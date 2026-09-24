import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFinancialText } from '../shared/parser.js';
import { normalizeFinancialEvent } from '../shared/financialEvent.js';
import { factsFromEvent } from '../shared/eventFacts.js';
import { DECISION_STATUS, decide, decisionAuthorizesPosting } from '../shared/accountingDecision.js';
import { FACT_KEYS, QUESTION_KINDS } from '../shared/factRequirements.js';
import { applyAnswer } from '../shared/questionAnswer.js';

/**
 * «تومن» محاوره‌ای — خطای هزاربرابری.
 *
 * «یه سی تومن ریختم واسه چاپخونه» در گفتار کسب‌وکاری یعنی سی میلیون. ولی
 * «پنجاه تومن» برای تاکسی یعنی پنجاه هزار. هر دو درست‌اند و به بافت بستگی
 * دارند — و پارسر بافت را نمی‌فهمد.
 *
 * تا امروز بی‌صدا ×۱۰۰۰ می‌کرد. جایی که حدس زدن یک خطای هزاربرابری در مبلغ
 * می‌سازد، همان جایی است که باید پرسید.
 */

const TODAY = '2026-09-24T09:00:00.000Z';

const voiceEvent = (text) => {
  const [item] = parseFinancialText(text, { source: 'voice' }).transactions;
  return normalizeFinancialEvent({
    kind: item.type === 'income' ? 'cash-income' : 'cash-expense',
    amount: item.amount,
    occurredAt: TODAY,
    category: item.category,
    accountId: 'cash',
    evidence: text,
    amountScaleAmbiguous: item.amountScaleAmbiguous,
  });
};

test('پارسر مبلغ محاوره‌ای را مبهم علامت می‌زند', () => {
  const [item] = parseFinancialText('یه سی تومن ریختم واسه چاپخونه', { source: 'voice' }).transactions;
  assert.equal(item.amountScaleAmbiguous, true);
  assert.equal(item.amount, 30_000, 'مقدار پیش‌فرض همان قبلی می‌ماند تا مسیر قدیمی نشکند');
});

test('مبلغ صریح مبهم نیست', () => {
  const [item] = parseFinancialText('سی میلیون تومان دادم', { source: 'voice' }).transactions;
  assert.notEqual(item.amountScaleAmbiguous, true);
});

test('متن تایپ‌شده مبهم نیست', () => {
  // این قاعده فقط برای گفتار است؛ کسی که تایپ می‌کند عدد را کامل می‌نویسد.
  const [item] = parseFinancialText('یه سی تومن ریختم واسه چاپخونه', { source: 'text' }).transactions;
  assert.notEqual(item.amountScaleAmbiguous, true);
});

test('مبلغ مبهم، خودکار ثبت نمی‌شود و سؤال می‌سازد', () => {
  const decision = decide(factsFromEvent(voiceEvent('یه سی تومن ریختم واسه چاپخونه')), { today: TODAY });
  assert.equal(decision.decisionStatus, DECISION_STATUS.NEEDS_USER_INPUT);
  assert.equal(decisionAuthorizesPosting(decision), false);
  assert.equal(decision.question.fact, FACT_KEYS.AMOUNT_SCALE);
  assert.equal(decision.question.kind, QUESTION_KINDS.OPTIONS);
});

test('گزینه‌ها خودِ دو مبلغ را نشان می‌دهند', () => {
  // «سی هزار یا سی میلیون؟» — نه اصطلاح فنی، خودِ عدد.
  const decision = decide(factsFromEvent(voiceEvent('یه سی تومن ریختم واسه چاپخونه')), { today: TODAY });
  const values = decision.question.options.map((option) => option.value);
  assert.deepEqual(values.sort((left, right) => left - right), [30_000, 30_000_000]);
  for (const option of decision.question.options) {
    assert.ok(option.label?.trim(), 'هر گزینه باید برچسب خوانا داشته باشد');
  }
});

test('سؤال مبلغ پیش از هر سؤال دیگری می‌آید', () => {
  // بیمهٔ با مبلغ مبهم: تا مبلغ روشن نشده، پرسیدن دورهٔ پوشش بی‌معناست.
  const event = normalizeFinancialEvent({
    kind: 'cash-expense', amount: 50_000, occurredAt: TODAY, category: 'بیمه',
    accountId: 'bank', evidence: 'یه پنجاه تومن بیمه دادم', amountScaleAmbiguous: true,
  });
  assert.equal(decide(factsFromEvent(event), { today: TODAY }).question.fact, FACT_KEYS.AMOUNT_SCALE);
});

test('جواب کاربر مبلغ را می‌نشاند', () => {
  const event = voiceEvent('یه سی تومن ریختم واسه چاپخونه');
  const patch = applyAnswer(event, { fact: FACT_KEYS.AMOUNT_SCALE, value: 30_000_000 }, { today: TODAY });
  assert.equal(patch.amount, 30_000_000);
  assert.equal(patch.amountScaleAmbiguous, false, 'ابهام باید بسته شود، وگرنه دوباره پرسیده می‌شود');
});

test('بعد از جواب، ابهام برمی‌گردد به مسیر عادی', () => {
  const event = voiceEvent('یه سی تومن ریختم واسه چاپخونه');
  const answered = normalizeFinancialEvent({ ...event, amount: 30_000_000, amountScaleAmbiguous: false });
  const decision = decide(factsFromEvent(answered), { today: TODAY });
  assert.notEqual(decision.question?.fact, FACT_KEYS.AMOUNT_SCALE);
});

test('گزینهٔ نامعتبر پذیرفته نمی‌شود', () => {
  const event = voiceEvent('یه سی تومن ریختم واسه چاپخونه');
  assert.throws(
    () => applyAnswer(event, { fact: FACT_KEYS.AMOUNT_SCALE, value: 12_345 }, { today: TODAY }),
    (error) => error.code === 'ANSWER_OPTION_UNKNOWN',
  );
});
