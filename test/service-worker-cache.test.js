import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * راهبرد کش service worker، جایی که فقط در مرورگر واقعی دیده می‌شود.
 *
 * باگی که اینجا قفل می‌شود: این فایل برای همه‌چیز network-first بود، پس
 * فایل‌های `/assets/index-<hash>.js` — که محتوایشان هرگز عوض نمی‌شود و سرور
 * برایشان `immutable` می‌فرستد — در هر بار باز کردن برنامه دوباره دانلود
 * می‌شدند. روی میزبانی که سرویس را می‌خواباند یعنی کاربر بارِ دوم هم باید
 * منتظر بیدار شدن سرور بماند.
 *
 * مرز مقابلش هم به همان اندازه مهم است: سند HTML نباید از کش بیاید، وگرنه
 * دیپلوی تازه برای کاربر نامرئی می‌ماند.
 */

const ORIGIN = 'https://app.test';
const source = readFileSync(resolve(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8');

class MemoryCache {
  entries = new Map();
  #key(request) { return typeof request === 'string' ? new URL(request, ORIGIN).href : request.url; }
  async match(request) { return this.entries.get(this.#key(request))?.clone(); }
  async put(request, response) { this.entries.set(this.#key(request), response); }
  async keys() { return [...this.entries.keys()].map((url) => ({ url })); }
  async delete(request) { return this.entries.delete(this.#key(request)); }
  async addAll(paths) { for (const path of paths) await this.put(path, new Response('shell')); }
}

function startWorker() {
  const stores = new Map();
  const caches = {
    async open(name) { if (!stores.has(name)) stores.set(name, new MemoryCache()); return stores.get(name); },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request) {
      for (const cache of stores.values()) { const hit = await cache.match(request); if (hit) return hit; }
      return undefined;
    },
  };
  const listeners = new Map();
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, handler) => listeners.set(type, handler),
    skipWaiting() {}, clients: { claim() {} },
  };
  const network = { calls: [], body: () => new Response('از شبکه'), fail: false };
  const fetchMock = async (request) => {
    network.calls.push(typeof request === 'string' ? request : request.url);
    if (network.fail) throw new TypeError('Failed to fetch');
    return network.body(request);
  };

  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', source)(self, caches, fetchMock);

  const dispatch = async (path, { destination = 'script', method = 'GET' } = {}) => {
    const request = { url: new URL(path, ORIGIN).href, method, destination };
    const pending = [];
    let answered;
    listeners.get('fetch')({ request, respondWith: (value) => { answered = value; }, waitUntil: (value) => pending.push(value) });
    const response = answered === undefined ? undefined : await answered;
    await Promise.allSettled(pending);
    return response;
  };

  // همان چیزی که مرورگر موقع نصب انجام می‌دهد: پوستهٔ برنامه در کش می‌نشیند.
  const install = async () => {
    const pending = [];
    listeners.get('install')({ waitUntil: (value) => pending.push(value) });
    await Promise.allSettled(pending);
  };

  return { caches, stores, listeners, network, dispatch, install };
}

test('a content-hashed asset is downloaded once and then served from the cache', async () => {
  const worker = startWorker();
  const first = await worker.dispatch('/assets/index-ABC123.js');
  assert.equal(await first.text(), 'از شبکه');
  assert.equal(worker.network.calls.length, 1);

  const second = await worker.dispatch('/assets/index-ABC123.js');
  assert.equal(await second.text(), 'از شبکه', 'همان محتوا، ولی از کش');
  assert.equal(worker.network.calls.length, 1, 'بار دوم نباید به شبکه برود');
});

test('the document always goes to the network, so a new deploy is never hidden', async () => {
  const worker = startWorker();
  worker.network.body = () => new Response('<script src="/assets/index-ABC123.js"></script>');
  await worker.dispatch('/', { destination: 'document' });
  worker.network.body = () => new Response('<script src="/assets/index-XYZ789.js"></script>');
  const second = await worker.dispatch('/', { destination: 'document' });

  assert.equal(worker.network.calls.length, 2, 'سند هر بار از شبکه گرفته می‌شود');
  assert.match(await second.text(), /index-XYZ789/, 'نسخهٔ تازه باید دیده شود');
});

test('a new deploy drops the previous generation of cached assets', async () => {
  const worker = startWorker();
  worker.network.body = () => new Response('<script src="/assets/index-ABC123.js"></script>');
  await worker.dispatch('/', { destination: 'document' });
  await worker.dispatch('/assets/index-ABC123.js');
  await worker.dispatch('/assets/LedgerPage-OLD111.js');

  worker.network.body = () => new Response('<script src="/assets/index-XYZ789.js"></script>');
  await worker.dispatch('/', { destination: 'document' });

  const assets = await worker.caches.open('hesab-yar-assets-v5');
  const cached = (await assets.keys()).map((item) => new URL(item.url).pathname);
  assert.ok(!cached.includes('/assets/index-ABC123.js'), 'بستهٔ نسل قبلی باید برود');
  assert.ok(!cached.includes('/assets/LedgerPage-OLD111.js'), 'قطعهٔ تنبل نسل قبلی هم باید برود');
});

test('a lazy chunk survives while the deploy is unchanged, though no HTML mentions it', async () => {
  // قطعه‌های `import()` هرگز در HTML نمی‌آیند. پاک‌کردن «هر چیزی که در سند
  // نیست» آن‌ها را در هر بار باز کردن برنامه دور می‌ریخت و کش برایشان بی‌اثر
  // می‌شد — به‌همین دلیل معیار، نسلِ بستهٔ اصلی است نه فهرست سند.
  const worker = startWorker();
  worker.network.body = () => new Response('<script src="/assets/index-ABC123.js"></script>');
  await worker.dispatch('/', { destination: 'document' });
  await worker.dispatch('/assets/WorkspacePanel-KEEP99.js');
  await worker.dispatch('/', { destination: 'document' });

  const before = worker.network.calls.length;
  await worker.dispatch('/assets/WorkspacePanel-KEEP99.js');
  assert.equal(worker.network.calls.length, before, 'قطعهٔ تنبل همان دیپلوی باید در کش مانده باشد');
});

test('api calls never touch the cache', async () => {
  const worker = startWorker();
  await worker.dispatch('/api/bootstrap', { destination: '' });
  await worker.dispatch('/api/bootstrap', { destination: '' });
  assert.equal(worker.network.calls.length, 2, 'پاسخ مالی هرگز از کش نمی‌آید');
  assert.equal(worker.stores.size, 0, 'هیچ کشی برای /api باز نمی‌شود');
});

test('a failed asset response is not cached for a year', async () => {
  const worker = startWorker();
  worker.network.body = () => new Response('خطا', { status: 502 });
  await worker.dispatch('/assets/index-ABC123.js');
  worker.network.body = () => new Response('درست');
  const retry = await worker.dispatch('/assets/index-ABC123.js');
  assert.equal(await retry.text(), 'درست', 'پاسخ ۵۰۲ نباید جای فایل درست را بگیرد');
});

test('when the network is down the cached app still opens', async () => {
  const worker = startWorker();
  await worker.install();
  await worker.dispatch('/assets/index-ABC123.js');
  worker.network.fail = true;
  const offline = await worker.dispatch('/assets/index-ABC123.js');
  assert.equal(await offline.text(), 'از شبکه', 'دارایی از کش می‌آید');

  const document_ = await worker.dispatch('/', { destination: 'document' });
  assert.ok(document_, 'سند باید از کش پوسته برگردد، نه خطا');
});
