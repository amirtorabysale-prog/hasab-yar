import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const runtimeCsrfSecret = process.env.CSRF_SECRET || randomBytes(32).toString('hex');

export function csrfTokenFor(sessionToken) {
  if (!sessionToken) return '';
  return createHmac('sha256', runtimeCsrfSecret).update(String(sessionToken)).digest('base64url');
}

export function csrfTokenIsValid(sessionToken, suppliedToken) {
  if (!sessionToken || !suppliedToken) return false;
  const expected = Buffer.from(csrfTokenFor(sessionToken));
  const supplied = Buffer.from(String(suppliedToken));
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function requestFingerprint(address = '', userAgent = '') {
  const pepper = process.env.AUTH_FINGERPRINT_SECRET || runtimeCsrfSecret;
  return createHash('sha256').update(`${pepper}:${address}:${String(userAgent).slice(0, 240)}`).digest('hex');
}

export function originMatchesHost(origin, host) {
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; }
  catch { return false; }
}

export function passwordPolicy(password, username = '') {
  const value = String(password || '');
  if (value.length < 14) return { valid: false, message: 'رمز جدید باید حداقل ۱۴ نویسه باشد.' };
  if (value.length > 200) return { valid: false, message: 'رمز جدید بیش از حد طولانی است.' };
  if (username && value.toLocaleLowerCase('en-US').includes(String(username).toLocaleLowerCase('en-US'))) return { valid: false, message: 'رمز نباید شامل نام کاربری باشد.' };
  if (!/[\p{L}]/u.test(value) || !/\d/u.test(value)) return { valid: false, message: 'رمز باید دست‌کم یک حرف و یک عدد داشته باشد.' };
  return { valid: true, message: '' };
}

export function setSecurityHeaders(response, { production = false } = {}) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
  ].join('; '));
  if (production) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
