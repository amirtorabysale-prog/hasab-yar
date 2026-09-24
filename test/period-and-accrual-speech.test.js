import test from 'node:test';
import assert from 'node:assert/strict';

import { readServicePeriod } from '../shared/periodSpeech.js';
import { readUnpaidSignal } from '../shared/accrualSpeech.js';
import { parseFinancialText } from '../shared/parser.js';

/**
 * دو واقعیتی که موتور تصمیم دارد ولی به آن نمی‌رسد.
 *
 * قاعده‌های چهار جهت زمانی ساخته و آزموده شدند، ولی دو سناریوی آزمون صوتی
 * همچنان «نامشخص» می‌مانند — چون پارسر دوره و نشانهٔ پرداخت‌نشدن را بیرون
 * نمی‌کشد. گلوگاه، استخراج است نه تصمیم.
 */

const OCCURRED = '2026-09-24T00:00:00.000Z';

// ---------------------------------------------------------------------------
// دورهٔ خدمت
// ---------------------------------------------------------------------------

test('«برای شش ماه جلوتر» یک دورهٔ شش‌ماهه می‌سازد', () => {
  const period = readServicePeriod('پونزده میلیون شارژ رو برای شش ماه جلوتر تسویه کردم', { occurredAt: OCCURRED });
  assert.ok(period, 'دوره باید تشخیص داده شود');
  assert.equal(period.months, 6);
  assert.equal(period.start, OCCURRED, 'شروع، همان تاریخ پرداخت است');
  assert.ok(period.end > period.start);
});

test('صفت دوره هم کافی است', () => {
  for (const [text, months] of [
    ['بیمه مسئولیت یک‌ساله رو پرداخت کردم', 12],
    ['قرارداد پشتیبانی شش ماهه بستیم', 6],
    ['اشتراک سه ماهه خریدم', 3],
    ['قرارداد دو ساله', 24],
  ]) {
    const period = readServicePeriod(text, { occurredAt: OCCURRED });
    assert.ok(period, `«${text}» باید دوره بدهد`);
    assert.equal(period.months, months, `«${text}»`);
  }
});

test('گذشته دوره نیست', () => {
  // «شش ماه پیش» یک زمان است، نه یک دورهٔ پوشش. اشتباه‌گرفتنشان یعنی هر
  // اشارهٔ زمانی به پیش‌پرداخت تبدیل می‌شود.
  for (const text of [
    'شش ماه پیش این رو خریدم',
    'سه ماه قبل پرداخت شد',
    'دو سال گذشته',
  ]) {
    assert.equal(readServicePeriod(text, { occurredAt: OCCURRED }), null, `«${text}» نباید دوره بدهد`);
  }
});

test('جملهٔ بدون اشارهٔ دوره‌ای، دوره نمی‌سازد', () => {
  for (const text of ['قبض برق رو سه میلیون دادم', 'حقوق پرسنل رو پرداخت کردم']) {
    assert.equal(readServicePeriod(text, { occurredAt: OCCURRED }), null);
  }
});

test('پایان دوره دقیقاً یک روز پیش از سررسید ماه پایانی است', () => {
  const period = readServicePeriod('بیمه یک‌ساله', { occurredAt: OCCURRED });
  const days = Math.round((new Date(period.end) - new Date(period.start)) / 86_400_000);
  assert.ok(days >= 360 && days <= 371, `طول دورهٔ یک‌ساله باید حدود یک سال باشد، شد ${days}`);
});

// ---------------------------------------------------------------------------
// نشانهٔ پرداخت‌نشدن
// ---------------------------------------------------------------------------

test('جمله‌ای که صریح می‌گوید هنوز پرداخت نشده', () => {
  for (const text of [
    'قبض برق اومده نه میلیون، موعد پرداختش هفته بعده',
    'فاکتورش رسیده ولی هنوز پرداخت نشده',
    'کار تموم شده ولی هنوز پولش رو ندادم',
    'سررسیدش ماه بعده',
  ]) {
    assert.equal(readUnpaidSignal(text), true, `«${text}» باید پرداخت‌نشده خوانده شود`);
  }
});

test('پرداخت انجام‌شده، نشانهٔ پرداخت‌نشدن ندارد', () => {
  for (const text of [
    'قبض برق رو سه میلیون پرداخت کردم',
    'نه میلیون دادم بابت قبض',
    'تسویه کردم',
  ]) {
    assert.equal(readUnpaidSignal(text), false, `«${text}» نباید پرداخت‌نشده خوانده شود`);
  }
});

test('«هنوز فاکتور نکرده» دربارهٔ فاکتور است، نه پرداخت', () => {
  // T006: «صد و بیست میلیون پیش‌پیش ریختیم... هنوز هیچی فاکتور نکرده» — پول
  // رفته. اشتباه‌گرفتنش یعنی یک پیش‌پرداخت انجام‌شده، بدهی ثبت می‌شود.
  assert.equal(readUnpaidSignal('صد و بیست میلیون پیش‌پیش ریختیم، هنوز هیچی فاکتور نکرده و بار نرسیده'), false);
});

// ---------------------------------------------------------------------------
// اتصال به پارسر
// ---------------------------------------------------------------------------

test('پارسر دوره را روی تراکنش می‌گذارد', () => {
  const [item] = parseFinancialText('پونزده میلیون شارژ ساختمان رو برای شش ماه جلوتر تسویه کردم', { source: 'voice' }).transactions;
  assert.ok(item.servicePeriodStart, 'شروع دوره');
  assert.ok(item.servicePeriodEnd, 'پایان دوره');
});

test('پارسر نشانهٔ پرداخت‌نشدن را روی تراکنش می‌گذارد', () => {
  const [item] = parseFinancialText('قبض برق و گاز کارگاه اومده نه میلیون، موعد پرداختش هفته بعده', { source: 'voice' }).transactions;
  assert.equal(item.unpaidSignal, true);
});
