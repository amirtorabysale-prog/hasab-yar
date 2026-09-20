import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { accountingTransferReadiness, parsianDocumentsFromJournal } from '../server/accountingTransfer.js';
import { ensureChartSchema, importChartOfAccounts, listChartAccounts, parseChartCsv } from '../server/chartOfAccounts.js';

/**
 * «سند غیرموازنه» در پارسیان، از فایل نامتوازن نمی‌آید.
 *
 * فایل ما متوازن است؛ پارسیان ردیفی را که نمی‌پذیرد کنار می‌گذارد و طرف دیگرِ
 * همان سند تنها می‌ماند. شایع‌ترین دلیلِ نپذیرفتن، معینِ «تفصیلی اجباری» است
 * که ردیف برایش کد تفصیلی ندارد. پس این را پیش از ساخت فایل می‌گیریم، نه بعد
 * از دیدنش در پارسیان.
 */
const line = (extra = {}) => ({
  entryId: 'e1', occurredAt: '2025-06-01T09:00:00.000Z', memo: 'فروش', documentNumber: 12,
  accountId: 'a1', accountCode: '1201', accountName: 'حساب‌های دریافتنی',
  kolCode: '12', moeenCode: '01', moeenName: 'بدهکاران تجاری',
  debit: 1_000_000, credit: 0, ...extra,
});

const twoSidedEntry = (requiresAnalytic, tafsiliCode) => [
  line({ requiresAnalytic, tafsiliCode, analyticId: 'n1', analyticName: 'شرکت آرمان' }),
  line({ accountId: 'a2', accountCode: '1101', accountName: 'صندوق', kolCode: '10', moeenCode: '01', moeenName: 'صندوق', debit: 0, credit: 1_000_000 }),
];

test('ردیفِ معین تفصیلی‌دار بدون کد تفصیلی، فایل پارسیان را متوقف می‌کند', () => {
  assert.throws(() => parsianDocumentsFromJournal({ journalRows: twoSidedEntry(1, '') }), (error) => {
    assert.equal(error.code, 'PARSIAN_JOURNAL_NOT_READY');
    assert.match(error.details.errors.join(' '), /تفصیلی اجباری/);
    return true;
  });
});

test('همان ردیف با کد تفصیلی، بی‌ایراد ساخته می‌شود', () => {
  const [document] = parsianDocumentsFromJournal({ journalRows: twoSidedEntry(1, '1001') });
  assert.equal(document.lines.length, 2);
  assert.equal(document.lines[0].tafsiliCode, 1001);
});

test('معینی که تفصیلی اجباری نیست، بدون تفصیلی هم می‌رود', () => {
  const [document] = parsianDocumentsFromJournal({ journalRows: twoSidedEntry(0, '') });
  assert.equal(document.lines[0].tafsiliCode, 0);
});

test('آمادگی خروجی، این ایراد را بازدارنده اعلام می‌کند', () => {
  const blocked = accountingTransferReadiness({ journalRows: twoSidedEntry(1, ''), settings: { fileFormat: 'csv' } });
  const check = blocked.checks.find((item) => item.id === 'analytic-required');
  assert.equal(check.passed, false);
  assert.equal(check.severity, 'blocker');
  assert.equal(check.count, 1);

  const clean = accountingTransferReadiness({ journalRows: twoSidedEntry(1, '1001'), settings: { fileFormat: 'csv' } });
  assert.equal(clean.checks.find((item) => item.id === 'analytic-required').passed, true);
});

/**
 * ستون «تفصیلی اجباری» باید از فایل کدینگ بیاید؛ اگر قرار باشد حسابدار آن را
 * معین‌به‌معین تیک بزند، همان کار دستی‌ای است که حساب‌یار قرار بود بردارد.
 */
test('ستون تفصیلی اجباری از فایل کدینگ خوانده می‌شود', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE journal_lines (id TEXT PRIMARY KEY, account_id TEXT, debit INTEGER DEFAULT 0, credit INTEGER DEFAULT 0);
    CREATE TABLE ledger_accounts (id TEXT PRIMARY KEY, code TEXT, name TEXT, type TEXT);
  `);
  ensureChartSchema(database);
  const { rows } = parseChartCsv([
    'کد,نام,سطح,کد والد,نوع,کد سطح,نقش,تفصیلی اجباری',
    '10,صندوق,کل,,دارایی,10,,',
    '1001,صندوق اصلی,معین,10,دارایی,1,cash,خیر',
    '12,بدهکاران,کل,,دارایی,12,,',
    '1202,مشتریان,معین,12,دارایی,2,,بله',
  ].join('\n'));
  importChartOfAccounts(database, rows, { codingStyle: 'segmented' });
  const chart = Object.fromEntries(listChartAccounts(database).map((item) => [item.code, item.requiresAnalytic]));
  assert.equal(chart['1202'], true);
  assert.equal(chart['1001'], false);
});

/**
 * وقتی فایل چیزی نگفته، نقش حساب حرف می‌زند: بدهکاران و بستانکاران بدون طرف
 * حساب معنا ندارند. این حدس فقط یک بازدارندهٔ قابل‌خاموش‌کردن می‌سازد، نه یک
 * ثبت خاموش.
 */
test('بدون ستون، معینِ دریافتنی و پرداختنی تفصیلی‌دار فرض می‌شوند', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE journal_lines (id TEXT PRIMARY KEY, account_id TEXT, debit INTEGER DEFAULT 0, credit INTEGER DEFAULT 0);
    CREATE TABLE ledger_accounts (id TEXT PRIMARY KEY, code TEXT, name TEXT, type TEXT);
  `);
  ensureChartSchema(database);
  const { rows } = parseChartCsv([
    'کد,نام,سطح,کد والد,نوع,نقش',
    '1,دارایی جاری,گروه,,دارایی,',
    '12,دریافتنی,کل,1,دارایی,',
    '1201,بدهکاران تجاری,معین,12,دارایی,receivable',
    '11,نقد,کل,1,دارایی,',
    '1101,صندوق,معین,11,دارایی,cash',
  ].join('\n'));
  importChartOfAccounts(database, rows);
  const chart = Object.fromEntries(listChartAccounts(database).map((item) => [item.code, item.requiresAnalytic]));
  assert.equal(chart['1201'], true);
  assert.equal(chart['1101'], false);
});
