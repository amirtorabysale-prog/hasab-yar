/**
 * نشانی هر صفحه: `#/<صفحه>/<بخش>` — مثلاً `#/ledger/timing`.
 *
 * تا امروز صفحه فقط در حالت React بود: دکمهٔ «بازگشت» مرورگر از برنامه بیرون می‌رفت،
 * تازه‌سازی همیشه «امروز» را باز می‌کرد و هیچ صفحه‌ای پیوند نداشت که بشود برای همکار
 * فرستاد. هش (نه مسیر) تا سرور و service worker هیچ تغییری نخواهند.
 */
export function readRoute(hash = typeof window === 'undefined' ? '' : window.location.hash) {
  const [screen = '', section = ''] = String(hash || '').replace(/^#\/?/, '').split('/');
  const clean = (value) => { try { return decodeURIComponent(value).replace(/[^\w-]/g, ''); } catch { return ''; } };
  return { screen: clean(screen), section: clean(section) };
}

export function routeHash(screen, section = '') {
  return `#/${encodeURIComponent(screen)}${section ? `/${encodeURIComponent(section)}` : ''}`;
}

/** نشانی را با صفحهٔ فعلی هم‌سو می‌کند؛ `replace` برای اصلاح بی‌آنکه تاریخچه پر شود. */
export function writeRoute(screen, section = '', { replace = false } = {}) {
  if (typeof window === 'undefined') return;
  const hash = routeHash(screen, section);
  if (window.location.hash === hash) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', hash);
}
