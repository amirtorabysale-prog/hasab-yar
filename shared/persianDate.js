import { normalizePersian } from './normalize.js';

/**
 * فهم تاریخ گفتاری فارسی.
 *
 * تا امروز فقط «دیروز»، «پریروز» و «هفتهٔ پیش» شناخته می‌شدند. هر تاریخ دیگری —
 * «سه روز پیش»، «دوم شهریور»، «۱۴۰۵/۰۶/۰۲» — بی‌صدا روی **امروز** می‌نشست.
 * برای یک دفتر حسابداری این بدترین نوع خطاست: سند در دورهٔ مالی اشتباه می‌رود،
 * بستن ماه غلط درمی‌آید و کسی هم متوجه نمی‌شود.
 */

export const PERSIAN_MONTHS = Object.freeze([
  ['فروردین', 1], ['اردیبهشت', 2], ['ارديبهشت', 2], ['خرداد', 3], ['تیر', 4], ['تير', 4],
  ['مرداد', 5], ['امرداد', 5], ['شهریور', 6], ['شهريور', 6], ['مهر', 7], ['آبان', 8], ['ابان', 8],
  ['آذر', 9], ['اذر', 9], ['دی', 10], ['بهمن', 11], ['اسفند', 12],
]);

const CARDINALS = [
  '', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه', 'ده',
  'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده', 'بیست',
];

/** «سه» ordinal بی‌قاعده است («سوم»)، بقیه فقط «م» می‌گیرند. */
function ordinalForms(day) {
  if (day <= 20) {
    const base = CARDINALS[day];
    const forms = [day === 3 ? 'سوم' : `${base}م`];
    if (day === 1) forms.push('اول', 'اوّل');
    if (day === 6) forms.push('شیشم');
    if (day === 15) forms.push('پونزدهم');
    return forms;
  }
  if (day === 30) return ['سی ام', 'سیام', 'سی'];
  const tens = day < 30 ? 'بیست' : 'سی';
  const unit = day % 10;
  const unitForm = unit === 3 ? 'سوم' : `${CARDINALS[unit]}م`;
  return [`${tens} و ${unitForm}`, `${tens}و${unitForm}`];
}

const DAY_WORDS = (() => {
  const map = new Map();
  for (let day = 1; day <= 31; day += 1) for (const form of ordinalForms(day)) map.set(normalizePersian(form), day);
  return map;
})();

const DAY_WORD_PATTERN = [...DAY_WORDS.keys()].sort((left, right) => right.length - left.length).join('|');
const MONTH_PATTERN = PERSIAN_MONTHS.map(([name]) => name).sort((left, right) => right.length - left.length).join('|');
const MONTH_BY_NAME = new Map(PERSIAN_MONTHS.map(([name, index]) => [normalizePersian(name), index]));

const MONTH_LENGTHS = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];

function dayOfPersianYear(month, day) {
  let total = day;
  for (let index = 0; index < month - 1; index += 1) total += MONTH_LENGTHS[index];
  return total;
}

function persianParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type) => Number(parts.find((item) => item.type === type)?.value || 0);
  return { year: part('year'), month: part('month'), day: part('day') };
}

export function todayPersian(now = new Date(), timeZone = 'Asia/Tehran') {
  return persianParts(now instanceof Date ? now : new Date(now), timeZone);
}

/**
 * تبدیل تاریخ شمسی به لحظهٔ ISO.
 *
 * قاعدهٔ کبیسه از حفظ نوشته نمی‌شود؛ از تقویم خود پلتفرم پرسیده و تا رسیدن به
 * تاریخ خواسته‌شده تصحیح می‌شود. ساعت روی ظهر تهران گذاشته می‌شود تا تبدیل
 * منطقهٔ زمانی، سند را به روز قبل یا بعد پرت نکند.
 */
export function persianToISO(year, month, day, timeZone = 'Asia/Tehran') {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  // تخمین اولیه: نوروز همان سال، به‌علاوهٔ روزِ سال.
  const matches = (time) => {
    const actual = persianParts(new Date(time), timeZone);
    return actual.year === Number(year) && actual.month === month && actual.day === day;
  };
  let guess = Date.UTC(Number(year) + 621, 2, 21, 8, 30) + (dayOfPersianYear(month, day) - 1) * 86_400_000;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (matches(guess)) return new Date(guess).toISOString();
    const actual = persianParts(new Date(guess), timeZone);
    // طول سال شمسی ۳۶۵ یا ۳۶۶ روز است. ضریب ثابت ۳۶۵ روی سال کبیسه واگرا
    // می‌شد و تخمین دقیقاً یک سال کنار می‌ماند؛ ۳۰ اسفند ۱۴۰۳ اصلاً ساخته
    // نمی‌شد. طول متوسط سال، تخمین را همیشه به فاصلهٔ چندروزه می‌رساند.
    const shift = Math.round((Number(year) - actual.year) * 365.2422)
      + (dayOfPersianYear(month, day) - dayOfPersianYear(actual.month, actual.day));
    if (!shift) break;
    guess += shift * 86_400_000;
  }
  // آخرین چند روز باقی‌مانده با جست‌وجوی کوتاه بسته می‌شود، تا هیچ حالت مرزی
  // به‌خاطر تخمین از دست نرود.
  for (let offset = -3; offset <= 3; offset += 1) {
    const time = guess + offset * 86_400_000;
    if (matches(time)) return new Date(time).toISOString();
  }
  return null;
}

function isoAtTehranNoon(now, offsetDays, timeZone) {
  const shifted = new Date(now.getTime() + offsetDays * 86_400_000);
  const { year, month, day } = persianParts(shifted, timeZone);
  return persianToISO(year, month, day, timeZone);
}

const PERSIAN_DIGITS = /^\d{1,4}$/;

const RELATIVE_WORDS = [
  [/(?:^|\s)امروز(?:\s|$)/, 0, 'امروز'],
  [/(?:^|\s)دیروز(?:\s|$)/, -1, 'دیروز'],
  [/(?:^|\s)(?:پریروز|پس\s*پریروز)(?:\s|$)/, -2, 'پریروز'],
  [/(?:^|\s)فردا(?:\s|$)/, 1, 'فردا'],
  [/(?:^|\s)پس\s*فردا(?:\s|$)/, 2, 'پس‌فردا'],
];

const COUNTED_UNITS = [
  [/(\d+)\s*روز\s*(?:پیش|قبل|گذشته)/, 1, 'روز'],
  [/(\d+)\s*هفته\s*(?:ی|ٔ)?\s*(?:پیش|قبل|گذشته)/, 7, 'هفته'],
  [/(\d+)\s*ماه\s*(?:پیش|قبل|گذشته)/, 30, 'ماه'],
];

/** عددهای گفتاری کوچک که پیش از «روز پیش» می‌آیند. */
const SMALL_NUMBERS = new Map(CARDINALS.map((word, value) => [word, value]).filter(([word]) => word));

function replaceSpokenCounts(text) {
  let output = text;
  for (const [word, value] of SMALL_NUMBERS) {
    output = output.replace(new RegExp(`(?<![آ-ی])${word}(?=\\s*(?:روز|هفته|ماه)\\s*(?:پیش|قبل|گذشته))`, 'g'), String(value));
  }
  return output;
}

/**
 * تاریخ گفته‌شده را از متن بیرون می‌کشد.
 *
 * `preferPast` برای ثبت مالی روشن است: کسی رویداد مالی آینده را ثبت نمی‌کند،
 * پس «۲۵ اسفند» در شهریور یعنی اسفندِ سال گذشته، نه شش ماه بعد. برای سررسید
 * چک خاموش می‌شود، چون آنجا آینده طبیعی است.
 */
export function extractDateMention(input, { now = new Date(), timeZone = 'Asia/Tehran', preferPast = true } = {}) {
  const text = replaceSpokenCounts(normalizePersian(input));
  if (!text) return null;

  // ۱) تاریخ کامل عددی: ۱۴۰۵/۰۶/۰۲ یا ۱۴۰۵-۶-۲
  const numeric = text.match(/(?<![\d/])(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?![\d/])/);
  if (numeric) {
    const iso = persianToISO(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]), timeZone);
    if (iso) return { iso, label: `${numeric[1]}/${String(numeric[2]).padStart(2, '0')}/${String(numeric[3]).padStart(2, '0')}`, kind: 'explicit' };
  }

  // ۲) روز و ماه: «دوم شهریور»، «۲ شهریور ۱۴۰۴»، «شهریور دوم» شمرده نمی‌شود.
  const dayMonth = text.match(new RegExp(`(?<![آ-ی])(${DAY_WORD_PATTERN}|\\d{1,2})\\s*(?:ام|م)?\\s*(?:ماه\\s*)?(${MONTH_PATTERN})(?:\\s*(?:ماه)?\\s*(\\d{4}|\\d{2}))?`));
  if (dayMonth) {
    const token = dayMonth[1];
    const day = PERSIAN_DIGITS.test(token) ? Number(token) : DAY_WORDS.get(token);
    const month = MONTH_BY_NAME.get(dayMonth[2]);
    if (day >= 1 && day <= 31 && month) {
      const today = persianParts(now, timeZone);
      let year = today.year;
      if (dayMonth[3]) year = dayMonth[3].length === 4 ? Number(dayMonth[3]) : 1400 + Number(dayMonth[3]);
      else if (preferPast && (month > today.month || (month === today.month && day > today.day))) year -= 1;
      const iso = persianToISO(year, month, day, timeZone);
      if (iso) return { iso, label: `${day} ${dayMonth[2]} ${year}`, kind: dayMonth[3] ? 'explicit' : 'inferred-year' };
    }
  }

  // ۳) شمارشی: «سه روز پیش»، «۲ هفته قبل»
  for (const [pattern, multiplier, unit] of COUNTED_UNITS) {
    const match = text.match(pattern);
    if (!match) continue;
    const count = Number(match[1]);
    if (!Number.isFinite(count) || count <= 0 || count > 400) continue;
    const iso = isoAtTehranNoon(now, -count * multiplier, timeZone);
    if (iso) return { iso, label: `${count} ${unit} پیش`, kind: 'relative' };
  }

  // ۴) واژه‌های تک: هفتهٔ پیش، ماه پیش
  if (/هفته\s*(?:ی|ٔ)?\s*(?:پیش|قبل|گذشته)/.test(text)) {
    const iso = isoAtTehranNoon(now, -7, timeZone);
    if (iso) return { iso, label: 'هفتهٔ پیش', kind: 'relative' };
  }
  if (/ماه\s*(?:پیش|قبل|گذشته)/.test(text)) {
    const iso = isoAtTehranNoon(now, -30, timeZone);
    if (iso) return { iso, label: 'ماه پیش', kind: 'relative' };
  }

  // ۵) امروز/دیروز/فردا
  for (const [pattern, offset, label] of RELATIVE_WORDS) {
    if (!pattern.test(` ${text} `)) continue;
    const iso = isoAtTehranNoon(now, offset, timeZone);
    if (iso) return { iso, label, kind: 'relative' };
  }
  return null;
}
