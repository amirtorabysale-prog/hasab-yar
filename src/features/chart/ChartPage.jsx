import { useCallback, useEffect, useState } from 'react';
import ExcelImportPanel from '../accounting/ExcelImportPanel.jsx';
import ParsianBackupPanel from './ParsianBackupPanel.jsx';
import { FirmSummaryTile } from '../firm/FirmConsolePage.jsx';
import { api } from '../../lib/api.js';
import { digitsOnly } from '../../components/common.jsx';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

const CHART_LEVEL_STYLE = { group: 'font-extrabold', general: 'font-bold pr-4', subsidiary: 'pr-8 text-muted' };

/**
 * تیک «تفصیلی اجباری» روی معین.
 *
 * این تیک می‌گوید نرم‌افزار دفتر برای این معین حتماً کد تفصیلی می‌خواهد. اگر
 * روشن باشد و ردیفی بدون تفصیلی بماند، خروجی ساخته نمی‌شود — چون پارسیان آن
 * ردیف را بی‌صدا کنار می‌گذارد و سند را نامتوازن نشان می‌دهد.
 */
function RequiresAnalyticToggle({ item, canManage, notify, onSaved }) {
  const [saving, setSaving] = useState(false);
  if (!item.postable) return <span className="text-muted">—</span>;
  const toggle = async (next) => {
    setSaving(true);
    try { await api.saveChartAccount({ id: item.id, code: item.code, requiresAnalytic: next }); await onSaved(); }
    catch (error) { notify(error.message); }
    setSaving(false);
  };
  return <label className="flex items-center gap-1.5 text-[12px]">
    <input type="checkbox" checked={Boolean(item.requiresAnalytic)} disabled={!canManage || saving} onChange={(event) => toggle(event.target.checked)} />
    <span className={item.requiresAnalytic ? 'text-accent' : 'text-muted'}>{item.requiresAnalytic ? 'دارد' : 'ندارد'}</span>
  </label>;
}

function ChartMappingRow({ item, chartAccounts, notify, onChanged }) {
  const [saving, setSaving] = useState(false);
  const options = chartAccounts.filter((account) => account.postable && account.active && account.type === item.type);
  const choose = async (chartAccountId) => {
    setSaving(true);
    try { await api.mapLedgerAccount(item.id, chartAccountId || null); await onChanged(); }
    catch (error) { notify(error.message); }
    setSaving(false);
  };
  return <tr className="border-b border-line">
    <td className="py-2 pl-3"><span className="numbers text-muted">{toPersianDigits(item.code)}</span></td>
    <td className="py-2 pl-3"><p className="truncate font-bold">{item.name}</p><p className="text-xs text-muted">{item.typeLabel}</p></td>
    <td className="py-2 pl-3">
      <select
        value={item.chartAccountId || ''} disabled={saving || !options.length}
        onChange={(event) => choose(event.target.value)}
        className={`tap w-full rounded-lg border px-2 text-[13px] ${item.mapped ? 'border-line bg-surface' : 'border-expense/50 bg-expense/5'}`}
      >
        <option value="">— بدون نگاشت —</option>
        {options.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
      </select>
      {!item.mapped && item.suggestion && <p className="mt-1 text-xs text-accent">پیشنهاد: {item.suggestion.code} · {item.suggestion.name}</p>}
      {!options.length && <p className="mt-1 text-xs text-expense">هیچ معین هم‌نوعی در کدینگ نیست.</p>}
    </td>
  </tr>;
}

/**
 * نگاشت گروهی حساب‌های بدون نگاشت به یک معین.
 *
 * حساب‌یار دیگر «اولین معین هم‌نوع» را حدس نمی‌زند، چون آن حدس در کدینگ یک
 * دفتر واقعی همهٔ هزینه‌ها را روی «بازاریاب» نشاند. ولی جایگزینش نباید
 * پنجاه‌بار باز کردن فهرست کشویی باشد: حسابدار یک‌بار معین را انتخاب می‌کند و
 * همهٔ حساب‌های بدون نگاشتِ آن نوع با هم می‌نشینند.
 */
function BulkMappingBar({ mapping, chartAccounts, notify, onChanged }) {
  const [type, setType] = useState('');
  const [chartAccountId, setChartAccountId] = useState('');
  const [busy, setBusy] = useState(false);

  const unmapped = (mapping.items || []).filter((item) => !item.mapped);
  const types = [...new Map(unmapped.map((item) => [item.type, item.typeLabel || item.type])).entries()];
  const activeType = type || types[0]?.[0] || '';
  const targets = unmapped.filter((item) => item.type === activeType);
  const options = chartAccounts.filter((account) => account.postable && account.active && account.type === activeType);
  if (!unmapped.length) return null;

  const apply = async () => {
    if (!chartAccountId) return;
    setBusy(true);
    try {
      const result = await api.mapLedgerAccountsInBulk(targets.map((item) => item.id), chartAccountId);
      await onChanged();
      notify(result.skipped.length
        ? `${toPersianDigits(result.mapped)} حساب نگاشت شد؛ ${toPersianDigits(result.skipped.length)} حساب به‌خاطر ناسازگاری نوع کنار ماند.`
        : `${toPersianDigits(result.mapped)} حساب به این معین نگاشت شد.`);
      setChartAccountId('');
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  return <div className="mt-3 rounded-lg border border-accent/40 bg-warn-bg p-3">
    <p className="text-[13px] font-bold text-accent">نگاشت گروهی — {toPersianDigits(unmapped.length)} حساب بدون نگاشت</p>
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
      <select value={activeType} onChange={(event) => { setType(event.target.value); setChartAccountId(''); }} className="tap rounded-lg border border-line bg-paper px-2">
        {types.map(([id, label]) => <option key={id} value={id}>{label} ({toPersianDigits(unmapped.filter((item) => item.type === id).length)})</option>)}
      </select>
      <select value={chartAccountId} onChange={(event) => setChartAccountId(event.target.value)} className="tap min-w-[220px] rounded-lg border border-line bg-paper px-2">
        <option value="">— معین مقصد را انتخاب کن —</option>
        {options.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
      </select>
      <button
        disabled={!chartAccountId || busy || !targets.length}
        onClick={apply}
        className="tap rounded-lg bg-accent px-4 font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90 active:bg-accent/80"
      >{busy ? 'در حال نگاشت…' : `اعمال به ${toPersianDigits(targets.length)} حساب`}</button>
    </div>
    <p className="mt-2 text-xs leading-5 text-muted">
      همهٔ حساب‌های بدون نگاشتِ این نوع روی یک معین می‌نشینند. اگر بعضی از آن‌ها معین جداگانه دارند، اول همان‌ها را تکی نگاشت کن و بعد بقیه را گروهی.
    </p>
  </div>;
}

const CHART_TABS = ['mapping', 'chart', 'dimensions', 'import', 'parsian'];

export function ChartPage({ access, notify, initialTab = '', onTabChange, refreshApp }) {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [csv, setCsv] = useState('');
  const [tab, setTab] = useState(CHART_TABS.includes(initialTab) ? initialTab : 'mapping');
  useEffect(() => { if (CHART_TABS.includes(initialTab)) setTab(initialTab); }, [initialTab]);
  const [dimension, setDimension] = useState(null);
  const canManage = ['owner', 'manager'].includes(access?.workspace?.role);

  const load = useCallback(async () => {
    setLoading(true);
    try { setOverview(await api.chartOverview()); }
    catch (error) { notify(error.message); }
    setLoading(false);
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  // پیام موفقیت گاهی به نتیجه بستگی دارد («۳ نگاشت منتقل شد» در برابر «چیزی
  // تغییر نکرد»)، پس مقدار برگشتی اقدام هم می‌تواند پیام باشد.
  const run = async (action, success) => {
    try { const outcome = await action(); await load(); notify(typeof outcome === 'string' ? outcome : success); }
    catch (error) { notify(error.details?.errors?.[0] ? `ردیف ${error.details.errors[0].rowNumber}: ${error.details.errors[0].message}` : error.message); }
  };

  const mapping = overview?.mapping;
  const accounts = overview?.accounts || [];

  return <section className="mx-auto w-full max-w-[980px] px-4 py-6">
    <div>
      <h1 className="mt-1 text-xl font-extrabold">کدینگ، تفصیلی شناور و مرکز هزینه</h1>
      <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
        کدینگ دفتر خودت را وارد کن و حساب‌های حساب‌یار را به معین‌های آن نگاشت بده. کد داخلی حساب‌یار حذف نمی‌شود تا اسناد قبلی دست‌نخورده بمانند؛ خروجی حسابدار کد کدینگ تو را می‌برد.
      </p>
    </div>

    {mapping && <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <FirmSummaryTile label="حساب کدینگ" value={toPersianDigits(mapping.chartAccountCount)} hint={`${toPersianDigits(mapping.postableCount)} معین قابل ثبت`} />
      <FirmSummaryTile label="نگاشت‌شده" value={toPersianDigits(mapping.mappedCount)} tone="text-income" />
      {/* فقط حسابی که سند خورده جلوی خروجی را می‌گیرد؛ بقیه فهرستِ کار
          باقی‌مانده‌اند، نه مانع. */}
      <FirmSummaryTile
        label="بدون نگاشت"
        value={toPersianDigits(mapping.unmappedCount)}
        tone={mapping.usedUnmappedCount ? 'text-expense' : ''}
        hint={mapping.usedUnmappedCount
          ? `${toPersianDigits(mapping.usedUnmappedCount)} حساب سند خورده و تا نگاشت نشود خروجی ساخته نمی‌شود`
          : (mapping.unmappedCount ? 'هیچ‌کدام هنوز سندی نخورده‌اند، پس جلوی خروجی را نمی‌گیرند' : '')}
      />
      <FirmSummaryTile label="پیشنهاد آماده" value={toPersianDigits(mapping.suggestionsAvailable)} hint="با یک کلیک قابل اعمال است" />
    </div>}

    {!loading && !mapping?.chartInstalled && <div className="mt-5 rounded-xl border border-accent/40 bg-warn-bg px-4 py-4">
      <p className="font-bold text-accent">هنوز کدینگی برای این دفتر تعریف نشده است.</p>
      <p className="mt-1 text-[13px] leading-6 text-muted">یا کدینگ پیشنهادی حساب‌یار را نصب کن و بعد ویرایشش کن، یا فایل کدینگ خود دفتر را وارد کن. کدینگ پیشنهادی یک نقطهٔ شروع است، نه کدینگ رسمی.</p>
      {/* ورود بکاپ پارسیان فقط در دفتر بی‌کدینگ ممکن است و خودش کدینگ را می‌سازد. نصب کدینگ
          پیشنهادی پیش از آن، راه ورود بکاپ را برای همیشه در این دفتر می‌بست. */}
      <p className="mt-2 rounded-lg border border-line bg-paper px-3 py-2 text-[13px] leading-6">
        <b>بکاپ پارسیان داری؟</b> اول همان را از برگهٔ «بکاپ پارسیان» وارد کن؛ کدینگ، معین‌ها و تفصیلی‌ها را خودش می‌سازد.
        نصب کدینگ پیشنهادی یا ورود فایل کدینگ پیش از آن، ورود بکاپ را در این دفتر می‌بندد.
        {tab !== 'parsian' && <button type="button" onClick={() => { setTab('parsian'); onTabChange?.('parsian'); }} className="tap mr-2 rounded-lg border border-line bg-surface px-3 text-[12px] font-bold">رفتن به بکاپ پارسیان</button>}
      </p>
      {canManage && <button onClick={() => run(() => api.installChartTemplate(), 'کدینگ پیشنهادی نصب شد.')} className="tap mt-3 rounded-lg bg-accent px-4 font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">نصب کدینگ پیشنهادی</button>}
    </div>}

    <nav aria-label="بخش‌های کدینگ" className="section-navigation">
      {[['mapping', 'نگاشت حساب‌ها'], ['chart', 'درخت کدینگ'], ['dimensions', 'تفصیلی و مرکز هزینه'], ['import', 'ورود کدینگ'], ['parsian', 'بکاپ پارسیان']].map(([id, label]) => (
        <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); onTabChange?.(id); }}>{label}</button>
      ))}
    </nav>

    {tab === 'mapping' && mapping && <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">هر حساب داخلی حساب‌یار باید یک معین مقصد در کدینگ داشته باشد.</p>
        <div className="flex flex-wrap gap-2">
          {/* جایگزینی کدینگ فقط وقتی مجاز است که هیچ نگاشتی نمانده باشد؛
              بدون این دکمه، دفتری با ده‌ها حساب عملاً نمی‌توانست کدینگ
              پیشنهادی را با کدینگ خودش عوض کند. */}
          {canManage && mapping.mappedCount > 0 && <button
            onClick={() => { if (window.confirm(`همهٔ ${toPersianDigits(mapping.mappedCount)} نگاشت برداشته شود؟ سند و ثبتی پاک نمی‌شود؛ فقط پیوند حساب‌ها به کدینگ برداشته می‌شود تا بتوانی کدینگ دفتر را جایگزین کنی.`)) run(() => api.clearChartMappings(), 'همهٔ نگاشت‌ها برداشته شد؛ حالا می‌توانی کدینگ دفتر را با گزینهٔ جایگزینی وارد کنی.'); }}
            className="tap rounded-lg border border-expense/50 px-4 text-sm font-bold text-expense">برداشتن همهٔ نگاشت‌ها</button>}
          {canManage && mapping.suggestionsAvailable > 0 && <button onClick={() => run(() => api.applyChartSuggestions(), 'پیشنهادها اعمال شدند.')} className="tap rounded-lg border border-line bg-surface px-4 text-sm font-bold hover:bg-paper hover:text-ink">اعمال {toPersianDigits(mapping.suggestionsAvailable)} پیشنهاد</button>}
          {/* نگاشت‌های قدیمی پیش از شناختن معین اختصاصی دسته‌ها ساخته شده‌اند و
              همه روی «سایر هزینه‌های عملیاتی» نشسته‌اند. اصلاحشان تصمیم کاربر
              است، نه بازنویسی خاموش. */}
          {canManage && mapping.mappedCount > 0 && <button
            onClick={() => run(async () => {
              const result = await api.applyChartSuggestions({ refine: true });
              return result.refined > 0
                ? `${toPersianDigits(result.refined)} نگاشت عمومی به معین دقیق‌تر منتقل شد.`
                : 'نگاشت عمومیِ قابل اصلاحی پیدا نشد؛ چیزی تغییر نکرد.';
            })}
            className="tap rounded-lg border border-line bg-surface px-4 text-sm font-bold"
          >اصلاح نگاشت‌های عمومی</button>}
        </div>
      </div>
      {canManage && <BulkMappingBar mapping={mapping} chartAccounts={accounts} notify={notify} onChanged={load} />}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] text-right text-[13px]">
          <thead className="border-b border-line text-[12px] text-muted"><tr><th className="pb-2 pl-3 font-bold">کد داخلی</th><th className="pb-2 pl-3 font-bold">حساب حساب‌یار</th><th className="pb-2 pl-3 font-bold">معین کدینگ دفتر</th></tr></thead>
          <tbody>{mapping.items.map((item) => <ChartMappingRow key={item.id} item={item} chartAccounts={accounts} notify={notify} onChanged={load} />)}</tbody>
        </table>
      </div>
    </div>}

    {tab === 'chart' && <div className="mt-4 overflow-x-auto">
      {!accounts.length && <p className="py-8 text-center text-sm text-muted">کدینگی برای نمایش نیست.</p>}
      <table className="w-full min-w-[560px] text-right text-[13px]">
        <thead className="border-b border-line text-[12px] text-muted"><tr><th className="pb-2 pl-3 font-bold">کد</th><th className="pb-2 pl-3 font-bold">نام</th><th className="pb-2 pl-3 font-bold">سطح</th><th className="pb-2 pl-3 font-bold">نوع</th><th className="pb-2 pl-3 font-bold">تفصیلی اجباری</th><th className="pb-2 font-bold">حساب متصل</th></tr></thead>
        <tbody>{accounts.map((item) => <tr key={item.id} className="border-b border-line">
          <td className="numbers py-2 pl-3">{toPersianDigits(item.code)}</td>
          <td className={`py-2 pl-3 ${CHART_LEVEL_STYLE[item.level]}`}>{item.name}</td>
          <td className="py-2 pl-3 text-muted">{item.levelLabel}</td>
          <td className="py-2 pl-3 text-muted">{item.typeLabel}</td>
          <td className="py-2 pl-3"><RequiresAnalyticToggle item={item} canManage={canManage} notify={notify} onSaved={load} /></td>
          <td className="numbers py-2 text-muted">{item.postable ? toPersianDigits(item.mappedAccounts) : '—'}</td>
        </tr>)}</tbody>
      </table>
    </div>}

    {tab === 'dimensions' && <DimensionsPanel overview={overview} canManage={canManage} notify={notify} refresh={load} dimension={dimension} setDimension={setDimension} />}

    {tab === 'parsian' && <div className="mt-4"><ParsianBackupPanel canManage={canManage} notify={notify} refresh={async () => { await load(); await refreshApp?.(); }} /></div>}

    {tab === 'import' && <div className="mt-4 space-y-5">
      <ExcelImportPanel canManage={canManage} notify={notify} refresh={load} />
      <p className="border-t border-line pt-4 text-[13px] leading-6 text-muted">
        یا کدینگ را به‌شکل متن CSV اینجا بچسبان. سرستون‌های «کد، نام، سطح، کد والد، نوع»؛ سطح یکی از گروه/کل/معین و نوع یکی از دارایی/بدهی/سرمایه/درآمد/هزینه است.
        کد فرزند باید با کد والد شروع شود. اگر حتی یک ردیف ایراد داشته باشد، هیچ ردیفی وارد نمی‌شود.
      </p>
      <textarea
        value={csv} onChange={(event) => setCsv(event.target.value)} rows={10} dir="ltr"
        placeholder={'کد,نام,سطح,کد والد,نوع\n1,دارایی‌های جاری,گروه,,دارایی\n11,موجودی نقد و بانک,کل,1,دارایی\n1101,صندوق,معین,11,دارایی'}
        className="numbers w-full rounded-lg border border-line bg-surface p-3 text-[13px] outline-none focus:border-accent"
      />
      <button disabled={!canManage || !csv.trim()} onClick={() => run(async () => { await api.importChart(csv); setCsv(''); }, 'کدینگ وارد شد.')} className="tap rounded-lg bg-accent px-4 font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90 active:bg-accent/80">ورود کدینگ</button>
      {!canManage && <p className="text-[12px] text-muted">تغییر کدینگ فقط از نقش مدیر یا مالک انجام می‌شود.</p>}
    </div>}
  </section>;
}

/**
 * کد تفصیلی در نرم‌افزار مقصد.
 *
 * چرا مهم است: فایل انتقال با همین کد، تفصیلی را به شخصِ تعریف‌شده در نرم‌افزار
 * دفتر وصل می‌کند. تفصیلی بدون این کد، در فایل با `TafsiliCode` صفر بالا می‌رود
 * و طرف حساب آنجا اصلاً دیده نمی‌شود — سند هست، ولی معلوم نیست طلب از کیست.
 */
function AnalyticTargetCode({ item, canManage, notify, onSaved }) {
  const [value, setValue] = useState(item.externalCode || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValue(item.externalCode || ''); }, [item.externalCode]);

  const commit = async () => {
    const next = digitsOnly(value);
    if (next === (item.externalCode || '')) return;
    setSaving(true);
    try { await api.saveAnalytic({ ...item, externalCode: next }); await onSaved?.(); notify('کد مقصد ذخیره شد.'); }
    catch (error) { notify(error.message); setValue(item.externalCode || ''); }
    setSaving(false);
  };

  if (!canManage) {
    return <span className={`numbers text-xs ${item.externalCode ? 'text-muted' : 'text-expense'}`}>
      {item.externalCode ? toPersianDigits(item.externalCode) : 'بدون کد مقصد'}
    </span>;
  }
  return <input
    dir="ltr" inputMode="numeric" disabled={saving} value={value} placeholder="کد مقصد"
    onChange={(event) => setValue(event.target.value)} onBlur={commit}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
    className={`tap numbers w-24 rounded-lg border px-2 text-left text-[12px] ${item.externalCode ? 'border-line bg-paper' : 'border-expense/50 bg-expense/5'}`}
  />;
}

function DimensionsPanel({ overview, canManage, notify, refresh, dimension, setDimension }) {
  const [analyticName, setAnalyticName] = useState('');
  const [analyticKind, setAnalyticKind] = useState('project');
  const [centerName, setCenterName] = useState('');
  const [kind, setKind] = useState('costCenter');

  const loadBalance = useCallback(async (target) => {
    try { setDimension(await api.dimensionBalance({ dimension: target })); }
    catch (error) { notify(error.message); }
  }, [notify, setDimension]);

  useEffect(() => { loadBalance(kind); }, [kind, loadBalance]);

  const add = async (action) => {
    try { await action(); await refresh(); await loadBalance(kind); notify('ثبت شد.'); }
    catch (error) { notify(error.message); }
  };

  return <div className="mt-4 space-y-6">
    <p className="text-[13px] leading-6 text-muted">
      تفصیلی شناور و مرکز هزینه روی «آرتیکل سند» می‌نشینند، نه روی حساب. یعنی یک معین «حساب‌های دریافتنی» داری و مشتری‌ها زیر آن تفصیلی می‌شوند؛ برای هر مشتری یک حساب کل تازه ساخته نمی‌شود.
    </p>

    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-xl border border-line bg-surface p-3">
        <p className="font-bold">تفصیلی شناور</p>
        {canManage && <form onSubmit={(event) => { event.preventDefault(); add(async () => { await api.saveAnalytic({ name: analyticName, kind: analyticKind }); setAnalyticName(''); }); }} className="mt-2 flex flex-wrap gap-2">
          <input required value={analyticName} onChange={(event) => setAnalyticName(event.target.value)} placeholder="مثلاً پروژهٔ برج آبان" className="tap min-w-40 flex-1 rounded-lg border border-line bg-paper px-3 text-[13px]" />
          <select value={analyticKind} onChange={(event) => setAnalyticKind(event.target.value)} className="tap rounded-lg border border-line bg-paper px-2 text-[13px]"><option value="project">پروژه</option><option value="employee">پرسنل</option><option value="custom">سایر</option></select>
          <button className="tap rounded-lg bg-accent px-4 text-sm font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">افزودن</button>
        </form>}
        <ul className="mt-3 divide-y divide-line text-[13px]">
          {(overview?.analytics || []).map((item) => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0 flex-1 truncate"><b className="numbers text-muted">{toPersianDigits(item.code)}</b> · {item.name}</span>
            <AnalyticTargetCode item={item} canManage={canManage} notify={notify} onSaved={refresh} />
            <span className="text-xs text-muted">{item.kindLabel}</span>
          </li>)}
          {!overview?.analytics?.length && <li className="py-3 text-muted">هنوز تفصیلی‌ای تعریف نشده؛ طرف‌حساب‌های فاکتور خودکار اضافه می‌شوند.</li>}
        </ul>
      </section>

      <section className="rounded-xl border border-line bg-surface p-3">
        <p className="font-bold">مرکز هزینه</p>
        {canManage && <form onSubmit={(event) => { event.preventDefault(); add(async () => { await api.saveCostCenter({ name: centerName }); setCenterName(''); }); }} className="mt-2 flex flex-wrap gap-2">
          <input required value={centerName} onChange={(event) => setCenterName(event.target.value)} placeholder="مثلاً شعبهٔ مرکزی" className="tap min-w-40 flex-1 rounded-lg border border-line bg-paper px-3 text-[13px]" />
          <button className="tap rounded-lg bg-accent px-4 text-sm font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">افزودن</button>
        </form>}
        <ul className="mt-3 divide-y divide-line text-[13px]">
          {(overview?.costCenters || []).map((item) => <li key={item.id} className="py-2"><b className="numbers text-muted">{toPersianDigits(item.code)}</b> · {item.name}</li>)}
          {!overview?.costCenters?.length && <li className="py-3 text-muted">هنوز مرکز هزینه‌ای تعریف نشده است.</li>}
        </ul>
      </section>
    </div>

    <section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-bold">گردش هر بعد</p>
        <select value={kind} onChange={(event) => setKind(event.target.value)} className="tap rounded-lg border border-line bg-surface px-2 text-[13px]"><option value="costCenter">مرکز هزینه</option><option value="analytic">تفصیلی شناور</option></select>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-right text-[13px]">
          <thead className="border-b border-line text-[12px] text-muted"><tr><th className="pb-2 pl-3 font-bold">کد</th><th className="pb-2 pl-3 font-bold">نام</th><th className="pb-2 pl-3 font-bold">بدهکار</th><th className="pb-2 pl-3 font-bold">بستانکار</th><th className="pb-2 font-bold">مانده</th></tr></thead>
          <tbody>
            {(dimension?.rows || []).map((row) => <tr key={row.id} className="border-b border-line">
              <td className="numbers py-2 pl-3 text-muted">{toPersianDigits(row.code)}</td>
              <td className="py-2 pl-3">{row.name}</td>
              <td className="numbers py-2 pl-3">{formatAmount(row.debit)}</td>
              <td className="numbers py-2 pl-3">{formatAmount(row.credit)}</td>
              <td className="numbers py-2 font-bold">{formatAmount(Math.abs(row.balance))}</td>
            </tr>)}
            {dimension && <tr className="bg-surface"><td className="py-2 pl-3 text-muted">—</td><td className="py-2 pl-3 text-muted">بدون تخصیص</td>
              <td className="numbers py-2 pl-3 text-muted">{formatAmount(dimension.unassigned.debit)}</td>
              <td className="numbers py-2 pl-3 text-muted">{formatAmount(dimension.unassigned.credit)}</td>
              <td className="numbers py-2 text-muted">{toPersianDigits(dimension.unassigned.lineCount)} ردیف</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted">ردیف «بدون تخصیص» عمداً نمایش داده می‌شود؛ گزارش بعد بدون آن گمراه‌کننده است.</p>
    </section>
  </div>;
}
