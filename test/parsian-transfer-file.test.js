import test from 'node:test';
import assert from 'node:assert/strict';
import { parsianHCode, applyTransferTemplate } from '../server/transferTemplates.js';

// این تست بر پایهٔ یک فایل انتقال واقعی نوشته شده که خودِ پارسیان ساخت:
// امکانات ← سامانه تبادل اطلاعات ← سامانه تبادل اطلاعات اسناد ← «انتقال اسناد به فایل».
// فایل در parsian/parsian-document-export.mdb نگه داشته می‌شود (gitignore).
//
// آنچه از آن فایل قطعی شد:
//   ۱. قالب انتقال یک دیتابیس Access (Jet 4، امضای «Standard Jet DB») است، نه
//      CSV و نه اکسل. پسوند فایل هیچ نقشی ندارد — همان فایل با پسوند .txt
//      ساخته و پذیرفته شد. یعنی تشخیص نوع باید از بایت محتوا باشد.
//   ۲. جدول tbl_Document در فایل دقیقاً همان ۱۷ ستون SQL Server را دارد.
//   ۳. فایل انتقال هیچ‌کدام از tbl_Kol / tbl_Moeen / tbl_Tafsili را حمل نمی‌کند،
//      پس کد حساب باید از قبل در مقصد موجود باشد.
//   ۴. مبلغ بدون هیچ تبدیلی منتقل می‌شود؛ همان عدد خام double.

// دو ردیف واقعی خروجی: سند ۴، متوازن، صندوق در برابر یک تفصیلی.
const REAL_EXPORT_ROWS = [
  { ID: 1, Sanad_Num: 4, SanadDate: '1402/06/05', KolCode: 10, MoeenCode: 1, TafsiliCode: 0, Comment: '', Bed: 20000000, Bes: 0, IsNote: 0, Factor_Num: null, CostCenterCode: null },
  { ID: 2, Sanad_Num: 4, SanadDate: '1402/06/05', KolCode: 12, MoeenCode: 2, TafsiliCode: 1, Comment: '', Bed: 0, Bes: 20000000, IsNote: 0, Factor_Num: null, CostCenterCode: null },
];

// ستون‌های tbl_Document در فایل انتقال، به همان ترتیب و نوع.
const TRANSFER_COLUMNS = Object.freeze([
  'ID', 'Sanad_Num', 'SanadDate', 'KolCode', 'MoeenCode', 'TafsiliCode', 'Comment',
  'Bed', 'Bes', 'IsNote', 'Factor_Num', 'Remain', 'Tick', 'SanadComment',
  'ChkNum', 'IsRecPayChk', 'CostCenterCode',
]);

test('the real exported document is balanced and dated inside the open fiscal year', () => {
  const debit = REAL_EXPORT_ROWS.reduce((sum, row) => sum + row.Bed, 0);
  const credit = REAL_EXPORT_ROWS.reduce((sum, row) => sum + row.Bes, 0);
  assert.equal(debit, credit);
  // سال مالی باز نصب مشتری ۱۴۰۲ بود. خروجی گرفتن از سندهای ۱۴۰۵ با خطای
  // «Incorrect syntax near ')'» شکست خورد، یعنی ماژول تبادل هیچ سندی پیدا نکرد.
  for (const row of REAL_EXPORT_ROWS) assert.equal(row.SanadDate.slice(0, 4), '1402');
});

test('every line of one document carries the same number and date', () => {
  const numbers = new Set(REAL_EXPORT_ROWS.map((row) => row.Sanad_Num));
  const dates = new Set(REAL_EXPORT_ROWS.map((row) => row.SanadDate));
  assert.equal(numbers.size, 1, 'شمارهٔ سند روی هر ردیف تکرار می‌شود، سرصفحه ندارد');
  assert.equal(dates.size, 1, 'تاریخ هم روی هر ردیف تکرار می‌شود');
  // ID در فایل شمارهٔ ردیف است و از ۱ شروع می‌شود، نه شناسهٔ سراسری.
  assert.deepEqual(REAL_EXPORT_ROWS.map((row) => row.ID), [1, 2]);
});

test('the account is three separate numbers and tafsili is zero when unused', () => {
  const [cash, party] = REAL_EXPORT_ROWS;
  assert.equal(cash.TafsiliCode, 0, 'صندوق تفصیلی ندارد و صفر می‌گیرد، نه NULL');
  assert.equal(party.TafsiliCode, 1);
  assert.equal(parsianHCode({ kolCode: cash.KolCode, moeenCode: cash.MoeenCode, tafsiliCode: cash.TafsiliCode }), '0-1-10');
  assert.equal(parsianHCode({ kolCode: party.KolCode, moeenCode: party.MoeenCode, tafsiliCode: party.TafsiliCode }), '1-2-12');
});

test('a manual document leaves the invoice and cost centre columns empty', () => {
  for (const row of REAL_EXPORT_ROWS) {
    assert.equal(row.Factor_Num, null, 'سند دستی شمارهٔ فاکتور ندارد و NULL می‌ماند، نه صفر');
    assert.equal(row.CostCenterCode, null);
    assert.equal(row.Comment, '', 'شرح خالی رشتهٔ تهی است، نه NULL');
  }
});

test('the template can produce exactly the shape the transfer file carries', () => {
  const { headers, rows } = applyTransferTemplate({
    columns: [
      { field: 'lineNumber', header: 'ID' },
      { field: 'dateJalali', header: 'SanadDate' },
      { field: 'kolCode', header: 'KolCode' },
      { field: 'moeenCode', header: 'MoeenCode' },
      { field: 'tafsiliCode', header: 'TafsiliCode' },
      { field: 'lineDescription', header: 'Comment' },
      { field: 'debitToman', header: 'Bed' },
      { field: 'creditToman', header: 'Bes' },
    ],
    journalRows: [
      { entryId: 's4', kolCode: '10', moeenCode: '1', tafsiliCode: '', lineDescription: '', debit: 20000000, credit: 0 },
      { entryId: 's4', kolCode: '12', moeenCode: '2', tafsiliCode: '1', lineDescription: '', debit: 0, credit: 20000000 },
    ],
    persianDate: () => '1402/06/05',
  });
  assert.deepEqual(headers, ['ID', 'SanadDate', 'KolCode', 'MoeenCode', 'TafsiliCode', 'Comment', 'Bed', 'Bes']);
  assert.deepEqual(rows[0], [1, '1402/06/05', '10', '1', '', '', 20000000, 0]);
  assert.deepEqual(rows[1], [2, '1402/06/05', '12', '2', '1', '', 0, 20000000]);
  // مبلغ بدون تبدیل منتقل می‌شود، دقیقاً مثل خود فایل.
  assert.equal(rows[0][6], REAL_EXPORT_ROWS[0].Bed);
  assert.equal(rows[1][7], REAL_EXPORT_ROWS[1].Bes);
});

test('the seventeen transfer columns are the ones the schema already carries', () => {
  assert.equal(TRANSFER_COLUMNS.length, 17);
  for (const name of ['SanadDate', 'KolCode', 'MoeenCode', 'TafsiliCode', 'Bed', 'Bes']) {
    assert.ok(TRANSFER_COLUMNS.includes(name));
  }
});

// ---------------------------------------------------------------------------
// آنچه از اجرای واقعی «انتقال اسناد از فایل» روی همان فایل خروجی معلوم شد.
// فهرست «جستجوی اسناد حسابداری» بعد از دو بار ورود این را نشان داد:
//
//   سند ۴  1402/06/05  (تایپ دستی)  زمان ثبت: 1405/06/05 10:27:04 کاربر ارشد
//   سند ۵  1402/06/05  (وارد شده)   زمان ثبت: خالی
//   سند ۶  1402/06/05  (وارد شده)   زمان ثبت: خالی
//
// یعنی: شمارهٔ سند فایل دور ریخته می‌شود، تاریخ حفظ می‌شود، ورود دوباره سند
// تکراری می‌سازد، و سند وارد شده تاریخچهٔ ثبت ندارد.

const IMPORT_RESULT = Object.freeze([
  { sanad: 4, date: '1402/06/05', origin: 'typed', registeredBy: 'کاربر ارشد' },
  { sanad: 5, date: '1402/06/05', origin: 'imported', registeredBy: '' },
  { sanad: 6, date: '1402/06/05', origin: 'imported', registeredBy: '' },
]);

test('Parsian assigns its own document number and ignores the one in the file', () => {
  const imported = IMPORT_RESULT.filter((row) => row.origin === 'imported');
  // فایل شمارهٔ ۴ را حمل می‌کرد؛ پارسیان ۵ و ۶ ساخت.
  assert.deepEqual(imported.map((row) => row.sanad), [5, 6]);
  assert.ok(imported.every((row) => row.sanad !== REAL_EXPORT_ROWS[0].Sanad_Num));
});

test('the document date survives the import unchanged', () => {
  for (const row of IMPORT_RESULT) assert.equal(row.date, REAL_EXPORT_ROWS[0].SanadDate);
});

test('importing the same file twice silently duplicates the document', () => {
  const imported = IMPORT_RESULT.filter((row) => row.origin === 'imported');
  assert.equal(imported.length, 2, 'یک فایل، دو بار ورود، دو سند — بدون هیچ هشداری');
  // پس جلوگیری از ارسال دوباره کاملاً وظیفهٔ حساب‌یار است.
});

test('an imported document has no registration history, so it is recognisable', () => {
  const typed = IMPORT_RESULT.find((row) => row.origin === 'typed');
  const imported = IMPORT_RESULT.filter((row) => row.origin === 'imported');
  assert.ok(typed.registeredBy);
  assert.ok(imported.every((row) => !row.registeredBy));
});

test('the hesab-yar document number can ride along in a column of its own', () => {
  // چون Sanad_Num زنده نمی‌ماند، تنها راه ردیابی این است که شمارهٔ سند
  // حساب‌یار داخل شرح برود.
  const { headers, rows } = applyTransferTemplate({
    columns: [
      { field: 'documentNumber', header: 'شماره سند حساب‌یار' },
      { field: 'lineDescription', header: 'Comment' },
      { field: 'kolCode', header: 'KolCode' },
      { field: 'debitToman', header: 'Bed' },
      { field: 'creditToman', header: 'Bes' },
    ],
    journalRows: [
      { entryId: 'e1', documentNumber: 117, fiscalYear: '1402', kolCode: '10', lineDescription: 'حساب‌یار ۱۱۷', debit: 20000000, credit: 0 },
      { entryId: 'e1', documentNumber: 117, fiscalYear: '1402', kolCode: '12', lineDescription: 'حساب‌یار ۱۱۷', debit: 0, credit: 20000000 },
    ],
  });
  assert.equal(headers[0], 'شماره سند حساب‌یار');
  assert.deepEqual(rows.map((row) => row[0]), [117, 117]);
});

test('a journal row without a document number leaves the column empty, not zero', () => {
  const { rows } = applyTransferTemplate({
    columns: [
      { field: 'documentNumber', header: 'سند' },
      { field: 'fiscalYear', header: 'سال مالی' },
      { field: 'kolCode', header: 'KolCode' },
      { field: 'debitToman', header: 'Bed' },
      { field: 'creditToman', header: 'Bes' },
    ],
    journalRows: [{ entryId: 'e1', kolCode: '10', debit: 1, credit: 0 }],
  });
  assert.deepEqual(rows[0].slice(0, 2), ['', ''], 'صفر جعلی یعنی سند شمارهٔ صفر');
});
