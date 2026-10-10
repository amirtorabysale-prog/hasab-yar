import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { PersianDateInput, digitsOnly } from '../../components/common.jsx';
import { formatAmount, persianDate } from '../../lib/format.js';

/**
 * برگهٔ پروندهٔ «فهم رویداد».
 *
 * سه چیز را جدا نشان می‌دهد، چون اشتباه‌گرفتنشان همان خطایی است که این لایه
 * برای حذفش آمده:
 *
 * - **آن‌چه فهمیده شد:** هر مبلغ با نقش و وضعیتش — انجام‌شده، آینده، مشروط،
 *   یا فقط زمینه.
 * - **آن‌چه ثبت می‌شود:** فقط اجزای انجام‌شده، با حساب و سطرهای پیشنهادی.
 * - **آن‌چه ثبت نمی‌شود و چرا:** بدهی قبلی، پرداخت آینده، بخشودگی مشروط.
 *
 * دکمهٔ «ثبت» فقط وقتی فعال است که سرور پرونده را «آماده» بداند؛ رابط هیچ
 * تصمیمی دربارهٔ آمادگی نمی‌گیرد.
 */

const ROLE_LABELS = {
  total: 'مبلغ کل', part: 'جزء', 'paid-now': 'پرداخت‌شده', 'received-now': 'دریافت‌شده', 'cash-part': 'بخش نقد',
  'credit-part': 'بخش نسیه', 'prior-balance': 'بدهی یا طلب قبلی', 'future-payment': 'پرداخت آینده',
  'conditional-waiver': 'بخشودگی مشروط', waiver: 'بخشودگی', 'loan-principal': 'اصل وام', installment: 'قسط',
  interest: 'سود', tax: 'مالیات', discount: 'تخفیف', deposit: 'ودیعه', fee: 'کارمزد', 'unit-price': 'نرخ واحد', other: 'مبلغ',
};
const STATUS_LABELS = { done: ['انجام‌شده', 'text-income'], future: ['آینده', 'text-accent'], conditional: ['مشروط', 'text-accent'], context: ['زمینه', 'text-muted'] };
const DATE_ROLES = { payment: 'تاریخ پرداخت', occurrence: 'تاریخ رویداد', 'coverage-start': 'شروع پوشش', 'coverage-end': 'پایان پوشش', delivery: 'تحویل', due: 'سررسید', invoice: 'تاریخ فاکتور', 'installment-start': 'شروع اقساط', other: 'تاریخ' };
const LINE_ROLES = {
  cash: 'صندوق یا بانک', payable: 'بدهی به طرف حساب', receivable: 'طلب از طرف حساب', 'expense-category': 'هزینه', 'income-category': 'درآمد',
  'inventory-unsplit': 'موجودی کالا', 'inventory-asset': 'موجودی کالا', 'prepaid-asset': 'پیش‌پرداخت', 'customer-advance': 'پیش‌دریافت',
  'loan-payable': 'وام پرداختنی', 'owner-capital': 'سرمایه', 'owner-drawing': 'برداشت مالک', 'fixed-asset': 'دارایی ثابت',
  'refundable-deposit': 'ودیعه', 'supplier-advance': 'پیش‌پرداخت خرید', 'employee-advance': 'مساعدهٔ کارمند', 'unidentified-receipt': 'وجوه تعیین‌تکلیف‌نشده',
  'partner-payable': 'جاری شریک (بدهی شرکت به او)', 'partner-receivable': 'جاری شریک (طلب شرکت از او)',
};
const PROVENANCE = { computed: 'محاسبه از مبالغ گفته‌شده', 'explicit-scale-from-sentence': 'مقیاس از همین جمله', 'whole-balance': 'همهٔ ماندهٔ گفته‌شده', user: 'تعیین‌شده توسط تو' };

export function UnderstandingSheet({ draft, setDraft, close, notify, onPosted }) {
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => setAnswers({}), [draft?.id, draft?.version]);
  if (!draft) return null;
  const plan = draft.plan;
  const accounts = plan?.accounts || [];
  const accountName = (id) => accounts.find((account) => account.id === id)?.name || '';
  const run = async (work, message) => {
    setBusy(true);
    try {
      const { item } = await work();
      setDraft(item);
      if (message) notify(message);
      return item;
    } catch (error) {
      notify(error.message);
      // «هنوز آماده نیست»: سرور نقشه را تازه کرده؛ همان را نشان بده.
      if (error.code === 'UNDERSTANDING_NOT_READY') api.understandingCase(draft.id).then(({ item }) => setDraft(item)).catch(() => {});
    } finally { setBusy(false); }
    return null;
  };
  const answered = Object.keys(answers).length > 0;
  const submitAnswers = () => run(() => api.answerUnderstandingCase(draft.id, answers));
  const commit = async () => {
    const item = await run(() => api.commitUnderstandingCase(draft.id));
    if (item?.status === 'posted') { onPosted?.(item); close(); }
  };
  const extracting = draft.status === 'extracting' || !draft.id;

  return <div className="fixed inset-0 z-[78] flex items-end justify-center bg-ink/40 backdrop-blur-[2px]">
    <section role="dialog" aria-modal="true" aria-label="پروندهٔ فهم گفته" className="sheet-in max-h-[92vh] w-full max-w-[600px] overflow-y-auto rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl">
      <div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" />
      <span className="rounded-full bg-accent/10 px-2 py-1 text-[10px] font-extrabold text-accent">فهم گفته</span>
      <h2 className="mt-3 text-xl font-extrabold">{extracting ? 'در حال فهمیدن گفته…' : draft.understanding?.event?.description || 'این گفته را این‌طور فهمیدم'}</h2>
      <blockquote className="mt-3 rounded-lg border border-line bg-surface px-3 py-3 text-sm leading-7 text-muted">«{draft.transcript}»</blockquote>

      {extracting && <p className="mt-4 text-sm text-muted">چند ثانیه طول می‌کشد. هیچ چیزی هنوز ثبت نشده است.</p>}

      {draft.status === 'failed' && <div className="mt-4 rounded-lg border border-expense/40 bg-surface p-3">
        <p className="text-sm font-bold text-expense">گفته فهمیده نشد</p>
        <p className="mt-1 text-[12px] leading-6 text-muted">{draft.error?.message || 'سرویس فهم گفته پاسخ نداد.'} متن تو نگه داشته شده و هیچ سندی ساخته نشده است.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button disabled={busy} onClick={() => run(() => api.retryUnderstandingCase(draft.id))} className="tap rounded-lg bg-accent px-3 text-[12px] font-bold text-white disabled:opacity-40">تلاش دوباره</button>
          <button disabled={busy} onClick={() => run(() => api.sendUnderstandingToAccountant(draft.id), 'پرونده با متن کامل به صف حسابدار رفت؛ سندی ساخته نشد.').then((item) => item && close())} className="tap rounded-lg border border-line px-3 text-[12px] font-bold">ارسال به حسابدار</button>
        </div>
      </div>}

      {draft.understanding && <>
        <div className="mt-4">
          <p className="text-xs font-bold text-muted">مبالغ</p>
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-surface">
            {draft.understanding.amounts.map((amount) => {
              const [statusLabel, statusClass] = STATUS_LABELS[amount.status] || ['', ''];
              return <li key={amount.id} className="flex items-start justify-between gap-2 px-3 py-2 text-[13px]">
                <span className="min-w-0">
                  <b>{ROLE_LABELS[amount.role] || amount.role}</b>
                  <span className={`mr-2 text-[11px] font-bold ${statusClass}`}>{statusLabel}</span>
                  <span className="block truncate text-[11px] text-muted">«{amount.evidence}»{PROVENANCE[amount.provenance] ? ` · ${PROVENANCE[amount.provenance]}` : ''}</span>
                </span>
                <b className={`numbers shrink-0 ${amount.accepted ? '' : 'text-expense'}`}>{amount.accepted ? formatAmount(amount.value) : 'نامعلوم'}</b>
              </li>;
            })}
          </ul>
        </div>
        {draft.understanding.dates.some((date) => date.iso) && <div className="mt-3 flex flex-wrap gap-2">
          {draft.understanding.dates.filter((date) => date.iso).map((date) => <span key={date.id} className="rounded-lg border border-line bg-surface px-2 py-1 text-[11px]">{DATE_ROLES[date.role] || 'تاریخ'}: <b>{persianDate(date.iso)}</b></span>)}
        </div>}
      </>}

      {plan && <>
        {plan.components.length > 0 && <div className="mt-4">
          <p className="text-xs font-bold text-muted">آن‌چه ثبت می‌شود</p>
          <ul className="mt-2 space-y-2">
            {plan.components.map((component) => <li key={component.id} className="rounded-lg border border-income/40 bg-surface px-3 py-2 text-[13px]">
              <b>{component.label}</b>
              {component.accountId && <span className="block text-[11px] text-muted">حساب: {accountName(component.accountId) || '—'}{component.category ? ` · ${component.category}` : ''}</span>}
              {component.preview?.lines?.length > 0 && <span className="mt-1 block text-[11px] text-muted">
                {component.preview.lines.map((line, index) => <span key={index} className="ml-2 inline-block">{line.debit ? 'بدهکار' : 'بستانکار'} {LINE_ROLES[line.role] || line.role} <span className="numbers">{formatAmount(line.debit || line.credit)}</span></span>)}
              </span>}
            </li>)}
          </ul>
        </div>}
        {plan.notes.length > 0 && <div className="mt-4">
          <p className="text-xs font-bold text-muted">آن‌چه ثبت نمی‌شود</p>
          <ul className="mt-2 space-y-1 text-[12px] leading-6 text-muted">{plan.notes.map((note, index) => <li key={index}>• {note.text}</li>)}</ul>
        </div>}
        {draft.status === 'needs-accountant' && <div className="mt-4 rounded-lg bg-warn-bg px-3 py-3 text-[12px] leading-6 text-accent">
          <b>این مورد قضاوت حسابدار می‌خواهد:</b>
          <ul className="mt-1">{plan.reasons.map((reason, index) => <li key={index}>• {reason}</li>)}</ul>
        </div>}
        {draft.status === 'no-entry' && <p className="mt-4 rounded-lg bg-surface px-3 py-3 text-[12px] leading-6 text-muted">{plan.reasons[0]}</p>}
        {plan.questions.length > 0 && <div className="mt-4 space-y-3">
          <p className="text-xs font-bold text-muted">برای ثبت این را بگو</p>
          {plan.questions.map((question) => <QuestionField key={question.id} question={question} accounts={accounts}
            value={answers[question.id]} onChange={(answer) => setAnswers({ ...answers, [question.id]: answer })} />)}
        </div>}
      </>}

      <div className="mt-5 grid grid-cols-2 gap-2">
        {draft.status === 'ready' && <button disabled={busy} onClick={commit} className="tap col-span-2 rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">{busy ? 'در حال ثبت…' : 'ثبت'}</button>}
        {plan?.questions.length > 0 && <button disabled={busy || !answered} onClick={submitAnswers} className="tap col-span-2 rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">{busy ? '…' : 'ثبت پاسخ‌ها'}</button>}
        {draft.status === 'needs-accountant' && <button disabled={busy} onClick={() => run(() => api.sendUnderstandingToAccountant(draft.id), 'پرونده به صف حسابدار رفت؛ سندی ساخته نشد.').then((item) => item && close())} className="tap col-span-2 rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">ارسال به حسابدار</button>}
        <button disabled={busy || extracting} onClick={async () => { if (draft.id && !['posted', 'sent-to-accountant', 'dismissed'].includes(draft.status)) await api.dismissUnderstandingCase(draft.id).catch(() => {}); close(); }}
          className="tap col-span-2 rounded-lg border border-line font-bold">{['posted', 'sent-to-accountant'].includes(draft.status) ? 'بستن' : 'انصراف — چیزی ثبت نشود'}</button>
      </div>
    </section>
  </div>;
}

function QuestionField({ question, accounts, value, onChange }) {
  const label = <p className="text-[13px] font-bold leading-6">{question.text}</p>;
  if (question.picker === 'account') {
    return <label className="block">{label}
      <select value={value?.valueId || ''} onChange={(event) => onChange({ valueId: event.target.value })} className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-sm">
        <option value="">انتخاب حساب</option>
        {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
      </select>
    </label>;
  }
  if (['contact', 'document', 'options'].includes(question.picker) && question.options?.length) {
    const byId = ['contact', 'document'].includes(question.picker);
    return <div>{label}
      <div className="mt-1 flex flex-wrap gap-2">
        {question.options.map((option) => {
          const chosen = byId ? value?.valueId === option.value : value?.value === option.value;
          return <button key={option.value} onClick={() => onChange(byId ? { valueId: option.value } : { value: option.value })}
            className={`tap rounded-lg border px-3 py-2 text-xs font-bold ${chosen ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-muted'}`}>{option.label}</button>;
        })}
      </div>
      {!byId && question.options.find((option) => option.value === value?.value)?.freeInput && <input value={value?.freeText || ''} onChange={(event) => onChange({ ...value, freeText: event.target.value })}
        className="tap mt-2 w-full rounded-lg border border-line bg-surface px-3 text-sm" />}
    </div>;
  }
  if (question.picker === 'amount') {
    return <label className="block">{label}
      <input inputMode="numeric" dir="ltr" value={value?.value || ''} onChange={(event) => onChange({ value: Number(digitsOnly(event.target.value)) || '' })}
        placeholder="مبلغ به تومان" className="tap numbers mt-1 w-full rounded-lg border border-line bg-surface px-3 text-left text-lg" />
      {Number(value?.value) > 0 && <span className="numbers mt-1 block text-[11px] text-muted">{formatAmount(value.value)} تومان</span>}
    </label>;
  }
  if (question.picker === 'date') {
    return <div>{label}<PersianDateInput value={value?.value || ''} onChange={(iso) => onChange({ value: iso })} className="mt-1" /></div>;
  }
  return <label className="block">{label}
    <textarea value={value?.value || ''} onChange={(event) => onChange({ value: event.target.value })} rows={2}
      className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm" />
    <span className="mt-1 block text-[11px] text-muted">با این پاسخ، گفته یک بار دیگر خوانده می‌شود.</span>
  </label>;
}

/**
 * کلید فهم گفته در قانون ثبت خودکار، با خلاصهٔ حالت مقایسه‌ای.
 *
 * سه حالت عمداً سه دکمهٔ جدا هستند نه یک کلید: «مقایسه» باید بی‌خطر بودنش را
 * روشن بگوید تا روی دفتر واقعی روشن شود، و «فعال» باید نشان بدهد چند گفته در
 * حالت مقایسه با مسیر قدیمی هم‌نظر بوده است.
 */
export function UnderstandingPolicyBox({ policy, busy, save }) {
  const [report, setReport] = useState(null);
  useEffect(() => {
    if (policy.understandingMode === 'off') { setReport(null); return; }
    api.understandingReport().then(setReport).catch(() => setReport(null));
  }, [policy.understandingMode]);
  const modes = [
    ['off', 'خاموش', 'هیچ درخواستی به AI نمی‌رود.'],
    ['shadow', 'مقایسه', 'ثبت از مسیر فعلی؛ AI فقط در پس‌زمینه می‌فهمد و مقایسه می‌کند. دفتر دست نمی‌خورد.'],
    ['active', 'فعال', 'گفتهٔ مرکب به برگهٔ پرونده می‌رود و فقط با تأیید تو ثبت می‌شود.'],
  ];
  return <div className="mt-3 border-t border-line pt-3">
    <p className="text-[12px] font-extrabold">فهم گفتهٔ مرکب با AI</p>
    <p className="mt-1 text-[11px] leading-5 text-muted">
      برای جمله‌هایی که چند مبلغ، شرط، نفی یا بدهی قبلی دارند. AI فقط می‌فهمد چه گفته شده؛ سند را همان قاعده‌های دفتر می‌سازند.
    </p>
    <div className="mt-2 grid grid-cols-3 gap-2">
      {modes.map(([mode, label]) => <button key={mode} disabled={busy} onClick={() => save({ understandingMode: mode })}
        className={`tap rounded-lg border px-2 text-[12px] font-bold ${policy.understandingMode === mode ? 'border-accent bg-accent text-white' : 'border-line bg-paper'}`}>{label}</button>)}
    </div>
    <p className="mt-1 text-[11px] leading-5 text-muted">{modes.find(([mode]) => mode === policy.understandingMode)?.[2]}</p>
    {policy.understandingMode !== 'off' && <label className="mt-2 flex items-center gap-2 text-[12px]">
      <input type="checkbox" disabled={busy} checked={policy.understandingScope === 'all'} onChange={(event) => save({ understandingScope: event.target.checked ? 'all' : 'composite' })} />
      همهٔ گفته‌ها، نه فقط گفته‌های مرکب (هزینهٔ AI بیشتر)
    </label>}
    {report && report.total > 0 && <p className="numbers mt-2 rounded-lg bg-surface px-2 py-2 text-[11px] leading-6 text-muted">
      مقایسه: {report.compared} گفته · هم‌نظر با مسیر فعلی {report.agree} · مسیر فعلی به حسابدار داد {report.legacyToAccountant} · مسیر تازه بدون حسابدار {report.wouldAvoidAccountant} · ناموفق {report.failed} · درخواست AI {report.aiCalls}{report.latencyMs ? ` · میانهٔ زمان ${Math.round(report.latencyMs.median / 100) / 10} ثانیه` : ''}
    </p>}
  </div>;
}
