import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const runtimeCsrfSecret = process.env.CSRF_SECRET || randomBytes(32).toString('hex');
const MINIMUM_PRODUCTION_SECRET_LENGTH = 32;

function configurationError(message) {
  return Object.assign(new Error(message), { code: 'SECURITY_CONFIG_INVALID' });
}

export function validateSecurityConfiguration(environment = process.env) {
  const production = String(environment.NODE_ENV || '').toLowerCase() === 'production';
  if (!production) return { production: false, trustProxyHops: 0 };

  const csrfSecret = String(environment.CSRF_SECRET || '');
  const fingerprintSecret = String(environment.AUTH_FINGERPRINT_SECRET || '');
  const isPlaceholder = (value) => /(?:replace|change|example|sample|placeholder)/i.test(value);
  if (csrfSecret.length < MINIMUM_PRODUCTION_SECRET_LENGTH || isPlaceholder(csrfSecret)) {
    throw configurationError('CSRF_SECRET در Production باید حداقل ۳۲ نویسهٔ تصادفی و غیرنمونه داشته باشد.');
  }
  if (fingerprintSecret.length < MINIMUM_PRODUCTION_SECRET_LENGTH || isPlaceholder(fingerprintSecret)) {
    throw configurationError('AUTH_FINGERPRINT_SECRET در Production باید حداقل ۳۲ نویسهٔ تصادفی و غیرنمونه داشته باشد.');
  }
  if (csrfSecret === fingerprintSecret) {
    throw configurationError('CSRF_SECRET و AUTH_FINGERPRINT_SECRET باید مستقل باشند.');
  }

  const rawProxyHops = String(environment.TRUST_PROXY_HOPS || '');
  const trustProxyHops = Number(rawProxyHops);
  if (!/^\d+$/.test(rawProxyHops) || !Number.isInteger(trustProxyHops) || trustProxyHops < 1 || trustProxyHops > 3) {
    throw configurationError('TRUST_PROXY_HOPS در Production باید عدد صحیح بین ۱ تا ۳ باشد.');
  }
  return { production: true, trustProxyHops };
}

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

function fingerprint(value) {
  const pepper = process.env.AUTH_FINGERPRINT_SECRET || runtimeCsrfSecret;
  return createHmac('sha256', pepper).update(String(value)).digest('hex');
}

export function requestFingerprint(address = '', userAgent = '') {
  return fingerprint(`network:${address}:${String(userAgent).slice(0, 240)}`);
}

export function accountLoginFingerprint(username = '') {
  const normalized = String(username || '').trim().toLocaleLowerCase('en-US').slice(0, 160);
  return fingerprint(`account:${normalized || '<empty>'}`);
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
