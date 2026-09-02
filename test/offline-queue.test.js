import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  #items = new Map();
  get length() { return this.#items.size; }
  clear() { this.#items.clear(); }
  getItem(key) { return this.#items.has(String(key)) ? this.#items.get(String(key)) : null; }
  key(index) { return [...this.#items.keys()][index] ?? null; }
  removeItem(key) { this.#items.delete(String(key)); }
  setItem(key, value) { this.#items.set(String(key), String(value)); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();
globalThis.window = { dispatchEvent() {} };

const {
  api, clearOfflineSession, currentOfflineScope, flushTransactionQueue, queueTransactions,
  rememberOfflineScope, transactionQueueSnapshot,
} = await import(`../src/lib/api.js?offline-queue=${process.pid}`);

const scopeA = { userId: 'user-a', workspaceId: 'workspace-a' };
const scopeB = { userId: 'user-b', workspaceId: 'workspace-a' };

function successResponse() {
  return new Response(JSON.stringify({ ids: ['saved-id'] }), {
    status: 201, headers: { 'content-type': 'application/json' },
  });
}

test.beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  globalThis.fetch = async () => successResponse();
});

test('transaction queues are isolated by both user and workspace', () => {
  queueTransactions({ transcript: 'فروش کاربر الف', transactions: [] }, scopeA);
  queueTransactions({ transcript: 'فروش کاربر ب', transactions: [] }, scopeB);
  assert.equal(transactionQueueSnapshot(scopeA).length, 1);
  assert.equal(transactionQueueSnapshot(scopeB).length, 1);
  assert.equal(transactionQueueSnapshot(scopeA)[0].payload.transcript, 'فروش کاربر الف');
  assert.equal(transactionQueueSnapshot(scopeB)[0].payload.transcript, 'فروش کاربر ب');
});

test('flushing one identity never sends another identity queue', async () => {
  const sent = [];
  queueTransactions({ transcript: 'الف', transactions: [] }, scopeA);
  queueTransactions({ transcript: 'ب', transactions: [] }, scopeB);
  const workspaceHeaders = [];
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body).transcript);
    workspaceHeaders.push(options.headers['X-Workspace-Id']);
    return successResponse();
  };
  const result = await flushTransactionQueue(scopeA);
  assert.deepEqual(result, { synced: 1, failed: 0, pending: 0 });
  assert.deepEqual(sent, ['الف']);
  assert.deepEqual(workspaceHeaders, ['workspace-a']);
  assert.equal(transactionQueueSnapshot(scopeA).length, 0);
  assert.equal(transactionQueueSnapshot(scopeB).length, 1);
});

test('logout removes active identity but preserves its scoped durable queue', () => {
  rememberOfflineScope(scopeA);
  queueTransactions({ transcript: 'ثبت تأییدشدهٔ آفلاین', transactions: [] }, scopeA);
  assert.deepEqual(currentOfflineScope(), scopeA);
  clearOfflineSession();
  assert.equal(currentOfflineScope(), null);
  assert.equal(api.activeWorkspaceId(), '');
  assert.equal(transactionQueueSnapshot(scopeA).length, 1);
  assert.throws(() => transactionQueueSnapshot(), (error) => error.code === 'OFFLINE_SCOPE_REQUIRED');
});

test('permanent failures move to failed and are not retried forever', async () => {
  let calls = 0;
  queueTransactions({ transcript: 'تکراری', transactions: [] }, scopeA);
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: 'ثبت تکراری', code: 'POSSIBLE_DUPLICATE' }), {
      status: 409, headers: { 'content-type': 'application/json' },
    });
  };
  const first = await flushTransactionQueue(scopeA);
  const second = await flushTransactionQueue(scopeA);
  assert.equal(first.failed, 1);
  assert.equal(second.failed, 1);
  assert.equal(calls, 1);
  assert.equal(transactionQueueSnapshot(scopeA)[0].state, 'failed');
});

test('temporary failures remain queued and can succeed later', async () => {
  queueTransactions({ transcript: 'خطای موقت', transactions: [] }, scopeA);
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'موقت' }), {
    status: 503, headers: { 'content-type': 'application/json' },
  });
  const first = await flushTransactionQueue(scopeA);
  assert.deepEqual(first, { synced: 0, failed: 0, pending: 1 });
  assert.equal(transactionQueueSnapshot(scopeA)[0].state, 'queued');

  globalThis.fetch = async () => successResponse();
  const second = await flushTransactionQueue(scopeA);
  assert.deepEqual(second, { synced: 1, failed: 0, pending: 0 });
  assert.equal(transactionQueueSnapshot(scopeA).length, 0);
});
