import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, persianDate, toPersianDigits } from '../../lib/format.js';

/**
 * پیشنهادهای ارتقای برچسب موضوعی — طرح ترکیبی مالک محصول.
 *
 * پیش‌فرض سیستم «برچسب» است نه «دستهٔ جدید»: موضوع هر ثبت تفصیلی می‌ماند و
 * کدینگ دست‌نخورده است. وقتی برچسبی در ماه به آستانهٔ تکرار رسید، سیستم این‌جا
 * می‌پرسد: دستهٔ مستقل بسازیم؟ تأیید یعنی دسته + معین کدینگ + **انتقال
 * ثبت‌های قبلیِ همان برچسب** + یادگیری واژه — همه یک‌جا، همه با نام و کدِ
 * قابل ویرایش. رد یعنی همین برچسب بماند و دیگر پرسیده نشود.
 */

function PromotionCard({ promotion, notify, onDecided }) {
  const [name, setName] = useState(promotion.categoryName || promotion.label);
  const [code, setCode] = useState(promotion.suggestedCode || '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (decision) => {
    setBusy(true);
    try {
      const result = await api.decideTopicPromotion(promotion.id, { decision, reason: reason.trim(), categoryName: name, chartCode: code });
      notify(decision === 'approve'
        ? `دستهٔ «${result.item.categoryName}» ساخته شد${result.item.migratedLines ? ` و ${toPersianDigits(result.item.migratedLines)} سطر قبلی منتقل شد` : ''}${result.item.keptLockedLines ? `؛ ${toPersianDigits(result.item.keptLockedLines)} سطر در دورهٔ بسته سر جایش ماند` : ''}.`
        : 'برچسب دسته نشد و دیگر پرسیده نمی‌شود.');
      onDecided();
    } catch (error) { notify(error.message); }
    setBusy(false);
  };
  return <article className="rounded-xl border border-accent/40 bg-accent/5 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[13px] font-extrabold">برچسب «{promotion.label}» این ماه <span className="numbers">{toPersianDigits(promotion.occurrences)}</span> بار ثبت شده است</p>
      <span className="rounded-full border border-accent/40 bg-surface px-2 py-0.5 text-[11px] font-bold text-accent">آستانه: <span className="numbers">{toPersianDigits(promotion.threshold)}</span></span>
    </div>
    <p className="mt-1 text-xs leading-6 text-muted">دستهٔ مستقل بسازیم؟ با تأیید، دسته و معین کدینگ ساخته می‌شود، <b className="text-ink">{toPersianDigits(promotion.migrationCount)} سطر قبلیِ همین برچسب</b> به دستهٔ تازه منتقل می‌شود و واژه یاد گرفته می‌شود. مبالغ و توازن سندها عوض نمی‌شود.{promotion.lockedLineCount > 0 && <> <b className="text-ink">{toPersianDigits(promotion.lockedLineCount)} سطر</b> در دورهٔ بسته است و جابه‌جا نمی‌شود.</>}</p>
    {promotion.samples?.length > 0 && <ul className="mt-2 space-y-1 rounded-lg border border-line bg-surface p-2 text-[11px] leading-5 text-muted">
      {promotion.samples.map((sample) => <li key={sample.entryId} className="truncate">
        {persianDate(sample.occurredAt)} · <span className="numbers">{formatAmount(sample.amount)}</span> تومان · {sample.accountName}{sample.memo ? ` · ${sample.memo.slice(0, 40)}` : ''}
      </li>)}
      {promotion.occurrences > promotion.samples.length && <li>… و <span className="numbers">{toPersianDigits(promotion.occurrences - promotion.samples.length)}</span> سطر دیگر</li>}
    </ul>}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input value={name} onChange={(event) => setName(event.target.value)} aria-label="نام دستهٔ جدید" className="min-w-0 flex-1 rounded border border-line bg-paper p-2 text-[13px]" placeholder="نام دستهٔ جدید" />
      <input value={code} onChange={(event) => setCode(event.target.value)} aria-label="کد معین کدینگ" inputMode="numeric" className="w-24 rounded border border-line bg-paper p-2 text-[13px] numbers" placeholder="کد معین" />
    </div>
    <input value={reason} onChange={(event) => setReason(event.target.value)} aria-label="دلیل تصمیم" className="mt-2 w-full rounded border border-line bg-paper p-2 text-[13px]" placeholder="دلیل تصمیم (با سند می‌ماند)" />
    <div className="mt-2 flex gap-2">
      <button disabled={busy || reason.trim().length < 3 || !name.trim()} onClick={() => decide('approve')} className="tap rounded bg-accent px-3 py-1.5 text-[12px] font-bold text-on-fill disabled:opacity-40">تأیید و ساخت دسته + انتقال ثبت‌ها</button>
      <button disabled={busy || reason.trim().length < 3} onClick={() => decide('reject')} className="tap rounded border border-expense/50 px-3 py-1.5 text-[12px] font-bold text-expense disabled:opacity-40">همین برچسب بماند</button>
    </div>
  </article>;
}

export function TopicPromotionsCard({ notify, onChanged }) {
  const [data, setData] = useState(null);
  const [thresholdDraft, setThresholdDraft] = useState('');
  // نقش در سرور کنترل می‌شود؛ تصمیم ارتقا فقط با مدیر و بالاتر می‌نشیند.
  useEffect(() => {
    api.topicsOverview().then((result) => { setData(result); setThresholdDraft(String(result.threshold || '')); }).catch(() => setData({ labels: [], promotions: [], threshold: 3 }));
  }, []);
  const reload = async () => {
    try { const result = await api.topicsOverview(); setData(result); setThresholdDraft(String(result.threshold || '')); } catch (error) { notify(error.message); }
    await onChanged?.();
  };
  if (!data) return null;
  const pending = (data.promotions || []).filter((item) => item.status === 'pending');
  const decided = (data.promotions || []).filter((item) => item.status !== 'pending');
  const labeled = (data.labels || []).filter((label) => label.current > 0 || label.previous > 0);
  if (!pending.length && !decided.length && !labeled.length) return null;
  const saveThreshold = async () => {
    const value = Number(String(thresholdDraft).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[^\d]/g, ''));
    try { await api.saveTopicThreshold(value); notify('آستانهٔ ارتقا ثبت شد.'); await reload(); }
    catch (error) { notify(error.message); }
  };
  return <section aria-label="برچسب‌های موضوعی و پیشنهاد ارتقا" className="mt-4 space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-extrabold">برچسب‌های موضوعی</h2>
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <span>آستانهٔ ارتقا (تکرار در ماه):</span>
        <input value={thresholdDraft} onChange={(event) => setThresholdDraft(event.target.value)} inputMode="numeric" aria-label="آستانهٔ ارتقا" className="numbers w-14 rounded border border-line bg-paper px-2 py-1 text-center text-[12px]" />
        <button onClick={saveThreshold} className="tap rounded border border-line bg-surface px-2 py-1 font-bold">ثبت</button>
      </div>
    </div>
    {labeled.length > 0 && <p className="rounded-lg border border-line bg-surface p-2.5 text-xs leading-6 text-muted">
      برچسب، تفصیلیِ «بابت چه بود؟» است و کدینگ را عوض نمی‌کند: {' '}
      {labeled.slice(0, 6).map((label) => `${label.name} (${toPersianDigits(label.current)})`).join(' · ')}
      {labeled.length > 6 ? ' …' : ''}
    </p>}
    {pending.map((promotion) => <PromotionCard key={promotion.id} promotion={promotion} notify={notify} onDecided={reload} />)}
    {decided.length > 0 && <details className="rounded-lg border border-line bg-surface p-2.5 text-xs leading-6">
      <summary className="cursor-pointer font-bold text-muted">تصمیم‌های قبلی (<span className="numbers">{toPersianDigits(decided.length)}</span>)</summary>
      <ul className="mt-1.5 space-y-1 text-muted">
        {decided.map((item) => <li key={item.id}>
          «{item.label}» → {item.status === 'approved' ? <>دستهٔ «{item.categoryName}» ({item.chartCode ? <>کد <span className="numbers">{item.chartCode}</span></> : 'بی‌معین؛ کدینگ هنوز نصب نیست'}{item.migratedLines ? `، ${toPersianDigits(item.migratedLines)} سطر منتقل شد` : ''})</> : 'دسته نشد'}
          {item.decisionReason ? ` — ${item.decisionReason}` : ''}
        </li>)}
      </ul>
    </details>}
  </section>;
}
