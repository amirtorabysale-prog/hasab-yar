/** Only explicit purchase advances paid now; not insurance or amortization. */
export function isReviewSupplierAdvance(evidence, lines = []) {
  const text=String(evidence || '').replace(/[‌\s]+/g,' ');
  return /خرید/.test(text) && /پیش پرداخت|پیش پیش/.test(text)
    && lines.length===2 && lines.some(l=>l.role==='prepaid-asset' && l.debit>0)
    && lines.some(l=>l.role==='cash' && l.credit>0);
}
