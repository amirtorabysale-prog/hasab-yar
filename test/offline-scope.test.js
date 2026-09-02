import test from 'node:test';
import assert from 'node:assert/strict';
import {
  belongsToOfflineScope, isPermanentQueueError, normalizeOfflineScope, normalizeOfflineState,
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
