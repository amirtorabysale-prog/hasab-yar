import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const databasePath = resolve(process.env.DATABASE_PATH || './data/hesab-yar.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new DatabaseSync(databasePath);
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
`);

function ensureColumn(table, definition) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`); } catch (error) {
    if (!/duplicate column name/i.test(error.message)) throw error;
  }
}

ensureColumn('transactions', "contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL");
ensureColumn('transactions', "account TEXT NOT NULL DEFAULT 'cash'");
ensureColumn('transactions', "account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT");
ensureColumn('transactions', "note TEXT NOT NULL DEFAULT ''");
ensureColumn('transactions', "status TEXT NOT NULL DEFAULT 'confirmed'");
ensureColumn('transactions', 'due_at TEXT');
ensureColumn('transactions', 'updated_at TEXT');
ensureColumn('users', "role TEXT NOT NULL DEFAULT 'owner'");

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
  onboardingDone: 'false', openingBalance: '0', ownerName: '', lowBalanceThreshold: '2000000',
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, String(value));

const openingMigrated = db.prepare("SELECT value FROM settings WHERE key='accountOpeningMigrated'").get();
if (!openingMigrated) {
  const legacyOpening = Number(db.prepare("SELECT value FROM settings WHERE key='openingBalance'").get()?.value || 0);
  db.prepare("UPDATE accounts SET opening_balance=? WHERE id='cash'").run(Math.round(legacyOpening));
  insertSetting.run('accountOpeningMigrated', 'true');
}

export function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((row) => [row.key, row.value]));
}

export function saveSettings(values) {
  const allowed = ['businessName', 'currency', 'timezone', 'profileType', 'onboardingDone', 'openingBalance', 'ownerName', 'lowBalanceThreshold'];
  const statement = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const key of allowed) if (values[key] != null) statement.run(key, String(values[key]).slice(0, 120));
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
  db.prepare(`INSERT INTO accounts (id,name,kind,opening_balance,active) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,opening_balance=excluded.opening_balance,
      active=excluded.active,updated_at=CURRENT_TIMESTAMP`)
    .run(id, name, kind, openingBalance, values.active === false ? 0 : 1);
  if (id === 'cash') insertSetting.run('openingBalance', String(openingBalance));
  audit(values.id ? 'update' : 'create', 'account', id, { name, kind, openingBalance });
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
    transactions.occurred_at AS occurredAt,transactions.note,transactions.account,transactions.contact_id AS contactId,
    contacts.name AS contactName
    FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id
    WHERE transactions.occurred_at>=? AND transactions.occurred_at<? AND transactions.status!='deleted'
    ORDER BY transactions.occurred_at DESC`).all(start, endExclusive);
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

function insertTransactionRows({ transcript, transactions }) {
  const insert = db.prepare(`INSERT OR IGNORE INTO transactions
    (id,client_id,amount,type,category,raw_text,source,confidence,needs_review,occurred_at,contact_id,account,account_id,note,status,due_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ids = [];
  for (const item of transactions) {
    const id = randomUUID();
    const amount = Math.round(Number(item.amount));
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999_999_999_999) throw new Error('مبلغ معتبر نیست.');
    if (!['income', 'expense'].includes(item.type)) throw new Error('نوع تراکنش معتبر نیست.');
    const occurredAt = item.occurredAt || new Date().toISOString();
    const accountId = resolveAccountId(item);
    const result = insert.run(id, item.clientId || null, amount, item.type, String(item.category || 'سایر').slice(0, 80), String(item.rawText || transcript || '').slice(0, 1000), item.source || 'text', Number(item.confidence ?? 1), item.needsReview ? 1 : 0, occurredAt, item.contactId || null, accountId, accountId, String(item.note || '').slice(0, 500), item.status || 'confirmed', item.dueAt || null, occurredAt);
    if (result.changes) {
      ids.push(id);
      audit('create', 'transaction', id, { amount, type: item.type, category: item.category });
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
    const ids = insertTransactionRows(payload);
    db.exec('COMMIT');
    return ids;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
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

function cleanAmount(value) {
  const amount = Math.round(Number(value));
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999_999_999_999) throw new Error('مبلغ معتبر نیست.');
  return amount;
}

function transactionRow(id) {
  return db.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,
    transactions.raw_text AS rawText,transactions.source,transactions.confidence,transactions.needs_review AS needsReview,
    transactions.occurred_at AS occurredAt,transactions.created_at AS createdAt,transactions.note,transactions.account,
    transactions.account_id AS accountId,accounts.name AS accountName,
    transactions.contact_id AS contactId,contacts.name AS contactName,transactions.due_at AS dueAt
    FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id LEFT JOIN accounts ON accounts.id=transactions.account_id
    WHERE transactions.id=? AND transactions.status!='deleted'`).get(id) || null;
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
    transactions.raw_text AS rawText,transactions.source,transactions.needs_review AS needsReview,
    transactions.occurred_at AS occurredAt,transactions.note,transactions.account,
    transactions.account_id AS accountId,accounts.name AS accountName,
    transactions.contact_id AS contactId,contacts.name AS contactName
    FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id LEFT JOIN accounts ON accounts.id=transactions.account_id
    WHERE ${where} ORDER BY transactions.occurred_at DESC LIMIT ? OFFSET ?`)
    .all(...values, safeLimit, (safePage - 1) * safeLimit);
  return { items, total, page: safePage, pages: Math.max(1, Math.ceil(total / safeLimit)) };
}

export function updateTransaction(id, values = {}) {
  const current = transactionRow(id);
  if (!current) return null;
  const type = ['income', 'expense'].includes(values.type) ? values.type : current.type;
  const amount = values.amount == null ? current.amount : cleanAmount(values.amount);
  const occurredAt = values.occurredAt || current.occurredAt;
  const accountId = values.accountId == null && values.account == null ? current.accountId : resolveAccountId(values);
  db.prepare(`UPDATE transactions SET amount=?,type=?,category=?,raw_text=?,note=?,account=?,account_id=?,contact_id=?,occurred_at=?,due_at=?,updated_at=? WHERE id=?`)
    .run(amount, type, String(values.category || current.category).slice(0, 80), String(values.rawText ?? current.rawText).slice(0, 1000), String(values.note ?? current.note ?? '').slice(0, 500), accountId, accountId, values.contactId === undefined ? current.contactId : (values.contactId || null), occurredAt, values.dueAt === undefined ? current.dueAt : (values.dueAt || null), new Date().toISOString(), id);
  audit('update', 'transaction', id, { before: current, after: values });
  return transactionRow(id);
}

export function deleteTransaction(id) {
  const current = transactionRow(id);
  if (!current) return false;
  db.prepare("UPDATE transactions SET status='deleted',updated_at=? WHERE id=?").run(new Date().toISOString(), id);
  audit('delete', 'transaction', id, current);
  return true;
}

export function listContacts() {
  return db.prepare(`SELECT contacts.id,contacts.name,contacts.kind,contacts.phone,contacts.note,
    COALESCE(SUM(CASE WHEN obligations.status='open' AND obligations.direction='receivable' THEN obligations.amount WHEN obligations.status='open' AND obligations.direction='payable' THEN -obligations.amount ELSE 0 END),0) AS balance,
    COUNT(CASE WHEN obligations.status='open' THEN 1 END) AS openCount
    FROM contacts LEFT JOIN obligations ON obligations.contact_id=contacts.id
    GROUP BY contacts.id ORDER BY contacts.updated_at DESC,contacts.name`).all();
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

export function listInvoices() {
  return db.prepare(`SELECT invoices.id,invoices.number,invoices.contact_id AS contactId,invoices.customer_name AS customerName,
    invoices.total,invoices.status,invoices.due_at AS dueAt,invoices.note,invoices.created_at AS createdAt,
    contacts.name AS contactName FROM invoices LEFT JOIN contacts ON contacts.id=invoices.contact_id
    ORDER BY invoices.created_at DESC`).all();
}

export function getInvoice(id) {
  const invoice = listInvoices().find((item) => item.id === id);
  if (!invoice) return null;
  invoice.items = db.prepare('SELECT id,title,quantity,unit_price AS unitPrice,total FROM invoice_items WHERE invoice_id=? ORDER BY rowid').all(id);
  return invoice;
}

export function createInvoice(values = {}) {
  const items = Array.isArray(values.items) ? values.items.filter((item) => String(item.title || '').trim()) : [];
  if (!items.length) throw new Error('حداقل یک ردیف برای فاکتور لازم است.');
  const normalized = items.map((item) => {
    const quantity = Math.max(0.01, Number(item.quantity) || 1);
    const unitPrice = cleanAmount(item.unitPrice);
    return { title: String(item.title).trim().slice(0, 120), quantity, unitPrice, total: Math.round(quantity * unitPrice) };
  });
  const total = normalized.reduce((sum, item) => sum + item.total, 0);
  const id = randomUUID();
  const count = db.prepare('SELECT COUNT(*) AS count FROM invoices').get().count + 1;
  const number = `HY-${new Date().getFullYear()}-${String(count).padStart(4, '0')}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO invoices (id,number,contact_id,customer_name,total,status,due_at,note) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, number, values.contactId || null, String(values.customerName || 'مشتری').trim().slice(0, 100), total, values.status === 'sent' ? 'sent' : 'draft', values.dueAt || null, String(values.note || '').slice(0, 500));
    const insert = db.prepare('INSERT INTO invoice_items (id,invoice_id,title,quantity,unit_price,total) VALUES (?,?,?,?,?,?)');
    for (const item of normalized) insert.run(randomUUID(), id, item.title, item.quantity, item.unitPrice, item.total);
    audit('create', 'invoice', id, { number, total });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getInvoice(id);
}

export function markInvoicePaid(id, { occurredAt, account = 'cash', accountId } = {}) {
  const invoice = getInvoice(id);
  if (!invoice || invoice.status === 'paid') return invoice;
  db.exec('BEGIN IMMEDIATE');
  try {
    insertTransactionRows({ transcript: `وصول فاکتور ${invoice.number}`, transactions: [{
      clientId: `invoice:${id}`, amount: invoice.total, type: 'income', category: 'فروش', rawText: `وصول فاکتور ${invoice.number}`,
      source: 'text', contactId: invoice.contactId, occurredAt, account, accountId,
    }] });
    const updated = db.prepare("UPDATE invoices SET status='paid',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status!='paid'").run(id);
    if (!updated.changes) throw new Error('این فاکتور قبلاً وصول شده است.');
    audit('paid', 'invoice', id, { total: invoice.total });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getInvoice(id);
}

export function deleteInvoice(id) {
  const result = db.prepare("UPDATE invoices SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status!='paid'").run(id);
  if (result.changes) audit('cancel', 'invoice', id);
  return result.changes > 0;
}

export function closeDay(values = {}) {
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

export function saveReceipt({ buffer, fileName, mimeType, note = '', amount = null, type = null, category = null }) {
  if (!buffer?.length) throw new Error('تصویر رسید خالی است.');
  const id = randomUUID();
  const normalizedAmount = amount ? cleanAmount(amount) : null;
  const normalizedType = ['income', 'expense'].includes(type) ? type : null;
  db.prepare('INSERT INTO receipts (id,file_name,mime_type,image_data,note,amount,type,category) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, String(fileName || 'receipt').slice(0, 160), mimeType, buffer, String(note || '').slice(0, 800), normalizedAmount, normalizedType, category ? String(category).slice(0, 80) : null);
  audit('create', 'receipt', id, { fileName, amount: normalizedAmount });
  return db.prepare('SELECT id,file_name AS fileName,mime_type AS mimeType,note,amount,type,category,created_at AS createdAt FROM receipts WHERE id=?').get(id);
}

export function listReceipts() {
  return db.prepare('SELECT id,file_name AS fileName,mime_type AS mimeType,note,amount,type,category,created_at AS createdAt FROM receipts ORDER BY created_at DESC LIMIT 100').all();
}

export function receiptImage(id) {
  const row = db.prepare('SELECT mime_type AS mimeType,image_data AS imageData FROM receipts WHERE id=?').get(id);
  return row ? { ...row, imageData: Buffer.from(row.imageData) } : null;
}

export function listProducts() {
  return db.prepare(`SELECT id,name,stock,unit,low_threshold AS lowThreshold,buy_price AS buyPrice,sale_price AS salePrice,
    CASE WHEN low_threshold>0 AND stock<=low_threshold THEN 1 ELSE 0 END AS isLow FROM products ORDER BY isLow DESC,name`).all();
}

export function saveProduct(values = {}) {
  const name = String(values.name || '').trim().slice(0, 100);
  if (!name) throw new Error('نام کالا را وارد کن.');
  const id = values.id || randomUUID();
  db.prepare(`INSERT INTO products (id,name,stock,unit,low_threshold,buy_price,sale_price) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,unit=excluded.unit,low_threshold=excluded.low_threshold,
      buy_price=excluded.buy_price,sale_price=excluded.sale_price,updated_at=CURRENT_TIMESTAMP`)
    .run(id, name, Math.max(0, Number(values.stock) || 0), String(values.unit || 'عدد').slice(0, 30), Math.max(0, Number(values.lowThreshold) || 0), Math.max(0, Math.round(Number(values.buyPrice) || 0)), Math.max(0, Math.round(Number(values.salePrice) || 0)));
  audit(values.id ? 'update' : 'create', 'product', id, { name });
  return listProducts().find((item) => item.id === id);
}

export function adjustStock(id, values = {}) {
  const quantity = Number(values.quantity);
  if (!Number.isFinite(quantity) || quantity === 0) throw new Error('تغییر موجودی معتبر نیست.');
  const current = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!current) return null;
  if (Number(current.stock) + quantity < 0) throw new Error('موجودی کالا نمی‌تواند منفی شود.');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE products SET stock=stock+?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(quantity, id);
    db.prepare('INSERT INTO stock_movements (id,product_id,quantity,note) VALUES (?,?,?,?)').run(randomUUID(), id, quantity, String(values.note || '').slice(0, 300));
    audit('adjust', 'product', id, { quantity });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return listProducts().find((item) => item.id === id);
}

export function financialOverview() {
  const month = report('month');
  const settings = getSettings();
  const obligations = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN direction='receivable' AND status='open' THEN amount ELSE 0 END),0) AS receivable,
    COALESCE(SUM(CASE WHEN direction='payable' AND status='open' THEN amount ELSE 0 END),0) AS payable,
    COUNT(CASE WHEN status='open' AND due_at IS NOT NULL AND due_at<? THEN 1 END) AS overdue
    FROM obligations`).get(new Date().toISOString());
  const liquid = db.prepare(`SELECT COALESCE(SUM(accounts.opening_balance + COALESCE((
      SELECT SUM(CASE WHEN transactions.type='income' THEN transactions.amount ELSE -transactions.amount END)
      FROM transactions WHERE transactions.account_id=accounts.id AND transactions.status!='deleted'
    ),0)),0) AS balance FROM accounts
    WHERE accounts.active=1 AND accounts.kind IN ('cash','bank','wallet')`).get();
  const cash = Number(liquid.balance || 0);
  const monthlyExpense = Number(month.summary.expense || 0);
  const runwayDays = monthlyExpense > 0 ? Math.max(0, Math.round((cash / monthlyExpense) * 30)) : null;
  const alerts = [];
  if (obligations.overdue) alerts.push({ level: 'danger', title: `${obligations.overdue} سررسید عقب‌افتاده داری`, action: 'obligations' });
  if (cash < Number(settings.lowBalanceThreshold || 2_000_000)) alerts.push({ level: 'warning', title: 'ماندهٔ برآوردی ثبت‌ها به حد هشدار رسیده است', action: 'reports' });
  if (month.summary.expense > month.summary.income && month.summary.expense > 0) alerts.push({ level: 'warning', title: 'هزینهٔ این ماه از درآمد بیشتر شده است', action: 'reports' });
  return {
    cash, receivable: Number(obligations.receivable), payable: Number(obligations.payable), overdue: Number(obligations.overdue),
    cashBasis: true, basisLabel: 'مبنای دریافت و پرداخت', accounts: listAccounts(), runwayDays, month: month.summary, alerts,
  };
}

export function answerFinancialQuestion(question = '') {
  const normalized = String(question).trim();
  const overview = financialOverview();
  const month = report('month');
  let answer;
  let evidence = [];
  if (/بده|طلب|گرفتن|دادن/.test(normalized)) {
    answer = `در حال حاضر ${new Intl.NumberFormat('fa-IR').format(overview.receivable)} تومان طلب باز و ${new Intl.NumberFormat('fa-IR').format(overview.payable)} تومان بدهی باز داری.`;
    evidence = listObligations({ status: 'open' }).slice(0, 5);
  } else if (/هزینه|خرج/.test(normalized)) {
    const top = month.categories.find((item) => item.type === 'expense');
    answer = top ? `بیشترین هزینهٔ ۳۰ روز اخیر «${top.name}» با ${new Intl.NumberFormat('fa-IR').format(top.amount)} تومان بوده است.` : 'در ۳۰ روز اخیر هنوز هزینه‌ای ثبت نشده است.';
    evidence = month.categories.filter((item) => item.type === 'expense').slice(0, 5);
  } else if (/درآمد|فروش/.test(normalized)) {
    answer = `در ۳۰ روز اخیر ${new Intl.NumberFormat('fa-IR').format(month.summary.income)} تومان درآمد ثبت کرده‌ای.`;
    evidence = month.points;
  } else if (/سود|وضع|چطور/.test(normalized)) {
    answer = `خالص دریافت و پرداخت ۳۰ روز اخیر ${new Intl.NumberFormat('fa-IR').format(month.summary.netCashFlow)} تومان و ماندهٔ برآوردی ثبت‌ها ${new Intl.NumberFormat('fa-IR').format(overview.cash)} تومان است. این عدد سود حسابداری نیست.`;
    evidence = [month.summary];
  } else {
    answer = `ماندهٔ برآوردی ثبت‌ها ${new Intl.NumberFormat('fa-IR').format(overview.cash)} تومان است. می‌توانی دربارهٔ فروش، هزینه، خالص دریافت و پرداخت، طلب یا بدهی بپرسی.`;
    evidence = [overview.month];
  }
  return { question: normalized, answer, evidence, generatedAt: new Date().toISOString(), deterministic: true };
}

export function recordVoiceMetric(values = {}) {
  db.prepare(`INSERT INTO voice_metrics (id,provider,model,duration_ms,latency_ms,transaction_count,needs_review,succeeded,error_code)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(randomUUID(), String(values.provider || 'unknown').slice(0, 40), String(values.model || '').slice(0, 100), Math.max(0, Number(values.durationMs) || 0), Math.max(0, Number(values.latencyMs) || 0), Math.max(0, Number(values.transactionCount) || 0), values.needsReview ? 1 : 0, values.succeeded === false ? 0 : 1, String(values.errorCode || '').slice(0, 80));
}

export function voiceStats() {
  const totals = db.prepare(`SELECT COUNT(*) AS total,SUM(succeeded) AS succeeded,
    ROUND(AVG(CASE WHEN succeeded=1 THEN latency_ms END)) AS averageLatency,
    SUM(needs_review) AS reviewed FROM voice_metrics`).get();
  const providers = db.prepare(`SELECT provider,model,COUNT(*) AS count,ROUND(AVG(latency_ms)) AS averageLatency,
    ROUND(100.0*SUM(succeeded)/COUNT(*),1) AS successRate FROM voice_metrics GROUP BY provider,model ORDER BY count DESC`).all();
  return { ...totals, providers };
}

export function exportSnapshot() {
  return {
    version: 3, exportedAt: new Date().toISOString(), settings: getSettings(), categories: getCategories(), accounts: listAccounts(),
    transactions: db.prepare(`SELECT id,amount,type,category,raw_text AS rawText,source,occurred_at AS occurredAt,
      note,account,account_id AS accountId,contact_id AS contactId,due_at AS dueAt FROM transactions WHERE status!='deleted' ORDER BY occurred_at`).all(), contacts: listContacts(),
    obligations: listObligations({ status: 'all' }), recurring: listRecurringRules(), invoices: listInvoices(),
    dailyClosings: listDailyClosings(), receipts: listReceipts(), products: listProducts(), learnings: getLearnings(),
  };
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
  const existing = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (existing) return { configured: true, username };
  if (password.length < 12) return { configured: false, username };
  const salt = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO users (id,username,password_hash,password_salt) VALUES (?,?,?,?)').run(randomUUID(), username, hashPassword(password, salt), salt);
  return { configured: true, username };
}

export function authenticateUser(username, password) {
  const user = db.prepare('SELECT id,username,password_hash,password_salt FROM users WHERE username=?').get(String(username || '').trim().toLowerCase());
  if (!user) { hashPassword(String(password || ''), '000000000000000000000000000000000000000000000000'); return null; }
  const supplied = Buffer.from(hashPassword(String(password || ''), user.password_salt), 'hex');
  const expected = Buffer.from(user.password_hash, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? { id: user.id, username: user.username } : null;
}

export function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(tokenHash, userId, expiresAt);
  return { token, expiresAt };
}

export function userFromSession(token) {
  if (!token) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return db.prepare(`SELECT users.id,users.username,sessions.expires_at AS expiresAt
    FROM sessions JOIN users ON users.id=sessions.user_id
    WHERE sessions.token_hash=? AND sessions.expires_at>?`).get(tokenHash, new Date().toISOString()) || null;
}

export function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(createHash('sha256').update(token).digest('hex'));
}
