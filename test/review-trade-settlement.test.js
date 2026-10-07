import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { conditionalPaymentProposal } from '../shared/reviewSettlement.js';
import { reviewQuestions, reviewSavedAnswers } from '../shared/reviewQuestions.js';
import { isReviewAccountSetupQuestion } from '../shared/reviewQuestions.js';
import { tradeCollectionProposal, tradeSettlementValidation } from '../server/reviewTradeSettlement.js';
import { bindReviewProposal } from '../server/reviewProposalBindings.js';
process.env.DATABASE_PATH=tempDatabase('trade-settlement');
process.env.ADMIN_USERNAME='trade-owner';process.env.ADMIN_PASSWORD=`trade-${crypto.randomUUID()}`;
process.env.OPENAI_API_KEY='test-key';
const db=await import('../server/db.js'),store=await import('../server/financialEventStore.js');
const ai=await import('../server/accountingReviewAi.js'),assistant=await import('../server/reviewAssistant.js');
const accounting=await import('../server/accounting.js'),resolver=await import('../server/roleResolver.js');
const chart=await import('../server/chartOfAccounts.js');
db.ensureAdmin();const owner=db.authenticateUser(process.env.ADMIN_USERNAME,process.env.ADMIN_PASSWORD);
const run=f=>db.runInWorkspace('primary',{role:'owner',userId:owner.id},f),database=()=>db.activeWorkspaceDatabase();
const text='به تامین‌کننده کارتن هشتاد میلیون بدهکار بودیم، پنجاه میلیون دادیم، گفت ده تومن دیگه بدی بقیه‌شو می‌بخشم، ما هم قبول کردیم.';
const fake=p=>async()=>({ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(p)}]}]})});
const noNetwork=async()=>{throw Error('Conditional payment should not spend API tokens');};
const row=item=>database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id);
const event=(t=text,amount=80000000)=>store.recordFinancialEvent(database(),{kind:'cash-expense',amount,occurredAt:'2026-10-06',evidence:t,amountReferenceOnly:true},{sourceEventId:crypto.randomUUID(),decision:{route:'accountant-review',guardBlocked:true,reasons:['بررسی']}});
function seed(role,amount,name=crypto.randomUUID()) {
  const party=db.saveContact({name});
  const accountId=resolver.resolveEventRole(database(),role,name,{counterpartyId:party.id,counterparty:name});
  const equity=database().prepare("SELECT id FROM ledger_accounts WHERE source_kind='system' AND source_key='opening-equity'").get().id;
  const payable=role==='payable';
  accounting.postJournalEntry(database(),{sourceType:'opening-trade-test',sourceId:crypto.randomUUID(),occurredAt:'2026-09-01',lines:[{accountId,debit:payable?0:amount,credit:payable?amount:0},{accountId:equity,debit:payable?amount:0,credit:payable?0:amount}]});
  return {party,accountId};
}
const prepared=(item,p)=>assistant.prepareReviewProposal(database(),row(item),p);

test('T035: promise is not cash; only completed 50m payment is proposed without API',()=>{
 const p=conditionalPaymentProposal(text,{questionAnswers:{q:{value:'تعهد پرداخت دادیم'}}});
 assert.deepEqual(p.lines,[{role:'payable',debit:50000000,credit:0},{role:'cash',debit:0,credit:50000000}]);
 assert.equal(conditionalPaymentProposal('اگر ده میلیون بدی بیست میلیون می‌بخشم'),null);
 assert.equal(conditionalPaymentProposal('اگر پنجاه میلیون پرداخت کردیم، بیست میلیون می‌بخشم'),null);
 assert.equal(conditionalPaymentProposal('اگر ده میلیون بدی می‌بخشم، پنجاه ریال دادیم'),null);
});
test('no prior debt: no fictitious debt, party or cash mutation',()=>run(async()=>{
 const item=event();const count=database().prepare('SELECT count(*) n FROM contacts').get().n;
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash',counterpartyName:'شرکت قیاسی'},fetcher:noNetwork});
 assert.equal(prepared(item,p).canPost,false);
 assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}),{code:'REVIEW_DETAILS_REQUIRED'});
 assert.equal(database().prepare('SELECT count(*) n FROM contacts').get().n,count);
 assert.equal(row(item).status,'pending');
}));
test('T031 explicit collection resolves commercial receivable without API',()=>{
 const p=tradeCollectionProposal('آقای محمدی بدهی پنجاه میلیونی خرید ماه قبل رو به حساب بانک ملت شرکت واریز کرد',50000000);
 assert.equal(p.lines[1].role,'receivable');
 assert.equal(tradeCollectionProposal('طلب شریک به حساب شرکت واریز کرد',50000000),null);
});
test('future opening journal cannot justify an earlier payment',()=>run(()=>{
 const {party,accountId}=seed('payable',80000000);const item=event();
 database().prepare("UPDATE journal_entries SET occurred_at='2026-11-01' WHERE id IN (SELECT entry_id FROM journal_lines WHERE account_id=?)").run(accountId);
 const r=tradeSettlementValidation(database(),{occurredAt:'2026-10-06',counterpartyId:party.id},conditionalPaymentProposal(text).lines);
 assert.ok(r.settlement.available===0);assert.ok(r.issues.length);
}));
test('T076 explicit category repairs generic expense binding, preserving amounts',()=>{
 const p=bindReviewProposal({lines:[{role:'expense-category',key:'سایر هزینه‌های عملیاتی',debit:20000000,credit:0},{role:'cash',debit:0,credit:20000000}],inventoryItems:[]},{ledger:[],chart:[]},{evidence:'ممیز مالیاتی بیست میلیون تومن جریمه عدم تسلیم اظهارنامه برید مجبور شدیم بدیم',category:'مالیات و عوارض'});
 assert.equal(p.lines[0].key,'جرایم مالیاتی');assert.equal(p.lines[0].debit,20000000);
});
test('account creation is not a business question, but real source/balance questions remain',()=>{
 assert.equal(isReviewAccountSetupQuestion('حساب دفترکل/سرفصل مناسب برای ثبت پیش‌پرداخت خرید به تأمین‌کننده در این پرونده موجود نیست و باید توسط سیستم ایجاد یا تطبیق شود.'),true);
 assert.equal(isReviewAccountSetupQuestion('حساب بدهی و مانده قبلی موجود نیست؛ سند مبنا را ایجاد کنید'),false);
 assert.equal(isReviewAccountSetupQuestion('کدام حساب بانک را انتخاب کنیم؟'),false);
});
test('80m opening payable -> one click pays 50m, leaves 30m; no waiver income; reversal and duplicate guard',()=>run(async()=>{
 const {party,accountId}=seed('payable',80000000,'شرکت قیاسی آزمون');const item=event();
 const cash=db.listAccounts().find(a=>a.id==='cash').balance;
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash',counterpartyId:party.id},fetcher:noNetwork});
 assert.equal(prepared(item,p).canPost,true);
 const posted=db.reviewAiFeedback(item.id,p.id,{accepted:true}).item;
 const lines=database().prepare('SELECT a.source_kind,l.debit,l.credit,l.analytic_id FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE entry_id=?').all(posted.journalEntryId);
 assert.equal(lines.length,2);assert.ok(lines.find(l=>l.source_kind==='vendor-payable').analytic_id);
 assert.equal(database().prepare('SELECT sum(credit-debit) n FROM journal_lines WHERE account_id=?').get(accountId).n,30000000);
 assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,cash-50000000);
 assert.equal(database().prepare("SELECT accounting_role FROM transactions WHERE client_id=?").get(`review:${item.id}`).accounting_role,'payable');
 assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}),{code:'EVENT_NOT_REVIEWABLE'});
 db.reverseEvent(item.id,'برگشت سند آزمایش تسویه');
 assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,cash);
 assert.equal(database().prepare('SELECT sum(credit-debit) n FROM journal_lines WHERE account_id=?').get(accountId).n,80000000);
}));
test('T031: customer collection uses actual receivable, no fresh income',()=>run(async()=>{
 const {party,accountId}=seed('receivable',50000000);const item=event('طلب قبلی مشتری بابت خرید ماه قبل پنجاه میلیون واریز شد',50000000);
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash',counterpartyId:party.id},fetcher:fake({summary:'وصول طلب',explanation:'بستن طلب قبلی',missingFacts:[],lines:[{role:'cash',debit:50000000,credit:0},{role:'receivable',debit:0,credit:50000000}]})});
 assert.equal(prepared(item,p).canPost,true);db.reviewAiFeedback(item.id,p.id,{accepted:true});
 assert.equal(database().prepare('SELECT sum(debit-credit) n FROM journal_lines WHERE account_id=?').get(accountId).n,0);
}));
test('wrong cached three-line conditional waiver remains unpostable',()=>run(()=>{
 const {party}=seed('payable',80000000);const item=event();assistant.saveReviewFacts(database(),item.id,{accountId:'cash',counterpartyId:party.id});
 const p={state:'proposed',missingFacts:[],lines:[{role:'payable',debit:70000000,credit:0},{role:'cash',debit:0,credit:50000000},{role:'income-category',key:'سایر درآمدها',debit:0,credit:20000000}]};
 assert.ok(prepared(item,p).postingBlockers.some(b=>b.includes('بخشودگی')));assert.equal(prepared(item,p).canPost,false);
}));
test('wrong trade cash direction cannot post even with balance',()=>run(async()=>{
 const {party}=seed('payable',80000000);const item=event('بدهی قبلی پنجاه میلیون پرداخت شد');
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash',counterpartyId:party.id},fetcher:fake({summary:'اشتباه جهت',explanation:'آزمون کنترل جهت',missingFacts:[],lines:[{role:'payable',debit:0,credit:50000000},{role:'cash',debit:50000000,credit:0}]})});
 assert.equal(prepared(item,p).canPost,false);
}));
test('overpayment is rejected against ledger balance',()=>run(async()=>{
 const {party}=seed('payable',40000000);const item=event();
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash',counterpartyId:party.id},fetcher:noNetwork});
 assert.ok(prepared(item,p).postingBlockers.some(b=>b.includes('کافی نیست')));
}));
test('period lock rolls back cash and journal atomically',()=>run(async()=>{
 const {party}=seed('payable',80000000);const item=event();
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash',counterpartyId:party.id},fetcher:noNetwork});
 const period=accounting.periodForDate('2026-10-06','Asia/Tehran');
 database().prepare("INSERT INTO accounting_periods(period,status) VALUES(?,'locked') ON CONFLICT(period) DO UPDATE SET status='locked'").run(period);
 const n=database().prepare('SELECT count(*) n FROM transactions').get().n;
 assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}),{code:'ACCOUNTING_PERIOD_LOCKED'});
 assert.equal(database().prepare('SELECT count(*) n FROM transactions').get().n,n);assert.equal(row(item).status,'pending');
 database().prepare("UPDATE accounting_periods SET status='open' WHERE period=?").run(period);
}));
test('waiver and supplier questions deduplicate; old stored answers keep working',()=>{
 const qs=reviewQuestions({questions:[{id:'supplier.name',text:'نام دقیق تأمین‌کننده چیست؟'},{id:'waiver.amount',text:'مبلغ بخشودگی پس از پرداخت چقدر است؟'}],missingFacts:['مبلغ دقیق بخشودگی بدهی پس از پرداخت یا تعهد چقدر است؟']});
 assert.equal(qs.length,2);assert.equal(qs[0].field,'counterpartyName');
 assert.equal(reviewSavedAnswers({'old-id':{question:qs[1].text,value:'20 میلیون'}})[qs[1].id].value,'20 میلیون');
});
test('bank preview uses readable name and existing bank subsidiary',()=>run(async()=>{
 chart.installDefaultChartTemplate(database());
 const bank=db.saveAccount({name:'بانک سامان تست',kind:'bank',bankId:'saman'});const item=event();
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:bank.id},fetcher:noNetwork});
 const cash=prepared(item,p).lines.find(l=>l.role==='cash');
 assert.equal(cash.accountName,'بانک سامان تست');assert.ok(cash.newAccount?.chartAccountId);
}));

test('supplier purchase advance retains person identity, creates resources only at approval and reverses cash',()=>run(async()=>{
 const t='صد و بیست میلیون پیش‌پیش ریختیم حساب کارخانه فولاد مبارکه واسه خرید ورق هنوز بار نرسیده';
 const item=event(t,120000000),name='کارخانه فولاد مبارکه';
 const plan={summary:'پیش‌پرداخت خرید ورق',explanation:t,questions:[],missingFacts:[],inventoryItems:[],counterpartyName:name,lines:[{role:'prepaid-asset',key:'پیش‌پرداخت‌ها',debit:120000000,credit:0},{role:'cash',debit:0,credit:120000000}]};
 const count=database().prepare('SELECT count(*) n FROM contacts').get().n;
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash',counterpartyName:name},fetcher:fake(plan)});
 const preview=prepared(item,p);assert.equal(preview.canPost,true,preview.postingBlockers.join(' / '));assert.equal(preview.newCounterparty.name,name);
 assert.equal(database().prepare('SELECT count(*) n FROM contacts').get().n,count);
 const posted=db.reviewAiFeedback(item.id,p.id,{accepted:true}).item;
 const party=database().prepare('SELECT id FROM contacts WHERE name=?').get(name);
 const lines=database().prepare('SELECT a.source_kind,a.source_key,l.analytic_id,l.debit,l.credit FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE entry_id=?').all(posted.journalEntryId);
 const advance=lines.find(l=>l.source_kind==='prepaid-asset');assert.equal(advance.source_key,party.id);assert.ok(advance.analytic_id);assert.equal(advance.debit,120000000);
 assert.equal(lines.find(l=>l.source_kind==='operational-account').credit,120000000);
 db.reverseEvent(item.id,'برگشت پیش پرداخت آزمایشی');
}));

test('bank and purpose paraphrases use one stable answer, without hiding real follow-up facts',()=>{
 const qs=reviewQuestions({questions:[{id:'cash.account',text:'وجه از کدام بانک یا صندوق واقعی پرداخت یا دریافت شد؟',field:'accountId'},{id:'payment.bank',text:'این مبلغ از کدام بانک یا حساب عملیاتی پرداخت شد؟',field:'accountId'}],missingFacts:['بانک یا حساب عملیاتی پرداخت‌کننده مشخص نیست.']});
 assert.equal(qs.length,1);assert.equal(qs[0].id,'cash.account');
 assert.equal(reviewSavedAnswers({'payment.bank':{question:'این مبلغ از کدام بانک پرداخت شد؟',field:'accountId',value:'cash'}})['cash.account'].value,'cash');
 const purpose=reviewQuestions({missingFacts:['این هفت میلیون دقیقاً بابت چه هزینه‌ای پرداخت شد؟','ماهیت دقیق هزینه‌ای که امروز پرداخت شده چیست؟','آیا اصل بدهی قبلی ثبت شده؟']});
 assert.equal(purpose.length,2);assert.equal(purpose[0].id,'fact.expense-purpose');
});

test('confirmed imported T031 balance -> actual collection -> zero receivable, duplicate import denied',()=>run(async()=>{
 const party=db.saveContact({name:'مشتری مانده منتقل شده آزمون'});
 const item=event('طلب قبلی مشتری بابت خرید ماه قبل پنجاه میلیون وصول شد',50000000);
 database().prepare("UPDATE financial_events SET payload=? WHERE id=?").run(JSON.stringify({...JSON.parse(row(item).payload),amountReferenceOnly:false}),item.id);
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash',counterpartyId:party.id},fetcher:noNetwork});
 assert.ok(prepared(item,p).priorBasis);assert.equal(prepared(item,p).canPost,false);
 const input={proposalId:p.id,amount:50000000,occurredAt:'2026-09-01',reference:'مانده مستند آزمایشی دفتر قبلی T031',confirmed:true};
 assert.throws(()=>db.recordReviewPriorBasis(item.id,{...input,confirmed:false}),{code:'REVIEW_BASIS_INVALID'});
 const result=db.recordReviewPriorBasis(item.id,input);assert.ok(result.journal.id);assert.equal(row(item).status,'pending');
 assert.throws(()=>db.recordReviewPriorBasis(item.id,input),{code:'REVIEW_BASIS_INVALID'});
 const fresh=await ai.proposeReview(database(),item.id,{fetcher:noNetwork});assert.equal(prepared(item,fresh).canPost,true);
 const posted=db.reviewAiFeedback(item.id,fresh.id,{accepted:true}).item;
 assert.ok(posted.journalEntryId);
 const accountId=database().prepare("SELECT id FROM ledger_accounts WHERE source_kind='customer-receivable' AND source_key=?").get(party.id).id;
 assert.equal(database().prepare('SELECT sum(debit-credit) n FROM journal_lines WHERE account_id=?').get(accountId).n,0);
}));

test('T079 imported tax receivable -> refund allocated to confirmed basis, no income',()=>run(async()=>{
 const item=event('اداره دارایی ده میلیون از مالیات ارزش افزوده بابت اضافه پرداختی به حساب شرکت عودت داد',10000000);
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash'},fetcher:noNetwork});
 assert.ok(prepared(item,p).priorBasis);
 const basis=db.recordReviewPriorBasis(item.id,{proposalId:p.id,amount:10000000,occurredAt:'2026-09-01',reference:'پرونده مستند استرداد ارزش افزوده آزمایشی T079',confirmed:true}).journal;
 const fresh=await ai.proposeReview(database(),item.id,{fetcher:noNetwork});assert.equal(prepared(item,fresh).canPost,true,prepared(item,fresh).postingBlockers.join(' / '));
 const posted=db.reviewAiFeedback(item.id,fresh.id,{accepted:true}).item;
 const allocated=database().prepare('SELECT * FROM accounting_review_tax_refunds WHERE event_id=?').get(item.id);
 assert.equal(allocated.amount,10000000);assert.equal(allocated.refund_journal_id,posted.journalEntryId);
 assert.equal(database().prepare('SELECT entry_id FROM journal_lines WHERE id=?').get(allocated.claim_line_id).entry_id,basis.id);
 assert.equal(database().prepare("SELECT count(*) n FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.entry_id=? AND a.type='income'").get(posted.journalEntryId).n,0);
}));

test('prior balance requires manager, prior date and absence of existing ledger history',()=>run(async()=>{
 const party=db.saveContact({name:'منبع دسترسی آزمایشی'}),item=event('طلب مشتری وصول شد',10000000);
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash',counterpartyId:party.id},fetcher:fake({summary:'وصول',missingFacts:[],inventoryItems:[],lines:[{role:'cash',debit:10000000,credit:0},{role:'receivable',debit:0,credit:10000000}]})});
 const input={proposalId:p.id,amount:10000000,occurredAt:'2026-10-06',reference:'مرجع مستند آزمایشی',confirmed:true};
 assert.throws(()=>db.runInWorkspace('primary',{role:'accountant',userId:owner.id},()=>db.recordReviewPriorBasis(item.id,input)),{code:'FORBIDDEN'});
 assert.throws(()=>db.recordReviewPriorBasis(item.id,input),{code:'REVIEW_BASIS_INVALID'});
 assert.equal(row(item).status,'pending');
}));

test('closed period atomically rejects basis, creating no receivable, journal or audit message',()=>run(async()=>{
 const party=db.saveContact({name:'مانده بسته آزمون'}),item=event('طلب مشتری وصول شد',10000000);
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash',counterpartyId:party.id},fetcher:fake({summary:'وصول',missingFacts:[],inventoryItems:[],lines:[{role:'cash',debit:10000000,credit:0},{role:'receivable',debit:0,credit:10000000}]})});
 const period=accounting.periodForDate('2026-09-01');database().prepare("INSERT INTO accounting_periods(period,status) VALUES(?,'locked') ON CONFLICT(period) DO UPDATE SET status='locked'").run(period);
 const before=database().prepare('SELECT count(*) n FROM journal_entries').get().n;
 const messages=assistant.reviewConversation(database(),item.id).length;
 try {
  assert.throws(()=>db.recordReviewPriorBasis(item.id,{proposalId:p.id,amount:10000000,occurredAt:'2026-09-01',reference:'مانده مستند دوره بسته آزمایشی',confirmed:true}),{code:'ACCOUNTING_PERIOD_LOCKED'});
  assert.equal(database().prepare('SELECT count(*) n FROM journal_entries').get().n,before);
  assert.equal(assistant.reviewConversation(database(),item.id).length,messages);
  assert.equal(database().prepare("SELECT 1 FROM ledger_accounts WHERE source_kind='customer-receivable' AND source_key=?").get(party.id),undefined);
 } finally {database().prepare("UPDATE accounting_periods SET status='open' WHERE period=?").run(period);}
}));
