import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('transfer');
process.env.DATABASE_PATH = databasePath;
const testAdminUsername = 'transfer-owner';
const testAdminPassword = `transfer-test-${crypto.randomUUID()}`;

process.env.ADMIN_USERNAME = testAdminUsername;
process.env.ADMIN_PASSWORD = testAdminPassword;

const database = await import(`../server/db.js?transfer=${process.pid}`);
const { persianYearEnd, suggestFiscalYearRange } = await import(`../server/accountingTransfer.js?transfer=${process.pid}`);
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
  database.db.prepare("UPDATE accounting_transfer_batches SET file_format='mdb',readiness_snapshot='{}' WHERE id=?").run(first.id);
  assert.throws(() => database.claimAccountingTransferBatchDownload(first.id, {
    confirmRedownload: true, reason: 'آزمون محافظ سال مالی بسته قدیمی',
  }), (error) => error.code === 'TRANSFER_FISCAL_YEAR_NOT_VERIFIED');
  database.db.prepare("UPDATE accounting_transfer_batches SET file_format='csv' WHERE id=?").run(first.id);
  assert.equal(database.updateAccountingTransferBatchStatus(first.id, { status: 'delivered' }).status, 'delivered');
  assert.equal(database.updateAccountingTransferBatchStatus(first.id, { status: 'accepted' }).status, 'accepted');
  assert.throws(() => database.updateAccountingTransferBatchStatus(first.id, { status: 'rejected', note: 'نیاز به اصلاح دارد' }), (error) => error.code === 'TRANSFER_BATCH_FINAL');
}));

test('requires a reviewed template and complete account mappings for Parsian preparation', () => inPrimary(() => {
  assert.throws(() => database.saveAccountingTransferSettings({
    targetSystem: 'parsian-review-csv', fiscalYearStart: '1405/12/29', fiscalYearEnd: '1405/01/01',
  }), (error) => error.code === 'TRANSFER_FISCAL_RANGE_INVALID');
  let overview = database.accountingTransferOverview('1405-05', 'parsian-review-csv', new Date('2026-08-20T12:00:00.000Z'));
  assert.equal(overview.readiness.ready, false);
  assert.equal(overview.readiness.checks.find((item) => item.id === 'template').passed, false);
  assert.ok(overview.readiness.missingMappings.length >= 2);

  database.saveAccountingTransferSettings({
    targetSystem: 'parsian-review-csv', templateName: 'قالب شرکت آزمایشی پارسیان ۱۴۰۵', templateVerified: true,
    fiscalYearStart: '۱۴۰۵/۰۱/۰۱', fiscalYearEnd: '۱۴۰۵/۱۲/۲۹',
  });
  const savedSettings = database.accountingTransferOverview('1405-05', 'parsian-review-csv').settings;
  assert.equal(savedSettings.fiscalYearStart, '1405/01/01');
  assert.equal(savedSettings.fiscalYearEnd, '1405/12/29');
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
  database.closeWorkspaceDatabases();
  database.db.close();
  // دیتابیس دفترها زیر همین پوشه ساخته می‌شود و با حذف پوشه می‌رود.
  removeTempDatabase(databasePath);
});

test('پایان سال شمسی از تقویم واقعی می‌آید، نه از حدس', () => {
  // سال‌های کبیسه ۳۰ اسفند دارند. اگر سال میلادیِ متناظر اشتباه گرفته شود،
  // همهٔ سال‌ها ۲۹ روزه به نظر می‌رسند و سند ۳۰ اسفند بیرون از بازه می‌افتد.
  assert.equal(persianYearEnd('1403'), '1403/12/30');
  assert.equal(persianYearEnd('1399'), '1399/12/30');
  assert.equal(persianYearEnd('1404'), '1404/12/29');
  assert.equal(persianYearEnd('1405'), '1405/12/29');
});

test('بازهٔ سال مالی از تاریخ خود سندها پیشنهاد می‌شود', () => {
  assert.deepEqual(suggestFiscalYearRange(['1405/06/02', '1405/06/31', '1405/01/01']), {
    start: '1405/01/01', end: '1405/12/29', year: '1405',
  });
});

test('بستهٔ چندساله پیشنهاد نمی‌گیرد، چون حدسش غلط از نگفتن بدتر است', () => {
  assert.equal(suggestFiscalYearRange(['1404/12/29', '1405/01/01']), null);
  assert.equal(suggestFiscalYearRange([]), null);
  assert.equal(suggestFiscalYearRange(['', null]), null);
});

// بن‌بست واقعی مسیر خروجی: پنل چیدمان هنگام ذخیرهٔ سال مالی، نام و تأیید قالب
// را نمی‌فرستد و سرور آن‌ها را خالی می‌کرد. پس هر بار ثبت سال مالی، تأیید قالب
// پاک می‌شد و کاربر هرگز نمی‌توانست هر دو دروازه را هم‌زمان سبز کند.
test('ذخیرهٔ سال مالی، تأیید قالب را پاک نمی‌کند', () => {
  inPrimary(() => {
    database.saveAccountingTransferSettings({
      targetSystem: 'parsian-review-csv',
      templateName: 'خروجی نمونه پارسیان',
      templateVerified: true,
    });
    assert.equal(database.accountingTransferOverview('', 'parsian-review-csv').settings.templateVerified, true);

    // همان چیزی که پنل چیدمان می‌فرستد — بدون فیلدهای قالب.
    database.saveAccountingTransferSettings({
      targetSystem: 'parsian-review-csv',
      fiscalYearStart: '1405/01/01',
      fiscalYearEnd: '1405/12/29',
    });

    const after = database.accountingTransferOverview('', 'parsian-review-csv').settings;
    assert.equal(after.templateVerified, true, 'تأیید قالب نباید پاک شود');
    assert.equal(after.templateName, 'خروجی نمونه پارسیان');
    assert.equal(after.fiscalYearStart, '1405/01/01');
    assert.equal(after.fiscalYearEnd, '1405/12/29');
  });
});

test('فرستادن صریح مقدار خالی همچنان پاک می‌کند', () => {
  inPrimary(() => {
    database.saveAccountingTransferSettings({ targetSystem: 'parsian-review-csv', templateVerified: false, templateName: '' });
    const after = database.accountingTransferOverview('', 'parsian-review-csv').settings;
    assert.equal(after.templateVerified, false);
    assert.equal(after.templateName, '');
  });
});
