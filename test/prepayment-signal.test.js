import test from 'node:test';
import assert from 'node:assert/strict';

import { readPrepaymentMention } from '../shared/prepaymentSpeech.js';
import { parseFinancialText } from '../shared/parser.js';
import { normalizeFinancialEvent } from '../shared/financialEvent.js';
import { factsFromEvent } from '../shared/eventFacts.js';
import { DECISION_STATUS, decide, decisionAuthorizesPosting } from '../shared/accountingDecision.js';
import { ECONOMIC_FAMILIES } from '../shared/economicFamily.js';
import { TREATMENTS } from '../shared/factRequirements.js';

/**
 * «پیش‌پیش»، «بیعانه»، «علی‌الحساب» — پول رفته ولی هیچ چیزی مصرف نشده.
 *
 * تا امروز «صد و بیست میلیون پیش‌پیش ریختیم واسه خرید ورق» ماهیتش «نامشخص»
 * می‌شد. مبلغ درست بود و دسته تقریبی، ولی موتور نمی‌فهمید این یک پیش‌پرداخت
 * است — یعنی دارایی، نه هزینه.
 *
 * این واژه‌ها دسته نیستند؛ نشانهٔ ماهیت‌اند. «پیش‌پیش واسه خرید ورق» دسته‌اش
 * مواد و کالاست و ماهیتش پیش‌پرداخت.
 */

const TODAY = '2026-09-24T09:00:00.000Z';

test('واژه‌های پیش‌پرداخت شناخته می‌شوند', () => {
  for (const text of [
    'صد و بیست میلیون پیش‌پیش ریختیم واسه خرید ورق',
    'بیست میلیون بیعانه دادم به فروشنده',
    'پنج میلیون علی‌الحساب به پیمانکار دادم',
    'پیش‌پرداخت قرارداد را واریز کردم',
    'جلوجلو پول جنس رو دادم',
  ]) {
    assert.equal(readPrepaymentMention(text), true, `«${text}» نشانهٔ پیش‌پرداخت دارد`);
  }
});

test('پرداخت عادی نشانهٔ پیش‌پرداخت ندارد', () => {
  for (const text of [
    'اجاره این ماه رو دادم',
    'قبض برق رو پرداخت کردم',
    'حقوق پرسنل رو دادم',
  ]) {
    assert.equal(readPrepaymentMention(text), false, `«${text}» نباید پیش‌پرداخت خوانده شود`);
  }
});

test('پارسر نشانه را روی تراکنش می‌گذارد', () => {
  const [item] = parseFinancialText('صد و بیست میلیون پیش‌پیش ریختیم واسه خرید ورق', { source: 'voice' }).transactions;
  assert.equal(item.prepaymentSignal, true);
});

// ---------------------------------------------------------------------------
// اثرش روی تصمیم
// ---------------------------------------------------------------------------

const advanceOut = (extra = {}) => normalizeFinancialEvent({
  kind: 'cash-expense', amount: 120_000_000, occurredAt: TODAY,
  category: 'مواد و کالا', accountId: 'bank-mellat', counterparty: 'فولاد مبارکه',
  evidence: 'صد و بیست میلیون پیش‌پیش ریختیم واسه خرید ورق',
  prepaymentSignal: true, ...extra,
});

test('پیش‌پرداخت خرید دیگر «نامشخص» نیست', () => {
  const decision = decide(factsFromEvent(advanceOut()), { today: TODAY });
  assert.equal(decision.family, ECONOMIC_FAMILIES.ASSET_CREATION, 'پول رفته و منفعت آینده ساخته');
  assert.notEqual(decision.family, 'unknown');
});

test('و به‌عنوان پیش‌پرداخت تأمین‌کننده نام‌گذاری می‌شود', () => {
  const decision = decide(factsFromEvent(advanceOut()), { today: TODAY });
  assert.equal(decision.treatment, TREATMENTS.SUPPLIER_ADVANCE);
});

test('ولی هنوز سند نمی‌سازد — قاعده‌اش در این فاز نیست', () => {
  // ارزشش این است که ماهیت درست نام‌گذاری شود؛ ساختن قاعدهٔ ثبتش کار فاز بعد
  // است. نام درست، همان دادهٔ خامی است که گزارش اختلاف لازم دارد.
  const decision = decide(factsFromEvent(advanceOut()), { today: TODAY });
  assert.equal(decision.decisionStatus, DECISION_STATUS.UNSUPPORTED);
  assert.equal(decisionAuthorizesPosting(decision), false);
  assert.ok(decision.explanation?.trim());
});

test('بیعانهٔ دریافتی، دریافت پیش از انجام تعهد است', () => {
  // آینهٔ همان خطا در جهت مخالف: پولی که گرفته‌ایم ولی هنوز کاری نکرده‌ایم،
  // درآمد نیست.
  const event = normalizeFinancialEvent({
    kind: 'cash-income', amount: 30_000_000, occurredAt: TODAY,
    category: 'فروش', accountId: 'bank-mellat', counterparty: 'شرکت آرمان',
    evidence: 'سی میلیون بیعانه از مشتری گرفتم', prepaymentSignal: true,
  });
  const decision = decide(factsFromEvent(event), { today: TODAY });
  assert.equal(decision.family, ECONOMIC_FAMILIES.ADVANCE_RECEIVED);
  assert.equal(decisionAuthorizesPosting(decision), false, 'درآمد شناسایی نمی‌شود');
});

test('پرداخت عادی دست‌نخورده می‌ماند', () => {
  const event = normalizeFinancialEvent({
    kind: 'cash-expense', amount: 3_000_000, occurredAt: TODAY,
    category: 'قبوض', accountId: 'cash', evidence: 'قبض برق رو سه میلیون دادم',
  });
  assert.notEqual(decide(factsFromEvent(event), { today: TODAY }).treatment, TREATMENTS.SUPPLIER_ADVANCE);
});
