/**
 * برنامهٔ شناسایی — پخش یک مبلغ روی ماه‌های دوره.
 *
 * روش مصوب نسخهٔ اول: ماهانه، خط مستقیم، بر مبنای ماه شمسی
 * (`docs/wp0-open-decisions.md`، تصمیم ۲).
 *
 * سه چیز که اینجا اهمیت دارند و اگر رعایت نشوند در دفتر واقعی خودشان را نشان
 * می‌دهند:
 *
 * ۱. **جمع اقلام باید دقیقاً برابر مبلغ اصلی باشد.** تقسیم ۱۰۰ بر ۳ سه قلم
 *    ۳۳ می‌دهد و یک تومان گم می‌شود. ته‌مانده به قلم آخر می‌چسبد، نه اینکه
 *    روی همه پخش شود — پخش کردنش اعداد را غیررُند می‌کند و حسابدار نمی‌تواند
 *    با ماشین‌حساب تأییدش کند.
 *
 * ۲. **اجرای دوباره نباید قلم دوم بسازد.** هر قلم کلید یکتای خودش را دارد:
 *    ترکیب شناسهٔ منبع و شناسهٔ دوره. اجرای مجدد همان کلید را می‌سازد و لایهٔ
 *    ثبت آن را تکراری می‌بیند.
 *
 * ۳. **دورهٔ بسته سند نمی‌سازد.** قلمی که در دورهٔ بسته بیفتد علامت می‌خورد و
 *    به صف حسابدار می‌رود (تصمیم ۳). نه به دورهٔ بعد منتقل می‌شود و نه دورهٔ
 *    بسته را باز می‌کند.
 */

export const SCHEDULE_ITEM_STATUS = Object.freeze({
  PLANNED: 'planned',
  POSTED: 'posted',
  BLOCKED_CLOSED_PERIOD: 'blocked-closed-period',
  // برنامه عوض شده و این قلم دیگر جزو آن نیست. حذف نمی‌شود: تاریخچه باید
  // بگوید چرا برنامه عوض شد.
  SUPERSEDED: 'superseded',
});

import { persianToISO, readJalaliExpression, readTypedDate, todayPersian } from './persianDate.js';
import { normalizePersian } from './normalize.js';

/**
 * شمارهٔ مطلق ماه شمسی — برای شمردن و مقایسه.
 *
 * ماه‌های شمسی ۲۹ تا ۳۱ روزند، پس «دوازده ماه» را نمی‌شود با ۳۶۵ روز یا با
 * ۳۰ روز در ماه حساب کرد. تبدیل به یک عدد صحیح، شمردن را دقیق و مقایسه را
 * ساده می‌کند.
 */
function persianMonthIndex(iso) {
  const parts = todayPersian(new Date(iso));
  return (parts.year * 12) + (parts.month - 1);
}

/**
 * طول دوره به ماه — نه تعداد ماه‌های تقویمی که لمس می‌کند.
 *
 * اجارهٔ شش ماهه‌ای که ۱۵ مهر شروع شده تا ۱۴ فروردین است و هفت ماه تقویمی را
 * لمس می‌کند؛ شمردن ماه‌های لمس‌شده آن را هفت قسط ۵٫۱۴ میلیونی می‌کرد، به‌جای
 * شش قسط شش میلیونی. تصمیم مهر ۱۴۰۵: N قسط مساوی، از همان ماه شروع.
 *
 * پایان دوره روز آخرِ آن است، پس یک روز جلو می‌رود تا «تا ۱۴ فروردین» با «از
 * ۱۵ مهر» شش ماه کامل شود. اختلاف روزِ باقی‌مانده به نزدیک‌ترین ماه گرد
 * می‌شود: «تا ۲۸ فروردین» برای شروعِ ۳۰ مهر هم شش ماه است.
 */
function periodMonths(periodStart, periodEnd) {
  // پایان پیش از شروع یعنی دادهٔ خراب؛ برنامه‌ای از آن ساخته نمی‌شود.
  if (!(Date.parse(periodEnd) >= Date.parse(periodStart))) return 0;
  const start = todayPersian(new Date(periodStart));
  const end = todayPersian(new Date(new Date(periodEnd).getTime() + 86_400_000));
  const months = ((end.year * 12) + end.month) - ((start.year * 12) + start.month);
  return Math.max(1, months + Math.round((end.day - start.day) / 30));
}

function persianMonthKey(index) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * کلید یکتای یک قلم.
 *
 * ترکیب شناسهٔ منبع و شناسهٔ دوره است، نه شمارهٔ ردیف: اگر برنامه دوباره ساخته
 * شود، همان کلید درمی‌آید و لایهٔ ثبت آن را تکراری می‌بیند. کلید مبتنی بر
 * ردیف، با هر بازسازی عوض می‌شد و سند دوم می‌ساخت.
 */
export function scheduleItemKey(sourceId, periodKey) {
  return `${String(sourceId || '')}:${String(periodKey || '')}`;
}

/**
 * برنامهٔ ماهانه را می‌سازد.
 *
 * ورودی: مبلغ کل، شروع و پایان دوره، شناسهٔ منبع، و تاریخ پرداخت یا دریافت
 * (`notBefore`) که هیچ قلمی پیش از آن تاریخ نمی‌خورد.
 * خروجی: آرایه‌ای از اقلام، هرکدام با `periodKey` یکتا، مبلغ، و وضعیت اولیه.
 *
 * تعداد اقساط، طول دوره به ماه است و اقساط مساوی از ماهِ شروع پشت سر هم
 * می‌آیند؛ خرده‌ریز روزانه محاسبه نمی‌شود (تصمیم ۲، `docs/wp0-open-decisions.md`؛
 * دورهٔ وسط ماه: تصمیم مهر ۱۴۰۵).
 */
/**
 * تاریخ سند یک قلم: اول ماهِ همان قلم، ولی هرگز پیش از پرداخت یا دریافتی که
 * دارایی یا بدهی را ساخت.
 *
 * پوششی که پیش از پرداخت شروع شده — وسط ماه، یا ماه‌ها قبل — اقلامی دارد که
 * اول ماهشان پیش از سند نقدی است. سند با آن تاریخ یعنی حساب پیش‌پرداخت پیش از
 * پرداخت ماندهٔ بستانکار دارد (و درآمد انتقالی ماندهٔ بدهکار)، و ماه‌های گذشتهٔ
 * دفتر بی‌صدا بازنویسی می‌شوند. سهم ماه‌های گذشته همان روز پرداخت شناسایی
 * می‌شود — همان قاعده‌ای که پوششِ کاملاً گذشته را همان روز هزینه می‌کند.
 *
 * `periodKey` و کلید قلم دست نمی‌خورند: قلم همچنان مال ماه پوشش خودش است و
 * یکتایی و بازسازی برنامه به آن تکیه دارند.
 */
function recognitionDateFor(monthStart, notBefore) {
  if (!notBefore || !monthStart) return monthStart;
  const floor = new Date(notBefore);
  if (Number.isNaN(floor.getTime())) return monthStart;
  return floor.getTime() > new Date(monthStart).getTime() ? floor.toISOString() : monthStart;
}

export function buildMonthlySchedule({ amount, periodStart, periodEnd, sourceId, notBefore = null } = {}) {
  const total = Math.round(Number(amount) || 0);
  if (!(total > 0) || !periodStart || !periodEnd) return [];

  const firstMonth = persianMonthIndex(periodStart);
  const count = periodMonths(periodStart, periodEnd);
  if (!(count > 0)) return [];

  // ته‌ماندهٔ گرد کردن روی قلم آخر می‌نشیند، نه پخش‌شده روی همه: پخش کردنش
  // اعداد را غیررُند می‌کند و حسابدار دیگر نمی‌تواند با ماشین‌حساب تأییدشان
  // کند. جمع اقلام باید دقیقاً برابر مبلغ اصلی بماند.
  const share = Math.floor(total / count);
  const items = [];
  for (let offset = 0; offset < count; offset += 1) {
    const index = firstMonth + offset;
    const periodKey = persianMonthKey(index);
    const last = offset === count - 1;
    items.push(Object.freeze({
      key: scheduleItemKey(sourceId, periodKey),
      periodKey,
      recognitionDate: recognitionDateFor(persianToISO(Math.floor(index / 12), (index % 12) + 1, 1), notBefore),
      amount: last ? total - (share * (count - 1)) : share,
      status: SCHEDULE_ITEM_STATUS.PLANNED,
    }));
  }
  return items;
}

// ---------------------------------------------------------------------------
// دورهٔ پوششی که حسابدار گفته
// ---------------------------------------------------------------------------

const COUNT_WORDS = Object.freeze({
  یک: 1, یه: 1, دو: 2, سه: 3, چهار: 4, چار: 4, پنج: 5, شش: 6, شیش: 6, هفت: 7, هشت: 8, نه: 9, ده: 10,
  یازده: 11, دوازده: 12, پانزده: 15, پونزده: 15, هجده: 18, بیست: 20, سی: 30, سی‌وشش: 36, 'سی و شش': 36,
});
const COUNT_PATTERN = `(\\d{1,3}|${Object.keys(COUNT_WORDS).sort((a, b) => b.length - a.length).join('|')})`;
/**
 * «به مدت ۱۲ ماه»، «یک‌ساله»، «شش ماهه»، «دو سال» — طول پوشش.
 *
 * عدد باید واژهٔ خودش باشد: «اردیبهشت ماه» هشت ماه نیست و «پوشش سال ۱۴۰۵»
 * شش سال نیست. پیش از عدد نه رقم می‌آید، نه حرف فارسی، نه نیم‌فاصله؛ و پس از
 * واحد هم حرفی نمی‌چسبد («ماهانه» واحد مدت نیست).
 */
const DURATION = new RegExp(`(?<![\\d\\u0600-\\u06FF\\u200c])${COUNT_PATTERN}[\\s\\u200c]*(ماهه|ماه|ساله|سال)(?![\\u0600-\\u06FF])`);
/**
 * طول پوششی که در یک متن آمده، به ماه: «سه ماهه» ۳، «یک‌ساله» ۱۲؛ نگفته `null`.
 * `match` همان تکه‌ای است که خوانده شد تا جای دیگری تاریخ خوانده نشود.
 */
export function readCoverageLength(input) {
  const text = normalizePersian(String(input || ''));
  const duration = DURATION.exec(text);
  const count = duration ? (/^\d+$/.test(duration[1]) ? Number(duration[1]) : COUNT_WORDS[duration[1]] || 0) : 0;
  const months = duration && count > 0 ? (/سال/.test(duration[2]) ? count * 12 : count) : 0;
  return months > 0 && months <= 120 ? { months, match: duration[0] } : null;
}

/** طول یک دورهٔ پوشش به ماه شمسی (برای مقایسه با «سه ماهه»ی جواب). */
export function coverageMonths(periodStart, periodEnd) {
  return periodStart && periodEnd ? periodMonths(periodStart, periodEnd) || null : null;
}

/** مرز «از … تا …» در جواب. */
const RANGE_SPLIT = /\s(?:تا|الی|لغایت)\s/;

/** پایان دوره: همان روز، چند ماه شمسی بعد، منهای یک روز. */
function coverageEnd(startIso, months) {
  const parts = todayPersian(new Date(startIso));
  const total = (parts.year * 12) + (parts.month - 1) + months;
  const next = persianToISO(Math.floor(total / 12), (total % 12) + 1, Math.min(parts.day, 29));
  return next ? new Date(new Date(next).getTime() - 86_400_000).toISOString() : null;
}

function lastDayOfMonth(year, month) {
  const next = month === 12 ? persianToISO(year + 1, 1, 1) : persianToISO(year, month + 1, 1);
  return next ? new Date(new Date(next).getTime() - 86_400_000).toISOString() : null;
}

/**
 * یک سرِ دوره: «اول مهر ۱۴۰۵»، «۳۱ شهریور ۱۴۰۶»، «آخر شهریور سال بعد»، «۱۴۰۵/۰۷/۰۱».
 *
 * ماهِ بی‌روز برای شروع اول ماه است و برای پایان آخر ماه — «مهر ۱۴۰۵ تا شهریور
 * ۱۴۰۶» دوازده ماه کامل است، نه یازده ماه و یک روز. سالِ نگفته از تاریخ رویداد
 * می‌آید و پایانی که ماهش پیش از ماه شروع است، سال بعد است.
 */
function coverageBound(text, { reference, end = false, after = null }) {
  const named = readJalaliExpression(text);
  if (named) {
    const base = todayPersian(new Date(after || reference));
    let year = named.year || (base.year + (named.yearOffset || 0));
    if (!named.year && named.yearOffset == null && after && named.month < base.month) year += 1;
    if (named.end || (end && !named.day)) return lastDayOfMonth(year, named.month);
    return persianToISO(year, named.month, named.day || 1);
  }
  return readTypedDate(text, { now: new Date(reference) });
}

/**
 * دورهٔ پوشش از جواب‌های حسابدار.
 *
 * چرا جدا از `readServicePeriod` گفتار: جواب یک سؤال صریح است، نه یک جملهٔ
 * پرداخت. «از اول مهر ۱۴۰۵ به مدت ۱۲ ماه» در گفتار نشانهٔ آینده ندارد و آنجا
 * عمداً دوره خوانده نمی‌شود؛ اینجا خودِ سؤال گفته بود «دوره از کی تا کی؟».
 *
 * ورودی: جواب‌ها به ترتیب اولویت، هرکدام `{ text, side }` که `side` یکی از
 * `start`، `end` یا `any` است؛ و آنچه از قبل معلوم است (`start`، `end`).
 * خروجی: `{ start, end }` — هرکدام که خوانده نشد `null` می‌ماند. چیزی حدس زده
 * نمی‌شود: شروعی که گفته نشده از تاریخ پرداخت ساخته نمی‌شود.
 */
export function readCoverageAnswers(answers = [], { occurredAt = null, start = null, end = null, months: knownMonths = null } = {}) {
  const reference = occurredAt || new Date().toISOString();
  let from = null;
  let to = null;
  let months = null;
  for (const answer of answers) {
    // پرانتز و گیومهٔ شرح سند («(مهر تا اسفند ۱۴۰۵)») مرز واژه را نمی‌شکند.
    const text = normalizePersian(String(answer?.text || '')).replace(/[()«»"\[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const side = answer.side || 'any';
    const duration = readCoverageLength(text);
    if (!months && duration) months = duration.months;
    // عدد مدت تاریخ نیست: «۱۲ ماه» نباید «۱۲ مهر» خوانده شود.
    const dated = duration ? text.replace(duration.match, ' ') : text;
    const [head, tail] = dated.split(RANGE_SPLIT);
    if (tail !== undefined) {
      const first = coverageBound(head, { reference });
      if (first && !from) from = first;
      const last = coverageBound(tail, { reference, end: true, after: first || from || start });
      if (last && !to) to = last;
    } else if (/\d|اول|آخر|پایان|ابتدا|فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند/.test(head)) {
      const isEnd = side === 'end' || /پایان|آخر|انتها|اتمام/.test(head);
      const bound = coverageBound(head, { reference, end: isEnd, after: isEnd ? (from || start) : null });
      if (bound && isEnd && !to) to = bound;
      else if (bound && !isEnd && !from) from = bound;
    }
  }
  const startIso = from || start || null;
  // طولی که از پیش معلوم بود («یک‌ساله» در متن) با شروعِ تازهٔ جواب: «از اول
  // مهر» یعنی همان دوازده ماه از اول مهر، نه پایانِ کهنه‌ای که از روز پرداخت
  // حساب شده بود.
  const length = months || (from && !to ? (knownMonths || (start && end ? periodMonths(start, end) : null)) : null);
  let endIso = to || end || null;
  if (startIso && !to && length) endIso = coverageEnd(startIso, length);
  if (startIso && endIso && !(Date.parse(endIso) >= Date.parse(startIso))) return { start: startIso, end: null };
  return { start: startIso, end: endIso };
}
