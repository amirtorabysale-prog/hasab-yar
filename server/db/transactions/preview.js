// پیش‌نمایش سند پیش از ثبت.
//
// از server/db/transactions.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// transactions همه از همان server/db/transactions.js می‌خوانند.

import { runGuards, GUARD_VERDICTS } from '../../../shared/guards.js';
import { accountForBank, resolveAccountId } from '../accounts.js';
import { currentTimeZone, db, invalidInput } from '../core.js';
import { assertAccountingPeriodOpen, periodForDate } from '../../accounting.js';
import { automationPolicy } from '../settings.js';
import { hasCompositeAmounts } from '../../../shared/parser.js';
import { openDocumentsFor } from '../counterpartyCard.js';
import { transactionEventDecision } from '../../transactionEvent.js';
import { vatGuardContext } from '../../tax.js';
import { readExplicitNonCash, readMixedSettlement, MIXED_SETTLEMENT_REASON } from '../../../shared/eventNature.js';
import { planJournal } from '../../../shared/accountingRules.js';
import { factsFromEvent } from '../../../shared/eventFacts.js';
import { ROUTES } from '../../../shared/confidenceEngine.js';
import { recognitionPreview, servicePeriodPreview } from '../../../shared/recognitionPreview.js';
import { settlementFor } from './rows.js';
import { correctionNature, nonCashInstrument } from './sentenceChecks.js';

/** Read-only advisory preflight. Posting always recomputes against current state. */
function safePlanLines(event, decision) {
  try { return planJournal(event, decision).lines || []; } catch { return []; }
}

export function previewTransactions({ transcript = '', transactions } = {}) {
  if (!Array.isArray(transactions) || !transactions.length || transactions.length > 20) throw invalidInput('حداقل یک تراکنش معتبر لازم است.');
  const policy = automationPolicy();
  return transactions.map((item) => {
    const text = transcript || item.rawText || '';
    // جزئی از یک گفتهٔ فهمیده‌شده: جملهٔ کامل عمداً مرکب است و همین الگوها
    // آن را به حسابدار می‌فرستادند. ماهیت هر جزء را فهم ساختاریافته روشن کرده.
    const structured = item.factSource === 'understanding';
    if (!structured && readMixedSettlement(text)) return { route: ROUTES.ACCOUNTANT_REVIEW, reasons: [MIXED_SETTLEMENT_REASON] };
    if (!structured && (hasCompositeAmounts(text) || correctionNature(item, text) || nonCashInstrument(item, text) || readExplicitNonCash(text))) {
      return { route: ROUTES.ACCOUNTANT_REVIEW, reasons: ['این رویداد ثبت نقدی ساده نیست؛ برای تعیین سند به بررسی حسابداری نیاز دارد.'] };
    }
    if (item.bankId && !item.accountId && !item.account && !accountForBank(item.bankId)) {
      return { route: ROUTES.CONFIRM, reasons: ['حساب بانک گفته‌شده مشخص نیست؛ حساب را انتخاب کن.'] };
    }
    const accountId = resolveAccountId(item);
    assertAccountingPeriodOpen(db, periodForDate(item.occurredAt || new Date().toISOString(), currentTimeZone()));
    // No name matching that could create a contact as a side effect.
    const contact = item.linkContact === false ? null : item.contactId
      ? db.prepare('SELECT id,name FROM contacts WHERE id=?').get(item.contactId)
      : item.contactName ? db.prepare('SELECT id,name FROM contacts WHERE name=?').get(item.contactName) : null;
    const row = { ...item, accountId, contactId: contact?.id || null, occurredAt: item.occurredAt || new Date().toISOString() };
    const settlement = settlementFor(row);
    const draft = transactionEventDecision({ ...row, contactName: contact?.name || item.contactName || '' }, {
      transcript, sentence: transactions.length === 1 ? transcript : '', policy, counterpartyBalance: settlement?.balance ?? null,
    });
    if (!draft) return { route: ROUTES.ACCOUNTANT_REVIEW, reasons: ['ماهیت قابل تشخیص نیست.'] };
    const decision = policy.shadowMode ? null : draft.accountingDecision;
    const guards = decision ? runGuards(draft.event, factsFromEvent(draft.event), {
      decision, openDocuments: contact ? openDocumentsFor(contact.id) : undefined, vat: vatGuardContext(db),
    }) : null;
    const blocked = guards?.verdict === GUARD_VERDICTS.BLOCK;
    return { route: blocked ? ROUTES.ACCOUNTANT_REVIEW : draft.decision.route,
      reasons: [...(draft.decision.reasons || []), ...(blocked ? [guards.reason] : [])],
      question: decision?.question || null, eventKind: draft.event.kind,
      decisionStatus: decision?.decisionStatus || null, accountId, contactId: contact?.id || null,
      // سطرهای پیشنهادی فقط برای نمایش؛ ثبت واقعی همان مسیر همیشگی است.
      lines: decision?.decisionStatus === 'decided' ? safePlanLines(draft.event, decision) : [],
      treatment: decision?.treatment || null, family: decision?.family || null,
      // دوره و برنامهٔ ماهانه‌ای که ثبت خواهد ساخت؛ برگهٔ تأیید بدون آن فقط سطر اول را نشان می‌داد.
      recognition: recognitionPreview(draft.event, decision), servicePeriod: servicePeriodPreview(draft.event),
    };
  });
}
