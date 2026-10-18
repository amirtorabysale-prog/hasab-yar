import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

/**
 * شفاف‌سازی مسیر «تحلیل کن» در صف حسابدار — بازخورد مالک محصول (۲۷ مهر ۱۴۰۵):
 *
 * مالک گفت مواردی که با «تحلیل کن» پیش می‌روند گیج‌کننده‌اند: معلوم نبود چه
 * چیزی از او خواسته می‌شود و چرا دکمهٔ تأیید قفل است. این آزمون‌ها قفل می‌کنند:
 *
 * ۱. پیش‌نویس با نشان «هیچ چیزی ثبت نشده» و نقشهٔ سه‌گامی مسیر شروع می‌شود.
 * ۲. گیره‌های ثبت بالای کارت با پرسش «چرا هنوز قابل ثبت نیست؟» و راهنمای
 *    «از کجا حل می‌شود؟» می‌آیند — نه در جعبهٔ مبهم پایین صفحه.
 * ۳. کنار دکمهٔ تأییدِ قفل، دلیل قفل نوشته شده است.
 * ۴. هر سطر پیشنهاد برچسب فارسی نقش دارد (وام پرداختنی، دارایی ثابت، …) تا
 *    «1100 وام جاری» بی‌رمز خوانده شود.
 * ۵. پرامپت مدل فارسیِ خلاصه/توضیح را کاری می‌کند: جملهٔ کوتاه، نام حساب فقط
 *    از فهرست شرکت — نه واژه‌های ساختهٔ مدل.
 */
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const lockedProposal = {
  state: 'proposed', id: 'p1', summary: 'خرید فن صنعتی سالن به مبلغ ۲٬۵۰۰٬۰۰۰ تومان.',
  explanation: 'خرید ملزومات سالن است و پرداخت از حساب بانک انجام شده است.',
  canPost: false,
  questions: [{ id: 'cash.account', text: 'وجه از کدام بانک یا صندوق واقعی پرداخت یا دریافت شد؟', field: 'accountId' }],
  postingBlockers: ['بانک یا صندوق واقعی را انتخاب کن.'],
  lines: [
    { role: 'fixed-asset', key: 'فن صنعتی', debit: 2500000, credit: 0, accountCode: '1127', accountName: 'اصول، ماشین‌آلات و تجهیزات' },
    { role: 'loan-payable', key: null, debit: 0, credit: 2500000, accountCode: '1100', accountName: 'وام جاری بانک' },
  ],
  context: {},
};

async function renderAssistant(ai) {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { ReviewAssistant } = await vite.ssrLoadModule('/src/features/review/ReviewAssistant.jsx');
    return renderToStaticMarkup(React.createElement(ReviewAssistant, { item: { id: 'clarity-case' }, ai, setAi() {}, onSaved() {}, notify() {} }));
  } finally { await vite.close(); }
}

test('پیش‌نویس قفل‌شده: نشانِ «هیچ چیزی ثبت نشده»، نقشهٔ سه‌گامی و پنل «چرا هنوز قابل ثبت نیست؟» با راهنمای رفع', async () => {
  const html = await renderAssistant(lockedProposal);
  assert.match(html, /پیش‌نویس — تا تأیید تو هیچ چیزی ثبت نشده/);
  assert.match(html, /aria-label="مسیر تکمیل سند"/);
  assert.match(html, /۲\. غلط یا ناقص بود\؟ در گفت‌وگو اصلاحش کن/);
  assert.match(html, /چرا هنوز قابل ثبت نیست\؟/);
  assert.match(html, /بانک یا صندوق واقعی را انتخاب کن\./);
  assert.match(html, /از بخش «مشاهده یا اصلاح تاریخ، طرف‌حساب و بانک»/, 'راهنمای محل رفع گیرهٔ بانک');
  assert.match(html, /قفل — تا رفع موارد بالا/, 'دلیل قفل‌بودن دکمهٔ تأیید روی خود دکمه');
  assert.match(html, /disabled=""[^>]*>تأیید و اعمال سند/);
  assert.match(html, /\(دارایی ثابت\)/, 'برچسب فارسی نقش سطر بدهکار');
  assert.match(html, /\(وام پرداختنی\)/, 'برچسب فارسی نقش سطر بستانکار');
  // متن‌های مبهم قدیمی نباید برگردند.
  assert.doesNotMatch(html, /اطلاعات تکمیلی را در بخش پایین وارد کن/);
  assert.doesNotMatch(html, /اثرهای عملیاتی پشتیبانی‌شده/);
  assert.doesNotMatch(html, /موارد لازم برای آماده شدن سند/);
});

test('پیش‌نویس آماده: بدون پنل گیره، دکمهٔ تأیید باز و جملهٔ وضعیت روشن', async () => {
  const html = await renderAssistant({ ...lockedProposal, canPost: true, postingBlockers: [], questions: [] });
  assert.doesNotMatch(html, /چرا هنوز قابل ثبت نیست\؟/);
  assert.doesNotMatch(html, /قفل — تا رفع موارد بالا/);
  assert.match(html, /پیش‌نویس کامل است\. با تأیید تو سند ثبت می‌شود/);
  assert.doesNotMatch(html, /disabled=""[^>]*>تأیید و اعمال سند/);
  assert.match(html, /۳\. درست شد\؟ تأیید و ثبت/);
});

test('گیرهٔ بدون سؤال: به‌جای جعبهٔ خالی، مسیر گفت‌وگو پیشنهاد می‌شود', async () => {
  const html = await renderAssistant({ ...lockedProposal, questions: [], postingBlockers: ['پیشنهاد هنوز سطرهای معتبر و متوازن برای ثبت ندارد.'] });
  assert.match(html, /اصلاح را در گفت‌وگو بنویس و «ارسال و بازبینی پیشنهاد» را بزن/);
});

test('پرامپت مدل: فارسیِ ساده و نام حساب فقط از فهرست شرکت', () => {
  const prompt = source('server/accountingReviewAi.js');
  assert.match(prompt, /فارسیِ ساده، درست و روان/);
  assert.match(prompt, /هرگز نام حساب از خودت نساز/);
  assert.match(prompt, /حداکثر سه جملهٔ کوتاه/);
});
