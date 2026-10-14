import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
import { runVoice } from './helpers/voicePipeline.js';
import { readServiceLength, readServicePeriod, maskCoveragePhrases } from '../shared/periodSpeech.js';
import { extractOccurrenceDate, persianPeriodEnd, persianToISO, todayPersian } from '../shared/persianDate.js';
import { applyAnswer } from '../shared/questionAnswer.js';
import { parseFinancialText } from '../shared/parser.js';
import { buildMonthlySchedule } from '../shared/recognitionSchedule.js';
import { transactionEventDecision } from '../server/transactionEvent.js';
import { ROLES } from '../shared/accountingRules.js';

/**
 * موتور ۵، بستهٔ دوره: خواندن دورهٔ پوشش از جمله و از جواب سؤال.
 *
 * پیش‌پرداخت خدمتِ دوره‌دار فقط وقتی درست ثبت می‌شود که دوره درست خوانده شود:
 * یک سالِ غلط برنامهٔ هزینه را پنجاه سال جلو می‌برد، یک شروعِ نادیده نیمی از
 * پوشش گذشته را به آینده هل می‌دهد، و یک «سه ماه» که دو ماه شود هزینهٔ یک ماه را
 * گم می‌کند. هر بخش یک خانواده است: جملهٔ واقعی کاربر عیناً، شکل‌های هم‌ارز، و
 * نمونه‌های منفی که نباید وارد مسیر شوند.
 *
 * امروز در همهٔ آزمون‌ها ۱۸ مهر ۱۴۰۵ است.
 */
const NOW = '2026-10-10T08:30:00.000Z';
const fa = (iso) => {
  if (!iso) return null;
  const { year, month, day } = todayPersian(new Date(iso));
  return `${year}/${month}/${day}`;
};
const period = (text, options = {}) => {
  const found = readServicePeriod(text, { occurredAt: NOW, ...options });
  return found ? [fa(found.start), fa(found.end)] : null;
};
const parsed = (text) => parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions;
const voice = (text) => runVoice(text, { today: NOW });
const roles = (item) => (item.plan?.lines || []).map((line) => [line.role, line.debit || line.credit]);
const TODAY = fa(NOW);

// ---------------------------------------------------------------------------
// range-year-reads-amount — عدد بعد از ماهِ پایان، سال نیست وقتی واحد دارد
// ---------------------------------------------------------------------------

test('سالِ بازه: مبلغ دورقمی بعد از ماه پایان، سال خوانده نمی‌شود (جمله‌های کاربر)', () => {
  for (const [text, expected] of [
    ['اجاره دفتر از مهر تا اسفند ۶۰ میلیون پرداخت شد', ['1405/7/1', '1405/12/29']],
    ['بیمه آتش سوزی از اول فروردین تا آخر اسفند ۱۲ میلیون دادیم', ['1405/1/1', '1405/12/29']],
    ['بیمه انبار از آبان تا مهر ۲۴ میلیون دادیم', ['1405/8/1', '1406/7/30']],
    ['اجاره دفتر از اول آبان تا آخر فروردین ۶۰ میلیون دادیم', ['1405/8/1', '1406/1/31']],
  ]) {
    assert.deepEqual(period(text), expected, text);
    const [item] = voice(text).items;
    assert.equal(item.decision.treatment, 'prepaid-expense', text);
    const [row] = parsed(text);
    assert.deepEqual([fa(row.servicePeriodStart), fa(row.servicePeriodEnd)], expected, `${text} — مسیر پارسر`);
  }
});

test('سالِ بازه: خانوادهٔ عددهایی که سال نیستند', () => {
  for (const text of [
    'اجاره دفتر از مهر تا اسفند ۱۵۰۰ هزار تومان دادیم',
    'اجاره دفتر از مهر تا اسفند ۱۴۰۰ هزار تومان دادیم',
    'اجاره از مهر تا اسفند ۲۰ و ۵۰۰ دادیم',
    'اجاره از مهر تا اسفند ۳۰ تومن دادیم',
    'اجاره از مهر تا اسفند ۶۰ ملیون دادیم',
    'اجاره از مهر تا اسفند 60 میلیون دادیم',
    'اجاره از مهر تا اسفند ۴۵ دادیم',
    'اجاره دفتر از مهر تا اسفند، ۶۰ میلیون پرداخت شد',
  ]) assert.deepEqual(period(text), ['1405/7/1', '1405/12/29'], text);
  // طولِ کنار بازه هم سال نیست.
  for (const text of ['بیمه از آبان تا مهر ۱۲ ماه، ۲۴ میلیون دادیم', 'بیمه از آبان تا مهر ۱۲ ماهه ۲۴ میلیون دادیم']) {
    assert.deepEqual(period(text), ['1405/8/1', '1406/7/30'], text);
  }
  // دورقمی به نزدیک‌ترین سده: «۹۹» در ۱۴۰۵ یعنی ۱۳۹۹، نه ۱۴۹۹.
  assert.deepEqual(period('بیمه از فروردین ۹۹ تا اسفند ۹۹ دادیم ۱۲ میلیون'), ['1399/1/1', '1399/12/30']);
});

test('سالِ بازه: سالِ واقعی همچنان خوانده می‌شود', () => {
  assert.deepEqual(period('اجاره از مهر تا اسفند ۰۵ مبلغ ۶۰ میلیون'), ['1405/7/1', '1405/12/29']);
  assert.deepEqual(period('اجاره سال ۰۵ از مهر تا اسفند'), ['1405/7/1', '1405/12/29']);
  assert.deepEqual(period('بیمه از آبان ۰۵ تا مهر ۰۶، ۲۴ میلیون'), ['1405/8/1', '1406/7/30']);
  assert.deepEqual(period('بیمه از آبان ۱۴۰۵ تا مهر ۱۴۰۶ مبلغ ۲۴ میلیون'), ['1405/8/1', '1406/7/30']);
  assert.deepEqual(period('بیمه از آبان هزار و چهارصد و پنج تا مهر هزار و چهارصد و شش، ۲۴ میلیون'), ['1405/8/1', '1406/7/30']);
  // سالی که عددی درست پشتش آمده تا وقتی خوانندهٔ مبلغ آن را کنار نگذارد، پرسیده
  // می‌شود؛ وگرنه مبلغِ سال‌دار خودکار ثبت می‌شد (آزمون بازبینی دور دوم).
  assert.equal(period('بیمه از آبان ۱۴۰۵ تا مهر ۱۴۰۶ ۲۴ میلیون'), null);
  assert.deepEqual(period('بیمه از آبان ۱۴۰۶ تا مهر ۱۴۰۷'), ['1406/8/1', '1407/7/30'], 'دو سال جلوتر هنوز باورپذیر است');
  // سالِ چهاررقمیِ دور صریحاً سال است: جایش سال رویداد نمی‌نشیند، پرسیده می‌شود.
  assert.equal(period('اجاره از مهر تا اسفند ۱۴۲۰ دادیم'), null, 'پانزده سال جلوتر پرسیده می‌شود');
});

// ---------------------------------------------------------------------------
// coverage-start-becomes-payment-date — شروع پوشش، روز پرداخت نیست
// ---------------------------------------------------------------------------

test('شروع پوشش «که از اول آذر شروع میشه» روز پرداخت نمی‌شود (جمله‌های کاربر)', () => {
  for (const [text, expected] of [
    ['اجاره شش ماهه که از اول آذر شروع میشه ۳۰ میلیون دادیم', ['1405/9/1', '1406/2/31']],
    ['بیمه یکساله که از اول آبان شروع میشه ۱۲ میلیون دادیم', ['1405/8/1', '1406/7/30']],
    ['بیمه یکساله که از ۱ آبان شروع میشه ۱۲ میلیون دادیم', ['1405/8/1', '1406/7/30']],
    // بی «از»، با تایپ بی‌دقت و رقم لاتین.
    ['بیمه یکساله که اول آبان شروع میشه ۱۲ میلیون دادیم', ['1405/8/1', '1406/7/30']],
    ['بیمه یکساله که از اول ابان شروع میشه ۱۲ میلیون دادیم', ['1405/8/1', '1406/7/30']],
    ['بیمه یکساله که از 1 آبان شروع میشه 12 میلیون دادیم', ['1405/8/1', '1406/7/30']],
  ]) {
    const [row] = parsed(text);
    assert.equal(row.occurredAt, undefined, `${text} — پرداخت امروز است، نه ${fa(row.occurredAt)}`);
    assert.deepEqual([fa(row.servicePeriodStart), fa(row.servicePeriodEnd)], expected, text);
    const [item] = voice(text).items;
    assert.equal(item.decision.treatment, 'prepaid-expense', text);
  }
});

test('شروع پوشش: تاریخ پرداختِ واقعی کنار آن می‌ماند؛ «سه ماه گذشته» روز پرداخت نیست', () => {
  const now = new Date(NOW);
  assert.equal(fa(extractOccurrenceDate('دیروز بیمه یکساله از اول آبان ۱۲ میلیون دادیم', { now, preferPast: true })?.iso), '1405/7/17');
  assert.equal(fa(extractOccurrenceDate('۱۵ مهر اجاره شش ماهه که از اول آذر شروع میشه ۳۰ میلیون دادیم', { now, preferPast: true })?.iso), '1405/7/15');
  const [row] = parsed('اجاره سه ماه گذشته ۳۰ میلیون دادیم');
  assert.equal(row.occurredAt, undefined, 'پرداخت امروز است، نه سه ماه پیش');
  assert.equal(voice('اجاره سه ماه گذشته ۳۰ میلیون دادیم').items[0].fact, 'servicePeriodStart', 'دوره حدس زده نمی‌شود');
});

test('ماسک پوشش هم‌طول است و فقط در جملهٔ خدمت دوره‌دار کار می‌کند', () => {
  const text = 'اجاره از اول آبان تا آخر اسفند رو چک ۵۰ میلیونی به آقای رضایی دادیم';
  const masked = maskCoveragePhrases(text);
  assert.equal(masked.length, text.length);
  assert.doesNotMatch(masked, /آبان|اسفند/);
  assert.match(maskCoveragePhrases('چک ۱۰ میلیونی دو ماه بعد بابت اجاره دادیم'), /دو ماه بعد/, 'تاریخ خود چک می‌ماند');
  assert.match(maskCoveragePhrases('از اول مهر تا حالا ۵۰ میلیون فروختیم'), /اول مهر/, 'بی خدمت دوره‌دار دست نمی‌خورد');
});

// ---------------------------------------------------------------------------
// goods-advance-lead-time-as-prepaid — زمان تحویل کالا، دورهٔ پوشش نیست
// ---------------------------------------------------------------------------

test('زمان تحویل کالا دورهٔ پوشش نیست (جمله‌های کاربر)', () => {
  for (const text of [
    '۳۰ میلیون به تولیدی نوری دادیم برای پارچه که سه ماه بعد تحویل میده',
    'برای خرید دستگاه که دو ماه بعد میرسه ۵۰ میلیون به آقای رضایی دادیم',
    '۲۰ میلیون به آقای رضایی دادیم بابت ورق، دو ماه آینده تحویل میده',
    'سفارش کالا دادیم ۴۰ میلیون واریز کردیم سه ماه بعد میاد',
    'پیش پرداخت پارچه ۳۰ میلیون دادیم تحویل سه ماه بعد',
    '۳۰ میلیون پارچه سفارش دادیم 3 ماه دیگه می رسه',
  ]) {
    assert.equal(readServicePeriod(text, { occurredAt: NOW }), null, text);
    const [row] = parsed(text);
    assert.equal(row.servicePeriodStart, undefined, text);
    for (const item of voice(text).items) {
      assert.notEqual(item.decision?.treatment, 'prepaid-expense', text);
      assert.equal(roles(item).some(([role]) => role === ROLES.PREPAID_ASSET), false, `${text} — هزینهٔ ماهانه نمی‌سازد`);
    }
  }
});

test('زمان تحویل: پوششِ خدمت با «آینده/بعد» همچنان دوره است', () => {
  assert.deepEqual(period('اجاره شش ماه آینده ۳۰ میلیون دادیم'), [TODAY, '1406/1/17']);
  assert.deepEqual(period('اشتراک سه ماه بعد نرم افزار ۶ میلیون دادیم'), [TODAY, '1405/10/17']);
  assert.deepEqual(period('پونزده میلیون شارژ ساختمان رو برای شش ماه جلوتر تسویه کردم'), [TODAY, '1406/1/17']);
});

// ---------------------------------------------------------------------------
// period-number-pattern-boundary — عدد درون واژه، و ماه سه‌رقمی
// ---------------------------------------------------------------------------

test('«نه» درون «خونه» و «ماهانه» عدد نیست؛ «۱۲۰ ماهه» ده سال است (جمله‌های کاربر)', () => {
  for (const [text, expected] of [
    ['اجاره خونه ماه بعد ۱۰ میلیون دادیم', ['1405/8/1', '1405/8/30']],
    ['اجاره ماهیانه ماه بعد رو ۱۰ میلیون دادیم', ['1405/8/1', '1405/8/30']],
    ['حق اشتراک ماهانه سال آینده رو ۲۴ میلیون دادیم', ['1406/1/1', '1406/12/29']],
    ['شارژ ماهانه ماه آینده ۲ میلیون دادیم', ['1405/8/1', '1405/8/30']],
    ['اجاره سوله ۱۲۰ ماهه ۱ میلیارد دادیم', [TODAY, '1415/7/17']],
    // «یه» درون «کرایه» هم عدد نیست.
    ['کرایه مغازه ماه بعد ۵ میلیون دادیم', ['1405/8/1', '1405/8/30']],
  ]) assert.deepEqual(period(text), expected, text);
  assert.equal(readServiceLength('اجاره سوله ۱۲۰ ماهه').months, 120);
  assert.equal(readServicePeriod('اجاره سوله ۱۵۰ ماهه ۱ میلیارد دادیم', { occurredAt: NOW }), null, 'بیش از ده سال پرسیده می‌شود');
});

// ---------------------------------------------------------------------------
// period-start-plus-duration-and-range-without-az — شروع و طول جدا خوانده می‌شوند
// ---------------------------------------------------------------------------

test('شروعِ گفته‌شده کنار طول: دوره از همان شروع (جمله‌های کاربر)', () => {
  for (const [text, expected] of [
    ['بیمه یکساله از اول آبان ۱۲ میلیون دادیم', ['1405/8/1', '1406/7/30']],
    ['اجاره شش ماهه از اول آبان ۳۰ میلیون دادیم', ['1405/8/1', '1406/1/31']],
    ['بیمه یکساله از 1405/08/01 مبلغ 12 میلیون دادیم', ['1405/8/1', '1406/7/30']],
    ['بیمه آتش سوزی یکساله از فروردین ۱۲ میلیون دادیم', ['1405/1/1', '1405/12/29']],
    ['اجاره آبان تا اسفند ۵۰ میلیون دادیم', ['1405/8/1', '1405/12/29']],
    ['اجاره مهر تا اسفند دفتر ۳۰ میلیون دادیم', ['1405/7/1', '1405/12/29']],
    ['بیمه یک ساله از اول فروردین ۱۲ میلیون دادیم', ['1405/1/1', '1405/12/29']],
    ['اجاره شش ماه دفتر رو از مهر دادیم ۳۰ میلیون', ['1405/7/1', '1405/12/29']],
    ['اجاره ۶ ماه دفتر از اول مهر ۳۰ میلیون دادیم', ['1405/7/1', '1405/12/29']],
    ['اجاره دفتر برای سه ماه ۱۵ میلیون دادیم', [TODAY, '1405/10/17']],
  ]) {
    assert.deepEqual(period(text), expected, text);
    const [row] = parsed(text);
    assert.deepEqual([fa(row.servicePeriodStart), fa(row.servicePeriodEnd)], expected, `${text} — مسیر پارسر`);
    assert.equal(row.occurredAt, undefined, `${text} — پرداخت امروز است`);
  }
});

test('شروع و طول: شکل‌های هم‌ارز', () => {
  for (const [text, expected] of [
    ['بیمه یکساله از ۱۴۰۵/۰۸/۰۱ مبلغ ۱۲ میلیون دادیم', ['1405/8/1', '1406/7/30']],
    ['اجاره آبان الی اسفند ۵۰ میلیون دادیم', ['1405/8/1', '1405/12/29']],
    ['بیمه آبان تا اسفند ۵۰ میلیون دادیم', ['1405/8/1', '1405/12/29']],
    ['اشتراک آبان تا اسفند ۵ میلیون دادیم', ['1405/8/1', '1405/12/29']],
    ['اجاره دفتر از اول آبان برای شش ماه ۳۰ میلیون دادیم', ['1405/8/1', '1406/1/31']],
    ['اجاره دفتر از آبان به مدت پنج ماه ۵۰ میلیون دادیم', ['1405/8/1', '1405/12/29']],
    ['اجاره دفتر به مدت شش ماه ۶۰ میلیون دادیم', [TODAY, '1406/1/17']],
    ['اجاره دفتر از امروز به مدت یک سال ۶۰ میلیون از تجارت دادیم', [TODAY, '1406/7/17']],
    ['بیمه یکساله از اول ابان ۱۲ میلیون دادیم', ['1405/8/1', '1406/7/30']],
    ['اجاره شش ماهه از اول اذر ۳۰ میلیون دادیم', ['1405/9/1', '1406/2/31']],
    ['بيمه يكساله از اول آبان ۱۲ ميليون داديم', ['1405/8/1', '1406/7/30']],
    ['بیمه‌ی یک‌ساله از اول آبان ۱۲ میلیون دادیم', ['1405/8/1', '1406/7/30']],
    ['بیمه سه ماهه از ۲۰ مهر ۶ میلیون دادیم', ['1405/7/20', '1405/10/19']],
    ['اجاره مهر برای شش ماه جلوتر ۶۰ میلیون دادیم', ['1405/7/1', '1405/12/29']],
  ]) assert.deepEqual(period(text), expected, text);
});

test('شروعِ تنها فقط شروع را می‌نشاند و پایان پرسیده می‌شود', () => {
  const text = 'اجاره دفتر از اول آبان ۱۲ میلیون دادیم';
  assert.deepEqual(period(text), ['1405/8/1', null], 'سال ۱۴۰۵ است، نه ۱۴۱۲');
  const [item] = voice(text).items;
  assert.equal(item.outcome, 'ask');
  assert.equal(item.fact, 'servicePeriodEnd');
  assert.deepEqual(period('اجاره از ابان تا اسفند ۵۰ میلیون دادیم'), ['1405/8/1', '1405/12/29'], 'نه ۱۴۵۰');
});

test('شروع و طول: نمونه‌های منفی', () => {
  // دورهٔ پارسال پیش‌پرداخت تازه از امروز نیست؛ شروع پرسیده می‌شود.
  const lastYear = 'بیمه آتش سوزی یک ساله پارسال رو امروز ۱۲ میلیون دادیم';
  assert.equal(readServicePeriod(lastYear, { occurredAt: NOW }), null);
  assert.equal(voice(lastYear).items[0].fact, 'servicePeriodStart');
  for (const text of [
    'شش ماه پیش اجاره دادیم ۳۰ میلیون',
    'چک شش ماهه ۱۰ میلیون دادیم',
    'حقوق کارمندا برای دو ماه ۵۰ میلیون دادیم',
    'به مدت دو ماه ۱۰ میلیون قرض دادیم به آقای رضایی',
    'دو ماهه ۱۰ میلیون قرض دادیم به آقای رضایی',
    'تبلیغات اینستاگرام برای یک ماه ۵ میلیون دادیم',
    'قرارداد خرید پارچه از اول آبان ۳۰ میلیون دادیم',
    'از اول مهر تا حالا ۵۰ میلیون فروختیم',
    'پروژه رو آبان شروع کردیم ۵۰ میلیون دادیم به پیمانکار',
  ]) assert.equal(readServicePeriod(text, { occurredAt: NOW }), null, text);
  // بازه و صفتِ ناسازگار حدس نمی‌خورد.
  assert.equal(readServicePeriod('بیمه یکساله از مهر تا اسفند ۱۲ میلیون دادیم', { occurredAt: NOW }), null);
});

// ---------------------------------------------------------------------------
// relative-month-and-year-period — «همین ماه»، «ماه قبل»، «سال ۱۴۰۶»
// ---------------------------------------------------------------------------

test('ماه و سالِ نسبی: سؤال بی‌مورد پرسیده نمی‌شود (جمله‌های کاربر)', () => {
  for (const [text, expected, treatment] of [
    ['اجاره همین ماه ۱۰ میلیون دادیم', ['1405/7/1', '1405/7/30'], 'period-expense'],
    ['اجاره این ماه رو ۱۰ میلیون دادیم', ['1405/7/1', '1405/7/30'], 'period-expense'],
    ['اجاره ماه جاری ۱۰ میلیون پرداخت شد', ['1405/7/1', '1405/7/30'], 'period-expense'],
    ['اجاره ماه قبل ۱۰ میلیون دادیم', ['1405/6/1', '1405/6/31'], 'period-expense'],
    ['اجاره ماه گذشته ۱۰ میلیون دادیم', ['1405/6/1', '1405/6/31'], 'period-expense'],
    ['اجاره دفتر برای سال ۱۴۰۶ رو ۱۲۰ میلیون دادیم', ['1406/1/1', '1406/12/29'], 'prepaid-expense'],
  ]) {
    assert.deepEqual(period(text), expected, text);
    const [item] = voice(text).items;
    assert.equal(item.outcome, 'post', text);
    assert.equal(item.decision.treatment, treatment, text);
    assert.equal(parsed(text)[0].occurredAt, undefined, `${text} — پرداخت امروز است`);
  }
});

test('ماه و سالِ نسبی: فقط پشت نام خدمت دوره‌دار', () => {
  // «ماه پیش اجاره دادیم» تاریخ پرداخت است؛ دوره پرسیده می‌شود.
  const paidLastMonth = parsed('ماه پیش اجاره ۱۰ میلیون دادیم')[0];
  assert.equal(fa(paidLastMonth.occurredAt), '1405/6/18');
  assert.equal(paidLastMonth.servicePeriodStart, undefined);
  for (const text of [
    '۱۰ میلیون پارچه برای ماه بعد سفارش دادیم',
    'مالیات بابت سال قبل رو ۱۰ میلیون دادیم',
    'بابت ماه قبل به آقای رضایی ۵ میلیون دادیم',
    'قسط ماه بعد وام رو ۱۰ میلیون دادیم',
  ]) {
    assert.equal(readServicePeriod(text, { occurredAt: NOW }), null, text);
    assert.notEqual(voice(text).items[0].outcome, 'post', `${text} — هزینهٔ حدسی ثبت نمی‌شود`);
  }
});

test('ماه نام‌برده یا نسبی کنار «تسویه»، بستن بدهی است؛ پوشش جلوتر پیش‌پرداخت', () => {
  for (const text of [
    'بدهی اجاره ماه قبل به آقای رضایی رو ۱۰ میلیون تسویه کردیم',
    'اجاره همین ماه رو با آقای رضایی تسویه کردیم ۱۰ میلیون',
    'اجاره مهر رو با آقای رضایی تسویه کردیم ۱۰ میلیون',
    'بدهی اجاره شهریور به آقای رضایی رو ۱۰ میلیون تسویه کردیم',
  ]) assert.equal(voice(text).path, 'settle', `${text} — کارت تسویه سند باز را می‌پرسد`);
  const [prepaid] = voice('پونزده میلیون شارژ ساختمان رو برای شش ماه جلوتر تسویه کردم').items;
  assert.equal(prepaid.decision.treatment, 'prepaid-expense');
});

// ---------------------------------------------------------------------------
// جهت وارونه: پیش‌دریافت اجاره و اشتراک — همان دوره، همان روز دریافت
// ---------------------------------------------------------------------------

test('پیش‌دریافت: دوره همان‌طور خوانده می‌شود و شروع پوشش روز دریافت نیست', () => {
  for (const [text, expected] of [
    ['مستاجر اجاره از اول آبان تا آخر اسفند رو ۵۰ میلیون داد', ['1405/8/1', '1405/12/29']],
    ['اجاره شش ماهه مغازه که از اول آذر شروع میشه رو ۳۰ میلیون از مستاجر گرفتیم', ['1405/9/1', '1406/2/31']],
    ['اجاره مغازه از مهر تا اسفند ۶۰ میلیون از مستاجر گرفتیم', ['1405/7/1', '1405/12/29']],
    ['اشتراک یکساله نرم افزار رو از اول آبان به مشتری فروختیم ۲۴ میلیون گرفتیم', ['1405/8/1', '1406/7/30']],
  ]) {
    const [row] = parsed(text);
    assert.deepEqual([fa(row.servicePeriodStart), fa(row.servicePeriodEnd)], expected, text);
    assert.equal(row.occurredAt, undefined, `${text} — دریافت امروز است`);
  }
});

// ---------------------------------------------------------------------------
// renewal-anchored-to-payment-day — «تمدید» از روز پرداخت شروع نمی‌شود
// ---------------------------------------------------------------------------

const RENEWALS = [
  'اشتراک نرم افزار رو یکساله تمدید کردیم ۲۴ میلیون از حساب تجارت',
  'بیمه آتش سوزی رو یک ساله تمدید کردیم ۱۲ میلیون از حساب تجارت دادیم',
  'بیمه بدنه رو تمدید کردیم یکساله ۸ میلیون دادیم',
  'تمدید یکساله بیمه آتش سوزی ۱۲ میلیون پرداخت شد',
  'تمدید اشتراک یکساله نرم افزار ۲۴ میلیون از حساب ملت',
  'قرارداد اجاره دفتر رو شش ماهه تمدید کردیم ۶۰ میلیون',
  'لایسنس آنتی ویروس رو یک ساله تمديد كرديم 3 میلیون',
  'بیمه رو برای یک سال دیگه تمدید کردیم ۱۲ میلیون دادیم',
];

test('تمدید: شروع از روز پرداخت حدس زده نمی‌شود؛ پرسیده می‌شود (جمله‌های کاربر)', () => {
  for (const text of RENEWALS) {
    assert.equal(readServicePeriod(text, { occurredAt: NOW }), null, text);
    const [item] = voice(text).items;
    assert.equal(item.outcome, 'ask', text);
    assert.equal(item.fact, 'servicePeriodStart', text);
  }
});

test('تمدید: جواب شروع، پایان را از طولِ گفته‌شده می‌سازد', () => {
  for (const [text, months] of RENEWALS.map((text) => [text, /شش ماهه/.test(text) ? 6 : 12])) {
    const event = { occurredAt: NOW, evidence: text };
    const patch = applyAnswer(event, { fact: 'servicePeriodStart', value: 'custom', freeText: '۱ آذر ۱۴۰۵' }, { today: NOW });
    assert.equal(fa(patch.servicePeriodStart), '1405/9/1', text);
    assert.equal(fa(patch.servicePeriodEnd), fa(persianPeriodEnd(persianToISO(1405, 9, 1), months)), text);
    const option = applyAnswer(event, { fact: 'servicePeriodStart', value: 'next-month' }, { today: NOW });
    assert.equal(fa(option.servicePeriodEnd), months === 6 ? '1406/1/31' : '1406/7/30', text);
  }
});

test('تمدید: نمونه‌های منفی', () => {
  // قرارداد تازه همچنان از روز پرداخت.
  assert.deepEqual(period('اشتراک یک ساله نرم افزار ۲۴ میلیون از حساب تجارت پرداخت کردیم'), [TODAY, '1406/7/17']);
  // بازهٔ صریح در جملهٔ تمدید همان بازه است.
  assert.deepEqual(period('بیمه آتش سوزی رو از اول آذر تا آخر آبان تمدید کردیم ۱۲ میلیون دادیم'), ['1405/9/1', '1406/8/30']);
  // کارمزد تمدید حد اعتباری پیش‌پرداخت نیست.
  const [fee] = voice('کارمزد تمدید حد اعتباری ۲ میلیون از حساب ملت کم شد').items;
  assert.notEqual(fee.decision?.treatment, 'prepaid-expense');
  // جملهٔ بی‌طول: جواب شروع پایان را نمی‌سازد.
  const plain = applyAnswer({ occurredAt: NOW, evidence: 'بیمه انبار ۱۲ میلیون دادیم' }, { fact: 'servicePeriodStart', value: 'this-month' }, { today: NOW });
  assert.equal(plain.servicePeriodEnd, undefined);
  // بازهٔ ناسازگار در جمله: پایان همچنان پرسیده می‌شود.
  const conflict = applyAnswer({ occurredAt: NOW, evidence: 'بیمه یکساله از مهر تا اسفند ۱۲ میلیون دادیم' }, { fact: 'servicePeriodStart', value: 'this-month' }, { today: NOW });
  assert.equal(conflict.servicePeriodEnd, undefined);
});

// ---------------------------------------------------------------------------
// period-end-from-month-start — پایانِ دوره همان روزِ ماه، منهای یک روز
// ---------------------------------------------------------------------------

test('پایان دوره از روزِ شروع حساب می‌شود، نه از اول ماه', () => {
  const PRESETS = { 'three-months': 3, 'six-months': 6, 'one-year': 12 };
  for (const day of [1, 15, 16, 20, 29, 31]) {
    const month = day === 31 ? 6 : 7;
    const start = persianToISO(1405, month, day);
    for (const [value, months] of Object.entries(PRESETS)) {
      const { servicePeriodEnd } = applyAnswer({ occurredAt: NOW, servicePeriodStart: start }, { fact: 'servicePeriodEnd', value }, { today: NOW });
      const schedule = buildMonthlySchedule({ amount: 12_000_000, periodStart: start, periodEnd: servicePeriodEnd, sourceId: 'x' });
      const label = `${day}/${month} + ${value}`;
      assert.equal(schedule.length, months, label);
      assert.equal(schedule.reduce((sum, item) => sum + item.amount, 0), 12_000_000, label);
      // سالگرد روزِ شروع، منهای یک روز.
      const anniversary = Date.parse(servicePeriodEnd) + 86_400_000;
      const { day: endDay } = todayPersian(new Date(anniversary));
      assert.ok(endDay === day || (endDay === 1 && day > 29), `${label} → ${fa(servicePeriodEnd)}`);
    }
  }
  for (const [start, months, end] of [
    [[1405, 7, 20], 3, '1405/10/19'], [[1405, 7, 15], 6, '1406/1/14'], [[1405, 8, 20], 6, '1406/2/19'],
    [[1405, 7, 1], 3, '1405/9/30'], [[1405, 6, 31], 1, '1405/7/30'], [[1405, 11, 30], 1, '1405/12/29'],
    [[1403, 12, 30], 12, '1404/12/29'], [[1405, 12, 29], 1, '1406/1/28'], [[1405, 7, 30], 6, '1406/1/29'],
  ]) assert.equal(fa(persianPeriodEnd(persianToISO(...start), months)), end, `${start.join('/')} + ${months}`);
  // جملهٔ تایپی همان قاعده را دارد.
  assert.deepEqual(period('اجاره شش ماهه از ۳۰ مهر ۳۰ میلیون دادیم'), ['1405/7/30', '1406/1/29']);
});

// ---------------------------------------------------------------------------
// coverage-answer-single-date-only — جواب دوره: بازه، طول، ماه، تاریخ
// ---------------------------------------------------------------------------

test('جواب سؤال دوره: بازه، طول و ماهِ بی‌روز پذیرفته می‌شوند', () => {
  const mehr = { occurredAt: NOW, servicePeriodStart: persianToISO(1405, 7, 1) };
  const answer = (event, fact, freeText) => {
    const patch = applyAnswer(event, { fact, value: 'custom', freeText }, { today: NOW });
    return [fa(patch.servicePeriodStart), fa(patch.servicePeriodEnd)];
  };
  assert.deepEqual(answer({ occurredAt: NOW }, 'servicePeriodStart', 'از اول مهر ۱۴۰۵ تا آخر شهریور ۱۴۰۶'), ['1405/7/1', '1406/6/31']);
  assert.deepEqual(answer({ occurredAt: NOW }, 'servicePeriodStart', '۶ ماه از مهر'), ['1405/7/1', '1405/12/29']);
  assert.deepEqual(answer({ occurredAt: NOW }, 'servicePeriodStart', 'مهر ۱۴۰۵'), ['1405/7/1', null]);
  assert.deepEqual(answer({ occurredAt: NOW }, 'servicePeriodStart', '۲۰ مهر ۱۴۰۵'), ['1405/7/20', null]);
  for (const [text, end] of [
    ['۱۲ ماه', '1406/6/31'], ['یک سال', '1406/6/31'], ['یکساله', '1406/6/31'], ['دوازده ماه', '1406/6/31'], ['12 ماه', '1406/6/31'],
    ['۲۴ ماه', '1407/6/31'], ['دو سال', '1407/6/31'], ['۹ ماه', '1406/3/31'], ['یک ماه', '1405/7/30'],
    ['آخر شهریور ۱۴۰۶', '1406/6/31'], ['اخر شهريور 1406', '1406/6/31'], ['پایان شهریور ۱۴۰۶', '1406/6/31'],
    ['شهریور ۱۴۰۶', '1406/6/31'], ['آخر شهریور', '1406/6/31'], ['۳۱ شهریور', '1406/6/31'], ['۳۱ شهریور ۱۴۰۶', '1406/6/31'], ['1406/06/31', '1406/6/31'],
  ]) assert.deepEqual(answer(mehr, 'servicePeriodEnd', text), [null, end], text);
  // دو سال: بیست‌وچهار قسط که جمعشان همان مبلغ است.
  const twoYears = applyAnswer(mehr, { fact: 'servicePeriodEnd', value: 'custom', freeText: 'دو سال' }, { today: NOW });
  const schedule = buildMonthlySchedule({ amount: 12_000_000, periodStart: mehr.servicePeriodStart, periodEnd: twoYears.servicePeriodEnd, sourceId: 'x' });
  assert.equal(schedule.length, 24);
  assert.equal(schedule.reduce((sum, item) => sum + item.amount, 0), 12_000_000);
});

test('جواب سؤال دوره: نمونه‌های منفی رد می‌شوند', () => {
  const mehr = { occurredAt: NOW, servicePeriodStart: persianToISO(1405, 7, 1) };
  const reject = (event, fact, freeText, code) => assert.throws(
    () => applyAnswer(event, { fact, value: 'custom', freeText }, { today: NOW }), { code }, freeText,
  );
  reject(mehr, 'servicePeriodEnd', 'سه ماه پیش', 'ANSWER_PERIOD_ORDER_INVALID');
  reject(mehr, 'servicePeriodEnd', '۶ ماه قبل', 'ANSWER_PERIOD_ORDER_INVALID');
  reject(mehr, 'servicePeriodEnd', '۱۵ شهریور ۱۴۰۵', 'ANSWER_PERIOD_ORDER_INVALID');
  // جواب کهنهٔ سؤال شروع که به سؤال پایان رسیده، دورهٔ یک‌روزه نمی‌سازد.
  reject(mehr, 'servicePeriodEnd', '۱ مهر ۱۴۰۵', 'ANSWER_PERIOD_ORDER_INVALID');
  reject(mehr, 'servicePeriodEnd', 'هرچی', 'ANSWER_DATE_INVALID');
  reject({ occurredAt: NOW, servicePeriodEnd: persianToISO(1405, 7, 30) }, 'servicePeriodStart', '۱ آبان ۱۴۰۵', 'ANSWER_PERIOD_ORDER_INVALID');
  // «دوره‌اش گذشته» همچنان شروع و پایان برابر می‌سازد.
  const passed = applyAnswer({ occurredAt: NOW }, { fact: 'servicePeriodStart', value: 'already-passed' }, { today: NOW });
  assert.equal(passed.servicePeriodStart, passed.servicePeriodEnd);
});

// ---------------------------------------------------------------------------
// روی دفتر: مسیر قطعی (جواب سؤال رویداد) و مسیر فهم (پروندهٔ AI)
// ---------------------------------------------------------------------------

process.env.DATABASE_PATH = tempDatabase('engine5-p2-period');
process.env.ADMIN_USERNAME = 'period-owner';
process.env.ADMIN_PASSWORD = 'period-strong-password-5521';
const database = await import('../server/db.js');
const store = await import('../server/financialEventStore.js');
database.ensureAdmin();
const owner = database.authenticateUser('period-owner', 'period-strong-password-5521');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر دورهٔ پوشش', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

let sequence = 0;
/** همان راهی که ردیف صوتی تا صف می‌رود: پارسر، تصمیم، رویداد منتظر. */
function captured(text) {
  const [row] = parsed(text);
  const draft = transactionEventDecision({ ...row, occurredAt: row.occurredAt || NOW, accountId: 'cash' }, { transcript: text, policy: { engineV2: true } });
  sequence += 1;
  return store.recordFinancialEvent(db(), draft.event, {
    sourceEventId: `p2-period:${sequence}`, decision: draft.decision, actor: owner.id, accountingDecision: draft.accountingDecision,
  });
}
const answer = (id, body) => store.answerEventQuestion(db(), id, { ...body, actor: owner.id });
const periodKeys = (id) => store.scheduleForEvent(db(), id).map((item) => [item.periodKey, item.amount]);

const none = { op: null, of: [] };
const outputs = new Map();
const fetcher = async (url, init) => {
  const said = JSON.parse(JSON.parse(init.body).input[1].content[0].text)['گفتهٔ کاربر'];
  return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(outputs.get(said)) }] }], usage: { input_tokens: 1, output_tokens: 1 } }) };
};
const aiOptions = { fetcher, env: { OPENAI_API_KEY: 'test-key-not-real', OPENAI_UNDERSTANDING_MODEL: 'test-model' }, now: new Date(NOW) };
/** خروجی مدل برای یک پرداخت خدمت از حساب تجارت، بی هیچ تاریخی. */
function modelSaid(text, { amount, evidence, what }) {
  outputs.set(text, {
    event: { kind: 'expense', description: what, status: 'done' },
    amounts: [{ id: 'a1', value: amount, currency: null, role: 'total', status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence }],
    nonAmountNumbers: [], dates: [], counterparties: [],
    movements: [{ id: 'm1', amountRef: 'a1', direction: 'out', from: { kind: 'bank', name: 'تجارت' }, to: { kind: 'unknown', name: null }, evidence: 'از حساب تجارت' }],
    subject: { what, kind: 'service', use: 'internal', delivered: 'unknown', usefulLifeMonths: null, evidence: what },
    conditions: [], ambiguities: [],
  });
}

test('آماده‌سازی دفتر: موتور روشن، فهم فعال، حساب تجارت', () => inWorkspace(() => {
  database.installChartTemplate();
  database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all' });
  database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 500_000_000 });
}));

test('دفتر، مسیر قطعی: «۲۰ مهر» + «سه ماه» سه قسط ۴ میلیونی است، نه دو قسط ۶ میلیونی', () => inWorkspace(() => {
  const event = captured('بیمه انبار ۱۲ میلیون دادیم');
  assert.equal(event.status, 'pending');
  answer(event.id, { fact: 'servicePeriodStart', value: 'custom', freeText: '۲۰ مهر ۱۴۰۵' });
  const done = answer(event.id, { fact: 'servicePeriodEnd', value: 'three-months' });
  assert.equal(done.decision.treatment, 'prepaid-expense');
  assert.equal(fa(done.decision.facts?.servicePeriodEnd || JSON.parse(db().prepare('SELECT payload FROM financial_events WHERE id=?').get(event.id).payload).servicePeriodEnd), '1405/10/19');
  assert.deepEqual(periodKeys(event.id), [['1405-07', 4_000_000], ['1405-08', 4_000_000], ['1405-09', 4_000_000]]);
}));

test('دفتر، مسیر قطعی: جواب «۶ ماه از مهر» هر دو طرف را می‌نشاند؛ «دو سال» ۲۴ قسط', () => inWorkspace(() => {
  const range = captured('بیمه انبار ۱۲ میلیون دادیم');
  const ranged = answer(range.id, { fact: 'servicePeriodStart', value: 'custom', freeText: '۶ ماه از مهر' });
  assert.equal(ranged.decision.decisionStatus, 'decided', 'سؤال پایان دوباره پرسیده نمی‌شود');
  assert.equal(periodKeys(range.id).length, 6);
  const long = captured('بیمه انبار ۲۴ میلیون دادیم');
  answer(long.id, { fact: 'servicePeriodStart', value: 'this-month' });
  answer(long.id, { fact: 'servicePeriodEnd', value: 'custom', freeText: 'دو سال' });
  const schedule = store.scheduleForEvent(db(), long.id);
  assert.equal(schedule.length, 24);
  assert.equal(schedule.reduce((sum, item) => sum + item.amount, 0), 24_000_000);
  // پایان پیش از شروع، رد؛ و چیزی هم نوشته نمی‌شود.
  const bad = captured('اجاره انبار ۱۲ میلیون دادیم');
  answer(bad.id, { fact: 'servicePeriodStart', value: 'this-month' });
  assert.throws(() => answer(bad.id, { fact: 'servicePeriodEnd', value: 'custom', freeText: '۱۵ شهریور ۱۴۰۵' }), { code: 'ANSWER_PERIOD_ORDER_INVALID' });
  assert.deepEqual(periodKeys(bad.id), []);
}));

test('دفتر، مسیر قطعی: تمدید شروع را می‌پرسد و یک جواب کافی است', () => inWorkspace(() => {
  const event = captured('بیمه آتش سوزی رو یک ساله تمدید کردیم ۱۲ میلیون از حساب تجارت دادیم');
  assert.equal(event.status, 'pending');
  assert.equal(store.decisionForEvent(db(), event.id).question.fact, 'servicePeriodStart');
  const done = answer(event.id, { fact: 'servicePeriodStart', value: 'custom', freeText: '۱ آذر ۱۴۰۵' });
  assert.equal(done.decision.decisionStatus, 'decided');
  const keys = periodKeys(event.id);
  assert.equal(keys.length, 12);
  assert.deepEqual([keys[0][0], keys.at(-1)[0]], ['1405-09', '1406-08']);
}));

test('دفتر، مسیر قطعی: سالِ بازه از مبلغ خوانده نمی‌شود', () => inWorkspace(() => {
  const event = captured('اجاره دفتر از مهر تا اسفند ۶۰ میلیون پرداخت شد');
  assert.deepEqual(periodKeys(event.id), ['1405-07', '1405-08', '1405-09', '1405-10', '1405-11', '1405-12'].map((key) => [key, 10_000_000]));
}));

test('دفتر، مسیر فهم: بی تاریخ از مدل، دوره از جمله و سالِ درست', async () => {
  await inWorkspace(async () => {
    const text = 'اجاره دفتر از مهر تا اسفند ۶۰ میلیون از حساب تجارت پرداخت شد';
    modelSaid(text, { amount: 60_000_000, evidence: '۶۰ میلیون', what: 'اجاره دفتر' });
    const item = await database.createUnderstandingCase({ text, clientId: 'p2-range' }, aiOptions);
    assert.equal(item.status, 'ready', JSON.stringify(item.plan?.questions));
    const posted = database.commitUnderstandingCase(item.id, { now: new Date(NOW) });
    assert.equal(posted.status, 'posted');
    const keys = db().prepare("SELECT period_key AS key FROM recognition_schedule_items WHERE event_id=(SELECT event_id FROM recognition_schedule_items ORDER BY rowid DESC LIMIT 1) ORDER BY period_key").all().map((row) => row.key);
    assert.deepEqual(keys, ['1405-07', '1405-08', '1405-09', '1405-10', '1405-11', '1405-12']);
  });
});

test('دفتر، مسیر فهم: تمدید شروع را می‌پرسد؛ جواب شروع با طولِ جمله کامل می‌شود', async () => {
  await inWorkspace(async () => {
    const text = 'بیمه آتش سوزی رو یک ساله تمدید کردیم ۱۲ میلیون از حساب تجارت دادیم';
    modelSaid(text, { amount: 12_000_000, evidence: '۱۲ میلیون', what: 'بیمه آتش سوزی' });
    const item = await database.createUnderstandingCase({ text, clientId: 'p2-renewal' }, aiOptions);
    const question = item.plan.questions.find((entry) => entry.id.endsWith('.servicePeriodStart'));
    assert.ok(question, `شروع پرسیده می‌شود: ${JSON.stringify(item.plan.questions)}`);
    const answered = await database.answerUnderstandingCase(item.id, { [question.id]: { value: 'custom', freeText: '۱ آذر ۱۴۰۵' } }, aiOptions);
    assert.equal(answered.status, 'ready', `پایان دوباره پرسیده نمی‌شود: ${JSON.stringify(answered.plan?.questions)}`);
    database.commitUnderstandingCase(item.id, { now: new Date(NOW) });
    const keys = db().prepare("SELECT period_key AS key FROM recognition_schedule_items WHERE event_id=(SELECT event_id FROM recognition_schedule_items ORDER BY rowid DESC LIMIT 1) ORDER BY period_key").all().map((row) => row.key);
    assert.deepEqual([keys.length, keys[0], keys.at(-1)], [12, '1405-09', '1406-08']);
  });
});

test('دفتر، مسیر فهم: «۲۰ مهر» + «سه ماه» همان سه قسط مسیر قطعی', async () => {
  await inWorkspace(async () => {
    const text = 'بیمه انبار ۱۲ میلیون از حساب تجارت دادیم';
    modelSaid(text, { amount: 12_000_000, evidence: '۱۲ میلیون', what: 'بیمه انبار' });
    const item = await database.createUnderstandingCase({ text, clientId: 'p2-ai-end' }, aiOptions);
    const start = item.plan.questions.find((entry) => entry.id.endsWith('.servicePeriodStart'));
    assert.ok(start, JSON.stringify(item.plan.questions));
    const half = await database.answerUnderstandingCase(item.id, { [start.id]: { value: 'custom', freeText: '۲۰ مهر ۱۴۰۵' } }, aiOptions);
    const end = half.plan.questions.find((entry) => entry.id.endsWith('.servicePeriodEnd'));
    assert.ok(end, JSON.stringify(half.plan.questions));
    const ready = await database.answerUnderstandingCase(item.id, { [end.id]: { value: 'three-months' } }, aiOptions);
    assert.equal(ready.status, 'ready');
    database.commitUnderstandingCase(item.id, { now: new Date(NOW) });
    const rows = db().prepare("SELECT period_key AS key, amount FROM recognition_schedule_items WHERE event_id=(SELECT event_id FROM recognition_schedule_items ORDER BY rowid DESC LIMIT 1) ORDER BY period_key").all();
    assert.deepEqual(rows.map((row) => [row.key, row.amount]), [['1405-07', 4_000_000], ['1405-08', 4_000_000], ['1405-09', 4_000_000]]);
  });
});
