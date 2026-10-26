// شناسایی ماهانهٔ پیش‌پرداخت و درآمد انتقالی: اجرا، اقلام منتظر و بسته، اعلان و فهرست قراردادها.
//
// از server/financialEventStore.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از
// پوشهٔ financialEvents همه از همان financialEventStore.js می‌خوانند.

import { ROLES } from '../../shared/accountingRules.js';
import { SCHEDULE_ITEM_STATUS } from '../../shared/recognitionSchedule.js';
import { persianToISO, todayPersian } from '../../shared/persianDate.js';
import { periodForDate, postJournalEntry } from '../accounting.js';
import { resolveEventAnalytic, resolveEventRole } from '../roleResolver.js';
import { storeError, ensureFinancialEventSchema, writeAudit, ledgerBalance } from './base.js';
import { lockedPeriodSet, blockedDetail, blockedRecognitionReason, decisionForEvent, ALLOCATION_PLANS, notBeforeDate } from './schedule.js';
import { unitLabel } from '../../shared/amountUnit.js';

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
      throw Object.assign(storeError(`ماندهٔ ${prepaid ? 'پیش‌پرداخت' : 'درآمد انتقالی'} (${available.toLocaleString('fa-IR')} ${unitLabel()}) از قلم ${item.periodKey} (${item.amount.toLocaleString('fa-IR')} ${unitLabel()}) کمتر است؛ احتمالاً استرداد یا اصلاحی بیرون از برنامه ثبت شده. حسابدار برنامهٔ قرارداد را بررسی کند.`, 'RECOGNITION_BALANCE_SHORT', 409), { available, accountId: lines[timingIndex].accountId });
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
