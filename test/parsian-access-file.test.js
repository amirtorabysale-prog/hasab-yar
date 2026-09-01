import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  encodeRow, validateDocuments, documentRows, isAccessDatabase,
  buildParsianTransfer, readParsianDocuments, readParsianTemplate,
  PARSIAN_TRANSFER_LIMITS,
} from '../server/parsianAccessFile.js';

// چیدمان ستون‌های tbl_Document از یک قالب تولیدشده توسط خود پارسیان استخراج
// شده است. fixtureهای این فایل عمداً ساختگی‌اند و هیچ نام یا مبلغ مشتری را
// نگه نمی‌دارند؛ فقط قرارداد بایتی قالب را قفل می‌کنند.
const COLUMNS = [
  { name: 'ID', type: 0x04, varIndex: 0, colId: 1, fixedOffset: 0, length: 4 },
  { name: 'Sanad_Num', type: 0x04, varIndex: 0, colId: 2, fixedOffset: 4, length: 4 },
  { name: 'SanadDate', type: 0x0a, varIndex: 0, colId: 3, fixedOffset: 0, length: 30 },
  { name: 'KolCode', type: 0x03, varIndex: 1, colId: 4, fixedOffset: 8, length: 2 },
  { name: 'MoeenCode', type: 0x03, varIndex: 1, colId: 5, fixedOffset: 10, length: 2 },
  { name: 'TafsiliCode', type: 0x04, varIndex: 1, colId: 6, fixedOffset: 12, length: 4 },
  { name: 'Comment', type: 0x0a, varIndex: 1, colId: 7, fixedOffset: 0, length: 200 },
  { name: 'Bed', type: 0x07, varIndex: 2, colId: 8, fixedOffset: 16, length: 8 },
  { name: 'Bes', type: 0x07, varIndex: 2, colId: 9, fixedOffset: 24, length: 8 },
  { name: 'IsNote', type: 0x01, varIndex: 2, colId: 10, fixedOffset: 0, length: 1 },
  { name: 'Factor_Num', type: 0x04, varIndex: 2, colId: 11, fixedOffset: 32, length: 4 },
  { name: 'Remain', type: 0x07, varIndex: 2, colId: 12, fixedOffset: 36, length: 8 },
  { name: 'Tick', type: 0x01, varIndex: 2, colId: 13, fixedOffset: 0, length: 1 },
  { name: 'SanadComment', type: 0x0a, varIndex: 2, colId: 14, fixedOffset: 0, length: 510 },
  { name: 'ChkNum', type: 0x04, varIndex: 3, colId: 15, fixedOffset: 44, length: 4 },
  { name: 'IsRecPayChk', type: 0x01, varIndex: 3, colId: 16, fixedOffset: 0, length: 1 },
  { name: 'CostCenterCode', type: 0x04, varIndex: 3, colId: 17, fixedOffset: 48, length: 4 },
];
const TEMPLATE = { columns: COLUMNS, numCols: 17, numVarCols: 3 };

function thrown(run) {
  try { run(); } catch (error) { return error; }
  throw new assert.AssertionError({ message: 'انتظار خطا بود ولی خطایی رخ نداد' });
}

// یک ردیف ساختگی سازگار با فایل انتقال پارسیان.
// بایت‌های ستون‌های NULL — یعنی ۳۴ تا ۵۳ — در بعضی فایل‌های Jet آشغال کهنه دارند
// (رشتهٔ «PrimaryKey» از یک رکورد قبلی) چون Jet فضای آزاد را صفر نمی‌کند.
// اینجا صفر شده‌اند، دقیقاً همان چیزی که ما می‌نویسیم.
const REAL_ROW_HEX = [
  '1100',                       // تعداد ستون = ۱۷
  '01000000',                   // ID = 1
  '04000000',                   // Sanad_Num = 4 (شمارهٔ محلی fixture)
  '0a00',                       // KolCode = 10
  '0100',                       // MoeenCode = 1
  '00000000',                   // TafsiliCode = 0
  '000000000024fe40',           // Bed = 123456
  '0000000000000000',           // Bes = 0
  '0000000000000000000000000000000000000000', // Factor_Num/Remain/ChkNum/CostCenterCode = NULL
  '31003400300032002f00300036002f0030003500', // SanadDate = "1402/06/05"
  '4a004a004a003600',           // آفست‌های ستون متغیر: 74,74,74,54
  '0300',                       // تعداد ستون متغیر = ۳
  'ff2100',                     // ماسک null
].join('');

test('the encoder reproduces a sanitized Parsian-compatible row byte for byte', () => {
  const encoded = encodeRow(TEMPLATE, {
    ID: 1, Sanad_Num: 4, SanadDate: '1402/06/05',
    KolCode: 10, MoeenCode: 1, TafsiliCode: 0,
    Comment: '', Bed: 123456, Bes: 0,
    IsNote: false, Tick: false, SanadComment: '',
  });
  assert.equal(encoded.length, 87, 'ردیف سازگار با قالب پارسیان ۸۷ بایت است');
  assert.equal(encoded.toString('hex'), REAL_ROW_HEX);
});

test('a null fixed column stays null and an empty text column stays an empty string', () => {
  const encoded = encodeRow(TEMPLATE, {
    ID: 1, Sanad_Num: 1, SanadDate: '1402/01/01',
    KolCode: 10, MoeenCode: 1, TafsiliCode: 0,
    Comment: '', Bed: 1, Bes: 0, IsNote: false, Tick: false, SanadComment: '',
  });
  const nullMask = encoded.subarray(encoded.length - 3);
  const bit = (colId) => (nullMask[(colId - 1) >> 3] >> ((colId - 1) & 7)) & 1;
  assert.equal(bit(7), 1, 'شرح خالی رشتهٔ تهی است، نه NULL — همان کاری که پارسیان می‌کند');
  assert.equal(bit(11), 0, 'شمارهٔ فاکتور در سند دستی NULL می‌ماند، نه صفر');
  assert.equal(bit(17), 0, 'مرکز هزینه هم NULL');
  assert.equal(bit(10), 0, 'بولی خاموش یعنی false، نه NULL');
});

test('a balanced document with the right shape passes', () => {
  assert.doesNotThrow(() => validateDocuments([{
    date: '1402/06/05',
    lines: [
      { kolCode: 10, moeenCode: 1, debit: 500, credit: 0 },
      { kolCode: 12, moeenCode: 2, tafsiliCode: 1, debit: 0, credit: 500 },
    ],
  }]));
});

test('an unbalanced document is refused, because Parsian would accept it', () => {
  const error = thrown(() => validateDocuments([{
    date: '1402/06/05',
    lines: [
      { kolCode: 10, moeenCode: 1, debit: 500, credit: 0 },
      { kolCode: 12, moeenCode: 2, debit: 0, credit: 400 },
    ],
  }]));
  assert.equal(error.code, 'PARSIAN_TRANSFER_ROWS_INVALID');
  assert.match(error.details.errors[0], /برابر نیست/);
});

test('a date without a leading zero is refused', () => {
  for (const date of ['1402/6/5', '1402-06-05', '۱۴۰۲/۰۶/۰۵', '']) {
    const error = thrown(() => validateDocuments([{
      date,
      lines: [
        { kolCode: 10, moeenCode: 1, debit: 1, credit: 0 },
        { kolCode: 12, moeenCode: 2, debit: 0, credit: 1 },
      ],
    }]));
    assert.match(error.details.errors[0], /تاریخ/);
  }
});

test('a line without a kol or moeen code is refused', () => {
  const error = thrown(() => validateDocuments([{
    date: '1402/06/05',
    lines: [
      { moeenCode: 1, debit: 1, credit: 0 },
      { kolCode: 12, debit: 0, credit: 1 },
    ],
  }]));
  assert.match(error.details.errors.join(' '), /کد کل ندارد/);
  assert.match(error.details.errors.join(' '), /کد معین ندارد/);
});

test('a line cannot be both debit and credit, and cannot be negative', () => {
  const both = thrown(() => validateDocuments([{
    date: '1402/06/05',
    lines: [
      { kolCode: 10, moeenCode: 1, debit: 5, credit: 5 },
      { kolCode: 12, moeenCode: 2, debit: 0, credit: 0 },
    ],
  }]));
  assert.match(both.details.errors.join(' '), /هم بدهکار باشد هم بستانکار/);
  const negative = thrown(() => validateDocuments([{
    date: '1402/06/05',
    lines: [
      { kolCode: 10, moeenCode: 1, debit: -5, credit: 0 },
      { kolCode: 12, moeenCode: 2, debit: 0, credit: -5 },
    ],
  }]));
  assert.match(negative.details.errors.join(' '), /منفی/);
});

test('rows are numbered from one and grouped by a file-local document number', () => {
  const rows = documentRows([
    { date: '1402/06/05', comment: 'الف', lines: [
      { kolCode: 10, moeenCode: 1, debit: 1, credit: 0 },
      { kolCode: 12, moeenCode: 2, debit: 0, credit: 1 },
    ] },
    { date: '1402/06/12', comment: 'ب', lines: [
      { kolCode: 62, moeenCode: 1, debit: 2, credit: 0 },
      { kolCode: 10, moeenCode: 1, debit: 0, credit: 2 },
    ] },
  ]);
  assert.deepEqual(rows.map((row) => row.ID), [1, 2, 3, 4]);
  // شمارهٔ سند فایل فقط کلید گروه‌بندی است؛ پارسیان موقع ورود دورش می‌ریزد.
  assert.deepEqual(rows.map((row) => row.Sanad_Num), [1, 1, 2, 2]);
  assert.deepEqual(rows.map((row) => row.SanadDate), ['1402/06/05', '1402/06/05', '1402/06/12', '1402/06/12']);
  assert.equal(rows[0].TafsiliCode, 0, 'نبودِ تفصیلی صفر می‌شود، نه NULL');
  assert.equal(rows[0].SanadComment, 'الف');
});

test('anything that is not a Jet database is refused before a single byte is written', () => {
  assert.equal(isAccessDatabase(Buffer.from('code,name,debit,credit')), false);
  const error = thrown(() => readParsianTemplate(Buffer.alloc(8192)));
  assert.equal(error.code, 'PARSIAN_TEMPLATE_NOT_ACCESS');
});

test('an empty document list is refused', () => {
  assert.equal(thrown(() => validateDocuments([])).code, 'PARSIAN_TRANSFER_EMPTY');
});

// ---------------------------------------------------------------------------
// رفت‌وبرگشت کامل روی الگوی محلی پارسیان. الگو ممکن است اطلاعات نصب را حمل کند
// و در مخزن نیست؛ این تست فقط وقتی اجرا می‌شود که فایل کنار دست باشد.

const TEMPLATE_PATH = 'parsian/parsian-document-export.mdb';
const hasTemplate = fs.existsSync(TEMPLATE_PATH);

test('a built file round-trips through an independent reader', { skip: hasTemplate ? false : 'الگوی واقعی پارسیان در دسترس نیست' }, () => {
  const template = fs.readFileSync(TEMPLATE_PATH);
  const documents = [
    { date: '1402/06/05', comment: 'حساب‌یار ۱۱۷', lines: [
      { kolCode: 10, moeenCode: 1, tafsiliCode: 0, debit: 123000, credit: 0, comment: 'دریافت نمونه' },
      { kolCode: 12, moeenCode: 2, tafsiliCode: 1, debit: 0, credit: 123000, comment: 'طرف حساب نمونه' },
    ] },
    { date: '1402/06/20', comment: 'حساب‌یار ۱۱۸', lines: [
      { kolCode: 50, moeenCode: 9, tafsiliCode: 0, debit: 45000, credit: 0, comment: 'هزینه حمل نمونه' },
      { kolCode: 50, moeenCode: 5, tafsiliCode: 0, debit: 7000, credit: 0, comment: 'هزینه ارتباطات نمونه' },
      { kolCode: 10, moeenCode: 1, tafsiliCode: 0, debit: 0, credit: 52000, comment: 'پرداخت نمونه' },
    ] },
  ];

  const built = buildParsianTransfer({ template, documents });
  assert.ok(isAccessDatabase(built));

  const back = readParsianDocuments(built);
  assert.equal(back.rows.length, 5);
  assert.equal(back.documents.length, 2);
  assert.deepEqual(back.documents.map((item) => item.date), ['1402/06/05', '1402/06/20']);
  assert.deepEqual(back.documents.map((item) => item.lines.length), [2, 3]);
  // فارسی سالم برمی‌گردد و مبلغ هیچ تبدیلی نمی‌خورد.
  assert.equal(back.rows[1].Comment, 'طرف حساب نمونه');
  assert.equal(back.rows[0].Bed, 123000);
  for (const document of back.documents) {
    const debit = document.lines.reduce((sum, line) => sum + line.debit, 0);
    const credit = document.lines.reduce((sum, line) => sum + line.credit, 0);
    assert.equal(debit, credit);
  }
});

test('the old rows of the template do not survive into the built file', { skip: hasTemplate ? false : 'الگوی واقعی پارسیان در دسترس نیست' }, () => {
  const template = fs.readFileSync(TEMPLATE_PATH);
  const before = readParsianDocuments(template);
  assert.ok(before.rows.length > 0, 'الگوی این آزمایش خودش سند دارد');
  const built = buildParsianTransfer({
    template,
    documents: [{ date: '1403/01/01', lines: [
      { kolCode: 10, moeenCode: 1, debit: 7, credit: 0 },
      { kolCode: 12, moeenCode: 2, debit: 0, credit: 7 },
    ] }],
  });
  const after = readParsianDocuments(built);
  assert.equal(after.rows.length, 2, 'سندهای قبلی الگو پاک می‌شوند، وگرنه سند غریبه وارد دفتر مشتری می‌شود');
  assert.equal(after.rows[0].SanadDate, '1403/01/01');
});

test('too many rows is refused with a clear limit instead of a corrupt file', { skip: hasTemplate ? false : 'الگوی واقعی پارسیان در دسترس نیست' }, () => {
  const template = fs.readFileSync(TEMPLATE_PATH);
  const lines = [];
  for (let i = 0; i < PARSIAN_TRANSFER_LIMITS.maxRows; i++) {
    lines.push({ kolCode: 10, moeenCode: 1, debit: 1, credit: 0 });
    lines.push({ kolCode: 12, moeenCode: 2, debit: 0, credit: 1 });
  }
  const error = thrown(() => buildParsianTransfer({
    template, documents: [{ date: '1402/06/05', lines }],
  }));
  assert.equal(error.code, 'PARSIAN_TRANSFER_TOO_MANY_ROWS');
});

// ---------------------------------------------------------------------------
// fixture ساختگیِ معیار پذیرش آزمون میدانی. مدرک واقعی خارج از Git نگه‌داری
// می‌شود؛ اینجا فقط منطق «تعداد ردیف برابر و جابه‌جایی دقیق دو جمع» آزموده می‌شود.

const TRIAL_IMPORT = Object.freeze({
  before: { debit: 100000000, credit: 90000000 },
  after: { debit: 101111000, credit: 91111000 },
  documents: [
    { sanad: 1, date: '1402/06/05', lines: [
      { kol: 10, moeen: 1, tafsili: 0, name: 'صندوق نمونه', debit: 700000, credit: 0 },
      { kol: 12, moeen: 2, tafsili: 1, name: 'طرف حساب نمونه', debit: 0, credit: 700000 },
    ] },
    { sanad: 2, date: '1402/06/12', lines: [
      { kol: 62, moeen: 1, tafsili: 0, name: 'خرید نمونه', debit: 300000, credit: 0 },
      { kol: 10, moeen: 1, tafsili: 0, name: 'صندوق نمونه', debit: 0, credit: 300000 },
    ] },
    { sanad: 3, date: '1402/06/20', lines: [
      { kol: 50, moeen: 9, tafsili: 0, name: 'هزینه حمل نمونه', debit: 80000, credit: 0 },
      { kol: 50, moeen: 5, tafsili: 0, name: 'هزینه ارتباطات نمونه', debit: 31000, credit: 0 },
      { kol: 10, moeen: 1, tafsili: 0, name: 'صندوق نمونه', debit: 0, credit: 111000 },
    ] },
  ],
});

// بستهٔ ساختگی متناظر با fixture مقصد.
const SENT_DOCUMENTS = [
  { date: '1402/06/05', comment: 'حساب‌یار ۱۱۷', lines: [
    { kolCode: 10, moeenCode: 1, tafsiliCode: 0, debit: 700000, credit: 0 },
    { kolCode: 12, moeenCode: 2, tafsiliCode: 1, debit: 0, credit: 700000 },
  ] },
  { date: '1402/06/12', comment: 'حساب‌یار ۱۱۸', lines: [
    { kolCode: 62, moeenCode: 1, tafsiliCode: 0, debit: 300000, credit: 0 },
    { kolCode: 10, moeenCode: 1, tafsiliCode: 0, debit: 0, credit: 300000 },
  ] },
  { date: '1402/06/20', comment: 'حساب‌یار ۱۱۹', lines: [
    { kolCode: 50, moeenCode: 9, tafsiliCode: 0, debit: 80000, credit: 0 },
    { kolCode: 50, moeenCode: 5, tafsiliCode: 0, debit: 31000, credit: 0 },
    { kolCode: 10, moeenCode: 1, tafsiliCode: 0, debit: 0, credit: 111000 },
  ] },
];

test('every row of the package arrived and none was rejected', () => {
  const sentRows = documentRows(SENT_DOCUMENTS);
  const landedRows = TRIAL_IMPORT.documents.flatMap((item) => item.lines);
  assert.equal(landedRows.length, sentRows.length, 'معیار فاز ۸: تعداد ردیف باید با بسته برابر باشد');
  assert.equal(sentRows.length, 7);
});

test('both destination totals moved by exactly the package total', () => {
  const sent = documentRows(SENT_DOCUMENTS);
  const packageDebit = sent.reduce((sum, row) => sum + row.Bed, 0);
  const packageCredit = sent.reduce((sum, row) => sum + row.Bes, 0);
  assert.equal(packageDebit, packageCredit, 'بسته خودش متوازن است');
  assert.equal(TRIAL_IMPORT.after.debit - TRIAL_IMPORT.before.debit, packageDebit);
  assert.equal(TRIAL_IMPORT.after.credit - TRIAL_IMPORT.before.credit, packageCredit);
  assert.equal(packageDebit, 1111000);
});

test('each account code resolved to the right account in the destination', () => {
  // پارسیان نام حساب را از کدینگ خودش می‌آورد، پس نام درست یعنی کد درست نشسته.
  const expected = [
    [10, 1, 'صندوق نمونه'], [12, 2, 'طرف حساب نمونه'], [62, 1, 'خرید نمونه'],
    [50, 9, 'هزینه حمل نمونه'], [50, 5, 'هزینه ارتباطات نمونه'],
  ];
  const landed = TRIAL_IMPORT.documents.flatMap((item) => item.lines);
  for (const [kol, moeen, name] of expected) {
    assert.ok(
      landed.some((line) => line.kol === kol && line.moeen === moeen && line.name === name),
      `کد ${kol}/${moeen} باید «${name}» شود`,
    );
  }
});

test('the dates and the tafsili code survived into the destination', () => {
  assert.deepEqual(
    TRIAL_IMPORT.documents.map((item) => item.date),
    SENT_DOCUMENTS.map((item) => item.date),
  );
  const withTafsili = TRIAL_IMPORT.documents[0].lines[1];
  assert.equal(withTafsili.tafsili, 1);
  const withoutTafsili = TRIAL_IMPORT.documents[0].lines[0];
  assert.equal(withoutTafsili.tafsili, 0, 'نبودِ تفصیلی صفر می‌ماند');
});

test('the pre-existing imbalance of the destination was not touched', () => {
  // fixture مقصد از قبل یک اختلاف ساختگی دارد؛ بستهٔ متوازن نباید آن را تغییر دهد.
  const before = TRIAL_IMPORT.before.debit - TRIAL_IMPORT.before.credit;
  const after = TRIAL_IMPORT.after.debit - TRIAL_IMPORT.after.credit;
  assert.equal(before, 10000000);
  assert.equal(after, before);
});
