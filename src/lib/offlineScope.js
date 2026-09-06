export const OFFLINE_STATES = Object.freeze(['queued', 'review', 'failed']);

export function normalizeOfflineScope(value = {}) {
  const userId = String(value?.userId || '').trim();
  const workspaceId = String(value?.workspaceId || '').trim();
  return userId && workspaceId ? { userId, workspaceId } : null;
}

export function requireOfflineScope(value) {
  const scope = normalizeOfflineScope(value);
  if (scope) return scope;
  throw Object.assign(new Error('کاربر و دفتر فعال برای ذخیرهٔ آفلاین مشخص نیست.'), {
    code: 'OFFLINE_SCOPE_REQUIRED',
  });
}

export function offlineScopeKey(value) {
  const scope = requireOfflineScope(value);
  return `${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.workspaceId)}`;
}

export function belongsToOfflineScope(record, value) {
  const scope = normalizeOfflineScope(value);
  return Boolean(scope && record?.userId === scope.userId && record?.workspaceId === scope.workspaceId);
}

export function normalizeOfflineState(value) {
  return OFFLINE_STATES.includes(value) ? value : 'queued';
}

export function isPermanentQueueError(error) {
  const status = Number(error?.status || 0);
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

export const MAX_OFFLINE_AUDIO_ATTEMPTS = 3;

/**
 * صف صدا برخلاف صف تراکنش‌ها هیچ سقف تلاشی نداشت: هر ضبطی که پردازش نمی‌شد
 * دوباره در حالت `queued` می‌نشست و بی‌پایان تکرار می‌شد. چون حلقهٔ همگام‌سازی
 * بعد از هر قلم متوقف می‌شود، همان یک ضبط خرابْ تمام ضبط‌های بعدی را هم بلوکه
 * می‌کرد و هر بار سهمیهٔ سرویس را می‌سوزاند.
 */
export function nextOfflineAudioState(record = {}, { permanent = false } = {}) {
  const attempts = Number(record.attempts || 0) + 1;
  const exhausted = permanent || attempts >= MAX_OFFLINE_AUDIO_ATTEMPTS;
  return { state: exhausted ? 'failed' : 'queued', attempts, exhausted };
}
