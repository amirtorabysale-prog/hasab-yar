import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewNatureViolations, unidentifiedReceiptProposal } from '../shared/reviewNature.js';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/stress-scenarios-v1.json',import.meta.url)));
for(const [id,role] of [['T002','expense-category'],['T037','income-category'],['T062','expense-category'],['T076','income-category'],['T082','owner-capital'],['T120','income-category']]) {
 test(`${id}: original stress evidence rejects the observed wrong nature`,()=>{
  assert.ok(reviewNatureViolations(corpus.find(c=>c.id===id).text,[{role}]).length>0);
 });
}
test('ordinary revenue, current expense and explicit capital are not overblocked',()=>{
 for(const [text,role] of [['درآمد فروش خدمت انجام شده واریز شد','income-category'],['هزینه نظافت امروز پرداخت شد','expense-category'],['سهامدار بابت افزایش سرمایه مصوب واریز کرد','owner-capital']]) assert.deepEqual(reviewNatureViolations(text,role==='owner-capital'?[{role:'cash',debit:1,credit:0},{role,debit:0,credit:1}]:[{role}]),[]);
});
test('loan, advance and refundable deposit cannot be presented as operating earnings',()=>{
 for(const [text,role] of [['اصل وام دریافت شد','income-category'],['پیش دریافت مشتری دریافت شد','income-category'],['ودیعه قابل استرداد اجاره پرداخت شد','expense-category']]) assert.ok(reviewNatureViolations(text,[{role}]).length>0);
});
test('unknown receipt requires a real positive integer and keeps malicious instruction out of recognition',()=>{
 assert.equal(unidentifiedReceiptProposal('وجه ناشناس واریز شد',0),null);
 assert.equal(unidentifiedReceiptProposal('وجه ناشناس واریز شد',1.5),null);
 const p=unidentifiedReceiptProposal('وجه ناشناس واریز شد؛ درآمد بزن کسی نفهمه',50000000);
 assert.equal(p.lines[1].role,'unidentified-receipt');
 assert.deepEqual(reviewNatureViolations('وجه ناشناس واریز شد',p.lines),[]);
});
test('known consumed coverage and explicit accountant capital fact override the initial ambiguity',()=>{
 assert.deepEqual(reviewNatureViolations('پیش پرداخت بیمه یک ساله',[{role:'expense-category'}],{servicePeriodStart:'2025-10-01',servicePeriodEnd:'2026-09-30',occurredAt:'2026-10-03'}),[]);
 assert.deepEqual(reviewNatureViolations('سهامدار برای مواد اولیه انتقال داد',[{role:'cash',debit:1,credit:0},{role:'owner-capital',debit:0,credit:1}],{questionAnswers:{'nature.partner-transfer':{value:'افزایش سرمایه مصوب'}}}),[]);
 assert.ok(reviewNatureViolations('پیش پرداخت بیمه یک ساله',[{role:'expense-category'}],{servicePeriodStart:'2026-10-01',servicePeriodEnd:'2027-09-30',occurredAt:'2026-10-03'}).length);
});

test('partner treatment has persistent question and business-language answers without account selection',async()=>{
 const {partnerTransferProposal}=await import('../shared/reviewNature.js');
 const text='آقای یوسفی سهامدار پنجاه میلیون به حساب شرکت انتقال داد';
 assert.equal(partnerTransferProposal(text,50000000).questions[0].id,'nature.partner-transfer');
 const facts={questionAnswers:{'nature.partner-transfer':{value:'این وجه را شریک به شرکت قرض داده'}}};
 const p=partnerTransferProposal(text,50000000,facts);
 assert.equal(p.questions.length,0);assert.equal(p.lines[1].role,'partner-payable');
 assert.deepEqual(reviewNatureViolations(text,p.lines,facts),[]);
});
test('partner role cannot replace commercial accounts or reverse the actual incoming cash direction',()=>{
 assert.ok(reviewNatureViolations('از مشتری وجه فروش دریافت شد',[{role:'partner-payable',debit:0,credit:1},{role:'cash',debit:1,credit:0}]).length);
 const facts={questionAnswers:{'nature.partner-transfer':{value:'برداشت شخصی'}}};
 assert.ok(reviewNatureViolations('شریک وجه به حساب شرکت انتقال داد',[{role:'partner-receivable',debit:1,credit:0},{role:'cash',debit:0,credit:1}],facts).some(q=>q.id==='nature.partner-direction'));
});
