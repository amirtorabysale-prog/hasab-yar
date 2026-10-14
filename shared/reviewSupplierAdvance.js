import { isPrepaidServiceCandidate, isTimeBoundService } from './economicFamily.js';

/**
 * پیش‌پرداخت خریدِ صریح در بازبینی حسابدار — نه بیمه، اشتراک یا هر خدمت دوره‌دار.
 *
 * «اشتراک یک ساله نرم افزار رو خریدیم پیش پرداخت ۲۴ میلیون» هم «خرید» دارد و هم
 * «پیش پرداخت»، ولی خدمتی است که ماه‌به‌ماه هزینه می‌شود و تأمین‌کننده لازم
 * ندارد. برچسب پیش‌پرداخت خرید روی آن، نام طرف‌حساب می‌خواست و سند را به
 * «پیش‌پرداخت خرید — <طرف>» می‌برد. همان قاعدهٔ موتور تصمیم این‌جا هم حاکم است:
 * دستهٔ دوره‌دار یا دورهٔ صریحی که زمان تحویل کالا نیست، پیش‌پرداخت خدمت است.
 * کلید پیشنهادی حسابدار برای حساب پیش‌پرداخت (مثلاً «بیمه») هم همین را می‌گوید.
 */
export function isReviewSupplierAdvance(evidence, lines = [], event = {}) {
  const text=String(evidence || '').replace(/[‌\s]+/g,' ');
  if (isPrepaidServiceCandidate({ ...event, evidence: text })) return false;
  if (lines.some(l=>l.role==='prepaid-asset' && isTimeBoundService({ category: String(l.key || '').trim(), evidence: text }))) return false;
  return /خرید/.test(text) && /پیش پرداخت|پیش پیش/.test(text)
    && lines.length===2 && lines.some(l=>l.role==='prepaid-asset' && l.debit>0)
    && lines.some(l=>l.role==='cash' && l.credit>0);
}
