import { useEffect, useState } from 'react';
import { COUNTERPARTY_PROMPT_EVENT } from '../../lib/counterpartyPrompt.js';

/**
 * برگهٔ «این همان طرف حساب است؟»
 *
 * یک بار در ریشهٔ برنامه نصب می‌شود و به هر پرسشی که از هر جای برنامه بیاید
 * جواب می‌دهد.
 *
 * هر دو گزینه هم‌وزن نشان داده می‌شوند و هیچ‌کدام پیش‌فرض نیست: اشتباه در هر
 * سمت گران است — ادغام اشتباه طلب دو نفر را یکی می‌کند، جدا کردن اشتباه ماندهٔ
 * یک نفر را دو تکه.
 */
export default function CounterpartyMatchSheet() {
  const [pending, setPending] = useState(null);

  useEffect(() => {
    const open = (event) => setPending(event.detail);
    window.addEventListener(COUNTERPARTY_PROMPT_EVENT, open);
    return () => window.removeEventListener(COUNTERPARTY_PROMPT_EVENT, open);
  }, []);

  if (!pending) return null;
  const { details = {}, resolve } = pending;
  const answer = (resolution) => { setPending(null); resolve(resolution); };

  return <div className="fixed inset-0 z-[90] flex items-end justify-center bg-ink/40 backdrop-blur-[2px]"
    onMouseDown={(event) => { if (event.target === event.currentTarget) answer(null); }}>
    <section role="dialog" aria-modal="true" aria-label="تأیید طرف حساب"
      className="sheet-in w-full max-w-[560px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl">
      <div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" />
      <span className="rounded-full bg-warn-bg px-2 py-1 text-[10px] font-extrabold text-accent">طرف حساب مشابه</span>
      <h2 className="mt-3 text-xl font-extrabold">این همان طرف حساب است؟</h2>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-[10px] border border-line bg-surface p-3">
          <span className="text-[10px] font-bold text-muted">نام این ثبت</span>
          <b className="mt-2 block text-[15px]">{details.input}</b>
        </div>
        <div className="rounded-[10px] border border-accent/30 bg-warn-bg p-3">
          <span className="text-[10px] font-bold text-muted">طرف حساب موجود</span>
          <b className="mt-2 block text-[15px]">{details.existing?.name}</b>
        </div>
      </div>
      <p className="mt-3 text-[12px] leading-6 text-muted">
        اگر یکی‌اند، این ثبت روی همان طرف حساب می‌نشیند و مانده‌اش یکجا دیده می‌شود.
        اگر دو شخص یا شرکت متفاوت‌اند، طرف حساب تازه ساخته می‌شود.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button onClick={() => answer('merge')} className="tap rounded-lg border border-accent bg-accent/5 font-extrabold text-accent">بله، همان است</button>
        <button onClick={() => answer('separate')} className="tap rounded-lg border border-line bg-surface font-extrabold">نه، جداست</button>
      </div>
      <button onClick={() => answer(null)} className="tap mt-2 w-full text-sm text-muted">لغو ثبت</button>
    </section>
  </div>;
}
