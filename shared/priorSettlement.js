import { normalizePersian } from './normalize.js';

/** پولی که بابت یک طلب یا بدهی موجود جابه‌جا شده، تعهد تازه نیست. */
export function priorSettlementDirection(input) {
  const text = normalizePersian(input);
  if (!text) return null;
  const received = /(?:دریافت\s*(?:کردم|کردیم|شد|شده)|گرفت(?:م|یم)|وصول\s*(?:شد|شده|کردم|کردیم)|به\s*حساب(?:م|مان|مون)?\s*واریز\s*(?:شد|کرد))/.test(text);
  const paid = /(?:پرداخت\s*(?:کردم|کردیم|شد|شده)|داد(?:م|یم)|تسویه\s*(?:کردم|کردیم|شد))/.test(text);
  if (received && /(?:طلب|مطالبه|حساب\s*دریافتنی)/.test(text)) return 'receivable';
  if (paid && /(?:بدهی|حساب\s*پرداختنی)/.test(text)) return 'payable';
  return null;
}
