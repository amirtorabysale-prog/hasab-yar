import { extractAmounts } from '../../shared/parser.js';
import { formatAmount } from './format.js';

/**
 * حالِ «حسابی»، نماد ماشین‌حسابِ نوار ضبط — از وضعیت واقعی برنامه، نه حدس.
 *
 * ترتیب، اولویت است. هشدار بر همه مقدم است: کاربری که حسابش منفی می‌شود نباید
 * شادیِ «ثبت شد» یا موجِ شنیدن ببیند. بعد «ثبت شد» که چند ثانیه می‌ماند، بعد هر
 * چیزی که از کاربر جوابی می‌خواهد (کارت تأیید، پروندهٔ فهم، شاید تکراری)، بعد
 * کارِ در جریان (پردازش صدا، تحلیل AI)، بعد شنیدن و نوشتن.
 */
export const MASCOT_MOODS = Object.freeze(['idle', 'listening', 'typing', 'thinking', 'question', 'success', 'worried']);

export function mascotMood({
  recordState = 'idle', manualText = '', savedRecently = false, reviewing = false,
  analyzing = false, asking = false, worried = false,
} = {}) {
  if (worried) return 'worried';
  if (savedRecently) return 'success';
  if (reviewing || asking) return 'question';
  if (analyzing || recordState === 'processing' || recordState === 'finalizing') return 'thinking';
  if (recordState === 'recording' || recordState === 'requesting') return 'listening';
  if (String(manualText || '').trim()) return 'typing';
  return 'idle';
}

/**
 * آنچه LCD در هشدار نشان می‌دهد: ماندهٔ منفیِ واقعیِ حساب از برگهٔ منفی‌شدن
 * («−۱۵٬۰۰۰٬۰۰۰»)، یا «خطا» وقتی صدا پردازش نشد.
 */
export function mascotAlert({ overdraftPrompt = null, failure = null } = {}) {
  if (overdraftPrompt) {
    const after = Number(overdraftPrompt.accounts?.[0]?.after);
    return Number.isFinite(after) && after < 0 && overdraftPrompt.kind !== 'stock' ? `−${formatAmount(Math.abs(after))}` : '−';
  }
  return failure ? 'خطا' : '';
}

/** آخرین مبلغی که کاربر تا این لحظه نوشته («۱۵ میلیون» ← ۱۵۰۰۰۰۰۰)؛ بی‌مبلغ null. */
export function typedAmount(text = '') {
  if (!String(text || '').trim()) return null;
  try {
    const last = (extractAmounts(String(text)).spans || []).at(-1);
    return last && Number.isSafeInteger(last.amount) && last.amount > 0 ? last.amount : null;
  } catch {
    return null;
  }
}
