import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const databasePath = `/tmp/hesab-yar-core-${process.pid}.sqlite`;
process.env.DATABASE_PATH = databasePath;
const core = await import(`../server/db.js?core=${process.pid}`);

test('supports searchable transactions with safe update and soft delete', () => {
  const [id] = core.insertTransactions({ transcript: 'هفت میلیون فروش داشتم', transactions: [{ amount: 7_000_000, type: 'income', category: 'فروش', rawText: 'هفت میلیون فروش داشتم' }] });
  assert.equal(core.listTransactions({ query: 'هفت' }).items[0].amount, 7_000_000);
  assert.equal(core.updateTransaction(id, { amount: 7_500_000, note: 'اصلاح‌شده' }).amount, 7_500_000);
  assert.equal(core.deleteTransaction(id), true);
  assert.equal(core.listTransactions().total, 0);
});

test('settles receivables into a linked income transaction', () => {
  const contact = core.saveContact({ name: 'حسن مشتری' });
  const debt = core.saveObligation({ title: 'باقی‌مانده فاکتور', amount: 2_000_000, direction: 'receivable', contactId: contact.id });
  const settled = core.settleObligation(debt.id);
  assert.equal(settled.item.status, 'paid');
  assert.equal(settled.transaction.type, 'income');
  assert.equal(settled.transaction.contactName, 'حسن مشتری');
});

test('creates and collects an invoice without double entry', () => {
  const invoice = core.createInvoice({ customerName: 'مشتری نمونه', items: [{ title: 'خدمت', quantity: 2, unitPrice: 600_000 }] });
  assert.equal(invoice.total, 1_200_000);
  assert.equal(core.markInvoicePaid(invoice.id).status, 'paid');
  const countAfterFirstCollection = core.listTransactions({ query: invoice.number }).total;
  core.markInvoicePaid(invoice.id);
  assert.equal(core.listTransactions({ query: invoice.number }).total, countAfterFirstCollection);
});

test('answers financial questions only from stored aggregates', () => {
  const result = core.answerFinancialQuestion('این ماه چقدر درآمد داشتم؟');
  assert.match(result.answer, /درآمد/);
  assert.equal(result.deterministic, true);
});

test('stores receipt images privately with parsed financial metadata', () => {
  const item = core.saveReceipt({ buffer: Buffer.from('fake-image'), fileName: 'receipt.webp', mimeType: 'image/webp', note: 'مواد', amount: 800_000, type: 'expense', category: 'مواد و کالا' });
  assert.equal(item.amount, 800_000);
  assert.equal(core.receiptImage(item.id).imageData.toString(), 'fake-image');
});

test('tracks lightweight inventory and low-stock warnings', () => {
  const product = core.saveProduct({ name: 'رنگ مو', stock: 5, unit: 'عدد', lowThreshold: 2, salePrice: 400_000 });
  const adjusted = core.adjustStock(product.id, { quantity: -3, note: 'مصرف' });
  assert.equal(adjusted.stock, 2);
  assert.equal(adjusted.isLow, 1);
  assert.throws(() => core.adjustStock(product.id, { quantity: -10 }), /منفی/);
});

test.after(() => {
  core.db.close();
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
});
