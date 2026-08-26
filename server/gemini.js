import { parseFinancialText } from './parser.js';
import { withReviewAssessment } from '../shared/review.js';

const DEFAULT_MODEL = 'gemini-3.7-flash';
const SUPPORTED_AUDIO_TYPES = new Set(['audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac']);
let discoveredModel = null;

const schema = {
  type: 'OBJECT',
  required: ['transcript', 'transactions'],
  properties: {
    transcript: { type: 'STRING' },
    transactions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT', required: ['amount', 'type', 'category', 'confidence'],
        properties: {
          amount: { type: 'INTEGER' }, type: { type: 'STRING', enum: ['income', 'expense'] },
          category: { type: 'STRING' }, confidence: { type: 'NUMBER' }, alternatives: { type: 'ARRAY', items: { type: 'INTEGER' } },
        },
      },
    },
  },
};

function modelId(value) {
  return String(value || '').replace(/^models\//, '').trim();
}

export function pickGeminiAudioModel(models, requested, excluded = []) {
  const blocked = new Set(excluded.map(modelId));
  const available = (models || [])
    .filter((item) => item?.supportedGenerationMethods?.includes('generateContent'))
    .map((item) => modelId(item.baseModelId || item.name))
    .filter((name) => name.includes('gemini') && name.includes('flash') && !/(image|tts|live|embedding)/i.test(name) && !blocked.has(name));
  const preferences = [requested, DEFAULT_MODEL, 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-flash-latest'].map(modelId);
  return preferences.find((name) => available.includes(name)) || available[0] || null;
}

function providerFailure(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

async function listModels(apiKey) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`, {
    signal: AbortSignal.timeout(3_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return [];
  return body.models || [];
}

async function generate({ apiKey, model, buffer, mimeType, prompt, vocabulary }) {
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: buffer.toString('base64') } }, { text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2_048,
          responseMimeType: 'application/json',
          responseSchema: schema,
          thinkingConfig: { thinkingLevel: 'LOW' },
          audioTranscriptionConfig: { languageCodes: ['fa-IR'], customVocabulary: vocabulary.slice(0, 100) },
        },
      }),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw providerFailure('پردازش صدا بیش از حد طول کشید؛ دوباره کوتاه‌تر بگو.', 'VOICE_TIMEOUT', 504);
    throw providerFailure('ارتباط با سرویس پردازش صدا برقرار نشد.', 'VOICE_PROVIDER_ERROR', 502);
  }
  const body = await response.json().catch(() => ({}));
  return { response, body, model };
}

function providerMessage(body) {
  return String(body?.error?.message || '');
}

function modelUnavailable(result) {
  const message = providerMessage(result.body);
  return [400, 404].includes(result.response.status) && /(model|مدل).*(not found|not available|no longer|unsupported)|not found.*model/i.test(message);
}

function throwProviderError(result) {
  const message = providerMessage(result.body);
  console.error('Gemini voice request failed', { status: result.response.status, model: result.model, providerCode: result.body?.error?.status });
  if (result.response.status === 429) throw providerFailure('سهمیهٔ سرویس صدا موقتاً تمام شده است؛ کمی بعد دوباره امتحان کن.', 'VOICE_QUOTA', 503);
  if ([400, 401, 403].includes(result.response.status) && /(api key|permission|credential)/i.test(message)) {
    throw providerFailure('کلید سرویس صدا معتبر نیست یا دسترسی لازم را ندارد؛ GEMINI_API_KEY در Railway باید اصلاح شود.', 'VOICE_AUTH', 503);
  }
  if (modelUnavailable(result)) throw providerFailure('مدل صوتی تنظیم‌شده در دسترس نیست؛ نام GEMINI_MODEL را بررسی کن.', 'VOICE_MODEL', 503);
  throw providerFailure('سرویس پشتیبان صدا پاسخ قابل استفاده نداد؛ دوباره بگو یا دستی بنویس.', 'VOICE_PROVIDER_ERROR', 502);
}

export async function parseAudioWithGemini({ buffer, mimeType, categories, learnings, averages, hint = '' }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw providerFailure('پردازش صوت روی سرور فعال نشده است.', 'VOICE_UNAVAILABLE', 503);
  const normalizedMime = String(mimeType || '').split(';')[0].toLowerCase();
  if (!SUPPORTED_AUDIO_TYPES.has(normalizedMime)) {
    throw providerFailure('قالب صدای این نسخه پشتیبانی نمی‌شود؛ صفحه را تازه‌سازی کن و دوباره بگو.', 'VOICE_AUDIO_FORMAT', 415);
  }
  if (!buffer?.length || buffer.length < 64) throw providerFailure('فایل صوتی خالی است؛ دوباره بگو.', 'VOICE_EMPTY', 400);

  const categoryNames = categories.map((item) => item.name);
  const vocabulary = [...categoryNames, ...learnings.map((item) => item.keyword), 'تومان', 'ریال', 'فروش', 'خرید', 'هزینه', 'درآمد', 'حقوق'];
  const browserHint = String(hint || '').trim().slice(0, 500);
  const prompt = `صدای کوتاه فارسی را کلمه‌به‌کلمه و بدون ترجمه پیاده کن، سپس هر ثبت مالی را جدا استخراج کن.
- مرجع اصلی فقط خود صداست؛ هیچ رقم یا کلمه‌ای را حدس نزن.
- مبلغ خروجی عدد صحیح و بر حسب تومان است. اگر گوینده ریال گفت، مبلغ را بر ۱۰ تقسیم کن.
- عبارت‌های محاوره‌ای مانند «پونصد»، «یه تومن»، «دو و نیم میلیون» و چند تراکنش در یک جمله را دقیق در نظر بگیر.
- نوع فقط income یا expense و دسته فقط یکی از این‌ها باشد: ${categoryNames.join('، ')}.
- اگر رقم واقعاً مبهم است confidence را کم و حداکثر دو alternative واقعی بده.
${browserHint ? `برداشت ناقص مرورگر فقط برای سرنخ است و ممکن است غلط باشد: «${browserHint}».` : ''}
نگاشت‌های آموخته‌شده: ${learnings.map((item) => `${item.keyword}=${item.category}`).join('، ') || 'ندارد'}.
میانگین‌ها فقط برای هشدار ناهنجاری و نه حدس مبلغ: ${JSON.stringify(averages)}.`;

  let model = discoveredModel || modelId(process.env.GEMINI_MODEL) || DEFAULT_MODEL;
  let result = await generate({ apiKey, model, buffer, mimeType: normalizedMime, prompt, vocabulary });
  if (!result.response.ok && modelUnavailable(result)) {
    const models = await listModels(apiKey).catch(() => []);
    const fallback = pickGeminiAudioModel(models, DEFAULT_MODEL, [model]);
    if (fallback) {
      discoveredModel = fallback;
      model = fallback;
      result = await generate({ apiKey, model, buffer, mimeType: normalizedMime, prompt, vocabulary });
    }
  }
  if (!result.response.ok) throwProviderError(result);

  const output = result.body.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  let parsed;
  try { parsed = JSON.parse(output); }
  catch { throw providerFailure('پاسخ صوت قابل خواندن نبود؛ دوباره تلاش کن.', 'VOICE_PARSE_ERROR', 502); }
  const aiTransactions = (parsed.transactions || []).filter((item) => Number.isFinite(item.amount) && item.amount > 0);
  const deterministic = parseFinancialText(parsed.transcript, { learnings, averages, source: 'voice' });
  if (deterministic.transactions.length) {
    parsed.transactions = deterministic.transactions.map((item, index) => {
      const aiAmount = Number(aiTransactions[index]?.amount || 0);
      if (!aiAmount || aiAmount === item.amount) return item;
      return withReviewAssessment({
        ...item,
        alternatives: [Math.round(aiAmount)],
        needsReview: true,
        confidence: undefined,
        confidenceDetails: { ...item.confidenceDetails, amount: { score: 0.52, reason: 'تحلیل متن و تحلیل مستقیم صدا دو مبلغ متفاوت پیشنهاد کردند.' } },
        reviewReasons: [...(item.reviewReasons || []), 'متن و تحلیل صوت دربارهٔ مبلغ اختلاف دارند.'],
        warning: item.warning || 'متن و تحلیل پشتیبان دو مبلغ متفاوت ساختند؛ مبلغ را با دقت بررسی کن.',
      });
    });
    return { ...parsed, engine: 'gemini-audio-wav', model };
  }
  parsed.transactions = aiTransactions.map((item) => {
    const average = averages[item.type] || 0;
    const unusual = average > 0 && item.amount >= average * 5;
    return withReviewAssessment({
      ...item, amount: Math.round(item.amount), rawText: parsed.transcript, source: 'voice', needsReview: unusual || item.confidence < 0.78,
      confidenceDetails: {
        amount: { score: item.confidence || 0.7, reason: 'مبلغ مستقیماً از تحلیل فایل صوتی استخراج شد.' },
        type: { score: item.confidence || 0.7, reason: 'نوع مستقیماً از تحلیل فایل صوتی پیشنهاد شد.' },
        category: { score: item.confidence || 0.7, reason: 'دسته مستقیماً از تحلیل فایل صوتی پیشنهاد شد.' },
        account: { score: 0.82, reason: 'حساب پیش‌فرض دفتر انتخاب می‌شود؛ قبل از ثبت قابل تغییر است.' },
      },
      reviewReasons: unusual ? ['مبلغ نسبت به میانگین ثبت‌های مشابه غیرعادی است.'] : item.confidence < 0.78 ? ['تحلیل مستقیم صوت اطمینان کافی ندارد.'] : [],
      warning: unusual ? 'این مبلغ بیشتر از پنج برابر میانگین ثبت‌های مشابه توست. مطمئنی؟' : item.confidence < 0.78 ? 'عدد یا نوع تراکنش با اطمینان کم شنیده شد؛ لطفاً بررسی کن.' : null,
    });
  });
  return { ...parsed, engine: 'gemini-audio-wav', model };
}
