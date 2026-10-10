import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('journey never links journals by sentence or by another source type', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { default: Journey, matchingTransactionJournals } = await vite.ssrLoadModule('/src/features/activity/TransactionJourney.jsx');
    const entries = [
      { id: 'real', sourceType: 'transaction', sourceId: 't1' },
      { id: 'same-text', sourceType: 'transaction', sourceId: 't2', memo: 't1' },
      { id: 'invoice', sourceType: 'invoice', sourceId: 't1' },
      { id: 'reverse', sourceType: 'transaction', sourceId: 't1', entryKind: 'reversal' },
    ];
    assert.deepEqual(matchingTransactionJournals(entries, 't1').map(x => x.id), ['real', 'reverse']);
    const html = renderToStaticMarkup(React.createElement(Journey, { item: { id: 't1', rawText: 'فروش ۸۰، دریافت ۳۰', amount: 30_000_000, type: 'income' }, canReadJournal: false, canReview: false }));
    assert.match(html, /وضعیت سند در این دسترسی قابل مشاهده نیست/);
    assert.match(html, /ممکن است تمام مبلغ فروش یا خرید نباشد/);
    assert.doesNotMatch(html, /بازکردن دفتر اسناد|رفتن به صف حسابدار/);
    assert.match(html, /چه گفتید؟/);
  } finally { await vite.close(); }
});
