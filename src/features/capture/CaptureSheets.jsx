import { Check, ChevronLeft, CircleAlert, Pencil, RotateCcw, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { CONFIDENCE_COMPONENT_LABELS } from '../../../shared/confidenceEngine.js';
import { REVIEW_FIELD_LABELS, assessTransactionReview, reviewBatchSummary } from '../../../shared/review.js';
import { formatAmount, formatSignedAmount, persianDate, toPersianDigits } from '../../lib/format.js';
import { pickBankAccount } from '../../../shared/banks.js';
import { counterpartyChoice, settlementPreview } from '../../../shared/counterpartySettlement.js';


export function ConfirmationSheet({ result, categories, accounts = [], contacts = [], onCancel, onConfirm }) {
  const defaultAccountId = accounts.find((account) => account.id === 'cash' && account.active)?.id || accounts.find((account) => account.active)?.id || 'cash';
  /**
   * حسابی که این برداشت باید روی آن بنشیند.
   *
   * اگر نام بانک در جمله آمده، همان حساب انتخاب می‌شود. بدون این، برگهٔ تأیید
   * پیش از ارسال `accountId` را روی صندوق می‌گذاشت و سرور دیگر فرصت نداشت از
   * روی نام بانک تصمیم بگیرد — یعنی گفتنِ نام بانک هیچ اثری نداشت.
   *
   * دو حساب از یک بانک یعنی جمله روشن نیست؛ همان قاعدهٔ سرور، اینجا هم.
   */
  const accountFor = (item) => item.accountId || pickBankAccount(accounts, item.bankId)?.id || defaultAccountId;
  const [items, setItems] = useState(() => result.transactions.map((item) => ({ ...item, accountId: accountFor(item), originalCategory: item.category })));
  const [index, setIndex] = useState(0);
  const [editAmount, setEditAmount] = useState(false);
  const initialSummary = reviewBatchSummary(result);
  const [detailsOpen, setDetailsOpen] = useState(() => initialSummary.review > 0 || initialSummary.unintelligible > 0);
  const item = items[index];
  const assessment = assessTransactionReview(item);
  const summary = reviewBatchSummary({ transactions: items });
  const allowedCategories = categories.filter((category) => category.type === item.type);
  const settlement = settlementPreview(item, contacts);
  // انتخاب کاربر بر پیش‌فرض مقدم است؛ تا وقتی دست نزده، پیش‌فرض همان قاعده است.
  const choice = { ...(counterpartyChoice(settlement) || {}), ...(item.counterpartyChoice || {}) };
  const setChoice = (changes) => patch({
    counterpartyChoice: { ...choice, ...changes },
    contactId: (changes.link ?? choice.link) ? settlement?.contact?.id || null : null,
    linkContact: changes.link ?? choice.link,
    settlement: changes.settlement ?? choice.settlement,
  });
  const patch = (changes) => setItems((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...changes } : entry));
  const patchFields = (fields, changes) => patch({
    ...changes, _changed: true,
    confidenceDetails: { ...item.confidenceDetails, ...Object.fromEntries(fields.map((field) => [field, { score: 1, reason: 'کاربر این مقدار را در صفحهٔ تأیید انتخاب کرد.' }])) },
  });
  const patchField = (field, changes) => patchFields([field], changes);
  const confirmedItems = () => items.map((entry) => {
    const nextAssessment = assessTransactionReview(entry);
    const { _changed, ...clean } = entry;
    const reviewed = Boolean(_changed) || nextAssessment.state !== 'ready';
    return {
      ...clean, needsReview: false, confidence: nextAssessment.overallScore, confidenceDetails: nextAssessment.fields,
      reviewState: reviewed ? 'reviewed' : 'ready',
      reviewReasons: reviewed ? [...(entry.reviewReasons || []), 'کاربر جزئیات این برداشت را پیش از ثبت تأیید کرد.'] : (entry.reviewReasons || []),
    };
  });
  const finish = () => index < items.length - 1 ? setIndex(index + 1) : onConfirm(confirmedItems());
  const statusCards = [
    ['ready', 'آماده ثبت', summary.ready, 'border-income/30 bg-income/5 text-income'],
    ['review', 'نیازمند بررسی', summary.review, 'border-accent/35 bg-warn-bg text-accent'],
    ['unintelligible', 'نامفهوم', summary.unintelligible, 'border-expense/30 bg-expense/5 text-expense'],
  ];
  const quickConfirm = summary.ready === summary.total && summary.total > 0 && !detailsOpen;
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-ink/35 px-0 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section role="dialog" aria-modal="true" aria-label="تأیید تراکنش" className="sheet-in max-h-[94vh] w-full max-w-[640px] overflow-y-auto rounded-t-2xl bg-paper px-4 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-3 shadow-2xl">
        <div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" />
        {items.length > 1 && <div className="mb-3 flex items-center justify-between text-[13px] text-muted"><span>تراکنش {toPersianDigits(index + 1)} از {toPersianDigits(items.length)}</span><div className="flex gap-1">{items.map((_, dot) => <span key={dot} className={`h-1.5 w-6 rounded-full ${dot === index ? 'bg-accent' : 'bg-line'}`} />)}</div></div>}
        <div className="mb-3 grid grid-cols-3 gap-2" aria-label="وضعیت برداشت‌ها">{statusCards.map(([key, label, count, classes]) => <div key={key} className={`rounded-lg border px-2 py-2 text-center ${classes}`}><b className="numbers block text-base">{toPersianDigits(count)}</b><span className="mt-0.5 block text-[10px] font-bold">{label}</span></div>)}</div>
        <blockquote className="rounded-lg border border-line bg-surface/65 px-3 py-3 text-[14px] leading-7 text-muted">«{result.transcript}»</blockquote>
        {Number.isFinite(result.responseMs) && <p className="mt-2 text-center text-[12px] font-medium text-income">{result.engine === 'browser-live' ? 'تشخیص زنده' : 'تشخیص از صدای اصلی'}؛ نتیجه در {toPersianDigits((Math.max(1, result.responseMs) / 1000).toFixed(1))} ثانیه آماده شد</p>}

        {quickConfirm ? <div className="mt-5"><div className="divide-y divide-line rounded-[10px] border border-line bg-surface px-3">{items.map((entry) => <div key={`${entry.amount}-${entry.rawText}`} className="flex items-center justify-between gap-3 py-3"><div><b className={`numbers text-lg ${entry.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatSignedAmount(entry)}</b>{/* حساب و تاریخ باید پیش از تأیید دیده شوند، وگرنه «تأیید سریع» یعنی
                تأیید چیزی که کاربر ندیده — و اگر حساب یا روز اشتباه باشد، بعداً
                فقط در تراز پیدا می‌شود. */}
              <p className="mt-1 text-xs text-muted">{entry.category} · {accounts.find((account) => account.id === entry.accountId)?.name || 'حساب پیش‌فرض'}{entry.occurredAtLabel ? ` · ${entry.occurredAtLabel}` : ''}</p></div><span className="rounded-full bg-income/10 px-2 py-1 text-[10px] font-bold text-income">آماده ثبت</span></div>)}</div><button onClick={() => onConfirm(confirmedItems())} className="tap mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 font-extrabold text-white"><Check size={19} />تأیید سریع همه</button><button onClick={() => setDetailsOpen(true)} className="tap mt-2 w-full text-sm font-bold text-muted">دیدن جزئیات و دلیل تصمیم</button></div> : <>
        <div className={`mt-4 flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-bold ${assessment.state === 'ready' ? 'border-income/30 bg-income/5 text-income' : assessment.state === 'review' ? 'border-accent/40 bg-warn-bg text-accent' : 'border-expense/30 bg-expense/5 text-expense'}`}><span>{assessment.state === 'ready' ? 'آماده ثبت' : assessment.state === 'review' ? 'این مورد را بررسی کن' : 'این مورد نامفهوم است'}</span><span className="numbers">اطمینان {toPersianDigits(assessment.percent)}٪</span></div>
        <button onClick={() => setEditAmount(true)} className="my-4 w-full rounded-[10px] border border-transparent py-3 text-center hover:border-line">
          {editAmount ? (
            <input autoFocus inputMode="numeric" value={item.amount} onChange={(event) => patchField('amount', { amount: Number(event.target.value.replace(/\D/g, '')) })} onBlur={() => setEditAmount(false)} onKeyDown={(event) => { if (event.key === 'Enter') setEditAmount(false); }} className="numbers mx-auto block w-full bg-transparent text-center text-4xl font-extrabold tracking-[-.02em] outline-none" />
          ) : <div className="flex items-center justify-center gap-2"><span className="numbers text-4xl font-extrabold tracking-[-.02em]">{formatAmount(item.amount)}</span><Pencil size={16} className="text-muted" /></div>}
          <span className="mt-1 block text-[13px] text-muted">تومان</span>
        </button>

        <div className="space-y-2">
          <div className="flex min-h-14 items-center gap-3 border-t border-line py-2"><span className="w-12 text-[13px] text-muted">نوع</span><div className="grid flex-1 grid-cols-2 gap-2"><button onClick={() => patchFields(['type', 'category'], { type: 'income', category: categories.find((x) => x.type === 'income')?.name || 'فروش' })} className={`tap rounded-lg border text-sm font-bold ${item.type === 'income' ? 'border-income bg-income text-white' : 'border-line bg-surface'}`}>درآمد</button><button onClick={() => patchFields(['type', 'category'], { type: 'expense', category: categories.find((x) => x.type === 'expense')?.name || 'سایر هزینه‌ها' })} className={`tap rounded-lg border text-sm font-bold ${item.type === 'expense' ? 'border-expense bg-expense text-white' : 'border-line bg-surface'}`}>هزینه</button></div></div>
          {/* طرف حساب، مهم‌ترین تصمیم این برگه است: تعیین می‌کند این پول به
              کارت حساب چه کسی می‌نشیند. پس پرسیده می‌شود، نه حدس زده. */}
          {settlement && <div className={`mt-2 rounded-lg border px-3 py-3 ${choice.link ? 'border-accent/50 bg-warn-bg' : 'border-line bg-surface'}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-[13px] font-extrabold text-ink">طرف حساب: {settlement.name}</p>
              <button
                onClick={() => setChoice({ link: !choice.link, settlement: 'none' })}
                className={`tap shrink-0 rounded-lg border px-2 text-[11px] font-bold ${choice.link ? 'border-line bg-paper text-muted' : 'border-accent bg-accent text-white'}`}
              >{choice.link ? 'بدون طرف حساب' : 'وصل کن'}</button>
            </div>

            {choice.link && !settlement.contact && <p className="mt-1 text-[12px] leading-6 text-muted">
              «{settlement.name}» در دفتر نیست. با ثبت، <b className="text-ink">کارت حساب برایش ساخته می‌شود</b> و این مبلغ اولین گردشش خواهد بود.
            </p>}

            {choice.link && settlement.contact && <>
              <p className="mt-1 text-[12px] leading-6 text-muted">
                به کارت حساب او وصل می‌شود.{' '}
                {settlement.balance === 0
                  ? 'حسابش الان صاف است.'
                  : settlement.balance > 0
                    ? <>طلب شما از او <b className="numbers text-ink">{formatAmount(settlement.balance)}</b> تومان است.</>
                    : <>بدهی شما به او <b className="numbers text-ink">{formatAmount(Math.abs(settlement.balance))}</b> تومان است.</>}
              </p>
              {settlement.direction && <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] font-bold">
                <button onClick={() => setChoice({ settlement: settlement.direction })}
                  className={`tap rounded-lg border py-1.5 ${choice.settlement !== 'none' ? 'border-income bg-income text-white' : 'border-line bg-paper text-muted'}`}>
                  {settlement.direction === 'payable' ? 'بابت بدهی او' : 'بابت طلب او'}
                </button>
                <button onClick={() => setChoice({ settlement: 'none' })}
                  className={`tap rounded-lg border py-1.5 ${choice.settlement === 'none' ? 'border-accent bg-accent text-white' : 'border-line bg-paper text-muted'}`}>
                  {item.type === 'expense' ? 'هزینهٔ عادی' : 'درآمد عادی'}
                </button>
              </div>}
              {settlement.direction && choice.settlement !== 'none' && <p className="mt-1.5 text-[11px] leading-5 text-muted">
                {settlement.direction === 'payable'
                  ? 'سند به حساب خودش می‌خورد و بدهی‌اش کم می‌شود؛ هزینهٔ تازه‌ای ساخته نمی‌شود.'
                  : 'سند به حساب خودش می‌خورد و طلبتان کم می‌شود؛ درآمد تازه‌ای شناسایی نمی‌شود.'}
              </p>}
            </>}
          </div>}
          {/* وقتی پول به حساب خودِ طرف حساب می‌نشیند، دسته معنایی ندارد. */}
          {!(choice.link && choice.settlement && choice.settlement !== 'none') && <label className="flex min-h-14 items-center gap-3 border-y border-line py-2"><span className="w-12 text-[13px] text-muted">دسته</span><select value={item.category} onChange={(event) => patchField('category', { category: event.target.value })} className="tap flex-1 appearance-none rounded-lg border border-line bg-surface px-3 text-[15px] font-bold outline-none">{allowedCategories.map((category) => <option key={category.id}>{category.name}</option>)}</select><Pencil size={16} className="text-muted" /></label>}
          <label className="flex min-h-14 items-center gap-3 border-b border-line py-2"><span className="w-12 text-[13px] text-muted">حساب</span><select value={item.accountId || defaultAccountId} onChange={(event) => patchField('account', { accountId: event.target.value })} className="tap flex-1 rounded-lg border border-line bg-surface px-3 text-[15px] font-bold outline-none">{accounts.filter((account) => account.active).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          {item.occurredAt && <div className="flex min-h-14 items-center gap-3 border-b border-line py-2"><span className="w-12 text-[13px] text-muted">تاریخ</span><div className="flex flex-1 items-center justify-between gap-2"><b className="text-[13px]">{persianDate(item.occurredAt)}</b><span className="rounded-md bg-warn-bg px-2 py-1 text-[11px] font-bold text-accent">از گفتهٔ «{item.occurredAtLabel}» برداشت شد</span></div></div>}
        </div>

        <ConfidencePanel assessment={assessment} />

        {item.warning && <div className="mt-4 flex gap-3 rounded-lg border-r-4 border-accent bg-warn-bg px-3 py-3 text-[14px] leading-6"><CircleAlert className="mt-0.5 shrink-0 text-accent" size={20} /><span>{item.warning}</span></div>}
        {!!item.alternatives?.length && <div className="mt-4"><p className="mb-2 text-[13px] text-muted">شاید منظورت این بود:</p><div className="flex flex-wrap gap-2">{item.alternatives.map((amount) => <button key={amount} onClick={() => patchField('amount', { amount })} className="tap numbers rounded-lg border border-line bg-surface px-4 font-bold">{formatAmount(amount)}</button>)}</div></div>}

        <div className="mt-5 grid grid-cols-[minmax(0,7fr)_minmax(90px,3fr)] gap-2">
          <button disabled={assessment.state === 'unintelligible'} onClick={finish} className="tap flex items-center justify-center gap-2 rounded-lg bg-accent px-4 font-extrabold text-white disabled:opacity-40"><Check size={19} />{index < items.length - 1 ? 'تأیید و بعدی' : 'تأیید و ثبت'}</button>
          <button onClick={onCancel} className="tap rounded-lg border border-line bg-surface font-bold">لغو</button>
        </div>
        </>}
      </section>
    </div>
  );
}

export function ConfidencePanel({ assessment }) {
  return <section className="mt-4 rounded-[10px] border border-line bg-surface p-3"><div className="flex items-center justify-between"><h3 className="text-sm font-extrabold">چرا این تصمیم؟</h3><span className="numbers text-xs text-muted">اطمینان کلی {toPersianDigits(assessment.percent)}٪</span></div><div className="mt-3 space-y-2">{Object.entries(assessment.fields).map(([field, detail]) => <div key={field} className="rounded-lg bg-paper px-3 py-2"><div className="flex items-center justify-between gap-2"><b className="text-xs">{REVIEW_FIELD_LABELS[field] || CONFIDENCE_COMPONENT_LABELS[field] || field}</b><span className={`numbers text-xs font-bold ${detail.score >= 0.82 ? 'text-income' : detail.score >= 0.7 ? 'text-accent' : 'text-expense'}`}>{toPersianDigits(Math.round(detail.score * 100))}٪</span></div><p className="mt-1 text-[11px] leading-5 text-muted">{detail.reason}</p></div>)}</div>{assessment.reasons.length > 0 && <div className="mt-3 border-t border-line pt-2">{assessment.reasons.map((reason) => <p key={reason} className="mt-1 text-[11px] leading-5 text-expense">• {reason}</p>)}</div>}</section>;
}

export function CorrectionSheet({ draft, accounts, close, confirm }) {
  const [busy, setBusy] = useState(false);
  const { current, preview } = draft;
  const valueFor = (field, source) => {
    if (field === 'amount') return `${formatAmount(source.amount)} تومان`;
    if (field === 'type') return source.type === 'income' ? 'درآمد' : 'هزینه';
    if (field === 'account') return source.accountName || accounts.find((account) => account.id === source.accountId)?.name || 'حساب پیش‌فرض';
    return source.category;
  };
  const next = { ...current, ...preview.changes };
  const submit = async () => { setBusy(true); await confirm(); setBusy(false); };
  return <div className="fixed inset-0 z-[76] flex items-end justify-center bg-ink/40 backdrop-blur-[2px]"><section role="dialog" aria-modal="true" aria-label="تأیید اصلاح آخرین ثبت" className="sheet-in w-full max-w-[620px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl"><div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" /><span className="rounded-full bg-accent/10 px-2 py-1 text-[10px] font-extrabold text-accent">اصلاح مکالمه‌ای امن</span><h2 className="mt-3 text-xl font-extrabold">همین آخرین ثبت اصلاح شود؟</h2><blockquote className="mt-3 rounded-lg border border-line bg-surface px-3 py-3 text-sm text-muted">«{draft.command}»</blockquote><div className="mt-4 divide-y divide-line rounded-[10px] border border-line bg-surface px-3">{preview.changedFields.map((field) => <div key={field} className="py-3"><p className="text-xs font-bold text-muted">{REVIEW_FIELD_LABELS[field]}</p><div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm"><span className="truncate text-muted line-through">{valueFor(field, current)}</span><ChevronLeft size={17} className="text-accent" /><b className="truncate">{valueFor(field, next)}</b></div></div>)}</div><p className="mt-3 text-xs leading-6 text-muted">اصلاح فقط وقتی انجام می‌شود که این رکورد هنوز آخرین ثبت باشد؛ سند قبلی پاک نمی‌شود و با سند معکوس در تاریخچه می‌ماند.</p><div className="mt-5 grid grid-cols-[2fr_1fr] gap-2"><button disabled={busy} onClick={submit} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">{busy ? 'در حال اصلاح…' : 'تأیید اصلاح'}</button><button disabled={busy} onClick={close} className="tap rounded-lg border border-line bg-surface font-bold">لغو</button></div></section></div>;
}

export function DuplicateSheet({ prompt, close, confirm }) {
  const [busy, setBusy] = useState(false);
  const duplicate = prompt.duplicates[0];
  const incoming = prompt.transactions[duplicate?.inputIndex || 0];
  const submit = async () => { setBusy(true); await confirm(); setBusy(false); };
  return <div className="fixed inset-0 z-[78] flex items-end justify-center bg-ink/45 backdrop-blur-[2px]"><section role="dialog" aria-modal="true" aria-label="هشدار ثبت تکراری" className="sheet-in w-full max-w-[620px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl"><div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" /><span className="rounded-full bg-warn-bg px-2 py-1 text-[10px] font-extrabold text-expense">نیازمند بررسی</span><h2 className="mt-3 text-xl font-extrabold">شاید این ثبت تکراری باشد</h2><p className="mt-2 text-sm leading-7 text-muted">مبلغ، حساب، زمان و متن با یک ثبت چند دقیقهٔ اخیر شباهت زیادی دارد. هیچ موردی خودکار ذخیره نمی‌شود.</p><div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-[10px] border border-line bg-surface p-3"><span className="text-[10px] font-bold text-muted">ثبت تازه</span><b className="numbers mt-2 block text-lg">{formatAmount(incoming?.amount || 0)}</b><p className="mt-1 truncate text-xs text-muted">{incoming?.rawText}</p></div><div className="rounded-[10px] border border-accent/30 bg-warn-bg p-3"><span className="text-[10px] font-bold text-muted">ثبت موجود · شباهت {toPersianDigits(duplicate?.similarity || 0)}٪</span><b className="numbers mt-2 block text-lg">{formatAmount(duplicate?.amount || 0)}</b><p className="mt-1 truncate text-xs text-muted">{duplicate?.rawText}</p></div></div><div className="mt-5 grid grid-cols-[2fr_1fr] gap-2"><button disabled={busy} onClick={submit} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">{busy ? 'در حال ثبت…' : 'بله، جداگانه ثبت کن'}</button><button disabled={busy} onClick={close} className="tap rounded-lg border border-line bg-surface font-bold">لغو</button></div></section></div>;
}

export function LearningSuggestionSheet({ suggestion, close, confirm }) {
  const [busy, setBusy] = useState(false);
  const submit = async () => { setBusy(true); await confirm(); setBusy(false); };
  return <div className="fixed inset-0 z-[79] flex items-end justify-center bg-ink/40 backdrop-blur-[2px]"><section role="dialog" aria-modal="true" aria-label="پیشنهاد یادگیری" className="sheet-in w-full max-w-[540px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl"><div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" /><Sparkles className="text-accent" size={26} /><h2 className="mt-3 text-xl font-extrabold">این اصلاح را یاد بگیرم؟</h2><p className="mt-2 text-sm leading-7 text-muted">از این به بعد عبارت «<b className="text-ink">{suggestion.keyword}</b>» را در دستهٔ «<b className="text-ink">{suggestion.category}</b>» پیشنهاد می‌دهم. هر وقت بخواهی از صفحهٔ یادگیری قابل حذف است.</p><div className="mt-5 grid grid-cols-2 gap-2"><button disabled={busy} onClick={submit} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">{busy ? 'در حال ذخیره…' : 'بله، یاد بگیر'}</button><button disabled={busy} onClick={close} className="tap rounded-lg border border-line bg-surface font-bold">نه، فقط همین بار</button></div></section></div>;
}

export function DecisionDetailsSheet({ item, close }) {
  const assessment = assessTransactionReview(item);
  const state = item.needsReview || item.reviewState === 'review' ? 'نیازمند بررسی' : ['reviewed', 'duplicate-confirmed'].includes(item.reviewState) ? 'بررسی‌شده توسط کاربر' : 'آماده ثبت';
  return <div className="fixed inset-0 z-[75] flex items-end justify-center bg-ink/35 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section role="dialog" aria-modal="true" aria-label="دلیل تصمیم تراکنش" className="sheet-in max-h-[92vh] w-full max-w-[620px] overflow-y-auto rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl"><div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" /><div className="flex items-start justify-between gap-3"><div><span className="rounded-full bg-surface px-2 py-1 text-[10px] font-extrabold text-accent">{state}</span><h2 className={`numbers mt-3 text-2xl font-extrabold ${item.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatSignedAmount(item)} تومان</h2><p className="mt-1 text-sm text-muted">{item.category} · {item.accountName || 'حساب پیش‌فرض'}</p></div><button onClick={close} className="tap grid place-items-center" aria-label="بستن"><X /></button></div><blockquote className="mt-4 rounded-lg border border-line bg-surface px-3 py-3 text-sm leading-7 text-muted">«{item.rawText}»</blockquote><ConfidencePanel assessment={assessment} />{item.restoredFrom && <p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-xs leading-6 text-muted">این ثبت در پاسخ به «دوباره انجام بده» به‌صورت یک سند تازه ساخته شده است.</p>}<button onClick={close} className="tap mt-4 w-full rounded-lg border border-line bg-surface font-bold">بستن</button></section></div>;
}

export function FailureSheet({ failure, close, retry, manual }) {
  return <div className="fixed inset-0 z-[70] flex items-end justify-center bg-ink/35 backdrop-blur-[2px]"><section role="dialog" className="sheet-in w-full max-w-[640px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)]"><div className="mx-auto mb-5 h-1 w-11 rounded-full bg-line" />{failure.transcript && <blockquote className="mb-4 rounded-lg border border-line bg-surface px-3 py-3 text-sm text-muted">«{failure.transcript}»</blockquote>}<span className="rounded-full bg-expense/10 px-2 py-1 text-[10px] font-extrabold text-expense">نامفهوم</span><CircleAlert className="mb-3 mt-3 text-expense" size={27} /><h2 className="text-xl font-extrabold">{failure.permission ? 'اجازهٔ میکروفن فعال نیست' : 'مبلغی پیدا نکردم'}</h2><p className="mt-2 text-[15px] leading-7 text-muted">{failure.message || 'جمله را دوباره بگو یا مبلغ را دستی بنویس. هیچ تراکنشی بدون تأیید تو ثبت نمی‌شود.'}</p>{failure.permission && <ol className="mt-3 list-decimal space-y-1 pr-5 text-sm leading-7"><li>روی علامت قفل کنار آدرس سایت بزن.</li><li>دسترسی «میکروفن» را روی مجاز بگذار.</li><li>صفحه را دوباره باز کن.</li></ol>}<div className="mt-5 grid grid-cols-2 gap-2"><button onClick={retry} className="tap flex items-center justify-center gap-2 rounded-lg bg-accent font-bold text-white"><RotateCcw size={18} />دوباره بگو</button><button onClick={manual} className="tap rounded-lg border border-line bg-surface font-bold">دستی بنویس</button></div><button onClick={close} className="tap mt-2 w-full text-sm text-muted">بستن</button></section></div>;
}
