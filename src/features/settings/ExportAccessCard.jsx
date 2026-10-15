import { useState } from 'react';
import { api } from '../../lib/api.js';

/**
 * «خروجی پارسیان کجاست؟» — با جواب دقیق برای همین کاربر و همین دفتر.
 *
 * خروجی به سه شرط بسته است: دفتر «کسب‌وکار» باشد، کاربر در محیط حرفه‌ای باشد، و
 * نقشش دست‌کم حسابدار. وقتی یکی برقرار نبود، صفحه‌اش بی‌صدا از منو غایب می‌شد و
 * کاربر فقط می‌دید «بخشی نیست» — بی‌آنکه بداند کدام شرط و چه باید بکند.
 *
 * هر حالت همان راه‌حل خودش را نشان می‌دهد، و اگر کاری از خود کاربر برمی‌آید، همان
 * دکمه را.
 */
export default function ExportAccessCard({ access, navigate, refreshAccess, notify }) {
  const [busy, setBusy] = useState(false);
  const role = access.workspace?.role || 'viewer';
  const profileType = access.workspace?.profileType || 'business';
  const available = (access.screens || []).some((screen) => screen.id === 'collaboration');

  const goProfessional = async () => {
    setBusy(true);
    try { await api.setExperience('professional'); await refreshAccess(); notify('محیط حرفه‌ای فعال شد.'); }
    catch (error) { notify(error.message); }
    setBusy(false);
  };

  let tone = 'border-accent/40 bg-warn-bg';
  let title;
  let body;
  let action = null;

  if (available) {
    tone = 'border-income/30 bg-income/5';
    title = 'خروجی پارسیان در دسترس است';
    body = 'منو ← «همکاری حسابدار» ← برگهٔ «تحویل به حسابدار» ← در «مقصد خروجی» گزینهٔ «پارسیان».';
    action = <button onClick={() => navigate('collaboration')} className="tap shrink-0 rounded-lg bg-accent px-4 text-[13px] font-extrabold text-on-fill">رفتن به خروجی</button>;
  } else if (profileType !== 'business') {
    title = 'این دفتر «حساب شخصی» است';
    body = ['owner', 'manager'].includes(role)
      ? 'خروجی پارسیان فقط برای دفتر کسب‌وکار ساخته می‌شود. در همین صفحه نوع دفتر را «کسب‌وکار» کن و «ذخیره تنظیمات» را بزن.'
      : 'خروجی پارسیان فقط برای دفتر کسب‌وکار ساخته می‌شود و تغییر نوع دفتر با مالک یا مدیر است.';
  } else if (role === 'viewer') {
    title = 'نقش تو «فقط مشاهده» است';
    body = 'خروجی پارسیان کار حسابدار است. از مالک دفتر بخواه در «دفترها و دسترسی تیم» نقشت را «حسابدار» یا «مدیر» کند.';
  } else if (access.experience !== 'professional' && role === 'owner') {
    title = 'در محیط ساده هستی';
    body = 'خروجی پارسیان و ابزار حسابدار در محیط حرفه‌ای است. با رفتن به آن، «همکاری حسابدار» به منو اضافه می‌شود.';
    action = <button disabled={busy} onClick={goProfessional} className="tap shrink-0 rounded-lg bg-accent px-4 text-[13px] font-extrabold text-on-fill disabled:opacity-40">{busy ? 'در حال تغییر…' : 'رفتن به محیط حرفه‌ای'}</button>;
  } else {
    title = 'خروجی پارسیان برای این دسترسی باز نیست';
    body = 'از مالک دفتر بخواه دسترسی‌ات را بررسی کند.';
  }

  return <section className="mx-auto mt-5 max-w-[760px] px-4">
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-[10px] border p-4 ${tone}`}>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-extrabold text-muted">خروجی پارسیان</p>
        <p className="mt-1 text-[15px] font-extrabold">{title}</p>
        <p className="mt-1 text-[12px] leading-6 text-muted">{body}</p>
      </div>
      {action}
    </div>
  </section>;
}
