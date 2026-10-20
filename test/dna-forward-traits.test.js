import assert from 'node:assert/strict';
import test from 'node:test';
import { financialDna } from '../server/financialDna.js';
import { persianToISO } from '../shared/persianDate.js';

const TZ = 'Asia/Tehran';
const at = (year, month, day) => persianToISO(year, month, day, TZ);
const trait = (dna, id) => dna.traits.find((item) => item.id === id) || null;

/** ثبت‌های یک ماه: چند ردیف در روزهای مختلف تا کفایت داده برقرار شود. */
function monthRows(year, month, { income = 0, expense = 0, category = 'اجاره', days = [2, 8, 14, 20, 26] } = {}) {
  const rows = [];
  for (const day of days) {
    if (income) rows.push({ amount: Math.round(income / days.length), type: 'income', category: 'فروش', source: 'voice', occurredAt: at(year, month, day), createdAt: at(year, month, day) });
    if (expense) rows.push({ amount: Math.round(expense / days.length), type: 'expense', category, source: 'text', occurredAt: at(year, month, day), createdAt: at(year, month, day) });
  }
  return rows;
}

// ماه جاری همیشه ناقص است؛ اگر در روند بیاید، هر پرونده‌ای «رو به کاهش» دیده
// می‌شود و حسابدار بر پایهٔ یک گزارش جعلی زنگ می‌زند.
test('ماه جاریِ ناتمام روند را رو به کاهش نشان نمی‌دهد', () => {
  const now = new Date(at(1405, 6, 10));
  const rows = [
    ...monthRows(1405, 3, { income: 100_000_000, expense: 40_000_000 }),
    ...monthRows(1405, 4, { income: 100_000_000, expense: 40_000_000 }),
    ...monthRows(1405, 5, { income: 100_000_000, expense: 40_000_000 }),
    // ماه جاری تازه شروع شده و فقط یک ثبت کوچک دارد.
    { amount: 2_000_000, type: 'income', category: 'فروش', source: 'voice', occurredAt: at(1405, 6, 3), createdAt: at(1405, 6, 3) },
  ];
  const dna = financialDna(rows, { timeZone: TZ, now });
  assert.equal(trait(dna, 'trend').value, 'ثابت');
});

test('رشد واقعی درآمد با شاهد عددی گزارش می‌شود', () => {
  const now = new Date(at(1405, 6, 10));
  const rows = [
    ...monthRows(1405, 2, { income: 50_000_000 }),
    ...monthRows(1405, 3, { income: 50_000_000 }),
    ...monthRows(1405, 4, { income: 150_000_000 }),
    ...monthRows(1405, 5, { income: 150_000_000 }),
  ];
  const found = trait(financialDna(rows, { timeZone: TZ, now }), 'trend');
  assert.equal(found.value, 'رو به رشد');
  assert.equal(found.evidence.changePercent, 200);
  assert.match(found.detail, /۲۰۰|200/);
});

test('نوسان کم روند شمرده نمی‌شود', () => {
  const now = new Date(at(1405, 6, 10));
  const rows = [
    ...monthRows(1405, 3, { income: 100_000_000, expense: 20_000_000 }),
    ...monthRows(1405, 4, { income: 105_000_000, expense: 20_000_000 }),
    ...monthRows(1405, 5, { income: 95_000_000, expense: 20_000_000 }),
  ];
  assert.equal(trait(financialDna(rows, { timeZone: TZ, now }), 'trend').value, 'ثابت');
});

test('یک ماه کامل روند نمی‌سازد', () => {
  const now = new Date(at(1405, 6, 10));
  const rows = [...monthRows(1405, 5, { income: 100_000_000, expense: 30_000_000 }), ...monthRows(1405, 5, { income: 0, expense: 30_000_000, days: [3, 9, 15, 21, 27] })];
  assert.equal(trait(financialDna(rows, { timeZone: TZ, now }), 'trend'), null);
});

// ---------------------------------------------------------------- فشار پرداخت

const busyRows = (now) => [
  ...monthRows(1405, 3, { income: 100_000_000, expense: 20_000_000 }),
  ...monthRows(1405, 4, { income: 100_000_000, expense: 20_000_000 }),
  ...monthRows(1405, 5, { income: 100_000_000, expense: 20_000_000 }),
];

test('تعهد پرداختنی پیش رو در برابر درآمد معمول سنجیده می‌شود', () => {
  const now = new Date(at(1405, 6, 10));
  const obligations = [
    { amount: 120_000_000, direction: 'payable', dueAt: at(1405, 6, 20), title: 'چک پارس' },
  ];
  const found = trait(financialDna(busyRows(now), { timeZone: TZ, now, obligations }), 'cash-pressure');
  assert.equal(found.value, 'بالا');
  assert.equal(found.evidence.payable, 120_000_000);
  assert.ok(found.evidence.ratio >= 1);
});

test('تعهد کوچک فشار بالا اعلام نمی‌شود', () => {
  const now = new Date(at(1405, 6, 10));
  const obligations = [{ amount: 5_000_000, direction: 'payable', dueAt: at(1405, 6, 20), title: 'قبض' }];
  assert.equal(trait(financialDna(busyRows(now), { timeZone: TZ, now, obligations }), 'cash-pressure').value, 'پایین');
});

// طلب ما پول خارج نمی‌کند؛ آوردنش در فشار پرداخت، گزارش را وارونه می‌کند.
test('طلب ما فشار پرداخت نمی‌سازد', () => {
  const now = new Date(at(1405, 6, 10));
  const obligations = [{ amount: 500_000_000, direction: 'receivable', dueAt: at(1405, 6, 20), title: 'طلب' }];
  assert.equal(trait(financialDna(busyRows(now), { timeZone: TZ, now, obligations }), 'cash-pressure'), null);
});

test('تعهد دورتر از سی روز در فشار این ماه نمی‌آید', () => {
  const now = new Date(at(1405, 6, 10));
  const obligations = [{ amount: 200_000_000, direction: 'payable', dueAt: at(1405, 9, 1), title: 'چک دور' }];
  assert.equal(trait(financialDna(busyRows(now), { timeZone: TZ, now, obligations }), 'cash-pressure'), null);
});

// نبودِ داده یعنی سکوت، نه «مشکلی نیست».
test('بدون تعهد سررسیددار هیچ ادعایی نمی‌شود', () => {
  const now = new Date(at(1405, 6, 10));
  assert.equal(trait(financialDna(busyRows(now), { timeZone: TZ, now, obligations: [] }), 'cash-pressure'), null);
});

test('سررسید گذشته جدا شمرده و در شاهد گفته می‌شود', () => {
  const now = new Date(at(1405, 6, 10));
  const obligations = [
    { amount: 60_000_000, direction: 'payable', dueAt: at(1405, 6, 2), title: 'چک عقب‌افتاده' },
    { amount: 60_000_000, direction: 'payable', dueAt: at(1405, 6, 25), title: 'چک پیش رو' },
  ];
  const found = trait(financialDna(busyRows(now), { timeZone: TZ, now, obligations }), 'cash-pressure');
  assert.equal(found.evidence.overdueCount, 1);
  assert.match(found.detail, /سررسید گذشته/);
});

// ------------------------------------------------------- دستهٔ خارج از عادت

test('دسته‌ای که این ماه چند برابر عادت خودش شده پیدا می‌شود', () => {
  const now = new Date(at(1405, 6, 20));
  const rows = [
    ...monthRows(1405, 2, { income: 80_000_000, expense: 10_000_000, category: 'اجاره' }),
    ...monthRows(1405, 3, { income: 80_000_000, expense: 10_000_000, category: 'اجاره' }),
    ...monthRows(1405, 4, { income: 80_000_000, expense: 10_000_000, category: 'اجاره' }),
    ...monthRows(1405, 5, { income: 80_000_000, expense: 10_000_000, category: 'اجاره' }),
    ...monthRows(1405, 6, { income: 80_000_000, expense: 50_000_000, category: 'اجاره', days: [2, 8, 14] }),
  ];
  const found = trait(financialDna(rows, { timeZone: TZ, now }), 'month-outlier');
  assert.equal(found.value, 'اجاره');
  assert.ok(found.evidence.findings[0].ratio >= 1.6);
});

// روز سوم ماه همیشه کمتر از میانه است؛ گزارش «افت شدید» آنجا بی‌معناست.
test('اوایل ماه هیچ ناهنجاری ماهانه‌ای اعلام نمی‌شود', () => {
  const now = new Date(at(1405, 6, 3));
  const rows = [
    ...monthRows(1405, 2, { income: 80_000_000, expense: 10_000_000 }),
    ...monthRows(1405, 3, { income: 80_000_000, expense: 10_000_000 }),
    ...monthRows(1405, 4, { income: 80_000_000, expense: 10_000_000 }),
    ...monthRows(1405, 5, { income: 80_000_000, expense: 10_000_000 }),
    { amount: 500_000, type: 'expense', category: 'اجاره', source: 'text', occurredAt: at(1405, 6, 2), createdAt: at(1405, 6, 2) },
  ];
  assert.equal(trait(financialDna(rows, { timeZone: TZ, now }), 'month-outlier'), null);
});

test('کمتر از سه ماه سابقه، «معمول» نمی‌سازد', () => {
  const now = new Date(at(1405, 6, 20));
  const rows = [
    ...monthRows(1405, 4, { income: 80_000_000, expense: 10_000_000 }),
    ...monthRows(1405, 5, { income: 80_000_000, expense: 10_000_000 }),
    ...monthRows(1405, 6, { income: 80_000_000, expense: 90_000_000, days: [2, 8, 14] }),
  ];
  assert.equal(trait(financialDna(rows, { timeZone: TZ, now }), 'month-outlier'), null);
});

// قاعدهٔ سخت DNA روی صفت‌های تازه هم برقرار است.
test('بدون دادهٔ کافی هیچ‌کدام از صفت‌های تازه ساخته نمی‌شوند', () => {
  const now = new Date(at(1405, 6, 20));
  const dna = financialDna([
    { amount: 1_000_000, type: 'income', category: 'فروش', source: 'voice', occurredAt: at(1405, 6, 2), createdAt: at(1405, 6, 2) },
  ], { timeZone: TZ, now, obligations: [{ amount: 999_000_000, direction: 'payable', dueAt: at(1405, 6, 20) }] });
  assert.equal(dna.sufficiency.level, 'thin');
  assert.deepEqual(dna.traits, []);
});

// صفحهٔ DNA هر صفت را با یک قالب نشان می‌دهد: عنوان، مقدار و جملهٔ توضیح متن‌اند
// و شاهد عددی شیء. سه صفت رو به جلو شاهدشان را در `detail` می‌گذاشتند و صفحه با
// «Minified React error #31 … {payable, typicalIncome, ratio, overdueCount}» می‌شکست.
test('همهٔ صفت‌ها، از جمله سه صفت رو به جلو، قالب صفحهٔ DNA را دارند', () => {
  const now = new Date(at(1405, 6, 20));
  const rows = [
    ...monthRows(1405, 2, { income: 50_000_000, expense: 10_000_000, category: 'اجاره' }),
    ...monthRows(1405, 3, { income: 50_000_000, expense: 10_000_000, category: 'اجاره' }),
    ...monthRows(1405, 4, { income: 150_000_000, expense: 10_000_000, category: 'اجاره' }),
    ...monthRows(1405, 5, { income: 150_000_000, expense: 10_000_000, category: 'اجاره' }),
    ...monthRows(1405, 6, { income: 80_000_000, expense: 50_000_000, category: 'اجاره', days: [2, 8, 14] }),
  ];
  const obligations = [{ amount: 300_000_000, direction: 'payable', dueAt: at(1405, 6, 15), title: 'چک عقب‌افتاده' }];
  const dna = financialDna(rows, { timeZone: TZ, now, obligations });
  for (const id of ['trend', 'cash-pressure', 'month-outlier']) assert.ok(trait(dna, id), `صفت ${id} در این داده ساخته می‌شود`);
  for (const item of dna.traits) {
    for (const field of ['label', 'value', 'detail']) {
      assert.equal(typeof item[field], 'string', `${item.id}.${field} متن است`);
      assert.ok(item[field].length > 0, `${item.id}.${field} خالی نیست`);
    }
    assert.equal(typeof item.evidence, 'object', `${item.id}.evidence شیء است`);
    assert.equal(typeof (item.evidence.sample ?? item.evidence.total), 'number', `${item.id}: «بر پایهٔ چند ثبت» عدد دارد`);
  }
});
