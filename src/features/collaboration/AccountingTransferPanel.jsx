import { Check, CircleAlert, Download, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

/**
 * وقتی یک کنترل آمادگی قرمز است، گفتن «چه چیزی خراب است» کافی نیست؛ باید
 * گفت کدام قلم و از کجا درست می‌شود. این بخش همان شکاف را پر می‌کند.
 */
function ReadinessFixHints({ readiness, navigate, notify, refresh }) {
  const [busy, setBusy] = useState(false);
  const failed = (readiness?.checks || []).filter((item) => !item.passed && item.severity !== 'advisory');
  if (!failed.length) return null;

  const chartCheck = failed.find((item) => item.id === 'chart');
  const unmapped = readiness?.chart?.unmappedUsedAccounts || [];
  const approvalCheck = failed.find((item) => item.id === 'approval');
  const mappingCheck = failed.find((item) => item.id === 'mappings');
  const templateCheck = failed.find((item) => item.id === 'template');
  const fiscalCheck = failed.find((item) => item.id === 'parsian-fiscal-year');
  const missing = readiness?.missingMappings || [];

  // بقیهٔ تنظیمات عمداً فرستاده نمی‌شوند؛ سرور فیلدهای نیامده را نگه می‌دارد،
  // پس ثبت سال مالی تأیید قالب را پاک نمی‌کند.
  const applySuggestedFiscalYear = async (suggestion) => {
    setBusy(true);
    try {
      await api.saveAccountingTransferSettings({ fiscalYearStart: suggestion.start, fiscalYearEnd: suggestion.end });
      await refresh();
      notify(`سال مالی ${toPersianDigits(suggestion.year)} ثبت شد.`);
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  const fillFromChart = async () => {
    setBusy(true);
    try {
      const result = await api.fillTransferMappingsFromChart(readiness?.target?.id, false);
      await refresh();
      notify(`کد مقصد ${toPersianDigits(result.filled)} حساب از کدینگ دفتر پر شد${result.kept ? ` و ${toPersianDigits(result.kept)} نگاشت دستی دست‌نخورده ماند` : ''}.`);
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  const applySuggestions = async () => {
    setBusy(true);
    try {
      const result = await api.applyChartSuggestions();
      await refresh();
      notify(result.unmappedCount === 0
        ? `نگاشت ${toPersianDigits(result.applied)} حساب انجام شد و این ایراد برطرف شد.`
        : `${toPersianDigits(result.applied)} حساب نگاشت شد؛ ${toPersianDigits(result.unmappedCount)} حساب هنوز معین متناسب ندارد.`);
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  return <div className="mt-3 space-y-2">
    {/* بدون بازهٔ ثبت‌شده، سرور همهٔ سندها را «بیرون از بازه» گزارش می‌کند. نمایش
        همان فهرست به‌عنوان ناسازگاری، کاربر را دنبال سندهای سالم می‌فرستد
        درحالی‌که مشکل یک فیلد پرنشده است. */}
    {fiscalCheck && (fiscalCheck.fiscalYearStart ? <div className="rounded-lg border border-expense/40 bg-expense/5 p-3 text-xs leading-6">
      <p className="font-bold text-expense">سال مالی مقصد با سندهای این بسته سازگار نیست</p>
      <p className="mt-1 text-muted">بازهٔ ثبت‌شده: <span dir="ltr" className="numbers">{fiscalCheck.fiscalYearStart} تا {fiscalCheck.fiscalYearEnd}</span></p>
      {(fiscalCheck.outsideDocuments || []).length > 0 && <ul className="mt-2 space-y-0.5">
        {fiscalCheck.outsideDocuments.slice(0, 8).map((item) => <li key={item.entryId}>سند {toPersianDigits(item.documentNumber || '—')} · <span dir="ltr" className="numbers">{item.date || 'تاریخ نامعتبر'}</span>{item.memo ? ` · ${item.memo}` : ''}</li>)}
        {fiscalCheck.outsideDocuments.length > 8 && <li className="text-muted">و {toPersianDigits(fiscalCheck.outsideDocuments.length - 8)} سند دیگر…</li>}
      </ul>}
      <p className="mt-2 text-[11px] text-muted">بازهٔ صحیح را در بخش «تنظیم مقصد» ثبت کن یا اسناد را به دورهٔ درست منتقل کن. تا آن زمان فایل ساخته و تحویل نمی‌شود.</p>
    </div> : <div className="rounded-lg border border-accent/40 bg-warn-bg p-3 text-xs leading-6">
      <p className="font-bold text-accent">بازهٔ سال مالی باز پارسیان هنوز ثبت نشده است</p>
      <p className="mt-1 text-muted">سندهای این بسته ایرادی ندارند. پارسیان سند خارج از سال مالی باز را نمی‌پذیرد، پس حساب‌یار پیش از ساختن فایل باید بداند آن بازه چیست.</p>
      {fiscalCheck.suggestedFiscalYear ? <>
        <p className="mt-2 text-muted">همهٔ سندهای این بسته در سال <b className="text-ink numbers">{toPersianDigits(fiscalCheck.suggestedFiscalYear.year)}</b> هستند.</p>
        <button
          disabled={busy}
          onClick={() => applySuggestedFiscalYear(fiscalCheck.suggestedFiscalYear)}
          className="tap mt-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
        >ثبت سال مالی <span dir="ltr" className="numbers">{fiscalCheck.suggestedFiscalYear.start} تا {fiscalCheck.suggestedFiscalYear.end}</span></button>
        <p className="mt-2 text-[11px] text-muted">اگر سال مالی باز در پارسیان شما بازهٔ دیگری است، آن را در بخش «تنظیم مقصد» دستی وارد کن.</p>
      </> : <p className="mt-2 text-[11px] text-muted">سندهای این بسته در بیش از یک سال شمسی‌اند، پس بازه حدس زده نمی‌شود. آن را در بخش «تنظیم مقصد — یک بار انجام می‌شود» بالای همین صفحه وارد کن.</p>}
    </div>)}
    {chartCheck && <div className="rounded-lg border border-expense/40 bg-expense/5 p-3 text-xs leading-6">
      <p className="font-bold text-expense">این حساب‌ها هنوز معین مقصد ندارند</p>
      {unmapped.length > 0 && <ul className="mt-2 space-y-0.5">
        {unmapped.slice(0, 8).map((item) => <li key={item.id}><span className="numbers text-muted">{toPersianDigits(item.code)}</span> · {item.name}</li>)}
        {unmapped.length > 8 && <li className="text-muted">و {toPersianDigits(unmapped.length - 8)} حساب دیگر…</li>}
      </ul>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button disabled={busy} onClick={applySuggestions} className="tap rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-white disabled:opacity-45">
          {busy ? 'در حال نگاشت…' : 'اعمال نگاشت پیشنهادی'}
        </button>
        <button onClick={() => navigate('chart')} className="tap rounded-lg border border-line bg-paper px-3 py-1.5 text-xs font-bold">نگاشت دستی در صفحهٔ کدینگ</button>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-muted">
        حساب‌یار برای هر حساب، معین هم‌نوع کدینگ تو را پیشنهاد می‌دهد. اگر حسابی معین متناسب نداشت، اول آن معین را در کدینگ بساز.
      </p>
    </div>}

    {mappingCheck && <div className="rounded-lg border border-expense/40 bg-expense/5 p-3 text-xs leading-6">
      <p className="font-bold text-expense">{toPersianDigits(mappingCheck.count)} حساب هنوز کد مقصد ندارد</p>
      {missing.length > 0 && <ul className="mt-2 space-y-0.5">
        {missing.slice(0, 8).map((item) => <li key={item.id}><span className="numbers text-muted">{toPersianDigits(item.code)}</span> · {item.name}</li>)}
        {missing.length > 8 && <li className="text-muted">و {toPersianDigits(missing.length - 8)} حساب دیگر…</li>}
      </ul>}
      <button disabled={busy} onClick={fillFromChart} className="tap mt-3 rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-white disabled:opacity-45">
        {busy ? 'در حال پرکردن…' : 'پرکردن کد مقصد از کدینگ دفتر'}
      </button>
      <p className="mt-2 text-[11px] leading-5 text-muted">
        کدینگی که در حساب‌یار وارد کرده‌ای همان کدینگ نرم‌افزار مقصد توست، پس کد مقصد از روی آن پر می‌شود.
        نگاشت‌هایی که خودت دستی نوشته‌ای بازنویسی نمی‌شوند. اگر حسابی به کدینگ وصل نباشد، اول در صفحهٔ کدینگ نگاشتش کن.
      </p>
    </div>}

    {templateCheck && <div className="rounded-lg border border-expense/40 bg-expense/5 p-3 text-xs leading-6">
      <p className="font-bold text-expense">قالب مقصد هنوز کنترل و نام‌گذاری نشده است</p>
      <p className="mt-1 text-[11px] leading-5 text-muted">
        در همین صفحه، کادر «نام یا نسخهٔ قالب کنترل‌شده» را پر کن و تیک تأیید حسابدار را بزن، بعد «ذخیره کنترل قالب».
        این تأیید یعنی خودت ستون‌ها و واحد پول را روی یک شرکت آزمایشی دیده‌ای؛ ادعای پشتیبانی رسمی سازنده نیست.
      </p>
    </div>}

    {approvalCheck && <div className="rounded-lg border border-expense/40 bg-expense/5 p-3 text-xs leading-6">
      <p className="font-bold text-expense">{toPersianDigits(approvalCheck.count)} سند هنوز کنترل نشده است</p>
      <button onClick={() => navigate('accounting')} className="tap mt-2 rounded-lg border border-line bg-paper px-3 py-1.5 text-xs font-bold">رفتن به کارتابل سند</button>
    </div>}
  </div>;
}

export function TransferLayoutPanel({ target, settings, readiness, notify, refresh }) {
  const [catalogue, setCatalogue] = useState(null);
  const [columns, setColumns] = useState([]);
  const [fileFormat, setFileFormat] = useState('csv');
  const [amountUnit, setAmountUnit] = useState('toman');
  const [fiscalYearStart, setFiscalYearStart] = useState('');
  const [fiscalYearEnd, setFiscalYearEnd] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.transferFields().then(setCatalogue).catch((error) => notify(error.message));
  }, [notify]);

  useEffect(() => {
    setColumns(settings?.columns || []);
    setFileFormat(settings?.fileFormat || 'csv');
    setAmountUnit(settings?.amountUnit || 'toman');
    // فیلد خالی، کاربر را با یک سؤال تنها می‌گذارد. بازهٔ سالِ خود سندها از پیش
    // نوشته می‌شود تا در حالت رایج فقط ذخیره لازم باشد — دیده می‌شود و قابل
    // تغییر است، پس حدسِ خاموش نیست.
    const suggested = (readiness?.checks || []).find((item) => item.id === 'parsian-fiscal-year')?.suggestedFiscalYear;
    setFiscalYearStart(settings?.fiscalYearStart || suggested?.start || '');
    setFiscalYearEnd(settings?.fiscalYearEnd || suggested?.end || '');
  }, [settings, readiness]);

  const move = (index, step) => {
    const next = [...columns];
    const target_ = index + step;
    if (target_ < 0 || target_ >= next.length) return;
    [next[index], next[target_]] = [next[target_], next[index]];
    setColumns(next);
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.saveAccountingTransferSettings({ targetSystem: target, fileFormat, amountUnit, columns, fiscalYearStart, fiscalYearEnd });
      await refresh();
      notify('قالب ستونی خروجی ذخیره شد.');
    } catch (error) {
      notify(error.details?.errors?.[0]?.message || error.message);
    }
    setBusy(false);
  };

  if (!catalogue) return null;
  const unused = catalogue.fields.filter((field) => !columns.some((column) => column.field === field.id));

  return <section className="mt-5 rounded-[10px] border border-line bg-surface p-4">
    <p className="font-bold">چیدمان ستون‌های خروجی</p>
    <p className="mt-1 max-w-2xl text-[12px] leading-6 text-muted">
      حساب‌یار قالب رسمی هیچ نسخه‌ای از پارسیان را نمی‌داند و ادعایش را هم نمی‌کند. یک بار بگو فایل ورودی نرم‌افزارت
      چه ستون‌هایی با چه نام و ترتیبی می‌خواهد؛ از آن به بعد خروجی دقیقاً همان می‌شود.
    </p>

    <div className="mt-3 flex flex-wrap gap-4">
      <label className="text-[13px] font-bold">نوع فایل خروجی
        <select value={fileFormat} onChange={(event) => setFileFormat(event.target.value)} className="tap mr-2 rounded-lg border border-line bg-paper px-2 text-[13px] font-normal">
          {catalogue.formats.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label className="text-[13px] font-bold">واحد ستون‌های مبلغ
        <select value={amountUnit} onChange={(event) => setAmountUnit(event.target.value)} className="tap mr-2 rounded-lg border border-line bg-paper px-2 text-[13px] font-normal"><option value="toman">تومان</option><option value="rial">ریال</option></select>
      </label>
    </div>

    {fileFormat === 'mdb' && <div className="mt-4 rounded-lg border border-line bg-paper p-3">
      <p className="text-[13px] font-bold">فایل پایهٔ Access پارسیان</p>
      <p className="mt-1 max-w-2xl text-[12px] leading-6 text-muted">
        این فایل پایه، خروجی خالی همان نصب پارسیان است و سندها روی یک نسخهٔ کپی‌شده از آن نوشته می‌شوند. یک بار در پارسیان خودت
        <b> امکانات ← سامانه تبادل اطلاعات ← سامانه تبادل اطلاعات اسناد ← انتقال اسناد به فایل </b>
        را بزن و همان فایل را اینجا بده. از آن به بعد حساب‌یار فقط سندها را داخل همان الگو می‌نویسد،
        پس ساختار فایل دقیقاً همانی می‌ماند که نرم‌افزار خودت ساخته است.
      </p>
      {settings?.hasTransferTemplate
        ? <p className="mt-2 text-[12px] text-ok">فایل پایه بارگذاری شده{settings.transferTemplateName ? `: ${settings.transferTemplateName}` : ''}. با فایل تازه جایگزین می‌شود.</p>
        : <p className="mt-2 text-[12px] text-danger">هنوز فایل پایه بارگذاری نشده؛ تا آن موقع فایل انتقال ساخته نمی‌شود.</p>}
      <input
        type="file" className="mt-2 w-full text-[12px]" disabled={busy === 'template'}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setBusy('template');
          try {
            await api.saveTransferTemplate(target, file);
            await refresh();
            notify('الگوی انتقال پارسیان ذخیره شد.');
          } catch (error) { notify(error.message); }
          setBusy(false);
        }}
      />
      <div className="mt-3 rounded-lg bg-surface p-3 text-[12px] leading-6">
        <b className="text-[13px]">سال مالی چیست و چرا پرسیده می‌شود؟</b>
        <p className="mt-1 text-muted">
          در پارسیان هر شرکت یک سال مالی دارد؛ مثل پوشه‌ای که سندهای آن سال داخلش می‌روند. معمولاً
          <b className="numbers"> ۱ فروردین تا ۲۹ اسفند</b>، ولی بعضی شرکت‌ها بازهٔ دیگری دارند (مثلاً ۱ مهر تا ۳۱ شهریور).
        </p>
        <p className="mt-1 text-muted">
          پارسیان سندی را که تاریخش بیرون از این پوشه باشد نمی‌پذیرد. حساب‌یار نمی‌داند پوشهٔ باز شرکت تو
          کدام است، پس همین‌جا می‌پرسد تا اگر ناسازگاری هست پیش از ساخت فایل بفهمی، نه بعد از رد شدنش.
        </p>
        <p className="mt-1 text-muted">
          مقدار زیر از تاریخ سندهای همین بسته پر شده است. اگر شرکتت سال مالی خاصی ندارد همین درست است؛
          اگر مطمئن نیستی، از حسابدارت بپرس سال مالی باز در پارسیان چه بازه‌ای است.
        </p>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-muted">
        ورود دوبارهٔ یک فایل سند تکراری می‌سازد، چون پارسیان تکراری را تشخیص نمی‌دهد.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-[12px] font-bold">شروع سال مالی باز
          <input dir="ltr" inputMode="numeric" value={fiscalYearStart} onChange={(event) => setFiscalYearStart(event.target.value)} placeholder="1405/01/01" className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-left numbers" />
        </label>
        <label className="text-[12px] font-bold">پایان سال مالی باز
          <input dir="ltr" inputMode="numeric" value={fiscalYearEnd} onChange={(event) => setFiscalYearEnd(event.target.value)} placeholder="1405/12/29" className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-left numbers" />
        </label>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-muted">این بازه باید دقیقاً با شرکت مقصد در پارسیان یکی باشد. حساب‌یار فایل دارای سند خارج از این بازه را تولید یا تحویل نمی‌دهد.</p>
      <p className="mt-2 text-[11px] leading-5 text-muted">اگر بسته بیشتر از ۴۰۱ ردیف داشته باشد، حساب‌یار بدون شکستن هیچ سندی آن را به چند فایل تقسیم می‌کند و یک ZIP شامل ترتیب ورود، جمع‌ها و هش هر بخش می‌سازد.</p>
    </div>}

    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[560px] text-right text-[13px]">
        <thead className="border-b border-line text-[12px] text-muted"><tr><th className="pb-2 pl-2 font-bold">#</th><th className="pb-2 pl-2 font-bold">عنوان ستون در فایل مقصد</th><th className="pb-2 pl-2 font-bold">دادهٔ حساب‌یار</th><th className="pb-2 font-bold">ترتیب</th></tr></thead>
        <tbody>
          {columns.map((column, index) => <tr key={`${column.field}-${index}`} className="border-b border-line">
            <td className="numbers py-2 pl-2 text-muted">{toPersianDigits(index + 1)}</td>
            <td className="py-2 pl-2">
              <input value={column.header} onChange={(event) => setColumns(columns.map((item, position) => (position === index ? { ...item, header: event.target.value } : item)))} className="tap w-full rounded-lg border border-line bg-paper px-2 text-[13px]" />
            </td>
            <td className="py-2 pl-2 text-muted">{catalogue.fields.find((field) => field.id === column.field)?.label || column.field}</td>
            <td className="whitespace-nowrap py-2">
              <button type="button" onClick={() => move(index, -1)} className="tap px-1 text-muted">▲</button>
              <button type="button" onClick={() => move(index, 1)} className="tap px-1 text-muted">▼</button>
              <button type="button" onClick={() => setColumns(columns.filter((_item, position) => position !== index))} className="tap px-1 text-expense"><Trash2 size={15} /></button>
            </td>
          </tr>)}
          {!columns.length && <tr><td colSpan={4} className="py-4 text-center text-muted">هیچ ستونی نمانده؛ حداقل کد حساب و دو ستون مبلغ لازم است.</td></tr>}
        </tbody>
      </table>
    </div>

    {unused.length > 0 && <div className="mt-3">
      <p className="text-[12px] text-muted">افزودن ستون:</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {unused.map((field) => <button key={field.id} type="button" onClick={() => setColumns([...columns, { field: field.id, header: field.label }])} className="tap rounded border border-line bg-paper px-2 py-0.5 text-[12px]">+ {field.label}</button>)}
      </div>
    </div>}

    <button disabled={busy} onClick={save} className="tap mt-4 rounded-lg bg-accent px-4 font-bold text-white disabled:opacity-45">{busy ? 'در حال ذخیره…' : 'ذخیرهٔ قالب'}</button>
  </section>;
}

export function AccountingTransferPanel({ month, target, setTarget, overview, notify, refresh, navigate }) {
  const [settingsDraft, setSettingsDraft] = useState({ templateName: '', templateVerified: false, note: '' });
  const [mappingDrafts, setMappingDrafts] = useState({});
  const [busy, setBusy] = useState('');
  const [validationBatchId, setValidationBatchId] = useState('');
  const [validationDraft, setValidationDraft] = useState({ softwareName: 'پارسیان', softwareVersion: '', testCompanyLabel: '', attemptType: 'dry-run', outcome: 'failed', amountUnit: 'rial', importedRows: '', rejectedRows: '0', importedDebitTotal: '', importedCreditTotal: '', errorSummary: '', note: '' });
  const readiness = overview?.readiness || {};
  const targets = overview?.targets || [];

  useEffect(() => {
    setSettingsDraft({
      templateName: overview?.settings?.templateName || '',
      templateVerified: Boolean(overview?.settings?.templateVerified),
      note: overview?.settings?.note || '',
    });
    setMappingDrafts(Object.fromEntries((readiness.accounts || []).map((item) => [item.id, {
      targetCode: item.mapping?.targetCode || '', targetName: item.mapping?.targetName || '',
    }])));
  }, [overview, readiness.accounts]);

  const saveSettings = async () => {
    setBusy('settings');
    try {
      await api.saveAccountingTransferSettings({ targetSystem: target, ...settingsDraft });
      await refresh();
      notify('تنظیمات پل انتقال حسابداری ذخیره شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const saveMapping = async (accountId) => {
    setBusy(`mapping-${accountId}`);
    try {
      await api.saveAccountingTransferMapping(accountId, { targetSystem: target, ...(mappingDrafts[accountId] || {}) });
      await refresh();
      notify('کد حساب مقصد ذخیره شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const redownloadOptions = (item) => {
    if (!item?.redownloadRequired) return {};
    const confirmed = window.confirm(`این بسته قبلاً ${toPersianDigits(item.downloadCount || 1)} بار دریافت شده است. پارسیان فایل تکراری را بدون هشدار دوباره وارد می‌کند. دریافت دوباره را تأیید می‌کنی؟`);
    if (!confirmed) return null;
    const reason = String(window.prompt('علت دریافت دوباره را بنویس؛ این متن در سابقهٔ حسابرسی ذخیره می‌شود:') || '').trim();
    if (reason.length < 8) {
      notify('برای دریافت دوباره، علت را حداقل در ۸ نویسه بنویس.');
      return null;
    }
    return { confirmRedownload: true, reason };
  };
  const createBatch = async () => {
    setBusy('batch');
    try {
      const result = await api.createAccountingTransferBatch({ month, targetSystem: target });
      const options = redownloadOptions(result.item);
      if (options === null) return;
      const downloaded = await api.downloadAccountingTransferBatch(result.item.id, result.item.fileName, options);
      await refresh();
      notify(`خروجی ${downloaded.fileName} دریافت و سابقهٔ تحویل ثبت شد.`);
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const downloadBatch = async (item) => {
    const options = redownloadOptions(item);
    if (options === null) return;
    try {
      const result = await api.downloadAccountingTransferBatch(item.id, item.fileName, options);
      await refresh();
      notify(`فایل ${result.fileName} دریافت شد؛ نوبت دریافت: ${toPersianDigits(result.downloadCount)}.`);
    }
    catch (error) { notify(error.message); }
  };
  const updateStatus = async (item, status) => {
    const note = status === 'rejected' ? window.prompt('دلیل رد خروجی را بنویس:') : '';
    if (status === 'rejected' && !note) return;
    try { await api.updateAccountingTransferBatchStatus(item.id, status, note || ''); await refresh(); notify('وضعیت تحویل خروجی ثبت شد.'); }
    catch (error) { notify(error.message); }
  };
  const openValidation = (item) => {
    setValidationBatchId(validationBatchId === item.id ? '' : item.id);
    setValidationDraft({
      softwareName: item.targetSystem === 'parsian-review-csv' ? 'پارسیان' : '', softwareVersion: '', testCompanyLabel: '',
      attemptType: 'dry-run', outcome: 'failed', amountUnit: 'rial', importedRows: String(item.rowCount), rejectedRows: '0',
      importedDebitTotal: String(Number(item.debitTotal) * 10), importedCreditTotal: String(Number(item.creditTotal) * 10),
      errorSummary: '', note: '',
    });
  };
  const saveValidation = async (event, item) => {
    event.preventDefault();
    setBusy(`validation-${item.id}`);
    try {
      await api.createAccountingTransferValidation(item.id, {
        ...validationDraft,
        importedRows: Number(validationDraft.importedRows || 0), rejectedRows: Number(validationDraft.rejectedRows || 0),
        importedDebitTotal: Number(validationDraft.importedDebitTotal || 0), importedCreditTotal: Number(validationDraft.importedCreditTotal || 0),
      });
      setValidationBatchId('');
      await refresh();
      notify('نتیجهٔ آزمون شرکت آزمایشی ثبت شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const statusLabel = { generated: 'ساخته‌شده', delivered: 'فایل دریافت شده', accepted: 'ورود تأیید شد', rejected: 'رد شده' };
  const validationLabel = { 'dry-run': 'Dry Run', 'trial-import': 'ورود آزمایشی', passed: 'موفق', failed: 'ناموفق' };

  return <section className="mt-4 rounded-[12px] border border-line bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold text-accent">فاز ۸ · اعتبارسنجی انتقال واقعی</p><h2 className="mt-1 font-extrabold">خروجی کنترل‌شده و آزمون شرکت نمونه</h2><p className="mt-1 max-w-[680px] text-xs leading-6 text-muted">هر بسته علاوه بر هش ثابت، نتیجهٔ Dry Run و ورود آزمایشی را با نسخهٔ نرم‌افزار، ردیف‌های ردشده و جمع بدهکار/بستانکار ثبت می‌کند. خروجی پارسیان بدون آزمون ورود موفق قابل پذیرش نیست.</p></div><label className="text-xs text-muted">مقصد خروجی<select value={target} onChange={(event) => setTarget(event.target.value)} className="tap mt-2 block rounded-lg border border-line bg-paper px-3 text-ink">{targets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>

    <div className="mt-4 grid gap-4 lg:grid-cols-[.9fr_1.1fr]">
      <div><div className="divide-y divide-line rounded-lg border border-line px-3">{(readiness.checks || []).map((item) => <div key={item.id} className="flex min-h-11 items-center gap-2 py-2 text-xs"><span className={`grid h-5 w-5 place-items-center rounded-full ${item.passed ? 'bg-income/10 text-income' : 'bg-expense/10 text-expense'}`}>{item.passed ? <Check size={14} /> : <CircleAlert size={14} />}</span><span className="flex-1 font-bold">{item.label}</span>{!item.passed && <b className="numbers text-expense">{toPersianDigits(item.count || 0)}</b>}</div>)}</div>
      <ReadinessFixHints readiness={readiness} navigate={navigate} notify={notify} refresh={refresh} />
      <div className="mt-3 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-paper p-3"><span className="text-[10px] text-muted">سند</span><b className="numbers mt-1 block">{toPersianDigits(readiness.entryCount || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-[10px] text-muted">ردیف</span><b className="numbers mt-1 block">{toPersianDigits(readiness.rowCount || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-[10px] text-muted">جمع بدهکار</span><b className="numbers mt-1 block text-[11px]">{formatAmount(readiness.debitTotal || 0)}</b></div></div><button disabled={!readiness.ready || busy === 'batch'} onClick={createBatch} className="tap mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-ink font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"><Download size={17} />{busy === 'batch' ? 'در حال ساخت…' : `ساخت و دریافت ${{ xlsx: 'اکسل', mdb: 'فایل انتقال پارسیان' }[overview?.settings?.fileFormat] || 'CSV'}`}</button><p className="mt-2 text-[10px] leading-5 text-muted">{readiness.disclaimer}</p></div>

      <div>{target === 'parsian-review-csv' ? <><div className="rounded-lg border border-line bg-paper p-3"><label className="text-xs text-muted">نام یا نسخهٔ قالب کنترل‌شده<input value={settingsDraft.templateName} onChange={(event) => setSettingsDraft({ ...settingsDraft, templateName: event.target.value })} placeholder="مثلاً خروجی نمونه پارسیان شرکت آزمایشی" className="tap mt-2 w-full rounded-lg border border-line bg-surface px-3" /></label><label className="mt-3 flex items-start gap-2 text-xs leading-6"><input type="checkbox" checked={settingsDraft.templateVerified} onChange={(event) => setSettingsDraft({ ...settingsDraft, templateVerified: event.target.checked })} className="mt-1" /><span>حسابدار ستون‌ها و واحد پول را با یک شرکت آزمایشی کنترل کرده است؛ این تأیید به معنی پشتیبانی رسمی سازنده نیست.</span></label><button disabled={busy === 'settings'} onClick={saveSettings} className="tap mt-3 rounded-lg border border-ink px-3 text-xs font-bold">ذخیره کنترل قالب</button></div><div className="mt-3 space-y-2">{(readiness.accounts || []).map((account) => { const draft = mappingDrafts[account.id] || { targetCode: '', targetName: '' }; return <div key={account.id} className="grid gap-2 rounded-lg border border-line p-3 md:grid-cols-[minmax(0,1fr)_120px_minmax(0,1fr)_70px]"><div><b className="text-xs">{account.name}</b><p className="numbers mt-1 text-[10px] text-muted">{account.code}</p></div><input value={draft.targetCode} onChange={(event) => setMappingDrafts({ ...mappingDrafts, [account.id]: { ...draft, targetCode: event.target.value } })} placeholder="کد مقصد" dir="ltr" className="tap rounded-lg border border-line px-2 text-left text-xs" /><input value={draft.targetName} onChange={(event) => setMappingDrafts({ ...mappingDrafts, [account.id]: { ...draft, targetName: event.target.value } })} placeholder="نام حساب مقصد" className="tap rounded-lg border border-line px-2 text-xs" /><button disabled={!draft.targetCode || busy === `mapping-${account.id}`} onClick={() => saveMapping(account.id)} className="tap rounded-lg bg-accent px-2 text-xs font-bold text-white disabled:opacity-40">ذخیره</button></div>; })}</div></> : <div className="rounded-lg bg-paper p-4 text-xs leading-6 text-muted"><b className="text-ink">قالب استاندارد حساب‌یار</b><p className="mt-2">هر ردیف دفتر کل با بدهکار/بستانکار تومان و ریال، کد و نام حساب، نوع و شناسهٔ منبع و تاریخ شمسی/ISO صادر می‌شود. متن‌های خطرناک برای Formula Injection خنثی می‌شوند.</p></div>}</div>
    </div>

    <div className="mt-4 border-t border-line pt-4"><h3 className="text-sm font-extrabold">سابقهٔ بسته‌ها و آزمون انتقال</h3><div className="mt-3 space-y-2">{overview?.batches?.length ? overview.batches.map((item) => <article key={item.id} className="rounded-lg bg-paper p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <b>{item.fileName}</b>
          <p className="mt-1 text-[10px] text-muted">SHA-256: <span dir="ltr">{item.digest.slice(0, 16)}…</span> · {toPersianDigits(item.entryCount)} سند · {toPersianDigits(item.rowCount)} ردیف · {toPersianDigits(item.downloadCount || 0)} بار دریافت</p>
          {item.latestValidation && <p className={`mt-2 text-[11px] font-bold ${item.latestValidation.outcome === 'passed' ? 'text-income' : 'text-expense'}`}>آخرین آزمون: {validationLabel[item.latestValidation.attemptType]} {validationLabel[item.latestValidation.outcome]} · {item.latestValidation.softwareName} {item.latestValidation.softwareVersion}</p>}
        </div>
        <span className={`rounded-md px-2 py-1 font-bold ${item.status === 'accepted' ? 'bg-income/10 text-income' : item.status === 'rejected' ? 'bg-expense/10 text-expense' : 'bg-surface text-muted'}`}>{statusLabel[item.status]}</span>
        <button onClick={() => downloadBatch(item)} className={`tap rounded-lg border px-2 text-[11px] font-bold ${item.redownloadRequired ? 'border-expense/30 text-expense' : 'border-line'}`}>{item.redownloadRequired ? 'دریافت دوباره' : 'دریافت'}</button>
        {!['accepted', 'rejected'].includes(item.status) && <button onClick={() => openValidation(item)} className="tap rounded-lg border border-ink px-2 text-[11px] font-bold">ثبت آزمون</button>}
        {!['accepted', 'rejected'].includes(item.status) && <button disabled={!item.acceptanceReady} onClick={() => updateStatus(item, 'accepted')} className="tap rounded-lg border border-income/30 px-2 text-[11px] font-bold text-income disabled:cursor-not-allowed disabled:opacity-35">ورود تأیید شد</button>}
        {!['accepted', 'rejected'].includes(item.status) && <button onClick={() => updateStatus(item, 'rejected')} className="tap rounded-lg border border-expense/30 px-2 text-[11px] font-bold text-expense">رد</button>}
      </div>
      {validationBatchId === item.id && <form onSubmit={(event) => saveValidation(event, item)} className="mt-3 grid gap-2 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-4"><input required value={validationDraft.softwareName} onChange={(event) => setValidationDraft({ ...validationDraft, softwareName: event.target.value })} placeholder="نام نرم‌افزار" className="tap rounded-lg border border-line px-2" /><input required value={validationDraft.softwareVersion} onChange={(event) => setValidationDraft({ ...validationDraft, softwareVersion: event.target.value })} placeholder="نسخه دقیق پارسیان" dir="ltr" className="tap rounded-lg border border-line px-2 text-left" /><input required value={validationDraft.testCompanyLabel} onChange={(event) => setValidationDraft({ ...validationDraft, testCompanyLabel: event.target.value })} placeholder="برچسب شرکت آزمایشی" className="tap rounded-lg border border-line px-2" /><select value={validationDraft.attemptType} onChange={(event) => setValidationDraft({ ...validationDraft, attemptType: event.target.value })} className="tap rounded-lg border border-line px-2"><option value="dry-run">Dry Run</option><option value="trial-import">ورود آزمایشی واقعی</option></select><select value={validationDraft.outcome} onChange={(event) => setValidationDraft({ ...validationDraft, outcome: event.target.value })} className="tap rounded-lg border border-line px-2"><option value="failed">ناموفق</option><option value="passed">موفق</option></select><select value={validationDraft.amountUnit} onChange={(event) => { const amountUnit = event.target.value; const multiplier = amountUnit === 'rial' ? 10 : 1; setValidationDraft({ ...validationDraft, amountUnit, importedDebitTotal: String(Number(item.debitTotal) * multiplier), importedCreditTotal: String(Number(item.creditTotal) * multiplier) }); }} className="tap rounded-lg border border-line px-2"><option value="rial">جمع مقصد به ریال</option><option value="toman">جمع مقصد به تومان</option></select><input required inputMode="numeric" value={validationDraft.importedRows} onChange={(event) => setValidationDraft({ ...validationDraft, importedRows: event.target.value.replace(/\D/g, '') })} placeholder="ردیف واردشده" className="tap numbers rounded-lg border border-line px-2" /><input required inputMode="numeric" value={validationDraft.rejectedRows} onChange={(event) => setValidationDraft({ ...validationDraft, rejectedRows: event.target.value.replace(/\D/g, '') })} placeholder="ردیف ردشده" className="tap numbers rounded-lg border border-line px-2" /><input required inputMode="numeric" value={validationDraft.importedDebitTotal} onChange={(event) => setValidationDraft({ ...validationDraft, importedDebitTotal: event.target.value.replace(/\D/g, '') })} placeholder="جمع بدهکار مقصد" className="tap numbers rounded-lg border border-line px-2" /><input required inputMode="numeric" value={validationDraft.importedCreditTotal} onChange={(event) => setValidationDraft({ ...validationDraft, importedCreditTotal: event.target.value.replace(/\D/g, '') })} placeholder="جمع بستانکار مقصد" className="tap numbers rounded-lg border border-line px-2" /><input value={validationDraft.errorSummary} onChange={(event) => setValidationDraft({ ...validationDraft, errorSummary: event.target.value })} placeholder="خطاهای مشاهده‌شده؛ برای ناموفق الزامی" className="tap rounded-lg border border-line px-2 lg:col-span-2" /><textarea value={validationDraft.note} onChange={(event) => setValidationDraft({ ...validationDraft, note: event.target.value })} placeholder="یادداشت و مدرک آزمون؛ بدون اطلاعات محرمانه" className="min-h-16 rounded-lg border border-line p-2 sm:col-span-2 lg:col-span-3" /><button disabled={busy === `validation-${item.id}`} className="tap rounded-lg bg-ink px-3 font-bold text-white">ثبت نتیجه آزمون</button><p className="text-[10px] leading-5 text-muted sm:col-span-2 lg:col-span-4">برای نتیجهٔ موفق، تعداد ردیف باید دقیقاً {toPersianDigits(item.rowCount)}، ردیف ردشده صفر و جمع بدهکار و بستانکار برابر هش/مبالغ همین بسته باشد.</p></form>}
    </article>) : <p className="rounded-lg bg-paper px-3 py-4 text-center text-xs text-muted">هنوز خروجی ثابتی ساخته نشده است.</p>}</div></div>
  </section>;
}
