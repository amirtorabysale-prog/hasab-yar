import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { passwordPolicy } from './security.js';
import {
  assertAccountingPeriodOpen, ensureAccountingSchema, migrateAccountingLedger, periodForDate,
  postInvoiceJournal, postInvoicePaymentJournal, reverseInvoiceJournal, reverseTransactionJournal,
  nextLedgerCode, postImportedOpeningBalances,
  syncOpeningBalanceJournal, syncTransactionJournal,
} from './accounting.js';
import {
  closeReconciliation as closeReconciliationCore, ensureReconciliationSchema, getReconciliationImport as getReconciliationImportCore, getStatementLine,
  ignoreStatementLine as ignoreStatementLineCore, importBankStatement as importBankStatementCore,
  listReconciliationImports as listReconciliationImportsCore, matchStatementLine as matchStatementLineCore,
} from './reconciliation.js';
import {
  applyInvoiceInventory, ensureInventorySchema, inventoryOverview as inventoryOverviewCore, migrateInventory,
  recordInventoryMovement, reverseInvoiceInventory,
} from './inventory.js';
import {
  calculateInvoiceTax, ensureTaxSchema, listTaxRates as listTaxRatesCore, saveTaxRate as saveTaxRateCore,
  taxReport as taxReportCore,
} from './tax.js';
import { normalizePersian } from '../shared/parser.js';
import {
  FINANCIAL_DISCLAIMER, FINANCIAL_UNIT, buildRunway, detectExpenseGrowth, exactWindow, financialScope,
  findUnusualTransaction, invoiceSource, isGuardedAdviceQuestion, obligationSource, prioritizeAlerts, transactionSource,
} from './financialIntelligence.js';
import {
  PLAN_CATALOG, billingMonth, estimateProviderCostMicrousd, fourWeekWindows, monthlyPackageChecklist,
  normalizePlanId, pilotRetentionSummary, quotaError, usageQuotaSnapshot,
} from './collaboration.js';
import {
  ACCOUNTING_TRANSFER_TARGETS, TRANSFER_FILE_FORMATS, accountingTransferReadiness, buildAccountingTransferFile,
  normalizeAccountingTransferTarget, normalizeTransferFileFormat,
} from './accountingTransfer.js';
import {
  DEFAULT_TRANSFER_COLUMNS, TRANSFER_FIELDS, amountUnitLabel, normalizeAmountUnit, normalizeTransferColumns,
} from './transferTemplates.js';
import { buildWorkbook, readTabularFile } from './spreadsheet.js';
import {
  importAnalyticRows, ledgerAccountForChart, prepareOpeningBalanceRows, tableFromSheet,
} from './ledgerImport.js';
import { buildFirmPortfolio, parseStoredMoment } from './firm.js';
import {
  DEFAULT_CHART_TEMPLATE, applySuggestedChartMappings, chartMappingOverview, dimensionBalance,
  importChartOfAccounts, installDefaultChartTemplate, listAnalyticAccounts, listChartAccounts, listCostCenters,
  mapLedgerAccountToChart, parseChartCsv, saveAnalyticAccount, saveChartAccount, saveCostCenter,
} from './chartOfAccounts.js';

const databasePath = resolve(process.env.DATABASE_PATH || './data/hesab-yar.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

const controlDb = new DatabaseSync(databasePath);
const workspaceContext = new AsyncLocalStorage();
const workspaceConnections = new Map();

// Financial functions keep using `db`, but each authenticated request receives an
// isolated SQLite connection. Authentication and membership always use controlDb.
export const db = new Proxy(controlDb, {
  get(target, property) {
    const active = workspaceContext.getStore()?.database || target;
    const value = active[property];
    return typeof value === 'function' ? value.bind(active) : value;
  },
});
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('income','expense')),
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL DEFAULT 'cash' CHECK(kind IN ('cash','bank','wallet','other')),
    opening_balance INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    client_id TEXT UNIQUE,
    amount INTEGER NOT NULL CHECK(amount > 0),
    type TEXT NOT NULL CHECK(type IN ('income','expense')),
    category TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'text' CHECK(source IN ('voice','text','offline')),
    confidence REAL NOT NULL DEFAULT 1,
    needs_review INTEGER NOT NULL DEFAULT 0,
    confidence_details TEXT NOT NULL DEFAULT '{}',
    review_reasons TEXT NOT NULL DEFAULT '[]',
    review_state TEXT NOT NULL DEFAULT 'ready',
    restored_from TEXT,
    account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_transactions_occurred ON transactions(occurred_at);
  CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
  CREATE TABLE IF NOT EXISTS learnings (
    id TEXT PRIMARY KEY,
    keyword TEXT NOT NULL UNIQUE COLLATE NOCASE,
    category TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS auth_attempts (
    fingerprint TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    window_started_at TEXT NOT NULL,
    locked_until TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_auth_attempts_updated ON auth_attempts(updated_at);
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'person' CHECK(kind IN ('person','customer','vendor')),
    phone TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS obligations (
    id TEXT PRIMARY KEY,
    contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    direction TEXT NOT NULL CHECK(direction IN ('receivable','payable')),
    due_at TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','paid','cancelled')),
    note TEXT NOT NULL DEFAULT '',
    paid_transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_obligations_due ON obligations(status,due_at);
  CREATE TABLE IF NOT EXISTS recurring_rules (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    type TEXT NOT NULL CHECK(type IN ('income','expense')),
    category TEXT NOT NULL,
    day_of_month INTEGER NOT NULL CHECK(day_of_month BETWEEN 1 AND 31),
    next_due_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL UNIQUE,
    contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL,
    total INTEGER NOT NULL CHECK(total > 0),
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','paid','cancelled')),
    due_at TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS invoice_items (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    unit_price INTEGER NOT NULL CHECK(unit_price >= 0),
    total INTEGER NOT NULL CHECK(total >= 0)
  );
  CREATE TABLE IF NOT EXISTS daily_closings (
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL UNIQUE,
    expected_cash INTEGER NOT NULL,
    counted_cash INTEGER NOT NULL,
    difference INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS receipts (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    image_data BLOB NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    amount INTEGER,
    type TEXT CHECK(type IN ('income','expense')),
    category TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    stock REAL NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT 'عدد',
    low_threshold REAL NOT NULL DEFAULT 0,
    buy_price INTEGER NOT NULL DEFAULT 0,
    sale_price INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS stock_movements (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity REAL NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS voice_metrics (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    first_transcript_ms INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    transaction_count INTEGER NOT NULL DEFAULT 0,
    needs_review INTEGER NOT NULL DEFAULT 0,
    succeeded INTEGER NOT NULL DEFAULT 1,
    error_code TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    profile_type TEXT NOT NULL DEFAULT 'business' CHECK(profile_type IN ('personal','business')),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('owner','manager','accountant','viewer')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id,user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id,workspace_id);
`);

function ensureColumn(table, definition) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`); } catch (error) {
    if (!/duplicate column name/i.test(error.message)) throw error;
  }
}

function ensureColumnOn(database, table, definition) {
  try { database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`); } catch (error) {
    if (!/duplicate column name/i.test(error.message)) throw error;
  }
}

function ensureVoiceMetricSchema(database) {
  ensureColumnOn(database, 'voice_metrics', 'first_transcript_ms INTEGER NOT NULL DEFAULT 0');
}

function ensureTransactionReviewSchema(database) {
  ensureColumnOn(database, 'transactions', "confidence_details TEXT NOT NULL DEFAULT '{}'");
  ensureColumnOn(database, 'transactions', "review_reasons TEXT NOT NULL DEFAULT '[]'");
  ensureColumnOn(database, 'transactions', "review_state TEXT NOT NULL DEFAULT 'ready'");
  ensureColumnOn(database, 'transactions', 'restored_from TEXT');
  database.exec('CREATE INDEX IF NOT EXISTS idx_transactions_restored_from ON transactions(restored_from)');
}

function ensureInvoiceSchema(database) {
  ensureColumnOn(database, 'invoices', "document_type TEXT NOT NULL DEFAULT 'sales' CHECK(document_type IN ('sales','purchase'))");
  ensureColumnOn(database, 'invoices', "category TEXT NOT NULL DEFAULT 'فروش'");
  ensureColumnOn(database, 'invoices', 'subtotal INTEGER NOT NULL DEFAULT 0');
  ensureColumnOn(database, 'invoices', 'discount INTEGER NOT NULL DEFAULT 0');
  ensureColumnOn(database, 'invoices', 'tax INTEGER NOT NULL DEFAULT 0');
  ensureColumnOn(database, 'invoices', 'issued_at TEXT');
  ensureColumnOn(database, 'invoices', 'posted_at TEXT');
  database.exec(`
    CREATE TABLE IF NOT EXISTS invoice_payments (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      amount INTEGER NOT NULL CHECK(amount > 0),
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
      occurred_at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id,occurred_at);
  `);
  database.prepare('UPDATE invoices SET subtotal=total WHERE subtotal=0').run();
}

function ensureReceiptAutomationSchema(database) {
  ensureColumnOn(database, 'receipts', "merchant TEXT NOT NULL DEFAULT ''");
  ensureColumnOn(database, 'receipts', 'occurred_at TEXT');
  ensureColumnOn(database, 'receipts', "payment_method TEXT NOT NULL DEFAULT ''");
  ensureColumnOn(database, 'receipts', "reference TEXT NOT NULL DEFAULT ''");
  ensureColumnOn(database, 'receipts', 'account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL');
  ensureColumnOn(database, 'receipts', 'transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL');
  ensureColumnOn(database, 'receipts', 'statement_line_id TEXT');
  ensureColumnOn(database, 'receipts', "status TEXT NOT NULL DEFAULT 'pending'");
  ensureColumnOn(database, 'receipts', "ocr_provider TEXT NOT NULL DEFAULT ''");
  ensureColumnOn(database, 'receipts', "ocr_model TEXT NOT NULL DEFAULT ''");
  ensureColumnOn(database, 'receipts', 'ocr_confidence REAL NOT NULL DEFAULT 0');
  ensureColumnOn(database, 'receipts', "field_confidence TEXT NOT NULL DEFAULT '{}'");
  ensureColumnOn(database, 'receipts', "ocr_text TEXT NOT NULL DEFAULT ''");
  ensureColumnOn(database, 'receipts', "review_reasons TEXT NOT NULL DEFAULT '[]'");
  ensureColumnOn(database, 'receipts', 'updated_at TEXT');
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status,created_at);
    CREATE INDEX IF NOT EXISTS idx_receipts_transaction ON receipts(transaction_id);
    CREATE INDEX IF NOT EXISTS idx_receipts_statement_line ON receipts(statement_line_id);
    CREATE TABLE IF NOT EXISTS automation_rules (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK(source IN ('merchant','bank_description')),
      pattern TEXT NOT NULL COLLATE NOCASE,
      type TEXT CHECK(type IN ('income','expense')),
      category TEXT NOT NULL,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source,pattern)
    );
  `);
}

function ensureFinancialAlertSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS financial_alert_feedback (
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('snooze')),
      snoozed_until TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_financial_alert_feedback_active ON financial_alert_feedback(alert_id,snoozed_until);
  `);
}

function ensureCollaborationSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS collaboration_requests (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('general','transaction','receipt','closing','reconciliation','obligation')),
      entity_id TEXT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','urgent')),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','answered','resolved')),
      requested_by TEXT,
      answered_by TEXT,
      resolved_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      answered_at TEXT,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_collaboration_requests_status ON collaboration_requests(status,priority,created_at);
    CREATE TABLE IF NOT EXISTS pilot_checkins (
      id TEXT PRIMARY KEY,
      week_start TEXT NOT NULL,
      respondent_type TEXT NOT NULL CHECK(respondent_type IN ('owner','accountant')),
      saved_minutes INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      friction TEXT NOT NULL DEFAULT '',
      dropout_reason TEXT NOT NULL DEFAULT '',
      willingness_to_pay TEXT NOT NULL DEFAULT 'unknown' CHECK(willingness_to_pay IN ('yes','maybe','no','unknown')),
      plan_interest TEXT NOT NULL DEFAULT 'none' CHECK(plan_interest IN ('free','professional','accountant','none')),
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(week_start,respondent_type)
    );
    CREATE TABLE IF NOT EXISTS provider_usage (
      id TEXT PRIMARY KEY,
      capability TEXT NOT NULL CHECK(capability IN ('server_voice','realtime_session','realtime_duration','receipt_ocr')),
      provider TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','succeeded','failed')),
      request_count INTEGER NOT NULL DEFAULT 1,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      estimated_cost_microusd INTEGER,
      error_code TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_provider_usage_month ON provider_usage(created_at,capability,status);
  `);
}

function ensureCommercialSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workspace_plans (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL DEFAULT 'free' CHECK(plan_id IN ('free','professional','accountant')),
      provider_budget_microusd INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// فقط روی دیتابیس کنترل. خلاصهٔ وضعیت هر پرونده اینجا cache می‌شود تا باز کردن
// میز کار با ده‌ها پرونده به باز کردن ده‌ها فایل SQLite در هر درخواست تبدیل نشود.
function ensureFirmConsoleSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS firm_client_cache (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      payload TEXT NOT NULL,
      computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id,month)
    );
  `);
}

function ensureAccountingTransferSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS accounting_transfer_settings (
      target_system TEXT PRIMARY KEY CHECK(target_system IN ('generic-csv','parsian-review-csv')),
      template_name TEXT NOT NULL DEFAULT '',
      template_verified INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS accounting_transfer_mappings (
      target_system TEXT NOT NULL CHECK(target_system IN ('generic-csv','parsian-review-csv')),
      ledger_account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE CASCADE,
      target_code TEXT NOT NULL,
      target_name TEXT NOT NULL DEFAULT '',
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (target_system,ledger_account_id)
    );
    CREATE TABLE IF NOT EXISTS accounting_transfer_batches (
      id TEXT PRIMARY KEY,
      period TEXT NOT NULL,
      target_system TEXT NOT NULL CHECK(target_system IN ('generic-csv','parsian-review-csv')),
      file_name TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      entry_count INTEGER NOT NULL,
      debit_total INTEGER NOT NULL,
      credit_total INTEGER NOT NULL,
      digest TEXT NOT NULL,
      readiness_snapshot TEXT NOT NULL,
      file_data BLOB NOT NULL,
      status TEXT NOT NULL DEFAULT 'generated' CHECK(status IN ('generated','delivered','accepted','rejected')),
      status_note TEXT NOT NULL DEFAULT '',
      generated_by TEXT,
      reviewed_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(period,target_system,digest)
    );
    CREATE INDEX IF NOT EXISTS idx_accounting_transfer_batches_period
      ON accounting_transfer_batches(period,target_system,created_at);
    CREATE TABLE IF NOT EXISTS accounting_transfer_validations (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES accounting_transfer_batches(id) ON DELETE CASCADE,
      software_name TEXT NOT NULL,
      software_version TEXT NOT NULL,
      test_company_label TEXT NOT NULL,
      attempt_type TEXT NOT NULL CHECK(attempt_type IN ('dry-run','trial-import')),
      outcome TEXT NOT NULL CHECK(outcome IN ('passed','failed')),
      amount_unit TEXT NOT NULL CHECK(amount_unit IN ('toman','rial')),
      imported_rows INTEGER NOT NULL DEFAULT 0,
      rejected_rows INTEGER NOT NULL DEFAULT 0,
      imported_debit_total INTEGER NOT NULL DEFAULT 0,
      imported_credit_total INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      tested_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_accounting_transfer_validations_batch
      ON accounting_transfer_validations(batch_id,created_at);
  `);
  // قالب ستونی و قالب فایل به‌جای افزودن target تازه اضافه شده‌اند؛ CHECK فعلی
  // روی target_system در SQLite قابل تغییر نیست و مهاجرت مخربی لازم می‌شد.
  ensureColumnOn(database, 'accounting_transfer_settings', "file_format TEXT NOT NULL DEFAULT 'csv'");
  ensureColumnOn(database, 'accounting_transfer_settings', "amount_unit TEXT NOT NULL DEFAULT 'toman'");
  ensureColumnOn(database, 'accounting_transfer_settings', "columns_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumnOn(database, 'accounting_transfer_batches', "file_format TEXT NOT NULL DEFAULT 'csv'");
  ensureColumnOn(database, 'accounting_transfer_batches', "amount_unit TEXT NOT NULL DEFAULT 'toman'");
}

ensureColumn('transactions', "contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL");
ensureColumn('transactions', "account TEXT NOT NULL DEFAULT 'cash'");
ensureColumn('transactions', "account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT");
ensureColumn('transactions', "note TEXT NOT NULL DEFAULT ''");
ensureColumn('transactions', "status TEXT NOT NULL DEFAULT 'confirmed'");
ensureColumn('transactions', 'due_at TEXT');
ensureColumn('transactions', 'updated_at TEXT');
ensureColumn('users', "role TEXT NOT NULL DEFAULT 'owner'");
ensureColumn('users', "display_name TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'must_change_password INTEGER NOT NULL DEFAULT 0');
ensureTransactionReviewSchema(controlDb);
ensureVoiceMetricSchema(controlDb);
ensureAccountingSchema(controlDb);
ensureInvoiceSchema(controlDb);
ensureReconciliationSchema(controlDb);
ensureReceiptAutomationSchema(controlDb);
ensureFinancialAlertSchema(controlDb);
ensureCollaborationSchema(controlDb);
ensureCommercialSchema(controlDb);
ensureFirmConsoleSchema(controlDb);
ensureAccountingTransferSchema(controlDb);
ensureInventorySchema(controlDb);
ensureTaxSchema(controlDb);

const categorySeed = [
  ['inc-sale', 'فروش', 'income', 1], ['inc-service', 'خدمات', 'income', 2], ['inc-project', 'پروژه و دستمزد', 'income', 3], ['inc-other', 'سایر درآمدها', 'income', 9],
  ['exp-material', 'مواد و کالا', 'expense', 1], ['exp-salary', 'حقوق و دستمزد', 'expense', 2], ['exp-rent', 'اجاره', 'expense', 3], ['exp-delivery', 'حمل‌ونقل', 'expense', 4], ['exp-food', 'خوراک', 'expense', 5], ['exp-bill', 'قبوض', 'expense', 6], ['exp-other', 'سایر هزینه‌ها', 'expense', 9],
];
const insertCategory = db.prepare('INSERT OR IGNORE INTO categories (id,name,type,sort_order) VALUES (?,?,?,?)');
for (const item of categorySeed) insertCategory.run(...item);

db.prepare(`INSERT OR IGNORE INTO accounts (id,name,kind,opening_balance,sort_order)
  VALUES ('cash','صندوق نقدی','cash',0,1)`).run();
db.prepare("UPDATE transactions SET account_id='cash' WHERE account_id IS NULL OR account_id='' ").run();

const defaults = {
  businessName: '', currency: 'تومان', timezone: 'Asia/Tehran', profileType: 'business',
  onboardingDone: 'false', openingBalance: '0', ownerName: '', lowBalanceThreshold: '2000000', alertSensitivity: 'balanced',
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, String(value));

const openingMigrated = db.prepare("SELECT value FROM settings WHERE key='accountOpeningMigrated'").get();
if (!openingMigrated) {
  const legacyOpening = Number(db.prepare("SELECT value FROM settings WHERE key='openingBalance'").get()?.value || 0);
  db.prepare("UPDATE accounts SET opening_balance=? WHERE id='cash'").run(Math.round(legacyOpening));
  insertSetting.run('accountOpeningMigrated', 'true');
}
migrateInventory(controlDb, { timeZone: defaults.timezone });

function workspaceDatabase(workspaceId) {
  if (workspaceId === 'primary') return controlDb;
  if (workspaceConnections.has(workspaceId)) return workspaceConnections.get(workspaceId);
  const folder = resolve(dirname(databasePath), 'workspaces');
  mkdirSync(folder, { recursive: true });
  const database = new DatabaseSync(resolve(folder, `${workspaceId}.sqlite`));
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const empty = database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().count === 0;
  if (empty) {
    const schema = controlDb.prepare(`SELECT type,sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table','index')
      ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,rowid`).all();
    database.exec('PRAGMA foreign_keys = OFF');
    for (const item of schema) database.exec(item.sql);
    database.exec('PRAGMA foreign_keys = ON');
    const categoryInsert = database.prepare('INSERT OR IGNORE INTO categories (id,name,type,sort_order) VALUES (?,?,?,?)');
    for (const item of categorySeed) categoryInsert.run(...item);
    database.prepare(`INSERT OR IGNORE INTO accounts (id,name,kind,opening_balance,sort_order)
      VALUES ('cash','صندوق نقدی','cash',0,1)`).run();
    const settingInsert = database.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
    for (const [key, value] of Object.entries(defaults)) settingInsert.run(key, String(value));
    settingInsert.run('accountOpeningMigrated', 'true');
  }
  ensureAccountingSchema(database);
  ensureTransactionReviewSchema(database);
  ensureVoiceMetricSchema(database);
  ensureInvoiceSchema(database);
  ensureReconciliationSchema(database);
  ensureReceiptAutomationSchema(database);
  ensureFinancialAlertSchema(database);
  ensureCollaborationSchema(database);
  ensureAccountingTransferSchema(database);
  ensureInventorySchema(database);
  ensureTaxSchema(database);
  migrateAccountingLedger(database);
  migrateInventory(database, { timeZone: defaults.timezone });
  workspaceConnections.set(workspaceId, database);
  return database;
}

export function runInWorkspace(workspaceId, member, callback) {
  return workspaceContext.run({ workspaceId, member, database: workspaceDatabase(workspaceId) }, callback);
}

export function currentWorkspace() {
  const context = workspaceContext.getStore();
  return context ? { id: context.workspaceId, role: context.member?.role, userId: context.member?.userId } : null;
}

export function activeWorkspaceDatabase() {
  return workspaceContext.getStore()?.database || controlDb;
}

export function listUserWorkspaces(userId) {
  return controlDb.prepare(`SELECT workspaces.id,workspaces.name,workspaces.profile_type AS profileType,
    workspace_members.role,workspaces.created_at AS createdAt
    FROM workspace_members JOIN workspaces ON workspaces.id=workspace_members.workspace_id
    WHERE workspace_members.user_id=? ORDER BY CASE workspace_members.role WHEN 'owner' THEN 0 ELSE 1 END,workspaces.created_at`).all(userId);
}

export function workspaceForUser(userId, requestedId = '') {
  const requested = String(requestedId || '').trim();
  const row = requested
    ? controlDb.prepare(`SELECT workspaces.id,workspaces.name,workspaces.profile_type AS profileType,workspace_members.role
        FROM workspace_members JOIN workspaces ON workspaces.id=workspace_members.workspace_id
        WHERE workspace_members.user_id=? AND workspaces.id=?`).get(userId, requested)
    : listUserWorkspaces(userId)[0];
  return row || null;
}

export function createWorkspace(userId, values = {}) {
  const name = String(values.name || '').trim().slice(0, 100);
  if (name.length < 2) throw new Error('نام دفتر باید حداقل دو نویسه باشد.');
  const profileType = values.profileType === 'personal' ? 'personal' : 'business';
  const id = randomUUID();
  controlDb.exec('BEGIN IMMEDIATE');
  try {
    controlDb.prepare('INSERT INTO workspaces (id,name,profile_type,created_by) VALUES (?,?,?,?)').run(id, name, profileType, userId);
    controlDb.prepare("INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?, 'owner')").run(id, userId);
    controlDb.prepare('INSERT INTO workspace_plans (workspace_id,plan_id,updated_by) VALUES (?,?,?)')
      .run(id, normalizePlanId(process.env.DEFAULT_WORKSPACE_PLAN), userId);
    controlDb.exec('COMMIT');
  } catch (error) { controlDb.exec('ROLLBACK'); throw error; }
  const database = workspaceDatabase(id);
  database.prepare("UPDATE settings SET value=? WHERE key='businessName'").run(name);
  database.prepare("UPDATE settings SET value=? WHERE key='profileType'").run(profileType);
  return workspaceForUser(userId, id);
}

export function listWorkspaceMembers(workspaceId) {
  return controlDb.prepare(`SELECT users.id,users.username,users.display_name AS displayName,
    users.must_change_password AS mustChangePassword,workspace_members.role,workspace_members.created_at AS createdAt
    FROM workspace_members JOIN users ON users.id=workspace_members.user_id
    WHERE workspace_members.workspace_id=?
    ORDER BY CASE workspace_members.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'accountant' THEN 2 ELSE 3 END,users.username`).all(workspaceId);
}

function assertWorkspaceRole(role) {
  if (!['owner', 'manager', 'accountant', 'viewer'].includes(role)) throw new Error('نقش انتخاب‌شده معتبر نیست.');
  return role;
}

export function addWorkspaceMember(workspaceId, values = {}) {
  const username = String(values.username || '').trim().toLowerCase().slice(0, 80);
  const displayName = String(values.displayName || '').trim().slice(0, 100);
  const role = assertWorkspaceRole(values.role || 'viewer');
  if (!/^[a-z0-9._-]{3,80}$/i.test(username)) throw new Error('نام کاربری باید حداقل سه نویسه و فقط شامل حروف انگلیسی، عدد، نقطه، خط تیره یا زیرخط باشد.');
  let user = controlDb.prepare('SELECT id,username FROM users WHERE username=?').get(username);
  const existingMembership = user && controlDb.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId, user.id);
  if (!existingMembership) {
    const plan = workspacePlanRecord(workspaceId);
    const memberCount = Number(controlDb.prepare('SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id=?').get(workspaceId).count || 0);
    const memberQuota = usageQuotaSnapshot(plan.planId, { members: memberCount }).find((item) => item.id === 'members');
    if (memberQuota.exhausted) throw quotaError(memberQuota);
  }
  controlDb.exec('BEGIN IMMEDIATE');
  try {
    if (!user) {
      const password = String(values.temporaryPassword || '');
      const policy = passwordPolicy(password, username);
      if (!policy.valid) throw new Error(policy.message);
      const salt = randomBytes(24).toString('hex');
      user = { id: randomUUID(), username };
      controlDb.prepare(`INSERT INTO users (id,username,password_hash,password_salt,display_name,must_change_password,role)
        VALUES (?,?,?,?,?,1,?)`).run(user.id, username, hashPassword(password, salt), salt, displayName, role);
    } else if (displayName) {
      controlDb.prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName, user.id);
    }
    controlDb.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,?)
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,updated_at=CURRENT_TIMESTAMP`).run(workspaceId, user.id, role);
    controlDb.exec('COMMIT');
  } catch (error) { controlDb.exec('ROLLBACK'); throw error; }
  return listWorkspaceMembers(workspaceId).find((item) => item.id === user.id);
}

export function updateWorkspaceMember(workspaceId, userId, role) {
  const nextRole = assertWorkspaceRole(role);
  const current = controlDb.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId, userId);
  if (!current) return null;
  const owners = controlDb.prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id=? AND role='owner'").get(workspaceId).count;
  if (current.role === 'owner' && nextRole !== 'owner' && owners <= 1) throw new Error('دفتر باید حداقل یک مالک داشته باشد.');
  controlDb.prepare('UPDATE workspace_members SET role=?,updated_at=CURRENT_TIMESTAMP WHERE workspace_id=? AND user_id=?').run(nextRole, workspaceId, userId);
  return listWorkspaceMembers(workspaceId).find((item) => item.id === userId);
}

export function removeWorkspaceMember(workspaceId, userId) {
  const current = controlDb.prepare('SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspaceId, userId);
  if (!current) return false;
  const owners = controlDb.prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id=? AND role='owner'").get(workspaceId).count;
  if (current.role === 'owner' && owners <= 1) throw new Error('آخرین مالک دفتر قابل حذف نیست.');
  return controlDb.prepare('DELETE FROM workspace_members WHERE workspace_id=? AND user_id=?').run(workspaceId, userId).changes > 0;
}

export function allWorkspaces() {
  return controlDb.prepare('SELECT id,name,profile_type AS profileType,created_at AS createdAt FROM workspaces ORDER BY created_at').all();
}

function workspacePlanRecord(workspaceId) {
  const id = String(workspaceId || 'primary');
  controlDb.prepare('INSERT OR IGNORE INTO workspace_plans (workspace_id,plan_id) VALUES (?,?)')
    .run(id, normalizePlanId(process.env.DEFAULT_WORKSPACE_PLAN));
  const row = controlDb.prepare(`SELECT workspace_id AS workspaceId,plan_id AS planId,
    provider_budget_microusd AS providerBudgetMicrousd,updated_at AS updatedAt
    FROM workspace_plans WHERE workspace_id=?`).get(id);
  return { ...row, planId: normalizePlanId(row?.planId) };
}

export function updateWorkspaceCommercialPlan(workspaceId, values = {}, updatedBy = '') {
  const planId = normalizePlanId(values.planId);
  const budgetUsd = Number(values.providerBudgetUsd);
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > 1_000_000) throw new Error('سقف بودجهٔ provider معتبر نیست.');
  const providerBudgetMicrousd = Math.round(budgetUsd * 1_000_000);
  controlDb.prepare(`INSERT INTO workspace_plans (workspace_id,plan_id,provider_budget_microusd,updated_by)
    VALUES (?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET plan_id=excluded.plan_id,
    provider_budget_microusd=excluded.provider_budget_microusd,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
    .run(workspaceId, planId, providerBudgetMicrousd, updatedBy || null);
  return workspacePlanRecord(workspaceId);
}

export function commercialStatus(workspaceId = currentWorkspace()?.id || 'primary', now = new Date()) {
  const planRecord = workspacePlanRecord(workspaceId);
  const range = billingMonth('', now);
  const usageRows = db.prepare(`SELECT capability,provider,status,SUM(request_count) AS requests,SUM(duration_ms) AS durationMs,
    SUM(COALESCE(estimated_cost_microusd,0)) AS estimatedCostMicrousd,
    SUM(CASE WHEN status='succeeded' AND capability!='realtime_session' AND estimated_cost_microusd IS NULL THEN 1 ELSE 0 END) AS unpriced
    FROM provider_usage WHERE created_at>=datetime(?) AND created_at<datetime(?) GROUP BY capability,provider,status
    ORDER BY capability,provider,status`).all(range.from, range.toExclusive);
  const smartVoiceRequests = usageRows.filter((item) => item.status !== 'failed' && ['server_voice', 'realtime_session'].includes(item.capability))
    .reduce((sum, item) => sum + Number(item.requests || 0), 0);
  const receiptOcrPages = usageRows.filter((item) => item.status !== 'failed' && item.capability === 'receipt_ocr')
    .reduce((sum, item) => sum + Number(item.requests || 0), 0);
  const members = Number(controlDb.prepare('SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id=?').get(workspaceId)?.count || 0);
  const transactionEntries = Number(db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE status!='deleted' AND created_at>=datetime(?) AND created_at<datetime(?)").get(range.from, range.toExclusive)?.count || 0);
  const estimatedCostMicrousd = usageRows.reduce((sum, item) => sum + Number(item.estimatedCostMicrousd || 0), 0);
  const unpricedEvents = usageRows.reduce((sum, item) => sum + Number(item.unpriced || 0), 0);
  const budgetMicrousd = Number(planRecord.providerBudgetMicrousd || 0);
  const usage = { smartVoiceRequests, receiptOcrPages, members, transactionEntries };
  return {
    month: range.month,
    plan: PLAN_CATALOG[planRecord.planId],
    catalog: Object.values(PLAN_CATALOG),
    usage,
    quotas: usageQuotaSnapshot(planRecord.planId, usage),
    provider: {
      rows: usageRows,
      estimatedCostMicrousd,
      estimatedCostUsd: estimatedCostMicrousd / 1_000_000,
      pricingComplete: unpricedEvents === 0,
      unpricedEvents,
      budgetMicrousd,
      budgetUsd: budgetMicrousd / 1_000_000,
      budgetPercent: budgetMicrousd ? Math.min(100, Math.round((estimatedCostMicrousd / budgetMicrousd) * 100)) : null,
      overBudget: budgetMicrousd > 0 && estimatedCostMicrousd >= budgetMicrousd,
    },
    coreEntryAlwaysAvailable: true,
    coreEntryMessage: 'ثبت دستی و تایپ رایگان Chrome با پایان سهمیهٔ سرویس‌های هوشمند قطع نمی‌شود.',
  };
}

function quotaItemForCapability(status, capability) {
  const id = capability === 'receipt_ocr' ? 'receiptOcrPages' : 'smartVoiceRequests';
  return status.quotas.find((item) => item.id === id);
}

export function beginProviderUsage(capability, provider = 'unknown') {
  if (!['server_voice', 'realtime_session', 'receipt_ocr'].includes(capability)) throw new Error('قابلیت provider معتبر نیست.');
  const status = commercialStatus();
  const quota = quotaItemForCapability(status, capability);
  if (quota?.exhausted) throw quotaError(quota);
  if (status.provider.overBudget) throw Object.assign(new Error('سقف بودجهٔ ماهانهٔ سرویس‌های هوشمند رسیده است؛ تایپ Chrome و ثبت دستی همچنان فعال است.'), {
    status: 402, code: 'PROVIDER_BUDGET_EXCEEDED', details: { provider: status.provider },
  });
  const id = randomUUID();
  db.prepare(`INSERT INTO provider_usage (id,capability,provider,status,request_count,created_by)
    VALUES (?,?,?,'started',1,?)`).run(id, capability, String(provider || 'unknown').slice(0, 40), currentWorkspace()?.userId || null);
  return id;
}

export function finishProviderUsage(id, values = {}) {
  const current = db.prepare('SELECT id,capability,provider FROM provider_usage WHERE id=?').get(id);
  if (!current) return null;
  const provider = String(values.provider || current.provider || 'unknown').slice(0, 40);
  const status = values.succeeded === false ? 'failed' : 'succeeded';
  const durationMs = Math.max(0, Math.round(Number(values.durationMs) || 0));
  const estimatedCostMicrousd = status === 'failed' ? 0 : estimateProviderCostMicrousd({ capability: current.capability, provider, durationMs, requestCount: 1 });
  db.prepare(`UPDATE provider_usage SET provider=?,status=?,duration_ms=?,estimated_cost_microusd=?,error_code=?,completed_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(provider, status, durationMs, estimatedCostMicrousd, String(values.errorCode || '').slice(0, 80), id);
  return db.prepare('SELECT * FROM provider_usage WHERE id=?').get(id);
}

export function recordRealtimeProviderDuration(durationMs) {
  const normalized = Math.max(0, Math.round(Number(durationMs) || 0));
  if (!normalized) return null;
  const id = randomUUID();
  const estimatedCostMicrousd = estimateProviderCostMicrousd({ capability: 'realtime_duration', provider: 'openai', durationMs: normalized, requestCount: 0 });
  db.prepare(`INSERT INTO provider_usage (id,capability,provider,status,request_count,duration_ms,estimated_cost_microusd,created_by,completed_at)
    VALUES (?, 'realtime_duration','openai','succeeded',0,?,?,?,CURRENT_TIMESTAMP)`)
    .run(id, normalized, estimatedCostMicrousd, currentWorkspace()?.userId || null);
  return id;
}

export function closeWorkspaceDatabases() {
  for (const database of workspaceConnections.values()) database.close();
  workspaceConnections.clear();
}

export function revokeWorkspaceSessions(workspaceId, exceptUserId = '') {
  const members = controlDb.prepare('SELECT user_id AS userId FROM workspace_members WHERE workspace_id=?').all(workspaceId);
  const remove = controlDb.prepare('DELETE FROM sessions WHERE user_id=?');
  for (const member of members) if (member.userId !== exceptUserId) remove.run(member.userId);
}

export function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((row) => [row.key, row.value]));
}

export function saveSettings(values) {
  const allowed = ['businessName', 'currency', 'timezone', 'profileType', 'onboardingDone', 'openingBalance', 'ownerName', 'lowBalanceThreshold', 'alertSensitivity'];
  const statement = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const key of allowed) if (values[key] != null) {
      const value = key === 'alertSensitivity' && !['low', 'balanced', 'high'].includes(values[key]) ? 'balanced' : values[key];
      statement.run(key, String(value).slice(0, 120));
    }
    if (values.openingBalance != null) {
      const opening = Math.round(Number(values.openingBalance));
      if (!Number.isSafeInteger(opening)) throw new Error('ماندهٔ ابتدای دوره معتبر نیست.');
      db.prepare("UPDATE accounts SET opening_balance=?,updated_at=CURRENT_TIMESTAMP WHERE id='cash'").run(opening);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getSettings();
}

export function listAccounts() {
  return db.prepare(`SELECT accounts.id,accounts.name,accounts.kind,accounts.opening_balance AS openingBalance,accounts.active,
    accounts.created_at AS createdAt,
    accounts.opening_balance + COALESCE(SUM(CASE WHEN transactions.status!='deleted' THEN
      CASE WHEN transactions.type='income' THEN transactions.amount ELSE -transactions.amount END ELSE 0 END),0) AS balance
    FROM accounts LEFT JOIN transactions ON transactions.account_id=accounts.id
    GROUP BY accounts.id ORDER BY accounts.active DESC,accounts.sort_order,accounts.name`).all();
}

export function saveAccount(values = {}) {
  const id = String(values.id || randomUUID()).trim().slice(0, 80);
  const name = String(values.name || '').trim().slice(0, 100);
  const kind = ['cash', 'bank', 'wallet', 'other'].includes(values.kind) ? values.kind : 'other';
  const openingBalance = Math.round(Number(values.openingBalance) || 0);
  if (!name) throw new Error('نام حساب را وارد کن.');
  if (!Number.isSafeInteger(openingBalance)) throw new Error('ماندهٔ ابتدای دوره معتبر نیست.');
  const current = db.prepare('SELECT created_at AS createdAt,opening_balance AS openingBalance FROM accounts WHERE id=?').get(id);
  if (current && Number(current.openingBalance) !== openingBalance) assertAccountingPeriodOpen(db, periodForDate(current.createdAt, currentTimeZone()));
  if (!current && openingBalance !== 0) assertAccountingPeriodOpen(db, periodForDate(new Date(), currentTimeZone()));
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO accounts (id,name,kind,opening_balance,active) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,opening_balance=excluded.opening_balance,
        active=excluded.active,updated_at=CURRENT_TIMESTAMP`)
      .run(id, name, kind, openingBalance, values.active === false ? 0 : 1);
    if (id === 'cash') insertSetting.run('openingBalance', String(openingBalance));
    if (!current || Number(current.openingBalance) !== openingBalance) syncOpeningBalanceJournal(db, id, { createdBy: currentWorkspace()?.userId });
    audit(values.id ? 'update' : 'create', 'account', id, { name, kind, openingBalance });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return listAccounts().find((item) => item.id === id);
}

export function getCategories() {
  return db.prepare('SELECT id,name,type FROM categories ORDER BY type DESC, sort_order, name').all();
}

function currentTimeZone() {
  const candidate = getSettings().timezone || 'Asia/Tehran';
  try { new Intl.DateTimeFormat('en', { timeZone: candidate }).format(); return candidate; }
  catch { return 'Asia/Tehran'; }
}

export function localDay(date = new Date(), timeZone = currentTimeZone()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function addLocalDays(day, count) {
  const [year, month, date] = day.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, date + count));
  return result.toISOString().slice(0, 10);
}

function zonedMidnight(day, timeZone) {
  const [year, month, date] = day.split('-').map(Number);
  const target = Date.UTC(year, month - 1, date);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess -= represented - target;
  }
  return new Date(guess);
}

export function dayBounds(day = localDay(), timeZone = currentTimeZone()) {
  const startDate = zonedMidnight(day, timeZone);
  const nextDate = zonedMidnight(addLocalDays(day, 1), timeZone);
  return { start: startDate.toISOString(), endExclusive: nextDate.toISOString(), end: new Date(nextDate.getTime() - 1).toISOString() };
}

export function getToday() {
  const today = localDay();
  const { start, endExclusive } = dayBounds(today);
  const transactions = db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,
    transactions.raw_text AS rawText,transactions.source,transactions.confidence,transactions.needs_review AS needsReview,
    transactions.confidence_details AS confidenceDetails,transactions.review_reasons AS reviewReasons,
    transactions.review_state AS reviewState,transactions.restored_from AS restoredFrom,
    transactions.occurred_at AS occurredAt,transactions.note,transactions.account,transactions.account_id AS accountId,
    accounts.name AS accountName,transactions.contact_id AS contactId,contacts.name AS contactName
    FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id LEFT JOIN accounts ON accounts.id=transactions.account_id
    WHERE transactions.occurred_at>=? AND transactions.occurred_at<? AND transactions.status!='deleted'
    ORDER BY transactions.occurred_at DESC,transactions.created_at DESC`).all(start, endExclusive).map(hydrateTransaction);
  const totals = summarize(transactions);
  const previousBounds = dayBounds(addLocalDays(today, -1));
  const previous = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income FROM transactions WHERE status!='deleted' AND occurred_at>=? AND occurred_at<?").get(previousBounds.start, previousBounds.endExclusive).income;
  totals.comparison = previous > 0 ? Math.round(((totals.income - previous) / previous) * 100) : null;
  return { transactions, summary: totals };
}

export function summarize(items) {
  const income = items.filter((item) => item.type === 'income').reduce((sum, item) => sum + Number(item.amount), 0);
  const expense = items.filter((item) => item.type === 'expense').reduce((sum, item) => sum + Number(item.amount), 0);
  const netCashFlow = income - expense;
  // profit برای سازگاری نسخهٔ قبلی نگه داشته شده و نباید با سود حسابداری اشتباه شود.
  return { income, expense, netCashFlow, profit: netCashFlow, comparison: null };
}

function resolveAccountId(item = {}) {
  const requested = String(item.accountId || item.account || 'cash').trim().slice(0, 80);
  const account = db.prepare('SELECT id FROM accounts WHERE id=? AND active=1').get(requested)
    || db.prepare('SELECT id FROM accounts WHERE name=? AND active=1').get(requested);
  if (!account) throw new Error('حساب مالی انتخاب‌شده معتبر یا فعال نیست.');
  return account.id;
}

function normalizeReviewState(value, fallback = 'ready') {
  return ['ready', 'review', 'unintelligible', 'reviewed', 'duplicate-confirmed'].includes(value) ? value : fallback;
}

function jsonText(value, fallback) {
  try { return JSON.stringify(value ?? fallback); }
  catch { return JSON.stringify(fallback); }
}

function insertTransactionRows({ transcript, transactions }) {
  const insert = db.prepare(`INSERT OR IGNORE INTO transactions
    (id,client_id,amount,type,category,raw_text,source,confidence,needs_review,confidence_details,review_reasons,review_state,restored_from,occurred_at,contact_id,account,account_id,note,status,due_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ids = [];
  for (const item of transactions) {
    const id = randomUUID();
    const amount = Math.round(Number(item.amount));
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999_999_999_999) throw new Error('مبلغ معتبر نیست.');
    if (!['income', 'expense'].includes(item.type)) throw new Error('نوع تراکنش معتبر نیست.');
    const occurredAt = item.occurredAt || new Date().toISOString();
    assertAccountingPeriodOpen(db, periodForDate(occurredAt, currentTimeZone()));
    const accountId = resolveAccountId(item);
    const reviewState = normalizeReviewState(item.reviewState, item.needsReview ? 'review' : 'ready');
    const result = insert.run(
      id, item.clientId || null, amount, item.type, String(item.category || 'سایر').slice(0, 80),
      String(item.rawText || transcript || '').slice(0, 1000), item.source || 'text', Number(item.confidence ?? 1),
      item.needsReview ? 1 : 0, jsonText(item.confidenceDetails, {}), jsonText(item.reviewReasons, []), reviewState,
      item.restoredFrom || null, occurredAt, item.contactId || null, accountId, accountId,
      String(item.note || '').slice(0, 500), item.status || 'confirmed', item.dueAt || null, occurredAt,
    );
    if (result.changes) {
      ids.push(id);
      audit('create', 'transaction', id, { amount, type: item.type, category: item.category });
      if (!item.journalManaged) syncTransactionJournal(db, { id, amount, type: item.type, category: item.category, rawText: item.rawText || transcript, accountId, occurredAt }, { createdBy: currentWorkspace()?.userId });
    } else if (item.clientId) {
      const existing = db.prepare('SELECT id FROM transactions WHERE client_id=?').get(item.clientId);
      if (existing) ids.push(existing.id);
    }
  }
  return ids;
}

export function insertTransactions(payload) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Public transaction writes may describe review metadata, but cannot forge an
    // internal restore link, allocation status or bypass the accounting journal.
    const transactions = (payload.transactions || []).map((item) => ({
      ...item, status: 'confirmed', restoredFrom: null, journalManaged: false,
    }));
    const ids = insertTransactionRows({ ...payload, transactions });
    db.exec('COMMIT');
    return ids;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function similarityTerms(value) {
  return new Set(normalizePersian(value).toLowerCase().replace(/[^0-9آ-ی\s]/g, ' ').split(/\s+/).filter((term) => term.length > 1));
}

function textSimilarity(left, right) {
  const leftTerms = similarityTerms(left);
  const rightTerms = similarityTerms(right);
  if (!leftTerms.size || !rightTerms.size) return 0;
  const overlap = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  return overlap / (leftTerms.size + rightTerms.size - overlap);
}

export function findPotentialDuplicates(transactions = [], { windowMinutes = 5 } = {}) {
  const duplicates = [];
  for (const [inputIndex, item] of transactions.entries()) {
    if (item.clientId && db.prepare('SELECT 1 FROM transactions WHERE client_id=?').get(item.clientId)) continue;
    const amount = Math.round(Number(item.amount));
    if (!Number.isSafeInteger(amount) || !['income', 'expense'].includes(item.type)) continue;
    const occurredAt = item.occurredAt || new Date().toISOString();
    const accountId = resolveAccountId(item);
    const incomingText = String(item.rawText || '');
    const candidates = db.prepare(`SELECT id,amount,type,category,raw_text AS rawText,occurred_at AS occurredAt,
      account_id AS accountId FROM transactions
      WHERE status!='deleted' AND amount=? AND type=? AND account_id=?
        AND ABS((julianday(occurred_at)-julianday(?))*1440)<=?
      ORDER BY occurred_at DESC LIMIT 8`).all(amount, item.type, accountId, occurredAt, Math.max(1, Number(windowMinutes) || 5));
    for (const candidate of candidates) {
      const similarity = textSimilarity(`${incomingText} ${item.category || ''}`, `${candidate.rawText} ${candidate.category || ''}`);
      if (similarity < 0.42) continue;
      duplicates.push({ inputIndex, ...candidate, similarity: Math.round(similarity * 100) });
      break;
    }
  }
  return duplicates;
}

export function getLearnings() {
  return db.prepare('SELECT id,keyword,category,created_at AS createdAt,updated_at AS updatedAt FROM learnings ORDER BY updated_at DESC').all();
}

export function saveLearning({ id = randomUUID(), keyword, category }) {
  const cleanedKeyword = String(keyword || '').trim().slice(0, 80);
  const cleanedCategory = String(category || '').trim().slice(0, 80);
  if (cleanedKeyword.length < 2 || !cleanedCategory) throw new Error('عبارت و دسته را کامل وارد کن.');
  db.prepare(`INSERT INTO learnings (id,keyword,category) VALUES (?,?,?)
    ON CONFLICT(keyword) DO UPDATE SET category=excluded.category,updated_at=CURRENT_TIMESTAMP`).run(id, cleanedKeyword, cleanedCategory);
  return db.prepare('SELECT id,keyword,category FROM learnings WHERE keyword=?').get(cleanedKeyword);
}

export function updateLearning(id, values) {
  const current = db.prepare('SELECT * FROM learnings WHERE id=?').get(id);
  if (!current) return null;
  db.prepare('UPDATE learnings SET keyword=?,category=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(String(values.keyword || current.keyword).trim().slice(0, 80), String(values.category || current.category).trim().slice(0, 80), id);
  return db.prepare('SELECT id,keyword,category FROM learnings WHERE id=?').get(id);
}

export function deleteLearning(id) { return db.prepare('DELETE FROM learnings WHERE id=?').run(id).changes > 0; }

export function typicalAmounts() {
  const rows = db.prepare("SELECT type, AVG(amount) AS average FROM (SELECT type,amount FROM transactions WHERE status!='deleted' ORDER BY occurred_at DESC LIMIT 120) GROUP BY type").all();
  return Object.fromEntries(rows.map((row) => [row.type, Math.round(row.average)]));
}

export function report(range = 'month', now = new Date()) {
  const days = range === 'week' ? 7 : range === 'quarter' ? 90 : 30;
  const timeZone = currentTimeZone();
  const today = localDay(now, timeZone);
  const startDay = addLocalDays(today, -(days - 1));
  const start = dayBounds(startDay, timeZone).start;
  const endExclusive = dayBounds(addLocalDays(today, 1), timeZone).start;
  const items = db.prepare("SELECT amount,type,category,occurred_at AS occurredAt FROM transactions WHERE status!='deleted' AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at").all(start, endExclusive);
  const summary = summarize(items);
  const bucketCount = range === 'quarter' ? 12 : range === 'month' ? 10 : 7;
  const bucketDays = Math.ceil(days / bucketCount);
  const points = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const fromDay = addLocalDays(startDay, index * bucketDays);
    const untilDay = addLocalDays(startDay, Math.min(days, (index + 1) * bucketDays));
    const from = new Date(dayBounds(fromDay, timeZone).start);
    const until = new Date(dayBounds(untilDay, timeZone).start);
    const group = items.filter((item) => { const time = new Date(item.occurredAt); return time >= from && time < until; });
    const totals = summarize(group);
    points.push({ label: new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone, day: 'numeric', month: range === 'quarter' ? 'short' : undefined }).format(from), income: totals.income, expense: totals.expense });
  }
  const grouped = new Map();
  for (const item of items) {
    const key = `${item.type}:${item.category}`;
    grouped.set(key, { name: item.category, type: item.type, amount: (grouped.get(key)?.amount || 0) + Number(item.amount) });
  }
  const totalsByType = { income: Math.max(1, summary.income), expense: Math.max(1, summary.expense) };
  const categories = [...grouped.values()].sort((a, b) => b.amount - a.amount)
    .map((item) => ({ ...item, share: Math.round(item.amount / totalsByType[item.type] * 100) }));
  const biggestExpense = categories.find((item) => item.type === 'expense');
  const insight = biggestExpense ? `بیشترین هزینهٔ این بازه مربوط به «${biggestExpense.name}» و مبلغ آن ${new Intl.NumberFormat('fa-IR').format(biggestExpense.amount)} تومان بوده است.` : '';
  return { basis: 'cash', basisLabel: 'مبنای دریافت و پرداخت', summary, points, categories, insight };
}

function audit(action, entityType, entityId, payload = {}) {
  db.prepare('INSERT INTO audit_log (id,action,entity_type,entity_id,payload) VALUES (?,?,?,?,?)')
    .run(randomUUID(), action, entityType, entityId, JSON.stringify(payload));
}

export function recordAudit(action, entityType, entityId, payload = {}) {
  audit(action, entityType, entityId, payload);
}

function userIdentity(userId) {
  if (!userId) return null;
  const user = controlDb.prepare('SELECT id,username,display_name AS displayName FROM users WHERE id=?').get(userId);
  return user ? { ...user, label: user.displayName || user.username } : { id: userId, username: '', displayName: '', label: 'کاربر حذف‌شده' };
}

function hydrateCollaborationRequest(row) {
  if (!row) return null;
  return {
    ...row,
    requestedBy: userIdentity(row.requestedBy),
    answeredBy: userIdentity(row.answeredBy),
    resolvedBy: userIdentity(row.resolvedBy),
  };
}

export function listCollaborationRequests({ status = '' } = {}) {
  const normalizedStatus = ['open', 'answered', 'resolved'].includes(status) ? status : '';
  const rows = normalizedStatus
    ? db.prepare(`SELECT id,entity_type AS entityType,entity_id AS entityId,question,answer,priority,status,
        requested_by AS requestedBy,answered_by AS answeredBy,resolved_by AS resolvedBy,
        created_at AS createdAt,answered_at AS answeredAt,resolved_at AS resolvedAt
        FROM collaboration_requests WHERE status=? ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END,created_at DESC`).all(normalizedStatus)
    : db.prepare(`SELECT id,entity_type AS entityType,entity_id AS entityId,question,answer,priority,status,
        requested_by AS requestedBy,answered_by AS answeredBy,resolved_by AS resolvedBy,
        created_at AS createdAt,answered_at AS answeredAt,resolved_at AS resolvedAt
        FROM collaboration_requests ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END,
        CASE priority WHEN 'urgent' THEN 0 ELSE 1 END,created_at DESC LIMIT 200`).all();
  return rows.map(hydrateCollaborationRequest);
}

function collaborationEntityExists(entityType, entityId) {
  if (entityType === 'general') return true;
  const tables = {
    transaction: 'transactions', receipt: 'receipts', closing: 'daily_closings',
    reconciliation: 'bank_statement_imports', obligation: 'obligations',
  };
  const table = tables[entityType];
  return Boolean(table && entityId && db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(entityId));
}

export function createCollaborationRequest(values = {}) {
  const entityType = ['general', 'transaction', 'receipt', 'closing', 'reconciliation', 'obligation'].includes(values.entityType) ? values.entityType : 'general';
  const entityId = entityType === 'general' ? null : String(values.entityId || '').trim().slice(0, 80);
  const question = String(values.question || '').trim().slice(0, 1200);
  const priority = values.priority === 'urgent' ? 'urgent' : 'normal';
  if (question.length < 5) throw new Error('درخواست توضیح باید حداقل پنج نویسه باشد.');
  if (!collaborationEntityExists(entityType, entityId)) throw Object.assign(new Error('منبع درخواست در همین دفتر پیدا نشد.'), { status: 404, code: 'COLLABORATION_ENTITY_NOT_FOUND' });
  const id = randomUUID();
  db.prepare(`INSERT INTO collaboration_requests (id,entity_type,entity_id,question,priority,requested_by)
    VALUES (?,?,?,?,?,?)`).run(id, entityType, entityId, question, priority, currentWorkspace()?.userId || null);
  audit('request-explanation', 'collaboration_request', id, { entityType, entityId, priority });
  return listCollaborationRequests().find((item) => item.id === id);
}

export function answerCollaborationRequest(id, answer) {
  const text = String(answer || '').trim().slice(0, 2000);
  if (text.length < 2) throw new Error('پاسخ را کامل وارد کن.');
  const result = db.prepare(`UPDATE collaboration_requests SET answer=?,status='answered',answered_by=?,answered_at=CURRENT_TIMESTAMP,
    resolved_by=NULL,resolved_at=NULL WHERE id=? AND status IN ('open','answered')`)
    .run(text, currentWorkspace()?.userId || null, id);
  if (!result.changes) return null;
  audit('answer', 'collaboration_request', id, {});
  return listCollaborationRequests().find((item) => item.id === id);
}

export function resolveCollaborationRequest(id) {
  const result = db.prepare(`UPDATE collaboration_requests SET status='resolved',resolved_by=?,resolved_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='answered'`).run(currentWorkspace()?.userId || null, id);
  if (!result.changes) return null;
  audit('resolve', 'collaboration_request', id, {});
  return listCollaborationRequests().find((item) => item.id === id);
}

function monthWindowForWorkspace(month = '', now = new Date()) {
  const timeZone = currentTimeZone();
  const requested = normalizePersian(month);
  const currentPersianPeriod = periodForDate(now, timeZone);
  const token = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) ? requested : currentPersianPeriod;
  const [year, monthNumber] = token.split('-').map(Number);
  if (year < 1700) {
    let firstDay = null;
    let nextDay = null;
    let matched = false;
    // Persian year 1405 starts in Gregorian 2026. Beginning at January of
    // year + 621 keeps the whole requested Persian year inside this scan.
    const searchStart = new Date(Date.UTC(year + 621, 0, 1, 12));
    for (let offset = 0; offset < 500; offset += 1) {
      const candidate = new Date(searchStart.getTime() + offset * 86_400_000);
      const candidatePeriod = periodForDate(candidate, timeZone);
      if (candidatePeriod === token && !matched) {
        matched = true;
        firstDay = localDay(candidate, timeZone);
      } else if (matched && candidatePeriod !== token) {
        nextDay = localDay(candidate, timeZone);
        break;
      }
    }
    if (!firstDay || !nextDay) throw new Error('دورهٔ شمسی انتخاب‌شده قابل محاسبه نیست.');
    const start = zonedMidnight(firstDay, timeZone);
    const endExclusive = zonedMidnight(nextDay, timeZone);
    return {
      month: token, period: token, periodType: 'persian', from: start.toISOString(), toExclusive: endExclusive.toISOString(),
      to: new Date(endExclusive.getTime() - 1).toISOString(), timeZone,
    };
  }
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const start = zonedMidnight(`${token}-01`, timeZone);
  const endExclusive = zonedMidnight(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01`, timeZone);
  return { month: token, period: token, periodType: 'gregorian', from: start.toISOString(), toExclusive: endExclusive.toISOString(), to: new Date(endExclusive.getTime() - 1).toISOString(), timeZone };
}

function packageTransactions(range) {
  return db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,transactions.raw_text AS rawText,
    transactions.source,transactions.review_state AS reviewState,transactions.occurred_at AS occurredAt,
    transactions.account_id AS accountId,accounts.name AS accountName,transactions.contact_id AS contactId,contacts.name AS contactName,
    transactions.note FROM transactions LEFT JOIN accounts ON accounts.id=transactions.account_id
    LEFT JOIN contacts ON contacts.id=transactions.contact_id
    WHERE transactions.status!='deleted' AND transactions.occurred_at>=? AND transactions.occurred_at<?
    ORDER BY transactions.occurred_at`).all(range.from, range.toExclusive);
}

export function monthlyAccountantPackage(month = '', now = new Date()) {
  const range = monthWindowForWorkspace(month, now);
  const workspace = currentWorkspace();
  const workspaceMeta = controlDb.prepare('SELECT id,name,profile_type AS profileType FROM workspaces WHERE id=?').get(workspace?.id || 'primary');
  const transactions = packageTransactions(range);
  const incompleteReceipts = db.prepare(`${receiptSelect("WHERE receipts.status NOT IN ('linked','ignored')")} ORDER BY receipts.created_at`).all().map(hydrateReceipt);
  const rangeStartDay = localDay(new Date(range.from), range.timeZone);
  const rangeEndDay = localDay(new Date(range.toExclusive), range.timeZone);
  const closings = db.prepare(`SELECT id,day,expected_cash AS expectedCash,counted_cash AS countedCash,difference,note,created_at AS createdAt
    FROM daily_closings WHERE day>=? AND day<? ORDER BY day`).all(rangeStartDay, rangeEndDay);
  const closingDiscrepancies = closings.filter((item) => Number(item.difference) !== 0 && !String(item.note || '').trim());
  const reconciliationIssues = db.prepare(`SELECT bank_statement_imports.id,bank_statement_imports.file_name AS fileName,
    bank_statement_imports.period_start AS periodStart,bank_statement_imports.period_end AS periodEnd,bank_statement_imports.status,
    bank_statement_imports.created_at AS createdAt,COUNT(CASE WHEN bank_statement_lines.status='unmatched' THEN 1 END) AS unmatchedCount,
    COALESCE(SUM(CASE WHEN bank_statement_lines.status='unmatched' THEN bank_statement_lines.amount ELSE 0 END),0) AS unmatchedAmount
    FROM bank_statement_imports LEFT JOIN bank_statement_lines ON bank_statement_lines.import_id=bank_statement_imports.id
    GROUP BY bank_statement_imports.id HAVING bank_statement_imports.status='open' OR unmatchedCount>0
    ORDER BY bank_statement_imports.created_at`).all();
  const obligations = listObligations({ status: 'open' });
  const auditLog = db.prepare(`SELECT id,action,entity_type AS entityType,entity_id AS entityId,payload,created_at AS createdAt
    FROM audit_log WHERE created_at>=datetime(?) AND created_at<datetime(?) ORDER BY created_at`).all(range.from, range.toExclusive)
    .map((item) => ({ ...item, payload: parseStoredJson(item.payload, {}) }));
  const openRequests = [...listCollaborationRequests({ status: 'open' }), ...listCollaborationRequests({ status: 'answered' })];
  const sections = { transactions, incompleteReceipts, closings, closingDiscrepancies, reconciliationIssues, obligations, auditLog, openRequests };
  const checklist = monthlyPackageChecklist(sections);
  const summary = {
    transactionCount: transactions.length,
    income: transactions.filter((item) => item.type === 'income').reduce((sum, item) => sum + Number(item.amount), 0),
    expense: transactions.filter((item) => item.type === 'expense').reduce((sum, item) => sum + Number(item.amount), 0),
    incompleteReceipts: incompleteReceipts.length,
    unexplainedClosingDiscrepancies: closingDiscrepancies.length,
    reconciliationIssues: reconciliationIssues.length,
    openObligations: obligations.length,
    unansweredRequests: openRequests.filter((item) => item.status === 'open').length,
  };
  const payload = {
    format: 'hesab-yar-accountant-package', version: 1, generatedAt: now.toISOString(),
    workspace: workspaceMeta, scope: range, basis: 'cash', unit: 'تومان', summary, checklist, sections,
    disclaimer: 'این بسته برای تحویل و کنترل حسابدار است؛ جایگزین دفاتر قانونی، اظهارنامه یا فایل انتقال نرم‌افزار حسابداری رسمی نیست.',
  };
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { ...payload, manifest: { algorithm: 'sha256', digest, sourceIdsComplete: true, receiptImagesIncluded: false } };
}

// ---------------------------------------------------------------------------
// فاز ۲ — کدینگ دفتر، تفصیلی شناور و مرکز هزینه (روی دیتابیس دفتر فعال)
// ---------------------------------------------------------------------------

export function chartOverview() {
  const database = activeWorkspaceDatabase();
  return {
    accounts: listChartAccounts(database, { includeInactive: true }),
    mapping: chartMappingOverview(database),
    analytics: listAnalyticAccounts(database, { includeInactive: true }),
    costCenters: listCostCenters(database, { includeInactive: true }),
    template: { accountCount: DEFAULT_CHART_TEMPLATE.length },
  };
}

export function importChart(csvText, { replace = false } = {}) {
  const { rows } = parseChartCsv(csvText);
  const result = importChartOfAccounts(activeWorkspaceDatabase(), rows, { source: 'import', replace });
  audit('import', 'chart_of_accounts', 'chart', result);
  return { ...result, ...chartOverview() };
}

export function installChartTemplate() {
  const result = installDefaultChartTemplate(activeWorkspaceDatabase());
  audit('install-template', 'chart_of_accounts', 'chart', result);
  return { ...result, ...chartOverview() };
}

export function saveChartAccountEntry(values = {}) {
  const item = saveChartAccount(activeWorkspaceDatabase(), values);
  audit('save', 'chart_account', item.id, { code: item.code, name: item.name, level: item.level });
  return item;
}

export function mapLedgerAccount(ledgerAccountId, chartAccountId) {
  const result = mapLedgerAccountToChart(activeWorkspaceDatabase(), ledgerAccountId, chartAccountId);
  audit('map', 'ledger_account', ledgerAccountId, { chartCode: result.chartAccount?.code || null });
  return { ...result, mapping: chartMappingOverview(activeWorkspaceDatabase()) };
}

export function applyChartSuggestions() {
  const result = applySuggestedChartMappings(activeWorkspaceDatabase());
  audit('map-suggested', 'chart_of_accounts', 'chart', { applied: result.applied });
  return result;
}

export function saveAnalytic(values = {}) {
  const item = saveAnalyticAccount(activeWorkspaceDatabase(), values);
  audit('save', 'analytic_account', item.id, { code: item.code, name: item.name });
  return item;
}

export function saveCostCenterEntry(values = {}) {
  const item = saveCostCenter(activeWorkspaceDatabase(), values);
  audit('save', 'cost_center', item.id, { code: item.code, name: item.name });
  return item;
}

// ---------------------------------------------------------------------------
// ورود داده از اکسل و پارسیان
// ---------------------------------------------------------------------------

const CHART_SHEET_ALIASES = {
  code: ['code', 'accountcode', 'کد', 'کدحساب', 'کدینگ'],
  name: ['name', 'title', 'accountname', 'نام', 'نامحساب', 'شرح', 'عنوان'],
  level: ['level', 'سطح', 'نوعسطح', 'ردهحساب'],
  parentCode: ['parent', 'parentcode', 'کدوالد', 'والد', 'کدبالاسری', 'حسابوالد'],
  type: ['type', 'accounttype', 'نوع', 'نوعحساب', 'ماهیت'],
  role: ['role', 'نقش', 'کاربرد'],
};

const ANALYTIC_SHEET_ALIASES = {
  code: ['code', 'کد', 'کدتفصیلی', 'کدطرفحساب', 'کدشناور'],
  name: ['name', 'title', 'نام', 'نامتفصیلی', 'شرح', 'عنوان', 'نامطرفحساب'],
  kind: ['kind', 'type', 'نوع', 'گروه', 'نوعتفصیلی'],
};

const OPENING_SHEET_ALIASES = {
  code: ['code', 'accountcode', 'کد', 'کدحساب', 'کدمعین', 'کدینگ'],
  name: ['name', 'accountname', 'نام', 'نامحساب', 'شرححساب', 'عنوان'],
  debit: ['debit', 'بدهکار', 'ماندهبدهکار', 'گردشبدهکار', 'بدهکارریال', 'بدهکارتومان'],
  credit: ['credit', 'بستانکار', 'ماندهبستانکار', 'گردشبستانکار', 'بستانکارریال', 'بستانکارتومان'],
  analyticCode: ['analytic', 'analyticcode', 'کدتفصیلی', 'تفصیلی', 'شناور'],
};

function firstSheet(buffer, fileName) {
  const sheets = readTabularFile(buffer, fileName);
  return sheets[0];
}

/** ورود کدینگ از اکسل یا CSV — همان قواعد اعتبارسنجی فاز کدینگ. */
export function importChartFile(buffer, fileName = '', { replace = false } = {}) {
  const rows = tableFromSheet(firstSheet(buffer, fileName), {
    aliases: CHART_SHEET_ALIASES, required: ['code', 'name', 'level', 'type'], label: 'فایل کدینگ',
    labels: { code: 'کد', name: 'نام', level: 'سطح', type: 'نوع', parentCode: 'کد والد' },
  });
  const result = importChartOfAccounts(activeWorkspaceDatabase(), rows, { source: 'import', replace });
  audit('import', 'chart_of_accounts', 'chart', { ...result, fileName });
  return { ...result, ...chartOverview() };
}

/** ورود تفصیلی و طرف حساب از اکسل یا CSV. */
export function importAnalyticsFile(buffer, fileName = '') {
  const rows = tableFromSheet(firstSheet(buffer, fileName), {
    aliases: ANALYTIC_SHEET_ALIASES, required: ['name'], label: 'فایل تفصیلی',
    labels: { code: 'کد', name: 'نام', kind: 'نوع' },
  });
  const result = importAnalyticRows(activeWorkspaceDatabase(), rows);
  audit('import', 'analytic_accounts', 'analytics', { ...result, fileName });
  return { ...result, ...chartOverview() };
}

/**
 * ورود ماندهٔ افتتاحیه از تراز نرم‌افزار مقصد و ساخت یک سند افتتاحیهٔ متوازن.
 * واحد مبلغ اجباری است؛ حدس‌زدن تومان/ریال یعنی خطای ده‌برابری.
 */
export function importOpeningBalanceFile(buffer, fileName = '', { amountUnit = 'toman', replace = false, occurredAt = '' } = {}) {
  const database = activeWorkspaceDatabase();
  const rows = tableFromSheet(firstSheet(buffer, fileName), {
    aliases: OPENING_SHEET_ALIASES, required: ['code', 'debit', 'credit'], label: 'فایل ماندهٔ افتتاحیه',
    labels: { code: 'کد حساب', debit: 'بدهکار', credit: 'بستانکار', analyticCode: 'کد تفصیلی' },
  });
  const prepared = prepareOpeningBalanceRows(database, rows, { amountUnit: normalizeAmountUnit(amountUnit) === 'rial' ? 'rial' : 'toman' });

  database.exec('BEGIN IMMEDIATE');
  try {
    const lines = prepared.rows.map((item) => ({
      ...item, ledgerAccountId: ledgerAccountForChart(database, item.chart, (type) => nextLedgerCode(database, type)),
    }));
    const posted = postImportedOpeningBalances(database, lines, {
      occurredAt: occurredAt || new Date().toISOString(),
      createdBy: currentWorkspace()?.userId || null,
      timeZone: currentTimeZone(),
      replace,
    });
    database.exec('COMMIT');
    audit('import', 'opening_balance', posted.id, {
      fileName, amountUnit: prepared.amountUnit, lineCount: posted.lineCount,
      debitTotal: prepared.debitTotal, replacedEntryId: posted.replacedEntryId,
    });
    return {
      entryId: posted.id, lineCount: posted.lineCount, replacedEntryId: posted.replacedEntryId,
      debitTotal: prepared.debitTotal, creditTotal: prepared.creditTotal, amountUnit: prepared.amountUnit,
      mapping: chartMappingOverview(database),
    };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

/** الگوهای خالی اکسل تا حسابدار بداند دقیقاً چه ستون‌هایی لازم است. */
export function importTemplateWorkbook() {
  return buildWorkbook([
    { name: 'کدینگ', rows: [['کد', 'نام', 'سطح', 'کد والد', 'نوع', 'نقش'], ['1', 'دارایی‌های جاری', 'گروه', '', 'دارایی', ''], ['11', 'موجودی نقد و بانک', 'کل', '1', 'دارایی', ''], ['1101', 'صندوق', 'معین', '11', 'دارایی', 'cash']] },
    { name: 'تفصیلی', rows: [['کد', 'نام', 'نوع'], ['1001', 'شرکت آبان', 'مشتری'], ['1002', 'پروژهٔ برج', 'پروژه']] },
    { name: 'مانده افتتاحیه', rows: [['کد حساب', 'نام حساب', 'بدهکار', 'بستانکار', 'کد تفصیلی'], ['1101', 'صندوق', 5_000_000, '', ''], ['5101', 'سرمایه', '', 5_000_000, '']] },
    { name: 'راهنما', rows: [['هر شیت را جداگانه بارگذاری کن.'], ['سطح: گروه / کل / معین'], ['نوع: دارایی / بدهی / سرمایه / درآمد / هزینه'], ['کد فرزند باید با کد والد شروع شود.'], ['واحد مبلغ ماندهٔ افتتاحیه را هنگام بارگذاری صریح انتخاب کن.']] },
  ]);
}

export function transferFieldCatalog() {
  return { fields: TRANSFER_FIELDS, defaultColumns: DEFAULT_TRANSFER_COLUMNS, formats: Object.values(TRANSFER_FILE_FORMATS) };
}

export function dimensionReport(query = {}) {
  return dimensionBalance(activeWorkspaceDatabase(), {
    dimension: query.dimension === 'analytic' ? 'analytic' : 'costCenter',
    from: query.from || '', to: query.to || '',
  });
}

function accountingTransferSettings(targetSystem = 'generic-csv') {
  const target = normalizeAccountingTransferTarget(targetSystem);
  const row = db.prepare(`SELECT target_system AS targetSystem,template_name AS templateName,
    template_verified AS templateVerified,note,updated_at AS updatedAt,
    file_format AS fileFormat,amount_unit AS amountUnit,columns_json AS columnsJson
    FROM accounting_transfer_settings WHERE target_system=?`).get(target);
  const stored = parseStoredJson(row?.columnsJson, []);
  const columns = Array.isArray(stored) && stored.length ? stored : [...DEFAULT_TRANSFER_COLUMNS];
  return {
    targetSystem: target,
    templateName: row?.templateName || '',
    templateVerified: Boolean(row?.templateVerified),
    note: row?.note || '',
    updatedAt: row?.updatedAt || null,
    fileFormat: normalizeTransferFileFormat(row?.fileFormat),
    amountUnit: normalizeAmountUnit(row?.amountUnit),
    columns,
    usingDefaultColumns: !(Array.isArray(stored) && stored.length),
  };
}

function accountingTransferMappings(targetSystem = 'generic-csv') {
  const target = normalizeAccountingTransferTarget(targetSystem);
  return db.prepare(`SELECT accounting_transfer_mappings.target_system AS targetSystem,
    accounting_transfer_mappings.ledger_account_id AS ledgerAccountId,ledger_accounts.code AS sourceCode,
    ledger_accounts.name AS sourceName,accounting_transfer_mappings.target_code AS targetCode,
    accounting_transfer_mappings.target_name AS targetName,accounting_transfer_mappings.updated_at AS updatedAt
    FROM accounting_transfer_mappings JOIN ledger_accounts ON ledger_accounts.id=accounting_transfer_mappings.ledger_account_id
    WHERE accounting_transfer_mappings.target_system=? ORDER BY ledger_accounts.code`).all(target);
}

function accountingTransferJournalRows(range) {
  return db.prepare(`SELECT journal_entries.id AS entryId,journal_entries.occurred_at AS occurredAt,
    journal_entries.memo,journal_entries.entry_kind AS entryKind,journal_entries.source_type AS sourceType,
    journal_entries.source_id AS sourceId,journal_entries.revision,journal_lines.account_id AS accountId,
    ledger_accounts.code AS accountCode,ledger_accounts.name AS accountName,journal_lines.debit,journal_lines.credit,
    journal_lines.description AS lineDescription,
    chart_accounts.code AS chartCode,chart_accounts.name AS chartName,
    analytic_accounts.code AS analyticCode,analytic_accounts.name AS analyticName,
    cost_centers.code AS costCenterCode,cost_centers.name AS costCenterName
    FROM journal_entries JOIN journal_lines ON journal_lines.entry_id=journal_entries.id
    JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
    LEFT JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    LEFT JOIN analytic_accounts ON analytic_accounts.id=journal_lines.analytic_id
    LEFT JOIN cost_centers ON cost_centers.id=journal_lines.cost_center_id
    WHERE journal_entries.occurred_at>=? AND journal_entries.occurred_at<?
    ORDER BY journal_entries.occurred_at,journal_entries.created_at,journal_entries.id,journal_lines.rowid`).all(range.from, range.toExclusive);
}

function accountingTransferState(month = '', targetSystem = 'generic-csv', now = new Date()) {
  const target = normalizeAccountingTransferTarget(targetSystem);
  const packageData = monthlyAccountantPackage(month, now);
  const settings = accountingTransferSettings(target);
  const mappings = accountingTransferMappings(target);
  const journalRows = accountingTransferJournalRows(packageData.scope);
  const chart = chartMappingOverview(activeWorkspaceDatabase());
  const readiness = accountingTransferReadiness({
    packageData, journalRows, settings, mappings,
    chart: { installed: chart.chartInstalled, complete: chart.complete },
  });
  return { packageData, settings, mappings, journalRows, readiness, chart };
}

function hydrateAccountingTransferBatch(row, includeFile = false) {
  if (!row) return null;
  const latestValidation = db.prepare(`SELECT id,batch_id AS batchId,software_name AS softwareName,
    software_version AS softwareVersion,test_company_label AS testCompanyLabel,attempt_type AS attemptType,
    outcome,amount_unit AS amountUnit,imported_rows AS importedRows,rejected_rows AS rejectedRows,
    imported_debit_total AS importedDebitTotal,imported_credit_total AS importedCreditTotal,
    error_summary AS errorSummary,note,tested_by AS testedBy,created_at AS createdAt
    FROM accounting_transfer_validations WHERE batch_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(row.id);
  const passedTrial = db.prepare(`SELECT id FROM accounting_transfer_validations
    WHERE batch_id=? AND attempt_type='trial-import' AND outcome='passed' ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(row.id);
  const item = {
    id: row.id, period: row.period, targetSystem: row.targetSystem, fileName: row.fileName,
    rowCount: Number(row.rowCount), entryCount: Number(row.entryCount), debitTotal: Number(row.debitTotal),
    creditTotal: Number(row.creditTotal), digest: row.digest, status: row.status, statusNote: row.statusNote,
    generatedBy: userIdentity(row.generatedBy), reviewedBy: userIdentity(row.reviewedBy),
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    fileFormat: normalizeTransferFileFormat(row.fileFormat),
    fileFormatLabel: TRANSFER_FILE_FORMATS[normalizeTransferFileFormat(row.fileFormat)].label,
    mimeType: TRANSFER_FILE_FORMATS[normalizeTransferFileFormat(row.fileFormat)].mimeType,
    amountUnit: normalizeAmountUnit(row.amountUnit),
    amountUnitLabel: amountUnitLabel(row.amountUnit),
    latestValidation: latestValidation ? { ...latestValidation, testedBy: userIdentity(latestValidation.testedBy) } : null,
    acceptanceReady: row.targetSystem !== 'parsian-review-csv' || Boolean(passedTrial),
  };
  if (includeFile) item.fileData = Buffer.from(row.fileData || []);
  return item;
}

const accountingTransferBatchColumns = `id,period,target_system AS targetSystem,file_name AS fileName,
  row_count AS rowCount,entry_count AS entryCount,debit_total AS debitTotal,credit_total AS creditTotal,digest,status,
  status_note AS statusNote,generated_by AS generatedBy,reviewed_by AS reviewedBy,created_at AS createdAt,
  updated_at AS updatedAt,file_format AS fileFormat,amount_unit AS amountUnit`;
const accountingTransferBatchSelect = `SELECT ${accountingTransferBatchColumns} FROM accounting_transfer_batches`;
const accountingTransferBatchFileSelect = `SELECT ${accountingTransferBatchColumns},file_data AS fileData FROM accounting_transfer_batches`;

export function listAccountingTransferBatches({ period = '', targetSystem = '', limit = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) { clauses.push('period=?'); params.push(period); }
  if (targetSystem) { clauses.push('target_system=?'); params.push(normalizeAccountingTransferTarget(targetSystem)); }
  params.push(Math.min(200, Math.max(1, Number(limit) || 50)));
  return db.prepare(`${accountingTransferBatchSelect}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY created_at DESC LIMIT ?`).all(...params).map((row) => hydrateAccountingTransferBatch(row));
}

export function accountingTransferOverview(month = '', targetSystem = 'generic-csv', now = new Date()) {
  const state = accountingTransferState(month, targetSystem, now);
  return {
    generatedAt: now.toISOString(), scope: state.packageData.scope, settings: state.settings,
    targets: ACCOUNTING_TRANSFER_TARGETS, readiness: state.readiness,
    batches: listAccountingTransferBatches({ period: state.packageData.scope.period, targetSystem: state.settings.targetSystem }),
  };
}

export function saveAccountingTransferSettings(values = {}) {
  const targetSystem = normalizeAccountingTransferTarget(values.targetSystem);
  const templateName = String(values.templateName || '').trim().slice(0, 160);
  const templateVerified = Boolean(values.templateVerified);
  const note = String(values.note || '').trim().slice(0, 800);
  if (targetSystem === 'parsian-review-csv' && templateVerified && templateName.length < 3) {
    throw new Error('برای تأیید نگاشت پارسیان، نام یا نسخهٔ قالب کنترل‌شده را وارد کن.');
  }
  const current = accountingTransferSettings(targetSystem);
  const fileFormat = values.fileFormat == null ? current.fileFormat : normalizeTransferFileFormat(values.fileFormat);
  const amountUnit = values.amountUnit == null ? current.amountUnit : normalizeAmountUnit(values.amountUnit);
  // ستون‌ها فقط وقتی بازنویسی می‌شوند که کاربر صریحاً فرستاده باشد؛ ذخیرهٔ
  // نام قالب نباید چیدمان ستون‌های کنترل‌شده را پاک کند.
  const columns = values.columns == null ? null : normalizeTransferColumns(values.columns).columns;

  db.prepare(`INSERT INTO accounting_transfer_settings (target_system,template_name,template_verified,note,updated_by,file_format,amount_unit,columns_json)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(target_system) DO UPDATE SET template_name=excluded.template_name,
    template_verified=excluded.template_verified,note=excluded.note,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP,
    file_format=excluded.file_format,amount_unit=excluded.amount_unit,columns_json=excluded.columns_json`)
    .run(targetSystem, templateName, templateVerified ? 1 : 0, note, currentWorkspace()?.userId || null,
      fileFormat, amountUnit, JSON.stringify(columns ?? (current.usingDefaultColumns ? [] : current.columns)));
  audit('update-transfer-settings', 'accounting_transfer_settings', targetSystem, { templateName, templateVerified, fileFormat, amountUnit, columnCount: (columns || current.columns).length });
  return accountingTransferSettings(targetSystem);
}

export function saveAccountingTransferMapping(values = {}) {
  const targetSystem = normalizeAccountingTransferTarget(values.targetSystem);
  const ledgerAccountId = String(values.ledgerAccountId || '').trim();
  const targetCode = String(values.targetCode || '').trim().slice(0, 80);
  const targetName = String(values.targetName || '').trim().slice(0, 160);
  const account = db.prepare('SELECT id,code,name FROM ledger_accounts WHERE id=?').get(ledgerAccountId);
  if (!account) throw Object.assign(new Error('حساب دفتر کل در این دفتر پیدا نشد.'), { status: 404, code: 'TRANSFER_ACCOUNT_NOT_FOUND' });
  if (!targetCode) throw new Error('کد حساب مقصد را وارد کن.');
  db.prepare(`INSERT INTO accounting_transfer_mappings (target_system,ledger_account_id,target_code,target_name,updated_by)
    VALUES (?,?,?,?,?) ON CONFLICT(target_system,ledger_account_id) DO UPDATE SET target_code=excluded.target_code,
    target_name=excluded.target_name,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
    .run(targetSystem, ledgerAccountId, targetCode, targetName, currentWorkspace()?.userId || null);
  audit('map-transfer-account', 'ledger_account', ledgerAccountId, { targetSystem, targetCode, targetName });
  return accountingTransferMappings(targetSystem).find((item) => item.ledgerAccountId === ledgerAccountId);
}

export function createAccountingTransferBatch(values = {}, now = new Date()) {
  const targetSystem = normalizeAccountingTransferTarget(values.targetSystem);
  const state = accountingTransferState(values.month, targetSystem, now);
  if (!state.readiness.ready) throw Object.assign(new Error('خروجی هنوز آماده نیست؛ موارد کنترل‌نشده را برطرف کن.'), {
    status: 409, code: 'ACCOUNTING_TRANSFER_NOT_READY', details: { readiness: state.readiness },
  });
  const fileFormat = normalizeTransferFileFormat(values.fileFormat || state.settings.fileFormat);
  const built = buildAccountingTransferFile({
    period: state.packageData.scope.period, journalRows: state.journalRows, settings: state.settings,
    mappings: state.mappings, timeZone: state.packageData.scope.timeZone,
    fileFormat, columns: state.settings.columns, amountUnit: state.settings.amountUnit,
    targetLabel: state.readiness.target?.label || '',
  });
  const fileData = built.buffer;
  const digest = createHash('sha256').update(fileData).digest('hex');
  const existing = db.prepare(`${accountingTransferBatchSelect} WHERE period=? AND target_system=? AND digest=?`)
    .get(state.packageData.scope.period, targetSystem, digest);
  if (existing) return hydrateAccountingTransferBatch(existing);
  const id = randomUUID();
  const workspaceId = String(currentWorkspace()?.id || 'primary').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'primary';
  const fileName = `hesab-yar-ledger-${workspaceId}-${state.packageData.scope.period}-${targetSystem}.${TRANSFER_FILE_FORMATS[fileFormat].extension}`;
  db.prepare(`INSERT INTO accounting_transfer_batches (id,period,target_system,file_name,row_count,entry_count,debit_total,
    credit_total,digest,readiness_snapshot,file_data,generated_by,file_format,amount_unit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, state.packageData.scope.period, targetSystem, fileName, state.readiness.rowCount, state.readiness.entryCount,
      state.readiness.debitTotal, state.readiness.creditTotal, digest, JSON.stringify(state.readiness), fileData,
      currentWorkspace()?.userId || null, fileFormat, state.settings.amountUnit);
  audit('generate-transfer-batch', 'accounting_transfer_batch', id, {
    period: state.packageData.scope.period, targetSystem, digest, rowCount: state.readiness.rowCount, fileFormat,
    amountUnit: state.settings.amountUnit,
  });
  return hydrateAccountingTransferBatch(db.prepare(`${accountingTransferBatchSelect} WHERE id=?`).get(id));
}

export function accountingTransferBatchFile(id) {
  return hydrateAccountingTransferBatch(db.prepare(`${accountingTransferBatchFileSelect} WHERE id=?`).get(id), true);
}

export function listAccountingTransferValidations(batchId) {
  return db.prepare(`SELECT id,batch_id AS batchId,software_name AS softwareName,
    software_version AS softwareVersion,test_company_label AS testCompanyLabel,attempt_type AS attemptType,
    outcome,amount_unit AS amountUnit,imported_rows AS importedRows,rejected_rows AS rejectedRows,
    imported_debit_total AS importedDebitTotal,imported_credit_total AS importedCreditTotal,
    error_summary AS errorSummary,note,tested_by AS testedBy,created_at AS createdAt
    FROM accounting_transfer_validations WHERE batch_id=? ORDER BY created_at DESC,rowid DESC`).all(String(batchId || ''))
    .map((item) => ({ ...item, testedBy: userIdentity(item.testedBy) }));
}

export function createAccountingTransferValidation(batchId, values = {}) {
  const batch = db.prepare(`${accountingTransferBatchSelect} WHERE id=?`).get(String(batchId || ''));
  if (!batch) return null;
  if (['accepted', 'rejected'].includes(batch.status)) throw Object.assign(new Error('بستهٔ نهایی‌شده آزمون تازه نمی‌پذیرد؛ پس از اصلاح، بستهٔ جدید بساز.'), { status: 409, code: 'TRANSFER_BATCH_FINAL' });
  const softwareName = String(values.softwareName || (batch.targetSystem === 'parsian-review-csv' ? 'پارسیان' : '')).trim().slice(0, 100);
  const softwareVersion = String(values.softwareVersion || '').trim().slice(0, 100);
  const testCompanyLabel = String(values.testCompanyLabel || '').trim().slice(0, 160);
  const attemptType = values.attemptType === 'trial-import' ? 'trial-import' : 'dry-run';
  const outcome = values.outcome === 'passed' ? 'passed' : 'failed';
  const amountUnit = values.amountUnit === 'toman' ? 'toman' : 'rial';
  const importedRows = Math.max(0, Math.round(Number(values.importedRows) || 0));
  const rejectedRows = Math.max(0, Math.round(Number(values.rejectedRows) || 0));
  const importedDebitTotal = Math.max(0, Math.round(Number(values.importedDebitTotal) || 0));
  const importedCreditTotal = Math.max(0, Math.round(Number(values.importedCreditTotal) || 0));
  const errorSummary = String(values.errorSummary || '').trim().slice(0, 1600);
  const note = String(values.note || '').trim().slice(0, 1600);
  if (softwareName.length < 2 || softwareVersion.length < 1 || testCompanyLabel.length < 2) throw new Error('نام نرم‌افزار، نسخه و برچسب شرکت آزمایشی را کامل وارد کن.');
  if (outcome === 'failed' && errorSummary.length < 5) throw new Error('برای آزمون ناموفق، خلاصهٔ خطا را کامل وارد کن.');
  const multiplier = amountUnit === 'rial' ? 10 : 1;
  const expectedDebitTotal = Number(batch.debitTotal) * multiplier;
  const expectedCreditTotal = Number(batch.creditTotal) * multiplier;
  const exactMatch = importedRows === Number(batch.rowCount) && rejectedRows === 0
    && importedDebitTotal === expectedDebitTotal && importedCreditTotal === expectedCreditTotal;
  if (outcome === 'passed' && !exactMatch) throw Object.assign(new Error('آزمون موفق فقط وقتی ثبت می‌شود که تعداد ردیف، ردیف ردشده و جمع بدهکار/بستانکار دقیقاً با بسته برابر باشد.'), {
    status: 409, code: 'TRANSFER_VALIDATION_MISMATCH', details: {
      expectedRows: Number(batch.rowCount), expectedDebitTotal, expectedCreditTotal, amountUnit,
    },
  });
  const id = randomUUID();
  db.prepare(`INSERT INTO accounting_transfer_validations (id,batch_id,software_name,software_version,
    test_company_label,attempt_type,outcome,amount_unit,imported_rows,rejected_rows,imported_debit_total,
    imported_credit_total,error_summary,note,tested_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, batch.id, softwareName, softwareVersion, testCompanyLabel, attemptType, outcome, amountUnit,
      importedRows, rejectedRows, importedDebitTotal, importedCreditTotal, errorSummary, note,
      currentWorkspace()?.userId || null);
  audit('validate-transfer-batch', 'accounting_transfer_batch', batch.id, {
    validationId: id, attemptType, outcome, softwareName, softwareVersion, testCompanyLabel,
    amountUnit, importedRows, rejectedRows, importedDebitTotal, importedCreditTotal,
  });
  return listAccountingTransferValidations(batch.id).find((item) => item.id === id);
}

export function updateAccountingTransferBatchStatus(id, values = {}) {
  const status = ['delivered', 'accepted', 'rejected'].includes(values.status) ? values.status : '';
  const note = String(values.note || '').trim().slice(0, 1200);
  if (!status) throw new Error('وضعیت تحویل معتبر نیست.');
  if (status === 'rejected' && note.length < 5) throw new Error('دلیل رد خروجی را کامل وارد کن.');
  const current = db.prepare('SELECT id,status,target_system AS targetSystem FROM accounting_transfer_batches WHERE id=?').get(id);
  if (!current) return null;
  if (['accepted', 'rejected'].includes(current.status) && status !== current.status) throw Object.assign(new Error('خروجی نهایی‌شده قابل بازگرداندن نیست؛ پس از اصلاح داده یک بستهٔ جدید بساز.'), { status: 409, code: 'TRANSFER_BATCH_FINAL' });
  if (status === 'accepted' && current.targetSystem === 'parsian-review-csv') {
    const passedTrial = db.prepare(`SELECT id FROM accounting_transfer_validations
      WHERE batch_id=? AND attempt_type='trial-import' AND outcome='passed' LIMIT 1`).get(id);
    if (!passedTrial) throw Object.assign(new Error('پذیرش پارسیان فقط بعد از ثبت آزمون ورود موفق روی شرکت آزمایشی ممکن است.'), { status: 409, code: 'TRANSFER_TRIAL_REQUIRED' });
  }
  db.prepare(`UPDATE accounting_transfer_batches SET status=?,status_note=?,reviewed_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, note, currentWorkspace()?.userId || null, id);
  audit('update-transfer-status', 'accounting_transfer_batch', id, { status, note });
  return hydrateAccountingTransferBatch(db.prepare(`${accountingTransferBatchSelect} WHERE id=?`).get(id));
}

export function savePilotCheckin(values = {}) {
  const weekStart = String(values.weekStart || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || Number.isNaN(new Date(`${weekStart}T00:00:00Z`).getTime())) throw new Error('تاریخ شروع هفته معتبر نیست.');
  const respondentType = values.respondentType === 'accountant' ? 'accountant' : 'owner';
  const savedMinutes = Math.min(10_000, Math.max(0, Math.round(Number(values.savedMinutes) || 0)));
  const errorCount = Math.min(10_000, Math.max(0, Math.round(Number(values.errorCount) || 0)));
  const willingnessToPay = ['yes', 'maybe', 'no', 'unknown'].includes(values.willingnessToPay) ? values.willingnessToPay : 'unknown';
  const planInterest = ['free', 'professional', 'accountant', 'none'].includes(values.planInterest) ? values.planInterest : 'none';
  const id = randomUUID();
  db.prepare(`INSERT INTO pilot_checkins (id,week_start,respondent_type,saved_minutes,error_count,friction,dropout_reason,
    willingness_to_pay,plan_interest,note,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(week_start,respondent_type) DO UPDATE SET saved_minutes=excluded.saved_minutes,error_count=excluded.error_count,
    friction=excluded.friction,dropout_reason=excluded.dropout_reason,willingness_to_pay=excluded.willingness_to_pay,
    plan_interest=excluded.plan_interest,note=excluded.note,created_by=excluded.created_by,updated_at=CURRENT_TIMESTAMP`)
    .run(id, weekStart, respondentType, savedMinutes, errorCount, String(values.friction || '').trim().slice(0, 1000),
      String(values.dropoutReason || '').trim().slice(0, 1000), willingnessToPay, planInterest,
      String(values.note || '').trim().slice(0, 1200), currentWorkspace()?.userId || null);
  audit('pilot-checkin', 'workspace', currentWorkspace()?.id || 'primary', { weekStart, respondentType, willingnessToPay, planInterest });
  return listPilotCheckins().find((item) => item.weekStart === weekStart && item.respondentType === respondentType);
}

export function listPilotCheckins() {
  return db.prepare(`SELECT id,week_start AS weekStart,respondent_type AS respondentType,saved_minutes AS savedMinutes,
    error_count AS errorCount,friction,dropout_reason AS dropoutReason,willingness_to_pay AS willingnessToPay,
    plan_interest AS planInterest,note,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt
    FROM pilot_checkins ORDER BY week_start DESC,respondent_type LIMIT 52`).all()
    .map((item) => ({ ...item, createdBy: userIdentity(item.createdBy) }));
}

export function pilotWorkspaceDashboard(now = new Date(), workspaceMeta = null) {
  const workspace = workspaceMeta || controlDb.prepare('SELECT id,name,created_at AS createdAt FROM workspaces WHERE id=?').get(currentWorkspace()?.id || 'primary');
  const weeks = fourWeekWindows(now).map((window) => {
    const transactions = Number(db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE status!='deleted' AND created_at>=datetime(?) AND created_at<datetime(?)").get(window.from, window.toExclusive).count || 0);
    const receipts = Number(db.prepare('SELECT COUNT(*) AS count FROM receipts WHERE created_at>=datetime(?) AND created_at<datetime(?)').get(window.from, window.toExclusive).count || 0);
    const voice = Number(db.prepare('SELECT COUNT(*) AS count FROM voice_metrics WHERE created_at>=datetime(?) AND created_at<datetime(?)').get(window.from, window.toExclusive).count || 0);
    return { ...window, transactions, receipts, voice, activity: transactions + receipts + voice, active: transactions + receipts + voice > 0 };
  });
  const checkins = listPilotCheckins();
  const latestCheckin = checkins[0] || null;
  const ageDays = workspace?.createdAt ? Math.floor((now.getTime() - new Date(`${workspace.createdAt.replace(' ', 'T')}Z`).getTime()) / 86_400_000) : 0;
  return {
    workspace,
    weeks,
    activeWeeks: weeks.filter((item) => item.active).length,
    eligibleForWeekFour: ageDays >= 21,
    weekFourActive: ageDays >= 21 ? Boolean(weeks.at(-1)?.active) : false,
    willingnessToPay: latestCheckin?.willingnessToPay || 'unknown',
    savedMinutes: checkins.reduce((sum, item) => sum + Number(item.savedMinutes || 0), 0),
    reportedErrors: checkins.reduce((sum, item) => sum + Number(item.errorCount || 0), 0),
    latestFriction: latestCheckin?.friction || '',
    latestDropoutReason: latestCheckin?.dropoutReason || '',
    checkins,
  };
}

export function pilotPortfolio(now = new Date()) {
  const workspaces = allWorkspaces().map((workspace) => runInWorkspace(workspace.id, { role: 'owner' }, () => ({
    ...pilotWorkspaceDashboard(now, workspace), commercial: commercialStatus(workspace.id, now),
  })));
  return { generatedAt: now.toISOString(), summary: pilotRetentionSummary(workspaces), workspaces };
}

const FIRM_CACHE_TTL_MS = 5 * 60 * 1000;

// شمارش‌های سبک یک پرونده برای میز کار. عمداً از monthlyAccountantPackage استفاده
// نمی‌کند چون آن تابع کل تراکنش‌ها و رسیدها را می‌خواند و برای ۵۰ پرونده گران است.
function firmClientSnapshot(month = '', now = new Date()) {
  const range = monthWindowForWorkspace(month, now);
  const count = (sql, ...parameters) => Number(db.prepare(sql).get(...parameters)?.count || 0);

  const ledger = db.prepare(`SELECT COALESCE(SUM(journal_lines.debit),0) AS debit,COALESCE(SUM(journal_lines.credit),0) AS credit
    FROM journal_lines JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
    WHERE journal_entries.occurred_at>=datetime(?) AND journal_entries.occurred_at<datetime(?)`).get(range.from, range.toExclusive);

  const rangeStartDay = localDay(new Date(range.from), range.timeZone);
  const rangeEndDay = localDay(new Date(range.toExclusive), range.timeZone);
  const totals = db.prepare(`SELECT
      COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expense
    FROM transactions WHERE status!='deleted' AND occurred_at>=datetime(?) AND occurred_at<datetime(?)`).get(range.from, range.toExclusive);

  const lastBatch = db.prepare(`SELECT id,period,target_system AS targetSystem,status,row_count AS rowCount,
    created_at AS createdAt FROM accounting_transfer_batches ORDER BY created_at DESC LIMIT 1`).get() || null;

  return {
    month: range.period || range.month || null,
    available: true,
    counts: {
      // رسید تا وقتی به ثبت وصل یا صرف‌نظر نشده، مدرک معلق است.
      openReceipts: count("SELECT COUNT(*) AS count FROM receipts WHERE status NOT IN ('linked','ignored')"),
      unexplainedClosings: count(
        "SELECT COUNT(*) AS count FROM daily_closings WHERE day>=? AND day<? AND difference<>0 AND TRIM(COALESCE(note,''))=''",
        rangeStartDay, rangeEndDay,
      ),
      unmatchedBankLines: count("SELECT COUNT(*) AS count FROM bank_statement_lines WHERE status='unmatched'"),
      openRequests: count("SELECT COUNT(*) AS count FROM collaboration_requests WHERE status='open'"),
      answeredRequests: count("SELECT COUNT(*) AS count FROM collaboration_requests WHERE status='answered'"),
      unreviewedTransactions: count("SELECT COUNT(*) AS count FROM transactions WHERE needs_review=1 AND status!='deleted'"),
      overdueObligations: count(
        "SELECT COUNT(*) AS count FROM obligations WHERE status='open' AND due_at IS NOT NULL AND due_at<datetime(?)",
        now.toISOString(),
      ),
    },
    ledgerBalanced: Number(ledger?.debit || 0) === Number(ledger?.credit || 0),
    periodLocked: (db.prepare('SELECT status FROM accounting_periods WHERE period=?').get(range.period || '')?.status || 'open') === 'locked',
    lastActivityAt: db.prepare('SELECT MAX(created_at) AS createdAt FROM audit_log').get()?.createdAt || null,
    activity: {
      transactionCount: Number(totals?.count || 0),
      income: Number(totals?.income || 0),
      expense: Number(totals?.expense || 0),
      entryCount: count('SELECT COUNT(*) AS count FROM journal_entries WHERE occurred_at>=datetime(?) AND occurred_at<datetime(?)', range.from, range.toExclusive),
    },
    delivery: { lastBatch },
  };
}

function cachedFirmSnapshot(workspaceId, month, now, refresh) {
  const cached = controlDb.prepare('SELECT payload,computed_at AS computedAt FROM firm_client_cache WHERE workspace_id=? AND month=?')
    .get(workspaceId, month);
  if (!refresh && cached) {
    const computedAt = parseStoredMoment(cached.computedAt);
    const age = computedAt ? now.getTime() - computedAt.getTime() : Number.NaN;
    if (Number.isFinite(age) && age >= 0 && age < FIRM_CACHE_TTL_MS) {
      return { ...parseStoredJson(cached.payload, {}), cached: true, computedAt: cached.computedAt };
    }
  }
  const snapshot = runInWorkspace(workspaceId, { role: 'accountant' }, () => firmClientSnapshot(month, now));
  controlDb.prepare(`INSERT INTO firm_client_cache (workspace_id,month,payload,computed_at) VALUES (?,?,?,?)
    ON CONFLICT(workspace_id,month) DO UPDATE SET payload=excluded.payload,computed_at=excluded.computed_at`)
    .run(workspaceId, month, JSON.stringify(snapshot), now.toISOString());
  return { ...snapshot, cached: false, computedAt: now.toISOString() };
}

/**
 * میز کار دفتر حسابداری: وضعیت همهٔ پرونده‌هایی که همین کاربر عضو آن‌هاست.
 * پرونده‌ای که کاربر عضوش نیست هرگز وارد این خروجی نمی‌شود.
 */
export function firmPortfolio(userId, { month = '', refresh = false, now = new Date() } = {}) {
  const memberships = listUserWorkspaces(userId);
  const requested = normalizePersian(String(month || '').trim());
  const snapshots = memberships.map((workspace) => {
    const key = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested)
      ? requested
      : runInWorkspace(workspace.id, { role: 'accountant' }, () => periodForDate(now, currentTimeZone()));
    try {
      return { workspace, ...cachedFirmSnapshot(workspace.id, key, now, refresh), month: key };
    } catch (error) {
      // یک پروندهٔ خراب نباید کل میز کار را از کار بیندازد؛ ردیفش «نامشخص» می‌ماند.
      return { workspace, month: key, available: false, error: error.message };
    }
  });
  const portfolio = buildFirmPortfolio(snapshots, { now });
  return { generatedAt: now.toISOString(), ...portfolio };
}

export function invalidateFirmCache(workspaceId) {
  controlDb.prepare('DELETE FROM firm_client_cache WHERE workspace_id=?').run(String(workspaceId || ''));
}

export function workspaceOperationalSignals() {
  const quickCheck = db.prepare('PRAGMA quick_check').get();
  const lastRestore = db.prepare("SELECT created_at AS createdAt FROM audit_log WHERE action='restore' ORDER BY created_at DESC LIMIT 1").get();
  const lastActivity = db.prepare('SELECT MAX(created_at) AS createdAt FROM audit_log').get();
  const unresolvedRequests = Number(db.prepare("SELECT COUNT(*) AS count FROM collaboration_requests WHERE status!='resolved'").get().count || 0);
  return {
    database: { ok: Object.values(quickCheck || {}).includes('ok'), result: Object.values(quickCheck || {})[0] || 'unknown' },
    lastRestoreAt: lastRestore?.createdAt || null,
    lastActivityAt: lastActivity?.createdAt || null,
    unresolvedRequests,
  };
}

function cleanAmount(value) {
  const amount = Math.round(Number(value));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999_999_999_999) throw new Error('مبلغ معتبر نیست.');
  return amount;
}

function parseStoredJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '') ?? fallback; }
  catch { return fallback; }
}

function hydrateTransaction(item) {
  if (!item) return null;
  return {
    ...item,
    needsReview: Boolean(item.needsReview),
    confidenceDetails: parseStoredJson(item.confidenceDetails, {}),
    reviewReasons: parseStoredJson(item.reviewReasons, []),
  };
}

function transactionQuery(includeDeleted = false) {
  return `SELECT transactions.id,transactions.client_id AS clientId,transactions.amount,transactions.type,transactions.category,
    transactions.raw_text AS rawText,transactions.source,transactions.confidence,transactions.needs_review AS needsReview,
    transactions.confidence_details AS confidenceDetails,transactions.review_reasons AS reviewReasons,
    transactions.review_state AS reviewState,transactions.restored_from AS restoredFrom,
    transactions.occurred_at AS occurredAt,transactions.created_at AS createdAt,transactions.note,transactions.account,transactions.status,
    transactions.account_id AS accountId,accounts.name AS accountName,
    transactions.contact_id AS contactId,contacts.name AS contactName,transactions.due_at AS dueAt
    FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id LEFT JOIN accounts ON accounts.id=transactions.account_id
    WHERE transactions.id=?${includeDeleted ? '' : " AND transactions.status!='deleted'"}`;
}

function transactionRow(id) {
  return hydrateTransaction(db.prepare(transactionQuery(false)).get(id));
}

function transactionAnyRow(id) {
  return hydrateTransaction(db.prepare(transactionQuery(true)).get(id));
}

export function getTransaction(id) {
  return transactionRow(id);
}

export function latestTransaction() {
  const row = db.prepare(`SELECT id FROM transactions WHERE status!='deleted' ORDER BY created_at DESC,rowid DESC LIMIT 1`).get();
  return row ? transactionRow(row.id) : null;
}

export function listTransactions({ query = '', type = '', category = '', from = '', to = '', page = 1, limit = 30 } = {}) {
  const clauses = ["transactions.status!='deleted'"];
  const values = [];
  if (query) {
    clauses.push('(transactions.raw_text LIKE ? OR transactions.note LIKE ? OR transactions.category LIKE ? OR contacts.name LIKE ?)');
    const pattern = `%${String(query).slice(0, 100)}%`;
    values.push(pattern, pattern, pattern, pattern);
  }
  if (['income', 'expense'].includes(type)) { clauses.push('transactions.type=?'); values.push(type); }
  if (category) { clauses.push('transactions.category=?'); values.push(String(category).slice(0, 80)); }
  if (from) { clauses.push('transactions.occurred_at>=?'); values.push(String(from)); }
  if (to) { clauses.push('transactions.occurred_at<=?'); values.push(String(to)); }
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  const safePage = Math.max(1, Number(page) || 1);
  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS count FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id WHERE ${where}`).get(...values).count;
  const items = db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,
    transactions.raw_text AS rawText,transactions.source,transactions.confidence,transactions.needs_review AS needsReview,
    transactions.confidence_details AS confidenceDetails,transactions.review_reasons AS reviewReasons,
    transactions.review_state AS reviewState,transactions.restored_from AS restoredFrom,
    transactions.occurred_at AS occurredAt,transactions.note,transactions.account,transactions.status,
    transactions.account_id AS accountId,accounts.name AS accountName,
    transactions.contact_id AS contactId,contacts.name AS contactName
    FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id LEFT JOIN accounts ON accounts.id=transactions.account_id
    WHERE ${where} ORDER BY transactions.occurred_at DESC LIMIT ? OFFSET ?`)
    .all(...values, safeLimit, (safePage - 1) * safeLimit).map(hydrateTransaction);
  return { items, total, page: safePage, pages: Math.max(1, Math.ceil(total / safeLimit)) };
}

export function updateTransaction(id, values = {}) {
  const current = transactionRow(id);
  if (!current) return null;
  if (current.status === 'allocated') throw Object.assign(new Error('این جابه‌جایی پول از تسویهٔ یک سند ساخته شده و فقط از داخل همان سند قابل اصلاح است.'), { code: 'ALLOCATED_TRANSACTION_LOCKED', status: 409 });
  const type = ['income', 'expense'].includes(values.type) ? values.type : current.type;
  const amount = values.amount == null ? current.amount : cleanAmount(values.amount);
  const occurredAt = values.occurredAt || current.occurredAt;
  const accountId = values.accountId == null && values.account == null ? current.accountId : resolveAccountId(values);
  assertAccountingPeriodOpen(db, periodForDate(current.occurredAt, currentTimeZone()));
  assertAccountingPeriodOpen(db, periodForDate(occurredAt, currentTimeZone()));
  const category = String(values.category || current.category).slice(0, 80);
  const rawText = String(values.rawText ?? current.rawText).slice(0, 1000);
  const changedByUser = ['amount', 'type', 'category', 'accountId', 'account'].some((field) => values[field] !== undefined);
  const needsReview = values.needsReview === undefined ? (changedByUser ? false : current.needsReview) : Boolean(values.needsReview);
  const confidence = Number(values.confidence ?? current.confidence ?? 1);
  const confidenceDetails = values.confidenceDetails ?? current.confidenceDetails ?? {};
  const reviewReasons = values.reviewReasons ?? current.reviewReasons ?? [];
  const reviewState = normalizeReviewState(values.reviewState, changedByUser ? 'reviewed' : current.reviewState);
  db.exec('BEGIN IMMEDIATE');
  try {
    reverseTransactionJournal(db, id, current.occurredAt, { createdBy: currentWorkspace()?.userId });
    db.prepare(`UPDATE transactions SET amount=?,type=?,category=?,raw_text=?,note=?,account=?,account_id=?,contact_id=?,occurred_at=?,due_at=?,
      confidence=?,needs_review=?,confidence_details=?,review_reasons=?,review_state=?,updated_at=? WHERE id=?`)
      .run(amount, type, category, rawText, String(values.note ?? current.note ?? '').slice(0, 500), accountId, accountId,
        values.contactId === undefined ? current.contactId : (values.contactId || null), occurredAt,
        values.dueAt === undefined ? current.dueAt : (values.dueAt || null), confidence, needsReview ? 1 : 0,
        jsonText(confidenceDetails, {}), jsonText(reviewReasons, []), reviewState, new Date().toISOString(), id);
    syncTransactionJournal(db, { id, amount, type, category, rawText, accountId, occurredAt }, { createdBy: currentWorkspace()?.userId });
    audit('update', 'transaction', id, { before: current, after: values });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return transactionRow(id);
}

export function correctLatestTransaction(targetId, command, changes = {}) {
  const latest = latestTransaction();
  if (!latest) throw Object.assign(new Error('هنوز ثبتی برای اصلاح وجود ندارد.'), { code: 'LATEST_TRANSACTION_MISSING', status: 404 });
  if (!targetId || latest.id !== targetId) throw Object.assign(new Error('در این فاصله ثبت تازه‌ای اضافه شده؛ اصلاح را دوباره بررسی کن.'), { code: 'LATEST_TRANSACTION_CHANGED', status: 409 });
  const allowed = Object.fromEntries(Object.entries(changes).filter(([key]) => ['amount', 'type', 'category', 'accountId'].includes(key)));
  if (!Object.keys(allowed).length) throw Object.assign(new Error('تغییر قابل‌اعمالی در فرمان پیدا نشد.'), { code: 'CORRECTION_EMPTY', status: 400 });
  const item = updateTransaction(targetId, {
    ...allowed,
    rawText: `${latest.rawText}\nاصلاح گفتاری: ${String(command || '').trim()}`,
    needsReview: false,
    reviewState: 'reviewed',
    reviewReasons: [...(latest.reviewReasons || []), `اصلاح با فرمان کاربر: ${String(command || '').trim()}`],
  });
  audit('conversation_correction', 'transaction', targetId, { command: String(command || '').slice(0, 500), changes: allowed });
  return item;
}

export function deleteTransaction(id) {
  const current = transactionRow(id);
  if (!current) return false;
  if (current.status === 'allocated') throw Object.assign(new Error('تراکنش تخصیص‌یافته به سند را نمی‌توان جداگانه حذف کرد.'), { code: 'ALLOCATED_TRANSACTION_LOCKED', status: 409 });
  assertAccountingPeriodOpen(db, periodForDate(current.occurredAt, currentTimeZone()));
  db.exec('BEGIN IMMEDIATE');
  try {
    reverseTransactionJournal(db, id, current.occurredAt, { createdBy: currentWorkspace()?.userId, memo: 'سند معکوس حذف تراکنش' });
    db.prepare("UPDATE transactions SET status='deleted',updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    audit('delete', 'transaction', id, current);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return true;
}

export function redoTransaction(id) {
  const current = transactionAnyRow(id);
  if (!current || current.status !== 'deleted') throw Object.assign(new Error('ثبت حذف‌شده برای بازیابی پیدا نشد.'), { code: 'REDO_SOURCE_MISSING', status: 404 });
  const alreadyRestored = db.prepare("SELECT id FROM transactions WHERE restored_from=? AND status!='deleted' ORDER BY created_at DESC LIMIT 1").get(id);
  if (alreadyRestored) throw Object.assign(new Error('این ثبت قبلاً بازیابی شده است.'), { code: 'TRANSACTION_ALREADY_RESTORED', status: 409, details: { id: alreadyRestored.id } });
  db.exec('BEGIN IMMEDIATE');
  try {
    const [restoredId] = insertTransactionRows({ transcript: current.rawText, transactions: [{
      amount: current.amount, type: current.type, category: current.category, rawText: current.rawText,
      source: current.source, confidence: current.confidence, confidenceDetails: current.confidenceDetails,
      reviewReasons: [...(current.reviewReasons || []), 'ثبت حذف‌شده با درخواست کاربر دوباره ایجاد شد.'],
      reviewState: 'reviewed', needsReview: false, accountId: current.accountId, contactId: current.contactId,
      note: current.note, dueAt: current.dueAt, occurredAt: current.occurredAt, restoredFrom: id,
    }] });
    audit('redo', 'transaction', restoredId, { restoredFrom: id });
    db.exec('COMMIT');
    return transactionRow(restoredId);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function listContacts() {
  return db.prepare(`SELECT contacts.id,contacts.name,contacts.kind,contacts.phone,contacts.note,
    COALESCE((SELECT SUM(CASE WHEN obligations.direction='receivable' THEN obligations.amount ELSE -obligations.amount END)
      FROM obligations WHERE obligations.contact_id=contacts.id AND obligations.status='open'),0)
    + COALESCE((SELECT SUM(CASE WHEN invoices.document_type='sales' THEN invoices.total-COALESCE((SELECT SUM(invoice_payments.amount) FROM invoice_payments WHERE invoice_payments.invoice_id=invoices.id),0)
      ELSE -(invoices.total-COALESCE((SELECT SUM(invoice_payments.amount) FROM invoice_payments WHERE invoice_payments.invoice_id=invoices.id),0)) END)
      FROM invoices WHERE invoices.contact_id=contacts.id AND invoices.status IN ('sent','paid')),0) AS balance,
    (SELECT COUNT(*) FROM obligations WHERE obligations.contact_id=contacts.id AND obligations.status='open')
    + (SELECT COUNT(*) FROM invoices WHERE invoices.contact_id=contacts.id AND invoices.status='sent') AS openCount
    FROM contacts ORDER BY contacts.updated_at DESC,contacts.name`).all();
}

export function saveContact(values = {}) {
  const name = String(values.name || '').trim().slice(0, 100);
  if (name.length < 2) throw new Error('نام شخص را کامل وارد کن.');
  const id = values.id || randomUUID();
  const kind = ['person', 'customer', 'vendor'].includes(values.kind) ? values.kind : 'person';
  db.prepare(`INSERT INTO contacts (id,name,kind,phone,note) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,phone=excluded.phone,note=excluded.note,updated_at=CURRENT_TIMESTAMP`)
    .run(id, name, kind, String(values.phone || '').slice(0, 30), String(values.note || '').slice(0, 500));
  audit(values.id ? 'update' : 'create', 'contact', id, { name, kind });
  return listContacts().find((item) => item.id === id);
}

export function deleteContact(id) {
  const result = db.prepare('DELETE FROM contacts WHERE id=?').run(id);
  if (result.changes) audit('delete', 'contact', id);
  return result.changes > 0;
}

export function listObligations({ status = 'open' } = {}) {
  const where = ['open', 'paid', 'cancelled'].includes(status) ? 'WHERE obligations.status=?' : '';
  const args = where ? [status] : [];
  return db.prepare(`SELECT obligations.id,obligations.contact_id AS contactId,contacts.name AS contactName,
    obligations.title,obligations.amount,obligations.direction,obligations.due_at AS dueAt,
    obligations.status,obligations.note,obligations.created_at AS createdAt
    FROM obligations LEFT JOIN contacts ON contacts.id=obligations.contact_id ${where}
    ORDER BY CASE WHEN obligations.due_at IS NULL THEN 1 ELSE 0 END,obligations.due_at,obligations.created_at DESC`).all(...args);
}

export function saveObligation(values = {}) {
  const amount = cleanAmount(values.amount);
  const direction = ['receivable', 'payable'].includes(values.direction) ? values.direction : null;
  if (!direction) throw new Error('نوع طلب یا بدهی معتبر نیست.');
  const title = String(values.title || '').trim().slice(0, 120);
  if (!title) throw new Error('عنوان طلب یا بدهی را وارد کن.');
  const id = values.id || randomUUID();
  db.prepare(`INSERT INTO obligations (id,contact_id,title,amount,direction,due_at,status,note) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET contact_id=excluded.contact_id,title=excluded.title,amount=excluded.amount,
      direction=excluded.direction,due_at=excluded.due_at,status=excluded.status,note=excluded.note,updated_at=CURRENT_TIMESTAMP`)
    .run(id, values.contactId || null, title, amount, direction, values.dueAt || null, ['open', 'paid', 'cancelled'].includes(values.status) ? values.status : 'open', String(values.note || '').slice(0, 500));
  audit(values.id ? 'update' : 'create', 'obligation', id, { amount, direction, title });
  return listObligations({ status: 'all' }).find((item) => item.id === id);
}

export function settleObligation(id, { occurredAt, account = 'cash', accountId } = {}) {
  const item = db.prepare("SELECT * FROM obligations WHERE id=? AND status='open'").get(id);
  if (!item) return null;
  let transactionId;
  db.exec('BEGIN IMMEDIATE');
  try {
    [transactionId] = insertTransactionRows({ transcript: `تسویه ${item.title}`, transactions: [{
      clientId: `obligation:${id}`, amount: item.amount,
      type: item.direction === 'receivable' ? 'income' : 'expense',
      category: item.direction === 'receivable' ? 'سایر درآمدها' : 'سایر هزینه‌ها',
      rawText: `تسویه ${item.title}`, source: 'text', contactId: item.contact_id, occurredAt, account, accountId,
    }] });
    const updated = db.prepare("UPDATE obligations SET status='paid',paid_transaction_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").run(transactionId, id);
    if (!updated.changes) throw new Error('این طلب یا بدهی قبلاً تسویه شده است.');
    audit('settle', 'obligation', id, { transactionId });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { item: listObligations({ status: 'paid' }).find((row) => row.id === id), transaction: transactionRow(transactionId) };
}

export function deleteObligation(id) {
  const result = db.prepare('DELETE FROM obligations WHERE id=?').run(id);
  if (result.changes) audit('delete', 'obligation', id);
  return result.changes > 0;
}

export function listRecurringRules() {
  return db.prepare(`SELECT id,title,amount,type,category,day_of_month AS dayOfMonth,next_due_at AS nextDueAt,
    active,created_at AS createdAt FROM recurring_rules ORDER BY active DESC,next_due_at`).all();
}

function nextMonthlyDate(day, from = new Date()) {
  const next = new Date(from);
  next.setUTCHours(9, 0, 0, 0);
  next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()));
  if (next <= from) {
    next.setUTCMonth(next.getUTCMonth() + 1, 1);
    next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()));
  }
  return next.toISOString();
}

export function saveRecurringRule(values = {}) {
  const id = values.id || randomUUID();
  const amount = cleanAmount(values.amount);
  const type = ['income', 'expense'].includes(values.type) ? values.type : 'expense';
  const day = Math.min(31, Math.max(1, Number(values.dayOfMonth) || new Date().getDate()));
  const title = String(values.title || '').trim().slice(0, 120);
  if (!title) throw new Error('عنوان ثبت تکرارشونده را وارد کن.');
  db.prepare(`INSERT INTO recurring_rules (id,title,amount,type,category,day_of_month,next_due_at,active) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,amount=excluded.amount,type=excluded.type,category=excluded.category,
      day_of_month=excluded.day_of_month,next_due_at=excluded.next_due_at,active=excluded.active,updated_at=CURRENT_TIMESTAMP`)
    .run(id, title, amount, type, String(values.category || (type === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها')).slice(0, 80), day, values.nextDueAt || nextMonthlyDate(day), values.active === false ? 0 : 1);
  audit(values.id ? 'update' : 'create', 'recurring', id, { title, amount });
  return listRecurringRules().find((item) => item.id === id);
}

export function materializeRecurringRules(now = new Date()) {
  const due = db.prepare('SELECT * FROM recurring_rules WHERE active=1 AND next_due_at<=?').all(now.toISOString());
  let created = 0;
  for (const item of due) {
    let nextDue = item.next_due_at;
    db.exec('BEGIN IMMEDIATE');
    try {
      while (nextDue <= now.toISOString()) {
        const clientId = `recurring:${item.id}:${nextDue.slice(0, 10)}`;
        const existed = db.prepare('SELECT id FROM transactions WHERE client_id=?').get(clientId);
        insertTransactionRows({ transcript: item.title, transactions: [{
          clientId, amount: item.amount, type: item.type, category: item.category,
          rawText: item.title, note: 'ثبت خودکار دوره‌ای', source: 'text', occurredAt: nextDue,
        }] });
        if (!existed) created += 1;
        nextDue = nextMonthlyDate(item.day_of_month, new Date(nextDue));
      }
      db.prepare('UPDATE recurring_rules SET next_due_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(nextDue, item.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return created;
}

export function deleteRecurringRule(id) {
  const result = db.prepare('DELETE FROM recurring_rules WHERE id=?').run(id);
  if (result.changes) audit('delete', 'recurring', id);
  return result.changes > 0;
}

function invoiceRows({ status = '', documentType = '' } = {}) {
  const clauses = [];
  const params = [];
  if (['draft', 'sent', 'paid', 'cancelled'].includes(status)) { clauses.push('invoices.status=?'); params.push(status); }
  if (['sales', 'purchase'].includes(documentType)) { clauses.push('invoices.document_type=?'); params.push(documentType); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT invoices.id,invoices.number,invoices.contact_id AS contactId,invoices.customer_name AS customerName,
    invoices.document_type AS documentType,invoices.category,invoices.subtotal,invoices.discount,invoices.tax,invoices.total,
    invoices.tax_calculation AS taxCalculation,invoices.status,invoices.due_at AS dueAt,invoices.issued_at AS issuedAt,invoices.posted_at AS postedAt,invoices.note,
    invoices.created_at AS createdAt,contacts.name AS contactName,COALESCE(SUM(invoice_payments.amount),0) AS paidAmount
    FROM invoices LEFT JOIN contacts ON contacts.id=invoices.contact_id
    LEFT JOIN invoice_payments ON invoice_payments.invoice_id=invoices.id ${where}
    GROUP BY invoices.id ORDER BY invoices.created_at DESC`).all(...params).map((invoice) => {
      const balanceDue = Math.max(0, Number(invoice.total) - Number(invoice.paidAmount));
      const overdue = Boolean(invoice.dueAt && new Date(invoice.dueAt) < new Date() && balanceDue > 0 && invoice.status !== 'draft' && invoice.status !== 'cancelled');
      const displayStatus = invoice.status === 'cancelled' ? 'cancelled' : invoice.status === 'draft' ? 'draft' : balanceDue === 0 ? 'paid' : Number(invoice.paidAmount) > 0 ? 'partial' : overdue ? 'overdue' : 'open';
      return { ...invoice, balanceDue, overdue, displayStatus };
    });
}

export function listInvoices(filters = {}) {
  const items = invoiceRows(filters);
  const open = items.filter((item) => !['draft', 'cancelled', 'paid'].includes(item.displayStatus));
  return {
    items,
    summary: {
      receivable: open.filter((item) => item.documentType === 'sales').reduce((sum, item) => sum + item.balanceDue, 0),
      payable: open.filter((item) => item.documentType === 'purchase').reduce((sum, item) => sum + item.balanceDue, 0),
      overdueReceivable: open.filter((item) => item.documentType === 'sales' && item.overdue).reduce((sum, item) => sum + item.balanceDue, 0),
      overduePayable: open.filter((item) => item.documentType === 'purchase' && item.overdue).reduce((sum, item) => sum + item.balanceDue, 0),
    },
  };
}

export function getInvoice(id) {
  const invoice = invoiceRows().find((item) => item.id === id);
  if (!invoice) return null;
  invoice.items = db.prepare(`SELECT id,title,quantity,unit_price AS unitPrice,total,product_id AS productId,
    inventory_cost AS inventoryCost,tax_rate_id AS taxRateId,tax_rate_bps AS taxRateBps,tax_treatment AS taxTreatment,
    tax_base AS taxBase,tax_amount AS taxAmount FROM invoice_items WHERE invoice_id=? ORDER BY rowid`).all(id);
  invoice.payments = db.prepare(`SELECT invoice_payments.id,invoice_payments.amount,invoice_payments.account_id AS accountId,
    accounts.name AS accountName,invoice_payments.occurred_at AS occurredAt,invoice_payments.note,invoice_payments.created_at AS createdAt
    FROM invoice_payments JOIN accounts ON accounts.id=invoice_payments.account_id WHERE invoice_payments.invoice_id=?
    ORDER BY invoice_payments.occurred_at DESC`).all(id);
  return invoice;
}

export function createInvoice(values = {}) {
  const items = Array.isArray(values.items) ? values.items.filter((item) => String(item.title || '').trim()) : [];
  if (!items.length) throw new Error('حداقل یک ردیف برای سند لازم است.');
  const normalized = items.map((item) => {
    const quantity = Math.max(0.01, Number(item.quantity) || 1);
    const unitPrice = cleanAmount(item.unitPrice);
    const product = item.productId ? db.prepare('SELECT id,name,track_inventory AS trackInventory FROM products WHERE id=?').get(item.productId) : null;
    if (item.productId && (!product || !product.trackInventory)) throw Object.assign(new Error('کالای انتخاب‌شده پیدا نشد.'), { code: 'INVOICE_PRODUCT_MISSING', status: 404 });
    return { title: String(item.title).trim().slice(0, 120), quantity, unitPrice, total: Math.round(quantity * unitPrice), productId: product?.id || null, taxRateId: item.taxRateId || null, inventoryCost: 0 };
  });
  const subtotal = normalized.reduce((sum, item) => sum + item.total, 0);
  const discount = Math.min(subtotal, Math.max(0, Math.round(Number(values.discount) || 0)));
  const taxResult = calculateInvoiceTax(db, normalized, discount, values.tax);
  const tax = taxResult.tax;
  const total = subtotal - discount + tax;
  if (total <= 0) throw new Error('مبلغ نهایی سند باید بیشتر از صفر باشد.');
  const documentType = values.documentType === 'purchase' ? 'purchase' : 'sales';
  const taxedItems = taxResult.items.map((item) => {
    if (documentType === 'purchase' && item.productId) item.inventoryCost = item.taxBase;
    return item;
  });
  const category = String(values.category || (documentType === 'purchase' ? 'مواد و کالا' : 'فروش')).trim().slice(0, 80);
  const issueNow = values.issueNow === true || values.status === 'sent';
  const issuedAt = issueNow ? (values.issuedAt || new Date().toISOString()) : null;
  if (issuedAt) assertAccountingPeriodOpen(db, periodForDate(issuedAt, currentTimeZone()));
  const id = randomUUID();
  const year = new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: currentTimeZone(), year: 'numeric' }).format(new Date());
  const count = db.prepare('SELECT COUNT(*) AS count FROM invoices').get().count + 1;
  const number = `${documentType === 'purchase' ? 'KH' : 'FR'}-${year}-${String(count).padStart(4, '0')}`;
  const contact = values.contactId ? db.prepare('SELECT id,name FROM contacts WHERE id=?').get(values.contactId) : null;
  const counterpartyName = String(contact?.name || values.customerName || (documentType === 'purchase' ? 'تأمین‌کننده' : 'مشتری')).trim().slice(0, 100);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO invoices
      (id,number,contact_id,customer_name,document_type,category,subtotal,discount,tax,total,tax_calculation,status,due_at,issued_at,posted_at,note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, number, contact?.id || null, counterpartyName, documentType, category, subtotal, discount, tax, total, taxResult.taxCalculation, issueNow ? 'sent' : 'draft', values.dueAt || null, issuedAt, issueNow ? issuedAt : null, String(values.note || '').slice(0, 500));
    const insert = db.prepare(`INSERT INTO invoice_items
      (id,invoice_id,title,quantity,unit_price,total,product_id,inventory_cost,tax_rate_id,tax_rate_bps,tax_treatment,tax_base,tax_amount)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const item of taxedItems) insert.run(randomUUID(), id, item.title, item.quantity, item.unitPrice, item.total, item.productId, item.inventoryCost,
      item.taxRateId, item.taxRateBps, item.taxTreatment, item.taxBase, item.taxAmount);
    if (issueNow) {
      const posted = getInvoice(id);
      applyInvoiceInventory(db, posted, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
      postInvoiceJournal(db, posted, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    }
    audit('create', 'invoice', id, { number, total, documentType, issueNow });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getInvoice(id);
}

export function issueInvoice(id, { issuedAt } = {}) {
  const invoice = getInvoice(id);
  if (!invoice) return null;
  if (invoice.status !== 'draft') return invoice;
  const occurredAt = issuedAt || new Date().toISOString();
  assertAccountingPeriodOpen(db, periodForDate(occurredAt, currentTimeZone()));
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE invoices SET status='sent',issued_at=?,posted_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='draft'").run(occurredAt, occurredAt, id);
    const posted = getInvoice(id);
    applyInvoiceInventory(db, posted, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    postInvoiceJournal(db, posted, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    audit('issue', 'invoice', id, { issuedAt: occurredAt });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getInvoice(id);
}

export function recordInvoicePayment(id, { amount, occurredAt, account = 'cash', accountId, note = '' } = {}) {
  let invoice = getInvoice(id);
  if (!invoice || ['draft', 'cancelled'].includes(invoice.status)) return null;
  const paymentAmount = cleanAmount(amount == null ? invoice.balanceDue : amount);
  if (paymentAmount > invoice.balanceDue) throw Object.assign(new Error('مبلغ تسویه از ماندهٔ سند بیشتر است.'), { code: 'INVOICE_OVERPAYMENT', status: 409 });
  const paymentAt = occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(db, periodForDate(paymentAt, currentTimeZone()));
  const resolvedAccountId = resolveAccountId({ account, accountId });
  const paymentId = randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    const [transactionId] = insertTransactionRows({ transcript: `${invoice.documentType === 'purchase' ? 'پرداخت' : 'وصول'} ${invoice.number}`, transactions: [{
      clientId: `invoice-payment:${paymentId}`, amount: paymentAmount, type: invoice.documentType === 'purchase' ? 'expense' : 'income',
      category: invoice.documentType === 'purchase' ? 'پرداخت حساب پرداختنی' : 'وصول حساب دریافتنی',
      rawText: `${invoice.documentType === 'purchase' ? 'پرداخت' : 'وصول'} ${invoice.number}`, source: 'text', contactId: invoice.contactId,
      occurredAt: paymentAt, accountId: resolvedAccountId, note, status: 'allocated', journalManaged: true,
    }] });
    db.prepare(`INSERT INTO invoice_payments (id,invoice_id,amount,account_id,transaction_id,occurred_at,note,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(paymentId, id, paymentAmount, resolvedAccountId, transactionId, paymentAt, String(note || '').slice(0, 500), currentWorkspace()?.userId || null);
    postInvoicePaymentJournal(db, invoice, { id: paymentId, amount: paymentAmount, accountId: resolvedAccountId, occurredAt: paymentAt }, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    invoice = getInvoice(id);
    if (invoice.balanceDue === 0) db.prepare("UPDATE invoices SET status='paid',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    audit('payment', 'invoice', id, { paymentId, amount: paymentAmount, transactionId });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getInvoice(id);
}

export function markInvoicePaid(id, values = {}) {
  let invoice = getInvoice(id);
  if (!invoice || invoice.status === 'cancelled') return invoice;
  if (invoice.status === 'paid') return invoice;
  if (invoice.status === 'draft') invoice = issueInvoice(id, { issuedAt: values.occurredAt });
  return recordInvoicePayment(id, { ...values, amount: invoice.balanceDue });
}

export function deleteInvoice(id) {
  const invoice = getInvoice(id);
  if (!invoice || invoice.status === 'cancelled' || invoice.paidAmount > 0) return false;
  const occurredAt = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (invoice.postedAt) {
      reverseInvoiceInventory(db, invoice, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
      reverseInvoiceJournal(db, invoice, occurredAt, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    }
    const result = db.prepare("UPDATE invoices SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    if (!result.changes) throw new Error('سند قابل ابطال نیست.');
    audit('cancel', 'invoice', id, { reversal: Boolean(invoice.postedAt) });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return true;
}

export function importBankStatement(values = {}) {
  let importId;
  db.exec('BEGIN IMMEDIATE');
  try {
    const item = importBankStatementCore(db, values, { createdBy: currentWorkspace()?.userId });
    importId = item.id;
    audit('import', 'bank_statement', item.id, { fileName: values.fileName, accountId: values.accountId, rows: item.rowCount });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getReconciliationImport(importId);
}

export function listReconciliationImports() {
  return listReconciliationImportsCore(db);
}

export function getReconciliationImport(id) {
  const item = getReconciliationImportCore(db, id);
  if (!item) return null;
  item.lines = item.lines.map((line) => {
    const rule = findAutomationRule('bank_description', `${line.description} ${line.reference}`, line.direction);
    return { ...line, ruleSuggestion: rule ? { id: rule.id, pattern: rule.pattern, category: rule.category, accountId: rule.accountId } : null };
  });
  return item;
}

export function matchReconciliationLine(lineId, transactionId) {
  let importId;
  db.exec('BEGIN IMMEDIATE');
  try {
    const item = matchStatementLineCore(db, lineId, transactionId, { resolvedBy: currentWorkspace()?.userId });
    importId = item.id;
    audit('match', 'bank_statement_line', lineId, { transactionId });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getReconciliationImport(importId);
}

export function createTransactionFromStatementLine(lineId, values = {}) {
  const line = getStatementLine(db, lineId);
  if (!line || line.status !== 'unmatched' || line.import_status !== 'open') return null;
  const rule = findAutomationRule('bank_description', `${line.description} ${line.reference}`, line.direction);
  const category = String(values.category || rule?.category || (line.direction === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها')).trim().slice(0, 80);
  let importId;
  db.exec('BEGIN IMMEDIATE');
  try {
    const [transactionId] = insertTransactionRows({ transcript: line.description || 'ثبت از صورت‌حساب بانکی', transactions: [{
      clientId: `statement-line:${line.id}`, amount: line.amount, type: line.direction, category,
      rawText: line.description || `ردیف بانکی ${line.reference}`, note: `ثبت از تطبیق بانکی${line.reference ? ` · پیگیری ${line.reference}` : ''}`,
      source: 'text', accountId: line.account_id, occurredAt: line.occurred_at,
    }] });
    const item = matchStatementLineCore(db, lineId, transactionId, { resolvedBy: currentWorkspace()?.userId, note: 'ساخت تراکنش از ردیف بانک' });
    importId = item.id;
    audit('create-transaction', 'bank_statement_line', lineId, { transactionId, category });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getReconciliationImport(importId);
}

export function ignoreReconciliationLine(lineId, reason) {
  let importId;
  db.exec('BEGIN IMMEDIATE');
  try {
    const item = ignoreStatementLineCore(db, lineId, reason, { resolvedBy: currentWorkspace()?.userId });
    importId = item.id;
    audit('ignore', 'bank_statement_line', lineId, { reason });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getReconciliationImport(importId);
}

export function closeBankReconciliation(importId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const item = closeReconciliationCore(db, importId, currentWorkspace()?.userId);
    audit('close', 'bank_reconciliation', importId, { difference: item.difference });
    db.exec('COMMIT');
    return item;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function previewDayClosing(values = {}) {
  const day = String(values.day || localDay()).slice(0, 10);
  const bounds = dayBounds(day);
  const previous = db.prepare('SELECT day,counted_cash AS countedCash FROM daily_closings WHERE day<? ORDER BY day DESC LIMIT 1').get(day);
  const cashAccount = db.prepare("SELECT opening_balance AS openingBalance FROM accounts WHERE id='cash'").get();
  const movementStart = previous ? dayBounds(addLocalDays(previous.day, 1)).start : null;
  const totals = movementStart
    ? db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) AS net
      FROM transactions WHERE status!='deleted' AND account_id='cash' AND occurred_at>=? AND occurred_at<?`).get(movementStart, bounds.endExclusive)
    : db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) AS net
      FROM transactions WHERE status!='deleted' AND account_id='cash' AND occurred_at<?`).get(bounds.endExclusive);
  const expectedCash = Number(previous?.countedCash ?? cashAccount?.openingBalance ?? 0) + Number(totals.net || 0);
  return { day, expectedCash, previousDay: previous?.day || null, previousCountedCash: previous?.countedCash ?? null };
}

export function closeDay(values = {}) {
  const preview = previewDayClosing(values);
  const { day, expectedCash } = preview;
  const countedCash = Math.max(0, Math.round(Number(values.countedCash) || 0));
  const difference = countedCash - expectedCash;
  const id = randomUUID();
  db.prepare(`INSERT INTO daily_closings (id,day,expected_cash,counted_cash,difference,note) VALUES (?,?,?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET expected_cash=excluded.expected_cash,counted_cash=excluded.counted_cash,difference=excluded.difference,note=excluded.note`)
    .run(id, day, expectedCash, countedCash, difference, String(values.note || '').slice(0, 500));
  const result = db.prepare('SELECT id,day,expected_cash AS expectedCash,counted_cash AS countedCash,difference,note,created_at AS createdAt FROM daily_closings WHERE day=?').get(day);
  audit('close', 'day', result.id, result);
  return result;
}

export function listDailyClosings() {
  return db.prepare('SELECT id,day,expected_cash AS expectedCash,counted_cash AS countedCash,difference,note,created_at AS createdAt FROM daily_closings ORDER BY day DESC LIMIT 60').all();
}

function normalizeReceiptStatus(value, fallback = 'review') {
  return ['pending', 'review', 'ready', 'linked', 'failed', 'ignored'].includes(value) ? value : fallback;
}

function receiptSelect(where = '') {
  return `SELECT receipts.id,receipts.file_name AS fileName,receipts.mime_type AS mimeType,receipts.note,receipts.amount,receipts.type,
    receipts.category,receipts.merchant,receipts.occurred_at AS occurredAt,receipts.payment_method AS paymentMethod,receipts.reference,
    receipts.account_id AS accountId,accounts.name AS accountName,receipts.transaction_id AS transactionId,
    receipts.statement_line_id AS statementLineId,receipts.status,receipts.ocr_provider AS ocrProvider,receipts.ocr_model AS ocrModel,
    receipts.ocr_confidence AS ocrConfidence,receipts.field_confidence AS fieldConfidence,receipts.ocr_text AS ocrText,
    receipts.review_reasons AS reviewReasons,receipts.created_at AS createdAt,COALESCE(receipts.updated_at,receipts.created_at) AS updatedAt
    FROM receipts LEFT JOIN accounts ON accounts.id=receipts.account_id ${where}`;
}

function hydrateReceipt(row) {
  if (!row) return null;
  return { ...row, fieldConfidence: parseStoredJson(row.fieldConfidence, {}), reviewReasons: parseStoredJson(row.reviewReasons, []) };
}

function normalizedRuleText(value) {
  return normalizePersian(String(value || '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

function findAutomationRule(source, text, type = null) {
  const haystack = normalizedRuleText(text);
  if (!haystack) return null;
  return listAutomationRules(source).find((rule) => (!rule.type || !type || rule.type === type) && haystack.includes(normalizedRuleText(rule.pattern))) || null;
}

export function saveReceipt({
  buffer, fileName, mimeType, note = '', amount = null, type = null, category = null, merchant = '', occurredAt = null,
  paymentMethod = '', reference = '', accountId = null, status = 'review', ocrProvider = '', ocrModel = '', ocrConfidence = 0,
  fieldConfidence = {}, ocrText = '', reviewReasons = [],
}) {
  if (!buffer?.length) throw new Error('تصویر رسید خالی است.');
  const id = randomUUID();
  const normalizedAmount = amount ? cleanAmount(amount) : null;
  const normalizedType = ['income', 'expense'].includes(type) ? type : null;
  const rule = findAutomationRule('merchant', merchant, normalizedType);
  const resolvedCategory = String(category || rule?.category || '').trim().slice(0, 80) || null;
  const resolvedAccountId = accountId || rule?.accountId || null;
  if (resolvedAccountId && !db.prepare('SELECT 1 FROM accounts WHERE id=? AND active=1').get(resolvedAccountId)) throw new Error('حساب پیشنهادی رسید معتبر نیست.');
  db.prepare(`INSERT INTO receipts
    (id,file_name,mime_type,image_data,note,amount,type,category,merchant,occurred_at,payment_method,reference,account_id,status,
      ocr_provider,ocr_model,ocr_confidence,field_confidence,ocr_text,review_reasons,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .run(id, String(fileName || 'receipt').slice(0, 160), mimeType, buffer, String(note || '').slice(0, 800), normalizedAmount,
      normalizedType, resolvedCategory, String(merchant || '').trim().slice(0, 160), occurredAt || null,
      String(paymentMethod || '').trim().slice(0, 80), String(reference || '').trim().slice(0, 120), resolvedAccountId,
      normalizeReceiptStatus(status), String(ocrProvider || '').slice(0, 40), String(ocrModel || '').slice(0, 80),
      Math.max(0, Math.min(1, Number(ocrConfidence) || 0)), jsonText(fieldConfidence, {}), String(ocrText || '').slice(0, 4000), jsonText(reviewReasons, []));
  audit('create', 'receipt', id, { fileName, amount: normalizedAmount, provider: ocrProvider, status });
  return getReceipt(id);
}

export function getReceipt(id) {
  return hydrateReceipt(db.prepare(`${receiptSelect('WHERE receipts.id=?')}`).get(id));
}

export function listReceipts({ status = '' } = {}) {
  const validStatus = normalizeReceiptStatus(status, '');
  const rows = validStatus
    ? db.prepare(`${receiptSelect('WHERE receipts.status=?')} ORDER BY receipts.created_at DESC LIMIT 100`).all(validStatus)
    : db.prepare(`${receiptSelect()} ORDER BY CASE receipts.status WHEN 'failed' THEN 0 WHEN 'review' THEN 1 WHEN 'ready' THEN 2 ELSE 3 END,receipts.created_at DESC LIMIT 100`).all();
  return rows.map(hydrateReceipt);
}

export function updateReceipt(id, values = {}) {
  const current = getReceipt(id);
  if (!current || current.status === 'linked') return null;
  const amount = values.amount == null || values.amount === '' ? current.amount : cleanAmount(values.amount);
  const type = ['income', 'expense'].includes(values.type) ? values.type : current.type;
  const category = String(values.category ?? current.category ?? '').trim().slice(0, 80) || null;
  const accountId = String(values.accountId ?? current.accountId ?? '').trim() || null;
  if (accountId && !db.prepare('SELECT 1 FROM accounts WHERE id=? AND active=1').get(accountId)) throw new Error('حساب انتخاب‌شده معتبر نیست.');
  const occurredAt = values.occurredAt ? new Date(values.occurredAt).toISOString() : current.occurredAt;
  const ready = Boolean(amount && type && category && accountId);
  const status = normalizeReceiptStatus(values.status, ready ? 'ready' : 'review');
  db.prepare(`UPDATE receipts SET amount=?,type=?,category=?,merchant=?,occurred_at=?,payment_method=?,reference=?,account_id=?,note=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(amount, type, category, String(values.merchant ?? current.merchant ?? '').trim().slice(0, 160), occurredAt,
      String(values.paymentMethod ?? current.paymentMethod ?? '').trim().slice(0, 80), String(values.reference ?? current.reference ?? '').trim().slice(0, 120),
      accountId, String(values.note ?? current.note ?? '').trim().slice(0, 800), status, id);
  audit('update', 'receipt', id, { amount, type, category, accountId, status });
  return getReceipt(id);
}

function dateDistance(left, right) {
  if (!left || !right) return null;
  return Math.abs(new Date(left).getTime() - new Date(right).getTime()) / 86_400_000;
}

export function receiptCandidates(id) {
  const receipt = getReceipt(id);
  if (!receipt || !receipt.amount || !receipt.type) return { transactions: [], statementLines: [] };
  const occurredAt = receipt.occurredAt || receipt.createdAt;
  const transactions = db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,transactions.raw_text AS rawText,
    transactions.occurred_at AS occurredAt,transactions.account_id AS accountId,accounts.name AS accountName
    FROM transactions LEFT JOIN accounts ON accounts.id=transactions.account_id
    WHERE transactions.status!='deleted' AND transactions.amount=? AND transactions.type=?
      AND ABS(julianday(transactions.occurred_at)-julianday(?))<=7
    ORDER BY ABS(julianday(transactions.occurred_at)-julianday(?)) LIMIT 5`).all(receipt.amount, receipt.type, occurredAt, occurredAt)
    .map((item) => {
      const distance = dateDistance(item.occurredAt, occurredAt);
      const merchantMatch = receipt.merchant && normalizedRuleText(item.rawText).includes(normalizedRuleText(receipt.merchant));
      const score = Math.min(100, Math.round(70 + Math.max(0, 20 - (distance || 0) * 5) + (merchantMatch ? 10 : 0)));
      return { ...item, score, reasons: ['مبلغ و نوع برابر است.', distance < 1 ? 'تاریخ یکسان است.' : `فاصلهٔ تاریخ ${Math.round(distance)} روز است.`, ...(merchantMatch ? ['نام فروشنده در شرح تراکنش دیده شد.'] : [])] };
    });
  const statementLines = db.prepare(`SELECT bank_statement_lines.id,bank_statement_lines.amount,bank_statement_lines.direction AS type,
    bank_statement_lines.description,bank_statement_lines.reference,bank_statement_lines.occurred_at AS occurredAt,
    bank_statement_imports.account_id AS accountId,accounts.name AS accountName
    FROM bank_statement_lines JOIN bank_statement_imports ON bank_statement_imports.id=bank_statement_lines.import_id
    JOIN accounts ON accounts.id=bank_statement_imports.account_id
    WHERE bank_statement_lines.status='unmatched' AND bank_statement_imports.status='open'
      AND bank_statement_lines.amount=? AND bank_statement_lines.direction=?
      AND ABS(julianday(bank_statement_lines.occurred_at)-julianday(?))<=7
    ORDER BY ABS(julianday(bank_statement_lines.occurred_at)-julianday(?)) LIMIT 5`).all(receipt.amount, receipt.type, occurredAt, occurredAt)
    .map((item) => {
      const distance = dateDistance(item.occurredAt, occurredAt);
      const merchantMatch = receipt.merchant && normalizedRuleText(`${item.description} ${item.reference}`).includes(normalizedRuleText(receipt.merchant));
      const score = Math.min(100, Math.round(70 + Math.max(0, 20 - (distance || 0) * 5) + (merchantMatch ? 10 : 0)));
      return { ...item, score, reasons: ['مبلغ و نوع برابر است.', distance < 1 ? 'تاریخ یکسان است.' : `فاصلهٔ تاریخ ${Math.round(distance)} روز است.`, ...(merchantMatch ? ['نام فروشنده در شرح بانک دیده شد.'] : [])] };
    });
  return { transactions, statementLines };
}

export function confirmReceipt(id, values = {}) {
  let receipt = updateReceipt(id, values);
  if (!receipt) return null;
  if (!receipt.amount || !receipt.type || !receipt.category || !receipt.accountId) throw Object.assign(new Error('مبلغ، نوع، دسته و حساب را پیش از ثبت کامل کن.'), { code: 'RECEIPT_INCOMPLETE', status: 409 });
  db.exec('BEGIN IMMEDIATE');
  try {
    let transactionId = String(values.transactionId || '').trim();
    const statementLineId = String(values.statementLineId || '').trim();
    if (transactionId) {
      const transaction = db.prepare("SELECT id,amount,type,account_id AS accountId FROM transactions WHERE id=? AND status!='deleted'").get(transactionId);
      if (!transaction || transaction.amount !== receipt.amount || transaction.type !== receipt.type || transaction.accountId !== receipt.accountId) throw Object.assign(new Error('تراکنش انتخاب‌شده با مبلغ، نوع و حساب رسید برابر نیست.'), { code: 'RECEIPT_MATCH_MISMATCH', status: 409 });
    } else {
      const [createdId] = insertTransactionRows({ transcript: receipt.ocrText || receipt.note || receipt.merchant || 'ثبت از رسید', transactions: [{
        clientId: `receipt:${receipt.id}`, amount: receipt.amount, type: receipt.type, category: receipt.category,
        rawText: receipt.ocrText || receipt.note || receipt.merchant || 'ثبت از رسید', source: 'text', accountId: receipt.accountId,
        occurredAt: receipt.occurredAt || receipt.createdAt, confidence: receipt.ocrConfidence || 1,
        note: `ثبت از رسید ${receipt.fileName}${receipt.reference ? ` · پیگیری ${receipt.reference}` : ''}`,
      }] });
      transactionId = createdId;
    }
    if (statementLineId) matchStatementLineCore(db, statementLineId, transactionId, { resolvedBy: currentWorkspace()?.userId, note: 'تطبیق با رسید تأییدشده' });
    db.prepare(`UPDATE receipts SET transaction_id=?,statement_line_id=?,status='linked',updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(transactionId, statementLineId || null, id);
    audit('confirm', 'receipt', id, { transactionId, statementLineId: statementLineId || null });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getReceipt(id);
}

export function listAutomationRules(source = '') {
  const params = source ? [source] : [];
  return db.prepare(`SELECT automation_rules.id,automation_rules.source,automation_rules.pattern,automation_rules.type,
    automation_rules.category,automation_rules.account_id AS accountId,accounts.name AS accountName,
    automation_rules.created_at AS createdAt,automation_rules.updated_at AS updatedAt
    FROM automation_rules LEFT JOIN accounts ON accounts.id=automation_rules.account_id
    ${source ? 'WHERE automation_rules.source=?' : ''} ORDER BY length(automation_rules.pattern) DESC,automation_rules.updated_at DESC`).all(...params);
}

export function saveAutomationRule(values = {}) {
  const source = ['merchant', 'bank_description'].includes(values.source) ? values.source : null;
  const pattern = normalizedRuleText(values.pattern).slice(0, 120);
  const type = ['income', 'expense'].includes(values.type) ? values.type : null;
  const category = String(values.category || '').trim().slice(0, 80);
  const accountId = String(values.accountId || '').trim() || null;
  if (!source || pattern.length < 2 || !category) throw new Error('منبع، عبارت و دستهٔ قانون را کامل کن.');
  if (accountId && !db.prepare('SELECT 1 FROM accounts WHERE id=? AND active=1').get(accountId)) throw new Error('حساب قانون معتبر نیست.');
  const id = values.id || randomUUID();
  db.prepare(`INSERT INTO automation_rules (id,source,pattern,type,category,account_id,created_by) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(source,pattern) DO UPDATE SET type=excluded.type,category=excluded.category,account_id=excluded.account_id,updated_at=CURRENT_TIMESTAMP`)
    .run(id, source, pattern, type, category, accountId, currentWorkspace()?.userId || null);
  audit(values.id ? 'update' : 'create', 'automation_rule', id, { source, pattern, type, category, accountId });
  return listAutomationRules(source).find((item) => item.pattern === pattern);
}

export function deleteAutomationRule(id) {
  const result = db.prepare('DELETE FROM automation_rules WHERE id=?').run(id);
  if (result.changes) audit('delete', 'automation_rule', id);
  return result.changes > 0;
}

export function receiptImage(id) {
  const row = db.prepare('SELECT mime_type AS mimeType,image_data AS imageData FROM receipts WHERE id=?').get(id);
  return row ? { ...row, imageData: Buffer.from(row.imageData) } : null;
}

export function deleteReceipt(id) {
  const result = db.prepare('DELETE FROM receipts WHERE id=?').run(id);
  if (result.changes) audit('delete', 'receipt', id);
  return result.changes > 0;
}

export function listProducts() {
  return inventoryOverviewCore(db).products;
}

export function saveProduct(values = {}) {
  const name = String(values.name || '').trim().slice(0, 100);
  if (!name) throw new Error('نام کالا را وارد کن.');
  const id = values.id || randomUUID();
  const openingStock = Math.max(0, Number(values.stock) || 0);
  const buyPrice = Math.max(0, Math.round(Number(values.buyPrice) || 0));
  db.exec('BEGIN IMMEDIATE');
  try {
    if (values.id) {
      const result = db.prepare(`UPDATE products SET name=?,unit=?,low_threshold=?,buy_price=?,sale_price=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(name, String(values.unit || 'عدد').slice(0, 30), Math.max(0, Number(values.lowThreshold) || 0), buyPrice, Math.max(0, Math.round(Number(values.salePrice) || 0)), id);
      if (!result.changes) throw Object.assign(new Error('کالا پیدا نشد.'), { status: 404 });
    } else {
      db.prepare(`INSERT INTO products (id,name,stock,unit,low_threshold,buy_price,sale_price,average_cost,inventory_value)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, name, 0, String(values.unit || 'عدد').slice(0, 30), Math.max(0, Number(values.lowThreshold) || 0), buyPrice,
        Math.max(0, Math.round(Number(values.salePrice) || 0)), 0, 0);
      if (openingStock > 0) recordInventoryMovement(db, id, {
        quantity: openingStock, unitCost: buyPrice, movementType: 'opening', sourceType: 'product_opening', sourceId: id,
        note: 'موجودی ابتدای تعریف کالا',
      }, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    }
    audit(values.id ? 'update' : 'create', 'product', id, { name, openingStock: values.id ? undefined : openingStock });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return listProducts().find((item) => item.id === id);
}

export function adjustStock(id, values = {}) {
  const quantity = Number(values.quantity);
  if (!Number.isFinite(quantity) || quantity === 0) throw new Error('تغییر موجودی معتبر نیست.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = recordInventoryMovement(db, id, {
      quantity, unitCost: values.unitCost, movementType: 'adjustment', sourceType: 'manual',
      note: String(values.note || (quantity > 0 ? 'افزایش دستی موجودی' : 'کاهش دستی موجودی')).slice(0, 300),
    }, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    audit('adjust', 'product', id, { quantity, valueDelta: result.movement.valueDelta });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return listProducts().find((item) => item.id === id);
}

export function inventoryOverview() {
  return inventoryOverviewCore(db);
}

export function listTaxRates() {
  return listTaxRatesCore(db);
}

export function saveTaxRate(values = {}) {
  const item = saveTaxRateCore(db, values);
  audit(values.id ? 'update' : 'create', 'tax_rate', item.id, { name: item.name, rate: item.rate, treatment: item.treatment, active: item.active });
  return item;
}

export function taxReport(filters = {}) {
  return taxReportCore(db, filters);
}

function financialTransactionRows(window, filters = {}) {
  const clauses = ["transactions.status!='deleted'", 'transactions.occurred_at>=?', 'transactions.occurred_at<?'];
  const values = [window.from, window.to];
  if (filters.type) { clauses.push('transactions.type=?'); values.push(filters.type); }
  if (filters.category) { clauses.push('transactions.category=?'); values.push(filters.category); }
  if (filters.contactId) { clauses.push('transactions.contact_id=?'); values.push(filters.contactId); }
  return db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,
    transactions.raw_text AS rawText,transactions.occurred_at AS occurredAt,transactions.account_id AS accountId,
    accounts.name AS accountName,transactions.contact_id AS contactId,contacts.name AS contactName
    FROM transactions LEFT JOIN accounts ON accounts.id=transactions.account_id
    LEFT JOIN contacts ON contacts.id=transactions.contact_id
    WHERE ${clauses.join(' AND ')} ORDER BY transactions.occurred_at DESC`).all(...values);
}

function accountSources(accounts) {
  return accounts.filter((item) => item.active && ['cash', 'bank', 'wallet'].includes(item.kind)).map((item) => ({
    kind: 'account', id: item.id, label: item.name, amount: Number(item.balance || 0), openingBalance: Number(item.openingBalance || 0), createdAt: item.createdAt || null,
  }));
}

function money(value) {
  return new Intl.NumberFormat('fa-IR').format(Math.round(Number(value) || 0));
}

function sourceScope(sources, now, label = 'از اولین سند باز تا اکنون') {
  const dated = sources.map((item) => item.occurredAt || item.dueAt || item.createdAt).filter(Boolean).sort();
  return { from: dated[0] || null, to: now.toISOString(), days: null, label, basis: 'cash', basisLabel: 'مبنای دریافت و پرداخت', unit: FINANCIAL_UNIT };
}

function financialAnswer({ question, intent, answer, result = null, scope = null, sources = [], calculation = '', now = new Date(), disclaimer = FINANCIAL_DISCLAIMER }) {
  return {
    question, intent, answer, result, scope, sources, evidence: sources,
    provenance: { sourceCount: sources.length, calculation, complete: true },
    unit: result ? FINANCIAL_UNIT : null,
    disclaimer, generatedAt: now.toISOString(), deterministic: true,
  };
}

function snoozedFinancialAlertIds(now = new Date()) {
  const userId = currentWorkspace()?.userId || null;
  const rows = userId
    ? db.prepare("SELECT DISTINCT alert_id AS alertId FROM financial_alert_feedback WHERE action='snooze' AND snoozed_until>? AND created_by=?").all(now.toISOString(), userId)
    : db.prepare("SELECT DISTINCT alert_id AS alertId FROM financial_alert_feedback WHERE action='snooze' AND snoozed_until>? AND created_by IS NULL").all(now.toISOString());
  return new Set(rows.map((item) => item.alertId));
}

export function snoozeFinancialAlert(alertId, { hours = 24 } = {}) {
  const normalizedId = String(alertId || '').trim().slice(0, 120);
  if (!/^[a-z0-9-]+$/i.test(normalizedId)) throw new Error('شناسهٔ هشدار معتبر نیست.');
  const safeHours = Math.min(168, Math.max(1, Math.round(Number(hours) || 24)));
  const snoozedUntil = new Date(Date.now() + safeHours * 60 * 60 * 1000).toISOString();
  const id = randomUUID();
  db.prepare("INSERT INTO financial_alert_feedback (id,alert_id,action,snoozed_until,created_by) VALUES (?,?, 'snooze',?,?)")
    .run(id, normalizedId, snoozedUntil, currentWorkspace()?.userId || null);
  audit('snooze', 'financial_alert', normalizedId, { hours: safeHours, snoozedUntil });
  return { id, alertId: normalizedId, action: 'snooze', snoozedUntil };
}

export function financialOverview(now = new Date()) {
  const settings = getSettings();
  const accounts = listAccounts();
  const liquidAccounts = accounts.filter((item) => item.active && ['cash', 'bank', 'wallet'].includes(item.kind));
  const cash = liquidAccounts.reduce((sum, item) => sum + Number(item.balance || 0), 0);
  const monthWindow = exactWindow(now, 30);
  const monthScope = financialScope(monthWindow, '۳۰ روز اخیر');
  const monthRows = financialTransactionRows(monthWindow);
  const month = summarize(monthRows);
  const expenseRows = monthRows.filter((item) => item.type === 'expense');
  const invoices = listInvoices().items;
  const openInvoices = invoices.filter((item) => !['draft', 'cancelled', 'paid'].includes(item.displayStatus) && Number(item.balanceDue) > 0);
  const openObligations = listObligations({ status: 'open' });
  const receivable = openObligations.filter((item) => item.direction === 'receivable').reduce((sum, item) => sum + Number(item.amount), 0)
    + openInvoices.filter((item) => item.documentType === 'sales').reduce((sum, item) => sum + Number(item.balanceDue), 0);
  const payable = openObligations.filter((item) => item.direction === 'payable').reduce((sum, item) => sum + Number(item.amount), 0)
    + openInvoices.filter((item) => item.documentType === 'purchase').reduce((sum, item) => sum + Number(item.balanceDue), 0);
  const overdueObligations = openObligations.filter((item) => item.dueAt && new Date(item.dueAt) < now);
  const overdueInvoices = openInvoices.filter((item) => item.dueAt && new Date(item.dueAt) < now);
  const overdueItems = [...overdueObligations.map(obligationSource), ...overdueInvoices.map(invoiceSource)];
  const overdueReceivables = overdueItems.filter((item) => item.direction === 'receivable');
  const runway = buildRunway({ cash, expenseTotal: month.expense, lookbackDays: 30, scope: monthScope, sources: expenseRows.map(transactionSource) });
  const alerts = [];

  if (overdueReceivables.length) {
    const total = overdueReceivables.reduce((sum, item) => sum + item.amount, 0);
    alerts.push({
      id: 'overdue-receivable', type: 'overdue-receivable', level: 'danger', priority: 100,
      title: `${overdueReceivables.length} طلب سررسیدشده داری`, detail: `${money(total)} تومان وصول عقب‌افتاده است.`,
      value: total, unit: FINANCIAL_UNIT, scope: sourceScope(overdueReceivables, now), sources: overdueReceivables,
      action: { screen: 'ledger', tab: 'obligations', label: 'پیگیری طلب‌ها' },
    });
  } else if (overdueItems.length) {
    const total = overdueItems.reduce((sum, item) => sum + item.amount, 0);
    alerts.push({
      id: 'overdue-payable', type: 'overdue-payable', level: 'danger', priority: 95,
      title: `${overdueItems.length} بدهی سررسیدشده داری`, detail: `${money(total)} تومان پرداخت عقب‌افتاده است.`,
      value: total, unit: FINANCIAL_UNIT, scope: sourceScope(overdueItems, now), sources: overdueItems,
      action: { screen: 'ledger', tab: 'obligations', label: 'بررسی بدهی‌ها' },
    });
  }

  const historyWindow = exactWindow(now, 90);
  const historyRows = financialTransactionRows(historyWindow);
  const anomaly = findUnusualTransaction(historyRows, settings.alertSensitivity, exactWindow(now, 7).from);
  if (anomaly) {
    const sources = [transactionSource(anomaly.current), ...anomaly.baseline.map((item) => transactionSource(item, 'baseline'))];
    alerts.push({
      id: `unusual-${anomaly.current.id}`, type: 'unusual-amount', level: 'warning', priority: 80,
      title: 'یک مبلغ غیرعادی ثبت شده',
      detail: `${money(anomaly.current.amount)} تومان در «${anomaly.current.category}»؛ ${anomaly.ratio} برابر میانهٔ ${anomaly.baseline.length} ثبت مشابه.`,
      value: Number(anomaly.current.amount), unit: FINANCIAL_UNIT, scope: financialScope(historyWindow, 'خط مبنای ۹۰ روزه'), sources,
      action: { screen: 'ledger', tab: 'transactions', entityId: anomaly.current.id, label: 'بازبینی ثبت' },
    });
  }

  const currentWeekWindow = exactWindow(now, 7);
  const previousWeekWindow = exactWindow(now, 7, 7);
  const currentWeekExpenses = financialTransactionRows(currentWeekWindow, { type: 'expense' });
  const previousWeekExpenses = financialTransactionRows(previousWeekWindow, { type: 'expense' });
  const growth = detectExpenseGrowth(currentWeekExpenses, previousWeekExpenses, settings.alertSensitivity);
  if (growth) {
    const sources = [...currentWeekExpenses.map(transactionSource), ...previousWeekExpenses.map((item) => transactionSource(item, 'previous'))];
    alerts.push({
      id: 'expense-growth', type: 'expense-growth', level: 'warning', priority: 70,
      title: `هزینهٔ هفت روز اخیر ${growth.percent}٪ رشد کرده`, detail: `${money(growth.delta)} تومان بیشتر از هفت روز قبل خرج شده است.`,
      value: growth.current, unit: FINANCIAL_UNIT,
      scope: { ...financialScope(currentWeekWindow, 'هفت روز اخیر در مقایسه با هفت روز قبل'), comparisonFrom: previousWeekWindow.from, comparisonTo: previousWeekWindow.to },
      sources, action: { screen: 'report', label: 'دیدن گزارش', target: 'expenses' },
    });
  }

  if (cash < Number(settings.lowBalanceThreshold || 2_000_000)) {
    alerts.push({
      id: 'low-cash', type: 'low-cash', level: 'warning', priority: 60,
      title: 'ماندهٔ نقدی به حد هشدار رسیده', detail: `${money(cash)} تومان مانده در برابر حد ${money(settings.lowBalanceThreshold || 2_000_000)} تومان.`,
      value: cash, unit: FINANCIAL_UNIT, scope: sourceScope(accountSources(liquidAccounts), now, 'ماندهٔ حساب‌های نقدی تا اکنون'), sources: accountSources(liquidAccounts),
      action: { screen: 'report', label: 'بررسی نقدینگی', target: 'runway' },
    });
  }

  const baseRunway = runway.scenarios.find((item) => item.id === 'base')?.days ?? null;
  if (baseRunway != null && baseRunway <= 14) {
    alerts.push({
      id: 'short-runway', type: 'short-runway', level: baseRunway <= 7 ? 'danger' : 'warning', priority: 65,
      title: `دوام نقدینگی پایه حدود ${baseRunway} روز است`, detail: 'این سناریو درآمد آینده را فرض نمی‌کند و از میانگین هزینهٔ ۳۰ روز اخیر ساخته شده است.',
      value: baseRunway, unit: 'روز', scope: monthScope, sources: runway.sources,
      action: { screen: 'report', label: 'دیدن سناریوها', target: 'runway' },
    });
  }

  const snoozedIds = snoozedFinancialAlertIds(now);
  const visibleAlerts = alerts.filter((item) => !snoozedIds.has(item.id)).sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0));
  return {
    cash, receivable, payable, overdue: overdueItems.length,
    cashBasis: true, basisLabel: 'مبنای دریافت و پرداخت', unit: FINANCIAL_UNIT, accounts,
    runway, runwayDays: baseRunway, month, monthScope, alerts: visibleAlerts, priorityAlert: prioritizeAlerts(visibleAlerts),
    alertSensitivity: settings.alertSensitivity || 'balanced', disclaimer: FINANCIAL_DISCLAIMER,
  };
}

export function answerFinancialQuestion(question = '', { now = new Date() } = {}) {
  const original = String(question || '').trim().slice(0, 500);
  const normalized = normalizePersian(original).toLowerCase();
  if (isGuardedAdviceQuestion(normalized)) {
    return financialAnswer({
      question: original, intent: 'guarded-advice',
      answer: 'می‌توانم ارقام ثبت‌شده را با منبع نشان بدهم، اما دربارهٔ مالیات یا موضوع حقوقی حکم قطعی نمی‌دهم. برای تصمیم رسمی، گزارش را با حسابدار یا مشاور حقوقی بررسی کن.',
      now, disclaimer: 'این پاسخ توصیهٔ مالیاتی یا حقوقی نیست و هیچ عددی خارج از دفتر محاسبه نشده است.',
    });
  }

  const currentWindow = exactWindow(now, 30);
  const scope = financialScope(currentWindow, '۳۰ روز اخیر');
  const rows = financialTransactionRows(currentWindow);
  const overview = financialOverview(now);
  const contacts = listContacts();
  const matchedContact = contacts.find((item) => normalized.includes(normalizePersian(item.name).toLowerCase()));
  const categories = getCategories().sort((left, right) => right.name.length - left.name.length);
  const matchedCategory = categories.find((item) => normalized.includes(normalizePersian(item.name).toLowerCase()));

  if (/آخرین.*(پرداخت|خرج|هزینه)|آخرین پرداخت/.test(normalized)) {
    const item = db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,
      transactions.raw_text AS rawText,transactions.occurred_at AS occurredAt,accounts.name AS accountName
      FROM transactions LEFT JOIN accounts ON accounts.id=transactions.account_id
      WHERE transactions.status!='deleted' AND transactions.type='expense' ORDER BY transactions.occurred_at DESC LIMIT 1`).get();
    const sources = item ? [transactionSource(item)] : [];
    const first = db.prepare("SELECT MIN(occurred_at) AS occurredAt FROM transactions WHERE status!='deleted'").get();
    const range = { ...sourceScope(sources, now, 'از اولین ثبت تا اکنون'), from: first.occurredAt || null };
    return financialAnswer({ question: original, intent: 'latest-payment',
      answer: item ? `آخرین پرداخت ${money(item.amount)} تومان برای «${item.category}» بوده است.` : 'هنوز پرداختی در دفتر ثبت نشده است.',
      result: { value: Number(item?.amount || 0), label: 'آخرین پرداخت', unit: FINANCIAL_UNIT }, scope: range, sources,
      calculation: 'آخرین تراکنش هزینه بر اساس زمان ثبت', now });
  }

  if (matchedContact && /مانده|طلب|بده|حساب/.test(normalized)) {
    const obligations = listObligations({ status: 'open' }).filter((item) => item.contactId === matchedContact.id);
    const invoices = listInvoices().items.filter((item) => item.contactId === matchedContact.id && !['draft', 'cancelled', 'paid'].includes(item.displayStatus) && item.balanceDue > 0);
    const sources = [...obligations.map(obligationSource), ...invoices.map(invoiceSource)];
    const value = sources.reduce((sum, item) => sum + (item.direction === 'receivable' ? item.amount : -item.amount), 0);
    const direction = value > 0 ? `${money(value)} تومان از او طلب داری` : value < 0 ? `${money(Math.abs(value))} تومان به او بدهکاری` : 'ماندهٔ بازی با او ثبت نشده است';
    return financialAnswer({ question: original, intent: 'contact-balance', answer: `ماندهٔ «${matchedContact.name}»: ${direction}.`,
      result: { value, label: `ماندهٔ ${matchedContact.name}`, unit: FINANCIAL_UNIT }, scope: sourceScope(sources, now), sources,
      calculation: 'طلب‌های باز منهای بدهی‌های باز شخص؛ شامل ماندهٔ فاکتورهای صادرشده', now });
  }

  if (matchedCategory) {
    const selected = rows.filter((item) => item.category === matchedCategory.name && item.type === matchedCategory.type);
    const value = selected.reduce((sum, item) => sum + Number(item.amount), 0);
    const sources = selected.map(transactionSource);
    return financialAnswer({ question: original, intent: 'category-total',
      answer: `جمع «${matchedCategory.name}» در ۳۰ روز اخیر ${money(value)} تومان از ${sources.length} ثبت است.`,
      result: { value, label: matchedCategory.name, unit: FINANCIAL_UNIT, type: matchedCategory.type }, scope, sources,
      calculation: `جمع مبلغ تراکنش‌های دستهٔ ${matchedCategory.name}`, now });
  }

  if (/مقایسه|بازه قبل|ماه قبل|نسبت/.test(normalized)) {
    const previousWindow = exactWindow(now, 30, 30);
    const previousRows = financialTransactionRows(previousWindow);
    const type = /هزینه|خرج/.test(normalized) ? 'expense' : /درآمد|فروش/.test(normalized) ? 'income' : '';
    const sum = (items) => items.filter((item) => !type || item.type === type).reduce((total, item) => total + (type ? Number(item.amount) : item.type === 'income' ? Number(item.amount) : -Number(item.amount)), 0);
    const current = sum(rows);
    const previous = sum(previousRows);
    const changePercent = previous !== 0 ? Math.round(((current - previous) / Math.abs(previous)) * 100) : null;
    const label = type === 'expense' ? 'هزینه' : type === 'income' ? 'درآمد' : 'خالص دریافت و پرداخت';
    const sources = [...rows.filter((item) => !type || item.type === type).map(transactionSource), ...previousRows.filter((item) => !type || item.type === type).map((item) => transactionSource(item, 'previous'))];
    const comparisonText = changePercent == null ? 'برای درصد تغییر، بازهٔ قبل دادهٔ کافی ندارد' : `${Math.abs(changePercent)}٪ ${changePercent >= 0 ? 'بیشتر' : 'کمتر'} از بازهٔ قبل`;
    return financialAnswer({ question: original, intent: 'range-comparison', answer: `${label} ۳۰ روز اخیر ${money(current)} تومان است؛ ${comparisonText}.`,
      result: { value: current, previousValue: previous, changePercent, label, unit: FINANCIAL_UNIT },
      scope: { ...scope, comparisonFrom: previousWindow.from, comparisonTo: previousWindow.to }, sources,
      calculation: `جمع ${label} در دو بازهٔ ۳۰ روزهٔ پشت‌سرهم`, now });
  }

  if (/بده|طلب|گرفتن|دادن/.test(normalized)) {
    const obligations = listObligations({ status: 'open' });
    const invoices = listInvoices().items.filter((item) => !['draft', 'cancelled', 'paid'].includes(item.displayStatus) && item.balanceDue > 0);
    const sources = [...obligations.map(obligationSource), ...invoices.map(invoiceSource)];
    return financialAnswer({ question: original, intent: 'open-balances',
      answer: `در حال حاضر ${money(overview.receivable)} تومان طلب باز و ${money(overview.payable)} تومان بدهی باز داری.`,
      result: { value: overview.receivable - overview.payable, receivable: overview.receivable, payable: overview.payable, label: 'خالص مطالبات باز', unit: FINANCIAL_UNIT },
      scope: sourceScope(sources, now), sources, calculation: 'جمع طلب‌های باز و فاکتورهای فروش منهای بدهی‌های باز و فاکتورهای خرید', now });
  }

  if (/هزینه|خرج/.test(normalized)) {
    const expenseRows = rows.filter((item) => item.type === 'expense');
    const value = expenseRows.reduce((sum, item) => sum + Number(item.amount), 0);
    const byCategory = new Map();
    for (const item of expenseRows) byCategory.set(item.category, (byCategory.get(item.category) || 0) + Number(item.amount));
    const top = [...byCategory.entries()].sort((left, right) => right[1] - left[1])[0];
    const answer = /بیشترین/.test(normalized) && top ? `بیشترین هزینهٔ ۳۰ روز اخیر «${top[0]}» با ${money(top[1])} تومان بوده است.` : `جمع هزینهٔ ۳۰ روز اخیر ${money(value)} تومان از ${expenseRows.length} ثبت است.`;
    const answerSources = /بیشترین/.test(normalized) && top ? expenseRows.filter((item) => item.category === top[0]) : expenseRows;
    return financialAnswer({ question: original, intent: /بیشترین/.test(normalized) ? 'top-expense' : 'expense-total', answer,
      result: { value: /بیشترین/.test(normalized) && top ? top[1] : value, label: /بیشترین/.test(normalized) ? top?.[0] || 'بیشترین هزینه' : 'هزینه', unit: FINANCIAL_UNIT },
      scope, sources: answerSources.map(transactionSource), calculation: /بیشترین/.test(normalized) ? 'جمع هزینه‌ها به تفکیک دسته و انتخاب بیشترین' : 'جمع تراکنش‌های هزینه', now });
  }

  if (/درآمد|فروش/.test(normalized)) {
    const incomeRows = rows.filter((item) => item.type === 'income');
    const value = incomeRows.reduce((sum, item) => sum + Number(item.amount), 0);
    return financialAnswer({ question: original, intent: 'income-total', answer: `در ۳۰ روز اخیر ${money(value)} تومان درآمد از ${incomeRows.length} ثبت داشته‌ای.`,
      result: { value, label: 'درآمد', unit: FINANCIAL_UNIT }, scope, sources: incomeRows.map(transactionSource), calculation: 'جمع تراکنش‌های درآمد', now });
  }

  const net = rows.reduce((sum, item) => sum + (item.type === 'income' ? Number(item.amount) : -Number(item.amount)), 0);
  if (/سود|وضع|چطور/.test(normalized)) {
    return financialAnswer({ question: original, intent: 'range-net-cash-flow',
      answer: `خالص دریافت و پرداخت ۳۰ روز اخیر ${money(net)} تومان است؛ این عدد سود حسابداری نیست.`,
      result: { value: net, label: 'خالص دریافت و پرداخت', unit: FINANCIAL_UNIT }, scope,
      sources: rows.map(transactionSource), calculation: 'جمع دریافت‌ها منهای جمع پرداخت‌های ۳۰ روز اخیر', now });
  }
  return financialAnswer({ question: original, intent: 'cash-position',
    answer: `ماندهٔ نقدی برآوردی ${money(overview.cash)} تومان است. می‌توانی دربارهٔ آخرین پرداخت، جمع یک دسته، ماندهٔ یک شخص یا مقایسهٔ دو بازه بپرسی.`,
    result: { value: overview.cash, netCashFlow: net, label: 'ماندهٔ نقدی برآوردی', unit: FINANCIAL_UNIT },
    scope: sourceScope(accountSources(overview.accounts), now, 'ماندهٔ حساب‌های نقدی تا اکنون'),
    sources: accountSources(overview.accounts), calculation: 'جمع ماندهٔ صندوق، بانک و کیف پول فعال؛ ماندهٔ افتتاحیه به‌علاوهٔ دریافت‌ها منهای پرداخت‌ها', now });
}

export function recordVoiceMetric(values = {}) {
  db.prepare(`INSERT INTO voice_metrics (id,provider,model,duration_ms,first_transcript_ms,latency_ms,transaction_count,needs_review,succeeded,error_code)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), String(values.provider || 'unknown').slice(0, 40), String(values.model || '').slice(0, 100), Math.max(0, Number(values.durationMs) || 0), Math.max(0, Number(values.firstTranscriptMs) || 0), Math.max(0, Number(values.latencyMs) || 0), Math.max(0, Number(values.transactionCount) || 0), values.needsReview ? 1 : 0, values.succeeded === false ? 0 : 1, String(values.errorCode || '').slice(0, 80));
}

export function voiceStats() {
  const totals = db.prepare(`SELECT COUNT(*) AS total,SUM(succeeded) AS succeeded,
    ROUND(AVG(CASE WHEN succeeded=1 THEN latency_ms END)) AS averageLatency,
    ROUND(AVG(CASE WHEN first_transcript_ms>0 THEN first_transcript_ms END)) AS averageFirstTranscript,
    SUM(needs_review) AS reviewed,
    SUM(CASE WHEN provider IN ('browser-live','openai-realtime') THEN 1 ELSE 0 END) AS fastPath,
    ROUND(100.0*SUM(CASE WHEN provider IN ('browser-live','openai-realtime') THEN 1 ELSE 0 END)/NULLIF(COUNT(*),0),1) AS fastPathRate
    FROM voice_metrics`).get();
  const providers = db.prepare(`SELECT provider,model,COUNT(*) AS count,ROUND(AVG(latency_ms)) AS averageLatency,
    ROUND(100.0*SUM(succeeded)/COUNT(*),1) AS successRate FROM voice_metrics GROUP BY provider,model ORDER BY count DESC`).all();
  return { ...totals, providers };
}

export const FINANCIAL_BACKUP_TABLES = [
  'categories', 'accounts', 'contacts', 'transactions', 'bank_statement_imports', 'bank_statement_lines', 'obligations', 'recurring_rules', 'invoices',
  'invoice_items', 'invoice_payments', 'daily_closings', 'receipts', 'products', 'stock_movements', 'learnings',
  'automation_rules', 'settings', 'voice_metrics', 'provider_usage', 'collaboration_requests', 'pilot_checkins', 'tax_rates',
  'ledger_accounts', 'journal_entries', 'journal_lines', 'accounting_periods', 'financial_alert_feedback',
  'accounting_transfer_settings', 'accounting_transfer_mappings', 'accounting_transfer_batches', 'accounting_transfer_validations', 'audit_log',
];

const BACKUP_DELETE_ORDER = [
  'accounting_transfer_validations', 'accounting_transfer_batches', 'accounting_transfer_mappings', 'accounting_transfer_settings',
  'provider_usage', 'collaboration_requests', 'pilot_checkins', 'financial_alert_feedback', 'journal_lines', 'journal_entries', 'accounting_periods', 'ledger_accounts', 'bank_statement_lines', 'bank_statement_imports', 'invoice_payments',
  'stock_movements', 'invoice_items', 'obligations', 'transactions', 'receipts', 'daily_closings',
  'automation_rules', 'recurring_rules', 'invoices', 'products', 'contacts', 'learnings', 'voice_metrics', 'tax_rates',
  'accounts', 'categories', 'settings',
];

export function financialBackupSnapshot(workspace = currentWorkspace()) {
  const tables = {};
  for (const table of FINANCIAL_BACKUP_TABLES) tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  return {
    format: 'hesab-yar-financial-data', version: 1, exportedAt: new Date().toISOString(),
    workspace: { id: workspace?.id || 'primary' }, tables,
  };
}

export function restoreFinancialSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== 'hesab-yar-financial-data' || snapshot.version !== 1 || !snapshot.tables) throw new Error('ساختار پشتیبان معتبر نیست.');
  db.exec('PRAGMA defer_foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of BACKUP_DELETE_ORDER) db.prepare(`DELETE FROM ${table}`).run();
    for (const table of FINANCIAL_BACKUP_TABLES) {
      const rows = snapshot.tables[table];
      if (!Array.isArray(rows)) throw new Error(`جدول ${table} در پشتیبان کامل نیست.`);
      const validColumns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
      for (const row of rows) {
        const columns = Object.keys(row).filter((column) => validColumns.has(column));
        if (!columns.length) continue;
        const placeholders = columns.map(() => '?').join(',');
        const command = table === 'audit_log' ? 'INSERT OR IGNORE' : 'INSERT';
        db.prepare(`${command} INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`).run(...columns.map((column) => row[column]));
      }
    }
    ensureTaxSchema(db);
    const cash = db.prepare("SELECT id FROM accounts WHERE id='cash'").get();
    if (!cash) throw new Error('پشتیبان حساب صندوق اصلی را ندارد.');
    migrateAccountingLedger(db, { createdBy: currentWorkspace()?.userId });
    migrateInventory(db, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    db.prepare('INSERT INTO audit_log (id,action,entity_type,entity_id,payload) VALUES (?,?,?,?,?)')
      .run(randomUUID(), 'restore', 'workspace', currentWorkspace()?.id || 'primary', JSON.stringify({ restoredAt: new Date().toISOString() }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return financialBackupSnapshot();
}

export function seedDemo() {
  if (db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count) return 0;
  const now = new Date();
  const samples = [
    { amount: 12_000_000, type: 'income', category: 'فروش', rawText: 'امروز دوازده میلیون فروش داشتم', occurredAt: new Date(now.getTime() - 30 * 60_000).toISOString() },
    { amount: 2_500_000, type: 'expense', category: 'حقوق و دستمزد', rawText: 'دو میلیون و پانصد هزار حقوق دادم', occurredAt: new Date(now.getTime() - 90 * 60_000).toISOString() },
    { amount: 1_200_000, type: 'expense', category: 'مواد و کالا', rawText: 'یک میلیون و دویست مواد خریدم', occurredAt: new Date(now.getTime() - 160 * 60_000).toISOString() },
  ];
  insertTransactions({ transcript: 'داده نمونه', transactions: samples });
  return samples.length;
}

if (String(process.env.SEED_DEMO).toLowerCase() === 'true') seedDemo();

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

export function ensureAdmin() {
  const username = String(process.env.ADMIN_USERNAME || 'owner').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  let existing = controlDb.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!existing) {
    const policy = passwordPolicy(password, username);
    if (!policy.valid || password === 'change-this-to-a-long-random-password') return { configured: false, username };
    const salt = randomBytes(24).toString('hex');
    existing = { id: randomUUID() };
    controlDb.prepare('INSERT INTO users (id,username,password_hash,password_salt,display_name) VALUES (?,?,?,?,?)')
      .run(existing.id, username, hashPassword(password, salt), salt, username);
  }
  const primaryName = controlDb.prepare("SELECT value FROM settings WHERE key='businessName'").get()?.value || 'دفتر اصلی';
  const primaryProfile = controlDb.prepare("SELECT value FROM settings WHERE key='profileType'").get()?.value === 'personal' ? 'personal' : 'business';
  controlDb.prepare(`INSERT OR IGNORE INTO workspaces (id,name,profile_type,created_by) VALUES ('primary',?,?,?)`)
    .run(primaryName, primaryProfile, existing.id);
  controlDb.prepare(`INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES ('primary',?,'owner')`).run(existing.id);
  return { configured: true, username };
}

export function authenticateUser(username, password) {
  const user = controlDb.prepare('SELECT id,username,display_name AS displayName,must_change_password AS mustChangePassword,password_hash,password_salt FROM users WHERE username=?').get(String(username || '').trim().toLowerCase());
  if (!user) { hashPassword(String(password || ''), '000000000000000000000000000000000000000000000000'); return null; }
  const supplied = Buffer.from(hashPassword(String(password || ''), user.password_salt), 'hex');
  const expected = Buffer.from(user.password_hash, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
    ? { id: user.id, username: user.username, displayName: user.displayName, mustChangePassword: Boolean(user.mustChangePassword) } : null;
}

export function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  controlDb.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  controlDb.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(tokenHash, userId, expiresAt);
  controlDb.prepare(`DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (
    SELECT token_hash FROM sessions WHERE user_id=? ORDER BY rowid DESC LIMIT 5
  )`).run(userId, userId);
  return { token, expiresAt };
}

export function userFromSession(token) {
  if (!token) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return controlDb.prepare(`SELECT users.id,users.username,users.display_name AS displayName,
    users.must_change_password AS mustChangePassword,sessions.expires_at AS expiresAt
    FROM sessions JOIN users ON users.id=sessions.user_id
    WHERE sessions.token_hash=? AND sessions.expires_at>?`).get(tokenHash, new Date().toISOString()) || null;
}

export function deleteSession(token) {
  if (!token) return;
  controlDb.prepare('DELETE FROM sessions WHERE token_hash=?').run(createHash('sha256').update(token).digest('hex'));
}

export function loginThrottle(fingerprint, now = new Date()) {
  const row = controlDb.prepare('SELECT attempts,locked_until AS lockedUntil FROM auth_attempts WHERE fingerprint=?').get(fingerprint);
  if (!row?.lockedUntil || row.lockedUntil <= now.toISOString()) return { blocked: false, retryAfterSeconds: 0 };
  return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((new Date(row.lockedUntil).getTime() - now.getTime()) / 1000)) };
}

export function recordLoginFailure(fingerprint, now = new Date()) {
  const windowMs = 15 * 60 * 1000;
  const current = controlDb.prepare('SELECT attempts,window_started_at AS windowStartedAt FROM auth_attempts WHERE fingerprint=?').get(fingerprint);
  const insideWindow = current && now.getTime() - new Date(current.windowStartedAt).getTime() < windowMs;
  const attempts = insideWindow ? Number(current.attempts) + 1 : 1;
  const windowStartedAt = insideWindow ? current.windowStartedAt : now.toISOString();
  const lockedUntil = attempts >= 8 ? new Date(now.getTime() + windowMs).toISOString() : null;
  controlDb.prepare(`INSERT INTO auth_attempts (fingerprint,attempts,window_started_at,locked_until,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(fingerprint) DO UPDATE SET attempts=excluded.attempts,window_started_at=excluded.window_started_at,
      locked_until=excluded.locked_until,updated_at=excluded.updated_at`)
    .run(fingerprint, attempts, windowStartedAt, lockedUntil, now.toISOString());
  controlDb.prepare('DELETE FROM auth_attempts WHERE updated_at<?').run(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
  return { attempts, blocked: Boolean(lockedUntil), lockedUntil };
}

export function clearLoginFailures(fingerprint) {
  controlDb.prepare('DELETE FROM auth_attempts WHERE fingerprint=?').run(fingerprint);
}

export function changePassword(userId, currentPassword, newPassword) {
  const user = controlDb.prepare('SELECT id,username,password_hash,password_salt FROM users WHERE id=?').get(userId);
  if (!user) return { changed: false, code: 'USER_NOT_FOUND' };
  const supplied = Buffer.from(hashPassword(String(currentPassword || ''), user.password_salt), 'hex');
  const expected = Buffer.from(user.password_hash, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return { changed: false, code: 'CURRENT_PASSWORD_INVALID' };
  const policy = passwordPolicy(newPassword, user.username);
  if (!policy.valid) return { changed: false, code: 'WEAK_PASSWORD', message: policy.message };
  if (String(currentPassword) === String(newPassword)) return { changed: false, code: 'PASSWORD_UNCHANGED', message: 'رمز جدید باید با رمز فعلی متفاوت باشد.' };
  const salt = randomBytes(24).toString('hex');
  controlDb.exec('BEGIN IMMEDIATE');
  try {
    controlDb.prepare('UPDATE users SET password_hash=?,password_salt=?,must_change_password=0 WHERE id=?').run(hashPassword(String(newPassword), salt), salt, userId);
    controlDb.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    controlDb.prepare('INSERT INTO audit_log (id,action,entity_type,entity_id,payload) VALUES (?,?,?,?,?)')
      .run(randomUUID(), 'password-change', 'user', userId, '{}');
    controlDb.exec('COMMIT');
  } catch (error) { controlDb.exec('ROLLBACK'); throw error; }
  return { changed: true };
}
