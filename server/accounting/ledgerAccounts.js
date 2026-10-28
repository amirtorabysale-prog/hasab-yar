// حساب‌های دفتر کل: جدول‌ها، خطا، دوره و سال مالی، و حساب هر نقش، دسته، طرف حساب، کالا و مالیات.
//
// از server/accounting.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// accounting همه از همان server/accounting.js می‌خوانند.

import { randomUUID } from 'node:crypto';
import { ensureChartSchema, ensureOpeningEquityMapping, ensurePettyCashChartRole, ensureRetainedEarningsTemplate, ensureTaxPenaltyTemplate, listChartAccounts, mapLedgerAccountToChart, suggestChartAccount } from '../chartOfAccounts.js';
import { ensureJournalWorkflowSchema } from '../journalWorkflow.js';
import { fiscalYearOfKey, normalizeFiscalStartMonth } from '../../shared/fiscalYear.js';

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];

export function accountingError(message, code = 'ACCOUNTING_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function ensureAccountingSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ledger_accounts (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','income','expense')),
      normal_side TEXT NOT NULL CHECK(normal_side IN ('debit','credit')),
      source_kind TEXT,
      source_key TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_kind,source_key)
    );
    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      entry_kind TEXT NOT NULL DEFAULT 'normal' CHECK(entry_kind IN ('normal','reversal','adjustment','opening')),
      occurred_at TEXT NOT NULL,
      memo TEXT NOT NULL DEFAULT '',
      reverses_entry_id TEXT REFERENCES journal_entries(id) ON DELETE RESTRICT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_type,source_id,revision)
    );
    CREATE INDEX IF NOT EXISTS idx_journal_entries_occurred ON journal_entries(occurred_at,id);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(source_type,source_id,revision);
    CREATE TABLE IF NOT EXISTS journal_lines (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
      account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
      debit INTEGER NOT NULL DEFAULT 0 CHECK(debit>=0),
      credit INTEGER NOT NULL DEFAULT 0 CHECK(credit>=0),
      description TEXT NOT NULL DEFAULT '',
      CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0))
    );
    CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
    CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);
    CREATE TABLE IF NOT EXISTS accounting_periods (
      period TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','locked')),
      locked_by TEXT,
      locked_at TEXT,
      reopened_by TEXT,
      reopened_at TEXT,
      reopen_reason TEXT NOT NULL DEFAULT ''
    );
    -- سندهای بستن سال (accounting/yearClose.js). «موقت» سند واقعی است و در مانده‌ها می‌ماند؛
    -- «اختتامیه» و «افتتاحیه» جفتی‌اند که بعد از مرز سال هم را خنثی می‌کنند و گزارش‌ها از
    -- محاسبه بیرونشان می‌گذارند. اختتامیه و افتتاحیهٔ آمده از بکاپ پارسیان هم همین‌جا می‌نشیند.
    CREATE TABLE IF NOT EXISTS year_close_entries (
      entry_id TEXT PRIMARY KEY REFERENCES journal_entries(id) ON DELETE RESTRICT,
      year TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('temporary','closing','opening')),
      origin TEXT NOT NULL DEFAULT 'hesabyar' CHECK(origin IN ('hesabyar','parsian'))
    );
    CREATE TABLE IF NOT EXISTS fiscal_year_closings (
      id TEXT PRIMARY KEY,
      year TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('closed','reopened')),
      retained_account_id TEXT,
      profit INTEGER NOT NULL DEFAULT 0,
      closed_by TEXT,
      closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reopened_by TEXT,
      reopened_at TEXT,
      reopen_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_fiscal_year_closings_year ON fiscal_year_closings(year,status);
  `);
  const seed = database.prepare(`INSERT OR IGNORE INTO ledger_accounts
    (id,code,name,type,normal_side,source_kind,source_key) VALUES (?,?,?,?,?,?,?)`);
  seed.run('ledger-opening-equity', '3000', 'سرمایه و ماندهٔ افتتاحیه', 'equity', 'credit', 'system', 'opening-equity');
  // ستون‌های بعد (تفصیلی و مرکز هزینه) و نگاشت کدینگ روی همین جدول‌ها می‌نشینند.
  ensureChartSchema(database);
  ensureTaxPenaltyTemplate(database);
  ensureRetainedEarningsTemplate(database);
  ensurePettyCashChartRole(database);
  ensureOpeningEquityMapping(database);
  ensureJournalWorkflowSchema(database);
}

/** ماه شروع سال مالی این دفتر (shared/fiscalYear.js)؛ دفتر بی‌تنظیم از فروردین. */
export function fiscalStartMonth(database) {
  try { return normalizeFiscalStartMonth(database.prepare("SELECT value FROM settings WHERE key='fiscalYearStartMonth'").get()?.value); }
  catch { return 1; }
}

// سال مالیِ تاریخ وقوع سند: سالی که سال مالی در آن تمام می‌شود.
export function fiscalYearForDate(occurredAt, timeZone = 'Asia/Tehran', startMonth = 1) {
  return String(fiscalYearOfKey(periodForDate(occurredAt, timeZone), startMonth));
}

export function nextCode(database, type) {
  const ranges = { asset: 1100, liability: 2100, equity: 3100, income: 4100, expense: 5100 };
  const base = ranges[type] || 9100;
  const rows = database.prepare('SELECT code FROM ledger_accounts WHERE CAST(code AS INTEGER)>=? AND CAST(code AS INTEGER)<?').all(base, base + 900);
  const used = new Set(rows.map((row) => Number(row.code)));
  for (let code = base; code < base + 900; code += 1) if (!used.has(code)) return String(code);
  throw accountingError('شماره حساب آزاد پیدا نشد.', 'LEDGER_CODE_EXHAUSTED');
}

export function linkedLedgerAccount(database, sourceKind, sourceKey, name, type, forcedNormalSide = null, metadata = {}) {
  ensureAccountingSchema(database);
  const existing = database.prepare('SELECT * FROM ledger_accounts WHERE source_kind=? AND source_key=?').get(sourceKind, sourceKey);
  if (existing) {
    if (existing.name !== name) database.prepare('UPDATE ledger_accounts SET name=? WHERE id=?').run(name, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  // حساب کاهنده (مثل استهلاک انباشته) نوعش دارایی است ولی ماهیتش بستانکار؛
  // بدون این استثنا، انباشته به‌جای کم‌کردن، دارایی را زیاد نشان می‌دهد.
  const normalSide = forcedNormalSide || (['asset', 'expense'].includes(type) ? 'debit' : 'credit');
  database.prepare(`INSERT INTO ledger_accounts (id,code,name,type,normal_side,source_kind,source_key)
    VALUES (?,?,?,?,?,?,?)`).run(id, nextCode(database, type), name, type, normalSide, sourceKind, sourceKey);
  autoMapNewAccount(database, { id, type, sourceKind, sourceKey, name, ...metadata });
  return id;
}

/**
 * حساب تازه همان لحظه به معین کدینگ نگاشت می‌شود.
 *
 * تا امروز هر حساب تازه بدون معین مقصد می‌ماند و کاربر باید دستی «اعمال
 * پیشنهادها» را می‌زد. نتیجه‌اش در فایل انتقال دیده شد: همهٔ هزینه‌ها روی یک
 * معین عمومی، چون هیچ‌کس آن دکمه را نزده بود.
 *
 * پیشنهاد از `suggestChartAccount` می‌آید که معین اختصاصی هر دسته را می‌شناسد،
 * پس اجاره روی حساب اجاره می‌نشیند نه روی «سایر هزینه‌های عملیاتی».
 *
 * شکست بی‌صداست و عمدی: کدینگ ممکن است نصب نشده باشد یا معین متناسبی نداشته
 * باشد. نگاشت‌نشدن در صفحهٔ آمادگی دیده می‌شود، ولی نباید جلوی ثبت سند را
 * بگیرد — سندِ ثبت‌نشده بدتر از سندِ نگاشت‌نشده است.
 */
function autoMapNewAccount(database, ledgerAccount) {
  try {
    const chart = listChartAccounts(database);
    if (!chart.length) return;
    // فقط نگاشت مطمئن: دستهٔ ناشناخته بدون نگاشت می‌ماند تا حسابدار خودش
    // تصمیم بگیرد، نه اینکه بی‌صدا روی معین عمومی بنشیند.
    const suggestion = suggestChartAccount(ledgerAccount, chart, { confidentOnly: true });
    if (suggestion) mapLedgerAccountToChart(database, ledgerAccount.id, suggestion.id);
  } catch { /* کدینگ هنوز آمادهٔ نگاشت نیست. */ }
}

/** حسابِ تنخواه، نوعِ ستون «سایر» دارد؛ جدول تنخواه است که می‌گوید تنخواه است. */
export function isPettyCashAccount(database, accountId) {
  try { return Boolean(database.prepare('SELECT 1 FROM petty_cash_funds WHERE account_id=?').get(accountId)); }
  catch { return false; }
}

export function operationalLedgerAccount(database, accountId) {
  const account = database.prepare('SELECT id,name,kind,bank_id FROM accounts WHERE id=?').get(accountId);
  if (!account) throw accountingError('حساب مالی تراکنش برای دفتر کل پیدا نشد.', 'LEDGER_ACCOUNT_MISSING');
  return linkedLedgerAccount(database, 'operational-account', account.id, account.name, 'asset', null, { operationalKind: isPettyCashAccount(database, account.id) ? 'petty' : account.kind, bankId: account.bank_id });
}

/**
 * حساب دفتر کلِ یک دسته — کلیدش نام دسته است (`source_key`).
 *
 * برای موتور ارتقای برچسب هم صادر شده: دستهٔ تازه باید همان کلیدی را بگیرد که
 * ثبت‌های عادی می‌گیرند، وگرنه «سایر هزینه‌ها» و دستهٔ جدید دو حساب جدا می‌شدند
 * و انتقال ثبت‌های قبلی بی‌معنا می‌شد.
 */
export function categoryLedgerAccount(database, type, category) {
  const clean = String(category || (type === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها')).trim().slice(0, 80);
  ensureAccountingSchema(database);
  const accountType = type === 'income' ? 'income' : 'expense';
  const existing = database.prepare('SELECT id FROM ledger_accounts WHERE source_kind=? AND source_key=?').get(accountType + '-category', clean);
  if (existing) return existing.id;
  const suggestion = suggestChartAccount({ name: clean, type: accountType, sourceKind: accountType + '-category', sourceKey: clean }, listChartAccounts(database), { confidentOnly: true });
  if (suggestion) {
    const seeded = database.prepare(`SELECT id FROM ledger_accounts WHERE chart_account_id=? AND source_kind='chart-account' AND active=1 AND type=? AND normal_side=? ORDER BY code LIMIT 1`).get(suggestion.id, accountType, accountType === 'expense' ? 'debit' : 'credit');
    if (seeded) {
      // Bind the unused template account to its operational category, preserving
      // its identity, chart mapping and existing journal references.
      database.prepare('UPDATE ledger_accounts SET source_kind=?,source_key=?,name=? WHERE id=?').run(accountType + '-category', clean, clean, seeded.id);
      return seeded.id;
    }
  }
  return linkedLedgerAccount(database, type === 'income' ? 'income-category' : 'expense-category', clean, clean, type === 'income' ? 'income' : 'expense');
}

/**
 * کلید حسابِ یک طرف حساب — یکی، برای همهٔ مسیرها.
 *
 * شناسهٔ شخص پایدارتر از نام است (تغییر نام حساب تازه نمی‌سازد)، پس کلید
 * پیش‌فرض همان است. ولی اگر حسابی از قبل با نام ساخته شده — چون آن موقع شناسه
 * در دست نبود — همان برداشته می‌شود، وگرنه یک شخص دو حساب پیدا می‌کند.
 */
export function counterpartyAccountKey(database, sourceKind, contactId, cleanName) {
  const byId = String(contactId || '').trim().slice(0, 120);
  const byName = String(cleanName || '').trim().slice(0, 120);
  const has = (key) => Boolean(key && database.prepare('SELECT 1 FROM ledger_accounts WHERE source_kind=? AND source_key=?').get(sourceKind, key));
  if (byId && has(byId)) return byId;
  if (byName && has(byName)) return byName;
  return byId || byName;
}

export function counterpartyLedgerAccount(database, contactId, name, documentType) {
  const purchase = documentType === 'purchase';
  const cleanName = String(name || (purchase ? 'تأمین‌کننده متفرقه' : 'مشتری متفرقه')).trim().slice(0, 100);
  const sourceKind = purchase ? 'vendor-payable' : 'customer-receivable';
  return linkedLedgerAccount(
    database,
    sourceKind,
    counterpartyAccountKey(database, sourceKind, contactId, cleanName),
    purchase ? `حساب پرداختنی — ${cleanName}` : `حساب دریافتنی — ${cleanName}`,
    purchase ? 'liability' : 'asset',
  );
}

export function inventoryLedgerAccount(database, product) {
  return linkedLedgerAccount(database, 'inventory-product', product.id, `موجودی کالا — ${String(product.name).slice(0, 100)}`, 'asset');
}

export function cogsLedgerAccount(database, product) {
  return linkedLedgerAccount(database, 'cogs-product', product.id, `بهای تمام‌شده — ${String(product.name).slice(0, 100)}`, 'expense');
}

export function outputTaxLedgerAccount(database) {
  return linkedLedgerAccount(database, 'system', 'output-tax', 'مالیات و عوارض فروش پرداختنی', 'liability');
}

export function inputTaxLedgerAccount(database) {
  return linkedLedgerAccount(database, 'system', 'input-tax', 'اعتبار مالیات و عوارض خرید', 'asset');
}

export function periodForDate(occurredAt, timeZone = 'Asia/Tehran') {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) throw accountingError('تاریخ سند معتبر نیست.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA-u-ca-persian', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}
