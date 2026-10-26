import { useState } from 'react';
import { api } from '../../lib/api.js';
import { currentAmountUnit, formatAmount, toPersianDigits, unitLabel } from '../../lib/format.js';

/**
 * ورود بکاپ پارسیان (.bak) به یک دفتر خام.
 *
 * سه‌مرحله‌ای و بدون هیچ حدسی: پیش‌نمایش هیچ چیزی نمی‌نویسد، همهٔ کدینگ و
 * همهٔ سندها با وضعیتشان دیده می‌شوند، اسناد نامتوازن با هشدار قرمز مشخص‌اند
 * و وارد نمی‌شوند، و ثبت فقط با تأیید صریح کاربر و فقط در دفتر خام انجام
 * می‌شود. اسناد متوازن به‌صورت پیش‌نویس وارد می‌شوند تا حسابدار خودش تأیید کند.
 */
export default function ParsianBackupPanel({ canManage, notify, refresh }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // پارسیان واحد مبلغ را نگه نمی‌دارد؛ تا دفتر انتخاب نکند پیش‌نمایش ساخته نمی‌شود.
  const [amountUnit, setAmountUnit] = useState('');
  const [kolTypes, setKolTypes] = useState({});

  const acceptFile = (event) => {
    setFile(event.target.files?.[0] || null);
    setPreview(null); setResult(null); setError(''); setKolTypes({});
  };

  const chooseUnit = (unit) => {
    setAmountUnit(unit);
    setPreview(null); setResult(null);
  };

  const chooseKolType = (code, type) => setKolTypes((current) => ({ ...current, [code]: type }));
  const pendingTypes = (preview?.kolTypeChoices || []).filter((choice) => !kolTypes[choice.code]);
  const acceptSuggestions = () => setKolTypes((current) => {
    const next = { ...current };
    for (const choice of preview?.kolTypeChoices || []) if (!next[choice.code] && choice.suggestion) next[choice.code] = choice.suggestion;
    return next;
  });

  const runPreview = async () => {
    if (!file || !amountUnit) return;
    setBusy(true); setError(''); setResult(null);
    try { setPreview(await api.parsianBackupPreview(file, { amountUnit })); }
    catch (issue) { setPreview(null); setError(issue.message); }
    setBusy(false);
  };

  // فایل ریالی در دفتر تومانی: ریالی که به تومانِ صحیح درنیاید سندش را نگه می‌دارد.
  // دفتر بی‌مبلغ را می‌شود ریالی کرد تا همهٔ سندها دقیق و بی‌تبدیل وارد شوند.
  const switchLedgerUnit = async (unit) => {
    setBusy(true); setError('');
    try {
      await api.setLedgerAmountUnit(unit);
      await refresh();
      setPreview(await api.parsianBackupPreview(file, { amountUnit }));
      notify(`واحد مبلغ این دفتر ${unitLabel(unit)} شد.`);
    } catch (issue) { setError(issue.message); }
    setBusy(false);
  };

  const runCommit = async () => {
    if (!preview || !file || pendingTypes.length) return;
    const { importableCount, unbalancedCount = 0, unitBlockedCount = 0, invalidCount = 0 } = preview.summary;
    const skippedParts = [
      unbalancedCount ? `${toPersianDigits(unbalancedCount)} سند نامتوازن در خود پارسیان` : '',
      unitBlockedCount ? `${toPersianDigits(unitBlockedCount)} سند متوازن که مبلغش در واحد این دفتر عدد صحیح نمی‌شود` : '',
      invalidCount ? `${toPersianDigits(invalidCount)} سند با ایراد دیگر` : '',
    ].filter(Boolean);
    const question = skippedParts.length
      ? `${toPersianDigits(importableCount)} سند به‌صورت پیش‌نویس وارد شود و این‌ها فقط در همین گزارش بمانند: ${skippedParts.join('، ')}؟`
      : `${toPersianDigits(importableCount)} سند به‌صورت پیش‌نویس وارد شود؟`;
    const extrasLine = extrasSentence(preview.extras);
    if (!window.confirm(`${question}${extrasLine ? `\nهمراهش: ${extrasLine}.` : ''}\nاین کار فقط در دفتر خام مجاز است و یک‌بار انجام می‌شود.`)) return;
    setBusy(true); setError('');
    try {
      const outcome = await api.parsianBackupCommit(file, { amountUnit, kolTypes });
      setResult(outcome); setPreview(null); setFile(null);
      await refresh();
      if (outcome.phaseB?.error || outcome.extras?.error) notify('اسناد پارسیان وارد شدند، ولی بخشی از اطلاعات پایه نیامد؛ گزارش زیر را ببین.');
      else notify('بکاپ پارسیان وارد شد؛ اسناد به‌صورت پیش‌نویس منتظر تأیید تو هستند.');
    } catch (issue) {
      setError(issue.message);
      if (issue.details?.errors?.length) {
        setError(`${issue.message} ${issue.details.errors.map((item) => item.message).join(' | ')}`);
      }
    }
    setBusy(false);
  };

  const summary = preview?.summary;
  const raw = preview?.rawLedger;

  return <section className="rounded-xl border border-line bg-surface p-4">
    <p className="font-bold">ورود بکاپ پارسیان (.bak)</p>
    <p className="mt-1 max-w-2xl text-[12px] leading-6 text-muted">
      فایل بکاپ SQL Server نرم‌افزار پارسیان را مستقیم بارگذاری کن؛ بدون نصب SQL Server و بدون Excel. اول پیش‌نمایش کامل می‌بینی — کدینگ، تفصیلی‌ها و
      تک‌تک سندها با وضعیت ترازشان — بعد با تأیید خودت وارد می‌شود. ورود فقط در <b>دفتر خام</b> (بدون هیچ سند و کدینگ) ممکن است و یک‌بار انجام می‌شود.
      اسناد متوازن به‌صورت <b>پیش‌نویس</b> می‌آیند تا در میز کار سندها تأییدشان کنی.
      {' '}همراه اسناد، بانک‌ها و صندوق با مانده، اشخاص با تلفن و کد اقتصادی، کالاها، بایگانی فاکتورها و مشخصات شرکت هم می‌آیند و DNA مالی از همین اسناد ساخته می‌شود.
    </p>

    <fieldset className="mt-3" disabled={!canManage || busy}>
      <legend className="text-[13px] font-bold">مبلغ‌های پارسیان این دفتر به چه واحدی است؟</legend>
      <p className="text-[12px] leading-6 text-muted">
        پارسیان واحد مبلغ را در بکاپ نگه نمی‌دارد. این دفتر به <b>{unitLabel(preview?.ledgerUnit || currentAmountUnit())}</b> است؛
        مبلغ فایل به واحد دفتر فقط دقیق تبدیل می‌شود و هیچ مبلغی گرد نمی‌شود. اگر نمی‌دانی، کارمزدهای بانکی را ببین: ۱٬۲۰۰ و ۷٬۲۰۰ ریالی‌اند.
      </p>
      <div className="mt-1 flex gap-4 text-[13px]">
        {[['rial', 'ریال'], ['toman', 'تومان']].map(([value, label]) => <label key={value} className="flex items-center gap-1.5">
          <input type="radio" name="parsian-amount-unit" value={value} checked={amountUnit === value} onChange={() => chooseUnit(value)} /> {label}
        </label>)}
      </div>
    </fieldset>

    <div className="mt-3 flex flex-wrap items-center gap-2">
      <input type="file" accept=".bak,.bak2,application/octet-stream" onChange={acceptFile} disabled={!canManage || busy}
        className="block w-full max-w-md text-[13px] file:ml-3 file:rounded-lg file:border file:border-line file:bg-paper file:px-3 file:py-2 file:text-[13px] file:font-bold" />
      <button disabled={!file || !amountUnit || busy} onClick={runPreview} className="tap rounded-lg border border-line bg-paper px-4 text-[13px] font-bold hover:bg-paper hover:text-ink disabled:opacity-45">
        {busy ? 'در حال خواندن…' : 'پیش‌نمایش'}
      </button>
      {preview && raw?.ok && canManage && <button disabled={busy || !summary.importableCount || pendingTypes.length > 0} onClick={runCommit}
        className="tap rounded-lg bg-accent px-4 text-[13px] font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90 active:bg-accent/80">
        ورود {toPersianDigits(summary.importableCount)} سند متوازن + کدینگ
      </button>}
    </div>
    {!canManage && <p className="mt-2 text-[12px] text-muted">ورود بکاپ فقط از نقش مدیر یا مالک انجام می‌شود.</p>}
    {error && <div role="alert" className="mt-3 rounded-lg border border-expense/40 bg-expense/5 p-3 text-[13px] leading-6 text-expense">{error}</div>}

    {raw && !raw.ok && <div className="mt-3 rounded-lg border border-expense/40 bg-expense/5 p-3 text-[13px] font-bold leading-6 text-expense">
      ورود به این دفتر ممکن نیست: {raw.message}
      <span className="mr-2 font-normal text-muted">(سند: {toPersianDigits(raw.journalCount)} — کدینگ: {toPersianDigits(raw.chartCount)} — تفصیلی: {toPersianDigits(raw.analyticCount)} — سابقهٔ ورود پارسیان: {toPersianDigits(raw.importedBefore)})</span>
    </div>}

    {preview?.unitAdvice && <UnitAdvice advice={preview.unitAdvice} busy={busy} canManage={canManage} onSwitch={switchLedgerUnit} />}

    {summary && <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <SummaryTile label="کل" value={summary.kolCount} />
      <SummaryTile label="معین" value={summary.moeenCount} />
      <SummaryTile label="تفصیلی" value={summary.tafsiliCount} />
      <SummaryTile label="سند در فایل" value={summary.voucherCount} />
      <SummaryTile label="قابل ورود" value={summary.importableCount} tone="text-income" />
      {/* سه دلیل جدا: نامتوازنِ واقعی، فقط واحد، و ایراد دیگر. «نامتوازن/نامعتبر» برای سندی که فقط واحدش جا نمی‌شد گمراه‌کننده بود. */}
      {summary.unbalancedCount > 0 && <SummaryTile label="نامتوازن در پارسیان" value={summary.unbalancedCount} tone="text-expense" />}
      {summary.unitBlockedCount > 0 && <SummaryTile label="متوازن، ولی واحد جا نمی‌شود" value={summary.unitBlockedCount} tone="text-accent" />}
      {summary.invalidCount > 0 && <SummaryTile label="ایراد دیگر" value={summary.invalidCount} tone="text-expense" />}
    </div>}
    {preview?.extras && extrasSentence(preview.extras) && <p className="mt-2 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] leading-6 text-muted">
      همراه اسناد وارد می‌شود: <b className="text-ink">{extrasSentence(preview.extras)}</b>. بانک‌ها، صندوق و اشخاص هم از همین کدینگ ساخته می‌شوند؛ هیچ سند تازه‌ای ثبت نمی‌شود.
    </p>}

    {preview && <div className="mt-4 space-y-4">
      <p className="text-[12px] leading-5 text-muted">
        فایل: <b className="numbers">{preview.meta.fileName}</b> — {toPersianDigits(Math.round(preview.meta.sizeBytes / 1024))} کیلوبایت — {preview.meta.container}
        {summary.dateMin && <> — بازهٔ اسناد قابل ورود: <b className="numbers">{toPersianDigits(persianToken(summary.dateMin))}</b> تا <b className="numbers">{toPersianDigits(persianToken(summary.dateMax))}</b></>}
      </p>

      {preview.warnings.length > 0 && <div className="rounded-lg border border-accent/40 bg-warn-bg p-3">
        <p className="text-[13px] font-bold text-accent">هشدارها ({toPersianDigits(preview.warnings.length)})</p>
        <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-[12px] leading-6">{preview.warnings.map((item, index) => <li key={index}>• {item}</li>)}</ul>
      </div>}

      {preview.kolTypeChoices.length > 0 ? <KolTypeChoices choices={preview.kolTypeChoices} kolTypes={kolTypes} onChoose={chooseKolType} onAcceptSuggestions={acceptSuggestions} pending={pendingTypes.length} /> : null}
      {preview.designatedRoles?.length > 0 ? <DesignatedRoles roles={preview.designatedRoles} /> : null}
      <ChartPreview preview={preview} />
      <VoucherPreview preview={preview} />
    </div>}

    {result && <div className="mt-4 space-y-3">
      <div className="rounded-lg border border-income/40 bg-income/5 p-3 text-[13px] leading-6">
        <b>ورود کامل شد.</b> کدینگ: <b className="numbers">{toPersianDigits(result.chart.created)}</b> حساب تازه — تفصیلی: <b className="numbers">{toPersianDigits(result.analytics)}</b> —
        حساب دفتر کل: <b className="numbers">{toPersianDigits(result.ledgerAccounts)}</b> — سند پیش‌نویس: <b className="numbers">{toPersianDigits(result.journals.entries)}</b> سند با جمع <b className="numbers">{formatAmount(result.journals.total)}</b> {unitLabel(result.ledgerUnit)} (واحد فایل: {unitLabel(result.amountUnit)}).
        <div className="mt-1 text-muted">سندها در میز کار سندها منتظر تأییدند؛ شماره‌گذاری داخلی از نو و تاریخ‌ها شمسیِ خود فایل‌اند.</div>
      </div>
      <ImportFilled result={result} />
      <NextStepsToParsian result={result} />
      {result.skippedVouchers.length > 0 && <div className="rounded-lg border border-expense/40 bg-expense/5 p-3">
        <p className="text-[13px] font-bold text-expense">{toPersianDigits(result.skippedVouchers.length)} سند وارد نشد — با هشدار باقی ماند</p>
        <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-[12px] leading-6">
          {result.skippedVouchers.map((voucher) => <li key={voucher.sanad}>
            <b className="numbers">سند {toPersianDigits(voucher.sanad)}</b> ({toPersianDigits(voucher.date)}): {voucher.issues[0] || voucher.lineIssues?.[0] || 'نامعتبر'}
          </li>)}
        </ul>
      </div>}
    </div>}

    <ParsianPhaseB canManage={canManage} notify={notify} refresh={refresh} autoDone={Boolean(result?.phaseB?.accounts)} />
  </section>;
}

/** جملهٔ کوتاه «چه چیزهایی همراه اسناد می‌آید» برای پیش‌نمایش و پرسش تأیید. */
function extrasSentence(extras) {
  if (!extras) return '';
  const parts = [
    extras.goods ? `${toPersianDigits(extras.goods)} کالا` : '',
    extras.cards ? `${toPersianDigits(extras.cards)} کارت طرف حساب (تلفن، نشانی، کد اقتصادی)` : '',
    extras.salesInvoices ? `${toPersianDigits(extras.salesInvoices)} فاکتور فروش` : '',
    extras.purchaseInvoices ? `${toPersianDigits(extras.purchaseInvoices)} فاکتور خرید` : '',
    extras.company ? 'مشخصات شرکت' : '',
  ].filter(Boolean);
  return parts.join('، ');
}

/**
 * گزارش «کدام بخش‌ها پر شدند» پس از ورود: بانک و صندوق، اشخاص، کالا، بایگانی
 * فاکتورها، مشخصات شرکت و DNA. هر چیزی که نیامد با دلیلش گفته می‌شود.
 */
function ImportFilled({ result }) {
  const phaseB = result.phaseB || {};
  const extras = result.extras || {};
  const rows = [
    !phaseB.error && phaseB.accounts && ['صندوق و بانک', `${toPersianDigits(phaseB.accounts.created + phaseB.accounts.bound)} حساب پولی با ماندهٔ همان اسناد${phaseB.petty ? ` و ${toPersianDigits(phaseB.petty)} تنخواه` : ''}`, 'تنظیمات ← صندوق و بانک، و کارت هر حساب'],
    !phaseB.error && phaseB.contacts && ['اشخاص و طرف حساب‌ها', `${toPersianDigits(phaseB.contacts.created + phaseB.contacts.reused)} شخص، ${toPersianDigits(phaseB.contacts.enriched || 0)} با تلفن و کد اقتصادی؛ طلب و بدهی هر کدام از دفتر کل`, 'دفتر مالی ← اشخاص و کارت طرف حساب'],
    extras.products && ['کالا', `${toPersianDigits(extras.products.created)} کالا با واحد و قیمت فروش (اگر در پارسیان بود)؛ موجودی تعدادی را با شمارش بگذار`, 'دفتر مالی ← انبار'],
    extras.invoices && ['فاکتورها', `${toPersianDigits(extras.invoices.byKind?.sales || 0)} فروش و ${toPersianDigits(extras.invoices.byKind?.purchase || 0)} خرید، بایگانی فقط‌خواندنی با سند پارسیانِ هر کدام`, 'دفتر مالی ← فاکتورها'],
    extras.company && ['مشخصات شرکت', 'کد اقتصادی، شناسهٔ ملی و نشانی', 'تنظیمات ← عمومی'],
    ['DNA مالی', 'از همین اسناد، در بازهٔ خود بکاپ: مشتریان و تأمین‌کنندگان اصلی، کالاهای اصلی، ستون فقرات هزینه و روند', 'منوی DNA مالی'],
  ].filter(Boolean);
  const problems = [phaseB.error, typeof phaseB.skipped === 'string' ? phaseB.skipped : '', extras.error,
    ...(Array.isArray(phaseB.skipped) ? phaseB.skipped : []), ...(extras.warnings || [])].filter(Boolean);
  return <div className="rounded-lg border border-line bg-paper p-3">
    <p className="text-[13px] font-bold">بخش‌هایی که از همین بکاپ پر شدند</p>
    <ul className="mt-2 space-y-2 text-[12px] leading-6">
      {rows.map(([title, detail, where]) => <li key={title} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
        <b className="shrink-0 text-income">✓ {title}</b>
        <span>{detail}</span>
        <span className="text-muted sm:mr-auto">({where})</span>
      </li>)}
    </ul>
    {problems.length > 0 && <ul className="mt-2 space-y-1 border-t border-line pt-2 text-[12px] leading-6 text-accent">
      {problems.map((item, index) => <li key={index}>• {item}</li>)}
    </ul>}
  </div>;
}

/**
 * فاز ب — وصل‌کردن کدینگ واردشده به بخش‌های روزمرهٔ حساب‌یار.
 *
 * بانک‌ها و صندوق و تنخواه که در ورود اول فقط معین کدینگ بودند، حساب عملیاتی
 * می‌گیرند و کارتشان همان لحظه گردش اسناد واردشده را نشان می‌دهد. تفصیلی‌های
 * «طرف حساب» با تأیید کاربر شخص می‌شوند و کارت حسابشان از دفتر کل پر می‌شود.
 * هیچ سند تازه‌ای ساخته نمی‌شود.
 */
function ParsianPhaseB({ canManage, notify, refresh, autoDone = false }) {
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      const outcome = await api.parsianPhaseBPreview();
      setPreview(outcome);
      setSelected(new Set(outcome.suggestedContactIds || []));
    } catch (issue) { setPreview(null); setError(issue.message); }
    setBusy(false);
  };

  const toggle = (id) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const run = async () => {
    const moneyCount = (preview?.money || []).filter((moeen) => !moeen.bound && (moeen.kind !== 'petty' || moeen.fundPossible)).length;
    const question = `${toPersianDigits(moneyCount)} حساب پولی (صندوق/بانک/تنخواه) ساخته یا وصل شود و ${toPersianDigits(selected.size)} تفصیلی به شخص تبدیل شود؟\nهیچ سند تازه‌ای ثبت نمی‌شود و هیچ مبلغی جابه‌جا نمی‌شود؛ فقط اسناد موجود به کارت‌های درست وصل می‌شوند.`;
    if (!window.confirm(question)) return;
    setBusy(true); setError('');
    try {
      const outcome = await api.parsianPhaseBCommit([...selected]);
      setResult(outcome); setPreview(null);
      await refresh();
      notify('حساب‌های عملیاتی و اشخاص ساخته شدند؛ کارت‌ها از همین لحظه گردش را نشان می‌دهند.');
    } catch (issue) { setError(issue.message); }
    setBusy(false);
  };

  if (!preview && !result && !error) {
    return <div className="mt-5 rounded-xl border border-dashed border-line p-4">
      <p className="text-[13px] font-bold">{autoDone ? 'تفصیلی‌های دیگر و بررسی دوباره' : 'قدم بعد: حساب‌های عملیاتی و اشخاص'}</p>
      <p className="mt-1 text-[12px] leading-6 text-muted">{autoDone
        ? 'بانک‌ها و اشخاص پیشنهادی همین حالا ساخته شدند. اگر تفصیلی دیگری هم شخص است (مثلاً نامی که شبیه حساب بود و کنار ماند)، از این‌جا انتخاب و اضافه کن.'
        : 'بانک‌ها، تنخواه و اشخاص برای دیده‌شدن در بخش‌های خودشان از همان کدینگ ساخته می‌شوند — بدون هیچ سند تازه‌ای. ورود تازه این کار را خودش انجام می‌دهد؛ این‌جا برای دفتری است که پیش‌تر وارد شده.'}</p>
      <button type="button" disabled={!canManage || busy} onClick={load} className="tap mt-2 rounded-lg border border-line bg-paper px-4 text-[13px] font-bold hover:bg-paper hover:text-ink disabled:opacity-45">
        {busy ? 'در حال بررسی…' : 'بررسی و ساخت حساب‌های عملیاتی'}
      </button>
      {!canManage && <p className="mt-2 text-[12px] text-muted">این کار فقط از نقش مدیر یا مالک انجام می‌شود.</p>}
    </div>;
  }

  return <div className="mt-5 rounded-xl border border-dashed border-line p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[13px] font-bold">قدم بعد: حساب‌های عملیاتی و اشخاص</p>
      {preview && <button type="button" disabled={busy} onClick={load} className="tap rounded-lg border border-line bg-paper px-3 text-[12px] font-bold">بررسی دوباره</button>}
    </div>
    {error && <div role="alert" className="mt-3 rounded-lg border border-expense/40 bg-expense/5 p-3 text-[13px] leading-6 text-expense">{error}</div>}

    {preview && !preview.eligible && <div className="mt-3 rounded-lg border border-expense/40 bg-expense/5 p-3 text-[13px] font-bold leading-6 text-expense">{preview.message}</div>}

    {preview?.eligible && <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || !canManage} onClick={run} className="tap rounded-lg bg-accent px-4 text-[13px] font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90 active:bg-accent/80">
          {busy ? 'در حال ساخت…' : `ساخت ${toPersianDigits(preview.money.filter((moeen) => !moeen.bound && (moeen.kind !== 'petty' || moeen.fundPossible)).length)} حساب پولی + ${toPersianDigits(selected.size)} شخص`}
        </button>
        <span className="text-[12px] leading-6 text-muted">هیچ سندی ثبت نمی‌شود؛ فقط اتصال اسناد موجود.</span>
      </div>

      {preview.money.length > 0 && <div className="mt-3">
        <p className="text-[13px] font-bold">حساب‌های پولی از کدینگ</p>
        <div className="mt-2 overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[560px] text-right text-[12px]">
            <thead className="border-b border-line bg-surface text-muted"><tr>
              <th className="p-2 font-bold">کد معین پارسیان</th><th className="p-2 font-bold">نام</th><th className="p-2 font-bold">نوع</th>
              <th className="p-2 font-bold">ردیف سند</th><th className="p-2 font-bold">ماندهٔ فعلی</th><th className="p-2 font-bold">وضعیت</th>
            </tr></thead>
            <tbody>{preview.money.map((moeen) => <tr key={moeen.code} className="border-b border-line">
              <td className="numbers p-2">{toPersianDigits(moeen.levelCode)}</td>
              <td className="p-2">{moeen.name}</td>
              <td className="p-2 text-muted">{moeen.kindLabel}</td>
              <td className="numbers p-2">{toPersianDigits(moeen.lineCount)}</td>
              <td className="numbers p-2">{formatAmount(moeen.balance)}</td>
              <td className="p-2">{moeen.bound
                ? <span className="text-muted">از قبل وصل است</span>
                : moeen.kind === 'petty' && !moeen.fundPossible
                  ? <span className="text-muted">گردش/مانده ندارد؛ ساخته نمی‌شود</span>
                  : moeen.reuseExistingCash
                    ? <span className="text-income">به «{moeen.reuseExistingCashName}» وصل می‌شود</span>
                    : <span className="text-income">حساب {moeen.kindLabel} تازه</span>}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="mt-1 text-[11px] leading-5 text-muted">کارت هر حساب، گردش همان معین را از اسناد واردشده نشان می‌دهد. بانکِ هر حساب را بعداً از «تنظیمات ← صندوق و بانک» انتخاب کن. سقف تنخواه را از «تنخواه‌گردان» تعیین کن.</p>
      </div>}

      {preview.contacts.length > 0 && <div className="mt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-bold">تبدیل تفصیلی‌ها به شخص ({toPersianDigits(selected.size)} از {toPersianDigits(preview.contacts.length)})</p>
          <div className="flex gap-2 text-[12px]">
            <button type="button" onClick={() => setSelected(new Set(preview.contacts.map((contact) => contact.id)))} className="tap rounded-lg border border-line bg-paper px-3 py-1 font-bold">همه</button>
            <button type="button" onClick={() => setSelected(new Set(preview.suggestedContactIds || []))} className="tap rounded-lg border border-line bg-paper px-3 py-1 font-bold">پیشنهادی‌ها</button>
            <button type="button" onClick={() => setSelected(new Set())} className="tap rounded-lg border border-line bg-paper px-3 py-1 font-bold">هیچ</button>
          </div>
        </div>
        <p className="mt-1 text-[11px] leading-5 text-muted">فقط تفصیلی‌هایی که واقعاً شخص‌اند را انتخاب کن؛ نام‌های حسابداری‌نما (مالیات، تهاتر، ارزش افزوده، پرداختنی و…) از پیش‌انتخاب کنار گذاشته شده‌اند. ردیف‌های هر شخص از حساب مشترک معین به کارت خودش می‌رود و کدینگش همان می‌ماند.</p>
        <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-line">
          <table className="w-full min-w-[560px] text-right text-[12px]">
            <thead className="sticky top-0 border-b border-line bg-surface text-muted"><tr>
              <th className="p-2"></th><th className="p-2 font-bold">تفصیلی</th><th className="p-2 font-bold">سمت</th>
              <th className="p-2 font-bold">ردیف</th><th className="p-2 font-bold">ماندهٔ بدهکار</th><th className="p-2 font-bold">ماندهٔ بستانکار</th>
            </tr></thead>
            <tbody>{preview.contacts.map((contact) => <tr key={contact.id} className={`border-b border-line ${selected.has(contact.id) ? '' : 'opacity-60'}`}>
              <td className="p-2"><input type="checkbox" checked={selected.has(contact.id)} onChange={() => toggle(contact.id)} aria-label={`انتخاب ${contact.name}`} /></td>
              <td className="p-2">{contact.name}</td>
              <td className="p-2 text-muted">{contact.sides.includes('receivable') && contact.sides.includes('payable') ? 'دریافتنی و پرداختنی' : contact.sides.includes('receivable') ? 'دریافتنی' : contact.sides.includes('payable') ? 'پرداختنی' : '—'}</td>
              <td className="numbers p-2">{toPersianDigits(contact.lineCount)}</td>
              <td className="numbers p-2">{formatAmount(contact.debit - contact.credit) >= 0 ? formatAmount(contact.debit - contact.credit) : '—'}</td>
              <td className="numbers p-2">{contact.credit - contact.debit > 0 ? formatAmount(contact.credit - contact.debit) : '—'}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>}

      {preview.warnings?.length > 0 && <ul className="mt-2 space-y-1 text-[12px] leading-6 text-accent">{preview.warnings.map((item, index) => <li key={index}>• {item}</li>)}</ul>}
    </>}

    {result && <div className="mt-3 space-y-2">
      <div className="rounded-lg border border-income/40 bg-income/5 p-3 text-[13px] leading-6">
        <b>ساخته شد.</b> حساب عملیاتی: <b className="numbers">{toPersianDigits(result.accounts.created)}</b> تازه و <b className="numbers">{toPersianDigits(result.accounts.bound)}</b> وصل‌شده
        {result.petty > 0 && <> — تنخواه: <b className="numbers">{toPersianDigits(result.petty)}</b></>}
        — شخص تازه: <b className="numbers">{toPersianDigits(result.contacts.created)}</b>{result.contacts.reused > 0 ? ` (+${toPersianDigits(result.contacts.reused)} موجود)` : ''}
        — ردیف سندِ به‌کارت‌وصل‌شده: <b className="numbers">{toPersianDigits(result.linesRepointed)}</b>.
        <div className="mt-1 text-muted">ماندهٔ کامل هر حساب در کارت حساب اوست؛ بانک‌ها در «تنظیمات ← صندوق و بانک» و اشخاص در «اشخاص». هیچ سند تازه‌ای ثبت نشد.</div>
      </div>
      {(result.warnings?.length > 0 || result.skipped?.length > 0) && <ul className="space-y-1 text-[12px] leading-6 text-accent">
        {result.skipped.map((item, index) => <li key={`s${index}`}>• {item}</li>)}
        {result.warnings.map((item, index) => <li key={`w${index}`}>• {item}</li>)}
      </ul>}
      <button type="button" disabled={busy} onClick={load} className="tap rounded-lg border border-line bg-paper px-3 text-[12px] font-bold">بررسی دوباره</button>
    </div>}
  </div>;
}

function SummaryTile({ label, value, tone = '' }) {
  return <div className="rounded-lg border border-line bg-paper p-3 text-center">
    <p className={`text-lg font-extrabold numbers ${tone}`}>{toPersianDigits(value)}</p>
    <p className="mt-0.5 text-[11px] text-muted">{label}</p>
  </div>;
}

const TYPE_OPTIONS = [['asset', 'دارایی'], ['liability', 'بدهی'], ['equity', 'سرمایه'], ['income', 'درآمد'], ['expense', 'هزینه']];

/**
 * فایل و دفتر واحد متفاوت دارند. فایل ریالی در دفتر تومانی سندهایی را نگه می‌دارد
 * که مبلغشان بر ۱۰ بخش‌پذیر نیست؛ راه درست ریالی کردن دفتر است، نه عوض کردن واحد
 * فایل که همهٔ مبلغ‌ها را ده برابر می‌کند.
 */
function UnitAdvice({ advice, busy, canManage, onSwitch }) {
  const { fileUnit, ledgerUnitLabel, fileUnitLabel, blockedVouchers, canSwitch } = advice;
  if (!blockedVouchers) {
    return <p role="status" className="mt-3 rounded-lg border border-line bg-paper p-3 text-[12px] leading-6 text-muted">
      مبلغ‌های فایل به {fileUnitLabel} است و این دفتر به {ledgerUnitLabel}؛ همهٔ مبلغ‌ها دقیق به {ledgerUnitLabel} تبدیل می‌شوند.
    </p>;
  }
  return <div role="status" className="mt-3 rounded-lg border border-accent/40 bg-warn-bg p-3 text-[13px] leading-6">
    <p className="font-bold text-accent">
      {toPersianDigits(blockedVouchers)} سند متوازن وارد نمی‌شود، چون مبلغ {fileUnitLabel}ی‌اش در دفتر {ledgerUnitLabel}ی به عدد صحیح درنمی‌آید.
    </p>
    {canSwitch
      ? <>
        <p className="mt-1 text-[12px] text-muted">این دفتر هنوز هیچ مبلغی ندارد. اگر {fileUnitLabel}ی‌اش کنی، همهٔ سندها دقیق و بی‌تبدیل وارد می‌شوند و از این به بعد مبلغ‌ها در این دفتر به {fileUnitLabel} نمایش داده و ثبت می‌شوند. گفتهٔ «۲ میلیون تومان» همچنان درست خوانده می‌شود.</p>
        {canManage && <button type="button" disabled={busy} onClick={() => onSwitch(fileUnit)}
          className="tap mt-2 rounded-lg bg-accent px-4 text-[13px] font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90 active:bg-accent/80">
          این دفتر را {fileUnitLabel}ی کن
        </button>}
      </>
      : <p className="mt-1 text-[12px] text-muted">این دفتر قبلاً مبلغ ثبت‌شده دارد و واحدش دیگر عوض نمی‌شود. برای ورود دقیق، یک دفتر تازه بساز، پیش از هر ثبتی آن را {fileUnitLabel}ی کن و بکاپ را آنجا وارد کن.</p>}
  </div>;
}

/** کل‌هایی که پارسیان نوع روشنی برایشان نمی‌دهد؛ ثبت تا انتخاب همه بسته است. */
function KolTypeChoices({ choices, kolTypes, onChoose, onAcceptSuggestions, pending }) {
  return <div className="rounded-lg border border-accent/40 bg-warn-bg p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[13px] font-bold text-accent">نوع {toPersianDigits(choices.length)} حساب کل را خودت انتخاب کن{pending ? ` — ${toPersianDigits(pending)} مانده` : ''}</p>
      {pending > 0 ? <button type="button" onClick={onAcceptSuggestions} className="tap rounded-lg border border-line bg-paper px-3 text-[12px] font-bold">پذیرش پیشنهادها</button> : null}
    </div>
    <ul className="mt-2 space-y-2 text-[12px] leading-6">
      {choices.map((choice) => <li key={choice.code} className="flex flex-wrap items-center gap-2">
        <label htmlFor={`kol-type-${choice.code}`} className="min-w-48"><b className="numbers">{toPersianDigits(choice.code)}</b> {choice.name} <span className="text-muted">— {choice.reason}</span></label>
        <select id={`kol-type-${choice.code}`} value={kolTypes[choice.code] || ''} onChange={(event) => onChoose(choice.code, event.target.value)} className="rounded-lg border border-line bg-paper px-2 py-1">
          <option value="">انتخاب کن…</option>
          {/* حساب انتظامی با هیچ‌کدام از پنج نوع جور نیست؛ فقط برای کل‌های انتظامی پارسیان. */}
          {choice.memorandumSide && <option value="memorandum">انتظامی — بیرون از ترازنامه و سود و زیان</option>}
          {TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {choice.suggestionLabel ? <span className="text-muted">پیشنهاد کدینگ استاندارد: {choice.suggestionLabel}</span> : null}
      </li>)}
    </ul>
  </div>;
}

/** نقش‌هایی که از تنظیمات خود پارسیان خوانده شد؛ نگاشت حساب‌های عملیاتی از همین‌ها می‌آید. */
function DesignatedRoles({ roles }) {
  return <details className="rounded-lg border border-line p-3">
    <summary className="cursor-pointer text-[13px] font-bold">حساب‌هایی که پارسیان برای هر کار تعیین کرده ({toPersianDigits(roles.filter((role) => role.applied).length)} از {toPersianDigits(roles.length)} به کار می‌رود)</summary>
    <p className="mt-2 text-[12px] leading-6 text-muted">صندوق، فروش، حقوق و بقیهٔ حساب‌های روزمرهٔ حساب‌یار خودکار به همین معین‌ها نگاشت می‌شوند تا خروجی پارسیان بدون نگاشت دستی ساخته شود.</p>
    <ul className="mt-2 space-y-1 text-[12px] leading-6">
      {roles.map((role) => <li key={role.key}>
        <b>{role.label}</b>: <span className="numbers">{toPersianDigits(role.kol)}/{toPersianDigits(role.moeen)}</span>{role.name ? ` ${role.name}` : ''}
        {role.applied ? <span className="text-income"> — به کار می‌رود</span> : <span className="text-muted"> — به کار نمی‌رود: {role.reason}</span>}
      </li>)}
    </ul>
  </details>;
}

/** بعد از ورود: برای برگرداندن کار ماهانه به پارسیان چه مانده است. */
function NextStepsToParsian({ result }) {
  return <div className="rounded-lg border border-line bg-paper p-3 text-[12px] leading-6">
    <p className="text-[13px] font-bold">قدم بعد: خروجی ماهانه به پارسیان</p>
    <ol className="mt-1 list-decimal space-y-1 pr-5">
      <li>سندهای پیش‌نویس را در میز کار سندها تأیید کن. این سندها همین حالا در پارسیان هستند و در فایل انتقال <b>نمی‌روند</b>؛ فقط ثبت‌های تازهٔ حساب‌یار می‌روند.</li>
      <li>واحد مبلغ فایل انتقال روی <b>{result.amountUnit === 'rial' ? 'ریال' : 'تومان'}</b> گذاشته شد، همان واحدی که برای این بکاپ گفتی.</li>
      <li>{result.mappedOperational > 0
        ? <>{toPersianDigits(result.mappedOperational)} حساب روزمرهٔ حساب‌یار خودکار به معین‌های پارسیان نگاشت شد؛ بقیه هنگام اولین ثبت نگاشت می‌شوند.</>
        : <>حساب‌های روزمرهٔ حساب‌یار هنگام اولین ثبت، با همان حساب‌هایی که پارسیان تعیین کرده نگاشت می‌شوند.</>}</li>
      <li>در «همکاری با حسابدار ← تحویل و پرسش‌ها»، نوع فایل را «فایل انتقال پارسیان» بگذار و یک بار فایل پایهٔ Access را از خود پارسیان بده (امکانات ← سامانه تبادل اطلاعات ← سامانه تبادل اطلاعات اسناد ← انتقال اسناد به فایل).</li>
    </ol>
  </div>;
}

function ChartPreview({ preview }) {
  return <div className="space-y-3">
    <p className="text-[13px] font-bold">کدینگ (پیش‌نمایش)</p>
    <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
      <table className="w-full min-w-[560px] text-right text-[12px]">
        <thead className="sticky top-0 border-b border-line bg-surface text-muted"><tr>
          <th className="p-2 font-bold">کد کل پارسیان</th><th className="p-2 font-bold">نام کل</th><th className="p-2 font-bold">نوع</th>
          <th className="p-2 font-bold">کد معین پارسیان</th><th className="p-2 font-bold">کد داخلی معین</th><th className="p-2 font-bold">نام معین</th>
        </tr></thead>
        <tbody>{preview.chart.moeen.map((row, index) => <tr key={row.code} className="border-b border-line">
          <td className="numbers p-2">{toPersianDigits(row.kolCode)}</td>
          <td className="p-2 text-muted">{preview.chart.kol.find((kol) => kol.code === row.kolCode)?.name || '—'}</td>
          <td className="p-2 text-muted">{row.typeLabel}</td>
          <td className="numbers p-2">{toPersianDigits(row.moeenCode)}</td>
          <td className="numbers p-2">{toPersianDigits(row.code)}</td>
          <td className="p-2">{row.name}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-[13px] font-bold">تفصیلی‌ها ({toPersianDigits(preview.chart.tafsili.length)})</summary>
      <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-[12px] leading-6">
        {preview.chart.tafsili.map((row) => <li key={`${row.kol}-${row.moeen}-${row.code}`}>
          <span className="numbers">{toPersianDigits(row.kol)}/{toPersianDigits(row.moeen)}/{toPersianDigits(row.code)}</span> — {row.name} <span className="text-muted">({row.kindLabel})</span>
        </li>)}
      </ul>
    </details>
  </div>;
}

function VoucherPreview({ preview }) {
  const unimportable = preview.vouchers.filter((voucher) => !voucher.importable);
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[13px] font-bold">سندها ({toPersianDigits(preview.vouchers.length)})</p>
      {unimportable.length > 0 && <p className="text-[12px] font-bold text-expense">{toPersianDigits(unimportable.length)} سند با هشدار وارد نمی‌شود</p>}
    </div>
    <div className="max-h-96 overflow-y-auto rounded-lg border border-line">
      <table className="w-full min-w-[640px] text-right text-[12px]">
        <thead className="sticky top-0 border-b border-line bg-surface text-muted"><tr>
          <th className="p-2 font-bold">شماره سند</th><th className="p-2 font-bold">تاریخ</th><th className="p-2 font-bold">ردیف</th>
          <th className="p-2 font-bold">بدهکار ({unitLabel(preview.summary.amountUnit)})</th><th className="p-2 font-bold">بستانکار ({unitLabel(preview.summary.amountUnit)})</th><th className="p-2 font-bold">وضعیت</th>
        </tr></thead>
        <tbody>{preview.vouchers.map((voucher) => <tr key={voucher.sanad} className={`border-b border-line ${voucher.importable ? '' : 'bg-expense/5'}`}>
          <td className="numbers p-2 font-bold">{toPersianDigits(voucher.sanad)}</td>
          <td className="numbers p-2">{toPersianDigits(voucher.date)}</td>
          <td className="numbers p-2">{toPersianDigits(voucher.lineCount)}</td>
          <td className="numbers p-2">{formatAmount(voucher.bedTotal)}</td>
          <td className="numbers p-2">{formatAmount(voucher.besTotal)}</td>
          <td className="p-2">{voucher.importable
            ? <span className="text-income">قابل ورود</span>
            : <details><summary className={`cursor-pointer font-bold ${voucher.blockReason === 'unit' ? 'text-accent' : 'text-expense'}`}>
              {voucher.blockReason === 'unit' ? 'واحد' : voucher.blockReason === 'unbalanced' ? 'نامتوازن' : 'هشدار'}
            </summary>
              <ul className="mt-1 max-w-md space-y-0.5 leading-5 text-muted">{[...voucher.issues, ...voucher.lineIssues].map((item, index) => <li key={index}>• {item}</li>)}</ul>
            </details>}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}

function persianToken(iso) {
  if (!iso) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const gregorian = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 8, 30));
  const parts = new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(gregorian);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${pick('year')}/${pick('month')}/${pick('day')}`.replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[digit]);
}
