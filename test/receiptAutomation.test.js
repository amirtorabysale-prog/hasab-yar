import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

const databasePath = tempDatabase('receipts');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'receipt-owner';
process.env.ADMIN_PASSWORD = randomBytes(24).toString('base64url');

const database = await import(`../server/db.js?receipts=${process.pid}`);
database.ensureAdmin();

function inPrimary(callback) {
  return database.runInWorkspace('primary', { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: 'receipt-test-owner' }, callback);
}

test('keeps OCR suggestions in review and learns merchant rules only after an explicit save', () => inPrimary(() => {
  const account = database.saveAccount({ name: 'کارت خرید', kind: 'bank', openingBalance: 0 });
  database.saveAutomationRule({ source: 'merchant', pattern: 'فروشگاه نمونه', type: 'expense', category: 'مواد و کالا', accountId: account.id });
  const receipt = database.saveReceipt({
    buffer: Buffer.from('private-image'), fileName: 'receipt.jpg', mimeType: 'image/jpeg', amount: 850_000, type: 'expense',
    merchant: 'شعبه مرکزی فروشگاه نمونه', occurredAt: '2026-08-24T12:30:00.000Z', status: 'review',
    ocrProvider: 'openai', ocrConfidence: 0.81, fieldConfidence: { amount: 0.94 }, reviewReasons: ['تاریخ را کنترل کن.'],
  });
  assert.equal(receipt.category, 'مواد و کالا');
  assert.equal(receipt.accountId, account.id);
  assert.deepEqual(receipt.reviewReasons, ['تاریخ را کنترل کن.']);
  assert.equal(database.listAutomationRules('merchant').length, 1);
}));

test('links a reviewed receipt, a new ledger transaction and an unmatched bank line atomically', () => inPrimary(() => {
  const account = database.listAccounts().find((item) => item.name === 'کارت خرید');
  const statement = database.importBankStatement({
    buffer: Buffer.from('date,description,credit,debit,balance\n2026-08-24,فروشگاه نمونه,,850000,-850000'),
    fileName: 'card.csv', accountId: account.id,
  });
  const receipt = database.saveReceipt({
    buffer: Buffer.from('private-image-2'), fileName: 'receipt-2.jpg', mimeType: 'image/jpeg', amount: 850_000,
    type: 'expense', category: 'مواد و کالا', accountId: account.id, merchant: 'فروشگاه نمونه', occurredAt: '2026-08-24T10:00:00.000Z', status: 'ready',
  });
  const candidates = database.receiptCandidates(receipt.id);
  assert.equal(candidates.statementLines[0].id, statement.lines[0].id);
  assert.match(candidates.statementLines[0].reasons.join(' '), /مبلغ و نوع برابر/);
  const linked = database.confirmReceipt(receipt.id, { statementLineId: statement.lines[0].id });
  assert.equal(linked.status, 'linked');
  assert.ok(linked.transactionId);
  assert.equal(database.getReconciliationImport(statement.id).matchedCount, 1);
  assert.equal(database.listTransactions({ query: 'فروشگاه نمونه' }).total, 1);
}));

test.after(() => {
  database.closeWorkspaceDatabases();
  database.db.close();
  removeTempDatabase(databasePath);
});
