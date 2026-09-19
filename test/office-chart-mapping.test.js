import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestChartAccount } from '../server/chartOfAccounts.js';
import { parseFinancialText } from '../shared/parser.js';

/** کدینگ واقعی یک دفتر پارسیانی — از تراز معین ۵۰ و ۴۰ همان دفتر. */
const OFFICE_EXPENSES = [
  ['5001', 'بازاریاب'], ['5002', 'هزینه حقوق و دستمزد'], ['5003', 'هزینه استهلاک'],
  ['5004', 'هزینه آب و برق مصرفی'], ['5005', 'هزینه پست و تلفن'], ['5006', 'هزینه اجاره محل'],
  ['5007', 'هزینه ملزومات و نوشت افزار'], ['5008', 'هزینه های متفرقه'], ['5009', 'هزینه حمل'],
].map(([code, name]) => ({ id: code, code, name, level: 'subsidiary', type: 'expense', active: 1, postable: true, role: '' }));

const categoryAccount = (name, type = 'expense') => ({
  name, type, sourceKind: `${type}-category`, sourceKey: name,
});

/**
 * بدترین خطای نگاشت خودکار، در دفتر واقعی مشتری دیده شد.
 *
 * موتور پیشنهاد، وقتی کد دسته به کدینگ دفتر نمی‌خورد، «اولین معین هم‌نوع» را
 * برمی‌گرداند. در آن کدینگ، اولین معین کل ۵۰ «بازاریاب» بود؛ نتیجه این شد که
 * حقوق، اجاره، قبوض و حمل — ۱۹۳ میلیون تومان هزینه — همه روی «بازاریاب»
 * نشستند و در پارسیان هیچ‌کدام قابل تفکیک نبودند.
 */
test('هزینه‌ها روی اولین معین فهرست دفن نمی‌شوند', () => {
  for (const name of ['حقوق و دستمزد', 'اجاره', 'قبوض', 'خوراک', 'تبلیغات و بازاریابی']) {
    const suggestion = suggestChartAccount(categoryAccount(name), OFFICE_EXPENSES);
    assert.notEqual(suggestion?.code, '5001', `«${name}» نباید روی «بازاریاب» بنشیند`);
  }
});

test('نام حساب، معین درست دفتر را پیدا می‌کند', () => {
  const byName = (name) => suggestChartAccount(categoryAccount(name), OFFICE_EXPENSES)?.code;
  assert.equal(byName('حقوق و دستمزد'), '5002');
  assert.equal(byName('اجاره'), '5006');
  assert.equal(byName('حمل‌ونقل'), '5009');
  assert.equal(byName('ملزومات اداری'), '5007');
  assert.equal(byName('استهلاک'), '5003');
});

// نبودِ پیشنهاد بهتر از پیشنهاد غلط است: حساب بدون نگاشت در فهرست دیده می‌شود
// و حسابدار خودش انتخاب می‌کند.
test('وقتی نامی نمی‌خورد، هیچ پیشنهادی داده نمی‌شود', () => {
  assert.equal(suggestChartAccount(categoryAccount('خوراک'), OFFICE_EXPENSES), null);
});

// دو معین با امتیاز برابر یعنی نام‌ها روشن نیستند؛ انتخاب یکی سکه انداختن است.
test('دو نامزد هم‌امتیاز، پیشنهادی نمی‌سازند', () => {
  const chart = [...OFFICE_EXPENSES,
    { id: '50200', code: '50200', name: 'هزینه بهره بانکی', level: 'subsidiary', type: 'expense', active: 1, postable: true, role: '' },
    { id: '50300', code: '50300', name: 'هزینه کارمزد بانک', level: 'subsidiary', type: 'expense', active: 1, postable: true, role: '' }];
  assert.equal(suggestChartAccount(categoryAccount('کارمزد بانکی'), chart), null);
});

/**
 * «۲۰۰ میلیون افزایش سرمایه آقای حیدری» در دفتر مشتری به‌عنوان درآمد ثبت شده
 * بود. آورده درآمد نیست: سود دوره به همان اندازه باد می‌کند و مالیات روی پول
 * خودِ مالک حساب می‌شود.
 */
test('جملهٔ آوردهٔ سرمایه هرگز بی‌پرسش ثبت نمی‌شود', () => {
  const [item] = parseFinancialText('۲۰۰ میلیون تومان افزایش سرمایه آقای حیدری', { source: 'voice' }).transactions;
  assert.equal(item.needsReview, true);
  assert.ok(item.reviewReasons.some((reason) => reason.includes('آورده')), item.reviewReasons.join(' | '));
});

test('جملهٔ دارایی ثابت هم همین‌طور', () => {
  const [item] = parseFinancialText('۵۰ میلیون تومان دارایی ثابت خریدم', { source: 'voice' }).transactions;
  assert.equal(item.needsReview, true);
  assert.ok(item.reviewReasons.some((reason) => reason.includes('دارایی ثابت')));
});

test('ثبت عادی بی‌دلیل به بررسی نمی‌رود', () => {
  const [item] = parseFinancialText('۵۰۰ هزار تومان قبض برق دادم', { source: 'text' }).transactions;
  assert.equal(item.needsReview, false);
});
