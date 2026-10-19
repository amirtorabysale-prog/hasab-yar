import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';

/**
 * آیکن‌های زنده (خواستهٔ مالک محصول، ۲۸ مهر ۱۴۰۵): آیکنِ داخل یک کنترل با رفتن
 * ماوس، حرکتِ معنای خودش را نشان می‌دهد؛ دکمه با فشردن کمی جمع می‌شود.
 *
 * چیزی که بی‌صدا خراب می‌شود نام کلاس است: اگر `.lucide-trash` به‌جای کلاسِ واقعیِ
 * آیکن نوشته شود، هیچ خطایی نمی‌آید و آیکن فقط تکان نمی‌خورد. پس هر کلاسِ اینجا با
 * رندرِ خودِ آیکنِ lucide سنجیده می‌شود.
 */

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const HOVER_GATE = '@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) {';

function hoverBlock() {
  const start = css.indexOf(HOVER_GATE);
  assert.ok(start >= 0, 'حرکت hover پشتِ دروازهٔ ماوس واقعی و «کاهش حرکت» است');
  let depth = 0;
  for (let index = start; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') { depth -= 1; if (depth === 0) return css.slice(start + HOVER_GATE.length, index); }
  }
  throw new Error('بلوک hover بسته نشده');
}

const pascal = (kebab) => kebab.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');

test('هر کلاسِ آیکن در CSS همان کلاسی است که lucide روی آیکن می‌گذارد', () => {
  const classes = [...new Set([...hoverBlock().matchAll(/\.lucide-([a-z0-9-]+)/g)].map((match) => match[1]))];
  assert.ok(classes.length >= 15, `آیکن‌ها: ${classes.join(', ')}`);
  for (const name of classes) {
    const Icon = icons[pascal(name)];
    assert.ok(Icon, `آیکنی به نام ${pascal(name)} در lucide نیست`);
    const markup = renderToStaticMarkup(createElement(Icon, { size: 16 }));
    assert.match(markup, new RegExp(`class="[^"]*\\blucide-${name}\\b`), `کلاس lucide-${name} روی ${pascal(name)} نیست`);
  }
});

test('فقط translate، rotate و scale حرکت می‌کنند؛ نه چیدمان، نه transition: all', () => {
  const block = hoverBlock();
  // فقط اعلان‌های داخل آکولاد، نه «button:hover» در انتخابگر.
  const properties = [...block.matchAll(/\{([^{}]*)\}/g)]
    .flatMap((match) => [...match[1].matchAll(/([a-z-]+)\s*:/g)].map((declaration) => declaration[1]));
  assert.ok(properties.length >= 15);
  for (const name of properties) assert.ok(['translate', 'rotate', 'scale', 'transition', 'transform-origin'].includes(name), `خاصیتِ ${name}`);
  assert.doesNotMatch(css, /transition\s*:\s*all\b/);
  assert.match(block, /transition: translate \.16s var\(--ease-out\), rotate \.16s var\(--ease-out\), scale \.16s var\(--ease-out\)/);
  assert.match(css, /--ease-out: cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
});

test('آیکنِ وضعیت که داخل کنترل نیست تکان نمی‌خورد؛ پیکانِ منو چرخشِ خودش را دارد', () => {
  for (const line of hoverBlock().split('\n').filter((row) => row.includes('.lucide'))) {
    assert.match(line, /:is\(button:not\(:disabled\), a\[href\], \[role="button"\], \[role="tab"\], summary, \.menu-group, \.menu-leaf\)/, line.trim());
  }
  assert.match(hoverBlock(), /:hover :is\(\.lucide-chevron-down, \.lucide-chevron-up\) \{ translate: none; \}/);
  assert.match(css, /\.menu-chevron\.is-open \{ transform: rotate\(180deg\); \}/, 'چرخشِ پیکانِ منو با transform است و با rotate جدا تداخل ندارد');
});

test('فشردن دکمه کمی جمعش می‌کند، با scale جدا تا transformِ موجود دکمه نپرد', () => {
  assert.match(css, /button:not\(:disabled\):active \{ scale: \.97; \}/);
  assert.match(css, /scale \.16s var\(--ease-out\)/);
});
