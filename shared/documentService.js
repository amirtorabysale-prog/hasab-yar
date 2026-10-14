import { DECISION_STATUS, decide } from './accountingDecision.js';
import { factsFromEvent } from './eventFacts.js';
import { TREATMENTS } from './factRequirements.js';
import { ROUTES } from './confidenceEngine.js';
import { isTimeBoundService } from './economicFamily.js';
import { isTimeBoundCategory } from './documentReading.js';
import { persianMonthRange, todayPersian } from './persianDate.js';

// خواننده‌ها در فایل سبک خودشان‌اند تا کارت صوتی (سمت کاربر) بی‌آنکه موتور
// تصمیم را بار کند، همان دسته و دوره را بخواند که سرور.
export { documentCategory, isTimeBoundCategory, readDocumentService, sideCategory } from './documentReading.js';

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
  const facts = factsFromEvent(event);
  const decision = decide(facts, { today: today || new Date().toISOString() });
  if (DOCUMENT_SERVICE_POLICIES.includes(decision.policyKey)) return decision;
  // «بیمه تأمین اجتماعی مهر» در دستهٔ بیمه است ولی حق‌بیمهٔ دوره‌دار نیست؛
  // همان استثنایی که مسیر نقدی دارد، تا سندش به حسابدار نرود و همان هزینهٔ
  // جاافتاده بماند.
  const timeBound = isTimeBoundCategory(event?.category) && (String(event?.category).trim() === 'درآمد اجاره' || isTimeBoundService(facts));
  // دوره‌ای که در ماهِ خودِ سند یا پیش از آن تمام شده چیزی را به ماه‌های بعد
  // نمی‌برد: «اشتراک مهر» یا «پشتیبانی شهریور» فروش یا هزینهٔ همان دوره است و
  // ردیف دستهٔ خودش را نگه می‌دارد — نه پیش‌دریافت، نه صف حسابدار. ودیعه و
  // سپرده استثناست: بدهی/دارایی است و هنوز تصمیم موتور را می‌خواهد.
  const period = Boolean(event?.servicePeriodStart && event?.servicePeriodEnd);
  if (!timeBound && period && !runsPastDocumentMonth(event) && !saysDeposit(event)) return null;
  const candidate = timeBound || period;
  return candidate && decision.decisionStatus !== DECISION_STATUS.DECIDED ? decision : null;
}

const DEPOSIT_WORDS = /ودیعه|رهن|قرض\s*الحسنه|سپرده|تضمین|حسن\s*انجام/;
function saysDeposit(event) {
  if (event?.refundable === true || event?.paymentPurpose === 'deposit') return true;
  return DEPOSIT_WORDS.test(`${event?.evidence || ''} ${event?.utterance || ''} ${event?.description || ''}`);
}

/** آیا پایان دوره از ماهِ (شمسیِ) تاریخ سند جلوتر است؟ */
function runsPastDocumentMonth(event) {
  const at = new Date(event?.occurredAt || '');
  const end = new Date(event?.servicePeriodEnd || '');
  if (Number.isNaN(at.getTime()) || Number.isNaN(end.getTime())) return true;
  const day = todayPersian(at);
  const month = persianMonthRange(day.year, day.month);
  return end.getTime() > new Date(month.to).getTime();
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
