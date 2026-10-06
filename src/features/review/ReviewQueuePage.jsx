import { ReviewAssistant } from './ReviewAssistant.jsx';
import { UnidentifiedFundsPanel } from './UnidentifiedFundsPanel.jsx';
import { Check } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ConfidencePanel } from '../capture/CaptureSheets.jsx';
import { ROUTE_LABELS } from '../../../shared/confidenceEngine.js';
import { api } from '../../lib/api.js';
import { formatAmount, persianDate, toPersianDigits } from '../../lib/format.js';

const ROUTE_STYLE = {
  'accountant-review': 'border-expense/40 bg-expense/5 text-expense',
  confirm: 'border-accent/40 bg-accent/5 text-accent',
  auto: 'border-income/40 bg-income/5 text-income',
};

/**
 * یک ردیف از صف بررسی.
 *
 * چرا تاریخچه فقط با درخواست باز می‌شود: صف ممکن است ده‌ها ردیف داشته باشد و
 * گرفتن تاریخچهٔ همه، هم کند است و هم چیزی است که حسابدار فقط برای موارد
 * مشکوک می‌خواهد.
 */
/**
 * کارت سؤال — وقتی موتور یک واقعیت لازم را ندارد.
 *
 * گزینه، هرجا که جواب شمردنی باشد. کاربری که روی «از اول ماه بعد» می‌زند هیچ
 * جمله‌ای برای تفسیر باقی نمی‌گذارد، و جواب از همان اول به مورد درست چسبیده
 * است چون روی کارت خودش زده شده.
 *
 * هر بار فقط یک سؤال. فرم یعنی کاربر باید همه را با هم بداند، و کسی که یکی را
 * نمی‌داند کل کار را رها می‌کند.
 */
function OriginalTranscript({text}) {
  return <section aria-label="متن اصلی گفتهٔ کاربر" className="mt-3 rounded-lg border border-line bg-paper p-3">
    <p className="text-xs font-extrabold text-ink">متن اصلی گفتهٔ کاربر</p>
    <p className="mt-1 text-[11px] text-muted">متن ذخیره‌شده هنگام دریافت؛ مبنای بررسی حسابدار</p>
    {text ? <blockquote dir="auto" className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-7 text-ink">{text}</blockquote>
      : <p className="mt-2 text-xs text-muted">متن اصلی برای این مورد ذخیره نشده است.</p>}
  </section>;
}

function QuestionCard({ question, busy, onAnswer }) {
  const [text, setText] = useState('');
  const [freeFor, setFreeFor] = useState(null);

  return <div className="mt-2 rounded-[10px] border border-accent/40 bg-accent/5 p-3">
    <p className="text-[12px] font-extrabold text-ink">{question.text}</p>
    {question.kind === 'options'
      ? <div className="mt-2 flex flex-wrap gap-1.5">
          {question.options.map((option) => <button
            key={String(option.value)}
            disabled={busy}
            onClick={() => (option.freeInput ? setFreeFor(option) : onAnswer({ fact: question.fact, value: option.value }))}
            className="tap rounded-lg border border-line bg-paper px-3 py-1 text-[12px] font-bold disabled:opacity-40">
            {option.label}
          </button>)}
        </div>
      : <div className="mt-2 flex gap-1.5">
          <input value={text} onChange={(event) => setText(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-1 text-[12px]" />
          <button disabled={busy || !text.trim()} onClick={() => onAnswer({ fact: question.fact, freeText: text.trim() })}
            className="tap rounded-lg bg-accent px-3 text-[12px] font-bold text-white disabled:opacity-40">ثبت پاسخ</button>
        </div>}

    {/* گزینهٔ «خودم می‌گویم» یک مقدار نیست؛ ورودی آزاد می‌خواهد. */}
    {freeFor && <div className="mt-2 flex gap-1.5">
      <input value={text} onChange={(event) => setText(event.target.value)} placeholder={freeFor.label}
        className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-1 text-[12px]" />
      <button disabled={busy || !text.trim()} onClick={() => onAnswer({ fact: question.fact, value: freeFor.value, freeText: text.trim() })}
        className="tap rounded-lg bg-accent px-3 text-[12px] font-bold text-white disabled:opacity-40">ثبت پاسخ</button>
    </div>}
  </div>;
}

function ReviewedCompositeEditor({ item, ai, onSaved, notify }) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [analytics, setAnalytics] = useState([]);
  const [costCenters, setCostCenters] = useState([]);
  const [lines, setLines] = useState([{ accountId: '', debit: '', credit: '', analyticId: '', costCenterId: '' }, { accountId: '', debit: '', credit: '', analyticId: '', costCenterId: '' }]);
  const [reason, setReason] = useState('');
  const [aiAccepted, setAiAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const digits = (value) => String(value ?? '').replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))).replace(/[,،\s]/g, '');
  const updateLine = (index, patch) => setLines((current) => current.map((line, position) => position === index ? { ...line, ...patch } : line));
  const openEditor = async () => {
    if (open) { setOpen(false); return; }
    try {
      const [ledger, chart] = await Promise.all([api.accountingAccounts(), api.chartOverview()]);
      setAccounts(ledger.items.filter((account) => account.active));
      setAnalytics((chart.analytics || []).filter((analytic) => analytic.active));
      setCostCenters((chart.costCenters || []).filter((center) => center.active));
      setOpen(true);
    } catch (failure) { notify(failure.message); }
  };
  const useSuggestion = () => {
    if (ai?.state !== 'proposed' || ai.missingFacts?.length) return;
    setLines(ai.lines.map((line) => ({ accountId: '', debit: line.debit || '', credit: line.credit || '', analyticId: '', costCenterId: '' })));
    setAiAccepted(true);
  };
  const submit = async () => {
    setError('');
    const parsed = lines.map((line) => ({ accountId: line.accountId, debit: Number(digits(line.debit || 0)), credit: Number(digits(line.credit || 0)), analyticId: line.analyticId || null, costCenterId: line.costCenterId || null }));
    if (reason.trim().length < 8 || parsed.some((line) => !line.accountId || !Number.isSafeInteger(line.debit) || !Number.isSafeInteger(line.credit))) {
      setError('برای هر سطر حساب و مبلغ معتبر، و برای سند دلیل حداقل هشت نویسه‌ای وارد کن.'); return;
    }
    setSaving(true);
    try {
      await api.reviewedJournal(item.id, { lines: parsed, reason: reason.trim(), proposalId: ai?.state === 'proposed' ? ai.id : '', aiAccepted });
      notify('سند بررسی‌شده با ردپای تصمیم حسابدار ثبت شد.');
      await onSaved();
    } catch (failure) { setError(failure.message); }
    setSaving(false);
  };
  return <div className="mt-2 rounded-lg border border-accent/40 bg-accent/5 p-3 text-[12px]">
    <button onClick={openEditor} className="tap font-bold text-accent">{open ? 'بستن ثبت بررسی‌شده' : 'تعیین سطرهای قطعی و ثبت توسط حسابدار'}</button>
    {open && <div className="mt-2 space-y-2">
      <p className="text-muted">مبلغ بالای کارت فقط مرجع است. هر سطر سند و حسابش را از متن کامل تعیین کن؛ سند متوازن و دورهٔ باز الزامی است.</p>
      {item.event?.utterance && <blockquote className="rounded border border-line bg-paper p-2">«{item.event.utterance}»</blockquote>}
      {ai?.state === 'proposed' && <button disabled={saving || ai.missingFacts?.length > 0} onClick={useSuggestion} className="tap rounded border border-accent px-2 py-1 text-accent disabled:opacity-40">برداشتن مبالغ پیشنهاد AI برای بازبینی</button>}
      {lines.map((line, index) => <div key={index} className="flex flex-wrap gap-1.5">
        <select aria-label={`حساب سطر ${index + 1}`} value={line.accountId} onChange={(event) => {
          const selected = accounts.find((account) => account.id === event.target.value);
          const analytic = analytics.find((entry) => entry.sourceKind === 'contact' && entry.sourceKey === selected?.sourceKey);
          updateLine(index, { accountId: event.target.value, analyticId: analytic?.id || '' });
        }} className="min-w-[160px] flex-1 rounded border border-line bg-paper p-2">
          <option value="">انتخاب سرفصل سطر {toPersianDigits(index + 1)}</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
        </select>
        <input aria-label={`بدهکار سطر ${index + 1} به تومان`} inputMode="numeric" placeholder="بدهکار (تومان)" value={line.debit} onChange={(event) => updateLine(index, { debit: event.target.value, credit: '' })} className="w-32 rounded border border-line bg-paper p-2" />
        <input aria-label={`بستانکار سطر ${index + 1} به تومان`} inputMode="numeric" placeholder="بستانکار (تومان)" value={line.credit} onChange={(event) => updateLine(index, { credit: event.target.value, debit: '' })} className="w-32 rounded border border-line bg-paper p-2" />
        <select aria-label={`تفصیلی سطر ${index + 1}`} value={line.analyticId || ''} onChange={(event) => updateLine(index, { analyticId: event.target.value })} className="min-w-[110px] rounded border border-line bg-paper p-2">
          <option value="">بدون تفصیلی</option>
          {analytics.map((analytic) => <option key={analytic.id} value={analytic.id}>{analytic.code} · {analytic.name}</option>)}
        </select>
        <select aria-label={`مرکز هزینه سطر ${index + 1}`} value={line.costCenterId || ''} onChange={(event) => updateLine(index, { costCenterId: event.target.value })} className="min-w-[110px] rounded border border-line bg-paper p-2">
          <option value="">بدون مرکز هزینه</option>
          {costCenters.map((center) => <option key={center.id} value={center.id}>{center.code} · {center.name}</option>)}
        </select>
        {lines.length > 2 && <button onClick={() => setLines((current) => current.filter((_, position) => position !== index))} className="tap px-2 text-expense">حذف</button>}
      </div>)}
      {lines.length < 12 && <button onClick={() => setLines((current) => [...current, { accountId: '', debit: '', credit: '', analyticId: '', costCenterId: '' }])} className="tap rounded border border-line px-2 py-1">افزودن سطر</button>}
      {ai?.state === 'proposed' && <label className="flex items-center gap-2"><input type="checkbox" checked={aiAccepted} disabled={ai.missingFacts?.length > 0} onChange={(event) => setAiAccepted(event.target.checked)} />مبالغ پیشنهاد AI را پس از انتخاب حساب‌ها تأیید می‌کنم؛ در صورت اصلاح، دلیل را می‌نویسم.</label>}
      <textarea aria-label="دلیل و مبنای ثبت حسابدار" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="مبنای حسابداری و اطلاعات بررسی‌شده" className="w-full rounded border border-line bg-paper p-2" rows={2} />
      {error && <p className="text-expense">{error}</p>}
      <button disabled={saving} onClick={submit} className="tap rounded bg-accent px-3 py-1.5 font-bold text-white disabled:opacity-40">{saving ? 'در حال ثبت…' : 'ثبت سند قطعی با دلیل'}</button>
    </div>}
  </div>;
}

function ReviewQueueRow({ item, busy, onApprove, onReject, onAnswered, notify, navigate }) {
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState(null);
  const [decision, setDecision] = useState(null);
  const [ai, setAi] = useState(item.aiProposal || null);
  const confidence = item.confidence || {};

  // تصمیم فقط برای ردیف‌هایی خوانده می‌شود که واقعاً تصمیمی دارند. صف ممکن است
  // ده‌ها ردیف داشته باشد و اکثرشان از مسیر قدیمی آمده‌اند.
  useEffect(() => {
    if (!item.decisionId) return;
    api.eventDecision(item.id).then(setDecision).catch(() => setDecision(null));
  }, [item.id, item.decisionId]);

  useEffect(() => { setAi(item.aiProposal || null); }, [item.id, item.aiProposal?.id]);

  const answer = async (payload) => {
    try {
      await api.answerEvent(item.id, payload);
      await onAnswered?.();
    } catch (error) { notify?.(error.message); }
  };

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !trail) {
      try { setTrail((await api.eventAudit(item.id)).items); }
      catch { setTrail([]); }
    }
  };

  return <article className="py-3">
    <div className="flex flex-wrap items-center gap-3">
      <span className={`rounded border px-2 py-0.5 text-[11px] font-bold ${ROUTE_STYLE[item.route] || ROUTE_STYLE.confirm}`}>
        {ROUTE_LABELS[item.route] || 'در انتظار'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-bold">{confidence.summary || item.kind}</p>
        <p className="mt-0.5 text-[11px] text-muted">
          {persianDate(item.occurredAt)} · <span className="numbers">{formatAmount(item.amount)}</span> تومان{item.event?.amountReferenceOnly ? ' (بزرگ‌ترین مبلغ گفته‌شده؛ مبلغ سند هنوز مشخص نیست)' : ''}
          {item.dueAt && <> · سررسید {persianDate(item.dueAt)}</>}
        </p>
      </div>
      <span className={`numbers text-[12px] font-bold ${confidence.percent >= 80 ? 'text-accent' : 'text-expense'}`}>
        {toPersianDigits(confidence.percent ?? 0)}٪
      </span>
      <div className="flex gap-1.5">
        <button disabled={busy} onClick={() => item.approvalBlocked ? setOpen(true) : onApprove(item)} className="tap flex items-center gap-1 rounded-lg bg-accent px-3 text-[12px] font-bold text-white disabled:opacity-40"><Check size={15} />{item.approvalBlocked ? 'تکمیل و اصلاح سند' : 'تأیید و ثبت سند'}</button>
        <button disabled={busy} onClick={() => onReject(item)} className="tap rounded-lg border border-expense/50 px-3 text-[12px] font-bold text-expense disabled:opacity-40">رد</button>
        <button onClick={toggle} className="tap rounded-lg border border-line bg-paper px-3 text-[12px] font-bold">{open ? 'بستن' : 'چرا؟'}</button>
      </div>
    </div>

    <OriginalTranscript text={item.originalTranscript || item.event?.utterance || item.event?.evidence} />
    {item.approvalBlocked && <div className="mt-2 rounded-lg border border-accent/30 bg-accent/5 p-3 text-xs leading-6">
      <p>{item.approvalNextStep === 'answer-question' ? 'ابتدا به سؤال پایین کارت پاسخ بده؛ بعد از تکمیل، امکان ثبت دوباره بررسی می‌شود.' : 'سطرهای این سند هنوز قطعی نیست. پیشنهاد AI را با «تحلیل کن» بگیر و حساب‌ها را بررسی کن.'}</p>
    </div>}
    {/* دلیل توقف، بدون باز کردن جزئیات — همان چیزی که حسابدار اول می‌خواهد بداند. */}
    {!open && confidence.reasons?.length > 0 && <p className="mt-1.5 text-[11px] leading-5 text-muted">• {confidence.reasons[0]}</p>}

    {item.route === 'accountant-review' && <ReviewAssistant item={item} ai={ai} setAi={setAi} onSaved={onAnswered} notify={notify} busy={busy} />}

    {item.event?.kind === 'review-placeholder' && <ReviewedCompositeEditor item={item} ai={ai} onSaved={onAnswered} notify={notify} />}

    {/* سؤال بالاتر از جزئیات می‌نشیند: تا جوابش نیامده، بقیه‌اش موضوعیت ندارد. */}
    {decision?.decision?.question && <QuestionCard question={decision.decision.question} busy={busy} onAnswer={answer} />}

    {/* برنامهٔ تخصیص، وقتی ساخته شده — همان چیزی که ثابت می‌کند مبلغ یک‌جا هزینه نشد. */}
    {decision?.schedule?.length > 0 && <p className="mt-1.5 text-[11px] text-muted">
      برنامهٔ شناسایی: <span className="numbers">{toPersianDigits(decision.schedule.length)}</span> قلم ماهانه،
      از {decision.schedule[0].periodKey} تا {decision.schedule[decision.schedule.length - 1].periodKey}
    </p>}

    {open && <div className="mt-2">
      <ConfidencePanel assessment={{ percent: confidence.percent ?? 0, fields: confidence.components || {}, reasons: confidence.reasons || [] }} />
      <div className="mt-3 rounded-[10px] border border-line bg-surface p-3">
        <p className="text-xs font-extrabold">تاریخچهٔ رویداد</p>
        {trail === null && <p className="mt-2 text-[11px] text-muted">در حال خواندن…</p>}
        {trail?.length === 0 && <p className="mt-2 text-[11px] text-muted">رویدادی ثبت نشده است.</p>}
        {trail?.map((entry, index) => <p key={`${entry.stage}-${index}`} className="mt-1.5 text-[11px] leading-5 text-muted">
          <b className="text-ink">{entry.stage}</b> · {persianDate(entry.createdAt)}
        </p>)}
      </div>
    </div>}
  </article>;
}

/**
 * صف بررسی حسابدار.
 *
 * این صفحه فقط رویدادهای «در انتظار» را نشان می‌دهد؛ یعنی چیزهایی که موتور
 * اطمینان جلوی ثبت خودکارشان را گرفته است. سند این‌ها هنوز زده نشده و تأیید
 * حسابدار همان لحظه سند را می‌زند.
 */
/**
 * تنظیم قوانین ثبت خودکار.
 *
 * کنار صف بررسی می‌نشیند چون همین اعداد تعیین می‌کنند چه چیزی وارد این صف
 * می‌شود؛ جای دیگری، حسابدار باید بین دو صفحه رفت‌وبرگشت کند تا اثر تغییرش را
 * ببیند.
 */
function AutomationPolicyPanel({ canManage, notify, onChanged }) {
  const [policy, setPolicy] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => { api.automationPolicy().then((result) => setPolicy(result.policy)).catch(() => setPolicy(null)); }, []);

  if (!policy) return null;
  const percent = (value) => toPersianDigits(Math.round(value * 100));

  const save = async (changes) => {
    setBusy(true);
    try {
      const result = await api.saveAutomationPolicy({ ...policy, ...changes });
      setPolicy(result.policy);
      notify('قانون ثبت خودکار به‌روز شد.');
      await onChanged?.();
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  const everythingReviewed = policy.manualOnly === true;

  return <section className="mt-4 rounded-[10px] border border-line bg-paper p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="text-xs font-extrabold">قانون ثبت خودکار</p>
        <p className="mt-0.5 text-[11px] text-muted">
          {everythingReviewed
            ? 'الان هیچ ثبتی بدون تأیید وارد دفتر نمی‌شود.'
            : <>بالای <span className="numbers">{percent(policy.autoThreshold)}</span>٪ خودکار · از <span className="numbers">{percent(policy.confirmThreshold)}</span>٪ سؤال از کاربر · پایین‌تر، همین صف</>}
        </p>
      </div>
      {canManage && <button onClick={() => setOpen(!open)} className="tap rounded-lg border border-line bg-surface px-3 text-[12px] font-bold">{open ? 'بستن' : 'تغییر'}</button>}
    </div>
    {!canManage && <p className="mt-2 text-[11px] text-muted">تغییر این قانون با نقش مدیر است.</p>}

    {open && canManage && <div className="mt-3 space-y-3 border-t border-line pt-3">
      {/*
        موتور تصمیم، دفتر‌به‌دفتر.
        روشن که باشد، پیش از نگاه به اطمینان، ماهیت رویداد سنجیده می‌شود: پرداختی
        که ممکن است پیش‌پرداخت باشد تا روشن نشدن دوره‌اش ثبت نمی‌شود و یک سؤال
        کوتاه می‌سازد. در پایلوت عمداً خاموش است.
      */}
      <div className={`rounded-lg border p-3 ${policy.engineV2 ? 'border-accent bg-accent/5' : 'border-line bg-surface'}`}>
        <p className="text-[12px] font-extrabold">تشخیص ماهیت رویداد {policy.engineV2 ? '— روشن' : '— خاموش'}</p>
        <p className="mt-1 text-[11px] leading-5 text-muted">
          به‌جای «هر پرداختی هزینه است»، اول می‌پرسد این رویداد از نظر اقتصادی چیست.
          اگر چیزی لازم باشد و ندانَد، یک سؤال کوتاه می‌پرسد و تا جواب نیامده ثبت نمی‌کند.
        </p>
        <button disabled={busy} onClick={() => save({ engineV2: !policy.engineV2 })}
          className={`tap mt-2 w-full rounded-lg border px-3 text-[12px] font-bold ${policy.engineV2 ? 'border-line bg-paper' : 'border-accent bg-accent text-white'}`}>
          {policy.engineV2 ? 'خاموش کن' : 'روشن کن'}
        </button>

        {/*
          شادو مود زیر همان کادر می‌نشیند چون بدون موتور تصمیم بی‌معناست، و
          مهم‌ترین نکته‌اش همان جمله‌ای است که نوشته شده: دفتر دست نمی‌خورد.
          کسی که این را روشن می‌کند باید مطمئن باشد هیچ ریسکی ندارد، وگرنه
          روی دفتر واقعی روشنش نمی‌کند — و تنها جایی که این اندازه‌گیری ارزش
          دارد همان دفتر واقعی است.
        */}
        {policy.engineV2 && <div className="mt-3 border-t border-line pt-3">
          <p className="text-[12px] font-extrabold">ضبط بدون ثبت {policy.shadowMode ? '— روشن' : '— خاموش'}</p>
          <p className="mt-1 text-[11px] leading-5 text-muted">
            موتور برای هر ثبت نظرش را می‌دهد و ذخیره می‌کند، ولی سند همان‌طور که تا امروز می‌خورده می‌خورد.
            <b className="text-ink"> دفتر دست نمی‌خورد.</b> بعد می‌شود دید موتور کجا با تو اختلاف داشته.
          </p>
          <button disabled={busy} onClick={() => save({ shadowMode: !policy.shadowMode })}
            className={`tap mt-2 w-full rounded-lg border px-3 text-[12px] font-bold ${policy.shadowMode ? 'border-line bg-paper' : 'border-accent bg-accent/10 text-accent'}`}>
            {policy.shadowMode ? 'خاموش کن' : 'روشن کن'}
          </button>
        </div>}
      </div>

      <button disabled={busy} onClick={() => save({ manualOnly: !everythingReviewed })}
        className={`tap w-full rounded-lg border px-3 text-[12px] font-bold ${everythingReviewed ? 'border-line bg-surface' : 'border-accent bg-accent/5 text-accent'}`}>
        {everythingReviewed ? 'برگرد به ثبت خودکار بالای ۹۵٪' : 'هیچ‌چیز بدون تأیید من ثبت نشود'}
      </button>

      {[['autoThreshold', 'آستانهٔ ثبت خودکار'], ['confirmThreshold', 'آستانهٔ سؤال از کاربر'], ['minimumAmountCertainty', 'حداقل اطمینان مبلغ']].map(([key, label]) =>
        <label key={key} className="block">
          <span className="text-[11px] font-bold text-muted">{label}</span>
          <span className="mt-1 flex items-center gap-2">
            <input
              type="range" min="0" max="100" step="1" disabled={busy}
              value={Math.round(policy[key] * 100)}
              onChange={(event) => setPolicy({ ...policy, [key]: Number(event.target.value) / 100 })}
              onMouseUp={(event) => save({ [key]: Number(event.target.value) / 100 })}
              onTouchEnd={(event) => save({ [key]: Number(event.target.value) / 100 })}
              className="flex-1"
            />
            <b className="numbers w-10 text-[12px]">{percent(policy[key])}٪</b>
          </span>
        </label>)}

      <label className="flex items-center gap-2 text-[12px]">
        <input type="checkbox" disabled={busy} checked={policy.allowAiOnlyAutoPost}
          onChange={(event) => save({ allowAiOnlyAutoPost: event.target.checked })} />
        برداشت مدل زبانی به‌تنهایی اجازهٔ ثبت خودکار داشته باشد
      </label>
      <p className="text-[11px] leading-5 text-muted">
        وقتی خاموش است، برداشتی که هیچ شاهد دیگری — پارسر محلی، تطبیق بانکی یا سابقهٔ پرونده — پشتش نباشد
        هرگز بی‌پرسش ثبت نمی‌شود.
      </p>
    </div>}
  </section>;
}

function UnquantifiedReviewCard({ item, notify, onSaved }) {
  const [reason, setReason] = useState('');
  const [journalEntryId, setJournalEntryId] = useState('');
  const [busy, setBusy] = useState(false);
  const resolve = async () => {
    setBusy(true);
    try { await api.resolveUnquantifiedReview(item.id, { reason, journalEntryId }); await onSaved(); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  return <article className="space-y-2 py-3 text-sm">
    <p className="font-bold">درخواست پیگیری حسابدار — مبلغ مشخص نشده</p>
    <OriginalTranscript text={item.transcript} />
    <p className="text-muted">شناسه پیگیری: {item.id} — هیچ سند یا مبلغ فرضی ثبت نشده است. ابتدا مبلغ، تاریخ و سند مبنا را بررسی کن.</p>
    <input className="w-full rounded border border-line p-2" value={journalEntryId} onChange={e => setJournalEntryId(e.target.value)} placeholder="شناسه سند مرتبط در صورت ثبت اصلاح توسط حسابدار (اختیاری)" />
    <textarea className="w-full rounded border border-line p-2" value={reason} onChange={e => setReason(e.target.value)} placeholder="نتیجه بررسی و دلیل بستن پرونده" />
    <button disabled={busy || reason.trim().length < 8} onClick={resolve} className="tap rounded bg-accent px-3 text-white disabled:opacity-40">ثبت نتیجه بررسی و بستن پرونده</button>
  </article>;
}

export function ReviewQueuePage({ notify, access, navigate, refresh }) {
  const [items, setItems] = useState(null);
  const [dnaSummary,setDnaSummary] = useState(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try { const result=await api.reviewQueue();setItems(result.items);setDnaSummary(result.dnaSummary);await refresh?.(); }
    catch (error) { notify(error.message); setItems([]); }
  }, [notify,refresh]);

  useEffect(() => { load(); }, [load]);

  const approve = async (item) => {
    setBusy(item.id);
    try { await api.approveEvent(item.id); notify('سند ثبت شد.'); await load(); }
    catch (error) {
      if (error.code !== 'EVENT_OVERRIDE_REASON_REQUIRED') notify(error.message);
      else {
        const reason = window.prompt(`${error.message}\n\nدلیل ثبت:`);
        if (reason?.trim()) {
          try { await api.approveEvent(item.id, reason.trim()); notify('سند با دلیل ثبت شد.'); await load(); }
          catch (retry) { notify(retry.message); }
        }
      }
    }
    setBusy('');
  };

  const reject = async (item) => {
    // رد کردن پاک کردن نیست: رویداد با دلیلش در تاریخچه می‌ماند.
    const reason = window.prompt('دلیل رد این مورد چیست؟');
    if (!reason) return;
    setBusy(item.id);
    try { await api.rejectEvent(item.id, reason); notify('مورد رد شد و دلیلش ثبت شد.'); await load(); }
    catch (error) { notify(error.message); }
    setBusy('');
  };

  const needsAccountant = (items || []).filter((item) => item.route === 'accountant-review').length;

  return <section className="mt-5 rounded-[10px] border border-line bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-bold">صف بررسی</p>
      {items && items.length > 0 && <div className="flex flex-wrap gap-1.5 text-[12px]">
        <span className={`rounded border px-2 py-0.5 font-bold ${ROUTE_STYLE['accountant-review']}`}>نیازمند بررسی: <span className="numbers">{toPersianDigits(needsAccountant)}</span></span>
        <span className={`rounded border px-2 py-0.5 font-bold ${ROUTE_STYLE.confirm}`}>در انتظار تأیید: <span className="numbers">{toPersianDigits(items.length - needsAccountant)}</span></span>
      </div>}
    </div>

    <p className="mt-3 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] leading-6 text-muted">
      این‌ها مواردی‌اند که سیستم به‌جای حدس زدن، ثبتشان را متوقف کرده است. سند هیچ‌کدام هنوز زده نشده
      ثبت سند تنها پس از تکمیل اطلاعات و کنترل‌های حسابداری انجام می‌شود.
    </p>

    {dnaSummary && <p className="mt-3 rounded border border-accent/30 bg-accent/5 p-3 text-xs leading-6"><b>DNA حسابداری همین شرکت</b> · {toPersianDigits(dnaSummary.accepted)} پیشنهاد تأییدشده · {toPersianDigits(dnaSummary.rejected)} اصلاح با دلیل · {toPersianDigits(dnaSummary.messages)} پیام حسابدار. تصمیم‌های شما در پیشنهادهای مرتبط بعدی استفاده می‌شوند.</p>}

    <AutomationPolicyPanel canManage={['owner', 'manager'].includes(access?.workspace?.role)} notify={notify} onChanged={load} />

    <UnidentifiedFundsPanel notify={notify} />

    {items === null && <p className="mt-3 text-[13px] text-muted">در حال خواندن صف…</p>}
    {items?.length === 0 && <p className="mt-3 text-[13px] text-income">چیزی در صف بررسی نمانده است.</p>}

    {items?.length > 0 && <div className="mt-1 divide-y divide-line">
      {items.map((item) => item.intake ? <UnquantifiedReviewCard key={item.id} item={item} notify={notify} onSaved={load} /> : <ReviewQueueRow key={item.id} item={item} busy={busy === item.id}
        onApprove={approve} onReject={reject} onAnswered={load} notify={notify} navigate={navigate} />)}
    </div>}
  </section>;
}
