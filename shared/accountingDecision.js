/**
 * تصمیم حسابداری — ایستگاهی که مسیر امروز ندارد.
 *
 * چرا این لایه وجود دارد:
 *
 * امروز رویداد مستقیم به `planJournal` می‌رسد و نوعِ رویداد هم‌زمان می‌گوید «چه
 * اتفاقی افتاد» و «چه سندی بخورد». نتیجه‌اش این است که اگر بالادست بفهمد یک
 * پرداخت در واقع پیش‌پرداخت است، جایی برای گفتنش وجود ندارد.
 *
 * تصمیم، همان جای خالی است: می‌گوید این رویداد در کدام خانواده است، چطور و
 * کِی شناسایی می‌شود، با کدام نسخهٔ قاعده، چه چیزی کم دارد، و چرا خودکار نشد.
 *
 * قاعدهٔ سخت: هیچ `PostingPlan` بدون یک تصمیم معتبر و نسخه‌دار ساخته نمی‌شود.
 */

import {
  ECONOMIC_FAMILIES, FAMILY_DEFAULT_RISK, FAMILY_UNKNOWN, RISK_LEVELS, TIME_BOUND_SERVICE_CATEGORIES,
  classifyFamily, isEconomicFamily, isTimeBoundService,
} from './economicFamily.js';
import {
  FACT_KEYS, FACT_LABELS, TREATMENTS, isFactPresent, missingFactsFor, nextQuestionFor, requiredFactsFor,
} from './factRequirements.js';
import {
  EVENT_NATURES, NATURE_EXPLANATIONS, natureAffectsPast, natureNeedsAccountant,
} from './eventNature.js';
import { needsJudgment as purchaseNeedsJudgment, needsPurchasePurpose } from './purchasePurpose.js';
import { persianMonthRange, todayPersian } from './persianDate.js';

function persianMonthOf(iso) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const day = todayPersian(parsed);
  return persianMonthRange(day.year, day.month);
}
import { judgmentReason } from './moneyPurpose.js';

/**
 * پنج وضعیت.
 *
 * تفاوت `needs-user-input` و `needs-accountant-review` تفاوت «یک چیز را
 * نمی‌دانیم» با «قضاوت لازم است» است. اولی با یک سؤال حل می‌شود و کاربر عادی
 * می‌تواند جوابش را بدهد؛ دومی حتی با دادهٔ کامل هم به حسابدار می‌رود.
 *
 * `unsupported` یعنی خانواده شناخته شده ولی قاعدهٔ ثبتش هنوز ساخته نشده —
 * وضعیت یازده خانواده در همین فاز. `blocked` یعنی یک مانع ساختاری جلویش را
 * گرفته؛ در WP-1 که نگهبان‌ها اضافه می‌شوند پر می‌شود.
 */
export const DECISION_STATUS = Object.freeze({
  DECIDED: 'decided',
  NEEDS_USER_INPUT: 'needs-user-input',
  NEEDS_ACCOUNTANT_REVIEW: 'needs-accountant-review',
  UNSUPPORTED: 'unsupported',
  BLOCKED: 'blocked',
});

const STATUS_VALUES = Object.freeze(Object.values(DECISION_STATUS));

export function isDecisionStatus(value) { return STATUS_VALUES.includes(value); }

/** چرا این مورد اینجاست — به زبان حسابدار، نه نام فنی وضعیت. */
export const DECISION_STATUS_LABELS = Object.freeze({
  [DECISION_STATUS.DECIDED]: 'تصمیم گرفته شد',
  [DECISION_STATUS.NEEDS_USER_INPUT]: 'یک سؤال باقی مانده',
  [DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW]: 'نیازمند بررسی حسابدار',
  [DECISION_STATUS.UNSUPPORTED]: 'قاعده‌ای برای این ماهیت تعریف نشده',
  [DECISION_STATUS.BLOCKED]: 'مانع ساختاری',
});

/**
 * روش شناسایی.
 *
 * `monthly-straight-line` تنها مقدار مصوب نسخهٔ اول است
 * (`docs/wp0-open-decisions.md`، تصمیم ۲). `daily` عمداً اینجا نام دارد ولی
 * پیاده‌سازی نمی‌شود: افزودنش بعداً باید یک قاعدهٔ تازه باشد، نه یک تغییر ساختار.
 */
export const RECOGNITION_METHODS = Object.freeze({
  IMMEDIATE: 'immediate',
  MONTHLY_STRAIGHT_LINE: 'monthly-straight-line',
  DAILY: 'daily',
});

/**
 * شکل تصمیم.
 *
 * هر فیلد یک سؤال را جواب می‌دهد که حسابدار در صف بررسی می‌پرسد:
 *
 * - `family` و `treatment` — این چیست و چطور با آن برخورد شد؟
 * - `policyKey` و `policyVersion` — بر اساس کدام قاعده، و کدام نسخه‌اش؟
 * - `recognitionDate` و `recognitionMethod` — کِی و چطور شناسایی می‌شود؟
 * - `requiredFacts` و `missingFacts` — چه چیزی لازم بود و چه چیزی نبود؟
 * - `assumptions` — چه چیزی فرض شد که در متن نبود؟
 * - `riskLevel` — چرا خودکار نشد؟
 * - `explanation` — به زبان آدمیزاد، بدون بدهکار و بستانکار.
 * - `sourceReferences` — از کدام گفته یا مدرک آمد؟
 * - `decisionStatus` — الان در چه حالی است؟
 *
 * تصمیم بعد از ساخته شدن قفل است. تغییر تصمیم یعنی تصمیم تازه با ارجاع به قبلی،
 * نه ویرایش همان شیء — وگرنه تاریخچه دروغ می‌گوید.
 */
export function createDecision(values = {}) {
  const family = isEconomicFamily(values.family) ? values.family : FAMILY_UNKNOWN;
  const decisionStatus = isDecisionStatus(values.decisionStatus) ? values.decisionStatus : DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW;
  return Object.freeze({
    family,
    treatment: values.treatment || null,
    policyKey: values.policyKey || null,
    policyVersion: values.policyVersion || null,
    recognitionDate: values.recognitionDate || null,
    recognitionMethod: values.recognitionMethod || null,
    requiredFacts: Object.freeze([...(values.requiredFacts || [])]),
    missingFacts: Object.freeze([...(values.missingFacts || [])]),
    assumptions: Object.freeze([...(values.assumptions || [])]),
    riskLevel: values.riskLevel || RISK_LEVELS.RED,
    explanation: values.explanation || '',
    sourceReferences: Object.freeze([...(values.sourceReferences || [])]),
    decisionStatus,
    question: values.question || null,
  });
}

/**
 * آیا این تصمیم اجازهٔ ساختن سند می‌دهد؟
 *
 * تنها `decided` اجازه می‌دهد. این تابع عمداً کوچک و صریح است تا هیچ‌جا لازم
 * نباشد کسی خودش وضعیت‌ها را مقایسه کند و یکی را جا بیندازد.
 */
export function decisionAuthorizesPosting(decision) {
  return Boolean(decision) && decision.decisionStatus === DECISION_STATUS.DECIDED;
}

/**
 * سندِ پایه‌ای که پولی جابه‌جا نمی‌کند و طرفش ماییم یا طرف مقابل.
 *
 * چکی که بابت طلب یا بدهی قبلی است فقط شکل تعهد را عوض می‌کند و برآوردی
 * («برآورد شد») قضاوت حسابدار است؛ هیچ‌کدام خدمت تازه نیستند.
 */
function onAccount(facts, side) {
  if (facts?.moneyDirection !== 'none' || isFactPresent(facts?.estimateBasis)) return false;
  if (facts?.chequeAgainst === 'receivable') return false;
  return facts?.obligationDirection === side || facts?.chequeDirection === side;
}

/** دوره‌ای که از ماهِ خودِ سند جلوتر می‌رود — یعنی چیزی را به ماه‌های بعد می‌برد. */
function coverageRunsPastMonth(facts) {
  const end = facts?.servicePeriodEnd;
  if (!isFactPresent(facts?.servicePeriodStart) || !isFactPresent(end) || !facts?.occurredAt) return false;
  const month = persianMonthOf(facts.occurredAt);
  return Boolean(month) && new Date(end).getTime() > new Date(month.to).getTime();
}

/** دستهٔ درآمدی که خودش دوره‌دار است: اجاره‌ای که می‌گیریم. */
const TIME_BOUND_INCOME_CATEGORIES = Object.freeze(['درآمد اجاره']);
const DEPOSIT_WORDS = /ودیعه|رهن|قرض\s*الحسنه|سپرده|تضمین|حسن\s*انجام/;
const policyByKey = (key) => DEFAULT_POLICIES.find((policy) => policy.policyKey === key);

/**
 * قاعده‌ها، به‌صورت داده.
 *
 * چرا قاعده لازم است و طبقه‌بند کافی نیست: طبقه‌بند می‌گوید «این ایجاد دارایی
 * است»، ولی نمی‌گوید پیش‌پرداخت است یا موجودی یا دارایی ثابت. آن تشخیص از روی
 * واژه‌های جمله درنمی‌آید — از سیاست دفتر درمی‌آید.
 *
 * مثال مشخص: اینکه «بیمه» یک خدمت دوره‌دار است و پرداختش پیش‌پرداخت می‌سازد،
 * یک قاعدهٔ حسابداری است که حسابدار تأیید می‌کند، نه حدسی که مدل زبانی می‌زند.
 * مدل فقط می‌گوید دسته «بیمه» بود؛ اینکه آن دسته چه معنایی دارد اینجا نوشته
 * می‌شود.
 *
 * `version` اینجا هست ولی انتخاب بر اساس تاریخ رویداد در WP-2 اضافه می‌شود.
 * فعلاً فقط ذخیره می‌شود تا تصمیم بدون نسخه ساخته نشود.
 */
export const DEFAULT_POLICIES = Object.freeze([
  /**
   * خدمت دوره‌دار روی سندِ پایه‌ای که پولی جابه‌جا نمی‌کند — چک پرداختی، بدهی،
   * فاکتور خرید.
   *
   * «اجارهٔ یک‌ساله دفتر رو با چک ۱۲۰ میلیون دادیم» همان پیش‌پرداختی است که با
   * نقد می‌شد؛ ابزار پرداخت ماهیت را عوض نمی‌کند. بی‌این قاعده چک پرداختی اصلاً
   * قاعده نداشت و بدهیِ «اشتراک یک‌ساله» زیر قاعدهٔ هزینهٔ تعهدی کل مبلغ را
   * همین ماه هزینه می‌کرد. پس همان حل‌وفصلِ پیش‌پرداخت خدمت اجرا می‌شود: دورهٔ
   * آینده → پیش‌پرداخت با شناسایی ماهانه؛ دورهٔ گذشته یا همین ماه → هزینهٔ دوره؛
   * ودیعه → سؤال استرداد؛ دورهٔ نامعلوم → سؤال، نه حدس. طرف بستانکار را قاعدهٔ
   * سند از نوع رویداد می‌گیرد (اسناد پرداختنی یا حساب پرداختنی)، نه صندوق.
   *
   * قبضِ مصرف‌شده («قبض برق شهریور هنوز پرداخت نشده») اینجا نمی‌رسد: نه دستهٔ
   * دوره‌دار دارد و نه دوره‌ای که از ماه سند بگذرد؛ همان هزینهٔ تعهدی می‌ماند.
   */
  Object.freeze({
    policyKey: 'prepaid-service-on-account',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.LIABILITY_CREATION,
    riskLevel: RISK_LEVELS.YELLOW,
    supportedTreatments: Object.freeze([TREATMENTS.PREPAID_EXPENSE, TREATMENTS.PERIOD_EXPENSE, TREATMENTS.REFUNDABLE_DEPOSIT]),
    appliesTo(facts) {
      if (!onAccount(facts, 'payable')) return false;
      if (isTimeBoundService(facts) || facts?.refundable === true || facts?.paymentPurpose === 'deposit') return true;
      return coverageRunsPastMonth(facts);
    },
    resolve(facts, context) { return policyByKey('prepaid-service').resolve(facts, context); },
  }),
  /**
   * آینه‌اش: خدمت دوره‌دار روی چک دریافتی، طلب یا فاکتور فروش — پیش‌دریافت.
   *
   * «چک ۶۰ میلیونی اجارهٔ شش ماه آینده رو از مستاجر گرفتیم» شش ماه درآمد آینده
   * است، نه فروش امروز. درآمد ماه‌به‌ماه شناسایی می‌شود و تا آن موقع درآمد
   * انتقالی (بدهی) است. ودیعهٔ مستاجر هرگز درآمد نیست و حسابش با حسابدار است؛
   * دورهٔ نامعلوم پرسیده می‌شود. فروش کالا و خدمتِ بی‌دوره اینجا نمی‌رسند.
   */
  Object.freeze({
    policyKey: 'deferred-revenue-on-account',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.RECEIVABLE_CREATION,
    riskLevel: RISK_LEVELS.YELLOW,
    supportedTreatments: Object.freeze([TREATMENTS.DEFERRED_REVENUE, TREATMENTS.RECOGNIZED_REVENUE]),
    appliesTo(facts) {
      if (!onAccount(facts, 'receivable') || isFactPresent(facts?.deliveryDate)) return false;
      // «بابت فروش تازه یا طلب قبلی؟» پیش از هر چیز؛ آن را قاعدهٔ چک دریافتی می‌پرسد.
      if (facts?.chequeDirection === 'receivable' && facts?.chequeAgainst !== 'income') return false;
      if (TIME_BOUND_INCOME_CATEGORIES.includes(String(facts?.category || '').trim()) || isTimeBoundService(facts)) return true;
      if (facts?.refundable === true || facts?.paymentPurpose === 'deposit') return true;
      return coverageRunsPastMonth(facts);
    },
    resolve(facts, { today }) {
      const said = `${facts?.evidence || ''} ${facts?.utterance || ''}`;
      if (facts?.refundable === true || facts?.paymentPurpose === 'deposit' || (DEPOSIT_WORDS.test(said) && facts?.refundable !== false)) {
        return { treatment: TREATMENTS.REFUNDABLE_DEPOSIT, reviewNote: 'ودیعه یا سپرده‌ای که گرفته‌ایم بدهی ماست، نه درآمد؛ حساب ودیعهٔ دریافتی و شرط استردادش را حسابدار تعیین می‌کند.' };
      }
      const start = facts?.servicePeriodStart;
      const end = facts?.servicePeriodEnd;
      if (!isFactPresent(start) || !isFactPresent(end)) return { treatment: TREATMENTS.DEFERRED_REVENUE };
      const immediate = { treatment: TREATMENTS.RECOGNIZED_REVENUE, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts.occurredAt || null };
      if (new Date(end).getTime() <= new Date(today).getTime()) return immediate;
      if (!coverageRunsPastMonth(facts)) return immediate;
      return { treatment: TREATMENTS.DEFERRED_REVENUE, recognitionMethod: RECOGNITION_METHODS.MONTHLY_STRAIGHT_LINE, recognitionDate: start };
    },
  }),
  /**
   * خرید نسیهٔ کالا.
   *
   * «سی میلیون کالا برای فروش نسیه خریدیم» پولی جابه‌جا نکرده ولی هم موجودی
   * ساخته و هم بدهی. تا امروز به صف حسابدار می‌رفت چون قاعدهٔ بدهی فقط قبض و
   * خدمت می‌شناخت. هدف خرید همان سؤالی است که خرید نقدی هم می‌پرسد.
   *
   * پیش از قاعدهٔ هزینهٔ تعهدی می‌نشیند: هر دو خانوادهٔ «ایجاد بدهی»اند و در
   * نسخهٔ برابر، اولی برنده است.
   */
  Object.freeze({
    policyKey: 'goods-on-credit',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.LIABILITY_CREATION,
    riskLevel: RISK_LEVELS.YELLOW,
    supportedTreatments: Object.freeze([TREATMENTS.INVENTORY_PURCHASE, TREATMENTS.ACCRUED_EXPENSE]),
    appliesTo(facts) {
      return facts?.moneyDirection === 'none' && facts?.obligationDirection === 'payable' && !facts?.chequeDirection
        && (isFactPresent(facts?.intendedUse) || String(facts?.category || '').trim() === 'مواد و کالا');
    },
    resolve(facts) {
      if (!isFactPresent(facts?.intendedUse)) return { treatment: TREATMENTS.INVENTORY_PURCHASE, extraFacts: [FACT_KEYS.INTENDED_USE] };
      if (['resale', 'production'].includes(facts.intendedUse)) {
        return {
          treatment: TREATMENTS.INVENTORY_PURCHASE, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts.occurredAt || null,
          assumptions: ['نام و تعداد اقلام در کارت کالا بعداً تفکیک می‌شود؛ ارزش خرید همین حالا در موجودی می‌نشیند.'],
        };
      }
      const threshold = facts?.capitalizationThreshold;
      if (facts.intendedUse === 'long-term-use' && !(Number.isSafeInteger(threshold) && Number(facts?.amount) < threshold)) {
        return { treatment: TREATMENTS.FIXED_ASSET, reviewNote: 'کالای ماندگار و هم‌اندازه یا بالاتر از حد سرمایه‌ای شدن دفتر است؛ دارایی ثابت با عمر مفید را حسابدار ثبت می‌کند.' };
      }
      return { treatment: TREATMENTS.ACCRUED_EXPENSE, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts.occurredAt || null };
    },
  }),
  /**
   * جهت ب — مصرف پیش از پرداخت.
   *
   * قبض اسفند در **اسفند** هزینه است، نه در فروردین که پرداخت می‌شود. بدون
   * این، هزینه در دورهٔ اشتباه می‌نشیند و سود هر دو دوره غلط می‌شود.
   *
   * مبلغ برآوردی همیشه به حسابدار می‌رود: برآورد قضاوت است، نه واقعیت.
   */
  Object.freeze({
    policyKey: 'accrued-expense',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.LIABILITY_CREATION,
    riskLevel: RISK_LEVELS.YELLOW,
    supportedTreatments: Object.freeze([TREATMENTS.ACCRUED_EXPENSE]),
    /**
     * فقط خدمت و مصرفی که همان دوره تمام می‌شود.
     *
     * «پرداخت‌نشده» به‌تنهایی نمی‌گوید چه چیزی خریده شده. پیش از این هر بدهیِ
     * بی‌پرداخت هزینه می‌شد: میز و صندلیِ نسیه، ساخت سوله، سود وام. در آزمون
     * استرس همهٔ این‌ها «تصمیم قطعی» گرفتند و همه غلط بودند — دارایی یا
     * تسهیلات، نه هزینهٔ دوره. بیرون از این فهرست، قاعده‌ای نیست و مورد به
     * حسابدار می‌رود.
     */
    categories: Object.freeze([
      'قبوض', 'اجاره', 'حمل‌ونقل', 'سوخت و ایاب‌وذهاب', 'تبلیغات و بازاریابی',
      'نرم‌افزار و اشتراک', 'کارمزد بانکی', 'تعمیر و نگهداری', 'خوراک', 'آموزش',
    ]),
    appliesTo(facts) {
      return facts?.moneyDirection === 'none' && !facts?.chequeDirection
        && this.categories.includes(String(facts?.category || '').trim());
    },
    resolve(facts) {
      return {
        treatment: TREATMENTS.ACCRUED_EXPENSE,
        recognitionMethod: RECOGNITION_METHODS.IMMEDIATE,
        recognitionDate: facts?.servicePeriodEnd || facts?.occurredAt || null,
        // برآورد، قضاوت است. حتی با طرف حساب و دورهٔ روشن، حسابدار باید ببیند.
        forceReview: isFactPresent(facts?.estimateBasis),
      };
    },
  }),

  /**
   * وام دریافتی — بدهی، نه درآمد.
   *
   * دستهٔ «سایر درآمدها» همان دسته‌ای است که وام هم می‌گیرد؛ بدون این قاعده،
   * دویست میلیون وام یا به صف حسابدار می‌رفت یا — بدتر — درآمد می‌شد.
   */
  Object.freeze({
    policyKey: 'loan-received',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.LIABILITY_CREATION,
    riskLevel: RISK_LEVELS.YELLOW,
    supportedTreatments: Object.freeze([TREATMENTS.LOAN_RECEIVED]),
    appliesTo(facts) { return facts?.moneyDirection === 'in' && facts?.receiptPurpose === 'loan'; },
    resolve(facts) {
      return { treatment: TREATMENTS.LOAN_RECEIVED, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts?.occurredAt || null };
    },
  }),
  /**
   * واریزی که منشأش معلوم نیست.
   *
   * نبودِ طرف حساب اینجا کمبود نیست، تعریفِ همین رویداد است؛ پرسیدن «طرف
   * حساب کیست؟» از کسی که همین حالا گفته نمی‌داند، سؤال بی‌جواب است.
   */
  Object.freeze({
    policyKey: 'unidentified-receipt',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.LIABILITY_CREATION,
    riskLevel: RISK_LEVELS.YELLOW,
    supportedTreatments: Object.freeze([TREATMENTS.UNIDENTIFIED_RECEIPT]),
    waivesFamilyFacts: Object.freeze([FACT_KEYS.COUNTERPARTY]),
    appliesTo(facts) { return facts?.moneyDirection === 'in' && facts?.receiptPurpose === 'unknown'; },
    resolve(facts) {
      return { treatment: TREATMENTS.UNIDENTIFIED_RECEIPT, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts?.occurredAt || null };
    },
  }),
  /**
   * فروش یا خدمتی که همین حالا انجام شد و پولش آمد.
   *
   * ساده‌ترین دریافت روز. تا امروز به صف حسابدار می‌رفت چون تنها قاعدهٔ درآمد
   * تاریخ تحویل جدا می‌خواست. نقشهٔ سندش همان نقشهٔ همیشگیِ دریافت است.
   */
  Object.freeze({
    policyKey: 'revenue-at-receipt',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.REVENUE_RECOGNITION,
    riskLevel: RISK_LEVELS.GREEN,
    supportedTreatments: Object.freeze([TREATMENTS.RECOGNIZED_REVENUE]),
    appliesTo(facts) { return facts?.moneyDirection === 'in'; },
    resolve(facts) {
      return { treatment: TREATMENTS.RECOGNIZED_REVENUE, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts?.deliveryDate || facts?.occurredAt || null };
    },
  }),
  /**
   * آورده و برداشت مالک.
   *
   * پولی که مالک می‌گذارد و برنمی‌دارد سرمایه است؛ پولی که برای خودش برمی‌دارد
   * و برنمی‌گرداند برداشت. هیچ‌کدام درآمد یا هزینه نیست. اگر قرار است پس داده
   * شود، قرض شریک است و جای آن جاری شرکاست — که حسابدار ثبت می‌کند.
   */
  Object.freeze({
    policyKey: 'owner-capital-movement',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.OWNER_CAPITAL_MOVEMENT,
    riskLevel: RISK_LEVELS.YELLOW,
    supportedTreatments: Object.freeze([TREATMENTS.OWNER_CAPITAL, TREATMENTS.OWNER_DRAWING]),
    appliesTo(facts) { return ['in', 'out'].includes(facts?.moneyDirection); },
    resolve(facts) {
      if (facts?.refundable === true) {
        return { treatment: null, reviewNote: 'پول مالک یا شریک که برمی‌گردد، قرض است و در جاری شرکا ثبت می‌شود؛ حسابدار ثبتش می‌کند.' };
      }
      return facts.moneyDirection === 'in'
        ? { treatment: TREATMENTS.OWNER_CAPITAL, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts?.occurredAt || null }
        : { treatment: TREATMENTS.OWNER_DRAWING, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts?.occurredAt || null };
    },
  }),
  /**
   * جهت ج — دریافت پیش از انجام تعهد.
   *
   * بدترین خطای این جهت، درآمد جعلی است: هم سود را باد می‌کند و هم مالیات
   * می‌سازد، در حالی که هنوز هیچ کاری انجام نشده. پس هیچ سطر درآمدی ساخته
   * نمی‌شود.
   *
   * بدون دورهٔ خدمت، پخش کردن ممکن نیست و حدس زدنش همان خطای پیش‌پرداخت است؛
   * پس فقط بدهی ثبت می‌شود و برنامه‌ای در کار نیست.
   */
  Object.freeze({
    policyKey: 'advance-received',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.ADVANCE_RECEIVED,
    riskLevel: RISK_LEVELS.YELLOW,
    supportedTreatments: Object.freeze([TREATMENTS.CUSTOMER_ADVANCE, TREATMENTS.DEFERRED_REVENUE]),
    appliesTo() { return true; },
    resolve(facts) {
      const hasPeriod = isFactPresent(facts?.servicePeriodStart) && isFactPresent(facts?.servicePeriodEnd);
      return hasPeriod
        ? {
          treatment: TREATMENTS.DEFERRED_REVENUE,
          recognitionMethod: RECOGNITION_METHODS.MONTHLY_STRAIGHT_LINE,
          recognitionDate: facts.servicePeriodStart,
        }
        : { treatment: TREATMENTS.CUSTOMER_ADVANCE };
    },
  }),

  /**
   * جهت د — انجام تعهد پیش از دریافت.
   *
   * کار تحویل شده و پولی نیامده: درآمد همان‌جا شناسایی می‌شود و طلب ساخته
   * می‌شود. به تاریخ تحویل تکیه می‌کند، نه به تاریخ فاکتور.
   */
  Object.freeze({
    policyKey: 'accrued-revenue',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.RECEIVABLE_CREATION,
    riskLevel: RISK_LEVELS.YELLOW,
    supportedTreatments: Object.freeze([TREATMENTS.ACCRUED_REVENUE]),
    appliesTo(facts) { return isFactPresent(facts?.deliveryDate) && !facts?.chequeDirection; },
    resolve(facts) {
      return {
        treatment: TREATMENTS.ACCRUED_REVENUE,
        recognitionMethod: RECOGNITION_METHODS.IMMEDIATE,
        recognitionDate: facts.deliveryDate,
      };
    },
  }),
  /**
   * پیش‌پرداخت به تأمین‌کننده.
   *
   * «صد و بیست میلیون پیش‌پیش ریختیم واسه خرید ورق» تا امروز ماهیتش «نامشخص»
   * می‌شد. پول رفته، ولی هیچ چیزی بابتش نگرفته‌ایم — این دارایی است نه هزینه.
   *
   * ثبتش ساده است — پیش‌پرداخت خرید به تفکیک تأمین‌کننده در برابر بانک — و
   * فقط نام تأمین‌کننده را لازم دارد. تسویه‌اش با فاکتوری که بعداً می‌آید، کار
   * نگهبان تسویه است و این سند را دست نمی‌زند.
   */
  /**
   * مساعدهٔ کارمند.
   *
   * «۵ میلیون به آقای کاظمی مساعده دادیم که از حقوق آبانش کم کنیم» به صف حقوق
   * می‌رفت، چون دسته‌اش «حقوق» بود. حقوق نیست: طلب شرکت از همان کارمند است و
   * با حقوق بعدی تسویه می‌شود. نام کارمند لازم است تا ماندهٔ هر نفر جدا بماند.
   */
  Object.freeze({
    policyKey: 'employee-advance',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.ASSET_CREATION,
    riskLevel: RISK_LEVELS.YELLOW,
    supportedTreatments: Object.freeze([TREATMENTS.EMPLOYEE_ADVANCE]),
    appliesTo(facts) { return facts?.paymentPurpose === 'employee-advance'; },
    resolve() { return { treatment: TREATMENTS.EMPLOYEE_ADVANCE }; },
  }),
  Object.freeze({
    policyKey: 'supplier-advance',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.ASSET_CREATION,
    riskLevel: RISK_LEVELS.YELLOW,
    supportedTreatments: Object.freeze([TREATMENTS.SUPPLIER_ADVANCE]),
    appliesTo(facts) {
      // خدمت دوره‌دار سیاست خودش را دارد و آنجا قاعدهٔ ثبت هم هست.
      return (facts?.prepaymentSignal === true || facts?.paymentPurpose === 'advance')
        && !TIME_BOUND_SERVICE_CATEGORIES.includes(String(facts?.category || '').trim());
    },
    resolve() { return { treatment: TREATMENTS.SUPPLIER_ADVANCE }; },
  }),
  Object.freeze({
    policyKey: 'cheque-received',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.RECEIVABLE_CREATION,
    riskLevel: RISK_LEVELS.YELLOW,
    supportedTreatments: Object.freeze([TREATMENTS.RECOGNIZED_REVENUE, TREATMENTS.CHEQUE_FORM_CHANGE]),
    appliesTo(facts) { return facts?.chequeDirection === 'receivable'; },
    /**
     * تنها سؤال این خانواده همان سؤالی است که فرم می‌پرسد و صدا نمی‌پرسید.
     * بدون جوابش، پیش‌فرض ناامنِ «فروش تازه» اجرا می‌شد.
     */
    resolve(facts) {
      if (facts?.chequeAgainst !== 'income' && facts?.chequeAgainst !== 'receivable') {
        return { treatment: TREATMENTS.RECOGNIZED_REVENUE, extraFacts: [FACT_KEYS.CHEQUE_AGAINST] };
      }
      return facts.chequeAgainst === 'receivable'
        ? { treatment: TREATMENTS.CHEQUE_FORM_CHANGE, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts.occurredAt || null }
        : { treatment: TREATMENTS.RECOGNIZED_REVENUE, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts.occurredAt || null };
    },
  }),
  Object.freeze({
    policyKey: 'prepaid-service',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.ASSET_CREATION,
    riskLevel: RISK_LEVELS.YELLOW,
    /**
     * دسته‌هایی که خدمت دوره‌دار می‌سازند.
     *
     * این فهرست سیاست دفتر است و حسابدار تأییدش می‌کند — نه حدسی که مدل زبانی
     * می‌زند. مدل فقط می‌گوید دسته «بیمه» بود؛ اینکه بیمه یک خدمت دوره‌دار است
     * و پرداختش دارایی می‌سازد، اینجا نوشته شده و قابل آزمون است.
     */
    categories: TIME_BOUND_SERVICE_CATEGORIES,
    /**
     * دسته‌هایی که پرداختشان می‌تواند مصرف‌شدنی باشد یا قابل استرداد.
     *
     * «بیست میلیون ودیعهٔ دفتر رو دادم» و «اجارهٔ سه ماه رو جلوجلو دادم» هر دو
     * دستهٔ اجاره‌اند و هر دو پول خارج‌شده — ولی اولی هیچ‌وقت هزینه نمی‌شود و
     * دومی ماه‌به‌ماه می‌شود. پرسیدن «دورهٔ پوشش» از ودیعه، سؤال غلط از رویداد
     * درست است.
     *
     * بیمه و اشتراک و پشتیبانی اینجا نیستند چون ذاتاً مصرف‌شدنی‌اند؛ پرسیدن
     * استرداد از آن‌ها فقط یک سؤال اضافه است.
     */
    ambiguousRefundability: Object.freeze(['اجاره']),
    /** برخوردهایی که در این فاز قاعدهٔ ثبت دارند. بقیه به حسابدار می‌روند. */
    supportedTreatments: Object.freeze([TREATMENTS.PREPAID_EXPENSE, TREATMENTS.PERIOD_EXPENSE, TREATMENTS.REFUNDABLE_DEPOSIT]),
    /**
     * دسته یکی از دو راه ورود است، نه تنها راه.
     *
     * ودیعه‌ای که ثبت‌کننده خودش گفته برمی‌گردد هم همین‌جا می‌رسد، با هر دسته‌ای.
     *
     * «پونزده میلیون شارژ ساختمان رو برای شش ماه جلوتر تسویه کردم» دسته‌اش
     * «قبوض» است و در فهرست خدمات دوره‌دار نیست — ولی خودِ جمله دوره را گفته.
     * وقتی دوره صریح است، دیگر نیازی به حدس از روی دسته نیست.
     */
    appliesTo(facts) {
      if (isTimeBoundService(facts)) return true;
      if (facts?.refundable === true || facts?.paymentPurpose === 'deposit') return true;
      return isFactPresent(facts?.servicePeriodStart) && isFactPresent(facts?.servicePeriodEnd);
    },
    /**
     * دوره‌ای که کاملاً گذشته، دارایی نمی‌سازد.
     *
     * پیش‌پرداختی که منفعت آینده ندارد، دارایی نیست — همان لحظه هزینهٔ دوره
     * است. ساختن دارایی و بعد مستهلک کردنش در گذشته، فقط سند اضافه می‌سازد.
     */
    resolve(facts, { today }) {
      const category = String(facts?.category || '').trim();
      // استرداد پیش از دوره پرسیده می‌شود، چون جوابش برخورد را عوض می‌کند و
      // پرسیدن دوره از یک ودیعه، سؤال غلط از رویداد درست است.
      // ودیعه سؤال استرداد لازم دارد، ولی اجارهٔ یک ماهِ نام‌برده آشکارا
      // مصرف‌شدنی است. پرسیدن از آن فقط اصطکاک است، و کاربری که برای هر اجاره
      // بازجویی شود سؤال‌ها را دور می‌زند — همان چیزی که کل این طرح رویش سوار
      // است. پس فقط وقتی می‌پرسیم که نشانهٔ استرداد در گفته باشد.
      const refundableWords = /ودیعه|رهن|قرض\s*الحسنه|سپرده|تضمین|حسن\s*انجام/;
      if (this.ambiguousRefundability.includes(category)
        && refundableWords.test(String(facts?.evidence || ''))
        && typeof facts?.refundable !== 'boolean') {
        return { treatment: TREATMENTS.PREPAID_EXPENSE, extraFacts: [FACT_KEYS.REFUNDABLE] };
      }
      if (facts?.refundable === true) {
        // پولی که برمی‌گردد هیچ‌وقت هزینه نمی‌شود: ودیعه به تفکیک طرف حساب.
        return { treatment: TREATMENTS.REFUNDABLE_DEPOSIT, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts?.occurredAt || null };
      }
      const end = facts?.servicePeriodEnd;
      // `<=` و نه `<`: وقتی کاربر می‌گوید «دوره‌اش گذشته»، دوره روی خودِ تاریخ
      // پرداخت بسته می‌شود. با مقایسهٔ اکید، همان جواب صریح نادیده می‌ماند و
      // سیستم باز هم دارایی می‌ساخت.
      if (end && new Date(end).getTime() <= new Date(today).getTime()) {
        return { treatment: TREATMENTS.PERIOD_EXPENSE, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts.occurredAt || null };
      }
      // «اجارهٔ همین ماه»: پوششی که در ماهِ پرداخت شروع و تمام می‌شود، چیزی را به
      // دورهٔ بعد نمی‌برد؛ دارایی‌ساختن و مستهلک‌کردنش در همان ماه فقط سند اضافه است
      // (آزمون بازبین، مهر ۱۴۰۵: «اجاره هم پیش‌پرداخت ماه‌های آینده نیست»).
      const paidMonth = facts?.occurredAt ? persianMonthOf(facts.occurredAt) : null;
      const start = facts?.servicePeriodStart;
      if (end && paidMonth && new Date(end).getTime() <= new Date(paidMonth.to).getTime()
        && (!start || new Date(start).getTime() >= new Date(paidMonth.from).getTime())) {
        return { treatment: TREATMENTS.PERIOD_EXPENSE, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts.occurredAt || null };
      }
      return {
        treatment: TREATMENTS.PREPAID_EXPENSE,
        recognitionMethod: RECOGNITION_METHODS.MONTHLY_STRAIGHT_LINE,
        recognitionDate: facts?.servicePeriodStart || null,
      };
    },
  }),
  /**
   * هزینهٔ همین دوره.
   *
   * قبض و سوخت و کارمزد — یا خریدی که کاربر گفته مصرف جاری است. نقشهٔ سندش
   * همان نقشهٔ همیشگیِ پرداخت هزینه است؛ ارزش این قاعده این است که موتورِ
   * روشن، ساده‌ترین ثبت‌های روز را «ماهیت نامعلوم» نخواند و به صف حسابدار
   * نفرستد.
   */
  Object.freeze({
    policyKey: 'period-expense',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.ASSET_CONSUMPTION,
    riskLevel: RISK_LEVELS.GREEN,
    supportedTreatments: Object.freeze([TREATMENTS.PERIOD_EXPENSE]),
    // تخصیص پیش‌پرداخت هم همین خانواده است، ولی پولی جابه‌جا نمی‌کند.
    appliesTo(facts) { return facts?.moneyDirection === 'out'; },
    resolve(facts) {
      return { treatment: TREATMENTS.PERIOD_EXPENSE, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts?.occurredAt || null };
    },
  }),
  /**
   * خرید کالایی که هدفش گفته شده.
   *
   * فقط یک حالت قاعدهٔ ثبت دارد: کالای ماندگارِ زیر حد سرمایه‌ای شدنِ دفتر،
   * که طبق سیاست خودِ دفتر هزینه است. دارایی ثابت و موجودی، نامشان درست
   * گذاشته می‌شود ولی به حسابدار می‌روند: دارایی ثابت عمر مفید و شروع
   * استهلاک می‌خواهد و موجودی کارت کالا و روش بهای تمام‌شده — هیچ‌کدام از یک
   * جملهٔ صوتی درنمی‌آید.
   */
  Object.freeze({
    policyKey: 'goods-purchase',
    version: '1.0.0',
    family: ECONOMIC_FAMILIES.ASSET_CREATION,
    riskLevel: RISK_LEVELS.YELLOW,
    supportedTreatments: Object.freeze([TREATMENTS.PERIOD_EXPENSE, TREATMENTS.INVENTORY_PURCHASE]),
    appliesTo(facts) {
      return ['resale', 'production', 'long-term-use'].includes(facts?.intendedUse)
        && facts?.prepaymentSignal !== true && !isTimeBoundService(facts)
        && !isFactPresent(facts?.servicePeriodStart) && !isFactPresent(facts?.servicePeriodEnd);
    },
    resolve(facts) {
      // موجودی همین حالا با ارزش درست می‌نشیند؛ نام و تعداد اقلام اگر گفته نشده،
      // بعداً به کارت کالا تفکیک می‌شود. منتظر ماندن کل خرید برای آن، ساده‌ترین
      // خرید روز را کار حسابدار می‌کرد.
      if (facts.intendedUse !== 'long-term-use') {
        return {
          treatment: TREATMENTS.INVENTORY_PURCHASE, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts?.occurredAt || null,
          assumptions: ['نام و تعداد اقلام در کارت کالا بعداً تفکیک می‌شود؛ ارزش خرید همین حالا در موجودی می‌نشیند.'],
        };
      }
      const threshold = facts?.capitalizationThreshold;
      if (Number.isSafeInteger(threshold) && Number(facts?.amount) < threshold) {
        return {
          treatment: TREATMENTS.PERIOD_EXPENSE, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts?.occurredAt || null,
          assumptions: [`مبلغ زیر حد سرمایه‌ای شدن دفتر (${threshold.toLocaleString('fa-IR')} تومان) است و طبق سیاست دفتر هزینه می‌شود.`],
        };
      }
      return {
        treatment: TREATMENTS.FIXED_ASSET,
        reviewNote: Number.isSafeInteger(threshold)
          ? 'کالای ماندگار و هم‌اندازه یا بالاتر از حد سرمایه‌ای شدن دفتر است؛ دارایی ثابت با عمر مفید و شروع استهلاک را حسابدار ثبت می‌کند.'
          : 'کالای ماندگار است و حد سرمایه‌ای شدن دفتر تعیین نشده؛ دارایی ثابت یا هزینه بودنش را حسابدار تعیین می‌کند.',
      };
    },
  }),
]);

/**
 * ترتیب نسخه‌ها — عددی، نه الفبایی.
 *
 * `'10.0.0' < '9.0.0'` در مقایسهٔ رشته‌ای درست است و در معنا غلط. نسخهٔ دهم
 * قاعده روزی می‌آید و آن روز نباید بی‌صدا نادیده گرفته شود.
 */
function versionRank(version) {
  return String(version || '0.0.0').split('.').reduce((sum, part) => (sum * 1000) + (Number(part) || 0), 0);
}

const withinWindow = (policy, eventDate) => {
  const at = new Date(eventDate).getTime();
  if (!Number.isFinite(at)) return true;
  if (policy.effectiveFrom && at < new Date(policy.effectiveFrom).getTime()) return false;
  if (policy.effectiveTo && at >= new Date(policy.effectiveTo).getTime()) return false;
  return true;
};

/**
 * قاعده‌ای که برای این رویداد اثر دارد.
 *
 * انتخاب بر اساس **تاریخ رویداد** است، نه تاریخ اجرای کد. رویدادی که برای
 * اسفند پارسال ثبت می‌شود باید قاعدهٔ اسفند پارسال را بگیرد — وگرنه یک ثبت
 * گذشته‌نگر سندی می‌خورد متفاوت با آنچه آن روز درست بود، و حسابرسی نمی‌تواند
 * بازسازی‌اش کند.
 *
 * میان چند نسخهٔ معتبر، تازه‌ترین برنده است.
 */
export function selectPolicy(policies, family, facts, eventDate) {
  let chosen = null;
  for (const policy of policies || []) {
    if (policy.family !== family) continue;
    if (!withinWindow(policy, eventDate)) continue;
    let applies = false;
    try { applies = Boolean(policy.appliesTo(facts)); } catch { applies = false; }
    if (!applies) continue;
    if (!chosen || versionRank(policy.version) > versionRank(chosen.version)) chosen = policy;
  }
  return chosen;
}

/**
 * اثر یک تغییر قاعده، پیش از فعال‌سازی.
 *
 * بدون این، تنها راه فهمیدن اینکه یک نسخهٔ تازه چه چیزی را عوض می‌کند، فعال
 * کردنش روی دفتر واقعی است. گزارش می‌گوید کدام رویدادها عوض می‌شوند و چطور —
 * و مهم‌تر، ثابت می‌کند کدام‌ها **نباید** عوض شوند و نشده‌اند.
 */
export function simulatePolicyChange(factsList = [], currentPolicies = [], candidatePolicies = [], { today = null } = {}) {
  const changed = [];
  let unchanged = 0;
  for (const facts of factsList) {
    const before = decide(facts, { policies: currentPolicies, today });
    const after = decide(facts, { policies: candidatePolicies, today });
    if (before.treatment === after.treatment
      && before.decisionStatus === after.decisionStatus
      && before.policyVersion === after.policyVersion) { unchanged += 1; continue; }
    changed.push({ facts, before, after });
  }
  return { total: factsList.length, unchanged, changed };
}

/**
 * از واقعیت‌ها، یک تصمیم.
 *
 * تابع خالص: هیچ دیتابیسی، هیچ ساعتی، هیچ تصادفی. `today` صریح پاس داده
 * می‌شود و از `Date.now()` خوانده نمی‌شود — بدون این، replay بعد از تغییر
 * نسخهٔ قاعده قابل اثبات نیست و همان ورودی فردا تصمیم دیگری می‌دهد.
 *
 * ترتیب کنترل‌ها عمدی است:
 *
 * ۱. خانواده معلوم نیست → حسابدار. هیچ قاعده‌ای روی ماهیت نامعلوم اجرا نمی‌شود.
 * ۲. واقعیت پایهٔ خانواده کم است → سؤال، حتی پیش از انتخاب قاعده.
 * ۳. قاعده‌ای برای این خانواده نیست → `unsupported`، نه حدس.
 * ۴. قاعده هست ولی واقعیت اضافه‌اش کم است → سؤال.
 * ۵. همه‌چیز هست → تصمیم.
 *
 * اطمینان مدل در هیچ‌کدام از این پنج گام دخالت ندارد. یک برداشت با اطمینان
 * کامل، جای دورهٔ پوشش نامعلوم را نمی‌گیرد.
 */
/** دسته‌هایی که پرسیدن «بابت چه بود؟» از ثبت‌کننده برایشان بی‌معناست. */
const JUDGMENT_CATEGORIES = Object.freeze(['بیمه', 'مالیات و عوارض', 'جرایم مالیاتی', 'بهای تمام‌شدهٔ فروش', 'کسری و ضایعات موجودی']);

export function decide(input = {}, { policies = DEFAULT_POLICIES, today = null, capitalizationThreshold = null } = {}) {
  // حد سرمایه‌ای شدن سیاست دفتر است، نه واقعیت رویداد؛ ولی قاعده‌ها و طبقه‌بند
  // آن را کنار واقعیت‌ها می‌خوانند تا تابع خالص بماند.
  const facts = Number.isSafeInteger(capitalizationThreshold) && capitalizationThreshold > 0
    ? { ...input, capitalizationThreshold } : input;
  // ابهام مقیاس مبلغ، پیش از هر چیز دیگری.
  //
  // «سی تومن» یعنی سی هزار یا سی میلیون؟ تا این روشن نشده، پرسیدن دورهٔ پوشش
  // یا هر سؤال دیگری بی‌معناست — و حدس زدنش یک خطای هزاربرابری در مبلغ است،
  // یعنی گران‌ترین خطایی که این سیستم می‌تواند بکند.
  if (facts?.amountScaleAmbiguous === true) {
    return createDecision({
      family: classifyFamily(facts).family,
      riskLevel: RISK_LEVELS.RED,
      sourceReferences: facts?.evidence ? [facts.evidence] : [],
      requiredFacts: [FACT_KEYS.AMOUNT_SCALE],
      missingFacts: [FACT_KEYS.AMOUNT_SCALE],
      decisionStatus: DECISION_STATUS.NEEDS_USER_INPUT,
      explanation: 'مبلغ به شکل محاوره‌ای گفته شده و مقیاسش روشن نیست.',
      question: nextQuestionFor([FACT_KEYS.AMOUNT_SCALE], facts),
    });
  }

  // نوع رویداد در دوره، پیش از هر قاعده‌ای.
  //
  // اصلاح ثبت قبلی، تغییر برآورد، برگشت سند، تعدیلی پایان دوره و افتتاحیه
  // هیچ‌کدام رویداد تازه نیستند و هیچ‌کدام خودکار ثبت نمی‌شوند. اجرای قاعده‌های
  // عادی رویشان یعنی یک اصلاح، سند مستقل تازه‌ای می‌سازد و همان مبلغ دو بار در
  // دفتر می‌نشیند.
  if (facts?.eventNature && natureNeedsAccountant(facts.eventNature)) {
    return createDecision({
      family: facts.eventNature === EVENT_NATURES.ESTIMATE_CHANGE
        ? ECONOMIC_FAMILIES.VALUE_OR_ESTIMATE_CHANGE
        : ECONOMIC_FAMILIES.CORRECTION_OR_REVERSAL,
      riskLevel: RISK_LEVELS.RED,
      sourceReferences: facts?.evidence ? [facts.evidence] : [],
      decisionStatus: DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW,
      explanation: NATURE_EXPLANATIONS[facts.eventNature] || 'این رویداد قضاوت حسابدار لازم دارد.',
      assumptions: natureAffectsPast(facts.eventNature) ? ['این ثبت دورهٔ گذشته را تغییر می‌دهد.'] : [],
    });
  }

  // جمله خودش گفته قضاوت لازم است. هیچ قاعده‌ای — نه قاعدهٔ تازه و نه سؤالی
  // از ثبت‌کننده — جای حسابدار را نمی‌گیرد.
  if (isFactPresent(facts?.needsJudgment)) {
    return createDecision({
      family: FAMILY_UNKNOWN,
      riskLevel: RISK_LEVELS.RED,
      sourceReferences: facts?.evidence ? [facts.evidence] : [],
      decisionStatus: DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW,
      explanation: facts.needsJudgment,
    });
  }

  const classified = classifyFamily(facts);
  const family = classified.family;
  const riskLevel = FAMILY_DEFAULT_RISK[family] || RISK_LEVELS.RED;
  const sourceReferences = facts?.evidence ? [facts.evidence] : [];

  if (family === FAMILY_UNKNOWN) {
    const ask = (fact, explanation) => createDecision({
      family, riskLevel: RISK_LEVELS.YELLOW, sourceReferences,
      requiredFacts: [fact], missingFacts: [fact],
      decisionStatus: DECISION_STATUS.NEEDS_USER_INPUT,
      explanation, question: nextQuestionFor([fact], facts),
    });
    // حقوق کسور بیمه و مالیات دارد که در یک جملهٔ صوتی نیست؛ ثبت خالص پرداختی
    // به‌عنوان کل هزینهٔ حقوق، بدهی بیمه و مالیات را جا می‌اندازد.
    if (facts?.moneyDirection === 'out' && String(facts?.category || '').trim() === 'حقوق و دستمزد') {
      return createDecision({
        family, riskLevel: RISK_LEVELS.YELLOW, sourceReferences,
        decisionStatus: DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW,
        explanation: 'پرداخت حقوق، کسور بیمه و مالیات دارد؛ حسابدار ناخالص، کسور و خالص پرداختی را ثبت می‌کند.',
      });
    }
    // خرید کالا بدون هدف: ماهیتش با یک سؤال روشن می‌شود، نه با قضاوت حسابدار.
    if (facts?.moneyDirection === 'out' && isFactPresent(facts?.amount)
      && (needsPurchasePurpose(facts, { capitalizationThreshold: facts?.capitalizationThreshold ?? null })
        || (facts?.paymentPurpose === 'goods' && !isFactPresent(facts?.intendedUse)))) {
      return ask(FACT_KEYS.INTENDED_USE, 'خرید کالاست؛ اینکه هزینه است، موجودی یا دارایی ثابت، به هدف خرید بستگی دارد.');
    }
    // «این پول بابت چه بود؟» — یک سؤال گزینه‌ای از ثبت‌کننده، به‌جای صف
    // حسابدار. فقط وقتی هنوز پرسیده نشده؛ «هیچ‌کدام» یعنی واقعاً قضاوت لازم است.
    // دسته‌هایی که ذاتاً تسویهٔ بدهی یا تفکیک مبلغ‌اند — مالیات، جریمه، لیست
    // بیمه، بهای تمام‌شده — این سؤال را نمی‌گیرند: هیچ گزینه‌ای درستشان نیست.
    if (JUDGMENT_CATEGORIES.includes(String(facts?.category || '').trim())) {
      return createDecision({ family, riskLevel, sourceReferences, decisionStatus: DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW, explanation: classified.reason });
    }
    // جمله‌ای که خودش نشانهٔ قضاوت دارد — «چطور ثبت کنیم؟»، محمولهٔ وارداتی،
    // شریک، تسویهٔ قبلی — سؤال گزینه‌ای نمی‌گیرد؛ هیچ گزینه‌ای درستش نیست.
    const judged = judgmentReason(`${facts?.utterance || ''} ${facts?.evidence || ''}`)
      || (purchaseNeedsJudgment(facts) ? 'جمله نشانه‌ای دارد که ساده دیدنش را ناامن می‌کند؛ حسابدار ماهیتش را تعیین می‌کند.' : null);
    if (judged) {
      return createDecision({ family, riskLevel, sourceReferences, decisionStatus: DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW, explanation: judged });
    }
    // پول کالا به شخص نام‌برده، بی‌آنکه هدفش گفته شود، ممکن است تسویهٔ بدهی
    // قبلی همان شخص باشد؛ «خرید کالا» گزینهٔ امنی برایش نیست.
    if (facts?.moneyDirection === 'out' && isFactPresent(facts?.counterparty) && ['مواد و کالا', 'ملزومات اداری'].includes(String(facts?.category || '').trim())) {
      return createDecision({ family, riskLevel, sourceReferences, decisionStatus: DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW, explanation: 'پول کالا به شخص نام‌برده رفته؛ خرید تازه است یا تسویهٔ بدهی قبلی، با حسابدار است.' });
    }
    if (facts?.moneyDirection === 'in' && isFactPresent(facts?.amount) && !isFactPresent(facts?.receiptPurpose)) {
      return ask(FACT_KEYS.RECEIPT_PURPOSE, 'از جمله معلوم نیست این دریافت فروش است، پیش‌دریافت، وام یا آورده.');
    }
    if (facts?.moneyDirection === 'out' && isFactPresent(facts?.amount) && !isFactPresent(facts?.paymentPurpose)) {
      return ask(FACT_KEYS.PAYMENT_PURPOSE, 'از جمله معلوم نیست این پرداخت هزینه است، خرید، پیش‌پرداخت یا برداشت مالک.');
    }
    return createDecision({
      family, riskLevel, sourceReferences,
      decisionStatus: DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW,
      explanation: classified.reason,
    });
  }

  // قاعده‌ای که یک واقعیت پایهٔ خانواده را عمداً لازم ندارد — مثل طرف حسابِ
  // واریز ناشناس، که نبودنش تعریف همان رویداد است.
  const waived = selectPolicy(policies, family, facts, facts?.occurredAt || today)?.waivesFamilyFacts || [];
  const baseMissing = missingFactsFor(family, null, facts).filter((key) => !waived.includes(key));
  if (baseMissing.length) {
    return createDecision({
      family, riskLevel, sourceReferences,
      requiredFacts: requiredFactsFor(family, null),
      missingFacts: baseMissing,
      decisionStatus: DECISION_STATUS.NEEDS_USER_INPUT,
      explanation: `${classified.reason} ولی ${FACT_LABELS[baseMissing[0]] || baseMissing[0]} معلوم نیست.`,
      question: nextQuestionFor(baseMissing, facts),
    });
  }

  // تاریخ رویداد، نه تاریخ اجرای کد. ثبت گذشته‌نگر باید قاعدهٔ همان روز را
  // بگیرد، وگرنه سندش با آنچه آن روز درست بود فرق می‌کند.
  const policy = selectPolicy(policies, family, facts, facts?.occurredAt || today);
  if (!policy) {
    return createDecision({
      family, riskLevel, sourceReferences,
      requiredFacts: requiredFactsFor(family, null),
      decisionStatus: DECISION_STATUS.UNSUPPORTED,
      explanation: `${classified.reason} قاعدهٔ ثبتی برای این ماهیت هنوز تعریف نشده است.`,
    });
  }

  const resolved = policy.resolve(facts, { today });
  // `extraFacts` وقتی می‌آید که قاعده بگوید «تا این را ندانم نمی‌توانم برخورد
  // را قطعی کنم». اول می‌نشیند تا همان اول پرسیده شود.
  const requiredFacts = [...new Set([...(resolved.extraFacts || []), ...requiredFactsFor(family, resolved.treatment)])]
    .filter((key) => !(policy.waivesFamilyFacts || []).includes(key));
  const missingFacts = requiredFacts.filter((key) => !isFactPresent(facts?.[key]));

  // برخوردی که قاعدهٔ ثبت ندارد، تصمیمش ثبت می‌شود ولی سند نمی‌سازد. ودیعه
  // دقیقاً همین‌جا می‌ایستد: ماهیتش شناخته شده، ولی هنوز کسی نگفته سندش چیست.
  //
  // این کنترل عمداً *پیش از* سؤال است. وقتی می‌دانیم نتیجه به حسابدار می‌رود،
  // بازجویی کردن کاربر فقط اصطکاک است؛ آنچه می‌دانیم را می‌فرستیم و او خودش
  // بقیه را می‌پرسد.
  if (policy.supportedTreatments && !policy.supportedTreatments.includes(resolved.treatment)) {
    return createDecision({
      family, requiredFacts, sourceReferences,
      treatment: resolved.treatment,
      policyKey: policy.policyKey,
      policyVersion: policy.version,
      riskLevel: policy.riskLevel || riskLevel,
      decisionStatus: DECISION_STATUS.UNSUPPORTED,
      explanation: resolved.reviewNote || `ماهیت روشن است، ولی قاعدهٔ ثبت «${resolved.treatment}» در این فاز ساخته نشده است.`,
    });
  }

  if (missingFacts.length) {
    return createDecision({
      family, riskLevel, requiredFacts, missingFacts, sourceReferences,
      treatment: resolved.treatment,
      policyKey: policy.policyKey,
      policyVersion: policy.version,
      decisionStatus: DECISION_STATUS.NEEDS_USER_INPUT,
      explanation: `${classified.reason} برای تصمیم نهایی ${FACT_LABELS[missingFacts[0]] || missingFacts[0]} لازم است.`,
      question: nextQuestionFor(missingFacts, facts),
    });
  }

  // قاعده می‌تواند بگوید حتی با دادهٔ کامل هم قضاوت لازم است — مثل مبلغ
  // برآوردی. این با «واقعیت کم است» فرق دارد و سؤال نمی‌سازد.
  if (resolved.forceReview) {
    return createDecision({
      family, requiredFacts, sourceReferences,
      treatment: resolved.treatment,
      policyKey: policy.policyKey,
      policyVersion: policy.version,
      recognitionDate: resolved.recognitionDate,
      recognitionMethod: resolved.recognitionMethod,
      riskLevel: RISK_LEVELS.RED,
      decisionStatus: DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW,
      explanation: `${classified.reason} مبلغ برآوردی است و قضاوت حسابدار لازم دارد.`,
    });
  }

  return createDecision({
    family,
    treatment: resolved.treatment,
    policyKey: policy.policyKey,
    policyVersion: policy.version,
    recognitionDate: resolved.recognitionDate,
    recognitionMethod: resolved.recognitionMethod,
    requiredFacts,
    missingFacts: [],
    riskLevel: policy.riskLevel || riskLevel,
    sourceReferences,
    assumptions: resolved.assumptions || [],
    decisionStatus: DECISION_STATUS.DECIDED,
    explanation: classified.reason,
  });
}
