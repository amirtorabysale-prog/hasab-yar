import test from 'node:test';
import assert from 'node:assert/strict';
import { parsianDocumentsFromJournal, accountingTransferReadiness, buildAccountingTransferFile, TRANSFER_FILE_FORMATS } from '../server/accountingTransfer.js';

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
    settings: { targetSystem: 'parsian-review-csv', fileFormat: 'mdb', hasTransferTemplate: false, templateVerified: true, templateName: 'پارسیان ۱۴۰۲' },
  });
  const check = withoutTemplate.checks.find((item) => item.id === 'parsian-template');
  assert.equal(check.passed, false);
  assert.equal(withoutTemplate.ready, false);

  const withTemplate = accountingTransferReadiness({
    ...base,
    settings: { targetSystem: 'parsian-review-csv', fileFormat: 'mdb', hasTransferTemplate: true, templateVerified: true, templateName: 'پارسیان ۱۴۰۲' },
    mappings: [
      { ledgerAccountId: 'a1', targetCode: '0-1-10' },
      { ledgerAccountId: 'a2', targetCode: '1-2-12' },
    ],
  });
  assert.equal(withTemplate.checks.find((item) => item.id === 'parsian-template').passed, true);
  assert.equal(withTemplate.checks.find((item) => item.id === 'parsian-segments').passed, true);
});

test('readiness blocks an account that has no numeric kol or moeen code', () => {
  const readiness = accountingTransferReadiness({
    packageData: { checklist: { checks: [] }, sections: { transactions: [] } },
    journalRows: [{ ...JOURNAL_ROWS[0], kolCode: null, moeenCode: null }, JOURNAL_ROWS[1]],
    mappings: [], chart: { installed: true }, workflow: {},
    settings: { targetSystem: 'parsian-review-csv', fileFormat: 'mdb', hasTransferTemplate: true, templateVerified: true, templateName: 'x' },
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
