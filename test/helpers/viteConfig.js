import { readFileSync } from 'node:fs';

/** خواندن vite.config.js برای آزمون‌های قفل‌کنندهٔ تنظیمات پروکسی dev. */
export function viteConfigSource() {
  return readFileSync(new URL('../../vite.config.js', import.meta.url), 'utf8');
}
