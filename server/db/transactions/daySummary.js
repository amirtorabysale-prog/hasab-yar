// خلاصهٔ امروز، مبلغ‌های معمول هر دسته و گزارش بازه.
//
// از server/db/transactions.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// transactions همه از همان server/db/transactions.js می‌خوانند.

import { addLocalDays, currentTimeZone, dayBounds, db, localDay } from '../core.js';
import { hydrateTransaction } from './rows.js';

export function getToday() {
  const today = localDay();
  const { start, endExclusive } = dayBounds(today);
  const transactions = db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,
    transactions.raw_text AS rawText,transactions.source,transactions.confidence,transactions.needs_review AS needsReview,
    transactions.confidence_details AS confidenceDetails,transactions.review_reasons AS reviewReasons,
    transactions.review_state AS reviewState,transactions.restored_from AS restoredFrom,
    transactions.journal_deferred AS journalDeferred,
    transactions.capital_flow AS capitalFlow, transactions.accounting_role AS accountingRole,
    transactions.occurred_at AS occurredAt,transactions.note,transactions.account,transactions.account_id AS accountId,
    accounts.name AS accountName,transactions.contact_id AS contactId,contacts.name AS contactName
    FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id LEFT JOIN accounts ON accounts.id=transactions.account_id
    WHERE transactions.occurred_at>=? AND transactions.occurred_at<? AND transactions.status!='deleted' AND transactions.journal_deferred=0
    ORDER BY transactions.occurred_at DESC,transactions.created_at DESC`).all(start, endExclusive).map(hydrateTransaction);
  const totals = summarize(transactions);
  const previousBounds = dayBounds(addLocalDays(today, -1));
  const previous = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income FROM transactions WHERE status!='deleted' AND journal_deferred=0 AND capital_flow='' AND accounting_role='' AND occurred_at>=? AND occurred_at<?").get(previousBounds.start, previousBounds.endExclusive).income;
  totals.comparison = previous > 0 ? Math.round(((totals.income - previous) / previous) * 100) : null;
  totals.ledger = ledgerDaySummary(start, endExclusive);
  return { transactions, summary: totals };
}

/**
 * سود و زیان همان روز از دفتر کل — کنار دریافت و پرداخت، نه به‌جای آن.
 *
 * کارت‌های امروز جریان پول‌اند: فروش ۱۱۰ با ارزش افزوده ۱۱۰ دریافت است، ولی
 * درآمد ۱۰۰؛ پیش‌پرداخت پرداخت است، نه هزینه؛ و درآمدِ تعیین تکلیف وجه
 * ناشناس اصلاً ردیف نقدی ندارد. بدون این، اختلاف دو تصویر دیده نمی‌شد.
 */
function ledgerDaySummary(start, endExclusive) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='journal_lines'").get();
  if (!exists) return null;
  const row = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN a.type='income' THEN l.credit-l.debit ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN a.type='expense' THEN l.debit-l.credit ELSE 0 END),0) AS expense
    FROM journal_lines l JOIN journal_entries j ON j.id=l.entry_id JOIN ledger_accounts a ON a.id=l.account_id
    WHERE j.approval_state='approved' AND j.occurred_at>=? AND j.occurred_at<?`).get(start, endExclusive);
  return { income: Number(row.income), expense: Number(row.expense), profit: Number(row.income) - Number(row.expense) };
}

export function summarize(items) {
  // آوردهٔ سرمایه درآمد نیست و خرید دارایی ثابت هزینهٔ دوره نیست؛ هر دو از صندوق
  // رد می‌شوند و در ماندهٔ حساب و کنترل پایان روز دیده می‌شوند، ولی اگر در این
  // جمع بیایند سود دوره را جعل می‌کنند.
  const operational = items.filter((item) => !item.capitalFlow && !item.accountingRole);
  const income = operational.filter((item) => item.type === 'income').reduce((sum, item) => sum + Number(item.amount), 0);
  const expense = operational.filter((item) => item.type === 'expense').reduce((sum, item) => sum + Number(item.amount), 0);
  const netCashFlow = income - expense;
  // profit برای سازگاری نسخهٔ قبلی نگه داشته شده و نباید با سود حسابداری اشتباه شود.
  return { income, expense, netCashFlow, profit: netCashFlow, comparison: null };
}

export function typicalAmounts() {
  const rows = db.prepare("SELECT type, AVG(amount) AS average FROM (SELECT type,amount FROM transactions WHERE status!='deleted' AND capital_flow='' AND accounting_role='' ORDER BY occurred_at DESC LIMIT 120) GROUP BY type").all();
  return Object.fromEntries(rows.map((row) => [row.type, Math.round(row.average)]));
}

export function report(range = 'month', now = new Date()) {
  const days = range === 'week' ? 7 : range === 'quarter' ? 90 : 30;
  const timeZone = currentTimeZone();
  const today = localDay(now, timeZone);
  const startDay = addLocalDays(today, -(days - 1));
  const start = dayBounds(startDay, timeZone).start;
  const endExclusive = dayBounds(addLocalDays(today, 1), timeZone).start;
  const items = db.prepare("SELECT amount,type,category,capital_flow AS capitalFlow,accounting_role AS accountingRole,occurred_at AS occurredAt FROM transactions WHERE status!='deleted' AND journal_deferred=0 AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at").all(start, endExclusive);
  const summary = summarize(items);
  const bucketCount = range === 'quarter' ? 12 : range === 'month' ? 10 : 7;
  const bucketDays = Math.ceil(days / bucketCount);
  const points = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const fromDay = addLocalDays(startDay, index * bucketDays);
    const untilDay = addLocalDays(startDay, Math.min(days, (index + 1) * bucketDays));
    const from = new Date(dayBounds(fromDay, timeZone).start);
    const until = new Date(dayBounds(untilDay, timeZone).start);
    const group = items.filter((item) => { const time = new Date(item.occurredAt); return time >= from && time < until; });
    const totals = summarize(group);
    points.push({ label: new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone, day: 'numeric', month: range === 'quarter' ? 'short' : undefined }).format(from), income: totals.income, expense: totals.expense });
  }
  const grouped = new Map();
  for (const item of items.filter(item=>!item.capitalFlow && !item.accountingRole)) {
    const key = `${item.type}:${item.category}`;
    grouped.set(key, { name: item.category, type: item.type, amount: (grouped.get(key)?.amount || 0) + Number(item.amount) });
  }
  const totalsByType = { income: Math.max(1, summary.income), expense: Math.max(1, summary.expense) };
  const categories = [...grouped.values()].sort((a, b) => b.amount - a.amount)
    .map((item) => ({ ...item, share: Math.round(item.amount / totalsByType[item.type] * 100) }));
  const biggestExpense = categories.find((item) => item.type === 'expense');
  const insight = biggestExpense ? `بیشترین هزینهٔ این بازه مربوط به «${biggestExpense.name}» و مبلغ آن ${new Intl.NumberFormat('fa-IR').format(biggestExpense.amount)} تومان بوده است.` : '';
  return { basis: 'cash', basisLabel: 'مبنای دریافت و پرداخت', summary, points, categories, insight };
}
