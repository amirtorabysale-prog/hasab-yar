import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const databasePath = `/tmp/hesab-yar-invoicing-${process.pid}.sqlite`;
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'invoice-owner';
process.env.ADMIN_PASSWORD = randomBytes(24).toString('base64url');

const database = await import(`../server/db.js?invoice=${process.pid}`);
const accounting = await import(`../server/accounting.js?invoice=${process.pid}`);
database.ensureAdmin();

function inPrimary(callback) {
  return database.runInWorkspace('primary', { role: 'owner', userId: 'invoice-test-owner' }, callback);
}

test('posts a sales invoice to receivable and supports exact partial collections', () => inPrimary(() => {
  const contact = database.saveContact({ name: 'فروشگاه سپید', kind: 'customer' });
  const invoice = database.createInvoice({
    documentType: 'sales', contactId: contact.id, customerName: contact.name, category: 'فروش',
    issueNow: true, issuedAt: '2026-07-02T09:00:00.000Z', dueAt: '2026-07-20T09:00:00.000Z',
    items: [{ title: 'خدمات ماهانه', quantity: 2, unitPrice: 500_000 }],
  });
  assert.equal(invoice.status, 'sent');
  assert.equal(invoice.total, 1_000_000);
  let trial = accounting.trialBalance(database.activeWorkspaceDatabase());
  assert.equal(trial.balanced, true);
  assert.equal(trial.rows.find((row) => row.name.includes('حساب دریافتنی')).debitBalance, 1_000_000);
  assert.equal(trial.rows.find((row) => row.name === 'فروش').creditBalance, 1_000_000);

  const partial = database.recordInvoicePayment(invoice.id, { amount: 400_000, occurredAt: '2026-07-10T09:00:00.000Z', accountId: 'cash' });
  assert.equal(partial.displayStatus, 'partial');
  assert.equal(partial.paidAmount, 400_000);
  assert.equal(partial.balanceDue, 600_000);
  assert.equal(database.listInvoices().summary.receivable, 600_000);
  assert.throws(() => database.recordInvoicePayment(invoice.id, { amount: 600_001 }), (error) => error.code === 'INVOICE_OVERPAYMENT');

  const paid = database.recordInvoicePayment(invoice.id, { amount: 600_000, occurredAt: '2026-07-12T09:00:00.000Z', accountId: 'cash' });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.balanceDue, 0);
  trial = accounting.trialBalance(database.activeWorkspaceDatabase());
  assert.equal(trial.balanced, true);
  assert.equal(trial.rows.find((row) => row.name.includes('حساب دریافتنی')).debitBalance, 0);
  assert.equal(trial.rows.find((row) => row.name === 'صندوق نقدی').debitBalance, 1_000_000);
  assert.equal(database.listTransactions({ query: invoice.number }).total, 2);
}));

test('posts purchase payables and reverses an unpaid issued invoice on cancellation', () => inPrimary(() => {
  const vendor = database.saveContact({ name: 'تأمین کالای پارس', kind: 'vendor' });
  const bill = database.createInvoice({
    documentType: 'purchase', contactId: vendor.id, customerName: vendor.name, category: 'مواد و کالا',
    issueNow: true, issuedAt: '2026-07-03T09:00:00.000Z',
    items: [{ title: 'مواد مصرفی', quantity: 1, unitPrice: 500_000 }],
  });
  database.recordInvoicePayment(bill.id, { amount: 200_000, occurredAt: '2026-07-14T09:00:00.000Z', accountId: 'cash' });
  let trial = accounting.trialBalance(database.activeWorkspaceDatabase());
  assert.equal(trial.rows.find((row) => row.name.includes('حساب پرداختنی')).creditBalance, 300_000);
  assert.equal(database.listInvoices().summary.payable, 300_000);

  const cancellable = database.createInvoice({
    documentType: 'sales', customerName: 'مشتری آزمایشی', issueNow: true, issuedAt: '2026-07-05T09:00:00.000Z',
    items: [{ title: 'خدمت لغوشده', quantity: 1, unitPrice: 120_000 }],
  });
  assert.equal(database.deleteInvoice(cancellable.id), true);
  assert.equal(database.getInvoice(cancellable.id).status, 'cancelled');
  trial = accounting.trialBalance(database.activeWorkspaceDatabase());
  assert.equal(trial.balanced, true);
  const entries = accounting.listJournal(database.activeWorkspaceDatabase(), { limit: 100 }).items.filter((entry) => entry.sourceId === cancellable.id);
  assert.equal(entries.length, 2);
  assert.ok(entries.some((entry) => entry.entryKind === 'reversal'));
  assert.equal(database.deleteInvoice(bill.id), false);
}));

test('keeps drafts outside the ledger and obeys locked Persian accounting periods', () => inPrimary(() => {
  const draft = database.createInvoice({ customerName: 'پیش‌نویس مشتری', issueNow: false, items: [{ title: 'پیش‌نویس', quantity: 1, unitPrice: 90_000 }] });
  assert.equal(draft.status, 'draft');
  assert.equal(accounting.listJournal(database.activeWorkspaceDatabase(), { limit: 100 }).items.some((entry) => entry.sourceId === draft.id), false);
  const period = accounting.periodForDate('2026-07-22T09:00:00.000Z');
  accounting.lockAccountingPeriod(database.activeWorkspaceDatabase(), period, 'invoice-test-owner');
  assert.throws(() => database.issueInvoice(draft.id, { issuedAt: '2026-07-22T09:00:00.000Z' }), (error) => error.code === 'ACCOUNTING_PERIOD_LOCKED');
}));

test.after(() => {
  database.closeWorkspaceDatabases();
  database.db.close();
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
});
