import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

function ReviewHistory({entryId}) {
  const [history,setHistory]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const load=async()=>{setLoading(true);setError('');try{setHistory(await api.journalReviewHistory(entryId));}catch(e){setError(e.message);}finally{setLoading(false);}};
  const body=entry=>{if(entry.speaker!=='assistant') return entry.body;try {const p=JSON.parse(entry.body);return [p.summary,p.explanation,...(p.missingFacts || [])].filter(Boolean).join(' — ');}catch{return entry.body;}};
  return <div className="border-t border-line pt-3 text-xs leading-6">
    <button disabled={loading} onClick={load} className="tap rounded border border-accent px-3 font-bold text-accent">{loading?'در حال خواندن…':'گفت‌وگوی ثبت و سابقهٔ DNA'}</button>
    {error && <p role="alert" className="text-expense">{error}</p>}
    {history && <div className="mt-3 space-y-2"><b>تاریخچهٔ تصمیم حسابدار برای همین سند</b>{!history.messages.length && <p>برای این سند گفت‌وگوی AI ثبت نشده است.</p>}{history.messages.map(m=><div key={m.id} className="rounded bg-paper p-3"><b>{m.speaker==='assistant'?'دستیار':m.speaker==='accepted'?'تأیید حسابدار':m.speaker==='rejected'?'رد با دلیل':'حسابدار'}</b> · {m.actorName || m.actor || ''} · {date(m.createdAt)}<p className="whitespace-pre-wrap">{body(m)}</p></div>)}</div>}
  </div>;
}
const date = (value) => value && !Number.isNaN(new Date(value).getTime()) ? new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'medium' }).format(new Date(value)) : '—';
// خواستهٔ مالک محصول: «ساعت و دقیقه باید ذکر بشه؛ ثبت‌کننده باید ذکر بشه» —
// زمانِ ثبت سند با ساعت و دقیقه، نه فقط تاریخ.
const dateTime = (value) => value && !Number.isNaN(new Date(value).getTime()) ? new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const kinds = { normal: 'عادی', reversal: 'معکوس', adjustment: 'اصلاحی', opening: 'افتتاحیه' };
const states = { draft: 'پیش‌نویس', submitted: 'در انتظار تأیید', returned: 'برگشت برای اصلاح', approved: 'تأییدشده' };
const badge = (state) => state === 'approved' ? 'bg-income/10 text-income' : state === 'returned' ? 'bg-expense/10 text-expense' : 'bg-paper text-muted';

/**
 * برگهٔ بازشوی سند — خواستهٔ مالک محصول (۲۶ مهر ۱۴۰۵):
 * «روی سند که می‌زنم می‌خوام باز بشه و جزئیاتش قشنگ نمایش داده بشه.»
 * کلیک روی هر ردیف دفتر، سند را در برگهٔ تمام‌جزئیات باز می‌کند:
 * همهٔ سطرهای بدهکار/بستانکار، زمان دقیق ثبت، ثبت‌کننده و سابقهٔ تأیید.
 */
function JournalDocumentSheet({ entry, close }) {
  const closeRef = useRef(null);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  const totals = (entry.lines || []).reduce((sum, line) => ({ debit: sum.debit + line.debit, credit: sum.credit + line.credit }), { debit: 0, credit: 0 });
  return <div className="fixed inset-0 z-[80] flex items-end justify-center bg-scrim/40 backdrop-blur-[2px] sm:items-center" onClick={close}>
    <section role="dialog" aria-modal="true" aria-label={`جزئیات سند شماره ${entry.documentNumber ?? '—'}`} onClick={(event) => event.stopPropagation()}
      className="sheet-in max-h-[92vh] w-full max-w-[760px] overflow-y-auto rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl sm:rounded-2xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="rounded-full bg-accent/10 px-2 py-1 text-xs font-extrabold text-accent">سند حسابداری</span>
          <h2 className="mt-2 text-lg font-extrabold">سند شماره {toPersianDigits(entry.documentNumber ?? '—')} · سال {toPersianDigits(entry.fiscalYear ?? '—')}</h2>
          <p className="mt-1 text-xs text-muted">{date(entry.occurredAt)} · {kinds[entry.entryKind] || entry.entryKind} · بازبینی {toPersianDigits(entry.revision)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={'rounded-md px-2 py-1 text-xs ' + badge(entry.approvalState)}>{entry.approvalLabel || states[entry.approvalState]}</span>
          <button ref={closeRef} onClick={close} aria-label="بستن" className="tap grid h-9 w-9 place-items-center rounded-lg border border-line hover:bg-paper hover:text-ink"><X size={17} /></button>
        </div>
      </div>

      {entry.memo && <p className="mt-3 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] leading-6">{toPersianDigits(entry.memo)}</p>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full min-w-[560px] text-sm">
        <thead className="bg-paper text-xs text-muted"><tr>{['ردیف', 'حساب و کدینگ', 'شرح / تفصیلی', 'بدهکار', 'بستانکار'].map((label) => <th key={label} className="p-3 text-right">{label}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{entry.lines.map((line, index) => <tr key={index}>
          <td className="p-3 text-muted">{toPersianDigits(index + 1)}</td>
          <td className="p-3"><p className="font-bold">{line.name}</p><p className="mt-1 text-xs text-muted">{toPersianDigits(line.code)}{line.chartCode ? ' · ' + toPersianDigits(line.chartCode) + ' ' + line.chartName : ' · بدون نگاشت کدینگ'}</p></td>
          <td className="p-3 text-xs leading-6">{line.description || '—'}{line.analyticName && <p>تفصیلی: {line.analyticName}</p>}{line.costCenterName && <p>مرکز هزینه: {line.costCenterName}</p>}</td>
          <td className="numbers p-3">{line.debit ? formatAmount(line.debit) : '—'}</td>
          <td className="numbers p-3">{line.credit ? formatAmount(line.credit) : '—'}</td>
        </tr>)}</tbody>
        <tfoot className="border-t-2 border-line bg-paper font-bold"><tr><td colSpan={3} className="p-3">جمع سند</td><td className="numbers p-3">{formatAmount(totals.debit)}</td><td className="numbers p-3">{formatAmount(totals.credit)}</td></tr></tfoot>
      </table></div>

      <p className={`mt-3 text-xs font-bold ${totals.debit === totals.credit ? 'text-income' : 'text-expense'}`}>{totals.debit === totals.credit ? '✓ بدهکار و بستانکار متوازن است.' : 'اختلاف سند: ' + formatAmount(Math.abs(totals.debit - totals.credit))}</p>

      <div className="mt-3 space-y-1.5 rounded-xl border border-line bg-surface p-3 text-xs leading-6">
        <p>زمان ثبت: <b className="numbers">{dateTime(entry.createdAt)}</b>{entry.createdByName && <> · ثبت‌کننده: <b>{entry.createdByName}</b></>}</p>
        {entry.submittedAt && <p>ارسال برای تأیید: <b className="numbers">{dateTime(entry.submittedAt)}</b>{entry.submittedByName && ` (${entry.submittedByName})`}</p>}
        {entry.reviewedAt && <p>بررسی: <b className="numbers">{dateTime(entry.reviewedAt)}</b>{entry.reviewedByName && ` (${entry.reviewedByName})`}</p>}
        {entry.returnReason && <p className="text-expense">دلیل برگشت: {entry.returnReason}</p>}
        <p className="break-all text-muted">منبع: {entry.sourceType} · {entry.sourceId}</p>
        {entry.reversesEntryId && <p className="break-all text-muted">معکوس سند: {entry.reversesEntryId}</p>}
        <p className="break-all text-muted">شناسه سند: {entry.id}</p>
      </div>

      <div className="mt-3">
        <ReviewHistory key={entry.id} entryId={entry.id} />
      </div>
    </section>
  </div>;
}

export default function JournalExplorer({ revision, workspaceId }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, pages: 1 });
  const [openEntry, setOpenEntry] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => { setPage(1); setOpenEntry(null); }, [workspaceId]);
  useEffect(() => {
    let active = true;
    setLoading(true); setOpenEntry(null); setError(''); setData({ items: [], total: 0, pages: 1 });
    api.journal({ page, limit: 100, search, approvalState: state }).then((result) => {
      if (active) setData(result);
    }).catch((cause) => { if (active) setError(cause.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, search, state, revision, workspaceId, retry]);
  return <section className="mt-5 space-y-4" aria-label="اسناد حسابداری" dir="rtl">
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-extrabold">اسناد حسابداری</h2><p className="mt-1 text-xs leading-6 text-muted">روی هر سند کلیک کنید تا با همهٔ جزئیات — سطرها، زمان ثبت و سابقهٔ تأیید — باز شود. مبالغ به تومان است.</p></div><span className="rounded-lg bg-paper px-3 py-2 text-sm">{toPersianDigits(data.total)} سند</span></div>
      <form className="mt-4 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(query); }}>
        <input aria-label="جست‌وجوی سند" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="شماره سند، شرح یا شناسه منبع…" className="tap min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 text-sm" />
        <button className="tap rounded-lg bg-accent px-4 text-sm font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">جست‌وجو</button>
        <select aria-label="وضعیت سند" value={state} onChange={(event) => { setState(event.target.value); setPage(1); }} className="tap rounded-lg border border-line bg-surface px-3 text-sm"><option value="">همه وضعیت‌ها</option>{Object.entries(states).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      </form>
    </div>
    {error ? <div role="alert" className="rounded-xl border border-expense p-4 text-sm text-expense">{error}<button onClick={() => setRetry(retry + 1)} className="tap mr-4 underline">تلاش دوباره</button></div> : loading ? <p role="status" className="p-6 text-center text-muted">در حال دریافت اسناد…</p> : !data.items.length ? <p className="rounded-xl border border-dashed border-line p-8 text-center text-muted">سندی با این شرایط پیدا نشد. تراکنش‌های صف بررسی هنوز سند نهایی نیستند.</p> : <>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full min-w-[860px] text-sm"><thead className="bg-paper text-xs text-muted"><tr>{['شماره / سال مالی', 'تاریخ سند', 'زمان ثبت', 'ثبت‌کننده', 'شرح سند', 'وضعیت', 'جمع بدهکار'].map((label) => <th key={label} className="p-3 text-right">{label}</th>)}</tr></thead><tbody className="divide-y divide-line">{data.items.map((entry) => <tr key={entry.id} onClick={() => setOpenEntry(entry)} className="cursor-pointer transition-colors hover:bg-paper">
        <td className="p-3"><button aria-haspopup="dialog" onClick={(event) => { event.stopPropagation(); setOpenEntry(entry); }} className="tap whitespace-nowrap font-bold text-accent underline underline-offset-4">{toPersianDigits(entry.documentNumber ?? '—')} / {toPersianDigits(entry.fiscalYear ?? '—')}</button></td>
        <td className="whitespace-nowrap p-3 text-xs">{date(entry.occurredAt)}</td>
        <td className="whitespace-nowrap p-3 text-xs text-muted">{dateTime(entry.createdAt)}</td>
        <td className="whitespace-nowrap p-3 text-xs">{entry.createdByName || '—'}</td>
        <td className="max-w-[280px] p-3 leading-6">{toPersianDigits(entry.memo || 'بدون شرح')}</td>
        <td className="p-3"><span className={'whitespace-nowrap rounded-md px-2 py-1 text-xs ' + badge(entry.approvalState)}>{entry.approvalLabel || states[entry.approvalState]}</span></td>
        <td className="numbers p-3">{formatAmount(entry.lines.reduce((sum, line) => sum + line.debit, 0))}</td>
      </tr>)}</tbody></table></div>
      <div className="flex items-center justify-between text-xs"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="tap rounded-lg border border-line px-4 disabled:opacity-40">قبلی</button><span>صفحه {toPersianDigits(page)} از {toPersianDigits(data.pages)}</span><button disabled={page >= data.pages} onClick={() => setPage(page + 1)} className="tap rounded-lg border border-line px-4 disabled:opacity-40 hover:bg-paper hover:text-ink">بعدی</button></div>
    </>}
    {openEntry && <JournalDocumentSheet entry={openEntry} close={() => setOpenEntry(null)} />}
  </section>;
}
