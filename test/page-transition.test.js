import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * گذرِ صفحه‌ها: یک ورودِ آرام (محو + چند پیکسل بالا آمدن) فقط وقتی صفحه عوض می‌شود.
 * برگه‌های درونِ یک صفحه کلید را عوض نمی‌کنند تا همان‌جا فوری بمانند. فقط opacity و
 * transform، زیر ۳۰۰ میلی‌ثانیه، و با «کاهش حرکت» هیچ.
 */

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('کلیدِ پوسته فقط صفحه است، نه بخش', () => {
  assert.match(app, /<div key=\{screen\} className="screen-enter">/);
  assert.equal((app.match(/className="screen-enter"/g) || []).length, 1);
});

test('فقط opacity و transform، کوتاه، با منحنیِ ease-out؛ با «کاهش حرکت» خاموش', () => {
  const frames = css.match(/@keyframes screen-in \{([\s\S]*?)\n\}/);
  assert.ok(frames, '@keyframes screen-in');
  const properties = [...frames[1].matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1]);
  assert.ok(properties.length >= 2);
  for (const name of properties) assert.ok(['opacity', 'transform'].includes(name), `خاصیتِ ${name}`);
  const timing = css.match(/\.screen-enter \{ animation: screen-in \.(\d+)s (cubic-bezier\([^)]*\)); \}/);
  assert.ok(timing, '.screen-enter');
  assert.ok(Number(timing[1].padEnd(3, '0')) <= 300, `${timing[1]} زیر ۳۰۰ms`);
  assert.doesNotMatch(timing[2], /ease-in\b/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.screen-enter \{ animation: none; \}/);
  // fill پیش‌فرض: پس از پایان، transform دوباره none است و fixedها نسبت به دیدگر جا می‌گیرند.
  assert.doesNotMatch(css, /\.screen-enter \{[^}]*\b(?:forwards|both)\b/);
});
