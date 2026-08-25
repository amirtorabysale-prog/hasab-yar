const EMPTY_SNAPSHOT = Object.freeze({ transcript: '', finalTranscript: '', candidates: [], error: null, ended: false, source: '' });

export function selectVoiceSnapshot({ browser, realtime, realtimeFailed = false } = {}) {
  const safeBrowser = browser || EMPTY_SNAPSHOT;
  const safeRealtime = realtime || EMPTY_SNAPSHOT;
  if (!realtimeFailed && safeRealtime.transcript) return safeRealtime;
  if (safeBrowser.transcript) return safeBrowser;
  if (!realtimeFailed && safeRealtime.transcript) return safeRealtime;
  return { ...safeBrowser, error: safeBrowser.error || safeRealtime.error || null };
}
