import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const databasePath = `/tmp/hesab-yar-tax-${process.pid}.sqlite`;
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'tax-owner';
process.env.ADMIN_PASSWORD = randomBytes(24).toString('base64url');

const database = await import(`../server/db.js?tax=${process.pid}`);
const accounting = await import(`../server/accounting.js?tax=${process.pid}`);
database.ensureAdmin();

function inPrimary(callback) {
  return database.runInWorkspace('primary', { role: 'owner', userId: 'tax-test-owner' }, callback);
}

let generalRate;
let salesInvoice;

test('calculates line tax after proportional discount and posts output tax separately', () => inPrimary(() => {
  generalRate = database.saveTaxRate({ name: 'نرخ آزمون عمومی', rate: 10, treatment: 'taxable', active: true, isDefault: true });
  salesInvoice = database.createInvoice({
    documentType: 'sales', customerName: 'مشتری مالیاتی', issueNow: true,
    issuedAt: '2026-07-02T09:00:00.000Z', discount: 100_000,
    items: [{ title: 'خدمت مشمول', quantity: 2, unitPrice: 500_000, taxRateId: generalRate.id }],
  });
  assert.equal(salesInvoice.subtotal, 1_000_000);
  assert.equal(salesInvoice.items[0].taxBase, 900_000);
  assert.equal(salesInvoice.items[0].taxAmount, 90_000);
  assert.equal(salesInvoice.tax, 90_000);
  assert.equal(salesInvoice.total, 990_000);
  assert.equal(salesInvoice.taxCalculation, 'line');

  const trial = accounting.trialBalance(database.activeWorkspaceDatabase());
  assert.equal(trial.balanced, true);
  assert.equal(trial.rows.find((row) => row.name.includes('حساب دریافتنی')).debitBalance, 990_000);
  assert.equal(trial.rows.find((row) => row.name === 'فروش').creditBalance, 900_000);
  assert.equal(trial.rows.find((row) => row.name === 'مالیات و عوارض فروش پرداختنی').creditBalance, 90_000);
}));

test('posts purchase input tax as an asset and reports net tax', () => inPrimary(() => {
  const purchase = database.createInvoice({
    documentType: 'purchase', customerName: 'تأمین‌کننده مالیاتی', category: 'مواد و کالا', issueNow: true,
    issuedAt: '2026-07-03T09:00:00.000Z',
    items: [{ title: 'خدمت خریداری‌شده', quantity: 1, unitPrice: 500_000, taxRateId: generalRate.id }],
  });
  assert.equal(purchase.tax, 50_000);
  assert.equal(purchase.total, 550_000);
  const trial = accounting.trialBalance(database.activeWorkspaceDatabase());
  assert.equal(trial.rows.find((row) => row.name === 'اعتبار مالیات و عوارض خرید').debitBalance, 50_000);
  assert.equal(trial.rows.find((row) => row.name.includes('حساب پرداختنی')).creditBalance, 550_000);

  const report = database.taxReport({ from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' });
  assert.deepEqual({ outputTax: report.summary.outputTax, inputTax: report.summary.inputTax, netTax: report.summary.netTax }, { outputTax: 90_000, inputTax: 50_000, netTax: 40_000 });
  assert.equal(report.summary.taxableSales, 900_000);
  assert.equal(report.summary.taxablePurchases, 500_000);
  assert.match(report.disclaimer, /مدیریتی/);
}));

test('keeps tax snapshots immutable when a configured rate changes', () => inPrimary(() => {
  database.saveTaxRate({ ...generalRate, rate: 12, active: true, isDefault: true });
  const historical = database.getInvoice(salesInvoice.id);
  assert.equal(historical.items[0].taxRateBps, 1000);
  assert.equal(historical.tax, 90_000);

  const current = database.createInvoice({
    documentType: 'sales', customerName: 'مشتری نرخ جدید', issueNow: true, issuedAt: '2026-07-04T09:00:00.000Z',
    items: [{ title: 'خدمت نرخ جدید', quantity: 1, unitPrice: 100_000, taxRateId: generalRate.id }],
  });
  assert.equal(current.items[0].taxRateBps, 1200);
  assert.equal(current.tax, 12_000);
  assert.equal(database.deleteInvoice(current.id), true);
  const report = database.taxReport({ from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' });
  assert.equal(report.summary.outputTax, 90_000);
}));

test('distinguishes zero-rated from exempt sales and rejects inactive rates', () => inPrimary(() => {
  const zeroRate = database.saveTaxRate({ name: 'نرخ صفر آزمون', rate: 0, treatment: 'zero', active: true });
  const exemptRate = database.listTaxRates().find((item) => item.id === 'tax-none');
  const invoice = database.createInvoice({
    documentType: 'sales', customerName: 'مشتری ترکیبی', issueNow: true, issuedAt: '2026-07-05T09:00:00.000Z',
    items: [
      { title: 'فروش نرخ صفر', quantity: 1, unitPrice: 100_000, taxRateId: zeroRate.id },
      { title: 'فروش معاف', quantity: 1, unitPrice: 200_000, taxRateId: exemptRate.id },
    ],
  });
  assert.equal(invoice.tax, 0);
  const report = database.taxReport({ from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' });
  assert.equal(report.summary.zeroSales, 100_000);
  assert.equal(report.summary.exemptSales, 200_000);

  const inactive = database.saveTaxRate({ name: 'نرخ غیرفعال آزمون', rate: 8, treatment: 'taxable', active: false });
  assert.throws(() => database.createInvoice({
    customerName: 'رد نرخ غیرفعال', issueNow: true,
    items: [{ title: 'خدمت', quantity: 1, unitPrice: 100_000, taxRateId: inactive.id }],
  }), (error) => error.code === 'TAX_RATE_MISSING');
  assert.throws(() => database.saveTaxRate({ ...exemptRate, name: 'دست‌کاری نرخ سیستمی' }), (error) => error.code === 'TAX_SYSTEM_RATE');
}));

test('preserves explicitly identified legacy manual tax for review', () => inPrimary(() => {
  const legacy = database.createInvoice({
    documentType: 'sales', customerName: 'سند قدیمی', issueNow: true, issuedAt: '2026-07-06T09:00:00.000Z', tax: 7_000,
    items: [{ title: 'خدمت قدیمی', quantity: 1, unitPrice: 70_000 }],
  });
  assert.equal(legacy.taxCalculation, 'manual');
  const report = database.taxReport({ from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' });
  assert.equal(report.summary.manualTax, 7_000);
  assert.equal(report.rows.find((item) => item.id === legacy.id).manualTax, 7_000);
}));

test('never allocates a negative line discount after rounding', () => inPrimary(() => {
  const rate = database.listTaxRates().find((item) => item.name === 'نرخ آزمون عمومی');
  const invoice = database.createInvoice({
    customerName: 'کنترل گردکردن', issueNow: false, discount: 1,
    items: [
      { title: 'ردیف یک', quantity: 1, unitPrice: 1, taxRateId: rate.id },
      { title: 'ردیف دو', quantity: 1, unitPrice: 1, taxRateId: rate.id },
      { title: 'ردیف سه', quantity: 1, unitPrice: 1, taxRateId: rate.id },
    ],
  });
  assert.equal(invoice.items.reduce((sum, item) => sum + item.taxBase, 0), 2);
  assert.equal(invoice.items.every((item) => item.taxBase >= 0 && item.taxBase <= item.total), true);
}));

test.after(() => {
  database.closeWorkspaceDatabases();
  database.db.close();
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
});
