import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountLoginFingerprint, csrfTokenFor, csrfTokenIsValid, originMatchesHost, passwordPolicy, requestFingerprint, setSecurityHeaders, validateSecurityConfiguration,
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

test('separates network and account login throttling identities', () => {
  const network = requestFingerprint('192.0.2.10', 'Test Browser');
  const account = accountLoginFingerprint('Owner-Test');
  assert.equal(account.length, 64);
  assert.notEqual(account, network);
  assert.equal(account, accountLoginFingerprint(' owner-test '));
});

test('fails closed on weak or ambiguous production security configuration', () => {
  const valid = {
    NODE_ENV: 'production',
    CSRF_SECRET: 'csrf-secret-32-characters-minimum-1',
    AUTH_FINGERPRINT_SECRET: 'fingerprint-secret-32-characters-2',
    TRUST_PROXY_HOPS: '1',
  };
  assert.deepEqual(validateSecurityConfiguration(valid), { production: true, trustProxyHops: 1 });
  assert.throws(() => validateSecurityConfiguration({ ...valid, CSRF_SECRET: 'short' }), /CSRF_SECRET/);
  assert.throws(() => validateSecurityConfiguration({ ...valid, CSRF_SECRET: 'replace-with-at-least-32-random-bytes' }), /CSRF_SECRET/);
  assert.throws(() => validateSecurityConfiguration({ ...valid, AUTH_FINGERPRINT_SECRET: valid.CSRF_SECRET }), /مستقل/);
  assert.throws(() => validateSecurityConfiguration({ ...valid, TRUST_PROXY_HOPS: '0' }), /TRUST_PROXY_HOPS/);
  assert.deepEqual(validateSecurityConfiguration({ NODE_ENV: 'test' }), { production: false, trustProxyHops: 0 });
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
