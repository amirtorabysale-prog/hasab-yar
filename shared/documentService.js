import { normalizePersian } from './normalize.js';
import { classifyCategory } from './categoryRules.js';
import { readServicePeriod } from './periodSpeech.js';
import { saysRefundable } from './moneyPurpose.js';
import { TIME_BOUND_SERVICE_CATEGORIES } from './economicFamily.js';
import { DECISION_STATUS, decide } from './accountingDecision.js';
import { factsFromEvent } from './eventFacts.js';
import { TREATMENTS } from './factRequirements.js';
import { ROUTES } from './confidenceEngine.js';

/**
 * خدمت دوره‌دار روی سندِ پایه — چک، طلب و بدهی، فاکتور، قاعدهٔ تکرار.
 *
 * چرا یک خواننده برای همه: مسیر نقدی دسته و دورهٔ پوشش را از جمله می‌خواند و
 * پیش‌پرداخت می‌سازد، ولی چک و فاکتور و طلب/بدهی هر کدام دستهٔ ثابت خودشان را
 * داشتند («مواد و کالا»، «فروش»، «سایر هزینه‌ها») و دوره را اصلاً نمی‌خواندند.
 * نتیجه: همان «اجارهٔ یک‌ساله» با نقد پیش‌پرداخت می‌شد و با چک یک‌جا «مواد و
 * کالا». این فایل همان واقعیت‌ها را برای هر سند پایه یکسان می‌خواند تا موتور
 * تصمیم یک جواب بدهد.
 *
 * فقط می‌خواند، تصمیم نمی‌گیرد: نبودِ دوره `null` است تا موتور بپرسد، و نبودِ
 * دسته `null` است تا هیچ هزینه یا درآمد حدسی ساخته نشود.
 */

const has = (pattern, text) => pattern.test(text);

// نام خدمتی که دستهٔ دوره‌دار را می‌گوید، حتی وقتی واژهٔ «خرید» یا «انبار» کنارش
// است: «فاکتور خرید اجاره شش ماهه» اجاره است، نه مواد و کالا.
const RENT = /(?<![آ-ی])(?:اجاره|اجارهٔ|اجاره‌ی|کرایه\s*(?:دفتر|مغازه|انبار|سوله|ملک|خانه|خونه|واحد|کارگاه)|رهن|ودیعه|مستاجر|مستأجر|موجر|صاحبخونه|صاحبخانه)(?![آ-ی])/;
const INSURANCE = /(?<![آ-ی])(?:بیمه|بیمع|حق\s*بیمه)(?![آ-ی])/;
const NOT_A_PREMIUM = /ت[اأ]مین\s*اجتماع|لیست\s*بیمه|بیمه\s*(?:پرسنل|کارگر|کارکنان|بیکاری)|سهم\s*(?:کارفرما|کارگر)|خسارت|غرامت/;
const SOFTWARE = /(?<![آ-ی])(?:اشتراک|لایسنس|لاینسس|نرم\s*افزار|هاست|هاستینگ|سرور|دامنه|آنتی\s*ویروس|آبونمان|سرویس\s*ابری)(?![آ-ی])/;
const SERVICE_INCOME = /(?<![آ-ی])(?:اشتراک|لایسنس|پشتیبانی|نگهداری|سرویس|خدمات|قرارداد|مشاوره|آموزش|هاست|هاستینگ)(?![آ-ی])/;

/**
 * دستهٔ سند از روی متنش.
 *
 * `payable` — هزینه یا خریدی که بابتش بدهکار شدیم یا چک دادیم.
 * `receivable` — درآمدی که بابتش طلبکار شدیم یا چک گرفتیم. اجاره‌ای که می‌گیریم
 * «درآمد اجاره» است، نه «اجاره» که نام هزینه است.
 */
export function documentCategory(input, direction) {
  const text = normalizePersian(input);
  if (!text) return null;
  if (direction === 'receivable') {
    if (has(RENT, text)) return 'درآمد اجاره';
    if (has(SERVICE_INCOME, text)) return 'خدمات';
    const read = classifyCategory(text, 'income');
    return read.matched === false || read.confidence <= 0.5 ? null : read.category;
  }
  if (has(INSURANCE, text) && !has(NOT_A_PREMIUM, text)) return 'بیمه';
  if (has(RENT, text)) return 'اجاره';
  if (has(SOFTWARE, text)) return 'نرم‌افزار و اشتراک';
  const read = classifyCategory(text, 'expense');
  return read.matched === false || read.confidence <= 0.5 ? null : read.category;
}

/**
 * دستهٔ صریحی که فرم یا API فرستاده، به زبان همان طرفِ سند.
 *
 * «اجاره» روی چک دریافتی یعنی اجاره‌ای که گرفته‌ایم؛ نام حساب درآمدش «درآمد
 * اجاره» است. بدون این، درآمد در حسابی با نام هزینه می‌نشست.
 */
export function sideCategory(category, direction) {
  const name = String(category || '').trim();
  if (!name) return null;
  if (direction === 'receivable' && name === 'اجاره') return 'درآمد اجاره';
  return name;
}

/**
 * واقعیت‌های خدمت دوره‌دار یک سند پایه.
 *
 * دورهٔ صریحِ سند (فیلد فرم یا API) بر خواندن متن مقدم است. خواندن متن نسبت به
 * تاریخ خودِ سند است، نه امروز: «اجاره شش ماه آینده» در چکِ مهر از مهر شروع
 * می‌شود.
 */
export function readDocumentService(input, { direction, occurredAt, category = null, servicePeriodStart = null, servicePeriodEnd = null, refundable = null } = {}) {
  const text = normalizePersian(input);
  const resolvedCategory = sideCategory(category, direction) || documentCategory(text, direction);
  const period = servicePeriodStart && servicePeriodEnd
    ? { start: servicePeriodStart, end: servicePeriodEnd }
    : (text && occurredAt ? readServicePeriod(text, { occurredAt }) : null);
  return {
    category: resolvedCategory,
    servicePeriodStart: period?.start || null,
    servicePeriodEnd: period?.end || null,
    refundable: typeof refundable === 'boolean' ? refundable : (text ? saysRefundable(text) : null),
  };
}

/** دسته‌ای که خدمت دوره‌دار است — هزینه یا درآمدش. */
export function isTimeBoundCategory(category) {
  const name = String(category || '').trim();
  return TIME_BOUND_SERVICE_CATEGORIES.includes(name) || name === 'درآمد اجاره';
}

const DOCUMENT_SERVICE_POLICIES = Object.freeze(['prepaid-service-on-account', 'deferred-revenue-on-account']);
/** برخوردهایی که سندشان را نقشهٔ موتور می‌زند و برنامهٔ شناسایی دارند. */
export const ENGINE_POSTED_TREATMENTS = Object.freeze([TREATMENTS.PREPAID_EXPENSE, TREATMENTS.DEFERRED_REVENUE, TREATMENTS.REFUNDABLE_DEPOSIT]);

/**
 * تصمیم موتور برای سند پایه، فقط وقتی سند خدمت دوره‌دار است.
 *
 * چکِ کالا یا فروشِ ساده همان مسیر جاافتادهٔ خودش را می‌رود (`null`)؛ ولی سندی
 * که دسته‌اش دوره‌دار است یا دوره‌ای گفته، هر چه موتور بگوید همان است — حتی
 * «به حسابدار» از یک بررسی پیشین (باقیِ قرارداد، قضاوت) — و هرگز به هزینه یا
 * درآمد یک‌جا برنمی‌گردد.
 */
export function documentServiceDecision(event, { today = null } = {}) {
  const decision = decide(factsFromEvent(event), { today: today || new Date().toISOString() });
  if (DOCUMENT_SERVICE_POLICIES.includes(decision.policyKey)) return decision;
  const candidate = isTimeBoundCategory(event?.category) || Boolean(event?.servicePeriodStart && event?.servicePeriodEnd);
  return candidate && decision.decisionStatus !== DECISION_STATUS.DECIDED ? decision : null;
}

/**
 * مسیرِ رویدادِ سند پایه از روی تصمیم.
 *
 * فرم و کارت تأیید را کاربر خودش ذخیره کرده؛ تصمیم قطعی همان‌جا ثبت می‌شود.
 * واقعیتِ کم سؤال است (در انتظار کاربر) و هر چیز دیگری با حسابدار.
 */
export function documentRouting(decision) {
  if (decision.decisionStatus === DECISION_STATUS.DECIDED) return { route: ROUTES.AUTO, reasons: [] };
  if (decision.decisionStatus === DECISION_STATUS.NEEDS_USER_INPUT) {
    return { route: ROUTES.CONFIRM, reasons: [decision.question?.text || decision.explanation].filter(Boolean) };
  }
  return { route: ROUTES.ACCOUNTANT_REVIEW, reasons: [decision.explanation || 'ماهیت این سند قضاوت حسابدار لازم دارد.'] };
}
