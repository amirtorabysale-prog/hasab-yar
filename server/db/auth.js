import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { controlDb } from './core.js';
import { passwordPolicy } from '../security.js';

export function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

export function ensureAdmin() {
  const username = String(process.env.ADMIN_USERNAME || 'owner').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  let existing = controlDb.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!existing) {
    const policy = passwordPolicy(password, username);
    if (!policy.valid || password === 'change-this-to-a-long-random-password') return { configured: false, username };
    const salt = randomBytes(24).toString('hex');
    existing = { id: randomUUID() };
    controlDb.prepare('INSERT INTO users (id,username,password_hash,password_salt,display_name) VALUES (?,?,?,?,?)')
      .run(existing.id, username, hashPassword(password, salt), salt, username);
  }
  const primaryName = controlDb.prepare("SELECT value FROM settings WHERE key='businessName'").get()?.value || 'دفتر اصلی';
  const primaryProfile = controlDb.prepare("SELECT value FROM settings WHERE key='profileType'").get()?.value === 'personal' ? 'personal' : 'business';
  controlDb.prepare(`INSERT OR IGNORE INTO workspaces (id,name,profile_type,created_by) VALUES ('primary',?,?,?)`)
    .run(primaryName, primaryProfile, existing.id);
  controlDb.prepare(`INSERT INTO workspace_members (workspace_id,user_id,role,experience) VALUES ('primary',?,'owner','professional')
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='owner',experience='professional'`).run(existing.id);
  return { configured: true, username };
}

export function authenticateUser(username, password) {
  const user = controlDb.prepare('SELECT id,username,display_name AS displayName,must_change_password AS mustChangePassword,password_hash,password_salt FROM users WHERE username=?').get(String(username || '').trim().toLowerCase());
  if (!user) { hashPassword(String(password || ''), '000000000000000000000000000000000000000000000000'); return null; }
  const supplied = Buffer.from(hashPassword(String(password || ''), user.password_salt), 'hex');
  const expected = Buffer.from(user.password_hash, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
    ? { id: user.id, username: user.username, displayName: user.displayName, mustChangePassword: Boolean(user.mustChangePassword) } : null;
}

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function sessionTokenHash(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function publicSessionId(tokenHash) {
  return createHash('sha256').update(`hesab-yar-session:${tokenHash}`).digest('base64url').slice(0, 24);
}

export function createSession(userId, { now = new Date() } = {}) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sessionTokenHash(token);
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
  controlDb.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
  controlDb.prepare('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)').run(tokenHash, userId, expiresAt, now.toISOString());
  controlDb.prepare(`DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (
    SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 5
  )`).run(userId, userId);
  return { token, expiresAt };
}

export function userFromSession(token) {
  if (!token) return null;
  const tokenHash = sessionTokenHash(token);
  return controlDb.prepare(`SELECT users.id,users.username,users.display_name AS displayName,
    users.must_change_password AS mustChangePassword,sessions.expires_at AS expiresAt
    FROM sessions JOIN users ON users.id=sessions.user_id
    WHERE sessions.token_hash=? AND sessions.expires_at>?`).get(tokenHash, new Date().toISOString()) || null;
}

export function listUserSessions(userId, currentToken = '') {
  const currentHash = currentToken ? sessionTokenHash(currentToken) : '';
  const now = new Date().toISOString();
  controlDb.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  return controlDb.prepare(`SELECT token_hash AS tokenHash,created_at AS createdAt,expires_at AS expiresAt
    FROM sessions WHERE user_id=? ORDER BY created_at DESC,rowid DESC`).all(userId).map((row) => ({
      id: publicSessionId(row.tokenHash),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      current: row.tokenHash === currentHash,
    }));
}

export function revokeUserSession(userId, sessionId, currentToken = '') {
  const target = listUserSessions(userId, currentToken).find((item) => item.id === String(sessionId || ''));
  if (!target) return { revoked: false, code: 'SESSION_NOT_FOUND' };
  if (target.current) return { revoked: false, code: 'CURRENT_SESSION' };
  const rows = controlDb.prepare('SELECT token_hash AS tokenHash FROM sessions WHERE user_id=?').all(userId);
  const row = rows.find((item) => publicSessionId(item.tokenHash) === target.id);
  if (!row) return { revoked: false, code: 'SESSION_NOT_FOUND' };
  controlDb.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash=?').run(userId, row.tokenHash);
  return { revoked: true };
}

export function revokeOtherUserSessions(userId, currentToken) {
  const currentHash = sessionTokenHash(currentToken);
  const result = controlDb.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(userId, currentHash);
  return { revoked: Number(result.changes || 0) };
}

export function deleteSession(token) {
  if (!token) return;
  controlDb.prepare('DELETE FROM sessions WHERE token_hash=?').run(sessionTokenHash(token));
}

export function loginThrottle(fingerprint, now = new Date()) {
  const row = controlDb.prepare('SELECT attempts,locked_until AS lockedUntil FROM auth_attempts WHERE fingerprint=?').get(fingerprint);
  if (!row?.lockedUntil || row.lockedUntil <= now.toISOString()) return { blocked: false, retryAfterSeconds: 0 };
  return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((new Date(row.lockedUntil).getTime() - now.getTime()) / 1000)) };
}

export function recordLoginFailure(fingerprint, now = new Date(), { limit = 8, lockMinutes = 15 } = {}) {
  const normalizedLimit = Math.min(100, Math.max(2, Number(limit) || 8));
  const windowMs = Math.min(60, Math.max(1, Number(lockMinutes) || 15)) * 60 * 1000;
  const current = controlDb.prepare('SELECT attempts,window_started_at AS windowStartedAt FROM auth_attempts WHERE fingerprint=?').get(fingerprint);
  const insideWindow = current && now.getTime() - new Date(current.windowStartedAt).getTime() < windowMs;
  const attempts = insideWindow ? Number(current.attempts) + 1 : 1;
  const windowStartedAt = insideWindow ? current.windowStartedAt : now.toISOString();
  const lockedUntil = attempts >= normalizedLimit ? new Date(now.getTime() + windowMs).toISOString() : null;
  controlDb.prepare(`INSERT INTO auth_attempts (fingerprint,attempts,window_started_at,locked_until,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(fingerprint) DO UPDATE SET attempts=excluded.attempts,window_started_at=excluded.window_started_at,
      locked_until=excluded.locked_until,updated_at=excluded.updated_at`)
    .run(fingerprint, attempts, windowStartedAt, lockedUntil, now.toISOString());
  controlDb.prepare('DELETE FROM auth_attempts WHERE updated_at<?').run(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
  return { attempts, blocked: Boolean(lockedUntil), lockedUntil };
}

export function clearLoginFailures(fingerprint) {
  controlDb.prepare('DELETE FROM auth_attempts WHERE fingerprint=?').run(fingerprint);
}

export function changePassword(userId, currentPassword, newPassword) {
  const user = controlDb.prepare('SELECT id,username,password_hash,password_salt FROM users WHERE id=?').get(userId);
  if (!user) return { changed: false, code: 'USER_NOT_FOUND' };
  const supplied = Buffer.from(hashPassword(String(currentPassword || ''), user.password_salt), 'hex');
  const expected = Buffer.from(user.password_hash, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return { changed: false, code: 'CURRENT_PASSWORD_INVALID' };
  const policy = passwordPolicy(newPassword, user.username);
  if (!policy.valid) return { changed: false, code: 'WEAK_PASSWORD', message: policy.message };
  if (String(currentPassword) === String(newPassword)) return { changed: false, code: 'PASSWORD_UNCHANGED', message: 'رمز جدید باید با رمز فعلی متفاوت باشد.' };
  const salt = randomBytes(24).toString('hex');
  controlDb.exec('BEGIN IMMEDIATE');
  try {
    controlDb.prepare('UPDATE users SET password_hash=?,password_salt=?,must_change_password=0 WHERE id=?').run(hashPassword(String(newPassword), salt), salt, userId);
    controlDb.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    controlDb.prepare('INSERT INTO audit_log (id,action,entity_type,entity_id,payload) VALUES (?,?,?,?,?)')
      .run(randomUUID(), 'password-change', 'user', userId, '{}');
    controlDb.exec('COMMIT');
  } catch (error) { controlDb.exec('ROLLBACK'); throw error; }
  return { changed: true };
}
