/**
 * هر موردِ صف حسابدار، به زبان کسی که بازش می‌کند: چرا این‌جاست و قدم بعدی چیست.
 *
 * بازخورد مالک محصول (۲۹ مهر ۱۴۰۵): «همان اول باید مشکلی که به‌خاطرش آمده خیلی شفاف و
 * صریح بیان شود؛ اگر با چند سؤال کارتی حل می‌شود، سؤال‌ها به ترتیب؛ اگر تحلیل لازم است،
 * بگوید.» این ماژول هیچ رابطی ندارد تا همین تصمیم آزمون‌پذیر بماند.
 */

import { toPersianDigits } from '../../lib/format.js';

/** برچسب فارسی نقش‌ها — همان واژه‌هایی که «فهم رویداد» هم به کاربر نشان می‌دهد. */
export const ROLE_LABELS = Object.freeze({
  cash: 'بانک یا صندوق', receivable: 'طلب از مشتری', payable: 'بدهی به تأمین‌کننده', 'expense-category': 'هزینه', 'income-category': 'درآمد',
  'fixed-asset': 'دارایی ثابت', 'prepaid-asset': 'پیش‌پرداخت', 'refundable-deposit': 'ودیعه', 'loan-payable': 'وام پرداختنی',
  'customer-advance': 'پیش‌دریافت مشتری', 'deferred-revenue': 'درآمد انتقالی', 'supplier-advance': 'پیش‌پرداخت به تأمین‌کننده',
  'employee-advance': 'مساعده کارکنان', 'inventory-asset': 'کالای انبار', 'inventory-unsplit': 'کالای تفکیک‌نشده',
  'cheque-receivable': 'چک دریافتنی', 'cheque-payable': 'چک پرداختنی', 'tax-receivable': 'طلب مالیات',
  'vat-input': 'مالیات ارزش افزوده خرید', 'vat-output': 'مالیات ارزش افزوده فروش', 'partner-payable': 'بدهی به شریک',
  'partner-receivable': 'طلب از شریک', 'owner-capital': 'سرمایه مالک', 'owner-drawing': 'برداشت مالک',
  'accumulated-depreciation': 'استهلاک انباشته', 'depreciation-expense': 'هزینه استهلاک', 'unidentified-receipt': 'وجه ناشناس',
});

export const PATHS = Object.freeze({
  question: { badge: 'یک سؤال کوتاه', tone: 'accent' },
  analysis: { badge: 'نیاز به تحلیل', tone: 'warn' },
  approve: { badge: 'آمادهٔ تأیید', tone: 'income' },
  intake: { badge: 'مبلغ نامشخص', tone: 'warn' },
});

const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/**
 * جملهٔ اول، تیتر؛ بقیه، توضیح. «چند مبلغ برای یک رویداد گفته شد (جمع و اجزا)؛ هیچ ثبتی
 * انجام نشد. …» تیترش همان بخشِ پیش از «؛» است.
 */
export function splitReason(text) {
  const value = clean(text);
  if (!value) return { headline: '', detail: '' };
  const cut = value.search(/[؛.]\s/);
  if (cut < 0 || cut > 140) return { headline: value.replace(/[.؛]$/, ''), detail: '' };
  return { headline: value.slice(0, cut).trim(), detail: value.slice(cut + 1).trim() };
}

/**
 * دلیل‌های پرتکرارِ موتور به زبانِ کسی که کارت را می‌خواند. فقط تیترِ چند الگوی شناخته‌شده
 * عوض می‌شود؛ متنِ کاملِ موتور در «جزئیات» دست‌نخورده می‌ماند.
 */
const PLAIN_REASONS = [
  [/^نوع تراکنش از متن با اطمینان کافی مشخص نیست/, 'از متن معلوم نیست این پول آمده یا رفته.'],
  [/^دسته: واژهٔ شناخته‌شده‌ای برای دسته‌بندی در متن نبود/, 'دستهٔ این مورد از متن معلوم نیست.'],
  [/^چند مبلغ برای یک رویداد گفته شد/, 'چند مبلغ در یک جمله آمده؛ تفکیکشان با حسابدار است.'],
];
const plain = (text) => PLAIN_REASONS.find(([pattern]) => pattern.test(text))?.[1] || text;

/**
 * سؤالِ خالص («این خرید برای چیست؟») دلیل نیست؛ جایش کارتِ سؤال است. دلیل‌های ذخیره‌شدهٔ
 * موتور هنگام ساخت نوشته می‌شوند و پس از جوابِ سؤال هم همان می‌مانند؛ بی این صافی، کارتی که
 * جوابش را گرفته بود همچنان «این خرید برای چیست؟» را دلیل نشان می‌داد (دیده‌شده در Chrome).
 */
const isPureQuestion = (text) => /؟\s*$/.test(text) && !/؛/.test(text);

/** دلیل‌های تکراری، خالی یا سؤالِ خالص بیرون؛ ترتیبِ موتور حفظ می‌شود. */
export function reasonsOf(item = {}) {
  const seen = new Set();
  return (item.confidence?.reasons || []).map(clean).filter((reason) => reason && !isPureQuestion(reason) && !seen.has(reason) && seen.add(reason));
}

/**
 * مسیرِ یک مورد:
 * - `question`: موتور یک واقعیت کم دارد و آن را با کارت گزینه می‌پرسد؛
 * - `analysis`: سند قطعی نیست و تحلیل (AI یا حسابدار) لازم است؛
 * - `approve`: سند آماده است و فقط تأیید می‌خواهد؛
 * - `intake`: گفته‌ای بی‌مبلغ که حسابدار باید پیگیری کند.
 */
export function reviewPath(item = {}) {
  if (item.intake) return 'intake';
  if (item.approvalNextStep === 'answer-question') return 'question';
  if (item.approvalBlocked || item.event?.kind === 'review-placeholder') return 'analysis';
  return 'approve';
}

export function reviewCase(item = {}) {
  const path = reviewPath(item);
  const reasons = reasonsOf(item);
  const split = splitReason(reasons[0] || '');
  const first = { headline: split.headline ? plain(split.headline) : '', detail: split.detail };
  const fallback = path === 'question'
    ? 'برای ثبت فقط یک جواب کم است.'
    : path === 'analysis' ? 'سند این مورد هنوز قطعی نیست و باید تحلیل شود.'
      : path === 'intake' ? 'مبلغ این گفته مشخص نشده است.' : 'سند آماده است و تأیید تو را لازم دارد.';
  // سؤال خودش زیرِ همین کارت است؛ تیتر تکرارش نمی‌کند.
  const headline = first.headline || fallback;
  const detail = [first.detail, ...reasons.slice(1).map((reason) => splitReason(reason).headline)].filter(Boolean).join(' ').slice(0, 240);
  const next = path === 'question' ? 'به سؤال پایین جواب بده؛ بعد سند نهایی برای تأیید نشان داده می‌شود.'
    : path === 'analysis' ? '«تحلیل کن» را بزن تا سند پیشنهادی ساخته شود؛ تا تأیید تو چیزی ثبت نمی‌شود.'
      : path === 'intake' ? 'مبلغ و سند مبنا را بررسی کن و نتیجه را بنویس.' : 'سند پایین را ببین و تأیید کن.';
  return { path, ...PATHS[path], headline, detail, next };
}

/**
 * مشکل و راه‌حلِ پیشنهادِ AI، کوتاه: مشکل همان چیزی است که تأیید را قفل کرده (اولین
 * گیره یا سؤالِ بی‌جواب)، راه‌حل خلاصهٔ پیشنهاد. توضیحِ بلند پشتِ «بیشتر» می‌ماند.
 */
export function proposalBrief(ai = {}, { unanswered = [], conditions = [] } = {}) {
  const solution = clean(ai.summary);
  if (ai.canPost) return { ready: true, problem: '', solution, more: clean(ai.explanation) };
  // سؤالِ بی‌جواب علت است و «سطرهای معتبر ندارد» پیامدش؛ پس سؤال اول می‌آید (دیده‌شده در Chrome).
  const problem = unanswered.length ? (unanswered.length === 1 ? 'یک سؤال بی‌جواب مانده است.' : `${toPersianDigits(unanswered.length)} سؤال بی‌جواب مانده است.`)
    : conditions[0] ? clean(conditions[0]) : 'پیشنهاد هنوز قابل ثبت نیست.';
  return { ready: false, problem, solution, more: clean(ai.explanation), fromQuestions: unanswered.length > 0 };
}
