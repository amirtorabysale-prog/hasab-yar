import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { parseBankCsv } from '../server/reconciliation.js';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('reconciliation');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'reconciliation-owner';
process.env.ADMIN_PASSWORD = randomBytes(24).toString('base64url');

const database = await import(`../server/db.js?reconciliation=${process.pid}`);
database.ensureAdmin();

function inPrimary(callback) {
  return database.runInWorkspace('primary', { role: 'owner', userId: 'reconciliation-test-owner' }, callback);
}

test('parses Persian digits, Jalali dates and separate debit/credit columns', () => {
  const rows = parseBankCsv(Buffer.from('تاریخ,شرح,واریز,برداشت,مانده\n۱۴۰۵/۰۵/۰۱,فروش,۵۰۰٬۰۰۰,,۵۰۰٬۰۰۰\n۱۴۰۵/۰۵/۰۲,کارمزد,,۱۰۰٬۰۰۰,۴۰۰٬۰۰۰'));
  assert.equal(rows.length, 2);
  assert.match(rows[0].occurredAt, /^2026-07-23/);
  assert.deepEqual(rows.map((row) => [row.amount, row.direction, row.statementBalance]), [
    [500_000, 'income', 500_000], [100_000, 'expense', 400_000],
  ]);
});

test('matches existing money, creates missing entries and closes only at zero difference', () => inPrimary(() => {
  const account = database.saveAccount({ name: 'حساب بانک تست', kind: 'bank', openingBalance: 0 });
  const [transactionId] = database.insertTransactions({ transcript: 'فروش کارتخوان', transactions: [{
    amount: 500_000, type: 'income', category: 'فروش', rawText: 'فروش کارتخوان', accountId: account.id,
    occurredAt: '2026-07-23T09:00:00.000Z',
  }] });
  const csv = Buffer.from('date,description,credit,debit,balance,reference\n2026-07-23,فروش کارتخوان,500000,,500000,A1\n2026-07-24,کارمزد بانک,,100000,400000,A2');
  let imported = database.importBankStatement({ buffer: csv, fileName: 'bank-july.csv', accountId: account.id });
  assert.equal(imported.rowCount, 2);
  assert.equal(imported.lines[0].candidates[0].id, transactionId);
  assert.equal(imported.lines[0].candidates[0].score, 100);
  assert.throws(() => database.closeBankReconciliation(imported.id), (error) => error.code === 'RECONCILIATION_INCOMPLETE');

  imported = database.matchReconciliationLine(imported.lines[0].id, transactionId);
  assert.equal(imported.matchedCount, 1);
  assert.throws(() => database.matchReconciliationLine(imported.lines[1].id, transactionId), (error) => error.code === 'STATEMENT_MATCH_MISMATCH');
  imported = database.createTransactionFromStatementLine(imported.lines[1].id, { category: 'سایر هزینه‌ها' });
  assert.equal(imported.unmatchedCount, 0);
  assert.equal(imported.bookBalance, 400_000);
  assert.equal(imported.statementBalance, 400_000);
  assert.equal(imported.difference, 0);
  const closed = database.closeBankReconciliation(imported.id);
  assert.equal(closed.status, 'reconciled');
  assert.equal(database.listTransactions({ query: 'کارمزد بانک' }).total, 1);
  assert.throws(() => database.importBankStatement({ buffer: csv, fileName: 'renamed.csv', accountId: account.id }), (error) => error.code === 'STATEMENT_DUPLICATE');
}));

test('requires an auditable reason for ignored rows', () => inPrimary(() => {
  const account = database.listAccounts().find((item) => item.name === 'حساب بانک تست');
  const csv = Buffer.from('date,amount,type,description\n2026-07-25,-25000,expense,ردیف خارج از دفتر');
  let imported = database.importBankStatement({ buffer: csv, fileName: 'ignored.csv', accountId: account.id });
  assert.throws(() => database.ignoreReconciliationLine(imported.lines[0].id, 'کم'), /حداقل ۵ نویسه/);
  imported = database.ignoreReconciliationLine(imported.lines[0].id, 'انتقال داخلی خارج از دامنه');
  assert.equal(imported.ignoredCount, 1);
  assert.equal(database.closeBankReconciliation(imported.id).status, 'reconciled');
}));

test.after(() => {
  database.closeWorkspaceDatabases();
  database.db.close();
  removeTempDatabase(databasePath);
});
