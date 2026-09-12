import { randomUUID } from 'node:crypto';
import { planJournal } from '../shared/accountingRules.js';
import { ROUTES } from '../shared/confidenceEngine.js';
import { ensureAccountingSchema, postJournalEntry, reverseJournalEntry } from './accounting.js';
import { resolveEventRole } from './roleResolver.js';

/**
 * دفتر رویدادهای مالی — یکتایی، ردیابی و صف بررسی.
 *
 * سه مسئولیت دارد و هیچ‌کدام تصمیم حسابداری نیست:
 *
 * ۱. **یکتایی.** یک ضبط صدا یا یک تراکنش نباید دو بار ثبت شود. کاربر دکمه را
 *    دوبار می‌زند، شبکه قطع می‌شود و درخواست تکرار می‌شود، صف آفلاین دوباره
 *    می‌فرستد — همه‌شان واقعی‌اند.
 *
 * ۲. **ردیابی.** برای هر تصمیم مالی باید بشود گفت از کدام گفته آمد، با چه
 *    اطمینانی، با کدام قاعده، چه سندی ساخت، چه کسی تأییدش کرد و بعداً چه بر
 *    سرش آمد. بدون این زنجیره، حسابرسی ممکن نیست.
 *
 * ۳. **صف بررسی.** رویدادی که اطمینانش کافی نیست یا مانع ساختاری دارد، به‌جای
 *    ثبت یا دورریختن، منتظر حسابدار می‌ماند.
 */

function storeError(message, code = 'EVENT_STORE_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function ensureFinancialEventSchema(database) {
  ensureAccountingSchema(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS financial_events (
      id TEXT PRIMARY KEY,
      -- شناسهٔ منبع: همان ضبط، همان تراکنش، همان ردیف ایمپورت.
      -- یکتایی اینجا تضمین می‌شود، نه با کنترل بالادستی که دور زدنی است.
      source_event_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0),
      occurred_at TEXT NOT NULL,
      due_at TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      confidence TEXT NOT NULL DEFAULT '{}',
      route TEXT NOT NULL CHECK(route IN ('auto','confirm','accountant-review')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','posted','reversed','rejected')),
      journal_entry_id TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_financial_events_status ON financial_events(status,route);
    CREATE TABLE IF NOT EXISTS financial_event_audit (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES financial_events(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      actor TEXT,
      detail TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_financial_event_audit_event ON financial_event_audit(event_id,created_at);
  `);
}

function writeAudit(database, eventId, stage, detail, actor) {
  database.prepare('INSERT INTO financial_event_audit (id,event_id,stage,actor,detail) VALUES (?,?,?,?,?)')
    .run(randomUUID(), eventId, stage, actor || null, JSON.stringify(detail ?? {}));
}

/**
 * رویداد را ثبت می‌کند و بر اساس مسیرش تصمیم می‌گیرد سند بخورد یا منتظر بماند.
 *
 * `sourceEventId` اجباری است. بدون آن هیچ تضمینی برای یکتایی نمی‌ماند و همان
 * گفته با هر بار ارسال دوباره ثبت می‌شود.
 */
export function recordFinancialEvent(database, event, {
  sourceEventId,
  decision,
  actor = null,
  transcript = '',
  rawInput = '',
  timeZone = 'Asia/Tehran',
} = {}) {
  ensureFinancialEventSchema(database);
  const source = String(sourceEventId || '').trim();
  if (!source) throw storeError('شناسهٔ منبع رویداد لازم است.', 'EVENT_SOURCE_MISSING');
  if (!event || !event.kind) throw storeError('رویداد مالی معتبر نیست.');
  if (!decision || !decision.route) throw storeError('تصمیم موتور اطمینان لازم است.', 'EVENT_DECISION_MISSING');

  const existing = database.prepare('SELECT * FROM financial_events WHERE source_event_id=?').get(source);
  // تکرار خطا نیست؛ همان نتیجهٔ قبلی برگردانده می‌شود تا فراخوان لازم نباشد
  // بین «شکست» و «قبلاً انجام شده» فرق بگذارد.
  if (existing) return { ...describeStored(database, existing), duplicate: true };

  const id = randomUUID();
  // نقشهٔ سند همین‌جا ساخته و ذخیره می‌شود، حتی وقتی قرار نیست همین حالا ثبت
  // شود: حسابرسی باید بداند در لحظهٔ تصمیم، قاعده چه گفته بود.
  const plan = planJournal(event);

  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO financial_events
      (id,source_event_id,kind,amount,occurred_at,due_at,payload,confidence,route,status,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, source, event.kind, event.amount, event.occurredAt, event.dueAt || null,
        JSON.stringify(event), JSON.stringify(decision), decision.route, 'pending', actor);

    writeAudit(database, id, 'captured', {
      rawInput: String(rawInput || '').slice(0, 1000),
      transcript: String(transcript || event.evidence || '').slice(0, 1000),
      event,
      confidence: decision,
      rule: plan.kind,
      journalPlan: plan,
    }, actor);

    let journalEntryId = null;
    if (decision.route === ROUTES.AUTO) {
      const posted = postEventJournal(database, id, event, plan, { actor, timeZone });
      journalEntryId = posted.id;
    }
    database.exec('COMMIT');
    return { id, sourceEventId: source, route: decision.route, status: journalEntryId ? 'posted' : 'pending', journalEntryId, plan, duplicate: false };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

/** نقشه را به سند تبدیل می‌کند؛ نقش‌ها اینجا به حساب واقعی نگاشت می‌شوند. */
function postEventJournal(database, eventId, event, plan, { actor = null, timeZone = 'Asia/Tehran' } = {}) {
  const lines = plan.lines.map((line) => ({
    accountId: resolveEventRole(database, line.role, line.key, event),
    debit: line.debit,
    credit: line.credit,
    description: plan.memoHint || null,
  }));
  const posted = postJournalEntry(database, {
    sourceType: 'financial-event',
    sourceId: eventId,
    occurredAt: event.occurredAt,
    memo: plan.memoHint || event.kind,
    lines,
  }, { createdBy: actor, timeZone });

  database.prepare("UPDATE financial_events SET status='posted',journal_entry_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(posted.id, eventId);
  writeAudit(database, eventId, 'posted', { journalEntryId: posted.id, documentNumber: posted.documentNumber, lines }, actor);
  return posted;
}

/** تأیید کاربر یا حسابدار روی رویدادی که منتظر مانده بود. */
export function approveFinancialEvent(database, eventId, { actor = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status === 'posted') return describeStored(database, row);
  if (row.status !== 'pending') throw storeError('این رویداد دیگر در انتظار تأیید نیست.', 'EVENT_NOT_PENDING', 409);

  const event = JSON.parse(row.payload);
  const plan = planJournal(event);
  database.exec('BEGIN IMMEDIATE');
  try {
    postEventJournal(database, row.id, event, plan, { actor, timeZone });
    writeAudit(database, row.id, 'approved', { by: actor }, actor);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
}

/**
 * برگشت یک رویداد ثبت‌شده.
 *
 * سند حذف نمی‌شود؛ سند معکوس می‌خورد و هر دو در تاریخچه می‌مانند. حذف، زنجیرهٔ
 * حسابرسی را پاک می‌کند و هیچ راهی برای بازسازی‌اش نمی‌ماند.
 */
export function reverseFinancialEvent(database, eventId, { actor = null, reason = '', timeZone = 'Asia/Tehran' } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status !== 'posted') throw storeError('فقط رویداد ثبت‌شده معکوس می‌شود.', 'EVENT_NOT_POSTED', 409);

  database.exec('BEGIN IMMEDIATE');
  try {
    const reversal = reverseJournalEntry(database, {
      sourceType: 'financial-event', sourceId: row.id,
      memo: reason ? `برگشت: ${reason}`.slice(0, 200) : 'برگشت رویداد مالی',
      createdBy: actor, timeZone,
    });
    database.prepare("UPDATE financial_events SET status='reversed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
    writeAudit(database, row.id, 'reversed', { reason: String(reason || '').slice(0, 300), reversalEntryId: reversal?.id || null }, actor);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
}

/** رد رویداد در صف بررسی، بدون ساختن سند. */
export function rejectFinancialEvent(database, eventId, { actor = null, reason = '' } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status !== 'pending') throw storeError('فقط رویداد در انتظار قابل رد است.', 'EVENT_NOT_PENDING', 409);
  database.prepare("UPDATE financial_events SET status='rejected',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
  writeAudit(database, row.id, 'rejected', { reason: String(reason || '').slice(0, 300) }, actor);
  return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
}

function describeStored(database, row) {
  return {
    id: row.id,
    sourceEventId: row.source_event_id,
    kind: row.kind,
    amount: row.amount,
    occurredAt: row.occurred_at,
    dueAt: row.due_at,
    route: row.route,
    status: row.status,
    journalEntryId: row.journal_entry_id,
    event: JSON.parse(row.payload),
    confidence: JSON.parse(row.confidence),
    createdAt: row.created_at,
  };
}

/** صف بررسی حسابدار: هرچه ثبت نشده و رد هم نشده. */
export function listReviewQueue(database, { limit = 50 } = {}) {
  ensureFinancialEventSchema(database);
  const rows = database.prepare(`SELECT * FROM financial_events
    WHERE status='pending' ORDER BY
      CASE route WHEN 'accountant-review' THEN 0 ELSE 1 END, created_at DESC
    LIMIT ?`).all(Math.max(1, Math.min(200, Number(limit) || 50)));
  return rows.map((row) => describeStored(database, row));
}

/** تاریخچهٔ کامل یک رویداد، از گفته تا برگشت. */
export function financialEventAudit(database, eventId) {
  ensureFinancialEventSchema(database);
  return database.prepare('SELECT stage,actor,detail,created_at AS createdAt FROM financial_event_audit WHERE event_id=? ORDER BY created_at,rowid')
    .all(String(eventId || ''))
    .map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
}
