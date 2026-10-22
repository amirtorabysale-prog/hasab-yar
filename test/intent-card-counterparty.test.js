import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { detectVoiceIntent } from '../shared/voiceIntent.js';
import { extractContactCandidate, extractContactName } from '../shared/counterpartySpeech.js';
import { runVoice } from './helpers/voicePipeline.js';

/**
 * نامِ بی‌عنوانِ طرف حساب روی کارت طلب و بدهی و چک.
 *
 * جملهٔ نمونهٔ خودِ صفحهٔ امروز، «رضا ۲ میلیون تومان بدهکار شد»، طلبی بی‌طرف حساب
 * می‌ساخت: نام بی‌عنوان فقط روی صفحهٔ طلب و بدهی برداشته می‌شد، و کارت طلب و بدهی
 * اصلاً فیلدی برای نام نداشت. حالا وقتی کارت ساختاری باز می‌شود (موضوع روشن است)
 * نام بی‌عنوان برداشته و «حدسی» علامت می‌خورد، و کارت آن را نشان می‌دهد تا پیش از
 * ثبت دیده و اصلاح شود. موضوعِ تنها («اجاره»، «قسط») و جمعِ نقش («کارمندا») نام نمی‌شوند؛
 * نقشِ تنها («مشتری»، «صاحب خونه») مثل مسیر عمومی طرف حساب می‌ماند.
 */

const SAMPLE = 'رضا ۲ میلیون تومان بدهکار شد';

test('جملهٔ نمونهٔ صفحهٔ امروز طرف حسابش را دارد', () => {
  assert.ok(readFileSync(new URL('../src/lib/todayExperience.js', import.meta.url), 'utf8').includes(SAMPLE), 'جملهٔ کاربر همان نمونهٔ صفحه است');
  const intent = detectVoiceIntent(SAMPLE);
  assert.equal(intent.intent, 'obligation');
  assert.equal(intent.direction, 'receivable');
  assert.equal(intent.amount, 2_000_000);
  assert.equal(intent.contactName, 'رضا');
  assert.equal(intent.contactGuessed, true);
  // همان راهی که برنامه می‌رود: رویداد طلب با همین طرف حساب.
  const voice = runVoice(SAMPLE);
  assert.equal(voice.path, 'obligation');
  assert.equal(voice.items[0].event.counterparty, 'رضا');
});

test('خانوادهٔ نام بی‌عنوان: جهت، صیغه، جایگاه نام، عدد لاتین، نام دوبخشی و چک', () => {
  const cases = [
    ['رضا 2 میلیون تومان بدهکار شد', 'obligation', 'receivable', 'رضا'],
    ['رضا ۲ میلیون بدهکاره', 'obligation', 'receivable', 'رضا'],
    ['محمد رضایی ۲ میلیون بدهکار شد', 'obligation', 'receivable', 'محمد رضایی'],
    ['به رضا ۲ میلیون بدهکاریم', 'obligation', 'payable', 'رضا'],
    ['۲ میلیون به رضا بدهکار شدیم', 'obligation', 'payable', 'رضا'],
    ['از رضا ۲ میلیون طلب داریم', 'obligation', 'receivable', 'رضا'],
    ['رضا ۲ میلیون طلب داره', 'obligation', 'payable', 'رضا'],
    ['رضا ۲ میلیون طلبکاره', 'obligation', 'payable', 'رضا'],
    // نقش پیش یا پس از نام کنار می‌رود.
    ['مستاجر رضایی ۵ میلیون بدهکار شد', 'obligation', 'receivable', 'رضایی'],
    ['رضایی مستاجر ۵ میلیون بدهکار شد', 'obligation', 'receivable', 'رضایی'],
    ['از رضا یه چک ۵ میلیونی گرفتیم بابت فروش امروز', 'cheque', 'receivable', 'رضا'],
    ['یه چک ۵ میلیونی به رضا دادیم بابت خرید امروز', 'cheque', 'payable', 'رضا'],
  ];
  for (const [text, intent, direction, name] of cases) {
    const found = detectVoiceIntent(text);
    assert.equal(found?.intent, intent, text);
    assert.equal(found.direction, direction, text);
    assert.equal(found.contactName, name, text);
    assert.equal(found.contactGuessed, true, text);
    // صفحهٔ طلب و بدهی همان نام را می‌گیرد؛ دو مسیر یک عدد می‌گویند.
    assert.equal(detectVoiceIntent(text, { context: 'obligation' }).contactName, name, `${text} (صفحهٔ طلب و بدهی)`);
  }
});

test('نام با عنوان قطعی است و حدسی علامت نمی‌خورد', () => {
  for (const [text, name] of [['اقای رضایی ۲ میلیون بدهکار شد', 'رضایی'], ['شرکت پارس ۲ میلیون طلبکاره', 'شرکت پارس']]) {
    const found = detectVoiceIntent(text);
    assert.equal(found.contactName, name, text);
    assert.equal(found.contactGuessed, undefined, text);
  }
});

test('نقشِ تنها طرف حساب است، همان قاعدهٔ مسیر عمومی', () => {
  // ودیعه یا پیش‌دریافتِ «مستاجر» بدهی است نه درآمد و تصمیم سند به همین نام تکیه دارد؛
  // کارت آن را حدسی نشان می‌دهد تا کاربر نام واقعی را بنویسد.
  for (const [text, name] of [['از مشتری ۵ میلیون طلب داریم', 'مشتری'], ['مشتری ۵ میلیون بدهکار شد', 'مشتری'],
    ['صاحب خونه ۳ میلیون طلبکاره', 'صاحب خونه'], ['یه چک ۵ میلیونی از مشتری گرفتیم بابت فروش', 'مشتری']]) {
    const found = detectVoiceIntent(text);
    assert.equal(found.contactName, name, text);
    assert.equal(found.contactGuessed, true, text);
  }
});

test('موضوع، جمعِ نقش، بانک و جملهٔ بی‌نام، طرف حساب نمی‌سازند', () => {
  for (const text of [
    'بابت اجاره ۲ میلیون بدهکاریم', 'اجاره ۲ میلیون بدهکاریم', 'بیمه ۲ میلیون بدهکاریم', 'قسط ۳ میلیون بدهکاریم',
    '۲ میلیون بدهکار شدیم', 'به بانک ۵ میلیون بدهکاریم', 'چک ۵ میلیونی از بانک ملت گرفتیم',
    'حقوق کارمندا ۵۰ میلیون بدهکاریم', 'حقوق کارمند‌ها ۵۰ میلیون بدهکاریم', 'به کارگرا ۳ میلیون بدهکاریم',
  ]) {
    const found = detectVoiceIntent(text);
    assert.ok(found, `${text}: کارت باز می‌شود`);
    assert.equal(found.contactName, '', text);
    assert.equal(found.contactGuessed, undefined, text);
  }
});

test('پارسر عمومی نام بی‌عنوان را قطعی نمی‌گیرد و «پول» نام نیست', () => {
  assert.equal(extractContactName(SAMPLE), '');
  assert.deepEqual(extractContactCandidate('۲۵ میلیون به محسن احتسامی پرداخت شد'), { name: 'محسن احتسامی', confident: false });
  // «به مستاجر پول دادیم» نام را «مستاجر پول» می‌ساخت؛ «پول» موضوع است، نه نام.
  assert.deepEqual(extractContactCandidate('به مستاجر پول دادیم'), { name: 'مستاجر', confident: false });
});

test('کارت طلب و بدهی نام را نشان می‌دهد و حدسی بودنش را می‌گوید', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { IntentSheet } = await vite.ssrLoadModule('/src/features/capture/IntentSheets.jsx');
    const render = (draft) => renderToStaticMarkup(React.createElement(IntentSheet, { draft, setDraft() {}, accounts: [], close() {}, confirm() {} }));
    const guessed = render(detectVoiceIntent(SAMPLE));
    assert.match(guessed, /طرف حساب/);
    assert.match(guessed, /value="رضا"/);
    assert.match(guessed, /نام از گفته‌ات برداشته شد/);
    assert.match(guessed, /aria-describedby="intent-contact-guessed"/);
    // با عنوان: نام هست، تذکر حدس نیست.
    const titled = render(detectVoiceIntent('اقای رضایی ۲ میلیون بدهکار شد'));
    assert.match(titled, /value="رضایی"/);
    assert.doesNotMatch(titled, /نام از گفته‌ات برداشته شد/);
    // بی‌نام: فیلد خالی هست تا کاربر بنویسد.
    const nameless = render(detectVoiceIntent('بابت اجاره ۲ میلیون بدهکاریم'));
    assert.match(nameless, /placeholder="نام شخص یا شرکت"/);
    // چک هم همان تذکر را دارد.
    assert.match(render(detectVoiceIntent('از رضا یه چک ۵ میلیونی گرفتیم بابت فروش امروز')), /نام از گفته‌ات برداشته شد/);
  } finally { await vite.close(); }
});
