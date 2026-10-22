// دفتر روزنامه: فهرست حساب‌ها، تراز آزمایشی، فهرست و کارتابل تأیید سند، سند دسته‌ای و اصلاحی.
//
// از server/accounting.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// accounting همه از همان server/accounting.js می‌خوانند.

import { randomUUID } from 'node:crypto';
import { APPROVAL_STATES, assertApprovalTransition, normalizeApprovalState, worklistSummary } from '../journalWorkflow.js';
import { accountingError, ensureAccountingSchema, periodForDate } from './ledgerAccounts.js';
import { validateLines, insertJournal, assertAccountingPeriodOpen } from './journalCore.js';
import { migrateAccountingLedger } from './ledgerSetup.js';

export function listLedgerAccounts(database) {
  migrateAccountingLedger(database);
  return database.prepare(`SELECT ledger_accounts.id,ledger_accounts.code,ledger_accounts.name,ledger_accounts.type,
    ledger_accounts.normal_side AS normalSide,ledger_accounts.active,
    ledger_accounts.source_kind AS sourceKind,ledger_accounts.source_key AS sourceKey,
    ledger_accounts.chart_account_id AS chartAccountId,chart_accounts.code AS chartCode,chart_accounts.name AS chartName
    FROM ledger_accounts LEFT JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    ORDER BY CAST(ledger_accounts.code AS INTEGER),ledger_accounts.name`).all();
}

export function trialBalance(database, through = '') {
  migrateAccountingLedger(database);
  const cutoff = through ? new Date(through) : null;
  if (cutoff && Number.isNaN(cutoff.getTime())) throw accountingError('تاریخ تراز معتبر نیست.');
  const cutoffClause = cutoff ? 'AND journal_entries.occurred_at<=?' : '';
  const params = cutoff ? [cutoff.toISOString()] : [];
  // پیش‌نویس، برگشتی و سند منتظر کنترل هنوز بخشی از دفاتر قطعی نیستند.
  // تجمیع در زیرپرس‌وجو باعث می‌شود حساب‌های بدون سند تأییدشده هم با مانده صفر باقی بمانند.
  const rows = database.prepare(`SELECT ledger_accounts.id,ledger_accounts.code,ledger_accounts.name,ledger_accounts.type,
    chart_accounts.code AS chartCode,chart_accounts.name AS chartName,
    COALESCE(approved_balances.debit,0) AS debit,COALESCE(approved_balances.credit,0) AS credit
    FROM ledger_accounts LEFT JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    LEFT JOIN (
      SELECT journal_lines.account_id AS accountId,
        SUM(journal_lines.debit) AS debit,SUM(journal_lines.credit) AS credit
      FROM journal_lines INNER JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
      WHERE journal_entries.approval_state='approved' ${cutoffClause}
      GROUP BY journal_lines.account_id
    ) AS approved_balances ON approved_balances.accountId=ledger_accounts.id
    ORDER BY CAST(ledger_accounts.code AS INTEGER),ledger_accounts.name`).all(...params)
    .map((row) => ({ ...row, debitBalance: Math.max(0, Number(row.debit) - Number(row.credit)), creditBalance: Math.max(0, Number(row.credit) - Number(row.debit)) }));
  const totals = rows.reduce((sum, row) => ({ debit: sum.debit + Number(row.debit), credit: sum.credit + Number(row.credit), debitBalance: sum.debitBalance + row.debitBalance, creditBalance: sum.creditBalance + row.creditBalance }), { debit: 0, credit: 0, debitBalance: 0, creditBalance: 0 });
  return { unit: 'IRT', basis: 'double-entry-operational', balanced: totals.debit === totals.credit && totals.debitBalance === totals.creditBalance, rows, totals, generatedAt: new Date().toISOString() };
}

export function listJournal(database, { page = 1, limit = 30, entryId = '', approvalState = '', search = '' } = {}) {
  migrateAccountingLedger(database);
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 30));
  const safePage = Math.max(1, Math.floor(Number(page)) || 1);
  const single = String(entryId || '').trim();
  const state = Object.hasOwn(APPROVAL_STATES, approvalState) ? approvalState : '';
  const clauses = state ? ['approval_state=?'] : [];
  const filterParams = state ? [state] : [];
  const query = String(search || '').trim().slice(0, 160).replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
  if (query) {
    clauses.push("(instr(memo,?)>0 OR CAST(document_number AS TEXT)=? OR source_id=?)");
    filterParams.push(query, query, query);
  }
  const filter = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const total = single
    ? Number(database.prepare('SELECT COUNT(*) AS count FROM journal_entries WHERE id=?').get(single).count)
    : Number(database.prepare(`SELECT COUNT(*) AS count FROM journal_entries ${filter}`).get(...filterParams).count);
  const select = `SELECT id,source_type AS sourceType,source_id AS sourceId,revision,entry_kind AS entryKind,
    occurred_at AS occurredAt,memo,reverses_entry_id AS reversesEntryId,created_at AS createdAt,created_by AS createdBy,
    document_number AS documentNumber,fiscal_year AS fiscalYear,approval_state AS approvalState,
    submitted_by AS submittedBy,submitted_at AS submittedAt,reviewed_by AS reviewedBy,reviewed_at AS reviewedAt,
    return_reason AS returnReason FROM journal_entries`;
  const entries = single
    ? database.prepare(`${select} WHERE id=?`).all(single)
    : database.prepare(`${select} ${filter} ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...filterParams, safeLimit, (safePage - 1) * safeLimit);
  const lines = database.prepare(`SELECT journal_lines.account_id AS accountId,ledger_accounts.code,ledger_accounts.name,
    journal_lines.debit,journal_lines.credit,journal_lines.description,
    chart_accounts.code AS chartCode,chart_accounts.name AS chartName,
    journal_lines.analytic_id AS analyticId,analytic_accounts.code AS analyticCode,analytic_accounts.name AS analyticName,
    journal_lines.cost_center_id AS costCenterId,cost_centers.code AS costCenterCode,cost_centers.name AS costCenterName
    FROM journal_lines
    JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
    LEFT JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    LEFT JOIN analytic_accounts ON analytic_accounts.id=journal_lines.analytic_id
    LEFT JOIN cost_centers ON cost_centers.id=journal_lines.cost_center_id
    WHERE journal_lines.entry_id=? ORDER BY journal_lines.rowid`);
  return {
    items: entries.map((entry) => ({
      ...entry,
      approvalState: normalizeApprovalState(entry.approvalState),
      approvalLabel: APPROVAL_STATES[normalizeApprovalState(entry.approvalState)].label,
      lines: lines.all(entry.id),
    })),
    total, page: safePage, pages: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

/**
 * کارتابل سند: چه چیزی پیش‌نویس است، چه چیزی منتظر کنترل و چه چیزی برگشت خورده.
 */
export function journalWorklist(database, { userId = '', limit = 50 } = {}) {
  ensureAccountingSchema(database);
  const entries = database.prepare(`SELECT id,document_number AS documentNumber,fiscal_year AS fiscalYear,
    occurred_at AS occurredAt,memo,approval_state AS approvalState,created_by AS createdBy,
    submitted_by AS submittedBy,submitted_at AS submittedAt,return_reason AS returnReason,
    (SELECT COALESCE(SUM(debit),0) FROM journal_lines WHERE entry_id=journal_entries.id) AS total
    FROM journal_entries WHERE approval_state<>'approved'
    ORDER BY CASE approval_state WHEN 'submitted' THEN 0 WHEN 'returned' THEN 1 ELSE 2 END,occurred_at DESC
    LIMIT ?`).all(Math.min(200, Math.max(1, Number(limit) || 50)))
    .map((item) => ({ ...item, approvalLabel: APPROVAL_STATES[normalizeApprovalState(item.approvalState)].label }));
  const all = database.prepare('SELECT approval_state AS approvalState,created_by AS createdBy FROM journal_entries').all();
  return { items: entries, summary: worklistSummary(all, { userId }), states: Object.values(APPROVAL_STATES) };
}

/**
 * وضعیت تأیید یک سند را جابه‌جا می‌کند و رد پای کامل نگه می‌دارد.
 * دورهٔ قفل‌شده هیچ تغییری نمی‌پذیرد، حتی تغییر وضعیت.
 */
export function setJournalApproval(database, entryId, nextState, { userId = null, reason = '', timeZone = 'Asia/Tehran', allowSelfApproval = false } = {}) {
  ensureAccountingSchema(database);
  const entry = database.prepare(`SELECT id,occurred_at AS occurredAt,approval_state AS approvalState,
    created_by AS createdBy,submitted_by AS submittedBy FROM journal_entries WHERE id=?`).get(String(entryId || ''));
  if (!entry) throw accountingError('سند پیدا نشد.', 'JOURNAL_ENTRY_NOT_FOUND', 404);
  assertAccountingPeriodOpen(database, periodForDate(entry.occurredAt, timeZone));

  const sameUser = Boolean(userId) && userId === (entry.submittedBy || entry.createdBy);
  const move = assertApprovalTransition(entry.approvalState, nextState, { reason, sameUser, allowSelfApproval });
  const cleanReason = String(reason || '').trim().slice(0, 500);

  if (move.to === 'submitted') {
    database.prepare("UPDATE journal_entries SET approval_state='submitted',submitted_by=?,submitted_at=CURRENT_TIMESTAMP,return_reason='' WHERE id=?").run(userId, entry.id);
  } else if (move.to === 'approved') {
    database.prepare("UPDATE journal_entries SET approval_state='approved',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,return_reason='' WHERE id=?").run(userId, entry.id);
  } else {
    database.prepare("UPDATE journal_entries SET approval_state='returned',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,return_reason=? WHERE id=?").run(userId, cleanReason, entry.id);
  }
  // خودتأییدی وقتی مجاز شمرده شده باشد باید در رد پا دیده شود، نه اینکه بی‌صدا بگذرد.
  const selfApproved = move.to === 'approved' && sameUser;
  return { ...move, selfApproved, entry: listJournal(database, { entryId: entry.id }).items[0] };
}

/**
 * ثبت انبوه: چند سند در یک تراکنش. یا همه ثبت می‌شوند یا هیچ‌کدام.
 * ثبت نیمه‌کاره برای کمک‌حسابداری که ۳۰۰ ردیف زده، بدترین حالت ممکن است.
 */
export function createJournalBatch(database, documents = [], { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const list = Array.isArray(documents) ? documents : [];
  if (!list.length) throw accountingError('هیچ سندی برای ثبت فرستاده نشد.', 'JOURNAL_BATCH_EMPTY');
  if (list.length > 200) throw accountingError('در هر بار حداکثر ۲۰۰ سند قابل ثبت است.', 'JOURNAL_BATCH_TOO_LARGE');

  const errors = [];
  const prepared = list.map((document, index) => {
    const position = index + 1;
    const occurredAt = document?.occurredAt || new Date().toISOString();
    if (Number.isNaN(new Date(occurredAt).getTime())) { errors.push({ position, message: 'تاریخ سند معتبر نیست.' }); return null; }
    try {
      assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
      // پیش از شروع تراکنش، هر سند جداگانه سنجیده می‌شود تا خطا با شمارهٔ سند برگردد.
      validateLines(database, document?.lines);
    } catch (error) { errors.push({ position, message: error.message, code: error.code }); return null; }
    return { occurredAt, memo: document?.memo || 'سند دستی', lines: document.lines };
  });
  if (errors.length) throw Object.assign(accountingError('ثبت انبوه انجام نشد؛ هیچ سندی ثبت نشده است.', 'JOURNAL_BATCH_INVALID'), { details: { errors } });

  database.exec('BEGIN IMMEDIATE');
  try {
    const created = prepared.map((document) => insertJournal(database, {
      sourceType: 'manual-batch', sourceId: randomUUID(), revision: 1, entryKind: 'adjustment',
      occurredAt: document.occurredAt, memo: document.memo, createdBy, timeZone,
      // سند دستی و انبوه همیشه از پیش‌نویس شروع می‌شود؛ وضعیت ارسالی کاربر قابل اعتماد نیست.
      approvalState: 'draft',
      lines: document.lines,
    }));
    database.exec('COMMIT');
    return {
      created: created.length,
      documentNumbers: created.map((item) => item.documentNumber),
      total: created.reduce((sum, item) => sum + item.total, 0),
      entryIds: created.map((item) => item.id),
    };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

export function createAdjustingJournal(database, values, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const occurredAt = values.occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
  const sourceId = randomUUID();
  const result = insertJournal(database, {
    sourceType: 'adjustment', sourceId, revision: 1, entryKind: 'adjustment', occurredAt,
    memo: values.memo || 'سند اصلاحی', createdBy, approvalState: 'draft', lines: values.lines,
  });
  // سند تازه با شناسهٔ خودش خوانده می‌شود، نه با «آخرین سند»؛ سند با تاریخ گذشته هم باید کامل برگردد.
  return listJournal(database, { entryId: result.id }).items[0] || { id: result.id };
}
