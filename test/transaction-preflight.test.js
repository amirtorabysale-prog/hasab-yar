import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
process.env.DATABASE_PATH = tempDatabase('preflight');
process.env.ADMIN_USERNAME = 'preview-owner';
process.env.ADMIN_PASSWORD = `preview-${crypto.randomUUID()}`;
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const run = fn => database.runInWorkspace('primary', { role: 'owner', userId: owner.id }, fn);
const item = { amount: 9000000, type: 'expense', category: 'قبوض', accountId: 'cash', source: 'text', confidence: 1 };

test('preflight is read-only and uses current workspace policy', () => run(() => {
  const db = database.activeWorkspaceDatabase();
  database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: false });
  const input = { transcript: 'نه میلیون قبض برق پرداخت کردم', transactions: [item] };
  assert.equal(database.previewTransactions(input)[0].decisionStatus, null);
  database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, shadowMode: false });
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  const result = database.previewTransactions(input)[0];
  assert.ok(result.decisionStatus);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
}));
test('preflight holds unknown bank and correction without writing rows', () => run(() => {
  assert.equal(database.previewTransactions({ transactions: [{ ...item, accountId: undefined, bankId: 'saman' }] })[0].route, 'confirm');
  const result = database.previewTransactions({ transcript: 'فاکتور خرید دیروز اشتباها بیست و یک میلیون ثبت شده بود اصلاحش کن', transactions: [item] });
  assert.equal(result[0].route, 'accountant-review');
}));
test('preflight rejects invalid batch and account', () => run(() => {
  assert.throws(() => database.previewTransactions({ transactions: [] }));
  assert.throws(() => database.previewTransactions({ transactions: [{ ...item, accountId: 'not-in-workspace' }] }));
}));
test('preflight uses real counterparty balance for settlement', () => run(() => {
  database.installChartTemplate();
  const contact = database.saveContact({ name: 'طرف حساب آزمون پیش نمایش' });
  database.saveObligation({ title: 'خرید قبلی', amount: 10000000, direction: 'payable', contactId: contact.id });
  const input = { transcript: 'نه میلیون پرداخت کردم', transactions: [{ ...item, contactId: contact.id }] };
  const result = database.previewTransactions(input)[0];
  assert.equal(result.eventKind, 'obligation-settled');
  const regular = database.previewTransactions({ ...input, transactions: [{ ...item, contactId: contact.id, settlement: 'none' }] })[0];
  assert.notEqual(regular.eventKind, 'obligation-settled');
}));
