import { normalizePersian } from '../../shared/parser.js';

const OPEN_TIMEOUT_MS = 6_000;
const FINAL_TIMEOUT_MS = 1_500;
const REALTIME_COOLDOWN_KEY = 'hesab-yar-realtime-cooldown';

function availableStorage(storage) {
  if (storage) return storage;
  try { return typeof window !== 'undefined' ? window.localStorage : null; }
  catch { return null; }
}

export function realtimeCooldown(storage, now = Date.now()) {
  const target = availableStorage(storage);
  if (!target) return null;
  try {
    const value = JSON.parse(target.getItem(REALTIME_COOLDOWN_KEY) || 'null');
    if (!value?.until || value.until <= now) {
      target.removeItem(REALTIME_COOLDOWN_KEY);
      return null;
    }
    return value;
  } catch { return null; }
}

export function rememberRealtimeFailure(error, storage, now = Date.now()) {
  const durations = {
    VOICE_QUOTA: 30 * 60,
    VOICE_RATE_LIMIT: 60,
    VOICE_AUTH: 10 * 60,
    VOICE_REALTIME_CONFIG: 10 * 60,
  };
  const fallbackSeconds = durations[error?.code];
  if (!fallbackSeconds) return null;
  const requestedSeconds = Number(error?.retryAfterSeconds);
  const retryAfterSeconds = Number.isFinite(requestedSeconds) && requestedSeconds > 0 ? Math.ceil(requestedSeconds) : fallbackSeconds;
  const value = { code: error.code, until: now + retryAfterSeconds * 1000 };
  const target = availableStorage(storage);
  try { target?.setItem(REALTIME_COOLDOWN_KEY, JSON.stringify(value)); } catch { /* private mode */ }
  return value;
}

export function realtimeSpeechSupported() {
  return typeof window !== 'undefined'
    && typeof window.RTCPeerConnection === 'function'
    && typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function realtimeSpeechAvailable(storage, now = Date.now()) {
  return realtimeSpeechSupported() && !realtimeCooldown(storage, now);
}

function waitForOpen(channel, timeoutMs = OPEN_TIMEOUT_MS) {
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(Object.assign(new Error('Realtime data channel timed out'), { code: 'VOICE_REALTIME_TIMEOUT' })), timeoutMs);
    channel.addEventListener('open', () => { window.clearTimeout(timer); resolve(); }, { once: true });
    channel.addEventListener('error', () => { window.clearTimeout(timer); reject(Object.assign(new Error('Realtime data channel failed'), { code: 'VOICE_REALTIME_CHANNEL' })); }, { once: true });
  });
}

function waitForIceGathering(peer, timeoutMs = 1_000) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { window.clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); resolve(); };
    const changed = () => { if (peer.iceGatheringState === 'complete') done(); };
    const timer = window.setTimeout(done, timeoutMs);
    peer.addEventListener('icegatheringstatechange', changed);
  });
}

export function createRealtimeTranscriber({ stream, createSession, onUpdate, onError }) {
  const PeerConnection = window.RTCPeerConnection;
  const peer = new PeerConnection();
  const channel = peer.createDataChannel('oai-events');
  const track = stream?.getAudioTracks?.()[0];
  if (!track) throw Object.assign(new Error('Audio track is missing'), { code: 'VOICE_AUDIO_CAPTURE' });
  peer.addTrack(track, stream);

  let partialTranscript = '';
  let finalTranscript = '';
  let stopped = false;
  let completedResolve;
  const completed = new Promise((resolve) => { completedResolve = resolve; });

  const publish = (isFinal = false) => {
    const transcript = normalizePersian(finalTranscript || partialTranscript);
    if (transcript) onUpdate?.({ transcript, finalTranscript: isFinal ? transcript : '', completed: isFinal });
  };

  channel.addEventListener('message', (message) => {
    let event;
    try { event = JSON.parse(message.data); } catch { return; }
    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      partialTranscript += String(event.delta || '');
      publish(false);
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      finalTranscript = String(event.transcript || partialTranscript);
      publish(true);
      completedResolve(normalizePersian(finalTranscript));
    } else if (event.type === 'error') {
      const error = Object.assign(new Error(event.error?.message || 'Realtime transcription failed'), { code: event.error?.code || 'VOICE_REALTIME_EVENT' });
      onError?.(error);
    }
  });

  const ready = (async () => {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer);
    const answerSdp = await createSession(peer.localDescription?.sdp || offer.sdp);
    await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    await waitForOpen(channel);
    return true;
  })().catch((error) => {
    onError?.(error);
    throw error;
  });

  const close = () => {
    if (stopped) return;
    stopped = true;
    try { channel.close(); } catch { /* already closed */ }
    try { peer.close(); } catch { /* already closed */ }
  };

  return {
    ready,
    async finish({ timeoutMs = FINAL_TIMEOUT_MS } = {}) {
      try {
        await ready;
        if (channel.readyState === 'open') channel.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        const transcript = await Promise.race([
          completed,
          new Promise((resolve) => window.setTimeout(() => resolve(normalizePersian(finalTranscript || partialTranscript)), timeoutMs)),
        ]);
        return { transcript, completed: Boolean(finalTranscript) };
      } finally { close(); }
    },
    abort: close,
  };
}
