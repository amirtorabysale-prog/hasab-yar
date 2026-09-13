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
