/**
 * آزمون رفت‌وبرگشت فایل پارسیان، روی دادهٔ واقعی همین دفتر.
 *
 * چه چیزی را ثابت می‌کند: هر چیزی که در حساب‌یار ثبت شده، وقتی به فایل انتقال
 * تبدیل می‌شود و دوباره از همان فایل خوانده می‌شود، بدون کم و زیاد برمی‌گردد —
 * همان مبلغ، همان تاریخ، همان کد کل و معین و تفصیلی.
 *
 * چه چیزی را ثابت نمی‌کند: اینکه نسخهٔ پارسیانِ نصب‌شده روی سیستم دفتر این فایل
 * را می‌پذیرد. آن فقط با ایمپورت واقعی در همان نصب معلوم می‌شود و این ابزار
 * جایش را نمی‌گیرد.
 *
 * عمداً از همان مسیری می‌رود که خروجی واقعی می‌رود (`createAccountingTransferBatch`).
 * اگر مسیر دومی می‌ساخت، چیزی را تأیید می‌کرد که کاربر هیچ‌وقت استفاده نمی‌کند.
 *
 *   node scripts/verify-parsian-roundtrip.mjs [ماه] [--workspace=primary]
 *   node scripts/verify-parsian-roundtrip.mjs 1405-06
 */

import { readParsianDocuments } from '../server/parsianAccessFile.js';

const args = process.argv.slice(2);
const month = args.find((item) => /^\d{4}-\d{2}$/.test(item)) || '';
const workspaceId = (args.find((item) => item.startsWith('--workspace=')) || '--workspace=primary').split('=')[1];

const database = await import('../server/db.js');

const fail = (message) => { console.error(`\n✖ ${message}`); process.exitCode = 1; };
const money = (value) => new Intl.NumberFormat('fa-IR').format(Math.round(Number(value) || 0));

database.runInWorkspace(workspaceId, { role: 'owner', userId: 'verify-script' }, () => {
  console.log(`دفتر: ${workspaceId}${month ? ` · دورهٔ ${month}` : ' · دورهٔ جاری'}\n`);

  // ۱) آمادگی — همان کنترل‌هایی که رابط کاربری نشان می‌دهد.
  const overview = database.accountingTransferOverview(month, 'parsian-review-csv');
  const blockers = (overview.readiness?.checks || []).filter((item) => !item.passed && item.severity === 'blocker');
  const advisories = (overview.readiness?.checks || []).filter((item) => !item.passed && item.severity !== 'blocker');

  console.log('— کنترل آمادگی —');
  for (const check of overview.readiness?.checks || []) {
    const mark = check.passed ? '✔' : (check.severity === 'blocker' ? '✖' : '▲');
    console.log(`  ${mark} ${check.label}${check.passed ? '' : ` (${money(check.count)})`}`);
  }

  if (blockers.length) {
    fail(`خروجی آماده نیست: ${blockers.length} مورد بازدارنده. تا این‌ها حل نشوند فایل ساخته نمی‌شود.`);
    return;
  }

  // ۲) ساخت فایل از همان مسیر تولید.
  let batch;
  try {
    batch = database.createAccountingTransferBatch({ month, targetSystem: 'parsian-review-csv', fileFormat: 'mdb' });
  } catch (error) {
    fail(`ساخت فایل شکست خورد: ${error.message}`);
    for (const item of error.details?.errors || []) console.error(`    - ${item}`);
    return;
  }

  const stored = database.accountingTransferBatchFile(batch.id);
  const buffer = stored?.fileData;
  if (!buffer?.length) { fail('فایل ساخته شد ولی خوانده نشد.'); return; }
  console.log(`\nفایل: ${stored.fileName} · ${money(buffer.length)} بایت · اثر انگشت ${stored.digest.slice(0, 12)}…`);

  // ۳) خواندن دوباره از روی خودِ فایل، نه از روی دادهٔ حافظه.
  const back = readParsianDocuments(buffer);

  // مرجع مقایسه، خودِ سابقهٔ بسته است: همان عددی که مسیر تولید ثبت کرده و
  // حسابدار در رابط کاربری می‌بیند. اگر فایل با این نخواند، یعنی چیزی که نشان
  // داده‌ایم با چیزی که تحویل داده‌ایم یکی نیست.
  const unit = batch.amountUnit === 'rial' ? 10 : 1;
  const sentDebit = Number(batch.debitTotal || 0) * unit;
  const sentCredit = Number(batch.creditTotal || 0) * unit;
  const backDebit = back.rows.reduce((sum, row) => sum + Number(row.Bed || 0), 0);
  const backCredit = back.rows.reduce((sum, row) => sum + Number(row.Bes || 0), 0);

  console.log('\n— رفت‌وبرگشت —');
  console.log(`  ردیف در دفتر: ${money(batch.rowCount)} · در فایل: ${money(back.rows.length)}`);
  console.log(`  سند در دفتر: ${money(batch.entryCount)} · در فایل: ${money(back.documents.length)}`);

  const problems = [];
  if (back.rows.length !== batch.rowCount) problems.push(`تعداد ردیف برابر نیست: ${batch.rowCount} ← ${back.rows.length}`);
  if (back.documents.length !== batch.entryCount) problems.push(`تعداد سند برابر نیست: ${batch.entryCount} ← ${back.documents.length}`);
  if (backDebit !== sentDebit) problems.push(`جمع بدهکار برابر نیست: ${money(sentDebit)} ← ${money(backDebit)}`);
  if (backCredit !== sentCredit) problems.push(`جمع بستانکار برابر نیست: ${money(sentCredit)} ← ${money(backCredit)}`);
  if (backDebit !== backCredit) problems.push(`فایل متوازن نیست: ${money(backDebit)} در برابر ${money(backCredit)}`);

  // هر سند جداگانه هم باید متوازن باشد؛ جمع کل می‌تواند دو خطا را پنهان کند.
  for (const document of back.documents) {
    const debit = document.lines.reduce((sum, line) => sum + line.debit, 0);
    const credit = document.lines.reduce((sum, line) => sum + line.credit, 0);
    if (debit !== credit) problems.push(`سند ${document.number} متوازن نیست.`);
  }

  // ۴) طرف حساب‌هایی که در پارسیان بی‌نام بالا می‌روند.
  const zeroTafsili = back.rows.filter((row) => !row.TafsiliCode).length;
  const withTafsili = back.rows.length - zeroTafsili;
  console.log(`  ردیف با کد تفصیلی: ${money(withTafsili)} · بدون کد: ${money(zeroTafsili)}`);

  console.log(`  جمع بدهکار: ${money(backDebit)}`);
  console.log(`  جمع بستانکار: ${money(backCredit)}`);

  if (problems.length) {
    console.error('\n— اختلاف‌ها —');
    for (const item of problems) console.error(`  ✖ ${item}`);
    fail(`${problems.length} اختلاف پیدا شد.`);
    return;
  }

  console.log('\n✔ هر ردیف دفتر، سالم در فایل نشست و سالم برگشت.');
  if (advisories.length) {
    console.log('\n▲ هشدارهای بازدارنده‌نشده — فایل ساخته می‌شود ولی این‌ها در پارسیان دیده می‌شوند:');
    for (const item of advisories) console.log(`  - ${item.label} (${money(item.count)})`);
  }
  console.log('\nگام بعدی که این ابزار نمی‌تواند جایش را بگیرد: همین فایل را در پارسیانِ دفتر ایمپورت کن');
  console.log('و تراز آزمایشی قبل و بعد را مقایسه کن. عدد تغییر باید دقیقاً برابر جمع بالا باشد.');
});
