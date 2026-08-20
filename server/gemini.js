import { parseFinancialText } from './parser.js';

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

export async function parseAudioWithGemini({ buffer, mimeType, categories, learnings, averages }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('پردازش صوت روی سرور فعال نشده است.'), { code: 'VOICE_UNAVAILABLE', status: 503 });
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const prompt = `این صدای فارسی متعلق به ثبت مالی یک کسب‌وکار ایرانی است. متن را دقیق پیاده کن و هر درآمد یا هزینه را جداگانه استخراج کن. مبلغ خروجی باید عدد صحیح بر حسب تومان باشد؛ اگر گوینده ریال گفت بر ده تقسیم کن. هرگز رقم ناموجود را حدس نزن. اگر رقم مبهم است confidence را کم و حداکثر دو alternative واقعی ثبت کن. دسته‌ها فقط یکی از این موارد باشد: ${categories.map((x) => x.name).join('، ')}. نگاشت‌های آموخته‌شده: ${learnings.map((x) => `${x.keyword}=${x.category}`).join('، ') || 'ندارد'}. میانگین‌های فعلی برای تشخیص ناهنجاری: ${JSON.stringify(averages)}.`;
  let response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: buffer.toString('base64') } }, { text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema } }),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw Object.assign(new Error('پردازش صدا بیش از حد طول کشید؛ دوباره تلاش کن.'), { status: 504, code: 'VOICE_TIMEOUT' });
    throw Object.assign(new Error('ارتباط با سرویس پردازش صدا برقرار نشد.'), { status: 502, code: 'VOICE_PROVIDER_ERROR' });
  }
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error('سرویس پشتیبان صدا در دسترس نیست؛ دوباره بگو یا دستی بنویس.'), { status: 502, code: 'VOICE_PROVIDER_ERROR' });
  const output = body.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  let parsed;
  try { parsed = JSON.parse(output); } catch { throw Object.assign(new Error('پاسخ صوت قابل خواندن نبود؛ دوباره تلاش کن.'), { status: 502, code: 'VOICE_PARSE_ERROR' }); }
  const aiTransactions = (parsed.transactions || []).filter((item) => Number.isFinite(item.amount) && item.amount > 0);
  const deterministic = parseFinancialText(parsed.transcript, { learnings, averages, source: 'voice' });
  if (deterministic.transactions.length) {
    parsed.transactions = deterministic.transactions.map((item, index) => {
      const aiAmount = Number(aiTransactions[index]?.amount || 0);
      if (!aiAmount || aiAmount === item.amount) return item;
      return {
        ...item,
        alternatives: [Math.round(aiAmount)],
        needsReview: true,
        warning: item.warning || 'متن و تحلیل پشتیبان دو مبلغ متفاوت ساختند؛ مبلغ را با دقت بررسی کن.',
      };
    });
    return { ...parsed, engine: 'gemini-fallback' };
  }
  parsed.transactions = aiTransactions.map((item) => {
    const average = averages[item.type] || 0;
    const unusual = average > 0 && item.amount >= average * 5;
    return { ...item, amount: Math.round(item.amount), rawText: parsed.transcript, source: 'voice', needsReview: unusual || item.confidence < 0.78, warning: unusual ? 'این مبلغ بیشتر از پنج برابر میانگین ثبت‌های مشابه توست. مطمئنی؟' : item.confidence < 0.78 ? 'عدد یا نوع تراکنش با اطمینان کم شنیده شد؛ لطفاً بررسی کن.' : null };
  });
  return { ...parsed, engine: 'gemini-fallback' };
}
