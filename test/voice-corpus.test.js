import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFinancialText } from '../shared/parser.js';

const amounts = [
  ['صد هزار', 100_000],
  ['دویست و پنجاه هزار', 250_000],
  ['پانصد هزار', 500_000],
  ['هفتصد و پنجاه هزار', 750_000],
  ['یک میلیون', 1_000_000],
  ['یک میلیون و دویست هزار', 1_200_000],
  ['دو میلیون و پانصد هزار', 2_500_000],
  ['سه میلیون', 3_000_000],
  ['پنج میلیون', 5_000_000],
  ['ده میلیون', 10_000_000],
  ['دوازده میلیون', 12_000_000],
  ['بیست و پنج میلیون', 25_000_000],
];

const singleTemplates = [
  { text: (amount) => `${amount} تومان فروش داشتم`, type: 'income' },
  { text: (amount) => `امروز ${amount} تومان فروش داشتم`, type: 'income' },
  { text: (amount) => `${amount} تومان درآمد داشتم`, type: 'income' },
  { text: (amount) => `${amount} تومان از مشتری گرفتم`, type: 'income' },
  { text: (amount) => `مشتری ${amount} تومان واریز کرد`, type: 'income' },
  { text: (amount) => `${amount} تومان هزینه کردم`, type: 'expense' },
  { text: (amount) => `${amount} تومان خرید کردم`, type: 'expense' },
  { text: (amount) => `${amount} تومان حقوق دادم`, type: 'expense' },
  { text: (amount) => `${amount} تومان کرایه دادم`, type: 'expense' },
  { text: (amount) => `${amount} تومان پرداخت کردم`, type: 'expense' },
];

const curated = [
  ['یه فروش یک و دویست داشتم', 1_200_000, 'income'],
  ['برای پیک هفتصد تومن دادم', 700_000, 'expense'],
  ['دوازده میلیون تومن فروش داشتم', 12_000_000, 'income'],
  ['دو و نیم میلیون خرید مواد کردم', 2_500_000, 'expense'],
  ['پونصد هزار تومن از رضا گرفتم', 500_000, 'income'],
  ['یک میلیون بابت حقوق پرداخت کردم', 1_000_000, 'expense'],
  ['سه میلیون مشتری کارت به کارت کرد', 3_000_000, 'income'],
  ['بیست و پنج میلیون تومان فروش امروز بود', 25_000_000, 'income'],
  ['صد هزار تومان پول اسنپ دادم', 100_000, 'expense'],
  ['هفتصد و پنجاه هزار هزینه بسته بندی شد', 750_000, 'expense'],
  ['امروز درآمد خدمات یک میلیون و دویست شد', 1_200_000, 'income'],
  ['برای خرید ابزار پنج میلیون خرج کردم', 5_000_000, 'expense'],
];

/**
 * پسوند «ی» صفتی، و شمارنده‌ای که مبلغ نیست.
 *
 * دو شکست واقعی که هیچ‌کدام در corpus بالا نبودند و هر دو مبلغ را غلط
 * می‌خواندند — نه اینکه چیزی پیدا نکنند، که خیلی بدتر است: کاربر یک عدد
 * می‌بیند و ممکن است تأییدش کند.
 *
 * ۱. «چک سه میلیونی گرفتم» سه تومان می‌خواند، چون «میلیونی» در فهرست
 *    مقیاس‌ها نبود و فقط «میلیون» بود. همین برای «هزاری» و «میلیاردی» هم
 *    بود — یعنی مبلغ هزار تا یک‌میلیون برابر کوچک می‌شد.
 *
 * ۲. عددِ شمارنده پیش از اسمِ سند، یک ثبت جعلی می‌ساخت: «یک چک سه میلیونی
 *    دادم» دو تراکنش می‌داد، یکی سه میلیون و یکی یک تومان. قاعدهٔ حذفِ
 *    شمارنده وجود داشت ولی فقط اسم‌های مالی («فروش»، «خرید»…) را می‌شناخت،
 *    نه اسم خودِ سند را.
 */
const scaleSuffix = [
  ['چک سه میلیونی گرفتم', 3_000_000, 'income'],
  ['خرید پانصد هزاری کردم', 500_000, 'expense'],
  ['جنس ده میلیونی خریدم', 10_000_000, 'expense'],
  ['یک قرارداد دو میلیاردی فروختم', 2_000_000_000, 'income'],
  ['دومیلیونی فروختم', 2_000_000, 'income'],
];

const counterBeforeDocument = [
  ['یک چک سه میلیونی دادم', 3_000_000, 'expense'],
  ['یه اسکناس پنجاه هزاری دادم', 50_000, 'expense'],
  ['یک فاکتور دو میلیونی زدم', 2_000_000, 'expense'],
  ['یه کارت صد هزاری فروختم', 100_000, 'income'],
  ['دو چک پانصد هزاری گرفتم', 500_000, 'income'],
];

test('the adjectival scale suffix is read as a scale, not dropped', () => {
  for (const [text, amount, type] of scaleSuffix) {
    const actual = parseFinancialText(text, { source: 'voice' }).transactions.map(({ amount: value, type: kind }) => ({ amount: value, type: kind }));
    assert.deepEqual(actual, [{ amount, type }], text);
  }
});

test('a counter before a document noun never becomes a second transaction', () => {
  for (const [text, amount, type] of counterBeforeDocument) {
    const actual = parseFinancialText(text, { source: 'voice' }).transactions.map(({ amount: value, type: kind }) => ({ amount: value, type: kind }));
    assert.deepEqual(actual, [{ amount, type }], text);
  }
});

test('collecting a receivable is money coming in, not going out', () => {
  // «وصول» جهت روشنی دارد و نداشتنش در فهرست درآمد یعنی «چک وصول شد» هزینه
  // ثبت می‌شد — درست وارونهٔ چیزی که اتفاق افتاده.
  for (const text of ['دو میلیون تومان چک وصول شد', 'طلبم را وصول کردم سه میلیون']) {
    assert.equal(parseFinancialText(text, { source: 'voice' }).transactions[0]?.type, 'income', text);
  }
  // ولی «وصول» در جمله‌ای که فعل و اسمش هزینه است، جهت را وارونه نمی‌کند.
  const spent = parseFinancialText('یک میلیون بابت وصول مطالبات هزینه دادم', { source: 'voice' });
  assert.equal(spent.transactions[0]?.type, 'expense');
});

test('a genuinely two-sided phrase is flagged instead of guessed silently', () => {
  // «چک نقد کردم» واقعاً دوپهلوست: «نقدی خریدم» هزینه است. حدسِ خاموش
  // بدترین کار است؛ گفتنِ اینکه مطمئن نیست، درست است.
  const [transaction] = parseFinancialText('دو میلیون تومان چک نقد کردم', { source: 'voice' }).transactions;
  assert.equal(transaction.needsReview, true);
  assert.ok(transaction.reviewReasons.some((reason) => reason.includes('نوع')), 'باید دربارهٔ نوع هشدار بدهد');
});

test('a real small amount beside a bigger one is never mistaken for a counter', () => {
  // مرز مقابل همان قاعده. اگر بیش از حد سخت‌گیر شود، مبلغ کوچکِ واقعی را هم
  // دور می‌ریزد و کاربر بی‌صدا یک ثبت را از دست می‌دهد. واحد پول در میانه
  // یعنی این یک مبلغ است، نه شمارنده.
  const actual = parseFinancialText('پنجاه تومان قبض دادم و دو میلیون فروختم', { source: 'voice' })
    .transactions.map(({ amount, type }) => ({ amount, type }));
  assert.deepEqual(actual, [{ amount: 50_000, type: 'expense' }, { amount: 2_000_000, type: 'income' }]);
});

test('regresses more than 300 Persian financial utterance shapes', () => {
  const corpus = [];
  for (const [spoken, value] of amounts) {
    for (const template of singleTemplates) corpus.push({ text: template.text(spoken), expected: [{ amount: value, type: template.type }] });
  }
  for (const [incomeSpoken, income] of amounts) {
    for (const [expenseSpoken, expense] of amounts) {
      corpus.push({
        text: `${incomeSpoken} تومان فروش و ${expenseSpoken} تومان هزینه پیک`,
        expected: [{ amount: income, type: 'income' }, { amount: expense, type: 'expense' }],
      });
    }
  }
  for (const [text, amount, type] of curated) corpus.push({ text, expected: [{ amount, type }] });
  // Numbers used as identifiers must never become money.
  for (let index = 100; index < 140; index += 1) corpus.push({ text: `شماره فاکتور ${index} بود و مبلغ را نگفتم`, expected: [] });

  assert.ok(corpus.length >= 300);
  for (const item of corpus) {
    const actual = parseFinancialText(item.text, { source: 'voice' }).transactions.map(({ amount, type }) => ({ amount, type }));
    assert.deepEqual(actual, item.expected, item.text);
  }
});
