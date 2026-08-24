import { FINANCIAL_SPEECH_PHRASES, normalizePersian } from '../../shared/parser.js';

export function liveSpeechSupported() {
  return typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

const SPEECH_ERROR_MESSAGES = {
  'no-speech': 'تشخیص زنده صدای واضحی نشنید؛ فایل صوتی روی سرور بررسی می‌شود.',
  network: 'سرویس زندهٔ مرورگر در دسترس نیست؛ فایل صوتی روی سرور بررسی می‌شود.',
  'audio-capture': 'مرورگر نتوانست صدای میکروفن را دریافت کند.',
  aborted: 'تشخیص زنده متوقف شد.',
  'not-allowed': 'اجازهٔ تشخیص صدا در مرورگر داده نشده است.',
  'service-not-allowed': 'سرویس تشخیص صدای مرورگر در این دستگاه فعال نیست.',
  'language-not-supported': 'تشخیص زندهٔ فارسی در این مرورگر پشتیبانی نمی‌شود.',
  'start-failed': 'تشخیص زندهٔ مرورگر شروع نشد؛ فایل صوتی روی سرور بررسی می‌شود.',
  VOICE_REALTIME_TIMEOUT: 'اتصال تایپ زنده کند بود؛ صدای کامل روی سرور بررسی می‌شود.',
  VOICE_REALTIME_CHANNEL: 'کانال تایپ زنده باز نشد؛ صدای کامل روی سرور بررسی می‌شود.',
  VOICE_REALTIME_CONFIG: 'تنظیم تایپ زنده روی سرور معتبر نیست؛ صدای کامل بررسی می‌شود.',
  VOICE_AUTH: 'تایپ زنده روی سرور مجوز ندارد؛ تنظیم کلید سرویس باید بررسی شود.',
  VOICE_QUOTA: 'سهمیهٔ تایپ زنده موقتاً تمام شده؛ صدای کامل بررسی می‌شود.',
};

export function liveSpeechErrorMessage(code) {
  return SPEECH_ERROR_MESSAGES[code] || 'تشخیص زنده نتیجه نداد؛ فایل صوتی روی سرور بررسی می‌شود.';
}

function snapshotResults(results) {
  const primary = [];
  const alternativesByResult = [];
  let interim = '';
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const alternatives = Array.from(result).map((item) => ({ transcript: normalizePersian(item.transcript), confidence: item.confidence || 0 }));
    alternativesByResult.push(alternatives);
    if (result.isFinal) primary.push(alternatives[0]?.transcript || '');
    else interim = alternatives[0]?.transcript || '';
  }
  const finalTranscript = normalizePersian(primary.join(' '));
  const transcript = normalizePersian([finalTranscript, interim].filter(Boolean).join(' '));
  const candidates = [{ transcript, confidence: alternativesByResult.reduce((sum, group) => sum + (group[0]?.confidence || 0), 0) / Math.max(1, alternativesByResult.length) }];
  for (let resultIndex = 0; resultIndex < alternativesByResult.length; resultIndex += 1) {
    for (let alternativeIndex = 1; alternativeIndex < alternativesByResult[resultIndex].length; alternativeIndex += 1) {
      const parts = alternativesByResult.map((group, index) => group[index === resultIndex ? alternativeIndex : 0]?.transcript || '');
      candidates.push({ transcript: normalizePersian(parts.join(' ')), confidence: alternativesByResult[resultIndex][alternativeIndex].confidence || 0 });
    }
  }
  return { transcript, finalTranscript, interim: normalizePersian(interim), candidates };
}

export function createPersianRecognizer({ phrases = [], onUpdate, onEnd, onError }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return null;
  const recognition = new Recognition();
  recognition.lang = 'fa-IR';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;

  const Phrase = window.SpeechRecognitionPhrase;
  if (Phrase && 'phrases' in recognition) {
    try {
      const uniquePhrases = [...new Set([...FINANCIAL_SPEECH_PHRASES, ...phrases].map(normalizePersian).filter(Boolean))];
      recognition.phrases = uniquePhrases.slice(0, 80).map((phrase) => new Phrase(phrase, 5));
    } catch { /* Context biasing is experimental; recognition still works without it. */ }
  }

  recognition.onresult = (event) => onUpdate?.(snapshotResults(event.results));
  recognition.onerror = (event) => onError?.(event.error || 'unknown');
  recognition.onend = () => onEnd?.();
  return recognition;
}
