import test from 'node:test';
import assert from 'node:assert/strict';

const databasePath = `/tmp/hesab-yar-bridge-${process.pid}.sqlite`;
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'bridge-owner';
process.env.ADMIN_PASSWORD = 'bridge-strong-password-12345';

const database = await import(`../server/db.js?bridge=${process.pid}`);
const accounting = await import(`../server/accounting.js?bridge=${process.pid}`);
const sheet = await import(`../server/spreadsheet.js?bridge=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('bridge-owner', 'bridge-strong-password-12345');
const workspace = database.createWorkspace(owner.id, { name: 'شرکت پل', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

function xlsx(sheets) {
  return sheet.buildWorkbook(sheets);
}

test('the blank import template is a real workbook with the sheets an office needs', () => {
  const sheets = sheet.readWorkbook(database.importTemplateWorkbook());
  assert.deepEqual(sheets.map((item) => item.name), ['کدینگ', 'تفصیلی', 'مانده افتتاحیه', 'راهنما']);
  assert.deepEqual(sheets[0].rows[0], ['کد', 'نام', 'سطح', 'کد والد', 'نوع', 'نقش']);
});

test('a chart arrives from an Excel file, not just from pasted CSV', () => {
  inWorkspace(() => {
    const buffer = xlsx([{
      name: 'کدینگ',
      rows: [
        ['کد', 'نام', 'سطح', 'کد والد', 'نوع', 'نقش'],
        ['۱', 'دارایی‌های جاری', 'گروه', '', 'دارایی', ''],
        ['۱۱', 'موجودی نقد و بانک', 'کل', '۱', 'دارایی', ''],
        ['۱۱۰۱', 'صندوق', 'معین', '۱۱', 'دارایی', 'cash'],
        ['۱۱۰۲', 'بانک', 'معین', '۱۱', 'دارایی', 'bank'],
        ['۵', 'حقوق صاحبان سرمایه', 'گروه', '', 'سرمایه', ''],
        ['۵۱', 'سرمایه', 'کل', '۵', 'سرمایه', ''],
        ['۵۱۰۱', 'سرمایه', 'معین', '۵۱', 'سرمایه', 'equity'],
        ['۶', 'درآمدها', 'گروه', '', 'درآمد', ''],
        ['۶۱', 'درآمد عملیاتی', 'کل', '۶', 'درآمد', ''],
        ['۶۱۰۱', 'فروش کالا', 'معین', '۶۱', 'درآمد', 'sales'],
        ['۸', 'هزینه‌ها', 'گروه', '', 'هزینه', ''],
        ['۸۱', 'هزینه عملیاتی', 'کل', '۸', 'هزینه', ''],
        ['۸۱۰۹', 'سایر هزینه‌ها', 'معین', '۸۱', 'هزینه', 'operating-expense'],
      ],
    }]);
    const result = database.importChartFile(buffer, 'coding.xlsx');
    assert.equal(result.created, 13);
    assert.equal(result.mapping.chartInstalled, true);
    assert.equal(database.chartOverview().accounts.find((item) => item.code === '1101').name, 'صندوق');
  });
});

test('a chart file missing a required column names the column instead of failing vaguely', () => {
  inWorkspace(() => {
    assert.throws(
      () => database.importChartFile(xlsx([{ name: 'x', rows: [['کد', 'نام'], ['1', 'الف']] }]), 'bad.xlsx'),
      (error) => error.code === 'IMPORT_COLUMN_MISSING' && error.message.includes('سطح، نوع'),
    );
  });
});

test('parties import from Excel and become floating analytics', () => {
  inWorkspace(() => {
    const result = database.importAnalyticsFile(xlsx([{
      name: 'تفصیلی',
      rows: [['کد', 'نام', 'نوع'], ['۱۰۰۱', 'شرکت آبان', 'مشتری'], ['۱۰۰۲', 'پروژهٔ برج', 'پروژه'], ['', 'بدون کد', 'سایر']],
    }]), 'parties.xlsx');
    assert.equal(result.created, 3);
    const analytics = database.chartOverview().analytics;
    assert.equal(analytics.find((item) => item.code === '1001').name, 'شرکت آبان');
    assert.equal(analytics.find((item) => item.code === '1002').kind, 'project');
  });
});

test('an unbalanced opening trial balance is refused with the exact difference', () => {
  inWorkspace(() => {
    assert.throws(
      () => database.importOpeningBalanceFile(xlsx([{
        name: 'مانده', rows: [['کد حساب', 'بدهکار', 'بستانکار'], ['1101', '5000000', ''], ['5101', '', '4000000']],
      }]), 'open.xlsx', { amountUnit: 'toman' }),
      (error) => error.code === 'IMPORT_UNBALANCED' && error.details.difference === 1_000_000,
    );
    assert.equal(accounting.trialBalance(database.db).balanced, true, 'رد شدن فایل نباید چیزی در دفتر بگذارد');
  });
});

test('an account code outside the office chart is refused rather than invented', () => {
  inWorkspace(() => {
    assert.throws(
      () => database.importOpeningBalanceFile(xlsx([{
        name: 'مانده', rows: [['کد حساب', 'بدهکار', 'بستانکار'], ['9999', '100', ''], ['5101', '', '100']],
      }]), 'open.xlsx', { amountUnit: 'toman' }),
      (error) => error.code === 'IMPORT_ROWS_INVALID' && /9999 در کدینگ این دفتر نیست/.test(error.details.errors[0].message),
    );
  });
});

test('posting to a group or general account is refused', () => {
  inWorkspace(() => {
    assert.throws(
      () => database.importOpeningBalanceFile(xlsx([{
        name: 'مانده', rows: [['کد حساب', 'بدهکار', 'بستانکار'], ['11', '100', ''], ['5101', '', '100']],
      }]), 'open.xlsx', { amountUnit: 'toman' }),
      (error) => /حساب کل/.test(error.details.errors[0].message),
    );
  });
});

test('a rial trial balance is converted once and becomes one balanced opening document', () => {
  inWorkspace(() => {
    const result = database.importOpeningBalanceFile(xlsx([{
      name: 'مانده افتتاحیه',
      rows: [
        ['کد حساب', 'نام حساب', 'بدهکار', 'بستانکار', 'کد تفصیلی'],
        ['۱۱۰۱', 'صندوق', '۳۰٬۰۰۰٬۰۰۰', '', ''],
        ['۱۱۰۲', 'بانک', '۷۰٬۰۰۰٬۰۰۰', '', ''],
        ['۵۱۰۱', 'سرمایه', '', '۱۰۰٬۰۰۰٬۰۰۰', ''],
      ],
    }]), 'trial.xlsx', { amountUnit: 'rial' });

    // ۱۰۰ میلیون ریال = ۱۰ میلیون تومان
    assert.equal(result.debitTotal, 10_000_000);
    assert.equal(result.creditTotal, 10_000_000);
    assert.equal(result.lineCount, 3);
    assert.equal(result.replacedEntryId, null);
    assert.equal(accounting.trialBalance(database.db).balanced, true);

    const cash = accounting.trialBalance(database.db).rows.find((row) => row.chartCode === '1101');
    assert.equal(cash.debitBalance, 3_000_000, 'مبلغ ریالی باید یک بار و فقط یک بار تقسیم شود');
  });
});

test('a second opening import is blocked unless replacement is explicit', () => {
  inWorkspace(() => {
    const file = xlsx([{
      name: 'مانده', rows: [['کد حساب', 'بدهکار', 'بستانکار'], ['1101', '4000000', ''], ['5101', '', '4000000']],
    }]);
    assert.throws(() => database.importOpeningBalanceFile(file, 'again.xlsx', { amountUnit: 'toman' }),
      (error) => error.code === 'OPENING_IMPORT_EXISTS');

    const replaced = database.importOpeningBalanceFile(file, 'again.xlsx', { amountUnit: 'toman', replace: true });
    assert.ok(replaced.replacedEntryId, 'سند قبلی باید معکوس شود، نه حذف');
    assert.equal(accounting.trialBalance(database.db).balanced, true);
    const cash = accounting.trialBalance(database.db).rows.find((row) => row.chartCode === '1101');
    assert.equal(cash.debitBalance, 4_000_000, 'ماندهٔ نهایی باید فقط از سند تازه بیاید');
  });
});

test('the office defines its own column layout and unit for the export', () => {
  inWorkspace(() => {
    const settings = database.saveAccountingTransferSettings({
      targetSystem: 'generic-csv', fileFormat: 'xlsx', amountUnit: 'rial',
      columns: [
        { field: 'dateJalali', header: 'تاريخ' },
        { field: 'chartCode', header: 'كد حساب' },
        { field: 'lineDescription', header: 'شرح' },
        { field: 'debit', header: 'بدهكار' },
        { field: 'credit', header: 'بستانكار' },
      ],
    });
    assert.equal(settings.fileFormat, 'xlsx');
    assert.equal(settings.amountUnit, 'rial');
    assert.equal(settings.columns.length, 5);
    assert.equal(settings.usingDefaultColumns, false);

    // ذخیرهٔ نام قالب نباید چیدمان ستون‌ها را پاک کند.
    const renamed = database.saveAccountingTransferSettings({ targetSystem: 'generic-csv', templateName: 'قالب دفتر ما' });
    assert.equal(renamed.columns.length, 5);
    assert.equal(renamed.fileFormat, 'xlsx');
  });
});

test('the generated batch is a real workbook with the office layout and a manifest sheet', () => {
  inWorkspace(() => {
    database.applyChartSuggestions();
    const overview = database.accountingTransferOverview('', 'generic-csv');
    assert.equal(overview.readiness.ready, true, JSON.stringify(overview.readiness.checks.filter((item) => !item.passed)));

    const batch = database.createAccountingTransferBatch({ targetSystem: 'generic-csv' });
    assert.equal(batch.fileFormat, 'xlsx');
    assert.equal(batch.amountUnit, 'rial');
    assert.match(batch.fileName, /\.xlsx$/);
    assert.equal(batch.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const sheets = sheet.readWorkbook(database.accountingTransferBatchFile(batch.id).fileData);
    assert.deepEqual(sheets.map((item) => item.name), ['ردیف‌های دفتر کل', 'شناسنامه']);
    assert.deepEqual(sheets[0].rows[0], ['تاريخ', 'كد حساب', 'شرح', 'بدهكار', 'بستانكار']);
    assert.equal(sheets[0].rows.length - 1, batch.rowCount);

    const manifest = Object.fromEntries(sheets[1].rows.filter((row) => row.length > 1).map((row) => [row[0], row[1]]));
    assert.equal(manifest['واحد مبلغ ستون‌های مبلغ'], 'ریال');
    assert.match(manifest['توضیح'], /ادعای ورود مستقیم/);

    // جمع ریالی فایل باید دقیقاً ده برابر جمع تومانی بستهٔ ثبت‌شده باشد.
    const debitColumn = sheets[0].rows.slice(1).reduce((sum, row) => sum + Number(row[3] || 0), 0);
    assert.equal(debitColumn, batch.debitTotal * 10);
  });
});

test('the same data regenerated gives the same digest and the same batch', () => {
  inWorkspace(() => {
    const first = database.createAccountingTransferBatch({ targetSystem: 'generic-csv' });
    const second = database.createAccountingTransferBatch({ targetSystem: 'generic-csv' });
    assert.equal(second.id, first.id);
    assert.equal(second.digest, first.digest);
  });
});

test('a csv batch still works so nothing an office already relies on breaks', () => {
  inWorkspace(() => {
    database.saveAccountingTransferSettings({ targetSystem: 'generic-csv', fileFormat: 'csv', amountUnit: 'toman' });
    const batch = database.createAccountingTransferBatch({ targetSystem: 'generic-csv' });
    assert.equal(batch.fileFormat, 'csv');
    assert.match(batch.fileName, /\.csv$/);
    const text = database.accountingTransferBatchFile(batch.id).fileData.toString('utf8');
    assert.match(text, /^﻿/, 'Excel بدون BOM فارسی را خراب نشان می‌دهد');
    assert.match(text.split('\r\n')[0], /تاريخ/);
  });
});

test('the export field catalogue is offered so the office can build its own layout', () => {
  const catalogue = database.transferFieldCatalog();
  assert.ok(catalogue.fields.some((item) => item.id === 'chartCode'));
  assert.ok(catalogue.fields.some((item) => item.id === 'analyticCode'));
  assert.deepEqual(catalogue.formats.map((item) => item.id).sort(), ['csv', 'xlsx']);
});
