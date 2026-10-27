import { ChevronLeft } from 'lucide-react';
import { formatAmount, toPersianDigits, unitLabel } from '../../lib/format.js';

/**
 * نمای هر گزارش حسابداری: فقط نمایش. هیچ عددی این‌جا حساب نمی‌شود جز آنچه سرور داده
 * (`server/accounting/reports.js`)؛ جمع‌ها و مانده‌ها همان‌اند که در اکسل می‌روند.
 */

export const dayLabel = (day) => (day ? toPersianDigits(day.replaceAll('-', '/')) : '—');
const money = (value) => (value ? formatAmount(value) : '—');
// منفی با پرانتز، به رسم صورت‌های مالی.
const signed = (value) => (!value ? '—' : value < 0 ? `(${formatAmount(-value)})` : formatAmount(value));

export const TRIAL_COLUMNS = Object.freeze({
  2: [['closingDebitBalance', 'مانده بدهکار'], ['closingCreditBalance', 'مانده بستانکار']],
  4: [['totalDebit', 'گردش بدهکار'], ['totalCredit', 'گردش بستانکار'], ['closingDebitBalance', 'مانده بدهکار'], ['closingCreditBalance', 'مانده بستانکار']],
  6: [['openingDebitBalance', 'اول دوره بد.'], ['openingCreditBalance', 'اول دوره بس.'], ['periodDebit', 'گردش بد.'], ['periodCredit', 'گردش بس.'], ['closingDebitBalance', 'مانده بد.'], ['closingCreditBalance', 'مانده بس.']],
  8: [['openingDebitBalance', 'اول دوره بد.'], ['openingCreditBalance', 'اول دوره بس.'], ['periodDebit', 'گردش بد.'], ['periodCredit', 'گردش بس.'], ['totalDebit', 'جمع بد.'], ['totalCredit', 'جمع بس.'], ['closingDebitBalance', 'مانده بد.'], ['closingCreditBalance', 'مانده بس.']],
});
// گروه سرستون‌ها در تراز شش و هشت ستونی.
const TRIAL_BANDS = Object.freeze({
  6: [['مانده اول دوره', 2], ['گردش دوره', 2], ['مانده پایان دوره', 2]],
  8: [['مانده اول دوره', 2], ['گردش دوره', 2], ['جمع', 2], ['مانده پایان دوره', 2]],
});

function Table({ children, minWidth = 640, label }) {
  return <div className="report-table mt-3 overflow-x-auto rounded-xl border border-line bg-surface" role="region" aria-label={label} tabIndex={0}>
    <table className="w-full text-sm" style={{ minWidth }}>{children}</table>
  </div>;
}

function DrillCell({ onOpen, children, title }) {
  if (!onOpen) return children;
  return <button type="button" onClick={onOpen} title={title} className="report-drill group inline-flex max-w-full items-center gap-1 text-right font-bold">
    <span className="truncate">{children}</span>
    <ChevronLeft size={14} aria-hidden="true" className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
  </button>;
}

function Check({ ok, okText, badText }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${ok ? 'bg-income/10 text-income' : 'bg-expense/10 text-expense'}`}>
    <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-income' : 'bg-expense'}`} aria-hidden="true" />{ok ? okText : badText}
  </span>;
}

export function Empty({ text = 'در این بازه سندِ تأییدشده‌ای نیست.' }) {
  return <p className="mt-3 rounded-xl border border-dashed border-line bg-surface px-4 py-10 text-center text-sm text-muted">{text}</p>;
}

// ---------------------------------------------------------------------------
// تراز آزمایشی
// ---------------------------------------------------------------------------

export function TrialView({ report, columns, onDrill }) {
  const set = TRIAL_COLUMNS[columns] || TRIAL_COLUMNS[4];
  const bands = TRIAL_BANDS[columns];
  if (!report.rows.length) return <Empty />;
  return <>
    <div className="mt-3 flex flex-wrap gap-2">
      <Check ok={report.checks.opening} okText="اول دوره متوازن" badText="اول دوره نامتوازن" />
      <Check ok={report.checks.period} okText="گردش دوره متوازن" badText="گردش دوره نامتوازن" />
      <Check ok={report.checks.closing} okText="مانده‌ها متوازن" badText="مانده‌ها نامتوازن" />
    </div>
    <Table minWidth={320 + set.length * 120} label={`تراز آزمایشی ${columns} ستونی`}>
      <thead className="sticky top-0 z-10 bg-paper text-xs text-muted">
        {bands && <tr className="border-b border-line"><th colSpan={2} />{bands.map(([label, span]) => <th key={label} colSpan={span} className="border-r border-line px-3 py-2 text-center font-bold">{label}</th>)}</tr>}
        <tr><th className="w-24 px-3 py-3 text-right">کد</th><th className="px-3 py-3 text-right">{report.levelLabel === 'تفصیلی' ? 'تفصیلی' : 'حساب'}</th>
          {set.map(([field, label]) => <th key={field} className="numbers px-3 py-3 text-left">{label}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-line">
        {report.rows.map((row) => <tr key={row.key} className="report-row">
          <td className="numbers px-3 py-2.5 text-muted">{row.code ? toPersianDigits(row.code) : '—'}</td>
          <td className="max-w-[260px] px-3 py-2.5"><DrillCell onOpen={() => onDrill({ level: report.level, key: row.key, title: row.name })} title="کارت حساب">{row.name}</DrillCell>
            {!row.mapped && report.level !== 'analytic' && <span className="mr-2 rounded bg-warn-bg px-1.5 py-0.5 text-[11px] font-bold text-warn">بی‌نگاشت</span>}</td>
          {set.map(([field]) => <td key={field} className="numbers whitespace-nowrap px-3 py-2.5 text-left">{money(row[field])}</td>)}
        </tr>)}
      </tbody>
      <tfoot className="border-t-2 border-ink/70 font-extrabold"><tr><td colSpan={2} className="px-3 py-3">جمع</td>
        {set.map(([field]) => <td key={field} className="numbers whitespace-nowrap px-3 py-3 text-left">{money(report.totals[field])}</td>)}</tr></tfoot>
    </Table>
  </>;
}

// ---------------------------------------------------------------------------
// صورت‌های مالی
// ---------------------------------------------------------------------------

/** بخش یک صورت مالی: «کل»‌ها، با حساب‌های زیرشان باز و بسته. */
function StatementSection({ title, rows, total, previousRows, previousTotal, compare, onDrill, negative = false }) {
  const previousOf = (key) => previousRows?.find((row) => row.key === key)?.amount ?? 0;
  const show = (value) => (negative ? signed(-value) : signed(value));
  return <tbody>
    <tr><th colSpan={compare ? 4 : 3} className="bg-subtle px-3 pb-2 pt-4 text-right text-xs font-extrabold text-accent">{title}</th></tr>
    {rows.length ? rows.map((group) => <tr key={group.key} className="report-row border-b border-line/60">
      <td className="numbers w-20 px-3 py-2.5 text-muted">{group.code ? toPersianDigits(group.code) : ''}</td>
      <td className="px-3 py-2.5">
        <details className="report-details">
          <summary className="cursor-pointer list-none font-bold">{group.name}<span className="mr-2 text-xs font-normal text-muted">{toPersianDigits(group.accounts.length)} حساب</span></summary>
          <ul className="mt-2 space-y-1.5 border-r-2 border-line pr-3">
            {group.accounts.map((account) => <li key={account.key} className="flex items-center justify-between gap-3 text-[13px]">
              <DrillCell onOpen={() => onDrill({ level: 'account', key: account.key, title: account.name })}>{account.name}</DrillCell>
              <span className="numbers shrink-0 text-muted">{show(account.amount)}</span>
            </li>)}
          </ul>
        </details>
      </td>
      <td className="numbers whitespace-nowrap px-3 py-2.5 text-left align-top">{show(group.amount)}</td>
      {compare && <td className="numbers whitespace-nowrap px-3 py-2.5 text-left align-top text-muted">{show(previousOf(group.key))}</td>}
    </tr>) : <tr><td colSpan={compare ? 4 : 3} className="px-3 py-3 text-xs text-muted">—</td></tr>}
    <tr className="font-extrabold"><td /><td className="px-3 py-2.5">جمع {title}</td><td className="numbers whitespace-nowrap border-t border-ink/50 px-3 py-2.5 text-left">{show(total)}</td>
      {compare && <td className="numbers whitespace-nowrap border-t border-ink/30 px-3 py-2.5 text-left text-muted">{show(previousTotal ?? 0)}</td>}</tr>
  </tbody>;
}

function SubtotalRow({ label, value, previous, compare, strong = false }) {
  return <tbody><tr className={strong ? 'text-[15px] font-extrabold' : 'font-extrabold'}>
    <td /><td className="px-3 py-3">{label}</td>
    <td className={`numbers whitespace-nowrap px-3 py-3 text-left ${strong ? 'border-y-2 border-double border-ink' : 'border-t border-ink/50'} ${value < 0 ? 'text-expense' : ''}`}>{signed(value)}</td>
    {compare && <td className="numbers whitespace-nowrap px-3 py-3 text-left text-muted">{signed(previous ?? 0)}</td>}
  </tr></tbody>;
}

function StatementHead({ compare, current, previous }) {
  return <thead className="sticky top-0 z-10 bg-paper text-xs text-muted"><tr><th className="w-20 px-3 py-3 text-right">کد</th><th className="px-3 py-3 text-right">شرح</th>
    <th className="numbers px-3 py-3 text-left">{current}</th>{compare && <th className="numbers px-3 py-3 text-left">{previous}</th>}</tr></thead>;
}

export function IncomeStatementView({ report, onDrill }) {
  const compare = Boolean(report.previous);
  const previous = report.previous;
  const t = report.totals;
  const p = previous?.totals || {};
  const range = (r) => `${r.fromDay ? dayLabel(r.fromDay) : 'از ابتدا'} تا ${dayLabel(r.toDay)}`;
  if (![...report.revenue, ...report.costOfSales, ...report.expenses, ...report.otherIncome].length) return <Empty text="در این بازه درآمد یا هزینه‌ای در دفتر نیست." />;
  return <Table minWidth={compare ? 640 : 520} label="صورت سود و زیان">
    <StatementHead compare={compare} current={range(report.range)} previous={previous ? range(previous.range) : ''} />
    <StatementSection title="درآمدهای عملیاتی" rows={report.revenue} total={t.revenue} previousRows={previous?.revenue} previousTotal={p.revenue} compare={compare} onDrill={onDrill} />
    <StatementSection title="بهای تمام‌شدهٔ کالا و خدمات فروش‌رفته" rows={report.costOfSales} total={t.costOfSales} previousRows={previous?.costOfSales} previousTotal={p.costOfSales} compare={compare} onDrill={onDrill} negative />
    <SubtotalRow label="سود (زیان) ناخالص" value={t.grossProfit} previous={p.grossProfit} compare={compare} />
    <StatementSection title="هزینه‌های عملیاتی" rows={report.expenses} total={t.expenses} previousRows={previous?.expenses} previousTotal={p.expenses} compare={compare} onDrill={onDrill} negative />
    <SubtotalRow label="سود (زیان) عملیاتی" value={t.operatingProfit} previous={p.operatingProfit} compare={compare} />
    <StatementSection title="سایر درآمدهای غیرعملیاتی" rows={report.otherIncome} total={t.otherIncome} previousRows={previous?.otherIncome} previousTotal={p.otherIncome} compare={compare} onDrill={onDrill} />
    <SubtotalRow label="سود (زیان) خالص" value={t.netProfit} previous={p.netProfit} compare={compare} strong />
  </Table>;
}

export function BalanceSheetView({ report, onDrill }) {
  const compare = Boolean(report.previous);
  const previous = report.previous;
  const sections = (items, previousItems, negative) => items.map((group) => <StatementSection key={group.key} title={group.name} rows={group.rows} total={group.amount}
    previousRows={previousItems?.find((item) => item.key === group.key)?.rows} previousTotal={previousItems?.find((item) => item.key === group.key)?.amount} compare={compare} onDrill={onDrill} negative={negative} />);
  const t = report.totals;
  const p = previous?.totals || {};
  if (!report.assets.length && !report.liabilities.length && !report.equity.length && !t.retained && !t.currentYear) return <Empty text="تا این تاریخ ماندهٔ تأییدشده‌ای در دفتر نیست." />;
  return <>
    <div className="mt-3 flex flex-wrap gap-2">
      <Check ok={report.balanced} okText="دارایی‌ها = بدهی‌ها + حقوق مالکانه" badText={`اختلاف ${formatAmount(Math.abs(t.difference))} ${unitLabel()}`} />
    </div>
    <Table minWidth={compare ? 640 : 520} label="ترازنامه">
      <StatementHead compare={compare} current={dayLabel(report.asOf)} previous={previous ? dayLabel(previous.asOf) : ''} />
      {sections(report.assets, previous?.assets)}
      <SubtotalRow label="جمع دارایی‌ها" value={t.assets} previous={p.assets} compare={compare} strong />
      {sections(report.liabilities, previous?.liabilities)}
      <SubtotalRow label="جمع بدهی‌ها" value={t.liabilities} previous={p.liabilities} compare={compare} />
      {sections(report.equity, previous?.equity)}
      <tbody>
        {[['سود (زیان) انباشته', t.retained, p.retained], ['سود (زیان) سال جاری', t.currentYear, p.currentYear]].map(([label, value, prior]) => <tr key={label} className="border-b border-line/60">
          <td /><td className="px-3 py-2.5 font-bold">{label}</td><td className="numbers px-3 py-2.5 text-left">{signed(value)}</td>{compare && <td className="numbers px-3 py-2.5 text-left text-muted">{signed(prior ?? 0)}</td>}</tr>)}
      </tbody>
      <SubtotalRow label="جمع حقوق مالکانه" value={t.equity} previous={p.equity} compare={compare} />
      <SubtotalRow label="جمع بدهی‌ها و حقوق مالکانه" value={t.liabilitiesAndEquity} previous={p.liabilitiesAndEquity} compare={compare} strong />
    </Table>
    {report.memorandum.length > 0 && <p className="mt-3 text-xs leading-6 text-muted">حساب‌های انتظامی ({toPersianDigits(report.memorandum.length)} حساب) در ترازنامه نیستند و در تراز آزمایشی دیده می‌شوند.</p>}
  </>;
}

export function CashFlowView({ report, onDrill }) {
  const empty = !report.operating.rows.length && !report.investing.rows.length && !report.financing.rows.length;
  return <>
    <div className="mt-3 flex flex-wrap gap-2"><Check ok={report.reconciled} okText="موجودی اول + جریان خالص = موجودی پایان" badText="جریان نقد با موجودی نمی‌خواند" /></div>
    {empty ? <Empty text="در این بازه پولی به صندوق، بانک یا تنخواه وارد یا خارج نشده است." /> : <Table minWidth={520} label="صورت جریان وجوه نقد">
      <StatementHead current="مبلغ" />
      <StatementSection title="فعالیت‌های عملیاتی" rows={report.operating.rows} total={report.operating.net} onDrill={onDrill} />
      <StatementSection title="فعالیت‌های سرمایه‌گذاری" rows={report.investing.rows} total={report.investing.net} onDrill={onDrill} />
      <StatementSection title="فعالیت‌های تأمین مالی" rows={report.financing.rows} total={report.financing.net} onDrill={onDrill} />
      <SubtotalRow label="خالص افزایش (کاهش) وجه نقد" value={report.net} />
      <SubtotalRow label="موجودی نقد اول دوره" value={report.opening} />
      <SubtotalRow label="موجودی نقد پایان دوره" value={report.closing} strong />
    </Table>}
    <p className="mt-3 text-xs leading-6 text-muted">روش مستقیم: هر ردیفِ مقابلِ صندوق، بانک و تنخواه به فعالیتِ حسابش می‌رود؛ دارایی ثابت سرمایه‌گذاری است و وام، سرمایه و جاری شرکا تأمین مالی. انتقال میان حساب‌های نقدی جریان نیست.</p>
  </>;
}

export function EquityChangesView({ report, onDrill }) {
  const rows = [...report.accounts, report.profit];
  return <Table minWidth={640} label="صورت تغییرات حقوق مالکانه">
    <thead className="sticky top-0 z-10 bg-paper text-xs text-muted"><tr><th className="px-3 py-3 text-right">شرح</th>{['ماندهٔ اول دوره', 'افزایش', 'کاهش', 'ماندهٔ پایان'].map((label) => <th key={label} className="px-3 py-3 text-left">{label}</th>)}</tr></thead>
    <tbody className="divide-y divide-line">{rows.map((row) => <tr key={row.key} className="report-row">
      <td className="px-3 py-2.5">{row.key === 'profit' ? <span className="font-bold">{row.name}</span> : <DrillCell onOpen={() => onDrill({ level: 'account', key: row.key, title: row.name })}>{row.name}</DrillCell>}</td>
      {['opening', 'increase', 'decrease', 'closing'].map((field) => <td key={field} className="numbers whitespace-nowrap px-3 py-2.5 text-left">{signed(row[field])}</td>)}
    </tr>)}</tbody>
    <tfoot className="border-t-2 border-ink/70 font-extrabold"><tr><td className="px-3 py-3">جمع حقوق مالکانه</td>{['opening', 'increase', 'decrease', 'closing'].map((field) => <td key={field} className="numbers whitespace-nowrap px-3 py-3 text-left">{signed(report.totals[field])}</td>)}</tr></tfoot>
  </Table>;
}

// ---------------------------------------------------------------------------
// دفاتر
// ---------------------------------------------------------------------------

export function LedgerView({ report, onOpenEntry, compact = false }) {
  return <>
    <div className={`grid grid-cols-3 gap-2 ${compact ? 'mt-3' : 'mt-4'}`}>
      {[['ماندهٔ اول دوره', report.opening], ['گردش بدهکار / بستانکار', null], ['ماندهٔ پایان', report.closing]].map(([label, value], index) => <div key={label} className="min-w-0 rounded-xl border border-line bg-surface px-3 py-2.5">
        <p className="text-[11px] font-bold text-muted">{label}</p>
        <p className="numbers mt-1 truncate text-[15px] font-extrabold">{index === 1 ? `${money(report.totals.debit)} / ${money(report.totals.credit)}` : !value ? '—' : `${formatAmount(Math.abs(value))} ${value > 0 ? 'بد' : 'بس'}`}</p>
      </div>)}
    </div>
    {!report.rows.length ? <Empty text="در این بازه گردشی روی این حساب نیست." /> : <Table minWidth={720} label={`کارت ${report.title}`}>
      <thead className="sticky top-0 z-10 bg-paper text-xs text-muted"><tr>{['تاریخ', 'سند', 'شرح', 'بدهکار', 'بستانکار', 'مانده', 'تشخیص'].map((label, index) => <th key={label} className={`px-3 py-3 ${index >= 3 && index <= 5 ? 'text-left' : 'text-right'}`}>{label}</th>)}</tr></thead>
      <tbody className="divide-y divide-line">{report.rows.map((row) => <tr key={row.id} className="report-row">
        <td className="numbers whitespace-nowrap px-3 py-2.5 text-muted">{dayLabel(row.day)}</td>
        <td className="numbers whitespace-nowrap px-3 py-2.5">{onOpenEntry ? <button type="button" onClick={() => onOpenEntry(row)} className="report-drill font-bold text-accent">{row.documentNumber ? toPersianDigits(row.documentNumber) : 'سند'}</button> : toPersianDigits(row.documentNumber || '—')}</td>
        <td className="max-w-[280px] px-3 py-2.5"><span className="line-clamp-2 text-[13px]">{row.description || '—'}</span>{(row.analytic || report.level !== 'account') && <span className="mt-0.5 block truncate text-[11px] text-muted">{[report.level !== 'account' ? row.accountName : '', row.analytic].filter(Boolean).join(' · ')}</span>}</td>
        <td className="numbers whitespace-nowrap px-3 py-2.5 text-left">{money(row.debit)}</td>
        <td className="numbers whitespace-nowrap px-3 py-2.5 text-left">{money(row.credit)}</td>
        <td className="numbers whitespace-nowrap px-3 py-2.5 text-left font-bold">{formatAmount(Math.abs(row.balance))}</td>
        <td className="px-3 py-2.5 text-xs text-muted">{row.balance > 0 ? 'بد' : row.balance < 0 ? 'بس' : '—'}</td>
      </tr>)}</tbody>
    </Table>}
  </>;
}

export function JournalBookView({ report, onOpenEntry }) {
  if (!report.entries.length) return <Empty />;
  return <>
    <div className="mt-3 flex flex-wrap items-center gap-2"><Check ok={!report.unbalanced.length} okText="همهٔ اسناد متوازن" badText={`${toPersianDigits(report.unbalanced.length)} سند نامتوازن`} />
      <span className="text-xs text-muted">{toPersianDigits(report.entryCount)} سند{report.truncated ? ' · فقط ۳٬۰۰۰ سند اول نشان داده شده؛ همه در فایل اکسل‌اند' : ''}</span></div>
    <Table minWidth={760} label="دفتر روزنامه">
      <thead className="sticky top-0 z-10 bg-paper text-xs text-muted"><tr>{['تاریخ', 'سند', 'حساب', 'شرح', 'بدهکار', 'بستانکار'].map((label, index) => <th key={label} className={`px-3 py-3 ${index >= 4 ? 'text-left' : 'text-right'}`}>{label}</th>)}</tr></thead>
      {report.entries.map((entry) => <tbody key={entry.id} className="border-b-2 border-line">
        {entry.lines.map((line, index) => <tr key={index} className="report-row">
          {index === 0 && <td rowSpan={entry.lines.length} className="numbers whitespace-nowrap px-3 py-2 align-top text-muted">{dayLabel(entry.day)}</td>}
          {index === 0 && <td rowSpan={entry.lines.length} className="numbers px-3 py-2 align-top"><button type="button" onClick={() => onOpenEntry({ entryId: entry.id })} className="report-drill font-bold text-accent">{entry.documentNumber ? toPersianDigits(entry.documentNumber) : 'سند'}</button></td>}
          <td className={`px-3 py-2 ${line.credit ? 'pr-8' : ''}`}><span className="numbers ml-2 text-xs text-muted">{toPersianDigits(line.accountCode)}</span><span className="font-bold">{line.accountName}</span>{line.analytic && <span className="block text-[11px] text-muted">{line.analytic}</span>}</td>
          <td className="max-w-[240px] px-3 py-2 text-[13px] text-muted"><span className="line-clamp-2">{line.description || (index === 0 ? entry.memo : '')}</span></td>
          <td className="numbers whitespace-nowrap px-3 py-2 text-left">{money(line.debit)}</td>
          <td className="numbers whitespace-nowrap px-3 py-2 text-left">{money(line.credit)}</td>
        </tr>)}
      </tbody>)}
      <tfoot className="font-extrabold"><tr><td colSpan={4} className="px-3 py-3">جمع دفتر روزنامه</td><td className="numbers px-3 py-3 text-left">{money(report.totals.debit)}</td><td className="numbers px-3 py-3 text-left">{money(report.totals.credit)}</td></tr></tfoot>
    </Table>
  </>;
}

// ---------------------------------------------------------------------------
// اشخاص، مرکز هزینه، کنترل‌ها
// ---------------------------------------------------------------------------

export function PersonsView({ report }) {
  const list = (title, rows, total, tone) => <section className="min-w-0">
    <div className="flex items-baseline justify-between"><h3 className="text-sm font-extrabold">{title}</h3><span className={`numbers text-sm font-extrabold ${tone}`}>{money(total)}</span></div>
    {rows.length ? <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface">{rows.map((row) => <li key={row.key} className="report-row flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
      <span className="truncate font-bold">{row.name}</span><span className="numbers shrink-0">{money(row.balance)}</span></li>)}</ul> : <Empty text="کسی نیست." />}
  </section>;
  return <div className="mt-3 grid gap-5 md:grid-cols-2">{list('بدهکاران (به ما بدهکارند)', report.debtors, report.totals.debtors, 'text-income')}{list('بستانکاران (به آن‌ها بدهکاریم)', report.creditors, report.totals.creditors, 'text-expense')}</div>;
}

export function AgingView({ report }) {
  const block = (title, rows, totals) => <section className="mt-5">
    <h3 className="text-sm font-extrabold">{title}</h3>
    {!rows.length ? <Empty text="سند بازی نیست." /> : <Table minWidth={860} label={title}>
      <thead className="sticky top-0 z-10 bg-paper text-xs text-muted"><tr><th className="px-3 py-3 text-right">شخص</th>{report.buckets.map((bucket) => <th key={bucket.id} className="px-3 py-3 text-left">{bucket.label}</th>)}<th className="px-3 py-3 text-left">جمع اسناد باز</th><th className="px-3 py-3 text-left">ماندهٔ دفتر</th><th className="px-3 py-3 text-left">بی‌سند</th></tr></thead>
      <tbody className="divide-y divide-line">{rows.map((row) => <tr key={row.key} className="report-row">
        <td className="px-3 py-2.5 font-bold">{row.name}</td>
        {report.buckets.map((bucket) => <td key={bucket.id} className={`numbers whitespace-nowrap px-3 py-2.5 text-left ${bucket.id === 'over' && row.buckets[bucket.id] ? 'font-extrabold text-expense' : ''}`}>{money(row.buckets[bucket.id])}</td>)}
        <td className="numbers whitespace-nowrap px-3 py-2.5 text-left font-bold">{money(row.documents)}</td>
        <td className="numbers whitespace-nowrap px-3 py-2.5 text-left text-muted">{row.ledgerBalance == null ? '—' : signed(row.ledgerBalance)}</td>
        <td className={`numbers whitespace-nowrap px-3 py-2.5 text-left ${row.unallocated ? 'text-warn' : 'text-muted'}`}>{row.unallocated == null ? '—' : signed(row.unallocated)}</td>
      </tr>)}</tbody>
      <tfoot className="border-t-2 border-ink/70 font-extrabold"><tr><td className="px-3 py-3">جمع</td>{report.buckets.map((bucket) => <td key={bucket.id} className="numbers whitespace-nowrap px-3 py-3 text-left">{money(totals[bucket.id])}</td>)}<td className="numbers whitespace-nowrap px-3 py-3 text-left">{money(totals.documents)}</td><td colSpan={2} /></tr></tfoot>
    </Table>}
  </section>;
  return <>
    {block('مطالبات', report.receivable, report.totals.receivable)}
    {block('بدهی‌ها', report.payable, report.totals.payable)}
    <p className="mt-3 text-xs leading-6 text-muted">سن از سررسید هر سند باز (تعهد، فاکتور، چک) تا امروز است؛ سندِ بی‌سررسید از تاریخ خودش. «بی‌سند» تفاوت ماندهٔ دفتر کل با اسناد باز است، مثلاً ماندهٔ واردشده از بکاپ یا سند دستی.</p>
  </>;
}

export function CostCenterView({ report }) {
  if (!report.rows.length) return <Empty text="در این بازه درآمد یا هزینه‌ای نیست." />;
  const widest = Math.max(1, ...report.rows.flatMap((row) => [row.income, row.expense]));
  return <Table minWidth={640} label="گزارش مراکز هزینه">
    <thead className="sticky top-0 z-10 bg-paper text-xs text-muted"><tr><th className="px-3 py-3 text-right">مرکز هزینه</th><th className="px-3 py-3 text-left">درآمد</th><th className="px-3 py-3 text-left">هزینه</th><th className="px-3 py-3 text-left">خالص</th></tr></thead>
    <tbody className="divide-y divide-line">{report.rows.map((row) => <tr key={row.key} className="report-row">
      <td className="px-3 py-2.5"><span className="font-bold">{row.name}</span>
        <span className="mt-1.5 flex h-1 gap-0.5 overflow-hidden" aria-hidden="true"><i className="report-bar block bg-income" style={{ width: `${row.income / widest * 50}%` }} /><i className="report-bar block bg-expense" style={{ width: `${row.expense / widest * 50}%` }} /></span></td>
      <td className="numbers whitespace-nowrap px-3 py-2.5 text-left">{money(row.income)}</td>
      <td className="numbers whitespace-nowrap px-3 py-2.5 text-left">{money(row.expense)}</td>
      <td className={`numbers whitespace-nowrap px-3 py-2.5 text-left font-bold ${row.net < 0 ? 'text-expense' : ''}`}>{signed(row.net)}</td>
    </tr>)}</tbody>
    <tfoot className="border-t-2 border-ink/70 font-extrabold"><tr><td className="px-3 py-3">جمع</td><td className="numbers px-3 py-3 text-left">{money(report.totals.income)}</td><td className="numbers px-3 py-3 text-left">{money(report.totals.expense)}</td><td className="numbers px-3 py-3 text-left">{signed(report.totals.net)}</td></tr></tfoot>
  </Table>;
}

const STATE_LABELS = { draft: 'پیش‌نویس', submitted: 'منتظر تأیید', returned: 'برگشتی' };

export function ControlsView({ report, onDrill }) {
  const items = [
    { ok: report.balanced, title: 'توازن دفتر', detail: report.balanced ? `گردش بدهکار و بستانکار هر دو ${formatAmount(report.trial.debit)} ${unitLabel()}` : `${toPersianDigits(report.unbalanced.length)} سند نامتوازن` },
    { ok: !report.pending.length, title: 'اسناد تأییدنشده', detail: report.pending.length ? report.pending.map((row) => `${STATE_LABELS[row.state] || row.state}: ${toPersianDigits(row.count)} سند (${formatAmount(row.amount)})`).join(' · ') : 'همهٔ اسناد تأیید شده‌اند؛ گزارش‌ها کامل‌اند.' },
    { ok: !report.deferred, title: 'ثبت‌های منتظر سند', detail: report.deferred ? `${toPersianDigits(report.deferred)} ثبت روزانه هنوز سند قطعی ندارد (صف حسابدار).` : 'ثبت روزانه‌ای بی‌سند نمانده است.' },
    { ok: !report.unmapped.length, title: 'حساب‌های بی‌نگاشت کدینگ', detail: report.unmapped.length ? `${toPersianDigits(report.unmapped.length)} حساب با مانده، بی‌جای مشخص در کدینگ؛ در ترازنامه زیر «بدون نگاشت» می‌آیند.` : 'همهٔ حساب‌های دارای مانده نگاشت دارند.' },
    { ok: !report.abnormal.length, title: 'مانده‌های خلاف ماهیت', detail: report.abnormal.length ? `${toPersianDigits(report.abnormal.length)} حساب` : 'موردی نیست.' },
  ];
  return <>
    <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">{items.map((item, index) => <li key={item.title} className="report-stagger flex items-start gap-3 px-4 py-3" style={{ '--i': index }}>
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.ok ? 'bg-income' : 'bg-warn'}`} aria-hidden="true" />
      <div className="min-w-0"><p className="text-sm font-extrabold">{item.title}<span className="sr-only">{item.ok ? ': سالم' : ': نیازمند بررسی'}</span></p><p className="mt-0.5 text-xs leading-6 text-muted">{item.detail}</p></div>
    </li>)}</ul>
    {[...report.abnormal, ...report.unmapped.filter((row) => !report.abnormal.some((item) => item.key === row.key))].length > 0 && <Table minWidth={560} label="حساب‌های نیازمند بررسی">
      <thead className="bg-paper text-xs text-muted"><tr><th className="px-3 py-3 text-right">حساب</th><th className="px-3 py-3 text-right">موضوع</th><th className="px-3 py-3 text-left">مانده</th></tr></thead>
      <tbody className="divide-y divide-line">{[...report.abnormal, ...report.unmapped.filter((row) => !report.abnormal.some((item) => item.key === row.key)).map((row) => ({ ...row, reason: 'بی‌نگاشت در کدینگ' }))].map((row) => <tr key={row.key} className="report-row">
        <td className="px-3 py-2.5"><DrillCell onOpen={() => onDrill({ level: 'account', key: row.key, title: row.name })}>{row.name}</DrillCell></td>
        <td className="px-3 py-2.5 text-xs text-muted">{row.reason}</td>
        <td className="numbers whitespace-nowrap px-3 py-2.5 text-left">{formatAmount(Math.abs(row.balance))} {row.balance > 0 ? 'بد' : 'بس'}</td>
      </tr>)}</tbody>
    </Table>}
  </>;
}
