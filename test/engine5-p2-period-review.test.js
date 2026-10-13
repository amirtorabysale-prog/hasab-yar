import test from 'node:test';
import assert from 'node:assert/strict';
import { runVoice } from './helpers/voicePipeline.js';
import { extractOccurrenceDate, todayPersian } from '../shared/persianDate.js';
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
