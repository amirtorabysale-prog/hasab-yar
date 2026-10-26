import { Download, Pencil, Trash2, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { BANKS, bankById, detectBank } from '../../../shared/banks.js';
import { profileDefinition } from '../../../shared/product.js';
import { api } from '../../lib/api.js';
import { digitsOnly } from '../../components/common.jsx';
import { formatAmount, toPersianDigits, unitLabel } from '../../lib/format.js';

const ACCOUNT_KINDS = [['cash', 'صندوق'], ['bank', 'بانک'], ['wallet', 'کیف پول'], ['other', 'سایر']];

/**
 * تعریف حساب‌های مالی دفتر.
 *
 * چرا بانک فیلد جداست و در نام حساب حل نمی‌شود: کاربر می‌گوید «از ملت دادم»
 * ولی حسابش را «جاری شرکت» اسم گذاشته. بدون هویت مشترک، گفتار به حساب نمی‌رسد
 * و هر ثبت بانکی در صندوق می‌نشیند.
 */
export function AccountsPanel({ accounts = [], canManage, notify, refresh }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);

  const blank = { name: '', kind: 'bank', bankId: '', openingBalance: 0, active: true };
  const guessed = draft && draft.kind === 'bank' && !draft.bankId ? detectBank(draft.name)?.bankId : null;

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.saveAccount({ ...draft, allowNegative: Boolean(draft.allowNegative), openingBalance: Number(digitsOnly(String(draft.openingBalance)) || 0) });
      setDraft(null);
      await refresh();
      notify('حساب ذخیره شد.');
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  return <section className="mt-5 rounded-xl border border-line bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="font-bold">حساب‌های مالی</p>
        <p className="mt-0.5 text-xs text-muted">وقتی نام بانک را در گفتار بگویی، ثبت روی همین حساب‌ها می‌نشیند.</p>
      </div>
      {canManage && <button onClick={() => setDraft(draft ? null : blank)} className="tap rounded-lg border border-line bg-paper px-3 text-[12px] font-bold hover:bg-paper hover:text-ink">
        {draft ? 'بستن' : 'حساب تازه'}
      </button>}
    </div>

    <ul className="mt-3 divide-y divide-line text-[13px]">
      {accounts.map((account) => {
        const bank = account.bankId ? bankById(account.bankId) : null;
        return <li key={account.id} className="flex flex-wrap items-center gap-2 py-2">
          <span className="min-w-0 flex-1 truncate">
            <b>{account.name}</b>
            <span className="mr-2 text-xs text-muted">· {account.kind === 'petty' ? 'تنخواه' : ACCOUNT_KINDS.find(([id]) => id === account.kind)?.[1]}</span>
            {/* حساب بانکی بی‌هویت، همانی است که گفتار هیچ‌وقت پیدایش نمی‌کند. */}
            {account.kind === 'bank' && <span className={`mr-2 text-xs ${bank ? 'text-muted' : 'text-expense'}`}>
              {bank ? bank.name : 'بانکش مشخص نیست'}
            </span>}
          </span>
          {account.allowNegative ? <span className="rounded-full bg-accent/5 px-2 text-xs font-bold text-accent">اضافه‌برداشت مجاز</span> : null}
          <span className={`numbers text-[12px] ${account.balance < 0 ? 'font-bold text-expense' : 'text-muted'}`}>{account.balance < 0 ? '−' : ''}{formatAmount(Math.abs(account.balance || 0))}</span>
          {/* تنخواه از صفحهٔ خودش اداره می‌شود: بستنش باید باقی‌مانده را برگرداند. */}
          {canManage && account.kind !== 'petty' && <button onClick={() => setDraft({ ...account, bankId: account.bankId || '' })} className="tap grid place-items-center text-muted" aria-label={`ویرایش ${account.name}`}><Pencil size={16} /></button>}
        </li>;
      })}
      {!accounts.length && <li className="py-3 text-muted">هنوز حسابی تعریف نشده است.</li>}
    </ul>

    {draft && <form onSubmit={save} className="mt-3 space-y-2 border-t border-line pt-3">
      <input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        placeholder="مثلاً جاری ملت شرکت" className="tap w-full rounded-lg border border-line bg-paper px-3 text-[13px]" />
      <div className="grid grid-cols-2 gap-2">
        <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })} className="tap rounded-lg border border-line bg-paper px-2 text-[13px]">
          {ACCOUNT_KINDS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        {draft.kind === 'bank' && <select value={draft.bankId} onChange={(event) => setDraft({ ...draft, bankId: event.target.value })} className="tap rounded-lg border border-line bg-paper px-2 text-[13px]">
          <option value="">{guessed ? `از روی نام: ${bankById(guessed).name}` : '— بانک را انتخاب کن —'}</option>
          {BANKS.map((bank) => <option key={bank.id} value={bank.id}>{bank.name}</option>)}
        </select>}
      </div>
      <label className="block text-xs text-muted">ماندهٔ ابتدای دوره
        <input inputMode="numeric" value={draft.openingBalance} onChange={(event) => setDraft({ ...draft, openingBalance: event.target.value })}
          className="tap numbers mt-1 w-full rounded-lg border border-line bg-paper px-3 text-left text-[13px]" />
      </label>
      {/* صندوق و بانک منفی نمی‌شوند مگر با تأیید حسابدار؛ این کلید فقط برای حسابی است که واقعاً اضافه‌برداشت دارد. */}
      <label className="flex items-start gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] leading-6 hover:bg-paper hover:text-ink">
        <input type="checkbox" checked={Boolean(draft.allowNegative)} onChange={(event) => setDraft({ ...draft, allowNegative: event.target.checked })} className="mt-1" />
        <span><b>اجازهٔ منفی شدن (اضافه‌برداشت)</b><span className="block text-muted">خاموش: اگر ثبتی این حساب را منفی کند، فقط با تأیید حسابدار و دلیل انجام می‌شود. فقط برای بانکی که قرارداد اضافه‌برداشت دارد روشن کن.</span></span>
      </label>
      <button disabled={busy} className="tap w-full rounded-lg bg-accent font-bold text-on-fill disabled:opacity-40 hover:bg-accent/90 active:bg-accent/80">{busy ? 'در حال ذخیره…' : 'ذخیره حساب'}</button>
    </form>}
  </section>;
}

export function SettingsPage({ initial, accounts = [], notify, refresh, onLogout, canManage = false }) {
  const [settings, setSettings] = useState({ businessName: '', profileType: 'business', openingBalance: '0', lowBalanceThreshold: '2000000', alertSensitivity: 'balanced', ...initial });
  useEffect(() => setSettings({ businessName: '', profileType: 'business', openingBalance: '0', lowBalanceThreshold: '2000000', alertSensitivity: 'balanced', ...initial }), [initial]);
  const save = async () => { if (!canManage) return notify('برای تغییر تنظیمات، نقش مدیر یا مالک لازم است.'); const result = await api.settings(settings); setSettings(result.settings); notify('تنظیمات ذخیره شد.'); };
  const selectedProfile = profileDefinition(settings.profileType);
  return <main className="mx-auto max-w-[760px] px-4 py-5">
    <h1 className="text-xl font-extrabold">تنظیمات</h1>
    <section className="mt-5 space-y-4 rounded-xl border border-line bg-surface p-4">
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => setSettings({ ...settings, profileType: 'business' })} className={`tap rounded-lg border text-sm font-bold ${settings.profileType === 'business' ? 'border-accent bg-accent/10 text-accent' : 'border-line'} hover:bg-paper hover:text-ink`}>کسب‌وکار</button>
        <button onClick={() => setSettings({ ...settings, profileType: 'personal' })} className={`tap rounded-lg border text-sm font-bold ${settings.profileType === 'personal' ? 'border-accent bg-accent/10 text-accent' : 'border-line'} hover:bg-paper hover:text-ink`}>شخصی</button>
      </div>
      <div className="rounded-lg border border-line bg-paper px-3 py-3">
        <p className="text-sm font-bold">{selectedProfile.label}</p>
        <p className="mt-1 text-[13px] leading-6 text-muted">{selectedProfile.description}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">{selectedProfile.capabilities.map((capability) => <span key={capability} className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-muted">{capability}</span>)}</div>
      </div>
      <label className="block text-[13px] text-muted">نام دفتر<input value={settings.businessName || ''} onChange={(event) => setSettings({ ...settings, businessName: event.target.value })} placeholder={settings.profileType === 'personal' ? 'مثلاً حساب‌های امیر' : 'مثلاً آرایشگاه آبان'} className="tap mt-2 w-full rounded-lg border border-line px-3 text-[15px] text-ink outline-none focus:border-accent" /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-[13px] text-muted">مانده شروع ثبت‌ها<input inputMode="numeric" value={settings.openingBalance || ''} onChange={(event) => setSettings({ ...settings, openingBalance: event.target.value.replace(/\D/g, '') })} className="tap numbers mt-2 w-full rounded-lg border border-line px-3" /></label>
        <label className="text-[13px] text-muted">هشدار کاهش مانده<input inputMode="numeric" value={settings.lowBalanceThreshold || ''} onChange={(event) => setSettings({ ...settings, lowBalanceThreshold: event.target.value.replace(/\D/g, '') })} className="tap numbers mt-2 w-full rounded-lg border border-line px-3" /></label>
      </div>
      <label className="mt-3 block text-[13px] text-muted">حساسیت هشدارهای مالی<select value={settings.alertSensitivity || 'balanced'} onChange={(event) => setSettings({ ...settings, alertSensitivity: event.target.value })} className="tap mt-2 w-full rounded-lg border border-line bg-surface px-3 text-ink"><option value="low">کم؛ فقط تغییرهای بزرگ</option><option value="balanced">متعادل؛ پیشنهاد حساب‌یار</option><option value="high">زیاد؛ هشدار زودتر</option></select><span className="mt-1 block text-xs leading-5">مبلغ غیرعادی و رشد هزینه فقط با خط مبنای کافی سنجیده می‌شود؛ این گزینه آستانه را تغییر می‌دهد، نه داده را.</span></label>
      <LedgerUnitSetting canManage={canManage} notify={notify} refresh={refresh} />
      <CompanyProfileCard raw={settings.companyProfile} />
      <button onClick={save} className="tap w-full rounded-lg bg-accent font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">ذخیره تنظیمات</button>
    </section>
  </main>;
}

/**
 * واحد مبلغ دفتر: تومان یا ریال. فقط پیش از اولین مبلغ عوض می‌شود؛ پس از آن قفل است،
 * چون عوض کردنش یعنی همهٔ عددهای قبلی ده برابر یا یک‌دهم خوانده شوند.
 */
/** مشخصات شرکت که از بکاپ پارسیان آمده (کد اقتصادی، شناسهٔ ملی، نشانی)؛ فقط برای دیدن. */
function CompanyProfileCard({ raw }) {
  let profile = null;
  try { profile = raw ? JSON.parse(raw) : null; } catch { profile = null; }
  if (!profile) return null;
  const rows = [['کد اقتصادی', profile.economicCode], ['شناسهٔ ملی', profile.nationalId], ['کد پستی', profile.postalCode], ['تلفن', profile.phone],
    ['استان و شهر', [profile.province, profile.city].filter(Boolean).join('، ')], ['نشانی', profile.address]].filter(([, value]) => value);
  if (!rows.length) return null;
  return <div className="rounded-lg border border-line bg-paper px-3 py-3">
    <p className="text-sm font-bold">مشخصات شرکت</p>
    <p className="mt-1 text-xs text-muted">{profile.source === 'parsian-backup' ? 'از بکاپ پارسیان آمده است.' : ''}</p>
    <dl className="mt-2 grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-2">
      {rows.map(([label, value]) => <div key={label} className="flex gap-2"><dt className="shrink-0 text-muted">{label}:</dt><dd className={label === 'نشانی' ? '' : 'numbers'}>{value}</dd></div>)}
    </dl>
  </div>;
}

function LedgerUnitSetting({ canManage, notify, refresh }) {
  const [state, setState] = useState(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.ledgerAmountUnit().then((result) => { setState(result); setChoice(result.amountUnit); }).catch(() => setState(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!state) return null;
  const save = async () => {
    if (!canManage || choice === state.amountUnit) return;
    setBusy(true);
    try {
      const result = await api.setLedgerAmountUnit(choice);
      await refresh();
      await load();
      notify(`واحد مبلغ این دفتر ${result.label} شد.`);
    } catch (error) { notify(error.message); }
    setBusy(false);
  };
  return <fieldset className="rounded-lg border border-line bg-paper px-3 py-3" disabled={!canManage || state.locked || busy}>
    <legend className="px-1 text-[13px] font-bold">واحد مبلغ دفتر: {state.label}</legend>
    <p className="text-[12px] leading-6 text-muted">
      همهٔ مبلغ‌های این دفتر به همین واحد ثبت و نمایش داده می‌شوند. دفتر ریالی برای کار با پارسیان است که مبلغ را به ریال نگه می‌دارد؛
      گفتهٔ «۲ میلیون تومان» در دفتر ریالی هم درست خوانده و به ریال ثبت می‌شود.
    </p>
    {state.locked
      ? <p className="mt-1 text-[12px] leading-6 text-muted">این دفتر مبلغ ثبت‌شده دارد و واحدش دیگر عوض نمی‌شود. برای واحد دیگر، دفتر تازه بساز و پیش از هر ثبتی واحدش را انتخاب کن.</p>
      : <div className="mt-2 flex flex-wrap items-center gap-4 text-[13px]">
        {[['toman', 'تومان'], ['rial', 'ریال']].map(([value, label]) => <label key={value} className="flex items-center gap-1.5">
          <input type="radio" name="ledger-amount-unit" value={value} checked={choice === value} onChange={() => setChoice(value)} /> {label}
        </label>)}
        {canManage && <button type="button" onClick={save} disabled={busy || choice === state.amountUnit}
          className="tap rounded-lg border border-line bg-surface px-3 text-[12px] font-bold disabled:opacity-45">ذخیرهٔ واحد</button>}
      </div>}
  </fieldset>;
}

/**
 * خروج، آخرین چیز صفحهٔ تنظیمات است.
 *
 * پیش از این وسط صفحه بود و شش بخش دیگر — حساب‌ها، اعضای دفتر، پشتیبان، حریم
 * خصوصی، نشست‌ها و رمز — زیرش می‌آمدند. کاربر یا آن‌ها را نمی‌دید، یا هنگام
 * گشتن دنبالشان از کنار دکمهٔ خروج رد می‌شد.
 */
export function LogoutPanel({ onLogout }) {
  return <button onClick={onLogout} className="tap mt-5 w-full rounded-lg border border-expense/40 bg-surface font-bold text-expense">خروج از حساب</button>;
}

export function DataPrivacyPanel({ access, notify }) {
  const [receipts, setReceipts] = useState([]);
  const canDelete = ['owner', 'manager', 'accountant'].includes(access.workspace?.role);
  const load = useCallback(() => api.receipts().then((result) => setReceipts(result.items)).catch((error) => notify(error.message)), [notify]);
  useEffect(() => { load(); }, [load, access.workspace?.id]);
  const remove = async (receipt) => {
    if (!window.confirm(`تصویر «${receipt.fileName}» برای همیشه حذف شود؟ این کار تراکنش‌های مالی را حذف نمی‌کند.`)) return;
    try { await api.deleteReceipt(receipt.id); await load(); notify('تصویر رسید و فرادادهٔ آن حذف شد.'); }
    catch (error) { notify(error.message); }
  };
  return <section className="mx-auto mt-5 max-w-[760px] px-4"><div className="rounded-xl border border-line bg-surface p-4"><h2 className="font-extrabold">حریم خصوصی و نگهداری داده</h2><div className="mt-3 space-y-2 text-[13px] leading-6 text-muted"><p>صدای کاربر فقط در حافظه برای تبدیل به متن پردازش می‌شود و فایل صوتی روی سرور نگه‌داری نمی‌شود.</p><p>تصاویر رسید تا زمان حذف دستی یا بازیابی یک پشتیبان نگه‌داری می‌شوند. حذف تصویر روی تراکنش مالی ثبت‌شده اثری ندارد.</p><p>پشتیبان‌های خودکار پس از بازهٔ نگهداری تنظیم‌شده به‌صورت امن از پوشهٔ پشتیبان حذف می‌شوند.</p></div>{receipts.length > 0 && <div className="mt-4 divide-y divide-line border-y border-line">{receipts.map((receipt) => <div key={receipt.id} className="flex min-h-[64px] items-center gap-2 py-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{receipt.fileName}</p><p className="mt-1 text-xs text-muted">{receipt.amount ? `${formatAmount(receipt.amount)} ${unitLabel()}` : 'بدون مبلغ'} · {new Intl.DateTimeFormat('fa-IR').format(new Date(receipt.createdAt))}</p></div><a href={api.workspacePath(`/api/receipts/${receipt.id}/image`)} target="_blank" rel="noreferrer" className="tap grid place-items-center rounded-lg border border-line px-3 text-xs font-bold hover:bg-paper hover:text-ink">دیدن</a>{canDelete && <button onClick={() => remove(receipt)} className="tap grid place-items-center text-expense" aria-label={`حذف ${receipt.fileName}`}><Trash2 size={18} /></button>}</div>)}</div>}</div></section>;
}

export function BackupPanel({ access, notify, refresh }) {
  const [status, setStatus] = useState(null);
  const [passphrase, setPassphrase] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState('');
  const role = access.workspace?.role;
  const canManage = ['owner', 'manager'].includes(role);
  const isOwner = role === 'owner';
  const loadStatus = useCallback(() => canManage ? api.backupStatus().then(setStatus).catch((error) => notify(error.message)) : Promise.resolve(), [canManage, notify]);
  useEffect(() => { loadStatus(); }, [loadStatus, access.workspace?.id]);
  const download = async () => {
    if (passphrase.length < 12) return notify('برای پشتیبان یک رمز حداقل ۱۲ نویسه‌ای انتخاب کن.');
    setBusy('download');
    try { await api.downloadBackup(passphrase); notify('پشتیبان رمزگذاری‌شده دانلود شد؛ رمز را جداگانه و امن نگه دار.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const inspect = async () => {
    if (!file) return notify('فایل پشتیبان را انتخاب کن.');
    if (passphrase.length < 12) return notify('رمز فایل پشتیبان را وارد کن.');
    setBusy('preview');
    try { const result = await api.previewBackup(file, passphrase); setPreview(result.summary); notify('فایل سالم است؛ خلاصه را پیش از بازیابی بررسی کن.'); }
    catch (error) { setPreview(null); notify(error.message); }
    finally { setBusy(''); }
  };
  const restore = async () => {
    if (!file || !preview) return notify('اول فایل را بررسی کن.');
    setBusy('restore');
    try {
      await api.restoreBackup(file, passphrase, confirmation);
      setFile(null); setPreview(null); setConfirmation('');
      await refresh();
      notify('دفتر با موفقیت بازیابی شد و پیش از آن checkpoint امن ساخته شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const snapshot = async () => {
    setBusy('snapshot');
    try { await api.createServerSnapshot(); await loadStatus(); notify('snapshot رمزگذاری‌شده روی سرور ساخته و آزمایش شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  if (!canManage) return null;
  return <section className="mx-auto mt-5 max-w-[760px] px-4"><div className="rounded-xl border border-line bg-surface p-4"><div className="flex items-start gap-3"><Download className="mt-0.5 shrink-0 text-accent" size={22} /><div><h2 className="font-extrabold">پشتیبان امن و بازیابی</h2><p className="mt-1 text-[13px] leading-6 text-muted">فایل شامل تمام داده‌های دفتر فعال و تصاویر رسید است و با AES-256 رمزگذاری می‌شود. رمز فایل روی سرور ذخیره نمی‌شود.</p></div></div><label className="mt-4 block text-[13px] text-muted">رمز پشتیبان<input type="password" minLength={12} autoComplete="new-password" value={passphrase} onChange={(event) => { setPassphrase(event.target.value); setPreview(null); }} placeholder="حداقل ۱۲ نویسه؛ در جای امن یادداشت کن" dir="ltr" className="tap mt-2 w-full rounded-lg border border-line px-3 text-left" /></label><button disabled={busy || passphrase.length < 12} onClick={download} className="tap mt-3 w-full rounded-lg bg-ink font-bold text-on-fill disabled:opacity-40">{busy === 'download' ? 'در حال ساخت…' : 'دانلود پشتیبان رمزگذاری‌شده'}</button><div className="mt-4 rounded-lg bg-paper px-3 py-3 text-[12px] leading-6 text-muted">{status?.configured ? <><b className="text-income">پشتیبان خودکار فعال است.</b> نگهداری: {toPersianDigits(status.retentionDays)} روز. {status.lastBackup ? `آخرین نسخه: ${new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(status.lastBackup.createdAt))}` : 'هنوز نسخه‌ای ساخته نشده است.'}</> : <><b className="text-expense">پشتیبان خودکار هنوز فعال نیست.</b> متغیر BACKUP_ENCRYPTION_KEY باید روی Railway تنظیم شود.</>}</div>{status?.configured && <button disabled={busy} onClick={snapshot} className="tap mt-2 w-full rounded-lg border border-line font-bold disabled:opacity-40 hover:bg-paper hover:text-ink">{busy === 'snapshot' ? 'در حال آزمایش و ذخیره…' : 'ساخت snapshot سرور همین حالا'}</button>}{isOwner && <div className="mt-5 border-t border-line pt-4"><h3 className="font-extrabold">بازیابی دفتر فعال</h3><p className="mt-1 text-[12px] leading-6 text-expense">بازیابی، اطلاعات مالی فعلی این دفتر را جایگزین می‌کند. پیش از جایگزینی، یک checkpoint رمزگذاری‌شده ساخته می‌شود.</p><input type="file" accept=".hybackup,application/octet-stream" onChange={(event) => { setFile(event.target.files?.[0] || null); setPreview(null); setConfirmation(''); }} className="mt-3 block w-full text-xs" /><button disabled={busy || !file || passphrase.length < 12} onClick={inspect} className="tap mt-3 w-full rounded-lg border border-accent font-bold text-accent disabled:opacity-40">{busy === 'preview' ? 'در حال رمزگشایی و بررسی…' : 'بررسی فایل پیش از بازیابی'}</button>{preview && <div className="mt-3 rounded-lg border border-line bg-paper p-3"><p className="text-sm font-bold text-income">فایل سالم و قابل بازیابی است</p><div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted"><span>تراکنش: <b className="numbers text-ink">{toPersianDigits(preview.transactions)}</b></span><span>رسید: <b className="numbers text-ink">{toPersianDigits(preview.receipts)}</b></span><span>درآمد: <b className="numbers text-income">{formatAmount(preview.income)}</b></span><span>هزینه: <b className="numbers text-expense">{formatAmount(preview.expense)}</b></span></div><label className="mt-3 block text-[12px] text-muted">برای تأیید بنویس: بازیابی دفتر<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="tap mt-2 w-full rounded-lg border border-expense px-3 text-ink" /></label><button disabled={busy || confirmation !== 'بازیابی دفتر'} onClick={restore} className="tap mt-3 w-full rounded-lg bg-expense font-bold text-on-fill disabled:opacity-35 hover:bg-expense/90">{busy === 'restore' ? 'در حال ساخت checkpoint و بازیابی…' : 'بازیابی قطعی دفتر'}</button></div>}</div>}</div></section>;
}

export function SessionsPanel({ notify }) {
  const [sessions, setSessions] = useState([]);
  const [busy, setBusy] = useState('');
  const refresh = useCallback(() => api.sessions().then((result) => setSessions(result.items || [])).catch((error) => notify(error.message)), [notify]);
  useEffect(() => { refresh(); }, [refresh]);
  const revoke = async (id) => {
    setBusy(id);
    try { await api.revokeSession(id); await refresh(); notify('نشست انتخاب‌شده بسته شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const revokeOthers = async () => {
    setBusy('others');
    try {
      const result = await api.revokeOtherSessions();
      await refresh();
      notify(result.revoked ? `${toPersianDigits(result.revoked)} نشست دیگر بسته شد.` : 'نشست فعال دیگری وجود ندارد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  return <section className="mx-auto mt-5 max-w-[760px] px-4"><div className="rounded-xl border border-line bg-surface p-4"><div className="flex items-start gap-3"><Users className="mt-0.5 shrink-0 text-accent" size={22} /><div><h2 className="font-extrabold">دستگاه‌ها و نشست‌های فعال</h2><p className="mt-1 text-[13px] leading-6 text-muted">هر نشست حداکثر هفت روز اعتبار دارد. حساب‌یار فقط شناسهٔ یک‌طرفهٔ نشست را نمایش می‌دهد و توکن ورود هرگز برگردانده نمی‌شود.</p></div></div><div className="mt-4 divide-y divide-line border-y border-line">{sessions.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 py-3"><div><p className="text-sm font-bold">{item.current ? 'همین دستگاه' : 'نشست فعال'}</p><p className="mt-1 text-xs leading-5 text-muted">شروع: {new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt))}<br />انقضا: {new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.expiresAt))}</p></div>{item.current ? <span className="rounded-full bg-accent/5 px-3 py-1 text-xs font-bold text-accent">فعلی</span> : <button disabled={Boolean(busy)} onClick={() => revoke(item.id)} className="tap rounded-lg border border-expense px-3 text-xs font-bold text-expense disabled:opacity-40">{busy === item.id ? 'در حال بستن…' : 'بستن نشست'}</button>}</div>)}</div><button disabled={Boolean(busy) || sessions.every((item) => item.current)} onClick={revokeOthers} className="tap mt-3 w-full rounded-lg border border-line font-bold disabled:opacity-40 hover:bg-paper hover:text-ink">{busy === 'others' ? 'در حال بستن…' : 'بستن همهٔ دستگاه‌های دیگر'}</button></div></section>;
}

export function PasswordPanel({ notify, onChanged }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (newPassword !== confirmation) return notify('تکرار رمز جدید یکسان نیست.');
    setSaving(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      notify('رمز تغییر کرد؛ برای امنیت دوباره وارد شو.');
      await onChanged();
    } catch (error) { notify(error.message); }
    finally { setSaving(false); }
  };
  return <section className="mx-auto mt-5 max-w-[760px] px-4"><form onSubmit={submit} className="rounded-xl border border-line bg-surface p-4"><h2 className="font-extrabold">تغییر رمز مالک</h2><p className="mt-2 text-[13px] leading-6 text-muted">حداقل ۱۴ نویسه، شامل حرف و عدد. پس از تغییر، همهٔ نشست‌های قبلی بسته می‌شوند.</p><label className="mt-4 block text-[13px] text-muted">رمز فعلی<input required type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} className="tap mt-2 w-full rounded-lg border border-line px-3" /></label><label className="mt-3 block text-[13px] text-muted">رمز جدید<input required minLength={14} type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="tap mt-2 w-full rounded-lg border border-line px-3" /></label><label className="mt-3 block text-[13px] text-muted">تکرار رمز جدید<input required minLength={14} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="tap mt-2 w-full rounded-lg border border-line px-3" /></label><button disabled={saving || newPassword !== confirmation} className="tap mt-4 w-full rounded-lg bg-ink font-bold text-on-fill disabled:opacity-40 hover:bg-ink/90">{saving ? 'در حال تغییر…' : 'تغییر رمز و خروج از همه دستگاه‌ها'}</button></form></section>;
}
