import { useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

const IMPORT_KINDS = [
  { id: 'chart', label: 'کدینگ حساب‌ها', hint: 'ستون‌ها: کد، نام، سطح، کد والد، نوع' },
  { id: 'analytics', label: 'تفصیلی و طرف حساب', hint: 'ستون‌ها: کد، نام، نوع، کد مقصد — فایل تفصیلی نرم‌افزار دفتر را همین‌جا بده؛ اگر ستون «کد مقصد» نداشته باشد، کد ستون اول کد مقصد شمرده می‌شود.' },
  { id: 'opening', label: 'ماندهٔ افتتاحیه', hint: 'ستون‌ها: کد حساب، بدهکار، بستانکار، کد تفصیلی' },
];

export default function ExcelImportPanel({ canManage, notify, refresh }) {
  const [kind, setKind] = useState('chart');
  const [file, setFile] = useState(null);
  const [amountUnit, setAmountUnit] = useState('toman');
  const [replace, setReplace] = useState(false);
  const [openingDate, setOpeningDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState([]);
  const [result, setResult] = useState(null);

  const active = IMPORT_KINDS.find((item) => item.id === kind);
  const download = async () => {
    try {
      const { blob, fileName } = await api.downloadImportTemplate();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = fileName;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch (error) { notify(error.message); }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true); setIssues([]); setResult(null);
    try {
      const response = kind === 'chart' ? await api.importChartFile(file, replace)
        : kind === 'analytics' ? await api.importAnalyticsFile(file)
          : await api.importOpeningBalances(file, { amountUnit, replace, occurredAt: openingDate });
      setResult(response); setFile(null); await refresh(); notify('فایل با موفقیت وارد شد.');
    } catch (error) {
      setIssues(error.details?.errors || []); notify(error.message);
    }
    setBusy(false);
  };

  return <section className="rounded-xl border border-line bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><p className="font-bold">ورود از اکسل یا پارسیان</p><p className="mt-1 max-w-xl text-[12px] leading-6 text-muted">
        فایل اکسل (xlsx) یا CSV را مستقیم بارگذاری کن. نوع فایل از محتوایش تشخیص داده می‌شود، نه از پسوند.
        اگر یک ردیف ایراد داشته باشد هیچ ردیفی وارد نمی‌شود. سقف امن: ۲ مگابایت، ۲۰ شیت، ۵۰ هزار ردیف و ۵۰۰ هزار سلول.
      </p></div>
      <button type="button" onClick={download} className="tap flex items-center gap-2 rounded-lg border border-line bg-paper px-3 text-[13px] font-bold hover:bg-paper hover:text-ink"><Download size={16} />الگوی خالی اکسل</button>
    </div>
    <div className="mt-3 flex flex-wrap gap-1.5 text-[13px] font-bold">
      {IMPORT_KINDS.map((item) => <button key={item.id} type="button" onClick={() => { setKind(item.id); setIssues([]); setResult(null); }} className={`tap rounded-lg border px-3 ${kind === item.id ? 'border-accent bg-warn-bg text-accent' : 'border-line bg-paper text-muted'} hover:bg-paper hover:text-ink`}>{item.label}</button>)}
    </div>
    <form onSubmit={submit} className="mt-3 space-y-3">
      <p className="text-[12px] text-muted">{active.hint}</p>
      <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(event) => { setFile(event.target.files?.[0] || null); setIssues([]); setResult(null); }} disabled={!canManage}
        className="block w-full text-[13px] file:ml-3 file:rounded-lg file:border file:border-line file:bg-paper file:px-3 file:py-2 file:text-[13px] file:font-bold" />
      {kind === 'opening' && <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-warn-bg px-3 py-2">
        <label className="text-[13px] font-bold text-accent">واحد مبلغ فایل<select value={amountUnit} onChange={(event) => setAmountUnit(event.target.value)} className="tap mr-2 rounded-lg border border-line bg-paper px-2 text-[13px] text-ink"><option value="toman">تومان</option><option value="rial">ریال</option></select></label>
        <span className="text-xs leading-5 text-muted">اشتباه در این انتخاب یعنی خطای ده‌برابری؛ حساب‌یار آن را حدس نمی‌زند.</span>
        <label className="text-[13px] font-bold text-accent">تاریخ افتتاحیه<input type="date" value={openingDate} onChange={(event) => setOpeningDate(event.target.value)} className="tap mr-2 rounded-lg border border-line bg-paper px-2 text-[13px] text-ink" /></label>
        <span className="text-xs leading-5 text-muted">خالی یعنی روز شروع ثبت در این دفتر؛ تاریخ بعد از آن پذیرفته نمی‌شود.</span>
      </div>}
      {kind !== 'analytics' && <label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />{kind === 'chart' ? 'کدینگ فعلی جایگزین شود (فقط وقتی هیچ نگاشتی وجود ندارد)' : 'سند افتتاحیهٔ قبلی معکوس و جایگزین شود'}</label>}
      <button disabled={!canManage || !file || busy} className="tap rounded-lg bg-accent px-4 font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90 active:bg-accent/80">{busy ? 'در حال ورود…' : 'بارگذاری فایل'}</button>
      {!canManage && <p className="text-[12px] text-muted">ورود داده فقط از نقش مدیر یا مالک انجام می‌شود.</p>}
    </form>
    {issues.length > 0 && <div className="mt-3 rounded-lg border border-expense/40 bg-expense/5 p-3"><p className="text-[13px] font-bold text-expense">{toPersianDigits(issues.length)} ایراد در فایل — هیچ ردیفی وارد نشد</p><ul className="mt-2 space-y-1 text-[12px] leading-6">{issues.slice(0, 12).map((item, index) => <li key={`${item.rowNumber}-${index}`}>ردیف <b className="numbers">{toPersianDigits(item.rowNumber ?? item.position ?? '—')}</b>: {item.message}</li>)}{issues.length > 12 && <li className="text-muted">و {toPersianDigits(issues.length - 12)} مورد دیگر…</li>}</ul></div>}
    {result && <div className="mt-3 rounded-lg border border-income/40 bg-income/5 p-3 text-[13px] leading-6">{result.entryId
      ? <>سند افتتاحیه با <b className="numbers">{toPersianDigits(result.lineCount)}</b> ردیف ثبت شد؛ جمع هر طرف <b className="numbers">{formatAmount(result.debitTotal)}</b> تومان.{result.replacedEntryId && ' سند قبلی معکوس شد.'}</>
      : <><b className="numbers">{toPersianDigits(result.created)}</b> ردیف تازه و <b className="numbers">{toPersianDigits(result.updated)}</b> ردیف به‌روزشده.
        {typeof result.linked === 'number' && <> از این‌ها <b className="numbers">{toPersianDigits(result.linked)}</b> طرف حساب کد تفصیلی مقصد دارند.</>}
        {result.kept > 0 && <span className="text-muted"> کد مقصدِ <b className="numbers">{toPersianDigits(result.kept)}</b> طرف حساب دست‌نخورده ماند؛ از قبل ثبت شده بود و فایل کد مقصد صریح نداشت.</span>}</>}</div>}
  </section>;
}
