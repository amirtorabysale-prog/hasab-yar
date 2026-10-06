import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { taxPenaltyProposal } from '../shared/reviewTaxPenalty.js';
process.env.DATABASE_PATH=tempDatabase('tax-penalty-opening');
process.env.ADMIN_USERNAME='penalty-owner';
process.env.ADMIN_PASSWORD=`penalty-${crypto.randomUUID()}`;
const db=await import('../server/db.js'),store=await import('../server/financialEventStore.js');
const ai=await import('../server/accountingReviewAi.js'),assistant=await import('../server/reviewAssistant.js');
const accounting=await import('../server/accounting.js'),chart=await import('../server/chartOfAccounts.js');
db.ensureAdmin();const owner=db.authenticateUser(process.env.ADMIN_USERNAME,process.env.ADMIN_PASSWORD);
const database=()=>db.activeWorkspaceDatabase();
const run=f=>db.runInWorkspace('primary',{role:'owner',userId:owner.id},f);
const noNetwork=()=>{throw Error('Deterministic fine must not call AI');};

test('paid standalone tax fine posts dedicated mapped expense, actual cash, DNA and reverses without duplicate expense',()=>run(async()=>{
 db.installChartTemplate();
 const amount=4200000,text='جریمه قطعی دیرکرد ارزش افزوده چهار میلیون و دویست هزار تومان پرداخت کردیم؛ هزینه آن اولین بار شناسایی می‌شود.';
 const item=store.recordFinancialEvent(database(),{kind:'cash-expense',amount,occurredAt:'2026-10-06',evidence:text,eventNature:'new',category:'مالیات و عوارض'},
  {sourceEventId:crypto.randomUUID(),decision:{route:'accountant-review',guardBlocked:true,reasons:['آزمون جریمه']}});
 const cash=db.listAccounts().find(a=>a.id==='cash').balance;
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash'},fetcher:noNetwork});
 assert.equal(p.analysisCost.source,'rules');assert.equal(p.lines[0].key,'جرایم مالیاتی');
 const row=database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id);
 const ready=assistant.prepareReviewProposal(database(),row,p);
 assert.equal(ready.canPost,true,ready.postingBlockers.join('|'));
 const forged={...p,lines:p.lines.map(l=>l.role==='expense-category'?{...l,key:'مالیات و عوارض'}:l)};
 assert.equal(assistant.prepareReviewProposal(database(),row,forged).canPost,false);
 const posted=db.reviewAiFeedback(item.id,p.id,{accepted:true}).item;
 const expense=database().prepare('SELECT a.name,c.role,l.debit FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id JOIN chart_accounts c ON c.id=a.chart_account_id WHERE l.entry_id=? AND a.type=\'expense\'').get(posted.journalEntryId);
 assert.equal(expense.name,'جرایم مالیاتی');assert.equal(expense.role,'tax-penalty-expense');assert.equal(expense.debit,amount);
 assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,cash-amount);
 assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}));
 db.reverseEvent(item.id,'برگشت آزمون جریمه');
 assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,cash);
}));

test('existing fine liability, mixed principal, and disputed fine do not manufacture a two-line expense',()=>{
 for(const text of ['جریمه مالیاتی قبلا در حساب پرداختنی ثبت شد؛ امروز پرداخت کردیم','اصل مالیات و جریمه را پرداخت کردیم','جریمه مالیاتی هنوز پرداخت نشده و اعتراض داریم']) {
  const p=taxPenaltyProposal(text,3000000);assert.equal(p.lines.length,0);assert.equal(p.questions.length,1);
 }
 assert.equal(taxPenaltyProposal('جریمه تاخیر پیمانکار پرداخت کردیم',3000000),null);
});

test('opening equity auto-maps on chart install and later schema load, without rewriting explicit mapping',()=>run(()=>{
 const opening=()=>database().prepare("SELECT * FROM ledger_accounts WHERE source_key='opening-equity'").get();
 const expected=chart.listChartAccounts(database()).find(c=>c.role==='equity');
 assert.equal(opening().chart_account_id,expected.id);
 database().prepare('UPDATE ledger_accounts SET chart_account_id=NULL WHERE id=?').run(opening().id);
 accounting.ensureAccountingSchema(database());assert.equal(opening().chart_account_id,expected.id);
 const explicit=chart.listChartAccounts(database()).find(c=>c.role==='owner-capital');
 chart.mapLedgerAccountToChart(database(),opening().id,explicit.id);
 accounting.ensureAccountingSchema(database());assert.equal(opening().chart_account_id,explicit.id);
}));

test('legacy template receives only missing fine subsidiary; collision or custom chart is not overwritten',()=>run(()=>{
 database().prepare("UPDATE ledger_accounts SET chart_account_id=NULL WHERE chart_account_id IN (SELECT id FROM chart_accounts WHERE code='8120')").run();
 database().prepare("DELETE FROM chart_accounts WHERE code='8120'").run();
 accounting.ensureAccountingSchema(database());
 assert.equal(database().prepare("SELECT role FROM chart_accounts WHERE code='8120'").get().role,'tax-penalty-expense');
 database().prepare("UPDATE chart_accounts SET name='معین اختصاصی دفتر',role='',source='manual' WHERE code='8120'").run();
 accounting.ensureAccountingSchema(database());
 assert.equal(database().prepare("SELECT name FROM chart_accounts WHERE code='8120'").get().name,'معین اختصاصی دفتر');
 const custom=db.createWorkspace(owner.id,{name:'کدینگ سفارشی جریمه',profileType:'business'});
 db.runInWorkspace(custom.id,{role:'owner',userId:owner.id},()=>{
  chart.importChartOfAccounts(database(),[{code:'8',name:'هزینه',level:'group',type:'expense'},{code:'81',name:'هزینه اداری',level:'general',parentCode:'8',type:'expense'},{code:'8114',name:'مالیات و عوارض',level:'subsidiary',parentCode:'81',type:'expense'}]);
  accounting.ensureAccountingSchema(database());assert.equal(database().prepare("SELECT 1 FROM chart_accounts WHERE code='8120'").get(),undefined);
 });
}));
