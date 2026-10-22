// دوره‌های حسابداری: فهرست، قفل و بازگشایی.
//
// از server/accounting.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// accounting همه از همان server/accounting.js می‌خوانند.

import { accountingError, ensureAccountingSchema, periodForDate } from './ledgerAccounts.js';
import { trialBalance } from './journalBook.js';

export function accountingPeriods(database) {
  ensureAccountingSchema(database);
  return database.prepare(`SELECT period,status,locked_by AS lockedBy,locked_at AS lockedAt,reopened_by AS reopenedBy,
    reopened_at AS reopenedAt,reopen_reason AS reopenReason FROM accounting_periods ORDER BY period DESC`).all();
}

/**
 * اقلام شناسایی رویدادهای ثبت‌شده که تا پایان این دوره باید سند می‌خوردند و
 * هنوز نخورده‌اند — در همین دوره یا دوره‌های باز پیش از آن.
 *
 * تاریخ سند هر قلم، دیرترِ تاریخ قلم و تاریخ پرداخت است؛ همان قاعدهٔ اجرای
 * شناسایی. اینجا مستقیم خوانده می‌شود چون لایهٔ رویداد خودش به این فایل وابسته
 * است.
 */
function unpostedRecognitionThrough(database, period, timeZone = 'Asia/Tehran') {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recognition_schedule_items'").get();
  if (!exists) return [];
  const locked = new Set(database.prepare("SELECT period FROM accounting_periods WHERE status='locked'").all().map((row) => row.period));
  return database.prepare(`SELECT i.key,i.period_key AS periodKey,i.recognition_date AS recognitionDate,
      json_extract(e.payload,'$.occurredAt') AS occurredAt,
      EXISTS (SELECT 1 FROM financial_event_audit a WHERE a.event_id=i.event_id AND a.stage='recognition-held-balance'
        AND json_extract(a.detail,'$.key')=i.key) AS held
    FROM recognition_schedule_items i JOIN financial_events e ON e.id=i.event_id
    WHERE i.status='planned' AND e.status='posted' AND i.recognition_date IS NOT NULL`).all()
    .map((row) => {
      const floor = row.occurredAt && new Date(row.occurredAt) > new Date(row.recognitionDate) ? row.occurredAt : row.recognitionDate;
      return { ...row, period: periodForDate(floor, timeZone) };
    })
    .filter((row) => row.period <= period && !locked.has(row.period));
}

export function lockAccountingPeriod(database, period, userId) {
  ensureAccountingSchema(database);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period))) throw accountingError('دوره باید به شکل YYYY-MM باشد.');
  const balance = trialBalance(database);
  if (!balance.balanced) throw accountingError('دفتر کل نامتوازن است و دوره قابل بستن نیست.', 'TRIAL_BALANCE_UNBALANCED', 409);
  // دوره‌ای که شناسایی پیش‌پرداخت یا درآمد انتقالی‌اش هنوز سند نخورده، بسته
  // نمی‌شود: بستنش آن قلم‌ها را پشت دورهٔ بسته می‌گذاشت و هزینه یا درآمد همان
  // ماه بی‌صدا از سود و زیانش جا می‌ماند.
  const pending = unpostedRecognitionThrough(database, String(period));
  const unposted = pending.filter((row) => !row.held);
  if (unposted.length) {
    const months = [...new Set(unposted.map((row) => row.periodKey))].slice(0, 6).join('، ');
    throw Object.assign(accountingError(`${unposted.length} قلم شناسایی پیش‌پرداخت یا درآمد انتقالی (${months}) تا پایان این دوره هنوز سند نخورده؛ پیش از بستن، شناسایی ماهانه را اجرا کن.`, 'RECOGNITION_DUE_BEFORE_LOCK', 409), { details: { items: unposted.length } });
  }
  // قلمی که ماندهٔ حسابش کمتر از آن بود (استرداد بیرون از برنامه) با اجرای دوباره
  // ثبت نمی‌شود؛ پیام همان را می‌گوید تا حسابدار تکلیفش را روشن کند.
  if (pending.length) {
    const months = [...new Set(pending.map((row) => row.periodKey))].slice(0, 6).join('، ');
    throw Object.assign(accountingError(`${pending.length} قلم شناسایی (${months}) چون ماندهٔ حساب پیش‌پرداخت یا درآمد انتقالی از آن کمتر است نگه داشته شده؛ پیش از بستن، در صف حسابدار تکلیفشان را روشن کن.`, 'RECOGNITION_HELD_BEFORE_LOCK', 409), { details: { items: pending.length } });
  }
  database.prepare(`INSERT INTO accounting_periods (period,status,locked_by,locked_at) VALUES (?,'locked',?,CURRENT_TIMESTAMP)
    ON CONFLICT(period) DO UPDATE SET status='locked',locked_by=excluded.locked_by,locked_at=CURRENT_TIMESTAMP`).run(period, userId || null);
  return accountingPeriods(database).find((item) => item.period === period);
}

export function reopenAccountingPeriod(database, period, userId, reason) {
  ensureAccountingSchema(database);
  const cleanReason = String(reason || '').trim().slice(0, 500);
  if (cleanReason.length < 10) throw accountingError('دلیل بازگشایی را با حداقل ۱۰ نویسه ثبت کن.');
  const result = database.prepare(`UPDATE accounting_periods SET status='open',reopened_by=?,reopened_at=CURRENT_TIMESTAMP,reopen_reason=?
    WHERE period=? AND status='locked'`).run(userId || null, cleanReason, period);
  if (!result.changes) throw accountingError('دورهٔ بسته‌شده پیدا نشد.', 'ACCOUNTING_PERIOD_NOT_LOCKED', 404);
  return accountingPeriods(database).find((item) => item.period === period);
}
