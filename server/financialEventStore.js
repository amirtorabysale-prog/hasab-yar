import { reviewNature, reviewNatureViolations } from '../shared/reviewNature.js';
import { matchingUnidentifiedHolding } from './unidentifiedReceipts.js';
import { ensureReviewIntakeSchema } from './reviewIntakeSchema.js';
import { randomUUID } from 'node:crypto';
import { ROLES, planJournal, treatmentHasPlan } from '../shared/accountingRules.js';
import { ROUTES } from '../shared/confidenceEngine.js';
import { SCHEDULE_ITEM_STATUS, buildMonthlySchedule } from '../shared/recognitionSchedule.js';
import { EVENT_KINDS, normalizeFinancialEvent } from '../shared/financialEvent.js';
import { DECISION_STATUS, decide } from '../shared/accountingDecision.js';
import { factsFromEvent } from '../shared/eventFacts.js';
import { applyAnswer } from '../shared/questionAnswer.js';
import { GUARD_VERDICTS, guardedPlan, isGuardPlan, runGuards } from '../shared/guards.js';
import { eventFingerprint } from '../shared/eventFingerprint.js';
import { compareProposalWithActual, summarizeDisagreements } from '../shared/shadowReport.js';
import { ensureAccountingSchema, periodForDate, postJournalEntry, reverseJournalEntry } from './accounting.js';
import { resolveEventAnalytic, resolveEventRole } from './roleResolver.js';

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
  ensureReviewIntakeSchema(database);
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
  // تصمیم حسابداری — ایستگاه تازه میان رویداد و سند.
  //
  // جدول جداست و نه چند ستون روی `financial_events`، چون تصمیم عمر خودش را
  // دارد: یک رویداد می‌تواند تصمیم اول بگیرد، سؤال بسازد، جواب بگیرد و تصمیم
  // دوم بگیرد. تصمیم ویرایش نمی‌شود؛ تصمیم تازه با ارجاع به قبلی ساخته می‌شود،
  // وگرنه تاریخچه دروغ می‌گوید.
  database.exec(`
    CREATE TABLE IF NOT EXISTS accounting_decisions (
      id TEXT PRIMARY KEY,
      event_id TEXT REFERENCES financial_events(id) ON DELETE CASCADE,
      supersedes TEXT,
      family TEXT NOT NULL,
      treatment TEXT,
      policy_key TEXT,
      policy_version TEXT,
      recognition_date TEXT,
      recognition_method TEXT,
      required_facts TEXT NOT NULL DEFAULT '[]',
      missing_facts TEXT NOT NULL DEFAULT '[]',
      assumptions TEXT NOT NULL DEFAULT '[]',
      risk_level TEXT NOT NULL,
      explanation TEXT,
      question TEXT,
      source_references TEXT NOT NULL DEFAULT '[]',
      decision_status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_accounting_decisions_event ON accounting_decisions(event_id,created_at);
  `);
  // برنامهٔ شناسایی — اقلامی که قرار است ماه‌به‌ماه از دارایی به هزینه بروند.
  //
  // `key` یکتاست و از شناسهٔ منبع و شناسهٔ دوره ساخته می‌شود، نه از شمارهٔ ردیف.
  // یکتایی اینجا در سطح دیتابیس تضمین می‌شود، نه با کنترل بالادستی که دور زدنی
  // است: اجرای دوبارهٔ برنامه برای یک ماه نباید سند دوم بسازد.
  database.exec(`
    CREATE TABLE IF NOT EXISTS recognition_schedule_items (
      key TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES financial_events(id) ON DELETE CASCADE,
      period_key TEXT NOT NULL,
      recognition_date TEXT,
      amount INTEGER NOT NULL CHECK(amount > 0),
      status TEXT NOT NULL DEFAULT 'planned'
        CHECK(status IN ('planned','posted','blocked-closed-period','superseded')),
      journal_entry_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_recognition_schedule_event ON recognition_schedule_items(event_id,period_key);
  `);
  // مهاجرت افزایشی: رویداد قدیمی هیچ‌کدام از این‌ها را ندارد و همان‌طور که بود
  // خوانده می‌شود. هیچ دادهٔ تاریخی بازطبقه‌بندی نمی‌شود.
  for (const column of ['decision_id TEXT', 'posting_plan TEXT', 'fingerprint TEXT']) {
    try { database.exec(`ALTER TABLE financial_events ADD COLUMN ${column}`); }
    catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
  }

  // لنگر سند باید تا لحظهٔ تأیید زنده بماند.
  //
  // بدون این، رویدادی که روی یک تراکنش نشسته و منتظر حسابدار مانده، هنگام تأیید
  // سندش را به نام خودِ رویداد می‌زند و `migrateAccountingLedger` که آن تراکنش را
  // همچنان بی‌سند می‌بیند، سند دومی می‌سازد.
  try { database.exec('ALTER TABLE financial_events ADD COLUMN journal_source TEXT'); }
  catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }

  // ترمیم یک‌باره برای هر اتصال: دفترهایی که پیش از بازنشستگی برنامه در لحظهٔ
  // برگشت ساخته شده‌اند، اقلام زندهٔ رویدادِ پس‌گرفته را هنوز دارند.
  if (!REPAIRED_DATABASES.has(database)) {
    REPAIRED_DATABASES.add(database);
    repairCancelledSchedules(database);
  }
}

const REPAIRED_DATABASES = new WeakSet();

/**
 * برنامهٔ شناسایی یک رویدادِ پس‌گرفته بازنشسته می‌شود.
 *
 * برنامه دنبالهٔ همان پرداخت یا دریافت است، نه چیزی مستقل از آن. وقتی پرداخت
 * برمی‌گردد — حذف تراکنش، «برگرداندن» آخرین ثبت، برگشت رویداد از پرونده، یا رد
 * در صف — دارایی پیش‌پرداخت (یا بدهی درآمد انتقالی) دیگر وجود ندارد:
 *
 * - قلمی که ثبت شده معکوس می‌شود، وگرنه هزینه (یا درآمد) پولی که برگشته در
 *   دفتر می‌ماند و حساب پیش‌پرداخت با ماندهٔ بستانکار — یا درآمد انتقالی با
 *   ماندهٔ بدهکار، یعنی «مستأجر به ما بدهکار است» — دیده می‌شود؛
 * - قلم برنامه‌ریزی‌شده یا منتظرِ دورهٔ بسته باطل می‌شود، وگرنه اجرای ماه بعد
 *   برای پولی که دیگر وجود ندارد هزینه می‌سازد و ثبت دوبارهٔ درستِ کاربر دو
 *   برابر شناسایی می‌شود.
 *
 * ردیف‌ها حذف نمی‌شوند و شناسهٔ سند قلم ثبت‌شده می‌ماند تا تاریخچه بگوید چه
 * شد. اگر ماهِ یک قلمِ ثبت‌شده بسته باشد، `reverseJournalEntry` خطا می‌دهد و کل
 * برگشت در همان تراکنش برمی‌گردد: برگشت نیمه‌کاره بدتر از رد صریح است.
 */
export function retireRecognitionSchedule(database, eventId, { actor = null, timeZone = 'Asia/Tehran', memo = 'برگشت شناسایی رویداد پس‌گرفته' } = {}) {
  const posted = database.prepare("SELECT key FROM recognition_schedule_items WHERE event_id=? AND status='posted' ORDER BY period_key").all(eventId);
  const reversalEntryIds = [];
  for (const item of posted) {
    // سندی که پیش‌تر معکوس شده دوباره معکوس نمی‌شود؛ فقط قلم علامت می‌خورد.
    const live = database.prepare(`SELECT 1 FROM journal_entries j WHERE source_type='recognition-schedule' AND source_id=?
      AND entry_kind='normal' AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=j.id)`).get(item.key);
    if (live) {
      const reversal = reverseJournalEntry(database, { sourceType: 'recognition-schedule', sourceId: item.key, memo, createdBy: actor, timeZone });
      if (reversal) reversalEntryIds.push(reversal.id);
    }
    database.prepare("UPDATE recognition_schedule_items SET status='superseded' WHERE key=?").run(item.key);
  }
  const superseded = database.prepare(`UPDATE recognition_schedule_items SET status='superseded'
    WHERE event_id=? AND status IN ('planned','blocked-closed-period')`).run(eventId).changes;
  if (posted.length || superseded) {
    writeAudit(database, eventId, 'schedule-retired', { reversedItems: posted.length, reversalEntryIds, supersededItems: superseded }, actor);
  }
  return { reversed: posted.length, superseded };
}

/**
 * ترمیم دفترهای قدیمی، یک بار برای هر اتصال.
 *
 * سه حالتی که پیش از بازنشستگی برنامه ساخته می‌شد:
 * ۱. اقلام زندهٔ رویداد ردشده یا معکوس‌شده — بی‌اثر در دفتر، ولی پنجرهٔ اجرای
 *    ماهانه را پر می‌کردند؛
 * ۲. قلمِ ثبت‌شدهٔ رویداد معکوس‌شده — هزینهٔ پولی که برگشته، در دفتر مانده؛
 * ۳. رویداد «ثبت‌شده»ای که سند تراکنشش با حذف تراکنش معکوس شده — یتیمی که
 *    برنامه‌اش هر ماه هزینه می‌ساخت و `reverseEvent` هم دیگر نمی‌توانست ببندد.
 *
 * هر رویداد در savepoint خودش: دورهٔ بسته‌ای که برگشت را رد کند فقط همان
 * رویداد را دست‌نخورده می‌گذارد، نه کل ترمیم را.
 */
export function repairCancelledSchedules(database) {
  database.prepare(`UPDATE recognition_schedule_items SET status='superseded'
    WHERE status IN ('planned','blocked-closed-period')
      AND event_id IN (SELECT id FROM financial_events WHERE status IN ('rejected','reversed'))`).run();
  const reversedWithPosted = database.prepare(`SELECT DISTINCT event_id AS id FROM recognition_schedule_items
    WHERE status='posted' AND event_id IN (SELECT id FROM financial_events WHERE status IN ('rejected','reversed'))`).all();
  const orphans = database.prepare(`SELECT id,journal_source AS journalSource FROM financial_events e
    WHERE status='posted' AND json_extract(journal_source,'$.type')='transaction'
      AND EXISTS (SELECT 1 FROM recognition_schedule_items i WHERE i.event_id=e.id AND i.status IN ('planned','posted','blocked-closed-period'))`).all()
    .filter((row) => {
      const anchor = JSON.parse(row.journalSource);
      const latest = database.prepare(`SELECT id FROM journal_entries WHERE source_type='transaction' AND source_id=?
        AND entry_kind='normal' ORDER BY revision DESC LIMIT 1`).get(String(anchor.id || ''));
      return latest && database.prepare('SELECT 1 FROM journal_entries WHERE reverses_entry_id=?').get(latest.id);
    });
  for (const { id, orphan } of [...reversedWithPosted, ...orphans.map((row) => ({ id: row.id, orphan: true }))]) {
    database.exec('SAVEPOINT repair_cancelled_schedule');
    try {
      retireRecognitionSchedule(database, id, { memo: 'ترمیم: برگشت شناسایی رویداد پس‌گرفته' });
      if (orphan) {
        database.prepare("UPDATE financial_events SET status='reversed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
        writeAudit(database, id, 'reversed', { reason: 'تراکنش پشت این رویداد پیش‌تر حذف شده بود؛ رویداد و برنامهٔ شناسایی‌اش هم بسته شدند.', repair: true }, null);
      }
      database.exec('RELEASE repair_cancelled_schedule');
    } catch {
      database.exec('ROLLBACK TO repair_cancelled_schedule');
      database.exec('RELEASE repair_cancelled_schedule');
    }
  }
}

/**
 * تصمیم را ذخیره می‌کند و شناسه‌اش را برمی‌گرداند.
 *
 * `null` برای رویدادی که تصمیمی همراهش نیامده — یعنی موتور نسخهٔ دو خاموش بوده.
 * در آن حالت هیچ ردیفی ساخته نمی‌شود و رفتار دقیقاً همان قبل است.
 */
function storeDecision(database, eventId, decision, supersedes = null) {
  if (!decision) return null;
  const id = randomUUID();
  database.prepare(`INSERT INTO accounting_decisions
    (id,event_id,supersedes,family,treatment,policy_key,policy_version,recognition_date,recognition_method,
     required_facts,missing_facts,assumptions,risk_level,explanation,question,source_references,decision_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, eventId, supersedes, decision.family, decision.treatment || null, decision.policyKey || null,
      decision.policyVersion || null, decision.recognitionDate || null, decision.recognitionMethod || null,
      JSON.stringify(decision.requiredFacts || []), JSON.stringify(decision.missingFacts || []),
      JSON.stringify(decision.assumptions || []), decision.riskLevel,
      decision.explanation || null, decision.question ? JSON.stringify(decision.question) : null,
      JSON.stringify(decision.sourceReferences || []), decision.decisionStatus);
  return id;
}

/**
 * برنامهٔ شناسایی را می‌سازد و ذخیره می‌کند.
 *
 * `INSERT OR IGNORE` عمدی است: اجرای دوباره همان کلیدها را می‌سازد و ردیف دوم
 * ساخته نمی‌شود. این تنها جایی است که idempotency واقعاً تضمین می‌شود، چون در
 * سطح دیتابیس است و هیچ مسیری نمی‌تواند دورش بزند.
 */
/**
 * مبلغی که پخش می‌شود: همان مبلغی که دارایی پیش‌پرداخت یا بدهی درآمد انتقالی
 * را ساخت، نه مبلغی که کاربر گفت.
 *
 * این دو فقط وقتی برابرند که نقشه دست نخورده باشد. نگهبان ارزش افزوده سطر
 * پیش‌پرداخت (یا درآمد انتقالی) را به خالص می‌برد و مالیات را به اعتبار یا بدهی
 * مالیاتی؛ پخش مبلغِ ناخالص یعنی مالیات یک بار دیگر هزینه یا درآمد می‌شد و
 * حساب پیش‌پرداخت در پایان دوره منفی می‌ماند.
 *
 * نقشه‌ای که سطر حامل ندارد — مثلاً نگهبان تسویه آن را به بستن بدهی برده —
 * دارایی یا بدهیِ دوره‌داری نساخته و برنامه‌ای هم ندارد. فراخوانی که نقشه
 * نمی‌دهد (دادهٔ قدیمی) همان مبلغ رویداد را می‌گیرد.
 */
function scheduleBase(plan, decision, event) {
  if (!plan) return event.amount;
  const deferred = decision?.treatment === 'deferred-revenue';
  const role = deferred ? ROLES.DEFERRED_REVENUE : ROLES.PREPAID_ASSET;
  return (plan.lines || []).filter((line) => line.role === role)
    .reduce((sum, line) => sum + (Number(deferred ? line.credit : line.debit) || 0), 0);
}

function storeSchedule(database, eventId, decision, event, { timeZone = 'Asia/Tehran', plan = null } = {}) {
  if (decision?.recognitionMethod !== 'monthly-straight-line') return 0;
  const items = buildMonthlySchedule({
    amount: scheduleBase(plan, decision, event),
    periodStart: event.servicePeriodStart,
    periodEnd: event.servicePeriodEnd,
    sourceId: eventId,
  });

  // برنامه که عوض شود، اقلام قدیمی **باطل** می‌شوند نه حذف.
  //
  // بدون این، قرارداد یک‌ساله‌ای که به شش ماه تغییر می‌کند شش قلم یتیم باقی
  // می‌گذارد که شش ماه هزینهٔ جعلی می‌سازند. و حذف‌کردنشان تاریخچه را پاک
  // می‌کند: هیچ‌کس نمی‌فهمد چرا برنامه عوض شد.
  //
  // قلمی که ثبت شده دست نمی‌خورد؛ آن سند در دفتر است و باطل‌کردن یک ردیف
  // برنامه، سند را برنمی‌گرداند.
  const keeping = new Set(items.map((item) => item.key));
  const existing = database.prepare("SELECT key,amount,status FROM recognition_schedule_items WHERE event_id=? AND status='planned'").all(eventId);
  const supersede = database.prepare("UPDATE recognition_schedule_items SET status='superseded' WHERE key=?");
  const reprice = database.prepare('UPDATE recognition_schedule_items SET amount=? WHERE key=?');
  for (const row of existing) {
    if (!keeping.has(row.key)) supersede.run(row.key);
  }
  // ماه‌هایی که می‌مانند ممکن است سهم تازه‌ای بگیرند: همان مبلغ روی دورهٔ
  // کوتاه‌تر پخش می‌شود.
  for (const item of items) {
    const row = existing.find((entry) => entry.key === item.key);
    if (row && row.amount !== item.amount) reprice.run(item.amount, item.key);
  }
  const insert = database.prepare(`INSERT OR IGNORE INTO recognition_schedule_items
    (key,event_id,period_key,recognition_date,amount,status) VALUES (?,?,?,?,?,?)`);
  // قلمی که در دورهٔ بسته می‌افتد ثبت نمی‌شود و علامت می‌خورد.
  //
  // تصمیم ۳ فاز صفر: نه به دورهٔ بعد منتقل می‌شود — که سود دوره را بدون تأیید
  // جابه‌جا می‌کند — و نه دورهٔ بسته را باز می‌کند. با دلیل روشن می‌ماند تا
  // حسابدار تصمیم بگیرد.
  const lockedPeriods = new Set(database.prepare("SELECT period FROM accounting_periods WHERE status='locked'")
    .all().map((row) => row.period));

  let written = 0;
  for (const item of items) {
    const blocked = item.recognitionDate && lockedPeriods.has(periodForDate(item.recognitionDate, timeZone));
    const status = blocked ? SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD : item.status;
    written += insert.run(item.key, eventId, item.periodKey, item.recognitionDate, item.amount, status).changes;
  }
  return written;
}

/** اقلام برنامهٔ شناسایی یک رویداد. */
export function scheduleForEvent(database, eventId) {
  ensureFinancialEventSchema(database);
  return database.prepare(`SELECT key,period_key AS periodKey,recognition_date AS recognitionDate,
    amount,status,journal_entry_id AS journalEntryId
    FROM recognition_schedule_items WHERE event_id=? ORDER BY period_key`).all(String(eventId || ''));
}

/** تصمیم جاری یک رویداد — آخرین تصمیمی که برایش گرفته شده. */
export function decisionForEvent(database, eventId) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM accounting_decisions WHERE event_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
    .get(String(eventId || ''));
  if (!row) return null;
  return {
    id: row.id,
    family: row.family,
    treatment: row.treatment,
    policyKey: row.policy_key,
    policyVersion: row.policy_version,
    recognitionDate: row.recognition_date,
    recognitionMethod: row.recognition_method,
    requiredFacts: JSON.parse(row.required_facts),
    missingFacts: JSON.parse(row.missing_facts),
    assumptions: JSON.parse(row.assumptions),
    riskLevel: row.risk_level,
    explanation: row.explanation,
    question: row.question ? JSON.parse(row.question) : null,
    sourceReferences: JSON.parse(row.source_references),
    decisionStatus: row.decision_status,
    createdAt: row.created_at,
  };
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
  // فراخوانی که خودش تراکنش باز کرده، نباید تراکنش تودرتو بسازد؛ SQLite آن را
  // نمی‌پذیرد و کل عملیات شکست می‌خورد.
  withinTransaction = false,
  // لنگر سند در دفتر.
  //
  // پیش‌فرض، خودِ رویداد است. ولی وقتی رویداد روی یک تراکنش موجود می‌نشیند، سند
  // باید به همان تراکنش لنگر بخورد: `migrateAccountingLedger` هر تراکنشِ بی‌سند
  // را خودش سند می‌زند و سندی که با منبع دیگری ثبت شده را نمی‌بیند. نتیجه‌اش سند
  // دوم و شناسایی دوبارهٔ درآمد است — دقیقاً همان چیزی که این معماری قرار بود
  // جلویش را بگیرد.
  journalSource = null,
  // چه کسی سند را می‌زند.
  //
  // پیش‌فرض، نقشهٔ نقش‌محورِ `shared/accountingRules.js` است. ولی رویدادی که
  // روی یک تراکنش نشسته، سندش شکل جاافتاده و آزموده‌شدهٔ خودش را دارد؛ عوض کردن
  // آن شکل کار این تغییر نیست. تصمیمِ «ثبت بشود یا نه» اینجا گرفته می‌شود،
  // «چطور ثبت بشود» همان‌جایی می‌ماند که بود.
  postJournal = null,
  // تصمیم موتور نسخهٔ دو، اگر روشن باشد.
  //
  // اختیاری است و نبودنش یعنی همان مسیر قبلی. وقتی هست، ذخیره می‌شود حتی اگر
  // اجازهٔ ثبت ندهد — چون همان دادهٔ خامی است که گزارش اختلاف فاز بعد لازم
  // دارد: موتور چه گفت و حسابدار چه کرد.
  accountingDecision = null,
  // اسناد باز طرف حساب، برای نگهبان تسویه.
  //
  // `undefined` یعنی بررسی ممکن نبود و `[]` یعنی بررسی شد و چیزی نبود. این دو
  // عمداً یکی نشده‌اند: امروز در transactionEvent هر دو بی‌صدا به هزینه می‌رسند
  // و بعداً نمی‌شود گفت نگهبان اصلاً اجرا شده یا نه.
  openDocuments = undefined,
  // نرخ‌های مشمول و ماندهٔ ارزش افزودهٔ دفتر، برای نگهبان ارزش افزوده.
  // نبودش یعنی بررسی ممکن نبود؛ نگهبان خودش می‌داند با آن چه کند.
  vat = undefined,
} = {}) {
  ensureFinancialEventSchema(database);
  const source = String(sourceEventId || '').trim();
  if (!source) throw storeError('شناسهٔ منبع رویداد لازم است.', 'EVENT_SOURCE_MISSING');
  if (!event || !event.kind) throw storeError('رویداد مالی معتبر نیست.');
  if (!decision || !decision.route) throw storeError('تصمیم موتور اطمینان لازم است.', 'EVENT_DECISION_MISSING');

  const fingerprint = eventFingerprint(event);

  const existing = database.prepare('SELECT * FROM financial_events WHERE source_event_id=?').get(source)
    // همان رویداد از کانال دیگر: شناسهٔ منبع فرق دارد ولی محتوا یکی است.
    //
    // رویداد ردشده یا معکوس‌شده از این کنترل بیرون است: کاربر آن ثبت را پس
    // گرفته و دوباره درستش را گفته؛ مسدود کردنش یعنی ثبت درست هیچ‌وقت وارد
    // نمی‌شود.
    // همان رویداد از کانال **دیگر**: شناسهٔ منبع فرق دارد ولی محتوا یکی است.
    //
    // شرط «کانال متفاوت» حیاتی است. دو پرداخت واقعاً یکسان در یک روز — دو بار
    // بنزین پانصد هزاری — محتوای یکسان دارند و هر دو درست‌اند؛ یکی‌کردنشان
    // ثبت درست کاربر را می‌خورد و او هیچ‌وقت نمی‌فهمد. آنچه واقعاً مشکوک است
    // همان فاکتوری است که یک بار گفته شده و یک بار عکسش فرستاده شده.
    //
    // رویداد ردشده یا معکوس‌شده هم از این کنترل بیرون است: کاربر آن ثبت را پس
    // گرفته و دوباره درستش را گفته.
    || (fingerprint && database.prepare(`SELECT * FROM financial_events
      WHERE fingerprint=? AND status IN ('pending','posted')
        AND COALESCE(json_extract(payload,'$.source'),'') <> ?`).get(fingerprint, event.source || ''));
  // تکرار خطا نیست؛ همان نتیجهٔ قبلی برگردانده می‌شود تا فراخوان لازم نباشد
  // بین «شکست» و «قبلاً انجام شده» فرق بگذارد.
  if (existing) return { ...describeStored(database, existing), duplicate: true };

  const id = randomUUID();
  // نقشهٔ سند همین‌جا ساخته و ذخیره می‌شود، حتی وقتی قرار نیست همین حالا ثبت
  // شود: حسابرسی باید بداند در لحظهٔ تصمیم، قاعده چه گفته بود.
  // نگهبان‌ها پس از تصمیم و پیش از قاعده. بدون تصمیم — یعنی موتور نسخهٔ دو
  // خاموش — اجرا نمی‌شوند و مسیر دقیقاً همان قبلی است.
  const guards = accountingDecision
    ? runGuards(event, factsFromEvent(event), { decision: accountingDecision, openDocuments, vat })
    : null;
  // مانعِ نگهبان به صف حسابدار می‌رود، با دلیلش — نه خطا.
  //
  // تا اینجا مانع یک خطای ۴۰۹ بود، و مسیر تراکنش هر خطای این لایه را «لایهٔ
  // رویداد نتوانست» می‌خواند و سند را از مسیر قدیمی می‌زد. یعنی درست همان
  // موردی که نگهبان گفته بود نباید ثبت شود، بی‌صدا ثبت می‌شد.
  const plan = guards ? guardedPlan(event, accountingDecision, guards) : planJournal(event, accountingDecision);
  const natureIssues=reviewNatureViolations(event.utterance || event.evidence || '',plan.lines,event);
  // همان پولی که پیش‌تر «ناشناس» نگه داشته شده، دریافت تازه نیست.
  const held = !reviewNature(event.utterance || event.evidence || '').unknownReceipt ? matchingUnidentifiedHolding(database, event) : null;
  const heldReason = held ? `این واریز با وجه ناشناس ${held.reference} (${Number(held.remaining).toLocaleString('fa-IR')} تومان، همین حساب) می‌خواند. اگر همان پول است، آن وجه را از صف «وجوه ناشناس» تعیین تکلیف کن و این مورد را رد کن.` : '';
  const blocked = natureIssues.length>0 || Boolean(held) || guards?.verdict === GUARD_VERDICTS.BLOCK || event.kind === EVENT_KINDS.REVIEW_PLACEHOLDER;
  const routing = blocked
    ? { ...decision, route: ROUTES.ACCOUNTANT_REVIEW, guardBlocked: true, reasons: [...new Set([...(decision.reasons || []), ...natureIssues.map(q=>q.text), ...(heldReason ? [heldReason] : []), guards?.reason || (heldReason ? '' : 'این گفته هنوز نقشهٔ سند قطعی ندارد.')].filter(Boolean))] }
    : decision;
  // The proposed plan is retained for audit even when semantic validation holds it.

  if (!withinTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO financial_events
      (id,source_event_id,kind,amount,occurred_at,due_at,payload,confidence,route,status,created_by,journal_source,posting_plan,fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, source, event.kind, event.amount, event.occurredAt, event.dueAt || null,
        JSON.stringify(event), JSON.stringify(routing), routing.route, 'pending', actor,
        journalSource ? JSON.stringify(journalSource) : null,
        // نقشه همین‌جا قفل می‌شود.
        //
        // تا امروز نقشه در تأیید دوباره با کدِ آن روز ساخته می‌شد. رویدادی که
        // دو هفته در صف مانده و در این فاصله قاعده‌ای عوض شده، سندی می‌خورد که
        // با آنچه به حسابدار نشان داده شده بود فرق دارد — و هیچ هشداری هم
        // نمی‌دهد. حالا آنچه در لحظهٔ تصمیم ساخته شد، همان ثبت می‌شود.
        JSON.stringify(plan), fingerprint);

    const decisionId = storeDecision(database, id, accountingDecision);
    if (decisionId) database.prepare('UPDATE financial_events SET decision_id=? WHERE id=?').run(decisionId, id);
    storeSchedule(database, id, accountingDecision, event, { plan, timeZone });

    writeAudit(database, id, 'captured', {
      rawInput: String(rawInput || '').slice(0, 10000),
      transcript: String(transcript || event.utterance || event.evidence || '').slice(0, 10000),
      event,
      confidence: routing,
      rule: plan.kind,
      journalPlan: plan,
      decision: accountingDecision || null,
      guards: guards?.checks || null,
      // آنچه نگهبان‌ها دیدند، نه فقط حکمشان: گزارش اختلاف باید بتواند بگوید
      // تفکیک با کدام نرخ و کدام مانده انجام شد.
      guardContext: guards ? { vat: vat ?? null, openDocumentCount: Array.isArray(openDocuments) ? openDocuments.length : null } : null,
    }, actor);

    let journalEntryId = null;
    if (routing.route === ROUTES.AUTO) {
      const posted = postPlanned(database, { id, event, plan, actor, timeZone, journalSource, postJournal, treatment: accountingDecision?.treatment });
      journalEntryId = posted?.id || null;
    }
    if (!withinTransaction) database.exec('COMMIT');
    return { id, sourceEventId: source, route: routing.route, status: journalEntryId ? 'posted' : 'pending', journalEntryId, decisionId, plan, guards: guards?.checks || null, duplicate: false };
  } catch (error) { if (!withinTransaction) database.exec('ROLLBACK'); throw error; }
}

/**
 * سند یک رویداد — با ثبت‌کنندهٔ تزریقی یا با نقشهٔ نقش‌محور.
 *
 * نقشه‌ای که نگهبان بازنویسی کرده هرگز به ثبت‌کنندهٔ تزریقی نمی‌رود. آن
 * ثبت‌کننده سند جاافتادهٔ تراکنش را می‌زند که فقط هزینه و درآمد می‌شناسد و
 * نقشه را اصلاً نمی‌خواند: فروش با ارزش افزوده دوباره کل مبلغ را درآمد می‌کرد،
 * درحالی‌که ردپا می‌گفت تفکیک شده. لنگر همان تراکنش می‌ماند تا ویرایش و
 * برگشت، سند را پیدا کنند.
 */
function postPlanned(database, { id, event, plan, actor, timeZone, journalSource, postJournal, treatment = null }) {
  const natureIssues=reviewNatureViolations(event.utterance || event.evidence || '',plan.lines,event);
  if(natureIssues.length) throw storeError(natureIssues.map(q=>q.text).join(' '),'REVIEW_NATURE_REQUIRED',409);
  // ثبت‌کنندهٔ تزریقیِ تراکنش فقط هزینه و درآمد می‌شناسد. برخوردی که نقشهٔ
  // خودش را دارد — پیش‌پرداخت، پیش‌دریافت — نباید در تأیید فوری یا ثبت خودکار
  // بی‌صدا هزینهٔ همان ماه شود؛ تأیید از صف این را از قبل رعایت می‌کرد.
  if (postJournal && !isGuardPlan(plan) && !treatmentHasPlan(treatment)) {
    const posted = postJournal(database, { event, plan, eventId: id, actor, timeZone });
    // مسیر تزریقی وضعیت و ردپا را خودش نمی‌نویسد؛ ردپا نباید به انتخاب
    // ثبت‌کننده وابسته باشد.
    if (posted?.id) markEventPosted(database, id, posted, plan.lines, actor);
    return posted;
  }
  return postEventJournal(database, id, event, plan, { actor, timeZone, journalSource });
}

/** نقشه را به سند تبدیل می‌کند؛ نقش‌ها اینجا به حساب واقعی نگاشت می‌شوند. */
function postEventJournal(database, eventId, event, plan, { actor = null, timeZone = 'Asia/Tehran', journalSource = null } = {}) {
  const lines = plan.lines.map((line) => ({
    accountId: resolveEventRole(database, line.role, line.key, event),
    // تفصیلی همان‌جا به سطر می‌چسبد، چون فقط اینجا می‌دانیم این سطر مال کدام
    // نقش است. بدون آن، طرف حساب در فایل انتقال گم می‌شود.
    analyticId: resolveEventAnalytic(database, line.role, event, line.key),
    debit: line.debit,
    credit: line.credit,
    description: plan.memoHint || null,
  }));
  const posted = postJournalEntry(database, {
    sourceType: journalSource?.type || 'financial-event',
    sourceId: journalSource?.id || eventId,
    occurredAt: event.occurredAt,
    memo: plan.memoHint || event.kind,
    lines,
  }, { createdBy: actor, timeZone });

  markEventPosted(database, eventId, posted, lines, actor);
  markTransactionAccountingRole(database, journalSource, plan.lines);
  return posted;
}

/**
 * ردیف نقدیِ پشت یک سند تخصصی، در جمع درآمد و هزینه نمی‌آید.
 *
 * وام، ودیعه، پیش‌پرداخت، پیش‌دریافت و آورده پول جابه‌جا می‌کنند ولی سود و
 * زیان نیستند. مسیر بررسی حسابدار همین علامت را می‌زند؛ موتور هم باید بزند،
 * وگرنه دویست میلیون وام در داشبورد «درآمد این ماه» دیده می‌شد.
 */
//
// فقط تأمین مالی: وام، واریز ناشناس و برداشت مالک (آورده با `capital_flow`).
// پیش‌پرداخت، ودیعه و خرید کالا پرداخت نقدی‌اند و در کارت «پرداخت امروز»
// می‌مانند؛ دفتر کل جداگانه نشان می‌دهد که هزینه نیستند.
const SPECIAL_COUNTERPART_ROLES = new Set(['loan-payable', 'unidentified-receipt', 'owner-drawing']);
function markTransactionAccountingRole(database, journalSource, planLines = []) {
  if (journalSource?.type !== 'transaction' || planLines.length !== 2) return;
  const counterpart = planLines.find((line) => line.role !== 'cash');
  if (!counterpart || !planLines.some((line) => line.role === 'cash')) return;
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transactions'").get()) return;
  if (counterpart.role === 'owner-capital') {
    database.prepare("UPDATE transactions SET capital_flow='capital-in' WHERE id=?").run(journalSource.id);
  } else if (SPECIAL_COUNTERPART_ROLES.has(counterpart.role)) {
    database.prepare('UPDATE transactions SET accounting_role=? WHERE id=?').run(counterpart.role, journalSource.id);
  }
}

/** وضعیت «ثبت شد» و ردپایش — مستقل از اینکه کدام لایه سند را زده است. */
function markEventPosted(database, eventId, posted, lines, actor) {
  database.prepare("UPDATE financial_events SET status='posted',journal_entry_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(posted.id, eventId);
  writeAudit(database, eventId, 'posted', { journalEntryId: posted.id, documentNumber: posted.documentNumber, lines }, actor);
}

/**
 * جواب کاربر به سؤال یک رویداد منتظر.
 *
 * چهار کار پشت سر هم، همه در یک تراکنش:
 *
 * ۱. جواب به واقعیت تبدیل و روی رویداد نشانده می‌شود؛
 * ۲. تصمیم دوباره گرفته می‌شود — تصمیم قبلی ویرایش نمی‌شود، تصمیم تازه با
 *    ارجاع به آن ساخته می‌شود تا تاریخچه دروغ نگوید؛
 * ۳. نقشهٔ سند با تصمیم تازه دوباره قفل می‌شود، چون ماهیت عوض شده؛
 * ۴. اگر تصمیم تازه برنامهٔ شناسایی بخواهد، ساخته می‌شود.
 *
 * سند اینجا ثبت **نمی‌شود**. جواب دادن یعنی ابهام برطرف شد، نه اینکه کاربر
 * تأیید کرد. ثبت همچنان کار `approveFinancialEvent` است.
 */
export function answerEventQuestion(database, eventId, { fact, value, freeText = '', actor = null, today = null, guardContext = {}, capitalizationThreshold = null } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status !== 'pending') throw storeError('این رویداد دیگر در انتظار نیست.', 'EVENT_NOT_PENDING', 409);

  const previous = decisionForEvent(database, row.id);
  const stored = JSON.parse(row.payload);
  const reference = today || stored.occurredAt;
  const patch = applyAnswer(stored, { fact, value, freeText }, { today: reference });
  const event = normalizeFinancialEvent({ ...stored, ...patch });
  const decision = decide(factsFromEvent(event), { today: reference, capitalizationThreshold });
  // نگهبان‌ها دوباره، چون ماهیت عوض شده. بدون این، جواب دادن به سؤال دورهٔ
  // پوشش نقشهٔ تفکیک ارزش افزوده را با نقشهٔ سادهٔ قاعده عوض می‌کرد و کل مبلغ
  // دوباره به سود و زیان می‌رفت — بی‌آنکه نگهبانی دوباره نگاه کند.
  const guards = runGuards(event, factsFromEvent(event), { ...guardContext, decision });
  const plan = guardedPlan(event, decision, guards);
  const blocked = guards.verdict === GUARD_VERDICTS.BLOCK;
  // جوابی که ماهیت را روشن کرد ولی ثبتش قضاوت می‌خواهد — دارایی ثابت، موجودی —
  // جایش صف حسابدار است. بدون این، رویداد در «تأیید کاربر» می‌ماند و تأییدش
  // هم رد می‌شد: کاربر گیر می‌کرد بی‌آنکه بداند منتظر چه کسی است.
  const forAccountant = ![DECISION_STATUS.DECIDED, DECISION_STATUS.NEEDS_USER_INPUT].includes(decision.decisionStatus);

  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('UPDATE financial_events SET payload=?,posting_plan=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(JSON.stringify(event), JSON.stringify(plan), row.id);
    if (blocked) {
      const confidence = JSON.parse(row.confidence);
      const routing = { ...confidence, route: ROUTES.ACCOUNTANT_REVIEW, guardBlocked: true, reasons: [...new Set([...(confidence.reasons || []), guards.reason])] };
      database.prepare('UPDATE financial_events SET route=?,confidence=? WHERE id=?').run(routing.route, JSON.stringify(routing), row.id);
    } else if (forAccountant) {
      const confidence = JSON.parse(row.confidence);
      const routing = { ...confidence, route: ROUTES.ACCOUNTANT_REVIEW, reasons: [...new Set([...(confidence.reasons || []), decision.explanation].filter(Boolean))] };
      database.prepare('UPDATE financial_events SET route=?,confidence=? WHERE id=?').run(routing.route, JSON.stringify(routing), row.id);
    }
    const decisionId = storeDecision(database, row.id, decision, previous?.id || null);
    database.prepare('UPDATE financial_events SET decision_id=? WHERE id=?').run(decisionId, row.id);
    storeSchedule(database, row.id, decision, event, { plan });
    writeAudit(database, row.id, 'answered', { fact, value, freeText, patch, decision, guards: guards.checks }, actor);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }

  return { ...describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id)), decision };
}

/** تأیید کاربر یا حسابدار روی رویدادی که منتظر مانده بود. */
export function approveFinancialEvent(database, eventId, { actor = null, timeZone = 'Asia/Tehran', postJournal = null, overrideReason = '', withinTransaction = false } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status === 'posted') return describeStored(database, row);
  if (row.status !== 'pending') throw storeError('این رویداد دیگر در انتظار تأیید نیست.', 'EVENT_NOT_PENDING', 409);

  // نوشتن دلیل جایگزین اصلاح سند نیست. در مورد مبهم یا مسدود، نقشهٔ قفل‌شده
  // همچنان می‌تواند سند قدیمیِ درآمد/هزینه باشد؛ حتی حسابدار نباید آن را با
  // یک توضیح متنی بدون تعیین دوبارهٔ حساب‌ها تأیید کند.
  const decision = decisionForEvent(database, row.id);
  const undecided = decision && decision.decisionStatus !== DECISION_STATUS.DECIDED;
  const lockedPlan = row.posting_plan ? JSON.parse(row.posting_plan) : null;
  // صف حسابدارِ مسیر قدیمی — اطمینان پایین، بدون موتور تصمیم — همان رفتار
  // همیشگی را دارد؛ فقط مانعِ نگهبان override حساب می‌شود.
  const heldForAccountant = row.route === ROUTES.ACCOUNTANT_REVIEW && JSON.parse(row.confidence || '{}').guardBlocked === true;
  const reason = String(overrideReason || '').trim();
  // نگهبانی که واقعاً سند را بازنویسی کرده، نقشهٔ مشخص و متوازن دارد؛ حسابدار
  // می‌تواند همان نقشه را با دلیل تأیید کند. نقشهٔ عمومیِ حدسی چنین مجوزی ندارد.
  const reviewedGuardPlan = undecided && !heldForAccountant && isGuardPlan(lockedPlan);
  if (reviewedGuardPlan && reason.length < 5) {
    throw storeError('برای ثبت نقشهٔ اصلاح‌شدهٔ نگهبان، دلیل بررسی حسابدار لازم است.', 'EVENT_OVERRIDE_REASON_REQUIRED', 409);
  }
  if ((undecided && !reviewedGuardPlan) || heldForAccountant) {
    throw storeError(decision?.decisionStatus === DECISION_STATUS.NEEDS_USER_INPUT
      ? 'پیش از ثبت، به سؤال این مورد پاسخ بده تا تصمیم و نقشهٔ سند دوباره ساخته شوند.'
      : 'نقشهٔ سند این مورد قطعی نیست؛ آن را بررسی و در مسیر ثبت دستیِ حسابدار اصلاح کن.', 'EVENT_PLAN_REVISION_REQUIRED', 409);
  }

  const event = JSON.parse(row.payload);
  // نقشهٔ قفل‌شدهٔ لحظهٔ تصمیم، نه نقشه‌ای که کدِ امروز می‌سازد.
  //
  // رویدادهایی که پیش از این تغییر ثبت شده‌اند نقشهٔ ذخیره‌شده ندارند؛ برای
  // آن‌ها مثل قبل محاسبه می‌شود و همین در ردپا نوشته می‌شود، تا حسابرسی بتواند
  // این دو دسته را از هم تشخیص بدهد.
  const plan = lockedPlan || planJournal(event);
  // همان لنگری که در لحظهٔ ثبت تصمیم گرفته شد، نه لنگر تازه.
  const journalSource = row.journal_source ? JSON.parse(row.journal_source) : null;
  if (!withinTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    // سندِ رویدادی که روی تراکنش نشسته باید همان شکلی را داشته باشد که اگر
    // خودکار ثبت می‌شد داشت. تأیید حسابدار زمانِ ثبت را عوض می‌کند، نه سند را.
    postPlanned(database, { id: row.id, event, plan, actor, timeZone, journalSource, postJournal, treatment: decision?.treatment });
    writeAudit(database, row.id, 'approved', {
      by: actor, planSource: lockedPlan ? 'locked-at-capture' : 'recomputed-legacy',
      ...(reviewedGuardPlan ? { override: true, reason: reason.slice(0, 500), guard: lockedPlan.guard } : {}),
    }, actor);
    if (!withinTransaction) database.exec('COMMIT');
  } catch (error) { if (!withinTransaction) database.exec('ROLLBACK'); throw error; }
  return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
}

/** ثبتِ بررسی‌شدهٔ گفتهٔ چندمبلغی؛ حسابدار حساب‌ها و همهٔ مبالغ را صریح انتخاب می‌کند. */
export function postReviewedComposite(database, eventId, { lines, reason, actor = null, timeZone = 'Asia/Tehran', accountantProposal = false, eventOverride = null } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row || row.status !== 'pending' || row.route !== ROUTES.ACCOUNTANT_REVIEW || (!accountantProposal && (row.kind !== EVENT_KINDS.REVIEW_PLACEHOLDER || row.journal_source))) {
    throw storeError('فقط گفتهٔ چندمبلغیِ در انتظار را می‌توان از این مسیر ثبت کرد.', 'EVENT_NOT_REVIEWABLE', 409);
  }
  const explanation = String(reason || '').trim().slice(0, 500);
  if (explanation.length < 8) throw storeError('مبنای ثبت حسابدار را با حداقل هشت نویسه بنویس.', 'REVIEW_REASON_REQUIRED', 400);
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > 12) throw storeError('سند بررسی‌شده باید بین ۲ تا ۱۲ سطر داشته باشد.', 'REVIEW_LINES_INVALID', 400);
  if (lines.some((line) => !Number.isSafeInteger(line?.debit) || !Number.isSafeInteger(line?.credit) || line.debit < 0 || line.credit < 0)) {
    throw storeError('مبلغ هر سطر باید عدد صحیح نامنفی به تومان باشد.', 'REVIEW_LINES_INVALID', 400);
  }
  const counterpartyAccounts = new Set(['customer-receivable', 'vendor-payable', 'cheque-receivable', 'cheque-payable']);
  for (const line of lines) {
    const account = database.prepare('SELECT source_kind AS sourceKind FROM ledger_accounts WHERE id=?').get(String(line.accountId || ''));
    if (counterpartyAccounts.has(account?.sourceKind) && !line.analyticId) {
      throw storeError('برای سطر طرف حساب، تفصیلی همان طرف را تعیین کن.', 'REVIEW_ANALYTIC_REQUIRED', 400);
    }
  }
  // مبلغ مرجع در این خانواده مبلغ سند نیست. تراز و اعتبار حساب‌ها در
  // postJournalEntry بررسی می‌شود، نه با حدس از بزرگ‌ترین عدد گفتار.
  const safeLines = lines.map((line) => ({
    accountId: String(line.accountId || '').trim(),
    debit: line.debit, credit: line.credit,
    description: String(line.description || '').slice(0, 300),
    analyticId: line.analyticId || null, costCenterId: line.costCenterId || null,
  }));
  const event = eventOverride || JSON.parse(row.payload);
  const source = row.journal_source ? JSON.parse(row.journal_source) : null;
  const posted = postJournalEntry(database, {
    sourceType: source?.type || 'financial-event', sourceId: source?.id || row.id, occurredAt: event.occurredAt,
    memo: `ثبت بررسی‌شده: ${explanation}`.slice(0, 500), lines: safeLines,
  }, { createdBy: actor, timeZone });
  database.prepare('UPDATE financial_events SET posting_plan=? WHERE id=?').run(JSON.stringify({
    kind: 'accountant-reviewed', lines: safeLines, memoHint: explanation,
  }), row.id);
  if (eventOverride) database.prepare('UPDATE financial_events SET payload=?,occurred_at=?,due_at=? WHERE id=?').run(JSON.stringify(event),event.occurredAt,event.dueAt || null,row.id);
  markEventPosted(database, row.id, posted, safeLines, actor);
  writeAudit(database, row.id, 'accountant-reviewed', { reason: explanation, journalEntryId: posted.id }, actor);
  return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
}

/**
 * برگشت یک رویداد ثبت‌شده.
 *
 * سند حذف نمی‌شود؛ سند معکوس می‌خورد و هر دو در تاریخچه می‌مانند. حذف، زنجیرهٔ
 * حسابرسی را پاک می‌کند و هیچ راهی برای بازسازی‌اش نمی‌ماند.
 */
export function reverseFinancialEvent(database, eventId, { actor = null, reason = '', timeZone = 'Asia/Tehran', withinTransaction = false } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status !== 'posted') throw storeError('فقط رویداد ثبت‌شده معکوس می‌شود.', 'EVENT_NOT_POSTED', 409);

  // سند این رویداد ممکن است به تراکنش لنگر خورده باشد، نه به خودِ رویداد.
  // جست‌وجوی لنگر اشتباه چیزی پیدا نمی‌کند و `reverseJournalEntry` بی‌صدا
  // `null` برمی‌گرداند — رویداد «معکوس‌شده» علامت می‌خورد ولی سندش سر جایش
  // می‌ماند. بدترین نوع خطا: دفتر غلط است و هیچ نشانه‌ای ندارد.
  const anchor = row.journal_source ? JSON.parse(row.journal_source) : null;
  if (!withinTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    const reversal = reverseJournalEntry(database, {
      sourceType: anchor?.type || 'financial-event', sourceId: anchor?.id || row.id,
      memo: reason ? `برگشت: ${reason}`.slice(0, 200) : 'برگشت رویداد مالی',
      createdBy: actor, timeZone,
    });
    // رویدادی که «ثبت‌شده» است حتماً سندی دارد. اگر پیدا نشد، یعنی لنگر غلط
    // است؛ علامت‌زدن «معکوس شد» در این حالت فقط ردپا را دروغ می‌کند.
    if (!reversal) throw storeError('سند این رویداد پیدا نشد؛ برگشت انجام نشد.', 'EVENT_JOURNAL_MISSING', 409);
    // برنامهٔ شناسایی دنبالهٔ همین سند است و با آن برمی‌گردد — پیش‌پرداخت و
    // درآمد انتقالی هر دو. بدون این، هزینهٔ ماه‌های گذشته برای پولی که برگشته
    // در دفتر می‌ماند و اجرای بعدی ماه‌های آینده را هم می‌ساخت.
    retireRecognitionSchedule(database, row.id, { actor, timeZone, memo: reason ? `برگشت شناسایی: ${reason}`.slice(0, 200) : undefined });
    database.prepare("UPDATE financial_events SET status='reversed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
    writeAudit(database, row.id, 'reversed', { reason: String(reason || '').slice(0, 300), reversalEntryId: reversal.id }, actor);
    if (!withinTransaction) database.exec('COMMIT');
  } catch (error) { if (!withinTransaction) database.exec('ROLLBACK'); throw error; }
  return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
}

/** رد رویداد در صف بررسی، بدون ساختن سند. */
export function rejectFinancialEvent(database, eventId, { actor = null, reason = '' } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status !== 'pending') throw storeError('فقط رویداد در انتظار قابل رد است.', 'EVENT_NOT_PENDING', 409);
  database.prepare("UPDATE financial_events SET status='rejected',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
  // برنامه‌ای که در لحظهٔ ضبط ساخته شد، با رد بی‌موضوع است؛ زنده ماندنش پنجرهٔ
  // اجرای ماهانه را برای رویدادهای واقعی پر می‌کرد.
  retireRecognitionSchedule(database, row.id, { actor });
  writeAudit(database, row.id, 'rejected', { reason: String(reason || '').slice(0, 300) }, actor);
  return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
}

function describeStored(database, row) {
  const decision = decisionForEvent(database, row.id);
  const held = row.route === ROUTES.ACCOUNTANT_REVIEW && JSON.parse(row.confidence || '{}').guardBlocked === true;
  const undecided = decision && decision.decisionStatus !== DECISION_STATUS.DECIDED;
  const guardPlan = !held && isGuardPlan(row.posting_plan ? JSON.parse(row.posting_plan) : null);
  const approvalBlocked = Boolean(held || (undecided && !guardPlan));

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
    approvalBlocked,
    approvalNextStep: approvalBlocked ? (decision?.decisionStatus === DECISION_STATUS.NEEDS_USER_INPUT ? 'answer-question' : 'manual-review') : 'approve',
    decisionId: row.decision_id || null,
    event: JSON.parse(row.payload),
    confidence: JSON.parse(row.confidence),
    createdAt: row.created_at,
  };
}

/**
 * صف بررسی: هرچه ثبت نشده و رد هم نشده.
 *
 * `route` صف را تنگ می‌کند. حسابدار همه را می‌بیند، ولی صاحب کسب‌وکار فقط
 * مسیر `confirm` را — یعنی چیزهایی که خودش می‌تواند جواب بدهد. موردی که به
 * دانش حسابداری نیاز دارد اصلاً به او نشان داده نمی‌شود.
 */
export function listReviewQueue(database, { limit = 50, route = '' } = {}) {
  ensureFinancialEventSchema(database);
  const filter = ROUTE_VALUES.includes(route) ? ' AND route=?' : '';
  const params = filter ? [route] : [];
  const rows = database.prepare(`SELECT * FROM financial_events
    WHERE status='pending'${filter} ORDER BY
      CASE route WHEN 'accountant-review' THEN 0 ELSE 1 END, created_at DESC
    LIMIT ?`).all(...params, Math.max(1, Math.min(200, Number(limit) || 50)));
  return rows.map((row) => describeStored(database, row));
}

const ROUTE_VALUES = Object.freeze(Object.values(ROUTES));

/**
 * سپردن یک مورد به حسابدار.
 *
 * وقتی صاحب کسب‌وکار می‌گوید «نمی‌دانم»، جواب درست پاک کردن نیست. مورد همان‌جا
 * می‌ماند و فقط مسیرش عوض می‌شود تا در صف کسی بنشیند که می‌تواند جوابش را بدهد.
 */
export function handOverToAccountant(database, eventId, { actor = null, reason = '' } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status !== 'pending') throw storeError('این مورد دیگر در انتظار نیست.', 'EVENT_NOT_PENDING', 409);
  database.prepare("UPDATE financial_events SET route='accountant-review',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
  writeAudit(database, row.id, 'handed-over', { reason: String(reason || '').slice(0, 300) }, actor);
  return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
}

/** تاریخچهٔ کامل یک رویداد، از گفته تا برگشت. */
export function financialEventAudit(database, eventId) {
  ensureFinancialEventSchema(database);
  return database.prepare('SELECT stage,actor,detail,created_at AS createdAt FROM financial_event_audit WHERE event_id=? ORDER BY created_at,rowid')
    .all(String(eventId || ''))
    .map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
}

/**
 * رویداد ثبت‌شده برای یک منبع، اگر وجود داشته باشد.
 *
 * مهاجرت تدریجی به این لازم دارد: تعهدی که پیش از این تغییر ساخته شده هیچ
 * سندی در دفتر ندارد، پس تسویه‌اش نباید از حساب دریافتنی کم کند — آن حساب
 * اصلاً موجودی ندارد و منفی می‌شود. مسیر تازه فقط برای تعهدهایی است که
 * خودشان از این مسیر آمده‌اند.
 */
export function findEventBySource(database, sourceEventId) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE source_event_id=?').get(String(sourceEventId || ''));
  return row ? describeStored(database, row) : null;
}

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

// ---------------------------------------------------------------------------
// اجرای اقلام شناسایی در سررسید
// ---------------------------------------------------------------------------

/**
 * سندِ تخصیص یک قلم، بر اساس برخوردِ رویداد اصلی.
 *
 * پیش‌پرداخت: از دارایی کم می‌شود و به هزینه می‌رود.
 * درآمد انتقالی: از بدهی کم می‌شود و به درآمد می‌رود.
 *
 * برخوردی که اینجا نیست، تخصیص ماهانه ندارد و قلمش اصلاً ساخته نمی‌شود.
 */
const ALLOCATION_PLANS = Object.freeze({
  'prepaid-expense': (event, amount) => ([
    { role: ROLES.EXPENSE_CATEGORY, key: event.category, debit: amount, credit: 0 },
    { role: ROLES.PREPAID_ASSET, key: event.category, debit: 0, credit: amount },
  ]),
  'deferred-revenue': (event, amount) => ([
    { role: ROLES.DEFERRED_REVENUE, key: event.counterparty, debit: amount, credit: 0 },
    { role: ROLES.INCOME_CATEGORY, key: event.category, debit: 0, credit: amount },
  ]),
});

/**
 * اقلامی که سررسیدشان رسیده را ثبت می‌کند.
 *
 * این نیمهٔ گمشدهٔ فاز ۲ بود: برنامه ساخته و باطل می‌شد، ولی کسی سررسید که
 * می‌رسید ثبتش نمی‌کرد. یعنی پیش‌پرداخت تا ابد دارایی می‌ماند و هیچ‌وقت هزینه
 * نمی‌شد.
 *
 * چهار چیزی که اینجا هرگز نباید بشکند:
 *
 * ۱. **اجرای دوباره سند دوم نمی‌سازد.** کار زمان‌بندی‌شده ممکن است چند بار در
 *    روز اجرا شود. وضعیت قلم و لنگر سند هر دو این را تضمین می‌کنند.
 * ۲. **قلمِ رویدادی که هنوز سند نخورده ثبت نمی‌شود.** تخصیص از دارایی‌ای کم
 *    می‌کند که هنوز ساخته نشده؛ مانده منفی می‌شود و هیچ‌کس نمی‌فهمد از کجا آمده.
 * ۳. **دورهٔ بسته باز نمی‌شود.** قلم علامت می‌خورد و می‌ماند تا حسابدار
 *    تصمیم بگیرد.
 * ۴. **قلم باطل‌شده هیچ‌وقت ثبت نمی‌شود.**
 */
export function postDueRecognitionItems(database, { today = null, actor = null, timeZone = 'Asia/Tehran', limit = 500 } = {}) {
  ensureFinancialEventSchema(database);
  const at = today || new Date().toISOString();
  const summary = { posted: 0, blocked: 0, skipped: 0 };

  const due = database.prepare(`SELECT key,event_id AS eventId,period_key AS periodKey,
    recognition_date AS recognitionDate,amount
    FROM recognition_schedule_items
    WHERE status='planned' AND recognition_date IS NOT NULL AND recognition_date <= ?
      -- فقط رویدادِ ثبت‌شده. قلم رویداد منتظر، ردشده یا معکوس‌شده هیچ‌وقت ثبت
      -- نمی‌شود؛ اگر اینجا انتخاب شود فقط سقف اجرا را می‌خورد و بیش از پانصد
      -- قلم کهنه، اقلام واقعیِ بعد از خود را برای همیشه پشت در نگه می‌داشت.
      AND event_id IN (SELECT id FROM financial_events WHERE status='posted')
    ORDER BY recognition_date LIMIT ?`).all(at, Math.max(1, Math.min(2000, Number(limit) || 500)));

  const lockedPeriods = new Set(database.prepare("SELECT period FROM accounting_periods WHERE status='locked'")
    .all().map((row) => row.period));

  for (const item of due) {
    const row = database.prepare('SELECT payload,status FROM financial_events WHERE id=?').get(item.eventId);
    // رویدادی که سند نخورده، دارایی‌ای هم نساخته.
    if (!row || row.status !== 'posted') { summary.skipped += 1; continue; }

    if (lockedPeriods.has(periodForDate(item.recognitionDate, timeZone))) {
      database.prepare("UPDATE recognition_schedule_items SET status='blocked-closed-period' WHERE key=?").run(item.key);
      summary.blocked += 1;
      continue;
    }

    const decision = decisionForEvent(database, item.eventId);
    const build = ALLOCATION_PLANS[decision?.treatment];
    if (!build) { summary.skipped += 1; continue; }

    const event = JSON.parse(row.payload);
    database.exec('BEGIN IMMEDIATE');
    try {
      const lines = build(event, item.amount).map((line) => ({
        accountId: resolveEventRole(database, line.role, line.key, event),
        analyticId: resolveEventAnalytic(database, line.role, event, line.key),
        debit: line.debit,
        credit: line.credit,
        description: `شناسایی ${item.periodKey}`,
      }));
      // لنگر سند، خودِ کلید قلم است: اگر همین قلم دوباره به اینجا برسد،
      // `postJournalEntry` آن را تکراری می‌بیند.
      const posted = postJournalEntry(database, {
        sourceType: 'recognition-schedule',
        sourceId: item.key,
        occurredAt: item.recognitionDate,
        memo: `تخصیص ${event.category || ''} — ${item.periodKey}`.trim(),
        lines,
      }, { createdBy: actor, timeZone });

      database.prepare("UPDATE recognition_schedule_items SET status='posted',journal_entry_id=? WHERE key=?")
        .run(posted.id, item.key);
      writeAudit(database, item.eventId, 'recognized', { periodKey: item.periodKey, amount: item.amount, journalEntryId: posted.id }, actor);
      database.exec('COMMIT');
      summary.posted += 1;
    } catch (error) {
      database.exec('ROLLBACK');
      // یک قلم خراب نباید بقیهٔ اجرا را متوقف کند؛ ولی بی‌صدا هم رد نمی‌شود.
      writeAudit(database, item.eventId, 'recognition-failed', { periodKey: item.periodKey, reason: String(error.message).slice(0, 300) }, actor);
      summary.skipped += 1;
    }
  }

  return summary;
}
