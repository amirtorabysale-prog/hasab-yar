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

test('queue exposes the original captured voice text including line breaks and text beyond the old 1000-character limit',()=>run(()=>{
  const transcript='من گفتم: پیش‌پرداخت بیمه، نه هزینه.\n' + 'این توضیح اصلی کاربر هنگام ضبط است؛ '.repeat(45) + '\nپایان متن اصلی.';
  const item=store.recordFinancialEvent(database(),{kind:'cash-expense',amount:40000000,occurredAt:'2026-10-03',evidence:'خلاصه موتور',category:'بیمه'},
    {sourceEventId:crypto.randomUUID(),transcript,decision:{route:'accountant-review',guardBlocked:true,reasons:['بررسی لازم است']}});
  assert.ok(transcript.length>1000);
  const row=database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id);
  assert.equal(assistant.originalReviewTranscript(database(),row),transcript);
  const queue=db.reviewQueue({limit:200}).items.find(i=>i.id===item.id);
  assert.equal(queue.originalTranscript,transcript);
  const payload={...JSON.parse(row.payload),evidence:'تفسیر اصلاح‌شدهٔ موتور'};
  database().prepare('UPDATE financial_events SET payload=? WHERE id=?').run(JSON.stringify(payload),item.id);
  assert.equal(db.reviewQueue({limit:200}).items.find(i=>i.id===item.id).originalTranscript,transcript);
}));

const inventoryPlan={summary:'خرید انباری با چک',explanation:'کالا تحویل انبار شده؛ وجه نقد جابه‌جا نشده',counterpartyName:'شرکت سپهر فیلتر',missingFacts:[],inventoryItems:[{name:'فیلتر روغن تست',unit:'عدد',quantity:20,total:40000000}],lines:[{role:'inventory-asset',key:'فیلتر روغن تست',debit:40000000,credit:0},{role:'cheque-payable',debit:0,credit:40000000}]};
const inventoryText='۲۰ عدد فیلتر روغن تست برای انبار از شرکت سپهر فیلتر به مبلغ چهل میلیون تومان خریدیم و چک سررسید پانزدهم آبان ۱۴۰۵ دادیم';

test('one approval creates missing party, product, inventory ledger, real receipt and cheque with one balanced journal',()=>run(async()=>{
  const item=event(inventoryText),cash=db.listAccounts().find(a=>a.id==='cash').balance;
  const beforeContacts=database().prepare('SELECT count(*) n FROM contacts').get().n;
  const beforeProducts=database().prepare('SELECT count(*) n FROM products').get().n;
  const p=await ai.proposeReview(database(),item.id,{fetcher:fake(inventoryPlan)});
  const prepared=assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id),p);
  assert.equal(prepared.canPost,true);assert.equal(prepared.newCounterparty.name,'شرکت سپهر فیلتر');assert.equal(prepared.inventoryItems[0].newProduct,true);
  assert.equal(database().prepare('SELECT count(*) n FROM contacts').get().n,beforeContacts);assert.equal(database().prepare('SELECT count(*) n FROM products').get().n,beforeProducts);
  const posted=db.reviewAiFeedback(item.id,p.id,{accepted:true}).item;
  const product=database().prepare('SELECT * FROM products WHERE name=?').get('فیلتر روغن تست');assert.equal(product.stock,20);assert.equal(product.inventory_value,40000000);assert.equal(product.average_cost,2000000);
  assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,cash);
  const receipt=database().prepare("SELECT * FROM stock_movements WHERE source_type='accountant-review' AND source_id=?").get(item.id);assert.equal(receipt.value_delta,40000000);
  const cheque=db.listCheques().find(c=>c.id===`review:${item.id}`);assert.equal(cheque.journalEntryId,posted.journalEntryId);assert.ok(cheque.contactId);
  const lines=database().prepare('SELECT a.source_kind,a.source_key,l.debit,l.credit,l.analytic_id FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.entry_id=?').all(posted.journalEntryId);
  assert.ok(lines.some(l=>l.source_kind==='inventory-product' && l.source_key===product.id && l.debit===40000000));assert.ok(lines.find(l=>l.credit).analytic_id);
  assert.equal(database().prepare("SELECT count(*) n FROM journal_entries WHERE source_id=?").get(item.id).n,1);
  assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}),{code:'EVENT_NOT_REVIEWABLE'});
  db.reverseEvent(item.id,'برگشت کامل خرید آزمایشی');assert.equal(database().prepare('SELECT stock,inventory_value FROM products WHERE id=?').get(product.id).stock,0);
  assert.equal(database().prepare('SELECT inventory_value FROM products WHERE id=?').get(product.id).inventory_value,0);assert.equal(database().prepare('SELECT status FROM cheques WHERE id=?').get(cheque.id).status,'cancelled');
}));

test('inventory purchase asks for actual quantity and unit; never inserts a fictitious unit',()=>run(async()=>{
  const item=event(inventoryText);
  const p=await ai.proposeReview(database(),item.id,{fetcher:fake({...inventoryPlan,inventoryItems:[{name:'فیلتر روغن تست',total:40000000}]})});
  const prepared=assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id),p);
  assert.equal(prepared.canPost,false);assert.ok(prepared.postingBlockers.some(b=>b.includes('مقدار')));
  assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}),{code:'REVIEW_DETAILS_REQUIRED'});
}));

test('closed period rolls back new contact, product, accounts, journal, cheque and stock receipt together',()=>run(async()=>{
  const text='۲۰ عدد فیلتر ویژه تازه برای انبار از شرکت خرید اتمیک به مبلغ چهل میلیون تومان خریدیم';
  const item=event(text);
  const plan={...inventoryPlan,counterpartyName:'شرکت خرید اتمیک',inventoryItems:[{name:'فیلتر ویژه تازه',unit:'عدد',quantity:20,total:40000000}],lines:[{...inventoryPlan.lines[0],key:'فیلتر ویژه تازه'},inventoryPlan.lines[1]]};
  const p=await ai.proposeReview(database(),item.id,{facts:{dueAt:'2026-11-06'},fetcher:fake(plan)});
  const period=(await import('../server/accounting.js')).periodForDate('2026-10-03','Asia/Tehran');
  database().prepare("INSERT INTO accounting_periods(period,status) VALUES(?,'locked') ON CONFLICT(period) DO UPDATE SET status='locked'").run(period);
  const counts=()=>['contacts','products','ledger_accounts','journal_entries','stock_movements','cheques'].map(t=>database().prepare(`SELECT count(*) n FROM ${t}`).get().n);
  const before=counts();assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}),{code:'ACCOUNTING_PERIOD_LOCKED'});assert.deepEqual(counts(),before);assert.equal(ai.latestReviewProposal(database(),item.id).state,'proposed');
  database().prepare("UPDATE accounting_periods SET status='open' WHERE period=?").run(period);
}));

test('similar party names require identity resolution instead of merging silently, and fake model names cannot be created',()=>run(async()=>{
  db.saveContact({name:'شرکت تشابه کنترل'});
  const item=event('مواد مصرفی از تشابه کنترل خریدم با چک');
  const p=await ai.proposeReview(database(),item.id,{facts:{dueAt:'2026-11-06'},fetcher:fake({...chequePlan,counterpartyName:'تشابه کنترل'})});
  const preview=assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id),p);assert.equal(preview.canPost,false);assert.ok(preview.postingBlockers.some(b=>b.includes('شبیه')));
  const other=event('مواد مصرفی برای دفتر با چک خریدیم');
  const fakeName=await ai.proposeReview(database(),other.id,{facts:{dueAt:'2026-11-06'},fetcher:fake({...chequePlan,counterpartyName:'شرکت خیالی ناشناس'})});
  assert.equal(assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(other.id),fakeName).canPost,false);
}));

test('purchase reversal is blocked after later inventory use and leaves stock, cheque and journal unchanged',()=>run(async()=>{
  // Independent SKU: another test's reversal is dated at wall-clock time and
  // must not accidentally turn this purchase into a backdated inventory event.
  const name='فیلتر روغن مصرف بعدی';
  const item=event(inventoryText.replaceAll('فیلتر روغن تست',name));
  const plan=JSON.parse(JSON.stringify(inventoryPlan).replaceAll('فیلتر روغن تست',name));
  const p=await ai.proposeReview(database(),item.id,{fetcher:fake(plan)});
  const posted=db.reviewAiFeedback(item.id,p.id,{accepted:true}).item;
  const product=database().prepare('SELECT id FROM products WHERE name=?').get(name);
  const {recordInventoryMovement}=await import('../server/inventory.js');
  recordInventoryMovement(database(),product.id,{quantity:-2,movementType:'adjustment',sourceType:'manual',sourceId:crypto.randomUUID(),occurredAt:'2026-10-03'},{journal:false});
  const before=database().prepare('SELECT stock,inventory_value FROM products WHERE id=?').get(product.id);
  assert.throws(()=>db.reverseEvent(item.id,'برگشت خرید پس از مصرف'),{code:'REVIEW_DETAILS_REQUIRED'});
  assert.deepEqual(database().prepare('SELECT stock,inventory_value FROM products WHERE id=?').get(product.id),before);
  assert.equal(database().prepare('SELECT status FROM financial_events WHERE id=?').get(item.id).status,'posted');
  assert.equal(database().prepare('SELECT status FROM cheques WHERE id=?').get(`review:${item.id}`).status,'open');
  assert.equal(database().prepare('SELECT COUNT(*) n FROM journal_entries WHERE reverses_entry_id=?').get(posted.journalEntryId).n,0);
}));

test('inventory approval rejects a model total differing from the fixed event amount and backdated receipts needing valuation',()=>run(async()=>{
  const item=event(inventoryText);
  const doubled={...inventoryPlan,inventoryItems:[{...inventoryPlan.inventoryItems[0],total:80000000}],lines:[{...inventoryPlan.lines[0],debit:80000000},{...inventoryPlan.lines[1],credit:80000000}]};
  const p=await ai.proposeReview(database(),item.id,{fetcher:fake(doubled)});
  const preview=assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id),p);
  assert.equal(preview.canPost,false);assert.ok(preview.postingBlockers.some(b=>b.includes('مبلغ قطعی')));
  const backdated=store.recordFinancialEvent(database(),{kind:'cash-expense',amount:40000000,occurredAt:'2026-10-02',evidence:inventoryText,eventNature:'new'},
    {sourceEventId:crypto.randomUUID(),decision:{route:'accountant-review',guardBlocked:true,reasons:['بررسی لازم است']}});
  const b=await ai.proposeReview(database(),backdated.id,{facts:{dueAt:'2026-11-06'},fetcher:fake(inventoryPlan)});
  const bp=assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(backdated.id),b);
  assert.equal(bp.canPost,false);assert.ok(bp.postingBlockers.some(q=>q.includes('ارزش‌گذاری')));
}));

test('question answers persist per event, bind real date fields, enter history and change the proposal revision',()=>run(async()=>{
  const item=event();
  const question={summary:'تکمیل خرید',questions:[{id:'inventory.quantity',text:'چند واحد تحویل شد؟'},{id:'cheque.due_at',text:'تاریخ سررسید چک چیست؟',field:'dueAt'}],lines:[]};
  const first=await ai.proposeReview(database(),item.id,{fetcher:fake(question)});
  assert.equal(first.questions.length,2);assert.equal(first.missingFacts.length,2);
  let prompt='';
  const fetcher=async(url,options)=>{prompt=JSON.parse(options.body).input[0].content[0].text;return fake({...question,questions:[question.questions[0]]})();};
  const second=await ai.proposeReview(database(),item.id,{actor:owner.id,facts:{questionAnswers:{'cheque.due_at':{value:'2026-11-08'}}},fetcher});
  assert.ok(second.contextRevision>first.contextRevision);
  assert.equal(assistant.reviewContext(database(),item.id).facts.dueAt,'2026-11-08');
  assert.match(prompt,/2026-11-08/);assert.match(prompt,/سؤال پاسخ‌داده‌شده را تکرار نکن/);
  const history=db.reviewAssistantHistory(item.id);
  assert.equal(history.context.questionAnswers['cheque.due_at'].value,'2026-11-08');
  assert.ok(history.messages.some(m=>m.speaker==='accountant' && m.actor===owner.id && m.body.includes('سررسید')));
  assert.throws(()=>db.reviewAiFeedback(item.id,first.id,{accepted:true}),{code:'AI_PROPOSAL_STALE'});
  const snapshot=db.financialBackupSnapshot();assert.ok(snapshot.tables.accounting_review_context.some(c=>JSON.parse(c.facts).questionAnswers?.['cheque.due_at']));
  const other=event();assert.equal(db.reviewAssistantHistory(other.id).context.questionAnswers,undefined);
  // Editing an answer remains possible after its question disappeared from the next proposal.
  const revised=await ai.proposeReview(database(),item.id,{facts:{questionAnswers:{'cheque.due_at':{value:'2026-11-09'}}},fetcher:fake(question)});
  assert.equal(assistant.reviewContext(database(),item.id).facts.dueAt,'2026-11-09');
  assert.ok(revised.contextRevision>second.contextRevision);
}));

test('repeated answered question is retained as a blocker, retryable explicitly and never authorizes posting',()=>run(async()=>{
  const item=event();const q={...chequePlan,questions:[{id:'inventory.use',text:'مصرف شرکت است یا فروش؟'}]};
  await ai.proposeReview(database(),item.id,{fetcher:fake(q)});
  const answered=await ai.proposeReview(database(),item.id,{facts:{questionAnswers:{'inventory.use':{value:'مصرف شرکت'}}},fetcher:fake({...q,questions:[{id:'inventory.use',text:'برای مصرف است؟'}]})});
  const p=db.reviewAssistantHistory(item.id).proposal;
  assert.equal(p.questions[0].id,'inventory.use');assert.equal(p.context.questionAnswers['inventory.use'].value,'مصرف شرکت');
  assert.equal(p.canPost,false);assert.ok(p.postingBlockers.length);
  assert.throws(()=>db.reviewAiFeedback(item.id,answered.id,{accepted:true}),{code:'REVIEW_DETAILS_REQUIRED'});
  let calls=0;
  const next=await ai.proposeReview(database(),item.id,{fetcher:async()=>{calls++;return fake(chequePlan)();}});
  assert.equal(calls,1);assert.equal(next.questions.length,0);
  assert.equal(database().prepare('SELECT status FROM financial_events WHERE id=?').get(item.id).status,'pending');
}));

test('answers validate ownership, size, real dates and conflicting fields without partially saving facts',()=>run(async()=>{
  const item=event();await ai.proposeReview(database(),item.id,{fetcher:fake({summary:'سررسید',questions:[{id:'cheque.due_at',text:'سررسید چه تاریخی است؟',field:'dueAt'}],lines:[]})});
  const before=assistant.reviewContext(database(),item.id);
  for(const facts of [
    {counterpartyName:'نام نباید ذخیره شود',questionAnswers:{other:{value:'جواب جعلی'}}},
    {questionAnswers:{'cheque.due_at':{value:'2026-02-31'}}},
    {questionAnswers:{'cheque.due_at':{value:''}}},
    {questionAnswers:{'cheque.due_at':{value:'x'.repeat(1001)}}},
    {dueAt:'2026-11-10',questionAnswers:{'cheque.due_at':{value:'2026-11-11'}}},
  ]) {assert.throws(()=>assistant.saveReviewFacts(database(),item.id,facts));assert.deepEqual(assistant.reviewContext(database(),item.id),before);}
}));

test('failed AI call preserves answers and retries do not duplicate accountant history',()=>run(async()=>{
  const item=event();const q={summary:'مقدار',questions:[{id:'inventory.quantity',text:'چند عدد؟'}],lines:[]};
  await ai.proposeReview(database(),item.id,{fetcher:fake(q)});
  const options={actor:owner.id,facts:{questionAnswers:{'inventory.quantity':{value:'۲۰ عدد'}}}};
  await assert.rejects(ai.proposeReview(database(),item.id,{...options,fetcher:async()=>{throw Error('network');}}),{code:'AI_UNAVAILABLE'});
  assert.equal(db.reviewAssistantHistory(item.id).context.questionAnswers['inventory.quantity'].value,'۲۰ عدد');
  const rev=assistant.reviewContext(database(),item.id).revision;
  await ai.proposeReview(database(),item.id,{...options,fetcher:fake(q)});
  assert.equal(assistant.reviewContext(database(),item.id).revision,rev);
  assert.equal(assistant.reviewConversation(database(),item.id).filter(m=>m.speaker==='accountant').length,1);
}));

test('editing an ordinary field updates its saved answer so prompt never retains a contradictory date',()=>run(async()=>{
  const item=event();const question={summary:'تاریخ چک',questions:[{id:'cheque.due_at',text:'سررسید چیست؟',field:'dueAt'}],lines:[]};
  await ai.proposeReview(database(),item.id,{fetcher:fake(question)});
  await ai.proposeReview(database(),item.id,{facts:{questionAnswers:{'cheque.due_at':{value:'2026-11-08'}}},fetcher:fake(chequePlan)});
  const changed=assistant.saveReviewFacts(database(),item.id,{dueAt:'2026-11-12'});
  assert.equal(changed.facts.questionAnswers['cheque.due_at'].value,'2026-11-12');
  const cleared=assistant.saveReviewFacts(database(),item.id,{dueAt:''});
  assert.equal(cleared.facts.dueAt,null);assert.equal(cleared.facts.questionAnswers['cheque.due_at'],undefined);
}));

test('OpenAI request uses strict output contract and includes unlinked operational banks',()=>run(async()=>{
  const bank=db.saveAccount({name:'بانک بدون دفتر جدید',kind:'bank',bankId:'pasargad'});
  const item=event('هزینه پیک پرداخت شد',200000);let sent;
  await ai.proposeReview(database(),item.id,{fetcher:async(url,options)=>{
    sent=JSON.parse(options.body);
    return fake({summary:'نیاز به تاریخ',explanation:'تاریخ پرداخت مشخص نیست',questions:[{id:'payment.date',text:'پرداخت چه روزی بود؟',field:'occurredAt'}],lines:[]})() ;
  }});
  assert.equal(sent.text.format.type,'json_schema');assert.equal(sent.text.format.strict,true);assert.equal(sent.store,false);
  assert.ok(sent.input[0].content[0].text.includes(bank.id));
}));

test('one uniquely valued inventory line binds to its real SKU and posts stock atomically',()=>run(async()=>{
 const name='زونکن آزمایشی قرارداد';
 const item=event('امروز دو بسته زونکن آزمایشی قرارداد به بهای کل هشتصد هزار تومان از شرکت آزمون بایگانی نسیه خریدیم و تحویل انبار گرفتیم؛ برای فروش است و هنوز پرداخت نکردیم.',800000);
 const p=await ai.proposeReview(database(),item.id,{fetcher:fake({summary:'خرید نسیه',explanation:'ورود کالای برای فروش',counterpartyName:'شرکت آزمون بایگانی',missingFacts:[],inventoryItems:[{name,unit:'بسته',quantity:2,total:800000}],lines:[{role:'inventory-asset',key:'موجودی کالا و مواد',debit:800000,credit:0},{role:'payable',key:'شرکت آزمون بایگانی',debit:0,credit:800000}]})});
 assert.equal(p.lines[0].key,name);
 const beforeCash=db.listAccounts().find(a=>a.id==='cash').balance;
 const posted=db.reviewAiFeedback(item.id,p.id,{accepted:true}).item;
 const product=database().prepare('SELECT * FROM products WHERE name=?').get(name);
 assert.equal(product.stock,2);assert.equal(product.inventory_value,800000);
 assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,beforeCash);
 const rows=database().prepare('SELECT a.source_kind,l.debit,l.credit FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE entry_id=?').all(posted.journalEntryId);
 assert.ok(rows.some(r=>r.source_kind==='inventory-product' && r.debit===800000));
 assert.ok(rows.some(r=>r.source_kind==='vendor-payable' && r.credit===800000));
 assert.ok(!rows.some(r=>r.source_kind==='expense-category'));
}));

test('short named real banks map to bank subsidiary on transfer; no income or expense',()=>{
 const workspace=db.createWorkspace(owner.id,{name:'تست بانک کوتاه',profileType:'business'});
 return db.runInWorkspace(workspace.id,{role:'owner',userId:owner.id},()=>{
  db.installChartTemplate();
  const from=db.saveAccount({name:'سامان',kind:'bank',bankId:'saman',openingBalance:1000000});
  const to=db.saveAccount({name:'پاسارگاد',kind:'bank',bankId:'pasargad'});
  db.transferBetweenAccounts({fromAccountId:from.id,toAccountId:to.id,amount:500000,occurredAt:'2026-10-04'});
  for(const id of [from.id,to.id]) {
   const mapped=database().prepare("SELECT c.role FROM ledger_accounts a JOIN chart_accounts c ON c.id=a.chart_account_id WHERE a.source_kind='operational-account' AND a.source_key=?").get(id);
   assert.equal(mapped.role,'bank');
  }
  const rows=database().prepare("SELECT a.type,l.debit,l.credit FROM journal_lines l JOIN journal_entries j ON j.id=l.entry_id JOIN ledger_accounts a ON a.id=l.account_id WHERE j.source_type='account_transfer'").all();
  assert.equal(rows.length,2);assert.ok(rows.every(r=>r.type==='asset'));
  assert.equal(db.listAccounts().find(a=>a.id===from.id).balance,500000);
  assert.equal(db.listAccounts().find(a=>a.id===to.id).balance,500000);
 });
});

test('direct cheque capture cannot expense delivered resale inventory or create a party',()=>run(()=>{
 const journals=database().prepare('SELECT count(*) n FROM journal_entries').get().n;
 const contacts=database().prepare('SELECT count(*) n FROM contacts').get().n;
 const item=db.recordCheque({direction:'payable',against:'income',amount:2000000,counterpartyName:'شرکت گارد انبار تازه',dueAt:'2026-11-04',note:'دو بسته کاغذ از شرکت گارد انبار تازه برای فروش خریدیم و تحویل انبار گرفتیم، دو میلیون تومان چک دادیم'});
 assert.equal(item.queuedForAccountant,true);assert.equal(item.status,'pending');assert.equal(item.route,'accountant-review');
 assert.equal(database().prepare('SELECT count(*) n FROM journal_entries').get().n,journals);
 assert.equal(database().prepare('SELECT count(*) n FROM contacts').get().n,contacts);
 assert.ok(!db.listCheques().some(c=>c.id===item.id));
}));

for(const [role,outgoing,party] of [['prepaid-asset',true,false],['refundable-deposit',true,true],['loan-payable',false,true],['customer-advance',false,true],['deferred-revenue',false,true]]) {
 test(`specialized ${role}: approval, journal, bank, reports, edit lock and reversal stay atomic`,()=>run(async()=>{
  const amount=230000, item=event(`رویداد تخصصی ${role}`,amount);
  const contact=party?db.saveContact({name:`طرف آزمایش ${role}`}):null;
  const plan={summary:'ثبت تخصصی',explanation:'دریافت یا پرداخت بدون درآمد و هزینه جاری',missingFacts:[],lines:[
   {role,key:party?contact.name:'بیمه',debit:outgoing?amount:0,credit:outgoing?0:amount},
   {role:'cash',debit:outgoing?0:amount,credit:outgoing?amount:0}]};
  const initial=db.listAccounts().find(a=>a.id==='cash').balance;
  const p=await ai.proposeReview(database(),item.id,{facts:{accountId:'cash',...(contact?{counterpartyId:contact.id}:{})},fetcher:fake(plan)});
  const result=db.reviewAiFeedback(item.id,p.id,{accepted:true}).item;
  assert.equal(result.status,'posted');
  assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,initial+(outgoing?-amount:amount));
  const source=JSON.parse(database().prepare('SELECT journal_source FROM financial_events WHERE id=?').get(item.id).journal_source);
  const tx=database().prepare('SELECT *,accounting_role AS accountingRole FROM transactions WHERE id=?').get(source.id);
  assert.equal(tx.accountingRole,role);
  const journal=database().prepare('SELECT l.*,a.source_kind FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE entry_id=?').all(result.journalEntryId);
  assert.equal(journal.reduce((n,l)=>n+l.debit-l.credit,0),0);
  assert.ok(journal.some(l=>l.source_kind===role));
  if(party) assert.ok(journal.find(l=>l.source_kind===role).analytic_id);
  const {summarize}=await import('../server/db/transactions.js');
  assert.equal(summarize([tx]).income,0);assert.equal(summarize([tx]).expense,0);
  assert.throws(()=>db.updateTransaction(source.id,{amount:999999}),{code:'REVIEWED_TRANSACTION_LOCKED'});
  assert.throws(()=>db.deleteTransaction(source.id),{code:'REVIEWED_TRANSACTION_LOCKED'});
  assert.throws(()=>db.reviewAiFeedback(item.id,p.id,{accepted:true}),{code:'EVENT_NOT_REVIEWABLE'});
  db.reverseEvent(item.id,'برگشت آزمایش تخصصی');
  assert.equal(db.listAccounts().find(a=>a.id==='cash').balance,initial);
 }));
}

test('catalog binding corrects inventory and party identities but never changes accounting roles or values',()=>run(async()=>{
 const {bindReviewProposal}=await import('../server/reviewProposalBindings.js');
 const catalog={ledger:[['wrong','1','هزینه','expense','debit','expense-category','مواد',null]],chart:[]};
 const p=bindReviewProposal({inventoryItems:[{name:'زونکن',total:800000}],lines:[{role:'inventory-asset',accountId:'wrong',key:'مواد',debit:800000,credit:0},{role:'payable',accountId:'wrong',debit:0,credit:800000}]},catalog,{});
 assert.equal(p.lines[0].key,'زونکن');assert.equal(p.lines[0].accountId,undefined);
 assert.equal(p.lines[1].accountId,undefined);assert.equal(p.lines[1].role,'payable');assert.equal(p.lines[1].credit,800000);
}));

test('old bank mapped to cash is blocked without silently changing journal history',()=>run(async()=>{
 const bank=db.saveAccount({name:'سامان بررسی نگاشت',kind:'bank',bankId:'saman',openingBalance:0});
 const {resolveEventRole}=await import('../server/roleResolver.js');
 const id=resolveEventRole(database(),'cash',bank.id,{accountId:bank.id});
 const {saveChartAccount}=await import('../server/chartOfAccounts.js');
 const group=saveChartAccount(database(),{code:'97',name:'دارایی آزمایش نگاشت',level:'group',type:'asset'});
 const general=saveChartAccount(database(),{code:'9701',name:'نقد و بانک آزمایش',level:'general',type:'asset',parentCode:group.code});
 const cash=saveChartAccount(database(),{code:'970101',name:'صندوق آزمایش',level:'subsidiary',type:'asset',parentCode:general.code,role:'cash'});
 const target=saveChartAccount(database(),{code:'970102',name:'بانک آزمایش',level:'subsidiary',type:'asset',parentCode:general.code,role:'bank'});
 database().prepare('UPDATE ledger_accounts SET chart_account_id=? WHERE id=?').run(cash.id,id);
 const item=event('هزینه پیک از سامان',200000);
 const p=await ai.proposeReview(database(),item.id,{facts:{accountId:bank.id},fetcher:fake({summary:'پیک',explanation:'هزینه جاری',missingFacts:[],lines:[{role:'expense-category',key:'نظافت',debit:200000,credit:0},{role:'cash',debit:0,credit:200000}]})});
 const prepared=assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id),p);
 assert.equal(prepared.canPost,false);assert.ok(prepared.postingBlockers.some(b=>b.includes('معین صندوق')));
 assert.equal(database().prepare('SELECT chart_account_id FROM ledger_accounts WHERE id=?').get(id).chart_account_id,cash.id);
 assert.equal(prepared.mappingRepairs.length,1);assert.equal(prepared.mappingRepairs[0].chartAccountId,target.id);
 db.mapLedgerAccount(id,target.id);
 const again=await ai.proposeReview(database(),item.id,{facts:{accountId:bank.id},fetcher:fake({summary:'پیک',explanation:'هزینه جاری',missingFacts:[],lines:[{role:'expense-category',key:'نظافت',debit:200000,credit:0},{role:'cash',debit:0,credit:200000}]})});
 assert.equal(assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id),again).canPost,true);
 assert.equal(db.reviewAiFeedback(item.id,again.id,{accepted:true}).item.status,'posted');
}));

test('category semantics override unrelated same-type AI chart bindings',()=>run(async()=>{
 const {bindReviewProposal}=await import('../server/reviewProposalBindings.js');
 const catalog={ledger:[['salary','5102','حقوق و دستمزد','expense','debit','chart-account','salary','salary-chart']],chart:[['salary-chart','8101','حقوق و دستمزد','expense','debit','operating-expense',false],['delivery-chart','8103','حمل‌ونقل','expense','debit','operating-expense',false]]};
 const p=bindReviewProposal({inventoryItems:[],lines:[{role:'expense-category',key:'حمل‌ونقل',accountId:'salary',chartAccountId:'salary-chart',debit:200000,credit:0}]},catalog,{});
 assert.equal(p.lines[0].accountId,undefined);assert.equal(p.lines[0].chartAccountId,'delivery-chart');assert.equal(p.lines[0].debit,200000);
 assert.ok(p.bindingCorrections.length);
}));

test('direct transfer rejects an old bank mapped to cash atomically, then succeeds after explicit repair',()=>{
 const workspace=db.createWorkspace(owner.id,{name:'تست گارد انتقال',profileType:'business'});
 return db.runInWorkspace(workspace.id,{role:'owner',userId:owner.id},()=>{
  db.installChartTemplate();
  const from=db.saveAccount({name:'سامان',kind:'bank',bankId:'saman',openingBalance:1000000});
  const to=db.saveAccount({name:'پاسارگاد',kind:'bank',bankId:'pasargad'});
  const cash=database().prepare("SELECT id FROM chart_accounts WHERE role='cash' AND level='subsidiary'").get();
  const bank=database().prepare("SELECT id FROM chart_accounts WHERE role='bank' AND level='subsidiary'").get();
  const ledger=database().prepare("SELECT id FROM ledger_accounts WHERE source_kind='operational-account' AND source_key=?").get(from.id);
  db.mapLedgerAccount(ledger.id,cash.id);
  const before=database().prepare('SELECT count(*) n FROM journal_entries').get().n;
  assert.throws(()=>db.transferBetweenAccounts({fromAccountId:from.id,toAccountId:to.id,amount:500000,occurredAt:'2026-10-04'}),{code:'BANK_CHART_MAPPING_INVALID'});
  assert.equal(database().prepare('SELECT count(*) n FROM journal_entries').get().n,before);
  assert.equal(db.listAccounts().find(a=>a.id===from.id).balance,1000000);
  assert.equal(database().prepare('SELECT chart_account_id FROM ledger_accounts WHERE id=?').get(ledger.id).chart_account_id,cash.id);
  db.mapLedgerAccount(ledger.id,bank.id);
  db.transferBetweenAccounts({fromAccountId:from.id,toAccountId:to.id,amount:500000,occurredAt:'2026-10-04'});
  assert.equal(db.listAccounts().find(a=>a.id===from.id).balance,500000);
 });
});

test('DNA similarity cannot come only from shared bank, party and capture wording',()=>run(async()=>{
 const bank=db.saveAccount({name:'بانک سامان مشترک',kind:'bank',bankId:'saman'});
 const prior=event('امروز دریافت بابت خدمات چاپ از شرکت آزمون نقش به بانک سامان مشترک دریافت کردم؛ بازآزمایی تازه چاپ.',700000);
 const p=await ai.proposeReview(database(),prior.id,{facts:{accountId:bank.id},fetcher:fake({summary:'خدمات چاپ',explanation:'درآمد خدمات',missingFacts:[],lines:[{role:'income-category',key:'خدمات',debit:0,credit:700000},{role:'cash',debit:700000,credit:0}]})});
 db.reviewAiFeedback(prior.id,p.id,{accepted:true});
 const next=event('امروز اصل وام از آقای آزمون وام به بانک سامان مشترک دریافت کردم؛ درآمد نیست. بازآزمایی تازه وام.',2000000);
 const dna=assistant.relevantDna(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(next.id));
 assert.ok(!dna.some(d=>d.id===p.id));
}));

test('a confirmation word in a party answer is not stored as part of the party identity',()=>run(async()=>{
 const {prepareReviewResources}=await import('../server/reviewResources.js');
 const evidence='دو بسته زونکن را از شرکت نمونه خریدیم';
 const result=prepareReviewResources(database(),{counterparty:'بله، شرکت نمونه'},{counterpartyName:'شرکت نمونه',inventoryItems:[],lines:[{role:'payable'}]},{evidence,facts:{counterpartyName:'بله، شرکت نمونه'},messages:[{speaker:'accountant',body:'بله، شرکت نمونه'}]});
 assert.equal(result.newCounterparty.name,'شرکت نمونه');assert.equal(result.event.counterparty,'شرکت نمونه');
}));

test('trade inventory purchase can be posted without a maturity; cheque maturity remains mandatory',()=>run(async()=>{
 const item=event('دو بسته زونکن از شرکت آزمون اعتبار نسیه خریدیم و تحویل انبار گرفتیم برای فروش',800000);
 const plan={summary:'خرید نسیه',explanation:'کالا تحویل شده',counterpartyName:'شرکت آزمون اعتبار',questions:[{id:'payable.due',text:'سررسید این خرید نسیه چه تاریخی است؟',field:'dueAt'}],missingFacts:[],inventoryItems:[{name:'زونکن اعتبار',unit:'بسته',quantity:2,total:800000}],lines:[{role:'inventory-asset',key:'زونکن اعتبار',debit:800000,credit:0},{role:'payable',debit:0,credit:800000}]};
 const p=await ai.proposeReview(database(),item.id,{fetcher:fake(plan)});
 assert.equal(p.questions.length,0);assert.equal(p.optionalQuestions.length,1);
 assert.equal(assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id),p).canPost,true);
 const cheque=event('دو بسته زونکن از شرکت آزمون اعتبار با چک خریدیم و تحویل انبار گرفتیم برای فروش',800000);
 const cp=await ai.proposeReview(database(),cheque.id,{fetcher:fake({...plan,questions:[{id:'cheque.due',text:'سررسید چک چیست؟',field:'dueAt'}],lines:[plan.lines[0],{role:'cheque-payable',debit:0,credit:800000}]})});
 assert.equal(cp.questions.length,1);
 assert.equal(assistant.prepareReviewProposal(database(),database().prepare('SELECT * FROM financial_events WHERE id=?').get(cheque.id),cp).canPost,false);
}));
