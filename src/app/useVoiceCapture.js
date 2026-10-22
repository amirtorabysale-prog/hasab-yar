// ضبط صدا: میکروفن، متن زندهٔ مرورگر و Realtime، انتخاب نتیجهٔ سریع یا فرستادن فایل
// به سرور، و ذخیرهٔ آفلاین صدا.
//
// از src/App.jsx جدا شد؛ متن توابع و effectها دست نخورده است. App این قلاب را در
// هر رندر با مقدارهای همان رندر صدا می‌زند، پس هر closure همان چیزی را می‌بیند که
// پیش‌تر درون App می‌دید.

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { assessAudioCapture, createWavRecorder } from '../lib/wavRecorder.js';
import { browserRecognitionCanRestart, createPersianRecognizer, liveSpeechErrorMessage, liveSpeechSupported, mergeSpeechSegments } from '../lib/liveSpeech.js';
import { saveOfflineAudio } from '../lib/offlineAudio.js';
import { createRealtimeTranscriber, realtimeSpeechAvailable, rememberRealtimeFailure } from '../lib/realtimeSpeech.js';
import { decideVoiceRoute } from '../lib/voiceDecision.js';
import { parseFinancialText, parseRecognitionCandidates } from '../../shared/parser.js';
import { isCorrectionCommand } from '../../shared/correction.js';
import { realtimeWorthTrying } from '../lib/voiceStatus.js';
import { selectVoiceSnapshot } from '../lib/voiceArbitration.js';

export function useVoiceCapture({ data, online, notify, refreshVoiceSystemStatus, voiceSystemStatusRef, openCorrection, routeIntent, setFailure, setParseResult, setPendingAudioCount, activeOfflineScope }) {
  const [recordState, setRecordState] = useState('idle');
  const [voicePath, setVoicePath] = useState('ready');

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
      else if (!result.transactions?.length) setFailure({ transcript: result.transcript || 'متن صدا مشخص نشد.', message: result.clarification });
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
      else if (result.clarification) setFailure({ transcript: result.transcript, message: result.clarification });
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
  return { recordState, voicePath, liveTranscript, liveVoiceNote, livePreview, levels, holdingRef, fastVoiceAvailable, startRecording, stopRecording, cancelProcessing };
}
