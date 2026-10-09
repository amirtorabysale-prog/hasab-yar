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
import { extractAmounts } from './parser.js';
import { normalizePersian } from './normalize.js';
import { extractDateMention, persianToISO, readJalaliExpression, todayPersian } from './persianDate.js';
import { FORBIDDEN_FACT_FIELDS } from './aiFactContract.js';
import { detectBank } from './banks.js';

export const UNDERSTANDING_VERSION = 'event-understanding/v1';

export const UNDERSTANDING_EVENT_KINDS = Object.freeze([
  'purchase', 'sale', 'expense', 'income', 'settlement', 'loan-received', 'loan-repayment', 'capital-in',
  'owner-drawing', 'transfer', 'payroll', 'asset-purchase', 'advance-paid', 'advance-received', 'deposit',
  'refund', 'correction', 'obligation', 'cheque', 'other',
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
  'loan-repayment': /وام|تسهیلات|قسط/,
  payroll: /حقوق|دستمزد|لیست\s*بیمه|کارکنان|پرسنل/,
  correction: /اشتباه|اصلاح|تصحیح|غلط/,
  refund: /برگشت|مرجوع|استرداد|عودت|پس\s*(?:دادیم|گرفتیم|دادن|داد)/,
  cheque: /چک/,
});

/** «نه»، «ببخشید»، «منظورم» میان دو عدد: عدد اول پس گرفته شد. */
const RETRACT = /[،,]?\s*(?:نه\s*[،,]?\s*ببخشید|نه|ببخشید|منظورم)\s*[،,]?\s*/g;
const SPLIT_PART_ROLES = new Set(['cash-part', 'credit-part', 'paid-now', 'received-now', 'part', 'future-payment']);
const ACCOUNT_SIDES = new Set(['bank', 'cash', 'petty-cash']);
const POSTING_DATE_ROLES = new Set(['payment', 'occurrence', 'coverage-start', 'coverage-end']);

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
  return normalizePersian(value).replace(/[«»"'“”()[\]{}،,؛;:!؟?.\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
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
      amount: span.amount, rial,
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
function verifyExplicitAmount(amount, evidence) {
  const claimed = Number(amount.value);
  const reads = readEvidenceAmounts(evidence);
  const candidates = reads.filter((read) => read.cue || read.colloquial).map((read) => {
    const rial = read.rial || amount.currency === 'rial';
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
 */
function jalaliIso({ year, month, day }, role, now, timeZone) {
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
  if (!PAST_DATE_ROLES.has(role) && !future && ['due', 'coverage-end', 'delivery', 'installment-start'].includes(role)
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
function resolveDate(date, { now, timeZone }) {
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
      : jalaliIso({ year: null, month: spoken.month, day: end ? null : (spoken.day ?? 1) }, end ? 'coverage-end' : date.role, now, timeZone);
    return { iso, issue: iso ? null : 'unresolved' };
  }
  const fromRelative = date.relative ? relativeIso(date.relative, now, timeZone) : null;
  const jalali = date.jalali && Number.isInteger(date.jalali.month) ? jalaliIso(date.jalali, date.role, now, timeZone) : null;
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
export function validateUnderstanding(raw, { text = '', now = new Date(), timeZone = 'Asia/Tehran' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, violations: ['payload'], understanding: null };
  const structural = structuralViolations(raw);
  const shape = ['event', 'amounts', 'nonAmountNumbers', 'dates', 'counterparties', 'movements', 'subject', 'conditions', 'ambiguities']
    .filter((key) => raw[key] === undefined || (key !== 'event' && key !== 'subject' && !Array.isArray(raw[key])))
    .map((key) => `${key}:shape`);
  if (structural.length || shape.length) return { ok: false, violations: [...structural, ...shape], understanding: null };

  const textKey = evidenceKey(text);
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
      const verified = segments(amount.evidence).map((part) => verifyExplicitAmount(amount.raw, part)).find(Boolean) || null;
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
  const byValue = new Map();
  for (const amount of amounts.filter((item) => item.accepted && item.provenance === 'explicit')) {
    byValue.set(amount.value, [...(byValue.get(amount.value) || []), amount]);
  }
  for (const [value, group] of byValue) {
    const allowed = Math.max(1, mentions.get(value) || 0);
    if (group.length <= allowed) continue;
    const ordered = [...group].sort((left, right) => generality(left.role) - generality(right.role));
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
    const target = amounts.find((item) => item.accepted && item.value === value && !retracted.includes(item.id));
    if (target) { retracted.push(target.id); violations.push(`amounts.${target.id}:retracted-in-speech`); }
  }
  const modelRetracted = raw.conditions.filter((item) => item?.kind === 'correction').flatMap((item) => item.affects || []);
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
  for (const amount of amounts) {
    if (amount.basis === 'inferred') amount.issue = 'inferred';
    // تکرارِ همان عدد سؤال نمی‌خواهد؛ عددش در مبلغِ نگه‌داشته‌شده هست.
    if (amount.accepted || amount.issue === 'same-mention') continue;
    violations.push(`amounts.${amount.id}:${amount.issue}`);
    // فقط مبلغی که سند می‌سازد می‌پرسد. زمینه، آینده و مشروط ثبت نمی‌شوند؛
    // نامعلوم‌بودن عددشان هیچ سندی را غلط نمی‌کند و سؤالش فقط ثبت را معطل می‌کرد.
    // کلِ نامعلوم وقتی اجزای انجام‌شده هست، مانع ثبت نیست: پول را اجزا جابه‌جا می‌کنند.
    if (amount.status === 'done' && !(amount.role === 'total' && otherDone)) {
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
    const resolved = resolveDate(date, { now, timeZone });
    return { ...date, iso: resolved.iso, accepted: Boolean(resolved.iso), issue: resolved.issue };
  });
  for (const date of dates.filter((item) => !item.accepted)) {
    violations.push(`dates.${date.id}:${date.issue}`);
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
  const loanEvent = ['loan-received', 'loan-repayment'].includes(eventKind);
  const isBank = (name) => Boolean(name && detectBank(name));
  const people = counterparties.filter((item) => !isBank(item.name));
  for (const movement of movements) {
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
    if (!ACCOUNT_SIDES.has(movement[cashKey].kind) && !loanEvent && isBank(movement[otherKey].name)) {
      movement[cashKey] = { kind: 'bank', name: movement[otherKey].name };
      movement[otherKey] = people.length === 1 ? { kind: 'counterparty', name: people[0].name } : { kind: 'unknown', name: null };
      violations.push(`movements.${movement.id}:bank-is-the-account`);
    }
  }
  // برای هر مبلغ یک جابه‌جایی: آن‌که جهت روشن و حساب مشخص دارد.
  const clarity = (movement) => {
    const cash = movement.direction === 'out' ? movement.from : movement.direction === 'in' ? movement.to : null;
    return (['in', 'out'].includes(movement.direction) ? 2 : movement.direction === 'transfer' ? 1 : 0) + (cash && ACCOUNT_SIDES.has(cash.kind) && cash.name ? 1 : 0);
  };
  const chosen = new Map();
  for (const movement of movements) {
    const previous = chosen.get(movement.amountRef);
    if (!previous || clarity(movement) > clarity(previous)) chosen.set(movement.amountRef, movement);
  }
  const uniqueMovements = movements.filter((movement) => chosen.get(movement.amountRef) === movement);

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
  // نفی‌ای که مبلغی را «پرداخت‌نشده» می‌کند بر جابه‌جاییِ همان مبلغ مقدم است:
  // «خریدیم ولی هنوز پولش رو ندادیم» خروج وجه نیست.
  for (const condition of conditions.filter((item) => item.kind === 'negation')) {
    for (const ref of condition.affects) {
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
      conditions: [...conditions, ...retracted
        .filter((id) => !conditions.some((item) => item.kind === 'correction' && item.affects.includes(id)))
        .map((id) => ({ kind: 'correction', text: 'اصلاحِ همان گفته', affects: [id], evidence: '', source: 'validator' }))],
      ambiguities,
    },
  };
}
