import {useState} from 'react';
import {api} from '../../lib/api.js';
import {formatAmount} from '../../lib/format.js';

export function ReviewPriorBasis({item,ai,onPrepared,notify,busy}) {
  const [open,setOpen]=useState(false),[amount,setAmount]=useState(''),[date,setDate]=useState(''),[reference,setReference]=useState(''),[confirmed,setConfirmed]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const basis=ai?.priorBasis;
  if(!basis) return null;
  const submit=async()=>{
    setLoading(true);setError('');
    try {
      const result=await api.reviewPriorBasis(item.id,{proposalId:ai.id,amount:Number(amount),occurredAt:date,reference,confirmed});
      notify(`سند مبنا ${result.journal.fiscalYear}/${result.journal.documentNumber} ثبت شد؛ پرداخت یا وصول هنوز به تأیید جداگانه نیاز دارد.`);
      const refreshed=await api.reviewAiProposal(item.id,{});
      onPrepared(refreshed.proposal);
    } catch(e) {setError(e.message);}
    finally {setLoading(false);}
  };
  return <div className="mt-3 rounded border border-line p-3" aria-label="تکمیل سند مبنا">
    <b>مانده قبلی این پرونده در دفتر ثبت نشده است</b>
    <p>اگر سند قبلی موجود است، آن را بررسی کنید. فقط برای مانده‌ای که واقعاً از دفتر قبلی منتقل شده، مدیر دفتر می‌تواند سند مبنا بسازد.</p>
    <button disabled={loading || busy} onClick={()=>setOpen(!open)} className="tap mt-2 rounded border border-accent px-3 text-accent">{open?'بستن ورود مانده':'ثبت مانده مستند منتقل‌شده'}</button>
    {open && <div className="mt-2 space-y-2">
      <p>این اقدام سند جداگانه با اثر بر سرمایه افتتاحیه می‌سازد؛ پرداخت/وصول را ثبت نمی‌کند و مانده فرضی مجاز نیست.</p>
      <label className="block">مانده واقعی پیش از رویداد (تومان)<input aria-label="مانده مستند پیش از رویداد" type="number" min={basis.amount} step="1" value={amount} onChange={e=>setAmount(e.target.value)} className="block w-full rounded border border-line p-2" /></label>
      {basis.ledgerStart && basis.latestDate===basis.ledgerStart && <p className="text-muted">ثبت در این دفتر از {basis.ledgerStart} شروع شده؛ مانده‌ای که بعد از آن ایجاد شده منتقل‌شده نیست و سند خرید یا فروش اصلی خودش را می‌خواهد.</p>}
      <label className="block">تاریخ مانده، پیش از شروع ثبت در این دفتر<input aria-label="تاریخ مانده منتقل‌شده" type="date" max={basis.latestDate} value={date} onChange={e=>setDate(e.target.value)} className="block w-full rounded border border-line p-2" /></label>
      <label className="block">مرجع مستند دفتر قبلی<textarea aria-label="مرجع مستند مانده منتقل‌شده" value={reference} maxLength={300} onChange={e=>setReference(e.target.value)} className="block w-full rounded border border-line p-2" /></label>
      <p>بدهکار: {basis.debit} · {formatAmount(Number(amount) || 0)} تومان</p><p>بستانکار: {basis.credit} · {formatAmount(Number(amount) || 0)} تومان</p>
      <label className="block"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} /> تأیید می‌کنم این مانده واقعی و مستند است و قبلاً در همین دفتر ثبت نشده است.</label>
      <button disabled={busy || loading || !confirmed || !date || reference.trim().length<8 || !Number.isSafeInteger(Number(amount)) || Number(amount)<basis.amount} onClick={submit} className="tap rounded bg-accent px-3 text-white disabled:opacity-40">{loading?'در حال ثبت مبنا و بازبینی…':'تأیید مانده منتقل‌شده و ثبت سند مبنا'}</button>
    </div>}
    {error && <p role="alert" className="text-expense">{error}</p>}
  </div>;
}
