import test from 'node:test';
import assert from 'node:assert/strict';
import { describeVoiceAvailability, pointerReleaseAction, realtimeWorthTrying, retryLabel } from '../src/lib/voiceStatus.js';
import { voiceProviderStatus } from '../server/voiceProviderState.js';

test('publishes voice provider availability without exposing credentials', () => {
  const status = voiceProviderStatus({
    OPENAI_API_KEY: 'secret-openai',
    GEMINI_API_KEY: 'secret-gemini',
    VOICE_PROVIDER_ORDER: 'openai,gemini',
  }, 1_000);
  assert.equal(status.realtime.available, true);
  assert.deepEqual(status.file.providers.map((item) => item.provider), ['openai', 'gemini']);
  assert.doesNotMatch(JSON.stringify(status), /secret-/);
});

test('explains that Chrome remains live while realtime is cooling down', () => {
  const values = new Map([['hesab-yar-realtime-cooldown', JSON.stringify({ code: 'VOICE_QUOTA', until: 121_000 })]]);
  const storage = { getItem: (key) => values.get(key), removeItem: (key) => values.delete(key) };
  const labels = describeVoiceAvailability({ realtime: { available: true }, file: { available: true } }, { browserSupported: true, storage, now: 1_000 });
  assert.match(labels[0].label, /Chrome/);
  assert.match(labels[0].label, /2 دقیقه/);
  assert.equal(labels[1].tone, 'good');
});

test('supports both tap-to-toggle and hold-to-finish gestures', () => {
  assert.equal(pointerReleaseAction(120), 'keep-recording');
  assert.equal(pointerReleaseAction(420), 'stop');
  assert.equal(retryLabel(61), '2 دقیقه');
});

// نشتی هزینه: `realtimeSpeechAvailable` فقط مرورگر را می‌سنجید، پس حتی وقتی
// سرور می‌دانست Realtime تنظیم نشده، برای هر ضبط یک نشستِ پولی باز می‌شد.
test('نشست Realtime وقتی سرور می‌گوید در دسترس نیست، باز نمی‌شود', () => {
  assert.equal(realtimeWorthTrying({ realtime: { available: false } }, { browserReady: true }), false);
  assert.equal(realtimeWorthTrying({ realtime: { configured: false, available: false } }, { browserReady: true }), false);
});

test('وضعیت ناشناخته مانع تلاش نمی‌شود', () => {
  assert.equal(realtimeWorthTrying(null, { browserReady: true }), true);
  assert.equal(realtimeWorthTrying({}, { browserReady: true }), true);
});

test('مرورگر ناتوان یا در cooldown، هیچ نشستی باز نمی‌کند', () => {
  assert.equal(realtimeWorthTrying({ realtime: { available: true } }, { browserReady: false }), false);
});
