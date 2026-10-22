// اجرای مقایسه‌ای (شادو): پیشنهاد مسیر تازه کنار ثبت واقعی، بی‌اثر بر دفتر.
//
// از server/financialEventStore.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از
// پوشهٔ financialEvents همه از همان financialEventStore.js می‌خوانند.

import { factsFromEvent } from '../../shared/eventFacts.js';
import { guardedPlan, runGuards } from '../../shared/guards.js';
import { compareProposalWithActual, summarizeDisagreements } from '../../shared/shadowReport.js';

// ---------------------------------------------------------------------------
// شادو مود — موتور نظر می‌دهد، دفتر دست نمی‌خورد
// ---------------------------------------------------------------------------

/**
 * جدول اجرای شادو.
 *
 * عمداً هیچ کلید خارجی‌ای به `financial_events` ندارد: ردیف شادو برای رویدادی
 * ساخته می‌شود که ممکن است اصلاً ثبت نشود. وابسته کردنش به رویداد یعنی همان
 * مواردی که بیشترین ارزش را دارند — آن‌هایی که موتور جلویشان را گرفته — اصلاً
 * ضبط نشوند.
 */
function ensureShadowSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shadow_runs (
      source_event_id TEXT PRIMARY KEY,
      occurred_at TEXT,
      amount INTEGER,
      family TEXT,
      treatment TEXT,
      policy_key TEXT,
      policy_version TEXT,
      decision_status TEXT,
      missing_facts TEXT NOT NULL DEFAULT '[]',
      question TEXT,
      guards TEXT NOT NULL DEFAULT '[]',
      facts TEXT NOT NULL DEFAULT '{}',
      proposed_plan TEXT,
      actual_plan TEXT,
      differences TEXT NOT NULL DEFAULT '[]',
      confidence REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * یک اجرای شادو را ثبت می‌کند و **هیچ سندی نمی‌زند**.
 *
 * شرط پذیرش این بسته یک جمله است: اجرای یک دستهٔ کامل، دفتر را بیت‌به‌بیت
 * دست‌نخورده می‌گذارد. برای همین این تابع عمداً هیچ‌جا `postJournalEntry` را
 * صدا نمی‌زند و هیچ ردیفی در `financial_events` نمی‌نویسد.
 *
 * `INSERT OR IGNORE` روی شناسهٔ منبع: اجرای دوبارهٔ همان دسته ردیف دوم نمی‌سازد،
 * وگرنه گزارش اختلاف همان رویداد را چند بار می‌شمارد و درصدها دروغ می‌گویند.
 */
export function recordShadowRun(database, { event, decision, confidence, sourceEventId, guards = null } = {}) {
  ensureShadowSchema(database);
  const source = String(sourceEventId || '').trim();
  if (!source || !event) return null;

  const facts = factsFromEvent(event);
  const guardResult = guards || runGuards(event, facts, { decision, openDocuments: undefined });
  let proposedPlan = null;
  // نقشهٔ پیشنهادی نباید بتواند کل ضبط را بشکند: رویدادی که قاعده‌ای ندارد هم
  // باید در گزارش دیده شود، چون «نتوانستم» خودش یک داده است.
  try { proposedPlan = guardedPlan(event, decision, guardResult); } catch { proposedPlan = null; }

  database.prepare(`INSERT OR IGNORE INTO shadow_runs
    (source_event_id,occurred_at,amount,family,treatment,policy_key,policy_version,decision_status,
     missing_facts,question,guards,facts,proposed_plan,confidence)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(source, event.occurredAt, event.amount,
      decision?.family || null, decision?.treatment || null, decision?.policyKey || null,
      decision?.policyVersion || null, decision?.decisionStatus || null,
      JSON.stringify(decision?.missingFacts || []),
      decision?.question ? JSON.stringify(decision.question) : null,
      JSON.stringify(guardResult?.checks || []),
      JSON.stringify(facts),
      proposedPlan ? JSON.stringify(proposedPlan) : null,
      Number(confidence?.score ?? null));

  return source;
}

/** ثبت واقعیِ حسابدار را کنار پیشنهاد موتور می‌نشاند و اختلافشان را حساب می‌کند. */
export function attachActualToShadowRun(database, sourceEventId, actualPlan) {
  ensureShadowSchema(database);
  const row = database.prepare('SELECT * FROM shadow_runs WHERE source_event_id=?').get(String(sourceEventId || ''));
  if (!row) return null;
  const proposed = row.proposed_plan ? JSON.parse(row.proposed_plan) : null;
  const differences = compareProposalWithActual(
    { plan: proposed, amount: row.amount },
    { plan: actualPlan, amount: actualPlan?.amount ?? row.amount },
  );
  database.prepare('UPDATE shadow_runs SET actual_plan=?,differences=? WHERE source_event_id=?')
    .run(JSON.stringify(actualPlan), JSON.stringify(differences), row.source_event_id);
  return differences;
}

/** همهٔ اجراهای شادو، برای گزارش اختلاف. */
export function shadowRuns(database, { limit = 500 } = {}) {
  ensureShadowSchema(database);
  return database.prepare('SELECT * FROM shadow_runs ORDER BY created_at DESC,rowid DESC LIMIT ?')
    .all(Math.max(1, Math.min(2000, Number(limit) || 500)))
    .map((row) => ({
      sourceEventId: row.source_event_id,
      occurredAt: row.occurred_at,
      amount: row.amount,
      family: row.family,
      treatment: row.treatment,
      policyKey: row.policy_key,
      policyVersion: row.policy_version,
      decisionStatus: row.decision_status,
      missingFacts: JSON.parse(row.missing_facts),
      question: row.question ? JSON.parse(row.question) : null,
      guards: JSON.parse(row.guards),
      facts: JSON.parse(row.facts),
      proposedPlan: row.proposed_plan ? JSON.parse(row.proposed_plan) : null,
      actualPlan: row.actual_plan ? JSON.parse(row.actual_plan) : null,
      differences: JSON.parse(row.differences),
      confidence: row.confidence,
      createdAt: row.created_at,
    }));
}

/** خلاصهٔ اختلاف، خانواده‌به‌خانواده — همان چیزی که تصمیم فعال‌سازی رویش سوار است. */
export function shadowDisagreementReport(database, options = {}) {
  return summarizeDisagreements(shadowRuns(database, options));
}
