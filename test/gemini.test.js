import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAudioWithGemini, pickGeminiAudioModel } from '../server/gemini.js';

const model = (name, supported = true) => ({ name: `models/${name}`, baseModelId: name, supportedGenerationMethods: supported ? ['generateContent'] : ['embedContent'] });

test('selects the requested supported Flash audio model', () => {
  const models = [model('gemini-3.6-flash'), model('gemini-3.7-flash')];
  assert.equal(pickGeminiAudioModel(models, 'gemini-3.6-flash'), 'gemini-3.6-flash');
});

test('falls forward when a configured Gemini model is unavailable', () => {
  const models = [model('gemini-3.5-flash'), model('gemini-3.7-flash'), model('text-embedding-004')];
  assert.equal(pickGeminiAudioModel(models, 'gemini-2.5-flash'), 'gemini-3.7-flash');
});

test('excludes failed and non-generate models during recovery', () => {
  const models = [model('gemini-3.7-flash'), model('gemini-3.6-flash'), model('gemini-3.5-flash', false)];
  assert.equal(pickGeminiAudioModel(models, 'gemini-3.7-flash', ['gemini-3.7-flash']), 'gemini-3.6-flash');
});

test('sends supported Persian WAV with low thinking and financial vocabulary', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const originalModel = process.env.GEMINI_MODEL;
  let request;
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_MODEL = 'gemini-3.7-flash';
  global.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: 'دوازده میلیون فروش داشتم', transactions: [{ amount: 12_000_000, type: 'income', category: 'فروش', confidence: 0.98 }] }) }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await parseAudioWithGemini({
      buffer: Buffer.alloc(128), mimeType: 'audio/wav', categories: [{ name: 'فروش' }], learnings: [], averages: {},
    });
    assert.match(request.url, /gemini-3\.7-flash/);
    assert.equal(request.body.contents[0].parts[0].inlineData.mimeType, 'audio/wav');
    assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
    assert.deepEqual(request.body.generationConfig.audioTranscriptionConfig.languageCodes, ['fa-IR']);
    assert.ok(request.body.generationConfig.audioTranscriptionConfig.customVocabulary.includes('تومان'));
    assert.equal(result.transactions[0].amount, 12_000_000);
    assert.equal(result.engine, 'gemini-audio-wav');
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = originalModel;
  }
});

test('rejects browser WebM before sending it to Gemini', async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    await assert.rejects(
      parseAudioWithGemini({ buffer: Buffer.alloc(128), mimeType: 'audio/webm', categories: [], learnings: [], averages: {} }),
      (error) => error.code === 'VOICE_AUDIO_FORMAT' && error.status === 415,
    );
  } finally {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
  }
});
