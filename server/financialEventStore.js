import { reviewNature, reviewNatureViolations } from '../shared/reviewNature.js';
import { matchingUnidentifiedHolding } from './unidentifiedReceipts.js';
import { ensureReviewIntakeSchema } from './reviewIntakeSchema.js';
import { randomUUID } from 'node:crypto';
import { ROLES, planJournal, treatmentHasPlan } from '../shared/accountingRules.js';
import { ROUTES } from '../shared/confidenceEngine.js';
import { SCHEDULE_ITEM_STATUS, buildMonthlySchedule, coverageMonths, readCoverageAnswers, readCoverageLength } from '../shared/recognitionSchedule.js';
import { extractAmounts } from '../shared/parser.js';
import { readServicePeriod } from '../shared/periodSpeech.js';
import { normalizePersian } from '../shared/normalize.js';
import { categoryByName, scoreCategories } from '../shared/categoryRules.js';
import { persianToISO, readJalaliExpression, readTypedDate, todayPersian } from '../shared/persianDate.js';
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

  // حسابی که تخصیص از آن کم می‌کند — همان حسابی که پرداخت (یا دریافت) واقعاً
  // بدهکار (یا بستانکار) کرد.
  //
  // برنامهٔ لحظهٔ ضبط حسابش را از نقش و دستهٔ رویداد می‌سازد و ستون خالی می‌ماند.
  // ولی وقتی حسابدار سطرها را خودش انتخاب می‌کند — «پیش‌پرداخت‌ها»ی کدینگ یا
  // پیش‌پرداخت دستهٔ دیگر — ساختن دوبارهٔ حساب از دسته یعنی تخصیص از حسابی کم
  // می‌شد که هرگز بدهکار نشده بود: یکی تا ابد مانده داشت و دیگری ماندهٔ بستانکار.
  try { database.exec('ALTER TABLE recognition_schedule_items ADD COLUMN account_id TEXT'); }
  catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }

  // ترمیم یک‌باره برای هر اتصال: دفترهایی که پیش از بازنشستگی برنامه در لحظهٔ
  // برگشت ساخته شده‌اند، اقلام زندهٔ رویدادِ پس‌گرفته را هنوز دارند.
  if (!REPAIRED_DATABASES.has(database)) {
    REPAIRED_DATABASES.add(database);
    repairCancelledSchedules(database);
    detachUnpaidCashRows(database);
  }
}

/**
 * ردیفِ تراکنشی که رویدادش «طلب یا بدهیِ باز» است، به هیچ حساب نقدی وصل نیست.
 *
 * تا ۲۹ مهر ۱۴۰۵ ردیفِ پرداخت‌نشده («قبض اومده، قراره تا آبان پرداختش کنیم») با حساب صندوق
 * ذخیره می‌شد. سندش درست بود (هزینه در برابر بدهی، بی‌سطر نقدی)، ولی ماندهٔ صندوق از جمعِ همین
 * ردیف‌ها حساب می‌شود و به اندازهٔ بدهیِ پرداخت‌نشده کم می‌آمد؛ کارت حساب و دفتر کل دو عدد
 * می‌گفتند. حساب از ردیف برداشته می‌شود؛ سندِ دفتر و خودِ تعهد دست نمی‌خورند.
 */
export function detachUnpaidCashRows(database) {
  try {
    database.prepare(`UPDATE transactions SET account_id=NULL WHERE account_id IS NOT NULL AND id IN (
      SELECT substr(source_event_id, 13) FROM financial_events
      WHERE kind IN ('payable-opened','receivable-opened') AND source_event_id LIKE 'transaction:%')`).run();
  } catch { /* دفتری که هنوز جدول تراکنش ندارد */ }
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

function storeSchedule(database, eventId, decision, event, { timeZone = 'Asia/Tehran', plan = null, amount = null, accountId = null } = {}) {
  if (decision?.recognitionMethod !== 'monthly-straight-line') return 0;
  const items = buildMonthlySchedule({
    // مبلغ صریح فقط از سند ثبت‌شدهٔ حسابدار می‌آید: همان سطر پیش‌پرداخت یا درآمد
    // انتقالی که واقعاً در دفتر نشست.
    amount: amount ?? scheduleBase(plan, decision, event),
    periodStart: event.servicePeriodStart,
    periodEnd: event.servicePeriodEnd,
    sourceId: eventId,
    // هیچ قلمی پیش از خودِ پرداخت یا دریافت سند نمی‌خورد؛ بررسی دورهٔ بسته هم
    // همان دوره‌ای را می‌سنجد که سند واقعاً در آن می‌نشیند.
    notBefore: event.occurredAt,
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
  // قلمی که برنامهٔ قبلی باطلش کرده و برنامهٔ تازه دوباره همان ماه را می‌خواهد،
  // زنده می‌شود. کلید یکتاست و `INSERT OR IGNORE` ردیف باطل را کنار نمی‌زند؛ بدون
  // این، برنامه‌ای که «یک‌ساله → شش‌ماهه → یک‌ساله» شد، یا ثبت حسابدار که برنامهٔ
  // لحظهٔ ضبط را جایگزین کرد، ماه‌هایی بی‌قلم داشت و دارایی هرگز صفر نمی‌شد.
  const revive = database.prepare("UPDATE recognition_schedule_items SET status='planned',journal_entry_id=NULL WHERE key=? AND status='superseded'");
  for (const key of keeping) revive.run(key);
  // قلم منتظرِ دورهٔ بسته هم جزو برنامهٔ زنده است: اگر برنامه عوض شود باطل یا
  // بازقیمت‌گذاری می‌شود، وگرنه با وضعیت کهنه‌اش جا می‌ماند.
  const existing = database.prepare(`SELECT key,amount,status,recognition_date AS recognitionDate,account_id AS accountId FROM recognition_schedule_items
    WHERE event_id=? AND status IN ('planned','blocked-closed-period')`).all(eventId);
  const supersede = database.prepare("UPDATE recognition_schedule_items SET status='superseded' WHERE key=?");
  const reprice = database.prepare('UPDATE recognition_schedule_items SET amount=?,recognition_date=?,account_id=? WHERE key=?');
  for (const row of existing) {
    if (!keeping.has(row.key)) supersede.run(row.key);
  }
  // ماه‌هایی که می‌مانند ممکن است سهم تازه‌ای بگیرند: همان مبلغ روی دورهٔ
  // کوتاه‌تر پخش می‌شود.
  for (const item of items) {
    const row = existing.find((entry) => entry.key === item.key);
    // تاریخ هم: جوابی که تاریخ پرداخت را جابه‌جا کند، کف تاریخ اقلام را هم
    // جابه‌جا می‌کند.
    if (row && (row.amount !== item.amount || row.recognitionDate !== item.recognitionDate || (row.accountId || null) !== accountId)) reprice.run(item.amount, item.recognitionDate, accountId, item.key);
  }
  const insert = database.prepare(`INSERT OR IGNORE INTO recognition_schedule_items
    (key,event_id,period_key,recognition_date,amount,status,account_id) VALUES (?,?,?,?,?,?,?)`);
  // قلمی که در دورهٔ بسته می‌افتد ثبت نمی‌شود و علامت می‌خورد.
  //
  // تصمیم ۳ فاز صفر: نه به دورهٔ بعد منتقل می‌شود — که سود دوره را بدون تأیید
  // جابه‌جا می‌کند — و نه دورهٔ بسته را باز می‌کند. با دلیل روشن می‌ماند تا
  // حسابدار تصمیم بگیرد.
  const lockedPeriods = lockedPeriodSet(database);
  const inLockedPeriod = (item) => Boolean(item.recognitionDate) && lockedPeriods.has(periodForDate(item.recognitionDate, timeZone));
  // قلمی که منتظر دورهٔ بسته بود و آن دوره باز شده، دوباره برنامه‌ریزی‌شده است.
  for (const row of existing) {
    const item = items.find((entry) => entry.key === row.key);
    if (row.status === SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD && item && !inLockedPeriod(item)) {
      database.prepare("UPDATE recognition_schedule_items SET status='planned' WHERE key=?").run(row.key);
    }
  }

  let written = 0;
  const blocked = [];
  for (const item of items) {
    const locked = inLockedPeriod(item);
    const status = locked ? SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD : item.status;
    const changes = insert.run(item.key, eventId, item.periodKey, item.recognitionDate, item.amount, status, accountId).changes;
    written += changes;
    if (locked && changes) writeAudit(database, eventId, 'recognition-blocked', blockedDetail(item, timeZone), null);
    if (locked) blocked.push(item);
  }
  return { written, blocked };
}

function lockedPeriodSet(database) {
  return new Set(database.prepare("SELECT period FROM accounting_periods WHERE status='locked'").all().map((row) => row.period));
}

/** تاریخ شمسیِ خوانا برای پیام حسابدار. */
function persianDay(iso, timeZone = 'Asia/Tehran') {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso || '') : date.toLocaleDateString('fa-IR-u-ca-persian', { timeZone });
}

function blockedDetail(item, timeZone) {
  return { periodKey: item.periodKey, recognitionDate: item.recognitionDate, period: periodForDate(item.recognitionDate, timeZone), amount: item.amount };
}

/**
 * دلیلی که حسابدار در صف می‌خواند (تصمیم ۳ فاز صفر): نام دوره و تاریخ شناسایی،
 * صریح؛ و دو راهی که پیش رو دارد.
 */
function blockedRecognitionReason(blocked, timeZone = 'Asia/Tehran') {
  const named = blocked.map((item) => `${item.periodKey} به تاریخ ${persianDay(item.recognitionDate, timeZone)} (دورهٔ بستهٔ ${periodForDate(item.recognitionDate, timeZone)})`);
  return `شناسایی ${named.join('، ')} در دورهٔ بسته می‌افتد و سند نمی‌خورد؛ دوره را باز کن یا ثبت جبرانی را با دلیل در نخستین دورهٔ باز تأیید کن.`;
}

/** اقلامی از برنامهٔ آینده که در دورهٔ بسته می‌افتند — پیش از ذخیره، برای مسیر. */
function lockedScheduleItems(database, eventId, decision, event, plan, timeZone) {
  if (decision?.recognitionMethod !== 'monthly-straight-line') return [];
  const lockedPeriods = lockedPeriodSet(database);
  if (!lockedPeriods.size) return [];
  return buildMonthlySchedule({
    amount: scheduleBase(plan, decision, event), periodStart: event.servicePeriodStart, periodEnd: event.servicePeriodEnd,
    sourceId: eventId, notBefore: event.occurredAt,
  }).filter((item) => item.recognitionDate && lockedPeriods.has(periodForDate(item.recognitionDate, timeZone)));
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
  const routed = blocked
    ? { ...decision, route: ROUTES.ACCOUNTANT_REVIEW, guardBlocked: true, reasons: [...new Set([...(decision.reasons || []), ...natureIssues.map(q=>q.text), ...(heldReason ? [heldReason] : []), guards?.reason || (heldReason ? '' : 'این گفته هنوز نقشهٔ سند قطعی ندارد.')].filter(Boolean))] }
    : decision;
  // قلمی از برنامه که در دورهٔ بسته می‌افتد، مورد را به صف حسابدار می‌برد (تصمیم
  // ۳ فاز صفر)؛ نه خودکار ثبت می‌شود و نه بی‌صدا در دورهٔ بعد می‌نشیند.
  const id = randomUUID();
  const lockedItems = lockedScheduleItems(database, id, accountingDecision, event, plan, timeZone);
  const routing = lockedItems.length
    ? { ...routed, route: ROUTES.ACCOUNTANT_REVIEW, reasons: [...new Set([...(routed.reasons || []), blockedRecognitionReason(lockedItems, timeZone)])] }
    : routed;
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
    const stored = storeSchedule(database, row.id, decision, event, { plan });
    if (stored?.blocked?.length) {
      const current = JSON.parse(database.prepare('SELECT confidence FROM financial_events WHERE id=?').get(row.id).confidence);
      const routing = { ...current, route: ROUTES.ACCOUNTANT_REVIEW, reasons: [...new Set([...(current.reasons || []), blockedRecognitionReason(stored.blocked)])] };
      database.prepare('UPDATE financial_events SET route=?,confidence=? WHERE id=?').run(routing.route, JSON.stringify(routing), row.id);
    }
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

// ---------------------------------------------------------------------------
// ثبت حسابدار و برنامهٔ شناسایی
// ---------------------------------------------------------------------------

/** «پیش‌پرداخت خرید — …»: پیش‌پرداخت کالا به تأمین‌کننده، نه خدمت دوره‌دار. */
const SUPPLIER_ADVANCE_NAME = /^پیش[\s\u200c]*پرداخت[\s\u200c]+خرید/;

/**
 * حساب دوره‌دارِ یک سطر: پیش‌پرداخت خدمت (`prepaid`)، درآمد انتقالی
 * (`deferred`) یا هیچ‌کدام.
 *
 * از خودِ حساب دفتر کل خوانده می‌شود — منشأ یا نقش معین کدینگ — نه از نقشی که
 * پیشنهاد گفته بود: حسابدار می‌تواند هر حسابی را انتخاب کند و همان در دفتر
 * می‌نشیند. پیش‌پرداخت خرید کالا هم در همان معین پیش‌پرداخت‌هاست ولی دورهٔ
 * پوشش ندارد؛ با رسیدن کالا بسته می‌شود، نه با گذشت ماه.
 */
export function timingAccountKind(database, accountId, event = {}) {
  const account = database.prepare(`SELECT a.name,a.source_kind AS sourceKind,c.role AS chartRole FROM ledger_accounts a
    LEFT JOIN chart_accounts c ON c.id=a.chart_account_id WHERE a.id=?`).get(String(accountId || ''));
  if (!account) return null;
  if (account.sourceKind === 'deferred-revenue' || account.chartRole === 'deferred-revenue') return 'deferred';
  if (account.sourceKind === 'prepaid-asset' || account.chartRole === 'prepaid-asset') {
    if (event.reviewSupplierAdvance || SUPPLIER_ADVANCE_NAME.test(account.name || '')) return null;
    return 'prepaid';
  }
  return null;
}

/**
 * جواب‌های حسابدار دربارهٔ دورهٔ پوشش، از گفت‌وگوی بررسی.
 *
 * دستیار بررسی شروع و پایان پوشش را با شناسهٔ `coverage.start`/`coverage.end`
 * می‌پرسد (هرگز روی تاریخ پرداخت). شناسه یا متن سؤال گاهی فرق می‌کند؛ هر سؤالی
 * که دربارهٔ پوشش یا دورهٔ خدمت است خوانده می‌شود و سؤال تاریخ پرداخت نه.
 */
/** جواب‌های متنی حسابدار به سؤال‌های همین پرونده: `[id, value, question]`. */
function reviewTextAnswers(database, eventId, event = {}) {
  let answers = event.questionAnswers || null;
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='accounting_review_context'").get()) {
    const row = database.prepare('SELECT facts FROM accounting_review_context WHERE event_id=?').get(eventId);
    if (row) answers = JSON.parse(row.facts || '{}').questionAnswers || answers;
  }
  return Object.entries(answers || {})
    .filter(([, answer]) => answer && typeof answer.value === 'string' && !answer.field)
    .map(([id, answer]) => [id, answer.value, normalizePersian(answer.question || '')]);
}

function reviewCoverageAnswers(database, eventId, event = {}) {
  const result = [];
  for (const [id, value, question] of reviewTextAnswers(database, eventId, event)) {
    const coverage = /coverage|service[_.-]?(?:start|end|period)|period[_.-]?(?:start|end)/i.test(id)
      || /پوشش|دوره(?:\s*ی)?\s*(?:خدمت|اجاره|قرارداد|بیمه|اشتراک)|(?:شروع|پایان)\s*(?:خدمت|قرارداد|اجاره|بیمه|اشتراک)|مدت\s*(?:قرارداد|اجاره|بیمه|اشتراک|پوشش)/.test(question);
    if (!coverage) continue;
    const side = /end|پایان|اتمام|انتها/i.test(`${id} ${question}`) ? 'end' : /start|شروع|ابتدا/i.test(`${id} ${question}`) ? 'start' : 'any';
    result.push({ text: value, side });
  }
  return result;
}

/**
 * دورهٔ پوشش برای سندی که حسابدار ثبت می‌کند.
 *
 * سه منبع، به ترتیب: جواب صریح حسابدار، دورهٔ ذخیره‌شده روی رویداد (از متن یا
 * از جواب کارت سؤال)، و دورهٔ گفته‌شده در خودِ متن اصلی با همان قاعدهٔ مسیر
 * قطعی. هیچ‌کدام نبود، دوره ناقص برمی‌گردد — حدسی در کار نیست.
 */
export function reviewTimingCoverage(database, eventId, event = {}) {
  const occurredAt = event.occurredAt || null;
  const text = event.utterance || event.evidence || '';
  const spoken = occurredAt ? readServicePeriod(text, { occurredAt }) : null;
  const start = event.servicePeriodStart || spoken?.start || null;
  const end = event.servicePeriodStart ? (event.servicePeriodEnd || null) : (spoken?.end || null);
  const months = !event.servicePeriodStart && spoken ? spoken.months : null;
  return readCoverageAnswers(reviewCoverageAnswers(database, eventId, event), { occurredAt, start, end, months });

}

export function coverageQuestion(kind) {
  return kind === 'deferred'
    ? 'دورهٔ خدمتی که پولش پیشاپیش گرفته شد از کی تا کی است؟ مثلاً «از اول مهر ۱۴۰۵ به مدت ۶ ماه»؛ بدون آن، درآمد انتقالی هیچ‌وقت درآمد نمی‌شود.'
    : 'دورهٔ پوشش این پیش‌پرداخت از کی تا کی است؟ مثلاً «از اول مهر ۱۴۰۵ به مدت ۱۲ ماه»؛ بدون آن، پیش‌پرداخت هیچ‌وقت هزینه نمی‌شود.';
}

/**
 * دسته‌هایی که هزینه یا درآمد ماهانهٔ یک خدمت دوره‌دار نیستند: کالا و بهای
 * تمام‌شده (پیش‌پرداخت کالا مسیر تأمین‌کننده است) و دستهٔ «سایر» که خودش یعنی
 * دسته معلوم نشد.
 */
const NON_SERVICE_CATEGORIES = new Set(['مواد و کالا', 'بهای تمام‌شدهٔ فروش', 'کسری و ضایعات موجودی', 'سایر هزینه‌ها', 'سایر درآمدها']);

/** نام دستهٔ معتبر از یک متن کوتاه (نام دسته، کلید سطر یا جواب): فقط وقتی یک دستهٔ خدمت بی‌رقیب جلوست. */
function serviceCategoryFrom(text, type) {
  const exact = categoryByName(text);
  if (exact) return exact.type === type && !NON_SERVICE_CATEGORIES.has(exact.name) ? exact.name : null;
  const [first, second] = scoreCategories(text, type);
  if (!first || (second && second.score >= first.score)) return null;
  return NON_SERVICE_CATEGORIES.has(first.definition.name) ? null : first.definition.name;
}

export function timingCategoryQuestion(kind) {
  return kind === 'deferred'
    ? 'درآمد ماهانهٔ این پیش‌دریافت کدام دسته است؟ (مثلاً درآمد اجاره یا خدمات)'
    : 'هزینهٔ ماهانهٔ این پیش‌پرداخت کدام دسته است؟ (مثلاً بیمه، اجاره، نرم‌افزار و اشتراک)؛ حساب «پیش‌پرداخت‌ها» دسته را نمی‌گوید.';
}

/**
 * دستهٔ هزینه (یا درآمد) ماهانهٔ قراردادی که حسابدار ثبت می‌کند — از انتخاب
 * خودِ حسابدار، نه از حدس لحظهٔ ضبط.
 *
 * به ترتیب:
 * 1. حسابِ دوره‌داری که سند حسابدار بدهکار یا بستانکار کرد، اگر به دسته وصل است
 *    («پیش‌پرداخت — بیمه» → بیمه). همان حسابی است که شناسایی از آن کم می‌کند.
 * 2. جواب صریح حسابدار به «کدام دسته؟».
 * 3. کلید سطر پیشنهاد حسابدار («بیمه انبار» → بیمه) — برای حساب کلی
 *    «پیش‌پرداخت‌ها» که دسته ندارد.
 * 4. دستهٔ لحظهٔ ضبط، فقط اگر دستهٔ یک خدمت است. «مواد و کالا» یا «سایر» برای
 *    پیش‌پرداخت خدمت حدس است: پرسیده می‌شود (`timing.category`).
 *
 * درآمد انتقالی حساب هر طرف است، نه هر دسته؛ دسته از جواب یا کلید سطر می‌آید و
 * نبودشان، دستهٔ لحظهٔ ضبط می‌ماند (حساب، چیزی خلافش نگفته).
 */
export function reviewedTimingCategory(database, eventId, event, timing, lines = []) {
  const type = timing.kind === 'deferred' ? 'income' : 'expense';
  const account = database.prepare('SELECT source_kind AS sourceKind, source_key AS sourceKey FROM ledger_accounts WHERE id=?').get(String(timing.accountId || ''));
  const linkedKind = timing.kind === 'deferred' ? 'deferred-revenue' : 'prepaid-asset';
  const linked = account?.sourceKind === linkedKind && account.sourceKey && account.sourceKey !== 'عمومی' ? account.sourceKey : null;
  const known = linked ? categoryByName(linked) : null;
  // پیش‌پرداخت به نام دسته باز می‌شود (دستهٔ دست‌ساز کاربر هم)؛ درآمد انتقالی به
  // نام طرف — مگر نامش خودش یک دستهٔ درآمد باشد.
  if (linked && (known ? known.type === type : timing.kind === 'prepaid')) return { category: linked, basis: 'account' };
  for (const [id, value, question] of reviewTextAnswers(database, eventId, event)) {
    if (!/category|دسته/i.test(id) && !/کدام\s*دسته|دسته\s*(?:ی|ٔ)?\s*(?:هزینه|درآمد)/.test(question)) continue;
    const answered = serviceCategoryFrom(value, type);
    if (answered) return { category: answered, basis: 'answer' };
  }
  for (const line of lines || []) {
    if (String(line.accountId || '') !== String(timing.accountId || '') || !line.key) continue;
    const keyed = serviceCategoryFrom(String(line.key), type);
    if (keyed) return { category: keyed, basis: 'line-key' };
  }
  const captured = event.category || '';
  if (timing.kind === 'deferred') return { category: captured, basis: 'capture' };
  if (captured && serviceCategoryFrom(captured, type) === captured) return { category: captured, basis: 'capture' };
  return { category: null, question: { id: 'timing.category', text: timingCategoryQuestion(timing.kind) } };
}

/**
 * سطر دوره‌دارِ سندِ حسابدار و دورهٔ پوششش — پیش از ثبت، تا ناقص بودن آن سند
 * نسازد.
 *
 * سطری که پیش‌پرداخت خدمت را بدهکار یا درآمد انتقالی را بستانکار می‌کند،
 * دارایی یا بدهی دوره‌دار می‌سازد و بدون برنامه تا ابد در ترازنامه می‌ماند.
 * پس دورهٔ پوشش شرط ثبت است؛ اگر معلوم نیست پرسیده می‌شود (کد
 * `REVIEW_DETAILS_REQUIRED` با همان سؤال)، نه اینکه از تاریخ پرداخت ساخته شود.
 *
 * بیش از یک حساب دوره‌دار در یک سند یعنی دو قرارداد با دو دوره؛ برنامهٔ یک
 * رویداد یک دوره دارد، پس جدا ثبت شوند.
 */
export function reviewedTimingPlan(database, eventId, event, lines) {
  const totals = new Map();
  for (const line of lines || []) {
    const kind = timingAccountKind(database, line.accountId, event);
    if (!kind) continue;
    const entry = totals.get(line.accountId) || { accountId: line.accountId, kind, amount: 0 };
    entry.amount += kind === 'prepaid' ? (line.debit || 0) - (line.credit || 0) : (line.credit || 0) - (line.debit || 0);
    totals.set(line.accountId, entry);
  }
  // جهت کاهنده (استرداد، فسخ) دارایی یا بدهی تازه نمی‌سازد.
  const creating = [...totals.values()].filter((entry) => entry.amount > 0);
  if (!creating.length) return null;
  if (creating.length > 1) {
    throw storeError('این سند بیش از یک حساب پیش‌پرداخت یا درآمد انتقالی دارد؛ هر قرارداد دوره‌دار را جداگانه ثبت کن تا برنامهٔ تخصیص هرکدام با دورهٔ خودش ساخته شود.', 'REVIEW_DETAILS_REQUIRED', 409);
  }
  const [timing] = creating;
  const coverage = reviewTimingCoverage(database, eventId, event);
  if (!coverage.start || !coverage.end) {
    const text = coverageQuestion(timing.kind);
    throw Object.assign(storeError(text, 'REVIEW_DETAILS_REQUIRED', 409), { question: { id: coverage.start ? 'coverage.end' : 'coverage.start', text } });
  }
  return { ...timing, start: coverage.start, end: coverage.end };
}

/**
 * سند حسابدار جای برنامهٔ لحظهٔ ضبط را می‌گیرد.
 *
 * برنامه‌ای که هنگام ضبط ساخته شد بر تصمیم آن لحظه تکیه داشت؛ وقتی حسابدار
 * سطرهای خودش را ثبت می‌کند، همان سطرها حقیقت دفترند:
 *
 * - سطر دوره‌دار هست: برنامه از **همان سطر** دوباره ساخته می‌شود — مبلغِ همان
 *   سطر (خالص، بی ارزش افزوده)، حسابِ همان سطر و دورهٔ پوشش. تخصیص بعدی از
 *   همان حسابی کم می‌کند که پرداخت بدهکار کرد و ماندهٔ آن در پایان دوره صفر
 *   است. پوششِ گذشته در اجرای بعدی جبران می‌شود.
 * - نیست (حسابدار همه را هزینه یا چیز دیگر ثبت کرد): اقلام برنامه باطل
 *   می‌شوند و تصمیم تازه‌ای جای تصمیم کهنه می‌نشیند، تا شناسایی ماهانه روی
 *   هزینه‌ای که یک بار ثبت شده دوباره هزینه نسازد.
 */
function reconcileReviewedRecognition(database, row, event, timing, { actor, timeZone, journalEntryId }) {
  const previous = decisionForEvent(database, row.id);
  if (!timing) {
    const superseded = database.prepare(`UPDATE recognition_schedule_items SET status='superseded'
      WHERE event_id=? AND status IN ('planned','blocked-closed-period')`).run(row.id).changes;
    let decisionId = null;
    if (previous && (previous.recognitionMethod || ALLOCATION_PLANS[previous.treatment])) {
      decisionId = storeDecision(database, row.id, {
        family: previous.family, treatment: 'accountant-reviewed', policyKey: previous.policyKey, policyVersion: previous.policyVersion,
        recognitionMethod: null, riskLevel: previous.riskLevel, decisionStatus: DECISION_STATUS.DECIDED,
        explanation: 'سند را حسابدار بی‌حساب پیش‌پرداخت یا درآمد انتقالی ثبت کرد؛ تصمیم لحظهٔ ضبط دیگر برنامهٔ شناسایی ندارد.',
        sourceReferences: [{ type: 'journal-entry', id: journalEntryId }],
      }, previous.id);
      database.prepare('UPDATE financial_events SET decision_id=? WHERE id=?').run(decisionId, row.id);
    }
    if (superseded || decisionId) writeAudit(database, row.id, 'schedule-reconciled', { supersededItems: superseded, timing: null, decisionId }, actor);
    return null;
  }
  const deferred = timing.kind === 'deferred';
  const decision = {
    family: deferred ? 'advance-received' : 'asset-creation',
    treatment: deferred ? 'deferred-revenue' : 'prepaid-expense',
    policyKey: previous?.policyKey || null, policyVersion: previous?.policyVersion || null,
    recognitionDate: timing.start, recognitionMethod: 'monthly-straight-line',
    riskLevel: previous?.riskLevel || 'yellow', decisionStatus: DECISION_STATUS.DECIDED,
    explanation: `حسابدار ${deferred ? 'درآمد انتقالی' : 'پیش‌پرداخت'} ثبت کرد؛ برنامهٔ تخصیص از همان سطر و همان حساب ساخته شد.`,
    sourceReferences: [{ type: 'journal-entry', id: journalEntryId }, { type: 'ledger-account', id: timing.accountId },
      ...(timing.category ? [{ type: 'category', id: timing.category, basis: timing.categoryBasis || null }] : [])],
    assumptions: timing.category && timing.categoryBasis !== 'capture' && event.category && event.category !== timing.category
      ? [`دستهٔ لحظهٔ ضبط «${event.category}» با انتخاب حسابدار «${timing.category}» جایگزین شد.`] : [],
  };
  const decisionId = storeDecision(database, row.id, decision, previous?.id || null);
  database.prepare('UPDATE financial_events SET decision_id=? WHERE id=?').run(decisionId, row.id);
  // هزینه یا درآمد ماهانه به دسته‌ای می‌رود که حسابدار انتخاب کرد («پیش‌پرداخت —
  // بیمه» → هزینهٔ بیمه)، نه حدس لحظهٔ ضبط («مواد و کالا»).
  const scheduled = { ...event, servicePeriodStart: timing.start, servicePeriodEnd: timing.end, category: timing.category ?? event.category };
  database.prepare('UPDATE financial_events SET payload=? WHERE id=?').run(JSON.stringify(scheduled), row.id);
  const stored = storeSchedule(database, row.id, decision, scheduled, { amount: timing.amount, accountId: timing.accountId, timeZone });
  writeAudit(database, row.id, 'schedule-reconciled', {
    timing: { kind: timing.kind, accountId: timing.accountId, amount: timing.amount, start: timing.start, end: timing.end },
    decisionId, written: stored?.written || 0, blocked: stored?.blocked?.length || 0,
  }, actor);
  return scheduled;
}

// ---------------------------------------------------------------------------
// استرداد و فسخ: سندی که ماندهٔ یک قرارداد دوره‌دار را کم می‌کند، برنامهٔ همان
// قرارداد را هم کم می‌کند
// ---------------------------------------------------------------------------

/** ماندهٔ قطعیِ یک حساب دفتر کل (بدهکار منهای بستانکار، فقط سندهای تأییدشده). */
function ledgerBalance(database, accountId) {
  return Number(database.prepare(`SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) AS n FROM journal_lines l
    JOIN journal_entries j ON j.id=l.entry_id WHERE l.account_id=? AND j.approval_state='approved'`).get(String(accountId || '')).n);
}

/**
 * قراردادهای زنده‌ای که تخصیصشان از این حساب کم می‌کند.
 *
 * رویداد ثبت‌شده با قلم برنامه‌ریزی‌شده یا منتظر؛ حسابش یا روی خودِ قلم ذخیره
 * شده (سند حسابدار، ماندهٔ بی‌سند) یا همان حسابی است که سند پرداخت/دریافتش
 * بدهکار/بستانکار کرد.
 */
function liveContractsOn(database, accountId, excludeEventId = '', { cutoff = null } = {}) {
  return database.prepare(`SELECT DISTINCT e.id,e.payload,e.journal_entry_id AS journalEntryId FROM financial_events e
    JOIN recognition_schedule_items i ON i.event_id=e.id
    WHERE e.status='posted' AND e.id<>? AND i.status IN ('planned','blocked-closed-period','posted')
      AND (i.account_id=? OR (i.account_id IS NULL AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id=e.journal_entry_id AND l.account_id=?)))
    ORDER BY e.occurred_at,e.rowid`).all(String(excludeEventId || ''), accountId, accountId)
    .map((row) => {
      const event = JSON.parse(row.payload);
      const position = contractPosition(database, row.id, cutoff);
      const entry = row.journalEntryId ? database.prepare('SELECT document_number AS documentNumber FROM journal_entries WHERE id=?').get(row.journalEntryId) : null;
      return {
        eventId: row.id, remaining: position.remaining, recognisedAfterEnd: position.postedAfterTotal,
        documentNumber: entry?.documentNumber ?? null, occurredAt: event.occurredAt, amount: event.amount,
        servicePeriodStart: event.servicePeriodStart || null, servicePeriodEnd: event.servicePeriodEnd || null,
        category: event.category || '', counterparty: event.counterparty || '', evidence: String(event.utterance || event.evidence || '').slice(0, 200),
      };
    })
    .filter((item) => item.remaining > 0 || item.recognisedAfterEnd > 0);
}

/** ابتدای ماه شمسیِ یک قلم، از کلید دوره‌اش («۱۴۰۵-۱۰» → اول دی ۱۴۰۵). */
function periodStartOf(periodKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(periodKey || ''));
  return match ? persianToISO(Number(match[1]), Number(match[2]), 1) : null;
}

/**
 * جای قرارداد در لحظهٔ استرداد: بخش شناسایی‌نشده، و ماه‌هایی که پس از پایان
 * قرارداد (`cutoff`) شروع شده‌اند ولی پیش‌تر سند خورده‌اند.
 *
 * شناسایی هر دقیقه اجرا می‌شود؛ پولِ استرداد معمولاً روزها پس از فسخ می‌رسد و
 * تا آن روز ماه‌های بعد از فسخ هزینه (یا درآمد) شده‌اند. پوششی که پس از پایان
 * قرارداد نبوده، هزینه یا درآمد هم نیست؛ این ماه‌ها جزو بخشی‌اند که استرداد
 * می‌تواند برگرداند. قلم پایانی و جبرانیِ استرداد قبلی جزو ماه‌های پوشش نیستند.
 */
function contractPosition(database, contractEventId, cutoff = null) {
  const rows = database.prepare(`SELECT key,period_key AS periodKey,amount,status FROM recognition_schedule_items
    WHERE event_id=? AND status IN ('planned','blocked-closed-period','posted') ORDER BY period_key,key`).all(contractEventId);
  const remaining = rows.filter((item) => item.status !== SCHEDULE_ITEM_STATUS.POSTED).reduce((sum, item) => sum + item.amount, 0);
  const floor = cutoff ? Date.parse(cutoff) : NaN;
  const postedAfter = Number.isNaN(floor) ? [] : rows.filter((item) => item.status === SCHEDULE_ITEM_STATUS.POSTED
    && !/:(?:close|restore):/.test(item.key) && Date.parse(periodStartOf(item.periodKey)) >= floor);
  const postedAfterTotal = postedAfter.reduce((sum, item) => sum + item.amount, 0);
  return { remaining, postedAfter, postedAfterTotal, available: remaining + postedAfterTotal };
}

/**
 * پایان خودِ قرارداد — نه هر «قطع شد»ی.
 *
 * «فسخ» و «تخلیه» فقط دربارهٔ قرارداد گفته می‌شوند. «کنسل»، «لغو»، «ابطال»،
 * «قطع» و «تمام» فقط وقتی پایان‌اند که فاعل یا مفعولشان خود قرارداد باشد («بیمه
 * رو کنسل کردیم»، «اشتراک قطع شد»، «قرارداد تمام شد»)؛ «آب انبار قطع شد» یا «برق
 * دو هفته قطع شد» قرارداد را تمام نمی‌کند. «تمدید نکرد» یعنی در سررسید ادامه
 * ندارد، نه امروز. فعل منفی («تخلیه نکرده»، «فسخ نشد») پایان نیست.
 */
const CONTRACT_NOUN = '(?:قرارداد|بیمه(?:\\s*نامه)?|اشتراک|اجاره(?:\\s*نامه)?|لایسنس|عضویت|اکانت|پشتیبانی|سرویس\\s*(?:پشتیبانی|نرم\\s*افزار|ابری|هاستینگ|میزبانی))';
const END_SOLE_VERB = /(?:فسخ|تخلیه)(?!\s*ن(?:کرد|کردیم|کرده|کردند|شد|شده|می|میکن|میشه))/;
const END_CONTRACT_VERB = new RegExp(`${CONTRACT_NOUN}[^،,.؛!؟?]{0,60}?(?:کنسل|لغو|ابطال|باطل|خاتمه|قطع|تمام)(?:\\s*(?:کردیم|کردند|کرد|کرده|شده|شد|گردید|دادیم|داد))(?![آ-ی])`);
const CONTRACT_ENDED = new RegExp(`${END_SOLE_VERB.source}|${END_CONTRACT_VERB.source}|پایان\\s*(?:قرارداد|همکاری)|خاتمه\\s*(?:قرارداد|همکاری)`);
const CONTRACT_CONTINUES = /ادامه\s*(?:دارد|داره|می\s*دهیم|میدیم|می\s*دهد|میده|پیدا)|تخفیف|کاهش\s*(?:پوشش|مبلغ|نرخ|اجاره|حق)|ارزان\s*تر|کمتر\s*شد/;

/** از متن: `true` پایان، `false` ادامه، `null` نامعلوم یا متناقض. */
function contractEndedFrom(text) {
  const normalized = normalizePersian(text);
  const ended = CONTRACT_ENDED.test(normalized);
  const continues = CONTRACT_CONTINUES.test(normalized);
  return ended === continues ? null : ended;
}

/**
 * جواب کوتاه به سؤال «تمام شد یا ادامه دارد؟» — «تمام شد»، «فسخ شد»، «نه، ادامه
 * دارد». جواب، سؤالِ خودش را دارد؛ فعل بی‌نام قرارداد اینجا کافی است.
 */
function contractEndedFromAnswer(text) {
  const fromText = contractEndedFrom(text);
  if (fromText !== null) return fromText;
  const normalized = normalizePersian(text);
  const negated = /(?:^|\s)(?:نه|خیر)(?=$|\s|[،,.])|(?:^|\s)ن(?:شد|شده|کرد|کرده|کردیم|کردند|میشه|می\s*شود)(?=$|\s|[،,.])/.test(normalized);
  const endWord = /(?:^|\s)(?:تمام|خاتمه|پایان|کنسل|لغو|باطل|فسخ|تخلیه)/.test(normalized);
  // «ادامه نداره»، «برقرار نیست» پایان‌اند؛ «فسخ نشده»، «هنوز تخلیه نکرده» ادامه.
  const stops = /ادامه\s*ن(?:دار|داد|می)|برقرار\s*نیست/.test(normalized);
  const goesOn = /ادامه(?!\s*ن(?:دار|داد|می))|هنوز|برقرار(?!\s*نیست)/.test(normalized);
  const ended = (endWord && !negated) || stops;
  const continues = goesOn || (endWord && negated);
  return ended === continues ? null : ended;
}

const MONTH_NAMES = 'فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند';
const END_VERB = '(?:فسخ|تخلیه|کنسل|لغو|ابطال|خاتمه)';
const END_DATE = `((?:(?:\\d{1,2}|اول|آخر|اخر|[آ-ی]+م)\\s+)?(?:${MONTH_NAMES})(?:\\s+ماه)?(?:\\s+(?:سال\\s+)?\\d{4})?)`;
/** «از اول دی فسخ کردیم»، «۱۵ آذر تخلیه کرد»، «از ۶ دی به بعد کنسل شد». */
const END_DATE_BEFORE = new RegExp(`(?:^|\\s)(?:از\\s+)?${END_DATE}\\s+(?:به\\s+بعد\\s+)?(?:(?:رو|را)\\s+)?${END_VERB}`);
/** «فسخ کردیم از اول دی»، «تخلیه کرد در ۱۵ آذر». */
const END_DATE_AFTER = new RegExp(`${END_VERB}\\S*\\s+(?:(?:کردیم|کرد|کردن|کردند|شد|شده|کرده)\\s+)?(?:از|در|به\\s+تاریخ|تاریخ)\\s+${END_DATE}`);

/**
 * یک تاریخ شمسی به لحظهٔ ISO؛ سالِ نگفته نزدیک‌ترین سال به تاریخ استرداد است
 * («اول دی» برای استرداد ۶ دی همین دی است، برای استرداد فروردین دیِ پارسال).
 */
function nearestJalali(text, reference) {
  const named = readJalaliExpression(text);
  if (!named) return readTypedDate(text, { now: new Date(reference) });
  const base = todayPersian(new Date(reference)).year + (named.yearOffset || 0);
  const years = named.year ? [named.year] : [base - 1, base, base + 1];
  const target = Date.parse(reference);
  let best = null;
  for (const year of years) {
    let iso = null;
    if (named.end) {
      const next = named.month === 12 ? persianToISO(year + 1, 1, 1) : persianToISO(year, named.month + 1, 1);
      iso = next ? new Date(Date.parse(next) - 86_400_000).toISOString() : null;
    } else iso = persianToISO(year, named.month, named.day || 1);
    if (iso && (!best || Math.abs(Date.parse(iso) - target) < Math.abs(Date.parse(best) - target))) best = iso;
  }
  return best;
}

/**
 * تاریخ پایان قرارداد، فقط وقتی کنار فعل پایان آمده باشد. تاریخی که جای دیگری از
 * جمله است (شروع پوشش، تاریخ خرید) تاریخ فسخ خوانده نمی‌شود.
 */
function contractEndDateFrom(text, reference) {
  const normalized = normalizePersian(text);
  const match = END_DATE_BEFORE.exec(normalized) || END_DATE_AFTER.exec(normalized);
  return match ? nearestJalali(match[1], reference) : null;
}

/**
 * جواب‌های حسابدار دربارهٔ قرارداد: کدام قرارداد و تمام شد یا ادامه دارد.
 *
 * سؤال «کدام قرارداد؟» با شمارهٔ سند یا نام طرف یا دستهٔ همان قرارداد جواب
 * داده می‌شود؛ جوابی که دقیقاً به یک نامزد نخورد، دوباره پرسیده می‌شود.
 */
function reviewContractAnswers(database, eventId, event = {}) {
  const result = { reference: [], ended: [], endedAt: [] };
  for (const [id, value, question] of reviewTextAnswers(database, eventId, event)) {
    if (/contract[_.-]?(?:ended[_.-]?at|end[_.-]?date|cancel(?:led)?[_.-]?(?:at|date)|termination)/i.test(id)
      || /(?:از\s*چه\s*تاریخی|چه\s*تاریخی|از\s*کی|چه\s*روزی|تاریخ).{0,30}(?:فسخ|تخلیه|پایان|تمام|کنسل|لغو)/.test(question)) result.endedAt.push(value);
    else if (/contract[_.-]?(?:ended|end|status|continue)/i.test(id) || /تمام\s*شد|ادامه\s*دارد/.test(question)) result.ended.push(value);
    else if (/contract|refund[_.-]?(?:source|reference)/i.test(id) || /کدام\s*قرارداد|قرارداد\s*اصلی/.test(question)) result.reference.push(value);
  }
  return result;
}

/** «سند ۱۸»، «سند شمارهٔ ۱۸»، «شماره ۱۸»، «#۱۸» — شمارهٔ سندی که صریحاً نام برده شد. */
const DOCUMENT_REFERENCE = /(?:سند|شماره|#)(?:[\s\u200cٔ]*(?:ی|سند|شماره|ه))*[\s\u200cٔ]*[#:]?\s*(\d+)(?![\d])/g;
/** واژه‌ای که پس از عدد آمد، آن را تاریخ، مبلغ یا مدت می‌کند، نه شمارهٔ سند. */
const NOT_DOCUMENT_AFTER = new RegExp(`^\\s*(?:${MONTH_NAMES}|هزار|میلیون|میلیارد|تومن|تومان|ریال|ماهه|ماه|ساله|سال|روز|درصد|تا)(?![آ-ی])`);

/** شماره‌های سندی که جواب صریحاً گفت؛ جوابِ فقط-عدد هم به سؤال «شمارهٔ سند؟» شماره است. */
function documentNumbersIn(normalized) {
  const bare = /^\s*#?\s*(\d+)\s*[.؟?!]?\s*$/.exec(normalized);
  if (bare) return [Number(bare[1])];
  const numbers = [];
  for (const match of normalized.matchAll(DOCUMENT_REFERENCE)) {
    if (!NOT_DOCUMENT_AFTER.test(normalized.slice(match.index + match[0].length))) numbers.push(Number(match[1]));
  }
  return numbers;
}

/** تاریخ یک نامزد با «۱۸ مهر»ِ جواب می‌خواند — روز ضبط یا شروع پوشش. */
function contractOnDate(candidate, named) {
  return [candidate.occurredAt, candidate.servicePeriodStart].filter(Boolean).some((iso) => {
    const parts = todayPersian(new Date(iso));
    return parts.month === named.month && (!named.day || parts.day === named.day) && (!named.year || parts.year === named.year);
  });
}

/**
 * کدام قرارداد؟ — از جواب حسابدار.
 *
 * هر نشانه‌ای که جواب گفت، نامزدها را جدا می‌کند و قرارداد باید با همهٔ آن‌ها
 * بخواند: شمارهٔ سندِ صریح («سند ۱۸»)، تاریخ («که ۱۸ مهر گرفتیم»)، مبلغ («همون
 * ۶۰ میلیونی»)، مدت («سه ماهه») و نام طرف یا دسته. عددی که کنار نام ماه،
 * «میلیون» یا «ماهه» آمده شمارهٔ سند نیست. نشانه‌ای که به هیچ نامزدی نخورد،
 * یا نشانه‌هایی که به دو قرارداد مختلف اشاره کنند، یعنی دوباره بپرس — حدس نه.
 */
function pickContract(candidates, references) {
  for (const text of references) {
    const normalized = normalizePersian(text);
    const signals = [];
    const numbers = documentNumbersIn(normalized);
    if (numbers.length) signals.push(candidates.filter((item) => item.documentNumber != null && numbers.includes(Number(item.documentNumber))));
    const named = readJalaliExpression(normalized);
    if (named) signals.push(candidates.filter((item) => contractOnDate(item, named)));
    const amounts = extractAmounts(normalized).spans.map((span) => span.amount).filter((value) => value >= 1000);
    if (amounts.length) signals.push(candidates.filter((item) => amounts.includes(Number(item.amount))));
    const length = readCoverageLength(normalized);
    if (length) signals.push(candidates.filter((item) => coverageMonths(item.servicePeriodStart, item.servicePeriodEnd) === length.months));
    const byName = candidates.filter((item) => [item.counterparty, item.category].some((name) => name && normalized.includes(normalizePersian(name))));
    if (byName.length) signals.push(byName);
    if (!signals.length || signals.some((matched) => !matched.length)) continue;
    const chosen = candidates.filter((item) => signals.every((matched) => matched.includes(item)));
    if (chosen.length === 1) return chosen[0];
  }
  return null;
}

function contractQuestionError(text, id, extra = {}) {
  return Object.assign(storeError(text, 'REVIEW_DETAILS_REQUIRED', 409), { question: { id, text }, ...extra });
}

/**
 * سطرهای سند حسابدار که ماندهٔ یک قرارداد دوره‌دار را کم می‌کنند — پیش از ثبت.
 *
 * بستانکارِ پیش‌پرداخت خدمت (بیمه‌گر حق بیمه را برگرداند، اشتراک کنسل شد) یا
 * بدهکارِ درآمد انتقالی (به مستأجری که زودتر تخلیه کرد پس دادیم). برای هرکدام:
 *
 * - قرارداد زنده‌ای روی آن حساب نیست: فقط وقتی ثبت می‌شود که ماندهٔ واقعی حساب
 *   برای استرداد کافی باشد؛ برنامه‌ای نیست که کم شود.
 * - یکی هست: همان قرارداد.
 * - چندتا هست: کدام؟ پرسیده می‌شود (`contract.reference`)، با فهرست نامزدها —
 *   حدس نمی‌زنیم کدام بیمه یا کدام اجاره.
 * - استرداد از بخش شناسایی‌نشدهٔ قرارداد بیشتر است: ثبت نمی‌شود.
 * - کمتر است و از متن یا جواب معلوم نیست قرارداد تمام شد یا ادامه دارد:
 *   پرسیده می‌شود (`contract.ended`)؛ نتیجهٔ این دو در دفتر فرق دارد.
 */
export function reviewedContractReductions(database, eventId, event, lines, { contractEventId = null, contractEnded = null, contractEndedAt = null, reason = '' } = {}) {
  const totals = new Map();
  for (const line of lines || []) {
    const kind = timingAccountKind(database, line.accountId, event);
    if (!kind) continue;
    const entry = totals.get(line.accountId) || { accountId: line.accountId, kind, amount: 0 };
    entry.amount += kind === 'prepaid' ? (line.credit || 0) - (line.debit || 0) : (line.debit || 0) - (line.credit || 0);
    totals.set(line.accountId, entry);
  }
  const reductions = [];
  const at = event.occurredAt || new Date().toISOString();
  const text = `${event.utterance || event.evidence || ''} ${reason}`;
  for (const reduction of [...totals.values()].filter((entry) => entry.amount > 0)) {
    const answers = reviewContractAnswers(database, eventId, event);
    const said = typeof contractEnded === 'boolean' ? contractEnded
      : [...answers.ended.map(contractEndedFromAnswer), contractEndedFrom(text)].find((value) => value !== null) ?? null;
    // تاریخ پایان: انتخاب صریح، جواب سؤال، یا کنار فعل پایان در متن. نگفته، روز
    // استرداد است — کمترین برگشتی که لازم است.
    const explicitEnd = contractEndedAt && !Number.isNaN(Date.parse(contractEndedAt)) ? new Date(contractEndedAt).toISOString() : null;
    const statedEnd = said === false ? null
      : explicitEnd || answers.endedAt.map((value) => nearestJalali(value, at)).find(Boolean) || contractEndDateFrom(text, at);
    const cutoff = statedEnd || at;
    const candidates = liveContractsOn(database, reduction.accountId, eventId, { cutoff: said === false ? null : cutoff });
    const label = reduction.kind === 'deferred' ? 'درآمد انتقالی' : 'پیش‌پرداخت';
    if (!candidates.length) {
      const available = reduction.kind === 'prepaid' ? ledgerBalance(database, reduction.accountId) : -ledgerBalance(database, reduction.accountId);
      if (available < reduction.amount) {
        throw storeError(`ماندهٔ ${label} این حساب (${available.toLocaleString('fa-IR')} تومان) برای این استرداد کافی نیست و قرارداد زنده‌ای هم رویش نیست؛ سند مبنای قرارداد یا مانده را بررسی کن.`, 'REVIEW_DETAILS_REQUIRED', 409);
      }
      continue;
    }
    const chosen = contractEventId ? candidates.find((item) => item.eventId === contractEventId) || null
      : candidates.length === 1 ? candidates[0] : pickContract(candidates, answers.reference);
    if (contractEventId && !chosen) throw storeError('قرارداد انتخاب‌شده روی این حساب برنامهٔ زنده‌ای ندارد.', 'REVIEW_DETAILS_REQUIRED', 409);
    if (!chosen) {
      throw contractQuestionError(`این استرداد کدام قرارداد را کم می‌کند؟ چند قرارداد زنده روی همین حساب ${label} هست؛ «سند شمارهٔ …»، تاریخ، مبلغ یا مدت همان قرارداد را بگو.`, 'contract.reference', { candidates });
    }
    const amount = (value) => value.toLocaleString('fa-IR');
    if (said === false && reduction.amount > chosen.remaining) {
      throw storeError(`استرداد (${amount(reduction.amount)} تومان) از بخش شناسایی‌نشدهٔ قرارداد (${amount(chosen.remaining)} تومان) بیشتر است؛ قراردادی که ادامه دارد بیش از این برنمی‌گرداند. مبلغ یا قرارداد را بررسی کن.`, 'REVIEW_DETAILS_REQUIRED', 409);
    }
    const available = chosen.remaining + chosen.recognisedAfterEnd;
    if (reduction.amount > available) {
      // ماه‌هایی که پیش از روز استرداد شناسایی شده‌اند فقط وقتی برمی‌گردند که
      // قرارداد پیش از آن‌ها تمام شده باشد؛ آن تاریخ را حدس نمی‌زنیم.
      if (!statedEnd) {
        throw contractQuestionError(`استرداد (${amount(reduction.amount)} تومان) از بخش شناسایی‌نشدهٔ قرارداد (${amount(chosen.remaining)} تومان) بیشتر است؛ اگر قرارداد پیش‌تر تمام شده و ماه‌های بعد از آن شناسایی شده‌اند، قرارداد از چه تاریخی تمام شد (فسخ یا تخلیه)؟`, 'contract.end-date', { candidates: [chosen] });
      }
      throw storeError(`استرداد (${amount(reduction.amount)} تومان) از بخش پوشش‌نیافتهٔ قرارداد از ${persianDay(statedEnd)} به بعد (${amount(available)} تومان) بیشتر است؛ مبلغ یا تاریخ پایان را بررسی کن.`, 'REVIEW_DETAILS_REQUIRED', 409);
    }
    if (said === null && reduction.amount < chosen.remaining) {
      throw contractQuestionError('قرارداد با این استرداد تمام شد (فسخ، تخلیه) یا با مبلغ کمتر ادامه دارد؟', 'contract.ended', { candidates: [chosen] });
    }
    reductions.push({ ...reduction, contractEventId: chosen.eventId, ended: said !== false, remaining: chosen.remaining, cutoff: said === false ? null : cutoff, endedAt: statedEnd });
  }
  return reductions;
}

/** کلید ماه شمسیِ یک تاریخ، مثل «۱۴۰۵-۱۰». */
function persianPeriodKey(iso, timeZone = 'Asia/Tehran') {
  const parts = todayPersian(new Date(iso), timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}`;
}

/**
 * برنامهٔ یک قرارداد پس از استرداد — در همان تراکنش سند استرداد.
 *
 * - **پایان قرارداد** (فسخ، تخلیه): همهٔ اقلام زنده باطل می‌شوند و یک قلم
 *   پایانی به تاریخ استرداد، به اندازهٔ «ماندهٔ شناسایی‌نشده منهای استرداد»،
 *   ساخته می‌شود — بخشی که برنگشت و در لحظهٔ فسخ هزینه (یا درآمد) است. پایان
 *   کار: حساب پیش‌پرداخت یا درآمد انتقالی دقیقاً صفر.
 * - **ادامه با مبلغ کمتر**: اقلام آینده بازقیمت‌گذاری می‌شوند تا جمعشان همان
 *   مانده منهای استرداد شود، با همان گرد کردن برنامهٔ ماهانه (ته‌مانده روی قلم
 *   آخر).
 */
export function reduceContractSchedule(database, contractEventId, { refund, at, ended, refundEventId, accountId = null, cutoff = null, actor = null, timeZone = 'Asia/Tehran' } = {}) {
  const live = database.prepare(`SELECT key,period_key AS periodKey,recognition_date AS recognitionDate,amount,status FROM recognition_schedule_items
    WHERE event_id=? AND status IN ('planned','blocked-closed-period') ORDER BY period_key,key`).all(contractEventId);
  const remaining = live.reduce((sum, item) => sum + item.amount, 0);
  // ماه‌هایی که پس از پایان قرارداد شروع شده ولی پیش‌تر سند خورده‌اند — فقط
  // برای قراردادی که تمام شد.
  const position = ended ? contractPosition(database, contractEventId, cutoff || at) : { postedAfter: [], postedAfterTotal: 0 };
  if (!(refund > 0) || refund > remaining + position.postedAfterTotal) throw storeError('استرداد از بخش شناسایی‌نشدهٔ قرارداد بیشتر است.', 'REVIEW_DETAILS_REQUIRED', 409);
  const supersede = database.prepare("UPDATE recognition_schedule_items SET status='superseded' WHERE key=?");
  // وضعیت پیشینِ هر قلمی که این استرداد عوض می‌کند: برگشت استرداد همین را باز
  // می‌گرداند، نه برنامه‌ای حدسی.
  const touched = [];
  const reversedPosted = [];
  let closing = null;
  if (ended) {
    for (const item of live) { touched.push({ key: item.key, amount: item.amount, status: item.status }); supersede.run(item.key); }
    // پوششی که پس از پایان نبوده، هزینه یا درآمد هم نیست: سندش به تاریخ همین
    // استرداد معکوس می‌شود — دورهٔ گذشته (شاید بسته) بازنویسی نمی‌شود.
    for (const item of position.postedAfter) {
      const reversal = reverseJournalEntry(database, {
        sourceType: 'recognition-schedule', sourceId: item.key, occurredAt: at, createdBy: actor, timeZone,
        memo: `برگشت شناسایی ${item.periodKey} پس از پایان قرارداد`,
      });
      supersede.run(item.key);
      reversedPosted.push({ key: item.key, periodKey: item.periodKey, amount: item.amount, reversalEntryId: reversal?.id || null });
    }
    const left = remaining + position.postedAfterTotal - refund;
    if (left > 0) {
      const periodKey = persianPeriodKey(at, timeZone);
      const locked = lockedPeriodSet(database).has(periodForDate(at, timeZone));
      closing = { key: `${contractEventId}:${periodKey}:close:${refundEventId}`, periodKey, recognitionDate: at, amount: left };
      database.prepare(`INSERT INTO recognition_schedule_items (key,event_id,period_key,recognition_date,amount,status,account_id) VALUES (?,?,?,?,?,?,?)`)
        .run(closing.key, contractEventId, periodKey, at, left, locked ? SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD : SCHEDULE_ITEM_STATUS.PLANNED, accountId);
      if (locked) writeAudit(database, contractEventId, 'recognition-blocked', blockedDetail(closing, timeZone), actor);
    }
  } else {
    // ماه‌های آینده بار کاهش را می‌برند؛ اگر کافی نیستند، همهٔ اقلام زنده.
    const future = live.filter((item) => item.recognitionDate > at);
    const pool = future.reduce((sum, item) => sum + item.amount, 0) >= refund ? future : live;
    const target = pool.reduce((sum, item) => sum + item.amount, 0) - refund;
    const share = Math.floor(target / pool.length);
    const reprice = database.prepare('UPDATE recognition_schedule_items SET amount=? WHERE key=?');
    pool.forEach((item, index) => {
      const amount = index === pool.length - 1 ? target - (share * (pool.length - 1)) : share;
      touched.push({ key: item.key, amount: item.amount, status: item.status });
      if (amount > 0) reprice.run(amount, item.key); else supersede.run(item.key);
    });
  }
  const detail = {
    refundEventId, refund, at, cutoff: ended ? (cutoff || at) : null, remainingBefore: remaining,
    remainingAfter: Math.max(0, remaining + position.postedAfterTotal - refund), ended: Boolean(ended), closingItem: closing, touched, reversedPosted,
  };
  writeAudit(database, contractEventId, 'contract-reduced', detail, actor);
  return detail;
}

/**
 * استردادهای ثبت‌شده‌ای که برنامهٔ یک قرارداد را کم کرده‌اند — به ترتیب ثبت.
 *
 * پیوند در ردپای `contract-linked` خودِ استرداد است؛ استردادِ برگشت‌خورده دیگر
 * پیوند زنده نیست.
 */
function linkedRefunds(database, contractEventId) {
  return database.prepare(`SELECT a.rowid AS auditRow,a.event_id AS eventId,a.detail,j.document_number AS documentNumber
    FROM financial_event_audit a JOIN financial_events e ON e.id=a.event_id LEFT JOIN journal_entries j ON j.id=e.journal_entry_id
    WHERE a.stage='contract-linked' AND json_extract(a.detail,'$.contractEventId')=? AND e.status='posted'
    ORDER BY a.rowid`).all(String(contractEventId || ''))
    .map((row) => ({ ...row, detail: JSON.parse(row.detail || '{}') }));
}

function refundLabel(refunds) {
  return refunds.map((item) => (item.documentNumber != null ? `سند ${Number(item.documentNumber).toLocaleString('fa-IR', { useGrouping: false })}` : item.eventId)).join('، ');
}

/**
 * برگشت استرداد، برنامهٔ قرارداد را به پیش از آن برمی‌گرداند — در همان تراکنش.
 *
 * استرداد سه اثر روی برنامه داشت و هر سه برمی‌گردند:
 *
 * - **قلم پایانی** (بخشی که برنگشت و در لحظهٔ فسخ هزینه یا درآمد شد): اگر سند
 *   خورده، سندش معکوس می‌شود؛ وگرنه باطل.
 * - **اقلام باطل‌شده یا بازقیمت‌گذاری‌شده**: با مبلغ و وضعیت پیشین برمی‌گردند
 *   (قلمی که حالا در دورهٔ بسته می‌افتد، منتظر دورهٔ بسته).
 * - **آنچه از آن پس با مبلغ کمتر سند خورده یا معکوس شده** قابل بازگرداندن روی
 *   همان قلم نیست؛ تفاوتش یک قلم جبرانی به تاریخ خودِ استرداد می‌شود.
 *
 * پایان کار: جمع اقلام شناسایی‌نشدهٔ قرارداد دوباره برابر ماندهٔ حساب دوره‌دار
 * است — پیش‌پرداخت سرگردان یا درآمد انتقالیِ ابدی نمی‌ماند.
 */
function restoreContractSchedule(database, link, { actor = null, timeZone = 'Asia/Tehran', memo = 'برگشت استرداد' } = {}) {
  const detail = link.detail || {};
  const contractEventId = detail.contractEventId;
  if (!contractEventId) return null;
  if (!Array.isArray(detail.touched)) {
    throw storeError('ردپای این استرداد برای بازگرداندن برنامهٔ قرارداد کافی نیست؛ برنامهٔ قرارداد را حسابدار بررسی کند.', 'REFUND_LINK_UNRESTORABLE', 409);
  }
  const contract = database.prepare('SELECT payload FROM financial_events WHERE id=?').get(contractEventId);
  const contractEvent = contract ? JSON.parse(contract.payload) : {};
  const lockedPeriods = lockedPeriodSet(database);
  const statusFor = (date) => (lockedPeriods.has(periodForDate(notBeforeDate(date, contractEvent.occurredAt), timeZone))
    ? SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD : SCHEDULE_ITEM_STATUS.PLANNED);
  const itemRow = database.prepare(`SELECT key,status,amount,recognition_date AS recognitionDate,period_key AS periodKey,account_id AS accountId
    FROM recognition_schedule_items WHERE key=?`);
  const supersede = database.prepare("UPDATE recognition_schedule_items SET status='superseded' WHERE key=?");
  const reversalEntryIds = [];
  let shortfall = 0;
  if (detail.closingItem?.key) {
    const closing = itemRow.get(detail.closingItem.key);
    if (closing?.status === SCHEDULE_ITEM_STATUS.POSTED) {
      const reversal = reverseJournalEntry(database, { sourceType: 'recognition-schedule', sourceId: closing.key, memo, createdBy: actor, timeZone });
      if (reversal) reversalEntryIds.push(reversal.id);
    }
    if (closing) supersede.run(closing.key);
  }
  const restored = [];
  const restore = database.prepare('UPDATE recognition_schedule_items SET amount=?,status=? WHERE key=?');
  for (const before of detail.touched) {
    const current = itemRow.get(before.key);
    if (!current) continue;
    // از آن پس با مبلغ بازقیمت‌گذاری‌شده سند خورده: تفاوت جبران می‌شود.
    if (current.status === SCHEDULE_ITEM_STATUS.POSTED) { shortfall += before.amount - current.amount; continue; }
    const status = statusFor(current.recognitionDate);
    restore.run(before.amount, status, before.key);
    restored.push({ key: before.key, amount: before.amount, status });
  }
  // ماه‌هایی که پس از تاریخ پایان سند خورده بودند و استرداد معکوسشان کرد.
  for (const reversed of detail.reversedPosted || []) shortfall += Number(reversed.amount) || 0;
  let compensation = null;
  if (shortfall > 0) {
    const at = detail.at || contractEvent.occurredAt;
    const periodKey = persianPeriodKey(at, timeZone);
    compensation = { key: `${contractEventId}:${periodKey}:restore:${detail.refundEventId || link.eventId}`, periodKey, recognitionDate: at, amount: shortfall };
    const status = statusFor(at);
    database.prepare(`INSERT INTO recognition_schedule_items (key,event_id,period_key,recognition_date,amount,status,account_id) VALUES (?,?,?,?,?,?,?)`)
      .run(compensation.key, contractEventId, periodKey, at, shortfall, status, detail.accountId ?? null);
    if (status === SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD) writeAudit(database, contractEventId, 'recognition-blocked', blockedDetail(compensation, timeZone), actor);
  }
  const result = { refundEventId: detail.refundEventId || link.eventId, restored, closingReversed: reversalEntryIds, compensation };
  writeAudit(database, contractEventId, 'contract-restored', result, actor);
  return result;
}

/** ثبتِ بررسی‌شدهٔ گفتهٔ چندمبلغی؛ حسابدار حساب‌ها و همهٔ مبالغ را صریح انتخاب می‌کند. */
export function postReviewedComposite(database, eventId, { lines, reason, actor = null, timeZone = 'Asia/Tehran', accountantProposal = false, eventOverride = null, contractEventId = null, contractEnded = null, contractEndedAt = null } = {}) {
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
  // دورهٔ پوشش پیش از سند: سطر دوره‌دارِ بی‌دوره ثبت نمی‌شود.
  const timing = reviewedTimingPlan(database, row.id, event, safeLines);
  if (timing) {
    // دستهٔ هزینه یا درآمد ماهانه پیش از سند: نامعلومش پرسیده می‌شود.
    const chosen = reviewedTimingCategory(database, row.id, event, timing, lines);
    if (!chosen.category && chosen.question) throw Object.assign(storeError(chosen.question.text, 'REVIEW_DETAILS_REQUIRED', 409), { question: chosen.question });
    Object.assign(timing, { category: chosen.category, categoryBasis: chosen.basis });
  }
  // استرداد پیش از سند: قرارداد و سرنوشتش باید معلوم باشد.
  const reductions = reviewedContractReductions(database, row.id, event, safeLines, { contractEventId, contractEnded, contractEndedAt, reason: explanation });
  const source = row.journal_source ? JSON.parse(row.journal_source) : null;
  const posted = postJournalEntry(database, {
    sourceType: source?.type || 'financial-event', sourceId: source?.id || row.id, occurredAt: event.occurredAt,
    memo: `ثبت بررسی‌شده: ${explanation}`.slice(0, 500), lines: safeLines,
  }, { createdBy: actor, timeZone });
  database.prepare('UPDATE financial_events SET posting_plan=? WHERE id=?').run(JSON.stringify({
    kind: 'accountant-reviewed', lines: safeLines, memoHint: explanation,
  }), row.id);
  if (eventOverride) database.prepare('UPDATE financial_events SET payload=?,occurred_at=?,due_at=? WHERE id=?').run(JSON.stringify(event),event.occurredAt,event.dueAt || null,row.id);
  const reconciled = reconcileReviewedRecognition(database, row, event, timing, { actor, timeZone, journalEntryId: posted.id });
  for (const reduction of reductions) {
    const detail = reduceContractSchedule(database, reduction.contractEventId, {
      refund: reduction.amount, at: event.occurredAt, ended: reduction.ended, refundEventId: row.id, accountId: reduction.accountId, cutoff: reduction.cutoff, actor, timeZone,
    });
    writeAudit(database, row.id, 'contract-linked', { contractEventId: reduction.contractEventId, accountId: reduction.accountId, ...detail }, actor);
  }
  if (reductions.length) {
    const current = JSON.parse(database.prepare('SELECT payload FROM financial_events WHERE id=?').get(row.id).payload);
    database.prepare('UPDATE financial_events SET payload=? WHERE id=?')
      .run(JSON.stringify({ ...(reconciled || current), contractEventId: reductions[0].contractEventId }), row.id);
  }
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

  // قراردادی که استرداد ثبت‌شده‌ای برنامه‌اش را کم کرده، تا آن استرداد سر جایش
  // است برنمی‌گردد — همان قاعدهٔ اثر وابستهٔ موجودی و چک. برگشت قرارداد همهٔ
  // پرداخت را برمی‌گرداند؛ استردادِ ماندهٔ بخشی از همان پول، پیش‌پرداخت را
  // بستانکار (و درآمد انتقالی را بدهکار، «مستأجر به ما بدهکار است») می‌کرد.
  const dependents = linkedRefunds(database, row.id).filter((link) => link.eventId !== row.id);
  if (dependents.length) {
    throw storeError(`این قرارداد استرداد ثبت‌شده دارد (${refundLabel(dependents)})؛ اول آن استرداد را برگردان، بعد خود قرارداد را.`, 'EVENT_HAS_LINKED_REFUND', 409);
  }
  // استردادی که به قرارداد وصل است: برنامهٔ قرارداد هم با آن برمی‌گردد. استرداد
  // دیگری که بعد از آن همان قرارداد را کم کرده، اول باید برگردد؛ وگرنه
  // بازگرداندن وضعیت پیشین اثر استرداد بعدی را پاک می‌کرد.
  const ownLinks = database.prepare("SELECT rowid AS auditRow,event_id AS eventId,detail FROM financial_event_audit WHERE event_id=? AND stage='contract-linked' ORDER BY rowid DESC")
    .all(row.id).map((link) => ({ ...link, detail: JSON.parse(link.detail || '{}') }));
  for (const link of ownLinks) {
    const later = linkedRefunds(database, link.detail.contractEventId).filter((other) => other.eventId !== row.id && other.auditRow > link.auditRow);
    if (later.length) {
      throw storeError(`پس از این استرداد، استرداد دیگری همان قرارداد را کم کرده (${refundLabel(later)})؛ اول آن را برگردان.`, 'EVENT_HAS_LINKED_REFUND', 409);
    }
  }
  const restoreLinks = () => {
    const memo = reason ? `برگشت استرداد: ${reason}`.slice(0, 200) : 'برگشت استرداد';
    return ownLinks.map((link) => restoreContractSchedule(database, link, { actor, timeZone, memo }));
  };

  // سند این رویداد ممکن است به تراکنش لنگر خورده باشد، نه به خودِ رویداد.
  // جست‌وجوی لنگر اشتباه چیزی پیدا نمی‌کند و `reverseJournalEntry` بی‌صدا
  // `null` برمی‌گرداند — رویداد «معکوس‌شده» علامت می‌خورد ولی سندش سر جایش
  // می‌ماند. بدترین نوع خطا: دفتر غلط است و هیچ نشانه‌ای ندارد.
  const anchor = row.journal_source ? JSON.parse(row.journal_source) : null;
  // برنامهٔ ماندهٔ بی‌سند سند خودش را ندارد؛ برگشتش فقط برنامه را برمی‌گرداند و
  // سند مبنا (افتتاحیه، سند دستی) هرگز از این مسیر معکوس نمی‌شود.
  if (row.kind === 'balance-recognition') {
    if (!withinTransaction) database.exec('BEGIN IMMEDIATE');
    try {
      retireRecognitionSchedule(database, row.id, { actor, timeZone, memo: reason ? `برگشت شناسایی: ${reason}`.slice(0, 200) : undefined });
      database.prepare("UPDATE financial_events SET status='reversed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
      writeAudit(database, row.id, 'reversed', { reason: String(reason || '').slice(0, 300), scheduleOnly: true }, actor);
      if (!withinTransaction) database.exec('COMMIT');
    } catch (error) { if (!withinTransaction) database.exec('ROLLBACK'); throw error; }
    return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
  }
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
    const restoredContracts = restoreLinks();
    database.prepare("UPDATE financial_events SET status='reversed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
    writeAudit(database, row.id, 'reversed', {
      reason: String(reason || '').slice(0, 300), reversalEntryId: reversal.id,
      ...(restoredContracts.length ? { restoredContracts: ownLinks.map((link) => link.detail.contractEventId) } : {}),
    }, actor);
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

/** سطرهای سندِ برنامه‌ریزی‌شده با نام‌هایی که کاربر می‌شناسد: حسابِ بانک، دسته، طرف حساب. */
function planPreview(database, row) {
  let plan = null;
  try { plan = row.posting_plan ? JSON.parse(row.posting_plan) : null; } catch { plan = null; }
  const lines = Array.isArray(plan?.lines) ? plan.lines : [];
  if (!lines.length) return null;
  const accountName = (id) => {
    try { return database.prepare('SELECT name FROM accounts WHERE id=?').get(String(id || ''))?.name || null; } catch { return null; }
  };
  return {
    lines: lines.map((line) => ({
      role: line.role, debit: Number(line.debit) || 0, credit: Number(line.credit) || 0,
      label: line.role === 'cash' ? accountName(line.key) || (line.key === 'cash' ? 'صندوق' : null) : (line.key || null),
    })),
  };
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
    // سندی که با «تأیید» زده می‌شود، فقط وقتی تأیید باز است: سطرِ موردِ گیرافتاده حدسِ
    // پارسر است و نشان‌دادنش به‌عنوان «سند نهایی» گمراه می‌کرد (صف حسابدار، ۲۹ مهر ۱۴۰۵).
    plan: approvalBlocked ? null : planPreview(database, row),
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
const TIMING_ROLES = new Set([ROLES.PREPAID_ASSET, ROLES.DEFERRED_REVENUE]);

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
/** دیرترِ دو تاریخ، به همان قالب ISO که در جدول ذخیره می‌شود. */
function notBeforeDate(date, floor) {
  const value = new Date(date);
  const minimum = new Date(floor);
  if (Number.isNaN(minimum.getTime())) return date;
  return minimum.getTime() > value.getTime() ? minimum.toISOString() : date;
}

/**
 * سند یک قلم شناسایی — مشترک میان اجرای ماهانه و ثبت جبرانیِ تأییدشدهٔ حسابدار.
 *
 * لنگر سند خودِ کلید قلم است: اگر همین قلم دوباره به اینجا برسد،
 * `postJournalEntry` آن را تکراری می‌بیند. فراخوان تراکنش را باز و بسته می‌کند.
 */
function postRecognitionItem(database, item, { event, decision, occurredAt, actor, timeZone, stage = 'recognized', detail = {} }) {
  const build = ALLOCATION_PLANS[decision?.treatment];
  if (!build) return null;
  const planned = build(event, item.amount);
  const lines = planned.map((line) => ({
    // حسابی که برنامه با آن ساخته شد (سند حسابدار)، وگرنه همان نقش و دسته.
    accountId: item.accountId && TIMING_ROLES.has(line.role) ? item.accountId : resolveEventRole(database, line.role, line.key, event),
    analyticId: resolveEventAnalytic(database, line.role, event, line.key),
    debit: line.debit,
    credit: line.credit,
    description: `شناسایی ${item.periodKey}`,
  }));
  // تور ایمنی: تخصیص هرگز از ماندهٔ واقعی حساب دوره‌دار بیشتر کم نمی‌کند.
  //
  // استردادی که با سند دستی، تعیین تکلیف وجه ناشناس یا هر مسیر دیگری بیرون از
  // ثبت حسابدار رسیده، برنامهٔ قرارداد را کم نکرده؛ ثبت کورِ قلم پیش‌پرداخت را
  // منفی و درآمد انتقالی را بدهکار — «مستأجر به ما بدهکار است» — می‌کرد.
  const timingIndex = planned.findIndex((line) => TIMING_ROLES.has(line.role));
  if (timingIndex >= 0) {
    const prepaid = planned[timingIndex].role === ROLES.PREPAID_ASSET;
    const balance = ledgerBalance(database, lines[timingIndex].accountId);
    const available = prepaid ? balance : -balance;
    if (available < item.amount) {
      throw Object.assign(storeError(`ماندهٔ ${prepaid ? 'پیش‌پرداخت' : 'درآمد انتقالی'} (${available.toLocaleString('fa-IR')} تومان) از قلم ${item.periodKey} (${item.amount.toLocaleString('fa-IR')} تومان) کمتر است؛ احتمالاً استرداد یا اصلاحی بیرون از برنامه ثبت شده. حسابدار برنامهٔ قرارداد را بررسی کند.`, 'RECOGNITION_BALANCE_SHORT', 409), { available, accountId: lines[timingIndex].accountId });
    }
  }
  const posted = postJournalEntry(database, {
    sourceType: 'recognition-schedule',
    sourceId: item.key,
    occurredAt,
    memo: `تخصیص ${event.category || ''} — ${item.periodKey}`.trim(),
    lines,
  }, { createdBy: actor, timeZone });
  database.prepare("UPDATE recognition_schedule_items SET status='posted',journal_entry_id=? WHERE key=?").run(posted.id, item.key);
  writeAudit(database, item.eventId, stage, { periodKey: item.periodKey, amount: item.amount, journalEntryId: posted.id, ...detail }, actor);
  return posted;
}

export function postDueRecognitionItems(database, { today = null, actor = null, timeZone = 'Asia/Tehran', limit = 500 } = {}) {
  ensureFinancialEventSchema(database);
  const at = today || new Date().toISOString();
  const summary = { posted: 0, blocked: 0, skipped: 0 };
  let held = 0;
  const cap = Math.max(1, Math.min(2000, Number(limit) || 500));
  const select = (status, size) => database.prepare(`SELECT key,event_id AS eventId,period_key AS periodKey,
    recognition_date AS recognitionDate,amount,status,account_id AS accountId
    FROM recognition_schedule_items
    WHERE status=? AND recognition_date IS NOT NULL AND recognition_date <= ?
      -- فقط رویدادِ ثبت‌شده. قلم رویداد منتظر، ردشده یا معکوس‌شده هیچ‌وقت ثبت
      -- نمی‌شود؛ اگر اینجا انتخاب شود فقط سقف اجرا را می‌خورد و بیش از پانصد
      -- قلم کهنه، اقلام واقعیِ بعد از خود را برای همیشه پشت در نگه می‌داشت.
      AND event_id IN (SELECT id FROM financial_events WHERE status='posted')
    ORDER BY recognition_date LIMIT ?`).all(status, at, size);
  // قلم منتظرِ دورهٔ بسته وضعیتی زنده است، نه پایان راه: هر اجرا دوباره نگاهش
  // می‌کند و اگر دوره باز شده باشد، در همان دورهٔ خودش ثبتش می‌کند. پرس‌وجوی
  // جدا دارد تا اقلام بسته‌مانده سقف اقلام برنامه‌ریزی‌شده را نخورند.
  const due = [...select('planned', cap), ...select('blocked-closed-period', 5000)];

  const lockedPeriods = lockedPeriodSet(database);

  for (const item of due) {
    const row = database.prepare('SELECT payload,status FROM financial_events WHERE id=?').get(item.eventId);
    // رویدادی که سند نخورده، دارایی‌ای هم نساخته.
    if (!row || row.status !== 'posted') { summary.skipped += 1; continue; }
    const event = JSON.parse(row.payload);
    // اقلامی که پیش از این اصلاح ذخیره شده‌اند اول ماهِ پوشش را دارند، حتی اگر
    // پرداخت بعد از آن بوده؛ همان کف اینجا هم اعمال می‌شود تا هیچ سند شناسایی‌ای
    // پیش از سند نقدیِ خودش ننشیند.
    const postAt = notBeforeDate(item.recognitionDate, event.occurredAt);
    if (postAt > at) continue;

    if (lockedPeriods.has(periodForDate(postAt, timeZone))) {
      // ردپا فقط وقتی وضعیت عوض می‌شود: اجرای دوبارهٔ همان برنامه نباید مورد
      // تکراری بسازد (تصمیم ۳ فاز صفر).
      if (item.status !== SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD) {
        database.prepare("UPDATE recognition_schedule_items SET status='blocked-closed-period' WHERE key=?").run(item.key);
        writeAudit(database, item.eventId, 'recognition-blocked', blockedDetail({ ...item, recognitionDate: postAt }, timeZone), actor);
      }
      summary.blocked += 1;
      continue;
    }

    const decision = decisionForEvent(database, item.eventId);
    if (!ALLOCATION_PLANS[decision?.treatment]) { summary.skipped += 1; continue; }

    database.exec('BEGIN IMMEDIATE');
    try {
      postRecognitionItem(database, item, {
        event, decision, occurredAt: postAt, actor, timeZone,
        detail: item.status === SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD ? { resumedAfterReopen: true } : {},
      });
      noteRecognitionPosted(database, { item, event, decision });
      database.exec('COMMIT');
      summary.posted += 1;
    } catch (error) {
      database.exec('ROLLBACK');
      if (error.code === 'RECOGNITION_BALANCE_SHORT') {
        // قلم برنامه‌ریزی‌شده می‌ماند تا حسابدار تصمیم بگیرد؛ ردپا یک بار برای
        // هر قلم، نه هر دقیقه.
        const seen = database.prepare(`SELECT 1 FROM financial_event_audit WHERE event_id=? AND stage='recognition-held-balance'
          AND json_extract(detail,'$.key')=?`).get(item.eventId, item.key);
        if (!seen) writeAudit(database, item.eventId, 'recognition-held-balance', { key: item.key, periodKey: item.periodKey, amount: item.amount, available: error.available, accountId: error.accountId, reason: error.message }, actor);
        held += 1;
        summary.skipped += 1;
        continue;
      }
      // یک قلم خراب نباید بقیهٔ اجرا را متوقف کند؛ ولی بی‌صدا هم رد نمی‌شود.
      writeAudit(database, item.eventId, 'recognition-failed', { periodKey: item.periodKey, reason: String(error.message).slice(0, 300) }, actor);
      summary.skipped += 1;
    }
  }

  return held ? { ...summary, held } : summary;
}

/**
 * تکلیف قلم نگه‌داشته، با دلیل حسابدار: «ماندهٔ این قرارداد پیش‌تر بیرون از
 * برنامه برگشته؛ این قلم دیگر لازم نیست».
 *
 * قلم باطل می‌شود، نه ثبت؛ سندی نمی‌خورد. فقط قلمی که تور ایمنی واقعاً نگهش
 * داشته و هنوز برنامه‌ریزی‌شده است.
 */
export function releaseHeldRecognition(database, key, { reason = '', actor = null } = {}) {
  ensureFinancialEventSchema(database);
  const explanation = String(reason || '').trim().slice(0, 500);
  if (explanation.length < 8) throw storeError('دلیل کنار گذاشتن قلم را با حداقل هشت نویسه بنویس.', 'REVIEW_REASON_REQUIRED', 400);
  const held = listHeldRecognition(database).find((item) => item.key === String(key || ''));
  if (!held) throw storeError('این قلم نگه‌داشته نیست.', 'RECOGNITION_NOT_HELD', 409);
  database.prepare("UPDATE recognition_schedule_items SET status='superseded' WHERE key=? AND status='planned'").run(held.key);
  writeAudit(database, held.eventId, 'recognition-released', { key: held.key, periodKey: held.periodKey, amount: held.amount, reason: explanation }, actor);
  return held;
}

/**
 * خبرِ ماهانهٔ شناسایی برای حسابدار.
 *
 * اقلام پیش‌پرداخت و درآمد انتقالی هر ماه خودکار سند می‌خورند (کار دقیقه‌ای سرور).
 * مالک محصول خواست حسابدار «خبر» بگیرد، نه اینکه هر قلم را تأیید کند (۲۳ مهر ۱۴۰۵):
 * تأییدِ تک‌تکِ اقلام صف را هر ماه با ده‌ها قلم تکراری پر می‌کرد. پس هر قلمی که
 * ثبت می‌شود به خبرِ همان ماه اضافه می‌شود — یک سطر برای هر ماه، با جمع هزینه و
 * درآمد و فهرست قراردادها — و خبرِ دیده‌شده با قلم تازه دوباره «دیده‌نشده» می‌شود.
 * در همان تراکنشِ سند نوشته می‌شود: سندی بی‌خبر یا خبری بی‌سند نمی‌ماند.
 *
 * ساختن جدول؛ `true` یعنی همین حالا ساخته شد و اقلامِ ثبت‌شدهٔ پیش از آن به خبرها
 * منتقل شدند. اقلامی که پیش از این بخش خودکار ثبت شده بودند بی‌خبر نمی‌مانند، ولی
 * فقط آخرین ماه «دیده‌نشده» می‌ماند تا صف حسابدار با خبرهای کهنه پر نشود.
 */
function ensureRecognitionNoticeSchema(database) {
  const existed = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recognition_notices'").get();
  createRecognitionNoticeTable(database);
  if (existed) return false;
  const posted = database.prepare(`SELECT i.event_id AS eventId,i.period_key AS periodKey,i.amount,e.payload
    FROM recognition_schedule_items i JOIN financial_events e ON e.id=i.event_id
    WHERE i.status='posted' ORDER BY i.period_key,i.key`).all();
  for (const row of posted) addToNotice(database, { item: row, event: JSON.parse(row.payload), decision: decisionForEvent(database, row.eventId) });
  if (posted.length) {
    database.prepare("UPDATE recognition_notices SET seen_at=?,seen_by='backfill' WHERE period_key<?")
      .run(new Date().toISOString(), posted.at(-1).periodKey);
  }
  return true;
}

function createRecognitionNoticeTable(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS recognition_notices (
    period_key TEXT PRIMARY KEY,
    posted_items INTEGER NOT NULL DEFAULT 0,
    expense_amount INTEGER NOT NULL DEFAULT 0,
    income_amount INTEGER NOT NULL DEFAULT 0,
    contracts TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    seen_at TEXT,
    seen_by TEXT
  )`);
}

const timingKindOf = (decision) => (decision?.treatment === 'deferred-revenue' ? 'deferred' : 'prepaid');
const contractTitle = (event) => [event.category, event.counterparty].filter(Boolean).join(' — ') || 'قرارداد دوره‌دار';

function noteRecognitionPosted(database, { item, event, decision }) {
  // جدولِ تازه‌ساخته همین قلم را هم منتقل کرده است (وضعیتش پیش از این «ثبت‌شده» شد).
  if (ensureRecognitionNoticeSchema(database)) return;
  addToNotice(database, { item, event, decision });
}

function addToNotice(database, { item, event, decision }) {
  const kind = timingKindOf(decision);
  const row = database.prepare('SELECT contracts FROM recognition_notices WHERE period_key=?').get(item.periodKey);
  const contracts = row ? JSON.parse(row.contracts) : [];
  const existing = contracts.find((entry) => entry.eventId === item.eventId);
  if (existing) existing.amount += item.amount;
  else contracts.push({ eventId: item.eventId, title: contractTitle(event), kind, amount: item.amount });
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO recognition_notices (period_key,posted_items,expense_amount,income_amount,contracts,updated_at,seen_at,seen_by)
    VALUES (?,1,?,?,?,?,NULL,NULL)
    ON CONFLICT(period_key) DO UPDATE SET posted_items=posted_items+1,expense_amount=expense_amount+excluded.expense_amount,
      income_amount=income_amount+excluded.income_amount,contracts=excluded.contracts,updated_at=excluded.updated_at,seen_at=NULL,seen_by=NULL`)
    .run(item.periodKey, kind === 'prepaid' ? item.amount : 0, kind === 'deferred' ? item.amount : 0, JSON.stringify(contracts), now);
}

/** خبرهای ماهانه، تازه‌ترین اول. `unseenOnly` برای صف حسابدار. */
export function listRecognitionNotices(database, { unseenOnly = false, limit = 12 } = {}) {
  ensureRecognitionNoticeSchema(database);
  return database.prepare(`SELECT period_key AS periodKey,posted_items AS postedItems,expense_amount AS expenseAmount,income_amount AS incomeAmount,
      contracts,updated_at AS updatedAt,seen_at AS seenAt,seen_by AS seenBy
    FROM recognition_notices ${unseenOnly ? 'WHERE seen_at IS NULL' : ''} ORDER BY period_key DESC LIMIT ?`)
    .all(Math.max(1, Math.min(60, Number(limit) || 12)))
    .map((row) => ({ ...row, contracts: JSON.parse(row.contracts) }));
}

export function markRecognitionNoticeSeen(database, periodKey, { actor = null } = {}) {
  ensureRecognitionNoticeSchema(database);
  const changed = database.prepare('UPDATE recognition_notices SET seen_at=?,seen_by=? WHERE period_key=?')
    .run(new Date().toISOString(), actor, String(periodKey || '')).changes;
  if (!changed) throw storeError('خبری برای این ماه نیست.', 'RECOGNITION_NOTICE_MISSING', 404);
  return listRecognitionNotices(database, { limit: 60 }).find((notice) => notice.periodKey === String(periodKey));
}

/**
 * قراردادهای دوره‌دار: هر پیش‌پرداخت و پیش‌دریافتی که برنامهٔ شناسایی دارد.
 *
 * تا امروز این قراردادها فقط در دفتر روزنامه و ماندهٔ حساب‌ها پراکنده بودند؛ کسی
 * نمی‌دید کدام بیمه چند قسط دیگر دارد یا کدام پیش‌دریافت تمام شده. هر سطر از خودِ
 * رویداد و برنامه‌اش ساخته می‌شود — مبلغ کل، شناسایی‌شده تا امروز، مانده، قسط بعدی
 * و وضعیت — نه از حدس روی دفتر کل. اقلام باطل‌شده (اصلاح برنامه، برگشت) در جمع
 * نمی‌آیند ولی رویداد برگشتی با وضعیت «لغوشده» در فهرست می‌ماند.
 */
export function listTimingContracts(database) {
  ensureFinancialEventSchema(database);
  const events = database.prepare(`SELECT e.id,e.status,e.payload,e.journal_entry_id AS journalEntryId,e.source_event_id AS sourceEventId,
      e.created_at AS createdAt
    FROM financial_events e WHERE EXISTS (SELECT 1 FROM recognition_schedule_items i WHERE i.event_id=e.id)
    ORDER BY e.created_at DESC,e.rowid DESC`).all();
  const itemsOf = database.prepare(`SELECT key,period_key AS periodKey,recognition_date AS recognitionDate,amount,status,
      journal_entry_id AS journalEntryId,account_id AS accountId
    FROM recognition_schedule_items WHERE event_id=? ORDER BY period_key,key`);
  const held = new Set(listHeldRecognition(database).map((item) => item.key));
  const accountName = database.prepare('SELECT name FROM ledger_accounts WHERE id=?');
  const timingLines = database.prepare(`SELECT a.name,l.debit,l.credit FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id
    LEFT JOIN chart_accounts c ON c.id=a.chart_account_id
    WHERE l.entry_id=? AND (a.source_kind IN ('prepaid-asset','deferred-revenue') OR c.role IN ('prepaid-asset','deferred-revenue'))`);
  return events.map((row) => {
    const event = JSON.parse(row.payload);
    const decision = decisionForEvent(database, row.id);
    const kind = timingKindOf(decision);
    const stored = itemsOf.all(row.id).filter((item) => item.status !== SCHEDULE_ITEM_STATUS.SUPERSEDED);
    const items = stored
      .map((item) => ({
        key: item.key, periodKey: item.periodKey, amount: item.amount, journalEntryId: item.journalEntryId,
        recognitionDate: item.recognitionDate ? notBeforeDate(item.recognitionDate, event.occurredAt) : null,
        status: item.status === SCHEDULE_ITEM_STATUS.PLANNED && held.has(item.key) ? 'held' : item.status,
      }));
    const total = items.reduce((sum, item) => sum + item.amount, 0);
    const recognized = items.filter((item) => item.status === SCHEDULE_ITEM_STATUS.POSTED).reduce((sum, item) => sum + item.amount, 0);
    const next = items.find((item) => item.status !== SCHEDULE_ITEM_STATUS.POSTED) || null;
    const carrier = row.journalEntryId ? timingLines.all(row.journalEntryId) : [];
    const carrierLine = carrier.find((line) => (kind === 'prepaid' ? line.debit : line.credit) === total) || carrier.find((line) => (kind === 'prepaid' ? line.debit : line.credit) > 0);
    const account = stored.map((item) => item.accountId).find(Boolean);
    const cancelled = ['reversed', 'rejected'].includes(row.status) || !items.length;
    const attention = items.some((item) => ['held', SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD].includes(item.status));
    return {
      eventId: row.id, kind, title: contractTitle(event),
      category: event.category || '', counterparty: event.counterparty || '',
      evidence: String(event.utterance || event.evidence || '').slice(0, 300),
      source: String(row.sourceEventId || '').split(':')[0] || 'event',
      occurredAt: event.occurredAt || null,
      account: (account && accountName.get(account)?.name) || carrierLine?.name || '',
      total, recognized, remaining: total - recognized,
      instalments: items.length, postedInstalments: items.filter((item) => item.status === SCHEDULE_ITEM_STATUS.POSTED).length,
      periodFrom: items[0]?.periodKey || null, periodTo: items.at(-1)?.periodKey || null,
      next: next ? { periodKey: next.periodKey, recognitionDate: next.recognitionDate, amount: next.amount, status: next.status } : null,
      state: cancelled ? 'cancelled' : row.status !== 'posted' ? 'pending' : attention ? 'attention' : total - recognized === 0 ? 'done' : 'active',
      items,
    };
  });
}

/**
 * اقلامی که تور ایمنیِ مانده نگهشان داشته — صف حسابدار.
 *
 * ماندهٔ حساب دوره‌دار از قلم کمتر بود؛ یعنی چیزی بیرون از برنامه آن را کم
 * کرده. ثبت نمی‌شوند و بی‌صدا هم نمی‌مانند.
 */
export function listHeldRecognition(database) {
  ensureFinancialEventSchema(database);
  return database.prepare(`SELECT i.key,i.event_id AS eventId,i.period_key AS periodKey,i.recognition_date AS recognitionDate,i.amount,
      (SELECT detail FROM financial_event_audit a WHERE a.event_id=i.event_id AND a.stage='recognition-held-balance'
        AND json_extract(a.detail,'$.key')=i.key ORDER BY a.rowid DESC LIMIT 1) AS detail
    FROM recognition_schedule_items i JOIN financial_events e ON e.id=i.event_id
    WHERE i.status='planned' AND e.status='posted' ORDER BY i.recognition_date,i.key`).all()
    .filter((row) => row.detail)
    .map((row) => ({ key: row.key, eventId: row.eventId, periodKey: row.periodKey, recognitionDate: row.recognitionDate, amount: row.amount, reason: JSON.parse(row.detail).reason }));
}

/**
 * اقلامی که دورهٔ بسته جلویشان را گرفته — صف حسابدار برای رویدادِ ثبت‌شده.
 *
 * رویداد منتظر در صف بررسی خودش با همین دلیل دیده می‌شود؛ ولی رویدادی که سند
 * خورده دیگر در آن صف نیست و بدون این فهرست، ماندهٔ دارایی یا بدهی‌اش بی‌صدا
 * تا ابد در ترازنامه می‌ماند.
 */
export function listBlockedRecognition(database, { timeZone = 'Asia/Tehran' } = {}) {
  ensureFinancialEventSchema(database);
  return database.prepare(`SELECT i.key,i.event_id AS eventId,i.period_key AS periodKey,i.recognition_date AS recognitionDate,
      i.amount,e.payload,e.journal_entry_id AS journalEntryId
    FROM recognition_schedule_items i JOIN financial_events e ON e.id=i.event_id
    WHERE i.status='blocked-closed-period' AND e.status='posted' ORDER BY i.recognition_date,i.key`).all()
    .map((row) => {
      const event = JSON.parse(row.payload);
      const postAt = notBeforeDate(row.recognitionDate, event.occurredAt);
      return {
        key: row.key, eventId: row.eventId, periodKey: row.periodKey, recognitionDate: postAt,
        period: periodForDate(postAt, timeZone), amount: row.amount, journalEntryId: row.journalEntryId,
        category: event.category || '', counterparty: event.counterparty || '',
        evidence: String(event.utterance || event.evidence || '').slice(0, 300),
        reason: blockedRecognitionReason([{ periodKey: row.periodKey, recognitionDate: postAt }], timeZone),
      };
    });
}

/**
 * ثبت جبرانیِ قلمی که دورهٔ بسته جلویش را گرفته — فقط با تأیید صریح حسابدار.
 *
 * تصمیم ۳ فاز صفر جابه‌جایی **بی‌صدا** را رد می‌کند، چون سود دوره را بدون
 * تأیید جابه‌جا می‌کند. اینجا حسابدار دلیلش را می‌نویسد و سند در نخستین دورهٔ
 * باز از تاریخ شناسایی به بعد می‌نشیند، با ردپایی که دورهٔ اصلی را نام می‌برد.
 * اگر خودِ دوره باز شده باشد، همان‌جا ثبت می‌شود. دورهٔ بسته هرگز باز نمی‌شود و
 * سند در آینده هم نمی‌نشیند.
 */
export function postBlockedRecognitionCatchUp(database, key, { reason = '', actor = null, timeZone = 'Asia/Tehran', today = null } = {}) {
  ensureFinancialEventSchema(database);
  const explanation = String(reason || '').trim().slice(0, 500);
  if (explanation.length < 8) throw storeError('دلیل ثبت جبرانی را با حداقل هشت نویسه بنویس.', 'REVIEW_REASON_REQUIRED', 400);
  const item = database.prepare(`SELECT key,event_id AS eventId,period_key AS periodKey,recognition_date AS recognitionDate,amount,status,account_id AS accountId
    FROM recognition_schedule_items WHERE key=?`).get(String(key || ''));
  if (!item || item.status !== SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD) throw storeError('این قلم منتظر دورهٔ بسته نیست.', 'RECOGNITION_NOT_BLOCKED', 409);
  const row = database.prepare('SELECT payload,status FROM financial_events WHERE id=?').get(item.eventId);
  if (!row || row.status !== 'posted') throw storeError('رویداد این قلم ثبت‌شده نیست.', 'EVENT_NOT_POSTED', 409);
  const event = JSON.parse(row.payload);
  const decision = decisionForEvent(database, item.eventId);
  if (!ALLOCATION_PLANS[decision?.treatment]) throw storeError('این رویداد برنامهٔ تخصیص ندارد.', 'RECOGNITION_PLAN_MISSING', 409);

  const original = notBeforeDate(item.recognitionDate, event.occurredAt);
  const now = today || new Date().toISOString();
  const lockedPeriods = lockedPeriodSet(database);
  let postAt = original;
  // ماه‌به‌ماه جلو، تا نخستین دورهٔ باز؛ سند اول همان ماه می‌نشیند.
  for (let step = 0; lockedPeriods.has(periodForDate(postAt, timeZone)); step += 1) {
    const parts = todayPersian(new Date(postAt), timeZone);
    const index = (parts.year * 12) + parts.month; // ماه بعد
    postAt = persianToISO(Math.floor(index / 12), (index % 12) + 1, 1, timeZone);
    if (!postAt || step > 240) break;
  }
  if (!postAt || postAt > now) throw storeError('تا امروز هیچ دورهٔ بازی بعد از تاریخ این شناسایی نیست؛ ثبت جبرانی در آینده نمی‌نشیند.', 'RECOGNITION_NO_OPEN_PERIOD', 409);

  database.exec('BEGIN IMMEDIATE');
  try {
    const posted = postRecognitionItem(database, item, {
      event, decision, occurredAt: postAt, actor, timeZone, stage: 'recognition-catch-up',
      detail: { originalDate: original, originalPeriod: periodForDate(original, timeZone), postedPeriod: periodForDate(postAt, timeZone), reason: explanation },
    });
    database.exec('COMMIT');
    return { key: item.key, eventId: item.eventId, journalEntryId: posted.id, occurredAt: postAt, period: periodForDate(postAt, timeZone) };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

// ---------------------------------------------------------------------------
// ماندهٔ دفتر کلِ بی‌سند: پیش‌پرداخت یا درآمد انتقالی‌ای که برنامه ندارد
// ---------------------------------------------------------------------------

/** قلم‌های زنده‌ای که تخصیصشان از این حساب کم می‌کند. */
function scheduledOnAccount(database, accountId) {
  return Number(database.prepare(`SELECT COALESCE(SUM(i.amount),0) AS n FROM recognition_schedule_items i
    JOIN financial_events e ON e.id=i.event_id
    WHERE e.status='posted' AND i.status IN ('planned','blocked-closed-period')
      AND (i.account_id=? OR (i.account_id IS NULL AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id=e.journal_entry_id AND l.account_id=?)))`).get(accountId, accountId).n);
}

/** دورهٔ پیشنهادی از شرح سند — فقط پیشنهاد؛ حسابدار تأییدش می‌کند. */
function suggestedCoverage(text, occurredAt) {
  if (!text || !occurredAt) return null;
  const stated = readCoverageAnswers([{ text, side: 'any' }], { occurredAt });
  if (stated.start && stated.end) return stated;
  const spoken = readServicePeriod(text, { occurredAt });
  return spoken ? { start: spoken.start, end: spoken.end } : null;
}

/**
 * ماندهٔ پیش‌پرداخت یا درآمد انتقالی که هیچ برنامه‌ای پشتش نیست.
 *
 * تنها جایی که برنامه ساخته می‌شود رویداد است؛ ولی ماندهٔ افتتاحیه، سند دستی
 * دسته‌ای و سند اصلاحی مستقیم روی همین حساب‌ها می‌نشینند و هیچ‌وقت هزینه یا
 * درآمد نمی‌شوند — یک سال بعد همان مانده سر جایش است. این بررسیِ سطح دفتر کل
 * است، نه وصله روی هر مسیر ورود: برای هر حساب دوره‌دار، ماندهٔ واقعی منهای
 * جمع اقلام زندهٔ برنامه. اختلاف مثبت یعنی بخشی که کسی برایش دوره نگفته.
 *
 * خروجی هر حساب: مانده، جمع برنامه، اختلاف، و سندهایی که آن را ساخته‌اند — با
 * دورهٔ پیشنهادی از شرح سند، اگر شرح آن را صریح گفته باشد. چیزی ثبت نمی‌شود و
 * دوره‌ای حدس زده نمی‌شود.
 */
export function unscheduledTimingBalances(database, { accountId = null } = {}) {
  ensureFinancialEventSchema(database);
  const accounts = database.prepare(`SELECT a.id,a.name,a.source_kind AS sourceKind,a.source_key AS sourceKey,c.code AS chartCode
    FROM ledger_accounts a LEFT JOIN chart_accounts c ON c.id=a.chart_account_id
    WHERE (a.source_kind IN ('prepaid-asset','deferred-revenue') OR c.role IN ('prepaid-asset','deferred-revenue'))
      AND (? IS NULL OR a.id=?) ORDER BY a.code,a.id`).all(accountId, accountId);
  const result = [];
  for (const account of accounts) {
    const kind = timingAccountKind(database, account.id);
    if (!kind) continue;
    const balance = ledgerBalance(database, account.id);
    const held = kind === 'prepaid' ? balance : -balance;
    const scheduled = scheduledOnAccount(database, account.id);
    const residual = held - scheduled;
    const sign = kind === 'prepaid' ? 1 : -1;
    // ماندهٔ با علامت غلط — پیش‌پرداخت بستانکار، درآمد انتقالی بدهکار («طرف به ما
    // بدهکار است») — برنامه‌ای نمی‌خواهد؛ خطایی است که باید دیده و اصلاح شود، نه
    // اینکه چون «اختلاف مثبت نیست» بی‌صدا رد شود.
    if (held < 0) {
      const label = kind === 'prepaid' ? 'پیش‌پرداخت' : 'درآمد انتقالی';
      const side = kind === 'prepaid' ? 'بستانکار' : 'بدهکار';
      const entries = database.prepare(`SELECT j.id,j.source_type AS sourceType,j.occurred_at AS occurredAt,j.memo,j.document_number AS documentNumber,
          SUM(l.debit)-SUM(l.credit) AS net, group_concat(l.description,' ') AS descriptions
        FROM journal_lines l JOIN journal_entries j ON j.id=l.entry_id
        WHERE l.account_id=? AND j.approval_state='approved' AND j.reverses_entry_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=j.id)
        GROUP BY j.id HAVING net*?<0 ORDER BY j.occurred_at DESC,j.id DESC LIMIT 20`).all(account.id, sign)
        .map((entry) => ({
          entryId: entry.id, sourceType: entry.sourceType, occurredAt: entry.occurredAt, documentNumber: entry.documentNumber,
          memo: entry.memo, description: entry.descriptions || '', amount: Math.abs(entry.net), suggestedCoverage: null, suggestedCategory: null,
        }));
      result.push({
        accountId: account.id, accountName: account.name, chartCode: account.chartCode || null, kind,
        balance: held, scheduled, residual, entries, category: null, wrongSign: true,
        question: `ماندهٔ «${account.name}» ${(-held).toLocaleString('fa-IR')} تومان ${side} است؛ ${label} نباید ماندهٔ ${side} داشته باشد. استرداد، برگشت یا سند دستیِ بیرون از برنامه را بررسی و اصلاح کن.`,
      });
      continue;
    }
    if (residual <= 0) continue;
    const entries = database.prepare(`SELECT j.id,j.source_type AS sourceType,j.occurred_at AS occurredAt,j.memo,j.document_number AS documentNumber,
        SUM(l.debit)-SUM(l.credit) AS net, group_concat(l.description,' ') AS descriptions
      FROM journal_lines l JOIN journal_entries j ON j.id=l.entry_id
      WHERE l.account_id=? AND j.approval_state='approved' AND j.source_type<>'recognition-schedule' AND j.reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=j.id)
        AND j.id NOT IN (SELECT e.journal_entry_id FROM financial_events e WHERE e.journal_entry_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM recognition_schedule_items i WHERE i.event_id=e.id AND i.status<>'superseded'))
        AND j.id NOT IN (SELECT json_extract(e.payload,'$.anchorEntryId') FROM financial_events e WHERE e.kind='balance-recognition' AND e.status='posted'
          AND json_extract(e.payload,'$.accountId')=?)
      GROUP BY j.id HAVING net*?>0 ORDER BY j.occurred_at,j.id`).all(account.id, account.id, sign)
      .map((entry) => {
        const text = [entry.descriptions, entry.memo].filter(Boolean).join(' ');
        const coverage = suggestedCoverage(text, entry.occurredAt);
        const [guess] = scoreCategories(text, kind === 'prepaid' ? 'expense' : 'income');
        return {
          entryId: entry.id, sourceType: entry.sourceType, occurredAt: entry.occurredAt, documentNumber: entry.documentNumber,
          memo: entry.memo, description: entry.descriptions || '', amount: Math.abs(entry.net),
          suggestedCoverage: coverage, suggestedCategory: guess?.definition?.name || null,
        };
      });
    const linkedCategory = kind === 'prepaid' && account.sourceKind === 'prepaid-asset' && account.sourceKey && account.sourceKey !== 'عمومی' ? account.sourceKey : null;
    result.push({
      accountId: account.id, accountName: account.name, chartCode: account.chartCode || null, kind,
      balance: held, scheduled, residual, entries, category: linkedCategory,
      question: kind === 'deferred'
        ? `ماندهٔ ${residual.toLocaleString('fa-IR')} تومانی «${account.name}» برنامهٔ شناسایی ندارد؛ دورهٔ خدمتی که پولش پیشاپیش گرفته شد از کی تا کی است و درآمد کدام دسته است؟`
        : `ماندهٔ ${residual.toLocaleString('fa-IR')} تومانی «${account.name}» برنامهٔ هزینه‌شدن ندارد؛ دورهٔ پوشش از کی تا کی است${linkedCategory ? '' : ' و هزینهٔ کدام دسته است'}؟ اگر پیش‌پرداخت خرید کالاست، آن را به حساب پیش‌پرداخت خرید تأمین‌کننده منتقل کن.`,
    });
  }
  return result;
}

/**
 * جواب حسابدار به ماندهٔ بی‌برنامه: دوره و دسته — و برنامه از همان مانده.
 *
 * رویداد «شناسایی مانده» ثبت‌شده ساخته می‌شود که **هیچ سند تازه‌ای نمی‌زند**:
 * پول همان روزی جابه‌جا شده که سند مبنا (افتتاحیه، سند دستی، سند اصلاحی) آن را
 * نوشت. فقط برنامه دارد — به مبلغ همان مانده (یا بخشی از آن، وقتی یک حساب
 * کلی چند قرارداد را با هم نگه داشته)، روی همان حساب، و هیچ قلمی پیش از تاریخ
 * سند مبنا. ماه‌های گذشتهٔ پوشش در اجرای بعدی جبران می‌شوند.
 */
export function scheduleTimingBalance(database, accountId, {
  amount = null, start = null, end = null, coverageText = '', category = '', counterparty = '', counterpartyId = null,
  entryId = null, reason = '', actor = null, timeZone = 'Asia/Tehran',
} = {}) {
  ensureFinancialEventSchema(database);
  const listed = unscheduledTimingBalances(database, { accountId: String(accountId || '') });
  const open = listed.find((item) => !item.wrongSign);
  if (!open) {
    const wrong = listed.find((item) => item.wrongSign);
    throw storeError(wrong ? wrong.question : 'این حساب ماندهٔ بی‌برنامه‌ای ندارد.', wrong ? 'TIMING_BALANCE_WRONG_SIGN' : 'TIMING_BALANCE_NOT_OPEN', 409);
  }
  const value = amount == null ? open.residual : Number(amount);
  if (!Number.isSafeInteger(value) || value <= 0) throw storeError('مبلغ برنامه باید عدد صحیح مثبت به تومان باشد.', 'TIMING_BALANCE_INVALID', 400);
  if (value > open.residual) throw storeError(`مبلغ برنامه از ماندهٔ بی‌برنامه (${open.residual.toLocaleString('fa-IR')} تومان) بیشتر است.`, 'TIMING_BALANCE_INVALID', 400);
  const anchor = (entryId ? open.entries.find((entry) => entry.entryId === entryId) : open.entries.at(-1)) || null;
  if (entryId && !anchor) throw storeError('سند مبنای انتخاب‌شده این مانده را نساخته است.', 'TIMING_BALANCE_INVALID', 400);
  const occurredAt = anchor?.occurredAt || new Date().toISOString();
  const explicit = start && end ? { start: new Date(start).toISOString(), end: new Date(end).toISOString() } : null;
  const coverage = explicit && !Number.isNaN(Date.parse(explicit.start)) && !Number.isNaN(Date.parse(explicit.end))
    ? explicit : readCoverageAnswers([{ text: coverageText, side: 'any' }], { occurredAt });
  if (!coverage.start || !coverage.end) {
    throw Object.assign(storeError(open.question, 'REVIEW_DETAILS_REQUIRED', 409), { question: { id: 'coverage.start', text: open.question } });
  }
  const finalCategory = String(open.category || category || '').trim();
  if (!finalCategory) {
    const text = open.kind === 'deferred' ? 'درآمد این مانده کدام دسته است؟ (مثلاً «درآمد اجاره»)' : 'هزینهٔ این پیش‌پرداخت کدام دسته است؟ (مثلاً «بیمه»)';
    throw Object.assign(storeError(text, 'REVIEW_DETAILS_REQUIRED', 409), { question: { id: 'balance.category', text } });
  }
  const explanation = String(reason || '').trim().slice(0, 500);
  const deferred = open.kind === 'deferred';
  const id = randomUUID();
  const event = {
    kind: 'balance-recognition', amount: value, occurredAt, category: finalCategory,
    counterparty: String(counterparty || '').trim() || null, counterpartyId: counterpartyId || null,
    servicePeriodStart: coverage.start, servicePeriodEnd: coverage.end,
    accountId: open.accountId, anchorEntryId: anchor?.entryId || null, anchorSourceType: anchor?.sourceType || null,
    evidence: [anchor?.description, anchor?.memo].filter(Boolean).join(' — ').slice(0, 500) || open.accountName,
  };
  const decision = {
    family: deferred ? 'advance-received' : 'asset-creation', treatment: deferred ? 'deferred-revenue' : 'prepaid-expense',
    recognitionDate: coverage.start, recognitionMethod: 'monthly-straight-line', riskLevel: 'yellow', decisionStatus: DECISION_STATUS.DECIDED,
    explanation: `ماندهٔ بی‌سند «${open.accountName}» با دورهٔ گفتهٔ حسابدار برنامه گرفت${explanation ? `: ${explanation}` : ''}.`,
    sourceReferences: [{ type: 'ledger-account', id: open.accountId }, ...(anchor ? [{ type: 'journal-entry', id: anchor.entryId }] : [])],
  };
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO financial_events (id,source_event_id,kind,amount,occurred_at,payload,confidence,route,status,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, `balance-recognition:${open.accountId}:${id}`, event.kind, value, occurredAt,
      JSON.stringify(event), JSON.stringify({ route: ROUTES.ACCOUNTANT_REVIEW, reasons: [open.question] }), ROUTES.ACCOUNTANT_REVIEW, 'posted', actor);
    const decisionId = storeDecision(database, id, decision);
    database.prepare('UPDATE financial_events SET decision_id=? WHERE id=?').run(decisionId, id);
    const stored = storeSchedule(database, id, decision, event, { amount: value, accountId: open.accountId, timeZone });
    writeAudit(database, id, 'balance-scheduled', {
      accountId: open.accountId, residualBefore: open.residual, amount: value, coverage, category: finalCategory,
      anchorEntryId: event.anchorEntryId, written: stored?.written || 0, blocked: stored?.blocked?.length || 0, reason: explanation,
    }, actor);
    database.exec('COMMIT');
    return { eventId: id, accountId: open.accountId, amount: value, coverage, items: scheduleForEvent(database, id) };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
