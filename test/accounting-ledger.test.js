import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('ledger');
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
  const beforeBalance = accounting.trialBalance(db);
  const item = accounting.createAdjustingJournal(db, {
    memo: 'اصلاح مصرف مواد', occurredAt: '2026-05-12T10:00:00.000Z',
    lines: [{ accountId: materials.id, debit: 100_000 }, { accountId: cash.id, credit: 100_000 }],
  }, { createdBy: 'test-owner' });
  assert.equal(item.entryKind, 'adjustment');
  assert.equal(item.approvalState, 'draft');
  const afterBalance = accounting.trialBalance(db);
  assert.equal(afterBalance.balanced, true);
  assert.deepEqual(afterBalance.totals, beforeBalance.totals, 'سند اصلاحی پیش‌نویس وارد تراز قطعی نمی‌شود');
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

// سرمایه و دارایی ثابت هر دو از صندوق رد می‌شوند ولی هیچ‌کدام سود دوره نیستند.
test('آورده و دارایی ثابت، صندوق را تکان می‌دهند و سود دوره را نه', () => inPrimary(() => {
  const cashBefore = database.listAccounts().find((item) => item.id === 'cash').balance;
  const reportBefore = database.report('month').summary;

  database.recordCapitalEntry({ kind: 'capital-in', amount: 50_000_000, title: 'آوردهٔ نقدی مالک', accountId: 'cash' });
  database.recordCapitalEntry({ kind: 'fixed-asset', amount: 30_000_000, title: 'لپ تاپ', accountId: 'cash' });

  const cashAfter = database.listAccounts().find((item) => item.id === 'cash').balance;
  assert.equal(cashAfter, cashBefore + 20_000_000);

  const reportAfter = database.report('month').summary;
  assert.equal(reportAfter.income, reportBefore.income);
  assert.equal(reportAfter.expense, reportBefore.expense);

  const trial = accounting.trialBalance(database.activeWorkspaceDatabase());
  assert.equal(trial.balanced, true);
  assert.equal(trial.rows.find((row) => row.name === 'سرمایه — آوردهٔ مالک').creditBalance, 50_000_000);
  assert.equal(trial.rows.find((row) => row.name === 'دارایی ثابت — لپ تاپ').debitBalance, 30_000_000);
  // دارایی به بهای تمام‌شده می‌نشیند؛ استهلاکی محاسبه نمی‌شود و ادعا هم نمی‌شود.
  assert.equal(trial.rows.some((row) => row.name.includes('استهلاک')), false);
}));

test('ثبت سرمایه بدون عنوان یا با نوع نامعتبر رد می‌شود', () => inPrimary(() => {
  assert.throws(() => database.recordCapitalEntry({ kind: 'fixed-asset', amount: 10_000_000, title: '  ' }));
  assert.throws(() => database.recordCapitalEntry({ kind: 'profit', amount: 10_000_000, title: 'چیزی' }));
  assert.throws(() => database.recordCapitalEntry({ kind: 'capital-in', amount: 0, title: 'آورده' }));
}));

test.after(() => {
  database.closeWorkspaceDatabases();
  database.db.close();
  removeTempDatabase(databasePath);
});
