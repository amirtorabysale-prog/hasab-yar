import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRM_LEVEL_LABELS, buildFirmPortfolio, firmClientStatus, firmPortfolioSummary, idleDays, sortFirmClients,
} from '../server/firm.js';
import { minimumRoleForRequest } from '../server/access.js';

const NOW = new Date('2026-08-27T10:00:00.000Z');

function snapshot(name, counts = {}, extra = {}) {
  return {
    workspace: { id: `ws-${name}`, name, role: 'accountant' },
    month: '1405-06',
    available: true,
    counts,
    ledgerBalanced: true,
    periodLocked: false,
    lastActivityAt: NOW.toISOString(),
    activity: { transactionCount: 0, income: 0, expense: 0, entryCount: 0 },
    delivery: { lastBatch: null },
    ...extra,
  };
}

test('a client with no open item is ready for delivery', () => {
  const status = firmClientStatus(snapshot('پرونده تمیز'), { now: NOW });
  assert.equal(status.level, 'ready');
  assert.equal(status.levelLabel, FIRM_LEVEL_LABELS.ready);
  assert.equal(status.readyForDelivery, true);
  assert.deepEqual(status.blockers, []);
  assert.deepEqual(status.warnings, []);
});

test('blocking items outrank warnings and name the real reason', () => {
  const status = firmClientStatus(
    snapshot('پرونده مسدود', { openReceipts: 3, unreviewedTransactions: 12 }),
    { now: NOW },
  );
  assert.equal(status.level, 'blocked');
  assert.equal(status.readyForDelivery, false);
  assert.deepEqual(status.blockers.map((item) => item.id), ['openReceipts']);
  assert.deepEqual(status.warnings.map((item) => item.id), ['unreviewedTransactions']);
  assert.equal(status.blockerTotal, 3);
  assert.equal(status.warningTotal, 12);
});

test('an unbalanced month ledger blocks the client even with zero counts', () => {
  const status = firmClientStatus(snapshot('نامتوازن', {}, { ledgerBalanced: false }), { now: NOW });
  assert.equal(status.level, 'blocked');
  assert.deepEqual(status.blockers.map((item) => item.id), ['ledgerUnbalanced']);
});

test('only unreviewed work keeps a client in attention, not blocked', () => {
  const status = firmClientStatus(snapshot('کنترل', { unreviewedTransactions: 4, answeredRequests: 1 }), { now: NOW });
  assert.equal(status.level, 'attention');
  assert.equal(status.readyForDelivery, false);
});

test('a silent client is flagged stale with the real number of idle days', () => {
  const quiet = snapshot('ساکت', {}, { lastActivityAt: new Date(NOW.getTime() - 11 * 86_400_000).toISOString() });
  const status = firmClientStatus(quiet, { now: NOW });
  assert.equal(status.idleDays, 11);
  assert.equal(status.stale, true);
  assert.equal(status.level, 'attention');
  assert.match(status.warnings.at(-1).label, /۱۱|11/);
});

test('a client that never recorded anything reports null idle days, not zero', () => {
  const status = firmClientStatus(snapshot('تازه', {}, { lastActivityAt: null }), { now: NOW });
  assert.equal(status.idleDays, null);
  assert.equal(status.stale, false);
  assert.equal(idleDays(null, NOW), null);
});

test('an unreadable client stays unknown instead of showing fake zeros', () => {
  const status = firmClientStatus(
    { workspace: { id: 'ws-x', name: 'خراب' }, available: false, error: 'disk error' },
    { now: NOW },
  );
  assert.equal(status.level, 'unknown');
  assert.equal(status.blockerTotal, null);
  assert.equal(status.warningTotal, null);
  assert.equal(status.readyForDelivery, false);
  assert.equal(status.error, 'disk error');
});

test('the most urgent client sits at the top of the desk', () => {
  const clients = [
    firmClientStatus(snapshot('آماده'), { now: NOW }),
    firmClientStatus(snapshot('کم‌ایراد', { openRequests: 1 }), { now: NOW }),
    firmClientStatus(snapshot('پرایراد', { openReceipts: 5, unmatchedBankLines: 4 }), { now: NOW }),
    firmClientStatus(snapshot('کنترل', { unreviewedTransactions: 2 }), { now: NOW }),
  ];
  const sorted = sortFirmClients(clients).map((item) => item.workspace.name);
  assert.deepEqual(sorted, ['پرایراد', 'کم‌ایراد', 'کنترل', 'آماده']);
});

test('portfolio summary counts levels and ranks the shared blockers', () => {
  const portfolio = buildFirmPortfolio([
    snapshot('الف', { openReceipts: 2 }),
    snapshot('ب', { openReceipts: 1, unmatchedBankLines: 3 }),
    snapshot('پ', { unreviewedTransactions: 6 }),
    snapshot('ت'),
  ], { now: NOW });
  assert.equal(portfolio.summary.clientCount, 4);
  assert.equal(portfolio.summary.blocked, 2);
  assert.equal(portfolio.summary.attention, 1);
  assert.equal(portfolio.summary.ready, 1);
  assert.equal(portfolio.summary.readyPercent, 25);
  assert.equal(portfolio.summary.topBlockers[0].id, 'openReceipts');
  assert.equal(portfolio.summary.topBlockers[0].clients, 2);
  assert.equal(portfolio.summary.topBlockers[0].count, 3);
});

test('an all-unavailable portfolio reports null readiness instead of zero percent', () => {
  const summary = firmPortfolioSummary([
    firmClientStatus({ workspace: { id: 'a', name: 'a' }, available: false }, { now: NOW }),
  ]);
  assert.equal(summary.measuredCount, 0);
  assert.equal(summary.unavailableCount, 1);
  assert.equal(summary.readyPercent, null);
});

test('the firm desk is reachable by every workspace member role', () => {
  assert.equal(minimumRoleForRequest('GET', '/firm/portfolio'), 'viewer');
});
