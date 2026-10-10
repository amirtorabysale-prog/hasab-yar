import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

/**
 * بایگانی دفتر — نه حذف.
 *
 * دفترهای اضافه از فهرست بیرون می‌روند ولی داده‌شان دست نمی‌خورد و برمی‌گردند.
 * فقط مالک همان دفتر می‌تواند نامش را عوض یا بایگانی‌اش کند، آخرین دفتر فعال
 * بایگانی نمی‌شود، و کوکیِ دفتر بایگانی‌شده کاربر را قفل نمی‌کند.
 */
const databasePath = tempDatabase('workspace-archive');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'archive-owner';
process.env.ADMIN_PASSWORD = 'archive-strong-password-8841';

const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser('archive-owner', 'archive-strong-password-8841');

test('بایگانی دفتر را از فهرست برمی‌دارد، داده‌اش می‌ماند و برمی‌گردد', () => {
  const main = database.createWorkspace(owner.id, { name: 'اصلی آزمون', profileType: 'business' });
  const extra = database.createWorkspace(owner.id, { name: 'دفتر اضافه', profileType: 'business' });
  database.runInWorkspace(extra.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, () => {
    database.insertTransactions({ transcript: 'قبض برق', transactions: [{ amount: 3_000_000, type: 'expense', category: 'قبوض و انرژی', rawText: 'قبض برق' }] });
  });
  database.archiveWorkspace(owner.id, extra.id);
  assert.equal(database.listUserWorkspaces(owner.id).some((item) => item.id === extra.id), false);
  assert.equal(database.workspaceForUser(owner.id, extra.id), null, 'دفتر بایگانی‌شده در دسترس نیست');
  assert.equal(database.listArchivedWorkspaces(owner.id)[0].id, extra.id);

  const restored = database.restoreArchivedWorkspace(owner.id, extra.id);
  assert.equal(restored.id, extra.id);
  database.runInWorkspace(extra.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, () => {
    assert.equal(database.listTransactions({}).items.length, 1, 'داده پس از بازگرداندن همان است');
  });
  assert.ok(main.id);
});

test('نام دفتر عوض می‌شود؛ فقط مالک؛ آخرین دفتر فعال بایگانی نمی‌شود', () => {
  const workspaces = database.listUserWorkspaces(owner.id);
  const target = workspaces.find((item) => item.name === 'دفتر اضافه');
  database.renameWorkspace(owner.id, target.id, 'ازمایشی');
  assert.equal(database.listUserWorkspaces(owner.id).find((item) => item.id === target.id).name, 'ازمایشی');
  database.runInWorkspace(target.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, () => {
    assert.equal(database.getSettings().businessName, 'ازمایشی');
  });

  database.runInWorkspace(target.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, () => {
    database.addWorkspaceMember(target.id, { username: 'archive-accountant', displayName: 'حسابدار', temporaryPassword: 'Temp-archive-pass-9921', role: 'accountant' });
  });
  const accountant = database.authenticateUser('archive-accountant', 'Temp-archive-pass-9921');
  assert.throws(() => database.archiveWorkspace(accountant.id, target.id), { code: 'WORKSPACE_OWNER_REQUIRED' });
  assert.throws(() => database.renameWorkspace(accountant.id, target.id, 'نام دیگر'), { code: 'WORKSPACE_OWNER_REQUIRED' });

  for (const item of database.listUserWorkspaces(owner.id).slice(1)) database.archiveWorkspace(owner.id, item.id);
  const [last] = database.listUserWorkspaces(owner.id);
  assert.throws(() => database.archiveWorkspace(owner.id, last.id), { code: 'WORKSPACE_LAST_ACTIVE' });
  for (const item of database.listArchivedWorkspaces(owner.id)) database.restoreArchivedWorkspace(owner.id, item.id);
});

test('از راه HTTP: کوکیِ دفتر بایگانی‌شده به دفتر فعال برمی‌گردد، هدر صریح رد می‌شود', async () => {
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i += 1) {
      if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let cookie = '';
    let csrf = '';
    const call = async (method, path, { body, workspace } = {}) => {
      const response = await fetch(base + path, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf, ...(workspace ? { 'x-workspace-id': workspace } : {}) },
      });
      for (const value of response.headers.getSetCookie()) {
        const [pair] = value.split(';');
        const [name] = pair.split('=');
        cookie = [...cookie.split('; ').filter((item) => item && !item.startsWith(`${name}=`)), pair].join('; ');
      }
      return { status: response.status, data: await response.json().catch(() => ({})) };
    };
    const login = await call('POST', '/api/auth/login', { body: { username: 'archive-owner', password: 'archive-strong-password-8841' } });
    csrf = login.data.csrfToken;
    const target = login.data.workspaces.find((item) => item.name === 'ازمایشی');
    // دفتر فعال در کوکی، همان دفتری که بایگانی می‌شود.
    assert.equal((await call('GET', '/api/workspaces', { workspace: target.id })).data.workspace.id, target.id);
    const archived = await call('POST', `/api/workspaces/${target.id}/archive`);
    assert.equal(archived.status, 200, JSON.stringify(archived.data));
    assert.notEqual(archived.data.workspace.id, target.id);
    const after = await call('GET', '/api/workspaces');
    assert.equal(after.status, 200, 'کوکی دفتر بایگانی‌شده کاربر را قفل نمی‌کند');
    assert.notEqual(after.data.workspace.id, target.id);
    assert.equal((await call('GET', '/api/workspaces', { workspace: target.id })).status, 403);
    const list = await call('GET', '/api/workspaces/archived');
    assert.ok(list.data.items.some((item) => item.id === target.id));
    assert.equal((await call('POST', `/api/workspaces/${target.id}/restore`)).status, 200);
  } finally { child.kill(); }
});

test.after(() => removeTempDatabase(databasePath));
