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

test.after(() => {
  database.db.close();
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
});
