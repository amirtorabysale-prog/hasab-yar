import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureChartSchema, importChartOfAccounts, parseChartCsv, validateChartRows } from '../server/chartOfAccounts.js';

/**
 * کدینگ پارسیان با کدینگ پیشوندی یکی نیست.
 *
 * در پارسیان «۱۲ بدهکاران» یک کلِ ریشه است — زیر هیچ گروهی نیست — و معینش کد
 * کوتاه خودش را دارد («۲ مشتریان»)، چون کلید معین در پارسیان ترکیب کل و معین
 * است و کد معین سراسری نیست.
 *
 * تا پیش از این، ورود کدینگ فقط سبک پیشوندی را می‌پذیرفت: کل حتماً والد
 * می‌خواست و کد سطحش از تفاضل با والد ساخته می‌شد. نتیجه این بود که خروجی
 * به‌جای کل ۱۲، کل ۱ می‌فرستاد و پارسیان آن ردیف‌ها را کنار می‌گذاشت — دفتر
 * مشتری نامتوازن می‌ماند و هیچ خطایی هم دیده نمی‌شد.
 */
const PARSIAN_CSV = [
  'کد,نام,سطح,کد والد,نوع,کد سطح,نقش',
  '10,صندوق,کل,,دارایی,10,',
  '1001,صندوق اصلی,معین,10,دارایی,1,cash',
  '12,بدهکاران (حسابهای دریافتنی),کل,,دارایی,12,',
  '1202,مشتریان,معین,12,دارایی,2,receivable',
  '23,بستانکاران (حسابهای پرداختنی),کل,,بدهی,23,',
  '2301,تأمین‌کنندگان,معین,23,بدهی,1,payable',
  '40,درآمدها,کل,,درآمد,40,',
  '4001,فروش,معین,40,درآمد,1,sales',
  '50,هزینه‌ها,کل,,هزینه,50,',
  '5001,هزینه‌های عمومی,معین,50,هزینه,1,operating-expense',
].join('\n');

test('ستون «کد سطح» از فایل خوانده می‌شود', () => {
  const { rows } = parseChartCsv(PARSIAN_CSV);
  assert.equal(rows.length, 10);
  assert.equal(rows[0].levelCode, '10');
  assert.equal(rows[3].levelCode, '2');
});

test('کلِ بدون والد با کد سطح صریح پذیرفته می‌شود', () => {
  const { rows } = parseChartCsv(PARSIAN_CSV);
  const { accounts, errors } = validateChartRows(rows);
  assert.deepEqual(errors, []);
  const byCode = new Map(accounts.map((item) => [item.code, item]));
  assert.equal(byCode.get('12').levelCode, '12', 'کل باید کد خودش را نگه دارد');
  assert.equal(byCode.get('1202').levelCode, '2', 'معین باید کد کوتاه پارسیان را نگه دارد');
  assert.equal(byCode.get('2301').levelCode, '1');
});

// بدون کد سطح و بدون والد، کل همچنان خطاست: نه می‌دانیم کد مقصدش چیست و نه
// جایش در درخت.
test('کل بدون والد و بدون کد سطح همچنان رد می‌شود', () => {
  const { rows } = parseChartCsv('کد,نام,سطح,نوع\n12,بدهکاران,کل,دارایی');
  const { errors } = validateChartRows(rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /کد والد|کد سطح/);
});

test('کد سطح تا پایگاه‌داده می‌رسد؛ همان چیزی که خروجی می‌فرستد', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE journal_lines (id TEXT PRIMARY KEY);
    CREATE TABLE ledger_accounts (id TEXT PRIMARY KEY, code TEXT, name TEXT, type TEXT);
  `);
  ensureChartSchema(database);
  const { rows } = parseChartCsv(PARSIAN_CSV);
  const result = importChartOfAccounts(database, rows, { source: 'import' });
  assert.equal(result.errors?.length ?? 0, 0);

  const stored = new Map(database.prepare('SELECT code,level_code AS levelCode FROM chart_accounts').all()
    .map((row) => [row.code, row.levelCode]));
  // این دو عدد همان KolCode و MoeenCode فایل انتقال‌اند.
  assert.equal(stored.get('12'), '12');
  assert.equal(stored.get('1202'), '2');
  assert.equal(stored.get('23'), '23');
  assert.equal(stored.get('4001'), '1');
  database.close();
});
