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

/**
 * دلیلِ عمومیِ اطمینان («نوع … با اطمینان کم»، «نوع: …»، «دسته: …») وقتی دلیلِ مشخص‌تری هست،
 * تیتر نمی‌شود. دیده‌شده روی سایت: پولی که شریک به شرکت داد تیترِ «از متن معلوم نیست این پول
 * آمده یا رفته» می‌گرفت و «پای شریک در میان است» ته توضیح گم می‌شد.
 */
const GENERIC_REASON = /^(?:نوع تراکنش از متن با اطمینان|نوع این تراکنش با اطمینان|نوع:|دسته:)/;

/** دلیل‌های تکراری، خالی یا سؤالِ خالص بیرون؛ دلیلِ مشخص پیش از دلیلِ عمومی، وگرنه ترتیبِ موتور. */
export function reasonsOf(item = {}) {
  const seen = new Set();
  const reasons = (item.confidence?.reasons || []).map(clean).filter((reason) => reason && !isPureQuestion(reason) && !seen.has(reason) && seen.add(reason));
  const specific = reasons.filter((reason) => !GENERIC_REASON.test(reason));
  return specific.length ? specific : reasons;
}

const sentence = (text) => (/[.؟!؛:]$/.test(text) ? text : `${text}.`);

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
  // هر دلیل جملهٔ خودش؛ پیش از این بی‌نقطه پشتِ هم می‌آمدند و یک جملهٔ درهم می‌ساختند.
  const detail = [first.detail, ...reasons.slice(1).map((reason) => splitReason(reason).headline)].filter(Boolean).map(sentence).join(' ').slice(0, 240);
  const next = path === 'question' ? 'به سؤال پایین جواب بده؛ بعد سند نهایی برای تأیید نشان داده می‌شود.'
    : path === 'analysis' ? '«تحلیل کن» را بزن تا سند پیشنهادی ساخته شود؛ تا تأیید تو چیزی ثبت نمی‌شود.'
      : path === 'intake' ? 'مبلغ و سند مبنا را بررسی کن و نتیجه را بنویس.' : 'سند پایین را ببین و تأیید کن.';
  return { path, ...PATHS[path], headline, detail, next };
}

/**
 * گیره‌های ثبتِ موتور به زبانِ کاربر: مشکل چیست و همین حالا چه کند. متنِ موتور برای
 * برنامه‌نویس نوشته شده («ثبت نقدی چندبخشی یا تخصصی است؛ مسیر تخصصی باید تکمیل شود») و
 * روی سایت هیچ‌کس نمی‌دانست با آن چه کند (آزمون صف، ۲۹ مهر ۱۴۰۵). `unsupported` یعنی
 * حساب‌یار این شکل سند را هنوز از این‌جا ثبت نمی‌کند و جوابِ سؤال هم بازش نمی‌کند.
 */
const PLAIN_BLOCKERS = [
  [/ثبت نقدی چندبخشی یا تخصصی/, {
    problem: 'یک پرداخت نقدی در سند به چند سطر تقسیم شده (مثل اصل و سود وام)؛ حساب‌یار هنوز پرداخت نقدی چندسطری را از این‌جا ثبت نمی‌کند.',
    fix: 'با «رد با دلیل» ردش کن و هر بخش را جدا بگو؛ مثلاً «۹ میلیون اصل وام ملت پرداخت شد» و «۳ میلیون سود وام ملت پرداخت شد».', unsupported: true }],
  [/^برگشت کالا یا پول یک خرید/, {
    problem: 'برگشت کالا یا پول یک خرید یا فروش قبلی هنوز از «تحلیل کن» ثبت نمی‌شود.',
    fix: 'با «رد با دلیل» کنارش بگذار؛ ثبت برگشت کالا هنوز در حساب‌یار کامل نشده است.', unsupported: true }],
  [/^برگشت کالا از مشتری/, {
    problem: 'برگشت کالا از مشتری باید فروش را کم کند؛ سند پیشنهادی فقط کالا را به قیمت فروش به انبار برگردانده.',
    fix: 'با «رد با دلیل» کنارش بگذار؛ ثبت برگشت کالا هنوز در حساب‌یار کامل نشده است.', unsupported: true }],
  [/جهت ورود یا خروج نقد/, {
    problem: 'جهت پول در سند پیشنهادی با حساب مقابل جور نیست؛ مثلاً پولی که آمده، خروج نوشته شده.',
    fix: 'در «گفت‌وگو با دستیار» بنویس پول آمد یا رفت و بابت چه بود.' }],
  [/نام کالا، مقدار و واحد|اطلاعات کالای این سطر/, {
    problem: 'نام کالا، تعداد و واحدش معلوم نیست.',
    fix: 'در «گفت‌وگو با دستیار» بنویس؛ مثلاً «۲ کارتن روغن، هر کارتن ۲ میلیون».' }],
  [/بانک یا صندوق واقعی را انتخاب کن|بانک سطر پیشنهادی با بانک/, {
    problem: 'معلوم نیست پول از کدام بانک یا صندوق جابه‌جا شده.',
    fix: 'بانک یا صندوق را در سؤال پایین، یا در «گفت‌وگو با دستیار» بخش «تاریخ، طرف‌حساب و بانک» انتخاب کن.' }],
  [/نام واقعی طرف[\s‌]*حساب/, { problem: 'نام طرف‌حساب معلوم نیست.', fix: 'نامش را در سؤال پایین بنویس.' }],
  [/تاریخ واقعی رویداد لازم/, { problem: 'تاریخ رویداد معلوم نیست.', fix: 'تاریخ را از «گفت‌وگو با دستیار» بخش «تاریخ، طرف‌حساب و بانک» وارد کن.' }],
  [/تغییر کرده؛ (?:پرونده|تحلیل|پیشنهاد) را دوباره/, { problem: 'از زمان این تحلیل، دفتر یا اطلاعات این مورد عوض شده.', fix: '«تحلیل دوباره» را بزن.' }],
];
const FALLBACK_FIX = 'در «گفت‌وگو با دستیار» بنویس چه چیزی درست است تا پیشنهاد تازه بدهد.';
export function plainBlocker(text) {
  const value = clean(text);
  const known = PLAIN_BLOCKERS.find(([pattern]) => pattern.test(value))?.[1];
  return known ? { ...known, unsupported: Boolean(known.unsupported) } : { problem: value, fix: FALLBACK_FIX, unsupported: false };
}

/** گیره‌ها به زبان کاربر و بی‌تکرار: «نام کالا …» و «اطلاعات کالای این سطر …» یک مشکل‌اند. */
export function plainBlockers(list = []) {
  const seen = new Set();
  return list.map(plainBlocker).filter((item) => item.problem && !seen.has(item.problem) && seen.add(item.problem));
}

/**
 * گیره‌های زیرِ «مشکل». «سطرهای معتبر ندارد» پیامدِ سؤالِ بی‌جواب است؛ وقتی سؤال هست، فهرست
 * تکرارش نمی‌کند (دیده‌شده روی سایت: کارتِ پرینتر زیرِ «عمر مفید چند سال است؟»).
 */
const CONSEQUENCE = /سطرهای معتبر و متوازن/;
export function remainingBlockers(conditions = [], { fromQuestions = false } = {}) {
  return plainBlockers(fromQuestions ? conditions.filter((text) => !CONSEQUENCE.test(text)) : conditions).slice(fromQuestions ? 0 : 1);
}

/**
 * مشکل و راه‌حلِ پیشنهادِ AI، کوتاه: مشکل همان چیزی است که تأیید را قفل کرده (اولین
 * گیره یا سؤالِ بی‌جواب)، راه‌حل خلاصهٔ پیشنهاد. توضیحِ بلند پشتِ «بیشتر» می‌ماند.
 */
export function proposalBrief(ai = {}, { unanswered = [], conditions = [] } = {}) {
  const solution = clean(ai.summary);
  if (ai.canPost) return { ready: true, problem: '', solution, more: clean(ai.explanation) };
  // سؤالِ بی‌جواب علت است و «سطرهای معتبر ندارد» پیامدش؛ پس سؤال اول می‌آید (دیده‌شده در Chrome).
  const [blocker] = plainBlockers(conditions);
  const problem = unanswered.length ? (unanswered.length === 1 ? 'یک سؤال بی‌جواب مانده است.' : `${toPersianDigits(unanswered.length)} سؤال بی‌جواب مانده است.`)
    : blocker ? blocker.problem : 'پیشنهاد هنوز قابل ثبت نیست.';
  return { ready: false, problem, fix: unanswered.length ? 'به سؤال پایین جواب بده؛ جواب‌ها ذخیره می‌مانند.' : blocker?.fix || FALLBACK_FIX,
    unsupported: !unanswered.length && Boolean(blocker?.unsupported), solution, more: clean(ai.explanation), fromQuestions: unanswered.length > 0 };
}
