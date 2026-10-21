import { useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

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

  const acceptFile = (event) => {
    setFile(event.target.files?.[0] || null);
    setPreview(null); setResult(null); setError('');
  };

  const runPreview = async () => {
    if (!file) return;
    setBusy(true); setError(''); setResult(null);
    try { setPreview(await api.parsianBackupPreview(file)); }
    catch (issue) { setPreview(null); setError(issue.message); }
    setBusy(false);
  };

  const runCommit = async () => {
    if (!preview || !file) return;
    const skipped = preview.summary.voucherCount - preview.summary.importableCount;
    const question = skipped > 0
      ? `${toPersianDigits(preview.summary.importableCount)} سند متوازن به‌صورت پیش‌نویس وارد شود و ${toPersianDigits(skipped)} سند نامتوازن/نامعتبر فقط در همین گزارش بماند؟`
      : `${toPersianDigits(preview.summary.importableCount)} سند متوازن به‌صورت پیش‌نویس وارد شود؟`;
    if (!window.confirm(`${question}\nاین کار فقط در دفتر خام مجاز است و یک‌بار انجام می‌شود.`)) return;
    setBusy(true); setError('');
    try {
      const outcome = await api.parsianBackupCommit(file);
      setResult(outcome); setPreview(null); setFile(null);
      await refresh();
      notify('بکاپ پارسیان وارد شد؛ اسناد به‌صورت پیش‌نویس منتظر تأیید تو هستند.');
    } catch (issue) {
      setError(issue.message);
      if (issue.code === 'PARSIAN_IMPORT_PARTIAL' && issue.details) {
        setError(`${issue.message} ${issue.details.errors?.map((item) => item.message).join(' | ') || ''}`);
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
    </p>

    <div className="mt-3 flex flex-wrap items-center gap-2">
      <input type="file" accept=".bak,.bak2,application/octet-stream" onChange={acceptFile} disabled={!canManage || busy}
        className="block w-full max-w-md text-[13px] file:ml-3 file:rounded-lg file:border file:border-line file:bg-paper file:px-3 file:py-2 file:text-[13px] file:font-bold" />
      <button disabled={!file || busy} onClick={runPreview} className="tap rounded-lg border border-line bg-paper px-4 text-[13px] font-bold hover:bg-paper hover:text-ink disabled:opacity-45">
        {busy ? 'در حال خواندن…' : 'پیش‌نمایش'}
      </button>
      {preview && raw?.ok && canManage && <button disabled={busy || !summary.importableCount} onClick={runCommit}
        className="tap rounded-lg bg-accent px-4 text-[13px] font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90 active:bg-accent/80">
        ورود {toPersianDigits(summary.importableCount)} سند متوازن + کدینگ
      </button>}
    </div>
    {!canManage && <p className="mt-2 text-[12px] text-muted">ورود بکاپ فقط از نقش مدیر یا مالک انجام می‌شود.</p>}
    {error && <div className="mt-3 rounded-lg border border-expense/40 bg-expense/5 p-3 text-[13px] leading-6 text-expense">{error}</div>}

    {raw && !raw.ok && <div className="mt-3 rounded-lg border border-expense/40 bg-expense/5 p-3 text-[13px] font-bold leading-6 text-expense">
      ورود به این دفتر ممکن نیست: {raw.message}
      <span className="mr-2 font-normal text-muted">(سند: {toPersianDigits(raw.journalCount)} — کدینگ: {toPersianDigits(raw.chartCount)} — تفصیلی: {toPersianDigits(raw.analyticCount)} — سابقهٔ ورود پارسیان: {toPersianDigits(raw.importedBefore)})</span>
    </div>}

    {summary && <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <SummaryTile label="کل" value={summary.kolCount} />
      <SummaryTile label="معین" value={summary.moeenCount} />
      <SummaryTile label="تفصیلی" value={summary.tafsiliCount} />
      <SummaryTile label="سند در فایل" value={summary.voucherCount} />
      <SummaryTile label="قابل ورود" value={summary.importableCount} tone="text-income" />
      <SummaryTile label="نامتوازن/نامعتبر" value={summary.voucherCount - summary.importableCount} tone="text-expense" />
    </div>}

    {preview && <div className="mt-4 space-y-4">
      <p className="text-[12px] leading-5 text-muted">
        فایل: <b className="numbers">{preview.meta.fileName}</b> — {toPersianDigits(Math.round(preview.meta.sizeBytes / 1024))} کیلوبایت — {preview.meta.container}
        {summary.dateMin && <> — بازهٔ اسناد قابل ورود: <b className="numbers">{toPersianDigits(persianToken(summary.dateMin))}</b> تا <b className="numbers">{toPersianDigits(persianToken(summary.dateMax))}</b></>}
      </p>

      {preview.warnings.length > 0 && <div className="rounded-lg border border-accent/40 bg-warn-bg p-3">
        <p className="text-[13px] font-bold text-accent">هشدارها ({toPersianDigits(preview.warnings.length)})</p>
        <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-[12px] leading-6">{preview.warnings.map((item, index) => <li key={index}>• {item}</li>)}</ul>
      </div>}

      <ChartPreview preview={preview} />
      <VoucherPreview preview={preview} />
    </div>}

    {result && <div className="mt-4 space-y-3">
      <div className="rounded-lg border border-income/40 bg-income/5 p-3 text-[13px] leading-6">
        <b>ورود کامل شد.</b> کدینگ: <b className="numbers">{toPersianDigits(result.chart.created)}</b> حساب تازه — تفصیلی: <b className="numbers">{toPersianDigits(result.analytics)}</b> —
        حساب دفتر کل: <b className="numbers">{toPersianDigits(result.ledgerAccounts)}</b> — سند پیش‌نویس: <b className="numbers">{toPersianDigits(result.journals.entries)}</b> سند با جمع <b className="numbers">{formatAmount(result.journals.total)}</b> تومان.
        <div className="mt-1 text-muted">سندها در میز کار سندها منتظر تأییدند؛ شماره‌گذاری داخلی از نو و تاریخ‌ها شمسیِ خود فایل‌اند.</div>
      </div>
      {result.skippedVouchers.length > 0 && <div className="rounded-lg border border-expense/40 bg-expense/5 p-3">
        <p className="text-[13px] font-bold text-expense">{toPersianDigits(result.skippedVouchers.length)} سند وارد نشد — با هشدار باقی ماند</p>
        <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-[12px] leading-6">
          {result.skippedVouchers.map((voucher) => <li key={voucher.sanad}>
            <b className="numbers">سند {toPersianDigits(voucher.sanad)}</b> ({toPersianDigits(voucher.date)}): {voucher.issues[0] || 'نامعتبر'}
          </li>)}
        </ul>
      </div>}
    </div>}
  </section>;
}

function SummaryTile({ label, value, tone = '' }) {
  return <div className="rounded-lg border border-line bg-paper p-3 text-center">
    <p className={`text-lg font-extrabold numbers ${tone}`}>{toPersianDigits(value)}</p>
    <p className="mt-0.5 text-[11px] text-muted">{label}</p>
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
          <th className="p-2 font-bold">بدهکار</th><th className="p-2 font-bold">بستانکار</th><th className="p-2 font-bold">وضعیت</th>
        </tr></thead>
        <tbody>{preview.vouchers.map((voucher) => <tr key={voucher.sanad} className={`border-b border-line ${voucher.importable ? '' : 'bg-expense/5'}`}>
          <td className="numbers p-2 font-bold">{toPersianDigits(voucher.sanad)}</td>
          <td className="numbers p-2">{toPersianDigits(voucher.date)}</td>
          <td className="numbers p-2">{toPersianDigits(voucher.lineCount)}</td>
          <td className="numbers p-2">{formatAmount(voucher.bedTotal)}</td>
          <td className="numbers p-2">{formatAmount(voucher.besTotal)}</td>
          <td className="p-2">{voucher.importable
            ? <span className="text-income">قابل ورود</span>
            : <details><summary className="cursor-pointer font-bold text-expense">هشدار</summary>
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
