import { normalizePersian } from './normalize.js';
import { extractAmounts } from './parser.js';

/**
 * باقی یا قسطِ قراردادی که از پیش وجود دارد.
 *
 * «باقی حق بیمه انبار ۹ میلیون رو هم دادیم»، «قسط دوم بیمه آتش سوزی ۳ میلیون»،
 * «بقیه اجاره رو مستاجر واریز کرد»: قرارداد، دوره‌اش و بدهی یا طلب باقی‌اش
 * پیش‌تر ثبت شده. این پول همان بدهی یا طلب را می‌بندد؛ ساختن دورهٔ پوشش تازه
 * برایش، یک قرارداد را دو بار دارایی می‌کرد و بدهی بیمه‌گر را باز می‌گذاشت.
 * «قسط» این‌جا قسط وام نیست — اصل و سودی ندارد.
 *
 * سه حالت:
 * - `remainder`: باقی/بقیه/مابقی/باقیمانده‌ی یک قرارداد، همین حالا پرداخت یا دریافت شد؛
 * - `later-instalment`: قسط، نوبت یا پرداختِ دوم به بعد (یا «قسط بعدی/آخر»)؛
 * - `instalment`: قسطِ یک قرارداد بی‌شماره یا قسط اول — آغاز قرارداد قسطی که
 *   کل مبلغ و بدهی باقی‌اش در جمله نیست؛ جایش حسابدار است، نه پیش‌پرداخت تازه.
 *
 * «بقیه رو قسطی میدیم» (آینده) و «قسط وام بانک» هیچ‌کدام نیستند.
 */
const CONTRACT = '(?:حق\\s*(?:بیمه|اشتراک|عضویت)|بیمه\\s*نامه|بیمه|اجاره|کرایه|اشتراک|لایسنس|قرارداد|رهن)';
const CONTRACT_AT = new RegExp(`^${CONTRACT}`);
// «باقی/بقیه/مابقی/باقیمانده»، با ضمیر («باقیش»، «بقیه‌اش»، «مابقیش») و با «پول/مبلغ»
// («بقیه پولش»، «باقی مبلغ»). ضمیر یعنی باقیِ همان چیزی که پیش‌تر نام برده شد.
const POSSESSIVE = '(?:ی|اش|ش|شو|شون|شان)(?![آ-ی])';
const REMAINDER_WORD = new RegExp(`(?<![آ-ی])(?:باقی\\s*مانده|مابقی|الباقی|باقی|بقیه|بقی(?=\\s*(?:ش|اش|شو)(?![آ-ی])))(\\s*${POSSESSIVE})?(?:\\s*(پول|مبلغ|وجه)(?![آ-ی])(\\s*${POSSESSIVE})?)?`, 'g');
// فعلِ جابه‌جایی پول جملهٔ قبلی را می‌بندد: «اجاره دفتر رو دادیم، بقیه پول رو به
// حساب ملت ریختیم» باقیِ اجاره نیست.
const MONEY_VERB = /^(?:دادیم|دادم|داد|دادن|دادند|کردیم|کردم|کرد|کردن|کردند|ریختیم|ریختم|ریخت|ریختن|ریختند|زدیم|زدم|زد|زدن|گرفتیم|گرفتم|گرفت|گرفتن|پرداختیم|پرداختم|میدیم|میدم|میده|میدن)$/;
const SETTLED_PASSIVE = /^(?:پرداخت|واریز|تسویه|کم|کسر)$/;
// همان باقی، اگر هنوز پرداخت نشده: «بقیه بیمه رو قسطی میدیم».
const NOT_YET = /^[^،,.؛]*?(?:(?<![آ-ی])می\s*(?:دیم|دهیم|پردازیم|ریزیم|گیریم)|بعدا|بعداً|قسطی|خواهیم|(?:می\s*)?کنیم(?![آ-ی]))/;
// قسط یا نوبت یا پرداختِ دوم به بعد: «قسط دوم بیمه»، «نوبت دوم حق بیمه»، «پرداخت دوم
// بیمه انبار»، «آخرین قسط بیمه‌نامه».
const ORDINAL = '(?:دوم|سوم|چهارم|پنجم|ششم|هفتم|هشتم|نهم|دهم|یازدهم|دوازدهم|بعدی|آخر|(?:[2-9]|1[0-2]|[۲-۹]|۱[۰-۲])(?![\\d۰-۹]))';
const PART_NOUN = '(?:قسط|نوبت|پرداخت|مرحله)';
const LATER_INSTALMENT = new RegExp(`(?<![آ-ی]|پیش\\s*)${PART_NOUN}\\s*${ORDINAL}(?![آ-ی])|(?:دومین|سومین|چهارمین|پنجمین|ششمین|آخرین)\\s*${PART_NOUN}(?![آ-ی])`, 'g');
const LOAN_INSTALMENT = /اصل\s*(?:وام|تسهیلات)|قسط\s*(?:\S+\s*){0,2}(?:وام|تسهیلات|بانک|لیزینگ)(?![آ-ی])|(?:وام|تسهیلات|لیزینگ)\s*(?:\S+\s*){0,3}قسط/;

// «مابقی حق بیمه رو برگردوندن»: استرداد بخش مصرف‌نشده است، نه پرداخت باقی
// قرارداد؛ مسیر استرداد آن را به قرارداد و برنامه‌اش وصل می‌کند.
const REFUND = /برگشت|برگردوند|برگرداند|(?<![آ-ی])پس\s*(?:داد|دادن|دادند|گرفت|میده|میدن)|استرداد|عودت|مرجوع|کنسل|فسخ|لغو/;

const words = (part) => part.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/[،,]/g, '')).filter(Boolean);

// میان «باقی» و قرارداد فقط پرکننده‌ها و خود مبلغ می‌آیند: «بقیه ۹ میلیون رو به بیمه
// ایران»، «باقی مونده اقساط حق بیمه»، «مابقیش رو بابت اجاره». «بقیه کارمندا بیمه
// ندارن» باقیِ کارمندان است، نه باقی بیمه.
const FILLER = /^(?:رو|را|هم|و|به|بابت|از|مربوط|مونده|مانده|اقساط|قسط|قسطهای|پول|پولش|مبلغ|مبلغش|وجه|ی|میلیون|میلیارد|هزار|تومان|تومن|ریال|[\d.,/٫]+)$/;

/** قرارداد در چند کلمهٔ بعد، پیش از هر نقطه، ویرگول یا فعل پرداخت. */
function contractFollows(after, maxBetween) {
  const tokens = words(after.split(/[،,.؛!?]/)[0]);
  for (let index = 0; index <= Math.min(maxBetween, tokens.length - 1); index += 1) {
    if (CONTRACT_AT.test(tokens.slice(index).join(' '))) return true;
    if (!FILLER.test(tokens[index])) return false;
  }
  return false;
}

/**
 * قرارداد در چند کلمهٔ قبل، در همان جمله: «بیمه یکساله انبار، باقیش رو …».
 * ویرگول را رد می‌کند، فعل پرداخت را نه — بعد از فعل، جملهٔ تازه‌ای شروع شده.
 */
function contractPrecedes(before, maxBetween) {
  const tokens = words(before.split(/[.؛!?]/).at(-1));
  for (let index = tokens.length - 1, seen = 0; index >= 0 && seen <= maxBetween; index -= 1, seen += 1) {
    if (MONEY_VERB.test(tokens[index]) || (tokens[index] === 'شد' && SETTLED_PASSIVE.test(tokens[index - 1] || ''))) return false;
    if (CONTRACT_AT.test(tokens.slice(index).join(' '))) return true;
  }
  return false;
}

/** همهٔ نشانه‌های باقی یا قسطِ قرارداد در جمله، با جایشان. */
function contractPartCues(text) {
  const cues = [];
  for (const match of text.matchAll(REMAINDER_WORD)) {
    const [, ownerAfterWord, moneyNoun, ownerAfterMoney] = match;
    const after = text.slice(match.index + match[0].length);
    if (NOT_YET.test(after)) continue;
    // «بقیه پول اجاره»: «پولِ» بی‌ضمیر فقط با قراردادِ چسبیده؛ «باقی پول رو برای
    // اجاره گذاشتیم کنار» باقی پولِ ماست، نه باقی اجاره.
    const bareMoney = moneyNoun && !ownerAfterWord && !ownerAfterMoney;
    if (contractFollows(after, bareMoney ? 0 : 4) || contractPrecedes(text.slice(0, match.index), 6)) {
      cues.push({ cue: 'remainder', index: match.index });
    }
  }
  if (!LOAN_INSTALMENT.test(text) && new RegExp(CONTRACT).test(text)) {
    // «قسط بعدی بیمه رو ماه دیگه میدیم» هم قسطِ همان قرارداد است — پرداختش هنوز
    // نشده و کارت تسویه باز نمی‌شود (فعل پرداخت ندارد)، ولی قرارداد تازه هم نیست.
    for (const match of text.matchAll(LATER_INSTALMENT)) cues.push({ cue: 'later-instalment', index: match.index });
    // «قسطی میدیم» شیوهٔ پرداخت باقی است، نه قسط.
    const bare = /(?<![آ-ی])قسط(?![آ-ی])/.exec(text);
    if (!cues.some((item) => item.cue === 'later-instalment') && bare) cues.push({ cue: 'instalment', index: bare.index });
  }
  return cues.sort((left, right) => left.index - right.index);
}

/**
 * «قسط» یک قرارداد (بیمه، اجاره، اشتراک)، نه وام — حتی وقتی پرداختش هنوز نشده:
 * «قسط بعدی بیمه رو ماه دیگه میدیم». برچسب «اصل و سود وام» برایش غلط است.
 */
export function isContractInstalment(input) {
  const text = normalizePersian(input);
  return Boolean(text) && /(?<![آ-ی])قسط(?![آ-ی])/.test(text) && new RegExp(CONTRACT).test(text)
    && !LOAN_INSTALMENT.test(text) && !/(?<![آ-ی])(?:وام|تسهیلات|لیزینگ|قرض)(?![آ-ی])/.test(text);
}

const amountSpans = (text) => extractAmounts(text).spans.filter((span) => Number.isSafeInteger(span.amount) && span.amount > 0);

// مرز هر تکهٔ پولیِ جمله، فعلِ پرداخت یا دریافت آن است: «حقوق کارگرها ۴۰ میلیون
// دادیم، | قسط دوم بیمه ۳ میلیون هم دادیم».
const CLAUSE_END = /(?<![آ-ی])(?:دادیم|دادم|دادند|دادن|داد|کردیم|کردم|کردند|کردن|کرد|ریختیم|ریختم|ریختند|ریختن|ریخت|زدیم|زدم|گرفتیم|گرفتم|گرفتن|گرفت|پرداختیم|پرداختم|شد)(?![آ-ی])/g;
function clauseOf(text, position) {
  let clause = 0;
  for (const match of text.matchAll(CLAUSE_END)) if (match.index + match[0].length <= position) clause += 1;
  return clause;
}

/**
 * نوع باقی یا قسطِ قرارداد؛ با `amount`، فقط اگر همان ردیف باشد.
 *
 * جملهٔ چندپرداختی — «حقوق کارگرها ۴۰ میلیون دادیم، قسط دوم بیمه ۳ میلیون هم
 * دادیم» — دو ردیف دارد و نشانهٔ قسط فقط مال ردیفِ تکهٔ خودش است. وقتی مبلغ
 * ردیف در جمله پیدا نشود، احتیاط: نشانه برای همهٔ ردیف‌ها می‌ماند.
 */
export function readsContractRemainder(input, { amount } = {}) {
  const text = normalizePersian(input);
  if (!text || REFUND.test(text)) return null;
  const cues = contractPartCues(text);
  if (!cues.length) return null;
  const spans = amountSpans(text);
  if (amount == null || spans.length <= 1) return cues[0].cue;
  const own = spans.filter((span) => span.amount === Number(amount));
  if (!own.length) return cues[0].cue;
  const clauses = new Set(own.map((span) => clauseOf(text, span.start)));
  return cues.find((item) => clauses.has(clauseOf(text, item.index)))?.cue || null;
}

/**
 * باقی یا قسطِ قرارداد وقتی کل جمله همان یک پرداخت است — و کارت تسویه با یک
 * مبلغ درستش را می‌بندد. جملهٔ چندمبلغی را یک کارت تسویه نمی‌بلعد: ردیف‌ها جدا
 * می‌مانند و ردیف قسط از نگهبان موتور تصمیم به حسابدار می‌رود.
 */
export function readsWholeContractRemainder(input) {
  const text = normalizePersian(input);
  if (!text || amountSpans(text).length > 1) return null;
  return readsContractRemainder(text);
}

/** پولی که بابت یک طلب یا بدهی موجود جابه‌جا شده، تعهد تازه نیست. */
export function priorSettlementDirection(input) {
  const text = normalizePersian(input);
  if (!text) return null;
  const received = /(?:دریافت\s*(?:کردم|کردیم|شد|شده)|گرفت(?:م|یم)|وصول\s*(?:شد|شده|کردم|کردیم)|به\s*حساب(?:م|مان|مون)?\s*واریز\s*(?:شد|کرد))/.test(text);
  const paid = /(?:پرداخت\s*(?:کردم|کردیم|شد|شده)|داد(?:م|یم)|تسویه\s*(?:کردم|کردیم|شد))/.test(text);
  if (received && /(?:طلب|مطالبه|حساب\s*دریافتنی)/.test(text)) return 'receivable';
  if (paid && /(?:بدهی|حساب\s*پرداختنی)/.test(text)) return 'payable';
  // مالکیتِ طلب یا بدهی هم جهت را می‌گوید، با فعل سوم‌شخص: «شرکت نوین ۲۰ میلیون از
  // بدهی‌اش را واریز کرد» یعنی بدهیِ او به ما — وصول طلب ما. «طلبش را دادیم» یعنی
  // طلبِ او از ما — پرداخت بدهی ما.
  const theirPayment = /(?:واریز|پرداخت|کارت\s*به\s*کارت|تسویه)\s*(?:کرد|کردن|کردند)(?![آ-ی])|(?<![آ-ی])(?:داد|دادن|دادند|ریخت|ریختن|ریختند|زد|زدن)(?![آ-ی])/.test(text);
  const ourPayment = /(?:واریز|پرداخت|کارت\s*به\s*کارت|تسویه)\s*(?:کردم|کردیم)|(?<![آ-ی])(?:دادیم|دادم|ریختیم|ریختم|زدیم|زدم)(?![آ-ی])/.test(text);
  const theirDebt = /بدهی\s*(?:ش|اش|شون|شان|خودش|خودشون)(?![آ-ی])|بدهیش|بدهیشون|بدهکاریش|از\s*طلب\s*(?:مون|مان|ما)(?![آ-ی])|طلب(?:مون|مان)(?![آ-ی])|طلب\s*ما(?![آ-ی])/.test(text);
  const theirClaim = /طلب\s*(?:ش|اش|شون|شان|خودش|خودشون)(?![آ-ی])|طلبش|طلبشون|از\s*بدهی\s*(?:مون|مان|ما)(?![آ-ی])|بدهی(?:مون|مان)(?![آ-ی])|بدهی\s*ما(?![آ-ی])/.test(text);
  if (theirDebt && theirPayment && !ourPayment) return 'receivable';
  if (theirClaim && ourPayment && !theirPayment) return 'payable';
  // باقی یا قسط بعدیِ قرارداد موجود: جهت را فعل می‌گوید — «دادیم/پرداخت شد»
  // بدهی ما، «مستاجر واریز کرد» طلب ما.
  if (['remainder', 'later-instalment'].includes(readsWholeContractRemainder(text))) {
    if ((paid || ourPayment) && !theirPayment) return 'payable';
    if ((received || theirPayment) && !ourPayment) return 'receivable';
  }
  return null;
}
