import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_OFFLINE_AUDIO_ATTEMPTS, OFFLINE_STATES,
  belongsToOfflineScope, isPermanentQueueError, nextOfflineAudioState, normalizeOfflineScope, normalizeOfflineState,
  offlineScopeKey, requireOfflineScope,
} from '../src/lib/offlineScope.js';

test('offline scope requires both the authenticated user and active workspace', () => {
  assert.deepEqual(normalizeOfflineScope({ userId: ' user-1 ', workspaceId: ' office-1 ' }), {
    userId: 'user-1', workspaceId: 'office-1',
  });
  assert.equal(normalizeOfflineScope({ userId: 'user-1' }), null);
  assert.throws(() => requireOfflineScope({ workspaceId: 'office-1' }), (error) => error.code === 'OFFLINE_SCOPE_REQUIRED');
});

test('offline records never cross a user or workspace boundary', () => {
  const record = { userId: 'user-1', workspaceId: 'office-1' };
  assert.equal(belongsToOfflineScope(record, record), true);
  assert.equal(belongsToOfflineScope(record, { userId: 'user-2', workspaceId: 'office-1' }), false);
  assert.equal(belongsToOfflineScope(record, { userId: 'user-1', workspaceId: 'office-2' }), false);
  assert.notEqual(
    offlineScopeKey({ userId: 'user-1', workspaceId: 'office-1' }),
    offlineScopeKey({ userId: 'user-2', workspaceId: 'office-1' }),
  );
});

test('unknown audio states recover as queued without weakening scope checks', () => {
  assert.equal(normalizeOfflineState('review'), 'review');
  assert.equal(normalizeOfflineState('unexpected'), 'queued');
});

test('permanent client errors are separated from retryable failures', () => {
  assert.equal(isPermanentQueueError({ status: 409 }), true);
  assert.equal(isPermanentQueueError({ status: 403 }), true);
  assert.equal(isPermanentQueueError({ status: 429 }), false);
  assert.equal(isPermanentQueueError({ status: 500 }), false);
  assert.equal(isPermanentQueueError({}), false);
});

// صف صدا برخلاف صف تراکنش‌ها هیچ سقف تلاشی نداشت: هر ضبطی که پردازش نمی‌شد
// دوباره در حالت queued می‌نشست. چون حلقهٔ همگام‌سازی بعد از هر قلم متوقف
// می‌شد، همان یک ضبط خراب همهٔ ضبط‌های بعدی را هم بلوکه می‌کرد و هر بار
// سهمیهٔ سرویس را می‌سوزاند.
test('talash-e sedaye offline shomorde mishavad', () => {
  const first = nextOfflineAudioState({ attempts: 0 });
  assert.deepEqual(first, { state: 'queued', attempts: 1, exhausted: false });

  const second = nextOfflineAudioState({ attempts: 1 });
  assert.equal(second.state, 'queued');
  assert.equal(second.exhausted, false);

  // با رسیدن به سقف، قلم از صف بیرون می‌رود تا بقیه پشتش نمانند.
  const third = nextOfflineAudioState({ attempts: 2 });
  assert.equal(third.attempts, MAX_OFFLINE_AUDIO_ATTEMPTS);
  assert.equal(third.state, 'failed');
  assert.equal(third.exhausted, true);
});

test('khataye daemi bedun-e talash-e dobare kenar mirawad', () => {
  const outcome = nextOfflineAudioState({ attempts: 0 }, { permanent: true });
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.exhausted, true);
  assert.equal(outcome.attempts, 1, 'تلاش انجام‌شده باید شمرده شود');
});

test('halat-e failed digar dar saf-e montazer nist', () => {
  // pendingAudio فقط queued و review را برمی‌دارد؛ این آزمون همان قرارداد را قفل می‌کند.
  assert.ok(OFFLINE_STATES.includes('failed'));
  assert.equal(normalizeOfflineState('failed'), 'failed');
  assert.equal(normalizeOfflineState('چیز دیگر'), 'queued');
});
