// ردیف تراکنش: آورده و دارایی ثابت، وضعیت بررسی، JSON، سند و تسویهٔ هر ردیف، و خواندن و فهرست تراکنش‌ها.
//
// از server/db/transactions.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// transactions همه از همان server/db/transactions.js می‌خوانند.

import { counterpartyLedgerBalance } from '../counterpartyCard.js';
import { settlementDirection } from '../../../shared/counterpartySettlement.js';
import { currentWorkspace, db, parseStoredJson } from '../core.js';
import { syncTransactionJournal } from '../../accounting.js';
import { normalizeTopicLabel } from '../../chartOfAccounts.js';

export const CAPITAL_FLOWS = Object.freeze(['capital-in', 'fixed-asset']);

// دستهٔ این دو نوع ثبت، قرارداد بین ساخت و ویرایش است: از روی همین دسته
// می‌فهمیم سندش را چه کسی زده و عنوان دارایی چه بوده. اگر هر طرف رشتهٔ خودش
// را بنویسد، ویرایشِ یک دارایی ثابت حساب دوم می‌سازد.
export const CAPITAL_IN_CATEGORY = 'آورده و افزایش سرمایه';

export const FIXED_ASSET_CATEGORY_PREFIX = 'دارایی ثابت — ';

export const capitalEntryTitle = (row) => (row.capitalFlow === 'fixed-asset'
  ? String(row.category || '').slice(FIXED_ASSET_CATEGORY_PREFIX.length) || 'دارایی ثابت'
  : 'آوردهٔ مالک');

export function normalizeReviewState(value, fallback = 'ready') {
  return ['ready', 'review', 'unintelligible', 'reviewed', 'duplicate-confirmed'].includes(value) ? value : fallback;
}

export function jsonText(value, fallback) {
  try { return JSON.stringify(value ?? fallback); }
  catch { return JSON.stringify(fallback); }
}

/**
 * سندِ یک تراکنش، به همان شکل همیشگی‌اش.
 *
 * این تابع به لایهٔ رویداد تزریق می‌شود تا «چه وقت ثبت شود» را موتور اطمینان
 * تصمیم بگیرد ولی «سند چه شکلی باشد» همان‌جا بماند که هست و آزمون دارد.
 */
export function transactionJournalPoster(row, settlement = null) {
  return (database, payload = {}) => syncTransactionJournal(database, {
    ...row,
    // برچسب موضوعی ممکن است پس از ثبتِ رویداد و پیش از تأیید، از صف بررسی
    // تنظیم شده باشد (طرح ترکیبی). سند باید همان برچسبِ آخرِ رویداد را بگیرد،
    // نه برچسبِ لحظهٔ ثبت که خالی بوده است.
    topicLabel: normalizeTopicLabel(payload?.event?.topicLabel ?? row.topicLabel) || '',
  }, { createdBy: currentWorkspace()?.userId, settlement });
}

/**
 * آیا این جابه‌جایی پول، تسویهٔ حساب همان شخص است؟
 *
 * از ماندهٔ واقعی دفتر تصمیم گرفته می‌شود، نه از واژه‌های جمله: پول رفت و به
 * او بدهکار بودیم → بدهی‌اش کم می‌شود؛ پول آمد و او به ما بدهکار بود →
 * طلبمان کم می‌شود. هر حالت دیگری — از جمله پرداخت به کسی که حسابش صاف است —
 * همان ثبت عادیِ هزینه یا درآمد می‌ماند.
 */
export function settlementFor(row) {
  // «هیچ‌کدام» یعنی کاربر روی برگه دیده و گفته این ثبت هزینه یا درآمد عادی
  // است؛ حدس ما حق ندارد رویش بنویسد.
  if (row.settlement === 'none') return null;
  if (!row.contactId) return null;
  const contact = db.prepare('SELECT id,name FROM contacts WHERE id=?').get(row.contactId);
  if (!contact) return null;
  const balance = counterpartyLedgerBalance(contact);
  // جهت اعلام‌شدهٔ کاربر بر ماندهٔ دفتر مقدم است، ولی فقط وقتی با نوع ثبت
  // بخواند: «بابت بدهی او» فقط روی پرداخت معنا دارد و «بابت طلب او» فقط
  // روی دریافت.
  const askedFits = (row.settlement === 'payable' && row.type === 'expense')
    || (row.settlement === 'receivable' && row.type === 'income');
  const direction = askedFits ? row.settlement : settlementDirection(row.type, balance);
  if (!direction) return null;
  return { direction, contactId: contact.id, contactName: contact.name, balance };
}

export function hydrateTransaction(item) {
  if (!item) return null;
  return {
    ...item,
    needsReview: Boolean(item.needsReview),
    confidenceDetails: parseStoredJson(item.confidenceDetails, {}),
    reviewReasons: parseStoredJson(item.reviewReasons, []),
  };
}

function transactionQuery(includeDeleted = false) {
  return `SELECT transactions.id,transactions.client_id AS clientId,transactions.amount,transactions.type,transactions.category,
    transactions.raw_text AS rawText,transactions.source,transactions.confidence,transactions.needs_review AS needsReview,
    transactions.confidence_details AS confidenceDetails,transactions.review_reasons AS reviewReasons,
    transactions.review_state AS reviewState,transactions.restored_from AS restoredFrom,
    transactions.journal_deferred AS journalDeferred,transactions.topic_label AS topicLabel,
    transactions.occurred_at AS occurredAt,transactions.created_at AS createdAt,transactions.note,transactions.account,transactions.status,
    transactions.capital_flow AS capitalFlow, transactions.accounting_role AS accountingRole,
    transactions.account_id AS accountId,accounts.name AS accountName,
    transactions.contact_id AS contactId,contacts.name AS contactName,transactions.due_at AS dueAt
    FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id LEFT JOIN accounts ON accounts.id=transactions.account_id
    WHERE transactions.id=?${includeDeleted ? '' : " AND transactions.status!='deleted'"}`;
}

export function transactionRow(id) {
  return hydrateTransaction(db.prepare(transactionQuery(false)).get(id));
}

export function transactionAnyRow(id) {
  return hydrateTransaction(db.prepare(transactionQuery(true)).get(id));
}

export function getTransaction(id) {
  return transactionRow(id);
}

export function latestTransaction() {
  const row = db.prepare(`SELECT id FROM transactions WHERE status!='deleted' ORDER BY created_at DESC,rowid DESC LIMIT 1`).get();
  return row ? transactionRow(row.id) : null;
}

export function listTransactions({ query = '', type = '', category = '', from = '', to = '', page = 1, limit = 30 } = {}) {
  const clauses = ["transactions.status!='deleted'"];
  const values = [];
  if (query) {
    clauses.push('(transactions.raw_text LIKE ? OR transactions.note LIKE ? OR transactions.category LIKE ? OR contacts.name LIKE ?)');
    const pattern = `%${String(query).slice(0, 100)}%`;
    values.push(pattern, pattern, pattern, pattern);
  }
  if (['income', 'expense'].includes(type)) { clauses.push('transactions.type=?'); values.push(type); }
  if (category) { clauses.push('transactions.category=?'); values.push(String(category).slice(0, 80)); }
  if (from) { clauses.push('transactions.occurred_at>=?'); values.push(String(from)); }
  if (to) { clauses.push('transactions.occurred_at<=?'); values.push(String(to)); }
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  const safePage = Math.max(1, Number(page) || 1);
  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS count FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id WHERE ${where}`).get(...values).count;
  const items = db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,
    transactions.raw_text AS rawText,transactions.source,transactions.confidence,transactions.needs_review AS needsReview,
    transactions.confidence_details AS confidenceDetails,transactions.review_reasons AS reviewReasons,
    transactions.review_state AS reviewState,transactions.restored_from AS restoredFrom,
    transactions.journal_deferred AS journalDeferred,
    transactions.occurred_at AS occurredAt,transactions.note,transactions.account,transactions.status,
    transactions.account_id AS accountId,accounts.name AS accountName,
    transactions.contact_id AS contactId,contacts.name AS contactName
    FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id LEFT JOIN accounts ON accounts.id=transactions.account_id
    WHERE ${where} ORDER BY transactions.occurred_at DESC LIMIT ? OFFSET ?`)
    .all(...values, safeLimit, (safePage - 1) * safeLimit).map(hydrateTransaction);
  return { items, total, page: safePage, pages: Math.max(1, Math.ceil(total / safeLimit)) };
}
