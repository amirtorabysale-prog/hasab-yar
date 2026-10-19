/**
 * «شاید این ثبت تکراری باشد» — یک قاعده برای همهٔ راه‌های ثبتِ یک کارت.
 *
 * گزارش مالک محصول (۲۳ مهر ۱۴۰۵): «اجاره دفتر مهر ۱۵ میلیون از حساب سامان» از صف
 * حسابدار ثبت شد و دو دقیقه بعد «اجاره مهر دفتر ۱۵ میلیون از سامان» از مسیر AI؛ هیچ
 * هشداری نیامد. کنترلِ تکرار فقط در ثبت روزانه بود و فقط برای ثبتِ هم‌متنِ پنج دقیقهٔ
 * اخیر (دوبار زدن دکمه)، نه برای «اجارهٔ همین ماه که قبلاً ثبت شده».
 *
 * نامزدِ تکرار: همان جهت، همان مبلغ، همان دسته، و همان حساب پول یا همان طرف حساب —
 * در همان ماه برای هزینه و درآمدِ ماهانه (اجاره، حقوق، قبض، بیمه، اشتراک)، و در همان
 * روز برای بقیه. طرف حسابِ متفاوت یعنی دو رویداد جدا. هشدار است، نه منع: کاربر با
 * «تکراری نیست، ثبت کن» (`X-Allow-Duplicate`) رد می‌شود.
 */
import { normalizePersian } from '../shared/normalize.js';

export const MONTHLY_CATEGORIES = Object.freeze(new Set(['اجاره', 'حقوق و دستمزد', 'قبوض', 'بیمه', 'نرم‌افزار و اشتراک', 'درآمد اجاره']));

const partsIn = (iso, timeZone, options) => Object.fromEntries(new Intl.DateTimeFormat('en-CA-u-ca-persian', { timeZone, ...options })
  .formatToParts(new Date(iso)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
const monthKey = (iso, timeZone) => { const parts = partsIn(iso, timeZone, { year: 'numeric', month: '2-digit' }); return `${parts.year}-${parts.month}`; };
const dayKey = (iso, timeZone) => { const parts = partsIn(iso, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }); return `${parts.year}-${parts.month}-${parts.day}`; };
const valid = (iso) => iso && !Number.isNaN(Date.parse(iso));

/**
 * ثبت‌های موجودی که این قلم احتمالاً تکرارشان است.
 *
 * `item`: `{ amount, type, category, accountId, contactId, occurredAt }`؛ `excludeIds`
 * ردیف‌هایی که خودِ همین ثبت‌اند (مثلاً ردیفِ صف که حالا تأیید می‌شود).
 */
export function likelyDuplicates(database, item, { excludeIds = [], timeZone = 'Asia/Tehran', limit = 3 } = {}) {
  const amount = Math.round(Number(item?.amount));
  if (!Number.isSafeInteger(amount) || amount <= 0 || !['income', 'expense'].includes(item?.type)) return [];
  const category = String(item.category || '').trim();
  if (!category) return [];
  const occurredAt = valid(item.occurredAt) ? item.occurredAt : new Date().toISOString();
  const monthly = MONTHLY_CATEGORIES.has(category);
  const key = monthly ? monthKey(occurredAt, timeZone) : dayKey(occurredAt, timeZone);
  const sameWindow = (iso) => valid(iso) && (monthly ? monthKey(iso, timeZone) : dayKey(iso, timeZone)) === key;
  const excluded = new Set(excludeIds.filter(Boolean).map(String));
  let rows = [];
  try {
    rows = database.prepare(`SELECT id,amount,type,category,raw_text AS rawText,occurred_at AS occurredAt,account_id AS accountId,
      contact_id AS contactId,journal_deferred AS deferred FROM transactions
      WHERE status!='deleted' AND amount=? AND type=? AND ABS(julianday(occurred_at)-julianday(?))<=32
      ORDER BY occurred_at DESC LIMIT 40`).all(amount, item.type, occurredAt);
  } catch { return []; }
  const sameCategory = (row) => normalizePersian(String(row.category || '')) === normalizePersian(category);
  return rows.filter((row) => !excluded.has(String(row.id)) && sameCategory(row) && sameWindow(row.occurredAt)
    // طرف حسابِ متفاوت یعنی دو رویداد جدا؛ همان طرف حساب یا همان حساب پول یعنی نامزد.
    && !(item.contactId && row.contactId && String(item.contactId) !== String(row.contactId))
    && ((item.contactId && String(item.contactId) === String(row.contactId)) || (item.accountId && String(item.accountId) === String(row.accountId))))
    .slice(0, limit)
    .map((row) => ({ id: row.id, amount: row.amount, type: row.type, category: row.category, rawText: row.rawText, occurredAt: row.occurredAt,
      accountId: row.accountId, queued: Boolean(row.deferred), reason: monthly ? 'same-month' : 'same-day' }));
}

export function duplicateError(duplicates, message = 'یک ثبت با همین مبلغ و همین دسته در همین دوره هست؛ شاید این تکراری باشد.') {
  return Object.assign(new Error(message), {
    code: 'POSSIBLE_DUPLICATE', status: 409, requiresAction: true, details: { duplicates },
  });
}
