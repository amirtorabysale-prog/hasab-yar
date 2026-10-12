import { postReviewPriorBasis } from '../reviewPriorBasis.js';
import { roleAllows } from '../access.js';
import { allocateTaxRefund } from '../reviewTaxRefund.js';
import { allocateInsuranceSettlement, releaseInsuranceSettlement } from '../reviewInsurance.js';
import { assertHoldHasNoResolutions } from '../unidentifiedReceipts.js';
import { reviewNature, reviewNatureViolations } from '../../shared/reviewNature.js';
import { prepareReviewResources, applyReviewInventory, reverseReviewInventory } from '../reviewResources.js';
import { randomUUID } from 'node:crypto';
import { prepareReviewProposal, reviewConversation, reviewedEvent, originalReviewTranscript, relevantDna, proposalRevision, addReviewMessage, reviewContext } from '../reviewAssistant.js';
import { attachReviewedCheque } from './cheques.js';
import { listUnquantifiedReviews } from './reviewIntakes.js';
import { activeWorkspaceDatabase, audit, currentTimeZone, currentWorkspace, db, controlDb } from './core.js';
import { answerEventQuestion, approveFinancialEvent, coverageQuestion, decisionForEvent, financialEventAudit, handOverToAccountant, listBlockedRecognition, listHeldRecognition, listReviewQueue, scheduleTimingBalance, unscheduledTimingBalances, postBlockedRecognitionCatchUp, recordFinancialEvent, rejectFinancialEvent, reverseFinancialEvent, reviewTimingCoverage, scheduleForEvent, postDueRecognitionItems, postReviewedComposite } from '../financialEventStore.js';
import { isReviewSupplierAdvance } from '../../shared/reviewSupplierAdvance.js';
import { treatmentHasPlan } from '../../shared/accountingRules.js';
import { saveFixedAssetSettings } from '../depreciationLedger.js';
import { todayPersian } from '../../shared/persianDate.js';
import { contactIdForName } from './contacts.js';
import { describeEvent, normalizeFinancialEvent } from '../../shared/financialEvent.js';
import { settlementFor, transactionJournalPoster } from './transactions.js';
import { automationPolicy } from './settings.js';
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
    return {...item,originalTranscript:originalReviewTranscript(database,row),aiProposal:item.route==='accountant-review'?preparedProposal(database,item.id):null,dnaMatches:item.route==='accountant-review'?relevantDna(database,row).map(d=>({...d,actorName:actorName(d.actor)})):[]};
  })];
  const counts=database.prepare("SELECT state,COUNT(*) count FROM accounting_review_ai WHERE state!='proposed' GROUP BY state").all();
  // اقلام شناسایی رویدادهای ثبت‌شده که دورهٔ بسته جلویشان را گرفته؛ رویداد ثبت‌شده
  // در صف بالا نیست و بدون این، ماندهٔ دارایی یا بدهی‌اش بی‌صدا می‌ماند.
  const blockedRecognition=listBlockedRecognition(database,{timeZone:currentTimeZone()});
  // اقلامی که ماندهٔ حساب دوره‌دارشان کمتر از قلم بود (استرداد بیرون از برنامه).
  const heldRecognition=listHeldRecognition(database);
  // ماندهٔ پیش‌پرداخت یا درآمد انتقالی بی‌برنامه (افتتاحیه، سند دستی، سند اصلاحی):
  // سؤال دوره برای حسابدار، نه دارایی یا بدهی ابدی.
  const unscheduledBalances=unscheduledTimingBalances(database);
  return {items,blockedRecognition,heldRecognition,unscheduledBalances,dnaSummary:{accepted:counts.find(c=>c.state==='accepted')?.count || 0,rejected:counts.find(c=>c.state==='rejected')?.count || 0,messages:database.prepare("SELECT COUNT(*) count FROM accounting_review_messages WHERE speaker='accountant'").get().count}};
}

function actorName(id) {return id ? controlDb.prepare('SELECT display_name,username FROM users WHERE id=?').get(id)?.display_name || controlDb.prepare('SELECT username FROM users WHERE id=?').get(id)?.username || id : null;}
function labelHistory(proposal) {return proposal ? {...proposal,conversation:proposal.conversation?.map(m=>({...m,actorName:actorName(m.actor)})),dnaEvidence:proposal.dnaEvidence?.map(d=>({...d,actorName:actorName(d.actor)}))} : null;}
function preparedProposal(database,eventId,proposal = latestReviewProposal(database,eventId)) {
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(eventId);
  return proposal && row ? labelHistory(withTimingCoverage(database,row,prepareReviewProposal(database,row,proposal))) : null;
}

/**
 * سطر پیش‌پرداخت خدمت یا درآمد انتقالی بدون دورهٔ پوشش، پیش از «قبول» مانع است.
 *
 * چنین سطری دارایی یا بدهی دوره‌دار می‌سازد که بدون برنامه هرگز هزینه یا درآمد
 * نمی‌شود. ثبت نهایی (`postReviewedComposite`) آن را رد می‌کند؛ اینجا همان مانع
 * پیش از کلیک دیده می‌شود تا حسابدار دوره را بگوید — در گفت‌وگو یا با کارت
 * سؤال — نه اینکه با خطای لحظهٔ ثبت روبه‌رو شود. پیش‌پرداخت خرید کالا دوره
 * ندارد و بیرون است.
 */
function withTimingCoverage(database,row,prepared) {
  if(!prepared?.lines?.length) return prepared;
  const evidence=originalReviewTranscript(database,row);
  const supplierAdvance=isReviewSupplierAdvance([evidence,...reviewConversation(database,row.id).filter(m=>m.speaker==='accountant').map(m=>m.body)].join(' '),prepared.lines);
  const kind=prepared.lines.some(l=>l.role==='deferred-revenue' && l.credit>0) ? 'deferred'
    : !supplierAdvance && prepared.lines.some(l=>l.role==='prepaid-asset' && l.debit>0) ? 'prepaid' : null;
  if(!kind) return prepared;
  const event=reviewedEvent(database,row);
  const coverage=reviewTimingCoverage(database,row.id,{...event,evidence:event.evidence || evidence});
  if(coverage.start && coverage.end) return {...prepared,coverage};
  const text=coverageQuestion(kind);
  return {...prepared,postingBlockers:[...new Set([...(prepared.postingBlockers || []),text])],canPost:false};
}
export function reviewAssistantHistory(eventId) {
  const database = activeWorkspaceDatabase();
  if (!database.prepare('SELECT id FROM financial_events WHERE id=?').get(eventId)) throw Object.assign(new Error('پرونده پیدا نشد.'),{status:404});
  const row=database.prepare('SELECT * FROM financial_events WHERE id=?').get(eventId);
  const known=reviewedEvent(database,row);
  return { messages:reviewConversation(database,eventId).map(m=>({...m,actorName:actorName(m.actor)})),proposal:preparedProposal(database,eventId),context:{...reviewContext(database,eventId).facts,occurredAt:known.occurredAt?.slice(0,10),dueAt:known.dueAt?.slice(0,10),counterpartyId:known.counterpartyId,accountId:known.accountId} };
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
    const prepared=withTimingCoverage(database,row,prepareReviewProposal(database,row,proposal));
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
export function recordReviewedComposite(eventId, { lines, reason, proposalId = '', aiAccepted = false, contractEventId = null, contractEnded = null } = {}) {
  const database = activeWorkspaceDatabase();
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(eventId);
  if (!row || row.status !== 'pending') throw Object.assign(new Error('این مورد دیگر در انتظار نیست.'), { code: 'EVENT_NOT_PENDING', status: 409 });
  const proposal = latestReviewProposal(database, eventId);
  // بستانکار کردن حساب طلب مالیاتی فقط از مسیر «اعمال پیشنهاد» که تخصیص وصول
  // را هم ثبت می‌کند. سند دستیِ بدون تخصیص، همان طلب را برای وصول دوم باز
  // می‌گذارد و وصول‌های بعدیِ همان حساب را متوقف می‌کند.
  const creditsTaxClaim=(lines || []).some(line=>line.credit>0 && database.prepare(`SELECT 1 FROM ledger_accounts a LEFT JOIN chart_accounts c ON c.id=a.chart_account_id
    WHERE a.id=? AND (a.source_kind='tax-receivable' OR c.role='tax-receivable')`).get(line.accountId));
  if(creditsTaxClaim) throw Object.assign(new Error('وصول طلب مالیاتی را با «تحلیل کن» و دکمهٔ اعمال پیشنهاد ثبت کن تا به سند مبنا وصل شود.'),{code:'REVIEW_NATURE_REQUIRED',status:409});
  // همین برای بیمهٔ لیست حقوق: سند دستی لیست را «پرداخت‌شده» نمی‌کند و دکمهٔ
  // پرداخت صفحهٔ حقوق همان بیمه را دوباره می‌پردازد.
  const debitsPayrollInsurance=(lines || []).some(line=>line.debit>0 && database.prepare("SELECT 1 FROM ledger_accounts WHERE id=? AND source_kind='payroll-insurance-payable'").get(line.accountId));
  // وجه ناشناس فقط از «تعیین تکلیف» بسته می‌شود؛ سند دستی ردی از منشأ و
  // فاکتور تسویه‌شده نمی‌گذارد.
  const debitsUnidentified=(lines || []).some(line=>line.debit>0 && database.prepare("SELECT 1 FROM ledger_accounts WHERE id=? AND source_kind='unidentified-receipt'").get(line.accountId));
  if(debitsUnidentified) throw Object.assign(new Error('وجه ناشناس را از بخش «وجوه ناشناس» صف حسابدار تعیین تکلیف کن.'),{code:'REVIEW_NATURE_REQUIRED',status:409});
  if(debitsPayrollInsurance) throw Object.assign(new Error('پرداخت بیمهٔ لیست حقوق را با «تحلیل کن» و دکمهٔ اعمال پیشنهاد یا از صفحهٔ «حقوق» ثبت کن تا لیست پرداخت‌شده علامت بخورد.'),{code:'REVIEW_NATURE_REQUIRED',status:409});
  if (proposal?.state === 'proposed') {
    if (!proposalId || proposal.id !== proposalId || !proposalIsCurrent(proposal, row) || (proposal.contextRevision || 0) !== proposalRevision(database,eventId)) throw Object.assign(new Error('پیشنهاد AI تغییر کرده است؛ صف را تازه‌سازی کن.'), { code: 'AI_PROPOSAL_STALE', status: 409 });
    if (aiAccepted && (proposal.missingFacts.length || !proposal.lines || proposal.lines.length !== lines?.length || proposal.lines.some((line, index) => line.debit !== lines[index].debit || line.credit !== lines[index].credit))) {
      throw Object.assign(new Error('مبالغ سند با پیشنهاد AI برابر نیست؛ اصلاح را با دلیل ثبت کن.'), { code: 'AI_PLAN_REVISION_REQUIRED', status: 409 });
    }
    if(aiAccepted) {
      if(reviewNature(originalReviewTranscript(database,row)).vatRefund) throw Object.assign(new Error('استرداد مالیات را با دکمه اعمال پیشنهاد ثبت کن تا سند طلب و تخصیص وصول هم ثبت شوند.'),{code:'REVIEW_NATURE_REQUIRED',status:409});
      const actualRoles=(lines || []).map(line=>{const a=database.prepare('SELECT type,source_kind,source_key FROM ledger_accounts WHERE id=?').get(line.accountId);return {...line,role:a?.source_kind==='operational-account'?'cash':a?.type==='income'?'income-category':a?.type==='expense'?'expense-category':a?.source_kind==='system' && a?.source_key==='owner-capital'?'owner-capital':a?.source_kind};});
      const issues=reviewNatureViolations(originalReviewTranscript(database,row),actualRoles,reviewedEvent(database,row));
      if(issues.length) throw Object.assign(new Error(issues.map(q=>q.text).join(' ')),{code:'REVIEW_NATURE_REQUIRED',status:409});
    }
    if (!aiAccepted && String(reason || '').trim().length < 8) throw Object.assign(new Error('دلیل اصلاح پیشنهاد AI را بنویس.'), { code: 'AI_REASON_REQUIRED', status: 400 });
  } else if (proposalId || aiAccepted) {
    throw Object.assign(new Error('پیشنهاد AI معتبر برای این مورد وجود ندارد.'), { code: 'AI_PROPOSAL_STALE', status: 409 });
  }
  const actor = currentWorkspace()?.userId || null;
  database.exec('BEGIN IMMEDIATE');
  try {
    // استرداد قرارداد: حسابدار از میان نامزدهای سؤال `contract.reference` یکی را
    // انتخاب می‌کند و پایان یا ادامهٔ قرارداد را می‌گوید.
    const item = postReviewedComposite(database, eventId, { lines, reason, actor, timeZone: currentTimeZone(),
      contractEventId: contractEventId ? String(contractEventId) : null, contractEnded: typeof contractEnded === 'boolean' ? contractEnded : null });
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
    const posted=database.prepare('SELECT journal_entry_id FROM financial_events WHERE id=?').get(eventId);
    if(posted?.journal_entry_id) assertHoldHasNoResolutions(database,posted.journal_entry_id);
    reverseReviewInventory(database,eventId,{actor:currentWorkspace()?.userId,timeZone:currentTimeZone()});
    const item=reverseFinancialEvent(database,eventId,{actor:currentWorkspace()?.userId || null,reason,timeZone:currentTimeZone(),withinTransaction:true});
    releaseInsuranceSettlement(database,eventId);
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
    // همان حدی که در لحظهٔ ثبت خوانده شد؛ بدون آن، جواب «استفادهٔ بلندمدت»
    // پرینتر هشت میلیونی را دارایی ثابت می‌کرد.
    capitalizationThreshold: automationPolicy().capitalizationThreshold,
    guardContext: { vat: vatGuardContext(database), openDocuments: contactId ? openDocumentsFor(contactId) : undefined },
  });
  audit('answer', 'financial-event', eventId, { fact, value, status: item.decision?.decisionStatus });
  return item;
}

/**
 * اجرای اقلام شناسایی سررسیدرسیده.
 *
 * کار دقیقه‌ای سرور (`runRecurringJob`) هر دفتر را با همین اجرا می‌کند و بستن
 * دوره هم پیش از قفل صدایش می‌زند؛ مسیر HTTP برای اجرای دستی حسابدار می‌ماند.
 * حدس نیست: هر رویداد هنگام ثبت یا تأیید دیده شده، فقط قلمِ سررسیدرسیدهٔ رویداد
 * ثبت‌شده سند می‌خورد، تکرار اجرا سند دوم نمی‌سازد و دورهٔ بسته باز نمی‌شود.
 */
export function runRecognition() {
  const database = activeWorkspaceDatabase();
  const result = postDueRecognitionItems(database, {
    actor: currentWorkspace()?.userId || null, timeZone: currentTimeZone(),
  });
  if (result.posted) audit('recognize', 'recognition-schedule', 'due', result);
  // هر اجرا ماندهٔ دوره‌دارِ بی‌برنامه را هم می‌شمارد تا کسی که دکمه را زده
  // بداند چیزی بیرون از برنامه مانده است.
  const unscheduled = unscheduledTimingBalances(database).length;
  return unscheduled ? { ...result, unscheduled } : result;
}

/** ماندهٔ پیش‌پرداخت و درآمد انتقالی که برنامهٔ شناسایی ندارد. */
export function unscheduledBalances() {
  return { items: unscheduledTimingBalances(activeWorkspaceDatabase()) };
}

/**
 * جواب حسابدار به ماندهٔ بی‌برنامه: دورهٔ پوشش، دسته و (برای حساب کلی) مبلغ.
 * سندی نمی‌زند؛ فقط برنامهٔ همان مانده را می‌سازد.
 */
export function scheduleBalance(accountId, input = {}) {
  const result = scheduleTimingBalance(activeWorkspaceDatabase(), accountId, {
    amount: input.amount ?? null, start: input.start || null, end: input.end || null, coverageText: String(input.coverageText || '').slice(0, 300),
    category: String(input.category || '').slice(0, 120), counterparty: String(input.counterparty || '').slice(0, 120), counterpartyId: input.counterpartyId || null,
    entryId: input.entryId || null, reason: String(input.reason || '').slice(0, 500),
    actor: currentWorkspace()?.userId || null, timeZone: currentTimeZone(),
  });
  audit('schedule-balance', 'ledger-account', String(accountId), { eventId: result.eventId, amount: result.amount, coverage: result.coverage });
  return result;
}

/** همان فهرست، فقط برای حساب‌هایی که یک سند لمس کرده — پاسخ تأیید سند دستی. */
export function unscheduledBalancesForEntry(entryId) {
  const database = activeWorkspaceDatabase();
  const touched = new Set(database.prepare('SELECT account_id AS id FROM journal_lines WHERE entry_id=?').all(String(entryId || '')).map((row) => row.id));
  return unscheduledTimingBalances(database).filter((item) => touched.has(item.accountId));
}

/** اقلام شناسایی‌ای که دورهٔ بسته جلویشان را گرفته (تصمیم ۳ فاز صفر). */
export function blockedRecognition() {
  return { items: listBlockedRecognition(activeWorkspaceDatabase(), { timeZone: currentTimeZone() }) };
}

/**
 * ثبت جبرانی یک قلمِ منتظرِ دورهٔ بسته، با دلیل حسابدار.
 *
 * جابه‌جایی بی‌صدا نیست: حسابدار دلیلش را می‌نویسد و سند در نخستین دورهٔ باز
 * می‌نشیند؛ ردپا دورهٔ اصلی و دورهٔ ثبت را هر دو نگه می‌دارد.
 */
export function catchUpRecognition(key, reason = '') {
  const item = postBlockedRecognitionCatchUp(activeWorkspaceDatabase(), key, {
    reason, actor: currentWorkspace()?.userId || null, timeZone: currentTimeZone(),
  });
  audit('recognition-catch-up', 'recognition-schedule', item.key, { eventId: item.eventId, period: item.period, reason: String(reason).slice(0, 200) });
  return { item };
}

/** تصمیم و برنامهٔ شناسایی یک رویداد — برای صف بررسی. */
export function eventDecision(eventId) {
  const database = activeWorkspaceDatabase();
  return { decision: decisionForEvent(database, eventId), schedule: scheduleForEvent(database, eventId) };
}

/** تمام اثرهای دفتر، ردیف نقدی و چک در یک تراکنش؛ پیشنهاد، مجوزِ دور زدن اعتبار حساب/دوره نیست. */
function acceptPreparedProposal(database,row,proposal,actor) {
  const prepared = withTimingCoverage(database,row,prepareReviewProposal(database,row,proposal));
  if (!prepared.canPost) throw Object.assign(new Error(prepared.postingBlockers.join(' — ') || 'پیشنهاد هنوز قطعی نیست.'), {code:'REVIEW_DETAILS_REQUIRED',status:409});
  database.exec('BEGIN IMMEDIATE');
  try {
    const fresh = database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id);
    if (fresh.status !== 'pending' || !proposalIsCurrent(proposal,fresh) || (proposal.contextRevision || 0) !== proposalRevision(database,row.id)) throw Object.assign(new Error('این پرونده هم‌زمان تغییر کرده است؛ دوباره بررسی کن.'),{code:'AI_PROPOSAL_STALE',status:409});
    const initial=reviewedEvent(database,fresh);
    const resources=prepareReviewResources(database,initial,proposal,{evidence:originalReviewTranscript(database,fresh),facts:prepared.context,messages:reviewConversation(database,row.id),apply:true});
    if(resources.blockers.length) throw Object.assign(new Error(resources.blockers.join(' — ')),{code:'REVIEW_DETAILS_REQUIRED',status:409});
    const resolvedEvent={...resources.event,reviewInventoryItems:resources.inventoryItems};
    const final = prepareReviewProposal(database,fresh,proposal,{resolve:true,eventOverride:resolvedEvent});
    if (!final.canPost) throw Object.assign(new Error(final.postingBlockers.join(' — ')),{code:'REVIEW_DETAILS_REQUIRED',status:409});
    const event = resolvedEvent;
    const cash = final.lines.find(l=>l.role==='cash');
    const counterpart = final.lines.find(l=>l.role!=='cash');
    const source = fresh.journal_source ? JSON.parse(fresh.journal_source) : null;
    if (cash) {
      const ledger = database.prepare('SELECT source_kind,source_key FROM ledger_accounts WHERE id=?').get(cash.accountId);
      if (ledger?.source_kind!=='operational-account' || ledger.source_key!==event.accountId) throw Object.assign(new Error('حساب نقدی پیشنهاد با بانک انتخاب‌شده برابر نیست.'),{code:'REVIEW_ACCOUNT_MISMATCH',status:409});
      const amount = cash.debit || cash.credit, type = cash.debit ? 'income' : 'expense';
      // سرمایه در هر دو جهت: پولی که آمده آورده است، پولی که رفته برداشت مالک.
      const capitalFlow = counterpart.role==='fixed-asset' ? 'fixed-asset' : counterpart.role==='owner-capital' && cash.debit ? 'capital-in' : '';
      const drawing = ['owner-capital','owner-drawing'].includes(counterpart.role) && cash.credit;
      const transactionId = source?.type==='transaction' ? source.id : randomUUID();
      if (source?.type==='transaction') {
        const changed = database.prepare(`UPDATE transactions SET amount=?,type=?,category=?,account_id=?,account=?,contact_id=?,occurred_at=?,capital_flow=?,journal_deferred=0,review_state='ready',needs_review=0,updated_at=? WHERE id=? AND status!='deleted'`).run(amount,type,counterpart.accountName || counterpart.key,event.accountId,event.accountId,event.counterpartyId || null,event.occurredAt,capitalFlow,new Date().toISOString(),transactionId).changes;
        if (!changed) throw Object.assign(new Error('تراکنش مبنا دیگر فعال نیست.'),{code:'EVENT_NOT_REVIEWABLE',status:409});
      } else {
        database.prepare(`INSERT INTO transactions(id,client_id,amount,type,category,raw_text,source,account_id,account,contact_id,occurred_at,capital_flow,status,journal_deferred)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(transactionId,`review:${row.id}`,amount,type,counterpart.accountName || counterpart.key,event.evidence || event.utterance || 'بررسی حسابدار','text',event.accountId,event.accountId,event.counterpartyId || null,event.occurredAt,capitalFlow,'confirmed');
        database.prepare('UPDATE financial_events SET journal_source=? WHERE id=?').run(JSON.stringify({type:'transaction',id:transactionId}),row.id);
      }
      database.prepare('UPDATE transactions SET accounting_role=? WHERE id=?').run(
        drawing ? 'owner-drawing' : ['payable','receivable','tax-receivable','payroll-insurance-payable','partner-payable','partner-receivable','unidentified-receipt','prepaid-asset','refundable-deposit','loan-payable','customer-advance','deferred-revenue','supplier-advance','inventory-unsplit'].includes(counterpart.role) ? counterpart.role : '',transactionId);
    } else if (source?.type==='transaction') {
      database.prepare("UPDATE transactions SET status='deleted',journal_deferred=0,updated_at=? WHERE id=?").run(new Date().toISOString(),source.id);
    }
    const item = postReviewedComposite(database,row.id,{lines:final.lines,reason:`تأیید حسابدار: ${proposal.summary}`,actor,timeZone:currentTimeZone(),accountantProposal:true,eventOverride:event});
    allocateTaxRefund(database,row.id,item.journalEntryId,final.taxRefundClaim,row.amount);
    allocateInsuranceSettlement(database,row.id,item.journalEntryId,final.insuranceRun,row.amount,event.occurredAt);
    applyReviewInventory(database,row.id,event,resources.inventoryItems,{actor,timeZone:currentTimeZone()});
    // دارایی ثابت با عمر مفیدش به دفتر دارایی‌ها می‌رود، وگرنه هرگز مستهلک نمی‌شود.
    if (proposal.fixedAsset?.usefulLifeMonths) {
      const assetLine = final.lines.find(l=>l.role==='fixed-asset');
      const assetKey = assetLine?.accountId && database.prepare("SELECT source_key FROM ledger_accounts WHERE id=? AND source_kind='fixed-asset'").get(assetLine.accountId)?.source_key;
      const month = todayPersian(new Date(event.occurredAt));
      if (assetKey) saveFixedAssetSettings(database,{assetKey,usefulLifeMonths:proposal.fixedAsset.usefulLifeMonths,inServiceMonth:`${month.year}-${String(month.month).padStart(2,'0')}`});
    }
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

/** A separate, explicit import action; never an automatic remedy for insufficient debt. */
export function recordReviewPriorBasis(eventId,input={}) {
  const actor=currentWorkspace();
  if(!roleAllows(actor?.role,'manager')) throw Object.assign(new Error('ثبت مانده منتقل‌شده به تأیید مدیر دفتر نیاز دارد.'),{status:403,code:'FORBIDDEN'});
  const database=activeWorkspaceDatabase();
  database.exec('BEGIN IMMEDIATE');
  try {
    const row=database.prepare('SELECT * FROM financial_events WHERE id=?').get(eventId);
    if(!row) throw Object.assign(new Error('پرونده پیدا نشد.'),{status:404});
    const proposal=latestReviewProposal(database,eventId);
    if(!proposal || proposal.id!==input.proposalId || !proposalIsCurrent(proposal,row) || proposal.contextRevision!==proposalRevision(database,eventId)) throw Object.assign(new Error('پیشنهاد تغییر کرده؛ پیش از ثبت مبنا بازتحلیل کن.'),{status:409,code:'AI_PROPOSAL_STALE'});
    const event=reviewedEvent(database,row);
    const journal=postReviewPriorBasis(database,row,{...event,evidence:originalReviewTranscript(database,row)},proposal.lines,input,{actor:actor.userId,timeZone:currentTimeZone()});
    addReviewMessage(database,eventId,'basis-confirmed',`مانده منتقل‌شده با تأیید صریح مدیر ثبت شد: ${input.amount} تومان؛ تاریخ ${input.occurredAt}؛ مرجع ${input.reference}؛ سند ${journal.fiscalYear}/${journal.documentNumber}. پرداخت/وصول هنوز ثبت نشده است.`,actor.userId);
    audit('create','review-prior-basis',journal.id,{eventId,amount:input.amount,reference:input.reference});
    database.exec('COMMIT');return {journal};
  } catch(error) {database.exec('ROLLBACK');throw error;}
}
