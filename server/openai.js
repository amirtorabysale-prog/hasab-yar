import { assertOpenAIAvailable, markOpenAIRateLimit } from './voiceProviderState.js';

const DEFAULT_MODEL = 'gpt-transcribe';
const SUPPORTED_AUDIO_TYPES = new Set(['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/webm']);

function providerFailure(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

function extensionFor(mimeType) {
  return ({
    'audio/wav': 'wav', 'audio/mp3': 'mp3', 'audio/mpeg': 'mp3', 'audio/aiff': 'aiff',
    'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/webm': 'webm',
  })[mimeType] || 'wav';
}

export async function transcribeWithOpenAI({ buffer, mimeType, categories = [], learnings = [], hint = '', timeoutMs = 7_000 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw providerFailure('کلید OpenAI روی سرور تنظیم نشده است.', 'OPENAI_UNAVAILABLE', 503);
  assertOpenAIAvailable('openai-file');
  const normalizedMime = String(mimeType || '').split(';')[0].toLowerCase();
  if (!SUPPORTED_AUDIO_TYPES.has(normalizedMime)) throw providerFailure('قالب صدا پشتیبانی نمی‌شود.', 'VOICE_AUDIO_FORMAT', 415);
  if (!buffer?.length || buffer.length < 64) throw providerFailure('فایل صوتی خالی است.', 'VOICE_EMPTY', 400);

  const model = process.env.OPENAI_TRANSCRIBE_MODEL || DEFAULT_MODEL;
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: normalizedMime }), `voice.${extensionFor(normalizedMime)}`);
  form.append('model', model);
  form.append('languages[]', 'fa');
  const vocabulary = [...categories.map((item) => item.name), ...learnings.map((item) => item.keyword), 'تومان', 'ریال', 'فروش', 'خرید', 'حقوق', 'اجاره']
    .map((item) => String(item).trim()).filter(Boolean).slice(0, 100);
  for (const keyword of vocabulary) form.append('keywords[]', keyword);
  const browserHint = String(hint || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const prompt = [
    'گفتار کوتاه فارسی درباره ثبت مالی را کلمه‌به‌کلمه پیاده کن. عددها، واحد تومان یا ریال، نام اشخاص و چند تراکنش در یک جمله را دقیق نگه دار؛ ترجمه یا خلاصه نکن.',
    browserHint ? `برداشت اولیهٔ مرورگر «${browserHint}» است؛ فقط سرنخ کم‌اعتماد است و در صورت اختلاف، خود صدا مرجع قطعی است.` : '',
  ].filter(Boolean).join(' ');
  form.append('prompt', prompt);

  let response;
  const startedAt = Date.now();
  try {
    response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw providerFailure('تشخیص صوت بیش از حد طول کشید.', 'VOICE_TIMEOUT', 504);
    throw providerFailure('ارتباط با سرویس اصلی صدا برقرار نشد.', 'VOICE_PROVIDER_ERROR', 502);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('OpenAI transcription failed', { status: response.status, code: body?.error?.code, type: body?.error?.type });
    if (response.status === 429) throw markOpenAIRateLimit('openai-file', response, body);
    if ([401, 403].includes(response.status)) throw providerFailure('کلید OpenAI معتبر نیست یا مجوز لازم را ندارد.', 'VOICE_AUTH', 503);
    if (response.status === 400 && /model/i.test(String(body?.error?.message || ''))) throw providerFailure('مدل تشخیص صوت تنظیم‌شده در دسترس نیست.', 'VOICE_MODEL', 503);
    throw providerFailure('سرویس اصلی صدا پاسخ قابل استفاده نداد.', 'VOICE_PROVIDER_ERROR', 502);
  }
  const transcript = String(body.text || '').trim();
  if (!transcript) throw providerFailure('متنی از صدا به دست نیامد.', 'VOICE_EMPTY_TRANSCRIPT', 422);
  return { transcript, provider: 'openai', model, latencyMs: Date.now() - startedAt, detectedLanguages: body.languages || [] };
}
