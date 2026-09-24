import test from 'node:test';
import assert from 'node:assert/strict';

import { detectVoiceIntent, intentToFinancialEvent } from '../shared/voiceIntent.js';
import { normalizeFinancialEvent } from '../shared/financialEvent.js';
import { factsFromEvent } from '../shared/eventFacts.js';
import { DECISION_STATUS, decide, decisionAuthorizesPosting } from '../shared/accountingDecision.js';
import { ECONOMIC_FAMILIES } from '../shared/economicFamily.js';
import { FACT_KEYS, QUESTION_KINDS, TREATMENTS } from '../shared/factRequirements.js';
import { ROLES, planJournal } from '../shared/accountingRules.js';

/**
 * چک از مسیر صدا — درآمد جعلی، بی‌صدا.
 *
 * فرم ثبت چک این را می‌پرسد و هشدارش را هم می‌نویسد: چک بابت فروش تازه است یا
 * بابت طلب قبلی؟ اگر بابت فاکتوری باشد که قبلاً ثبت شده، آن فروش همان روز
 * درآمد شده و شناسایی دوباره‌اش یعنی همان فروش دو بار در سود دوره و دو بار در
 * مالیات.
 *
 * ولی مسیر صدا این انتخاب را اصلاً نداشت و همیشه «فروش تازه» فرض می‌کرد —
 * حتی وقتی کاربر صریح می‌گفت «بابت فاکتور قبلی».
 */

const TODAY = '2026-09-24T00:00:00.000Z';

const chequeEvent = (extra = {}) => normalizeFinancialEvent({
  kind: 'cheque-received', amount: 3_000_000, occurredAt: TODAY,
  counterparty: 'شرکت بهار', category: 'فروش', ...extra,
});

test('چک دریافتی، دریافتنی می‌سازد نه بدهی', () => {
  const decision = decide(factsFromEvent(chequeEvent()), { today: TODAY });
  assert.equal(decision.family, ECONOMIC_FAMILIES.RECEIVABLE_CREATION);
});

test('چک بدون تعیین بابت، خودکار ثبت نمی‌شود', () => {
  const decision = decide(factsFromEvent(chequeEvent()), { today: TODAY });
  assert.equal(decision.decisionStatus, DECISION_STATUS.NEEDS_USER_INPUT);
  assert.equal(decisionAuthorizesPosting(decision), false);
  assert.ok(decision.missingFacts.includes(FACT_KEYS.CHEQUE_AGAINST));
});

test('سؤالش گزینه‌ای است، با همان دو گزینهٔ فرم', () => {
  const decision = decide(factsFromEvent(chequeEvent()), { today: TODAY });
  assert.equal(decision.question.fact, FACT_KEYS.CHEQUE_AGAINST);
  assert.equal(decision.question.kind, QUESTION_KINDS.OPTIONS);
  assert.deepEqual(decision.question.options.map((option) => option.value).sort(), ['income', 'receivable']);
});

test('«بابت فروش تازه» درآمد شناسایی می‌کند', () => {
  const event = chequeEvent({ chequeAgainst: 'income' });
  const decision = decide(factsFromEvent(event), { today: TODAY });
  assert.equal(decision.decisionStatus, DECISION_STATUS.DECIDED);
  const roles = planJournal(event, decision).lines.map((line) => line.role);
  assert.ok(roles.includes(ROLES.CHEQUE_RECEIVABLE));
  assert.ok(roles.includes(ROLES.INCOME_CATEGORY), 'فروش تازه باید درآمد بسازد');
});

test('«بابت طلب قبلی» هیچ درآمدی نمی‌سازد', () => {
  // این همان خطایی است که تا امروز بی‌صدا اتفاق می‌افتاد: فروش دو بار در سود
  // دوره و دو بار در مالیات.
  const event = chequeEvent({ chequeAgainst: 'receivable' });
  const decision = decide(factsFromEvent(event), { today: TODAY });
  assert.equal(decision.decisionStatus, DECISION_STATUS.DECIDED);
  assert.equal(decision.treatment, TREATMENTS.CHEQUE_FORM_CHANGE);

  const lines = planJournal(event, decision).lines;
  const roles = lines.map((line) => line.role);
  assert.equal(roles.includes(ROLES.INCOME_CATEGORY), false, 'هیچ سطری نباید درآمد باشد');
  assert.ok(roles.includes(ROLES.CHEQUE_RECEIVABLE), 'طلب به اسناد دریافتنی منتقل می‌شود');
  assert.ok(roles.includes(ROLES.RECEIVABLE), 'و از حساب دریافتنی کم می‌شود');
  assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), lines.reduce((sum, line) => sum + line.credit, 0));
});

test('مسیر صدا هم همین سؤال را می‌گیرد', () => {
  // «چک پنج میلیونی بابت فاکتور قبلی گرفتم» تا امروز بی‌چون‌وچرا درآمد
  // می‌ساخت، با اینکه کاربر صریح گفته بود بابت چیست.
  const intent = detectVoiceIntent('چک پنج میلیونی از شرکت بهار گرفتم');
  const event = normalizeFinancialEvent(intentToFinancialEvent(intent));
  assert.equal(event.kind, 'cheque-received');

  const decision = decide(factsFromEvent(event), { today: TODAY });
  assert.equal(decisionAuthorizesPosting(decision), false, 'بدون جواب نباید ثبت شود');
  assert.equal(decision.question.fact, FACT_KEYS.CHEQUE_AGAINST);
});

test('چک پرداختی، بدهی می‌سازد نه دریافتنی', () => {
  const event = normalizeFinancialEvent({
    kind: 'cheque-issued', amount: 2_000_000, occurredAt: TODAY, counterparty: 'تأمین‌کننده', category: 'مواد و کالا',
  });
  assert.equal(decide(factsFromEvent(event), { today: TODAY }).family, ECONOMIC_FAMILIES.LIABILITY_CREATION);
});
