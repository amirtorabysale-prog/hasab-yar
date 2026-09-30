import { extractAmounts } from './parser.js';
import { normalizePersian } from './normalize.js';
import { natureNeedsAccountant, readEventNature } from './eventNature.js';

export const UNQUANTIFIED_REVIEW_REASON = 'مبلغ و مبنای سند مشخص نیست؛ درخواست برای پیگیری حسابدار ذخیره شد و هیچ سندی ساخته نشد.';
export function needsUnquantifiedReview(input) {
  const text = normalizePersian(input);
  if (extractAmounts(text).spans.some(span => span.amount > 0)) return false;
  return natureNeedsAccountant(readEventNature(text))
    || /مغایرت|هیچ\s*(?:عدد|مبلغ)|(?:حساب|مانده).*صاف\s*(?:کن|شه)/.test(text);
}
