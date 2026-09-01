import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const databasePath = `/tmp/hesab-yar-firm-${process.pid}.sqlite`;
// بعضی runnerها PID فرایند قبلی را دوباره استفاده می‌کنند؛ fixture قدیمی نباید
// عضویت‌ها را دو بار وارد کند و CI را تصادفی قرمز کند.
rmSync(databasePath, { force: true });
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'firm-owner';
process.env.ADMIN_PASSWORD = 'firm-desk-strong-password-1234';

const database = await import(`../server/db.js?firm=${process.pid}`);
database.ensureAdmin();
const accountant = database.authenticateUser('firm-owner', 'firm-desk-strong-password-1234');

let clientA;
let clientB;

test('the desk lists every file the user is a member of', () => {
  clientA = database.createWorkspace(accountant.id, { name: 'شرکت الف', profileType: 'business' });
  clientB = database.createWorkspace(accountant.id, { name: 'شرکت ب', profileType: 'business' });
  const portfolio = database.firmPortfolio(accountant.id);
  const names = portfolio.clients.map((item) => item.workspace.name).sort((first, second) => first.localeCompare(second, 'fa'));
  assert.deepEqual(names, ['شرکت الف', 'شرکت ب', 'دفتر اصلی'].sort((first, second) => first.localeCompare(second, 'fa')));
  assert.equal(portfolio.summary.clientCount, 3);
});

test('an open explanation request pushes exactly that client to blocked', () => {
  database.runInWorkspace(clientA.id, { role: 'accountant', userId: accountant.id }, () => {
    database.createCollaborationRequest({ entityType: 'general', question: 'سند این واریز چیست؟' });
  });
  const portfolio = database.firmPortfolio(accountant.id, { refresh: true });
  const blocked = portfolio.clients.find((item) => item.workspace.id === clientA.id);
  const other = portfolio.clients.find((item) => item.workspace.id === clientB.id);
  assert.equal(blocked.level, 'blocked');
  assert.deepEqual(blocked.blockers.map((item) => item.id), ['openRequests']);
  assert.equal(other.level, 'ready', 'ایراد یک پرونده نباید روی پروندهٔ دیگر دیده شود');
  assert.equal(portfolio.clients[0].workspace.id, clientA.id, 'پروندهٔ دارای ایراد باید بالای جدول بنشیند');
});

test('recorded activity is counted for the right client only', () => {
  database.runInWorkspace(clientB.id, { role: 'owner', userId: accountant.id }, () => {
    database.insertTransactions({
      transcript: 'فروش نقدی',
      transactions: [{ amount: 5_000_000, type: 'income', category: 'فروش', rawText: 'فروش نقدی' }],
    });
  });
  const portfolio = database.firmPortfolio(accountant.id, { refresh: true });
  const withSale = portfolio.clients.find((item) => item.workspace.id === clientB.id);
  const withoutSale = portfolio.clients.find((item) => item.workspace.id === clientA.id);
  assert.equal(withSale.activity.transactionCount, 1);
  assert.equal(withSale.activity.income, 5_000_000);
  assert.equal(withoutSale.activity.transactionCount, 0);
});

test('a posted transaction leaves the month ledger balanced', () => {
  const portfolio = database.firmPortfolio(accountant.id, { refresh: true });
  for (const client of portfolio.clients) assert.equal(client.ledgerBalanced, true, `${client.workspace.name} نامتوازن است`);
});

test('another accountant never sees a file they were not added to', () => {
  const outsider = database.addWorkspaceMember(clientA.id, {
    username: 'outside-accountant', displayName: 'حسابدار دیگر',
    temporaryPassword: 'another-strong-password-7788', role: 'accountant',
  });
  const portfolio = database.firmPortfolio(outsider.id);
  assert.deepEqual(portfolio.clients.map((item) => item.workspace.id), [clientA.id]);
  assert.equal(portfolio.clients.some((item) => item.workspace.id === clientB.id), false);
});

test('the cache is reused until it is explicitly refreshed', () => {
  const first = database.firmPortfolio(accountant.id, { refresh: true });
  const beforeCount = first.clients.find((item) => item.workspace.id === clientB.id).activity.transactionCount;
  database.runInWorkspace(clientB.id, { role: 'owner', userId: accountant.id }, () => {
    database.insertTransactions({
      transcript: 'فروش دوم',
      transactions: [{ amount: 1_000_000, type: 'income', category: 'فروش', rawText: 'فروش دوم' }],
    });
  });
  const cached = database.firmPortfolio(accountant.id);
  assert.equal(cached.clients.find((item) => item.workspace.id === clientB.id).activity.transactionCount, beforeCount);
  const fresh = database.firmPortfolio(accountant.id, { refresh: true });
  assert.equal(fresh.clients.find((item) => item.workspace.id === clientB.id).activity.transactionCount, beforeCount + 1);
});

test('invalidating one client forces only that client to be recomputed', () => {
  database.runInWorkspace(clientA.id, { role: 'owner', userId: accountant.id }, () => {
    database.insertTransactions({
      transcript: 'هزینه پیک',
      transactions: [{ amount: 300_000, type: 'expense', category: 'حمل‌ونقل', rawText: 'هزینه پیک' }],
    });
  });
  assert.equal(
    database.firmPortfolio(accountant.id).clients.find((item) => item.workspace.id === clientA.id).activity.transactionCount,
    0,
    'بدون باطل‌کردن cache نباید عدد تازه دیده شود',
  );
  database.invalidateFirmCache(clientA.id);
  assert.equal(
    database.firmPortfolio(accountant.id).clients.find((item) => item.workspace.id === clientA.id).activity.transactionCount,
    1,
  );
});
