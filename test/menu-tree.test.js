import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CARD_SECTIONS, LEDGER_SECTIONS, MENU, SETTINGS_SECTIONS, findMenuItem, searchMenu, visibleMenu } from '../src/app/menu.js';
import { SCREENS, screensFor } from '../shared/experience.js';
import { profileDefinition } from '../shared/product.js';

/**
 * منوی درختی: هر قابلیت یک مقصد مستقیم.
 *
 * برگی که به صفحه یا زبانهٔ ناموجود اشاره کند، کلیکی است که هیچ‌جا نمی‌رود؛
 * صفحه‌ای که در منو نباشد، قابلیتی است که کسی پیدایش نمی‌کند.
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
    review: ['automation-policy'],
  };
  for (const { item } of leaves) {
    assert.ok(screens.has(item.screen), `${item.label}: صفحهٔ ${item.screen} وجود ندارد`);
    if (item.section) assert.ok(sections[item.screen]?.includes(item.section), `${item.label}: بخش ${item.section} در ${item.screen} نیست`);
  }
  // زبانه‌هایی که برگ‌ها به آن‌ها می‌روند، واقعاً در صفحه‌ها تعریف شده‌اند.
  assert.match(source('src/features/accounting/AccountingPage.jsx'), /'journals', 'trial', 'entry', 'worklist', 'payroll', 'period'/);
  assert.match(source('src/features/review/ReviewQueuePage.jsx'), /id="automation-policy"/);
  for (const card of Object.values(CARD_SECTIONS)) assert.match(source('src/features/counterparty/AccountCardsPanel.jsx'), new RegExp(`section === '${card}'`));
});

test('هر صفحهٔ قابل دیدن دست‌کم یک برگ دارد و هیچ برگی تکراری نیست', () => {
  // «یادگیری‌ها» زبانهٔ تنظیمات است ولی با مجوز صفحهٔ خودش؛ همان هم شمرده می‌شود.
  const inMenu = new Set(leaves.flatMap(({ item }) => [item.screen, item.requires].filter(Boolean)));
  for (const screen of SCREENS.filter((item) => !item.hidden)) assert.ok(inMenu.has(screen.id), `صفحهٔ ${screen.id} در منو نیست`);
  const keys = leaves.map(({ item }) => `${item.screen}/${item.section || ''}`);
  assert.equal(new Set(keys).size, keys.length, 'دو برگ به یک مقصد می‌روند');
});

test('منو فقط صفحه‌های مجاز و زبانه‌های همان نوع پرونده را نشان می‌دهد', () => {
  const owner = visibleMenu(screensFor({ role: 'owner', experience: 'simple' }), { ledgerTabs: profileDefinition('business').ledgerTabs });
  const ownerScreens = new Set(owner.flatMap((group) => group.items.map((item) => item.screen)));
  assert.ok(!ownerScreens.has('accounting') && !ownerScreens.has('chart'), 'تجربهٔ ساده کدینگ و اسناد نمی‌بیند');
  assert.ok(owner.every((group) => group.items.length), 'گروه خالی نمایش داده نمی‌شود');

  const accountant = visibleMenu(screensFor({ role: 'accountant', experience: 'professional' }), { ledgerTabs: profileDefinition('business').ledgerTabs });
  assert.ok(accountant.some((group) => group.items.some((item) => item.section === 'trial')), 'حسابدار تراز آزمایشی را در منو دارد');

  const personal = visibleMenu(screensFor({ role: 'owner', experience: 'simple', profileType: 'personal' }), { ledgerTabs: profileDefinition('personal').ledgerTabs });
  assert.ok(!personal.some((group) => group.items.some((item) => item.section === 'invoices')), 'پروندهٔ شخصی فاکتور ندارد');
});

test('بخش‌های حذف‌شده در منو نیستند و یادگیری‌ها فقط با مجوز خودش در تنظیمات است', () => {
  assert.ok(!leaves.some(({ item }) => ['plan', 'pilot'].includes(item.section)), 'پلن و پایلوت حذف شده‌اند');
  assert.ok(!leaves.some(({ item }) => item.screen === 'learning'), 'یادگیری‌ها دیگر صفحهٔ جدا نیست');
  const owner = visibleMenu(screensFor({ role: 'owner', experience: 'simple' }));
  assert.ok(!owner.some((group) => group.items.some((item) => item.section === 'learning')), 'بدون مجوز یادگیری، زبانه‌اش در منو نیست');
  const accountant = visibleMenu(screensFor({ role: 'accountant', experience: 'professional' }));
  assert.ok(accountant.some((group) => group.items.some((item) => item.section === 'learning')));
  const app = source('src/App.jsx');
  assert.doesNotMatch(app, /InsightRail/, 'نوار نبض نقدینگی حذف شده است');
  assert.doesNotMatch(source('src/features/settings/SettingsPage.jsx'), /محدوده محصول|دقت صوت و حریم خصوصی/);
});

test('جست‌وجو هر قابلیت را با نام یا واژهٔ هم‌معنا پیدا می‌کند', () => {
  const groups = visibleMenu(SCREENS.filter((screen) => !screen.hidden));
  const first = (query) => searchMenu(groups, query)[0]?.item;
  assert.equal(first('چک').section, 'obligations');
  assert.equal(first('تراز').section, 'trial');
  assert.equal(first('پشتیبان').section, 'backup');
  assert.equal(first('پارسیان').section, 'delivery');
  assert.equal(first('تنخواه').screen, 'petty-cash');
  assert.equal(first('كارت بانك').section, 'cards-banks', 'ی و ک عربی هم پیدا می‌شوند');
  assert.deepEqual(searchMenu(groups, 'چیزی که نیست'), []);
});

test('مسیر بالای صفحه برگ دقیق را پیدا می‌کند و برای بخش بی‌برگ به صفحه برمی‌گردد', () => {
  const groups = visibleMenu(SCREENS.filter((screen) => !screen.hidden));
  assert.equal(findMenuItem(groups, 'accounting', 'payroll').item.label, 'حقوق و دستمزد');
  assert.equal(findMenuItem(groups, 'review', '').item.label, 'صف بررسی حسابدار');
  assert.equal(findMenuItem(groups, 'report', 'runway').item.screen, 'report');
  assert.equal(findMenuItem(groups, 'nowhere', ''), null);
});
