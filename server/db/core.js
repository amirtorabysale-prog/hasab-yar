import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CATEGORY_DEFINITIONS } from '../../shared/categoryRules.js';
import { ensureAccountingSchema, migrateAccountingLedger } from '../accounting.js';
import { ensureCounterpartyIdentitySchema } from '../counterparties.js';
import { ensureDepreciationSchema } from '../depreciationLedger.js';
import { ensureFinancialEventSchema } from '../financialEventStore.js';
import { ensureInventorySchema, migrateInventory } from '../inventory.js';
import { ensureReconciliationSchema } from '../reconciliation.js';
import { ensureTaxAssistantSchema } from '../taxAssistant.js';
import { ensureTaxKnowledgeSchema, migrateTaxKnowledgeSources } from '../taxKnowledge.js';
import { ensureTaxSchema } from '../tax.js';

const databasePath = resolve(process.env.DATABASE_PATH || './data/hesab-yar.sqlite');

mkdirSync(dirname(databasePath), { recursive: true });

/**
 * خطای ورودی کاربر، نه خرابی سرور.
 *
 * error handler فقط وقتی پیام واقعی را به کاربر می‌دهد که خطا `status` داشته
 * باشد؛ وگرنه ۵۰۰ برمی‌گرداند و پیام را با «خطای داخلی سرور» جایگزین می‌کند.
 * تا امروز دهها اعتبارسنجی اینجا `Error` خالی پرتاب می‌کردند، پس پیام فارسیِ
 * دقیقی که برایشان نوشته شده بود هرگز به کاربر نمی‌رسید و او فقط می‌دید
 * «دوباره تلاش کن» — کاری که هرگز جواب نمی‌داد چون ایراد از ورودی خودش بود.
 */
export function invalidInput(message, code = 'INVALID_INPUT') {
  return Object.assign(new Error(message), { code, status: 400 });
}

export const controlDb = new DatabaseSync(databasePath);

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
    -- '' یعنی ثبت عادی. 'capital-in' و 'fixed-asset' پول را جابه‌جا می‌کنند ولی
    -- سود و زیان دوره نیستند و از جمع درآمد/هزینه بیرون می‌مانند.
    capital_flow TEXT NOT NULL DEFAULT '' CHECK(capital_flow IN ('','capital-in','fixed-asset')),
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
  -- تسویهٔ جزئی قاعده است نه استثنا: مشتری سی درصد می‌دهد و بقیه را ماه بعد.
  -- تا پیش از این، تعهد یا کامل بسته می‌شد یا اصلاً — پس دفتر مجبور بود یا
  -- طلب را زودتر از موعد ببندد یا پرداخت واقعی را جایی ثبت نکند.
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

// ترجیح تجربه روی عضویت می‌نشیند، نه روی کاربر: یک حسابدار در پروندهٔ خودش
// صاحب کسب‌وکار است و در پروندهٔ مشتری، حسابدار. تجربه باید در هر پرونده
// جداگانه تصمیم گرفته شود.
ensureColumnOn(controlDb, 'workspace_members', 'experience TEXT');

function ensureVoiceMetricSchema(database) {
  ensureColumnOn(database, 'voice_metrics', 'first_transcript_ms INTEGER NOT NULL DEFAULT 0');
}

function ensureTransactionReviewSchema(database) {
  // تاریخ بدهکار/طلبکار شدن، جدا از سررسید. یکی‌کردنشان یعنی سندی که امروز
  // بدهکار شده، سررسیدش در گذشته دیده می‌شود و در فهرست عقب‌افتاده‌ها می‌نشیند.
  ensureColumnOn(database, 'obligations', 'occurred_at TEXT');
  ensureColumnOn(database, 'transactions', "confidence_details TEXT NOT NULL DEFAULT '{}'");
  ensureColumnOn(database, 'transactions', "review_reasons TEXT NOT NULL DEFAULT '[]'");
  ensureColumnOn(database, 'transactions', "review_state TEXT NOT NULL DEFAULT 'ready'");
  ensureColumnOn(database, 'transactions', 'restored_from TEXT');
  ensureColumnOn(database, 'transactions', "capital_flow TEXT NOT NULL DEFAULT ''");
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
      -- شناسهٔ همان «تلاش» کاربر: یک ضبط ممکن است هم نشست realtime بسازد و هم
      -- فایل را روی سرور بفرستد. هزینهٔ provider دو تاست، ولی از دید کاربر یک
      -- بار حرف زده و سهمیه باید یک واحد کم شود.
      attempt_id TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_provider_usage_month ON provider_usage(created_at,capability,status);
  `);
  // دیتابیس‌های موجود ستون تلاش را ندارند. ردیف قدیمی NULL می‌ماند و هرکدام یک
  // تلاش شمرده می‌شود، پس مصرف ثبت‌شدهٔ گذشته بازنویسی نمی‌شود. ایندکس بعد از
  // ستون ساخته می‌شود، وگرنه روی دیتابیس قدیمی به ستون ناموجود اشاره می‌کرد.
  ensureColumnOn(database, 'provider_usage', 'attempt_id TEXT');
  database.exec('CREATE INDEX IF NOT EXISTS idx_provider_usage_attempt ON provider_usage(attempt_id) WHERE attempt_id IS NOT NULL');
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
      download_count INTEGER NOT NULL DEFAULT 0,
      first_downloaded_at TEXT,
      last_downloaded_at TEXT,
      last_downloaded_by TEXT,
      last_download_reason TEXT NOT NULL DEFAULT '',
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
  // الگوی فایل انتقال پارسیان: خود دفتر یک بار از نصبش می‌گیرد و اینجا می‌ماند.
  ensureColumnOn(database, 'accounting_transfer_settings', 'transfer_template BLOB');
  ensureColumnOn(database, 'accounting_transfer_settings', "transfer_template_name TEXT NOT NULL DEFAULT ''");
  ensureColumnOn(database, 'accounting_transfer_settings', "fiscal_year_start TEXT NOT NULL DEFAULT ''");
  ensureColumnOn(database, 'accounting_transfer_settings', "fiscal_year_end TEXT NOT NULL DEFAULT ''");
  ensureColumnOn(database, 'accounting_transfer_batches', "file_format TEXT NOT NULL DEFAULT 'csv'");
  ensureColumnOn(database, 'accounting_transfer_batches', "amount_unit TEXT NOT NULL DEFAULT 'toman'");
  ensureColumnOn(database, 'accounting_transfer_batches', 'download_count INTEGER NOT NULL DEFAULT 0');
  ensureColumnOn(database, 'accounting_transfer_batches', 'first_downloaded_at TEXT');
  ensureColumnOn(database, 'accounting_transfer_batches', 'last_downloaded_at TEXT');
  ensureColumnOn(database, 'accounting_transfer_batches', 'last_downloaded_by TEXT');
  ensureColumnOn(database, 'accounting_transfer_batches', "last_download_reason TEXT NOT NULL DEFAULT ''");
}

ensureColumn('transactions', "contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL");

ensureColumn('transactions', "account TEXT NOT NULL DEFAULT 'cash'");

ensureColumn('transactions', "account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT");

ensureColumn('transactions', "note TEXT NOT NULL DEFAULT ''");

ensureColumn('transactions', "status TEXT NOT NULL DEFAULT 'confirmed'");

ensureColumn('transactions', 'due_at TEXT');

ensureColumn('transactions', 'updated_at TEXT');

// سندِ عمداً نگه‌داشته‌شده.
//
// وقتی موتور اطمینان جلوی ثبت خودکار را می‌گیرد، ردیف تراکنش نوشته می‌شود ولی
// سندش منتظر تأیید می‌ماند. این ستون همان «منتظر» است و بدونش
// `migrateAccountingLedger` که هر تراکنش بی‌سند را سند می‌زند، همان سندی را
// می‌ساخت که قرار بود نگه داشته شود.
ensureColumn('transactions', 'journal_deferred INTEGER NOT NULL DEFAULT 0');

// هویت بانک، جدا از نام حساب.
//
// کاربر می‌گوید «از ملت دادم» ولی حسابش را «جاری شرکت» اسم گذاشته. بدون یک
// شناسهٔ مشترک، این دو هیچ‌وقت به هم نمی‌رسند و هر ثبت بانکی در صندوق می‌نشیند.
ensureColumn('accounts', 'bank_id TEXT');

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

ensureTaxAssistantSchema(controlDb);

ensureTaxKnowledgeSchema(controlDb);

migrateTaxKnowledgeSources(controlDb);

ensureCounterpartyIdentitySchema(controlDb);

// دسته‌ها یک منبع حقیقت دارند: همان جدولی که پارسر با آن تصمیم می‌گیرد. اگر
// این دو از هم جدا شوند، پارسر دسته‌ای پیشنهاد می‌دهد که در کشوی کارت تأیید
// وجود ندارد و کاربر نمی‌تواند تأییدش کند.
const categorySeed = CATEGORY_DEFINITIONS.map((item, index) => [
  item.id, item.name, item.type, item.id.endsWith('-other') ? 99 : index + 1,
]);

// دفترهای موجود هم باید دسته‌های تازه را بگیرند، وگرنه فقط نصب‌های جدید از
// دسته‌بندی دقیق بهره می‌برند.
// نام دسته‌های قدیمی عمداً دست‌نخورده می‌ماند: تراکنش‌ها دسته را به‌صورت نام
// ذخیره می‌کنند، پس تغییر نام یعنی بی‌دسته‌شدن هر ثبت قدیمی.
function ensureCategorySeed(database) {
  const insert = database.prepare('INSERT OR IGNORE INTO categories (id,name,type,sort_order) VALUES (?,?,?,?)');
  for (const item of categorySeed) insert.run(...item);
}

ensureCategorySeed(db);

db.prepare(`INSERT OR IGNORE INTO accounts (id,name,kind,opening_balance,sort_order)
  VALUES ('cash','صندوق نقدی','cash',0,1)`).run();

db.prepare("UPDATE transactions SET account_id='cash' WHERE account_id IS NULL OR account_id='' ").run();

const defaults = {
  businessName: '', currency: 'تومان', timezone: 'Asia/Tehran', profileType: 'business',
  onboardingDone: 'false', openingBalance: '0', ownerName: '', lowBalanceThreshold: '2000000', alertSensitivity: 'balanced',
};

export const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');

for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, String(value));

const openingMigrated = db.prepare("SELECT value FROM settings WHERE key='accountOpeningMigrated'").get();

if (!openingMigrated) {
  const legacyOpening = Number(db.prepare("SELECT value FROM settings WHERE key='openingBalance'").get()?.value || 0);
  db.prepare("UPDATE accounts SET opening_balance=? WHERE id='cash'").run(Math.round(legacyOpening));
  insertSetting.run('accountOpeningMigrated', 'true');
}

migrateInventory(controlDb, { timeZone: defaults.timezone });

/**
 * نوع دفتر («کسب‌وکار» یا «شخصی») در دو جا نگه داشته می‌شود: تنظیمات خودِ دفتر،
 * که کاربر ویرایشش می‌کند، و ردیف workspaces، که منو از روی آن ساخته می‌شود.
 *
 * پیش از این فقط اولی به‌روز می‌شد. وقتی این دو اختلاف داشتند، «همکاری حسابدار»
 * — جای خروجی پارسیان — یا از منو غایب بود یا صفحهٔ خالی باز می‌کرد، چون خودِ
 * صفحه نسخهٔ دیگر را می‌خواند. تنظیمات مرجع است، چون همان چیزی است که کاربر دیده.
 */
export function setWorkspaceProfileType(workspaceId, value) {
  if (!['business', 'personal'].includes(value)) return;
  controlDb.prepare('UPDATE workspaces SET profile_type=? WHERE id=? AND profile_type<>?').run(value, String(workspaceId || 'primary'), value);
}

// دفترهایی که پیش از این اصلاح ناهمخوان مانده‌اند، هنگام اولین باز شدن درست می‌شوند.
const profileTypeRepaired = new Set();
function repairWorkspaceProfileType(workspaceId, database) {
  if (profileTypeRepaired.has(workspaceId)) return;
  profileTypeRepaired.add(workspaceId);
  try {
    // تنظیمات فقط وقتی مرجع است که کاربر واقعاً انتخاب کرده باشد. دفتر تازه
    // مقدار پیش‌فرض «کسب‌وکار» را دارد و بدون این شرط، دفتر شخصی تازه‌ساخته
    // هنگام اولین باز شدن کسب‌وکار می‌شد.
    const chosen = database.prepare("SELECT value FROM settings WHERE key='onboardingDone'").get()?.value === 'true';
    if (chosen) setWorkspaceProfileType(workspaceId, database.prepare("SELECT value FROM settings WHERE key='profileType'").get()?.value);
  } catch { /* دفتر هنوز جدول تنظیمات ندارد */ }
}

export function workspaceDatabase(workspaceId) {
  if (workspaceId === 'primary') { repairWorkspaceProfileType('primary', controlDb); return controlDb; }
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
  ensureCategorySeed(database);
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
  ensureDepreciationSchema(database);
  ensureFinancialEventSchema(database);
  ensureTaxSchema(database);
  ensureTaxAssistantSchema(database);
  ensureTaxKnowledgeSchema(database);
  migrateTaxKnowledgeSources(database);
  ensureCounterpartyIdentitySchema(database);
  migrateAccountingLedger(database);
  migrateInventory(database, { timeZone: defaults.timezone });
  repairWorkspaceProfileType(workspaceId, database);
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

export function closeWorkspaceDatabases() {
  for (const database of workspaceConnections.values()) database.close();
  workspaceConnections.clear();
}

/**
 * همهٔ اتصال‌ها، شامل دیتابیس کنترل و دفتر اصلی.
 *
 * ویندوز فایلِ باز را قفل نگه می‌دارد، پس تا وقتی این اتصال‌ها باز باشند پوشهٔ
 * موقت آزمون پاک نمی‌شود و `rmSync` خطای EPERM می‌دهد. روی لینوکس مشکلی دیده
 * نمی‌شد چون unlink روی فایل باز مجاز است — برای همین فقط اجرای محلی قرمز بود.
 */
export function closeAllDatabases() {
  closeWorkspaceDatabases();
  for (const connection of new Set([db, controlDb])) {
    try { connection.close(); } catch { /* از قبل بسته است */ }
  }
}

export function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((row) => [row.key, row.value]));
}

export function currentTimeZone() {
  const candidate = getSettings().timezone || 'Asia/Tehran';
  try { new Intl.DateTimeFormat('en', { timeZone: candidate }).format(); return candidate; }
  catch { return 'Asia/Tehran'; }
}

export function localDay(date = new Date(), timeZone = currentTimeZone()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function addLocalDays(day, count) {
  const [year, month, date] = day.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, date + count));
  return result.toISOString().slice(0, 10);
}

export function zonedMidnight(day, timeZone) {
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

export function audit(action, entityType, entityId, payload = {}) {
  db.prepare('INSERT INTO audit_log (id,action,entity_type,entity_id,payload) VALUES (?,?,?,?,?)')
    .run(randomUUID(), action, entityType, entityId, JSON.stringify(payload));
}

export function recordAudit(action, entityType, entityId, payload = {}) {
  audit(action, entityType, entityId, payload);
}

export function userIdentity(userId) {
  if (!userId) return null;
  const user = controlDb.prepare('SELECT id,username,display_name AS displayName FROM users WHERE id=?').get(userId);
  return user ? { ...user, label: user.displayName || user.username } : { id: userId, username: '', displayName: '', label: 'کاربر حذف‌شده' };
}

export function cleanAmount(value) {
  const amount = Math.round(Number(value));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999_999_999_999) throw invalidInput('مبلغ معتبر نیست.');
  return amount;
}

export function parseStoredJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '') ?? fallback; }
  catch { return fallback; }
}
