import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

/**
 * کارتِ صف حسابدار (بازطراحی ۲۹ مهر ۱۴۰۵): همان اول «چرا در صف است؟» صریح، و فقط یک قدمِ بعدی —
 * سؤال کارتی، تحلیل، یا تأییدِ سندِ آماده. جملهٔ مالک محصول: «وقتی مورد می‌رود توی صف و کاربر
 * می‌خواندش، همان اول باید مشکلی که به‌خاطرش آمده خیلی شفاف و صریح بیان شود.»
 */

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const load = async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try { return await vite.ssrLoadModule('/src/features/review/reviewCase.js'); } finally { await vite.close(); }
};

test('مسیر هر مورد: سؤال کارتی، تحلیل، تأیید، یا پیگیریِ بی‌مبلغ', async () => {
  const { reviewPath } = await load();
  assert.equal(reviewPath({ intake: true }), 'intake');
  assert.equal(reviewPath({ approvalNextStep: 'answer-question', approvalBlocked: true }), 'question');
  assert.equal(reviewPath({ approvalNextStep: 'manual-review', approvalBlocked: true }), 'analysis');
  assert.equal(reviewPath({ approvalNextStep: 'approve', event: { kind: 'review-placeholder' } }), 'analysis');
  assert.equal(reviewPath({ approvalNextStep: 'approve', approvalBlocked: false }), 'approve');
});

test('«چرا در صف است؟»: جملهٔ ساده، نه سؤالِ جواب‌گرفته و نه اصطلاح موتور', async () => {
  const { reviewCase } = await load();
  // دیده‌شده در Chrome: پس از جوابِ «این خرید برای چیست؟» همان سؤال هنوز دلیل نشان داده می‌شد.
  const answered = reviewCase({ approvalNextStep: 'manual-review', approvalBlocked: true, confidence: { reasons: ['این خرید برای چیست؟', 'مبلغ بدون ارزش افزوده گفته شده؛ پولی که واقعاً جابه‌جا شد چقدر بود؟'] } });
  assert.equal(answered.path, 'analysis');
  assert.equal(answered.headline, 'مبلغ بدون ارزش افزوده گفته شده');
  assert.match(answered.detail, /پولی که واقعاً جابه‌جا شد چقدر بود/);
  // سؤال خودش زیرِ کارت است؛ تیتر تکرارش نمی‌کند.
  const asking = reviewCase({ approvalNextStep: 'answer-question', approvalBlocked: true, confidence: { reasons: ['طرف حساب چه کسی است؟'] } });
  assert.equal(asking.headline, 'برای ثبت فقط یک جواب کم است.');
  assert.equal(asking.badge, 'یک سؤال کوتاه');
  assert.equal(reviewCase({ approvalBlocked: true, confidence: { reasons: ['نوع تراکنش از متن با اطمینان کافی مشخص نیست.'] } }).headline, 'از متن معلوم نیست این پول آمده یا رفته.');
  assert.equal(reviewCase({ approvalBlocked: true, confidence: { reasons: ['دسته: واژهٔ شناخته‌شده‌ای برای دسته‌بندی در متن نبود؛ دستهٔ عمومی پیشنهاد شد.'] } }).headline, 'دستهٔ این مورد از متن معلوم نیست.');
  const composite = reviewCase({ event: { kind: 'review-placeholder' }, confidence: { reasons: ['چند مبلغ برای یک رویداد گفته شد (جمع و اجزا)؛ هیچ ثبتی انجام نشد. مبلغ پرداخت را مشخص کن.'] } });
  assert.equal(composite.headline, 'چند مبلغ در یک جمله آمده؛ تفکیکشان با حسابدار است.');
  assert.match(composite.detail, /هیچ ثبتی انجام نشد/);
  assert.equal(reviewCase({ approvalNextStep: 'approve' }).headline, 'سند آماده است و تأیید تو را لازم دارد.');
});

test('پیشنهادِ AI در دو خط: مشکل (آنچه قفل کرده) و راه‌حل (خلاصه)', async () => {
  const { proposalBrief } = await load();
  assert.deepEqual(proposalBrief({ canPost: true, summary: 'خرید فن', explanation: 'بلند' }), { ready: true, problem: '', solution: 'خرید فن', more: 'بلند' });
  assert.equal(proposalBrief({ canPost: false, summary: 'خرید فن' }, { conditions: ['بانک را انتخاب کن.'] }).problem, 'بانک را انتخاب کن.');
  // دیده‌شده در Chrome: «سطرهای معتبر ندارد» پیامدِ سؤالِ بی‌جواب است، نه علتش.
  const asked = proposalBrief({ canPost: false }, { unanswered: [{}], conditions: ['پیشنهاد هنوز سطرهای معتبر و متوازن برای ثبت ندارد.'] });
  assert.equal(asked.problem, 'یک سؤال بی‌جواب مانده است.');
  assert.equal(asked.fromQuestions, true);
  assert.equal(proposalBrief({ canPost: false }, { unanswered: [{}, {}, {}] }).problem, '۳ سؤال بی‌جواب مانده است.');
  assert.equal(proposalBrief({ canPost: false }, { unanswered: [{}] }).problem, 'یک سؤال بی‌جواب مانده است.');
});

test('صف بی پنجرهٔ prompt مرورگر؛ حرکت‌ها کوتاه، فقط opacity/transform و با «کاهش حرکت» خاموش', () => {
  for (const path of ['src/features/review/ReviewQueuePage.jsx', 'src/features/review/ReviewAssistant.jsx']) {
    assert.doesNotMatch(source(path), /window\.prompt/, path);
  }
  const css = source('src/styles.css');
  assert.match(css, /@keyframes rq-step-in \{ from \{ opacity: 0; transform: translateY\(6px\); \} \}/);
  assert.match(css, /\.rq-step \{ animation: rq-step-in \.18s var\(--ease-out\); \}/);
  assert.match(css, /\.rq-leaving \{ opacity: 0; transform: translateY\(-4px\); transition: opacity \.16s var\(--ease-out\), transform \.16s var\(--ease-out\); \}/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.rq-step, \.rq-skeleton \{ animation: none; \}\s*\.rq-leaving \{ transition: none; \}/);
  const page = source('src/features/review/ReviewQueuePage.jsx');
  assert.match(page, /چرا در صف است؟/);
  assert.match(page, /<EntryTable lines=\{item\.plan\?\.lines \|\| \[\]\} title="سند نهایی" \/>/);
});

test('سندِ نهایی فقط برای موردی که تأییدش باز است فرستاده می‌شود', () => {
  const store = source('server/financialEventStore.js');
  assert.match(store, /plan: approvalBlocked \? null : planPreview\(database, row\)/);
});
