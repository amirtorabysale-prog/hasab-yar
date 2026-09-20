import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { removeTempDatabase, tempDatabase } from './helpers/tempPath.js';

/**
 * اولین درخواست بعد از ورود نباید پشت تحلیل‌ها بماند.
 *
 * `/api/bootstrap` همان چیزی است که تعیین می‌کند کاربر چقدر به صفحهٔ نیمه‌خالی
 * نگاه کند. اندازه‌گیری روی یک دفتر ششصدثبتی — که برای یک دفتر حسابداری کوچک
 * است — نشان داد کل پاسخ ۲۴۹ میلی‌ثانیه طول می‌کشد و ۹۹٪ آن فقط در
 * `financialOverview` (۱۲۳ms) و `dnaProfiles` (۹۱ms) است؛ دوازده تابع دیگر
 * روی هم سه میلی‌ثانیه بودند. هر دو با بزرگ‌شدن دفتر بدتر می‌شوند چون همهٔ
 * ردیف‌ها را در JavaScript می‌خوانند.
 *
 * این آزمون مرز را نگه می‌دارد: دادهٔ دفتر در `bootstrap`، تحلیل در
 * `/api/insights`. اگر روزی کسی دوباره آن‌ها را به `bootstrap` برگرداند،
 * اینجا قرمز می‌شود و نه در گزارش کندی شش ماه بعد.
 */

const databasePath = tempDatabase('bootstrap-split');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'daftar-owner';
process.env.ADMIN_PASSWORD = 'Rooz-Nameh-Kamel-8821';
process.env.PORT = '0';

const { server } = await import(`../server/index.js?bootstrap-split=${process.pid}`);
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'daftar-owner', password: 'Rooz-Nameh-Kamel-8821' }),
});
assert.equal(login.status, 200, 'ورود آزمون باید موفق باشد');
const session = login.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
const signedIn = { cookie: session };

test.after(() => {
  server.close();
  removeTempDatabase(databasePath);
});

test('bootstrap دادهٔ دفتر را می‌دهد و تحلیل سنگین را نه', async () => {
  const body = await (await fetch(`${base}/api/bootstrap`, { headers: signedIn })).json();

  for (const field of ['categories', 'settings', 'accounts', 'contacts', 'obligations', 'recurring', 'closings', 'access']) {
    assert.ok(field in body, `${field} باید در bootstrap بماند`);
  }
  assert.ok(!('overview' in body), 'financialOverview نباید اولین نمایش را نگه دارد');
  assert.ok(!('dnaProfiles' in body), 'dnaProfiles نباید اولین نمایش را نگه دارد');
});

test('تحلیل‌ها در مسیر خودشان کامل برمی‌گردند', async () => {
  const response = await fetch(`${base}/api/insights`, { headers: signedIn });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.overview && typeof body.overview === 'object', 'overview باید بیاید');
  assert.ok('dnaProfiles' in body, 'dnaProfiles باید بیاید');
});

test('تحلیل مالی بدون نشست باز نیست', async () => {
  // مسیر تازه همان مرز دسترسی مسیرهای دیگر را دارد؛ نبودش یعنی وضعیت مالی
  // دفتر برای هر کسی که نشانی را بداند خوانده می‌شود.
  const response = await fetch(`${base}/api/insights`);
  assert.equal(response.status, 401);
});
