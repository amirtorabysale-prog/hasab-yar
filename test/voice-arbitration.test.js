import test from 'node:test';
import assert from 'node:assert/strict';
import { selectVoiceSnapshot } from '../src/lib/voiceArbitration.js';

test('lets realtime take over only while it remains healthy', () => {
  const browser = { source: 'browser-live', transcript: 'دوازده میلیون فروش' };
  const realtime = { source: 'openai-realtime', transcript: 'دوازده میلیون تومان فروش' };
  assert.equal(selectVoiceSnapshot({ browser, realtime }).source, 'openai-realtime');
  assert.equal(selectVoiceSnapshot({ browser, realtime, realtimeFailed: true }).source, 'browser-live');
});

test('keeps Chrome text when realtime fails after a partial delta', () => {
  const selected = selectVoiceSnapshot({
    browser: { source: 'browser-live', transcript: 'هفتصد هزار هزینه پیک' },
    realtime: { source: 'openai-realtime', transcript: 'هفتصد', error: { code: 'VOICE_QUOTA' } },
    realtimeFailed: true,
  });
  assert.equal(selected.transcript, 'هفتصد هزار هزینه پیک');
});
