import { randomUUID } from 'node:crypto';
import { allWorkspaces, listUserWorkspaces } from './workspaces.js';
import { audit, controlDb, currentTimeZone, currentWorkspace, db, invalidInput, localDay, parseStoredJson, runInWorkspace, userIdentity } from './core.js';
import { buildFirmPortfolio, parseStoredMoment } from '../firm.js';
import { commercialStatus } from './commercial.js';
import { fourWeekWindows, pilotRetentionSummary } from '../collaboration.js';
import { monthWindowForWorkspace } from './collaboration.js';
import { normalizePersian } from '../../shared/parser.js';
import { periodForDate } from '../accounting.js';

export function savePilotCheckin(values = {}) {
  const weekStart = String(values.weekStart || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || Number.isNaN(new Date(`${weekStart}T00:00:00Z`).getTime())) throw invalidInput('تاریخ شروع هفته معتبر نیست.');
  const respondentType = values.respondentType === 'accountant' ? 'accountant' : 'owner';
  const savedMinutes = Math.min(10_000, Math.max(0, Math.round(Number(values.savedMinutes) || 0)));
  const errorCount = Math.min(10_000, Math.max(0, Math.round(Number(values.errorCount) || 0)));
  const willingnessToPay = ['yes', 'maybe', 'no', 'unknown'].includes(values.willingnessToPay) ? values.willingnessToPay : 'unknown';
  const planInterest = ['free', 'professional', 'accountant', 'none'].includes(values.planInterest) ? values.planInterest : 'none';
  const id = randomUUID();
  db.prepare(`INSERT INTO pilot_checkins (id,week_start,respondent_type,saved_minutes,error_count,friction,dropout_reason,
    willingness_to_pay,plan_interest,note,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(week_start,respondent_type) DO UPDATE SET saved_minutes=excluded.saved_minutes,error_count=excluded.error_count,
    friction=excluded.friction,dropout_reason=excluded.dropout_reason,willingness_to_pay=excluded.willingness_to_pay,
    plan_interest=excluded.plan_interest,note=excluded.note,created_by=excluded.created_by,updated_at=CURRENT_TIMESTAMP`)
    .run(id, weekStart, respondentType, savedMinutes, errorCount, String(values.friction || '').trim().slice(0, 1000),
      String(values.dropoutReason || '').trim().slice(0, 1000), willingnessToPay, planInterest,
      String(values.note || '').trim().slice(0, 1200), currentWorkspace()?.userId || null);
  audit('pilot-checkin', 'workspace', currentWorkspace()?.id || 'primary', { weekStart, respondentType, willingnessToPay, planInterest });
  return listPilotCheckins().find((item) => item.weekStart === weekStart && item.respondentType === respondentType);
}

export function listPilotCheckins() {
  return db.prepare(`SELECT id,week_start AS weekStart,respondent_type AS respondentType,saved_minutes AS savedMinutes,
    error_count AS errorCount,friction,dropout_reason AS dropoutReason,willingness_to_pay AS willingnessToPay,
    plan_interest AS planInterest,note,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt
    FROM pilot_checkins ORDER BY week_start DESC,respondent_type LIMIT 52`).all()
    .map((item) => ({ ...item, createdBy: userIdentity(item.createdBy) }));
}

export function pilotWorkspaceDashboard(now = new Date(), workspaceMeta = null) {
  const workspace = workspaceMeta || controlDb.prepare('SELECT id,name,created_at AS createdAt FROM workspaces WHERE id=?').get(currentWorkspace()?.id || 'primary');
  const weeks = fourWeekWindows(now).map((window) => {
    const transactions = Number(db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE status!='deleted' AND datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?)").get(window.from, window.toExclusive).count || 0);
    const receipts = Number(db.prepare('SELECT COUNT(*) AS count FROM receipts WHERE datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?)').get(window.from, window.toExclusive).count || 0);
    const voice = Number(db.prepare('SELECT COUNT(*) AS count FROM voice_metrics WHERE datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?)').get(window.from, window.toExclusive).count || 0);
    return { ...window, transactions, receipts, voice, activity: transactions + receipts + voice, active: transactions + receipts + voice > 0 };
  });
  const checkins = listPilotCheckins();
  const latestCheckin = checkins[0] || null;
  const ageDays = workspace?.createdAt ? Math.floor((now.getTime() - new Date(`${workspace.createdAt.replace(' ', 'T')}Z`).getTime()) / 86_400_000) : 0;
  return {
    workspace,
    weeks,
    activeWeeks: weeks.filter((item) => item.active).length,
    eligibleForWeekFour: ageDays >= 21,
    weekFourActive: ageDays >= 21 ? Boolean(weeks.at(-1)?.active) : false,
    willingnessToPay: latestCheckin?.willingnessToPay || 'unknown',
    savedMinutes: checkins.reduce((sum, item) => sum + Number(item.savedMinutes || 0), 0),
    reportedErrors: checkins.reduce((sum, item) => sum + Number(item.errorCount || 0), 0),
    latestFriction: latestCheckin?.friction || '',
    latestDropoutReason: latestCheckin?.dropoutReason || '',
    checkins,
  };
}

export function pilotPortfolio(now = new Date()) {
  const workspaces = allWorkspaces().map((workspace) => runInWorkspace(workspace.id, { role: 'owner' }, () => ({
    ...pilotWorkspaceDashboard(now, workspace), commercial: commercialStatus(workspace.id, now),
  })));
  return { generatedAt: now.toISOString(), summary: pilotRetentionSummary(workspaces), workspaces };
}

const FIRM_CACHE_TTL_MS = 5 * 60 * 1000;

// شمارش‌های سبک یک پرونده برای میز کار. عمداً از monthlyAccountantPackage استفاده
// نمی‌کند چون آن تابع کل تراکنش‌ها و رسیدها را می‌خواند و برای ۵۰ پرونده گران است.
function firmClientSnapshot(month = '', now = new Date()) {
  const range = monthWindowForWorkspace(month, now);
  const count = (sql, ...parameters) => Number(db.prepare(sql).get(...parameters)?.count || 0);

  const ledger = db.prepare(`SELECT COALESCE(SUM(journal_lines.debit),0) AS debit,COALESCE(SUM(journal_lines.credit),0) AS credit
    FROM journal_lines JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
    WHERE datetime(journal_entries.occurred_at)>=datetime(?) AND datetime(journal_entries.occurred_at)<datetime(?)`).get(range.from, range.toExclusive);

  const rangeStartDay = localDay(new Date(range.from), range.timeZone);
  const rangeEndDay = localDay(new Date(range.toExclusive), range.timeZone);
  const totals = db.prepare(`SELECT
      COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expense
    FROM transactions WHERE status!='deleted' AND datetime(occurred_at)>=datetime(?) AND datetime(occurred_at)<datetime(?)`).get(range.from, range.toExclusive);

  const lastBatch = db.prepare(`SELECT id,period,target_system AS targetSystem,status,row_count AS rowCount,
    created_at AS createdAt FROM accounting_transfer_batches ORDER BY created_at DESC LIMIT 1`).get() || null;

  return {
    month: range.period || range.month || null,
    available: true,
    counts: {
      // رسید تا وقتی به ثبت وصل یا صرف‌نظر نشده، مدرک معلق است.
      openReceipts: count("SELECT COUNT(*) AS count FROM receipts WHERE status NOT IN ('linked','ignored')"),
      unexplainedClosings: count(
        "SELECT COUNT(*) AS count FROM daily_closings WHERE day>=? AND day<? AND difference<>0 AND TRIM(COALESCE(note,''))=''",
        rangeStartDay, rangeEndDay,
      ),
      unmatchedBankLines: count("SELECT COUNT(*) AS count FROM bank_statement_lines WHERE status='unmatched'"),
      openRequests: count("SELECT COUNT(*) AS count FROM collaboration_requests WHERE status='open'"),
      answeredRequests: count("SELECT COUNT(*) AS count FROM collaboration_requests WHERE status='answered'"),
      unreviewedTransactions: count("SELECT COUNT(*) AS count FROM transactions WHERE needs_review=1 AND status!='deleted'"),
      // سند پیش‌نویس، در انتظار کنترل یا برگشتی در همان دوره.
      pendingApproval: count(
        "SELECT COUNT(*) AS count FROM journal_entries WHERE approval_state<>'approved' AND datetime(occurred_at)>=datetime(?) AND datetime(occurred_at)<datetime(?)",
        range.from, range.toExclusive,
      ),
      overdueObligations: count(
        "SELECT COUNT(*) AS count FROM obligations WHERE status='open' AND due_at IS NOT NULL AND datetime(due_at)<datetime(?)",
        now.toISOString(),
      ),
    },
    ledgerBalanced: Number(ledger?.debit || 0) === Number(ledger?.credit || 0),
    periodLocked: (db.prepare('SELECT status FROM accounting_periods WHERE period=?').get(range.period || '')?.status || 'open') === 'locked',
    lastActivityAt: db.prepare('SELECT MAX(created_at) AS createdAt FROM audit_log').get()?.createdAt || null,
    activity: {
      transactionCount: Number(totals?.count || 0),
      income: Number(totals?.income || 0),
      expense: Number(totals?.expense || 0),
      entryCount: count('SELECT COUNT(*) AS count FROM journal_entries WHERE datetime(occurred_at)>=datetime(?) AND datetime(occurred_at)<datetime(?)', range.from, range.toExclusive),
    },
    delivery: { lastBatch },
  };
}

function cachedFirmSnapshot(workspaceId, month, now, refresh) {
  const cached = controlDb.prepare('SELECT payload,computed_at AS computedAt FROM firm_client_cache WHERE workspace_id=? AND month=?')
    .get(workspaceId, month);
  if (!refresh && cached) {
    const computedAt = parseStoredMoment(cached.computedAt);
    const age = computedAt ? now.getTime() - computedAt.getTime() : Number.NaN;
    if (Number.isFinite(age) && age >= 0 && age < FIRM_CACHE_TTL_MS) {
      return { ...parseStoredJson(cached.payload, {}), cached: true, computedAt: cached.computedAt };
    }
  }
  const snapshot = runInWorkspace(workspaceId, { role: 'accountant' }, () => firmClientSnapshot(month, now));
  controlDb.prepare(`INSERT INTO firm_client_cache (workspace_id,month,payload,computed_at) VALUES (?,?,?,?)
    ON CONFLICT(workspace_id,month) DO UPDATE SET payload=excluded.payload,computed_at=excluded.computed_at`)
    .run(workspaceId, month, JSON.stringify(snapshot), now.toISOString());
  return { ...snapshot, cached: false, computedAt: now.toISOString() };
}

/**
 * میز کار دفتر حسابداری: وضعیت همهٔ پرونده‌هایی که همین کاربر عضو آن‌هاست.
 * پرونده‌ای که کاربر عضوش نیست هرگز وارد این خروجی نمی‌شود.
 */
export function firmPortfolio(userId, { month = '', refresh = false, now = new Date() } = {}) {
  const memberships = listUserWorkspaces(userId);
  const requested = normalizePersian(String(month || '').trim());
  const snapshots = memberships.map((workspace) => {
    const key = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested)
      ? requested
      : runInWorkspace(workspace.id, { role: 'accountant' }, () => periodForDate(now, currentTimeZone()));
    try {
      return { workspace, ...cachedFirmSnapshot(workspace.id, key, now, refresh), month: key };
    } catch (error) {
      // یک پروندهٔ خراب نباید کل میز کار را از کار بیندازد؛ ردیفش «نامشخص» می‌ماند.
      return { workspace, month: key, available: false, error: error.message };
    }
  });
  const portfolio = buildFirmPortfolio(snapshots, { now });
  return { generatedAt: now.toISOString(), ...portfolio };
}

export function invalidateFirmCache(workspaceId) {
  controlDb.prepare('DELETE FROM firm_client_cache WHERE workspace_id=?').run(String(workspaceId || ''));
}

export function workspaceOperationalSignals() {
  const quickCheck = db.prepare('PRAGMA quick_check').get();
  const lastRestore = db.prepare("SELECT created_at AS createdAt FROM audit_log WHERE action='restore' ORDER BY created_at DESC LIMIT 1").get();
  const lastActivity = db.prepare('SELECT MAX(created_at) AS createdAt FROM audit_log').get();
  const unresolvedRequests = Number(db.prepare("SELECT COUNT(*) AS count FROM collaboration_requests WHERE status!='resolved'").get().count || 0);
  return {
    database: { ok: Object.values(quickCheck || {}).includes('ok'), result: Object.values(quickCheck || {})[0] || 'unknown' },
    lastRestoreAt: lastRestore?.createdAt || null,
    lastActivityAt: lastActivity?.createdAt || null,
    unresolvedRequests,
  };
}
