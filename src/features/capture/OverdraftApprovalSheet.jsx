import { useState } from 'react';
import { formatAmount } from '../../lib/format.js';

/**
 * «این ثبت صندوق یا بانک را منفی می‌کند» — تأیید حسابدار با دلیل.
 *
 * از هر جای برنامه باز می‌شود (ثبت صوتی، تسویه، انتقال، فاکتور، …) چون سرور همهٔ
 * عملیات را یک‌جا می‌سنجد. بدون دلیل نوشته‌شده تأیید نمی‌شود؛ دلیل با سند می‌ماند.
 * کاربری که نقش تأیید ندارد، فقط می‌بیند چرا ثبت انجام نشد.
 */
const negative = (value) => `${value < 0 ? '−' : ''}${formatAmount(Math.abs(value))}`;

export function OverdraftApprovalSheet({ prompt, canApprove, close }) {
  const [reason, setReason] = useState('');
  const ready = reason.trim().length >= 3;
  return <div className="fixed inset-0 z-[90] flex items-end justify-center bg-ink/40 backdrop-blur-[2px] sm:items-center">
    <section role="alertdialog" aria-modal="true" aria-label="تأیید منفی شدن موجودی" className="sheet-in w-full max-w-[560px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl sm:rounded-2xl">
      <span className="rounded-full bg-expense/10 px-2 py-1 text-[10px] font-extrabold text-expense">موجودی منفی می‌شود</span>
      <h2 className="mt-3 text-lg font-extrabold">این ثبت موجودی را منفی می‌کند</h2>
      <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-surface text-[13px]">
        {prompt.accounts.map((item) => <li key={item.accountId} className="flex items-center justify-between gap-3 px-3 py-2">
          <b>{item.name}</b>
          <span className="numbers">{negative(item.before)} <span className="text-muted">←</span> <b className="text-expense">{negative(item.after)}</b></span>
        </li>)}
      </ul>
      <p className="mt-3 text-[12px] leading-6 text-muted">
        ماندهٔ منفیِ صندوق یا بانک معمولاً یعنی دریافتی که ثبت نشده، حساب یا مبلغ اشتباه، یا اضافه‌برداشت واقعی بانک.
        هیچ چیزی ثبت نشده است. اگر واقعاً چنین است، حسابدار با دلیل تأیید می‌کند.
      </p>
      {canApprove ? <>
        <label className="mt-3 block text-[12px] font-bold" htmlFor="overdraft-reason">دلیل تأیید حسابدار</label>
        <textarea id="overdraft-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={2}
          placeholder="مثلاً: دریافت دیروز هنوز ثبت نشده / اضافه‌برداشت مصوب بانک"
          className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px]" />
      </> : <p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-[12px] text-accent">تأیید منفی شدن موجودی با حسابدار یا مدیر دفتر است؛ از او بخواه یا اول دریافتی جاافتاده را ثبت کن.</p>}
      <div className="mt-4 grid grid-cols-[2fr_1fr] gap-2">
        {canApprove && <button disabled={!ready} onClick={() => close(reason.trim())} className="tap rounded-lg bg-expense font-extrabold text-white disabled:opacity-40">تأیید حسابدار و ثبت</button>}
        <button onClick={() => close(null)} className={`tap rounded-lg border border-line bg-surface font-bold ${canApprove ? '' : 'col-span-2'}`}>انصراف — ثبت نشود</button>
      </div>
    </section>
  </div>;
}
