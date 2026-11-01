import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Mic, Pencil, Plus, Square, X } from 'lucide-react';
import { QuickDateInput } from '../../components/QuickDateInput.jsx';
import { api } from '../../lib/api.js';
import { withCounterpartyConfirmation } from '../../lib/counterpartyPrompt.js';
import { createPersianRecognizer, liveSpeechErrorMessage, liveSpeechSupported } from '../../lib/liveSpeech.js';
import { currentAmountUnit, formatAmount, toPersianDigits, tomanToLedger, unitLabel } from '../../lib/format.js';
import { DEPARTMENTS, EMPLOYMENT_TYPES, MARITAL, PERSONNEL_STEPS, readPersonnelAnswer } from '../../../shared/personnel.js';

/**
 * تعریف پرسنل — یک راهنمای مرحله‌به‌مرحله، با صدا یا دست.
 *
 * روی میکروفن که بزنی، مرحله‌ها به ترتیب پرسیده می‌شوند. هرچه می‌گویی همان لحظه
 * زیر مرحلهٔ جاری تایپ می‌شود؛ وقتی جمله تمام شد و پاسخ معتبر بود، مرحله تیک
 * می‌خورد و راهنما به مرحلهٔ بعد می‌رود. «بعداً» مرحله را رد می‌کند، «برگرد»
 * به مرحلهٔ قبل می‌رود و «ذخیره» پرونده را ثبت می‌کند. پاسخی که خوانده نشود
 * حدس زده نمی‌شود: مرحله باز می‌ماند و دلیلش گفته می‌شود.
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

function initialState(employee) {
  const values = employee ? { ...employee } : {};
  const status = Object.fromEntries(PERSONNEL_STEPS.map((step) => [step.id, hasValue(step.id, values) ? 'done' : 'pending']));
  const first = PERSONNEL_STEPS.findIndex((step) => status[step.id] === 'pending');
  return { values, status, current: first < 0 ? PERSONNEL_STEPS.length : first };
}

/** مبلغ گفتاری (تومان یا ریال) → واحد دفتر. */
function spokenAmountToLedger(result) {
  if (result.amountRial != null) return currentAmountUnit() === 'rial' ? result.amountRial : Math.round(result.amountRial / 10);
  return tomanToLedger(result.amountToman);
}

function ManualInput({ step, values, onAnswer, onValue }) {
  const [text, setText] = useState('');
  useEffect(() => setText(''), [step.id]);
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
    return <div className="flex flex-wrap gap-2">{step.options.map((option) => <button key={option.id} type="button" onClick={() => onValue(option.id)}
      className={`${button} ${values[step.id] === option.id ? 'border-accent bg-accent/10 text-accent' : ''}`}>{option.label}</button>)}</div>;
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
    <input value={text} onChange={(event) => setText(event.target.value)} inputMode={inputMode} dir={['iban', 'mobile', 'nationalId', 'insuranceNumber'].includes(step.kind) ? 'ltr' : 'rtl'}
      placeholder={step.kind === 'amount' ? `مبلغ به ${unitLabel()}` : 'بنویس و تأیید را بزن'} aria-label={step.label}
      className="tap min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 text-[14px] focus:border-accent focus:outline-none" />
    <button type="submit" className="tap rounded-lg bg-accent px-3 text-[13px] font-bold text-on-fill hover:bg-accent/90">تأیید</button>
  </form>;
}

function PersonnelWizard({ employee, onClose, onSaved, notify }) {
  const [state, setState] = useState(() => initialState(employee));
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
    if (SAVE_WORDS.test(String(text).replace(/[.!؟?،]/g, '').trim())) { saveRef.current?.(); return; }
    if (!active) return;
    const result = readPersonnelAnswer(active.id, text);
    if (result.back) { goBack(); return; }
    if (result.skip) { commit(active.id, null, 'skipped'); return; }
    if (!result.ok) { setError(result.message); return; }
    commit(active.id, active.kind === 'amount' ? spokenAmountToLedger(result) : result.value);
  }, [commit, goBack]);

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
        const live = (snapshot.transcript.startsWith(consumed) ? snapshot.transcript.slice(consumed.length) : snapshot.transcript).trim();
        setHeard(live);
        if (fresh) {
          consumedRef.current = final;
          answer(fresh);
        }
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
  }, [answer, notify, stopListening]);

  const toggleListening = () => {
    if (listening) { stopListening(); return; }
    if (!liveSpeechSupported()) { notify('این مرورگر تشخیص گفتار فارسی ندارد؛ Chrome را امتحان کن یا دستی وارد کن.'); return; }
    listeningRef.current = true;
    setListening(true);
    try { startSession(); } catch { stopListening(); notify('میکروفن شروع نشد؛ دستی وارد کن.'); }
  };

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
        <p className="font-extrabold">{employee ? `پروندهٔ ${employee.name}` : 'پرسنل تازه'}</p>
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
        ? 'بگو؛ هر مرحله که تیک خورد، بعدی را بگو. «بعداً» رد می‌کند، «برگرد» قبلی، «ذخیره» ثبت.'
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
            {listening && <p className="min-h-6 rounded-md bg-surface px-2 py-1 text-[14px]" aria-live="polite">{heard || <span className="text-muted">گوش می‌دهم…</span>}</p>}
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

export default function PersonnelPanel({ canManage, notify }) {
  const [items, setItems] = useState([]);
  const [showEnded, setShowEnded] = useState(false);
  const [editing, setEditing] = useState(null); // null | 'new' | employee
  const load = useCallback(async () => {
    try { setItems((await api.personnel({ all: showEnded })).items || []); } catch (failure) { notify(failure.message); }
  }, [notify, showEnded]);
  useEffect(() => { load(); }, [load]);
  const active = useMemo(() => items.filter((item) => item.active), [items]);

  return <section className="mt-5">
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="font-extrabold">پرسنل</h2>
        <p className="mt-1 text-xs text-muted">{active.length ? `${toPersianDigits(active.length)} نفر فعال` : 'هنوز کسی تعریف نشده'}</p>
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={showEnded} onChange={(event) => setShowEnded(event.target.checked)} /> پایان‌یافته‌ها</label>
        {canManage && !editing && <button type="button" onClick={() => setEditing('new')}
          className="tap inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-bold text-on-fill hover:bg-accent/90"><Plus size={16} />پرسنل تازه</button>}
      </div>
    </div>

    {editing && <div className="mt-3">
      <PersonnelWizard key={editing === 'new' ? 'new' : editing.id} employee={editing === 'new' ? null : editing} notify={notify}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
    </div>}

    {items.length > 0 && <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
      {items.map((item) => <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className={`truncate text-[14px] font-bold ${item.active ? '' : 'text-muted line-through'}`}>{item.name}</p>
          <p className="mt-0.5 truncate text-xs text-muted">{[item.jobTitle, LABEL.department[item.department], item.baseWage ? `${formatAmount(item.baseWage)} ${unitLabel()}` : ''].filter(Boolean).join(' · ') || '—'}</p>
        </div>
        <span title={item.completeness.missing.length ? `هنوز گفته نشده: ${item.completeness.missing.join('، ')}` : 'پرونده کامل است'}
          className={`numbers shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${item.completeness.percent === 100 ? 'bg-income/10 text-income' : 'bg-paper text-muted'}`}>
          {toPersianDigits(item.completeness.percent)}٪
        </span>
        {canManage && (item.active
          ? <button type="button" onClick={() => setEditing(item)} aria-label={`ویرایش ${item.name}`} className="tap grid h-9 w-9 place-items-center rounded-lg text-muted hover:text-accent"><Pencil size={16} /></button>
          : <button type="button" onClick={async () => { try { await api.resumePersonnel(item.id); load(); } catch (failure) { notify(failure.message); } }} className="tap rounded-lg px-2 text-xs font-bold text-muted hover:text-accent">بازگشت به کار</button>)}
      </li>)}
    </ul>}
  </section>;
}
