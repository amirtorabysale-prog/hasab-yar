import { ArrowDownLeft, ArrowUpRight, Check, MessageSquareText, RotateCcw, Settings2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

/**
 * پیامک‌های بانکی — یک صفحه برای دیدن، تطبیق و تعیین تکلیف هر پیامک.
 *
 * هر پیامک تراکنش یا با ثبتی که در دفتر هست تطبیق می‌خورد (خودکار وقتی فقط یک
 * نامزد هست)، یا کاربر بابتش را می‌گوید و ثبت می‌شود، یا کنار می‌رود. بابت هرگز
 * حدس زده نمی‌شود. مانده‌ای که بانک گفته کنار ماندهٔ دفتر نشان داده می‌شود تا
 * ثبتِ جاافتاده دیده شود. کل قابلیت و هر بانک جدا روشن و خاموش می‌شود.
 *
 * در اپ اندروید، پیامک‌های بانکی با اجازهٔ صاحب گوشی خودکار به همین‌جا می‌آیند؛
 * در وب، پیامک را کپی و این‌جا می‌چسبانی.
 */
const STATUS = {
  pending: { label: 'منتظر', tone: 'border-warning/40 bg-warning/10 text-ink' },
  matched: { label: 'تطبیق خورد', tone: 'border-income/40 bg-income/10 text-income' },
  recorded: { label: 'ثبت شد', tone: 'border-accent/40 bg-accent/10 text-accent' },
  ignored: { label: 'کنار گذاشته', tone: 'border-line bg-paper text-muted' },
};
const FILTERS = [['pending', 'منتظر'], ['matched', 'تطبیق خورده'], ['recorded', 'ثبت‌شده'], ['ignored', 'کنار گذاشته'], ['', 'همه']];
const dateOf = (iso) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export function BankSmsPage({ categories = [], notify, refresh }) {
  const [settings, setSettings] = useState(null);
  const [data, setData] = useState({ items: [], summary: {} });
  const [filter, setFilter] = useState('pending');
  const [paste, setPaste] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState({});

  const load = useCallback(async () => {
    const [config, list] = await Promise.all([api.bankSmsSettings(), api.bankSms(filter)]);
    setSettings(config.settings); setData(list);
  }, [filter]);
  useEffect(() => { load().catch((error) => notify(error.message)); }, [load, notify]);

  const run = async (promise, message) => {
    setBusy(true);
    try { await promise; await load(); refresh?.(); if (message) notify(message); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const saveSettings = (patch) => run(api.saveBankSmsSettings(patch));
  const ingest = async (event) => {
    event.preventDefault();
    const messages = paste.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean).map((text) => ({ text, receivedAt: new Date().toISOString() }));
    if (!messages.length) return notify('متن پیامک را بچسبان.');
    setBusy(true);
    try {
      const result = await api.ingestBankSms(messages);
      const stored = result.results.filter((item) => item.result === 'stored').length;
      const skipped = result.results.length - stored;
      notify(`${toPersianDigits(stored)} پیامک ثبت شد${skipped ? `؛ ${toPersianDigits(skipped)} مورد تکراری، رمز یا غیربانکی بود` : ''}.`);
      setPaste(''); setFilter('pending'); await load();
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };

  if (!settings) return <main className="mx-auto w-full max-w-[980px] px-4 py-5"><p className="text-sm text-muted">در حال بارگذاری…</p></main>;
  const accountName = (id) => settings.accounts.find((account) => account.id === id)?.name;
  const accountsOf = (bankId) => settings.accounts.filter((account) => account.bankId === bankId);
  const draft = (id) => drafts[id] || {};
  const setDraft = (id, patch) => setDrafts({ ...drafts, [id]: { ...draft(id), ...patch } });

  return <main className="mx-auto w-full max-w-[980px] px-4 py-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-extrabold"><MessageSquareText size={22} /> پیامک‌های بانکی</h1>
        <p className="mt-1 max-w-[620px] text-[13px] leading-6 text-muted">هر پیامک برداشت یا واریز با ثبت دفتر تطبیق می‌خورد؛ اگر ثبتی نبود، بابتش را می‌گویی و ثبت می‌شود. بابت هیچ پیامکی حدس زده نمی‌شود، و رمز یک‌بارمصرف هیچ‌وقت ذخیره نمی‌شود.</p>
      </div>
      <div className="flex items-center gap-2">
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-bold">
          <input type="checkbox" checked={settings.enabled} disabled={busy} onChange={(event) => saveSettings({ enabled: event.target.checked })} />
          {settings.enabled ? 'روشن' : 'خاموش'}
        </label>
        <button type="button" onClick={() => setShowSettings(!showSettings)} aria-expanded={showSettings} className="tap flex items-center gap-1 rounded-lg border border-line px-3 text-sm"><Settings2 size={16} /> تنظیمات</button>
      </div>
    </div>

    {showSettings && <section className="mt-4 rounded-xl border border-line bg-surface p-4">
      <h2 className="font-bold">بانک‌ها</h2>
      <p className="mt-1 text-xs text-muted">پیامک بانکِ خاموش اصلاً خوانده و ذخیره نمی‌شود. بانک‌هایی که در دفتر حساب دارند اول آمده‌اند.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {settings.banks.map((bank) => <label key={bank.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${bank.inLedger ? 'border-accent/40' : 'border-line'}`}>
          <input type="checkbox" checked={bank.enabled} disabled={busy} onChange={(event) => saveSettings({ banks: { [bank.id]: event.target.checked } })} />
          <span className="flex-1">{bank.name}</span>{bank.inLedger && <span className="text-[11px] text-accent">در دفتر</span>}
        </label>)}
      </div>
      <h2 className="mt-5 font-bold">چهار رقم آخر حساب یا کارت</h2>
      <p className="mt-1 text-xs text-muted">وقتی از یک بانک چند حساب داری، با این چهار رقم پیامک به حساب درست می‌رسد. با یک حساب لازم نیست.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {settings.accounts.map((account) => <label key={account.id} className="flex items-center gap-2 text-sm">
          <span className="w-40 truncate">{account.name}</span>
          <input defaultValue={account.hint} inputMode="numeric" maxLength={4} placeholder="۴ رقم" onBlur={(event) => event.target.value !== account.hint && saveSettings({ hints: { [account.id]: event.target.value } })} className="tap numbers w-24 rounded-lg border border-line px-2" />
        </label>)}
        {!settings.accounts.length && <p className="text-sm text-muted">هنوز حساب بانکی تعریف نشده؛ از تنظیمات › صندوق و بانک.</p>}
      </div>
    </section>}

    {settings.enabled ? <form onSubmit={ingest} className="mt-4 rounded-xl border border-line bg-surface p-4">
      <label htmlFor="sms-paste" className="font-bold">افزودن پیامک</label>
      <p className="mt-1 text-xs text-muted">در اپ اندروید پیامک‌ها خودکار می‌آیند. این‌جا می‌توانی یک یا چند پیامک را بچسبانی؛ هر پیامک را با یک خط خالی جدا کن.</p>
      <textarea id="sms-paste" value={paste} onChange={(event) => setPaste(event.target.value)} rows={4} placeholder={'بانک ملت\nبرداشت: 1,250,000\nمانده: 10,500,000\n1405/07/15-10:20'} className="mt-2 w-full rounded-lg border border-line bg-paper p-3 text-sm" />
      <button disabled={busy} className="tap mt-2 rounded-lg bg-accent px-4 text-sm font-bold text-on-fill">خواندن پیامک</button>
    </form> : <p className="mt-4 rounded-xl border border-line bg-paper p-4 text-sm text-muted">خواندن پیامک بانکی خاموش است. با دکمهٔ بالا روشنش کن؛ می‌توانی فقط بعضی بانک‌ها را روشن نگه داری.</p>}

    <nav aria-label="وضعیت پیامک‌ها" className="section-navigation mt-5">
      {FILTERS.map(([id, label]) => <button key={id || 'all'} type="button" aria-current={filter === id ? 'page' : undefined} onClick={() => setFilter(id)}>
        {label}{id && data.summary?.[id] != null ? ` (${toPersianDigits(data.summary[id])})` : ''}
      </button>)}
    </nav>

    <div className="mt-3 space-y-3">
      {!data.items.length && <p className="py-8 text-center text-sm text-muted">پیامکی در این بخش نیست.</p>}
      {data.items.map((item) => {
        const income = item.direction === 'income';
        const status = STATUS[item.status];
        const choices = categories.filter((category) => category.type === item.direction);
        return <article key={item.id} className="rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`grid h-9 w-9 place-items-center rounded-full ${income ? 'bg-income/10 text-income' : 'bg-expense/10 text-expense'}`}>{income ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}</span>
            <div className="min-w-0 flex-1">
              <p className="font-bold">{item.bankName} · {income ? 'واریز' : 'برداشت'}</p>
              <p className="mt-0.5 text-xs text-muted">{dateOf(item.occurredAt)}{item.accountHint ? ` · حساب …${toPersianDigits(item.accountHint)}` : ''}{item.accountId ? ` · ${accountName(item.accountId) || ''}` : ''}</p>
            </div>
            <b className={`numbers text-lg ${income ? 'text-income' : 'text-expense'}`}>{income ? '+' : '−'}{formatAmount(item.amount)}</b>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${status.tone}`}>{status.label}{item.matchKind === 'auto' ? ' (خودکار)' : ''}</span>
          </div>

          {item.balanceCheck && <p className={`mt-3 rounded-lg px-3 py-2 text-xs ${item.balanceCheck.difference === 0 ? 'bg-income/10 text-income' : 'bg-expense/10 text-expense'}`}>
            {item.balanceCheck.difference === 0
              ? `مانده طبق بانک و دفتر یکی است: ${formatAmount(item.balanceCheck.sms)}`
              : `مانده طبق بانک ${formatAmount(item.balanceCheck.sms)} و طبق دفتر ${formatAmount(item.balanceCheck.ledger)} است؛ اختلاف ${formatAmount(Math.abs(item.balanceCheck.difference))} — احتمالاً ثبتی جا افتاده.`}
          </p>}

          {item.status === 'pending' && <div className="mt-3 space-y-3">
            {!item.accountId && <label className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">حساب این پیامک:</span>
              <select disabled={busy} defaultValue="" onChange={(event) => event.target.value && run(api.assignBankSmsAccount(item.id, event.target.value))} className="tap rounded-lg border border-line bg-surface px-3">
                <option value="">انتخاب کن…</option>
                {(accountsOf(item.bankId).length ? accountsOf(item.bankId) : settings.accounts).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </label>}
            {item.candidates.length > 0 && <div>
              <p className="text-xs font-bold text-muted">ثبت‌های هم‌مبلغ در همین روزها — همین است؟</p>
              <ul className="mt-1 divide-y divide-line rounded-lg border border-line">
                {item.candidates.map((candidate) => <li key={candidate.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{candidate.rawText || candidate.category} · <span className="text-muted">{candidate.category}</span></span>
                  <span className="text-xs text-muted">{dateOf(candidate.occurredAt)}</span>
                  <button disabled={busy} onClick={() => run(api.matchBankSms(item.id, candidate.id), 'پیامک با همین ثبت تطبیق خورد.')} className="tap flex items-center gap-1 rounded-lg border border-income px-2 text-xs font-bold text-income"><Check size={14} /> تطبیق</button>
                </li>)}
              </ul>
            </div>}
            <div className="grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)_auto_auto]">
              <select value={draft(item.id).category || ''} onChange={(event) => setDraft(item.id, { category: event.target.value })} className="tap rounded-lg border border-line bg-surface px-3 text-sm">
                <option value="">بابت چه بود؟ (دسته)</option>
                {choices.map((category) => <option key={category.id}>{category.name}</option>)}
              </select>
              <input value={draft(item.id).description || ''} onChange={(event) => setDraft(item.id, { description: event.target.value })} placeholder="شرح (اختیاری)، مثلاً قبض برق مهر" className="tap rounded-lg border border-line px-3 text-sm" />
              <button disabled={busy || !draft(item.id).category || !item.accountId} onClick={() => run(api.recordBankSms(item.id, draft(item.id)), 'از روی پیامک در دفتر ثبت شد.')} className="tap rounded-lg bg-accent px-3 text-xs font-bold text-on-fill disabled:opacity-40">ثبت در دفتر</button>
              <button disabled={busy} onClick={() => { const reason = window.prompt('چرا این پیامک ثبت نمی‌خواهد؟ (مثلاً انتقال بین حساب‌های خودمان)'); if (reason !== null) run(api.ignoreBankSms(item.id, reason), 'کنار گذاشته شد.'); }} className="tap flex items-center gap-1 rounded-lg border border-line px-3 text-xs font-bold text-muted"><X size={14} /> کنار بگذار</button>
            </div>
          </div>}

          {(item.status === 'matched' || item.status === 'ignored') && <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted">
            <span>{item.status === 'ignored' ? (item.note ? `دلیل: ${item.note}` : 'کنار گذاشته شد.') : 'این پیامک گواهِ یک ثبت موجود است؛ چیزی دوباره ثبت نشد.'}</span>
            <button disabled={busy} onClick={() => run(api.reopenBankSms(item.id), 'پیامک دوباره منتظر شد.')} className="tap flex items-center gap-1 rounded-lg border border-line px-2 font-bold"><RotateCcw size={13} /> برگرداندن</button>
          </div>}
          {item.status === 'recorded' && <p className="mt-3 text-xs text-muted">از روی این پیامک تراکنش ساخته شد{item.note ? `: ${item.note}` : ''}.</p>}
        </article>;
      })}
    </div>
  </main>;
}
