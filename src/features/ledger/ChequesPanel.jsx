import { useCallback, useEffect, useState } from 'react';
import { ReceiptText } from 'lucide-react';
import { api } from '../../lib/api.js';
import { PersianDateInput } from '../../components/common.jsx';
import { formatAmount, persianDate, toPersianDigits, unitLabel } from '../../lib/format.js';

/**
 * دفتر چک.
 *
 * چک تا وصول نشود پول نیست، و تا برگشت نخورد طلب هم از بین نمی‌رود. سه حالتِ
 * جدا که هرکدام سند خودش را دارد؛ بدون این‌ها «اسناد دریافتنی» تا ابد بدهکار
 * می‌ماند و مانده‌اش با واقعیت هیچ نسبتی ندارد.
 */
const EMPTY = {
  direction: 'receivable', counterpartyName: '', contactId: '', amount: '',
  dueAt: '', serial: '', bankName: '', against: 'income', note: '',
};

export default function ChequesPanel({ contacts = [], notify, refresh }) {
  const [state, setState] = useState({ items: [], summary: {} });
  const [status, setStatus] = useState('open');
  const [draft, setDraft] = useState(EMPTY);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try { setState(await api.cheques({ status })); }
    catch (error) { notify(error.message); }
  }, [notify, status]);

  useEffect(() => { load(); }, [load]);

  const submit = async (event) => {
    event.preventDefault();
    if (!draft.counterpartyName.trim() || !draft.amount) return;
    setBusy('save');
    try {
      const { item } = await api.recordCheque({ ...draft, amount: Number(draft.amount) });
      setDraft(EMPTY);
      await load(); await refresh?.();
      notify(item.queuedForAccountant ? item.queuedReason : 'چک ثبت شد و سندش خورد.');
    } catch (error) { notify(error.message); }
    setBusy('');
  };

  const act = async (cheque, action, label) => {
    setBusy(cheque.id);
    try { await action(); await load(); await refresh?.(); notify(label); }
    catch (error) { notify(error.message); }
    setBusy('');
  };

  const summary = state.summary || {};
  return <section className="mt-6">
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="font-extrabold">دفتر چک</h2>
        <p className="mt-1 text-xs leading-5 text-muted">
          چک تا وصول نشود پول نیست. اینجا سررسیدش را می‌بینی، وصولش می‌کنی، و اگر برگشت خورد طلبِ همان شخص برمی‌گردد.
        </p>
      </div>
      <div className="flex gap-1.5 text-[12px] font-bold">
        {[['open', 'در جریان'], ['cleared', 'وصول‌شده'], ['bounced', 'برگشتی']].map(([id, label]) => (
          <button key={id} onClick={() => setStatus(id)} className={`tap rounded-lg px-3 ${status === id ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-surface'}`}>{label}</button>
        ))}
      </div>
    </div>

    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
      <div className="rounded-lg border border-line bg-surface px-3 py-2">
        <span className="block text-xs text-muted">چک دریافتی در جریان</span>
        <b className="numbers mt-0.5 block text-income">{formatAmount(summary.openReceivable?.total || 0)}</b>
      </div>
      <div className="rounded-lg border border-line bg-surface px-3 py-2">
        <span className="block text-xs text-muted">چک پرداختی در جریان</span>
        <b className="numbers mt-0.5 block text-expense">{formatAmount(summary.openPayable?.total || 0)}</b>
      </div>
      <div className="rounded-lg border border-line bg-surface px-3 py-2">
        <span className="block text-xs text-muted">برگشتی</span>
        <b className="numbers mt-0.5 block">{formatAmount(summary.bounced || 0)}</b>
      </div>
    </div>

    <form onSubmit={submit} className="mt-3 rounded-xl border border-line bg-surface p-3">
      <h3 className="font-bold">ثبت چک</h3>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <select value={draft.direction} onChange={(event) => setDraft({ ...draft, direction: event.target.value })} className="tap rounded-lg border border-line bg-paper px-3 text-[13px]">
          <option value="receivable">چک دریافتی</option>
          <option value="payable">چک پرداختی</option>
        </select>
        <select value={draft.contactId} onChange={(event) => {
          const contact = contacts.find((item) => item.id === event.target.value);
          setDraft({ ...draft, contactId: event.target.value, counterpartyName: contact?.name || draft.counterpartyName });
        }} className="tap rounded-lg border border-line bg-paper px-3 text-[13px]">
          <option value="">شخص را انتخاب کن یا نامش را بنویس</option>
          {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
        </select>
        <input value={draft.counterpartyName} onChange={(event) => setDraft({ ...draft, counterpartyName: event.target.value })}
          placeholder="نام صاحب چک" className="tap rounded-lg border border-line px-3 text-[13px]" />
        <input inputMode="numeric" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/\D/g, '') })}
          placeholder={`مبلغ ${unitLabel()}`} className="tap numbers rounded-lg border border-line px-3 text-[13px]" />
        <input value={draft.serial} onChange={(event) => setDraft({ ...draft, serial: event.target.value })}
          placeholder="شماره چک" className="tap numbers rounded-lg border border-line px-3 text-[13px]" />
        <input value={draft.bankName} onChange={(event) => setDraft({ ...draft, bankName: event.target.value })}
          placeholder="بانک" className="tap rounded-lg border border-line px-3 text-[13px]" />
        <label className="text-xs text-muted">سررسید<PersianDateInput value={draft.dueAt} onChange={(iso) => setDraft({ ...draft, dueAt: iso })} /></label>
        <select value={draft.against} onChange={(event) => setDraft({ ...draft, against: event.target.value })} className="tap rounded-lg border border-line bg-paper px-3 text-[13px]">
          <option value="income">بابت فروش یا خرید تازه</option>
          <option value="receivable">بابت طلب یا بدهی قبلی</option>
        </select>
      </div>
      {/* مهم‌ترین انتخاب همین است و بی‌سروصدا از دست می‌رود، پس نوشته می‌شود. */}
      <p className="mt-2 text-xs leading-5 text-muted">
        {draft.against === 'receivable'
          ? 'چون بابت طلب قبلی است، درآمدی دوباره شناسایی نمی‌شود؛ فقط شکل طلب از حساب دریافتنی به اسناد دریافتنی عوض می‌شود.'
          : 'چون بابت معاملهٔ تازه است، همین حالا درآمد یا هزینه شناسایی می‌شود. اگر بابت طلب قبلی است، گزینه را عوض کن وگرنه همان فروش دو بار در سود دوره می‌آید.'}
      </p>
      <button disabled={busy === 'save' || !draft.counterpartyName.trim() || !draft.amount}
        className="tap mt-3 rounded-lg bg-accent px-4 font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90 active:bg-accent/80">
        {busy === 'save' ? 'در حال ثبت…' : 'ثبت چک'}
      </button>
    </form>

    <div className="mt-3 divide-y divide-line border-y border-line">
      {state.items.length === 0 && <p className="py-8 text-center text-sm text-muted">چکی در این وضعیت نیست.</p>}
      {state.items.map((cheque) => <article key={cheque.id} className="flex min-h-[72px] flex-wrap items-center gap-3 py-3">
        <ReceiptText size={20} className={cheque.direction === 'receivable' ? 'text-income' : 'text-expense'} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold">{cheque.counterpartyName}</p>
          <p className="mt-1 text-xs text-muted">
            {cheque.direction === 'receivable' ? 'دریافتی' : 'پرداختی'}
            {cheque.serial ? ` · شماره ${toPersianDigits(cheque.serial)}` : ''}
            {cheque.bankName ? ` · ${cheque.bankName}` : ''}
            {cheque.dueAt ? ` · سررسید ${persianDate(cheque.dueAt)}` : ''}
          </p>
        </div>
        <b className="numbers shrink-0 text-sm">{formatAmount(cheque.amount)}</b>
        {cheque.status === 'open' ? <div className="flex shrink-0 gap-1">
          <button disabled={busy === cheque.id} onClick={() => act(cheque, () => api.clearCheque(cheque.id), 'چک وصول شد.')}
            className="tap rounded-lg border border-income px-3 text-xs font-bold text-income">وصول</button>
          <button disabled={busy === cheque.id}
            onClick={() => { if (window.confirm(`چک ${cheque.counterpartyName} برگشت خورده؟ مبلغ به طلب همان شخص برمی‌گردد.`)) act(cheque, () => api.bounceCheque(cheque.id), 'چک برگشتی ثبت شد و طلب برگشت.'); }}
            className="tap rounded-lg border border-expense/60 px-3 text-xs font-bold text-expense">برگشت</button>
        </div> : <span className="shrink-0 text-xs font-bold text-muted">{cheque.statusLabel}</span>}
      </article>)}
    </div>
  </section>;
}
