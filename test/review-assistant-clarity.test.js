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

// بازطراحی ۲۹ مهر ۱۴۰۵: «مشکل» و «راه‌حل» هر کدام یک خط، سؤال یکی‌یکی، دلیل قفل کنار دکمه.
const LOCKED_APPROVE = /disabled=""[^>]*>(?:<svg[\s\S]*?<\/svg>)?تأیید و ثبت سند/;

test('پیش‌نویس قفل‌شده: نشانِ «هیچ چیزی ثبت نشده»، «مشکل» و «راه‌حل» با راهنمای رفع، و سؤال یکی‌یکی', async () => {
  const html = await renderAssistant(lockedProposal);
  assert.match(html, /پیش‌نویس — تا تأیید تو هیچ چیزی ثبت نشده/);
  // سؤالِ بی‌جواب علت است؛ گیرهٔ بانک زیرش با راهنمای رفع می‌آید.
  assert.match(html, /<dt[^>]*>مشکل<\/dt><dd[^>]*>یک سؤال بی‌جواب مانده است\.<\/dd><dd[^>]*>به سؤال پایین جواب بده/);
  assert.match(html, /<li>بانک یا صندوق واقعی را انتخاب کن\. <span[^>]*>— حساب واقعی را در سؤال بانک انتخاب کن/);
  assert.match(html, /<dt[^>]*>راه‌حل<\/dt><dd[^>]*>خرید فن صنعتی سالن/);
  assert.match(html, /هنوز قابل ثبت نیست/);
  assert.match(html, /حساب واقعی را در سؤال بانک انتخاب کن/, 'راهنمای محل رفع گیرهٔ بانک');
  assert.match(html, /سؤال ۱ از ۱/);
  assert.match(html, /قفل تا «مشکل» بالا حل شود/, 'دلیل قفل‌بودن دکمهٔ تأیید کنار خود دکمه');
  assert.match(html, LOCKED_APPROVE);
  assert.doesNotMatch(html, /<details[^>]*open/, 'توضیح بلند پشت «چرا؟» بسته می‌ماند');
  assert.match(html, /\(دارایی ثابت\)/, 'برچسب فارسی نقش سطر بدهکار');
  assert.match(html, /\(وام پرداختنی\)/, 'برچسب فارسی نقش سطر بستانکار');
  // متن‌های مبهم قدیمی نباید برگردند.
  assert.doesNotMatch(html, /اطلاعات تکمیلی را در بخش پایین وارد کن/);
  assert.doesNotMatch(html, /اثرهای عملیاتی پشتیبانی‌شده/);
  assert.doesNotMatch(html, /موارد لازم برای آماده شدن سند/);
});

test('پیش‌نویس آماده: بدون «مشکل»، دکمهٔ تأیید باز و نشان «آمادهٔ ثبت»', async () => {
  const html = await renderAssistant({ ...lockedProposal, canPost: true, postingBlockers: [], questions: [] });
  assert.doesNotMatch(html, /هنوز قابل ثبت نیست/);
  assert.doesNotMatch(html, /<dt[^>]*>مشکل<\/dt>/);
  assert.doesNotMatch(html, /قفل تا «مشکل» بالا حل شود/);
  assert.match(html, /آمادهٔ ثبت/);
  assert.match(html, /<dt[^>]*>سند پیشنهادی<\/dt>/);
  assert.doesNotMatch(html, LOCKED_APPROVE);
});

test('گیرهٔ بدون سؤال: همان گیره «مشکل» است و راه رفعش گفت‌وگو با دستیار', async () => {
  const html = await renderAssistant({ ...lockedProposal, questions: [], postingBlockers: ['پیشنهاد هنوز سطرهای معتبر و متوازن برای ثبت ندارد.'] });
  assert.match(html, /<dt[^>]*>مشکل<\/dt><dd[^>]*>پیشنهاد هنوز سطرهای معتبر و متوازن برای ثبت ندارد\.<\/dd>/);
  assert.match(html, /در «گفت‌وگو با دستیار» بنویس چه چیزی درست است/);
});

test('پرامپت مدل: فارسیِ ساده و نام حساب فقط از فهرست شرکت', () => {
  const prompt = source('server/accountingReviewAi.js');
  assert.match(prompt, /فارسیِ ساده، درست و روان/);
  assert.match(prompt, /هرگز نام حساب از خودت نساز/);
  assert.match(prompt, /حداکثر سه جملهٔ کوتاه/);
});
