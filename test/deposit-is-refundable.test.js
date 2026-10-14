import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionsPropertyDeposit, paymentPurposeFromSpeech, saysRefundable } from '../shared/moneyPurpose.js';
import { describeEvent } from '../shared/financialEvent.js';
import { ROLES } from '../shared/accountingRules.js';
import { runVoice } from './helpers/voicePipeline.js';

/**
 * ودیعه، رهن و پول پیش ملک — پولی که به حکم نامش برمی‌گردد.
 *
 * مالک محصول (مهر ۱۴۰۵): «سیستم هنوز ودیعه رو به‌عنوان اجاره تشخیص می‌ده و این
 * خیلی افتضاحه». برگه «پرداخت بابت اجاره» می‌نوشت و می‌پرسید «قابل استرداد است یا
 * مصرف می‌شود؟». تصمیم ۲۲ مهر ۱۴۰۵: نام ودیعه پرسش نمی‌خواهد. سؤال فقط وقتی می‌ماند
 * که جمله خودش خلاف بگوید (از اجاره کم می‌شود) یا واژه ودیعهٔ ملک نباشد (سپرده،
 * تضمین). برگشتِ ودیعه و ودیعهٔ دریافتی هم مسیر خودشان را دارند.
 */

const plan = (item) => (item.plan?.lines || []).map((line) => [line.role, line.debit || line.credit]);

test('خواننده: ودیعه، رهن و پول پیشِ ملک در هر شکل نوشتن، استرداد و هدف «ودیعه» را می‌گویند', () => {
  for (const text of [
    '۳۰ میلیون ودیعه دادیم',
    'ودیعهٔ دفتر رو دادیم',
    'ودیعه‌ی مغازه ۵۰ میلیون',
    'وديعه دفتر 50 ميليون داديم',
    'ودیعشو دادیم ۲۰ تومن',
    '۵۰ میلیون رهن مغازه به آقای کریمی دادیم',
    'رهنش رو کامل دادیم',
    'رهن و اجاره مغازه',
    '۳۰ میلیون پول پیش مغازه رو دادیم',
    'پول‌پیش خونه رو ریختیم برای صاحبخونه',
    'پولپیش دفتر ۴۰ میلیون',
  ]) {
    assert.equal(mentionsPropertyDeposit(text), true, text);
    assert.equal(saysRefundable(text), true, text);
    assert.equal(paymentPurposeFromSpeech(text), 'deposit', text);
  }
});

test('خواننده — منفی: رهنمود، وام رهنی، پول پیش شخص، سپرده و تضمین ودیعهٔ ملک نیستند', () => {
  for (const text of [
    'رهنمود حسابدار رو اجرا کردیم ۲ میلیون',
    'رهنما ۳ میلیون گرفت',
    'قسط وام رهنی ۱۰ میلیون دادیم',
    '۵ میلیون پول پیش حسابدار گذاشتیم',
    'پول پیش ما مونده ۲ میلیون',
    'سود سپرده ۲ میلیون واریز شد',
    '۱۰ میلیون سپرده حسن انجام کار دادیم',
    'تضمین ۲۰ میلیون دادیم',
  ]) {
    assert.equal(mentionsPropertyDeposit(text), false, text);
    assert.notEqual(paymentPurposeFromSpeech(text), 'deposit', text);
  }
  // «پس می‌گیریم» همان قاعدهٔ قبلی است، با هر نامی.
  assert.equal(saysRefundable('۲۰ میلیون سپرده دادیم که آخر قرارداد پس می‌گیریم'), true);
  assert.equal(saysRefundable('سپرده ۲۰ میلیون دادیم'), null);
});

test('خواننده — خلافِ نام: «غیرقابل استرداد» نه؛ «از اجاره کم می‌شه» پرسیده می‌شود؛ برگشتِ ودیعه ودیعهٔ تازه نیست', () => {
  assert.equal(saysRefundable('۱۰ میلیون ودیعه غیر قابل استرداد دادیم'), false);
  assert.equal(saysRefundable('ودیعه قابل استرداد نیست ۱۰ میلیون'), false);
  for (const text of ['۲۰ میلیون ودیعه دادیم که از اجاره ماهانه کم میشه', 'رهن رو تبدیل به اجاره کردیم ۵۰ میلیون', 'ودیعه رو جای اجاره سه ماه حساب کرد']) {
    assert.equal(saysRefundable(text), null, text);
    assert.equal(paymentPurposeFromSpeech(text), null, text);
  }
  for (const text of ['ودیعه مون رو صاحبخونه پس داد ۳۰ میلیون', 'ودیعه مستاجر رو پس دادیم ۲۰ میلیون', 'صاحبخونه رهن رو برگردوند']) {
    assert.equal(paymentPurposeFromSpeech(text), null, text);
  }
});

test('مسیر بی‌AI: جملهٔ واقعی «۳۰ میلیون ودیعه و ۶ میلیون اجاره» — ودیعهٔ قابل استرداد بی‌سؤال، اجاره جدا', () => {
  const [deposit, rent] = runVoice('۳۰ میلیون ودیعه و ۶ میلیون اجاره به صاحبخونه دادیم').items;
  assert.equal(deposit.outcome, 'post');
  assert.deepEqual(plan(deposit), [[ROLES.REFUNDABLE_DEPOSIT, 30_000_000], [ROLES.CASH, 30_000_000]]);
  assert.match(deposit.routing.summary, /^پرداخت ودیعه \(قابل استرداد\)/);
  assert.doesNotMatch(deposit.routing.summary, /اجاره/);
  assert.equal(rent.amount, 6_000_000);
  assert.notEqual(rent.fact, 'refundable', 'اجاره ودیعه نمی‌شود');

  // اجارهٔ همین ماه کنار ودیعه: هزینهٔ همین دوره، بی‌سؤال.
  const [, thisMonth] = runVoice('برای دفتر جدید ۳۰ میلیون ودیعه و ۶ میلیون اجاره همین ماه به صاحبخانه دادیم').items;
  assert.equal(thisMonth.outcome, 'post');
  assert.equal(thisMonth.plan.lines.some((line) => line.role === ROLES.REFUNDABLE_DEPOSIT), false);
});

test('مسیر بی‌AI: رهن و پول پیش با نام صاحبخانه ثبت می‌شوند؛ بی‌نام، فقط نام پرسیده می‌شود', () => {
  for (const [text, amount] of [
    ['۵۰ میلیون رهن مغازه به آقای کریمی دادیم', 50_000_000],
    ['پول پیش مغازه ۸۰ میلیون به آقای کریمی دادیم', 80_000_000],
    ['وديعه دفتر 40 ميليون به آقاي كريمي داديم', 40_000_000],
  ]) {
    const [item] = runVoice(text).items;
    assert.equal(item.outcome, 'post', text);
    assert.deepEqual(plan(item), [[ROLES.REFUNDABLE_DEPOSIT, amount], [ROLES.CASH, amount]], text);
  }
  for (const text of ['ودیعه اجاره دفتر ۵۰ میلیون دادیم', '۳۰ میلیون پول پیش مغازه رو دادیم']) {
    const [item] = runVoice(text).items;
    assert.deepEqual([item.outcome, item.fact], ['ask', 'counterparty'], text);
  }
});

test('مسیر بی‌AI — منفی: ودیعه‌ای که از اجاره کم می‌شود می‌پرسد؛ دریافتی و برگشتی به حسابدار؛ پول پیش شخص ودیعه نیست', () => {
  assert.deepEqual(runVoice('۲۰ میلیون ودیعه دادیم که از اجاره ماهانه کم میشه').items.map((item) => item.fact), ['refundable']);
  for (const text of ['مستاجر ۲۰ میلیون ودیعه داد ریخت به ملت', 'ودیعه مون رو صاحبخونه پس داد ۳۰ میلیون', 'ودیعه مستاجر رو پس دادیم ۲۰ میلیون از ملت']) {
    assert.deepEqual(runVoice(text).items.map((item) => item.outcome), ['accountant'], text);
  }
  const [held] = runVoice('۵ میلیون پول پیش حسابدار گذاشتیم').items;
  assert.equal(held.plan?.lines?.some((line) => line.role === ROLES.REFUNDABLE_DEPOSIT) || false, false);
});

test('خلاصهٔ رویداد: ودیعه «پرداخت ودیعه» است، نه «پرداخت بابت اجاره»', () => {
  assert.equal(describeEvent({ kind: 'cash-expense', category: 'اجاره', paymentPurpose: 'deposit', refundable: true }), 'پرداخت ودیعه (قابل استرداد)');
  assert.equal(describeEvent({ kind: 'cash-expense', category: 'اجاره', paymentPurpose: 'deposit', refundable: null }), 'پرداخت ودیعه');
  assert.equal(describeEvent({ kind: 'cash-expense', category: 'اجاره', paymentPurpose: null }), 'پرداخت بابت اجاره');
});
