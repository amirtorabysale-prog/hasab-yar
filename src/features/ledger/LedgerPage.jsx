import BankVoicePanel from './BankVoicePanel.jsx';
import ChequesPanel from './ChequesPanel.jsx';
import { AccountCardsPanel } from '../counterparty/AccountCardsPanel.jsx';
import { TimingContractsPanel } from './TimingContractsPanel.jsx';
import { Check, HandCoins, Landmark, Mic, PackageSearch, Pencil, Plus, Printer, ReceiptText, RotateCcw, Search, Sparkles, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PRODUCT_POSITIONING, profileDefinition } from '../../../shared/product.js';
import { api } from '../../lib/api.js';
import { PersianDateInput } from '../../components/common.jsx';
import { createPersianRecognizer, liveSpeechErrorMessage, liveSpeechSupported } from '../../lib/liveSpeech.js';
import { createWavRecorder } from '../../lib/wavRecorder.js';
import { detectVoiceIntent } from '../../../shared/voiceIntent.js';
import { formatAmount, formatSignedAmount, persianDate, toPersianDigits } from '../../lib/format.js';
import { normalizePersian } from '../../../shared/normalize.js';
import { withCounterpartyConfirmation } from '../../lib/counterpartyPrompt.js';

/**
 * `<input type="date">` فقط `YYYY-MM-DD` میلادی می‌پذیرد.
 * تا امروز مقدار ISO کامل به آن داده می‌شد و کادر خالی می‌ماند — یعنی هر تاریخی
 * که سیستم می‌فهمید، برای کاربر نامرئی بود.
 */
function isoToDateInput(iso, timeZone = 'Asia/Tehran') {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}


const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);

export function LedgerPage({ profileType = 'business', categories, accounts = [], contacts: initialContacts, notify, refresh, initialTab = 'transactions', cardSection = '' }) {
  const [tab, setTab] = useState(initialTab);
  const profile = profileDefinition(profileType);
  const allTabs = [['transactions', profileType === 'personal' ? 'ثبت‌ها' : 'تراکنش‌ها'], ['obligations', profileType === 'personal' ? 'قسط و بدهی' : 'طلب و بدهی'], ['timing', 'پیش‌پرداخت و پیش‌دریافت'], ['counterparties', 'کارت حساب'], ['invoices', 'فاکتور'], ['reconciliation', 'تطبیق بانک'], ['recurring', 'دوره‌ای'], ['inventory', 'موجودی'], ['tools', 'ابزارها']];
  const tabs = allTabs.filter(([id]) => profile.ledgerTabs.includes(id));
  useEffect(() => { if (profile.ledgerTabs.includes(initialTab)) setTab(initialTab); }, [initialTab, profileType]);
  useEffect(() => { if (!profile.ledgerTabs.includes(tab)) setTab('transactions'); }, [profile, tab]);
  return <main className="mx-auto w-full max-w-[900px] px-4 py-5"><div className="flex items-center justify-between"><div><h1 className="text-xl font-extrabold">دفتر مالی</h1><p className="mt-1 text-[13px] text-muted">{profile.description}</p></div></div><div className="scrollbar-none -mx-4 mt-5 flex gap-2 overflow-x-auto border-b border-line px-4 pb-3">{tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} className={`tap shrink-0 rounded-lg px-4 text-sm font-bold ${tab === id ? 'bg-ink text-on-fill' : 'border border-line bg-surface text-muted'} hover:bg-ink/90`}>{label}</button>)}</div>{tab === 'transactions' && <TransactionsPanel categories={categories} accounts={accounts} contacts={initialContacts} notify={notify} refresh={refresh} />}{tab === 'obligations' && <ObligationsPanel contacts={initialContacts} notify={notify} refresh={refresh} />}{tab === 'timing' && <TimingContractsPanel notify={notify} />}{tab === 'counterparties' && <AccountCardsPanel accounts={accounts} contacts={initialContacts} notify={notify} refresh={refresh} initialSection={cardSection} />}{tab === 'invoices' && <InvoicesPanel contacts={initialContacts} accounts={accounts} categories={categories} notify={notify} refresh={refresh} />}{tab === 'reconciliation' && <ReconciliationPanel accounts={accounts} categories={categories} notify={notify} refresh={refresh} />}{tab === 'recurring' && <RecurringPanel categories={categories} notify={notify} />}{tab === 'inventory' && <InventoryPanel notify={notify} />}{tab === 'tools' && <ToolsPanel profileType={profileType} accounts={accounts} categories={categories} notify={notify} refresh={refresh} />}</main>;
}

function TransactionsPanel({ categories, accounts = [], contacts, notify, refresh }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [result, setResult] = useState({ items: [], total: 0 });
  const [editing, setEditing] = useState(null);
  const load = useCallback(() => api.transactions({ query, type, limit: 50 }).then(setResult).catch((error) => notify(error.message)), [query, type, notify]);
  useEffect(() => { const timer = window.setTimeout(load, 180); return () => window.clearTimeout(timer); }, [load]);
  const remove = async (id) => { if (!window.confirm('این تراکنش از دفتر حذف شود؟ سابقهٔ تغییر برای امنیت باقی می‌ماند.')) return; await api.deleteTransaction(id); notify('تراکنش حذف شد.'); load(); refresh(); };
  const save = async (event) => { event.preventDefault(); try { await api.updateTransaction(editing.id, editing); } catch (error) { notify(error.message); return; } setEditing(null); notify('اصلاح تراکنش ذخیره شد.'); load(); refresh(); };
  return <section className="mt-5"><div className="grid gap-2 sm:grid-cols-[1fr_160px]"><label className="flex min-h-12 items-center gap-2 rounded-lg border border-line bg-surface px-3 hover:bg-paper hover:text-ink"><Search size={18} className="text-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="جست‌وجوی مبلغ، دسته، شخص یا توضیح" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label><select value={type} onChange={(event) => setType(event.target.value)} className="tap rounded-lg border border-line bg-surface px-3 text-sm"><option value="">همهٔ نوع‌ها</option><option value="income">درآمد</option><option value="expense">هزینه</option></select></div><p className="mt-3 text-xs text-muted">{toPersianDigits(result.total)} ثبت پیدا شد</p><div className="mt-2 divide-y divide-line border-y border-line">{result.items.map((item) => <article key={item.id} className="flex min-h-[78px] items-center gap-3 py-3"><div className="min-w-0 flex-1"><p className={`numbers font-extrabold ${item.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatSignedAmount(item)} <small className="font-normal text-muted">تومان</small></p><p className="mt-1 truncate text-xs text-muted">{item.category}{item.accountName ? ` · ${item.accountName}` : ''}{item.contactName ? ` · ${item.contactName}` : ''} · {item.rawText}</p>{item.journalDeferred === 1 && <p className="mt-1 text-xs font-bold text-expense">در انتظار بررسی — در ماندهٔ قطعی محاسبه نشده است</p>}{item.status === 'allocated' && <p className="mt-1 text-xs font-bold text-accent">متصل به تسویه سند — اصلاح از بخش فاکتور</p>}</div>{item.status !== 'allocated' && !item.journalDeferred && <><button onClick={() => setEditing(item)} className="tap grid place-items-center text-muted" aria-label="ویرایش"><Pencil size={18} /></button><button onClick={() => remove(item.id)} className="tap grid place-items-center text-expense" aria-label="حذف"><Trash2 size={18} /></button></>}</article>)}</div>{editing && <div className="fixed inset-0 z-[75] grid place-items-center bg-scrim/40 p-4"><form onSubmit={save} className="w-full max-w-[480px] rounded-2xl bg-paper p-4"><div className="flex justify-between"><h2 className="text-lg font-extrabold">اصلاح تراکنش</h2><button type="button" onClick={() => setEditing(null)} className="tap grid place-items-center"><X /></button></div><label className="mt-4 block text-xs text-muted">مبلغ<input inputMode="numeric" value={editing.amount} onChange={(event) => setEditing({ ...editing, amount: event.target.value.replace(/\D/g, '') })} className="tap numbers mt-2 w-full rounded-lg border border-line bg-surface px-3 text-lg font-bold" /></label><div className="mt-3 grid grid-cols-2 gap-2"><select value={editing.type} onChange={(event) => setEditing({ ...editing, type: event.target.value })} className="tap rounded-lg border border-line bg-surface px-3"><option value="income">درآمد</option><option value="expense">هزینه</option></select><select value={editing.category} onChange={(event) => setEditing({ ...editing, category: event.target.value })} className="tap min-w-0 rounded-lg border border-line bg-surface px-3">{categories.filter((item) => item.type === editing.type).map((item) => <option key={item.id}>{item.name}</option>)}</select></div><select value={editing.accountId || 'cash'} onChange={(event) => setEditing({ ...editing, accountId: event.target.value })} className="tap mt-3 w-full rounded-lg border border-line bg-surface px-3">{accounts.filter((account) => account.active).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select><select value={editing.contactId || ''} onChange={(event) => setEditing({ ...editing, contactId: event.target.value })} className="tap mt-3 w-full rounded-lg border border-line bg-surface px-3"><option value="">بدون شخص</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select><textarea value={editing.note || ''} onChange={(event) => setEditing({ ...editing, note: event.target.value })} placeholder="یادداشت" className="mt-3 min-h-20 w-full rounded-lg border border-line bg-surface p-3 text-sm" /><button className="tap mt-3 w-full rounded-lg bg-accent font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">ذخیره اصلاح</button></form></div>}</section>;
}

function ObligationsPanel({ contacts: initialContacts, notify, refresh }) {
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
    const found = detectVoiceIntent(transcript, { context: 'obligation' });
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
      const answer = window.prompt(`چقدر از «${item.title}» پرداخت شد؟ مانده ${formatAmount(remaining)} تومان است.`, String(remaining));
      if (!answer) return;
      amount = Number(String(answer).replace(/[^\d]/g, ''));
      if (!amount) { notify('مبلغ تسویه خوانده نشد.'); return; }
    }
    try {
      const result = await api.settleObligation(item.id, partial ? { amount } : {});
      const left = result?.item?.remaining ?? 0;
      notify(left > 0 ? `${formatAmount(amount)} تومان تسویه شد؛ ${formatAmount(left)} تومان مانده.` : 'تسویه شد و تراکنش آن در دفتر ثبت شد.');
      load(); refresh();
    } catch (error) { notify(error.message); }
  };
  return <section className="mt-5 space-y-6"><div><h2 className="font-extrabold">اشخاص</h2><div className="mt-2 flex gap-2"><input value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="نام شخص یا مشتری" className="tap min-w-0 flex-1 rounded-lg border border-line bg-surface px-3" /><button onClick={addContact} className="tap rounded-lg bg-ink px-4 font-bold text-on-fill hover:bg-ink/90">افزودن</button></div><div className="scrollbar-none mt-2 flex gap-2 overflow-x-auto">{contacts.map((contact) => <span key={contact.id} className="shrink-0 rounded-lg border border-line bg-surface px-3 py-2 text-xs"><b>{contact.name}</b>{Number(contact.balance) !== 0 && <span className={`numbers mr-2 ${contact.balance > 0 ? 'text-income' : 'text-expense'}`}>{formatAmount(Math.abs(contact.balance))}</span>}</span>)}</div></div><form onSubmit={add} className="rounded-xl border border-line bg-surface p-3"><div className="flex items-start justify-between gap-3"><div><h2 className="font-extrabold">طلب یا بدهی تازه</h2><p className="mt-1 text-xs leading-5 text-muted">می‌توانی بگویی «حسن سه میلیون بدهکار شد». شخص تازه خودش ساخته می‌شود و ثبت با دکمهٔ خودت انجام می‌شود.</p></div><button type="button" disabled={busyVoice} onClick={dictating ? finishDictation : toggleDictation} className={`tap grid shrink-0 place-items-center rounded-lg border px-3 disabled:opacity-40 ${dictating ? 'border-expense bg-expense/10 text-expense' : 'border-line text-accent'}`} aria-label={dictating ? 'پایان گفتن' : 'گفتن طلب یا بدهی'}>{busyVoice ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" /> : <Mic size={19} />}</button></div>{dictating && <p className="mt-2 text-xs font-bold text-expense">در حال شنیدن… وقتی حرفت تمام شد دوباره روی میکروفن بزن.</p>}{busyVoice && <p className="mt-2 text-xs font-bold text-accent">صدا روی سرور بررسی می‌شود…</p>}{heard && <blockquote className="mt-2 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] leading-6 text-muted">«{heard}»</blockquote>}{draft.spokenName && <p className="mt-2 text-xs leading-5 text-accent">شخص «{draft.spokenName}» در دفتر نیست و با ذخیره‌شدن این ثبت ساخته می‌شود.</p>}{(draft.occurredAt || draft.dueAt) && <p className="mt-1 text-xs leading-5 text-muted">{draft.occurredAt && <>تاریخ بدهکار/طلبکار شدن: <b className="text-ink">{persianDate(draft.occurredAt)}</b></>}{draft.occurredAt && draft.dueAt ? ' · ' : ''}{draft.dueAt && <>سررسید: <b className="text-ink">{persianDate(draft.dueAt)}</b></>}</p>}<div className="mt-3 grid gap-2 sm:grid-cols-2"><input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="مثلاً طلب از حسن" className="tap rounded-lg border border-line px-3" /><input required inputMode="numeric" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/\D/g, '') })} placeholder="مبلغ تومان" className="tap numbers rounded-lg border border-line px-3" /><select value={draft.direction} onChange={(event) => setDraft({ ...draft, direction: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="receivable">طلب دارم</option><option value="payable">بدهکارم</option></select><select value={draft.contactId} onChange={(event) => setDraft({ ...draft, contactId: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="">بدون شخص</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select><label className="text-xs text-muted">تاریخ بدهکار/طلبکار شدن<PersianDateInput value={draft.occurredAt} onChange={(iso) => setDraft({ ...draft, occurredAt: iso })} /></label><label className="text-xs text-muted">سررسید<PersianDateInput value={draft.dueAt} onChange={(iso) => setDraft({ ...draft, dueAt: iso })} /></label><button className="tap rounded-lg bg-accent font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">ذخیره سررسید</button></div></form><div className="divide-y divide-line border-y border-line">{items.length ? items.map((item) => <article key={item.id} className="flex min-h-[76px] items-center gap-3 py-3"><HandCoins className={item.direction === 'receivable' ? 'text-income' : 'text-expense'} /><div className="min-w-0 flex-1"><p className="font-bold">{item.title}</p><p className="mt-1 text-xs text-muted">{item.contactName || 'بدون شخص'}{item.dueAt ? ` · سررسید ${new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(item.dueAt))}` : ''}</p>{item.journalStatus !== 'posted' && <p className="mt-1 text-xs font-bold text-expense">{item.journalStatus === 'legacy' ? 'سند اولیه ندارد؛ مانده باید با حسابدار تطبیق داده شود' : 'سند اولیه هنوز قطعی نشده؛ در صف بررسی پیگیری کن'}</p>}</div><div className="shrink-0 text-left"><b className="numbers block text-sm">{formatAmount(item.remaining ?? item.amount)}</b>{item.paidAmount > 0 && <span className="numbers block text-xs text-muted">از {formatAmount(item.amount)}</span>}</div><div className="flex shrink-0 gap-1"><button disabled={item.journalStatus !== 'posted'} onClick={() => settle(item, true)} className="tap rounded-lg border border-line px-2 text-xs font-bold text-muted disabled:opacity-40 hover:bg-paper hover:text-ink">بخشی</button><button disabled={item.journalStatus !== 'posted'} onClick={() => settle(item)} className="tap rounded-lg border border-income px-3 text-xs font-bold text-income disabled:opacity-40">تسویه</button></div></article>) : <p className="py-10 text-center text-sm text-muted">طلب یا بدهی بازی نداری.</p>}</div><ChequesPanel contacts={contacts} notify={notify} refresh={refresh} /></section>;
}

function InvoicesPanel({ contacts, accounts, categories, notify, refresh }) {
  const emptyDraft = { documentType: 'sales', customerName: '', contactId: '', category: 'فروش', dueAt: '', discount: '', note: '', issueNow: true, items: [{ productId: '', title: '', quantity: 1, unitPrice: '', taxRateId: '' }] };
  const [result, setResult] = useState({ items: [], summary: {} });
  const [products, setProducts] = useState([]);
  const [taxRates, setTaxRates] = useState([]);
  const [filter, setFilter] = useState('all');
  const [draft, setDraft] = useState(emptyDraft);
  const [payment, setPayment] = useState(null);
  const load = useCallback(() => api.invoices(filter === 'all' ? {} : { documentType: filter }).then(setResult), [filter]);
  useEffect(() => {
    load();
    api.products().then((response) => setProducts(response.items)).catch(() => {});
    api.taxRates().then((response) => {
      const rates = response.items || [];
      const defaultRateId = rates.find((item) => item.active && item.isDefault)?.id || 'tax-none';
      setTaxRates(rates);
      setDraft((current) => ({ ...current, items: current.items.map((line) => ({ ...line, taxRateId: line.taxRateId || defaultRateId })) }));
    }).catch(() => {});
  }, [load]);
  const defaultTaxRateId = () => taxRates.find((item) => item.active && item.isDefault)?.id || 'tax-none';
  const freshDraft = () => ({ ...emptyDraft, items: [{ productId: '', title: '', quantity: 1, unitPrice: '', taxRateId: defaultTaxRateId() }] });
  const patchLine = (index, changes) => setDraft((current) => ({ ...current, items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item) }));
  const chooseProduct = (index, productId) => { const product = products.find((item) => item.id === productId); patchLine(index, product ? { productId, title: product.name, unitPrice: String(draft.documentType === 'purchase' ? product.buyPrice || product.averageCost || '' : product.salePrice || '') } : { productId: '' }); };
  const changeType = (documentType) => setDraft((current) => ({ ...current, documentType, category: documentType === 'purchase' ? 'مواد و کالا' : 'فروش', items: current.items.map((line) => ({ ...line, unitPrice: line.productId ? String((documentType === 'purchase' ? products.find((item) => item.id === line.productId)?.buyPrice : products.find((item) => item.id === line.productId)?.salePrice) || '') : line.unitPrice })) }));
  const invoicePreview = useMemo(() => {
    const lines = draft.items.map((line) => ({ total: Math.round((Number(line.quantity) || 0) * (Number(line.unitPrice) || 0)), taxRateId: line.taxRateId }));
    const subtotal = lines.reduce((sum, line) => sum + line.total, 0);
    const discount = Math.min(subtotal, Math.max(0, Number(draft.discount) || 0));
    let allocated = 0;
    const tax = lines.reduce((sum, line, index) => {
      const remaining = Math.max(0, discount - allocated);
      const proportional = subtotal ? Math.round(discount * line.total / subtotal) : 0;
      const share = index === lines.length - 1 ? remaining : Math.min(remaining, proportional);
      allocated += share;
      const rate = taxRates.find((item) => item.id === line.taxRateId);
      return sum + (rate?.treatment === 'taxable' ? Math.round(Math.max(0, line.total - share) * rate.rateBps / 10000) : 0);
    }, 0);
    return { subtotal, discount, tax, total: subtotal - discount + tax };
  }, [draft.discount, draft.items, taxRates]);
  const save = async (event) => { event.preventDefault(); try { await withCounterpartyConfirmation((counterpartyResolution) => api.saveInvoice({ ...draft, counterpartyResolution })); } catch (error) { notify(error.message); return; } setDraft(freshDraft()); notify(draft.issueNow ? 'سند صادر و مالیات آن در دفتر کل تفکیک شد.' : 'پیش‌نویس ذخیره شد.'); load(); refresh(); };
  const issue = async (id) => { await api.issueInvoice(id); notify('سند صادر و حساب طرف مقابل ثبت شد.'); load(); refresh(); };
  const openPayment = (item) => setPayment({ id: item.id, amount: String(item.balanceDue), accountId: accounts.find((account) => account.active)?.id || 'cash', documentType: item.documentType, number: item.number });
  const pay = async (event) => { event.preventDefault(); await api.recordInvoicePayment(payment.id, payment); setPayment(null); notify(payment.documentType === 'purchase' ? 'پرداخت ثبت شد.' : 'وصول ثبت شد.'); load(); refresh(); };
  const print = async (id) => { const { item } = await api.invoice(id); const popup = window.open('', '_blank', 'width=760,height=900'); if (!popup) return notify('اجازهٔ بازکردن پنجرهٔ چاپ را فعال کن.'); popup.document.write(`<html dir="rtl"><head><title>${escapeHtml(item.number)}</title><style>body{font-family:Tahoma;padding:40px;color:#1c1b19}h1{border-bottom:2px solid #1c1b19;padding-bottom:16px}table{width:100%;border-collapse:collapse;margin-top:30px}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:right}.summary{margin-top:24px;margin-right:auto;width:280px}.summary p{display:flex;justify-content:space-between}.total{font-size:22px;font-weight:bold;border-top:2px solid #1c1b19;padding-top:12px}</style></head><body><h1>${item.documentType === 'purchase' ? 'صورتحساب خرید' : 'فاکتور فروش'} ${escapeHtml(item.number)}</h1><p>طرف حساب: ${escapeHtml(item.customerName)}</p><table><thead><tr><th>شرح</th><th>تعداد</th><th>مبلغ واحد</th><th>جمع</th><th>مالیات</th></tr></thead><tbody>${item.items.map((line) => `<tr><td>${escapeHtml(line.title)}</td><td>${escapeHtml(line.quantity)}</td><td>${formatAmount(line.unitPrice)}</td><td>${formatAmount(line.total)}</td><td>${formatAmount(line.taxAmount || 0)}</td></tr>`).join('')}</tbody></table><div class="summary"><p><span>جمع اقلام</span><b>${formatAmount(item.subtotal)}</b></p><p><span>تخفیف</span><b>${formatAmount(item.discount)}</b></p><p><span>مالیات و عوارض</span><b>${formatAmount(item.tax)}</b></p><p class="total"><span>جمع کل</span><b>${formatAmount(item.total)} تومان</b></p></div><script>window.print()<\/script></body></html>`); popup.document.close(); };
  const statusLabels = { draft: 'پیش‌نویس', open: 'باز', partial: 'بخشی تسویه شده', overdue: 'سررسید گذشته', paid: 'تسویه کامل', cancelled: 'باطل‌شده' };
  return <section className="mt-5 space-y-6">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">مطالبات باز</p><b className="numbers mt-2 block text-lg text-income">{formatAmount(result.summary.receivable || 0)}</b></div><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">بدهی تأمین‌کننده</p><b className="numbers mt-2 block text-lg text-expense">{formatAmount(result.summary.payable || 0)}</b></div><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">مطالبات معوق</p><b className="numbers mt-2 block text-lg">{formatAmount(result.summary.overdueReceivable || 0)}</b></div><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">پرداخت معوق</p><b className="numbers mt-2 block text-lg">{formatAmount(result.summary.overduePayable || 0)}</b></div></div>
    <form onSubmit={save} className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-extrabold">سند تازه</h2><p className="mt-1 text-xs text-muted">مالیات هر ردیف قبل از صدور محاسبه و در حساب جداگانه ثبت می‌شود.</p></div><div className="flex rounded-lg border border-line p-1"><button type="button" onClick={() => changeType('sales')} className={`tap rounded-md px-4 text-sm font-bold ${draft.documentType === 'sales' ? 'bg-income text-on-fill' : 'text-muted'}`}>فروش</button><button type="button" onClick={() => changeType('purchase')} className={`tap rounded-md px-4 text-sm font-bold ${draft.documentType === 'purchase' ? 'bg-expense text-on-fill' : 'text-muted'} hover:bg-expense/90`}>خرید</button></div></div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2"><input required value={draft.customerName} onChange={(event) => setDraft({ ...draft, customerName: event.target.value })} placeholder={draft.documentType === 'purchase' ? 'نام تأمین‌کننده' : 'نام مشتری'} className="tap rounded-lg border border-line px-3" /><select value={draft.contactId} onChange={(event) => setDraft({ ...draft, contactId: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="">طرف حساب ثبت‌شده (اختیاری)</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="tap rounded-lg border border-line px-3">{categories.filter((item) => item.type === (draft.documentType === 'purchase' ? 'expense' : 'income')).map((item) => <option key={item.id}>{item.name}</option>)}</select><label className="flex items-center gap-2 rounded-lg border border-line px-3 text-xs text-muted hover:bg-paper hover:text-ink">سررسید<input type="date" value={isoToDateInput(draft.dueAt)} onChange={(event) => setDraft({ ...draft, dueAt: event.target.value ? new Date(`${event.target.value}T09:00:00`).toISOString() : '' })} className="tap min-w-0 flex-1 bg-transparent text-ink" /></label></div>
      {draft.items.map((line, index) => <div key={index} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-[140px_minmax(0,1fr)_70px_110px_135px]"><select value={line.productId} onChange={(event) => chooseProduct(index, event.target.value)} className="tap min-w-0 rounded-lg border border-line bg-paper px-2 text-xs"><option value="">خدمت / بدون انبار</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {toPersianDigits(product.stock)} {product.unit}</option>)}</select><input required value={line.title} onChange={(event) => patchLine(index, { title: event.target.value })} placeholder="شرح کالا یا خدمت" className="tap min-w-0 rounded-lg border border-line px-3" /><input inputMode="decimal" value={line.quantity} onChange={(event) => patchLine(index, { quantity: event.target.value })} placeholder="تعداد" className="tap numbers min-w-0 rounded-lg border border-line px-2" /><input required inputMode="numeric" value={line.unitPrice} onChange={(event) => patchLine(index, { unitPrice: event.target.value.replace(/\D/g, '') })} placeholder="مبلغ واحد" className="tap numbers min-w-0 rounded-lg border border-line px-2" /><select aria-label="نوع و نرخ مالیات" value={line.taxRateId || defaultTaxRateId()} onChange={(event) => patchLine(index, { taxRateId: event.target.value })} className="tap min-w-0 rounded-lg border border-line bg-surface px-2 text-xs">{taxRates.filter((rate) => rate.active).map((rate) => <option key={rate.id} value={rate.id}>{rate.name} · {toPersianDigits(rate.rate)}٪</option>)}</select></div>)}
      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(280px,1fr)]"><input inputMode="numeric" value={draft.discount} onChange={(event) => setDraft({ ...draft, discount: event.target.value.replace(/\D/g, '') })} placeholder="تخفیف (تومان)" className="tap numbers rounded-lg border border-line px-3" /><div className="grid grid-cols-2 gap-2 rounded-lg bg-paper px-3 py-2 text-xs"><span className="text-muted">مالیات محاسبه‌شده<b className="numbers mt-1 block text-sm text-ink">{formatAmount(invoicePreview.tax)}</b></span><span className="text-muted">جمع قابل پرداخت<b className="numbers mt-1 block text-sm text-ink">{formatAmount(invoicePreview.total)}</b></span></div></div>
      <p className="mt-2 text-xs leading-5 text-muted">تخفیف به نسبت مبلغ ردیف‌ها تقسیم می‌شود. مالیات خرید وارد بهای موجودی نمی‌شود و جداگانه به‌عنوان اعتبار مالیاتی ثبت می‌شود.</p>
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => setDraft({ ...draft, items: [...draft.items, { productId: '', title: '', quantity: 1, unitPrice: '', taxRateId: defaultTaxRateId() }] })} className="tap rounded-lg border border-line px-3 text-sm font-bold hover:bg-paper hover:text-ink"><Plus size={17} className="ml-1 inline" />ردیف</button><label className="flex min-h-12 items-center gap-2 text-xs font-bold"><input type="checkbox" checked={draft.issueNow} onChange={(event) => setDraft({ ...draft, issueNow: event.target.checked })} />همین حالا صادر شود</label><button className="tap min-w-[160px] flex-1 rounded-lg bg-accent font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">{draft.issueNow ? 'صدور و ثبت حسابداری' : 'ذخیره پیش‌نویس'}</button></div>
    </form>
    <div><div className="mb-2 flex items-center justify-between"><h2 className="font-extrabold">اسناد</h2><select value={filter} onChange={(event) => setFilter(event.target.value)} className="tap rounded-lg border border-line bg-surface px-3 text-sm"><option value="all">همه</option><option value="sales">فروش</option><option value="purchase">خرید</option></select></div><div className="divide-y divide-line border-y border-line">{result.items.length ? result.items.map((item) => <article key={item.id} className="grid min-h-[88px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3"><ReceiptText className={item.documentType === 'sales' ? 'text-income' : 'text-expense'} /><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-bold">{item.customerName}</p><span className={`rounded border px-2 py-1 text-xs font-bold ${item.displayStatus === 'overdue' ? 'border-expense text-expense' : 'border-line text-muted'}`}>{statusLabels[item.displayStatus]}</span></div><p className="mt-1 text-xs text-muted">{item.number} · {item.documentType === 'purchase' ? 'خرید' : 'فروش'}{item.dueAt ? ` · سررسید ${new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(item.dueAt))}` : ''}</p><div className="mt-2 h-1.5 overflow-hidden rounded bg-line"><div className="h-full bg-accent" style={{ width: `${Math.min(100, Math.round((item.paidAmount / item.total) * 100))}%` }} /></div></div><div className="text-left"><b className="numbers block text-sm">{formatAmount(item.total)}</b>{item.balanceDue > 0 && <span className="numbers mt-1 block text-xs text-muted">مانده {formatAmount(item.balanceDue)}</span>}<div className="mt-2 flex justify-end gap-1"><button onClick={() => print(item.id)} className="tap grid place-items-center text-muted" aria-label="چاپ"><Printer size={18} /></button>{item.status === 'draft' && <button onClick={() => issue(item.id)} className="tap rounded-lg border border-accent px-2 text-xs font-bold text-accent">صدور</button>}{['open', 'partial', 'overdue'].includes(item.displayStatus) && <button onClick={() => openPayment(item)} className="tap rounded-lg border border-income px-2 text-xs font-bold text-income">{item.documentType === 'purchase' ? 'پرداخت' : 'وصول'}</button>}</div></div></article>) : <p className="py-10 text-center text-sm text-muted">هنوز سندی ثبت نشده است.</p>}</div></div>
    {payment && <div className="fixed inset-0 z-[80] grid place-items-center bg-scrim/40 p-4"><form onSubmit={pay} className="w-full max-w-[420px] rounded-2xl bg-paper p-4"><div className="flex items-center justify-between"><div><h2 className="text-lg font-extrabold">{payment.documentType === 'purchase' ? 'ثبت پرداخت' : 'ثبت وصول'}</h2><p className="mt-1 text-xs text-muted">سند {payment.number}</p></div><button type="button" onClick={() => setPayment(null)} className="tap grid place-items-center"><X /></button></div><label className="mt-4 block text-xs text-muted">مبلغ تومان<input autoFocus required inputMode="numeric" value={payment.amount} onChange={(event) => setPayment({ ...payment, amount: event.target.value.replace(/\D/g, '') })} className="tap numbers mt-2 w-full rounded-lg border border-line bg-surface px-3 text-xl font-extrabold" /></label><label className="mt-3 block text-xs text-muted">حساب پول<select value={payment.accountId} onChange={(event) => setPayment({ ...payment, accountId: event.target.value })} className="tap mt-2 w-full rounded-lg border border-line bg-surface px-3 text-ink">{accounts.filter((account) => account.active).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><button className="tap mt-4 w-full rounded-lg bg-accent font-extrabold text-on-fill hover:bg-accent/90 active:bg-accent/80">ثبت قطعی</button></form></div>}
  </section>;
}

function ReconciliationPanel({ accounts = [], categories = [], notify, refresh }) {
  const eligibleAccounts = accounts.filter((account) => account.active && ['cash', 'bank', 'wallet'].includes(account.kind));
  const [imports, setImports] = useState([]);
  const [detail, setDetail] = useState(null);
  const [file, setFile] = useState(null);
  const [accountId, setAccountId] = useState(eligibleAccounts[0]?.id || 'cash');
  const [lineCategories, setLineCategories] = useState({});
  const [rules, setRules] = useState([]);
  const [busy, setBusy] = useState(false);
  const loadImports = useCallback(async () => { const result = await api.reconciliationImports(); setImports(result.items); }, []);
  const loadRules = useCallback(async () => { const result = await api.automationRules('bank_description'); setRules(result.items); }, []);
  useEffect(() => { Promise.all([loadImports(), loadRules()]).catch((error) => notify(error.message)); }, [loadImports, loadRules, notify]);
  const open = async (id) => { setBusy(true); try { setDetail((await api.reconciliationImport(id)).item); } catch (error) { notify(error.message); } finally { setBusy(false); } };
  const upload = async (event) => {
    event.preventDefault();
    if (!file) return notify('فایل CSV را انتخاب کن.');
    setBusy(true);
    try { const result = await api.importBankStatement(file, accountId); setDetail(result.item); setFile(null); await loadImports(); notify(`صورت‌حساب با قالب «${result.item.formatName}» وارد شد.`); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const applyResult = async (promise, message) => {
    setBusy(true);
    try { const result = await promise; setDetail(result.item); await loadImports(); refresh(); notify(message); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const match = (lineId, transactionId) => applyResult(api.matchReconciliationLine(lineId, transactionId), 'ردیف با تراکنش موجود تطبیق شد.');
  const create = (line) => applyResult(api.createFromReconciliationLine(line.id, lineCategories[line.id] || line.ruleSuggestion?.category || (line.direction === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها')), 'تراکنش ساخته و ردیف تطبیق شد.');
  const ignore = (line) => { const reason = window.prompt('چرا این ردیف نباید وارد دفتر شود؟ (حداقل ۵ نویسه)'); if (reason) applyResult(api.ignoreReconciliationLine(line.id, reason), 'ردیف با دلیل ثبت‌شده کنار گذاشته شد.'); };
  const learn = async (line) => {
    const pattern = window.prompt('عبارت ثابت و کوتاه داخل شرح بانک چیست؟', line.description.slice(0, 40));
    if (!pattern?.trim()) return;
    const category = lineCategories[line.id] || line.ruleSuggestion?.category || (line.direction === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها');
    try { await api.saveAutomationRule({ source: 'bank_description', pattern, type: line.direction, category, accountId: detail.accountId }); await loadRules(); setDetail((await api.reconciliationImport(detail.id)).item); notify('قانون با تأیید تو ذخیره شد.'); }
    catch (error) { notify(error.message); }
  };
  const removeRule = async (id) => { try { await api.deleteAutomationRule(id); await loadRules(); notify('قانون بانکی حذف شد.'); } catch (error) { notify(error.message); } };
  const close = () => applyResult(api.closeReconciliation(detail.id), 'تطبیق این دوره بسته شد.');
  const statusLabels = { unmatched: 'نیازمند بررسی', matched: 'تطبیق‌شده', ignored: 'کنارگذاشته‌شده' };
  return <section className="mt-5 space-y-6">
    <BankVoicePanel accounts={accounts} notify={notify} refresh={refresh} />
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start gap-3"><Landmark className="mt-1 shrink-0 text-accent" /><div><h2 className="font-extrabold">ورود صورت‌حساب بانک یا صندوق</h2><p className="mt-1 text-xs leading-6 text-muted">عنوان ستون‌های CSV به‌صورت خودکار نگاشت می‌شود؛ تاریخ شمسی/میلادی و اعداد فارسی پشتیبانی می‌شوند. <a href="/bank-statement-template.csv" download className="font-bold text-accent underline">فایل نمونه</a></p></div></div>
      <form onSubmit={upload} className="mt-4 grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)_150px]"><select value={accountId} onChange={(event) => setAccountId(event.target.value)} className="tap rounded-lg border border-line bg-paper px-3">{eligibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select><label className="flex min-h-12 cursor-pointer items-center rounded-lg border border-dashed border-muted/60 bg-paper px-3 text-sm"><input type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] || null)} className="sr-only" /><span className="truncate">{file?.name || 'انتخاب فایل CSV'}</span></label><button disabled={busy || !eligibleAccounts.length} className="tap rounded-lg bg-accent font-extrabold text-on-fill disabled:opacity-40 hover:bg-accent/90 active:bg-accent/80">ورود و بررسی</button></form>
      <p className="mt-2 text-xs text-muted">فایل بانکی فقط روی سرور حساب‌یار پردازش می‌شود و برای OCR یا هوش مصنوعی ارسال نمی‌شود.</p>
    </div>
    {imports.length > 0 && <div><div className="mb-2 flex items-center justify-between"><h2 className="font-extrabold">دوره‌های واردشده</h2><span className="text-xs text-muted">{toPersianDigits(imports.length)} فایل</span></div><div className="scrollbar-none flex gap-2 overflow-x-auto pb-1">{imports.map((item) => <button key={item.id} onClick={() => open(item.id)} className={`min-w-[220px] rounded-xl border p-3 text-right ${detail?.id === item.id ? 'border-accent bg-warn-bg' : 'border-line bg-surface'} hover:bg-paper hover:text-ink`}><span className="block truncate text-sm font-bold">{item.accountName}</span><span className="mt-1 block truncate text-xs text-muted">{item.fileName} · {item.formatName}</span><span className="numbers mt-2 block text-xs">{toPersianDigits(item.matchedCount + item.ignoredCount)} از {toPersianDigits(item.rowCount)} بررسی‌شده</span></button>)}</div></div>}
    {detail && <div className="space-y-4">
      {detail.importWarnings?.length > 0 && <div className="rounded-lg border border-accent/30 bg-warn-bg px-3 py-2 text-xs leading-6 text-muted"><b className="text-ink">نتیجهٔ تشخیص {detail.formatName}:</b> {detail.importWarnings.join(' ')}</div>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">ردیف‌ها</p><b className="numbers mt-2 block text-lg">{toPersianDigits(detail.rowCount)}</b></div><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">باقی‌مانده</p><b className={`numbers mt-2 block text-lg ${detail.unmatchedCount ? 'text-expense' : 'text-income'}`}>{toPersianDigits(detail.unmatchedCount)}</b></div><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">مانده بانک</p><b className="numbers mt-2 block text-lg">{detail.statementBalance == null ? '—' : formatAmount(detail.statementBalance)}</b></div><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">اختلاف با دفتر</p><b className={`numbers mt-2 block text-lg ${detail.difference === 0 ? 'text-income' : detail.difference == null ? '' : 'text-expense'}`}>{detail.difference == null ? 'نامشخص' : formatAmount(detail.difference)}</b></div></div>
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-extrabold">بررسی ردیف‌های {detail.accountName}</h2><p className="mt-1 text-xs text-muted">{new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(detail.periodStart))} تا {new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(detail.periodEnd))}</p></div>{detail.status === 'open' ? <button disabled={busy || !detail.canClose} onClick={close} className="tap rounded-lg bg-ink px-4 text-sm font-bold text-on-fill disabled:opacity-35 hover:bg-ink/90">بستن تطبیق</button> : <span className="rounded-lg border border-income px-3 py-2 text-xs font-bold text-income"><Check size={16} className="ml-1 inline" />تطبیق بسته شده</span>}</div>
      {detail.status === 'open' && detail.blockingReasons?.length > 0 && <div className="rounded-lg border border-expense/25 bg-expense/5 px-3 py-2 text-xs leading-6 text-expense"><b>بستن دوره ممکن نیست:</b> {detail.blockingReasons.join(' ')}</div>}
      <div className="divide-y divide-line border-y border-line">{detail.lines.map((line) => <article key={line.id} className="py-4"><div className="flex items-start gap-3"><div className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${line.status === 'matched' ? 'bg-income' : line.status === 'ignored' ? 'bg-muted' : 'bg-accent'}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-bold">{line.description || 'بدون شرح بانکی'}</p><p className="mt-1 text-xs text-muted">{new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(line.occurredAt))}{line.reference ? ` · پیگیری ${line.reference}` : ''}</p></div><div className="text-left"><b className={`numbers block ${line.direction === 'income' ? 'text-income' : 'text-expense'}`}>{line.direction === 'income' ? '+' : '−'} {formatAmount(line.amount)}</b><span className="mt-1 block text-xs text-muted">{statusLabels[line.status]}</span></div></div>
        {line.status === 'unmatched' && detail.status === 'open' && <div className="mt-3 rounded-lg bg-paper p-3">
          {line.ruleSuggestion && <p className="mb-2 rounded-md bg-accent/10 px-2 py-1.5 text-xs text-accent">قانون «{line.ruleSuggestion.pattern}» دستهٔ {line.ruleSuggestion.category} را پیشنهاد می‌دهد.</p>}
          {line.candidates.length > 0 && <div><p className="text-xs font-bold text-muted">پیشنهاد تطبیق با دلیل</p><div className="mt-2 grid gap-2">{line.candidates.map((candidate) => <button disabled={busy} key={candidate.id} onClick={() => match(line.id, candidate.id)} className="tap rounded-lg border border-income bg-surface px-3 py-2 text-right text-xs"><b className="text-income">تطبیق {toPersianDigits(candidate.score)}٪</b><span className="mr-2 text-muted">{candidate.category} · {new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(candidate.occurredAt))}</span><span className="mt-1 block text-xs leading-5 text-muted">{candidate.reasons.join(' ')}</span></button>)}</div></div>}
          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_100px_100px]"><select value={lineCategories[line.id] || line.ruleSuggestion?.category || (line.direction === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها')} onChange={(event) => setLineCategories({ ...lineCategories, [line.id]: event.target.value })} className="tap min-w-0 rounded-lg border border-line bg-surface px-3 text-sm">{categories.filter((category) => category.type === line.direction).map((category) => <option key={category.id}>{category.name}</option>)}</select><button disabled={busy} onClick={() => create(line)} className="tap rounded-lg bg-accent px-3 text-xs font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">ثبت در دفتر</button><button disabled={busy || !line.description} onClick={() => learn(line)} className="tap rounded-lg border border-accent px-3 text-xs font-bold text-accent">ساخت قانون</button><button disabled={busy} onClick={() => ignore(line)} className="tap rounded-lg border border-line px-3 text-xs font-bold text-muted hover:bg-paper hover:text-ink">کنارگذاری</button></div>
        </div>}{line.resolutionNote && <p className="mt-2 text-xs text-muted">{line.resolutionNote}</p>}</div></div></article>)}</div>
    </div>}
    {rules.length > 0 && <div className="rounded-xl border border-line bg-surface p-4"><h3 className="font-extrabold">قواعد تأییدشدهٔ بانکی</h3><div className="mt-2 flex flex-wrap gap-2">{rules.map((rule) => <span key={rule.id} className="inline-flex items-center gap-2 rounded-lg border border-line bg-paper px-2 py-1.5 text-xs">{rule.pattern} ← {rule.category}<button onClick={() => removeRule(rule.id)} aria-label={`حذف قانون ${rule.pattern}`} className="text-expense"><X size={14} /></button></span>)}</div></div>}
    {!imports.length && !detail && <p className="py-8 text-center text-sm text-muted">هنوز صورت‌حسابی وارد نشده است.</p>}
  </section>;
}

function RecurringPanel({ categories, notify }) {
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState({ title: '', amount: '', type: 'expense', category: 'اجاره', dayOfMonth: 1 });
  const load = useCallback(() => api.recurring().then((result) => setItems(result.items)), []);
  useEffect(() => { load(); }, [load]);
  const save = async (event) => { event.preventDefault(); await api.saveRecurring(draft); setDraft({ ...draft, title: '', amount: '' }); notify('ثبت دوره‌ای فعال شد.'); load(); };
  const remove = async (id) => { await api.deleteRecurring(id); notify('ثبت دوره‌ای حذف شد.'); load(); };
  return <section className="mt-5 space-y-5"><p className="text-sm leading-7 text-muted">حقوق، اجاره، قسط و درآمدهای ثابت را یک‌بار تعریف کن؛ در سررسید خودکار وارد دفتر می‌شوند.</p><form onSubmit={save} className="grid gap-2 rounded-xl border border-line bg-surface p-3 sm:grid-cols-2"><input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="مثلاً اجاره مغازه" className="tap rounded-lg border border-line px-3" /><input required inputMode="numeric" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/\D/g, '') })} placeholder="مبلغ تومان" className="tap numbers rounded-lg border border-line px-3" /><select value={draft.type} onChange={(event) => { const type = event.target.value; setDraft({ ...draft, type, category: categories.find((item) => item.type === type)?.name || '' }); }} className="tap rounded-lg border border-line px-3"><option value="expense">هزینه</option><option value="income">درآمد</option></select><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="tap rounded-lg border border-line px-3">{categories.filter((item) => item.type === draft.type).map((item) => <option key={item.id}>{item.name}</option>)}</select><label className="flex items-center gap-2 text-xs text-muted">روز ماه<input type="number" min="1" max="31" value={draft.dayOfMonth} onChange={(event) => setDraft({ ...draft, dayOfMonth: event.target.value })} className="tap numbers w-20 rounded-lg border border-line px-2" /></label><button className="tap rounded-lg bg-accent font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">فعال‌سازی</button></form><div className="divide-y divide-line border-y border-line">{items.map((item) => <article key={item.id} className="flex min-h-[72px] items-center gap-3 py-3"><RotateCcw size={19} className="text-muted" /><div className="min-w-0 flex-1"><p className="font-bold">{item.title}</p><p className="mt-1 text-xs text-muted">روز {toPersianDigits(item.dayOfMonth)} هر ماه · {item.category}</p></div><b className={`numbers text-sm ${item.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatAmount(item.amount)}</b><button onClick={() => remove(item.id)} className="tap grid place-items-center text-expense"><Trash2 size={17} /></button></article>)}</div></section>;
}

function InventoryPanel({ notify }) {
  const [data, setData] = useState({ products: [], movements: [], summary: {} });
  const [draft, setDraft] = useState({ name: '', stock: '', unit: 'عدد', lowThreshold: '', buyPrice: '', salePrice: '' });
  const load = useCallback(() => api.inventoryOverview().then(setData), []);
  useEffect(() => { load(); }, [load]);
  const save = async (event) => { event.preventDefault(); try { await api.saveProduct(draft); setDraft({ ...draft, name: '', stock: '', lowThreshold: '', buyPrice: '', salePrice: '' }); notify('کالا و موجودی افتتاحیه ثبت شد.'); load(); } catch (error) { notify(error.message); } };
  const adjust = async (item, sign) => {
    const value = window.prompt(sign > 0 ? `چند ${item.unit} اضافه شد؟` : `چند ${item.unit} کم شد؟`);
    if (!value) return;
    let unitCost = null;
    if (sign > 0) { const cost = window.prompt('بهای هر واحد چند تومان است؟', String(item.averageCost || item.buyPrice || '')); if (cost == null) return; unitCost = Number(cost.replace(/\D/g, '')); }
    try { await api.adjustStock(item.id, sign * Math.abs(Number(value)), sign > 0 ? 'افزایش موجودی با شمارش/رسید دستی' : 'کاهش موجودی با شمارش/مصرف دستی', unitCost); notify('تعداد، ارزش موجودی و سند حسابداری اصلاح شد.'); load(); } catch (error) { notify(error.message); }
  };
  const movementLabels = { opening: 'افتتاحیه', purchase: 'خرید', sale: 'فروش', adjustment: 'اصلاح دستی', reversal: 'برگشت' };
  return <section className="mt-5 space-y-6">
    <div><h2 className="font-extrabold">انبار و بهای تمام‌شده</h2><p className="mt-1 text-sm leading-7 text-muted">ارزش کالا با روش میانگین موزون محاسبه می‌شود؛ خرید میانگین را به‌روز و فروش، هزینه واقعی کالا را ثبت می‌کند.</p></div>
    <div className="grid grid-cols-3 gap-2"><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">ارزش موجودی</p><b className="numbers mt-2 block text-base sm:text-lg">{formatAmount(data.summary.inventoryValue || 0)}</b><span className="text-xs text-muted">تومان</span></div><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">بهای فروش ۳۰ روز</p><b className="numbers mt-2 block text-base text-expense sm:text-lg">{formatAmount(data.summary.cogs30 || 0)}</b><span className="text-xs text-muted">تومان</span></div><div className="rounded-xl border border-line bg-surface p-3"><p className="text-xs text-muted">نیاز به تأمین</p><b className="numbers mt-2 block text-base sm:text-lg">{toPersianDigits(data.summary.lowStockCount || 0)}</b><span className="text-xs text-muted">کالا</span></div></div>
    <form onSubmit={save} className="grid gap-2 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2"><div className="sm:col-span-2"><h3 className="font-extrabold">تعریف کالا</h3><p className="mt-1 text-xs text-muted">برای موجودی اولیه، تعداد و بهای خرید هر واحد را وارد کن.</p></div><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="نام کالا" className="tap rounded-lg border border-line px-3" /><input value={draft.unit} onChange={(event) => setDraft({ ...draft, unit: event.target.value })} placeholder="واحد؛ مثلاً عدد یا کیلو" className="tap rounded-lg border border-line px-3" /><input inputMode="decimal" value={draft.stock} onChange={(event) => setDraft({ ...draft, stock: event.target.value })} placeholder="موجودی اولیه" className="tap numbers rounded-lg border border-line px-3" /><input inputMode="numeric" value={draft.buyPrice} onChange={(event) => setDraft({ ...draft, buyPrice: event.target.value.replace(/\D/g, '') })} placeholder="بهای خرید هر واحد" className="tap numbers rounded-lg border border-line px-3" /><input inputMode="numeric" value={draft.salePrice} onChange={(event) => setDraft({ ...draft, salePrice: event.target.value.replace(/\D/g, '') })} placeholder="قیمت فروش پیشنهادی" className="tap numbers rounded-lg border border-line px-3" /><input inputMode="decimal" value={draft.lowThreshold} onChange={(event) => setDraft({ ...draft, lowThreshold: event.target.value })} placeholder="حد هشدار کمبود" className="tap numbers rounded-lg border border-line px-3" /><button className="tap rounded-lg bg-accent font-bold text-on-fill sm:col-span-2 hover:bg-accent/90 active:bg-accent/80">ثبت کالا و مانده افتتاحیه</button></form>
    <div><div className="mb-2 flex items-center justify-between"><h3 className="font-extrabold">کالاها</h3><span className="text-xs text-muted">{toPersianDigits(data.products.length)} قلم</span></div><div className="divide-y divide-line border-y border-line">{data.products.length ? data.products.map((item) => <article key={item.id} className={`grid min-h-[94px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3 ${item.isLow ? 'bg-warn-bg/60' : ''}`}><PackageSearch className={item.isLow ? 'text-expense' : 'text-muted'} /><div className="min-w-0"><p className="font-bold">{item.name}</p><p className="mt-1 text-xs text-muted">میانگین خرید {formatAmount(item.averageCost || 0)} · ارزش {formatAmount(item.inventoryValue || 0)} تومان</p><p className={`mt-1 text-xs ${item.isLow ? 'font-bold text-expense' : 'text-muted'}`}>{item.isLow ? 'موجودی به حد تأمین رسیده' : `فروش پیشنهادی ${formatAmount(item.salePrice || 0)} تومان`}</p></div><div className="text-left"><b className="numbers block">{toPersianDigits(item.stock)} {item.unit}</b><div className="mt-2 flex gap-1"><button onClick={() => adjust(item, 1)} className="tap grid place-items-center rounded-lg border border-income text-income" aria-label="افزایش موجودی"><Plus size={17} /></button><button onClick={() => adjust(item, -1)} className="tap grid place-items-center rounded-lg border border-expense text-expense" aria-label="کاهش موجودی">−</button></div></div></article>) : <p className="py-10 text-center text-sm text-muted">هنوز کالایی تعریف نشده است.</p>}</div></div>
    {data.movements.length > 0 && <div><h3 className="mb-2 font-extrabold">آخرین گردش‌ها</h3><div className="divide-y divide-line border-y border-line">{data.movements.slice(0, 12).map((movement) => <article key={movement.id} className="flex min-h-[68px] items-center gap-3 py-3"><div className={`h-2.5 w-2.5 rounded-full ${movement.quantity > 0 ? 'bg-income' : 'bg-expense'}`} /><div className="min-w-0 flex-1"><p className="text-sm font-bold">{movement.productName}</p><p className="mt-1 truncate text-xs text-muted">{movementLabels[movement.movementType] || 'گردش'} · {movement.note || new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(movement.occurredAt))}</p></div><div className="text-left"><b className={`numbers block text-sm ${movement.quantity > 0 ? 'text-income' : 'text-expense'}`}>{movement.quantity > 0 ? '+' : '−'}{toPersianDigits(Math.abs(movement.quantity))}</b><span className="numbers mt-1 block text-xs text-muted">{formatAmount(Math.abs(movement.valueDelta))} تومان</span></div></article>)}</div></div>}
  </section>;
}

const RECEIPT_STATUS = {
  failed: ['OCR ناموفق', 'text-expense'], review: ['نیازمند بازبینی', 'text-expense'], ready: ['آمادهٔ تأیید', 'text-accent'],
  linked: ['ثبت و متصل‌شده', 'text-income'], pending: ['در حال بررسی', 'text-muted'], ignored: ['کنارگذاشته‌شده', 'text-muted'],
};

function ReceiptReviewPanel({ detail, candidates, accounts, categories, notify, onChanged, refresh }) {
  const [draft, setDraft] = useState(detail);
  const [busy, setBusy] = useState(false);
  const [learnMerchant, setLearnMerchant] = useState(false);
  useEffect(() => { setDraft(detail); setLearnMerchant(false); }, [detail]);
  const save = async () => {
    setBusy(true);
    try { const result = await api.updateReceipt(detail.id, draft); onChanged(result.item, result.candidates); notify('اصلاحات رسید ذخیره شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const confirm = async (link = {}) => {
    setBusy(true);
    try {
      const result = await api.confirmReceipt(detail.id, { ...draft, ...link });
      if (learnMerchant && draft.merchant?.trim()) await api.saveAutomationRule({ source: 'merchant', pattern: draft.merchant, type: draft.type, category: draft.category, accountId: draft.accountId });
      onChanged(result.item, { transactions: [], statementLines: [] }); refresh();
      notify(link.transactionId ? 'رسید به ثبت موجود متصل شد.' : link.statementLineId ? 'رسید، ردیف بانک و ثبت دفتر به هم متصل شدند.' : 'رسید تأیید و در دفتر ثبت شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const canConfirm = draft.amount && draft.type && draft.category && draft.accountId && detail.status !== 'linked';
  const confidence = Math.round(Number(detail.ocrConfidence || 0) * 100);
  return <div className="rounded-xl border border-accent/35 bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-extrabold">بازبینی رسید</h3><p className="mt-1 text-xs text-muted">پیشنهاد OCR هیچ‌وقت بدون تأیید تو وارد دفتر نمی‌شود.</p></div><a href={api.workspacePath(`/api/receipts/${detail.id}/image`)} target="_blank" rel="noreferrer" className="tap rounded-lg border border-line px-3 text-xs font-bold hover:bg-paper hover:text-ink">دیدن تصویر اصلی</a></div>
    {detail.ocrProvider && <div className="mt-3 flex flex-wrap gap-2 text-xs"><span className="rounded-md bg-paper px-2 py-1">مسیر: {detail.ocrProvider === 'openai' ? 'OCR تصویر' : 'توضیح کاربر'}</span><span className={`rounded-md bg-paper px-2 py-1 ${confidence >= 72 ? 'text-income' : 'text-expense'}`}>اطمینان کلی: {toPersianDigits(confidence)}٪</span>{detail.fieldConfidence?.amount != null && <span className="rounded-md bg-paper px-2 py-1">اطمینان مبلغ: {toPersianDigits(Math.round(detail.fieldConfidence.amount * 100))}٪</span>}</div>}
    {detail.reviewReasons?.length > 0 && <div className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-xs leading-6 text-expense">{detail.reviewReasons.map((reason) => <p key={reason}>• {reason}</p>)}</div>}
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      <label className="text-xs text-muted">مبلغ کل؛ تومان<input inputMode="numeric" value={draft.amount || ''} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/\D/g, '') })} className="tap numbers mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label>
      <label className="text-xs text-muted">فروشنده<input value={draft.merchant || ''} onChange={(event) => setDraft({ ...draft, merchant: event.target.value })} className="tap mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label>
      <label className="text-xs text-muted">نوع<select value={draft.type || 'expense'} onChange={(event) => setDraft({ ...draft, type: event.target.value, category: categories.find((item) => item.type === event.target.value)?.name || '' })} className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-ink"><option value="expense">هزینه</option><option value="income">درآمد</option></select></label>
      <label className="text-xs text-muted">دسته<select value={draft.category || ''} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-ink"><option value="">انتخاب دسته</option>{categories.filter((item) => item.type === (draft.type || 'expense')).map((item) => <option key={item.id}>{item.name}</option>)}</select></label>
      <label className="text-xs text-muted">حساب<select value={draft.accountId || 'cash'} onChange={(event) => setDraft({ ...draft, accountId: event.target.value })} className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-ink">{accounts.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="text-xs text-muted">روش تسویه<input value={draft.paymentMethod || ''} onChange={(event) => setDraft({ ...draft, paymentMethod: event.target.value })} placeholder="کارت، نقد، انتقال…" className="tap mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label>
      <label className="text-xs text-muted">تاریخ رسید<input type="date" value={(draft.occurredAt || '').slice(0, 10)} onChange={(event) => setDraft({ ...draft, occurredAt: event.target.value })} className="tap numbers mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label>
      <label className="text-xs text-muted">شماره پیگیری<input value={draft.reference || ''} onChange={(event) => setDraft({ ...draft, reference: event.target.value })} className="tap numbers mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label>
      <label className="text-xs text-muted sm:col-span-2">توضیح تکمیلی<input value={draft.note || ''} onChange={(event) => setDraft({ ...draft, note: event.target.value })} className="tap mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label>
    </div>
    {detail.status !== 'linked' && <label className="mt-3 flex items-start gap-2 text-xs leading-6 text-muted"><input type="checkbox" checked={learnMerchant} disabled={!draft.merchant} onChange={(event) => setLearnMerchant(event.target.checked)} className="mt-1" />با تأیید من، برای رسیدهای بعدی این فروشنده دسته و حساب فعلی را پیشنهاد بده.</label>}
    {detail.status !== 'linked' && <div className="mt-4 flex flex-wrap gap-2"><button disabled={busy} onClick={save} className="tap rounded-lg border border-line px-4 text-xs font-bold hover:bg-paper hover:text-ink">فقط ذخیره اصلاحات</button><button disabled={busy || !canConfirm} onClick={() => confirm()} className="tap rounded-lg bg-accent px-4 text-xs font-bold text-on-fill disabled:opacity-35 hover:bg-accent/90 active:bg-accent/80">تأیید و ساخت ثبت</button></div>}
    {detail.status !== 'linked' && (candidates.transactions?.length > 0 || candidates.statementLines?.length > 0) && <div className="mt-4 border-t border-line pt-3"><p className="text-xs font-bold">یا اتصال به مورد موجود</p><div className="mt-2 grid gap-2 sm:grid-cols-2">{candidates.transactions?.map((item) => <button key={item.id} disabled={busy} onClick={() => confirm({ transactionId: item.id, accountId: item.accountId })} className="tap rounded-lg border border-income px-3 py-2 text-right text-xs"><b className="text-income">ثبت دفتر · {toPersianDigits(item.score)}٪</b><span className="mt-1 block text-muted">{item.category} · {item.reasons.join(' ')}</span></button>)}{candidates.statementLines?.map((item) => <button key={item.id} disabled={busy} onClick={() => confirm({ statementLineId: item.id, accountId: item.accountId })} className="tap rounded-lg border border-accent px-3 py-2 text-right text-xs"><b className="text-accent">ردیف بانک · {toPersianDigits(item.score)}٪</b><span className="mt-1 block text-muted">{item.accountName} · {item.reasons.join(' ')}</span></button>)}</div></div>}
    {detail.status === 'linked' && <p className="mt-4 rounded-lg bg-income/10 px-3 py-2 text-xs font-bold text-income"><Check size={16} className="ml-1 inline" />این رسید به ثبت دفتر متصل شده است.</p>}
  </div>;
}

function FinancialAnswerCard({ answer }) {
  const [selectedSource, setSelectedSource] = useState(null);
  useEffect(() => setSelectedSource(null), [answer]);
  const kindLabel = { transaction: 'ثبت دفتر', obligation: 'طلب/بدهی', invoice: 'سند', account: 'حساب' };
  const sourceDate = selectedSource?.occurredAt || selectedSource?.dueAt || selectedSource?.createdAt;
  const dateLabel = sourceDate ? new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(sourceDate)) : '';
  const scopeDate = (value) => value ? new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value)) : '';
  const scopeRange = answer.scope ? [scopeDate(answer.scope.from), scopeDate(answer.scope.to)].filter(Boolean).join(' تا ') : '';
  return <div className="mt-3 rounded-xl border border-accent/25 bg-warn-bg p-3">
    <p className="text-sm font-bold leading-7">{toPersianDigits(answer.answer)}</p>
    {answer.scope && <div className="mt-3 flex flex-wrap gap-1.5 text-xs font-bold text-muted"><span className="rounded-full bg-surface px-2 py-1">بازه: {toPersianDigits(answer.scope.label)}</span>{scopeRange && <span className="rounded-full bg-surface px-2 py-1">{toPersianDigits(scopeRange)}</span>}<span className="rounded-full bg-surface px-2 py-1">واحد: {answer.scope.unit}</span><span className="rounded-full bg-surface px-2 py-1">{answer.scope.basisLabel}</span></div>}
    <details className="mt-3 border-t border-accent/15 pt-2"><summary className="cursor-pointer text-xs font-extrabold">عدد از کجا آمده؟</summary><p className="mt-2 text-xs leading-5 text-muted">{answer.provenance?.calculation || 'محاسبه مستقیم از داده‌های دفتر'}</p><p className="mt-1 text-xs text-muted">{toPersianDigits(answer.provenance?.sourceCount || 0)} منبع سازندهٔ پاسخ</p>
      {answer.sources?.length ? <div className="scrollbar-none mt-2 flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">{answer.sources.map((source) => <button type="button" key={`${source.kind}-${source.id}-${source.period || ''}`} onClick={() => setSelectedSource(source)} className={`rounded-md border px-2 py-1 text-xs font-bold ${selectedSource?.id === source.id && selectedSource?.period === source.period ? 'border-accent bg-surface text-accent' : 'border-line bg-surface text-muted'} hover:bg-paper hover:text-ink`}>{kindLabel[source.kind] || 'منبع'} · {source.label}</button>)}</div> : <p className="mt-2 rounded-md bg-surface px-2 py-1.5 text-xs text-muted">هیچ ثبت سازنده‌ای در این محدوده پیدا نشد؛ مقدار صفر از نبودِ ثبت به‌دست آمده است.</p>}
      {selectedSource && <div className="mt-2 rounded-lg border border-line bg-surface p-2 text-xs leading-5"><div className="flex items-center justify-between gap-2"><b>{selectedSource.label}</b><span className="numbers text-muted">{selectedSource.amount != null ? `${formatAmount(selectedSource.amount)} تومان` : ''}</span></div><p className="mt-1 text-muted">{kindLabel[selectedSource.kind] || 'منبع'}{selectedSource.category ? ` · ${selectedSource.category}` : ''}{selectedSource.contactName ? ` · ${selectedSource.contactName}` : ''}{dateLabel ? ` · ${dateLabel}` : ''}{selectedSource.period === 'previous' || selectedSource.period === 'baseline' ? ' · خط مبنا' : ''}</p><p className="mt-1 select-all font-mono text-xs text-muted">شناسه: {selectedSource.id}</p></div>}
    </details>
    <p className="mt-3 border-t border-accent/15 pt-2 text-xs leading-5 text-muted">{answer.disclaimer}</p>
  </div>;
}

function ToolsPanel({ profileType = 'business', accounts = [], categories = [], notify, refresh }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [countedCash, setCountedCash] = useState('');
  const [closing, setClosing] = useState(null);
  const [receiptFile, setReceiptFile] = useState(null);
  const [receiptNote, setReceiptNote] = useState('');
  const [receiptAccountId, setReceiptAccountId] = useState(accounts.find((item) => item.active)?.id || 'cash');
  const [receipts, setReceipts] = useState([]);
  const [ocrConfigured, setOcrConfigured] = useState(true);
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [receiptMatches, setReceiptMatches] = useState({ transactions: [], statementLines: [] });
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [dictating, setDictating] = useState(false);
  const recognizerRef = useRef(null);
  const fileInputRef = useRef(null);
  const loadReceipts = useCallback(async () => { const result = await api.receipts(); setReceipts(result.items); setOcrConfigured(result.ocrConfigured); }, []);
  useEffect(() => { loadReceipts().catch(() => {}); return () => recognizerRef.current?.stop?.(); }, [loadReceipts]);
  const ask = async (event) => { event.preventDefault(); if (!question.trim()) return; try { setAnswer(await api.ask(question)); } catch (error) { notify(error.message); } };
  const close = async (event) => { event.preventDefault(); const result = await api.closeDay({ countedCash }); setClosing(result.item); notify('بستن صندوق ذخیره شد.'); };
  const openReceipt = async (id) => { try { const result = await api.receipt(id); setSelectedReceipt(result.item); setReceiptMatches(result.candidates); } catch (error) { notify(error.message); } };
  const updateSelected = async (item, matches) => { setSelectedReceipt(item); setReceiptMatches(matches); await loadReceipts(); };
  const toggleDictation = () => {
    if (dictating) { recognizerRef.current?.stop(); setDictating(false); return; }
    if (!liveSpeechSupported()) return notify('تایپ زنده فارسی در این مرورگر فعال نیست؛ توضیح را دستی بنویس.');
    const recognizer = createPersianRecognizer({ onUpdate: (snapshot) => setReceiptNote(snapshot.transcript), onEnd: () => setDictating(false), onError: (code) => { setDictating(false); notify(liveSpeechErrorMessage(code)); } });
    recognizerRef.current = recognizer;
    try { recognizer.start(); setDictating(true); } catch { notify('میکروفن توضیح رسید شروع نشد.'); }
  };
  const saveReceiptFile = async (event) => {
    event.preventDefault();
    if (!receiptFile) return notify('اول عکس رسید را انتخاب کن.');
    setReceiptBusy(true);
    try {
      const result = await api.saveReceipt(receiptFile, receiptNote, receiptAccountId);
      setReceiptFile(null); setReceiptNote(''); if (fileInputRef.current) fileInputRef.current.value = '';
      setSelectedReceipt(result.item); setReceiptMatches(result.candidates); await loadReceipts();
      notify(result.warning ? result.warning.message : 'رسید خوانده شد؛ پیشنهادها را قبل از ثبت کنترل کن.');
    } catch (error) { notify(error.message); }
    finally { setReceiptBusy(false); }
  };
  return <section className="mt-5 space-y-6">
    <div className="rounded-xl border border-line bg-surface p-4"><div className="flex items-center gap-2"><Sparkles size={19} className="text-accent" /><h2 className="font-extrabold">از دفترت بپرس</h2></div><p className="mt-2 text-xs leading-6 text-muted">پاسخ فقط از داده‌های ثبت‌شده ساخته می‌شود؛ هیچ عددی حدس زده نمی‌شود. می‌توانی آخرین پرداخت، جمع یک دسته، ماندهٔ یک شخص یا مقایسهٔ دو بازه را بپرسی.</p><form onSubmit={ask} className="mt-3 flex gap-2"><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="مثلاً خوراک این ماه چقدر شد؟" className="tap min-w-0 flex-1 rounded-lg border border-line px-3" /><button className="tap rounded-lg bg-ink px-4 font-bold text-on-fill hover:bg-ink/90">بپرس</button></form>{answer && <FinancialAnswerCard answer={answer} />}</div>
    <form onSubmit={saveReceiptFile} className="rounded-xl border border-line bg-surface p-4"><div className="flex items-center gap-2"><ReceiptText size={20} className="text-accent" /><h2 className="font-extrabold">ورود هوشمند رسید</h2></div><p className="mt-2 text-xs leading-6 text-muted">مبلغ، تاریخ و فروشنده از تصویر پیشنهاد می‌شود. توضیح صوتی برای دسته، حساب و روش تسویه به پیشنهاد اضافه می‌شود.</p>{!ocrConfigured && <p className="mt-2 rounded-lg bg-warn-bg px-3 py-2 text-xs text-expense">OPENAI_API_KEY برای OCR تنظیم نیست؛ عکس از بین نمی‌رود و با توضیح تو وارد صندوق بازبینی می‌شود.</p>}<input ref={fileInputRef} required type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => setReceiptFile(event.target.files?.[0] || null)} className="mt-3 block w-full text-xs" /><div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px]"><div className="flex gap-2"><input value={receiptNote} onChange={(event) => setReceiptNote(event.target.value)} placeholder="مثلاً مواد خریدم، با کارت بانک ملت" className="tap min-w-0 flex-1 rounded-lg border border-line px-3" /><button type="button" onClick={toggleDictation} className={`tap grid place-items-center rounded-lg border px-3 ${dictating ? 'border-expense bg-expense/10 text-expense' : 'border-line text-accent'}`} aria-label={dictating ? 'توقف توضیح صوتی' : 'توضیح صوتی'}><Mic size={19} /></button></div><select value={receiptAccountId} onChange={(event) => setReceiptAccountId(event.target.value)} className="tap rounded-lg border border-line bg-surface px-3 text-sm">{accounts.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><button disabled={receiptBusy} className="tap mt-3 w-full rounded-lg bg-accent font-bold text-on-fill disabled:opacity-40 hover:bg-accent/90 active:bg-accent/80">{receiptBusy ? 'در حال خواندن و تحلیل…' : 'خواندن رسید و افزودن به صندوق'}</button>
      {receipts.length > 0 && <div className="mt-4 border-t border-line pt-3"><div className="flex items-center justify-between"><h3 className="text-sm font-extrabold">صندوق رسیدها</h3><span className="text-xs text-muted">{toPersianDigits(receipts.filter((item) => item.status !== 'linked').length)} مورد باز</span></div><div className="scrollbar-none mt-2 flex gap-2 overflow-x-auto pb-1">{receipts.slice(0, 20).map((item) => { const status = RECEIPT_STATUS[item.status] || RECEIPT_STATUS.review; return <button type="button" key={item.id} onClick={() => openReceipt(item.id)} className={`min-w-[180px] rounded-lg border p-3 text-right ${selectedReceipt?.id === item.id ? 'border-accent bg-warn-bg' : 'border-line bg-paper'} hover:bg-paper hover:text-ink`}><span className="block truncate text-xs font-bold">{item.merchant || item.fileName}</span><span className="numbers mt-1 block text-sm">{item.amount ? `${formatAmount(item.amount)} تومان` : 'مبلغ نامشخص'}</span><span className={`mt-1 block text-xs ${status[1]}`}>{status[0]}</span></button>; })}</div></div>}
    </form>
    {selectedReceipt && <ReceiptReviewPanel detail={selectedReceipt} candidates={receiptMatches} accounts={accounts} categories={categories} notify={notify} onChanged={updateSelected} refresh={refresh} />}
    {profileType === 'business' && <form onSubmit={close} className="rounded-xl border border-line bg-surface p-4"><h2 className="font-extrabold">بستن صندوق امروز</h2><p className="mt-2 text-xs leading-6 text-muted">پول واقعی صندوق را وارد کن تا اختلافش با ثبت‌های امروز مشخص شود.</p><div className="mt-3 flex gap-2"><input required inputMode="numeric" value={countedCash} onChange={(event) => setCountedCash(event.target.value.replace(/\D/g, ''))} placeholder="موجودی شمارش‌شده" className="tap numbers min-w-0 flex-1 rounded-lg border border-line px-3" /><button className="tap rounded-lg bg-accent px-4 font-bold text-on-fill hover:bg-accent/90 active:bg-accent/80">محاسبه</button></div>{closing && <p className={`numbers mt-3 rounded-lg px-3 py-2 text-sm font-bold ${closing.difference === 0 ? 'bg-income/10 text-income' : 'bg-warn-bg text-expense'}`}>اختلاف: {formatAmount(closing.difference)} تومان</p>}</form>}
    <div className="rounded-xl border border-line bg-surface p-4"><p className="text-sm font-bold">محدوده فعلی حساب‌یار</p><p className="mt-2 text-xs leading-6 text-muted">{PRODUCT_POSITIONING.accountingDisclaimer}</p></div>
  </section>;
}
