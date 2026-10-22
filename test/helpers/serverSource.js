import { readdirSync, readFileSync } from 'node:fs';

/**
 * متن کد سرورِ مسیرهای API: `server/index.js` و همهٔ فایل‌های `server/routes/`.
 *
 * مسیرها از index.js به فایل‌های هر بخش رفتند. آزمون‌هایی که متنِ مسیر را
 * می‌خوانند (وجود مسیر، ترتیبِ کارها در بدنهٔ آن) همهٔ این‌ها را با هم می‌بینند،
 * پس جای فایلِ یک مسیر در آزمون مهم نیست.
 */
export function serverSource() {
  const root = new URL('../../server/', import.meta.url);
  const routes = new URL('routes/', root);
  const files = readdirSync(routes).filter((name) => name.endsWith('.js')).sort();
  return [readFileSync(new URL('index.js', root), 'utf8'), ...files.map((name) => readFileSync(new URL(name, routes), 'utf8'))].join('\n');
}
