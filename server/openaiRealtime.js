import { createHash } from 'node:crypto';

const DEFAULT_MODEL = 'gpt-live-transcribe';

function providerFailure(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

function cleanVocabulary(categories = [], learnings = []) {
  return [...categories.map((item) => item.name), ...learnings.map((item) => item.keyword),
    'تومان', 'ریال', 'فروش', 'خرید', 'هزینه', 'درآمد', 'حقوق', 'اجاره']
    .map((item) => String(item || '').replace(/[<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((item, index, values) => values.indexOf(item) === index)
    .slice(0, 100);
}

export function buildRealtimeTranscriptionSession({ categories = [], learnings = [] } = {}) {
  return {
    type: 'transcription',
    audio: {
      input: {
        transcription: {
          model: process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || DEFAULT_MODEL,
          prompt: 'گفتار کوتاه فارسی برای ثبت مالی است. عدد، واحد تومان یا ریال، نام شخص و چند تراکنش را کلمه‌به‌کلمه و بدون ترجمه پیاده کن.',
          keywords: cleanVocabulary(categories, learnings),
          languages: ['fa'],
          delay: process.env.OPENAI_REALTIME_TRANSCRIBE_DELAY || 'low',
        },
        turn_detection: null,
      },
    },
  };
}

export async function createRealtimeTranscriptionCall({ sdp, categories = [], learnings = [], userId = '', timeoutMs = 7_000 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw providerFailure('کلید OpenAI روی سرور تنظیم نشده است.', 'OPENAI_UNAVAILABLE', 503);
  const offer = String(sdp || '').trim();
  if (!offer.startsWith('v=0') || offer.length > 128_000) throw providerFailure('پیشنهاد اتصال صوتی معتبر نیست.', 'VOICE_REALTIME_SDP', 400);

  const form = new FormData();
  form.set('sdp', offer);
  form.set('session', JSON.stringify(buildRealtimeTranscriptionSession({ categories, learnings })));
  const safetyIdentifier = createHash('sha256').update(`hasab-yar:${userId || 'anonymous'}`).digest('hex');

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'OpenAI-Safety-Identifier': safetyIdentifier },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw providerFailure('اتصال تایپ زنده بیش از حد طول کشید.', 'VOICE_REALTIME_TIMEOUT', 504);
    throw providerFailure('اتصال تایپ زنده برقرار نشد.', 'VOICE_REALTIME_PROVIDER', 502);
  }

  const answer = await response.text();
  if (!response.ok) {
    let body = {};
    try { body = JSON.parse(answer); } catch { /* OpenAI can return a plain-text gateway error. */ }
    console.error('OpenAI realtime transcription failed', { status: response.status, code: body?.error?.code, type: body?.error?.type });
    if (response.status === 429) throw providerFailure('سهمیهٔ تایپ زنده موقتاً تمام شده است.', 'VOICE_QUOTA', 503);
    if ([401, 403].includes(response.status)) throw providerFailure('کلید OpenAI معتبر نیست یا مجوز Realtime ندارد.', 'VOICE_AUTH', 503);
    if (response.status === 400) throw providerFailure('تنظیمات تایپ زنده معتبر نیست.', 'VOICE_REALTIME_CONFIG', 503);
    throw providerFailure('سرویس تایپ زنده پاسخ قابل استفاده نداد.', 'VOICE_REALTIME_PROVIDER', 502);
  }
  if (!answer.trim().startsWith('v=0')) throw providerFailure('پاسخ اتصال تایپ زنده معتبر نبود.', 'VOICE_REALTIME_SDP', 502);
  return answer;
}
