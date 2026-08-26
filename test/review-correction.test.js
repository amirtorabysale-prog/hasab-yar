import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTransactionReview, reviewBatchSummary, withReviewAssessment } from '../shared/review.js';
import { isCorrectionCommand, previewCorrection } from '../shared/correction.js';

const current = { id: 'tx-1', amount: 700_000, type: 'expense', category: 'حمل‌ونقل', accountId: 'cash' };

test('explainable review distinguishes ready, review and unintelligible items', () => {
  const ready = withReviewAssessment({ amount: 900_000, type: 'income', category: 'فروش', confidenceDetails: {
    amount: { score: 0.97 }, type: { score: 0.94 }, category: { score: 0.92 }, account: { score: 0.84 },
  } });
  assert.equal(ready.reviewState, 'ready');
  const unintelligible = withReviewAssessment({ amount: 0, type: 'expense', category: '' });
  assert.equal(assessTransactionReview(unintelligible).state, 'unintelligible');
  assert.equal(unintelligible.needsReview, true);
  assert.equal(withReviewAssessment({ ...ready, needsReview: true, warning: 'مبلغ غیرعادی است.' }).reviewState, 'review');
  assert.deepEqual(reviewBatchSummary({ transactions: [ready, { ...ready, needsReview: true }] }), { ready: 1, review: 1, unintelligible: 0, total: 2 });
});

test('recognizes conversational correction commands', () => {
  assert.equal(isCorrectionCommand('نه، هفتصد و پنجاه هزار بود'), true);
  assert.equal(isCorrectionCommand('بزن هزینه پیک'), true);
  assert.equal(isCorrectionCommand('امروز فروش داشتم'), false);
  assert.equal(isCorrectionCommand('امروز هزینه پیک هفتصد هزار بود'), false);
});

test('corrects only the mentioned fields of the latest transaction preview', () => {
  const amount = previewCorrection('نه، هفتصد و پنجاه هزار بود', current);
  assert.deepEqual(amount.changes, { amount: 750_000 });
  const category = previewCorrection('بزن هزینه خوراک', current, { categories: [{ name: 'خوراک', type: 'expense' }] });
  assert.equal(category.changes.category, 'خوراک');
  assert.equal(category.changes.type, 'expense');
});

test('matches a named account without changing unrelated fields', () => {
  const result = previewCorrection('حسابش کن بانک ملت', current, { accounts: [{ id: 'bank', name: 'بانک ملت' }] });
  assert.deepEqual(result.changes, { accountId: 'bank', accountName: 'بانک ملت' });
});
