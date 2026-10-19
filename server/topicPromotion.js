import { randomUUID } from 'node:crypto';
import { db, audit, currentWorkspace, invalidInput, currentTimeZone } from './db/core.js';
import { assertAccountingPeriodOpen, periodForDate, categoryLedgerAccount } from './accounting.js';
import {
  TOPIC_SOURCE_KIND, backfillLevelCodes, chartCodeIsValid, listChartAccounts, mapLedgerAccountToChart, normalizeChartCode,
  normalizeTopicLabel, saveChartAccount, suggestChartAccount, topicAnalytic,
} from './chartOfAccounts.js';

/**
 * موتور شمارش و ارتقای برچسب موضوعی — طرح ترکیبی مالک محصول.
 *
 * پیش‌فرض این است که هیچ دستهٔ جدیدی خودبه‌خود ساخته نمی‌شود: موضوع هر ثبت
 * («کلید برق») برچسب/تفصیلی می‌ماند و کدینگ دست‌نخورده است. وقتی همان برچسب
 * در یک ماه به «آستانهٔ ارتقا» رسید — پیش‌فرض ۳ بار — سیستم به‌جای حدس، یک
 * «درخواست ارتقا» در صف حسابدار می‌گذارد: دسته‌ی مستقل بسازیم؟
 *
 * تأیید، سه کار می‌کند و همه در یک تراکنش:
 * ۱. دستهٔ جدید (و معینِ کدینگش) می‌سازد؛
 * ۲. **ثبت‌های قبلیِ همان برچسب را به دستهٔ جدید منتقل می‌کند** — فقط سطرهایی
 *    که روی حسابِ یک دسته نشسته‌اند جابه‌جا می‌شوند؛ سطرهای تسویهٔ طرف حساب و
 *    دارایی دست نمی‌خورند. مبالغ و توازن هیچ سندی عوض نمی‌شود، فقط صاحبِ سطر.
 * ۳. واژه را یاد می‌گیرد تا ثبت‌های بعدی خودشان به دستهٔ تازه بروند.
 *
 * رد کردن هم تصمیم است: همان برچسب دیگر خودکار پیشنهاد نمی‌شود.
 */

const PROMOTION_THRESHOLD_DEFAULT = 3;
const THRESHOLD_SETTING_KEY = 'topic_promotion_threshold';

export function ensureTopicPromotionSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS topic_promotions (
      id TEXT PRIMARY KEY,
      analytic_id TEXT NOT NULL REFERENCES analytic_accounts(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      period TEXT NOT NULL,
      occurrences INTEGER NOT NULL,
      threshold INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','approved','rejected')),
      payload TEXT NOT NULL DEFAULT '{}',
      category_name TEXT,
      chart_code TEXT,
      migrated_lines INTEGER NOT NULL DEFAULT 0,
      requested_by TEXT,
      decided_by TEXT,
      decision_reason TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(analytic_id)
    );
  `);
}

function promotionError(message, code = 'TOPIC_PROMOTION_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

const schema = () => { ensureTopicPromotionSchema(db); repairPromotionChartAccounts(db); };

// سندی که سند معکوس دارد زنده نیست: حذف یا ویرایشِ ثبت، سند قبلی را با معکوسش
// خنثی می‌کند و هر دو در دفتر می‌مانند. شمردنِ سند اصلی، برچسبِ حذف‌شده را به
// آستانه می‌رساند؛ و جابه‌جاکردنش بی معکوسش، دستهٔ قدیمی را منفی و دستهٔ تازه را
// بزرگ‌تر از واقع می‌کرد (سه «کلید برق»، یکی حذف‌شده: «تعمیرات» منفی یک میلیون).
const LIVE_ENTRY = `je.entry_kind='normal' AND NOT EXISTS (SELECT 1 FROM journal_entries rev WHERE rev.reverses_entry_id=je.id)`;

/** دوره‌های بسته. سندِ دورهٔ بسته با ارتقا یا برچسب عوض نمی‌شود، مثل هر اصلاح دیگری. */
function lockedPeriods(database) {
  try {
    return new Set(database.prepare("SELECT period FROM accounting_periods WHERE status='locked'").all().map((row) => row.period));
  } catch { return new Set(); }
}

function chartInstalled(database) {
  try { return Number(database.prepare('SELECT COUNT(*) AS n FROM chart_accounts').get()?.n) > 0; } catch { return false; }
}

/**
 * حساب کلِ معینِ تازه.
 *
 * معینِ بی‌کل در کدینگ یتیم است و فایل انتقال پارسیان کد کلش را ندارد؛ خروجی با
 * «هر حساب کد کل و معین عددی دارد» می‌ایستاد. کل به این ترتیب پیدا می‌شود: کلی
 * که کدِ واردشده زیرش است؛ کلِ معینِ دسته‌هایی که ثبت‌های همین برچسب امروز روی
 * آن‌اند؛ کلِ بقیهٔ دسته‌های هم‌نوع؛ و اگر کدینگ فقط یک کلِ هم‌نوع دارد، همان.
 */
function promotionChartParent(database, type, { sourceAccountIds = [], code = '' } = {}) {
  const generals = database.prepare(`SELECT id, code FROM chart_accounts WHERE level='general' AND type=? AND active=1`).all(type);
  if (code) {
    const byPrefix = generals.filter((row) => code.startsWith(row.code) && code.length > row.code.length)
      .sort((left, right) => right.code.length - left.code.length)[0];
    if (byPrefix) return byPrefix;
  }
  const generalByCode = new Map(generals.map((row) => [row.code, row]));
  const mostCommon = (parents) => {
    const counts = new Map();
    for (const parent of parents.filter(Boolean)) counts.set(parent.id, { ...parent, uses: (counts.get(parent.id)?.uses || 0) + 1 });
    const [best] = [...counts.values()].sort((left, right) => right.uses - left.uses);
    return best ? { id: best.id, code: best.code } : null;
  };
  const mappedParent = database.prepare(`SELECT parent.code FROM ledger_accounts la
    JOIN chart_accounts ca ON ca.id=la.chart_account_id
    JOIN chart_accounts parent ON parent.id=ca.parent_id
    WHERE la.id=?`);
  const mapped = (accountIds) => mostCommon(accountIds.map((accountId) => generalByCode.get(mappedParent.get(accountId)?.code)));
  // حسابِ دستهٔ مبدأ هنوز نگاشت نشده (دستهٔ تازه با اولین ثبتش حساب می‌گیرد):
  // کلِ همان معینی که پیشنهاددهندهٔ نگاشت برایش می‌گوید.
  const chartAccounts = listChartAccounts(database);
  const ledgerOf = database.prepare('SELECT name, type, source_kind AS sourceKind, source_key AS sourceKey FROM ledger_accounts WHERE id=?');
  const suggested = (accountIds) => mostCommon(accountIds.map((accountId) => {
    const ledger = ledgerOf.get(accountId);
    return ledger ? generalByCode.get(suggestChartAccount(ledger, chartAccounts)?.parentCode) : null;
  }));
  const categoryAccounts = database.prepare('SELECT id FROM ledger_accounts WHERE source_kind=?').all(`${type}-category`).map((row) => row.id);
  return mapped(sourceAccountIds) || suggested(sourceAccountIds) || mapped(categoryAccounts)
    || (generals.length === 1 ? generals[0] : null);
}

/** کد معین پیشنهادی: معینِ آزادِ بعدیِ همان کل، هم‌طولِ معین‌های دیگرش. */
function suggestedChartCode(database, parent) {
  if (!parent) return null;
  const siblings = database.prepare(`SELECT code FROM chart_accounts WHERE parent_id=? AND level='subsidiary'`).all(parent.id)
    .map((row) => row.code).filter((code) => /^\d+$/.test(code) && code.startsWith(parent.code) && code.length > parent.code.length);
  const width = siblings.length ? Math.max(...siblings.map((code) => code.length)) : parent.code.length + 2;
  const digits = width - parent.code.length;
  const used = siblings.filter((code) => code.length === width).map((code) => Number(code.slice(parent.code.length)));
  const taken = database.prepare('SELECT 1 FROM chart_accounts WHERE code=?');
  for (let next = (used.length ? Math.max(...used) : 0) + 1; String(next).length <= digits; next += 1) {
    const code = parent.code + String(next).padStart(digits, '0');
    if (!taken.get(code)) return code;
  }
  return null;
}

/** معین را زیر کلش می‌نشاند؛ کد سطح از نو از تفاضل کد معین و کد کل ساخته می‌شود. */
function attachChartParent(database, chartId, parent) {
  database.prepare(`UPDATE chart_accounts SET parent_id=?, level_code='' WHERE id=?`).run(parent.id, chartId);
  backfillLevelCodes(database);
}

/**
 * معین‌هایی که ارتقاهای پیش از این اصلاح ساختند — بی‌کل یا با کدِ ارقام فارسی —
 * یک بار سر جایشان می‌نشینند. فقط حسابی دست می‌خورد که کدش در یک ارتقای
 * تأییدشده ثبت است؛ کدینگِ خودِ دفتر نه. اجرای دوباره کاری نمی‌کند.
 */
export function repairPromotionChartAccounts(database) {
  let rows = [];
  try {
    rows = database.prepare(`SELECT tp.id AS promotionId, ca.id, ca.code, ca.type, ca.parent_id AS parentId
      FROM topic_promotions tp JOIN chart_accounts ca ON ca.code=tp.chart_code
      WHERE tp.status='approved' AND ca.level='subsidiary'`).all();
  } catch { return 0; }
  let repaired = 0;
  for (const row of rows) {
    let code = row.code;
    const latin = normalizeChartCode(row.code);
    if (latin !== row.code && chartCodeIsValid(latin) && !database.prepare('SELECT 1 FROM chart_accounts WHERE code=?').get(latin)) {
      database.prepare(`UPDATE chart_accounts SET code=?, level_code='' WHERE id=?`).run(latin, row.id);
      database.prepare('UPDATE topic_promotions SET chart_code=? WHERE id=?').run(latin, row.promotionId);
      code = latin;
      repaired += 1;
    }
    if (!row.parentId && /^\d+$/.test(code)) {
      const parent = promotionChartParent(database, row.type, { code });
      if (parent) { attachChartParent(database, row.id, parent); repaired += 1; }
    }
  }
  if (repaired) {
    backfillLevelCodes(database);
    audit('repair', 'topic_promotion', 'chart-accounts', { repaired });
  }
  return repaired;
}

/**
 * سندِ ثبت‌شده‌ای که برچسب دستی رویش می‌نشیند: فقط سند زنده و فقط در دورهٔ باز.
 * برچسب یا انتقالِ سندِ معکوس‌شده، بی معکوسش، دسته‌ها را کج می‌کرد؛ و سندِ دورهٔ
 * بسته با برچسب هم عوض نمی‌شود.
 */
function labelableEntry(database, entryId) {
  if (!entryId) return null;
  const entry = database.prepare(`SELECT je.id, je.occurred_at AS occurredAt FROM journal_entries je WHERE je.id=? AND ${LIVE_ENTRY}`).get(entryId);
  if (entry) assertAccountingPeriodOpen(database, periodForDate(entry.occurredAt, currentTimeZone()));
  return entry || null;
}

function inTransaction(database, work) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* تراکنش باز نبوده است. */ }
    throw error;
  }
}

/** آستانهٔ ارتقا: چند تکرار برچسب در یک ماه، پیشنهاد دستهٔ مستقل بسازد. */
export function topicPromotionThreshold(database) {
  const row = database.prepare('SELECT value FROM settings WHERE key=?').get(THRESHOLD_SETTING_KEY);
  const value = Number(row?.value);
  return Number.isSafeInteger(value) && value >= 2 && value <= 50 ? value : PROMOTION_THRESHOLD_DEFAULT;
}

export function saveTopicPromotionThreshold(value) {
  const threshold = Number(value);
  if (!Number.isSafeInteger(threshold) || threshold < 2 || threshold > 50) throw invalidInput('آستانهٔ ارتقا باید عددی بین ۲ تا ۵۰ باشد.');
  db.prepare(`INSERT INTO settings (key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(THRESHOLD_SETTING_KEY, String(threshold));
  audit('save', 'topic_promotion_threshold', THRESHOLD_SETTING_KEY, { threshold });
  return threshold;
}

/** فهرست برچسب‌های موضوعی دفتر با شمارش سطرهای ماه جاری و ماه پیش. */
export function topicLabelStats(database, { timeZone = currentTimeZone() } = {}) {
  schema();
  const currentPeriod = periodForDate(new Date().toISOString(), timeZone);
  const labels = database.prepare(`SELECT id,code,name FROM analytic_accounts WHERE source_kind=? AND active=1 ORDER BY name`).all(TOPIC_SOURCE_KIND);
  const rows = database.prepare(`SELECT jl.analytic_id AS analyticId, je.occurred_at AS occurredAt
    FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id AND ${LIVE_ENTRY}
    JOIN analytic_accounts aa ON aa.id=jl.analytic_id
    WHERE aa.source_kind=?`).all(TOPIC_SOURCE_KIND);
  const countBy = new Map();
  for (const row of rows) {
    const period = periodForDate(row.occurredAt, timeZone);
    const item = countBy.get(row.analyticId) || { current: 0, previous: 0 };
    if (period === currentPeriod) item.current += 1;
    else item.previous += 1;
    countBy.set(row.analyticId, item);
  }
  const threshold = topicPromotionThreshold(database);
  return { period: currentPeriod, threshold, labels: labels.map((label) => ({
    analyticId: label.id, code: label.code, name: label.name,
    current: countBy.get(label.id)?.current || 0, previous: countBy.get(label.id)?.previous || 0,
    ...(countBy.get(label.id)?.current >= threshold ? { crossedThreshold: true } : {}),
  })) };
}

/** سطرهای یک برچسب در یک دوره، با نوع حسابشان — مبنای شمارش و پیش‌نمایش انتقال. */
function labeledLines(database, analyticId, { timeZone, period }) {
  return database.prepare(`SELECT jl.id AS lineId, jl.entry_id AS entryId, jl.debit, jl.credit,
      la.id AS accountId, la.type, la.source_kind AS sourceKind, la.name AS accountName,
      je.occurred_at AS occurredAt, je.memo
    FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.entry_id AND ${LIVE_ENTRY}
    JOIN ledger_accounts la ON la.id=jl.account_id
    WHERE jl.analytic_id=?`).all(analyticId)
    .map((row) => ({ ...row, period: periodForDate(row.occurredAt, timeZone) }))
    .filter((row) => !period || row.period === period);
}

/**
 * گشت ماهانه: برچسب‌های رسیده به آستانه، اگر قبلاً پرسیده نشده باشند، به صف
 * حسابدار پیشنهاد ارتقا می‌دهند. اجرای دوباره همان خروجی را می‌دهد (idempotent).
 *
 * «قبلاً پرسیده شده» هر وضعیتی است — تأیید، رد یا در انتظار — چون پرسیدنِ
 * دوبارهٔ همان سؤال هر ماه، صف حسابدار را بی‌ارزش می‌کند.
 */
export function topicPromotionSweep(database, { timeZone = currentTimeZone(), threshold = null } = {}) {
  schema();
  const limit = threshold || topicPromotionThreshold(database);
  const currentPeriod = periodForDate(new Date().toISOString(), timeZone);
  const labels = database.prepare(`SELECT id,name FROM analytic_accounts WHERE source_kind=? AND active=1`).all(TOPIC_SOURCE_KIND);
  const created = [];
  for (const label of labels) {
    if (database.prepare(`SELECT id FROM topic_promotions WHERE analytic_id=?`).get(label.id)) continue;
    // دسته‌ای با همین نام از قبل هست؟ برچسب چیزی برای ارتقا ندارد.
    if (database.prepare(`SELECT id FROM categories WHERE name=?`).get(label.name)) continue;
    const lines = labeledLines(database, label.id, { timeZone, period: currentPeriod });
    if (lines.length < limit) continue;
    const byType = new Map();
    for (const line of lines) byType.set(line.type, (byType.get(line.type) || 0) + 1);
    const type = [...byType.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || 'expense';
    const candidates = lines.filter((line) => line.sourceKind === `${type}-category`);
    if (!candidates.length) continue;
    const entryIds = [...new Set(lines.map((line) => line.entryId))];
    const samples = entryIds.slice(0, 5).map((entryId) => {
      const line = lines.find((item) => item.entryId === entryId);
      return { entryId, occurredAt: line.occurredAt, amount: Math.max(line.debit, line.credit), memo: line.memo, accountName: line.accountName };
    });
    // سطرِ دورهٔ بسته در پیشنهاد می‌ماند ولی جابه‌جا نمی‌شود؛ عددِ کارت همان را می‌گوید.
    const locked = lockedPeriods(database);
    const lockedLineCount = candidates.filter((line) => locked.has(line.period)).length;
    const parent = chartInstalled(database)
      ? promotionChartParent(database, type, { sourceAccountIds: candidates.map((line) => line.accountId) }) : null;
    const payload = {
      type, suggestedCode: suggestedChartCode(database, parent),
      migrationCount: candidates.length - lockedLineCount,
      lockedLineCount,
      migrationLineIds: candidates.map((line) => line.lineId),
      samples,
    };
    const id = randomUUID();
    database.prepare(`INSERT INTO topic_promotions (id,analytic_id,label,period,occurrences,threshold,payload,requested_by)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, label.id, label.name, currentPeriod, lines.length, limit, JSON.stringify(payload), currentWorkspace()?.userId || null);
    audit('request', 'topic_promotion', id, { label: label.name, occurrences: lines.length, threshold: limit });
    created.push(id);
  }
  return created;
}

function parsePayload(row) {
  try { return JSON.parse(row.payload || '{}'); } catch { return {}; }
}

function hydratePromotion(row) {
  if (!row) return null;
  return {
    id: row.id, analyticId: row.analytic_id, label: row.label, period: row.period,
    occurrences: row.occurrences, threshold: row.threshold, status: row.status,
    ...parsePayload(row),
    categoryName: row.category_name, chartCode: row.chart_code, migratedLines: row.migrated_lines,
    decidedBy: row.decided_by, decisionReason: row.decision_reason, decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

export function listTopicPromotions(database, { status = '' } = {}) {
  schema();
  const where = status ? 'WHERE status=?' : '';
  const rows = status
    ? database.prepare(`SELECT * FROM topic_promotions ${where} ORDER BY created_at DESC LIMIT 50`).all(status)
    : database.prepare(`SELECT * FROM topic_promotions ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 50`).all();
  return rows.map(hydratePromotion);
}

export function getTopicPromotion(database, id) {
  return hydratePromotion(database.prepare('SELECT * FROM topic_promotions WHERE id=?').get(String(id || '')));
}

/**
 * تصمیم حسابدار/مدیر دربارهٔ ارتقای یک برچسب به دستهٔ مستقل.
 *
 * تأیید ساخت دسته، کدینگ، انتقال ثبت‌های قبلی و یادگیری واژه را در **یک
 * تراکنش** انجام می‌دهد: یا همه چیز می‌نشیند یا هیچ‌کدام. رد کردن هیچ ساختاری
 * نمی‌سازد و فقط سؤال را می‌بندد.
 */
export function decideTopicPromotion(database, id, { decision, reason = '', categoryName = '', chartCode = '' } = {}) {
  schema();
  const promotion = database.prepare('SELECT * FROM topic_promotions WHERE id=?').get(String(id || ''));
  if (!promotion) throw promotionError('درخواست ارتقا پیدا نشد.', 'TOPIC_PROMOTION_NOT_FOUND', 404);
  if (promotion.status !== 'pending') throw promotionError('این درخواست قبلاً تصمیم گرفته شده است.', 'TOPIC_PROMOTION_DECIDED', 409);
  const actor = currentWorkspace()?.userId || null;
  const cleanReason = String(reason || '').trim().slice(0, 300);
  if (decision === 'reject') {
    if (cleanReason.length < 3) throw invalidInput('دلیل رد را بنویس تا با تصمیم بماند.');
    database.prepare(`UPDATE topic_promotions SET status='rejected',decided_by=?,decision_reason=?,decided_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(actor, cleanReason, promotion.id);
    audit('reject', 'topic_promotion', promotion.id, { label: promotion.label, reason: cleanReason });
    return getTopicPromotion(database, promotion.id);
  }
  if (decision !== 'approve') throw invalidInput('تصمیم باید تأیید یا رد باشد.');
  if (cleanReason.length < 3) throw invalidInput('دلیل تأیید را بنویس تا با سند بماند.');

  const payload = parsePayload(promotion);
  const type = payload.type === 'income' ? 'income' : 'expense';
  const label = normalizeTopicLabel(promotion.label);
  const name = normalizeTopicLabel(categoryName) || label;
  if (!name) throw invalidInput('نام دسته خالی است.');
  // «۸۱۵۵» و «81-55» همان 8155 است؛ کدِ ارقام فارسی در کدینگ می‌نشست و پارسیان نمی‌پذیرفتش.
  const requestedCode = normalizeChartCode(chartCode);
  if (requestedCode && !chartCodeIsValid(requestedCode)) throw invalidInput('کد معین فقط رقم است (حداکثر ۱۲ رقم).');
  const timeZone = currentTimeZone();

  database.exec('BEGIN IMMEDIATE');
  try {
    // ۰. سطرهای پیشنهاد، همین حالا دوباره سنجیده می‌شوند: سندی که از گشت تا تصمیم
    //    معکوس شده یا دوره‌اش بسته شده، جابه‌جا نمی‌شود.
    const lineOf = database.prepare(`SELECT jl.id, jl.account_id AS accountId, la.source_kind AS sourceKind, je.occurred_at AS occurredAt
      FROM journal_lines jl
      JOIN ledger_accounts la ON la.id=jl.account_id
      JOIN journal_entries je ON je.id=jl.entry_id AND ${LIVE_ENTRY}
      WHERE jl.id=?`);
    const liveLines = (payload.migrationLineIds || []).map((lineId) => lineOf.get(lineId))
      .filter((line) => line && line.sourceKind === `${type}-category`);
    const locked = lockedPeriods(database);
    const isLocked = (line) => locked.has(periodForDate(line.occurredAt, timeZone));
    const keptLockedLines = liveLines.filter(isLocked).length;

    // ۱. دستهٔ جدید — یا همان که از قبل بوده.
    let category = database.prepare('SELECT id,name FROM categories WHERE name=?').get(name);
    if (!category) {
      const sortOrder = (database.prepare('SELECT COALESCE(MAX(sort_order),0) AS max FROM categories WHERE type=?').get(type)?.max || 0) + 1;
      const categoryId = randomUUID();
      database.prepare('INSERT INTO categories (id,name,type,sort_order) VALUES (?,?,?,?)').run(categoryId, name, type, sortOrder);
      category = { id: categoryId, name };
    }

    // ۲. معینِ کدینگ، زیرِ کلِ درست. کدینگِ نصب‌نشده یعنی معینی ساخته نمی‌شود و
    //    نگاشت با نصب کدینگ انجام می‌شود؛ معینِ بی‌کل خروجی پارسیان را می‌بست.
    let chart = null;
    if (chartInstalled(database)) {
      const parent = promotionChartParent(database, type, { sourceAccountIds: liveLines.map((line) => line.accountId), code: requestedCode });
      const code = requestedCode || suggestedChartCode(database, parent);
      if (!code) {
        throw parent
          ? promotionError('زیرِ این حساب کل کد معین آزادی نماند؛ کد را دستی وارد کن.', 'TOPIC_CHART_CODE_EXHAUSTED', 409)
          : promotionError('حساب کلِ این دسته در کدینگ معلوم نیست؛ کد معینی زیرِ یکی از حساب‌های کلِ هم‌نوع وارد کن.', 'TOPIC_CHART_PARENT_MISSING', 409);
      }
      const existing = database.prepare('SELECT id,code,name,parent_id AS parentId FROM chart_accounts WHERE code=?').get(code);
      if (existing) {
        if (normalizeTopicLabel(existing.name) !== name) throw promotionError(`کد «${code}» به حساب دیگری تعلق دارد؛ کد دیگری انتخاب کن.`, 'TOPIC_CHART_CODE_TAKEN', 409);
        if (!existing.parentId && parent) attachChartParent(database, existing.id, parent);
        chart = existing;
      } else {
        if (!parent) throw promotionError('حساب کلِ این کد در کدینگ نیست؛ کدی زیرِ یکی از حساب‌های کلِ هم‌نوع وارد کن.', 'TOPIC_CHART_PARENT_MISSING', 409);
        chart = saveChartAccount(database, { code, name, level: 'subsidiary', type, parentCode: parent.code });
        backfillLevelCodes(database);
      }
    }

    // ۳. حساب دفتر کل دستهٔ جدید و اتصالش به کدینگ.
    const ledgerId = categoryLedgerAccount(database, type, name);
    const ledger = database.prepare('SELECT id,chart_account_id FROM ledger_accounts WHERE id=?').get(ledgerId);
    if (chart && !ledger.chart_account_id) mapLedgerAccountToChart(database, ledgerId, chart.id);

    // ۴. انتقال ثبت‌های قبلی: فقط سطرهایِ دسته، از سند زنده و دورهٔ باز؛ تسویهٔ
    //    طرف حساب و دارایی دست نمی‌خورد. مبلغ و توازن هیچ سندی عوض نمی‌شود.
    const candidates = liveLines.filter((line) => line.accountId !== ledgerId && !isLocked(line));
    let migrated = 0;
    const movedLineIds = candidates.map((line) => line.id);
    if (movedLineIds.length) {
      const update = database.prepare('UPDATE journal_lines SET account_id=? WHERE id=?');
      const entryIds = new Set();
      for (const lineId of movedLineIds) {
        update.run(ledgerId, lineId);
        migrated += 1;
        const entryId = database.prepare('SELECT entry_id AS id FROM journal_lines WHERE id=?').get(lineId)?.id;
        if (entryId) entryIds.add(entryId);
      }
      // برچسب دستهٔ خودِ تراکنش هم تازه می‌شود تا فهرست‌های رابط، دستهٔ درست را نشان دهند.
      const sourceIds = [...entryIds].map((entryId) => database
        .prepare(`SELECT source_id AS id FROM journal_entries WHERE id=? AND source_type='transaction'`).get(entryId)?.id)
        .filter(Boolean);
      const updateCategory = database.prepare('UPDATE transactions SET category=? WHERE id=?');
      for (const sourceId of sourceIds) updateCategory.run(name, sourceId);
      audit('migrate', 'topic_promotion', promotion.id, { label, lines: migrated, entries: entryIds.size });
    }

    // ۵. یادگیری واژه: ثبت‌های بعدی خودشان به دستهٔ تازه می‌روند.
    database.prepare(`INSERT INTO learnings (id,keyword,category) VALUES (?,?,?)
      ON CONFLICT(keyword) DO UPDATE SET category=excluded.category, updated_at=CURRENT_TIMESTAMP`)
      .run(randomUUID(), label, name);
    audit('learn', 'learning', label, { category: name, source: 'topic-promotion' });

    database.prepare(`UPDATE topic_promotions SET status='approved',category_name=?,chart_code=?,migrated_lines=?,payload=?,
      decided_by=?,decision_reason=?,decided_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(name, chart?.code || null, migrated, JSON.stringify({ ...payload, keptLockedLines }), actor, cleanReason, promotion.id);
    audit('approve', 'topic_promotion', promotion.id, { label, category: name, chartCode: chart?.code || null, migrated, keptLockedLines });
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* تراکنش باز نبوده است. */ }
    throw error;
  }
  return getTopicPromotion(database, promotion.id);
}

// ---------------------------------------------------------------------------
// برچسب‌گذاری دستی — روی تراکنش و رویدادِ در انتظار یا سندِ ثبت‌شده
// ---------------------------------------------------------------------------

/** دستهٔ پذیرفته‌شدهٔ یک برچسب — پس از ارتقا، برچسب‌زدن یعنی رفتن به همین حساب. */
function promotedLedgerFor(database, analyticId, type) {
  const promotion = database.prepare(`SELECT category_name, chart_code FROM topic_promotions
    WHERE analytic_id=? AND status='approved'`).get(analyticId);
  if (!promotion?.category_name) return null;
  const ledger = database.prepare(`SELECT id FROM ledger_accounts WHERE source_kind=? AND source_key=?`)
    .get(`${type}-category`, promotion.category_name);
  return ledger?.id || null;
}

/** برچسب را به سطرِ دستهٔ یک سندِ ثبت‌شده می‌چسباند؛ مبالغ دست‌نخورده می‌مانند. */
function attachLabelToPostedEntry(database, entryId, analyticId, { migrateToLedgerId = null, ledgerType = null } = {}) {
  const lines = database.prepare(`SELECT jl.id, jl.account_id, la.type, la.source_kind AS sourceKind FROM journal_lines jl
    JOIN ledger_accounts la ON la.id=jl.account_id
    WHERE jl.entry_id=? AND la.source_kind IN ('expense-category','income-category') AND jl.analytic_id IS NULL`).all(entryId);
  let attached = 0;
  let migrated = 0;
  for (const line of lines) {
    database.prepare('UPDATE journal_lines SET analytic_id=? WHERE id=?').run(analyticId, line.id);
    attached += 1;
    // طرح ترکیبی: دسته‌ای برای این برچسب تأیید شده؟ برچسب‌زدنِ ثبتِ قدیمی هم
    // همان انتقال است — سطر از دستهٔ عمومی به دستهٔ تازه می‌رود، مبالغ ثابت.
    if (migrateToLedgerId && line.sourceKind === `${ledgerType}-category` && line.account_id !== migrateToLedgerId
      && line.type === (ledgerType === 'income' ? 'income' : 'expense')) {
      database.prepare('UPDATE journal_lines SET account_id=? WHERE id=?').run(migrateToLedgerId, line.id);
      migrated += 1;
    }
  }
  return { attached, migrated };
}

/**
 * گذاشتن/عوض‌کردن برچسب موضوعی یک تراکنش.
 *
 * تراکنشی که سندش هنوز بسته نشده فقط ستونش تازه می‌شود و سند بعداً با برچسب
 * ساخته می‌شود. سندِ بسته‌شده بی‌صدا نمی‌ماند: همان لحظه به سطرِ دسته‌اش
 * تفصیلی می‌چسبد — همان کاری که برچسبِ پیش از ثبت می‌کرد.
 */
export function setTransactionTopicLabel(transactionId, label) {
  schema();
  const clean = normalizeTopicLabel(label);
  const row = db.prepare('SELECT id,topic_label AS previous FROM transactions WHERE id=?').get(String(transactionId || ''));
  if (!row) throw promotionError('تراکنش پیدا نشد.', 'TRANSACTION_NOT_FOUND', 404);
  return inTransaction(db, () => labelTransaction(row, clean));
}

function labelTransaction(row, clean) {
  // سندِ زندهٔ همین تراکنش؛ دورهٔ بسته پیش از هر نوشتنی رد می‌شود.
  const live = db.prepare(`SELECT je.id FROM journal_entries je WHERE je.source_type='transaction' AND je.source_id=? AND ${LIVE_ENTRY}
    ORDER BY je.revision DESC LIMIT 1`).get(row.id);
  const entry = labelableEntry(db, live?.id);
  db.prepare('UPDATE transactions SET topic_label=? WHERE id=?').run(clean, row.id);
  let attached = 0;
  let migrated = 0;
  if (entry) {
    // سندِ فعالِ همین تراکنش؛ تاریخچهٔ نسخه‌های پیشین دست نمی‌خورد.
    db.prepare(`UPDATE journal_lines SET analytic_id=NULL WHERE analytic_id IS NOT NULL
      AND analytic_id IN (SELECT id FROM analytic_accounts WHERE source_kind=?)
      AND entry_id=?`).run(TOPIC_SOURCE_KIND, entry.id);
    if (clean) {
      const analytic = topicAnalytic(db, clean);
      const ledgerType = db.prepare(`SELECT type FROM transactions WHERE id=?`).get(row.id)?.type === 'income' ? 'income' : 'expense';
      const promoted = promotedLedgerFor(db, analytic.id, ledgerType);
      const result = attachLabelToPostedEntry(db, entry.id, analytic.id, { migrateToLedgerId: promoted, ledgerType });
      attached = result.attached;
      migrated = result.migrated;
      // دستهٔ خودِ ردیف هم تازه شود تا فهرست‌ها دستهٔ درست را نشان دهند.
      if (migrated > 0) {
        const promotion = db.prepare(`SELECT category_name FROM topic_promotions WHERE analytic_id=? AND status='approved'`).get(analytic.id);
        if (promotion?.category_name) db.prepare('UPDATE transactions SET category=? WHERE id=?').run(promotion.category_name, row.id);
      }
    }
  }
  audit(clean ? 'label' : 'unlabel', 'transaction', row.id, { label: clean, attachedToPosted: attached > 0, migrated });
  return { id: row.id, topicLabel: clean, attachedToPostedLines: attached, migratedLines: migrated };
}

/** برچسب موضوعی یک رویداد مالی: روی payload می‌نشیند و در ساخت سند تفصیلی می‌شود. */
export function setEventTopicLabel(eventId, label) {
  schema();
  const clean = normalizeTopicLabel(label);
  const row = db.prepare('SELECT id,payload,journal_entry_id AS journalEntryId FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw promotionError('رویداد پیدا نشد.', 'EVENT_NOT_FOUND', 404);
  return inTransaction(db, () => {
    // سند رویدادِ برگشت‌خورده زنده نیست و دست نمی‌خورد؛ دورهٔ بسته پیش از هر نوشتنی رد می‌شود.
    const entry = labelableEntry(db, row.journalEntryId);
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch { payload = {}; }
    payload.topicLabel = clean || null;
    db.prepare('UPDATE financial_events SET payload=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(payload), row.id);
    let attached = 0;
    let migrated = 0;
    if (clean && entry) {
      const analytic = topicAnalytic(db, clean);
      db.prepare(`UPDATE journal_lines SET analytic_id=NULL WHERE analytic_id=? AND entry_id=?`).run(analytic.id, entry.id);
      const ledgerType = payload.type === 'income' ? 'income' : 'expense';
      const promoted = promotedLedgerFor(db, analytic.id, ledgerType);
      const result = attachLabelToPostedEntry(db, entry.id, analytic.id, { migrateToLedgerId: promoted, ledgerType });
      attached = result.attached;
      migrated = result.migrated;
    }
    audit('label', 'financial-event', row.id, { label: clean, attachedToPosted: attached > 0, migrated });
    return { id: row.id, topicLabel: clean, attachedToPostedLines: attached, migratedLines: migrated };
  });
}
