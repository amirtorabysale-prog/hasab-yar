import { normalizePersian } from './normalize.js';

/**
 * برچسب موضوعی = «چه چیزی»، نه «کجا» و «چندتا».
 *
 * مدل موضوع را هر بار کمی متفاوت می‌نویسد: «قهوه»، «قهوهٔ دفتر»، «قهوه برای دفتر»،
 * «یه کارتریج پرینتر دیگه»، «دو کارتن آب معدنی». هر کدام تفصیلیِ جدا می‌شد، شمارش
 * ارتقا پخش می‌شد و پارسیان چند تفصیلی برای یک قلم می‌گرفت (آزمون زندهٔ ۴ آبان ۱۴۰۵).
 *
 * محل («دفتر»، «مغازه») بُعدِ دیگری است — مرکز هزینه — و فقط وقتی به کار می‌رود که
 * حسابدار مرکز هزینه‌ای به همان نام تعریف کرده باشد. این‌جا فقط جدا می‌شود، حدس زده
 * نمی‌شود.
 *
 * برمی‌گرداند { item, place }؛ `place` null وقتی محلی در برچسب نیست.
 */
const PLACES = ['دفتر کار', 'دفتر', 'مغازه', 'انبار', 'کارگاه', 'فروشگاه', 'کارخانه', 'سالن', 'آبدارخانه', 'آبدارخونه', 'شعبه'];
const PLACE_AT_END = new RegExp(`(?:\\s+(?:برای|واسه|واسه‌ی|مال|داخل|توی|تو))?\\s+(${PLACES.join('|')})$`);
const COUNT = '(?:یه|یک|دو|سه|چهار|پنج|شش|شیش|هفت|هشت|نه|ده|\\d+)';
const UNIT = '(?:کارتن|بسته|جعبه|عدد|تا|کیسه|بطری|شیشه|کیلو|بسته‌ی|بسته ی)';
const QUANTITY_AT_START = new RegExp(`^${COUNT}\\s+(?:${UNIT}\\s+)?`);
const TRAILING_FILLER = /\s+(?:دیگه|دیگر)$/;
// خدمتی که روی خودِ محل انجام می‌شود: «اجارهٔ دفتر» و «اجارهٔ مغازه» دو قلم‌اند، نه یک قلم
// در دو محل. محل این‌جا جزءِ قلم می‌ماند (و مرکز هزینه هم می‌شود، اگر تعریف شده باشد).
const PLACE_BOUND = /^(?:اجاره|کرایه|رهن|ودیعه|شارژ|قبض|قبوض|تعمیر|تعمیرات|نظافت|سرویس|بیمه|عوارض|نگهداری|بازسازی|نقاشی|سیم\s*کشی)(?![آ-ی])/;

export function topicParts(label) {
  const text = normalizePersian(String(label || '').replace(/ۀ/g, 'ه')).replace(/\s+/g, ' ').trim();
  if (!text) return { item: '', place: null };
  let rest = text.replace(TRAILING_FILLER, '');
  const place = rest.match(PLACE_AT_END);
  // «قهوه‌ی دفتر»: کسرهٔ نوشته‌شده پس از جدا شدن محل می‌ماند.
  if (place) rest = rest.slice(0, place.index).replace(/\s+ی$/, '');
  rest = rest.replace(QUANTITY_AT_START, '').replace(TRAILING_FILLER, '').trim();
  // «دفتر» تنها یا «دو کارتن» تنها: چیزی جز محل یا شمار نمانده؛ برچسب همان است که بود.
  if (!rest) return { item: text, place: null };
  if (place && PLACE_BOUND.test(rest)) return { item: `${rest} ${place[1]}`, place: place[1] };
  return { item: rest, place: place ? place[1] : null };
}
