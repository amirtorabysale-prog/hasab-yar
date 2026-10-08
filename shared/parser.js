import { withReviewAssessment } from './review.js';
import { normalizePersian } from './normalize.js';
import { CATEGORY_DEFINITIONS, chartCodeForCategory, classifyCategory } from './categoryRules.js';
import { PERSIAN_MONTHS, extractOccurrenceDate } from './persianDate.js';
import { detectBank, detectTransferBanks } from './banks.js';
import { mentionsCapitalOrAsset } from './capitalSpeech.js';
import { readPrepaymentMention } from './prepaymentSpeech.js';
import { readServicePeriod } from './periodSpeech.js';
import { readUnpaidSignal } from './accrualSpeech.js';
import { EVENT_NATURES, natureNeedsAccountant, readEventNature } from './eventNature.js';
import { counterpartyMoneyDirection, extractContactCandidate } from './counterpartySpeech.js';
import { withoutVatQualifiers } from './vatSpeech.js';
import { readPettyCash } from './pettyCashSpeech.js';

const DIGITS = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

const VALUES = {
  صفر: 0, یک: 1, یه: 1, ی: 1, دو: 2, سه: 3, چهار: 4, چار: 4, پنج: 5, شش: 6, شیش: 6, هفت: 7, هشت: 8, نه: 9,
  ده: 10, یازده: 11, دوازده: 12, سیزده: 13, چهارده: 14, پونزده: 15, پانزده: 15, شانزده: 16, هفده: 17, هجده: 18, نوزده: 19,
  بیست: 20, سی: 30, چهل: 40, پنجاه: 50, شصت: 60, شست: 60, هفتاد: 70, هشتاد: 80, نود: 90,
  صد: 100, یکصد: 100, دویست: 200, دویس: 200, سیصد: 300, سیصدتا: 300, چهارصد: 400, چارصد: 400,
  پانصد: 500, پونصد: 500, پنصد: 500, ششصد: 600, شیشصد: 600, ششصدتا: 600,
  // گویش محاوره‌ای که موتور تشخیص گفتار واقعاً تولید می‌کند؛ نبودشان یعنی
  // «هفصد هزار» بی‌صدا ۱۰۰۰ خوانده می‌شد.
  هفتصد: 700, هفصد: 700, هشتصد: 800, هشصد: 800, نهصد: 900, نهصدتا: 900,
};
const FRACTIONS = { نیم: 0.5, نصف: 0.5 };
// پسوند «ی» صفتی همان مقیاس است: «چک سه میلیونی»، «اسکناس پنجاه هزاری»،
// «جنس ده میلیونی». بدون اینها مبلغ هزار یا یک‌میلیون برابر کوچک خوانده
// می‌شد — «چک سه میلیونی گرفتم» سه تومان ثبت می‌کرد — و بدتر، چون عدد از
// مقیاسش جدا می‌افتاد گاهی دو ثبت جداگانه از یک جمله ساخته می‌شد.
const SCALES = {
  هزار: 1_000, هزارتا: 1_000, هزاری: 1_000,
  میلیون: 1_000_000, میلیونی: 1_000_000,
  میلیارد: 1_000_000_000, میلیاردی: 1_000_000_000,
};
const NUMBER_WORDS = new Set([...Object.keys(VALUES), ...Object.keys(FRACTIONS), ...Object.keys(SCALES)]);
// پول آمده به حساب خودِ واحد. آزمون استرس نشان داد این شکل‌های رایج جهت نداشتند
// و «یه پولی اومده تو حساب ملی» یا «اداره دارایی… عودت داد» خروج پول ثبت
// می‌شد — ردیف تراکنش هم با همان جهت غلط ماندهٔ بانک را جابه‌جا می‌کرد.
const INCOME_WORDS = ['فروش', 'درآمد', 'دریافت', 'واریز', 'واریزی', 'گرفتم', 'فروختم', 'فروختیم', 'دخل', 'وصول', 'دستمزد گرفتم', 'به حسابم آمد', 'به حسابم اومد', 'مشتری کارت به کارت کرد',
  'اومده تو حساب', 'اومد تو حساب', 'به حساب اومده', 'به حساب اومد', 'عودت', 'به حساب شرکت انتقال داد', 'به حساب شرکت واریز کرد'];
const EXPENSE_WORDS = ['هزینه', 'خرج', 'خرید', 'خریدم', 'خریدیم', 'حقوق', 'اجاره', 'پرداخت', 'دادم', 'دادیم', 'برداشت', 'قبض', 'کرایه', 'مواد'];
// فعلِ جهت‌دار از اسم قوی‌تر است. «از مشتری ده میلیون گرفتم بابت پیش پرداخت»
// هم «گرفتم» دارد و هم «پرداخت»؛ با شمارش ساده مساوی می‌شدند و نوع بی‌دلیل
// هزینه می‌افتاد. آنچه جهت پول را تعیین می‌کند فعل است، نه اسمِ کنارش.
const INCOME_VERBS = new Set(['گرفتم', 'فروختم', 'فروختیم', 'واریز', 'واریزی', 'دریافت',
  'اومده تو حساب', 'اومد تو حساب', 'به حساب اومده', 'به حساب اومد', 'عودت', 'به حساب شرکت انتقال داد', 'به حساب شرکت واریز کرد']);
const EXPENSE_VERBS = new Set(['دادم', 'دادیم', 'خریدم', 'خریدیم', 'برداشت']);
const LEARNING_STOP_WORDS = new Set(['امروز', 'دیروز', 'تومان', 'تومن', 'تومنی', 'ریال', 'بابت', 'برای', 'از', 'به', 'را', 'رو', 'کردم', 'دادم', 'گرفتم', 'داشتم', 'خریدم', 'فروختم', 'پرداخت', 'هزینه', 'درآمد', 'فروش', 'حقوق', 'و']);

export const FINANCIAL_SPEECH_PHRASES = [
  'تومان', 'تومن', 'ریال', 'هزار', 'میلیون', 'میلیارد', 'نیم', 'فروش', 'درآمد', 'هزینه',
  'حقوق', 'اجاره', 'خرید', 'پرداخت', 'دریافت', 'مواد', 'کالا', 'قبض', 'کرایه', 'اسنپ',
];

export { normalizePersian };

// «جمع + اجزا» یک رویداد است، نه چند جابه‌جایی پول. تا وقتی مبلغ قابل ثبت و
// تفکیک سند جداگانه تأیید نشده، حتی ردیف نقدی هم نباید ساخته شود.
export const COMPOSITE_AMOUNT_MESSAGE = 'چند مبلغ برای یک رویداد گفته شد (جمع و اجزا)؛ هیچ ثبتی انجام نشد. مبلغ پرداخت یا دریافت و تفکیک اصل، سود، مالیات یا کسورات را با سند اصلی در بخش بررسی حسابداری مشخص کن.';
export function hasCompositeAmounts(input) {
  const normalized = normalizePersian(input);
  if (extractAmounts(normalized).spans.length < 2) return false;
  return /سرمایه.*(?:افزایش|کاهش)|بدهکار.*(?:ببخش|می بخشم|می‌بخشم)/.test(normalized)
    || /شامل|از این مبلغ|جمع کل|مجموع|تفکیک|ناخالص|(?:اصل\s*(?:وام|قسط|تسهیلات)?\s*و\s*(?:سود|بهره))/.test(normalized)
    || /(?:قسط|وام).*(?:اصل).*(?:سود|بهره)/.test(normalized)
    || /(?:اصل\s*(?:وام|قسط|تسهیلات)|سهم\s*کارمند|بهای\s*کالا).*(?:سود|بهره|مالیات|بیمه)/.test(normalized);
}

// موتور تشخیص گفتار عدد و مقیاس را گاهی سرِ هم می‌نویسد («دوهزار»، «دومیلیون»)
// یا «و» را به عدد می‌چسباند («سیصدو»). بدون این ترمیم، هیچ مبلغی پیدا نمی‌شد.
const JOINABLE_VALUES = Object.keys(VALUES).sort((left, right) => right.length - left.length);
const SCALE_WORDS = Object.keys(SCALES).sort((left, right) => right.length - left.length);
const JOINED_SCALE_PATTERN = new RegExp(`(?<![آ-ی])(${JOINABLE_VALUES.join('|')})(${SCALE_WORDS.join('|')})(?![آ-ی])`, 'g');
const TRAILING_VAV_PATTERN = new RegExp(`(?<![آ-ی])(${JOINABLE_VALUES.join('|')})و(?![آ-ی])`, 'g');

// پسوند محاوره‌ای روی واژهٔ مقیاس: «پنجاه میلیونیش»، «چهل میلیونشو»، «ده
// هزارشو». بدون جدا کردنش واژهٔ مقیاس شناخته نمی‌شد و «بدهی پنجاه میلیونیش»
// یک ثبت پنجاه‌تومانی می‌ساخت — در آزمون استرس، به صف حسابدار با مبلغی
// یک‌میلیون‌بار کوچک‌تر.
const SCALE_SUFFIX_PATTERN = /(?<![آ-ی])(هزار|میلیون|میلیارد)(?:ی(?:ش|شو|شم|شون)|ش|شو|شم|شون)(?![آ-ی])/g;

export function repairNumberSpeech(text) {
  return String(text || '')
    .replace(SCALE_SUFFIX_PATTERN, '$1')
    .replace(JOINED_SCALE_PATTERN, '$1 $2')
    .replace(TRAILING_VAV_PATTERN, '$1 و')
    .replace(/\s+/g, ' ')
    .trim();
}

// یک گفته یک مرجع زمانی دارد. تا امروز «دیروز» کاملاً نادیده گرفته می‌شد و سند
// در تاریخ اشتباه، یعنی در دورهٔ مالی اشتباه، می‌نشست.
const RELATIVE_DAYS = [
  [/پریروز/, -2, 'پریروز'],
  [/دیروز/, -1, 'دیروز'],
  [/هفته\s*ی?\s*(?:پیش|گذشته|قبل)/, -7, 'هفتهٔ پیش'],
];

export function relativeDayOffset(text) {
  const normalized = normalizePersian(text);
  for (const [pattern, days, label] of RELATIVE_DAYS) if (pattern.test(normalized)) return { days, label };
  return null;
}

function parseNumericToken(token) {
  const value = String(token || '');
  if (!/^\d[\d,.]*$/.test(value)) return null;
  const commaParts = value.split(',');
  const dotParts = value.split('.');
  if (commaParts.length > 2 || (commaParts.length === 2 && commaParts[1].length === 3)) return Number(value.replace(/,/g, ''));
  if (dotParts.length > 2 || (dotParts.length === 2 && dotParts[1].length === 3)) return Number(value.replace(/\./g, ''));
  if (commaParts.length === 2) return Number(`${commaParts[0]}.${commaParts[1]}`);
  return Number(value);
}

/**
 * «یه» و «یک» پیش از عدد دیگر، حرف تعریف‌اند نه عدد.
 *
 * «یه سی تومن» را ۳۱ می‌خواند، چون «یه» و «سی» با هم جمع می‌شدند. مبلغ اشتباه
 * بدترین نوع خطاست: سند با عددی غلط ثبت می‌شود و هیچ نشانه‌ای هم ندارد.
 *
 * پیش از **مقیاس** دست نمی‌خورد: «یک میلیون» باید یک میلیون بماند.
 */
function dropLeadingArticle(tokens) {
  if (tokens.length < 2) return tokens;
  const [first, second] = tokens;
  if (first !== 'یه' && first !== 'یک') return tokens;
  if (SCALES[second] || FRACTIONS[second] != null) return tokens;
  return VALUES[second] != null || /^\d/.test(second) ? tokens.slice(1) : tokens;
}

export function wordsToNumber(tokens) {
  const normalizedTokens = dropLeadingArticle(tokens.map(normalizePersian).filter(Boolean));
  const shorthandSeparator = normalizedTokens.lastIndexOf('و');
  const hasExplicitScale = normalizedTokens.some((token) => SCALES[token] || FRACTIONS[token] != null);
  if (!hasExplicitScale && shorthandSeparator > 0 && shorthandSeparator < normalizedTokens.length - 1) {
    const leading = wordsToNumber(normalizedTokens.slice(0, shorthandSeparator));
    const trailing = wordsToNumber(normalizedTokens.slice(shorthandSeparator + 1));
    // در گفتار مالی «یک و دویست» یا «دوازده و پونصد» به‌ترتیب
    // ۱٫۲ و ۱۲٫۵ میلیون تومان است. شرط‌ها مانع تبدیل «صد و بیست» می‌شوند.
    if (leading > 0 && leading < 100 && trailing >= 100 && trailing < 1_000) {
      return Math.round(leading * 1_000_000 + trailing * 1_000);
    }
  }
  let total = 0;
  let current = 0;
  let lastLargeScale = 0;
  for (const token of normalizedTokens) {
    if (!token || token === 'و') continue;
    const numeric = parseNumericToken(token);
    if (numeric != null) current += numeric;
    else if (VALUES[token] != null) current += VALUES[token];
    else if (FRACTIONS[token] != null) current += FRACTIONS[token];
    else if (SCALES[token]) {
      const scale = SCALES[token];
      total += (current || 1) * scale;
      current = 0;
      lastLargeScale = scale >= 1_000_000 ? scale : 0;
    }
  }
  // در گفتار روزمره «دو میلیون و پونصد» یعنی دو میلیون و پانصد هزار.
  if (current && lastLargeScale >= 1_000_000 && current < 1) total += current * lastLargeScale;
  else if (current && lastLargeScale >= 1_000_000 && current < 1_000) total += current * (lastLargeScale / 1_000);
  else total += current;
  return Math.round(total);
}

function tokenize(text) {
  return [...text.matchAll(/[0-9][0-9,.]*|[آ-ی]+/g)]
    .map((match) => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
}

function isNumericWord(value) { return /^\d/.test(value) || NUMBER_WORDS.has(value); }

// نام ماه پس از عدد یعنی تاریخ، نه مبلغ. بدون این، «۲۵ مرداد قبض دادم» یک ثبت
// بیست‌وپنج تومانی می‌ساخت — همان خطای بی‌صدایی که در بخش مبلغ بسته شد.
// واحد زمان هم مبلغ نیست و این در آزمون صوتی روی سناریوهای واقعی پیدا شد:
// «برای شش ماه جلوتر تسویه کردم» یک تراکنش شش تومانی می‌ساخت و «بیمه یک‌ساله»
// یک تراکنش یک‌تومانی. رکورد شبح در دفتر بدتر از ثبت‌نشدن است، چون هیچ‌کس
// دنبالش نمی‌گردد و در تراز هم گم می‌شود.
// شمارش کالا هم مبلغ نیست: «دسته چک پنجاه برگه» یک کارمزد پنجاه تومانی می‌ساخت.
const NON_AMOUNT_UNITS = ['تا', 'عدد', 'نفر', 'کیلو', 'کیلوگرم', 'گرم', 'متر', 'درصد', 'درصدی', 'بسته', 'کارتن',
  'برگ', 'برگه', 'دستگاه', 'جلد', 'قلم', 'جفت', 'لیتر', 'کیسه', 'رول', 'ورق',
  'ماه', 'ماهه', 'ماهانه', 'سال', 'ساله', 'سالانه', 'هفته', 'هفتگی', 'روزه', 'روزانه', 'ساعته',
  ...PERSIAN_MONTHS.map(([name]) => name)];
const IDENTIFIER_PREFIXES = ['شماره', 'فاکتور', 'رسید', 'سفارش', 'کد', 'تلفن', 'موبایل', 'ساعت', 'روز', 'تاریخ'];

/**
 * تاریخ، مبلغ نیست.
 *
 * «امروز ۲۴ میلیون… از اول آبان ۱۴۰۵ تا پایان مهر ۱۴۰۶ پرداخت کردم» دو تراکنش
 * می‌ساخت: ۲۴ میلیون، و یک تراکنش «۱٬۴۰۶ تومانی» از سالِ پایان دوره. روز ماه
 * پیش از نام ماه («۲۰ آذر») از قبل کنار گذاشته می‌شد، ولی سالِ بعد از نام ماه،
 * سال بی‌نام ماه، و تاریخ عددی («۱۴۰۵/۰۷/۱۵») نه — تاریخ عددی حتی بدتر بود:
 * سه بخشش با هم جمع می‌شدند و یک مبلغ ۱۴۲۷ تومانی می‌ساختند.
 *
 * سه قاعده، از قطعی به محتاط:
 *
 * ۱. **تاریخ عددی کامل** — سال/ماه/روز یا روز/ماه/سال با یک جداکنندهٔ یکسان و
 *    محدودهٔ معتبر — پیش از هر چیز پوشانده می‌شود. «2.500.000» تاریخ نیست چون
 *    بخش میانی‌اش ماه نیست.
 * ۲. **سال در بافت تاریخ** — بعد از نام ماه، «ماه» یا «سال»، یا پیش از «شمسی»
 *    و «میلادی» — حتی اگر با حروف گفته شده باشد («مهر هزار و چهارصد و شش»).
 * ۳. **سالِ برهنه** — عدد چهاررقمی ۱۳۰۰ تا ۱۴۹۹ (یا ۱۹۰۰ تا ۲۱۰۰) که هیچ واحد
 *    پولی پشتش نیست. «۱۴۰۵ تومان» مبلغ می‌ماند؛ «مالیات ۱۴۰۴» نه.
 *
 * در هر سه حالت، واحد پولِ چسبیده («… ۱۴۰۵ تومان») قاعده را لغو می‌کند.
 */
const isYearLike = (value) => (value >= 1300 && value <= 1499) || (value >= 1900 && value <= 2100);
const MONEY_AFTER = /^(?:تومان|تومن|ریال|هزار|میلیون|میلیارد|دلار|یورو|درهم)/;
const DATE_SUFFIX = /^(?:شمسی|هجری|ه\s*\.?\s*ش|میلادی)/;
const YEAR_CONTEXT = new RegExp(`(?:^|\\s)(?:${PERSIAN_MONTHS.map(([name]) => name).join('|')}|ماه|سال)(?:\\s+(?:ماه|سال|مالی))*$`);
const NUMERIC_DATE = /(?<![\d,.])(\d{1,4})([/\-.])(\d{1,2})\2(\d{1,4})(?![\d,]|\.\d)/g;

function looksLikeDate(first, month, last) {
  const [x, m, z] = [Number(first), Number(month), Number(last)];
  if (!(m >= 1 && m <= 12)) return false;
  const yearFirst = (first.length === 4 ? isYearLike(x) : first.length === 2) && z >= 1 && z <= 31;
  const dayFirst = x >= 1 && x <= 31 && (last.length === 4 ? isYearLike(z) : last.length === 2);
  return yearFirst || dayFirst;
}

/** تاریخ عددی کامل با فاصلهٔ هم‌طول جایگزین می‌شود تا جای بقیهٔ جمله تکان نخورد. */
function maskNumericDates(text) {
  return text.replace(NUMERIC_DATE, (match, first, _separator, month, last) => (
    looksLikeDate(first, month, last) ? ' '.repeat(match.length) : match));
}

function isYearSpan(span, before, after) {
  if (!isYearLike(span.amount) || MONEY_AFTER.test(after)) return false;
  if (YEAR_CONTEXT.test(before) || DATE_SUFFIX.test(after)) return true;
  // سال برهنه فقط به شکل رقمی؛ «هزار و چهارصد» با حروف بی‌بافت تاریخ، مبلغ است.
  return /^\d{4}$/.test(span.raw.replace(/[.,]+$/, ''));
}

// عبارت‌های دوکلمه‌ای که هیچ خوانش مبلغی ندارند. این‌ها از معافیتِ واژهٔ مقیاس
// هم قوی‌ترند: در «کد حساب هزار و دویست»، وجود «هزار» باعث می‌شد عدد مبلغ
// شمرده شود و کد حساب وارد دفتر شود. برعکسش «فاکتور پنج میلیون» یک مبلغ واقعی
// است، پس «فاکتور»ِ تنها در فهرست ضعیف می‌ماند.
const STRONG_IDENTIFIER_PREFIXES = [
  'کد حساب', 'شماره حساب', 'شماره فاکتور', 'شماره سند', 'کد ملی',
  'کد اقتصادی', 'شماره پیگیری', 'کد رهگیری', 'شماره کارت', 'شماره شبا',
];

function isNonAmountSpan(text, span) {
  const raw = text.slice(span.start, span.end);
  const before = text.slice(Math.max(0, span.start - 24), span.start).trim();
  const after = text.slice(span.end, Math.min(text.length, span.end + 18)).trim();
  const precededBy = (prefixes) => prefixes.some((prefix) => before === prefix || before.endsWith(` ${prefix}`));

  // شناسهٔ صریح، حتی با واژهٔ مقیاس، هرگز مبلغ نیست.
  if (precededBy(STRONG_IDENTIFIER_PREFIXES)) return true;
  // سال، حتی با «هزار» در خودش («مهر هزار و چهارصد و شش»)، مبلغ نیست.
  if (isYearSpan(span, before, after)) return true;
  // عددهای دارای مقیاس پولی، حتی اگر کنار واژه‌های دیگر باشند، مبلغ محسوب می‌شوند.
  if (/هزار|میلیون|میلیارد/.test(raw)) return false;
  // واژهٔ بعدی، بی‌توجه به ویرگول و نقطه: «پنجاه برگه، کارمزد…».
  if (NON_AMOUNT_UNITS.includes(after.split(/[\s،,.؛:]/)[0])) return true;
  return precededBy(IDENTIFIER_PREFIXES);
}

export function extractAmounts(input) {
  const text = maskNumericDates(repairNumberSpeech(normalizePersian(input)));
  const tokens = tokenize(text);
  const spans = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isNumericWord(token.value)) continue;
    const collected = [token.value];
    let cursor = index + 1;
    let end = token.end;
    while (cursor < tokens.length) {
      const next = tokens[cursor];
      // ویرگول و نقطه میان دو واژهٔ عددی یعنی دو عدد جدا: «…هزار و چهارصد و شش،
      // دوازده میلیون» یک مبلغ ۴۱۸ میلیونی می‌ساخت.
      if (/[،,؛;.:!؟?\n]/.test(text.slice(end, next.start))) break;
      if (isNumericWord(next.value)) {
        collected.push(next.value);
        end = next.end;
        cursor += 1;
        continue;
      }
      if (next.value === 'و' && isNumericWord(tokens[cursor + 1]?.value)) {
        collected.push(next.value);
        end = next.end;
        cursor += 1;
        continue;
      }
      break;
    }
    const amount = wordsToNumber(collected);
    if (amount > 0) {
      // مقیاس بدون عدد («... هزار تومان») تقریباً همیشه یعنی عددِ پیش از آن
      // شنیده نشده است. wordsToNumber ناچار ۱×مقیاس برمی‌گرداند؛ این پرچم
      // جلوی ثبت آن به‌عنوان یک مبلغ مطمئن را می‌گیرد.
      // «یه» تنها هیچ‌وقت مبلغ نیست: «یه جوری ثبت کن» یک تراکنش هزارتومانی
      // می‌ساخت. حرف تعریف بدون عدد و بدون مقیاس، عدد نیست.
      if (collected.length === 1 && (collected[0] === 'یه' || collected[0] === 'یک')) { index = cursor - 1; continue; }
      const bareScale = Boolean(SCALES[collected[0]]);
      const span = { amount, start: token.start, end, raw: text.slice(token.start, end), bareScale };
      if (!isNonAmountSpan(text, span)) spans.push(span);
    }
    index = cursor - 1;
  }
  /**
   * عددِ برهنهٔ کوچک، درست پیش از یک مبلغ، شمارنده است نه پول.
   *
   * «یه فروش یک و دویست»، «یک چک سه میلیونی»، «دو فاکتور دو میلیونی»: آن
   * «یک» تعداد سند است، ولی به‌عنوان یک تومان ثبت می‌شد و از یک جمله دو
   * تراکنش می‌ساخت. بدتر از پیدانکردن است، چون کاربر یک عدد می‌بیند و ممکن
   * است تأییدش کند.
   *
   * قاعده قبلاً فهرستی از اسم‌ها بود («فروش»، «خرید»…) و هر اسم تازه‌ای —
   * «قرارداد»، «اسکناس» — از آن رد می‌شد. حالا معیار خودِ ساختار است: عدد
   * کوچکِ بی‌مقیاس، چسبیده به مبلغ بعدی، بدون واحد پول در میانه. اگر واحد
   * پول آمده باشد («پنجاه تومان قبض دادم و دو میلیون فروختم») مبلغ واقعی
   * است و دست‌نخورده می‌ماند.
   */
  const currencyBetween = /تومان|تومن|ریال|\d/;
  const filteredSpans = spans.filter((span, index) => {
    const next = spans[index + 1];
    if (!next || span.amount >= 100) return true;
    const between = text.slice(span.end, next.start);
    if (currencyBetween.test(between)) return true;
    return between.trim().split(/\s+/).filter(Boolean).length > 3;
  });
  return { text, spans: filteredSpans };
}

export function inferLearningKeyword(input) {
  const normalized = normalizePersian(input).replace(/[0-9,.]/g, ' ');
  const words = normalized.split(/\s+/).filter((word) => word && !NUMBER_WORDS.has(word) && !LEARNING_STOP_WORDS.has(word));
  return words.slice(0, 3).join(' ').trim();
}

function containsAny(text, words) { return words.some((word) => text.includes(word)); }

/** فعل جهت‌دار دو امتیاز می‌گیرد و اسم یک امتیاز. */
function signalScore(text, words, verbs) {
  return words.reduce((sum, word) => (text.includes(word) ? sum + (verbs.has(word) ? 2 : 1) : sum), 0);
}

/**
 * جهت پول و دستهٔ یک تراکنش.
 *
 * `categoryContext` عمداً جداست از `context`.
 *
 * برای تشخیص **جهت**، متنِ بعد از مبلغ ترجیح دارد: در جمله‌ای که چند مبلغ
 * دارد، فعلِ هر تراکنش بعد از مبلغ خودش می‌آید و نگاه‌کردن به عقب، فعلِ
 * تراکنش قبلی را قرض می‌گیرد.
 *
 * برای تشخیص **دسته** عکسش درست است: در فارسی گفتاری موضوع تقریباً همیشه پیش
 * از مبلغ می‌آید — «قبض برق رو سه میلیون پرداخت کردم». اگر همان پنجرهٔ جهت را
 * برای دسته هم استفاده کنیم، «قبض برق» دور ریخته می‌شود و فقط «پرداخت کردم»
 * می‌ماند که هیچ دسته‌ای در آن نیست. نتیجه‌اش «سایر هزینه‌ها» بود با این دلیلِ
 * گمراه‌کننده که «واژهٔ شناخته‌شده‌ای در متن نبود» — در حالی که بود، فقط یک
 * کلمه آن‌طرف‌تر.
 */
/**
 * نام نقش، فعل نیست.
 *
 * «فروشنده»، «فروشگاه» و «خریدار» هر کدام واژهٔ جهت را در خود دارند و با
 * تطبیق زیررشته‌ای جهت پول را برعکس می‌کردند: «یه دستگاه خریدیم… فروشنده
 * فاکتور غیررسمی داده» درآمد ثبت می‌شد.
 */
const ROLE_NOUNS = /فروشنده|فروشگاه|خریدار/g;

/**
 * هدف خرید، نشانهٔ فروش نیست.
 *
 * «سی کارتن روغن موتور برای فروش در مغازه… از بانک ملت خریدیم» درآمد ثبت
 * می‌شد: «فروش» واژهٔ دستهٔ درآمد است و فعل «خریدیم» شمرده نمی‌شد. «برای
 * فروش» می‌گوید کالا چرا خریده شده، نه اینکه پولی آمده.
 */
const PURPOSE_PHRASES = /(?:برای|واسه|جهت)\s*(?:فروش|فروختن)(?:\s*مجدد)?/g;
/** فعل خرید یا پرداختِ اول‌شخص: جهت پول را صریح می‌گوید و دسته نقضش نمی‌کند. */
const FIRST_PERSON_OUT = /خرید(?:م|یم)(?![آ-ی])|پرداخت\s*کرد(?:م|یم)|(?<!تحویل\s)داد(?:م|یم)(?![آ-ی])/;
/** فعل گذشتهٔ جابه‌جایی پول — «دادیم»، «گرفتیم»، «واریز شد» — نه اسم «خرید». */
const PAST_MONEY_VERB = /(?:داد(?:یم|م)?|گرفت(?:یم|م)?|خرید(?:یم|م)|ریخت(?:یم|م)?)(?![آ-ی])|(?:واریز|پرداخت|کارت\s*به\s*کارت)\s*(?:شد|کرد(?:یم|م)?)(?![آ-ی])/;

const MONEY_IN_PHRASE = /اومده?\s*تو\s*حساب|به\s*حساب\s*(?:\S+\s*)?اومد|عودت\s*(?:داد|دادن|کرد)|به\s*حساب\s*شرکت\s*(?:انتقال\s*داد|واریز\s*کرد|ریخت)|واریز\s*شد\s*به\s*حساب/;
/**
 * کسی دیگر به حساب ما ریخت — فعل سوم‌شخص، مقصد حساب خودمان.
 *
 * «خانم رضایی… بیعانه به بانک ملت کارت به کارت کرد» پرداخت ما خوانده می‌شد
 * چون «کارت به کارت» واژهٔ عمومی پرداخت است. فعل سوم‌شخصِ بی‌پسوند («کرد» نه
 * «کردم») و مقصدی که حساب خودِ ماست، جهت را صریح می‌کنند.
 */
const THIRD_PERSON_IN = /(?:به|تو|توی)\s*(?:حساب\s*)?(?:بانک\s*\S+|حسابمون|حساب\s*(?:ما|شرکت))\s*(?:\S+\s*){0,3}?(?:کارت\s*به\s*کارت\s*کرد|واریز\s*کرد|انتقال\s*داد|ریخت)(?![آ-ی])|(?:بهمون|به\s*ما|بهم)\s*(?:\S+\s*){0,1}?(?:داد|پرداخت\s*کرد|واریز\s*کرد|کارت\s*به\s*کارت\s*کرد)(?![آ-ی])/;
/** طلبی که هنوز وصول نشده: «قراره بدن ولی هنوز پولی نگرفتیم». */
const RECEIVABLE_STATEMENT = /قرار(?:ه)?\s*(?:بدن|بده|بدهند|پرداخت\s*کنن)|(?:پولش|پولی|پولشو)\s*(?:رو\s*)?(?:هنوز\s*)?نگرفتیم|هنوز\s*(?:پولش|پولی)\s*(?:رو\s*)?نگرفتیم/;
// فعل پرداختِ اول‌شخص. «برای خرید مواد اولیه» اسم است، نه فعل؛ جلوی تشخیص
// ورود را نمی‌گیرد.
const MONEY_OUT_VERB = /(?:دادم|دادیم|ریختم|ریختیم|زدم|زدیم|خریدم|خریدیم|پرداخت\s*(?:کردم|کردیم)|برداشت\s*کرد)/;

function sentenceMoneyIn(input) {
  const text = normalizePersian(input);
  // «تحویل دادیم» و «انجام دادیم» دربارهٔ کار است، نه پول.
  const payments = text.replace(/(?:تحویل|انجام)\s*داد(?:یم|م)/g, ' ');
  return (MONEY_IN_PHRASE.test(text) || THIRD_PERSON_IN.test(text) || RECEIVABLE_STATEMENT.test(text)) && !MONEY_OUT_VERB.test(payments);
}

/** نشانهٔ ورودِ صریح، نه حدسی: اطمینانش پایین نمی‌آید. */
function explicitMoneyIn(input) {
  const text = normalizePersian(input);
  return THIRD_PERSON_IN.test(text) || RECEIVABLE_STATEMENT.test(text);
}

function classify(context, learnings = [], categoryContext = '') {
  const normalizedContext = normalizePersian(context).replace(ROLE_NOUNS, ' ').replace(PURPOSE_PHRASES, ' ');
  const normalizedCategoryContext = (normalizePersian(categoryContext) || normalizePersian(context)).replace(ROLE_NOUNS, ' ').replace(PURPOSE_PHRASES, ' ');
  const learned = learnings.find((item) => normalizedCategoryContext.includes(normalizePersian(item.keyword)));
  const incomeScore = signalScore(normalizedContext, INCOME_WORDS, INCOME_VERBS);
  const expenseScore = signalScore(normalizedContext, EXPENSE_WORDS, EXPENSE_VERBS);
  const hasIncome = incomeScore > 0;
  const hasExpense = expenseScore > 0;
  const onlyOneSide = hasIncome !== hasExpense;
  // وقتی هر دو نشانه هست، فعلِ جهت‌دار برنده می‌شود؛ ولی اطمینان پایین می‌ماند
  // تا کاربر نگاهش کند، چون جمله واقعاً هر دو نشانه را داشته است.
  let type = incomeScore > expenseScore ? 'income' : 'expense';
  let confidence = onlyOneSide ? 0.93 : incomeScore === expenseScore ? 0.58 : 0.72;
  let typeReason = onlyOneSide
    ? `نوع از واژهٔ ${hasIncome ? 'درآمدی' : 'هزینه‌ای'} متن تشخیص داده شد.`
    : incomeScore === expenseScore
      ? 'متن هم‌زمان نشانهٔ روشن درآمد یا هزینه ندارد.'
      : `متن هر دو نشانه را دارد؛ نوع از فعل ${type === 'income' ? 'دریافت' : 'پرداخت'} برداشت شد و باید کنترل شود.`;
  // نگاشت تأییدشدهٔ کاربر از هر قاعده‌ای قوی‌تر است: او یک‌بار همین را اصلاح
  // کرده و نباید دوباره از او پرسیده شود.
  let category = learned?.category;
  let categoryConfidence = 0.98;
  let categoryReason = learned ? `بر اساس نگاشت تأییدشدهٔ «${learned.keyword}» انتخاب شد.` : '';
  let categoryAmbiguous = false;
  let categoryRunnerUp = null;
  if (learned) confidence = Math.max(confidence, 0.96);
  if (!category) {
    let suggestion = classifyCategory(normalizedCategoryContext, type);
    /**
     * وقتی سمتِ تشخیص‌داده‌شده هیچ واژه‌ای ندارد ولی سمت مقابل دارد، جهت پول
     * غلط خوانده شده است.
     *
     * «بنزین گرفتم» و «ناهار پرسنل گرفتم» درآمد ثبت می‌شدند، چون «گرفتم»
     * فعل درآمدی است — درحالی‌که اینجا یعنی «خریدم». و چون `classifyCategory`
     * با همان نوعِ غلط صدا زده می‌شود و بر اساس نوع فیلتر می‌کند، «سوخت» و
     * «خوراک» اصلاً نامزد نمی‌شدند؛ دسته روی «سایر درآمدها» می‌افتاد و کاربر
     * باید هم نوع و هم دسته را دستی درست می‌کرد.
     *
     * اصلاحِ وارونه‌اش از قبل بود («دستهٔ درآمدی روی تراکنش هزینه») ولی فقط
     * برای نگاشت تأییدشدهٔ کاربر کار می‌کرد، چون دستهٔ خودکار هرگز نمی‌تواند
     * نوع را نقض کند.
     *
     * شرط عمداً سخت است: سمت فعلی باید هیچ واژه‌ای نداشته باشد و سمت مقابل
     * تطابق روشن. «از مشتری گرفتم» هیچ‌کدام را ندارد و دست‌نخورده می‌ماند.
     */
    if (!suggestion.matched && !(type === 'expense' && FIRST_PERSON_OUT.test(normalizedContext))) {
      const oppositeType = type === 'income' ? 'expense' : 'income';
      const opposite = classifyCategory(normalizedCategoryContext, oppositeType);
      if (opposite.matched && opposite.confidence >= 0.86) {
        type = oppositeType;
        typeReason = `نوع با واژهٔ دستهٔ «${opposite.category}» هماهنگ شد؛ فعل جمله جهت دیگری را نشان می‌داد.`;
        // زیر آستانهٔ بازبینی عمداً: فعل و اسمِ جمله با هم نخواندند و کاربر
        // باید یک نگاه بیندازد. یک‌بار. بعد از تأیید او، نگاشت یادگرفته‌شده
        // این مسیر را دور می‌زند و دیگر پرسیده نمی‌شود.
        confidence = Math.min(confidence, 0.68);
        suggestion = opposite;
      }
    }
    category = suggestion.category;
    categoryConfidence = suggestion.confidence;
    categoryReason = suggestion.reason;
    categoryAmbiguous = suggestion.ambiguous;
    categoryRunnerUp = suggestion.runnerUp;
  }
  /**
   * دسته و نوع هرگز نباید با هم نخوانند؛ دسته مرجع است چون از واژهٔ صریح‌تری
   * آمده.
   *
   * این اصلاح فقط یک‌طرفه بود — دستهٔ درآمدی می‌توانست «هزینه» را برگرداند
   * ولی عکسش نه — و روی نگاشت تأییدشدهٔ کاربر رکورد خودمتناقض می‌ساخت: کاربر
   * یک‌بار «بنزین» را به «سوخت و ایاب‌وذهاب» نگاشت می‌کرد و از آن به بعد
   * «بنزین گرفتم» نوعِ درآمد با دستهٔ هزینه‌ای می‌گرفت. یعنی همان تأییدِ کاربر
   * که قرار بود مسئله را حل کند، آن را بدتر می‌کرد.
   */
  const categoryType = CATEGORY_DEFINITIONS.find((item) => item.name === category)?.type;
  if (categoryType && categoryType !== type) {
    type = categoryType;
    typeReason = `نوع با دستهٔ «${category}» هماهنگ شد.`;
    confidence = Math.max(confidence, categoryConfidence);
  }
  return {
    type, category, confidence, typeConfidence: confidence, typeReason, categoryConfidence, categoryReason,
    chartCode: chartCodeForCategory(category), categoryAmbiguous, categoryRunnerUp,
  };
}

/**
 * یک جملهٔ گفته‌شده، چند بار شنیده شده.
 *
 * تشخیص زندهٔ اندروید هر نسخهٔ نیمه‌تمام جمله را جدا برمی‌گرداند و متن به
 * پلکان تبدیل می‌شود: «پرداخت ۹۳ / پرداخت ۹۳ میلیون / پرداخت ۹۳ میلیون
 * تومان …». ریشه‌اش در لایهٔ گفتار بسته شد، ولی این لایه هم نباید به آن
 * تکیه کند: هر منبع دیگری — Whisper، متن چسبانده‌شدهٔ کاربر — می‌تواند همین
 * تکرار را بسازد.
 *
 * و پیامدش از زشتیِ متن خیلی بدتر است: هر «۹۳» یک مبلغ جدا شمرده می‌شود و یک
 * جمله به چهارده ثبتِ ۹۳ میلیونی تبدیل می‌شود — یک‌میلیارد و سیصد میلیون
 * هزینهٔ ساختگی، با یک بار تأیید.
 *
 * قاعده: مبلغ‌های پشت‌سرهمِ یکسان با همان نوع و همان دسته، یک ثبت‌اند. حذف
 * بی‌صدا نیست؛ شمارشش در دلیل بررسی نوشته می‌شود تا اگر واقعاً دو پرداختِ
 * هم‌مبلغ بوده، کاربر خودش دومی را اضافه کند.
 */
function collapseRepeatedTransactions(transactions) {
  const collapsed = [];
  for (const transaction of transactions) {
    const previous = collapsed[collapsed.length - 1];
    const sameEntry = previous
      && previous.amount === transaction.amount
      && previous.type === transaction.type
      && previous.category === transaction.category;
    if (!sameEntry) { collapsed.push({ ...transaction, repeatCount: 1 }); continue; }
    previous.repeatCount += 1;
  }
  return collapsed.map((transaction) => {
    if (transaction.repeatCount < 2) { const { repeatCount, ...rest } = transaction; return rest; }
    const { repeatCount, ...rest } = transaction;
    const reason = `این مبلغ ${repeatCount} بار پشت سر هم شنیده شد و یک ثبت در نظر گرفته شد؛ اگر واقعاً چند پرداخت بوده، بقیه را خودت اضافه کن.`;
    return withReviewAssessment({
      ...rest,
      needsReview: true,
      reviewReasons: [...(rest.reviewReasons || []), reason],
      warning: rest.warning || reason,
      confidenceDetails: {
        ...rest.confidenceDetails,
        // تکرارِ غیرعادی یعنی خودِ شنیدن مشکوک است، نه فقط دسته‌بندی.
        amount: { score: 0.4, reason: `مبلغ ${repeatCount} بار تکرار شد؛ تشخیص گفتار احتمالاً یک جمله را چند بار نوشته است.` },
      },
    });
  });
}

export function parseFinancialText(input, { learnings = [], averages = {}, source = 'text', now = new Date() } = {}) {
  if (hasCompositeAmounts(input)) return { transcript: normalizePersian(input), transactions: [], clarification: COMPOSITE_AMOUNT_MESSAGE };
  // تاریخ پیش از مبلغ خوانده می‌شود، چون رقم‌های تاریخ نباید مبلغ شمرده شوند.
  //
  // «در تاریخ 15 5 1405 13 میلیون تومان» مبلغ را ۱٬۴۳۸٬۰۰۰٬۰۰۰ می‌خواند:
  // ۱۵ و ۵ و ۱۴۰۵ و ۱۳ همه در یک عدد جمع می‌شدند. این بدترین نوع خطاست، چون
  // سند با مبلغی صد برابر ثبت می‌شود و هیچ نشانه‌ای هم ندارد.
  // طول خدمت («برای ۶ ماه آینده») تاریخ وقوع پرداخت نیست.
  const duration = readServicePeriod(normalizePersian(input), { occurredAt: now.toISOString() });
  const dateSource = duration
    ? normalizePersian(input).replace(/(?:برای\s*)?(?:\d+|یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|دوازده)\s*ماه\s*(?:آینده|جلوتر|بعد|پیش\s*رو|آتی)/g, ' ')
    : input;
  // A due-date clause is not the occurrence date of an unpaid bill.
  const occurrenceSource = normalizePersian(dateSource).replace(/(?:موعد\s*پرداخت(?:ش)?|سررسید(?:ش)?)\s*[^،,.؛]*/g, ' ');
  const mentionedDate = extractOccurrenceDate(occurrenceSource, { now, preferPast: true });
  // تاریخِ آینده در جمله‌ای که پول را با فعل گذشته گفته، تاریخ وقوع نیست.
  //
  // «ده میلیون پیش‌پرداخت دادیم که جنس رو هفته بعد تحویل بده» و «دویست میلیون
  // وام گرفتیم؛ قسط‌هاش از ماه بعد شروع می‌شه» پرداخت و دریافت را به هفته و ماه
  // بعد می‌بردند: آن تاریخ مال تحویل و قسط است. پولی که «دادیم» امروز رفته.
  const futureOfPast = mentionedDate?.iso && Date.parse(mentionedDate.iso) > now.getTime() + 43_200_000
    && PAST_MONEY_VERB.test(occurrenceSource);
  const occurredAt = futureOfPast ? null : mentionedDate?.iso || null;
  // بانک روی متن اصلی خوانده می‌شود، پیش از هر ماسکی، تا جای تطبیق جابه‌جا نشود.
  const bank = detectBank(input);
  // جابه‌جایی بین دو حساب خودِ دفتر. تا امروز این جمله هزینه ثبت می‌شد و یک
  // زیان جعلی می‌ساخت که — برخلاف خطای پیش‌پرداخت — هیچ‌وقت خودش را اصلاح
  // نمی‌کند. تشخیصش از قبل نوشته شده بود و هیچ‌کس صدایش نمی‌زد.
  const transferPair = detectTransferBanks(input);
  // «از تنخواه پذیرایی خریدیم»: پول از حساب تنخواه رفته، نه از صندوق اصلی.
  const petty = readPettyCash(input);
  // یک بار برای کل جمله، نه برای هر تراکنش: تایپ زنده بودجهٔ میلی‌ثانیه‌ای
  // دارد و همین اشتباه یک بار با تشخیص انتقال تکرار شده بود.
  const prepayment = readPrepaymentMention(input);
  // دوره و نشانهٔ پرداخت‌نشدن هم یک بار برای کل جمله، نه برای هر تراکنش.
  const unpaid = readUnpaidSignal(input);
  const eventNature = readEventNature(input);
  // دوره نسبت به تاریخ رویداد حساب می‌شود، نه تاریخ اجرای کد: «برای شش ماه
  // جلوتر» در جمله‌ای که تاریخش دیروز است، از دیروز شروع می‌شود.
  const servicePeriod = readServicePeriod(normalizePersian(input), { occurredAt: occurredAt || now.toISOString() });
  // فقط بخشِ تاریخ با فاصله جایگزین می‌شود تا بقیهٔ جمله و مبلغ دست‌نخورده بماند.
  let amountSource = mentionedDate?.match || bank
    ? normalizePersian(input)
    : input;
  if (mentionedDate?.match) amountSource = amountSource.replace(mentionedDate.match, ' '.repeat(mentionedDate.match.length));
  // نام بانک هم ماسک می‌شود، وگرنه «بانک صادرات» دستهٔ «صادرات» می‌سازد و
  // «بانک مسکن» را هزینهٔ اجاره می‌خواند.
  if (bank) amountSource = amountSource.replace(bank.matchedText, ' '.repeat(bank.matchedText.length));
  const { text, spans } = extractAmounts(amountSource);
  // نام طرف حساب از همان جمله برداشته می‌شود، حتی وقتی جمله «طلب و بدهی»
  // نیست. «۹۳ میلیون تومان به شرکت آراد گستر آسیا پرداخت شد» تا امروز یک
  // هزینهٔ ساده ثبت می‌شد و نام شرکت دور ریخته می‌شد — شرکتی که کارت حساب
  // داشت، هیچ ردی از این پرداخت در کارتش نمی‌ماند.
  //
  // اینجا فقط نام برداشته می‌شود. اینکه این پرداخت تسویهٔ بدهی اوست یا هزینه،
  // به ماندهٔ همان شخص در دفتر بستگی دارد و تصمیمش با سرور است.
  //
  // دارندهٔ تنخواه طرف حساب نیست: در «آقای رضایی از تنخواه به آقای کریمی بابت
  // تعمیر داد» پول را کریمی گرفته و رضایی فقط از تنخواه پرداخته است.
  const contactSource = petty?.holder
    ? input.replace(new RegExp(`(?:(?:آقای|اقای|خانم|مهندس|دکتر|حاج|حاجی)[\\s\\u200c]*)?${petty.holder}`), (match) => ' '.repeat(match.length))
    : input;
  const counterparty = extractContactCandidate(contactSource);
  const counterpartyName = counterparty.name;
  const moneyDirection = counterpartyName ? counterpartyMoneyDirection(contactSource) : '';
  const categoryWords = CATEGORY_DEFINITIONS.flatMap((item) => item.keywords.map((keyword) => keyword.word));
  const signalWords = [...INCOME_WORDS, ...EXPENSE_WORDS, ...categoryWords];
  const transactions = spans.map((span, index) => {
    const previousEnd = spans[index - 1]?.end ?? 0;
    const nextStart = spans[index + 1]?.start ?? text.length;
    const afterRaw = text.slice(span.end, nextStart).trim();
    const beforeRaw = text.slice(previousEnd, span.start).trim();
    // نشانه‌های قیمتی ارزش افزوده — «با ارزش افزوده»، «به علاوهٔ مالیات» — از
    // پنجرهٔ دسته و جهت کنار می‌روند. آن‌ها می‌گویند قیمت چطور حساب شده، نه
    // موضوع خرج چیست؛ ولی قوی‌ترین واژهٔ جمله بودند و «لپ‌تاپ خریدم با احتساب
    // ارزش افزوده» را «مالیات و عوارض» می‌کردند و «فروش ۱۰۰ میلیون به علاوه
    // ارزش افزوده» را حتی هزینه. متن خام ردیف دست‌نخورده می‌ماند تا نگهبان
    // ارزش افزوده همان را ببیند.
    const afterAmount = withoutVatQualifiers(afterRaw);
    const beforeAmount = withoutVatQualifiers(beforeRaw);
    const afterSignals = containsAny(afterAmount, signalWords);
    const context = afterSignals ? afterAmount : `${beforeAmount} ${afterAmount}`.trim();
    const rawContext = afterSignals ? afterRaw : `${beforeRaw} ${afterRaw}`.trim();
    // پنجرهٔ دسته از پنجرهٔ جهت جداست.
    //
    // موضوعِ خرج در فارسی گفتاری تقریباً همیشه پیش از مبلغ می‌آید: «قبض برق رو
    // سه میلیون پرداخت کردم». پنجرهٔ بالا به‌محض دیدن یک فعل بعد از مبلغ، هرچه
    // قبلش بوده دور می‌ریزد — و دسته همان‌جا بود. پس فقط وقتی به متنِ بعد از
    // مبلغ بسنده می‌کنیم که خودش واژهٔ دسته داشته باشد.
    const categoryContext = containsAny(afterAmount, categoryWords)
      ? afterAmount
      : `${beforeAmount} ${afterAmount}`.trim();
    let classified = classify(context, learnings, categoryContext);
    // جهت پول از کل جمله، وقتی جمله یک مبلغ بیشتر ندارد.
    //
    // پنجرهٔ جهت فقط متنِ کنار مبلغ را می‌بیند و «یه پولی اومده تو حساب ملی
    // بیست و دو میلیون، معلوم نیس کی ریخته» را خروج پول می‌خواند چون نشانهٔ
    // ورود پیش از مبلغ آمده. ردیف تراکنش با جهت غلط، ماندهٔ بانک را غلط
    // می‌گذارد — حتی وقتی سندش به صف حسابدار رفته.
    if (spans.length === 1 && classified.type === 'expense' && sentenceMoneyIn(input)) {
      const incomeCategory = classifyCategory(normalizePersian(categoryContext || context).replace(ROLE_NOUNS, ' '), 'income');
      classified = {
        ...classified, type: 'income', category: incomeCategory.category, chartCode: chartCodeForCategory(incomeCategory.category),
        confidence: explicitMoneyIn(input) ? 0.86 : Math.min(classified.confidence, 0.68),
        typeReason: explicitMoneyIn(input)
          ? 'جمله صریح می‌گوید طرف مقابل به حساب ما ریخته یا باید بدهد؛ جهت از کل جمله برداشت شد.'
          : 'جمله صریح می‌گوید پول به حساب آمده؛ جهت از کل جمله برداشت شد و باید کنترل شود.',
      };
    }
    let amount = span.amount;
    // «پنجاه تومن» یعنی پنجاه هزار تومان. هیچ چیزی در ایران امروز پنجاه تومان
    // نیست، پس محدودکردن این قاعده به سه‌رقمی‌ها فقط مبلغ‌های کوچک را خراب می‌کرد.
    const colloquialThousands = amount > 0 && amount < 1_000
      && !/\d|هزار|میلیون|میلیارد/.test(span.raw)
      && /تومان|تومن/.test(context);
    if (colloquialThousands) amount *= 1_000;
    if (context.includes('ریال') && !containsAny(context, ['تومان', 'تومن'])) amount = Math.round(amount / 10);
    const average = Number(averages[classified.type] || 0);
    const unusual = average > 0 && amount >= average * 5;
    const ambiguous = classified.confidence < 0.7;
    const reviewReasons = [];
    if (servicePeriod && !occurredAt) reviewReasons.push('تاریخ پرداخت مشخص نیست؛ تاریخ پوشش یا دورهٔ خدمت جای تاریخ پرداخت نیست.');
    // آوردهٔ مالک درآمد نیست و دارایی ثابت هزینه نیست.
    //
    // برای این جمله‌ها برگهٔ مخصوص باز می‌شود، ولی اگر کاربر آن را ببندد و
    // همین‌جا ثبت کند، ۲۰۰ میلیون آورده بی‌صدا در درآمد می‌نشیند: سود دوره باد
    // می‌کند و مالیات روی پول خودِ مالک حساب می‌شود. پس این ثبت هرگز بی‌پرسش
    // رد نمی‌شود.
    const capitalWording = mentionsCapitalOrAsset(normalizePersian(context || text));
    if (capitalWording === 'capital') reviewReasons.push('این جمله از آوردهٔ سرمایه می‌گوید؛ آورده درآمد نیست و باید در بخش سرمایه ثبت شود.');
    if (capitalWording === 'fixed-asset') reviewReasons.push('این جمله از دارایی ثابت می‌گوید؛ دارایی ثابت هزینهٔ این ماه نیست.');
    if (natureNeedsAccountant(eventNature)) reviewReasons.push('این جمله اصلاح یک ثبت قبلی است؛ تراکنش تازه ساخته نمی‌شود و برای اصلاح به حسابدار می‌رسد.');
    if (unusual) reviewReasons.push('مبلغ نسبت به میانگین ثبت‌های مشابه غیرعادی است.');
    if (colloquialThousands) reviewReasons.push('مقیاس مبلغ مبهم است؛ مبلغ دقیق را با هزار، میلیون یا میلیارد مشخص کن.');
    if (ambiguous) reviewReasons.push('نوع تراکنش از متن با اطمینان کافی مشخص نیست.');
    if (span.bareScale) reviewReasons.push(`عدد پیش از «${span.raw}» شنیده نشد؛ مبلغ را خودت بنویس.`);
    const transaction = {
      amount, type: classified.type, category: classified.category,
      // مقیاس محاوره‌ای ابهام دارد و حدس‌زدنش خطای هزاربرابری می‌سازد.
      // مقدار همان ×۱۰۰۰ می‌ماند تا مسیر قدیمی نشکند؛ این پرچم می‌گوید موتور
      // تصمیم باید بپرسد.
      ...(colloquialThousands ? { amountScaleAmbiguous: true } : {}),
      // نشانهٔ ماهیت، نه دسته: پول رفته ولی هنوز هیچ چیزی بابتش نگرفته‌ایم.
      ...(prepayment ? { prepaymentSignal: true } : {}),
      ...(unpaid ? { unpaidSignal: true } : {}),
      ...(eventNature !== EVENT_NATURES.NEW ? { eventNature } : {}),
      ...(servicePeriod ? { servicePeriodStart: servicePeriod.start, servicePeriodEnd: servicePeriod.end } : {}), chartCode: classified.chartCode,
      // Amount extraction masks banks and dates. Those masks must never become
      // the user's evidence. Keep scoped context for genuinely separate amounts.
      rawText: spans.length === 1 ? String(input) : rawContext || text,
      ...(counterpartyName ? {
        contactName: counterpartyName, moneyDirection, contactNameConfident: counterparty.confident,
      } : {}),
      // دستهٔ مبهم یعنی دو دسته به یک اندازه موجه بودند؛ ثبت چنین چیزی بدون
      // نگاه کاربر همان خطای بی‌صداست که در بخش مبلغ بستیم.
      confidence: classified.confidence,
      needsReview: unusual || ambiguous || colloquialThousands || span.bareScale || classified.categoryAmbiguous || Boolean(capitalWording) || natureNeedsAccountant(eventNature),
      source,
      ...(occurredAt ? { occurredAt, occurredAtLabel: mentionedDate.label, occurredAtSource: mentionedDate.kind } : {}),
      // شناسهٔ بانک می‌رود، نه شناسهٔ حساب: پارسر دفتر را نمی‌شناسد و نمی‌داند
      // این کاربر کدام حساب را به کدام بانک بسته است. نگاشت کار سرور است.
      ...(bank ? { bankId: bank.bankId, bankName: bank.bankName } : {}),
      // شناسهٔ بانک می‌رود نه شناسهٔ حساب، به همان دلیل بالا: نگاشت کار سرور است.
      // نام دارنده می‌رود نه شناسهٔ حساب، به همان دلیل: پارسر حساب‌های دفتر را نمی‌شناسد.
      ...(petty?.action === 'spend' && classified.type === 'expense' ? { pettyCash: { action: 'spend', holder: petty.holder } } : {}),
      ...(transferPair ? { transfer: { fromId: transferPair.from.id, fromName: transferPair.from.name, toId: transferPair.to.id, toName: transferPair.to.name } } : {}),
      confidenceDetails: {
        amount: {
          score: span.bareScale ? 0.3 : colloquialThousands ? 0.66 : source === 'voice' ? 0.93 : 0.98,
          reason: span.bareScale
            ? `فقط واژهٔ «${span.raw}» شنیده شد و عددِ پیش از آن گم شده است.`
            : colloquialThousands
              ? 'مبلغ با قاعدهٔ گفتار محاوره‌ای به هزار تومان تبدیل شد.'
              : source === 'voice' ? 'مبلغ از نتیجهٔ تشخیص گفتار استخراج شد.' : 'مبلغ مستقیم از متن استخراج شد.',
        },
        type: { score: classified.typeConfidence, reason: classified.typeReason },
        category: { score: classified.categoryConfidence, reason: classified.categoryReason },
        account: bank
          ? { score: 0.97, reason: `حساب از نام «${bank.bankName}» در گفتار مشخص شد.` }
          : { score: 0.82, reason: 'حساب پیش‌فرض دفتر انتخاب می‌شود؛ قبل از ثبت قابل تغییر است.' },
      },
      reviewReasons,
      warning: span.bareScale
        ? `عدد پیش از «${span.raw}» شنیده نشد؛ این مبلغ حدس است، نه برداشت.`
        : unusual
          ? 'این مبلغ بیشتر از پنج برابر میانگین ثبت‌های مشابه توست. مطمئنی؟'
          : colloquialThousands
          ? `«${span.raw} تومان» به‌صورت محاوره‌ای ${new Intl.NumberFormat('fa-IR').format(amount)} تومان برداشت شد؛ مبلغ را بررسی کن.`
          : ambiguous ? 'نوع این تراکنش با اطمینان کم تشخیص داده شد؛ لطفاً بررسی کن.' : null,
      alternatives: colloquialThousands ? [span.amount] : [],
    };
    return withReviewAssessment(transaction);
  });
  if (natureNeedsAccountant(eventNature) && transactions.length > 1) {
    const representative = /مبلغ\s+درست|صحیح|باید/.test(normalizePersian(input)) ? transactions.at(-1) : transactions[0];
    return { transcript: String(input), transactions: [{ ...representative, rawText: normalizePersian(input), needsReview: true,
      reviewReasons: [...representative.reviewReasons, 'این یک درخواست اصلاح است؛ مبلغ نمایش‌داده‌شده پیشنهادی است و سند قبلی باید توسط حسابدار بررسی شود.'] }] };
  }
  return { transcript: String(input), transactions: collapseRepeatedTransactions(transactions) };
}

export function parseRecognitionCandidates(candidates, options = {}) {
  const unique = [];
  for (const candidate of candidates || []) {
    const transcript = normalizePersian(typeof candidate === 'string' ? candidate : candidate?.transcript);
    if (!transcript || unique.some((item) => item.transcript === transcript)) continue;
    unique.push({ transcript, speechConfidence: Number(typeof candidate === 'string' ? 0 : candidate?.confidence) || 0 });
  }
  if (!unique.length) return { transcript: '', transactions: [], engine: 'browser-live' };
  const parsed = unique.map((candidate) => {
    const result = parseFinancialText(candidate.transcript, { ...options, source: 'voice' });
    const averageParserConfidence = result.transactions.length
      ? result.transactions.reduce((sum, item) => sum + item.confidence, 0) / result.transactions.length
      : 0;
    // تعداد بیشتر نباید یک برداشت کم‌اعتماد را برنده کند؛ این کار اعداد فرعی را به تراکنش جعلی تبدیل می‌کرد.
    const score = (result.transactions.length ? 250 : 0)
      + averageParserConfidence * 100
      + candidate.speechConfidence * 120;
    return { ...candidate, result, score };
  }).sort((left, right) => right.score - left.score);
  const best = parsed[0];
  if (!best.result.transactions.length) return { ...best.result, engine: 'browser-live', speechConfidence: best.speechConfidence };
  const candidateCountDisagreement = parsed.slice(1).some((candidate) => (
    candidate.result.transactions.length > 0
    && candidate.result.transactions.length !== best.result.transactions.length
  ));
  const transactions = best.result.transactions.map((item, index) => {
    const alternatives = [...new Set(parsed.slice(1)
      .filter((candidate) => candidate.result.transactions.length === best.result.transactions.length)
      .map((candidate) => candidate.result.transactions[index]?.amount)
      .filter((amount) => Number.isFinite(amount) && amount > 0 && amount !== item.amount))].slice(0, 2);
    const typeDisagreement = parsed.slice(1).some((candidate) => {
      if (candidate.result.transactions.length !== best.result.transactions.length) return false;
      const alternative = candidate.result.transactions[index];
      return alternative && (alternative.type !== item.type || alternative.category !== item.category);
    });
    if (!alternatives.length && !candidateCountDisagreement && !typeDisagreement) return { ...item, speechConfidence: best.speechConfidence };
    const warning = alternatives.length
      ? 'چند مبلغ متفاوت شنیده شد؛ مبلغ را با دقت بررسی کن.'
      : candidateCountDisagreement
        ? 'تعداد ثبت‌ها در برداشت‌های صدا یکسان نبود؛ همهٔ موارد را بررسی کن.'
        : 'نوع یا دستهٔ تراکنش در برداشت‌های صدا یکسان نبود؛ لطفاً بررسی کن.';
    const fieldChanges = {};
    if (alternatives.length || candidateCountDisagreement) fieldChanges.amount = {
      ...item.confidenceDetails?.amount,
      score: Math.min(item.confidenceDetails?.amount?.score ?? 0.93, 0.56),
      reason: alternatives.length ? 'موتور گفتار چند مبلغ متفاوت پیشنهاد کرد.' : 'برداشت‌های گفتار دربارهٔ تعداد مبلغ‌ها یکسان نبودند.',
    };
    if (typeDisagreement) {
      fieldChanges.type = { ...item.confidenceDetails?.type, score: 0.56, reason: 'برداشت‌های گفتار دربارهٔ نوع تراکنش یکسان نبودند.' };
      fieldChanges.category = { ...item.confidenceDetails?.category, score: 0.56, reason: 'برداشت‌های گفتار دربارهٔ دسته یکسان نبودند.' };
    }
    return withReviewAssessment({
      ...item,
      speechConfidence: best.speechConfidence,
      alternatives,
      needsReview: true,
      confidence: undefined,
      confidenceDetails: { ...item.confidenceDetails, ...fieldChanges },
      reviewReasons: [...(item.reviewReasons || []), warning],
      reviewCode: alternatives.length ? 'candidate-amount-disagreement' : candidateCountDisagreement ? 'candidate-count-disagreement' : 'candidate-type-disagreement',
      warning: item.warning ? `${item.warning} ${warning}` : warning,
    });
  });
  return {
    ...best.result,
    transactions,
    engine: 'browser-live',
    speechConfidence: best.speechConfidence,
    candidateDisagreement: transactions.some((item) => item.reviewCode?.startsWith('candidate-')),
  };
}
