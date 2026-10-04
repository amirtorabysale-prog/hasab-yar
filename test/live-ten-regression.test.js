import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFinancialText} from '../shared/parser.js';
import {isCorrectionCommand} from '../shared/correction.js';
import {needsUnquantifiedReview} from '../shared/reviewIntake.js';
import {detectCaptureTransfer} from '../shared/bankSpeech.js';
import {transactionEventDecision} from '../shared/transactionEvent.js';
import {reviewQuestions} from '../shared/reviewQuestions.js';
import {reviewOutputSchema} from '../server/accountingReviewAi.js';
const now=new Date('2026-10-04T10:00:00Z');
const parse=text=>parseFinancialText(text,{now}).transactions;
const samples=[
 ['courier','امروز دویست هزار تومان هزینه پیک از بانک سامان پرداخت کردم؛ آزمون پیک.',200000],
 ['income','امروز هفتصد هزار تومان بابت خدمات چاپ از شرکت آزمون نقش به بانک سامان دریافت کردم؛ آزمون چاپ.',700000],
 ['transfer','امروز پانصد هزار تومان از بانک سامان به بانک پاسارگاد انتقال دادم؛ آزمون انتقال.',500000],
 ['insurance','امروز شش میلیون تومان پیش‌پرداخت بیمه مسئولیت از بانک سامان پرداخت کردم. پوشش بیمه از اول آبان برای شش ماه است؛ آزمون بیمه.',6000000],
 ['deposit','امروز چهار میلیون تومان ودیعه قابل استرداد به آقای آزمون رهن از بانک سامان پرداخت کردم؛ آزمون ودیعه.',4000000],
 ['loan','امروز دو میلیون تومان وام از آقای آزمون وام به بانک سامان دریافت کردم؛ اصل وام است و درآمد نیست.',2000000],
 ['printer','امروز پنج میلیون تومان یک چاپگر برای استفاده دفتر از بانک سامان خریدم؛ آزمون چاپگر.',5000000],
 ['inventory','امروز دو بسته زونکن آزمایشی به بهای کل هشتصد هزار تومان از شرکت آزمون بایگانی نسیه خریدیم و تحویل انبار گرفتیم؛ برای فروش است و هنوز پرداخت نکردیم.',800000],
 ['advance','امروز یک میلیون تومان از شرکت آزمون سفارش بابت پیش‌دریافت سفارش خدمات ماه آینده به بانک سامان گرفتم؛ هنوز خدماتی ارائه نکردیم.',1000000],
];
for(const [name,text,amount] of samples) test(`live ${name}: exact evidence and monetary amount survive extraction`,()=>{
 const items=parse(text);assert.equal(items.length,1);assert.equal(items[0].amount,amount);assert.equal(items[0].rawText,text);
});
test('coverage and future service month never replace today cash date',()=>{
 for(const index of [3,8]) assert.equal(parse(samples[index][1])[0].occurredAt.slice(0,10),'2026-10-04');
});
test('bank and purchase verbs never become counterparty names',()=>{
 assert.equal(parse(samples[0][1])[0].contactName,undefined);
 assert.equal(parse(samples[6][1])[0].contactName,undefined);
 assert.equal(parse(samples[7][1])[0].contactName,'شرکت آزمون بایگانی');
});
test('explicit transfer selects real source and destination without capturing customer receipts',()=>{
 const accounts=[{id:'s',name:'سامان',kind:'bank',bankId:'saman',active:true},{id:'p',name:'پاسارگاد',kind:'bank',bankId:'pasargad',active:true}];
 const draft=detectCaptureTransfer(samples[2][1],{now,accounts});
 assert.equal(draft.fromAccountId,'s');assert.equal(draft.toAccountId,'p');assert.equal(draft.amount,500000);
 assert.equal(detectCaptureTransfer(samples[1][1],{now,accounts}),null);
 assert.equal(detectCaptureTransfer('شرکت آزمون انتقال هفتصد هزار تومان بابت خدمات به بانک سامان واریز کرد',{now,accounts}),null);
});
test('unknown-amount old depreciation correction goes to review, never latest-transaction editor',()=>{
 const text='ثبت استهلاک چاپگر ماه قبل اشتباه شده، لطفاً حسابدار بررسی و اصلاح کند؛ مبلغ را هنوز نمی‌دانم.';
 assert.equal(isCorrectionCommand(text),false);assert.equal(needsUnquantifiedReview(text),true);
 assert.equal(isCorrectionCommand('نه مبلغ همین آخرین ثبت را دو میلیون بزن'),true);
});
test('explicit refundable wording becomes a fact without asking the same question',()=>{
 const item=parse(samples[4][1])[0];const result=transactionEventDecision(item,{transcript:samples[4][1]});
 assert.equal(result.event.refundable,true);
 const negative=transactionEventDecision({...item,rawText:'ودیعه غیرقابل استرداد پرداخت کردم'},{transcript:'ودیعه غیرقابل استرداد پرداخت کردم'});
 assert.equal(negative.event.refundable,false);
});
test('coverage answer cannot overwrite transaction occurrence date',()=>{
 assert.deepEqual(reviewQuestions({questions:[{id:'coverage.start',text:'پوشش بیمه از چه تاریخی شروع می‌شود؟',field:'occurredAt'}]}),[{id:'coverage.start',text:'پوشش بیمه از چه تاریخی شروع می‌شود؟'}]);
 assert.equal(reviewQuestions({questions:[{id:'payment.date',text:'پرداخت چه روزی بود؟',field:'occurredAt'}]})[0].field,'occurredAt');
});
test('structured output contract requires all nested keys and only real catalog IDs',()=>{
 const schema=reviewOutputSchema(['actual-ledger'],['actual-chart']);
 const check=node=>{if(node.type==='object'){assert.equal(node.additionalProperties,false);assert.deepEqual(node.required,Object.keys(node.properties));Object.values(node.properties).forEach(check);}if(node.items)check(node.items);};
 check(schema);assert.deepEqual(schema.properties.lines.items.properties.accountId.enum,[null,'actual-ledger']);
 assert.equal(schema.properties.lines.items.properties.debit.type,'integer');
});
test('two accounts in the named source bank require selection instead of first-match guessing',()=>{
 const accounts=[{id:'s1',name:'سامان یک',kind:'bank',bankId:'saman'},{id:'s2',name:'سامان دو',kind:'bank',bankId:'saman'},{id:'p',name:'پاسارگاد',kind:'bank',bankId:'pasargad'}];
 const draft=detectCaptureTransfer(samples[2][1],{now,accounts});assert.equal(draft.fromAccountId,'');assert.equal(draft.toAccountId,'p');
 const absent=detectCaptureTransfer(samples[2][1],{now,accounts:[]});assert.equal(absent.intent,'transfer');assert.equal(absent.fromAccountId,'');assert.equal(absent.toAccountId,'');
});

test('capture keeps original transcript and unmasked bank in review evidence',()=>{
 const input=samples.find(([name])=>name==='insurance')[1];
 const parsed=parseFinancialText(input,{now});
 assert.equal(parsed.transcript,input);
 const draft=transactionEventDecision(parsed.transactions[0],{transcript:parsed.transcript,sentence:'بیمه از bankplaceholder پرداخت شد'});
 assert.equal(draft.event.evidence,input);
});

test('business questions deduplicate paraphrased coverage and useful life',()=>{
 const q=reviewQuestions({questions:[{id:'coverage',text:'پوشش بیمه از اول آبان چه سالی شروع می‌شود؟'},{id:'life',text:'عمر استفاده مورد انتظار چاپگر چقدر است؟'}],missingFacts:['تاریخ دقیق شروع پوشش بیمه اول آبان کدام سال','عمر استفاده مورد انتظار این چاپگر چقدر است؟']});
 assert.equal(q.length,2);
});
