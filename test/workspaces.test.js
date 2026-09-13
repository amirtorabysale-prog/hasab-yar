import test from 'node:test';
import assert from 'node:assert/strict';
import { minimumRoleForRequest, roleAllows } from '../server/access.js';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('workspaces');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'workspace-owner';
process.env.ADMIN_PASSWORD = 'separate-strong-password-1234';

const database = await import(`../server/db.js?workspaces=${process.pid}`);
const admin = database.ensureAdmin();
const owner = database.authenticateUser('workspace-owner', 'separate-strong-password-1234');
let secondWorkspace;

test('migrates the existing owner and data into a primary workspace', () => {
  assert.equal(admin.configured, true);
  assert.deepEqual(database.listUserWorkspaces(owner.id).map((item) => item.id), ['primary']);
  assert.equal(database.workspaceForUser(owner.id, 'primary').role, 'owner');
  assert.equal(database.workspaceForUser(owner.id, 'primary').experiencePreference, 'professional');
});

test('repairs an existing primary admin membership to full professional access', () => {
  database.db.prepare("UPDATE workspace_members SET role='manager',experience='simple' WHERE workspace_id='primary' AND user_id=?").run(owner.id);
  database.ensureAdmin();
  const repaired = database.workspaceForUser(owner.id, 'primary');
  assert.equal(repaired.role, 'owner');
  assert.equal(repaired.experiencePreference, 'professional');
});

test('isolates every financial table behind a separate workspace database', () => {
  database.runInWorkspace('primary', { role: 'owner' }, () => {
    database.insertTransactions({ transcript: 'دفتر اصلی', transactions: [{ amount: 111_000, type: 'income', category: 'فروش', rawText: 'دفتر اصلی' }] });
  });
  secondWorkspace = database.createWorkspace(owner.id, { name: 'دفتر دوم', profileType: 'business' });
  database.runInWorkspace(secondWorkspace.id, { role: 'owner' }, () => {
    assert.equal(database.getToday().summary.income, 0);
    assert.equal(database.getSettings().businessName, 'دفتر دوم');
    database.insertTransactions({ transcript: 'دفتر دوم', transactions: [{ amount: 222_000, type: 'income', category: 'فروش', rawText: 'دفتر دوم' }] });
    assert.equal(database.getToday().summary.income, 222_000);
  });
  database.runInWorkspace('primary', { role: 'owner' }, () => {
    assert.equal(database.getToday().summary.income, 111_000);
    assert.equal(database.listTransactions({ query: 'دفتر دوم' }).items.length, 0);
  });
});

test('creates members with forced password change and protects the last owner', () => {
  const member = database.addWorkspaceMember(secondWorkspace.id, {
    username: 'teammate', displayName: 'همکار مالی', temporaryPassword: 'temporary-safe-password-9876', role: 'viewer',
  });
  assert.equal(member.mustChangePassword, 1);
  assert.equal(database.workspaceForUser(member.id, secondWorkspace.id).role, 'viewer');
  assert.equal(database.authenticateUser('teammate', 'temporary-safe-password-9876').mustChangePassword, true);
  assert.throws(() => database.updateWorkspaceMember(secondWorkspace.id, owner.id, 'manager'), /حداقل یک مالک/);
  assert.throws(() => database.removeWorkspaceMember(secondWorkspace.id, owner.id), /آخرین مالک/);
  assert.equal(database.updateWorkspaceMember(secondWorkspace.id, member.id, 'accountant').role, 'accountant');
});

test('enforces the role matrix for reads, financial writes, settings and members', () => {
  assert.equal(roleAllows('viewer', minimumRoleForRequest('GET', '/reports')), true);
  assert.equal(roleAllows('viewer', minimumRoleForRequest('POST', '/alerts/expense-growth/snooze')), true);
  assert.equal(roleAllows('viewer', minimumRoleForRequest('POST', '/transactions')), false);
  assert.equal(roleAllows('accountant', minimumRoleForRequest('POST', '/transactions')), true);
  assert.equal(roleAllows('accountant', minimumRoleForRequest('PATCH', '/settings')), false);
  assert.equal(roleAllows('manager', minimumRoleForRequest('PATCH', '/settings')), true);
  assert.equal(roleAllows('manager', minimumRoleForRequest('POST', '/workspace/members')), false);
  assert.equal(roleAllows('owner', minimumRoleForRequest('POST', '/workspace/members')), true);
  assert.equal(roleAllows('viewer', minimumRoleForRequest('GET', '/backups/status')), false);
  assert.equal(roleAllows('manager', minimumRoleForRequest('POST', '/backups/export')), true);
  assert.equal(roleAllows('manager', minimumRoleForRequest('POST', '/backups/restore')), false);
  assert.equal(roleAllows('owner', minimumRoleForRequest('POST', '/backups/restore')), true);
  assert.equal(roleAllows('accountant', minimumRoleForRequest('POST', '/accounting/journal')), true);
  assert.equal(roleAllows('manager', minimumRoleForRequest('POST', '/accounting/periods/2026-08/lock')), false);
  assert.equal(roleAllows('owner', minimumRoleForRequest('POST', '/accounting/periods/2026-08/lock')), true);
  assert.equal(roleAllows('accountant', minimumRoleForRequest('POST', '/reconciliation/imports')), true);
  assert.equal(roleAllows('accountant', minimumRoleForRequest('POST', '/reconciliation/imports/abc/close')), false);
  assert.equal(roleAllows('manager', minimumRoleForRequest('POST', '/reconciliation/imports/abc/close')), true);
  assert.equal(roleAllows('accountant', minimumRoleForRequest('POST', '/tax/rates')), false);
  assert.equal(roleAllows('manager', minimumRoleForRequest('POST', '/tax/rates')), true);
  assert.equal(roleAllows('viewer', minimumRoleForRequest('GET', '/tax/report')), true);
  assert.equal(roleAllows('viewer', minimumRoleForRequest('GET', '/collaboration/overview')), false);
  assert.equal(roleAllows('accountant', minimumRoleForRequest('GET', '/collaboration/monthly-package')), true);
  assert.equal(roleAllows('accountant', minimumRoleForRequest('POST', '/collaboration/requests/abc/answer')), false);
  assert.equal(roleAllows('manager', minimumRoleForRequest('POST', '/collaboration/requests/abc/answer')), true);
  assert.equal(roleAllows('accountant', minimumRoleForRequest('POST', '/collaboration/requests/abc/resolve')), true);
  assert.equal(roleAllows('viewer', minimumRoleForRequest('GET', '/accountant-transfer/overview')), false);
  assert.equal(roleAllows('accountant', minimumRoleForRequest('POST', '/accountant-transfer/batches')), true);
  assert.equal(roleAllows('accountant', minimumRoleForRequest('GET', '/pilot/portfolio')), false);
  assert.equal(roleAllows('manager', minimumRoleForRequest('GET', '/operations/overview')), true);
});

test.after(() => {
  database.closeWorkspaceDatabases();
  database.db.close();
  // دیتابیس دفترها زیر همین پوشه ساخته می‌شود و با حذف پوشه می‌رود.
  removeTempDatabase(databasePath);
});
