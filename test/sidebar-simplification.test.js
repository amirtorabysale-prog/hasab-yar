import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MENU } from '../src/app/menu.js';
import { serverSource } from './helpers/serverSource.js';

/**
 * خواسته‌های مالک محصول (مهر ۱۴۰۵) — منوی تخت و دفتر اسناد با زمان ثبت:
 *
 * «کلا هر بخشی که توی نوار اصلی صفحه ذکر شده نیازی نیست توی نوار سمت راستی
 * سایت ذکر بشه فقط باعث گیج شدن کاربر میشه.»
 * «صف حسابدارم کلا باید یک بخش جدا برای خودش باشه؛ قانون ثبت خودکارم نمیخواد
 * نمایش بدی، همون توی صف حسابدار هست کافیه.»
 * «بخش اسناد تازه ثبت شده باید همه اسناد باز بشه و با تایم دقیق ثبت بشه؛
 * ساعت و دقیقه باید ذکر بشه، ثبت‌کننده باید ذکر بشه.»
 * «توی بخش کارت صندوق و تنخواه برای ساخت صندوق جدید دکمه هست، برای تنخواه
 * جدید نیست.»
 */
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const leaves = MENU.flatMap((group) => group.items.map((item) => ({ group, item })));

// «گزارش‌ها» به خواست مالک محصول (۵ آبان ۱۴۰۵) زیرمجموعهٔ «گزارش‌های حسابداری» دارد.
test('گروه‌های منو تک‌مقصدها‌ند؛ فقط میز کار و گزارش‌ها دو مقصد جدا دارند', () => {
  for (const group of MENU) {
    if (group.id === 'desk') { assert.ok(group.items.length > 1, 'میز کار دو صفحه دارد'); continue; }
    if (group.id === 'reports') { assert.deepEqual(group.items.map((item) => item.screen), ['report', 'accounting-reports']); continue; }
    assert.equal(group.items.length, 1, `${group.label}: فقط یک مقصد`);
  }
});

test('زبانه‌های بالای صفحه‌ها در سایدبار تکرار نشده‌اند', () => {
  // هر زبانه‌ای که نوار بالای دفتر مالی، حسابداری، کدینگ، همکاری یا تنظیمات
  // می‌سازد، دیگر برگ منو نیست.
  const topBarSections = ['obligations', 'timing', 'invoices', 'inventory', 'reconciliation', 'recurring', 'tools',
    'cards-banks', 'cards-cash', 'cards-people', 'trial', 'entry', 'worklist', 'payroll', 'period',
    'mapping', 'dimensions', 'import', 'questions', 'dna', 'accounts', 'team', 'backup', 'privacy', 'security', 'learning'];
  for (const { group, item } of leaves) {
    assert.ok(!topBarSections.includes(item.section), `${group.label}/${item.label}: زبانهٔ بالای صفحه در منو تکرار شده`);
  }
});

test('صف حسابدار بخش جدا است و قانون ثبت خودکار برگ منو نیست', () => {
  assert.ok(MENU.some((group) => group.id === 'review' && group.label === 'صف حسابدار'), 'صف حسابدار گروه خودش را دارد');
  assert.ok(!leaves.some(({ item }) => item.section === 'automation-policy'), 'قانون ثبت خودکار برگ منو نیست');
  // پنل همان‌جا داخل صف حسابدار می‌ماند.
  assert.match(source('src/features/review/ReviewQueuePage.jsx'), /id="automation-policy"/);
});

test('دریافت و پرداخت و بانک/صندوق/اشخاص یک گزینه‌اند؛ تعریف صندوق و بانک فقط در تنظیمات', () => {
  const cash = MENU.find((group) => group.id === 'cash');
  assert.equal(cash.label, 'دریافت و پرداخت');
  assert.ok(!MENU.some((group) => group.label.includes('بانک، صندوق و اشخاص')), 'گروه جداگانهٔ بانک/صندوق/اشخاص حذف شده است');
  assert.ok(!leaves.some(({ item }) => item.section === 'accounts'), 'تعریف صندوق و بانک از منو بیرون است');
  // در تنظیمات زبانهٔ «صندوق و بانک» سر جایش است.
  assert.match(source('src/App.jsx'), /part === 'accounts'/);
});

test('کارت صندوق و تنخواه دکمهٔ «تنخواه تازه» هم دارد', () => {
  const cards = source('src/features/counterparty/AccountCardsPanel.jsx');
  assert.match(cards, /تنخواه تازه/, 'دکمهٔ تنخواه تازه در کارت صندوق و تنخواه');
  assert.match(cards, /onNewPetty/, 'دکمه به مسیر ساخت تنخواه وصل است');
  const ledger = source('src/features/ledger/LedgerPage.jsx');
  assert.match(ledger, /pettyAvailable/, 'تنخواه فقط در پروندهٔ کسب‌وکار پیشنهاد می‌شود');
  const app = source('src/App.jsx');
  assert.match(app, /autoCreate=\{section === 'new'\}/, 'پرش به فرم تنخواه تازه');
  const petty = source('src/features/pettyCash/PettyCashPage.jsx');
  assert.match(petty, /autoCreate/);
});

test('دفتر اسناد: زمان ثبت با ساعت و دقیقه و نام ثبت‌کننده', () => {
  const explorer = source('src/features/accounting/JournalExplorer.jsx');
  assert.match(explorer, /زمان ثبت/, 'ستون زمان ثبت');
  assert.match(explorer, /ثبت‌کننده/, 'ستون ثبت‌کننده');
  assert.match(explorer, /timeStyle: 'short'/, 'ساعت و دقیقه');
  assert.match(explorer, /limit: 100/, 'همهٔ اسناد یک‌جا باز می‌شوند');
  const server = source('server/db/journal.js');
  assert.match(server, /journalOverview/);
  assert.match(server, /createdByName/, 'نام نمایشی ثبت‌کننده از سرور می‌آید');
  const index = serverSource();
  assert.match(index, /journalOverview\(request\.query\)/);
});

test('کلیک روی هر سند، برگهٔ جزئیات کامل را باز می‌کند', () => {
  // خواستهٔ مالک (۲۶ مهر ۱۴۰۵): «روی سند که می‌زنم می‌خوام باز بشه و جزئیاتش
  // قشنگ نمایش داده بشه» — برگهٔ مدالی با همهٔ سطرها، نه پنل انتهای فهرست.
  const explorer = source('src/features/accounting/JournalExplorer.jsx');
  assert.match(explorer, /JournalDocumentSheet/, 'برگهٔ بازشوی سند وجود دارد');
  assert.match(explorer, /role="dialog"/, 'مدال با نقش dialog');
  assert.match(explorer, /aria-modal="true"/, 'مدال معلولیت‌پسند');
  assert.match(explorer, /setOpenEntry\(entry\)/, 'کلیک روی ردیف، سند را باز می‌کند');
  assert.match(explorer, /useSheetA11y/, 'بستن با Escape و تلهٔ فوکوس از قلاب مشترک');
  assert.doesNotMatch(explorer, /setSelected\(result\.items\[0\]/, 'انتخاب خودکار اولین سند و پنل پایین فهرست حذف شد');
});
