import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Mic, Pencil, Plus, Square, X } from 'lucide-react';
import { QuickDateInput } from '../../components/QuickDateInput.jsx';
import { api } from '../../lib/api.js';
import { withCounterpartyConfirmation } from '../../lib/counterpartyPrompt.js';
import { appendSpeechSegment, createPersianRecognizer, liveSpeechErrorMessage, liveSpeechSupported } from '../../lib/liveSpeech.js';
import { currentAmountUnit, formatAmount, toPersianDigits, tomanToLedger, unitLabel } from '../../lib/format.js';
import { DEPARTMENTS, EMPLOYMENT_TYPES, MARITAL, PERSONNEL_STEPS, readPersonnelAnswer, splitVoiceCommand } from '../../../shared/personnel.js';
import { parsePersonnelBlock } from '../../../shared/personnelLine.js';

/**
 * تعریف پرسنل — یک راهنمای مرحله‌به‌مرحله، با صدا یا دست.
 *
 * روی میکروفن که بزنی، مرحله‌ها به ترتیب پرسیده می‌شوند. هرچه می‌گویی همان لحظه
 * زیر مرحلهٔ جاری تایپ می‌شود و روی هم جمع می‌شود — مکث وسط «امیرحسین … ترابی»
 * یا «۱۲۷ … ۳۹۲ …» پاسخ را نمی‌بُرد. مرحله فقط با اجازهٔ تو بسته می‌شود: «بعدی»
 * یا «تأیید» (یا دکمهٔ تأیید). «پاک کن» از نو، «بعداً» رد، «برگرد» قبلی و «ذخیره»
 * ثبت. پاسخی که خوانده نشود حدس زده نمی‌شود: مرحله باز می‌ماند و دلیلش گفته می‌شود.
 */

const LABEL = {
  department: Object.fromEntries(DEPARTMENTS.map((item) => [item.id, item.label])),
  employmentType: Object.fromEntries(EMPLOYMENT_TYPES.map((item) => [item.id, item.label])),
  marital: Object.fromEntries(MARITAL.map((item) => [item.id, item.label])),
};
const SAVE_WORDS = /^(?:ذخیره|ذخیره کن|ثبت|ثبت کن|تمام|تموم|تمومه|کافیه)$/;

const stepLabel = (step, values) => (step.id === 'baseWage'
  ? (values.employmentType === 'hourly' ? 'مزد ساعتی' : 'مزد پایهٔ ماهانه')
  : step.label);

function displayValue(stepId, value) {
  if (value == null || value === '') return '';
  if (stepId === 'baseWage') return `${formatAmount(value)} ${unitLabel()}`;
  if (stepId === 'startDate') return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(value));
  if (stepId === 'children') return Number(value) ? `${toPersianDigits(value)} فرزند` : 'ندارد';
  if (LABEL[stepId]) return LABEL[stepId][value] || '';
  return toPersianDigits(value);
}

const hasValue = (stepId, values) => (stepId === 'children' ? values.children != null && values.children !== '' : Boolean(values[stepId]));

function initialState(employee, seed) {
  const values = employee ? { ...employee } : { ...(seed || {}) };
  const status = Object.fromEntries(PERSONNEL_STEPS.map((step) => [step.id, hasValue(step.id, values) ? 'done' : 'pending']));
  const first = PERSONNEL_STEPS.findIndex((step) => status[step.id] === 'pending');
  return { values, status, current: first < 0 ? PERSONNEL_STEPS.length : first };
}

/** مبلغ گفتاری (تومان یا ریال) → واحد دفتر. */
function spokenAmountToLedger(result) {
  if (result.amountRial != null) return currentAmountUnit() === 'rial' ? result.amountRial : Math.round(result.amountRial / 10);
  return tomanToLedger(result.amountToman);
}

/** مزد خوانده‌شده از خط سریع (`{ amount, unit }`) → واحد دفتر. */
const wageToLedger = (wage) => (wage ? spokenAmountToLedger(wage.unit === 'rial' ? { amountRial: wage.amount } : { amountToman: wage.amount }) : undefined);

// فیلدهایی که کامل‌شدنشان بی‌ابهام است: همین که معتبر شد، مرحله بسته می‌شود.
const AUTO_COMPLETE = new Set(['nationalId', 'mobile', 'iban']);
const faDigit = (key) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(key) >= 0 ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(key) : key);

function ManualInput({ step, values, onAnswer, onValue }) {
  const [text, setText] = useState('');
  useEffect(() => setText(''), [step.id]);
  // گزینه‌ها با کلید عددی: ۱ اولی، ۲ دومی…؛ فرزند: ۰ تا ۵.
  const choices = step.kind === 'choice' ? step.options.map((option) => option.id) : step.kind === 'count' ? [0, 1, 2, 3, 4, 5] : null;
  useEffect(() => {
    if (!choices) return undefined;
    const handler = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || /^(?:INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
      const digit = Number(faDigit(event.key));
      if (!Number.isInteger(digit)) return;
      const choice = step.kind === 'count' ? (digit <= 5 ? digit : null) : choices[digit - 1];
      if (choice == null) return;
      event.preventDefault();
      onValue(choice);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [step.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (next) => {
    setText(next);
    if (!AUTO_COMPLETE.has(step.kind)) return;
    const result = readPersonnelAnswer(step.id, next);
    if (result.ok) { onValue(result.value); setText(''); }
  };
  const submitText = (event) => {
    event.preventDefault();
    if (!text.trim()) return;
    if (step.kind === 'amount') {
      const amount = Number(String(text).replace(/[۰-۹]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)).replace(/[,٬\s]/g, ''));
      if (Number.isSafeInteger(amount) && amount > 0) { onValue(amount); setText(''); return; }
    }
    onAnswer(text);
    setText('');
  };
  const button = 'tap rounded-lg border border-line px-3 text-[13px] font-bold hover:border-accent hover:text-accent';
  if (step.kind === 'choice') {
    return <div className="flex flex-wrap gap-2">{step.options.map((option, index) => <button key={option.id} type="button" onClick={() => onValue(option.id)}
      className={`${button} ${values[step.id] === option.id ? 'border-accent bg-accent/10 text-accent' : ''}`}><span className="ml-1.5 text-[11px] text-muted">{toPersianDigits(index + 1)}</span>{option.label}</button>)}</div>;
  }
  if (step.kind === 'count') {
    return <div className="flex flex-wrap gap-2">{[0, 1, 2, 3, 4, 5].map((count) => <button key={count} type="button" onClick={() => onValue(count)}
      className={`${button} min-w-11 ${Number(values.children) === count && values.children != null ? 'border-accent bg-accent/10 text-accent' : ''}`}>{count ? toPersianDigits(count) : 'ندارد'}</button>)}</div>;
  }
  if (step.kind === 'date') {
    return <QuickDateInput value={values.startDate || ''} onChange={(iso) => iso && onValue(iso)} direction="past" aria-label={step.label} className="w-full max-w-xs" />;
  }
  const inputMode = ['nationalId', 'insuranceNumber', 'mobile', 'amount'].includes(step.kind) ? 'numeric' : 'text';
  return <form onSubmit={submitText} className="flex gap-2">
    <input value={text} onChange={(event) => change(event.target.value)} inputMode={inputMode} dir={['iban', 'mobile', 'nationalId', 'insuranceNumber'].includes(step.kind) ? 'ltr' : 'rtl'}
      placeholder={step.kind === 'amount' ? `مبلغ به ${unitLabel()}` : AUTO_COMPLETE.has(step.kind) ? 'بنویس؛ کامل که شد خودش می‌رود بعدی' : 'بنویس و تأیید را بزن'} aria-label={step.label} autoFocus
      className="tap min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 text-[14px] focus:border-accent focus:outline-none" />
    <button type="submit" className="tap rounded-lg bg-accent px-3 text-[13px] font-bold text-on-fill hover:bg-accent/90">تأیید</button>
  </form>;
}

/**
 * گفته‌های مرحلهٔ جاری و پیش‌نمایش خواندنشان. چیزی ثبت نمی‌شود تا «بعدی» یا
 * «تأیید» گفته شود یا دکمهٔ تأیید زده شود.
 */
function VoiceDraft({ step, heard, onConfirm, onClear }) {
  const text = splitVoiceCommand(heard).rest;
  const preview = text ? readPersonnelAnswer(step.id, text) : null;
  return <div className="rounded-md bg-surface px-2 py-1.5" aria-live="polite">
    <p dir="auto" className="min-h-6 text-[14px]">{heard || <span className="text-muted">گوش می‌دهم…</span>}</p>
    {preview && <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      {preview.ok
        ? <span className="font-bold text-income">خوانده شد: {toPersianDigits(preview.display)} · بگو «بعدی»</span>
        : preview.skip ? <span className="text-muted">«بعداً» رد می‌کند</span>
          : !preview.back && <span className="text-muted">{preview.message}</span>}
      {preview.ok && <button type="button" onClick={onConfirm} className="tap rounded-md bg-accent px-2 text-[12px] font-bold text-on-fill">تأیید</button>}
      <button type="button" onClick={onClear} className="font-bold text-muted hover:text-expense">پاک کن</button>
    </div>}
  </div>;
}

function PersonnelWizard({ employee, seed, title, onClose, onSaved, notify }) {
  const [state, setState] = useState(() => initialState(employee, seed));
  const [heard, setHeard] = useState('');
  const [error, setError] = useState('');
  const [listening, setListening] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endDate, setEndDate] = useState('');
  const stateRef = useRef(state);
  stateRef.current = state;
  const recognizerRef = useRef(null);
  const listeningRef = useRef(false);
  const consumedRef = useRef('');
  // گفته‌های نهاییِ مرحلهٔ جاری، روی هم؛ با عوض شدن مرحله خالی می‌شود.
  const bufferRef = useRef('');
  const saveRef = useRef(null);

  const answered = PERSONNEL_STEPS.filter((step) => state.status[step.id] !== 'pending').length;
  const percent = Math.round((answered / PERSONNEL_STEPS.length) * 100);
  const step = PERSONNEL_STEPS[state.current];
  const finished = state.current >= PERSONNEL_STEPS.length;

  const nextPending = (status, from) => {
    for (let index = from + 1; index < PERSONNEL_STEPS.length; index += 1) if (status[PERSONNEL_STEPS[index].id] === 'pending') return index;
    return PERSONNEL_STEPS.length;
  };

  const commit = useCallback((stepId, value, outcome = 'done') => {
    setState((previous) => {
      const index = PERSONNEL_STEPS.findIndex((item) => item.id === stepId);
      const values = { ...previous.values, [stepId]: outcome === 'skipped' ? (stepId === 'children' ? null : '') : value };
      const status = { ...previous.status, [stepId]: outcome };
      return { values, status, current: nextPending(status, index) };
    });
    setError('');
    setHeard('');
  }, []);

  const goBack = useCallback(() => {
    setState((previous) => ({ ...previous, current: Math.max(0, Math.min(previous.current, PERSONNEL_STEPS.length) - 1) }));
    setError('');
    setHeard('');
  }, []);

  /** پاسخ یک مرحله، از صدا یا از کادر متن. */
  const answer = useCallback((text) => {
    const { current } = stateRef.current;
    const active = PERSONNEL_STEPS[current];
    if (SAVE_WORDS.test(String(text).replace(/[.!؟?،]/g, '').trim())) { saveRef.current?.(); return true; }
    if (!active) return false;
    const result = readPersonnelAnswer(active.id, text);
    if (result.back) { goBack(); return true; }
    if (result.skip) { commit(active.id, null, 'skipped'); return true; }
    if (!result.ok) { setError(result.message); return false; }
    commit(active.id, active.kind === 'amount' ? spokenAmountToLedger(result) : result.value);
    return true;
  }, [commit, goBack]);

  /**
   * تکهٔ نهاییِ تازه از گفتار: به گفته‌های همین مرحله اضافه می‌شود و فقط اگر با
   * فرمان تمام شده باشد کاری انجام می‌شود. پایانِ تکه پایانِ پاسخ نیست.
   */
  const hearSegment = useCallback((segment) => {
    const buffer = appendSpeechSegment(bufferRef.current, segment);
    const { command, rest } = splitVoiceCommand(buffer);
    if (!command) { bufferRef.current = buffer; setHeard(buffer); return; }
    bufferRef.current = '';
    setHeard('');
    const active = PERSONNEL_STEPS[stateRef.current.current];
    if (command === 'clear') { setError(''); return; }
    if (command === 'back') { goBack(); return; }
    if (command === 'skip') {
      if (active?.required) { bufferRef.current = rest; setHeard(rest); setError(`«${active.label}» لازم است و نمی‌شود بعداً گفت.`); return; }
      if (active) commit(active.id, null, 'skipped');
      return;
    }
    if (command === 'save') {
      if (rest && active && !answer(rest)) { bufferRef.current = rest; setHeard(rest); return; }
      saveRef.current?.();
      return;
    }
    // «بعدی» / «تأیید»
    if (!active) return;
    if (!rest) {
      // مرحله‌ای که از قبل پاسخ دارد با «بعدی» فقط جلو می‌رود.
      if (stateRef.current.status[active.id] !== 'pending') { commit(active.id, stateRef.current.values[active.id], stateRef.current.status[active.id]); return; }
      setError('هنوز چیزی برای این مرحله نگفتی.');
      return;
    }
    // پاسخ نامعتبر می‌ماند تا کاربر ادامه دهد یا «پاک کن» بگوید.
    if (!answer(rest)) { bufferRef.current = rest; setHeard(rest); }
  }, [answer, commit, goBack]);

  const stopListening = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    setHeard('');
    try { recognizerRef.current?.stop(); } catch { /* نشست از قبل بسته است */ }
    recognizerRef.current = null;
  }, []);

  const startSession = useCallback(() => {
    consumedRef.current = '';
    const recognizer = createPersianRecognizer({
      phrases: ['کد ملی', 'شبا', 'تمام وقت', 'پاره وقت', 'متاهل', 'مجرد', 'بعداً', 'برگرد', 'ذخیره'],
      onUpdate: (snapshot) => {
        const consumed = consumedRef.current;
        const final = snapshot.finalTranscript || '';
        const fresh = (final.startsWith(consumed) ? final.slice(consumed.length) : final).trim();
        if (fresh) {
          consumedRef.current = final;
          hearSegment(fresh);
          return;
        }
        // تکهٔ نیمه‌تمام فقط نمایش است؛ چیزی را نمی‌بندد.
        const interim = (snapshot.transcript.startsWith(consumed) ? snapshot.transcript.slice(consumed.length) : snapshot.transcript).trim();
        setHeard(appendSpeechSegment(bufferRef.current, interim));
      },
      // Chrome پس از سکوت نشست را می‌بندد؛ تا کاربر خودش نبسته، دوباره گوش می‌دهیم.
      onEnd: () => { if (listeningRef.current) { try { startSession(); } catch { stopListening(); } } },
      onError: (code) => {
        if (['no-speech', 'aborted'].includes(code)) return;
        notify(code === 'not-allowed' ? 'اجازهٔ میکروفن داده نشده؛ دستی وارد کن.' : liveSpeechErrorMessage(code));
        stopListening();
      },
    });
    recognizerRef.current = recognizer;
    recognizer.start();
  }, [hearSegment, notify, stopListening]);

  const toggleListening = () => {
    if (listening) { stopListening(); return; }
    if (!liveSpeechSupported()) { notify('این مرورگر تشخیص گفتار فارسی ندارد؛ Chrome را امتحان کن یا دستی وارد کن.'); return; }
    listeningRef.current = true;
    setListening(true);
    try { startSession(); } catch { stopListening(); notify('میکروفن شروع نشد؛ دستی وارد کن.'); }
  };

  // مرحلهٔ تازه، گفته‌های تازه.
  useEffect(() => { bufferRef.current = ''; setHeard(''); }, [state.current]);
  useEffect(() => () => { listeningRef.current = false; try { recognizerRef.current?.abort(); } catch { /* بسته است */ } }, []);
  // همهٔ مرحله‌ها پاسخ گرفتند: گوش دادن تمام می‌شود.
  useEffect(() => { if (finished && listeningRef.current) stopListening(); }, [finished, stopListening]);

  const save = useCallback(async () => {
    const { values } = stateRef.current;
    if (!values.name) { setError('اول نام و نام خانوادگی.'); return; }
    setSaving(true);
    try {
      const payload = { ...values, id: employee?.id };
      const { item } = await withCounterpartyConfirmation((counterpartyResolution) => api.savePersonnel({ ...payload, counterpartyResolution }));
      stopListening();
      notify(employee ? 'پرونده به‌روز شد.' : `«${item.name}» به پرسنل اضافه شد.`);
      onSaved(item);
    } catch (failure) {
      const field = failure.details?.errors?.[0]?.field;
      if (field) setState((previous) => ({ ...previous, current: PERSONNEL_STEPS.findIndex((item) => item.id === field) }));
      setError(failure.details?.errors?.[0]?.message || failure.message);
    }
    setSaving(false);
  }, [employee, notify, onSaved, stopListening]);
  saveRef.current = save;

  const endWork = async () => {
    try { await api.endPersonnel(employee.id, endDate || new Date().toISOString()); notify('پایان همکاری ثبت شد.'); onSaved(null); }
    catch (failure) { setError(failure.message); }
  };

  return <div className="rounded-xl border border-line bg-surface p-4">
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="font-extrabold">{employee ? `پروندهٔ ${employee.name}` : title || 'پرسنل تازه'}</p>
        <p className="mt-0.5 text-xs text-muted">{toPersianDigits(answered)} از {toPersianDigits(PERSONNEL_STEPS.length)} مرحله</p>
      </div>
      <button type="button" onClick={() => { stopListening(); onClose(); }} aria-label="بستن" className="tap grid h-9 w-9 place-items-center rounded-lg text-muted hover:text-ink"><X size={18} /></button>
    </div>

    <div className="mt-3 flex items-center gap-3">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="پیشرفت تعریف پرسنل">
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
      <b className="numbers w-10 text-left text-[13px]">{toPersianDigits(percent)}٪</b>
    </div>

    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="button" onClick={toggleListening} aria-pressed={listening}
        className={`tap inline-flex items-center gap-2 rounded-full px-4 text-[13px] font-bold ${listening ? 'bg-expense text-on-fill' : 'bg-accent text-on-fill hover:bg-accent/90'}`}>
        {listening ? <Square size={16} /> : <Mic size={16} />}
        {listening ? 'توقف' : 'گفتن با صدا'}
      </button>
      <p className="text-xs leading-6 text-muted">{listening
        ? 'کامل بگو و آخرش «بعدی» یا «تأیید». «پاک کن» از نو، «بعداً» رد، «برگرد» قبلی، «ذخیره» ثبت.'
        : 'روی میکروفن بزن و به ترتیب بگو، یا هر مرحله را دستی پر کن.'}</p>
    </div>

    <ol className="mt-4 space-y-1.5">
      {PERSONNEL_STEPS.map((item, index) => {
        const status = state.status[item.id];
        const active = index === state.current;
        const value = displayValue(item.id, state.values[item.id]);
        return <li key={item.id} className={`rounded-lg border ${active ? 'border-accent bg-paper' : 'border-transparent'}`}>
          <button type="button" onClick={() => { setState((previous) => ({ ...previous, current: index })); setError(''); setHeard(''); }}
            className="flex w-full items-center gap-3 px-3 py-2 text-right" aria-current={active ? 'step' : undefined}>
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold transition-colors ${status === 'done' ? 'bg-income text-on-fill' : status === 'skipped' ? 'bg-line text-muted' : active ? 'border-2 border-accent text-accent' : 'border border-line text-muted'}`}>
              {status === 'done' ? <Check size={14} strokeWidth={3} /> : status === 'skipped' ? '–' : toPersianDigits(index + 1)}
            </span>
            <span className={`text-[13px] ${active ? 'font-extrabold' : 'font-bold'}`}>{stepLabel(item, state.values)}{item.required && <span className="text-expense"> *</span>}</span>
            <span className="mr-auto truncate text-[13px] text-muted">{status === 'skipped' ? 'بعداً' : value}</span>
          </button>
          {active && <div className="space-y-2 px-3 pb-3">
            <p className="text-xs text-muted">بگو یا بنویس: {item.say}</p>
            {listening && <VoiceDraft step={item} heard={heard} onConfirm={() => hearSegment('تأیید')} onClear={() => hearSegment('پاک کن')} />}
            {error && <p className="text-xs font-bold text-expense" role="alert">{error}</p>}
            <ManualInput step={item} values={state.values} onAnswer={answer} onValue={(value) => commit(item.id, value)} />
            <div className="flex gap-3 text-xs font-bold text-muted">
              {index > 0 && <button type="button" onClick={goBack} className="hover:text-ink">مرحلهٔ قبل</button>}
              {!item.required && <button type="button" onClick={() => commit(item.id, null, 'skipped')} className="hover:text-ink">بعداً</button>}
            </div>
          </div>}
        </li>;
      })}
    </ol>

    {finished && error && <p className="mt-3 text-xs font-bold text-expense" role="alert">{error}</p>}
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button type="button" onClick={save} disabled={saving || !state.values.name}
        className="tap rounded-lg bg-accent px-4 text-[13px] font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90">
        {saving ? 'در حال ذخیره…' : finished ? 'ذخیرهٔ پرونده' : 'ذخیره و تکمیل بعداً'}
      </button>
      {employee?.active && !ending && <button type="button" onClick={() => setEnding(true)} className="tap rounded-lg px-3 text-[13px] font-bold text-muted hover:text-expense">پایان همکاری</button>}
      {ending && <div className="flex flex-wrap items-center gap-2">
        <QuickDateInput value={endDate} onChange={setEndDate} direction="past" aria-label="تاریخ پایان همکاری" placeholder="تاریخ پایان همکاری" />
        <button type="button" onClick={endWork} className="tap rounded-lg border border-expense/50 px-3 text-[13px] font-bold text-expense">ثبت پایان</button>
      </div>}
    </div>
  </div>;
}

/**
 * تعریف سریع: یک خط برای یک نفر، چند خط (یا ستون‌های اکسل) برای چند نفر.
 * هر تکه از شکل خودش شناخته می‌شود و همان لحظه برچسب می‌خورد؛ تکهٔ نامشخص
 * حدس زده نمی‌شود و ذخیره هم نمی‌شود.
 */
function QuickAdd({ notify, onSaved, onForm }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const parsed = useMemo(() => parsePersonnelBlock(text), [text]);
  const rows = parsed.rows;
  const single = rows.length === 1 && !parsed.columns;
  const ready = rows.filter((row) => row.values.name && !row.issues.length);
  const lines = text.split(/\r?\n/).filter((line) => line.trim());

  const payloadOf = (row) => ({ ...row.values, ...(row.wage ? { baseWage: wageToLedger(row.wage) } : {}) });
  const saveAll = async () => {
    if (!ready.length || saving) return;
    setSaving(true);
    const failed = [];
    let saved = 0;
    for (const row of rows) {
      if (!ready.includes(row)) { failed.push(row); continue; }
      try {
        await withCounterpartyConfirmation((counterpartyResolution) => api.savePersonnel({ ...payloadOf(row), counterpartyResolution }));
        saved += 1;
      } catch (failure) {
        failed.push({ ...row, issues: [{ message: failure.details?.errors?.[0]?.message || failure.message }] });
      }
    }
    setSaving(false);
    // فقط خط‌هایی که ثبت نشدند در کادر می‌مانند (با عنوان ستون‌ها، اگر بود).
    const header = parsed.columns ? [lines[0]] : [];
    setText([...header, ...failed.map((row) => lines[row.line - 1])].filter(Boolean).join('\n'));
    notify(failed.length ? `${toPersianDigits(saved)} نفر ثبت شد؛ ${toPersianDigits(failed.length)} خط مانده که باید درست شود.` : saved === 1 ? `«${rows[0].values.name}» به پرسنل اضافه شد.` : `${toPersianDigits(saved)} نفر به پرسنل اضافه شد.`);
    if (saved) onSaved();
  };

  const chip = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px]';
  return <div className="mt-3 rounded-xl border border-line bg-surface p-3">
    <textarea value={text} onChange={(event) => setText(event.target.value)} rows={Math.min(8, Math.max(2, lines.length + (text.endsWith('\n') ? 1 : 0), Math.ceil(text.length / 38)))}
      onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && single) { event.preventDefault(); saveAll(); } }}
      placeholder="تعریف سریع: هرچه می‌دانی پشت هم بنویس — امیرحسین ترابی ۱۲۷۳۹۲۵۳۵۱ تولید ۱۸ میلیون ۰۹۱۲… — یا چند نفر را از اکسل بچسبان"
      aria-label="تعریف سریع پرسنل" className="w-full resize-none rounded-lg border border-line bg-paper px-3 py-2 text-[14px] leading-7 focus:border-accent focus:outline-none" />

    {single && <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-live="polite">
      {rows[0].fields.map((field) => <span key={field.id} className={`${chip} bg-income/10 text-income`}><Check size={12} strokeWidth={3} /><span className="text-muted">{field.label}:</span> <b dir="auto">{toPersianDigits(field.display)}</b></span>)}
      {!rows[0].values.name && <span className={`${chip} bg-expense/10 text-expense`}>نام لازم است</span>}
      {rows[0].issues.map((issue, index) => <span key={`i${index}`} className={`${chip} bg-warn-bg text-warn`}>{issue.message}</span>)}
      {rows[0].unknown.map((item, index) => <span key={`u${index}`} title="معلوم نیست چیست؛ ذخیره نمی‌شود. با برچسب بنویس، مثلاً «بیمه ۱۲۳۴۵۶» یا «سمت انباردار»." className={`${chip} bg-paper text-muted`}>؟ {toPersianDigits(item)}</span>)}
    </div>}

    {rows.length > 1 || parsed.columns ? <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[520px] text-right text-[12px]">
        <thead className="text-muted"><tr><th className="py-1 font-normal">خط</th><th className="py-1 font-normal">نام</th><th className="py-1 font-normal">خوانده شد</th><th className="py-1 font-normal">وضعیت</th></tr></thead>
        <tbody className="divide-y divide-line">{rows.map((row) => <tr key={row.line}>
          <td className="numbers py-1.5 text-muted">{toPersianDigits(row.line)}</td>
          <td className="py-1.5 font-bold">{row.values.name || <span className="text-expense">بی‌نام</span>}</td>
          <td className="py-1.5 text-muted">{row.fields.filter((field) => field.id !== 'name').map((field) => toPersianDigits(field.display)).join(' · ') || '—'}</td>
          <td className="py-1.5">{row.values.name && !row.issues.length
            ? <span className="text-income">✓{row.unknown.length ? <span className="text-muted"> (؟ {toPersianDigits(row.unknown.join('، '))})</span> : ''}</span>
            : <span className="text-warn">{row.issues[0]?.message || 'نام لازم است'}</span>}</td>
        </tr>)}</tbody>
      </table>
    </div> : null}

    {rows.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" onClick={saveAll} disabled={!ready.length || saving}
        className="tap rounded-lg bg-accent px-3 text-[13px] font-bold text-on-fill disabled:opacity-45 hover:bg-accent/90">
        {saving ? 'در حال ثبت…' : single ? 'ذخیره (Enter)' : `ثبت ${toPersianDigits(ready.length)} نفر`}
      </button>
      {single && <button type="button" onClick={() => { onForm({ ...rows[0].values, ...(rows[0].wage ? { baseWage: wageToLedger(rows[0].wage) } : {}) }); setText(''); }}
        className="tap rounded-lg px-3 text-[13px] font-bold text-muted hover:text-accent">تکمیل در فرم</button>}
      <button type="button" onClick={() => setText('')} className="text-xs font-bold text-muted hover:text-expense">پاک کردن</button>
    </div>}
  </div>;
}

export default function PersonnelPanel({ canManage, notify }) {
  const [items, setItems] = useState([]);
  const [showEnded, setShowEnded] = useState(false);
  // null | { key, employee } | { key, seed, title }
  const [editing, setEditing] = useState(null);
  const load = useCallback(async () => {
    try { setItems((await api.personnel({ all: showEnded })).items || []); } catch (failure) { notify(failure.message); }
  }, [notify, showEnded]);
  useEffect(() => { load(); }, [load]);
  const active = useMemo(() => items.filter((item) => item.active), [items]);
  // «مثل این نفر»: همان حکم و جایگاه، شخص تازه.
  const likeThis = (item) => setEditing({ key: `like-${item.id}-${Date.now()}`, title: `پرسنل تازه، مثل ${item.name}`,
    seed: Object.fromEntries(['jobTitle', 'department', 'employmentType', 'baseWage'].filter((key) => item[key]).map((key) => [key, item[key]])) });

  return <section className="mt-5">
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="font-extrabold">پرسنل</h2>
        <p className="mt-1 text-xs text-muted">{active.length ? `${toPersianDigits(active.length)} نفر فعال` : 'هنوز کسی تعریف نشده'}</p>
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={showEnded} onChange={(event) => setShowEnded(event.target.checked)} /> پایان‌یافته‌ها</label>
        {canManage && !editing && <button type="button" onClick={() => setEditing({ key: `new-${Date.now()}` })}
          className="tap inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-bold text-on-fill hover:bg-accent/90"><Plus size={16} />پرسنل تازه</button>}
      </div>
    </div>

    {canManage && !editing && <QuickAdd notify={notify} onSaved={load} onForm={(seed) => setEditing({ key: `form-${Date.now()}`, seed })} />}

    {editing && <div className="mt-3">
      <PersonnelWizard key={editing.key} employee={editing.employee || null} seed={editing.seed} title={editing.title} notify={notify}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
    </div>}

    {items.length > 0 && <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
      {items.map((item) => <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className={`truncate text-[14px] font-bold ${item.active ? '' : 'text-muted line-through'}`}>{item.name}{item.nickname && <span className="font-normal text-muted"> · «{item.nickname}»</span>}</p>
          <p className="mt-0.5 truncate text-xs text-muted">{[item.jobTitle, LABEL.department[item.department], item.baseWage ? `${formatAmount(item.baseWage)} ${unitLabel()}` : ''].filter(Boolean).join(' · ') || '—'}</p>
        </div>
        <span title={item.completeness.missing.length ? `هنوز گفته نشده: ${item.completeness.missing.join('، ')}` : 'پرونده کامل است'}
          className={`numbers shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${item.completeness.percent === 100 ? 'bg-income/10 text-income' : 'bg-paper text-muted'}`}>
          {toPersianDigits(item.completeness.percent)}٪
        </span>
        {canManage && (item.active
          ? <>
            <button type="button" onClick={() => likeThis(item)} aria-label={`پرسنل تازه مثل ${item.name}`} title="مثل این نفر" className="tap grid h-9 w-9 place-items-center rounded-lg text-muted hover:text-accent"><Copy size={16} /></button>
            <button type="button" onClick={() => setEditing({ key: item.id, employee: item })} aria-label={`ویرایش ${item.name}`} className="tap grid h-9 w-9 place-items-center rounded-lg text-muted hover:text-accent"><Pencil size={16} /></button>
          </>
          : <button type="button" onClick={async () => { try { await api.resumePersonnel(item.id); load(); } catch (failure) { notify(failure.message); } }} className="tap rounded-lg px-2 text-xs font-bold text-muted hover:text-accent">بازگشت به کار</button>)}
      </li>)}
    </ul>}
  </section>;
}
