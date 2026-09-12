import { normalizePersian } from './normalize.js';
import { repairNumberSpeech, wordsToNumber } from './parser.js';

/**
 * ردیف‌های فاکتور از گفتار.
 *
 * تا امروز صدا فقط یک پیش‌نویس تک‌ردیفی با عنوان «ردیف فروش — از گفتهٔ صوتی»
 * می‌ساخت: بدون نام کالا، بدون تعداد، بدون نرخ واحد. یعنی کاربر باید کل فاکتور
 * را دوباره دستی می‌نوشت و صدا فقط یک شمارهٔ سند می‌داد.
 *
 * قاعدهٔ ایمنی این ماژول: **مبلغ گفته‌شده هرگز تغییر نمی‌کند.** وقتی جمله نرخ
 * واحد را صریح می‌گوید («هرکدام پنجاه هزار») تعداد در نرخ ضرب می‌شود، چون خود
 * کاربر همین را گفته. وقتی نمی‌گوید، مبلغ همان مبلغ ردیف می‌ماند و تعداد فقط در
 * عنوان می‌نشیند — تقسیم‌کردن مبلغ بر تعداد، عددی می‌سازد که کاربر نگفته است.
 */

const COUNTER_WORDS = ['عدد', 'تا', 'دستگاه', 'بسته', 'جعبه', 'کارتن', 'کیلو', 'کیلوگرم', 'گرم', 'متر', 'لیتر', 'ورق', 'رول', 'جفت', 'نفر'];

// نشانهٔ صریح «این عدد، نرخ یک واحد است».
const UNIT_PRICE_MARKERS = [
  'هرکدام', 'هر کدام', 'هردانه', 'هر دانه', 'دانه ای', 'دونه ای', 'دانه‌ای',
  'هر عدد', 'هر دستگاه', 'هر کیلو', 'هر متر', 'هر بسته', 'هر جعبه', 'دانه', 'تایی', 'نفری',
];

const CURRENCY_WORDS = new Set(['تومان', 'تومن', 'تومنی', 'ریال']);
const NUMERIC_WORDS = new Set([
  'صفر', 'یک', 'یه', 'دو', 'سه', 'چهار', 'چار', 'پنج', 'شش', 'شیش', 'هفت', 'هشت', 'نه', 'ده',
  'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'پونزده', 'شانزده', 'هفده', 'هجده', 'نوزده',
  'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'شست', 'هفتاد', 'هشتاد', 'نود',
  'صد', 'یکصد', 'دویست', 'دویس', 'سیصد', 'چهارصد', 'چارصد', 'پانصد', 'پونصد', 'پنصد',
  'ششصد', 'شیشصد', 'هفتصد', 'هفصد', 'هشتصد', 'هشصد', 'نهصد',
  'هزار', 'میلیون', 'میلیارد', 'نیم', 'نصف', 'و',
]);

// واژه‌هایی که هرگز بخشی از نام کالا نیستند.
const NAME_STOP_WORDS = new Set([
  'فاکتور', 'فروش', 'خرید', 'برای', 'از', 'به', 'با', 'بابت', 'رو', 'را', 'که', 'در',
  'آقای', 'اقای', 'خانم', 'جناب', 'شرکت', 'مهندس', 'دکتر', 'حاج', 'حاجی',
  'صادر', 'کن', 'بزن', 'ثبت', 'مالیات', 'ارزش', 'افزوده', 'درصد', 'تخفیف',
  ...CURRENCY_WORDS,
]);

function isNumericToken(token) {
  return /^\d[\d,.]*$/.test(token) || NUMERIC_WORDS.has(token);
}

function amountFromTokens(tokens) {
  const clean = tokens.filter((token) => !CURRENCY_WORDS.has(token));
  if (!clean.length) return 0;
  const value = wordsToNumber(clean);
  // «ریال» گفته‌شده به تومان تبدیل می‌شود، همان قاعده‌ای که پارسر مبلغ دارد.
  return tokens.includes('ریال') ? Math.round(value / 10) : value;
}

/** واژهٔ شمارشی بعد از عدد («۱۰ عدد») حذف می‌شود تا در نام کالا نیفتد. */
function stripCounter(tokens) {
  return tokens.length && COUNTER_WORDS.includes(tokens[0]) ? tokens.slice(1) : tokens;
}

/**
 * واژهٔ شمارشی اینجا فیلتر نمی‌شود: `stripCounter` همان یکی را که بعد از عدد
 * آمده برداشته، و بعضی واژه‌ها هم شمارشی‌اند هم نام کالا («کارتن»، «بسته»،
 * «رول»). فیلتر دوباره، نام را خالی می‌کرد و ردیف اصلاً ساخته نمی‌شد.
 */
function cleanName(tokens) {
  const words = tokens.filter((token) => !NAME_STOP_WORDS.has(token) && !isNumericToken(token));
  return words.join(' ').trim().slice(0, 120);
}

/**
 * نرخ مالیات گفته‌شده.
 *
 * فقط «چند درصد» و «ارزش افزوده» تشخیص داده می‌شود. انتخاب نرخ واقعی کار رابط
 * است، چون مالیات باید از نرخ‌های تعریف‌شدهٔ همان دفتر بیاید؛ ساختن نرخ از روی
 * حرف، عددی به سند می‌دهد که در دفتر وجود ندارد.
 */
export function detectTaxMention(input) {
  const text = repairNumberSpeech(normalizePersian(input));
  if (/بدون\s*(?:مالیات|ارزش\s*افزوده)|معاف/.test(text)) return { wanted: false, ratePercent: null, explicit: true };
  const percent = text.match(/(\d{1,2})\s*درصد/);
  if (percent) return { wanted: true, ratePercent: Number(percent[1]), explicit: true };
  if (/ارزش\s*افزوده|مالیات/.test(text)) return { wanted: true, ratePercent: null, explicit: true };
  return { wanted: false, ratePercent: null, explicit: false };
}

/** کاربر خواسته سند همان لحظه صادر شود، نه پیش‌نویس بماند. */
export function wantsImmediateIssue(input) {
  return /(?:صادر|نهایی|قطعی)\s*(?:ش|کن|بشه|بکن|کنش)|فاکتور\s*رسمی/.test(normalizePersian(input));
}

/**
 * ردیف‌های کالا را از جمله بیرون می‌کشد.
 *
 * برمی‌گرداند: آرایه‌ای از { title, quantity, unitPrice, fromUnitPrice }.
 * اگر هیچ ردیف قابل اتکایی پیدا نشود، آرایهٔ خالی برمی‌گردد و تصمیم با فراخوان
 * است — حدس‌زدن ردیف از یک جملهٔ مبهم بدتر از نساختن آن است.
 */
export function parseInvoiceLines(input) {
  const text = repairNumberSpeech(normalizePersian(input));
  if (!text) return [];
  const tokens = text.split(' ').filter(Boolean);

  // جای هر نشانهٔ نرخ واحد را پیدا کن؛ نشانه ممکن است یک یا دو واژه باشد.
  const markers = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const one = tokens[index];
    const two = `${tokens[index]} ${tokens[index + 1] || ''}`.trim();
    const matched = UNIT_PRICE_MARKERS.includes(two) ? 2 : UNIT_PRICE_MARKERS.includes(one) ? 1 : 0;
    if (matched) { markers.push({ start: index, length: matched }); index += matched - 1; }
  }
  if (!markers.length) return [];

  const lines = [];
  let boundary = 0;
  for (let position = 0; position < markers.length; position += 1) {
    const marker = markers[position];

    // سمت راست نشانه: نرخ واحد، تا جایی که توکن عددی یا واحد پول ادامه دارد.
    const priceTokens = [];
    let cursor = marker.start + marker.length;
    while (cursor < tokens.length && (isNumericToken(tokens[cursor]) || CURRENCY_WORDS.has(tokens[cursor]))) {
      priceTokens.push(tokens[cursor]);
      cursor += 1;
    }
    // «و» پایانی متعلق به ردیف بعدی است، نه به مبلغ این ردیف.
    while (priceTokens.length && priceTokens.at(-1) === 'و') { priceTokens.pop(); cursor -= 1; }
    // «یک میلیون و سه عدد صندلی» — آن «سه» تعداد ردیف بعدی است، نه بخشی از
    // مبلغ این ردیف. نشانه‌اش این است که بلافاصله بعدش واژهٔ شمارشی می‌آید.
    const lastVav = priceTokens.lastIndexOf('و');
    if (lastVav > 0 && cursor < tokens.length && COUNTER_WORDS.includes(tokens[cursor])) {
      cursor -= priceTokens.length - lastVav;
      priceTokens.length = lastVav;
    }
    const unitPrice = amountFromTokens(priceTokens);

    // سمت چپ نشانه ساختار «… تعداد [واژهٔ شمارشی] نام» دارد، پس تعداد باید از
    // راست پیدا شود. جست‌وجو از چپ، «فاکتور» را اولین توکن می‌دید و هیچ تعدادی
    // پیدا نمی‌کرد؛ نام کالا هم نام مشتری را با خودش می‌آورد.
    const left = tokens.slice(boundary, marker.start);
    let numberEnd = left.length;
    while (numberEnd > 0 && !isNumericToken(left[numberEnd - 1])) numberEnd -= 1;
    let numberStart = numberEnd;
    while (numberStart > 0 && isNumericToken(left[numberStart - 1])) numberStart -= 1;

    let quantity = 1;
    let nameTokens = left;
    if (numberEnd > numberStart) {
      const parsed = wordsToNumber(left.slice(numberStart, numberEnd));
      if (parsed > 0 && parsed < 100_000) quantity = parsed;
      nameTokens = stripCounter(left.slice(numberEnd));
    }
    const title = cleanName(nameTokens);
    boundary = cursor;
    if (!unitPrice || !title) continue;
    lines.push({ title, quantity, unitPrice, fromUnitPrice: true });
  }
  return lines;
}
