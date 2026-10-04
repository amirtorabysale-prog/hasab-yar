import { factsFromEvent } from '../shared/eventFacts.js';
import { classifyFamily, FAMILY_UNKNOWN } from '../shared/economicFamily.js';
import { reviewQuestions } from '../shared/reviewQuestions.js';
import { randomUUID, createHash } from 'node:crypto';
import { ensureFinancialEventSchema } from './financialEventStore.js';
import { resolveEventAnalytic } from './roleResolver.js';

import { prepareReviewResources } from './reviewResources.js';
import { prepareReviewAccount, reviewKnowledgeFingerprint } from './reviewAccountPreparation.js';
import { extractContactName } from '../shared/counterpartySpeech.js';
import { exactCounterpartyKey } from '../shared/counterpartyIdentity.js';
import { detectBank } from '../shared/banks.js';
import { splitDateRoles } from '../shared/voiceIntent.js';

const fail = (message, code = 'REVIEW_DETAILS_REQUIRED') => Object.assign(new Error(message), { code, status: 409 });
export function ensureAssistantSchema(database) {
  ensureFinancialEventSchema(database);
  database.exec(`CREATE TABLE IF NOT EXISTS accounting_review_messages (
    id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES financial_events(id),speaker TEXT NOT NULL,
    actor TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS idx_review_messages_event ON accounting_review_messages(event_id);
    CREATE TABLE IF NOT EXISTS accounting_review_context (
    event_id TEXT PRIMARY KEY REFERENCES financial_events(id),facts TEXT NOT NULL DEFAULT '{}',revision INTEGER NOT NULL DEFAULT 0);`);
}
export function reviewConversation(database, eventId) {
  ensureAssistantSchema(database);
  return database.prepare('SELECT id,speaker,actor,body,created_at AS createdAt FROM accounting_review_messages WHERE event_id=? ORDER BY rowid').all(eventId);
}
export function reviewContext(database, eventId) {
  ensureAssistantSchema(database);
  const row = database.prepare('SELECT facts,revision FROM accounting_review_context WHERE event_id=?').get(eventId);
  return { facts: row ? JSON.parse(row.facts) : {}, revision: row?.revision || 0 };
}
export function addReviewMessage(database, eventId, speaker, body, actor = null) {
  ensureAssistantSchema(database);
  database.prepare('INSERT INTO accounting_review_messages(id,event_id,speaker,actor,body) VALUES(?,?,?,?,?)').run(randomUUID(), eventId, speaker, actor, String(body).slice(0, 4000));
}
export function saveReviewFacts(database, eventId, facts = {}) {
  if (!facts || typeof facts!=='object' || Array.isArray(facts)) throw fail('اطلاعات تکمیلی معتبر نیست.');
  const old = reviewContext(database, eventId);
  const next = { ...old.facts };
  const supplied={...facts};
  if (Object.hasOwn(facts,'questionAnswers')) {
    const submitted=facts.questionAnswers;
    if(!submitted || typeof submitted!=='object' || Array.isArray(submitted) || Object.keys(submitted).length>40) throw fail('پاسخ سؤال‌ها معتبر نیست.');
    const latest=database.prepare('SELECT proposal FROM accounting_review_ai WHERE event_id=? ORDER BY rowid DESC LIMIT 1').get(eventId);
    const allowed=new Map(reviewQuestions(latest?JSON.parse(latest.proposal):{}).map(q=>[q.id,q]));
    const answers={...(old.facts.questionAnswers || {})};
    for(const [id,answer] of Object.entries(submitted)) {
      if(!allowed.has(id) && !Object.hasOwn(answers,id)) throw fail('این سؤال مربوط به پیشنهاد فعلی این پرونده نیست.');
      if(!answer || typeof answer.value!=='string' || !answer.value.trim() || answer.value.trim().length>1000) throw fail('پاسخ هر سؤال باید بین ۱ تا ۱۰۰۰ نویسه باشد.');
      const previous=answers[id];
      const value=answer.value.trim();
      const question=allowed.get(id);
      const field=previous?.field || question?.field;
      if(field && previous?.value!==value) {
        if(Object.hasOwn(supplied,field) && String(supplied[field] || '').trim()!==value) throw fail('پاسخ سؤال و فیلد انتخاب‌شده یکسان نیستند.');
        supplied[field]=value;
      }
      answers[id]=previous?.value===value ? previous : {question:previous?.question || question?.text,value,...(field?{field}:{})};
    }
    if(Object.keys(answers).length>40) throw fail('تعداد پاسخ‌های این پرونده بیش از حد مجاز است.');
    next.questionAnswers=answers;
  }
  for (const key of ['occurredAt', 'dueAt', 'counterpartyId', 'counterpartyName', 'accountId']) {
    if (!Object.hasOwn(supplied, key)) continue;
    const value = String(supplied[key] || '').trim();
    if(key==='counterpartyName' && value && (value.length<2 || value.length>100)) throw fail('نام واقعی طرف‌حساب را کامل و کوتاه‌تر از ۱۰۰ نویسه بنویس.');
    if (key==='occurredAt' && !value) throw fail('تاریخ رویداد را خالی نگذار.');
    if (['occurredAt', 'dueAt'].includes(key) && value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value)) throw fail('تاریخ معتبر میلادی را از انتخابگر تاریخ تعیین کن.');
    if (key === 'counterpartyId' && value && !database.prepare('SELECT id FROM contacts WHERE id=?').get(value)) throw fail('طرف حساب انتخاب‌شده معتبر نیست.');
    if (key === 'accountId' && value && !database.prepare('SELECT id FROM accounts WHERE id=? AND active=1').get(value)) throw fail('حساب بانک یا صندوق معتبر نیست.');
    next[key] = value || null;
    // Editing the ordinary date/person/bank controls also updates the saved answer.
    for(const [id,answer] of Object.entries(next.questionAnswers || {})) {
      if(answer.field!==key || answer.value===value) continue;
      next.questionAnswers={...next.questionAnswers};
      if(value) next.questionAnswers[id]={...answer,value};
      else delete next.questionAnswers[id];
    }
  }
  database.prepare('INSERT OR IGNORE INTO accounting_review_context(event_id) VALUES(?)').run(eventId);
  if (JSON.stringify(next) !== JSON.stringify(old.facts)) database.prepare(`INSERT INTO accounting_review_context(event_id,facts,revision) VALUES(?,?,1)
    ON CONFLICT(event_id) DO UPDATE SET facts=excluded.facts,revision=revision+1`).run(eventId, JSON.stringify(next));
  return reviewContext(database, eventId);
}
/** Original captured speech-to-text; never replace it with the engine summary. */
export function originalReviewTranscript(database,row) {
  const event=JSON.parse(row.payload);
  const capture=database.prepare("SELECT detail FROM financial_event_audit WHERE event_id=? AND stage='captured' ORDER BY rowid LIMIT 1").get(row.id);
  const detail=capture ? JSON.parse(capture.detail) : {};
  const captured=detail.transcript || detail.rawInput || '';
  const anchor=row.journal_source ? JSON.parse(row.journal_source) : null;
  const hasTransactions=database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'").get();
  const raw=anchor?.type==='transaction' && hasTransactions ? database.prepare('SELECT raw_text FROM transactions WHERE id=?').get(anchor.id)?.raw_text || '' : '';
  // Older audit entries were truncated: recover a longer identical original when retained.
  if(raw && (!captured || raw.startsWith(captured))) return raw;
  return captured || event.utterance || event.evidence || '';
}
export const reviewEvidence=originalReviewTranscript;

export function reviewedEvent(database, row) {
  const facts=reviewContext(database,row.id).facts;
  const event = { ...JSON.parse(row.payload), ...facts };
  const text=reviewEvidence(database,row);
  if(facts.counterpartyName) event.counterparty=facts.counterpartyName;
  if(!event.counterpartyId && !Object.hasOwn(facts,'counterpartyId')) {
    const candidate=event.counterparty || extractContactName(text);
    if(candidate) {
      const matches=database.prepare('SELECT id,name FROM contacts').all().filter(c=>exactCounterpartyKey(c.name)===exactCounterpartyKey(candidate));
      if(matches.length===1) {event.counterpartyId=matches[0].id;event.counterparty=matches[0].name;}
    }
  }
  if(!event.accountId && !Object.hasOwn(facts,'accountId') && database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get()) {
    const bank=detectBank(text);
    if(bank) {const matches=database.prepare("SELECT id FROM accounts WHERE active=1 AND kind='bank' AND bank_id=?").all(bank.bankId);if(matches.length===1) event.accountId=matches[0].id;}
  }
  // Reuse voice date-role parser, anchored to the recorded event, never today's date.
  // Only explicit maturity markers: collection tomorrow is not issuance or maturity.
  if(!event.dueAt && !Object.hasOwn(facts,'dueAt') && /سررسید|سر رسید|به تاریخ/.test(text) && event.occurredAt) {
    event.dueAt=splitDateRoles(text,{now:new Date(event.occurredAt),isCheque:true}).dueAt;
  }
  if (event.counterpartyId) event.counterparty = database.prepare('SELECT name FROM contacts WHERE id=?').get(event.counterpartyId)?.name || '';
  return event;
}
const words = (text) => new Set(String(text).replace(/[يى]/g,'ی').replace(/ك/g,'ک').replace(/[\d۰-۹٠-٩]+/g,' ').split(/[^\p{L}]+/u).filter(w => w.length > 2 && !['تومان','میلیون','امروز','مبلغ','هزار','پرداخت','دریافت','کردم','کردیم','بانک','حساب','شرکت','آقای','بابت','تازه','بازآزمایی','آزمون'].includes(w)));
/** بازیابی تجربه، نه قانون یا اجازهٔ ثبت خودکار. مقدار و حساب‌های رویداد تازه مستقل کنترل می‌شوند. */
export function relevantDna(database, row) {
  const event = reviewedEvent(database, row);
  // A shared bank or person is context, not evidence of the same accounting treatment.
  const identityNames=[];
  for(const table of ['accounts','contacts']) {
    if(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      for(const item of database.prepare(`SELECT name FROM ${table}`).all()) if(item.name?.length>2) identityNames.push(item.name.replace(/[يى]/g,'ی').replace(/ك/g,'ک'));
    }
  }
  const meaningfulWords=text=>{let clean=String(text || '').replace(/[يى]/g,'ی').replace(/ك/g,'ک');for(const name of identityNames.sort((a,b)=>b.length-a.length)) clean=clean.split(name).join(' ');return words(clean);};
  const tokens=meaningfulWords(event.evidence || event.utterance || event.category);
  const family=classifyFamily(factsFromEvent(event)).family;
  const records = database.prepare(`SELECT a.id,a.event_id,a.state,a.proposal,a.feedback_reason,a.reviewed_by,a.reviewed_at,e.payload,e.status,e.journal_entry_id
    FROM accounting_review_ai a JOIN financial_events e ON e.id=a.event_id
    WHERE a.state IN ('accepted','rejected') AND a.event_id!=? ORDER BY a.reviewed_at DESC,a.rowid DESC LIMIT 200`).all(row.id);
  const human = database.prepare(`SELECT e.*,a.actor,a.detail,a.created_at AS reviewedAt,a.stage FROM financial_events e JOIN financial_event_audit a ON a.event_id=e.id
    WHERE e.id!=? AND a.stage IN ('approved','accountant-reviewed','rejected') AND e.status IN ('posted','rejected')
    AND NOT EXISTS(SELECT 1 FROM accounting_review_ai p WHERE p.event_id=e.id AND p.state IN ('accepted','rejected'))
    ORDER BY a.created_at DESC LIMIT 100`).all(row.id);
  for (const r of human) {
    const event=JSON.parse(r.payload),detail=JSON.parse(r.detail);
    records.push({id:`event:${r.id}`,event_id:r.id,state:r.status==='posted'?'accepted':'rejected',proposal:JSON.stringify({summary:event.description || event.category || event.kind}),feedback_reason:detail.reason || 'تأیید مستقیم حسابدار',reviewed_by:r.actor,reviewed_at:r.reviewedAt,payload:r.payload,status:r.status,journal_entry_id:r.journal_entry_id});
  }

  return records.map(r => {
    const source = JSON.parse(r.payload), other = meaningfulWords(source.evidence || source.utterance || source.category);
    const common = [...tokens].filter(w => other.has(w)).length;
    const sourceFamily=classifyFamily(factsFromEvent(source)).family;
    const compatible=family===FAMILY_UNKNOWN || sourceFamily===FAMILY_UNKNOWN || family===sourceFamily;
    return { id:r.id,eventId:r.event_id,state:r.state,summary:JSON.parse(r.proposal).summary,reason:r.feedback_reason,actor:r.reviewed_by,date:r.reviewed_at,journalEntryId:r.journal_entry_id,
      similarity: common / Math.max(1,new Set([...tokens,...other]).size), valid:compatible && (r.state==='rejected' || r.status==='posted') };
  }).filter(r => r.valid && r.similarity >= .25).sort((a,b)=>b.similarity-a.similarity).slice(0,5).map(({valid,...r})=>({...r,finalLines:r.journalEntryId ? database.prepare('SELECT a.code,a.name,l.debit,l.credit FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.entry_id=? ORDER BY l.rowid').all(r.journalEntryId) : []}));
}
export function proposalRevision(database, eventId) { return reviewContext(database,eventId).revision; }
export function conversationFingerprint(database,eventId) {
  return createHash('sha256').update(JSON.stringify([reviewContext(database,eventId),reviewConversation(database,eventId)])).digest('hex');
}
const partyRoles = new Set(['receivable','payable','cheque-receivable','cheque-payable','customer-advance','deferred-revenue','refundable-deposit','loan-payable']);
const roleNames = {cash:'بانک و صندوق',receivable:'حساب دریافتنی',payable:'حساب پرداختنی','cheque-receivable':'اسناد دریافتنی','cheque-payable':'اسناد پرداختنی','inventory-asset':'موجودی کالا','expense-category':'هزینه','income-category':'درآمد','fixed-asset':'دارایی ثابت','refundable-deposit':'ودیعه قابل استرداد','loan-payable':'اصل وام پرداختنی','prepaid-asset':'پیش‌پرداخت','owner-capital':'سرمایه مالک','customer-advance':'پیش‌دریافت مشتری','deferred-revenue':'درآمد انتقالی','accumulated-depreciation':'استهلاک انباشته','depreciation-expense':'هزینه استهلاک','vat-input':'اعتبار ارزش افزوده','vat-output':'مالیات ارزش افزوده پرداختنی'};
const sources = { cash:'operational-account', receivable:'customer-receivable', payable:'vendor-payable' };
const cashCounterparts=['expense-category','income-category','fixed-asset','owner-capital','prepaid-asset','refundable-deposit','loan-payable','customer-advance','deferred-revenue'];
const outgoingCashRoles=['expense-category','fixed-asset','prepaid-asset','refundable-deposit'];
const systemKeys = { 'owner-capital':'owner-capital', 'depreciation-expense':'depreciation-expense', 'vat-input':'input-tax', 'vat-output':'output-tax' };
/** بدون ساخت حساب در پیش‌نمایش؛ حساب تازه فقط داخل تراکنش تأیید ایجاد می‌شود. */
export function prepareReviewProposal(database, row, proposal, { resolve = false, eventOverride = null } = {}) {
  const initial=eventOverride || reviewedEvent(database,row);
  const resources=prepareReviewResources(database,initial,proposal,{evidence:reviewEvidence(database,row),facts:reviewContext(database,row.id).facts,messages:reviewConversation(database,row.id)});
  const event={...resources.event,reviewInventoryItems:eventOverride?.reviewInventoryItems || resources.inventoryItems};
  const mappingRepairs=[];
  const blockers = [...(proposal.missingFacts || [])];
  if(event.refundable===true && proposal.lines.some(l=>l.role==='prepaid-asset')) blockers.push('ودیعه قابل استرداد پیش‌پرداخت هزینه نیست؛ پیشنهاد باید با نقش ودیعه بازبینی شود.');
  if(/اصل\s*وام/.test(reviewEvidence(database,row)) && proposal.lines.some(l=>['income-category','payable'].includes(l.role))) blockers.push('اصل وام درآمد یا بدهی تجاری نیست؛ نقش اصل وام پرداختنی لازم است.');
  blockers.push(...resources.blockers);
  if(proposal.lines.some(l=>l.role==='inventory-asset') && !event.amountReferenceOnly && proposal.lines.filter(l=>l.role==='inventory-asset').reduce((n,l)=>n+l.debit,0)!==row.amount) blockers.push('بهای خرید انباری با مبلغ قطعی رویداد برابر نیست؛ پیشنهاد باید اصلاح شود.');
  if(!eventOverride && proposal.knowledgeFingerprint && proposal.knowledgeFingerprint!==reviewKnowledgeFingerprint(database)) blockers.push('کدینگ، اشخاص یا دفتر کل تغییر کرده؛ تحلیل را دوباره درخواست کن.');
  if (!event.occurredAt || !Number.isFinite(Date.parse(event.occurredAt))) blockers.push('تاریخ واقعی رویداد لازم است.');
  const named = key => database.prepare('SELECT id,code,name,type,normal_side AS normalSide,active,source_kind AS sourceKind,source_key AS sourceKey FROM ledger_accounts WHERE source_kind=? AND source_key=?').get(...key.map(v=>v ?? null));
  const lines = proposal.lines.map(line => {
    let key = line.key, role = line.role;
    if(!key && line.chartAccountId) key=database.prepare('SELECT name FROM chart_accounts WHERE id=? AND active=1').get(line.chartAccountId)?.name;
    if (partyRoles.has(role)) {
      if (!event.counterpartyId && !resources.newCounterparty) blockers.push('نام واقعی طرف حساب را مشخص کن؛ انتخاب سرفصل لازم نیست.');
      key = event.counterparty || key;
    }
    if (role === 'cash') {
      key = event.accountId;
      if (!key || !database.prepare('SELECT id FROM accounts WHERE id=? AND active=1').get(key)) blockers.push('بانک یا صندوق واقعی را انتخاب کن.');
    }
    if (['expense-category','income-category','prepaid-asset','fixed-asset','accumulated-depreciation'].includes(role) && !String(key || '').trim() && !line.accountId) blockers.push('AI نام حساب این سطر را تعیین نکرده؛ بازبینی پیشنهاد لازم است.');
    let account = line.accountId ? database.prepare('SELECT id,code,name,type,normal_side AS normalSide,active,source_kind AS sourceKind,source_key AS sourceKey FROM ledger_accounts WHERE id=?').get(line.accountId) : null;
    if (line.accountId && (!account || !account.active)) blockers.push('سرفصل پیشنهادی حذف یا غیرفعال شده است.');
    if (!account && !line.accountId) {
      const source = sources[role] || role;
      account = named([systemKeys[role] ? 'system' : source, systemKeys[role] || (partyRoles.has(role) ? event.counterpartyId : key)]);
    }
    if (account && role==='cash' && account.sourceKey!==event.accountId) blockers.push('بانک سطر پیشنهادی با بانک انتخاب‌شده یکسان نیست.');
    if(account && role==='cash') {
      const bank=database.prepare('SELECT kind,bank_id FROM accounts WHERE id=?').get(event.accountId);
      const mapped=database.prepare('SELECT c.role FROM ledger_accounts a JOIN chart_accounts c ON c.id=a.chart_account_id WHERE a.id=?').get(account.id);
      if(bank?.kind==='bank' && mapped?.role==='cash') {
        blockers.push('حساب بانکی به معین صندوق نگاشت شده است؛ نگاشت قبلی را اصلاح کن و تحلیل را دوباره بگیر.');
        const targets=database.prepare("SELECT id,code,name FROM chart_accounts WHERE role='bank' AND active=1 AND level='subsidiary'").all();
        if(targets.length===1) mappingRepairs.push({ledgerAccountId:account.id,accountName:account.name,chartAccountId:targets[0].id,chartCode:targets[0].code,chartName:targets[0].name,affectedLines:database.prepare('SELECT count(*) n FROM journal_lines WHERE account_id=?').get(account.id).n});
      }
    }
    if (account && !account.active) blockers.push('حساب پیشنهادی غیرفعال است.');
    if (account && partyRoles.has(role) && (account.sourceKind !== (sources[role] || role) || account.sourceKey !== event.counterpartyId)) blockers.push('حساب طرف‌حساب باید به شخص انتخاب‌شده متصل باشد.');
    if (account && account.sourceKind !== (systemKeys[role] ? 'system' : sources[role] || role) && role === 'cash') blockers.push('سطر نقدی باید به بانک یا صندوق عملیاتی متصل باشد.');
    const result=prepareReviewAccount(database,{...line,key,accountId:account?.id || line.accountId},event,{resolve:resolve && !blockers.length});
    blockers.push(...result.blockers);
    const mappedId=result.account?.chart_account_id || line.chartAccountId || result.creation?.chartAccountId;
    if(mappedId && database.prepare('SELECT requires_analytic FROM chart_accounts WHERE id=?').get(mappedId)?.requires_analytic && !partyRoles.has(role)) blockers.push('این معین به تفصیلی نیاز دارد؛ مسیر تخصصی برای تعیین شخص یا پروژه لازم است.');
    account=result.account ? {...result.account,sourceKind:result.account.source_kind,sourceKey:result.account.source_key} : account;
    return { ...line,key,accountId:account?.id || null,accountName:account?.name || (key ? `${roleNames[role] || role} — ${key}` : roleNames[role] || role),accountCode:account?.code || '',newAccount:!account?result.creation:null,analyticId: resolve && partyRoles.has(role) ? resolveEventAnalytic(database,role,event,key) : null };
  });
  const cheque = lines.filter(l => ['cheque-payable','cheque-receivable'].includes(l.role));
  if (cheque.length && (cheque.length !== 1 || !event.dueAt || (!event.counterpartyId && !resources.newCounterparty))) blockers.push('برای ثبت چک، یک سطر چک، طرف حساب و تاریخ سررسید مشخص لازم است.');
  if (cheque.some(l => l.role==='cheque-payable' ? l.debit>0 : l.credit>0)) blockers.push('وصول، برگشت یا تسویهٔ چک را در دفتر چک و با ارجاع به چک قبلی انجام بده.');
  const cash = lines.filter(l => l.role==='cash');
  const other = lines.filter(l=>l.role!=='cash');
  // Only supported two-sided cash shapes synchronize the operational register atomically.
  if (cash.length && (cash.length !== 1 || other.length !== 1 || !cashCounterparts.includes(other[0]?.role))) blockers.push('این ثبت نقدی چندبخشی یا تخصصی است؛ ابتدا مسیر تخصصی یا سطرهای عملیاتی آن باید تکمیل شود.');
  if (cash.length && other.some(l => l.accountId && !['income-category','expense-category','fixed-asset','system','chart-account','prepaid-asset','refundable-deposit','loan-payable','customer-advance','deferred-revenue'].includes(database.prepare('SELECT source_kind FROM ledger_accounts WHERE id=?').get(l.accountId)?.source_kind))) blockers.push('اثر نقدی این سرفصل در گزارش عملیاتی پشتیبانی نشده؛ مسیر تخصصی لازم است.');
  const anchor = row.journal_source ? JSON.parse(row.journal_source) : null;
  if (anchor?.type==='transaction') {
    const transaction=database.prepare('SELECT amount,status FROM transactions WHERE id=?').get(anchor.id);
    if (!transaction || transaction.status==='deleted' || transaction.amount!==row.amount) blockers.push('تراکنش مبنا تغییر کرده؛ پرونده را دوباره بررسی کن.');
  }
  if (anchor && anchor.type!=='transaction') blockers.push('منبع این رویداد مسیر تخصصی دارد؛ همان منبع را اصلاح کن.');
  if (event.eventNature && event.eventNature!=='new') blockers.push('برای سند اصلاحی، سند قبلی و مسیر اصلاح باید مشخص شود.');
  if ((proposal.contextRevision || 0) !== reviewContext(database,row.id).revision || proposal.sourceFingerprint !== createHash('sha256').update(`${row.payload}|${row.posting_plan}|${row.decision_id}`).digest('hex')) blockers.push('اطلاعات یا گفت‌وگو تغییر کرده؛ پیشنهاد را دوباره بررسی کن.');
  if (cash.length===1 && other.length===1 && cashCounterparts.includes(other[0].role)) {
    const creditCash=cash[0].credit>0;
    if (outgoingCashRoles.includes(other[0].role) ? !creditCash || other[0].debit<=0 : creditCash || other[0].credit<=0) blockers.push('جهت ورود یا خروج نقد با ماهیت سطر مقابل سازگار نیست.');
  }
  const locked = row.posting_plan ? JSON.parse(row.posting_plan) : null;
  const shape = list => (list || []).map(l=>[l.role,l.key || '',l.debit,l.credit].join(':')).sort().join('|');
  const decided = row.decision_id ? database.prepare('SELECT decision_status FROM accounting_decisions WHERE id=?').get(row.decision_id)?.decision_status==='decided' : true;
  const useLockedPlan = (!cash.length || anchor?.type==='transaction') && !proposal.missingFacts?.length && !proposal.lines.some(l=>l.accountId) && !Object.keys(reviewContext(database,row.id).facts).length && !JSON.parse(row.confidence || '{}').guardBlocked && decided && proposal.lines.length>0 && shape(proposal.lines)===shape(locked?.lines);
  const unique = [...new Set(blockers)].filter(b=>!useLockedPlan || !b.includes('این ثبت نقدی چندبخشی یا تخصصی') && !b.includes('اثر نقدی این سرفصل')); 
  return { ...proposal,lines,postingBlockers:unique,canPost:proposal.state==='proposed' && unique.length===0,contextRevision:proposal.contextRevision || 0,useLockedPlan,
    mappingRepairs,newCounterparty:resources.newCounterparty,inventoryItems:event.reviewInventoryItems,questions:reviewQuestions(proposal),
    context:{occurredAt:event.occurredAt?.slice(0,10),dueAt:event.dueAt?.slice(0,10),counterpartyId:event.counterpartyId,accountId:event.accountId,...reviewContext(database,row.id).facts},conversation:reviewConversation(database,row.id) };
}
