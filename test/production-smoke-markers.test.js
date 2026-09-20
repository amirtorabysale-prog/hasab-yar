import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { removeTempDatabase, tempDatabase } from './helpers/tempPath.js';

/**
 * کنترل انتشار باید قابلیت را در هر قطعه‌ای پیدا کند، نه فقط در بستهٔ اصلی.
 *
 * این یک شکست واقعی را قفل می‌کند. وقتی بسته تقسیم شد، «بسته بیشتر از ۴۰۱
 * ردیف» به قطعهٔ همکاری حسابدار رفت و «سقف امن» به قطعهٔ کدینگ. کنترل
 * Production که فقط بستهٔ اصلی را می‌گشت، دیپلوی کاملاً سالم را قرمز کرد.
 *
 * خطر این حالت از یک باگ معمولی بیشتر است: کنترلی که دیپلوی درست را رد
 * می‌کند، چند بار که تکرار شود نادیده گرفته می‌شود — و از آن به بعد دیگر
 * دیپلویِ خراب را هم نمی‌گیرد.
 */

const run = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '..');
const databasePath = tempDatabase('smoke-markers');
const root = dirname(databasePath);
const dist = resolve(root, 'dist');

// قابلیت عمداً فقط در قطعهٔ تنبل است، نه در بستهٔ اصلی — همان چیزی که
// تقسیم بسته می‌سازد.
mkdirSync(resolve(dist, 'assets'), { recursive: true });
writeFileSync(resolve(dist, 'index.html'), '<!doctype html><title>حساب‌یار</title><script src="/assets/index-abc123.js"></script>');
writeFileSync(resolve(dist, 'assets', 'index-abc123.js'), `${'/* بستهٔ اصلی */'.padEnd(11_000, ' ')}\nconst lazy = ["assets/CollaborationPage-xyz789.js"];\n`);
writeFileSync(resolve(dist, 'assets', 'CollaborationPage-xyz789.js'), 'const label = "بسته بیشتر از ۴۰۱ ردیف";\n');

process.chdir(root);
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'smoke-owner';
process.env.ADMIN_PASSWORD = 'Kontrol-Enteshar-7731';
process.env.PORT = '0';
process.env.RAILWAY_GIT_COMMIT_SHA = 'b'.repeat(40);

const { server } = await import(`../server/index.js?smoke-markers=${process.pid}`);
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

const smoke = (markers) => run('node', [resolve(projectRoot, 'scripts', 'production-smoke.mjs')], {
  cwd: projectRoot,
  env: { ...process.env, PRODUCTION_URL: base, EXPECTED_SHA: 'b'.repeat(40), EXPECTED_MARKERS: markers },
});

test.after(() => {
  server.close();
  process.chdir(projectRoot);
  removeTempDatabase(databasePath);
});

test('a feature living only in a lazy chunk still counts as deployed', async () => {
  const { stdout } = await smoke('بسته بیشتر از ۴۰۱ ردیف');
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.chunks, 1, 'قطعهٔ تنبل باید پیدا و خوانده شده باشد');
});

test('a feature that is nowhere still fails the release check', async () => {
  // اگر این سبز شود، کنترل انتشار دیگر هیچ‌چیز را نمی‌گیرد.
  const failure = await smoke('قابلیتی که هرگز ساخته نشده').then(() => null, (error) => error);
  assert.ok(failure, 'نبودن قابلیت باید انتشار را رد کند');
  assert.match(String(failure.stderr), /نشانهٔ قابلیت/);
});

test('a mismatched production SHA is still refused', async () => {
  const failure = await run('node', [resolve(projectRoot, 'scripts', 'production-smoke.mjs')], {
    cwd: projectRoot,
    env: { ...process.env, PRODUCTION_URL: base, EXPECTED_SHA: 'c'.repeat(40), EXPECTED_MARKERS: '' },
  }).then(() => null, (error) => error);
  assert.ok(failure, 'SHA نادرست باید رد شود');
  assert.match(String(failure.stderr), /SHA پروداکشن/);
});
