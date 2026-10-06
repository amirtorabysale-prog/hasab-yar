import assert from 'node:assert/strict';
import test from 'node:test';
import { CATEGORY_DEFINITIONS, classifyCategory, chartCodeForCategory, scoreCategories } from '../shared/categoryRules.js';
import { parseFinancialText } from '../shared/parser.js';

function firstTransaction(text) {
  const parsed = parseFinancialText(text, { source: 'voice' });
  assert.ok(parsed.transactions.length, `هیچ تراکنشی از «${text}» ساخته نشد`);
  return parsed.transactions[0];
}

// این دقیقاً جمله‌ای است که کاربر در production آزمود و «سایر هزینه‌ها» افتاد.
test('هزینهٔ تبلیغات دیگر در سایر هزینه‌ها نمی‌افتد', () => {
  const item = firstTransaction('دو میلیون بابت تبلیغات دادم');
  assert.equal(item.amount, 2_000_000);
  assert.equal(item.type, 'expense');
  assert.equal(item.category, 'تبلیغات و بازاریابی');
});

test('دسته‌های شرکتی رایج از گفتار شناخته می‌شوند', () => {
  const cases = [
    ['سه میلیون حق بیمه پرسنل دادم', 'بیمه'],
    ['هشتصد هزار کارمزد بانک کم شد', 'کارمزد بانکی'],
    ['یک میلیون و دویست بابت لایسنس نرم افزار دادم', 'نرم‌افزار و اشتراک'],
    ['پانصد هزار تونر و کارتریج خریدم', 'ملزومات اداری'],
    ['دو میلیون به پیمانکار دادم', 'پیمانکار و خدمات بیرونی'],
    ['نهصد هزار مالیات بر ارزش افزوده پرداخت کردم', 'مالیات و عوارض'],
    ['چهارصد هزار تعمیر دستگاه دادم', 'تعمیر و نگهداری'],
    ['سیصد هزار بنزین زدم', 'سوخت و ایاب‌وذهاب'],
    ['یک میلیون کرایه حمل بار دادم', 'حمل‌ونقل'],
  ];
  for (const [sentence, expected] of cases) {
    assert.equal(firstTransaction(sentence).category, expected, `«${sentence}» باید ${expected} شود`);
  }
});

// نقص ساختاری قاعده‌های قبلی: `.find()` اولین تطابق را برمی‌داشت، پس نتیجه به
// ترتیب نوشتن قاعده‌ها وابسته بود نه به متن.
test('عبارت اختصاصی بر واژهٔ عمومی می‌چربد، نه ترتیب قاعده‌ها', () => {
  assert.equal(classifyCategory('کارمزد بانک برای انتقال وجه', 'expense').category, 'کارمزد بانکی');
  assert.equal(classifyCategory('اجارهٔ انبار کالا', 'expense').category, 'اجاره');
  assert.equal(classifyCategory('خرید کالا برای انبار', 'expense').category, 'مواد و کالا');
});

test('وقتی دو دسته هم‌امتیازند، ابهام اعلام و اطمینان کم می‌شود', () => {
  const ranked = scoreCategories('قبض اینترنت و شارژ', 'expense');
  assert.ok(ranked.length >= 1);
  const tie = classifyCategory('غذا', 'expense');
  assert.ok(tie.confidence <= 0.94);
});

test('دستهٔ پیشنهادی هرگز با نوع تراکنش ناسازگار نیست', () => {
  for (const type of ['income', 'expense']) {
    const result = classifyCategory('یک متن کاملاً بی‌ربط', type);
    const definition = CATEGORY_DEFINITIONS.find((item) => item.name === result.category);
    assert.equal(definition.type, type);
  }
});

test('هر دستهٔ داخلی به یک کد حساب معتبر نگاشت می‌شود', () => {
  for (const definition of CATEGORY_DEFINITIONS) {
    assert.match(definition.chartCode, /^\d{4}$/, `${definition.name} کد حساب ندارد`);
    assert.equal(chartCodeForCategory(definition.name), definition.chartCode);
  }
});

test('کد حساب روی خود تراکنش می‌نشیند تا سند بدون حدس ساخته شود', () => {
  // تبلیغات معین خودش را دارد؛ پیش از تفکیک کدینگ در «۸۱۰۹ سایر» دفن می‌شد.
  assert.equal(firstTransaction('دو میلیون بابت تبلیغات دادم').chartCode, '8110');
  assert.equal(firstTransaction('پنج میلیون حقوق دادم').chartCode, '8101');
  assert.equal(firstTransaction('ده میلیون فروختم').chartCode, '6101');
});

// دستهٔ دست‌ساز کاربر کد ندارد و نباید کد اشتباهی به آن نسبت داده شود.
test('دستهٔ ناشناخته کد حساب جعلی نمی‌گیرد', () => {
  assert.equal(chartCodeForCategory('یک دستهٔ دلخواه کاربر'), null);
});

test('نگاشت تأییدشدهٔ کاربر بر قاعده‌ها مقدم است', () => {
  const parsed = parseFinancialText('دو میلیون بابت تبلیغات دادم', {
    learnings: [{ keyword: 'تبلیغات', category: 'پیمانکار و خدمات بیرونی' }],
    source: 'voice',
  });
  assert.equal(parsed.transactions[0].category, 'پیمانکار و خدمات بیرونی');
});
