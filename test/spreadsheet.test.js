import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkbook, columnIndex, columnName, isXlsxBuffer, readDelimitedText, readTabularFile, readWorkbook,
  SPREADSHEET_LIMITS,
} from '../server/spreadsheet.js';
import {
  DEFAULT_TRANSFER_COLUMNS, applyTransferTemplate, normalizeAmountUnit, normalizeTransferColumns,
} from '../server/transferTemplates.js';
import { parseCellAmount } from '../server/ledgerImport.js';

test('column letters and indexes round-trip past Z', () => {
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(701), 'ZZ');
  for (const index of [0, 25, 26, 51, 701, 702]) assert.equal(columnIndex(columnName(index)), index);
});

test('a written workbook reads back with Persian text, sheets and leading zeros intact', () => {
  const buffer = buildWorkbook([
    { name: 'دفتر کل', rows: [['کد', 'نام', 'بدهکار'], ['0012', 'صندوق نقدی', 5_000_000]] },
    { name: 'شناسنامه', rows: [['واحد', 'تومان']] },
  ]);
  assert.equal(isXlsxBuffer(buffer), true);
  const sheets = readWorkbook(buffer);
  assert.deepEqual(sheets.map((item) => item.name), ['دفتر کل', 'شناسنامه']);
  assert.deepEqual(sheets[0].rows[0], ['کد', 'نام', 'بدهکار']);
  assert.equal(sheets[0].rows[1][0], '0012', 'صفر ابتدای کد حساب نباید گم شود');
  assert.equal(sheets[0].rows[1][2], '5000000');
  assert.deepEqual(sheets[1].rows[0], ['واحد', 'تومان']);
});

test('xml-hostile text survives the round-trip', () => {
  const nasty = 'شرح با <تگ> و "نقل" و & و \'آپستروف\'';
  const sheets = readWorkbook(buildWorkbook([{ name: 'x', rows: [[nasty]] }]));
  assert.equal(sheets[0].rows[0][0], nasty);
});

test('the same content always produces the same bytes', () => {
  const rows = [['a', 1], ['b', 2]];
  const first = buildWorkbook([{ name: 'S', rows }]);
  const second = buildWorkbook([{ name: 'S', rows }]);
  assert.equal(first.equals(second), true, 'digest خروجی نباید با گذر زمان عوض شود');
});

test('unsafe sheet names are cleaned instead of producing a broken file', () => {
  const sheets = readWorkbook(buildWorkbook([{ name: 'a/b*c?[d]:e', rows: [['x']] }]));
  assert.doesNotMatch(sheets[0].name, /[\\/*?:[\]]/);
});

test('a non-xlsx buffer is refused with a clear message', () => {
  assert.throws(() => readWorkbook(Buffer.from('این یک فایل اکسل نیست')), (error) => error.code === 'SPREADSHEET_NOT_XLSX');
  assert.throws(() => buildWorkbook([]), (error) => error.code === 'SPREADSHEET_NO_SHEET');
});

test('xlsx limits are enforced before a suspicious ZIP entry is inflated', () => {
  const workbook = buildWorkbook([{ name: 'x', rows: [['a']] }]);
  const endOffset = workbook.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const centralOffset = workbook.readUInt32LE(endOffset + 16);

  const oversized = Buffer.from(workbook);
  oversized.writeUInt32LE(SPREADSHEET_LIMITS.maxEntryBytes + 1, centralOffset + 24);
  assert.throws(() => readWorkbook(oversized), (error) => error.code === 'SPREADSHEET_ENTRY_TOO_LARGE' && error.status === 413);

  const bombRatio = Buffer.from(workbook);
  const compressedSize = bombRatio.readUInt32LE(centralOffset + 20);
  bombRatio.writeUInt32LE(compressedSize * (SPREADSHEET_LIMITS.maxCompressionRatio + 1), centralOffset + 24);
  assert.throws(() => readWorkbook(bombRatio), (error) => error.code === 'SPREADSHEET_COMPRESSION_RATIO' && error.status === 413);
});

test('corrupt ZIP offsets are rejected without reading outside the upload buffer', () => {
  const workbook = buildWorkbook([{ name: 'x', rows: [['a']] }]);
  const endOffset = workbook.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const centralOffset = workbook.readUInt32LE(endOffset + 16);
  const corrupt = Buffer.from(workbook);
  corrupt.writeUInt32LE(corrupt.length + 100, centralOffset + 42);
  assert.throws(() => readWorkbook(corrupt), (error) => error.code === 'SPREADSHEET_CORRUPT');
});

test('row, column and cell ceilings also protect CSV imports', () => {
  const tooManyRows = Array.from({ length: SPREADSHEET_LIMITS.maxRows + 1 }, () => 'a').join('\n');
  assert.throws(() => readDelimitedText(tooManyRows), (error) => error.code === 'SPREADSHEET_TOO_MANY_ROWS' && error.status === 413);

  const tooManyColumns = Array.from({ length: SPREADSHEET_LIMITS.maxColumns + 1 }, () => 'a').join(',');
  assert.throws(() => readDelimitedText(tooManyColumns), (error) => error.code === 'SPREADSHEET_TOO_MANY_COLUMNS' && error.status === 413);
});

test('a valid workbook at ordinary office scale still reads normally', () => {
  const rows = Array.from({ length: 2_000 }, (_item, index) => [String(index + 1), `حساب ${index + 1}`, index]);
  const workbook = buildWorkbook([{ name: 'کدینگ', rows }]);
  const parsed = readWorkbook(workbook);
  assert.equal(parsed[0].rows.length, 2_000);
  assert.equal(parsed[0].rows[1][1], 'حساب 2');
});

test('csv is detected by content, not by file extension', () => {
  const csv = Buffer.from('﻿کد;نام\n1101;صندوق', 'utf8');
  const sheets = readTabularFile(csv, 'whatever.xlsx');
  assert.deepEqual(sheets[0].rows, [['کد', 'نام'], ['1101', 'صندوق']]);
  assert.equal(readDelimitedText('a,b\n1,2')[0].rows.length, 2);
});

test('amounts are read with Persian digits, separators and accounting parentheses', () => {
  assert.equal(parseCellAmount('۱٬۲۵۰٬۰۰۰'), 1_250_000);
  assert.equal(parseCellAmount('1,250,000'), 1_250_000);
  assert.equal(parseCellAmount('(500)'), -500);
  assert.equal(parseCellAmount('-500'), -500);
  assert.equal(parseCellAmount(''), 0);
  // متن غیرعددی هرگز صفر تفسیر نمی‌شود.
  assert.equal(parseCellAmount('نامشخص'), null);
  assert.equal(parseCellAmount('12a'), null);
});

test('a template must carry both sides of the amount and an account code', () => {
  assert.throws(() => normalizeTransferColumns([{ field: 'accountCode' }, { field: 'debit' }]), (error) => error.code === 'TRANSFER_TEMPLATE_NO_AMOUNT');
  assert.throws(() => normalizeTransferColumns([{ field: 'debit' }, { field: 'credit' }]), (error) => error.code === 'TRANSFER_TEMPLATE_NO_ACCOUNT');
  assert.throws(() => normalizeTransferColumns([{ field: 'nope' }]), (error) => error.code === 'TRANSFER_TEMPLATE_ROWS_INVALID');
});

test('duplicate column headers are rejected because the target cannot tell them apart', () => {
  assert.throws(
    () => normalizeTransferColumns([
      { field: 'accountCode', header: 'کد' }, { field: 'chartCode', header: 'کد' },
      { field: 'debit', header: 'بدهکار' }, { field: 'credit', header: 'بستانکار' },
    ]),
    (error) => /تکراری/.test(error.details.errors[0].message),
  );
});

test('an empty column list falls back to the full default layout', () => {
  const { columns } = normalizeTransferColumns([]);
  assert.equal(columns.length, DEFAULT_TRANSFER_COLUMNS.length);
  assert.equal(columns[0].field, 'entryId');
});

test('the template converts amounts to the unit the office asked for', () => {
  const journalRows = [
    { entryId: 'e1', accountId: 'a1', accountCode: '1100', accountName: 'صندوق', chartCode: '1101', debit: 250_000, credit: 0, occurredAt: '2026-08-20T09:00:00.000Z', entryKind: 'normal', sourceType: 'transaction', sourceId: 't1', memo: 'فروش' },
    { entryId: 'e1', accountId: 'a2', accountCode: '4100', accountName: 'فروش', chartCode: '6101', debit: 0, credit: 250_000, occurredAt: '2026-08-20T09:00:00.000Z', entryKind: 'normal', sourceType: 'transaction', sourceId: 't1', memo: 'فروش' },
  ];
  const columns = [
    { field: 'chartCode', header: 'کد حساب' }, { field: 'debit', header: 'بدهکار' }, { field: 'credit', header: 'بستانکار' },
  ];
  const rial = applyTransferTemplate({ columns, amountUnit: 'rial', journalRows, period: '1405-05' });
  assert.deepEqual(rial.headers, ['کد حساب', 'بدهکار', 'بستانکار']);
  assert.deepEqual(rial.rows[0], ['1101', 2_500_000, 0]);
  assert.equal(rial.totals.debit, 2_500_000);
  assert.equal(rial.totals.debitToman, 250_000);

  const toman = applyTransferTemplate({ columns, amountUnit: 'toman', journalRows, period: '1405-05' });
  assert.deepEqual(toman.rows[0], ['1101', 250_000, 0]);
});

test('explicit toman and rial columns keep their own unit regardless of template unit', () => {
  const journalRows = [{ entryId: 'e1', accountId: 'a1', accountCode: '1100', debit: 1_000, credit: 0, occurredAt: '2026-08-20T09:00:00.000Z' }];
  const table = applyTransferTemplate({
    columns: [
      { field: 'accountCode', header: 'کد' }, { field: 'debitToman', header: 'تومان' },
      { field: 'debitRial', header: 'ریال' }, { field: 'credit', header: 'بستانکار' },
    ],
    amountUnit: 'rial', journalRows, period: '1405-05',
  });
  assert.deepEqual(table.rows[0], ['1100', 1_000, 10_000, 0]);
});

test('line numbers restart for each document', () => {
  const journalRows = [
    { entryId: 'e1', accountId: 'a', accountCode: '1', debit: 1, credit: 0, occurredAt: '2026-08-20T09:00:00.000Z' },
    { entryId: 'e1', accountId: 'b', accountCode: '2', debit: 0, credit: 1, occurredAt: '2026-08-20T09:00:00.000Z' },
    { entryId: 'e2', accountId: 'a', accountCode: '1', debit: 2, credit: 0, occurredAt: '2026-08-21T09:00:00.000Z' },
  ];
  const table = applyTransferTemplate({
    columns: [{ field: 'lineNumber', header: 'ردیف' }, { field: 'accountCode', header: 'کد' }, { field: 'debit', header: 'بد' }, { field: 'credit', header: 'بس' }],
    journalRows, period: '1405-05',
  });
  assert.deepEqual(table.rows.map((row) => row[0]), [1, 2, 1]);
});

test('an unknown amount unit falls back to toman rather than guessing', () => {
  assert.equal(normalizeAmountUnit('dollar'), 'toman');
  assert.equal(normalizeAmountUnit('rial'), 'rial');
});
