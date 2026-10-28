import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Download, FileSpreadsheet, Printer, Scale, ShieldCheck, Users, X } from 'lucide-react';
import { PersianDateInput } from '../../components/common.jsx';
import { useSheetA11y } from '../../components/sheetA11y.js';
import { api } from '../../lib/api.js';
import { toPersianDigits, unitLabel } from '../../lib/format.js';
import { persianToISO, todayPersian } from '../../../shared/persianDate.js';
import { fiscalYearLabel, fiscalYearMonths, fiscalYearOf } from '../../../shared/fiscalYear.js';
import { JournalEntrySheet } from '../accounting/JournalEntrySheet.jsx';
import {
  AgingView, BalanceSheetView, CashFlowView, ControlsView, CostCenterView, Empty, EquityChangesView, IncomeStatementView,
  JournalBookView, LedgerView, PersonsView, TrialView, dayLabel,
} from './accountingReportViews.jsx';

/**
 * گزارش‌های حسابداری — زیرمجموعهٔ «گزارش‌ها».
 *
 * هر گزارش از سرور (`/api/accounting/reports/:kind`) و فقط از سندهای تأییدشده می‌آید. این
 * صفحه بازه، سطح و ستون را انتخاب می‌کند و نشان می‌دهد؛ هیچ جمعی این‌جا ساخته نمی‌شود.
 * کلیک روی هر حساب، کارت همان حساب را در همان بازه باز می‌کند و از کارت، خودِ سند.
 */

const GROUPS = Object.freeze([
  { id: 'trials', label: 'ترازها', icon: Scale, reports: [
    { id: 'trial', label: 'تراز آزمایشی', hint: 'دو، چهار، شش و هشت ستونی؛ در سطح گروه، کل، معین، حساب و تفصیلی' },
  ] },
  { id: 'statements', label: 'صورت‌های مالی', icon: FileSpreadsheet, reports: [
    { id: 'balance-sheet', label: 'ترازنامه', hint: 'صورت وضعیت مالی در یک تاریخ، با مقایسهٔ پایان سال قبل', pointInTime: true, comparable: true },
    { id: 'income-statement', label: 'سود و زیان', hint: 'درآمد، بهای تمام‌شده، سود ناخالص، عملیاتی و خالص', comparable: true },
    { id: 'cash-flow', label: 'جریان وجوه نقد', hint: 'روش مستقیم؛ عملیاتی، سرمایه‌گذاری و تأمین مالی' },
    { id: 'equity-changes', label: 'تغییرات حقوق مالکانه', hint: 'سرمایه، برداشت و سود دوره' },
  ] },
  { id: 'books', label: 'دفاتر', icon: BookOpen, reports: [
    { id: 'journal', label: 'دفتر روزنامه', hint: 'همهٔ اسناد بازه به ترتیب تاریخ و شماره' },
    { id: 'ledger', label: 'دفتر کل و معین', hint: 'کارت هر حساب با ماندهٔ جاری' },
  ] },
  { id: 'people', label: 'اشخاص و تحلیل', icon: Users, reports: [
    { id: 'persons', label: 'بدهکاران و بستانکاران', hint: 'ماندهٔ هر شخص از دفتر کل', pointInTime: true },
    { id: 'aging', label: 'گزارش سنی', hint: 'مطالبات و بدهی‌ها به سن سررسید، امروز', today: true },
    { id: 'cost-centers', label: 'مراکز هزینه', hint: 'درآمد، هزینه و خالص هر مرکز' },
  ] },
  { id: 'controls', label: 'کنترل‌ها', icon: ShieldCheck, reports: [
    { id: 'controls', label: 'کنترل‌های دفتر', hint: 'توازن، اسناد منتظر، بی‌نگاشت و خلاف ماهیت', pointInTime: true },
  ] },
]);
const REPORTS = Object.fromEntries(GROUPS.flatMap((group) => group.reports.map((report) => [report.id, { ...report, group: group.id }])));
const LEVELS = Object.freeze([['group', 'گروه'], ['general', 'کل'], ['subsidiary', 'معین'], ['account', 'حساب'], ['analytic', 'تفصیلی']]);
const STORAGE_KEY = 'hesabyar.accounting-reports';

const remember = (value) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* حافظهٔ مرورگر در دسترس نیست. */ } };
const recall = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { return {}; } };

/** بازه‌های آماده به تقویم شمسی؛ «سال» یعنی سال مالی دفتر با ماه شروع خودش. */
function presetRange(id, startMonth = 1) {
  const today = todayPersian();
  const iso = (year, month, day) => persianToISO(year, month, day);
  const to = iso(today.year, today.month, today.day);
  const currentFiscal = fiscalYearOf(today.year, today.month, startMonth);
  if (id === 'month') return { from: iso(today.year, today.month, 1), to };
  if (id === 'quarter') return { from: iso(today.year, Math.floor((today.month - 1) / 3) * 3 + 1, 1), to };
  if (id === 'year') { const { first } = fiscalYearMonths(currentFiscal, startMonth); return { from: iso(first.year, first.month, 1), to }; }
  // `y:1403` یک سالِ کامل است و `all` کل دفتر. دفتری که از بکاپ پر شده سال‌های گذشته را
  // دارد؛ «سال جاری» آن‌جا خالی بود (دفتر «آزمون بکاپ ریالی»، ۵ آبان ۱۴۰۵).
  if (id === 'all') return { from: '', to };
  const year = id === 'last-year' ? currentFiscal - 1 : Number(String(id).match(/^y:(\d{4})$/)?.[1]);
  if (year) {
    const { first, last } = fiscalYearMonths(year, startMonth);
    // روز آخر ماه آخر: ۳۱، ۳۰ یا ۲۹ (اسفند غیرکبیسه).
    const end = iso(last.year, last.month, 31) || iso(last.year, last.month, 30) || iso(last.year, last.month, 29);
    return { from: iso(first.year, first.month, 1), to: year === currentFiscal ? to : end };
  }
  return null;
}
/** سال‌های شمسیِ یک بازهٔ آماده، برای شمردن پیش‌نویس‌هایی که در گزارش نیامده‌اند؛ null یعنی همه. */
function presetYears(id, currentYear) {
  if (id === 'all') return null;
  if (['month', 'quarter', 'year'].includes(id)) return [currentYear];
  const year = Number(String(id).match(/^y:(\d{4})$/)?.[1]);
  return year ? [year] : [];
}

function Segmented({ label, options, value, onChange }) {
  return <div role="radiogroup" aria-label={label} className="report-segment inline-flex max-w-full overflow-x-auto rounded-xl border border-line bg-surface p-1 [scrollbar-width:none]">
    {options.map(([id, text]) => <button key={id} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)}
      className={`min-h-9 shrink-0 rounded-lg px-3 text-[13px] font-bold transition-colors ${value === id ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-subtle hover:text-ink'}`}>{text}</button>)}
  </div>;
}

function Skeleton() {
  return <div className="mt-4 space-y-2" aria-hidden="true">{[90, 70, 82, 64, 76, 58].map((width, index) => <div key={index} className="rq-skeleton h-9" style={{ width: `${width}%` }} />)}</div>;
}

/** کارت حساب در برگهٔ کناری؛ از همان بازهٔ گزارش. */
function LedgerSheet({ target, range, drafts, close, onOpenEntry }) {
  const sheetRef = useSheetA11y(close);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setReport(null); setError('');
    api.accountingReport('ledger', { level: target.level, key: target.key, from: range.from, to: range.to, drafts })
      .then((result) => { if (active) setReport(result); }).catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [target.level, target.key, range.from, range.to, drafts]);
  return <div ref={sheetRef} className="fixed inset-0 z-[70] flex items-end justify-center bg-scrim/40 backdrop-blur-[2px] sm:items-center" onClick={close}>
    <section role="dialog" aria-modal="true" aria-label={`کارت ${target.title}`} onClick={(event) => event.stopPropagation()}
      className="sheet-in max-h-[88vh] w-full max-w-[860px] overflow-y-auto rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl sm:rounded-2xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><span className="rounded-full bg-accent/10 px-2 py-1 text-xs font-extrabold text-accent">کارت حساب</span>
          <h2 className="mt-2 truncate text-lg font-extrabold">{toPersianDigits(report?.title || target.title)}</h2>
          <p className="mt-0.5 text-xs text-muted">{range.from ? `${dayLabel(report?.range.fromDay)} تا ${dayLabel(report?.range.toDay)}` : 'از ابتدا'} · {unitLabel()}</p></div>
        <button type="button" onClick={close} aria-label="بستن" className="tap grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted hover:bg-subtle hover:text-ink"><X size={18} /></button>
      </div>
      {error ? <p className="mt-4 rounded-lg bg-warn-bg px-3 py-3 text-sm text-warn">{error}</p> : !report ? <Skeleton /> : <div className="rq-step"><LedgerView report={report} onOpenEntry={onOpenEntry} compact /></div>}
    </section>
  </div>;
}

export function AccountingReportsPage({ access, notify }) {
  const saved = useMemo(recall, []);
  const role = access?.workspace?.role || 'viewer';
  const canApprove = ['owner', 'manager'].includes(role);
  const [reportId, setReportId] = useState(REPORTS[saved.reportId] ? saved.reportId : 'trial');
  // بازه تا رسیدن فهرست سال‌های دفتر انتخاب نمی‌شود؛ پیش‌فرضش آخرین سالِ دارای سند است.
  const [preset, setPreset] = useState(null);
  const [range, setRange] = useState(null);
  const [yearsInfo, setYearsInfo] = useState(null);
  const [imports, setImports] = useState([]);
  const [drafts, setDrafts] = useState(false);
  const [approving, setApproving] = useState(null);
  const [level, setLevel] = useState(saved.level || 'subsidiary');
  const [columns, setColumns] = useState(saved.columns || 4);
  const [compare, setCompare] = useState(false);
  const [ledgerTarget, setLedgerTarget] = useState(null);
  const [ledgerLevel, setLedgerLevel] = useState('general');
  const [ledgerOptions, setLedgerOptions] = useState([]);
  const [state, setState] = useState({ loading: true, report: null, error: '' });
  const [drill, setDrill] = useState(null);
  const [entry, setEntry] = useState(null);
  const [exporting, setExporting] = useState(false);
  const request = useRef(0);

  const meta = REPORTS[reportId];
  const group = GROUPS.find((item) => item.id === meta.group);
  useEffect(() => { if (preset) remember({ reportId, preset, level, columns }); }, [reportId, preset, level, columns]);

  const loadYears = useCallback(() => Promise.all([api.accountingReportYears(), api.accountingImports().catch(() => ({ imports: [] }))])
    .then(([years, imported]) => { setYearsInfo(years); setImports(imported.imports || []); return years; }), []);
  useEffect(() => {
    loadYears().then((years) => {
      const has = (year) => years.years.some((item) => item.year === year);
      const latest = years.years[0]?.year;
      const wanted = saved.preset && saved.preset !== 'custom' ? saved.preset : null;
      // بازهٔ ذخیره‌شده فقط اگر در این دفتر سند دارد؛ وگرنه آخرین سالِ دارای سند.
      const fits = wanted && (wanted === 'all' || (['month', 'quarter', 'year'].includes(wanted) ? has(years.currentYear) : has(Number(wanted.slice(2)))));
      const choice = fits ? wanted : has(years.currentYear) || !latest ? 'year' : `y:${latest}`;
      setPreset(choice); setRange(presetRange(choice, years.startMonth));
    }).catch(() => { setPreset('year'); setRange(presetRange('year')); });
  }, [loadYears, saved.preset]);
  const presets = useMemo(() => {
    const current = yearsInfo?.currentYear;
    const years = [...new Set([current, ...(yearsInfo?.years || []).map((item) => item.year)].filter(Boolean))].sort((a, b) => b - a);
    return [['month', 'ماه جاری'], ['quarter', 'فصل جاری'], ...years.map((year) => [year === current ? 'year' : `y:${year}`, `سال ${toPersianDigits(fiscalYearLabel(year, yearsInfo?.startMonth))}`]), ['all', 'کل دفتر'], ['custom', 'دلخواه']];
  }, [yearsInfo]);

  const params = useMemo(() => {
    if (!range) return null;
    const flag = drafts ? { drafts: true } : {};
    if (meta.today) return flag;
    const base = { ...(meta.pointInTime ? { to: range.to } : { from: range.from, to: range.to }), ...flag };
    if (reportId === 'trial') return { ...base, level };
    if (reportId === 'ledger') return ledgerTarget ? { ...base, level: ledgerTarget.level, key: ledgerTarget.key } : null;
    if (meta.comparable) return { ...base, compare };
    return base;
  }, [meta, range, reportId, level, compare, ledgerTarget, drafts]);

  // فهرست حساب‌های دفتر کل و معین، از ترازِ همان سطح.
  useEffect(() => {
    if (reportId !== 'ledger' || !range) return undefined;
    let active = true;
    api.accountingReport('trial', { level: ledgerLevel, to: range.to, drafts }).then((result) => {
      if (!active) return;
      setLedgerOptions(result.rows);
      setLedgerTarget((current) => (current && current.level === ledgerLevel && result.rows.some((row) => row.key === current.key) ? current : result.rows[0] ? { level: ledgerLevel, key: result.rows[0].key, title: result.rows[0].name } : null));
    }).catch(() => { if (active) setLedgerOptions([]); });
    return () => { active = false; };
  }, [reportId, ledgerLevel, range, drafts]);

  const load = useCallback(() => {
    if (!params) { setState({ loading: false, report: null, error: '' }); return; }
    const id = request.current += 1;
    setState((current) => ({ ...current, loading: true, error: '' }));
    api.accountingReport(reportId, params)
      .then((report) => { if (request.current === id) setState({ loading: false, report, error: '' }); })
      .catch((error) => { if (request.current === id) setState({ loading: false, report: null, error: error.message }); });
  }, [reportId, params]);
  useEffect(() => { load(); }, [load]);

  const choosePreset = (id) => { setPreset(id); if (id !== 'custom') setRange(presetRange(id, yearsInfo?.startMonth)); };
  const exportExcel = async () => {
    if (!params) return;
    setExporting(true);
    try { await api.downloadAccountingReport(reportId, { ...params, columns }, `${meta.label}.xlsx`); }
    catch (error) { notify?.(error.message); }
    finally { setExporting(false); }
  };
  // پاسخِ گزارشِ قبلی تا رسیدن پاسخ تازه نشان داده نمی‌شود؛ نوعِ هر پاسخ همان شناسهٔ گزارش است.
  const report = state.report?.kind === reportId ? state.report : null;
  const ledgerRange = range || { from: '', to: '' };
  // پیش‌نویس‌هایی که در سال‌های این بازه هستند ولی در گزارش نیامده‌اند.
  const hiddenDrafts = useMemo(() => {
    if (drafts || !yearsInfo || !preset) return 0;
    const years = presetYears(preset, yearsInfo.currentYear);
    return yearsInfo.years.filter((item) => !years || years.includes(item.year)).reduce((sum, item) => sum + item.drafts, 0);
  }, [drafts, yearsInfo, preset]);
  const pendingImports = imports.filter((item) => item.pending > 0);
  const approveImport = async (item) => {
    setApproving({ sha: item.fileSha256, busy: true });
    try {
      const result = await api.approveAccountingImport(item.fileSha256);
      const rest = result.skipped.length ? `؛ ${toPersianDigits(result.skipped.length)} سند پیش‌نویس ماند (${result.skipped[0].reason})` : '.';
      notify?.(`${toPersianDigits(result.approved)} سند بکاپ تأیید شد${rest}`);
      setApproving(null);
      await loadYears();
      load();
    } catch (error) { notify?.(error.message); setApproving({ sha: item.fileSha256, busy: false }); }
  };
  const rangeText = meta.today ? 'امروز' : meta.pointInTime ? `تا ${dayLabel(report?.range?.toDay || '')}` : `${report?.range?.fromDay ? dayLabel(report.range.fromDay) : 'از ابتدا'} تا ${dayLabel(report?.range?.toDay || '')}`;

  const view = (() => {
    if (!report) return null;
    const onDrill = (target) => setDrill(target);
    switch (reportId) {
      case 'trial': return <TrialView report={report} columns={columns} onDrill={onDrill} />;
      case 'balance-sheet': return <BalanceSheetView report={report} onDrill={onDrill} />;
      case 'income-statement': return <IncomeStatementView report={report} onDrill={onDrill} />;
      case 'cash-flow': return <CashFlowView report={report} onDrill={onDrill} />;
      case 'equity-changes': return <EquityChangesView report={report} onDrill={onDrill} />;
      case 'journal': return <JournalBookView report={report} onOpenEntry={setEntry} />;
      case 'ledger': return <LedgerView report={report} onOpenEntry={setEntry} />;
      case 'persons': return <PersonsView report={report} />;
      case 'aging': return <AgingView report={report} />;
      case 'cost-centers': return <CostCenterView report={report} />;
      case 'controls': return <ControlsView report={report} onDrill={onDrill} />;
      default: return null;
    }
  })();

  return <main className="accounting-reports mx-auto w-full max-w-[1080px] px-4 py-5">
    <header className="report-print-hide">
      <p className="text-xs font-extrabold text-accent">گزارش‌ها</p>
      <h1 className="mt-1 text-xl font-extrabold">گزارش‌های حسابداری</h1>
      <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">ترازها، صورت‌های مالی و دفاتر، همه از اسناد تأییدشدهٔ همین دفتر. روی هر حساب بزن تا کارتش باز شود.</p>
    </header>

    <nav className="section-navigation report-print-hide" aria-label="دسته‌های گزارش">
      {GROUPS.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" aria-current={item.id === group.id ? 'page' : undefined} onClick={() => setReportId(item.reports[0].id)}>
        <Icon size={15} aria-hidden="true" className="ml-1.5 inline -translate-y-px" />{item.label}</button>; })}
    </nav>

    {group.reports.length > 1 && <div className="report-print-hide flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={group.label}>
      {group.reports.map((item) => <button key={item.id} type="button" role="tab" aria-selected={item.id === reportId} onClick={() => setReportId(item.id)}
        className={`report-pick min-w-[150px] shrink-0 rounded-xl border px-3 py-2.5 text-right transition-[border-color,background-color] ${item.id === reportId ? 'border-accent/60 bg-accent/[.06]' : 'border-line bg-surface hover:border-accent/30'}`}>
        <span className={`block text-sm font-extrabold ${item.id === reportId ? 'text-accent' : ''}`}>{item.label}</span>
        <span className="mt-0.5 block text-[11px] leading-5 text-muted">{item.hint}</span>
      </button>)}
    </div>}

    <section className="report-toolbar report-print-hide mt-3 rounded-2xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        {!meta.today && <Segmented label="بازهٔ گزارش" options={presets} value={preset} onChange={choosePreset} />}
        {meta.today && <span className="rounded-lg bg-subtle px-3 py-2 text-xs font-bold text-muted">وضعیت امروز</span>}
        <label className={`inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] font-bold ${drafts ? 'text-warn' : 'text-muted hover:text-ink'}`}>
          <input type="checkbox" checked={drafts} onChange={(event) => setDrafts(event.target.checked)} className="h-4 w-4 accent-[rgb(var(--c-warn))]" />با پیش‌نویس‌ها</label>
        <span className="flex-1" />
        <button type="button" onClick={exportExcel} disabled={!report || exporting} className="tap inline-flex items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-bold hover:bg-subtle disabled:opacity-50"><Download size={15} aria-hidden="true" />{exporting ? 'در حال ساخت…' : 'اکسل'}</button>
        <button type="button" onClick={() => window.print()} disabled={!report} className="tap inline-flex items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-bold hover:bg-subtle disabled:opacity-50"><Printer size={15} aria-hidden="true" />چاپ</button>
      </div>
      {preset === 'custom' && !meta.today && range && <div className="rq-step mt-3 grid gap-2 sm:max-w-md sm:grid-cols-2">
        {!meta.pointInTime && <label className="text-xs font-bold text-muted">از تاریخ<PersianDateInput value={range.from} onChange={(from) => setRange((current) => ({ ...current, from }))} className="mt-1" /></label>}
        <label className="text-xs font-bold text-muted">{meta.pointInTime ? 'در تاریخ' : 'تا تاریخ'}<PersianDateInput value={range.to} onChange={(to) => setRange((current) => ({ ...current, to }))} className="mt-1" /></label>
      </div>}
      {(reportId === 'trial' || reportId === 'ledger' || meta.comparable) && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {reportId === 'trial' && <><Segmented label="سطح تراز" options={LEVELS} value={level} onChange={setLevel} />
          <Segmented label="تعداد ستون" options={[[2, '۲ ستونی'], [4, '۴ ستونی'], [6, '۶ ستونی'], [8, '۸ ستونی']]} value={columns} onChange={setColumns} /></>}
        {reportId === 'ledger' && <><Segmented label="نوع دفتر" options={[['group', 'گروه'], ['general', 'دفتر کل'], ['subsidiary', 'دفتر معین'], ['account', 'حساب'], ['analytic', 'تفصیلی']]} value={ledgerLevel} onChange={setLedgerLevel} />
          <label className="min-w-[220px] flex-1 text-xs font-bold text-muted"><span className="sr-only">حساب</span>
            <select value={ledgerTarget?.key || ''} onChange={(event) => { const row = ledgerOptions.find((item) => item.key === event.target.value); if (row) setLedgerTarget({ level: ledgerLevel, key: row.key, title: row.name }); }}
              className="tap w-full rounded-lg border border-line px-3 text-sm text-ink">
              {!ledgerOptions.length && <option value="">حسابی با گردش نیست</option>}
              {ledgerOptions.map((row) => <option key={row.key} value={row.key}>{row.code ? `${toPersianDigits(row.code)} — ` : ''}{row.name}</option>)}
            </select></label></>}
        {meta.comparable && <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2 text-[13px] font-bold text-muted hover:text-ink">
          <input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} className="h-4 w-4 accent-[rgb(var(--c-accent))]" />
          {reportId === 'balance-sheet' ? 'مقایسه با پایان سال قبل' : 'مقایسه با دورهٔ هم‌طول قبل'}</label>}
      </div>}
    </section>

    {report?.provisional && <div role="status" className="rq-step mt-4 flex items-start gap-3 rounded-xl border border-warn/40 bg-warn-bg px-4 py-3 text-[13px] leading-6">
      <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-warn" aria-hidden="true" />
      <p><b className="text-warn">غیرقطعی:</b> این گزارش {toPersianDigits(report.draftEntries)} سند تأییدنشده (پیش‌نویس، منتظر کنترل یا برگشتی) را هم شمرده است. برای دفاتر رسمی و تحویل، اول سندها را تأیید کن.</p>
    </div>}
    {!drafts && (hiddenDrafts > 0 || pendingImports.length > 0) && <div className="report-print-hide rq-step mt-4 rounded-xl border border-line bg-surface px-4 py-3">
      {hiddenDrafts > 0 && <p className="text-[13px] leading-6">در این بازه <b>{toPersianDigits(hiddenDrafts)} سند تأییدنشده</b> هست که در گزارش نیامده؛ گزارش‌ها فقط سند تأییدشده را می‌شمارند.
        <button type="button" onClick={() => setDrafts(true)} className="mr-2 font-bold text-accent underline-offset-4 hover:underline">نمایش غیرقطعی با پیش‌نویس‌ها</button></p>}
      {pendingImports.map((item) => <div key={item.fileSha256} className={`flex flex-wrap items-center gap-2 text-[13px] ${hiddenDrafts > 0 ? 'mt-2 border-t border-line pt-2' : ''}`}>
        <span className="min-w-0 flex-1">بکاپ پارسیان{item.fileName ? ` «${item.fileName}»` : ''}: {toPersianDigits(item.pending)} از {toPersianDigits(item.total)} سند هنوز تأیید نشده.</span>
        {!canApprove ? <span className="text-xs text-muted">تأیید با مدیر یا مالک دفتر است.</span>
          : approving?.sha === item.fileSha256 ? <span className="rq-step flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">هر سند دوباره سنجیده و با نام تو تأیید می‌شود؛ سندِ دورهٔ بسته یا ناسالم پیش‌نویس می‌ماند.</span>
            <button type="button" disabled={approving.busy} onClick={() => approveImport(item)} className="tap rounded-lg bg-accent px-3 text-[13px] font-bold text-on-fill disabled:opacity-60">{approving.busy ? 'در حال تأیید…' : `تأیید ${toPersianDigits(item.pending)} سند`}</button>
            <button type="button" disabled={approving.busy} onClick={() => setApproving(null)} className="tap rounded-lg px-3 text-[13px] font-bold text-muted hover:text-ink">انصراف</button></span>
          : <button type="button" onClick={() => setApproving({ sha: item.fileSha256, busy: false })} className="tap rounded-lg border border-accent/50 px-3 text-[13px] font-bold text-accent hover:bg-accent/[.06]">تأیید یک‌جا</button>}
      </div>)}
    </div>}

    <section className="report-sheet mt-5" aria-live="polite" aria-busy={state.loading}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div><h2 className="text-[17px] font-extrabold">{meta.label}{reportId === 'trial' && <span className="mr-2 text-sm font-bold text-muted">{toPersianDigits(columns)} ستونی · سطح {LEVELS.find(([id]) => id === level)?.[1]}</span>}
          {reportId === 'ledger' && ledgerTarget && <span className="mr-2 text-sm font-bold text-muted">{toPersianDigits(report?.title || ledgerTarget.title)}</span>}</h2>
          <p className="mt-0.5 text-xs text-muted">{rangeText} · مبالغ به {unitLabel()} · {report?.provisional ? 'با اسناد تأییدنشده (غیرقطعی)' : 'فقط اسناد تأییدشده'}</p></div>
      </div>
      {state.error ? <p className="mt-4 rounded-lg bg-warn-bg px-3 py-3 text-sm text-warn">{state.error}</p>
        : state.loading && !report ? <Skeleton />
          : reportId === 'ledger' && !ledgerTarget ? <Empty text="هنوز حسابی با گردش در دفتر نیست." />
            : <div key={`${reportId}-${JSON.stringify(params)}-${columns}`} className={`rq-step ${state.loading ? 'opacity-60 transition-opacity' : ''}`}>{view}</div>}
    </section>

    {drill && <LedgerSheet target={drill} drafts={drafts} range={meta.pointInTime || meta.today ? { from: '', to: ledgerRange.to } : ledgerRange} close={() => setDrill(null)} onOpenEntry={setEntry} />}
    {entry && <JournalEntrySheet line={entry} close={() => setEntry(null)} />}
  </main>;
}
