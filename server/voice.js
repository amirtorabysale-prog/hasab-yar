import { parseFinancialText } from './parser.js';
import { parseAudioWithGemini } from './gemini.js';
import { transcribeWithOpenAI } from './openai.js';

function shouldFallback(error) {
  return ['OPENAI_UNAVAILABLE', 'VOICE_TIMEOUT', 'VOICE_PROVIDER_ERROR', 'VOICE_QUOTA', 'VOICE_RATE_LIMIT', 'VOICE_AUTH', 'VOICE_MODEL', 'VOICE_EMPTY_TRANSCRIPT'].includes(error?.code);
}

export async function parseFinancialAudio(context) {
  const providers = String(process.env.VOICE_PROVIDER_ORDER || 'openai,gemini').split(',').map((item) => item.trim()).filter(Boolean);
  const errors = [];
  // متنی که واقعاً از صدای کاربر پیاده شده، حتی وقتی مبلغی در آن پیدا نشود،
  // ارزشمندترین چیزی است که داریم. تا امروز دور ریخته می‌شد و کاربر مجبور بود
  // دوباره حرف بزند.
  let heardTranscript = '';
  for (const provider of providers) {
    if (provider === 'openai') {
      try {
        const transcription = await transcribeWithOpenAI(context);
        heardTranscript = heardTranscript || transcription.transcript;
        const parsed = parseFinancialText(transcription.transcript, { learnings: context.learnings, averages: context.averages, source: 'voice' });
        if (!parsed.transactions.length) {
          errors.push(Object.assign(new Error('از متن صدا مبلغ قابل اتکا استخراج نشد.'), { code: 'VOICE_NO_AMOUNT', status: 422 }));
          continue;
        }
        return {
          ...parsed, transcript: transcription.transcript, engine: 'openai-transcribe+deterministic-parser',
          provider: transcription.provider, model: transcription.model, responseMs: transcription.latencyMs,
        };
      } catch (error) {
        errors.push(error);
        if (!shouldFallback(error)) throw error;
      }
    }
    if (provider === 'gemini') {
      try {
        const result = await parseAudioWithGemini(context);
        heardTranscript = heardTranscript || result.transcript || '';
        return { ...result, provider: 'gemini' };
      } catch (error) { errors.push(error); }
    }
  }
  // صدا درست شنیده شد ولی مبلغی در آن نبود: متن را برگردان تا کاربر همان را
  // اصلاح کند، نه اینکه با یک خطا از صفر شروع کند.
  if (heardTranscript) {
    return {
      transcript: heardTranscript,
      transactions: [],
      engine: 'openai-transcribe+deterministic-parser',
      provider: 'openai',
      noAmount: true,
    };
  }
  const actionable = errors.find((error) => ['VOICE_QUOTA', 'VOICE_RATE_LIMIT', 'VOICE_AUTH'].includes(error?.code));
  const last = actionable || errors.at(-1) || Object.assign(new Error('هیچ سرویس صوتی فعالی پیدا نشد.'), { code: 'VOICE_UNAVAILABLE', status: 503 });
  if (errors.length > 1) last.fallbackErrors = errors.map((error) => error.code || 'UNKNOWN');
  throw last;
}
