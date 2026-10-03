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
