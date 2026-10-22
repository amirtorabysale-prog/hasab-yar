import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessTransactionReview } from '../shared/review.js';
import { viteConfigSource } from './helpers/viteConfig.js';

/**
 * P1 و P2 بازخورد UX مالک محصول (۲۶ مهر ۱۴۰۵) — دسترس‌پذیری برگه‌ها و صیقل:
 *
 * P1: تلهٔ فوکوس و Escape یکدست در همهٔ برگه‌های مدالی (useSheetA11y)،
 *     skip-link در پوسته، پیام خطای onboarding.
 * P2: پروکسی dev همیشه هم‌مبدأ (پایان 403 INVALID_ORIGIN)، کنتراست
 *     placeholder در حد AA، اطمینان کلی هرگز از ضعیف‌ترین فیلد بالاتر نیست.
 */
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('قلاب دسترس‌پذیری برگه‌ها: Escape، تلهٔ فوکوس، فوکوس اولیه و بازگردانی', () => {
  const hook = source('src/components/sheetA11y.js');
  assert.match(hook, /Escape/, 'بستن با Escape');
  assert.match(hook, /Tab/, 'چرخش فوکوس با Tab');
  assert.match(hook, /preventDefault/, 'خروج فوکوس از برگه مسدود است');
  assert.match(hook, /opener\?\.focus/, 'بازگردانی فوکوس به عنصر بازکننده');
});

test('همهٔ برگه‌های مدالی از قلاب مشترک استفاده می‌کنند', () => {
  const sheets = [
    'src/features/accounting/JournalExplorer.jsx',
    'src/features/accounting/JournalEntrySheet.jsx',
    'src/features/counterparty/CounterpartyMatchSheet.jsx',
    'src/features/understanding/UnderstandingSheet.jsx',
    'src/features/capture/OverdraftApprovalSheet.jsx',
    'src/features/capture/IntentSheets.jsx',
    'src/features/capture/CaptureSheets.jsx',
    'src/features/today/TodayPage.jsx',
    'src/features/ledger/TransactionsPanel.jsx',
    'src/features/ledger/InvoicesPanel.jsx',
    'src/features/pettyCash/PettyCashPage.jsx',
    'src/features/auth/AuthScreens.jsx',
  ];
  for (const file of sheets) {
    const code = source(file);
    assert.match(code, /useSheetA11y/, `${file}: از قلاب مشترک استفاده نمی‌کند`);
    assert.match(code, /ref=\{\w*[Ss]heetRef\}/, `${file}: ref قلاب روی کانتینر بسته نشده`);
  }
});

test('skip-link اولین مقصد کیبورد پوسته است', () => {
  const app = source('src/App.jsx');
  assert.match(app, /skip-link/, 'پیوند پرش وجود دارد');
  assert.match(app, /id="main-content"/, 'محتوای اصلی لنگر دارد');
  const css = source('src/styles.css');
  assert.match(css, /\.skip-link:focus-visible/, 'با فوکوس دیده می‌شود');
});

test('onboarding در خطای ذخیره گیر نمی‌کند و پیام می‌دهد', () => {
  const auth = source('src/features/auth/AuthScreens.jsx');
  assert.match(auth, /role="alert"/, 'پیام خطا با نقش alert');
  assert.match(auth, /try \{[\s\S]*?await onDone[\s\S]*?\} catch/, 'خطا گرفته می‌شود');
});

test('پروکسی dev همیشه هم‌مبدأ است (پایان 403 INVALID_ORIGIN)', () => {
  const config = viteConfigSource();
  assert.match(config, /changeOrigin:\s*true/, 'Host به مقصد بازنویسی می‌شود');
  assert.match(config, /headers:\s*\{\s*origin:/, 'Origin به مقصد بازنویسی می‌شود');
});

test('placeholder در حد AA کنتراست دارد', () => {
  const css = source('src/styles.css');
  assert.doesNotMatch(css, /--c-muted\)\s*\/\s*0\.75/, 'شفافیت ۰٫۷۵ که کنتراست را زیر ۴٫۵ می‌برد حذف شده');
  assert.match(css, /input::placeholder[^}]*rgb\(var\(--c-muted\)\)/, 'placeholder با رنگ کامل muted');
});

test('عدد نمایشی اطمینان کلی از ضعیف‌ترین فیلد سنجیده‌شده بالاتر نمی‌رود؛ مسیریابی عوض نمی‌شود', () => {
  // پیش از فیکس: کارت «چرا این تصمیم؟» «کلی ۹۱٪» را کنار «دسته ۵۵٪» نشان می‌داد.
  const weak = assessTransactionReview({
    amount: 900_000, type: 'income', category: 'فروش',
    confidenceDetails: { amount: { score: 0.97 }, type: { score: 0.94 }, category: { score: 0.55 }, account: { score: 0.9 } },
  });
  assert.equal(weak.state, 'review', 'فیلد ضعیف، وضعیت را به بررسی می‌برد');
  assert.ok(weak.displayPercent <= 55, `نمایش کلی ${weak.displayPercent}٪ از ضعیف‌ترین فیلد بالاتر است`);
  // همهٔ فیلدهای قوی: «آماده» و نمایش هم‌خوان با فیلدها.
  const strong = assessTransactionReview({
    amount: 900_000, type: 'income', category: 'فروش',
    confidenceDetails: { amount: { score: 0.97 }, type: { score: 0.94 }, category: { score: 0.92 }, account: { score: 0.84 } },
  });
  assert.equal(strong.state, 'ready');
  assert.ok(strong.displayPercent <= 84 && strong.displayPercent >= 82, 'نمایش کلی در بازهٔ فیلدهای قوی');
  // فیلد سنجیده‌نشده (پیش‌فرض) عدد نمایشی را خراب نمی‌کند؛ مسیریابی هم دست‌نخورده.
  const partial = assessTransactionReview({
    amount: 900_000, type: 'income', category: 'فروش',
    confidenceDetails: { amount: { score: 0.95 } },
  });
  assert.ok(partial.displayPercent <= 90, `نمایش از فیلد سنجیده‌شده بالاتر نیست: ${partial.displayPercent}`);
  assert.ok(partial.overallScore >= 0.82, 'مسیریابی با weighted قبلی می‌ماند');
});
