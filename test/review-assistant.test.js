import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
process.env.DATABASE_PATH = tempDatabase('review-assistant');
process.env.ADMIN_USERNAME = 'review-owner';
process.env.ADMIN_PASSWORD = `review-${crypto.randomUUID()}`;
const db = await import('../server/db.js');
const store = await import('../server/financialEventStore.js');
const assistant = await import('../server/reviewAssistant.js');
const ai = await import('../server/accountingReviewAi.js');
db.ensureAdmin();
const owner = db.authenticateUser(process.env.ADMIN_USERNAME,process.env.ADMIN_PASSWORD);
const run = f=>db.runInWorkspace('primary',{role:'owner',userId:owner.id},f);
const database = ()=>db.activeWorkspaceDatabase();
const fake = proposal=>async()=>({ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(proposal)}]}]})});
function event(text='خرید کالا با چک از شرکت نمونه',amount=40000000) {
  return store.recordFinancialEvent(database(),{kind:'cash-expense',amount,occurredAt:'2026-10-03',evidence:text,eventNature:'new',category:'مواد و کالا'},
    {sourceEventId:crypto.randomUUID(),decision:{route:'accountant-review',guardBlocked:true,reasons:['بررسی حسابدار لازم است']}});
}
const chequePlan = {summary:'خرید با چک',explanation:'خرید تحویل شده، وجهی جابه‌جا نشده',missingFacts:[],lines:[{role:'expense-category',key:'مواد مصرفی',debit:40000000,credit:0},{role:'cheque-payable',debit:0,credit:40000000}]};
const before = process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key';
test.after(()=>{if(before===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=before;});

test('chat asks questions without fictitious journal, persists accountant and response, and invalidates old proposal',()=>run(async()=>{
  const item=event();
  const first=await ai.proposeReview(database(),item.id,{fetcher:fake(chequePlan)});
  assert.equal(assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id),first).canPost,false);
  const question={summary:'نیاز به توضیح',explanation:'طرف حساب و سررسید کدام است؟',missingFacts:['طرف حساب و سررسید؟'],lines:[]};
  const second=await ai.proposeReview(database(),item.id,{message:'سررسید هنوز مشخص نیست، سؤال کن',actor:owner.id,fetcher:fake(question)});
  assert.notEqual(first.id,second.id);assert.ok(second.contextRevision>first.contextRevision);
  assert.equal(second.lines.length,0);
  assert.equal(assistant.reviewConversation(database(),item.id).filter(m=>m.speaker==='accountant').length,1);
  assert.throws(()=>db.reviewAiFeedback(item.id,first.id,true),{code:'AI_PROPOSAL_STALE'});
  assert.throws(()=>db.reviewAiFeedback(item.id,second.id,{accepted:true}),{code:'REVIEW_DETAILS_REQUIRED'});
  assert.equal(database().prepare('SELECT status FROM financial_events WHERE id=?').get(item.id).status,'pending');
}));

test('one click posts a cheque, links its party and operational register, never moves cash and cannot duplicate',()=>run(async()=>{
  const item=event(), contact=db.saveContact({name:'شرکت نمونه بررسی'});
  const firstCash=db.listAccounts().find(a=>a.id==='cash').balance;
  const p=await ai.proposeReview(database(),item.id,{message:'مواد مصرفی است؛ موجودی انبار نیست. طرف و سررسید را انتخاب کردم',actor:owner.id,facts:{counterpartyId:contact.id,dueAt:'2026-11-01'},fetcher:fake(chequePlan)});
  const prepared=assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id),p);
  assert.equal(prepared.canPost,true);
  const {item:posted}=db.reviewAiFeedback(item.id,p.id,{accepted:true});
  assert.equal(posted.status,'posted');assert.ok(posted.journalEntryId);
  assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,firstCash);
  const cheque=db.listCheques().find(c=>c.id===`review:${item.id}`);
  assert.equal(cheque.journalEntryId,posted.journalEntryId);assert.equal(cheque.contactId,contact.id);assert.equal(cheque.amount,40000000);
  const lines=database().prepare('SELECT debit,credit,analytic_id FROM journal_lines WHERE entry_id=?').all(posted.journalEntryId);
  assert.equal(lines.reduce((n,l)=>n+l.debit-l.credit,0),0);assert.ok(lines.find(l=>l.credit).analytic_id);
  assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}),{code:'EVENT_NOT_REVIEWABLE'});
  const related=event('خرید کالا با چک از شرکت نمونه بررسی',60000000);
  const dna=assistant.relevantDna(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(related.id));
  assert.ok(dna.some(d=>d.id===p.id && d.actor===owner.id && d.journalEntryId===posted.journalEntryId));
}));

test('cash approval synchronizes transaction anchor and balance; period lock rolls every effect back',()=>run(async()=>{
  const item=event('هزینه نظافت پرداخت شد',3000000);
  const cashPlan={summary:'هزینه نظافت',explanation:'خدمت همین دوره پرداخت شده',missingFacts:[],lines:[{role:'expense-category',key:'نظافت',debit:3000000,credit:0},{role:'cash',debit:0,credit:3000000}]};
  const initial=db.listAccounts().find(a=>a.id==='cash').balance;
  const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash'},fetcher:fake(cashPlan)});
  const posted=db.reviewAiFeedback(item.id,p.id,{accepted:true}).item;
  assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,initial-3000000);
  const row=database().prepare('SELECT journal_source FROM financial_events WHERE id=?').get(item.id),source=JSON.parse(row.journal_source);
  assert.equal(source.type,'transaction');assert.equal(database().prepare('SELECT source_id FROM journal_entries WHERE id=?').get(posted.journalEntryId).source_id,source.id);
  db.reverseEvent(item.id,'اصلاح ثبت آزمایشی');
  assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,initial);
  const blocked=event('هزینه نظافت پرداخت شد',3000000);
  const b=await ai.proposeReview(database(),blocked.id,{facts:{accountId:'cash',occurredAt:'2026-10-03'},fetcher:fake(cashPlan)});
  const period=(await import('../server/accounting.js')).periodForDate('2026-10-03','Asia/Tehran');
  database().prepare("INSERT INTO accounting_periods(period,status) VALUES(?,'locked') ON CONFLICT(period) DO UPDATE SET status='locked'").run(period);
  const count=database().prepare('SELECT count(*) n FROM transactions').get().n;
  assert.throws(()=>db.reviewAiFeedback(blocked.id,b.id,{accepted:true}),{code:'ACCOUNTING_PERIOD_LOCKED'});
  assert.equal(database().prepare('SELECT count(*) n FROM transactions').get().n,count);
  assert.equal(ai.latestReviewProposal(database(),blocked.id).state,'proposed');
  database().prepare("UPDATE accounting_periods SET status='open' WHERE period=?").run(period);
}));

test('rejection requires explanation and stores a learning signal; reviewed balances do not authorize auto posting',()=>run(async()=>{
  const item=event(),p=await ai.proposeReview(database(),item.id,{fetcher:fake(chequePlan)});
  assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{reason:'نه'}),{code:'AI_REASON_REQUIRED'});
  db.reviewAiFeedback(item.id,p.id,{reason:'کالا موجودی انبار است و نباید هزینه شود'});
  assert.equal(ai.latestReviewProposal(database(),item.id).state,'rejected');
  const related=event();const row=database().prepare('SELECT * FROM financial_events WHERE id=?').get(related.id);
  assert.ok(assistant.relevantDna(database(),row).some(d=>d.reason.includes('موجودی انبار')));
  assert.equal(row.status,'pending');
}));

test('DNA stays in its workspace and backup preserves conversation, context, cheque and real journal',()=>run(()=>{
  const snapshot=db.financialBackupSnapshot();
  assert.ok(snapshot.tables.accounting_review_messages.some(m=>m.speaker==='accountant'));
  assert.ok(snapshot.tables.cheques.length>0);
  assert.ok(snapshot.tables.accounting_review_context.some(c=>JSON.parse(c.facts).dueAt));
  const workspace=db.createWorkspace(owner.id,{name:'شرکت بدون تجربه',profileType:'business'});
  db.runInWorkspace(workspace.id,{role:'owner',userId:owner.id},()=>{
    const item=event();ai.ensureReviewAiSchema(database());
    assert.equal(assistant.relevantDna(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id)).length,0);
    assert.equal(db.reviewQueue().dnaSummary.accepted,0);
  });
  const restored=db.restoreFinancialSnapshot(snapshot);
  assert.deepEqual(restored.tables.accounting_review_messages,snapshot.tables.accounting_review_messages);
  assert.deepEqual(restored.tables.cheques,snapshot.tables.cheques);
  assert.deepEqual(restored.tables.accounting_review_context,snapshot.tables.accounting_review_context);
}));

test('reversing reviewed cheque cancels its register and excludes it from future accepted DNA',()=>run(()=>{
  const cheque=db.listCheques().find(c=>c.id.startsWith('review:'));
  const eventId=cheque.id.slice('review:'.length);
  db.reverseEvent(eventId,'برگشت ثبت آزمایشی به درخواست حسابدار');
  assert.equal(database().prepare('SELECT status FROM cheques WHERE id=?').get(cheque.id).status,'cancelled');
  const item=event();
  assert.ok(!assistant.relevantDna(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id)).some(d=>d.eventId===eventId));
}));

test('concurrent chat change rejects a slow model answer and keeps prior proposal unpostable',()=>run(async()=>{
  const item=event();
  const first=await ai.proposeReview(database(),item.id,{fetcher:fake(chequePlan)});
  await assert.rejects(ai.proposeReview(database(),item.id,{message:'یک نکته تازه برای بررسی',fetcher:async()=>{
    assistant.saveReviewFacts(database(),item.id,{dueAt:'2026-12-01'});
    return fake(chequePlan)();
  }}),{code:'EVENT_NOT_PENDING'});
  const prepared=assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id),first);
  assert.equal(prepared.canPost,false);
  assert.throws(()=>db.reviewAiFeedback(item.id,first.id,{accepted:true}),{code:'AI_PROPOSAL_STALE'});
  assert.throws(()=>assistant.saveReviewFacts(database(),item.id,{occurredAt:'2026-99-30'}),{code:'REVIEW_DETAILS_REQUIRED'});
  assert.throws(()=>assistant.saveReviewFacts(database(),item.id,{occurredAt:''}),{code:'REVIEW_DETAILS_REQUIRED'});
}));

test('a rejected event without AI still teaches company DNA with accountant reason',()=>run(()=>{
  const item=event('پرداخت بیمه مسئولیت قبل از شروع پوشش',5000000);
  db.rejectEvent(item.id,'این پرداخت قبلاً ثبت شده و درخواست تکراری است');
  const next=event('پرداخت بیمه مسئولیت قبل از شروع پوشش',7000000);
  assert.ok(assistant.relevantDna(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(next.id)).some(d=>d.eventId===item.id && d.reason.includes('تکراری')));
}));

test('posted and reversed documents expose the same persistent accountant conversation',()=>run(()=>{
  const row=database().prepare("SELECT id,journal_entry_id FROM financial_events WHERE status='reversed' AND id IN(SELECT event_id FROM accounting_review_ai) LIMIT 1").get();
  const original=db.reviewAssistantForJournal(row.journal_entry_id);
  assert.equal(original.eventId,row.id);assert.ok(original.messages.some(m=>m.speaker==='accepted'));
  assert.ok(original.messages.find(m=>m.speaker==='accepted').actorName);
  const reversal=database().prepare('SELECT id FROM journal_entries WHERE reverses_entry_id=?').get(row.journal_entry_id);
  assert.equal(db.reviewAssistantForJournal(reversal.id).eventId,row.id);
}));

test('review reuses recorded date, exact existing party and voice maturity, without guessing collection date',()=>run(()=>{
  const contact=db.saveContact({name:'شرکت آفتاب هوشمند'});
  const item=event('خرید مواد مصرفی از شرکت آفتاب هوشمند با چک به مبلغ چهل میلیون تومان سررسید پانزدهم آبان ۱۴۰۵');
  const row=database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id);
  const known=assistant.reviewedEvent(database(),row);
  assert.equal(known.occurredAt,'2026-10-03');assert.equal(known.counterpartyId,contact.id);assert.equal(known.dueAt.slice(0,10),'2026-11-06');
  const other=event('چک شرکت نمونه فردا نقدش می‌کند');
  assert.equal(assistant.reviewedEvent(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(other.id)).dueAt,undefined);
  const history=db.reviewAssistantHistory(item.id);assert.equal(history.context.occurredAt,'2026-10-03');assert.equal(history.context.counterpartyId,contact.id);
}));

test('actual ledger type rejects an expense proposal targeting inventory, even if balanced',()=>run(async()=>{
  const id=crypto.randomUUID();database().prepare('INSERT INTO ledger_accounts(id,code,name,type,normal_side,source_kind,source_key) VALUES(?,?,?,?,?,?,?)').run(id,'199999','موجودی تست','asset','debit','inventory','test');
  const item=event();const contact=db.saveContact({name:'شرکت کنترل ماهیت'});
  const p=await ai.proposeReview(database(),item.id,{facts:{counterpartyId:contact.id,dueAt:'2026-11-01'},fetcher:fake({...chequePlan,lines:[{...chequePlan.lines[0],accountId:id},chequePlan.lines[1]]})});
  const preview=assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id),p);
  assert.equal(preview.canPost,false);assert.ok(preview.postingBlockers.some(x=>x.includes('ماهیت')));
  assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}),{code:'REVIEW_DETAILS_REQUIRED'});
}));

test('a proposed account is previewed, created only on approval, linked to subsidiary and not duplicated',()=>run(async()=>{
  const {saveChartAccount}=await import('../server/chartOfAccounts.js');
  const group=saveChartAccount(database(),{code:'98',name:'هزینه آزمایش',level:'group',type:'expense'});
  const general=saveChartAccount(database(),{code:'9801',name:'هزینه خدمات آزمایش',level:'general',type:'expense',parentCode:group.code});
  const chart=saveChartAccount(database(),{code:'980101',name:'خدمات آزمایش ویژه',level:'subsidiary',type:'expense',parentCode:general.code});
  const contact=db.saveContact({name:'شرکت حساب تازه'});
  const item=event();
  const plan={...chequePlan,lines:[{...chequePlan.lines[0],key:'خدمات آزمایش ویژه',chartAccountId:chart.id},chequePlan.lines[1]]};
  const p=await ai.proposeReview(database(),item.id,{facts:{counterpartyId:contact.id,dueAt:'2026-11-01'},fetcher:fake(plan)});
  const preview=assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id),p);
  assert.equal(preview.canPost,true);assert.equal(preview.lines[0].newAccount.chartAccountId,chart.id);
  assert.equal(database().prepare('SELECT COUNT(*) n FROM ledger_accounts WHERE chart_account_id=?').get(chart.id).n,0);
  const posted=db.reviewAiFeedback(item.id,p.id,{accepted:true}).item;
  const real=database().prepare('SELECT a.* FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.entry_id=? AND l.debit>0').get(posted.journalEntryId);
  assert.equal(real.chart_account_id,chart.id);assert.equal(real.type,'expense');
  const next=event();const n=await ai.proposeReview(database(),next.id,{facts:{counterpartyId:contact.id,dueAt:'2026-11-01'},fetcher:fake(plan)});
  const np=assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(next.id),n);
  assert.equal(np.lines[0].accountId,real.id);assert.equal(np.lines[0].newAccount,null);
}));

test('unchanged retries and concurrent clicks use one API request, chart changes invalidate cached proposals',()=>run(async()=>{
  const item=event();let calls=0;let prompt='';
  const fetcher=async(url,options)=>{calls++;prompt=JSON.parse(options.body).input[0].content[0].text;await new Promise(r=>setTimeout(r,10));return fake(chequePlan)();};
  const opts={message:'مواد مصرفی همین دوره است',fetcher};
  const [p,q]=await Promise.all([ai.proposeReview(database(),item.id,opts),ai.proposeReview(database(),item.id,opts)]);
  assert.equal(p.id,q.id);assert.equal(calls,1);
  assert.equal((await ai.proposeReview(database(),item.id,opts)).id,p.id);assert.equal(calls,1);
  assert.match(prompt,/occurredAt/);assert.match(prompt,/chartFields/);
  database().prepare('UPDATE ledger_accounts SET name=? WHERE id=?').run('نام اصلاح‌شده', 'ledger-opening-equity');
  const prepared=assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id),p);
  assert.equal(prepared.canPost,false);assert.ok(prepared.postingBlockers.some(b=>b.includes('کدینگ')));
  const fresh=await ai.proposeReview(database(),item.id,opts);assert.notEqual(fresh.id,p.id);assert.equal(calls,2);
}));
