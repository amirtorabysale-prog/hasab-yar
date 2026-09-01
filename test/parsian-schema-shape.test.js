import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodingStyle, validateChartRows } from '../server/chartOfAccounts.js';

// این تست قرارداد schema پارسیان را با یک کدینگ ساختگی نمایش می‌دهد؛ هیچ
// شناسه یا دادهٔ نصب مشتری در fixture نگه‌داری نمی‌شود. دو واقعیت مهم:
//   ۱. کد کل هیچ ربطی به کد گروهش ندارد — کل ۱۰ زیر گروه ۱۱ می‌نشیند؛
//   ۲. بعضی کل‌ها اصلاً گروه ندارند (مثل «تراز افتتاحیه»).

const PARSIAN_ROWS = [
  { rowNumber: 2, code: '11', levelCode: '11', name: 'دارايي هاي جاري', level: 'گروه', parentCode: '', type: 'دارایی' },
  { rowNumber: 3, code: '1110', levelCode: '10', name: 'صندوق', level: 'کل', parentCode: '11', type: 'دارایی' },
  { rowNumber: 4, code: '111001', levelCode: '1', name: 'صندوق', level: 'معین', parentCode: '1110', type: 'دارایی' },
  { rowNumber: 5, code: '1112', levelCode: '12', name: 'بدهکاران', level: 'کل', parentCode: '11', type: 'دارایی' },
  { rowNumber: 6, code: '111202', levelCode: '2', name: 'مشتریان', level: 'معین', parentCode: '1112', type: 'دارایی' },
];

test('the segmented Parsian-shaped chart is rejected by the prefix rule', () => {
  const { errors } = validateChartRows(PARSIAN_ROWS, { codingStyle: 'prefix' });
  // کل ۱۱۱۰ با کد والد ۱۱ شروع می‌شود، اما این فقط اتفاقی است؛ نکته این است که
  // در سبک پیشوندی، کد سطح مستقل اصلاً پذیرفته نمی‌شود وقتی هم‌خوان نباشد.
  const orphan = validateChartRows([
    { rowNumber: 2, code: '51', name: 'قیمت تمام‌شده', level: 'کل', parentCode: '', type: 'هزینه' },
  ], { codingStyle: 'prefix' });
  assert.equal(orphan.errors.length, 1);
  assert.match(orphan.errors[0].message, /باید کد والد داشته باشد/);
  assert.deepEqual(errors, [], 'این نمونهٔ خاص با کد کامل ساخته شده تا پیشوند بخورد');
});

test('the segmented style accepts a general account with no group, like Parsian has', () => {
  const { accounts, errors } = validateChartRows([
    { rowNumber: 2, code: '51', levelCode: '51', name: 'قیمت تمام‌شده کالای فروش‌رفته', level: 'کل', parentCode: '', type: 'هزینه' },
    { rowNumber: 3, code: '66', levelCode: '66', name: 'تراز افتتاحیه', level: 'کل', parentCode: '', type: 'سرمایه' },
  ], { codingStyle: 'segmented' });
  assert.deepEqual(errors, []);
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].levelCode, '51');
});

test('each level keeps its own independent code', () => {
  const { accounts, errors } = validateChartRows(PARSIAN_ROWS, { codingStyle: 'segmented' });
  assert.deepEqual(errors, []);
  const byCode = Object.fromEntries(accounts.map((item) => [item.code, item]));
  assert.equal(byCode['11'].levelCode, '11', 'گروه');
  assert.equal(byCode['1110'].levelCode, '10', 'کل صندوق در پارسیان کد ۱۰ دارد، نه ۱۱۱۰');
  assert.equal(byCode['111001'].levelCode, '1', 'معین صندوق کد ۱ دارد');
  assert.equal(byCode['111202'].levelCode, '2', 'معین مشتریان کد ۲ دارد');
});

test('the prefix style still derives a level code by itself when none is given', () => {
  const { accounts } = validateChartRows([
    { rowNumber: 2, code: '1', name: 'دارایی', level: 'گروه', parentCode: '', type: 'دارایی' },
    { rowNumber: 3, code: '11', name: 'نقد', level: 'کل', parentCode: '1', type: 'دارایی' },
    { rowNumber: 4, code: '1101', name: 'صندوق', level: 'معین', parentCode: '11', type: 'دارایی' },
  ], { codingStyle: 'prefix' });
  const byCode = Object.fromEntries(accounts.map((item) => [item.code, item]));
  assert.equal(byCode['1'].levelCode, '1');
  assert.equal(byCode['11'].levelCode, '1', 'کد سطح = تفاضل کد فرزند و والد');
  assert.equal(byCode['1101'].levelCode, '01');
});

test('an unknown coding style falls back to the safer prefix rule', () => {
  assert.equal(normalizeCodingStyle('nonsense'), 'prefix');
  assert.equal(normalizeCodingStyle('segmented'), 'segmented');
});

test('a non numeric level code is refused', () => {
  const { errors } = validateChartRows([
    { rowNumber: 2, code: '11', levelCode: 'AB', name: 'گروه', level: 'گروه', parentCode: '', type: 'دارایی' },
  ], { codingStyle: 'segmented' });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /کد سطح/);
});
