// بستن سال مالی: سند بستن حساب‌های موقت، سند اختتامیه، سند افتتاحیهٔ سال بعد، قفل دوره‌ها
// و بازگشایی با سند معکوس.
//
// سه سند، با سه نقش متفاوت در گزارش‌ها (جدول `year_close_entries`):
//
//   موقت      — درآمد و هزینه را به «سود (زیان) انباشته» می‌برد. سند واقعی است و در هر
//               مانده‌ای می‌ماند؛ فقط صورت سود و زیان، مراکز هزینه و خلاصهٔ روز آن را
//               نمی‌شمارند، وگرنه سود سال در روز آخرش صفر نشان داده می‌شد.
//   اختتامیه  — ماندهٔ همهٔ حساب‌های دائمی را در آخرین لحظهٔ سال صفر می‌کند.
//   افتتاحیه  — همان مانده‌ها را در اولین لحظهٔ سال بعد برمی‌گرداند.
//
// اختتامیه و افتتاحیه از مرز سال به بعد دقیقاً هم را خنثی می‌کنند؛ پس گزارش‌ها هر دو را از
// محاسبه بیرون می‌گذارند (و فقط در دفتر روزنامه نشان می‌دهند). نتیجه: ترازنامهٔ روز آخر سال
// همان مانده‌ها را نشان می‌دهد نه صفر، و تراز سال بعد مانده را دو بار نمی‌شمارد. سند اختتامیه
// و افتتاحیه‌ای که از بکاپ پارسیان آمده با همین جدول همین رفتار را می‌گیرد.
//
// سود و زیان سال را سیستم «تصمیم» نمی‌گیرد: ذخیرهٔ مالیات عملکرد و اندوختهٔ قانونی سند
// تعدیلی حسابدارند و پیش از بستن باید ثبت شده باشند.

import { randomUUID } from 'node:crypto';
import { persianMonthRange } from '../../shared/persianDate.js';
import { mapLedgerAccountToChart } from '../chartOfAccounts.js';
import { fiscalYearLabel, fiscalYearMonths, fiscalYearOfKey } from '../../shared/fiscalYear.js';
import { accountingError, ensureAccountingSchema, fiscalStartMonth, fiscalYearForDate, linkedLedgerAccount } from './ledgerAccounts.js';
import { backfillDocumentNumbers } from '../journalWorkflow.js';
import { ensureParsianSourceSchema, insertJournal, nextRevision, reversedLine } from './journalCore.js';
import { trialBalance } from './journalBook.js';
import { unpostedRecognitionThrough } from './periods.js';

const SOURCE_TYPE = 'year-close';
// سقف آرتیکلِ سندهای بستن: یکی برای هر حساب، تفصیلی و مرکز هزینهٔ مانده‌دار.
const MAX_CLOSING_LINES = 200_000;
const ROLE_LABELS = Object.freeze({ temporary: 'بستن حساب‌های موقت', closing: 'اختتامیه', opening: 'افتتاحیه' });

// ---------------------------------------------------------------------------
// مرز سال
// ---------------------------------------------------------------------------

function readYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1300 || year > 1500) throw accountingError('سال مالی باید یک سال شمسی چهاررقمی باشد.', 'FISCAL_YEAR_INVALID');
  return year;
}

function dayKeyFormatter(timeZone) {
  const format = new Intl.DateTimeFormat('en-CA-u-ca-persian-nu-latn', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const parts = Object.fromEntries(format.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}

/**
 * مرز سال مالی، با ماه شروع دلخواه دفتر (shared/fiscalYear.js). سال مالی ۱۴۰۴ با شروع از
 * مهر، از ۱ مهر ۱۴۰۳ تا ۳۱ شهریور ۱۴۰۴ است.
 *
 * سند موقت دو ثانیه و اختتامیه یک ثانیه پیش از نیمه‌شبِ اول فروردین سال بعد (به وقت دفتر)
 * زده می‌شوند تا بعد از هر سند روز آخر بنشینند؛ افتتاحیه درست در همان نیمه‌شب.
 */
export function fiscalYearBounds(year, timeZone = 'Asia/Tehran', startMonth = 1) {
  const months = fiscalYearMonths(year, startMonth);
  const following = fiscalYearMonths(year + 1, startMonth).first;
  const start = persianMonthRange(months.first.year, months.first.month, timeZone);
  const next = persianMonthRange(following.year, following.month, timeZone);
  if (!start || !next) throw accountingError('مرز سال مالی ساخته نشد.', 'FISCAL_YEAR_INVALID');
  const nextStart = Date.parse(next.from);
  const toDay = dayKeyFormatter(timeZone);
  const temporaryAt = new Date(nextStart - 2000).toISOString();
  return {
    year, startMonth: months.first.month, label: fiscalYearLabel(year, startMonth), from: start.from, toExclusive: next.from,
    temporaryAt, closingAt: new Date(nextStart - 1000).toISOString(), openingAt: next.from,
    firstDay: `${months.periods[0]}-01`, lastDay: toDay(temporaryAt), nextFirstDay: `${following.year}-${String(following.month).padStart(2, '0')}-01`,
    periods: months.periods, nextPeriod: `${following.year}-${String(following.month).padStart(2, '0')}`,
  };
}

// ---------------------------------------------------------------------------
// خواندن دفتر
// ---------------------------------------------------------------------------

/** نقشِ سندهای بستن سال: entryId → { role, year, origin }. */
export function yearCloseRoles(database) {
  ensureAccountingSchema(database);
  return new Map(database.prepare('SELECT entry_id AS entryId,year,role,origin FROM year_close_entries').all().map((row) => [row.entryId, row]));
}

function readBook(database, timeZone) {
  ensureAccountingSchema(database);
  ensureParsianSourceSchema(database);
  const toDay = dayKeyFormatter(timeZone);
  const chart = new Map(database.prepare('SELECT id,parent_id AS parentId,role FROM chart_accounts').all().map((row) => [row.id, row]));
  const memorandumChart = (id) => {
    const seen = new Set();
    for (let node = chart.get(id); node && !seen.has(node.id); node = chart.get(node.parentId)) {
      seen.add(node.id);
      if (node.role === 'memorandum') return true;
    }
    return false;
  };
  const accounts = new Map(database.prepare(`SELECT id,code,name,type,active,chart_account_id AS chartAccountId FROM ledger_accounts`).all()
    .map((row) => [row.id, { ...row, memorandum: Boolean(row.chartAccountId) && memorandumChart(row.chartAccountId) }]));
  const entries = new Map();
  for (const row of database.prepare(`SELECT je.id,je.occurred_at AS occurredAt,je.approval_state AS state,je.entry_kind AS entryKind,
      je.document_number AS documentNumber,je.memo,je.reverses_entry_id AS reversesEntryId,
      EXISTS (SELECT 1 FROM parsian_imported_entries p WHERE p.entry_id=je.id) AS imported
    FROM journal_entries je`).all()) {
    entries.set(row.id, { ...row, day: toDay(row.occurredAt), imported: Boolean(row.imported), lines: [] });
  }
  for (const line of database.prepare(`SELECT id,entry_id AS entryId,account_id AS accountId,analytic_id AS analyticId,
      cost_center_id AS costCenterId,debit,credit FROM journal_lines ORDER BY rowid`).all()) {
    entries.get(line.entryId)?.lines.push({ ...line, debit: Number(line.debit) || 0, credit: Number(line.credit) || 0 });
  }
  return { toDay, accounts, entries, roles: yearCloseRoles(database) };
}

const isTemporaryAccount = (account) => ['income', 'expense'].includes(account?.type) && !account.memorandum;
const lineKey = (line) => `${line.accountId}|${line.analyticId || ''}|${line.costCenterId || ''}`;

/**
 * ماندهٔ هر (حساب، تفصیلی، مرکز هزینه) تا پایان یک روز، از سندهای تأییدشده، بی‌اختتامیه و
 * افتتاحیه. `exclude` سندهایی است که در همین محاسبه نباید باشند (نامزدهای تشخیص).
 */
function balancesThrough(book, lastDay, { exclude = new Set(), byAccount = false } = {}) {
  const totals = new Map();
  for (const entry of book.entries.values()) {
    if (entry.state !== 'approved' || entry.day > lastDay || exclude.has(entry.id)) continue;
    const role = book.roles.get(entry.id)?.role;
    if (role === 'closing' || role === 'opening') continue;
    for (const line of entry.lines) {
      const key = byAccount ? line.accountId : lineKey(line);
      totals.set(key, (totals.get(key) || 0) + line.debit - line.credit);
    }
  }
  return totals;
}

function netsOf(entry) {
  const nets = new Map();
  for (const line of entry.lines) nets.set(line.accountId, (nets.get(line.accountId) || 0) + line.debit - line.credit);
  for (const [key, value] of nets) if (!value) nets.delete(key);
  return nets;
}

// ---------------------------------------------------------------------------
// سند اختتامیه و افتتاحیهٔ پارسیان
// ---------------------------------------------------------------------------

/**
 * سند اختتامیه، افتتاحیه و بستن حساب‌های موقتی که از بکاپ پارسیان آمده‌اند.
 *
 * پارسیان سال را خودش می‌بندد و این سندها با بکاپ می‌آیند. تشخیص ساختاری و دقیق است، نه
 * از روی شرح: اختتامیه سندِ روز آخر سال است که بعد از آن ماندهٔ همهٔ حساب‌ها صفر است؛
 * افتتاحیه سندِ روز اول سال بعد است که خالصِ هر حسابش دقیقاً قرینهٔ همان اختتامیه است؛
 * سندی که این شرط‌ها را دقیق ندارد، سند عادی می‌ماند. بستن موقتِ پارسیان جداست و در سطح
 * آرتیکل تشخیص داده می‌شود (`registerImportedTemporaryLines`).
 */
function detectImportedYearClose(book, bounds) {
  const registered = (entry) => book.roles.has(entry.id);
  const lastDayCandidates = [...book.entries.values()]
    .filter((entry) => entry.imported && !registered(entry) && entry.day === bounds.lastDay && entry.lines.length >= 2)
    .sort((a, b) => Number(b.documentNumber || 0) - Number(a.documentNumber || 0));
  const allZero = (balances, predicate) => [...balances].every(([accountId, value]) => !value || !predicate(book.accounts.get(accountId)));

  let closing = null;
  for (const candidate of lastDayCandidates) {
    const balances = balancesThrough(book, bounds.lastDay, { exclude: new Set([candidate.id]), byAccount: true });
    if (![...balances.values()].some(Boolean)) continue;
    for (const [accountId, value] of netsOf(candidate)) balances.set(accountId, (balances.get(accountId) || 0) + value);
    if (allZero(balances, (account) => !account?.memorandum)) { closing = candidate; break; }
  }
  let opening = null;
  if (closing) {
    const expected = new Map([...netsOf(closing)].map(([accountId, value]) => [accountId, -value]));
    opening = [...book.entries.values()].find((entry) => entry.imported && !registered(entry) && entry.day === bounds.nextFirstDay
      && sameNets(netsOf(entry), expected)) || null;
  }
  return { closing, opening };
}

// ---------------------------------------------------------------------------
// بستن موقتِ پارسیان، در سطح آرتیکل
// ---------------------------------------------------------------------------

// بیش از این آرتیکلِ نامزد، جست‌وجوی ترکیب سنگین می‌شود؛ چنین سندی برچسب نمی‌خورد.
const MAX_CLOSING_CANDIDATES = 20;

/**
 * آرتیکل‌هایی از یک سند بکاپ که سود را از درآمد و هزینه به حقوق صاحبان سهام می‌برند.
 *
 * پارسیان بستن حساب‌های موقت را همیشه در یک سند جدا نمی‌زند. در بکاپ واقعی (۱۴۰۳) هزینه‌ها
 * در یک سند ۲۹ اسفند بسته شدند و فروش در سند ۳۰ اسفند، کنار محاسبهٔ بهای تمام‌شدهٔ ادواری
 * (خرید ← موجودی ← بهای تمام‌شده). برچسب کل سند یا سود را صفر می‌کرد یا بهای تمام‌شده را
 * از سود و زیان بیرون می‌انداخت؛ پس برچسب روی آرتیکل است.
 *
 * نامزد بستن: آرتیکل درآمدِ بدهکار و هزینهٔ بستانکار (رو به صفر). بستن، ترکیبی از نامزدهاست
 * که خالصش دقیقاً قرینهٔ خالص آرتیکل‌های حقوق صاحبان سهام همان سند باشد. اگر هیچ ترکیبی یا
 * بیش از یک ترکیب بخواند، حدس زده نمی‌شود و سند عادی می‌ماند.
 */
function temporaryClosingLines(book, entry) {
  const equity = entry.lines.filter((line) => { const account = book.accounts.get(line.accountId); return account?.type === 'equity' && !account.memorandum; });
  const candidates = entry.lines.filter((line) => {
    const account = book.accounts.get(line.accountId);
    return isTemporaryAccount(account) && (account.type === 'income' ? line.debit > 0 : line.credit > 0);
  });
  if (!equity.length || !candidates.length || candidates.length > MAX_CLOSING_CANDIDATES) return null;
  const target = -equity.reduce((sum, line) => sum + line.debit - line.credit, 0);
  if (!target) return null;
  const values = candidates.map((line) => line.debit - line.credit);
  let match = null;
  for (let mask = 1; mask < 2 ** candidates.length; mask += 1) {
    let total = 0;
    for (let index = 0; index < candidates.length; index += 1) if (mask & (2 ** index)) total += values[index];
    if (total !== target) continue;
    if (match !== null) return null;
    match = mask;
  }
  if (match === null) return null;
  return [...candidates.filter((_, index) => match & (2 ** index)), ...equity];
}

function ensureYearCloseLines(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS year_close_lines (
      line_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, year TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'temporary' CHECK(role IN ('temporary')), origin TEXT NOT NULL DEFAULT 'parsian');
    CREATE INDEX IF NOT EXISTS idx_year_close_lines_entry ON year_close_lines(entry_id);
    CREATE TABLE IF NOT EXISTS year_close_scanned (entry_id TEXT PRIMARY KEY)`);
}

/**
 * آرتیکل‌های بستن موقتِ همهٔ سندهای بکاپ را برچسب می‌زند؛ هر سند یک بار بررسی می‌شود.
 *
 * برچسب پیش از هر گزارش زده می‌شود، نه فقط هنگام بستن سال: سود و زیانِ سالی که پارسیان
 * بسته، بدون آن صفر نشان داده می‌شد. برچسب هیچ عددی از دفتر را عوض نمی‌کند؛ فقط می‌گوید این
 * آرتیکل سود را جابه‌جا کرده، نه ساخته. فقط ماه آخر سال مالی بررسی می‌شود.
 */
export function registerImportedTemporaryLines(database, { timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  ensureParsianSourceSchema(database);
  ensureYearCloseLines(database);
  const pending = Number(database.prepare(`SELECT COUNT(*) AS n FROM parsian_imported_entries p
    WHERE NOT EXISTS (SELECT 1 FROM year_close_scanned s WHERE s.entry_id=p.entry_id)`).get().n);
  if (!pending) return { scanned: 0, registered: 0 };
  const startMonth = fiscalStartMonth(database);
  const book = readBook(database, timeZone);
  const scanned = new Set(database.prepare('SELECT entry_id AS id FROM year_close_scanned').all().map((row) => row.id));
  const markScanned = database.prepare('INSERT OR IGNORE INTO year_close_scanned (entry_id) VALUES (?)');
  const register = database.prepare("INSERT OR IGNORE INTO year_close_lines (line_id,entry_id,year,role,origin) VALUES (?,?,?,'temporary','parsian')");
  let registered = 0;
  let count = 0;
  for (const entry of book.entries.values()) {
    if (!entry.imported || scanned.has(entry.id)) continue;
    count += 1;
    markScanned.run(entry.id);
    if (book.roles.has(entry.id) || !entry.day) continue;
    const year = fiscalYearOfKey(entry.day, startMonth);
    if (entry.day.slice(0, 7) !== fiscalYearMonths(year, startMonth).periods[11]) continue;
    const lines = temporaryClosingLines(book, entry);
    if (!lines) continue;
    for (const line of lines) register.run(line.id, entry.id, String(year));
    registered += 1;
  }
  return { scanned: count, registered };
}

/** سندهای بکاپی که در یک سال مالی آرتیکل بستن موقت دارند. */
function importedTemporaryEntries(database, year) {
  ensureYearCloseLines(database);
  return database.prepare(`SELECT DISTINCT y.entry_id AS id,j.document_number AS documentNumber FROM year_close_lines y
    JOIN journal_entries j ON j.id=y.entry_id WHERE y.year=? ORDER BY j.document_number`).all(String(year)).map((row) => ({ ...row }));
}

function sameNets(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

// ---------------------------------------------------------------------------
// حساب سود (زیان) انباشته
// ---------------------------------------------------------------------------

const RETAINED_NAME = /سود.*انباشته|انباشته.*سود/;

/** معین مقصد سود سال: انتخاب حسابدار، یا نقش «سود انباشته»، یا تنها معینِ هم‌نام. حدس نه. */
function resolveRetainedChart(database, chosenId = '') {
  const candidates = database.prepare(`SELECT id,code,name,role FROM chart_accounts
    WHERE level='subsidiary' AND type='equity' AND active=1 ORDER BY code`).all();
  const hasChart = Boolean(database.prepare('SELECT 1 FROM chart_accounts LIMIT 1').get());
  const listed = candidates.map(({ id, code, name }) => ({ id, code, name }));
  if (chosenId) {
    const chosen = candidates.find((item) => item.id === chosenId || item.code === chosenId);
    if (!chosen) throw accountingError('حساب انتخاب‌شده برای سود (زیان) انباشته معین فعال حقوق مالکانه نیست.', 'RETAINED_ACCOUNT_INVALID');
    return { chart: chosen, candidates: listed, hasChart };
  }
  const byRole = candidates.filter((item) => item.role === 'retained-earnings');
  const byName = candidates.filter((item) => RETAINED_NAME.test(item.name));
  const chart = byRole.length === 1 ? byRole[0] : byRole.length === 0 && byName.length === 1 ? byName[0] : null;
  return { chart, candidates: listed, hasChart };
}

function retainedLedgerAccount(database, chart) {
  if (!chart) return linkedLedgerAccount(database, 'system', 'retained-earnings', 'سود (زیان) انباشته', 'equity');
  const mapped = database.prepare(`SELECT id FROM ledger_accounts WHERE chart_account_id=? AND type='equity' AND active=1
    ORDER BY CASE WHEN source_kind='system' THEN 0 ELSE 1 END,code LIMIT 1`).get(chart.id);
  if (mapped) return mapped.id;
  const id = linkedLedgerAccount(database, 'system', `retained-earnings:${chart.id}`, chart.name, 'equity');
  mapLedgerAccountToChart(database, id, chart.id);
  return id;
}

// ---------------------------------------------------------------------------
// پیش‌نمایش
// ---------------------------------------------------------------------------

function activeClosing(database, year) {
  return database.prepare(`SELECT id,year,status,retained_account_id AS retainedAccountId,profit,closed_by AS closedBy,closed_at AS closedAt
    FROM fiscal_year_closings WHERE year=? AND status='closed' ORDER BY closed_at DESC LIMIT 1`).get(String(year)) || null;
}

/** آرتیکل‌هایی که ماندهٔ هر کلید را صفر می‌کنند؛ `keep` کلیدهای این سند را انتخاب می‌کند. */
function zeroingLines(book, balances, keep) {
  const lines = [];
  for (const [key, value] of balances) {
    if (!value) continue;
    const [accountId, analyticId, costCenterId] = key.split('|');
    if (!keep(book.accounts.get(accountId))) continue;
    lines.push({ accountId, analyticId: analyticId || null, costCenterId: costCenterId || null, debit: value < 0 ? -value : 0, credit: value > 0 ? value : 0 });
  }
  return lines;
}

function deferredTransactions(database, bounds) {
  try {
    return Number(database.prepare("SELECT COUNT(*) AS n FROM transactions WHERE status!='deleted' AND journal_deferred=1 AND occurred_at>=? AND occurred_at<?")
      .get(bounds.from, bounds.toExclusive).n) || 0;
  } catch { return 0; }
}

function planYearClose(database, year, { timeZone = 'Asia/Tehran', retainedChartAccountId = '' } = {}) {
  const startMonth = fiscalStartMonth(database);
  const bounds = fiscalYearBounds(year, timeZone, startMonth);
  registerImportedTemporaryLines(database, { timeZone });
  const book = readBook(database, timeZone);
  const blockers = [];
  const block = (code, message, extra = {}) => blockers.push({ code, message, ...extra });

  const inYear = [...book.entries.values()].filter((entry) => entry.day >= bounds.firstDay && entry.day <= bounds.lastDay);
  const unapproved = inYear.filter((entry) => entry.state !== 'approved');
  const closed = activeClosing(database, year);
  if (closed) block('FISCAL_YEAR_ALREADY_CLOSED', `سال ${year} بسته شده است. برای اصلاح، اول سال را با دلیل بازگشایی کن.`);
  if (!inYear.length) block('FISCAL_YEAR_EMPTY', `در سال ${year} هیچ سندی نیست.`);
  if (unapproved.length) {
    const states = unapproved.reduce((map, entry) => ({ ...map, [entry.state]: (map[entry.state] || 0) + 1 }), {});
    block('FISCAL_YEAR_UNAPPROVED_ENTRIES', `${unapproved.length} سند سال ${year} هنوز کنترل نشده است (پیش‌نویس، منتظر کنترل یا برگشتی). پیش از بستن، هر کدام را تأیید یا اصلاح کن.`, { count: unapproved.length, states });
  }
  const deferred = deferredTransactions(database, bounds);
  if (deferred) block('FISCAL_YEAR_DEFERRED_TRANSACTIONS', `${deferred} ثبت روزانهٔ سال ${year} هنوز سند حسابداری ندارد. بستن سال آن‌ها را بیرون از دفتر می‌گذاشت.`, { count: deferred });

  // سال‌های قبل به ترتیب بسته می‌شوند؛ سالی که فقط سند افتتاحیه دارد بستن نمی‌خواهد.
  const closedYears = new Set(database.prepare("SELECT year FROM fiscal_year_closings WHERE status='closed'").all().map((row) => Number(row.year)));
  const openEarlier = [...new Set([...book.entries.values()]
    .filter((entry) => entry.state === 'approved' && entry.day < bounds.firstDay && entry.entryKind !== 'opening' && !book.roles.has(entry.id))
    .map((entry) => fiscalYearOfKey(entry.day, startMonth)))].filter((item) => !closedYears.has(item)).sort();
  if (openEarlier.length) block('FISCAL_YEAR_PREVIOUS_OPEN', `سال ${openEarlier.join('، ')} هنوز بسته نشده است. سال‌ها به ترتیب بسته می‌شوند.`, { years: openEarlier });

  if (!trialBalance(database).balanced) block('TRIAL_BALANCE_UNBALANCED', 'دفتر کل نامتوازن است و سال قابل بستن نیست.');
  const recognition = unpostedRecognitionThrough(database, bounds.periods.at(-1), timeZone);
  if (recognition.length) block('RECOGNITION_DUE_BEFORE_CLOSE', `${recognition.length} قلم شناسایی پیش‌پرداخت یا درآمد انتقالی تا پایان سال ${year} هنوز سند نخورده؛ پیش از بستن، شناسایی ماهانه را اجرا کن یا تکلیفش را در صف حسابدار روشن کن.`, { count: recognition.length });
  const { nextPeriod } = bounds;
  if (database.prepare("SELECT 1 FROM accounting_periods WHERE period=? AND status='locked'").get(nextPeriod)) {
    block('NEXT_PERIOD_LOCKED', `دورهٔ ${nextPeriod} بسته است و سند افتتاحیه در آن ثبت نمی‌شود.`);
  }

  // سند بستنِ آمده از بکاپ پارسیان، اگر هست، جای سند ما را می‌گیرد.
  const imported = detectImportedYearClose(book, bounds);
  const pending = { ...Object.fromEntries(Object.entries(imported).filter(([, entry]) => entry).map(([role, entry]) => [entry.id, role])) };
  const rolesWithImported = new Map(book.roles);
  for (const [entryId, role] of Object.entries(pending)) rolesWithImported.set(entryId, { entryId, year: String(year), role, origin: 'parsian' });
  const planned = { ...book, roles: rolesWithImported };

  const before = balancesThrough(planned, bounds.lastDay);
  const temporaryLines = zeroingLines(planned, before, isTemporaryAccount);
  // سود سال: بستانکارِ خالصِ درآمد و هزینه. آرتیکل انباشته سند موقت را متوازن می‌کند.
  const profit = temporaryLines.reduce((sum, line) => sum + line.debit - line.credit, 0);
  const retained = resolveRetainedChart(database, retainedChartAccountId);
  if (temporaryLines.length && retained.hasChart && !retained.chart) {
    block('RETAINED_ACCOUNT_REQUIRED', 'معین «سود (زیان) انباشته» در کدینگ مشخص نیست. یکی از معین‌های حقوق مالکانه را انتخاب کن.', { candidates: retained.candidates });
  }
  // ماندهٔ دائمی بعد از سند موقت: همان مانده‌ها، به‌علاوهٔ سود روی انباشته.
  const permanent = new Map([...before].filter(([key]) => !isTemporaryAccount(planned.accounts.get(key.split('|')[0]))));
  const closingLines = imported.closing ? [] : zeroingLines(planned, permanent, () => true);
  if (!imported.closing && profit) closingLines.push({ retained: true, debit: profit > 0 ? profit : 0, credit: profit < 0 ? -profit : 0 });
  const permanentLineCount = closingLines.length;
  if (permanentLineCount > MAX_CLOSING_LINES) block('CLOSING_TOO_LARGE', `سند اختتامیه ${permanentLineCount} آرتیکل دارد که از سقف ${MAX_CLOSING_LINES} بیشتر است.`);

  const importedTemporary = importedTemporaryEntries(database, year);
  const reminders = [];
  if (importedTemporary.length) reminders.push(`بستن حساب‌های موقت در سند ${importedTemporary.map((entry) => entry.documentNumber ?? '—').join('، ')} بکاپ پارسیان انجام شده و در سود و زیان شمرده نمی‌شود.`);
  if (profit > 0) reminders.push('ذخیرهٔ مالیات عملکرد و اندوختهٔ قانونی خودکار ثبت نمی‌شوند؛ اگر لازم‌اند، پیش از بستن با سند تعدیلی ثبتشان کن.');
  if (imported.closing) reminders.push(`سند ${imported.closing.documentNumber ?? '—'} بکاپ پارسیان اختتامیهٔ همین سال است و جای سند اختتامیهٔ حساب‌یار را می‌گیرد.`);
  const nextYearEntries = [...book.entries.values()].filter((entry) => entry.day >= bounds.nextFirstDay && fiscalYearOfKey(entry.day, startMonth) === year + 1).length;
  if (nextYearEntries && !imported.closing) reminders.push(`سال ${year + 1} از قبل ${nextYearEntries} سند دارد؛ شمارهٔ سند افتتاحیه بعد از آن‌ها می‌آید، نه شمارهٔ ۱.`);

  return {
    bounds, book, blockers, imported, profit, retained, temporaryLines, closingLines, before,
    summary: {
      year, label: bounds.label, startMonth, from: bounds.firstDay, to: bounds.lastDay, ready: blockers.length === 0, blockers, reminders,
      closed, entries: { total: inYear.length, unapproved: unapproved.length },
      profit,
      temporary: { lines: temporaryLines.length, accounts: new Set(temporaryLines.map((line) => line.accountId)).size },
      permanent: { lines: permanentLineCount },
      retained: retained.chart ? { id: retained.chart.id, code: retained.chart.code, name: retained.chart.name } : null,
      retainedCandidates: retained.candidates,
      imported: {
        ...Object.fromEntries(Object.entries(imported).map(([role, entry]) => [role, entry ? { id: entry.id, documentNumber: entry.documentNumber, day: entry.day } : null])),
        temporary: importedTemporary,
      },
      documents: [
        { role: 'temporary', label: ROLE_LABELS.temporary, day: bounds.lastDay, lines: temporaryLines.length ? temporaryLines.length + (profit ? 1 : 0) : 0, source: importedTemporary.length && !temporaryLines.length ? 'parsian' : 'hesabyar' },
        { role: 'closing', label: ROLE_LABELS.closing, day: bounds.lastDay, lines: imported.closing ? netsOf(imported.closing).size : permanentLineCount, source: imported.closing ? 'parsian' : 'hesabyar' },
        { role: 'opening', label: ROLE_LABELS.opening, day: bounds.nextFirstDay, lines: imported.closing ? (imported.opening ? netsOf(imported.opening).size : 0) : permanentLineCount, source: imported.closing ? 'parsian' : 'hesabyar' },
      ],
    },
  };
}

/** وضعیت بستن یک سال: آماده است؟ چه چیزی جلویش را گرفته؟ سه سند چند آرتیکل دارند؟ */
export function previewYearClose(database, year, options = {}) {
  return planYearClose(database, readYear(year), options).summary;
}

// ---------------------------------------------------------------------------
// بستن و بازگشایی
// ---------------------------------------------------------------------------

function registerRole(database, entryId, year, role, origin = 'hesabyar') {
  database.prepare('INSERT INTO year_close_entries (entry_id,year,role,origin) VALUES (?,?,?,?)').run(entryId, String(year), role, origin);
}

function inTransaction(database, work) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * بستن سال: سند موقت، اختتامیه و افتتاحیه (یا ثبت همان‌هایی که از پارسیان آمده) و قفل
 * دوازده دورهٔ سال، همه در یک تراکنش. هر مانعی کل کار را پیش از ثبت هر سندی متوقف می‌کند.
 */
export function closeFiscalYear(database, yearValue, { userId = null, timeZone = 'Asia/Tehran', retainedChartAccountId = '' } = {}) {
  const year = readYear(yearValue);
  return inTransaction(database, () => {
    const plan = planYearClose(database, year, { timeZone, retainedChartAccountId });
    if (plan.blockers.length) {
      const [first] = plan.blockers;
      throw Object.assign(accountingError(first.message, first.code, 409), { details: { blockers: plan.blockers } });
    }
    const { bounds, imported } = plan;
    const created = {};
    for (const [role, entry] of Object.entries(imported)) if (entry) registerRole(database, entry.id, year, role, 'parsian');

    const retainedId = plan.temporaryLines.length ? retainedLedgerAccount(database, plan.retained.chart) : null;
    const retainedName = retainedId ? database.prepare('SELECT name FROM ledger_accounts WHERE id=?').get(retainedId).name : '';
    const post = (role, sourceId, occurredAt, memo, lines) => {
      const result = insertJournal(database, {
        sourceType: SOURCE_TYPE, sourceId, revision: nextRevision(database, SOURCE_TYPE, sourceId), entryKind: 'adjustment',
        occurredAt, memo, createdBy: userId, timeZone, approvalState: 'approved', lines, maxLines: MAX_CLOSING_LINES, allowInactive: true,
      });
      registerRole(database, result.id, year, role);
      created[role] = { id: result.id, documentNumber: result.documentNumber, fiscalYear: result.fiscalYear, total: result.total, lines: lines.length };
      return result;
    };

    if (plan.temporaryLines.length) {
      const lines = plan.temporaryLines.map((line) => ({ ...line, description: 'بستن حساب موقت' }));
      if (plan.profit) lines.push({ accountId: retainedId, debit: plan.profit < 0 ? -plan.profit : 0, credit: plan.profit > 0 ? plan.profit : 0, description: plan.profit > 0 ? `سود سال ${year}` : `زیان سال ${year}` });
      post('temporary', `${year}:temporary`, bounds.temporaryAt, `بستن حساب‌های موقت سال ${year} — ${plan.profit >= 0 ? 'سود' : 'زیان'} به «${retainedName}»`, lines);
    }

    if (!imported.closing) {
      const closing = plan.closingLines.map((line) => (line.retained ? { ...line, accountId: retainedId, retained: undefined } : line))
        .map(({ retained, ...line }) => ({ ...line, description: 'اختتامیه' }));
      // انباشته‌ای که پیش از این سند هم مانده داشت، دو آرتیکل می‌گیرد؛ یکی می‌شوند.
      const merged = mergeLines(closing);
      if (merged.length >= 2) {
        post('closing', `${year}:closing`, bounds.closingAt, `سند اختتامیهٔ سال ${year}`, merged);
        post('opening', `${year}:opening`, bounds.openingAt, `سند افتتاحیهٔ سال ${year + 1} — ماندهٔ پایان سال ${year}`, merged.map((line) => ({ ...reversedLine(line), description: 'افتتاحیه' })));
      }
    }

    const id = randomUUID();
    database.prepare(`INSERT INTO fiscal_year_closings (id,year,status,retained_account_id,profit,closed_by) VALUES (?,?,'closed',?,?,?)`)
      .run(id, String(year), retainedId, plan.profit, userId);
    const lock = database.prepare(`INSERT INTO accounting_periods (period,status,locked_by,locked_at) VALUES (?,'locked',?,CURRENT_TIMESTAMP)
      ON CONFLICT(period) DO UPDATE SET status='locked',locked_by=excluded.locked_by,locked_at=CURRENT_TIMESTAMP`);
    for (const period of bounds.periods) lock.run(period, userId);
    return { id, year, profit: plan.profit, documents: created, imported: plan.summary.imported, lockedPeriods: bounds.periods };
  });
}

function mergeLines(lines) {
  const totals = new Map();
  for (const line of lines) {
    const key = lineKey(line);
    totals.set(key, (totals.get(key) || 0) + line.debit - line.credit);
  }
  return [...totals].filter(([, value]) => value).map(([key, value]) => {
    const [accountId, analyticId, costCenterId] = key.split('|');
    return { accountId, analyticId: analyticId || null, costCenterId: costCenterId || null, debit: value > 0 ? value : 0, credit: value < 0 ? -value : 0, description: 'اختتامیه' };
  });
}

/**
 * بازگشایی سال بسته: دوره‌ها باز می‌شوند، سه سند حساب‌یار با سند معکوس خنثی می‌شوند (حذف
 * نمی‌شوند) و سندهای پارسیان از نقش بستن بیرون می‌آیند. فقط آخرین سالِ بسته بازگشایی
 * می‌شود؛ وگرنه افتتاحیهٔ سال بعدش با مانده‌ای که دیگر درست نیست می‌ماند.
 */
export function reopenFiscalYear(database, yearValue, { userId = null, reason = '', timeZone = 'Asia/Tehran' } = {}) {
  const year = readYear(yearValue);
  const cleanReason = String(reason || '').trim().slice(0, 500);
  if (cleanReason.length < 10) throw accountingError('دلیل بازگشایی سال را با حداقل ۱۰ نویسه ثبت کن.', 'REOPEN_REASON_REQUIRED');
  ensureAccountingSchema(database);
  return inTransaction(database, () => {
    const closed = activeClosing(database, year);
    if (!closed) throw accountingError(`سال ${year} بسته نیست.`, 'FISCAL_YEAR_NOT_CLOSED', 404);
    const later = database.prepare("SELECT year FROM fiscal_year_closings WHERE status='closed' AND CAST(year AS INTEGER)>? ORDER BY year").all(year).map((row) => row.year);
    if (later.length) throw accountingError(`سال ${later.join('، ')} بعد از این سال بسته شده است؛ اول آن را بازگشایی کن.`, 'LATER_YEAR_CLOSED', 409);
    const bounds = fiscalYearBounds(year, timeZone, fiscalStartMonth(database));
    if (database.prepare("SELECT 1 FROM accounting_periods WHERE period=? AND status='locked'").get(bounds.nextPeriod)) {
      throw accountingError(`دورهٔ ${bounds.nextPeriod} بسته است و معکوس سند افتتاحیه در آن ثبت نمی‌شود.`, 'NEXT_PERIOD_LOCKED', 409);
    }
    database.prepare(`UPDATE accounting_periods SET status='open',reopened_by=?,reopened_at=CURRENT_TIMESTAMP,reopen_reason=?
      WHERE period IN (${bounds.periods.map(() => '?').join(',')}) AND status='locked'`).run(userId, cleanReason, ...bounds.periods);

    const ours = database.prepare(`SELECT y.entry_id AS entryId,y.role,j.source_id AS sourceId,j.occurred_at AS occurredAt
      FROM year_close_entries y JOIN journal_entries j ON j.id=y.entry_id
      WHERE y.year=? AND y.origin='hesabyar' AND j.entry_kind<>'reversal'
        AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=j.id)
      ORDER BY CASE y.role WHEN 'opening' THEN 0 WHEN 'closing' THEN 1 ELSE 2 END`).all(String(year));
    const reversals = [];
    for (const entry of ours) {
      const lines = database.prepare(`SELECT account_id AS accountId,debit,credit,description,analytic_id AS analyticId,cost_center_id AS costCenterId
        FROM journal_lines WHERE entry_id=? ORDER BY rowid`).all(entry.entryId).map(reversedLine);
      const result = insertJournal(database, {
        sourceType: SOURCE_TYPE, sourceId: entry.sourceId, revision: nextRevision(database, SOURCE_TYPE, entry.sourceId), entryKind: 'reversal',
        occurredAt: entry.occurredAt, memo: `معکوس ${ROLE_LABELS[entry.role]} سال ${year} — بازگشایی: ${cleanReason}`, reversesEntryId: entry.entryId,
        createdBy: userId, timeZone, approvalState: 'approved', lines, maxLines: MAX_CLOSING_LINES, allowInactive: true,
      });
      registerRole(database, result.id, year, entry.role);
      reversals.push({ role: entry.role, id: result.id, documentNumber: result.documentNumber });
    }
    const released = database.prepare("DELETE FROM year_close_entries WHERE year=? AND origin='parsian'").run(String(year)).changes;
    database.prepare(`UPDATE fiscal_year_closings SET status='reopened',reopened_by=?,reopened_at=CURRENT_TIMESTAMP,reopen_reason=? WHERE id=?`)
      .run(userId, cleanReason, closed.id);
    return { year, reversals, releasedImported: released, reopenedPeriods: bounds.periods };
  });
}

/** فهرست سال‌های بسته و بازگشایی‌شده، تازه‌ترین اول. */
export function fiscalYearClosings(database) {
  ensureAccountingSchema(database);
  return database.prepare(`SELECT id,year,status,profit,closed_by AS closedBy,closed_at AS closedAt,reopened_by AS reopenedBy,
    reopened_at AS reopenedAt,reopen_reason AS reopenReason FROM fiscal_year_closings ORDER BY closed_at DESC,year DESC`).all();
}

// ---------------------------------------------------------------------------
// ماه شروع سال مالی
// ---------------------------------------------------------------------------

/**
 * ماه شروع سال مالی دفتر را عوض می‌کند و سال مالی و شمارهٔ همهٔ سندها را از نو می‌سازد.
 *
 * شمارهٔ سند در هر سال مالی از ۱ است؛ با جابه‌جا شدن مرز سال، دنباله باید از نو ساخته شود.
 * پس تغییر فقط وقتی ممکن است که هیچ شماره‌ای بیرون از دفتر «ثبت» نشده باشد: هیچ سالی بسته
 * نیست، هیچ دوره‌ای قفل نیست و هیچ بسته‌ای به پارسیان تحویل نشده. وگرنه سند ۱۲ دورهٔ بسته
 * یا فایل تحویل‌شده بی‌صدا سند دیگری می‌شد.
 */
export function setFiscalYearStartMonth(database, value, { timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const month = Number(value);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw accountingError('ماه شروع سال مالی باید عددی از ۱ (فروردین) تا ۱۲ (اسفند) باشد.', 'FISCAL_START_INVALID');
  const previous = fiscalStartMonth(database);
  if (previous === month) return { startMonth: month, changed: false, renumbered: 0 };
  const closed = database.prepare("SELECT year FROM fiscal_year_closings WHERE status='closed' ORDER BY year").all().map((row) => row.year);
  if (closed.length) throw accountingError(`سال ${closed.join('، ')} بسته شده است؛ ماه شروع سال مالی فقط پیش از بستن اولین سال عوض می‌شود. اول سال‌ها را بازگشایی کن.`, 'FISCAL_START_LOCKED', 409);
  const locked = database.prepare("SELECT period FROM accounting_periods WHERE status='locked' ORDER BY period").all().map((row) => row.period);
  if (locked.length) throw accountingError(`دوره‌های ${locked.slice(0, 6).join('، ')} قفل‌اند؛ تغییر سال مالی شمارهٔ سندهای آن‌ها را عوض می‌کرد. اول دوره‌ها را باز کن.`, 'FISCAL_START_LOCKED', 409);
  let delivered = 0;
  try { delivered = Number(database.prepare("SELECT COUNT(*) AS n FROM accounting_transfer_batches WHERE status IN ('delivered','accepted')").get().n) || 0; } catch { delivered = 0; }
  if (delivered) throw accountingError(`${delivered} بستهٔ انتقال به پارسیان تحویل شده و شمارهٔ سندهایش آن‌جا ثبت است؛ ماه شروع سال مالی دیگر عوض نمی‌شود.`, 'FISCAL_START_LOCKED', 409);
  return inTransaction(database, () => {
    database.prepare("INSERT INTO settings (key,value) VALUES ('fiscalYearStartMonth',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(month));
    // شماره‌ها اول خالی می‌شوند تا شاخص یکتای (سال، شماره) وسط کار به هم نخورد؛ بعد به
    // ترتیب تاریخ وقوع و زمان ثبت، همان قاعدهٔ شماره‌گذاری اسناد قدیمی، پر می‌شوند.
    const total = database.prepare('UPDATE journal_entries SET document_number=NULL').run().changes;
    // «ماه آخر سال» عوض شد؛ بستن موقتِ بکاپ پارسیان از نو بررسی می‌شود.
    ensureYearCloseLines(database);
    database.exec('DELETE FROM year_close_lines; DELETE FROM year_close_scanned;');
    backfillDocumentNumbers(database, (occurredAt) => fiscalYearForDate(occurredAt, timeZone, month));
    return { startMonth: month, previous, changed: true, renumbered: total };
  });
}
