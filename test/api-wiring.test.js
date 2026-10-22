import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { serverSource as readServerSource } from './helpers/serverSource.js';

/**
 * رابط و سرور باید با هم بخوانند — پیش از اینکه کاربر رویش کلیک کند.
 *
 * سه پنل تازه (حقوق، چک، تسویهٔ ارزش افزوده) هرکدام یک متد در `api.js` و یک
 * مسیر در سرور لازم داشتند. اگر یکی جا بیفتد یا نامش غلط تایپ شود، نه آزمون
 * سرور می‌گیردش و نه build: فقط وقتی بیرون می‌زند که کسی دکمه را بزند و
 * «is not a function» یا ۴۰۴ بگیرد — یعنی وسط نمایش محصول.
 */
function sourceFiles(directory, pattern = /\.jsx?$/) {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? sourceFiles(full, pattern) : pattern.test(name) ? [full] : [];
  });
}

const apiSource = readFileSync('src/lib/api.js', 'utf8');
const serverSource = readServerSource();

/**
 * کلیدهای شیء `api` — چیزی که صفحه‌ها صدا می‌زنند.
 *
 * هم «name:» و هم شکل کوتاه «name,»؛ هر دو در همان شیء استفاده می‌شوند.
 */
const apiMethods = new Set(
  [...apiSource.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*[:,]/gm)].map((match) => match[1]),
);

test('هر api.x که صفحه‌ها صدا می‌زنند، واقعاً تعریف شده است', () => {
  const missing = new Map();
  for (const file of sourceFiles('src')) {
    if (file.endsWith(path.join('lib', 'api.js'))) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(/\bapi\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!apiMethods.has(match[1])) missing.set(match[1], file);
    }
  }
  assert.deepEqual([...missing.keys()], [], [...missing].map(([name, file]) => `${name} (${file})`).join(' | '));
});

/**
 * مسیرهایی که سرور واقعاً ثبت کرده.
 *
 * پارامترها (`:id`) به یک جای‌نگهدار تبدیل می‌شوند تا با درون‌ریزی رشته‌ای
 * سمت رابط قابل مقایسه باشند.
 */
const serverRoutes = [...serverSource.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)]
  .map((match) => ({ method: match[1].toUpperCase(), path: match[2] }));

/** مسیرهای فراخوانی‌شده از رابط، با متدشان. */
function clientCalls() {
  const calls = [];
  // هم رشتهٔ ساده و هم قالبِ درون‌ریزی‌شده؛ در دومی فقط تا اولین ${ مقایسه می‌شود.
  for (const match of apiSource.matchAll(/request\(\s*(`[^`]+`|'[^']+')\s*(?:,\s*\{([^}]*)\})?/g)) {
    const raw = match[1].slice(1, -1);
    const options = match[2] || '';
    const method = (options.match(/method:\s*'([A-Z]+)'/)
      || options.match(/method:\s*[^,']*\?\s*'([A-Z]+)'/) || [null, 'GET'])[1];
    calls.push({ raw, method, dynamic: /[?$]/.test(raw) });
  }
  return calls;
}

test('هر مسیری که رابط صدا می‌زند، در سرور ثبت شده است', () => {
  const missing = [];
  for (const call of clientCalls()) {
    // تا اولین بخش متغیر مقایسه می‌شود؛ بقیه‌اش پارامتر یا رشتهٔ پرس‌وجوست.
    const prefix = call.raw.split(/[?$]/)[0].replace(/\/$/, '');
    const found = serverRoutes.some((route) => {
      if (route.method !== call.method) return false;
      const routePrefix = route.path.split('/:')[0];
      return call.dynamic ? routePrefix === prefix || route.path === prefix : route.path === call.raw || routePrefix === prefix;
    });
    if (!found) missing.push(`${call.method} ${call.raw}`);
  }
  assert.deepEqual(missing, [], `این مسیرها در سرور نیستند: ${missing.join(' | ')}`);
});

/**
 * هر تابعی که `index.js` از لایهٔ دفتر وارد می‌کند باید واقعاً صادر شده باشد.
 *
 * یک نام جاافتاده در فهرست وارداتِ طولانی، سرور را همان لحظهٔ بالا آمدن
 * می‌شکند — ولی هیچ آزمونی که خودِ سرور را بالا نیاورد، نمی‌بیندش.
 */
test('سرور فقط چیزهایی را وارد می‌کند که لایهٔ دفتر صادر کرده است', async () => {
  const database = await import('../server/db.js?wiring=1');
  // بدون گذشتن از آکولاد، وگرنه بلوک با واردات‌های قبلیِ فایل قاطی می‌شود.
  const block = serverSource.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/db\.js'/);
  assert.ok(block, 'بلوک واردات از db.js پیدا نشد');
  const names = block[1].split(',').map((item) => item.trim().split(/\s+as\s+/)[0]).filter(Boolean);
  const missing = names.filter((name) => database[name] === undefined);
  assert.deepEqual(missing, [], `این‌ها از db.js صادر نشده‌اند: ${missing.join('، ')}`);
});
