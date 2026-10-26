import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, persianDate, toPersianDigits, unitLabel } from '../../lib/format.js';

/**
 * وجوه ناشناس — تعیین تکلیف پولی که منشأش بعداً معلوم شد.
 *
 * پول یک بار، در روز نگهداری، وارد بانک شده است. تعیین تکلیف فقط آن را از
 * بدهی موقت به جای درستش منتقل می‌کند؛ هیچ دریافت تازه‌ای ساخته نمی‌شود، جز
 * «استرداد به فرستنده» که پول واقعاً از بانک می‌رود.
 */
const EMPTY = { target: '', amount: '', invoiceId: '', contactId: '', category: '', vatAmount: '', reason: '', occurredAt: '' };
const digits = (value) => String(value || '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[^\d]/g, '');

function ResolveForm({ hold, targets, invoices, contacts, notify, onDone }) {
  const [form, setForm] = useState({ ...EMPTY, amount: String(hold.remaining) });
  const [busy, setBusy] = useState(false);
  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = { ...form, amount: Number(digits(form.amount)), vatAmount: Number(digits(form.vatAmount)) || 0, occurredAt: form.occurredAt || undefined };
      const { item } = await api.resolveUnidentified(hold.lineId, payload);
      notify(`تعیین تکلیف ثبت شد؛ ماندهٔ این وجه ${formatAmount(item.remaining)} ${unitLabel()}.`);
      await onDone();
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const field = 'tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-sm';
  return <form onSubmit={submit} className="mt-2 grid gap-2 rounded-lg border border-line bg-surface p-3 text-[12px] sm:grid-cols-2">
    <label>منشأ پول<select required value={form.target} onChange={set('target')} className={field}>
      <option value="">انتخاب کن</option>
      {Object.entries(targets).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
    </select></label>
    <label>مبلغ ({unitLabel()})<input inputMode="numeric" required value={form.amount} onChange={set('amount')} className={`${field} numbers`} /></label>
    {form.target === 'invoice' && <label className="sm:col-span-2">فاکتور فروش<select required value={form.invoiceId} onChange={set('invoiceId')} className={field}>
      <option value="">انتخاب کن</option>
      {invoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.number} — {invoice.contactName || invoice.customerName} — مانده {formatAmount(invoice.balanceDue)}</option>)}
    </select></label>}
    {['partner', 'advance'].includes(form.target) && <label className="sm:col-span-2">شخص<select required value={form.contactId} onChange={set('contactId')} className={field}>
      <option value="">انتخاب کن</option>
      {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}
    </select></label>}
    {form.target === 'income' && <>
      <label>دستهٔ درآمد<input required value={form.category} onChange={set('category')} placeholder="مثلاً فروش خدمات" className={field} /></label>
      <label>ارزش افزودهٔ داخل مبلغ<input inputMode="numeric" value={form.vatAmount} onChange={set('vatAmount')} placeholder="۰" className={`${field} numbers`} /></label>
    </>}
    <label>تاریخ تعیین تکلیف<input type="date" value={form.occurredAt} onChange={set('occurredAt')} className={field} /></label>
    <label className="sm:col-span-2">دلیل یا مدرک منشأ<textarea required minLength={8} value={form.reason} onChange={set('reason')} placeholder="مثلاً فیش واریز شرکت آریا رسید" className="mt-1 min-h-16 w-full rounded-lg border border-line bg-surface p-2 text-sm" /></label>
    <button disabled={busy} className="tap rounded-lg bg-accent font-bold text-on-fill disabled:opacity-45 sm:col-span-2 hover:bg-accent/90 active:bg-accent/80">ثبت تعیین تکلیف</button>
  </form>;
}

export function UnidentifiedFundsPanel({ notify }) {
  const [data, setData] = useState(null);
  const [lookups, setLookups] = useState({ invoices: [], contacts: [] });
  const [open, setOpen] = useState('');
  const load = useCallback(async () => {
    try {
      const [holds, invoices, contacts] = await Promise.all([
        api.unidentifiedReceipts(), api.invoices({ documentType: 'sales' }), api.contacts(),
      ]);
      setData(holds);
      setLookups({
        invoices: invoices.items.filter((item) => item.balanceDue > 0 && !['draft', 'cancelled'].includes(item.status)),
        contacts: contacts.items,
      });
      setOpen('');
    } catch (error) { notify(error.message); setData({ items: [], targets: {} }); }
  }, [notify]);
  useEffect(() => { load(); }, [load]);
  const reverse = async (resolution) => {
    if (!window.confirm('این تعیین تکلیف برگردانده شود؟ سندش معکوس و وجه دوباره باز می‌شود.')) return;
    try { await api.reverseUnidentifiedResolution(resolution.id); notify('تعیین تکلیف برگشت خورد.'); await load(); }
    catch (error) { notify(error.message); }
  };
  if (!data?.items?.length) return null;
  return <section aria-label="وجوه ناشناس" className="mt-4 rounded-xl border border-line bg-paper p-3">
    <p className="font-bold">وجوه ناشناس <span className="numbers text-muted">({toPersianDigits(data.items.length)})</span></p>
    <p className="mt-1 text-[12px] leading-6 text-muted">پولی که منشأش معلوم نبود و در بدهی موقت نگه داشته شده. وقتی منشأ معلوم شد اینجا تعیین تکلیفش کن؛ اگر همان پول دوباره ثبت شده، آن ثبت را رد کن.</p>
    <div className="mt-2 divide-y divide-line">
      {data.items.map((hold) => <article key={hold.lineId} className="py-3 text-[13px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span><b className="numbers">{formatAmount(hold.amount)}</b> {unitLabel()} · {persianDate(hold.occurredAt)} · سند <span className="numbers">{toPersianDigits(hold.reference)}</span></span>
          <span className="rounded border border-expense/40 bg-expense/5 px-2 py-0.5 text-[12px] font-bold text-expense">مانده <span className="numbers">{formatAmount(hold.remaining)}</span></span>
        </div>
        {hold.evidence && <p dir="auto" className="mt-1 text-[12px] text-muted">{hold.evidence}</p>}
        {hold.resolutions.map((resolution) => <p key={resolution.id} className="mt-1 flex flex-wrap items-center gap-2 text-[12px]">
          <span>{resolution.targetLabel}: <b className="numbers">{formatAmount(resolution.amount)}</b> — {resolution.reason}</span>
          <button type="button" onClick={() => reverse(resolution)} className="text-expense underline">برگشت</button>
        </p>)}
        {open === hold.lineId
          ? <ResolveForm hold={hold} targets={data.targets} invoices={lookups.invoices} contacts={lookups.contacts} notify={notify} onDone={load} />
          : <button type="button" onClick={() => setOpen(hold.lineId)} className="tap mt-2 rounded-lg border border-accent px-3 text-[12px] font-bold text-accent">تعیین تکلیف</button>}
      </article>)}
    </div>
  </section>;
}
