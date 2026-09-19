import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { attachMissingCounterpartyAnalytics } from '../server/accounting.js';
import { counterpartyAnalyticForKey } from '../server/roleResolver.js';
import { ensureChartSchema, listAnalyticAccounts, saveAnalyticAccount } from '../server/chartOfAccounts.js';

/**
 * ردیف «بدون طرف حساب» که حسابش به نام یک شخصِ شناخته‌شده است.
 *
 * رویدادی که شناسهٔ طرف حسابش نیامده بود، حساب اختصاصی می‌گرفت («حساب پرداختنی
 * — شرکت آران گستر») ولی تفصیلی نمی‌گرفت؛ درحالی‌که همان شخص در دفتر ثبت شده و
 * روی ردیف‌های دیگرش تفصیلی دارد. در پارسیان معین پرداختنی تفصیلی اجباری دارد،
 * پس آن ردیف کنار گذاشته می‌شد و سند نامتوازن می‌شد.
 *
 * مرز کار روشن است: تفصیلی فقط وقتی چسبانده می‌شود که آن نام واقعاً یک شخص
 * باشد — طرف حساب ثبت‌شده یا تفصیلیِ هم‌نامِ موجود. عنوان تعهد («بدهی بی‌نام»)
 * تفصیلی نمی‌سازد.
 */
function workbench() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE journal_lines (id TEXT PRIMARY KEY, account_id TEXT, debit INTEGER, credit INTEGER);
    CREATE TABLE ledger_accounts (id TEXT PRIMARY KEY, code TEXT, name TEXT, type TEXT,
      source_kind TEXT, source_key TEXT, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, name TEXT, canonical_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  ensureChartSchema(database);
  const account = (name, sourceKind, sourceKey, type) => {
    const id = randomUUID();
    database.prepare('INSERT INTO ledger_accounts (id,code,name,type,source_kind,source_key) VALUES (?,?,?,?,?,?)')
      .run(id, '100', name, type, sourceKind, sourceKey);
    return id;
  };
  const line = (accountId) => {
    const id = randomUUID();
    database.prepare('INSERT INTO journal_lines (id,account_id,debit,credit) VALUES (?,?,?,?)').run(id, accountId, 0, 1_000_000);
    return id;
  };
  const contact = (name, canonical) => database.prepare('INSERT INTO contacts (id,name,canonical_name) VALUES (?,?,?)')
    .run(randomUUID(), name, canonical);
  return { database, account, line, contact };
}

test('تفصیلیِ ردیف از روی طرف حسابِ هم‌نام چسبانده می‌شود', () => {
  const bench = workbench();
  bench.contact('شرکت آران گستر سپیده', 'آران گستر سپیده');
  const payable = bench.account('حساب پرداختنی — شرکت آران گستر سپیده', 'vendor-payable', 'شرکت آران گستر سپیده', 'liability');
  const lineId = bench.line(payable);
  const result = attachMissingCounterpartyAnalytics(bench.database);
  assert.equal(result.attached, 1);
  const analytic = listAnalyticAccounts(bench.database)[0];
  assert.equal(analytic.name, 'شرکت آران گستر سپیده');
  assert.equal(bench.database.prepare('SELECT analytic_id AS id FROM journal_lines WHERE id=?').get(lineId).id, analytic.id);
});

// عنوان تعهد شخص نیست. تفصیلیِ ساختگی در فهرست اشخاصِ دفتر می‌ماند و با
// هیچ‌کس یکی نمی‌شود؛ آن ردیف به طرف حساب نیاز دارد، نه به تفصیلی.
test('نامی که طرف حساب نیست، تفصیلی نمی‌سازد', () => {
  const bench = workbench();
  bench.line(bench.account('حساب پرداختنی — بدهی بی‌نام', 'vendor-payable', 'بدهی بی‌نام', 'liability'));
  const result = attachMissingCounterpartyAnalytics(bench.database);
  assert.equal(result.attached, 0);
  assert.equal(result.skipped, 1);
  assert.equal(listAnalyticAccounts(bench.database).length, 0);
});

test('حساب صندوق و هزینه تفصیلی نمی‌گیرند', () => {
  const bench = workbench();
  bench.line(bench.account('صندوق', 'operational-account', 'main', 'asset'));
  bench.line(bench.account('اجاره', 'expense-category', 'اجاره', 'expense'));
  assert.deepEqual(attachMissingCounterpartyAnalytics(bench.database), { attached: 0, skipped: 0, analytics: 0 });
  assert.equal(listAnalyticAccounts(bench.database).length, 0);
});

test('دو ردیف یک شخص، یک تفصیلی می‌گیرند و اجرای دوباره چیزی اضافه نمی‌کند', () => {
  const bench = workbench();
  bench.contact('آران گستر', 'آران گستر');
  const payable = bench.account('حساب پرداختنی — آران گستر', 'vendor-payable', 'آران گستر', 'liability');
  bench.line(payable);
  bench.line(payable);
  assert.equal(attachMissingCounterpartyAnalytics(bench.database).attached, 2);
  assert.equal(attachMissingCounterpartyAnalytics(bench.database).attached, 0);
  assert.equal(listAnalyticAccounts(bench.database).length, 1);
});

/**
 * تفصیلیِ هم‌نامِ موجود هم همان شخص است — چه از ثبت قبلی آمده باشد چه از فایل
 * تفصیلی نرم‌افزار دفتر. وگرنه یک نفر دو تفصیلی پیدا می‌کند و در پارسیان دو
 * بدهکار جدا می‌شود.
 */
test('تفصیلی موجود، دومی نمی‌سازد و «ي» عربی هم همان است', () => {
  const bench = workbench();
  const existing = saveAnalyticAccount(bench.database, { name: 'شرکت آران گستر', kind: 'contact', sourceKind: 'import', sourceKey: '1001' });
  assert.equal(counterpartyAnalyticForKey(bench.database, 'شركت آران گستر'), existing.id);
  assert.equal(listAnalyticAccounts(bench.database).length, 1);
});

// دو تفصیلیِ هم‌نام یعنی نام برای شناسایی کافی نیست؛ انتخاب یکی سکه انداختن
// روی سوابق ثبت‌شده است.
test('دو تفصیلی هم‌نام، هیچ‌کدام انتخاب نمی‌شوند', () => {
  const bench = workbench();
  saveAnalyticAccount(bench.database, { code: '9001', name: 'علی محمدی', sourceKind: 'import', sourceKey: 'a' });
  saveAnalyticAccount(bench.database, { code: '9002', name: 'علی محمدی', sourceKind: 'import', sourceKey: 'b' });
  assert.equal(counterpartyAnalyticForKey(bench.database, 'علی محمدی'), null);
});
