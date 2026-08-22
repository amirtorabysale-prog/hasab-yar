import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const databasePath = `/tmp/hesab-yar-auth-${process.pid}.sqlite`;
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'owner-test';
process.env.ADMIN_PASSWORD = 'a-strong-test-password-1234';

const database = await import(`../server/db.js?auth=${process.pid}`);

test('creates the owner only from server configuration', () => {
  assert.deepEqual(database.ensureAdmin(), { configured: true, username: 'owner-test' });
});

test('rejects a wrong password and accepts the configured password', () => {
  assert.equal(database.authenticateUser('owner-test', 'wrong-password'), null);
  assert.equal(database.authenticateUser('owner-test', 'a-strong-test-password-1234')?.username, 'owner-test');
});

test('creates and revokes an opaque server-side session', () => {
  const user = database.authenticateUser('owner-test', 'a-strong-test-password-1234');
  const session = database.createSession(user.id);
  assert.equal(database.userFromSession(session.token)?.username, 'owner-test');
  database.deleteSession(session.token);
  assert.equal(database.userFromSession(session.token), null);
});

test('keeps at most five active sessions for the owner', () => {
  const user = database.authenticateUser('owner-test', 'a-strong-test-password-1234');
  const sessions = Array.from({ length: 6 }, () => database.createSession(user.id));
  assert.equal(database.userFromSession(sessions[0].token), null);
  assert.equal(database.userFromSession(sessions[5].token)?.username, 'owner-test');
});

test('persists login throttling without storing a raw address', () => {
  const fingerprint = 'hashed-request-fingerprint';
  const now = new Date('2026-08-22T12:00:00.000Z');
  for (let attempt = 0; attempt < 8; attempt += 1) database.recordLoginFailure(fingerprint, now);
  assert.equal(database.loginThrottle(fingerprint, now).blocked, true);
  database.clearLoginFailures(fingerprint);
  assert.equal(database.loginThrottle(fingerprint, now).blocked, false);
});

test('changes the password and revokes every existing session', () => {
  const user = database.authenticateUser('owner-test', 'a-strong-test-password-1234');
  const session = database.createSession(user.id);
  assert.equal(database.changePassword(user.id, 'wrong', 'another-strong-password-5678').code, 'CURRENT_PASSWORD_INVALID');
  assert.equal(database.changePassword(user.id, 'a-strong-test-password-1234', 'new-strong-password-5678').changed, true);
  assert.equal(database.userFromSession(session.token), null);
  assert.equal(database.authenticateUser('owner-test', 'a-strong-test-password-1234'), null);
  assert.equal(database.authenticateUser('owner-test', 'new-strong-password-5678')?.username, 'owner-test');
});

test.after(() => {
  database.db.close();
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
});
