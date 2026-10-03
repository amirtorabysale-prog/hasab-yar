import { useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, persianDate } from '../../lib/format.js';

export function ReviewAssistant({item,ai,setAi,onSaved,notify,busy}) {
  const [open,setOpen] = useState(false), [loading,setLoading] = useState(false), [error,setError] = useState('');
  const [message,setMessage] = useState(''), [history,setHistory] = useState([]), [contacts,setContacts] = useState([]), [accounts,setAccounts] = useState([]);
  const [facts,setFacts] = useState({});
  const loadChoices = async () => {
    const [people,banks] = await Promise.all([api.contacts(),api.accounts()]);
    setContacts(people.items || []);setAccounts((banks.items || []).filter(a=>a.active));
  };
  const analyze = async () => {
    setLoading(true);setError('');
    try {
      const result = await api.reviewAiProposal(item.id,{message,facts});
      setAi(result.proposal);setHistory(result.proposal.conversation || []);setMessage('');setFacts(result.proposal.context || {});
      if (result.proposal.postingBlockers?.length) {await loadChoices();setOpen(true);}
    } catch(e) {setError(e.message);}
    finally {setLoading(false);}
  };
  const toggle = async () => {
    if(open) {setOpen(false);return;}
    setLoading(true);setError('');
    try {
      const [conversation,people,banks] = await Promise.all([api.reviewAiConversation(item.id),api.contacts(),api.accounts()]);
      setHistory(conversation.messages || []);setContacts(people.items || []);setAccounts((banks.items || []).filter(a=>a.active));
      setFacts(conversation.proposal?.context || conversation.context || {});setOpen(true);
    } catch(e) {setError(e.message);}
    finally {setLoading(false);}
  };
  const feedback = async accepted => {
    const reason = accepted ? '' : window.prompt('دلیل رد و روش درست از نظر شما چیست؟ (حداقل ۸ نویسه)');
    if(!accepted && !reason?.trim()) return;
    setLoading(true);setError('');
    try {
      const result = await api.reviewAiFeedback(item.id,ai.id,accepted,reason || '');
      if(accepted) {notify('سند ثبت شد؛ این تأیید با نام حسابدار در DNA شرکت ذخیره شد.');await onSaved();}
      else {setAi(result.proposal);setHistory((await api.reviewAiConversation(item.id)).messages);notify('دلیل رد ذخیره شد؛ برای اصلاح با دستیار گفت‌وگو کن.');}
    } catch(e) {setError(e.message);}
    finally {setLoading(false);}
  };
  const textOf = entry => {
    if(entry.speaker!=='assistant') return entry.body;
    try {const p=JSON.parse(entry.body);return [p.summary,p.explanation,...(p.missingFacts || [])].filter(Boolean).join(' — ');} catch{return entry.body;}
  };
  return <section className="mt-3 rounded-lg border border-accent/30 bg-paper p-3 text-xs leading-6">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <b>دستیار حسابدار و DNA شرکت</b>
      <div className="flex gap-2">
        {(!ai || ai.state==='rejected' || !ai.canPost) && <button disabled={loading || busy} onClick={analyze} className="tap rounded border border-accent px-3 text-accent disabled:opacity-40">{loading?'در حال تحلیل…':'تحلیل کن'}</button>}
        <button disabled={loading} onClick={toggle} className="tap rounded border border-line px-3">{open?'بستن گفت‌وگو':'گفت‌وگو و تکمیل اطلاعات'}</button>
      </div>
    </div>
    {!ai && item.dnaMatches?.length>0 && <div className="mt-2 rounded bg-accent/5 p-2"><b>DNA شرکت {item.dnaMatches.length} تجربهٔ مشابه پیدا کرده است.</b>{item.dnaMatches.map(d=><p key={d.id}>{d.summary} · {d.actorName || d.actor} · {persianDate(d.date)} — {d.reason || 'تأیید قبلی'}</p>)}<p>با «تحلیل کن» تطبیق رویداد تازه را درخواست کن؛ تجربهٔ قبلی مجوز ثبت خودکار نیست.</p></div>}
    {ai?.state==='proposed' && <>
      <p className="mt-2 font-bold">{ai.summary}</p><p className="text-muted">{ai.explanation}</p>
      {ai.dnaEvidence?.length > 0 && <div className="my-2 rounded border border-accent/30 bg-accent/5 p-2">
        <b>این پیشنهاد با توجه به تجربه‌های DNA همین شرکت تهیه شده؛ ثبت فقط با اجازهٔ شماست.</b>
        {ai.dnaEvidence.map(d=><p key={d.id}>{d.state==='accepted'?'تجربهٔ تأییدشده':'اصلاح قبلی'}: {d.summary} — {d.reason || 'تأیید حسابدار'} · {persianDate(d.date)} · حسابدار {d.actorName || d.actor || 'ثبت‌نشده'}{d.journalEntryId && ` · سند ${d.journalEntryId}`}</p>)}
      </div>}
      {ai.lines?.length>0 && <div className="mt-2 overflow-x-auto"><table className="w-full text-right"><thead><tr className="border-b border-line"><th>حساب پیشنهادی</th><th>بدهکار (تومان)</th><th>بستانکار (تومان)</th></tr></thead><tbody>{ai.lines.map((l,i)=><tr key={i} className="border-b border-line"><td>{l.accountCode} {l.accountName || l.key || l.role}{l.newAccount && <p className="text-accent">ساخت همراه سند · {l.newAccount.type==='asset'?'دارایی':l.newAccount.type==='liability'?'بدهی':l.newAccount.type==='expense'?'هزینه':l.newAccount.type==='income'?'درآمد':'سرمایه'} · {l.newAccount.normalSide==='debit'?'ماهیت بدهکار':'ماهیت بستانکار'}{l.newAccount.chartCode && ` · معین ${l.newAccount.chartCode} ${l.newAccount.chartName}`}</p>}</td><td className="numbers">{l.debit?formatAmount(l.debit):'—'}</td><td className="numbers">{l.credit?formatAmount(l.credit):'—'}</td></tr>)}</tbody></table></div>}
      {(ai.postingBlockers || ai.missingFacts || []).map((q,i)=><p key={i} className="mt-1 text-expense">• {q}</p>)}
      <p className="mt-2 text-muted">با تأیید شما سند، اثرهای عملیاتی پشتیبانی‌شده و ردپای تصمیم حسابدار با هم ثبت می‌شوند.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button disabled={loading || busy || !ai.canPost} onClick={()=>feedback(true)} className="tap rounded bg-accent px-3 font-bold text-white disabled:opacity-40">{ai.lines?.some(l=>l.newAccount)?'تأیید ساخت حساب و ثبت سند':'تأیید و اعمال سند'}</button>
        <button disabled={loading || busy} onClick={()=>feedback(false)} className="tap rounded border border-expense px-3 text-expense">رد با دلیل</button>
        {!ai.canPost && <button disabled={loading} onClick={()=>open?null:toggle()} className="tap rounded border border-accent px-3 text-accent">پاسخ به ابهام و اصلاح پیشنهاد</button>}
      </div>
    </>}
    {ai?.state==='rejected' && <p>دلیل رد: {ai.reason}</p>}
    {open && <div className="mt-3 space-y-2 border-t border-line pt-3">
      <p>نکته یا پاسخ سؤال را بنویس. AI پیشنهاد تازه می‌دهد و برای ثبت نهایی از شما اجازه می‌گیرد.</p>
      <div className="max-h-72 space-y-2 overflow-y-auto" aria-label="تاریخچه گفت‌وگوی حسابدار">{(history.length?history:ai?.conversation || []).map(h=><div key={h.id} className={`rounded p-2 ${h.speaker==='assistant'?'bg-surface':'bg-accent/5'}`}><b>{h.speaker==='assistant'?'دستیار':h.speaker==='accepted'?'تأیید سند':h.speaker==='rejected'?'رد با دلیل':'حسابدار'}</b> · {h.actorName || h.actor || ''} · {persianDate(h.createdAt)}<p className="whitespace-pre-wrap">{textOf(h)}</p></div>)}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label>تاریخ رویداد<input type="date" value={facts.occurredAt || ''} onChange={e=>setFacts({...facts,occurredAt:e.target.value})} className="block w-full rounded border border-line p-2" /></label>
        {ai?.lines?.some(l=>['cheque-payable','cheque-receivable'].includes(l.role)) && <label>سررسید چک<input type="date" value={facts.dueAt || ''} onChange={e=>setFacts({...facts,dueAt:e.target.value})} className="block w-full rounded border border-line p-2" /></label>}
        <label>طرف حساب<select value={facts.counterpartyId || ''} onChange={e=>setFacts({...facts,counterpartyId:e.target.value})} className="block w-full rounded border border-line p-2"><option value="">انتخاب شخص</option>{contacts.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {ai?.lines?.some(l=>l.role==='cash') && <label>بانک یا صندوق<select value={facts.accountId || ''} onChange={e=>setFacts({...facts,accountId:e.target.value})} className="block w-full rounded border border-line p-2"><option value="">انتخاب حساب</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
      </div>
      <textarea aria-label="پیام حسابدار به AI" rows={3} value={message} onChange={e=>setMessage(e.target.value)} maxLength={2000} placeholder="مثلاً کالا برای انبار است، هزینه نیست؛ سررسید و شخص را بالا انتخاب کردم…" className="w-full rounded border border-line p-2" />
      <button disabled={loading || busy || (!message.trim() && !Object.keys(facts).length)} onClick={analyze} className="tap rounded border border-accent px-3 text-accent disabled:opacity-40">{loading?'در حال بررسی…':'ارسال و بازبینی پیشنهاد'}</button>
    </div>}
    {error && <p role="alert" className="mt-2 text-expense">{error}</p>}
  </section>;
}
