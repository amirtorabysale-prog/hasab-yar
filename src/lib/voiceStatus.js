import { realtimeCooldown } from './realtimeSpeech.js';

export const HOLD_TO_FINISH_MS = 420;

export function pointerReleaseAction(elapsedMs) {
  return Number(elapsedMs) >= HOLD_TO_FINISH_MS ? 'stop' : 'keep-recording';
}

export function retryLabel(seconds) {
  const value = Math.max(1, Math.ceil(Number(seconds) || 0));
  if (value < 60) return `${value} ثانیه`;
  return `${Math.ceil(value / 60)} دقیقه`;
}

/**
 * آیا اصلاً ارزش دارد نشست Realtime باز شود؟
 *
 * `realtimeSpeechAvailable` فقط پشتیبانی مرورگر و cooldown محلی را می‌سنجد و
 * نظر سرور را نمی‌پرسد. نتیجه‌اش این بود که وقتی سرور می‌دانست Realtime
 * تنظیم نشده یا در cooldown است، مرورگر همچنان برای **هر ضبط** یک نشست باز
 * می‌کرد. Realtime بر اساس مدت باز بودن نشست هزینه می‌گیرد، پس این یعنی پولِ
 * بی‌نتیجه.
 *
 * وضعیت ناشناخته (هنوز بارگذاری نشده) مانع تلاش نمی‌شود؛ فقط «می‌دانیم در
 * دسترس نیست» جلوی نشست را می‌گیرد.
 */
export function realtimeWorthTrying(status, { browserReady = false } = {}) {
  if (!browserReady) return false;
  if (!status?.realtime) return true;
  return Boolean(status.realtime.available);
}

export function describeVoiceAvailability(status, { browserSupported = false, storage, now = Date.now() } = {}) {
  const localCooldown = realtimeCooldown(storage, now);
  const serverCooldown = status?.realtime?.cooldown;
  const cooldown = localCooldown || serverCooldown;
  const realtimeReady = Boolean(status?.realtime?.available) && !localCooldown;
  const live = realtimeReady
    ? { tone: 'good', label: browserSupported ? 'زنده: Chrome + هوشمند' : 'زنده: هوشمند' }
    : browserSupported
      ? { tone: cooldown ? 'warn' : 'neutral', label: cooldown ? `زنده: Chrome؛ هوشمند تا ${retryLabel(cooldown.retryAfterSeconds || ((cooldown.until - now) / 1000))} مکث` : 'زنده: Chrome' }
      : { tone: 'warn', label: 'متن زنده در این مرورگر محدود است' };
  const file = status?.file?.available
    ? { tone: 'good', label: 'فایل پشتیبان: آماده' }
    : { tone: 'warn', label: 'فایل پشتیبان: تنظیم نشده' };
  return [live, file];
}

export function voicePathLabel(path = 'ready') {
  return ({
    ready: 'آمادهٔ شنیدن',
    requesting: 'درخواست دسترسی میکروفن',
    capturing: 'ضبط امن صدا',
    'browser-live': 'تایپ زنده با Chrome',
    'realtime-connecting': 'اتصال تایپ زنده هوشمند',
    'realtime-live': 'تایپ زنده هوشمند',
    finalizing: 'نهایی‌کردن متن و مبلغ',
    'server-file': 'بررسی فایل صوتی روی سرور',
    offline: 'ذخیرهٔ آفلاین برای ارسال بعدی',
  })[path] || 'مسیر صوتی پشتیبان';
}
