import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { canonicalCounterpartyName, exactCounterpartyKey } from '../shared/counterpartyIdentity.js';
import {
  ensureCounterpartyIdentitySchema, matchCounterparty, mergeCounterparties, resolveCounterparty,
} from '../server/counterparties.js';

// ------------------------------------------------------------------ کلیدها

test('شکل حقوقی نام را «مشابه» می‌کند، نه «یکسان»', () => {
  assert.equal(canonicalCounterpartyName('شرکت آرمان (سهامی خاص)'), canonicalCounterpartyName('آرمان'));
  assert.notEqual(exactCounterpartyKey('شرکت آرمان'), exactCounterpartyKey('آرمان'));
});

test('تفاوت نوشتاری صرف، همان نام است', () => {
  assert.equal(exactCounterpartyKey('مرتضي‌رضایی'), exactCounterpartyKey('مرتضی رضایی'));
  assert.equal(exactCounterpartyKey('آرمان، سهامی'), exactCounterpartyKey('آرمان سهامی'));
});

test('نام‌های واقعاً متفاوت جدا می‌مانند', () => {
  assert.notEqual(canonicalCounterpartyName('آرمان تجارت'), canonicalCounterpartyName('آرمان صنعت'));
});

/**
 * «آقای رضایی» و «خانم رضایی» دو نفرند.
 *
 * وقتی عنوان شخص هم حذف می‌شد، هر دو «رضایی» می‌شدند و طلب و بدهی دو آدم روی یک
 * طرف حساب می‌نشست.
 */
test('عنوان شخص هویت را عوض می‌کند', () => {
  assert.notEqual(canonicalCounterpartyName('آقای رضایی'), canonicalCounterpartyName('خانم رضایی'));
  assert.notEqual(canonicalCounterpartyName('دکتر احمدی'), canonicalCounterpartyName('مهندس احمدی'));
});

// ------------------------------------------------------------------ پرسش

function contactsDatabase(rows = []) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE contacts (id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT,phone TEXT,note TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE transactions (id TEXT PRIMARY KEY,contact_id TEXT);
    CREATE TABLE obligations (id TEXT PRIMARY KEY,contact_id TEXT);
    CREATE TABLE invoices (id TEXT PRIMARY KEY,contact_id TEXT);
    CREATE TABLE analytic_accounts (id TEXT PRIMARY KEY,name TEXT,source_kind TEXT,source_key TEXT,external_code TEXT);
    CREATE TABLE journal_lines (id TEXT PRIMARY KEY,analytic_id TEXT);
    CREATE TABLE audit_log (id TEXT PRIMARY KEY,action TEXT,entity_type TEXT,entity_id TEXT,payload TEXT);
  `);
  const insert = database.prepare('INSERT INTO contacts (id,name) VALUES (?,?)');
  for (const [id, name] of rows) insert.run(id, name);
  ensureCounterpartyIdentitySchema(database);
  return database;
}

test('همان نوشته بی‌پرسش همان طرف حساب است', () => {
  const database = contactsDatabase([['c1', 'شرکت آرمان']]);
  assert.equal(resolveCounterparty(database, 'شرکت  آرمان').contact.id, 'c1');
  database.close();
});

/**
 * ادغامِ «مشابه» تصمیم ثبت‌کننده است، نه برنامه.
 *
 * «آرمان» شاید همان «شرکت آرمان» باشد، شاید نه. سرور خطای پرسش می‌دهد و همان
 * درخواست با جواب کاربر دوباره می‌آید.
 */
test('نام مشابه بدون پاسخ ثبت‌کننده به پرسش تبدیل می‌شود', () => {
  const database = contactsDatabase([['c1', 'شرکت آرمان']]);
  assert.throws(() => resolveCounterparty(database, 'آرمان'), (error) => {
    assert.equal(error.code, 'COUNTERPARTY_SIMILAR');
    assert.equal(error.status, 409);
    assert.deepEqual(error.details.existing, { id: 'c1', name: 'شرکت آرمان' });
    return true;
  });
  database.close();
});

test('پاسخ «همان است» به طرف حساب موجود و «جداست» به طرف حساب تازه می‌رسد', () => {
  const database = contactsDatabase([['c1', 'شرکت آرمان']]);
  assert.equal(resolveCounterparty(database, 'آرمان', 'merge').contact.id, 'c1');
  assert.equal(resolveCounterparty(database, 'آرمان', 'separate').contact, null);
  database.close();
});

test('نامی که هیچ شباهتی ندارد پرسشی نمی‌سازد', () => {
  const database = contactsDatabase([['c1', 'شرکت آرمان']]);
  assert.deepEqual(matchCounterparty(database, 'پارس'), { exact: null, similar: null });
  database.close();
});

// ------------------------------------------------------- بدون ادغام خودکار

// این تابع روی هر بار باز شدن دفتر اجرا می‌شود، بی‌آنکه کسی ببیند؛ ادغام در آن
// یعنی یکی کردن مشابه‌ها بدون تأیید.
test('باز شدن دفتر هیچ طرف حسابی را ادغام نمی‌کند', () => {
  const database = contactsDatabase([['c1', 'شرکت آرمان'], ['c2', 'آرمان']]);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 2);
  database.close();
});

// ------------------------------------------------------ ادغام تأییدشده

test('ادغام تأییدشده اسناد و سطرهای سند را به طرف حساب ماندگار می‌بندد', () => {
  const database = contactsDatabase([['kept', 'شرکت آرمان'], ['duplicate', 'آرمان']]);
  database.exec(`
    INSERT INTO obligations VALUES ('o1','duplicate');
    INSERT INTO analytic_accounts VALUES ('a1','شرکت آرمان','contact','kept',NULL),('a2','آرمان','contact','duplicate',NULL);
    INSERT INTO journal_lines VALUES ('j1','a2');
  `);
  mergeCounterparties(database, 'kept', 'duplicate');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 1);
  assert.equal(database.prepare("SELECT contact_id AS c FROM obligations WHERE id='o1'").get().c, 'kept');
  assert.equal(database.prepare("SELECT analytic_id AS a FROM journal_lines WHERE id='j1'").get().a, 'a1');
  database.close();
});

// حسابدار آن دو را عمداً دو تفصیلی جدا در پارسیان تعریف کرده.
test('دو کد مقصدِ متفاوت ادغام را رد می‌کنند و چیزی تغییر نمی‌کند', () => {
  const database = contactsDatabase([['c1', 'شرکت آرمان'], ['c2', 'آرمان']]);
  database.exec("INSERT INTO analytic_accounts VALUES ('a1','شرکت آرمان','contact','c1','5101'),('a2','آرمان','contact','c2','5102')");
  assert.throws(() => mergeCounterparties(database, 'c1', 'c2'), /COUNTERPARTY_MERGE_CONFLICT|دو کد تفصیلی/);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 2);
  database.close();
});

// بدون این، نگاشتی که حسابدار دستی ساخته بود بی‌صدا از بین می‌رفت.
test('کد مقصدِ ردیف حذف‌شده به طرف حساب ماندگار منتقل می‌شود', () => {
  const database = contactsDatabase([['c1', 'شرکت آرمان'], ['c2', 'آرمان']]);
  database.exec("INSERT INTO analytic_accounts VALUES ('a1','شرکت آرمان','contact','c1',NULL),('a2','آرمان','contact','c2','5102')");
  mergeCounterparties(database, 'c1', 'c2');
  assert.equal(database.prepare("SELECT external_code AS code FROM analytic_accounts WHERE id='a1'").get().code, '5102');
  database.close();
});

test('هر ادغام در Audit Log می‌ماند', () => {
  const database = contactsDatabase([['c1', 'شرکت آرمان'], ['c2', 'آرمان']]);
  mergeCounterparties(database, 'c1', 'c2', { actor: 'user-1' });
  const row = database.prepare("SELECT payload FROM audit_log WHERE action='merge' AND entity_type='contact'").get();
  assert.ok(row);
  assert.match(row.payload, /user-1/);
  database.close();
});
