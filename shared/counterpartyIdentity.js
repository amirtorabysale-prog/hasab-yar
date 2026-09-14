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

/** کلید قطعی طرف حساب؛ بدون fuzzy matching پرریسک برای دادهٔ مالی. */
export function canonicalCounterpartyName(value) {
  return normalizePersian(String(value || ''))
    .replace(/[\u200c\u200d\u2060]/gu, ' ')
    .replace(/[()\[\]{}«»"'،,؛;:.ـ_-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(LEADING_TITLES, '')
    .replace(LEGAL_SUFFIXES, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function cleanCounterpartyDisplayName(value, limit = 100) {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, limit);
}
