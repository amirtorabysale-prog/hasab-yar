/**
 * تم روشن و تاریک.
 *
 * رنگ‌ها متغیرهای CSS‌اند (`src/styles.css`)، پس کلاس `dark` روی `<html>` کل برنامه را
 * یکجا عوض می‌کند — هیچ صفحه‌ای رنگ خودش را جدا نمی‌شناسد. انتخاب کاربر در همین
 * مرورگر می‌ماند؛ «خودکار» از تنظیم سیستم عامل پیروی می‌کند و با عوض‌شدنش عوض می‌شود.
 */
const KEY = 'hy-theme';
export const THEMES = Object.freeze(['light', 'dark', 'system']);
export const THEME_LABELS = Object.freeze({ light: 'روشن', dark: 'تاریک', system: 'خودکار' });
const THEME_COLOR = { light: '#F4F6F7', dark: '#0D1417' };

const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

export function storedTheme() {
  try {
    const value = window.localStorage.getItem(KEY);
    return THEMES.includes(value) ? value : 'system';
  } catch { return 'system'; }
}

export function resolvedTheme(choice = storedTheme()) {
  if (choice === 'system') return media()?.matches ? 'dark' : 'light';
  return choice;
}

export function applyTheme(choice = storedTheme()) {
  if (typeof document === 'undefined') return;
  const mode = resolvedTheme(choice);
  document.documentElement.classList.toggle('dark', mode === 'dark');
  document.documentElement.style.colorScheme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[mode]);
}

export function setTheme(choice) {
  const value = THEMES.includes(choice) ? choice : 'system';
  try { window.localStorage.setItem(KEY, value); } catch { /* حالت خصوصی: فقط برای همین نشست */ }
  applyTheme(value);
  return value;
}

/** با «خودکار»، تغییر تنظیم سیستم عامل همان لحظه دیده شود. */
export function watchSystemTheme() {
  const query = media();
  if (!query) return () => {};
  const listener = () => { if (storedTheme() === 'system') applyTheme('system'); };
  query.addEventListener?.('change', listener);
  return () => query.removeEventListener?.('change', listener);
}
