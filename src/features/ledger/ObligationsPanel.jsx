// برگهٔ «طلب و بدهی»: اشخاص، طلب یا بدهی تازه (دستی یا با صدا) و چک‌ها.
//
// از src/features/ledger/LedgerPage.jsx جدا شد؛ بدنهٔ کامپوننت‌ها دست نخورده است.

import ChequesPanel from './ChequesPanel.jsx';
import { HandCoins, Mic } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { PersianDateInput } from '../../components/common.jsx';
import { createPersianRecognizer, liveSpeechSupported } from '../../lib/liveSpeech.js';
import { createWavRecorder } from '../../lib/wavRecorder.js';
import { detectVoiceIntent } from '../../../shared/voiceIntent.js';
import { draftInLedgerUnit } from '../../../shared/amountUnit.js';
import { formatAmount, persianDate, unitLabel } from '../../lib/format.js';
import { normalizePersian } from '../../../shared/normalize.js';
import { withCounterpartyConfirmation } from '../../lib/counterpartyPrompt.js';

export function ObligationsPanel({ contacts: initialContacts, notify, refresh }) {
  const [contacts, setContacts] = useState(initialContacts || []);
  const [items, setItems] = useState([]);
  const [contactName, setContactName] = useState('');
  const [draft, setDraft] = useState({ title: '', amount: '', direction: 'receivable', contactId: '', dueAt: '', occurredAt: '' });
  const [dictating, setDictating] = useState(false);
  const [busyVoice, setBusyVoice] = useState(false);
  const [heard, setHeard] = useState('');
  const recognizerRef = useRef(null);
  const wavRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const liveFailedRef = useRef(false);
  const load = useCallback(async () => { const [people, obligations] = await Promise.all([api.contacts(), api.obligations('open')]); setContacts(people.items); setItems(obligations.items); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => {
    recognizerRef.current?.stop?.();
    wavRecorderRef.current?.dispose?.();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    audioContextRef.current?.close().catch(() => {});
  }, []);
  // بدون try، هر خطای سرور — از نام کوتاه تا پرسش طرف حساب مشابه — بی‌صدا از
  // دست می‌رفت و کاربر نمی‌فهمید چرا شخص اضافه نشد.
  const addContact = async () => {
    if (!contactName.trim()) return;
    try {
      await withCounterpartyConfirmation((counterpartyResolution) => api.saveContact({ name: contactName, counterpartyResolution }));
      setContactName(''); notify('شخص اضافه شد.'); load(); refresh();
    } catch (error) { notify(error.message); }
  };
  const add = async (event) => {
    event.preventDefault();
    // نام گفته‌شده همراه ثبت می‌رود؛ سرور شخص را پیدا یا ایجاد می‌کند تا کاربر
    // مجبور نباشد اول شخص را دستی بسازد.
    try {
      await withCounterpartyConfirmation((counterpartyResolution) => api.saveObligation({ ...draft, contactName: draft.contactId ? '' : draft.spokenName || '', counterpartyResolution }));
    } catch (error) { notify(error.message); return; }
    setDraft({ title: '', amount: '', direction: 'receivable', contactId: '', dueAt: '', occurredAt: '' });
    setHeard('');
    notify('سررسید ذخیره شد.');
    load();
    refresh();
  };

  /**
   * گفتهٔ کاربر روی همین صفحه تفسیر می‌شود، نه به‌عنوان تراکنش.
   *
   * تشخیص با تایپ زندهٔ مرورگر انجام می‌شود؛ نه سهمیهٔ صوت هوشمند مصرف می‌کند و
   * نه منتظر سرور می‌ماند. چیزی خودکار ذخیره نمی‌شود: فرم پر می‌شود و ثبت با
   * دکمهٔ خود کاربر است.
   */
  const applySpokenObligation = (transcript) => {
    const found = draftInLedgerUnit(detectVoiceIntent(transcript, { context: 'obligation' }));
    if (!found || !['obligation', 'cheque'].includes(found.intent)) {
      notify('از این جمله طلب یا بدهی برداشت نشد. مثلاً بگو «حسن سه میلیون بدهکار شد».');
      return;
    }
    const matched = found.contactName
      ? contacts.find((item) => normalizePersian(item.name) === normalizePersian(found.contactName))
      : null;
    setDraft((current) => ({
      ...current,
      title: found.contactName || found.title || current.title,
      amount: found.amount ? String(found.amount) : '',
      direction: found.direction || current.direction,
      contactId: matched?.id || '',
      spokenName: matched ? '' : found.contactName || '',
      dueAt: found.dueAt || current.dueAt,
      occurredAt: found.occurredAt || current.occurredAt,
    }));
    if (found.ambiguous) notify('جمله هم نشانهٔ طلب داشت هم بدهی؛ جهت را خودت انتخاب کن.');
    else if (!found.amount) notify(`«${found.contactName || 'طرف حساب'}» ثبت شد؛ مبلغ را بنویس.`);
  };

  /**
   * وقتی تشخیص زندهٔ مرورگر جواب نمی‌دهد، صدا روی سرور بررسی می‌شود.
   *
   * تشخیص زندهٔ Chrome به سرویس بیرونی وصل می‌شود و در بعضی شبکه‌ها اصلاً بالا
   * نمی‌آید. بدون این مسیر، دکمهٔ میکروفن روی همان دستگاه‌ها فقط یک پیام خطا بود.
   * این مسیر سهمیهٔ «پردازش صوت هوشمند» مصرف می‌کند و صریح گفته می‌شود.
   */
  const reviewRecordingOnServer = async () => {
    const capture = wavRecorderRef.current?.stop() || null;
    wavRecorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    if (!capture?.blob || capture.durationMs < 400) return false;
    setBusyVoice(true);
    try {
      const result = await api.parseAudio(capture.blob, { attemptId: crypto.randomUUID() });
      const transcript = result.transcript || '';
      setHeard(transcript);
      if (!transcript.trim()) { notify('از این صدا متنی درنیامد؛ دوباره و شمرده‌تر بگو.'); return true; }
      applySpokenObligation(transcript);
      return true;
    } catch (error) {
      notify(error.code === 'PLAN_QUOTA_EXCEEDED'
        ? 'تشخیص زندهٔ مرورگر جواب نداد و سهمیهٔ بررسی روی سرور هم تمام شده؛ فعلاً دستی بنویس.'
        : error.message);
      return true;
    } finally { setBusyVoice(false); }
  };

  const stopDictation = () => {
    recognizerRef.current?.stop();
    recognizerRef.current = null;
    setDictating(false);
  };

  const toggleDictation = async () => {
    if (dictating) { stopDictation(); return; }
    setHeard('');
    liveFailedRef.current = false;
    let latest = '';
    // صدا از همان ابتدا ضبط می‌شود، حتی وقتی تشخیص زنده کار می‌کند: اگر وسط کار
    // شکست بخورد، گفتهٔ کاربر از دست نمی‌رود و همان ضبط روی سرور بررسی می‌شود.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      streamRef.current = stream;
      const context = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = context;
      wavRecorderRef.current = createWavRecorder(context, stream);
    } catch {
      notify('میکروفن در دسترس نیست یا اجازه‌اش داده نشده است.');
      return;
    }
    if (!liveSpeechSupported()) {
      // مرورگری که تایپ زنده ندارد مستقیم به مسیر سرور می‌رود؛ پیام پیش از مصرف.
      notify('این مرورگر تایپ زندهٔ فارسی ندارد؛ صدا روی سرور بررسی می‌شود و از سهمیهٔ صوت هوشمند کم می‌کند.');
      setDictating(true);
      liveFailedRef.current = true;
      return;
    }
    const recognizer = createPersianRecognizer({
      onUpdate: (snapshot) => { latest = snapshot.transcript; setHeard(snapshot.transcript); },
      onEnd: async () => {
        setDictating(false);
        recognizerRef.current = null;
        if (latest.trim()) {
          wavRecorderRef.current?.dispose?.();
          wavRecorderRef.current = null;
          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          audioContextRef.current?.close().catch(() => {});
          audioContextRef.current = null;
          applySpokenObligation(latest);
          return;
        }
        if (liveFailedRef.current) { await reviewRecordingOnServer(); return; }
        // تشخیص زنده سالم بود ولی چیزی نگفت: ضبط دور ریخته می‌شود، نه اینکه
        // بی‌دلیل سهمیهٔ سرور خرج شود.
        wavRecorderRef.current?.dispose?.();
        wavRecorderRef.current = null;
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        audioContextRef.current?.close().catch(() => {});
        audioContextRef.current = null;
        notify('چیزی نشنیدم؛ دوباره روی میکروفن بزن و بگو.');
      },
      onError: (code) => {
        // «چیزی نشنیدم» و «متوقف شد» خطا نیستند؛ همان ضبط روی سرور بررسی می‌شود.
        liveFailedRef.current = true;
        if (!['no-speech', 'aborted'].includes(code)) {
          notify(`تشخیص زندهٔ مرورگر جواب نداد (${code})؛ همین صدا روی سرور بررسی می‌شود.`);
        }
      },
    });
    recognizerRef.current = recognizer;
    try { recognizer.start(); setDictating(true); } catch { liveFailedRef.current = true; setDictating(true); }
  };

  const finishDictation = async () => {
    if (recognizerRef.current) { stopDictation(); return; }
    setDictating(false);
    await reviewRecordingOnServer();
  };
  /**
   * تسویه — کامل یا به‌اندازهٔ همان چیزی که واقعاً پرداخت شده.
   *
   * مشتری سی درصد می‌دهد و بقیه را ماه بعد؛ تا پیش از این چاره‌ای جز بستن کل
   * طلب نبود و ماندهٔ واقعی از دفتر گم می‌شد.
   */
  const settle = async (item, partial = false) => {
    const remaining = item.remaining ?? item.amount;
    let amount;
    if (partial) {
      const answer = window.prompt(`چقدر از «${item.title}» پرداخت شد؟ مانده ${formatAmount(remaining)} ${unitLabel()} است.`, String(remaining));
      if (!answer) return;
      amount = Number(String(answer).replace(/[^\d]/g, ''));
      if (!amount) { notify('مبلغ تسویه خوانده نشد.'); return; }
    }
    try {
      const result = await api.settleObligation(item.id, partial ? { amount } : {});
      const left = result?.item?.remaining ?? 0;
      notify(left > 0 ? `${formatAmount(amount)} ${unitLabel()} تسویه شد؛ ${formatAmount(left)} ${unitLabel()} مانده.` : 'تسویه شد و تراکنش آن در دفتر ثبت شد.');
      load(); refresh();
    } catch (error) { notify(error.message); }
  };
  return <section className="mt-5 space-y-6"><div><h2 className="font-extrabold">اشخاص</h2><div className="mt-2 flex gap-2"><input value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="نام شخص یا مشتری" className="tap min-w-0 flex-1 rounded-lg border border-line bg-surface px-3" /><button onClick={addContact} className="tap rounded-lg bg-ink px-4 font-bold text-on-fill hover:bg-ink/90">افزودن</button></div><div className="scrollbar-none mt-2 flex gap-2 overflow-x-auto">{contacts.map((contact) => <span key={contact.id} className="shrink-0 rounded-lg border border-line bg-surface px-3 py-2 text-xs"><b>{contact.name}</b>{Number(contact.balance) !== 0 && <span className={`numbers mr-2 ${contact.balance > 0 ? 'text-income' : 'text-expense'}`}>{formatAmount(Math.abs(contact.balance))}</span>}</span>)}</div></div><form onSubmit={add} className="rounded-xl border border-line bg-surface p-3"><div className="flex items-start justify-between gap-3"><div><h2 className="font-extrabold">طلب یا بدهی تازه</h2><p className="mt-1 text-xs leading-5 text-muted">می‌توانی بگویی «حسن سه میلیون بدهکار شد». شخص تازه خودش ساخته می‌شود و ثبت با دکمهٔ خودت انجام می‌شود.</p></div><button type="button" disabled={busyVoice} onClick={dictating ? finishDictation : toggleDictation} className={`tap grid shrink-0 place-items-center rounded-lg border px-3 disabled:opacity-40 ${dictating ? 'border-expense bg-expense/10 text-expense' : 'border-line text-accent'}`} aria-label={dictating ? 'پایان گفتن' : 'گفتن طلب یا بدهی'}>{busyVoice ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" /> : <Mic size={19} />}</button></div>{dictating && <p className="mt-2 text-xs font-bold text-expense">در حال شنیدن… وقتی حرفت تمام شد دوباره روی میکروفن بزن.</p>}{busyVoice && <p className="mt-2 text-xs font-bold text-accent">صدا روی سرور بررسی می‌شود…</p>}{heard && <blockquote className="mt-2 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] leading-6 text-muted">«{heard}»</blockquote>}{draft.spokenName && <p className="mt-2 text-xs leading-5 text-accent">شخص «{draft.spokenName}» در دفتر نیست و با ذخیره‌شدن این ثبت ساخته می‌شود.</p>}{(draft.occurredAt || draft.dueAt) && <p className="mt-1 text-xs leading-5 text-muted">{draft.occurredAt && <>تاریخ بدهکار/طلبکار شدن: <b className="text-ink">{persianDate(draft.occurredAt)}</b></>}{draft.occurredAt && draft.dueAt ? ' · ' : ''}{draft.dueAt && <>سررسید: <b className="text-ink">{persianDate(draft.dueAt)}</b></>}</p>}<div className="mt-3 grid gap-2 sm:grid-cols-2"><input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="مثلاً طلب از حسن" className="tap rounded-lg border border-line px-3" /><input required inputMode="numeric" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/\D/g, '') })} placeholder={`مبلغ ${unitLabel()}`} className="tap numbers rounded-lg border border-line px-3" /><select value={draft.direction} onChange={(event) => setDraft({ ...draft, direction: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="receivable">طلب دارم</option><option value="payable">بدهکارم</option></select><select value={draft.contactId} onChange={(event) => setDraft({ ...draft, contactId: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="">بدون شخص</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select><label className="text-xs text-muted">تاریخ بدهکار/طلبکار شدن<PersianDateInput value={draft.occurredAt} onChange={(iso) => setDraft({ ...draft, occurredAt: iso })} /></label><label className="text-xs text-muted">سررسید<PersianDateInput value={draft.dueAt} onChange={(iso) => setDraft({ ...draft, dueAt: iso })} /></label><button className="tap rounded-lg bg-accent font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">ذخیره سررسید</button></div></form><div className="divide-y divide-line border-y border-line">{items.length ? items.map((item) => <article key={item.id} className="flex min-h-[76px] items-center gap-3 py-3"><HandCoins className={item.direction === 'receivable' ? 'text-income' : 'text-expense'} /><div className="min-w-0 flex-1"><p className="font-bold">{item.title}</p><p className="mt-1 text-xs text-muted">{item.contactName || 'بدون شخص'}{item.dueAt ? ` · سررسید ${new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(item.dueAt))}` : ''}</p>{item.journalStatus !== 'posted' && <p className="mt-1 text-xs font-bold text-expense">{item.journalStatus === 'legacy' ? 'سند اولیه ندارد؛ مانده باید با حسابدار تطبیق داده شود' : 'سند اولیه هنوز قطعی نشده؛ در صف بررسی پیگیری کن'}</p>}</div><div className="shrink-0 text-left"><b className="numbers block text-sm">{formatAmount(item.remaining ?? item.amount)}</b>{item.paidAmount > 0 && <span className="numbers block text-xs text-muted">از {formatAmount(item.amount)}</span>}</div><div className="flex shrink-0 gap-1"><button disabled={item.journalStatus !== 'posted'} onClick={() => settle(item, true)} className="tap rounded-lg border border-line px-2 text-xs font-bold text-muted disabled:opacity-40 hover:bg-paper hover:text-ink">بخشی</button><button disabled={item.journalStatus !== 'posted'} onClick={() => settle(item)} className="tap rounded-lg border border-income px-3 text-xs font-bold text-income disabled:opacity-40">تسویه</button></div></article>) : <p className="py-10 text-center text-sm text-muted">طلب یا بدهی بازی نداری.</p>}</div><ChequesPanel contacts={contacts} notify={notify} refresh={refresh} /></section>;
}
