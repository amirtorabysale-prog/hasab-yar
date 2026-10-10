import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, persianDate, toPersianDigits } from '../../lib/format.js';

const KIND_LABEL = { cash: 'صندوق/بانک منفی', stock: 'کالا بیش از موجودی', export: 'اصلاح سند صادرشده' };
const STATUS_LABEL = { pending: 'منتظر تأیید', approved: 'تأییدشده — آمادهٔ اجرا', rejected: 'رد شد', executed: 'اجرا شد', cancelled: 'لغو شد' };

/**
 * صف تأیید دونفره.
 *
 * ثبت‌کننده‌ای که دفترش حسابدار یا مدیر دیگری دارد، منفی شدن صندوق، فروش بیش از
 * موجودی یا اصلاح سند رفته به پارسیان را خودش تأیید نمی‌کند؛ درخواستش این‌جا
 * می‌آید. نفر دوم با دلیل تأیید یا رد می‌کند و درخواستِ تأییدشده — با همان
 * جزئیاتی که فرستاده شد — یک بار اجرا می‌شود (هر دو نفر می‌توانند دکمهٔ اجرا را بزنند).
 */
export function ApprovalRequestsPanel({ canApprove, notify }) {
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(() => api.approvalRequests('open').then((result) => setItems(result.items || [])).catch(() => setItems([])), []);
  useEffect(() => { load(); }, [load]);

  const act = async (item, action) => {
    setBusy(item.id);
    try {
      if (action === 'approve' || action === 'reject') {
        const reason = window.prompt(action === 'approve' ? 'دلیل تأیید (با سند می‌ماند):' : 'دلیل رد درخواست:') || '';
        if (action === 'approve' && reason.trim().length < 3) { setBusy(''); return; }
        await api.decideApprovalRequest(item.id, { decision: action, reason });
        notify(action === 'approve' ? 'تأیید شد؛ حالا «اجرا» را بزن.' : 'درخواست رد شد.');
      } else if (action === 'execute') {
        await api.executeApprovalRequest(item);
        notify('درخواست تأییدشده اجرا و ثبت شد.');
      } else {
        await api.cancelApprovalRequest(item.id);
        notify('درخواست لغو شد.');
      }
      await load();
    } catch (error) { notify(error.message); }
    setBusy('');
  };

  if (!items?.length) return null;
  return <section className="mt-5 rounded-[10px] border border-accent/40 bg-surface p-4">
    <p className="font-bold">درخواست‌های تأیید <span className="numbers text-muted">({toPersianDigits(items.length)})</span></p>
    <div className="mt-3 divide-y divide-line">
      {items.map((item) => <article key={item.id} className="py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded border border-expense/40 px-2 py-0.5 text-[11px] font-bold text-expense">{KIND_LABEL[item.kind] || item.kind}</span>
          <span className="text-[11px] text-muted">{STATUS_LABEL[item.status]} · {persianDate(item.createdAt)}</span>
        </div>
        {item.message && <p className="mt-1 text-[12px] leading-6">{item.message}</p>}
        {item.items?.length > 0 && <ul className="mt-1 text-[11px] text-muted">
          {item.items.map((row) => <li key={row.accountId}>{row.name}{row.kind !== 'export' && Number.isFinite(row.after) && row.after !== 0 ? ` ← ${row.after < 0 ? '−' : ''}${formatAmount(Math.abs(row.after))}` : ''}</li>)}
        </ul>}
        {item.note && <p className="mt-1 text-[12px] text-muted">توضیح ثبت‌کننده: {item.note}</p>}
        {item.decisionReason && <p className="mt-1 text-[12px] text-income">دلیل تأیید: {item.decisionReason}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.status === 'pending' && canApprove && <>
            <button disabled={busy === item.id} onClick={() => act(item, 'approve')} className="tap rounded-lg bg-accent px-3 text-[12px] font-bold text-white">تأیید</button>
            <button disabled={busy === item.id} onClick={() => act(item, 'reject')} className="tap rounded-lg border border-expense/50 px-3 text-[12px] font-bold text-expense">رد</button>
          </>}
          {item.status === 'approved' && <button disabled={busy === item.id} onClick={() => act(item, 'execute')} className="tap rounded-lg bg-income px-3 text-[12px] font-bold text-white">اجرا</button>}
          <button disabled={busy === item.id} onClick={() => act(item, 'cancel')} className="tap rounded-lg border border-line px-3 text-[12px] font-bold">لغو</button>
        </div>
      </article>)}
    </div>
  </section>;
}
