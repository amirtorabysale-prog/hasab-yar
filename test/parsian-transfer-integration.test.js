import test from 'node:test';
import assert from 'node:assert/strict';
import { parsianDocumentsFromJournal, accountingTransferReadiness, buildAccountingTransferFile,
  buildParsianMultipartPackage, splitParsianDocuments, TRANSFER_FILE_FORMATS } from '../server/accountingTransfer.js';
import { readZipArchive } from '../server/archive.js';

const JOURNAL_ROWS = [
  { entryId: 'e1', occurredAt: '2023-08-27T09:00:00.000Z', documentNumber: 117, memo: 'دریافت از مشتری',
    accountId: 'a1', accountCode: '1001', accountName: 'صندوق', kolCode: '10', moeenCode: '1', tafsiliCode: '',
    lineDescription: 'دریافت نقدی', debit: 500000, credit: 0 },
  { entryId: 'e1', occurredAt: '2023-08-27T09:00:00.000Z', documentNumber: 117, memo: 'دریافت از مشتری',
    accountId: 'a2', accountCode: '1301', accountName: 'مشتریان', kolCode: '12', moeenCode: '2', tafsiliCode: '1',
    lineDescription: 'طرف حساب نمونه', debit: 0, credit: 500000 },
];

test('journal rows become one Parsian document grouped by the hesab-yar entry', () => {
  const documents = parsianDocumentsFromJournal({ journalRows: JOURNAL_ROWS });
  assert.equal(documents.length, 1);
  assert.equal(documents[0].lines.length, 2);
  assert.match(documents[0].date, /^\d{4}\/\d{2}\/\d{2}$/);
  // شمارهٔ سند حساب‌یار در شرح می‌رود، چون پارسیان شمارهٔ فایل را دور می‌ریزد.
  assert.match(documents[0].comment, /حساب‌یار 117/);
});

test('the amount unit is applied once, in the file, not guessed later', () => {
  const toman = parsianDocumentsFromJournal({ journalRows: JOURNAL_ROWS, amountUnit: 'toman' });
  const rial = parsianDocumentsFromJournal({ journalRows: JOURNAL_ROWS, amountUnit: 'rial' });
  assert.equal(toman[0].lines[0].debit, 500000);
  assert.equal(rial[0].lines[0].debit, 5000000);
});

test('an account with no kol or moeen code stops the file instead of posting somewhere wrong', () => {
  let error;
  try {
    parsianDocumentsFromJournal({ journalRows: [
      { ...JOURNAL_ROWS[0], kolCode: '', moeenCode: '' },
      JOURNAL_ROWS[1],
    ] });
  } catch (caught) { error = caught; }
  assert.equal(error.code, 'PARSIAN_JOURNAL_NOT_READY');
  assert.match(error.details.errors.join(' '), /صندوق/);
});

test('a non numeric tafsili code is refused instead of silently becoming zero', () => {
  let error;
  try {
    parsianDocumentsFromJournal({ journalRows: [
      JOURNAL_ROWS[0],
      { ...JOURNAL_ROWS[1], tafsiliCode: 'SAMPLE-01' },
    ] });
  } catch (caught) { error = caught; }
  assert.equal(error.code, 'PARSIAN_JOURNAL_NOT_READY');
  assert.match(error.details.errors.join(' '), /کد تفصیلی/);
  // تبدیل بی‌صدا به صفر یعنی ردیف روی معین می‌نشیند و طرف‌حساب گم می‌شود.
});

test('a missing tafsili is zero, which in Parsian means posting to the moeen', () => {
  const documents = parsianDocumentsFromJournal({ journalRows: JOURNAL_ROWS });
  assert.equal(documents[0].lines[0].tafsiliCode, 0);
  assert.equal(documents[0].lines[1].tafsiliCode, 1);
});

test('building the Parsian file without a template refuses instead of writing rubbish', () => {
  let error;
  try {
    buildAccountingTransferFile({ period: '1402-06', journalRows: JOURNAL_ROWS, fileFormat: 'mdb', template: null });
  } catch (caught) { error = caught; }
  assert.equal(error.code, 'PARSIAN_TEMPLATE_MISSING');
  assert.match(error.message, /انتقال اسناد به فایل/);
});

test('readiness blocks the Parsian file until the template is loaded', () => {
  const base = {
    packageData: { checklist: { checks: [] }, sections: { transactions: [] } },
    journalRows: JOURNAL_ROWS, mappings: [], chart: { installed: true }, workflow: {},
  };
  const withoutTemplate = accountingTransferReadiness({
    ...base,
    settings: { targetSystem: 'parsian-review-csv', fileFormat: 'mdb', hasTransferTemplate: false, templateVerified: true, templateName: 'پارسیان ۱۴۰۲', fiscalYearStart: '1402/01/01', fiscalYearEnd: '1402/12/29' },
  });
  const check = withoutTemplate.checks.find((item) => item.id === 'parsian-template');
  assert.equal(check.passed, false);
  assert.equal(withoutTemplate.ready, false);

  const withTemplate = accountingTransferReadiness({
    ...base,
    settings: { targetSystem: 'parsian-review-csv', fileFormat: 'mdb', hasTransferTemplate: true, templateVerified: true, templateName: 'پارسیان ۱۴۰۲', fiscalYearStart: '1402/01/01', fiscalYearEnd: '1402/12/29' },
    mappings: [
      { ledgerAccountId: 'a1', targetCode: '0-1-10' },
      { ledgerAccountId: 'a2', targetCode: '1-2-12' },
    ],
  });
  assert.equal(withTemplate.checks.find((item) => item.id === 'parsian-template').passed, true);
  assert.equal(withTemplate.checks.find((item) => item.id === 'parsian-segments').passed, true);
  assert.equal(withTemplate.checks.find((item) => item.id === 'parsian-fiscal-year').passed, true);
});

test('readiness names every document outside the open Parsian fiscal year', () => {
  const readiness = accountingTransferReadiness({
    packageData: { checklist: { checks: [] }, sections: { transactions: [] }, scope: { timeZone: 'Asia/Tehran' } },
    journalRows: JOURNAL_ROWS, mappings: [
      { ledgerAccountId: 'a1', targetCode: '10-1' },
      { ledgerAccountId: 'a2', targetCode: '12-2' },
    ], chart: { installed: true }, workflow: {},
    settings: { targetSystem: 'parsian-review-csv', fileFormat: 'mdb', hasTransferTemplate: true,
      templateVerified: true, templateName: 'پارسیان ۱۴۰۱', fiscalYearStart: '1401/01/01', fiscalYearEnd: '1401/12/29' },
  });
  const check = readiness.checks.find((item) => item.id === 'parsian-fiscal-year');
  assert.equal(check.passed, false);
  assert.equal(check.count, 1);
  assert.equal(check.outsideDocuments[0].documentNumber, 117);
  assert.match(check.outsideDocuments[0].date, /^1402\//);
  assert.equal(readiness.ready, false);
});

test('readiness blocks an account that has no numeric kol or moeen code', () => {
  const readiness = accountingTransferReadiness({
    packageData: { checklist: { checks: [] }, sections: { transactions: [] } },
    journalRows: [{ ...JOURNAL_ROWS[0], kolCode: null, moeenCode: null }, JOURNAL_ROWS[1]],
    mappings: [], chart: { installed: true }, workflow: {},
    settings: { targetSystem: 'parsian-review-csv', fileFormat: 'mdb', hasTransferTemplate: true, templateVerified: true, templateName: 'x', fiscalYearStart: '1402/01/01', fiscalYearEnd: '1402/12/29' },
  });
  const check = readiness.checks.find((item) => item.id === 'parsian-segments');
  assert.equal(check.passed, false);
  assert.equal(check.count, 1);
});

test('the two human readable formats are unaffected by the Parsian format', () => {
  assert.equal(TRANSFER_FILE_FORMATS.csv.requiresTemplate, undefined);
  assert.equal(TRANSFER_FILE_FORMATS.xlsx.requiresTemplate, undefined);
  assert.equal(TRANSFER_FILE_FORMATS.mdb.requiresTemplate, true);
  const csv = buildAccountingTransferFile({ period: '1402-06', journalRows: JOURNAL_ROWS, fileFormat: 'csv' });
  assert.ok(csv.buffer.length > 0);
});

test('large Parsian packages split between documents and never through one', () => {
  const documents = Array.from({ length: 205 }, (_unused, index) => ({
    date: '1402/06/05', comment: `سند ${index + 1}`, lines: [
      { kolCode: 10, moeenCode: 1, debit: 1, credit: 0 },
      { kolCode: 12, moeenCode: 2, debit: 0, credit: 1 },
    ],
  }));
  const parts = splitParsianDocuments(documents, 401);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].length, 200);
  assert.equal(parts[0].reduce((sum, item) => sum + item.lines.length, 0), 400);
  assert.equal(parts[1].length, 5);
  assert.throws(() => splitParsianDocuments([{ date: '1402/06/05', lines: Array(402).fill({}) }]),
    (error) => error.code === 'PARSIAN_DOCUMENT_TOO_LARGE');
});

test('multipart Parsian ZIP carries ordered files, hashes and exact totals', () => {
  const documents = Array.from({ length: 205 }, (_unused, index) => ({
    date: '1402/06/05', comment: `سند ${index + 1}`, lines: [
      { kolCode: 10, moeenCode: 1, debit: index + 1, credit: 0 },
      { kolCode: 12, moeenCode: 2, debit: 0, credit: index + 1 },
    ],
  }));
  const built = buildParsianMultipartPackage({ documents, period: '1402-06',
    buildPart: (group, index) => Buffer.from(`part-${index + 1}-documents-${group.length}`) });
  assert.equal(built.manifest.totals.partCount, 2);
  assert.equal(built.manifest.totals.rowCount, 410);
  assert.equal(built.manifest.totals.documentCount, 205);
  assert.equal(built.manifest.totals.debit, built.manifest.totals.credit);
  assert.deepEqual(built.manifest.importOrder, built.manifest.parts.map((item) => item.name));
  assert.ok(built.manifest.parts.every((item) => item.sha256.length === 64 && item.rowCount <= 401));
  const files = readZipArchive(built.archive);
  assert.ok(files.has('manifest.json'));
  assert.ok(files.has('README-FA.txt'));
  assert.ok(built.manifest.parts.every((item) => files.has(item.name)));
  assert.deepEqual(JSON.parse(files.get('manifest.json').toString('utf8')), built.manifest);
});
