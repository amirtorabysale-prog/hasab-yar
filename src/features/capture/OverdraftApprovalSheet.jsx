import { useState } from 'react';
import { formatAmount, toPersianDigits } from '../../lib/format.js';

/**
 * «این ثبت صندوق یا بانک را منفی می‌کند» (یا کالا را، یا سندی را که به پارسیان
 * رفته عوض می‌کند) — تأیید حسابدار با دلیل.
 *
 * از هر جای برنامه باز می‌شود (ثبت صوتی، تسویه، انتقال، فاکتور، …) چون سرور همهٔ
 * عملیات را یک‌جا می‌سنجد. بدون دلیل نوشته‌شده تأیید نمی‌شود؛ دلیل با سند می‌ماند.
 * کاربری که نقش تأیید ندارد، فقط می‌بیند چرا ثبت انجام نشد.
 */
const negative = (value) => `${value < 0 ? '−' : ''}${formatAmount(Math.abs(value))}`;
const quantity = (value) => `${value < 0 ? '−' : ''}${toPersianDigits(Math.abs(value))}`;

const COPY = {
  cash: {
    badge: 'موجودی منفی می‌شود', title: 'این ثبت موجودی را منفی می‌کند',
    why: 'ماندهٔ منفیِ صندوق یا بانک معمولاً یعنی دریافتی که ثبت نشده، حساب یا مبلغ اشتباه، یا اضافه‌برداشت واقعی بانک.',
    placeholder: 'مثلاً: دریافت دیروز هنوز ثبت نشده / اضافه‌برداشت مصوب بانک',
  },
  stock: {
    badge: 'کالا بیش از موجودی', title: 'این خروج، موجودی کالا را منفی می‌کند',
    why: 'موجودی منفی کالا معمولاً یعنی خریدی که هنوز ثبت نشده، شمارش اشتباه انبار یا کالای اشتباه در فاکتور.',
    placeholder: 'مثلاً: فاکتور خرید این کالا فردا ثبت می‌شود',
  },
  export: {
    badge: 'سند رفته به پارسیان', title: 'این سند قبلاً به پارسیان رفته است',
    why: 'اصلاح یا حذف آن با سند اصلاحیه انجام می‌شود و حسابدار باید همان اصلاحیه را در پارسیان هم وارد کند تا دو دفتر یکی بمانند.',
    placeholder: 'مثلاً: مبلغ کارمزد اشتباه بود؛ اصلاحیه در پارسیان هم وارد می‌شود',
  },
};

/**
 * `mode === 'request'`: دفتر تأییدکنندهٔ دیگری دارد و ثبت‌کننده نمی‌تواند کار
 * خودش را تأیید کند؛ درخواست به صف حسابدار می‌رود.
 */
export function OverdraftApprovalSheet({ prompt, canApprove, close }) {
  const [reason, setReason] = useState('');
  const kind = COPY[prompt.kind] ? prompt.kind : 'cash';
  const copy = COPY[kind];
  const queue = prompt.mode === 'request';
  const inline = canApprove && !queue;
  const ready = reason.trim().length >= 3;
  return <div className="fixed inset-0 z-[90] flex items-end justify-center bg-scrim/40 backdrop-blur-[2px] sm:items-center">
    <section role="alertdialog" aria-modal="true" aria-label={copy.title} className="sheet-in w-full max-w-[560px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl sm:rounded-2xl">
      <span className="rounded-full bg-expense/10 px-2 py-1 text-xs font-extrabold text-expense">{copy.badge}</span>
      <h2 className="mt-3 text-lg font-extrabold">{copy.title}</h2>
      <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-surface text-[13px]">
        {prompt.accounts.map((item) => <li key={item.accountId} className="flex items-center justify-between gap-3 px-3 py-2">
          <b>{item.name}</b>
          {kind === 'export'
            ? <span className="truncate text-xs text-muted">{item.fileName}</span>
            : <span className="numbers">{(kind === 'stock' ? quantity : negative)(item.before)} <span className="text-muted">←</span> <b className="text-expense">{(kind === 'stock' ? quantity : negative)(item.after)}</b>{kind === 'stock' && item.unit ? ` ${item.unit}` : ''}</span>}
        </li>)}
      </ul>
      <p className="mt-3 text-[12px] leading-6 text-muted">{copy.why} هیچ چیزی ثبت نشده است.</p>
      {inline && <>
        <label className="mt-3 block text-[12px] font-bold" htmlFor="overdraft-reason">دلیل تأیید حسابدار</label>
        <textarea id="overdraft-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={2}
          placeholder={copy.placeholder} className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px]" />
      </>}
      {queue && <>
        <p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-[12px] leading-6 text-accent">در این دفتر حسابدار یا مدیر دیگری هست؛ ثبت‌کننده کار خودش را تأیید نمی‌کند. درخواست با همین جزئیات برای او فرستاده می‌شود و پس از تأیید اجرا می‌شود.</p>
        <label className="mt-3 block text-[12px] font-bold" htmlFor="overdraft-reason">توضیح برای حسابدار</label>
        <textarea id="overdraft-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={2}
          placeholder={copy.placeholder} className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px]" />
      </>}
      {!inline && !queue && <p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-[12px] text-accent">این تأیید با حسابدار یا مدیر دفتر است؛ از او بخواه یا اول ثبت جاافتاده را بزن.</p>}
      <div className="mt-4 grid grid-cols-[2fr_1fr] gap-2">
        {inline && <button disabled={!ready} onClick={() => close(reason.trim())} className="tap rounded-lg bg-expense font-extrabold text-on-fill disabled:opacity-40 hover:bg-expense/90">تأیید حسابدار و ثبت</button>}
        {queue && <button onClick={() => close({ requestNote: reason.trim() })} className="tap rounded-lg bg-accent font-extrabold text-on-fill hover:bg-accent/90 active:bg-accent/80">ارسال برای تأیید حسابدار</button>}
        <button onClick={() => close(null)} className={`tap rounded-lg border border-line bg-surface font-bold ${inline || queue ? '' : 'col-span-2'} hover:bg-paper hover:text-ink`}>انصراف — ثبت نشود</button>
      </div>
    </section>
  </div>;
}
