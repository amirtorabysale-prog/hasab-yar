import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * کارت حساب بانک و صندوق.
 *
 * درخواست مالک محصول، مهر ۱۴۰۵: «برای هر حسابی باید کارت حساب داشته باشیم».
 * تا امروز فقط اشخاص کارت داشتند؛ بانک فقط یک عدد مانده در تنظیمات بود و
 * معلوم نبود آن عدد از کجا آمده.
 *
 * کارت باید همان عددی را بگوید که فهرست حساب‌ها می‌گوید، و برای هر ردیف بگوید
 * پول از کجا آمد یا به کجا رفت.
 */
const databasePath = tempDatabase('money-card');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'money-card-owner';
process.env.ADMIN_PASSWORD = 'money-card-strong-password-5521';

const database = await import(`../server/db.js?moneycard=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('money-card-owner', 'money-card-strong-password-5521');
const workspace = database.createWorkspace(owner.id, { name: 'شرکت کارت بانک', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

test('کارت بانک: افتتاحیه، پرداخت، دریافت و انتقال، با مانده‌ای برابر فهرست', () => inWorkspace(() => {
  const mellat = database.saveAccount({ name: 'جاری ملت', kind: 'bank', openingBalance: 50_000_000 });
  const at = '2026-10-08T08:00:00.000Z';
  database.insertTransactions({ transcript: 'اجاره و فروش', transactions: [
    { amount: 6_000_000, type: 'expense', category: 'اجاره', accountId: mellat.id, occurredAt: at },
    { amount: 9_000_000, type: 'income', category: 'فروش', accountId: mellat.id, occurredAt: at },
  ] });
  database.transferBetweenAccounts({ fromAccountId: mellat.id, toAccountId: 'cash', amount: 3_000_000, occurredAt: at });

  const card = database.moneyAccountCard(mellat.id);
  const listed = database.listAccounts().find((item) => item.id === mellat.id).balance;
  assert.equal(card.totals.balance, 50_000_000 - 6_000_000 + 9_000_000 - 3_000_000);
  assert.equal(card.totals.balance, listed, 'کارت و فهرست یک عدد');
  assert.equal(card.reconciliation.unexplained, 0);
  assert.ok(card.lines.some((line) => line.debit === 50_000_000), 'افتتاحیه یک ردیف کارت است');
  const rent = card.lines.find((line) => line.credit === 6_000_000);
  assert.match(rent.counterpart, /اجاره/, 'طرف مقابلِ پرداخت، حساب هزینهٔ اجاره است');
  const transfer = card.lines.find((line) => line.credit === 3_000_000);
  assert.match(transfer.counterpart, /صندوق/);

  // کارت صندوق همان انتقال را از سمت دیگر می‌بیند.
  const cash = database.moneyAccountCard('cash');
  assert.ok(cash.lines.some((line) => line.debit === 3_000_000));
}));

test('حساب ناموجود خطای روشن می‌دهد', () => inWorkspace(() => {
  assert.throws(() => database.moneyAccountCard('nope'), /پیدا نشد/);
}));

test.after(() => removeTempDatabase(databasePath));
