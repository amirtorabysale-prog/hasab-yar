import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3, BookOpenCheck, Check, ChevronLeft, CircleAlert, Contact, Download, FileText, Landmark,
  HandCoins, Home, ListFilter, Menu, Mic, PackageSearch, Pencil, Plus, Printer, ReceiptText, RotateCcw,
  Search, Settings, Sparkles, Trash2, Users, WalletCards, WifiOff, X,
} from 'lucide-react';
import { api, flushTransactionQueue, queueTransactions } from './lib/api.js';
import { createPersianRecognizer, liveSpeechErrorMessage, liveSpeechSupported } from './lib/liveSpeech.js';
import { pendingAudio, removeOfflineAudio, saveOfflineAudio } from './lib/offlineAudio.js';
import { clock, formatAmount, formatSignedAmount, persianDate, toPersianDigits } from './lib/format.js';
import { createWavRecorder } from './lib/wavRecorder.js';
import { parseFinancialText, parseRecognitionCandidates } from '../shared/parser.js';
import { PRODUCT_POSITIONING, profileDefinition } from '../shared/product.js';

const EMPTY_SUMMARY = { income: 0, expense: 0, netCashFlow: 0, profit: 0, comparison: null };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);

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
  const [access, setAccess] = useState({ user: null, workspaces: [], workspace: null });
  const [screen, setScreen] = useState('today');
  const [drawer, setDrawer] = useState(false);
  const [data, setData] = useState({ transactions: [], summary: EMPTY_SUMMARY, categories: [], accounts: [], settings: {}, learnings: [], averages: {}, overview: {}, contacts: [], obligations: [], recurring: [] });
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
      if (bootstrap.access) setAccess(bootstrap.access);
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
    else api.authStatus().then((result) => { setAuthenticated(result.authenticated); if (result.authenticated) setAccess({ user: result.user, workspaces: result.workspaces || [], workspace: result.workspace }); }).catch((error) => { setAuthError(error.message); setAuthenticated(false); });
    return () => window.removeEventListener('hesabyar:auth-required', requireAuth);
  }, []);

  useEffect(() => { if (authenticated && !access.user?.mustChangePassword) load(); }, [authenticated, access.user?.mustChangePassword, load]);

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
      const result = await api.login(username, password);
      setAccess({ user: result.user, workspaces: result.workspaces || [], workspace: result.workspace });
      localStorage.setItem('hesab-yar-authenticated', '1');
      setAuthenticated(true);
    } catch (error) { setAuthError(error.message); }
  };

  const logout = async () => {
    try { await api.logout(); } catch { /* پاک‌کردن نشست محلی حتی اگر شبکه قطع باشد */ }
    localStorage.removeItem('hesab-yar-authenticated');
    setData({ transactions: [], summary: EMPTY_SUMMARY, categories: [], accounts: [], settings: {}, learnings: [], averages: {}, overview: {}, contacts: [], obligations: [], recurring: [] });
    setAccess({ user: null, workspaces: [], workspace: null });
    setAuthenticated(false);
  };

  const switchWorkspace = async (workspaceId) => {
    if (!workspaceId || workspaceId === access.workspace?.id) return;
    api.selectWorkspace(workspaceId);
    setLoading(true);
    setParseResult(null);
    setFailure(null);
    await load();
    navigate('today');
    notify('دفتر فعال عوض شد.');
  };

  if (authenticated === null) return <div dir="rtl" className="grid min-h-screen place-items-center bg-paper text-ink"><span className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" aria-label="در حال بارگذاری" /></div>;
  if (!authenticated) return <LoginPage onLogin={login} error={authError} />;
  if (access.user?.mustChangePassword) return <main dir="rtl" className="min-h-screen bg-paper py-10 text-ink"><div className="mx-auto max-w-[760px] px-4"><p className="text-sm font-bold text-accent">اولین ورود</p><h1 className="mt-2 text-2xl font-extrabold">رمز موقتت را عوض کن</h1><p className="mt-2 text-sm leading-7 text-muted">برای حفاظت از اطلاعات مالی، تا تعیین رمز شخصی امکان ورود به دفتر وجود ندارد.</p></div><PasswordPanel notify={notify} onChanged={logout} /></main>;

  const canWrite = ['owner', 'manager', 'accountant'].includes(access.workspace?.role);

  return (
    <div dir="rtl" className="min-h-screen bg-paper text-ink">
      {!online && <div className="sticky top-0 z-50 flex h-9 items-center justify-center gap-2 bg-ink px-4 text-[13px] text-white"><WifiOff size={15} /> آفلاین — ضبط ذخیره می‌شود و بعداً ارسال</div>}
      <div className="app-shell mx-auto min-h-screen w-full max-w-[1440px] bg-paper">
        <DesktopNav screen={screen} navigate={navigate} businessName={data.settings.businessName} profileType={data.settings.profileType} access={access} switchWorkspace={switchWorkspace} />
        <div className="safe-bottom min-w-0 lg:col-start-2">
          {screen === 'today' && (
            <TodayPage
              data={data} loading={loading} manualText={manualText} setManualText={setManualText}
              parseManual={parseManual} recordState={recordState}
              stopRecording={stopRecording} cancelProcessing={cancelProcessing} beginRecording={() => { holdingRef.current = true; startRecording(); }}
              levels={levels} liveTranscript={liveTranscript} liveVoiceNote={liveVoiceNote} livePreview={livePreview} fastVoiceAvailable={fastVoiceAvailable} openDrawer={() => setDrawer(true)} readOnly={!canWrite}
            />
          )}
          {screen === 'ledger' && <LedgerPage profileType={data.settings.profileType} categories={data.categories} accounts={data.accounts} contacts={data.contacts} notify={notify} refresh={load} />}
          {screen === 'report' && <ReportPage profileType={data.settings.profileType} />}
          {screen === 'accounting' && data.settings.profileType === 'business' && <AccountingPage access={access} notify={notify} />}
          {screen === 'tax' && data.settings.profileType === 'business' && <TaxPage access={access} notify={notify} />}
          {screen === 'learning' && <LearningPage categories={data.categories} notify={notify} />}
          {screen === 'settings' && <><SettingsPage initial={data.settings} accounts={data.accounts} notify={notify} refresh={load} onLogout={logout} canManage={['owner', 'manager'].includes(access.workspace?.role)} /><WorkspacePanel access={access} notify={notify} switchWorkspace={switchWorkspace} refreshAccess={async () => { const result = await api.workspaces(); setAccess({ user: result.user, workspaces: result.workspaces, workspace: result.workspace }); }} /><BackupPanel access={access} notify={notify} refresh={load} /><DataPrivacyPanel access={access} notify={notify} /><PasswordPanel notify={notify} onChanged={logout} /></>}
        </div>
        <InsightRail overview={data.overview} navigate={navigate} />
      </div>

      <BottomNav screen={screen} navigate={navigate} />
      {drawer && <Drawer profileType={data.settings.profileType} close={() => setDrawer(false)} navigate={navigate} access={access} switchWorkspace={switchWorkspace} />}
      {parseResult && (
        <ConfirmationSheet
          result={parseResult} categories={data.categories} accounts={data.accounts} onCancel={() => setParseResult(null)} onConfirm={saveConfirmed}
        />
      )}
      {failure && <FailureSheet failure={failure} close={() => setFailure(null)} retry={() => { setFailure(null); holdingRef.current = true; startRecording(); }} manual={() => { setFailure(null); document.getElementById('manual-entry')?.focus(); }} />}
      {toast && <div role="status" className="fixed bottom-28 left-1/2 z-[80] w-[calc(100%-32px)] max-w-[430px] -translate-x-1/2 rounded-lg bg-ink px-4 py-3 text-center text-sm text-white shadow-paper">{toast}</div>}
      {data.settings.onboardingDone === 'false' && <Onboarding initial={data.settings} onDone={async (values) => { const result = await api.settings({ ...values, onboardingDone: 'true' }); setData((current) => ({ ...current, settings: result.settings })); }} />}
    </div>
  );
}

function TodayPage({ data, loading, manualText, setManualText, parseManual, recordState, beginRecording, stopRecording, cancelProcessing, levels, liveTranscript, liveVoiceNote, livePreview, fastVoiceAvailable, openDrawer, readOnly = false }) {
  return (
    <main className="mx-auto w-full max-w-[760px]">
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line/80 bg-paper/95 px-4 py-3 backdrop-blur-sm">
        <div><h1 className="text-xl font-extrabold">امروز</h1><p className="mt-0.5 text-[13px] text-muted">{persianDate()}</p></div>
        <button className="tap grid place-items-center rounded-lg border border-line bg-surface" onClick={openDrawer} aria-label="بازکردن منو"><Menu size={23} /></button>
      </header>

      <div className="space-y-6 px-4 py-5">
        <SummaryCard summary={data.summary} loading={loading} profileType={data.settings.profileType} />
        {!!data.overview?.alerts?.length && <section className="space-y-2">{data.overview.alerts.slice(0, 2).map((alert) => <div key={alert.title} className="flex min-h-12 items-center gap-3 rounded-[10px] border-r-4 border-accent bg-warn-bg px-3 text-sm"><CircleAlert size={18} className="shrink-0 text-accent" /><span className="font-bold">{alert.title}</span></div>)}</section>}
        <section>
          <div className="mb-2 flex items-center justify-between"><h2 className="text-[17px] font-extrabold">ثبت‌های امروز</h2><span className="text-[13px] text-muted">{toPersianDigits(data.transactions.length)} مورد</span></div>
          <TransactionList items={data.transactions} loading={loading} />
        </section>

        {readOnly && <div className="rounded-[10px] border-r-4 border-accent bg-warn-bg px-3 py-3 text-sm leading-6">دسترسی تو «فقط مشاهده» است؛ می‌توانی گزارش‌ها و ثبت‌ها را ببینی اما چیزی تغییر نمی‌کند.</div>}
        <form onSubmit={parseManual} className="rounded-[10px] border border-line bg-surface p-2 shadow-paper">
          <label htmlFor="manual-entry" className="sr-only">ورود دستی</label>
          <div className="flex gap-2">
            <input disabled={readOnly} id="manual-entry" value={manualText} onChange={(event) => setManualText(event.target.value)} placeholder={readOnly ? 'در حالت فقط مشاهده، ثبت غیرفعال است' : 'یا بنویس… مثلاً ۵۰۰ هزار تومان خرید کردم'} className="tap min-w-0 flex-1 rounded-lg border-0 bg-transparent px-3 text-[15px] outline-none placeholder:text-muted/80 disabled:opacity-60" />
            <button disabled={readOnly || !manualText.trim() || recordState === 'processing'} className="tap rounded-lg bg-ink px-4 text-sm font-bold text-white disabled:opacity-35">بررسی</button>
          </div>
        </form>

        <Recorder state={recordState} start={beginRecording} stop={stopRecording} cancel={cancelProcessing} levels={levels} liveTranscript={liveTranscript} liveVoiceNote={liveVoiceNote} livePreview={livePreview} fastVoiceAvailable={fastVoiceAvailable} disabled={readOnly} />
      </div>
    </main>
  );
}

function SummaryCard({ summary, loading, profileType = 'business', context = 'today' }) {
  const profile = profileDefinition(profileType);
  const labels = context === 'today'
    ? profile.summaryLabels
    : { income: profileType === 'personal' ? 'دریافتی بازه' : 'فروش و دریافت بازه', expense: profileType === 'personal' ? 'پرداختی بازه' : 'هزینه بازه', net: 'خالص جریان نقدی' };
  const values = [
    { label: labels.income, value: summary.income, color: 'text-income' },
    { label: labels.expense, value: summary.expense, color: 'text-expense' },
    { label: labels.net, value: summary.netCashFlow ?? summary.profit, color: 'text-ink' },
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

function Recorder({ state, start, stop, cancel, levels, liveTranscript, liveVoiceNote, livePreview, fastVoiceAvailable, disabled = false }) {
  const recording = state === 'recording';
  const processing = state === 'processing';
  const requesting = state === 'requesting';
  const finalizing = state === 'finalizing';
  const press = (event) => {
    if (disabled || processing || finalizing || requesting) return;
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
    if (disabled || ![' ', 'Enter'].includes(event.key) || event.repeat || processing || finalizing || requesting) return;
    event.preventDefault();
    start();
  };
  const keyUp = (event) => {
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    stop();
  };
  return (
    <section className="voice-dock flex flex-col items-center py-2">
      {(recording || finalizing) && liveTranscript && <div aria-live="polite" className="mb-3 w-full rounded-[10px] border border-line bg-surface px-3 py-3 text-right"><p className="truncate text-sm text-muted">شنیدم: «{liveTranscript}»</p>{livePreview.length > 0 && <p className="numbers mt-2 text-lg font-extrabold text-ink">{livePreview.map((item) => formatAmount(item.amount)).join(' + ')} <span className="font-normal text-[12px] text-muted">تومان</span></p>}</div>}
      {(recording || finalizing) && liveVoiceNote && !liveTranscript && <p role="status" className="mb-3 rounded-lg bg-warn-bg px-3 py-2 text-center text-[13px] leading-6 text-expense">{liveVoiceNote}</p>}
      <p className="mb-3 text-center text-[13px] text-muted">{disabled ? 'ضبط برای نقش فقط مشاهده غیرفعال است' : recording ? (fastVoiceAvailable ? 'در حال ضبط زنده — دستت را برداری تمام می‌شود' : 'در حال ضبط — دستت را برداری تمام می‌شود') : processing ? 'صدای ضبط‌شده در حال تبدیل به متن است…' : finalizing ? 'در حال نهایی‌کردن عدد…' : requesting ? 'دکمه را نگه دار؛ میکروفن در حال فعال‌شدن است…' : 'دکمه را نگه دار و بگو؛ برای پایان دستت را بردار'}</p>
      <button
        type="button" aria-pressed={recording} aria-label={processing ? 'لغو پردازش' : recording ? 'در حال ضبط؛ برای پایان دستت را بردار' : 'برای ضبط نگه دار'} disabled={disabled || finalizing}
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

function ConfirmationSheet({ result, categories, accounts = [], onCancel, onConfirm }) {
  const defaultAccountId = accounts.find((account) => account.id === 'cash' && account.active)?.id || accounts.find((account) => account.active)?.id || 'cash';
  const [items, setItems] = useState(() => result.transactions.map((item) => ({ ...item, accountId: item.accountId || defaultAccountId, originalCategory: item.category })));
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
          <label className="flex min-h-14 items-center gap-3 border-b border-line py-2"><span className="w-12 text-[13px] text-muted">حساب</span><select value={item.accountId || defaultAccountId} onChange={(event) => patch({ accountId: event.target.value })} className="tap flex-1 rounded-lg border border-line bg-surface px-3 text-[15px] font-bold outline-none">{accounts.filter((account) => account.active).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
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

function ReportPage({ profileType = 'business' }) {
  const [range, setRange] = useState('month');
  const [report, setReport] = useState({ summary: EMPTY_SUMMARY, points: [], categories: [], insight: '' });
  const [loading, setLoading] = useState(true);
  useEffect(() => { setLoading(true); api.report(range).then(setReport).finally(() => setLoading(false)); }, [range]);
  const maximum = Math.max(1, ...report.points.flatMap((point) => [point.income, point.expense]));
  return <main className="px-4 py-5"><h1 className="text-xl font-extrabold">گزارش</h1><p className="mt-1 text-[13px] leading-6 text-muted">این گزارش بر پایهٔ دریافت و پرداخت‌های ثبت‌شده است و سود حسابداری محسوب نمی‌شود.</p><div className="mt-4 grid grid-cols-3 rounded-lg border border-line bg-surface p-1">{[['week', 'این هفته'], ['month', 'این ماه'], ['quarter', 'سه ماه']].map(([value, label]) => <button key={value} onClick={() => setRange(value)} className={`tap rounded-md text-sm font-bold ${range === value ? 'bg-ink text-white' : 'text-muted'}`}>{label}</button>)}</div><div className="mt-5"><SummaryCard summary={report.summary} loading={loading} profileType={profileType} context="range" /></div>
    {report.insight && <div className="mt-4 rounded-lg border-r-4 border-accent bg-warn-bg px-3 py-3 text-sm leading-7">{report.insight}</div>}
    <section className="mt-7"><h2 className="text-[17px] font-extrabold">روند درآمد و هزینه</h2><div className="mt-3 flex h-56 items-end gap-3 border-b border-line bg-surface px-3 pt-5">{report.points.length ? report.points.map((point) => <div key={point.label} className="flex h-full min-w-0 flex-1 flex-col justify-end"><div className="flex flex-1 items-end justify-center gap-1"><span title={`درآمد ${formatAmount(point.income)}`} className="w-3 max-w-[16px] bg-income" style={{ height: `${Math.max(2, point.income / maximum * 100)}%` }} /><span title={`هزینه ${formatAmount(point.expense)}`} className="w-3 max-w-[16px] bg-expense" style={{ height: `${Math.max(2, point.expense / maximum * 100)}%` }} /></div><span className="mt-2 truncate text-center text-[11px] text-muted">{point.label}</span></div>) : <p className="m-auto text-sm text-muted">داده‌ای برای این بازه نیست.</p>}</div><div className="mt-2 flex gap-4 text-xs text-muted"><span><i className="ml-1 inline-block h-2 w-2 bg-income" />درآمد</span><span><i className="ml-1 inline-block h-2 w-2 bg-expense" />هزینه</span></div></section>
    <section className="mt-7"><h2 className="text-[17px] font-extrabold">تفکیک دسته‌ها</h2><div className="mt-2 divide-y divide-line border-y border-line">{report.categories.map((item) => <div key={`${item.type}-${item.name}`} className="py-3"><div className="flex justify-between gap-3"><span className="text-sm font-bold">{item.name}</span><span className={`numbers text-sm font-bold ${item.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatAmount(item.amount)} تومان</span></div><div className="mt-2 h-1.5 overflow-hidden bg-line/60"><div className={item.type === 'income' ? 'h-full bg-income' : 'h-full bg-expense'} style={{ width: `${item.share}%` }} /></div></div>)}</div></section>
  </main>;
}

function currentPersianPeriod(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit' }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}

function AccountingPage({ access, notify }) {
  const [trial, setTrial] = useState({ rows: [], totals: {}, balanced: true });
  const [journal, setJournal] = useState({ items: [], total: 0 });
  const [accounts, setAccounts] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [currentPeriod, setCurrentPeriod] = useState(currentPersianPeriod());
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState({ memo: '', amount: '', debitAccountId: '', creditAccountId: '' });
  const role = access.workspace?.role || 'viewer';
  const canWrite = ['owner', 'manager', 'accountant'].includes(role);
  const isOwner = role === 'owner';
  const period = currentPeriod;
  const periodState = periods.find((item) => item.period === period);
  const load = useCallback(async () => {
    try {
      const [nextTrial, nextJournal, nextAccounts, nextPeriods] = await Promise.all([
        api.trialBalance(), api.journal({ limit: 30 }), api.accountingAccounts(), api.accountingPeriods(),
      ]);
      setTrial(nextTrial); setJournal(nextJournal); setAccounts(nextAccounts.items); setPeriods(nextPeriods.items); setCurrentPeriod(nextPeriods.currentPeriod || currentPersianPeriod());
      setDraft((current) => ({ ...current, debitAccountId: current.debitAccountId || nextAccounts.items.find((item) => item.type === 'expense')?.id || '', creditAccountId: current.creditAccountId || nextAccounts.items.find((item) => item.type === 'asset')?.id || '' }));
    } catch (error) { notify(error.message); }
  }, [notify]);
  useEffect(() => { load(); }, [load, access.workspace?.id]);
  const saveAdjustment = async (event) => {
    event.preventDefault();
    const amount = Number(draft.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) return notify('مبلغ سند اصلاحی معتبر نیست.');
    if (draft.debitAccountId === draft.creditAccountId) return notify('حساب بدهکار و بستانکار باید متفاوت باشد.');
    setBusy('journal');
    try {
      await api.createAdjustingJournal({ memo: draft.memo, lines: [{ accountId: draft.debitAccountId, debit: amount }, { accountId: draft.creditAccountId, credit: amount }] });
      setDraft((current) => ({ ...current, memo: '', amount: '' }));
      await load(); notify('سند اصلاحی متوازن ثبت شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const lock = async () => {
    if (!window.confirm(`دورهٔ ${toPersianDigits(period.replace('-', '/'))} بسته شود؟ بعد از بستن، ثبت‌ها و اصلاحات این ماه تغییر نمی‌کنند.`)) return;
    setBusy('period');
    try { await api.lockAccountingPeriod(period); await load(); notify('دوره مالی بسته شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const reopen = async () => {
    const reason = window.prompt('دلیل بازگشایی را دقیق ثبت کن؛ این توضیح در سابقه حسابرسی می‌ماند.');
    if (!reason) return;
    setBusy('period');
    try { await api.reopenAccountingPeriod(period, reason); await load(); notify('دوره با ثبت دلیل بازگشایی شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const typeLabels = { asset: 'دارایی', liability: 'بدهی', equity: 'سرمایه', income: 'درآمد', expense: 'هزینه' };
  return <main className="mx-auto w-full max-w-[980px] px-4 py-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[13px] font-bold text-accent">هسته حسابداری کسب‌وکار</p><h1 className="mt-1 text-xl font-extrabold">دفتر کل دوطرفه</h1><p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">هر دریافت یا پرداخت به سند متوازن بدهکار و بستانکار تبدیل می‌شود. این دفتر هنوز جایگزین دفاتر قانونی و محاسبات مالیاتی نیست.</p></div><div className={`rounded-lg border px-3 py-2 text-xs font-bold ${trial.balanced ? 'border-income/30 bg-income/5 text-income' : 'border-expense/30 bg-warn-bg text-expense'}`}><Check size={16} className="ml-1 inline" />{trial.balanced ? 'دفتر متوازن است' : 'عدم توازن نیازمند بررسی'}</div></div>
    <section className="mt-5 rounded-[10px] border border-line bg-surface p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-extrabold">کنترل دوره جاری</h2><p className="mt-1 text-xs text-muted">ماه {toPersianDigits(period.replace('-', '/'))} هجری شمسی · {periodState?.status === 'locked' ? 'بسته' : 'باز'}</p></div>{isOwner && (periodState?.status === 'locked' ? <button disabled={busy} onClick={reopen} className="tap rounded-lg border border-expense px-4 text-sm font-bold text-expense"><RotateCcw size={17} className="ml-1 inline" />بازگشایی با دلیل</button> : <button disabled={busy} onClick={lock} className="tap rounded-lg bg-ink px-4 text-sm font-bold text-white">بستن دوره</button>)}</div>{!isOwner && <p className="mt-3 rounded-lg bg-paper px-3 py-2 text-xs leading-6 text-muted">فقط مالک می‌تواند دوره را ببندد یا با ثبت دلیل باز کند.</p>}</section>
    <section className="mt-5"><div className="flex items-end justify-between"><div><h2 className="font-extrabold">تراز آزمایشی</h2><p className="mt-1 text-xs text-muted">واحد تمام مبالغ: تومان</p></div><span className="text-xs text-muted">گردش بدهکار و بستانکار: {formatAmount(trial.totals.debit || 0)}</span></div><div className="mt-3 overflow-x-auto rounded-[10px] border border-line bg-surface"><table className="w-full min-w-[620px] text-sm"><thead className="bg-paper text-xs text-muted"><tr><th className="px-3 py-3 text-right">کد</th><th className="px-3 py-3 text-right">حساب</th><th className="px-3 py-3 text-right">ماهیت</th><th className="px-3 py-3 text-left">مانده بدهکار</th><th className="px-3 py-3 text-left">مانده بستانکار</th></tr></thead><tbody className="divide-y divide-line">{trial.rows.filter((row) => row.debitBalance || row.creditBalance).map((row) => <tr key={row.id}><td className="numbers px-3 py-3 text-muted">{toPersianDigits(row.code)}</td><td className="px-3 py-3 font-bold">{row.name}</td><td className="px-3 py-3 text-xs text-muted">{typeLabels[row.type]}</td><td className="numbers px-3 py-3 text-left">{row.debitBalance ? formatAmount(row.debitBalance) : '—'}</td><td className="numbers px-3 py-3 text-left">{row.creditBalance ? formatAmount(row.creditBalance) : '—'}</td></tr>)}</tbody><tfoot className="border-t-2 border-ink font-extrabold"><tr><td colSpan="3" className="px-3 py-3">جمع مانده‌ها</td><td className="numbers px-3 py-3 text-left">{formatAmount(trial.totals.debitBalance || 0)}</td><td className="numbers px-3 py-3 text-left">{formatAmount(trial.totals.creditBalance || 0)}</td></tr></tfoot></table></div></section>
    {canWrite && <form onSubmit={saveAdjustment} className="mt-5 rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">سند اصلاحی ساده</h2><p className="mt-1 text-xs leading-6 text-muted">این بخش برای حسابدار یا مدیر مالی است؛ مبلغ به‌صورت برابر در بدهکار و بستانکار ثبت می‌شود.</p><input required value={draft.memo} onChange={(event) => setDraft({ ...draft, memo: event.target.value })} placeholder="شرح و دلیل اصلاح" className="tap mt-3 w-full rounded-lg border border-line px-3" /><div className="mt-2 grid gap-2 sm:grid-cols-3"><label className="text-xs text-muted">حساب بدهکار<select required value={draft.debitAccountId} onChange={(event) => setDraft({ ...draft, debitAccountId: event.target.value })} className="tap mt-1 w-full rounded-lg border border-line bg-surface px-2 text-ink">{accounts.map((account) => <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}</select></label><label className="text-xs text-muted">حساب بستانکار<select required value={draft.creditAccountId} onChange={(event) => setDraft({ ...draft, creditAccountId: event.target.value })} className="tap mt-1 w-full rounded-lg border border-line bg-surface px-2 text-ink">{accounts.map((account) => <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}</select></label><label className="text-xs text-muted">مبلغ تومان<input required inputMode="numeric" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/\D/g, '') })} className="tap numbers mt-1 w-full rounded-lg border border-line px-3 text-ink" /></label></div><button disabled={busy || periodState?.status === 'locked'} className="tap mt-3 w-full rounded-lg bg-accent font-bold text-white disabled:opacity-40">{periodState?.status === 'locked' ? 'دوره بسته است' : 'ثبت سند متوازن'}</button></form>}
    <section className="mt-6"><div className="flex justify-between"><h2 className="font-extrabold">آخرین اسناد روزنامه</h2><span className="text-xs text-muted">{toPersianDigits(journal.total)} سند</span></div><div className="mt-3 divide-y divide-line border-y border-line">{journal.items.map((entry) => <article key={entry.id} className="py-3"><div className="flex justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-bold">{entry.memo || 'سند بدون شرح'}</p><p className="mt-1 text-xs text-muted">{entry.entryKind === 'reversal' ? 'سند معکوس' : entry.entryKind === 'adjustment' ? 'سند اصلاحی' : entry.entryKind === 'opening' ? 'مانده افتتاحیه' : 'ثبت خودکار'} · {new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(entry.occurredAt))}</p></div><span className="numbers shrink-0 text-xs text-muted">#{toPersianDigits(entry.revision)}</span></div><div className="mt-2 grid gap-1 text-xs text-muted">{entry.lines.map((line) => <div key={`${entry.id}-${line.accountId}-${line.debit}-${line.credit}`} className="flex justify-between gap-3"><span>{toPersianDigits(line.code)} · {line.name}</span><span className="numbers">{line.debit ? `بدهکار ${formatAmount(line.debit)}` : `بستانکار ${formatAmount(line.credit)}`}</span></div>)}</div></article>)}</div></section>
  </main>;
}

function TaxPage({ access, notify }) {
  const [days, setDays] = useState(90);
  const [report, setReport] = useState({ summary: {}, rows: [], rates: [], disclaimer: '' });
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ name: '', rate: '', treatment: 'taxable', active: true, isDefault: false });
  const canManage = ['owner', 'manager'].includes(access.workspace?.role);
  const load = useCallback(async () => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    try { setReport(await api.taxReport(from.toISOString(), to.toISOString())); }
    catch (error) { notify(error.message); }
  }, [days, notify]);
  useEffect(() => { load(); }, [load, access.workspace?.id]);
  const save = async (event) => {
    event.preventDefault();
    if (!canManage) return notify('برای تغییر نرخ‌ها نقش مدیر یا مالک لازم است.');
    setBusy(true);
    try { await api.saveTaxRate({ ...draft, rate: draft.treatment === 'taxable' ? Number(draft.rate) : 0 }); setDraft({ name: '', rate: '', treatment: 'taxable', active: true, isDefault: false }); await load(); notify('نرخ مالیاتی ذخیره شد؛ فاکتورهای قبلی بدون تغییر می‌مانند.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const toggle = async (rate) => {
    if (!canManage || rate.id === 'tax-none') return;
    setBusy(true);
    try { await api.saveTaxRate({ ...rate, active: !rate.active }); await load(); notify(rate.active ? 'نرخ غیرفعال شد.' : 'نرخ دوباره فعال شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const summary = report.summary || {};
  const treatmentLabels = { taxable: 'مشمول', zero: 'نرخ صفر', exempt: 'معاف' };
  return <main className="mx-auto w-full max-w-[980px] px-4 py-5">
    <div><p className="text-[13px] font-bold text-accent">کنترل مدیریتی مالیات</p><h1 className="mt-1 text-xl font-extrabold">مالیات و ارزش افزوده</h1><p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">نرخ‌ها را مطابق وضعیت کسب‌وکارت تعریف کن. حساب‌یار مبلغ را شفاف محاسبه و در دفتر کل تفکیک می‌کند، اما به سامانه مودیان ارسال نمی‌کند.</p></div>
    <div className="mt-4 grid grid-cols-3 rounded-lg border border-line bg-surface p-1">{[[30, '۳۰ روز'], [90, '۹۰ روز'], [365, 'یک سال']].map(([value, label]) => <button key={value} onClick={() => setDays(value)} className={`tap rounded-md text-sm font-bold ${days === value ? 'bg-ink text-white' : 'text-muted'}`}>{label}</button>)}</div>
    <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">مالیات فروش</p><b className="numbers mt-2 block text-lg text-expense">{formatAmount(summary.outputTax || 0)}</b><span className="text-[10px] text-muted">تومان</span></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">اعتبار خرید</p><b className="numbers mt-2 block text-lg text-income">{formatAmount(summary.inputTax || 0)}</b><span className="text-[10px] text-muted">تومان</span></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">خالص برآوردی</p><b className={`numbers mt-2 block text-lg ${(summary.netTax || 0) > 0 ? 'text-expense' : 'text-income'}`}>{formatAmount(summary.netTax || 0)}</b><span className="text-[10px] text-muted">تومان</span></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">مالیات دستی قدیمی</p><b className="numbers mt-2 block text-lg">{formatAmount(summary.manualTax || 0)}</b><span className="text-[10px] text-muted">نیازمند بازبینی</span></div></div>
    <section className="mt-5 rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">تفکیک فروش</h2><div className="mt-3 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">مشمول</span><b className="numbers mt-2 block text-sm">{formatAmount(summary.taxableSales || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">نرخ صفر</span><b className="numbers mt-2 block text-sm">{formatAmount(summary.zeroSales || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">معاف</span><b className="numbers mt-2 block text-sm">{formatAmount(summary.exemptSales || 0)}</b></div></div><p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-[11px] leading-6 text-muted">«نرخ صفر» و «معاف» از نظر گزارش یکسان نیستند؛ انتخاب نوع صحیح بر عهده کسب‌وکار و حسابدار است.</p></section>
    {canManage && <form onSubmit={save} className="mt-5 rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">تعریف نرخ</h2><p className="mt-1 text-xs leading-6 text-muted">هیچ نرخ قانونی پیش‌فرضی داخل برنامه قرار نگرفته؛ نرخ معتبر خودت را وارد کن.</p><div className="mt-3 grid gap-2 sm:grid-cols-3"><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="مثلاً نرخ عمومی" className="tap rounded-lg border border-line px-3" /><select value={draft.treatment} onChange={(event) => setDraft({ ...draft, treatment: event.target.value, rate: event.target.value === 'taxable' ? draft.rate : '0' })} className="tap rounded-lg border border-line bg-surface px-3"><option value="taxable">مشمول</option><option value="zero">نرخ صفر</option><option value="exempt">معاف</option></select><label className="flex items-center rounded-lg border border-line px-3 text-xs text-muted">درصد<input required={draft.treatment === 'taxable'} disabled={draft.treatment !== 'taxable'} inputMode="decimal" value={draft.rate} onChange={(event) => setDraft({ ...draft, rate: event.target.value.replace(/[^0-9.]/g, '') })} className="tap numbers min-w-0 flex-1 bg-transparent text-left text-ink outline-none disabled:opacity-40" /></label></div><label className="mt-3 flex min-h-12 items-center gap-2 text-xs font-bold"><input type="checkbox" checked={draft.isDefault} onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })} />پیش‌فرض فاکتورهای تازه</label><button disabled={busy} className="tap mt-2 w-full rounded-lg bg-accent font-bold text-white disabled:opacity-40">ذخیره نرخ</button></form>}
    <section className="mt-6"><div className="flex items-center justify-between"><h2 className="font-extrabold">نرخ‌های تعریف‌شده</h2><span className="text-xs text-muted">{toPersianDigits(report.rates?.length || 0)} نرخ</span></div><div className="mt-2 divide-y divide-line border-y border-line">{report.rates?.map((rate) => <article key={rate.id} className="flex min-h-[68px] items-center gap-3 py-3"><div className={`h-2.5 w-2.5 rounded-full ${rate.active ? 'bg-income' : 'bg-muted'}`} /><div className="min-w-0 flex-1"><p className="font-bold">{rate.name}{rate.isDefault ? <span className="mr-2 rounded border border-accent px-1.5 py-0.5 text-[10px] text-accent">پیش‌فرض</span> : null}</p><p className="mt-1 text-xs text-muted">{treatmentLabels[rate.treatment]} · {toPersianDigits(rate.rate)}٪ · {rate.active ? 'فعال' : 'غیرفعال'}</p></div>{canManage && rate.id !== 'tax-none' && <button disabled={busy} onClick={() => toggle(rate)} className="tap rounded-lg border border-line px-3 text-xs font-bold text-muted">{rate.active ? 'غیرفعال' : 'فعال'}</button>}</article>)}</div></section>
    <section className="mt-6"><div className="flex items-center justify-between"><h2 className="font-extrabold">اسناد این بازه</h2><span className="text-xs text-muted">{toPersianDigits(report.rows?.length || 0)} سند</span></div><div className="mt-2 divide-y divide-line border-y border-line">{report.rows?.slice(0, 50).map((invoice) => <article key={invoice.id} className="flex min-h-[72px] items-center gap-3 py-3"><ReceiptText className={invoice.documentType === 'sales' ? 'text-income' : 'text-expense'} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{invoice.number} · {invoice.customerName}</p><p className="mt-1 text-xs text-muted">{invoice.documentType === 'sales' ? 'فروش' : 'خرید'} · {new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(invoice.issuedAt))}{invoice.manualTax ? ' · مالیات دستی' : ''}</p></div><div className="text-left"><b className="numbers block text-sm">{formatAmount(invoice.total)}</b><span className="numbers mt-1 block text-[10px] text-muted">مالیات {formatAmount(invoice.tax)}</span></div></article>)}</div></section>
    <p className="mt-5 rounded-lg border-r-4 border-accent bg-warn-bg px-3 py-3 text-xs leading-6 text-muted">{report.disclaimer || 'این گزارش مدیریتی است و جایگزین اظهارنامه یا صورتحساب رسمی نیست.'}</p>
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

function SettingsPage({ initial, accounts = [], notify, refresh, onLogout, canManage = false }) {
  const [settings, setSettings] = useState({ businessName: '', profileType: 'business', openingBalance: '0', lowBalanceThreshold: '2000000', ...initial });
  const [stats, setStats] = useState(null);
  useEffect(() => setSettings({ businessName: '', profileType: 'business', openingBalance: '0', lowBalanceThreshold: '2000000', ...initial }), [initial]);
  useEffect(() => { api.voiceStats().then(setStats).catch(() => {}); }, []);
  const save = async () => { if (!canManage) return notify('برای تغییر تنظیمات، نقش مدیر یا مالک لازم است.'); const result = await api.settings(settings); setSettings(result.settings); notify('تنظیمات ذخیره شد.'); };
  const selectedProfile = profileDefinition(settings.profileType);
  return <main className="mx-auto max-w-[760px] px-4 py-5">
    <h1 className="text-xl font-extrabold">تنظیمات</h1>
    <section className="mt-5 space-y-4 rounded-[10px] border border-line bg-surface p-4">
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => setSettings({ ...settings, profileType: 'business' })} className={`tap rounded-lg border text-sm font-bold ${settings.profileType === 'business' ? 'border-accent bg-warn-bg text-accent' : 'border-line'}`}>کسب‌وکار</button>
        <button onClick={() => setSettings({ ...settings, profileType: 'personal' })} className={`tap rounded-lg border text-sm font-bold ${settings.profileType === 'personal' ? 'border-accent bg-warn-bg text-accent' : 'border-line'}`}>شخصی</button>
      </div>
      <div className="rounded-lg border border-line bg-paper px-3 py-3">
        <p className="text-sm font-bold">{selectedProfile.label}</p>
        <p className="mt-1 text-[13px] leading-6 text-muted">{selectedProfile.description}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">{selectedProfile.capabilities.map((capability) => <span key={capability} className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-muted">{capability}</span>)}</div>
      </div>
      <label className="block text-[13px] text-muted">نام دفتر<input value={settings.businessName || ''} onChange={(event) => setSettings({ ...settings, businessName: event.target.value })} placeholder={settings.profileType === 'personal' ? 'مثلاً حساب‌های امیر' : 'مثلاً آرایشگاه آبان'} className="tap mt-2 w-full rounded-lg border border-line px-3 text-[15px] text-ink outline-none focus:border-accent" /></label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-[13px] text-muted">مانده شروع ثبت‌ها<input inputMode="numeric" value={settings.openingBalance || ''} onChange={(event) => setSettings({ ...settings, openingBalance: event.target.value.replace(/\D/g, '') })} className="tap numbers mt-2 w-full rounded-lg border border-line px-3" /></label>
        <label className="text-[13px] text-muted">هشدار کاهش مانده<input inputMode="numeric" value={settings.lowBalanceThreshold || ''} onChange={(event) => setSettings({ ...settings, lowBalanceThreshold: event.target.value.replace(/\D/g, '') })} className="tap numbers mt-2 w-full rounded-lg border border-line px-3" /></label>
      </div>
      <div className="rounded-lg bg-warn-bg px-3 py-2 text-[12px] leading-6 text-muted">واحد نمایش و ذخیره نسخه فعلی تومان است. مهاجرت آینده به ریال بدون تغییر معنای مبالغ موجود انجام می‌شود.</div>
      <button onClick={save} className="tap w-full rounded-lg bg-accent font-bold text-white">ذخیره تنظیمات</button>
    </section>
    <section className="mt-5 border-y border-line py-4">
      <h2 className="font-extrabold">دقت صوت و حریم خصوصی</h2>
      <p className="mt-2 text-sm leading-7 text-muted">تشخیص اصلی با مدل تخصصی گفتار فارسی انجام می‌شود و مبلغ با قواعد قطعی استخراج می‌شود. اگر سرویس اصلی در دسترس نباشد، مسیر پشتیبان فعال می‌شود. کلیدها فقط روی سرور می‌مانند.</p>
      {stats && <div className="mt-3 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-paper p-2"><b className="numbers block">{toPersianDigits(stats.total || 0)}</b><span className="text-[11px] text-muted">پردازش</span></div><div className="rounded-lg bg-paper p-2"><b className="numbers block">{toPersianDigits(stats.averageLatency || 0)}</b><span className="text-[11px] text-muted">میلی‌ثانیه</span></div><div className="rounded-lg bg-paper p-2"><b className="numbers block">{toPersianDigits(stats.reviewed || 0)}</b><span className="text-[11px] text-muted">نیاز به اصلاح</span></div></div>}
    </section>
    <section className="mt-5 rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">محدوده محصول</h2><p className="mt-2 text-[13px] leading-6 text-muted">{PRODUCT_POSITIONING.accountingDisclaimer}</p></section>
    <button onClick={onLogout} className="tap mt-5 w-full rounded-lg border border-expense/40 bg-surface font-bold text-expense">خروج از حساب</button>
  </main>;
}

function DataPrivacyPanel({ access, notify }) {
  const [receipts, setReceipts] = useState([]);
  const canDelete = ['owner', 'manager', 'accountant'].includes(access.workspace?.role);
  const load = useCallback(() => api.receipts().then((result) => setReceipts(result.items)).catch((error) => notify(error.message)), [notify]);
  useEffect(() => { load(); }, [load, access.workspace?.id]);
  const remove = async (receipt) => {
    if (!window.confirm(`تصویر «${receipt.fileName}» برای همیشه حذف شود؟ این کار تراکنش‌های مالی را حذف نمی‌کند.`)) return;
    try { await api.deleteReceipt(receipt.id); await load(); notify('تصویر رسید و فرادادهٔ آن حذف شد.'); }
    catch (error) { notify(error.message); }
  };
  return <section className="mx-auto mt-5 max-w-[760px] px-4"><div className="rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">حریم خصوصی و نگهداری داده</h2><div className="mt-3 space-y-2 text-[13px] leading-6 text-muted"><p>صدای کاربر فقط در حافظه برای تبدیل به متن پردازش می‌شود و فایل صوتی روی سرور نگه‌داری نمی‌شود.</p><p>تصاویر رسید تا زمان حذف دستی یا بازیابی یک پشتیبان نگه‌داری می‌شوند. حذف تصویر روی تراکنش مالی ثبت‌شده اثری ندارد.</p><p>پشتیبان‌های خودکار پس از بازهٔ نگهداری تنظیم‌شده به‌صورت امن از پوشهٔ پشتیبان حذف می‌شوند.</p></div>{receipts.length > 0 && <div className="mt-4 divide-y divide-line border-y border-line">{receipts.map((receipt) => <div key={receipt.id} className="flex min-h-[64px] items-center gap-2 py-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{receipt.fileName}</p><p className="mt-1 text-xs text-muted">{receipt.amount ? `${formatAmount(receipt.amount)} تومان` : 'بدون مبلغ'} · {new Intl.DateTimeFormat('fa-IR').format(new Date(receipt.createdAt))}</p></div><a href={api.workspacePath(`/api/receipts/${receipt.id}/image`)} target="_blank" rel="noreferrer" className="tap grid place-items-center rounded-lg border border-line px-3 text-xs font-bold">دیدن</a>{canDelete && <button onClick={() => remove(receipt)} className="tap grid place-items-center text-expense" aria-label={`حذف ${receipt.fileName}`}><Trash2 size={18} /></button>}</div>)}</div>}</div></section>;
}

function BackupPanel({ access, notify, refresh }) {
  const [status, setStatus] = useState(null);
  const [passphrase, setPassphrase] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState('');
  const role = access.workspace?.role;
  const canManage = ['owner', 'manager'].includes(role);
  const isOwner = role === 'owner';
  const loadStatus = useCallback(() => canManage ? api.backupStatus().then(setStatus).catch((error) => notify(error.message)) : Promise.resolve(), [canManage, notify]);
  useEffect(() => { loadStatus(); }, [loadStatus, access.workspace?.id]);
  const download = async () => {
    if (passphrase.length < 12) return notify('برای پشتیبان یک رمز حداقل ۱۲ نویسه‌ای انتخاب کن.');
    setBusy('download');
    try { await api.downloadBackup(passphrase); notify('پشتیبان رمزگذاری‌شده دانلود شد؛ رمز را جداگانه و امن نگه دار.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const inspect = async () => {
    if (!file) return notify('فایل پشتیبان را انتخاب کن.');
    if (passphrase.length < 12) return notify('رمز فایل پشتیبان را وارد کن.');
    setBusy('preview');
    try { const result = await api.previewBackup(file, passphrase); setPreview(result.summary); notify('فایل سالم است؛ خلاصه را پیش از بازیابی بررسی کن.'); }
    catch (error) { setPreview(null); notify(error.message); }
    finally { setBusy(''); }
  };
  const restore = async () => {
    if (!file || !preview) return notify('اول فایل را بررسی کن.');
    setBusy('restore');
    try {
      await api.restoreBackup(file, passphrase, confirmation);
      setFile(null); setPreview(null); setConfirmation('');
      await refresh();
      notify('دفتر با موفقیت بازیابی شد و پیش از آن checkpoint امن ساخته شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const snapshot = async () => {
    setBusy('snapshot');
    try { await api.createServerSnapshot(); await loadStatus(); notify('snapshot رمزگذاری‌شده روی سرور ساخته و آزمایش شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  if (!canManage) return null;
  return <section className="mx-auto mt-5 max-w-[760px] px-4"><div className="rounded-[10px] border border-line bg-surface p-4"><div className="flex items-start gap-3"><Download className="mt-0.5 shrink-0 text-accent" size={22} /><div><h2 className="font-extrabold">پشتیبان امن و بازیابی</h2><p className="mt-1 text-[13px] leading-6 text-muted">فایل شامل تمام داده‌های دفتر فعال و تصاویر رسید است و با AES-256 رمزگذاری می‌شود. رمز فایل روی سرور ذخیره نمی‌شود.</p></div></div><label className="mt-4 block text-[13px] text-muted">رمز پشتیبان<input type="password" minLength={12} autoComplete="new-password" value={passphrase} onChange={(event) => { setPassphrase(event.target.value); setPreview(null); }} placeholder="حداقل ۱۲ نویسه؛ در جای امن یادداشت کن" dir="ltr" className="tap mt-2 w-full rounded-lg border border-line px-3 text-left" /></label><button disabled={busy || passphrase.length < 12} onClick={download} className="tap mt-3 w-full rounded-lg bg-ink font-bold text-white disabled:opacity-40">{busy === 'download' ? 'در حال ساخت…' : 'دانلود پشتیبان رمزگذاری‌شده'}</button><div className="mt-4 rounded-lg bg-paper px-3 py-3 text-[12px] leading-6 text-muted">{status?.configured ? <><b className="text-income">پشتیبان خودکار فعال است.</b> نگهداری: {toPersianDigits(status.retentionDays)} روز. {status.lastBackup ? `آخرین نسخه: ${new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(status.lastBackup.createdAt))}` : 'هنوز نسخه‌ای ساخته نشده است.'}</> : <><b className="text-expense">پشتیبان خودکار هنوز فعال نیست.</b> متغیر BACKUP_ENCRYPTION_KEY باید روی Railway تنظیم شود.</>}</div>{status?.configured && <button disabled={busy} onClick={snapshot} className="tap mt-2 w-full rounded-lg border border-line font-bold disabled:opacity-40">{busy === 'snapshot' ? 'در حال آزمایش و ذخیره…' : 'ساخت snapshot سرور همین حالا'}</button>}{isOwner && <div className="mt-5 border-t border-line pt-4"><h3 className="font-extrabold">بازیابی دفتر فعال</h3><p className="mt-1 text-[12px] leading-6 text-expense">بازیابی، اطلاعات مالی فعلی این دفتر را جایگزین می‌کند. پیش از جایگزینی، یک checkpoint رمزگذاری‌شده ساخته می‌شود.</p><input type="file" accept=".hybackup,application/octet-stream" onChange={(event) => { setFile(event.target.files?.[0] || null); setPreview(null); setConfirmation(''); }} className="mt-3 block w-full text-xs" /><button disabled={busy || !file || passphrase.length < 12} onClick={inspect} className="tap mt-3 w-full rounded-lg border border-accent font-bold text-accent disabled:opacity-40">{busy === 'preview' ? 'در حال رمزگشایی و بررسی…' : 'بررسی فایل پیش از بازیابی'}</button>{preview && <div className="mt-3 rounded-lg border border-line bg-paper p-3"><p className="text-sm font-bold text-income">فایل سالم و قابل بازیابی است</p><div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted"><span>تراکنش: <b className="numbers text-ink">{toPersianDigits(preview.transactions)}</b></span><span>رسید: <b className="numbers text-ink">{toPersianDigits(preview.receipts)}</b></span><span>درآمد: <b className="numbers text-income">{formatAmount(preview.income)}</b></span><span>هزینه: <b className="numbers text-expense">{formatAmount(preview.expense)}</b></span></div><label className="mt-3 block text-[12px] text-muted">برای تأیید بنویس: بازیابی دفتر<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="tap mt-2 w-full rounded-lg border border-expense px-3 text-ink" /></label><button disabled={busy || confirmation !== 'بازیابی دفتر'} onClick={restore} className="tap mt-3 w-full rounded-lg bg-expense font-bold text-white disabled:opacity-35">{busy === 'restore' ? 'در حال ساخت checkpoint و بازیابی…' : 'بازیابی قطعی دفتر'}</button></div>}</div>}</div></section>;
}

const ROLE_LABELS = { owner: 'مالک', manager: 'مدیر', accountant: 'حسابدار', viewer: 'فقط مشاهده' };

function WorkspacePanel({ access, notify, switchWorkspace, refreshAccess }) {
  const [members, setMembers] = useState([]);
  const [workspaceDraft, setWorkspaceDraft] = useState({ name: '', profileType: 'business' });
  const [memberDraft, setMemberDraft] = useState({ username: '', displayName: '', temporaryPassword: '', role: 'viewer' });
  const role = access.workspace?.role || 'viewer';
  const canViewMembers = ['owner', 'manager'].includes(role);
  const isOwner = role === 'owner';
  const loadMembers = useCallback(() => canViewMembers ? api.members().then((result) => setMembers(result.items)).catch((error) => notify(error.message)) : Promise.resolve(), [canViewMembers, notify]);
  useEffect(() => { loadMembers(); }, [loadMembers, access.workspace?.id]);
  const create = async (event) => {
    event.preventDefault();
    try {
      const result = await api.createWorkspace(workspaceDraft);
      setWorkspaceDraft({ name: '', profileType: 'business' });
      await switchWorkspace(result.workspace.id);
      notify('دفتر تازه و پایگاه‌دادهٔ جدا ساخته شد.');
    } catch (error) { notify(error.message); }
  };
  const add = async (event) => {
    event.preventDefault();
    try {
      await api.addMember(memberDraft);
      setMemberDraft({ username: '', displayName: '', temporaryPassword: '', role: 'viewer' });
      await loadMembers();
      notify('دسترسی عضو ذخیره شد.');
    } catch (error) { notify(error.message); }
  };
  const updateRole = async (userId, nextRole) => {
    try { await api.updateMember(userId, nextRole); await loadMembers(); notify('نقش عضو تغییر کرد.'); }
    catch (error) { notify(error.message); }
  };
  const remove = async (userId) => {
    if (!window.confirm('دسترسی این عضو از دفتر حذف شود؟')) return;
    try { await api.removeMember(userId); await loadMembers(); await refreshAccess(); notify('دسترسی عضو حذف شد.'); }
    catch (error) { notify(error.message); }
  };
  return <section className="mx-auto mt-1 max-w-[760px] px-4"><div className="rounded-[10px] border border-line bg-surface p-4"><div className="flex items-start gap-3"><Users className="mt-0.5 shrink-0 text-accent" size={22} /><div><h2 className="font-extrabold">دفترها و دسترسی تیم</h2><p className="mt-1 text-[13px] leading-6 text-muted">اطلاعات هر دفتر در پایگاه‌داده‌ای جدا نگه‌داری می‌شود. نقش فعلی تو: <b className="text-ink">{ROLE_LABELS[role]}</b></p></div></div><label className="mt-4 block text-[13px] text-muted">دفتر فعال<select value={access.workspace?.id || ''} onChange={(event) => switchWorkspace(event.target.value)} className="tap mt-2 w-full rounded-lg border border-line bg-surface px-3 font-bold text-ink">{access.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} — {ROLE_LABELS[workspace.role]}</option>)}</select></label><form onSubmit={create} className="mt-4 grid gap-2 border-t border-line pt-4 sm:grid-cols-[1fr_150px_120px]"><input required minLength={2} value={workspaceDraft.name} onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, name: event.target.value })} placeholder="نام دفتر تازه" className="tap rounded-lg border border-line px-3" /><select value={workspaceDraft.profileType} onChange={(event) => setWorkspaceDraft({ ...workspaceDraft, profileType: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="business">کسب‌وکار</option><option value="personal">شخصی</option></select><button className="tap rounded-lg bg-ink px-3 text-sm font-bold text-white">ساخت دفتر</button></form>{canViewMembers && <div className="mt-5 border-t border-line pt-4"><div className="flex items-center justify-between"><h3 className="font-extrabold">اعضای این دفتر</h3><span className="text-xs text-muted">{toPersianDigits(members.length)} نفر</span></div><div className="mt-3 divide-y divide-line border-y border-line">{members.map((member) => <div key={member.id} className="flex min-h-[68px] items-center gap-2 py-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{member.displayName || member.username}</p><p className="mt-1 truncate text-xs text-muted" dir="ltr">@{member.username}</p></div>{isOwner ? <select value={member.role} onChange={(event) => updateRole(member.id, event.target.value)} className="tap max-w-32 rounded-lg border border-line bg-surface px-2 text-xs font-bold"><option value="owner">مالک</option><option value="manager">مدیر</option><option value="accountant">حسابدار</option><option value="viewer">فقط مشاهده</option></select> : <span className="rounded-md border border-line px-2 py-1 text-xs">{ROLE_LABELS[member.role]}</span>}{isOwner && member.id !== access.user?.id && <button onClick={() => remove(member.id)} className="tap grid place-items-center text-expense" aria-label="حذف دسترسی"><Trash2 size={17} /></button>}</div>)}</div>{isOwner && <form onSubmit={add} className="mt-4 grid gap-2 sm:grid-cols-2"><input required value={memberDraft.username} onChange={(event) => setMemberDraft({ ...memberDraft, username: event.target.value })} placeholder="نام کاربری انگلیسی" dir="ltr" className="tap rounded-lg border border-line px-3 text-left" /><input value={memberDraft.displayName} onChange={(event) => setMemberDraft({ ...memberDraft, displayName: event.target.value })} placeholder="نام نمایشی" className="tap rounded-lg border border-line px-3" /><input value={memberDraft.temporaryPassword} onChange={(event) => setMemberDraft({ ...memberDraft, temporaryPassword: event.target.value })} placeholder="رمز موقت ۱۴ نویسه‌ای (برای کاربر تازه)" dir="ltr" type="password" autoComplete="new-password" className="tap rounded-lg border border-line px-3 text-left" /><select value={memberDraft.role} onChange={(event) => setMemberDraft({ ...memberDraft, role: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="viewer">فقط مشاهده</option><option value="accountant">حسابدار</option><option value="manager">مدیر</option><option value="owner">مالک</option></select><button className="tap rounded-lg bg-accent font-bold text-white sm:col-span-2">افزودن یا به‌روزرسانی عضو</button></form>}<p className="mt-3 text-[11px] leading-5 text-muted">کاربر تازه در اولین ورود باید رمز موقت را عوض کند. حسابدار ثبت‌های مالی را مدیریت می‌کند؛ مدیر تنظیمات دفتر را هم تغییر می‌دهد؛ فقط مالک اعضا را مدیریت می‌کند.</p></div>}</div></section>;
}

function PasswordPanel({ notify, onChanged }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (newPassword !== confirmation) return notify('تکرار رمز جدید یکسان نیست.');
    setSaving(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      notify('رمز تغییر کرد؛ برای امنیت دوباره وارد شو.');
      await onChanged();
    } catch (error) { notify(error.message); }
    finally { setSaving(false); }
  };
  return <section className="mx-auto mt-5 max-w-[760px] px-4"><form onSubmit={submit} className="rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">تغییر رمز مالک</h2><p className="mt-2 text-[13px] leading-6 text-muted">حداقل ۱۴ نویسه، شامل حرف و عدد. پس از تغییر، همهٔ نشست‌های قبلی بسته می‌شوند.</p><label className="mt-4 block text-[13px] text-muted">رمز فعلی<input required type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} className="tap mt-2 w-full rounded-lg border border-line px-3" /></label><label className="mt-3 block text-[13px] text-muted">رمز جدید<input required minLength={14} type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="tap mt-2 w-full rounded-lg border border-line px-3" /></label><label className="mt-3 block text-[13px] text-muted">تکرار رمز جدید<input required minLength={14} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="tap mt-2 w-full rounded-lg border border-line px-3" /></label><button disabled={saving || newPassword !== confirmation} className="tap mt-4 w-full rounded-lg bg-ink font-bold text-white disabled:opacity-40">{saving ? 'در حال تغییر…' : 'تغییر رمز و خروج از همه دستگاه‌ها'}</button></form></section>;
}

function LoginPage({ onLogin, error }) {
  const [username, setUsername] = useState('owner');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event) => { event.preventDefault(); setSubmitting(true); await onLogin(username, password); setSubmitting(false); };
  return <main dir="rtl" className="grid min-h-screen place-items-center bg-paper px-4 text-ink"><section className="w-full max-w-[390px]"><div className="mb-8"><div className="mb-4 grid h-14 w-14 place-items-center rounded-[10px] border border-line bg-surface shadow-paper"><FileText className="text-accent" size={27} /></div><h1 className="text-2xl font-extrabold">ورود به حساب‌یار</h1><p className="mt-2 text-sm leading-7 text-muted">اطلاعات مالی خصوصی است؛ برای ادامه رمز مالک را وارد کن.</p></div><form onSubmit={submit} className="rounded-[10px] border border-line bg-surface p-4 shadow-paper"><label className="block text-[13px] text-muted">نام کاربری<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} className="tap mt-2 w-full rounded-lg border border-line px-3 text-ink outline-none focus:border-accent" /></label><label className="mt-4 block text-[13px] text-muted">رمز عبور<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="tap mt-2 w-full rounded-lg border border-line px-3 text-ink outline-none focus:border-accent" /></label>{error && <p role="alert" className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-sm leading-6 text-expense">{error}</p>}<button disabled={submitting || !username || password.length < 1} className="tap mt-5 w-full rounded-lg bg-accent font-extrabold text-white disabled:opacity-50">{submitting ? 'در حال بررسی…' : 'ورود امن'}</button></form></section></main>;
}

function DesktopNav({ screen, navigate, businessName, profileType = 'business' }) {
  const items = [
    ['today', 'امروز', Home], ['ledger', 'دفتر مالی', WalletCards], ['report', 'گزارش', BarChart3],
    ...(profileType === 'business' ? [['accounting', 'حسابداری', BookOpenCheck], ['tax', 'مالیات', HandCoins]] : []),
    ['learning', 'یادگیری‌ها', BookOpenCheck], ['settings', 'تنظیمات', Settings],
  ];
  const profile = profileDefinition(profileType);
  return <aside className="desktop-nav hidden border-l border-line bg-surface px-4 py-6 lg:block"><div className="sticky top-6"><div className="mb-8 border-b border-line pb-5"><p className="text-xl font-extrabold">حساب‌یار</p><p className="mt-1 truncate text-xs text-muted">{businessName || profile.label}</p><p className="mt-1 text-[11px] leading-5 text-muted">دستیار ثبت و مدیریت نقدینگی</p></div><nav className="space-y-1">{items.map(([id, label, Icon]) => <button key={id} onClick={() => navigate(id)} className={`tap flex w-full items-center gap-3 rounded-lg px-3 text-right text-sm font-bold ${screen === id ? 'bg-warn-bg text-accent' : 'text-muted hover:bg-paper hover:text-ink'}`}><Icon size={20} />{label}</button>)}</nav></div></aside>;
}

function InsightRail({ overview = {}, navigate }) {
  return <aside className="hidden border-r border-line px-5 py-7 xl:block"><div className="sticky top-7 space-y-5"><div><p className="text-[13px] text-muted">وضعیت همین حالا</p><p className="numbers mt-2 text-2xl font-extrabold">{formatAmount(overview.cash || 0)}</p><p className="text-xs leading-5 text-muted">تومان ماندهٔ برآوردی ثبت‌ها</p></div><div className="border-y border-line py-4 text-sm"><div className="flex justify-between py-1"><span className="text-muted">طلب باز</span><b className="numbers text-income">{formatAmount(overview.receivable || 0)}</b></div><div className="flex justify-between py-1"><span className="text-muted">بدهی باز</span><b className="numbers text-expense">{formatAmount(overview.payable || 0)}</b></div>{overview.runwayDays != null && <div className="flex justify-between py-1"><span className="text-muted">دوام نقدینگی برآوردی</span><b>{toPersianDigits(overview.runwayDays)} روز</b></div>}</div><p className="text-[11px] leading-5 text-muted">این مانده تا پیش از تطبیق صندوق یا بانک، قطعی نیست.</p><button onClick={() => navigate('ledger')} className="tap w-full rounded-lg border border-line bg-surface px-3 text-sm font-bold">بازکردن دفتر کامل</button></div></aside>;
}

function Onboarding({ initial, onDone }) {
  const [profileType, setProfileType] = useState(initial.profileType || 'business');
  const [businessName, setBusinessName] = useState(initial.businessName || '');
  const [saving, setSaving] = useState(false);
  const submit = async () => { setSaving(true); await onDone({ profileType, businessName }); setSaving(false); };
  const selectedProfile = profileDefinition(profileType);
  return <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/45 p-4 backdrop-blur-[2px]"><section role="dialog" aria-modal="true" className="w-full max-w-[520px] rounded-[12px] border border-line bg-paper p-5 shadow-2xl"><p className="text-sm font-bold text-accent">راه‌اندازی یک‌دقیقه‌ای</p><h2 className="mt-2 text-2xl font-extrabold">حساب‌یار را برای خودت تنظیم کن</h2><p className="mt-2 text-sm leading-7 text-muted">نوع استفاده، ابزارهای دفترت را مشخص می‌کند و هر زمان قابل تغییر است.</p><div className="mt-5 grid grid-cols-2 gap-2"><button onClick={() => setProfileType('business')} className={`tap rounded-lg border px-3 text-sm font-bold ${profileType === 'business' ? 'border-accent bg-warn-bg text-accent' : 'border-line bg-surface'}`}>کسب‌وکار کوچک</button><button onClick={() => setProfileType('personal')} className={`tap rounded-lg border px-3 text-sm font-bold ${profileType === 'personal' ? 'border-accent bg-warn-bg text-accent' : 'border-line bg-surface'}`}>حساب شخصی</button></div><div className="mt-3 rounded-lg border border-line bg-surface px-3 py-3"><p className="text-sm font-bold">{selectedProfile.label}</p><p className="mt-1 text-[13px] leading-6 text-muted">{selectedProfile.description}</p></div><label className="mt-4 block text-[13px] text-muted">{profileType === 'business' ? 'نام کسب‌وکار' : 'نام دفتر شخصی'}<input value={businessName} onChange={(event) => setBusinessName(event.target.value)} placeholder={profileType === 'business' ? 'مثلاً فروشگاه آبان' : 'مثلاً حساب‌های امیر'} className="tap mt-2 w-full rounded-lg border border-line bg-surface px-3 text-ink outline-none focus:border-accent" /></label><p className="mt-3 text-[12px] leading-6 text-muted">{PRODUCT_POSITIONING.accountingDisclaimer}</p><button disabled={saving} onClick={submit} className="tap mt-5 w-full rounded-lg bg-accent font-extrabold text-white">{saving ? 'در حال ذخیره…' : 'شروع کار'}</button></section></div>;
}

function LedgerPage({ profileType = 'business', categories, accounts = [], contacts: initialContacts, notify, refresh }) {
  const [tab, setTab] = useState('transactions');
  const profile = profileDefinition(profileType);
  const allTabs = [['transactions', profileType === 'personal' ? 'ثبت‌ها' : 'تراکنش‌ها'], ['obligations', profileType === 'personal' ? 'قسط و بدهی' : 'طلب و بدهی'], ['invoices', 'فاکتور'], ['reconciliation', 'تطبیق بانک'], ['recurring', 'دوره‌ای'], ['inventory', 'موجودی'], ['tools', 'ابزارها']];
  const tabs = allTabs.filter(([id]) => profile.ledgerTabs.includes(id));
  useEffect(() => { if (!profile.ledgerTabs.includes(tab)) setTab('transactions'); }, [profile, tab]);
  return <main className="mx-auto w-full max-w-[900px] px-4 py-5"><div className="flex items-center justify-between"><div><h1 className="text-xl font-extrabold">دفتر مالی</h1><p className="mt-1 text-[13px] text-muted">{profile.description}</p></div><ListFilter className="text-muted" /></div><div className="scrollbar-none -mx-4 mt-5 flex gap-2 overflow-x-auto border-b border-line px-4 pb-3">{tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} className={`tap shrink-0 rounded-lg px-4 text-sm font-bold ${tab === id ? 'bg-ink text-white' : 'border border-line bg-surface text-muted'}`}>{label}</button>)}</div>{tab === 'transactions' && <TransactionsPanel categories={categories} accounts={accounts} contacts={initialContacts} notify={notify} refresh={refresh} />}{tab === 'obligations' && <ObligationsPanel contacts={initialContacts} notify={notify} refresh={refresh} />}{tab === 'invoices' && <InvoicesPanel contacts={initialContacts} accounts={accounts} categories={categories} notify={notify} refresh={refresh} />}{tab === 'reconciliation' && <ReconciliationPanel accounts={accounts} categories={categories} notify={notify} refresh={refresh} />}{tab === 'recurring' && <RecurringPanel categories={categories} notify={notify} />}{tab === 'inventory' && <InventoryPanel notify={notify} />}{tab === 'tools' && <ToolsPanel profileType={profileType} notify={notify} />}</main>;
}

function TransactionsPanel({ categories, accounts = [], contacts, notify, refresh }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [result, setResult] = useState({ items: [], total: 0 });
  const [editing, setEditing] = useState(null);
  const load = useCallback(() => api.transactions({ query, type, limit: 50 }).then(setResult).catch((error) => notify(error.message)), [query, type, notify]);
  useEffect(() => { const timer = window.setTimeout(load, 180); return () => window.clearTimeout(timer); }, [load]);
  const remove = async (id) => { if (!window.confirm('این تراکنش از دفتر حذف شود؟ سابقهٔ تغییر برای امنیت باقی می‌ماند.')) return; await api.deleteTransaction(id); notify('تراکنش حذف شد.'); load(); refresh(); };
  const save = async (event) => { event.preventDefault(); await api.updateTransaction(editing.id, editing); setEditing(null); notify('اصلاح تراکنش ذخیره شد.'); load(); refresh(); };
  return <section className="mt-5"><div className="grid gap-2 sm:grid-cols-[1fr_160px]"><label className="flex min-h-12 items-center gap-2 rounded-lg border border-line bg-surface px-3"><Search size={18} className="text-muted" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="جست‌وجوی مبلغ، دسته، شخص یا توضیح" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label><select value={type} onChange={(event) => setType(event.target.value)} className="tap rounded-lg border border-line bg-surface px-3 text-sm"><option value="">همهٔ نوع‌ها</option><option value="income">درآمد</option><option value="expense">هزینه</option></select></div><p className="mt-3 text-xs text-muted">{toPersianDigits(result.total)} ثبت پیدا شد</p><div className="mt-2 divide-y divide-line border-y border-line">{result.items.map((item) => <article key={item.id} className="flex min-h-[78px] items-center gap-3 py-3"><div className="min-w-0 flex-1"><p className={`numbers font-extrabold ${item.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatSignedAmount(item)} <small className="font-normal text-muted">تومان</small></p><p className="mt-1 truncate text-xs text-muted">{item.category}{item.accountName ? ` · ${item.accountName}` : ''}{item.contactName ? ` · ${item.contactName}` : ''} · {item.rawText}</p>{item.status === 'allocated' && <p className="mt-1 text-[10px] font-bold text-accent">متصل به تسویه سند — اصلاح از بخش فاکتور</p>}</div>{item.status !== 'allocated' && <><button onClick={() => setEditing(item)} className="tap grid place-items-center text-muted" aria-label="ویرایش"><Pencil size={18} /></button><button onClick={() => remove(item.id)} className="tap grid place-items-center text-expense" aria-label="حذف"><Trash2 size={18} /></button></>}</article>)}</div>{editing && <div className="fixed inset-0 z-[75] grid place-items-center bg-ink/40 p-4"><form onSubmit={save} className="w-full max-w-[480px] rounded-[12px] bg-paper p-4"><div className="flex justify-between"><h2 className="text-lg font-extrabold">اصلاح تراکنش</h2><button type="button" onClick={() => setEditing(null)} className="tap grid place-items-center"><X /></button></div><label className="mt-4 block text-xs text-muted">مبلغ<input inputMode="numeric" value={editing.amount} onChange={(event) => setEditing({ ...editing, amount: event.target.value.replace(/\D/g, '') })} className="tap numbers mt-2 w-full rounded-lg border border-line bg-surface px-3 text-lg font-bold" /></label><div className="mt-3 grid grid-cols-2 gap-2"><select value={editing.type} onChange={(event) => setEditing({ ...editing, type: event.target.value })} className="tap rounded-lg border border-line bg-surface px-3"><option value="income">درآمد</option><option value="expense">هزینه</option></select><select value={editing.category} onChange={(event) => setEditing({ ...editing, category: event.target.value })} className="tap min-w-0 rounded-lg border border-line bg-surface px-3">{categories.filter((item) => item.type === editing.type).map((item) => <option key={item.id}>{item.name}</option>)}</select></div><select value={editing.accountId || 'cash'} onChange={(event) => setEditing({ ...editing, accountId: event.target.value })} className="tap mt-3 w-full rounded-lg border border-line bg-surface px-3">{accounts.filter((account) => account.active).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select><select value={editing.contactId || ''} onChange={(event) => setEditing({ ...editing, contactId: event.target.value })} className="tap mt-3 w-full rounded-lg border border-line bg-surface px-3"><option value="">بدون شخص</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select><textarea value={editing.note || ''} onChange={(event) => setEditing({ ...editing, note: event.target.value })} placeholder="یادداشت" className="mt-3 min-h-20 w-full rounded-lg border border-line bg-surface p-3 text-sm" /><button className="tap mt-3 w-full rounded-lg bg-accent font-bold text-white">ذخیره اصلاح</button></form></div>}</section>;
}

function ObligationsPanel({ contacts: initialContacts, notify, refresh }) {
  const [contacts, setContacts] = useState(initialContacts || []);
  const [items, setItems] = useState([]);
  const [contactName, setContactName] = useState('');
  const [draft, setDraft] = useState({ title: '', amount: '', direction: 'receivable', contactId: '', dueAt: '' });
  const load = useCallback(async () => { const [people, obligations] = await Promise.all([api.contacts(), api.obligations('open')]); setContacts(people.items); setItems(obligations.items); }, []);
  useEffect(() => { load(); }, [load]);
  const addContact = async () => { if (!contactName.trim()) return; await api.saveContact({ name: contactName }); setContactName(''); notify('شخص اضافه شد.'); load(); refresh(); };
  const add = async (event) => { event.preventDefault(); await api.saveObligation(draft); setDraft({ title: '', amount: '', direction: 'receivable', contactId: '', dueAt: '' }); notify('سررسید ذخیره شد.'); load(); refresh(); };
  const settle = async (id) => { await api.settleObligation(id); notify('تسویه شد و تراکنش آن در دفتر ثبت شد.'); load(); refresh(); };
  return <section className="mt-5 space-y-6"><div><h2 className="font-extrabold">اشخاص</h2><div className="mt-2 flex gap-2"><input value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="نام شخص یا مشتری" className="tap min-w-0 flex-1 rounded-lg border border-line bg-surface px-3" /><button onClick={addContact} className="tap rounded-lg bg-ink px-4 font-bold text-white">افزودن</button></div><div className="scrollbar-none mt-2 flex gap-2 overflow-x-auto">{contacts.map((contact) => <span key={contact.id} className="shrink-0 rounded-lg border border-line bg-surface px-3 py-2 text-xs"><b>{contact.name}</b>{Number(contact.balance) !== 0 && <span className={`numbers mr-2 ${contact.balance > 0 ? 'text-income' : 'text-expense'}`}>{formatAmount(Math.abs(contact.balance))}</span>}</span>)}</div></div><form onSubmit={add} className="rounded-[10px] border border-line bg-surface p-3"><h2 className="font-extrabold">طلب یا بدهی تازه</h2><div className="mt-3 grid gap-2 sm:grid-cols-2"><input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="مثلاً طلب از حسن" className="tap rounded-lg border border-line px-3" /><input required inputMode="numeric" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/\D/g, '') })} placeholder="مبلغ تومان" className="tap numbers rounded-lg border border-line px-3" /><select value={draft.direction} onChange={(event) => setDraft({ ...draft, direction: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="receivable">طلب دارم</option><option value="payable">بدهکارم</option></select><select value={draft.contactId} onChange={(event) => setDraft({ ...draft, contactId: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="">بدون شخص</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select><input type="date" value={draft.dueAt} onChange={(event) => setDraft({ ...draft, dueAt: event.target.value ? new Date(`${event.target.value}T09:00:00`).toISOString() : '' })} className="tap rounded-lg border border-line px-3" /><button className="tap rounded-lg bg-accent font-bold text-white">ذخیره سررسید</button></div></form><div className="divide-y divide-line border-y border-line">{items.length ? items.map((item) => <article key={item.id} className="flex min-h-[76px] items-center gap-3 py-3"><HandCoins className={item.direction === 'receivable' ? 'text-income' : 'text-expense'} /><div className="min-w-0 flex-1"><p className="font-bold">{item.title}</p><p className="mt-1 text-xs text-muted">{item.contactName || 'بدون شخص'}{item.dueAt ? ` · سررسید ${new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(item.dueAt))}` : ''}</p></div><b className="numbers text-sm">{formatAmount(item.amount)}</b><button onClick={() => settle(item.id)} className="tap rounded-lg border border-income px-3 text-xs font-bold text-income">تسویه</button></article>) : <p className="py-10 text-center text-sm text-muted">طلب یا بدهی بازی نداری.</p>}</div></section>;
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
  const save = async (event) => { event.preventDefault(); await api.saveInvoice(draft); setDraft(freshDraft()); notify(draft.issueNow ? 'سند صادر و مالیات آن در دفتر کل تفکیک شد.' : 'پیش‌نویس ذخیره شد.'); load(); refresh(); };
  const issue = async (id) => { await api.issueInvoice(id); notify('سند صادر و حساب طرف مقابل ثبت شد.'); load(); refresh(); };
  const openPayment = (item) => setPayment({ id: item.id, amount: String(item.balanceDue), accountId: accounts.find((account) => account.active)?.id || 'cash', documentType: item.documentType, number: item.number });
  const pay = async (event) => { event.preventDefault(); await api.recordInvoicePayment(payment.id, payment); setPayment(null); notify(payment.documentType === 'purchase' ? 'پرداخت ثبت شد.' : 'وصول ثبت شد.'); load(); refresh(); };
  const print = async (id) => { const { item } = await api.invoice(id); const popup = window.open('', '_blank', 'width=760,height=900'); if (!popup) return notify('اجازهٔ بازکردن پنجرهٔ چاپ را فعال کن.'); popup.document.write(`<html dir="rtl"><head><title>${escapeHtml(item.number)}</title><style>body{font-family:Tahoma;padding:40px;color:#1c1b19}h1{border-bottom:2px solid #1c1b19;padding-bottom:16px}table{width:100%;border-collapse:collapse;margin-top:30px}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:right}.summary{margin-top:24px;margin-right:auto;width:280px}.summary p{display:flex;justify-content:space-between}.total{font-size:22px;font-weight:bold;border-top:2px solid #1c1b19;padding-top:12px}</style></head><body><h1>${item.documentType === 'purchase' ? 'صورتحساب خرید' : 'فاکتور فروش'} ${escapeHtml(item.number)}</h1><p>طرف حساب: ${escapeHtml(item.customerName)}</p><table><thead><tr><th>شرح</th><th>تعداد</th><th>مبلغ واحد</th><th>جمع</th><th>مالیات</th></tr></thead><tbody>${item.items.map((line) => `<tr><td>${escapeHtml(line.title)}</td><td>${escapeHtml(line.quantity)}</td><td>${formatAmount(line.unitPrice)}</td><td>${formatAmount(line.total)}</td><td>${formatAmount(line.taxAmount || 0)}</td></tr>`).join('')}</tbody></table><div class="summary"><p><span>جمع اقلام</span><b>${formatAmount(item.subtotal)}</b></p><p><span>تخفیف</span><b>${formatAmount(item.discount)}</b></p><p><span>مالیات و عوارض</span><b>${formatAmount(item.tax)}</b></p><p class="total"><span>جمع کل</span><b>${formatAmount(item.total)} تومان</b></p></div><script>window.print()<\/script></body></html>`); popup.document.close(); };
  const statusLabels = { draft: 'پیش‌نویس', open: 'باز', partial: 'بخشی تسویه شده', overdue: 'سررسید گذشته', paid: 'تسویه کامل', cancelled: 'باطل‌شده' };
  return <section className="mt-5 space-y-6">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">مطالبات باز</p><b className="numbers mt-2 block text-lg text-income">{formatAmount(result.summary.receivable || 0)}</b></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">بدهی تأمین‌کننده</p><b className="numbers mt-2 block text-lg text-expense">{formatAmount(result.summary.payable || 0)}</b></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">مطالبات معوق</p><b className="numbers mt-2 block text-lg">{formatAmount(result.summary.overdueReceivable || 0)}</b></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">پرداخت معوق</p><b className="numbers mt-2 block text-lg">{formatAmount(result.summary.overduePayable || 0)}</b></div></div>
    <form onSubmit={save} className="rounded-[10px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-extrabold">سند تازه</h2><p className="mt-1 text-xs text-muted">مالیات هر ردیف قبل از صدور محاسبه و در حساب جداگانه ثبت می‌شود.</p></div><div className="flex rounded-lg border border-line p-1"><button type="button" onClick={() => changeType('sales')} className={`tap rounded-md px-4 text-sm font-bold ${draft.documentType === 'sales' ? 'bg-income text-white' : 'text-muted'}`}>فروش</button><button type="button" onClick={() => changeType('purchase')} className={`tap rounded-md px-4 text-sm font-bold ${draft.documentType === 'purchase' ? 'bg-expense text-white' : 'text-muted'}`}>خرید</button></div></div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2"><input required value={draft.customerName} onChange={(event) => setDraft({ ...draft, customerName: event.target.value })} placeholder={draft.documentType === 'purchase' ? 'نام تأمین‌کننده' : 'نام مشتری'} className="tap rounded-lg border border-line px-3" /><select value={draft.contactId} onChange={(event) => setDraft({ ...draft, contactId: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="">طرف حساب ثبت‌شده (اختیاری)</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="tap rounded-lg border border-line px-3">{categories.filter((item) => item.type === (draft.documentType === 'purchase' ? 'expense' : 'income')).map((item) => <option key={item.id}>{item.name}</option>)}</select><label className="flex items-center gap-2 rounded-lg border border-line px-3 text-xs text-muted">سررسید<input type="date" value={draft.dueAt} onChange={(event) => setDraft({ ...draft, dueAt: event.target.value ? new Date(`${event.target.value}T09:00:00`).toISOString() : '' })} className="tap min-w-0 flex-1 bg-transparent text-ink" /></label></div>
      {draft.items.map((line, index) => <div key={index} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-[140px_minmax(0,1fr)_70px_110px_135px]"><select value={line.productId} onChange={(event) => chooseProduct(index, event.target.value)} className="tap min-w-0 rounded-lg border border-line bg-paper px-2 text-xs"><option value="">خدمت / بدون انبار</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name} · {toPersianDigits(product.stock)} {product.unit}</option>)}</select><input required value={line.title} onChange={(event) => patchLine(index, { title: event.target.value })} placeholder="شرح کالا یا خدمت" className="tap min-w-0 rounded-lg border border-line px-3" /><input inputMode="decimal" value={line.quantity} onChange={(event) => patchLine(index, { quantity: event.target.value })} placeholder="تعداد" className="tap numbers min-w-0 rounded-lg border border-line px-2" /><input required inputMode="numeric" value={line.unitPrice} onChange={(event) => patchLine(index, { unitPrice: event.target.value.replace(/\D/g, '') })} placeholder="مبلغ واحد" className="tap numbers min-w-0 rounded-lg border border-line px-2" /><select aria-label="نوع و نرخ مالیات" value={line.taxRateId || defaultTaxRateId()} onChange={(event) => patchLine(index, { taxRateId: event.target.value })} className="tap min-w-0 rounded-lg border border-line bg-surface px-2 text-xs">{taxRates.filter((rate) => rate.active).map((rate) => <option key={rate.id} value={rate.id}>{rate.name} · {toPersianDigits(rate.rate)}٪</option>)}</select></div>)}
      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(280px,1fr)]"><input inputMode="numeric" value={draft.discount} onChange={(event) => setDraft({ ...draft, discount: event.target.value.replace(/\D/g, '') })} placeholder="تخفیف (تومان)" className="tap numbers rounded-lg border border-line px-3" /><div className="grid grid-cols-2 gap-2 rounded-lg bg-paper px-3 py-2 text-xs"><span className="text-muted">مالیات محاسبه‌شده<b className="numbers mt-1 block text-sm text-ink">{formatAmount(invoicePreview.tax)}</b></span><span className="text-muted">جمع قابل پرداخت<b className="numbers mt-1 block text-sm text-ink">{formatAmount(invoicePreview.total)}</b></span></div></div>
      <p className="mt-2 text-[11px] leading-5 text-muted">تخفیف به نسبت مبلغ ردیف‌ها تقسیم می‌شود. مالیات خرید وارد بهای موجودی نمی‌شود و جداگانه به‌عنوان اعتبار مالیاتی ثبت می‌شود.</p>
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => setDraft({ ...draft, items: [...draft.items, { productId: '', title: '', quantity: 1, unitPrice: '', taxRateId: defaultTaxRateId() }] })} className="tap rounded-lg border border-line px-3 text-sm font-bold"><Plus size={17} className="ml-1 inline" />ردیف</button><label className="flex min-h-12 items-center gap-2 text-xs font-bold"><input type="checkbox" checked={draft.issueNow} onChange={(event) => setDraft({ ...draft, issueNow: event.target.checked })} />همین حالا صادر شود</label><button className="tap min-w-[160px] flex-1 rounded-lg bg-accent font-bold text-white">{draft.issueNow ? 'صدور و ثبت حسابداری' : 'ذخیره پیش‌نویس'}</button></div>
    </form>
    <div><div className="mb-2 flex items-center justify-between"><h2 className="font-extrabold">اسناد</h2><select value={filter} onChange={(event) => setFilter(event.target.value)} className="tap rounded-lg border border-line bg-surface px-3 text-sm"><option value="all">همه</option><option value="sales">فروش</option><option value="purchase">خرید</option></select></div><div className="divide-y divide-line border-y border-line">{result.items.length ? result.items.map((item) => <article key={item.id} className="grid min-h-[88px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3"><ReceiptText className={item.documentType === 'sales' ? 'text-income' : 'text-expense'} /><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-bold">{item.customerName}</p><span className={`rounded border px-2 py-1 text-[10px] font-bold ${item.displayStatus === 'overdue' ? 'border-expense text-expense' : 'border-line text-muted'}`}>{statusLabels[item.displayStatus]}</span></div><p className="mt-1 text-xs text-muted">{item.number} · {item.documentType === 'purchase' ? 'خرید' : 'فروش'}{item.dueAt ? ` · سررسید ${new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(item.dueAt))}` : ''}</p><div className="mt-2 h-1.5 overflow-hidden rounded bg-line"><div className="h-full bg-accent" style={{ width: `${Math.min(100, Math.round((item.paidAmount / item.total) * 100))}%` }} /></div></div><div className="text-left"><b className="numbers block text-sm">{formatAmount(item.total)}</b>{item.balanceDue > 0 && <span className="numbers mt-1 block text-[11px] text-muted">مانده {formatAmount(item.balanceDue)}</span>}<div className="mt-2 flex justify-end gap-1"><button onClick={() => print(item.id)} className="tap grid place-items-center text-muted" aria-label="چاپ"><Printer size={18} /></button>{item.status === 'draft' && <button onClick={() => issue(item.id)} className="tap rounded-lg border border-accent px-2 text-xs font-bold text-accent">صدور</button>}{['open', 'partial', 'overdue'].includes(item.displayStatus) && <button onClick={() => openPayment(item)} className="tap rounded-lg border border-income px-2 text-xs font-bold text-income">{item.documentType === 'purchase' ? 'پرداخت' : 'وصول'}</button>}</div></div></article>) : <p className="py-10 text-center text-sm text-muted">هنوز سندی ثبت نشده است.</p>}</div></div>
    {payment && <div className="fixed inset-0 z-[80] grid place-items-center bg-ink/40 p-4"><form onSubmit={pay} className="w-full max-w-[420px] rounded-[12px] bg-paper p-4"><div className="flex items-center justify-between"><div><h2 className="text-lg font-extrabold">{payment.documentType === 'purchase' ? 'ثبت پرداخت' : 'ثبت وصول'}</h2><p className="mt-1 text-xs text-muted">سند {payment.number}</p></div><button type="button" onClick={() => setPayment(null)} className="tap grid place-items-center"><X /></button></div><label className="mt-4 block text-xs text-muted">مبلغ تومان<input autoFocus required inputMode="numeric" value={payment.amount} onChange={(event) => setPayment({ ...payment, amount: event.target.value.replace(/\D/g, '') })} className="tap numbers mt-2 w-full rounded-lg border border-line bg-surface px-3 text-xl font-extrabold" /></label><label className="mt-3 block text-xs text-muted">حساب پول<select value={payment.accountId} onChange={(event) => setPayment({ ...payment, accountId: event.target.value })} className="tap mt-2 w-full rounded-lg border border-line bg-surface px-3 text-ink">{accounts.filter((account) => account.active).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><button className="tap mt-4 w-full rounded-lg bg-accent font-extrabold text-white">ثبت قطعی</button></form></div>}
  </section>;
}

function ReconciliationPanel({ accounts = [], categories = [], notify, refresh }) {
  const eligibleAccounts = accounts.filter((account) => account.active && ['cash', 'bank', 'wallet'].includes(account.kind));
  const [imports, setImports] = useState([]);
  const [detail, setDetail] = useState(null);
  const [file, setFile] = useState(null);
  const [accountId, setAccountId] = useState(eligibleAccounts[0]?.id || 'cash');
  const [lineCategories, setLineCategories] = useState({});
  const [busy, setBusy] = useState(false);
  const loadImports = useCallback(async () => { const result = await api.reconciliationImports(); setImports(result.items); return result.items; }, []);
  useEffect(() => { loadImports().catch((error) => notify(error.message)); }, [loadImports, notify]);
  const open = async (id) => { setBusy(true); try { const result = await api.reconciliationImport(id); setDetail(result.item); } catch (error) { notify(error.message); } finally { setBusy(false); } };
  const upload = async (event) => { event.preventDefault(); if (!file) return notify('فایل CSV را انتخاب کن.'); setBusy(true); try { const result = await api.importBankStatement(file, accountId); setDetail(result.item); setFile(null); await loadImports(); notify('صورت‌حساب وارد شد؛ پیشنهادها را بررسی کن.'); } catch (error) { notify(error.message); } finally { setBusy(false); } };
  const applyResult = async (promise, message) => { setBusy(true); try { const result = await promise; setDetail(result.item); await loadImports(); refresh(); notify(message); } catch (error) { notify(error.message); } finally { setBusy(false); } };
  const match = (lineId, transactionId) => applyResult(api.matchReconciliationLine(lineId, transactionId), 'ردیف با تراکنش موجود تطبیق شد.');
  const create = (line) => { const fallback = line.direction === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها'; return applyResult(api.createFromReconciliationLine(line.id, lineCategories[line.id] || fallback), 'تراکنش ساخته و ردیف تطبیق شد.'); };
  const ignore = (line) => { const reason = window.prompt('چرا این ردیف نباید وارد دفتر شود؟ (حداقل ۵ نویسه)'); if (reason) applyResult(api.ignoreReconciliationLine(line.id, reason), 'ردیف با دلیل ثبت‌شده کنار گذاشته شد.'); };
  const close = () => applyResult(api.closeReconciliation(detail.id), 'تطبیق این دوره بسته شد.');
  const statusLabels = { unmatched: 'نیازمند بررسی', matched: 'تطبیق‌شده', ignored: 'کنارگذاشته‌شده' };
  return <section className="mt-5 space-y-6">
    <div className="rounded-[10px] border border-line bg-surface p-4"><div className="flex items-start gap-3"><Landmark className="mt-1 shrink-0 text-accent" /><div><h2 className="font-extrabold">ورود صورت‌حساب بانک یا صندوق</h2><p className="mt-1 text-xs leading-6 text-muted">فایل CSV را از اینترنت‌بانک بگیر. ستون‌های تاریخ و مبلغ الزامی‌اند؛ «شرح، واریز، برداشت، مانده و شماره پیگیری» هم شناخته می‌شوند. تاریخ میلادی یا هجری شمسی و اعداد فارسی پشتیبانی می‌شود. <a href="/bank-statement-template.csv" download className="font-bold text-accent underline">دانلود فایل نمونه</a></p></div></div><form onSubmit={upload} className="mt-4 grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)_150px]"><select value={accountId} onChange={(event) => setAccountId(event.target.value)} className="tap rounded-lg border border-line bg-paper px-3">{eligibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select><label className="flex min-h-12 cursor-pointer items-center rounded-lg border border-dashed border-muted/60 bg-paper px-3 text-sm"><input type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] || null)} className="sr-only" /><span className="truncate">{file?.name || 'انتخاب فایل CSV'}</span></label><button disabled={busy || !eligibleAccounts.length} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">ورود و بررسی</button></form><p className="mt-2 text-[11px] text-muted">فایل فقط در دفتر خودت پردازش می‌شود و برای هوش مصنوعی ارسال نمی‌شود. ورود دوبارهٔ همان فایل مسدود است.</p></div>
    {imports.length > 0 && <div><div className="mb-2 flex items-center justify-between"><h2 className="font-extrabold">دوره‌های واردشده</h2><span className="text-xs text-muted">{toPersianDigits(imports.length)} فایل</span></div><div className="scrollbar-none flex gap-2 overflow-x-auto pb-1">{imports.map((item) => <button key={item.id} onClick={() => open(item.id)} className={`min-w-[210px] rounded-[10px] border p-3 text-right ${detail?.id === item.id ? 'border-accent bg-warn-bg' : 'border-line bg-surface'}`}><span className="block truncate text-sm font-bold">{item.accountName}</span><span className="mt-1 block truncate text-xs text-muted">{item.fileName}</span><span className="numbers mt-2 block text-xs">{toPersianDigits(item.matchedCount + item.ignoredCount)} از {toPersianDigits(item.rowCount)} بررسی‌شده</span></button>)}</div></div>}
    {detail && <div className="space-y-4"><div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">ردیف‌ها</p><b className="numbers mt-2 block text-lg">{toPersianDigits(detail.rowCount)}</b></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">باقی‌مانده</p><b className={`numbers mt-2 block text-lg ${detail.unmatchedCount ? 'text-expense' : 'text-income'}`}>{toPersianDigits(detail.unmatchedCount)}</b></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">مانده بانک</p><b className="numbers mt-2 block text-lg">{detail.statementBalance == null ? '—' : formatAmount(detail.statementBalance)}</b></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">اختلاف با دفتر</p><b className={`numbers mt-2 block text-lg ${detail.difference === 0 ? 'text-income' : detail.difference == null ? '' : 'text-expense'}`}>{detail.difference == null ? 'نامشخص' : formatAmount(detail.difference)}</b></div></div><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-extrabold">بررسی ردیف‌های {detail.accountName}</h2><p className="mt-1 text-xs text-muted">{new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(detail.periodStart))} تا {new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(detail.periodEnd))}</p></div>{detail.status === 'open' ? <button disabled={busy || detail.unmatchedCount > 0 || (detail.difference != null && detail.difference !== 0)} onClick={close} className="tap rounded-lg bg-ink px-4 text-sm font-bold text-white disabled:opacity-35">بستن تطبیق</button> : <span className="rounded-lg border border-income px-3 py-2 text-xs font-bold text-income"><Check size={16} className="ml-1 inline" />تطبیق بسته شده</span>}</div><div className="divide-y divide-line border-y border-line">{detail.lines.map((line) => <article key={line.id} className="py-4"><div className="flex items-start gap-3"><div className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${line.status === 'matched' ? 'bg-income' : line.status === 'ignored' ? 'bg-muted' : 'bg-accent'}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-bold">{line.description || 'بدون شرح بانکی'}</p><p className="mt-1 text-xs text-muted">{new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(line.occurredAt))}{line.reference ? ` · پیگیری ${line.reference}` : ''}</p></div><div className="text-left"><b className={`numbers block ${line.direction === 'income' ? 'text-income' : 'text-expense'}`}>{line.direction === 'income' ? '+' : '−'} {formatAmount(line.amount)}</b><span className="mt-1 block text-[10px] text-muted">{statusLabels[line.status]}</span></div></div>{line.status === 'unmatched' && detail.status === 'open' && <div className="mt-3 rounded-lg bg-paper p-3">{line.candidates.length > 0 && <div><p className="text-xs font-bold text-muted">پیشنهادهای هم‌مبلغ و نزدیک به تاریخ</p><div className="mt-2 flex flex-wrap gap-2">{line.candidates.map((candidate) => <button disabled={busy} key={candidate.id} onClick={() => match(line.id, candidate.id)} className="tap rounded-lg border border-income bg-surface px-3 text-right text-xs"><b className="text-income">تطبیق {toPersianDigits(candidate.score)}٪</b><span className="mr-2 text-muted">{candidate.category} · {new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(candidate.occurredAt))}</span></button>)}</div></div>}<div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_110px]"><select value={lineCategories[line.id] || (line.direction === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها')} onChange={(event) => setLineCategories({ ...lineCategories, [line.id]: event.target.value })} className="tap min-w-0 rounded-lg border border-line bg-surface px-3 text-sm">{categories.filter((category) => category.type === line.direction).map((category) => <option key={category.id}>{category.name}</option>)}</select><button disabled={busy} onClick={() => create(line)} className="tap rounded-lg bg-accent px-3 text-xs font-bold text-white">ثبت جدید در دفتر</button><button disabled={busy} onClick={() => ignore(line)} className="tap rounded-lg border border-line px-3 text-xs font-bold text-muted">کنارگذاری</button></div></div>}{line.resolutionNote && <p className="mt-2 text-[11px] text-muted">{line.resolutionNote}</p>}</div></div></article>)}</div></div>}
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
  return <section className="mt-5 space-y-5"><p className="text-sm leading-7 text-muted">حقوق، اجاره، قسط و درآمدهای ثابت را یک‌بار تعریف کن؛ در سررسید خودکار وارد دفتر می‌شوند.</p><form onSubmit={save} className="grid gap-2 rounded-[10px] border border-line bg-surface p-3 sm:grid-cols-2"><input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="مثلاً اجاره مغازه" className="tap rounded-lg border border-line px-3" /><input required inputMode="numeric" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/\D/g, '') })} placeholder="مبلغ تومان" className="tap numbers rounded-lg border border-line px-3" /><select value={draft.type} onChange={(event) => { const type = event.target.value; setDraft({ ...draft, type, category: categories.find((item) => item.type === type)?.name || '' }); }} className="tap rounded-lg border border-line px-3"><option value="expense">هزینه</option><option value="income">درآمد</option></select><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="tap rounded-lg border border-line px-3">{categories.filter((item) => item.type === draft.type).map((item) => <option key={item.id}>{item.name}</option>)}</select><label className="flex items-center gap-2 text-xs text-muted">روز ماه<input type="number" min="1" max="31" value={draft.dayOfMonth} onChange={(event) => setDraft({ ...draft, dayOfMonth: event.target.value })} className="tap numbers w-20 rounded-lg border border-line px-2" /></label><button className="tap rounded-lg bg-accent font-bold text-white">فعال‌سازی</button></form><div className="divide-y divide-line border-y border-line">{items.map((item) => <article key={item.id} className="flex min-h-[72px] items-center gap-3 py-3"><RotateCcw size={19} className="text-muted" /><div className="min-w-0 flex-1"><p className="font-bold">{item.title}</p><p className="mt-1 text-xs text-muted">روز {toPersianDigits(item.dayOfMonth)} هر ماه · {item.category}</p></div><b className={`numbers text-sm ${item.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatAmount(item.amount)}</b><button onClick={() => remove(item.id)} className="tap grid place-items-center text-expense"><Trash2 size={17} /></button></article>)}</div></section>;
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
    <div className="grid grid-cols-3 gap-2"><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">ارزش موجودی</p><b className="numbers mt-2 block text-base sm:text-lg">{formatAmount(data.summary.inventoryValue || 0)}</b><span className="text-[10px] text-muted">تومان</span></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">بهای فروش ۳۰ روز</p><b className="numbers mt-2 block text-base text-expense sm:text-lg">{formatAmount(data.summary.cogs30 || 0)}</b><span className="text-[10px] text-muted">تومان</span></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">نیاز به تأمین</p><b className="numbers mt-2 block text-base sm:text-lg">{toPersianDigits(data.summary.lowStockCount || 0)}</b><span className="text-[10px] text-muted">کالا</span></div></div>
    <form onSubmit={save} className="grid gap-2 rounded-[10px] border border-line bg-surface p-4 sm:grid-cols-2"><div className="sm:col-span-2"><h3 className="font-extrabold">تعریف کالا</h3><p className="mt-1 text-xs text-muted">برای موجودی اولیه، تعداد و بهای خرید هر واحد را وارد کن.</p></div><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="نام کالا" className="tap rounded-lg border border-line px-3" /><input value={draft.unit} onChange={(event) => setDraft({ ...draft, unit: event.target.value })} placeholder="واحد؛ مثلاً عدد یا کیلو" className="tap rounded-lg border border-line px-3" /><input inputMode="decimal" value={draft.stock} onChange={(event) => setDraft({ ...draft, stock: event.target.value })} placeholder="موجودی اولیه" className="tap numbers rounded-lg border border-line px-3" /><input inputMode="numeric" value={draft.buyPrice} onChange={(event) => setDraft({ ...draft, buyPrice: event.target.value.replace(/\D/g, '') })} placeholder="بهای خرید هر واحد" className="tap numbers rounded-lg border border-line px-3" /><input inputMode="numeric" value={draft.salePrice} onChange={(event) => setDraft({ ...draft, salePrice: event.target.value.replace(/\D/g, '') })} placeholder="قیمت فروش پیشنهادی" className="tap numbers rounded-lg border border-line px-3" /><input inputMode="decimal" value={draft.lowThreshold} onChange={(event) => setDraft({ ...draft, lowThreshold: event.target.value })} placeholder="حد هشدار کمبود" className="tap numbers rounded-lg border border-line px-3" /><button className="tap rounded-lg bg-accent font-bold text-white sm:col-span-2">ثبت کالا و مانده افتتاحیه</button></form>
    <div><div className="mb-2 flex items-center justify-between"><h3 className="font-extrabold">کالاها</h3><span className="text-xs text-muted">{toPersianDigits(data.products.length)} قلم</span></div><div className="divide-y divide-line border-y border-line">{data.products.length ? data.products.map((item) => <article key={item.id} className={`grid min-h-[94px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3 ${item.isLow ? 'bg-warn-bg/60' : ''}`}><PackageSearch className={item.isLow ? 'text-expense' : 'text-muted'} /><div className="min-w-0"><p className="font-bold">{item.name}</p><p className="mt-1 text-xs text-muted">میانگین خرید {formatAmount(item.averageCost || 0)} · ارزش {formatAmount(item.inventoryValue || 0)} تومان</p><p className={`mt-1 text-[11px] ${item.isLow ? 'font-bold text-expense' : 'text-muted'}`}>{item.isLow ? 'موجودی به حد تأمین رسیده' : `فروش پیشنهادی ${formatAmount(item.salePrice || 0)} تومان`}</p></div><div className="text-left"><b className="numbers block">{toPersianDigits(item.stock)} {item.unit}</b><div className="mt-2 flex gap-1"><button onClick={() => adjust(item, 1)} className="tap grid place-items-center rounded-lg border border-income text-income" aria-label="افزایش موجودی"><Plus size={17} /></button><button onClick={() => adjust(item, -1)} className="tap grid place-items-center rounded-lg border border-expense text-expense" aria-label="کاهش موجودی">−</button></div></div></article>) : <p className="py-10 text-center text-sm text-muted">هنوز کالایی تعریف نشده است.</p>}</div></div>
    {data.movements.length > 0 && <div><h3 className="mb-2 font-extrabold">آخرین گردش‌ها</h3><div className="divide-y divide-line border-y border-line">{data.movements.slice(0, 12).map((movement) => <article key={movement.id} className="flex min-h-[68px] items-center gap-3 py-3"><div className={`h-2.5 w-2.5 rounded-full ${movement.quantity > 0 ? 'bg-income' : 'bg-expense'}`} /><div className="min-w-0 flex-1"><p className="text-sm font-bold">{movement.productName}</p><p className="mt-1 truncate text-xs text-muted">{movementLabels[movement.movementType] || 'گردش'} · {movement.note || new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(movement.occurredAt))}</p></div><div className="text-left"><b className={`numbers block text-sm ${movement.quantity > 0 ? 'text-income' : 'text-expense'}`}>{movement.quantity > 0 ? '+' : '−'}{toPersianDigits(Math.abs(movement.quantity))}</b><span className="numbers mt-1 block text-[10px] text-muted">{formatAmount(Math.abs(movement.valueDelta))} تومان</span></div></article>)}</div></div>}
  </section>;
}

function ToolsPanel({ profileType = 'business', notify }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [countedCash, setCountedCash] = useState('');
  const [closing, setClosing] = useState(null);
  const [receiptFile, setReceiptFile] = useState(null);
  const [receiptNote, setReceiptNote] = useState('');
  const [receipts, setReceipts] = useState([]);
  useEffect(() => { api.receipts().then((result) => setReceipts(result.items)).catch(() => {}); }, []);
  const ask = async (event) => { event.preventDefault(); if (!question.trim()) return; setAnswer(await api.ask(question)); };
  const close = async (event) => { event.preventDefault(); const result = await api.closeDay({ countedCash }); setClosing(result.item); notify('بستن صندوق ذخیره شد.'); };
  const saveReceipt = async (event) => { event.preventDefault(); if (!receiptFile) return; const result = await api.saveReceipt(receiptFile, receiptNote); setReceiptFile(null); setReceiptNote(''); const list = await api.receipts(); setReceipts(list.items); notify(result.suggestion ? 'رسید ذخیره شد و مبلغ پیشنهادی از توضیح پیدا شد.' : 'تصویر رسید ذخیره شد.'); };
  return <section className="mt-5 space-y-6"><div className="rounded-[10px] border border-line bg-surface p-4"><div className="flex items-center gap-2"><Sparkles size={19} className="text-accent" /><h2 className="font-extrabold">از دفترت بپرس</h2></div><p className="mt-2 text-xs leading-6 text-muted">پاسخ فقط از داده‌های ثبت‌شده ساخته می‌شود؛ هیچ عددی حدس زده نمی‌شود.</p><form onSubmit={ask} className="mt-3 flex gap-2"><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="مثلاً بیشترین هزینه‌ام چی بوده؟" className="tap min-w-0 flex-1 rounded-lg border border-line px-3" /><button className="tap rounded-lg bg-ink px-4 font-bold text-white">بپرس</button></form>{answer && <div className="mt-3 rounded-lg bg-warn-bg p-3 text-sm leading-7">{answer.answer}</div>}</div><form onSubmit={saveReceipt} className="rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">عکس رسید</h2><p className="mt-2 text-xs leading-6 text-muted">عکس را نگه دار و در توضیح بنویس «هشتصد هزار تومان مواد خریدم» تا مبلغ پیشنهادی آماده شود.</p><input required type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setReceiptFile(event.target.files?.[0] || null)} className="mt-3 block w-full text-xs" /><input value={receiptNote} onChange={(event) => setReceiptNote(event.target.value)} placeholder="توضیح مالی رسید" className="tap mt-3 w-full rounded-lg border border-line px-3" /><button className="tap mt-3 w-full rounded-lg border border-accent font-bold text-accent">ذخیره رسید</button>{receipts.length > 0 && <div className="scrollbar-none mt-3 flex gap-2 overflow-x-auto">{receipts.slice(0, 8).map((item) => <a key={item.id} href={api.workspacePath(`/api/receipts/${item.id}/image`)} target="_blank" rel="noreferrer" className="shrink-0 rounded-lg border border-line px-3 py-2 text-xs">{item.amount ? `${formatAmount(item.amount)} تومان` : item.fileName}</a>)}</div>}</form>{profileType === 'business' && <form onSubmit={close} className="rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">بستن صندوق امروز</h2><p className="mt-2 text-xs leading-6 text-muted">پول واقعی صندوق را وارد کن تا اختلافش با ثبت‌های امروز مشخص شود.</p><div className="mt-3 flex gap-2"><input required inputMode="numeric" value={countedCash} onChange={(event) => setCountedCash(event.target.value.replace(/\D/g, ''))} placeholder="موجودی شمارش‌شده" className="tap numbers min-w-0 flex-1 rounded-lg border border-line px-3" /><button className="tap rounded-lg bg-accent px-4 font-bold text-white">محاسبه</button></div>{closing && <p className={`numbers mt-3 rounded-lg px-3 py-2 text-sm font-bold ${closing.difference === 0 ? 'bg-income/10 text-income' : 'bg-warn-bg text-expense'}`}>اختلاف: {formatAmount(closing.difference)} تومان</p>}</form>}<div className="rounded-[10px] border border-line bg-surface p-4"><p className="text-sm font-bold">محدوده فعلی حساب‌یار</p><p className="mt-2 text-xs leading-6 text-muted">{PRODUCT_POSITIONING.accountingDisclaimer}</p></div></section>;
}

function BottomNav({ screen, navigate }) {
  const items = [{ id: 'today', label: 'امروز', icon: Home }, { id: 'ledger', label: 'دفتر', icon: WalletCards }, { id: 'report', label: 'گزارش', icon: BarChart3 }];
  return <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto flex h-[76px] max-w-[640px] items-start justify-around border-t border-line bg-surface px-3 pb-[env(safe-area-inset-bottom)] pt-2 lg:hidden">{items.map((item) => { const Icon = item.icon; const active = screen === item.id; return <button key={item.id} onClick={() => navigate(item.id)} className={`tap flex min-w-20 flex-col items-center justify-center gap-1 rounded-lg text-[12px] font-bold ${active ? 'text-accent' : 'text-muted'}`}><Icon size={21} strokeWidth={active ? 2.6 : 2} />{item.label}</button>; })}</nav>;
}

function Drawer({ profileType = 'business', close, navigate }) {
  const profile = profileDefinition(profileType);
  return <div className="fixed inset-0 z-[60] bg-ink/35 lg:hidden" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <aside className="sheet-in h-full w-[82%] max-w-[330px] bg-paper px-4 py-5 shadow-2xl">
      <div className="flex items-center justify-between"><div><p className="text-xl font-extrabold">حساب‌یار</p><p className="text-xs text-muted">{profile.label} · دستیار نقدینگی</p></div><button onClick={close} className="tap grid place-items-center" aria-label="بستن"><X /></button></div>
      <div className="mt-8 space-y-2">
        <DrawerItem icon={Home} label="امروز" onClick={() => navigate('today')} />
        <DrawerItem icon={WalletCards} label="دفتر مالی" onClick={() => navigate('ledger')} />
        <DrawerItem icon={BarChart3} label="گزارش" onClick={() => navigate('report')} />
        {profileType === 'business' && <DrawerItem icon={BookOpenCheck} label="دفتر کل و حسابداری" onClick={() => navigate('accounting')} />}
        {profileType === 'business' && <DrawerItem icon={HandCoins} label="مالیات و ارزش افزوده" onClick={() => navigate('tax')} />}
        <DrawerItem icon={BookOpenCheck} label="آنچه یاد گرفته‌ام" onClick={() => navigate('learning')} />
        <DrawerItem icon={Settings} label="تنظیمات" onClick={() => navigate('settings')} />
      </div>
      <div className="absolute bottom-6 right-4 left-4 border-t border-line pt-4 text-xs leading-6 text-muted">هیچ مبلغی بدون تأیید تو ثبت نمی‌شود.</div>
    </aside>
  </div>;
}

function DrawerItem({ icon: Icon, label, onClick }) { return <button onClick={onClick} className="tap flex w-full items-center gap-3 rounded-lg px-3 text-right font-bold hover:bg-surface"><Icon size={20} className="text-muted" />{label}</button>; }
