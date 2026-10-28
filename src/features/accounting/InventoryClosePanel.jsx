import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, toPersianDigits, unitLabel } from '../../lib/format.js';

const STATE_LABEL = { submitted: 'منتظر کنترل', returned: 'برگشتی', draft: 'پیش‌نویس', approved: 'کنترل‌شده' };

/**
 * سند پایان دورهٔ انبار برای دفتر ادواریِ آمده از پارسیان، پیش از بستن سال. فقط وقتی دیده
 * می‌شود که سال گردش کالای پارسیان دارد. سند را پیشنهاد می‌دهد و «منتظر کنترل» می‌سازد؛
 * تأییدش در کنترل اسناد است، مثل هر سند دیگر.
 */
export default function InventoryClosePanel({ year, label, notify, onChange }) {
  const [plan, setPlan] = useState(null);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!year) return;
    try { setPlan(await api.previewInventoryClose(year, target)); } catch (error) { notify(error.message); }
  }, [year, target, notify]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setTarget(''); }, [year]);

  if (!plan || plan.blockers.some((item) => item.code === 'INVENTORY_CLOSE_NOT_PERIODIC')) return null;
  const { amounts, accounts, existing } = plan;
  const blockers = plan.blockers.filter((item) => item.code !== 'INVENTORY_CLOSE_APPROVED');
  const propose = async () => {
    setBusy(true);
    try {
      const result = await api.proposeInventoryClose(year, target);
      notify(`سند ${toPersianDigits(result.documentNumber)} پایان دورهٔ انبار ${result.rebuilt ? 'بازسازی شد' : 'ساخته شد'} و منتظر کنترل است.`);
      await load(); await onChange?.();
    } catch (error) { notify(error.message); }
    setBusy(false);
  };
  const row = (title, value, hint = '') => <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
    <span>{title}{hint ? <span className="mr-1 text-xs text-muted">{hint}</span> : null}</span>
    <b className="numbers">{formatAmount(value)} {unitLabel()}</b>
  </div>;
  const codes = (list) => list.map((item) => toPersianDigits(item.code)).join('، ') || '—';

  return <div className="mt-4 rounded-lg border border-line p-3">
    <h3 className="font-extrabold">سند پایان دورهٔ انبار {toPersianDigits(label)}</h3>
    <p className="mt-1 text-xs leading-6 text-muted">پارسیان ادواری است: تا این سند نخورد، کل خرید هزینه شمرده شده و موجودی پایان دوره در دفتر نیست. موجودی پایان دوره از گردش فاکتورها به میانگین موزون است و سند پیش از ثبت به کنترل حسابدار می‌رود.</p>
    <div className="mt-2 divide-y divide-line rounded-lg bg-paper text-[13px]">
      {row('موجودی اول دوره در دفتر', amounts.opening, `(${codes(accounts.inventory)})`)}
      {row('+ خرید کالا', amounts.purchases, `(${codes(accounts.purchases)}، از سند فاکتورهای خرید)`)}
      {amounts.returns ? row('− برگشت از خرید', amounts.returns, `(${codes(accounts.returns)})`) : null}
      {row('− موجودی پایان دوره', amounts.ending, accounts.target ? `(به ${toPersianDigits(accounts.target.code)} ${accounts.target.name})` : '')}
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 font-extrabold">
        <span>= بهای تمام‌شدهٔ کالای فروش‌رفته {accounts.cogs[0] ? <span className="text-xs font-normal text-muted">({toPersianDigits(accounts.cogs[0].code)})</span> : null}</span>
        <b className="numbers">{formatAmount(amounts.cogs)} {unitLabel()}</b>
      </div>
    </div>
    {accounts.inventory.length > 1 && !existing?.state === 'approved' ? <label className="mt-2 block text-xs text-muted">حساب موجودی پایان دوره
      <select value={target || accounts.target?.id || ''} onChange={(event) => setTarget(event.target.value)} className="tap mt-1 w-full rounded-lg border border-line bg-paper px-2 text-sm text-ink">
        {accounts.inventory.map((item) => <option key={item.id} value={item.id}>{toPersianDigits(item.code)} · {item.name}</option>)}
      </select>
    </label> : null}
    {existing ? <p className="mt-2 text-xs font-bold text-accent">سند {toPersianDigits(existing.documentNumber)}: {STATE_LABEL[existing.state] || existing.state}{existing.state === 'approved' ? '' : ' — برای تأیید به «کنترل اسناد» برو.'}</p> : null}
    {blockers.length ? <ul className="mt-2 space-y-1 rounded-lg border border-expense/40 bg-expense/5 p-2 text-[12px] leading-6 text-expense">
      {blockers.map((item) => <li key={item.code}>{toPersianDigits(item.message)}</li>)}
    </ul> : null}
    {plan.notes.length ? <ul className="mt-2 space-y-1 text-[12px] leading-6 text-muted">{plan.notes.map((text) => <li key={text}>• {toPersianDigits(text)}</li>)}</ul> : null}
    {existing?.state !== 'approved' ? <button type="button" disabled={busy || !plan.ready} onClick={propose}
      className="tap mt-3 rounded-lg bg-accent px-4 text-sm font-bold text-on-fill disabled:opacity-40 hover:bg-accent/90">
      {busy ? 'در حال ساخت…' : existing ? 'بازسازی پیشنهاد سند' : 'ساخت سند منتظر کنترل'}
    </button> : null}
  </div>;
}
