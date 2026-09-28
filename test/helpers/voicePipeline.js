import { extractAmounts, hasCompositeAmounts, parseFinancialText } from '../../shared/parser.js';
import { detectVoiceIntent, intentToFinancialEvent } from '../../shared/voiceIntent.js';
import { detectSettleIntent } from '../../shared/settleSpeech.js';
import { factsFromEvent } from '../../shared/eventFacts.js';
import { planJournal } from '../../shared/accountingRules.js';
import { DECISION_STATUS } from '../../shared/accountingDecision.js';
import { ROUTES } from '../../shared/confidenceEngine.js';
import { GUARD_VERDICTS, guardedPlan, runGuards } from '../../shared/guards.js';
import { transactionEventDecision } from '../../server/transactionEvent.js';
import { natureNeedsAccountant, readEventNature, readNonCashInstrument, readExplicitNonCash } from '../../shared/eventNature.js';

/**
 * یک گفتهٔ صوتی، از همان راهی که برنامه می‌رود — بدون دیتابیس.
 *
 * ترتیب همان `routeIntent` در `src/App.jsx` است: اول تسویه، بعد نیت‌های
 * ساختاری (فاکتور، سرمایه، دارایی، چک، طلب و بدهی)، و اگر هیچ‌کدام نبود پارسر
 * و موتور تصمیم با فلگ روشن.
 *
 * خروجی برای هر ردیف یکی از چهار حالت است:
 *
 *   post        سند ساخته می‌شود (خودکار یا با یک «تأیید» ساده)؛ `plan` همان سند است
 *   ask         پیش از هر سندی یک سؤال پرسیده می‌شود؛ `fact` موضوع سؤال است
 *   accountant  به صف حسابدار می‌رود و صاحب کسب‌وکار نمی‌تواند تأییدش کند
 *   draft       پیش‌نویسی ساخته می‌شود که هیچ سندی در دفتر نمی‌زند
 *
 * معیار آزمون استرس همین است: «post» فقط وقتی مجاز است که سندش درست باشد.
 */
export function runVoice(text, {
  today = '2026-09-23T00:00:00.000Z', vat = { ratesBps: [1000], rateBps: 1000, outputTax: 0 },
  openDocuments = undefined, counterpartyBalance = null,
} = {}) {
  const now = new Date(today);
  // routeIntent در برنامه پیش از تسویه و نیت‌های ساختاری همین کنترل را اجرا
  // می‌کند. یک گفتهٔ جمع و اجزا، یک پرونده است و هیچ ردیف نقدی نمی‌سازد.
  if (hasCompositeAmounts(text)) {
    const amounts = extractAmounts(text).spans.map((span) => span.amount).filter((amount) => Number.isSafeInteger(amount) && amount > 0);
    return { path: 'composite-review', items: [{ outcome: 'accountant', amount: Math.max(...amounts), amountReferenceOnly: true, noCashRow: true }] };
  }
  const settle = detectSettleIntent(text, { now });
  if (settle) {
    // کارت تسویه سند را از کاربر می‌پرسد؛ هیچ سندی خودکار بسته نمی‌شود.
    return { path: settle.bounced ? 'bounce' : 'settle', items: [{ outcome: 'ask', fact: settle.bounced ? 'bounce' : 'settlement-target', amount: settle.amount }] };
  }

  const intent = detectVoiceIntent(text, { now });
  if (intent) {
    if (intent.intent === 'invoice') {
      return { path: 'invoice', items: [{ outcome: intent.issueNow ? 'post' : 'draft', amount: intent.amount, documentType: intent.documentType }] };
    }
    if (intent.intent === 'cheque') {
      // کارت چک پیش از ثبت می‌پرسد «بابت معاملهٔ تازه یا طلب/بدهی قبلی؟» و
      // پیش‌فرضی ندارد.
      return { path: 'cheque', items: [{ outcome: 'ask', fact: 'chequeAgainst', amount: intent.amount, direction: intent.direction }] };
    }
    const event = intentToFinancialEvent(intent, { now });
    if (intent.intent === 'obligation' && !intent.direction) {
      return { path: 'obligation', items: [{ outcome: 'ask', fact: 'direction', amount: intent.amount }] };
    }
    return {
      path: intent.intent,
      items: [{ outcome: event ? 'post' : 'ask', amount: intent.amount, direction: intent.direction, plan: event ? planJournal(event) : null, event }],
    };
  }

  const items = parseFinancialText(text, { source: 'voice', now }).transactions || [];
  // همان کاری که `insertTransactionRows` می‌کند: اصلاح ثبت قبلی و چکِ وصول‌نشده
  // ردیف نقدی نمی‌سازند و مستقیم به صف حسابدار می‌روند.
  const queued = natureNeedsAccountant(readEventNature(text)) ? 'correction' : readNonCashInstrument(text) ? 'non-cash-instrument' : readExplicitNonCash(text) ? 'explicit-non-cash' : null;
  if (queued) {
    if (queued === 'correction' && items.length > 1) {
      const corrected = /مبلغ\s+درست|صحیح|باید/.test(text) ? items.at(-1) : items[0];
      return { path: 'queued', items: [{ outcome: 'accountant', amount: corrected.amount, kind: corrected.type, noCashRow: true, reason: queued, singleCase: true }] };
    }
    return { path: 'queued', items: items.map((item) => ({ outcome: 'accountant', amount: item.amount, kind: item.type, noCashRow: true, reason: queued })) };
  }
  return {
    path: 'transaction',
    items: items.map((item) => {
      const draft = transactionEventDecision({
        ...item, accountId: item.accountId || 'cash', occurredAt: item.occurredAt || today, source: 'voice',
      }, { transcript: text, sentence: items.length === 1 ? text : '', policy: { engineV2: true }, counterpartyBalance });
      const { event, decision: routing, accountingDecision: decision } = draft;
      const guards = runGuards(event, factsFromEvent(event), { decision, vat, openDocuments });
      const base = { amount: event.amount, kind: event.kind, category: event.category, decision, routing, guards };
      if (guards.verdict === GUARD_VERDICTS.BLOCK) return { ...base, outcome: 'accountant', reason: guards.reason };
      if (decision.decisionStatus === DECISION_STATUS.NEEDS_USER_INPUT) {
        return { ...base, outcome: 'ask', fact: decision.question?.fact || decision.missingFacts?.[0] };
      }
      if (routing.route === ROUTES.ACCOUNTANT_REVIEW) return { ...base, outcome: 'accountant', reason: routing.reasons?.[0] || decision.explanation };
      return { ...base, outcome: 'post', plan: guardedPlan(event, decision, guards) };
    }),
  };
}

/** نقشهٔ سند به شکل خوانا: «Dr prepaid-asset 12000000 / Cr cash 12000000». */
export function describePlan(plan) {
  if (!plan?.lines) return '';
  return plan.lines.map((line) => `${line.debit ? 'Dr' : 'Cr'} ${line.role} ${line.debit || line.credit}`).join(' / ');
}
