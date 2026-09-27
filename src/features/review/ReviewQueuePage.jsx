import { Check } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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

function ReviewQueueRow({ item, busy, onApprove, onReject, onAnswered, notify }) {
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState(null);
  const [decision, setDecision] = useState(null);
  const [ai, setAi] = useState(item.aiProposal || null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const confidence = item.confidence || {};

  // تصمیم فقط برای ردیف‌هایی خوانده می‌شود که واقعاً تصمیمی دارند. صف ممکن است
  // ده‌ها ردیف داشته باشد و اکثرشان از مسیر قدیمی آمده‌اند.
  useEffect(() => {
    if (!item.decisionId) return;
    api.eventDecision(item.id).then(setDecision).catch(() => setDecision(null));
  }, [item.id, item.decisionId]);

  useEffect(() => { setAi(item.aiProposal || null); }, [item.id, item.aiProposal?.id]);

  const analyze = async () => {
    setAiBusy(true); setAiError('');
    try { setAi((await api.reviewAiProposal(item.id)).proposal); }
    catch (error) { setAiError(error.message); }
    setAiBusy(false);
  };

  const feedback = async (accepted) => {
    const reason = accepted ? '' : window.prompt('چرا پیشنهاد AI درست نیست؟ دلیل مشخص بنویس:');
    if (!accepted && !reason?.trim()) return;
    setAiBusy(true);
    try {
      const result = await api.reviewAiFeedback(item.id, ai.id, accepted, reason || '');
      if (accepted) { notify?.('پیشنهاد مطابق نقشهٔ قطعی تأیید و سند ثبت شد.'); await onAnswered?.(); }
      else { setAi(result.proposal); notify?.('دلیل رد در سابقهٔ حسابداری این دفتر ثبت شد.'); }
    } catch (error) { setAiError(error.message); }
    setAiBusy(false);
  };

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
          {persianDate(item.occurredAt)} · <span className="numbers">{formatAmount(item.amount)}</span> تومان
          {item.dueAt && <> · سررسید {persianDate(item.dueAt)}</>}
        </p>
      </div>
      <span className={`numbers text-[12px] font-bold ${confidence.percent >= 80 ? 'text-accent' : 'text-expense'}`}>
        {toPersianDigits(confidence.percent ?? 0)}٪
      </span>
      <div className="flex gap-1.5">
        <button disabled={busy} onClick={() => onApprove(item)} className="tap flex items-center gap-1 rounded-lg bg-accent px-3 text-[12px] font-bold text-white disabled:opacity-40"><Check size={15} />تأیید و ثبت سند</button>
        <button disabled={busy} onClick={() => onReject(item)} className="tap rounded-lg border border-expense/50 px-3 text-[12px] font-bold text-expense disabled:opacity-40">رد</button>
        <button onClick={toggle} className="tap rounded-lg border border-line bg-paper px-3 text-[12px] font-bold">{open ? 'بستن' : 'چرا؟'}</button>
      </div>
    </div>

    {/* دلیل توقف، بدون باز کردن جزئیات — همان چیزی که حسابدار اول می‌خواهد بداند. */}
    {!open && confidence.reasons?.length > 0 && <p className="mt-1.5 text-[11px] leading-5 text-muted">• {confidence.reasons[0]}</p>}

    {item.route === 'accountant-review' && <div className="mt-2 rounded-lg border border-line bg-paper p-3 text-[12px] leading-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <b>پیشنهاد AI برای بررسی حسابدار</b>
        {(!ai || ai.state === 'rejected') && <button disabled={busy || aiBusy} onClick={analyze} className="tap rounded-lg border border-accent px-2 py-1 font-bold text-accent disabled:opacity-40">{aiBusy ? 'در حال تحلیل…' : ai ? 'تحلیل دوباره' : 'تحلیل کن'}</button>}
      </div>
      {ai?.state === 'proposed' && <>
        <p className="mt-1 font-bold">{ai.summary}</p>
        <p className="text-muted">{ai.explanation}</p>
        <div className="mt-1 rounded border border-line p-2 numbers" dir="ltr">{ai.lines.map((line, index) => <p key={index}>{line.debit ? 'Dr' : 'Cr'} {line.role}{line.key ? ` (${line.key})` : ''}: {formatAmount(line.debit || line.credit)}</p>)}</div>
        {ai.missingFacts?.length > 0 && <p className="mt-1 text-expense">اطلاعات لازم: {ai.missingFacts.join('، ')}</p>}
        <p className="mt-1 text-muted">این پیشنهاد سند نیست؛ فقط در صورت تطبیق با نقشهٔ قطعی سیستم با تأیید ثبت می‌شود.</p>
        <div className="mt-2 flex gap-2">
          <button disabled={busy || aiBusy || ai.missingFacts?.length > 0} onClick={() => feedback(true)} className="tap rounded border border-accent px-2 py-1 text-accent disabled:opacity-40">تأیید پیشنهاد و ثبت</button>
          <button disabled={busy || aiBusy} onClick={() => feedback(false)} className="tap rounded border border-expense px-2 py-1 text-expense disabled:opacity-40">رد پیشنهاد با دلیل</button>
        </div>
      </>}
      {ai?.state === 'rejected' && <p className="mt-1 text-muted">پیشنهاد رد شد: {ai.reason}</p>}
      {aiError && <p className="mt-1 text-expense">{aiError}</p>}
    </div>}

    {/* سؤال بالاتر از جزئیات می‌نشیند: تا جوابش نیامده، بقیه‌اش موضوعیت ندارد. */}
    {decision?.decision?.question && <QuestionCard question={decision.decision.question} busy={busy} onAnswer={answer} />}

    {/* برنامهٔ تخصیص، وقتی ساخته شده — همان چیزی که ثابت می‌کند مبلغ یک‌جا هزینه نشد. */}
    {decision?.schedule?.length > 0 && <p className="mt-1.5 text-[11px] text-muted">
      برنامهٔ شناسایی: <span className="numbers">{toPersianDigits(decision.schedule.length)}</span> قلم ماهانه،
      از {decision.schedule[0].periodKey} تا {decision.schedule[decision.schedule.length - 1].periodKey}
    </p>}

    {open && <div className="mt-2">
      {item.event?.evidence && <blockquote className="rounded-lg border border-line bg-paper px-3 py-2 text-[12px] leading-6 text-muted">«{item.event.evidence}»</blockquote>}
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

export function ReviewQueuePage({ notify, access }) {
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState('');
  const aiAttempted = useRef(new Set());
  const queueKeys = items?.map((item) => item.id).join('|') || '';

  const load = useCallback(async () => {
    try { setItems((await api.reviewQueue()).items); }
    catch (error) { notify(error.message); setItems([]); }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  // صف در پس‌زمینه و با دو کارگر تحلیل می‌شود؛ باز شدن صفحه منتظر سرویس AI نمی‌ماند.
  useEffect(() => {
    if (!items) return undefined;
    const pending = items.filter((item) => item.route === 'accountant-review' && !item.aiProposal && !aiAttempted.current.has(item.id));
    if (!pending.length) return undefined;
    pending.forEach((item) => aiAttempted.current.add(item.id));
    let cancelled = false;
    let cursor = 0;
    const worker = async () => {
      while (!cancelled && cursor < pending.length) {
        const item = pending[cursor++];
        try {
          const { proposal } = await api.reviewAiProposal(item.id);
          if (!cancelled) setItems((current) => current?.map((entry) => entry.id === item.id ? { ...entry, aiProposal: proposal } : entry));
        } catch (error) {
          // پیکربندی‌نشدن سرویس یا قطعی آن نباید درخواست‌های بقیهٔ صف را تکرار کند.
          if (['AI_NOT_CONFIGURED', 'AI_UNAVAILABLE'].includes(error.code)) { cancelled = true; break; }
        }
      }
    };
    void Promise.all([worker(), worker()]);
    return () => { cancelled = true; };
  }, [queueKeys]);

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
      و تأیید تو همان لحظه سند را می‌زند.
    </p>

    <AutomationPolicyPanel canManage={['owner', 'manager'].includes(access?.workspace?.role)} notify={notify} onChanged={load} />

    {items === null && <p className="mt-3 text-[13px] text-muted">در حال خواندن صف…</p>}
    {items?.length === 0 && <p className="mt-3 text-[13px] text-income">چیزی در صف بررسی نمانده است.</p>}

    {items?.length > 0 && <div className="mt-1 divide-y divide-line">
      {items.map((item) => <ReviewQueueRow key={item.id} item={item} busy={busy === item.id}
        onApprove={approve} onReject={reject} onAnswered={load} notify={notify} />)}
    </div>}
  </section>;
}
