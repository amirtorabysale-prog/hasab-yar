import { normalizePersian } from './normalize.js';
import { parseFinancialText } from './parser.js';
import { extractOccurrenceDate } from './persianDate.js';

/**
 * پولی که از حساب شخصیِ کسی جز خودِ شرکت گذشت.
 *
 * پارسر هر جمله را یک پولِ ورودی یا خروجیِ صندوق یا بانک شرکت می‌خواند. ولی
 * خانواده‌ای از رویدادها هست که پولش هرگز از حساب شرکت نگذشته:
 *
 *   پرداخت از پول شخصی (منبع پول: جاری شریک، یا پرداختنیِ کارمند)
 *     ۱. بدهیِ شرکت را بست      «مدیرعامل ماشینش را فروخت و بدهی آریا را داد»
 *     ۲. هزینه‌ای را مستقیم داد   «مدیرعامل اجارهٔ دفتر را از جیب خودش داد»
 *     ۳. برای شرکت خرید کرد      «آقای سهرابی با پول شخصی‌اش مواد اولیه خرید»
 *     ۴. همان سه، از کارمند      «کارمندمان بنزین ماشین شرکت را از جیبش داد»
 *
 *   دریافت در حساب شخصی (مقصد پول: جاری شریک)
 *     ۵. طلبِ شرکت را گرفت       «شرکت نوین از بدهی‌اش به حساب شخصی مدیرعامل ریخت»
 *
 * سند هر کدام همان سند عادی است، با یک تفاوت: سطرِ صندوق یا بانک جایش را به
 * جاری همان شریک (یا پرداختنیِ همان کارمند) می‌دهد. فروشِ داراییِ شخصیِ او هم
 * رویداد شرکت نیست و هیچ‌جای دفتر نمی‌آید.
 *
 * تشخیص محافظه‌کار است: بدون نشانهٔ صریحِ پول شخصی، هیچ جمله‌ای به این مسیر
 * نمی‌رود. «آقای سهرابی ۲۸۰ میلیون به آریا داد» همان پرداخت عادی است که
 * می‌پرسد بابت چه بود؛ حدس نمی‌زنیم پول از جیب کیست.
 */

const PERSONAL_SOURCE = [
  /پول\s*(?:شخصی|خودش|خودشون|خودشان|خودم|خودمون)/,
  /(?:از\s*)?جیب\s*(?:خودش|خودشون|خودشان|خودم|خودمون|شخصی|ش|شون)(?![آ-ی])/,
  /از\s*حساب\s*(?:شخصی|خودش|خودشون)/,
  /(?:از\s*)?(?:دارایی|سرمایه|اموال)\s*شخصی/,
  /(?:شخصا|شخصاً)\s*(?:پرداخت|حساب)\s*کرد/,
  // داراییِ شخصی که فروخته شد: «ماشین شخصی خودش رو فروخت»، «ماشینشو فروخت»،
  // «خونه‌اش رو فروخت». مالکیت با «شخصی»، «خودش» یا ضمیر چسبیده گفته می‌شود.
  /(?:ماشین|خودرو|ماشینش|ماشینشو|ماشینشون|خونه|خانه|خونش|خونشو|خونه اش|خانه اش|ملک|ملکش|زمین|زمینش|طلا|طلاهاش|آپارتمان|واحد)\s*(?:شخصی\s*)?(?:خودش|خودشون|خودشان|خودم|اش|ش)?\s*(?:رو|را)?\s*(?:فروخت|فروختن|فروختند|فروختم)/,
];

/** پولِ شرکت که به حساب شخصیِ شریک رفت، یا شریک خودش نقد گرفت. */
const PERSONAL_DESTINATION = [
  /(?:به|تو|توی)\s*حساب\s*(?:شخصی|خودِ?)\s*(?:\S+\s*){0,3}?(?:ریخت|ریختن|ریختند|واریز\s*کرد|واریز\s*کردن|واریز\s*کردند|زد|زدن|کارت\s*به\s*کارت\s*کرد)/,
  /(?:خودش|شخصا|شخصاً)\s*(?:\S+\s*){0,2}?(?:نقد\s*)?(?:گرفت|گرفتن|گرفتند|دریافت\s*کرد|وصول\s*کرد)(?![آ-ی])/,
];

// پول به حساب شرکت آمده (آورده یا قرض شریک)، یا از شرکت برداشته شده: هیچ‌کدام
// این خانواده نیستند و مسیر خودشان را دارند. «از جیب خودش ۵۰ میلیون به شرکت داد»
// پول ورودی به شرکت است و «از جیب خودش به آقای کریمی قرض داد» وام به دیگری؛
// هیچ‌کدام خرج شرکت نیست. «به شرکت آریا داد» (تأمین‌کننده) عمداً بیرون می‌ماند.
const NOT_THIS = /برداشت|قرض\s*گرفت|وام|به\s*حساب\s*(?:شرکت|بانک|صندوق)|(?:به|تو)\s*(?:صندوق|بانک)\s*(?:شرکت\s*)?(?:ریخت|واریز|گذاشت)|از\s*(?:حساب\s*شرکت|صندوق\s*شرکت)|آورده|افزایش\s*سرمایه|(?:به|تو|توی)\s*(?:شرکت|صندوق|بانک)(?:\s*(?:خودمون|مون|ما))?\s*(?:داد|دادن|دادند|ریخت|ریختن|ریختند|واریز|گذاشت)(?![آ-ی])|قرض\s*(?:داد|دادن|دادند)(?![آ-ی])/;

const DEBT_WORDS = /بدهی|بدهکاری|طلب\s*(?:شرکت\s*)?\S+\s*(?:رو|را)|قسط|بستانکار|فاکتور|صورتحساب|صورت\s*حساب/;
const RECEIVABLE_WORDS = /بدهیش|بدهی\s*اش|بدهی\s*خودش|طلب\s*(?:ما|شرکت)|طلبمون|طلبمان|مشتری|بدهکار\s*(?:بود|بودن|بودند)/;
const PAID_VERB = /(?:پرداخت|تسویه|صاف|پاس|حساب)\s*(?:کرد|کردن|کردند|کردم|کردیم|شد)(?![آ-ی])|(?<![آ-ی])(?:داد|دادن|دادند|دادم|ریخت|ریختن|ریختند|زد|زدن)(?![آ-ی])|(?:کارت\s*به\s*کارت|واریز)\s*(?:کرد|کردن|کردند)/;
const BOUGHT_VERB = /(?<![آ-ی])(?:خرید|خریدن|خریدند|خریدم|گرفت|گرفتن|گرفتند)(?![آ-ی])/;

const PARTNER_ROLES = /(?:مدیر\s*عامل|مدیرعامل|شریک|سهامدار|سهام\s*دار|صاحب\s*شرکت|مالک|رئیس|رییس|عضو\s*هیئت\s*مدیره)/;
const EMPLOYEE_ROLES = /(?:کارمند|کارمندمون|کارمندمان|کارگر|پرسنل|راننده|منشی|حسابدار\s*شرکت|نیرو(?:ی)?\s*(?:ما|شرکت)|همکار)/;
const PERSON_TITLES = ['آقای', 'اقای', 'خانم', 'جناب', 'مهندس', 'دکتر', 'حاج', 'حاجی'];
const COMPANY_TITLES = ['شرکت', 'فروشگاه', 'کارخانه', 'کارخونه', 'گروه', 'موسسه', 'مؤسسه', 'تولیدی', 'بازرگانی'];

const STOP = new Set([
  'رو', 'را', 'به', 'از', 'با', 'برای', 'بابت', 'که', 'در', 'و', 'هم', 'تو', 'توی', 'خودش', 'خودشون', 'شخصی',
  'بدهی', 'بدهیه', 'بدهیش', 'طلب', 'پرداخت', 'تسویه', 'صاف', 'داد', 'دادن', 'کرد', 'کردن', 'شد',
  'مدیرعامل', 'مدیر', 'عامل', 'شریک', 'سهامدار', 'مالک', 'رئیس', 'رییس', 'کارمند', 'کارمندمون', 'کارگر',
  'فروخت', 'فروختن', 'پول', 'جیب', 'حساب', 'تومان', 'تومن', 'ریال', 'میلیون', 'میلیونی', 'هزار', 'میلیارد',
  'ما', 'مون', 'شرکتمون', 'شرکتمان', 'خودمون', 'قبلی', 'قبلیه', 'مونده', 'باقی', 'مانده', 'فاکتور', 'خرید',
]);

const isNumberish = (word) => /\d/.test(word) || /^(?:یک|یه|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|صد|دویست|سیصد|چهارصد|پانصد|پونصد|ششصد|هفتصد|هشتصد|نهصد|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود|و)$/.test(word) || /میلیون|هزار|میلیارد|تومن|تومان|ریال/.test(word);

function takeName(words, from, limit = 2) {
  const picked = [];
  for (let index = from; index < words.length && picked.length < limit; index += 1) {
    const word = words[index];
    if (STOP.has(word) || isNumberish(word) || PERSON_TITLES.includes(word) || COMPANY_TITLES.includes(word)) break;
    // «آقای سهرابی ماشینشو فروخت»: داراییِ ضمیردار جزء نام نیست.
    // «آقای رضایی شریکمون»: نقش جزء نام نیست، وگرنه جاری شریک دو حساب می‌شود.
    if (/^(?:ماشین|خودرو|خون|خانه|ملک|زمین|طلا|آپارتمان|پول|جیب|حساب|مدیر|کارمند|شریک|سهامدار|سهام)/.test(word)) break;
    // «آقای رضایی بیمه یکساله … داد»: موضوع پرداخت جزء نام نیست.
    if (/^(?:بیمه|اجاره|کرایه|اشتراک|لایسنس|قبض|قبوض|شارژ|هزینه|مواد|جنس|کالا|ودیعه|رهن|تعمیر)/.test(word)) break;
    // «به شرکت آریا داشتیم»: فعل جزء نام نیست.
    if (/^(?:ن?(?:داشت|بود|هست|شد|کرد|داد|گرفت|خرید|فروخت|ریخت|زد)(?:یم|م|ند|ن|ه|ی)?|است|نیست|دار(?:یم|م|ه|ند))$/.test(word)) break;
    picked.push(word);
  }
  return picked.join(' ');
}

/** نام‌های عنوان‌دار جمله، به ترتیب: «آقای سهرابی»، «شرکت آریا». */
function titledNames(words) {
  const names = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const person = PERSON_TITLES.includes(word);
    const company = COMPANY_TITLES.includes(word);
    if (!person && !company) continue;
    const name = takeName(words, index + 1);
    // «بدهی شرکت رو» یعنی شرکت خودمان، نه طرف حسابی به نام «شرکت».
    if (!name) continue;
    names.push({ index, kind: person ? 'person' : 'company', name: `${word === 'اقای' ? 'آقای' : word} ${name}` });
    index += name.split(' ').length;
  }
  return names;
}

const wordsOf = (text) => text.replace(/[،,.؛;!؟?()]/g, ' ').split(' ').filter(Boolean);

function singleAmount(input) {
  const amounts = parseFinancialText(input, { source: 'voice' }).transactions
    .map((item) => Number(item.amount) || 0).filter((amount) => amount >= 1_000);
  // چند مبلغ یعنی بهای فروش ماشین و مبلغ بدهی هر دو گفته شده‌اند؛ مبلغ را کارت
  // از سند باز می‌گیرد یا می‌پرسد، نه از حدس ما.
  return new Set(amounts).size === 1 ? amounts[0] : 0;
}

/**
 * چه کسی؟ شریک (جاری شریک) یا کارمند (پرداختنیِ کارمند). نقش از واژهٔ کنار
 * نام می‌آید؛ بی‌نقش، آدمِ عنوان‌دارِ جمله شریک فرض نمی‌شود مگر جمله از پول
 * شخصیِ «خودش» بگوید — و آن‌وقت هم کارت نامش را برای تأیید نشان می‌دهد.
 */
function readPerson(text, names) {
  const employee = EMPLOYEE_ROLES.exec(text);
  const partner = PARTNER_ROLES.exec(text);
  const people = names.filter((item) => item.kind === 'person');
  const person = people[0] || null;
  const firstPerson = /(?:خودم|خودمون|جیبم|پولم)(?![آ-ی])/.test(text) && !person;
  const kind = employee && !partner ? 'employee' : 'partner';
  const role = (kind === 'employee' ? employee : partner)?.[0]?.replace(/\s+/g, '') || '';
  return { name: person?.name || '', role, kind, firstPerson, entry: person };
}

/** هر جمله‌ای که از پولِ شخصی می‌گوید — دروازهٔ فهم با AI و نشانهٔ لازمِ نوعِ رویداد. */
export function mentionsPersonalMoney(input) {
  const text = normalizePersian(input);
  if (!text || NOT_THIS.test(text)) return false;
  return PERSONAL_SOURCE.some((pattern) => pattern.test(text)) || PERSONAL_DESTINATION.some((pattern) => pattern.test(text));
}

/**
 * تسویهٔ طلب یا بدهیِ شرکت از حساب شخصی شریک — موارد ۱ و ۵.
 *
 * خروجی همان شکل نیت تسویه است (`intent: 'settle'`) تا کارت تسویه سند باز یا
 * ماندهٔ دفتر کل را با همان قیدهای نام و مبلغ پیدا کند؛ `paidBy` می‌گوید پول از
 * حساب شخصیِ چه کسی گذشت.
 */
export function detectPartnerPaidDebt(input, { now = new Date() } = {}) {
  const text = normalizePersian(input);
  if (!text || NOT_THIS.test(text)) return null;
  const paidOut = PERSONAL_SOURCE.some((pattern) => pattern.test(text)) && DEBT_WORDS.test(text) && PAID_VERB.test(text);
  const cameIn = PERSONAL_DESTINATION.some((pattern) => pattern.test(text)) && (RECEIVABLE_WORDS.test(text) || DEBT_WORDS.test(text));
  if (!paidOut && !cameIn) return null;
  const direction = cameIn && !paidOut ? 'receivable' : 'payable';

  const words = wordsOf(text);
  const names = titledNames(words);
  const person = readPerson(text, names);
  // پول مشتری به حساب کارمند رفت: این جاری شریک نیست و قضاوت حسابدار است.
  if (direction === 'receivable' && person.kind === 'employee') return null;
  if (!person.name && !person.role && !person.firstPerson) return null;

  // طرف حساب: شرکت یا آدمِ دیگری غیر از پرداخت‌کننده. نامِ بی‌عنوان پس از «بدهی»
  // یا «طلب» هم پذیرفته می‌شود: «بدهی آریا رو صاف کرد».
  let contactName = names.find((item) => item !== person.entry && item.kind === 'company')?.name
    || names.find((item) => item !== person.entry && item.kind === 'person')?.name || '';
  if (!contactName) {
    const at = words.findIndex((word) => /^(?:بدهی|بدهکاری|طلب)$/.test(word));
    if (at >= 0) {
      let ahead = at + 1;
      while (ahead < words.length && (isNumberish(words[ahead]) || ['شرکت', 'ما', 'مون', 'از'].includes(words[ahead]))) ahead += 1;
      // «بدهی شرکت به آریا»: نام پس از «به».
      if (words[ahead] === 'به') ahead += 1;
      contactName = takeName(words, ahead, 1);
    }
  }
  if (!contactName && direction === 'payable') {
    const toAt = words.findIndex((word, index) => word === 'به' && index > 0 && !/حساب/.test(words[index + 1] || ''));
    if (toAt >= 0) contactName = takeName(words, toAt + 1, 2);
  }

  return {
    intent: 'settle',
    kind: 'obligation',
    direction,
    contactName,
    number: '',
    amount: singleAmount(input),
    occurredAt: extractOccurrenceDate(input, { now, preferPast: true })?.iso || null,
    paidBy: { name: person.name, role: person.role, kind: 'partner', firstPerson: person.firstPerson },
    transcript: text,
  };
}

/**
 * هزینه یا خریدی که شریک یا کارمند از پول شخصی‌اش داد — موارد ۲ تا ۴.
 *
 * بدهیِ قبلی‌ای بسته نمی‌شود؛ رویداد همان هزینه یا خرید عادی است و همان موتور
 * تصمیم (هزینه، پیش‌پرداخت، موجودی، دارایی ثابت) برایش تصمیم می‌گیرد. فقط
 * منبع پول عوض می‌شود: به‌جای صندوق، جاری شریک یا پرداختنیِ کارمند بستانکار
 * می‌شود. خروجی `fundedBy` است و روی هر ردیفِ همان جمله می‌نشیند.
 */
export function detectPartnerFundedSpend(input) {
  const text = normalizePersian(input);
  if (!text || NOT_THIS.test(text)) return null;
  if (!PERSONAL_SOURCE.some((pattern) => pattern.test(text))) return null;
  // بستن بدهی مسیر خودش را دارد.
  if (DEBT_WORDS.test(text)) return null;
  if (!PAID_VERB.test(text) && !BOUGHT_VERB.test(text)) return null;
  const person = readPerson(text, titledNames(wordsOf(text)));
  if (!person.name && !person.role && !person.firstPerson) return null;
  return { name: person.name, role: person.role, kind: person.kind, firstPerson: person.firstPerson };
}

/**
 * ردیفِ پارسر برای هزینه‌ای که از پول شخصی رفت.
 *
 * «از جیب خودش داد» برای پارسر جهتِ مبهمی دارد (سوم‌شخص، بی‌فعل اول‌شخص)، ولی
 * وقتی منبع پول جیب شخص است و پول به شرکت نیامده، جهت قطعاً پرداخت است. همان
 * قطعیت این‌جا یک‌جا اعمال می‌شود تا ثبت، پیش‌نمایش و آزمون یک‌جور بفهمند.
 */
export function asFundedSpend(item, funder) {
  const typeReason = /نوع/;
  const reviewReasons = (Array.isArray(item.reviewReasons) ? item.reviewReasons : []).filter((reason) => !typeReason.test(String(reason)));
  const details = { ...(item.confidenceDetails || {}), type: { score: 1, reason: `پرداخت از پول شخصی ${funder.name || funder.role || (funder.kind === 'employee' ? 'کارمند' : 'شریک')} گفته شده است.` } };
  return { ...item, type: 'expense', moneyDirection: 'out', confidenceDetails: details, reviewReasons, needsReview: reviewReasons.length > 0 };
}
