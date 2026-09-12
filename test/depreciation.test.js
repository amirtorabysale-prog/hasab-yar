import assert from 'node:assert/strict';
import test from 'node:test';
import { assetStatus, dueDepreciation, monthsBetween, nextPersianMonth, straightLineSchedule } from '../shared/depreciation.js';

test('ماه شمسی بعدی از مرز سال درست رد می‌شود', () => {
  assert.equal(nextPersianMonth('1405-06'), '1405-07');
  assert.equal(nextPersianMonth('1405-12'), '1406-01');
  assert.equal(nextPersianMonth('1404-01'), '1404-02');
  assert.equal(nextPersianMonth(''), '');
});

test('فاصلهٔ ماه‌ها از مرز سال هم درست شمرده می‌شود', () => {
  assert.equal(monthsBetween('1405-01', '1405-06'), 5);
  assert.equal(monthsBetween('1404-11', '1405-02'), 3);
  assert.equal(monthsBetween('1405-06', '1405-06'), 0);
  assert.equal(monthsBetween('1405-07', '1405-06'), -1);
});

// این مهم‌ترین خاصیت حسابداری این ماژول است: تقسیم ساده و گردکردن هر قسط، در
// پنج سال رانش می‌سازد و ارزش دفتری هیچ‌وقت دقیقاً صفر نمی‌شود.
test('جمع اقساط دقیقاً برابر بهای مستهلک‌شدنی است', () => {
  const cases = [
    { cost: 120_000_000, salvage: 0, usefulLifeMonths: 60 },
    { cost: 100_000_000, salvage: 0, usefulLifeMonths: 36 },
    { cost: 33_333_333, salvage: 0, usefulLifeMonths: 7 },
    { cost: 99_999_999, salvage: 1, usefulLifeMonths: 11 },
    { cost: 45_000_000, salvage: 5_000_000, usefulLifeMonths: 48 },
  ];
  for (const asset of cases) {
    const schedule = straightLineSchedule({ ...asset, inServiceMonth: '1405-01' });
    const total = schedule.reduce((sum, row) => sum + row.amount, 0);
    assert.equal(total, asset.cost - asset.salvage, JSON.stringify(asset));
    assert.equal(schedule.length, asset.usefulLifeMonths);
    assert.equal(schedule.at(-1).bookValue, asset.salvage, `ارزش دفتری پایان عمر باید ارزش اسقاط باشد: ${JSON.stringify(asset)}`);
  }
});

test('هیچ قسطی منفی یا صفر نمی‌شود و ترتیب ماه‌ها پیوسته است', () => {
  const schedule = straightLineSchedule({ cost: 10_000_000, salvage: 0, usefulLifeMonths: 24, inServiceMonth: '1404-11' });
  assert.ok(schedule.every((row) => row.amount > 0));
  for (let index = 1; index < schedule.length; index += 1) {
    assert.equal(schedule[index].month, nextPersianMonth(schedule[index - 1].month));
  }
  assert.equal(schedule[0].month, '1404-11');
  assert.equal(schedule[1].month, '1404-12');
  assert.equal(schedule[2].month, '1405-01');
});

test('ورودی نامعتبر جدول نمی‌سازد', () => {
  const invalid = [
    { cost: 0, usefulLifeMonths: 12, inServiceMonth: '1405-01' },
    { cost: 1_000_000, usefulLifeMonths: 0, inServiceMonth: '1405-01' },
    { cost: 1_000_000, usefulLifeMonths: 12, inServiceMonth: '' },
    // ارزش اسقاط برابر یا بیشتر از بها یعنی چیزی برای استهلاک نمانده.
    { cost: 1_000_000, salvage: 1_000_000, usefulLifeMonths: 12, inServiceMonth: '1405-01' },
    { cost: 1_000_000, salvage: 2_000_000, usefulLifeMonths: 12, inServiceMonth: '1405-01' },
  ];
  for (const asset of invalid) assert.deepEqual(straightLineSchedule(asset), [], JSON.stringify(asset));
});

// ---------------------------------------------------------------- سررسیدها

const asset = { cost: 120_000_000, salvage: 0, usefulLifeMonths: 60, inServiceMonth: '1405-01' };

test('فقط ماه‌های سررسیدشده برگردانده می‌شوند', () => {
  const due = dueDepreciation(asset, { throughMonth: '1405-03' });
  assert.deepEqual(due.map((row) => row.month), ['1405-01', '1405-02', '1405-03']);
});

// ثبت دوبارهٔ یک ماه، هزینهٔ دوره را باد می‌کند و انباشته را از بها جلو می‌اندازد.
test('ماه‌های از قبل ثبت‌شده دوباره سررسید نمی‌شوند', () => {
  const due = dueDepreciation(asset, { throughMonth: '1405-04', postedMonths: ['1405-01', '1405-02'] });
  assert.deepEqual(due.map((row) => row.month), ['1405-03', '1405-04']);
});

test('پیش از ماه بهره‌برداری هیچ قسطی سررسید نمی‌شود', () => {
  assert.deepEqual(dueDepreciation(asset, { throughMonth: '1404-12' }), []);
});

test('پس از پایان عمر، قسط تازه‌ای ساخته نمی‌شود', () => {
  const all = straightLineSchedule(asset).map((row) => row.month);
  assert.deepEqual(dueDepreciation(asset, { throughMonth: '1420-01', postedMonths: all }), []);
  // حتی با ماه خیلی دورتر، بیش از عمر مفید قسط وجود ندارد.
  assert.equal(dueDepreciation(asset, { throughMonth: '1420-01' }).length, 60);
});

test('بدون ماه مقصد چیزی سررسید نمی‌شود', () => {
  assert.deepEqual(dueDepreciation(asset, {}), []);
});

// ------------------------------------------------------------------- وضعیت

test('وضعیت دارایی از سندهای واقعی ساخته می‌شود، نه از جدول نظری', () => {
  const status = assetStatus(asset, { postedAmount: 6_000_000, throughMonth: '1405-06' });
  assert.equal(status.cost, 120_000_000);
  assert.equal(status.depreciable, 120_000_000);
  assert.equal(status.accumulated, 6_000_000);
  assert.equal(status.bookValue, 114_000_000);
  assert.equal(status.months, 60);
  // شش ماه × دو میلیون = دوازده میلیون باید ثبت می‌شد؛ شش میلیون ثبت شده.
  assert.equal(status.behindAmount, 6_000_000);
  assert.equal(status.complete, false);
});

test('دفترِ به‌روز عقب‌ماندگی ندارد', () => {
  const status = assetStatus(asset, { postedAmount: 12_000_000, throughMonth: '1405-06' });
  assert.equal(status.behindAmount, 0);
});

test('ارزش دفتری هیچ‌وقت زیر ارزش اسقاط نمی‌رود', () => {
  const withSalvage = { cost: 50_000_000, salvage: 5_000_000, usefulLifeMonths: 12, inServiceMonth: '1405-01' };
  const status = assetStatus(withSalvage, { postedAmount: 99_000_000, throughMonth: '1406-06' });
  assert.equal(status.bookValue, 5_000_000);
  assert.equal(status.complete, true);
});
