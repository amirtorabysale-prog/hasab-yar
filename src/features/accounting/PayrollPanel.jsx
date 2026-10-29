import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { QuickMonthInput } from '../../components/QuickDateInput.jsx';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

/**
 * لیست حقوق — از فایل دفتر تا تسویهٔ سه بدهی.
 *
 * حساب‌یار حقوق را محاسبه نمی‌کند و این را صریح می‌گوید: نرخ بیمه و پلکان
 * مالیات هر سال عوض می‌شوند و هر دفتری قاعدهٔ خودش را دارد. کاری که می‌کند
 * این است که لیستِ بستهٔ دفتر را به سند درست تبدیل کند و سه بدهیِ جدا را —
 * خالص پرسنل، بیمه، مالیات — قابل پیگیری نگه دارد.
 */
const SUMMARY = [
  ['ناخالص', 'gross'], ['بیمهٔ کارمند', 'insuranceEmployee'], ['بیمهٔ کارفرما', 'insuranceEmployer'],
  ['مالیات', 'incomeTax'], ['خالص پرداختنی', 'net'],
];

function RunCard({ run, canManage, notify, refresh }) {
  const [busy, setBusy] = useState('');
  const act = async (key, action, success) => {
    setBusy(key);
    try { await action(); await refresh(); notify(success); }
    catch (error) { notify(error.details?.errors?.[0]?.message || error.message); }
    setBusy('');
  };

  const insuranceTotal = run.insuranceEmployee + run.insuranceEmployer;
  return <div className="rounded-lg border border-line bg-paper p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="font-bold">لیست حقوق {toPersianDigits(run.period)}</p>
        <p className="mt-0.5 text-xs text-muted">{toPersianDigits(run.employeeCount)} نفر · ثبت‌شده</p>
      </div>
      {canManage && run.unpaidCount === run.employeeCount && !run.insurancePaidAt && !run.taxPaidAt && <button
        disabled={Boolean(busy)}
        onClick={() => { if (window.confirm(`لیست حقوق ${run.period} برگردانده شود؟ سند پاک نمی‌شود؛ سند معکوس می‌خورد.`)) act('reverse', () => api.reversePayrollRun(run.id), 'لیست حقوق برگشت خورد.'); }}
        className="tap rounded-lg border border-expense/50 px-3 text-[12px] font-bold text-expense"
      >برگرداندن</button>}
    </div>

    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
      {SUMMARY.map(([label, key]) => <div key={key} className="rounded-lg bg-surface px-2 py-1.5">
        <span className="block text-xs text-muted">{label}</span>
        <b className="numbers mt-0.5 block text-[13px]">{formatAmount(run[key])}</b>
      </div>)}
    </div>

    <div className="mt-3 flex flex-wrap gap-2 text-[12px]">
      {run.unpaidCount > 0
        ? canManage && <button disabled={Boolean(busy)} onClick={() => act('salary', () => api.payPayrollSalaries(run.id), 'خالص حقوق پرداخت شد.')}
          className="tap rounded-lg bg-accent px-3 py-1.5 font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90 active:bg-accent/80">
          {busy === 'salary' ? 'در حال ثبت…' : `پرداخت خالص ${toPersianDigits(run.unpaidCount)} نفر (${formatAmount(run.unpaidNet)})`}
        </button>
        : <span className="rounded-lg bg-income/10 px-3 py-1.5 font-bold text-income">خالص همه پرداخت شد</span>}

      {insuranceTotal > 0 && (run.insurancePaidAt
        ? <span className="rounded-lg bg-income/10 px-3 py-1.5 font-bold text-income">بیمه پرداخت شد</span>
        : canManage && <button disabled={Boolean(busy)} onClick={() => act('insurance', () => api.payPayrollLiability(run.id, 'insurance'), 'بیمه پرداخت شد.')}
          className="tap rounded-lg border border-line bg-surface px-3 py-1.5 font-bold hover:bg-paper hover:text-ink">
          پرداخت بیمه ({formatAmount(insuranceTotal)})
        </button>)}

      {run.incomeTax > 0 && (run.taxPaidAt
        ? <span className="rounded-lg bg-income/10 px-3 py-1.5 font-bold text-income">مالیات پرداخت شد</span>
        : canManage && <button disabled={Boolean(busy)} onClick={() => act('tax', () => api.payPayrollLiability(run.id, 'tax'), 'مالیات حقوق پرداخت شد.')}
          className="tap rounded-lg border border-line bg-surface px-3 py-1.5 font-bold hover:bg-paper hover:text-ink">
          پرداخت مالیات ({formatAmount(run.incomeTax)})
        </button>)}
    </div>

    <details className="mt-3">
      <summary className="tap cursor-pointer text-[12px] font-bold text-muted">ردیف‌های این لیست</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[520px] text-right text-[12px]">
          <thead className="border-b border-line text-xs text-muted"><tr>
            <th className="pb-1 pl-2 font-bold">پرسنل</th><th className="pb-1 pl-2 font-bold">ناخالص</th>
            <th className="pb-1 pl-2 font-bold">کسورات</th><th className="pb-1 pl-2 font-bold">خالص</th>
            <th className="pb-1 font-bold">وضعیت</th>
          </tr></thead>
          <tbody>{run.lines.map((line) => <tr key={line.id} className="border-b border-line/60">
            <td className="py-1 pl-2">{line.employeeName}</td>
            <td className="numbers py-1 pl-2">{formatAmount(line.gross)}</td>
            <td className="numbers py-1 pl-2 text-muted">{formatAmount(line.insuranceEmployee + line.incomeTax + line.otherDeductions)}</td>
            <td className="numbers py-1 pl-2 font-bold">{formatAmount(line.net)}</td>
            <td className={`py-1 ${line.paidAt ? 'text-income' : 'text-muted'}`}>{line.paidAt ? 'پرداخت‌شده' : 'پرداخت‌نشده'}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  </div>;
}

export default function PayrollPanel({ canManage, notify }) {
  const [runs, setRuns] = useState([]);
  const [file, setFile] = useState(null);
  const [period, setPeriod] = useState('');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState([]);

  const load = useCallback(async () => {
    try { setRuns((await api.payrollRuns()).items || []); }
    catch (error) { notify(error.message); }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  const submit = async (event) => {
    event.preventDefault();
    if (!file || !period.trim()) return;
    setBusy(true); setIssues([]);
    try {
      await api.importPayrollFile(file, { period: period.trim() });
      setFile(null); setPeriod('');
      await load();
      notify('لیست حقوق ثبت شد و سندش خورد.');
    } catch (error) {
      setIssues(error.details?.errors || []);
      notify(error.message);
    }
    setBusy(false);
  };

  return <section className="rounded-xl border border-line bg-surface p-4">
    <p className="font-bold">حقوق و دستمزد</p>
    <p className="mt-1 max-w-2xl text-[12px] leading-6 text-muted">
      حساب‌یار حقوق را محاسبه نمی‌کند — نرخ بیمه و پلکان مالیات هر سال عوض می‌شوند و هر دفتری قاعدهٔ خودش را دارد.
      لیستی را که خودت بسته‌ای بارگذاری کن تا سندش درست بخورد: هزینهٔ ناخالص و سهم کارفرما بدهکار، و سه بدهیِ جدا
      بستانکار — خالص پرسنل، بیمهٔ تأمین اجتماعی و مالیات حقوق. هرکدام گیرندهٔ خودش را دارد و جدا تسویه می‌شود.
    </p>
    <p className="mt-2 text-[12px] text-muted">
      ستون‌ها: نام پرسنل، حقوق ناخالص، و در صورت وجود: کد ملی، بیمهٔ سهم کارمند، بیمهٔ سهم کارفرما، مالیات، سایر کسورات، خالص پرداختی.
      اگر خالص با ناخالص منهای کسورات نخواند، هیچ ردیفی وارد نمی‌شود و همان‌جا گفته می‌شود کدام ردیف و چقدر اختلاف دارد.
    </p>

    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
      <label className="text-[12px] font-bold">دورهٔ حقوق
        <QuickMonthInput value={period} onChange={setPeriod} disabled={!canManage} aria-label="دورهٔ حقوق" className="mt-1 w-44 font-normal" />
      </label>
      <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(event) => { setFile(event.target.files?.[0] || null); setIssues([]); }} disabled={!canManage}
        className="block text-[13px] file:ml-3 file:rounded-lg file:border file:border-line file:bg-paper file:px-3 file:py-2 file:text-[13px] file:font-bold" />
      <button disabled={!canManage || !file || !period.trim() || busy} className="tap rounded-lg bg-accent px-4 font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90 active:bg-accent/80">
        {busy ? 'در حال ثبت…' : 'ثبت لیست حقوق'}
      </button>
      <a href="#payroll-template" onClick={(event) => { event.preventDefault(); notify('ستون‌های لازم بالای همین کادر نوشته شده‌اند؛ هر فایل اکسل یا CSV با همان سرستون‌ها کار می‌کند.'); }}
        className="tap flex items-center gap-1 text-[12px] font-bold text-muted"><Download size={14} />ستون‌های لازم</a>
    </form>
    {!canManage && <p className="mt-2 text-[12px] text-muted">ثبت لیست حقوق از نقش مدیر یا مالک انجام می‌شود.</p>}

    {issues.length > 0 && <div className="mt-3 rounded-lg border border-expense/40 bg-expense/5 p-3">
      <p className="text-[13px] font-bold text-expense">{toPersianDigits(issues.length)} ایراد در لیست — هیچ ردیفی وارد نشد</p>
      <ul className="mt-2 space-y-1 text-[12px] leading-6">
        {issues.slice(0, 12).map((item, index) => <li key={`${item.rowNumber}-${index}`}>ردیف <b className="numbers">{toPersianDigits(item.rowNumber)}</b>: {item.message}</li>)}
        {issues.length > 12 && <li className="text-muted">و {toPersianDigits(issues.length - 12)} مورد دیگر…</li>}
      </ul>
    </div>}

    <div className="mt-4 space-y-3">
      {runs.length === 0 && <p className="py-4 text-center text-[13px] text-muted">هنوز لیست حقوقی ثبت نشده است.</p>}
      {runs.map((run) => <RunCard key={run.id} run={run} canManage={canManage} notify={notify} refresh={load} />)}
    </div>
  </section>;
}
