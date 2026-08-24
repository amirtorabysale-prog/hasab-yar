import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRealtimeTranscriptionSession, createRealtimeTranscriptionCall } from '../server/openaiRealtime.js';
import { resetVoiceProviderState } from '../server/voiceProviderState.js';

test('builds a Persian low-latency financial transcription session', () => {
  const session = buildRealtimeTranscriptionSession({
    categories: [{ name: 'فروش حضوری' }],
    learnings: [{ keyword: 'اسنپ‌فود' }],
  });
  assert.equal(session.type, 'transcription');
  assert.equal(session.audio.input.transcription.model, 'gpt-live-transcribe');
  assert.deepEqual(session.audio.input.transcription.languages, ['fa']);
  assert.equal(session.audio.input.transcription.delay, 'low');
  assert.ok(session.audio.input.transcription.keywords.includes('تومان'));
  assert.ok(session.audio.input.transcription.keywords.includes('اسنپ‌فود'));
  assert.equal(session.audio.input.turn_detection, null);
});

test('exchanges browser SDP through the authenticated realtime calls endpoint', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let request;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response('v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n', { status: 200, headers: { 'Content-Type': 'application/sdp' } });
  };
  try {
    const answer = await createRealtimeTranscriptionCall({
      sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n',
      categories: [{ name: 'فروش' }],
      userId: 'owner-123',
    });
    assert.match(answer, /^v=0/);
    assert.equal(request.url, 'https://api.openai.com/v1/realtime/calls');
    assert.equal(request.options.headers.Authorization, 'Bearer test-openai-key');
    assert.equal(request.options.headers['OpenAI-Safety-Identifier'].length, 64);
    assert.doesNotMatch(request.options.headers['OpenAI-Safety-Identifier'], /owner-123/);
    assert.match(request.options.body.get('sdp'), /^v=0/);
    const session = JSON.parse(request.options.body.get('session'));
    assert.equal(session.audio.input.transcription.model, 'gpt-live-transcribe');
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('stops repeated OpenAI calls after billing quota is exhausted', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let calls = 0;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  resetVoiceProviderState();
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: 'insufficient_quota', type: 'insufficient_quota' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const input = { sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n', userId: 'owner-123' };
  try {
    await assert.rejects(createRealtimeTranscriptionCall(input), (error) => (
      error.code === 'VOICE_QUOTA' && error.requiresAction === true && error.retryAfterSeconds >= 1_700
    ));
    await assert.rejects(createRealtimeTranscriptionCall(input), (error) => error.code === 'VOICE_QUOTA');
    assert.equal(calls, 1);
  } finally {
    resetVoiceProviderState();
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('honors Retry-After for a temporary realtime rate limit', async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  resetVoiceProviderState();
  global.fetch = async () => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '12' },
  });
  try {
    await assert.rejects(
      createRealtimeTranscriptionCall({ sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' }),
      (error) => error.code === 'VOICE_RATE_LIMIT' && error.retryAfterSeconds === 12 && !error.requiresAction,
    );
  } finally {
    resetVoiceProviderState();
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});
