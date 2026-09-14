import { normalizePersian } from './parser.js';

/**
 * فقط شکل حقوقی کنار گذاشته می‌شود، نه عنوان شخص.
 *
 * «شرکت آرمان (سهامی خاص)» و «آرمان» یک شرکت‌اند. ولی «آقای رضایی» و «خانم
 * رضایی» دو نفرند؛ وقتی «آقای» و «خانم» هم حذف می‌شدند هر دو به «رضایی» تبدیل
 * می‌شدند و مهاجرت، طلب و بدهی دو آدم متفاوت را روی یک طرف حساب ادغام می‌کرد —
 * بی‌بازگشت. «دکتر» و «مهندس» هم به همین دلیل می‌مانند.
 *
 * قاعده برای دادهٔ مالی: ادغامِ اشتباه بسیار گران‌تر از یک تکراریِ پیدانشده است.
 */
const LEADING_TITLES = /^(?:(?:شرکت|موسسه|مؤسسه)\s+)+/u;
const LEGAL_SUFFIXES = /\s+(?:سهامی\s+(?:خاص|عام)|با\s+مسئولیت\s+محدود)$/u;

/**
 * کلید «همان نوشته».
 *
 * فقط تفاوت‌های نوشتاری را یکی می‌کند — «ي» و «ی»، نیم‌فاصله، ویرگول، پرانتز.
 * دو نامی که این کلیدشان یکی است واقعاً یک نام‌اند و بی‌پرسش یکی شمرده می‌شوند.
 */
export function exactCounterpartyKey(value) {
  return normalizePersian(String(value || ''))
    .replace(/[\u200c\u200d\u2060]/gu, ' ')
    .replace(/[()\[\]{}«»"'،,؛;:.ـ_-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * کلید «احتمالاً همان طرف حساب».
 *
 * شکل حقوقی را هم کنار می‌گذارد. دو نامی که فقط در این کلید یکی‌اند «مشابه»اند
 * نه «یکسان»؛ یکی کردنشان تصمیم ثبت‌کننده است، نه برنامه.
 */
export function canonicalCounterpartyName(value) {
  return exactCounterpartyKey(value)
    .replace(LEADING_TITLES, '')
    .replace(LEGAL_SUFFIXES, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function cleanCounterpartyDisplayName(value, limit = 100) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

/** پاسخ‌های مجاز ثبت‌کننده به «این همان طرف حساب است؟» */
export const COUNTERPARTY_RESOLUTIONS = Object.freeze({ MERGE: 'merge', SEPARATE: 'separate' });
