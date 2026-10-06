import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { reviewQuestions } from '../shared/reviewQuestions.js';

test('question identities remain stable for legacy text and structured paraphrases',()=>{
  assert.equal(reviewQuestions({missingFacts:['واحد کالا؟']})[0].id,reviewQuestions({missingFacts:['واحد کالا ?']})[0].id);
  const q=reviewQuestions({questions:[{id:'inventory.unit',text:'واحد کالا چیست؟'},{id:'inventory.unit',text:'به چه واحدی؟'}],missingFacts:['واحد کالا چیست؟']});
  assert.equal(q.length,1);assert.equal(q[0].id,'inventory.unit');
  assert.equal(reviewQuestions({questions:[{id:'__proto__',text:'آزمون'}]})[0].id.startsWith('question-'),true);
});

test('questions render below proposal with individual boxes, typed dates and persisted answers instead of repeated questions',async()=>{
  const vite=await createServer({server:{middlewareMode:true},appType:'custom'});
  try {
    const {ReviewAssistant}=await vite.ssrLoadModule('/src/features/review/ReviewAssistant.jsx');
    const ai={state:'proposed',summary:'خرید انباری',explanation:'تکمیل مشخصات خرید',canPost:false,questions:[{id:'inventory.name',text:'نام دقیق کالا چیست؟'},{id:'inventory.quantity',text:'چند متر خریدید؟'},{id:'cheque.due_at',text:'سررسید چک چیست؟',field:'dueAt'}],missingFacts:['نام دقیق کالا چیست؟','چند متر خریدید؟','سررسید چک چیست؟'],postingBlockers:['نام دقیق کالا چیست؟','چند متر خریدید؟','سررسید چک چیست؟','مسیر تخصصی لازم است.'],context:{questionAnswers:{'inventory.quantity':{question:'چند متر خریدید؟',value:'۶۰ متر'}}},lines:[]};
    const html=renderToStaticMarkup(React.createElement(ReviewAssistant,{item:{id:'example'},ai,setAi(){},onSaved(){},notify(){}}));
    assert.ok(html.indexOf('نام دقیق کالا چیست؟')>html.indexOf('تأیید و اعمال سند'));
    assert.match(html,/textarea[^>]*aria-label="نام دقیق کالا چیست؟"/);
    assert.match(html,/input[^>]*aria-label="سررسید چک چیست؟"[^>]*type="date"/);
    assert.doesNotMatch(html,/برای فعال شدن ثبت، فقط موارد مشخص‌شدهٔ بالا/);
    assert.doesNotMatch(html,/پاسخ این سؤال را اینجا بنویس…[^>]*aria-label="چند متر خریدید؟"/);
    assert.match(html,/پاسخ‌های ذخیره‌شده/);assert.match(html,/۶۰ متر/);
    assert.match(html,/موارد لازم برای آماده شدن سند/);
    assert.match(html,/disabled=""[^>]*>تأیید و اعمال سند/);
    const answerPanel=html.slice(html.indexOf('aria-label="سؤال‌ها و پاسخ‌های این پرونده"'));
    assert.doesNotMatch(answerPanel,/text-expense/);
  } finally {await vite.close();}
});

test('bank mapping repair states historical impact and requires explicit action before posting',async()=>{
 const vite=await createServer({server:{middlewareMode:true},appType:'custom'});
 try {
  const {ReviewAssistant}=await vite.ssrLoadModule('/src/features/review/ReviewAssistant.jsx');
  const html=renderToStaticMarkup(React.createElement(ReviewAssistant,{item:{id:'bank-case'},ai:{state:'proposed',summary:'بانک',lines:[],canPost:false,mappingRepairs:[{ledgerAccountId:'bank-ledger',accountName:'سامان',chartAccountId:'bank-chart',chartCode:'1102',chartName:'بانک',affectedLines:3}]},setAi(){},onSaved(){},notify(){}}));
  assert.match(html,/نمایش کدینگ 3 سطر قبلی/);assert.match(html,/تأیید اصلاح نگاشت بانک و بازتحلیل/);
  assert.match(html,/disabled=""[^>]*>تأیید و اعمال سند/);
 } finally {await vite.close();}
});

test('paraphrased party and inventory fact questions do not create duplicate answer boxes',()=>{
 const questions=reviewQuestions({questions:[{id:'party.name',text:'نام دقیق طرف حساب را تأیید می‌کنید؟'}],missingFacts:['نام دقیق طرف حساب تأیید شود.','واحد ثبت این کالا چیست؟','واحد کالا چیست؟']});
 assert.equal(questions.length,2);
});

test('missing imported balance has explicit documented preview and separate disabled approval',async()=>{
 const vite=await createServer({server:{middlewareMode:true},appType:'custom'});
 try {
  const {ReviewAssistant}=await vite.ssrLoadModule('/src/features/review/ReviewAssistant.jsx');
  const html=renderToStaticMarkup(React.createElement(ReviewAssistant,{item:{id:'basis-case'},ai:{state:'proposed',id:'p',canPost:false,lines:[],priorBasis:{role:'receivable',amount:50000000,latestDate:'2026-10-06',debit:'طلب مشتری',credit:'سرمایه افتتاحیه'}},setAi(){},onSaved(){},notify(){}}));
  assert.match(html,/ثبت مانده مستند منتقل‌شده/);assert.match(html,/مدیر دفتر/);assert.match(html,/disabled=""[^>]*>تأیید و اعمال سند/);
 } finally {await vite.close();}
});
