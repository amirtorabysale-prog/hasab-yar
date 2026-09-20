import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setSecurityHeaders } from '../server/security.js';

/**
 * `index.html` تنها چیزی است که کاربر پیش از رسیدن بستهٔ JavaScript می‌بیند.
 *
 * دو قاعده اینجا قفل می‌شوند، چون هر دو بی‌صدا می‌شکنند: یکی فقط روی میزبانِ
 * کند دیده می‌شود و دیگری فقط در production که CSP فعال است.
 */

const html = readFileSync(resolve(import.meta.dirname, '..', 'index.html'), 'utf8');

test('the first paint says something instead of showing a white page', () => {
  // روی میزبانی که سرویس را می‌خواباند، فاصلهٔ باز شدن نشانی تا سوارشدن React
  // ده‌ها ثانیه است. یک `#root` خالی در آن مدت از «سایت خراب است» قابل
  // تشخیص نیست.
  assert.match(html, /id="boot"/, 'صفحهٔ آغاز باید در خود HTML باشد');
  assert.match(html, /حساب‌یار/, 'نام برنامه باید پیش از JavaScript دیده شود');
  assert.match(html, /id="boot-spinner"/, 'نشانهٔ «در حال آمدن» باید باشد');
  assert.match(html, /سرور تازه بیدار می‌شود/, 'انتظار طولانی باید توضیح داده شود');
});

test('the boot screen steps aside the moment React fills the root', () => {
  // ترتیب عنصرها بخشی از قرارداد است: انتخابگر همزاد فقط وقتی کار می‌کند که
  // `#boot` بعد از `#root` بیاید.
  assert.match(html, /#root:not\(:empty\) ~ #boot\s*\{\s*display:\s*none/);
  assert.ok(html.indexOf('id="root"') < html.indexOf('id="boot"'), '#boot باید بعد از #root بیاید');
});

test('the app shell carries no inline script, because the production CSP forbids it', () => {
  // `script-src 'self'` یعنی مرورگر هر اسکریپت درون‌خطی را بی‌صدا رد می‌کند.
  // چنین اسکریپتی در `npm run dev` درست کار می‌کند و فقط روی production
  // می‌میرد — بدترین حالت ممکن برای فهمیدن.
  const headers = new Map();
  setSecurityHeaders({ setHeader: (name, value) => headers.set(name, value) }, { production: true });
  assert.match(headers.get('Content-Security-Policy'), /script-src 'self'/);

  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>/gi)].filter(([, attributes]) => !/\ssrc=/i.test(attributes));
  assert.deepEqual(inlineScripts, [], 'اسکریپت درون‌خطی روی production اجرا نمی‌شود');
});

test('nothing on a third-party domain can hold back the first paint', () => {
  // `@import` در ابتدای برگهٔ سبک برنامه، Google Fonts را به زنجیرهٔ
  // مسدودکنندهٔ رنگ‌آمیزی اضافه می‌کرد: HTML، بعد CSS برنامه، بعد CSS گوگل.
  // در شبکه‌ای که این دامنه کند یا بسته است، کاربر تا timeout شدنش صفحهٔ سفید
  // می‌دید — و شبکهٔ یک دفتر دقیقاً همان شبکه است.
  const styles = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8');
  assert.doesNotMatch(styles, /@import\s+url\(\s*['"]?https?:/i, 'فونت بیرونی نباید در مسیر رنگ‌آمیزی باشد');

  const blocking = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map(([tag]) => tag)
    .filter((tag) => /rel="stylesheet"/i.test(tag) && /https?:\/\//i.test(tag));
  assert.deepEqual(blocking, [], 'برگهٔ سبک دامنهٔ بیرونی نباید در HTML باشد');
});

test('the description positions the product for an accounting office', () => {
  const description = html.match(/<meta name="description" content="([^"]+)"/)?.[1] || '';
  assert.ok(description.includes('دفتر حسابداری'), 'مخاطب محصول باید در معرفی روشن باشد');
});
