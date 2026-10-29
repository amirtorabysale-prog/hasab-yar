// انتخاب‌گر سریع تاریخ (shared/quickDate.js): هر شکل گفتن و نوشتن تاریخ، به جهت فیلد.
//
// «امروز» آزمون: ۷ آبان ۱۴۰۵ (۲۹ اکتبر ۲۰۲۶).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gregorianDate, isoToValue, jalaliOf, jalaliSlash, monthGrid, monthLength, parseQuickDate, quickPresets, relativeLabel, valueToISO,
} from '../shared/quickDate.js';

const now = new Date('2026-10-29T08:00:00Z');
const read = (text, direction = 'any') => {
  const parsed = parseQuickDate(text, { now, direction });
  return parsed ? jalaliSlash(parsed) : null;
};

test('روز تنها: نزدیک‌ترین روز به جهت فیلد', () => {
  assert.equal(read('25', 'past'), '1405/07/25');
  assert.equal(read('25', 'future'), '1405/08/25');
  assert.equal(read('25', 'any'), '1405/08/25');
  assert.equal(read('5', 'past'), '1405/08/05');
  assert.equal(read('7', 'past'), '1405/08/07');
  assert.equal(read('5', 'future'), '1405/09/05');
  // ماه‌های سی‌روزه ۳۱ ندارند: ۳۱ گذشته یعنی شهریور.
  assert.equal(read('31', 'past'), '1405/06/31');
  assert.equal(read('31', 'any'), null);
});

test('رقم فارسی، عربی و لاتین یکی است', () => {
  assert.equal(read('۲۵', 'past'), '1405/07/25');
  assert.equal(read('٢٥', 'past'), '1405/07/25');
  assert.equal(read('۱۴۰۵/۰۲/۲۵'), '1405/02/25');
});

test('روز و ماه: فاصله ترتیب گفتن است، ممیز ترتیب نوشتن', () => {
  assert.equal(read('25 2', 'past'), '1405/02/25');
  assert.equal(read('۲/۲۵', 'past'), '1405/02/25');
  assert.equal(read('2-25', 'past'), '1405/02/25');
  // آذر هنوز نیامده؛ در فیلد گذشته، آذر پارسال است.
  assert.equal(read('10 9', 'past'), '1404/09/10');
  assert.equal(read('10 9', 'future'), '1405/09/10');
  assert.equal(read('۲۵ اردیبهشت', 'past'), '1405/02/25');
  assert.equal(read('اردیبهشت', 'past'), '1405/02/01');
});

test('سال کامل یا دورقمی؛ ۳۰ اسفند فقط در سال کبیسه', () => {
  assert.equal(read('1403/12/30'), '1403/12/30');
  assert.equal(read('03/12/30'), '1403/12/30');
  assert.equal(read('1404/12/30'), null);
  assert.equal(read('1405/7/31'), null);
  assert.equal(monthLength(1403, 12), 30);
  assert.equal(monthLength(1404, 12), 29);
});

test('نسبت به امروز: واژه، تعداد روز و علامت', () => {
  assert.equal(read('امروز'), '1405/08/07');
  assert.equal(read('دیروز', 'past'), '1405/08/06');
  assert.equal(read('پریروز', 'past'), '1405/08/05');
  assert.equal(read('فردا', 'future'), '1405/08/08');
  assert.equal(read('پس فردا', 'future'), '1405/08/09');
  assert.equal(read('پس‌فردا', 'future'), '1405/08/09');
  assert.equal(read('3 روز پیش', 'past'), '1405/08/04');
  assert.equal(read('سه روز پیش', 'past'), '1405/08/04');
  assert.equal(read('دو هفته بعد', 'future'), '1405/08/21');
  assert.equal(read('-3'), '1405/08/04');
  assert.equal(read('+10'), '1405/08/17');
  assert.equal(read('+۱۰'), '1405/08/17');
});

test('چیزی که خوانده نشود null است، نه امروز', () => {
  for (const text of ['', 'abc', '1405', '32', '25 13', '0', 'سلام']) assert.equal(read(text), null, text);
});

test('میان‌برها به جهت فیلد', () => {
  const past = quickPresets('past', now).map((preset) => [preset.label, jalaliSlash(jalaliOf(preset.iso))]);
  assert.deepEqual(past, [['امروز', '1405/08/07'], ['دیروز', '1405/08/06'], ['پریروز', '1405/08/05'], ['اول ماه', '1405/08/01'], ['آخر ماه قبل', '1405/07/30']]);
  const future = quickPresets('future', now).map((preset) => [preset.label, jalaliSlash(jalaliOf(preset.iso))]);
  assert.deepEqual(future, [['امروز', '1405/08/07'], ['فردا', '1405/08/08'], ['یک هفته بعد', '1405/08/14'], ['آخر ماه', '1405/08/30'], ['ماه بعد', '1405/09/07']]);
});

test('تقویم ماه از شنبه شروع می‌شود و همهٔ روزهای ماه را دارد', () => {
  const grid = monthGrid(1405, 8);
  assert.equal(grid.length % 7, 0);
  // ۱ آبان ۱۴۰۵ جمعه است: شش روز از مهر پیش از آن.
  assert.equal(grid.findIndex((cell) => !cell.outside), 6);
  assert.equal(grid.filter((cell) => !cell.outside).length, 30);
  const esfand = monthGrid(1403, 12).filter((cell) => !cell.outside);
  assert.equal(esfand.at(-1).day, 30);
});

test('قالب‌های مقدار بیرونی: ISO، روز میلادی و متن شمسی', () => {
  const iso = parseQuickDate('25 2', { now, direction: 'past' }).iso;
  assert.equal(isoToValue(iso, 'date'), '2026-05-15');
  assert.equal(isoToValue(iso, 'jalali'), '1405/02/25');
  assert.equal(isoToValue(iso, 'iso'), iso);
  assert.equal(jalaliSlash(jalaliOf(valueToISO('2026-05-15', 'date'))), '1405/02/25');
  assert.equal(jalaliSlash(jalaliOf(valueToISO('۱۴۰۵/۰۲/۲۵', 'jalali'))), '1405/02/25');
  assert.equal(valueToISO('', 'date'), '');
  assert.equal(valueToISO('nonsense', 'jalali'), '');
  // روز میلادی همان روز تهران می‌ماند، حتی نزدیک نیمه‌شب.
  assert.equal(gregorianDate('2026-10-28T21:00:00Z'), '2026-10-29');
});

test('برچسب نسبی فقط تا یک ماه', () => {
  assert.equal(relativeLabel('2026-10-29T08:30:00Z', now), 'امروز');
  assert.equal(relativeLabel('2026-10-26T08:30:00Z', now), '3 روز پیش');
  assert.equal(relativeLabel('2026-10-31T08:30:00Z', now), 'پس‌فردا');
  assert.equal(relativeLabel('2026-01-01T08:30:00Z', now), '');
});
