import { normalizePersian } from './parser.js';

const LEADING_TITLES = /^(?:(?:شرکت|موسسه|مؤسسه|آقای|اقای|خانم|جناب|مهندس|دکتر)\s+)+/u;
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
