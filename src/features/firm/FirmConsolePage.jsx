import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

const FIRM_LEVEL_STYLE = {
  blocked: { badge: 'border-expense/40 bg-expense/10 text-expense', dot: 'bg-expense' },
  attention: { badge: 'border-accent/40 bg-accent/10 text-accent', dot: 'bg-accent' },
  ready: { badge: 'border-income/40 bg-income/10 text-income', dot: 'bg-income' },
  unknown: { badge: 'border-line bg-surface text-muted', dot: 'bg-muted' },
};

const FIRM_BATCH_LABELS = { generated: 'ساخته شده', delivered: 'تحویل شده', accepted: 'تأیید شده', rejected: 'رد شده' };

export function FirmSummaryTile({ label, value, hint, tone = '' }) {
  return <div className="rounded-xl border border-line bg-surface px-3 py-3">
    <p className="text-[12px] text-muted">{label}</p>
    <p className={`numbers mt-1 text-2xl font-extrabold ${tone}`}>{value}</p>
    {hint && <p className="mt-1 text-xs leading-5 text-muted">{hint}</p>}
  </div>;
}

function FirmClientRow({ client, onOpen, isActive }) {
  const style = FIRM_LEVEL_STYLE[client.level] || FIRM_LEVEL_STYLE.unknown;
  const batch = client.delivery?.lastBatch || null;
  return <article className="grid gap-3 border-b border-line py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] lg:items-start">
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
        <p className="truncate font-extrabold">{client.workspace?.name || 'بدون نام'}</p>
        {isActive && <span className="rounded border border-line px-1.5 text-xs font-bold text-muted">دفتر فعال</span>}
      </div>
      <p className="mt-1 text-[12px] text-muted">
        <span className={`inline-block rounded border px-1.5 py-0.5 font-bold ${style.badge}`}>{client.levelLabel}</span>
        {client.periodLocked && <span className="mr-2">· دوره قفل است</span>}
        {client.idleDays == null
          ? <span className="mr-2">· هنوز فعالیتی ثبت نشده</span>
          : <span className="mr-2">· آخرین فعالیت {toPersianDigits(client.idleDays)} روز پیش</span>}
      </p>
    </div>
    <div className="min-w-0 text-[12px] leading-6">
      {client.error && <p className="text-expense">{client.error}</p>}
      {!client.error && !client.blockers.length && !client.warnings.length && <p className="text-muted">هیچ کار بازی روی این پرونده نیست.</p>}
      <div className="flex flex-wrap gap-1.5">
        {client.blockers.map((item) => <span key={item.id} className="rounded border border-expense/40 bg-expense/10 px-2 py-0.5 font-bold text-expense">{item.label}{item.count > 1 && <span className="numbers"> · {toPersianDigits(item.count)}</span>}</span>)}
        {client.warnings.map((item) => <span key={item.id} className="rounded border border-line bg-surface px-2 py-0.5 text-muted">{item.label}{item.id !== 'stale' && item.count > 1 && <span className="numbers"> · {toPersianDigits(item.count)}</span>}</span>)}
      </div>
      {client.activity && <p className="mt-2 text-xs text-muted">
        <span className="numbers">{toPersianDigits(client.activity.transactionCount)}</span> ثبت این ماه ·
        درآمد <b className="numbers text-income">{formatAmount(client.activity.income)}</b> ·
        هزینه <b className="numbers text-expense">{formatAmount(client.activity.expense)}</b>
      </p>}
      {batch && <p className="mt-1 text-xs text-muted">آخرین خروجی {batch.period} — {FIRM_BATCH_LABELS[batch.status] || batch.status}</p>}
    </div>
    <button onClick={() => onOpen(client.workspace?.id)} disabled={isActive} className="tap h-10 shrink-0 rounded-lg border border-line bg-surface px-4 text-sm font-bold disabled:opacity-45 hover:bg-paper hover:text-ink">
      {isActive ? 'همین‌جا هستی' : 'باز کردن پرونده'}
    </button>
  </article>;
}

/** ساخت پروندهٔ مشتری تازه از داخل میز کار، بدون رفتن به تنظیمات. */
function AddClientForm({ notify, onAdded }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.createWorkspace({ name, profileType: 'business' });
      setName('');
      await onAdded();
      notify('پروندهٔ مشتری ساخته شد.');
    } catch (error) { notify(error.message); }
    setBusy(false);
  };
  return <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
    <input required minLength={2} value={name} onChange={(event) => setName(event.target.value)} placeholder="نام شرکت مشتری" className="tap min-w-52 flex-1 rounded-lg border border-line bg-paper px-3 text-[13px]" />
    <button disabled={busy} className="tap rounded-lg bg-accent px-4 text-sm font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90 active:bg-accent/80">{busy ? 'در حال ساخت…' : 'افزودن پروندهٔ مشتری'}</button>
  </form>;
}

export function FirmConsolePage({ access, notify, switchWorkspace, refreshAccess }) {
  const [portfolio, setPortfolio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      setPortfolio(await api.firmPortfolio({ refresh }));
      setError('');
    } catch (failure) { setError(failure.message || 'خواندن میز کار ممکن نشد.'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(false); }, [load]);

  const summary = portfolio?.summary;
  const clients = portfolio?.clients || [];
  const activeId = access?.workspace?.id;

  return <section className="mx-auto max-w-[1100px] px-4 py-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-[13px] font-bold text-accent">میز کار دفتر حسابداری</p>
        <h1 className="mt-1 text-xl font-extrabold">امروز کدام پرونده کار دارد؟</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
          فقط پرونده‌هایی که عضو آن‌ها هستی دیده می‌شوند. ترتیب بر اساس فوریت است، نه الفبا. ارقام تا آخرین بازخوانی معتبرند و ادعای تأیید مالیاتی ندارند.
        </p>
      </div>
      <button onClick={() => load(true)} disabled={loading} className="tap h-10 rounded-lg border border-line bg-surface px-4 text-sm font-bold disabled:opacity-45 hover:bg-paper hover:text-ink">
        {loading ? 'در حال بازخوانی…' : 'بازخوانی وضعیت'}
      </button>
    </div>

    {error && <p className="mt-4 rounded-lg border border-expense/40 bg-expense/10 px-3 py-2 text-sm font-bold text-expense">{error}</p>}

    {summary && <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <FirmSummaryTile label="پروندهٔ من" value={toPersianDigits(summary.clientCount)} hint={summary.unavailableCount ? `${toPersianDigits(summary.unavailableCount)} پرونده خوانده نشد` : ''} />
      <FirmSummaryTile label="نیازمند رفع ایراد" value={toPersianDigits(summary.blocked)} tone="text-expense" hint="تا رفع نشوند، تحویل ماه معنا ندارد" />
      <FirmSummaryTile label="در انتظار کنترل" value={toPersianDigits(summary.attention)} tone="text-accent" hint="ثبت بررسی‌نشده یا پاسخ کنترل‌نشده" />
      <FirmSummaryTile
        label="آمادهٔ تحویل" value={toPersianDigits(summary.ready)} tone="text-income"
        hint={summary.readyPercent == null ? 'هنوز پروندهٔ قابل اندازه‌گیری نیست' : `${toPersianDigits(summary.readyPercent)}٪ از پرونده‌های اندازه‌گیری‌شده`}
      />
    </div>}

    {summary?.topBlockers?.length > 0 && <div className="mt-4 rounded-xl border border-line bg-surface px-3 py-3">
      <p className="text-[12px] font-bold text-muted">تکرارشونده‌ترین ایرادها در کل دفتر</p>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[12px]">
        {summary.topBlockers.map((item) => <span key={item.id} className="rounded border border-line bg-paper px-2 py-0.5">
          {item.label} · <b className="numbers">{toPersianDigits(item.clients)}</b> پرونده
        </span>)}
      </div>
    </div>}

    {!loading && clients.length <= 1 && <div className="mt-5 rounded-xl border border-accent/40 bg-warn-bg px-4 py-4">
      <p className="font-bold text-accent">میز کار وقتی می‌درخشد که چند پروندهٔ مشتری داشته باشی.</p>
      <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
        هر مشتری یک پروندهٔ کاملاً جدا با دیتابیس مستقل می‌گیرد. از همین‌جا پرونده بساز؛ بعد می‌توانی از تنظیمات، همکارانت را با نقش حسابدار یا فقط‌مشاهده به هر پرونده اضافه کنی.
      </p>
      <AddClientForm notify={notify} onAdded={async () => { await refreshAccess?.(); await load(true); }} />
    </div>}

    <div className="mt-6 border-t border-line">
      {loading && !portfolio && <p className="py-8 text-center text-sm text-muted">در حال خواندن پرونده‌ها…</p>}
      {!loading && !clients.length && <p className="py-8 text-center text-sm text-muted">هنوز پرونده‌ای به تو داده نشده است.</p>}
      {clients.map((client) => <FirmClientRow
        key={client.workspace?.id} client={client} isActive={client.workspace?.id === activeId}
        onOpen={async (id) => { await switchWorkspace(id); notify('پروندهٔ مشتری باز شد.'); }}
      />)}
    </div>

    {portfolio && <p className="mt-4 text-xs leading-5 text-muted">
      این خلاصه هر ۵ دقیقه بازسازی می‌شود؛ برای دیدن لحظهٔ دقیق، «بازخوانی وضعیت» را بزن. پروندهٔ خوانده‌نشده با وضعیت «نامشخص» می‌ماند و عددش صفر فرض نمی‌شود.
    </p>}
  </section>;
}
