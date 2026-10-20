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
  for (const name of properties) assert.ok(['translate', 'rotate', 'scale', 'transition', 'transition-delay', 'transform-origin', 'transform-box'].includes(name), `خاصیتِ ${name}`);
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

test('هاور منو مینیمال است: ردیف فقط رنگ می‌گیرد و حرکت مالِ خودِ آیکن است', () => {
  // خواستهٔ مالک محصول: «مثل سایت Claude، تغییر کوچک و مینیمال بر اساس شکل آیکن».
  // هاور v2 (هالهٔ سه‌لایه، بلند شدن ۴px، آیکن ۱٫۵ برابر، جاروی نور، فلش) هم این را
  // نقض کرد و هم با transition خودش translate/rotate/scaleِ آیکن‌های زنده را پاک کرد.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.replace(/\/\*[\s\S]*?\*\//g, '').trim(), body]);
  for (const [selector, body] of rules) {
    if (!/\.menu-(?:group|leaf)[^,{]*:(?:hover|active|focus-visible)/.test(selector) || /\.lucide/.test(selector)) continue;
    assert.doesNotMatch(body, /(?:^|;)\s*(?:transform|translate|box-shadow|filter|rotate)\s*:/, `${selector} فقط رنگ می‌گیرد`);
  }
  for (const [selector, body] of rules) {
    assert.ok(!(/\.menu-group[^,{]*(?:>\s*)?svg/.test(selector) && /transition\s*:/.test(body)), `${selector} transitionِ آیکن‌های زنده را بازنویسی می‌کند`);
  }
  // فشردن: transitionِ پایهٔ ردیف‌های منو scale را دارد تا scale: .97 نپرد.
  for (const [selector, body] of rules.filter(([selector, body]) => /\.menu-(?:group|leaf)\b/.test(selector) && /transition\s*:/.test(body) && !/\.lucide|svg/.test(selector))) {
    assert.match(body, /scale \.16s/, selector);
  }
  assert.doesNotMatch(css, /content:\s*'←'/, 'فلشِ ساخته‌شده با CSS جزو نامِ دکمه برای صفحه‌خوان می‌شود');
  assert.doesNotMatch(css, /--ease-pop/);
  assert.match(css, /\.menu-group:focus-visible, \.menu-leaf:focus-visible \{ background: rgb\(var\(--c-accent\) \/ \.08\); \}/);
});

/** کلاسِ اصلیِ آیکن (اولین lucide-* پس از lucide)، همان که CSS باید بنویسد. */
const canonicalClass = (Icon) => renderToStaticMarkup(createElement(Icon, { size: 18 })).match(/class="lucide (lucide-[a-z0-9-]+)/)[1];

test('هر آیکنِ منوی کناری حرکتِ شکلِ خودش را دارد، نه فقط بلند شدنِ یکسانِ ۱ پیکسلی', () => {
  // دیدهٔ مالک محصول روی سایت: «وقتی موس میره روشون اتفاق خاصی براشون نمیفته».
  const navigation = readFileSync(new URL('../src/app/navigation.jsx', import.meta.url), 'utf8');
  const maps = [...navigation.matchAll(/const (?:SCREEN|GROUP)_ICONS = \{([^}]*)\}/g)].map((match) => match[1]).join(',');
  const names = [...new Set([...maps.matchAll(/:\s*([A-Z][A-Za-z0-9]+)/g)].map((match) => match[1]))];
  assert.ok(names.length >= 12, names.join(', '));
  const block = hoverBlock();
  for (const name of names) {
    const cls = canonicalClass(icons[name]);
    const own = [...block.matchAll(/([^{}]*)\{([^}]*)\}/g)].filter(([, selector, body]) => selector.includes(':hover') && new RegExp(`\\.${cls}\\b`).test(selector) && !/translate: none;\s*$/.test(body.trim()) && body.trim() !== 'translate: none;');
    assert.ok(own.length, `${name} (${cls}) حرکتِ مخصوص ندارد`);
  }
});

test('تکهٔ آیکن که حرکت می‌کند واقعاً در SVGِ آن آیکن هست', () => {
  // اگر lucide ترتیب یا تعدادِ تکه‌ها را عوض کند، nth-child بی‌صدا به هیچ می‌خورد.
  const picks = [...hoverBlock().matchAll(/\.lucide-([a-z0-9-]+) > ([a-z]*):nth-(child|of-type)\((\d+)\)/g)];
  assert.ok(picks.length >= 15, `قاعدهٔ تکه‌ای: ${picks.length}`);
  for (const [, name, type, how, at] of picks) {
    const markup = renderToStaticMarkup(createElement(icons[pascal(name)], { size: 18 }));
    const children = [...markup.matchAll(/<(path|circle|rect|line|polyline|ellipse)\b/g)].map((match) => match[1]);
    const index = Number(at);
    const pool = how === 'of-type' ? children.filter((child) => child === type) : children;
    assert.ok(pool.length >= index, `lucide-${name}: تکهٔ ${type}:nth-${how}(${at}) نیست (${children.join(',')})`);
    if (how === 'child' && type) assert.equal(children[index - 1], type, `lucide-${name}: تکهٔ ${index} از نوع ${type} نیست`);
  }
});
