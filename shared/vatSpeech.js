import { normalizePersian } from './normalize.js';

/**
 * ارزش افزوده در گفتار — فقط خواندن جمله، هیچ تصمیم حسابداری.
 *
 * چرا جدا از `detectTaxMention` فاکتور:
 *
 * آن تابع برای فرم فاکتور ساخته شده و فقط می‌پرسد «مالیات می‌خواهی یا نه».
 * اینجا سؤال دیگری است: مبلغی که کاربر گفته با ارزش افزوده چه نسبتی دارد؟
 * سه جملهٔ زیر هر سه «ارزش افزوده» دارند و سه سند کاملاً متفاوت می‌خواهند:
 *
 *   «۱۱۰ میلیون فروختم با ارزش افزوده»    مالیات **داخل** مبلغ است
 *   «فروش ۱۰۰ میلیون به علاوه ارزش افزوده» مالیات **بیرون** مبلغ است
 *   «ارزش افزودهٔ فصل رو ۲۰ میلیون دادم»   خودِ مبلغ **پرداخت به سازمان** است
 *
 * تا امروز هر سه یک سرنوشت داشتند: دستهٔ «مالیات و عوارض» و کل مبلغ در سود و
 * زیان.
 */

export const VAT_FORMS = Object.freeze({
  /** اصلاً حرفی از ارزش افزوده نیست. */
  NONE: 'none',
  /** صریحاً گفته شده مالیات ندارد. */
  EXEMPT: 'exempt',
  /** مالیات داخل مبلغ گفته‌شده است: «با ارزش افزوده»، «شامل مالیات». */
  INCLUSIVE: 'inclusive',
  /** مبلغ بدون مالیات گفته شده و مالیات جداست: «به علاوه ارزش افزوده». */
  EXCLUSIVE: 'exclusive',
  /** ارزش افزوده آمده ولی نسبتش با مبلغ گفته نشده. */
  BARE: 'bare',
});

const RATE_WORDS = Object.freeze({
  یک: 1, دو: 2, سه: 3, چهار: 4, پنج: 5, شش: 6, شیش: 6, هفت: 7, هشت: 8, نه: 9, ده: 10,
  یازده: 11, دوازده: 12, سیزده: 13, چهارده: 14, پانزده: 15, پونزده: 15, شانزده: 16, هفده: 17, هجده: 18, نوزده: 19, بیست: 20,
});

// نرخ گفته‌شده میان نشانه و واژهٔ مالیات: «شامل ۱۰ درصد مالیات»، «با ده درصد ارزش افزوده».
const RATE = String.raw`(?:(?:\d{1,2}(?:\.\d+)?|${Object.keys(RATE_WORDS).join('|')})\s*(?:درصد|%)\s*)?`;

// «مالیات» تنها فقط کنار یک نشانهٔ قیمت ارزش افزوده شمرده می‌شود. «مالیات
// دادم» می‌تواند مالیات عملکرد باشد؛ «با مالیات» در جملهٔ خرید و فروش نه.
const VAT_TERM = String.raw`(?:مالیات\s*(?:بر\s*)?ارزش\s*افزوده|ارزش\s*افزوده|مالیات)`;

const EXCLUSIVE = new RegExp(String.raw`(?:(?:^|\s)(?:به\s*علاوه|بعلاوه|به\s*اضافه|باضافه|بدون\s*احتساب|علاوه\s*بر|جدا\s*از)|\+)\s*(?:ی\s*)?${RATE}${VAT_TERM}`);
// «ده درصد ارزش افزوده هم اضافه شد» — مالیات روی مبلغ آمد، پس مبلغ گفته‌شده
// بدون مالیات است. در آزمون استرس همین جمله، فروش ۴۰۰ میلیونی را «مالیات و
// عوارض» و هزینه کرده بود.
const EXCLUSIVE_AFTER = new RegExp(String.raw`${VAT_TERM}\s*(?:ش|اش|هم|رو|را)?\s*(?:هم\s*)?(?:جدا|جداگانه|روش|رویش|اضافه\s*(?:شد|شده|کردیم|کردم|میشه|می\s*شه))`);
const INCLUSIVE = new RegExp(String.raw`(?:^|\s)(?:با\s*احتساب|احتساب|شامل|همراه\s*با|به\s*همراه|با)\s*(?:ی\s*)?${RATE}${VAT_TERM}`);
// «مالیات ارزش افزوده نگرفته» هم یعنی مالیاتی در کار نیست: فروشنده نگرفته،
// پس اعتباری هم برای ما نیست و کل مبلغ بهای خرید است.
const EXEMPT = /بدون\s*(?:مالیات|ارزش\s*افزوده)|معاف\s*(?:از\s*)?(?:مالیات|ارزش)|معافه|معاف است|(?:مالیات|ارزش\s*افزوده)\s*(?:رو\s*|را\s*)?(?:نگرفته|نگرفت|نگرفتن|نداده|نداد)/;
const EXPLICIT_VAT = /ارزش\s*افزوده|\bVAT\b/i;
const PENALTY = /جریمه|دیرکرد|خسارت\s*تاخیر|خسارت\s*تأخیر/;
// نشانهٔ داد و ستد: وقتی باشد، ارزش افزودهٔ جمله مالِ یک خرید یا فروش است، نه
// پرداخت به سازمان.
const TRADE = /خرید|خریدم|خریدیم|فروش|فروختم|فروختیم|فاکتور|جنس|کالا|مشتری|تامین\s*کننده|تأمین\s*کننده/;
const REFUND = /استرداد|برگشت|پس\s*گرفتم|مسترد|عودت|برگردوند|برگرداند|پس\s*داد/;
// پرداخت واقعاً انجام شده؟ «مبلغ بدهی قابل پرداخت ۲۷ میلیون شد» از اظهارنامه
// می‌گوید، نه از پولی که رفته — و در آزمون استرس پرداخت به سازمان خوانده شد.
const PAID = /(?:پرداخت|واریز|تسویه)\s*(?:کردم|کردیم|شد|کرد|کردند|کردن)|دادم|دادیم|ریختم|ریختیم|زدم|زدیم|کارت\s*کشیدم/;
const NOT_PAID = /قابل\s*پرداخت|باید\s*(?:بدیم|بدم|پرداخت)|هنوز/;

function statedRate(text) {
  const digits = text.match(/(\d{1,2}(?:\.\d+)?)\s*(?:درصد|%)/);
  if (digits) return Number(digits[1]);
  const words = text.match(new RegExp(`(?:^|\\s)(${Object.keys(RATE_WORDS).join('|')})\\s*درصد`));
  return words ? RATE_WORDS[words[1]] : null;
}

/**
 * ارزش افزوده در این جمله چه نقشی دارد؟
 *
 * برمی‌گرداند: { form, ratePercent, explicitVat, penalty, trade, refund }.
 * `ratePercent` فقط وقتی عدد است که در جمله گفته شده باشد؛ نرخ پیش‌فرض دفتر
 * اینجا حدس زده نمی‌شود، چون این ماژول دفتر را نمی‌شناسد.
 */
export function readVatMention(input) {
  const text = normalizePersian(input);
  const base = {
    ratePercent: null,
    explicitVat: EXPLICIT_VAT.test(text),
    penalty: PENALTY.test(text),
    trade: TRADE.test(text),
    refund: REFUND.test(text),
    paid: PAID.test(text.replace(/قابل\s*پرداخت/g, ' ')) && !NOT_PAID.test(text),
  };
  // واژهٔ تنهای «مالیات» بدون نشانهٔ داد و ستد، ارزش افزوده نیست.
  //
  // «حقوق پرسنل رو با مالیات ۱۰۰ میلیون دادم» مالیات حقوق است، نه ارزش افزوده.
  // بدون این کنترل، الگوی «با ... مالیات» می‌گرفت و نگهبان ۹ درصد از حقوق را
  // اعتبار مالیاتی می‌کرد — یک اعتبار جعلی که هیچ‌وقت قابل استفاده نیست و در
  // تسویهٔ دوره با سازمان نمی‌خواند. «با» در فارسی آن‌قدر عام است که
  // نمی‌تواند به‌تنهایی نشانهٔ قیمت باشد.
  const vatMeant = base.explicitVat || base.trade;

  // ترتیب مهم است: «بدون احتساب مالیات» با «بدون مالیات» شروع می‌شود ولی
  // معنایش برعکس است — مالیات هست، فقط در مبلغ نیست.
  if (vatMeant && (EXCLUSIVE.test(text) || EXCLUSIVE_AFTER.test(text))) return { ...base, form: VAT_FORMS.EXCLUSIVE, ratePercent: statedRate(text) };
  if (EXEMPT.test(text)) return { ...base, form: VAT_FORMS.EXEMPT };
  if (vatMeant && INCLUSIVE.test(text)) return { ...base, form: VAT_FORMS.INCLUSIVE, ratePercent: statedRate(text) };
  if (base.explicitVat) return { ...base, form: VAT_FORMS.BARE, ratePercent: statedRate(text) };
  return { ...base, form: VAT_FORMS.NONE };
}

/**
 * جمله بدون نشانه‌های قیمتیِ ارزش افزوده.
 *
 * برای دسته‌بندی لازم است: «لپ‌تاپ خریدم ۵۵ میلیون با احتساب ارزش افزوده»
 * دستهٔ «مالیات و عوارض» می‌گرفت چون قوی‌ترین واژهٔ جمله «ارزش افزوده» بود، و
 * «فروش ۱۰۰ میلیون به علاوه ارزش افزوده» حتی هزینه ثبت می‌شد. این نشانه‌ها
 * می‌گویند قیمت چطور حساب شده، نه اینکه موضوع خرج چیست.
 *
 * ارزش افزودهٔ بی‌نشانه — «ارزش افزوده رو دادم» — دست نمی‌خورد؛ آنجا خودِ
 * ارزش افزوده موضوع جمله است.
 */
const PRICE_QUALIFIERS = [
  new RegExp(EXCLUSIVE.source, 'g'),
  new RegExp(EXCLUSIVE_AFTER.source, 'g'),
  new RegExp(INCLUSIVE.source, 'g'),
  /بدون\s*(?:مالیات|ارزش\s*افزوده)/g,
  /(?:مالیات\s*)?(?:ارزش\s*افزوده|مالیات)\s*(?:رو\s*|را\s*)?(?:نگرفته|نگرفت|نگرفتن|نداده|نداد)/g,
];

export function withoutVatQualifiers(input) {
  if (!/مالیات|ارزش|VAT/i.test(String(input || ''))) return String(input || '');
  let text = normalizePersian(input);
  for (const pattern of PRICE_QUALIFIERS) text = text.replace(pattern, (match) => ' '.repeat(match.length));
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * تفکیک مبلغ ناخالص به خالص و مالیات.
 *
 * نرخ به «واحد در ده‌هزار» است تا ۹٫۵ درصد هم بی‌خطای اعشاری بماند — همان
 * شکلی که جدول نرخ‌های مالیاتی ذخیره می‌کند. مالیات از **تفاضل** درمی‌آید،
 * نه از ضرب جداگانه: جمع دو سطر باید دقیقاً همان پولی باشد که جابه‌جا شده.
 */
/**
 * جمعِ فاکتوری که مبلغش بدون ارزش افزوده و نرخش صریح گفته شده.
 *
 * «فاکتور خرید … ۴۰ میلیون تومان به‌علاوهٔ ۱۰ درصد ارزش افزوده، پولش هنوز
 * ندادیم»: جمع ۴۴ از خودِ جمله درمی‌آید و پرسیدنش سؤالی بود که جمله جواب داده
 * بود (آزمون زندهٔ ۴ آبان ۱۴۰۵). فقط با نرخِ گفته‌شده؛ نرخ پیش‌فرض دفتر این‌جا
 * حدس زده نمی‌شود. مقیاس مهم نیست: درصد در تومان و ریال یکی است.
 *
 * برمی‌گرداند { net, tax, gross, rateBps } یا null.
 */
export function exclusiveVatTotal(text, base) {
  const mention = readVatMention(text);
  if (mention.form !== VAT_FORMS.EXCLUSIVE || !(mention.ratePercent > 0)) return null;
  const net = Math.round(Number(base));
  if (!Number.isSafeInteger(net) || net <= 0) return null;
  const rateBps = Math.round(mention.ratePercent * 100);
  const tax = Math.round(net * rateBps / 10_000);
  return tax > 0 ? { net, tax, gross: net + tax, rateBps } : null;
}

export function splitInclusive(gross, rateBps) {
  const amount = Math.round(Number(gross));
  const bps = Math.round(Number(rateBps));
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isFinite(bps) || bps <= 0) return null;
  const net = Math.round(amount * 10_000 / (10_000 + bps));
  const tax = amount - net;
  if (net <= 0 || tax <= 0) return null;
  return { net, tax };
}
