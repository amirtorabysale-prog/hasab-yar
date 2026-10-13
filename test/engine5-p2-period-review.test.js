import test from 'node:test';
import assert from 'node:assert/strict';
import { runVoice } from './helpers/voicePipeline.js';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
import { transactionEventDecision } from '../server/transactionEvent.js';
import { extractOccurrenceDate, persianToISO, spokenYear, todayPersian } from '../shared/persianDate.js';
import { readServiceLength, readServicePeriod } from '../shared/periodSpeech.js';
import { applyAnswer } from '../shared/questionAnswer.js';
import { detectSettleIntent } from '../shared/settleSpeech.js';
import { parseFinancialText } from '../shared/parser.js';

/**
 * موتور ۵، بستهٔ دوره — دور دوم بازبینی.
 *
 * هر بخش یک خانواده است: جملهٔ بازبین عیناً، شکل‌های هم‌ارز (رقم لاتین و فارسی،
 * تایپ بی‌دقت، جهت وارونه، مسیر تسویه و مسیر فهم) و نمونه‌های منفی که نباید وارد
 * مسیر شوند. امروز در همهٔ آزمون‌ها ۱۸ مهر ۱۴۰۵ است.
 */
const NOW = '2026-10-10T08:30:00.000Z';
const fa = (iso) => {
  if (!iso) return null;
  const { year, month, day } = todayPersian(new Date(iso));
  return `${year}/${month}/${day}`;
};
const parsed = (text) => parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions;
const voice = (text) => runVoice(text, { today: NOW });
const period = (text, options = {}) => {
  const found = readServicePeriod(text, { occurredAt: NOW, ...options });
  return found ? [fa(found.start), fa(found.end)] : null;
};
const TODAY = fa(NOW);
const occurrence = (text) => fa(extractOccurrenceDate(text, { now: new Date(NOW), preferPast: true })?.iso);

// ---------------------------------------------------------------------------
// مبلغِ بعد از «روز + ماه» سال نیست (extractDateMention)
// ---------------------------------------------------------------------------

test('تاریخ پرداخت: مبلغِ بعد از روز و ماه سال خوانده نمی‌شود (جمله‌های بازبین)', () => {
  for (const [text, expected] of [
    ['پنجم مهر ۹۹ میلیون فروش داشتیم', '1405/7/5'],
    ['۲۰ شهریور ۱۲ میلیون خرید کردیم', '1405/6/20'],
    ['۱۵ مهر ۳۰ میلیون اجاره دادیم', '1405/7/15'],
    ['اول مهر ۱۲ میلیون بیمه یکساله دادیم', '1405/7/1'],
    ['۳ مهر 60 میلیون فروختیم', '1405/7/3'],
    ['سوم مهر ۲۰ و ۵۰۰ فروش', '1405/7/3'],
  ]) {
    assert.equal(occurrence(text), expected, text);
    assert.equal(fa(parsed(text)[0].occurredAt), expected, `${text} — مسیر پارسر`);
  }
});

test('تاریخ پرداخت: خانوادهٔ عددهایی که سال نیستند', () => {
  for (const [text, expected] of [
    ['پنجم مهر ۹۹ ملیون فروش داشتیم', '1405/7/5'],
    ['5 مهر 99 میلیون فروش داشتیم', '1405/7/5'],
    ['۵ مهر ۱۲۰ میلیون فروختیم', '1405/7/5'],
    ['۵ مهر ۲۰ هزار تومن خرید کردیم', '1405/7/5'],
    ['۵ مهر ۳۰ تومان دادیم', '1405/7/5'],
    ['دهم شهریور ۴۵ دادیم بابت اجاره', '1405/6/10'],
    ['۱۰ شهریور ۲ ماه اجاره دادیم', '1405/6/10'],
    ['۱۰ شهریور ۲۰ و پانصد دادیم', '1405/6/10'],
  ]) assert.equal(occurrence(text), expected, text);
  // نمونهٔ منفی: سالِ واقعی همچنان سال است.
  for (const [text, expected] of [
    ['۵ مهر ۱۴۰۴ اجاره دادیم ۱۰ میلیون', '1404/7/5'],
    ['۵ مهر ۹۹ اجاره دادیم ۱۰ میلیون', '1399/7/5'],
    ['۵ مهر سال ۹۹ اجاره دادیم ۱۰ میلیون', '1399/7/5'],
    ['۲۰ شهریور ۰۴ خرید کردیم ۱۲ میلیون', '1404/6/20'],
  ]) assert.equal(occurrence(text), expected, text);
  // «پنجم مهر ۹۹ میلیون فروش» سند فروشِ پنجم مهرِ امسال است، نه ۱۴۹۹.
  const [row] = parsed('پنجم مهر ۹۹ میلیون فروش داشتیم');
  assert.deepEqual([fa(row.occurredAt), row.amount], ['1405/7/5', 99_000_000]);
});

test('تاریخ پرداخت: پولی که هنوز نرفته، روزش یک سال عقب نمی‌رود', () => {
  // «اول آذر» در جملهٔ آینده همین آذر است، نه آذرِ پارسال و نه ۱۴۳۰.
  assert.equal(occurrence('اجاره شش ماهه رو اول آذر ۳۰ میلیون پرداخت می‌کنیم'), '1405/9/1');
  assert.equal(occurrence('اجاره آبان رو اول آبان ۱۰ میلیون میدیم'), '1405/8/1');
  // نمونهٔ منفی: پولی که رفته، روزِ آینده‌اش پارسال است.
  assert.equal(occurrence('اول آذر اجاره دادیم ۱۰ میلیون'), '1404/9/1');
  assert.equal(occurrence('اجاره رو ۲۵ اسفند ۱۰ میلیون دادیم'), '1404/12/25');
  // «قرارداد» فعل گذشته نیست.
  assert.equal(occurrence('قرارداد اجاره رو اول آبان ۱۰ میلیون پرداخت می‌کنیم'), '1405/8/1');
});

// ---------------------------------------------------------------------------
// سالِ صریحِ دور جای خودش را به سال رویداد نمی‌دهد؛ پرسیده می‌شود
// ---------------------------------------------------------------------------

test('سالِ صریح بیرون از پنجره: دوره پرسیده می‌شود، نه سال رویداد (جمله‌های بازبین)', () => {
  for (const text of [
    'بیمه از فروردین ۱۳۹۴ تا اسفند ۱۳۹۴ مبلغ ۱۲ میلیون دادیم',
    'اجاره دفتر از فروردین ۱۴۰۸ تا اسفند ۱۴۰۸ مبلغ ۶۰ میلیون دادیم',
    'اجاره سوله از اول آبان ۱۴۱۰ به مدت یک سال ۶۰ میلیون دادیم',
    'اجاره دفتر از مهر تا اسفند ۰۸ مبلغ ۶۰ میلیون دادیم',
    'بیمه از فروردین ۹۴ تا اسفند ۹۴ مبلغ ۱۲ میلیون دادیم',
  ]) {
    assert.equal(period(text), null, text);
    const [row] = parsed(text);
    assert.equal(row.servicePeriodStart, undefined, `${text} — مسیر پارسر`);
    const [item] = voice(text).items;
    assert.equal(item.outcome, 'ask', text);
    assert.equal(item.fact, 'servicePeriodStart', text);
  }
});

test('سالِ صریح بیرون از پنجره: شکل‌های هم‌ارز و نمونه‌های منفی', () => {
  for (const text of [
    'اجاره دفتر از فروردین 1408 تا اسفند 1408 مبلغ 60 میلیون دادیم',
    'بیمه از فروردین سال ۹۴ تا اسفند سال ۹۴ ۱۲ میلیون دادیم',
    'اجاره دفتر سال ۱۴۱۰ رو ۱۰ میلیون دادیم',
    'اجاره دفتر از اول آبان ۰۸ برای یک سال ۱۲ میلیون دادیم',
    'بیمه یکساله که از اول آبان ۱۴۱۲ شروع میشه ۱۲ میلیون دادیم',
    'اجاره از مهر تا اسفند ۱۴۲۰ دادیم',
  ]) assert.equal(period(text), null, text);
  // سالِ باورپذیر همچنان خوانده می‌شود.
  assert.deepEqual(period('بیمه از فروردین ۹۹ تا اسفند ۹۹ دادیم ۱۲ میلیون'), ['1399/1/1', '1399/12/30']);
  assert.deepEqual(period('بیمه از آبان ۱۴۰۶ تا مهر ۱۴۰۷'), ['1406/8/1', '1407/7/30']);
  assert.deepEqual(period('اجاره از مهر تا اسفند ۰۵ مبلغ ۶۰ میلیون'), ['1405/7/1', '1405/12/29']);
  // عددی که حتی به‌عنوان سال بی‌معناست مبلغ گفتاری است: سال از تاریخ رویداد.
  assert.deepEqual(period('اجاره از مهر تا اسفند ۴۵ دادیم'), ['1405/7/1', '1405/12/29']);
  assert.deepEqual(period('اجاره از مهر تا اسفند ۶۰ میلیون دادیم'), ['1405/7/1', '1405/12/29']);
  // قاعدهٔ مشترک سال.
  assert.deepEqual(spokenYear('99', 1405), { year: 1399, plausible: true });
  assert.deepEqual(spokenYear('08', 1405), { year: 1408, plausible: false });
  assert.deepEqual(spokenYear('94', 1405), { year: 1394, plausible: false });
  assert.deepEqual(spokenYear('1394', 1405), { year: 1394, plausible: false });
  assert.equal(spokenYear('45', 1405), null);
  assert.equal(spokenYear('1200', 1405), null);
});

// ---------------------------------------------------------------------------
// سالی که دوره از آن خوانده شد، در مبلغ جمع نمی‌شود
// ---------------------------------------------------------------------------

test('سالِ دوره کنار مبلغ: ثبت خودکار نمی‌شود و جای سال گزارش می‌شود (جمله‌های بازبین)', () => {
  for (const text of [
    'بیمه سال ۱۴۰۶ ۱۲ میلیون دادیم',
    'اجاره دفتر سال ۱۴۰۶ ۱۲۰ میلیون دادیم',
    'اجاره دفتر سال ۰۶ ۱۲۰ میلیون دادیم',
  ]) {
    assert.equal(period(text), null, text);
    for (const item of voice(text).items) assert.notEqual(item.outcome, 'post', `${text} — مبلغِ سال‌دار ثبت نمی‌شود`);
  }
});

test('سالِ دوره کنار مبلغ: شکل‌های هم‌ارز، و جای سال‌ها برای خوانندهٔ مبلغ', () => {
  for (const text of [
    'اجاره از مهر تا اسفند ۰۵ ۶۰ میلیون دادیم',
    'بیمه از فروردین ۹۹ تا اسفند ۹۹ ۱۲ میلیون دادیم',
    'بیمه یکساله از اول آبان ۱۴۰۵ ۱۲ میلیون دادیم',
    'بیمه از آبان 1405 تا مهر 1406 24 میلیون دادیم',
    'اشتراک سال 06 24 میلیون دادیم',
  ]) assert.equal(period(text), null, text);
  // سالِ جدا از مبلغ همچنان خوانده می‌شود و جایش گزارش می‌شود.
  const text = 'اجاره دفتر برای سال ۱۴۰۶ رو ۱۲۰ میلیون دادیم';
  const found = readServicePeriod(text, { occurredAt: NOW });
  assert.deepEqual([fa(found.start), fa(found.end)], ['1406/1/1', '1406/12/29']);
  assert.deepEqual(found.consumed.map(({ index, length }) => text.slice(index, index + length)), ['۱۴۰۶']);
  const range = 'بیمه از آبان ۰۵ تا مهر ۰۶، ۲۴ میلیون';
  assert.deepEqual(readServicePeriod(range, { occurredAt: NOW }).consumed.map(({ index, length }) => range.slice(index, index + length)), ['۰۵', '۰۶']);
  // عددی که سال نیست، جای سال گزارش نمی‌شود.
  assert.equal(readServicePeriod('اجاره دفتر از مهر تا اسفند ۶۰ میلیون پرداخت شد', { occurredAt: NOW }).consumed, undefined);
});

test('سالِ تاریخ پرداخت کنار مبلغ: در مبلغ جمع نمی‌شود', () => {
  for (const [text, date] of [
    ['۵ مهر ۹۹ ۱۲ میلیون خرید کردیم', '1399/7/5'],
    ['۵ مهر ۰۵ ۱۲ میلیون اجاره دادیم', '1405/7/5'],
    ['۵ مهر ۱۴۰۵ ۱۲ میلیون اجاره دادیم', '1405/7/5'],
    ['5 مهر 1404 12 میلیون اجاره دادیم', '1404/7/5'],
  ]) {
    const [row] = parsed(text);
    assert.deepEqual([fa(row.occurredAt), row.amount], [date, 12_000_000], text);
  }
  // عددی که سال نیست، مبلغ می‌ماند.
  assert.equal(parsed('پنجم مهر ۹۹ میلیون فروش داشتیم')[0].amount, 99_000_000);
});

// ---------------------------------------------------------------------------
// ماهِ نسبی بعد از «رو»، صفت طول یا ماهِ نام‌برده زمان پرداخت است، نه پوشش
// ---------------------------------------------------------------------------

test('ماهِ نسبی بعد از «رو» یا صفت طول: روز پرداخت می‌ماند (جمله‌های بازبین)', () => {
  // [جمله، روز پرداخت، دوره (یا null یعنی پرسیده می‌شود)]
  for (const [text, paid, expected] of [
    ['اجاره آبان رو ماه پیش ۱۰ میلیون دادیم', '1405/6/18', ['1405/8/1', '1405/8/30']],
    ['بیمه یکساله ماه پیش ۱۲ میلیون دادیم', '1405/6/18', ['1405/6/18', '1406/6/17']],
    ['اجاره رو ماه پیش ۱۰ میلیون دادیم', '1405/6/18', null],
    ['اشتراک یکساله رو ماه گذشته ۲۴ میلیون دادیم', '1405/6/18', ['1405/6/18', '1406/6/17']],
  ]) {
    assert.equal(occurrence(text), paid, text);
    const [row] = parsed(text);
    assert.equal(fa(row.occurredAt), paid, `${text} — مسیر پارسر`);
    assert.deepEqual(row.servicePeriodStart ? [fa(row.servicePeriodStart), fa(row.servicePeriodEnd)] : null, expected, text);
  }
  // «اجاره رو ماه پیش دادیم»: دوره حدس زده نمی‌شود.
  assert.equal(voice('اجاره رو ماه پیش ۱۰ میلیون دادیم').items[0].fact, 'servicePeriodStart');
});

test('ماهِ نسبی: پولِ آینده پیش‌پرداخت قطعی نمی‌شود', () => {
  for (const text of ['اجاره دفتر رو ماه بعد ۱۰ میلیون میدیم', 'اجاره رو ماه بعد میدیم ۱۰ میلیون', 'شارژ ساختمان رو ماه آینده ۲ میلیون میدیم']) {
    assert.equal(readServicePeriod(text, { occurredAt: NOW }), null, text);
    // «ماه بعد» زمانِ پرداخت است، نه پوشش؛ پیش‌پرداختِ امروز ساخته نمی‌شود.
    assert.equal(occurrence(text), '1405/8/18', text);
    for (const item of voice(text).items) {
      assert.equal((item.plan?.lines || []).some((line) => line.role === 'prepaid-asset'), false, text);
    }
  }
  assert.equal(voice('اجاره دفتر رو ماه بعد ۱۰ میلیون میدیم').items[0].fact, 'servicePeriodStart');
});

test('ماهِ نسبی: مسیر تسویه روز پرداخت را نگه می‌دارد (جمله‌های بازبین)', () => {
  const now = new Date(NOW);
  for (const text of [
    'بدهی اجاره رو ماه پیش ۱۰ میلیون به آقای رضایی تسویه کردیم',
    'بدهی اجاره رو ماه قبل ۱۰ میلیون به آقای رضایی تسویه کردیم',
    'بدهی اجاره رو ماه گذشته ۱۰ میلیون به آقای رضایی تسویه کردیم',
  ]) {
    const intent = detectSettleIntent(text, { now });
    assert.ok(intent, text);
    assert.equal(fa(intent.occurredAt), '1405/6/18', text);
  }
});

test('ماهِ نسبی: شکل‌های هم‌ارز و نمونه‌های منفی', () => {
  // پشت نام خدمت، با کسره، با مکان یا موضوع، با صفت دوره‌ای، با «برای»: پوشش است.
  for (const [text, expected] of [
    ['اجاره ماه پیش رو ۱۰ میلیون دادیم', ['1405/6/1', '1405/6/31']],
    ['اجاره‌ی ماه قبل ۱۰ میلیون دادیم', ['1405/6/1', '1405/6/31']],
    ['اجارهٔ ماه قبل ۱۰ میلیون دادیم', ['1405/6/1', '1405/6/31']],
    ['اجاره دفتر ماه قبل ۱۰ میلیون دادیم', ['1405/6/1', '1405/6/31']],
    ['کرایه مغازه ماه بعد ۵ میلیون دادیم', ['1405/8/1', '1405/8/30']],
    ['بیمه شخص ثالث ماه بعد ۲ میلیون دادیم', ['1405/8/1', '1405/8/30']],
    ['اجاره ماهانه ماه بعد رو ۱۰ میلیون دادیم', ['1405/8/1', '1405/8/30']],
    ['اجاره دفتر برای ماه بعد ۱۰ میلیون دادیم', ['1405/8/1', '1405/8/30']],
    ['اقای رضایی اجاره ماه قبل رو گرفت ۱۰ میلیون', ['1405/6/1', '1405/6/31']],
  ]) {
    assert.deepEqual(period(text), expected, text);
    assert.equal(occurrence(text), null, `${text} — ماهِ خدمت روز پرداخت نیست`);
  }
  // بعد از «رو/را»، صفت طول یا ماهِ نام‌برده: زمان پرداخت.
  for (const [text, paid] of [
    ['اجاره را ماه قبل ۱۰ میلیون دادیم', '1405/6/18'],
    ['اجاره دفتر رو ماه گذشته ۱۰ میلیون پرداخت کردیم', '1405/6/18'],
    ['اجاره آبان ماه پیش ۱۰ میلیون دادیم', '1405/6/18'],
    ['اجاره شش ماهه ماه قبل ۳۰ میلیون دادیم', '1405/6/18'],
    ['بیمه یک ساله ماه قبل 12 میلیون دادیم', '1405/6/18'],
    ['ماه پیش اجاره ۱۰ میلیون دادیم', '1405/6/18'],
  ]) assert.equal(occurrence(text), paid, text);
});

// ---------------------------------------------------------------------------
// فهرست ماه‌ها یک بازه است، نه ماه اولش
// ---------------------------------------------------------------------------

test('فهرست ماه‌ها: کل فهرست بازه است (جمله‌های بازبین)', () => {
  for (const [text, expected] of [
    ['اجاره این ماه و ماه بعد رو ۲۰ میلیون دادیم', ['1405/7/1', '1405/8/30']],
    ['اجاره همین ماه و ماه بعد ۲۰ میلیون دادیم', ['1405/7/1', '1405/8/30']],
    ['اجاره ماه بعد و ماه بعدش رو ۲۰ میلیون دادیم', ['1405/8/1', '1405/9/30']],
    ['اجاره مهر و آبان و آذر رو ۳۰ میلیون دادیم', ['1405/7/1', '1405/9/30']],
  ]) {
    assert.deepEqual(period(text), expected, text);
    const [row] = parsed(text);
    assert.deepEqual([fa(row.servicePeriodStart), fa(row.servicePeriodEnd)], expected, `${text} — مسیر پارسر`);
    assert.equal(row.occurredAt, undefined, `${text} — پرداخت امروز است، نه ماه بعد`);
    const [item] = voice(text).items;
    assert.equal(item.decision.treatment, 'prepaid-expense', text);
  }
});

test('فهرست ماه‌ها: شکل‌های هم‌ارز و نمونه‌های منفی', () => {
  for (const [text, expected] of [
    ['اجاره مهر و آبان ۲۰ میلیون دادیم', ['1405/7/1', '1405/8/30']],
    ['اجاره مهر ماه و آبان ماه ۲۰ میلیون دادیم', ['1405/7/1', '1405/8/30']],
    ['بابت اجاره مهر، آبان و آذر ۳۰ میلیون دادیم', ['1405/7/1', '1405/9/30']],
    ['اجاره اسفند و فروردین ۲۰ میلیون دادیم', ['1405/12/1', '1406/1/31']],
    ['شارژ این ماه و ماه بعدش ۴ میلیون دادیم', ['1405/7/1', '1405/8/30']],
    ['اجاره ماه قبل و این ماه ۲۰ میلیون دادیم', ['1405/6/1', '1405/7/30']],
    ['اجاره ابان و اذر ۲۰ میلیون دادیم', ['1405/8/1', '1405/9/30']],
    ['مستاجر اجاره این ماه و ماه بعد رو ۲۰ میلیون داد', ['1405/7/1', '1405/8/30']],
  ]) assert.deepEqual(period(text), expected, text);
  // فهرستِ ناپیوسته خوانده نمی‌شود: نه یک ماهش، نه بازهٔ حدسی.
  for (const text of [
    'اجاره مهر و آذر ۲۰ میلیون دادیم',
    'اجاره آبان و مهر ۲۰ میلیون دادیم',
    // «این ماه و سه ماه آینده» چهار ماه است یا سه؟ پرسیده می‌شود.
    'اجاره این ماه و دو ماه بعد ۲۰ میلیون دادیم',
    'اجاره این ماه و سه ماه آینده ۴۰ میلیون دادیم',
  ]) assert.equal(period(text), null, text);
  assert.equal(voice('اجاره مهر و آذر ۲۰ میلیون دادیم').items[0].fact, 'servicePeriodStart');
  // «و» که ماه نمی‌آورد فهرست نیست.
  assert.deepEqual(period('اجاره مهر و آب و برق ۱۲ میلیون دادیم'), ['1405/7/1', '1405/7/30']);
  assert.deepEqual(period('اجاره مهر ۱۰ میلیون دادیم'), ['1405/7/1', '1405/7/30']);
});

// ---------------------------------------------------------------------------
// طولِ مرکب: «یک سال و شش ماه»، «یک سال و نیم»
// ---------------------------------------------------------------------------

test('طول مرکب: یک طول است، نه یک سال (جمله‌های بازبین)', () => {
  for (const [text, expected] of [
    ['اشتراک نرم افزار به مدت یک سال و شش ماه ۱۸ میلیون دادیم', [TODAY, '1407/1/17']],
    ['اجاره دفتر یک سال و سه ماهه ۱۵ میلیون دادیم', [TODAY, '1406/10/17']],
  ]) {
    assert.deepEqual(period(text), expected, text);
    const [row] = parsed(text);
    assert.deepEqual([fa(row.servicePeriodStart), fa(row.servicePeriodEnd)], expected, `${text} — مسیر پارسر`);
  }
  // «نیم» پشتِ عدد مبلغ را خوانندهٔ مبلغ ۱۸٫۵ می‌خواند؛ تا آن درست نشده، ثبت خودکار نمی‌شود.
  for (const text of ['اجاره دفتر برای یک سال و نیم ۱۸ میلیون دادیم', 'اجاره دفتر از اول آبان یک سال و نیم ۱۸ میلیون دادیم']) {
    assert.equal(period(text), null, text);
    assert.notEqual(voice(text).items[0].outcome, 'post', text);
  }
  // نیم‌ماه برنامهٔ ماهانه ندارد: پرسیده می‌شود، نه سه ماه.
  assert.equal(period('اجاره دفتر برای سه ماه و نیم ۳۵ میلیون دادیم'), null);
  assert.equal(voice('اجاره دفتر برای سه ماه و نیم ۳۵ میلیون دادیم').items[0].fact, 'servicePeriodStart');
});

test('طول مرکب: شکل‌های هم‌ارز و نمونه‌های منفی', () => {
  for (const [text, expected] of [
    ['اجاره دفتر برای یک سال و نیم، ۱۸ میلیون دادیم', [TODAY, '1407/1/17']],
    ['اجاره دفتر از اول آبان یک سال و نیم مبلغ ۱۸ میلیون دادیم', ['1405/8/1', '1407/1/31']],
    ['اشتراک یکساله و شش ماهه ۱۸ میلیون دادیم', [TODAY, '1407/1/17']],
    ['اجاره دفتر یک سال و شش ماه آینده رو ۱۸ میلیون دادیم', [TODAY, '1407/1/17']],
    ['بیمه به مدت 1 سال و 6 ماه 18 میلیون دادیم', [TODAY, '1407/1/17']],
    ['اشتراک برای دو سال و نیم، ۳۰ میلیون دادیم', [TODAY, '1408/1/17']],
  ]) assert.deepEqual(period(text), expected, text);
  for (const text of ['اجاره مهر برای سه ماه و نیم ۳۵ میلیون دادیم', 'بیمه یک سال و ۱۸ ماه ۱۲ میلیون دادیم']) assert.equal(period(text), null, text);
  assert.equal(readServiceLength('سه ماه و نیم', { bare: true }), null);
  assert.equal(readServiceLength('یک سال و نیم', { bare: true }).months, 18);
  // «یک سال و» بی‌طولِ دوم همان یک سال است.
  assert.deepEqual(period('بیمه یکساله و ۱۲ میلیون دادیم'), [TODAY, '1406/7/17']);
});

test('طول مرکب: جواب سؤال پایان همان قاعده را دارد', () => {
  const mehr = { occurredAt: NOW, servicePeriodStart: persianToISO(1405, 7, 1) };
  const end = (freeText) => fa(applyAnswer(mehr, { fact: 'servicePeriodEnd', value: 'custom', freeText }, { today: NOW }).servicePeriodEnd);
  assert.equal(end('یک سال و نیم'), '1406/12/29');
  assert.equal(end('یک سال و شش ماه'), '1406/12/29');
  assert.equal(end('یک سال و سه ماهه'), '1406/9/30');
  assert.equal(end('دو سال و نیم'), '1407/12/29');
  assert.throws(() => end('سه ماه و نیم'), { code: 'ANSWER_DATE_INVALID' });
  const start = applyAnswer({ occurredAt: NOW }, { fact: 'servicePeriodStart', value: 'custom', freeText: 'یک سال و نیم از مهر' }, { today: NOW });
  assert.deepEqual([fa(start.servicePeriodStart), fa(start.servicePeriodEnd)], ['1405/7/1', '1406/12/29']);
});

// ---------------------------------------------------------------------------
// صفت طول در جملهٔ خدمت زمان تحویل نیست؛ «حمل» در نام خدمت نشانهٔ تحویل نیست
// ---------------------------------------------------------------------------

test('زمان تحویل: صفت طولِ خدمت دوره است (جمله‌های بازبین)', () => {
  for (const [text, expected] of [
    ['اجاره کامیون حمل بار یکساله ۱۲۰ میلیون دادیم', [TODAY, '1406/7/17']],
    ['بیمه حمل و نقل یکساله ۱۲ میلیون دادیم', [TODAY, '1406/7/17']],
    ['بیمه نامه یکساله رو تحویل گرفتیم ۱۲ میلیون دادیم', [TODAY, '1406/7/17']],
    ['اجاره شش ماهه تحویل کلید ۶۰ میلیون دادیم', [TODAY, '1406/1/17']],
    ['لایسنس یکساله میاد ۲۴ میلیون دادیم', [TODAY, '1406/7/17']],
    ['بیمه حمل سه ماه آینده ۹ میلیون دادیم', [TODAY, '1405/10/17']],
  ]) {
    assert.deepEqual(period(text), expected, text);
    const [item] = voice(text).items;
    assert.equal(item.outcome, 'post', text);
    assert.equal(item.decision.treatment, 'prepaid-expense', `${text} — یازده ماه آینده همین امروز هزینه نمی‌شود`);
  }
});

test('زمان تحویل: شکل‌های هم‌ارز و نمونه‌های منفی', () => {
  for (const [text, expected] of [
    ['بیمه حمل بار یکساله ۶ میلیون دادیم', [TODAY, '1406/7/17']],
    ['اجاره وانت حمل یک ساله ۶۰ میلیون دادیم', [TODAY, '1406/7/17']],
    ['اجاره دفتر شش ماهه، کلید رو تحویل گرفتیم ۳۰ میلیون دادیم', [TODAY, '1406/1/17']],
  ]) assert.deepEqual(period(text), expected, text);
  // زمانِ تحویلِ کالا همچنان دوره نیست — با صفت، با «بعد» و با «حمل» به‌عنوان فعل.
  for (const text of [
    '۳۰ میلیون دادیم برای پارچه که سه ماهه تحویل میدن',
    '۳۰ میلیون به تولیدی دادیم برای پارچه که سه ماه بعد حمل میشه',
    '۳۰ میلیون به تولیدی نوری دادیم برای پارچه که سه ماه بعد تحویل میده',
    'لایسنس سه ماه بعد میاد ۲۴ میلیون دادیم',
  ]) assert.equal(period(text), null, text);
});

// ===== دفتر =====

process.env.DATABASE_PATH = tempDatabase('engine5-p2-period-review');
process.env.ADMIN_USERNAME = 'period-review-owner';
process.env.ADMIN_PASSWORD = 'period-review-strong-password-5521';
const database = await import('../server/db.js');
const store = await import('../server/financialEventStore.js');
database.ensureAdmin();
const owner = database.authenticateUser('period-review-owner', 'period-review-strong-password-5521');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر بازبینی دوره', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

let sequence = 0;
/** همان راهی که ردیف صوتی تا صف می‌رود: پارسر، تصمیم، رویداد منتظر. */
function captured(text) {
  const [row] = parsed(text);
  const draft = transactionEventDecision({ ...row, occurredAt: row.occurredAt || NOW, accountId: 'cash' }, { transcript: text, policy: { engineV2: true } });
  sequence += 1;
  return store.recordFinancialEvent(db(), draft.event, {
    sourceEventId: `p2-period-review:${sequence}`, decision: draft.decision, actor: owner.id, accountingDecision: draft.accountingDecision,
  });
}
const periodKeys = (id) => store.scheduleForEvent(db(), id).map((item) => [item.periodKey, item.amount]);
const answer = (id, body) => store.answerEventQuestion(db(), id, { ...body, actor: owner.id });

test('آماده‌سازی دفتر: موتور روشن', () => inWorkspace(() => {
  database.installChartTemplate();
  database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all' });
  database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 500_000_000 });
}));

test('دفتر: فهرست ماه‌ها برنامهٔ ماه‌به‌ماه می‌سازد، نه هزینهٔ یک‌جا', () => inWorkspace(() => {
  for (const [text, keys] of [
    ['اجاره این ماه و ماه بعد رو ۲۰ میلیون دادیم', [['1405-07', 10_000_000], ['1405-08', 10_000_000]]],
    ['اجاره ماه بعد و ماه بعدش رو ۲۰ میلیون دادیم', [['1405-08', 10_000_000], ['1405-09', 10_000_000]]],
    ['اجاره مهر و آبان و آذر رو ۳۰ میلیون دادیم', [['1405-07', 10_000_000], ['1405-08', 10_000_000], ['1405-09', 10_000_000]]],
  ]) {
    const event = captured(text);
    assert.equal(store.decisionForEvent(db(), event.id).treatment, 'prepaid-expense', text);
    assert.deepEqual(periodKeys(event.id), keys, text);
  }
}));

test('دفتر: طول مرکب هجده قسط می‌سازد', () => inWorkspace(() => {
  const event = captured('اشتراک نرم افزار به مدت یک سال و شش ماه ۱۸ میلیون دادیم');
  const keys = periodKeys(event.id);
  assert.equal(keys.length, 18);
  assert.deepEqual([keys[0][0], keys.at(-1)[0]], ['1405-07', '1406-12']);
  assert.equal(keys.reduce((sum, [, amount]) => sum + amount, 0), 18_000_000);
}));

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
const lastScheduleKeys = () => db().prepare('SELECT period_key AS key FROM recognition_schedule_items WHERE event_id=(SELECT event_id FROM recognition_schedule_items ORDER BY rowid DESC LIMIT 1) ORDER BY period_key').all().map((row) => row.key);

let aiSequence = 0;
async function understood(text, { amount, evidence, what }) {
  modelSaid(text, { amount, evidence, what });
  aiSequence += 1;
  return database.createUnderstandingCase({ text, clientId: `p2-review-ai-${aiSequence}` }, aiOptions);
}

test('دفتر، مسیر فهم: فهرست ماه‌ها و طول مرکب همان دورهٔ مسیر قطعی', async () => {
  await inWorkspace(async () => {
    for (const [text, amount, evidence, what, keys] of [
      ['اجاره این ماه و ماه بعد رو ۲۰ میلیون از حساب تجارت دادیم', 20_000_000, '۲۰ میلیون', 'اجاره', ['1405-07', '1405-08']],
      ['اشتراک نرم افزار به مدت یک سال و شش ماه ۱۸ میلیون از حساب تجارت دادیم', 18_000_000, '۱۸ میلیون', 'اشتراک نرم افزار',
        ['1405-07', '1405-08', '1405-09', '1405-10', '1405-11', '1405-12', '1406-01', '1406-02', '1406-03', '1406-04', '1406-05', '1406-06', '1406-07', '1406-08', '1406-09', '1406-10', '1406-11', '1406-12']],
    ]) {
      const item = await understood(text, { amount, evidence, what });
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify(item.plan?.questions)}`);
      database.commitUnderstandingCase(item.id, { now: new Date(NOW) });
      assert.deepEqual(lastScheduleKeys(), keys, text);
    }
  });
});
