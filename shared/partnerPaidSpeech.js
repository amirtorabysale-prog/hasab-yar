import { normalizePersian } from './normalize.js';
import { parseFinancialText } from './parser.js';
import { extractOccurrenceDate } from './persianDate.js';

/**
 * بدهی شرکت که شریک یا مدیرعامل از پول شخصی خودش داد.
 *
 * «آقای سهرابی مدیرعامل ماشین شخصی خودش رو فروخت و ۲۸۰ میلیون بدهی شرکت آریا
 * رو پرداخت کرد.» پارسر هر جمله را یک پولِ ورودی یا خروجیِ صندوق شرکت می‌خواند:
 * «فروخت» را درآمد می‌کرد و «پرداخت کرد» را هزینه، و در هر دو حالت ماندهٔ
 * صندوق ۲۸۰ میلیون جابه‌جا می‌شد — درحالی‌که از حساب شرکت ریالی نرفته است.
 *
 * رویداد واقعی یک جابه‌جاییِ بدهی است: بدهی به آریا بسته می‌شود و شرکت همان
 * مبلغ را به شریک بدهکار می‌شود (جاری شریک). داراییِ شخصی‌ای که فروخته شد مال
 * شرکت نبود و هیچ‌جای دفتر نمی‌آید.
 *
 * تشخیص عمداً محافظه‌کار است و دو نشانه را با هم می‌خواهد:
 *
 *   ۱. پولِ شخص، نه شرکت: «پول شخصی»، «از جیب خودش»، «ماشین/خانه‌اش را فروخت».
 *   ۲. بستن بدهیِ موجود: «بدهی … را داد/پرداخت کرد/صاف کرد».
 *
 * «آقای سهرابی ۲۸۰ میلیون به آریا داد» بدون نشانهٔ اول، همان پرداخت عادی است
 * که از مسیر قبلی می‌پرسد بابت چه بود — حدس نمی‌زنیم پول از جیب کیست.
 */

const PERSONAL_MONEY = [
  /پول\s*(?:شخصی|خودش|خودشون|خودشان|خودم|خودمون)/,
  /(?:از\s*)?جیب\s*(?:خودش|خودشون|خودشان|خودم|خودمون|شخصی)/,
  /حساب\s*شخصی/,
  /(?:از\s*)?(?:دارایی|سرمایه|اموال)\s*شخصی/,
  // داراییِ شخصی که فروخته شد: «ماشین شخصی خودش رو فروخت»، «ماشینشو فروخت»،
  // «خونه‌اش رو فروخت». مالکیت با «شخصی»، «خودش» یا ضمیر چسبیده گفته می‌شود.
  /(?:ماشین|خودرو|ماشینش|ماشینشو|ماشینشون|خونه|خانه|خونش|خونشو|خونه اش|خانه اش|ملک|ملکش|زمین|زمینش|طلا|طلاهاش|آپارتمان|واحد)\s*(?:شخصی\s*)?(?:خودش|خودشون|خودشان|خودم|اش|ش)?\s*(?:رو|را)?\s*(?:فروخت|فروختن|فروختند|فروختم)/,
];

// پول به حساب شخصی شریک آمده یا از شرکت برداشته — جهتش برعکس است و این‌جا نیست.
const NOT_THIS = /برداشت|به\s*حساب\s*شخصی|(?:ریخت|واریز\s*کرد|زد)(?:ن|ند)?\s*(?:به|تو)\s*حساب\s*(?:شخصی|خودش)|قرض\s*گرفت|وام/;

const DEBT_WORDS = /بدهی|بدهکاری|طلب\s*(?:شرکت\s*)?\S+\s*(?:رو|را)|قسط|بستانکار/;
const PAID_VERB = /(?:پرداخت|تسویه|صاف|پاس)\s*(?:کرد|کردن|کردند|کردم|کردیم|شد)(?![آ-ی])|(?<![آ-ی])(?:داد|دادن|دادند|دادم|ریخت|ریختن|ریختند|زد|زدن)(?![آ-ی])|(?:کارت\s*به\s*کارت|واریز)\s*(?:کرد|کردن|کردند)/;

const PAYER_ROLES = /(?:مدیر\s*عامل|مدیرعامل|شریک|سهامدار|سهام\s*دار|صاحب\s*شرکت|مالک|رئیس|رییس|عضو\s*هیئت\s*مدیره)/;
const PERSON_TITLES = ['آقای', 'اقای', 'خانم', 'جناب', 'مهندس', 'دکتر', 'حاج', 'حاجی'];
const COMPANY_TITLES = ['شرکت', 'فروشگاه', 'کارخانه', 'کارخونه', 'گروه', 'موسسه', 'مؤسسه', 'تولیدی', 'بازرگانی'];

const STOP = new Set([
  'رو', 'را', 'به', 'از', 'با', 'برای', 'بابت', 'که', 'در', 'و', 'هم', 'تو', 'خودش', 'خودشون', 'شخصی',
  'بدهی', 'بدهیه', 'بدهی‌ای', 'طلب', 'پرداخت', 'تسویه', 'صاف', 'داد', 'دادن', 'کرد', 'کردن', 'شد',
  'مدیرعامل', 'مدیر', 'عامل', 'شریک', 'سهامدار', 'مالک', 'رئیس', 'رییس', 'ماشین', 'خونه', 'خانه', 'ملک',
  'فروخت', 'فروختن', 'پول', 'جیب', 'حساب', 'تومان', 'تومن', 'ریال', 'میلیون', 'میلیونی', 'هزار', 'میلیارد',
  'ما', 'مون', 'شرکتمون', 'شرکتمان', 'خودمون', 'قبلی', 'قبلیه', 'مونده', 'باقی', 'مانده',
]);

const isNumberish = (word) => /\d/.test(word) || /^(?:یک|یه|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|صد|دویست|سیصد|چهارصد|پانصد|پونصد|ششصد|هفتصد|هشتصد|نهصد|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود|و)$/.test(word) || /میلیون|هزار|میلیارد|تومن|تومان|ریال/.test(word);

function takeName(words, from, limit = 2) {
  const picked = [];
  for (let index = from; index < words.length && picked.length < limit; index += 1) {
    const word = words[index];
    if (STOP.has(word) || isNumberish(word) || PERSON_TITLES.includes(word) || COMPANY_TITLES.includes(word)) break;
    // «آقای سهرابی ماشینشو فروخت»: داراییِ ضمیردار جزء نام نیست.
    if (/^(?:ماشین|خودرو|خون|خانه|ملک|زمین|طلا|آپارتمان|پول|جیب|حساب|مدیر)/.test(word)) break;
    // «به شرکت آریا داشتیم»: فعل جزء نام نیست.
    if (/^(?:ن?(?:داشت|بود|هست|شد|کرد|داد|گرفت|خرید|فروخت)(?:یم|م|ند|ن|ه|ی)?|است|نیست|دار(?:یم|م|ه|ند))$/.test(word)) break;
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

/**
 * آیا جمله از پولِ شخصیِ کسی جز کسب‌وکار حرف می‌زند؟ نشانهٔ لازمِ نوع رویدادِ
 * `paid-by-partner` در فهم با AI، و دلیلِ فرستادن گفته به آن مسیر.
 */
export function mentionsPersonalMoney(input) {
  const text = normalizePersian(input);
  return Boolean(text) && PERSONAL_MONEY.some((pattern) => pattern.test(text)) && !NOT_THIS.test(text);
}

/**
 * نیت «بدهی شرکت از پول شریک». برگشت `null` یعنی جمله این رویداد نیست.
 *
 * خروجی همان شکل نیت تسویه است (`intent: 'settle'`) تا کارت تسویه سندهای باز
 * را با همان قیدهای نام و مبلغ پیدا کند؛ `paidBy` می‌گوید پول از کجا آمد.
 */
export function detectPartnerPaidDebt(input, { now = new Date() } = {}) {
  const text = normalizePersian(input);
  if (!text) return null;
  if (!mentionsPersonalMoney(text)) return null;
  if (!DEBT_WORDS.test(text) || !PAID_VERB.test(text)) return null;

  const words = text.replace(/[،,.؛;!؟?()]/g, ' ').split(' ').filter(Boolean);
  const names = titledNames(words);
  const roleMatch = PAYER_ROLES.exec(text);
  // پرداخت‌کننده: آدمی که پیش از فعلِ فروش یا پرداخت آمده. اول نامِ کنار نقش
  // («آقای سهرابی مدیرعامل» یا «مدیرعامل آقای سهرابی»)، بعد نخستین آدمِ جمله.
  const people = names.filter((item) => item.kind === 'person');
  const payer = people[0] || null;
  const payerRole = roleMatch ? roleMatch[0].replace(/\s+/g, '') : '';
  // اول‌شخص — «از جیب خودم بدهی آریا رو دادم» — یعنی ثبت‌کننده خودش شریک است؛
  // نامش را کارت می‌پرسد.
  const firstPerson = /(?:خودم|خودمون)/.test(text) && !payer;
  if (!payer && !payerRole && !firstPerson) return null;

  // طلبکار: شرکت یا آدمِ دیگری غیر از پرداخت‌کننده. نامِ بی‌عنوان پس از «بدهی»
  // یا پیش از «رو» هم پذیرفته می‌شود: «بدهی آریا رو صاف کرد».
  let creditor = names.find((item) => item !== payer && item.kind === 'company')?.name
    || names.find((item) => item !== payer && item.kind === 'person')?.name || '';
  if (!creditor) {
    const debtAt = words.findIndex((word) => /^(?:بدهی|بدهکاری|طلب)$/.test(word));
    if (debtAt >= 0) {
      let ahead = debtAt + 1;
      while (ahead < words.length && (isNumberish(words[ahead]) || ['شرکت', 'ما', 'مون'].includes(words[ahead]))) ahead += 1;
      // «بدهی شرکت به آریا»: نام پس از «به».
      if (words[ahead] === 'به') ahead += 1;
      creditor = takeName(words, ahead, 1);
    }
  }
  if (!creditor) {
    const toAt = words.findIndex((word, index) => word === 'به' && index > 0 && !/حساب/.test(words[index + 1] || ''));
    if (toAt >= 0) creditor = takeName(words, toAt + 1, 2);
  }

  const amounts = parseFinancialText(input, { source: 'voice' }).transactions
    .map((item) => Number(item.amount) || 0).filter((amount) => amount >= 1_000);
  // چند مبلغ یعنی بهای فروش ماشین و مبلغ بدهی هر دو گفته شده‌اند؛ مبلغِ بستن
  // بدهی را کارت از سند باز می‌گیرد، نه از حدس ما.
  const amount = new Set(amounts).size === 1 ? amounts[0] : 0;

  return {
    intent: 'settle',
    kind: 'obligation',
    direction: 'payable',
    contactName: creditor,
    number: '',
    amount,
    occurredAt: extractOccurrenceDate(input, { now, preferPast: true })?.iso || null,
    paidBy: { name: payer?.name || '', role: payerRole, firstPerson },
    transcript: text,
  };
}
