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

import { FAMILY_UNKNOWN, RISK_LEVELS, isEconomicFamily } from './economicFamily.js';

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
export const DEFAULT_POLICIES = Object.freeze([]);

function notImplemented(name) {
  return Object.assign(new Error(`${name} هنوز پیاده‌سازی نشده است.`), { code: 'NOT_IMPLEMENTED' });
}

/**
 * از واقعیت‌ها، یک تصمیم.
 *
 * تابع خالص: هیچ دیتابیسی، هیچ ساعتی، هیچ تصادفی. همان ورودی همیشه همان تصمیم
 * را می‌دهد — بدون این، replay بعد از تغییر نسخهٔ قاعده قابل اثبات نیست.
 */
export function decide(/* facts, { policies, today } */) {
  throw notImplemented('decide');
}
