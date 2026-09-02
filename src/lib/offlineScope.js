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
