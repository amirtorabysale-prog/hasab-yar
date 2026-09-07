import test from 'node:test';
import assert from 'node:assert/strict';
import { browserRecognitionCanRestart, createPersianRecognizer, liveSpeechErrorMessage, liveSpeechSupported, mergeSpeechSegments } from '../src/lib/liveSpeech.js';
import { parseFinancialText } from '../shared/parser.js';

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

test('turns browser speech errors into useful Persian diagnostics', () => {
  assert.match(liveSpeechErrorMessage('network'), /سرور/);
  assert.match(liveSpeechErrorMessage('no-speech'), /صدای واضح/);
  assert.match(liveSpeechErrorMessage('unknown'), /تشخیص زنده/);
});

test('restarts Chrome recognition only after recoverable early endings', () => {
  assert.equal(browserRecognitionCanRestart(''), true);
  assert.equal(browserRecognitionCanRestart('no-speech'), true);
  assert.equal(browserRecognitionCanRestart('network'), false);
  assert.equal(browserRecognitionCanRestart('not-allowed'), false);
});

// تشخیص گفتار Chrome وسط ضبط تمام می‌شود و دوباره راه می‌افتد؛ نشست تازه
// results خالی دارد. بدون حمل متن، هرچه کاربر تا آن لحظه گفته بود پاک می‌شد و
// مسیر محلی می‌توانست همان نیمهٔ دوم را به‌عنوان کل جمله ثبت کند.
test('metn-e neshast-haye pishin dar rah-andazi dobare gom nemishavad', () => {
  const secondSession = {
    transcript: 'دو میلیون و پونصد حقوق دادم',
    finalTranscript: 'دو میلیون و پونصد حقوق دادم',
    interim: '',
    candidates: [{ transcript: 'دو میلیون و پونصد حقوق دادم', confidence: 0.9 }],
  };
  const merged = mergeSpeechSegments('دوازده میلیون فروش داشتم', secondSession);
  assert.equal(merged.transcript, 'دوازده میلیون فروش داشتم دو میلیون و پونصد حقوق دادم');
  assert.equal(merged.finalTranscript, 'دوازده میلیون فروش داشتم دو میلیون و پونصد حقوق دادم');
  assert.equal(merged.candidates[0].transcript, 'دوازده میلیون فروش داشتم دو میلیون و پونصد حقوق دادم');

  // مهم‌ترین اثر: هر دو تراکنش زنده می‌مانند، نه فقط نیمهٔ دوم.
  const parsed = parseFinancialText(merged.transcript, { source: 'voice' });
  assert.equal(parsed.transactions.length, 2);
  assert.deepEqual(parsed.transactions.map((item) => item.amount), [12_000_000, 2_500_000]);
});

test('metn-e movaqqat ham baad az carry dorost michasbad', () => {
  const merged = mergeSpeechSegments('دوازده میلیون فروش داشتم', {
    transcript: 'و پونصد هزار',
    finalTranscript: '',
    interim: 'و پونصد هزار',
    candidates: [{ transcript: 'و پونصد هزار', confidence: 0.4 }],
  });
  assert.equal(merged.transcript, 'دوازده میلیون فروش داشتم و پونصد هزار');
  // آنچه هنوز نهایی نشده نباید وارد بخش نهایی شود.
  assert.equal(merged.finalTranscript, 'دوازده میلیون فروش داشتم');
});

test('bedun-e carry, snapshot dast nakhorde mimanad', () => {
  const snapshot = { transcript: 'سه میلیون فروش', finalTranscript: 'سه میلیون فروش', interim: '', candidates: [] };
  assert.equal(mergeSpeechSegments('', snapshot), snapshot);
  assert.equal(mergeSpeechSegments('   ', snapshot), snapshot);
});

// تقویت واژه‌های مالی در بعضی نسخه‌های Chrome هست ولی فعال نمی‌شود و نشست را با
// `phrases-not-supported` می‌کشد. تنظیم `phrases` خطا پرتاب نمی‌کند، پس نشست
// بعداً می‌میرد و تشخیص زندهٔ مرورگر کاملاً از کار می‌افتد.
test('نشستِ کشته‌شده با phrases-not-supported، بی‌سروصدا بدون تقویت دوباره شروع می‌شود', () => {
  const built = [];
  class FakeRecognition {
    constructor() { this.phrases = []; this.started = 0; built.push(this); }
    start() { this.started += 1; }
    stop() { this.stopped = true; }
  }
  class FakePhrase {
    constructor(phrase, boost) { this.phrase = phrase; this.boost = boost; }
  }
  global.window = { SpeechRecognition: FakeRecognition, SpeechRecognitionPhrase: FakePhrase };
  const errors = [];
  const ends = [];
  const recognizer = createPersianRecognizer({ onError: (code) => errors.push(code), onEnd: () => ends.push(true) });
  recognizer.start();
  assert.equal(built.length, 1);
  assert.ok(built[0].phrases.length > 0, 'نشست اول با تقویت شروع می‌شود');

  built[0].onerror({ error: 'phrases-not-supported' });
  assert.equal(built.length, 2, 'نشست تازه ساخته می‌شود');
  assert.equal(built[1].phrases.length, 0, 'نشست دوم بدون تقویت است');
  assert.equal(built[1].started, 1, 'نشست دوم خودش شروع می‌شود');
  assert.deepEqual(errors, [], 'کاربر خطایی نمی‌بیند');

  // پایانِ نشستِ کنارگذاشته‌شده، پایان کار کاربر نیست.
  built[0].onend();
  assert.deepEqual(ends, []);
  built[1].onend();
  assert.deepEqual(ends, [true]);

  // اگر بار دوم هم نشد، دیگر حلقه نمی‌زند و خطا به کاربر می‌رسد.
  built[1].onerror({ error: 'phrases-not-supported' });
  assert.equal(built.length, 2);
  assert.deepEqual(errors, ['phrases-not-supported']);

  // بقیهٔ خطاها همان‌طور که بودند به کاربر می‌رسند.
  built[1].onerror({ error: 'network' });
  assert.deepEqual(errors, ['phrases-not-supported', 'network']);
  delete global.window;
});
