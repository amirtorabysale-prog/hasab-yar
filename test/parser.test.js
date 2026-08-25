import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAmounts, inferLearningKeyword, normalizePersian, parseFinancialText, parseRecognitionCandidates, wordsToNumber } from '../server/parser.js';

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
test('extracts a stable keyword from a corrected phrase', () => assert.equal(inferLearningKeyword('ششصد هزار تومان اسنپ‌فود دادم'), 'اسنپ فود'));
test('parses colloquial omitted thousand scale', () => assert.equal(parseFinancialText('دو میلیون و پونصد حقوق دادم').transactions[0].amount, 2_500_000));
test('parses colloquial omitted million and thousand scales', () => assert.equal(parseFinancialText('یه فروش یک و دویست داشتم').transactions[0].amount, 1_200_000));
test('parses half after a large scale', () => assert.equal(parseFinancialText('یه میلیون و نیم اجاره دادم').transactions[0].amount, 1_500_000));
test('parses decimal and thousands separators without multiplying digits', () => {
  assert.equal(parseFinancialText('۲.۵ میلیون فروش داشتم').transactions[0].amount, 2_500_000);
  assert.equal(parseFinancialText('۲,۵۰۰,۰۰۰ تومان فروش داشتم').transactions[0].amount, 2_500_000);
  assert.equal(parseFinancialText('2.500.000 تومان فروش داشتم').transactions[0].amount, 2_500_000);
});
test('compares recognition alternatives and forces review when amounts disagree', () => {
  const result = parseRecognitionCandidates([
    { transcript: 'دوازده میلیون فروش داشتم', confidence: 0.91 },
    { transcript: 'دویست میلیون فروش داشتم', confidence: 0.52 },
  ]);
  assert.equal(result.transactions[0].amount, 12_000_000);
  assert.deepEqual(result.transactions[0].alternatives, [200_000_000]);
  assert.equal(result.transactions[0].needsReview, true);
});
test('ignores quantities, dates and document identifiers around the real amount', () => {
  assert.deepEqual(parseFinancialText('دو تا کالا را پانصد هزار تومان فروختم').transactions.map((item) => item.amount), [500_000]);
  assert.deepEqual(parseFinancialText('روز ۱۵ اجاره پنج میلیون تومان پرداخت شد').transactions.map((item) => item.amount), [5_000_000]);
  assert.deepEqual(parseFinancialText('شماره فاکتور ۱۲۳ بود و هزینه دو میلیون تومان شد').transactions.map((item) => item.amount), [2_000_000]);
});
test('does not prefer a noisier candidate merely because it contains more numbers', () => {
  const result = parseRecognitionCandidates([
    { transcript: 'پنج میلیون فروش داشتم', confidence: 0.91 },
    { transcript: 'پنج میلیون فروش و دو میلیون هزینه داشتم', confidence: 0.2 },
  ]);
  assert.equal(result.transcript, 'پنج میلیون فروش داشتم');
  assert.equal(result.transactions.length, 1);
  assert.equal(result.candidateDisagreement, true);
  assert.equal(result.transactions[0].reviewCode, 'candidate-count-disagreement');
});
