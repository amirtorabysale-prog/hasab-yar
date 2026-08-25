import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const databasePath = `/tmp/hesab-yar-accounting-${process.pid}.sqlite`;
process.env.DATABASE_PATH = databasePath;
const core = await import(`../server/db.js?accounting=${process.pid}`);

test('builds Tehran day boundaries from IANA timezone rules', () => {
  const bounds = core.dayBounds('2026-08-22', 'Asia/Tehran');
  assert.equal(bounds.start, '2026-08-21T20:30:00.000Z');
  assert.equal(bounds.endExclusive, '2026-08-22T20:30:00.000Z');
  assert.equal(core.localDay(new Date('2026-08-21T21:00:00.000Z'), 'Asia/Tehran'), '2026-08-22');
});

test('reports exclude deleted entries and use total category share', () => {
  const occurredAt = '2026-08-22T10:00:00.000Z';
  core.insertTransactions({ transcript: 'آزمون گزارش', transactions: [
    { amount: 300_000, type: 'expense', category: 'مواد و کالا', occurredAt },
    { amount: 100_000, type: 'expense', category: 'حمل‌ونقل', occurredAt },
    { amount: 9_000_000, type: 'expense', category: 'حذف‌شده', occurredAt },
  ] });
  const deleted = core.listTransactions({ query: 'آزمون گزارش' }).items.find((item) => item.category === 'حذف‌شده');
  core.deleteTransaction(deleted.id);
  const result = core.report('week', new Date('2026-08-22T12:00:00.000Z'));
  assert.equal(result.basis, 'cash');
  assert.equal(result.summary.expense, 400_000);
  assert.equal(result.categories.find((item) => item.name === 'مواد و کالا').share, 75);
  assert.equal(result.categories.find((item) => item.name === 'حمل‌ونقل').share, 25);
  assert.equal(result.categories.some((item) => item.name === 'حذف‌شده'), false);
});

test('month reports keep transactions on the correct side of a year boundary', () => {
  core.insertTransactions({ transcript: 'مرز سال', transactions: [
    { amount: 700_000, type: 'income', category: 'مرز سال جدید', occurredAt: '2026-12-31T21:00:00.000Z' },
    { amount: 900_000, type: 'income', category: 'خارج بازه', occurredAt: '2026-11-30T20:00:00.000Z' },
  ] });
  const result = core.report('month', new Date('2027-01-01T12:00:00.000Z'));
  assert.equal(result.categories.find((item) => item.name === 'مرز سال جدید').amount, 700_000);
  assert.equal(result.categories.some((item) => item.name === 'خارج بازه'), false);
});

test('daily closing carries the previous counted cash instead of reusing opening balance', () => {
  core.saveSettings({ openingBalance: 1_000_000 });
  core.insertTransactions({ transcript: 'روز اول', transactions: [
    { amount: 500_000, type: 'income', category: 'فروش', occurredAt: '2026-08-22T10:00:00.000Z' },
  ] });
  const preview = core.previewDayClosing({ day: '2026-08-22' });
  assert.equal(core.listDailyClosings().length, 0);
  const first = core.closeDay({ day: '2026-08-22', countedCash: 1_500_000 });
  assert.equal(preview.expectedCash, first.expectedCash);
  assert.equal(first.expectedCash, 1_100_000);

  core.saveSettings({ openingBalance: 9_000_000 });
  core.insertTransactions({ transcript: 'روز دوم', transactions: [
    { amount: 200_000, type: 'expense', category: 'خرید', occurredAt: '2026-08-23T10:00:00.000Z' },
  ] });
  const second = core.closeDay({ day: '2026-08-23', countedCash: 1_300_000 });
  assert.equal(second.expectedCash, 1_300_000);
  assert.equal(second.difference, 0);
});

test('keeps liquid balances separate from non-cash accounts', () => {
  const bank = core.saveAccount({ id: 'bank-main', name: 'حساب بانکی', kind: 'bank', openingBalance: 2_000_000 });
  const clearing = core.saveAccount({ id: 'clearing', name: 'حساب واسط', kind: 'other', openingBalance: 90_000_000 });
  core.insertTransactions({ transcript: 'گردش حساب‌ها', transactions: [
    { amount: 300_000, type: 'income', category: 'فروش', accountId: bank.id },
    { amount: 80_000_000, type: 'income', category: 'انتقال', accountId: clearing.id },
  ] });
  const accounts = core.listAccounts();
  const expectedLiquid = accounts.filter((item) => ['cash', 'bank', 'wallet'].includes(item.kind) && item.active).reduce((sum, item) => sum + Number(item.balance), 0);
  assert.equal(core.financialOverview().cash, expectedLiquid);
  assert.equal(accounts.find((item) => item.id === 'clearing').balance, 170_000_000);
});

test('materializes each recurring occurrence exactly once', () => {
  const rule = core.saveRecurringRule({
    title: 'اجاره دوره‌ای', amount: 4_000_000, type: 'expense', category: 'اجاره', dayOfMonth: 1,
    nextDueAt: '2026-08-01T09:00:00.000Z',
  });
  assert.equal(core.materializeRecurringRules(new Date('2026-08-02T12:00:00.000Z')), 1);
  assert.equal(core.materializeRecurringRules(new Date('2026-08-02T12:00:00.000Z')), 0);
  assert.equal(core.listTransactions({ query: rule.title }).total, 1);
});

test.after(() => {
  core.db.close();
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
});
