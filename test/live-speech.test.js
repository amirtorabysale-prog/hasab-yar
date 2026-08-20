import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersianRecognizer, liveSpeechSupported } from '../src/lib/liveSpeech.js';

test('configures Persian live recognition and returns alternatives', () => {
  class FakeRecognition {
    constructor() { this.phrases = []; }
    start() { this.started = true; }
  }
  class FakePhrase {
    constructor(phrase, boost) { this.phrase = phrase; this.boost = boost; }
  }
  global.window = { SpeechRecognition: FakeRecognition, SpeechRecognitionPhrase: FakePhrase };
  let snapshot;
  const recognition = createPersianRecognizer({ phrases: ['آرایش'], onUpdate: (value) => { snapshot = value; } });
  assert.equal(liveSpeechSupported(), true);
  assert.equal(recognition.lang, 'fa-IR');
  assert.equal(recognition.interimResults, true);
  assert.equal(recognition.maxAlternatives, 3);
  assert.ok(recognition.phrases.some((item) => item.phrase === 'آرایش' && item.boost === 5));

  const result = [
    { transcript: 'دوازده میلیون فروش داشتم', confidence: 0.91 },
    { transcript: 'دویست میلیون فروش داشتم', confidence: 0.52 },
  ];
  result.isFinal = true;
  recognition.onresult({ results: [result] });
  assert.equal(snapshot.transcript, 'دوازده میلیون فروش داشتم');
  assert.deepEqual(snapshot.candidates.map((item) => item.transcript), ['دوازده میلیون فروش داشتم', 'دویست میلیون فروش داشتم']);
  delete global.window;
});
