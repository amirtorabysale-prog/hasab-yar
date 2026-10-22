// سند استهلاک دارایی ثابت.
//
// از server/accounting.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// accounting همه از همان server/accounting.js می‌خوانند.

import { accountingError, ensureAccountingSchema, linkedLedgerAccount } from './ledgerAccounts.js';
import { nextRevision, insertJournal } from './journalCore.js';

/**
 * سند استهلاک یک ماه برای یک دارایی ثابت.
 *
 * بدهکار: هزینهٔ استهلاک (یک حساب مشترک، چون گزارش سود و زیان استهلاک را یکجا
 * می‌خواهد). بستانکار: استهلاک انباشتهٔ همان دارایی — حسابی جدا از خودِ دارایی،
 * چون بهای تمام‌شده باید دست‌نخورده بماند و انباشته کنارش دیده شود.
 *
 * `sourceId` ترکیب دارایی و ماه است تا دو بار ثبت یک ماه، در همان لایهٔ سند
 * قابل تشخیص باشد و نه فقط با کنترل بالادستی.
 */
export function postDepreciationJournal(database, entry, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const amount = Math.round(Number(entry.amount));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw accountingError('مبلغ استهلاک معتبر نیست.');
  const title = String(entry.title || '').trim().slice(0, 100);
  if (!title) throw accountingError('نام دارایی برای سند استهلاک لازم است.');
  const month = String(entry.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) throw accountingError('ماه استهلاک معتبر نیست.');

  const sourceId = `${entry.assetKey || title}:${month}`;
  const existing = database.prepare("SELECT id FROM journal_entries WHERE source_type='depreciation' AND source_id=? AND entry_kind='normal'").get(sourceId);
  if (existing) throw accountingError(`استهلاک «${title}» برای ${month} قبلاً ثبت شده است.`, 'DEPRECIATION_DUPLICATE', 409);

  const lines = [
    { accountId: linkedLedgerAccount(database, 'system', 'depreciation-expense', 'هزینهٔ استهلاک', 'expense'), debit: amount },
    {
      accountId: linkedLedgerAccount(database, 'accumulated-depreciation', entry.assetKey || title, `استهلاک انباشته — ${title}`, 'asset', 'credit'),
      credit: amount,
    },
  ];
  return insertJournal(database, {
    sourceType: 'depreciation', sourceId,
    revision: nextRevision(database, 'depreciation', sourceId), entryKind: 'normal',
    occurredAt: entry.occurredAt, memo: `استهلاک ${title} — ${month}`, createdBy, timeZone, lines,
  });
}

/** ماه‌هایی که برای یک دارایی سند استهلاک خورده‌اند. */
export function postedDepreciationMonths(database, assetKey) {
  ensureAccountingSchema(database);
  return database.prepare("SELECT source_id AS sourceId FROM journal_entries WHERE source_type='depreciation' AND entry_kind='normal' AND source_id LIKE ?")
    .all(`${assetKey}:%`)
    .map((row) => String(row.sourceId).slice(String(assetKey).length + 1));
}
