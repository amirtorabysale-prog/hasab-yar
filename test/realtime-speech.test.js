import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeTranscriber, realtimeCooldown, realtimeSpeechAvailable, rememberRealtimeFailure } from '../src/lib/realtimeSpeech.js';

class FakeChannel extends EventTarget {
  constructor() { super(); this.readyState = 'open'; this.sent = []; }
  send(value) {
    this.sent.push(JSON.parse(value));
    if (this.sent.at(-1).type !== 'input_audio_buffer.commit') return;
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      type: 'conversation.item.input_audio_transcription.delta', delta: 'دوازده میلیون ',
    }) }));
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed', transcript: 'دوازده میلیون تومان فروش',
    }) }));
  }
  close() { this.readyState = 'closed'; }
}

class FakePeer extends EventTarget {
  constructor() { super(); this.iceGatheringState = 'complete'; this.channel = new FakeChannel(); }
  createDataChannel() { return this.channel; }
  addTrack(track) { this.track = track; this.direction = 'sendrecv'; }
  addTransceiver(track, init) { this.track = track; this.direction = init?.direction; }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=browser\r\n' }; }
  async setLocalDescription(offer) { this.localDescription = offer; }
  async setRemoteDescription(answer) { this.remoteDescription = answer; }
  close() { this.closed = true; }
}

test('commits WebRTC microphone audio and returns the final Persian transcript', async () => {
  const originalWindow = global.window;
  global.window = { RTCPeerConnection: FakePeer, setTimeout, clearTimeout };
  const updates = [];
  try {
    const transcriber = createRealtimeTranscriber({
      stream: { getAudioTracks: () => [{ id: 'microphone' }] },
      createSession: async (sdp) => {
        assert.match(sdp, /^v=0/);
        return 'v=0\r\no=openai\r\n';
      },
      onUpdate: (snapshot) => updates.push(snapshot),
    });
    await transcriber.ready;
    const result = await transcriber.finish();
    assert.deepEqual(result, { transcript: 'دوازده میلیون تومان فروش', completed: true });
    assert.equal(updates.at(-1).completed, true);
    assert.equal(updates.at(-1).transcript, 'دوازده میلیون تومان فروش');
  } finally { global.window = originalWindow; }
});

test('temporarily disables realtime in the browser after quota failure', () => {
  const originalWindow = global.window;
  const originalNavigator = global.navigator;
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  global.window = { RTCPeerConnection: FakePeer };
  Object.defineProperty(global, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia() {} } } });
  try {
    assert.equal(realtimeSpeechAvailable(storage, 1_000), true);
    const remembered = rememberRealtimeFailure({ code: 'VOICE_QUOTA', retryAfterSeconds: 120 }, storage, 1_000);
    assert.equal(remembered.until, 121_000);
    assert.equal(realtimeCooldown(storage, 1_001).code, 'VOICE_QUOTA');
    assert.equal(realtimeSpeechAvailable(storage, 120_999), false);
    assert.equal(realtimeSpeechAvailable(storage, 121_000), true);
  } finally {
    global.window = originalWindow;
    Object.defineProperty(global, 'navigator', { configurable: true, value: originalNavigator });
  }
});

// WHIP یک پروتکل ingestion است. `addTrack` تراسیور را sendrecv می‌سازد و برای
// نشست transcription که هیچ صدایی برنمی‌گرداند، مسیر دریافتِ بی‌مصرف اعلام
// می‌کند — یکی از دو شرطی که offer را نامعتبر می‌کرد.
test('offer فقط ارسالی است، چون نشست transcription صدایی برنمی‌گرداند', async () => {
  const originalWindow = global.window;
  global.window = { RTCPeerConnection: FakePeer, setTimeout, clearTimeout };
  try {
    const track = { kind: 'audio' };
    const stream = { getAudioTracks: () => [track] };
    let peer;
    class Capturing extends FakePeer { constructor() { super(); peer = this; } }
    global.window.RTCPeerConnection = Capturing;
    const transcriber = createRealtimeTranscriber({
      stream, createSession: async () => 'v=0\r\no=openai\r\n', onUpdate: () => {}, onError: () => {},
    });
    await transcriber.ready;
    assert.equal(peer.direction, 'sendonly');
    assert.equal(peer.track, track);
    transcriber.abort();
  } finally { global.window = originalWindow; }
});
