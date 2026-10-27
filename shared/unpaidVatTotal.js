import { extractAmounts } from './parser.js';
import { exclusiveVatTotal } from './vatSpeech.js';

/**
 * جمعِ بدهی یا طلبِ بازی که مبلغش «به‌علاوهٔ X درصد ارزش افزوده» گفته شده.
 *
 * «فاکتور خرید … ۴۰ میلیون تومان به‌علاوهٔ ۱۰ درصد ارزش افزوده، پولش هنوز ندادیم»
 * بدهیِ ۴۴ است (آزمون زندهٔ ۴ آبان ۱۴۰۵). سازندهٔ رویداد و برگهٔ فهم هر دو از
 * همین تابع می‌خوانند تا یک عدد بگویند.
 *
 * null وقتی نرخ گفته نشده، یا خودِ این مبلغ جمعِ عددِ دیگری از همین جمله است
 * («… به‌علاوهٔ ۱۰ درصد، میشه ۴۴»): جمع دوباره جمع نمی‌شود. مبلغ ممکن است به
 * ریال باشد و عدد جمله به تومان؛ هر دو سنجیده می‌شوند.
 */
export function unpaidVatTotal(text, amount) {
  const total = exclusiveVatTotal(text, amount);
  if (!total) return null;
  const stated = extractAmounts(String(text || '')).spans.map((span) => span.amount);
  const alreadyGross = stated.some((value) => [1, 10].some((unit) => exclusiveVatTotal(text, value * unit)?.gross === total.net));
  return alreadyGross ? null : total;
}
