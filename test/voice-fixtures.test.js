import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFinancialText } from '../shared/parser.js';

const fixtures = [
  ['امروز دوازده میلیون فروش داشتم', 12_000_000, 'income', 'فروش'],
  ['امروز ۱۲ میلیون تومن فروختم', 12_000_000, 'income', 'فروش'],
  ['دو میلیون و پونصد حقوق دادم', 2_500_000, 'expense', 'حقوق و دستمزد'],
  ['دو میلیون و پانصد هزار تومان حقوق دادم', 2_500_000, 'expense', 'حقوق و دستمزد'],
  ['یه میلیون و نیم اجاره دادم', 1_500_000, 'expense', 'اجاره'],
  ['دو و نیم میلیون اجاره دادم', 2_500_000, 'expense', 'اجاره'],
  ['۲.۵ میلیون هزینه مواد شد', 2_500_000, 'expense', 'مواد و کالا'],
  ['۲,۵۰۰,۰۰۰ تومان خرید جنس داشتم', 2_500_000, 'expense', 'مواد و کالا'],
  ['پونصد هزار تومن کرایه دادم', 500_000, 'expense', 'حمل‌ونقل'],
  ['ششصد هزار تومان اسنپ دادم', 600_000, 'expense', 'حمل‌ونقل'],
  ['سیصد و پنجاه هزار تومان غذا خریدم', 350_000, 'expense', 'خوراک'],
  ['یک میلیون و دویست قبض برق دادم', 1_200_000, 'expense', 'قبوض'],
  ['هشت میلیون درآمد خدمات گرفتم', 8_000_000, 'income', 'خدمات'],
  ['پنج میلیون دستمزد پروژه گرفتم', 5_000_000, 'income', 'پروژه و دستمزد'],
  ['پنجاه میلیون ریال کرایه دادم', 5_000_000, 'expense', 'حمل‌ونقل'],
  ['سه میلیون و صد خرید کالا داشتم', 3_100_000, 'expense', 'مواد و کالا'],
  ['یک میلیارد و دویست میلیون فروش داشتم', 1_200_000_000, 'income', 'فروش'],
  ['نهصد و پنجاه هزار تومان اینترنت دادم', 950_000, 'expense', 'قبوض'],
  ['هفت میلیون و نیم درآمد داشتم', 7_500_000, 'income', 'سایر درآمدها'],
  ['۴۵۰ هزار تومن پیک دادم', 450_000, 'expense', 'حمل‌ونقل'],
];

for (const [phrase, amount, type, category] of fixtures) {
  test(`voice fixture: ${phrase}`, () => {
    const result = parseFinancialText(phrase);
    assert.equal(result.transactions.length, 1);
    assert.deepEqual(
      [result.transactions[0].amount, result.transactions[0].type, result.transactions[0].category],
      [amount, type, category],
    );
  });
}

test('voice fixture: multiple transactions stay separate', () => {
  const result = parseFinancialText('دوازده میلیون فروش داشتم، دو میلیون و پونصد حقوق دادم و پونصد هزار قبض برق دادم');
  assert.deepEqual(result.transactions.map((item) => [item.amount, item.type]), [
    [12_000_000, 'income'], [2_500_000, 'expense'], [500_000, 'expense'],
  ]);
});

/**
 * تایپ زنده بودجهٔ میلی‌ثانیه‌ای دارد و این تست دو بار جلوی رگرسیون واقعی را
 * گرفته: یک بار تشخیص انتقال داخلی و یک بار نشانهٔ پیش‌پرداخت، هر دو چون
 * نرمال‌سازی فارسی را روی هر جمله اجرا می‌کردند.
 *
 * دور گرم‌کننده عمدی است: بدون آن، تست هزینهٔ JIT را هم اندازه می‌گرفت و زیر
 * بار موازیِ کل مجموعه شکننده می‌شد. حالا توان پایدار را می‌سنجد — که همان
 * چیزی است که کاربر موقع تایپ تجربه می‌کند — و هنوز هر دو رگرسیون بالا را
 * می‌گرفت.
 */
test('local parser is fast enough for live preview', () => {
  for (let index = 0; index < 200; index += 1) parseFinancialText(fixtures[index % fixtures.length][0]);
  const startedAt = performance.now();
  for (let index = 0; index < 2_000; index += 1) parseFinancialText(fixtures[index % fixtures.length][0]);
  assert.ok(performance.now() - startedAt < 1_000);
});
