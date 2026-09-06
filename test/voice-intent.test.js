import assert from 'node:assert/strict';
import test from 'node:test';
import { detectVoiceIntent, extractContactName } from '../shared/voiceIntent.js';
import { persianToISO } from '../shared/persianDate.js';

const TZ = 'Asia/Tehran';
const NOW = new Date(persianToISO(1405, 6, 6, TZ));
const persianDay = (iso) => {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}/${part('month')}/${part('day')}`;
};
const detect = (text) => detectVoiceIntent(text, { now: NOW });

test('طلب و بدهی جهت مخالف می‌گیرند', () => {
  const owed = detect('آقای احمدی سه میلیون بدهکاره');
  assert.equal(owed.intent, 'obligation');
  assert.equal(owed.direction, 'receivable');
  assert.equal(owed.amount, 3_000_000);
  assert.equal(owed.contactName, 'احمدی');

  const owing = detect('به شرکت پارس دو میلیون بدهکارم');
  assert.equal(owing.direction, 'payable');
  assert.equal(owing.amount, 2_000_000);
});

// جمله‌ای که هر دو نشانه دارد اجرا نمی‌شود؛ ثبت جهت غلط بدتر از نپرسیدن است.
test('جملهٔ مبهم جهت نمی‌گیرد و پرچم می‌خورد', () => {
  const found = detect('آقای رضایی بدهکاره ولی من هم بهش بدهکارم پنج میلیون');
  assert.equal(found.ambiguous, true);
  assert.equal(found.direction, null);
});

test('چک با سررسید آینده ثبت می‌شود، نه سال گذشته', () => {
  const cheque = detect('چک پنج میلیون دادم سررسید دهم مهر');
  assert.equal(cheque.intent, 'cheque');
  assert.equal(cheque.direction, 'payable');
  assert.equal(cheque.amount, 5_000_000);
  assert.equal(persianDay(cheque.dueAt), '1405/07/10');
});

test('چک دریافتی طلب است، نه بدهی', () => {
  const cheque = detect('چک ده میلیون از آقای احمدی گرفتم');
  assert.equal(cheque.direction, 'receivable');
  assert.equal(cheque.amount, 10_000_000);
});

test('فاکتور فروش و خرید از هم جدا می‌شوند', () => {
  const sales = detect('فاکتور فروش برای آقای احمدی سه میلیون');
  assert.equal(sales.intent, 'invoice');
  assert.equal(sales.documentType, 'sales');
  assert.equal(sales.amount, 3_000_000);
  assert.equal(sales.contactName, 'احمدی');

  const purchase = detect('فاکتور خرید از شرکت پارس دوازده میلیون');
  assert.equal(purchase.documentType, 'purchase');
  assert.equal(purchase.amount, 12_000_000);
});

// ثبت عادی نباید به نیت دیگری ربوده شود.
test('ثبت معمولی هیچ نیت خاصی نمی‌سازد', () => {
  assert.equal(detect('دو میلیون بابت تبلیغات دادم'), null);
  assert.equal(detect('دیروز ده میلیون فروختم'), null);
  assert.equal(detect(''), null);
});

test('بدون مبلغ، نیتی اجرا نمی‌شود', () => {
  assert.equal(detect('آقای احمدی بدهکاره'), null);
  assert.equal(detect('فاکتور فروش برای آقای احمدی'), null);
});

test('نام طرف حساب از عنوان بیرون کشیده می‌شود', () => {
  assert.equal(extractContactName('آقای احمدی سه میلیون بدهکاره'), 'احمدی');
  assert.equal(extractContactName('خانم موسوی نژاد دو میلیون'), 'موسوی نژاد');
  assert.equal(extractContactName('شرکت پارس خودرو ده میلیون'), 'شرکت پارس خودرو');
  // بدون عنوان، حدس‌زدن نام خطای بیشتری می‌سازد تا فایده.
  assert.equal(extractContactName('دو میلیون بدهکاره'), '');
});
