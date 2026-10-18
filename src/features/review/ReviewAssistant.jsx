import {ReviewPriorBasis} from './ReviewPriorBasis.jsx';
import { reviewQuestions, reviewSavedAnswers } from '../../../shared/reviewQuestions.js';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { formatAmount, persianDate, toPersianDigits } from '../../lib/format.js';

/** برچسب فارسی نقش‌ها — همان واژه‌هایی که «فهم رویداد» هم به کاربر نشان می‌دهد. */
const ROLE_LABELS = {
  cash: 'بانک یا صندوق', receivable: 'طلب از مشتری', payable: 'بدهی به تأمین‌کننده', 'expense-category': 'هزینه', 'income-category': 'درآمد',
  'fixed-asset': 'دارایی ثابت', 'prepaid-asset': 'پیش‌پرداخت', 'refundable-deposit': 'ودیعه', 'loan-payable': 'وام پرداختنی',
  'customer-advance': 'پیش‌دریافت مشتری', 'deferred-revenue': 'درآمد انتقالی', 'supplier-advance': 'پیش‌پرداخت به تأمین‌کننده',
  'employee-advance': 'مساعده کارکنان', 'inventory-asset': 'کالای انبار', 'inventory-unsplit': 'کالای تفکیک‌نشده',
  'cheque-receivable': 'چک دریافتنی', 'cheque-payable': 'چک پرداختنی', 'tax-receivable': 'طلب مالیات',
  'vat-input': 'مالیات ارزش افزوده خرید', 'vat-output': 'مالیات ارزش افزوده فروش', 'partner-payable': 'بدهی به شریک',
  'partner-receivable': 'طلب از شریک', 'owner-capital': 'سرمایه مالک', 'owner-drawing': 'برداشت مالک',
  'accumulated-depreciation': 'استهلاک انباشته', 'depreciation-expense': 'هزینه استهلاک', 'unidentified-receipt': 'وجه ناشناس',
};

/** هر گیرهٔ ثبت یک راهنمای «از کجا حل می‌شود؟» دارد تا حسابدار نداند گم نشود. */
function blockerHint(text) {
  const t = String(text || '');
  if (/بانک|صندوق/.test(t)) return 'از بخش «مشاهده یا اصلاح تاریخ، طرف‌حساب و بانک» یا پاسخ سؤالِ بانک، حساب واقعی را انتخاب کن.';
  if (/تاریخ/.test(t)) return 'تاریخ رویداد را در همان بخش پایین گفت‌وگو اصلاح کن.';
  if (/سؤال|نام واقعی|مشخص کن|پاسخ/.test(t)) return 'پاسخ سؤال‌های پایین همین کارت را بده؛ پاسخ‌ها ذخیره می‌مانند.';
  return 'اصلاح را در گفت‌وگو بنویس و «ارسال و بازبینی پیشنهاد» را بزن تا پیشنهاد تازه بدهد.';
}

/** نقشهٔ سه‌گامیِ مسیر: گام فعال بسته به وضعیت پیشنهاد روشن است. */
function StepPath({ ai }) {
  const active = ai.canPost ? 2 : 1;
  return <ol aria-label="مسیر تکمیل سند" className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
    {['۱. پیش‌نویس را بخوان', '۲. غلط یا ناقص بود؟ در گفت‌وگو اصلاحش کن', '۳. درست شد؟ تأیید و ثبت'].map((step, index) =>
      <li key={step} className={`rounded-full border px-2 py-0.5 font-bold ${index === active ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted'}`}>{step}</li>)}
  </ol>;
}

export function ReviewAssistant({item,ai,setAi,onSaved,notify,busy}) {
  const [open,setOpen] = useState(false), [loading,setLoading] = useState(false), [error,setError] = useState('');
  const [message,setMessage] = useState(''), [history,setHistory] = useState([]), [contacts,setContacts] = useState([]), [accounts,setAccounts] = useState([]);
  const [facts,setFacts] = useState({}), [answers,setAnswers] = useState({});
  const questions=reviewQuestions(ai || {});
  const savedAnswers=reviewSavedAnswers(facts.questionAnswers || ai?.context?.questionAnswers || {});
  const unanswered=questions.filter(q=>!savedAnswers[q.id]);
  const conditions=(ai?.postingBlockers || []).filter(text=>!questions.some(q=>q.text===text));
  const hasAnswerChanges=Object.entries(answers).some(([id,value])=>value.trim()!==(savedAnswers[id]?.value || ''));

  const hasFactChanges=Object.entries(facts).some(([key,value])=>key!=='questionAnswers' && value!==ai?.context?.[key]);
  const hasUnreviewedChanges=hasAnswerChanges || hasFactChanges || Boolean(message.trim());
  const needsChoices=questions.some(q=>['counterpartyId','accountId'].includes(q.field)) || Object.values(savedAnswers).some(a=>['counterpartyId','accountId'].includes(a.field));
  useEffect(()=>{
    if(!needsChoices) return;
    let cancelled=false;
    Promise.all([api.contacts(),api.accounts()]).then(([people,banks])=>{
      if(!cancelled) {setContacts(people.items || []);setAccounts((banks.items || []).filter(a=>a.active));}
    }).catch(e=>{if(!cancelled) setError(e.message);});
    return ()=>{cancelled=true;};
  },[needsChoices]);
  const answerQuestion=(q,value)=>{
    setAnswers({...answers,[q.id]:value});
    if(q.field) setFacts({...facts,[q.field]:value});
  };
  const questionInput=(q,value)=>{
    const props={value,onChange:e=>answerQuestion(q,e.target.value),'aria-label':q.text,className:'mt-2 block w-full rounded border border-line bg-paper p-2'};
    if(q.id==='nature.vat-refund' && ai?.taxRefundCandidates?.length) return <>
      <input {...props} list={`tax-sources-${item.id}`} placeholder="شماره سال/سند، مثلاً ۱۴۰۵/۱۲" />
      <datalist id={`tax-sources-${item.id}`}>{ai.taxRefundCandidates.map(c=><option key={c.lineId} value={c.reference}>{c.accountName} · {persianDate(c.occurredAt)} · مانده {formatAmount(c.available)} تومان</option>)}</datalist>
    </>;
    if(['occurredAt','dueAt'].includes(q.field)) return <input {...props} type="date" />;
    // شخص تازه هم یک جواب است، نه فقط انتخاب از فهرست موجود.
    const newName=String(ai?.newCounterparty?.name || ai?.counterpartyName || '').trim();
    if(['counterpartyId','accountId'].includes(q.field)) return <select {...props}><option value="">انتخاب کن…</option>{q.field==='counterpartyId' && newName && <option value={`new:${newName}`}>طرف‌حساب تازه: {newName}</option>}{(q.field==='counterpartyId'?contacts:accounts).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>;
    return <textarea {...props} rows={2} maxLength={1000} placeholder="پاسخ این سؤال را اینجا بنویس…" />;
  };
  const loadChoices = async () => {
    const [people,banks] = await Promise.all([api.contacts(),api.accounts()]);
    setContacts(people.items || []);setAccounts((banks.items || []).filter(a=>a.active));
  };
  const analyze = async () => {
    if(Object.entries(answers).some(([id,value])=>savedAnswers[id] && !value.trim())) {setError('پاسخ ذخیره‌شده را خالی نگذار؛ جواب درست را جایگزین کن.');return;}
    setLoading(true);setError('');
    try {
      const result = await api.reviewAiProposal(item.id,{message,facts:{...facts,...(Object.values(answers).some(v=>v.trim())?{questionAnswers:Object.fromEntries(Object.entries(answers).filter(([,value])=>value.trim()).map(([id,value])=>[id,{value}]))}:{})}});
      setAi(result.proposal);setHistory(result.proposal.conversation || []);setMessage('');setFacts(result.proposal.context || {});setAnswers({});
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
  const repairMapping = async repair => {
    setLoading(true);setError('');
    try {
      await api.mapLedgerAccount(repair.ledgerAccountId,repair.chartAccountId);
      const result=await api.reviewAiProposal(item.id,{});
      setAi(result.proposal);await onSaved();
      notify('نگاشت با تأیید شما اصلاح و پیشنهاد دوباره تحلیل شد.');
    } catch(e) {setError(e.message);}
    finally {setLoading(false);}
  };
  const textOf = entry => {
    if(entry.speaker!=='assistant') {
      let body=entry.body;
      for(const choice of [...accounts,...contacts]) body=body.replaceAll(choice.id,choice.name);
      return body;
    }
    try {const p=JSON.parse(entry.body);return [p.summary,p.explanation,...(p.missingFacts || [])].filter(Boolean).join(' — ');} catch{return entry.body;}
  };
  return <section className="mt-3 rounded-lg border border-accent/30 bg-paper p-3 text-xs leading-6">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <b>دستیار حسابدار و DNA شرکت</b>
      {ai?.state === 'proposed' && <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] font-bold text-muted">پیش‌نویس — تا تأیید تو هیچ چیزی ثبت نشده</span>}
      <div className="flex gap-2">
        {(!ai || ai.state==='rejected' || !ai.canPost) && <button disabled={loading || busy} onClick={analyze} className="tap rounded border border-accent px-3 text-accent disabled:opacity-40">{loading?'در حال تحلیل…':'تحلیل کن'}</button>}
        <button disabled={loading} onClick={toggle} className="tap rounded border border-line px-3 hover:bg-paper hover:text-ink">{open?'بستن گفت‌وگو':'گفت‌وگو و تکمیل اطلاعات'}</button>
      </div>
    </div>
    {!ai && item.dnaMatches?.length>0 && <div className="mt-2 rounded bg-accent/5 p-2"><b>DNA شرکت {item.dnaMatches.length} تجربهٔ مشابه پیدا کرده است.</b>{item.dnaMatches.map(d=><p key={d.id}>{d.summary} · {d.actorName || d.actor} · {persianDate(d.date)} — {d.reason || 'تأیید قبلی'}</p>)}<p>با «تحلیل کن» تطبیق رویداد تازه را درخواست کن؛ تجربهٔ قبلی مجوز ثبت خودکار نیست.</p></div>}
    {ai?.state==='proposed' && <>
      <StepPath ai={ai} />
      <p className="mt-2 font-bold">{ai.summary}</p><p className="text-muted">{ai.explanation}</p>
      {!ai.canPost && <div role="status" className="mt-2 rounded-lg border border-expense/40 bg-expense/5 p-2.5">
        <b>چرا هنوز قابل ثبت نیست؟</b>
        {conditions.length > 0
          ? <ol className="mt-1 list-decimal space-y-1 ps-4">{conditions.map((text, index) => <li key={index}>{text} <span className="text-muted">— {blockerHint(text)}</span></li>)}</ol>
          : <p className="mt-1">{questions.length > 0 ? 'تأیید تا پاسخ سؤال‌های پایین همین کارت قفل است.' : 'این پیش‌نویس قابل ثبت نیست؛ اصلاح را در گفت‌وگو بنویس و بازبینی بگیر.'}</p>}
      </div>}
      {ai.tradeSettlement && <div className="my-2 rounded border border-line p-2"><b>مانده واقعی طرف‌حساب: {formatAmount(ai.tradeSettlement.available)} تومان</b><p>مبلغ پرداخت/وصول این سند: {formatAmount(ai.tradeSettlement.amount)} تومان</p><p>مانده پس از اعمال: {formatAmount(ai.tradeSettlement.available-ai.tradeSettlement.amount)} تومان</p><p className="text-muted">پرداخت بدهی و وصول طلب درآمد یا هزینه تازه نیستند.</p></div>}
      {ai.taxRefundClaim && <div className="my-2 rounded border border-line bg-paper p-2">
        <b>سند مبنای طلب مالیاتی: <span className="numbers" dir="ltr">{toPersianDigits(ai.taxRefundClaim.reference)}</span></b>
        <p>{persianDate(ai.taxRefundClaim.occurredAt)} · {ai.taxRefundClaim.accountName}</p>
        <p>مانده قابل وصول پیش از این ثبت: <span className="numbers">{formatAmount(ai.taxRefundClaim.available)}</span> تومان</p>
        <p className="text-muted">با تأیید شما، وصول به همین سند متصل می‌شود؛ درآمد تازه ثبت نمی‌شود.</p>
      </div>}
      {ai.dnaEvidence?.length > 0 && <div className="my-2 rounded border border-accent/30 bg-accent/5 p-2">
        <b>این پیشنهاد با توجه به تجربه‌های DNA همین شرکت تهیه شده؛ ثبت فقط با اجازهٔ شماست.</b>
        {ai.dnaEvidence.map(d=><p key={d.id}>{d.state==='accepted'?'تجربهٔ تأییدشده':'اصلاح قبلی'}: {d.summary} — {d.reason || 'تأیید حسابدار'} · {persianDate(d.date)} · حسابدار {d.actorName || d.actor || 'ثبت‌نشده'}{d.journalEntryId && ` · سند ${d.journalEntryId}`}</p>)}
      </div>}
      {ai.newCounterparty && <div className="mt-2 rounded border border-accent/30 bg-accent/5 p-2"><b>طرف‌حساب تازه: {ai.newCounterparty.name}</b><p>با تأیید شما، شخص و تفصیلی مربوط به سند ایجاد می‌شوند؛ پیش‌نمایش هنوز چیزی نساخته است.</p></div>}
      {ai.inventoryItems?.length>0 && <div className="mt-2 rounded border border-line p-2"><b>ورود انبار همراه سند</b>{ai.inventoryItems.map((i,n)=><p key={n}>{i.name} · {i.quantity} {i.unit} · بهای کل {formatAmount(i.total)} تومان{i.newProduct?' · ایجاد کالای تازه':''}</p>)}</div>}
      {ai.lines?.length>0 && <div className="mt-2 overflow-x-auto"><table className="w-full text-right"><thead><tr className="border-b border-line"><th>حساب پیشنهادی</th><th>بدهکار (تومان)</th><th>بستانکار (تومان)</th></tr></thead><tbody>{ai.lines.map((l,i)=><tr key={i} className="border-b border-line"><td>{l.accountCode} {l.accountName || l.key || l.role} <span className="text-muted">({ROLE_LABELS[l.role] || l.role})</span>{l.newAccount && <p className="text-accent">ساخت همراه سند · {l.newAccount.type==='asset'?'دارایی':l.newAccount.type==='liability'?'بدهی':l.newAccount.type==='expense'?'هزینه':l.newAccount.type==='income'?'درآمد':'سرمایه'} · {l.newAccount.normalSide==='debit'?'ماهیت بدهکار':'ماهیت بستانکار'}{l.newAccount.chartCode && ` · معین ${l.newAccount.chartCode} ${l.newAccount.chartName}`}</p>}</td><td className="numbers">{l.debit?formatAmount(l.debit):'—'}</td><td className="numbers">{l.credit?formatAmount(l.credit):'—'}</td></tr>)}</tbody></table></div>}
      {hasUnreviewedChanges && <p role="status" className="text-accent">اطلاعات تغییر کرده؛ پیش از تأیید سند، پاسخ‌ها را ذخیره و پیشنهاد را بازبینی کن.</p>}
      <p className="mt-2 text-muted">{ai.canPost ? 'پیش‌نویس کامل است. با تأیید تو سند ثبت می‌شود و تصمیمت با نام تو در تاریخچهٔ همین پرونده می‌ماند.' : 'تا رفع موارد «چرا هنوز قابل ثبت نیست؟» دکمهٔ تأیید قفل است؛ با یک اصلاح در گفت‌وگو پیشنهاد تازه می‌گیری.'}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button disabled={loading || busy || !ai.canPost || hasUnreviewedChanges} onClick={()=>feedback(true)} className="tap rounded bg-accent px-3 font-bold text-on-fill disabled:opacity-40 hover:bg-accent/90 active:bg-accent/80">{ai.newCounterparty || ai.inventoryItems?.length || ai.lines?.some(l=>l.newAccount)?'تأیید ایجاد موارد لازم و ثبت سند':'تأیید و اعمال سند'}</button>
        {!ai.canPost && <span className="text-[11px] font-bold text-muted">قفل — تا رفع موارد بالا</span>}
        <button disabled={loading || busy} onClick={()=>feedback(false)} className="tap rounded border border-expense px-3 text-expense">رد با دلیل</button>
        {!ai.canPost && <button disabled={loading} onClick={()=>open?null:toggle()} className="tap rounded border border-accent px-3 text-accent">پاسخ به ابهام و اصلاح پیشنهاد</button>}
      </div>
    </>}
    {ai?.state==='proposed' && ai.mappingRepairs?.map(repair=><div key={repair.ledgerAccountId} className="mt-3 rounded border border-line p-3">
      <p>حساب «{repair.accountName}» به صندوق نگاشت شده؛ معین مناسب «{repair.chartCode} {repair.chartName}» است. اصلاح نگاشت، نمایش کدینگ {repair.affectedLines} سطر قبلی را هم تغییر می‌دهد؛ مبلغ و بانک اسناد تغییر نمی‌کند.</p>
      <button disabled={loading || busy} onClick={()=>repairMapping(repair)} className="tap mt-2 rounded border border-accent px-3 text-accent">تأیید اصلاح نگاشت بانک و بازتحلیل</button>
    </div>)}
    {ai?.state==='proposed' && ai.bindingCorrections?.map((text,index)=><p key={index} className="mt-1 text-muted">{text}</p>)}
    {ai?.state==='proposed' && <ReviewPriorBasis item={item} ai={ai} busy={busy || loading} notify={notify} onPrepared={p=>{setAi(p);setFacts(p.context || {});setHistory(p.conversation || []);setAnswers({});setMessage('');}} />}
    {ai?.state==='rejected' && <p>دلیل رد: {ai.reason}</p>}
    {ai?.state==='proposed' && (questions.length>0 || Object.keys(savedAnswers).length>0 || conditions.length>0) && <div className="mt-3 space-y-3 border-t border-line pt-3" aria-label="سؤال‌ها و پاسخ‌های این پرونده">
      {unanswered.length>0 && <><b>برای تکمیل پیشنهاد، به این سؤال‌ها پاسخ بده</b><p className="text-muted">هر پاسخ کنار سؤال خودش ذخیره می‌شود و در بازبینی‌های بعدی در اختیار دستیار می‌ماند.</p></>}
      {unanswered.map(q=><label key={q.id} className="block rounded-lg border border-accent/30 bg-accent/5 p-3"><span className="block font-bold">{q.text}</span>{questionInput(q,answers[q.id] ?? '')}</label>)}
      {Object.keys(savedAnswers).length>0 && <details className="rounded border border-line p-3"><summary className="cursor-pointer font-bold">پاسخ‌های ذخیره‌شده ({Object.keys(savedAnswers).length}) · مشاهده و اصلاح</summary><p className="text-muted">این اطلاعات دوباره پرسیده نمی‌شوند. اگر واقعیت تغییر کرده، پاسخ را اصلاح و بازبینی کن.</p>{Object.entries(savedAnswers).map(([id,answer])=><label key={id} className="mt-2 block"><span>{answer.question}</span>{questionInput({id,text:answer.question,field:answer.field},answers[id] ?? answer.value)}</label>)}</details>}
      {questions.some(q=>savedAnswers[q.id]) && <p role="status" className="rounded bg-surface p-2">پاسخ شما محفوظ است؛ دستیار هنوز پیشنهاد قابل ثبت تهیه نکرده است. با بازبینی مجدد، پاسخ ذخیره‌شده دوباره به آن داده می‌شود.</p>}
      {(questions.length>0 || hasAnswerChanges) && <button disabled={loading || busy || (!hasAnswerChanges && !questions.some(q=>savedAnswers[q.id]))} onClick={analyze} className="tap rounded bg-accent px-3 font-bold text-on-fill disabled:opacity-40 hover:bg-accent/90 active:bg-accent/80">{loading?'در حال ذخیره و بازبینی…':hasAnswerChanges?'ذخیره پاسخ‌ها و بازبینی پیشنهاد':'بازبینی با پاسخ‌های ذخیره‌شده'}</button>}
    </div>}
    {open && <div className="mt-3 space-y-2 border-t border-line pt-3">
      <p>نکته یا پاسخ سؤال را بنویس. AI پیشنهاد تازه می‌دهد و برای ثبت نهایی از شما اجازه می‌گیرد.</p>
      <div className="max-h-72 space-y-2 overflow-y-auto" aria-label="تاریخچه گفت‌وگوی حسابدار">{(history.length?history:ai?.conversation || []).map(h=><div key={h.id} className={`rounded p-2 ${h.speaker==='assistant'?'bg-surface':'bg-accent/5'}`}><b>{h.speaker==='assistant'?'دستیار':h.speaker==='accepted'?'تأیید سند':h.speaker==='rejected'?'رد با دلیل':'حسابدار'}</b> · {h.actorName || h.actor || ''} · {persianDate(h.createdAt)}<p className="whitespace-pre-wrap">{textOf(h)}</p></div>)}</div>
      <details className="rounded border border-line p-2"><summary className="cursor-pointer">مشاهده یا اصلاح تاریخ، طرف‌حساب و بانک</summary><p className="text-muted">اطلاعات این بخش اختیاری است؛ فقط اگر اطلاعات ثبت اشتباه است آن را تغییر بده. پاسخ به سؤال‌های بالا کافی است.</p><div className="grid gap-2 sm:grid-cols-2">
        <label>تاریخ رویداد<input type="date" value={facts.occurredAt || ''} onChange={e=>setFacts({...facts,occurredAt:e.target.value})} className="block w-full rounded border border-line p-2" /></label>
        {ai?.lines?.some(l=>['cheque-payable','cheque-receivable'].includes(l.role)) && <label>سررسید چک<input type="date" value={facts.dueAt || ''} onChange={e=>setFacts({...facts,dueAt:e.target.value})} className="block w-full rounded border border-line p-2" /></label>}
        <label>طرف حساب موجود (در صورت انتخاب صریح)<select value={facts.counterpartyId || ''} onChange={e=>setFacts({...facts,counterpartyId:e.target.value})} className="block w-full rounded border border-line p-2"><option value="">انتخاب شخص</option>{contacts.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {ai?.lines?.some(l=>l.role==='cash') && <label>بانک یا صندوق<select value={facts.accountId || ''} onChange={e=>setFacts({...facts,accountId:e.target.value})} className="block w-full rounded border border-line p-2"><option value="">انتخاب حساب</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
        {!facts.counterpartyId && <label>نام طرف‌حساب تازه در صورت نیاز<input value={facts.counterpartyName || ai?.newCounterparty?.name || ''} onChange={e=>setFacts({...facts,counterpartyName:e.target.value})} placeholder="نام واقعی؛ ایجاد همراه تأیید سند" className="block w-full rounded border border-line p-2" /></label>}
      </div></details>
      <textarea aria-label="پیام حسابدار به AI" rows={3} value={message} onChange={e=>setMessage(e.target.value)} maxLength={2000} placeholder="مثلاً ۲۰ عدد فیلتر برای انبار تحویل گرفتیم؛ بهای کل ۴۰ میلیون تومان، طرف‌حساب آسیا گستر اسپادانا است…" className="w-full rounded border border-line p-2" />
      <button disabled={loading || busy || (!message.trim() && !Object.keys(facts).length && !hasAnswerChanges)} onClick={analyze} className="tap rounded border border-accent px-3 text-accent disabled:opacity-40">{loading?'در حال بررسی…':'ارسال و بازبینی پیشنهاد'}</button>
    </div>}
    {error && <p role="alert" className="mt-2 text-expense">{error}</p>}
  </section>;
}
