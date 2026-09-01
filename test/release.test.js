import test from 'node:test';
import assert from 'node:assert/strict';
import { healthPayload, releaseIdentity } from '../server/release.js';

test('Railway commit SHA is published without exposing unrelated environment values', () => {
  const release = releaseIdentity({ RAILWAY_GIT_COMMIT_SHA: 'A'.repeat(40), SECRET: 'never-return-this' });
  assert.deepEqual(release, { sha: 'a'.repeat(40), source: 'RAILWAY_GIT_COMMIT_SHA' });
  assert.doesNotMatch(JSON.stringify(release), /never-return-this/);
});

test('an invalid or missing deployment SHA is explicit instead of invented', () => {
  assert.deepEqual(releaseIdentity({ RAILWAY_GIT_COMMIT_SHA: 'main' }), { sha: 'unknown', source: 'unavailable' });
  assert.equal(healthPayload({}).ok, true);
  assert.equal(healthPayload({}).release.sha, 'unknown');
});
