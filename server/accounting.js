import { randomUUID } from 'node:crypto';
import {
  analyticForContact, counterpartyAnalyticForKey, ensureChartSchema, listChartAccounts, mapLedgerAccountToChart,
  resolveLineDimensions, saveAnalyticAccount, suggestChartAccount,
} from './chartOfAccounts.js';
import { ensurePayrollSchema, payrollJournalLines } from './payroll.js';
import {
  APPROVAL_STATES, assertApprovalTransition, backfillDocumentNumbers, ensureJournalWorkflowSchema,
  nextDocumentNumber, normalizeApprovalState, worklistSummary,
} from './journalWorkflow.js';


const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];

function accountingError(message, code = 'ACCOUNTING_INVALID', status = 400) {
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
  `);
  const seed = database.prepare(`INSERT OR IGNORE INTO ledger_accounts
    (id,code,name,type,normal_side,source_kind,source_key) VALUES (?,?,?,?,?,?,?)`);
  seed.run('ledger-opening-equity', '3000', 'سرمایه و ماندهٔ افتتاحیه', 'equity', 'credit', 'system', 'opening-equity');
  // ستون‌های بعد (تفصیلی و مرکز هزینه) و نگاشت کدینگ روی همین جدول‌ها می‌نشینند.
  ensureChartSchema(database);
  ensureJournalWorkflowSchema(database);
}

// سال مالی از سال شمسی تاریخ وقوع سند گرفته می‌شود.
export function fiscalYearForDate(occurredAt, timeZone = 'Asia/Tehran') {
  return periodForDate(occurredAt, timeZone).split('-')[0];
}

function nextCode(database, type) {
  const ranges = { asset: 1100, liability: 2100, equity: 3100, income: 4100, expense: 5100 };
  const base = ranges[type] || 9100;
  const rows = database.prepare('SELECT code FROM ledger_accounts WHERE CAST(code AS INTEGER)>=? AND CAST(code AS INTEGER)<?').all(base, base + 900);
  const used = new Set(rows.map((row) => Number(row.code)));
  for (let code = base; code < base + 900; code += 1) if (!used.has(code)) return String(code);
  throw accountingError('شماره حساب آزاد پیدا نشد.', 'LEDGER_CODE_EXHAUSTED');
}

function linkedLedgerAccount(database, sourceKind, sourceKey, name, type, forcedNormalSide = null, metadata = {}) {
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

function operationalLedgerAccount(database, accountId) {
  const account = database.prepare('SELECT id,name,kind,bank_id FROM accounts WHERE id=?').get(accountId);
  if (!account) throw accountingError('حساب مالی تراکنش برای دفتر کل پیدا نشد.', 'LEDGER_ACCOUNT_MISSING');
  return linkedLedgerAccount(database, 'operational-account', account.id, account.name, 'asset', null, { operationalKind: account.kind, bankId: account.bank_id });
}

function categoryLedgerAccount(database, type, category) {
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

function cogsLedgerAccount(database, product) {
  return linkedLedgerAccount(database, 'cogs-product', product.id, `بهای تمام‌شده — ${String(product.name).slice(0, 100)}`, 'expense');
}

export function outputTaxLedgerAccount(database) {
  return linkedLedgerAccount(database, 'system', 'output-tax', 'مالیات و عوارض فروش پرداختنی', 'liability');
}

export function inputTaxLedgerAccount(database) {
  return linkedLedgerAccount(database, 'system', 'input-tax', 'اعتبار مالیات و عوارض خرید', 'asset');
}

function validateLines(database, lines) {
  // سقف بالا عمداً بزرگ است: سند حقوق یک آرتیکل به‌ازای هر نفر دارد تا
  // بدهی هر پرسنل جدا دیده و جدا تسویه شود.
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > 1000) throw accountingError('سند باید بین دو تا هزار آرتیکل داشته باشد.');
  let debit = 0;
  let credit = 0;
  const normalized = lines.map((line) => {
    const accountId = String(line.accountId || '').trim();
    if (!database.prepare('SELECT 1 FROM ledger_accounts WHERE id=? AND active=1').get(accountId)) throw accountingError('یکی از حساب‌های دفتر کل معتبر یا فعال نیست.');
    const lineDebit = Math.round(Number(line.debit) || 0);
    const lineCredit = Math.round(Number(line.credit) || 0);
    if (!Number.isSafeInteger(lineDebit) || !Number.isSafeInteger(lineCredit) || (lineDebit > 0) === (lineCredit > 0)) throw accountingError('هر آرتیکل باید فقط بدهکار یا فقط بستانکار و دارای مبلغ مثبت باشد.');
    debit += lineDebit;
    credit += lineCredit;
    const dimensions = resolveLineDimensions(database, line);
    return {
      accountId, debit: lineDebit, credit: lineCredit,
      description: String(line.description || '').slice(0, 300),
      ...dimensions,
    };
  });
  if (debit !== credit || debit <= 0) throw accountingError('جمع بدهکار و بستانکار سند برابر نیست.', 'JOURNAL_UNBALANCED');
  return { lines: normalized, total: debit };
}

function nextRevision(database, sourceType, sourceId) {
  return Number(database.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM journal_entries WHERE source_type=? AND source_id=?').get(sourceType, sourceId).revision) + 1;
}

/**
 * آرتیکل معکوسِ یک آرتیکل.
 *
 * بدهکار و بستانکار جا عوض می‌کنند و **همهٔ ابعاد سطر با آن می‌آیند**. تفصیلی و
 * مرکز هزینه جزو هویت سطرند، نه زینت: سطر اصلی روی «شرکت الف» نشسته و اگر
 * معکوسش روی خودِ معین بنشیند، بدهی آن شرکت در دفتر تفصیلی هرگز بسته نمی‌شود —
 * و در پارسیان همان سطرِ بی‌تفصیلی روی معینِ تفصیلی‌دار کنار گذاشته می‌شود و
 * سند را نامتوازن نشان می‌دهد.
 */
function reversedLine(line) {
  return {
    accountId: line.accountId,
    debit: line.credit,
    credit: line.debit,
    description: line.description,
    analyticId: line.analyticId || null,
    costCenterId: line.costCenterId || null,
  };
}

function insertJournal(database, values) {
  const validated = validateLines(database, values.lines);
  const id = randomUUID();
  // شماره در همان لحظهٔ درج و در همان تراکنش گرفته می‌شود تا دنبالهٔ سال مالی گپ نگیرد.
  const fiscalYear = fiscalYearForDate(values.occurredAt, values.timeZone || 'Asia/Tehran');
  const documentNumber = nextDocumentNumber(database, fiscalYear);
  // سند خودکار سیستم «کنترل‌شده» است؛ فقط ثبت دستی و انبوه وارد گردش تأیید می‌شوند.
  const approvalState = normalizeApprovalState(values.approvalState || 'approved');
  database.prepare(`INSERT INTO journal_entries
    (id,source_type,source_id,revision,entry_kind,occurred_at,memo,reverses_entry_id,created_by,
     document_number,fiscal_year,approval_state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, values.sourceType, values.sourceId, values.revision, values.entryKind || 'normal', values.occurredAt, String(values.memo || '').slice(0, 500), values.reversesEntryId || null, values.createdBy || null, documentNumber, fiscalYear, approvalState);
  const insert = database.prepare('INSERT INTO journal_lines (id,entry_id,account_id,debit,credit,description,analytic_id,cost_center_id) VALUES (?,?,?,?,?,?,?,?)');
  for (const line of validated.lines) insert.run(randomUUID(), id, line.accountId, line.debit, line.credit, line.description, line.analyticId || null, line.costCenterId || null);
  return { id, total: validated.total, documentNumber, fiscalYear, approvalState };
}

export function periodForDate(occurredAt, timeZone = 'Asia/Tehran') {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) throw accountingError('تاریخ سند معتبر نیست.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA-u-ca-persian', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}

export function assertAccountingPeriodOpen(database, period) {
  ensureAccountingSchema(database);
  const row = database.prepare('SELECT status FROM accounting_periods WHERE period=?').get(period);
  if (row?.status === 'locked') throw accountingError(`دورهٔ ${period} بسته شده و قابل تغییر نیست.`, 'ACCOUNTING_PERIOD_LOCKED', 409);
}

/**
 * سند یک ثبت روزانه.
 *
 * `settlement` وقتی می‌آید که این جابه‌جایی پول، تسویهٔ حساب یک طرف حساب
 * باشد نه هزینه یا درآمد تازه: «۹۳ میلیون به شرکت آراد گستر آسیا پرداخت شد»
 * وقتی به آن شرکت بدهکاریم، بدهی‌اش را کم می‌کند. ثبتش به‌عنوان هزینه دو
 * خطا با هم دارد — سود دوره بی‌دلیل کم می‌شود و بدهی آن شرکت در دفتر باز
 * می‌ماند، انگار پولی نداده‌ایم.
 *
 * تصمیمش اینجا گرفته نمی‌شود؛ لایهٔ دفتر که ماندهٔ واقعی را می‌بیند آن را
 * می‌فرستد. اینجا فقط حساب درست انتخاب می‌شود — و تفصیلی همان شخص هم روی
 * سطر می‌نشیند، وگرنه در پارسیان روی معین می‌نشیند و طرف حساب گم می‌شود.
 */
export function syncTransactionJournal(database, transaction, { createdBy = null, settlement = null } = {}) {
  ensureAccountingSchema(database);
  const amount = Math.round(Number(transaction.amount));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw accountingError('مبلغ سند تراکنش معتبر نیست.');
  const cash = operationalLedgerAccount(database, transaction.accountId || transaction.account || 'cash');
  const counterparty = settlement
    ? counterpartyLedgerAccount(database, settlement.contactId, settlement.contactName, settlement.direction === 'payable' ? 'purchase' : 'sales')
    : null;
  const category = counterparty || categoryLedgerAccount(database, transaction.type, transaction.category);
  const analyticId = settlement ? analyticForContact(database, settlement.contactId, settlement.contactName)?.id || null : null;
  const lines = transaction.type === 'income'
    ? [{ accountId: cash, debit: amount }, { accountId: category, credit: amount, analyticId }]
    : [{ accountId: category, debit: amount, analyticId }, { accountId: cash, credit: amount }];
  return insertJournal(database, {
    sourceType: 'transaction', sourceId: transaction.id,
    revision: nextRevision(database, 'transaction', transaction.id), entryKind: 'normal',
    occurredAt: transaction.occurredAt || transaction.occurred_at,
    memo: transaction.rawText || transaction.raw_text || transaction.category,
    createdBy, lines,
  });
}

/**
 * سند سرمایه و دارایی ثابت.
 *
 * هر دو پول را از صندوق یا بانک رد می‌کنند، ولی هیچ‌کدام سود و زیان دوره را
 * تکان نمی‌دهند: آوردهٔ مالک بستانکارِ حساب سرمایه است و خرید دارایی ثابت
 * بدهکارِ حساب همان دارایی. اگر مثل یک ثبت عادی به دستهٔ درآمد/هزینه می‌رفتند،
 * آورده سود را باد می‌کرد و خرید دارایی، سود همان ماه را می‌خورد.
 *
 * استهلاک اینجا نیست و ادعا هم نمی‌شود؛ دارایی به بهای تمام‌شده می‌نشیند و
 * استهلاک کار فاز جداگانه است.
 */
export function postCapitalJournal(database, entry, { createdBy = null } = {}) {
  ensureAccountingSchema(database);
  const amount = Math.round(Number(entry.amount));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw accountingError('مبلغ سند سرمایه معتبر نیست.');
  const cash = operationalLedgerAccount(database, entry.accountId || 'cash');
  const title = String(entry.title || '').trim().slice(0, 100);
  if (!title) throw accountingError('عنوان سرمایه یا دارایی ثابت لازم است.');
  const lines = entry.kind === 'capital-in'
    ? [
      { accountId: cash, debit: amount },
      { accountId: linkedLedgerAccount(database, 'system', 'owner-capital', 'سرمایه — آوردهٔ مالک', 'equity'), credit: amount },
    ]
    : [
      { accountId: linkedLedgerAccount(database, 'fixed-asset', title, `دارایی ثابت — ${title}`, 'asset'), debit: amount },
      { accountId: cash, credit: amount },
    ];
  return insertJournal(database, {
    sourceType: 'transaction', sourceId: entry.transactionId,
    revision: nextRevision(database, 'transaction', entry.transactionId), entryKind: 'normal',
    occurredAt: entry.occurredAt, memo: title, createdBy, lines,
  });
}

export function reverseTransactionJournal(database, transactionId, occurredAt, { createdBy = null, memo = 'سند معکوس اصلاح' } = {}) {
  ensureAccountingSchema(database);
  const original = database.prepare(`SELECT * FROM journal_entries WHERE source_type='transaction' AND source_id=?
    AND entry_kind='normal' ORDER BY revision DESC LIMIT 1`).get(transactionId);
  if (!original) return null;
  const alreadyReversed = database.prepare('SELECT 1 FROM journal_entries WHERE reverses_entry_id=?').get(original.id);
  if (alreadyReversed) return null;
  const lines = database.prepare('SELECT account_id AS accountId,debit,credit,description,analytic_id AS analyticId,cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=? ORDER BY rowid').all(original.id)
    .map((line) => reversedLine(line));
  return insertJournal(database, {
    sourceType: 'transaction', sourceId: transactionId,
    revision: nextRevision(database, 'transaction', transactionId), entryKind: 'reversal',
    occurredAt, memo, reversesEntryId: original.id, createdBy, lines,
  });
}

export function postInvoiceJournal(database, invoice, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const amount = Math.round(Number(invoice.total));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw accountingError('مبلغ فاکتور معتبر نیست.');
  const occurredAt = invoice.issuedAt || invoice.issued_at || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
  const existing = database.prepare("SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=? AND entry_kind='normal'").get(invoice.id);
  if (existing) return existing;
  const documentType = invoice.documentType || invoice.document_type || 'sales';
  const contactName = invoice.contactName || invoice.customerName || invoice.customer_name;
  const counterparty = counterpartyLedgerAccount(database, invoice.contactId || invoice.contact_id, contactName, documentType);
  // طرف حساب علاوه بر حساب معین، به‌عنوان تفصیلی شناور روی همان آرتیکل می‌نشیند.
  const counterpartyAnalytic = analyticForContact(database, invoice.contactId || invoice.contact_id, contactName || (documentType === 'purchase' ? 'تأمین‌کننده متفرقه' : 'مشتری متفرقه'))?.id || null;
  const category = categoryLedgerAccount(database, documentType === 'purchase' ? 'expense' : 'income', invoice.category || (documentType === 'purchase' ? 'مواد و کالا' : 'فروش'));
  const tax = Math.max(0, Math.round(Number(invoice.tax) || 0));
  const netAmount = amount - tax;
  if (netAmount < 0) throw accountingError('مالیات فاکتور از مبلغ نهایی بیشتر است.', 'INVOICE_TAX_INVALID');
  let lines;
  if (documentType === 'purchase') {
    const inventoryLines = (invoice.items || []).filter((item) => item.productId && Number(item.inventoryCost) > 0).map((item) => {
      const product = database.prepare('SELECT id,name FROM products WHERE id=?').get(item.productId);
      if (!product) throw accountingError('کالای متصل به صورتحساب خرید پیدا نشد.', 'INVOICE_PRODUCT_MISSING');
      return { accountId: inventoryLedgerAccount(database, product), debit: Number(item.inventoryCost), description: item.title };
    });
    const inventoryTotal = inventoryLines.reduce((sum, line) => sum + line.debit, 0);
    const serviceBase = netAmount - inventoryTotal;
    if (serviceBase < 0) throw accountingError('ارزش موجودی ردیف‌های خرید از مبلغ خالص فاکتور بیشتر است.', 'INVOICE_INVENTORY_VALUE_INVALID');
    lines = [...inventoryLines, ...(serviceBase > 0 ? [{ accountId: category, debit: serviceBase }] : []),
      ...(tax > 0 ? [{ accountId: inputTaxLedgerAccount(database), debit: tax }] : []), { accountId: counterparty, credit: amount, analyticId: counterpartyAnalytic }];
  } else {
    lines = [{ accountId: counterparty, debit: amount, analyticId: counterpartyAnalytic }, ...(netAmount > 0 ? [{ accountId: category, credit: netAmount }] : []),
      ...(tax > 0 ? [{ accountId: outputTaxLedgerAccount(database), credit: tax }] : [])];
  }
  return insertJournal(database, {
    sourceType: 'invoice', sourceId: invoice.id, revision: nextRevision(database, 'invoice', invoice.id),
    occurredAt, memo: `${documentType === 'purchase' ? 'صورتحساب خرید' : 'فاکتور فروش'} ${invoice.number}`,
    createdBy, lines,
  });
}

export function postInventoryMovementJournal(database, movement, product, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const value = Math.abs(Math.round(Number(movement.valueDelta ?? movement.value_delta) || 0));
  if (!value || movement.movementType === 'purchase' || movement.movement_type === 'purchase') return null;
  const occurredAt = movement.occurredAt || movement.occurred_at || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
  const existing = database.prepare("SELECT id FROM journal_entries WHERE source_type='inventory_movement' AND source_id=?").get(movement.id);
  if (existing) return existing;
  const type = movement.movementType || movement.movement_type;
  const inventory = inventoryLedgerAccount(database, product);
  let lines;
  if (type === 'opening') lines = [{ accountId: inventory, debit: value }, { accountId: 'ledger-opening-equity', credit: value }];
  else if (type === 'sale') lines = [{ accountId: cogsLedgerAccount(database, product), debit: value }, { accountId: inventory, credit: value }];
  else if (Number(movement.quantity) > 0) {
    const gain = linkedLedgerAccount(database, 'system', 'inventory-gain', 'اضافی موجودی و تعدیلات', 'income');
    lines = [{ accountId: inventory, debit: value }, { accountId: gain, credit: value }];
  } else {
    const shrinkage = linkedLedgerAccount(database, 'system', 'inventory-shrinkage', 'کسری و ضایعات موجودی', 'expense');
    lines = [{ accountId: shrinkage, debit: value }, { accountId: inventory, credit: value }];
  }
  return insertJournal(database, {
    sourceType: 'inventory_movement', sourceId: movement.id, revision: 1, occurredAt,
    memo: movement.note || `${type === 'sale' ? 'بهای تمام‌شده' : 'اصلاح موجودی'} ${product.name}`,
    createdBy, lines,
  });
}

export function reverseInventoryMovementJournal(database, movementId, occurredAt, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  const original = database.prepare("SELECT * FROM journal_entries WHERE source_type='inventory_movement' AND source_id=? AND entry_kind='normal' ORDER BY revision DESC LIMIT 1").get(movementId);
  if (!original || database.prepare('SELECT 1 FROM journal_entries WHERE reverses_entry_id=?').get(original.id)) return null;
  const reversalAt = occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(reversalAt, timeZone));
  const lines = database.prepare('SELECT account_id AS accountId,debit,credit,description,analytic_id AS analyticId,cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=? ORDER BY rowid').all(original.id)
    .map((line) => reversedLine(line));
  return insertJournal(database, {
    sourceType: 'inventory_movement', sourceId: movementId, revision: nextRevision(database, 'inventory_movement', movementId), entryKind: 'reversal',
    occurredAt: reversalAt, memo: 'معکوس گردش انبار', reversesEntryId: original.id, createdBy, lines,
  });
}

export function postInvoicePaymentJournal(database, invoice, payment, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const amount = Math.round(Number(payment.amount));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw accountingError('مبلغ تسویه معتبر نیست.');
  const occurredAt = payment.occurredAt || payment.occurred_at || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
  const existing = database.prepare("SELECT id FROM journal_entries WHERE source_type='invoice_payment' AND source_id=?").get(payment.id);
  if (existing) return existing;
  const documentType = invoice.documentType || invoice.document_type || 'sales';
  const contactName = invoice.contactName || invoice.customerName || invoice.customer_name;
  const counterparty = counterpartyLedgerAccount(database, invoice.contactId || invoice.contact_id, contactName, documentType);
  const counterpartyAnalytic = analyticForContact(database, invoice.contactId || invoice.contact_id, contactName || (documentType === 'purchase' ? 'تأمین‌کننده متفرقه' : 'مشتری متفرقه'))?.id || null;
  const cash = operationalLedgerAccount(database, payment.accountId || payment.account_id || 'cash');
  const lines = documentType === 'purchase'
    ? [{ accountId: counterparty, debit: amount, analyticId: counterpartyAnalytic }, { accountId: cash, credit: amount }]
    : [{ accountId: cash, debit: amount }, { accountId: counterparty, credit: amount, analyticId: counterpartyAnalytic }];
  return insertJournal(database, {
    sourceType: 'invoice_payment', sourceId: payment.id, revision: 1, occurredAt,
    memo: `${documentType === 'purchase' ? 'پرداخت' : 'وصول'} ${invoice.number}`,
    createdBy, lines,
  });
}

export function reverseInvoiceJournal(database, invoice, occurredAt, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const original = database.prepare("SELECT * FROM journal_entries WHERE source_type='invoice' AND source_id=? AND entry_kind='normal' ORDER BY revision DESC LIMIT 1").get(invoice.id);
  if (!original) return null;
  if (database.prepare('SELECT 1 FROM journal_entries WHERE reverses_entry_id=?').get(original.id)) return null;
  const reversalAt = occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(reversalAt, timeZone));
  const lines = database.prepare('SELECT account_id AS accountId,debit,credit,description,analytic_id AS analyticId,cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=? ORDER BY rowid').all(original.id)
    .map((line) => reversedLine(line));
  return insertJournal(database, {
    sourceType: 'invoice', sourceId: invoice.id, revision: nextRevision(database, 'invoice', invoice.id), entryKind: 'reversal',
    occurredAt: reversalAt, memo: `ابطال ${invoice.number}`, reversesEntryId: original.id, createdBy, lines,
  });
}

export function syncOpeningBalanceJournal(database, operationalAccountId, { createdBy = null } = {}) {
  ensureAccountingSchema(database);
  const account = database.prepare('SELECT id,name,opening_balance AS openingBalance,created_at AS createdAt FROM accounts WHERE id=?').get(operationalAccountId);
  if (!account) return null;
  const sourceId = account.id;
  const prior = database.prepare(`SELECT * FROM journal_entries WHERE source_type='opening_balance' AND source_id=? AND entry_kind='opening' ORDER BY revision DESC LIMIT 1`).get(sourceId);
  if (prior && !database.prepare('SELECT 1 FROM journal_entries WHERE reverses_entry_id=?').get(prior.id)) {
    const lines = database.prepare(`SELECT account_id AS accountId,debit,credit,description,
      analytic_id AS analyticId,cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=? ORDER BY rowid`)
      .all(prior.id).map((line) => reversedLine(line));
    insertJournal(database, { sourceType: 'opening_balance', sourceId, revision: nextRevision(database, 'opening_balance', sourceId), entryKind: 'reversal', occurredAt: prior.occurred_at, memo: `معکوس مانده افتتاحیه ${account.name}`, reversesEntryId: prior.id, createdBy, lines });
  }
  const amount = Math.abs(Math.round(Number(account.openingBalance) || 0));
  if (!amount) return null;
  const asset = operationalLedgerAccount(database, account.id);
  const equity = 'ledger-opening-equity';
  const positive = Number(account.openingBalance) > 0;
  return insertJournal(database, {
    sourceType: 'opening_balance', sourceId, revision: nextRevision(database, 'opening_balance', sourceId), entryKind: 'opening',
    occurredAt: account.createdAt || new Date().toISOString(), memo: `مانده افتتاحیه ${account.name}`, createdBy,
    lines: positive ? [{ accountId: asset, debit: amount }, { accountId: equity, credit: amount }] : [{ accountId: equity, debit: amount }, { accountId: asset, credit: amount }],
  });
}

/**
 * ماندهٔ افتتاحیهٔ واردشده از نرم‌افزار مقصد را به یک سند افتتاحیهٔ متوازن
 * تبدیل می‌کند. ورود دوباره، سند قبلی را معکوس می‌کند و سند تازه می‌سازد؛
 * تاریخچه بازنویسی نمی‌شود.
 */
export function postImportedOpeningBalances(database, prepared = [], { occurredAt, memo = 'ماندهٔ افتتاحیهٔ واردشده', createdBy = null, timeZone = 'Asia/Tehran', replace = false } = {}) {
  ensureAccountingSchema(database);
  const postedAt = occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(postedAt, timeZone));

  const prior = database.prepare(`SELECT * FROM journal_entries WHERE source_type='opening_import'
    AND entry_kind='opening' ORDER BY revision DESC,created_at DESC LIMIT 1`).get();
  const priorLive = prior && !database.prepare('SELECT 1 FROM journal_entries WHERE reverses_entry_id=?').get(prior.id);
  if (priorLive && !replace) {
    throw accountingError('برای این دفتر از قبل سند افتتاحیهٔ واردشده وجود دارد؛ برای جایگزینی گزینهٔ جایگزینی را روشن کن.', 'OPENING_IMPORT_EXISTS', 409);
  }
  if (priorLive) {
    const reverseLines = database.prepare(`SELECT account_id AS accountId,debit,credit,description,
      analytic_id AS analyticId,cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=? ORDER BY rowid`)
      .all(prior.id).map((line) => reversedLine(line));
    insertJournal(database, {
      sourceType: 'opening_import', sourceId: prior.source_id,
      revision: nextRevision(database, 'opening_import', prior.source_id), entryKind: 'reversal',
      occurredAt: postedAt, memo: 'معکوس ماندهٔ افتتاحیهٔ قبلی', reversesEntryId: prior.id, createdBy, lines: reverseLines,
    });
  }

  const sourceId = randomUUID();
  const lines = prepared.map((item) => ({
    accountId: item.ledgerAccountId,
    debit: item.debit || 0,
    credit: item.credit || 0,
    description: item.name || '',
    analyticId: item.analyticId || null,
  }));
  const result = insertJournal(database, {
    sourceType: 'opening_import', sourceId, revision: 1, entryKind: 'opening',
    occurredAt: postedAt, memo, createdBy, lines,
  });
  return { ...result, replacedEntryId: priorLive ? prior.id : null, lineCount: lines.length };
}

// برای ماژول ورود داده: ساخت کد داخلی تازه در همان بازه‌های همیشگی.
export function nextLedgerCode(database, type) {
  return nextCode(database, type);
}

export function migrateAccountingLedger(database, { createdBy = null } = {}) {
  ensureAccountingSchema(database);
  // دفترهایی که پیش از این قابلیت ساخته شده‌اند این ستون را ندارند و پرس‌وجوی
  // پایین بدون آن می‌شکند.
  try { database.exec('ALTER TABLE transactions ADD COLUMN journal_deferred INTEGER NOT NULL DEFAULT 0'); }
  catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
  const accounts = database.prepare('SELECT id FROM accounts').all();
  for (const account of accounts) {
    const exists = database.prepare("SELECT 1 FROM journal_entries WHERE source_type='opening_balance' AND source_id=?").get(account.id);
    if (!exists) syncOpeningBalanceJournal(database, account.id, { createdBy });
  }
  // تراکنشی که سندش عمداً منتظر تأیید مانده، «بی‌سند» نیست؛ نباید اینجا سند بخورد.
  const transactions = database.prepare(`SELECT id,amount,type,category,raw_text AS rawText,account_id AS accountId,occurred_at AS occurredAt
    FROM transactions WHERE status NOT IN ('deleted','allocated')
      AND COALESCE(journal_deferred,0)=0 ORDER BY occurred_at,id`).all();
  for (const transaction of transactions) {
    const exists = database.prepare("SELECT 1 FROM journal_entries WHERE source_type='transaction' AND source_id=?").get(transaction.id);
    if (!exists) syncTransactionJournal(database, transaction, { createdBy });
  }
  // اسناد پیش از فاز ۳ شماره ندارند؛ به ترتیب تاریخ وقوع شماره می‌گیرند.
  const numbered = backfillDocumentNumbers(database, (occurredAt) => fiscalYearForDate(occurredAt));
  return { accounts: accounts.length, transactions: transactions.length, numbered: numbered.numbered };
}

// حساب‌هایی که خودشان مالِ یک طرف حساب‌اند: نامشان همان شخص است.
const COUNTERPARTY_SOURCE_KINDS = ['customer-receivable', 'vendor-payable', 'cheque-receivable', 'cheque-payable'];

/**
 * چسباندن تفصیلی به ردیف‌هایی که از قبل بی‌تفصیلی ثبت شده‌اند.
 *
 * تا پیش از این، رویدادی که طرف حسابش در دفتر ثبت نشده بود حساب اختصاصی
 * می‌گرفت ولی تفصیلی نمی‌گرفت. در پارسیان معین دریافتنی و پرداختنی تفصیلی
 * اجباری دارند، پس همان ردیف‌ها کنار گذاشته می‌شدند و سند نامتوازن می‌شد.
 *
 * این اصلاح هیچ مبلغی را دست نمی‌زند: فقط می‌گوید ردیفی که روی «حساب پرداختنی
 * — شرکت آران گستر» نشسته، مال شرکت آران گستر است. چیزی که از نام خودِ حساب
 * پیداست و جای دیگری جعل نمی‌شود.
 *
 * صریح است و خودکار اجرا نمی‌شود: کاربر آن را از صفحهٔ تحویل می‌زند.
 */
export function attachMissingCounterpartyAnalytics(database) {
  ensureChartSchema(database);
  const placeholders = COUNTERPARTY_SOURCE_KINDS.map(() => '?').join(',');
  const rows = database.prepare(`SELECT journal_lines.id,ledger_accounts.source_key AS sourceKey,ledger_accounts.name AS accountName
    FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
    WHERE journal_lines.analytic_id IS NULL AND ledger_accounts.source_kind IN (${placeholders})`)
    .all(...COUNTERPARTY_SOURCE_KINDS);
  if (!rows.length) return { attached: 0, skipped: 0, analytics: 0 };

  const update = database.prepare('UPDATE journal_lines SET analytic_id=? WHERE id=?');
  const cache = new Map();
  let attached = 0;
  let skipped = 0;
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const key = String(row.sourceKey || '').trim();
      if (!key) { skipped += 1; continue; }
      if (!cache.has(key)) cache.set(key, counterpartyAnalyticForKey(database, key));
      const analyticId = cache.get(key);
      if (!analyticId) { skipped += 1; continue; }
      update.run(analyticId, row.id);
      attached += 1;
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return { attached, skipped, analytics: cache.size };
}

/**
 * انتقال پول میان دو حساب خودمان.
 *
 * «دو میلیون از صندوق به بانک ملت واریز شد» نه درآمد است نه هزینه — پول از
 * جیبی به جیب دیگرِ همین کسب‌وکار رفته. اگر از مسیر عادی رد شود، یک بار
 * درآمدِ بانک ثبت می‌شود و یک بار هزینهٔ صندوق، و سود دوره دو بار جعل
 * می‌شود.
 *
 * سند دوطرفه است و هیچ حساب درآمد یا هزینه‌ای را لمس نمی‌کند؛ فقط مانده‌ی
 * دو حساب جابه‌جا می‌شود.
 */
export function postAccountTransferJournal(database, { transferId, fromAccountId, toAccountId, amount, occurredAt, memo }, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const value = Math.round(Number(amount) || 0);
  if (!Number.isSafeInteger(value) || value <= 0) throw accountingError('مبلغ انتقال معتبر نیست.', 'TRANSFER_AMOUNT_INVALID');
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) {
    throw accountingError('مبدأ و مقصد انتقال باید دو حساب متفاوت باشند.', 'TRANSFER_SAME_ACCOUNT');
  }
  const at = occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(at, timeZone));
  return insertJournal(database, {
    sourceType: 'account_transfer', sourceId: transferId, revision: 1,
    occurredAt: at, memo: String(memo || 'انتقال بین حساب‌ها').slice(0, 200), createdBy, timeZone,
    lines: [
      { accountId: operationalLedgerAccount(database, toAccountId), debit: value, description: memo },
      { accountId: operationalLedgerAccount(database, fromAccountId), credit: value, description: memo },
    ],
  });
}

// ---------------------------------------------------------------------------
// تسویهٔ دورهٔ مالیات بر ارزش افزوده
// ---------------------------------------------------------------------------

/**
 * ماندهٔ دو حساب ارزش افزوده.
 *
 * فروش بستانکار است (بدهی به سازمان) و خرید بدهکار (اعتبار). گزارش مالیاتی
 * از فاکتورها ساخته می‌شود ولی تسویه باید از **دفتر** بیاید: همان مانده‌ای
 * که واقعاً در حساب نشسته، نه چیزی که دوباره از فاکتورها حساب شود.
 */
export function vatBalances(database) {
  ensureAccountingSchema(database);
  const balance = (accountId) => (accountId ? Number(database.prepare(
    'SELECT COALESCE(SUM(debit)-SUM(credit),0) AS net FROM journal_lines WHERE account_id=?',
  ).get(accountId).net || 0) : 0);
  // فقط خواندن: ساختن حساب کار ثبت سند است، نه کار گزارش.
  const find = (key) => database.prepare("SELECT id FROM ledger_accounts WHERE source_kind='system' AND source_key=?").get(key)?.id || null;
  const output = find('output-tax');
  const input = find('input-tax');
  return {
    outputAccountId: output, inputAccountId: input,
    // ماندهٔ فروش بستانکار است، پس با علامت مثبت گزارش می‌شود. جمع با صفر،
    // «منفی صفر» را برمی‌دارد — وگرنه در رابط «−۰» نوشته می‌شود.
    outputTax: -balance(output) + 0,
    inputTax: balance(input) + 0,
  };
}

/**
 * تسویهٔ دورهٔ ارزش افزوده.
 *
 * بدون این، دو حساب ارزش افزوده تا ابد بزرگ می‌شوند: بدهی به سازمان و
 * اعتبار خرید هیچ‌وقت خنثی نمی‌شوند و ترازنامه هر دو را باد می‌کند. بدتر،
 * وقتی شرکت واقعاً مالیات را می‌پردازد، آن پرداخت جایی جز «هزینه» نمی‌نشیند
 * — و ارزش افزوده هزینهٔ شرکت نیست، پول سازمان است که شرکت فقط جمعش کرده.
 *
 * اعتبار اضافی منتقل می‌شود، نه مطالبه: اگر اعتبار خرید از بدهی فروش بیشتر
 * باشد فقط به اندازهٔ بدهی خنثی می‌شود و باقی‌اش برای دورهٔ بعد می‌ماند —
 * همان کاری که در عمل انجام می‌شود.
 */
export function postVatSettlementJournal(database, { settlementId, occurredAt, cashAccountId, memo }, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  const { outputTax, inputTax } = vatBalances(database);
  if (outputTax <= 0) throw accountingError('بدهی ارزش افزودهٔ تسویه‌نشده‌ای در دفتر نیست.', 'VAT_NOTHING_TO_SETTLE');
  // اینجا حساب حتماً وجود دارد (ماندهٔ مثبت دارد)، ولی گرفتنش از همان تابعی
  // که سند هم از آن می‌گیرد، یک منبع می‌ماند.
  const outputAccountId = outputTaxLedgerAccount(database);
  const inputAccountId = inputTaxLedgerAccount(database);
  const offset = Math.min(outputTax, inputTax);
  const payable = outputTax - offset;
  const at = occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(at, timeZone));

  const lines = [{ accountId: outputAccountId, debit: outputTax, description: 'بستن مالیات فروش دوره' }];
  if (offset > 0) lines.push({ accountId: inputAccountId, credit: offset, description: 'استفاده از اعتبار مالیات خرید' });
  if (payable > 0) {
    lines.push({ accountId: operationalLedgerAccount(database, cashAccountId || 'cash'), credit: payable, description: 'پرداخت مالیات ارزش افزوده' });
  }
  const posted = insertJournal(database, {
    sourceType: 'vat_settlement', sourceId: settlementId, revision: 1,
    occurredAt: at, memo: String(memo || 'تسویهٔ دورهٔ ارزش افزوده').slice(0, 200), createdBy, timeZone, lines,
  });
  return { ...posted, outputTax, inputTax, offset, paid: payable, carriedForward: inputTax - offset };
}

// ---------------------------------------------------------------------------
// چک
// ---------------------------------------------------------------------------

/**
 * حساب اسناد دریافتنی و پرداختنی — به تفکیک صاحب چک.
 *
 * چک از مطالبات عادی جدا می‌ماند: سررسید دارد، ممکن است برگشت بخورد، و تا
 * وصول نشود پول نیست. ریختنش در همان حساب دریافتنی یعنی نه سررسیدی پیداست و
 * نه می‌شود گفت چقدر از مطالبات، چکِ در جریان است.
 *
 * ولی «جدا از مطالبات» یعنی حساب جدا، نه شخصِ گم‌شده. یک حساب مشترک برای
 * همهٔ چک‌ها، کارت حساب را خراب می‌کرد: مشتری‌ای که طلبش را با چک داده بود
 * در کارتش صفر می‌شد — انگار پول رسیده — درحالی‌که چک هنوز وصول نشده و او
 * همچنان بدهکار است. پس کلید همان کلیدی است که حساب دریافتنی‌اش دارد.
 */
export function chequeLedgerAccounts(database, counterparty = null) {
  ensureAccountingSchema(database);
  const name = String(counterparty?.name || '').trim().slice(0, 100);
  const receivableKey = name ? counterpartyAccountKey(database, 'cheque-receivable', counterparty?.contactId, name) : 'notes';
  const payableKey = name ? counterpartyAccountKey(database, 'cheque-payable', counterparty?.contactId, name) : 'notes';
  const label = (prefix) => (name ? `${prefix} — ${name}` : prefix);
  return {
    noteReceivable: linkedLedgerAccount(database, 'cheque-receivable', receivableKey, label('اسناد دریافتنی (چک)'), 'asset'),
    notePayable: linkedLedgerAccount(database, 'cheque-payable', payableKey, label('اسناد پرداختنی (چک)'), 'liability'),
  };
}

/**
 * سند هر سه مرحلهٔ زندگی یک چک.
 *
 * ثبت: چک دریافتی، اسناد دریافتنی را بدهکار می‌کند. طرف دیگرش بستگی دارد به
 * اینکه چک بابت فروش تازه باشد (درآمد) یا بابت طلب قبلی (حساب دریافتنی).
 * دومی حیاتی است: آن فروش قبلاً درآمد شده و شناسایی دوباره‌اش یعنی همان مبلغ
 * دو بار در سود دوره و دو بار در مالیات.
 *
 * وصول: پول واقعاً می‌آید — نقد بدهکار، اسناد دریافتنی بستانکار. نه درآمدی
 * ساخته می‌شود و نه هزینه‌ای.
 *
 * برگشت: طلب از بین نرفته، فقط ابزارش باطل شده — مبلغ از اسناد دریافتنی به
 * حساب دریافتنیِ همان شخص برمی‌گردد و او دوباره بدهکار می‌شود.
 */
export function postChequeJournal(database, values, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const amount = Math.round(Number(values.amount) || 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw accountingError('مبلغ چک معتبر نیست.', 'CHEQUE_AMOUNT_INVALID');
  const stage = values.stage || 'record';
  const receivable = values.direction === 'receivable';
  const occurredAt = values.occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));

  const party = values.counterparty || {};
  const notes = chequeLedgerAccounts(database, party);
  const noteAccount = receivable ? notes.noteReceivable : notes.notePayable;
  const analyticId = party.analyticId || null;
  const partyAccount = () => counterpartyLedgerAccount(database, party.contactId, party.name, receivable ? 'sales' : 'purchase');

  let lines;
  if (stage === 'record') {
    const other = values.against === 'receivable'
      ? partyAccount()
      : categoryLedgerAccount(database, receivable ? 'income' : 'expense', values.category);
    // تفصیلی فقط روی سطری می‌نشیند که واقعاً مال یک شخص است؛ روی حساب درآمد
    // و هزینه معنایی ندارد.
    const otherAnalytic = values.against === 'receivable' ? analyticId : null;
    lines = receivable
      ? [{ accountId: noteAccount, debit: amount, analyticId }, { accountId: other, credit: amount, analyticId: otherAnalytic }]
      : [{ accountId: other, debit: amount, analyticId: otherAnalytic }, { accountId: noteAccount, credit: amount, analyticId }];
  } else if (stage === 'clear') {
    const cash = operationalLedgerAccount(database, values.cashAccountId || 'cash');
    lines = receivable
      ? [{ accountId: cash, debit: amount }, { accountId: noteAccount, credit: amount, analyticId }]
      : [{ accountId: noteAccount, debit: amount, analyticId }, { accountId: cash, credit: amount }];
  } else {
    const party_ = partyAccount();
    lines = receivable
      ? [{ accountId: party_, debit: amount, analyticId }, { accountId: noteAccount, credit: amount, analyticId }]
      : [{ accountId: noteAccount, debit: amount, analyticId }, { accountId: party_, credit: amount, analyticId }];
  }

  return insertJournal(database, {
    sourceType: `cheque_${stage}`, sourceId: values.chequeId,
    revision: nextRevision(database, `cheque_${stage}`, values.chequeId),
    occurredAt, memo: String(values.memo || 'چک').slice(0, 200), createdBy, timeZone,
    lines: lines.map((line) => ({ ...line, description: values.memo || '' })),
  });
}

// ---------------------------------------------------------------------------
// حقوق و دستمزد
// ---------------------------------------------------------------------------

/**
 * پنج حسابی که سند حقوق لازم دارد.
 *
 * هر سه بدهی جدا می‌مانند چون سه گیرندهٔ متفاوت دارند: خالص به پرسنل، بیمه به
 * تأمین اجتماعی، مالیات به سازمان امور مالیاتی. یک حساب مشترک یعنی تسویهٔ
 * هرکدام ماندهٔ دو تای دیگر را هم تکان می‌دهد و هیچ‌کدام قابل پیگیری نیست.
 */
export function payrollLedgerAccounts(database) {
  ensureAccountingSchema(database);
  return {
    salaryExpense: linkedLedgerAccount(database, 'payroll-salary-expense', 'salary', 'هزینهٔ حقوق و دستمزد', 'expense'),
    insuranceExpense: linkedLedgerAccount(database, 'payroll-insurance-expense', 'employer', 'هزینهٔ بیمهٔ سهم کارفرما', 'expense'),
    salaryPayable: linkedLedgerAccount(database, 'payroll-salary-payable', 'net', 'حقوق و دستمزد پرداختنی', 'liability'),
    insurancePayable: linkedLedgerAccount(database, 'payroll-insurance-payable', 'social-security', 'بیمهٔ پرداختنی (تأمین اجتماعی)', 'liability'),
    taxPayable: linkedLedgerAccount(database, 'payroll-tax-payable', 'income-tax', 'مالیات حقوق پرداختنی', 'liability'),
    otherPayable: linkedLedgerAccount(database, 'payroll-other-payable', 'deductions', 'سایر کسورات حقوق پرداختنی', 'liability'),
  };
}

/**
 * تفصیلی هر پرسنل.
 *
 * کلید از کد ملی می‌آید اگر باشد، وگرنه از نام. کد ملی بین دو نفرِ هم‌نام فرق
 * می‌گذارد — چیزی که در لیست حقوق یک کارخانه واقعاً پیش می‌آید.
 */
export function employeeAnalytic(database, { employeeName, nationalId }) {
  const name = String(employeeName || '').trim().slice(0, 120);
  if (!name) return null;
  return saveAnalyticAccount(database, {
    name, kind: 'employee', sourceKind: 'employee', sourceKey: String(nationalId || name).slice(0, 120),
  })?.id || null;
}

/** سند لیست حقوق یک دوره. */
export function postPayrollJournal(database, run, lines, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensurePayrollSchema(database);
  const accounts = payrollLedgerAccounts(database);
  assertAccountingPeriodOpen(database, periodForDate(run.occurredAt, timeZone));
  const { lines: journalLines } = payrollJournalLines(lines, accounts);
  return insertJournal(database, {
    sourceType: 'payroll', sourceId: run.id, revision: nextRevision(database, 'payroll', run.id),
    occurredAt: run.occurredAt, memo: `لیست حقوق ${run.period}`, createdBy, timeZone, lines: journalLines,
  });
}

/**
 * سند پرداخت یک بدهیِ حقوق.
 *
 * فهرست ورودی می‌گوید کدام بدهی و برای چه کسی: خالص حقوق به تفکیک پرسنل تسویه
 * می‌شود تا ماندهٔ تفصیلیِ هر نفر واقعاً صفر شود، و بیمه و مالیات یک‌جا چون
 * یک گیرنده دارند.
 */
export function postPayrollPaymentJournal(database, { paymentId, occurredAt, memo, cashAccountId, entries = [] }, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const total = entries.reduce((sum, entry) => sum + Math.round(Number(entry.amount) || 0), 0);
  if (!Number.isSafeInteger(total) || total <= 0) throw accountingError('مبلغ پرداخت حقوق معتبر نیست.', 'PAYROLL_PAYMENT_INVALID');
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
  const cash = operationalLedgerAccount(database, cashAccountId || 'cash');
  const lines = [
    ...entries.map((entry) => ({
      accountId: entry.accountId, debit: Math.round(Number(entry.amount) || 0),
      analyticId: entry.analyticId || null, description: entry.description || memo,
    })),
    { accountId: cash, credit: total, description: memo },
  ];
  return insertJournal(database, {
    sourceType: 'payroll_payment', sourceId: paymentId, revision: 1,
    occurredAt, memo, createdBy, timeZone, lines,
  });
}

export function listLedgerAccounts(database) {
  migrateAccountingLedger(database);
  return database.prepare(`SELECT ledger_accounts.id,ledger_accounts.code,ledger_accounts.name,ledger_accounts.type,
    ledger_accounts.normal_side AS normalSide,ledger_accounts.active,
    ledger_accounts.source_kind AS sourceKind,ledger_accounts.source_key AS sourceKey,
    ledger_accounts.chart_account_id AS chartAccountId,chart_accounts.code AS chartCode,chart_accounts.name AS chartName
    FROM ledger_accounts LEFT JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    ORDER BY CAST(ledger_accounts.code AS INTEGER),ledger_accounts.name`).all();
}

export function trialBalance(database, through = '') {
  migrateAccountingLedger(database);
  const cutoff = through ? new Date(through) : null;
  if (cutoff && Number.isNaN(cutoff.getTime())) throw accountingError('تاریخ تراز معتبر نیست.');
  const cutoffClause = cutoff ? 'AND journal_entries.occurred_at<=?' : '';
  const params = cutoff ? [cutoff.toISOString()] : [];
  // پیش‌نویس، برگشتی و سند منتظر کنترل هنوز بخشی از دفاتر قطعی نیستند.
  // تجمیع در زیرپرس‌وجو باعث می‌شود حساب‌های بدون سند تأییدشده هم با مانده صفر باقی بمانند.
  const rows = database.prepare(`SELECT ledger_accounts.id,ledger_accounts.code,ledger_accounts.name,ledger_accounts.type,
    chart_accounts.code AS chartCode,chart_accounts.name AS chartName,
    COALESCE(approved_balances.debit,0) AS debit,COALESCE(approved_balances.credit,0) AS credit
    FROM ledger_accounts LEFT JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    LEFT JOIN (
      SELECT journal_lines.account_id AS accountId,
        SUM(journal_lines.debit) AS debit,SUM(journal_lines.credit) AS credit
      FROM journal_lines INNER JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
      WHERE journal_entries.approval_state='approved' ${cutoffClause}
      GROUP BY journal_lines.account_id
    ) AS approved_balances ON approved_balances.accountId=ledger_accounts.id
    ORDER BY CAST(ledger_accounts.code AS INTEGER),ledger_accounts.name`).all(...params)
    .map((row) => ({ ...row, debitBalance: Math.max(0, Number(row.debit) - Number(row.credit)), creditBalance: Math.max(0, Number(row.credit) - Number(row.debit)) }));
  const totals = rows.reduce((sum, row) => ({ debit: sum.debit + Number(row.debit), credit: sum.credit + Number(row.credit), debitBalance: sum.debitBalance + row.debitBalance, creditBalance: sum.creditBalance + row.creditBalance }), { debit: 0, credit: 0, debitBalance: 0, creditBalance: 0 });
  return { unit: 'IRT', basis: 'double-entry-operational', balanced: totals.debit === totals.credit && totals.debitBalance === totals.creditBalance, rows, totals, generatedAt: new Date().toISOString() };
}

export function listJournal(database, { page = 1, limit = 30, entryId = '', approvalState = '', search = '' } = {}) {
  migrateAccountingLedger(database);
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit)) || 30));
  const safePage = Math.max(1, Math.floor(Number(page)) || 1);
  const single = String(entryId || '').trim();
  const state = Object.hasOwn(APPROVAL_STATES, approvalState) ? approvalState : '';
  const clauses = state ? ['approval_state=?'] : [];
  const filterParams = state ? [state] : [];
  const query = String(search || '').trim().slice(0, 160).replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
  if (query) {
    clauses.push("(instr(memo,?)>0 OR CAST(document_number AS TEXT)=? OR source_id=?)");
    filterParams.push(query, query, query);
  }
  const filter = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const total = single
    ? Number(database.prepare('SELECT COUNT(*) AS count FROM journal_entries WHERE id=?').get(single).count)
    : Number(database.prepare(`SELECT COUNT(*) AS count FROM journal_entries ${filter}`).get(...filterParams).count);
  const select = `SELECT id,source_type AS sourceType,source_id AS sourceId,revision,entry_kind AS entryKind,
    occurred_at AS occurredAt,memo,reverses_entry_id AS reversesEntryId,created_at AS createdAt,created_by AS createdBy,
    document_number AS documentNumber,fiscal_year AS fiscalYear,approval_state AS approvalState,
    submitted_by AS submittedBy,submitted_at AS submittedAt,reviewed_by AS reviewedBy,reviewed_at AS reviewedAt,
    return_reason AS returnReason FROM journal_entries`;
  const entries = single
    ? database.prepare(`${select} WHERE id=?`).all(single)
    : database.prepare(`${select} ${filter} ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...filterParams, safeLimit, (safePage - 1) * safeLimit);
  const lines = database.prepare(`SELECT journal_lines.account_id AS accountId,ledger_accounts.code,ledger_accounts.name,
    journal_lines.debit,journal_lines.credit,journal_lines.description,
    chart_accounts.code AS chartCode,chart_accounts.name AS chartName,
    journal_lines.analytic_id AS analyticId,analytic_accounts.code AS analyticCode,analytic_accounts.name AS analyticName,
    journal_lines.cost_center_id AS costCenterId,cost_centers.code AS costCenterCode,cost_centers.name AS costCenterName
    FROM journal_lines
    JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
    LEFT JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    LEFT JOIN analytic_accounts ON analytic_accounts.id=journal_lines.analytic_id
    LEFT JOIN cost_centers ON cost_centers.id=journal_lines.cost_center_id
    WHERE journal_lines.entry_id=? ORDER BY journal_lines.rowid`);
  return {
    items: entries.map((entry) => ({
      ...entry,
      approvalState: normalizeApprovalState(entry.approvalState),
      approvalLabel: APPROVAL_STATES[normalizeApprovalState(entry.approvalState)].label,
      lines: lines.all(entry.id),
    })),
    total, page: safePage, pages: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

/**
 * کارتابل سند: چه چیزی پیش‌نویس است، چه چیزی منتظر کنترل و چه چیزی برگشت خورده.
 */
export function journalWorklist(database, { userId = '', limit = 50 } = {}) {
  ensureAccountingSchema(database);
  const entries = database.prepare(`SELECT id,document_number AS documentNumber,fiscal_year AS fiscalYear,
    occurred_at AS occurredAt,memo,approval_state AS approvalState,created_by AS createdBy,
    submitted_by AS submittedBy,submitted_at AS submittedAt,return_reason AS returnReason,
    (SELECT COALESCE(SUM(debit),0) FROM journal_lines WHERE entry_id=journal_entries.id) AS total
    FROM journal_entries WHERE approval_state<>'approved'
    ORDER BY CASE approval_state WHEN 'submitted' THEN 0 WHEN 'returned' THEN 1 ELSE 2 END,occurred_at DESC
    LIMIT ?`).all(Math.min(200, Math.max(1, Number(limit) || 50)))
    .map((item) => ({ ...item, approvalLabel: APPROVAL_STATES[normalizeApprovalState(item.approvalState)].label }));
  const all = database.prepare('SELECT approval_state AS approvalState,created_by AS createdBy FROM journal_entries').all();
  return { items: entries, summary: worklistSummary(all, { userId }), states: Object.values(APPROVAL_STATES) };
}

/**
 * وضعیت تأیید یک سند را جابه‌جا می‌کند و رد پای کامل نگه می‌دارد.
 * دورهٔ قفل‌شده هیچ تغییری نمی‌پذیرد، حتی تغییر وضعیت.
 */
export function setJournalApproval(database, entryId, nextState, { userId = null, reason = '', timeZone = 'Asia/Tehran', allowSelfApproval = false } = {}) {
  ensureAccountingSchema(database);
  const entry = database.prepare(`SELECT id,occurred_at AS occurredAt,approval_state AS approvalState,
    created_by AS createdBy,submitted_by AS submittedBy FROM journal_entries WHERE id=?`).get(String(entryId || ''));
  if (!entry) throw accountingError('سند پیدا نشد.', 'JOURNAL_ENTRY_NOT_FOUND', 404);
  assertAccountingPeriodOpen(database, periodForDate(entry.occurredAt, timeZone));

  const sameUser = Boolean(userId) && userId === (entry.submittedBy || entry.createdBy);
  const move = assertApprovalTransition(entry.approvalState, nextState, { reason, sameUser, allowSelfApproval });
  const cleanReason = String(reason || '').trim().slice(0, 500);

  if (move.to === 'submitted') {
    database.prepare("UPDATE journal_entries SET approval_state='submitted',submitted_by=?,submitted_at=CURRENT_TIMESTAMP,return_reason='' WHERE id=?").run(userId, entry.id);
  } else if (move.to === 'approved') {
    database.prepare("UPDATE journal_entries SET approval_state='approved',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,return_reason='' WHERE id=?").run(userId, entry.id);
  } else {
    database.prepare("UPDATE journal_entries SET approval_state='returned',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,return_reason=? WHERE id=?").run(userId, cleanReason, entry.id);
  }
  // خودتأییدی وقتی مجاز شمرده شده باشد باید در رد پا دیده شود، نه اینکه بی‌صدا بگذرد.
  const selfApproved = move.to === 'approved' && sameUser;
  return { ...move, selfApproved, entry: listJournal(database, { entryId: entry.id }).items[0] };
}

/**
 * ثبت انبوه: چند سند در یک تراکنش. یا همه ثبت می‌شوند یا هیچ‌کدام.
 * ثبت نیمه‌کاره برای کمک‌حسابداری که ۳۰۰ ردیف زده، بدترین حالت ممکن است.
 */
export function createJournalBatch(database, documents = [], { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const list = Array.isArray(documents) ? documents : [];
  if (!list.length) throw accountingError('هیچ سندی برای ثبت فرستاده نشد.', 'JOURNAL_BATCH_EMPTY');
  if (list.length > 200) throw accountingError('در هر بار حداکثر ۲۰۰ سند قابل ثبت است.', 'JOURNAL_BATCH_TOO_LARGE');

  const errors = [];
  const prepared = list.map((document, index) => {
    const position = index + 1;
    const occurredAt = document?.occurredAt || new Date().toISOString();
    if (Number.isNaN(new Date(occurredAt).getTime())) { errors.push({ position, message: 'تاریخ سند معتبر نیست.' }); return null; }
    try {
      assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
      // پیش از شروع تراکنش، هر سند جداگانه سنجیده می‌شود تا خطا با شمارهٔ سند برگردد.
      validateLines(database, document?.lines);
    } catch (error) { errors.push({ position, message: error.message, code: error.code }); return null; }
    return { occurredAt, memo: document?.memo || 'سند دستی', lines: document.lines };
  });
  if (errors.length) throw Object.assign(accountingError('ثبت انبوه انجام نشد؛ هیچ سندی ثبت نشده است.', 'JOURNAL_BATCH_INVALID'), { details: { errors } });

  database.exec('BEGIN IMMEDIATE');
  try {
    const created = prepared.map((document) => insertJournal(database, {
      sourceType: 'manual-batch', sourceId: randomUUID(), revision: 1, entryKind: 'adjustment',
      occurredAt: document.occurredAt, memo: document.memo, createdBy, timeZone,
      // سند دستی و انبوه همیشه از پیش‌نویس شروع می‌شود؛ وضعیت ارسالی کاربر قابل اعتماد نیست.
      approvalState: 'draft',
      lines: document.lines,
    }));
    database.exec('COMMIT');
    return {
      created: created.length,
      documentNumbers: created.map((item) => item.documentNumber),
      total: created.reduce((sum, item) => sum + item.total, 0),
      entryIds: created.map((item) => item.id),
    };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

export function createAdjustingJournal(database, values, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const occurredAt = values.occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
  const sourceId = randomUUID();
  const result = insertJournal(database, {
    sourceType: 'adjustment', sourceId, revision: 1, entryKind: 'adjustment', occurredAt,
    memo: values.memo || 'سند اصلاحی', createdBy, approvalState: 'draft', lines: values.lines,
  });
  // سند تازه با شناسهٔ خودش خوانده می‌شود، نه با «آخرین سند»؛ سند با تاریخ گذشته هم باید کامل برگردد.
  return listJournal(database, { entryId: result.id }).items[0] || { id: result.id };
}

export function accountingPeriods(database) {
  ensureAccountingSchema(database);
  return database.prepare(`SELECT period,status,locked_by AS lockedBy,locked_at AS lockedAt,reopened_by AS reopenedBy,
    reopened_at AS reopenedAt,reopen_reason AS reopenReason FROM accounting_periods ORDER BY period DESC`).all();
}

export function lockAccountingPeriod(database, period, userId) {
  ensureAccountingSchema(database);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period))) throw accountingError('دوره باید به شکل YYYY-MM باشد.');
  const balance = trialBalance(database);
  if (!balance.balanced) throw accountingError('دفتر کل نامتوازن است و دوره قابل بستن نیست.', 'TRIAL_BALANCE_UNBALANCED', 409);
  database.prepare(`INSERT INTO accounting_periods (period,status,locked_by,locked_at) VALUES (?,'locked',?,CURRENT_TIMESTAMP)
    ON CONFLICT(period) DO UPDATE SET status='locked',locked_by=excluded.locked_by,locked_at=CURRENT_TIMESTAMP`).run(period, userId || null);
  return accountingPeriods(database).find((item) => item.period === period);
}

export function reopenAccountingPeriod(database, period, userId, reason) {
  ensureAccountingSchema(database);
  const cleanReason = String(reason || '').trim().slice(0, 500);
  if (cleanReason.length < 10) throw accountingError('دلیل بازگشایی را با حداقل ۱۰ نویسه ثبت کن.');
  const result = database.prepare(`UPDATE accounting_periods SET status='open',reopened_by=?,reopened_at=CURRENT_TIMESTAMP,reopen_reason=?
    WHERE period=? AND status='locked'`).run(userId || null, cleanReason, period);
  if (!result.changes) throw accountingError('دورهٔ بسته‌شده پیدا نشد.', 'ACCOUNTING_PERIOD_NOT_LOCKED', 404);
  return accountingPeriods(database).find((item) => item.period === period);
}

/**
 * سند استهلاک یک ماه برای یک دارایی ثابت.
 *
 * بدهکار: هزینهٔ استهلاک (یک حساب مشترک، چون گزارش سود و زیان استهلاک را یکجا
 * می‌خواهد). بستانکار: استهلاک انباشتهٔ همان دارایی — حسابی جدا از خودِ دارایی،
 * چون بهای تمام‌شده باید دست‌نخورده بماند و انباشته کنارش دیده شود.
 *
 * `sourceId` ترکیب دارایی و ماه است تا دو بار ثبت یک ماه، در همان لایهٔ سند
 * قابل تشخیص باشد و نه فقط با کنترل بالادستی.
 */
export function postDepreciationJournal(database, entry, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const amount = Math.round(Number(entry.amount));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw accountingError('مبلغ استهلاک معتبر نیست.');
  const title = String(entry.title || '').trim().slice(0, 100);
  if (!title) throw accountingError('نام دارایی برای سند استهلاک لازم است.');
  const month = String(entry.month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) throw accountingError('ماه استهلاک معتبر نیست.');

  const sourceId = `${entry.assetKey || title}:${month}`;
  const existing = database.prepare("SELECT id FROM journal_entries WHERE source_type='depreciation' AND source_id=? AND entry_kind='normal'").get(sourceId);
  if (existing) throw accountingError(`استهلاک «${title}» برای ${month} قبلاً ثبت شده است.`, 'DEPRECIATION_DUPLICATE', 409);

  const lines = [
    { accountId: linkedLedgerAccount(database, 'system', 'depreciation-expense', 'هزینهٔ استهلاک', 'expense'), debit: amount },
    {
      accountId: linkedLedgerAccount(database, 'accumulated-depreciation', entry.assetKey || title, `استهلاک انباشته — ${title}`, 'asset', 'credit'),
      credit: amount,
    },
  ];
  return insertJournal(database, {
    sourceType: 'depreciation', sourceId,
    revision: nextRevision(database, 'depreciation', sourceId), entryKind: 'normal',
    occurredAt: entry.occurredAt, memo: `استهلاک ${title} — ${month}`, createdBy, timeZone, lines,
  });
}

/** ماه‌هایی که برای یک دارایی سند استهلاک خورده‌اند. */
export function postedDepreciationMonths(database, assetKey) {
  ensureAccountingSchema(database);
  return database.prepare("SELECT source_id AS sourceId FROM journal_entries WHERE source_type='depreciation' AND entry_kind='normal' AND source_id LIKE ?")
    .all(`${assetKey}:%`)
    .map((row) => String(row.sourceId).slice(String(assetKey).length + 1));
}

/**
 * ورودی عمومی لایهٔ ثبت.
 *
 * `accounting.js` از این پس دو نقش دارد و باید به یکی برسد: مجموعهٔ توابع
 * `postXJournal` که هم **تصمیم** می‌گیرند سند چه باشد و هم آن را **ثبت**
 * می‌کنند. تصمیم باید به `shared/accountingRules.js` برود و اینجا فقط اجرا
 * بماند.
 *
 * این تابع همان ورودیِ «فقط اجرا» است: یک سند از پیش تصمیم‌گرفته‌شده را ثبت
 * می‌کند و هیچ نظری دربارهٔ محتوایش ندارد. توابع قدیمی دست‌نخورده می‌مانند تا
 * مهاجرت تدریجی و بی‌ریسک باشد.
 *
 * `sourceType` و `sourceId` یکتایی را تضمین می‌کنند: ثبت دوبارهٔ یک رویداد
 * همین‌جا رد می‌شود، نه در لایهٔ بالاتر که ممکن است دور زده شود.
 */
export function postJournalEntry(database, values, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const sourceType = String(values.sourceType || '').trim();
  const sourceId = String(values.sourceId || '').trim();
  if (!sourceType || !sourceId) throw accountingError('منبع سند برای ثبت لازم است.', 'JOURNAL_SOURCE_MISSING');
  const occurredAt = values.occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));

  const existing = database.prepare(
    "SELECT id,document_number AS documentNumber FROM journal_entries WHERE source_type=? AND source_id=? AND entry_kind='normal'",
  ).get(sourceType, sourceId);
  if (existing) throw accountingError('برای این رویداد از قبل سند ثبت شده است.', 'JOURNAL_DUPLICATE', 409);

  return insertJournal(database, {
    sourceType,
    sourceId,
    revision: nextRevision(database, sourceType, sourceId),
    entryKind: values.entryKind || 'normal',
    occurredAt,
    memo: values.memo || '',
    createdBy,
    timeZone,
    approvalState: values.approvalState || 'approved',
    lines: values.lines,
  });
}

/**
 * سند معکوس برای یک رویداد.
 *
 * سند ثبت‌شده هرگز حذف نمی‌شود. حسابرسی باید بتواند بگوید چه چیزی ثبت شد، چه
 * کسی اصلاحش کرد و چرا؛ حذف، همین زنجیره را پاک می‌کند و هیچ راهی برای
 * بازسازی‌اش نمی‌ماند.
 */
export function reverseJournalEntry(database, { sourceType, sourceId, occurredAt, memo = 'سند معکوس', createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const prior = database.prepare(
    "SELECT id,occurred_at AS occurredAt FROM journal_entries WHERE source_type=? AND source_id=? AND entry_kind='normal' ORDER BY revision DESC LIMIT 1",
  ).get(String(sourceType || ''), String(sourceId || ''));
  if (!prior) return null;
  const already = database.prepare("SELECT 1 FROM journal_entries WHERE reverses_entry_id=?").get(prior.id);
  if (already) throw accountingError('این سند قبلاً معکوس شده است.', 'JOURNAL_ALREADY_REVERSED', 409);

  const lines = database.prepare(`SELECT account_id AS accountId,debit,credit,description,
    analytic_id AS analyticId,cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=? ORDER BY rowid`)
    .all(prior.id).map((line) => reversedLine(line));
  const at = occurredAt || prior.occurredAt;
  assertAccountingPeriodOpen(database, periodForDate(at, timeZone));
  return insertJournal(database, {
    sourceType, sourceId, revision: nextRevision(database, sourceType, sourceId), entryKind: 'reversal',
    occurredAt: at, memo, reversesEntryId: prior.id, createdBy, timeZone, lines,
  });
}
