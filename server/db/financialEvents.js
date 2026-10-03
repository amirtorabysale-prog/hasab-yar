import { randomUUID } from 'node:crypto';
import { prepareReviewProposal, reviewConversation, reviewedEvent, relevantDna, proposalRevision, addReviewMessage } from '../reviewAssistant.js';
import { attachReviewedCheque } from './cheques.js';
import { listUnquantifiedReviews } from './reviewIntakes.js';
import { activeWorkspaceDatabase, audit, currentTimeZone, currentWorkspace, db, controlDb } from './core.js';
import { answerEventQuestion, approveFinancialEvent, decisionForEvent, financialEventAudit, handOverToAccountant, listReviewQueue, recordFinancialEvent, rejectFinancialEvent, reverseFinancialEvent, scheduleForEvent, postDueRecognitionItems, postReviewedComposite } from '../financialEventStore.js';
import { treatmentHasPlan } from '../../shared/accountingRules.js';
import { contactIdForName } from './contacts.js';
import { describeEvent, normalizeFinancialEvent } from '../../shared/financialEvent.js';
import { settlementFor, transactionJournalPoster } from './transactions.js';
import { openDocumentsFor } from './counterpartyCard.js';
import { vatGuardContext } from '../tax.js';
import { ensureReviewAiSchema, latestReviewProposal, proposeReview, proposalIsCurrent, recordReviewFeedback } from '../accountingReviewAi.js';

// ---------------------------------------------------------------------------
// رویدادهای مالی و صف بررسی
// ---------------------------------------------------------------------------

/**
 * ثبت یک رویداد مالی.
 *
 * تصمیمِ «سند چه باشد» اینجا گرفته نمی‌شود؛ `shared/accountingRules.js` آن را
 * می‌گیرد و لایهٔ ثبت فقط اجرا می‌کند. این تابع فقط دروازهٔ ورود است.
 */
export function submitFinancialEvent(event, options = {}) {
  const normalized = normalizeFinancialEvent(event);
  let resolvedEvent = normalized;
  if (normalized.counterparty && !normalized.counterpartyId) {
    const counterpartyId = contactIdForName(normalized.counterparty, options.counterpartyResolution);
    const contact = counterpartyId ? db.prepare('SELECT id,name FROM contacts WHERE id=?').get(counterpartyId) : null;
    resolvedEvent = { ...normalized, counterpartyId, counterparty: contact?.name || normalized.counterparty };
  }
  const result = recordFinancialEvent(activeWorkspaceDatabase(), resolvedEvent, {
    ...options,
    actor: options.actor || currentWorkspace()?.userId || null,
    timeZone: currentTimeZone(),
  });
  if (!result.duplicate) audit('create', 'financial-event', result.id, { kind: resolvedEvent.kind, amount: resolvedEvent.amount, route: result.route });
  return result;
}

export function reviewQueue(options = {}) {
  const database = activeWorkspaceDatabase();
  ensureReviewAiSchema(database);
  const items = [...listUnquantifiedReviews(options), ...listReviewQueue(database, options).map(item=>{
    const row=database.prepare('SELECT * FROM financial_events WHERE id=?').get(item.id);
    return {...item,aiProposal:item.route==='accountant-review'?preparedProposal(database,item.id):null,dnaMatches:item.route==='accountant-review'?relevantDna(database,row).map(d=>({...d,actorName:actorName(d.actor)})):[]};
  })];
  const counts=database.prepare("SELECT state,COUNT(*) count FROM accounting_review_ai WHERE state!='proposed' GROUP BY state").all();
  return {items,dnaSummary:{accepted:counts.find(c=>c.state==='accepted')?.count || 0,rejected:counts.find(c=>c.state==='rejected')?.count || 0,messages:database.prepare("SELECT COUNT(*) count FROM accounting_review_messages WHERE speaker='accountant'").get().count}};
}

function actorName(id) {return id ? controlDb.prepare('SELECT display_name,username FROM users WHERE id=?').get(id)?.display_name || controlDb.prepare('SELECT username FROM users WHERE id=?').get(id)?.username || id : null;}
function labelHistory(proposal) {return proposal ? {...proposal,conversation:proposal.conversation?.map(m=>({...m,actorName:actorName(m.actor)})),dnaEvidence:proposal.dnaEvidence?.map(d=>({...d,actorName:actorName(d.actor)}))} : null;}
function preparedProposal(database,eventId,proposal = latestReviewProposal(database,eventId)) {
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(eventId);
  return proposal && row ? labelHistory(prepareReviewProposal(database,row,proposal)) : null;
}
export function reviewAssistantHistory(eventId) {
  const database = activeWorkspaceDatabase();
  if (!database.prepare('SELECT id FROM financial_events WHERE id=?').get(eventId)) throw Object.assign(new Error('پرونده پیدا نشد.'),{status:404});
  const row=database.prepare('SELECT * FROM financial_events WHERE id=?').get(eventId);
  const known=reviewedEvent(database,row);
  return { messages:reviewConversation(database,eventId).map(m=>({...m,actorName:actorName(m.actor)})),proposal:preparedProposal(database,eventId),context:{occurredAt:known.occurredAt?.slice(0,10),dueAt:known.dueAt?.slice(0,10),counterpartyId:known.counterpartyId,accountId:known.accountId} };
}
export function reviewAssistantForJournal(journalEntryId) {
  const database=activeWorkspaceDatabase();
  const row=database.prepare(`SELECT id FROM financial_events WHERE journal_entry_id=? OR journal_entry_id=(SELECT reverses_entry_id FROM journal_entries WHERE id=?) LIMIT 1`).get(journalEntryId,journalEntryId);
  return row ? {...reviewAssistantHistory(row.id),eventId:row.id} : {eventId:null,messages:[],proposal:null};
}
export async function analyzeReviewEvent(eventId, {message = '',facts = {}} = {}) {
  const database = activeWorkspaceDatabase();
  const proposal = await proposeReview(database,eventId,{message,facts,actor:currentWorkspace()?.userId || null});
  return { proposal:preparedProposal(database,eventId,proposal) };
}


export function reviewAiFeedback(eventId, proposalId, { accepted = false, reason = '' } = {}) {
  const database = activeWorkspaceDatabase();
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(eventId);
  if (!row || row.status !== 'pending' || row.route !== 'accountant-review') throw Object.assign(new Error('این مورد دیگر در صف حسابدار نیست.'), { code: 'EVENT_NOT_REVIEWABLE', status: 409 });
  const proposal = latestReviewProposal(database, eventId);
  if (!proposal || proposal.id !== proposalId || proposal.state !== 'proposed' || !proposalIsCurrent(proposal, row) || (proposal.contextRevision || 0) !== proposalRevision(database,eventId)) throw Object.assign(new Error('پیشنهاد AI تغییر کرده است؛ صفحه را تازه‌سازی کن.'), { code: 'AI_PROPOSAL_STALE', status: 409 });
  const actor = currentWorkspace()?.userId || null;
  if (accepted) {
    const prepared=prepareReviewProposal(database,row,proposal);
    if (prepared.canPost && prepared.useLockedPlan) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const fresh=database.prepare('SELECT * FROM financial_events WHERE id=?').get(eventId);
        if (fresh.status!=='pending' || !proposalIsCurrent(proposal,fresh) || (proposal.contextRevision || 0)!==proposalRevision(database,eventId)) throw Object.assign(new Error('پیشنهاد هم‌زمان تغییر کرده است.'),{code:'AI_PROPOSAL_STALE',status:409});
        const item=approveEvent(eventId,{reason:'تأیید حسابدار پس از تطبیق پیشنهاد با نقشه قطعی',withinTransaction:true});
        recordReviewFeedback(database,eventId,proposal.id,{state:'accepted',reason:proposal.explanation,actor});
        addReviewMessage(database,eventId,'accepted',`تأیید سند ${item.journalEntryId}`,actor);
        database.exec('COMMIT');
        return {item};
      } catch(error) {database.exec('ROLLBACK');throw error;}
    }
    return acceptPreparedProposal(database,row,proposal,actor);
  }
  const updated = recordReviewFeedback(database, eventId, proposalId, { state: 'rejected', reason, actor });
  addReviewMessage(database,eventId,'rejected',reason,actor);
  audit('reject-ai-proposal', 'financial-event', eventId, { proposalId, reason: String(reason).slice(0, 200) });
  return { proposal: updated };
}

/** حسابدار سطرهای قطعی را انتخاب می‌کند؛ AI فقط شاهد پیشنهاد است. */
export function recordReviewedComposite(eventId, { lines, reason, proposalId = '', aiAccepted = false } = {}) {
  const database = activeWorkspaceDatabase();
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(eventId);
  if (!row || row.status !== 'pending') throw Object.assign(new Error('این مورد دیگر در انتظار نیست.'), { code: 'EVENT_NOT_PENDING', status: 409 });
  const proposal = latestReviewProposal(database, eventId);
  if (proposal?.state === 'proposed') {
    if (!proposalId || proposal.id !== proposalId || !proposalIsCurrent(proposal, row) || (proposal.contextRevision || 0) !== proposalRevision(database,eventId)) throw Object.assign(new Error('پیشنهاد AI تغییر کرده است؛ صف را تازه‌سازی کن.'), { code: 'AI_PROPOSAL_STALE', status: 409 });
    if (aiAccepted && (proposal.missingFacts.length || !proposal.lines || proposal.lines.length !== lines?.length || proposal.lines.some((line, index) => line.debit !== lines[index].debit || line.credit !== lines[index].credit))) {
      throw Object.assign(new Error('مبالغ سند با پیشنهاد AI برابر نیست؛ اصلاح را با دلیل ثبت کن.'), { code: 'AI_PLAN_REVISION_REQUIRED', status: 409 });
    }
    if (!aiAccepted && String(reason || '').trim().length < 8) throw Object.assign(new Error('دلیل اصلاح پیشنهاد AI را بنویس.'), { code: 'AI_REASON_REQUIRED', status: 400 });
  } else if (proposalId || aiAccepted) {
    throw Object.assign(new Error('پیشنهاد AI معتبر برای این مورد وجود ندارد.'), { code: 'AI_PROPOSAL_STALE', status: 409 });
  }
  const actor = currentWorkspace()?.userId || null;
  database.exec('BEGIN IMMEDIATE');
  try {
    const item = postReviewedComposite(database, eventId, { lines, reason, actor, timeZone: currentTimeZone() });
    if (proposal?.state === 'proposed') recordReviewFeedback(database, eventId, proposal.id, {
      state: aiAccepted ? 'accepted' : 'rejected', reason, actor,
    });
    database.exec('COMMIT');
    audit('reviewed-composite', 'financial-event', eventId, { journalEntryId: item.journalEntryId, proposalId: proposal?.id || null, aiAccepted: Boolean(proposal && aiAccepted) });
    return { item };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

/**
 * پرسش‌های بازِ صاحب کسب‌وکار.
 *
 * فقط مسیر `confirm` — یعنی مواردی که خودِ کاربر می‌تواند جوابشان را بدهد.
 * چیزی که به دانش حسابداری نیاز دارد به او نشان داده نمی‌شود؛ آن در صف
 * حسابدار می‌ماند.
 *
 * خروجی عمداً تنگ است: نه نمرهٔ اطمینان، نه نام مسیر، نه مؤلفه‌ها، نه نقشهٔ
 * سند. کاربری که دانش حسابداری ندارد با دیدن این‌ها تصمیم بهتری نمی‌گیرد،
 * فقط اعتمادش را از دست می‌دهد.
 */
export function pendingConfirmations(limit = 5) {
  const items = listReviewQueue(activeWorkspaceDatabase(), { limit, route: 'confirm' });
  return {
    items: items.map((item) => ({
      id: item.id,
      question: item.confidence?.summary || describeEvent(item.event),
      // یک دلیل، به زبان ساده. فهرست دلایل، پرسش را به بازجویی تبدیل می‌کند.
      hint: item.confidence?.reasons?.[0] || '',
      amount: item.amount,
      occurredAt: item.occurredAt,
      evidence: String(item.event?.evidence || '').slice(0, 300),
    })),
  };
}

/** «بله، درست است» — همان تأیید، با همان مسیر سند. */
export function confirmPending(eventId) {
  return approveEvent(eventId);
}

/**
 * ردیف تراکنشی که رویدادش رد یا معکوس شده.
 *
 * چرا لازم است: ماندهٔ حساب و گزارش‌های کاربر از جدول `transactions` ساخته
 * می‌شوند، نه از دفتر کل. اگر فقط رویداد رد شود، ردیف تراکنش سر جایش می‌ماند و
 * تا ابد در ماندهٔ صندوق و گزارش ماه دیده می‌شود — درحالی‌که هیچ سندی ندارد و
 * هیچ‌وقت هم نخواهد داشت. دفتر و برنامه دائم اختلاف نشان می‌دهند و هیچ‌کس
 * نمی‌فهمد چرا.
 *
 * حذف فیزیکی نمی‌شود: همان `status='deleted'` که مسیر حذف عادی استفاده می‌کند.
 */
function retireTransactionBehind(eventId, action) {
  const database = activeWorkspaceDatabase();
  const row = database.prepare('SELECT journal_source AS journalSource FROM financial_events WHERE id=?').get(String(eventId || ''));
  const source = row?.journalSource ? JSON.parse(row.journalSource) : null;
  if (source?.type !== 'transaction') return;
  const changed = database.prepare("UPDATE transactions SET status='deleted',journal_deferred=0,updated_at=? WHERE id=? AND status!='deleted'")
    .run(new Date().toISOString(), source.id).changes;
  if (changed) audit(action, 'transaction', source.id, { because: 'financial-event', eventId });
}

/** «نمی‌دانم» — مورد به حسابدار سپرده می‌شود، نه پاک. */
export function handOverPending(eventId) {
  const item = handOverToAccountant(activeWorkspaceDatabase(), eventId, {
    actor: currentWorkspace()?.userId || null, reason: 'کاربر گفت مطمئن نیست.',
  });
  audit('handover', 'financial-event', eventId, { route: item.route });
  return item;
}

export function approveEvent(eventId, { reason = '', withinTransaction = false } = {}) {
  const database = activeWorkspaceDatabase();
  // رویدادی که روی یک تراکنش نشسته، سندش را از همان مسیر تراکنش می‌گیرد. اگر
  // اینجا نقشهٔ نقش‌محور اجرا شود، دو تراکنش هم‌شکل بسته به اینکه خودکار ثبت
  // شده‌اند یا با تأیید، دو سند متفاوت می‌گیرند.
  const row = database.prepare('SELECT journal_source AS journalSource FROM financial_events WHERE id=?').get(String(eventId || ''));
  const source = row?.journalSource ? JSON.parse(row.journalSource) : null;
  let postJournal = null;
  // ولی وقتی تصمیم برخوردی را انتخاب کرده که نقشهٔ خودش را دارد — مثل
  // پیش‌پرداخت — مسیر تراکنش نباید برنده شود. آن مسیر فقط هزینه و درآمد
  // می‌شناسد و سکوت‌کنان تصمیم را دور می‌زند.
  const decision = decisionForEvent(database, eventId);
  const decisionDrivesPlan = treatmentHasPlan(decision?.treatment);
  if (source?.type === 'transaction' && !decisionDrivesPlan) {
    // شناسهٔ طرف حساب هم خوانده می‌شود: بدون آن، سندی که با تأیید ثبت
    // می‌شود روی دستهٔ هزینه می‌نشیند درحالی‌که همان ثبت اگر خودکار رفته بود
    // بدهی همان شخص را می‌بست. دو سند متفاوت برای یک ثبت، بسته به اینکه
    // حسابدار تأییدش کرده یا نه.
    const transaction = database.prepare(`SELECT id,amount,type,category,raw_text AS rawText,
      account_id AS accountId,occurred_at AS occurredAt,contact_id AS contactId,
      settlement_choice AS settlement FROM transactions WHERE id=?`).get(source.id);
    if (transaction) postJournal = transactionJournalPoster(transaction, settlementFor(transaction));
  }
  const item = approveFinancialEvent(database, eventId, {
    actor: currentWorkspace()?.userId || null, timeZone: currentTimeZone(), postJournal, overrideReason: reason, withinTransaction,
  });
  if (source?.type === 'transaction') database.prepare('UPDATE transactions SET journal_deferred=0 WHERE id=?').run(source.id);
  audit('approve', 'financial-event', eventId, { status: item.status });
  return item;
}

export function reverseEvent(eventId, reason = '') {
  const database=activeWorkspaceDatabase();
  database.exec('BEGIN IMMEDIATE');
  try {
    const hasCheques=database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cheques'").get();
    const cheque=hasCheques ? database.prepare('SELECT id,status FROM cheques WHERE id=?').get(`review:${eventId}`) : null;
    if (cheque && cheque.status!=='open') throw Object.assign(new Error('این چک پیش‌تر وصول یا تعیین تکلیف شده؛ ابتدا اسناد وابسته را اصلاح کن.'),{code:'REVIEW_CHEQUE_DEPENDENCY',status:409});
    const item=reverseFinancialEvent(database,eventId,{actor:currentWorkspace()?.userId || null,reason,timeZone:currentTimeZone(),withinTransaction:true});
    if(cheque) database.prepare("UPDATE cheques SET status='cancelled' WHERE id=?").run(cheque.id);
    retireTransactionBehind(eventId,'reverse');
    database.exec('COMMIT');
    audit('reverse','financial-event',eventId,{reason:String(reason).slice(0,200)});
    return item;
  } catch(error) {database.exec('ROLLBACK');throw error;}
}

export function rejectEvent(eventId, reason = '') {
  if (String(reason).trim().length < 8) throw Object.assign(new Error('دلیل رد را با حداقل هشت نویسه بنویس.'),{code:'REVIEW_REASON_REQUIRED',status:400});
  const database = activeWorkspaceDatabase();
  const proposal = latestReviewProposal(database,eventId);
  database.exec('BEGIN IMMEDIATE');
  try {
    const item = rejectFinancialEvent(database,eventId,{actor:currentWorkspace()?.userId || null,reason});
    if (proposal?.state==='proposed') recordReviewFeedback(database,eventId,proposal.id,{state:'rejected',reason,actor:currentWorkspace()?.userId || null});
    addReviewMessage(database,eventId,'rejected',reason,currentWorkspace()?.userId || null);
    retireTransactionBehind(eventId,'reject');
    database.exec('COMMIT');
    audit('reject','financial-event',eventId,{reason:String(reason).slice(0,200)});
    return item;
  } catch(error) {database.exec('ROLLBACK');throw error;}
}

export function eventAudit(eventId) {
  return { items: financialEventAudit(activeWorkspaceDatabase(), eventId) };
}

/**
 * جواب کاربر به سؤال یک رویداد.
 *
 * جواب دادن ثبت نیست: ابهام برطرف می‌شود و تصمیم تازه ساخته می‌شود، ولی سند
 * همچنان با تأیید زده می‌شود. اگر جواب دادن خودش سند می‌زد، کاربر با یک کلیک
 * روی «از همین ماه» ناخواسته دفتر را تکان می‌داد.
 */
export function answerEvent(eventId, { fact, value, freeText = '' } = {}) {
  const database = activeWorkspaceDatabase();
  // نگهبان‌ها پس از جواب دوباره اجرا می‌شوند و همان چیزی را لازم دارند که در
  // لحظهٔ ثبت داشتند — با وضعیت امروزِ دفتر، نه وضعیت آن روز.
  const stored = database.prepare('SELECT payload FROM financial_events WHERE id=?').get(String(eventId || ''));
  const contactId = stored ? JSON.parse(stored.payload).counterpartyId : null;
  const item = answerEventQuestion(database, eventId, {
    fact, value, freeText, actor: currentWorkspace()?.userId || null,
    guardContext: { vat: vatGuardContext(database), openDocuments: contactId ? openDocumentsFor(contactId) : undefined },
  });
  audit('answer', 'financial-event', eventId, { fact, value, status: item.decision?.decisionStatus });
  return item;
}

/** تصمیم و برنامهٔ شناسایی یک رویداد — برای صف بررسی. */
/**
 * اجرای اقلام شناسایی سررسیدرسیده.
 *
 * دستی صدا زده می‌شود، نه خودکار: تا وقتی کسی ندیده موتور چه می‌سازد، اجرای
 * خودکارش روی دفتر واقعی همان حدسی است که کل طرح برای حذفش نوشته شده.
 */
export function runRecognition() {
  const result = postDueRecognitionItems(activeWorkspaceDatabase(), {
    actor: currentWorkspace()?.userId || null, timeZone: currentTimeZone(),
  });
  if (result.posted) audit('recognize', 'recognition-schedule', 'due', result);
  return result;
}

export function eventDecision(eventId) {
  const database = activeWorkspaceDatabase();
  return { decision: decisionForEvent(database, eventId), schedule: scheduleForEvent(database, eventId) };
}

/** تمام اثرهای دفتر، ردیف نقدی و چک در یک تراکنش؛ پیشنهاد، مجوزِ دور زدن اعتبار حساب/دوره نیست. */
function acceptPreparedProposal(database,row,proposal,actor) {
  const prepared = prepareReviewProposal(database,row,proposal);
  if (!prepared.canPost) throw Object.assign(new Error(prepared.postingBlockers.join(' — ') || 'پیشنهاد هنوز قطعی نیست.'), {code:'REVIEW_DETAILS_REQUIRED',status:409});
  database.exec('BEGIN IMMEDIATE');
  try {
    const fresh = database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id);
    if (fresh.status !== 'pending' || !proposalIsCurrent(proposal,fresh) || (proposal.contextRevision || 0) !== proposalRevision(database,row.id)) throw Object.assign(new Error('این پرونده هم‌زمان تغییر کرده است؛ دوباره بررسی کن.'),{code:'AI_PROPOSAL_STALE',status:409});
    const final = prepareReviewProposal(database,fresh,proposal,{resolve:true});
    if (!final.canPost) throw Object.assign(new Error(final.postingBlockers.join(' — ')),{code:'REVIEW_DETAILS_REQUIRED',status:409});
    const event = reviewedEvent(database,fresh);
    const cash = final.lines.find(l=>l.role==='cash');
    const counterpart = final.lines.find(l=>l.role!=='cash');
    const source = fresh.journal_source ? JSON.parse(fresh.journal_source) : null;
    if (cash) {
      const ledger = database.prepare('SELECT source_kind,source_key FROM ledger_accounts WHERE id=?').get(cash.accountId);
      if (ledger?.source_kind!=='operational-account' || ledger.source_key!==event.accountId) throw Object.assign(new Error('حساب نقدی پیشنهاد با بانک انتخاب‌شده برابر نیست.'),{code:'REVIEW_ACCOUNT_MISMATCH',status:409});
      const amount = cash.debit || cash.credit, type = cash.debit ? 'income' : 'expense';
      const capitalFlow = counterpart.role==='fixed-asset' ? 'fixed-asset' : counterpart.role==='owner-capital' ? 'capital-in' : '';
      const transactionId = source?.type==='transaction' ? source.id : randomUUID();
      if (source?.type==='transaction') {
        const changed = database.prepare(`UPDATE transactions SET amount=?,type=?,category=?,account_id=?,account=?,contact_id=?,occurred_at=?,capital_flow=?,journal_deferred=0,review_state='ready',needs_review=0,updated_at=? WHERE id=? AND status!='deleted'`).run(amount,type,counterpart.key || counterpart.accountName,event.accountId,event.accountId,event.counterpartyId || null,event.occurredAt,capitalFlow,new Date().toISOString(),transactionId).changes;
        if (!changed) throw Object.assign(new Error('تراکنش مبنا دیگر فعال نیست.'),{code:'EVENT_NOT_REVIEWABLE',status:409});
      } else {
        database.prepare(`INSERT INTO transactions(id,client_id,amount,type,category,raw_text,source,account_id,account,contact_id,occurred_at,capital_flow,status,journal_deferred)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(transactionId,`review:${row.id}`,amount,type,counterpart.key || counterpart.accountName,event.evidence || event.utterance || 'بررسی حسابدار','text',event.accountId,event.accountId,event.counterpartyId || null,event.occurredAt,capitalFlow,'confirmed');
        database.prepare('UPDATE financial_events SET journal_source=? WHERE id=?').run(JSON.stringify({type:'transaction',id:transactionId}),row.id);
      }
    } else if (source?.type==='transaction') {
      database.prepare("UPDATE transactions SET status='deleted',journal_deferred=0,updated_at=? WHERE id=?").run(new Date().toISOString(),source.id);
    }
    const item = postReviewedComposite(database,row.id,{lines:final.lines,reason:`تأیید حسابدار: ${proposal.summary}`,actor,timeZone:currentTimeZone(),accountantProposal:true,eventOverride:event});
    const cheque = final.lines.find(l=>['cheque-receivable','cheque-payable'].includes(l.role));
    if (cheque) attachReviewedCheque({eventId:row.id,event,line:cheque,journalEntryId:item.journalEntryId,against:final.lines.some(l=>['receivable','payable'].includes(l.role))?'receivable':'income'});
    database.prepare('UPDATE accounting_review_ai SET proposal=? WHERE id=?').run(JSON.stringify({...proposal,lines:final.lines,finalJournalEntryId:item.journalEntryId}),proposal.id);
    recordReviewFeedback(database,row.id,proposal.id,{state:'accepted',reason:proposal.explanation,actor});
    addReviewMessage(database,row.id,'accepted',`سند ${item.journalEntryId} — ${proposal.summary}`,actor);
    database.exec('COMMIT');
    audit('accept-ai-proposal','financial-event',row.id,{proposalId:proposal.id,journalEntryId:item.journalEntryId,dnaEvidence:proposal.dnaEvidence?.map(d=>d.id) || []});
    return {item};
  } catch(error) {database.exec('ROLLBACK');throw error;}
}
