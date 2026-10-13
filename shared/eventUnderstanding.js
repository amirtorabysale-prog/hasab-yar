/**
 * قرارداد «فهم رویداد مالی» — خروجی مدل زبانی پیش از موتور حسابداری.
 *
 * مرز همان مرز `shared/aiFactContract.js` است: مدل فقط می‌گوید چه گفته شده، نه
 * سند چه باشد. تفاوت این قرارداد با آن یکی این است که **رابطه‌ها** را هم
 * می‌خواهد: کدام مبلغ کل است و کدام جزء، کدام انجام شده و کدام آینده یا مشروط،
 * کدام تاریخ پرداخت است و کدام شروع پوشش. پارسر قطعی همین‌ها را با الگو
 * می‌فهمید و در جملهٔ مرکب یا تکه‌تکه می‌کرد یا کل گفته را به حسابدار می‌داد.
 *
 * سه چیز این‌جا از مدل گرفته **نمی‌شود** و سرور خودش حسابشان می‌کند:
 *
 * - **عدد مبلغ:** مدل عدد را می‌گوید، ولی فقط وقتی پذیرفته می‌شود که خواندنِ
 *   قطعیِ همان شاهد (`extractAmounts`) همان عدد را بدهد. مدلی که عدد بسازد —
 *   از شمارهٔ فاکتور، سال یا تعداد کارتن — رد می‌شود.
 * - **تاریخ:** مدل فقط عبارت و نقش تاریخ را می‌دهد. تبدیل شمسی به لحظهٔ واقعی
 *   کار `persianDate.js` است؛ مدل‌ها در این تبدیل غلط می‌کنند و غلطشان دیده
 *   نمی‌شود.
 * - **شناسه:** مدل نام می‌گوید. اینکه آن نام کدام شخص یا حساب دفتر است، کار
 *   تطبیق سرور است و نتیجه‌اش شناسهٔ واقعی است.
 *
 * و یک چیز اصلاً در قرارداد نیست: اطمینانِ اعلام‌شدهٔ مدل. اجازهٔ ثبت فقط از
 * اعتبارسنجی، موتور قاعده و تأیید انسان می‌آید؛ عددی که مدل دربارهٔ خودش
 * می‌گوید هیچ‌کدام از این سه نیست.
 *
 * این ماژول وابستگی شبکه یا دیتابیس ندارد و در مرورگر هم اجرا می‌شود.
 */
import { extractAmounts, withoutRateAmounts } from './parser.js';
import { normalizePersian } from './normalize.js';
import { extractDateMention, persianToISO, readJalaliExpression, todayPersian } from './persianDate.js';
import { FORBIDDEN_FACT_FIELDS } from './aiFactContract.js';
import { detectBank } from './banks.js';
import { readUnpaidSignal } from './accrualSpeech.js';
import { mentionsPersonalMoney } from './partnerPaidSpeech.js';
import { readServicePeriod } from './periodSpeech.js';

export const UNDERSTANDING_VERSION = 'event-understanding/v1';

export const UNDERSTANDING_EVENT_KINDS = Object.freeze([
  'purchase', 'sale', 'expense', 'income', 'settlement', 'loan-received', 'loan-repayment', 'capital-in',
  'owner-drawing', 'transfer', 'payroll', 'asset-purchase', 'advance-paid', 'advance-received', 'deposit',
  'refund', 'correction', 'obligation', 'cheque', 'paid-by-partner', 'other',
]);
export const EVENT_STATUSES = Object.freeze(['done', 'future', 'conditional', 'mixed']);

/**
 * نقش هر مبلغ در همان رویداد.
 *
 * `prior-balance` زمینه است و هرگز سند تازه نمی‌سازد: «۸۰ میلیون بدهکار
 * بودیم» بدهی را دوباره ایجاد نمی‌کند. `future-payment` و `conditional-waiver`
 * هم تا وقتی انجام نشده‌اند سند ندارند.
 */
export const AMOUNT_ROLES = Object.freeze([
  'total', 'part', 'paid-now', 'received-now', 'cash-part', 'credit-part', 'prior-balance', 'future-payment',
  'conditional-waiver', 'waiver', 'loan-principal', 'installment', 'interest', 'tax', 'discount', 'deposit',
  'fee', 'unit-price', 'other',
]);
export const AMOUNT_STATUSES = Object.freeze(['done', 'future', 'conditional', 'context']);
export const AMOUNT_BASES = Object.freeze(['explicit', 'computed', 'inferred']);
export const CURRENCIES = Object.freeze(['toman', 'rial']);
export const COMPUTE_OPS = Object.freeze(['sum', 'difference', 'product']);
export const NON_AMOUNT_ROLES = Object.freeze([
  'invoice-number', 'cheque-number', 'year', 'quantity', 'installment-count', 'day-of-month', 'percentage',
  'phone', 'account-number', 'duration', 'other',
]);
export const DATE_ROLES = Object.freeze([
  'payment', 'occurrence', 'coverage-start', 'coverage-end', 'delivery', 'due', 'invoice', 'installment-start', 'other',
]);
export const RELATIVE_DATES = Object.freeze(['today', 'yesterday', 'day-before-yesterday', 'tomorrow', 'day-after-tomorrow']);
export const COUNTERPARTY_ROLES = Object.freeze([
  'supplier', 'customer', 'lender', 'owner', 'partner', 'employee', 'authority', 'bank', 'landlord', 'other',
]);
export const MOVEMENT_DIRECTIONS = Object.freeze(['in', 'out', 'transfer', 'none']);
export const ENDPOINT_KINDS = Object.freeze(['bank', 'cash', 'petty-cash', 'counterparty', 'us', 'unknown']);
export const SUBJECT_KINDS = Object.freeze(['goods', 'service', 'asset', 'money', 'other']);
export const SUBJECT_USES = Object.freeze(['internal', 'resale', 'production', 'long-term', 'unknown']);
export const DELIVERY_STATES = Object.freeze(['yes', 'no', 'unknown']);
export const CONDITION_KINDS = Object.freeze(['negation', 'condition', 'promise', 'correction']);
export const AMBIGUITY_KINDS = Object.freeze(['information', 'judgment']);

/**
 * نقش‌هایی که وضعیتشان از خودشان معلوم است.
 *
 * اگر مدل «بدهی قبلی» را «انجام‌شده» علامت بزند، نتیجه‌اش ایجاد دوبارهٔ همان
 * بدهی است. وضعیتی که نقش تعیین می‌کند، همیشه به سمتِ «سند نساز» اصلاح
 * می‌شود — هیچ‌وقت برعکس.
 */
const STATUS_BY_ROLE = Object.freeze({
  'prior-balance': 'context',
  'future-payment': 'future',
  'conditional-waiver': 'conditional',
  'unit-price': 'context',
});

const PAST_DATE_ROLES = new Set(['payment', 'occurrence', 'invoice']);

/**
 * نوع‌هایی که مسیر حسابدار را باز می‌کنند، فقط وقتی واژه‌اش در جمله هست.
 *
 * آزمون زنده: مدل یک تسویهٔ بدهی را «قسط وام» نامید و پرونده بی‌دلیل به
 * حسابدار رفت. نوع رویداد حدس مدل است؛ وقتی حدسش مسیر را عوض می‌کند، باید
 * دست‌کم یک نشانهٔ صریح در خود جمله داشته باشد.
 */
const KIND_CUES = Object.freeze({
  'loan-received': /وام|تسهیلات|قرض/,
  // «قسط دوم بیمه»، «قسط اجاره» قسطِ یک قرارداد است، نه وام؛ «قسط» فقط کنار بانک
  // یا لیزینگ نشانهٔ وام است.
  'loan-repayment': /وام|تسهیلات|لیزینگ|قسط(?:\s+\S+){0,2}?\s+(?:بانک|لیزینگ)/,
  payroll: /حقوق|دستمزد|لیست\s*بیمه|کارکنان|پرسنل/,
  correction: /اشتباه|اصلاح|تصحیح|غلط/,
  refund: /برگشت|مرجوع|استرداد|عودت|پس\s*(?:دادیم|گرفتیم|دادن|داد)/,
  cheque: /چک/,
  // بدون نشانهٔ پولِ شخصی، «پرداخت کرد» همان پرداختِ کسب‌وکار است.
  'paid-by-partner': { test: (text) => mentionsPersonalMoney(text) },
});

/** «نه»، «ببخشید»، «منظورم» میان دو عدد: عدد اول پس گرفته شد. */
const RETRACT = /[،,]?\s*(?:نه\s*[،,]?\s*ببخشید|نه|ببخشید|منظورم)\s*[،,]?\s*/g;
const SPLIT_PART_ROLES = new Set(['cash-part', 'credit-part', 'paid-now', 'received-now', 'part', 'future-payment']);
const ACCOUNT_SIDES = new Set(['bank', 'cash', 'petty-cash']);
const POSTING_DATE_ROLES = new Set(['payment', 'occurrence', 'coverage-start', 'coverage-end']);
/** نشانهٔ پرداختِ بخشی از مانده؛ بدون هیچ‌کدام، «بدهی‌اش را واریز کرد» یعنی همهٔ مانده. */
const PARTIAL_PAYMENT = /بخشی|قسمتی|مقداری|نصف|نیمی|کمی|یه\s*کم|بعضی|بقیه|باقی|مابقی|علی[\s\u200c]*الحساب|درصد|قسط|بیعانه/;
/** فعلِ انجام‌شدهٔ جابه‌جایی پول. */
const DONE_MONEY_VERB = /(?:پرداخت|واریز|منتقل|حواله|کارت\s*به\s*کارت)\s*(?:کردیم|کردم|کرد|کردند|کردن|شد)(?=$|[\s.،؛!؟])|(?:^|\s)(?:دادیم|دادم|ریختیم|ریختم|زدیم|زدم|کشیدیم|کشیدن)(?=$|[\s.،؛!؟])/;
const NOT_YET = /قرار|خواه|بعدا|بعداً|هنوز|اگر|اگه|می[\s\u200c]*(?:پرداز|ده|دیم|ریز|زن)/;
/**
 * اصلاحِ سندِ قبلی یا رویدادِ دیرگفته، هر نوعی که مدل بگوید. آزمون زنده: «سود
 * سال قبل را برداشت کردم، یادم رفته بود بگم، درستش کن» برداشتِ پس‌گرفته دیده شد
 * و «فروش سال قبل جا افتاده» تاریخ پرداخت را پرسید.
 */
const BOOK_CORRECTION = /اشتباه\S*[^.،؛!؟]{0,40}(?:ثبت|منظور|برده)\s*شده|جا\s*افتاده|تعدیل(?:ات)?\s*سنواتی|سند\s*(?:اصلاحی|تعدیل)|(?:کمتر|بیشتر)\s*محاسبه\s*شده|یادم\s*رفته\s*بود|(?:اصلاحش|درستش)\s*کن/;
const THIS_MONTH = /^(?:این|همین)\s*ماه$|^ماه\s*جاری$/;
/** واژهٔ نسبیِ خودِ عبارت؛ ترتیب مهم است: «پس‌فردا» پیش از «فردا». */
const RELATIVE_WORDS = [
  [/پس[\s‌]*فردا/, 'day-after-tomorrow'], [/پریروز/, 'day-before-yesterday'], [/دیروز/, 'yesterday'],
  [/امروز/, 'today'], [/(?:^|[\s‌])فردا/, 'tomorrow'],
];
/** بندی که پرداختش هنوز نیامده: زمان آینده، قرار، یا شرط. */
const FUTURE_CLAUSE = /فردا|(?:هفته|ماه|سال)\s*(?:بعد|آینده|دیگه|دیگر)|(?:^|\s)بعد(?:ا|اً)(?=$|\s)|قرار(?:ه|\s*است)|(?:^|\s)خواه(?:یم|ند|د)(?=$|\s)|(?:^|\s)می[\s‌]*(?:دهیم|دیم|دهند|دن|پردازیم|پردازند|ریزیم|ریزند|ریزن|گیریم|گیرند|کنیم|کنند|کنن)(?=$|[\s.،؛!؟])/;
/** «شش ماه آینده»، «یک سال جلوتر»: طولِ دوره با شمارش، نه «ماه آینده می‌دیم». */
const COVERAGE_LENGTH = /(?:[0-9۰-۹]+|یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|یازده|دوازده)\s*(?:ماه|سال)\s*(?:آینده|جلوتر)/g;
const CONDITION_CLAUSE = /(?:^|\s)(?:اگر|اگه)(?=$|\s)|در\s*صورت/;
const DONE_CLAUSE = /(?:^|\s)(?:کردیم|کردم|کرد|کردند|کردن|شد|شده|دادیم|دادم|داد|دادند|دادن|گرفتیم|گرفتم|گرفت|گرفتند|ریختیم|ریختم|ریخت|ریختند|زدیم|زدم|زد|زدند|کشیدیم|کشیدن|خریدیم|خریدم|فروختیم|فروختم|رسید|آمد|اومد)(?=$|[\s.،؛!؟])/;
/** فعلِ سوم‌شخصِ واریز: «شرکت آفتاب ... به ملت واریز کرد» یعنی پول آمد. */
const THEIR_DEPOSIT = /(?:واریز|پرداخت)\s*(?:کرد|کردند|کردن)(?=$|[\s.،؛!؟])|(?:^|\s)(?:ریخت|ریختند|ریختن|زد|زدند|زدن|داد|دادند|دادن)(?=$|[\s.،؛!؟])/;
const OUR_PAYMENT = /(?:^|\s)(?:کردیم|دادیم|ریختیم|زدیم|کردم|دادم|ریختم|زدم|پرداختیم)(?=$|[\s.،؛!؟])/;
/** نفیِ پرداخت — نه نفیِ ماهیت. «ودیعه هزینه نیست» پرداخت را نفی نمی‌کند. */
const PAYMENT_NEGATION = /(?:پرداخت|واریز|تسویه|دریافت)\s*ن(?:کرده|کردیم|کردم|کرد|کردند|شده|شد)|(?:^|\s)ن(?:دادیم|دادم|داده|دادن|دادند|گرفتیم|گرفتم|گرفته|گرفتن|ریختیم|ریخته|زدیم|زده)|هنوز[^.،؛]{0,25}(?:پول|پرداخت|واریز|نداد|نگرفت)|پولی\s*(?:هم\s*)?ن/;
/** نامِ کسی یا جایی که بانک نیست، حتی اگر نامِ کوتاهِ یک بانک در آن باشد. */
const PARTY_TITLE = /آقای|خانم|شرکت|دکتر|مهندس|حاج|فروشگاه|موسسه|مؤسسه|کارخانه/;

function persianMonthEnd(year, month, timeZone) {
  const next = month === 12 ? persianToISO(year + 1, 1, 1, timeZone) : persianToISO(year, month + 1, 1, timeZone);
  return next ? new Date(Date.parse(next) - 86_400_000).toISOString() : null;
}

/** اسم شمارشیِ پس از عدد: آن عدد تعداد است، نه پول. */
const COUNT_NOUN = /^\s*(?:تا|عدد|قسط|کارتن|بسته|نفر|ماه|سال|روز|هفته|کیلو|متر|دستگاه|قلم|فقره|برگ|چک|فاکتور|درصد|واحد|جلد|شاخه|تن)(?![آ-ی])/;

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const object = (properties) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const array = (items) => ({ type: 'array', items });
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const nullableInteger = { type: ['integer', 'null'] };
const choice = (values) => ({ type: 'string', enum: [...values] });
const nullableChoice = (values) => ({ type: ['string', 'null'], enum: [...values, null] });
const endpoint = object({ kind: choice(ENDPOINT_KINDS), name: nullableString });

/**
 * schema سختِ خروجی، قابل استفاده با Structured Outputs.
 *
 * همهٔ فیلدها `required` اند و «نمی‌دانم» با `null` گفته می‌شود — همان قاعدهٔ
 * قرارداد قبلی به زبان حالت سخت: مدلی که مجبور شود مبلغ بدهد، مبلغ می‌سازد؛
 * مدلی که بتواند `null` بگذارد، نمی‌سازد.
 */
export function understandingSchema() {
  return object({
    event: object({ kind: choice(UNDERSTANDING_EVENT_KINDS), description: string, status: choice(EVENT_STATUSES) }),
    amounts: array(object({
      id: string,
      value: nullableInteger,
      currency: nullableChoice(CURRENCIES),
      role: choice(AMOUNT_ROLES),
      status: choice(AMOUNT_STATUSES),
      partOf: nullableString,
      basis: choice(AMOUNT_BASES),
      computedFrom: object({ op: nullableChoice(COMPUTE_OPS), of: array(string) }),
      evidence: string,
    })),
    nonAmountNumbers: array(object({ value: string, role: choice(NON_AMOUNT_ROLES), evidence: string })),
    dates: array(object({
      id: string,
      role: choice(DATE_ROLES),
      expression: string,
      relative: nullableChoice(RELATIVE_DATES),
      jalali: object({ year: nullableInteger, month: nullableInteger, day: nullableInteger }),
    })),
    counterparties: array(object({ id: string, name: string, role: nullableChoice(COUNTERPARTY_ROLES), evidence: string })),
    movements: array(object({
      id: string, amountRef: string, direction: choice(MOVEMENT_DIRECTIONS), from: endpoint, to: endpoint, evidence: string,
    })),
    subject: object({
      what: nullableString, kind: nullableChoice(SUBJECT_KINDS), use: choice(SUBJECT_USES),
      delivered: choice(DELIVERY_STATES), usefulLifeMonths: nullableInteger, evidence: nullableString,
    }),
    conditions: array(object({ kind: choice(CONDITION_KINDS), text: string, affects: array(string), evidence: string })),
    ambiguities: array(object({ field: string, kind: choice(AMBIGUITY_KINDS), question: string, options: array(string) })),
  });
}

// ---------------------------------------------------------------------------
// اعتبارسنجی
// ---------------------------------------------------------------------------

const FORBIDDEN = new Set(FORBIDDEN_FACT_FIELDS.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, '')));
// «type» در فهرست ممنوع قرارداد قبلی است چون طبقه‌بندی حسابداری بود. این‌جا
// نامِ هیچ فیلدی نیست، پس هر جا دیده شود یعنی مدل از قالب بیرون زده.
const ALLOWED_KEYS = new Set([
  'event', 'kind', 'description', 'status', 'amounts', 'id', 'value', 'currency', 'role', 'partOf', 'basis',
  'computedFrom', 'op', 'of', 'evidence', 'nonAmountNumbers', 'dates', 'expression', 'relative', 'jalali', 'year',
  'month', 'day', 'counterparties', 'name', 'movements', 'amountRef', 'direction', 'from', 'to', 'subject', 'what',
  'use', 'delivered', 'usefulLifeMonths', 'conditions', 'text', 'affects', 'ambiguities', 'field', 'question', 'options',
]);

function structuralViolations(value, path = '', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => structuralViolations(item, `${path}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FORBIDDEN.has(normalized) && key !== 'kind') found.push(`${path}.${key}:forbidden`);
    else if (!ALLOWED_KEYS.has(key)) found.push(`${path}.${key}:unknown`);
    structuralViolations(child, `${path}.${key}`, found);
  }
  return found;
}

/**
 * متن برای مقایسهٔ شاهد: رقم لاتین، بدون نیم‌فاصله و نشانه، با فاصلهٔ یکسان.
 *
 * شاهد باید **عین** گفتهٔ کاربر باشد؛ این یکسان‌سازی فقط تفاوت‌های نوشتاری را
 * برمی‌دارد — «۵۰» و «50»، «می‌دهیم» و «می دهیم» — نه تفاوت معنایی.
 */
export function evidenceKey(value) {
  // «اقای» تایپی و «آقای» مدل یک واژه‌اند؛ فقط برای تطبیق شاهد، نه برای متنی که ذخیره می‌شود.
  return normalizePersian(value).replace(/آ/g, 'ا').replace(/[«»"'“”()[\]{}،,؛;:!؟?.\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * تکه‌های یک نقل‌قول.
 *
 * مدل واقعی عبارتِ بلند را با «...» کوتاه می‌کند: «جنس برای فروش ... تحویل
 * گرفتیم». هر تکه جداگانه باید در متن باشد؛ «...» خودش ادعایی نیست.
 */
const segments = (evidence) => String(evidence || '').split(/\.{2,}|…/).map((part) => part.trim()).filter(Boolean);

/** عینِ متن؛ اگر چند تکه است، همه به همان ترتیب. */
const found = (evidence, textKey) => {
  const parts = segments(evidence).map(evidenceKey).filter(Boolean);
  if (!parts.length) return false;
  let from = 0;
  for (const part of parts) {
    const index = textKey.indexOf(part, from);
    if (index < 0) return false;
    from = index + part.length;
  }
  return true;
};

/**
 * شاهدِ توصیفی — کاربرد کالا، شرط، نفی — کمی آزادتر.
 *
 * مدل واقعی گاهی یک «را» یا یک واژه را از عبارت جا می‌اندازد و شاهد عیناً در
 * متن پیدا نمی‌شد؛ «برای فروش» دور ریخته می‌شد و خرید کالا بی‌کاربرد می‌ماند.
 * این‌جا کافی است همهٔ واژه‌های شاهد به همان ترتیب در متن باشند و جمعاً حداکثر
 * دو واژه جا افتاده باشد. هیچ واژه‌ای که در متن نیست پذیرفته نمی‌شود.
 *
 * مبلغ، تاریخ و نام همچنان عینِ متن را می‌خواهند: دوختن تکه‌های دور از هم
 * («پنجاه … میلیون») می‌تواند عدد یا تاریخی بسازد که کسی نگفته.
 */
// واژه‌های دستوری که مدل در نقل‌قول اضافه یا کم می‌کند و معنایی نمی‌سازند.
const FUNCTION_WORDS = new Set(['را', 'رو', 'و', 'که', 'به', 'از', 'با', 'هم', 'این', 'اون', 'آن', 'ما', 'ها']);

const foundLoosely = (evidence, textKey) => {
  if (found(evidence, textKey)) return true;
  const parts = segments(evidence);
  if (parts.length > 1) return parts.every((part) => foundLoosely(part, textKey));
  const words = evidenceKey(evidence).split(' ').filter((word) => word && !FUNCTION_WORDS.has(word));
  const textWords = textKey.split(' ');
  if (words.length < 2) return false;
  let position = textWords.indexOf(words[0]);
  if (position < 0) return false;
  let skipped = 0;
  for (const word of words.slice(1)) {
    const next = textWords.indexOf(word, position + 1);
    if (next < 0) return false;
    skipped += next - position - 1;
    position = next;
  }
  return skipped <= 2;
};

const cleanLabel = (value, limit = 160) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, limit);

/**
 * مبلغ‌هایی که خواندنِ قطعی از یک شاهد بیرون می‌آورد.
 *
 * `cue` یعنی آن عدد نشانهٔ پول دارد: واحد، مقیاس، یا عدد بزرگی که فقط مبلغ
 * می‌تواند باشد. «ده کارتن» و «سه قسط» نشانهٔ پول ندارند؛ اگر مدل آن‌ها را
 * مبلغ بداند، همین‌جا رد می‌شود.
 */
function readEvidenceAmounts(evidence) {
  const { text, spans } = extractAmounts(evidence);
  return spans.filter((span) => !span.bareScale).map((span) => {
    const after = text.slice(span.end, span.end + 14);
    const toman = /^\s*(?:تومان|تومن)/.test(after);
    const rial = /^\s*ریال/.test(after);
    const scaled = /هزار|میلیون|میلیارد/.test(span.raw);
    const grouped = /^\d{1,3}(?:,\d{3})+$/.test(span.raw.replace(/\s/g, ''));
    // «۱۰۰۰۰ عدد پیچ» عدد بزرگ است ولی تعداد است.
    const counted = !toman && !rial && COUNT_NOUN.test(text.slice(span.end));
    return {
      amount: span.amount, rial, toman,
      colloquial: span.amount < 1_000 && !/\d|هزار|میلیون|میلیارد/.test(span.raw) && toman,
      cue: !counted && (toman || rial || scaled || grouped || span.amount >= 10_000),
    };
  });
}

/**
 * آیا عددی که مدل گفته، از همان شاهد درمی‌آید؟
 *
 * خروجی: `{ value, scaleAmbiguous }` یا `null`. ریال به تومان تقسیم می‌شود،
 * چون همهٔ دفتر به تومان است. «هشتصد تومن» پذیرفته می‌شود ولی با ابهام مقیاس،
 * همان رفتار پارسر قطعی.
 */
/**
 * عددِ مبلغ از خودِ شاهد خوانده می‌شود؛ عددِ مدل فقط انتخاب می‌کند کدام.
 *
 * آزمون زنده روی سایت (۱۷ مهر ۱۴۰۵): مدل واقعی برای «۱۵ میلیون تومان» نوشت
 * `value: 15` — به میلیون، نه تومان. شاهد درست بود و خواندنِ قطعیِ همان شاهد
 * ۱۵٬۰۰۰٬۰۰۰ می‌داد. پس مبلغ همیشه همان خواندنِ شاهد است، و عدد مدل فقط وقتی
 * شاهد چند مبلغ دارد یکی را برمی‌گزیند — به تومان، یا به هزار، میلیون یا
 * میلیارد. شاهدی که فقط یک مبلغِ پولی دارد، همان است. هیچ عددی بیرون از شاهد
 * ساخته نمی‌شود.
 */
const MODEL_UNITS = [1, 1_000, 1_000_000, 1_000_000_000];

/** واژهٔ نرخِ دوره کنار یک مبلغ: «ماهی ۱ میلیون»، «۵ میلیون در ماه». */
const PERIOD_RATE_BEFORE = /(?:ماهیانه|ماهانه|(?<![آ-ی])ماهی(?:\s*ای)?|هر\s*ماهه?|در\s*ماه|سالانه|سالیانه|(?<![آ-ی])سالی(?:\s*ای)?|هر\s*ساله?|در\s*سال|روزانه|(?<![آ-ی])روزی|هر\s*روز|هفتگی|هر\s*هفته)\s*(?:مبلغ\s*)?$/;
const PERIOD_RATE_AFTER = /^\s*(?:تومان|تومن|ریال)?\s*(?:(?:در|هر|برای\s*هر|به\s*ازای\s*هر)\s*(?:ماه|سال|روز|هفته)ه?(?![آ-ی])|(?:ماهیانه|ماهانه|سالانه|سالیانه|روزانه|هفتگی)(?![آ-ی]))/;
const OWN_PAYMENT_VERB = /(?<![آ-ی])(?:دادیم|دادم|داد|دادن|پرداخت|واریز|ریختیم|ریختم|ریخت|زدیم|زدم|گرفتیم|گرفتم|کارت\s*به\s*کارت)/;
const LOAN_WORD = /وام|تسهیلات|قرض/;

/**
 * نرخِ دوره کنار کل، پرداخت نیست؛ نرخی که فعل پرداختِ خودش را دارد، هست.
 *
 * گزارش کاربر (۱۸ مهر ۱۴۰۵): «بیمهٔ یک‌ساله ۱۲ میلیون … ماهیانه ۱ میلیون». مسیر
 * قطعی «ماهیانه ۱ میلیون» را با `withoutRateAmounts` کنار می‌گذارد، ولی مسیر AI
 * برچسب مدل را می‌پذیرفت: نرخِ «سایر/پرداخت‌شده» پرداخت دوم می‌شد (۱۳ میلیون
 * پیش‌پرداخت با ۲۴ قسط)، و نرخِ «پرداخت‌شده» کنار کل به کل وصل می‌شد و خودِ ۱۲
 * میلیون از ثبت می‌افتاد. وارونه‌اش هم بود: «ودیعه ۵۰ میلیون دادیم و اجارهٔ
 * ماهانه ۵ میلیون هم دادیم» با برچسب «نرخ» یا «قسط» پرداخت ۵ میلیونی را بی‌صدا
 * دور می‌ریخت و بانک ۵ میلیون کم می‌آمد.
 *
 * قاعده همان قاعدهٔ مسیر قطعی است، روی خودِ جمله، نه برچسب مدل:
 * - مبلغی که `withoutRateAmounts` نرخ می‌داند و مبلغ انجام‌شدهٔ دیگری کنارش هست،
 *   نرخِ زمینه است — هر جابه‌جایی که مدل رویش گذاشته باشد.
 * - مبلغی که مدل «نرخ» یا «قسط» خوانده ولی واژهٔ نرخ دارد و فعل پرداختِ خودش را
 *   در بند خودش (فعلِ آخرِ جمله فقط با «هم» یا وقتی مبلغ قبلی فعل خودش را دارد)،
 *   پرداخت است. قسطِ وام بیرون از این قاعده است؛ اصل و سودش با حسابدار است.
 */
const RATE_TOTAL_CUE = /(?<![آ-ی])(?:کل|کلش|کلشو|جمع|جمعا|جمعاً|مجموع|مجموعا|مجموعاً|یکجا|یک\s*جا|روی\s*هم|همه|همش|همه\s*اش)(?![آ-ی])/;
const LIST_JOIN = /^\s*(?:تومان|تومن|ریال)?\s*(?:رو|را)?\s*و\s/;

function guardPeriodRates(amounts, movements, text, violations, ask = () => {}) {
  const read = extractAmounts(text);
  if (read.spans.length < 2) return;
  const keptStarts = new Set(withoutRateAmounts(read.text, read.spans).map((span) => span.start));
  const spanOf = (amount) => {
    const same = read.spans.filter((span) => span.amount === amount.value || span.amount === amount.value * 10);
    if (same.length <= 1) return same[0] || null;
    const key = normalizePersian(amount.evidence || '').trim();
    const at = key ? read.text.indexOf(key) : -1;
    return at < 0 ? null : same.find((span) => span.start >= at && span.end <= at + key.length) || null;
  };
  const placed = amounts.filter((amount) => amount.accepted).map((amount) => ({ amount, span: spanOf(amount) })).filter((item) => item.span);
  const isRate = (span) => !keptStarts.has(span.start);
  const index = (span) => read.spans.findIndex((item) => item.start === span.start);
  const ownClause = (span) => read.text.slice(span.end, read.spans[index(span) + 1]?.start ?? read.text.length).split(/[.،,؛;\n]/)[0];
  // کلی که پرداخت را می‌برد: جابه‌جایی یا فعل پرداختِ خودش را دارد. «قرارداد
  // یک ساله ۱۲۰ میلیون بستیم، ماهی ۱۰ میلیون، اجارهٔ این ماه رو دادیم»: ۱۲۰
  // میلیون ارزش قرارداد است و پولی با آن جابه‌جا نشده؛ پرداختِ واقعی همان ۱۰
  // میلیون است و نباید به نفع کلِ پرداخت‌نشده کنار برود.
  const carries = (other) => movements.some((item) => item?.amountRef === other.amount.id) || OWN_PAYMENT_VERB.test(ownClause(other.span));
  for (const { amount, span } of placed) {
    if (!isRate(span) || amount.status !== 'done') continue;
    const totals = placed.filter((other) => other.amount !== amount && other.amount.status === 'done' && !isRate(other.span) && carries(other));
    if (!totals.length) continue;
    // «اجاره ماهانه ۱۰ میلیون و قبض برق ۲ میلیون رو دادیم»: مبلغی که با «و»
    // به قلم بعدی وصل است و فعلِ آخر را با آن شریک است، قلمِ فهرست است، نه نرخِ
    // کل — مگر واژهٔ کل («کل شش ماه ۳۰ میلیون») یا مضربِ درستِ نرخ بودنِ کل آن
    // را نرخ کند. مضرب بی‌واژهٔ کل حدس است؛ داوری با حسابدار.
    const next = read.spans[index(span) + 1];
    const gap = next ? read.text.slice(span.end, next.start) : '';
    if (next && LIST_JOIN.test(gap) && !RATE_TOTAL_CUE.test(gap)) {
      const multiple = totals.some((other) => other.amount.value > amount.value && other.amount.value % amount.value === 0);
      if (multiple) {
        ask(`amounts.${amount.id}.rate`, 'judgment', `«${amount.evidence}» نرخِ دوره‌ایِ مبلغ دیگر است یا پرداختی جدا؟ با حسابدار.`);
        violations.push(`amounts.${amount.id}:rate-or-item`);
      }
      continue;
    }
    Object.assign(amount, { role: 'unit-price', status: 'context', partOf: null });
    violations.push(`amounts.${amount.id}:rate-not-payment`);
  }
  for (const { amount, span } of placed) {
    if (!['unit-price', 'installment'].includes(amount.role) || isRate(span)) continue;
    const at = index(span);
    const previous = read.spans[at - 1];
    const next = read.spans[at + 1];
    const cue = PERIOD_RATE_BEFORE.test(read.text.slice(Math.max(0, span.start - 24), span.start)) || PERIOD_RATE_AFTER.test(read.text.slice(span.end, span.end + 30));
    const clause = read.text.slice(span.end, next?.start ?? read.text.length).split(/[.،,؛;\n]/)[0];
    const leading = read.text.slice(previous?.end ?? 0, span.start);
    const ownVerb = OWN_PAYMENT_VERB.test(clause)
      && (!previous || OWN_PAYMENT_VERB.test(leading) || /(?<![آ-ی])هم(?![آ-ی])/.test(clause));
    if (!cue || !ownVerb || LOAN_WORD.test(`${leading} ${clause}`)) continue;
    const movement = movements.find((item) => item?.amountRef === amount.id);
    Object.assign(amount, { role: movement?.direction === 'in' ? 'received-now' : 'paid-now', status: 'done' });
    violations.push(`amounts.${amount.id}:rate-with-own-verb`);
  }
}
function verifyExplicitAmount(amount, evidence, unitHint = null) {
  const claimed = Number(amount.value);
  const reads = readEvidenceAmounts(evidence);
  const candidates = reads.filter((read) => read.cue || read.colloquial).map((read) => {
    // واحد را متن می‌گوید، نه برچسبِ مدل: «۱۲ میلیون تومان» با برچسب ریال، ده برابر
    // کوچک می‌شد (گزارش بازبین، مهر ۱۴۰۵).
    const rial = read.rial || (!read.toman && unitHint === 'rial');
    return { value: read.colloquial ? read.amount * 1_000 : rial ? Math.round(read.amount / 10) : read.amount, raw: read.amount, scaleAmbiguous: read.colloquial };
  });
  if (!candidates.length) return null;
  if (Number.isFinite(claimed) && claimed > 0) {
    const matched = candidates.find((candidate) => MODEL_UNITS.some((unit) => candidate.value === claimed * unit || candidate.raw === claimed * unit));
    // عددی که مدل گفته با شاهدِ خودش در هیچ مقیاسی نمی‌خواند: تناقض است و
    // پرسیده می‌شود. پذیرفتنِ عددِ شاهد این‌جا یعنی نقشی که مدل برای عدد دیگری
    // گفته بود — «نسیه ۷۰» — روی ۱۰۰ بنشیند.
    return matched ? { value: matched.value, scaleAmbiguous: matched.scaleAmbiguous } : null;
  }
  // مدل عدد نگفته ولی شاهدش فقط یک مبلغ پولی دارد: همان.
  return candidates.length === 1 ? { value: candidates[0].value, scaleAmbiguous: candidates[0].scaleAmbiguous } : null;
}

function compute(op, values) {
  if (values.some((value) => !Number.isSafeInteger(value))) return null;
  if (op === 'sum') return values.reduce((total, value) => total + value, 0);
  if (op === 'difference') return values.length === 2 ? values[0] - values[1] : null;
  if (op === 'product') return values.reduce((total, value) => total * value, 1);
  return null;
}

const RELATIVE_OFFSETS = Object.freeze({ today: 0, yesterday: -1, 'day-before-yesterday': -2, tomorrow: 1, 'day-after-tomorrow': 2 });

function relativeIso(relative, now, timeZone) {
  const offset = RELATIVE_OFFSETS[relative];
  if (offset === undefined) return null;
  const today = todayPersian(now, timeZone);
  const base = persianToISO(today.year, today.month, today.day, timeZone);
  return base ? new Date(Date.parse(base) + offset * 86_400_000).toISOString() : null;
}

/**
 * سالِ نگفته از نقش تاریخ فهمیده می‌شود: پرداخت و وقوع گذشته‌اند، سررسید و
 * پایان پوشش آینده. «۲۰ آذر» برای سررسید چک یعنی آذرِ پیش رو، نه آذرِ پارسال.
 *
 * پایانِ پوششی که آغازش هم گفته شده، به آغازش بسته است نه به امروز (`rollEnd`
 * خاموش): «اجارهٔ مرداد» که مهر پرداخت شود، مرداد تا مردادِ همین سال است و
 * گذشته؛ پیش‌تر پایانش به مردادِ سال بعد می‌رفت و اجارهٔ یک ماهِ گذشته
 * پیش‌پرداختِ ۱۳ ماهه می‌شد (موتور ۵، مهر ۱۴۰۵). پایانی که پیش از آغاز بیفتد،
 * پایین‌تر با همان آغاز به سال بعد می‌رود.
 */
function jalaliIso({ year, month, day }, role, now, timeZone, { rollEnd = true } = {}) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (day != null && (!Number.isInteger(day) || day < 1 || day > 31)) return null;
  const today = todayPersian(now, timeZone);
  const atDay = (y) => {
    if (day != null) return persianToISO(y, month, day, timeZone);
    // «تا پایان مهر»: آخرین روز همان ماه، از روز اولِ ماه بعد.
    if (role === 'coverage-end') {
      const next = month === 12 ? persianToISO(y + 1, 1, 1, timeZone) : persianToISO(y, month + 1, 1, timeZone);
      return next ? new Date(Date.parse(next) - 86_400_000).toISOString() : null;
    }
    return persianToISO(y, month, 1, timeZone);
  };
  if (Number.isInteger(year)) return atDay(year < 100 ? 1400 + year : year);
  const thisYear = atDay(today.year);
  if (!thisYear) return null;
  const future = Date.parse(thisYear) > now.getTime() + 43_200_000;
  if (PAST_DATE_ROLES.has(role) && future) return atDay(today.year - 1);
  if (!PAST_DATE_ROLES.has(role) && !future && ['due', ...(rollEnd ? ['coverage-end'] : []), 'delivery', 'installment-start'].includes(role)
    && Date.parse(thisYear) < now.getTime() - 43_200_000 * 60) return atDay(today.year + 1);
  return thisYear;
}

const dayKey = (iso, timeZone) => {
  const parts = todayPersian(new Date(iso), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

/**
 * تاریخ، از سه منبع: «امروز/دیروز»، اجزای شمسی، و خواندنِ قطعیِ خودِ عبارت.
 * اگر دو منبع با هم نخوانند تاریخ پذیرفته نمی‌شود و سؤال می‌شود.
 */
function resolveDate(date, { now, timeZone, rollEnd = true }) {
  // «سود سپردهٔ این ماه»، «قبض گاز این ماه»: ماهِ جاری، بی‌روز. روز پرداختش همان
  // پیش‌فرضِ امروز است. پوششی که در همین ماه تمام می‌شود چیزی را به دورهٔ بعد
  // نمی‌برد، پس دورهٔ پوشش نیست و پرسیده هم نمی‌شود. آزمون زنده: دو بار «دقیقاً
  // چه روزی؟»، و سود سپرده با دورهٔ پوشش طرف حساب خواست.
  if (THIS_MONTH.test(normalizePersian(date.expression || '').trim())) {
    if (['payment', 'occurrence'].includes(date.role)) return { iso: new Date(now).toISOString(), issue: null };
    if (['coverage-start', 'coverage-end'].includes(date.role)) return { iso: null, issue: 'this-month' };
    const today = todayPersian(now, timeZone);
    const iso = persianToISO(today.year, today.month, 1, timeZone);
    return { iso, issue: iso ? null : 'unresolved' };
  }
  // عبارتی که نام ماه دارد، ماه و روز و سالش را از واژه‌های خودش می‌گیرد؛ شمارهٔ
  // ماهِ مدل کنار گذاشته می‌شود (آزمون زنده: «آبان» = ۱۱، «مهر» = ۱۰ از مدل).
  const spoken = date.expression ? readJalaliExpression(date.expression) : null;
  if (spoken) {
    const today = todayPersian(now, timeZone);
    const end = spoken.end || (spoken.day == null && date.role === 'coverage-end');
    const lastDay = (year) => {
      const next = spoken.month === 12 ? persianToISO(year + 1, 1, 1, timeZone) : persianToISO(year, spoken.month + 1, 1, timeZone);
      return next ? new Date(Date.parse(next) - 86_400_000).toISOString() : null;
    };
    const year = spoken.year ?? (spoken.yearOffset != null ? today.year + spoken.yearOffset : null);
    const iso = year != null
      ? (end ? lastDay(year) : persianToISO(year, spoken.month, spoken.day ?? 1, timeZone))
      : jalaliIso({ year: null, month: spoken.month, day: end ? null : (spoken.day ?? 1) }, end ? 'coverage-end' : date.role, now, timeZone, { rollEnd: rollEnd || date.role !== 'coverage-end' });
    return { iso, issue: iso ? null : 'unresolved' };
  }
  // «دیروز» با برچسبِ «امروز»: واژهٔ خودِ عبارت حرف آخر است (گزارش بازبین، مهر ۱۴۰۵).
  const expressed = normalizePersian(date.expression || '');
  const saidRelative = RELATIVE_WORDS.find(([pattern]) => pattern.test(expressed))?.[1] || null;
  const relative = saidRelative || date.relative;
  const fromRelative = relative ? relativeIso(relative, now, timeZone) : null;
  const jalali = date.jalali && Number.isInteger(date.jalali.month) ? jalaliIso(date.jalali, date.role, now, timeZone, { rollEnd }) : null;
  const mention = date.expression ? extractDateMention(date.expression, { now, timeZone, preferPast: PAST_DATE_ROLES.has(date.role) }) : null;
  const candidates = [fromRelative, jalali].filter(Boolean);
  // عبارت بی‌سال («اول آبان») از خواندن قطعی سالِ حدسی می‌گیرد؛ فقط ماه و روز
  // قابل مقایسه است.
  if (mention?.iso && !candidates.length) candidates.push(mention.iso);
  if (!candidates.length) return { iso: null, issue: 'unresolved' };
  const keys = new Set(candidates.map((iso) => dayKey(iso, timeZone)));
  if (keys.size > 1) return { iso: null, issue: 'conflict' };
  if (mention?.iso && jalali && date.jalali.day != null) {
    const [, mentionMonth, mentionDay] = dayKey(mention.iso, timeZone).split('-');
    const [, ownMonth, ownDay] = dayKey(jalali, timeZone).split('-');
    if (mentionMonth !== ownMonth || mentionDay !== ownDay) return { iso: null, issue: 'conflict' };
  }
  return { iso: candidates[0], issue: null };
}

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/**
 * خروجی مدل را می‌سنجد و شکل قطعی‌اش را می‌سازد.
 *
 * دو نوع خطا جداست:
 *
 * - **ساختاری** (فیلد ممنوع یا ناشناخته، شکل اشتباه): کل پاسخ رد می‌شود —
 *   `ok: false`. حذف بی‌صدای فیلد ممنوع یعنی هیچ‌کس نمی‌فهمد مدل چند بار از
 *   مرز رد شده.
 * - **برداشتِ تکی** (شاهدی که در متن نیست، مبلغی که از شاهد درنمی‌آید، تاریخ
 *   متناقض): همان برداشت پذیرفته نمی‌شود و یک ابهامِ «پرسیدنی» جایش می‌نشیند.
 *   بقیهٔ فهم سالم می‌ماند، ولی ثبت تا جواب آن سؤال ممکن نیست.
 */
export function validateUnderstanding(raw, { text = '', now = new Date(), timeZone = 'Asia/Tehran', ledgerBanks = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, violations: ['payload'], understanding: null };
  const structural = structuralViolations(raw);
  const shape = ['event', 'amounts', 'nonAmountNumbers', 'dates', 'counterparties', 'movements', 'subject', 'conditions', 'ambiguities']
    .filter((key) => raw[key] === undefined || (key !== 'event' && key !== 'subject' && !Array.isArray(raw[key])))
    .map((key) => `${key}:shape`);
  if (structural.length || shape.length) return { ok: false, violations: [...structural, ...shape], understanding: null };

  const textKey = evidenceKey(text);
  // واحدِ پولِ هر شاهد: واژهٔ پس از آن در خودِ جمله، و اگر نبود، تنها واحدی که
  // جمله گفته. برچسبِ ریالِ مدل فقط وقتی پذیرفته است که جمله جز ریال واحدی نگفته باشد.
  const sentence = normalizePersian(text);
  const sentenceUnits = { rial: /ریال/.test(sentence), toman: /تومان|تومن/.test(sentence) };
  const unitAfter = (evidence) => {
    const key = normalizePersian(evidence || '').trim();
    const at = key ? sentence.indexOf(key) : -1;
    if (at < 0) return null;
    const after = sentence.slice(at + key.length, at + key.length + 14);
    return /^\s*ریال/.test(after) ? 'rial' : /^\s*(?:تومان|تومن)/.test(after) ? 'toman' : null;
  };
  const unitHintFor = (part, rawAmount) => unitAfter(part)
    || (rawAmount?.currency === 'rial' && sentenceUnits.rial && !sentenceUnits.toman ? 'rial' : null);
  // بندِ یک شاهد: تکه‌ای از جمله میان دو مرز که شاهد در آن است. دونقطه مرز نیست —
  // «پرداخت کردیم: ۳۰ ودیعه و ۶ اجاره» توضیحِ همان پرداخت است. «و» پیش از عدد مرز
  // است: «۹ میلیون واریز کردند و ۱۸ میلیون را ماه بعد می‌دهند» دو بند است.
  const boundedBy = (evidence, boundary) => {
    const key = normalizePersian(evidence || '').trim();
    const at = key ? sentence.indexOf(key) : -1;
    if (at < 0) return '';
    let start = 0;
    let end = sentence.length;
    for (const match of sentence.matchAll(boundary)) {
      if (match.index + match[0].length <= at) start = match.index + match[0].length;
      else if (match.index >= at + key.length) { end = match.index; break; }
    }
    return sentence.slice(start, end);
  };
  const clauseOf = (evidence) => boundedBy(evidence, /[.،,؛;!؟?\n]|\s+و\s+(?=\d)|\s+(?:ولی|اما)\s+/g);
  const sentenceOf = (evidence) => boundedBy(evidence, /[.؛;!؟?\n]/g);
  const violations = [];
  const ambiguities = [];
  const ask = (field, kind, question, options = [], source = 'validator') => {
    if (!ambiguities.some((item) => item.field === field)) ambiguities.push({ field, kind, question: cleanLabel(question, 200), options, source });
  };

  // --- مبالغ ---------------------------------------------------------------
  const seen = new Set();
  const amounts = raw.amounts.slice(0, 12).map((item, index) => {
    const id = cleanLabel(item.id, 20) || `a${index + 1}`;
    if (seen.has(id)) violations.push(`amounts.${id}:duplicate-id`);
    seen.add(id);
    const role = pick(item.role, AMOUNT_ROLES, 'other');
    const forced = STATUS_BY_ROLE[role];
    const status = forced || pick(item.status, AMOUNT_STATUSES, 'done');
    if (forced && item.status !== forced) violations.push(`amounts.${id}:status-forced-${forced}`);
    return {
      id, role, status, raw: item,
      currency: pick(item.currency, CURRENCIES, null),
      partOf: item.partOf ? cleanLabel(item.partOf, 20) : null,
      basis: pick(item.basis, AMOUNT_BASES, 'inferred'),
      computedFrom: item.computedFrom?.op ? { op: pick(item.computedFrom.op, COMPUTE_OPS, null), of: (item.computedFrom.of || []).map((ref) => cleanLabel(ref, 20)) } : null,
      evidence: cleanLabel(item.evidence, 300),
      value: null, accepted: false, scaleAmbiguous: false, provenance: null, issue: null,
    };
  });
  const byId = new Map(amounts.map((amount) => [amount.id, amount]));

  for (const amount of amounts) {
    if (amount.basis === 'explicit') {
      if (!found(amount.evidence, textKey)) { amount.issue = 'evidence-not-found'; continue; }
      // عدد از یک تکهٔ پیوسته خوانده می‌شود، نه از تکه‌های دوخته‌شده.
      const verified = segments(amount.evidence).map((part) => verifyExplicitAmount(amount.raw, part, unitHintFor(part, amount.raw))).find(Boolean) || null;
      if (!verified) { amount.issue = amount.raw.value == null ? 'value-missing' : 'not-in-evidence'; continue; }
      Object.assign(amount, { value: verified.value, scaleAmbiguous: verified.scaleAmbiguous, accepted: true, provenance: 'explicit' });
    }
  }
  // «صد میلیون خریدیم، چهل‌شو نقد دادیم»: «چهل» مقیاس ندارد و مقیاسش همان
  // «میلیون» همین جمله است. فقط وقتی پذیرفته می‌شود که جمله یک مقیاس بیشتر
  // نداشته باشد و عدد خودش هیچ نشانهٔ پولی نداشته باشد؛ منشأ جدا ثبت می‌شود
  // تا برگهٔ تأیید بگوید مقیاس از کجا آمده.
  const scales = new Set(readEvidenceAmounts(text).filter((read) => read.cue).map((read) => (
    read.amount % 1_000_000_000 === 0 ? 1_000_000_000 : read.amount % 1_000_000 === 0 ? 1_000_000 : read.amount % 1_000 === 0 ? 1_000 : 1
  )).filter((scale) => scale > 1));
  if (scales.size === 1) {
    const [scale] = scales;
    for (const amount of amounts.filter((item) => item.issue === 'not-in-evidence')) {
      const read = extractAmounts(amount.evidence);
      // «سه قسط»، «ده کارتن»: عددِ شمارنده مقیاس پول نمی‌گیرد.
      const bare = read.spans.filter((span) => !span.bareScale && span.amount < 1_000 && !/\d|هزار|میلیون|میلیارد/.test(span.raw)
        && !COUNT_NOUN.test(read.text.slice(span.end)));
      // عدد مدل ممکن است تومانِ کامل باشد یا خودِ «چهل» به میلیون.
      const claimed = Number(amount.raw.value);
      const span = bare.find((item) => item.amount * scale === claimed || item.amount === claimed);
      if (span && !readEvidenceAmounts(amount.evidence).some((read) => read.cue)) {
        Object.assign(amount, { value: span.amount * scale, accepted: true, provenance: 'explicit-scale-from-sentence', issue: null });
      }
    }
  }
  guardPeriodRates(amounts, raw.movements, text, violations, ask);
  // یک عددِ گفته‌شده، حداکثر یک مبلغ قابل ثبت.
  //
  // مدل واقعی «هشتاد میلیون … نسیه خریدیم» را دو مبلغ کرد: کل ۸۰ و بخش نسیهٔ ۸۰،
  // بی‌آنکه یکی را جزء دیگری بداند. نتیجه‌اش سؤال «۸۰ میلیون از کدام حساب رفت؟»
  // بود و با جوابش، ۸۰ نقد و ۸۰ بدهی — دو برابرِ واقعیت. وقتی عددی در متن کمتر
  // از تعداد مبالغِ هم‌اندازهٔ ادعاشده آمده، همان تعداد نگه داشته می‌شود و نقشِ
  // مشخص‌تر (نسیه، نقد، پرداخت‌شده) بر «کل» مقدم است.
  const mentions = new Map();
  for (const read of readEvidenceAmounts(text).filter((item) => item.cue || item.colloquial)) {
    const value = read.colloquial ? read.amount * 1_000 : read.rial ? Math.round(read.amount / 10) : read.amount;
    mentions.set(value, (mentions.get(value) || 0) + 1);
  }
  const generality = (role) => (['total', 'other'].includes(role) ? 1 : 0);
  // «آقای محمدی بدهی پنجاه میلیونیش را واریز کرد»: یک عدد با دو نقش — مانده (زمینه)
  // و پرداخت. مانده هیچ‌وقت ثبت نمی‌شود، پس دوباره‌شماری نمی‌سازد.
  const wholeBalance = (amount, balance) => balance.role === 'prior-balance' && ['paid-now', 'received-now'].includes(amount.role)
    && amount.status === 'done' && !PARTIAL_PAYMENT.test(normalizePersian(text));
  const byValue = new Map();
  for (const amount of amounts.filter((item) => item.accepted && item.provenance === 'explicit')) {
    byValue.set(amount.value, [...(byValue.get(amount.value) || []), amount]);
  }
  for (const [value, group] of byValue) {
    const allowed = Math.max(1, mentions.get(value) || 0);
    const counted = group.filter((item) => !group.some((other) => wholeBalance(other, item)));
    if (counted.length <= allowed) continue;
    const ordered = [...counted].sort((left, right) => generality(left.role) - generality(right.role));
    for (const extra of ordered.slice(allowed)) {
      Object.assign(extra, { accepted: false, issue: 'same-mention', duplicateOf: ordered[0].id, value: null });
      violations.push(`amounts.${extra.id}:same-mention`);
    }
  }
  // محاسبه‌شده‌ها بعد از صریح‌ها، و فقط از مبالغ پذیرفته‌شده: «بقیه‌اش» از
  // اعداد صریح قابل محاسبه است، از عدد حدسی نه.
  for (const amount of amounts) {
    if (amount.basis !== 'computed') continue;
    const sources = (amount.computedFrom?.of || []).map((ref) => byId.get(ref));
    if (!amount.computedFrom?.op || !sources.length || sources.some((source) => !source?.accepted)) { amount.issue = 'computation-unsupported'; continue; }
    const value = compute(amount.computedFrom.op, sources.map((source) => source.value));
    // عدد مدل برای محاسبه‌شده هم ممکن است به میلیون باشد؛ مقدار، محاسبهٔ خود سرور است.
    const claimed = Number(amount.raw.value);
    const agrees = amount.raw.value == null || MODEL_UNITS.some((unit) => claimed * unit === value);
    if (!Number.isSafeInteger(value) || value <= 0 || !agrees) { amount.issue = 'computation-mismatch'; continue; }
    Object.assign(amount, { value, accepted: true, provenance: 'computed' });
  }
  // اصلاحِ همان گفته، بی‌نیاز به مدل: عددی که درست پیش از «نه/ببخشید» آمده و
  // عدد دیگری درست بعدش، پس گرفته شده است. آزمون زنده: مدل در «۱۵۰ میلیون، نه،
  // ۲۰۰ میلیون وام گرفتیم» هر دو را وام دانست.
  const retracted = [];
  const spokenRetractions = [];
  const replacements = new Map();
  const spoken = normalizePersian(text);
  for (const marker of spoken.matchAll(RETRACT)) {
    const left = extractAmounts(spoken.slice(0, marker.index));
    const last = left.spans.at(-1);
    if (!last || left.text.slice(last.end).trim()) continue;
    const right = extractAmounts(spoken.slice(marker.index + marker[0].length));
    const first = right.spans[0];
    if (!first || right.text.slice(0, first.start).trim()) continue;
    const scale = /میلیارد/.test(first.raw) ? 1_000_000_000 : /میلیون/.test(first.raw) ? 1_000_000 : /هزار/.test(first.raw) ? 1_000 : 1;
    const value = /هزار|میلیون|میلیارد/.test(last.raw) ? last.amount : last.amount * scale;
    spokenRetractions.push(value);
    replacements.set(value, first.amount);
    const target = amounts.find((item) => item.accepted && item.value === value && !retracted.includes(item.id));
    if (target) { retracted.push(target.id); violations.push(`amounts.${target.id}:retracted-in-speech`); }
  }
  // وقتی جمله خودش روشن می‌گوید کدام عدد پس گرفته شد، حدسِ مدل کنار می‌رود، حتی
  // اگر عددِ پس‌گرفته خودش مبلغِ پذیرفته‌ای نشده باشد. آزمون زنده: در «۱۶، نه ۱۸
  // میلیون» جمله ۱۶ را پس می‌گیرد ولی مدل ۱۸ را پس‌گرفته دانست.
  const trustModelCorrections = spokenRetractions.length === 0;
  const modelRetracted = trustModelCorrections ? raw.conditions.filter((item) => item?.kind === 'correction').flatMap((item) => item.affects || []) : [];
  const isRetracted = (id) => retracted.includes(id) || modelRetracted.includes(id);
  // اجزایی که مدل به کلِ تنها وصل نکرده بود، به همان وصل می‌شوند؛ بدون این، کل
  // خودش پرداختِ جدا دیده می‌شد و «۱۲۰ از کدام حساب رفت؟» پرسیده می‌شد.
  const totals = amounts.filter((item) => item.accepted && item.role === 'total' && item.status === 'done' && !isRetracted(item.id));
  if (totals.length === 1) {
    const [total] = totals;
    const loose = amounts.filter((item) => item !== total && item.accepted && !item.partOf && !isRetracted(item.id)
      && SPLIT_PART_ROLES.has(item.role) && item.value < total.value);
    if (loose.length && loose.reduce((sum, item) => sum + item.value, 0) <= total.value) {
      for (const item of loose) { item.partOf = total.id; violations.push(`amounts.${item.id}:linked-to-total`); }
    }
  }
  const otherDone = amounts.some((item) => item.accepted && item.status === 'done');
  // همان پول، دو بار توصیف‌شده: «به مبلغ ۹۵ میلیون» و «نقدی از صندوق» (آزمون زنده).
  // مبلغی که شاهدش عددی ندارد ولی عددِ ادعاشده‌اش با مبلغِ پذیرفته‌شده‌ای یکی است،
  // همان مبلغ است؛ جابه‌جایی‌اش به آن منتقل می‌شود و سؤالی نمی‌سازد.
  const sameAs = new Map();
  // عددِ پس‌گرفته‌ای که مدل پول را روی آن گذاشته بود: پول با عددِ جانشینش رفته
  // است. آزمون زنده: در «۱۶، نه ۱۸ میلیون» مدل پرداخت از بانک ملت را روی ۱۶ گذاشت،
  // ۱۸ بی‌جابه‌جایی ماند و «مبلغِ ۱۶، نه ۱۸ میلیون دقیقاً چقدر است؟» پرسیده می‌شد.
  for (const amount of amounts) {
    let value = null;
    if (amount.accepted) {
      if (!retracted.includes(amount.id)) continue;
      value = amount.value;
    } else if (amount.issue === 'not-in-evidence' && amount.status === 'done') {
      const claimed = Number(amount.raw.value);
      value = [...replacements.keys()].find((item) => MODEL_UNITS.some((unit) => claimed * unit === item)) ?? null;
      if (value == null) continue;
      amount.issue = 'retracted-in-speech';
      retracted.push(amount.id);
      violations.push(`amounts.${amount.id}:retracted-in-speech`);
    } else continue;
    const successor = amounts.find((item) => item.accepted && !retracted.includes(item.id) && item.value === replacements.get(value));
    if (successor && !raw.movements.some((item) => item?.amountRef === successor.id)) sameAs.set(amount.id, successor.id);
  }
  for (const amount of amounts.filter((item) => !item.accepted && ['not-in-evidence', 'value-missing'].includes(item.issue) && item.status === 'done')) {
    const claimed = Number(amount.raw.value);
    if (!(claimed > 0)) continue;
    const twin = amounts.find((item) => item !== amount && item.accepted && !isRetracted(item.id) && MODEL_UNITS.some((unit) => item.value === claimed * unit));
    if (!twin) continue;
    // پرداختِ همهٔ مانده، تکرارِ مانده نیست؛ آزمون زنده (T031): پرداخت روی ماندهٔ
    // زمینه افتاد و هیچ سندی ساخته نشد.
    if (wholeBalance(amount, twin)) {
      Object.assign(amount, { value: twin.value, accepted: true, provenance: 'whole-balance', issue: null });
      violations.push(`amounts.${amount.id}:whole-balance-of-${twin.id}`);
      continue;
    }
    Object.assign(amount, { issue: 'same-mention', duplicateOf: twin.id });
    sameAs.set(amount.id, twin.id);
    violations.push(`amounts.${amount.id}:same-as-${twin.id}`);
  }
  // تکرارِ همان عدد که کنار رفت، جابه‌جایی‌اش را به مبلغِ نگه‌داشته می‌دهد.
  for (const amount of amounts) if (amount.issue === 'same-mention' && amount.duplicateOf && !sameAs.has(amount.id)) sameAs.set(amount.id, amount.duplicateOf);
  for (const amount of amounts) {
    if (amount.basis === 'inferred') amount.issue = 'inferred';
    // تکرارِ همان عدد سؤال نمی‌خواهد؛ عددش در مبلغِ نگه‌داشته‌شده هست.
    if (amount.accepted || ['same-mention', 'retracted-in-speech'].includes(amount.issue)) continue;
    violations.push(`amounts.${amount.id}:${amount.issue}`);
    // فقط مبلغی که سند می‌سازد می‌پرسد. زمینه، آینده و مشروط ثبت نمی‌شوند؛
    // نامعلوم‌بودن عددشان هیچ سندی را غلط نمی‌کند و سؤالش فقط ثبت را معطل می‌کرد.
    // کل یا «سایر»ِ نامعلوم وقتی مبلغ انجام‌شدهٔ دیگری هست مانع ثبت نیست: پول را
    // همان‌ها جابه‌جا می‌کنند. آزمون زنده: «فاکتور ۱۴۰۵۷» مبلغِ خالی شد و پرسیده می‌شد.
    // جزءِ بی‌عددِ یک مبلغِ پذیرفته‌شده هم سؤال نمی‌خواهد: کل، یک‌جا ثبت می‌شود.
    // فقط جزئی که عددی ادعا نکرده؛ جزئی که عددش با شاهدش تناقض دارد همچنان پرسیده می‌شود.
    const partOfAccepted = amount.raw.value == null && amount.partOf && amounts.some((item) => item.id === amount.partOf && item.accepted);
    if (amount.status === 'done' && !partOfAccepted && !(['total', 'other'].includes(amount.role) && otherDone)) {
      ask(`amounts.${amount.id}.value`, 'information', amount.evidence
        ? `مبلغِ «${amount.evidence}» دقیقاً چقدر است؟`
        : 'مبلغ این بخش دقیقاً چقدر است؟');
    }
  }
  for (const amount of amounts) {
    if (amount.scaleAmbiguous) ask(`amounts.${amount.id}.scale`, 'information', `«${amount.evidence}» یعنی ${amount.value.toLocaleString('fa-IR')} تومان؟`, ['بله', 'نه، مبلغ دیگری است']);
    if (amount.partOf && !byId.has(amount.partOf)) { violations.push(`amounts.${amount.id}:partOf-missing`); amount.partOf = null; }
  }
  // کل و اجزا: جمعِ اجزای پذیرفته‌شده نباید از کل بیشتر شود، و نقد + نسیه
  // باید دقیقاً همان کل باشد.
  for (const total of amounts.filter((amount) => amount.accepted)) {
    const parts = amounts.filter((amount) => amount.partOf === total.id && amount.accepted && !isRetracted(amount.id));
    if (!parts.length) continue;
    const sum = parts.reduce((value, part) => value + part.value, 0);
    const split = parts.some((part) => part.role === 'cash-part') && parts.some((part) => part.role === 'credit-part');
    if (sum > total.value || (split && sum !== total.value)) {
      violations.push(`amounts.${total.id}:parts-mismatch`);
      ask(`amounts.${total.id}.parts`, 'information', 'جمع اجزا با مبلغ کل نمی‌خواند؛ کدام عدد درست است؟');
    }
  }

  // --- اعداد غیرمبلغ ---------------------------------------------------------
  const nonAmountNumbers = raw.nonAmountNumbers.slice(0, 12).map((item) => ({
    value: cleanLabel(item.value, 30), role: pick(item.role, NON_AMOUNT_ROLES, 'other'), evidence: cleanLabel(item.evidence, 200),
  })).filter((item) => foundLoosely(item.evidence, textKey));
  // اگر مدل همان عدد را هم مبلغ دانسته و هم شماره یا تعداد، به هیچ‌کدام اعتماد
  // نمی‌شود.
  for (const amount of amounts.filter((item) => item.accepted && item.provenance === 'explicit')) {
    const clash = nonAmountNumbers.find((number) => evidenceKey(number.evidence) === evidenceKey(amount.evidence) && Number(evidenceKey(number.value).replace(/[^\d]/g, '')) === amount.value);
    if (clash) {
      amount.accepted = false;
      amount.issue = 'also-non-amount';
      violations.push(`amounts.${amount.id}:also-non-amount`);
      ask(`amounts.${amount.id}.value`, 'information', `«${amount.evidence}» مبلغ است یا ${clash.role === 'quantity' ? 'تعداد' : 'شماره'}؟`);
    }
  }

  // --- تاریخ‌ها --------------------------------------------------------------
  const startSaid = raw.dates.slice(0, 8).some((item) => item?.role === 'coverage-start' && found(cleanLabel(item.expression, 120), textKey));
  const dates = raw.dates.slice(0, 8).map((item, index) => {
    const date = {
      id: cleanLabel(item.id, 20) || `d${index + 1}`, role: pick(item.role, DATE_ROLES, 'other'),
      expression: cleanLabel(item.expression, 120), relative: pick(item.relative, RELATIVE_DATES, null),
      jalali: item.jalali && typeof item.jalali === 'object' ? {
        year: Number.isInteger(item.jalali.year) ? item.jalali.year : null,
        month: Number.isInteger(item.jalali.month) ? item.jalali.month : null,
        day: Number.isInteger(item.jalali.day) ? item.jalali.day : null,
      } : null,
      iso: null, accepted: false, issue: null,
    };
    if (!found(date.expression, textKey)) { date.issue = 'evidence-not-found'; return date; }
    const resolved = resolveDate(date, { now, timeZone, rollEnd: !startSaid });
    return { ...date, iso: resolved.iso, accepted: Boolean(resolved.iso), issue: resolved.issue };
  });
  // «از اول مهر تا آخر شهریور»: پایانِ بی‌سالی که پیش از آغاز می‌افتد، سالِ بعد
  // است. آزمون زنده (V09): پایان ۳۱ شهریورِ همین سال خوانده شد، یک روز پیش از
  // آغاز، و بیمهٔ یک‌ساله یک‌جا هزینه شد. پایانی که سالش گفته شده و باز پیش از
  // آغاز است، پرسیده می‌شود.
  const coverageFrom = dates.find((item) => item.accepted && item.role === 'coverage-start');
  for (const end of dates.filter((item) => coverageFrom && item.accepted && item.role === 'coverage-end')) {
    if (Date.parse(end.iso) > Date.parse(coverageFrom.iso)) continue;
    const spokenEnd = end.expression ? readJalaliExpression(end.expression) : null;
    const yearSaid = spokenEnd ? spokenEnd.year != null || spokenEnd.yearOffset != null : end.jalali?.year != null;
    const parts = todayPersian(new Date(end.iso), timeZone);
    const monthEnd = spokenEnd ? Boolean(spokenEnd.end) || spokenEnd.day == null : end.jalali?.day == null;
    const rolled = yearSaid ? null : monthEnd ? persianMonthEnd(parts.year + 1, parts.month, timeZone) : persianToISO(parts.year + 1, parts.month, parts.day, timeZone);
    if (rolled && Date.parse(rolled) > Date.parse(coverageFrom.iso)) { end.iso = rolled; violations.push(`dates.${end.id}:next-year`); continue; }
    Object.assign(end, { iso: null, accepted: false, issue: 'before-start' });
  }
  for (const date of dates.filter((item) => !item.accepted)) {
    violations.push(`dates.${date.id}:${date.issue}`);
    if (date.issue === 'this-month') continue;
    // فقط تاریخی که سند را عوض می‌کند پرسیده می‌شود: روز پرداخت و دورهٔ پوشش.
    // سررسید یا روز تحویلِ نامعلوم، ثبت امروز را غلط نمی‌کند.
    if (POSTING_DATE_ROLES.has(date.role)) ask(`dates.${date.role}`, 'information', `تاریخِ «${date.expression || 'این بخش'}» دقیقاً چه روزی است؟`);
  }

  // --- طرف حساب، جابه‌جایی، موضوع -------------------------------------------
  const counterparties = raw.counterparties.slice(0, 6).map((item, index) => ({
    id: cleanLabel(item.id, 20) || `c${index + 1}`, name: cleanLabel(item.name, 100),
    role: pick(item.role, COUNTERPARTY_ROLES, null), evidence: cleanLabel(item.evidence, 200),
  })).filter((item) => {
    // نامی که در متن نیست، ساختهٔ مدل است.
    const ok = item.name && found(item.name, textKey);
    if (!ok) violations.push(`counterparties.${item.id}:name-not-found`);
    return ok;
  });

  const movements = raw.movements.slice(0, 12).map((item, index) => ({
    id: cleanLabel(item.id, 20) || `m${index + 1}`, amountRef: cleanLabel(item.amountRef, 20),
    direction: pick(item.direction, MOVEMENT_DIRECTIONS, 'none'),
    from: { kind: pick(item.from?.kind, ENDPOINT_KINDS, 'unknown'), name: item.from?.name ? cleanLabel(item.from.name, 80) : null },
    to: { kind: pick(item.to?.kind, ENDPOINT_KINDS, 'unknown'), name: item.to?.name ? cleanLabel(item.to.name, 80) : null },
    evidence: cleanLabel(item.evidence, 300),
  })).filter((item) => {
    if (sameAs.has(item.amountRef)) item.amountRef = sameAs.get(item.amountRef);
    if (!byId.has(item.amountRef)) { violations.push(`movements.${item.id}:amount-missing`); return false; }
    // نام بانک یا شخصی که در متن نیست، مقصد ساختگی است؛ نامش حذف می‌شود و
    // انتخاب حساب پرسیده می‌شود.
    for (const side of ['from', 'to']) {
      if (item[side].name && !found(item[side].name, textKey)) { violations.push(`movements.${item.id}.${side}:name-not-found`); item[side].name = null; }
    }
    return true;
  });

  // --- نوع رویداد و جهت جابه‌جایی ---------------------------------------------
  let eventKind = pick(raw.event?.kind, UNDERSTANDING_EVENT_KINDS, 'other');
  if (KIND_CUES[eventKind] && !KIND_CUES[eventKind].test(spoken)) {
    violations.push(`event:${eventKind}-without-cue`);
    eventKind = amounts.some((item) => item.role === 'prior-balance') ? 'settlement' : 'other';
  }
  if (eventKind !== 'correction' && BOOK_CORRECTION.test(spoken)) {
    violations.push(`event:${eventKind}-is-correction`);
    eventKind = 'correction';
  }
  const loanEvent = ['loan-received', 'loan-repayment'].includes(eventKind);
  // نامِ کوتاهِ بانکی که همین دفتر حسابش را دارد هم بانک است: «۹ میلیون به سامان
  // واریز کردند». «سامان» نامِ آدم هم هست، پس فقط وقتی دفتر حسابِ سامان دارد و
  // عنوانی مثل «آقای» یا «شرکت» کنارش نیست (آزمون بازبین، مهر ۱۴۰۵).
  const isBank = (name) => {
    if (!name) return false;
    if (detectBank(name)) return true;
    if (PARTY_TITLE.test(name)) return false;
    const cued = detectBank(`بانک ${name}`);
    return Boolean(cued && ledgerBanks.includes(cued.bankId));
  };
  // بانکِ خودمان طرف حساب نیست، جز در وام.
  if (!loanEvent) {
    for (const party of counterparties.filter((item) => isBank(item.name) && item.role !== 'bank')) {
      party.role = 'bank';
      violations.push(`counterparties.${party.id}:our-bank`);
    }
  }
  // جهت از فعلِ جمله. «شرکت آفتاب ۶ میلیون به ملت واریز کرد»: مدل نوشت پول از
  // شرکت آفتاب «رفت» به ملت. فعلِ سوم‌شخصِ واریز با مقصدِ بانکِ ما یعنی پول آمد؛
  // فعلِ اول‌شخص («پرداخت کردیم») با مبدأ بانکِ ما یعنی پول رفت.
  const isParty = (side) => Boolean(side?.name) && !isBank(side.name) && !/صندوق|تنخواه/.test(side.name);
  for (const movement of movements.filter((item) => ['in', 'out'].includes(item.direction))) {
    const clause = clauseOf(byId.get(movement.amountRef)?.evidence) || clauseOf(movement.evidence);
    if (!clause) continue;
    const theirs = THEIR_DEPOSIT.test(clause) && !OUR_PAYMENT.test(clause);
    const ours = OUR_PAYMENT.test(clause) && !THEIR_DEPOSIT.test(clause);
    if (movement.direction === 'out' && isParty(movement.from) && isBank(movement.to.name) && theirs) {
      Object.assign(movement, { direction: 'in', from: { kind: 'counterparty', name: movement.from.name }, to: { kind: 'bank', name: movement.to.name } });
      violations.push(`movements.${movement.id}:in-by-verb`);
    } else if (movement.direction === 'in' && isParty(movement.to) && isBank(movement.from.name) && ours) {
      Object.assign(movement, { direction: 'out', from: { kind: 'bank', name: movement.from.name }, to: { kind: 'counterparty', name: movement.to.name } });
      violations.push(`movements.${movement.id}:out-by-verb`);
    }
  }
  // طرف حسابی که مدل فقط در جابه‌جایی نام برد، در فهرست نام‌ها هم هست؛ بدونش تنها
  // نامِ فهرست جای او می‌نشست و دو معاملهٔ جدا قاطی می‌شد (آزمون بازبین، مهر ۱۴۰۵).
  for (const movement of movements) {
    for (const side of ['from', 'to']) {
      const name = movement[side]?.name;
      // فقط نامِ خاص («شرکت آفتاب»، «آقای کریمی»)، نه نقشی مثل «صاحبخانه».
      if (!isParty(movement[side]) || !PARTY_TITLE.test(name) || !found(name, textKey)) continue;
      if (counterparties.some((item) => item.name === name || item.name.includes(name) || name.includes(item.name))) continue;
      counterparties.push({ id: `c-${movement.id}-${side}`, name: cleanLabel(name, 100), role: 'other', evidence: cleanLabel(name, 200) });
      violations.push(`counterparties:added-from-${movement.id}`);
    }
  }
  const people = counterparties.filter((item) => !isBank(item.name));
  for (const movement of movements) {
    // «تنخواه» فقط وقتی تنخواه است که در جمله گفته شده باشد؛ «صندوق» صندوق است.
    for (const side of ['from', 'to']) {
      if (movement[side].kind === 'petty-cash' && !/تنخواه/.test(spoken)) {
        movement[side] = { kind: /صندوق/.test(movement[side].name || '') || /صندوق/.test(spoken) ? 'cash' : 'unknown', name: movement[side].name };
        violations.push(`movements.${movement.id}.${side}:not-petty-cash`);
      }
    }
    // پولِ وام از بانک وام‌دهنده به حساب ما «انتقال بین حساب‌های خودمان» نیست.
    if (eventKind === 'loan-received' && movement.direction === 'transfer') {
      Object.assign(movement, { direction: 'in', from: { kind: 'counterparty', name: movement.from.name } });
      violations.push(`movements.${movement.id}:loan-is-not-a-transfer`);
    }
    if (!['in', 'out'].includes(movement.direction)) continue;
    const cashKey = movement.direction === 'out' ? 'from' : 'to';
    const otherKey = cashKey === 'from' ? 'to' : 'from';
    const cash = movement[cashKey];
    if (!ACCOUNT_SIDES.has(cash.kind) && cash.name) {
      if (isBank(cash.name)) movement[cashKey] = { kind: 'bank', name: cash.name };
      else if (/صندوق/.test(cash.name)) movement[cashKey] = { kind: 'cash', name: cash.name };
    }
    // «از بانک سامان به شرکت قیاسی پرداخت کردیم»: مدل بانک را گیرنده نوشت. وقتی
    // سمتِ حساب خالی است و سمتِ دیگر نام بانک دارد، آن بانک حسابِ ماست — جز در
    // وام، که بانک واقعاً طرف حساب است.
    // «کارت به کارت کردن به ملت»: مدل بانک را فقط در فهرست نام‌ها آورد. سمتِ حسابِ
    // خالی، وقتی جمله فقط یک بانک دارد، همان بانک است.
    const namedBanks = counterparties.filter((item) => isBank(item.name));
    if (!ACCOUNT_SIDES.has(movement[cashKey].kind) && !loanEvent && !isBank(movement[otherKey].name) && namedBanks.length === 1) {
      movement[cashKey] = { kind: 'bank', name: namedBanks[0].name };
      violations.push(`movements.${movement.id}:bank-from-names`);
    }
    if (!ACCOUNT_SIDES.has(movement[cashKey].kind) && !loanEvent && isBank(movement[otherKey].name)) {
      movement[cashKey] = { kind: 'bank', name: movement[otherKey].name };
      movement[otherKey] = people.length === 1 ? { kind: 'counterparty', name: people[0].name } : { kind: 'unknown', name: null };
      violations.push(`movements.${movement.id}:bank-is-the-account`);
    }
  }

  const subject = {
    what: raw.subject?.what ? cleanLabel(raw.subject.what, 120) : null,
    kind: pick(raw.subject?.kind, SUBJECT_KINDS, null),
    use: pick(raw.subject?.use, SUBJECT_USES, 'unknown'),
    delivered: pick(raw.subject?.delivered, DELIVERY_STATES, 'unknown'),
    usefulLifeMonths: Number.isInteger(raw.subject?.usefulLifeMonths) && raw.subject.usefulLifeMonths > 0 ? raw.subject.usefulLifeMonths : null,
    evidence: raw.subject?.evidence ? cleanLabel(raw.subject.evidence, 300) : null,
  };
  // «برای فروش نیست» یا «عمر مفیدش سه سال است» فقط با شاهد پذیرفته می‌شود.
  if (subject.evidence && !foundLoosely(subject.evidence, textKey)) {
    violations.push('subject:evidence-not-found');
    subject.use = 'unknown';
    subject.usefulLifeMonths = null;
    subject.evidence = null;
  }
  if (!subject.evidence && (subject.use !== 'unknown' || subject.usefulLifeMonths)) {
    violations.push('subject:claims-without-evidence');
    subject.use = 'unknown';
    subject.usefulLifeMonths = null;
  }

  const conditions = raw.conditions.slice(0, 8).map((item) => ({
    kind: pick(item.kind, CONDITION_KINDS, 'condition'), text: cleanLabel(item.text, 200),
    affects: (item.affects || []).map((ref) => cleanLabel(ref, 20)).filter((ref) => byId.has(ref)),
    evidence: cleanLabel(item.evidence, 300),
  })).filter((item) => {
    const ok = foundLoosely(item.evidence, textKey);
    if (!ok) violations.push('conditions:evidence-not-found');
    return ok;
  });
  // جهتِ پول بر نامِ مدل مقدم است: بیعانه‌ای که به حساب ما آمد پیش‌دریافت است، نه
  // پیش‌پرداختِ ما. آزمون زنده (V18): مدل «پیش‌پرداخت» گفت و پول ورودی بود.
  const flows = movements.filter((item) => ['in', 'out'].includes(item.direction)).map((item) => item.direction);
  const advanceBy = { in: 'advance-received', out: 'advance-paid' };
  if (flows.length && new Set(flows).size === 1 && ['advance-paid', 'advance-received'].includes(eventKind) && advanceBy[flows[0]] !== eventKind) {
    violations.push(`event:${eventKind}-is-${advanceBy[flows[0]]}`);
    eventKind = advanceBy[flows[0]];
  }
  // قبض یا فاکتوری که آمده و هنوز پرداخت نشده، بدهیِ همین امروز است.
  //
  // آزمون زنده: مدل مبلغ قبض را «آینده» یا «پرداخت‌نشده» نامید — درست دربارهٔ
  // پول — و هیچ سندی ساخته نشد؛ بدهی به ادارهٔ برق گم شد. همان قاعدهٔ قطعیِ مسیر
  // فعلی (`readUnpaidSignal`) این‌جا هم داور است، و سفارش، پیش‌فاکتور یا قرار
  // آینده («قرار است») هرگز بدهی نمی‌سازد.
  // سوم‌شخص هم: «مستاجر اجاره رو هنوز نداده» همان «هنوز نگرفتیم» است؛ بی‌این،
  // مبلغ انجام‌شده می‌ماند و «پول به کدام حساب آمد؟» برای پولی که نیامده پرسیده می‌شد.
  const unpaidHere = { out: readUnpaidSignal(text), in: /هنوز[^.،؛!؟]{0,18}(?:ن(?:گرفتیم|گرفتم|گرفته|داده|دادن|دادند|ریخته|ریختن|ریختند)|(?:دریافت|واریز|پرداخت)\s*ن(?:شده|کرده|کردیم|کردن|کردند))|پول(?:ی)?\s*(?:هم\s*)?نگرفت/.test(spoken) };
  // «تموم کردیم و تحویل دادیم؛ قراره بدن»: «قرار» دربارهٔ پول است و طلب امروز هست
  // (آزمون زنده V15). «قرار» فقط وقتی چیزی را آینده می‌کند که تحویلی گفته نشده باشد.
  const deliveredInSpeech = /تحویل\s*(?:دادیم|دادم|گرفتیم|گرفتم|شد)|(?:تموم|تمام)\s*(?:کردیم|کردم|شد)|انجام\s*(?:دادیم|دادم|شد)/.test(spoken)
    && !/(?:نه|هنوز)\s*تحویل|تحویل\s*ن(?:دادیم|داده|گرفتیم|گرفته|شده)/.test(spoken);
  const notYetReal = /سفارش|پیش\s*فاکتور/.test(spoken) || (/قرار\s*(?:است|بود)|قراره/.test(spoken) && !deliveredInSpeech) || subject.delivered === 'no';
  const accrues = ['expense', 'purchase', 'asset-purchase', 'sale', 'income'].includes(eventKind) && !notYetReal;
  // «اجارهٔ ۶ ماه آینده ۳۰ میلیون شد ولی هنوز پرداخت نکردیم»: قراردادِ اجرانشده.
  // خدمتی که دوره‌اش هنوز نیامده و پولش هم نرفته، امروز نه هزینه است نه بدهی؛
  // تبدیلش به «بدهیِ پرداخت‌نشده» شش ماه اجارهٔ آینده را امروز هزینه می‌کرد
  // (موتور ۵). دوره‌ای که از ماهِ جاری جلوتر می‌رود — گفته‌شده یا از تاریخ پوشش —
  // بدهیِ خودکار نمی‌سازد و با حسابدار است؛ همان کاری که مسیر قطعی می‌کند.
  const today = todayPersian(now, timeZone);
  const thisMonthEnd = Date.parse(persianMonthEnd(today.year, today.month, timeZone) || '') || Infinity;
  const spokenPeriod = readServicePeriod(text, { occurredAt: new Date(now).toISOString() });
  const futureCoverage = (spokenPeriod && Date.parse(spokenPeriod.end) > thisMonthEnd)
    || dates.some((date) => date.accepted && ['coverage-start', 'coverage-end'].includes(date.role) && Date.parse(date.iso) > thisMonthEnd);
  const executory = new Set();
  const becameObligation = new Set();
  for (const condition of conditions.filter((item) => item.kind === 'negation')) {
    for (const ref of condition.affects) {
      // نفیِ «پرداخت آینده»ای که جزء یک کل است، دربارهٔ همان کل است.
      const target = byId.get(ref)?.role === 'future-payment' && byId.get(ref)?.partOf ? byId.get(byId.get(ref).partOf) : byId.get(ref);
      if (!accrues || !target?.accepted || becameObligation.has(target.id)) continue;
      const own = movements.filter((item) => item.amountRef === target.id || item.amountRef === ref);
      // جهت از نوع رویداد: مدل در «هنوز پولی نگرفتیم» جابه‌جایی را «خروج» نوشت.
      const direction = ['sale', 'income'].includes(eventKind) ? 'in' : 'out';
      if (!unpaidHere[direction]) continue;
      if (futureCoverage) { executory.add(target.id); continue; }
      target.status = 'done';
      for (const item of own) { item.direction = 'none'; item.amountRef = target.id; }
      if (!own.length) movements.push({ id: `${target.id}-unpaid`, amountRef: target.id, direction: 'none', from: { kind: 'unknown', name: null }, to: { kind: 'unknown', name: null }, evidence: condition.evidence });
      becameObligation.add(target.id);
      violations.push(`amounts.${target.id}:unpaid-obligation`);
    }
  }
  // «قبض ... اومده، موعد پرداختش هفته بعده»: مدل نفی‌ای نگفت ولی داورِ قطعیِ مسیر
  // فعلی می‌گوید پرداخت نشده. آزمون زنده (T008): مبلغ «آینده» ماند و بدهی گم شد.
  // فقط وقتی یک مبلغ در میان است و هیچ پرداخت انجام‌شدهٔ دیگری گفته نشده.
  if (unpaidHere.out && !becameObligation.size && !['sale', 'income'].includes(eventKind) && (accrues || (eventKind === 'obligation' && !notYetReal))) {
    const candidates = amounts.filter((item) => item.accepted && !isRetracted(item.id) && ['total', 'other'].includes(item.role) && ['done', 'future'].includes(item.status));
    const othersDone = amounts.some((item) => item.accepted && !isRetracted(item.id) && item.status === 'done' && !candidates.includes(item));
    if (candidates.length === 1 && !othersDone && futureCoverage) executory.add(candidates[0].id);
    else if (candidates.length === 1 && !othersDone) {
      const [target] = candidates;
      target.status = 'done';
      const own = movements.filter((item) => item.amountRef === target.id);
      for (const item of own) item.direction = 'none';
      if (!own.length) movements.push({ id: `${target.id}-unpaid`, amountRef: target.id, direction: 'none', from: { kind: 'unknown', name: null }, to: { kind: 'unknown', name: null }, evidence: '' });
      becameObligation.add(target.id);
      violations.push(`amounts.${target.id}:unpaid-obligation`);
    }
  }
  for (const id of executory) {
    // پولی هم جابه‌جا نشده: هیچ سطر نقدی، هیچ سؤال «از کدام حساب».
    byId.get(id).status = 'future';
    for (const movement of movements.filter((item) => item.amountRef === id)) movement.direction = 'none';
    violations.push(`amounts.${id}:executory-contract`);
    ask(`amounts.${id}.executory`, 'judgment', `«${byId.get(id)?.evidence || id}» برای دورهٔ آینده است و هنوز پرداخت نشده؛ قراردادِ اجرانشده امروز هزینه یا بدهی نمی‌سازد و ثبتش با حسابدار است.`);
  }
  // «اجارهٔ شش ماه آینده را ... پرداخت کردیم»: «آینده» دربارهٔ دورهٔ اجاره است، نه
  // پول. مبلغی که مدل «آینده» نامید ولی جابه‌جایی‌اش با فعلِ انجام‌شده آمده، انجام
  // شده است. آزمون زنده (V10): هیچ سندی ساخته نشد.
  //
  // فعل فقط در شاهدِ جابه‌جایی نیست: مدل شاهد را «از تجارت» نوشت و فعلِ «پرداخت
  // کردیم» در دنبالهٔ بندِ خودِ مبلغ ماند؛ پرداخت ۳۰ میلیونی گم می‌شد (موتور ۵).
  // دنبالهٔ بند، از پایان شاهدِ مبلغ تا مرز بعدی است؛ «بقیه رو ماه بعد میدیم» فعل
  // انجام‌شده‌ای ندارد و «۴ میلیون دادیم»ِ پیش از آن به آن نمی‌رسد.
  const tailOf = (evidence) => {
    const key = normalizePersian(evidence || '').trim();
    const clause = clauseOf(evidence);
    const at = key ? clause.indexOf(key) : -1;
    return at < 0 ? '' : clause.slice(at + key.length);
  };
  const hedged = new Set(conditions.filter((item) => ['negation', 'condition', 'promise'].includes(item.kind)).flatMap((item) => item.affects));
  for (const movement of movements.filter((item) => ['in', 'out', 'transfer'].includes(item.direction))) {
    const amount = byId.get(movement.amountRef);
    if (!amount?.accepted || amount.status !== 'future' || STATUS_BY_ROLE[amount.role] || hedged.has(amount.id) || becameObligation.has(amount.id)) continue;
    const said = normalizePersian(movement.evidence || '');
    const tail = tailOf(amount.evidence);
    const doneHere = said && foundLoosely(movement.evidence, textKey) && DONE_MONEY_VERB.test(said) && !NOT_YET.test(said);
    if (!doneHere && !(DONE_MONEY_VERB.test(tail) && !NOT_YET.test(tail))) continue;
    amount.status = 'done';
    violations.push(`amounts.${amount.id}:done-in-speech`);
  }
  // «اگر تأیید کنیم، فردا ۱۵ میلیون بیعانه می‌دهیم»: مبلغی که مدل «انجام‌شده»
  // نامید ولی بندِ خودش آینده یا شرطی است و فعلِ انجام‌شده ندارد، امروز ثبت نمی‌شود
  // (گزارش بازبین، مهر ۱۴۰۵). پولِ نسیهٔ امروز (بدون جابه‌جایی وجه) دست نمی‌خورد.
  for (const movement of movements.filter((item) => ['in', 'out', 'transfer'].includes(item.direction))) {
    const amount = byId.get(movement.amountRef);
    if (!amount?.accepted || amount.status !== 'done' || becameObligation.has(amount.id) || amount.role === 'credit-part') continue;
    // «پس می‌گیریم»، «برمی‌گردانند»: استردادِ آینده است، نه زمانِ همین پرداخت.
    // «اجاره برای شش ماه آینده»: طولِ دورهٔ پوشش است، نه زمانِ پول. در «۳۰ میلیون
    // اجاره دفتر برای شش ماه آینده و ۲ میلیون قبض برق از تجارت دادیم» فعلِ مشترکِ
    // آخر جمله در بندِ اجاره نیست و «ماه آینده» اجارهٔ پرداخت‌شده را آینده می‌کرد.
    const clause = (clauseOf(amount.evidence) || clauseOf(movement.evidence))
      .replace(/پس\s*می[\s‌]*(?:گیریم|گیرند|دهیم|دهند|دیم)|بر\s*می[\s‌]*گردان\S*/g, ' ')
      .replace(COVERAGE_LENGTH, ' ');
    if (!clause.trim() || !FUTURE_CLAUSE.test(clause) || DONE_CLAUSE.test(clause)) continue;
    amount.status = CONDITION_CLAUSE.test(sentenceOf(amount.evidence) || clause) ? 'conditional' : 'future';
    violations.push(`amounts.${amount.id}:${amount.status}-in-speech`);
  }
  // نفی‌ای که مبلغی را «پرداخت‌نشده» می‌کند بر جابه‌جاییِ همان مبلغ مقدم است:
  // «خریدیم ولی هنوز پولش رو ندادیم» خروج وجه نیست.
  for (const condition of conditions.filter((item) => item.kind === 'negation' && [item.evidence, item.text].some((said) => PAYMENT_NEGATION.test(normalizePersian(said || ''))))) {
    for (const ref of condition.affects) {
      if (becameObligation.has(ref)) continue;
      for (const movement of movements.filter((item) => item.amountRef === ref && ['in', 'out'].includes(item.direction))) {
        const amount = byId.get(ref);
        if (amount?.status === 'done') {
          violations.push(`movements.${movement.id}:negated`);
          ask(`movements.${movement.id}.done`, 'information', `«${amount.evidence}» واقعاً پرداخت یا دریافت شده یا هنوز نه؟`, ['انجام شده', 'هنوز انجام نشده']);
        }
      }
    }
  }

  // --- ابهام‌های خودِ مدل ----------------------------------------------------
  for (const item of raw.ambiguities.slice(0, 8)) {
    const field = cleanLabel(item.field, 80);
    const question = cleanLabel(item.question, 200);
    if (!field || !question) continue;
    ask(field, pick(item.kind, AMBIGUITY_KINDS, 'judgment'), question, (item.options || []).slice(0, 5).map((option) => cleanLabel(option, 60)).filter(Boolean), 'model');
  }

  // برای هر مبلغ یک جابه‌جایی: آن‌که جهت روشن و حساب مشخص دارد. بدهیِ
  // پرداخت‌نشده (جهت «هیچ») عمداً بر خروجِ نفی‌شده مقدم است.
  const clarity = (movement) => {
    if (becameObligation.has(movement.amountRef)) return movement.direction === 'none' ? 9 : 0;
    const cash = movement.direction === 'out' ? movement.from : movement.direction === 'in' ? movement.to : null;
    return (['in', 'out'].includes(movement.direction) ? 2 : movement.direction === 'transfer' ? 1 : 0) + (cash && ACCOUNT_SIDES.has(cash.kind) && cash.name ? 1 : 0);
  };
  const chosen = new Map();
  for (const movement of movements) {
    const previous = chosen.get(movement.amountRef);
    if (!previous || clarity(movement) > clarity(previous)) chosen.set(movement.amountRef, movement);
  }
  const uniqueMovements = movements.filter((movement) => chosen.get(movement.amountRef) === movement);

  // اصلاح‌هایی که می‌مانند: اگر جمله خودش تصمیم گرفته، فقط اصلاحِ برآمده از جمله.
  // آزمون زنده: اصلاحِ مدل کنار می‌رفت و اصلاحِ جمله هم، چون مدل همان عدد را
  // گفته بود، کنار گذاشته می‌شد؛ «۱۲، نه ببخشید ۱۵» هر دو را ثبت کرد.
  const keptConditions = conditions.filter((item) => trustModelCorrections || item.kind !== 'correction');
  return {
    ok: true,
    violations,
    understanding: {
      version: UNDERSTANDING_VERSION,
      event: {
        kind: eventKind,
        description: cleanLabel(raw.event?.description, 200),
        status: pick(raw.event?.status, EVENT_STATUSES, 'done'),
      },
      amounts: amounts.map(({ raw: _raw, ...amount }) => amount),
      nonAmountNumbers, dates, counterparties, movements: uniqueMovements, subject,
      conditions: [...keptConditions, ...retracted
        .filter((id) => !keptConditions.some((item) => item.kind === 'correction' && item.affects.includes(id)))
        .map((id) => ({ kind: 'correction', text: 'اصلاحِ همان گفته', affects: [id], evidence: '', source: 'validator' }))],
      ambiguities,
    },
  };
}
