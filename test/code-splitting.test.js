import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * صفحه‌های گیت‌شده نباید دوباره به بستهٔ اول برگردند.
 *
 * تا پیش از این هر چهارده صفحه در همان بستهٔ اول بودند: کسی که فقط «امروز» را
 * باز می‌کرد، کدینگ و انتقال پارسیان و حقوق و مالیات را هم دانلود می‌کرد.
 * اندازه‌گیری روی source map نشان داد همین صفحه‌ها حدود ۲۸۰ کیلوبایت از ۶۲۶
 * کیلوبایت کد خودمان‌اند، و جداکردنشان بستهٔ اول را از ۱۹۱ به ۱۲۲ کیلوبایت
 * فشرده رساند.
 *
 * یک `import` ساده در بالای فایل همهٔ این را بی‌صدا برمی‌گرداند و هیچ آزمون
 * دیگری نمی‌گیردش: برنامه درست کار می‌کند، فقط دوباره کند می‌شود. این آزمون
 * دقیقاً همان را می‌گیرد.
 */

const app = readFileSync(resolve(import.meta.dirname, '..', 'src', 'App.jsx'), 'utf8');

const GATED_PAGES = [
  'AccountingPage', 'ChartPage', 'CollaborationPage', 'FirmConsolePage', 'LearningPage',
  'LedgerPage', 'ReportPage', 'ReviewQueuePage', 'SettingsPage', 'TaxPage', 'WorkspacePanel',
];

test('هیچ صفحهٔ پشت‌ناوبری به‌صورت ایستا وارد نمی‌شود', () => {
  const staticImports = [...app.matchAll(/^import\s+(?:(\w+)|\{([^}]+)\})\s+from\s+'([^']+)'/gm)]
    .flatMap(([, defaultName, named, source]) => {
      const names = defaultName ? [defaultName] : named.split(',').map((item) => item.trim().split(/\s+as\s+/).pop());
      return names.filter((name) => GATED_PAGES.includes(name)).map((name) => `${name} از ${source}`);
    });
  assert.deepEqual(staticImports, [], 'این‌ها باید با lazy() بیایند، نه import');
});

test('هر صفحهٔ پشت‌ناوبری واقعاً تنبل تعریف شده است', () => {
  const missing = GATED_PAGES.filter((name) => !new RegExp(`const ${name} = (namedLazy|lazy)\\(`).test(app));
  assert.deepEqual(missing, [], 'تعریف lazy پیدا نشد');
});

test('مرز Suspense هست، وگرنه اولین صفحهٔ تنبل برنامه را می‌اندازد', () => {
  // بدون مرز، React برای یک قطعهٔ نرسیده خطا می‌دهد و ErrorBoundary کل صفحه
  // را با «این صفحه بالا نیامد» جایگزین می‌کند — دقیقاً وسط کار کاربر.
  assert.match(app, /<Suspense fallback=\{<ScreenLoading \/>\}>/, 'ناحیهٔ صفحه‌ها باید مرز Suspense داشته باشد');
  assert.match(app, /function ScreenLoading\(\)/, 'fallback باید تعریف شده باشد');
});

test('صفحهٔ فرود و مسیر ثبت صوتی عمداً تنبل نیستند', () => {
  // تنبل‌کردن اینها فقط یک رفت‌وبرگشت به مسیر اصلی اضافه می‌کند: «امروز»
  // همان صفحه‌ای است که کاربر رویش می‌نشیند و کار اصلی‌اش را می‌کند.
  assert.match(app, /^import \{ CloseDaySheet, TodayPage \} from/m, 'صفحهٔ امروز باید ایستا بماند');
  assert.match(app, /^import \{ LoginPage, Onboarding \} from/m, 'صفحهٔ ورود باید ایستا بماند');
  assert.match(app, /^import \{ ConfirmationSheet,/m, 'برگه‌های ثبت صوتی باید ایستا بمانند');
});
