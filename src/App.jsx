import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3, BookOpenCheck, Check, ChevronLeft, CircleAlert, Contact, Download, FileText, Landmark,
  HandCoins, Home, LayoutGrid, ListFilter, Menu, Mic, PackageSearch, Pencil, Plus, Printer, ReceiptText, RotateCcw,
  Search, Settings, Sparkles, Trash2, Users, WalletCards, WifiOff, X,
} from 'lucide-react';
import { api, flushTransactionQueue, queueTransactions } from './lib/api.js';
import { browserRecognitionCanRestart, createPersianRecognizer, liveSpeechErrorMessage, liveSpeechSupported, mergeSpeechSegments } from './lib/liveSpeech.js';
import { createRealtimeTranscriber, realtimeSpeechAvailable, rememberRealtimeFailure } from './lib/realtimeSpeech.js';
import {
  countOfflineAudio, failOfflineAudio, markOfflineAudioForReview, pendingAudio, releaseOfflineAudio, removeOfflineAudio, saveOfflineAudio,
} from './lib/offlineAudio.js';
import { isPermanentQueueError } from './lib/offlineScope.js';
import { clock, formatAmount, formatSignedAmount, persianDate, toPersianDigits } from './lib/format.js';
import { assessAudioCapture, createWavRecorder } from './lib/wavRecorder.js';
import { decideVoiceRoute } from './lib/voiceDecision.js';
import { selectVoiceSnapshot } from './lib/voiceArbitration.js';
import { describeVoiceAvailability, pointerReleaseAction, realtimeWorthTrying, voicePathLabel } from './lib/voiceStatus.js';
import { buildTodayPulse, buildTodayTasks, closingDifference, todayComposerState, todayExamples } from './lib/todayExperience.js';
import { inferLearningKeyword, parseFinancialText, parseRecognitionCandidates } from '../shared/parser.js';
import { normalizePersian } from '../shared/normalize.js';

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

/** ISO به متن شمسی، برای نمایش داخل ورودی. */
function isoToPersianInput(iso, timeZone = 'Asia/Tehran') {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).filter((part) => part.type !== 'literal')
    .reduce((value, part) => ({ ...value, [part.type]: part.value }), {});
  return `${parts.year}/${parts.month}/${parts.day}`;
}

function toLatinDigits(value) {
  return String(value || '').replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

/**
 * ورودی تاریخ شمسی.
 *
 * <input type="date"> همیشه میلادی نشان می‌دهد و برای کاربر ایرانی بی‌معناست:
 * «۲۰۲۶/۰۸/۰۶» هیچ نمی‌گوید، «۱۴۰۵/۰۵/۱۵» همه‌چیز. تاریخ به‌صورت متن شمسی
 * گرفته و نشان داده می‌شود و تبدیل همین‌جا انجام می‌گیرد.
 *
 * تا وقتی کاربر در حال تایپ است مقدار بیرونی روی متن او نوشته نمی‌شود، وگرنه
 * نیمهٔ تایپ‌شده مدام پاک می‌شد.
 */
function PersianDateInput({ value, onChange, placeholder = '۱۴۰۵/۰۵/۱۵', className = '' }) {
  const [text, setText] = useState(() => isoToPersianInput(value));
  const [typing, setTyping] = useState(false);
  useEffect(() => { if (!typing) setText(isoToPersianInput(value)); }, [value, typing]);
  const commit = (raw) => {
    setText(raw);
    setTyping(true);
    const digits = toLatinDigits(raw).trim();
    if (!digits) { onChange(''); return; }
    const match = digits.match(/^(\d{4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})$/);
    if (!match) return;
    const iso = persianToISO(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso) onChange(iso);
  };
  const typed = toLatinDigits(text).trim();
  const invalid = Boolean(typed) && !value;
  return <span className="block">
    <input
      dir="ltr" inputMode="numeric" value={text} placeholder={placeholder}
      onChange={(event) => commit(event.target.value)} onBlur={() => setTyping(false)}
      className={`tap w-full rounded-lg border px-3 text-left numbers ${invalid ? 'border-expense' : 'border-line'} ${className}`}
    />
    {invalid && <span className="mt-1 block text-[10px] text-expense">تاریخ شمسی را به شکل ۱۴۰۵/۰۵/۱۵ بنویس.</span>}
  </span>;
}

import { isCorrectionCommand, previewCorrection } from '../shared/correction.js';
import { capitalEntryPayload, detectVoiceIntent, invoiceDraftPayload, invoiceLinesTotal } from '../shared/voiceIntent.js';
import { detectSettleIntent, matchSettleTargets } from '../shared/settleSpeech.js';
import { persianToISO } from '../shared/persianDate.js';
import { applyDnaSignals } from '../shared/dnaSignals.js';
import { assessTransactionReview, REVIEW_FIELD_LABELS, reviewBatchSummary } from '../shared/review.js';
import { SETUP_CHECK_IDS, deliverySteps } from './lib/deliveryFlow.js';
import { PRODUCT_POSITIONING, profileDefinition } from '../shared/product.js';
import ExcelImportPanel from './features/accounting/ExcelImportPanel.jsx';

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

  const load = useCallback(async () => {
    try {
      const [bootstrap] = await Promise.all([api.bootstrap(), refreshVoiceSystemStatus()]);
      setData({ ...bootstrap, learnings: bootstrap.learnings || [], averages: bootstrap.averages || {} });
      if (bootstrap.access) setAccess(bootstrap.access);
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
    else api.authStatus().then((result) => { setAuthenticated(result.authenticated); if (result.authenticated) setAccess({ user: result.user, workspaces: result.workspaces || [], workspace: result.workspace }); }).catch((error) => { setAuthError(error.message); setAuthenticated(false); });
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
        const { item } = await api.saveInvoice({ ...payload, documentType: draft.documentType, customerName: draft.contactName || '' });
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
    if (!section) window.scrollTo({ top: 0, behavior: 'smooth' });
  };

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
    if (parseResult?.offlineAudioId && offlineScopeReady) {
      await releaseOfflineAudio(parseResult.offlineAudioId, activeOfflineScope(), 'خروج کاربر پیش از تأیید').catch(() => {});
    }
    try { await api.logout(); } catch { /* پاک‌کردن نشست محلی حتی اگر شبکه قطع باشد */ }
    localStorage.removeItem('hesab-yar-authenticated');
    api.clearOfflineSession();
    setParseResult(null);
    setPendingAudioCount(0);
    setData({ transactions: [], summary: EMPTY_SUMMARY, categories: [], accounts: [], settings: {}, learnings: [], averages: {}, overview: {}, contacts: [], obligations: [], recurring: [], closings: [], closingPreview: null });
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
            />
          )}
          {screen === 'ledger' && <LedgerPage profileType={data.settings.profileType} categories={data.categories} accounts={data.accounts} contacts={data.contacts} notify={notify} refresh={load} initialTab={ledgerTab} />}
          {screen === 'report' && <ReportPage profileType={data.settings.profileType} navigate={navigate} notify={notify} />}
          {screen === 'accounting' && data.settings.profileType === 'business' && <AccountingPage access={access} notify={notify} />}
          {screen === 'tax' && data.settings.profileType === 'business' && <TaxPage access={access} notify={notify} />}
          {screen === 'firm' && <FirmConsolePage access={access} notify={notify} switchWorkspace={switchWorkspace} refreshAccess={async () => { const result = await api.workspaces(); setAccess({ user: result.user, workspaces: result.workspaces, workspace: result.workspace }); }} />}
          {screen === 'chart' && data.settings.profileType === 'business' && <ChartPage access={access} notify={notify} />}
          {screen === 'collaboration' && data.settings.profileType === 'business' && <CollaborationPage access={access} notify={notify} navigate={navigate} />}
          {screen === 'learning' && <LearningPage categories={data.categories} notify={notify} />}
          {screen === 'settings' && <><SettingsPage initial={data.settings} accounts={data.accounts} notify={notify} refresh={load} onLogout={logout} canManage={['owner', 'manager'].includes(access.workspace?.role)} /><WorkspacePanel access={access} notify={notify} switchWorkspace={switchWorkspace} refreshAccess={async () => { const result = await api.workspaces(); setAccess({ user: result.user, workspaces: result.workspaces, workspace: result.workspace }); }} /><BackupPanel access={access} notify={notify} refresh={load} /><DataPrivacyPanel access={access} notify={notify} /><SessionsPanel notify={notify} /><PasswordPanel notify={notify} onChanged={logout} /></>}
        </div>
        <InsightRail overview={data.overview} navigate={navigate} open={insightsOpen} setOpen={setInsightsOpen} />
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

function TodayPage({ data, loading, manualText, setManualText, parseManual, recordState, beginRecording, stopRecording, cancelProcessing, levels, liveTranscript, liveVoiceNote, livePreview, fastVoiceAvailable, voicePath, voiceSystemStatus, openDrawer, readOnly = false, reviewing = false, savedRecently = false, pendingAudioCount = 0, navigate, onOpenClosing, onSelectTransaction, onSnoozeAlert }) {
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
        <button className="tap grid place-items-center rounded-lg border border-line bg-surface" onClick={openDrawer} aria-label="بازکردن منو"><Menu size={23} /></button>
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
          <Recorder state={recordState} start={beginRecording} stop={stopRecording} cancel={cancelProcessing} levels={levels} liveTranscript={liveTranscript} liveVoiceNote={liveVoiceNote} livePreview={livePreview} fastVoiceAvailable={fastVoiceAvailable} voicePath={voicePath} voiceSystemStatus={voiceSystemStatus} disabled={readOnly} />

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
        {values.map((item) => <div key={item.label} className="min-w-0 px-2 first:pr-0 last:pl-0"><p className="min-h-8 text-[11px] leading-4 text-muted sm:min-h-0 sm:whitespace-nowrap sm:text-[12px]">{item.label}</p><p className={`numbers mt-2 truncate text-[16px] font-extrabold sm:text-[19px] ${item.color}`}>{loading ? '—' : formatAmount(item.value)}</p><p className="mt-0.5 text-[11px] text-muted">تومان</p></div>)}
      </div>
      <div className="mt-4 border-t border-line pt-3 text-[13px] text-muted">
        {summary.comparison == null ? 'برای مقایسه با دیروز هنوز داده کافی نیست.' : <span><b className={summary.comparison >= 0 ? 'text-income' : 'text-expense'}>{summary.comparison >= 0 ? '↑' : '↓'} {formatAmount(Math.abs(summary.comparison))}٪</b> {summary.comparison >= 0 ? 'بیشتر' : 'کمتر'} از دیروز</span>}
      </div>
    </section>
  );
}

function TransactionList({ items, loading, examples = [], onExample, onSelect }) {
  if (loading) return <div className="space-y-2">{[1, 2, 3].map((x) => <div key={x} className="h-16 animate-pulse rounded-lg bg-line/45" />)}</div>;
  if (!items.length) return <div className="rounded-[12px] border border-dashed border-line bg-surface/55 px-4 py-6 text-center"><div className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-warn-bg text-accent"><ReceiptText size={21} /></div><p className="mt-3 text-[15px] font-extrabold">اولین ثبت امروز را بساز</p><p className="mt-1 text-[12px] leading-6 text-muted">لازم نیست فرم حسابداری بلد باشی؛ یکی از جمله‌ها را انتخاب کن و مبلغش را تغییر بده.</p><div className="mt-3 flex flex-wrap justify-center gap-2">{examples.map((example) => <button key={example} onClick={() => onExample?.(example)} className="min-h-9 rounded-full border border-line bg-surface px-3 text-[11px] font-bold">{example}</button>)}</div></div>;
  return <div className="border-y border-line bg-surface/50">{items.map((item) => {
    const status = item.needsReview || item.reviewState === 'review'
      ? { label: 'نیازمند بررسی', classes: 'bg-warn-bg text-expense' }
      : ['reviewed', 'duplicate-confirmed'].includes(item.reviewState)
        ? { label: 'بررسی‌شده', classes: 'bg-accent/10 text-accent' }
        : { label: 'آماده', classes: 'bg-income/10 text-income' };
    return (
    <button type="button" key={item.id} onClick={() => onSelect?.(item)} className="flex min-h-[76px] w-full items-center justify-between gap-4 border-b border-line px-1 py-3 text-right last:border-b-0">
      <div className="min-w-0"><div className="flex items-center gap-2"><p className={`numbers text-lg font-bold ${item.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatSignedAmount(item)}</p><span className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${status.classes}`}>{status.label}</span></div><p className="mt-1 truncate text-[13px] text-muted">{item.rawText}</p></div>
      <div className="shrink-0 text-left"><span className="inline-block rounded-md border border-line bg-surface px-2 py-1 text-[12px]">{item.category}</span><p className="mt-1 text-[12px] text-muted">{clock(item.occurredAt)}</p></div>
    </button>
  ); })}</div>;
}

function CloseDaySheet({ data, close, onComplete }) {
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

function Recorder({ state, start, stop, cancel, levels, liveTranscript, liveVoiceNote, livePreview, fastVoiceAvailable, voicePath = 'ready', voiceSystemStatus, disabled = false }) {
  const recording = state === 'recording';
  const processing = state === 'processing';
  const requesting = state === 'requesting';
  const finalizing = state === 'finalizing';
  const pointerRef = useRef({ action: '', startedAt: 0 });
  const availability = voiceSystemStatus
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

function ConfirmationSheet({ result, categories, accounts = [], onCancel, onConfirm }) {
  const defaultAccountId = accounts.find((account) => account.id === 'cash' && account.active)?.id || accounts.find((account) => account.active)?.id || 'cash';
  const [items, setItems] = useState(() => result.transactions.map((item) => ({ ...item, accountId: item.accountId || defaultAccountId, originalCategory: item.category })));
  const [index, setIndex] = useState(0);
  const [editAmount, setEditAmount] = useState(false);
  const initialSummary = reviewBatchSummary(result);
  const [detailsOpen, setDetailsOpen] = useState(() => initialSummary.review > 0 || initialSummary.unintelligible > 0);
  const item = items[index];
  const assessment = assessTransactionReview(item);
  const summary = reviewBatchSummary({ transactions: items });
  const allowedCategories = categories.filter((category) => category.type === item.type);
  const patch = (changes) => setItems((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...changes } : entry));
  const patchFields = (fields, changes) => patch({
    ...changes, _changed: true,
    confidenceDetails: { ...item.confidenceDetails, ...Object.fromEntries(fields.map((field) => [field, { score: 1, reason: 'کاربر این مقدار را در صفحهٔ تأیید انتخاب کرد.' }])) },
  });
  const patchField = (field, changes) => patchFields([field], changes);
  const confirmedItems = () => items.map((entry) => {
    const nextAssessment = assessTransactionReview(entry);
    const { _changed, ...clean } = entry;
    const reviewed = Boolean(_changed) || nextAssessment.state !== 'ready';
    return {
      ...clean, needsReview: false, confidence: nextAssessment.overallScore, confidenceDetails: nextAssessment.fields,
      reviewState: reviewed ? 'reviewed' : 'ready',
      reviewReasons: reviewed ? [...(entry.reviewReasons || []), 'کاربر جزئیات این برداشت را پیش از ثبت تأیید کرد.'] : (entry.reviewReasons || []),
    };
  });
  const finish = () => index < items.length - 1 ? setIndex(index + 1) : onConfirm(confirmedItems());
  const statusCards = [
    ['ready', 'آماده ثبت', summary.ready, 'border-income/30 bg-income/5 text-income'],
    ['review', 'نیازمند بررسی', summary.review, 'border-accent/35 bg-warn-bg text-accent'],
    ['unintelligible', 'نامفهوم', summary.unintelligible, 'border-expense/30 bg-expense/5 text-expense'],
  ];
  const quickConfirm = summary.ready === summary.total && summary.total > 0 && !detailsOpen;
  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-ink/35 px-0 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section role="dialog" aria-modal="true" aria-label="تأیید تراکنش" className="sheet-in max-h-[94vh] w-full max-w-[640px] overflow-y-auto rounded-t-2xl bg-paper px-4 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-3 shadow-2xl">
        <div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" />
        {items.length > 1 && <div className="mb-3 flex items-center justify-between text-[13px] text-muted"><span>تراکنش {toPersianDigits(index + 1)} از {toPersianDigits(items.length)}</span><div className="flex gap-1">{items.map((_, dot) => <span key={dot} className={`h-1.5 w-6 rounded-full ${dot === index ? 'bg-accent' : 'bg-line'}`} />)}</div></div>}
        <div className="mb-3 grid grid-cols-3 gap-2" aria-label="وضعیت برداشت‌ها">{statusCards.map(([key, label, count, classes]) => <div key={key} className={`rounded-lg border px-2 py-2 text-center ${classes}`}><b className="numbers block text-base">{toPersianDigits(count)}</b><span className="mt-0.5 block text-[10px] font-bold">{label}</span></div>)}</div>
        <blockquote className="rounded-lg border border-line bg-surface/65 px-3 py-3 text-[14px] leading-7 text-muted">«{result.transcript}»</blockquote>
        {Number.isFinite(result.responseMs) && <p className="mt-2 text-center text-[12px] font-medium text-income">{result.engine === 'browser-live' ? 'تشخیص زنده' : 'تشخیص از صدای اصلی'}؛ نتیجه در {toPersianDigits((Math.max(1, result.responseMs) / 1000).toFixed(1))} ثانیه آماده شد</p>}

        {quickConfirm ? <div className="mt-5"><div className="divide-y divide-line rounded-[10px] border border-line bg-surface px-3">{items.map((entry) => <div key={`${entry.amount}-${entry.rawText}`} className="flex items-center justify-between gap-3 py-3"><div><b className={`numbers text-lg ${entry.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatSignedAmount(entry)}</b><p className="mt-1 text-xs text-muted">{entry.category}</p></div><span className="rounded-full bg-income/10 px-2 py-1 text-[10px] font-bold text-income">آماده ثبت</span></div>)}</div><button onClick={() => onConfirm(confirmedItems())} className="tap mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 font-extrabold text-white"><Check size={19} />تأیید سریع همه</button><button onClick={() => setDetailsOpen(true)} className="tap mt-2 w-full text-sm font-bold text-muted">دیدن جزئیات و دلیل تصمیم</button></div> : <>
        <div className={`mt-4 flex items-center justify-between rounded-lg border px-3 py-2 text-xs font-bold ${assessment.state === 'ready' ? 'border-income/30 bg-income/5 text-income' : assessment.state === 'review' ? 'border-accent/40 bg-warn-bg text-accent' : 'border-expense/30 bg-expense/5 text-expense'}`}><span>{assessment.state === 'ready' ? 'آماده ثبت' : assessment.state === 'review' ? 'این مورد را بررسی کن' : 'این مورد نامفهوم است'}</span><span className="numbers">اطمینان {toPersianDigits(assessment.percent)}٪</span></div>
        <button onClick={() => setEditAmount(true)} className="my-4 w-full rounded-[10px] border border-transparent py-3 text-center hover:border-line">
          {editAmount ? (
            <input autoFocus inputMode="numeric" value={item.amount} onChange={(event) => patchField('amount', { amount: Number(event.target.value.replace(/\D/g, '')) })} onBlur={() => setEditAmount(false)} onKeyDown={(event) => { if (event.key === 'Enter') setEditAmount(false); }} className="numbers mx-auto block w-full bg-transparent text-center text-4xl font-extrabold tracking-[-.02em] outline-none" />
          ) : <div className="flex items-center justify-center gap-2"><span className="numbers text-4xl font-extrabold tracking-[-.02em]">{formatAmount(item.amount)}</span><Pencil size={16} className="text-muted" /></div>}
          <span className="mt-1 block text-[13px] text-muted">تومان</span>
        </button>

        <div className="space-y-2">
          <div className="flex min-h-14 items-center gap-3 border-t border-line py-2"><span className="w-12 text-[13px] text-muted">نوع</span><div className="grid flex-1 grid-cols-2 gap-2"><button onClick={() => patchFields(['type', 'category'], { type: 'income', category: categories.find((x) => x.type === 'income')?.name || 'فروش' })} className={`tap rounded-lg border text-sm font-bold ${item.type === 'income' ? 'border-income bg-income text-white' : 'border-line bg-surface'}`}>درآمد</button><button onClick={() => patchFields(['type', 'category'], { type: 'expense', category: categories.find((x) => x.type === 'expense')?.name || 'سایر هزینه‌ها' })} className={`tap rounded-lg border text-sm font-bold ${item.type === 'expense' ? 'border-expense bg-expense text-white' : 'border-line bg-surface'}`}>هزینه</button></div></div>
          <label className="flex min-h-14 items-center gap-3 border-y border-line py-2"><span className="w-12 text-[13px] text-muted">دسته</span><select value={item.category} onChange={(event) => patchField('category', { category: event.target.value })} className="tap flex-1 appearance-none rounded-lg border border-line bg-surface px-3 text-[15px] font-bold outline-none">{allowedCategories.map((category) => <option key={category.id}>{category.name}</option>)}</select><Pencil size={16} className="text-muted" /></label>
          <label className="flex min-h-14 items-center gap-3 border-b border-line py-2"><span className="w-12 text-[13px] text-muted">حساب</span><select value={item.accountId || defaultAccountId} onChange={(event) => patchField('account', { accountId: event.target.value })} className="tap flex-1 rounded-lg border border-line bg-surface px-3 text-[15px] font-bold outline-none">{accounts.filter((account) => account.active).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          {item.occurredAt && <div className="flex min-h-14 items-center gap-3 border-b border-line py-2"><span className="w-12 text-[13px] text-muted">تاریخ</span><div className="flex flex-1 items-center justify-between gap-2"><b className="text-[13px]">{persianDate(item.occurredAt)}</b><span className="rounded-md bg-warn-bg px-2 py-1 text-[11px] font-bold text-accent">از گفتهٔ «{item.occurredAtLabel}» برداشت شد</span></div></div>}
        </div>

        <ConfidencePanel assessment={assessment} />

        {item.warning && <div className="mt-4 flex gap-3 rounded-lg border-r-4 border-accent bg-warn-bg px-3 py-3 text-[14px] leading-6"><CircleAlert className="mt-0.5 shrink-0 text-accent" size={20} /><span>{item.warning}</span></div>}
        {!!item.alternatives?.length && <div className="mt-4"><p className="mb-2 text-[13px] text-muted">شاید منظورت این بود:</p><div className="flex flex-wrap gap-2">{item.alternatives.map((amount) => <button key={amount} onClick={() => patchField('amount', { amount })} className="tap numbers rounded-lg border border-line bg-surface px-4 font-bold">{formatAmount(amount)}</button>)}</div></div>}

        <div className="mt-5 grid grid-cols-[minmax(0,7fr)_minmax(90px,3fr)] gap-2">
          <button disabled={assessment.state === 'unintelligible'} onClick={finish} className="tap flex items-center justify-center gap-2 rounded-lg bg-accent px-4 font-extrabold text-white disabled:opacity-40"><Check size={19} />{index < items.length - 1 ? 'تأیید و بعدی' : 'تأیید و ثبت'}</button>
          <button onClick={onCancel} className="tap rounded-lg border border-line bg-surface font-bold">لغو</button>
        </div>
        </>}
      </section>
    </div>
  );
}

function ConfidencePanel({ assessment }) {
  return <section className="mt-4 rounded-[10px] border border-line bg-surface p-3"><div className="flex items-center justify-between"><h3 className="text-sm font-extrabold">چرا این تصمیم؟</h3><span className="numbers text-xs text-muted">اطمینان کلی {toPersianDigits(assessment.percent)}٪</span></div><div className="mt-3 space-y-2">{Object.entries(assessment.fields).map(([field, detail]) => <div key={field} className="rounded-lg bg-paper px-3 py-2"><div className="flex items-center justify-between gap-2"><b className="text-xs">{REVIEW_FIELD_LABELS[field]}</b><span className={`numbers text-xs font-bold ${detail.score >= 0.82 ? 'text-income' : detail.score >= 0.7 ? 'text-accent' : 'text-expense'}`}>{toPersianDigits(Math.round(detail.score * 100))}٪</span></div><p className="mt-1 text-[11px] leading-5 text-muted">{detail.reason}</p></div>)}</div>{assessment.reasons.length > 0 && <div className="mt-3 border-t border-line pt-2">{assessment.reasons.map((reason) => <p key={reason} className="mt-1 text-[11px] leading-5 text-expense">• {reason}</p>)}</div>}</section>;
}

function CorrectionSheet({ draft, accounts, close, confirm }) {
  const [busy, setBusy] = useState(false);
  const { current, preview } = draft;
  const valueFor = (field, source) => {
    if (field === 'amount') return `${formatAmount(source.amount)} تومان`;
    if (field === 'type') return source.type === 'income' ? 'درآمد' : 'هزینه';
    if (field === 'account') return source.accountName || accounts.find((account) => account.id === source.accountId)?.name || 'حساب پیش‌فرض';
    return source.category;
  };
  const next = { ...current, ...preview.changes };
  const submit = async () => { setBusy(true); await confirm(); setBusy(false); };
  return <div className="fixed inset-0 z-[76] flex items-end justify-center bg-ink/40 backdrop-blur-[2px]"><section role="dialog" aria-modal="true" aria-label="تأیید اصلاح آخرین ثبت" className="sheet-in w-full max-w-[620px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl"><div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" /><span className="rounded-full bg-accent/10 px-2 py-1 text-[10px] font-extrabold text-accent">اصلاح مکالمه‌ای امن</span><h2 className="mt-3 text-xl font-extrabold">همین آخرین ثبت اصلاح شود؟</h2><blockquote className="mt-3 rounded-lg border border-line bg-surface px-3 py-3 text-sm text-muted">«{draft.command}»</blockquote><div className="mt-4 divide-y divide-line rounded-[10px] border border-line bg-surface px-3">{preview.changedFields.map((field) => <div key={field} className="py-3"><p className="text-xs font-bold text-muted">{REVIEW_FIELD_LABELS[field]}</p><div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm"><span className="truncate text-muted line-through">{valueFor(field, current)}</span><ChevronLeft size={17} className="text-accent" /><b className="truncate">{valueFor(field, next)}</b></div></div>)}</div><p className="mt-3 text-xs leading-6 text-muted">اصلاح فقط وقتی انجام می‌شود که این رکورد هنوز آخرین ثبت باشد؛ سند قبلی پاک نمی‌شود و با سند معکوس در تاریخچه می‌ماند.</p><div className="mt-5 grid grid-cols-[2fr_1fr] gap-2"><button disabled={busy} onClick={submit} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">{busy ? 'در حال اصلاح…' : 'تأیید اصلاح'}</button><button disabled={busy} onClick={close} className="tap rounded-lg border border-line bg-surface font-bold">لغو</button></div></section></div>;
}

function DuplicateSheet({ prompt, close, confirm }) {
  const [busy, setBusy] = useState(false);
  const duplicate = prompt.duplicates[0];
  const incoming = prompt.transactions[duplicate?.inputIndex || 0];
  const submit = async () => { setBusy(true); await confirm(); setBusy(false); };
  return <div className="fixed inset-0 z-[78] flex items-end justify-center bg-ink/45 backdrop-blur-[2px]"><section role="dialog" aria-modal="true" aria-label="هشدار ثبت تکراری" className="sheet-in w-full max-w-[620px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl"><div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" /><span className="rounded-full bg-warn-bg px-2 py-1 text-[10px] font-extrabold text-expense">نیازمند بررسی</span><h2 className="mt-3 text-xl font-extrabold">شاید این ثبت تکراری باشد</h2><p className="mt-2 text-sm leading-7 text-muted">مبلغ، حساب، زمان و متن با یک ثبت چند دقیقهٔ اخیر شباهت زیادی دارد. هیچ موردی خودکار ذخیره نمی‌شود.</p><div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-[10px] border border-line bg-surface p-3"><span className="text-[10px] font-bold text-muted">ثبت تازه</span><b className="numbers mt-2 block text-lg">{formatAmount(incoming?.amount || 0)}</b><p className="mt-1 truncate text-xs text-muted">{incoming?.rawText}</p></div><div className="rounded-[10px] border border-accent/30 bg-warn-bg p-3"><span className="text-[10px] font-bold text-muted">ثبت موجود · شباهت {toPersianDigits(duplicate?.similarity || 0)}٪</span><b className="numbers mt-2 block text-lg">{formatAmount(duplicate?.amount || 0)}</b><p className="mt-1 truncate text-xs text-muted">{duplicate?.rawText}</p></div></div><div className="mt-5 grid grid-cols-[2fr_1fr] gap-2"><button disabled={busy} onClick={submit} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">{busy ? 'در حال ثبت…' : 'بله، جداگانه ثبت کن'}</button><button disabled={busy} onClick={close} className="tap rounded-lg border border-line bg-surface font-bold">لغو</button></div></section></div>;
}

function LearningSuggestionSheet({ suggestion, close, confirm }) {
  const [busy, setBusy] = useState(false);
  const submit = async () => { setBusy(true); await confirm(); setBusy(false); };
  return <div className="fixed inset-0 z-[79] flex items-end justify-center bg-ink/40 backdrop-blur-[2px]"><section role="dialog" aria-modal="true" aria-label="پیشنهاد یادگیری" className="sheet-in w-full max-w-[540px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl"><div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" /><Sparkles className="text-accent" size={26} /><h2 className="mt-3 text-xl font-extrabold">این اصلاح را یاد بگیرم؟</h2><p className="mt-2 text-sm leading-7 text-muted">از این به بعد عبارت «<b className="text-ink">{suggestion.keyword}</b>» را در دستهٔ «<b className="text-ink">{suggestion.category}</b>» پیشنهاد می‌دهم. هر وقت بخواهی از صفحهٔ یادگیری قابل حذف است.</p><div className="mt-5 grid grid-cols-2 gap-2"><button disabled={busy} onClick={submit} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">{busy ? 'در حال ذخیره…' : 'بله، یاد بگیر'}</button><button disabled={busy} onClick={close} className="tap rounded-lg border border-line bg-surface font-bold">نه، فقط همین بار</button></div></section></div>;
}

function DecisionDetailsSheet({ item, close }) {
  const assessment = assessTransactionReview(item);
  const state = item.needsReview || item.reviewState === 'review' ? 'نیازمند بررسی' : ['reviewed', 'duplicate-confirmed'].includes(item.reviewState) ? 'بررسی‌شده توسط کاربر' : 'آماده ثبت';
  return <div className="fixed inset-0 z-[75] flex items-end justify-center bg-ink/35 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section role="dialog" aria-modal="true" aria-label="دلیل تصمیم تراکنش" className="sheet-in max-h-[92vh] w-full max-w-[620px] overflow-y-auto rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl"><div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" /><div className="flex items-start justify-between gap-3"><div><span className="rounded-full bg-surface px-2 py-1 text-[10px] font-extrabold text-accent">{state}</span><h2 className={`numbers mt-3 text-2xl font-extrabold ${item.type === 'income' ? 'text-income' : 'text-expense'}`}>{formatSignedAmount(item)} تومان</h2><p className="mt-1 text-sm text-muted">{item.category} · {item.accountName || 'حساب پیش‌فرض'}</p></div><button onClick={close} className="tap grid place-items-center" aria-label="بستن"><X /></button></div><blockquote className="mt-4 rounded-lg border border-line bg-surface px-3 py-3 text-sm leading-7 text-muted">«{item.rawText}»</blockquote><ConfidencePanel assessment={assessment} />{item.restoredFrom && <p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-xs leading-6 text-muted">این ثبت در پاسخ به «دوباره انجام بده» به‌صورت یک سند تازه ساخته شده است.</p>}<button onClick={close} className="tap mt-4 w-full rounded-lg border border-line bg-surface font-bold">بستن</button></section></div>;
}

function FailureSheet({ failure, close, retry, manual }) {
  return <div className="fixed inset-0 z-[70] flex items-end justify-center bg-ink/35 backdrop-blur-[2px]"><section role="dialog" className="sheet-in w-full max-w-[640px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)]"><div className="mx-auto mb-5 h-1 w-11 rounded-full bg-line" />{failure.transcript && <blockquote className="mb-4 rounded-lg border border-line bg-surface px-3 py-3 text-sm text-muted">«{failure.transcript}»</blockquote>}<span className="rounded-full bg-expense/10 px-2 py-1 text-[10px] font-extrabold text-expense">نامفهوم</span><CircleAlert className="mb-3 mt-3 text-expense" size={27} /><h2 className="text-xl font-extrabold">{failure.permission ? 'اجازهٔ میکروفن فعال نیست' : 'مبلغی پیدا نکردم'}</h2><p className="mt-2 text-[15px] leading-7 text-muted">{failure.message || 'جمله را دوباره بگو یا مبلغ را دستی بنویس. هیچ تراکنشی بدون تأیید تو ثبت نمی‌شود.'}</p>{failure.permission && <ol className="mt-3 list-decimal space-y-1 pr-5 text-sm leading-7"><li>روی علامت قفل کنار آدرس سایت بزن.</li><li>دسترسی «میکروفن» را روی مجاز بگذار.</li><li>صفحه را دوباره باز کن.</li></ol>}<div className="mt-5 grid grid-cols-2 gap-2"><button onClick={retry} className="tap flex items-center justify-center gap-2 rounded-lg bg-accent font-bold text-white"><RotateCcw size={18} />دوباره بگو</button><button onClick={manual} className="tap rounded-lg border border-line bg-surface font-bold">دستی بنویس</button></div><button onClick={close} className="tap mt-2 w-full text-sm text-muted">بستن</button></section></div>;
}

function ReportPage({ profileType = 'business', navigate, notify }) {
  const [range, setRange] = useState('month');
  const [report, setReport] = useState({ summary: EMPTY_SUMMARY, points: [], categories: [], insight: '' });
  const [overview, setOverview] = useState({ alerts: [], runway: null });
  const [loading, setLoading] = useState(true);
  const loadOverview = useCallback(() => api.overview().then(setOverview), []);
  useEffect(() => { setLoading(true); api.report(range).then(setReport).finally(() => setLoading(false)); }, [range]);
  useEffect(() => { loadOverview().catch(() => {}); }, [loadOverview]);
  const snooze = async (id) => { try { await api.snoozeAlert(id, 24); await loadOverview(); notify?.('این هشدار تا ۲۴ ساعت پنهان شد.'); } catch (error) { notify?.(error.message); } };
  const maximum = Math.max(1, ...report.points.flatMap((point) => [point.income, point.expense]));
  return <main className="px-4 py-5"><h1 className="text-xl font-extrabold">گزارش</h1><p className="mt-1 text-[13px] leading-6 text-muted">این گزارش بر پایهٔ دریافت و پرداخت‌های ثبت‌شده است و سود حسابداری محسوب نمی‌شود.</p><div className="mt-4 grid grid-cols-3 rounded-lg border border-line bg-surface p-1">{[['week', '۷ روز'], ['month', '۳۰ روز'], ['quarter', '۹۰ روز']].map(([value, label]) => <button key={value} onClick={() => setRange(value)} className={`tap rounded-md text-sm font-bold ${range === value ? 'bg-ink text-white' : 'text-muted'}`}>{label}</button>)}</div><div className="mt-5"><SummaryCard summary={report.summary} loading={loading} profileType={profileType} context="range" /></div>
    {report.insight && <div className="mt-4 rounded-lg border-r-4 border-accent bg-warn-bg px-3 py-3 text-sm leading-7">{report.insight}</div>}
    {overview.runway && <section id="runway" className="mt-7 rounded-[12px] border border-line bg-surface p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[11px] font-extrabold text-accent">تصمیم‌یار نقدینگی</p><h2 className="mt-1 text-[17px] font-extrabold">دوام نقدینگی در سه سناریو</h2><p className="mt-1 text-xs leading-6 text-muted">میانگین هزینهٔ روزانه: <b className="numbers text-ink">{formatAmount(overview.runway.averageDailyExpense)}</b> تومان · خط مبنا: {toPersianDigits(overview.runway.lookbackDays)} روز</p></div><span className="rounded-full bg-paper px-2.5 py-1 text-[10px] font-bold text-muted">بدون فرض درآمد آینده</span></div><div className="mt-4 grid grid-cols-3 gap-2">{overview.runway.scenarios.map((scenario) => <div key={scenario.id} className={`rounded-[10px] border px-2 py-3 text-center ${scenario.id === 'base' ? 'border-accent bg-warn-bg' : 'border-line bg-paper'}`}><p className="text-[11px] font-bold text-muted">{scenario.label}</p><p className="numbers mt-2 text-xl font-extrabold">{scenario.days == null ? '—' : toPersianDigits(scenario.days)}</p><p className="mt-1 text-[10px] text-muted">{scenario.days == null ? 'هزینه‌ای ثبت نشده' : 'روز'}</p></div>)}</div><details className="mt-4 border-t border-line pt-3 text-xs leading-6 text-muted"><summary className="cursor-pointer font-bold text-ink">روش محاسبه و منابع</summary><p className="mt-2">{overview.runway.formula}</p><p>{toPersianDigits(overview.runway.sources?.length || 0)} ثبت هزینه در بازهٔ {overview.runway.scope?.label} · واحد: {overview.runway.scope?.unit}</p><p className="mt-1">{overview.runway.disclaimer}</p></details></section>}
    {overview.alerts?.length > 0 && <section className="mt-7"><div className="flex items-end justify-between"><div><p className="text-[11px] font-extrabold text-accent">قابل توضیح و قابل اقدام</p><h2 className="mt-1 text-[17px] font-extrabold">هشدارهای فعال</h2></div><span className="text-xs text-muted">اولویت‌بندی‌شده</span></div><div className="mt-3 space-y-2">{overview.alerts.map((alert, index) => <article key={alert.id} className={`rounded-[10px] border p-3 ${index === 0 ? 'border-accent bg-warn-bg' : 'border-line bg-surface'}`}><div className="flex items-start gap-3"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${alert.level === 'danger' ? 'bg-expense' : 'bg-accent'}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-extrabold">{toPersianDigits(alert.title)}</h3>{index === 0 && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[9px] font-bold text-accent">اولویت امروز</span>}</div><p className="mt-1 text-xs leading-6 text-muted">{toPersianDigits(alert.detail)}</p><p className="mt-1 text-[10px] text-muted">{alert.scope?.label} · {toPersianDigits(alert.sources?.length || 0)} منبع · {alert.unit}</p></div><div className="flex shrink-0 flex-col gap-1">{alert.action?.screen && <button onClick={() => navigate?.(alert.action.screen, alert.action.tab || alert.action.target)} className="tap rounded-lg border border-line bg-surface px-3 text-xs font-bold">{alert.action.label}</button>}<button onClick={() => snooze(alert.id)} className="min-h-7 text-[10px] font-bold text-muted">۲۴ ساعت بعد</button></div></div></article>)}</div></section>}
    <section id="expenses" className="mt-7"><h2 className="text-[17px] font-extrabold">روند درآمد و هزینه</h2><div className="mt-3 flex h-56 items-end gap-3 border-b border-line bg-surface px-3 pt-5">{report.points.length ? report.points.map((point) => <div key={point.label} className="flex h-full min-w-0 flex-1 flex-col justify-end"><div className="flex flex-1 items-end justify-center gap-1"><span title={`درآمد ${formatAmount(point.income)}`} className="w-3 max-w-[16px] bg-income" style={{ height: `${Math.max(2, point.income / maximum * 100)}%` }} /><span title={`هزینه ${formatAmount(point.expense)}`} className="w-3 max-w-[16px] bg-expense" style={{ height: `${Math.max(2, point.expense / maximum * 100)}%` }} /></div><span className="mt-2 truncate text-center text-[11px] text-muted">{point.label}</span></div>) : <p className="m-auto text-sm text-muted">داده‌ای برای این بازه نیست.</p>}</div><div className="mt-2 flex gap-4 text-xs text-muted"><span><i className="ml-1 inline-block h-2 w-2 bg-income" />درآمد</span><span><i className="ml-1 inline-block h-2 w-2 bg-expense" />هزینه</span></div></section>
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
  const [worklist, setWorklist] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [chart, setChart] = useState({ analytics: [], costCenters: [] });
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
      // کارتابل و ابعاد نباید نبودشان کل صفحهٔ حسابداری را از کار بیندازد.
      const [nextWorklist, nextTemplates, nextChart] = await Promise.all([
        api.journalWorklist().catch(() => null),
        api.journalTemplates().catch(() => ({ items: [] })),
        api.chartOverview().catch(() => ({ analytics: [], costCenters: [] })),
      ]);
      setWorklist(nextWorklist); setTemplates(nextTemplates.items || []); setChart(nextChart);
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
    {canWrite && <JournalGridPanel accounts={accounts} analytics={chart.analytics || []} costCenters={chart.costCenters || []} templates={templates} notify={notify} refresh={load} />}
    <JournalWorklistPanel worklist={worklist} canApprove={["owner", "manager"].includes(role)} notify={notify} refresh={load} />
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
    <TaxAssistantPanel access={access} notify={notify} />
    <div className="mt-4 grid grid-cols-3 rounded-lg border border-line bg-surface p-1">{[[30, '۳۰ روز'], [90, '۹۰ روز'], [365, 'یک سال']].map(([value, label]) => <button key={value} onClick={() => setDays(value)} className={`tap rounded-md text-sm font-bold ${days === value ? 'bg-ink text-white' : 'text-muted'}`}>{label}</button>)}</div>
    <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">مالیات فروش</p><b className="numbers mt-2 block text-lg text-expense">{formatAmount(summary.outputTax || 0)}</b><span className="text-[10px] text-muted">تومان</span></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">اعتبار خرید</p><b className="numbers mt-2 block text-lg text-income">{formatAmount(summary.inputTax || 0)}</b><span className="text-[10px] text-muted">تومان</span></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">خالص برآوردی</p><b className={`numbers mt-2 block text-lg ${(summary.netTax || 0) > 0 ? 'text-expense' : 'text-income'}`}>{formatAmount(summary.netTax || 0)}</b><span className="text-[10px] text-muted">تومان</span></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">مالیات دستی قدیمی</p><b className="numbers mt-2 block text-lg">{formatAmount(summary.manualTax || 0)}</b><span className="text-[10px] text-muted">نیازمند بازبینی</span></div></div>
    <section className="mt-5 rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">تفکیک فروش</h2><div className="mt-3 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">مشمول</span><b className="numbers mt-2 block text-sm">{formatAmount(summary.taxableSales || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">نرخ صفر</span><b className="numbers mt-2 block text-sm">{formatAmount(summary.zeroSales || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">معاف</span><b className="numbers mt-2 block text-sm">{formatAmount(summary.exemptSales || 0)}</b></div></div><p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-[11px] leading-6 text-muted">«نرخ صفر» و «معاف» از نظر گزارش یکسان نیستند؛ انتخاب نوع صحیح بر عهده کسب‌وکار و حسابدار است.</p></section>
    {canManage && <form onSubmit={save} className="mt-5 rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">تعریف نرخ</h2><p className="mt-1 text-xs leading-6 text-muted">هیچ نرخ قانونی پیش‌فرضی داخل برنامه قرار نگرفته؛ نرخ معتبر خودت را وارد کن.</p><div className="mt-3 grid gap-2 sm:grid-cols-3"><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="مثلاً نرخ عمومی" className="tap rounded-lg border border-line px-3" /><select value={draft.treatment} onChange={(event) => setDraft({ ...draft, treatment: event.target.value, rate: event.target.value === 'taxable' ? draft.rate : '0' })} className="tap rounded-lg border border-line bg-surface px-3"><option value="taxable">مشمول</option><option value="zero">نرخ صفر</option><option value="exempt">معاف</option></select><label className="flex items-center rounded-lg border border-line px-3 text-xs text-muted">درصد<input required={draft.treatment === 'taxable'} disabled={draft.treatment !== 'taxable'} inputMode="decimal" value={draft.rate} onChange={(event) => setDraft({ ...draft, rate: event.target.value.replace(/[^0-9.]/g, '') })} className="tap numbers min-w-0 flex-1 bg-transparent text-left text-ink outline-none disabled:opacity-40" /></label></div><label className="mt-3 flex min-h-12 items-center gap-2 text-xs font-bold"><input type="checkbox" checked={draft.isDefault} onChange={(event) => setDraft({ ...draft, isDefault: event.target.checked })} />پیش‌فرض فاکتورهای تازه</label><button disabled={busy} className="tap mt-2 w-full rounded-lg bg-accent font-bold text-white disabled:opacity-40">ذخیره نرخ</button></form>}
    <section className="mt-6"><div className="flex items-center justify-between"><h2 className="font-extrabold">نرخ‌های تعریف‌شده</h2><span className="text-xs text-muted">{toPersianDigits(report.rates?.length || 0)} نرخ</span></div><div className="mt-2 divide-y divide-line border-y border-line">{report.rates?.map((rate) => <article key={rate.id} className="flex min-h-[68px] items-center gap-3 py-3"><div className={`h-2.5 w-2.5 rounded-full ${rate.active ? 'bg-income' : 'bg-muted'}`} /><div className="min-w-0 flex-1"><p className="font-bold">{rate.name}{rate.isDefault ? <span className="mr-2 rounded border border-accent px-1.5 py-0.5 text-[10px] text-accent">پیش‌فرض</span> : null}</p><p className="mt-1 text-xs text-muted">{treatmentLabels[rate.treatment]} · {toPersianDigits(rate.rate)}٪ · {rate.active ? 'فعال' : 'غیرفعال'}</p></div>{canManage && rate.id !== 'tax-none' && <button disabled={busy} onClick={() => toggle(rate)} className="tap rounded-lg border border-line px-3 text-xs font-bold text-muted">{rate.active ? 'غیرفعال' : 'فعال'}</button>}</article>)}</div></section>
    <section className="mt-6"><div className="flex items-center justify-between"><h2 className="font-extrabold">اسناد این بازه</h2><span className="text-xs text-muted">{toPersianDigits(report.rows?.length || 0)} سند</span></div><div className="mt-2 divide-y divide-line border-y border-line">{report.rows?.slice(0, 50).map((invoice) => <article key={invoice.id} className="flex min-h-[72px] items-center gap-3 py-3"><ReceiptText className={invoice.documentType === 'sales' ? 'text-income' : 'text-expense'} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold">{invoice.number} · {invoice.customerName}</p><p className="mt-1 text-xs text-muted">{invoice.documentType === 'sales' ? 'فروش' : 'خرید'} · {new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(invoice.issuedAt))}{invoice.manualTax ? ' · مالیات دستی' : ''}</p></div><div className="text-left"><b className="numbers block text-sm">{formatAmount(invoice.total)}</b><span className="numbers mt-1 block text-[10px] text-muted">مالیات {formatAmount(invoice.tax)}</span></div></article>)}</div></section>
    <p className="mt-5 rounded-lg border-r-4 border-accent bg-warn-bg px-3 py-3 text-xs leading-6 text-muted">{report.disclaimer || 'این گزارش مدیریتی است و جایگزین اظهارنامه یا صورتحساب رسمی نیست.'}</p>
  </main>;
}

function TaxAssistantPanel({ access, notify }) {
  const canManage = ['owner', 'manager'].includes(access.workspace?.role);
  const [question, setQuestion] = useState('');
  const [questionKind, setQuestionKind] = useState('general');
  const [items, setItems] = useState([]);
  const [sources, setSources] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sourceDraft, setSourceDraft] = useState({ title: '', issuer: '', officialUrl: '', summary: '', keywords: '', versionLabel: '', effectiveFrom: '', effectiveTo: '', verifiedAt: '' });
  const load = useCallback(async () => {
    try {
      const [questionResult, sourceResult] = await Promise.all([api.taxAssistantQuestions(), api.taxAssistantSources()]);
      setItems(questionResult.items || []); setSources(sourceResult.items || []);
    } catch (error) { notify(error.message); }
  }, [notify]);
  useEffect(() => { load(); }, [load, access.workspace?.id]);
  const ask = async (event) => {
    event.preventDefault(); if (!question.trim()) return;
    setBusy(true);
    try {
      const result = await api.askTaxAssistant({ question, questionKind });
      setQuestion(''); setItems((current) => [result.item, ...current]);
      notify(result.item.status === 'answered' ? 'پاسخ منبع‌دار آماده شد.' : 'سؤال برای بررسی متخصص ثبت شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const saveSource = async (event) => {
    event.preventDefault(); setBusy(true);
    try {
      await api.saveTaxAssistantSource({ ...sourceDraft, keywords: sourceDraft.keywords.split(/[،,]/).map((item) => item.trim()).filter(Boolean) });
      setSourceDraft({ title: '', issuer: '', officialUrl: '', summary: '', keywords: '', versionLabel: '', effectiveFrom: '', effectiveTo: '', verifiedAt: '' });
      await load(); notify('منبع رسمی نسخه‌دار ذخیره شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  const resolveQuestion = async (item) => {
    const activeSources = sources.filter((source) => !source.expired && source.status === 'active');
    if (!activeSources.length) return notify('قبل از پاسخ متخصص، دست‌کم یک منبع رسمی فعال ثبت کن.');
    const answer = window.prompt('پاسخ بررسی‌شدهٔ متخصص را بنویس. منبع فعال اول به پاسخ پیوست می‌شود:');
    if (!answer?.trim()) return;
    setBusy(true);
    try { await api.resolveTaxAssistantQuestion(item.id, { answer, sourceIds: [activeSources[0].id] }); await load(); notify('پاسخ متخصص همراه snapshot منبع ثبت شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(false); }
  };
  return <section className="mt-5 rounded-[12px] border border-accent/30 bg-warn-bg p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Sparkles size={19} className="text-accent" /><h2 className="font-extrabold">دستیار مالیاتی منبع‌دار</h2></div><p className="mt-2 max-w-2xl text-xs leading-6 text-muted">پاسخ خودکار فقط از خلاصهٔ تأییدشدهٔ منابع رسمی فعال ساخته می‌شود. سؤال پرونده‌ای، جریمه، معافیت یا اعتراض مستقیماً به متخصص ارجاع می‌شود.</p></div><span className="rounded-full border border-accent/30 bg-surface px-3 py-1 text-[10px] font-bold text-accent">بدون اقدام یا ارسال خودکار</span></div>
    <form onSubmit={ask} className="mt-4 rounded-lg border border-line bg-surface p-3"><textarea required minLength={8} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="مثلاً این هزینه طبق منبع رسمی چه شرایط عمومی‌ای دارد؟" className="min-h-20 w-full rounded-lg border border-line p-3 text-sm" /><div className="mt-2 flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-xs font-bold"><input type="radio" checked={questionKind === 'general'} onChange={() => setQuestionKind('general')} />اطلاعات عمومی</label><label className="flex items-center gap-2 text-xs font-bold"><input type="radio" checked={questionKind === 'case'} onChange={() => setQuestionKind('case')} />مربوط به پرونده من</label><button disabled={busy} className="tap mr-auto rounded-lg bg-ink px-5 text-sm font-bold text-white disabled:opacity-40">ثبت سؤال</button></div></form>
    <div className="mt-4 space-y-3">{items.slice(0, 10).map((item) => <article key={item.id} className="rounded-lg border border-line bg-surface p-3"><div className="flex items-start justify-between gap-3"><p className="text-sm font-bold leading-6">{item.question}</p><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${item.status === 'referred' ? 'bg-expense/10 text-expense' : 'bg-income/10 text-income'}`}>{item.status === 'referred' ? 'نیازمند متخصص' : item.status === 'resolved' ? 'پاسخ متخصص' : 'پاسخ منبع‌دار'}</span></div>{item.answer ? <p className="mt-3 whitespace-pre-line rounded-lg bg-paper px-3 py-2 text-xs leading-6">{item.answer}</p> : <p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-xs leading-6 text-expense">{item.referralReason}</p>}<div className="mt-3 flex flex-wrap gap-2">{item.sources?.map((source) => <a key={`${item.id}-${source.id}`} href={source.officialUrl} target="_blank" rel="noreferrer" className="rounded-md border border-line px-2 py-1 text-[10px] font-bold text-accent">{source.title} · {source.versionLabel} · معتبر از {toPersianDigits(source.effectiveFrom)}</a>)}</div>{canManage && item.status === 'referred' && <button disabled={busy} onClick={() => resolveQuestion(item)} className="tap mt-3 rounded-lg border border-accent px-3 text-xs font-bold text-accent disabled:opacity-40">ثبت پاسخ متخصص با منبع فعال</button>}<p className="mt-3 border-t border-line pt-2 text-[10px] leading-5 text-muted">{item.disclaimer}</p></article>)}</div>
    {canManage && <details className="mt-4 border-t border-accent/20 pt-3"><summary className="cursor-pointer text-xs font-extrabold">مدیریت منابع رسمی ({toPersianDigits(sources.length)})</summary><form onSubmit={saveSource} className="mt-3 grid gap-2 rounded-lg bg-surface p-3 sm:grid-cols-2"><input required value={sourceDraft.title} onChange={(event) => setSourceDraft({ ...sourceDraft, title: event.target.value })} placeholder="عنوان قانون یا بخشنامه" className="tap rounded-lg border border-line px-3" /><input required value={sourceDraft.issuer} onChange={(event) => setSourceDraft({ ...sourceDraft, issuer: event.target.value })} placeholder="صادرکننده رسمی" className="tap rounded-lg border border-line px-3" /><input required type="url" dir="ltr" value={sourceDraft.officialUrl} onChange={(event) => setSourceDraft({ ...sourceDraft, officialUrl: event.target.value })} placeholder="https://..." className="tap rounded-lg border border-line px-3 text-left" /><input required value={sourceDraft.versionLabel} onChange={(event) => setSourceDraft({ ...sourceDraft, versionLabel: event.target.value })} placeholder="نسخه / شماره ابلاغ" className="tap rounded-lg border border-line px-3" /><input required type="date" value={sourceDraft.effectiveFrom} onChange={(event) => setSourceDraft({ ...sourceDraft, effectiveFrom: event.target.value })} className="tap numbers rounded-lg border border-line px-3" /><input type="date" value={sourceDraft.effectiveTo} onChange={(event) => setSourceDraft({ ...sourceDraft, effectiveTo: event.target.value })} className="tap numbers rounded-lg border border-line px-3" /><input required type="date" value={sourceDraft.verifiedAt} onChange={(event) => setSourceDraft({ ...sourceDraft, verifiedAt: event.target.value })} className="tap numbers rounded-lg border border-line px-3" /><input required value={sourceDraft.keywords} onChange={(event) => setSourceDraft({ ...sourceDraft, keywords: event.target.value })} placeholder="کلیدواژه‌ها با ویرگول" className="tap rounded-lg border border-line px-3" /><textarea required value={sourceDraft.summary} onChange={(event) => setSourceDraft({ ...sourceDraft, summary: event.target.value })} placeholder="خلاصهٔ تأییدشده‌ای که مجاز است در پاسخ نمایش داده شود" className="min-h-24 rounded-lg border border-line p-3 sm:col-span-2" /><button disabled={busy} className="tap rounded-lg bg-accent font-bold text-white sm:col-span-2 disabled:opacity-40">ذخیره منبع نسخه‌دار</button></form><div className="mt-2 space-y-2">{sources.map((source) => <div key={source.id} className="rounded-lg bg-surface px-3 py-2 text-xs"><a href={source.officialUrl} target="_blank" rel="noreferrer" className="font-bold text-accent">{source.title}</a><p className="mt-1 text-[10px] text-muted">{source.issuer} · {source.versionLabel} · {source.expired ? 'منقضی/غیرفعال' : 'فعال'} · بازبینی {toPersianDigits(source.verifiedAt)}</p></div>)}</div></details>}
  </section>;
}

function LearningPage({ categories, notify }) {
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState({ keyword: '', category: 'خوراک' });
  const load = () => api.learnings().then((result) => setItems(result.items));
  useEffect(load, []);
  const save = async () => { if (!draft.keyword.trim()) return; await api.saveLearning(draft); setDraft({ ...draft, keyword: '' }); notify('یادگیری تازه ذخیره شد.'); load(); };
  const update = async (item, category) => { await api.updateLearning(item.id, { keyword: item.keyword, category }); load(); };
  const remove = async (id) => { await api.deleteLearning(id); notify('این یادگیری حذف شد.'); load(); };
  return <main className="px-4 py-5"><h1 className="text-xl font-extrabold">آنچه یاد گرفته‌ام</h1><p className="mt-2 text-sm leading-7 text-muted">فقط نگاشت‌هایی اینجا می‌مانند که خودت صریحاً تأیید کرده‌ای یا دستی ساخته‌ای. هر مورد را هر زمان بخواهی می‌توانی تغییر بدهی یا پاک کنی.</p><div className="mt-5 flex gap-2 rounded-[10px] border border-line bg-surface p-2"><input value={draft.keyword} onChange={(event) => setDraft({ ...draft, keyword: event.target.value })} placeholder="مثلاً اسنپ‌فود" className="tap min-w-0 flex-1 px-2 outline-none" /><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="tap max-w-32 rounded-lg border border-line px-2">{categories.map((category) => <option key={category.id}>{category.name}</option>)}</select><button onClick={save} className="tap grid place-items-center rounded-lg bg-accent text-white" aria-label="افزودن"><Plus size={21} /></button></div><div className="mt-5 divide-y divide-line border-y border-line">{items.length ? items.map((item) => <div key={item.id} className="flex min-h-[64px] items-center gap-2"><span className="min-w-0 flex-1 truncate font-bold">{item.keyword}</span><ChevronLeft size={17} className="text-muted" /><select value={item.category} onChange={(event) => update(item, event.target.value)} className="tap max-w-36 bg-transparent text-sm text-muted outline-none">{categories.map((category) => <option key={category.id}>{category.name}</option>)}</select><button onClick={() => remove(item.id)} className="tap grid place-items-center text-expense" aria-label={`حذف ${item.keyword}`}><Trash2 size={18} /></button></div>) : <p className="py-10 text-center text-sm text-muted">هنوز نگاشت تأییدشده‌ای ندارم.</p>}</div></main>;
}

function SettingsPage({ initial, accounts = [], notify, refresh, onLogout, canManage = false }) {
  const [settings, setSettings] = useState({ businessName: '', profileType: 'business', openingBalance: '0', lowBalanceThreshold: '2000000', alertSensitivity: 'balanced', ...initial });
  const [stats, setStats] = useState(null);
  useEffect(() => setSettings({ businessName: '', profileType: 'business', openingBalance: '0', lowBalanceThreshold: '2000000', alertSensitivity: 'balanced', ...initial }), [initial]);
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
      <label className="mt-3 block text-[13px] text-muted">حساسیت هشدارهای مالی<select value={settings.alertSensitivity || 'balanced'} onChange={(event) => setSettings({ ...settings, alertSensitivity: event.target.value })} className="tap mt-2 w-full rounded-lg border border-line bg-surface px-3 text-ink"><option value="low">کم؛ فقط تغییرهای بزرگ</option><option value="balanced">متعادل؛ پیشنهاد حساب‌یار</option><option value="high">زیاد؛ هشدار زودتر</option></select><span className="mt-1 block text-[11px] leading-5">مبلغ غیرعادی و رشد هزینه فقط با خط مبنای کافی سنجیده می‌شود؛ این گزینه آستانه را تغییر می‌دهد، نه داده را.</span></label>
      <div className="rounded-lg bg-warn-bg px-3 py-2 text-[12px] leading-6 text-muted">واحد نمایش و ذخیره نسخه فعلی تومان است. مهاجرت آینده به ریال بدون تغییر معنای مبالغ موجود انجام می‌شود.</div>
      <button onClick={save} className="tap w-full rounded-lg bg-accent font-bold text-white">ذخیره تنظیمات</button>
    </section>
    <section className="mt-5 border-y border-line py-4">
      <h2 className="font-extrabold">دقت صوت و حریم خصوصی</h2>
      <p className="mt-2 text-sm leading-7 text-muted">تشخیص اصلی با مدل تخصصی گفتار فارسی انجام می‌شود و مبلغ با قواعد قطعی استخراج می‌شود. اگر سرویس اصلی در دسترس نباشد، مسیر پشتیبان فعال می‌شود. کلیدها فقط روی سرور می‌مانند.</p>
      {stats && <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4"><div className="rounded-lg bg-paper p-2"><b className="numbers block">{toPersianDigits(stats.total || 0)}</b><span className="text-[11px] text-muted">پردازش</span></div><div className="rounded-lg bg-paper p-2"><b className="numbers block">{toPersianDigits(stats.averageFirstTranscript || 0)}</b><span className="text-[11px] text-muted">اولین متن؛ ms</span></div><div className="rounded-lg bg-paper p-2"><b className="numbers block">{toPersianDigits(stats.averageLatency || 0)}</b><span className="text-[11px] text-muted">نتیجه؛ ms</span></div><div className="rounded-lg bg-paper p-2"><b className="numbers block">{toPersianDigits(stats.reviewed || 0)}</b><span className="text-[11px] text-muted">نیاز به اصلاح</span></div></div>}
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

function SessionsPanel({ notify }) {
  const [sessions, setSessions] = useState([]);
  const [busy, setBusy] = useState('');
  const refresh = useCallback(() => api.sessions().then((result) => setSessions(result.items || [])).catch((error) => notify(error.message)), [notify]);
  useEffect(() => { refresh(); }, [refresh]);
  const revoke = async (id) => {
    setBusy(id);
    try { await api.revokeSession(id); await refresh(); notify('نشست انتخاب‌شده بسته شد.'); }
    catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const revokeOthers = async () => {
    setBusy('others');
    try {
      const result = await api.revokeOtherSessions();
      await refresh();
      notify(result.revoked ? `${toPersianDigits(result.revoked)} نشست دیگر بسته شد.` : 'نشست فعال دیگری وجود ندارد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  return <section className="mx-auto mt-5 max-w-[760px] px-4"><div className="rounded-[10px] border border-line bg-surface p-4"><div className="flex items-start gap-3"><Users className="mt-0.5 shrink-0 text-accent" size={22} /><div><h2 className="font-extrabold">دستگاه‌ها و نشست‌های فعال</h2><p className="mt-1 text-[13px] leading-6 text-muted">هر نشست حداکثر هفت روز اعتبار دارد. حساب‌یار فقط شناسهٔ یک‌طرفهٔ نشست را نمایش می‌دهد و توکن ورود هرگز برگردانده نمی‌شود.</p></div></div><div className="mt-4 divide-y divide-line border-y border-line">{sessions.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 py-3"><div><p className="text-sm font-bold">{item.current ? 'همین دستگاه' : 'نشست فعال'}</p><p className="mt-1 text-[11px] leading-5 text-muted">شروع: {new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt))}<br />انقضا: {new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.expiresAt))}</p></div>{item.current ? <span className="rounded-full bg-warn-bg px-3 py-1 text-xs font-bold text-accent">فعلی</span> : <button disabled={Boolean(busy)} onClick={() => revoke(item.id)} className="tap rounded-lg border border-expense px-3 text-xs font-bold text-expense disabled:opacity-40">{busy === item.id ? 'در حال بستن…' : 'بستن نشست'}</button>}</div>)}</div><button disabled={Boolean(busy) || sessions.every((item) => item.current)} onClick={revokeOthers} className="tap mt-3 w-full rounded-lg border border-line font-bold disabled:opacity-40">{busy === 'others' ? 'در حال بستن…' : 'بستن همهٔ دستگاه‌های دیگر'}</button></div></section>;
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

function persianPeriodToken(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit' }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}`;
}

function recentPersianPeriods(now = new Date(), count = 12) {
  const items = [];
  const seen = new Set();
  for (let offset = 0; offset < 420 && items.length < count; offset += 1) {
    const date = new Date(now.getTime() - offset * 86_400_000);
    const id = persianPeriodToken(date);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, label: new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'long' }).format(date) });
  }
  return items;
}

function tehranWeekStart(now = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', weekday: 'short' }).format(now);
  const daysSinceMonday = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekday] || 0;
  const monday = new Date(now.getTime() - daysSinceMonday * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(monday);
}

const APPROVAL_STYLE = {
  draft: 'border-line bg-surface text-muted',
  submitted: 'border-accent/40 bg-warn-bg text-accent',
  returned: 'border-expense/40 bg-expense/10 text-expense',
  approved: 'border-income/40 bg-income/10 text-income',
};

const EMPTY_GRID_ROW = { accountId: '', description: '', debit: '', credit: '', analyticId: '', costCenterId: '' };

function digitsOnly(value) {
  return String(value ?? '').replace(/[^\d۰-۹٠-٩]/g, '').replace(/[۰-۹٠-٩]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) >= 0 ? String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)) : String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

/**
 * گرید ثبت انبوه: کمک‌حسابدار روزی صدها ردیف می‌زند و باید بدون لمس ماوس کار کند.
 * Enter ردیف بعد، Ctrl+D کپی ردیف بالا، Ctrl+Enter ثبت سند.
 */
function JournalGridPanel({ accounts, analytics, costCenters, templates, notify, refresh }) {
  const [memo, setMemo] = useState('');
  const [rows, setRows] = useState([{ ...EMPTY_GRID_ROW }, { ...EMPTY_GRID_ROW }]);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);
  const gridRef = useRef(null);

  const postable = accounts.filter((item) => item.active !== 0);
  const totals = rows.reduce((sum, row) => ({
    debit: sum.debit + Number(digitsOnly(row.debit) || 0),
    credit: sum.credit + Number(digitsOnly(row.credit) || 0),
  }), { debit: 0, credit: 0 });
  const difference = totals.debit - totals.credit;
  const balanced = totals.debit > 0 && difference === 0;

  const update = (index, field, value) => setRows(rows.map((row, position) => (position === index ? { ...row, [field]: value } : row)));
  const addRow = () => setRows([...rows, { ...EMPTY_GRID_ROW }]);

  const focusCell = (rowIndex, field) => {
    requestAnimationFrame(() => {
      gridRef.current?.querySelector(`[data-cell="${rowIndex}-${field}"]`)?.focus();
    });
  };

  const onKeyDown = (event, index, field) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (index === rows.length - 1) { setRows([...rows, { ...EMPTY_GRID_ROW }]); focusCell(index + 1, 'accountId'); }
      else focusCell(index + 1, field);
      return;
    }
    // کپی ردیف بالا — همان چیزی که در نرم‌افزارهای حسابداری با Ctrl+D انجام می‌شود.
    if (event.key.toLowerCase() === 'd' && (event.ctrlKey || event.metaKey) && index > 0) {
      event.preventDefault();
      setRows(rows.map((row, position) => (position === index ? { ...rows[index - 1] } : row)));
    }
  };

  const applyTemplate = (templateId) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    setMemo(template.memo || template.name);
    setRows(template.lines.map((line) => ({
      accountId: line.accountId, description: line.description || '',
      debit: line.debit ? String(line.debit) : '', credit: line.credit ? String(line.credit) : '',
      analyticId: line.analyticId || '', costCenterId: line.costCenterId || '',
    })));
  };

  const submit = async () => {
    setErrors([]);
    const lines = rows
      .filter((row) => row.accountId && (digitsOnly(row.debit) || digitsOnly(row.credit)))
      .map((row) => ({
        accountId: row.accountId,
        debit: Number(digitsOnly(row.debit) || 0),
        credit: Number(digitsOnly(row.credit) || 0),
        description: row.description,
        analyticId: row.analyticId || null,
        costCenterId: row.costCenterId || null,
      }));
    if (lines.length < 2) { notify('سند باید حداقل دو آرتیکل با مبلغ داشته باشد.'); return; }
    setBusy(true);
    try {
      const result = await api.journalBatch([{ memo: memo || 'سند دستی', lines }]);
      notify(`سند شمارهٔ ${toPersianDigits(result.documentNumbers[0])} به‌شکل پیش‌نویس ثبت شد.`);
      setRows([{ ...EMPTY_GRID_ROW }, { ...EMPTY_GRID_ROW }]);
      setMemo('');
      await refresh();
      focusCell(0, 'accountId');
    } catch (error) {
      setErrors(error.details?.errors || [{ message: error.message }]);
      notify(error.message);
    }
    setBusy(false);
  };

  return <section className="mt-5 rounded-[10px] border border-line bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="font-bold">ثبت سند با کیبورد</p>
        <p className="mt-1 text-[12px] leading-6 text-muted">
          <b>Enter</b> ردیف بعد · <b>Ctrl+D</b> کپی ردیف بالا · <b>Ctrl+Enter</b> ثبت سند. سند به‌شکل پیش‌نویس ثبت می‌شود و تا کنترل نشود در خروجی حسابدار نمی‌آید.
        </p>
      </div>
      {templates.length > 0 && <label className="text-[12px] text-muted">الگوی سند
        <select onChange={(event) => applyTemplate(event.target.value)} value="" className="tap mr-2 rounded-lg border border-line bg-paper px-2 text-[13px] text-ink">
          <option value="">— انتخاب —</option>
          {templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>}
    </div>

    <input value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="شرح سند" className="tap mt-3 w-full rounded-lg border border-line bg-paper px-3 text-[13px]" />

    <div ref={gridRef} className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[720px] text-right text-[13px]">
        <thead className="border-b border-line text-[12px] text-muted"><tr>
          <th className="pb-2 pl-2 font-bold">حساب</th><th className="pb-2 pl-2 font-bold">شرح</th>
          <th className="pb-2 pl-2 font-bold">تفصیلی</th><th className="pb-2 pl-2 font-bold">مرکز هزینه</th>
          <th className="pb-2 pl-2 font-bold">بدهکار</th><th className="pb-2 font-bold">بستانکار</th>
        </tr></thead>
        <tbody>
          {rows.map((row, index) => <tr key={index} className="border-b border-line">
            <td className="py-1 pl-2"><select data-cell={`${index}-accountId`} value={row.accountId} onChange={(event) => update(index, 'accountId', event.target.value)} onKeyDown={(event) => onKeyDown(event, index, 'accountId')} className="tap w-44 rounded border border-line bg-paper px-1 text-[13px]"><option value="">—</option>{postable.map((item) => <option key={item.id} value={item.id}>{item.chartCode || item.code} · {item.name}</option>)}</select></td>
            <td className="py-1 pl-2"><input data-cell={`${index}-description`} value={row.description} onChange={(event) => update(index, 'description', event.target.value)} onKeyDown={(event) => onKeyDown(event, index, 'description')} className="tap w-36 rounded border border-line bg-paper px-1 text-[13px]" /></td>
            <td className="py-1 pl-2"><select data-cell={`${index}-analyticId`} value={row.analyticId} onChange={(event) => update(index, 'analyticId', event.target.value)} onKeyDown={(event) => onKeyDown(event, index, 'analyticId')} className="tap w-32 rounded border border-line bg-paper px-1 text-[13px]"><option value="">—</option>{analytics.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></td>
            <td className="py-1 pl-2"><select data-cell={`${index}-costCenterId`} value={row.costCenterId} onChange={(event) => update(index, 'costCenterId', event.target.value)} onKeyDown={(event) => onKeyDown(event, index, 'costCenterId')} className="tap w-32 rounded border border-line bg-paper px-1 text-[13px]"><option value="">—</option>{costCenters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></td>
            <td className="py-1 pl-2"><input data-cell={`${index}-debit`} inputMode="numeric" value={row.debit} onChange={(event) => update(index, 'debit', digitsOnly(event.target.value))} onKeyDown={(event) => onKeyDown(event, index, 'debit')} className="numbers tap w-28 rounded border border-line bg-paper px-1 text-[13px]" /></td>
            <td className="py-1"><input data-cell={`${index}-credit`} inputMode="numeric" value={row.credit} onChange={(event) => update(index, 'credit', digitsOnly(event.target.value))} onKeyDown={(event) => onKeyDown(event, index, 'credit')} className="numbers tap w-28 rounded border border-line bg-paper px-1 text-[13px]" /></td>
          </tr>)}
        </tbody>
        <tfoot><tr className="text-[13px] font-bold">
          <td colSpan={4} className="py-2 pl-2 text-muted">جمع</td>
          <td className="numbers py-2 pl-2">{formatAmount(totals.debit)}</td>
          <td className="numbers py-2">{formatAmount(totals.credit)}</td>
        </tr></tfoot>
      </table>
    </div>

    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button type="button" onClick={addRow} className="tap rounded-lg border border-line bg-paper px-3 text-[13px] font-bold">افزودن ردیف</button>
      <button type="button" disabled={busy || !balanced} onClick={submit} className="tap rounded-lg bg-accent px-4 font-bold text-white disabled:opacity-45">{busy ? 'در حال ثبت…' : 'ثبت سند (Ctrl+Enter)'}</button>
      {!balanced && totals.debit + totals.credit > 0 && <span className="text-[13px] font-bold text-expense">اختلاف <span className="numbers">{formatAmount(Math.abs(difference))}</span> تومان</span>}
      {balanced && <span className="text-[13px] font-bold text-income">سند متوازن است</span>}
    </div>

    {errors.length > 0 && <ul className="mt-3 space-y-1 rounded-lg border border-expense/40 bg-expense/5 p-3 text-[12px] leading-6 text-expense">
      {errors.map((item, index) => <li key={index}>{item.position ? `سند ${toPersianDigits(item.position)}: ` : ''}{item.message}</li>)}
    </ul>}
  </section>;
}

/** کارتابل سند: چه چیزی پیش‌نویس است، چه چیزی منتظر کنترل و چه چیزی برگشت خورده. */
function JournalWorklistPanel({ worklist, canApprove, notify, refresh }) {
  const [busy, setBusy] = useState('');
  const summary = worklist?.summary;

  const move = async (id, state) => {
    const reason = state === 'returned' ? window.prompt('دلیل برگشت سند (حداقل ۱۰ نویسه):') : '';
    if (state === 'returned' && !reason) return;
    setBusy(id);
    try { await api.setJournalApproval(id, state, reason || ''); await refresh(); notify('وضعیت سند به‌روز شد.'); }
    catch (error) { notify(error.message); }
    setBusy('');
  };

  if (!summary) return null;
  return <section className="mt-5 rounded-[10px] border border-line bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="font-bold">کارتابل سند</p>
      <div className="flex flex-wrap gap-1.5 text-[12px]">
        {['draft', 'submitted', 'returned'].map((state) => <span key={state} className={`rounded border px-2 py-0.5 font-bold ${APPROVAL_STYLE[state]}`}>
          {worklist.states.find((item) => item.id === state)?.label}: <span className="numbers">{toPersianDigits(summary[state])}</span>
        </span>)}
      </div>
    </div>

    {canApprove && worklist.checkers?.soloChecker && <p className="mt-3 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] leading-6 text-muted">
      این دفتر کنترل‌کنندهٔ دیگری ندارد، پس می‌توانی سند خودت را تأیید کنی؛ هر خودتأییدی در Audit Log ثبت می‌شود.
      برای تفکیک واقعی ثبت‌کننده و کنترل‌کننده، یک عضو با نقش مدیر اضافه کن.
    </p>}

    {summary.clear && <p className="mt-3 text-[13px] text-income">هیچ سندی در جریان نمانده است.</p>}

    {!summary.clear && <div className="mt-3 divide-y divide-line">
      {worklist.items.map((item) => <article key={item.id} className="flex flex-wrap items-center gap-3 py-3">
        <span className={`rounded border px-2 py-0.5 text-[11px] font-bold ${APPROVAL_STYLE[item.approvalState]}`}>{item.approvalLabel}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold">سند <span className="numbers">{toPersianDigits(item.documentNumber || '—')}</span> · {item.memo || 'بدون شرح'}</p>
          <p className="mt-0.5 text-[11px] text-muted">{persianDate(item.occurredAt)} · <span className="numbers">{formatAmount(item.total)}</span> تومان</p>
          {item.returnReason && <p className="mt-1 text-[11px] leading-5 text-expense">دلیل برگشت: {item.returnReason}</p>}
        </div>
        <div className="flex gap-1.5">
          {['draft', 'returned'].includes(item.approvalState) && <button disabled={busy === item.id} onClick={() => move(item.id, 'submitted')} className="tap rounded-lg border border-line bg-paper px-3 text-[12px] font-bold">ارسال برای کنترل</button>}
          {item.approvalState === 'submitted' && canApprove && <>
            <button disabled={busy === item.id} onClick={() => move(item.id, 'approved')} className="tap rounded-lg bg-accent px-3 text-[12px] font-bold text-white">تأیید</button>
            <button disabled={busy === item.id} onClick={() => move(item.id, 'returned')} className="tap rounded-lg border border-expense/50 px-3 text-[12px] font-bold text-expense">برگشت</button>
          </>}
          {item.approvalState === 'submitted' && !canApprove && <span className="text-[11px] text-muted">کنترل با نقش مدیر است</span>}
        </div>
      </article>)}
    </div>}
  </section>;
}

const CHART_LEVEL_STYLE = { group: 'font-extrabold', general: 'font-bold pr-4', subsidiary: 'pr-8 text-muted' };

function ChartMappingRow({ item, chartAccounts, notify, onChanged }) {
  const [saving, setSaving] = useState(false);
  const options = chartAccounts.filter((account) => account.postable && account.active && account.type === item.type);
  const choose = async (chartAccountId) => {
    setSaving(true);
    try { await api.mapLedgerAccount(item.id, chartAccountId || null); await onChanged(); }
    catch (error) { notify(error.message); }
    setSaving(false);
  };
  return <tr className="border-b border-line">
    <td className="py-2 pl-3"><span className="numbers text-muted">{toPersianDigits(item.code)}</span></td>
    <td className="py-2 pl-3"><p className="truncate font-bold">{item.name}</p><p className="text-[11px] text-muted">{item.typeLabel}</p></td>
    <td className="py-2 pl-3">
      <select
        value={item.chartAccountId || ''} disabled={saving || !options.length}
        onChange={(event) => choose(event.target.value)}
        className={`tap w-full rounded-lg border px-2 text-[13px] ${item.mapped ? 'border-line bg-surface' : 'border-expense/50 bg-expense/5'}`}
      >
        <option value="">— بدون نگاشت —</option>
        {options.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
      </select>
      {!item.mapped && item.suggestion && <p className="mt-1 text-[11px] text-accent">پیشنهاد: {item.suggestion.code} · {item.suggestion.name}</p>}
      {!options.length && <p className="mt-1 text-[11px] text-expense">هیچ معین هم‌نوعی در کدینگ نیست.</p>}
    </td>
  </tr>;
}

function ChartPage({ access, notify }) {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [csv, setCsv] = useState('');
  const [tab, setTab] = useState('mapping');
  const [dimension, setDimension] = useState(null);
  const canManage = ['owner', 'manager'].includes(access?.workspace?.role);

  const load = useCallback(async () => {
    setLoading(true);
    try { setOverview(await api.chartOverview()); }
    catch (error) { notify(error.message); }
    setLoading(false);
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  // پیام موفقیت گاهی به نتیجه بستگی دارد («۳ نگاشت منتقل شد» در برابر «چیزی
  // تغییر نکرد»)، پس مقدار برگشتی اقدام هم می‌تواند پیام باشد.
  const run = async (action, success) => {
    try { const outcome = await action(); await load(); notify(typeof outcome === 'string' ? outcome : success); }
    catch (error) { notify(error.details?.errors?.[0] ? `ردیف ${error.details.errors[0].rowNumber}: ${error.details.errors[0].message}` : error.message); }
  };

  const mapping = overview?.mapping;
  const accounts = overview?.accounts || [];

  return <section className="mx-auto max-w-[1100px] px-4 py-6">
    <div>
      <p className="text-[13px] font-bold text-accent">فاز ۲ · کدینگ دفتر</p>
      <h1 className="mt-1 text-xl font-extrabold">کدینگ، تفصیلی شناور و مرکز هزینه</h1>
      <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
        کدینگ دفتر خودت را وارد کن و حساب‌های حساب‌یار را به معین‌های آن نگاشت بده. کد داخلی حساب‌یار حذف نمی‌شود تا اسناد قبلی دست‌نخورده بمانند؛ خروجی حسابدار کد کدینگ تو را می‌برد.
      </p>
    </div>

    {mapping && <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <FirmSummaryTile label="حساب کدینگ" value={toPersianDigits(mapping.chartAccountCount)} hint={`${toPersianDigits(mapping.postableCount)} معین قابل ثبت`} />
      <FirmSummaryTile label="نگاشت‌شده" value={toPersianDigits(mapping.mappedCount)} tone="text-income" />
      <FirmSummaryTile label="بدون نگاشت" value={toPersianDigits(mapping.unmappedCount)} tone={mapping.unmappedCount ? 'text-expense' : ''} hint={mapping.unmappedCount ? 'تا رفع نشود، خروجی حسابدار ساخته نمی‌شود' : ''} />
      <FirmSummaryTile label="پیشنهاد آماده" value={toPersianDigits(mapping.suggestionsAvailable)} hint="با یک کلیک قابل اعمال است" />
    </div>}

    {!loading && !mapping?.chartInstalled && <div className="mt-5 rounded-[10px] border border-accent/40 bg-warn-bg px-4 py-4">
      <p className="font-bold text-accent">هنوز کدینگی برای این دفتر تعریف نشده است.</p>
      <p className="mt-1 text-[13px] leading-6 text-muted">یا کدینگ پیشنهادی حساب‌یار را نصب کن و بعد ویرایشش کن، یا فایل کدینگ خود دفتر را وارد کن. کدینگ پیشنهادی یک نقطهٔ شروع است، نه کدینگ رسمی.</p>
      {canManage && <button onClick={() => run(() => api.installChartTemplate(), 'کدینگ پیشنهادی نصب شد.')} className="tap mt-3 rounded-lg bg-accent px-4 font-bold text-white">نصب کدینگ پیشنهادی</button>}
    </div>}

    <div className="mt-6 flex flex-wrap gap-1.5 border-b border-line pb-2 text-[13px] font-bold">
      {[['mapping', 'نگاشت حساب‌ها'], ['chart', 'درخت کدینگ'], ['dimensions', 'تفصیلی و مرکز هزینه'], ['import', 'ورود کدینگ']].map(([id, label]) => (
        <button key={id} onClick={() => setTab(id)} className={`tap rounded-lg px-3 ${tab === id ? 'bg-warn-bg text-accent' : 'text-muted hover:bg-surface'}`}>{label}</button>
      ))}
    </div>

    {tab === 'mapping' && mapping && <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">هر حساب داخلی حساب‌یار باید یک معین مقصد در کدینگ داشته باشد.</p>
        <div className="flex flex-wrap gap-2">
          {canManage && mapping.suggestionsAvailable > 0 && <button onClick={() => run(() => api.applyChartSuggestions(), 'پیشنهادها اعمال شدند.')} className="tap rounded-lg border border-line bg-surface px-4 text-sm font-bold">اعمال {toPersianDigits(mapping.suggestionsAvailable)} پیشنهاد</button>}
          {/* نگاشت‌های قدیمی پیش از شناختن معین اختصاصی دسته‌ها ساخته شده‌اند و
              همه روی «سایر هزینه‌های عملیاتی» نشسته‌اند. اصلاحشان تصمیم کاربر
              است، نه بازنویسی خاموش. */}
          {canManage && mapping.mappedCount > 0 && <button
            onClick={() => run(async () => {
              const result = await api.applyChartSuggestions({ refine: true });
              return result.refined > 0
                ? `${toPersianDigits(result.refined)} نگاشت عمومی به معین دقیق‌تر منتقل شد.`
                : 'نگاشت عمومیِ قابل اصلاحی پیدا نشد؛ چیزی تغییر نکرد.';
            })}
            className="tap rounded-lg border border-line bg-surface px-4 text-sm font-bold"
          >اصلاح نگاشت‌های عمومی</button>}
        </div>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] text-right text-[13px]">
          <thead className="border-b border-line text-[12px] text-muted"><tr><th className="pb-2 pl-3 font-bold">کد داخلی</th><th className="pb-2 pl-3 font-bold">حساب حساب‌یار</th><th className="pb-2 pl-3 font-bold">معین کدینگ دفتر</th></tr></thead>
          <tbody>{mapping.items.map((item) => <ChartMappingRow key={item.id} item={item} chartAccounts={accounts} notify={notify} onChanged={load} />)}</tbody>
        </table>
      </div>
    </div>}

    {tab === 'chart' && <div className="mt-4 overflow-x-auto">
      {!accounts.length && <p className="py-8 text-center text-sm text-muted">کدینگی برای نمایش نیست.</p>}
      <table className="w-full min-w-[560px] text-right text-[13px]">
        <thead className="border-b border-line text-[12px] text-muted"><tr><th className="pb-2 pl-3 font-bold">کد</th><th className="pb-2 pl-3 font-bold">نام</th><th className="pb-2 pl-3 font-bold">سطح</th><th className="pb-2 pl-3 font-bold">نوع</th><th className="pb-2 font-bold">حساب متصل</th></tr></thead>
        <tbody>{accounts.map((item) => <tr key={item.id} className="border-b border-line">
          <td className="numbers py-2 pl-3">{toPersianDigits(item.code)}</td>
          <td className={`py-2 pl-3 ${CHART_LEVEL_STYLE[item.level]}`}>{item.name}</td>
          <td className="py-2 pl-3 text-muted">{item.levelLabel}</td>
          <td className="py-2 pl-3 text-muted">{item.typeLabel}</td>
          <td className="numbers py-2 text-muted">{item.postable ? toPersianDigits(item.mappedAccounts) : '—'}</td>
        </tr>)}</tbody>
      </table>
    </div>}

    {tab === 'dimensions' && <DimensionsPanel overview={overview} canManage={canManage} notify={notify} refresh={load} dimension={dimension} setDimension={setDimension} />}

    {tab === 'import' && <div className="mt-4 space-y-5">
      <ExcelImportPanel canManage={canManage} notify={notify} refresh={load} />
      <p className="border-t border-line pt-4 text-[13px] leading-6 text-muted">
        یا کدینگ را به‌شکل متن CSV اینجا بچسبان. سرستون‌های «کد، نام، سطح، کد والد، نوع»؛ سطح یکی از گروه/کل/معین و نوع یکی از دارایی/بدهی/سرمایه/درآمد/هزینه است.
        کد فرزند باید با کد والد شروع شود. اگر حتی یک ردیف ایراد داشته باشد، هیچ ردیفی وارد نمی‌شود.
      </p>
      <textarea
        value={csv} onChange={(event) => setCsv(event.target.value)} rows={10} dir="ltr"
        placeholder={'کد,نام,سطح,کد والد,نوع\n1,دارایی‌های جاری,گروه,,دارایی\n11,موجودی نقد و بانک,کل,1,دارایی\n1101,صندوق,معین,11,دارایی'}
        className="numbers w-full rounded-lg border border-line bg-surface p-3 text-[13px] outline-none focus:border-accent"
      />
      <button disabled={!canManage || !csv.trim()} onClick={() => run(async () => { await api.importChart(csv); setCsv(''); }, 'کدینگ وارد شد.')} className="tap rounded-lg bg-accent px-4 font-bold text-white disabled:opacity-45">ورود کدینگ</button>
      {!canManage && <p className="text-[12px] text-muted">تغییر کدینگ فقط از نقش مدیر یا مالک انجام می‌شود.</p>}
    </div>}
  </section>;
}

function DimensionsPanel({ overview, canManage, notify, refresh, dimension, setDimension }) {
  const [analyticName, setAnalyticName] = useState('');
  const [analyticKind, setAnalyticKind] = useState('project');
  const [centerName, setCenterName] = useState('');
  const [kind, setKind] = useState('costCenter');

  const loadBalance = useCallback(async (target) => {
    try { setDimension(await api.dimensionBalance({ dimension: target })); }
    catch (error) { notify(error.message); }
  }, [notify, setDimension]);

  useEffect(() => { loadBalance(kind); }, [kind, loadBalance]);

  const add = async (action) => {
    try { await action(); await refresh(); await loadBalance(kind); notify('ثبت شد.'); }
    catch (error) { notify(error.message); }
  };

  return <div className="mt-4 space-y-6">
    <p className="text-[13px] leading-6 text-muted">
      تفصیلی شناور و مرکز هزینه روی «آرتیکل سند» می‌نشینند، نه روی حساب. یعنی یک معین «حساب‌های دریافتنی» داری و مشتری‌ها زیر آن تفصیلی می‌شوند؛ برای هر مشتری یک حساب کل تازه ساخته نمی‌شود.
    </p>

    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-[10px] border border-line bg-surface p-3">
        <p className="font-bold">تفصیلی شناور</p>
        {canManage && <form onSubmit={(event) => { event.preventDefault(); add(async () => { await api.saveAnalytic({ name: analyticName, kind: analyticKind }); setAnalyticName(''); }); }} className="mt-2 flex flex-wrap gap-2">
          <input required value={analyticName} onChange={(event) => setAnalyticName(event.target.value)} placeholder="مثلاً پروژهٔ برج آبان" className="tap min-w-40 flex-1 rounded-lg border border-line bg-paper px-3 text-[13px]" />
          <select value={analyticKind} onChange={(event) => setAnalyticKind(event.target.value)} className="tap rounded-lg border border-line bg-paper px-2 text-[13px]"><option value="project">پروژه</option><option value="employee">پرسنل</option><option value="custom">سایر</option></select>
          <button className="tap rounded-lg bg-accent px-4 text-sm font-bold text-white">افزودن</button>
        </form>}
        <ul className="mt-3 divide-y divide-line text-[13px]">
          {(overview?.analytics || []).map((item) => <li key={item.id} className="flex items-center justify-between py-2">
            <span><b className="numbers text-muted">{toPersianDigits(item.code)}</b> · {item.name}</span>
            <span className="text-[11px] text-muted">{item.kindLabel}</span>
          </li>)}
          {!overview?.analytics?.length && <li className="py-3 text-muted">هنوز تفصیلی‌ای تعریف نشده؛ طرف‌حساب‌های فاکتور خودکار اضافه می‌شوند.</li>}
        </ul>
      </section>

      <section className="rounded-[10px] border border-line bg-surface p-3">
        <p className="font-bold">مرکز هزینه</p>
        {canManage && <form onSubmit={(event) => { event.preventDefault(); add(async () => { await api.saveCostCenter({ name: centerName }); setCenterName(''); }); }} className="mt-2 flex flex-wrap gap-2">
          <input required value={centerName} onChange={(event) => setCenterName(event.target.value)} placeholder="مثلاً شعبهٔ مرکزی" className="tap min-w-40 flex-1 rounded-lg border border-line bg-paper px-3 text-[13px]" />
          <button className="tap rounded-lg bg-accent px-4 text-sm font-bold text-white">افزودن</button>
        </form>}
        <ul className="mt-3 divide-y divide-line text-[13px]">
          {(overview?.costCenters || []).map((item) => <li key={item.id} className="py-2"><b className="numbers text-muted">{toPersianDigits(item.code)}</b> · {item.name}</li>)}
          {!overview?.costCenters?.length && <li className="py-3 text-muted">هنوز مرکز هزینه‌ای تعریف نشده است.</li>}
        </ul>
      </section>
    </div>

    <section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-bold">گردش هر بعد</p>
        <select value={kind} onChange={(event) => setKind(event.target.value)} className="tap rounded-lg border border-line bg-surface px-2 text-[13px]"><option value="costCenter">مرکز هزینه</option><option value="analytic">تفصیلی شناور</option></select>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-right text-[13px]">
          <thead className="border-b border-line text-[12px] text-muted"><tr><th className="pb-2 pl-3 font-bold">کد</th><th className="pb-2 pl-3 font-bold">نام</th><th className="pb-2 pl-3 font-bold">بدهکار</th><th className="pb-2 pl-3 font-bold">بستانکار</th><th className="pb-2 font-bold">مانده</th></tr></thead>
          <tbody>
            {(dimension?.rows || []).map((row) => <tr key={row.id} className="border-b border-line">
              <td className="numbers py-2 pl-3 text-muted">{toPersianDigits(row.code)}</td>
              <td className="py-2 pl-3">{row.name}</td>
              <td className="numbers py-2 pl-3">{formatAmount(row.debit)}</td>
              <td className="numbers py-2 pl-3">{formatAmount(row.credit)}</td>
              <td className="numbers py-2 font-bold">{formatAmount(Math.abs(row.balance))}</td>
            </tr>)}
            {dimension && <tr className="bg-surface"><td className="py-2 pl-3 text-muted">—</td><td className="py-2 pl-3 text-muted">بدون تخصیص</td>
              <td className="numbers py-2 pl-3 text-muted">{formatAmount(dimension.unassigned.debit)}</td>
              <td className="numbers py-2 pl-3 text-muted">{formatAmount(dimension.unassigned.credit)}</td>
              <td className="numbers py-2 text-muted">{toPersianDigits(dimension.unassigned.lineCount)} ردیف</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-muted">ردیف «بدون تخصیص» عمداً نمایش داده می‌شود؛ گزارش بعد بدون آن گمراه‌کننده است.</p>
    </section>
  </div>;
}

const FIRM_LEVEL_STYLE = {
  blocked: { badge: 'border-expense/40 bg-expense/10 text-expense', dot: 'bg-expense' },
  attention: { badge: 'border-accent/40 bg-warn-bg text-accent', dot: 'bg-accent' },
  ready: { badge: 'border-income/40 bg-income/10 text-income', dot: 'bg-income' },
  unknown: { badge: 'border-line bg-surface text-muted', dot: 'bg-muted' },
};

const FIRM_BATCH_LABELS = { generated: 'ساخته شده', delivered: 'تحویل شده', accepted: 'تأیید شده', rejected: 'رد شده' };

function FirmSummaryTile({ label, value, hint, tone = '' }) {
  return <div className="rounded-[10px] border border-line bg-surface px-3 py-3">
    <p className="text-[12px] text-muted">{label}</p>
    <p className={`numbers mt-1 text-2xl font-extrabold ${tone}`}>{value}</p>
    {hint && <p className="mt-1 text-[11px] leading-5 text-muted">{hint}</p>}
  </div>;
}

function FirmClientRow({ client, onOpen, isActive }) {
  const style = FIRM_LEVEL_STYLE[client.level] || FIRM_LEVEL_STYLE.unknown;
  const batch = client.delivery?.lastBatch || null;
  return <article className="grid gap-3 border-b border-line py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] lg:items-start">
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
        <p className="truncate font-extrabold">{client.workspace?.name || 'بدون نام'}</p>
        {isActive && <span className="rounded border border-line px-1.5 text-[10px] font-bold text-muted">دفتر فعال</span>}
      </div>
      <p className="mt-1 text-[12px] text-muted">
        <span className={`inline-block rounded border px-1.5 py-0.5 font-bold ${style.badge}`}>{client.levelLabel}</span>
        {client.periodLocked && <span className="mr-2">· دوره قفل است</span>}
        {client.idleDays == null
          ? <span className="mr-2">· هنوز فعالیتی ثبت نشده</span>
          : <span className="mr-2">· آخرین فعالیت {toPersianDigits(client.idleDays)} روز پیش</span>}
      </p>
    </div>
    <div className="min-w-0 text-[12px] leading-6">
      {client.error && <p className="text-expense">{client.error}</p>}
      {!client.error && !client.blockers.length && !client.warnings.length && <p className="text-muted">هیچ کار بازی روی این پرونده نیست.</p>}
      <div className="flex flex-wrap gap-1.5">
        {client.blockers.map((item) => <span key={item.id} className="rounded border border-expense/40 bg-expense/10 px-2 py-0.5 font-bold text-expense">{item.label}{item.count > 1 && <span className="numbers"> · {toPersianDigits(item.count)}</span>}</span>)}
        {client.warnings.map((item) => <span key={item.id} className="rounded border border-line bg-surface px-2 py-0.5 text-muted">{item.label}{item.id !== 'stale' && item.count > 1 && <span className="numbers"> · {toPersianDigits(item.count)}</span>}</span>)}
      </div>
      {client.activity && <p className="mt-2 text-[11px] text-muted">
        <span className="numbers">{toPersianDigits(client.activity.transactionCount)}</span> ثبت این ماه ·
        درآمد <b className="numbers text-income">{formatAmount(client.activity.income)}</b> ·
        هزینه <b className="numbers text-expense">{formatAmount(client.activity.expense)}</b>
      </p>}
      {batch && <p className="mt-1 text-[11px] text-muted">آخرین خروجی {batch.period} — {FIRM_BATCH_LABELS[batch.status] || batch.status}</p>}
    </div>
    <button onClick={() => onOpen(client.workspace?.id)} disabled={isActive} className="tap h-10 shrink-0 rounded-lg border border-line bg-surface px-4 text-sm font-bold disabled:opacity-45">
      {isActive ? 'همین‌جا هستی' : 'باز کردن پرونده'}
    </button>
  </article>;
}

/** ساخت پروندهٔ مشتری تازه از داخل میز کار، بدون رفتن به تنظیمات. */
function AddClientForm({ notify, onAdded }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.createWorkspace({ name, profileType: 'business' });
      setName('');
      await onAdded();
      notify('پروندهٔ مشتری ساخته شد.');
    } catch (error) { notify(error.message); }
    setBusy(false);
  };
  return <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
    <input required minLength={2} value={name} onChange={(event) => setName(event.target.value)} placeholder="نام شرکت مشتری" className="tap min-w-52 flex-1 rounded-lg border border-line bg-paper px-3 text-[13px]" />
    <button disabled={busy} className="tap rounded-lg bg-accent px-4 text-sm font-bold text-white disabled:opacity-45">{busy ? 'در حال ساخت…' : 'افزودن پروندهٔ مشتری'}</button>
  </form>;
}

function FirmConsolePage({ access, notify, switchWorkspace, refreshAccess }) {
  const [portfolio, setPortfolio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      setPortfolio(await api.firmPortfolio({ refresh }));
      setError('');
    } catch (failure) { setError(failure.message || 'خواندن میز کار ممکن نشد.'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(false); }, [load]);

  const summary = portfolio?.summary;
  const clients = portfolio?.clients || [];
  const activeId = access?.workspace?.id;

  return <section className="mx-auto max-w-[1100px] px-4 py-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-[13px] font-bold text-accent">میز کار دفتر حسابداری</p>
        <h1 className="mt-1 text-xl font-extrabold">امروز کدام پرونده کار دارد؟</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
          فقط پرونده‌هایی که عضو آن‌ها هستی دیده می‌شوند. ترتیب بر اساس فوریت است، نه الفبا. ارقام تا آخرین بازخوانی معتبرند و ادعای تأیید مالیاتی ندارند.
        </p>
      </div>
      <button onClick={() => load(true)} disabled={loading} className="tap h-10 rounded-lg border border-line bg-surface px-4 text-sm font-bold disabled:opacity-45">
        {loading ? 'در حال بازخوانی…' : 'بازخوانی وضعیت'}
      </button>
    </div>

    {error && <p className="mt-4 rounded-lg border border-expense/40 bg-expense/10 px-3 py-2 text-sm font-bold text-expense">{error}</p>}

    {summary && <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <FirmSummaryTile label="پروندهٔ من" value={toPersianDigits(summary.clientCount)} hint={summary.unavailableCount ? `${toPersianDigits(summary.unavailableCount)} پرونده خوانده نشد` : ''} />
      <FirmSummaryTile label="نیازمند رفع ایراد" value={toPersianDigits(summary.blocked)} tone="text-expense" hint="تا رفع نشوند، تحویل ماه معنا ندارد" />
      <FirmSummaryTile label="در انتظار کنترل" value={toPersianDigits(summary.attention)} tone="text-accent" hint="ثبت بررسی‌نشده یا پاسخ کنترل‌نشده" />
      <FirmSummaryTile
        label="آمادهٔ تحویل" value={toPersianDigits(summary.ready)} tone="text-income"
        hint={summary.readyPercent == null ? 'هنوز پروندهٔ قابل اندازه‌گیری نیست' : `${toPersianDigits(summary.readyPercent)}٪ از پرونده‌های اندازه‌گیری‌شده`}
      />
    </div>}

    {summary?.topBlockers?.length > 0 && <div className="mt-4 rounded-[10px] border border-line bg-surface px-3 py-3">
      <p className="text-[12px] font-bold text-muted">تکرارشونده‌ترین ایرادها در کل دفتر</p>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[12px]">
        {summary.topBlockers.map((item) => <span key={item.id} className="rounded border border-line bg-paper px-2 py-0.5">
          {item.label} · <b className="numbers">{toPersianDigits(item.clients)}</b> پرونده
        </span>)}
      </div>
    </div>}

    {!loading && clients.length <= 1 && <div className="mt-5 rounded-[10px] border border-accent/40 bg-warn-bg px-4 py-4">
      <p className="font-bold text-accent">میز کار وقتی می‌درخشد که چند پروندهٔ مشتری داشته باشی.</p>
      <p className="mt-1 max-w-2xl text-[13px] leading-6 text-muted">
        هر مشتری یک پروندهٔ کاملاً جدا با دیتابیس مستقل می‌گیرد. از همین‌جا پرونده بساز؛ بعد می‌توانی از تنظیمات، همکارانت را با نقش حسابدار یا فقط‌مشاهده به هر پرونده اضافه کنی.
      </p>
      <AddClientForm notify={notify} onAdded={async () => { await refreshAccess?.(); await load(true); }} />
    </div>}

    <div className="mt-6 border-t border-line">
      {loading && !portfolio && <p className="py-8 text-center text-sm text-muted">در حال خواندن پرونده‌ها…</p>}
      {!loading && !clients.length && <p className="py-8 text-center text-sm text-muted">هنوز پرونده‌ای به تو داده نشده است.</p>}
      {clients.map((client) => <FirmClientRow
        key={client.workspace?.id} client={client} isActive={client.workspace?.id === activeId}
        onOpen={async (id) => { await switchWorkspace(id); notify('پروندهٔ مشتری باز شد.'); }}
      />)}
    </div>

    {portfolio && <p className="mt-4 text-[11px] leading-5 text-muted">
      این خلاصه هر ۵ دقیقه بازسازی می‌شود؛ برای دیدن لحظهٔ دقیق، «بازخوانی وضعیت» را بزن. پروندهٔ خوانده‌نشده با وضعیت «نامشخص» می‌ماند و عددش صفر فرض نمی‌شود.
    </p>}
  </section>;
}

function CollaborationPage({ access, notify, navigate }) {
  const [month, setMonth] = useState(() => persianPeriodToken());
  const [transferTarget, setTransferTarget] = useState('generic-csv');
  const periodOptions = useMemo(() => recentPersianPeriods(), []);
  const [overview, setOverview] = useState(null);
  const [transfer, setTransfer] = useState(null);
  const [operations, setOperations] = useState(null);
  const [portfolio, setPortfolio] = useState(null);
  const [loading, setLoading] = useState(true);
  const [requestDraft, setRequestDraft] = useState({ entityType: 'general', entityId: '', question: '', priority: 'normal' });
  const [answers, setAnswers] = useState({});
  const monday = useMemo(() => tehranWeekStart(), []);
  const [checkin, setCheckin] = useState({ weekStart: monday, respondentType: 'owner', savedMinutes: '', errorCount: '', friction: '', dropoutReason: '', willingnessToPay: 'unknown', planInterest: 'none', note: '' });
  const role = access.workspace?.role;
  const canAnswer = ['owner', 'manager'].includes(role);
  const canManagePilot = ['owner', 'manager'].includes(role);
  // این صفحه چهار کار بی‌ربط را زیر یک عنوان جمع کرده بود و سه بخشش هم اسم
  // «انتقال» داشتند. هر برگه حالا یک کار است، نه یک دیوار عمودی.
  const [tab, setTab] = useState('delivery');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [collaboration, transferState, operationState, portfolioState] = await Promise.all([
        api.collaborationOverview(month),
        api.accountingTransferOverview(month, transferTarget),
        canManagePilot ? api.operationsOverview() : Promise.resolve(null),
        access.user?.isSystemAdmin ? api.pilotPortfolio() : Promise.resolve(null),
      ]);
      setOverview(collaboration);
      setTransfer(transferState);
      setOperations(operationState);
      setPortfolio(portfolioState);
    } catch (error) { notify(error.message); }
    finally { setLoading(false); }
  }, [access.user?.isSystemAdmin, canManagePilot, month, notify, transferTarget]);

  useEffect(() => { load(); }, [load]);

  const createRequest = async (event) => {
    event.preventDefault();
    try {
      await api.createCollaborationRequest(requestDraft);
      setRequestDraft({ entityType: 'general', entityId: '', question: '', priority: 'normal' });
      await load();
      notify('درخواست توضیح در صندوق همکاری ثبت شد.');
    } catch (error) { notify(error.message); }
  };
  const answer = async (id) => {
    try { await api.answerCollaborationRequest(id, answers[id]); setAnswers({ ...answers, [id]: '' }); await load(); notify('پاسخ ثبت شد و برای حسابدار قابل مشاهده است.'); }
    catch (error) { notify(error.message); }
  };
  const resolveRequest = async (id) => {
    try { await api.resolveCollaborationRequest(id); await load(); notify('درخواست بسته شد و در سابقه باقی ماند.'); }
    catch (error) { notify(error.message); }
  };
  const saveCheckin = async (event) => {
    event.preventDefault();
    try {
      await api.savePilotCheckin({ ...checkin, savedMinutes: Number(checkin.savedMinutes || 0), errorCount: Number(checkin.errorCount || 0) });
      await load();
      notify('مصاحبهٔ هفتگی پایلوت ثبت شد.');
    } catch (error) { notify(error.message); }
  };
  const downloadPackage = async () => {
    try { const result = await api.downloadMonthlyAccountantPackage(month); notify(`بستهٔ ${result.fileName} ساخته شد.`); }
    catch (error) { notify(error.message); }
  };
  const updatePlan = async (workspaceId, planId, budgetUsd) => {
    try { await api.updateWorkspacePlan(workspaceId, { planId, providerBudgetUsd: Number(budgetUsd || 0) }); await load(); notify('پلن و سقف بودجهٔ دفتر به‌روزرسانی شد.'); }
    catch (error) { notify(error.message); }
  };

  if (loading && !overview) return <main className="mx-auto w-full max-w-[980px] px-4 py-6"><div className="h-28 animate-pulse rounded-[12px] bg-surface" /></main>;
  const packageData = overview?.package || {};
  const commercial = overview?.commercial || {};
  const pilot = overview?.pilot || {};
  const cost = commercial.provider || {};
  const entityLabels = { general: 'پرسش عمومی', transaction: 'تراکنش', receipt: 'رسید', closing: 'بستن صندوق', reconciliation: 'تطبیق بانکی', obligation: 'طلب یا بدهی' };

  return <main className="mx-auto w-full max-w-[980px] px-4 py-5">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-sm font-bold text-accent">فاز همکاری واقعی</p><h1 className="mt-1 text-xl font-extrabold">همکاری حسابدار، پایلوت و هزینه</h1><p className="mt-2 max-w-[700px] text-[13px] leading-6 text-muted">حساب‌یار در این بخش پل بین صاحب کسب‌وکار و دفتر حسابداری است؛ ثبت اولیه، مدرک و سؤال جابه‌جا می‌شود، اما جای نرم‌افزار رسمی حسابداری را نمی‌گیرد.</p></div><label className="text-xs text-muted">دورهٔ شمسی بسته<select value={month} onChange={(event) => setMonth(event.target.value)} className="tap mt-2 block rounded-lg border border-line bg-surface px-3 text-ink">{periodOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>

    <div className="mt-6 flex flex-wrap gap-1.5 border-b border-line pb-2 text-[13px] font-bold">
      {[['delivery', 'تحویل به حسابدار'], ['dna', 'DNA مالی'], ['questions', 'سؤال و پاسخ'], ['plan', 'پلن و هزینه'], ...(canManagePilot ? [['pilot', 'پایلوت و سلامت']] : [])].map(([id, label]) => (
        <button key={id} onClick={() => setTab(id)} className={`tap rounded-lg px-3 ${tab === id ? 'bg-warn-bg text-accent' : 'text-muted hover:bg-surface'}`}>{label}</button>
      ))}
    </div>

    {tab === 'delivery' && <div className="mt-4">
      <DeliverySpine readiness={transfer?.readiness} targetLabel={(transfer?.targets || []).find((item) => item.id === transferTarget)?.label || ''} />

      {/* گام ۱ و ۲ — تنظیمی که یک بار انجام می‌شود و بعد جمع می‌ماند. */}
      <TransferSetupSection readiness={transfer?.readiness}>
        <TransferLayoutPanel target={transferTarget} settings={transfer?.settings} readiness={transfer?.readiness} notify={notify} refresh={load} />
      </TransferSetupSection>

      {/* گام ۳ و ۴ — کار هر ماه: کنترل داده، ساخت بسته، ثبت آزمون ورود. */}
      <AccountingTransferPanel month={month} target={transferTarget} setTarget={setTransferTarget} overview={transfer} notify={notify} refresh={load} navigate={navigate} />

      {/* تحویل جداگانه: بستهٔ JSON مرور حسابدار، نه فایل انتقال نرم‌افزار. */}
      <section className="rounded-[12px] border border-line bg-surface p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="font-extrabold">بستهٔ پایان ماه برای حسابدار</h2><p className="mt-1 text-xs leading-6 text-muted">تراکنش‌ها، رسید ناقص، اختلاف صندوق، تطبیق باز، طلب/بدهی و سابقهٔ حسابرسی با شناسهٔ منبع.</p></div><FileText size={22} className="shrink-0 text-accent" /></div><div className="mt-4 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-paper p-3"><span className="text-[11px] text-muted">ثبت‌ها</span><b className="numbers mt-1 block">{toPersianDigits(packageData.summary?.transactionCount || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-[11px] text-muted">رسید ناقص</span><b className="numbers mt-1 block">{toPersianDigits(packageData.summary?.incompleteReceipts || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-[11px] text-muted">سؤال بی‌پاسخ</span><b className="numbers mt-1 block">{toPersianDigits(packageData.summary?.unansweredRequests || 0)}</b></div></div><div className="mt-4 divide-y divide-line rounded-lg border border-line px-3">{packageData.checklist?.checks?.map((item) => <div key={item.id} className="flex min-h-11 items-center gap-2 py-2 text-xs"><span className={`grid h-5 w-5 place-items-center rounded-full ${item.passed ? 'bg-income/10 text-income' : 'bg-expense/10 text-expense'}`}>{item.passed ? <Check size={14} /> : <CircleAlert size={14} />}</span><span className="flex-1 font-bold">{item.label}</span>{!item.passed && <b className="numbers text-expense">{toPersianDigits(item.count)}</b>}</div>)}</div><button onClick={downloadPackage} className="tap mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-ink font-bold text-white"><Download size={18} />دریافت بسته JSON حسابدار</button><p className="mt-3 text-[10px] leading-5 text-muted">هش SHA-256 داخل manifest امکان کنترل تغییر فایل را می‌دهد. تصویر خام رسید داخل خروجی قرار نمی‌گیرد.</p></section>
    </div>}

    {tab === 'dna' && <FinancialDnaPanel notify={notify} />}

    {tab === 'questions' && <section className="mt-4 rounded-[12px] border border-line bg-surface p-4"><div className="flex items-center justify-between"><div><h2 className="font-extrabold">صندوق درخواست توضیح</h2><p className="mt-1 text-xs leading-6 text-muted">حسابدار سؤال را به یک منبع وصل می‌کند؛ مدیر یا مالک پاسخ می‌دهد و حسابدار پس از کنترل آن را می‌بندد.</p></div><Users size={22} className="text-accent" /></div><form onSubmit={createRequest} className="mt-4 grid gap-2 md:grid-cols-[150px_minmax(0,1fr)_110px]"><select value={requestDraft.entityType} onChange={(event) => setRequestDraft({ ...requestDraft, entityType: event.target.value, entityId: '' })} className="tap rounded-lg border border-line bg-surface px-3 text-sm">{Object.entries(entityLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>{requestDraft.entityType === 'general' ? <input required minLength={5} value={requestDraft.question} onChange={(event) => setRequestDraft({ ...requestDraft, question: event.target.value })} placeholder="مثلاً این پرداخت بابت کدام پروژه بود؟" className="tap rounded-lg border border-line px-3" /> : <div className="grid gap-2 sm:grid-cols-[160px_1fr]"><input required value={requestDraft.entityId} onChange={(event) => setRequestDraft({ ...requestDraft, entityId: event.target.value })} placeholder="شناسه منبع" dir="ltr" className="tap rounded-lg border border-line px-3 text-left text-xs" /><input required minLength={5} value={requestDraft.question} onChange={(event) => setRequestDraft({ ...requestDraft, question: event.target.value })} placeholder="سؤال حسابدار" className="tap rounded-lg border border-line px-3" /></div>}<button className="tap rounded-lg bg-accent px-3 text-sm font-bold text-white">ثبت درخواست</button><label className="flex items-center gap-2 text-xs md:col-span-3"><input type="checkbox" checked={requestDraft.priority === 'urgent'} onChange={(event) => setRequestDraft({ ...requestDraft, priority: event.target.checked ? 'urgent' : 'normal' })} />فوری است</label></form><div className="mt-5 space-y-3">{overview?.requests?.length ? overview.requests.map((item) => <article key={item.id} className={`rounded-lg border p-3 ${item.priority === 'urgent' && item.status !== 'resolved' ? 'border-expense/30 bg-expense/5' : 'border-line'}`}><div className="flex flex-wrap items-center gap-2 text-[11px]"><b>{entityLabels[item.entityType]}</b><span className="rounded-md bg-paper px-2 py-1">{item.status === 'open' ? 'منتظر پاسخ' : item.status === 'answered' ? 'پاسخ داده‌شده' : 'بسته'}</span><span className="text-muted">{item.requestedBy?.label} · {persianDate(item.createdAt)}</span></div><p className="mt-3 text-sm font-bold leading-6">{item.question}</p>{item.entityId && <p className="mt-1 truncate text-[10px] text-muted" dir="ltr">{item.entityId}</p>}{item.answer && <div className="mt-3 rounded-lg bg-paper px-3 py-2"><p className="text-[11px] text-muted">پاسخ {item.answeredBy?.label}</p><p className="mt-1 text-sm leading-6">{item.answer}</p></div>}{item.status === 'open' && canAnswer && <div className="mt-3 flex gap-2"><input value={answers[item.id] || ''} onChange={(event) => setAnswers({ ...answers, [item.id]: event.target.value })} placeholder="پاسخ مستند صاحب کسب‌وکار" className="tap min-w-0 flex-1 rounded-lg border border-line px-3" /><button disabled={!String(answers[item.id] || '').trim()} onClick={() => answer(item.id)} className="tap rounded-lg bg-ink px-3 text-xs font-bold text-white disabled:opacity-40">ثبت پاسخ</button></div>}{item.status === 'answered' && <button onClick={() => resolveRequest(item.id)} className="tap mt-3 rounded-lg border border-income/30 px-3 text-xs font-bold text-income">کنترل شد؛ بستن درخواست</button>}</article>) : <p className="rounded-lg bg-paper px-3 py-4 text-center text-xs text-muted">درخواست بازی وجود ندارد.</p>}</div></section>}

    {tab === 'plan' && <div className="mt-4">
      <section className="rounded-[12px] border border-line bg-surface p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="font-extrabold">پلن و مصرف ماه</h2><p className="mt-1 text-xs text-muted">{commercial.plan?.label || 'رایگان'} · {commercial.plan?.description}</p></div><HandCoins size={22} className="text-accent" /></div><div className="mt-4 space-y-4">{commercial.quotas?.map((item) => <div key={item.id}><div className="flex justify-between text-xs"><span className="font-bold">{item.label}</span><span className={item.exhausted ? 'text-expense' : 'text-muted'}>{toPersianDigits(item.used)} از {toPersianDigits(item.limit)}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-paper"><div className={`h-full rounded-full ${item.percent >= 90 ? 'bg-expense' : 'bg-accent'}`} style={{ width: `${item.percent}%` }} /></div>{item.note && <p className="mt-1 text-[10px] leading-5 text-muted">{item.note}</p>}</div>)}</div><div className="mt-4 border-t border-line pt-4"><div className="flex justify-between text-sm"><span className="text-muted">هزینهٔ تخمینی provider</span><b dir="ltr">${Number(cost.estimatedCostUsd || 0).toFixed(4)}</b></div>{cost.budgetUsd > 0 && <div className="mt-2 flex justify-between text-xs"><span className="text-muted">سقف بودجه</span><b dir="ltr">${Number(cost.budgetUsd).toFixed(2)}</b></div>}{!cost.pricingComplete && <p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-[11px] leading-5 text-expense">بعضی نرخ‌های provider در Railway تنظیم نشده‌اند؛ جمع هزینه کامل نیست و به‌عنوان عدد قطعی نمایش داده نمی‌شود.</p>}<p className="mt-3 text-[11px] font-bold leading-5 text-income">{commercial.coreEntryMessage}</p></div></section>
    </div>}

    {tab === 'pilot' && <>
      {canManagePilot && <div className="mt-4 grid gap-4 lg:grid-cols-2"><section className="rounded-[12px] border border-line bg-surface p-4"><h2 className="font-extrabold">مصاحبهٔ هفتگی پایلوت</h2><p className="mt-1 text-xs leading-6 text-muted">زمان صرفه‌جویی، خطا و علت ترک را ثبت کن؛ این داده را حدس نزن.</p><form onSubmit={saveCheckin} className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs text-muted">شروع هفته<input required type="date" value={checkin.weekStart} onChange={(event) => setCheckin({ ...checkin, weekStart: event.target.value })} className="tap mt-2 w-full rounded-lg border border-line px-3" /></label><label className="text-xs text-muted">مصاحبه‌شونده<select value={checkin.respondentType} onChange={(event) => setCheckin({ ...checkin, respondentType: event.target.value })} className="tap mt-2 w-full rounded-lg border border-line px-3"><option value="owner">صاحب کسب‌وکار</option><option value="accountant">حسابدار</option></select></label><input inputMode="numeric" value={checkin.savedMinutes} onChange={(event) => setCheckin({ ...checkin, savedMinutes: event.target.value.replace(/\D/g, '') })} placeholder="دقیقه صرفه‌جویی" className="tap rounded-lg border border-line px-3" /><input inputMode="numeric" value={checkin.errorCount} onChange={(event) => setCheckin({ ...checkin, errorCount: event.target.value.replace(/\D/g, '') })} placeholder="تعداد خطا" className="tap rounded-lg border border-line px-3" /><select value={checkin.willingnessToPay} onChange={(event) => setCheckin({ ...checkin, willingnessToPay: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="unknown">آمادگی پرداخت نامشخص</option><option value="yes">حاضر به پرداخت</option><option value="maybe">شاید پرداخت کند</option><option value="no">حاضر به پرداخت نیست</option></select><select value={checkin.planInterest} onChange={(event) => setCheckin({ ...checkin, planInterest: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="none">پلن انتخاب نشده</option><option value="free">رایگان</option><option value="professional">حرفه‌ای</option><option value="accountant">همکاری حسابدار</option></select><textarea value={checkin.friction} onChange={(event) => setCheckin({ ...checkin, friction: event.target.value })} placeholder="بزرگ‌ترین اصطکاک این هفته" className="min-h-20 rounded-lg border border-line p-3 text-sm sm:col-span-2" /><textarea value={checkin.dropoutReason} onChange={(event) => setCheckin({ ...checkin, dropoutReason: event.target.value })} placeholder="اگر استفاده نکرد، دلیل ترک" className="min-h-20 rounded-lg border border-line p-3 text-sm sm:col-span-2" /><button className="tap rounded-lg bg-accent font-bold text-white sm:col-span-2">ثبت دادهٔ واقعی هفته</button></form></section><section className="rounded-[12px] border border-line bg-surface p-4"><h2 className="font-extrabold">سلامت دفتر و پایلوت</h2><div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">هفته فعال از ۴</span><b className="numbers mt-2 block text-lg">{toPersianDigits(pilot.activeWeeks || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">دقیقه صرفه‌جویی گزارش‌شده</span><b className="numbers mt-2 block text-lg">{toPersianDigits(pilot.savedMinutes || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">پایگاه‌داده</span><b className={`mt-2 block text-sm ${operations?.database?.ok ? 'text-income' : 'text-expense'}`}>{operations?.database?.ok ? 'سالم' : 'نیازمند بررسی'}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">پشتیبان خودکار</span><b className={`mt-2 block text-sm ${operations?.backup?.healthy ? 'text-income' : 'text-expense'}`}>{operations?.backup?.healthy ? 'کمتر از ۳۰ ساعت' : 'تأیید نشده'}</b></div></div><p className="mt-4 rounded-lg bg-warn-bg px-3 py-3 text-xs leading-6 text-muted">«بکاپ نوشته شد» مساوی «بازیابی عملی شد» نیست. آخرین بازیابی واقعی: {operations?.lastRestoreAt ? persianDate(operations.lastRestoreAt) : 'هنوز ثبت نشده'}.</p></section></div>}
      {portfolio && <PilotPortfolioPanel portfolio={portfolio} updatePlan={updatePlan} />}
    </>}
  </main>;
}

/**
 * ستون فقرات صفحه: چهار گام به همان ترتیبی که کار واقعاً انجام می‌شود، تا
 * کاربر پیش از هر اسکرول بداند کجای کار است و چه چیزی جلویش را گرفته.
 */
function DeliverySpine({ readiness, targetLabel }) {
  const steps = deliverySteps(readiness, targetLabel);
  return <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
    {steps.map((step, order) => {
      const tone = step.blocking ? 'border-expense/30 bg-expense/5' : step.done ? 'border-income/30 bg-income/5' : 'border-line bg-surface';
      const mark = step.blocking ? 'bg-expense/10 text-expense' : step.done ? 'bg-income/10 text-income' : 'bg-paper text-muted';
      return <li key={step.id} className={`rounded-[10px] border p-3 ${tone}`}>
        <div className="flex items-center gap-2">
          <span className={`numbers grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-extrabold ${mark}`}>
            {step.blocking ? <CircleAlert size={14} /> : step.done ? <Check size={14} /> : toPersianDigits(order + 1)}
          </span>
          <b className="text-[13px]">{step.title}</b>
          {step.blocking > 0 && <span className="numbers mr-auto text-[11px] font-bold text-expense">{toPersianDigits(step.blocking)} مورد</span>}
        </div>
        <p className="mt-2 text-[11px] leading-5 text-muted">{step.hint}</p>
      </li>;
    })}
  </ol>;
}

/**
 * تنظیم مقصد یک کار یک‌باره است، نه کار ماهانه. وقتی درست شده باشد باید جمع
 * بماند تا آنچه هر ماه دیده می‌شود، فقط کار همان ماه باشد؛ و وقتی چیزی از آن
 * ناقص است، خودش باز شود تا کاربر دنبالش نگردد.
 */
function TransferSetupSection({ readiness, children }) {
  const checks = (readiness?.checks || []).filter((item) => SETUP_CHECK_IDS.includes(item.id));
  const blocking = checks.filter((item) => !item.passed && item.severity !== 'advisory');
  const [open, setOpen] = useState(null);
  const expanded = open === null ? blocking.length > 0 : open;
  return <section className="mt-4 rounded-[12px] border border-line bg-surface">
    <button onClick={() => setOpen(!expanded)} className="tap flex w-full items-center gap-3 px-4 py-3 text-right">
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${blocking.length ? 'bg-expense/10 text-expense' : 'bg-income/10 text-income'}`}>
        {blocking.length ? <CircleAlert size={16} /> : <Check size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <b className="block text-[14px]">تنظیم مقصد — یک بار انجام می‌شود</b>
        <span className="mt-0.5 block text-[11px] leading-5 text-muted">
          {blocking.length
            ? `${toPersianDigits(blocking.length)} مورد باید تکمیل شود: ${blocking.map((item) => item.label).join('، ')}`
            : 'فایل پایه، چیدمان ستون‌ها، واحد مبلغ و سال مالی تنظیم شده‌اند.'}
        </span>
      </span>
      <ChevronLeft size={18} className={`shrink-0 text-muted transition-transform ${expanded ? '-rotate-90' : ''}`} />
    </button>
    {expanded && <div className="border-t border-line px-4 pb-4">{children}</div>}
  </section>;
}

/**
 * وقتی یک کنترل آمادگی قرمز است، گفتن «چه چیزی خراب است» کافی نیست؛ باید
 * گفت کدام قلم و از کجا درست می‌شود. این بخش همان شکاف را پر می‌کند.
 */
function ReadinessFixHints({ readiness, navigate, notify, refresh }) {
  const [busy, setBusy] = useState(false);
  const failed = (readiness?.checks || []).filter((item) => !item.passed && item.severity !== 'advisory');
  if (!failed.length) return null;

  const chartCheck = failed.find((item) => item.id === 'chart');
  const unmapped = readiness?.chart?.unmappedUsedAccounts || [];
  const approvalCheck = failed.find((item) => item.id === 'approval');
  const mappingCheck = failed.find((item) => item.id === 'mappings');
  const templateCheck = failed.find((item) => item.id === 'template');
  const fiscalCheck = failed.find((item) => item.id === 'parsian-fiscal-year');
  const missing = readiness?.missingMappings || [];

  // بقیهٔ تنظیمات عمداً فرستاده نمی‌شوند؛ سرور فیلدهای نیامده را نگه می‌دارد،
  // پس ثبت سال مالی تأیید قالب را پاک نمی‌کند.
  const applySuggestedFiscalYear = async (suggestion) => {
    setBusy(true);
    try {
      await api.saveAccountingTransferSettings({ fiscalYearStart: suggestion.start, fiscalYearEnd: suggestion.end });
      await refresh();
      notify(`سال مالی ${toPersianDigits(suggestion.year)} ثبت شد.`);
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  const fillFromChart = async () => {
    setBusy(true);
    try {
      const result = await api.fillTransferMappingsFromChart(readiness?.target?.id, false);
      await refresh();
      notify(`کد مقصد ${toPersianDigits(result.filled)} حساب از کدینگ دفتر پر شد${result.kept ? ` و ${toPersianDigits(result.kept)} نگاشت دستی دست‌نخورده ماند` : ''}.`);
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  const applySuggestions = async () => {
    setBusy(true);
    try {
      const result = await api.applyChartSuggestions();
      await refresh();
      notify(result.unmappedCount === 0
        ? `نگاشت ${toPersianDigits(result.applied)} حساب انجام شد و این ایراد برطرف شد.`
        : `${toPersianDigits(result.applied)} حساب نگاشت شد؛ ${toPersianDigits(result.unmappedCount)} حساب هنوز معین متناسب ندارد.`);
    } catch (error) { notify(error.message); }
    setBusy(false);
  };

  return <div className="mt-3 space-y-2">
    {/* بدون بازهٔ ثبت‌شده، سرور همهٔ سندها را «بیرون از بازه» گزارش می‌کند. نمایش
        همان فهرست به‌عنوان ناسازگاری، کاربر را دنبال سندهای سالم می‌فرستد
        درحالی‌که مشکل یک فیلد پرنشده است. */}
    {fiscalCheck && (fiscalCheck.fiscalYearStart ? <div className="rounded-lg border border-expense/40 bg-expense/5 p-3 text-xs leading-6">
      <p className="font-bold text-expense">سال مالی مقصد با سندهای این بسته سازگار نیست</p>
      <p className="mt-1 text-muted">بازهٔ ثبت‌شده: <span dir="ltr" className="numbers">{fiscalCheck.fiscalYearStart} تا {fiscalCheck.fiscalYearEnd}</span></p>
      {(fiscalCheck.outsideDocuments || []).length > 0 && <ul className="mt-2 space-y-0.5">
        {fiscalCheck.outsideDocuments.slice(0, 8).map((item) => <li key={item.entryId}>سند {toPersianDigits(item.documentNumber || '—')} · <span dir="ltr" className="numbers">{item.date || 'تاریخ نامعتبر'}</span>{item.memo ? ` · ${item.memo}` : ''}</li>)}
        {fiscalCheck.outsideDocuments.length > 8 && <li className="text-muted">و {toPersianDigits(fiscalCheck.outsideDocuments.length - 8)} سند دیگر…</li>}
      </ul>}
      <p className="mt-2 text-[11px] text-muted">بازهٔ صحیح را در بخش «تنظیم مقصد» ثبت کن یا اسناد را به دورهٔ درست منتقل کن. تا آن زمان فایل ساخته و تحویل نمی‌شود.</p>
    </div> : <div className="rounded-lg border border-accent/40 bg-warn-bg p-3 text-xs leading-6">
      <p className="font-bold text-accent">بازهٔ سال مالی باز پارسیان هنوز ثبت نشده است</p>
      <p className="mt-1 text-muted">سندهای این بسته ایرادی ندارند. پارسیان سند خارج از سال مالی باز را نمی‌پذیرد، پس حساب‌یار پیش از ساختن فایل باید بداند آن بازه چیست.</p>
      {fiscalCheck.suggestedFiscalYear ? <>
        <p className="mt-2 text-muted">همهٔ سندهای این بسته در سال <b className="text-ink numbers">{toPersianDigits(fiscalCheck.suggestedFiscalYear.year)}</b> هستند.</p>
        <button
          disabled={busy}
          onClick={() => applySuggestedFiscalYear(fiscalCheck.suggestedFiscalYear)}
          className="tap mt-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
        >ثبت سال مالی <span dir="ltr" className="numbers">{fiscalCheck.suggestedFiscalYear.start} تا {fiscalCheck.suggestedFiscalYear.end}</span></button>
        <p className="mt-2 text-[11px] text-muted">اگر سال مالی باز در پارسیان شما بازهٔ دیگری است، آن را در بخش «تنظیم مقصد» دستی وارد کن.</p>
      </> : <p className="mt-2 text-[11px] text-muted">سندهای این بسته در بیش از یک سال شمسی‌اند، پس بازه حدس زده نمی‌شود. آن را در بخش «تنظیم مقصد — یک بار انجام می‌شود» بالای همین صفحه وارد کن.</p>}
    </div>)}
    {chartCheck && <div className="rounded-lg border border-expense/40 bg-expense/5 p-3 text-xs leading-6">
      <p className="font-bold text-expense">این حساب‌ها هنوز معین مقصد ندارند</p>
      {unmapped.length > 0 && <ul className="mt-2 space-y-0.5">
        {unmapped.slice(0, 8).map((item) => <li key={item.id}><span className="numbers text-muted">{toPersianDigits(item.code)}</span> · {item.name}</li>)}
        {unmapped.length > 8 && <li className="text-muted">و {toPersianDigits(unmapped.length - 8)} حساب دیگر…</li>}
      </ul>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button disabled={busy} onClick={applySuggestions} className="tap rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-white disabled:opacity-45">
          {busy ? 'در حال نگاشت…' : 'اعمال نگاشت پیشنهادی'}
        </button>
        <button onClick={() => navigate('chart')} className="tap rounded-lg border border-line bg-paper px-3 py-1.5 text-xs font-bold">نگاشت دستی در صفحهٔ کدینگ</button>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-muted">
        حساب‌یار برای هر حساب، معین هم‌نوع کدینگ تو را پیشنهاد می‌دهد. اگر حسابی معین متناسب نداشت، اول آن معین را در کدینگ بساز.
      </p>
    </div>}

    {mappingCheck && <div className="rounded-lg border border-expense/40 bg-expense/5 p-3 text-xs leading-6">
      <p className="font-bold text-expense">{toPersianDigits(mappingCheck.count)} حساب هنوز کد مقصد ندارد</p>
      {missing.length > 0 && <ul className="mt-2 space-y-0.5">
        {missing.slice(0, 8).map((item) => <li key={item.id}><span className="numbers text-muted">{toPersianDigits(item.code)}</span> · {item.name}</li>)}
        {missing.length > 8 && <li className="text-muted">و {toPersianDigits(missing.length - 8)} حساب دیگر…</li>}
      </ul>}
      <button disabled={busy} onClick={fillFromChart} className="tap mt-3 rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-white disabled:opacity-45">
        {busy ? 'در حال پرکردن…' : 'پرکردن کد مقصد از کدینگ دفتر'}
      </button>
      <p className="mt-2 text-[11px] leading-5 text-muted">
        کدینگی که در حساب‌یار وارد کرده‌ای همان کدینگ نرم‌افزار مقصد توست، پس کد مقصد از روی آن پر می‌شود.
        نگاشت‌هایی که خودت دستی نوشته‌ای بازنویسی نمی‌شوند. اگر حسابی به کدینگ وصل نباشد، اول در صفحهٔ کدینگ نگاشتش کن.
      </p>
    </div>}

    {templateCheck && <div className="rounded-lg border border-expense/40 bg-expense/5 p-3 text-xs leading-6">
      <p className="font-bold text-expense">قالب مقصد هنوز کنترل و نام‌گذاری نشده است</p>
      <p className="mt-1 text-[11px] leading-5 text-muted">
        در همین صفحه، کادر «نام یا نسخهٔ قالب کنترل‌شده» را پر کن و تیک تأیید حسابدار را بزن، بعد «ذخیره کنترل قالب».
        این تأیید یعنی خودت ستون‌ها و واحد پول را روی یک شرکت آزمایشی دیده‌ای؛ ادعای پشتیبانی رسمی سازنده نیست.
      </p>
    </div>}

    {approvalCheck && <div className="rounded-lg border border-expense/40 bg-expense/5 p-3 text-xs leading-6">
      <p className="font-bold text-expense">{toPersianDigits(approvalCheck.count)} سند هنوز کنترل نشده است</p>
      <button onClick={() => navigate('accounting')} className="tap mt-2 rounded-lg border border-line bg-paper px-3 py-1.5 text-xs font-bold">رفتن به کارتابل سند</button>
    </div>}
  </div>;
}

function TransferLayoutPanel({ target, settings, readiness, notify, refresh }) {
  const [catalogue, setCatalogue] = useState(null);
  const [columns, setColumns] = useState([]);
  const [fileFormat, setFileFormat] = useState('csv');
  const [amountUnit, setAmountUnit] = useState('toman');
  const [fiscalYearStart, setFiscalYearStart] = useState('');
  const [fiscalYearEnd, setFiscalYearEnd] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.transferFields().then(setCatalogue).catch((error) => notify(error.message));
  }, [notify]);

  useEffect(() => {
    setColumns(settings?.columns || []);
    setFileFormat(settings?.fileFormat || 'csv');
    setAmountUnit(settings?.amountUnit || 'toman');
    // فیلد خالی، کاربر را با یک سؤال تنها می‌گذارد. بازهٔ سالِ خود سندها از پیش
    // نوشته می‌شود تا در حالت رایج فقط ذخیره لازم باشد — دیده می‌شود و قابل
    // تغییر است، پس حدسِ خاموش نیست.
    const suggested = (readiness?.checks || []).find((item) => item.id === 'parsian-fiscal-year')?.suggestedFiscalYear;
    setFiscalYearStart(settings?.fiscalYearStart || suggested?.start || '');
    setFiscalYearEnd(settings?.fiscalYearEnd || suggested?.end || '');
  }, [settings, readiness]);

  const move = (index, step) => {
    const next = [...columns];
    const target_ = index + step;
    if (target_ < 0 || target_ >= next.length) return;
    [next[index], next[target_]] = [next[target_], next[index]];
    setColumns(next);
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.saveAccountingTransferSettings({ targetSystem: target, fileFormat, amountUnit, columns, fiscalYearStart, fiscalYearEnd });
      await refresh();
      notify('قالب ستونی خروجی ذخیره شد.');
    } catch (error) {
      notify(error.details?.errors?.[0]?.message || error.message);
    }
    setBusy(false);
  };

  if (!catalogue) return null;
  const unused = catalogue.fields.filter((field) => !columns.some((column) => column.field === field.id));

  return <section className="mt-5 rounded-[10px] border border-line bg-surface p-4">
    <p className="font-bold">چیدمان ستون‌های خروجی</p>
    <p className="mt-1 max-w-2xl text-[12px] leading-6 text-muted">
      حساب‌یار قالب رسمی هیچ نسخه‌ای از پارسیان را نمی‌داند و ادعایش را هم نمی‌کند. یک بار بگو فایل ورودی نرم‌افزارت
      چه ستون‌هایی با چه نام و ترتیبی می‌خواهد؛ از آن به بعد خروجی دقیقاً همان می‌شود.
    </p>

    <div className="mt-3 flex flex-wrap gap-4">
      <label className="text-[13px] font-bold">نوع فایل خروجی
        <select value={fileFormat} onChange={(event) => setFileFormat(event.target.value)} className="tap mr-2 rounded-lg border border-line bg-paper px-2 text-[13px] font-normal">
          {catalogue.formats.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label className="text-[13px] font-bold">واحد ستون‌های مبلغ
        <select value={amountUnit} onChange={(event) => setAmountUnit(event.target.value)} className="tap mr-2 rounded-lg border border-line bg-paper px-2 text-[13px] font-normal"><option value="toman">تومان</option><option value="rial">ریال</option></select>
      </label>
    </div>

    {fileFormat === 'mdb' && <div className="mt-4 rounded-lg border border-line bg-paper p-3">
      <p className="text-[13px] font-bold">فایل پایهٔ Access پارسیان</p>
      <p className="mt-1 max-w-2xl text-[12px] leading-6 text-muted">
        این فایل پایه، خروجی خالی همان نصب پارسیان است و سندها روی یک نسخهٔ کپی‌شده از آن نوشته می‌شوند. یک بار در پارسیان خودت
        <b> امکانات ← سامانه تبادل اطلاعات ← سامانه تبادل اطلاعات اسناد ← انتقال اسناد به فایل </b>
        را بزن و همان فایل را اینجا بده. از آن به بعد حساب‌یار فقط سندها را داخل همان الگو می‌نویسد،
        پس ساختار فایل دقیقاً همانی می‌ماند که نرم‌افزار خودت ساخته است.
      </p>
      {settings?.hasTransferTemplate
        ? <p className="mt-2 text-[12px] text-ok">فایل پایه بارگذاری شده{settings.transferTemplateName ? `: ${settings.transferTemplateName}` : ''}. با فایل تازه جایگزین می‌شود.</p>
        : <p className="mt-2 text-[12px] text-danger">هنوز فایل پایه بارگذاری نشده؛ تا آن موقع فایل انتقال ساخته نمی‌شود.</p>}
      <input
        type="file" className="mt-2 w-full text-[12px]" disabled={busy === 'template'}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setBusy('template');
          try {
            await api.saveTransferTemplate(target, file);
            await refresh();
            notify('الگوی انتقال پارسیان ذخیره شد.');
          } catch (error) { notify(error.message); }
          setBusy(false);
        }}
      />
      <div className="mt-3 rounded-lg bg-surface p-3 text-[12px] leading-6">
        <b className="text-[13px]">سال مالی چیست و چرا پرسیده می‌شود؟</b>
        <p className="mt-1 text-muted">
          در پارسیان هر شرکت یک سال مالی دارد؛ مثل پوشه‌ای که سندهای آن سال داخلش می‌روند. معمولاً
          <b className="numbers"> ۱ فروردین تا ۲۹ اسفند</b>، ولی بعضی شرکت‌ها بازهٔ دیگری دارند (مثلاً ۱ مهر تا ۳۱ شهریور).
        </p>
        <p className="mt-1 text-muted">
          پارسیان سندی را که تاریخش بیرون از این پوشه باشد نمی‌پذیرد. حساب‌یار نمی‌داند پوشهٔ باز شرکت تو
          کدام است، پس همین‌جا می‌پرسد تا اگر ناسازگاری هست پیش از ساخت فایل بفهمی، نه بعد از رد شدنش.
        </p>
        <p className="mt-1 text-muted">
          مقدار زیر از تاریخ سندهای همین بسته پر شده است. اگر شرکتت سال مالی خاصی ندارد همین درست است؛
          اگر مطمئن نیستی، از حسابدارت بپرس سال مالی باز در پارسیان چه بازه‌ای است.
        </p>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-muted">
        ورود دوبارهٔ یک فایل سند تکراری می‌سازد، چون پارسیان تکراری را تشخیص نمی‌دهد.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-[12px] font-bold">شروع سال مالی باز
          <input dir="ltr" inputMode="numeric" value={fiscalYearStart} onChange={(event) => setFiscalYearStart(event.target.value)} placeholder="1405/01/01" className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-left numbers" />
        </label>
        <label className="text-[12px] font-bold">پایان سال مالی باز
          <input dir="ltr" inputMode="numeric" value={fiscalYearEnd} onChange={(event) => setFiscalYearEnd(event.target.value)} placeholder="1405/12/29" className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-left numbers" />
        </label>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-muted">این بازه باید دقیقاً با شرکت مقصد در پارسیان یکی باشد. حساب‌یار فایل دارای سند خارج از این بازه را تولید یا تحویل نمی‌دهد.</p>
      <p className="mt-2 text-[11px] leading-5 text-muted">اگر بسته بیشتر از ۴۰۱ ردیف داشته باشد، حساب‌یار بدون شکستن هیچ سندی آن را به چند فایل تقسیم می‌کند و یک ZIP شامل ترتیب ورود، جمع‌ها و هش هر بخش می‌سازد.</p>
    </div>}

    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[560px] text-right text-[13px]">
        <thead className="border-b border-line text-[12px] text-muted"><tr><th className="pb-2 pl-2 font-bold">#</th><th className="pb-2 pl-2 font-bold">عنوان ستون در فایل مقصد</th><th className="pb-2 pl-2 font-bold">دادهٔ حساب‌یار</th><th className="pb-2 font-bold">ترتیب</th></tr></thead>
        <tbody>
          {columns.map((column, index) => <tr key={`${column.field}-${index}`} className="border-b border-line">
            <td className="numbers py-2 pl-2 text-muted">{toPersianDigits(index + 1)}</td>
            <td className="py-2 pl-2">
              <input value={column.header} onChange={(event) => setColumns(columns.map((item, position) => (position === index ? { ...item, header: event.target.value } : item)))} className="tap w-full rounded-lg border border-line bg-paper px-2 text-[13px]" />
            </td>
            <td className="py-2 pl-2 text-muted">{catalogue.fields.find((field) => field.id === column.field)?.label || column.field}</td>
            <td className="whitespace-nowrap py-2">
              <button type="button" onClick={() => move(index, -1)} className="tap px-1 text-muted">▲</button>
              <button type="button" onClick={() => move(index, 1)} className="tap px-1 text-muted">▼</button>
              <button type="button" onClick={() => setColumns(columns.filter((_item, position) => position !== index))} className="tap px-1 text-expense"><Trash2 size={15} /></button>
            </td>
          </tr>)}
          {!columns.length && <tr><td colSpan={4} className="py-4 text-center text-muted">هیچ ستونی نمانده؛ حداقل کد حساب و دو ستون مبلغ لازم است.</td></tr>}
        </tbody>
      </table>
    </div>

    {unused.length > 0 && <div className="mt-3">
      <p className="text-[12px] text-muted">افزودن ستون:</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {unused.map((field) => <button key={field.id} type="button" onClick={() => setColumns([...columns, { field: field.id, header: field.label }])} className="tap rounded border border-line bg-paper px-2 py-0.5 text-[12px]">+ {field.label}</button>)}
      </div>
    </div>}

    <button disabled={busy} onClick={save} className="tap mt-4 rounded-lg bg-accent px-4 font-bold text-white disabled:opacity-45">{busy ? 'در حال ذخیره…' : 'ذخیرهٔ قالب'}</button>
  </section>;
}

function AccountingTransferPanel({ month, target, setTarget, overview, notify, refresh, navigate }) {
  const [settingsDraft, setSettingsDraft] = useState({ templateName: '', templateVerified: false, note: '' });
  const [mappingDrafts, setMappingDrafts] = useState({});
  const [busy, setBusy] = useState('');
  const [validationBatchId, setValidationBatchId] = useState('');
  const [validationDraft, setValidationDraft] = useState({ softwareName: 'پارسیان', softwareVersion: '', testCompanyLabel: '', attemptType: 'dry-run', outcome: 'failed', amountUnit: 'rial', importedRows: '', rejectedRows: '0', importedDebitTotal: '', importedCreditTotal: '', errorSummary: '', note: '' });
  const readiness = overview?.readiness || {};
  const targets = overview?.targets || [];

  useEffect(() => {
    setSettingsDraft({
      templateName: overview?.settings?.templateName || '',
      templateVerified: Boolean(overview?.settings?.templateVerified),
      note: overview?.settings?.note || '',
    });
    setMappingDrafts(Object.fromEntries((readiness.accounts || []).map((item) => [item.id, {
      targetCode: item.mapping?.targetCode || '', targetName: item.mapping?.targetName || '',
    }])));
  }, [overview, readiness.accounts]);

  const saveSettings = async () => {
    setBusy('settings');
    try {
      await api.saveAccountingTransferSettings({ targetSystem: target, ...settingsDraft });
      await refresh();
      notify('تنظیمات پل انتقال حسابداری ذخیره شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const saveMapping = async (accountId) => {
    setBusy(`mapping-${accountId}`);
    try {
      await api.saveAccountingTransferMapping(accountId, { targetSystem: target, ...(mappingDrafts[accountId] || {}) });
      await refresh();
      notify('کد حساب مقصد ذخیره شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const redownloadOptions = (item) => {
    if (!item?.redownloadRequired) return {};
    const confirmed = window.confirm(`این بسته قبلاً ${toPersianDigits(item.downloadCount || 1)} بار دریافت شده است. پارسیان فایل تکراری را بدون هشدار دوباره وارد می‌کند. دریافت دوباره را تأیید می‌کنی؟`);
    if (!confirmed) return null;
    const reason = String(window.prompt('علت دریافت دوباره را بنویس؛ این متن در سابقهٔ حسابرسی ذخیره می‌شود:') || '').trim();
    if (reason.length < 8) {
      notify('برای دریافت دوباره، علت را حداقل در ۸ نویسه بنویس.');
      return null;
    }
    return { confirmRedownload: true, reason };
  };
  const createBatch = async () => {
    setBusy('batch');
    try {
      const result = await api.createAccountingTransferBatch({ month, targetSystem: target });
      const options = redownloadOptions(result.item);
      if (options === null) return;
      const downloaded = await api.downloadAccountingTransferBatch(result.item.id, result.item.fileName, options);
      await refresh();
      notify(`خروجی ${downloaded.fileName} دریافت و سابقهٔ تحویل ثبت شد.`);
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const downloadBatch = async (item) => {
    const options = redownloadOptions(item);
    if (options === null) return;
    try {
      const result = await api.downloadAccountingTransferBatch(item.id, item.fileName, options);
      await refresh();
      notify(`فایل ${result.fileName} دریافت شد؛ نوبت دریافت: ${toPersianDigits(result.downloadCount)}.`);
    }
    catch (error) { notify(error.message); }
  };
  const updateStatus = async (item, status) => {
    const note = status === 'rejected' ? window.prompt('دلیل رد خروجی را بنویس:') : '';
    if (status === 'rejected' && !note) return;
    try { await api.updateAccountingTransferBatchStatus(item.id, status, note || ''); await refresh(); notify('وضعیت تحویل خروجی ثبت شد.'); }
    catch (error) { notify(error.message); }
  };
  const openValidation = (item) => {
    setValidationBatchId(validationBatchId === item.id ? '' : item.id);
    setValidationDraft({
      softwareName: item.targetSystem === 'parsian-review-csv' ? 'پارسیان' : '', softwareVersion: '', testCompanyLabel: '',
      attemptType: 'dry-run', outcome: 'failed', amountUnit: 'rial', importedRows: String(item.rowCount), rejectedRows: '0',
      importedDebitTotal: String(Number(item.debitTotal) * 10), importedCreditTotal: String(Number(item.creditTotal) * 10),
      errorSummary: '', note: '',
    });
  };
  const saveValidation = async (event, item) => {
    event.preventDefault();
    setBusy(`validation-${item.id}`);
    try {
      await api.createAccountingTransferValidation(item.id, {
        ...validationDraft,
        importedRows: Number(validationDraft.importedRows || 0), rejectedRows: Number(validationDraft.rejectedRows || 0),
        importedDebitTotal: Number(validationDraft.importedDebitTotal || 0), importedCreditTotal: Number(validationDraft.importedCreditTotal || 0),
      });
      setValidationBatchId('');
      await refresh();
      notify('نتیجهٔ آزمون شرکت آزمایشی ثبت شد.');
    } catch (error) { notify(error.message); }
    finally { setBusy(''); }
  };
  const statusLabel = { generated: 'ساخته‌شده', delivered: 'فایل دریافت شده', accepted: 'ورود تأیید شد', rejected: 'رد شده' };
  const validationLabel = { 'dry-run': 'Dry Run', 'trial-import': 'ورود آزمایشی', passed: 'موفق', failed: 'ناموفق' };

  return <section className="mt-4 rounded-[12px] border border-line bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold text-accent">فاز ۸ · اعتبارسنجی انتقال واقعی</p><h2 className="mt-1 font-extrabold">خروجی کنترل‌شده و آزمون شرکت نمونه</h2><p className="mt-1 max-w-[680px] text-xs leading-6 text-muted">هر بسته علاوه بر هش ثابت، نتیجهٔ Dry Run و ورود آزمایشی را با نسخهٔ نرم‌افزار، ردیف‌های ردشده و جمع بدهکار/بستانکار ثبت می‌کند. خروجی پارسیان بدون آزمون ورود موفق قابل پذیرش نیست.</p></div><label className="text-xs text-muted">مقصد خروجی<select value={target} onChange={(event) => setTarget(event.target.value)} className="tap mt-2 block rounded-lg border border-line bg-paper px-3 text-ink">{targets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>

    <div className="mt-4 grid gap-4 lg:grid-cols-[.9fr_1.1fr]">
      <div><div className="divide-y divide-line rounded-lg border border-line px-3">{(readiness.checks || []).map((item) => <div key={item.id} className="flex min-h-11 items-center gap-2 py-2 text-xs"><span className={`grid h-5 w-5 place-items-center rounded-full ${item.passed ? 'bg-income/10 text-income' : 'bg-expense/10 text-expense'}`}>{item.passed ? <Check size={14} /> : <CircleAlert size={14} />}</span><span className="flex-1 font-bold">{item.label}</span>{!item.passed && <b className="numbers text-expense">{toPersianDigits(item.count || 0)}</b>}</div>)}</div>
      <ReadinessFixHints readiness={readiness} navigate={navigate} notify={notify} refresh={refresh} />
      <div className="mt-3 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-paper p-3"><span className="text-[10px] text-muted">سند</span><b className="numbers mt-1 block">{toPersianDigits(readiness.entryCount || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-[10px] text-muted">ردیف</span><b className="numbers mt-1 block">{toPersianDigits(readiness.rowCount || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-[10px] text-muted">جمع بدهکار</span><b className="numbers mt-1 block text-[11px]">{formatAmount(readiness.debitTotal || 0)}</b></div></div><button disabled={!readiness.ready || busy === 'batch'} onClick={createBatch} className="tap mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-ink font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"><Download size={17} />{busy === 'batch' ? 'در حال ساخت…' : `ساخت و دریافت ${{ xlsx: 'اکسل', mdb: 'فایل انتقال پارسیان' }[overview?.settings?.fileFormat] || 'CSV'}`}</button><p className="mt-2 text-[10px] leading-5 text-muted">{readiness.disclaimer}</p></div>

      <div>{target === 'parsian-review-csv' ? <><div className="rounded-lg border border-line bg-paper p-3"><label className="text-xs text-muted">نام یا نسخهٔ قالب کنترل‌شده<input value={settingsDraft.templateName} onChange={(event) => setSettingsDraft({ ...settingsDraft, templateName: event.target.value })} placeholder="مثلاً خروجی نمونه پارسیان شرکت آزمایشی" className="tap mt-2 w-full rounded-lg border border-line bg-surface px-3" /></label><label className="mt-3 flex items-start gap-2 text-xs leading-6"><input type="checkbox" checked={settingsDraft.templateVerified} onChange={(event) => setSettingsDraft({ ...settingsDraft, templateVerified: event.target.checked })} className="mt-1" /><span>حسابدار ستون‌ها و واحد پول را با یک شرکت آزمایشی کنترل کرده است؛ این تأیید به معنی پشتیبانی رسمی سازنده نیست.</span></label><button disabled={busy === 'settings'} onClick={saveSettings} className="tap mt-3 rounded-lg border border-ink px-3 text-xs font-bold">ذخیره کنترل قالب</button></div><div className="mt-3 space-y-2">{(readiness.accounts || []).map((account) => { const draft = mappingDrafts[account.id] || { targetCode: '', targetName: '' }; return <div key={account.id} className="grid gap-2 rounded-lg border border-line p-3 md:grid-cols-[minmax(0,1fr)_120px_minmax(0,1fr)_70px]"><div><b className="text-xs">{account.name}</b><p className="numbers mt-1 text-[10px] text-muted">{account.code}</p></div><input value={draft.targetCode} onChange={(event) => setMappingDrafts({ ...mappingDrafts, [account.id]: { ...draft, targetCode: event.target.value } })} placeholder="کد مقصد" dir="ltr" className="tap rounded-lg border border-line px-2 text-left text-xs" /><input value={draft.targetName} onChange={(event) => setMappingDrafts({ ...mappingDrafts, [account.id]: { ...draft, targetName: event.target.value } })} placeholder="نام حساب مقصد" className="tap rounded-lg border border-line px-2 text-xs" /><button disabled={!draft.targetCode || busy === `mapping-${account.id}`} onClick={() => saveMapping(account.id)} className="tap rounded-lg bg-accent px-2 text-xs font-bold text-white disabled:opacity-40">ذخیره</button></div>; })}</div></> : <div className="rounded-lg bg-paper p-4 text-xs leading-6 text-muted"><b className="text-ink">قالب استاندارد حساب‌یار</b><p className="mt-2">هر ردیف دفتر کل با بدهکار/بستانکار تومان و ریال، کد و نام حساب، نوع و شناسهٔ منبع و تاریخ شمسی/ISO صادر می‌شود. متن‌های خطرناک برای Formula Injection خنثی می‌شوند.</p></div>}</div>
    </div>

    <div className="mt-4 border-t border-line pt-4"><h3 className="text-sm font-extrabold">سابقهٔ بسته‌ها و آزمون انتقال</h3><div className="mt-3 space-y-2">{overview?.batches?.length ? overview.batches.map((item) => <article key={item.id} className="rounded-lg bg-paper p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <b>{item.fileName}</b>
          <p className="mt-1 text-[10px] text-muted">SHA-256: <span dir="ltr">{item.digest.slice(0, 16)}…</span> · {toPersianDigits(item.entryCount)} سند · {toPersianDigits(item.rowCount)} ردیف · {toPersianDigits(item.downloadCount || 0)} بار دریافت</p>
          {item.latestValidation && <p className={`mt-2 text-[11px] font-bold ${item.latestValidation.outcome === 'passed' ? 'text-income' : 'text-expense'}`}>آخرین آزمون: {validationLabel[item.latestValidation.attemptType]} {validationLabel[item.latestValidation.outcome]} · {item.latestValidation.softwareName} {item.latestValidation.softwareVersion}</p>}
        </div>
        <span className={`rounded-md px-2 py-1 font-bold ${item.status === 'accepted' ? 'bg-income/10 text-income' : item.status === 'rejected' ? 'bg-expense/10 text-expense' : 'bg-surface text-muted'}`}>{statusLabel[item.status]}</span>
        <button onClick={() => downloadBatch(item)} className={`tap rounded-lg border px-2 text-[11px] font-bold ${item.redownloadRequired ? 'border-expense/30 text-expense' : 'border-line'}`}>{item.redownloadRequired ? 'دریافت دوباره' : 'دریافت'}</button>
        {!['accepted', 'rejected'].includes(item.status) && <button onClick={() => openValidation(item)} className="tap rounded-lg border border-ink px-2 text-[11px] font-bold">ثبت آزمون</button>}
        {!['accepted', 'rejected'].includes(item.status) && <button disabled={!item.acceptanceReady} onClick={() => updateStatus(item, 'accepted')} className="tap rounded-lg border border-income/30 px-2 text-[11px] font-bold text-income disabled:cursor-not-allowed disabled:opacity-35">ورود تأیید شد</button>}
        {!['accepted', 'rejected'].includes(item.status) && <button onClick={() => updateStatus(item, 'rejected')} className="tap rounded-lg border border-expense/30 px-2 text-[11px] font-bold text-expense">رد</button>}
      </div>
      {validationBatchId === item.id && <form onSubmit={(event) => saveValidation(event, item)} className="mt-3 grid gap-2 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-4"><input required value={validationDraft.softwareName} onChange={(event) => setValidationDraft({ ...validationDraft, softwareName: event.target.value })} placeholder="نام نرم‌افزار" className="tap rounded-lg border border-line px-2" /><input required value={validationDraft.softwareVersion} onChange={(event) => setValidationDraft({ ...validationDraft, softwareVersion: event.target.value })} placeholder="نسخه دقیق پارسیان" dir="ltr" className="tap rounded-lg border border-line px-2 text-left" /><input required value={validationDraft.testCompanyLabel} onChange={(event) => setValidationDraft({ ...validationDraft, testCompanyLabel: event.target.value })} placeholder="برچسب شرکت آزمایشی" className="tap rounded-lg border border-line px-2" /><select value={validationDraft.attemptType} onChange={(event) => setValidationDraft({ ...validationDraft, attemptType: event.target.value })} className="tap rounded-lg border border-line px-2"><option value="dry-run">Dry Run</option><option value="trial-import">ورود آزمایشی واقعی</option></select><select value={validationDraft.outcome} onChange={(event) => setValidationDraft({ ...validationDraft, outcome: event.target.value })} className="tap rounded-lg border border-line px-2"><option value="failed">ناموفق</option><option value="passed">موفق</option></select><select value={validationDraft.amountUnit} onChange={(event) => { const amountUnit = event.target.value; const multiplier = amountUnit === 'rial' ? 10 : 1; setValidationDraft({ ...validationDraft, amountUnit, importedDebitTotal: String(Number(item.debitTotal) * multiplier), importedCreditTotal: String(Number(item.creditTotal) * multiplier) }); }} className="tap rounded-lg border border-line px-2"><option value="rial">جمع مقصد به ریال</option><option value="toman">جمع مقصد به تومان</option></select><input required inputMode="numeric" value={validationDraft.importedRows} onChange={(event) => setValidationDraft({ ...validationDraft, importedRows: event.target.value.replace(/\D/g, '') })} placeholder="ردیف واردشده" className="tap numbers rounded-lg border border-line px-2" /><input required inputMode="numeric" value={validationDraft.rejectedRows} onChange={(event) => setValidationDraft({ ...validationDraft, rejectedRows: event.target.value.replace(/\D/g, '') })} placeholder="ردیف ردشده" className="tap numbers rounded-lg border border-line px-2" /><input required inputMode="numeric" value={validationDraft.importedDebitTotal} onChange={(event) => setValidationDraft({ ...validationDraft, importedDebitTotal: event.target.value.replace(/\D/g, '') })} placeholder="جمع بدهکار مقصد" className="tap numbers rounded-lg border border-line px-2" /><input required inputMode="numeric" value={validationDraft.importedCreditTotal} onChange={(event) => setValidationDraft({ ...validationDraft, importedCreditTotal: event.target.value.replace(/\D/g, '') })} placeholder="جمع بستانکار مقصد" className="tap numbers rounded-lg border border-line px-2" /><input value={validationDraft.errorSummary} onChange={(event) => setValidationDraft({ ...validationDraft, errorSummary: event.target.value })} placeholder="خطاهای مشاهده‌شده؛ برای ناموفق الزامی" className="tap rounded-lg border border-line px-2 lg:col-span-2" /><textarea value={validationDraft.note} onChange={(event) => setValidationDraft({ ...validationDraft, note: event.target.value })} placeholder="یادداشت و مدرک آزمون؛ بدون اطلاعات محرمانه" className="min-h-16 rounded-lg border border-line p-2 sm:col-span-2 lg:col-span-3" /><button disabled={busy === `validation-${item.id}`} className="tap rounded-lg bg-ink px-3 font-bold text-white">ثبت نتیجه آزمون</button><p className="text-[10px] leading-5 text-muted sm:col-span-2 lg:col-span-4">برای نتیجهٔ موفق، تعداد ردیف باید دقیقاً {toPersianDigits(item.rowCount)}، ردیف ردشده صفر و جمع بدهکار و بستانکار برابر هش/مبالغ همین بسته باشد.</p></form>}
    </article>) : <p className="rounded-lg bg-paper px-3 py-4 text-center text-xs text-muted">هنوز خروجی ثابتی ساخته نشده است.</p>}</div></div>
  </section>;
}

/**
 * توزیع هفتگی یک سری واحد از جنس «بزرگی» است، نه هویت؛ پس یک رنگ می‌گیرد و
 * روز اوج با برچسب مستقیم مشخص می‌شود، نه با رنگ دوم.
 */
function WeekdayBars({ rows }) {
  const peak = rows.reduce((best, item) => (item.percent > best.percent ? item : best), rows[0]);
  // سهم هر روز حدود یک‌هفتم است، پس مقیاس‌کردن به صد درصد همهٔ میله‌ها را به
  // ته نوار می‌چسباند و تفاوتشان دیده نمی‌شود. مقیاس نسبت به بیشترین مقدار
  // است و عدد واقعی کنارش می‌ماند، پس چیزی بزرگ‌نمایی نمی‌شود.
  const highest = Math.max(...rows.map((item) => item.percent), 1);
  return <div className="mt-3 space-y-1.5">
    {rows.map((item) => <div key={item.day} className="flex items-center gap-2" title={`${item.day}: ${formatAmount(item.amount)} تومان`}>
      <span className="w-16 shrink-0 text-[11px] text-muted">{item.day}</span>
      <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-paper">
        <div className="h-full rounded-full bg-accent" style={{ width: `${item.percent ? Math.max(4, Math.round((item.percent / highest) * 100)) : 0}%` }} />
      </div>
      <span className="numbers w-9 shrink-0 text-left text-[11px] font-bold text-muted">{toPersianDigits(item.percent)}٪</span>
      <span className="w-8 shrink-0">{item.day === peak.day && <span className="rounded-md bg-warn-bg px-1.5 py-0.5 text-[10px] font-bold text-accent">اوج</span>}</span>
    </div>)}
  </div>;
}

function FinancialDnaPanel({ notify }) {
  const [dna, setDna] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.financialDna(6)
      .then((result) => { if (alive) setDna(result); })
      .catch((error) => { if (alive) notify(error.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [notify]);

  if (loading) return <div className="mt-4 h-32 animate-pulse rounded-[12px] bg-surface" />;
  if (!dna) return null;

  // نبود داده یک واقعیت است، نه خطا؛ ادعای الگو روی دادهٔ کم بدتر از سکوت است.
  if (dna.sufficiency.level !== 'ok') {
    return <section className="mt-4 rounded-[12px] border border-line bg-surface p-4">
      <h2 className="font-extrabold">DNA مالی این پرونده</h2>
      <p className="mt-2 text-[13px] leading-7 text-muted">{dna.message}</p>
      <p className="mt-3 rounded-lg bg-paper px-3 py-3 text-[12px] leading-6 text-muted">
        تا آن موقع هیچ الگویی نشان داده نمی‌شود. پروفایل غلط برای دفتر بدتر از نبودِ پروفایل است، چون بر پایه‌اش تصمیم گرفته می‌شود.
      </p>
    </section>;
  }

  const brief = dna.brief;
  const weekday = dna.traits.find((item) => item.id === 'weekday-pattern');
  return <div className="mt-4 space-y-4">
    <section className="rounded-[12px] border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-extrabold">پروفایل یک‌نگاهی پرونده</h2>
          <p className="mt-1 text-xs leading-6 text-muted">
            از {toPersianDigits(dna.sufficiency.activeDays)} روز فعال در {toPersianDigits(dna.sufficiency.months)} ماه ساخته شده است؛ هر عدد از ثبت‌های واقعی می‌آید، نه از پیش‌بینی.
          </p>
        </div>
        <BarChart3 size={22} className="shrink-0 text-accent" />
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['شکل پرونده', brief.shape],
          ['سند در ماه', toPersianDigits(brief.documentsPerMonth)],
          ['انضباط ثبت', brief.discipline],
          ['ثبت معمول درآمد', `${formatAmount(brief.typicalIncome)} تومان`],
        ].map(([label, value]) => <div key={label} className="rounded-lg bg-paper p-3">
          <span className="text-[11px] text-muted">{label}</span>
          <b className="mt-1 block text-[13px] leading-6">{value}</b>
        </div>)}
      </div>
      <p className="mt-3 rounded-lg bg-warn-bg px-3 py-2 text-[12px] leading-6 text-accent">{brief.workloadNote}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {brief.activeCategories.map((item) => <span key={item.category} className="rounded-md border border-line px-2 py-1 text-[11px]">
          {item.category} <span className="numbers text-muted">{toPersianDigits(item.count)}</span>
        </span>)}
      </div>
    </section>

    <section className="rounded-[12px] border border-line bg-surface p-4">
      <h2 className="font-extrabold">اثر انگشت رفتاری</h2>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        {dna.traits.map((trait) => <article key={trait.id} className="rounded-[10px] border border-line bg-paper p-3">
          <div className="flex items-baseline justify-between gap-2">
            <b className="text-[13px]">{trait.label}</b>
            <span className="text-[13px] font-extrabold text-accent">{trait.value}</span>
          </div>
          <p className="mt-2 text-[11px] leading-6 text-muted">{trait.detail}</p>
          {trait.id === 'weekday-pattern' && <WeekdayBars rows={weekday.evidence.byWeekday} />}
          {trait.id === 'expense-backbone' && trait.evidence.fixed.length > 0 && <div className="mt-3 space-y-1">
            {trait.evidence.fixed.slice(0, 4).map((item) => <div key={item.category} className="flex items-center justify-between text-[11px]">
              <span className="text-muted">{item.category}</span>
              <span className="flex shrink-0 items-baseline gap-2">
                <b className="numbers">{toPersianDigits(item.percent)}٪</b>
                <span className="text-muted">در {toPersianDigits(item.months)} ماه</span>
              </span>
            </div>)}
          </div>}
          {trait.id === 'income-concentration' && <div className="mt-3 space-y-1">
            {trait.evidence.top.map((item) => <div key={item.category} className="flex items-center justify-between text-[11px]">
              <span className="text-muted">{item.category}</span>
              <span className="numbers font-bold">{toPersianDigits(item.percent)}٪</span>
            </div>)}
          </div>}
          {trait.id === 'entry-discipline' && <p className="mt-3 text-[11px] leading-6 text-muted">
            فاصلهٔ معمول ثبت تا وقوع: <b className="numbers">{toPersianDigits(trait.evidence.typicalLagDays)}</b> روز ·
            همان‌روز: <b className="numbers">{toPersianDigits(trait.evidence.sameDayPercent)}٪</b> ·
            شلوغ‌ترین روز ثبت: <b className="numbers">{toPersianDigits(trait.evidence.busiestDayCount)}</b> سند
          </p>}
          <p className="mt-2 text-[10px] text-muted">بر پایهٔ {toPersianDigits(trait.evidence.sample ?? trait.evidence.total ?? 0)} ثبت</p>
        </article>)}
      </div>
    </section>
  </div>;
}

function PilotPortfolioPanel({ portfolio, updatePlan }) {
  const [drafts, setDrafts] = useState({});
  const summary = portfolio.summary || {};
  return <section className="mt-4 rounded-[12px] border border-line bg-surface p-4"><h2 className="font-extrabold">داشبورد مدیر پایلوت</h2><p className="mt-1 text-xs leading-6 text-muted">نرخ‌ها فقط از رفتار و مصاحبهٔ ثبت‌شدهٔ دفترها ساخته می‌شوند؛ دفترهای کمتر از چهار هفته وارد مخرج ماندگاری نمی‌شوند.</p><div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">دفتر پایلوت</span><b className="numbers mt-2 block">{toPersianDigits(summary.workspaceCount || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">واجد هفته چهارم</span><b className="numbers mt-2 block">{toPersianDigits(summary.eligibleWeekFour || 0)}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">ماندگاری / هدف ۴۰٪</span><b className="numbers mt-2 block">{summary.retentionPercent == null ? '—' : `${toPersianDigits(summary.retentionPercent)}٪`}</b></div><div className="rounded-lg bg-paper p-3"><span className="text-xs text-muted">آمادگی پرداخت / هدف ۳۰٪</span><b className="numbers mt-2 block">{summary.willingnessPercent == null ? '—' : `${toPersianDigits(summary.willingnessPercent)}٪`}</b></div></div><div className="mt-4 divide-y divide-line border-y border-line">{portfolio.workspaces?.map((item) => { const draft = drafts[item.workspace.id] || { planId: item.commercial.plan.id, budgetUsd: item.commercial.provider.budgetUsd }; return <div key={item.workspace.id} className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_150px_130px_100px]"><div><p className="text-sm font-bold">{item.workspace.name}</p><p className="mt-1 text-[11px] text-muted">{toPersianDigits(item.activeWeeks)} هفته فعال · {item.willingnessToPay === 'yes' ? 'حاضر به پرداخت' : 'پرداخت تأیید نشده'}</p></div><select value={draft.planId} onChange={(event) => setDrafts({ ...drafts, [item.workspace.id]: { ...draft, planId: event.target.value } })} className="tap rounded-lg border border-line px-2 text-xs"><option value="free">رایگان</option><option value="professional">حرفه‌ای</option><option value="accountant">همکاری حسابدار</option></select><input type="number" min="0" step="0.01" value={draft.budgetUsd} onChange={(event) => setDrafts({ ...drafts, [item.workspace.id]: { ...draft, budgetUsd: event.target.value } })} placeholder="بودجه دلار" dir="ltr" className="tap rounded-lg border border-line px-2 text-left text-xs" /><button onClick={() => updatePlan(item.workspace.id, draft.planId, draft.budgetUsd)} className="tap rounded-lg bg-ink px-2 text-xs font-bold text-white">ذخیره پلن</button></div>; })}</div></section>;
}

/**
 * آیکن هر صفحه.
 *
 * فهرست صفحه‌ها از سرور می‌آید تا فرانت‌اند نسخهٔ موازی نسازد؛ همان قاعده‌ای
 * که دروازهٔ سرور با آن کار می‌کند. فقط آیکن اینجا می‌ماند، چون داده نیست.
 */
const SCREEN_ICONS = {
  home: Home, wallet: WalletCards, chart: BarChart3, settings: Settings,
  grid: LayoutGrid, inbox: ReceiptText, book: BookOpenCheck, landmark: Landmark,
  coins: HandCoins, users: Users,
};

/** صفحه‌های مجاز این کاربر؛ تا وقتی دسترسی نرسیده، ناوبری خالی می‌ماند نه حدسی. */
function allowedScreens(access) {
  return Array.isArray(access?.screens) ? access.screens : [];
}

function DesktopNav({ screen, navigate, businessName, profileType = 'business', access }) {
  // میز کار فقط وقتی معنا دارد که کاربر بیش از یک پرونده داشته باشد.
  const items = allowedScreens(access).map((item) => [item.id, item.label, SCREEN_ICONS[item.icon] || Home]);
  const profile = profileDefinition(profileType);
  return <aside className="desktop-nav hidden border-l border-line bg-surface px-4 py-6 lg:block"><div className="sticky top-6"><div className="mb-8 border-b border-line pb-5"><p className="text-xl font-extrabold">حساب‌یار</p><p className="mt-1 truncate text-xs text-muted">{businessName || profile.label}</p><p className="mt-1 text-[11px] leading-5 text-muted">دستیار ثبت و مدیریت نقدینگی</p></div><nav className="space-y-1">{items.map(([id, label, Icon]) => <button key={id} onClick={() => navigate(id)} className={`tap flex w-full items-center gap-3 rounded-lg px-3 text-right text-sm font-bold ${screen === id ? 'bg-warn-bg text-accent' : 'text-muted hover:bg-paper hover:text-ink'}`}><Icon size={20} />{label}</button>)}</nav></div></aside>;
}

function InsightRail({ overview = {}, navigate, open = false, setOpen }) {
  return <aside className={`insight-rail hidden border-r border-line bg-paper xl:block ${open ? 'px-5 py-7' : 'px-2 py-5'}`}><div className="sticky top-5"><button onClick={() => setOpen(!open)} className={`tap flex items-center rounded-lg border border-line bg-surface text-xs font-extrabold ${open ? 'w-full justify-between px-3' : 'mx-auto w-12 justify-center'}`} aria-expanded={open} aria-label={open ? 'جمع‌کردن وضعیت نقدینگی' : 'بازکردن وضعیت نقدینگی'}>{open && <span>وضعیت نقدینگی</span>}<ChevronLeft size={19} className={`transition-transform ${open ? 'rotate-180' : ''}`} /></button>{open ? <div className="mt-5 space-y-5"><div><p className="text-[13px] text-muted">وضعیت همین حالا</p><p className="numbers mt-2 text-2xl font-extrabold">{formatAmount(overview.cash || 0)}</p><p className="text-xs leading-5 text-muted">تومان ماندهٔ برآوردی ثبت‌ها</p></div><div className="border-y border-line py-4 text-sm"><div className="flex justify-between py-1"><span className="text-muted">طلب باز</span><b className="numbers text-income">{formatAmount(overview.receivable || 0)}</b></div><div className="flex justify-between py-1"><span className="text-muted">بدهی باز</span><b className="numbers text-expense">{formatAmount(overview.payable || 0)}</b></div>{overview.runwayDays != null && <div className="flex justify-between py-1"><span className="text-muted">دوام نقدینگی</span><b>{toPersianDigits(overview.runwayDays)} روز</b></div>}</div><p className="text-[11px] leading-5 text-muted">این مانده تا پیش از تطبیق صندوق یا بانک، قطعی نیست.</p><button onClick={() => navigate('ledger')} className="tap w-full rounded-lg border border-line bg-surface px-3 text-sm font-bold">بازکردن دفتر کامل</button></div> : <button onClick={() => setOpen(true)} className="insight-rail-label mx-auto mt-5 flex min-h-[150px] items-center text-[11px] font-extrabold text-muted">نبض نقدینگی</button>}</div></aside>;
}

function Onboarding({ initial, onDone }) {
  const [profileType, setProfileType] = useState(initial.profileType || 'business');
  const [businessName, setBusinessName] = useState(initial.businessName || '');
  const [saving, setSaving] = useState(false);
  const submit = async () => { setSaving(true); await onDone({ profileType, businessName }); setSaving(false); };
  const selectedProfile = profileDefinition(profileType);
  return <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/45 p-4 backdrop-blur-[2px]"><section role="dialog" aria-modal="true" className="w-full max-w-[520px] rounded-[12px] border border-line bg-paper p-5 shadow-2xl"><p className="text-sm font-bold text-accent">راه‌اندازی یک‌دقیقه‌ای</p><h2 className="mt-2 text-2xl font-extrabold">حساب‌یار را برای خودت تنظیم کن</h2><p className="mt-2 text-sm leading-7 text-muted">نوع استفاده، ابزارهای دفترت را مشخص می‌کند و هر زمان قابل تغییر است.</p><div className="mt-5 grid grid-cols-2 gap-2"><button onClick={() => setProfileType('business')} className={`tap rounded-lg border px-3 text-sm font-bold ${profileType === 'business' ? 'border-accent bg-warn-bg text-accent' : 'border-line bg-surface'}`}>کسب‌وکار کوچک</button><button onClick={() => setProfileType('personal')} className={`tap rounded-lg border px-3 text-sm font-bold ${profileType === 'personal' ? 'border-accent bg-warn-bg text-accent' : 'border-line bg-surface'}`}>حساب شخصی</button></div><div className="mt-3 rounded-lg border border-line bg-surface px-3 py-3"><p className="text-sm font-bold">{selectedProfile.label}</p><p className="mt-1 text-[13px] leading-6 text-muted">{selectedProfile.description}</p></div><label className="mt-4 block text-[13px] text-muted">{profileType === 'business' ? 'نام کسب‌وکار' : 'نام دفتر شخصی'}<input value={businessName} onChange={(event) => setBusinessName(event.target.value)} placeholder={profileType === 'business' ? 'مثلاً فروشگاه آبان' : 'مثلاً حساب‌های امیر'} className="tap mt-2 w-full rounded-lg border border-line bg-surface px-3 text-ink outline-none focus:border-accent" /></label><p className="mt-3 text-[12px] leading-6 text-muted">{PRODUCT_POSITIONING.accountingDisclaimer}</p><button disabled={saving} onClick={submit} className="tap mt-5 w-full rounded-lg bg-accent font-extrabold text-white">{saving ? 'در حال ذخیره…' : 'شروع کار'}</button></section></div>;
}

function LedgerPage({ profileType = 'business', categories, accounts = [], contacts: initialContacts, notify, refresh, initialTab = 'transactions' }) {
  const [tab, setTab] = useState(initialTab);
  const profile = profileDefinition(profileType);
  const allTabs = [['transactions', profileType === 'personal' ? 'ثبت‌ها' : 'تراکنش‌ها'], ['obligations', profileType === 'personal' ? 'قسط و بدهی' : 'طلب و بدهی'], ['invoices', 'فاکتور'], ['reconciliation', 'تطبیق بانک'], ['recurring', 'دوره‌ای'], ['inventory', 'موجودی'], ['tools', 'ابزارها']];
  const tabs = allTabs.filter(([id]) => profile.ledgerTabs.includes(id));
  useEffect(() => { if (profile.ledgerTabs.includes(initialTab)) setTab(initialTab); }, [initialTab, profileType]);
  useEffect(() => { if (!profile.ledgerTabs.includes(tab)) setTab('transactions'); }, [profile, tab]);
  return <main className="mx-auto w-full max-w-[900px] px-4 py-5"><div className="flex items-center justify-between"><div><h1 className="text-xl font-extrabold">دفتر مالی</h1><p className="mt-1 text-[13px] text-muted">{profile.description}</p></div><ListFilter className="text-muted" /></div><div className="scrollbar-none -mx-4 mt-5 flex gap-2 overflow-x-auto border-b border-line px-4 pb-3">{tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} className={`tap shrink-0 rounded-lg px-4 text-sm font-bold ${tab === id ? 'bg-ink text-white' : 'border border-line bg-surface text-muted'}`}>{label}</button>)}</div>{tab === 'transactions' && <TransactionsPanel categories={categories} accounts={accounts} contacts={initialContacts} notify={notify} refresh={refresh} />}{tab === 'obligations' && <ObligationsPanel contacts={initialContacts} notify={notify} refresh={refresh} />}{tab === 'invoices' && <InvoicesPanel contacts={initialContacts} accounts={accounts} categories={categories} notify={notify} refresh={refresh} />}{tab === 'reconciliation' && <ReconciliationPanel accounts={accounts} categories={categories} notify={notify} refresh={refresh} />}{tab === 'recurring' && <RecurringPanel categories={categories} notify={notify} />}{tab === 'inventory' && <InventoryPanel notify={notify} />}{tab === 'tools' && <ToolsPanel profileType={profileType} accounts={accounts} categories={categories} notify={notify} refresh={refresh} />}</main>;
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
  const addContact = async () => { if (!contactName.trim()) return; await api.saveContact({ name: contactName }); setContactName(''); notify('شخص اضافه شد.'); load(); refresh(); };
  const add = async (event) => {
    event.preventDefault();
    // نام گفته‌شده همراه ثبت می‌رود؛ سرور شخص را پیدا یا ایجاد می‌کند تا کاربر
    // مجبور نباشد اول شخص را دستی بسازد.
    await api.saveObligation({ ...draft, contactName: draft.contactId ? '' : draft.spokenName || '' });
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
  const settle = async (id) => { await api.settleObligation(id); notify('تسویه شد و تراکنش آن در دفتر ثبت شد.'); load(); refresh(); };
  return <section className="mt-5 space-y-6"><div><h2 className="font-extrabold">اشخاص</h2><div className="mt-2 flex gap-2"><input value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="نام شخص یا مشتری" className="tap min-w-0 flex-1 rounded-lg border border-line bg-surface px-3" /><button onClick={addContact} className="tap rounded-lg bg-ink px-4 font-bold text-white">افزودن</button></div><div className="scrollbar-none mt-2 flex gap-2 overflow-x-auto">{contacts.map((contact) => <span key={contact.id} className="shrink-0 rounded-lg border border-line bg-surface px-3 py-2 text-xs"><b>{contact.name}</b>{Number(contact.balance) !== 0 && <span className={`numbers mr-2 ${contact.balance > 0 ? 'text-income' : 'text-expense'}`}>{formatAmount(Math.abs(contact.balance))}</span>}</span>)}</div></div><form onSubmit={add} className="rounded-[10px] border border-line bg-surface p-3"><div className="flex items-start justify-between gap-3"><div><h2 className="font-extrabold">طلب یا بدهی تازه</h2><p className="mt-1 text-[11px] leading-5 text-muted">می‌توانی بگویی «حسن سه میلیون بدهکار شد». شخص تازه خودش ساخته می‌شود و ثبت با دکمهٔ خودت انجام می‌شود.</p></div><button type="button" disabled={busyVoice} onClick={dictating ? finishDictation : toggleDictation} className={`tap grid shrink-0 place-items-center rounded-lg border px-3 disabled:opacity-40 ${dictating ? 'border-expense bg-expense/10 text-expense' : 'border-line text-accent'}`} aria-label={dictating ? 'پایان گفتن' : 'گفتن طلب یا بدهی'}>{busyVoice ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" /> : <Mic size={19} />}</button></div>{dictating && <p className="mt-2 text-[11px] font-bold text-expense">در حال شنیدن… وقتی حرفت تمام شد دوباره روی میکروفن بزن.</p>}{busyVoice && <p className="mt-2 text-[11px] font-bold text-accent">صدا روی سرور بررسی می‌شود…</p>}{heard && <blockquote className="mt-2 rounded-lg border border-line bg-paper px-3 py-2 text-[12px] leading-6 text-muted">«{heard}»</blockquote>}{draft.spokenName && <p className="mt-2 text-[11px] leading-5 text-accent">شخص «{draft.spokenName}» در دفتر نیست و با ذخیره‌شدن این ثبت ساخته می‌شود.</p>}{(draft.occurredAt || draft.dueAt) && <p className="mt-1 text-[11px] leading-5 text-muted">{draft.occurredAt && <>تاریخ بدهکار/طلبکار شدن: <b className="text-ink">{persianDate(draft.occurredAt)}</b></>}{draft.occurredAt && draft.dueAt ? ' · ' : ''}{draft.dueAt && <>سررسید: <b className="text-ink">{persianDate(draft.dueAt)}</b></>}</p>}<div className="mt-3 grid gap-2 sm:grid-cols-2"><input required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="مثلاً طلب از حسن" className="tap rounded-lg border border-line px-3" /><input required inputMode="numeric" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value.replace(/\D/g, '') })} placeholder="مبلغ تومان" className="tap numbers rounded-lg border border-line px-3" /><select value={draft.direction} onChange={(event) => setDraft({ ...draft, direction: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="receivable">طلب دارم</option><option value="payable">بدهکارم</option></select><select value={draft.contactId} onChange={(event) => setDraft({ ...draft, contactId: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="">بدون شخص</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select><label className="text-[11px] text-muted">تاریخ بدهکار/طلبکار شدن<PersianDateInput value={draft.occurredAt} onChange={(iso) => setDraft({ ...draft, occurredAt: iso })} /></label><label className="text-[11px] text-muted">سررسید<PersianDateInput value={draft.dueAt} onChange={(iso) => setDraft({ ...draft, dueAt: iso })} /></label><button className="tap rounded-lg bg-accent font-bold text-white">ذخیره سررسید</button></div></form><div className="divide-y divide-line border-y border-line">{items.length ? items.map((item) => <article key={item.id} className="flex min-h-[76px] items-center gap-3 py-3"><HandCoins className={item.direction === 'receivable' ? 'text-income' : 'text-expense'} /><div className="min-w-0 flex-1"><p className="font-bold">{item.title}</p><p className="mt-1 text-xs text-muted">{item.contactName || 'بدون شخص'}{item.dueAt ? ` · سررسید ${new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(item.dueAt))}` : ''}</p></div><b className="numbers text-sm">{formatAmount(item.amount)}</b><button onClick={() => settle(item.id)} className="tap rounded-lg border border-income px-3 text-xs font-bold text-income">تسویه</button></article>) : <p className="py-10 text-center text-sm text-muted">طلب یا بدهی بازی نداری.</p>}</div></section>;
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
      <div className="mt-4 grid gap-2 sm:grid-cols-2"><input required value={draft.customerName} onChange={(event) => setDraft({ ...draft, customerName: event.target.value })} placeholder={draft.documentType === 'purchase' ? 'نام تأمین‌کننده' : 'نام مشتری'} className="tap rounded-lg border border-line px-3" /><select value={draft.contactId} onChange={(event) => setDraft({ ...draft, contactId: event.target.value })} className="tap rounded-lg border border-line px-3"><option value="">طرف حساب ثبت‌شده (اختیاری)</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select><select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="tap rounded-lg border border-line px-3">{categories.filter((item) => item.type === (draft.documentType === 'purchase' ? 'expense' : 'income')).map((item) => <option key={item.id}>{item.name}</option>)}</select><label className="flex items-center gap-2 rounded-lg border border-line px-3 text-xs text-muted">سررسید<input type="date" value={isoToDateInput(draft.dueAt)} onChange={(event) => setDraft({ ...draft, dueAt: event.target.value ? new Date(`${event.target.value}T09:00:00`).toISOString() : '' })} className="tap min-w-0 flex-1 bg-transparent text-ink" /></label></div>
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
    <div className="rounded-[10px] border border-line bg-surface p-4">
      <div className="flex items-start gap-3"><Landmark className="mt-1 shrink-0 text-accent" /><div><h2 className="font-extrabold">ورود صورت‌حساب بانک یا صندوق</h2><p className="mt-1 text-xs leading-6 text-muted">عنوان ستون‌های CSV به‌صورت خودکار نگاشت می‌شود؛ تاریخ شمسی/میلادی و اعداد فارسی پشتیبانی می‌شوند. <a href="/bank-statement-template.csv" download className="font-bold text-accent underline">فایل نمونه</a></p></div></div>
      <form onSubmit={upload} className="mt-4 grid gap-2 sm:grid-cols-[180px_minmax(0,1fr)_150px]"><select value={accountId} onChange={(event) => setAccountId(event.target.value)} className="tap rounded-lg border border-line bg-paper px-3">{eligibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select><label className="flex min-h-12 cursor-pointer items-center rounded-lg border border-dashed border-muted/60 bg-paper px-3 text-sm"><input type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] || null)} className="sr-only" /><span className="truncate">{file?.name || 'انتخاب فایل CSV'}</span></label><button disabled={busy || !eligibleAccounts.length} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">ورود و بررسی</button></form>
      <p className="mt-2 text-[11px] text-muted">فایل بانکی فقط روی سرور حساب‌یار پردازش می‌شود و برای OCR یا هوش مصنوعی ارسال نمی‌شود.</p>
    </div>
    {imports.length > 0 && <div><div className="mb-2 flex items-center justify-between"><h2 className="font-extrabold">دوره‌های واردشده</h2><span className="text-xs text-muted">{toPersianDigits(imports.length)} فایل</span></div><div className="scrollbar-none flex gap-2 overflow-x-auto pb-1">{imports.map((item) => <button key={item.id} onClick={() => open(item.id)} className={`min-w-[220px] rounded-[10px] border p-3 text-right ${detail?.id === item.id ? 'border-accent bg-warn-bg' : 'border-line bg-surface'}`}><span className="block truncate text-sm font-bold">{item.accountName}</span><span className="mt-1 block truncate text-xs text-muted">{item.fileName} · {item.formatName}</span><span className="numbers mt-2 block text-xs">{toPersianDigits(item.matchedCount + item.ignoredCount)} از {toPersianDigits(item.rowCount)} بررسی‌شده</span></button>)}</div></div>}
    {detail && <div className="space-y-4">
      {detail.importWarnings?.length > 0 && <div className="rounded-lg border border-accent/30 bg-warn-bg px-3 py-2 text-xs leading-6 text-muted"><b className="text-ink">نتیجهٔ تشخیص {detail.formatName}:</b> {detail.importWarnings.join(' ')}</div>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">ردیف‌ها</p><b className="numbers mt-2 block text-lg">{toPersianDigits(detail.rowCount)}</b></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">باقی‌مانده</p><b className={`numbers mt-2 block text-lg ${detail.unmatchedCount ? 'text-expense' : 'text-income'}`}>{toPersianDigits(detail.unmatchedCount)}</b></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">مانده بانک</p><b className="numbers mt-2 block text-lg">{detail.statementBalance == null ? '—' : formatAmount(detail.statementBalance)}</b></div><div className="rounded-[10px] border border-line bg-surface p-3"><p className="text-xs text-muted">اختلاف با دفتر</p><b className={`numbers mt-2 block text-lg ${detail.difference === 0 ? 'text-income' : detail.difference == null ? '' : 'text-expense'}`}>{detail.difference == null ? 'نامشخص' : formatAmount(detail.difference)}</b></div></div>
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-extrabold">بررسی ردیف‌های {detail.accountName}</h2><p className="mt-1 text-xs text-muted">{new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(detail.periodStart))} تا {new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(detail.periodEnd))}</p></div>{detail.status === 'open' ? <button disabled={busy || !detail.canClose} onClick={close} className="tap rounded-lg bg-ink px-4 text-sm font-bold text-white disabled:opacity-35">بستن تطبیق</button> : <span className="rounded-lg border border-income px-3 py-2 text-xs font-bold text-income"><Check size={16} className="ml-1 inline" />تطبیق بسته شده</span>}</div>
      {detail.status === 'open' && detail.blockingReasons?.length > 0 && <div className="rounded-lg border border-expense/25 bg-expense/5 px-3 py-2 text-xs leading-6 text-expense"><b>بستن دوره ممکن نیست:</b> {detail.blockingReasons.join(' ')}</div>}
      <div className="divide-y divide-line border-y border-line">{detail.lines.map((line) => <article key={line.id} className="py-4"><div className="flex items-start gap-3"><div className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${line.status === 'matched' ? 'bg-income' : line.status === 'ignored' ? 'bg-muted' : 'bg-accent'}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-bold">{line.description || 'بدون شرح بانکی'}</p><p className="mt-1 text-xs text-muted">{new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(line.occurredAt))}{line.reference ? ` · پیگیری ${line.reference}` : ''}</p></div><div className="text-left"><b className={`numbers block ${line.direction === 'income' ? 'text-income' : 'text-expense'}`}>{line.direction === 'income' ? '+' : '−'} {formatAmount(line.amount)}</b><span className="mt-1 block text-[10px] text-muted">{statusLabels[line.status]}</span></div></div>
        {line.status === 'unmatched' && detail.status === 'open' && <div className="mt-3 rounded-lg bg-paper p-3">
          {line.ruleSuggestion && <p className="mb-2 rounded-md bg-accent/10 px-2 py-1.5 text-xs text-accent">قانون «{line.ruleSuggestion.pattern}» دستهٔ {line.ruleSuggestion.category} را پیشنهاد می‌دهد.</p>}
          {line.candidates.length > 0 && <div><p className="text-xs font-bold text-muted">پیشنهاد تطبیق با دلیل</p><div className="mt-2 grid gap-2">{line.candidates.map((candidate) => <button disabled={busy} key={candidate.id} onClick={() => match(line.id, candidate.id)} className="tap rounded-lg border border-income bg-surface px-3 py-2 text-right text-xs"><b className="text-income">تطبیق {toPersianDigits(candidate.score)}٪</b><span className="mr-2 text-muted">{candidate.category} · {new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(new Date(candidate.occurredAt))}</span><span className="mt-1 block text-[11px] leading-5 text-muted">{candidate.reasons.join(' ')}</span></button>)}</div></div>}
          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px_100px_100px]"><select value={lineCategories[line.id] || line.ruleSuggestion?.category || (line.direction === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها')} onChange={(event) => setLineCategories({ ...lineCategories, [line.id]: event.target.value })} className="tap min-w-0 rounded-lg border border-line bg-surface px-3 text-sm">{categories.filter((category) => category.type === line.direction).map((category) => <option key={category.id}>{category.name}</option>)}</select><button disabled={busy} onClick={() => create(line)} className="tap rounded-lg bg-accent px-3 text-xs font-bold text-white">ثبت در دفتر</button><button disabled={busy || !line.description} onClick={() => learn(line)} className="tap rounded-lg border border-accent px-3 text-xs font-bold text-accent">ساخت قانون</button><button disabled={busy} onClick={() => ignore(line)} className="tap rounded-lg border border-line px-3 text-xs font-bold text-muted">کنارگذاری</button></div>
        </div>}{line.resolutionNote && <p className="mt-2 text-[11px] text-muted">{line.resolutionNote}</p>}</div></div></article>)}</div>
    </div>}
    {rules.length > 0 && <div className="rounded-[10px] border border-line bg-surface p-4"><h3 className="font-extrabold">قواعد تأییدشدهٔ بانکی</h3><div className="mt-2 flex flex-wrap gap-2">{rules.map((rule) => <span key={rule.id} className="inline-flex items-center gap-2 rounded-lg border border-line bg-paper px-2 py-1.5 text-xs">{rule.pattern} ← {rule.category}<button onClick={() => removeRule(rule.id)} aria-label={`حذف قانون ${rule.pattern}`} className="text-expense"><X size={14} /></button></span>)}</div></div>}
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
  return <div className="rounded-[10px] border border-accent/35 bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-extrabold">بازبینی رسید</h3><p className="mt-1 text-xs text-muted">پیشنهاد OCR هیچ‌وقت بدون تأیید تو وارد دفتر نمی‌شود.</p></div><a href={api.workspacePath(`/api/receipts/${detail.id}/image`)} target="_blank" rel="noreferrer" className="tap rounded-lg border border-line px-3 text-xs font-bold">دیدن تصویر اصلی</a></div>
    {detail.ocrProvider && <div className="mt-3 flex flex-wrap gap-2 text-[11px]"><span className="rounded-md bg-paper px-2 py-1">مسیر: {detail.ocrProvider === 'openai' ? 'OCR تصویر' : 'توضیح کاربر'}</span><span className={`rounded-md bg-paper px-2 py-1 ${confidence >= 72 ? 'text-income' : 'text-expense'}`}>اطمینان کلی: {toPersianDigits(confidence)}٪</span>{detail.fieldConfidence?.amount != null && <span className="rounded-md bg-paper px-2 py-1">اطمینان مبلغ: {toPersianDigits(Math.round(detail.fieldConfidence.amount * 100))}٪</span>}</div>}
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
    {detail.status !== 'linked' && <div className="mt-4 flex flex-wrap gap-2"><button disabled={busy} onClick={save} className="tap rounded-lg border border-line px-4 text-xs font-bold">فقط ذخیره اصلاحات</button><button disabled={busy || !canConfirm} onClick={() => confirm()} className="tap rounded-lg bg-accent px-4 text-xs font-bold text-white disabled:opacity-35">تأیید و ساخت ثبت</button></div>}
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
  return <div className="mt-3 rounded-[10px] border border-accent/25 bg-warn-bg p-3">
    <p className="text-sm font-bold leading-7">{toPersianDigits(answer.answer)}</p>
    {answer.scope && <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] font-bold text-muted"><span className="rounded-full bg-surface px-2 py-1">بازه: {toPersianDigits(answer.scope.label)}</span>{scopeRange && <span className="rounded-full bg-surface px-2 py-1">{toPersianDigits(scopeRange)}</span>}<span className="rounded-full bg-surface px-2 py-1">واحد: {answer.scope.unit}</span><span className="rounded-full bg-surface px-2 py-1">{answer.scope.basisLabel}</span></div>}
    <details className="mt-3 border-t border-accent/15 pt-2"><summary className="cursor-pointer text-xs font-extrabold">عدد از کجا آمده؟</summary><p className="mt-2 text-[11px] leading-5 text-muted">{answer.provenance?.calculation || 'محاسبه مستقیم از داده‌های دفتر'}</p><p className="mt-1 text-[11px] text-muted">{toPersianDigits(answer.provenance?.sourceCount || 0)} منبع سازندهٔ پاسخ</p>
      {answer.sources?.length ? <div className="scrollbar-none mt-2 flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">{answer.sources.map((source) => <button type="button" key={`${source.kind}-${source.id}-${source.period || ''}`} onClick={() => setSelectedSource(source)} className={`rounded-md border px-2 py-1 text-[10px] font-bold ${selectedSource?.id === source.id && selectedSource?.period === source.period ? 'border-accent bg-surface text-accent' : 'border-line bg-surface text-muted'}`}>{kindLabel[source.kind] || 'منبع'} · {source.label}</button>)}</div> : <p className="mt-2 rounded-md bg-surface px-2 py-1.5 text-[11px] text-muted">هیچ ثبت سازنده‌ای در این محدوده پیدا نشد؛ مقدار صفر از نبودِ ثبت به‌دست آمده است.</p>}
      {selectedSource && <div className="mt-2 rounded-lg border border-line bg-surface p-2 text-[11px] leading-5"><div className="flex items-center justify-between gap-2"><b>{selectedSource.label}</b><span className="numbers text-muted">{selectedSource.amount != null ? `${formatAmount(selectedSource.amount)} تومان` : ''}</span></div><p className="mt-1 text-muted">{kindLabel[selectedSource.kind] || 'منبع'}{selectedSource.category ? ` · ${selectedSource.category}` : ''}{selectedSource.contactName ? ` · ${selectedSource.contactName}` : ''}{dateLabel ? ` · ${dateLabel}` : ''}{selectedSource.period === 'previous' || selectedSource.period === 'baseline' ? ' · خط مبنا' : ''}</p><p className="mt-1 select-all font-mono text-[9px] text-muted">شناسه: {selectedSource.id}</p></div>}
    </details>
    <p className="mt-3 border-t border-accent/15 pt-2 text-[10px] leading-5 text-muted">{answer.disclaimer}</p>
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
    <div className="rounded-[10px] border border-line bg-surface p-4"><div className="flex items-center gap-2"><Sparkles size={19} className="text-accent" /><h2 className="font-extrabold">از دفترت بپرس</h2></div><p className="mt-2 text-xs leading-6 text-muted">پاسخ فقط از داده‌های ثبت‌شده ساخته می‌شود؛ هیچ عددی حدس زده نمی‌شود. می‌توانی آخرین پرداخت، جمع یک دسته، ماندهٔ یک شخص یا مقایسهٔ دو بازه را بپرسی.</p><form onSubmit={ask} className="mt-3 flex gap-2"><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="مثلاً خوراک این ماه چقدر شد؟" className="tap min-w-0 flex-1 rounded-lg border border-line px-3" /><button className="tap rounded-lg bg-ink px-4 font-bold text-white">بپرس</button></form>{answer && <FinancialAnswerCard answer={answer} />}</div>
    <form onSubmit={saveReceiptFile} className="rounded-[10px] border border-line bg-surface p-4"><div className="flex items-center gap-2"><ReceiptText size={20} className="text-accent" /><h2 className="font-extrabold">ورود هوشمند رسید</h2></div><p className="mt-2 text-xs leading-6 text-muted">مبلغ، تاریخ و فروشنده از تصویر پیشنهاد می‌شود. توضیح صوتی برای دسته، حساب و روش تسویه به پیشنهاد اضافه می‌شود.</p>{!ocrConfigured && <p className="mt-2 rounded-lg bg-warn-bg px-3 py-2 text-xs text-expense">OPENAI_API_KEY برای OCR تنظیم نیست؛ عکس از بین نمی‌رود و با توضیح تو وارد صندوق بازبینی می‌شود.</p>}<input ref={fileInputRef} required type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => setReceiptFile(event.target.files?.[0] || null)} className="mt-3 block w-full text-xs" /><div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px]"><div className="flex gap-2"><input value={receiptNote} onChange={(event) => setReceiptNote(event.target.value)} placeholder="مثلاً مواد خریدم، با کارت بانک ملت" className="tap min-w-0 flex-1 rounded-lg border border-line px-3" /><button type="button" onClick={toggleDictation} className={`tap grid place-items-center rounded-lg border px-3 ${dictating ? 'border-expense bg-expense/10 text-expense' : 'border-line text-accent'}`} aria-label={dictating ? 'توقف توضیح صوتی' : 'توضیح صوتی'}><Mic size={19} /></button></div><select value={receiptAccountId} onChange={(event) => setReceiptAccountId(event.target.value)} className="tap rounded-lg border border-line bg-surface px-3 text-sm">{accounts.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><button disabled={receiptBusy} className="tap mt-3 w-full rounded-lg bg-accent font-bold text-white disabled:opacity-40">{receiptBusy ? 'در حال خواندن و تحلیل…' : 'خواندن رسید و افزودن به صندوق'}</button>
      {receipts.length > 0 && <div className="mt-4 border-t border-line pt-3"><div className="flex items-center justify-between"><h3 className="text-sm font-extrabold">صندوق رسیدها</h3><span className="text-xs text-muted">{toPersianDigits(receipts.filter((item) => item.status !== 'linked').length)} مورد باز</span></div><div className="scrollbar-none mt-2 flex gap-2 overflow-x-auto pb-1">{receipts.slice(0, 20).map((item) => { const status = RECEIPT_STATUS[item.status] || RECEIPT_STATUS.review; return <button type="button" key={item.id} onClick={() => openReceipt(item.id)} className={`min-w-[180px] rounded-lg border p-3 text-right ${selectedReceipt?.id === item.id ? 'border-accent bg-warn-bg' : 'border-line bg-paper'}`}><span className="block truncate text-xs font-bold">{item.merchant || item.fileName}</span><span className="numbers mt-1 block text-sm">{item.amount ? `${formatAmount(item.amount)} تومان` : 'مبلغ نامشخص'}</span><span className={`mt-1 block text-[10px] ${status[1]}`}>{status[0]}</span></button>; })}</div></div>}
    </form>
    {selectedReceipt && <ReceiptReviewPanel detail={selectedReceipt} candidates={receiptMatches} accounts={accounts} categories={categories} notify={notify} onChanged={updateSelected} refresh={refresh} />}
    {profileType === 'business' && <form onSubmit={close} className="rounded-[10px] border border-line bg-surface p-4"><h2 className="font-extrabold">بستن صندوق امروز</h2><p className="mt-2 text-xs leading-6 text-muted">پول واقعی صندوق را وارد کن تا اختلافش با ثبت‌های امروز مشخص شود.</p><div className="mt-3 flex gap-2"><input required inputMode="numeric" value={countedCash} onChange={(event) => setCountedCash(event.target.value.replace(/\D/g, ''))} placeholder="موجودی شمارش‌شده" className="tap numbers min-w-0 flex-1 rounded-lg border border-line px-3" /><button className="tap rounded-lg bg-accent px-4 font-bold text-white">محاسبه</button></div>{closing && <p className={`numbers mt-3 rounded-lg px-3 py-2 text-sm font-bold ${closing.difference === 0 ? 'bg-income/10 text-income' : 'bg-warn-bg text-expense'}`}>اختلاف: {formatAmount(closing.difference)} تومان</p>}</form>}
    <div className="rounded-[10px] border border-line bg-surface p-4"><p className="text-sm font-bold">محدوده فعلی حساب‌یار</p><p className="mt-2 text-xs leading-6 text-muted">{PRODUCT_POSITIONING.accountingDisclaimer}</p></div>
  </section>;
}

function BottomNav({ screen, navigate, access }) {
  // فقط صفحه‌های اصلی در نوار پایین جا می‌شوند؛ بقیه در کشو می‌مانند.
  const items = allowedScreens(access).filter((item) => item.primary).slice(0, 4)
    .map((item) => ({ id: item.id, label: item.label, icon: SCREEN_ICONS[item.icon] || Home }));
  return <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto flex h-[76px] max-w-[640px] items-start justify-around border-t border-line bg-surface px-3 pb-[env(safe-area-inset-bottom)] pt-2 lg:hidden">{items.map((item) => { const Icon = item.icon; const active = screen === item.id; return <button key={item.id} onClick={() => navigate(item.id)} className={`tap flex min-w-20 flex-col items-center justify-center gap-1 rounded-lg text-[12px] font-bold ${active ? 'text-accent' : 'text-muted'}`}><Icon size={21} strokeWidth={active ? 2.6 : 2} />{item.label}</button>; })}</nav>;
}

function Drawer({ profileType = 'business', close, navigate, access }) {
  const profile = profileDefinition(profileType);
  return <div className="fixed inset-0 z-[60] bg-ink/35 lg:hidden" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <aside className="sheet-in h-full w-[82%] max-w-[330px] bg-paper px-4 py-5 shadow-2xl">
      <div className="flex items-center justify-between"><div><p className="text-xl font-extrabold">حساب‌یار</p><p className="text-xs text-muted">{profile.label} · دستیار نقدینگی</p></div><button onClick={close} className="tap grid place-items-center" aria-label="بستن"><X /></button></div>
      <div className="mt-8 space-y-2">
        {/* همان فهرستی که سرور اجازه داده؛ کشو نسخهٔ دوم نمی‌سازد. */}
        {allowedScreens(access).map((item) => {
          const Icon = SCREEN_ICONS[item.icon] || Home;
          return <DrawerItem key={item.id} icon={Icon} label={item.label} onClick={() => navigate(item.id)} />;
        })}
      </div>
      <div className="absolute bottom-6 right-4 left-4 border-t border-line pt-4 text-xs leading-6 text-muted">هیچ مبلغی بدون تأیید تو ثبت نمی‌شود.</div>
    </aside>
  </div>;
}

function DrawerItem({ icon: Icon, label, onClick }) { return <button onClick={onClick} className="tap flex w-full items-center gap-3 rounded-lg px-3 text-right font-bold hover:bg-surface"><Icon size={20} className="text-muted" />{label}</button>; }

/**
 * کارت تأیید نیت‌های ساختاری (طلب، بدهی، چک).
 *
 * جهت پول مهم‌ترین چیزی است که می‌تواند غلط باشد، پس همیشه به‌صورت دو دکمهٔ
 * صریح نشان داده می‌شود — حتی وقتی تشخیص مطمئن است. جملهٔ مبهم بدون انتخاب
 * کاربر اصلاً ذخیره نمی‌شود.
 */
function IntentSheet({ draft, setDraft, accounts = [], close, confirm }) {
  const [busy, setBusy] = useState(false);
  const [availableTaxRates, setAvailableTaxRates] = useState([]);

  // نرخ‌ها فقط وقتی گرفته می‌شوند که سند فاکتور باشد؛ بقیهٔ نیت‌ها مالیات ندارند.
  useEffect(() => {
    if (draft.intent !== 'invoice') return;
    let cancelled = false;
    api.taxRates()
      .then((response) => { if (!cancelled) setAvailableTaxRates((response.items || []).filter((rate) => rate.active && rate.treatment === 'taxable')); })
      .catch(() => { if (!cancelled) setAvailableTaxRates([]); });
    return () => { cancelled = true; };
  }, [draft.intent]);

  const patchLine = (index, changes) => setDraft({
    ...draft,
    lines: (draft.lines || []).map((line, position) => (position === index ? { ...line, ...changes } : line)),
  });
  const linesTotal = invoiceLinesTotal(draft);
  const isCheque = draft.intent === 'cheque';
  const isInvoice = draft.intent === 'invoice';
  const isCapital = draft.intent === 'capital';
  const isAsset = draft.intent === 'fixed-asset';
  const isEquityMove = isCapital || isAsset;
  const ready = isInvoice ? true : isEquityMove ? Boolean(String(draft.title || '').trim()) : Boolean(draft.direction);
  const label = isInvoice ? 'فاکتور' : isCapital ? 'سرمایه' : isAsset ? 'دارایی ثابت' : isCheque ? 'چک' : 'طلب و بدهی';
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    await confirm(draft);
    setBusy(false);
  };
  return <div className="fixed inset-0 z-[77] flex items-end justify-center bg-ink/40 backdrop-blur-[2px]">
    <section role="dialog" aria-modal="true" aria-label={isInvoice ? 'تأیید پیش‌نویس فاکتور' : 'تأیید طلب یا بدهی'} className="sheet-in w-full max-w-[560px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl">
      <div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" />
      <span className="rounded-full bg-accent/10 px-2 py-1 text-[10px] font-extrabold text-accent">{label}</span>
      <h2 className="mt-3 text-xl font-extrabold">
        {isInvoice ? 'پیش‌نویس فاکتور ساخته شود؟'
          : isCapital ? 'این آورده به حساب سرمایه برود؟'
            : isAsset ? 'این خرید دارایی ثابت است؟'
              : isCheque ? 'این چک ثبت شود؟' : 'این مورد ثبت شود؟'}
      </h2>
      <blockquote className="mt-3 rounded-lg border border-line bg-surface px-3 py-3 text-sm text-muted">«{draft.transcript}»</blockquote>

      <div className="mt-4 rounded-[10px] border border-line bg-surface px-3 py-3">
        <p className="text-xs font-bold text-muted">مبلغ</p>
        <b className="numbers mt-1 block text-2xl">{formatAmount(draft.amount)} <span className="text-[12px] font-normal text-muted">تومان</span></b>
      </div>

      {isEquityMove ? <>
        <label className="mt-3 block text-xs font-bold text-muted">{isCapital ? 'عنوان آورده' : 'نام دارایی'}
          <input value={draft.title || ''} onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder={isCapital ? 'آوردهٔ نقدی مالک' : 'مثلاً لپ‌تاپ، خودرو، دستگاه چاپ'}
            className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink" />
        </label>
        {/* حساب دارایی بی‌نام، ردیفی است که شش ماه بعد هیچ‌کس نمی‌داند چیست. */}
        {isAsset && !String(draft.title || '').trim() && <p className="mt-1 text-[11px] leading-5 text-expense">
          نام دارایی از جمله برداشت نشد؛ خودت بنویس. حساب دارایی بدون نام در دفتر کل قابل پیگیری نیست.
        </p>}

        <div className="mt-3">
          <p className="text-xs font-bold text-muted">{isCapital ? 'پول به کدام حساب آمد؟' : 'پول از کدام حساب رفت؟'}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {accounts.filter((item) => item.active).map((item) => (
              <button key={item.id} onClick={() => setDraft({ ...draft, accountId: item.id })}
                className={`tap rounded-lg border px-3 py-2 text-xs font-bold ${draft.accountId === item.id ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-muted'}`}>{item.name}</button>
            ))}
          </div>
        </div>

        <p className="mt-3 rounded-lg bg-warn-bg px-3 py-3 text-[11px] leading-6 text-accent">
          {isCapital
            ? 'آورده درآمد نیست: در جمع درآمد و سود ماه نمی‌آید و بستانکار حساب سرمایه می‌شود. مانده و کنترل پایان روزِ همان حساب، این پول را می‌بیند.'
            : 'دارایی ثابت هزینهٔ این ماه نیست: به بهای تمام‌شده در دارایی‌ها می‌نشیند و از جمع هزینهٔ دوره بیرون می‌ماند. استهلاک در این نسخه محاسبه نمی‌شود.'}
        </p>
      </> : isInvoice ? <>
        <div className="mt-3">
          <p className="text-xs font-bold text-muted">نوع سند</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {[['sales', 'فاکتور فروش'], ['purchase', 'فاکتور خرید']].map(([value, text]) => (
              <button key={value} onClick={() => setDraft({ ...draft, documentType: value })}
                className={`tap rounded-lg border px-3 py-2 text-xs font-bold ${draft.documentType === value ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-muted'}`}>{text}</button>
            ))}
          </div>
        </div>

        <label className="mt-3 block text-xs font-bold text-muted">{draft.documentType === 'purchase' ? 'تأمین‌کننده' : 'مشتری'}
          <input value={draft.contactName || ''} onChange={(event) => setDraft({ ...draft, contactName: event.target.value })}
            placeholder={draft.documentType === 'purchase' ? 'تأمین‌کننده متفرقه' : 'مشتری متفرقه'}
            className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink" />
        </label>

        <div className="mt-3">
          <p className="text-xs font-bold text-muted">ردیف‌ها</p>
          <div className="mt-2 space-y-2">
            {(draft.lines || []).map((line, index) => (
              <div key={index} className="grid grid-cols-[minmax(0,1fr)_58px_minmax(0,110px)] gap-2">
                <input value={line.title} onChange={(event) => patchLine(index, { title: event.target.value })}
                  placeholder="نام کالا یا خدمت" className="tap rounded-lg border border-line bg-surface px-2 text-xs text-ink" />
                <input dir="ltr" inputMode="numeric" value={line.quantity}
                  onChange={(event) => patchLine(index, { quantity: Number(event.target.value) || 0 })}
                  className="tap rounded-lg border border-line bg-surface px-2 text-center text-xs numbers" />
                <input dir="ltr" inputMode="numeric" value={line.unitPrice}
                  onChange={(event) => patchLine(index, { unitPrice: Number(event.target.value) || 0 })}
                  className="tap rounded-lg border border-line bg-surface px-2 text-left text-xs numbers" />
              </div>
            ))}
          </div>
          {!(draft.lines || []).length && <p className="mt-1 text-[11px] leading-5 text-muted">
            نرخ واحد در جمله گفته نشد، پس یک ردیف به کل مبلغ ساخته می‌شود. برای ردیف دقیق بگو
            «ده عدد چای هرکدام پنجاه هزار تومان».
          </p>}
          {(draft.lines || []).length > 0 && <p className="numbers mt-2 text-right text-xs text-muted">
            جمع ردیف‌ها: <b className="text-ink">{formatAmount(linesTotal)}</b> تومان
          </p>}
        </div>

        {/* نرخ مالیات فقط از نرخ‌های تعریف‌شدهٔ همین دفتر می‌آید؛ ساختن نرخ از روی
            حرف، عددی به سند می‌دهد که در دفتر وجود ندارد. */}
        <div className="mt-3">
          <p className="text-xs font-bold text-muted">مالیات</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => setDraft({ ...draft, taxRateId: null })}
              className={`tap rounded-lg border px-3 py-2 text-xs font-bold ${!draft.taxRateId ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-muted'}`}>بدون مالیات</button>
            {availableTaxRates.map((rate) => (
              <button key={rate.id} onClick={() => setDraft({ ...draft, taxRateId: rate.id })}
                className={`tap rounded-lg border px-3 py-2 text-xs font-bold ${draft.taxRateId === rate.id ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-muted'}`}>
                {rate.name} <span className="numbers">({toPersianDigits(rate.rate)}٪)</span>
              </button>
            ))}
          </div>
          {draft.tax?.wanted && !availableTaxRates.length && <p className="mt-1 text-[11px] leading-5 text-expense">
            در جمله مالیات خواسته شد ولی هیچ نرخ فعالی در این دفتر تعریف نشده است. نرخ را در «مالیات» بساز؛
            حساب‌یار نرخ نمی‌سازد چون سند باید به نرخ واقعی دفتر بخورد.
          </p>}
          {draft.tax?.wanted && draft.tax.ratePercent != null && !availableTaxRates.some((rate) => Math.round(rate.rate) === draft.tax.ratePercent) && availableTaxRates.length > 0 && (
            <p className="mt-1 text-[11px] leading-5 text-accent">
              نرخ <span className="numbers">{toPersianDigits(draft.tax.ratePercent)}٪</span> گفته شد ولی در نرخ‌های این دفتر نیست؛ خودت از بالا انتخاب کن.
            </p>
          )}
        </div>

        <label className="mt-3 flex items-start gap-2 text-[12px] leading-6">
          <input type="checkbox" checked={draft.issueNow === true}
            onChange={(event) => setDraft({ ...draft, issueNow: event.target.checked })} className="mt-1" />
          <span>همین حالا صادر شود {draft.occurredAt ? <>با تاریخ <b>{persianDate(draft.occurredAt)}</b></> : '(با تاریخ امروز)'}</span>
        </label>

        <p className="mt-3 rounded-lg bg-warn-bg px-3 py-3 text-[11px] leading-6 text-accent">
          {draft.issueNow
            ? 'سند صادر می‌شود: در دفتر کل سند می‌خورد، در گزارش مالیاتی می‌آید و در جمع طلب و بدهی می‌نشیند. پس از صدور، اصلاحش سند برگشتی می‌خواهد.'
            : 'سند به‌صورت پیش‌نویس می‌ماند: نه در دفتر کل سند می‌خورد، نه در گزارش مالیاتی می‌آید و نه در جمع طلب و بدهی. هر وقت خواستی از برگهٔ «فاکتورها» صادرش کن.'}
        </p>
      </> : <>
        <div className="mt-3">
          <p className="text-xs font-bold text-muted">جهت</p>
          {draft.ambiguous && <p className="mt-1 text-[11px] leading-5 text-expense">جمله هم نشانهٔ طلب داشت هم بدهی؛ خودت انتخاب کن.</p>}
          <div className="mt-2 grid grid-cols-2 gap-2">
            {[['receivable', 'طلب ما (بدهکار است)'], ['payable', 'بدهی ما (طلبکار است)']].map(([value, text]) => (
              <button key={value} onClick={() => setDraft({ ...draft, direction: value, ambiguous: false })}
                className={`tap rounded-lg border px-3 py-2 text-xs font-bold ${draft.direction === value ? 'border-accent bg-accent/10 text-accent' : 'border-line bg-surface text-muted'}`}>{text}</button>
            ))}
          </div>
        </div>

        <label className="mt-3 block text-xs font-bold text-muted">عنوان
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            className="tap mt-1 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink" />
        </label>

        {draft.occurredAt && <p className="mt-3 text-xs text-muted">تاریخ بدهکار/طلبکار شدن: <b className="text-ink">{persianDate(draft.occurredAt)}</b></p>}
      {draft.dueAt && <p className="mt-1 text-xs text-muted">سررسید: <b className="text-ink">{persianDate(draft.dueAt)}</b></p>}
      </>}

      <div className="mt-5 grid grid-cols-[2fr_1fr] gap-2">
        <button disabled={busy || !ready} onClick={submit} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">
          {busy ? 'در حال ثبت…' : isInvoice ? 'پیش‌نویس بساز' : 'ثبت کن'}
        </button>
        <button disabled={busy} onClick={close} className="tap rounded-lg border border-line bg-surface font-bold">لغو</button>
      </div>
    </section>
  </div>;
}

/**
 * انتخاب و تأیید تسویهٔ یک سند موجود.
 *
 * خطر این مسیر از ساختن سند بیشتر است: تسویهٔ سند اشتباه یعنی پول در جای
 * اشتباه جابه‌جا می‌شود و یک سند باز، بسته اعلام می‌شود. پس هیچ سندی خودکار
 * تسویه نمی‌شود — حتی وقتی فقط یک گزینه بخورد، کاربر باید همان یکی را تأیید کند.
 */
function SettleSheet({ draft, obligations = [], close, confirm }) {
  const [invoices, setInvoices] = useState([]);
  const [loadingInvoices, setLoadingInvoices] = useState(true);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (draft.bounced) { setLoadingInvoices(false); return undefined; }
    let cancelled = false;
    api.invoices()
      .then((response) => { if (!cancelled) setInvoices(response.items || []); })
      .catch(() => { if (!cancelled) setInvoices([]); })
      .finally(() => { if (!cancelled) setLoadingInvoices(false); });
    return () => { cancelled = true; };
  }, [draft.bounced]);

  const targets = draft.bounced ? [] : matchSettleTargets(draft, { invoices, obligations });
  const selected = targets.find((item) => item.id === selectedId) || null;
  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    await confirm(selected, { occurredAt: draft.occurredAt });
    setBusy(false);
  };

  return <div className="fixed inset-0 z-[77] flex items-end justify-center bg-ink/40 backdrop-blur-[2px]">
    <section role="dialog" aria-modal="true" aria-label="تأیید تسویه" className="sheet-in w-full max-w-[560px] rounded-t-2xl bg-paper p-4 pb-[calc(env(safe-area-inset-bottom)+20px)] shadow-2xl">
      <div className="mx-auto mb-4 h-1 w-11 rounded-full bg-line" />
      <span className="rounded-full bg-accent/10 px-2 py-1 text-[10px] font-extrabold text-accent">تسویه</span>
      <h2 className="mt-3 text-xl font-extrabold">{draft.bounced ? 'چک برگشتی تسویه نمی‌شود' : 'کدام سند تسویه شود؟'}</h2>
      <blockquote className="mt-3 rounded-lg border border-line bg-surface px-3 py-3 text-sm text-muted">«{draft.transcript}»</blockquote>

      {draft.bounced ? <p className="mt-4 rounded-lg bg-warn-bg px-3 py-3 text-[12px] leading-6 text-accent">
        برگشت چک، تسویه نیست: سند همچنان باز می‌ماند و معمولاً پیگیری حقوقی یا ثبت هزینهٔ جداگانه می‌خواهد.
        حساب‌یار عمداً کاری انجام نمی‌دهد تا یک سند باز، بسته اعلام نشود.
      </p> : <>
        {loadingInvoices && <p className="mt-4 text-sm text-muted">در حال خواندن سندهای باز…</p>}

        {!loadingInvoices && !targets.length && <p className="mt-4 rounded-lg bg-warn-bg px-3 py-3 text-[12px] leading-6 text-accent">
          سند بازی که با این توضیح بخورد پیدا نشد. شاید نام یا مبلغ فرق دارد، یا سند هنوز صادر نشده است
          — پیش‌نویس تسویه نمی‌شود.
        </p>}

        {targets.length > 1 && <p className="mt-4 text-[12px] leading-6 text-expense">
          {toPersianDigits(targets.length)} سند با این توضیح می‌خورد. خودت انتخاب کن؛ حساب‌یار حدس نمی‌زند
          چون تسویهٔ سند اشتباه، پول را در جای اشتباه جابه‌جا می‌کند.
        </p>}

        <div className="mt-3 space-y-2">
          {targets.map((target) => (
            <button key={target.id} onClick={() => setSelectedId(target.id)}
              className={`tap flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-3 text-right ${selectedId === target.id ? 'border-accent bg-accent/10' : 'border-line bg-surface'}`}>
              <span className="min-w-0">
                <b className="block truncate text-sm">{target.label}</b>
                <span className="mt-0.5 block text-[11px] text-muted">
                  {target.kind === 'invoice' ? 'فاکتور' : target.direction === 'receivable' ? 'طلب ما' : 'بدهی ما'}
                  {target.name ? ` · ${target.name}` : ''}
                </span>
              </span>
              <b className="numbers shrink-0 text-sm">{formatAmount(target.amount)}</b>
            </button>
          ))}
        </div>

        {draft.occurredAt && <p className="mt-3 text-xs text-muted">تاریخ تسویه: <b className="text-ink">{persianDate(draft.occurredAt)}</b></p>}
      </>}

      <div className="mt-5 grid grid-cols-[2fr_1fr] gap-2">
        {!draft.bounced && <button disabled={busy || !selected} onClick={submit} className="tap rounded-lg bg-accent font-extrabold text-white disabled:opacity-40">{busy ? 'در حال تسویه…' : 'تسویه کن'}</button>}
        <button disabled={busy} onClick={close} className={`tap rounded-lg border border-line bg-surface font-bold ${draft.bounced ? 'col-span-2' : ''}`}>{draft.bounced ? 'باشه' : 'لغو'}</button>
      </div>
    </section>
  </div>;
}
