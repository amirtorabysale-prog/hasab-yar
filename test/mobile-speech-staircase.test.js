import test from 'node:test';
import assert from 'node:assert/strict';
import { appendSpeechSegment, mergeSpeechSegments } from '../src/lib/liveSpeech.js';
import { parseFinancialText } from '../shared/parser.js';

/**
 * پلکانِ تشخیص زندهٔ اندروید.
 *
 * روی موبایل — هم Chrome و هم مرورگر سامسونگ — تشخیص زنده هر نسخهٔ نیمه‌تمام
 * جمله را به‌عنوان یک نتیجهٔ جدا برمی‌گرداند، نه به‌عنوان به‌روزرسانی نتیجهٔ
 * قبلی. چسباندن ساده این را می‌ساخت:
 *
 *   «پرداخت / پرداخت ۹۳ / پرداخت ۹۳ میلیون / پرداخت ۹۳ میلیون تومان …»
 *
 * و پیامدش از زشتیِ متن خیلی بدتر بود: هر «۹۳» یک مبلغ جدا شمرده می‌شد و یک
 * جملهٔ گفته‌شده به چهارده ثبتِ ۹۳ میلیونی تبدیل می‌شد — با یک بار تأیید،
 * یک‌میلیارد و سیصد میلیون هزینهٔ ساختگی.
 */
const STAIRCASE = [
  'پرداخت',
  'پرداخت 93',
  'پرداخت 93 میلیون',
  'پرداخت 93 میلیون تومان',
  'پرداخت 93 میلیون تومان به شرکت',
  'پرداخت 93 میلیون تومان به شرکت آراد گستر',
  'پرداخت 93 میلیون تومان به شرکت آراد گستر آسیا',
];

test('نسخهٔ کامل‌ترِ همان جمله جایگزین می‌شود، نه اضافه', () => {
  const heard = STAIRCASE.reduce((accumulated, segment) => appendSpeechSegment(accumulated, segment), '');
  assert.equal(heard, 'پرداخت 93 میلیون تومان به شرکت آراد گستر آسیا');
});

test('تکرار عین همان تکه چیزی اضافه نمی‌کند', () => {
  assert.equal(appendSpeechSegment('پرداخت 93 میلیون', 'پرداخت 93 میلیون'), 'پرداخت 93 میلیون');
  assert.equal(appendSpeechSegment('پرداخت 93 میلیون', '93 میلیون'), 'پرداخت 93 میلیون');
});

// هم‌پوشانی جزئی: نشست تازه وسط جمله شروع می‌کند.
test('هم‌پوشانی دنباله و سرآغاز یک بار نوشته می‌شود', () => {
  assert.equal(appendSpeechSegment('پرداخت 93 میلیون تومان به', 'تومان به شرکت آراد'), 'پرداخت 93 میلیون تومان به شرکت آراد');
});

test('جملهٔ واقعاً تازه با فاصله اضافه می‌شود', () => {
  assert.equal(appendSpeechSegment('قبض برق دادم', 'اجاره هم دادم'), 'قبض برق دادم اجاره هم دادم');
});

test('متن منتقل‌شده از نشست قبلی دوباره نوشته نمی‌شود', () => {
  const merged = mergeSpeechSegments('پرداخت 93 میلیون تومان', {
    finalTranscript: 'پرداخت 93 میلیون تومان به شرکت آراد گستر',
    interim: '',
    transcript: 'پرداخت 93 میلیون تومان به شرکت آراد گستر',
    candidates: [{ transcript: 'پرداخت 93 میلیون تومان به شرکت آراد گستر', confidence: 0.9 }],
  });
  assert.equal(merged.finalTranscript, 'پرداخت 93 میلیون تومان به شرکت آراد گستر');
  assert.equal(merged.candidates[0].transcript, 'پرداخت 93 میلیون تومان به شرکت آراد گستر');
});

/**
 * لایهٔ دوم: پارسر هم نباید به لایهٔ گفتار تکیه کند.
 *
 * هر منبع دیگری — Whisper، متن چسبانده‌شدهٔ کاربر — می‌تواند همین تکرار را
 * بسازد. مبلغ‌های پشت‌سرهمِ یکسان یک ثبت‌اند، و شمارشش گفته می‌شود تا حذف
 * بی‌صدا نباشد.
 */
test('یک جملهٔ تکرارشده، چهارده ثبت نمی‌سازد', () => {
  const garbage = STAIRCASE.join(' ');
  const { transactions } = parseFinancialText(garbage, { source: 'voice' });
  assert.equal(transactions.length, 1, `باید یک ثبت بماند، نه ${transactions.length}`);
  assert.equal(transactions[0].amount, 93_000_000);
  assert.equal(transactions[0].needsReview, true, 'متن تکراری هرگز بی‌پرسش ثبت نمی‌شود');
  assert.match(transactions[0].reviewReasons.join(' '), /بار پشت سر هم شنیده شد/);
  // و اطمینانِ مبلغ باید پایین بیاید؛ ۸۲٪ دادن به چنین متنی همان خطای اصلی بود.
  assert.ok(transactions[0].confidenceDetails.amount.score <= 0.5,
    `اطمینان مبلغ باید پایین باشد، نه ${transactions[0].confidenceDetails.amount.score}`);
});

test('دو مبلغ واقعاً متفاوت در یک جمله، دو ثبت می‌مانند', () => {
  const { transactions } = parseFinancialText('دو میلیون تومان قبض برق دادم و سه میلیون تومان اجاره دادم', { source: 'voice' });
  assert.equal(transactions.length, 2);
  assert.deepEqual(transactions.map((item) => item.amount), [2_000_000, 3_000_000]);
});
