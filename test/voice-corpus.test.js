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
