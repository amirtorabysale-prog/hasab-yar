import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunway, detectExpenseGrowth, financialScope, exactWindow, findUnusualTransaction } from '../server/financialIntelligence.js';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('financial-intelligence');
process.env.DATABASE_PATH = databasePath;
const core = await import(`../server/db.js?financial-intelligence=${process.pid}`);
const now = new Date('2026-08-26T12:00:00.000Z');
const atDaysAgo = (days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

test('runway scenarios expose their formula, scope and conservative ordering', () => {
  const scope = financialScope(exactWindow(now, 30), '۳۰ روز اخیر');
  const runway = buildRunway({ cash: 12_000_000, expenseTotal: 6_000_000, lookbackDays: 30, scope, sources: [{ id: 'expense-1' }] });
  assert.deepEqual(runway.scenarios.map((item) => item.id), ['optimistic', 'base', 'pessimistic']);
  assert.ok(runway.scenarios[0].days > runway.scenarios[1].days);
  assert.ok(runway.scenarios[1].days > runway.scenarios[2].days);
  assert.equal(runway.scope.unit, 'تومان');
  assert.match(runway.formula, /درآمد آینده را فرض نمی‌کنند/);
});

test('anomaly and growth detectors require a real baseline', () => {
  const rows = [
    { id: 'new', type: 'expense', category: 'خوراک', amount: 4_000_000, occurredAt: atDaysAgo(1) },
    ...[10, 20, 30, 40].map((days, index) => ({ id: `old-${index}`, type: 'expense', category: 'خوراک', amount: 1_000_000, occurredAt: atDaysAgo(days) })),
  ];
  assert.equal(findUnusualTransaction(rows.slice(0, 4), 'balanced', atDaysAgo(7)), null);
  assert.equal(findUnusualTransaction(rows, 'balanced', atDaysAgo(7)).current.id, 'new');
  assert.equal(detectExpenseGrowth([{ amount: 2_000_000 }], [{ amount: 1_000_000 }], 'balanced').percent, 100);
  assert.equal(detectExpenseGrowth([{ amount: 1_100_000 }], [{ amount: 1_000_000 }], 'balanced'), null);
});

test('financial answers always return a unit, exact scope and reconstructable source ids', () => {
  core.saveSettings({ openingBalance: '20000000', alertSensitivity: 'balanced' });
  const [currentFood] = core.insertTransactions({ transcript: 'خوراک امروز', transactions: [{ amount: 4_000_000, type: 'expense', category: 'خوراک', rawText: 'خوراک امروز', occurredAt: atDaysAgo(1) }] });
  core.insertTransactions({ transcript: 'خوراک قدیمی', transactions: [{ amount: 1_000_000, type: 'expense', category: 'خوراک', rawText: 'خوراک قدیمی', occurredAt: atDaysAgo(40) }] });
  const category = core.answerFinancialQuestion('خوراک این ماه چقدر شد؟', { now });
  assert.equal(category.intent, 'category-total');
  assert.equal(category.result.value, 4_000_000);
  assert.equal(category.scope.unit, 'تومان');
  assert.equal(category.scope.days, 30);
  assert.deepEqual(category.sources.map((item) => item.id), [currentFood]);
  assert.equal(category.provenance.complete, true);

  const latest = core.answerFinancialQuestion('آخرین پرداخت من چه بود؟', { now });
  assert.equal(latest.intent, 'latest-payment');
  assert.equal(latest.sources[0].id, currentFood);

  const comparison = core.answerFinancialQuestion('هزینه را با ماه قبل مقایسه کن', { now });
  assert.equal(comparison.intent, 'range-comparison');
  assert.equal(comparison.result.previousValue, 1_000_000);
  assert.ok(comparison.scope.comparisonFrom);
  assert.equal(comparison.sources.some((item) => item.period === 'previous'), true);
});

test('contact balances link every open obligation to the answer', () => {
  const contact = core.saveContact({ name: 'سارا احمدی' });
  const receivable = core.saveObligation({ contactId: contact.id, title: 'باقی‌مانده سفارش', amount: 2_500_000, direction: 'receivable', dueAt: atDaysAgo(2) });
  const answer = core.answerFinancialQuestion('مانده حساب سارا احمدی چقدر است؟', { now });
  assert.equal(answer.intent, 'contact-balance');
  assert.equal(answer.result.value, 2_500_000);
  assert.equal(answer.sources[0].id, receivable.id);
  assert.equal(answer.sources[0].kind, 'obligation');
});

test('overview prioritizes overdue receivables and keeps alerts explainable and snoozable', () => {
  for (const [index, days] of [10, 20, 30, 50].entries()) core.insertTransactions({ transcript: `خط مبنا ${index}`, transactions: [{ amount: 1_000_000, type: 'expense', category: 'خوراک', rawText: `خط مبنا ${index}`, occurredAt: atDaysAgo(days) }] });
  const overview = core.financialOverview(now);
  assert.equal(overview.priorityAlert.id, 'overdue-receivable');
  assert.ok(overview.priorityAlert.sources.length > 0);
  assert.equal(overview.alerts.some((item) => item.type === 'unusual-amount'), true);
  assert.equal(overview.runway.scope.unit, 'تومان');
  assert.equal(overview.runway.scenarios.find((item) => item.id === 'base').days, overview.runwayDays);

  core.snoozeFinancialAlert('overdue-receivable', { hours: 24 });
  const afterSnooze = core.financialOverview(now);
  assert.equal(afterSnooze.alerts.some((item) => item.id === 'overdue-receivable'), false);
  assert.notEqual(afterSnooze.priorityAlert?.id, 'overdue-receivable');
});

test('tax and legal questions are guarded instead of generating advice', () => {
  const answer = core.answerFinancialQuestion('برای مالیات چقدر قطعی پرداخت کنم؟', { now });
  assert.equal(answer.intent, 'guarded-advice');
  assert.equal(answer.result, null);
  assert.equal(answer.sources.length, 0);
  assert.match(answer.disclaimer, /توصیهٔ مالیاتی یا حقوقی نیست/);
});

test.after(() => {
  core.db.close();
  removeTempDatabase(databasePath);
});
