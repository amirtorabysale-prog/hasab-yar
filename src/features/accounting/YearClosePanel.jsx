import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits, unitLabel } from '../../lib/format.js';

const SOURCE_LABEL = { hesabyar: 'ساخته می‌شود', parsian: 'از بکاپ پارسیان' };

/**
 * بستن سال مالی: پیش‌نمایش سه سند (موقت، اختتامیه، افتتاحیه)، مانع‌ها با دلیل، انتخاب معین
 * «سود (زیان) انباشته» وقتی کدینگ آن را مشخص نمی‌کند، و بازگشایی با دلیل. فقط مالک می‌بندد.
 */
export default function YearClosePanel({ isOwner, notify, refresh }) {
  const [years, setYears] = useState([]);
  const [year, setYear] = useState('');
  const [retained, setRetained] = useState('');
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.accountingReportYears().then((result) => {
      const list = (result.years || []).map((item) => item.year);
      setYears(list);
      // پیش‌فرض: قدیمی‌ترین سالی که هنوز بسته نشده؛ همان که اول باید بسته شود.
      setYear((current) => current || String(list.at(-1) || result.currentYear || ''));
    }).catch((error) => notify(error.message));
  }, [notify]);

  const load = useCallback(async () => {
    if (!year) return;
    try { setPlan(await api.previewYearClose(year, retained)); } catch (error) { notify(error.message); }
  }, [year, retained, notify]);
  useEffect(() => { load(); }, [load]);

  const close = async () => {
    if (!window.confirm(`سال ${toPersianDigits(year)} بسته شود؟ سند بستن حساب‌های موقت، اختتامیه و افتتاحیهٔ سال بعد ثبت و دوازده دورهٔ سال قفل می‌شود.`)) return;
    setBusy(true);
    try {
      const result = await api.closeFiscalYear(year, retained);
      notify(`سال ${toPersianDigits(year)} بسته شد؛ ${result.profit >= 0 ? 'سود' : 'زیان'} ${formatAmount(Math.abs(result.profit))} ${unitLabel()} به انباشته رفت.`);
      await Promise.all([load(), refresh()]);
    } catch (error) { notify(error.message); }
    setBusy(false);
  };
  const reopen = async () => {
    const reason = window.prompt('دلیل بازگشایی سال را دقیق ثبت کن (حداقل ۱۰ نویسه). سه سند بستن با سند معکوس خنثی می‌شوند.');
    if (!reason) return;
    setBusy(true);
    try { await api.reopenFiscalYear(year, reason); notify(`سال ${toPersianDigits(year)} بازگشایی شد.`); await Promise.all([load(), refresh()]); }
    catch (error) { notify(error.message); }
    setBusy(false);
  };

  const closed = Boolean(plan?.closed);
  const needsRetained = plan?.blockers?.some((item) => item.code === 'RETAINED_ACCOUNT_REQUIRED') || Boolean(retained);
  const blockers = (plan?.blockers || []).filter((item) => item.code !== 'FISCAL_YEAR_ALREADY_CLOSED');

  return <section className="mt-5 rounded-xl border border-line bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="font-extrabold">بستن سال مالی</h2>
        <p className="mt-1 max-w-xl text-xs leading-6 text-muted">درآمد و هزینه به «سود (زیان) انباشته» می‌روند، ماندهٔ حساب‌های دائمی با سند اختتامیه بسته و با افتتاحیه به سال بعد می‌آیند، و دوره‌های سال قفل می‌شوند.</p>
      </div>
      <label className="text-xs text-muted">سال
        <select value={year} onChange={(event) => { setYear(event.target.value); setRetained(''); }} className="tap mr-2 rounded-lg border border-line bg-paper px-2 text-sm text-ink">
          {years.map((item) => <option key={item} value={item}>{toPersianDigits(item)}</option>)}
        </select>
      </label>
    </div>

    {plan ? <>
      <dl className="mt-4 grid gap-2 text-[13px] sm:grid-cols-3">
        <div className="rounded-lg bg-paper px-3 py-2"><dt className="text-xs text-muted">وضعیت</dt><dd className="mt-1 font-bold">{closed ? 'بسته' : 'باز'}</dd></div>
        <div className="rounded-lg bg-paper px-3 py-2"><dt className="text-xs text-muted">{plan.profit >= 0 ? 'سود سال' : 'زیان سال'}</dt><dd className="numbers mt-1 font-bold">{formatAmount(Math.abs(plan.profit))} {unitLabel()}</dd></div>
        <div className="rounded-lg bg-paper px-3 py-2"><dt className="text-xs text-muted">مقصد سود</dt><dd className="mt-1 font-bold">{plan.retained ? `${toPersianDigits(plan.retained.code)} ${plan.retained.name}` : '—'}</dd></div>
      </dl>

      {closed ? null : <ul className="mt-3 divide-y divide-line rounded-lg border border-line text-[13px]">
        {plan.documents.map((doc) => <li key={doc.role} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <span className="font-bold">{doc.label}</span>
          <span className="text-xs text-muted">{toPersianDigits(doc.day.replace(/-/g, '/'))} · <span className="numbers">{toPersianDigits(doc.lines)}</span> آرتیکل · {SOURCE_LABEL[doc.source]}</span>
        </li>)}
      </ul>}

      {needsRetained && !closed ? <label className="mt-3 block text-xs text-muted">معین «سود (زیان) انباشته»
        <select value={retained} onChange={(event) => setRetained(event.target.value)} className="tap mt-1 w-full rounded-lg border border-line bg-paper px-2 text-sm text-ink">
          <option value="">— انتخاب کن —</option>
          {plan.retainedCandidates.map((item) => <option key={item.id} value={item.id}>{toPersianDigits(item.code)} · {item.name}</option>)}
        </select>
      </label> : null}

      {blockers.length && !closed ? <ul className="mt-3 space-y-1 rounded-lg border border-expense/40 bg-expense/5 p-3 text-[12px] leading-6 text-expense">
        {blockers.map((item) => <li key={item.code}>{toPersianDigits(item.message)}</li>)}
      </ul> : null}
      {plan.reminders.length && !closed ? <ul className="mt-3 space-y-1 rounded-lg bg-paper p-3 text-[12px] leading-6 text-muted">
        {plan.reminders.map((text) => <li key={text}>{toPersianDigits(text)}</li>)}
      </ul> : null}

      {isOwner ? <div className="mt-4 flex flex-wrap gap-2">
        {closed
          ? <button type="button" disabled={busy} onClick={reopen} className="tap rounded-lg border border-expense px-4 text-sm font-bold text-expense">بازگشایی سال با دلیل</button>
          : <button type="button" disabled={busy || !plan.ready} onClick={close} className="tap rounded-lg bg-ink px-4 text-sm font-bold text-on-fill disabled:opacity-40 hover:bg-ink/90">{busy ? 'در حال بستن…' : `بستن سال ${toPersianDigits(year)}`}</button>}
      </div> : <p className="mt-3 rounded-lg bg-paper px-3 py-2 text-xs leading-6 text-muted">فقط مالک می‌تواند سال را ببندد یا با ثبت دلیل باز کند.</p>}
    </> : null}
  </section>;
}
