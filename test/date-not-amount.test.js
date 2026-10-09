import test from 'node:test';
import assert from 'node:assert/strict';

import { extractAmounts, parseFinancialText } from '../shared/parser.js';
import { normalizeSpokenYears, todayPersian } from '../shared/persianDate.js';

/**
 * تاریخ، مبلغ نیست — گزارش کاربر، مهر ۱۴۰۵.
 *
 * «امروز ۲۴ میلیون… اشتراک یکساله… از اول آبان ۱۴۰۵ تا پایان مهر ۱۴۰۶» روی
 * برگهٔ تأیید دو تراکنش ساخت: ۲۴ میلیون، و «۱٬۴۰۶ تومان» با دستهٔ حمل‌ونقل. همان
 * جمله دورهٔ پوشش را هم از روز پرداخت ساخت، نه از اول آبان، و تاریخ پرداخت را
 * از کاربر پرسید با اینکه «امروز» گفته بود.
 */

const NOW = new Date('2026-10-08T09:00:00.000Z'); // ۱۶ مهر ۱۴۰۵
const parse = (text) => parseFinancialText(text, { source: 'voice', now: NOW }).transactions;
const amounts = (text) => extractAmounts(text).spans.map((span) => span.amount);
const fa = (iso) => { const p = todayPersian(new Date(iso)); return `${p.year}/${p.month}/${p.day}`; };

test('جملهٔ گزارش کاربر: یک تراکنش، دورهٔ درست، تاریخ پرداخت امروز', () => {
  const rows = parse('امروز ۲۴ میلیون تومان از بانک صادرات بابت اشتراک یکساله نرم‌افزار حسابداری پرداخت کردم؛ از اول آبان ۱۴۰۵ تا پایان مهر ۱۴۰۶. فقط حق استفاده یکساله داریم و مالک نرم‌افزار نمی‌شویم.');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 24_000_000);
  assert.equal(fa(rows[0].servicePeriodStart), '1405/8/1');
  assert.equal(fa(rows[0].servicePeriodEnd), '1406/7/30');
  assert.equal(fa(rows[0].occurredAt), '1405/7/16', '«امروز» تاریخ پرداخت است، نه اول آبان');
});

test('سالِ پس از نام ماه، «سال» یا «ماه»، مبلغ نیست', () => {
  assert.deepEqual(amounts('اجاره دی ماه ۱۴۰۴ رو ده میلیون دادیم'), [10_000_000]);
  assert.deepEqual(amounts('مالیات عملکرد سال ۱۴۰۴ رو بیست میلیون تومان پرداخت کردیم'), [20_000_000]);
  assert.deepEqual(amounts('قرارداد مورخ ۱۴۰۵ شمسی، پنج میلیون'), [5_000_000]);
});

test('سال با حروف هم سال است، و ویرگول دو عدد را از هم جدا می‌کند', () => {
  const text = 'بیمه از اول مهر هزار و چهارصد و پنج تا آخر شهریور هزار و چهارصد و شش، دوازده میلیون دادیم';
  assert.deepEqual(amounts(text), [12_000_000]);
  const [row] = parse(text);
  assert.equal(fa(row.servicePeriodStart), '1405/7/1');
  assert.equal(fa(row.servicePeriodEnd), '1406/6/31');
  assert.equal(normalizeSpokenYears('از اول مهر هزار و چهارصد و پنج'), 'از اول مهر 1405');
  assert.equal(normalizeSpokenYears('هزار و چهارصد تومان دادم'), 'هزار و چهارصد تومان دادم', 'بدون نام ماه یا «سال» دست نمی‌خورد');
});

test('تاریخ عددی کامل مبلغ نیست؛ عدد با جداکنندهٔ هزارگان مبلغ می‌ماند', () => {
  assert.deepEqual(amounts('به تاریخ ۱۴۰۵/۰۷/۱۵ ده میلیون تومان اجاره دفتر دادیم'), [10_000_000]);
  assert.deepEqual(amounts('تاریخ 15-7-1405 هشت میلیون فروش داشتیم'), [8_000_000]);
  assert.deepEqual(amounts('2.500.000 تومان قبض برق دادم'), [2_500_000]);
  assert.deepEqual(amounts('2,500,000 تومان قبض برق دادم'), [2_500_000]);
});

test('«نه» پیش از عدد رقمی حرف نفی است، نه «۹»', () => {
  // آزمون زندهٔ فهم رویداد، ۱۷ مهر ۱۴۰۵: «۱۶، نه ۱۸ میلیون» ۲۷ میلیون خوانده می‌شد.
  assert.deepEqual(amounts('فاکتور رو ۱۶، نه ۱۸ میلیون از بانک ملت پرداخت کردیم'), [18_000_000]);
  assert.deepEqual(amounts('اجاره نه ۱۵ میلیون شد'), [15_000_000]);
  assert.deepEqual(amounts('نه میلیون تومان دادیم'), [9_000_000], '«نه میلیون» همان نُه میلیون است');
  assert.deepEqual(amounts('نه و نیم میلیون کرایه دادیم'), [9_500_000]);
});

test('عدد سال‌مانند با واحد پول، مبلغ است', () => {
  assert.deepEqual(amounts('۱۴۰۵ تومان پول پارکینگ دادم'), [1_405]);
  assert.deepEqual(amounts('هزار و چهارصد تومان کرایه تاکسی دادم'), [1_400]);
  // روز ماه پیش از نام ماه از قبل کنار گذاشته می‌شد و همچنان می‌شود.
  assert.deepEqual(amounts('سه میلیون فروش داشتیم ۲۵ مرداد'), [3_000_000]);
});
