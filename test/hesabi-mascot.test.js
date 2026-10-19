import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { mascotAlert, mascotMood, typedAmount } from '../src/lib/mascotMood.js';

/** حسابی، نماد ماشین‌حساب نوار ضبط: حالش از وضعیت واقعی برنامه می‌آید. */

test('حال حسابی به ترتیب اولویت: هشدار، ثبت، سؤال، محاسبه، شنیدن، نوشتن، بیکار', () => {
  assert.equal(mascotMood(), 'idle');
  assert.equal(mascotMood({ manualText: '   ' }), 'idle');
  assert.equal(mascotMood({ manualText: 'اجاره ۱۵ میلیون' }), 'typing');
  assert.equal(mascotMood({ recordState: 'recording' }), 'listening');
  assert.equal(mascotMood({ recordState: 'requesting' }), 'listening');
  assert.equal(mascotMood({ recordState: 'processing' }), 'thinking');
  assert.equal(mascotMood({ recordState: 'finalizing' }), 'thinking');
  assert.equal(mascotMood({ analyzing: true, manualText: 'x' }), 'thinking');
  assert.equal(mascotMood({ reviewing: true }), 'question');
  assert.equal(mascotMood({ asking: true, recordState: 'processing' }), 'question');
  assert.equal(mascotMood({ savedRecently: true, asking: true }), 'success');
  assert.equal(mascotMood({ worried: true, savedRecently: true }), 'worried');
});

test('مبلغِ نوشته‌شده روی LCD، با ارقام فارسی و عدد حروفی', () => {
  assert.equal(typedAmount('۱۵ میلیون اجاره دادم'), 15_000_000);
  assert.equal(typedAmount('اجاره 15 میلیون از سامان'), 15_000_000);
  assert.equal(typedAmount('دو میلیون و سیصد'), 2_300_000);
  assert.equal(typedAmount('۲ میلیون نقد و ۳ میلیون چک'), 3_000_000);
  assert.equal(typedAmount('سلام'), null);
  assert.equal(typedAmount(''), null);
});

test('هشدار: ماندهٔ منفیِ واقعی، یا «خطا» برای صدا', () => {
  assert.equal(mascotAlert({ overdraftPrompt: { kind: 'cash', accounts: [{ after: -15_000_000 }] } }), '−۱۵٬۰۰۰٬۰۰۰');
  assert.equal(mascotAlert({ overdraftPrompt: { kind: 'stock', accounts: [{ after: -3 }] } }), '−');
  assert.equal(mascotAlert({ failure: { message: 'x' } }), 'خطا');
  assert.equal(mascotAlert(), '');
});

test('کامپوننت: تزئینی، مبلغ و هشدار روی LCD، موج واقعیِ میکروفون، ۱۶ کلید', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { HesabiMascot } = await vite.ssrLoadModule('/src/components/HesabiMascot.jsx');
    const idle = renderToStaticMarkup(React.createElement(HesabiMascot, {}));
    assert.match(idle, /class="hs is-idle" aria-hidden="true"/);
    assert.equal((idle.match(/class="hs-k[ "]/g) || []).length + (idle.match(/class="hs-k hs-k-(op|eq)/g) || []).length >= 16, true);
    const id = idle.match(/<pattern id="([^"]+)"/)[1];
    assert.match(id, /^[a-zA-Z0-9_-]+$/);
    assert.ok(idle.includes(`url(#${id})`));
    const typing = renderToStaticMarkup(React.createElement(HesabiMascot, { mood: 'typing', amount: 15_000_000, typed: '۱۵ میلیون' }));
    assert.match(typing, /۱۵٬۰۰۰٬۰۰۰/);
    // دیده‌شده در Chrome: چشم‌ها روی عددِ LCD می‌افتادند. عدد که هست، صورت کنار می‌رود.
    assert.match(typing, /class="hs is-typing hs-has-num"/);
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(HesabiMascot, { mood: 'typing', typed: 'اجاره' })), /hs-has-num/);
    assert.match(renderToStaticMarkup(React.createElement(HesabiMascot, { mood: 'worried', alert: '−۱۵٬۰۰۰٬۰۰۰' })), /−۱۵٬۰۰۰٬۰۰۰/);
    const live = renderToStaticMarkup(React.createElement(HesabiMascot, { mood: 'listening', levels: [44, 22, 11] }));
    assert.match(live, /class="hs is-listening hs-live"/);
    assert.match(live, /scaleY\(1\.00\)/);
  } finally { await vite.close(); }
});

test('حرکت‌ها: پلک‌زدن پایان دارد، hover فقط با ماوس، «کاهش حرکت» همه را می‌ایستاند', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.hs-eyes \{[^}]*animation: hs-blink 5\.4s steps\(1, end\) 6;/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.hs-svg \* \{ animation: none !important; transition: none !important; \}/);
  for (const mood of ['listening', 'typing', 'thinking', 'question', 'success', 'worried']) assert.match(css, new RegExp(`\\.hs\\.is-${mood} `));
  assert.match(css, /\.hs\.is-typing\.hs-has-num \.hs-face \{ opacity: 0; \}/);
  // گوشی: کوچک‌تر و نشانِ وضعیت زیرش؛ دسکتاپ همان ۳px.
  assert.match(css, /\.hs \{ --hs-u: 3px;/);
  assert.match(css, /@media \(max-width: 639px\) \{\s*\.hs \{ --hs-u: 2\.6px; \}\s*\.composer-status \{ flex-direction: column-reverse;/);
  const today = readFileSync(new URL('../src/features/today/TodayPage.jsx', import.meta.url), 'utf8');
  assert.match(today, /<span aria-live="polite"[^>]*>\{composerLabels\[composerState\]\[0\]\}<\/span><HesabiMascot /);
  assert.match(readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'), /mascot=\{mascot\}/);
});
