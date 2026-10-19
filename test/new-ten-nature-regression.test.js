import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tempDatabase } from './helpers/tempPath.js';
import { parseFinancialText } from '../shared/parser.js';
import { extractOccurrenceDate } from '../shared/persianDate.js';
import { extractContactCandidate } from '../shared/counterpartySpeech.js';
import { taxPenaltyProposal } from '../shared/reviewTaxPenalty.js';
import { classifyCategory } from '../shared/categoryRules.js';
import { reviewNatureViolations } from '../shared/reviewNature.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
const cases=Object.fromEntries(JSON.parse(readFileSync(new URL('../docs/testing/new-ten-2026-10-06-evidence.json',import.meta.url))).cases);
process.env.DATABASE_PATH=tempDatabase('new-ten-nature');
process.env.ADMIN_USERNAME='new-ten-owner';
process.env.ADMIN_PASSWORD=`test-${crypto.randomUUID()}`;
const db=await import('../server/db.js'),store=await import('../server/financialEventStore.js');
db.ensureAdmin(); const owner=db.authenticateUser(process.env.ADMIN_USERNAME,process.env.ADMIN_PASSWORD);
const run=f=>db.runInWorkspace('primary', { role: 'owner', userId: owner.id, overdraftApproval: FIXTURE_OVERDRAFT },f);
const now=new Date('2026-10-06T08:00:00Z');
const amount={N01:4200000,N03:6300000,N04:8400000,N05:11000000,N06:9500000,N07:2400000,N08:17000000,N09:15000000};
const category={N01:'مالیات و عوارض',N03:'سایر درآمدها',N04:'خدمات',N05:'سایر هزینه‌ها',N06:'نرم‌افزار و اشتراک',N07:'کارمزد بانکی',N08:'پروژه و دستمزد',N09:'قبوض'};
for(const id of Object.keys(amount)) test(`${id}: new live evidence checks posting boundary on repaired code`,()=>run(()=>{
 db.installChartTemplate(); const database=db.activeWorkspaceDatabase();
 const before=database.prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
 const income=['N03','N04','N08'].includes(id);
 const item=store.recordFinancialEvent(database,{kind:income?'cash-income':'cash-expense',amount:amount[id],category:category[id],accountId:'cash',evidence:cases[id],occurredAt:now.toISOString(),eventNature:'new'},
  {sourceEventId:crypto.randomUUID(),decision:{route:'auto',reasons:[]}});
 const allowed=['N03','N07'].includes(id);
 assert.equal(item.status,allowed?'posted':'pending');
 assert.equal(database.prepare('SELECT COUNT(*) n FROM journal_entries').get().n,before+(allowed?1:0));
 if(!allowed) assert.equal(item.route,'accountant-review');
 if(id==='N01') {assert.equal(classifyCategory(cases[id],'expense').category,'جرایم مالیاتی');assert.equal(taxPenaltyProposal(cases[id],amount[id]).lines[0].key,'جرایم مالیاتی');}
 if(['N06','N08'].includes(id)) assert.equal(extractOccurrenceDate(cases[id],{now}).iso,extractOccurrenceDate('امروز',{now}).iso);
 if(id==='N04') assert.equal(extractContactCandidate(cases[id]).name,'شرکت آذرخش');
 if(id==='N09') assert.equal(extractContactCandidate(cases[id]).name,'');
}));
for(const id of ['N02','N10']) test(`${id}: unmatched settlement persists one idempotent case without a journal or cash movement`,()=>run(()=>{
 const database=db.activeWorkspaceDatabase(),before=database.prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
 const balances=db.listAccounts().map(a=>[a.id,a.balance]);
 const clientId=crypto.randomUUID(),item=db.queueUnmatchedSettlement(cases[id],{clientId});
 assert.equal(item.status,'pending');assert.equal(item.route,'accountant-review');
 assert.equal(db.queueUnmatchedSettlement(cases[id],{clientId}).id,item.id);
 assert.equal(database.prepare('SELECT COUNT(*) n FROM journal_entries').get().n,before);
 assert.deepEqual(db.listAccounts().map(a=>[a.id,a.balance]),balances);
 assert.throws(()=>store.approveFinancialEvent(database,item.id),/بررسی|حسابدار|قطعی/);
}));
test('ordinary expense and fully performed issuance fee remain available while multi-year rights are held',()=>{
 assert.deepEqual(reviewNatureViolations(cases.N07,[{role:'expense-category'}]),[]);
 assert.ok(reviewNatureViolations(cases.N06,[{role:'fixed-asset'}]).some(x=>x.id==='nature.intangible'));
 assert.throws(()=>run(()=>db.queueUnmatchedSettlement('امروز برای نظافت دو میلیون پرداخت کردیم')),/تسویه/);
});

test('advance refund requires real prior liability, posts its reduction and cash atomically, then blocks duplicate',()=>run(async()=>{
 process.env.OPENAI_API_KEY='test-only-key';
 const ai=await import('../server/accountingReviewAi.js'),assistant=await import('../server/reviewAssistant.js');
 const resolver=await import('../server/roleResolver.js'),accounting=await import('../server/accounting.js');
 const database=db.activeWorkspaceDatabase(),party=db.saveContact({name:'شرکت آذرخش'});
 const liability=resolver.resolveEventRole(database,'customer-advance',party.name,{counterpartyId:party.id,counterparty:party.name});
 const event=store.recordFinancialEvent(database,{kind:'cash-income',amount:8400000,category:'خدمات',evidence:cases.N04,occurredAt:now.toISOString(),eventNature:'new'},
  {sourceEventId:crypto.randomUUID(),decision:{route:'accountant-review',guardBlocked:true,reasons:['عودت پیش‌دریافت']}});
 const fake=async()=>({ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({summary:'عودت پیش‌دریافت مشتری',explanation:'کاهش تعهد قبلی',questions:[],missingFacts:[],lines:[{role:'customer-advance',debit:8400000,credit:0},{role:'cash',debit:0,credit:8400000}]})}]}]})});
 const row=()=>database.prepare('SELECT * FROM financial_events WHERE id=?').get(event.id);
 const p=await ai.proposeReview(database,event.id,{facts:{counterpartyId:party.id,accountId:'cash'},fetcher:fake});
 assert.ok(assistant.prepareReviewProposal(database,row(),p).postingBlockers.some(b=>b.includes('مانده واقعی پیش‌دریافت')));
 const cash=resolver.resolveEventRole(database,'cash','cash');
 accounting.postJournalEntry(database,{sourceType:'test-initial-advance',sourceId:crypto.randomUUID(),occurredAt:'2026-10-01',lines:[{accountId:cash,debit:8400000,credit:0},{accountId:liability,debit:0,credit:8400000}]});
 const fresh=await ai.proposeReview(database,event.id,{fetcher:fake});
 const ready=assistant.prepareReviewProposal(database,row(),fresh);
 assert.equal(ready.canPost,true,ready.postingBlockers.join('|'));
 const before=db.listAccounts().find(a=>a.id==='cash').balance;
 const posted=db.reviewAiFeedback(event.id,fresh.id,{accepted:true}).item;
 assert.ok(posted.journalEntryId);
 assert.equal(database.prepare('SELECT SUM(credit-debit) balance FROM journal_lines WHERE account_id=?').get(liability).balance,0);
 assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,before-8400000);
 assert.throws(()=>db.reviewAiFeedback(event.id,fresh.id,{accepted:true}));
}));
