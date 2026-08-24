import test from 'node:test';
import assert from 'node:assert/strict';
import { decideVoiceRoute } from '../src/lib/voiceDecision.js';

const reliable = {
  transcript: 'پنج میلیون فروش داشتم',
  speechConfidence: 0.91,
  transactions: [{ amount: 5_000_000, type: 'income', category: 'فروش', confidence: 0.93, alternatives: [] }],
};

test('uses the local fast path for a final, agreed financial command', () => {
  assert.deepEqual(decideVoiceRoute(reliable, { online: true, transcriptFinal: true }), { route: 'local', score: 100, reasons: [] });
});

test('routes acoustic disagreements and low reported speech confidence to the server', () => {
  const disagreement = {
    ...reliable,
    candidateDisagreement: true,
    transactions: [{ ...reliable.transactions[0], needsReview: true, reviewCode: 'candidate-amount-disagreement', alternatives: [50_000_000] }],
  };
  assert.equal(decideVoiceRoute(disagreement, { online: true, transcriptFinal: true }).route, 'server');
  assert.equal(decideVoiceRoute({ ...reliable, speechConfidence: 0.2 }, { online: true, transcriptFinal: true }).route, 'server');
});

test('keeps semantic ambiguity local for confirmation but never trusts unfinished online text', () => {
  const ambiguousIntent = { ...reliable, transactions: [{ ...reliable.transactions[0], confidence: 0.58, needsReview: true }] };
  assert.equal(decideVoiceRoute(ambiguousIntent, { online: true, transcriptFinal: true }).route, 'local-review');
  assert.equal(decideVoiceRoute(reliable, { online: true, transcriptFinal: false }).route, 'server');
});

test('allows an offline provisional review when a transaction exists', () => {
  const disagreement = { ...reliable, candidateDisagreement: true };
  assert.equal(decideVoiceRoute(disagreement, { online: false, transcriptFinal: true }).route, 'local-review');
  assert.equal(decideVoiceRoute(reliable, { online: false, transcriptFinal: false }).route, 'unavailable');
});
