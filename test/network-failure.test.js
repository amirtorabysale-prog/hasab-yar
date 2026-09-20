import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * وقتی سرور جواب نمی‌دهد، برنامه باید فارسی حرف بزند و صف آفلاین را نگه دارد.
 *
 * این فایل دو باگ واقعی را قفل می‌کند که هر دو با میزبانِ خواب‌رونده هر روز
 * صبح تکرار می‌شدند:
 *
 * ۱. `fetch` در این حالت یک `TypeError` با متن انگلیسی مرورگر پرتاب می‌کند و
 *    این متن مستقیم به کاربر نشان داده می‌شد — روی صفحهٔ ورود، به‌عنوان دلیل
 *    ناموفق‌بودن ورود.
 * ۲. همان خطا در صف آفلاین یک «تلاش ناموفق» حساب می‌شد؛ سه بار بازکردن برنامه
 *    پیش از بیدارشدن سرور، ثبت‌های تأییدشدهٔ کاربر را به مرز «بررسی دستی»
 *    می‌رساند بدون اینکه هیچ ایرادی در خودشان باشد.
 */

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

const { api, flushTransactionQueue, queueTransactions, transactionQueueSnapshot } =
  await import(`../src/lib/api.js?network-failure=${process.pid}`);
const { isNetworkQueueError, isPermanentQueueError } =
  await import(`../src/lib/offlineScope.js?network-failure=${process.pid}`);

const scope = { userId: 'user-a', workspaceId: 'workspace-a' };

// همان چیزی که مرورگر واقعاً پرتاب می‌کند: یک TypeError با متن انگلیسی.
const unreachable = () => { throw new TypeError('Failed to fetch'); };

function withOnlineStatus(value, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: value }, configurable: true, writable: true,
  });
  return (async () => {
    try { return await run(); }
    finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else delete globalThis.navigator;
    }
  })();
}

test.beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
});

test('a server that does not answer is reported in Persian, not with the browser string', async () => {
  globalThis.fetch = unreachable;
  const error = await api.authStatus().then(() => null, (thrown) => thrown);
  assert.ok(error, 'باید خطا بدهد');
  assert.equal(error.code, 'NETWORK_UNREACHABLE');
  assert.equal(error.status, 0);
  assert.doesNotMatch(error.message, /fetch|network/i, 'متن داخلی مرورگر نباید به کاربر برسد');
  assert.match(error.message, /سرور پاسخ نداد/);
  assert.ok(error.cause instanceof TypeError, 'خطای اصلی برای عیب‌یابی نگه داشته می‌شود');
});

test('a disconnected device gets a different message than a sleeping server', async () => {
  await withOnlineStatus(false, async () => {
    globalThis.fetch = unreachable;
    const error = await api.authStatus().then(() => null, (thrown) => thrown);
    assert.equal(error.code, 'NETWORK_OFFLINE');
    assert.match(error.message, /اینترنت دستگاه قطع است/);
  });
});

test('a download path reports the same Persian failure as a JSON path', async () => {
  globalThis.fetch = unreachable;
  const error = await api.downloadImportTemplate().then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'NETWORK_UNREACHABLE');
  assert.doesNotMatch(error.message, /fetch/i);
});

test('a cancelled recording stays cancelled and is not renamed a server failure', async () => {
  // مهلت و لغو کاربر با `controller.abort(reason)` انجام می‌شوند و هر مقداری —
  // اینجا یک رشته — را به‌عنوان دلیل رد می‌کنند. اگر اینها هم ترجمه می‌شدند،
  // «پردازش صدا لغو شد» به «سرور پاسخ نداد» تبدیل می‌شد.
  globalThis.fetch = async () => { throw 'timeout'; };
  const thrown = await api.authStatus().then(() => null, (error) => error);
  assert.equal(thrown, 'timeout');
});

test('an unreachable server never counts as a permanent queue failure', () => {
  const error = Object.assign(new Error('سرور پاسخ نداد.'), { code: 'NETWORK_UNREACHABLE', status: 0 });
  assert.equal(isNetworkQueueError(error), true);
  assert.equal(isPermanentQueueError(error), false);
  assert.equal(isNetworkQueueError(Object.assign(new Error('نامعتبر'), { status: 400 })), false);
});

test('a sleeping server leaves the offline queue exactly as it was', async () => {
  queueTransactions({ transcript: 'فروش نقدی', transactions: [] }, scope);
  queueTransactions({ transcript: 'خرید مواد', transactions: [] }, scope);
  const before = transactionQueueSnapshot(scope);

  globalThis.fetch = unreachable;
  const result = await flushTransactionQueue(scope);

  assert.deepEqual(result, { synced: 0, failed: 0, pending: 2 });
  const after = transactionQueueSnapshot(scope);
  assert.equal(after.length, 2, 'هیچ قلمی از صف گم نمی‌شود');
  assert.deepEqual(after.map((item) => item.payload.transcript), ['فروش نقدی', 'خرید مواد']);
  assert.deepEqual(after.map((item) => Number(item.attempts || 0)), [0, 0], 'شکست شبکه تلاش حساب نمی‌شود');
  assert.deepEqual(after, before, 'صف باید دست‌نخورده بماند');
});

test('the queue stops at the first unreachable item instead of sending the rest', async () => {
  queueTransactions({ transcript: 'قلم اول', transactions: [] }, scope);
  queueTransactions({ transcript: 'قلم دوم', transactions: [] }, scope);
  queueTransactions({ transcript: 'قلم سوم', transactions: [] }, scope);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new TypeError('Failed to fetch'); };

  await flushTransactionQueue(scope);

  assert.equal(calls, 1, 'وقتی سرور در دسترس نیست، بقیهٔ صف بی‌فایده فرستاده نمی‌شود');
  assert.equal(transactionQueueSnapshot(scope).length, 3);
});

test('a real rejection from the server still fails the item as before', async () => {
  queueTransactions({ transcript: 'ثبت نامعتبر', transactions: [] }, scope);
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'INVALID_INPUT', message: 'مبلغ نامعتبر است.' }), {
    status: 400, headers: { 'content-type': 'application/json' },
  });

  const result = await flushTransactionQueue(scope);

  assert.equal(result.failed, 1);
  const [item] = transactionQueueSnapshot(scope);
  assert.equal(item.state, 'failed');
  assert.equal(item.attempts, 1);
});
