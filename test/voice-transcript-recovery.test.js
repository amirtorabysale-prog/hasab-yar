import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFinancialAudio } from '../server/voice.js';
import { transcriptionTimeoutFor } from '../server/openai.js';

function withOpenAI(responseBody, callback, { status = 200 } = {}) {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalOrder = process.env.VOICE_PROVIDER_ORDER;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  // فقط OpenAI؛ می‌خواهیم رفتار خودِ زنجیره را بسنجیم نه Gemini را.
  process.env.VOICE_PROVIDER_ORDER = 'openai';
  delete process.env.GEMINI_API_KEY;
  global.fetch = async () => new Response(JSON.stringify(responseBody), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  return (async () => {
    try { return await callback(); }
    finally {
      global.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
      if (originalOrder === undefined) delete process.env.VOICE_PROVIDER_ORDER; else process.env.VOICE_PROVIDER_ORDER = originalOrder;
      if (originalGeminiKey !== undefined) process.env.GEMINI_API_KEY = originalGeminiKey;
    }
  })();
}

const audio = { buffer: Buffer.alloc(256), mimeType: 'audio/wav' };

test('صدای درست‌شنیده‌شده حتی بدون مبلغ، دور ریخته نمی‌شود', async () => {
  // کاربر حرف زد، درست هم پیاده شد، ولی مبلغی در جمله نبود. تا پیش از این
  // خطای VOICE_NO_AMOUNT پرتاب می‌شد و متن گم می‌شد؛ کاربر باید از صفر
  // دوباره حرف می‌زد.
  const spoken = 'یادم باشه فردا با حسابدار تماس بگیرم';
  const result = await withOpenAI({ text: spoken }, () => parseFinancialAudio(audio));
  assert.equal(result.transcript, spoken);
  assert.deepEqual(result.transactions, []);
  assert.equal(result.noAmount, true);
});

test('وقتی مبلغ هست، مسیر عادی دست‌نخورده می‌ماند', async () => {
  const result = await withOpenAI({ text: 'امروز دوازده میلیون تومان فروش داشتم' }, () => parseFinancialAudio(audio));
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, 12_000_000);
  assert.equal(result.transactions[0].type, 'income');
  assert.ok(!result.noAmount);
});

test('گویش محاوره‌ای از مسیر کامل سرور هم درست خوانده می‌شود', async () => {
  const result = await withOpenAI({ text: 'هفصد هزار تومن پیک دادم' }, () => parseFinancialAudio(audio));
  assert.equal(result.transactions[0].amount, 700_000);
  assert.equal(result.transactions[0].type, 'expense');
});

test('وقتی هیچ متنی شنیده نشد، خطا همچنان پرتاب می‌شود', async () => {
  await assert.rejects(
    () => withOpenAI({ text: '' }, () => parseFinancialAudio(audio)),
    (error) => error.code === 'VOICE_EMPTY_TRANSCRIPT',
  );
});

test('مهلت تشخیص با طول صدا رشد می‌کند و سقف دارد', () => {
  // جملهٔ کوتاه نباید مهلت را بی‌دلیل بالا ببرد و جملهٔ بلند نباید جریمه شود.
  assert.equal(transcriptionTimeoutFor(0), 7_000);
  assert.equal(transcriptionTimeoutFor(500), 7_000);
  assert.equal(transcriptionTimeoutFor(4_000), 10_000);
  assert.equal(transcriptionTimeoutFor(20_000), 15_000);
  assert.equal(transcriptionTimeoutFor(600_000), 15_000);
});
