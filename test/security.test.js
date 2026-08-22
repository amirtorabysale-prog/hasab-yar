import test from 'node:test';
import assert from 'node:assert/strict';
import {
  csrfTokenFor, csrfTokenIsValid, originMatchesHost, passwordPolicy, requestFingerprint, setSecurityHeaders,
} from '../server/security.js';

test('binds CSRF tokens to the opaque session token', () => {
  const token = csrfTokenFor('session-one');
  assert.ok(token.length >= 40);
  assert.equal(csrfTokenIsValid('session-one', token), true);
  assert.equal(csrfTokenIsValid('session-two', token), false);
  assert.equal(csrfTokenIsValid('session-one', ''), false);
});

test('accepts only an exact same-origin host', () => {
  assert.equal(originMatchesHost('https://hesab.example.com', 'hesab.example.com'), true);
  assert.equal(originMatchesHost('https://evil.example.com', 'hesab.example.com'), false);
  assert.equal(originMatchesHost('not-a-url', 'hesab.example.com'), false);
});

test('hashes request identity before persistence', () => {
  const fingerprint = requestFingerprint('192.0.2.10', 'Test Browser');
  assert.equal(fingerprint.length, 64);
  assert.equal(fingerprint.includes('192.0.2.10'), false);
});

test('enforces a practical owner password policy', () => {
  assert.equal(passwordPolicy('short1').valid, false);
  assert.equal(passwordPolicy('owner-test-password-1234', 'owner-test').valid, false);
  assert.equal(passwordPolicy('correct-horse-9837-battery').valid, true);
});

test('sets browser isolation, CSP and production transport headers', () => {
  const headers = new Map();
  setSecurityHeaders({ setHeader: (key, value) => headers.set(key, value) }, { production: true });
  assert.equal(headers.get('X-Frame-Options'), 'DENY');
  assert.match(headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(headers.get('Strict-Transport-Security'), /max-age=31536000/);
});
