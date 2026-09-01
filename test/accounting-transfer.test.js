import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const databasePath = `/tmp/hesab-yar-transfer-${process.pid}.sqlite`;
process.env.DATABASE_PATH = databasePath;
const testAdminUsername = 'transfer-owner';
const testAdminPassword = `transfer-test-${crypto.randomUUID()}`;

process.env.ADMIN_USERNAME = testAdminUsername;
process.env.ADMIN_PASSWORD = testAdminPassword;

const database = await import(`../server/db.js?transfer=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser(testAdminUsername, testAdminPassword);
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
  assert.match(first.fileName, new RegExp(`${first.digest.slice(0, 12)}\\.csv$`));
  const firstDownload = database.runInWorkspace('primary', { role: 'accountant', userId: owner.id }, () => (
    database.claimAccountingTransferBatchDownload(first.id)
  ));
  assert.equal(firstDownload.downloadCount, 1);
  assert.equal(firstDownload.status, 'delivered', 'اولین دریافت خودش سابقهٔ تحویل را ثبت می‌کند');
  assert.equal(firstDownload.fileData.equals(file.fileData), true);
  assert.throws(() => database.runInWorkspace('primary', { role: 'accountant', userId: owner.id }, () => (
    database.claimAccountingTransferBatchDownload(first.id, { confirmRedownload: true, reason: 'بازیابی فایل حذف‌شده' })
  )), (error) => error.code === 'TRANSFER_REDOWNLOAD_MANAGER_REQUIRED');
  assert.throws(() => database.claimAccountingTransferBatchDownload(first.id),
    (error) => error.code === 'TRANSFER_REDOWNLOAD_CONFIRM_REQUIRED');
  assert.throws(() => database.claimAccountingTransferBatchDownload(first.id, { confirmRedownload: true, reason: 'کوتاه' }),
    (error) => error.code === 'TRANSFER_REDOWNLOAD_REASON_REQUIRED');
  const secondDownload = database.claimAccountingTransferBatchDownload(first.id, {
    confirmRedownload: true, reason: 'نسخهٔ محلی پیش از ورود پاک شده بود',
  });
  assert.equal(secondDownload.downloadCount, 2);
  assert.equal(secondDownload.lastDownloadReason, 'نسخهٔ محلی پیش از ورود پاک شده بود');
  const downloadAudits = database.financialBackupSnapshot({ id: 'primary' }).tables.audit_log
    .filter((item) => item.entity_id === first.id && ['download-transfer-batch', 'redownload-transfer-batch'].includes(item.action));
  assert.deepEqual(downloadAudits.map((item) => item.action), ['download-transfer-batch', 'redownload-transfer-batch']);
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
  assert.equal(batch.acceptanceReady, false);
  assert.throws(() => database.updateAccountingTransferBatchStatus(batch.id, { status: 'accepted' }), (error) => error.code === 'TRANSFER_TRIAL_REQUIRED');

  const failed = database.createAccountingTransferValidation(batch.id, {
    softwareName: 'پارسیان', softwareVersion: '1405.2', testCompanyLabel: 'شرکت نمونه الف',
    attemptType: 'dry-run', outcome: 'failed', amountUnit: 'rial', importedRows: 0, rejectedRows: batch.rowCount,
    importedDebitTotal: 0, importedCreditTotal: 0, errorSummary: 'کد حساب مقصد در قالب نمونه پذیرفته نشد.',
  });
  assert.equal(failed.outcome, 'failed');
  assert.throws(() => database.createAccountingTransferValidation(batch.id, {
    softwareName: 'پارسیان', softwareVersion: '1405.2', testCompanyLabel: 'شرکت نمونه الف',
    attemptType: 'trial-import', outcome: 'passed', amountUnit: 'rial', importedRows: batch.rowCount - 1,
    rejectedRows: 1, importedDebitTotal: batch.debitTotal * 10, importedCreditTotal: batch.creditTotal * 10,
  }), (error) => error.code === 'TRANSFER_VALIDATION_MISMATCH');

  database.createAccountingTransferValidation(batch.id, {
    softwareName: 'پارسیان', softwareVersion: '1405.2', testCompanyLabel: 'شرکت نمونه الف',
    attemptType: 'dry-run', outcome: 'passed', amountUnit: 'rial', importedRows: batch.rowCount, rejectedRows: 0,
    importedDebitTotal: batch.debitTotal * 10, importedCreditTotal: batch.creditTotal * 10,
  });
  assert.throws(() => database.updateAccountingTransferBatchStatus(batch.id, { status: 'accepted' }), (error) => error.code === 'TRANSFER_TRIAL_REQUIRED');

  const trial = database.createAccountingTransferValidation(batch.id, {
    softwareName: 'پارسیان', softwareVersion: '1405.2', testCompanyLabel: 'شرکت نمونه الف',
    attemptType: 'trial-import', outcome: 'passed', amountUnit: 'rial', importedRows: batch.rowCount, rejectedRows: 0,
    importedDebitTotal: batch.debitTotal * 10, importedCreditTotal: batch.creditTotal * 10, note: 'ورود در شرکت آزمایشی و کنترل تراز انجام شد.',
  });
  assert.equal(trial.attemptType, 'trial-import');
  assert.equal(database.listAccountingTransferBatches({ targetSystem: 'parsian-review-csv' })[0].acceptanceReady, true);
  assert.equal(database.updateAccountingTransferBatchStatus(batch.id, { status: 'accepted' }).status, 'accepted');
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
  assert.ok(snapshot.tables.accounting_transfer_validations.length >= 3);
  assert.ok(Buffer.from(snapshot.tables.accounting_transfer_batches[0].file_data).length > 100);
  const downloaded = snapshot.tables.accounting_transfer_batches.find((item) => Number(item.download_count) >= 2);
  assert.ok(downloaded, 'شمارندهٔ دریافت داخل نسخهٔ پشتیبان می‌ماند');
  assert.ok(downloaded.first_downloaded_at);
  assert.ok(downloaded.last_downloaded_at);
  assert.match(downloaded.last_download_reason, /نسخهٔ محلی/);
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
