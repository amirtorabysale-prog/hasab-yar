import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSettleIntent, matchSettleTargets } from '../shared/settleSpeech.js';
import { runVoice } from './helpers/voicePipeline.js';

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

test('دریافت طلب قبلی به جای ساخت طلب تازه، سند باز را برای انتخاب نشان می‌دهد', () => {
  const sentence = '۷ میلیون تومان از طلب قبلی دریافت کردم';
  const intent = detectSettleIntent(sentence);
  assert.equal(intent?.kind, 'any');
  assert.equal(intent.direction, 'receivable');
  assert.equal(intent.amount, 7_000_000);
  assert.equal(runVoice(sentence).path, 'settle');
  const targets = matchSettleTargets(intent, { obligations: [
    { id: 'old-claim', title: 'طلب قدیمی', amount: 20_000_000, remaining: 12_000_000, direction: 'receivable', status: 'open' },
    { id: 'old-debt', title: 'بدهی قدیمی', amount: 7_000_000, direction: 'payable', status: 'open' },
  ] });
  assert.deepEqual(targets.map((target) => [target.id, target.amount, target.paymentAmount]), [['old-claim', 12_000_000, 7_000_000]]);
  assert.deepEqual(matchSettleTargets(intent, { obligations: [
    { id: 'legacy', title: 'طلب قبلی', amount: 12_000_000, direction: 'receivable', status: 'open', journalStatus: 'legacy' },
    { id: 'pending', title: 'طلب تازه', amount: 12_000_000, direction: 'receivable', status: 'open', journalStatus: 'pending' },
  ] }), [], 'صدای وصول نباید سند بدون پشتوانهٔ دفتر را برای انتخاب عرضه کند');
  assert.deepEqual(matchSettleTargets(intent, { obligations: [
    { id: 'small-claim', title: 'طلب قدیمی', amount: 5_000_000, direction: 'receivable', status: 'open' },
  ] }), [], 'مبلغ دریافت نباید از ماندهٔ سند بیشتر باشد');
  const invoiceTargets = matchSettleTargets(intent, { invoices: [
    { id: 'sales-invoice', number: 'FR-1405-0001', status: 'sent', balanceDue: 12_000_000, documentType: 'sales' },
    { id: 'purchase-invoice', number: 'KH-1405-0001', status: 'sent', balanceDue: 12_000_000, documentType: 'purchase' },
  ] });
  assert.deepEqual(invoiceTargets.map((target) => [target.id, target.paymentAmount]), [['sales-invoice', 7_000_000]]);
});

test('پرداخت بدهی قبلی هم به انتخاب سند می‌رود و ایجاد بدهی تازه نمی‌کند', () => {
  const intent = detectSettleIntent('۲ میلیون تومان از بدهی قبلی رو پرداخت کردم');
  assert.equal(intent?.direction, 'payable');
  assert.equal(intent?.amount, 2_000_000);
  assert.equal(runVoice('۲ میلیون تومان از بدهی قبلی رو پرداخت کردم').path, 'settle');
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

// ---------------------------------------------------- هزینهٔ ساده، نه تسویه

/**
 * «پرداخت کردم» معمول‌ترین شکل بیان یک هزینهٔ ساده در فارسی است.
 *
 * وقتی این فعل به‌تنهایی تسویه شمرده می‌شد، جملهٔ «دو میلیون بابت اجاره پرداخت
 * کردم» به‌جای ثبت هزینه برگهٔ «کدام سند تسویه شود؟» را باز می‌کرد؛ و چون سند
 * بازی وجود نداشت، کاربر در بن‌بست می‌ماند و باید جمله‌اش را دور می‌انداخت.
 *
 * قاعده: تسویه بدون سند بی‌معنی است.
 */
test('هزینهٔ ساده با «پرداخت کردم» تسویه شمرده نمی‌شود', () => {
  assert.equal(detectSettleIntent('دیروز ۲ میلیون و ۵۰۰ هزار تومان از بانک ملت بابت اجاره مغازه پرداخت کردم'), null);
  assert.equal(detectSettleIntent('پانصد هزار تومان بابت قبض برق پرداخت کردم'), null);
  assert.equal(detectSettleIntent('کرایه پیک را نقد کردم'), null);
  assert.equal(detectSettleIntent('حقوق کارگر را صاف کردم'), null);
});

test('همان فعل در کنار نام سند، تسویه است', () => {
  assert.ok(detectSettleIntent('فاکتور آقای رضایی را پرداخت کردم'));
  assert.ok(detectSettleIntent('چک آقای احمدی پاس شد'));
  assert.ok(detectSettleIntent('بدهی رضا را پرداخت کردم'));
  assert.ok(detectSettleIntent('طلب مغازه وصول شد'));
});

// فعل صریح حتی بدون نام سند هم تسویه است؛ کاربر می‌خواهد فهرست باز را ببیند.
test('فعل صریح تسویه بدون نام سند هم کار می‌کند', () => {
  assert.ok(detectSettleIntent('تسویه کردم'));
  assert.ok(detectSettleIntent('حساب رضا بسته شد'));
});
