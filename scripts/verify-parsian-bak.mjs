// صحه‌گذاری خوانندهٔ بکاپ پارسیان روی یک فایل واقعی.
// استفاده: node scripts/verify-parsian-bak.mjs <مسیر بکاپ>
// خروجی فقط گزارش است؛ هیچ دیتابیسی باز نمی‌شود و چیزی نوشته نمی‌شود.

import { readFileSync } from 'node:fs';
import { parseParsianBackup } from '../server/parsianBackup.js';
import { buildParsianImportPlan } from '../server/parsianImport.js';

const path = process.argv[2];
if (!path) {
  console.error('مسیر فایل بکاپ را بده: node scripts/verify-parsian-bak.mjs <file.bak>');
  process.exit(1);
}

const buffer = readFileSync(path);
const parsed = parseParsianBackup(buffer, { fileName: path.split('/').pop() });
const plan = buildParsianImportPlan(parsed);

console.log('— رمزگشایی —');
console.log('جدول‌های شناسایی‌شده:', parsed.meta.tablesDiscovered);
console.log('صفحات جدول‌های هدف:', JSON.stringify(parsed.meta.pagesByTable));
console.log('ردیف‌های قدم‌خورده:', JSON.stringify(parsed.stats.walkedRows));
console.log('ردیف‌های سالم:', JSON.stringify(parsed.stats.decodedRows));
console.log('تکراری حذف‌شده:', JSON.stringify(parsed.stats.duplicateRows));
console.log('ردیف‌های مشکوک کنارگذاشته:', parsed.stats.suspiciousRows);

console.log('\n— کدینگ —');
console.log('کل:', parsed.chart.kol.length, '| معین:', parsed.chart.moeen.length, '| تفصیلی:', parsed.chart.tafsili.length);
console.log('نمونه کل:', JSON.stringify(parsed.chart.kol.slice(0, 3)));
console.log('نمونه معین:', JSON.stringify(parsed.chart.moeen.slice(0, 3)));
console.log('نمونه تفصیلی:', JSON.stringify(parsed.chart.tafsili.slice(0, 3)));

console.log('\n— اسناد —');
console.log('ردیف سند سالم:', parsed.documents.rows.length);
console.log('سند (شماره یکتا):', parsed.documents.vouchers.length);
const balanced = parsed.documents.vouchers.filter((voucher) => voucher.balanced);
console.log('سند متوازن:', balanced.length);
console.log('جمع بدهکار اسناد متوازن:', balanced.reduce((sum, voucher) => sum + voucher.bedTotal, 0).toLocaleString('en-US'));

console.log('\n— طرح ورود —');
console.log(JSON.stringify(plan.summary, null, 1));
console.log('هشدارها:', plan.warnings.length);
for (const warning of plan.warnings.slice(0, 12)) console.log('  •', warning);
const skipped = plan.vouchers.filter((voucher) => !voucher.importable);
console.log('نمونه اسناد واردنشدنی:', skipped.slice(0, 5).map((voucher) => ({
  sanad: voucher.sanad, date: voucher.date, issues: voucher.issues.slice(0, 1),
})));
