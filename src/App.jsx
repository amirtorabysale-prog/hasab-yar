import { Check, RotateCcw, WifiOff } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { AccountingPage } from './features/accounting/AccountingPage.jsx';
import { AccountsPanel, BackupPanel, DataPrivacyPanel, LogoutPanel, PasswordPanel, SessionsPanel, SettingsPage } from './features/settings/SettingsPage.jsx';
import { BottomNav, DesktopNav, Drawer, InsightRail, allowedScreens } from './app/navigation.jsx';
import { ChartPage } from './features/chart/ChartPage.jsx';
import { CloseDaySheet, TodayPage } from './features/today/TodayPage.jsx';
import { CollaborationPage } from './features/collaboration/CollaborationPage.jsx';
import { ConfirmationSheet, CorrectionSheet, DecisionDetailsSheet, DuplicateSheet, FailureSheet, LearningSuggestionSheet } from './features/capture/CaptureSheets.jsx';
import CounterpartyMatchSheet from './features/counterparty/CounterpartyMatchSheet.jsx';
import ExportAccessCard from './features/settings/ExportAccessCard.jsx';
import { EMPTY_SUMMARY } from './components/common.jsx';
import { FirmConsolePage } from './features/firm/FirmConsolePage.jsx';
import { IntentSheet, SettleSheet } from './features/capture/IntentSheets.jsx';
import { LearningPage } from './features/learning/LearningPage.jsx';
import { LedgerPage } from './features/ledger/LedgerPage.jsx';
import { LoginPage, Onboarding } from './features/auth/AuthScreens.jsx';
import { ReportPage } from './features/reports/ReportPage.jsx';
import { ReviewQueuePage } from './features/review/ReviewQueuePage.jsx';
import { TaxPage } from './features/tax/TaxPage.jsx';
import { api, flushTransactionQueue, queueTransactions } from './lib/api.js';
import { applyDnaSignals } from '../shared/dnaSignals.js';
import { assessAudioCapture, createWavRecorder } from './lib/wavRecorder.js';
import { browserRecognitionCanRestart, createPersianRecognizer, liveSpeechErrorMessage, liveSpeechSupported, mergeSpeechSegments } from './lib/liveSpeech.js';
import { capitalEntryPayload, detectVoiceIntent, invoiceDraftPayload } from '../shared/voiceIntent.js';
import { countOfflineAudio, failOfflineAudio, markOfflineAudioForReview, pendingAudio, releaseOfflineAudio, removeOfflineAudio, saveOfflineAudio } from './lib/offlineAudio.js';
import { createRealtimeTranscriber, realtimeSpeechAvailable, rememberRealtimeFailure } from './lib/realtimeSpeech.js';
import { decideVoiceRoute } from './lib/voiceDecision.js';
import { detectSettleIntent } from '../shared/settleSpeech.js';
import { inferLearningKeyword, parseFinancialText, parseRecognitionCandidates } from '../shared/parser.js';
import { isCorrectionCommand, previewCorrection } from '../shared/correction.js';
import { isNetworkQueueError, isPermanentQueueError } from './lib/offlineScope.js';
import { realtimeWorthTrying } from './lib/voiceStatus.js';
import { selectVoiceSnapshot } from './lib/voiceArbitration.js';
import { toPersianDigits } from './lib/format.js';
import { withCounterpartyConfirmation } from './lib/counterpartyPrompt.js';

const WorkspacePanel = lazy(() => import('./features/settings/WorkspacePanel.jsx'));

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

/**
 * دسترسی کامل از پاسخ سرور.
 *
 * سرور در ورود، وضعیت نشست و فهرست دفترها همیشه `screens` و `experience` را
 * هم می‌فرستد. پیش از این چهار جا فقط سه فیلد را برمی‌داشتند و بقیه را دور
 * می‌ریختند؛ نتیجه‌اش این بود که پس از ورود یا تغییر نقش، ناوبری از روی
 * فهرست خالی ساخته می‌شد و صفحه‌هایی مثل «همکاری حسابدار» — که خروجی پارسیان
 * آنجاست — تا بارگذاری کامل بعدی دیده نمی‌شدند.
 */
function accessFromPayload(result = {}) {
  return {
    user: result.user || null,
    workspaces: result.workspaces || [],
    workspace: result.workspace || null,
    experience: result.experience || result.workspace?.experience || 'simple',
    screens: Array.isArray(result.screens) ? result.screens : [],
  };
}

export default function App() {
  const online = useOnlineStatus();
  const [authenticated, setAuthenticated] = useState(null);
  const [authError, setAuthError] = useState('');
  const [access, setAccess] = useState({ user: null, workspaces: [], workspace: null });
  const [screen, setScreen] = useState('today');
  const [ledgerTab, setLedgerTab] = useState('transactions');
  const [drawer, setDrawer] = useState(false);
  const [data, setData] = useState({ transactions: [], summary: EMPTY_SUMMARY, categories: [], accounts: [], settings: {}, learnings: [], averages: {}, dnaProfiles: null, overview: {}, contacts: [], obligations: [], recurring: [], closings: [], closingPreview: null });
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [manualText, setManualText] = useState('');
  const [parseResult, setParseResult] = useState(null);
  const [failure, setFailure] = useState(null);
  const [pendingAudioCount, setPendingAudioCount] = useState(0);
  const [closeDayOpen, setCloseDayOpen] = useState(false);
  const [undoSave, setUndoSave] = useState(null);
  const [redoSave, setRedoSave] = useState(null);
  const [undoing, setUndoing] = useState(false);
  const [correctionDraft, setCorrectionDraft] = useState(null);
  const [duplicatePrompt, setDuplicatePrompt] = useState(null);
  const [learningSuggestion, setLearningSuggestion] = useState(null);
  const [selectedDecision, setSelectedDecision] = useState(null);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [recordState, setRecordState] = useState('idle');
  const [voicePath, setVoicePath] = useState('ready');
  const [voiceSystemStatus, setVoiceSystemStatus] = useState(null);
  const [intentDraft, setIntentDraft] = useState(null);
  const [settleDraft, setSettleDraft] = useState(null);
  // startRecording یک closure است و مقدار state در آن کهنه می‌ماند؛ تصمیمِ
  // «نشست Realtime باز شود یا نه» باید تازه‌ترین وضعیت سرور را ببیند.
  const voiceSystemStatusRef = useRef(null);
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
  const realtimeSpeechRef = useRef(null);
  const speechSnapshotRef = useRef({ transcript: '', candidates: [], error: null, source: '' });
  const browserSpeechSnapshotRef = useRef({ transcript: '', finalTranscript: '', candidates: [], error: null, ended: false, source: 'browser-live' });
  // متن نشست‌های پیشین تشخیص Chrome؛ نشست تازه results خالی دارد.
  const carriedTranscriptRef = useRef('');
  const segmentFinalRef = useRef('');
  const realtimeSpeechSnapshotRef = useRef({ transcript: '', finalTranscript: '', candidates: [], error: null, ended: false, source: 'openai-realtime' });
  const firstTranscriptMsRef = useRef(0);
  const maxRecordingTimerRef = useRef(null);
  const finalizeTimerRef = useRef(null);
  const pendingAudioBlobRef = useRef(null);
  const fastFinalizeDoneRef = useRef(false);
  const voiceAttemptRef = useRef('');
  const fastVoiceAvailable = realtimeSpeechAvailable() || liveSpeechSupported();
  const rememberedOfflineScope = api.offlineScope();
  const offlineUserId = access.user?.id || rememberedOfflineScope?.userId || '';
  const offlineWorkspaceId = access.workspace?.id || rememberedOfflineScope?.workspaceId || '';
  const offlineScopeReady = Boolean(offlineUserId && offlineWorkspaceId);
  const activeOfflineScope = () => ({ userId: offlineUserId, workspaceId: offlineWorkspaceId });

  const notify = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3200);
  }, []);

  const refreshVoiceSystemStatus = useCallback(async () => {
    try {
      const status = await api.voiceStatus();
      voiceSystemStatusRef.current = status;
      setVoiceSystemStatus(status);
      return status;
    } catch { return null; }
  }, []);

  /**
   * دفتر اول می‌آید، تحلیل‌ها بعدش.
   *
   * `financialOverview` و `dnaProfiles` روی سرور ۹۹٪ زمان `bootstrap` را
   * می‌گرفتند و با بزرگ‌شدن دفتر بدتر می‌شوند. حالا در درخواست دوم می‌آیند و
   * تا رسیدنشان همان مقدار قبلی روی صفحه می‌ماند — نه یک پرش به حالت خالی.
   *
   * نتیجهٔ دیررس اگر دفتر عوض شده باشد دور ریخته می‌شود؛ وگرنه هشدار مالی یک
   * دفتر می‌توانست روی دفتر دیگری بنشیند.
   */
  const load = useCallback(async () => {
    try {
      const [bootstrap] = await Promise.all([api.bootstrap(), refreshVoiceSystemStatus()]);
      setData((previous) => ({ ...previous, ...bootstrap, learnings: bootstrap.learnings || [], averages: bootstrap.averages || {} }));
      if (bootstrap.access) setAccess(bootstrap.access);
      // دفتر فعال بعد از پاسخ خوانده می‌شود، نه قبلش: در اولین بارگذاری هنوز
      // چیزی در حافظهٔ محلی نیست و پاسخ خودِ سرور آن را می‌نشاند. خواندن زودتر
      // یعنی مقایسهٔ پایین همیشه شکست بخورد و تحلیلِ درست دور ریخته شود.
      const loadedWorkspace = api.activeWorkspaceId();
      api.insights()
        .then((insights) => setData((previous) => (
          api.activeWorkspaceId() === loadedWorkspace ? { ...previous, ...insights } : previous
        )))
        .catch(() => { /* تحلیل مکمل است؛ نبودش دفتر را از کار نمی‌اندازد */ });
      return bootstrap;
    } catch (error) {
      notify(error.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [notify, refreshVoiceSystemStatus]);

  useEffect(() => {
    const requireAuth = () => { localStorage.removeItem('hesab-yar-authenticated'); api.clearOfflineSession(); setAuthenticated(false); };
    window.addEventListener('hesabyar:auth-required', requireAuth);
    if (!navigator.onLine && localStorage.getItem('hesab-yar-authenticated') === '1') setAuthenticated(true);
    else api.authStatus().then((result) => { setAuthenticated(result.authenticated); if (result.authenticated) setAccess(accessFromPayload(result)); }).catch((error) => { setAuthError(error.message); setAuthenticated(false); });
    return () => window.removeEventListener('hesabyar:auth-required', requireAuth);
  }, []);

  useEffect(() => { if (authenticated && !access.user?.mustChangePassword) load(); }, [authenticated, access.user?.mustChangePassword, load]);

  useEffect(() => {
    if (!online || !authenticated || !offlineScopeReady || parseResult) return undefined;
    let active = true;
    const scope = { userId: offlineUserId, workspaceId: offlineWorkspaceId };
    (async () => {
      const syncResult = await flushTransactionQueue(scope).catch(() => ({ synced: 0, failed: 0, pending: 0 }));
      const audios = await pendingAudio(scope).catch(() => []);
      if (active) setPendingAudioCount(await countOfflineAudio(scope).catch(() => 0));
      // فقط یک نتیجه در هر نوبت به کاربر نشان داده می‌شود، ولی قلم شکست‌خورده
      // نباید بقیهٔ صف را پشت خودش نگه دارد: تا امروز یک ضبط پردازش‌نشدنی
      // بی‌پایان تکرار می‌شد و همهٔ ضبط‌های بعدی هرگز نوبتشان نمی‌رسید.
      let giveUpCount = 0;
      for (const item of audios) {
        try {
          const result = await api.parseAudio(item.blob, { workspaceId: scope.workspaceId });
          if (!result.transactions?.length) {
            // متن شنیده شد ولی مبلغی نداشت؛ تکرارش هم همین نتیجه را می‌دهد.
            const outcome = await failOfflineAudio(item.id, scope, 'مبلغی در این صدا پیدا نشد.', { permanent: true });
            if (outcome?.exhausted) giveUpCount += 1;
            continue;
          }
          await markOfflineAudioForReview(item.id, scope);
          if (active) {
            setParseResult({ ...result, offlineAudioId: item.id });
            notify('صدای ذخیره‌شده پردازش شد؛ پس از تأیید ثبت می‌شود.');
          }
          break;
        } catch (error) {
          // سرور در دسترس نیست: نه تلاشی انجام شده که شمرده شود، نه فرستادن
          // بقیهٔ صف فایده‌ای دارد. `navigator.onLine` این حالت را نمی‌گیرد —
          // دستگاه اینترنت دارد و این سرور است که جواب نمی‌دهد — و چون شکست
          // شبکه هم یک تلاش حساب می‌شد، سه بار بازکردن برنامه روی میزبانی که
          // هنوز بیدار نشده بود کافی بود تا یک ضبط کاملاً سالم `failed` شود.
          if (isNetworkQueueError(error)) break;
          const outcome = await failOfflineAudio(item.id, scope, error?.message || 'خطای پردازش صوت', {
            permanent: isPermanentQueueError(error),
          }).catch(() => null);
          if (outcome?.exhausted) giveUpCount += 1;
          // خطای شبکه یعنی بقیهٔ صف هم همین حالا شکست می‌خورد؛ ادامه بی‌فایده است.
          if (!navigator.onLine) break;
        }
      }
      if (active && giveUpCount) {
        notify(`${toPersianDigits(giveUpCount)} صدای ذخیره‌شده پردازش نشد و از صف خارج شد؛ همان‌ها را دستی ثبت کن.`);
      }
      if (active && syncResult.synced) {
        notify(`${toPersianDigits(syncResult.synced)} ثبت آفلاین همگام شد.`);
        load();
      } else if (active && syncResult.failed) {
        notify(`${toPersianDigits(syncResult.failed)} ثبت آفلاین نیازمند بررسی است و خودکار تکرار نمی‌شود.`);
      }
    })();
    return () => { active = false; };
  }, [online, authenticated, offlineScopeReady, offlineUserId, offlineWorkspaceId, parseResult, load, notify]);

  useEffect(() => {
    if (!authenticated || !offlineScopeReady) { setPendingAudioCount(0); return undefined; }
    countOfflineAudio({ userId: offlineUserId, workspaceId: offlineWorkspaceId })
      .then(setPendingAudioCount).catch(() => setPendingAudioCount(0));
    return undefined;
  }, [authenticated, offlineScopeReady, offlineUserId, offlineWorkspaceId]);

  useEffect(() => {
    if (!undoSave) return undefined;
    const timer = window.setTimeout(() => setUndoSave(null), 9_000);
    return () => window.clearTimeout(timer);
  }, [undoSave]);

  useEffect(() => {
    if (!redoSave) return undefined;
    const timer = window.setTimeout(() => setRedoSave(null), 12_000);
    return () => window.clearTimeout(timer);
  }, [redoSave]);

  useEffect(() => () => {
    cancelAnimationFrame(animationRef.current);
    window.clearTimeout(maxRecordingTimerRef.current);
    window.clearTimeout(finalizeTimerRef.current);
    processingAbortRef.current?.abort('unmount');
    try { recognitionRef.current?.abort(); } catch { /* already stopped */ }
    realtimeSpeechRef.current?.abort();
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

  const openCorrection = useCallback(async (command) => {
    if (!online) {
      setFailure({ transcript: command, message: 'اصلاح آخرین ثبت برای اطمینان از انتخاب رکورد درست، به اتصال اینترنت نیاز دارد.' });
      return;
    }
    try {
      const result = await api.latestTransaction();
      if (!result.item) {
        setFailure({ transcript: command, message: 'هنوز تراکنشی وجود ندارد که اصلاحش کنم.' });
        return;
      }
      const preview = previewCorrection(command, result.item, { learnings: data.learnings, accounts: data.accounts, categories: data.categories });
      if (!preview.canApply) {
        setFailure({ transcript: command, message: `${preview.explanation} مثلاً بگو «نه، هفتصد و پنجاه هزار بود» یا «بزن هزینه پیک».` });
        return;
      }
      setCorrectionDraft({ command, current: result.item, preview });
    } catch (error) { notify(error.message); }
  }, [data.accounts, data.categories, data.learnings, notify, online]);

  const processAudio = async (blob, fallbackReason = '') => {
    if (!online) {
      setVoicePath('offline');
      try {
        await saveOfflineAudio(blob, activeOfflineScope());
        setPendingAudioCount((count) => count + 1);
        notify('ضبط برای همین کاربر و همین دفتر ذخیره شد و بعد از اتصال آمادهٔ تأیید می‌شود.');
      } catch (error) {
        setFailure({ transcript: '', message: error.message });
      }
      setRecordState('idle');
      return;
    }
    setRecordState('processing');
    setVoicePath('server-file');
    const controller = new AbortController();
    processingAbortRef.current = controller;
    // مسیر فایل ممکن است بعد از شکست OpenAI به Gemini برسد؛ مهلت کلاینت باید از مجموع مهلت providerها کوتاه‌تر نباشد.
    const timeout = window.setTimeout(() => controller.abort('timeout'), 22_000);
    const requestedAt = Date.now();
    try {
      const result = await api.parseAudio(blob, {
        signal: controller.signal,
        hint: speechSnapshotRef.current.transcript,
        fallbackReason,
        attemptId: voiceAttemptRef.current,
      });
      if (isCorrectionCommand(result.transcript)) await openCorrection(result.transcript);
      else if (routeIntent(result.transcript)) { /* نیت ساختاری، نه ثبت سادهٔ تراکنش */ }
      else if (!result.transactions?.length) setFailure({ transcript: result.transcript || 'متن صدا مشخص نشد.' });
      else setParseResult({ ...result, responseMs: Date.now() - requestedAt });
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason !== 'timeout') notify('پردازش صدا لغو شد.');
      else if (controller.signal.aborted || error.code === 'VOICE_TIMEOUT') setFailure({ transcript: speechSnapshotRef.current.transcript, message: 'بررسی پشتیبان بیش از حد طول کشید. دوباره کوتاه‌تر بگو یا دستی بنویس.' });
      else setFailure({ transcript: speechSnapshotRef.current.transcript, message: error.code === 'VOICE_UNAVAILABLE' ? 'پردازش صوت هنوز روی سرور فعال نشده است.' : error.message });
    } finally {
      window.clearTimeout(timeout);
      if (processingAbortRef.current === controller) processingAbortRef.current = null;
      refreshVoiceSystemStatus();
      setRecordState('idle');
      setVoicePath('ready');
    }
  };

  const cancelProcessing = () => {
    processingAbortRef.current?.abort('user');
    processingAbortRef.current = null;
    setRecordState('idle');
    setVoicePath('ready');
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
    const transcriptIsFinal = Boolean(snapshot.finalTranscript || snapshot.ended);
    const decision = decideVoiceRoute(result, { online, transcriptFinal: transcriptIsFinal });
    const canUseLocalReview = decision.route === 'local-review' && (transcriptIsFinal || deadlineReached);
    if (decision.route === 'local' || canUseLocalReview) {
      fastFinalizeDoneRef.current = true;
      pendingAudioBlobRef.current = null;
      window.clearTimeout(finalizeTimerRef.current);
      const reviewedResult = {
        ...result,
        engine: snapshot.source === 'openai-realtime' ? 'openai-realtime+deterministic-parser' : result.engine,
        qualityScore: decision.score,
        reviewReasons: decision.reasons,
        latencyMs: Date.now() - startedAtRef.current,
        responseMs: Date.now() - stoppedAtRef.current,
      };
      if (isCorrectionCommand(result.transcript)) void openCorrection(result.transcript);
      else if (routeIntent(result.transcript)) { /* نیت ساختاری، نه ثبت سادهٔ تراکنش */ }
      else setParseResult(reviewedResult);
      if (online) {
        api.recordVoiceMetric({
          provider: snapshot.source === 'openai-realtime' ? 'openai-realtime' : 'browser-live',
          durationMs: Math.max(0, stoppedAtRef.current - startedAtRef.current),
          firstTranscriptMs: firstTranscriptMsRef.current,
          latencyMs: Date.now() - stoppedAtRef.current,
          transactionCount: result.transactions.length,
          needsReview: decision.route === 'local-review' || result.transactions.some((item) => item.needsReview),
        }).catch(() => {});
      }
      setRecordState('idle');
      setVoicePath('ready');
      return true;
    }
    if (deadlineReached) {
      fastFinalizeDoneRef.current = true;
      const blob = pendingAudioBlobRef.current;
      pendingAudioBlobRef.current = null;
      if (!online) {
        setVoicePath('offline');
        saveOfflineAudio(blob, activeOfflineScope()).then(() => {
          setPendingAudioCount((count) => count + 1);
          setRecordState('idle');
          notify('صدا برای همین کاربر و همین دفتر ذخیره شد و پس از اتصال آماده می‌شود.');
        }).catch(() => {
          setRecordState('idle');
          setFailure({ transcript: snapshot.transcript, message: 'ذخیرهٔ آفلاین صدا انجام نشد؛ دوباره بگو یا دستی بنویس.' });
        });
      } else processAudio(blob, decision.reasons.join(','));
    }
    return false;
  };

  const publishSpeechSnapshot = (snapshot) => {
    speechSnapshotRef.current = snapshot;
    if (!firstTranscriptMsRef.current && snapshot.transcript && startedAtRef.current) {
      firstTranscriptMsRef.current = Date.now() - startedAtRef.current;
    }
    setLiveTranscript(snapshot.transcript);
    setLivePreview(parseFinancialText(snapshot.transcript, { learnings: data.learnings, averages: data.averages, source: 'voice' }).transactions);
    tryFinishFastResult(false);
  };

  const finishWithFastResult = (blob, { awaitingRealtime = false } = {}) => {
    setRecordState('finalizing');
    setVoicePath('finalizing');
    pendingAudioBlobRef.current = blob;
    fastFinalizeDoneRef.current = false;
    window.clearTimeout(finalizeTimerRef.current);
    if (tryFinishFastResult(false)) return;
    // اگر مرورگر حتی متن ناقص هم ندارد، مسیر WAV تقریباً فوری شروع می‌شود؛ فقط فرصت کوتاهی برای نتیجهٔ نهایی می‌دهیم.
    const hasUsefulLiveSignal = fastVoiceAvailable && speechSnapshotRef.current.transcript && !speechSnapshotRef.current.error;
    finalizeTimerRef.current = window.setTimeout(() => tryFinishFastResult(true), awaitingRealtime ? 1_650 : hasUsefulLiveSignal ? 450 : 160);
  };

  const stopRecordingNow = () => {
    window.clearTimeout(maxRecordingTimerRef.current);
    cancelAnimationFrame(animationRef.current);
    if (!stoppedAtRef.current) stoppedAtRef.current = Date.now();
    try { recognitionRef.current?.stop(); } catch { /* recognition may have ended after silence */ }
    recognitionRef.current = null;
    const realtime = realtimeSpeechRef.current;
    realtimeSpeechRef.current = null;
    const realtimeFinal = realtime?.finish().catch((error) => {
      rememberRealtimeFailure(error);
      const fallbackSnapshot = selectVoiceSnapshot({ browser: browserSpeechSnapshotRef.current, realtime: realtimeSpeechSnapshotRef.current, realtimeFailed: true });
      if (fallbackSnapshot.transcript) {
        publishSpeechSnapshot(fallbackSnapshot);
        setVoicePath('browser-live');
      }
      setLiveVoiceNote(liveSpeechErrorMessage(error.code));
      refreshVoiceSystemStatus();
      return null;
    });
    const capture = wavRecorderRef.current?.stop();
    wavRecorderRef.current = null;
    if (!capture) return;
    setRecordState('finalizing');
    setVoicePath('finalizing');
    cleanupMedia();
    const captureQuality = assessAudioCapture(capture);
    if (!captureQuality.valid) {
      setRecordState('idle');
      setVoicePath('ready');
      setFailure({ transcript: speechSnapshotRef.current.transcript, message: captureQuality.message });
      return;
    }
    finishWithFastResult(capture.blob, { awaitingRealtime: Boolean(realtimeFinal) });
    realtimeFinal?.then((snapshot) => {
      if (!snapshot?.transcript || fastFinalizeDoneRef.current) return;
      if (!snapshot.completed && browserSpeechSnapshotRef.current.transcript) {
        publishSpeechSnapshot(browserSpeechSnapshotRef.current);
        return;
      }
      const next = {
        transcript: snapshot.transcript,
        finalTranscript: snapshot.completed ? snapshot.transcript : '',
        candidates: [{ transcript: snapshot.transcript, confidence: 0 }],
        error: null,
        ended: snapshot.completed,
        source: 'openai-realtime',
      };
      realtimeSpeechSnapshotRef.current = next;
      publishSpeechSnapshot(next);
    });
  };

  const startRecording = async () => {
    if (recordState !== 'idle') return;
    setRecordState('requesting');
    setVoicePath('requesting');
    setLiveTranscript('');
    setLiveVoiceNote('');
    setLivePreview([]);
    pendingAudioBlobRef.current = null;
    // یک شناسه برای کل این ضبط: نشست realtime و بررسی فایل با همین شناسه
    // می‌روند تا سهمیه یک واحد کم کند، نه دو تا.
    voiceAttemptRef.current = crypto.randomUUID();
    fastFinalizeDoneRef.current = false;
    firstTranscriptMsRef.current = 0;
    speechSnapshotRef.current = { transcript: '', finalTranscript: '', candidates: [], error: null, ended: false, source: '' };
    browserSpeechSnapshotRef.current = { transcript: '', finalTranscript: '', candidates: [], error: null, ended: false, source: 'browser-live' };
    carriedTranscriptRef.current = '';
    segmentFinalRef.current = '';
    realtimeSpeechSnapshotRef.current = { transcript: '', finalTranscript: '', candidates: [], error: null, ended: false, source: 'openai-realtime' };
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
      setVoicePath('capturing');
      animateWave();
      let browserError = '';
      const startBrowserRecognizer = () => {
        if (recognitionRef.current || !liveSpeechSupported()) return;
        const recognizer = createPersianRecognizer({
          phrases: [...data.categories.map((item) => item.name), ...data.learnings.map((item) => item.keyword)],
          onUpdate: (rawSnapshot) => {
            browserError = '';
            segmentFinalRef.current = rawSnapshot.finalTranscript || '';
            const snapshot = mergeSpeechSegments(carriedTranscriptRef.current, rawSnapshot);
            const next = { ...snapshot, error: null, ended: false, source: 'browser-live' };
            browserSpeechSnapshotRef.current = next;
            if (speechSnapshotRef.current.source !== 'openai-realtime' || realtimeSpeechSnapshotRef.current.error) {
              publishSpeechSnapshot(next);
              setVoicePath('browser-live');
              if (!realtimeSpeechSnapshotRef.current.error) setLiveVoiceNote('');
            }
          },
          onError: (error) => {
            browserError = error;
            browserSpeechSnapshotRef.current = { ...browserSpeechSnapshotRef.current, error };
            if (speechSnapshotRef.current.source !== 'openai-realtime') {
              speechSnapshotRef.current = { ...browserSpeechSnapshotRef.current };
              setLiveVoiceNote(liveSpeechErrorMessage(error));
            }
          },
          onEnd: () => {
            if (recognitionRef.current === recognizer) recognitionRef.current = null;
            const restartable = browserRecognitionCanRestart(browserError);
            if (holdingRef.current && wavRecorderRef.current && restartable) {
              // آنچه در این نشست نهایی شد باید به نشست بعدی منتقل شود، وگرنه
              // نشست تازه با results خالی شروع می‌کند و متن قبلی پاک می‌شود.
              carriedTranscriptRef.current = [carriedTranscriptRef.current, segmentFinalRef.current].filter(Boolean).join(' ').trim();
              segmentFinalRef.current = '';
              window.setTimeout(() => {
                if (holdingRef.current && wavRecorderRef.current && !recognitionRef.current) startBrowserRecognizer();
              }, 90);
              return;
            }
            const next = { ...browserSpeechSnapshotRef.current, ended: true };
            browserSpeechSnapshotRef.current = next;
            if (speechSnapshotRef.current.source !== 'openai-realtime') publishSpeechSnapshot(next);
          },
        });
        recognitionRef.current = recognizer;
        try {
          recognizer?.start();
          if (speechSnapshotRef.current.source !== 'openai-realtime') setVoicePath('browser-live');
        } catch {
          recognitionRef.current = null;
          browserError = 'start-failed';
          browserSpeechSnapshotRef.current = { ...browserSpeechSnapshotRef.current, error: browserError };
          setLiveVoiceNote(liveSpeechErrorMessage('start-failed'));
        }
      };
      // Chrome must start listening immediately. Realtime connects in parallel and takes over only after its first delta.
      startBrowserRecognizer();
      if (realtimeWorthTrying(voiceSystemStatusRef.current, { browserReady: realtimeSpeechAvailable() })) {
        try {
          setVoicePath('realtime-connecting');
          let realtime;
          realtime = createRealtimeTranscriber({
            stream,
            createSession: (sdp) => api.createRealtimeTranscription(sdp, { attemptId: voiceAttemptRef.current }),
            onUpdate: (snapshot) => {
              if (realtimeSpeechRef.current !== realtime) return;
              const next = {
                transcript: snapshot.transcript,
                finalTranscript: snapshot.completed ? snapshot.transcript : '',
                candidates: [{ transcript: snapshot.transcript, confidence: 0 }],
                error: null,
                ended: snapshot.completed,
                source: 'openai-realtime',
              };
              realtimeSpeechSnapshotRef.current = next;
              publishSpeechSnapshot(next);
              setLiveVoiceNote('');
              setVoicePath('realtime-live');
            },
            onError: (error) => {
              if (realtimeSpeechRef.current !== realtime) return;
              rememberRealtimeFailure(error);
              realtimeSpeechSnapshotRef.current = { ...realtimeSpeechSnapshotRef.current, error };
              const fallbackSnapshot = selectVoiceSnapshot({ browser: browserSpeechSnapshotRef.current, realtime: realtimeSpeechSnapshotRef.current, realtimeFailed: true });
              speechSnapshotRef.current = fallbackSnapshot;
              if (fallbackSnapshot.transcript) publishSpeechSnapshot(fallbackSnapshot);
              setVoicePath(liveSpeechSupported() ? 'browser-live' : 'capturing');
              setLiveVoiceNote(liveSpeechErrorMessage(error.code));
              refreshVoiceSystemStatus();
            },
          });
          realtimeSpeechRef.current = realtime;
          realtime.ready.catch((error) => {
            rememberRealtimeFailure(error);
            if (realtimeSpeechRef.current === realtime) {
              realtimeSpeechRef.current = null;
              realtime.abort();
            }
          });
        } catch {
          setVoicePath(liveSpeechSupported() ? 'browser-live' : 'capturing');
        }
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
      setVoicePath('ready');
      setFailure({ permission: true, message: error.name === 'NotAllowedError' ? 'اجازهٔ میکروفن خاموش است.' : 'میکروفن در دسترس نیست.' });
    }
  };

  const stopRecording = () => {
    holdingRef.current = false;
    if (recordState !== 'recording' || !wavRecorderRef.current) return;
    stopRecordingNow();
  };

  const parseManual = async (event) => {
    event?.preventDefault();
    const text = manualText.trim();
    if (!text) return;
    if (isCorrectionCommand(text)) {
      setManualText('');
      await openCorrection(text);
      return;
    }
    if (routeIntent(text)) { setManualText(''); return; }
    // همان کنترلی که سرور روی مسیر صدا می‌زند؛ ثبت متنی محلی پارس می‌شود و نباید
    // از الگوی خودِ پرونده بی‌خبر بماند.
    const result = applyDnaSignals(parseFinancialText(text, { learnings: data.learnings, averages: data.averages, source: 'text' }), data.dnaProfiles);
    if (!result.transactions?.length) setFailure({ transcript: text });
    else { setParseResult({ ...result, engine: 'local-text', latencyMs: 0 }); setManualText(''); }
  };

  /**
   * گفته‌ای که طلب، بدهی، چک یا فاکتور است نباید به‌عنوان تراکنش ساده ثبت شود.
   * هیچ‌چیز خودکار ذخیره نمی‌شود؛ فقط کارت تأیید باز می‌شود.
   */
  const routeIntent = (transcript) => {
    if (!canWrite) return false;
    // تسویه پیش از ساخت سنجیده می‌شود: «طلب رضایی وصول شد» هم واژهٔ «طلب» دارد
    // هم فعل تسویه، و اگر اول مسیر ساخت برود یک طلب تازه می‌سازد به‌جای بستن
    // طلب موجود.
    const settle = detectSettleIntent(transcript);
    if (settle) { setSettleDraft(settle); return true; }
    const found = detectVoiceIntent(transcript);
    if (!found) return false;
    setIntentDraft(found);
    return true;
  };

  /** تسویهٔ سندی که کاربر روی کارت انتخاب کرده؛ هیچ سندی خودکار بسته نمی‌شود. */
  const applySettlement = async (target, { occurredAt = null } = {}) => {
    try {
      if (target.kind === 'invoice') {
        await api.recordInvoicePayment(target.id, { occurredAt: occurredAt || undefined });
      } else {
        await api.settleObligation(target.id, occurredAt ? { occurredAt } : {});
      }
      setSettleDraft(null);
      await load();
      notify(`${target.label} تسویه شد.`);
    } catch (error) { notify(error.message); }
  };

  const saveIntentDraft = async (draft) => {
    try {
      if (draft.intent === 'invoice') {
        const payload = invoiceDraftPayload(draft, { taxRateId: draft.taxRateId || null });
        if (!payload) return;
        const { item } = await withCounterpartyConfirmation((counterpartyResolution) => api.saveInvoice({ ...payload, documentType: draft.documentType, customerName: draft.contactName || '', counterpartyResolution }));
        setIntentDraft(null);
        await load();
        // پیام دقیقاً می‌گوید سند در چه وضعیتی است. «ثبت شد» خالی، کاربر را به
        // این باور می‌رساند که فاکتور صادر شده درحالی‌که ممکن است پیش‌نویس باشد.
        notify(payload.issueNow
          ? `فاکتور ${item.number} صادر شد؛ در دفتر کل سند خورد و در گزارش مالیاتی می‌آید.`
          : `پیش‌نویس ${item.number} ساخته شد؛ هر وقت خواستی از برگهٔ فاکتورها صادرش کن.`);
        return;
      }
      if (draft.intent === 'capital' || draft.intent === 'fixed-asset') {
        const payload = capitalEntryPayload(draft);
        if (!payload) return;
        await api.saveCapitalEntry({ ...payload, source: 'voice' });
        setIntentDraft(null);
        await load();
        notify(draft.intent === 'capital'
          ? 'آورده ثبت شد؛ در جمع درآمد ماه نمی‌آید و مستقیم به حساب سرمایه نشست.'
          : 'دارایی ثابت ثبت شد؛ هزینهٔ این ماه نشد و به بهای تمام‌شده در دارایی‌ها نشست.');
        return;
      }
      await api.saveObligation({
        title: draft.title, amount: draft.amount, direction: draft.direction,
        dueAt: draft.dueAt || null, occurredAt: draft.occurredAt || null,
        note: draft.transcript.slice(0, 300),
      });
      setIntentDraft(null);
      await load();
      notify(draft.direction === 'receivable' ? 'طلب ثبت شد.' : 'بدهی ثبت شد.');
    } catch (error) { notify(error.message); }
  };

  const queueLearningSuggestion = (transactions, transcript) => {
    const corrected = transactions.find((item) => item.originalCategory && item.originalCategory !== item.category);
    if (!corrected) return;
    const keyword = inferLearningKeyword(corrected.rawText || transcript);
    if (keyword.length >= 2) setLearningSuggestion({ keyword, category: corrected.category });
  };

  const finalizeOfflineAudio = async (offlineAudioId) => {
    if (!offlineAudioId || !offlineScopeReady) return;
    const scope = activeOfflineScope();
    await removeOfflineAudio(offlineAudioId, scope).catch(() => {});
    setPendingAudioCount(await countOfflineAudio(scope).catch(() => 0));
  };

  const persistConfirmed = async (payload, transactions, allowDuplicates = false, offlineAudioId = '') => {
    const result = await api.saveTransactions({ ...payload, allowDuplicates });
    await finalizeOfflineAudio(offlineAudioId);
    setUndoSave({ ids: result.ids || [], count: transactions.length });
    setRedoSave(null);
    setDuplicatePrompt(null);
    setParseResult(null);
    queueLearningSuggestion(transactions, payload.transcript);
    await load();
  };

  const saveConfirmed = async (transactions) => {
    const offlineAudioId = parseResult.offlineAudioId || '';
    const payload = { transcript: parseResult.transcript, transactions };
    try {
      if (!online) {
        queueTransactions(payload, activeOfflineScope());
        await finalizeOfflineAudio(offlineAudioId);
        setParseResult(null);
        notify('ثبت شد؛ بعد از اتصال فقط در همین دفتر همگام می‌شود.');
        await load();
      } else {
        await persistConfirmed(payload, transactions, false, offlineAudioId);
      }
    } catch (error) {
      if (error.code === 'POSSIBLE_DUPLICATE') {
        setDuplicatePrompt({ payload, transactions, offlineAudioId, duplicates: error.details?.duplicates || [] });
      } else notify(error.message);
    }
  };

  const confirmDuplicate = async () => {
    if (!duplicatePrompt) return;
    const transactions = duplicatePrompt.transactions.map((item) => ({
      ...item, needsReview: false, reviewState: 'duplicate-confirmed',
      reviewReasons: [...(item.reviewReasons || []), 'شباهت با ثبت اخیر به کاربر نمایش داده شد و ثبت جداگانه تأیید شد.'],
    }));
    try {
      await persistConfirmed(
        { ...duplicatePrompt.payload, transactions }, transactions, true, duplicatePrompt.offlineAudioId || '',
      );
    } catch (error) { notify(error.message); }
  };

  const discardParseResult = async () => {
    const offlineAudioId = parseResult?.offlineAudioId;
    if (offlineAudioId) await finalizeOfflineAudio(offlineAudioId);
    setParseResult(null);
  };

  const undoLastSave = async () => {
    const snapshot = undoSave;
    if (!snapshot?.ids?.length || undoing) return;
    setUndoing(true);
    setUndoSave(null);
    try {
      for (const id of snapshot.ids) await api.deleteTransaction(id);
      await load();
      setRedoSave(snapshot);
      notify(snapshot.ids.length > 1 ? 'ثبت‌های اخیر با سند معکوس برگردانده شدند.' : 'ثبت اخیر با سند معکوس برگردانده شد.');
    } catch (error) { notify(error.message); }
    finally { setUndoing(false); }
  };

  const redoLastUndo = async () => {
    const snapshot = redoSave;
    if (!snapshot?.ids?.length || undoing) return;
    setUndoing(true);
    setRedoSave(null);
    try {
      const restored = [];
      for (const id of snapshot.ids) restored.push((await api.redoTransaction(id)).item.id);
      setUndoSave({ ids: restored, count: restored.length });
      await load();
      notify(restored.length > 1 ? 'ثبت‌ها با سند تازه دوباره ایجاد شدند.' : 'ثبت با سند تازه دوباره ایجاد شد.');
    } catch (error) { notify(error.message); }
    finally { setUndoing(false); }
  };

  const applyCorrection = async () => {
    if (!correctionDraft) return;
    try {
      const result = await api.correctTransaction(correctionDraft.current.id, correctionDraft.command);
      const categoryChanged = result.interpretation?.changedFields?.includes('category');
      if (categoryChanged) {
        const keyword = inferLearningKeyword(correctionDraft.command);
        if (keyword.length >= 2) setLearningSuggestion({ keyword, category: result.item.category });
      }
      setCorrectionDraft(null);
      await load();
      notify('آخرین ثبت با سند معکوس اصلاح شد.');
    } catch (error) {
      if (error.code === 'LATEST_TRANSACTION_CHANGED') setCorrectionDraft(null);
      notify(error.message);
    }
  };

  const acceptLearning = async () => {
    const suggestion = learningSuggestion;
    setLearningSuggestion(null);
    if (!suggestion) return;
    try { await api.saveLearning(suggestion); await load(); notify('این نگاشت با تأیید تو یاد گرفته شد.'); }
    catch (error) { notify(error.message); }
  };

  const navigate = (target, section = '') => {
    // صفحه‌ای که این کاربر اجازه‌اش را ندارد حتی با ناوبری مستقیم باز نمی‌شود.
    // سرور هم همین مرز را دارد، پس این فقط تجربه را تمیز نگه می‌دارد — ولی
    // نبودش یعنی کاربر ساده می‌تواند به صفحه‌ای برود که همهٔ درخواست‌هایش ۴۰۳
    // می‌گیرند و فقط خطا می‌بیند.
    if (allowedScreens(access).length && !allowedScreens(access).some((item) => item.id === target)) return;
    if (target === 'ledger' && ['transactions', 'obligations', 'invoices', 'reconciliation', 'recurring', 'inventory', 'tools'].includes(section)) setLedgerTab(section);
    setScreen(target); setDrawer(false);
    window.setTimeout(() => section && document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
    // صفحهٔ تازه از بالا باز می‌شود، فوری. اسکرول نرم پیش از عوض‌شدن محتوا شروع
    // می‌شد و جابه‌جایی صفحه آن را نیمه‌راه قطع می‌کرد؛ کاربر از پایین تنظیمات
    // مستقیم به پایین «همکاری حسابدار» می‌رسید و بخش اصلی را نمی‌دید.
    if (!section) window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const login = async (username, password) => {
    setAuthError('');
    try {
      const result = await api.login(username, password);
      setAccess(accessFromPayload(result));
      localStorage.setItem('hesab-yar-authenticated', '1');
      setAuthenticated(true);
    } catch (error) { setAuthError(error.message); }
  };

  const logout = async () => {
    if (parseResult?.offlineAudioId && offlineScopeReady) {
      await releaseOfflineAudio(parseResult.offlineAudioId, activeOfflineScope(), 'خروج کاربر پیش از تأیید').catch(() => {});
    }
    try { await api.logout(); } catch { /* پاک‌کردن نشست محلی حتی اگر شبکه قطع باشد */ }
    localStorage.removeItem('hesab-yar-authenticated');
    api.clearOfflineSession();
    setParseResult(null);
    setPendingAudioCount(0);
    setData({ transactions: [], summary: EMPTY_SUMMARY, categories: [], accounts: [], settings: {}, learnings: [], averages: {}, dnaProfiles: null, overview: {}, contacts: [], obligations: [], recurring: [], closings: [], closingPreview: null });
    setAccess({ user: null, workspaces: [], workspace: null });
    setAuthenticated(false);
  };

  const switchWorkspace = async (workspaceId) => {
    if (!workspaceId || workspaceId === access.workspace?.id) return;
    if (!online) { notify('برای تغییر دفتر ابتدا به اینترنت وصل شو؛ ثبت‌های آفلاین در دفتر فعلی محفوظ‌اند.'); return; }
    if (parseResult?.offlineAudioId && offlineScopeReady) {
      await releaseOfflineAudio(parseResult.offlineAudioId, activeOfflineScope(), 'تغییر دفتر پیش از تأیید').catch(() => {});
    }
    const previousWorkspaceId = access.workspace?.id || '';
    api.selectWorkspace(workspaceId);
    setLoading(true);
    // تا رسیدن تحلیل دفتر تازه، تحلیل دفتر قبلی باید برود.
    setData((previous) => ({ ...previous, overview: {}, dnaProfiles: null }));
    setParseResult(null);
    setPendingAudioCount(0);
    setFailure(null);
    const loaded = await load();
    if (!loaded) {
      api.selectWorkspace(previousWorkspaceId);
      notify('تغییر دفتر کامل نشد و دفتر قبلی فعال ماند.');
      return;
    }
    navigate('today');
    notify('دفتر فعال عوض شد.');
  };
  const snoozeAlert = async (alertId) => {
    try { await api.snoozeAlert(alertId, 24); await load(); notify('این هشدار تا ۲۴ ساعت پنهان شد.'); }
    catch (error) { notify(error.message); }
  };

  if (authenticated === null) return <div dir="rtl" className="grid min-h-screen place-items-center bg-paper text-ink"><span className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" aria-label="در حال بارگذاری" /></div>;
  if (!authenticated) return <LoginPage onLogin={login} error={authError} />;
  if (access.user?.mustChangePassword) return <main dir="rtl" className="min-h-screen bg-paper py-10 text-ink"><div className="mx-auto max-w-[760px] px-4"><p className="text-sm font-bold text-accent">اولین ورود</p><h1 className="mt-2 text-2xl font-extrabold">رمز موقتت را عوض کن</h1><p className="mt-2 text-sm leading-7 text-muted">برای حفاظت از اطلاعات مالی، تا تعیین رمز شخصی امکان ورود به دفتر وجود ندارد.</p></div><PasswordPanel notify={notify} onChanged={logout} /></main>;

  const canWrite = ['owner', 'manager', 'accountant'].includes(access.workspace?.role);

  return (
    <div dir="rtl" className="min-h-screen bg-paper text-ink">
      {!online && <div className="sticky top-0 z-50 flex h-9 items-center justify-center gap-2 bg-ink px-4 text-[13px] text-white"><WifiOff size={15} /> آفلاین — ضبط ذخیره می‌شود و بعداً ارسال</div>}
      <div className={`app-shell mx-auto min-h-screen w-full max-w-[1440px] bg-paper ${insightsOpen ? 'insights-open' : ''}`}>
        <DesktopNav screen={screen} navigate={navigate} businessName={data.settings.businessName} profileType={data.settings.profileType} access={access} switchWorkspace={switchWorkspace} />
        <div className="safe-bottom min-w-0 lg:col-start-2">
          {screen === 'today' && (
            <TodayPage
              data={data} loading={loading} manualText={manualText} setManualText={setManualText}
              parseManual={parseManual} recordState={recordState}
              stopRecording={stopRecording} cancelProcessing={cancelProcessing} beginRecording={() => { holdingRef.current = true; startRecording(); }}
              levels={levels} liveTranscript={liveTranscript} liveVoiceNote={liveVoiceNote} livePreview={livePreview} fastVoiceAvailable={fastVoiceAvailable}
              voicePath={voicePath} voiceSystemStatus={voiceSystemStatus} openDrawer={() => setDrawer(true)} readOnly={!canWrite}
              reviewing={Boolean(parseResult)} savedRecently={Boolean(undoSave)} pendingAudioCount={pendingAudioCount}
              navigate={navigate} onOpenClosing={() => setCloseDayOpen(true)} onSelectTransaction={setSelectedDecision} onSnoozeAlert={snoozeAlert}
              notify={notify} refreshToday={load} experience={access.experience}
            />
          )}
          {screen === 'ledger' && <LedgerPage profileType={data.settings.profileType} categories={data.categories} accounts={data.accounts} contacts={data.contacts} notify={notify} refresh={load} initialTab={ledgerTab} />}
          {screen === 'report' && <ReportPage profileType={data.settings.profileType} navigate={navigate} notify={notify} />}
          {screen === 'review' && <ReviewQueuePage notify={notify} access={access} />}
          {screen === 'accounting' && data.settings.profileType === 'business' && <AccountingPage access={access} notify={notify} />}
          {screen === 'tax' && data.settings.profileType === 'business' && <TaxPage access={access} notify={notify} />}
          {screen === 'firm' && <FirmConsolePage access={access} notify={notify} switchWorkspace={switchWorkspace} refreshAccess={async () => { const result = await api.workspaces(); setAccess(accessFromPayload(result)); }} />}
          {screen === 'chart' && data.settings.profileType === 'business' && <ChartPage access={access} notify={notify} />}
          {screen === 'collaboration' && data.settings.profileType === 'business' && <CollaborationPage access={access} notify={notify} navigate={navigate} />}
          {screen === 'learning' && <LearningPage categories={data.categories} notify={notify} />}
          {screen === 'settings' && <><ExportAccessCard access={access} navigate={navigate} notify={notify} refreshAccess={async () => { const result = await api.workspaces(); setAccess(accessFromPayload(result)); }} /><SettingsPage initial={data.settings} accounts={data.accounts} notify={notify} refresh={load} onLogout={logout} canManage={['owner', 'manager'].includes(access.workspace?.role)} /><AccountsPanel accounts={data.accounts} canManage={['owner', 'manager'].includes(access.workspace?.role)} notify={notify} refresh={load} /><Suspense fallback={null}><WorkspacePanel access={access} notify={notify} switchWorkspace={switchWorkspace} refreshAccess={async () => { const result = await api.workspaces(); setAccess(accessFromPayload(result)); }} /></Suspense><BackupPanel access={access} notify={notify} refresh={load} /><DataPrivacyPanel access={access} notify={notify} /><SessionsPanel notify={notify} /><PasswordPanel notify={notify} onChanged={logout} /><LogoutPanel onLogout={logout} /></>}
        </div>
        <InsightRail overview={data.overview} navigate={navigate} open={insightsOpen} setOpen={setInsightsOpen} />
        <CounterpartyMatchSheet />
      </div>

      <BottomNav screen={screen} navigate={navigate} access={access} />
      {drawer && <Drawer profileType={data.settings.profileType} close={() => setDrawer(false)} navigate={navigate} access={access} switchWorkspace={switchWorkspace} />}
      {parseResult && (
        <ConfirmationSheet
          result={parseResult} categories={data.categories} accounts={data.accounts} onCancel={discardParseResult} onConfirm={saveConfirmed}
        />
      )}
      {failure && <FailureSheet failure={failure} close={() => setFailure(null)} retry={() => { setFailure(null); holdingRef.current = true; startRecording(); }} manual={() => { setFailure(null); document.getElementById('manual-entry')?.focus(); }} />}
      {correctionDraft && <CorrectionSheet draft={correctionDraft} accounts={data.accounts} close={() => setCorrectionDraft(null)} confirm={applyCorrection} />}
      {duplicatePrompt && <DuplicateSheet prompt={duplicatePrompt} close={() => setDuplicatePrompt(null)} confirm={confirmDuplicate} />}
      {learningSuggestion && <LearningSuggestionSheet suggestion={learningSuggestion} close={() => setLearningSuggestion(null)} confirm={acceptLearning} />}
      {intentDraft && <IntentSheet draft={intentDraft} setDraft={setIntentDraft} accounts={data.accounts || []} close={() => setIntentDraft(null)} confirm={saveIntentDraft} />}
      {settleDraft && <SettleSheet draft={settleDraft} obligations={data.obligations || []} close={() => setSettleDraft(null)} confirm={applySettlement} />}
      {selectedDecision && <DecisionDetailsSheet item={selectedDecision} close={() => setSelectedDecision(null)} />}
      {closeDayOpen && <CloseDaySheet data={data} close={() => setCloseDayOpen(false)} onComplete={async () => { setCloseDayOpen(false); await load(); notify('امروز بسته شد و نتیجه در سابقهٔ صندوق ماند.'); }} />}
      {undoSave && <div role="status" className="fixed bottom-28 left-1/2 z-[80] flex w-[calc(100%-32px)] max-w-[460px] -translate-x-1/2 items-center gap-3 rounded-lg bg-ink px-4 py-3 text-sm text-white shadow-paper"><Check size={19} className="shrink-0 text-income" /><span className="min-w-0 flex-1">{undoSave.count > 1 ? `${toPersianDigits(undoSave.count)} ثبت ذخیره شد.` : 'تراکنش ثبت شد.'}</span><button disabled={undoing} onClick={undoLastSave} className="tap min-w-0 rounded-md border border-white/30 px-3 text-xs font-extrabold">برگردان</button></div>}
      {redoSave && <div role="status" className="fixed bottom-28 left-1/2 z-[80] flex w-[calc(100%-32px)] max-w-[460px] -translate-x-1/2 items-center gap-3 rounded-lg bg-ink px-4 py-3 text-sm text-white shadow-paper"><RotateCcw size={19} className="shrink-0 text-income" /><span className="min-w-0 flex-1">{redoSave.count > 1 ? 'ثبت‌ها برگردانده شدند.' : 'ثبت برگردانده شد.'}</span><button disabled={undoing} onClick={redoLastUndo} className="tap min-w-0 rounded-md border border-white/30 px-3 text-xs font-extrabold">دوباره انجام بده</button></div>}
      {toast && <div role="status" className="fixed bottom-28 left-1/2 z-[80] w-[calc(100%-32px)] max-w-[430px] -translate-x-1/2 rounded-lg bg-ink px-4 py-3 text-center text-sm text-white shadow-paper">{toast}</div>}
      {data.settings.onboardingDone === 'false' && <Onboarding initial={data.settings} onDone={async (values) => { const result = await api.settings({ ...values, onboardingDone: 'true' }); setData((current) => ({ ...current, settings: result.settings })); }} />}
    </div>
  );
}
