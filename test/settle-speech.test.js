import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSettleIntent, matchSettleTargets } from '../shared/settleSpeech.js';

const invoices = [
  { id: 'inv-1', number: 'FR-1405-0001', customerName: 'احمدی', status: 'sent', balanceDue: 3_000_000, documentType: 'sales' },
  { id: 'inv-2', number: 'FR-1405-0002', customerName: 'شرکت پارس خودرو', status: 'sent', balanceDue: 12_000_000, documentType: 'sales' },
  { id: 'inv-3', number: 'FR-1405-0003', customerName: 'احمدی', status: 'paid', balanceDue: 0, documentType: 'sales' },
  { id: 'inv-4', number: 'KH-1405-0001', customerName: 'رضایی', status: 'draft', balanceDue: 5_000_000, documentType: 'purchase' },
];
const obligations = [
  { id: 'ob-1', title: 'چک احمدی', contactName: 'احمدی', amount: 5_000_000, direction: 'receivable', status: 'open' },
  { id: 'ob-2', title: 'طلب رضایی', contactName: 'رضایی', amount: 2_000_000, direction: 'receivable', status: 'open' },
  { id: 'ob-3', title: 'بدهی شرکت پارس خودرو', contactName: 'شرکت پارس خودرو', amount: 8_000_000, direction: 'payable', status: 'open' },
  { id: 'ob-4', title: 'طلب قدیمی', contactName: 'احمدی', amount: 1_000_000, direction: 'receivable', status: 'paid' },
];
const match = (text) => matchSettleTargets(detectSettleIntent(text), { invoices, obligations });

test('جملهٔ غیرتسویه‌ای وارد این مسیر نمی‌شود', () => {
  assert.equal(detectSettleIntent('دو میلیون بابت تبلیغات دادم'), null);
  assert.equal(detectSettleIntent('فاکتور فروش برای آقای احمدی سه میلیون'), null);
  assert.equal(detectSettleIntent('آقای احمدی سه میلیون بدهکاره'), null);
  assert.equal(detectSettleIntent(''), null);
});

test('فعل‌های تسویه شناخته می‌شوند', () => {
  for (const sentence of [
    'فاکتور آقای احمدی رو تسویه کن',
    'چک آقای احمدی پاس شد',
    'طلب رضایی وصول شد',
    'بدهی شرکت پارس خودرو پرداخت شد',
  ]) assert.equal(detectSettleIntent(sentence)?.intent, 'settle', sentence);
});

// چک برگشتی تسویه نیست؛ اجرای تسویه رویش یک سند باز را دروغ می‌بندد.
test('چک برگشتی تسویه نمی‌شود', () => {
  const found = detectSettleIntent('چک آقای احمدی برگشت خورد');
  assert.equal(found.bounced, true);
  assert.deepEqual(matchSettleTargets(found, { invoices, obligations }), []);
});

test('فاکتور با نام مشتری پیدا می‌شود و سند بسته نادیده می‌ماند', () => {
  const found = match('فاکتور آقای احمدی رو تسویه کن');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'inv-1');
});

// پیش‌نویس هنوز سند نیست و تسویه‌شدنی نیست.
test('پیش‌نویس و سند لغوشده گزینهٔ تسویه نمی‌شوند', () => {
  const found = match('فاکتور آقای رضایی رو تسویه کن');
  assert.deepEqual(found, []);
});

test('چک فقط چک را می‌بندد، نه طلب عادی همان شخص', () => {
  const found = match('چک آقای احمدی پاس شد');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'ob-1');
});

test('طلب با نام شخص پیدا می‌شود و طلب تسویه‌شده نمی‌آید', () => {
  const found = match('طلب آقای رضایی وصول شد');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'ob-2');
});

test('شمارهٔ سند مستقیم تطبیق می‌خورد', () => {
  const found = match('فاکتور FR-1405-0002 تسویه شد');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'inv-2');
});

test('مبلغ گفته‌شده قید می‌گذارد', () => {
  const withAmount = match('چک آقای احمدی پنج میلیون پاس شد');
  assert.equal(withAmount.length, 1);
  assert.equal(withAmount[0].id, 'ob-1');

  // مبلغی که با هیچ سندی نمی‌خورد نباید سند دیگری را تسویه کند.
  assert.deepEqual(match('چک آقای احمدی نه میلیون پاس شد'), []);
});

// نام چندبخشی نباید با نام مشابه اشتباه گرفته شود.
test('نام چندبخشی همهٔ بخش‌هایش باید بخورد', () => {
  const found = match('بدهی شرکت پارس خودرو پرداخت شد');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'ob-3');
});

// این مهم‌ترین قاعدهٔ ایمنی است: چند گزینه یعنی هیچ اجرای خودکاری.
test('وقتی چند سند می‌خورند، همه برگردانده می‌شوند تا کاربر انتخاب کند', () => {
  const found = match('تسویه شد');
  assert.ok(found.length > 1, 'جملهٔ بی‌قید باید همهٔ سندهای باز را نشان دهد');
  assert.ok(found.every((item) => item.id !== 'inv-3'), 'سند بسته نباید بیاید');
  assert.ok(found.every((item) => item.id !== 'ob-4'), 'طلب تسویه‌شده نباید بیاید');
  assert.ok(found.every((item) => item.id !== 'inv-4'), 'پیش‌نویس نباید بیاید');
});

test('سندی که نامش نمی‌خورد هرگز انتخاب نمی‌شود', () => {
  assert.deepEqual(match('فاکتور آقای موسوی تسویه شد'), []);
});

test('تاریخ تسویه از جمله برداشته می‌شود', () => {
  const found = detectSettleIntent('چک آقای احمدی دیروز پاس شد');
  assert.ok(found.occurredAt, 'تاریخ گفته‌شده باید روی تسویه بنشیند');
});
