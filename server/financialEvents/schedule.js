// تصمیم و برنامهٔ شناسایی ماهانهٔ هر رویداد، دوره‌های بستهٔ سر راهش، و نقشهٔ سند هر قلم شناسایی.
//
// از server/financialEventStore.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از
// پوشهٔ financialEvents همه از همان financialEventStore.js می‌خوانند.

import { randomUUID } from 'node:crypto';
import { ROLES } from '../../shared/accountingRules.js';
import { SCHEDULE_ITEM_STATUS, buildMonthlySchedule } from '../../shared/recognitionSchedule.js';
import { periodForDate } from '../accounting.js';
import { ensureFinancialEventSchema, writeAudit } from './base.js';

/**
 * تصمیم را ذخیره می‌کند و شناسه‌اش را برمی‌گرداند.
 *
 * `null` برای رویدادی که تصمیمی همراهش نیامده — یعنی موتور نسخهٔ دو خاموش بوده.
 * در آن حالت هیچ ردیفی ساخته نمی‌شود و رفتار دقیقاً همان قبل است.
 */
export function storeDecision(database, eventId, decision, supersedes = null) {
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

export function storeSchedule(database, eventId, decision, event, { timeZone = 'Asia/Tehran', plan = null, amount = null, accountId = null } = {}) {
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

export function lockedPeriodSet(database) {
  return new Set(database.prepare("SELECT period FROM accounting_periods WHERE status='locked'").all().map((row) => row.period));
}

/** تاریخ شمسیِ خوانا برای پیام حسابدار. */
export function persianDay(iso, timeZone = 'Asia/Tehran') {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso || '') : date.toLocaleDateString('fa-IR-u-ca-persian', { timeZone });
}

export function blockedDetail(item, timeZone) {
  return { periodKey: item.periodKey, recognitionDate: item.recognitionDate, period: periodForDate(item.recognitionDate, timeZone), amount: item.amount };
}

/**
 * دلیلی که حسابدار در صف می‌خواند (تصمیم ۳ فاز صفر): نام دوره و تاریخ شناسایی،
 * صریح؛ و دو راهی که پیش رو دارد.
 */
export function blockedRecognitionReason(blocked, timeZone = 'Asia/Tehran') {
  const named = blocked.map((item) => `${item.periodKey} به تاریخ ${persianDay(item.recognitionDate, timeZone)} (دورهٔ بستهٔ ${periodForDate(item.recognitionDate, timeZone)})`);
  return `شناسایی ${named.join('، ')} در دورهٔ بسته می‌افتد و سند نمی‌خورد؛ دوره را باز کن یا ثبت جبرانی را با دلیل در نخستین دورهٔ باز تأیید کن.`;
}

/** اقلامی از برنامهٔ آینده که در دورهٔ بسته می‌افتند — پیش از ذخیره، برای مسیر. */
export function lockedScheduleItems(database, eventId, decision, event, plan, timeZone) {
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

export const ALLOCATION_PLANS = Object.freeze({
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
export function notBeforeDate(date, floor) {
  const value = new Date(date);
  const minimum = new Date(floor);
  if (Number.isNaN(minimum.getTime())) return date;
  return minimum.getTime() > value.getTime() ? minimum.toISOString() : date;
}
