import { Check, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { digitsOnly } from '../../components/common.jsx';
import { formatAmount, persianDate, toPersianDigits } from '../../lib/format.js';

function currentPersianPeriod(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit' }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}

export function AccountingPage({ access, notify }) {
  const [trial, setTrial] = useState({ rows: [], totals: {}, balanced: true });
  const [journal, setJournal] = useState({ items: [], total: 0 });
  const [accounts, setAccounts] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [currentPeriod, setCurrentPeriod] = useState(currentPersianPeriod());
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState({ memo: '', amount: '', debitAccountId: '', creditAccountId: '' });
  const [worklist, setWorklist] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [chart, setChart] = useState({ analytics: [], costCenters: [] });
  const role = access.workspace?.role || 'viewer';
  const canWrite = ['owner', 'manager', 'accountant'].includes(role);
  const isOwner = role === 'owner';
  const period = currentPeriod;
  const periodState = periods.find((item) => item.period === period);
  const load = useCallback(async () => {
    try {
      const [nextTrial, nextJournal, nextAccounts, nextPeriods] = await Promise.all([
        api.trialBalance(), api.journal({ limit: 30 }), api.accountingAccounts(), api.accountingPeriods(),
      ]);
      setTrial(nextTrial); setJournal(nextJournal); setAccounts(nextAccounts.items); setPeriods(nextPeriods.items); setCurrentPeriod(nextPeriods.currentPeriod || currentPersianPeriod());
      // کارتابل و ابعاد نباید نبودشان کل صفحهٔ حسابداری را از کار بیندازد.
      const [nextWorklist, nextTemplates, nextChart] = await Promise.all([
        api.journalWorklist().catch(() => null),
        api.journalTemplates().catch(() => ({ items: [] })),
        api.chartOverview().catch(() => ({ analytics: [], costCenters: [] })),
      ]);
      setWorklist(nextWorklist); setTemplates(nextTemplates.items || []); setChart(nextChart);
      setDraft((current) => ({ ...current, debitAccountId: current.debitAccountId || nextAccounts.items.find((item) => item.type === 'expense')?.id || '', creditAccountId: current.creditAccountId || nextAccounts.items.find((item) => item.type === 'asset')?.id || '' }));
    } catch (error) { notify(error.message); }
  }, [notify]);
  useEffect(() => { load(); }, [load, access.workspace?.id]);
  const saveAdjustment = async (event) => {
    event.preventDefault();
    const amount = Number(draft.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) return notify('مبلغ سند اصلاحی معتبر نیست.');
    if (draft.debitAccountId === draft.creditAccountId) return notify('حساب بدهکار و بستانکار باید متفاوت باشد.');
    setBusy('journal');
    try {
      await api.createAdjustingJournal({ memo: draft.memo, lines: [{ accountId: draft.debitAccountId, debit: amount }, { accountId: draft.creditAccountId, credit: amount }] });
      setDraft((current) => ({ ...current, memo: '', amount: '' }));
      await load(); notify('سند اصلاحی متوازن ثبت شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const lock = async () => {
    if (!window.confirm(`دورهٔ ${toPersianDigits(period.replace('-', '/'))} بسته شود؟ بعد از بستن، ثبت‌ها و اصلاحات این ماه تغییر نمی‌کنند.`)) return;
    setBusy('period');
    try { await api.lockAccountingPeriod(period); await load(); notify('دوره مالی بسته شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const reopen = async () => {
    const reason = window.prompt('دلیل بازگشایی را دقیق ثبت کن؛ این توضیح در سابقه حسابرسی می‌ماند.');
    if (!reason) return;
    setBusy('period');
    try { await api.reopenAccountingPeriod(period, reason); await load(); notify('دوره با ثبت دلیل بازگشایی شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const typeLabels = { asset: 'دارایی', liability: 'بدهی', equity: 'سرمایه', income: 'درآمد', expense: 'هزینه' };
  return <main className="mx-auto w-full max-w-[980px] px-4 py-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[13px] font-bold text-accent">هسته حسابداری کسب‌وکار</p><h1 className="mt-1 text-xl font-extrabold">دفتر کل دوطرفه</h1><p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">هر دریافت یا پرداخت به سند متوازن بدهکار و بستانکار تبدیل می‌شود. این دفتر هنوز جایگزین دفاتر قانونی و محاسبات مالیاتی نیست.</p></div><div className={`rounded-lg border px-3 py-2 text-xs font-bold ${trial.balanced ? 'border-income/30 bg-income/5 text-income' : 'border-expense/30 bg-warn-bg text-expense'}`}><Check size={16} className="ml-1 inline" />{trial.balanced ? 'دفتر متوازن است' : 'عدم توازن نیازمند بررسی'}</div></div>
    <section className="mt-5 rounded-[10px] border border-line bg-surface p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-extrabold">کنترل دوره جاری</h2><p className="mt-1 text-xs text-muted">ماه {toPersianDigits(period.replace('-', '/'))} هجری شمسی · {periodState?.status === 'locked' ? 'بسته' : 'باز'}</p></div>{isOwner && (periodState?.status === 'locked' ? <button disabled={busy} onClick={reopen} className="tap rounded-lg border border-expense px-4 text-sm font-bold text-expense"><RotateCcw size={17} className="ml-1 inline" />بازگشایی با دلیل</button> : <button disabled={busy} onClick={lock} className="tap rounded-lg bg-ink px-4 text-sm font-bold text-white">بستن دوره</button>)}</div>{!isOwner && <p className="mt-3 rounded-lg bg-paper px-3 py-2 text-xs leading-6 text-muted">فقط مالک می‌تواند دوره را ببندد یا با ثبت دلیل باز کند.</p>}</section>
    <section className="mt-5"><div className="flex items-end justify-between"><div><h2 className="font-extrabold">تراز آزمایشی</h2><p className="mt-1 text-xs text-muted">واحد تمام مبالغ: تومان</p></div><span className="text-xs text-muted">گردش بدهکار و بستانکار: {formatAmount(trial.totals.debit || 0)}</span></div><div className="mt-3 overflow-x-auto rounded-[10px] border border-line bg-surface"><table className="w-full min-w-[620px] text-sm"><thead className="bg-paper text-xs text-muted"><tr><th className="px-3 py-3 text-right">کد</th><th className="px-3 py-3 text-right">حساب</th><th className="px-3 py-3 text-right">ماهیت</th><th className="px-3 py-3 text-left">مانده بدهکار</th><th className="px-3 py-3 text-left">مانده بستانکار</th></tr></thead><tbody className="divide-y divide-line">{trial.rows.filter((row) => row.debitBalance || row.creditBalance).map((row) => <tr key={row.id}><td className="numbers px-3 py-3 text-muted">{toPersianDigits(row.code)}</td><td className="px-3 py-3 font-bold">{row.name}</td><td className="px-3 py-3 text-xs text-muted">{typeLabels[row.type]}</td><td className="numbers px-3 py-3 text-left">{row.debitBalance ? formatAmount(row.debitBalance) : '—'}</td><td className="numbers px-3 py-3 text-left">{row.creditBalance ? formatAmount(row.creditBalance) : '—'}</td></tr>)}</tbody><tfoot className="border-t-2 border-ink font-extrabold"><tr><td colSpan="3" className="px-3 py-3">جمع مانده‌ها</td><td className="numbers px-3 py-3 text-left">{formatAmount(trial.totals.debitBalance || 0)}</td><td className="numbers px-3 py-3 text-left">{formatAmount(trial.totals.creditBalance || 0)}</td></tr></tfoot></table></div></section>
    {canWrite && <form onSubmit={saveAdjustment} className="mt-5 rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">سند اصلاحی ساده</h2><p className="mt-1 text-xs leading-6 text-muted">این بخش برای حسابدار یا مدیر مالی است؛ مبلغ به‌صورت برابر در بدهکار و بستانکار ثبت می‌شود.</p><input required value={draft.memo} onChange={(event) => setDraft({ ...draft, memo: event.target.value })} placeholder="شرح و دلیل اصلاح" className="tap mt-3 w-full rounded-lg border border-line px-3" /><div className="mt-2 grid gap-2 sm:grid-cols-3"><label className="text-xs text-muted">حساب بدهکار<select required value={draft.debitAccountId} onChange={(event) => setDraft({ ...draft, debitAccountId: event.target.value })} className="tap mt-1 w-full rounded-lg border border-line bg-surface px-2 text-ink">{accounts.map((account) => <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}</select></label><label className="text-xs text-muted">حساب بستانکار<select required value={draft.creditAccountId} onChange={(event) => setDraft({ ...draft, creditAccountId: event.target.value })} className="tap mt-1 w-full rounded-lg border border-line bg-surface px-2 text-ink">{accounts.map((account) => <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}</select></label><label className="text-xs text-muted">مبلغ تومان<input required inputMode="numeric" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/\D/g, '') })} className="tap numbers mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label></div><button disabled={busy || periodState?.status === 'locked'} className="tap mt-3 w-full rounded-lg bg-accent font-bold text-white disabled:opacity-40">{periodState?.status === 'locked' ? 'دوره بسته است' : 'ثبت سند متوازن'}</button></form>}
    {canWrite && <JournalGridPanel accounts={accounts} analytics={chart.analytics || []} costCenters={chart.costCenters || []} templates={templates} notify={notify} refresh={load} />}
    <JournalWorklistPanel worklist={worklist} canApprove={["owner", "manager"].includes(role)} notify={notify} refresh={load} />
    <section className="mt-6"><div className="flex justify-between"><h2 className="font-extrabold">آخرین اسناد روزنامه</h2><span className="text-xs text-muted">{toPersianDigits(journal.total)} سند</span></div><div className="mt-3 divide-y divide-line border-y border-line">{journal.items.map((entry) => <article key={entry.id} className="py-3"><div className="flex justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-bold">{entry.memo || 'سند بدون شرح'}</p><p className="mt-1 text-xs text-muted">{entry.entryKind === 'reversal' ? 'سند معکوس' : entry.entryKind === 'adjustment' ? 'سند اصلاحی' : entry.entryKind === 'opening' ? 'مانده افتتاحیه' : 'ثبت خودکار'} · {new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(entry.occurredAt))}</p></div><span className="numbers shrink-0 text-xs text-muted">#{toPersianDigits(entry.revision)}</span></div><div className="mt-2 grid gap-1 text-xs text-muted">{entry.lines.map((line) => <div key={`${entry.id}-${line.accountId}-${line.debit}-${line.credit}`} className="flex justify-between gap-3"><span>{toPersianDigits(line.code)} · {line.name}</span><span className="numbers">{line.debit ? `بدهکار ${formatAmount(line.debit)}` : `بستانکار ${formatAmount(line.credit)}`}</span></div>)}</div></article>)}</div></section>
  </main>;
}

const APPROVAL_STYLE = {
  draft: 'border-line bg-surface text-muted',
  submitted: 'border-accent/40 bg-warn-bg text-accent',
  returned: 'border-expense/40 bg-expense/10 text-expense',
  approved: 'border-income/40 bg-income/10 text-income',
};

const EMPTY_GRID_ROW = { accountId: '', description: '', debit: '', credit: '', analyticId: '', costCenterId: '' };

/**
 * گرید ثبت انبوه: کمک‌حسابدار روزی صدها ردیف می‌زند و باید بدون لمس ماوس کار کند.
 * Enter ردیف بعد، Ctrl+D کپی ردیف بالا، Ctrl+Enter ثبت سند.
 */
function JournalGridPanel({ accounts, analytics, costCenters, templates, notify, refresh }) {
  const [memo, setMemo] = useState('');
  const [rows, setRows] = useState([{ ...EMPTY_GRID_ROW }, { ...EMPTY_GRID_ROW }]);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);
  const gridRef = useRef(null);

  const postable = accounts.filter((item) => item.active !== 0);
  const totals = rows.reduce((sum, row) => ({
    debit: sum.debit + Number(digitsOnly(row.debit) || 0),
    credit: sum.credit + Number(digitsOnly(row.credit) || 0),
  }), { debit: 0, credit: 0 });
  const difference = totals.debit - totals.credit;
  const balanced = totals.debit > 0 && difference === 0;

  const update = (index, field, value) => setRows(rows.map((row, position) => (position === index ? { ...row, [field]: value } : row)));
  const addRow = () => setRows([...rows, { ...EMPTY_GRID_ROW }]);

  const focusCell = (rowIndex, field) => {
    requestAnimationFrame(() => {
      gridRef.current?.querySelector(`[data-cell="${rowIndex}-${field}"]`)?.focus();
    });
  };

  const onKeyDown = (event, index, field) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (index === rows.length - 1) { setRows([...rows, { ...EMPTY_GRID_ROW }]); focusCell(index + 1, 'accountId'); }
      else focusCell(index + 1, field);
      return;
    }
    // کپی ردیف بالا — همان چیزی که در نرم‌افزارهای حسابداری با Ctrl+D انجام می‌شود.
    if (event.key.toLowerCase() === 'd' && (event.ctrlKey || event.metaKey) && index > 0) {
      event.preventDefault();
      setRows(rows.map((row, position) => (position === index ? { ...rows[index - 1] } : row)));
    }
  };

  const applyTemplate = (templateId) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    setMemo(template.memo || template.name);
    setRows(template.lines.map((line) => ({
      accountId: line.accountId, description: line.description || '',
      debit: line.debit ? String(line.debit) : '', credit: line.credit ? String(line.credit) : '',
      analyticId: line.analyticId || '', costCenterId: line.costCenterId || '',
    })));
  };

  const submit = async () => {
    setErrors([]);
    const lines = rows
      .filter((row) => row.accountId && (digitsOnly(row.debit) || digitsOnly(row.credit)))
      .map((row) => ({
        accountId: row.accountId,
        debit: Number(digitsOnly(row.debit) || 0),
        credit: Number(digitsOnly(row.credit) || 0),
        description: row.description,
        analyticId: row.analyticId || null,
        costCenterId: row.costCenterId || null,
      }));
    if (lines.length < 2) { notify('سند باید حداقل دو آرتیکل با مبلغ داشته باشد.'); return; }
    setBusy(true);
    try {
      const result = await api.journalBatch([{ memo: memo || 'سند دستی', lines }]);
      notify(`سند شمارهٔ ${toPersianDigits(result.documentNumbers[0])} به‌شکل پیش‌نویس ثبت شد.`);
      setRows([{ ...EMPTY_GRID_ROW }, { ...EMPTY_GRID_ROW }]);
      setMemo('');
      await refresh();
      focusCell(0, 'accountId');
    } catch (error) {
      setErrors(error.details?.errors || [{ message: error.message }]);
      notify(error.message);
    }
    setBusy(false);
  };

  return <section className="mt-5 rounded-[10px] border border-line bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="font-bold">ثبت سند با کیبورد</p>
        <p className="mt-1 text-[12px] leading-6 text-muted">
          <b>Enter</b> ردیف بعد · <b>Ctrl+D</b> کپی ردیف بالا · <b>Ctrl+Enter</b> ثبت سند. سند به‌شکل پیش‌نویس ثبت می‌شود و تا کنترل نشود در خروجی حسابدار نمی‌آید.
        </p>
      </div>
      {templates.length > 0 && <label className="text-[12px] text-muted">الگوی سند
        <select onChange={(event) => applyTemplate(event.target.value)} value="" className="tap mr-2 rounded-lg border border-line bg-paper px-2 text-[13px] text-ink">
          <option value="">— انتخاب —</option>
          {templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>}
    </div>

    <input value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="شرح سند" className="tap mt-3 w-full rounded-lg border border-line bg-paper px-3 text-[13px]" />

    <div ref={gridRef} className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[720px] text-right text-[13px]">
        <thead className="border-b border-line text-[12px] text-muted"><tr>
          <th className="pb-2 pl-2 font-bold">حساب</th><th className="pb-2 pl-2 font-bold">شرح</th>
          <th className="pb-2 pl-2 font-bold">تفصیلی</th><th className="pb-2 pl-2 font-bold">مرکز هزینه</th>
          <th className="pb-2 pl-2 font-bold">بدهکار</th><th className="pb-2 font-bold">بستانکار</th>
        </tr></thead>
        <tbody>
          {rows.map((row, index) => <tr key={index} className="border-b border-line">
            <td className="py-1 pl-2"><select data-cell={`${index}-accountId`} value={row.accountId} onChange={(event) => update(index, 'accountId', event.target.value)} onKeyDown={(event) => onKeyDown(event, index, 'accountId')} className="tap w-44 rounded border border-line bg-paper px-1 text-[13px]"><option value="">—</option>{postable.map((item) => <option key={item.id} value={item.id}>{item.chartCode || item.code} · {item.name}</option>)}</select></td>
            <td className="py-1 pl-2"><input data-cell={`${index}-description`} value={row.description} onChange={(event) => update(index, 'description', event.target.value)} onKeyDown={(event) => onKeyDown(event, index, 'description')} className="tap w-36 rounded border border-line bg-paper px-1 text-[13px]" /></td>
            <td className="py-1 pl-2"><select data-cell={`${index}-analyticId`} value={row.analyticId} onChange={(event) => update(index, 'analyticId', event.target.value)} onKeyDown={(event) => onKeyDown(event, index, 'analyticId')} className="tap w-32 rounded border border-line bg-paper px-1 text-[13px]"><option value="">—</option>{analytics.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></td>
            <td className="py-1 pl-2"><select data-cell={`${index}-costCenterId`} value={row.costCenterId} onChange={(event) => update(index, 'costCenterId', event.target.value)} onKeyDown={(event) => onKeyDown(event, index, 'costCenterId')} className="tap w-32 rounded border border-line bg-paper px-1 text-[13px]"><option value="">—</option>{costCenters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></td>
            <td className="py-1 pl-2"><input data-cell={`${index}-debit`} inputMode="numeric" value={row.debit} onChange={(event) => update(index, 'debit', digitsOnly(event.target.value))} onKeyDown={(event) => onKeyDown(event, index, 'debit')} className="numbers tap w-28 rounded border border-line bg-paper px-1 text-[13px]" /></td>
            <td className="py-1"><input data-cell={`${index}-credit`} inputMode="numeric" value={row.credit} onChange={(event) => update(index, 'credit', digitsOnly(event.target.value))} onKeyDown={(event) => onKeyDown(event, index, 'credit')} className="numbers tap w-28 rounded border border-line bg-paper px-1 text-[13px]" /></td>
          </tr>)}
        </tbody>
        <tfoot><tr className="text-[13px] font-bold">
          <td colSpan={4} className="py-2 pl-2 text-muted">جمع</td>
          <td className="numbers py-2 pl-2">{formatAmount(totals.debit)}</td>
          <td className="numbers py-2">{formatAmount(totals.credit)}</td>
        </tr></tfoot>
      </table>
    </div>

    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" onClick={addRow} className="tap rounded-lg border border-line bg-paper px-3 text-[13px] font-bold">افزودن ردیف</button>
      <button type="button" disabled={busy || !balanced} onClick={submit} className="tap rounded-lg bg-accent px-4 font-bold text-white disabled:opacity-45">{busy ? 'در حال ثبت…' : 'ثبت سند (Ctrl+Enter)'}</button>
      {!balanced && totals.debit + totals.credit > 0 && <span className="text-[13px] font-bold text-expense">اختلاف <span className="numbers">{formatAmount(Math.abs(difference))}</span> تومان</span>}
      {balanced && <span className="text-[13px] font-bold text-income">سند متوازن است</span>}
    </div>

    {errors.length > 0 && <ul className="mt-3 space-y-1 rounded-lg border border-expense/40 bg-expense/5 p-3 text-[12px] leading-6 text-expense">
      {errors.map((item, index) => <li key={index}>{item.position ? `سند ${toPersianDigits(item.position)}: ` : ''}{item.message}</li>)}
    </ul>}
  </section>;
}

/** کارتابل سند: چه چیزی پیش‌نویس است، چه چیزی منتظر کنترل و چه چیزی برگشت خورده. */
function JournalWorklistPanel({ worklist, canApprove, notify, refresh }) {
  const [busy, setBusy] = useState('');
  const summary = worklist?.summary;

  const move = async (id, state) => {
    const reason = state === 'returned' ? window.prompt('دلیل برگشت سند (حداقل ۱۰ نویسه):') : '';
    if (state === 'returned' && !reason) return;
    setBusy(id);
    try { await api.setJournalApproval(id, state, reason || ''); await refresh(); notify('وضعیت سند به‌روز شد.'); }
    catch (error) { notify(error.message); }
    setBusy('');
  };

  if (!summary) return null;
  return <section className="mt-5 rounded-[10px] border border-line bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-bold">کارتابل سند</p>
      <div className="flex flex-wrap gap-1.5 text-[12px]">
        {['draft', 'submitted', 'returned'].map((state) => <span key={state} className={`rounded border px-2 py-0.5 font-bold ${APPROVAL_STYLE[state]}`}>
          {worklist.states.find((item) => item.id === state)?.label}: <span className="numbers">{toPersianDigits(summary[state])}</span>
        </span>)}
      </div>
    </div>

    {canApprove && worklist.checkers?.soloChecker && <p className="mt-3 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] leading-6 text-muted">
      این دفتر کنترل‌کنندهٔ دیگری ندارد، پس می‌توانی سند خودت را تأیید کنی؛ هر خودتأییدی در Audit Log ثبت می‌شود.
      برای تفکیک واقعی ثبت‌کننده و کنترل‌کننده، یک عضو با نقش مدیر اضافه کن.
    </p>}

    {summary.clear && <p className="mt-3 text-[13px] text-income">هیچ سندی در جریان نمانده است.</p>}

    {!summary.clear && <div className="mt-3 divide-y divide-line">
      {worklist.items.map((item) => <article key={item.id} className="flex flex-wrap items-center gap-3 py-3">
        <span className={`rounded border px-2 py-0.5 text-[11px] font-bold ${APPROVAL_STYLE[item.approvalState]}`}>{item.approvalLabel}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold">سند <span className="numbers">{toPersianDigits(item.documentNumber || '—')}</span> · {item.memo || 'بدون شرح'}</p>
          <p className="mt-0.5 text-[11px] text-muted">{persianDate(item.occurredAt)} · <span className="numbers">{formatAmount(item.total)}</span> تومان</p>
          {item.returnReason && <p className="mt-1 text-[11px] leading-5 text-expense">دلیل برگشت: {item.returnReason}</p>}
        </div>
        <div className="flex gap-1.5">
          {['draft', 'returned'].includes(item.approvalState) && <button disabled={busy === item.id} onClick={() => move(item.id, 'submitted')} className="tap rounded-lg border border-line bg-paper px-3 text-[12px] font-bold">ارسال برای کنترل</button>}
          {item.approvalState === 'submitted' && canApprove && <>
            <button disabled={busy === item.id} onClick={() => move(item.id, 'approved')} className="tap rounded-lg bg-accent px-3 text-[12px] font-bold text-white">تأیید</button>
            <button disabled={busy === item.id} onClick={() => move(item.id, 'returned')} className="tap rounded-lg border border-expense/50 px-3 text-[12px] font-bold text-expense">برگشت</button>
          </>}
          {item.approvalState === 'submitted' && !canApprove && <span className="text-[11px] text-muted">کنترل با نقش مدیر است</span>}
        </div>
      </article>)}
    </div>}
  </section>;
}
