import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPERIENCES, SCREENS, canChooseExperience, canSeeScreen, experienceForRole, pathNeedsProfessional, screensFor,
} from '../shared/experience.js';

// نردبان نقش برای «اجازه» درست است ولی برای «چه ببیند» وارونه: صاحب کسب‌وکار
// بالاترین رتبه را دارد و در نتیجه کدینگ و کارتابل سند را هم می‌دید.
test('تجربهٔ پیش‌فرض از نقش می‌آید، نه از رتبه', () => {
  assert.equal(experienceForRole('owner'), EXPERIENCES.SIMPLE);
  assert.equal(experienceForRole('viewer'), EXPERIENCES.SIMPLE);
  assert.equal(experienceForRole('accountant'), EXPERIENCES.PROFESSIONAL);
  assert.equal(experienceForRole('manager'), EXPERIENCES.PROFESSIONAL);
});

test('مالک می‌تواند به محیط حرفه‌ای سوییچ کند', () => {
  assert.equal(experienceForRole('owner', EXPERIENCES.PROFESSIONAL), EXPERIENCES.PROFESSIONAL);
  assert.equal(canChooseExperience('owner'), true);
});

// ابزار کار حسابدار در محیط ساده وجود ندارد؛ فرستادنش آنجا یعنی بی‌ابزار شدن.
test('حسابدار نمی‌تواند به محیط ساده برود', () => {
  assert.equal(experienceForRole('accountant', EXPERIENCES.SIMPLE), EXPERIENCES.PROFESSIONAL);
  assert.equal(experienceForRole('manager', EXPERIENCES.SIMPLE), EXPERIENCES.PROFESSIONAL);
  assert.equal(canChooseExperience('accountant'), false);
});

test('ترجیح نامعتبر به پیش‌فرض برمی‌گردد', () => {
  assert.equal(experienceForRole('owner', 'چیز عجیب'), EXPERIENCES.SIMPLE);
  assert.equal(experienceForRole('owner', null), EXPERIENCES.SIMPLE);
  assert.equal(experienceForRole('نقش ناشناخته'), EXPERIENCES.SIMPLE);
});

// ------------------------------------------------------------------ صفحه‌ها

const simpleOwner = { role: 'owner', experience: EXPERIENCES.SIMPLE, profileType: 'business' };
const proAccountant = { role: 'accountant', experience: EXPERIENCES.PROFESSIONAL, profileType: 'business' };

test('کاربر ساده فقط چند صفحهٔ روزمره می‌بیند', () => {
  const ids = screensFor(simpleOwner).map((screen) => screen.id);
  // تنخواه‌گردان کار روزمرهٔ هر کسب‌وکار است، نه ابزار حسابدار (مهر ۱۴۰۵).
  assert.deepEqual(ids.sort(), ['ledger', 'petty-cash', 'report', 'settings', 'today'].sort());
});

test('تنخواه‌گردان فقط در پروندهٔ کسب‌وکار است', () => {
  assert.equal(canSeeScreen('petty-cash', simpleOwner), true);
  assert.equal(canSeeScreen('petty-cash', { ...simpleOwner, profileType: 'personal' }), false);
});

// این‌ها همان چیزهایی‌اند که کاربر عادی نباید ببیند.
test('کدینگ، کارتابل سند و صف بررسی در محیط ساده نیستند', () => {
  for (const screen of ['chart', 'accounting', 'review', 'collaboration', 'tax', 'learning', 'firm']) {
    assert.equal(canSeeScreen(screen, simpleOwner), false, `${screen} نباید در محیط ساده دیده شود`);
  }
});

test('حسابدار محیط حرفه‌ای کامل می‌بیند', () => {
  const ids = screensFor(proAccountant).map((screen) => screen.id);
  for (const screen of ['today', 'ledger', 'report', 'firm', 'review', 'accounting', 'collaboration']) {
    assert.ok(ids.includes(screen), `${screen} باید برای حسابدار باشد`);
  }
});

/**
 * مالیات فعلاً پنهان است، نه حذف.
 *
 * صفحه و مسیرهای سرورش سر جایشان‌اند و آزمون‌هایشان هم اجرا می‌شوند؛ فقط از
 * ناوبری بیرون است. این آزمون هر دو نیمه را نگه می‌دارد: نه دیده می‌شود، و
 * نه تعریفش گم شده — تا برگرداندنش یک پرچم باشد، نه بازنویسی.
 */
test('مالیات پنهان است ولی تعریفش سر جایش مانده', () => {
  assert.equal(canSeeScreen('tax', proAccountant), false, 'نباید در ناوبری باشد');
  assert.ok(SCREENS.some((screen) => screen.id === 'tax' && screen.hidden), 'ولی تعریفش باید بماند');
});

// رتبه و تجربه دو شرط مستقل‌اند و هر دو باید برقرار باشند.
test('تجربهٔ حرفه‌ای رتبهٔ ناکافی را جبران نمی‌کند', () => {
  const proViewer = { role: 'viewer', experience: EXPERIENCES.PROFESSIONAL, profileType: 'business' };
  assert.equal(canSeeScreen('chart', proViewer), false, 'کدینگ کار مدیر است');
  assert.equal(canSeeScreen('review', proViewer), false, 'صف بررسی کار حسابدار است');
  assert.equal(canSeeScreen('today', proViewer), true);
});

test('کدینگ کار مدیر است، نه هر حسابداری', () => {
  assert.equal(canSeeScreen('chart', proAccountant), false);
  assert.equal(canSeeScreen('chart', { role: 'manager', experience: EXPERIENCES.PROFESSIONAL, profileType: 'business' }), true);
});

test('پروندهٔ شخصی صفحه‌های کسب‌وکاری ندارد', () => {
  const personal = { role: 'manager', experience: EXPERIENCES.PROFESSIONAL, profileType: 'personal' };
  for (const screen of ['chart', 'accounting', 'tax', 'collaboration']) {
    assert.equal(canSeeScreen(screen, personal), false, screen);
  }
  assert.equal(canSeeScreen('today', personal), true);
});

test('هر صفحه دست‌کم یک صفحهٔ اصلی برای ناوبری دارد', () => {
  for (const context of [simpleOwner, proAccountant]) {
    assert.ok(screensFor(context).some((screen) => screen.primary), 'ناوبری بدون صفحهٔ اصلی خالی می‌ماند');
  }
});

// ---------------------------------------------------------------- مرز سرور

// مخفی‌کردن منو امنیت نیست: کسی که آدرس را بداند همچنان صدا می‌زند.
test('مسیرهای ابزار حسابدار در سرور هم علامت خورده‌اند', () => {
  for (const path of ['/accounting/journal', '/chart/accounts', '/financial-events/review-queue',
    '/reconciliation/imports', '/accountant-transfer/package', '/collaboration/requests',
    '/tax/rates', '/learnings', '/fixed-assets', '/import/analytics']) {
    assert.equal(pathNeedsProfessional(path), true, path);
  }
});

// دادهٔ پایه‌ای که تجربهٔ ساده هم لازم دارد نباید بسته شود، وگرنه کاربر عادی
// حتی نمی‌تواند چیزی ثبت کند.
test('مسیرهای پایه برای تجربهٔ ساده باز می‌مانند', () => {
  for (const path of ['/bootstrap', '/transactions', '/parse/audio', '/parse/text',
    '/obligations', '/contacts', '/auth/status', '/voice/status', '/reports']) {
    assert.equal(pathNeedsProfessional(path), false, path);
  }
});

// «/accountingsomething» نباید با «/accounting» اشتباه گرفته شود.
test('تطبیق مسیر روی مرز بخش انجام می‌شود، نه پیشوند خام', () => {
  assert.equal(pathNeedsProfessional('/accounting'), true);
  assert.equal(pathNeedsProfessional('/accounting/periods'), true);
  assert.equal(pathNeedsProfessional('/accountingx'), false);
  assert.equal(pathNeedsProfessional('/charts-of-something'), false);
  assert.equal(pathNeedsProfessional(''), false);
});

// ------------------------------------- هم‌خوانی مرز سرور با فهرست ناوبری

import { minimumRoleForRequest } from '../server/access.js';

/**
 * مرز سرور و فهرست صفحه‌ها نباید از هم جدا بیفتند.
 *
 * اگر صفحه‌ای در ناوبری باشد ولی مسیرهایش در سرور بسته، کاربر صفحه‌ای می‌بیند
 * که همهٔ درخواست‌هایش ۴۰۳ می‌گیرد. و اگر برعکس باشد، منو مخفی است ولی آدرس
 * مستقیم کار می‌کند — یعنی امنیتی در کار نیست.
 */
test('هر صفحهٔ حرفه‌ای، مسیر سروری بسته‌ای دارد', () => {
  const professionalScreens = screensFor({ role: 'manager', experience: EXPERIENCES.PROFESSIONAL, profileType: 'business' })
    .filter((screen) => !screen.experiences.includes(EXPERIENCES.SIMPLE));
  const paths = {
    firm: '/firm/portfolio',
    review: '/financial-events/review-queue',
    accounting: '/accounting/journal',
    'accounting-reports': '/accounting/reports/trial',
    chart: '/chart/accounts',
    tax: '/tax/rates',
    collaboration: '/collaboration/requests',
    dna: '/financial-dna',
    learning: '/learnings',
  };
  for (const screen of professionalScreens) {
    const path = paths[screen.id];
    assert.ok(path, `برای صفحهٔ ${screen.id} مسیری در این آزمون تعریف نشده`);
    // میز کار دفتر عمداً باز است: خروجی‌اش به عضویت‌های خود کاربر محدود است.
    if (screen.id === 'firm') continue;
    assert.equal(pathNeedsProfessional(path), true, `${screen.id} باید در سرور هم بسته باشد`);
  }
});

test('صفحه‌های تجربهٔ ساده هیچ‌کدام در سرور بسته نیستند', () => {
  const simpleScreens = screensFor({ role: 'owner', experience: EXPERIENCES.SIMPLE, profileType: 'business' });
  const paths = { today: '/bootstrap', ledger: '/transactions', report: '/reports', settings: '/settings' };
  for (const screen of simpleScreens) {
    assert.equal(pathNeedsProfessional(paths[screen.id]), false, `${screen.id} برای کاربر ساده باید باز بماند`);
  }
});

// رتبه و تجربه دو کنترل مستقل‌اند و هیچ‌کدام جای دیگری را نمی‌گیرد.
test('کنترل رتبه و کنترل تجربه هر دو لازم‌اند', () => {
  // مالک رتبه‌اش از همه بالاتر است، پس کنترل رتبه‌ای جلویش را نمی‌گیرد.
  assert.equal(minimumRoleForRequest('GET', '/chart/accounts'), 'viewer');
  assert.equal(minimumRoleForRequest('POST', '/chart/accounts'), 'manager');
  // چیزی که جلوی مالکِ سادهٔ را می‌گیرد، همین مرز تجربه است.
  assert.equal(pathNeedsProfessional('/chart/accounts'), true);
});
