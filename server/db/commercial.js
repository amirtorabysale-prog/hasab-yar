import { randomUUID } from 'node:crypto';
import { PLAN_CATALOG, billingMonth, estimateProviderCostMicrousd, normalizePlanId, quotaError, usageQuotaSnapshot } from '../collaboration.js';
import { controlDb, currentTimeZone, currentWorkspace, db, invalidInput } from './core.js';

export function workspacePlanRecord(workspaceId) {
  const id = String(workspaceId || 'primary');
  controlDb.prepare('INSERT OR IGNORE INTO workspace_plans (workspace_id,plan_id) VALUES (?,?)')
    .run(id, normalizePlanId(process.env.DEFAULT_WORKSPACE_PLAN));
  const row = controlDb.prepare(`SELECT workspace_id AS workspaceId,plan_id AS planId,
    provider_budget_microusd AS providerBudgetMicrousd,updated_at AS updatedAt
    FROM workspace_plans WHERE workspace_id=?`).get(id);
  return { ...row, planId: normalizePlanId(row?.planId) };
}

export function updateWorkspaceCommercialPlan(workspaceId, values = {}, updatedBy = '') {
  const planId = normalizePlanId(values.planId);
  const budgetUsd = Number(values.providerBudgetUsd);
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > 1_000_000) throw invalidInput('سقف بودجهٔ provider معتبر نیست.');
  const providerBudgetMicrousd = Math.round(budgetUsd * 1_000_000);
  controlDb.prepare(`INSERT INTO workspace_plans (workspace_id,plan_id,provider_budget_microusd,updated_by)
    VALUES (?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET plan_id=excluded.plan_id,
    provider_budget_microusd=excluded.provider_budget_microusd,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
    .run(workspaceId, planId, providerBudgetMicrousd, updatedBy || null);
  return workspacePlanRecord(workspaceId);
}

export function commercialStatus(workspaceId = currentWorkspace()?.id || 'primary', now = new Date()) {
  const planRecord = workspacePlanRecord(workspaceId);
  const range = billingMonth('', now, currentTimeZone());
  const usageRows = db.prepare(`SELECT capability,provider,status,SUM(request_count) AS requests,SUM(duration_ms) AS durationMs,
    SUM(COALESCE(estimated_cost_microusd,0)) AS estimatedCostMicrousd,
    SUM(CASE WHEN status='succeeded' AND capability!='realtime_session' AND estimated_cost_microusd IS NULL THEN 1 ELSE 0 END) AS unpriced
    FROM provider_usage WHERE datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?) GROUP BY capability,provider,status
    ORDER BY capability,provider,status`).all(range.from, range.toExclusive);
  // سهمیهٔ صدا بر «تلاش» شمرده می‌شود، نه بر تماس provider. یک ضبط می‌تواند هم
  // نشست realtime باز کند و هم فایل بفرستد؛ هزینهٔ ما دو تاست ولی کاربر یک بار
  // حرف زده. ردیف‌های قدیمی `attempt_id` ندارند و هرکدام یک تلاش شمرده می‌شوند،
  // یعنی مصرف گذشته بازنویسی نمی‌شود.
  const smartVoiceRequests = Number(db.prepare(`SELECT COUNT(DISTINCT COALESCE(attempt_id,id)) AS attempts
    FROM provider_usage WHERE status!='failed' AND capability IN ('server_voice','realtime_session')
      AND datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?)`).get(range.from, range.toExclusive)?.attempts || 0);
  const receiptOcrPages = usageRows.filter((item) => item.status !== 'failed' && item.capability === 'receipt_ocr')
    .reduce((sum, item) => sum + Number(item.requests || 0), 0);
  const members = Number(controlDb.prepare('SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id=?').get(workspaceId)?.count || 0);
  const transactionEntries = Number(db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE status!='deleted' AND datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?)").get(range.from, range.toExclusive)?.count || 0);
  const estimatedCostMicrousd = usageRows.reduce((sum, item) => sum + Number(item.estimatedCostMicrousd || 0), 0);
  const unpricedEvents = usageRows.reduce((sum, item) => sum + Number(item.unpriced || 0), 0);
  const budgetMicrousd = Number(planRecord.providerBudgetMicrousd || 0);
  const usage = { smartVoiceRequests, receiptOcrPages, members, transactionEntries };
  return {
    month: range.month,
    monthLabel: range.monthLabel,
    monthEndsAt: range.toExclusive,
    plan: PLAN_CATALOG[planRecord.planId],
    catalog: Object.values(PLAN_CATALOG),
    usage,
    quotas: usageQuotaSnapshot(planRecord.planId, usage),
    provider: {
      rows: usageRows,
      estimatedCostMicrousd,
      estimatedCostUsd: estimatedCostMicrousd / 1_000_000,
      pricingComplete: unpricedEvents === 0,
      unpricedEvents,
      budgetMicrousd,
      budgetUsd: budgetMicrousd / 1_000_000,
      budgetPercent: budgetMicrousd ? Math.min(100, Math.round((estimatedCostMicrousd / budgetMicrousd) * 100)) : null,
      overBudget: budgetMicrousd > 0 && estimatedCostMicrousd >= budgetMicrousd,
    },
    coreEntryAlwaysAvailable: true,
    coreEntryMessage: 'ثبت دستی و تایپ رایگان Chrome با پایان سهمیهٔ سرویس‌های هوشمند قطع نمی‌شود.',
  };
}

function quotaItemForCapability(status, capability) {
  const id = capability === 'receipt_ocr' ? 'receiptOcrPages' : 'smartVoiceRequests';
  return status.quotas.find((item) => item.id === id);
}

export function beginProviderUsage(capability, provider = 'unknown', { attemptId = '' } = {}) {
  if (!['server_voice', 'realtime_session', 'receipt_ocr'].includes(capability)) throw invalidInput('قابلیت provider معتبر نیست.');
  const status = commercialStatus();
  const quota = quotaItemForCapability(status, capability);
  if (quota?.exhausted) throw quotaError(quota);
  if (status.provider.overBudget) throw Object.assign(new Error('سقف بودجهٔ ماهانهٔ سرویس‌های هوشمند رسیده است؛ تایپ Chrome و ثبت دستی همچنان فعال است.'), {
    status: 402, code: 'PROVIDER_BUDGET_EXCEEDED', details: { provider: status.provider },
  });
  const id = randomUUID();
  db.prepare(`INSERT INTO provider_usage (id,capability,provider,status,request_count,attempt_id,created_by)
    VALUES (?,?,?,'started',1,?,?)`).run(id, capability, String(provider || 'unknown').slice(0, 40),
    String(attemptId || '').trim().slice(0, 80) || null, currentWorkspace()?.userId || null);
  return id;
}

export function finishProviderUsage(id, values = {}) {
  const current = db.prepare('SELECT id,capability,provider FROM provider_usage WHERE id=?').get(id);
  if (!current) return null;
  const provider = String(values.provider || current.provider || 'unknown').slice(0, 40);
  const status = values.succeeded === false ? 'failed' : 'succeeded';
  const durationMs = Math.max(0, Math.round(Number(values.durationMs) || 0));
  const estimatedCostMicrousd = status === 'failed' ? 0 : estimateProviderCostMicrousd({ capability: current.capability, provider, durationMs, requestCount: 1 });
  db.prepare(`UPDATE provider_usage SET provider=?,status=?,duration_ms=?,estimated_cost_microusd=?,error_code=?,completed_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(provider, status, durationMs, estimatedCostMicrousd, String(values.errorCode || '').slice(0, 80), id);
  return db.prepare('SELECT * FROM provider_usage WHERE id=?').get(id);
}

export function recordRealtimeProviderDuration(durationMs) {
  const normalized = Math.max(0, Math.round(Number(durationMs) || 0));
  if (!normalized) return null;
  const id = randomUUID();
  const estimatedCostMicrousd = estimateProviderCostMicrousd({ capability: 'realtime_duration', provider: 'openai', durationMs: normalized, requestCount: 0 });
  db.prepare(`INSERT INTO provider_usage (id,capability,provider,status,request_count,duration_ms,estimated_cost_microusd,created_by,completed_at)
    VALUES (?, 'realtime_duration','openai','succeeded',0,?,?,?,CURRENT_TIMESTAMP)`)
    .run(id, normalized, estimatedCostMicrousd, currentWorkspace()?.userId || null);
  return id;
}
