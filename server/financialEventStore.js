import { randomUUID } from 'node:crypto';
import { planJournal } from '../shared/accountingRules.js';
import { ROUTES } from '../shared/confidenceEngine.js';
import { buildMonthlySchedule } from '../shared/recognitionSchedule.js';
import { normalizeFinancialEvent } from '../shared/financialEvent.js';
import { decide } from '../shared/accountingDecision.js';
import { factsFromEvent } from '../shared/eventFacts.js';
import { applyAnswer } from '../shared/questionAnswer.js';
import { ensureAccountingSchema, postJournalEntry, reverseJournalEntry } from './accounting.js';
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
        CHECK(status IN ('planned','posted','blocked-closed-period')),
      journal_entry_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_recognition_schedule_event ON recognition_schedule_items(event_id,period_key);
  `);
  // مهاجرت افزایشی: رویداد قدیمی هیچ‌کدام از این‌ها را ندارد و همان‌طور که بود
  // خوانده می‌شود. هیچ دادهٔ تاریخی بازطبقه‌بندی نمی‌شود.
  for (const column of ['decision_id TEXT', 'posting_plan TEXT']) {
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
function storeSchedule(database, eventId, decision, event) {
  if (decision?.recognitionMethod !== 'monthly-straight-line') return 0;
  const items = buildMonthlySchedule({
    amount: event.amount,
    periodStart: event.servicePeriodStart,
    periodEnd: event.servicePeriodEnd,
    sourceId: eventId,
  });
  const insert = database.prepare(`INSERT OR IGNORE INTO recognition_schedule_items
    (key,event_id,period_key,recognition_date,amount,status) VALUES (?,?,?,?,?,?)`);
  let written = 0;
  for (const item of items) {
    written += insert.run(item.key, eventId, item.periodKey, item.recognitionDate, item.amount, item.status).changes;
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
  // تصمیم، شکل سند را تعیین می‌کند. بدون تصمیم، همان قاعدهٔ نوع رویداد.
  const plan = planJournal(event, accountingDecision);

  if (!withinTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO financial_events
      (id,source_event_id,kind,amount,occurred_at,due_at,payload,confidence,route,status,created_by,journal_source,posting_plan)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, source, event.kind, event.amount, event.occurredAt, event.dueAt || null,
        JSON.stringify(event), JSON.stringify(decision), decision.route, 'pending', actor,
        journalSource ? JSON.stringify(journalSource) : null,
        // نقشه همین‌جا قفل می‌شود.
        //
        // تا امروز نقشه در تأیید دوباره با کدِ آن روز ساخته می‌شد. رویدادی که
        // دو هفته در صف مانده و در این فاصله قاعده‌ای عوض شده، سندی می‌خورد که
        // با آنچه به حسابدار نشان داده شده بود فرق دارد — و هیچ هشداری هم
        // نمی‌دهد. حالا آنچه در لحظهٔ تصمیم ساخته شد، همان ثبت می‌شود.
        JSON.stringify(plan));

    const decisionId = storeDecision(database, id, accountingDecision);
    if (decisionId) database.prepare('UPDATE financial_events SET decision_id=? WHERE id=?').run(decisionId, id);
    storeSchedule(database, id, accountingDecision, event);

    writeAudit(database, id, 'captured', {
      rawInput: String(rawInput || '').slice(0, 1000),
      transcript: String(transcript || event.evidence || '').slice(0, 1000),
      event,
      confidence: decision,
      rule: plan.kind,
      journalPlan: plan,
      decision: accountingDecision || null,
    }, actor);

    let journalEntryId = null;
    if (decision.route === ROUTES.AUTO) {
      const posted = postJournal
        ? postJournal(database, { event, plan, eventId: id, actor, timeZone })
        : postEventJournal(database, id, event, plan, { actor, timeZone, journalSource });
      journalEntryId = posted?.id || null;
      // مسیر تزریقی وضعیت و ردپا را خودش نمی‌نویسد؛ ردپا نباید به انتخاب
      // ثبت‌کننده وابسته باشد.
      if (postJournal && journalEntryId) markEventPosted(database, id, posted, plan.lines, actor);
    }
    if (!withinTransaction) database.exec('COMMIT');
    return { id, sourceEventId: source, route: decision.route, status: journalEntryId ? 'posted' : 'pending', journalEntryId, decisionId, plan, duplicate: false };
  } catch (error) { if (!withinTransaction) database.exec('ROLLBACK'); throw error; }
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
  return posted;
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
export function answerEventQuestion(database, eventId, { fact, value, freeText = '', actor = null, today = null } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status !== 'pending') throw storeError('این رویداد دیگر در انتظار نیست.', 'EVENT_NOT_PENDING', 409);

  const previous = decisionForEvent(database, row.id);
  const stored = JSON.parse(row.payload);
  const reference = today || stored.occurredAt;
  const patch = applyAnswer(stored, { fact, value, freeText }, { today: reference });
  const event = normalizeFinancialEvent({ ...stored, ...patch });
  const decision = decide(factsFromEvent(event), { today: reference });
  const plan = planJournal(event, decision);

  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('UPDATE financial_events SET payload=?,posting_plan=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(JSON.stringify(event), JSON.stringify(plan), row.id);
    const decisionId = storeDecision(database, row.id, decision, previous?.id || null);
    database.prepare('UPDATE financial_events SET decision_id=? WHERE id=?').run(decisionId, row.id);
    storeSchedule(database, row.id, decision, event);
    writeAudit(database, row.id, 'answered', { fact, value, freeText, patch, decision }, actor);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }

  return { ...describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id)), decision };
}

/** تأیید کاربر یا حسابدار روی رویدادی که منتظر مانده بود. */
export function approveFinancialEvent(database, eventId, { actor = null, timeZone = 'Asia/Tehran', postJournal = null } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status === 'posted') return describeStored(database, row);
  if (row.status !== 'pending') throw storeError('این رویداد دیگر در انتظار تأیید نیست.', 'EVENT_NOT_PENDING', 409);

  const event = JSON.parse(row.payload);
  // نقشهٔ قفل‌شدهٔ لحظهٔ تصمیم، نه نقشه‌ای که کدِ امروز می‌سازد.
  //
  // رویدادهایی که پیش از این تغییر ثبت شده‌اند نقشهٔ ذخیره‌شده ندارند؛ برای
  // آن‌ها مثل قبل محاسبه می‌شود و همین در ردپا نوشته می‌شود، تا حسابرسی بتواند
  // این دو دسته را از هم تشخیص بدهد.
  const lockedPlan = row.posting_plan ? JSON.parse(row.posting_plan) : null;
  const plan = lockedPlan || planJournal(event);
  // همان لنگری که در لحظهٔ ثبت تصمیم گرفته شد، نه لنگر تازه.
  const journalSource = row.journal_source ? JSON.parse(row.journal_source) : null;
  database.exec('BEGIN IMMEDIATE');
  try {
    // سندِ رویدادی که روی تراکنش نشسته باید همان شکلی را داشته باشد که اگر
    // خودکار ثبت می‌شد داشت. تأیید حسابدار زمانِ ثبت را عوض می‌کند، نه سند را.
    if (postJournal) {
      const posted = postJournal(database, { event, plan, eventId: row.id, actor, timeZone });
      if (posted?.id) markEventPosted(database, row.id, posted, plan.lines, actor);
    } else {
      postEventJournal(database, row.id, event, plan, { actor, timeZone, journalSource });
    }
    writeAudit(database, row.id, 'approved', { by: actor, planSource: lockedPlan ? 'locked-at-capture' : 'recomputed-legacy' }, actor);
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

  // سند این رویداد ممکن است به تراکنش لنگر خورده باشد، نه به خودِ رویداد.
  // جست‌وجوی لنگر اشتباه چیزی پیدا نمی‌کند و `reverseJournalEntry` بی‌صدا
  // `null` برمی‌گرداند — رویداد «معکوس‌شده» علامت می‌خورد ولی سندش سر جایش
  // می‌ماند. بدترین نوع خطا: دفتر غلط است و هیچ نشانه‌ای ندارد.
  const anchor = row.journal_source ? JSON.parse(row.journal_source) : null;
  database.exec('BEGIN IMMEDIATE');
  try {
    const reversal = reverseJournalEntry(database, {
      sourceType: anchor?.type || 'financial-event', sourceId: anchor?.id || row.id,
      memo: reason ? `برگشت: ${reason}`.slice(0, 200) : 'برگشت رویداد مالی',
      createdBy: actor, timeZone,
    });
    // رویدادی که «ثبت‌شده» است حتماً سندی دارد. اگر پیدا نشد، یعنی لنگر غلط
    // است؛ علامت‌زدن «معکوس شد» در این حالت فقط ردپا را دروغ می‌کند.
    if (!reversal) throw storeError('سند این رویداد پیدا نشد؛ برگشت انجام نشد.', 'EVENT_JOURNAL_MISSING', 409);
    database.prepare("UPDATE financial_events SET status='reversed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
    writeAudit(database, row.id, 'reversed', { reason: String(reason || '').slice(0, 300), reversalEntryId: reversal.id }, actor);
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
