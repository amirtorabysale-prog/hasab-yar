import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {tempDatabase} from './helpers/tempPath.js';
import {extractContactCandidate} from '../shared/counterpartySpeech.js';
import {reviewNatureViolations} from '../shared/reviewNature.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
const cases=Object.fromEntries(JSON.parse(readFileSync(new URL('../docs/testing/new-ten-2026-10-06-evidence.json',import.meta.url))).cases);
process.env.DATABASE_PATH=tempDatabase('review-rerun-ten');
process.env.ADMIN_USERNAME='rerun-owner';process.env.ADMIN_PASSWORD=`test-${crypto.randomUUID()}`;
process.env.OPENAI_API_KEY='test-only-key';
const db=await import('../server/db.js'),store=await import('../server/financialEventStore.js');
const ai=await import('../server/accountingReviewAi.js'),assistant=await import('../server/reviewAssistant.js');
const accounting=await import('../server/accounting.js'),resolver=await import('../server/roleResolver.js');
db.ensureAdmin();const owner=db.authenticateUser(process.env.ADMIN_USERNAME,process.env.ADMIN_PASSWORD);
const noNetwork=async()=>{throw new Error('Explicit supported facts must not need model API');};
const fake=p=>async()=>({ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(p)}]}]})});
const database=()=>db.activeWorkspaceDatabase();
const row=item=>database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id);
const prepared=(item,p)=>assistant.prepareReviewProposal(database(),row(item),p);
function office(name,fn) {
  const workspace=db.createWorkspace(owner.id,{name:`بازآزمایی محلی ${name}`,profileType:'business'});
  return db.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id, overdraftApproval: FIXTURE_OVERDRAFT },()=>{db.installChartTemplate();return fn();});
}
function event(id,amount,extra={}) {
  return store.recordFinancialEvent(database(),{kind:'cash-expense',amount,category:'سایر هزینه‌ها',occurredAt:'2026-10-07',evidence:cases[id],eventNature:'new',...extra},
    {sourceEventId:crypto.randomUUID(),decision:{route:'accountant-review',guardBlocked:true,reasons:['آزمون صف']}});
}
const lines=item=>database().prepare('SELECT a.source_kind,a.source_key,a.name,a.type,l.debit,l.credit,l.analytic_id FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.entry_id=?').all(item.journalEntryId);

test('N05 complete organization -> real deposit journal and cash, no API or duplicate, reversible',()=>office('سپرده',async()=>{
  const item=event('N05',11000000,{accountId:'cash',counterparty:'سازمان توسعه'});
  const p=await ai.proposeReview(database(),item.id,{fetcher:noNetwork});
  const ready=prepared(item,p),before=db.listAccounts().find(a=>a.id==='cash').balance;
  assert.equal(p.analysisCost.source,'rules');assert.equal(ready.newCounterparty.name,'سازمان توسعه آزمون');assert.equal(ready.canPost,true,ready.postingBlockers.join('|'));
  assert.equal(database().prepare('SELECT COUNT(*) n FROM contacts').get().n,0);
  const posted=db.reviewAiFeedback(item.id,p.id,{accepted:true}).item;
  const party=database().prepare('SELECT id FROM contacts WHERE name=?').get('سازمان توسعه آزمون');
  assert.ok(party);assert.equal(lines(posted).find(l=>l.source_kind==='refundable-deposit').source_key,party.id);
  assert.equal(lines(posted).find(l=>l.source_kind==='refundable-deposit').debit,11000000);
  assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,before-11000000);
  assert.equal(database().prepare('SELECT accounting_role FROM transactions WHERE client_id=?').get(`review:${item.id}`).accounting_role,'refundable-deposit');
  assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}));
  db.reverseEvent(item.id,'برگشت سپرده آزمایشی');assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,before);
}));

test('N08 explicit in-cash phrase -> customer advance with operational cash and no new revenue',()=>office('پیش‌دریافت',async()=>{
  const item=event('N08',17000000,{kind:'cash-income',counterparty:'شرکت سرو آزمون',accountId:'cash'});
  const p=await ai.proposeReview(database(),item.id,{fetcher:noNetwork});
  const ready=prepared(item,p);assert.equal(ready.canPost,true,ready.postingBlockers.join('|'));assert.equal(ready.questions.length,0);
  const posted=db.reviewAiFeedback(item.id,p.id,{accepted:true}).item;
  assert.equal(lines(posted).find(l=>l.source_kind==='operational-account').debit,17000000);
  assert.equal(lines(posted).find(l=>l.source_kind==='customer-advance').credit,17000000);
  assert.ok(!lines(posted).some(l=>l.source_kind==='income-category'));
  assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,17000000);
}));

test('grounded accountant correction overrides an old bare-name guess at preview and actual approval',()=>office('اصلاح نام',async()=>{
  const evidence='امروز از صندوق نقدی دو میلیون تومان ودیعه قابل استرداد به محسن نادری پرداخت کردیم';
  const item=event('N05',2000000,{evidence,counterparty:'محسن',accountId:'cash'});
  const model={summary:'ودیعه',explanation:'پرداخت ودیعه',counterpartyName:'محسن نادری',questions:[],missingFacts:[],lines:[{role:'refundable-deposit',debit:2000000,credit:0},{role:'cash',debit:0,credit:2000000}]};
  const p=await ai.proposeReview(database(),item.id,{message:'نام دقیق طرف قرارداد محسن نادری است، محسن به تنهایی ناقص است.',fetcher:fake(model)});
  assert.equal(prepared(item,p).newCounterparty.name,'محسن نادری');
  const posted=db.reviewAiFeedback(item.id,p.id,{accepted:true}).item;
  const party=database().prepare('SELECT id FROM contacts WHERE name=?').get('محسن نادری');
  assert.equal(lines(posted).find(l=>l.source_kind==='refundable-deposit').source_key,party.id);
}));

test('N04 explicit confirmed imported advance -> separate basis, real refund, zero liability and no repeat',()=>office('مبنای عودت',async()=>{
  const party=db.saveContact({name:'شرکت آذرخش'}),item=event('N04',8400000,{counterpartyId:party.id,accountId:'cash'});
  const p=await ai.proposeReview(database(),item.id,{fetcher:noNetwork});
  assert.equal(prepared(item,p).canPost,false);assert.equal(prepared(item,p).priorBasis.role,'customer-advance');
  const input={proposalId:p.id,amount:8400000,occurredAt:'2026-09-30',reference:'مبنای ساختگی آزمون: پیش‌دریافت مستند دفتر قبلی',confirmed:true};
  assert.throws(()=>db.recordReviewPriorBasis(item.id,{...input,confirmed:false}),{code:'REVIEW_BASIS_INVALID'});
  assert.throws(()=>db.recordReviewPriorBasis(item.id,{...input,occurredAt:'2026-10-07'}),{code:'REVIEW_BASIS_INVALID'});
  const basis=db.recordReviewPriorBasis(item.id,input);assert.ok(basis.journal.id);assert.equal(row(item).status,'pending');
  const fresh=await ai.proposeReview(database(),item.id,{fetcher:noNetwork});assert.equal(prepared(item,fresh).canPost,true);
  const posted=db.reviewAiFeedback(item.id,fresh.id,{accepted:true}).item;
  assert.equal(lines(posted).find(l=>l.source_kind==='customer-advance').debit,8400000);
  assert.equal(lines(posted).find(l=>l.source_kind==='operational-account').credit,8400000);
  const ledger=lines(posted).find(l=>l.source_kind==='customer-advance').source_key;
  assert.equal(database().prepare('SELECT SUM(l.credit-l.debit) n FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE a.source_kind=? AND a.source_key=?').get('customer-advance',ledger).n,0);
  assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,-8400000);
  assert.throws(()=>db.reviewAiFeedback(item.id,fresh.id,{accepted:true}));
}));

test('N04 future or draft advances cannot finance a refund; approval change invalidates cached proposal',()=>office('مبنای نامعتبر',async()=>{
  const party=db.saveContact({name:'شرکت آذرخش'}),item=event('N04',8400000,{counterpartyId:party.id,accountId:'cash'});
  const cash=resolver.resolveEventRole(database(),'cash','cash'),liability=resolver.resolveEventRole(database(),'customer-advance',party.name,{counterpartyId:party.id});
  const seed=(occurredAt,approvalState)=>accounting.postJournalEntry(database(),{sourceType:'test-advance',sourceId:crypto.randomUUID(),occurredAt,approvalState,lines:[{accountId:cash,debit:8400000,credit:0},{accountId:liability,debit:0,credit:8400000}]});
  seed('2026-11-01','approved');const draft=seed('2026-10-01','draft');
  const p=await ai.proposeReview(database(),item.id,{fetcher:noNetwork});assert.equal(prepared(item,p).canPost,false);
  const count=database().prepare('SELECT COUNT(*) n FROM transactions').get().n;
  assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}),{code:'REVIEW_DETAILS_REQUIRED'});
  assert.equal(database().prepare('SELECT COUNT(*) n FROM transactions').get().n,count);
  database().prepare("UPDATE journal_entries SET approval_state='approved' WHERE id=?").run(draft.id);
  assert.equal(prepared(item,p).canPost,false); // old knowledge fingerprint
  const fresh=await ai.proposeReview(database(),item.id,{fetcher:noNetwork});assert.notEqual(fresh.id,p.id);assert.equal(prepared(item,fresh).canPost,true);
}));

test('N10 deleted receivable cannot be paid out of another live balance or invented opening equity',()=>office('طلب حذف‌شده',async()=>{
  const party=db.saveContact({name:'شرکت ماهور'}),item=event('N10',6800000,{kind:'review-placeholder',amountReferenceOnly:true,counterpartyId:party.id,accountId:'cash'});
  const receivable=resolver.resolveEventRole(database(),'receivable',party.name,{counterpartyId:party.id}),equity=resolver.resolveEventRole(database(),'owner-capital');
  accounting.postJournalEntry(database(),{sourceType:'test-other-receivable',sourceId:crypto.randomUUID(),occurredAt:'2026-09-01',lines:[{accountId:receivable,debit:20000000,credit:0},{accountId:equity,debit:0,credit:20000000}]});
  const wrong={summary:'وصول',explanation:'وصول طلب',questions:[],missingFacts:[],lines:[{role:'cash',debit:6800000,credit:0},{role:'receivable',debit:0,credit:6800000}]};
  const p=await ai.proposeReview(database(),item.id,{fetcher:fake(wrong)}),ready=prepared(item,p);
  assert.equal(ready.canPost,false);assert.equal(ready.priorBasis,null);assert.ok(ready.postingBlockers.some(b=>b.includes('حذف‌شده')));
  assert.throws(()=>db.recordReviewPriorBasis(item.id,{proposalId:p.id,amount:6800000,occurredAt:'2026-09-01',reference:'مرجع فرضی نباید طلب حذف‌شده بسازد',confirmed:true}),{code:'REVIEW_BASIS_INVALID'});
  assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}),{code:'REVIEW_DETAILS_REQUIRED'});assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,0);
  assert.ok(reviewNatureViolations(cases.N10,[{role:'income-category'}]).length);
}));

test('N09 capital proposal asks lease term and approved policy; saved answers permit a real fixed-asset journal',()=>office('بهسازی',async()=>{
  const item=event('N09',15000000,{accountId:'cash'});
  const model={summary:'بهسازی دفتر',explanation:'بهسازی چندساله',questions:[],missingFacts:[],lines:[{role:'fixed-asset',key:'بهسازی سیستم برق دفتر استیجاری',debit:15000000,credit:0},{role:'cash',debit:0,credit:15000000}]};
  const p=await ai.proposeReview(database(),item.id,{fetcher:fake(model)});assert.equal(prepared(item,p).canPost,false);
  assert.ok(p.questions.some(q=>q.id==='leasehold.lease-term'));assert.ok(p.questions.some(q=>q.id==='leasehold.capitalization-policy'));
  const fresh=await ai.proposeReview(database(),item.id,{facts:{questionAnswers:{'leasehold.lease-term':{value:'چهار سال قطعی حق استفاده باقی مانده است'},'leasehold.capitalization-policy':{value:'طبق سیاست مصوب شرکت این بهسازی بالاتر از حد نصاب و سرمایه ای است'}}},fetcher:fake(model)});
  assert.equal(prepared(item,fresh).canPost,true,prepared(item,fresh).postingBlockers.join('|'));
  const posted=db.reviewAiFeedback(item.id,fresh.id,{accepted:true}).item;assert.equal(lines(posted).find(l=>l.type==='asset' && l.debit).debit,15000000);
  assert.ok(!lines(posted).some(l=>l.type==='expense'));
  assert.equal(database().prepare('SELECT capital_flow FROM transactions WHERE client_id=?').get(`review:${item.id}`).capital_flow,'fixed-asset');
  assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,-15000000);
}));

test('N02 unavailable prior documents stay an actionable workflow hold, without repeating the answered question',()=>office('مالیات مخلوط',async()=>{
  const item=db.queueUnmatchedSettlement(cases.N02,{clientId:crypto.randomUUID()}),p=await ai.proposeReview(database(),item.id,{fetcher:noNetwork});
  const fresh=await ai.proposeReview(database(),item.id,{facts:{questionAnswers:{'nature.tax-penalty-basis':{value:'اصل مالیات پنج میلیون و جریمه یک میلیون است؛ سند بدهی قبلی در دسترس نیست'}}},fetcher:noNetwork});
  assert.equal(fresh.questions.length,0);assert.ok(fresh.workflowBlockers.length);assert.equal(prepared(item,fresh).canPost,false);
  assert.equal(database().prepare('SELECT COUNT(*) n FROM transactions').get().n,0);
  assert.throws(()=>db.reviewAiFeedback(item.id,fresh.id,{accepted:true}));
}));

test('time phrases cannot be people; explicit organizations retain full titles',()=>{
  assert.deepEqual(extractContactCandidate(cases.N06),{name:'',confident:false});
  assert.equal(extractContactCandidate(cases.N05).name,'سازمان توسعه آزمون');
});

test('N06 unsupported intangible is reported as application work, not an unanswered account-selection question',()=>office('نامشهود',async()=>{
  const item=event('N06',9500000,{accountId:'cash'}),p=await ai.proposeReview(database(),item.id,{fetcher:noNetwork});
  assert.equal(p.questions.length,0);assert.equal(p.lines.length,0);assert.equal(p.analysisCost.source,'rules');
  assert.ok(prepared(item,p).postingBlockers.some(b=>b.includes('نامشهود')));assert.equal(prepared(item,p).canPost,false);
  assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}));assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,0);
}));

test('explicit named cash replaces capture default; ambiguous normalized names require a real selection',()=>office('صندوق‌های واقعی',async()=>{
  const actual=db.saveAccount({name:'صندوق غرب',kind:'cash'}),text=cases.N08.replace('صندوق نقدی','صندوق غرب');
  const item=event('N08',17000000,{evidence:text,accountId:'cash',kind:'cash-income'});
  const p=await ai.proposeReview(database(),item.id,{fetcher:noNetwork});assert.equal(prepared(item,p).context.accountId,actual.id);
  const posted=db.reviewAiFeedback(item.id,p.id,{accepted:true}).item;
  assert.equal(lines(posted).find(l=>l.source_kind==='operational-account').source_key,actual.id);assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,0);
  db.saveAccount({name:'صندوق  غرب',kind:'cash'});
  const ambiguous=event('N08',17000000,{evidence:text,accountId:'cash',kind:'cash-income'}),fresh=await ai.proposeReview(database(),ambiguous.id,{fetcher:noNetwork});
  assert.equal(prepared(ambiguous,fresh).context.accountId,null);assert.ok(fresh.questions.some(q=>q.id==='cash.account'));assert.equal(prepared(ambiguous,fresh).canPost,false);
}));

test('ordinary trade payment also requires approved history, not a draft journal',()=>office('طلب پیش‌نویس',async()=>{
  const party=db.saveContact({name:'شرکت طلب واقعی'}),text='امروز طلب قبلی شرکت طلب واقعی به مبلغ دو میلیون از مشتری وصول و در صندوق نقدی دریافت شد';
  const item=event('N10',2000000,{evidence:text,counterpartyId:party.id,accountId:'cash',kind:'cash-income'});
  const debit=resolver.resolveEventRole(database(),'receivable',party.name,{counterpartyId:party.id}),credit=resolver.resolveEventRole(database(),'owner-capital');
  const draft=accounting.postJournalEntry(database(),{sourceType:'test-draft-trade',sourceId:crypto.randomUUID(),occurredAt:'2026-10-01',approvalState:'draft',lines:[{accountId:debit,debit:2000000,credit:0},{accountId:credit,debit:0,credit:2000000}]});
  const model={summary:'وصول',explanation:'وصول طلب قبلی',questions:[],missingFacts:[],lines:[{role:'cash',debit:2000000,credit:0},{role:'receivable',debit:0,credit:2000000}]};
  const p=await ai.proposeReview(database(),item.id,{fetcher:fake(model)});assert.equal(prepared(item,p).canPost,false);assert.equal(prepared(item,p).tradeSettlement.available,0);
  database().prepare("UPDATE journal_entries SET approval_state='approved' WHERE id=?").run(draft.id);
  const fresh=await ai.proposeReview(database(),item.id,{fetcher:fake(model)});assert.equal(prepared(item,fresh).canPost,true);
  const posted=db.reviewAiFeedback(item.id,fresh.id,{accepted:true}).item;assert.equal(lines(posted).find(l=>l.source_kind==='customer-receivable').credit,2000000);
}));
