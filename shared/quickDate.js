// منطق انتخاب‌گر سریع تاریخ شمسی (src/components/QuickDateInput.jsx).
//
// تایپ «۱۴۰۵/۰۲/۲۵» برای هر تاریخ کند و پرخطاست. اینجا هر تاریخ با کمترین
// حرکت به دست می‌آید:
//  - «۲۵»            ← روز ۲۵ نزدیک‌ترین ماه، در جهت فیلد (گذشته برای تاریخ سند،
//                      آینده برای سررسید).
//  - «۲۵ ۲» یا «۲۵ اردیبهشت» ← روز و ماه، به ترتیب گفتن.
//  - «۲/۲۵»           ← ماه/روز، به ترتیب نوشتن تاریخ شمسی.
//  - «۰۳/۲/۲۵» یا «۱۴۰۳/۲/۲۵» ← کامل.
//  - «دیروز»، «پس فردا»، «۳ روز پیش»، «۲ هفته بعد»، «-۳» و «+۱۰» ← نسبت به امروز.
// هر چیزی که خوانده نشود null است، نه حدس.

import { normalizePersian } from './normalize.js';
import { PERSIAN_MONTHS, extractDateMention, persianToISO, todayPersian } from './persianDate.js';

const DAY = 86_400_000;
export const MONTH_NAMES = Object.freeze(['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند']);
/** ستون‌های هفته از شنبه. */
export const WEEKDAY_INITIALS = Object.freeze(['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج']);

const toLatin = (text) => String(text ?? '')
  .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
  .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));

export function monthLength(year, month) {
  if (month <= 6) return 31;
  if (month <= 11) return 30;
  return persianToISO(year, 12, 30) ? 30 : 29;
}

/** شمسیِ یک لحظه در تهران. */
export function jalaliOf(iso, timeZone = 'Asia/Tehran') {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : todayPersian(date, timeZone);
}

const key = (parts) => parts.year * 10_000 + parts.month * 100 + parts.day;
export const sameDay = (left, right) => Boolean(left && right) && key(left) === key(right);
export const compareDays = (left, right) => key(left) - key(right);

/** ظهرِ تهرانِ یک روز شمسی؛ روز بیش از طول ماه روی روز آخر می‌نشیند. */
export function jalaliToISO({ year, month, day }, timeZone = 'Asia/Tehran') {
  if (!(month >= 1 && month <= 12) || !(day >= 1)) return null;
  return persianToISO(year, month, Math.min(day, monthLength(year, month)), timeZone);
}

export function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * DAY).toISOString();
}

export function addMonths(parts, months) {
  const total = parts.year * 12 + parts.month - 1 + months;
  const year = Math.floor(total / 12);
  const month = total % 12 + 1;
  return { year, month, day: Math.min(parts.day, monthLength(year, month)) };
}

/** شش هفتهٔ تقویم یک ماه، از شنبه؛ روزهای ماه‌های کناری `outside` دارند. */
export function monthGrid(year, month, timeZone = 'Asia/Tehran') {
  const first = persianToISO(year, month, 1, timeZone);
  // getUTCDay ظهرِ تهران همان روز هفتهٔ تهران است؛ شنبه = ۶.
  const lead = (new Date(first).getUTCDay() + 1) % 7;
  const start = addDays(first, -lead);
  const length = monthLength(year, month);
  const weeks = Math.ceil((lead + length) / 7);
  return Array.from({ length: weeks * 7 }, (_, index) => {
    const iso = addDays(start, index);
    const parts = todayPersian(new Date(iso), timeZone);
    return { iso, ...parts, outside: parts.month !== month };
  });
}

function relativeOffset(text) {
  const signed = /^([+\-−])\s*(\d{1,3})$/.exec(text);
  if (signed) return (signed[1] === '+' ? 1 : -1) * Number(signed[2]);
  if (/^پس[\s‌]*فردا$/.test(text)) return 2;
  if (/^پس[\s‌]*پریروز$/.test(text)) return -3;
  return null;
}

/** روز و ماهِ بی‌سال در جهت فیلد: نزدیک‌ترین تاریخ گذشته یا آینده. */
function nearest(day, month, today, direction) {
  // «۳۱» در آبان یعنی ۳۱ شهریور: ماه‌های سی‌روزه رد می‌شوند، پس دو ماه به هر طرف.
  const candidates = month
    ? [-1, 0, 1].map((shift) => ({ year: today.year + shift, month, day }))
    : [-2, -1, 0, 1, 2].map((shift) => ({ ...addMonths({ ...today, day: 1 }, shift), day }));
  const fits = (parts) => parts.day <= monthLength(parts.year, parts.month);
  const valid = candidates.filter(fits);
  const distance = (parts) => compareDays(parts, today);
  if (direction === 'past') return valid.filter((parts) => distance(parts) <= 0).at(-1) || null;
  if (direction === 'future') return valid.find((parts) => distance(parts) >= 0) || null;
  // هر دو جهت: همان ماه یا سالِ جاری؛ روزی که در آن نیست، خوانده نمی‌شود.
  const current = candidates[(candidates.length - 1) / 2];
  return fits(current) ? current : null;
}

function fullYear(value) {
  if (value >= 1300 && value <= 1500) return value;
  if (value >= 0 && value < 100) return 1400 + value - (value > 50 ? 100 : 0);
  return null;
}

/**
 * متن ورودی ← { iso, year, month, day } یا null.
 * `direction`: 'past' (تاریخ وقوع)، 'future' (سررسید) یا 'any'.
 */
export function parseQuickDate(input, { now = new Date(), direction = 'any', timeZone = 'Asia/Tehran' } = {}) {
  const text = normalizePersian(toLatin(input)).trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const today = todayPersian(now, timeZone);
  const todayIso = jalaliToISO(today, timeZone);
  const done = (parts) => {
    if (!parts || !(parts.month >= 1 && parts.month <= 12) || !(parts.day >= 1 && parts.day <= monthLength(parts.year, parts.month))) return null;
    const iso = jalaliToISO(parts, timeZone);
    return iso ? { iso, year: parts.year, month: parts.month, day: parts.day } : null;
  };

  const offset = relativeOffset(text);
  if (offset != null) return done(todayPersian(new Date(addDays(todayIso, offset)), timeZone));

  const numbers = /^(\d{1,4})(?:\s*([/\-.\s])\s*(\d{1,2}))?(?:\s*[/\-.\s]\s*(\d{1,2}))?$/.exec(text);
  if (numbers) {
    const [, a, separator, b, c] = numbers;
    if (c) return done({ year: fullYear(Number(a)), month: Number(b), day: Number(c) });
    if (b) {
      // فاصله ترتیب گفتن است (روز ماه)؛ ممیز ترتیب نوشتن (ماه/روز).
      const [day, month] = separator.trim() ? [Number(b), Number(a)] : [Number(a), Number(b)];
      return done(nearest(day, month, today, direction));
    }
    if (a.length <= 2) return done(nearest(Number(a), null, today, direction));
    return null;
  }

  const monthName = PERSIAN_MONTHS.find(([name]) => text === normalizePersian(name));
  if (monthName) return done(nearest(1, monthName[1], today, direction));
  const spoken = extractDateMention(text, { now, timeZone, preferPast: direction !== 'future' });
  return spoken?.iso ? done(todayPersian(new Date(spoken.iso), timeZone)) : null;
}

/** «امروز»، «دیروز»، «۳ روز پیش» — فقط تا یک ماه؛ بعدش تاریخ خودش گویاست. */
export function relativeLabel(iso, now = new Date(), timeZone = 'Asia/Tehran') {
  const target = jalaliToISO(jalaliOf(iso, timeZone), timeZone);
  const base = jalaliToISO(todayPersian(now, timeZone), timeZone);
  if (!target || !base) return '';
  const days = Math.round((new Date(target) - new Date(base)) / DAY);
  if (days === 0) return 'امروز';
  if (days === -1) return 'دیروز';
  if (days === 1) return 'فردا';
  if (days === -2) return 'پریروز';
  if (days === 2) return 'پس‌فردا';
  if (Math.abs(days) <= 31) return `${Math.abs(days)} روز ${days < 0 ? 'پیش' : 'بعد'}`;
  return '';
}

/** میان‌برهای همان فیلد، به جهت آن. */
export function quickPresets(direction = 'any', now = new Date(), timeZone = 'Asia/Tehran') {
  const today = todayPersian(now, timeZone);
  const todayIso = jalaliToISO(today, timeZone);
  const startOfMonth = jalaliToISO({ ...today, day: 1 }, timeZone);
  const endOfMonth = jalaliToISO({ ...today, day: monthLength(today.year, today.month) }, timeZone);
  const lastMonthEnd = addDays(startOfMonth, -1);
  const past = [
    { label: 'امروز', iso: todayIso },
    { label: 'دیروز', iso: addDays(todayIso, -1) },
    { label: 'پریروز', iso: addDays(todayIso, -2) },
    { label: 'اول ماه', iso: startOfMonth },
    { label: 'آخر ماه قبل', iso: lastMonthEnd },
  ];
  const future = [
    { label: 'امروز', iso: todayIso },
    { label: 'فردا', iso: addDays(todayIso, 1) },
    { label: 'یک هفته بعد', iso: addDays(todayIso, 7) },
    { label: 'آخر ماه', iso: endOfMonth },
    { label: 'ماه بعد', iso: jalaliToISO(addMonths(today, 1), timeZone) },
  ];
  if (direction === 'past') return past;
  if (direction === 'future') return future;
  return [past[0], past[1], future[1], past[3], future[3]];
}

/** نمایش کوتاه: «۸ آبان ۱۴۰۵». */
export function jalaliText(parts, { digits = 'fa' } = {}) {
  if (!parts) return '';
  const text = `${parts.day} ${MONTH_NAMES[parts.month - 1]} ${parts.year}`;
  return digits === 'fa' ? text.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[digit]) : text;
}

/** «1405/08/07» برای فیلدهایی که متن شمسی می‌خواهند. */
export function jalaliSlash(parts) {
  if (!parts) return '';
  return `${parts.year}/${String(parts.month).padStart(2, '0')}/${String(parts.day).padStart(2, '0')}`;
}

/** «2026-10-29» میلادیِ همان روز تهران، برای فیلدهایی که `YYYY-MM-DD` می‌خواهند. */
export function gregorianDate(iso, timeZone = 'Asia/Tehran') {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** مقدار بیرونی فیلد ← ISO، برای هر سه قالب. */
export function valueToISO(value, format = 'iso', timeZone = 'Asia/Tehran') {
  const text = toLatin(value).trim();
  if (!text) return '';
  if (format === 'jalali') {
    const match = /^(\d{4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})$/.exec(text);
    return match ? jalaliToISO({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }, timeZone) || '' : '';
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    // روز میلادیِ بی‌ساعت، روزِ تهران است؛ ظهرش در هیچ منطقه‌ای روز را عوض نمی‌کند.
    const date = new Date(`${text}T08:30:00.000Z`);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/** ISO ← مقدار بیرونی، به قالب همان فیلد. */
export function isoToValue(iso, format = 'iso', timeZone = 'Asia/Tehran') {
  if (!iso) return '';
  if (format === 'date') return gregorianDate(iso, timeZone);
  if (format === 'jalali') return jalaliSlash(jalaliOf(iso, timeZone));
  return iso;
}
