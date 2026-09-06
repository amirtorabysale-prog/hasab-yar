import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDnaSignals, dnaSignals } from '../shared/dnaSignals.js';
import { dnaCategoryProfiles, overdueBackboneCategories } from '../server/financialDna.js';

const monthly = (category, amount, months, dayOfMonth = 22) => Array.from({ length: months }, (_, index) => {
  const when = new Date(Date.UTC(2026, 2 + index, dayOfMonth)).toISOString();
  return { amount, type: 'expense', category, occurredAt: when, createdAt: when };
});

const daily = (category, amount, count) => Array.from({ length: count }, (_, index) => {
  const when = new Date(Date.UTC(2026, 7, 1 + index)).toISOString();
  return { amount, type: 'expense', category, occurredAt: when, createdAt: when };
});

const profiles = dnaCategoryProfiles([...monthly('اجاره', 20_000_000, 6), ...daily('خوراک', 300_000, 10), ...daily('حمل‌ونقل', 150_000, 8)]);

test('مبلغ خارج از عادت همان دسته پرچم می‌خورد، با شاهد', () => {
  const signals = dnaSignals(profiles, { amount: 3_000_000, type: 'expense', category: 'خوراک' });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].code, 'dna-amount-out-of-pattern');
  assert.match(signals[0].message, /خوراک/);
  // مبلغ معمول همان دسته باید در پیام باشد؛ «غیرعادی است» بدون عدد قابل قضاوت نیست.
  assert.match(signals[0].message, /۳۰۰٬۰۰۰|300,000/);
});

test('مبلغ در دامنهٔ عادی همان دسته پرچم نمی‌خورد', () => {
  assert.deepEqual(dnaSignals(profiles, { amount: 400_000, type: 'expense', category: 'خوراک' }), []);
  // اجاره مبلغ درشتی دارد ولی برای خودش عادی است؛ میانگین کلی اینجا را اشتباه می‌گرفت.
  assert.deepEqual(dnaSignals(profiles, { amount: 20_000_000, type: 'expense', category: 'اجاره' }), []);
});

test('دستهٔ دیده‌نشده فقط روی پروندهٔ باسابقه پرچم می‌خورد', () => {
  const signals = dnaSignals(profiles, { amount: 500_000, type: 'expense', category: 'تبلیغات' });
  assert.equal(signals[0].code, 'dna-unseen-category');
  const thin = dnaCategoryProfiles(daily('خوراک', 300_000, 5));
  assert.deepEqual(dnaSignals(thin, { amount: 500_000, type: 'expense', category: 'تبلیغات' }), []);
});

test('دستهٔ کم‌نمونه ادعایی نمی‌سازد', () => {
  const thin = dnaCategoryProfiles(daily('خوراک', 300_000, 4));
  assert.deepEqual(dnaSignals(thin, { amount: 9_000_000, type: 'expense', category: 'خوراک' }), []);
});

test('نشانه فقط به صف بررسی می‌برد و چیزی را عوض نمی‌کند', () => {
  const result = applyDnaSignals({ transactions: [{ amount: 3_000_000, type: 'expense', category: 'خوراک', needsReview: false, reviewState: 'ready', reviewReasons: [] }] }, profiles);
  const item = result.transactions[0];
  assert.equal(item.needsReview, true);
  assert.equal(item.reviewState, 'review');
  assert.equal(item.amount, 3_000_000);
  assert.equal(item.category, 'خوراک');
  assert.equal(item.reviewReasons.length, 1);
});

test('بدون پروفایل هیچ چیزی به نتیجه اضافه نمی‌شود', () => {
  const input = { transactions: [{ amount: 9_000_000, type: 'expense', category: 'خوراک' }] };
  assert.deepEqual(applyDnaSignals(input, null), input);
  assert.deepEqual(applyDnaSignals(input, { totalRows: 0, months: 0, categories: [] }).transactions[0], input.transactions[0]);
});

test('هزینهٔ تکرارشوندهٔ ثبت‌نشده فقط بعد از روز معمولش خبر می‌شود', () => {
  const early = overdueBackboneCategories(profiles, [], { dayOfMonth: 3 });
  assert.equal(early.length, 0);
  const late = overdueBackboneCategories(profiles, [], { dayOfMonth: 28 });
  assert.equal(late[0].category, 'اجاره');
  // ثبت‌شدهٔ همین ماه دیگر خبر نیست.
  assert.equal(overdueBackboneCategories(profiles, [{ type: 'expense', category: 'اجاره' }], { dayOfMonth: 28 }).length, 0);
});
