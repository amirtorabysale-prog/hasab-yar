import { PERSIAN_MONTHS, normalizeSpokenYears, persianToISO, todayPersian } from './persianDate.js';

/**
 * دورهٔ پوششِ گفته‌شده در جمله.
 *
 * چرا لازم شد:
 *
 * قاعدهٔ پیش‌پرداخت از فاز صفر ساخته شده بود، ولی فقط وقتی کار می‌کرد که دسته
 * در فهرست خدمات دوره‌دار باشد. «پونزده میلیون شارژ ساختمان رو برای شش ماه
 * جلوتر تسویه کردم» دسته‌اش «قبوض» است و در آن فهرست نیست — در حالی که خودِ
 * جمله دوره را صریح گفته. قاعده بود و داده نمی‌رسید.
 *
 * دو شکل پذیرفته می‌شود:
 *
 * - **صفت دوره**: «یک‌ساله»، «شش ماهه»، «سه ماهه». خودِ واژه می‌گوید پوشش چند
 *   ماه است.
 * - **عدد + واحد + نشانهٔ آینده**: «برای شش ماه جلوتر»، «سه ماه آینده».
 *
 * «شش ماه پیش» عمداً بیرون است: یک زمان است، نه یک دورهٔ پوشش. بدون این مرز،
 * هر اشارهٔ زمانی به پیش‌پرداخت تبدیل می‌شد.
 *
 * الگو روی متن خام اجرا می‌شود و نرمال‌سازی فارسی صدا زده نمی‌شود: تایپ زنده
 * بودجهٔ میلی‌ثانیه‌ای دارد و این درس دو بار گرفته شده.
 */

const GAP = '[\\s\\u200c]*';
const YA = '[یي]';

const WORD_NUMBERS = Object.freeze({
  یک: 1, یه: 1, دو: 2, سه: 3, چهار: 4, چار: 4, پنج: 5, شش: 6, شیش: 6,
  هفت: 7, هشت: 8, نه: 9, ده: 10, یازده: 11, دوازده: 12, هجده: 18, بیست: 20, بیست‌وچهار: 24,
});

const NUMBER_PATTERN = `(\\d{1,2}|${Object.keys(WORD_NUMBERS).join('|')})`;

/** «شش ماهه»، «یک‌ساله» — صفت، یعنی طول پوشش. */
const ADJECTIVE = new RegExp(`${NUMBER_PATTERN}${GAP}(ماهه|ساله|سال${GAP}ه)`);
/** «برای شش ماه جلوتر» — عدد و واحد، با نشانهٔ صریح آینده. */
const FORWARD = new RegExp(`${NUMBER_PATTERN}${GAP}(ماه|سال)${GAP}(?:${['جلوتر', 'آ' + YA + 'نده', 'بعد', 'پ' + YA + 'ش' + GAP + 'رو', 'آت' + YA].join('|')})`);
/** گذشته: صریحاً یک زمان است، نه دوره. */
const PAST = new RegExp(`${NUMBER_PATTERN}${GAP}(?:ماه|سال)${GAP}(?:پ${YA}ش|قبل|گذشته)`);

const monthsOf = (token) => (/^\d+$/.test(token) ? Number(token) : WORD_NUMBERS[token] || 0);

/** ماه شمسی را جلو می‌برد و یک روز عقب می‌کشد: پایان دوره، نه شروع دورهٔ بعد. */
function endOfPeriod(startIso, months) {
  const parts = todayPersian(new Date(startIso));
  const total = (parts.year * 12) + (parts.month - 1) + months;
  const next = persianToISO(Math.floor(total / 12), (total % 12) + 1, Math.min(parts.day, 28));
  return next ? new Date(new Date(next).getTime() - 86_400_000).toISOString() : null;
}

/**
 * شرط پرداخت، دورهٔ خدمت نیست.
 *
 * «نسیه دو ماهه»، «چک شش‌ماهه»، «وام دوساله» همان صفت دوره را دارند ولی
 * دربارهٔ **مهلت پرداخت** حرف می‌زنند، نه مدت خدمتی که خریده شده. در آزمون
 * استرس، «پنج تا صندلی… نسیه دو ماهه» پیش‌پرداخت قطعی شد و «سهم‌الشرکه… چک
 * شش‌ماهه» هم — هر دو با اطمینان و هر دو غلط.
 */
const CREDIT_TERM = new RegExp(`(?:نس${YA}ه|چک|وام|قسط|اقساط|مهلت|سررس${YA}د|مدت${GAP}دار|تسه${YA}لات|سپرده|اعتبار|ضمانت)${GAP}(?:[^\\s]+${GAP}){0,2}$`);

function termOfPayment(text, index) {
  return CREDIT_TERM.test(text.slice(Math.max(0, index - 30), index));
}

const MONTH_NAMES = PERSIAN_MONTHS.map(([name]) => name).join('|');
const monthNumber = (name) => PERSIAN_MONTHS.find(([candidate]) => candidate === name)?.[1] || 0;

/**
 * «از اول فروردین تا آخر اسفند» — بازهٔ صریح ماه‌ها، با سالِ اختیاری کنار هر ماه.
 *
 * «از اول آبان ۱۴۰۵ تا پایان مهر ۱۴۰۶» تا مهر ۱۴۰۵ خوانده نمی‌شد، چون سالِ
 * میان ماه و «تا» الگو را می‌شکست؛ دوره از «یک‌ساله» و از روز پرداخت ساخته
 * می‌شد و سال‌ها مبلغ شمرده می‌شدند.
 */
const RANGE_YEAR = `(?:${GAP}(?:سال${GAP})?(\\d{4}|\\d{2})(?![\\d]))?`;
const MONTH_RANGE = new RegExp(`(?<![آ-ی])از${GAP}(?:اول${GAP}|ابتدا${YA}${GAP})?(${MONTH_NAMES})${GAP}(?:ماه${GAP})?${RANGE_YEAR}${GAP}تا${GAP}(?:آخر${GAP}|پا${YA}ان${GAP}|انتها${YA}${GAP})?(${MONTH_NAMES})(?:${GAP}ماه)?${RANGE_YEAR}`);
/** «۰۵» یعنی ۱۴۰۵: سال دورقمی در گفتار، سال همین سده است. */
const fullYear = (value) => (!value ? null : value.length === 2 ? 1400 + Number(value) : Number(value));
/**
 * «بابت اجاره اردیبهشت ماه» — یک ماه نام‌برده، به‌عنوان موضوع پرداخت.
 *
 * مرز واژه لازم است: «مال» درون «مالیات» و «دی» درون «عیدی» پیدا می‌شد و
 * «مالیات عیدی» دورهٔ دی‌ماه می‌گرفت. «مهر»، «تیر» و «دی» واژه‌های روزمره هم
 * هستند («بابت مهر شرکت»)، پس فقط با «ماه» پشتشان ماه شمرده می‌شوند.
 */
const COMMON_WORD_MONTHS = ['تیر', 'تير', 'مهر', 'دی'];
const DISTINCT_MONTHS = PERSIAN_MONTHS.map(([name]) => name).filter((name) => !COMMON_WORD_MONTHS.includes(name)).join('|');
const NAMED_MONTH = new RegExp(`(?<![آ-ی])(?:بابت|مال|برا${YA}|واسه)(?![آ-ی])${GAP}(?:[^\\s\\d]+[\\s\\u200c]+){0,3}?(?:(${DISTINCT_MONTHS})(?![آ-ی])|(${COMMON_WORD_MONTHS.join('|')})${GAP}ماه)(?![^\\s]*\\d)`);

/**
 * «اجارهٔ مهر»، «شارژ ماه آبان» — ماه درست پشت نام خدمت دوره‌دار.
 *
 * بی‌حرف «بابت» هم روشن است که ماه موضوع پرداخت است؛ پشت «اجاره» حتی «مهر» و
 * «دی» واژهٔ روزمره نیستند. بدون این، «اجارهٔ مهر» بی‌دوره می‌ماند و برای
 * اجارهٔ همین ماه، شروع دوره پرسیده می‌شد.
 */
const SERVICE_MONTH = new RegExp(`(?<![آ-ی])(?:اجاره|اجاره${GAP}بها|کرا${YA}ه${GAP}(?:دفتر|مغازه|انبار|خانه|خونه)|شارژ|اشتراک)(?:${GAP}${YA}(?![آ-ی])|ٔ)?${GAP}(?:ماه${GAP})?(${MONTH_NAMES})(?![آ-ی])`);

function yearShift(text) {
  if (/پارسال|سال${GAP}(?:قبل|گذشته)/.test(text)) return -1;
  if (/سال${GAP}(?:بعد|آ[یي]نده)/.test(text)) return 1;
  return 0;
}

/** روز آخرِ یک ماه شمسی: یک روز پیش از اول ماه بعد. */
function lastDayOf(year, month) {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const first = persianToISO(nextYear, nextMonth, 1);
  return first ? new Date(new Date(first).getTime() - 86_400_000).toISOString() : null;
}

function monthSpan(year, fromMonth, toMonth, explicitEndYear = null) {
  const endYear = explicitEndYear || (toMonth < fromMonth ? year + 1 : year);
  if (endYear < year || (endYear === year && toMonth < fromMonth)) return null;
  const start = persianToISO(year, fromMonth, 1);
  const end = lastDayOf(endYear, toMonth);
  if (!start || !end) return null;
  const months = ((endYear - year) * 12) + (toMonth - fromMonth) + 1;
  return { start, end, months };
}

/**
 * ماه‌های نام‌برده، پیش از هر صفتی.
 *
 * «بیمهٔ یک‌ساله، از اول فروردین تا آخر اسفند» دوره را از خودِ جمله دارد؛
 * شروع کردنش از روز پرداخت — که ممکن است مهر باشد — نیمی از پوشش را به
 * آینده هل می‌داد. سال از تاریخ رویداد می‌آید، مگر جمله خودش سال دیگری بگوید.
 */
function namedMonths(text, occurredAt) {
  const reference = todayPersian(new Date(occurredAt));
  const year = reference.year + yearShift(text);
  const range = MONTH_RANGE.exec(text);
  if (range) {
    // سالِ گفته‌شده بر سال تاریخ رویداد مقدم است؛ اگر فقط سالِ پایان گفته شده،
    // سال شروع از روی ترتیب ماه‌ها پیدا می‌شود.
    const fromMonth = monthNumber(range[1]), toMonth = monthNumber(range[3]);
    const endYear = fullYear(range[4]);
    const startYear = fullYear(range[2]) || (endYear ? (toMonth < fromMonth ? endYear - 1 : endYear) : year);
    return monthSpan(startYear, fromMonth, toMonth, endYear);
  }
  const single = NAMED_MONTH.exec(text);
  if (single) {
    const month = monthNumber(single[1] || single[2]);
    return month ? monthSpan(year, month, month) : null;
  }
  const service = SERVICE_MONTH.exec(text);
  if (service) {
    const month = monthNumber(service[1]);
    return month ? monthSpan(year, month, month) : null;
  }
  return null;
}

export function readServicePeriod(input, { occurredAt } = {}) {
  // «مهر هزار و چهارصد و پنج» همان «مهر 1405» است؛ بی‌این، بازه شناخته نمی‌شد.
  // آزمون ارزان پیش از تبدیل: تایپ زنده بودجهٔ میلی‌ثانیه‌ای دارد.
  const raw = String(input || '');
  const text = /هزار\s+و\s+(?:سیصد|چهارصد)/.test(raw) ? normalizeSpokenYears(raw) : raw;
  if (!/ماه|سال|فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند/.test(text)) return null;
  if (PAST.test(text)) return null;
  const start = occurredAt || null;
  if (!start) return null;

  const named = namedMonths(text, start);
  if (named) return named;

  let match = null;
  for (const pattern of [ADJECTIVE, FORWARD]) {
    const candidate = pattern.exec(text);
    if (candidate && !termOfPayment(text, candidate.index)) { match = candidate; break; }
  }
  if (!match) return null;

  const count = monthsOf(match[1]);
  if (!(count > 0)) return null;
  const months = /سال/.test(match[2]) ? count * 12 : count;
  if (months > 120) return null;

  const end = endOfPeriod(start, months);
  return end ? { start, end, months } : null;
}
