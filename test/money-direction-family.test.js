import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFinancialText } from '../shared/parser.js';
import { runVoice } from './helpers/voicePipeline.js';

/**
 * جهت پول در مسیر بی‌AI — خانواده‌ای که محک دسته پیدا کرد (۲۳ مهر ۱۴۰۵).
 *
 * شش جملهٔ محک بی‌سؤال با جهت وارونه ثبت می‌شدند:
 * - «کلاس … برگزار کردیم … ثبت‌نام گرفتیم» و «شهریه … از شرکت‌کننده‌ها گرفتیم» هزینه
 *   شدند: «گرفتیم»ِ تنها عمداً دریافت نیست («پیتزا گرفتیم» خرید است)، و شرکت‌کننده
 *   پرداخت‌کنندهٔ شناخته‌شده نبود؛
 * - «پاداش فروش ویزیتورها» و «کتاب … برای فروش در کتاب‌فروشی» درآمد شدند، چون واژهٔ
 *   «فروش» در نام واحد، مبنای پاداش و نام مغازه هم بود؛
 * - «کرایه دستگاه به یه شرکت دیگه … گرفتیم» هزینهٔ حمل شد.
 *
 * نمونه‌های منفی: فروشِ واقعی، خرید از مغازه، شهریه و ثبت‌نامی که ما دادیم، و کرایه‌ای
 * که ما پرداختیم، جهتِ قبلی‌شان را نگه می‌دارند.
 */

const NOW = '2026-10-14T08:00:00.000Z';
const typeOf = (text) => parseFinancialText(text, { source: 'voice' }).transactions[0]?.type;
const voice = (text) => runVoice(text, { today: NOW }).items?.[0] || {};
const cashMoved = (item) => {
  const cash = (item.plan?.lines || []).find((line) => line.role === 'cash');
  return cash ? (cash.debit ? 'in' : 'out') : null;
};

test('شهریه و ثبت‌نامی که گرفتیم، و پولِ شرکت‌کننده و هنرجو، درآمد است', () => {
  for (const text of [
    'کلاس آموزش اکسل برگزار کردیم ۶ میلیون ثبت‌نام گرفتیم',
    'شهریه دورهٔ آموزشی ۹ میلیون از شرکت‌کننده‌ها گرفتیم',
    'از هنرجوها ۴ میلیون شهریه گرفتیم',
    'ورودیه همایش ۱۰ میلیون گرفتیم',
    'دانشجوها ۳ میلیون شهریه واریز کردن',
    'بیمار ۵۰۰ هزار تومن نقد داد',
  ]) {
    assert.equal(typeOf(text), 'income', text);
    const item = voice(text);
    if (item.outcome === 'post') assert.equal(cashMoved(item), 'in', text);
  }
  // جملهٔ محک: آموزشی که ما دادیم، درآمد خدمات است.
  assert.equal(parseFinancialText('کلاس آموزش اکسل برگزار کردیم ۶ میلیون ثبت‌نام گرفتیم', { source: 'voice' }).transactions[0].category, 'خدمات');
});

test('شهریه و ثبت‌نامی که ما دادیم، و هزینهٔ بیمارستان، همچنان هزینه است', () => {
  for (const text of [
    'شهریه دورهٔ آموزشی حسابدار ۴ میلیون دادیم',
    'ثبت‌نام همایش ۲ میلیون دادیم',
    'هزینه بیمارستان کارگر ۲ میلیون دادیم',
    'مشاوره گرفتیم ۳ میلیون',
  ]) {
    assert.equal(typeOf(text), 'expense', text);
  }
});

test('«فروش» در نام واحد، مبنای پاداش و نام مغازه نشانهٔ دریافت نیست', () => {
  for (const text of [
    'پاداش فروش ویزیتورها ۱۲ میلیون',
    'حقوق مدیر فروش ۲۵ میلیون دادیم',
    'پورسانت فروش بازاریاب ۳ میلیون دادیم',
    'کتاب آموزش آشپزی برای فروش در کتاب‌فروشی ۳ میلیون',
    'از کتاب‌فروشی ۲ میلیون کتاب خریدیم',
  ]) {
    assert.equal(typeOf(text), 'expense', text);
    assert.notEqual(cashMoved(voice(text)), 'in', text);
  }
  // «پاداش فروش ویزیتورها» حقوق است، و کتابِ «برای فروش» موجودی کالا.
  assert.equal(parseFinancialText('پاداش فروش ویزیتورها ۱۲ میلیون', { source: 'voice' }).transactions[0].category, 'حقوق و دستمزد');
  assert.ok(voice('کتاب آموزش آشپزی برای فروش در کتاب‌فروشی ۳ میلیون').plan.lines.some((line) => line.role === 'inventory-unsplit'));
});

test('نمونه‌های منفی: فروشِ واقعی و کمیسیونی که گرفتیم درآمد است', () => {
  for (const text of ['فروش امروز ۱۲ میلیون', '۵ میلیون فروش داشتیم', 'عمده فروشی کردیم ۵۰ میلیون', 'حق کمیسیون فروش از شرکت آلفا ۷ میلیون گرفتیم']) {
    assert.equal(typeOf(text), 'income', text);
  }
  assert.notEqual(parseFinancialText('حق کمیسیون فروش از شرکت آلفا ۷ میلیون گرفتیم', { source: 'voice' }).transactions[0].category, 'فروش');
});

test('کرایه‌ای که ما گرفتیم بی‌سؤال هزینهٔ حمل ثبت نمی‌شود؛ کرایه‌ای که دادیم هزینه است', () => {
  const taken = voice('کرایه دستگاه به یه شرکت دیگه ۵ میلیون گرفتیم');
  assert.notEqual(taken.outcome, 'post');
  for (const text of ['کرایه تاکسی ۱۵۰ هزار تومن', 'کرایه حمل بار ۲ میلیون دادیم']) {
    const item = voice(text);
    assert.equal(item.outcome, 'post', text);
    assert.equal(cashMoved(item), 'out', text);
  }
});
