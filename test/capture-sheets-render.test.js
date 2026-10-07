import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('capture sheets render saved decisions and unresolved bank honestly', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { DecisionDetailsSheet, ConfirmationSheet } = await vite.ssrLoadModule('/src/features/capture/CaptureSheets.jsx');
    const item = { amount: 12000000, type: 'expense', category: 'اجاره', rawText: 'اجاره دفتر', accountId: 'cash', confidence: 0.99 };
    const details = renderToStaticMarkup(React.createElement(DecisionDetailsSheet, { item, close() {} }));
    assert.match(details, /اجاره دفتر/);
    assert.doesNotMatch(details, /بررسی آنلاین/);
    const html = renderToStaticMarkup(React.createElement(ConfirmationSheet, {
      result: { transcript: 'از حساب سامان پرداخت کردم', transactions: [{ ...item, accountId: undefined, bankId: 'saman', bankName: 'بانک سامان' }] },
      categories: [{ id: 'rent', name: 'اجاره', type: 'expense' }],
      accounts: [{ id: 'cash', name: 'صندوق نقدی', active: true }],
      onCancel() {}, onConfirm() {},
    }));
    assert.match(html, /value=""[^>]*selected=""/);
    assert.match(html, /حساب را انتخاب کن/);
    assert.doesNotMatch(html, /فعلاً روی حساب پیش‌فرض/);
    assert.match(html, /disabled=""[^>]*>.*تأیید و ارسال/);
    const props={categories:[{id:'software',name:'نرم‌افزار و اشتراک',type:'expense'}],accounts:[{id:'cash',name:'صندوق نقدی',active:true}],onCancel(){},onConfirm(){}};
    const covered={...item,category:'نرم‌افزار و اشتراک',servicePeriodStart:'2026-11-01',occurredAt:'2026-10-07'};
    const dated=renderToStaticMarkup(React.createElement(ConfirmationSheet,{...props,result:{transcript:'امروز پرداخت؛ بهره‌برداری ماه آینده',transactions:[covered]}}));
    assert.doesNotMatch(dated,/تاریخ واقعی پرداخت/);
    const missing=renderToStaticMarkup(React.createElement(ConfirmationSheet,{...props,result:{transcript:'شروع پوشش ماه آینده',transactions:[{...covered,occurredAt:null}]}}));
    assert.match(missing,/تاریخ واقعی پرداخت/);
  } finally { await vite.close(); }
});
