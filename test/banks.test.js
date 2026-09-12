import test from 'node:test';
import assert from 'node:assert/strict';
import { BANKS, bankById, detectBank, mentionsMultipleBanks, pickBankAccount } from '../shared/banks.js';

const idOf = (text) => detectBank(text)?.bankId ?? null;

test('نام روشن بانک، تنها هم که بیاید شناخته می‌شود', () => {
  assert.equal(idOf('پنجاه هزار از ملت دادم'), 'mellat');
  assert.equal(idOf('واریز به پاسارگاد'), 'pasargad');
  assert.equal(idOf('با بلوبانک پرداخت کردم'), 'blu');
  assert.equal(idOf('از حساب رفاه برداشتم'), 'refah');
});

test('نشانهٔ بانک، نام کامل را هم می‌گیرد', () => {
  assert.equal(idOf('بانک ملی ایران'), 'melli');
  assert.equal(idOf('کارت اقتصاد نوین'), 'eghtesad-novin');
  assert.equal(idOf('حساب توسعه تعاون'), 'tosee-taavon');
});

// ------------------------------------------------- تله‌های واژهٔ روزمره

/**
 * «دی» هم اسم ماه است.
 *
 * یک بار سر «یک ماه دیگه» که به «اول دی» تبدیل شد همین درس را گرفتیم: نام
 * کوتاه بدون نشانه، بی‌صدا چیز دیگری را می‌بلعد.
 */
test('واژهٔ روزمره بدون نشانه، بانک شمرده نمی‌شود', () => {
  assert.equal(idOf('دهم دی صد هزار تومان دادم'), null);
  assert.equal(idOf('کرایه شهر را دادم'), null);
  assert.equal(idOf('برای آینده پس‌انداز کردم'), null);
  assert.equal(idOf('سرمایه آوردم'), null);
  assert.equal(idOf('قبض آب ملی را دادم'), null);
});

test('همان واژه با نشانه، بانک است', () => {
  assert.equal(idOf('از بانک دی برداشتم'), 'dey');
  assert.equal(idOf('کارت شهر را کشیدم'), 'shahr');
  assert.equal(idOf('حساب آینده'), 'ayandeh');
  assert.equal(idOf('از بانک ملی گرفتم'), 'melli');
});

// مرز فارسی با \b کار نمی‌کند؛ بدون مرز دستی «ملتهب» هم ملت می‌شد.
test('نام بانک داخل واژهٔ دیگر شناخته نمی‌شود', () => {
  assert.equal(idOf('وضعیت ملتهب بازار'), null);
  assert.equal(idOf('سیناپس مغزی'), null);
});

// ------------------------------------------------------------- دو بانک

// «از ملت به پاسارگاد» انتقال بین حساب‌هاست، نه هزینه. حدس زدن یکی از آن دو
// بدتر از نگفتن است، چون پول را از حساب اشتباه کم می‌کند.
test('جملهٔ دو بانکی هیچ بانکی برنمی‌گرداند', () => {
  assert.equal(idOf('از ملت به پاسارگاد منتقل کردم'), null);
  assert.equal(mentionsMultipleBanks('از ملت به پاسارگاد منتقل کردم'), true);
  assert.equal(mentionsMultipleBanks('از ملت دادم'), false);
});

// ------------------------------------------------------------ فهرست

test('متن تطبیق‌خورده برمی‌گردد تا بشود ماسکش کرد', () => {
  // «بانک صادرات» نباید دستهٔ «صادرات» بسازد.
  const hit = detectBank('صد هزار به بانک صادرات دادم');
  assert.equal(hit.bankId, 'saderat');
  assert.ok(hit.matchedText.includes('صادرات'));
  assert.ok(Number.isInteger(hit.index));
});

test('هر بانک شناسهٔ یکتا و دست‌کم یک نام دارد', () => {
  const ids = new Set();
  for (const bank of BANKS) {
    assert.ok(!ids.has(bank.id), `شناسهٔ تکراری: ${bank.id}`);
    ids.add(bank.id);
    assert.ok(bank.name, `${bank.id} نام ندارد`);
    assert.ok(bank.strong.length + bank.weak.length > 0, `${bank.id} هیچ نامی برای تشخیص ندارد`);
  }
  assert.equal(bankById('mellat').name, 'بانک ملت');
  assert.equal(bankById('ناشناخته'), null);
});

test('ارقام فارسی و نیم‌فاصله مانع تشخیص نمی‌شوند', () => {
  assert.equal(idOf('۵۰۰ هزار از بانک ملي'), 'melli');
  assert.equal(idOf('کارآفرین'), 'karafarin');
  assert.equal(idOf('کار آفرین'), 'karafarin');
});

// ------------------------------------------------- انتخاب حساب از بانک

/**
 * این قاعده یک بار در دو جا نوشته شده بود و از هم جدا افتاد.
 *
 * برگهٔ تأیید پیش از ارسال، حساب را روی صندوق می‌گذاشت و سرور دیگر فرصت نداشت
 * از روی نام بانک تصمیم بگیرد؛ یعنی گفتنِ نام بانک روی مسیر واقعی هیچ اثری
 * نداشت، درحالی‌که آزمون‌های سرور سبز بودند.
 */
test('حساب بانک وقتی یکتا باشد انتخاب می‌شود', () => {
  const accounts = [
    { id: 'cash', kind: 'cash', active: true },
    { id: 'a1', kind: 'bank', bankId: 'mellat', active: true },
  ];
  assert.equal(pickBankAccount(accounts, 'mellat').id, 'a1');
  assert.equal(pickBankAccount(accounts, 'saman'), null);
  assert.equal(pickBankAccount(accounts, ''), null);
});

test('دو حساب از یک بانک یعنی هیچ‌کدام', () => {
  const accounts = [
    { id: 'a1', kind: 'bank', bankId: 'saman', active: true },
    { id: 'a2', kind: 'bank', bankId: 'saman', active: true },
  ];
  assert.equal(pickBankAccount(accounts, 'saman'), null);
});

test('حساب بسته یا غیربانکی انتخاب نمی‌شود', () => {
  assert.equal(pickBankAccount([{ id: 'a1', kind: 'bank', bankId: 'mellat', active: false }], 'mellat'), null);
  assert.equal(pickBankAccount([{ id: 'a1', kind: 'cash', bankId: 'mellat', active: true }], 'mellat'), null);
});
