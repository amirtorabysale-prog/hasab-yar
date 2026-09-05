import test from 'node:test';
import assert from 'node:assert/strict';
import { clock, persianDate } from '../src/lib/format.js';

// این توابع داخل رندر صدا زده می‌شوند. Intl.format روی رشته خطا می‌دهد و چون
// هیچ error boundaryای بالای این صفحه‌ها نیست، همان خطا کل برنامه را سفید
// می‌کرد — دقیقاً همان اتفاقی که در کارتابل سند و صفحهٔ همکاری می‌افتاد.
const iso = '2026-09-04T10:00:00.000Z';

test('تاریخ شمسی رشتهٔ ISO را می‌پذیرد', () => {
  const fromString = persianDate(iso);
  const fromDate = persianDate(new Date(iso));
  assert.equal(fromString, fromDate);
  assert.ok(fromString.length > 0);
  assert.notEqual(fromString, '—');
});

test('ساعت هم رشتهٔ ISO و هم Date را می‌پذیرد', () => {
  assert.equal(clock(iso), clock(new Date(iso)));
  assert.notEqual(clock(iso), '—');
});

test('مقدار نامعتبر به‌جای انداختن خطا، خط تیره برمی‌گرداند', () => {
  for (const value of [null, undefined, '', 'تاریخ نیست', Number.NaN, new Date('نامعتبر')]) {
    assert.doesNotThrow(() => persianDate(value));
    assert.doesNotThrow(() => clock(value));
  }
  assert.equal(persianDate(null), '—');
  assert.equal(persianDate('تاریخ نیست'), '—');
  assert.equal(clock(''), '—');
});

test('بدون آرگومان همچنان تاریخ امروز را می‌دهد', () => {
  assert.notEqual(persianDate(), '—');
});
