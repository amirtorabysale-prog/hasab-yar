import { persianToISO, todayPersian } from './persianDate.js';

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

export function readServicePeriod(input, { occurredAt } = {}) {
  const text = String(input || '');
  if (!/ماه|سال/.test(text)) return null;
  if (PAST.test(text)) return null;

  const match = ADJECTIVE.exec(text) || FORWARD.exec(text);
  if (!match) return null;

  const count = monthsOf(match[1]);
  if (!(count > 0)) return null;
  const months = /سال/.test(match[2]) ? count * 12 : count;
  if (months > 120) return null;

  const start = occurredAt || null;
  if (!start) return null;
  const end = endOfPeriod(start, months);
  return end ? { start, end, months } : null;
}
