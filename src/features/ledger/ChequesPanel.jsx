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
  const [accounts, setAccounts] = useState([]);
  const [calendar, setCalendar] = useState(null);
  // یک چک در هر لحظه یک فرم باز دارد: وصول، سپردن، واگذاری، تعیین تکلیف یا تاریخچه.
  const [open, setOpen] = useState({ id: '', kind: '', history: [] });

  const load = useCallback(async () => {
    try {
      const [cheques, calendarData] = await Promise.all([api.cheques({ status }), api.chequeCalendar(60)]);
      setState(cheques); setCalendar(calendarData);
    } catch (error) { notify(error.message); }
  }, [notify, status]);

  useEffect(() => { api.accounts().then(({ items }) => setAccounts((items || []).filter((account) => account.active !== 0))).catch(() => {}); }, []);

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
    try { await action(); setOpen({ id: '', kind: '', history: [] }); await load(); await refresh?.(); notify(label); }
    catch (error) { notify(error.message); }
    setBusy('');
  };

  const toggle = async (cheque, kind) => {
    if (open.id === cheque.id && open.kind === kind) { setOpen({ id: '', kind: '', history: [] }); return; }
    let history = [];
    if (kind === 'history') {
      try { ({ items: history } = await api.chequeHistory(cheque.id)); } catch (error) { notify(error.message); return; }
    }
    setOpen({ id: cheque.id, kind, history });
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
        {[['open', 'در جریان'], ['deposited', 'نزد بانک'], ['cleared', 'وصول‌شده'], ['bounced', 'برگشتی'], ['transferred', 'واگذارشده'],
          ...(summary.review?.count ? [['review', `نیازمند بررسی (${toPersianDigits(summary.review.count)})`]] : [])].map(([id, label]) => (
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

    <DueCalendar calendar={calendar} />

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
        <label className="text-xs text-muted">سررسید<PersianDateInput aria-label="سررسید چک" value={draft.dueAt} onChange={(iso) => setDraft({ ...draft, dueAt: iso })} /></label>
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
            {cheque.sayad ? ` · صیاد ${toPersianDigits(cheque.sayad)}` : ''}
            {cheque.transferredTo ? ` · واگذار به ${cheque.transferredTo}` : ''}
            {cheque.source === 'parsian' ? ' · از پارسیان' : ''}
          </p>
          {cheque.reviewReason ? <p className="mt-1 text-xs leading-5 text-warn">{cheque.reviewReason}</p> : null}
        </div>
        <b className="numbers shrink-0 text-sm">{formatAmount(cheque.amount)}</b>
        <div className="flex shrink-0 flex-wrap gap-1">
          {['open', 'deposited'].includes(cheque.status) && <>
            <button disabled={busy === cheque.id} onClick={() => toggle(cheque, 'clear')}
              className="tap rounded-lg border border-income px-3 text-xs font-bold text-income">{cheque.direction === 'payable' ? 'پاس' : 'وصول'}</button>
            {cheque.status === 'open' && cheque.direction === 'receivable' && <>
              <button disabled={busy === cheque.id} onClick={() => toggle(cheque, 'deposit')} className="tap rounded-lg border border-line px-3 text-xs font-bold text-muted hover:text-ink">نزد بانک</button>
              <button disabled={busy === cheque.id} onClick={() => toggle(cheque, 'transfer')} className="tap rounded-lg border border-line px-3 text-xs font-bold text-muted hover:text-ink">واگذاری</button>
            </>}
            {cheque.status === 'deposited' && <button disabled={busy === cheque.id} onClick={() => act(cheque, () => api.chequeAction(cheque.id, 'withdraw'), 'چک از بانک پس گرفته شد.')}
              className="tap rounded-lg border border-line px-3 text-xs font-bold text-muted hover:text-ink">پس‌گرفتن</button>}
            <button disabled={busy === cheque.id}
              onClick={() => { if (window.confirm(`چک ${cheque.counterpartyName} برگشت خورده؟ مبلغ به ${cheque.direction === 'payable' ? 'بدهی ما به' : 'طلب از'} همان شخص برمی‌گردد.`)) act(cheque, () => api.bounceCheque(cheque.id), 'چک برگشتی ثبت شد.'); }}
              className="tap rounded-lg border border-expense/60 px-3 text-xs font-bold text-expense">برگشت</button>
          </>}
          {cheque.status === 'review' && <button disabled={busy === cheque.id} onClick={() => toggle(cheque, 'resolve')}
            className="tap rounded-lg border border-warn px-3 text-xs font-bold text-warn">تعیین تکلیف</button>}
          {!['open', 'deposited', 'review'].includes(cheque.status) && <span className="self-center text-xs font-bold text-muted">{cheque.statusLabel}</span>}
          <button onClick={() => toggle(cheque, 'history')} className="tap rounded-lg px-2 text-xs text-muted hover:text-ink">تاریخچه</button>
        </div>
        {open.id === cheque.id && <ChequeForm key={`${cheque.id}:${open.kind}`} kind={open.kind} cheque={cheque} accounts={accounts} contacts={contacts} history={open.history}
          busy={busy === cheque.id} onSubmit={(action, payload, label) => act(cheque, () => api.chequeAction(cheque.id, action, payload), label)} />}
      </article>)}
    </div>
  </section>;
}

/** سررسیدهای پیش رو: سررسیدگذشته جدا، بعد هر روز با جمع دریافتنی، پرداختنی و خالص. */
function DueCalendar({ calendar }) {
  if (!calendar || (!calendar.overdue.items.length && !calendar.days.length)) return null;
  const { overdue, days } = calendar;
  return <div className="mt-3 rounded-xl border border-line bg-surface p-3">
    <h3 className="font-bold">تقویم سررسید (۶۰ روز آینده)</h3>
    {overdue.items.length > 0 && <p className="mt-2 rounded-lg bg-expense/10 px-3 py-2 text-xs leading-6 text-expense">
      {toPersianDigits(overdue.items.length)} چک سررسیدش گذشته و هنوز باز است:
      {overdue.receivable ? <> دریافتنی <b className="numbers">{formatAmount(overdue.receivable)}</b></> : null}
      {overdue.receivable && overdue.payable ? ' ·' : ''}
      {overdue.payable ? <> پرداختنی <b className="numbers">{formatAmount(overdue.payable)}</b></> : null}
    </p>}
    <div className="mt-2 divide-y divide-line">
      {days.slice(0, 20).map((day) => <div key={day.day} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs">
        <b className="w-24 shrink-0">{persianDate(day.dueAt)}</b>
        {day.receivable ? <span className="numbers text-income">+{formatAmount(day.receivable)}</span> : null}
        {day.payable ? <span className="numbers text-expense">−{formatAmount(day.payable)}</span> : null}
        <span className="numbers mr-auto text-muted">خالص {formatAmount(day.net)}</span>
        <span className="w-full truncate text-muted">{day.items.map((item) => item.counterpartyName).join('، ')}</span>
      </div>)}
      {days.length === 0 && <p className="py-2 text-xs text-muted">در ۶۰ روز آینده سررسیدی نیست.</p>}
    </div>
    {calendar.undated > 0 && <p className="mt-2 text-xs text-muted">{toPersianDigits(calendar.undated)} چک باز سررسید ندارد.</p>}
  </div>;
}

const RESOLVE_OPTIONS = [['open', 'هنوز در جریان است'], ['cleared', 'وصول یا پاس شده'], ['bounced', 'برگشت خورده'], ['transferred', 'واگذار شده'], ['cancelled', 'ابطال شده']];

/** فرم کوچک زیر هر چک. هر کار همان چیزی را می‌پرسد که بی‌آن حدس لازم می‌شد. */
function ChequeForm({ kind, cheque, accounts, contacts, history, busy, onSubmit }) {
  const banks = accounts.filter((account) => account.kind === 'bank');
  const moneyAccounts = [...banks, ...accounts.filter((account) => account.kind !== 'bank')];
  const [values, setValues] = useState({
    accountId: cheque.defaultAccountId || cheque.bankAccountId || banks[0]?.id || moneyAccounts[0]?.id || '', occurredAt: '',
    contactId: '', counterpartyName: '', status: 'open', documentNumber: '', fiscalYear: '', transferredTo: '', note: '',
  });
  const set = (patch) => setValues((current) => ({ ...current, ...patch }));
  const field = 'tap rounded-lg border border-line bg-paper px-3 text-[13px]';
  if (kind === 'history') {
    return <ol className="w-full space-y-1 rounded-lg bg-paper px-3 py-2 text-xs leading-6">
      {history.length === 0 && <li className="text-muted">تاریخچه‌ای ثبت نشده.</li>}
      {history.map((row, index) => <li key={index}>
        <b>{persianDate(row.at)}</b> · {row.statusLabel}{row.note ? ` — ${row.note}` : ''}
        {row.documentNumber ? <span className="text-muted"> (سند {toPersianDigits(row.documentNumber)})</span> : null}
      </li>)}
    </ol>;
  }
  const submit = (event) => {
    event.preventDefault();
    const at = values.occurredAt || undefined;
    if (kind === 'clear') onSubmit('clear', { accountId: values.accountId, occurredAt: at }, cheque.direction === 'payable' ? 'چک پاس شد.' : 'چک وصول شد.');
    if (kind === 'deposit') onSubmit('deposit', { accountId: values.accountId, occurredAt: at }, 'چک نزد بانک ثبت شد؛ سندی نخورد.');
    if (kind === 'transfer') onSubmit('transfer', { contactId: values.contactId, counterpartyName: values.counterpartyName, occurredAt: at }, 'چک واگذار شد و از بدهی گیرنده کم شد.');
    if (kind === 'resolve') onSubmit('resolve', { status: values.status, documentNumber: values.documentNumber, fiscalYear: values.fiscalYear, transferredTo: values.transferredTo, note: values.note }, 'تکلیف چک روشن شد.');
  };
  return <form onSubmit={submit} className="grid w-full gap-2 rounded-lg bg-paper p-2 sm:grid-cols-3">
    {(kind === 'clear' || kind === 'deposit') && <select value={values.accountId} onChange={(event) => set({ accountId: event.target.value })} className={field} aria-label="حساب">
      {(kind === 'deposit' ? banks : moneyAccounts).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
    </select>}
    {kind === 'deposit' && banks.length === 0 && <p className="text-xs text-warn sm:col-span-3">هنوز حساب بانکی نساخته‌ای؛ اول از «حساب‌ها» بانک را بساز.</p>}
    {kind === 'transfer' && <>
      <select value={values.contactId} onChange={(event) => {
        const contact = contacts.find((item) => item.id === event.target.value);
        set({ contactId: event.target.value, counterpartyName: contact?.name || values.counterpartyName });
      }} className={field} aria-label="گیرنده">
        <option value="">گیرنده را انتخاب کن</option>
        {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
      </select>
      <input value={values.counterpartyName} onChange={(event) => set({ counterpartyName: event.target.value, contactId: '' })} placeholder="یا نام گیرنده" className={field} />
    </>}
    {kind === 'resolve' && <>
      <select value={values.status} onChange={(event) => set({ status: event.target.value })} className={field} aria-label="وضعیت واقعی">
        {RESOLVE_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      {values.status !== 'open' && <>
        <input inputMode="numeric" value={values.documentNumber} onChange={(event) => set({ documentNumber: event.target.value.replace(/\D/g, '') })} placeholder="شمارهٔ سندی که این رویداد را دارد" className={`${field} numbers`} />
        <input inputMode="numeric" value={values.fiscalYear} onChange={(event) => set({ fiscalYear: event.target.value.replace(/\D/g, '') })} placeholder="سال مالی (اگر شماره تکراری است)" className={`${field} numbers`} />
      </>}
      {values.status === 'transferred' && <input value={values.transferredTo} onChange={(event) => set({ transferredTo: event.target.value })} placeholder="واگذار به" className={field} />}
      <p className="text-xs leading-5 text-muted sm:col-span-3">
        {values.status === 'open' ? 'چک باز می‌شود و وصول یا برگشتش از همین‌جا سند می‌خورد.' : 'سند تازه‌ای ساخته نمی‌شود؛ فقط چک به سندی وصل می‌شود که همین رویداد را در دفتر دارد.'}
      </p>
    </>}
    {kind !== 'resolve' && <label className="text-xs text-muted">تاریخ<PersianDateInput direction="past" aria-label="تاریخ" value={values.occurredAt} onChange={(iso) => set({ occurredAt: iso })} /></label>}
    <button disabled={busy || ((kind === 'clear' || kind === 'deposit') && !values.accountId) || (kind === 'transfer' && !values.counterpartyName.trim())}
      className="tap rounded-lg bg-accent px-4 text-[13px] font-bold text-on-fill disabled:opacity-45">
      {{ clear: cheque.direction === 'payable' ? 'ثبت پاس' : 'ثبت وصول', deposit: 'ثبت نزد بانک', transfer: 'ثبت واگذاری', resolve: 'ثبت تکلیف' }[kind]}
    </button>
  </form>;
}
