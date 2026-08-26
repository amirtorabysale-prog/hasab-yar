import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const databasePath = `/tmp/hesab-yar-transfer-${process.pid}.sqlite`;
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'transfer-owner';
process.env.ADMIN_PASSWORD = 'transfer-safe-password-4829';

const database = await import(`../server/db.js?transfer=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('transfer-owner', 'transfer-safe-password-4829');
let secondWorkspace;

function inPrimary(callback) {
  return database.runInWorkspace('primary', { role: 'owner', userId: owner.id }, callback);
}

test('builds an immutable balanced CSV batch with both toman and rial', () => inPrimary(() => {
  database.insertTransactions({ transcript: '=فروش پروژه', transactions: [{
    amount: 1_200_000, type: 'income', category: 'فروش', rawText: '=فروش پروژه',
    occurredAt: '2026-08-10T09:00:00.000Z', reviewState: 'ready',
  }] });
  const preview = database.accountingTransferOverview('1405-05', 'generic-csv', new Date('2026-08-20T12:00:00.000Z'));
  assert.equal(preview.scope.period, '1405-05');
  assert.equal(preview.readiness.ready, true);
  assert.equal(preview.readiness.entryCount, 1);
  assert.equal(preview.readiness.rowCount, 2);
  assert.equal(preview.readiness.debitTotal, 1_200_000);
  assert.equal(preview.readiness.creditTotal, 1_200_000);
  assert.equal(preview.readiness.directImportCertified, false);

  const first = database.createAccountingTransferBatch({ month: '1405-05', targetSystem: 'generic-csv' }, new Date('2026-08-20T12:00:00.000Z'));
  const repeated = database.createAccountingTransferBatch({ month: '1405-05', targetSystem: 'generic-csv' }, new Date('2026-08-20T12:05:00.000Z'));
  assert.equal(repeated.id, first.id);
  assert.equal(first.digest.length, 64);
  const file = database.accountingTransferBatchFile(first.id);
  const csv = file.fileData.toString('utf8');
  assert.equal(csv.startsWith('\uFEFFشناسه سند حساب‌یار'), true);
  assert.match(csv, /بدهکار تومان/);
  assert.match(csv, /بدهکار ریال/);
  assert.match(csv, /12000000/);
  assert.match(csv, /'=فروش پروژه/);
  assert.equal(database.updateAccountingTransferBatchStatus(first.id, { status: 'delivered' }).status, 'delivered');
  assert.equal(database.updateAccountingTransferBatchStatus(first.id, { status: 'accepted' }).status, 'accepted');
  assert.throws(() => database.updateAccountingTransferBatchStatus(first.id, { status: 'rejected', note: 'نیاز به اصلاح دارد' }), (error) => error.code === 'TRANSFER_BATCH_FINAL');
}));

test('requires a reviewed template and complete account mappings for Parsian preparation', () => inPrimary(() => {
  let overview = database.accountingTransferOverview('1405-05', 'parsian-review-csv', new Date('2026-08-20T12:00:00.000Z'));
  assert.equal(overview.readiness.ready, false);
  assert.equal(overview.readiness.checks.find((item) => item.id === 'template').passed, false);
  assert.ok(overview.readiness.missingMappings.length >= 2);

  database.saveAccountingTransferSettings({
    targetSystem: 'parsian-review-csv', templateName: 'قالب شرکت آزمایشی پارسیان ۱۴۰۵', templateVerified: true,
  });
  for (const [index, account] of overview.readiness.accounts.entries()) database.saveAccountingTransferMapping({
    targetSystem: 'parsian-review-csv', ledgerAccountId: account.id,
    targetCode: `P-${index + 1}`, targetName: `حساب مقصد ${index + 1}`,
  });
  overview = database.accountingTransferOverview('1405-05', 'parsian-review-csv', new Date('2026-08-20T12:00:00.000Z'));
  assert.equal(overview.readiness.ready, true);
  assert.equal(overview.readiness.missingMappings.length, 0);
  assert.match(overview.readiness.disclaimer, /\.bak/);
  const batch = database.createAccountingTransferBatch({ month: '1405-05', targetSystem: 'parsian-review-csv' }, new Date('2026-08-20T12:00:00.000Z'));
  assert.match(database.accountingTransferBatchFile(batch.id).fileData.toString('utf8'), /P-1/);
}));

test('blocks export when a transaction still needs review and isolates transfer history by workspace', () => {
  inPrimary(() => {
    database.insertTransactions({ transcript: 'ثبت مشکوک', transactions: [{
      amount: 75_000, type: 'expense', category: 'سایر هزینه‌ها', rawText: 'ثبت مشکوک',
      occurredAt: '2026-08-11T09:00:00.000Z', reviewState: 'review', needsReview: true,
    }] });
    const preview = database.accountingTransferOverview('1405-05', 'generic-csv', new Date('2026-08-20T12:00:00.000Z'));
    assert.equal(preview.readiness.ready, false);
    assert.equal(preview.readiness.checks.find((item) => item.id === 'review').count, 1);
    assert.throws(() => database.createAccountingTransferBatch({ month: '1405-05', targetSystem: 'generic-csv' }), (error) => error.code === 'ACCOUNTING_TRANSFER_NOT_READY');
  });

  secondWorkspace = database.createWorkspace(owner.id, { name: 'دفتر انتقال دوم', profileType: 'business' });
  database.runInWorkspace(secondWorkspace.id, { role: 'owner', userId: owner.id }, () => {
    const preview = database.accountingTransferOverview('1405-05', 'generic-csv', new Date('2026-08-20T12:00:00.000Z'));
    assert.equal(preview.readiness.entryCount, 0);
    assert.equal(preview.batches.length, 0);
  });
  inPrimary(() => assert.ok(database.listAccountingTransferBatches().length >= 2));
});

test('includes transfer settings, mappings and immutable files in encrypted-backup data', () => inPrimary(() => {
  const snapshot = database.financialBackupSnapshot({ id: 'primary' });
  assert.ok(snapshot.tables.accounting_transfer_settings.length >= 1);
  assert.ok(snapshot.tables.accounting_transfer_mappings.length >= 2);
  assert.ok(snapshot.tables.accounting_transfer_batches.length >= 2);
  assert.ok(Buffer.from(snapshot.tables.accounting_transfer_batches[0].file_data).length > 100);
}));

test.after(() => {
  const workspaceId = secondWorkspace?.id;
  database.closeWorkspaceDatabases();
  database.db.close();
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
  if (workspaceId) {
    const tenantPath = resolve(dirname(databasePath), 'workspaces', `${workspaceId}.sqlite`);
    for (const suffix of ['', '-shm', '-wal']) rmSync(`${tenantPath}${suffix}`, { force: true });
  }
});
