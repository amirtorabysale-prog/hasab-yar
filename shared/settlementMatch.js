/**
 * تطبیق یک جابه‌جایی پول با اسناد باز طرف حساب.
 *
 * چرا تابع خالص و جدا از دیتابیس: این منطق باید آزمون‌پذیر باشد بدون ساختن
 * دفتر. خواندنِ اسناد باز کار لایهٔ سرور است؛ تصمیمِ «این پول کدام سند را
 * می‌بندد» اینجا گرفته می‌شود و با هر منبعی کار می‌کند.
 *
 * قاعدهٔ حاکم: **ابهام یعنی ارجاع، نه حدس.** دو سند هم‌مبلغ یعنی نمی‌دانیم
 * کدام بسته می‌شود؛ انتخاب یکی‌شان سند اشتباه را می‌بندد و هیچ نشانه‌ای هم
 * نمی‌گذارد. این بدترین نوع خطاست چون در تراز دیده نمی‌شود.
 */

export const SETTLEMENT_MATCH = Object.freeze({
  /** مبلغ دقیقاً برابر ماندهٔ یک سند باز است. */
  EXACT: 'exact',
  /** مبلغ کمتر از ماندهٔ یک سند باز است؛ تسویهٔ جزئی. */
  PARTIAL: 'partial',
  /** بیش از یک سند به یک اندازه موجه است. */
  AMBIGUOUS: 'ambiguous',
  /** هیچ سندی نمی‌خواند؛ رویداد همان چیزی است که گفته شد. */
  NONE: 'none',
});

/**
 * جهت پول باید با جهت سند بخواند.
 *
 * پول خارج شد و به او بدهکار بودیم → بدهی‌اش کم می‌شود.
 * پول وارد شد و او به ما بدهکار بود → طلبمان کم می‌شود.
 *
 * هر ترکیب دیگری تسویه نیست. «پول گرفتم» در حالی که به او بدهکاریم، یک
 * رویداد تازه است نه بستن همان بدهی.
 */
function directionFits(moneyDirection, documentDirection) {
  if (moneyDirection === 'out') return documentDirection === 'payable';
  if (moneyDirection === 'in') return documentDirection === 'receivable';
  return false;
}

/**
 * سندی که این پول می‌بندد، یا اعلام ابهام.
 *
 * خروجی: `{ kind, document, candidates }`.
 */
export function matchOpenDocument({ amount, moneyDirection } = {}, openDocuments = []) {
  const value = Math.round(Number(amount) || 0);
  const documents = (openDocuments || []).filter((document) => document
    && directionFits(moneyDirection, document.direction)
    && Number(document.remaining) > 0);

  if (!value || !documents.length) return Object.freeze({ kind: SETTLEMENT_MATCH.NONE, document: null, candidates: [] });

  // پرداخت بیشتر از ماندهٔ سند یعنی چیزی غیر از تسویه هم در کار است — مثلاً
  // تسویه به‌علاوهٔ خرید تازه. تکه‌کردنش بدون گفتن، حدس است.
  const exact = documents.filter((document) => Number(document.remaining) === value);
  if (exact.length === 1) return Object.freeze({ kind: SETTLEMENT_MATCH.EXACT, document: exact[0], candidates: exact });
  if (exact.length > 1) return Object.freeze({ kind: SETTLEMENT_MATCH.AMBIGUOUS, document: null, candidates: exact });

  const partial = documents.filter((document) => Number(document.remaining) > value);
  if (partial.length === 1) return Object.freeze({ kind: SETTLEMENT_MATCH.PARTIAL, document: partial[0], candidates: partial });
  if (partial.length > 1) return Object.freeze({ kind: SETTLEMENT_MATCH.AMBIGUOUS, document: null, candidates: partial });

  return Object.freeze({ kind: SETTLEMENT_MATCH.NONE, document: null, candidates: [] });
}
