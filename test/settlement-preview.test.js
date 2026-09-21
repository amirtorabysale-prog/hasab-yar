import test from 'node:test';
import assert from 'node:assert/strict';
import { settlementPreview } from '../shared/counterpartySettlement.js';

/**
 * برگهٔ تأیید باید بگوید پول کجا می‌رود — پیش از ثبت، نه بعدش.
 *
 * کاربر گفت «۹۳ میلیون به شرکت آراد گستر آسیا پرداخت شد» و برگه نوشت
 * «سایر هزینه‌ها · صندوق نقدی». سرور درست عمل می‌کرد و پول را به بدهی همان
 * شرکت می‌بست، ولی کاربر آن را نمی‌دید. آنچه دیده می‌شود همان چیزی است که
 * باور می‌شود؛ برگه‌ای که چیز دیگری وعده بدهد، اعتماد را از بین می‌برد حتی
 * وقتی دفتر درست است.
 */
const contacts = [
  { id: 'c1', name: 'شرکت آراد گستر آسیا', balance: -120_000_000 },
  { id: 'c2', name: 'شرکت پخش البرز', balance: 40_000_000 },
  { id: 'c3', name: 'شرکت پاک‌سازان', balance: 0 },
];

test('پرداخت به کسی که به او بدهکاریم، «کم‌شدن بدهی» اعلام می‌شود', () => {
  const preview = settlementPreview({ contactName: 'شرکت آراد گستر آسیا', type: 'expense' }, contacts);
  assert.equal(preview.direction, 'payable');
  assert.equal(preview.balance, -120_000_000);
  assert.equal(preview.name, 'شرکت آراد گستر آسیا');
});

test('دریافت از بدهکار، «کم‌شدن طلب» اعلام می‌شود', () => {
  const preview = settlementPreview({ contactName: 'شرکت پخش البرز', type: 'income' }, contacts);
  assert.equal(preview.direction, 'receivable');
  assert.equal(preview.balance, 40_000_000);
});

// حساب صاف یعنی ادعایی نباید بشود؛ همان هزینهٔ عادی است.
test('طرف حسابی با حساب صاف، تسویه اعلام نمی‌شود', () => {
  const preview = settlementPreview({ contactName: 'شرکت پاک‌سازان', type: 'expense' }, contacts);
  assert.equal(preview.direction, null);
  assert.ok(preview.contact, 'ولی نامش باید دیده شود');
});

// «ي» عربی و نیم‌فاصله نباید شخص را گم کنند.
test('نام با املای متفاوت هم به همان شخص می‌رسد', () => {
  const preview = settlementPreview({ contactName: 'شركت آراد گستر آسيا', type: 'expense' }, contacts);
  assert.equal(preview.direction, 'payable');
  assert.equal(preview.contact.id, 'c1');
});

test('نامی که در دفتر نیست، به‌عنوان طرف حساب تازه اعلام می‌شود', () => {
  const preview = settlementPreview({ contactName: 'شرکت ناشناخته', type: 'expense' }, contacts);
  assert.equal(preview.contact, null);
  assert.equal(preview.direction, null);
  assert.equal(preview.name, 'شرکت ناشناخته');
});

test('جمله‌ای بدون طرف حساب چیزی اعلام نمی‌کند', () => {
  assert.equal(settlementPreview({ type: 'expense' }, contacts), null);
});

// پرداخت به کسی که او به ما بدهکار است، تسویه نیست — پیش‌پرداخت یا هزینه است.
test('جهت اشتباه، تسویه اعلام نمی‌شود', () => {
  assert.equal(settlementPreview({ contactName: 'شرکت پخش البرز', type: 'expense' }, contacts).direction, null);
  assert.equal(settlementPreview({ contactName: 'شرکت آراد گستر آسیا', type: 'income' }, contacts).direction, null);
});
