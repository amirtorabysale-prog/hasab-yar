import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const databasePath = `/tmp/hesab-yar-ledger-${process.pid}.sqlite`;
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'ledger-owner';
process.env.ADMIN_PASSWORD = 'ledger-safe-password-4829';

const database = await import(`../server/db.js?ledger=${process.pid}`);
const accounting = await import(`../server/accounting.js?ledger=${process.pid}`);
database.ensureAdmin();

function inPrimary(callback) {
  return database.runInWorkspace('primary', { role: 'owner', userId: 'test-owner' }, callback);
}

test('posts every cash transaction as a balanced double-entry journal', () => inPrimary(() => {
  database.insertTransactions({ transcript: 'ثبت‌های دفتر کل', transactions: [
    { amount: 1_000_000, type: 'income', category: 'فروش', rawText: 'یک میلیون فروش', occurredAt: '2026-05-10T10:00:00.000Z' },
    { amount: 250_000, type: 'expense', category: 'مواد و کالا', rawText: 'دویست و پنجاه مواد', occurredAt: '2026-05-11T10:00:00.000Z' },
  ] });
  const balance = accounting.trialBalance(database.activeWorkspaceDatabase());
  assert.equal(balance.balanced, true);
  assert.equal(balance.totals.debit, 1_250_000);
  assert.equal(balance.totals.credit, 1_250_000);
  assert.equal(balance.rows.find((row) => row.name === 'صندوق نقدی').debitBalance, 750_000);
  assert.equal(balance.rows.find((row) => row.name === 'فروش').creditBalance, 1_000_000);
  assert.equal(balance.rows.find((row) => row.name === 'مواد و کالا').debitBalance, 250_000);
}));

test('uses immutable reversal entries for transaction edits and deletes', () => inPrimary(() => {
  const income = database.listTransactions({ query: 'یک میلیون فروش' }).items[0];
  database.updateTransaction(income.id, { amount: 1_200_000 });
  const afterEdit = accounting.listJournal(database.activeWorkspaceDatabase(), { limit: 20 });
  assert.equal(afterEdit.items.filter((entry) => entry.sourceId === income.id).length, 3);
  assert.ok(afterEdit.items.some((entry) => entry.sourceId === income.id && entry.entryKind === 'reversal'));
  const expense = database.listTransactions({ query: 'دویست و پنجاه مواد' }).items[0];
  database.deleteTransaction(expense.id);
  const balance = accounting.trialBalance(database.activeWorkspaceDatabase());
  assert.equal(balance.balanced, true);
  assert.equal(balance.rows.find((row) => row.name === 'صندوق نقدی').debitBalance, 1_200_000);
  assert.equal(balance.rows.find((row) => row.name === 'مواد و کالا').debitBalance, 0);
}));

test('rejects unbalanced adjustments and accepts a balanced correction', () => inPrimary(() => {
  const db = database.activeWorkspaceDatabase();
  const accounts = accounting.listLedgerAccounts(db);
  const cash = accounts.find((account) => account.name === 'صندوق نقدی');
  const materials = accounts.find((account) => account.name === 'مواد و کالا');
  assert.throws(() => accounting.createAdjustingJournal(db, {
    memo: 'سند نامتوازن', occurredAt: '2026-05-12T10:00:00.000Z',
    lines: [{ accountId: materials.id, debit: 100_000 }, { accountId: cash.id, credit: 90_000 }],
  }), (error) => error.code === 'JOURNAL_UNBALANCED');
  const item = accounting.createAdjustingJournal(db, {
    memo: 'اصلاح مصرف مواد', occurredAt: '2026-05-12T10:00:00.000Z',
    lines: [{ accountId: materials.id, debit: 100_000 }, { accountId: cash.id, credit: 100_000 }],
  }, { createdBy: 'test-owner' });
  assert.equal(item.entryKind, 'adjustment');
  assert.equal(accounting.trialBalance(db).balanced, true);
}));

test('blocks every mutation in a locked period and records controlled reopening', () => inPrimary(() => {
  const db = database.activeWorkspaceDatabase();
  const period = accounting.periodForDate('2026-05-20T10:00:00.000Z');
  const locked = accounting.lockAccountingPeriod(db, period, 'test-owner');
  assert.equal(locked.status, 'locked');
  assert.throws(() => database.insertTransactions({ transcript: 'بعد از بستن', transactions: [
    { amount: 10_000, type: 'expense', category: 'سایر هزینه‌ها', rawText: 'بعد از بستن', occurredAt: '2026-05-20T10:00:00.000Z' },
  ] }), (error) => error.code === 'ACCOUNTING_PERIOD_LOCKED');
  assert.throws(() => accounting.reopenAccountingPeriod(db, period, 'test-owner', 'کوتاه'), /حداقل ۱۰ نویسه/);
  const reopened = accounting.reopenAccountingPeriod(db, period, 'test-owner', 'اصلاح ثبت اشتباه تأییدشده');
  assert.equal(reopened.status, 'open');
  assert.match(reopened.reopenReason, /اصلاح ثبت/);
  assert.doesNotThrow(() => database.insertTransactions({ transcript: 'بعد از بازگشایی', transactions: [
    { amount: 10_000, type: 'expense', category: 'سایر هزینه‌ها', rawText: 'بعد از بازگشایی', occurredAt: '2026-05-20T10:00:00.000Z' },
  ] }));
}));

test('migrates a legacy transaction exactly once', () => inPrimary(() => {
  const db = database.activeWorkspaceDatabase();
  db.prepare(`INSERT INTO transactions (id,amount,type,category,raw_text,account,account_id,occurred_at,status)
    VALUES ('legacy-ledger-row',50000,'income','خدمات','ثبت قدیمی','cash','cash','2026-06-01T10:00:00.000Z','confirmed')`).run();
  accounting.migrateAccountingLedger(db);
  accounting.migrateAccountingLedger(db);
  const count = db.prepare("SELECT COUNT(*) AS count FROM journal_entries WHERE source_type='transaction' AND source_id='legacy-ledger-row'").get().count;
  assert.equal(count, 1);
  assert.equal(accounting.trialBalance(db).balanced, true);
}));

test.after(() => {
  database.closeWorkspaceDatabases();
  database.db.close();
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
});
