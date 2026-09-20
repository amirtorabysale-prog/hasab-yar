import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureChartSchema, listAnalyticAccounts, saveAnalyticAccount } from '../server/chartOfAccounts.js';
import { importAnalyticRows } from '../server/ledgerImport.js';

/**
 * طرف حساب‌ها باید با فایل بیایند، نه با تایپ دستی.
 *
 * دفتر حسابداری صدها تفصیلی در نرم‌افزار خودش دارد. اگر کمک‌حسابدار مجبور باشد
 * یکی‌یکی واردشان کند، حساب‌یار کاری از کارش کم نکرده است. مهم‌تر از خودِ نام،
 * «کد مقصد» است: ردیفی که کد تفصیلی ندارد در پارسیان کنار گذاشته می‌شود و طرف
 * دیگرِ همان سند تنها می‌ماند — همان سند غیرموازنه.
 */
function freshDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE journal_lines (id TEXT PRIMARY KEY, account_id TEXT, debit INTEGER DEFAULT 0, credit INTEGER DEFAULT 0);
    CREATE TABLE ledger_accounts (id TEXT PRIMARY KEY, code TEXT, name TEXT, type TEXT);
  `);
  ensureChartSchema(database);
  return database;
}

const rows = (...items) => items.map((item, index) => ({ rowNumber: index + 2, ...item }));

test('کد فایل، وقتی ستون مقصد نیست، کد مقصد هم هست', () => {
  const database = freshDatabase();
  const result = importAnalyticRows(database, rows(
    { code: '1001', name: 'شرکت آرمان', kind: 'مشتری' },
    { code: '1002', name: 'پخش البرز', kind: 'تامین کننده' },
  ));
  assert.equal(result.created, 2);
  assert.equal(result.linked, 2);
  const list = listAnalyticAccounts(database);
  assert.deepEqual(list.map((item) => item.externalCode), ['1001', '1002']);
  assert.deepEqual(list.map((item) => item.code), ['1001', '1002']);
});

test('ستون صریح کد مقصد بر کد داخلی می‌چربد', () => {
  const database = freshDatabase();
  importAnalyticRows(database, rows({ code: '7', name: 'شرکت آرمان', externalCode: '1001' }));
  const [item] = listAnalyticAccounts(database);
  assert.equal(item.code, '7');
  assert.equal(item.externalCode, '1001');
});

/**
 * طرف حسابی که از ثبت روزانه ساخته شده، کد داخلی خودکار دارد و آرتیکل‌های
 * ثبت‌شده به همان id چسبیده‌اند. فایل باید کد مقصدش را پر کند، نه اینکه
 * دومینِ هم‌نام بسازد.
 */
test('فایل، طرف حساب موجود را از روی نام پیدا می‌کند و کد مقصدش را پر می‌کند', () => {
  const database = freshDatabase();
  const existing = saveAnalyticAccount(database, { name: 'شرکت آرمان', kind: 'contact', sourceKind: 'contact', sourceKey: 'c-1' });
  const result = importAnalyticRows(database, rows({ code: '1001', name: 'شركت آرمان' }));
  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);
  const list = listAnalyticAccounts(database);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, existing.id);
  assert.equal(list[0].code, existing.code, 'کد داخلی تفصیلی موجود عوض نمی‌شود');
  assert.equal(list[0].externalCode, '1001');
});

test('ورود دوباره همان فایل چیزی اضافه نمی‌کند', () => {
  const database = freshDatabase();
  const file = rows({ code: '1001', name: 'شرکت آرمان' }, { code: '1002', name: 'پخش البرز' });
  importAnalyticRows(database, file);
  const second = importAnalyticRows(database, file);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 2);
  assert.equal(listAnalyticAccounts(database).length, 2);
});

/**
 * دو تفصیلیِ هم‌نام یعنی نام برای شناسایی کافی نیست. آن‌وقت ردیف فایل یکی تازه
 * می‌سازد؛ عوض کردن یکی از آن دو، سکه انداختن روی سوابق ثبت‌شده است.
 */
test('نام تکراری در دفتر، هیچ‌کدام را بی‌صدا عوض نمی‌کند', () => {
  const database = freshDatabase();
  const first = saveAnalyticAccount(database, { code: '9001', name: 'علی محمدی', sourceKind: 'contact', sourceKey: 'a' });
  const second = saveAnalyticAccount(database, { code: '9002', name: 'علی محمدی', sourceKind: 'contact', sourceKey: 'b' });
  importAnalyticRows(database, rows({ code: '1001', name: 'علی محمدی' }));
  const list = listAnalyticAccounts(database);
  assert.equal(list.length, 3);
  for (const id of [first.id, second.id]) {
    assert.equal(list.find((item) => item.id === id).externalCode, null);
  }
});

test('کد مقصد ثبت‌شده با حدسِ کدِ فایل بازنویسی نمی‌شود', () => {
  const database = freshDatabase();
  saveAnalyticAccount(database, { name: 'شرکت آرمان', externalCode: '5555', sourceKind: 'contact', sourceKey: 'c-1' });
  const result = importAnalyticRows(database, rows({ code: '1001', name: 'شرکت آرمان' }));
  assert.equal(result.kept, 1);
  assert.equal(listAnalyticAccounts(database)[0].externalCode, '5555');
  // ولی اعلام صریح فایل، تصمیم کاربر است و اعمال می‌شود.
  importAnalyticRows(database, rows({ code: '1001', name: 'شرکت آرمان', externalCode: '1001' }));
  assert.equal(listAnalyticAccounts(database)[0].externalCode, '1001');
});

test('کد مقصد غیرعددی کل فایل را رد می‌کند', () => {
  const database = freshDatabase();
  assert.throws(() => importAnalyticRows(database, rows({ code: '1001', name: 'آرمان', externalCode: 'AB-2' })), (error) => {
    assert.equal(error.code, 'IMPORT_ROWS_INVALID');
    assert.match(error.details.errors[0].message, /کد مقصد/);
    return true;
  });
  assert.equal(listAnalyticAccounts(database).length, 0);
});

test('کد داخلی گرفته‌شده، ردیف تازه را متوقف نمی‌کند', () => {
  const database = freshDatabase();
  saveAnalyticAccount(database, { code: '1001', name: 'حساب قدیمی', sourceKind: 'contact', sourceKey: 'old' });
  importAnalyticRows(database, rows({ code: '1001', name: 'شرکت آرمان' }));
  const created = listAnalyticAccounts(database).find((item) => item.name === 'شرکت آرمان');
  assert.ok(created, 'ردیف تازه ساخته می‌شود');
  assert.notEqual(created.code, '1001');
  assert.equal(created.externalCode, '1001', 'کد مقصد همان کد فایل می‌ماند');
});
