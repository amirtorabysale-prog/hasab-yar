import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const databasePath = `/tmp/hesab-yar-inventory-${process.pid}.sqlite`;
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'inventory-owner';
process.env.ADMIN_PASSWORD = randomBytes(24).toString('base64url');

const database = await import(`../server/db.js?inventory=${process.pid}`);
const accounting = await import(`../server/accounting.js?inventory=${process.pid}`);
database.ensureAdmin();

function inPrimary(callback) {
  return database.runInWorkspace('primary', { role: 'owner', userId: 'inventory-test-owner' }, callback);
}

test('values opening stock and purchases with perpetual weighted average', () => inPrimary(() => {
  const product = database.saveProduct({ name: 'قهوه ویژه', stock: 10, unit: 'بسته', buyPrice: 100_000, salePrice: 300_000, lowThreshold: 3 });
  assert.equal(product.stock, 10);
  assert.equal(product.inventoryValue, 1_000_000);
  assert.equal(product.averageCost, 100_000);

  const purchase = database.createInvoice({
    documentType: 'purchase', customerName: 'تأمین‌کننده قهوه', issueNow: true, discount: 200_000,
    items: [{ productId: product.id, title: product.name, quantity: 10, unitPrice: 220_000 }],
  });
  assert.equal(purchase.items[0].inventoryCost, 2_000_000);
  const afterPurchase = database.listProducts().find((item) => item.id === product.id);
  assert.equal(afterPurchase.stock, 20);
  assert.equal(afterPurchase.inventoryValue, 3_000_000);
  assert.equal(afterPurchase.averageCost, 150_000);

  const trial = accounting.trialBalance(database.activeWorkspaceDatabase());
  assert.equal(trial.balanced, true);
  assert.equal(trial.rows.find((row) => row.name.includes('موجودی کالا — قهوه ویژه')).debitBalance, 3_000_000);
  assert.equal(trial.rows.find((row) => row.name.includes('حساب پرداختنی')).creditBalance, 2_000_000);
}));

test('posts COGS on sale, rejects overselling and restores stock on cancellation', () => inPrimary(() => {
  const product = database.listProducts().find((item) => item.name === 'قهوه ویژه');
  const sale = database.createInvoice({
    documentType: 'sales', customerName: 'کافه مشتری', issueNow: true,
    items: [{ productId: product.id, title: product.name, quantity: 4, unitPrice: 300_000 }],
  });
  let current = database.listProducts().find((item) => item.id === product.id);
  assert.equal(current.stock, 16);
  assert.equal(current.inventoryValue, 2_400_000);
  let trial = accounting.trialBalance(database.activeWorkspaceDatabase());
  assert.equal(trial.rows.find((row) => row.name.includes('بهای تمام‌شده — قهوه ویژه')).debitBalance, 600_000);
  assert.equal(trial.rows.find((row) => row.name === 'فروش').creditBalance, 1_200_000);
  assert.throws(() => database.createInvoice({
    documentType: 'sales', customerName: 'فروش بیش از موجودی', issueNow: true,
    items: [{ productId: product.id, title: product.name, quantity: 17, unitPrice: 300_000 }],
  }), (error) => error.code === 'INVENTORY_NEGATIVE_STOCK');
  assert.equal(database.listInvoices().items.some((item) => item.customerName === 'فروش بیش از موجودی'), false);

  assert.equal(database.deleteInvoice(sale.id), true);
  current = database.listProducts().find((item) => item.id === product.id);
  assert.equal(current.stock, 20);
  assert.equal(current.inventoryValue, 3_000_000);
  assert.equal(database.inventoryOverview().summary.cogs30, 0);
  trial = accounting.trialBalance(database.activeWorkspaceDatabase());
  assert.equal(trial.balanced, true);
  assert.equal(trial.rows.find((row) => row.name.includes('بهای تمام‌شده — قهوه ویژه')).debitBalance, 0);
  assert.equal(trial.rows.find((row) => row.name === 'فروش').creditBalance, 0);
}));

test('manual adjustments preserve value and create balanced journals', () => inPrimary(() => {
  const product = database.listProducts().find((item) => item.name === 'قهوه ویژه');
  database.adjustStock(product.id, { quantity: 2, unitCost: 180_000, note: 'کشف موجودی ثبت‌نشده' });
  let current = database.listProducts().find((item) => item.id === product.id);
  assert.equal(current.stock, 22);
  assert.equal(current.inventoryValue, 3_360_000);
  database.adjustStock(product.id, { quantity: -2, note: 'ضایعات تأییدشده' });
  current = database.listProducts().find((item) => item.id === product.id);
  assert.equal(current.stock, 20);
  assert.equal(current.inventoryValue, 3_054_546);
  const overview = database.inventoryOverview();
  assert.equal(overview.summary.inventoryValue, current.inventoryValue);
  assert.ok(overview.movements.some((item) => item.note === 'ضایعات تأییدشده'));
  assert.equal(accounting.trialBalance(database.activeWorkspaceDatabase()).balanced, true);
}));

test.after(() => {
  database.closeWorkspaceDatabases();
  database.db.close();
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
});
