import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTodayPulse, buildTodayTasks, closingDifference, todayComposerState, todayExamples } from '../src/lib/todayExperience.js';

test('composer exposes the five meaningful interaction states', () => {
  assert.equal(todayComposerState(), 'ready');
  assert.equal(todayComposerState({ recordState: 'recording' }), 'listening');
  assert.equal(todayComposerState({ manualText: 'پانصد هزار هزینه' }), 'typing');
  assert.equal(todayComposerState({ reviewing: true }), 'review');
  assert.equal(todayComposerState({ savedRecently: true }), 'success');
});

test('today examples follow the selected profile', () => {
  assert.equal(todayExamples('business').length, 3);
  assert.match(todayExamples('business')[0], /فروش/);
  assert.match(todayExamples('personal')[0], /حقوق/);
});

test('pulse prioritizes overdue work over a positive cash day', () => {
  const pulse = buildTodayPulse({ summary: { netCashFlow: 2_000_000 }, overview: { overdue: 2 }, transactions: [{ id: '1' }] });
  assert.equal(pulse.tone, 'danger');
  assert.match(pulse.title, /2 سررسید/);
});

test('pulse renders only the server-ranked alert with its direct action', () => {
  const pulse = buildTodayPulse({
    summary: { netCashFlow: -9_000_000 }, transactions: [{ id: '1' }],
    overview: { alerts: [{ id: 'growth' }], priorityAlert: { id: 'growth', level: 'warning', title: 'هزینه رشد کرده', detail: 'از خط مبنا بیشتر است.', action: { screen: 'report', label: 'دیدن گزارش' } } },
  });
  assert.equal(pulse.alertId, 'growth');
  assert.equal(pulse.action, 'report');
  assert.equal(pulse.actionLabel, 'دیدن گزارش');
});

test('work queue orders unsynced and suspicious work before closing', () => {
  const tasks = buildTodayTasks({
    profileType: 'business', pendingAudioCount: 1, overview: { overdue: 1 },
    transactions: [{ id: '1', needsReview: true }], closing: null,
  });
  assert.deepEqual(tasks.map((item) => item.id), ['pending-audio', 'review', 'overdue', 'close-day']);
});

test('personal profiles do not receive a cash closing task', () => {
  const tasks = buildTodayTasks({ profileType: 'personal', transactions: [{ id: '1' }] });
  assert.equal(tasks.some((item) => item.id === 'close-day'), false);
});

test('a closed day with a cash mismatch returns to the work queue', () => {
  const tasks = buildTodayTasks({ profileType: 'business', transactions: [{ id: '1' }], closing: { difference: -75_000 } });
  assert.equal(tasks.find((item) => item.id === 'cash-mismatch').action, 'close');
  assert.equal(tasks.some((item) => item.id === 'close-day'), false);
});

test('closing difference is counted cash minus server expectation', () => {
  assert.equal(closingDifference(1_250_000, '1300000'), 50_000);
  assert.equal(closingDifference(1_250_000, ''), -1_250_000);
});
