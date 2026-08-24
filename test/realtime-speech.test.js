import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeTranscriber } from '../src/lib/realtimeSpeech.js';

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
  addTrack(track) { this.track = track; }
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
