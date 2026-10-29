import { Check, ChevronLeft, ChevronRight, MessageCircle, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { QuickDateInput } from '../../components/QuickDateInput.jsx';
import { ReviewPriorBasis } from './ReviewPriorBasis.jsx';
import { EntryTable } from './ReviewEntry.jsx';
import { proposalBrief, remainingBlockers } from './reviewCase.js';
import { reviewQuestions, reviewSavedAnswers } from '../../../shared/reviewQuestions.js';
import { api } from '../../lib/api.js';
import { formatAmount, persianDate, toPersianDigits, unitLabel } from '../../lib/format.js';

/**
 * «تحلیل کن» در صف حسابدار — بازطراحی پس از بازخورد مالک محصول (۲۹ مهر ۱۴۰۵):
 * «متن‌ها خیلی ریز، جایی می‌روند که کاربر عادی اصلاً نمی‌بیند؛ وقتی چت طولانی می‌شود
 * مشکل و اینکه چرا هنوز نمی‌شود ثبت کرد مشخص نیست.»
 *
 * ترتیب ثابت است و هر چیز یک جا دارد:
 * ۱. پیش از تحلیل: یک دکمهٔ اصلی «تحلیل کن» و یک جمله که چه می‌شود.
 * ۲. نتیجه: «مشکل» (آنچه تأیید را قفل کرده) و «راه‌حل» (خلاصهٔ پیشنهاد)، هر کدام یک خط؛
 *    توضیحِ بلند پشت «چرا؟».
 * ۳. سؤال‌ها یکی‌یکی با شمارهٔ «۱ از ۳»؛ پس از آخری پیشنهاد با جواب‌ها بازبینی می‌شود.
 * ۴. سند پیشنهادی و تأیید. رد با دلیل و گفت‌وگو با دستیار، کنارِ تأیید ولی آرام‌تر.
 */

const SPEAKERS = { assistant: 'دستیار', accepted: 'تأیید سند', rejected: 'رد با دلیل' };

function Analyzing() {
  return <div role="status" aria-live="polite" className="rq-step rounded-xl border border-line bg-paper p-4">
    <p className="flex items-center gap-2 text-[14px] font-bold"><Sparkles size={17} className="text-accent" aria-hidden="true" />در حال تحلیل…</p>
    <p className="mt-1 text-[13px] text-muted">متن کامل، دفتر و سابقهٔ همین شرکت خوانده می‌شود؛ چند ثانیه طول می‌کشد.</p>
    <div className="mt-3 space-y-2" aria-hidden="true"><div className="rq-skeleton h-3 w-3/4" /><div className="rq-skeleton h-3 w-1/2" /><div className="rq-skeleton h-8 w-full" /></div>
  </div>;
}

export function ReviewAssistant({ item, ai, setAi, onSaved, notify, busy }) {
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [message, setMessage] = useState(''), [history, setHistory] = useState([]), [contacts, setContacts] = useState([]), [accounts, setAccounts] = useState([]);
  const [facts, setFacts] = useState({}), [answers, setAnswers] = useState({}), [step, setStep] = useState(0);
  const [rejecting, setRejecting] = useState(false), [rejectReason, setRejectReason] = useState('');
  const questions = reviewQuestions(ai || {});
  const savedAnswers = reviewSavedAnswers(facts.questionAnswers || ai?.context?.questionAnswers || {});
  const unanswered = questions.filter((q) => !savedAnswers[q.id]);
  const conditions = (ai?.postingBlockers || []).filter((text) => !questions.some((q) => q.text === text));
  const hasAnswerChanges = Object.entries(answers).some(([id, value]) => value.trim() !== (savedAnswers[id]?.value || ''));
  const hasFactChanges = Object.entries(facts).some(([key, value]) => key !== 'questionAnswers' && value !== ai?.context?.[key]);
  const hasUnreviewedChanges = hasAnswerChanges || hasFactChanges || Boolean(message.trim());
  const needsChoices = questions.some((q) => ['counterpartyId', 'accountId'].includes(q.field)) || Object.values(savedAnswers).some((a) => ['counterpartyId', 'accountId'].includes(a.field));
  const brief = ai?.state === 'proposed' ? proposalBrief(ai, { unanswered, conditions }) : null;
  // گیره‌های دیگر به زبانِ کاربر و بی‌تکرار؛ اولی همان «مشکل» بالاست.
  const otherBlockers = brief && !brief.ready ? remainingBlockers(conditions, brief) : [];
  const current = unanswered[Math.min(step, Math.max(unanswered.length - 1, 0))];
  const currentIndex = current ? unanswered.indexOf(current) : -1;
  const creates = ai?.newCounterparty || ai?.inventoryItems?.length || ai?.lines?.some((l) => l.newAccount);

  useEffect(() => { setStep(0); }, [ai?.id]);
  useEffect(() => {
    if (!needsChoices) return;
    let cancelled = false;
    Promise.all([api.contacts(), api.accounts()]).then(([people, banks]) => {
      if (!cancelled) { setContacts(people.items || []); setAccounts((banks.items || []).filter((a) => a.active)); }
    }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [needsChoices]);

  const answerQuestion = (q, value) => {
    setAnswers({ ...answers, [q.id]: value });
    if (q.field) setFacts({ ...facts, [q.field]: value });
  };
  const questionInput = (q, value) => {
    const props = { value, onChange: (e) => answerQuestion(q, e.target.value), 'aria-label': q.text, className: 'mt-2 block w-full rounded-lg border border-line bg-surface p-2.5 text-[14px]' };
    if (q.id === 'nature.vat-refund' && ai?.taxRefundCandidates?.length) return <>
      <input {...props} list={`tax-sources-${item.id}`} placeholder="شماره سال/سند، مثلاً ۱۴۰۵/۱۲" />
      <datalist id={`tax-sources-${item.id}`}>{ai.taxRefundCandidates.map((c) => <option key={c.lineId} value={c.reference}>{c.accountName} · {persianDate(c.occurredAt)} · مانده {formatAmount(c.available)} {unitLabel()}</option>)}</datalist>
    </>;
    if (['occurredAt', 'dueAt'].includes(q.field)) return <QuickDateInput format="date" direction={q.field === 'dueAt' ? 'any' : 'past'} value={value || ''} onChange={(date) => answerQuestion(q, date)} aria-label={q.text} className="mt-2" />;
    // جوابِ بسته («وجه در اختیار شرکت»، «برداشت شخصی» …) کارتِ انتخاب است، نه متنِ آزاد.
    if (q.options?.length) return <span role="radiogroup" aria-label={q.text} className="mt-2 grid gap-2 sm:grid-cols-2">
      {q.options.map((option) => <button key={option} type="button" role="radio" aria-checked={value === option} onClick={() => answerQuestion(q, option)}
        className={`tap rounded-lg border px-3 py-2 text-start text-[14px] font-bold ${value === option ? 'border-accent bg-accent/10 text-ink' : 'border-line bg-surface text-ink hover:border-accent/50'}`}>{option}</button>)}
    </span>;
    // شخص تازه هم یک جواب است، نه فقط انتخاب از فهرست موجود.
    const newName = String(ai?.newCounterparty?.name || ai?.counterpartyName || '').trim();
    if (['counterpartyId', 'accountId'].includes(q.field)) return <select {...props}><option value="">انتخاب کن…</option>{q.field === 'counterpartyId' && newName && <option value={`new:${newName}`}>طرف‌حساب تازه: {newName}</option>}{(q.field === 'counterpartyId' ? contacts : accounts).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>;
    return <textarea {...props} rows={2} maxLength={1000} placeholder="جواب را کوتاه بنویس…" />;
  };
  const loadChoices = async () => {
    const [people, banks] = await Promise.all([api.contacts(), api.accounts()]);
    setContacts(people.items || []); setAccounts((banks.items || []).filter((a) => a.active));
  };
  const analyze = async () => {
    if (Object.entries(answers).some(([id, value]) => savedAnswers[id] && !value.trim())) { setError('پاسخ ذخیره‌شده را خالی نگذار؛ جواب درست را جایگزین کن.'); return; }
    setLoading(true); setError('');
    try {
      const result = await api.reviewAiProposal(item.id, { message, facts: { ...facts, ...(Object.values(answers).some((v) => v.trim()) ? { questionAnswers: Object.fromEntries(Object.entries(answers).filter(([, value]) => value.trim()).map(([id, value]) => [id, { value }])) } : {}) } });
      setAi(result.proposal); setHistory(result.proposal.conversation || []); setMessage(''); setFacts(result.proposal.context || {}); setAnswers({});
      if (result.proposal.postingBlockers?.length) await loadChoices();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setLoading(true); setError('');
    try {
      const [conversation, people, banks] = await Promise.all([api.reviewAiConversation(item.id), api.contacts(), api.accounts()]);
      setHistory(conversation.messages || []); setContacts(people.items || []); setAccounts((banks.items || []).filter((a) => a.active));
      setFacts(conversation.proposal?.context || conversation.context || {}); setOpen(true);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  const accept = async () => {
    setLoading(true); setError('');
    try {
      await api.reviewAiFeedback(item.id, ai.id, true, '');
      notify('سند ثبت شد؛ این تأیید با نام تو در DNA شرکت ماند.');
      await onSaved();
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  const reject = async () => {
    if (rejectReason.trim().length < 8) { setError('دلیل رد و روش درست را دست‌کم در هشت نویسه بنویس.'); return; }
    setLoading(true); setError('');
    try {
      const result = await api.reviewAiFeedback(item.id, ai.id, false, rejectReason.trim());
      setAi(result.proposal); setHistory((await api.reviewAiConversation(item.id)).messages); setRejecting(false); setRejectReason('');
      notify('دلیل رد ذخیره شد؛ برای پیشنهاد تازه «تحلیل کن» یا گفت‌وگو را بزن.');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  const repairMapping = async (repair) => {
    setLoading(true); setError('');
    try {
      await api.mapLedgerAccount(repair.ledgerAccountId, repair.chartAccountId);
      const result = await api.reviewAiProposal(item.id, {});
      setAi(result.proposal); await onSaved();
      notify('نگاشت با تأیید تو اصلاح و پیشنهاد دوباره تحلیل شد.');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  const textOf = (entry) => {
    if (entry.speaker !== 'assistant') {
      let body = entry.body;
      for (const choice of [...accounts, ...contacts]) body = body.replaceAll(choice.id, choice.name);
      return body;
    }
    try { const p = JSON.parse(entry.body); return [p.summary, ...(p.missingFacts || [])].filter(Boolean).join(' — '); } catch { return entry.body; }
  };

  return <section aria-label="تحلیل این مورد" className="mt-3">
    {!ai && !loading && <div className="rounded-xl border border-line bg-paper p-4">
      {item.dnaMatches?.length > 0 && <p className="mb-3 text-[13px] leading-6 text-muted"><b className="text-ink">DNA همین شرکت {toPersianDigits(item.dnaMatches.length)} تجربهٔ مشابه دارد</b> — {item.dnaMatches[0].summary}. تجربهٔ قبلی مجوز ثبت خودکار نیست؛ تحلیل تطبیقش را می‌سنجد.</p>}
      <button type="button" disabled={busy} onClick={analyze} className="tap inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 text-[15px] font-extrabold text-on-fill hover:bg-accent/90 disabled:opacity-40 sm:w-auto"><Sparkles size={18} aria-hidden="true" />تحلیل کن</button>
      <p className="mt-2 text-[13px] leading-6 text-muted">AI از روی متن کامل و سابقهٔ همین شرکت سند پیشنهادی می‌سازد؛ تا تأیید تو هیچ چیزی ثبت نمی‌شود.</p>
    </div>}

    {loading && <Analyzing />}

    {ai?.state === 'rejected' && !loading && <div className="rq-step rounded-xl border border-line bg-paper p-4 text-[14px] leading-7">
      <p><b>پیشنهاد قبلی رد شد:</b> {ai.reason}</p>
      <button type="button" disabled={busy} onClick={analyze} className="tap mt-2 inline-flex items-center gap-2 rounded-xl bg-accent px-4 text-[14px] font-bold text-on-fill disabled:opacity-40"><Sparkles size={17} aria-hidden="true" />تحلیل دوباره</button>
    </div>}

    {brief && !loading && <div className="rq-step rounded-xl border border-line bg-paper p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[12px] font-bold text-muted">پیش‌نویس — تا تأیید تو هیچ چیزی ثبت نشده</span>
        <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-extrabold ${brief.ready ? 'bg-income/10 text-income' : 'bg-warn-bg text-warn'}`}>{brief.ready ? 'آمادهٔ ثبت' : brief.unsupported ? 'هنوز پشتیبانی نمی‌شود' : 'هنوز قابل ثبت نیست'}</span>
      </div>
      <dl className="mt-3 space-y-2.5 text-[14px] leading-7">
        {!brief.ready && <div role="status" className="rounded-lg border-s-4 border-warn bg-warn-bg/60 px-3 py-2"><dt className="text-[12px] font-extrabold text-warn">مشکل</dt><dd className="font-bold text-ink">{brief.problem}</dd><dd className="mt-0.5 text-[13px] text-muted">{brief.fix}</dd>
          {/* پیام می‌گفت «تحلیل دوباره» را بزن و دکمه‌ای نبود (آزمون صف روی سایت). */}
          {brief.restart && <dd><button type="button" disabled={loading || busy} onClick={analyze} className="tap mt-2 inline-flex items-center gap-2 rounded-xl bg-accent px-4 text-[14px] font-bold text-on-fill disabled:opacity-40"><Sparkles size={17} aria-hidden="true" />تحلیل دوباره</button></dd>}</div>}
        {brief.solution && <div className="rounded-lg border-s-4 border-accent bg-accent/5 px-3 py-2"><dt className="text-[12px] font-extrabold text-accent">{brief.ready ? 'سند پیشنهادی' : 'راه‌حل'}</dt><dd className="text-ink">{brief.solution}</dd></div>}
      </dl>
      {otherBlockers.length > 0 && <ol className="mt-2 list-decimal space-y-1 ps-5 text-[13px] leading-6">{otherBlockers.map((blocker) => <li key={blocker.problem}>{blocker.problem} <span className="text-muted">— {blocker.fix}</span></li>)}</ol>}
      {brief.more && <details className="mt-2 text-[13px] leading-6"><summary className="cursor-pointer font-bold text-muted">چرا؟</summary><p className="mt-1 text-ink">{brief.more}</p></details>}

      {current && !brief.restart && <div key={current.id} className="rq-step mt-4 rounded-xl border border-accent/40 bg-accent/5 p-3.5" aria-label="سؤال‌های این پرونده">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] font-extrabold text-accent">سؤال {toPersianDigits(currentIndex + 1)} از {toPersianDigits(unanswered.length)}</p>
          {unanswered.length > 1 && <span aria-hidden="true" className="flex gap-1">{unanswered.map((q, index) => <span key={q.id} className={`h-1.5 w-4 rounded-full ${index <= currentIndex ? 'bg-accent' : 'bg-line'}`} />)}</span>}
        </div>
        {/* گزینه‌ها دکمه‌اند؛ درونِ <label> کلیک روی متنِ سؤال اولین گزینه را می‌زد. */}
        {current.options?.length
          ? <div className="mt-1.5 text-[15px] font-bold leading-7"><p>{current.text}</p>{questionInput(current, answers[current.id] ?? '')}</div>
          : <label className="mt-1.5 block text-[15px] font-bold leading-7">{current.text}{questionInput(current, answers[current.id] ?? '')}</label>}
        <div className="mt-3 flex flex-wrap gap-2">
          {currentIndex > 0 && <button type="button" onClick={() => setStep(currentIndex - 1)} className="tap inline-flex items-center gap-1 rounded-lg border border-line px-3 text-[13px] font-bold"><ChevronRight size={16} aria-hidden="true" />قبلی</button>}
          {currentIndex < unanswered.length - 1
            ? <button type="button" disabled={!(answers[current.id] || '').trim()} onClick={() => setStep(currentIndex + 1)} className="tap inline-flex items-center gap-1 rounded-lg bg-accent px-4 text-[13px] font-bold text-on-fill disabled:opacity-40">بعدی<ChevronLeft size={16} aria-hidden="true" /></button>
            : <button type="button" disabled={loading || busy || !hasAnswerChanges} onClick={analyze} className="tap rounded-lg bg-accent px-4 text-[13px] font-bold text-on-fill disabled:opacity-40">ذخیره و بازبینی پیشنهاد</button>}
        </div>
      </div>}
      {!current && !brief.restart && questions.some((q) => savedAnswers[q.id]) && !brief.ready && <div role="status" className="mt-3 rounded-lg bg-surface p-2.5 text-[13px] leading-6"><p>جواب‌ها ذخیره شده؛ پیشنهاد هنوز قابل ثبت نیست. با «تحلیل دوباره» جواب‌ها به دستیار داده می‌شوند.</p>
        <button type="button" disabled={loading || busy} onClick={analyze} className="tap mt-2 inline-flex items-center gap-2 rounded-lg bg-accent px-4 text-[13px] font-bold text-on-fill disabled:opacity-40"><Sparkles size={16} aria-hidden="true" />تحلیل دوباره</button></div>}
      {Object.keys(savedAnswers).length > 0 && <details className="mt-3 rounded-lg border border-line p-3 text-[13px]"><summary className="cursor-pointer font-bold">جواب‌های داده‌شده ({toPersianDigits(Object.keys(savedAnswers).length)}) · دیدن و اصلاح</summary>
        {Object.entries(savedAnswers).map(([id, answer]) => <label key={id} className="mt-2 block">{answer.question}{questionInput({ id, text: answer.question, field: answer.field }, answers[id] ?? answer.value)}</label>)}
        {hasAnswerChanges && <button type="button" disabled={loading || busy} onClick={analyze} className="tap mt-2 rounded-lg bg-accent px-3 text-[13px] font-bold text-on-fill disabled:opacity-40">ذخیره و بازبینی پیشنهاد</button>}
      </details>}

      {ai.tradeSettlement && <div className="mt-3 rounded-lg border border-line p-3 text-[13px] leading-6"><b>ماندهٔ واقعی طرف‌حساب: {formatAmount(ai.tradeSettlement.available)} {unitLabel()}</b><p>این سند {formatAmount(ai.tradeSettlement.amount)} {unitLabel()}؛ مانده پس از آن {formatAmount(ai.tradeSettlement.available - ai.tradeSettlement.amount)} {unitLabel()}.</p><p className="text-muted">پرداخت بدهی و وصول طلب، درآمد یا هزینهٔ تازه نیست.</p></div>}
      {ai.taxRefundClaim && <div className="mt-3 rounded-lg border border-line p-3 text-[13px] leading-6"><b>سند مبنای طلب مالیاتی: <span className="numbers" dir="ltr">{toPersianDigits(ai.taxRefundClaim.reference)}</span></b><p>{persianDate(ai.taxRefundClaim.occurredAt)} · {ai.taxRefundClaim.accountName} · ماندهٔ قابل وصول <span className="numbers">{formatAmount(ai.taxRefundClaim.available)}</span> {unitLabel()}</p><p className="text-muted">با تأیید تو، وصول به همین سند وصل می‌شود؛ درآمد تازه ثبت نمی‌شود.</p></div>}
      {ai.newCounterparty && <p className="mt-3 rounded-lg border border-accent/30 bg-accent/5 p-3 text-[13px] leading-6"><b>طرف‌حساب تازه: {ai.newCounterparty.name}</b> — با تأیید تو، شخص و تفصیلی‌اش ساخته می‌شوند.</p>}
      {ai.inventoryItems?.length > 0 && <div className="mt-3 rounded-lg border border-line p-3 text-[13px] leading-6"><b>ورود انبار همراه سند</b>{ai.inventoryItems.map((i, n) => <p key={n}>{i.name} · {i.quantity} {i.unit} · بهای کل {formatAmount(i.total)} {unitLabel()}{i.newProduct ? ' · کالای تازه' : ''}</p>)}</div>}
      <EntryTable lines={ai.lines || []} title="سند پیشنهادی" />
      {ai.mappingRepairs?.map((repair) => <div key={repair.ledgerAccountId} className="mt-3 rounded-lg border border-line p-3 text-[13px] leading-6">
        <p>حساب «{repair.accountName}» به صندوق نگاشت شده؛ معین مناسب «{repair.chartCode} {repair.chartName}» است. اصلاح نگاشت، نمایش کدینگ {repair.affectedLines} سطر قبلی را هم تغییر می‌دهد؛ مبلغ و بانک اسناد تغییر نمی‌کند.</p>
        <button type="button" disabled={loading || busy} onClick={() => repairMapping(repair)} className="tap mt-2 rounded-lg border border-accent px-3 text-[13px] font-bold text-accent">تأیید اصلاح نگاشت بانک و بازتحلیل</button>
      </div>)}
      {ai.bindingCorrections?.map((text, index) => <p key={index} className="mt-2 text-[13px] text-muted">{text}</p>)}
      <ReviewPriorBasis item={item} ai={ai} busy={busy || loading} notify={notify} onPrepared={(p) => { setAi(p); setFacts(p.context || {}); setHistory(p.conversation || []); setAnswers({}); setMessage(''); }} />
      {ai.dnaEvidence?.length > 0 && <details className="mt-3 text-[13px] leading-6"><summary className="cursor-pointer font-bold text-muted">این پیشنهاد از {toPersianDigits(ai.dnaEvidence.length)} تجربهٔ همین شرکت کمک گرفته</summary>
        {ai.dnaEvidence.map((d) => <p key={d.id} className="mt-1">{d.state === 'accepted' ? 'تأییدشده' : 'اصلاح قبلی'}: {d.summary} — {d.reason || 'تأیید حسابدار'} · {persianDate(d.date)} · {d.actorName || d.actor || 'ثبت‌نشده'}{d.journalEntryId && ` · سند ${d.journalEntryId}`}</p>)}
      </details>}

      {hasUnreviewedChanges && <p role="status" className="mt-3 text-[13px] font-bold text-accent">اطلاعات عوض شده؛ پیش از تأیید، «ذخیره و بازبینی پیشنهاد» را بزن.</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <button type="button" disabled={loading || busy || !ai.canPost || hasUnreviewedChanges} onClick={accept} className="tap inline-flex items-center gap-1.5 rounded-xl bg-accent px-5 text-[14px] font-extrabold text-on-fill hover:bg-accent/90 disabled:opacity-40"><Check size={17} aria-hidden="true" />{creates ? 'تأیید، ساخت موارد لازم و ثبت سند' : 'تأیید و ثبت سند'}</button>
        {!ai.canPost && <span className="text-[12px] font-bold text-muted">{brief.unsupported ? 'این شکل سند هنوز قابل ثبت نیست' : brief.restart ? 'قفل تا تحلیل دوباره' : 'قفل تا «مشکل» بالا حل شود'}</span>}
        <button type="button" disabled={loading || busy} onClick={() => setRejecting(!rejecting)} aria-expanded={rejecting} className="tap rounded-xl border border-line px-3 text-[13px] font-bold text-expense">رد با دلیل</button>
        <button type="button" disabled={loading} onClick={toggle} aria-expanded={open} className="tap inline-flex items-center gap-1.5 rounded-xl border border-line px-3 text-[13px] font-bold"><MessageCircle size={16} aria-hidden="true" />{open ? 'بستن گفت‌وگو' : 'گفت‌وگو با دستیار'}</button>
      </div>
      {rejecting && <div className="rq-step mt-3 space-y-2">
        <label className="block text-[13px] font-bold">چرا رد می‌کنی و روش درست چیست؟<textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={2} maxLength={1000} className="mt-1 block w-full rounded-lg border border-line bg-surface p-2.5 text-[14px] font-normal" /></label>
        <button type="button" disabled={loading || rejectReason.trim().length < 8} onClick={reject} className="tap rounded-lg border border-expense px-3 text-[13px] font-bold text-expense disabled:opacity-40">ثبت رد</button>
      </div>}
    </div>}

    {open && <div className="rq-step mt-3 space-y-3 rounded-xl border border-line bg-paper p-4 text-[13px] leading-6">
      <p className="text-muted">چیزی که پیشنهاد درست نفهمیده را بنویس؛ پیشنهاد تازه می‌آید و ثبت همچنان با تأیید توست.</p>
      {(history.length ? history : ai?.conversation || []).length > 0 && <div className="max-h-72 space-y-2 overflow-y-auto" aria-label="تاریخچه گفت‌وگوی حسابدار">{(history.length ? history : ai?.conversation || []).map((h) => <div key={h.id} className={`rounded-lg p-2.5 ${h.speaker === 'assistant' ? 'bg-surface' : 'bg-accent/5'}`}><p className="text-[12px] text-muted"><b className="text-ink">{SPEAKERS[h.speaker] || 'حسابدار'}</b> · {h.actorName || h.actor || ''} · {persianDate(h.createdAt)}</p><p className="line-clamp-4 whitespace-pre-wrap text-[14px]">{textOf(h)}</p></div>)}</div>}
      <details className="rounded-lg border border-line p-2.5"><summary className="cursor-pointer font-bold">تاریخ، طرف‌حساب و بانک</summary><p className="mt-1 text-muted">فقط اگر اطلاعات ثبت اشتباه است عوضش کن؛ جواب سؤال‌ها کافی است.</p><div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label>تاریخ رویداد<QuickDateInput format="date" direction="past" aria-label="تاریخ رویداد" value={facts.occurredAt || ''} onChange={(occurredAt) => setFacts({ ...facts, occurredAt })} /></label>
        {ai?.lines?.some((l) => ['cheque-payable', 'cheque-receivable'].includes(l.role)) && <label>سررسید چک<QuickDateInput format="date" aria-label="سررسید" value={facts.dueAt || ''} onChange={(dueAt) => setFacts({ ...facts, dueAt })} /></label>}
        <label>طرف حساب موجود<select value={facts.counterpartyId || ''} onChange={(e) => setFacts({ ...facts, counterpartyId: e.target.value })} className="block w-full rounded-lg border border-line p-2"><option value="">انتخاب شخص</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {ai?.lines?.some((l) => l.role === 'cash') && <label>بانک یا صندوق<select value={facts.accountId || ''} onChange={(e) => setFacts({ ...facts, accountId: e.target.value })} className="block w-full rounded-lg border border-line p-2"><option value="">انتخاب حساب</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
        {!facts.counterpartyId && <label>نام طرف‌حساب تازه<input value={facts.counterpartyName || ai?.newCounterparty?.name || ''} onChange={(e) => setFacts({ ...facts, counterpartyName: e.target.value })} placeholder="نام واقعی؛ همراه تأیید ساخته می‌شود" className="block w-full rounded-lg border border-line p-2" /></label>}
      </div></details>
      <textarea aria-label="پیام حسابدار به AI" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} placeholder="مثلاً ۲۰ عدد فیلتر برای انبار تحویل گرفتیم؛ بهای کل ۴۰ میلیون تومان، طرف‌حساب آسیا گستر است…" className="w-full rounded-lg border border-line bg-surface p-2.5 text-[14px]" />
      <button type="button" disabled={loading || busy || (!message.trim() && !Object.keys(facts).length && !hasAnswerChanges)} onClick={analyze} className="tap rounded-lg bg-accent px-4 text-[13px] font-bold text-on-fill disabled:opacity-40">{loading ? 'در حال بررسی…' : 'ارسال و بازبینی پیشنهاد'}</button>
    </div>}
    {error && <p role="alert" className="mt-2 text-[13px] font-bold text-expense">{error}</p>}
  </section>;
}
