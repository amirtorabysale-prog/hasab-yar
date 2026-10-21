import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { MENU, visibleMenu } from '../src/app/menu.js';
import { SCREENS, screensFor } from '../shared/experience.js';
import { profileDefinition } from '../shared/product.js';

/**
 * DNA مالی بخشِ جدای منو با نمادِ متحرکِ مالک محصول (۲۹ مهر ۱۴۰۵): «بخش DNA را یک بخش جدا در
 * دسته‌بندی قرار بده و داخلش از انیمیت استفاده کن.» نماد از تختهٔ «نماد DNA — متحرک»: پله‌ها با
 * scaleX جمع و باز می‌شوند و لایهٔ جلو هنگام عبور از محور محو می‌شود.
 */
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const render = async (path, name, props) => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try { return renderToStaticMarkup(React.createElement((await vite.ssrLoadModule(path))[name], props)); } finally { await vite.close(); }
};

test('DNA مالی صفحه و گروهِ منوی خودش را دارد؛ فقط حرفه‌ای، حسابدار به بالا، پروندهٔ کسب‌وکار', () => {
  const dna = SCREENS.find((screen) => screen.id === 'dna');
  assert.deepEqual([dna.label, dna.icon, dna.minimumRole, dna.experiences], ['DNA مالی', 'dna', 'accountant', ['professional']]);
  const group = MENU.find((item) => item.id === 'dna');
  assert.deepEqual(group.items.map((item) => item.screen), ['dna']);
  assert.match(group.items[0].keywords, /اثر انگشت/);
  const ledgerTabs = profileDefinition('business').ledgerTabs;
  assert.ok(visibleMenu(screensFor({ role: 'accountant', experience: 'professional' }), { ledgerTabs }).some((item) => item.id === 'dna'));
  assert.ok(!visibleMenu(screensFor({ role: 'viewer', experience: 'professional' }), { ledgerTabs }).some((item) => item.id === 'dna'), 'فقط‌مشاهده نمی‌بیند');
  assert.ok(!visibleMenu(screensFor({ role: 'owner', experience: 'simple' }), { ledgerTabs }).some((item) => item.id === 'dna'), 'تجربهٔ ساده نمی‌بیند');
  assert.ok(!screensFor({ role: 'owner', experience: 'professional', profileType: 'personal' }).some((screen) => screen.id === 'dna'), 'پروندهٔ شخصی نمی‌بیند');
  // دیگر برگهٔ «همکاری با حسابدار» نیست؛ نشانیِ قدیمی به صفحهٔ تازه می‌رود.
  const collaboration = source('src/features/collaboration/CollaborationPage.jsx');
  assert.doesNotMatch(collaboration, /\['dna', 'DNA مالی'\]/);
  assert.match(collaboration, /initialTab === 'dna'[^\n]*navigate\('dna'\)/);
  assert.doesNotMatch(MENU.find((item) => item.id === 'collaboration').items[0].keywords, /DNA/);
});

test('App صفحه را تنبل بار می‌کند؛ منو نمادِ مارپیچ را جدا از آیکن‌های lucide می‌گیرد', () => {
  const app = source('src/App.jsx');
  assert.match(app, /const DnaPage = namedLazy\(\(\) => import\('\.\/features\/dna\/DnaPage\.jsx'\), 'DnaPage'\);/);
  assert.match(app, /screen === 'dna' && data\.settings\.profileType === 'business' && <DnaPage notify=\{notify\} \/>/);
  const navigation = source('src/app/navigation.jsx');
  assert.match(navigation, /const CUSTOM_ICONS = \{ dna: DnaIcon \};/);
  assert.match(navigation, /CUSTOM_ICONS\[group\.icon\] \|\| GROUP_ICONS\[group\.icon\] \|\| Home/);
  assert.doesNotMatch(navigation.match(/const SCREEN_ICONS = \{[^}]*\}/)[0], /dna/, 'جدولِ lucide فقط نام lucide دارد');
});

test('نماد: سرصفحه هفت پله با نام دسترس‌پذیر؛ منو چهار پله و پنهان از صفحه‌خوان', async () => {
  const hero = await render('/src/components/DnaHelix.jsx', 'DnaHelix', { variant: 'hero', size: 72, label: 'نماد DNA مالی' });
  assert.match(hero, /role="img" aria-label="نماد DNA مالی"/);
  assert.equal(hero.match(/class="dna-rung"/g).length, 7);
  const menu = await render('/src/components/DnaHelix.jsx', 'DnaIcon', { size: 18 });
  assert.match(menu, /aria-hidden="true"/);
  assert.equal(menu.match(/class="dna-rung"/g).length, 4);
  const page = await render('/src/features/dna/DnaPage.jsx', 'DnaPage', { notify() {} });
  assert.match(page, /<h1[^>]*>DNA مالی<\/h1>/);
  assert.match(page, /class="dna-hero-tile/);
});

test('حرکت: فقط transform و opacity؛ سرصفحه سه دور و ایست؛ منو فقط با hover؛ «کاهش حرکت» خاموش', () => {
  const css = source('src/styles.css');
  assert.match(css, /@keyframes dna-turn \{ 0%, 50%, 100% \{ transform: scaleX\(1\); \} 25%, 75% \{ transform: scaleX\(\.08\); \} \}/);
  assert.match(css, /@keyframes dna-depth \{[^}]*opacity[^@]*\}/);
  // فریم‌های کلیدی فقط transform، opacity و translate دارند؛ هیچ ویژگی چیدمانی.
  for (const frames of css.match(/@keyframes dna-[a-z]+ \{.*\}/g)) {
    assert.doesNotMatch(frames.replace(/\b(?:transform|opacity|translate):/g, ''), /[a-z-]+:/, frames);
  }
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.dna-hero \.dna-rung \{ animation: dna-turn var\(--spin, 3\.2s\) linear 3;/);
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) and \(prefers-reduced-motion: no-preference\) \{\s*:is\(\.menu-group, \.menu-leaf, button, a\[href\]\):hover \.dna-menu \.dna-rung/);
  assert.doesNotMatch(css, /^\s*\.dna-menu \.dna-rung \{ animation/m, 'نمادِ منو بی hover ساکن است');
});
