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
`);

const categorySeed = [
  ['inc-sale', 'فروش', 'income', 1], ['inc-service', 'خدمات', 'income', 2], ['inc-project', 'پروژه و دستمزد', 'income', 3], ['inc-other', 'سایر درآمدها', 'income', 9],
  ['exp-material', 'مواد و کالا', 'expense', 1], ['exp-salary', 'حقوق و دستمزد', 'expense', 2], ['exp-rent', 'اجاره', 'expense', 3], ['exp-delivery', 'حمل‌ونقل', 'expense', 4], ['exp-food', 'خوراک', 'expense', 5], ['exp-bill', 'قبوض', 'expense', 6], ['exp-other', 'سایر هزینه‌ها', 'expense', 9],
];
const insertCategory = db.prepare('INSERT OR IGNORE INTO categories (id,name,type,sort_order) VALUES (?,?,?,?)');
for (const item of categorySeed) insertCategory.run(...item);

const defaults = { businessName: '', currency: 'تومان', timezone: 'Asia/Tehran' };
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, String(value));

export function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((row) => [row.key, row.value]));
}

export function saveSettings(values) {
  const allowed = ['businessName', 'currency', 'timezone'];
  const statement = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const key of allowed) if (values[key] != null) statement.run(key, String(values[key]).slice(0, 120));
  return getSettings();
}

export function getCategories() {
  return db.prepare('SELECT id,name,type FROM categories ORDER BY type DESC, sort_order, name').all();
}

function tehranDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function dayBounds(day = tehranDay()) {
  return { start: `${day}T00:00:00+03:30`, end: `${day}T23:59:59.999+03:30` };
}

export function getToday() {
  const { start, end } = dayBounds();
  const transactions = db.prepare('SELECT id,amount,type,category,raw_text AS rawText,source,confidence,needs_review AS needsReview,occurred_at AS occurredAt FROM transactions WHERE occurred_at BETWEEN ? AND ? ORDER BY occurred_at DESC').all(start, end);
  const totals = summarize(transactions);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const previousBounds = dayBounds(tehranDay(yesterday));
  const previous = db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income FROM transactions WHERE occurred_at BETWEEN ? AND ?").get(previousBounds.start, previousBounds.end).income;
  totals.comparison = previous > 0 ? Math.round(((totals.income - previous) / previous) * 100) : null;
  return { transactions, summary: totals };
}

export function summarize(items) {
  const income = items.filter((item) => item.type === 'income').reduce((sum, item) => sum + Number(item.amount), 0);
  const expense = items.filter((item) => item.type === 'expense').reduce((sum, item) => sum + Number(item.amount), 0);
  return { income, expense, profit: income - expense, comparison: null };
}

export function insertTransactions({ transcript, transactions }) {
  const insert = db.prepare(`INSERT OR IGNORE INTO transactions
    (id,client_id,amount,type,category,raw_text,source,confidence,needs_review,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const ids = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of transactions) {
      const id = randomUUID();
      const amount = Math.round(Number(item.amount));
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999_999_999_999) throw new Error('مبلغ معتبر نیست.');
      if (!['income', 'expense'].includes(item.type)) throw new Error('نوع تراکنش معتبر نیست.');
      insert.run(id, item.clientId || null, amount, item.type, String(item.category || 'سایر').slice(0, 80), String(item.rawText || transcript || '').slice(0, 1000), item.source || 'text', Number(item.confidence ?? 1), item.needsReview ? 1 : 0, item.occurredAt || new Date().toISOString());
      ids.push(id);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return ids;
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
  const rows = db.prepare("SELECT type, AVG(amount) AS average FROM (SELECT type,amount FROM transactions ORDER BY occurred_at DESC LIMIT 120) GROUP BY type").all();
  return Object.fromEntries(rows.map((row) => [row.type, Math.round(row.average)]));
}

export function report(range = 'month') {
  const days = range === 'week' ? 7 : range === 'quarter' ? 90 : 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (days - 1));
  const start = dayBounds(tehranDay(startDate)).start;
  const items = db.prepare('SELECT amount,type,category,occurred_at AS occurredAt FROM transactions WHERE occurred_at >= ? ORDER BY occurred_at').all(start);
  const summary = summarize(items);
  const bucketCount = range === 'quarter' ? 12 : range === 'month' ? 10 : 7;
  const bucketDays = Math.ceil(days / bucketCount);
  const points = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const from = new Date(startDate); from.setDate(from.getDate() + index * bucketDays);
    const until = new Date(from); until.setDate(until.getDate() + bucketDays);
    const group = items.filter((item) => { const time = new Date(item.occurredAt); return time >= from && time < until; });
    const totals = summarize(group);
    points.push({ label: new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: range === 'quarter' ? 'short' : undefined }).format(from), income: totals.income, expense: totals.expense });
  }
  const grouped = new Map();
  for (const item of items) {
    const key = `${item.type}:${item.category}`;
    grouped.set(key, { name: item.category, type: item.type, amount: (grouped.get(key)?.amount || 0) + Number(item.amount) });
  }
  const maximum = Math.max(1, ...[...grouped.values()].map((item) => item.amount));
  const categories = [...grouped.values()].sort((a, b) => b.amount - a.amount).map((item) => ({ ...item, share: Math.round(item.amount / maximum * 100) }));
  const biggestExpense = categories.find((item) => item.type === 'expense');
  const insight = biggestExpense ? `بیشترین هزینهٔ این بازه مربوط به «${biggestExpense.name}» و مبلغ آن ${new Intl.NumberFormat('fa-IR').format(biggestExpense.amount)} تومان بوده است.` : '';
  return { summary, points, categories, insight };
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
