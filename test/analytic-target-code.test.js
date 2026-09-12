import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { listAnalyticAccounts, saveAnalyticAccount } from '../server/chartOfAccounts.js';
import { ensureAccountingSchema } from '../server/accounting.js';

function freshDatabase() {
  const database = new DatabaseSync(':memory:');
  // کدینگ روی دفتر کل می‌نشیند؛ بدون آن جدول‌های سند وجود ندارند.
  ensureAccountingSchema(database);
  saveAnalyticAccount(database, { name: 'شرکت آبان', kind: 'custom' });
  return database;
}

/**
 * تفصیلی بدون کد مقصد، در فایل انتقال با `TafsiliCode` صفر بالا می‌رود و طرف
 * حساب در نرم‌افزار دفتر اصلاً دیده نمی‌شود. تا وقتی این کد در فهرست برنگردد،
 * هیچ صفحه‌ای نمی‌تواند نشان دهد کدام تفصیلی هنوز بی‌کد مانده است.
 */
test('فهرست تفصیلی‌ها کد مقصد را برمی‌گرداند', () => {
  const database = freshDatabase();
  const [item] = listAnalyticAccounts(database);
  assert.ok(Object.hasOwn(item, 'externalCode'), 'کد مقصد باید در فهرست باشد');
  assert.equal(item.externalCode, null, 'تفصیلی تازه هنوز کد مقصد ندارد');
});

test('کد مقصد ذخیره و در فهرست دیده می‌شود', () => {
  const database = freshDatabase();
  const [item] = listAnalyticAccounts(database);
  saveAnalyticAccount(database, { ...item, externalCode: '5104' });
  assert.equal(listAnalyticAccounts(database)[0].externalCode, '5104');
});

test('کد غیرعددی رد می‌شود و کد قبلی دست‌نخورده می‌ماند', () => {
  const database = freshDatabase();
  const [item] = listAnalyticAccounts(database);
  saveAnalyticAccount(database, { ...item, externalCode: '5104' });
  assert.throws(() => saveAnalyticAccount(database, { ...item, externalCode: 'آبان' }), /فقط رقم/);
  assert.equal(listAnalyticAccounts(database)[0].externalCode, '5104');
});

// ذخیرهٔ دوباره بدون دست زدن به این فیلد نباید پاکش کند؛ فرم‌ها همهٔ فیلدها را
// با هم می‌فرستند و یک `undefined` نباید نگاشت حسابدار را از بین ببرد.
test('ویرایش نام، کد مقصد را پاک نمی‌کند', () => {
  const database = freshDatabase();
  const [item] = listAnalyticAccounts(database);
  saveAnalyticAccount(database, { ...item, externalCode: '5104' });
  saveAnalyticAccount(database, { id: item.id, name: 'شرکت آبان (اصلاح‌شده)', kind: item.kind });
  const [updated] = listAnalyticAccounts(database);
  assert.equal(updated.name, 'شرکت آبان (اصلاح‌شده)');
  assert.equal(updated.externalCode, '5104');
});

// پاک کردن عمدی باید ممکن بماند، وگرنه کد اشتباه هیچ‌وقت برداشته نمی‌شود.
test('کد مقصد را می‌شود عمداً خالی کرد', () => {
  const database = freshDatabase();
  const [item] = listAnalyticAccounts(database);
  saveAnalyticAccount(database, { ...item, externalCode: '5104' });
  saveAnalyticAccount(database, { ...item, externalCode: '' });
  assert.equal(listAnalyticAccounts(database)[0].externalCode, null);
});
