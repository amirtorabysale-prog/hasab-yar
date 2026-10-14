import { Check, CircleAlert, Mic, ReceiptText, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { buildTodayPulse, buildTodayTasks, closingDifference, todayComposerState, todayExamples } from '../../lib/todayExperience.js';
import { clock, formatAmount, formatSignedAmount, persianDate, toPersianDigits } from '../../lib/format.js';
import { describeVoiceAvailability, pointerReleaseAction, voicePathLabel } from '../../lib/voiceStatus.js';
import { liveSpeechSupported } from '../../lib/liveSpeech.js';
import { profileDefinition } from '../../../shared/product.js';
import { DecisionQuestionCard, questionCardKey } from '../../components/DecisionQuestionCard.jsx';

export function TodayPage({ data, loading, manualText, setManualText, parseManual, recordState, beginRecording, stopRecording, cancelProcessing, levels, liveTranscript, liveVoiceNote, livePreview, fastVoiceAvailable, voicePath, voiceSystemStatus, readOnly = false, reviewing = false, savedRecently = false, pendingAudioCount = 0, navigate, onOpenClosing, onSelectTransaction, onSnoozeAlert, notify, refreshToday, experience = 'simple', aiForAll = null, onToggleAiForAll }) {
  const profileType = data.settings.profileType || 'business';
  const examples = todayExamples(profileType);
  const composerState = todayComposerState({ recordState, manualText, reviewing, savedRecently });
  const composerLabels = {
    ready: ['آماده', 'یک اتفاق مالی را بگو یا بنویس'],
    listening: ['در حال شنیدن', 'هم‌زمان متن و عدد را می‌سازم'],
    typing: ['در حال نوشتن', 'جمله را کامل کن تا بررسی شود'],
    review: ['بازبینی', 'پیش از ثبت، عدد و دسته را تأیید کن'],
    success: ['ثبت شد', 'تا چند ثانیه می‌توانی برگردانی'],
  };
  const latestClosing = data.closings?.find((item) => item.day === data.closingPreview?.day) || null;
  const commercial = data.overview?.commercial || {};
  const voiceQuota = commercial.quotas?.find((item) => item.id === 'smartVoiceRequests') || null;
  const pulse = buildTodayPulse({ summary: data.summary, overview: data.overview, transactions: data.transactions });
  const tasks = buildTodayTasks({ transactions: data.transactions, overview: data.overview, closing: latestClosing, profileType, pendingAudioCount });
  const chooseExample = (example) => {
    setManualText(example);
    window.setTimeout(() => document.getElementById('manual-entry')?.focus(), 0);
  };
  const handleTask = (task) => {
    if (task.action === 'close') onOpenClosing();
    if (task.action === 'ledger') navigate('ledger');
  };
  return (
    <main className="mx-auto w-full max-w-[920px]">
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line/80 bg-paper/95 px-4 py-3 backdrop-blur-sm">
        <div><div className="flex items-center gap-2"><h1 className="text-xl font-extrabold">امروز</h1>{latestClosing && <span className="rounded-full bg-income/10 px-2 py-1 text-[10px] font-extrabold text-income">روز بسته شد</span>}</div><p className="mt-0.5 text-[13px] text-muted">{persianDate()}</p></div>
      </header>

      <div className="space-y-5 px-4 py-4 sm:py-5">
        <section className={`voice-composer rounded-[14px] border p-4 shadow-paper sm:p-5 voice-state-${composerState}`} aria-label="ثبت سریع امروز">
          <div className="flex items-start justify-between gap-3">
            <div><p className="text-[12px] font-extrabold text-accent">ثبت سریع</p><h2 className="mt-1 text-xl font-extrabold sm:text-2xl">امروز چه اتفاقی افتاد؟</h2><p className="mt-1 text-[13px] leading-6 text-muted">{composerLabels[composerState][1]}</p></div>
            <span aria-live="polite" className="shrink-0 rounded-full border border-line bg-surface/80 px-2.5 py-1 text-[11px] font-extrabold">{composerLabels[composerState][0]}</span>
          </div>

          {readOnly && <div className="mt-3 rounded-[10px] border-r-4 border-accent bg-warn-bg px-3 py-3 text-sm leading-6">دسترسی تو «فقط مشاهده» است؛ می‌توانی گزارش‌ها و ثبت‌ها را ببینی اما چیزی تغییر نمی‌کند.</div>}
          {/* سهمیه پیش از رسیدن به صفر گفته می‌شود؛ غافلگیرشدن وسط ثبت روزانه،
              همان تجربه‌ای است که کاربر را از ابزار دور می‌کند. */}
          {!readOnly && voiceQuota && (voiceQuota.exhausted || voiceQuota.nearLimit) && (
            <div className={`mt-3 rounded-[10px] border-r-4 px-3 py-3 text-[12px] leading-6 ${voiceQuota.exhausted ? 'border-expense bg-expense/5' : 'border-accent bg-warn-bg'}`}>
              {voiceQuota.exhausted
                ? <><b>سهمیهٔ پردازش صوت هوشمند {commercial.monthLabel || 'این ماه'} تمام شد.</b> ضبط و تایپ زندهٔ Chrome و ثبت دستی همچنان کار می‌کنند؛ فقط بررسی فایل روی سرور تا شروع سهمیهٔ تازه بسته است.</>
                : <><b>{toPersianDigits(voiceQuota.remaining)} پردازش صوت هوشمند</b> تا پایان {commercial.monthLabel || 'این ماه'} مانده است. تایپ Chrome و ثبت دستی از این سهمیه کم نمی‌کنند.</>}
              {commercial.monthEndsAt && <span className="mt-1 block text-muted">سهمیهٔ تازه از {persianDate(commercial.monthEndsAt)}.</span>}
            </div>
          )}
          {!readOnly && aiForAll && <AiForAllToggle state={aiForAll} toggle={onToggleAiForAll} />}
          <Recorder state={recordState} start={beginRecording} stop={stopRecording} cancel={cancelProcessing} levels={levels} liveTranscript={liveTranscript} liveVoiceNote={liveVoiceNote} livePreview={livePreview} fastVoiceAvailable={fastVoiceAvailable} voicePath={voicePath} voiceSystemStatus={voiceSystemStatus} disabled={readOnly} showDiagnostics={experience === 'professional'} />

          <div className="my-2 flex items-center gap-3 text-[11px] text-muted"><span className="h-px flex-1 bg-line" /><span>یا بنویس</span><span className="h-px flex-1 bg-line" /></div>
          <form onSubmit={parseManual} className="rounded-[10px] border border-line bg-surface p-2">
            <label htmlFor="manual-entry" className="sr-only">ورود دستی</label>
            <div className="flex gap-2">
              <input disabled={readOnly} id="manual-entry" value={manualText} onChange={(event) => setManualText(event.target.value)} placeholder={readOnly ? 'در حالت فقط مشاهده، ثبت غیرفعال است' : 'مثلاً ۵۰۰ هزار تومان خرید کردم'} className="tap min-w-0 flex-1 rounded-lg border-0 bg-transparent px-3 text-[15px] outline-none placeholder:text-muted/80 disabled:opacity-60" />
              <button disabled={readOnly || !manualText.trim() || ['processing', 'finalizing'].includes(recordState)} className="tap rounded-lg bg-ink px-4 text-sm font-bold text-white disabled:opacity-35">بررسی</button>
            </div>
          </form>
          {!readOnly && <div className="scrollbar-none -mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="نمونه‌های ثبت"><span className="self-center whitespace-nowrap text-[11px] text-muted">نمونه:</span>{examples.map((example) => <button type="button" key={example} onClick={() => chooseExample(example)} className="min-h-9 shrink-0 rounded-full border border-line bg-surface/75 px-3 text-[11px] font-bold text-muted hover:border-accent hover:text-accent">{example}</button>)}</div>}
        </section>

        {/* پیش از هر خلاصه‌ای: اگر چیزی مبهم مانده، همان اول پرسیده می‌شود. */}
        {!readOnly && <PendingQuestionCard notify={notify} refresh={refreshToday} reloadKey={data.transactions.length} />}

        <section className={`today-pulse pulse-${pulse.tone} rounded-[12px] border border-line bg-surface px-4 py-3.5`}>
          <div className="flex items-start gap-3"><span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-current" /><div className="min-w-0 flex-1"><p className="text-[11px] font-extrabold opacity-75">{pulse.eyebrow}</p><h2 className="mt-1 text-[16px] font-extrabold">{toPersianDigits(pulse.title)}</h2><p className="mt-1 text-[12px] leading-6 text-muted">{toPersianDigits(pulse.detail)}</p></div>{pulse.action && <div className="flex shrink-0 flex-col gap-1"><button onClick={() => navigate(pulse.action, pulse.actionTarget)} className="tap rounded-lg border border-current px-3 text-xs font-extrabold">{pulse.actionLabel || 'رسیدگی'}</button>{pulse.alertId && <button onClick={() => onSnoozeAlert?.(pulse.alertId)} className="min-h-7 text-[10px] font-bold opacity-70">۲۴ ساعت بعد</button>}</div>}</div>
        </section>

        <SummaryCard summary={data.summary} loading={loading} profileType={data.settings.profileType} />

        <section>
          <div className="mb-2 flex items-center justify-between"><h2 className="text-[17px] font-extrabold">کارهای ناتمام</h2><span className="text-[12px] text-muted">قبل از مرور ثبت‌ها</span></div>
          {tasks.length ? <div className="divide-y divide-line rounded-[12px] border border-line bg-surface px-3">{tasks.map((task) => <article key={task.id} className="flex min-h-[72px] items-center gap-3 py-3"><CircleAlert size={19} className={`shrink-0 ${task.tone === 'danger' ? 'text-expense' : task.tone === 'primary' ? 'text-accent' : 'text-muted'}`} /><div className="min-w-0 flex-1"><p className="text-sm font-extrabold">{toPersianDigits(task.title)}</p><p className="mt-1 text-[11px] leading-5 text-muted">{task.detail}</p></div>{task.action !== 'none' && <button onClick={() => handleTask(task)} className={`tap shrink-0 rounded-lg px-3 text-xs font-extrabold ${task.action === 'close' ? 'bg-accent text-white' : 'border border-line'}`}>{task.id === 'cash-mismatch' ? 'بازشماری' : task.action === 'close' ? 'بستن روز' : 'بازبینی'}</button>}</article>)}</div> : <div className="flex min-h-[72px] items-center gap-3 rounded-[12px] border border-income/25 bg-income/5 px-4"><Check size={20} className="text-income" /><div><p className="text-sm font-extrabold">کار فوری باقی نمانده</p><p className="mt-1 text-[11px] text-muted">ثبت‌های امروز مرتب و آمادهٔ مرور هستند.</p></div></div>}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between"><h2 className="text-[17px] font-extrabold">ثبت‌های امروز</h2><span className="text-[13px] text-muted">{toPersianDigits(data.transactions.length)} مورد</span></div>
          <TransactionList items={data.transactions} loading={loading} examples={examples} onExample={chooseExample} onSelect={onSelectTransaction} />
        </section>
      </div>
    </main>
  );
}

/**
 * پرسش سادهٔ صاحب کسب‌وکار.
 *
 * فقط وقتی دیده می‌شود که واقعاً چیزی مبهم باشد، و هر بار فقط یک مورد. فهرست
 * کردنشان، صفحهٔ اصلی را به کارتابل تبدیل می‌کند — دقیقاً همان چیزی که این
 * کاربر نباید داشته باشد.
 *
 * هیچ عدد اطمینانی، نام مسیری یا اصطلاح حسابداری اینجا نمی‌آید؛ سرور هم آن‌ها
 * را نمی‌فرستد.
 */
function PendingQuestionCard({ notify, refresh, reloadKey = 0 }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setItems((await api.confirmations()).items || []); }
    catch { setItems([]); }
  }, []);

  useEffect(() => { load(); }, [load, reloadKey]);

  const question = items[0];
  if (!question) return null;

  const answer = async (action) => {
    setBusy(true);
    try {
      if (action === 'yes') { await api.confirmPending(question.id); notify('ثبت شد.'); }
      else { await api.handOverPending(question.id); notify('به حسابدار سپرده شد.'); }
      await load();
      await refresh?.();
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  // جواب سؤال موتور (دورهٔ پوشش، قابل استرداد، بابت پول). سند نمی‌زند؛ بعد از
  // آخرین جواب، همین کارت «بله» را نشان می‌دهد.
  const answerAsk = async (payload) => {
    setBusy(true);
    try {
      const { item } = await api.answerPending(question.id, payload);
      notify(item?.route && item.route !== 'confirm' ? 'جواب ثبت شد و مورد به حسابدار سپرده شد.' : item?.ask ? 'جواب ثبت شد.' : 'جواب ثبت شد؛ حالا تأیید کن.');
      await load();
      await refresh?.();
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  return <PendingQuestionView question={question} more={items.length - 1} busy={busy} onYes={() => answer('yes')} onHandover={() => answer('handover')} onAnswer={answerAsk} />;
}

/**
 * نمای کارت پرسش. تا سؤالی باز است «بله» حتماً رد می‌شود؛ پس دیده نمی‌شود.
 * «مطمئن نیستم» همیشه هست: کسی که دوره را نمی‌داند حدس نمی‌زند، می‌سپارد.
 */
export function PendingQuestionView({ question, more = 0, busy = false, onYes, onHandover, onAnswer }) {
  const ask = question.ask || null;
  return <section className="rounded-[12px] border-r-4 border-accent bg-warn-bg px-4 py-3.5" aria-label="یک پرسش">
    <p className="text-[11px] font-extrabold text-accent">یک سؤال کوتاه</p>
    <h2 className="mt-1 text-[16px] font-extrabold">{toPersianDigits(question.question)}</h2>
    {!ask && question.hint && <p className="mt-1 text-[12px] leading-6 text-muted">{question.hint}</p>}
    {question.evidence && <blockquote className="mt-2 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] leading-6 text-muted">«{question.evidence}»</blockquote>}
    {ask && <DecisionQuestionCard key={questionCardKey(question.id, ask)} question={ask} busy={busy} onAnswer={onAnswer} />}
    <div className={`mt-3 grid gap-2 ${ask ? 'grid-cols-1' : 'grid-cols-[2fr_1fr]'}`}>
      {!ask && <button disabled={busy} onClick={onYes} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">بله، درست است</button>}
      <button disabled={busy} onClick={onHandover} className="tap rounded-lg border border-line bg-surface text-[13px] font-bold disabled:opacity-40">مطمئن نیستم</button>
    </div>
    {more > 0 && <p className="mt-2 text-[11px] text-muted">{toPersianDigits(more)} مورد دیگر بعد از این پرسیده می‌شود.</p>}
  </section>;
}

export function SummaryCard({ summary, loading, profileType = 'business', context = 'today' }) {
  const periodLabel = context === 'today' ? 'امروز' : 'این بازه';
  const labels = { income: `دریافت وجه ${periodLabel}`, expense: `پرداخت وجه ${periodLabel}`, net: 'خالص جریان نقدی' };
  const values = [
    { label: labels.income, value: summary.income, color: 'text-income' },
    { label: labels.expense, value: summary.expense, color: 'text-expense' },
    { label: labels.net, value: summary.netCashFlow ?? summary.profit, color: 'text-ink' },
  ];
  return (
    <section className="rounded-[10px] border border-line bg-surface p-4 shadow-paper">
      <div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-extrabold">گردش وجه نقد</h2><span className="text-xs text-muted">{periodLabel} · تومان</span></div><div className="financial-metrics">
        {values.map((item) => <div key={item.label} className="min-w-0 px-2 first:pr-0 last:pl-0"><p className="min-h-8 text-[11px] leading-4 text-muted sm:min-h-0 sm:whitespace-nowrap sm:text-[12px]">{item.label}</p><p className={`numbers mt-2 break-words text-[16px] font-extrabold sm:text-[19px] ${item.color}`}>{loading ? '—' : formatAmount(item.value)}</p><p className="mt-0.5 text-[11px] text-muted">تومان</p></div>)}
      </div>
      {summary.ledger && <div className="accrual-summary">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-extrabold">عملکرد ثبت‌شده در دفتر کل</h3><span className="text-xs text-muted">{periodLabel} · تومان</span></div>
        <div className="financial-metrics mt-3">{[
          ['درآمد ثبت‌شده', summary.ledger.income, 'text-income'],
          ['هزینه ثبت‌شده', summary.ledger.expense, 'text-expense'],
          ['سود / زیان', summary.ledger.profit, 'text-ink'],
        ].map(([label, value, color]) => <div key={label}><p className="text-xs text-muted">{label}</p><p className={`numbers mt-2 font-extrabold ${color}`}>{loading ? '—' : formatAmount(value)}</p></div>)}</div>
        <p className="mt-3 text-xs leading-6 text-muted">فروش نسیه می‌تواند درآمد باشد بدون دریافت وجه؛ دریافت طلب و پرداخت پیش‌پرداخت هم لزوماً درآمد یا هزینه نیستند.</p>
      </div>}
      <div className="mt-4 border-t border-line pt-3 text-[13px] text-muted">
        {summary.comparison == null ? 'برای مقایسه با دیروز هنوز داده کافی نیست.' : <span><b className={summary.comparison >= 0 ? 'text-income' : 'text-expense'}>{summary.comparison >= 0 ? '↑' : '↓'} {formatAmount(Math.abs(summary.comparison))}٪</b> {summary.comparison >= 0 ? 'بیشتر' : 'کمتر'} از دیروز</span>}
      </div>
    </section>
  );
}

function TransactionList({ items, loading, examples = [], onExample, onSelect }) {
  if (loading) return <div className="space-y-2">{[1, 2, 3].map((x) => <div key={x} className="h-16 animate-pulse rounded-lg bg-line/45" />)}</div>;
  if (!items.length) return <div className="rounded-[12px] border border-dashed border-line bg-surface/55 px-4 py-6 text-center"><div className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-warn-bg text-accent"><ReceiptText size={21} /></div><p className="mt-3 text-[15px] font-extrabold">اولین ثبت امروز را بساز</p><p className="mt-1 text-[12px] leading-6 text-muted">لازم نیست فرم حسابداری بلد باشی؛ یکی از جمله‌ها را انتخاب کن و مبلغش را تغییر بده.</p><div className="mt-3 flex flex-wrap justify-center gap-2">{examples.map((example) => <button key={example} onClick={() => onExample?.(example)} className="min-h-9 rounded-full border border-line bg-surface px-3 text-[11px] font-bold">{example}</button>)}</div></div>;
  return <div className="space-y-3">{items.map((item) => {
    const status = item.needsReview || item.reviewState === 'review'
      ? { label: 'نیازمند بررسی', classes: 'bg-warn-bg text-expense' }
      : ['reviewed', 'duplicate-confirmed'].includes(item.reviewState)
        ? { label: 'بررسی‌شده', classes: 'bg-accent/10 text-accent' }
        : { label: 'دریافت/پرداخت ذخیره‌شده', classes: 'bg-income/10 text-income' };
    return (
    <button type="button" key={item.id} onClick={() => onSelect?.(item)} className="flex min-h-[76px] w-full items-center justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-4 text-right hover:border-accent">
      <div className="min-w-0"><div className="flex items-center gap-2"><p className={`numbers text-lg font-bold ${item.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatSignedAmount(item)}</p><span className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${status.classes}`}>{status.label}</span></div><p className="mt-2 line-clamp-2 text-[13px] leading-7 text-muted">{item.rawText}</p></div>
      <div className="shrink-0 text-left"><span className="inline-block rounded-md border border-line bg-surface px-2 py-1 text-[12px]">{item.category}</span><p className="mt-1 text-[12px] text-muted">{clock(item.occurredAt)}</p><p className="mt-2 text-xs font-bold text-accent">مسیر ثبت و سند ←</p></div>
    </button>
  ); })}</div>;
}

export function CloseDaySheet({ data, close, onComplete }) {
  const preview = data.closingPreview || { day: '', expectedCash: 0 };
  const existing = data.closings?.find((item) => item.day === preview.day) || null;
  const [step, setStep] = useState(0);
  const [countedCash, setCountedCash] = useState(existing ? String(existing.countedCash) : '');
  const [note, setNote] = useState(existing?.note || '');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const difference = closingDifference(preview.expectedCash, countedCash);
  const suspiciousCount = data.transactions.filter((item) => item.needsReview).length;
  const noteRequired = difference !== 0 && note.trim().length < 3;
  const submit = async () => {
    setSaving(true);
    try {
      const response = await api.closeDay({ day: preview.day, countedCash: Number(countedCash), note: note.trim() });
      setResult(response.item);
      setStep(3);
    } catch (error) { setResult({ error: error.message }); }
    finally { setSaving(false); }
  };
  const stepTitle = ['مرور پیش از شمارش', 'شمارش پول واقعی', 'بررسی اختلاف', 'روز بسته شد'][step];
  return <div className="fixed inset-0 z-[72] flex items-end justify-center bg-ink/40 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) close(); }}><section role="dialog" aria-modal="true" aria-label="بستن روز" className="sheet-in max-h-[94vh] w-full max-w-[620px] overflow-y-auto rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl"><div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" /><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-extrabold text-accent">بستن امروز · مرحله {toPersianDigits(Math.min(step + 1, 3))} از ۳</p><h2 className="mt-1 text-xl font-extrabold">{stepTitle}</h2></div><button disabled={saving} onClick={close} className="tap grid place-items-center" aria-label="بستن"><X /></button></div><div className="mt-4 grid grid-cols-3 gap-1">{[0, 1, 2].map((item) => <span key={item} className={`h-1.5 rounded-full ${item <= Math.min(step, 2) ? 'bg-accent' : 'bg-line'}`} />)}</div>
    {step === 0 && <div className="mt-5 space-y-3"><p className="text-sm leading-7 text-muted">بستن روز، دوره حسابداری را قفل نمی‌کند؛ فقط نتیجه شمارش صندوق و اختلاف آن را با دفتر ثبت می‌کند.</p><div className="divide-y divide-line rounded-[10px] border border-line bg-surface px-3 text-sm"><div className="flex justify-between py-3"><span className="text-muted">ثبت‌های امروز</span><b>{toPersianDigits(data.transactions.length)} مورد</b></div><div className="flex justify-between py-3"><span className="text-muted">نیازمند بازبینی</span><b className={suspiciousCount ? 'text-expense' : 'text-income'}>{toPersianDigits(suspiciousCount)} مورد</b></div><div className="flex justify-between py-3"><span className="text-muted">سررسید عقب‌افتاده</span><b className={data.overview.overdue ? 'text-expense' : 'text-income'}>{toPersianDigits(data.overview.overdue || 0)} مورد</b></div></div>{existing && <p className="rounded-lg bg-warn-bg px-3 py-2 text-xs leading-6 text-expense">امروز قبلاً بسته شده؛ ثبت دوباره نتیجه شمارش قبلی را با سابقه حسابرسی به‌روزرسانی می‌کند.</p>}<button onClick={() => setStep(1)} className="tap w-full rounded-lg bg-accent font-extrabold text-white">شروع شمارش صندوق</button></div>}
    {step === 1 && <div className="mt-5"><p className="text-sm leading-7 text-muted">فقط پول واقعی داخل صندوق را وارد کن؛ مانده بانکی و کیف پول در این شمارش نیست.</p><label className="mt-4 block text-xs font-bold text-muted">موجودی شمارش‌شده صندوق<input autoFocus inputMode="numeric" value={countedCash} onChange={(event) => setCountedCash(event.target.value.replace(/\D/g, ''))} placeholder="مثلاً ۱۲۵۰۰۰۰۰" className="tap numbers mt-2 w-full rounded-[10px] border border-line bg-surface px-3 text-center text-2xl font-extrabold outline-none focus:border-accent" /></label><p className="mt-2 text-center text-xs text-muted">تومان</p><div className="mt-5 grid grid-cols-[1fr_2fr] gap-2"><button onClick={() => setStep(0)} className="tap rounded-lg border border-line font-bold">قبلی</button><button disabled={!countedCash} onClick={() => setStep(2)} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">دیدن اختلاف</button></div></div>}
    {step === 2 && <div className="mt-5"><div className={`rounded-[12px] border p-4 text-center ${difference === 0 ? 'border-income/30 bg-income/5' : 'border-expense/25 bg-warn-bg'}`}><p className="text-xs text-muted">اختلاف شمارش با دفتر</p><p className={`numbers mt-2 text-3xl font-extrabold ${difference === 0 ? 'text-income' : 'text-expense'}`}>{difference > 0 ? '+' : difference < 0 ? '−' : ''}{formatAmount(Math.abs(difference))}</p><p className="mt-1 text-xs text-muted">تومان</p><p className="mt-3 text-xs leading-6 text-muted">دفتر {formatAmount(preview.expectedCash)} · شمارش {formatAmount(Number(countedCash))} تومان</p></div>{difference !== 0 && <label className="mt-4 block text-xs font-bold text-muted">علت احتمالی اختلاف<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="مثلاً ۵۰ هزار تومان تنخواه هنوز ثبت نشده" className="mt-2 min-h-20 w-full rounded-[10px] border border-line bg-surface p-3 text-sm font-normal outline-none focus:border-accent" /></label>}{result?.error && <p role="alert" className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-sm text-expense">{result.error}</p>}<div className="mt-5 grid grid-cols-[1fr_2fr] gap-2"><button disabled={saving} onClick={() => setStep(1)} className="tap rounded-lg border border-line font-bold">اصلاح شمارش</button><button disabled={saving || noteRequired} onClick={submit} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">{saving ? 'در حال ثبت…' : difference === 0 ? 'تأیید و بستن امروز' : noteRequired ? 'علت اختلاف را بنویس' : 'ثبت اختلاف و بستن'}</button></div></div>}
    {step === 3 && <div className="mt-6 text-center"><div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-income/10 text-income"><Check size={32} /></div><h3 className="mt-4 text-xl font-extrabold">نتیجه شمارش ثبت شد</h3><p className="mt-2 text-sm leading-7 text-muted">اختلاف {formatAmount(Math.abs(result?.difference || 0))} تومان همراه با یادداشت در سابقه صندوق باقی می‌ماند.</p><button onClick={() => onComplete(result)} className="tap mt-5 w-full rounded-lg bg-ink font-extrabold text-white">بازگشت به امروز</button></div>}
  </section></div>;
}

function Recorder({ state, start, stop, cancel, levels, liveTranscript, liveVoiceNote, livePreview, fastVoiceAvailable, voicePath = 'ready', voiceSystemStatus, disabled = false, showDiagnostics = false }) {
  const recording = state === 'recording';
  const processing = state === 'processing';
  const requesting = state === 'requesting';
  const finalizing = state === 'finalizing';
  const pointerRef = useRef({ action: '', startedAt: 0 });
  /**
   * وضعیت مسیرهای صدا فقط در محیط حرفه‌ای.
   *
   * «فایل پشتیبان: تنظیم نشده» تشخیص زیرساخت است، نه چیزی که صاحب کسب‌وکار
   * بتواند دربارهٔ آن کاری کند — و چون هشدارگونه دیده می‌شود، اولین برداشتش از
   * برنامه این است که چیزی خراب است. همان «لاگ فنی» که نباید ببیند.
   */
  const availability = !showDiagnostics ? [] : voiceSystemStatus
    ? describeVoiceAvailability(voiceSystemStatus, { browserSupported: liveSpeechSupported() })
    : [{ tone: 'neutral', label: 'در حال بررسی مسیرهای صدا…' }];
  const press = (event) => {
    if (disabled || processing || finalizing || requesting) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    if (recording) {
      pointerRef.current = { action: 'stopped', startedAt: Date.now() };
      stop();
      return;
    }
    pointerRef.current = { action: 'started', startedAt: Date.now() };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start();
  };
  const release = (event) => {
    event?.preventDefault?.();
    const gesture = pointerRef.current;
    pointerRef.current = { action: '', startedAt: 0 };
    if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (gesture.action === 'started' && pointerReleaseAction(Date.now() - gesture.startedAt) === 'stop') stop();
  };
  const cancelPointer = (event) => {
    event?.preventDefault?.();
    const started = pointerRef.current.action === 'started';
    pointerRef.current = { action: '', startedAt: 0 };
    if (started) stop();
  };
  const keyDown = (event) => {
    if (disabled || ![' ', 'Enter'].includes(event.key) || event.repeat || processing || finalizing || requesting) return;
    event.preventDefault();
    if (event.key === 'Enter' && recording) stop();
    else start();
  };
  const keyUp = (event) => {
    if (event.key !== ' ') return;
    event.preventDefault();
    stop();
  };
  return (
    <section className="voice-dock flex flex-col items-center py-2">
      <div className="mb-2 flex max-w-full flex-wrap items-center justify-center gap-1.5 text-[11px]">
        <span className={`rounded-full border px-2.5 py-1 font-bold ${['browser-live', 'realtime-live'].includes(voicePath) ? 'border-income/40 bg-income/10 text-income' : 'border-line bg-surface text-muted'}`}>{voicePathLabel(voicePath)}</span>
        {!recording && !requesting && !finalizing && !processing && availability.map((item) => <span key={item.label} className={`rounded-full border px-2.5 py-1 ${item.tone === 'good' ? 'border-income/30 text-income' : item.tone === 'warn' ? 'border-accent/40 text-accent' : 'border-line text-muted'}`}>{item.label}</span>)}
      </div>
      {(recording || finalizing) && liveTranscript && <div aria-live="polite" className="mb-3 w-full rounded-[10px] border border-line bg-surface px-3 py-3 text-right"><p className="truncate text-sm text-muted">شنیدم: «{liveTranscript}»</p>{livePreview.length > 0 && <p className="numbers mt-2 text-lg font-extrabold text-ink">{livePreview.map((item) => formatAmount(item.amount)).join(' + ')} <span className="font-normal text-[12px] text-muted">تومان</span></p>}</div>}
      {(recording || finalizing) && liveVoiceNote && <p role="status" className="mb-3 rounded-lg bg-warn-bg px-3 py-2 text-center text-[13px] leading-6 text-expense">{liveVoiceNote}</p>}
      <p className="mb-3 text-center text-[13px] text-muted">{disabled ? 'ضبط برای نقش فقط مشاهده غیرفعال است' : recording ? (fastVoiceAvailable ? 'در حال ضبط زنده — دوباره لمس کن یا اگر نگه داشته‌ای، رها کن' : 'در حال ضبط — دوباره لمس کن تا تمام شود') : processing ? 'صدای ضبط‌شده در حال تبدیل به متن است…' : finalizing ? 'در حال نهایی‌کردن عدد…' : requesting ? 'میکروفن در حال فعال‌شدن است…' : 'یک‌بار لمس کن و صحبت کن؛ یا نگه دار و برای پایان رها کن'}</p>
      <button
        type="button" aria-pressed={recording} aria-label={processing ? 'لغو پردازش' : recording ? 'پایان ضبط' : 'شروع ضبط صوتی'} disabled={disabled || finalizing}
        onClick={processing ? cancel : undefined}
        onPointerDown={press} onPointerUp={release} onPointerCancel={cancelPointer}
        onKeyDown={keyDown} onKeyUp={keyUp}
        onContextMenu={(event) => event.preventDefault()} onDragStart={(event) => event.preventDefault()}
        className={`relative grid touch-none select-none place-items-center rounded-full text-white shadow-paper transition-all disabled:opacity-70 ${recording ? 'record-pulse h-20 w-20 bg-expense' : processing ? 'h-[72px] w-[72px] bg-expense' : 'h-[72px] w-[72px] bg-accent'}`}
      >
        {processing ? <X size={30} /> : requesting || finalizing ? <span className="h-7 w-7 animate-spin rounded-full border-2 border-white/35 border-t-white" /> : <Mic size={31} fill="currentColor" strokeWidth={1.8} />}
      </button>
      {processing && <button onClick={cancel} className="tap mt-2 px-4 text-sm font-bold text-expense">لغو پردازش</button>}
      <div aria-hidden="true" className={`mt-4 flex h-12 items-center gap-1.5 transition-opacity ${recording ? 'opacity-100' : 'opacity-0'}`}>
        {levels.map((level, index) => <span key={index} className="w-1.5 rounded-full bg-expense transition-[height] duration-75" style={{ height: level }} />)}
      </div>
    </section>
  );
}

/**
 * کلید «همه را اول AI بفهمد».
 *
 * روشن: هر گفته اول به فهم رویداد با AI می‌رود و خروجی ساخت‌یافته‌اش به موتور
 * قاعده و پارسر داده می‌شود؛ خاموش: فقط گفته‌های مرکب. تغییرش سیاست دفتر است،
 * پس فقط مالک و مدیر می‌توانند؛ بقیه وضعیت را می‌بینند.
 */
function AiForAllToggle({ state, toggle }) {
  const blocked = !state.available ? 'کلید سرویس AI روی سرور تنظیم نشده است.'
    : !state.canManage ? 'فقط مالک یا مدیر دفتر می‌تواند این را تغییر دهد.'
      : '';
  const note = state.on && !state.online ? 'آفلاین هستی؛ تا وصل شوی گفته‌ها از مسیر سریع بررسی می‌شوند.'
    : state.on ? 'هر گفته اول با AI فهمیده می‌شود و بعد موتور قاعده سندش را می‌سازد. کمی کندتر و از سهمیهٔ AI.'
      : 'فقط گفته‌های مرکب به AI می‌روند؛ بقیه از مسیر سریع و رایگان.';
  return <div className="mt-3 flex items-center justify-between gap-3 rounded-[10px] border border-line bg-surface/70 px-3 py-2">
    <div className="min-w-0">
      <p className="text-[12px] font-extrabold">همه را اول AI بفهمد</p>
      <p className="mt-0.5 text-[11px] leading-5 text-muted">{blocked || note}</p>
    </div>
    <button type="button" role="switch" aria-checked={state.on} aria-label="همه را اول AI بفهمد"
      disabled={Boolean(blocked) || state.busy} onClick={toggle}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-40 ${state.on ? 'bg-accent' : 'bg-line'}`}>
      <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${state.on ? 'right-1' : 'right-6'}`} />
    </button>
  </div>;
}
