import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensureAccountingSchema, migrateAccountingLedger } from '../accounting.js';
import { ensureCounterpartyIdentitySchema } from '../counterparties.js';
import { ensureDepreciationSchema } from '../depreciationLedger.js';
import { ensureFinancialEventSchema } from '../financialEventStore.js';
import { ensureInventorySchema, migrateInventory } from '../inventory.js';
import { ensureReconciliationSchema } from '../reconciliation.js';
import { ensureTaxAssistantSchema } from '../taxAssistant.js';
import { ensureTaxKnowledgeSchema, migrateTaxKnowledgeSources } from '../taxKnowledge.js';
import { ensureTaxSchema } from '../tax.js';
import { balanceSnapshot, currentApproval, ensureOverdraftSchema, negativeViolations, overdraftError, recordOverdraftApproval, setApprovalSource } from '../balanceGuard.js';
import {
  CONTROL_SCHEMA_SQL, categorySeed, ensureCategorySeed, ensureColumnOn, ensureVoiceMetricSchema,
  ensureTransactionReviewSchema, ensureInvoiceSchema, ensureReceiptAutomationSchema,
  ensureFinancialAlertSchema, ensureCollaborationSchema, ensureCommercialSchema,
  ensureFirmConsoleSchema, ensurePettyCashSchema, ensureAccountingTransferSchema,
} from './schema.js';
export { ensurePettyCashSchema };

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
//
// `exec` از همین‌جا رد می‌شود تا قاعدهٔ «صندوق و بانک منفی نمی‌شوند مگر با تأیید
// حسابدار» روی هر تراکنشی که با `db` باز و بسته می‌شود بنشیند (`balanceGuard.js`):
// عکسِ مانده‌ها در BEGIN، سنجش پیش از COMMIT، و برگرداندن کل عملیات اگر حسابی
// با همین عملیات منفی‌تر شده و تأییدی نیامده.
//
// نگهبان روی خودِ اتصال هر دفتر هم می‌نشیند (`guardConnection`)، نه فقط روی `db`:
// مسیرهای صف حسابدار (`financialEvents.js`، `financialEventStore.js`) با اتصال خام
// (`activeWorkspaceDatabase()`) تراکنش باز می‌کردند و ثبتِ مورد صف، جاری سامان را
// بی‌تأیید به منفی ۱۵ میلیون رساند (گزارش مالک محصول، ۲۳ مهر ۱۴۰۵).
const openTransactions = new WeakMap();
const rawExec = new WeakMap();
function guardedExec(active, sql) {
  const exec = rawExec.get(active) || ((statementSql) => active.exec(statementSql));
  const statement = String(sql || '').trim().toUpperCase();
  if (/^BEGIN\b/.test(statement) && !openTransactions.has(active)) {
    const result = exec(sql);
    openTransactions.set(active, balanceSnapshot(active));
    return result;
  }
  if (/^COMMIT\b/.test(statement) && openTransactions.has(active)) {
    const before = openTransactions.get(active);
    openTransactions.delete(active);
    const violations = negativeViolations(active, before);
    if (violations.length) {
      const approval = currentApproval(active);
      if (!approval) {
        exec('ROLLBACK');
        throw withApprovalMode(overdraftError(violations));
      }
      recordOverdraftApproval(active, violations, approval);
    }
    return exec(sql);
  }
  if (/^ROLLBACK\b/.test(statement)) {
    openTransactions.delete(active);
    // نگهبان خودش برگردانده باشد، ROLLBACK دومِ فراخوان نباید خطای «تراکنشی باز
    // نیست» بسازد و خطای اصلی را بپوشاند.
    try { return exec(sql); } catch (error) {
      if (/no transaction is active/i.test(error.message)) return undefined;
      throw error;
    }
  }
  return exec(sql);
}

/** `exec` خودِ اتصال را نگهبان‌دار می‌کند؛ هر BEGIN/COMMIT روی آن، از هر مسیری، سنجیده می‌شود. */
export function guardConnection(connection) {
  if (rawExec.has(connection)) return connection;
  rawExec.set(connection, connection.exec.bind(connection));
  connection.exec = (sql) => guardedExec(connection, sql);
  return connection;
}

/**
 * تأیید از کجا می‌آید.
 *
 * - دفتری که جز ثبت‌کننده تأییدکنندهٔ دیگری ندارد: خودِ مدیر/حسابدار با دلیل
 *   تأیید می‌کند (هدر `X-Overdraft-Approval`).
 * - دفتری که حسابدار یا مدیر دیگری دارد: ثبت‌کننده تأیید خودش را نمی‌دهد؛
 *   درخواست به صف تأیید می‌رود و نفر دوم تأیید می‌کند. اجرای آن با
 *   `X-Approval-Request-Id` فقط وقتی پذیرفته است که همان درخواست (همان مسیر و
 *   همان بدنه) تأیید شده و هنوز اجرا نشده باشد.
 */
export function canonicalRequestBody(body) {
  if (body == null || (typeof body === 'object' && !Object.keys(body).length)) return '';
  const sort = (value) => Array.isArray(value) ? value.map(sort)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value;
  return JSON.stringify(sort(typeof body === 'string' ? JSON.parse(body || 'null') : body));
}

function approvedRequestFor(active, member) {
  ensureOverdraftSchema(active);
  const row = active.prepare("SELECT * FROM approval_requests WHERE id=? AND status='approved'").get(String(member.approvalRequestId));
  if (!row) return null;
  if (row.method !== member.requestMethod || row.path !== member.requestPath) return null;
  if (row.body !== canonicalRequestBody(member.requestBody)) return null;
  if (member.userId && ![row.requested_by, row.decided_by].includes(member.userId)) return null;
  return { reason: row.decision_reason || row.note, role: row.decider_role, userId: row.decided_by,
    requestId: row.id, requestedBy: row.requested_by, executedBy: member.userId || null };
}

setApprovalSource((database) => {
  const store = workspaceContext.getStore();
  const member = store?.member;
  if (!member) return null;
  if (member.overdraftApproval) return member.overdraftApproval;
  if (member.approvalRequestId) return approvedRequestFor(database || store.database || controlDb, member);
  return null;
}, () => workspaceContext.getStore()?.member?.approvalMode || 'inline');

/** خطا می‌گوید کاربر خودش تأیید می‌کند یا باید درخواست بفرستد. */
export function withApprovalMode(error) {
  const member = workspaceContext.getStore()?.member;
  error.details = { ...(error.details || {}), approvalMode: member?.approvalMode || 'inline' };
  return error;
}

export const db = new Proxy(controlDb, {
  get(target, property) {
    const active = workspaceContext.getStore()?.database || target;
    if (property === 'exec') return (sql) => guardedExec(active, sql);
    const value = active[property];
    return typeof value === 'function' ? value.bind(active) : value;
  },
});

db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(CONTROL_SCHEMA_SQL);

const LEARNING_SOURCE_COLUMN = "source TEXT NOT NULL DEFAULT 'manual'";

function ensureColumn(table, definition) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`); } catch (error) {
    if (!/duplicate column name/i.test(error.message)) throw error;
  }
}

// ترجیح تجربه روی عضویت می‌نشیند، نه روی کاربر: یک حسابدار در پروندهٔ خودش
// صاحب کسب‌وکار است و در پروندهٔ مشتری، حسابدار. تجربه باید در هر پرونده
// جداگانه تصمیم گرفته شود.
ensureColumnOn(controlDb, 'workspace_members', 'experience TEXT');
// دفتر بایگانی‌شده از فهرست بیرون می‌رود ولی فایل داده‌اش دست نمی‌خورد.
ensureColumnOn(controlDb, 'workspaces', 'archived_at TEXT');

// تسویهٔ جزئی: چقدر از این تعهد تا امروز پرداخت شده.
ensureColumn('obligations', 'paid_amount INTEGER NOT NULL DEFAULT 0');
// منشأ هر یادگیری: کاربر ('manual')، ارتقای برچسب موضوعی ('topic') یا ثبت‌های تأییدشدهٔ AI
// ('ai'). یادگیریِ AI فقط دسته را عوض می‌کند، هرگز جهت پول را (shared/parser.js).
ensureColumn('learnings', LEARNING_SOURCE_COLUMN);
// انتخاب کاربر دربارهٔ طرف حساب: '' یعنی چیزی نگفته، 'none' یعنی صریح گفته
// این ثبت هزینه یا درآمد عادی است. بدون نگه‌داشتنش، ثبتی که به صف بررسی
// می‌رود انتخاب کاربر را گم می‌کند و موقع تأیید دوباره حدس زده می‌شود.
ensureColumn('transactions', "settlement_choice TEXT NOT NULL DEFAULT ''");
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

// اجازهٔ منفی شدن (اضافه‌برداشت) برای هر حساب، و ردِ تأییدهای حسابدار.
ensureOverdraftSchema(controlDb);
guardConnection(controlDb);

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

ensurePettyCashSchema(controlDb);

ensureInventorySchema(controlDb);

ensureTaxSchema(controlDb);

ensureTaxAssistantSchema(controlDb);

ensureTaxKnowledgeSchema(controlDb);

migrateTaxKnowledgeSources(controlDb);

ensureCounterpartyIdentitySchema(controlDb);

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
  ensureColumnOn(database, 'learnings', LEARNING_SOURCE_COLUMN);
  ensureAccountingSchema(database);
  ensureTransactionReviewSchema(database);
  ensureVoiceMetricSchema(database);
  ensureInvoiceSchema(database);
  ensureReconciliationSchema(database);
  ensureReceiptAutomationSchema(database);
  ensureFinancialAlertSchema(database);
  ensureCollaborationSchema(database);
  ensureAccountingTransferSchema(database);
  ensurePettyCashSchema(database);
  ensureInventorySchema(database);
  ensureDepreciationSchema(database);
  ensureFinancialEventSchema(database);
  ensureTaxSchema(database);
  ensureTaxAssistantSchema(database);
  ensureTaxKnowledgeSchema(database);
  migrateTaxKnowledgeSources(database);
  ensureCounterpartyIdentitySchema(database);
  ensureOverdraftSchema(database);
  migrateAccountingLedger(database);
  migrateInventory(database, { timeZone: defaults.timezone });
  repairWorkspaceProfileType(workspaceId, database);
  workspaceConnections.set(workspaceId, guardConnection(database));
  return database;
}

export function runInWorkspace(workspaceId, member, callback) {
  return workspaceContext.run({ workspaceId, member, database: workspaceDatabase(workspaceId) }, callback);
}

/**
 * تأیید منفی شدن موجودی برای اسکریپت یا آزمونی که بیرون از درخواست HTTP روی
 * دفتر اصلی کار می‌کند — همیشه با دلیلِ صریح، تا جایی که نگهبان را دور می‌زند
 * در کد دیده شود.
 */
export function approveOverdraftsForScript(reason) {
  const store = workspaceContext.getStore();
  const overdraftApproval = { reason: String(reason || '').trim(), role: 'owner', userId: null };
  if (overdraftApproval.reason.length < 3) throw invalidInput('دلیل تأیید منفی شدن موجودی لازم است.');
  workspaceContext.enterWith(store
    ? { ...store, member: { ...store.member, overdraftApproval } }
    : { workspaceId: 'primary', member: { role: 'owner', overdraftApproval }, database: controlDb });
}

/** کاربر هشدار «شاید تکراری» را دیده و گفته «تکراری نیست، ثبت کن» (`X-Allow-Duplicate`). */
export function duplicateAllowed() {
  return Boolean(workspaceContext.getStore()?.member?.allowDuplicate);
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
