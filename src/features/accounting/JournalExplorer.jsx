import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

function ReviewHistory({entryId}) {
  const [history,setHistory]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const load=async()=>{setLoading(true);setError('');try{setHistory(await api.journalReviewHistory(entryId));}catch(e){setError(e.message);}finally{setLoading(false);}};
  const body=entry=>{if(entry.speaker!=='assistant') return entry.body;try {const p=JSON.parse(entry.body);return [p.summary,p.explanation,...(p.missingFacts || [])].filter(Boolean).join(' — ');}catch{return entry.body;}};
  return <div className="border-t border-line p-4 text-xs leading-6">
    <button disabled={loading} onClick={load} className="tap rounded border border-accent px-3 font-bold text-accent">{loading?'در حال خواندن…':'گفت‌وگوی ثبت و سابقه DNA'}</button>
    {error && <p role="alert" className="text-expense">{error}</p>}
    {history && <div className="mt-3 space-y-2"><b>تاریخچهٔ تصمیم حسابدار برای همین سند</b>{!history.messages.length && <p>برای این سند گفت‌وگوی AI ثبت نشده است.</p>}{history.messages.map(m=><div key={m.id} className="rounded bg-paper p-3"><b>{m.speaker==='assistant'?'دستیار':m.speaker==='accepted'?'تأیید حسابدار':m.speaker==='rejected'?'رد با دلیل':'حسابدار'}</b> · {m.actorName || m.actor || ''} · {date(m.createdAt)}<p className="whitespace-pre-wrap">{body(m)}</p></div>)}</div>}
  </div>;
}
const date = (value) => value && !Number.isNaN(new Date(value).getTime()) ? new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'medium' }).format(new Date(value)) : '—';
const kinds = { normal: 'عادی', reversal: 'معکوس', adjustment: 'اصلاحی', opening: 'افتتاحیه' };
const states = { draft: 'پیش‌نویس', submitted: 'در انتظار تأیید', returned: 'برگشت برای اصلاح', approved: 'تأییدشده' };
const badge = (state) => state === 'approved' ? 'bg-income/10 text-income' : state === 'returned' ? 'bg-expense/10 text-expense' : 'bg-paper text-muted';

export default function JournalExplorer({ revision, workspaceId }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, pages: 1 });
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => { setPage(1); setSelected(null); }, [workspaceId]);
  useEffect(() => {
    let active = true;
    setLoading(true); setSelected(null); setError(''); setData({ items: [], total: 0, pages: 1 });
    api.journal({ page, limit: 20, search, approvalState: state }).then((result) => {
      if (active) { setData(result); setSelected(result.items[0] || null); }
    }).catch((cause) => { if (active) setError(cause.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, search, state, revision, workspaceId, retry]);
  const totals = (selected?.lines || []).reduce((sum, line) => ({ debit: sum.debit + line.debit, credit: sum.credit + line.credit }), { debit: 0, credit: 0 });
  return <section className="mt-5 space-y-4" aria-label="اسناد حسابداری" dir="rtl">
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-extrabold">اسناد حسابداری</h2><p className="mt-1 text-xs leading-6 text-muted">سند را انتخاب کنید تا حساب‌ها، مبالغ و سابقهٔ تأیید آن را ببینید. مبالغ به تومان است.</p></div><span className="rounded-lg bg-paper px-3 py-2 text-sm">{toPersianDigits(data.total)} سند</span></div>
      <form className="mt-4 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(query); }}>
        <input aria-label="جست‌وجوی سند" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="شماره سند، شرح یا شناسه منبع…" className="tap min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 text-sm" />
        <button className="tap rounded-lg bg-accent px-4 text-sm font-bold text-white">جست‌وجو</button>
        <select aria-label="وضعیت سند" value={state} onChange={(event) => { setState(event.target.value); setPage(1); }} className="tap rounded-lg border border-line bg-surface px-3 text-sm"><option value="">همه وضعیت‌ها</option>{Object.entries(states).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      </form>
    </div>
    {error ? <div role="alert" className="rounded-xl border border-expense p-4 text-sm text-expense">{error}<button onClick={() => setRetry(retry + 1)} className="tap mr-4 underline">تلاش دوباره</button></div> : loading ? <p role="status" className="p-6 text-center text-muted">در حال دریافت اسناد…</p> : !data.items.length ? <p className="rounded-xl border border-dashed border-line p-8 text-center text-muted">سندی با این شرایط پیدا نشد. تراکنش‌های صف بررسی هنوز سند نهایی نیستند.</p> : <>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full min-w-[650px] text-sm"><thead className="bg-paper text-xs text-muted"><tr>{['شماره / سال مالی', 'تاریخ', 'شرح سند', 'وضعیت', 'جمع بدهکار'].map((label) => <th key={label} className="p-3 text-right">{label}</th>)}</tr></thead><tbody className="divide-y divide-line">{data.items.map((entry) => <tr key={entry.id} className={selected?.id === entry.id ? 'bg-accent/5' : ''}><td className="p-3"><button aria-pressed={selected?.id === entry.id} onClick={() => setSelected(entry)} className="tap whitespace-nowrap font-bold text-accent underline underline-offset-4">{toPersianDigits(entry.documentNumber ?? '—')} / {toPersianDigits(entry.fiscalYear ?? '—')}</button></td><td className="whitespace-nowrap p-3 text-xs">{date(entry.occurredAt)}</td><td className="max-w-[280px] p-3 leading-6">{entry.memo || 'بدون شرح'}</td><td className="p-3"><span className={'whitespace-nowrap rounded-md px-2 py-1 text-xs ' + badge(entry.approvalState)}>{entry.approvalLabel || states[entry.approvalState]}</span></td><td className="numbers p-3">{formatAmount(entry.lines.reduce((sum, line) => sum + line.debit, 0))}</td></tr>)}</tbody></table></div>
      <div className="flex items-center justify-between text-xs"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="tap rounded-lg border border-line px-4 disabled:opacity-40">قبلی</button><span>صفحه {toPersianDigits(page)} از {toPersianDigits(data.pages)}</span><button disabled={page >= data.pages} onClick={() => setPage(page + 1)} className="tap rounded-lg border border-line px-4 disabled:opacity-40">بعدی</button></div>
      {selected && <article className="overflow-hidden rounded-xl border border-line bg-surface" aria-label="جزئیات سند">
        <header className="border-b border-line bg-paper p-4"><div className="flex flex-wrap justify-between gap-3"><h3 className="font-extrabold">سند شماره {toPersianDigits(selected.documentNumber ?? '—')} · سال {toPersianDigits(selected.fiscalYear ?? '—')}</h3><span className={'rounded-md px-2 py-1 text-xs ' + badge(selected.approvalState)}>{selected.approvalLabel}</span></div><p className="mt-3 text-sm leading-7">{selected.memo || 'بدون شرح'}</p><p className="mt-2 text-xs text-muted">{date(selected.occurredAt)} · {kinds[selected.entryKind] || selected.entryKind} · بازبینی {toPersianDigits(selected.revision)}</p></header>
        <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead className="text-xs text-muted"><tr>{['ردیف', 'حساب و کدینگ', 'شرح / تفصیلی', 'بدهکار', 'بستانکار'].map((label) => <th key={label} className="p-3 text-right">{label}</th>)}</tr></thead><tbody className="divide-y divide-line">{selected.lines.map((line, index) => <tr key={index}><td className="p-3 text-muted">{toPersianDigits(index + 1)}</td><td className="p-3"><p className="font-bold">{line.name}</p><p className="mt-1 text-xs text-muted">{toPersianDigits(line.code)}{line.chartCode ? ' · ' + toPersianDigits(line.chartCode) + ' ' + line.chartName : ' · بدون نگاشت کدینگ'}</p></td><td className="p-3 text-xs leading-6">{line.description || '—'}{line.analyticName && <p>تفصیلی: {line.analyticName}</p>}{line.costCenterName && <p>مرکز هزینه: {line.costCenterName}</p>}</td><td className="numbers p-3">{line.debit ? formatAmount(line.debit) : '—'}</td><td className="numbers p-3">{line.credit ? formatAmount(line.credit) : '—'}</td></tr>)}</tbody><tfoot className="border-t-2 border-line bg-paper font-bold"><tr><td colSpan={3} className="p-3">جمع سند</td><td className="numbers p-3">{formatAmount(totals.debit)}</td><td className="numbers p-3">{formatAmount(totals.credit)}</td></tr></tfoot></table></div>
        <div className="space-y-2 border-t border-line p-4 text-xs leading-6"><p className={totals.debit === totals.credit ? 'text-income' : 'text-expense'}>{totals.debit === totals.credit ? 'بدهکار و بستانکار متوازن است.' : 'اختلاف سند: ' + formatAmount(Math.abs(totals.debit - totals.credit))}</p><p>ایجاد: {date(selected.createdAt)}{selected.submittedAt && ' · ارسال برای تأیید: ' + date(selected.submittedAt)}{selected.reviewedAt && ' · بررسی: ' + date(selected.reviewedAt)}</p>{selected.returnReason && <p className="text-expense">دلیل برگشت: {selected.returnReason}</p>}<p className="break-all text-muted">منبع: {selected.sourceType} · {selected.sourceId}</p>{selected.reversesEntryId && <p className="break-all text-muted">معکوس سند: {selected.reversesEntryId}</p>}<p className="break-all text-muted">شناسه سند: {selected.id}</p></div>
        <ReviewHistory key={selected.id} entryId={selected.id} />
      </article>}
    </>}
  </section>;
}
