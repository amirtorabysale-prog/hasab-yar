import { ChevronDown, PiggyBank, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { digitsOnly } from '../../components/common.jsx';
import { formatAmount, persianDate } from '../../lib/format.js';

/**
 * تنخواه‌گردان — پولِ شرکت که دست یک نفر است تا خرج‌های کوچک را بدهد.
 *
 * سقف ثابت است: تنخواه یک بار به اندازهٔ سقف پرداخت می‌شود و هر بار دقیقاً به
 * اندازهٔ خرج‌شده شارژ می‌شود. پرداخت، شارژ و بستن هزینه نیستند و فقط پول را
 * میان حساب‌های خود شرکت جابه‌جا می‌کنند؛ هزینه همان خرج‌هایی است که با «از
 * تنخواه…» ثبت می‌شوند.
 */
export function PettyCashPage({ accounts = [], access, notify, refresh }) {
  const canManage = ['owner', 'manager'].includes(access?.workspace?.role);
  const [funds, setFunds] = useState(null);
  const [showClosed, setShowClosed] = useState(false);
  const [creating, setCreating] = useState(null);
  const [action, setAction] = useState(null);
  const [busy, setBusy] = useState(false);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  // منبع و مقصد پول فقط صندوق و بانک‌اند؛ تنخواه از تنخواهِ دیگر شارژ نمی‌شود.
  const sources = accounts.filter((account) => account.active && account.kind !== 'petty');

  // `notify` عمداً وابستگی نیست: تابع تازه در هر رندر یعنی بارگذاری بی‌پایان.
  const load = useCallback(async () => {
    try { setFunds((await api.pettyCashFunds(showClosed)).items || []); }
    catch (error) { setFunds([]); notifyRef.current?.(error.message); }
  }, [showClosed]);
  useEffect(() => { void load(); }, [load]);

  const run = async (work, message) => {
    setBusy(true);
    try {
      await work();
      setCreating(null);
      setAction(null);
      await Promise.all([load(), refresh?.()]);
      notify(message);
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  const create = (event) => {
    event.preventDefault();
    void run(() => api.openPettyCash({ holderName: creating.holderName, ceiling: Number(digitsOnly(creating.ceiling)), fromAccountId: creating.fromAccountId }),
      `تنخواهِ «${creating.holderName}» پرداخت شد؛ هزینه‌ای ثبت نشد.`);
  };

  const submitAction = (event) => {
    event.preventDefault();
    const { kind, fund } = action;
    if (kind === 'replenish') {
      void run(() => api.replenishPettyCash(fund.id, { fromAccountId: action.accountId, amount: Number(digitsOnly(action.amount)) || null }),
        `تنخواهِ «${fund.holderName}» شارژ شد.`);
    } else if (kind === 'ceiling') {
      void run(() => api.updatePettyCash(fund.id, { ceiling: Number(digitsOnly(action.amount)) }), 'سقف تنخواه به‌روز شد.');
    } else if (kind === 'close') {
      void run(() => api.closePettyCash(fund.id, { toAccountId: action.accountId }),
        fund.balance > 0 ? `تنخواه بسته شد و ${formatAmount(fund.balance)} تومان به حساب برگشت.` : 'تنخواه بسته شد.');
    }
  };

  const openAction = (kind, fund) => setAction({
    kind, fund, accountId: sources[0]?.id || '',
    amount: kind === 'replenish' ? String(fund.spent || '') : kind === 'ceiling' ? String(fund.ceiling) : '',
  });

  return <main className="mx-auto max-w-[760px] px-4 py-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-extrabold">تنخواه‌گردان</h1>
        <p className="mt-1 text-[12px] leading-6 text-muted">
          پولی که دست یک نفر است تا خرج‌های کوچک را بدهد. پرداخت و شارژ تنخواه هزینه نیست؛ فقط پول شرکت از صندوق یا بانک به
          دست او می‌رود. هزینه، خرج‌هایی است که با گفتن «از تنخواه…» ثبت می‌شوند.
        </p>
      </div>
      {canManage && <button onClick={() => setCreating(creating ? null : { holderName: '', ceiling: '', fromAccountId: sources[0]?.id || '' })}
        className="tap flex items-center gap-1 rounded-lg bg-accent px-3 text-[13px] font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">
        <Plus size={16} />{creating ? 'بستن' : 'تنخواه تازه'}
      </button>}
    </div>

    {creating && <form onSubmit={create} className="mt-4 space-y-3 rounded-xl border border-line bg-surface p-4">
      <p className="font-bold">تنخواه تازه</p>
      <label className="block text-[12px] text-muted">دست چه کسی است؟
        <input required value={creating.holderName} onChange={(event) => setCreating({ ...creating, holderName: event.target.value })}
          placeholder="مثلاً رضایی" className="tap mt-1 w-full rounded-lg border border-line bg-paper px-3 text-[14px] text-ink" />
      </label>
      <label className="block text-[12px] text-muted">سقف تنخواه (تومان)
        <input required inputMode="numeric" value={creating.ceiling} onChange={(event) => setCreating({ ...creating, ceiling: digitsOnly(event.target.value) })}
          className="tap numbers mt-1 w-full rounded-lg border border-line bg-paper px-3 text-left text-[15px] font-bold text-ink" />
        {Number(creating.ceiling) > 0 && <span className="numbers mt-1 block text-xs">{formatAmount(creating.ceiling)} تومان</span>}
      </label>
      <label className="block text-[12px] text-muted">از کدام حساب پرداخت شد؟
        <select required value={creating.fromAccountId} onChange={(event) => setCreating({ ...creating, fromAccountId: event.target.value })}
          className="tap mt-1 w-full rounded-lg border border-line bg-paper px-3 text-[14px] text-ink">
          <option value="" disabled>حساب را انتخاب کن</option>
          {sources.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
        </select>
      </label>
      <p className="rounded-lg bg-warn-bg px-3 py-2 text-xs leading-6 text-accent">به اندازهٔ سقف از این حساب به تنخواه منتقل می‌شود. بعد از هر بار خرج، با «شارژ» دوباره به سقف می‌رسد.</p>
      <button disabled={busy} className="tap w-full rounded-lg bg-accent font-bold text-on-fill disabled:opacity-40 hover:bg-accent/90 active:bg-accent/80">{busy ? 'در حال ثبت…' : 'پرداخت تنخواه'}</button>
    </form>}

    <div className="mt-4 space-y-3">
      {funds === null && <p className="py-8 text-center text-sm text-muted">در حال بارگذاری…</p>}
      {funds?.length === 0 && <div className="rounded-xl border border-dashed border-line bg-surface px-4 py-8 text-center">
        <PiggyBank className="mx-auto text-muted" />
        <p className="mt-2 text-sm font-bold">{showClosed ? 'تنخواهی ثبت نشده است.' : 'تنخواه بازی نیست.'}</p>
        <p className="mt-1 text-[12px] leading-6 text-muted">با «تنخواه تازه» شروع کن، یا بگو «پنج میلیون تنخواه به رضایی دادیم».</p>
      </div>}
      {funds?.map((fund) => <FundCard key={fund.id} fund={fund} canManage={canManage && fund.status === 'open'} onAction={openAction} />)}
    </div>

    <button onClick={() => setShowClosed(!showClosed)} className="tap mt-4 text-[12px] font-bold text-muted">
      {showClosed ? 'فقط تنخواه‌های باز' : 'نمایش تنخواه‌های بسته‌شده هم'}
    </button>

    <section className="mt-5 rounded-xl border border-line bg-surface p-4 text-[12px] leading-7 text-muted">
      <p className="font-bold text-ink">ثبت خرج از تنخواه با صدا</p>
      <p>«از تنخواه رضایی دویست هزار تومان پذیرایی خریدیم» — هزینه ثبت می‌شود و از تنخواه رضایی کم می‌شود، نه از صندوق.</p>
      <p>«تنخواه رضایی رو از بانک ملت شارژ کردیم» — شارژ؛ هزینه نیست.</p>
    </section>

    {action && <div className="fixed inset-0 z-[80] grid place-items-center bg-scrim/40 p-4">
      <form onSubmit={submitAction} className="w-full max-w-[420px] rounded-2xl bg-paper p-4">
        <h2 className="text-lg font-extrabold">
          {action.kind === 'replenish' ? `شارژ تنخواه ${action.fund.holderName}` : action.kind === 'ceiling' ? 'تغییر سقف تنخواه' : `بستن تنخواه ${action.fund.holderName}`}
        </h2>
        {action.kind !== 'close' && <label className="mt-4 block text-xs text-muted">{action.kind === 'ceiling' ? 'سقف تازه (تومان)' : 'مبلغ شارژ (تومان)'}
          <input autoFocus required inputMode="numeric" value={action.amount} onChange={(event) => setAction({ ...action, amount: digitsOnly(event.target.value) })}
            className="tap numbers mt-2 w-full rounded-lg border border-line bg-surface px-3 text-xl font-extrabold" />
          {action.kind === 'replenish' && <span className="mt-1 block text-xs leading-5">
            پیشنهاد همان مبلغ خرج‌شده است ({formatAmount(action.fund.spent)} تومان) تا تنخواه دوباره به سقفش برسد.
          </span>}
        </label>}
        {action.kind === 'close' && <p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-[12px] leading-6 text-accent">
          {action.fund.balance > 0 ? `باقی‌ماندهٔ ${formatAmount(action.fund.balance)} تومان به حسابی که انتخاب کنی برمی‌گردد.`
            : action.fund.balance < 0 ? `${action.fund.holderName} ${formatAmount(-action.fund.balance)} تومان بیش از تنخواه خرج کرده؛ همین مبلغ از حسابی که انتخاب کنی به او پرداخت می‌شود.`
              : 'تنخواه مانده‌ای ندارد و فقط بسته می‌شود.'}
        </p>}
        {action.kind !== 'ceiling' && <label className="mt-3 block text-xs text-muted">{action.kind === 'close' ? 'حساب برگشت' : 'از کدام حساب؟'}
          <select required value={action.accountId} onChange={(event) => setAction({ ...action, accountId: event.target.value })}
            className="tap mt-2 w-full rounded-lg border border-line bg-surface px-3 text-ink">
            <option value="" disabled>حساب را انتخاب کن</option>
            {sources.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label>}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setAction(null)} className="tap rounded-lg border border-line font-bold hover:bg-paper hover:text-ink">انصراف</button>
          <button disabled={busy} className="tap rounded-lg bg-accent font-extrabold text-on-fill disabled:opacity-40 hover:bg-accent/90 active:bg-accent/80">{busy ? '…' : 'ثبت'}</button>
        </div>
      </form>
    </div>}
  </main>;
}

function FundCard({ fund, canManage, onAction }) {
  const [open, setOpen] = useState(false);
  const ratio = fund.ceiling > 0 ? Math.max(0, Math.min(100, Math.round((fund.balance / fund.ceiling) * 100))) : 0;
  return <article className="rounded-xl border border-line bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="font-extrabold">{fund.holderName}</p>
        <p className="mt-0.5 text-xs text-muted">{fund.status === 'open' ? 'باز' : `بسته شده${fund.closedAt ? ` · ${persianDate(fund.closedAt)}` : ''}`} · سقف <span className="numbers">{formatAmount(fund.ceiling)}</span> تومان</p>
      </div>
      <div className="text-left">
        <b className={`numbers block text-lg ${fund.balance < 0 ? 'text-expense' : ''}`}>{formatAmount(fund.balance)}</b>
        <span className="text-xs text-muted">مانده دست {fund.holderName}</span>
      </div>
    </div>
    {fund.status === 'open' && <>
      <div className="mt-3 h-2 overflow-hidden rounded bg-line"><div className="h-full bg-accent" style={{ width: `${ratio}%` }} /></div>
      <p className="mt-2 text-[12px] text-muted">
        {fund.overspent > 0 ? <span className="text-expense">{formatAmount(fund.overspent)} تومان بیش از تنخواه خرج شده است.</span>
          : fund.spent > 0 ? <>خرج‌شده و منتظر شارژ: <b className="numbers text-ink">{formatAmount(fund.spent)}</b> تومان</> : 'تنخواه پر است.'}
      </p>
    </>}
    {canManage && <div className="mt-3 flex flex-wrap gap-2">
      <button onClick={() => onAction('replenish', fund)} disabled={!(fund.spent > 0)} className="tap rounded-lg border border-accent px-3 text-[12px] font-bold text-accent disabled:opacity-40">شارژ</button>
      <button onClick={() => onAction('ceiling', fund)} className="tap rounded-lg border border-line px-3 text-[12px] font-bold hover:bg-paper hover:text-ink">تغییر سقف</button>
      <button onClick={() => onAction('close', fund)} className="tap rounded-lg border border-line px-3 text-[12px] font-bold text-expense hover:bg-paper hover:text-ink">بستن</button>
    </div>}
    {fund.recentSpends?.length > 0 && <>
      <button onClick={() => setOpen(!open)} className="tap mt-2 flex items-center gap-1 text-[12px] font-bold text-muted">
        خرج‌های اخیر ({fund.recentSpends.length})<ChevronDown size={14} className={open ? 'rotate-180' : ''} />
      </button>
      {open && <ul className="mt-1 divide-y divide-line text-[12px]">
        {fund.recentSpends.map((spend) => <li key={spend.id} className="flex items-center justify-between gap-2 py-2">
          <span className="min-w-0 truncate">{spend.category} <span className="text-muted">· {persianDate(spend.occurredAt)}</span></span>
          <b className="numbers shrink-0">{formatAmount(spend.amount)}</b>
        </li>)}
      </ul>}
    </>}
  </article>;
}
