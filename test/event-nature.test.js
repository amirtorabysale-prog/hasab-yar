import test from 'node:test';
import assert from 'node:assert/strict';

import { EVENT_NATURES, natureAffectsPast, readEventNature } from '../shared/eventNature.js';
import { normalizeFinancialEvent } from '../shared/financialEvent.js';
import { factsFromEvent } from '../shared/eventFacts.js';
import { DECISION_STATUS, decide, decisionAuthorizesPosting } from '../shared/accountingDecision.js';
import { ECONOMIC_FAMILIES } from '../shared/economicFamily.js';

/**
 * هفت نوع رویداد که در یک دوره ممکن است و هر کدام سند متفاوتی دارند.
 *
 * مهم‌ترینشان تفاوت **اصلاح اشتباه** و **تغییر برآورد** است. این دو شبیه هم
 * به نظر می‌رسند و کاملاً متفاوت‌اند:
 *
 * - اصلاح اشتباه: آن روز غلط ثبت شده. گذشته باید درست شود.
 * - تغییر برآورد: آن روز درست بود، امروز اطلاعات تازه‌ای داریم. گذشته
 *   دست‌نخورده می‌ماند و اثر از این به بعد است.
 *
 * اشتباه‌گرفتنشان یعنی دورهٔ گذشته — که ممکن است بسته و اظهار شده باشد —
 * بی‌دلیل دست‌کاری می‌شود.
 */

const TODAY = '2026-09-24T00:00:00.000Z';

test('جملهٔ اصلاحی، اصلاح اشتباه است', () => {
  for (const text of [
    'اشتباه شد، مبلغ پنج میلیون بود',
    'ببخشید اشتباه ثبت کردم، درستش سه میلیونه',
    'اون ثبت قبلی غلط بود',
  ]) {
    assert.equal(readEventNature(text), EVENT_NATURES.CORRECTION, `«${text}»`);
  }
});

test('تغییر برآورد، اصلاح اشتباه نیست', () => {
  for (const text of [
    'عمر مفید دستگاه رو از پنج سال به هفت سال تغییر دادیم',
    'برآورد ذخیره مطالبات رو به‌روز کردیم',
    'تخمین هزینه پروژه عوض شد',
  ]) {
    assert.equal(readEventNature(text), EVENT_NATURES.ESTIMATE_CHANGE, `«${text}»`);
  }
});

test('برگشت سند', () => {
  assert.equal(readEventNature('این سند رو برگشت بزن'), EVENT_NATURES.REVERSAL);
  assert.equal(readEventNature('فاکتور رو ابطال کن'), EVENT_NATURES.REVERSAL);
});

test('ثبت افتتاحیه', () => {
  assert.equal(readEventNature('ثبت افتتاحیه سال مالی جدید'), EVENT_NATURES.OPENING);
});

test('ثبت تعدیلی پایان دوره', () => {
  assert.equal(readEventNature('ثبت تعدیلی پایان سال رو بزن'), EVENT_NATURES.PERIOD_END_ADJUSTMENT);
});

test('رویداد عادی، هیچ‌کدام از این‌ها نیست', () => {
  for (const text of [
    'دوازده میلیون اجاره دادم',
    'قبض برق رو پرداخت کردم',
    'فاکتور فروش زدم',
  ]) {
    assert.equal(readEventNature(text), EVENT_NATURES.NEW, `«${text}»`);
  }
});

// ---------------------------------------------------------------------------
// قاعدهٔ حاکم: کدام‌ها گذشته را دست می‌زنند
// ---------------------------------------------------------------------------

test('اصلاح اشتباه و برگشت، گذشته را دست می‌زنند', () => {
  assert.equal(natureAffectsPast(EVENT_NATURES.CORRECTION), true);
  assert.equal(natureAffectsPast(EVENT_NATURES.REVERSAL), true);
});

test('تغییر برآورد هرگز گذشته را دست نمی‌زند', () => {
  // این قاعدهٔ اصلی این بخش است. دورهٔ بسته و اظهارشده نباید به‌خاطر
  // اطلاعات تازه بازنویسی شود.
  assert.equal(natureAffectsPast(EVENT_NATURES.ESTIMATE_CHANGE), false);
});

test('رویداد عادی هم گذشته را دست نمی‌زند', () => {
  assert.equal(natureAffectsPast(EVENT_NATURES.NEW), false);
});

// ---------------------------------------------------------------------------
// اثر روی تصمیم
// ---------------------------------------------------------------------------

const withNature = (nature, extra = {}) => normalizeFinancialEvent({
  kind: 'cash-expense', amount: 5_000_000, occurredAt: TODAY,
  category: 'اجاره', accountId: 'bank-mellat', eventNature: nature, ...extra,
});

test('رویدادی که گذشته را دست می‌زند، هیچ‌وقت خودکار ثبت نمی‌شود', () => {
  for (const nature of [EVENT_NATURES.CORRECTION, EVENT_NATURES.REVERSAL]) {
    const decision = decide(factsFromEvent(withNature(nature)), { today: TODAY });
    assert.equal(decisionAuthorizesPosting(decision), false, `${nature} نباید خودکار ثبت شود`);
    assert.equal(decision.decisionStatus, DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW);
  }
});

test('اصلاح، خانوادهٔ خودش را می‌گیرد نه رویداد تازه', () => {
  const decision = decide(factsFromEvent(withNature(EVENT_NATURES.CORRECTION)), { today: TODAY });
  assert.equal(decision.family, ECONOMIC_FAMILIES.CORRECTION_OR_REVERSAL);
});

test('تغییر برآورد هم به حسابدار می‌رود ولی خانواده‌اش فرق دارد', () => {
  const decision = decide(factsFromEvent(withNature(EVENT_NATURES.ESTIMATE_CHANGE)), { today: TODAY });
  assert.equal(decision.family, ECONOMIC_FAMILIES.VALUE_OR_ESTIMATE_CHANGE);
  assert.equal(decisionAuthorizesPosting(decision), false);
});

test('دلیلِ توقف، تفاوت این دو را می‌گوید', () => {
  // حسابدار باید بدون باز کردن کد بفهمد چرا این مورد متوقف شده.
  const correction = decide(factsFromEvent(withNature(EVENT_NATURES.CORRECTION)), { today: TODAY });
  const estimate = decide(factsFromEvent(withNature(EVENT_NATURES.ESTIMATE_CHANGE)), { today: TODAY });
  assert.notEqual(correction.explanation, estimate.explanation);
  assert.ok(estimate.explanation.includes('گذشته'), 'باید بگوید گذشته دست نمی‌خورد');
});

test('پارسر نوع رویداد را روی تراکنش می‌گذارد', async () => {
  const { parseFinancialText } = await import('../shared/parser.js');
  const [item] = parseFinancialText('اشتباه شد، مبلغ پنج میلیون بود', { source: 'voice' }).transactions;
  assert.equal(item?.eventNature, EVENT_NATURES.CORRECTION);
});
