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
  classifyFamily, isEconomicFamily,
} from './economicFamily.js';
import {
  FACT_KEYS, FACT_LABELS, TREATMENTS, isFactPresent, missingFactsFor, nextQuestionFor, requiredFactsFor,
} from './factRequirements.js';

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
export const DEFAULT_POLICIES = Object.freeze([
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
    supportedTreatments: Object.freeze([TREATMENTS.PREPAID_EXPENSE, TREATMENTS.PERIOD_EXPENSE]),
    appliesTo(facts) { return this.categories.includes(String(facts?.category || '').trim()); },
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
        // پولی که برمی‌گردد هیچ‌وقت هزینه نمی‌شود. قاعدهٔ ثبتش در این فاز
        // ساخته نشده، پس به حسابدار می‌رود — نه اینکه هزینه ثبت شود.
        return { treatment: TREATMENTS.REFUNDABLE_DEPOSIT };
      }
      const end = facts?.servicePeriodEnd;
      // `<=` و نه `<`: وقتی کاربر می‌گوید «دوره‌اش گذشته»، دوره روی خودِ تاریخ
      // پرداخت بسته می‌شود. با مقایسهٔ اکید، همان جواب صریح نادیده می‌ماند و
      // سیستم باز هم دارایی می‌ساخت.
      if (end && new Date(end).getTime() <= new Date(today).getTime()) {
        return { treatment: TREATMENTS.PERIOD_EXPENSE, recognitionMethod: RECOGNITION_METHODS.IMMEDIATE, recognitionDate: facts.occurredAt || null };
      }
      return {
        treatment: TREATMENTS.PREPAID_EXPENSE,
        recognitionMethod: RECOGNITION_METHODS.MONTHLY_STRAIGHT_LINE,
        recognitionDate: facts?.servicePeriodStart || null,
      };
    },
  }),
]);

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
export function decide(facts = {}, { policies = DEFAULT_POLICIES, today = null } = {}) {
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

  const classified = classifyFamily(facts);
  const family = classified.family;
  const riskLevel = FAMILY_DEFAULT_RISK[family] || RISK_LEVELS.RED;
  const sourceReferences = facts?.evidence ? [facts.evidence] : [];

  if (family === FAMILY_UNKNOWN) {
    return createDecision({
      family, riskLevel, sourceReferences,
      decisionStatus: DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW,
      explanation: classified.reason,
    });
  }

  const baseMissing = missingFactsFor(family, null, facts);
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

  const policy = policies.find((candidate) => candidate.family === family && candidate.appliesTo(facts));
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
  const requiredFacts = [...new Set([...(resolved.extraFacts || []), ...requiredFactsFor(family, resolved.treatment)])];
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
      explanation: `ماهیت روشن است، ولی قاعدهٔ ثبت «${resolved.treatment}» در این فاز ساخته نشده است.`,
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
    decisionStatus: DECISION_STATUS.DECIDED,
    explanation: classified.reason,
  });
}
