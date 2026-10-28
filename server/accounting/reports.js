// گزارش‌های حسابداری: ترازها، صورت‌های مالی، دفاتر، اشخاص، مرکز هزینه و کنترل‌های دفتر.
//
// همه از یک منبع: ردیف‌های سندِ «تأییدشده» (همان قاعدهٔ `trialBalance`). پیش‌نویس، برگشتی و
// سندِ منتظر کنترل بخشی از دفاتر قطعی نیستند و در هیچ گزارشی نمی‌آیند؛ گزارش «کنترل‌ها»
// تعدادشان را می‌گوید.
//
// مرز روزها به وقت دفتر (پیش‌فرض تهران) و به تقویم شمسی است، نه UTC: سندی که ساعت ۲۳:۳۰
// آخرین روز اسفند زده شده مال همان سال است. از این رو جمع‌ها در JS ساخته می‌شوند، نه در SQL.
//
// هیچ گزارشی عددی را «درست» نمی‌کند: اگر ترازنامه نخواند، اختلاف صریح نشان داده می‌شود.

import { migrateAccountingLedger } from './ledgerSetup.js';
import { accountingError, fiscalStartMonth } from './ledgerAccounts.js';
import { fiscalYearLabel, fiscalYearOfKey, fiscalYearStartKey } from '../../shared/fiscalYear.js';
import { registerImportedTemporaryLines } from './yearClose.js';
import { persianToISO } from '../../shared/persianDate.js';

const CASH_ROLES = new Set(['cash', 'bank', 'petty-cash']);
const INVESTING_ROLES = new Set(['fixed-asset', 'accumulated-depreciation']);
const FINANCING_ROLES = new Set(['loan-payable', 'owner-capital', 'equity', 'partner-payable', 'partner-receivable']);
// حساب‌هایی که ماندهٔ خلاف ماهیت‌شان طبیعی است.
const FLEXIBLE_ROLES = new Set(['accumulated-depreciation', 'partner-payable', 'partner-receivable', 'memorandum']);
const NON_CURRENT = /غیر\s*‌?\s*جاری|بلند\s*‌?\s*مدت/;
export const TRIAL_LEVELS = Object.freeze(['group', 'general', 'subsidiary', 'account', 'analytic']);
const LEVEL_LABELS = Object.freeze({ group: 'گروه', general: 'کل', subsidiary: 'معین', account: 'حساب', analytic: 'تفصیلی' });
const TYPE_LABELS = Object.freeze({ asset: 'دارایی', liability: 'بدهی', equity: 'حقوق مالکانه', income: 'درآمد', expense: 'هزینه' });
const TYPE_ORDER = Object.freeze({ asset: 1, liability: 2, equity: 3, income: 4, expense: 5 });

// ---------------------------------------------------------------------------
// تاریخ: روزِ شمسی به وقت دفتر
// ---------------------------------------------------------------------------

function dayKeyFormatter(timeZone) {
  const format = new Intl.DateTimeFormat('en-CA-u-ca-persian-nu-latn', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const cache = new Map();
  return (iso) => {
    let key = cache.get(iso);
    if (key) return key;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const parts = Object.fromEntries(format.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    key = `${parts.year}-${parts.month}-${parts.day}`;
    cache.set(iso, key);
    return key;
  };
}

/** بازهٔ گزارش به روزهای شمسی؛ `from` و `to` تاریخ ISO هستند (هر لحظه‌ای از آن روز). */
function readRange({ from = '', to = '' } = {}, toDay) {
  const read = (value, label) => {
    if (!value) return '';
    const key = toDay(String(value));
    if (!key) throw accountingError(`تاریخ ${label} گزارش معتبر نیست.`, 'REPORT_DATE_INVALID');
    return key;
  };
  const fromDay = read(from, 'شروع');
  const toDayKey = read(to, 'پایان') || toDay(new Date().toISOString());
  if (fromDay && fromDay > toDayKey) throw accountingError('تاریخ شروع گزارش بعد از تاریخ پایان است.', 'REPORT_RANGE_INVALID');
  return { fromDay, toDay: toDayKey };
}


const DAY = 86_400_000;
/** لحظه‌ای ثابت درون یک روز شمسی؛ فاصلهٔ دو روز با آن عدد صحیحِ روز است. */
const dayInstant = (dayKey, timeZone) => Date.parse(persianToISO(...dayKey.split('-').map(Number), timeZone));
const daysBetween = (fromDay, toDay, timeZone) => Math.round((dayInstant(toDay, timeZone) - dayInstant(fromDay, timeZone)) / DAY);
/** روزِ شمسیِ n روز پیش از یک روز. */
const shiftDay = (dayKey, days, toDay, timeZone) => toDay(new Date(dayInstant(dayKey, timeZone) + days * DAY).toISOString());

// ---------------------------------------------------------------------------
// خواندن دفتر
// ---------------------------------------------------------------------------

/**
 * حساب‌ها با زنجیرهٔ کدینگ‌شان، و همهٔ ردیف‌های سند تأییدشده.
 *
 * حسابِ عملیاتی به یکی از سطوح کدینگ نگاشت می‌شود (معمولاً معین). `chain` از همان گره
 * تا گروه بالا می‌رود؛ حسابی که نگاشت ندارد زنجیرهٔ خالی دارد و در ترازِ سطح کدینگ زیر
 * «بدون نگاشت کدینگ» می‌نشیند — هیچ ردیفی از جمع‌ها بیرون نمی‌ماند.
 */
function readLedger(database, timeZone, { includeDrafts = false, beforeClose = false } = {}) {
  migrateAccountingLedger(database);
  // آرتیکل‌های بستن موقتِ بکاپ پارسیان پیش از خواندن برچسب می‌خورند (هر سند یک بار).
  registerImportedTemporaryLines(database, { timeZone });
  const toDay = dayKeyFormatter(timeZone);
  const chart = new Map(database.prepare('SELECT id,code,name,level,parent_id AS parentId,type,role FROM chart_accounts').all().map((row) => [row.id, row]));
  const chainOf = (id) => {
    const chain = [];
    const seen = new Set();
    for (let node = chart.get(id); node && !seen.has(node.id); node = chart.get(node.parentId)) { seen.add(node.id); chain.push(node); }
    return chain;
  };
  const accounts = new Map(database.prepare(`SELECT id,code,name,type,normal_side AS normalSide,source_kind AS sourceKind,
    source_key AS sourceKey,chart_account_id AS chartAccountId FROM ledger_accounts`).all().map((row) => {
    const chain = row.chartAccountId ? chainOf(row.chartAccountId) : [];
    const roles = new Set(chain.map((node) => node.role).filter(Boolean));
    const group = chain.find((node) => node.level === 'group') || null;
    return [row.id, {
      ...row, chain, roles, group,
      cash: row.sourceKind === 'operational-account' || [...roles].some((role) => CASH_ROLES.has(role)),
      memorandum: roles.has('memorandum'),
    }];
  }));
  const journalLines = database.prepare(`SELECT jl.id,jl.account_id AS accountId,jl.debit,jl.credit,jl.description,
      jl.analytic_id AS analyticId,jl.cost_center_id AS costCenterId,
      je.id AS entryId,je.occurred_at AS occurredAt,je.document_number AS documentNumber,je.memo,je.entry_kind AS entryKind,
      yc.role AS yearCloseRole,ycl.role AS lineRole
    FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    LEFT JOIN year_close_entries yc ON yc.entry_id=je.id
    LEFT JOIN year_close_lines ycl ON ycl.line_id=jl.id
    ${includeDrafts ? '' : "WHERE je.approval_state='approved'"}
    ORDER BY je.occurred_at,COALESCE(je.document_number,0),je.id,jl.rowid`).all()
    .map((line) => ({ ...line, debit: Number(line.debit) || 0, credit: Number(line.credit) || 0, day: toDay(line.occurredAt), temporary: line.yearCloseRole === 'temporary' || line.lineRole === 'temporary' }));
  // اختتامیه و افتتاحیه از مرز سال به بعد هم را خنثی می‌کنند؛ در هیچ مانده‌ای نیستند تا
  // ترازنامهٔ روز آخر سال صفر نشود و ماندهٔ سال بعد دو بار شمرده نشود. دفتر روزنامه نشانشان
  // می‌دهد. «قبل از بستن» سند بستن حساب‌های موقت را هم کنار می‌گذارد.
  const lines = journalLines.filter((line) => line.yearCloseRole !== 'closing' && line.yearCloseRole !== 'opening' && !(beforeClose && line.temporary));
  const analytics = new Map(database.prepare('SELECT id,code,name,kind,source_kind AS sourceKind,source_key AS sourceKey FROM analytic_accounts').all().map((row) => [row.id, row]));
  const costCenters = new Map(database.prepare('SELECT id,code,name FROM cost_centers').all().map((row) => [row.id, row]));
  // روزِ هر سند تأییدنشده؛ گزارش فقط آن‌هایی را می‌شمارد که تا پایان بازه‌اش اثر دارند.
  const drafts = includeDrafts ? database.prepare("SELECT occurred_at AS occurredAt FROM journal_entries WHERE approval_state<>'approved'").all().map((row) => toDay(row.occurredAt)) : [];
  return { toDay, timeZone, chart, accounts, lines, journalLines, analytics, costCenters, includeDrafts, drafts, startMonth: fiscalStartMonth(database) };
}

/** گزارشی که پیش‌نویس‌ها را هم شمرده، غیرقطعی است و باید همین را بگوید. */
const draftMark = (ledger, upTo) => (ledger.includeDrafts ? { provisional: true, draftEntries: ledger.drafts.filter((day) => day <= upTo).length } : {});

const before = (line, range) => Boolean(range.fromDay) && line.day < range.fromDay;
const within = (line, range) => (!range.fromDay || line.day >= range.fromDay) && line.day <= range.toDay;
const through = (line, day) => line.day <= day;

// ---------------------------------------------------------------------------
// سطح‌های تراز
// ---------------------------------------------------------------------------

/** ردیفِ یک حساب در یک سطح کدینگ. */
function nodeFor(account, level) {
  if (level === 'account') {
    const mapped = account.chain[0];
    return { key: account.id, code: account.code, name: account.name, type: account.type, chartCode: mapped?.code || '', chartName: mapped?.name || '', mapped: Boolean(mapped) };
  }
  const index = { subsidiary: 0, general: 1, group: 2 }[level];
  // گرهِ همان سطح؛ اگر حساب به سطحی بالاتر نگاشت شده، همان گره (کلی‌تر) ردیفش است.
  const exact = account.chain.find((node) => node.level === level);
  const fallback = account.chain.find((node) => ({ subsidiary: 0, general: 1, group: 2 }[node.level] > index));
  const node = exact || fallback;
  if (!node) return { key: `unmapped:${account.type}`, code: '', name: `بدون نگاشت کدینگ — ${TYPE_LABELS[account.type]}`, type: account.type, mapped: false };
  return { key: node.id, code: node.code, name: node.name, type: node.type, mapped: true };
}

function emptyRow(node) {
  return { ...node, openingDebit: 0, openingCredit: 0, periodDebit: 0, periodCredit: 0 };
}

function finishRow(row) {
  const openingNet = row.openingDebit - row.openingCredit;
  const closingNet = openingNet + row.periodDebit - row.periodCredit;
  return {
    ...row,
    openingDebitBalance: Math.max(0, openingNet), openingCreditBalance: Math.max(0, -openingNet),
    // «جمع گردش» تراز هشت‌ستونی: ماندهٔ اول دوره به‌علاوهٔ گردش دوره.
    totalDebit: Math.max(0, openingNet) + row.periodDebit, totalCredit: Math.max(0, -openingNet) + row.periodCredit,
    closingDebitBalance: Math.max(0, closingNet), closingCreditBalance: Math.max(0, -closingNet),
    closingNet,
  };
}

const sumBy = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0);
const TRIAL_FIELDS = ['openingDebit', 'openingCredit', 'openingDebitBalance', 'openingCreditBalance', 'periodDebit', 'periodCredit',
  'totalDebit', 'totalCredit', 'closingDebitBalance', 'closingCreditBalance'];

/**
 * تراز آزمایشی در هر سطح (گروه، کل، معین، حساب، تفصیلی) با همهٔ ستون‌ها.
 *
 * دو، چهار، شش و هشت ستونی همه از همین ردیف‌ها ساخته می‌شوند؛ فقط نمایش فرق دارد:
 * ۲: ماندهٔ پایان · ۴: جمع گردش تا پایان + مانده · ۶: ماندهٔ اول دوره + گردش دوره + ماندهٔ پایان ·
 * ۸: ماندهٔ اول دوره + گردش دوره + جمع + ماندهٔ پایان.
 */
export function trialBalanceReport(database, { from = '', to = '', level = 'subsidiary', includeZero = false, timeZone = 'Asia/Tehran', includeDrafts = false, beforeClose = false } = {}) {
  if (!TRIAL_LEVELS.includes(level)) throw accountingError('سطح تراز معتبر نیست.', 'REPORT_LEVEL_INVALID');
  const ledger = readLedger(database, timeZone, { includeDrafts, beforeClose });
  const range = readRange({ from, to }, ledger.toDay);
  const rows = new Map();
  const rowFor = (line) => {
    if (level === 'analytic') {
      const analytic = line.analyticId ? ledger.analytics.get(line.analyticId) : null;
      const key = analytic?.id || 'none';
      if (!rows.has(key)) rows.set(key, emptyRow(analytic ? { key, code: analytic.code, name: analytic.name, type: '', kind: analytic.kind, mapped: true } : { key, code: '', name: 'بدون تفصیلی', type: '', mapped: false }));
      return rows.get(key);
    }
    const node = nodeFor(ledger.accounts.get(line.accountId), level);
    if (!rows.has(node.key)) rows.set(node.key, emptyRow(node));
    return rows.get(node.key);
  };
  if (includeZero && level !== 'analytic') {
    for (const account of ledger.accounts.values()) { const node = nodeFor(account, level); if (!rows.has(node.key)) rows.set(node.key, emptyRow(node)); }
  }
  for (const line of ledger.lines) {
    if (line.day > range.toDay) continue;
    const row = rowFor(line);
    if (before(line, range)) { row.openingDebit += line.debit; row.openingCredit += line.credit; } else { row.periodDebit += line.debit; row.periodCredit += line.credit; }
  }
  const finished = [...rows.values()].map(finishRow)
    .filter((row) => includeZero || TRIAL_FIELDS.some((field) => row[field]))
    .sort((left, right) => (TYPE_ORDER[left.type] || 9) - (TYPE_ORDER[right.type] || 9) || String(left.code || '~').localeCompare(String(right.code || '~'), 'en', { numeric: true }) || left.name.localeCompare(right.name, 'fa'));
  const totals = Object.fromEntries(TRIAL_FIELDS.map((field) => [field, sumBy(finished, field)]));
  const checks = {
    opening: totals.openingDebit === totals.openingCredit,
    period: totals.periodDebit === totals.periodCredit,
    closing: totals.closingDebitBalance === totals.closingCreditBalance,
  };
  return { kind: 'trial', ...draftMark(ledger, range.toDay), ...(beforeClose ? { beforeClose: true } : {}), level, levelLabel: LEVEL_LABELS[level], range, rows: finished, totals, checks, balanced: checks.opening && checks.period && checks.closing };
}

// ---------------------------------------------------------------------------
// دفاتر
// ---------------------------------------------------------------------------

/** حساب‌هایی که زیر یک ردیفِ تراز می‌نشینند (برای کارت حساب و ریز هر ردیف). */
function accountsUnder(ledger, level, key) {
  return new Set([...ledger.accounts.values()].filter((account) => nodeFor(account, level).key === key).map((account) => account.id));
}

/**
 * دفتر کل، معین یا کارت حساب: ماندهٔ اول دوره، ردیف‌ها با ماندهٔ جاری، ماندهٔ پایان.
 *
 * ماندهٔ پایانِ این گزارش همان ماندهٔ پایانِ همان ردیف در تراز است — آزمون همین را می‌سنجد.
 */
export function accountLedgerReport(database, { from = '', to = '', level = 'subsidiary', key = '', analyticId = '', timeZone = 'Asia/Tehran', includeDrafts = false, beforeClose = false } = {}) {
  if (!TRIAL_LEVELS.includes(level)) throw accountingError('سطح دفتر معتبر نیست.', 'REPORT_LEVEL_INVALID');
  if (!key) throw accountingError('حساب دفتر انتخاب نشده است.', 'REPORT_ACCOUNT_REQUIRED');
  const ledger = readLedger(database, timeZone, { includeDrafts, beforeClose });
  const range = readRange({ from, to }, ledger.toDay);
  const matches = level === 'analytic'
    ? (line) => (key === 'none' ? !line.analyticId : line.analyticId === key)
    : (() => { const set = accountsUnder(ledger, level, key); return (line) => set.has(line.accountId) && (!analyticId || line.analyticId === analyticId); })();
  let title = '';
  if (level === 'analytic') title = key === 'none' ? 'بدون تفصیلی' : ledger.analytics.get(key)?.name || '';
  else {
    const sample = [...ledger.accounts.values()].find((account) => nodeFor(account, level).key === key);
    if (!sample) throw accountingError('حساب انتخاب‌شده در این دفتر نیست.', 'REPORT_ACCOUNT_MISSING');
    const node = nodeFor(sample, level);
    // در سطح حساب، کد کدینگ (همان که در تراز و پارسیان دیده می‌شود) بر کد داخلی مقدم است.
    const code = level === 'account' ? node.chartCode || node.code : node.code;
    title = code ? `${code} — ${node.name}` : node.name;
  }
  let opening = 0;
  let balance = 0;
  const rows = [];
  let periodDebit = 0;
  let periodCredit = 0;
  for (const line of ledger.lines) {
    if (!matches(line) || line.day > range.toDay) continue;
    if (before(line, range)) { opening += line.debit - line.credit; continue; }
    if (!rows.length) balance = opening;
    balance += line.debit - line.credit;
    periodDebit += line.debit;
    periodCredit += line.credit;
    const account = ledger.accounts.get(line.accountId);
    rows.push({
      id: line.id, entryId: line.entryId, day: line.day, documentNumber: line.documentNumber, entryKind: line.entryKind,
      description: line.description || line.memo, accountCode: account?.code || '', accountName: account?.name || '',
      analytic: line.analyticId ? ledger.analytics.get(line.analyticId)?.name || '' : '',
      debit: line.debit, credit: line.credit, balance,
    });
  }
  const closing = opening + periodDebit - periodCredit;
  return { kind: 'ledger', ...draftMark(ledger, range.toDay), level, key, title, range, opening, rows, totals: { debit: periodDebit, credit: periodCredit }, closing };
}

/** دفتر روزنامه: سندهای بازه با ردیف‌هایشان، به ترتیب تاریخ و شمارهٔ سند. */
export function journalBookReport(database, { from = '', to = '', timeZone = 'Asia/Tehran', limit = 3000, includeDrafts = false } = {}) {
  const ledger = readLedger(database, timeZone, { includeDrafts });
  const range = readRange({ from, to }, ledger.toDay);
  const entries = new Map();
  // دفتر روزنامه همهٔ سندها را دارد، اختتامیه و افتتاحیه هم؛ نقششان کنار سند می‌آید.
  for (const line of ledger.journalLines) {
    if (!within(line, range)) continue;
    if (!entries.has(line.entryId)) entries.set(line.entryId, { id: line.entryId, day: line.day, documentNumber: line.documentNumber, memo: line.memo, entryKind: line.entryKind, yearCloseRole: line.yearCloseRole || null, lines: [], debit: 0, credit: 0 });
    const entry = entries.get(line.entryId);
    const account = ledger.accounts.get(line.accountId);
    entry.lines.push({ accountCode: account?.chain[0]?.code || account?.code || '', accountName: account?.name || '', description: line.description,
      analytic: line.analyticId ? ledger.analytics.get(line.analyticId)?.name || '' : '', debit: line.debit, credit: line.credit });
    entry.debit += line.debit;
    entry.credit += line.credit;
  }
  const all = [...entries.values()];
  const safeLimit = Math.max(1, Math.min(10_000, Math.floor(Number(limit)) || 3000));
  return {
    kind: 'journal', ...draftMark(ledger, range.toDay), range, entries: all.slice(0, safeLimit), truncated: all.length > safeLimit, entryCount: all.length,
    totals: { debit: sumBy(all, 'debit'), credit: sumBy(all, 'credit') },
    // جمع اختتامیه و افتتاحیه جدا: گردش دورهٔ تراز = جمع روزنامه منهای همین.
    yearCloseTotals: { debit: sumBy(all.filter((entry) => ['closing', 'opening'].includes(entry.yearCloseRole)), 'debit') },
    unbalanced: all.filter((entry) => entry.debit !== entry.credit).map((entry) => entry.id),
  };
}

// ---------------------------------------------------------------------------
// صورت‌های مالی
// ---------------------------------------------------------------------------

/** خالصِ هر حساب در یک شرط، به ماهیتِ عادی نوعش (دارایی و هزینه بدهکار، بقیه بستانکار). */
function netByAccount(ledger, predicate) {
  const totals = new Map();
  for (const line of ledger.lines) {
    if (!predicate(line)) continue;
    totals.set(line.accountId, (totals.get(line.accountId) || 0) + line.debit - line.credit);
  }
  return totals;
}
const naturalSign = (type) => (['asset', 'expense'].includes(type) ? 1 : -1);

/** ردیف‌های یک بخش، گروه‌بندی‌شده به «کل» کدینگ و حساب‌های زیرش. */
function sectionRows(ledger, entries, { groupLevel = 'general' } = {}) {
  const groups = new Map();
  for (const [accountId, amount] of entries) {
    if (!amount) continue;
    const account = ledger.accounts.get(accountId);
    const node = nodeFor(account, groupLevel);
    if (!groups.has(node.key)) groups.set(node.key, { key: node.key, code: node.code, name: node.name, amount: 0, accounts: [] });
    const group = groups.get(node.key);
    group.amount += amount;
    group.accounts.push({ key: account.id, code: account.chain[0]?.code || account.code, name: account.name, amount });
  }
  return [...groups.values()]
    .map((group) => ({ ...group, accounts: group.accounts.sort((a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true })) }))
    .sort((a, b) => String(a.code || '~').localeCompare(String(b.code || '~'), 'en', { numeric: true }));
}
const sectionTotal = (rows) => rows.reduce((sum, row) => sum + row.amount, 0);

function incomeStatementFor(ledger, range) {
  // گروه‌هایی که حساب بهای تمام‌شده دارند (کدینگ پیش‌فرض: «بهای تمام‌شده»)؛ هر حسابِ زیرشان بهای فروش است.
  const cogsGroups = new Set([...ledger.accounts.values()].filter((account) => account.roles.has('cogs') && account.group).map((account) => account.group.id));
  const classOf = (account) => {
    if (account.type === 'income') return account.roles.has('other-income') ? 'otherIncome' : 'revenue';
    if (account.sourceKind === 'cogs-product' || account.roles.has('cogs') || (account.group && cogsGroups.has(account.group.id))) return 'costOfSales';
    return 'expenses';
  };
  const buckets = { revenue: new Map(), costOfSales: new Map(), expenses: new Map(), otherIncome: new Map() };
  // سند بستن حساب‌های موقت سود را جابه‌جا می‌کند، نمی‌سازد؛ در سود و زیان نیست.
  for (const [accountId, net] of netByAccount(ledger, (line) => within(line, range) && !line.temporary)) {
    const account = ledger.accounts.get(accountId);
    if (!['income', 'expense'].includes(account?.type) || account.memorandum) continue;
    buckets[classOf(account)].set(accountId, net * naturalSign(account.type));
  }
  const revenue = sectionRows(ledger, buckets.revenue);
  const costOfSales = sectionRows(ledger, buckets.costOfSales);
  const expenses = sectionRows(ledger, buckets.expenses);
  const otherIncome = sectionRows(ledger, buckets.otherIncome);
  const totals = { revenue: sectionTotal(revenue), costOfSales: sectionTotal(costOfSales), expenses: sectionTotal(expenses), otherIncome: sectionTotal(otherIncome) };
  totals.grossProfit = totals.revenue - totals.costOfSales;
  totals.operatingProfit = totals.grossProfit - totals.expenses;
  totals.netProfit = totals.operatingProfit + totals.otherIncome;
  return { range, revenue, costOfSales, expenses, otherIncome, totals };
}

/** بازهٔ هم‌طولِ پیش از این بازه، برای ستون مقایسه. */
function previousRange(range, ledger) {
  if (!range.fromDay) return null;
  const span = daysBetween(range.fromDay, range.toDay, ledger.timeZone);
  const toPrevious = shiftDay(range.fromDay, -1, ledger.toDay, ledger.timeZone);
  return { fromDay: shiftDay(toPrevious, -span, ledger.toDay, ledger.timeZone), toDay: toPrevious };
}

/** صورت سود و زیان یک بازه؛ با `compare` ستون بازهٔ هم‌طولِ قبل هم می‌آید. */
export function incomeStatementReport(database, { from = '', to = '', compare = false, timeZone = 'Asia/Tehran', includeDrafts = false } = {}) {
  const ledger = readLedger(database, timeZone, { includeDrafts });
  const range = readRange({ from, to }, ledger.toDay);
  const current = incomeStatementFor(ledger, range);
  const prior = compare ? previousRange(range, ledger) : null;
  return { kind: 'income-statement', ...draftMark(ledger, range.toDay), ...current, previous: prior ? incomeStatementFor(ledger, prior) : null };
}

function balanceSheetFor(ledger, asOf) {
  // ترازنامه سند بستن حساب‌های موقت را نمی‌شمارد: سود هر سال از خود درآمد و هزینه ساخته
  // می‌شود (پایین)، پس بستن سال هیچ عددی از ترازنامه را عوض نمی‌کند و سودِ روز آخر سال صفر
  // نمی‌شود. حساب انباشته فقط ثبت‌های دیگرش (تقسیم سود، اندوخته) را نشان می‌دهد.
  const nets = netByAccount(ledger, (line) => through(line, asOf) && !line.temporary);
  // «سال جاری» یعنی سال مالی دفتر، نه سال شمسی.
  const yearStart = fiscalYearStartKey(asOf, ledger.startMonth);
  const section = (type) => {
    const entries = new Map();
    for (const [accountId, net] of nets) {
      const account = ledger.accounts.get(accountId);
      if (account?.type !== type || account.memorandum) continue;
      entries.set(accountId, net * naturalSign(type));
    }
    // ترازنامه به «گروه» کدینگ تقسیم می‌شود (جاری و غیرجاری) و هر گروه به «کل».
    const groups = new Map();
    for (const [accountId, amount] of entries) {
      if (!amount) continue;
      const account = ledger.accounts.get(accountId);
      const group = nodeFor(account, 'group');
      if (!groups.has(group.key)) groups.set(group.key, { key: group.key, code: group.code, name: group.name, nonCurrent: NON_CURRENT.test(group.name), entries: new Map() });
      groups.get(group.key).entries.set(accountId, amount);
    }
    return [...groups.values()].map((group) => {
      const rows = sectionRows(ledger, group.entries);
      return { key: group.key, code: group.code, name: group.name, nonCurrent: group.nonCurrent, rows, amount: sectionTotal(rows) };
    }).sort((a, b) => Number(a.nonCurrent) - Number(b.nonCurrent) || String(a.code || '~').localeCompare(String(b.code || '~'), 'en', { numeric: true }));
  };
  const assets = section('asset');
  const liabilities = section('liability');
  const equity = section('equity');
  // سود سال‌های قبل «سود (زیان) انباشته» و امسال «سود (زیان) سال جاری».
  let retained = 0;
  let currentYear = 0;
  for (const line of ledger.lines) {
    if (!through(line, asOf) || line.temporary) continue;
    const account = ledger.accounts.get(line.accountId);
    if (!['income', 'expense'].includes(account?.type) || account.memorandum) continue;
    const profit = line.credit - line.debit;
    if (line.day < yearStart) retained += profit; else currentYear += profit;
  }
  const totals = {
    assets: assets.reduce((sum, group) => sum + group.amount, 0),
    liabilities: liabilities.reduce((sum, group) => sum + group.amount, 0),
    equityAccounts: equity.reduce((sum, group) => sum + group.amount, 0),
    retained, currentYear,
  };
  totals.equity = totals.equityAccounts + retained + currentYear;
  totals.liabilitiesAndEquity = totals.liabilities + totals.equity;
  totals.difference = totals.assets - totals.liabilitiesAndEquity;
  return { asOf, yearStart, assets, liabilities, equity, totals, balanced: totals.difference === 0 };
}

/** ترازنامه (صورت وضعیت مالی) در یک روز؛ با `compare` ستون پایان سال قبل هم می‌آید. */
export function balanceSheetReport(database, { to = '', compare = false, timeZone = 'Asia/Tehran', includeDrafts = false } = {}) {
  const ledger = readLedger(database, timeZone, { includeDrafts });
  const range = readRange({ to }, ledger.toDay);
  const current = balanceSheetFor(ledger, range.toDay);
  const previousDay = compare ? shiftDay(current.yearStart, -1, ledger.toDay, ledger.timeZone) : null;
  const memorandum = [...netByAccount(ledger, (line) => through(line, range.toDay))]
    .filter(([accountId, net]) => net && ledger.accounts.get(accountId)?.memorandum)
    .map(([accountId, net]) => { const account = ledger.accounts.get(accountId); return { key: accountId, code: account.chain[0]?.code || account.code, name: account.name, amount: net }; });
  return { kind: 'balance-sheet', ...draftMark(ledger, range.toDay), range, ...current, memorandum, previous: previousDay ? balanceSheetFor(ledger, previousDay) : null };
}

/**
 * صورت جریان وجوه نقد، روش مستقیم.
 *
 * در هر سند، تغییر نقدِ سند (صندوق، بانک و تنخواه) دقیقاً برابر جمعِ (بستانکار − بدهکار)ِ
 * ردیف‌های غیرنقدیِ همان سند است — چون سند متوازن است. پس هر ردیف غیرنقدی سهمِ خودش را
 * بی‌تخمین می‌گیرد و به فعالیتِ حسابش (عملیاتی، سرمایه‌گذاری، تأمین مالی) می‌رود. انتقال
 * میان حساب‌های نقدی ردیف غیرنقدی ندارد و جریانی نمی‌سازد. موجودی اول + جریان خالص =
 * موجودی پایان، همیشه.
 */
export function cashFlowReport(database, { from = '', to = '', timeZone = 'Asia/Tehran', includeDrafts = false } = {}) {
  const ledger = readLedger(database, timeZone, { includeDrafts });
  const range = readRange({ from, to }, ledger.toDay);
  const classOf = (account) => {
    if ([...account.roles].some((role) => INVESTING_ROLES.has(role))) return 'investing';
    if ([...account.roles].some((role) => FINANCING_ROLES.has(role)) || account.type === 'equity') return 'financing';
    if (account.group && NON_CURRENT.test(account.group.name)) return account.type === 'asset' ? 'investing' : account.type === 'liability' ? 'financing' : 'operating';
    return 'operating';
  };
  const byEntry = new Map();
  let opening = 0;
  let closing = 0;
  for (const line of ledger.lines) {
    if (line.day > range.toDay) continue;
    const account = ledger.accounts.get(line.accountId);
    if (account?.cash) {
      closing += line.debit - line.credit;
      if (before(line, range)) opening += line.debit - line.credit;
    }
    if (!within(line, range)) continue;
    if (!byEntry.has(line.entryId)) byEntry.set(line.entryId, []);
    byEntry.get(line.entryId).push(line);
  }
  const activities = { operating: new Map(), investing: new Map(), financing: new Map() };
  for (const lines of byEntry.values()) {
    if (!lines.some((line) => ledger.accounts.get(line.accountId)?.cash)) continue;
    for (const line of lines) {
      const account = ledger.accounts.get(line.accountId);
      if (account.cash) continue;
      const amount = line.credit - line.debit;
      const bucket = activities[classOf(account)];
      bucket.set(account.id, (bucket.get(account.id) || 0) + amount);
    }
  }
  const sections = Object.fromEntries(Object.entries(activities).map(([name, entries]) => {
    const rows = sectionRows(ledger, entries);
    return [name, { rows, inflow: rows.reduce((sum, row) => sum + row.accounts.reduce((s, a) => s + Math.max(0, a.amount), 0), 0),
      outflow: rows.reduce((sum, row) => sum + row.accounts.reduce((s, a) => s + Math.max(0, -a.amount), 0), 0), net: sectionTotal(rows) }];
  }));
  const net = sections.operating.net + sections.investing.net + sections.financing.net;
  return { kind: 'cash-flow', ...draftMark(ledger, range.toDay), range, ...sections, net, opening, closing, reconciled: opening + net === closing };
}

/** صورت تغییرات حقوق مالکانه: هر حساب سرمایه + سود بسته‌نشده، از اول تا پایان بازه. */
export function equityChangesReport(database, { from = '', to = '', timeZone = 'Asia/Tehran', includeDrafts = false } = {}) {
  const ledger = readLedger(database, timeZone, { includeDrafts });
  const range = readRange({ from, to }, ledger.toDay);
  const rows = new Map();
  let openingProfit = 0;
  let periodProfit = 0;
  // سند بستن موقت در بازه، سود را از ردیف «سود دوره» به حساب انباشته می‌برد: انتقال است،
  // نه سود یا زیان تازه. ردیف سود کم می‌شود و حساب انباشته زیاد؛ جمع ثابت می‌ماند.
  let transferred = 0;
  for (const line of ledger.lines) {
    if (line.day > range.toDay) continue;
    const account = ledger.accounts.get(line.accountId);
    if (!account || account.memorandum) continue;
    if (['income', 'expense'].includes(account.type)) {
      if (before(line, range)) openingProfit += line.credit - line.debit;
      else if (line.temporary) transferred += line.credit - line.debit;
      else periodProfit += line.credit - line.debit;
      continue;
    }
    if (account.type !== 'equity') continue;
    if (!rows.has(account.id)) rows.set(account.id, { key: account.id, code: account.chain[0]?.code || account.code, name: account.name, opening: 0, increase: 0, decrease: 0 });
    const row = rows.get(account.id);
    if (before(line, range)) row.opening += line.credit - line.debit;
    else { row.increase += line.credit; row.decrease += line.debit; }
  }
  const accounts = [...rows.values()].map((row) => ({ ...row, closing: row.opening + row.increase - row.decrease }))
    .sort((a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true }));
  const profit = {
    key: 'profit', code: '', name: 'سود (زیان) انباشته و سود دوره', opening: openingProfit,
    increase: Math.max(0, periodProfit) + Math.max(0, transferred), decrease: Math.max(0, -periodProfit) + Math.max(0, -transferred),
    transferred, closing: openingProfit + periodProfit + transferred,
  };
  const all = [...accounts, profit];
  const totals = { opening: sumBy(all, 'opening'), increase: sumBy(all, 'increase'), decrease: sumBy(all, 'decrease'), closing: sumBy(all, 'closing') };
  return { kind: 'equity-changes', ...draftMark(ledger, range.toDay), range, accounts, profit, periodProfit, totals };
}

// ---------------------------------------------------------------------------
// اشخاص
// ---------------------------------------------------------------------------

/**
 * ماندهٔ اشخاص (بدهکاران و بستانکاران) از دفتر کل.
 *
 * شخصِ هر ردیف از تفصیلیِ «طرف حساب» می‌آید (همان که به پارسیان می‌رود)، یا اگر ردیف
 * تفصیلی ندارد، از حسابِ اختصاصیِ طرف حساب. فقط حساب‌های ترازنامه‌ای؛ مثبت یعنی او به ما
 * بدهکار است.
 */
function personBalances(database, ledger, asOf) {
  const contacts = new Map(database.prepare('SELECT id,name FROM contacts').all().map((row) => [row.id, row.name]));
  const people = new Map();
  for (const line of ledger.lines) {
    if (!through(line, asOf)) continue;
    const account = ledger.accounts.get(line.accountId);
    if (!account || !['asset', 'liability'].includes(account.type) || account.memorandum || account.cash) continue;
    const analytic = line.analyticId ? ledger.analytics.get(line.analyticId) : null;
    let key = null;
    let name = '';
    if (analytic?.kind === 'contact') { key = analytic.sourceKey || analytic.id; name = analytic.name; }
    else if (['customer-receivable', 'vendor-payable'].includes(account.sourceKind)) { key = account.sourceKey; name = account.name.replace(/^حساب (?:دریافتنی|پرداختنی) — /, ''); }
    if (!key) continue;
    const contactId = contacts.has(key) ? key : [...contacts].find(([, contactName]) => contactName === key)?.[0] || null;
    const id = contactId || `name:${key}`;
    if (!people.has(id)) people.set(id, { key: id, contactId, name: contactId ? contacts.get(contactId) : name || key, debit: 0, credit: 0 });
    const person = people.get(id);
    person.debit += line.debit;
    person.credit += line.credit;
  }
  return [...people.values()].map((person) => ({ ...person, balance: person.debit - person.credit }));
}

export function personsReport(database, { to = '', timeZone = 'Asia/Tehran', includeDrafts = false } = {}) {
  const ledger = readLedger(database, timeZone, { includeDrafts });
  const range = readRange({ to }, ledger.toDay);
  const all = personBalances(database, ledger, range.toDay).filter((person) => person.balance);
  const debtors = all.filter((person) => person.balance > 0).sort((a, b) => b.balance - a.balance);
  const creditors = all.filter((person) => person.balance < 0).map((person) => ({ ...person, balance: -person.balance })).sort((a, b) => b.balance - a.balance);
  return { kind: 'persons', ...draftMark(ledger, range.toDay), range, debtors, creditors, totals: { debtors: sumBy(debtors, 'balance'), creditors: sumBy(creditors, 'balance') } };
}

const AGING_BUCKETS = Object.freeze([
  { id: 'current', label: 'سررسید نشده', max: 0 }, { id: 'd30', label: '۱ تا ۳۰ روز', max: 30 },
  { id: 'd60', label: '۳۱ تا ۶۰ روز', max: 60 }, { id: 'd90', label: '۶۱ تا ۹۰ روز', max: 90 }, { id: 'over', label: 'بیش از ۹۰ روز', max: Infinity },
]);

/**
 * گزارش سنی مطالبات و بدهی‌ها — امروز.
 *
 * سنِ هر مبلغ از سندِ بازش می‌آید (تعهد، فاکتور، چک) و از سررسیدش؛ سندِ بی‌سررسید از
 * تاریخ خودش. ماندهٔ دفتر کلِ هر شخص کنارش است و تفاوتِ این دو «ماندهٔ بی‌سند» است — همان
 * چیزی که در ورود بکاپ یا سند دستی آمده و سندِ بازی ندارد؛ پنهانش نمی‌کنیم.
 */
export function agingReport(database, { timeZone = 'Asia/Tehran', now = new Date(), includeDrafts = false } = {}) {
  const ledger = readLedger(database, timeZone, { includeDrafts });
  const today = ledger.toDay(now.toISOString());
  // روزهای گذشته از سررسید؛ منفی یعنی هنوز سررسید نشده.
  const ageDays = (iso) => (iso ? daysBetween(ledger.toDay(iso), today, timeZone) : 0);
  const exists = (name) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const documents = [
    ...(exists('obligations') ? database.prepare(`SELECT contact_id AS contactId,direction,title AS reference,occurred_at AS occurredAt,due_at AS dueAt,
      amount-COALESCE(paid_amount,0) AS remaining FROM obligations WHERE status='open' AND amount-COALESCE(paid_amount,0)>0`).all() : []),
    ...(exists('invoices') ? database.prepare(`SELECT contact_id AS contactId,CASE WHEN document_type='purchase' THEN 'payable' ELSE 'receivable' END AS direction,
      'فاکتور ' || number AS reference,COALESCE(issued_at,created_at) AS occurredAt,due_at AS dueAt,
      total-COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id=invoices.id),0) AS remaining FROM invoices WHERE status='sent'`).all() : []),
    ...(exists('cheques') ? database.prepare(`SELECT contact_id AS contactId,direction,'چک ' || COALESCE(serial,'') AS reference,occurred_at AS occurredAt,due_at AS dueAt,
      amount AS remaining FROM cheques WHERE status='open'`).all() : []),
  ].filter((document) => Number(document.remaining) > 0);
  const contacts = new Map(database.prepare('SELECT id,name FROM contacts').all().map((row) => [row.id, row.name]));
  const ledgerBalances = new Map(personBalances(database, ledger, today).filter((person) => person.contactId).map((person) => [person.contactId, person.balance]));
  const build = (direction) => {
    const people = new Map();
    for (const document of documents.filter((item) => item.direction === direction)) {
      const id = document.contactId || 'unknown';
      if (!people.has(id)) people.set(id, { key: id, contactId: document.contactId || null, name: contacts.get(document.contactId) || 'بدون طرف حساب', buckets: Object.fromEntries(AGING_BUCKETS.map((bucket) => [bucket.id, 0])), documents: 0, items: [] });
      const person = people.get(id);
      const age = ageDays(document.dueAt || document.occurredAt);
      const bucket = AGING_BUCKETS.find((item) => Math.max(0, age) <= item.max);
      const amount = Number(document.remaining);
      person.buckets[bucket.id] += amount;
      person.documents += amount;
      person.items.push({ reference: document.reference, dueDay: document.dueAt ? ledger.toDay(document.dueAt) : '', day: ledger.toDay(document.occurredAt), age: Math.max(0, age), bucket: bucket.id, amount });
    }
    return [...people.values()].map((person) => {
      const signed = ledgerBalances.get(person.contactId) ?? null;
      const ledgerBalance = signed == null ? null : direction === 'receivable' ? signed : -signed;
      return { ...person, ledgerBalance, unallocated: ledgerBalance == null ? null : ledgerBalance - person.documents };
    }).sort((a, b) => b.documents - a.documents);
  };
  const receivable = build('receivable');
  const payable = build('payable');
  const totalsOf = (rows) => ({ ...Object.fromEntries(AGING_BUCKETS.map((bucket) => [bucket.id, rows.reduce((sum, row) => sum + row.buckets[bucket.id], 0)])), documents: sumBy(rows, 'documents') });
  return { kind: 'aging', ...draftMark(ledger, today), asOf: today, buckets: AGING_BUCKETS.map(({ id, label }) => ({ id, label })), receivable, payable, totals: { receivable: totalsOf(receivable), payable: totalsOf(payable) } };
}

// ---------------------------------------------------------------------------
// مرکز هزینه و کنترل‌ها
// ---------------------------------------------------------------------------

/** درآمد و هزینهٔ هر مرکز هزینه در بازه؛ ردیفِ «بدون مرکز هزینه» جمع را کامل می‌کند. */
export function costCenterReport(database, { from = '', to = '', timeZone = 'Asia/Tehran', includeDrafts = false } = {}) {
  const ledger = readLedger(database, timeZone, { includeDrafts });
  const range = readRange({ from, to }, ledger.toDay);
  const centers = new Map();
  for (const line of ledger.lines) {
    if (!within(line, range) || line.temporary) continue;
    const account = ledger.accounts.get(line.accountId);
    if (!['income', 'expense'].includes(account?.type) || account.memorandum) continue;
    const center = line.costCenterId ? ledger.costCenters.get(line.costCenterId) : null;
    const key = center?.id || 'none';
    if (!centers.has(key)) centers.set(key, { key, code: center?.code || '', name: center?.name || 'بدون مرکز هزینه', income: 0, expense: 0, accounts: new Map() });
    const row = centers.get(key);
    if (account.type === 'income') row.income += line.credit - line.debit; else row.expense += line.debit - line.credit;
    row.accounts.set(account.id, (row.accounts.get(account.id) || 0) + (account.type === 'income' ? line.credit - line.debit : line.debit - line.credit));
  }
  const rows = [...centers.values()].map((row) => ({
    key: row.key, code: row.code, name: row.name, income: row.income, expense: row.expense, net: row.income - row.expense,
    accounts: [...row.accounts].filter(([, amount]) => amount).map(([accountId, amount]) => { const account = ledger.accounts.get(accountId); return { key: accountId, name: account.name, type: account.type, amount }; }),
  })).sort((a, b) => (a.key === 'none') - (b.key === 'none') || String(a.code).localeCompare(String(b.code), 'en', { numeric: true }));
  return { kind: 'cost-centers', ...draftMark(ledger, range.toDay), range, rows, totals: { income: sumBy(rows, 'income'), expense: sumBy(rows, 'expense'), net: sumBy(rows, 'net') } };
}

/**
 * کنترل‌های دفتر پیش از هر گزارش‌گیری رسمی: توازن، سندهای منتظر، حساب‌های بی‌نگاشت با
 * مانده، و مانده‌های خلاف ماهیت. هر مورد قابل پیگیری است، نه یک نمرهٔ کلی.
 */
export function ledgerControlsReport(database, { to = '', timeZone = 'Asia/Tehran', includeDrafts = false } = {}) {
  const ledger = readLedger(database, timeZone, { includeDrafts });
  const range = readRange({ to }, ledger.toDay);
  const entries = new Map();
  for (const line of ledger.lines) {
    if (!entries.has(line.entryId)) entries.set(line.entryId, { debit: 0, credit: 0, day: line.day, documentNumber: line.documentNumber, memo: line.memo });
    const entry = entries.get(line.entryId);
    entry.debit += line.debit;
    entry.credit += line.credit;
  }
  const unbalanced = [...entries].filter(([, entry]) => entry.debit !== entry.credit).map(([id, entry]) => ({ id, ...entry }));
  const pending = database.prepare(`SELECT je.approval_state AS state,COUNT(DISTINCT je.id) AS count,COALESCE(SUM(jl.debit),0) AS amount
    FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id WHERE je.approval_state<>'approved' GROUP BY je.approval_state`).all()
    .map((row) => ({ state: row.state, count: Number(row.count), amount: Number(row.amount) }));
  let deferred = 0;
  try { deferred = Number(database.prepare("SELECT COUNT(*) AS n FROM transactions WHERE status!='deleted' AND journal_deferred=1").get().n) || 0; } catch { deferred = 0; }
  const nets = netByAccount(ledger, (line) => through(line, range.toDay));
  const unmapped = [];
  const abnormal = [];
  for (const [accountId, net] of nets) {
    if (!net) continue;
    const account = ledger.accounts.get(accountId);
    if (!account) continue;
    const row = { key: account.id, code: account.code, name: account.name, type: account.type, balance: net };
    if (!account.chain.length) unmapped.push(row);
    if ([...account.roles].some((role) => FLEXIBLE_ROLES.has(role))) continue;
    const normal = naturalSign(account.type);
    if (net * normal < 0) abnormal.push({ ...row, reason: account.cash ? 'موجودی نقد یا بانک منفی است.' : `ماندهٔ ${net > 0 ? 'بدهکار' : 'بستانکار'} برای حساب ${TYPE_LABELS[account.type]} خلاف ماهیت است.` });
  }
  const trial = { debit: sumBy(ledger.lines, 'debit'), credit: sumBy(ledger.lines, 'credit') };
  return {
    kind: 'controls', range, balanced: trial.debit === trial.credit && !unbalanced.length, trial, unbalanced, pending, deferred,
    unmapped: unmapped.sort((a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true })),
    abnormal: abnormal.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)),
  };
}

// ---------------------------------------------------------------------------
// خروجی اکسل: همان عددهای گزارش، بی‌محاسبهٔ دوباره
// ---------------------------------------------------------------------------

const TRIAL_COLUMN_SETS = Object.freeze({
  2: [['closingDebitBalance', 'مانده بدهکار'], ['closingCreditBalance', 'مانده بستانکار']],
  4: [['totalDebit', 'جمع گردش بدهکار'], ['totalCredit', 'جمع گردش بستانکار'], ['closingDebitBalance', 'مانده بدهکار'], ['closingCreditBalance', 'مانده بستانکار']],
  6: [['openingDebitBalance', 'مانده اول دوره بدهکار'], ['openingCreditBalance', 'مانده اول دوره بستانکار'], ['periodDebit', 'گردش دوره بدهکار'], ['periodCredit', 'گردش دوره بستانکار'], ['closingDebitBalance', 'مانده پایان بدهکار'], ['closingCreditBalance', 'مانده پایان بستانکار']],
  8: [['openingDebitBalance', 'مانده اول دوره بدهکار'], ['openingCreditBalance', 'مانده اول دوره بستانکار'], ['periodDebit', 'گردش دوره بدهکار'], ['periodCredit', 'گردش دوره بستانکار'], ['totalDebit', 'جمع بدهکار'], ['totalCredit', 'جمع بستانکار'], ['closingDebitBalance', 'مانده پایان بدهکار'], ['closingCreditBalance', 'مانده پایان بستانکار']],
});
export const TRIAL_COLUMNS = TRIAL_COLUMN_SETS;

/** ردیف‌های جدولیِ هر گزارش برای اکسل؛ سطر اول سرستون است. */
export function reportSheets(report, { columns = 4, title = '' } = {}) {
  const head = (rows) => [{ name: (title || report.kind).slice(0, 31), rows }];
  if (report.kind === 'trial') {
    const set = TRIAL_COLUMN_SETS[columns] || TRIAL_COLUMN_SETS[4];
    return head([['کد', 'نام حساب', ...set.map(([, label]) => label)], ...report.rows.map((row) => [row.code, row.name, ...set.map(([field]) => row[field])]), ['', 'جمع', ...set.map(([field]) => report.totals[field])]]);
  }
  if (report.kind === 'ledger') {
    return head([['تاریخ', 'شماره سند', 'شرح', 'حساب', 'تفصیلی', 'بدهکار', 'بستانکار', 'مانده'], ['', '', 'ماندهٔ اول دوره', '', '', '', '', report.opening],
      ...report.rows.map((row) => [row.day.replaceAll('-', '/'), row.documentNumber ?? '', row.description, row.accountName, row.analytic, row.debit, row.credit, row.balance]),
      ['', '', 'جمع و ماندهٔ پایان', '', '', report.totals.debit, report.totals.credit, report.closing]]);
  }
  if (report.kind === 'journal') {
    const rows = [['تاریخ', 'شماره سند', 'شرح سند', 'کد حساب', 'حساب', 'شرح ردیف', 'تفصیلی', 'بدهکار', 'بستانکار']];
    for (const entry of report.entries) for (const line of entry.lines) rows.push([entry.day.replaceAll('-', '/'), entry.documentNumber ?? '', entry.memo, line.accountCode, line.accountName, line.description, line.analytic, line.debit, line.credit]);
    rows.push(['', '', '', '', 'جمع', '', '', report.totals.debit, report.totals.credit]);
    return head(rows);
  }
  const sectionLines = (label, rows, total) => [[label, '', ''], ...rows.flatMap((group) => [[group.code, group.name, group.amount], ...group.accounts.map((account) => [account.code, `   ${account.name}`, account.amount])]), ['', `جمع ${label}`, total]];
  if (report.kind === 'income-statement') {
    const { totals } = report;
    return head([['کد', 'شرح', 'مبلغ'], ...sectionLines('درآمد عملیاتی', report.revenue, totals.revenue), ...sectionLines('بهای تمام‌شدهٔ فروش', report.costOfSales, totals.costOfSales),
      ['', 'سود ناخالص', totals.grossProfit], ...sectionLines('هزینه‌های عملیاتی', report.expenses, totals.expenses), ['', 'سود عملیاتی', totals.operatingProfit],
      ...sectionLines('سایر درآمدها', report.otherIncome, totals.otherIncome), ['', 'سود (زیان) خالص', totals.netProfit]]);
  }
  if (report.kind === 'balance-sheet') {
    const groups = (label, sections, total) => [[label, '', ''], ...sections.flatMap((section) => sectionLines(section.name, section.rows, section.amount)), ['', `جمع ${label}`, total]];
    const { totals } = report;
    return head([['کد', 'شرح', 'مبلغ'], ...groups('دارایی‌ها', report.assets, totals.assets), ...groups('بدهی‌ها', report.liabilities, totals.liabilities),
      ...groups('حقوق مالکانه', report.equity, totals.equityAccounts), ['', 'سود (زیان) انباشته', totals.retained], ['', 'سود (زیان) سال جاری', totals.currentYear],
      ['', 'جمع حقوق مالکانه', totals.equity], ['', 'جمع بدهی‌ها و حقوق مالکانه', totals.liabilitiesAndEquity]]);
  }
  if (report.kind === 'cash-flow') {
    return head([['کد', 'شرح', 'مبلغ'], ...sectionLines('فعالیت‌های عملیاتی', report.operating.rows, report.operating.net), ...sectionLines('فعالیت‌های سرمایه‌گذاری', report.investing.rows, report.investing.net),
      ...sectionLines('فعالیت‌های تأمین مالی', report.financing.rows, report.financing.net), ['', 'خالص جریان نقد', report.net], ['', 'موجودی نقد اول دوره', report.opening], ['', 'موجودی نقد پایان دوره', report.closing]]);
  }
  if (report.kind === 'equity-changes') {
    return head([['کد', 'شرح', 'ماندهٔ اول دوره', 'افزایش', 'کاهش', 'ماندهٔ پایان'], ...[...report.accounts, report.profit].map((row) => [row.code, row.name, row.opening, row.increase, row.decrease, row.closing]),
      ['', 'جمع', report.totals.opening, report.totals.increase, report.totals.decrease, report.totals.closing]]);
  }
  if (report.kind === 'persons') {
    return [{ name: 'بدهکاران', rows: [['شخص', 'مانده بدهکار'], ...report.debtors.map((row) => [row.name, row.balance]), ['جمع', report.totals.debtors]] },
      { name: 'بستانکاران', rows: [['شخص', 'مانده بستانکار'], ...report.creditors.map((row) => [row.name, row.balance]), ['جمع', report.totals.creditors]] }];
  }
  if (report.kind === 'aging') {
    const sheet = (name, rows, totals) => ({ name, rows: [['شخص', ...report.buckets.map((bucket) => bucket.label), 'جمع اسناد باز', 'ماندهٔ دفتر', 'ماندهٔ بی‌سند'],
      ...rows.map((row) => [row.name, ...report.buckets.map((bucket) => row.buckets[bucket.id]), row.documents, row.ledgerBalance ?? '', row.unallocated ?? '']),
      ['جمع', ...report.buckets.map((bucket) => totals[bucket.id]), totals.documents, '', '']] });
    return [sheet('مطالبات', report.receivable, report.totals.receivable), sheet('بدهی‌ها', report.payable, report.totals.payable)];
  }
  if (report.kind === 'cost-centers') {
    return head([['کد', 'مرکز هزینه', 'درآمد', 'هزینه', 'خالص'], ...report.rows.map((row) => [row.code, row.name, row.income, row.expense, row.net]), ['', 'جمع', report.totals.income, report.totals.expense, report.totals.net]]);
  }
  if (report.kind === 'controls') {
    return head([['کنترل', 'نتیجه'], ['توازن دفتر', report.balanced ? 'متوازن' : 'نامتوازن'], ['سندهای نامتوازن', report.unbalanced.length],
      ...report.pending.map((row) => [`سند ${row.state}`, row.count]), ['ثبت‌های منتظر سند', report.deferred],
      ...report.unmapped.map((row) => [`بی‌نگاشت: ${row.code} ${row.name}`, row.balance]), ...report.abnormal.map((row) => [`خلاف ماهیت: ${row.code} ${row.name}`, row.balance])]);
  }
  throw accountingError('این گزارش خروجی اکسل ندارد.', 'REPORT_EXPORT_UNSUPPORTED');
}

/**
 * سال‌های شمسی‌ای که دفتر در آن‌ها سند دارد، با تعداد سند تأییدشده و غیرقطعی هر سال.
 *
 * دفتری که از بکاپ پر شده معمولاً سال‌های گذشته را دارد (بکاپ ۱۴۰۳ در دفتر امروز). بازهٔ
 * پیش‌فرضِ «سال جاری» آن‌جا خالی بود و گزارش هیچ نشان نمی‌داد؛ این فهرست انتخاب سال و
 * پیش‌فرضِ «آخرین سالِ دارای سند» را ممکن می‌کند.
 */
export function ledgerYears(database, { timeZone = 'Asia/Tehran' } = {}) {
  migrateAccountingLedger(database);
  const toDay = dayKeyFormatter(timeZone);
  const startMonth = fiscalStartMonth(database);
  const years = new Map();
  for (const row of database.prepare('SELECT occurred_at AS occurredAt,approval_state AS state FROM journal_entries').all()) {
    const key = toDay(row.occurredAt);
    if (!key) continue;
    // سال مالی دفتر، نه سال شمسی: با شروع از مهر، سند آبان ۱۴۰۳ مال سال مالی ۱۴۰۴ است.
    const year = fiscalYearOfKey(key, startMonth);
    if (!years.has(year)) years.set(year, { year, label: fiscalYearLabel(year, startMonth), approved: 0, drafts: 0 });
    years.get(year)[row.state === 'approved' ? 'approved' : 'drafts'] += 1;
  }
  const list = [...years.values()].sort((a, b) => b.year - a.year);
  return { years: list, currentYear: fiscalYearOfKey(toDay(new Date().toISOString()), startMonth), startMonth };
}
