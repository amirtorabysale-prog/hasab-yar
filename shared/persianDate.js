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

// ساخت Intl.DateTimeFormat گران است و این تابع در حلقهٔ تبدیل تاریخ ده‌ها بار
// صدا زده می‌شود. پارسر هم روی هر کلیدِ تایپ زنده اجرا می‌شود، پس ساخت دوبارهٔ
// formatter بودجهٔ پیش‌نمایش زنده را می‌سوزاند: ۲۰۰۰ پارس از زیر یک ثانیه به
// بیش از یک ثانیه رفته بود.
const persianFormatters = new Map();

function persianFormatter(timeZone) {
  let formatter = persianFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-persian', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    persianFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function persianParts(date, timeZone) {
  const parts = persianFormatter(timeZone).formatToParts(date);
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

/**
 * نیمه‌شب یک روز میلادی در یک منطقهٔ زمانی.
 * جست‌وجوی کوتاه به‌جای محاسبهٔ افست، تا تغییر ساعت تابستانی هم درست بیفتد.
 */
function zonedMidnight(gregorianDay, timeZone) {
  const [year, month, day] = gregorianDay.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess))
      .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess -= represented - target;
  }
  return new Date(guess);
}

/**
 * بازهٔ یک ماه شمسی، از نیمه‌شب اول ماه تا نیمه‌شب اول ماه بعد.
 *
 * دورهٔ سهمیه و هر چیز دیگری که به کاربر «این ماه» گفته می‌شود باید با همان
 * تقویمی بسته شود که کاربر با آن کار می‌کند. مرز ماه میلادی وسط ماه شمسی
 * می‌افتد و «این ماه» را به دو تکه می‌برد.
 */
export function persianMonthRange(year, month, timeZone = 'Asia/Tehran') {
  const startNoon = persianToISO(year, month, 1, timeZone);
  if (!startNoon) return null;
  const nextYear = month === 12 ? Number(year) + 1 : Number(year);
  const nextMonth = month === 12 ? 1 : month + 1;
  const endNoon = persianToISO(nextYear, nextMonth, 1, timeZone);
  if (!endNoon) return null;
  const gregorianDay = (iso) => new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
  const from = zonedMidnight(gregorianDay(startNoon), timeZone);
  const toExclusive = zonedMidnight(gregorianDay(endNoon), timeZone);
  return {
    month: `${year}-${String(month).padStart(2, '0')}`,
    from: from.toISOString(),
    toExclusive: toExclusive.toISOString(),
    to: new Date(toExclusive.getTime() - 1).toISOString(),
  };
}

/**
 * چند ماه شمسی جلو یا عقب، روی همان روزِ ماه.
 *
 * «یک ماه دیگه» را نباید ۳۰ روز حساب کرد: ماه‌های شمسی ۲۹ تا ۳۱ روزند، پس
 * نتیجه با «ماه بعد» — که تقویمی حساب می‌شد — یکی درنمی‌آمد. برای سررسید چک
 * همین یک روز اختلاف یعنی سند در ماه اشتباه می‌نشیند.
 *
 * روزی که در ماه مقصد وجود ندارد (مثل ۳۱ در نیمهٔ دوم سال) روی آخرین روز
 * همان ماه می‌نشیند، نه اینکه به ماه بعدی سر برود.
 */
function isoAtPersianMonthOffset(now, offsetMonths, timeZone) {
  const today = persianParts(now, timeZone);
  const total = (today.year * 12) + (today.month - 1) + offsetMonths;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  let day = today.day;
  let iso = persianToISO(year, month, day, timeZone);
  while (!iso && day > 28) { day -= 1; iso = persianToISO(year, month, day, timeZone); }
  return iso;
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
  [/(\d+)\s*ماه\s*(?:پیش|قبل|گذشته)/, 'month', 'ماه'],
];

// سررسید تقریباً همیشه آینده است و کاربر آن را نسبی می‌گوید: «سه روز دیگه»،
// «هفتهٔ بعد»، «آخر ماه». بدون اینها تاریخ سررسید عملاً هیچ‌وقت فهمیده نمی‌شد.
const FUTURE_UNITS = [
  [/(\d+)\s*روز\s*(?:دیگه|دیگر|بعد|آینده|بعدی)/, 1, 'روز'],
  [/(\d+)\s*هفته\s*(?:ی|ٔ)?\s*(?:دیگه|دیگر|بعد|آینده|بعدی)/, 7, 'هفته'],
  [/(\d+)\s*ماه\s*(?:دیگه|دیگر|بعد|آینده|بعدی)/, 'month', 'ماه'],
];

const FUTURE_WORDS = [
  [/هفته\s*(?:ی|ٔ)?\s*(?:دیگه|دیگر|بعد|آینده|بعدی)/, 7, 'هفتهٔ بعد'],
  [/(?:دو\s*هفته|۲\s*هفته)\s*(?:ی|ٔ)?\s*(?:دیگه|دیگر|بعد)/, 14, 'دو هفتهٔ بعد'],
];

/** عددهای گفتاری کوچک که پیش از «روز پیش» می‌آیند. */
const SMALL_NUMBERS = new Map(CARDINALS.map((word, value) => [word, value]).filter(([word]) => word));

// این تابع روی هر پارس اجرا می‌شود. ساخت یک RegExp تازه به ازای هر واژهٔ
// عددی یعنی حدود ۴۵ شیء در هر فراخوانی — گران‌ترین بخش مسیر تاریخ.
const SPOKEN_COUNT_PATTERNS = [...SMALL_NUMBERS].map(([word, value]) => [
  new RegExp(`(?<![آ-ی])${word}(?=\\s*(?:روز|هفته|ماه)\\s*(?:ی|ٔ)?\\s*(?:پیش|قبل|گذشته|دیگه|دیگر|بعد|آینده|بعدی))`, 'g'),
  String(value),
]);

function replaceSpokenCounts(text) {
  let output = text;
  for (const [pattern, value] of SPOKEN_COUNT_PATTERNS) output = output.replace(pattern, value);
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

  // Explicit day of next month must precede the generic same-day fallback.
  const nextDay = text.match(new RegExp(`(?:^|\\s)(${DAY_WORD_PATTERN})\\s+ماه\\s*(?:بعدی|بعد|آینده|دیگه|دیگر)`));
  if (nextDay) {
    const today = persianParts(now, timeZone);
    const day = DAY_WORDS.get(nextDay[1]) || Number(nextDay[1]);
    const iso = persianToISO(today.month === 12 ? today.year + 1 : today.year, today.month === 12 ? 1 : today.month + 1, day, timeZone);
    return iso ? { iso, label: nextDay[0].trim(), match: nextDay[0].trim(), kind: 'relative' } : null;
  }

  // ۱) تاریخ کامل عددی.
  //
  // موتور گفتار تاریخِ گفته‌شده را با **فاصله** می‌نویسد، نه با اسلش: «پانزده
  // پنج هزار و چهارصد و پنج» به «15 5 1405» تبدیل می‌شود. تا وقتی فقط اسلش و
  // خط تیره پذیرفته می‌شد، این تاریخ اصلاً دیده نمی‌شد و — بدتر — رقم‌هایش به
  // مبلغ می‌چسبید.
  //
  // ترتیب هم ثابت نیست: «۱۴۰۵/۰۶/۰۲» سال‌اول است و «۱۵ ۵ ۱۴۰۵» روزاول. کدام
  // بخش سال است از چهاررقمی‌بودنش فهمیده می‌شود، نه از جای آن.
  const numeric = text.match(/(?<![\d/\-.])(\d{1,4})\s*[/\-.\s]\s*(\d{1,2})\s*[/\-.\s]\s*(\d{1,4})(?![\d/\-.])/);
  if (numeric) {
    const [matched, first, middle, last] = numeric;
    const yearFirst = first.length === 4;
    const yearLast = last.length === 4;
    // بدون یک بخش چهاررقمی، این عدد تاریخ نیست؛ «۱۲ ۵ ۳» می‌تواند هر چیزی باشد.
    if (yearFirst || yearLast) {
      const year = Number(yearFirst ? first : last);
      const month = Number(middle);
      const day = Number(yearFirst ? last : first);
      const iso = persianToISO(year, month, day, timeZone);
      if (iso) {
        return {
          iso,
          label: `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`,
          kind: 'explicit',
          match: matched,
        };
      }
    }
  }

  // ۲) روز و ماه: «دوم شهریور»، «۲ شهریور ۱۴۰۴»، «شهریور دوم» شمرده نمی‌شود.
  // نام ماه باید مرز راست داشته باشد، وگرنه «دیگه» با «دی» تطبیق می‌خورد و
  // «یک ماه دیگه» به اول دی ماه تبدیل می‌شود. «شهریورماه» همچنان باید بخورد،
  // پس «ماه» چسبیده پیش از مرز پذیرفته می‌شود.
  const dayMonth = text.match(new RegExp(`(?<![آ-ی])(${DAY_WORD_PATTERN}|\\d{1,2})\\s*(?:ام|م)?\\s*(?:ماه\\s*)?(${MONTH_PATTERN})(?:\\s*ماه)?(?![آ-ی])(?:\\s*(\\d{4}|\\d{2}))?`));
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
    const iso = multiplier === 'month'
      ? isoAtPersianMonthOffset(now, -count, timeZone)
      : isoAtTehranNoon(now, -count * multiplier, timeZone);
    if (iso) return { iso, label: `${count} ${unit} پیش`, kind: 'relative' };
  }

  // ۴) واژه‌های تک: هفتهٔ پیش، ماه پیش
  if (/هفته\s*(?:ی|ٔ)?\s*(?:پیش|قبل|گذشته)/.test(text)) {
    const iso = isoAtTehranNoon(now, -7, timeZone);
    if (iso) return { iso, label: 'هفتهٔ پیش', kind: 'relative' };
  }
  if (/ماه\s*(?:پیش|قبل|گذشته)/.test(text)) {
    // «ماه پیش» هم تقویمی است، وگرنه با «یک ماه پیش» یک روز اختلاف داشت.
    const iso = isoAtPersianMonthOffset(now, -1, timeZone);
    if (iso) return { iso, label: 'ماه پیش', kind: 'relative' };
  }

  // ۵) شمارشی رو به آینده: «سه روز دیگه»، «۲ هفتهٔ بعد»
  for (const [pattern, multiplier, unit] of FUTURE_UNITS) {
    const match = text.match(pattern);
    if (!match) continue;
    const count = Number(match[1]);
    if (!Number.isFinite(count) || count <= 0 || count > 400) continue;
    const iso = multiplier === 'month'
      ? isoAtPersianMonthOffset(now, count, timeZone)
      : isoAtTehranNoon(now, count * multiplier, timeZone);
    if (iso) return { iso, label: `${count} ${unit} دیگر`, kind: 'relative' };
  }

  // ۶) آخر و اول ماه شمسی: طول ماه از تقویم پرسیده می‌شود، نه از قاعدهٔ حفظی.
  if (/(?:آخر|اخر|پایان)\s*(?:این\s*)?ماه/.test(text)) {
    const today = persianParts(now, timeZone);
    const range = persianMonthRange(today.year, today.month, timeZone);
    if (range) {
      const lastDay = persianParts(new Date(new Date(range.toExclusive).getTime() - 86_400_000), timeZone);
      const iso = persianToISO(lastDay.year, lastDay.month, lastDay.day, timeZone);
      if (iso) return { iso, label: 'آخر ماه', kind: 'relative' };
    }
  }
  if (/(?:اول|ابتدای|شروع)\s*ماه\s*(?:دیگه|دیگر|بعد|آینده|بعدی)/.test(text)
    || /ماه\s*(?:دیگه|دیگر|بعد|آینده|بعدی)/.test(text)) {
    const today = persianParts(now, timeZone);
    const nextYear = today.month === 12 ? today.year + 1 : today.year;
    const nextMonth = today.month === 12 ? 1 : today.month + 1;
    // «ماه بعد» بدون روز یعنی همان روزِ ماه بعد؛ اگر آن روز در ماه بعد نباشد
    // (مثل ۳۱ در ماه‌های دوم سال) روی آخرین روز همان ماه می‌نشیند.
    const explicitFirst = /(?:اول|ابتدای|شروع)\s*ماه/.test(text);
    let day = explicitFirst ? 1 : today.day;
    let iso = persianToISO(nextYear, nextMonth, day, timeZone);
    while (!iso && day > 28) { day -= 1; iso = persianToISO(nextYear, nextMonth, day, timeZone); }
    if (iso) return { iso, label: explicitFirst ? 'اول ماه بعد' : 'ماه بعد', kind: 'relative' };
  }

  // ۷) واژه‌های تک رو به آینده: هفتهٔ بعد
  for (const [pattern, offset, label] of FUTURE_WORDS) {
    if (!pattern.test(text)) continue;
    const iso = isoAtTehranNoon(now, offset, timeZone);
    if (iso) return { iso, label, kind: 'relative' };
  }

  // ۸) امروز/دیروز/فردا
  for (const [pattern, offset, label] of RELATIVE_WORDS) {
    if (!pattern.test(` ${text} `)) continue;
    const iso = isoAtTehranNoon(now, offset, timeZone);
    if (iso) return { iso, label, kind: 'relative' };
  }
  return null;
}


/** Dates belonging to coverage, an old invoice, or future cheque cashing are
 * not occurrence dates. Keep raw text intact for evidence and service parsing. */
export function extractOccurrenceDate(input, options = {}) {
  let text = normalizePersian(input);
  const months = PERSIAN_MONTHS.map(([name]) => name).join('|');
  if (/بیمه|اجاره|پوشش|شارژ|اشتراک/.test(text)) {
    text = text.replace(new RegExp(`از\\s+(?:${DAY_WORD_PATTERN}|\\d{1,2})\\s+(?:${months})\\s+تا\\s+(?:آخر|پایان|${DAY_WORD_PATTERN}|\\d{1,2})\\s+(?:${months})(?:\\s+همین\\s+امسال)?`, 'g'), ' ');
    text = text.replace(/(?:شروع|آغاز)\s*(?:پوشش|بیمه|قرارداد)\s*[^،,؛.]+/g, ' ');
  }
  text = text.replace(/(?:خرید|فروش|فاکتور|بدهی|اجاره)\s*(?:ماه\s*(?:قبل|پیش|گذشته)|سال\s*(?:قبل|گذشته))/g, ' ');
  text = text.replace(/(?:موعد\s*پرداخت(?:ش)?|سررسید(?:ش)?)\s*[^،,.؛]*/g, ' ');
  text = text.replace(/(?:فردا|پس\s*فردا|هفته\s*بعد)\s*(?:نقدش|نقد|وصولش|وصول|پاسش|پاس)\s*(?:می\s*)?(?:کنه|کند|کنند|کنن|شه|شود)/g, ' ');
  return extractDateMention(text, { ...options, preferPast: true });
}
