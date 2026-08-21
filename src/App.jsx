import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3, BookOpenCheck, Check, ChevronLeft, CircleAlert, FileText, Home,
  Menu, Mic, Pencil, Plus, RotateCcw, Settings, Trash2, WifiOff, X,
} from 'lucide-react';
import { api, flushTransactionQueue, queueTransactions } from './lib/api.js';
import { createPersianRecognizer, liveSpeechErrorMessage, liveSpeechSupported } from './lib/liveSpeech.js';
import { pendingAudio, removeOfflineAudio, saveOfflineAudio } from './lib/offlineAudio.js';
import { clock, formatAmount, formatSignedAmount, persianDate, toPersianDigits } from './lib/format.js';
import { createWavRecorder } from './lib/wavRecorder.js';
import { parseFinancialText, parseRecognitionCandidates } from '../shared/parser.js';

const EMPTY_SUMMARY = { income: 0, expense: 0, profit: 0, comparison: null };

function useOnlineStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return online;
}

export default function App() {
  const online = useOnlineStatus();
  const [authenticated, setAuthenticated] = useState(null);
  const [authError, setAuthError] = useState('');
  const [screen, setScreen] = useState('today');
  const [drawer, setDrawer] = useState(false);
  const [data, setData] = useState({ transactions: [], summary: EMPTY_SUMMARY, categories: [], settings: {}, learnings: [], averages: {} });
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [manualText, setManualText] = useState('');
  const [parseResult, setParseResult] = useState(null);
  const [failure, setFailure] = useState(null);
  const [recordState, setRecordState] = useState('idle');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [liveVoiceNote, setLiveVoiceNote] = useState('');
  const [livePreview, setLivePreview] = useState([]);
  const [levels, setLevels] = useState([12, 20, 32, 18, 28, 15, 24]);
  const wavRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const analyserRef = useRef(null);
  const animationRef = useRef(null);
  const audioContextRef = useRef(null);
  const startedAtRef = useRef(0);
  const stoppedAtRef = useRef(0);
  const holdingRef = useRef(false);
  const processingAbortRef = useRef(null);
  const recognitionRef = useRef(null);
  const speechSnapshotRef = useRef({ transcript: '', candidates: [], error: null });
  const maxRecordingTimerRef = useRef(null);
  const finalizeTimerRef = useRef(null);
  const pendingAudioBlobRef = useRef(null);
  const fastFinalizeDoneRef = useRef(false);
  const fastVoiceAvailable = useMemo(() => liveSpeechSupported(), []);

  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3200);
  }, []);

  const load = useCallback(async () => {
    try {
      const bootstrap = await api.bootstrap();
      setData({ ...bootstrap, learnings: bootstrap.learnings || [], averages: bootstrap.averages || {} });
    } catch (error) {
      notify(error.message);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    const requireAuth = () => { localStorage.removeItem('hesab-yar-authenticated'); setAuthenticated(false); };
    window.addEventListener('hesabyar:auth-required', requireAuth);
    if (!navigator.onLine && localStorage.getItem('hesab-yar-authenticated') === '1') setAuthenticated(true);
    else api.authStatus().then((result) => setAuthenticated(result.authenticated)).catch((error) => { setAuthError(error.message); setAuthenticated(false); });
    return () => window.removeEventListener('hesabyar:auth-required', requireAuth);
  }, []);

  useEffect(() => { if (authenticated) load(); }, [authenticated, load]);

  useEffect(() => {
    if (!online || !authenticated) return;
    let active = true;
    (async () => {
      const synced = await flushTransactionQueue();
      const audios = await pendingAudio().catch(() => []);
      for (const item of audios) {
        try {
          const result = await api.parseAudio(item.blob);
          await removeOfflineAudio(item.id);
          if (active && result.transactions?.length) {
            setParseResult(result);
            notify('صدای ذخیره‌شده پردازش شد؛ لطفاً تأییدش کن.');
            break;
          }
        } catch { break; }
      }
      if (active && synced) { notify(`${toPersianDigits(synced)} ثبت آفلاین همگام شد.`); load(); }
    })();
    return () => { active = false; };
  }, [online, authenticated, load, notify]);

  useEffect(() => () => {
    cancelAnimationFrame(animationRef.current);
    window.clearTimeout(maxRecordingTimerRef.current);
    window.clearTimeout(finalizeTimerRef.current);
    processingAbortRef.current?.abort('unmount');
    try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
    wavRecorderRef.current?.dispose();
    audioContextRef.current?.close().catch(() => {});
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const animateWave = () => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const values = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(values);
    const step = Math.max(1, Math.floor(values.length / 7));
    setLevels(Array.from({ length: 7 }, (_, index) => 10 + Math.round((values[index * step] / 255) * 34)));
    animationRef.current = requestAnimationFrame(animateWave);
  };

  const processAudio = async (blob) => {
    if (!online) {
      await saveOfflineAudio(blob);
      setRecordState('idle');
      notify('ضبط ذخیره شد و با وصل‌شدن اینترنت ارسال می‌شود.');
      return;
    }
    setRecordState('processing');
    const controller = new AbortController();
    processingAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort('timeout'), 10_000);
    const requestedAt = Date.now();
    try {
      const result = await api.parseAudio(blob, { signal: controller.signal, hint: speechSnapshotRef.current.transcript });
      if (!result.transactions?.length) setFailure({ transcript: result.transcript || 'متن صدا مشخص نشد.' });
      else setParseResult({ ...result, responseMs: Date.now() - requestedAt });
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason !== 'timeout') notify('پردازش صدا لغو شد.');
      else if (controller.signal.aborted || error.code === 'VOICE_TIMEOUT') setFailure({ transcript: speechSnapshotRef.current.transcript, message: 'بررسی پشتیبان بیش از حد طول کشید. دوباره کوتاه‌تر بگو یا دستی بنویس.' });
      else setFailure({ transcript: '', message: error.code === 'VOICE_UNAVAILABLE' ? 'پردازش صوت هنوز روی سرور فعال نشده است.' : error.message });
    } finally {
      window.clearTimeout(timeout);
      if (processingAbortRef.current === controller) processingAbortRef.current = null;
      setRecordState('idle');
    }
  };

  const cancelProcessing = () => {
    processingAbortRef.current?.abort('user');
    processingAbortRef.current = null;
    setRecordState('idle');
  };

  const cleanupMedia = () => {
    cancelAnimationFrame(animationRef.current);
    analyserRef.current = null;
    wavRecorderRef.current?.dispose();
    wavRecorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
  };

  const tryFinishFastResult = (deadlineReached = false) => {
    if (fastFinalizeDoneRef.current || !pendingAudioBlobRef.current) return false;
    const snapshot = speechSnapshotRef.current;
    const candidates = snapshot.candidates?.length ? snapshot.candidates : [{ transcript: snapshot.transcript, confidence: 0 }];
    const result = parseRecognitionCandidates(candidates, { learnings: data.learnings, averages: data.averages });
    const transcriptIsFinal = Boolean(snapshot.finalTranscript || snapshot.ended || deadlineReached);
    const fastResultIsReliable = transcriptIsFinal && result.transactions?.length
      && (!online || result.transactions.every((item) => item.confidence >= 0.7));
    if (fastResultIsReliable) {
      fastFinalizeDoneRef.current = true;
      pendingAudioBlobRef.current = null;
      window.clearTimeout(finalizeTimerRef.current);
      setParseResult({
        ...result,
        latencyMs: Date.now() - startedAtRef.current,
        responseMs: Date.now() - stoppedAtRef.current,
      });
      setRecordState('idle');
      return true;
    }
    if (deadlineReached) {
      fastFinalizeDoneRef.current = true;
      const blob = pendingAudioBlobRef.current;
      pendingAudioBlobRef.current = null;
      processAudio(blob);
    }
    return false;
  };

  const finishWithFastResult = (blob) => {
    setRecordState('finalizing');
    pendingAudioBlobRef.current = blob;
    fastFinalizeDoneRef.current = false;
    window.clearTimeout(finalizeTimerRef.current);
    if (tryFinishFastResult(false)) return;
    // اگر مرورگر حتی متن ناقص هم ندارد، مسیر WAV تقریباً فوری شروع می‌شود؛ فقط فرصت کوتاهی برای نتیجهٔ نهایی می‌دهیم.
    const hasUsefulLiveSignal = fastVoiceAvailable && speechSnapshotRef.current.transcript && !speechSnapshotRef.current.error;
    finalizeTimerRef.current = window.setTimeout(() => tryFinishFastResult(true), hasUsefulLiveSignal ? 350 : 120);
  };

  const stopRecordingNow = () => {
    window.clearTimeout(maxRecordingTimerRef.current);
    cancelAnimationFrame(animationRef.current);
    if (!stoppedAtRef.current) stoppedAtRef.current = Date.now();
    try { recognitionRef.current?.stop(); } catch { /* recognition may have ended after silence */ }
    const capture = wavRecorderRef.current?.stop();
    wavRecorderRef.current = null;
    if (!capture) return;
    setRecordState('finalizing');
    cleanupMedia();
    if (!capture.durationMs || capture.blob.size <= 44) {
      setRecordState('idle');
      setFailure({ transcript: '', message: 'هیچ صدایی ضبط نشد. دکمه را نگه دار، جمله را بگو و بعد دستت را بردار.' });
      return;
    }
    finishWithFastResult(capture.blob);
  };

  const startRecording = async () => {
    if (recordState !== 'idle') return;
    setRecordState('requesting');
    setLiveTranscript('');
    setLiveVoiceNote('');
    setLivePreview([]);
    pendingAudioBlobRef.current = null;
    fastFinalizeDoneRef.current = false;
    speechSnapshotRef.current = { transcript: '', finalTranscript: '', candidates: [], error: null, ended: false };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      streamRef.current = stream;
      let context;
      try { context = new AudioContext({ latencyHint: 'interactive', sampleRate: 16_000 }); }
      catch { context = new AudioContext(); }
      audioContextRef.current = context;
      await context.resume();
      const wavRecorder = createWavRecorder(context, stream);
      wavRecorderRef.current = wavRecorder;
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      wavRecorder.source.connect(analyser);
      analyserRef.current = analyser;
      startedAtRef.current = Date.now();
      stoppedAtRef.current = 0;
      setRecordState('recording');
      animateWave();
      const recognizer = createPersianRecognizer({
        phrases: [...data.categories.map((item) => item.name), ...data.learnings.map((item) => item.keyword)],
        onUpdate: (snapshot) => {
          speechSnapshotRef.current = { ...snapshot, error: null, ended: false };
          setLiveTranscript(snapshot.transcript);
          setLivePreview(parseFinancialText(snapshot.transcript, { learnings: data.learnings, averages: data.averages, source: 'voice' }).transactions);
          tryFinishFastResult(false);
        },
        onError: (error) => {
          speechSnapshotRef.current = { ...speechSnapshotRef.current, error };
          setLiveVoiceNote(liveSpeechErrorMessage(error));
        },
        onEnd: () => {
          speechSnapshotRef.current = { ...speechSnapshotRef.current, ended: true };
          tryFinishFastResult(false);
        },
      });
      recognitionRef.current = recognizer;
      try { recognizer?.start(); } catch {
        speechSnapshotRef.current.error = 'start-failed';
        setLiveVoiceNote(liveSpeechErrorMessage('start-failed'));
      }
      maxRecordingTimerRef.current = window.setTimeout(() => {
        holdingRef.current = false;
        stopRecordingNow();
        notify('برای سرعت و دقت، ضبط بعد از ۱۲ ثانیه متوقف شد.');
      }, 12_000);
      // اگر کاربر هنگام نمایش پنجرهٔ مجوز دستش را برداشته باشد، ضبط بلافاصله بسته می‌شود.
      if (!holdingRef.current) stopRecordingNow();
    } catch (error) {
      cleanupMedia();
      setRecordState('idle');
      setFailure({ permission: true, message: error.name === 'NotAllowedError' ? 'اجازهٔ میکروفن خاموش است.' : 'میکروفن در دسترس نیست.' });
    }
  };

  const stopRecording = () => {
    holdingRef.current = false;
    if (recordState !== 'recording' || !wavRecorderRef.current) return;
    stopRecordingNow();
  };

  const parseManual = (event) => {
    event?.preventDefault();
    const text = manualText.trim();
    if (!text) return;
    const result = parseFinancialText(text, { learnings: data.learnings, averages: data.averages, source: 'text' });
    if (!result.transactions?.length) setFailure({ transcript: text });
    else { setParseResult({ ...result, engine: 'local-text', latencyMs: 0 }); setManualText(''); }
  };

  const saveConfirmed = async (transactions) => {
    const payload = { transcript: parseResult.transcript, transactions };
    try {
      if (!online) { queueTransactions(payload); notify('ثبت شد؛ بعد از اتصال همگام می‌شود.'); }
      else { await api.saveTransactions(payload); notify(transactions.length > 1 ? `${toPersianDigits(transactions.length)} تراکنش ثبت شد.` : 'تراکنش ثبت شد.'); }
      setParseResult(null);
      await load();
    } catch (error) { notify(error.message); }
  };

  const navigate = (target) => { setScreen(target); setDrawer(false); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  const login = async (username, password) => {
    setAuthError('');
    try {
      await api.login(username, password);
      localStorage.setItem('hesab-yar-authenticated', '1');
      setAuthenticated(true);
    } catch (error) { setAuthError(error.message); }
  };

  const logout = async () => {
    try { await api.logout(); } catch { /* پاک‌کردن نشست محلی حتی اگر شبکه قطع باشد */ }
    localStorage.removeItem('hesab-yar-authenticated');
    setData({ transactions: [], summary: EMPTY_SUMMARY, categories: [], settings: {}, learnings: [], averages: {} });
    setAuthenticated(false);
  };

  if (authenticated === null) return <div dir="rtl" className="grid min-h-screen place-items-center bg-paper text-ink"><span className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" aria-label="در حال بارگذاری" /></div>;
  if (!authenticated) return <LoginPage onLogin={login} error={authError} />;

  return (
    <div dir="rtl" className="min-h-screen bg-paper text-ink">
      {!online && <div className="sticky top-0 z-50 flex h-9 items-center justify-center gap-2 bg-ink px-4 text-[13px] text-white"><WifiOff size={15} /> آفلاین — ضبط ذخیره می‌شود و بعداً ارسال</div>}
      <div className="mx-auto min-h-screen w-full max-w-[640px] bg-paper safe-bottom">
        {screen === 'today' && (
          <TodayPage
            data={data} loading={loading} manualText={manualText} setManualText={setManualText}
            parseManual={parseManual} recordState={recordState}
            stopRecording={stopRecording} cancelProcessing={cancelProcessing} beginRecording={() => { holdingRef.current = true; startRecording(); }}
            levels={levels} liveTranscript={liveTranscript} liveVoiceNote={liveVoiceNote} livePreview={livePreview} fastVoiceAvailable={fastVoiceAvailable} openDrawer={() => setDrawer(true)}
          />
        )}
        {screen === 'report' && <ReportPage />}
        {screen === 'learning' && <LearningPage categories={data.categories} notify={notify} />}
        {screen === 'settings' && <SettingsPage initial={data.settings} notify={notify} onLogout={logout} />}
      </div>

      <BottomNav screen={screen} navigate={navigate} />
      {drawer && <Drawer close={() => setDrawer(false)} navigate={navigate} />}
      {parseResult && (
        <ConfirmationSheet
          result={parseResult} categories={data.categories} onCancel={() => setParseResult(null)} onConfirm={saveConfirmed}
        />
      )}
      {failure && <FailureSheet failure={failure} close={() => setFailure(null)} retry={() => { setFailure(null); holdingRef.current = true; startRecording(); }} manual={() => { setFailure(null); document.getElementById('manual-entry')?.focus(); }} />}
      {toast && <div role="status" className="fixed bottom-28 left-1/2 z-[80] w-[calc(100%-32px)] max-w-[430px] -translate-x-1/2 rounded-lg bg-ink px-4 py-3 text-center text-sm text-white shadow-paper">{toast}</div>}
    </div>
  );
}

function TodayPage({ data, loading, manualText, setManualText, parseManual, recordState, beginRecording, stopRecording, cancelProcessing, levels, liveTranscript, liveVoiceNote, livePreview, fastVoiceAvailable, openDrawer }) {
  return (
    <main>
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line/80 bg-paper/95 px-4 py-3 backdrop-blur-sm">
        <div><h1 className="text-xl font-extrabold">امروز</h1><p className="mt-0.5 text-[13px] text-muted">{persianDate()}</p></div>
        <button className="tap grid place-items-center rounded-lg border border-line bg-surface" onClick={openDrawer} aria-label="بازکردن منو"><Menu size={23} /></button>
      </header>

      <div className="space-y-6 px-4 py-5">
        <SummaryCard summary={data.summary} loading={loading} />
        <section>
          <div className="mb-2 flex items-center justify-between"><h2 className="text-[17px] font-extrabold">ثبت‌های امروز</h2><span className="text-[13px] text-muted">{toPersianDigits(data.transactions.length)} مورد</span></div>
          <TransactionList items={data.transactions} loading={loading} />
        </section>

        <form onSubmit={parseManual} className="rounded-[10px] border border-line bg-surface p-2 shadow-paper">
          <label htmlFor="manual-entry" className="sr-only">ورود دستی</label>
          <div className="flex gap-2">
            <input id="manual-entry" value={manualText} onChange={(event) => setManualText(event.target.value)} placeholder="یا بنویس… مثلاً ۵۰۰ هزار تومان خرید کردم" className="tap min-w-0 flex-1 rounded-lg border-0 bg-transparent px-3 text-[15px] outline-none placeholder:text-muted/80" />
            <button disabled={!manualText.trim() || recordState === 'processing'} className="tap rounded-lg bg-ink px-4 text-sm font-bold text-white disabled:opacity-35">بررسی</button>
          </div>
        </form>

        <Recorder state={recordState} start={beginRecording} stop={stopRecording} cancel={cancelProcessing} levels={levels} liveTranscript={liveTranscript} liveVoiceNote={liveVoiceNote} livePreview={livePreview} fastVoiceAvailable={fastVoiceAvailable} />
      </div>
    </main>
  );
}

function SummaryCard({ summary, loading }) {
  const values = [
    { label: 'فروش امروز', value: summary.income, color: 'text-income' },
    { label: 'هزینه امروز', value: summary.expense, color: 'text-expense' },
    { label: 'سود تقریبی', value: summary.profit, color: 'text-ink' },
  ];
  return (
    <section className="rounded-[10px] border border-line bg-surface p-4 shadow-paper">
      <div className="grid grid-cols-3 divide-x-reverse divide-x divide-line">
        {values.map((item) => <div key={item.label} className="min-w-0 px-2 first:pr-0 last:pl-0"><p className="whitespace-nowrap text-[12px] text-muted">{item.label}</p><p className={`numbers mt-2 truncate text-[16px] font-extrabold sm:text-[19px] ${item.color}`}>{loading ? '—' : formatAmount(item.value)}</p><p className="mt-0.5 text-[11px] text-muted">تومان</p></div>)}
      </div>
      <div className="mt-4 border-t border-line pt-3 text-[13px] text-muted">
        {summary.comparison == null ? 'برای مقایسه با دیروز هنوز داده کافی نیست.' : <span><b className={summary.comparison >= 0 ? 'text-income' : 'text-expense'}>{summary.comparison >= 0 ? '↑' : '↓'} {formatAmount(Math.abs(summary.comparison))}٪</b> {summary.comparison >= 0 ? 'بیشتر' : 'کمتر'} از دیروز</span>}
      </div>
    </section>
  );
}

function TransactionList({ items, loading }) {
  if (loading) return <div className="space-y-2">{[1, 2, 3].map((x) => <div key={x} className="h-16 animate-pulse rounded-lg bg-line/45" />)}</div>;
  if (!items.length) return <div className="grid min-h-40 place-items-center border-y border-line px-8 text-center text-[15px] leading-7 text-muted">هنوز چیزی ثبت نشده. دکمهٔ پایین را نگه دار و بگو.</div>;
  return <div className="border-y border-line bg-surface/50">{items.map((item) => (
    <article key={item.id} className="flex min-h-[76px] items-center justify-between gap-4 border-b border-line px-1 py-3 last:border-b-0">
      <div className="min-w-0"><p className={`numbers text-lg font-bold ${item.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatSignedAmount(item)}</p><p className="mt-1 truncate text-[13px] text-muted">{item.rawText}</p></div>
      <div className="shrink-0 text-left"><span className="inline-block rounded-md border border-line bg-surface px-2 py-1 text-[12px]">{item.category}</span><p className="mt-1 text-[12px] text-muted">{clock(item.occurredAt)}</p></div>
    </article>
  ))}</div>;
}

function Recorder({ state, start, stop, cancel, levels, liveTranscript, liveVoiceNote, livePreview, fastVoiceAvailable }) {
  const recording = state === 'recording';
  const processing = state === 'processing';
  const requesting = state === 'requesting';
  const finalizing = state === 'finalizing';
  const press = (event) => {
    if (processing || finalizing || requesting) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    start();
  };
  const release = (event) => {
    event?.preventDefault?.();
    if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    stop();
  };
  const keyDown = (event) => {
    if (![' ', 'Enter'].includes(event.key) || event.repeat || processing || finalizing || requesting) return;
    event.preventDefault();
    start();
  };
  const keyUp = (event) => {
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    stop();
  };
  return (
    <section className="flex flex-col items-center py-2">
      {(recording || finalizing) && liveTranscript && <div aria-live="polite" className="mb-3 w-full rounded-[10px] border border-line bg-surface px-3 py-3 text-right"><p className="truncate text-sm text-muted">شنیدم: «{liveTranscript}»</p>{livePreview.length > 0 && <p className="numbers mt-2 text-lg font-extrabold text-ink">{livePreview.map((item) => formatAmount(item.amount)).join(' + ')} <span className="font-normal text-[12px] text-muted">تومان</span></p>}</div>}
      {(recording || finalizing) && liveVoiceNote && !liveTranscript && <p role="status" className="mb-3 rounded-lg bg-warn-bg px-3 py-2 text-center text-[13px] leading-6 text-expense">{liveVoiceNote}</p>}
      <p className="mb-3 text-center text-[13px] text-muted">{recording ? (fastVoiceAvailable ? 'در حال ضبط زنده — دستت را برداری تمام می‌شود' : 'در حال ضبط — دستت را برداری تمام می‌شود') : processing ? 'صدای ضبط‌شده در حال تبدیل به متن است…' : finalizing ? 'در حال نهایی‌کردن عدد…' : requesting ? 'دکمه را نگه دار؛ میکروفن در حال فعال‌شدن است…' : 'دکمه را نگه دار و بگو؛ برای پایان دستت را بردار'}</p>
      <button
        type="button" aria-pressed={recording} aria-label={processing ? 'لغو پردازش' : recording ? 'در حال ضبط؛ برای پایان دستت را بردار' : 'برای ضبط نگه دار'} disabled={finalizing}
        onClick={processing ? cancel : undefined}
        onPointerDown={press} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={stop}
        onKeyDown={keyDown} onKeyUp={keyUp} onBlur={stop}
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

function ConfirmationSheet({ result, categories, onCancel, onConfirm }) {
  const [items, setItems] = useState(() => result.transactions.map((item) => ({ ...item, originalCategory: item.category })));
  const [index, setIndex] = useState(0);
  const [editAmount, setEditAmount] = useState(false);
  const item = items[index];
  const allowedCategories = categories.filter((category) => category.type === item.type);
  const patch = (changes) => setItems((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...changes } : entry));
  const finish = () => index < items.length - 1 ? setIndex(index + 1) : onConfirm(items);
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-ink/35 px-0 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section role="dialog" aria-modal="true" aria-label="تأیید تراکنش" className="sheet-in max-h-[94vh] w-full max-w-[640px] overflow-y-auto rounded-t-2xl bg-paper px-4 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-3 shadow-2xl">
        <div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" />
        {items.length > 1 && <div className="mb-3 flex items-center justify-between text-[13px] text-muted"><span>تراکنش {toPersianDigits(index + 1)} از {toPersianDigits(items.length)}</span><div className="flex gap-1">{items.map((_, dot) => <span key={dot} className={`h-1.5 w-6 rounded-full ${dot === index ? 'bg-accent' : 'bg-line'}`} />)}</div></div>}
        <blockquote className="rounded-lg border border-line bg-surface/65 px-3 py-3 text-[14px] leading-7 text-muted">«{result.transcript}»</blockquote>
        {Number.isFinite(result.responseMs) && <p className="mt-2 text-center text-[12px] font-medium text-income">{result.engine === 'browser-live' ? 'تشخیص زنده' : 'تشخیص از صدای اصلی'}؛ نتیجه در {toPersianDigits((Math.max(1, result.responseMs) / 1000).toFixed(1))} ثانیه آماده شد</p>}

        <button onClick={() => setEditAmount(true)} className="my-4 w-full rounded-[10px] border border-transparent py-3 text-center hover:border-line">
          {editAmount ? (
            <input autoFocus inputMode="numeric" value={item.amount} onChange={(event) => patch({ amount: Number(event.target.value.replace(/\D/g, '')) })} onBlur={() => setEditAmount(false)} onKeyDown={(event) => { if (event.key === 'Enter') setEditAmount(false); }} className="numbers mx-auto block w-full bg-transparent text-center text-4xl font-extrabold tracking-[-.02em] outline-none" />
          ) : <div className="flex items-center justify-center gap-2"><span className="numbers text-4xl font-extrabold tracking-[-.02em]">{formatAmount(item.amount)}</span><Pencil size={16} className="text-muted" /></div>}
          <span className="mt-1 block text-[13px] text-muted">تومان</span>
        </button>

        <div className="space-y-2">
          <div className="flex min-h-14 items-center gap-3 border-t border-line py-2"><span className="w-12 text-[13px] text-muted">نوع</span><div className="grid flex-1 grid-cols-2 gap-2"><button onClick={() => patch({ type: 'income', category: categories.find((x) => x.type === 'income')?.name || 'فروش' })} className={`tap rounded-lg border text-sm font-bold ${item.type === 'income' ? 'border-income bg-income text-white' : 'border-line bg-surface'}`}>درآمد</button><button onClick={() => patch({ type: 'expense', category: categories.find((x) => x.type === 'expense')?.name || 'سایر هزینه‌ها' })} className={`tap rounded-lg border text-sm font-bold ${item.type === 'expense' ? 'border-expense bg-expense text-white' : 'border-line bg-surface'}`}>هزینه</button></div></div>
          <label className="flex min-h-14 items-center gap-3 border-y border-line py-2"><span className="w-12 text-[13px] text-muted">دسته</span><select value={item.category} onChange={(event) => patch({ category: event.target.value })} className="tap flex-1 appearance-none rounded-lg border border-line bg-surface px-3 text-[15px] font-bold outline-none">{allowedCategories.map((category) => <option key={category.id}>{category.name}</option>)}</select><Pencil size={16} className="text-muted" /></label>
        </div>

        {item.warning && <div className="mt-4 flex gap-3 rounded-lg border-r-4 border-accent bg-warn-bg px-3 py-3 text-[14px] leading-6"><CircleAlert className="mt-0.5 shrink-0 text-accent" size={20} /><span>{item.warning}</span></div>}
        {!!item.alternatives?.length && <div className="mt-4"><p className="mb-2 text-[13px] text-muted">شاید منظورت این بود:</p><div className="flex flex-wrap gap-2">{item.alternatives.map((amount) => <button key={amount} onClick={() => patch({ amount })} className="tap numbers rounded-lg border border-line bg-surface px-4 font-bold">{formatAmount(amount)}</button>)}</div></div>}

        <div className="mt-5 grid grid-cols-[minmax(0,7fr)_minmax(90px,3fr)] gap-2">
          <button onClick={finish} className="tap flex items-center justify-center gap-2 rounded-lg bg-accent px-4 font-extrabold text-white"><Check size={19} />{index < items.length - 1 ? 'بعدی' : 'ثبت شد'}</button>
          <button onClick={onCancel} className="tap rounded-lg border border-line bg-surface font-bold">لغو</button>
        </div>
      </section>
    </div>
  );
}

function FailureSheet({ failure, close, retry, manual }) {
  return <div className="fixed inset-0 z-[70] flex items-end justify-center bg-ink/35 backdrop-blur-[2px]"><section role="dialog" className="sheet-in w-full max-w-[640px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)]"><div className="mx-auto mb-5 h-1 w-11 rounded-full bg-line" />{failure.transcript && <blockquote className="mb-4 rounded-lg border border-line bg-surface px-3 py-3 text-sm text-muted">«{failure.transcript}»</blockquote>}<CircleAlert className="mb-3 text-accent" size={27} /><h2 className="text-xl font-extrabold">{failure.permission ? 'اجازهٔ میکروفن فعال نیست' : 'مبلغی پیدا نکردم'}</h2><p className="mt-2 text-[15px] leading-7 text-muted">{failure.message || 'جمله را دوباره بگو یا مبلغ را دستی بنویس. هیچ تراکنشی بدون تأیید تو ثبت نمی‌شود.'}</p>{failure.permission && <ol className="mt-3 list-decimal space-y-1 pr-5 text-sm leading-7"><li>روی علامت قفل کنار آدرس سایت بزن.</li><li>دسترسی «میکروفن» را روی مجاز بگذار.</li><li>صفحه را دوباره باز کن.</li></ol>}<div className="mt-5 grid grid-cols-2 gap-2"><button onClick={retry} className="tap flex items-center justify-center gap-2 rounded-lg bg-accent font-bold text-white"><RotateCcw size={18} />دوباره بگو</button><button onClick={manual} className="tap rounded-lg border border-line bg-surface font-bold">دستی بنویس</button></div><button onClick={close} className="tap mt-2 w-full text-sm text-muted">بستن</button></section></div>;
}

function ReportPage() {
  const [range, setRange] = useState('month');
  const [report, setReport] = useState({ summary: EMPTY_SUMMARY, points: [], categories: [], insight: '' });
  const [loading, setLoading] = useState(true);
  useEffect(() => { setLoading(true); api.report(range).then(setReport).finally(() => setLoading(false)); }, [range]);
  const maximum = Math.max(1, ...report.points.flatMap((point) => [point.income, point.expense]));
  return <main className="px-4 py-5"><h1 className="text-xl font-extrabold">گزارش</h1><div className="mt-4 grid grid-cols-3 rounded-lg border border-line bg-surface p-1">{[['week', 'این هفته'], ['month', 'این ماه'], ['quarter', 'سه ماه']].map(([value, label]) => <button key={value} onClick={() => setRange(value)} className={`tap rounded-md text-sm font-bold ${range === value ? 'bg-ink text-white' : 'text-muted'}`}>{label}</button>)}</div><div className="mt-5"><SummaryCard summary={report.summary} loading={loading} /></div>
    {report.insight && <div className="mt-4 rounded-lg border-r-4 border-accent bg-warn-bg px-3 py-3 text-sm leading-7">{report.insight}</div>}
    <section className="mt-7"><h2 className="text-[17px] font-extrabold">روند درآمد و هزینه</h2><div className="mt-3 flex h-56 items-end gap-3 border-b border-line bg-surface px-3 pt-5">{report.points.length ? report.points.map((point) => <div key={point.label} className="flex h-full min-w-0 flex-1 flex-col justify-end"><div className="flex flex-1 items-end justify-center gap-1"><span title={`درآمد ${formatAmount(point.income)}`} className="w-3 max-w-[16px] bg-income" style={{ height: `${Math.max(2, point.income / maximum * 100)}%` }} /><span title={`هزینه ${formatAmount(point.expense)}`} className="w-3 max-w-[16px] bg-expense" style={{ height: `${Math.max(2, point.expense / maximum * 100)}%` }} /></div><span className="mt-2 truncate text-center text-[11px] text-muted">{point.label}</span></div>) : <p className="m-auto text-sm text-muted">داده‌ای برای این بازه نیست.</p>}</div><div className="mt-2 flex gap-4 text-xs text-muted"><span><i className="ml-1 inline-block h-2 w-2 bg-income" />درآمد</span><span><i className="ml-1 inline-block h-2 w-2 bg-expense" />هزینه</span></div></section>
    <section className="mt-7"><h2 className="text-[17px] font-extrabold">تفکیک دسته‌ها</h2><div className="mt-2 divide-y divide-line border-y border-line">{report.categories.map((item) => <div key={`${item.type}-${item.name}`} className="py-3"><div className="flex justify-between gap-3"><span className="text-sm font-bold">{item.name}</span><span className={`numbers text-sm font-bold ${item.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatAmount(item.amount)} تومان</span></div><div className="mt-2 h-1.5 overflow-hidden bg-line/60"><div className={item.type === 'income' ? 'h-full bg-income' : 'h-full bg-expense'} style={{ width: `${item.share}%` }} /></div></div>)}</div></section>
  </main>;
}

function LearningPage({ categories, notify }) {
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState({ keyword: '', category: 'خوراک' });
  const load = () => api.learnings().then((result) => setItems(result.items));
  useEffect(load, []);
  const save = async () => { if (!draft.keyword.trim()) return; await api.saveLearning(draft); setDraft({ ...draft, keyword: '' }); notify('یادگیری تازه ذخیره شد.'); load(); };
  const update = async (item, category) => { await api.updateLearning(item.id, { keyword: item.keyword, category }); load(); };
  const remove = async (id) => { await api.deleteLearning(id); notify('این یادگیری حذف شد.'); load(); };
  return <main className="px-4 py-5"><h1 className="text-xl font-extrabold">آنچه یاد گرفته‌ام</h1><p className="mt-2 text-sm leading-7 text-muted">هر بار دسته‌ای را اصلاح می‌کنی، اینجا یاد می‌گیرم. می‌توانی نگاشت‌ها را هم خودت اضافه یا پاک کنی.</p><div className="mt-5 flex gap-2 rounded-[10px] border border-line bg-surface p-2"><input value={draft.keyword} onChange={(event) => setDraft({ ...draft, keyword: event.target.value })} placeholder="مثلاً اسنپ‌فود" className="tap min-w-0 flex-1 px-2 outline-none" /><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="tap max-w-32 rounded-lg border border-line px-2">{categories.map((category) => <option key={category.id}>{category.name}</option>)}</select><button onClick={save} className="tap grid place-items-center rounded-lg bg-accent text-white" aria-label="افزودن"><Plus size={21} /></button></div><div className="mt-5 divide-y divide-line border-y border-line">{items.length ? items.map((item) => <div key={item.id} className="flex min-h-[64px] items-center gap-2"><span className="min-w-0 flex-1 truncate font-bold">{item.keyword}</span><ChevronLeft size={17} className="text-muted" /><select value={item.category} onChange={(event) => update(item, event.target.value)} className="tap max-w-36 bg-transparent text-sm text-muted outline-none">{categories.map((category) => <option key={category.id}>{category.name}</option>)}</select><button onClick={() => remove(item.id)} className="tap grid place-items-center text-expense" aria-label={`حذف ${item.keyword}`}><Trash2 size={18} /></button></div>) : <p className="py-10 text-center text-sm text-muted">هنوز چیزی از اصلاح‌ها یاد نگرفته‌ام.</p>}</div></main>;
}

function SettingsPage({ initial, notify, onLogout }) {
  const [settings, setSettings] = useState({ businessName: '', ...initial });
  useEffect(() => setSettings({ businessName: '', ...initial }), [initial]);
  const save = async () => { const result = await api.settings(settings); setSettings(result.settings); notify('تنظیمات ذخیره شد.'); };
  return <main className="px-4 py-5"><h1 className="text-xl font-extrabold">تنظیمات</h1><section className="mt-5 rounded-[10px] border border-line bg-surface p-4"><label className="text-[13px] text-muted">نام کسب‌وکار<input value={settings.businessName || ''} onChange={(event) => setSettings({ ...settings, businessName: event.target.value })} placeholder="مثلاً آرایشگاه آبان" className="tap mt-2 w-full rounded-lg border border-line px-3 text-[15px] text-ink outline-none focus:border-accent" /></label><button onClick={save} className="tap mt-4 w-full rounded-lg bg-accent font-bold text-white">ذخیره تنظیمات</button></section><section className="mt-5 border-y border-line py-4"><h2 className="font-extrabold">میکروفن و حریم خصوصی</h2><p className="mt-2 text-sm leading-7 text-muted">در حالت عادی، متن زنده در مرورگر به مبلغ تبدیل می‌شود و فایل صدا به سرور حساب‌یار ارسال نمی‌شود. فقط اگر تشخیص زنده نتیجه ندهد، صدای کوتاه برای بررسی پشتیبان فرستاده می‌شود. کلید سرویس هوش مصنوعی هرگز داخل مرورگر قرار نمی‌گیرد.</p></section><button onClick={onLogout} className="tap mt-6 w-full rounded-lg border border-expense/40 bg-surface font-bold text-expense">خروج از حساب</button></main>;
}

function LoginPage({ onLogin, error }) {
  const [username, setUsername] = useState('owner');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event) => { event.preventDefault(); setSubmitting(true); await onLogin(username, password); setSubmitting(false); };
  return <main dir="rtl" className="grid min-h-screen place-items-center bg-paper px-4 text-ink"><section className="w-full max-w-[390px]"><div className="mb-8"><div className="mb-4 grid h-14 w-14 place-items-center rounded-[10px] border border-line bg-surface shadow-paper"><FileText className="text-accent" size={27} /></div><h1 className="text-2xl font-extrabold">ورود به حساب‌یار</h1><p className="mt-2 text-sm leading-7 text-muted">اطلاعات مالی خصوصی است؛ برای ادامه رمز مالک را وارد کن.</p></div><form onSubmit={submit} className="rounded-[10px] border border-line bg-surface p-4 shadow-paper"><label className="block text-[13px] text-muted">نام کاربری<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} className="tap mt-2 w-full rounded-lg border border-line px-3 text-ink outline-none focus:border-accent" /></label><label className="mt-4 block text-[13px] text-muted">رمز عبور<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="tap mt-2 w-full rounded-lg border border-line px-3 text-ink outline-none focus:border-accent" /></label>{error && <p role="alert" className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-sm leading-6 text-expense">{error}</p>}<button disabled={submitting || !username || password.length < 1} className="tap mt-5 w-full rounded-lg bg-accent font-extrabold text-white disabled:opacity-50">{submitting ? 'در حال بررسی…' : 'ورود امن'}</button></form></section></main>;
}

function BottomNav({ screen, navigate }) {
  const items = [{ id: 'today', label: 'امروز', icon: Home }, { id: 'report', label: 'گزارش', icon: BarChart3 }, { id: 'settings', label: 'تنظیمات', icon: Settings }];
  return <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto flex h-[76px] max-w-[640px] items-start justify-around border-t border-line bg-surface px-3 pb-[env(safe-area-inset-bottom)] pt-2">{items.map((item) => { const Icon = item.icon; const active = screen === item.id || (item.id === 'settings' && screen === 'learning'); return <button key={item.id} onClick={() => navigate(item.id)} className={`tap flex min-w-20 flex-col items-center justify-center gap-1 rounded-lg text-[12px] font-bold ${active ? 'text-accent' : 'text-muted'}`}><Icon size={21} strokeWidth={active ? 2.6 : 2} />{item.label}</button>; })}</nav>;
}

function Drawer({ close, navigate }) {
  return <div className="fixed inset-0 z-[60] bg-ink/35" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><aside className="sheet-in h-full w-[82%] max-w-[330px] bg-paper px-4 py-5 shadow-2xl"><div className="flex items-center justify-between"><div><p className="text-xl font-extrabold">حساب‌یار</p><p className="text-xs text-muted">دفتر مالی سادهٔ تو</p></div><button onClick={close} className="tap grid place-items-center" aria-label="بستن"><X /></button></div><div className="mt-8 space-y-2"><DrawerItem icon={Home} label="امروز" onClick={() => navigate('today')} /><DrawerItem icon={BarChart3} label="گزارش" onClick={() => navigate('report')} /><DrawerItem icon={BookOpenCheck} label="آنچه یاد گرفته‌ام" onClick={() => navigate('learning')} /><DrawerItem icon={Settings} label="تنظیمات" onClick={() => navigate('settings')} /></div><div className="absolute bottom-6 right-4 left-4 border-t border-line pt-4 text-xs leading-6 text-muted">نسخهٔ اولیهٔ حساب‌یار<br />همهٔ مبالغ پیش از ثبت نیاز به تأیید دارند.</div></aside></div>;
}

function DrawerItem({ icon: Icon, label, onClick }) { return <button onClick={onClick} className="tap flex w-full items-center gap-3 rounded-lg px-3 text-right font-bold hover:bg-surface"><Icon size={20} className="text-muted" />{label}</button>; }
