import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAmounts, inferLearningKeyword, normalizePersian, parseFinancialText, wordsToNumber } from '../server/parser.js';

test('normalizes Persian and Arabic digits', () => assert.equal(normalizePersian('۱۲٬۵۰۰ و ٣٠٠'), '12,500 و 300'));
test('parses compound Persian number words', () => assert.equal(wordsToNumber(['دو', 'میلیون', 'و', 'پانصد', 'هزار']), 2_500_000));
test('extracts digit and word amounts', () => assert.deepEqual(extractAmounts('۱۲ میلیون فروش و دو میلیون هزینه').spans.map((x) => x.amount), [12_000_000, 2_000_000]));
test('splits a sentence into income and expense transactions', () => {
  const result = parseFinancialText('امروز دوازده میلیون فروش داشتم، دو میلیون و پانصد هزار حقوق دادم');
  assert.equal(result.transactions.length, 2);
  assert.deepEqual(result.transactions.map((item) => [item.amount, item.type, item.category]), [[12_000_000, 'income', 'فروش'], [2_500_000, 'expense', 'حقوق و دستمزد']]);
});
test('converts rial to toman', () => assert.equal(parseFinancialText('پانصد هزار ریال کرایه دادم').transactions[0].amount, 50_000));
test('uses learned categorization', () => {
  const result = parseFinancialText('ششصد هزار اسنپ‌فود دادم', { learnings: [{ keyword: 'اسنپ‌فود', category: 'خوراک' }] });
  assert.equal(result.transactions[0].category, 'خوراک');
});
test('extracts a stable keyword from a corrected phrase', () => assert.equal(inferLearningKeyword('ششصد هزار تومان اسنپ‌فود دادم'), 'اسنپ‌فود'));
