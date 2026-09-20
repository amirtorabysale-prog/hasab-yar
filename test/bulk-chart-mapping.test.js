import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  bulkMapLedgerAccounts, chartMappingOverview, ensureChartSchema, importChartOfAccounts, parseChartCsv,
} from '../server/chartOfAccounts.js';

/**
 * نگاشت دستیِ حساب‌به‌حساب، کار دفتری است که حساب‌یار قرار بود کمش کند.
 *
 * حدس خودکار برداشته شد چون در کدینگ یک دفتر واقعی همهٔ هزینه‌ها را روی یک
 * معین بی‌ربط نشاند. جایگزینش باید یک تصمیمِ آگاهانه برای یک گروه باشد، نه
 * پنجاه انتخاب تکی.
 */
function workbench() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE journal_lines (id TEXT PRIMARY KEY, account_id TEXT, debit INTEGER DEFAULT 0, credit INTEGER DEFAULT 0);
    CREATE TABLE ledger_accounts (id TEXT PRIMARY KEY, code TEXT, name TEXT, type TEXT,
      source_kind TEXT, source_key TEXT, active INTEGER NOT NULL DEFAULT 1);
  `);
  ensureChartSchema(database);
  const { rows } = parseChartCsv([
    'کد,نام,سطح,کد والد,نوع,نقش',
    '5,هزینه‌ها,گروه,,هزینه,',
    '50,هزینه‌های عملیاتی,کل,5,هزینه,',
    '5001,بازاریاب,معین,50,هزینه,',
    '5008,هزینه‌های متفرقه,معین,50,هزینه,',
    '1,دارایی‌ها,گروه,,دارایی,',
    '11,نقد,کل,1,دارایی,',
    '1101,صندوق,معین,11,دارایی,cash',
  ].join('\n'));
  importChartOfAccounts(database, rows);
  const add = (code, name, type) => {
    const id = randomUUID();
    database.prepare('INSERT INTO ledger_accounts (id,code,name,type,source_kind,source_key) VALUES (?,?,?,?,?,?)')
      .run(id, code, name, type, `${type}-category`, name);
    return id;
  };
  return {
    database,
    expenses: ['پذیرایی', 'ایاب و ذهاب', 'نظافت'].map((name, index) => add(`60${index}`, name, 'expense')),
    cash: add('100', 'صندوق فروشگاه', 'asset'),
    chartId: (code) => database.prepare('SELECT id FROM chart_accounts WHERE code=?').get(code).id,
  };
}

test('چند حساب با یک تصمیم به یک معین می‌نشینند', () => {
  const bench = workbench();
  const result = bulkMapLedgerAccounts(bench.database, bench.expenses, bench.chartId('5008'));
  assert.equal(result.mapped, 3);
  assert.equal(result.skipped.length, 0);
  const overview = chartMappingOverview(bench.database);
  assert.equal(overview.unmappedCount, 1, 'فقط حساب دارایی بدون نگاشت می‌ماند');
  for (const item of overview.items.filter((row) => row.type === 'expense')) assert.equal(item.chartCode, '5008');
});

// یک ردیف ناسازگار نباید کل اقدام را برگرداند؛ ولی باید دیده شود.
test('حساب ناهم‌نوع کنار گذاشته می‌شود و بقیه انجام می‌شوند', () => {
  const bench = workbench();
  const result = bulkMapLedgerAccounts(bench.database, [...bench.expenses, bench.cash], bench.chartId('5008'));
  assert.equal(result.mapped, 3);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].message, /صندوق فروشگاه/);
  assert.equal(chartMappingOverview(bench.database).unmappedCount, 1);
});

test('انتخاب خالی، خطای روشن می‌دهد', () => {
  const bench = workbench();
  assert.throws(() => bulkMapLedgerAccounts(bench.database, [], bench.chartId('5008')), (error) => error.code === 'LEDGER_ACCOUNTS_EMPTY');
});

// معین غیرقابل‌ثبت (کل یا گروه) در پارسیان سند نمی‌پذیرد؛ این خطا باید کل
// اقدام را برگرداند، نه اینکه ردیف‌به‌ردیف کنار گذاشته شود.
test('نگاشت گروهی به کل، چیزی را نگاشت نمی‌کند', () => {
  const bench = workbench();
  assert.throws(() => bulkMapLedgerAccounts(bench.database, bench.expenses, bench.chartId('50')), (error) => error.code === 'CHART_NOT_POSTABLE');
  assert.equal(chartMappingOverview(bench.database).unmappedCount, 4);
});
