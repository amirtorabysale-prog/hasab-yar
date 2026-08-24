import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeWithOpenAI } from '../server/openai.js';

test('sends Persian language and financial vocabulary to gpt-transcribe', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_TRANSCRIBE_MODEL;
  let request;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.OPENAI_TRANSCRIBE_MODEL = 'gpt-transcribe';
  global.fetch = async (url, options) => {
    request = { url, authorization: options.headers.Authorization, body: options.body };
    return new Response(JSON.stringify({ text: 'امروز دوازده میلیون تومان فروش داشتم', languages: ['fa'] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await transcribeWithOpenAI({
      buffer: Buffer.alloc(128), mimeType: 'audio/wav', categories: [{ name: 'فروش' }], learnings: [{ keyword: 'اسنپ‌فود' }], hint: 'دوازده میلیون فروش',
    });
    assert.equal(request.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(request.authorization, 'Bearer test-openai-key');
    assert.equal(request.body.get('model'), 'gpt-transcribe');
    assert.equal(request.body.get('languages[]'), 'fa');
    assert.ok(request.body.getAll('keywords[]').includes('تومان'));
    assert.ok(request.body.getAll('keywords[]').includes('اسنپ‌فود'));
    assert.match(request.body.get('prompt'), /دوازده میلیون فروش/);
    assert.match(request.body.get('prompt'), /خود صدا مرجع قطعی/);
    assert.equal(result.transcript, 'امروز دوازده میلیون تومان فروش داشتم');
    assert.equal(result.provider, 'openai');
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENAI_TRANSCRIBE_MODEL; else process.env.OPENAI_TRANSCRIBE_MODEL = originalModel;
  }
});

test('does not call OpenAI without a server key', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      transcribeWithOpenAI({ buffer: Buffer.alloc(128), mimeType: 'audio/wav' }),
      (error) => error.code === 'OPENAI_UNAVAILABLE' && error.status === 503,
    );
  } finally {
    if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
  }
});
