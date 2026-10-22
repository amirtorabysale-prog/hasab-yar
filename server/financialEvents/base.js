// پایهٔ دفتر رویدادهای مالی: خطا، ممیزی، جدول‌ها و ترمیم‌های یک‌بارهٔ داده، و ماندهٔ تأییدشدهٔ یک حساب.
//
// از server/financialEventStore.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از
// پوشهٔ financialEvents همه از همان financialEventStore.js می‌خوانند.

import { ensureReviewIntakeSchema } from '../reviewIntakeSchema.js';
import { randomUUID } from 'node:crypto';
import { ensureAccountingSchema, reverseJournalEntry } from '../accounting.js';

export function storeError(message, code = 'EVENT_STORE_INVALID', status = 400) {
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

export function writeAudit(database, eventId, stage, detail, actor) {
  database.prepare('INSERT INTO financial_event_audit (id,event_id,stage,actor,detail) VALUES (?,?,?,?,?)')
    .run(randomUUID(), eventId, stage, actor || null, JSON.stringify(detail ?? {}));
}

// ---------------------------------------------------------------------------
// استرداد و فسخ: سندی که ماندهٔ یک قرارداد دوره‌دار را کم می‌کند، برنامهٔ همان
// قرارداد را هم کم می‌کند
// ---------------------------------------------------------------------------

/** ماندهٔ قطعیِ یک حساب دفتر کل (بدهکار منهای بستانکار، فقط سندهای تأییدشده). */
export function ledgerBalance(database, accountId) {
  return Number(database.prepare(`SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) AS n FROM journal_lines l
    JOIN journal_entries j ON j.id=l.entry_id WHERE l.account_id=? AND j.approval_state='approved'`).get(String(accountId || '')).n);
}
