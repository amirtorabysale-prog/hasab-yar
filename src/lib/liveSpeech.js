import { FINANCIAL_SPEECH_PHRASES, normalizePersian } from '../../shared/parser.js';

export function liveSpeechSupported() {
  return typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function browserRecognitionCanRestart(errorCode = '') {
  return !errorCode || errorCode === 'no-speech' || errorCode === 'aborted';
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
  VOICE_QUOTA: 'اعتبار OpenAI تمام شده؛ فعلاً با تشخیص Chrome و فایل پشتیبان ادامه می‌دهیم.',
  VOICE_RATE_LIMIT: 'تایپ زنده موقتاً محدود شده؛ تشخیص Chrome و فایل پشتیبان ادامه دارد.',
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

/**
 * تشخیص گفتار Chrome وسط ضبط تمام می‌شود و دوباره راه می‌افتد؛ نشست تازه با
 * results خالی شروع می‌کند. بدون این ادغام، هرچه کاربر پیش از راه‌اندازی دوباره
 * گفته بود از تایپ زنده پاک می‌شد — و بدتر: مسیر محلی ممکن بود همان متن ناقص
 * را ثبت کند و صدای کامل هرگز به سرور نرسد.
 */
export function mergeSpeechSegments(carried, snapshot) {
  const carriedText = normalizePersian(carried);
  if (!carriedText) return snapshot;
  const join = (...parts) => normalizePersian(parts.filter(Boolean).join(' '));
  const finalTranscript = join(carriedText, snapshot.finalTranscript);
  return {
    ...snapshot,
    finalTranscript,
    transcript: join(finalTranscript, snapshot.interim),
    candidates: (snapshot.candidates || []).map((candidate) => ({
      ...candidate,
      transcript: join(carriedText, candidate.transcript),
    })),
  };
}

const PHRASE_FLAG_KEY = 'hesab-yar:phrase-biasing-blocked';

/**
 * تقویت واژه‌های مالی (context biasing) در بعضی نسخه‌های Chrome هست ولی فعال
 * نمی‌شود و نشست را با خطای `phrases-not-supported` می‌کشد.
 *
 * تنظیم `phrases` خطا پرتاب نمی‌کند؛ نشست بعداً می‌میرد. پس try/catch دور
 * انتساب هیچ‌چیز را نمی‌گرفت و تشخیص زندهٔ مرورگر روی آن دستگاه‌ها کاملاً از کار
 * می‌افتاد — بدون اینکه معلوم باشد چرا. یادداشت این ناتوانی در حافظهٔ مرورگر
 * می‌ماند تا نشست‌های بعدی از همان اول بدون تقویت شروع شوند.
 */
function phraseBiasingBlocked() {
  try { return window.localStorage?.getItem(PHRASE_FLAG_KEY) === '1'; } catch { return false; }
}

function blockPhraseBiasing() {
  try { window.localStorage?.setItem(PHRASE_FLAG_KEY, '1'); } catch { /* حافظهٔ مرورگر ممکن است بسته باشد */ }
}

export function createPersianRecognizer({ phrases = [], onUpdate, onEnd, onError }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return null;

  let active = null;
  let swapping = false;
  let retriedWithoutPhrases = phraseBiasingBlocked();

  const build = (usePhrases) => {
    const recognition = new Recognition();
    recognition.lang = 'fa-IR';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;

    const Phrase = window.SpeechRecognitionPhrase;
    if (usePhrases && Phrase && 'phrases' in recognition) {
      try {
        const uniquePhrases = [...new Set([...FINANCIAL_SPEECH_PHRASES, ...phrases].map(normalizePersian).filter(Boolean))];
        recognition.phrases = uniquePhrases.slice(0, 80).map((phrase) => new Phrase(phrase, 5));
      } catch { /* Context biasing is experimental; recognition still works without it. */ }
    }

    recognition.onresult = (event) => onUpdate?.(snapshotResults(event.results));
    recognition.onerror = (event) => {
      const code = event.error || 'unknown';
      // یک‌بار بدون تقویت دوباره امتحان می‌شود؛ کاربر نباید بفهمد چه شد، فقط
      // باید تشخیص کار کند.
      if (code === 'phrases-not-supported' && !retriedWithoutPhrases) {
        retriedWithoutPhrases = true;
        blockPhraseBiasing();
        swapping = true;
        active = build(false);
        try { active.start(); return; } catch { /* شروع دوباره نشد؛ خطا به کاربر می‌رسد */ }
        swapping = false;
      }
      onError?.(code);
    };
    // نشستِ کنارگذاشته‌شده هنگام جایگزینی `onend` می‌دهد؛ آن پایانِ کار کاربر
    // نیست و نباید نتیجه را زودتر از موعد ببندد.
    recognition.onend = () => {
      if (swapping) { swapping = false; return; }
      onEnd?.();
    };
    return recognition;
  };

  active = build(!retriedWithoutPhrases);
  // نشست ممکن است وسط کار با نشست بدون تقویت جایگزین شود، ولی صداکننده همان یک
  // شیء را نگه می‌دارد؛ پس دسترسی‌ها به نشست فعالِ همان لحظه هدایت می‌شوند.
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'start') return () => active.start();
      if (property === 'stop') return () => active.stop();
      if (property === 'abort') return () => active.abort?.();
      const value = Reflect.get(active, property);
      return typeof value === 'function' ? value.bind(active) : value;
    },
    set(_target, property, value) { return Reflect.set(active, property, value); },
    has(_target, property) { return Reflect.has(active, property); },
  });
}
