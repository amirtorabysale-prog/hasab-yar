import { BellRing, CalendarClock, CheckCheck, ChevronDown, ChevronUp, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits } from '../../lib/format.js';
import { coverageDate, periodKeyLabel } from '../../components/RecognitionNote.jsx';

/**
 * پیش‌پرداخت و پیش‌دریافت — همهٔ قراردادهای دوره‌دار در یک جا.
 *
 * مالک محصول (۲۳ مهر ۱۴۰۵): «یک بخش مشخص که معلوم باشد و هرکدام سر تایم خودش برود
 * توی هزینه یا درآمد، با اعلام به حسابدار». اقلام را سرور هر ماه خودش ثبت می‌کند؛
 * این صفحه نشان می‌دهد چه مانده، قسط بعدی کی است، و خبرِ ماهانهٔ ثبت‌ها را برای
 * حسابدار می‌آورد. آنچه خودکار ثبت نمی‌شود (ماه بسته، ماندهٔ کم، ماندهٔ بی‌برنامه)
 * جدا در «نیاز به اقدام حسابدار» می‌آید.
 */

const STATE_LABELS = {
  active: ['در جریان', 'text-accent'], done: ['تمام‌شده', 'text-income'], attention: ['نیاز به حسابدار', 'text-expense'],
  pending: ['منتظر تأیید', 'text-muted'], cancelled: ['لغوشده', 'text-muted'],
};
const ITEM_LABELS = { planned: 'برنامه', posted: 'ثبت شد', 'blocked-closed-period': 'ماه بسته', held: 'نگه‌داشته' };
const SOURCE_LABELS = { transaction: 'ثبت روزانه', 'invoice-line': 'فاکتور', cheque: 'چک', obligation: 'طلب و بدهی', balance: 'ماندهٔ دفتر', event: 'ثبت' };

function NoticeCard({ notice, onSeen }) {
  const total = notice.expenseAmount + notice.incomeAmount;
  return <article className={`rounded-xl border p-3 ${notice.seenAt ? 'border-line bg-surface' : 'border-accent bg-accent/5'}`}>
    <div className="flex items-start gap-3">
      <BellRing size={18} className={notice.seenAt ? 'mt-0.5 text-muted' : 'mt-0.5 text-accent'} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">{periodKeyLabel(notice.periodKey)}: {toPersianDigits(notice.postedItems)} قسط خودکار ثبت شد</p>
        <p className="mt-1 text-xs leading-6 text-muted">
          {notice.expenseAmount > 0 && <>هزینه {formatAmount(notice.expenseAmount)} تومان</>}
          {notice.expenseAmount > 0 && notice.incomeAmount > 0 && ' · '}
          {notice.incomeAmount > 0 && <>درآمد {formatAmount(notice.incomeAmount)} تومان</>}
          {!total && 'بدون مبلغ'}
        </p>
        <p className="mt-1 text-xs leading-6 text-muted">
          {notice.contracts.slice(0, 3).map((contract) => `${contract.title} (${formatAmount(contract.amount)})`).join('، ')}
          {notice.contracts.length > 3 && ` و ${toPersianDigits(notice.contracts.length - 3)} قرارداد دیگر`}
        </p>
      </div>
      {notice.seenAt
        ? <span className="flex items-center gap-1 text-xs text-muted"><CheckCheck size={14} />دیده شد</span>
        : <button onClick={() => onSeen(notice.periodKey)} className="tap shrink-0 rounded-lg border border-accent px-3 text-xs font-bold text-accent">دیدم</button>}
    </div>
  </article>;
}

function ContractRow({ item }) {
  const [open, setOpen] = useState(false);
  const [label, tone] = STATE_LABELS[item.state] || STATE_LABELS.active;
  const progress = item.total ? Math.round((item.recognized / item.total) * 100) : 0;
  return <article className="py-3">
    <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 text-right">
      <CalendarClock size={19} className="mt-1 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <p className="font-bold">{item.title}</p>
        <p className="mt-1 text-xs text-muted">
          {item.periodFrom ? `${periodKeyLabel(item.periodFrom)} تا ${periodKeyLabel(item.periodTo)}` : '—'} · {toPersianDigits(item.postedInstalments)} از {toPersianDigits(item.instalments)} قسط · {SOURCE_LABELS[item.source] || 'ثبت'}
        </p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"><div className={`h-full ${item.kind === 'deferred' ? 'bg-income' : 'bg-accent'}`} style={{ width: `${progress}%` }} /></div>
        <p className="mt-2 text-xs text-muted">
          {item.next && item.state !== 'cancelled'
            ? <>قسط بعدی: {periodKeyLabel(item.next.periodKey)} — {formatAmount(item.next.amount)} تومان{item.next.status !== 'planned' && <b className="text-expense"> ({ITEM_LABELS[item.next.status]})</b>}</>
            : item.state === 'done' ? 'همهٔ قسط‌ها ثبت شده است.' : ''}
        </p>
      </div>
      <div className="shrink-0 text-left">
        <b className="numbers block text-sm">{formatAmount(item.remaining)}</b>
        <span className="block text-xs text-muted">مانده از {formatAmount(item.total)}</span>
        <span className={`mt-1 block text-xs font-bold ${tone}`}>{label}</span>
      </div>
      {open ? <ChevronUp size={16} className="mt-1 text-muted" /> : <ChevronDown size={16} className="mt-1 text-muted" />}
    </button>
    {open && <div className="mr-8 mt-3 space-y-2 rounded-xl border border-line bg-surface p-3 text-xs">
      {item.account && <p className="text-muted">حساب: <b className="text-ink">{item.account}</b></p>}
      {item.evidence && <p className="leading-6 text-muted">«{item.evidence}»</p>}
      <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1">
        {item.items.map((row) => <div key={row.key} className="contents">
          <span>{periodKeyLabel(row.periodKey)}</span>
          <span className="text-muted">{row.recognitionDate ? coverageDate(row.recognitionDate) : ''}</span>
          <span className={`numbers ${row.status === 'posted' ? 'text-income' : row.status === 'planned' ? 'text-muted' : 'text-expense'}`}>{formatAmount(row.amount)} · {ITEM_LABELS[row.status] || row.status}</span>
        </div>)}
      </div>
    </div>}
  </article>;
}

function ContractList({ title, hint, items, emptyText }) {
  return <div>
    <div className="mb-2 flex items-baseline justify-between"><h3 className="font-extrabold">{title}</h3><span className="text-xs text-muted">{toPersianDigits(items.length)} قرارداد</span></div>
    <p className="mb-2 text-xs leading-6 text-muted">{hint}</p>
    <div className="divide-y divide-line border-y border-line">{items.length ? items.map((item) => <ContractRow key={item.eventId} item={item} />) : <p className="py-8 text-center text-sm text-muted">{emptyText}</p>}</div>
  </div>;
}

export function TimingContractsPanel({ notify }) {
  const [data, setData] = useState(null);
  const [showClosed, setShowClosed] = useState(false);
  const load = useCallback(() => api.timingContracts().then(setData).catch((error) => notify(error.message)), [notify]);
  useEffect(() => { load(); }, [load]);
  const seen = async (periodKey) => {
    try { await api.seeRecognitionNotice(periodKey); notify('خبر این ماه دیده شد.'); load(); } catch (error) { notify(error.message); }
  };
  if (!data) return <p className="mt-6 text-sm text-muted">در حال خواندن قراردادها…</p>;
  return <TimingContractsView data={data} showClosed={showClosed} onToggleClosed={setShowClosed} onSeen={seen} />;
}

/** نمای خالص بخش، برای آزمون رندر با دادهٔ واقعی. */
export function TimingContractsView({ data, showClosed = false, onToggleClosed = () => {}, onSeen = () => {} }) {
  const seen = onSeen;
  const setShowClosed = onToggleClosed;
  const visible = data.items.filter((item) => showClosed || !['cancelled', 'done'].includes(item.state));
  const prepaid = visible.filter((item) => item.kind === 'prepaid');
  const deferred = visible.filter((item) => item.kind === 'deferred');
  const unseen = data.notices.filter((notice) => !notice.seenAt);
  const { blocked, held, unscheduled } = data.attention;
  const attentionCount = blocked.length + held.length + unscheduled.length;
  return <section className="mt-5 space-y-6">
    <div>
      <h2 className="font-extrabold">پیش‌پرداخت و پیش‌دریافت</h2>
      <p className="mt-1 text-sm leading-7 text-muted">پولی که برای ماه‌های آینده داده یا گرفته شده، ماه‌به‌ماه سر موعد خودش هزینه یا درآمد می‌شود. ثبت هر ماه خودکار است و حسابدار خبرش را همین‌جا و در صف بررسی می‌بیند.</p>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">ماندهٔ پیش‌پرداخت‌ها</p><b className="numbers mt-2 block text-base sm:text-lg">{formatAmount(data.summary.prepaidRemaining)}</b><span className="text-xs text-muted">تومان · {toPersianDigits(data.summary.prepaidActive)} قرارداد در جریان</span></div>
      <div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">ماندهٔ پیش‌دریافت‌ها</p><b className="numbers mt-2 block text-base sm:text-lg">{formatAmount(data.summary.deferredRemaining)}</b><span className="text-xs text-muted">تومان · {toPersianDigits(data.summary.deferredActive)} قرارداد در جریان</span></div>
    </div>
    {data.notices.length > 0 && <div className="space-y-2">
      <h3 className="font-extrabold">خبر ثبت‌های ماهانه {unseen.length > 0 && <span className="text-xs font-bold text-accent">({toPersianDigits(unseen.length)} دیده‌نشده)</span>}</h3>
      {data.notices.slice(0, 4).map((notice) => <NoticeCard key={notice.periodKey} notice={notice} onSeen={seen} />)}
    </div>}
    {attentionCount > 0 && <div className="rounded-xl border border-expense/40 bg-warn-bg/50 p-3">
      <p className="flex items-center gap-2 text-sm font-extrabold text-expense"><TriangleAlert size={17} />نیاز به اقدام حسابدار ({toPersianDigits(attentionCount)})</p>
      <ul className="mt-2 space-y-1 text-xs leading-6">
        {blocked.map((item) => <li key={item.key}>قسط {periodKeyLabel(item.periodKey)} «{[item.category, item.counterparty].filter(Boolean).join(' — ')}» ({formatAmount(item.amount)} تومان): {item.reason}</li>)}
        {held.map((item) => <li key={item.key}>قسط {periodKeyLabel(item.periodKey)} ({formatAmount(item.amount)} تومان) نگه داشته شد: {item.reason}</li>)}
        {unscheduled.map((item) => <li key={item.accountId}>{item.wrongSign
          ? <>«{item.accountName}» ماندهٔ وارونه دارد ({formatAmount(Math.abs(item.balance || 0))} تومان)؛ سندی بیرون از برنامه آن را جابه‌جا کرده و باید اصلاح شود.</>
          : <>«{item.accountName}» {formatAmount(item.residual || 0)} تومان مانده دارد که برنامهٔ ماهانه ندارد؛ دوره‌اش را حسابدار در صف بررسی می‌دهد.</>}</li>)}
      </ul>
      <p className="mt-2 text-xs text-muted">این موارد در «صف بررسی حسابدار» با دکمهٔ اقدام آمده‌اند.</p>
    </div>}
    <ContractList title="پیش‌پرداخت‌ها" hint="پولی که برای پوشش آینده داده‌ایم (بیمه، اجاره، اشتراک و …). دارایی است و ماه‌به‌ماه هزینه می‌شود." items={prepaid} emptyText="پیش‌پرداخت در جریانی نیست." />
    <ContractList title="پیش‌دریافت‌ها" hint="پولی که برای خدمت آینده گرفته‌ایم (اجارهٔ مستاجر، پشتیبانی، اشتراک). بدهی است و ماه‌به‌ماه درآمد می‌شود." items={deferred} emptyText="پیش‌دریافت در جریانی نیست." />
    <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} />قراردادهای تمام‌شده و لغوشده را هم نشان بده</label>
  </section>;
}
