import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { canonicalCounterpartyName } from '../shared/counterpartyIdentity.js';
import { ensureCounterpartyIdentitySchema } from '../server/counterparties.js';

test('عنوان حقوقی، علائم و نویسه‌های عربی هویت شرکت را عوض نمی‌کنند', () => {
  const expected = canonicalCounterpartyName('شرکت آرمان (سهامی خاص)');
  assert.equal(expected, canonicalCounterpartyName('آرمان'));
  assert.equal(expected, canonicalCounterpartyName('شرکت آرمان، سهامي خاص'));
});

test('نام‌های واقعاً متفاوت برای جلوگیری از ادغام مالی جدا می‌مانند', () => {
  assert.notEqual(canonicalCounterpartyName('آرمان تجارت'), canonicalCounterpartyName('آرمان صنعت'));
});

test('مهاجرت، اسناد و تفصیلی تکراری را روی یک شرکت نگه می‌دارد', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE contacts (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE transactions (id TEXT PRIMARY KEY,contact_id TEXT REFERENCES contacts(id));
    CREATE TABLE obligations (id TEXT PRIMARY KEY,contact_id TEXT REFERENCES contacts(id));
    CREATE TABLE invoices (id TEXT PRIMARY KEY,contact_id TEXT REFERENCES contacts(id));
    CREATE TABLE analytic_accounts (id TEXT PRIMARY KEY,name TEXT,source_kind TEXT,source_key TEXT,UNIQUE(source_kind,source_key));
    CREATE TABLE journal_lines (id TEXT PRIMARY KEY,analytic_id TEXT REFERENCES analytic_accounts(id) ON DELETE RESTRICT);
    INSERT INTO contacts (id,name) VALUES ('kept','شرکت آرمان'),('duplicate','آرمان');
    INSERT INTO obligations (id,contact_id) VALUES ('o1','duplicate');
    INSERT INTO invoices (id,contact_id) VALUES ('i1','kept');
    INSERT INTO analytic_accounts (id,name,source_kind,source_key) VALUES ('a1','شرکت آرمان','contact','kept'),('a2','آرمان','contact','duplicate');
    INSERT INTO journal_lines (id,analytic_id) VALUES ('j1','a2');
  `);
  ensureCounterpartyIdentitySchema(database);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM contacts').get().count, 1);
  assert.equal(database.prepare("SELECT contact_id AS contactId FROM obligations WHERE id='o1'").get().contactId, 'kept');
  assert.equal(database.prepare("SELECT analytic_id AS analyticId FROM journal_lines WHERE id='j1'").get().analyticId, 'a1');
  database.close();
});

// ---------------------------------------------------- مرز ادغام خودکار

/**
 * «آقای رضایی» و «خانم رضایی» دو نفرند.
 *
 * وقتی عنوان شخص هم حذف می‌شد، هر دو «رضایی» می‌شدند و مهاجرتی که روی هر بار
 * باز شدن دفتر اجرا می‌شود، طلب و بدهی دو آدم را روی یک طرف حساب ادغام می‌کرد و
 * یکی را پاک — بی‌بازگشت.
 */
test('عنوان شخص هویت را عوض می‌کند و ادغام نمی‌شود', () => {
  assert.notEqual(canonicalCounterpartyName('آقای رضایی'), canonicalCounterpartyName('خانم رضایی'));
  assert.notEqual(canonicalCounterpartyName('دکتر احمدی'), canonicalCounterpartyName('مهندس احمدی'));
});

function schemaWithCodes() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE contacts (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE analytic_accounts (id TEXT PRIMARY KEY,name TEXT,source_kind TEXT,source_key TEXT,external_code TEXT);
    CREATE TABLE journal_lines (id TEXT PRIMARY KEY,analytic_id TEXT);
    CREATE TABLE audit_log (id TEXT PRIMARY KEY,action TEXT,entity_type TEXT,entity_id TEXT,payload TEXT);
  `);
  return database;
}

// حسابدار آن دو را عمداً دو تفصیلی جدا در پارسیان تعریف کرده؛ ادغام خودکار
// یعنی نادیده گرفتن تصمیم او.
test('دو کد مقصدِ متفاوت، جلوی ادغام خودکار را می‌گیرند', () => {
  const database = schemaWithCodes();
  database.exec(`
    INSERT INTO contacts (id,name) VALUES ('c1','شرکت آرمان'),('c2','آرمان');
    INSERT INTO analytic_accounts VALUES ('a1','شرکت آرمان','contact','c1','5101'),('a2','آرمان','contact','c2','5102');
  `);
  ensureCounterpartyIdentitySchema(database);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM analytic_accounts').get().n, 2);
  database.close();
});

// بدون این، با حذف ردیف تکراری، نگاشتی که حسابدار دستی ساخته بود بی‌صدا از بین
// می‌رفت و طرف حساب در فایل انتقال بی‌نام بالا می‌آمد.
test('کد مقصدِ ردیف تکراری به طرف حساب نگه‌داشته منتقل می‌شود', () => {
  const database = schemaWithCodes();
  database.exec(`
    INSERT INTO contacts (id,name) VALUES ('c1','شرکت آرمان'),('c2','آرمان');
    INSERT INTO analytic_accounts VALUES ('a1','شرکت آرمان','contact','c1',NULL),('a2','آرمان','contact','c2','5102');
    INSERT INTO journal_lines VALUES ('j1','a2');
  `);
  ensureCounterpartyIdentitySchema(database);
  assert.equal(database.prepare("SELECT external_code AS code FROM analytic_accounts WHERE id='a1'").get().code, '5102');
  assert.equal(database.prepare("SELECT analytic_id AS a FROM journal_lines WHERE id='j1'").get().a, 'a1');
  database.close();
});

test('هر ادغام در Audit Log می‌ماند', () => {
  const database = schemaWithCodes();
  database.exec("INSERT INTO contacts (id,name) VALUES ('c1','شرکت آرمان'),('c2','آرمان')");
  ensureCounterpartyIdentitySchema(database);
  const row = database.prepare("SELECT payload FROM audit_log WHERE action='merge' AND entity_type='contact'").get();
  assert.ok(row, 'ادغامی که اسناد را جابه‌جا می‌کند باید ردپا داشته باشد');
  assert.match(row.payload, /آرمان/);
  database.close();
});
