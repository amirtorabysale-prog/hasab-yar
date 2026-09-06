import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { once } from 'node:events';
import { tempDatabase } from './helpers/tempPath.js';

// این تست یک باگ واقعی production را قفل می‌کند: express.static با maxAge یک
// ساعته روی همهٔ فایل‌ها، باعث می‌شد index.html و sw.js تا یک ساعت از کش
// مرورگر بیایند و دیپلوی تازه برای کاربر نامرئی بماند تا Ctrl+Shift+R بزند.

const databasePath = tempDatabase('static');
const root = dirname(databasePath);
const dist = resolve(root, 'dist');
mkdirSync(resolve(dist, 'assets'), { recursive: true });
writeFileSync(resolve(dist, 'index.html'), '<!doctype html><title>حساب‌یار</title><script src="/assets/index-abc123.js"></script>');
writeFileSync(resolve(dist, 'sw.js'), 'self.addEventListener("fetch", () => {});');
writeFileSync(resolve(dist, 'manifest.webmanifest'), '{"name":"حساب‌یار"}');
writeFileSync(resolve(dist, 'assets', 'index-abc123.js'), 'console.log("bundle");');
writeFileSync(resolve(dist, 'assets', 'index-abc123.css'), 'body{color:#000}');

process.chdir(root);
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'static-owner';
process.env.ADMIN_PASSWORD = 'Static-Long-Passphrase-9931';
// پورت را سیستم‌عامل می‌دهد. پورتِ ساخته‌شده از pid هم با سرور جامانده از اجرای
// قبلی برخورد می‌کرد و هم با اجرای موازی؛ در آن حالت listen خطا می‌داد و این
// فایل یک‌بار و بدون دلیل روشن قرمز می‌شد.
process.env.PORT = '0';

const { server } = await import(`../server/index.js?static=${process.pid}`);
// انتظار برای رویداد واقعی listening، نه یک وقفهٔ ثابت: روی ماشین شلوغ ۷۰۰
// میلی‌ثانیه گاهی کم می‌آمد و اولین fetch با ECONNREFUSED می‌خورد.
if (!server.listening) await once(server, 'listening');

const base = `http://127.0.0.1:${server.address().port}`;
const headersFor = async (path, method = 'GET') => {
  const response = await fetch(base + path, { method });
  await response.arrayBuffer();
  return { status: response.status, cacheControl: response.headers.get('cache-control') || '' };
};

test.after(() => {
  server.close();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* windows file lock */ }
});

test('index.html is revalidated on every load so a new deploy is visible at once', async () => {
  const root_ = await headersFor('/');
  assert.equal(root_.status, 200);
  assert.match(root_.cacheControl, /no-cache/);
  assert.doesNotMatch(root_.cacheControl, /max-age=[1-9]/, 'یک max-age مثبت یعنی مرورگر تا انقضا اصلاً از سرور نمی‌پرسد');
});

test('an unknown path falls back to the app shell, also without a stale cache', async () => {
  const deep = await headersFor('/ledger/anything');
  assert.equal(deep.status, 200);
  assert.match(deep.cacheControl, /no-cache/);
});

test('a HEAD request for the app shell answers like a GET, not with a 404', async () => {
  // مانیتورینگ و بعضی proxyها با HEAD سلامت مسیر را می‌سنجند.
  for (const path of ['/', '/ledger/anything']) {
    const head = await headersFor(path, 'HEAD');
    assert.equal(head.status, 200, path);
    assert.match(head.cacheControl, /no-cache/, path);
  }
});

test('the service worker is never served from a stale browser cache', async () => {
  const worker = await headersFor('/sw.js');
  assert.equal(worker.status, 200);
  assert.match(worker.cacheControl, /no-cache/);
  assert.doesNotMatch(worker.cacheControl, /max-age=[1-9]/);
});

test('the manifest is revalidated too', async () => {
  const manifest = await headersFor('/manifest.webmanifest');
  assert.match(manifest.cacheControl, /no-cache/);
});

test('content-hashed assets are cached hard because their name changes with content', async () => {
  for (const path of ['/assets/index-abc123.js', '/assets/index-abc123.css']) {
    const asset = await headersFor(path);
    assert.equal(asset.status, 200, path);
    assert.match(asset.cacheControl, /max-age=31536000/, path);
    assert.match(asset.cacheControl, /immutable/, path);
  }
});

test('api responses are never cached', async () => {
  const health = await headersFor('/api/health');
  assert.equal(health.status, 200);
  assert.match(health.cacheControl, /no-store/);
});
