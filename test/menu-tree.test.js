import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CARD_SECTIONS, LEDGER_SECTIONS, MENU, SETTINGS_REQUIRES, SETTINGS_SECTIONS, findMenuItem, searchMenu, visibleMenu } from '../src/app/menu.js';
import { SCREENS, screensFor } from '../shared/experience.js';
import { profileDefinition } from '../shared/product.js';

/**
 * منوی تخت: هر صفحه یک مقصد؛ زبانه‌های بالای صفحه جای تکرار در سایدبار را
 * گرفته‌اند. برگی که به صفحه یا زبانهٔ ناموجود اشاره کند، کلیکی است که هیچ‌جا
 * نمی‌رود؛ صفحه‌ای که در منو نباشد، قابلیتی است که کسی پیدایش نمی‌کند.
 */
const leaves = MENU.flatMap((group) => group.items.map((item) => ({ group, item })));
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('هر برگ به صفحهٔ واقعی و زبانهٔ واقعی همان صفحه می‌رود', () => {
  const screens = new Set(SCREENS.map((screen) => screen.id));
  const sections = {
    ledger: Object.keys(LEDGER_SECTIONS),
    accounting: ['journals', 'trial', 'entry', 'worklist', 'payroll', 'period'],
    chart: ['mapping', 'chart', 'dimensions', 'import'],
    collaboration: ['delivery', 'dna', 'questions'],
    settings: SETTINGS_SECTIONS.map(([id]) => id),
  };
  for (const { item } of leaves) {
    assert.ok(screens.has(item.screen), `${item.label}: صفحهٔ ${item.screen} وجود ندارد`);
    if (item.section) assert.ok(sections[item.screen]?.includes(item.section), `${item.label}: بخش ${item.section} در ${item.screen} نیست`);
  }
  // زبانه‌هایی که نوار بالای صفحه‌ها می‌سازد، واقعاً در همان صفحه‌ها تعریف شده‌اند.
  assert.match(source('src/features/accounting/AccountingPage.jsx'), /'journals', 'trial', 'entry', 'worklist', 'payroll', 'period'/);
  for (const card of Object.values(CARD_SECTIONS)) assert.match(source('src/features/counterparty/AccountCardsPanel.jsx'), new RegExp(`section === '${card}'`));
});

test('هر صفحهٔ قابل دیدن دست‌کم یک مقصد دارد و هیچ برگ تکراری نیست', () => {
  const inMenu = new Set(leaves.flatMap(({ item }) => [item.screen, item.requires].filter(Boolean)));
  // «یادگیری‌ها» برگ منو ندارد؛ زبانهٔ تنظیمات است و با مجوز خودش در نوار تنظیمات می‌آید.
  assert.equal(SETTINGS_REQUIRES.learning, 'learning');
  inMenu.add('learning');
  for (const screen of SCREENS.filter((item) => !item.hidden)) assert.ok(inMenu.has(screen.id), `صفحهٔ ${screen.id} در منو نیست`);
  const keys = leaves.map(({ item }) => `${item.screen}/${item.section || ''}`);
  assert.equal(new Set(keys).size, keys.length, 'دو برگ به یک مقصد می‌روند');
});

test('منو فقط صفحه‌های مجاز را نشان می‌دهد', () => {
  const owner = visibleMenu(screensFor({ role: 'owner', experience: 'simple' }), { ledgerTabs: profileDefinition('business').ledgerTabs });
  const ownerScreens = new Set(owner.flatMap((group) => group.items.map((item) => item.screen)));
  assert.ok(!ownerScreens.has('accounting') && !ownerScreens.has('chart') && !ownerScreens.has('review'), 'تجربهٔ ساده اسناد، کدینگ و صف حسابدار نمی‌بیند');
  assert.ok(owner.every((group) => group.items.length), 'گروه خالی نمایش داده نمی‌شود');

  const accountant = visibleMenu(screensFor({ role: 'accountant', experience: 'professional' }), { ledgerTabs: profileDefinition('business').ledgerTabs });
  assert.ok(accountant.some((group) => group.items.some((item) => item.screen === 'accounting')), 'حسابدار دفتر اسناد را در منو دارد');
  assert.ok(accountant.some((group) => group.id === 'review'), 'صف حسابدار بخش جداگانهٔ خودش را دارد');

  const personal = visibleMenu(screensFor({ role: 'owner', experience: 'simple', profileType: 'personal' }), { ledgerTabs: profileDefinition('personal').ledgerTabs });
  assert.ok(!personal.some((group) => group.items.some((item) => item.screen === 'petty-cash')), 'پروندهٔ شخصی تنخواه‌گردان ندارد');
});

test('بخش‌های حذف‌شده در منو نیستند و یادگیری‌ها فقط زبانهٔ تنظیمات است', () => {
  assert.ok(!leaves.some(({ item }) => ['plan', 'pilot'].includes(item.section)), 'پلن و پایلوت حذف شده‌اند');
  assert.ok(!leaves.some(({ item }) => item.screen === 'learning'), 'یادگیری‌ها دیگر صفحهٔ جدا نیست');
  const app = source('src/App.jsx');
  assert.match(app, /SETTINGS_REQUIRES\[id\]/, 'زبانهٔ یادگیری‌ها همچنان با مجوز خودش در تنظیمات گِیت می‌شود');
  assert.doesNotMatch(app, /InsightRail/, 'نوار نبض نقدینگی حذف شده است');
  assert.doesNotMatch(source('src/features/settings/SettingsPage.jsx'), /محدوده محصول|دقت صوت و حریم خصوصی/);
});

test('جست‌وجو هر قابلیت را با نام یا واژهٔ هم‌معنا پیدا می‌کند', () => {
  const groups = visibleMenu(SCREENS.filter((screen) => !screen.hidden));
  const first = (query) => searchMenu(groups, query)[0]?.item;
  assert.equal(first('چک').screen, 'ledger');
  assert.equal(first('تراز').screen, 'accounting');
  assert.equal(first('پشتیبان').screen, 'settings');
  assert.equal(first('پارسیان').section, 'delivery');
  assert.equal(first('تنخواه').screen, 'petty-cash');
  assert.equal(first('كارت بانك').screen, 'ledger', 'ی و ک عربی هم پیدا می‌شوند');
  assert.equal(first('قانون ثبت خودکار').screen, 'review', 'قانون ثبت خودکار در صف حسابدار پیدا می‌شود، نه به‌عنوان برگ منو');
  assert.deepEqual(searchMenu(groups, 'چیزی که نیست'), []);
});

test('مسیر بالای صفحه برگ صفحه را پیدا می‌کند و برای زبانهٔ بی‌برگ به همان صفحه برمی‌گردد', () => {
  const groups = visibleMenu(SCREENS.filter((screen) => !screen.hidden));
  assert.equal(findMenuItem(groups, 'accounting', 'payroll').item.label, 'دفتر اسناد');
  assert.equal(findMenuItem(groups, 'ledger', 'obligations').group.label, 'دریافت و پرداخت');
  assert.equal(findMenuItem(groups, 'review', '').item.label, 'صف بررسی');
  assert.equal(findMenuItem(groups, 'report', 'runway').item.screen, 'report');
  assert.equal(findMenuItem(groups, 'nowhere', ''), null);
});
