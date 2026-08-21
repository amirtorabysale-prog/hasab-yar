import { parseFinancialText } from './parser.js';
import { parseAudioWithGemini } from './gemini.js';
import { transcribeWithOpenAI } from './openai.js';

function shouldFallback(error) {
  return ['OPENAI_UNAVAILABLE', 'VOICE_TIMEOUT', 'VOICE_PROVIDER_ERROR', 'VOICE_QUOTA', 'VOICE_AUTH', 'VOICE_MODEL', 'VOICE_EMPTY_TRANSCRIPT'].includes(error?.code);
}

export async function parseFinancialAudio(context) {
  const providers = String(process.env.VOICE_PROVIDER_ORDER || 'openai,gemini').split(',').map((item) => item.trim()).filter(Boolean);
  const errors = [];
  for (const provider of providers) {
    if (provider === 'openai') {
      try {
        const transcription = await transcribeWithOpenAI(context);
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
        return { ...result, provider: 'gemini' };
      } catch (error) { errors.push(error); }
    }
  }
  const last = errors.at(-1) || Object.assign(new Error('هیچ سرویس صوتی فعالی پیدا نشد.'), { code: 'VOICE_UNAVAILABLE', status: 503 });
  if (errors.length > 1) last.fallbackErrors = errors.map((error) => error.code || 'UNKNOWN');
  throw last;
}
