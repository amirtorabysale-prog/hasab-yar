import test from 'node:test';
import assert from 'node:assert/strict';
import { DNA_MINIMUMS, financialDna, normalizeDnaRows } from '../server/financialDna.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-05T09:00:00.000Z');

function row(daysAgo, amount, type, category, extra = {}) {
  const occurredAt = new Date(NOW.getTime() - daysAgo * DAY).toISOString();
  return { amount, type, category, source: 'voice', occurredAt, createdAt: occurredAt, ...extra };
}

// یک پروندهٔ خرده‌فروشی ساختگی: فروش خرد روزانه، اجاره و حقوق ماهانه.
function retailRows({ days = 120 } = {}) {
  const rows = [];
  for (let day = 0; day < days; day += 1) {
    rows.push(row(day, 900_000 + (day % 5) * 50_000, 'income', 'فروش'));
    rows.push(row(day, 950_000 + (day % 3) * 40_000, 'income', 'فروش'));
    if (day % 30 === 0) {
      rows.push(row(day, 25_000_000, 'expense', 'اجاره'));
      rows.push(row(day, 40_000_000, 'expense', 'حقوق و دستمزد'));
    }
    if (day % 4 === 0) rows.push(row(day, 3_000_000, 'expense', 'مواد و کالا'));
  }
  return rows;
}

test('ردیف بی‌تاریخ یا با مبلغ نامعتبر کنار گذاشته می‌شود', () => {
  const normalized = normalizeDnaRows([
    row(1, 500_000, 'income', 'فروش'),
    { amount: 100, type: 'income', category: 'فروش', occurredAt: 'تاریخ نیست' },
    { amount: 0, type: 'income', category: 'فروش', occurredAt: NOW.toISOString() },
    { amount: -5, type: 'expense', category: 'اجاره', occurredAt: NOW.toISOString() },
  ]);
  assert.equal(normalized.length, 1);
});

// مهم‌ترین قاعده: پروفایل غلط برای دفتر بدتر از نبودِ پروفایل است.
test('با دادهٔ کم هیچ صفتی ادعا نمی‌شود', () => {
  const dna = financialDna([row(1, 500_000, 'income', 'فروش'), row(2, 300_000, 'expense', 'اجاره')], { now: NOW });
  assert.equal(dna.sufficiency.level, 'thin');
  assert.deepEqual(dna.traits, []);
  assert.equal(dna.brief, null);
  assert.ok(dna.message.includes(String(DNA_MINIMUMS.transactions)));
});

test('ثبت زیاد در روزهای کم هم کافی نیست', () => {
  // ۳۰ ثبت ولی همه در سه روز؛ الگوی رفتاری از این در نمی‌آید.
  const rows = Array.from({ length: 30 }, (_, index) => row(index % 3, 500_000, 'income', 'فروش'));
  const dna = financialDna(rows, { now: NOW });
  assert.equal(dna.sufficiency.level, 'thin');
});

test('پروندهٔ خرده‌فروشی ریتم روزانه تشخیص داده می‌شود', () => {
  const dna = financialDna(retailRows(), { now: NOW, months: 4 });
  assert.equal(dna.sufficiency.level, 'ok');
  const rhythm = dna.traits.find((item) => item.id === 'income-rhythm');
  assert.equal(rhythm.value, 'روزانه و پرتعداد');
  assert.ok(rhythm.evidence.sample > 100);
});

test('پروندهٔ پروژه‌ای از خرده‌فروشی جدا می‌شود', () => {
  const rows = [];
  for (let month = 0; month < 4; month += 1) {
    rows.push(row(month * 30, 400_000_000, 'income', 'پروژه و دستمزد'));
    for (let item = 0; item < 6; item += 1) rows.push(row(month * 30 + item * 3, 8_000_000, 'expense', 'حقوق و دستمزد'));
  }
  const dna = financialDna(rows, { now: NOW, months: 4 });
  const rhythm = dna.traits.find((item) => item.id === 'income-rhythm');
  assert.equal(rhythm.value, 'پروژه‌ای و کم‌تعداد');
});

test('ستون فقرات هزینه، دستهٔ تکرارشونده را از متغیر جدا می‌کند', () => {
  const dna = financialDna(retailRows(), { now: NOW, months: 4 });
  const backbone = dna.traits.find((item) => item.id === 'expense-backbone');
  const fixedCategories = backbone.evidence.fixed.map((item) => item.category);
  assert.ok(fixedCategories.includes('اجاره'));
  assert.ok(fixedCategories.includes('حقوق و دستمزد'));
  assert.ok(backbone.evidence.fixedPercent > 0);
});

test('تمرکز درآمد تک‌منبعی هشدار می‌دهد', () => {
  const dna = financialDna(retailRows(), { now: NOW, months: 4 });
  const concentration = dna.traits.find((item) => item.id === 'income-concentration');
  assert.match(concentration.value, /فروش/);
  assert.ok(concentration.detail.includes('تک‌منبعی'), 'وقتی یک دسته غالب است باید صریح گفته شود');
});

// این صفت مستقیم روی برنامهٔ کاری دفتر اثر دارد و از هیچ گزارش دیگری پیدا نیست.
test('ثبت روزانه از ثبت انبوه آخر ماه تشخیص داده می‌شود', () => {
  const daily = financialDna(retailRows(), { now: NOW, months: 4 });
  assert.equal(daily.traits.find((item) => item.id === 'entry-discipline').value, 'روزانه و به‌موقع');

  // همان داده، ولی همه یک‌جا در یک روز وارد شده‌اند.
  const bulkCreatedAt = NOW.toISOString();
  const bulk = financialDna(retailRows().map((item) => ({ ...item, createdAt: bulkCreatedAt })), { now: NOW, months: 4 });
  const discipline = bulk.traits.find((item) => item.id === 'entry-discipline');
  assert.equal(discipline.value, 'انبوه و دیرهنگام');
  assert.ok(discipline.evidence.busiestDayCount > 100);
  assert.ok(discipline.evidence.typicalLagDays > 0);
});

test('پروفایل دفتر بار کاری و دسته‌های فعال را می‌دهد', () => {
  const dna = financialDna(retailRows(), { now: NOW, months: 4 });
  assert.equal(dna.brief.shape, 'روزانه و پرتعداد');
  assert.ok(dna.brief.documentsPerMonth > 0);
  assert.ok(dna.brief.typicalIncome > 0);
  assert.ok(dna.brief.typicalExpense > 0);
  assert.ok(dna.brief.activeCategories.some((item) => item.category === 'فروش'));
  assert.ok(dna.brief.workloadNote.length > 0);
});

test('الگوی هفتگی فقط با چند هفته داده ساخته می‌شود', () => {
  const short = financialDna(
    Array.from({ length: 40 }, (_, index) => row(index % 10, 500_000, 'income', 'فروش')),
    { now: NOW, months: 1 },
  );
  assert.equal(short.traits.find((item) => item.id === 'weekday-pattern'), undefined);

  const long = financialDna(retailRows(), { now: NOW, months: 4 });
  const weekday = long.traits.find((item) => item.id === 'weekday-pattern');
  assert.ok(weekday);
  assert.equal(weekday.evidence.byWeekday.length, 7);
  assert.equal(weekday.evidence.byWeekday.reduce((sum, item) => sum + item.percent, 0) >= 99, true);
});

test('سهم ثبت صوتی از منبع واقعی ثبت‌ها می‌آید', () => {
  const rows = retailRows().map((item, index) => ({ ...item, source: index % 2 ? 'text' : 'voice' }));
  const dna = financialDna(rows, { now: NOW, months: 4 });
  const adoption = dna.traits.find((item) => item.id === 'voice-adoption');
  assert.match(adoption.value, /٪/);
  assert.ok(adoption.evidence.voice > 0 && adoption.evidence.voice < adoption.evidence.total);
});

// آستانهٔ «تکرارشونده» باید از ماه‌های واقعیِ موجود بیاید، نه از پنجرهٔ درخواستی.
// وگرنه درخواست شش‌ماهه روی چهار ماه داده، اجاره و حقوق را — یعنی واقعی‌ترین
// هزینه‌های ثابت — از ستون فقرات بیرون می‌اندازد.
test('پنجرهٔ درخواستی بزرگ‌تر از داده، هزینهٔ ثابت را حذف نمی‌کند', () => {
  const rows = [];
  for (let day = 0; day < 115; day += 1) {
    rows.push(row(day, 1_000_000, 'income', 'فروش'));
    if (day % 30 === 5) {
      rows.push(row(day, 28_000_000, 'expense', 'اجاره'));
      rows.push(row(day, 52_000_000, 'expense', 'حقوق و دستمزد'));
    }
    if (day % 4 === 0) rows.push(row(day, 3_200_000, 'expense', 'مواد و کالا'));
  }
  // شش ماه خواسته شده ولی داده پنج ماه است؛ اجاره در سه ماه از پنج ماه دیده می‌شود
  // چون تاریخ پرداختش نسبت به ماه شمسی جابه‌جا می‌شود — دقیقاً حالت واقعی.
  const dna = financialDna(rows, { now: NOW, months: 6 });
  const fixed = dna.traits.find((item) => item.id === 'expense-backbone').evidence.fixed.map((item) => item.category);
  assert.ok(fixed.includes('اجاره'), 'اجاره باید هزینهٔ تکرارشونده شمرده شود');
  assert.ok(fixed.includes('حقوق و دستمزد'), 'حقوق باید هزینهٔ تکرارشونده شمرده شود');
});
