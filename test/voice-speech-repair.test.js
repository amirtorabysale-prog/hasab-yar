import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFinancialText, relativeDayOffset, repairNumberSpeech } from '../shared/parser.js';

const amountOf = (phrase) => parseFinancialText(phrase, { source: 'voice' }).transactions[0];

// این واژه‌ها را موتور تشخیص گفتار فارسی واقعاً تولید می‌کند. تا پیش از این،
// نبودنشان در واژگان باعث می‌شد «هفصد هزار» بی‌صدا ۱۰۰۰ خوانده شود — یعنی
// خطای ۷۰۰ برابری که هیچ هشداری هم نداشت.
const colloquialForms = [
  ['هفصد هزار تومن پیک دادم', 700_000],
  ['هشصد هزار تومان فروختم', 800_000],
  ['پنصد هزار تومان کرایه دادم', 500_000],
  ['دویس هزار تومان غذا خریدم', 200_000],
  ['یک میلیون و هفصد فروش داشتم', 1_700_000],
];

for (const [phrase, expected] of colloquialForms) {
  test(`گویش محاوره‌ای: ${phrase}`, () => {
    const transaction = amountOf(phrase);
    assert.equal(transaction.amount, expected);
  });
}

// موتور گفتار عدد و مقیاس را گاهی سرِ هم می‌نویسد؛ پیش از این هیچ مبلغی پیدا نمی‌شد.
const joinedForms = [
  ['دوهزار تومن دادم', 2_000],
  ['دومیلیون فروختم', 2_000_000],
  ['یکمیلیون گرفتم', 1_000_000],
  ['پنجاههزار تومان پارکینگ دادم', 50_000],
];

for (const [phrase, expected] of joinedForms) {
  test(`عدد چسبیده به مقیاس: ${phrase}`, () => {
    assert.equal(amountOf(phrase).amount, expected);
  });
}

// «و» چسبیده به عدد، کل مبلغ را از بین می‌برد.
const attachedVav = [
  ['سیصدو پنجاه هزار تومان غذا خریدم', 350_000],
  ['دویستو پنجاه هزار تومان دادم', 250_000],
  ['نهصدو پنجاه هزار اینترنت دادم', 950_000],
];

for (const [phrase, expected] of attachedVav) {
  test(`«و» چسبیده: ${phrase}`, () => {
    assert.equal(amountOf(phrase).amount, expected);
  });
}

test('ترمیم گفتار، متن سالم را دست‌نخورده می‌گذارد', () => {
  const untouched = 'دو میلیون و پانصد هزار تومان حقوق دادم';
  assert.equal(repairNumberSpeech(untouched), untouched);
});

test('مقیاس بدون عدد هرگز به‌عنوان مبلغ مطمئن ثبت نمی‌شود', () => {
  // wordsToNumber ناچار ۱×مقیاس برمی‌گرداند؛ نکتهٔ مهم این است که این حدس
  // هرگز بی‌صدا از کنترل رد نشود.
  const transaction = amountOf('قلمبه هزار تومان دادم');
  assert.equal(transaction.needsReview, true);
  assert.ok(transaction.warning.includes('شنیده نشد'));
  assert.ok(transaction.confidenceDetails.amount.score <= 0.35);
  assert.ok(transaction.reviewReasons.some((reason) => reason.includes('شنیده نشد')));
});

test('مقیاس بدون عدد برای میلیون هم همان‌قدر مشکوک است', () => {
  const transaction = amountOf('فلان میلیون فروختم');
  assert.equal(transaction.amount, 1_000_000);
  assert.equal(transaction.needsReview, true);
  assert.equal(transaction.reviewState, 'review');
});

test('مبلغ با عدد صریح، مشکوک علامت نمی‌خورد', () => {
  const transaction = amountOf('دوازده میلیون فروش داشتم');
  assert.equal(transaction.amount, 12_000_000);
  assert.equal(transaction.needsReview, false);
});

// «پنجاه تومن» در گفتار ایرانی یعنی پنجاه هزار تومان؛ هیچ چیزی امروز
// پنجاه تومان نیست. قاعده باید اعمال شود ولی حتماً برای بررسی علامت بخورد.
const colloquialToman = [
  ['پنجاه تومن دادم', 50_000],
  ['ده تومن دادم', 10_000],
  ['سیصد تومن دادم', 300_000],
];

for (const [phrase, expected] of colloquialToman) {
  test(`تومنِ محاوره‌ای: ${phrase}`, () => {
    const transaction = amountOf(phrase);
    assert.equal(transaction.amount, expected);
    assert.equal(transaction.needsReview, true, 'تبدیل محاوره‌ای باید همیشه قابل بررسی بماند');
  });
}

test('مبلغ نوشته‌شده با رقم، هرگز محاوره‌ای تبدیل نمی‌شود', () => {
  assert.equal(amountOf('۵۰ تومان دادم').amount, 50);
});

// یک گفته یک مرجع زمانی دارد. پیش از این «دیروز» نادیده گرفته می‌شد و سند
// در دورهٔ مالی اشتباه می‌نشست.
test('تاریخ نسبی از گفتار استخراج می‌شود', () => {
  assert.deepEqual(relativeDayOffset('دیروز دو میلیون فروختم'), { days: -1, label: 'دیروز' });
  assert.deepEqual(relativeDayOffset('پریروز پونصد هزار خرج کردم'), { days: -2, label: 'پریروز' });
  assert.deepEqual(relativeDayOffset('هفته پیش سه میلیون گرفتم'), { days: -7, label: 'هفتهٔ پیش' });
  assert.equal(relativeDayOffset('امروز دو میلیون فروختم'), null);
  assert.equal(relativeDayOffset('دو میلیون فروختم'), null);
});

test('تاریخ نسبی روی خود تراکنش می‌نشیند', () => {
  const now = new Date('2026-09-05T10:00:00.000Z');
  const result = parseFinancialText('دیروز دو میلیون فروختم', { source: 'voice', now });
  const transaction = result.transactions[0];
  assert.equal(transaction.occurredAt, '2026-09-04T10:00:00.000Z');
  assert.equal(transaction.occurredAtLabel, 'دیروز');
});

test('بدون واژهٔ زمانی، تاریخ به سرور واگذار می‌شود', () => {
  const result = parseFinancialText('دو میلیون فروختم', { source: 'voice' });
  assert.equal(result.transactions[0].occurredAt, undefined);
});

test('همهٔ ثبت‌های یک گفته یک مرجع زمانی می‌گیرند', () => {
  const now = new Date('2026-09-05T10:00:00.000Z');
  const result = parseFinancialText('دیروز دو میلیون فروختم و پونصد هزار قبض برق دادم', { source: 'voice', now });
  assert.equal(result.transactions.length, 2);
  assert.ok(result.transactions.every((item) => item.occurredAt === '2026-09-04T10:00:00.000Z'));
});
