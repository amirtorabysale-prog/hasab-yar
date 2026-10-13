import test from 'node:test';
import assert from 'node:assert/strict';
import { runVoice } from './helpers/voicePipeline.js';
import { extractOccurrenceDate, spokenYear, todayPersian } from '../shared/persianDate.js';
import { readServicePeriod } from '../shared/periodSpeech.js';
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
