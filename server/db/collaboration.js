import { createHash, randomUUID } from 'node:crypto';
import { audit, controlDb, currentTimeZone, currentWorkspace, db, invalidInput, localDay, parseStoredJson, userIdentity, zonedMidnight } from './core.js';
import { hydrateReceipt, receiptSelect } from './receipts.js';
import { listObligations } from './obligations.js';
import { monthlyPackageChecklist } from '../collaboration.js';
import { normalizePersian } from '../../shared/parser.js';
import { periodForDate } from '../accounting.js';

function hydrateCollaborationRequest(row) {
  if (!row) return null;
  return {
    ...row,
    requestedBy: userIdentity(row.requestedBy),
    answeredBy: userIdentity(row.answeredBy),
    resolvedBy: userIdentity(row.resolvedBy),
  };
}

export function listCollaborationRequests({ status = '' } = {}) {
  const normalizedStatus = ['open', 'answered', 'resolved'].includes(status) ? status : '';
  const rows = normalizedStatus
    ? db.prepare(`SELECT id,entity_type AS entityType,entity_id AS entityId,question,answer,priority,status,
        requested_by AS requestedBy,answered_by AS answeredBy,resolved_by AS resolvedBy,
        created_at AS createdAt,answered_at AS answeredAt,resolved_at AS resolvedAt
        FROM collaboration_requests WHERE status=? ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END,created_at DESC`).all(normalizedStatus)
    : db.prepare(`SELECT id,entity_type AS entityType,entity_id AS entityId,question,answer,priority,status,
        requested_by AS requestedBy,answered_by AS answeredBy,resolved_by AS resolvedBy,
        created_at AS createdAt,answered_at AS answeredAt,resolved_at AS resolvedAt
        FROM collaboration_requests ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END,
        CASE priority WHEN 'urgent' THEN 0 ELSE 1 END,created_at DESC LIMIT 200`).all();
  return rows.map(hydrateCollaborationRequest);
}

function collaborationEntityExists(entityType, entityId) {
  if (entityType === 'general') return true;
  const tables = {
    transaction: 'transactions', receipt: 'receipts', closing: 'daily_closings',
    reconciliation: 'bank_statement_imports', obligation: 'obligations',
  };
  const table = tables[entityType];
  return Boolean(table && entityId && db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(entityId));
}

export function createCollaborationRequest(values = {}) {
  const entityType = ['general', 'transaction', 'receipt', 'closing', 'reconciliation', 'obligation'].includes(values.entityType) ? values.entityType : 'general';
  const entityId = entityType === 'general' ? null : String(values.entityId || '').trim().slice(0, 80);
  const question = String(values.question || '').trim().slice(0, 1200);
  const priority = values.priority === 'urgent' ? 'urgent' : 'normal';
  if (question.length < 5) throw invalidInput('درخواست توضیح باید حداقل پنج نویسه باشد.');
  if (!collaborationEntityExists(entityType, entityId)) throw Object.assign(new Error('منبع درخواست در همین دفتر پیدا نشد.'), { status: 404, code: 'COLLABORATION_ENTITY_NOT_FOUND' });
  const id = randomUUID();
  db.prepare(`INSERT INTO collaboration_requests (id,entity_type,entity_id,question,priority,requested_by)
    VALUES (?,?,?,?,?,?)`).run(id, entityType, entityId, question, priority, currentWorkspace()?.userId || null);
  audit('request-explanation', 'collaboration_request', id, { entityType, entityId, priority });
  return listCollaborationRequests().find((item) => item.id === id);
}

export function answerCollaborationRequest(id, answer) {
  const text = String(answer || '').trim().slice(0, 2000);
  if (text.length < 2) throw invalidInput('پاسخ را کامل وارد کن.');
  const result = db.prepare(`UPDATE collaboration_requests SET answer=?,status='answered',answered_by=?,answered_at=CURRENT_TIMESTAMP,
    resolved_by=NULL,resolved_at=NULL WHERE id=? AND status IN ('open','answered')`)
    .run(text, currentWorkspace()?.userId || null, id);
  if (!result.changes) return null;
  audit('answer', 'collaboration_request', id, {});
  return listCollaborationRequests().find((item) => item.id === id);
}

export function resolveCollaborationRequest(id) {
  const result = db.prepare(`UPDATE collaboration_requests SET status='resolved',resolved_by=?,resolved_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='answered'`).run(currentWorkspace()?.userId || null, id);
  if (!result.changes) return null;
  audit('resolve', 'collaboration_request', id, {});
  return listCollaborationRequests().find((item) => item.id === id);
}

export function monthWindowForWorkspace(month = '', now = new Date()) {
  const timeZone = currentTimeZone();
  const requested = normalizePersian(month);
  const currentPersianPeriod = periodForDate(now, timeZone);
  const token = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) ? requested : currentPersianPeriod;
  const [year, monthNumber] = token.split('-').map(Number);
  if (year < 1700) {
    let firstDay = null;
    let nextDay = null;
    let matched = false;
    // Persian year 1405 starts in Gregorian 2026. Beginning at January of
    // year + 621 keeps the whole requested Persian year inside this scan.
    const searchStart = new Date(Date.UTC(year + 621, 0, 1, 12));
    for (let offset = 0; offset < 500; offset += 1) {
      const candidate = new Date(searchStart.getTime() + offset * 86_400_000);
      const candidatePeriod = periodForDate(candidate, timeZone);
      if (candidatePeriod === token && !matched) {
        matched = true;
        firstDay = localDay(candidate, timeZone);
      } else if (matched && candidatePeriod !== token) {
        nextDay = localDay(candidate, timeZone);
        break;
      }
    }
    if (!firstDay || !nextDay) throw invalidInput('دورهٔ شمسی انتخاب‌شده قابل محاسبه نیست.');
    const start = zonedMidnight(firstDay, timeZone);
    const endExclusive = zonedMidnight(nextDay, timeZone);
    return {
      month: token, period: token, periodType: 'persian', from: start.toISOString(), toExclusive: endExclusive.toISOString(),
      to: new Date(endExclusive.getTime() - 1).toISOString(), timeZone,
    };
  }
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const start = zonedMidnight(`${token}-01`, timeZone);
  const endExclusive = zonedMidnight(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01`, timeZone);
  return { month: token, period: token, periodType: 'gregorian', from: start.toISOString(), toExclusive: endExclusive.toISOString(), to: new Date(endExclusive.getTime() - 1).toISOString(), timeZone };
}

function packageTransactions(range) {
  return db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,transactions.raw_text AS rawText,
    transactions.source,transactions.review_state AS reviewState,transactions.occurred_at AS occurredAt,
    transactions.account_id AS accountId,accounts.name AS accountName,transactions.contact_id AS contactId,contacts.name AS contactName,
    transactions.note FROM transactions LEFT JOIN accounts ON accounts.id=transactions.account_id
    LEFT JOIN contacts ON contacts.id=transactions.contact_id
    WHERE transactions.status!='deleted' AND transactions.occurred_at>=? AND transactions.occurred_at<?
    ORDER BY transactions.occurred_at`).all(range.from, range.toExclusive);
}

export function monthlyAccountantPackage(month = '', now = new Date()) {
  const range = monthWindowForWorkspace(month, now);
  const workspace = currentWorkspace();
  const workspaceMeta = controlDb.prepare('SELECT id,name,profile_type AS profileType FROM workspaces WHERE id=?').get(workspace?.id || 'primary');
  const transactions = packageTransactions(range);
  const incompleteReceipts = db.prepare(`${receiptSelect("WHERE receipts.status NOT IN ('linked','ignored')")} ORDER BY receipts.created_at`).all().map(hydrateReceipt);
  const rangeStartDay = localDay(new Date(range.from), range.timeZone);
  const rangeEndDay = localDay(new Date(range.toExclusive), range.timeZone);
  const closings = db.prepare(`SELECT id,day,expected_cash AS expectedCash,counted_cash AS countedCash,difference,note,created_at AS createdAt
    FROM daily_closings WHERE day>=? AND day<? ORDER BY day`).all(rangeStartDay, rangeEndDay);
  const closingDiscrepancies = closings.filter((item) => Number(item.difference) !== 0 && !String(item.note || '').trim());
  const reconciliationIssues = db.prepare(`SELECT bank_statement_imports.id,bank_statement_imports.file_name AS fileName,
    bank_statement_imports.period_start AS periodStart,bank_statement_imports.period_end AS periodEnd,bank_statement_imports.status,
    bank_statement_imports.created_at AS createdAt,COUNT(CASE WHEN bank_statement_lines.status='unmatched' THEN 1 END) AS unmatchedCount,
    COALESCE(SUM(CASE WHEN bank_statement_lines.status='unmatched' THEN bank_statement_lines.amount ELSE 0 END),0) AS unmatchedAmount
    FROM bank_statement_imports LEFT JOIN bank_statement_lines ON bank_statement_lines.import_id=bank_statement_imports.id
    GROUP BY bank_statement_imports.id HAVING bank_statement_imports.status='open' OR unmatchedCount>0
    ORDER BY bank_statement_imports.created_at`).all();
  const obligations = listObligations({ status: 'open' });
  const auditLog = db.prepare(`SELECT id,action,entity_type AS entityType,entity_id AS entityId,payload,created_at AS createdAt
    FROM audit_log WHERE created_at>=datetime(?) AND created_at<datetime(?) ORDER BY created_at`).all(range.from, range.toExclusive)
    .map((item) => ({ ...item, payload: parseStoredJson(item.payload, {}) }));
  const openRequests = [...listCollaborationRequests({ status: 'open' }), ...listCollaborationRequests({ status: 'answered' })];
  const sections = { transactions, incompleteReceipts, closings, closingDiscrepancies, reconciliationIssues, obligations, auditLog, openRequests };
  const checklist = monthlyPackageChecklist(sections);
  const summary = {
    transactionCount: transactions.length,
    income: transactions.filter((item) => item.type === 'income').reduce((sum, item) => sum + Number(item.amount), 0),
    expense: transactions.filter((item) => item.type === 'expense').reduce((sum, item) => sum + Number(item.amount), 0),
    incompleteReceipts: incompleteReceipts.length,
    unexplainedClosingDiscrepancies: closingDiscrepancies.length,
    reconciliationIssues: reconciliationIssues.length,
    openObligations: obligations.length,
    unansweredRequests: openRequests.filter((item) => item.status === 'open').length,
  };
  const payload = {
    format: 'hesab-yar-accountant-package', version: 1, generatedAt: now.toISOString(),
    workspace: workspaceMeta, scope: range, basis: 'cash', unit: 'تومان', summary, checklist, sections,
    disclaimer: 'این بسته برای تحویل و کنترل حسابدار است؛ جایگزین دفاتر قانونی، اظهارنامه یا فایل انتقال نرم‌افزار حسابداری رسمی نیست.',
  };
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { ...payload, manifest: { algorithm: 'sha256', digest, sourceIdsComplete: true, receiptImagesIncluded: false } };
}
