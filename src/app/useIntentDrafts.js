// کارت‌های نیت ساختاری (انتقال، تنخواه، فاکتور، سرمایه، دارایی، چک، طلب و بدهی) و
// کارت تسویه: نگه‌داشتن پیش‌نویس و ثبتش وقتی کاربر تأیید کرد. هیچ‌چیز خودکار ذخیره نمی‌شود.
//
// از src/App.jsx جدا شد؛ متن توابع و effectها دست نخورده است. App این قلاب را در
// هر رندر با مقدارهای همان رندر صدا می‌زند، پس هر closure همان چیزی را می‌بیند که
// پیش‌تر درون App می‌دید.

import { useState } from 'react';
import { api } from '../lib/api.js';
import { capitalEntryPayload, invoiceDraftPayload } from '../../shared/voiceIntent.js';
import { formatAmount, unitLabel } from '../lib/format.js';
import { withCounterpartyConfirmation } from '../lib/counterpartyPrompt.js';

export function useIntentDrafts({ load, notify }) {
  const [intentDraft, setIntentDraft] = useState(null);
  const [settleDraft, setSettleDraft] = useState(null);

  const queueSettlementReview = async (draft) => {
    try {
      await api.queueUnmatchedSettlement({ transcript: draft.transcript, clientId: crypto.randomUUID() });
      setSettleDraft(null);
      notify('گفته به صف حسابدار رفت؛ سند یا تسویه‌ای انجام نشد.');
      await load();
    } catch (error) { notify(error.message); }
  };

  /** تسویهٔ سندی که کاربر روی کارت انتخاب کرده؛ هیچ سندی خودکار بسته نمی‌شود. */
  const applySettlement = async (target, { occurredAt = null, paidBy = null } = {}) => {
    try {
      if (target.kind === 'ledger-balance') {
        await api.settleLedgerBalance(target.contactId, { direction: target.direction, amount: target.paymentAmount, clientId: crypto.randomUUID(),
          ...(paidBy ? { paidBy } : {}), ...(occurredAt ? { occurredAt } : {}) });
        setSettleDraft(null);
        await load();
        notify(paidBy ? `${target.label} از حساب شخصی ${paidBy.name} تسویه شد؛ صندوق و بانک دست نخورد.` : `${target.label} تسویه شد.`);
        return;
      }
      if (paidBy) {
        {
          await api.settleObligation(target.id, { amount: target.paymentAmount, paidBy, ...(occurredAt ? { occurredAt } : {}) });
        }
        setSettleDraft(null);
        await load();
        notify(target.direction === 'receivable'
          ? `${target.label} به حساب شخصی ${paidBy.name} وصول شد؛ ${paidBy.name} همین مبلغ را به شرکت بدهکار شد.`
          : `${target.label} از پول شخصی ${paidBy.name} تسویه شد؛ از صندوق و بانک پولی کم نشد.`);
        return;
      }
      if (target.kind === 'invoice') {
        await api.recordInvoicePayment(target.id, { amount: target.paymentAmount, occurredAt: occurredAt || undefined });
      } else {
        await api.settleObligation(target.id, { amount: target.paymentAmount, ...(occurredAt ? { occurredAt } : {}) });
      }
      setSettleDraft(null);
      await load();
      notify(`${target.label} تسویه شد.`);
    } catch (error) { notify(error.message); }
  };

  const saveIntentDraft = async (draft) => {
    try {
      if (draft.intent === 'petty-fund') {
        const result = await api.fundPettyCashByVoice({ holderName: draft.holder, amount: draft.amount,
          fromAccountId: draft.fromAccountId, occurredAt: draft.occurredAt || undefined });
        setIntentDraft(null);
        await load();
        notify(result.action === 'opened'
          ? `تنخواهِ «${result.item.holderName}» با سقف ${formatAmount(result.item.ceiling)} ${unitLabel()} پرداخت شد؛ هزینه‌ای ثبت نشد.`
          : `تنخواهِ «${result.item.holderName}» شارژ شد؛ هزینه‌ای ثبت نشد.`);
        return;
      }
      if (draft.intent === 'transfer') {
        await api.transferBetweenAccounts({ fromAccountId: draft.fromAccountId, toAccountId: draft.toAccountId,
          amount: draft.amount, fee: draft.fee || 0, note: draft.transcript, occurredAt: draft.occurredAt || undefined });
        setIntentDraft(null);
        await load();
        notify(draft.fee > 0 ? 'انتقال ثبت شد و کارمزدش هزینهٔ کارمزد بانکی حساب مبدأ شد.' : 'انتقال بین حساب‌ها ثبت شد؛ درآمد یا هزینه‌ای ساخته نشد.');
        return;
      }
      if (draft.intent === 'invoice') {
        const payload = invoiceDraftPayload(draft, { taxRateId: draft.taxRateId || null });
        if (!payload) return;
        const { item } = await withCounterpartyConfirmation((counterpartyResolution) => api.saveInvoice({ ...payload, documentType: draft.documentType, customerName: draft.contactName || '', counterpartyResolution }));
        setIntentDraft(null);
        await load();
        // پیام دقیقاً می‌گوید سند در چه وضعیتی است. «ثبت شد» خالی، کاربر را به
        // این باور می‌رساند که فاکتور صادر شده درحالی‌که ممکن است پیش‌نویس باشد.
        // ردیف خدمتی که دوره‌اش گفته نشده صادر نمی‌شود (هزینه یا درآمد یک‌جا
        // حدس است)؛ پیش‌نویس می‌ماند و سؤالش همین‌جا گفته می‌شود.
        notify(item.pendingQuestion
          ? `پیش‌نویس ${item.number} ساخته شد ولی صادر نشد: ${item.pendingQuestion}`
          : payload.issueNow
            ? `فاکتور ${item.number} صادر شد؛ در دفتر کل سند خورد و در گزارش مالیاتی می‌آید.`
            : `پیش‌نویس ${item.number} ساخته شد؛ هر وقت خواستی از برگهٔ فاکتورها صادرش کن.`);
        return;
      }
      if (draft.intent === 'capital' || draft.intent === 'fixed-asset') {
        const payload = capitalEntryPayload(draft);
        if (!payload) return;
        await api.saveCapitalEntry({ ...payload, source: 'voice' });
        setIntentDraft(null);
        await load();
        notify(draft.intent === 'capital'
          ? 'آورده ثبت شد؛ در جمع درآمد ماه نمی‌آید و مستقیم به حساب سرمایه نشست.'
          : 'دارایی ثابت ثبت شد؛ هزینهٔ این ماه نشد و به بهای تمام‌شده در دارایی‌ها نشست.');
        return;
      }
      // چک صوتی همان مسیر فرم چک را می‌رود، با همان پرسش «بابت چه؟». تا امروز
      // به‌عنوان طلب یا بدهی عادی ذخیره می‌شد و همیشه درآمد یا هزینهٔ تازه
      // می‌ساخت — حتی وقتی چک بابت فاکتور قبلی بود.
      if (draft.intent === 'cheque') {
        const { item } = await withCounterpartyConfirmation((counterpartyResolution) => api.recordCheque({
          direction: draft.direction, counterpartyName: draft.contactName, amount: draft.amount,
          against: draft.against, dueAt: draft.dueAt || null, occurredAt: draft.occurredAt || null,
          note: draft.transcript.slice(0, 300), counterpartyResolution, source: 'voice',
          // سری چک («۱۲ تا چک ۱۰ میلیونی») با تعدادش می‌رود؛ سرور آن را یک چکِ
          // تک ثبت نمی‌کند.
          ...(draft.chequeCount > 1 ? { chequeCount: draft.chequeCount, perChequeAmount: draft.perChequeAmount || null } : {}),
        }));
        setIntentDraft(null);
        await load();
        notify(item.queuedForAccountant ? item.queuedReason
          : item.pendingQuestion ? `چک در دفتر چک‌ها ثبت شد؛ سندش منتظر یک جواب است: ${item.pendingQuestion}`
            : draft.against === 'receivable' ? 'چک ثبت شد؛ درآمد یا هزینهٔ تازه‌ای ساخته نشد.' : 'چک ثبت شد.');
        return;
      }
      // طرف حسابِ گفته‌شده همان مسیر فرم و کارت چک را می‌رود: مخاطب ساخته یا
      // پیدا می‌شود و تعهد به او وصل است. بی‌آن، بدهی «شرکت پارس» بی‌مخاطب
      // می‌ماند و کارت طرف حساب بعداً همان مبلغ را «بی‌پوشش» دوباره تسویه می‌کرد.
      const { item } = await withCounterpartyConfirmation((counterpartyResolution) => api.saveObligation({
        title: draft.title, amount: draft.amount, direction: draft.direction,
        dueAt: draft.dueAt || null, occurredAt: draft.occurredAt || null,
        note: draft.transcript.slice(0, 300), contactName: draft.contactName || '', counterpartyResolution,
      }));
      setIntentDraft(null);
      await load();
      notify(item?.journalStatus === 'pending'
        ? `${draft.direction === 'receivable' ? 'طلب' : 'بدهی'} ثبت شد؛ سندش منتظر یک جواب یا بررسی حسابدار است.`
        : draft.direction === 'receivable' ? 'طلب ثبت شد.' : 'بدهی ثبت شد.');
    } catch (error) { notify(error.message); }
  };
  return { intentDraft, setIntentDraft, settleDraft, setSettleDraft, saveIntentDraft, applySettlement, queueSettlementReview };
}
