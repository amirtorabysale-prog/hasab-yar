import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

/** صفحهٔ «آنچه یاد گرفته‌ام»: بخش یادگیری از AI، دکمه‌ها به نقش، و منشأ هر یادگیری. */

test('بخش «یادگیری از AI» با قول «فقط دسته، هرگز جهت پول» و دانلود گزارش', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { LearningPage } = await vite.ssrLoadModule('/src/features/learning/LearningPage.jsx');
    const markup = renderToStaticMarkup(React.createElement(LearningPage, { categories: [{ id: 'c1', name: 'خوراک' }], notify: () => {}, role: 'manager' }));
    assert.match(markup, /یادگیری از AI/);
    assert.match(markup, /هرگز جهت پول را/);
    assert.match(markup, /اختلاف‌های ساختاری/);
    assert.match(markup, /دانلود گزارش اختلاف‌ها/);
    assert.match(markup, /یادگیری خودکار بعد از/, 'مدیر تعداد تأیید را تعیین می‌کند');
    const viewer = renderToStaticMarkup(React.createElement(LearningPage, { categories: [], notify: () => {}, role: 'viewer' }));
    assert.doesNotMatch(viewer, /یادگیری خودکار بعد از/, 'فقط‌مشاهده آستانه را نمی‌بیند');
  } finally { await vite.close(); }
});

test('App نقش را به صفحه می‌دهد و هر یادگیری منشأ خودش را نشان می‌دهد', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /<LearningPage categories=\{data\.categories\} notify=\{notify\} role=\{access\.workspace\?\.role\} \/>/);
  const page = readFileSync(new URL('../src/features/learning/LearningPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /const SOURCE_LABELS = \{ ai: 'از AI', accountant: 'از تأیید حسابدار', topic: 'از ارتقای موضوع', history: 'از سابقهٔ دفتر' \}/);
});
