import test from 'node:test';
import assert from 'node:assert/strict';
import { parsianHCode, applyTransferTemplate, TRANSFER_FIELDS } from '../server/transferTemplates.js';

// این تست قرارداد schema پارسیان را با fixtureهای کاملاً ساختگی قفل می‌کند.
// شواهد میدانی و فایل نصب مشتری خارج از Git نگه‌داری می‌شوند. سه نکتهٔ فنی:
//
//   ۱. SanadDate یک nvarchar است، نه datetime، و خود پارسیان در VW_Document
//      ماه را با SUBSTRING(SanadDate, 6, 2) از آن بیرون می‌کشد. پس قالب دقیقاً
//      «YYYY/MM/DD» ده‌نویسه‌ای با صفر ابتدای ماه و روز است و «1405/6/5»
//      گزارش‌های ماهانهٔ خود پارسیان را بی‌صدا خراب می‌کند.
//   ۲. کدی که اپراتور می‌بیند در VW_HCode برعکس کدینگ ساخته می‌شود:
//      تفصیلی-معین-کل، و برای معین بدون تفصیلی تفصیلی صفر می‌شود.
//   ۳. کد معین و کد تفصیلی سراسری نیستند: معین زیرمجموعهٔ کل است
//      (tbl_Moeen با کلید KolCode+Code) و تفصیلی زیرمجموعهٔ معین
//      (tbl_Tafsili با کلید KolCode+MoeenCode+Code).

// ردیف‌های ساختگی tbl_Document؛ فقط شکل داده مهم است.
const SYNTHETIC_DOCUMENT_ROWS = [
  { ID: 1, Sanad_Num: 2, SanadDate: '1405/06/05', KolCode: 62, MoeenCode: 1, TafsiliCode: 0, Bed: 12345000, Bes: 0 },
  { ID: 2, Sanad_Num: 2, SanadDate: '1405/06/05', KolCode: 12, MoeenCode: 2, TafsiliCode: 1, Bed: 0, Bes: 12345000 },
];

test('the Parsian month extraction only works on a zero padded YYYY/MM/DD date', () => {
  // همان کاری که VW_Document می‌کند: SUBSTRING(SanadDate, 6, 2)
  const parsianMonth = (value) => Number(value.slice(5, 7));
  for (const row of SYNTHETIC_DOCUMENT_ROWS) assert.equal(parsianMonth(row.SanadDate), 6);
  assert.notEqual(parsianMonth('1405/6/5'), 6, 'تاریخ بدون صفر، ماه را جابه‌جا می‌خواند');
});

test('the exported Jalali date keeps the exact ten character shape Parsian slices', () => {
  const { rows } = applyTransferTemplate({
    columns: [
      { field: 'dateJalali', header: 'تاریخ' },
      { field: 'debitToman', header: 'بدهکار' },
      { field: 'creditToman', header: 'بستانکار' },
      { field: 'kolCode', header: 'کل' },
    ],
    journalRows: [{ entryId: 'e1', occurredAt: '2026-08-27T09:00:00.000Z', debit: 1000, credit: 0, kolCode: '62' }],
    persianDate: () => '1405/06/05',
  });
  const date = rows[0][0];
  assert.equal(date.length, 10);
  assert.match(date, /^\d{4}\/\d{2}\/\d{2}$/);
});

test('the operator facing account code is tafsili-moeen-kol, not the chart code', () => {
  // صندوق: کل ۱۰، معین ۱، بدون تفصیلی
  assert.equal(parsianHCode({ kolCode: '10', moeenCode: '1' }), '0-1-10');
  // طرف حساب نمونه: کل ۱۲، معین ۲، تفصیلی ۱
  assert.equal(parsianHCode({ kolCode: '12', moeenCode: '2', tafsiliCode: '1' }), '1-2-12');
  // خريــــد: کل ۶۲، معین ۱
  assert.equal(parsianHCode({ kolCode: '62', moeenCode: '1', tafsiliCode: '0' }), '0-1-62');
});

test('a line with no chart mapping gets no Parsian code instead of a wrong one', () => {
  assert.equal(parsianHCode({}), '');
  assert.equal(parsianHCode({ kolCode: '12' }), '', 'کل بدون معین یک حساب قابل ثبت نیست');
  assert.equal(parsianHCode({ moeenCode: '2', tafsiliCode: '1' }), '');
});

test('the Parsian code column is offered as a template field and fills from the journal row', () => {
  assert.ok(TRANSFER_FIELDS.some((item) => item.id === 'parsianHCode'));
  const { rows } = applyTransferTemplate({
    columns: [
      { field: 'parsianHCode', header: 'کد حساب' },
      { field: 'debitRial', header: 'بدهکار' },
      { field: 'creditRial', header: 'بستانکار' },
    ],
    journalRows: [
      { entryId: 'e1', kolCode: '62', moeenCode: '1', tafsiliCode: '', debit: 1234500, credit: 0 },
      { entryId: 'e1', kolCode: '12', moeenCode: '2', tafsiliCode: '1', debit: 0, credit: 1234500 },
    ],
  });
  assert.deepEqual(rows.map((row) => row[0]), ['0-1-62', '1-2-12']);
  // همان سند ساختگی، وقتی دفتر واحد را ریال اعلام کند.
  assert.deepEqual(rows.map((row) => row[1]), [SYNTHETIC_DOCUMENT_ROWS[0].Bed, 0]);
  assert.deepEqual(rows.map((row) => row[2]), [0, SYNTHETIC_DOCUMENT_ROWS[1].Bes]);
});

test('a moeen code is only meaningful under its kol', () => {
  // در کدینگ تفکیکی پارسیان، یک کد معین می‌تواند زیر چند کل تکرار شود؛
  // پس کد معین به‌تنهایی یک حساب نیست.
  const codes = new Set([
    parsianHCode({ kolCode: '10', moeenCode: '1' }),
    parsianHCode({ kolCode: '12', moeenCode: '1' }),
    parsianHCode({ kolCode: '62', moeenCode: '1' }),
  ]);
  assert.equal(codes.size, 3);
});
