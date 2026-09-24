import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFinancialEvent } from '../shared/financialEvent.js';
import { factsFromEvent } from '../shared/eventFacts.js';
import { DECISION_STATUS, decide, decisionAuthorizesPosting } from '../shared/accountingDecision.js';
import { ECONOMIC_FAMILIES } from '../shared/economicFamily.js';
import { TREATMENTS } from '../shared/factRequirements.js';
import { ROLES, planJournal } from '../shared/accountingRules.js';

/**
 * چهار جهت زمانی — یک زیرسامانه.
 *
 * تاریخ پرداخت، تاریخ فاکتور، تاریخ تحویل و تاریخ شناسایی چهار چیز متفاوت‌اند.
 * هر چهار جهت یک سؤال مشترک دارند: پول و تعهد در دو زمان متفاوت اتفاق
 * افتاده‌اند — کدام زودتر؟
 *
 * جدول‌های تصمیم در `docs/wp2-timing-decision-tables.md`.
 */

const TODAY = '2026-09-24T00:00:00.000Z';
const roles = (event, decision) => planJournal(event, decision).lines.map((line) => line.role);

// ---------------------------------------------------------------------------
// جهت ب — مصرف پیش از پرداخت
// ---------------------------------------------------------------------------

const accrued = (extra = {}) => normalizeFinancialEvent({
  kind: 'payable-opened', amount: 9_000_000, occurredAt: TODAY,
  category: 'قبوض', counterparty: 'ادارهٔ برق',
  evidence: 'قبض برق کارگاه اومده نه میلیون، موعدش هفته بعده',
  servicePeriodStart: '2026-08-23T00:00:00.000Z',
  servicePeriodEnd: '2026-09-22T00:00:00.000Z',
  ...extra,
});

test('ب — قبضی که آمده ولی پرداخت نشده، بدهی تحقق‌یافته است', () => {
  const decision = decide(factsFromEvent(accrued()), { today: TODAY });
  assert.equal(decision.family, ECONOMIC_FAMILIES.LIABILITY_CREATION);
  assert.equal(decision.treatment, TREATMENTS.ACCRUED_EXPENSE);
  assert.equal(decision.decisionStatus, DECISION_STATUS.DECIDED);
});

test('ب — سندش هزینه و پرداختنی است، بدون لمس نقد', () => {
  const event = accrued();
  const list = roles(event, decide(factsFromEvent(event), { today: TODAY }));
  assert.ok(list.includes(ROLES.EXPENSE_CATEGORY), 'هزینه در دورهٔ مصرف شناسایی می‌شود');
  assert.ok(list.includes(ROLES.PAYABLE), 'و بدهی ساخته می‌شود');
  assert.equal(list.includes(ROLES.CASH), false, 'هنوز پولی جابه‌جا نشده');
});

test('ب — مبلغ برآوردی همیشه به حسابدار می‌رود', () => {
  // برآورد قضاوت است، نه واقعیت. حتی با طرف حساب و دورهٔ روشن.
  const decision = decide(factsFromEvent(accrued({ estimateBasis: 'میانگین سه ماه گذشته' })), { today: TODAY });
  assert.equal(decisionAuthorizesPosting(decision), false);
});

// ---------------------------------------------------------------------------
// جهت ج — دریافت پیش از انجام تعهد
// ---------------------------------------------------------------------------

const advance = (extra = {}) => normalizeFinancialEvent({
  kind: 'cash-income', amount: 30_000_000, occurredAt: TODAY,
  category: 'فروش', counterparty: 'شرکت آرمان', accountId: 'bank-mellat',
  evidence: 'سی میلیون بیعانه از مشتری برای سفارش جدید گرفتم',
  prepaymentSignal: true, ...extra,
});

test('ج — بیعانه هیچ سطر درآمدی نمی‌سازد', () => {
  // بدترین خطای این جهت: درآمد جعلی که هم سود را باد می‌کند و هم مالیات
  // می‌سازد، در حالی که هنوز هیچ کاری انجام نشده.
  const event = advance();
  const decision = decide(factsFromEvent(event), { today: TODAY });
  assert.equal(decision.family, ECONOMIC_FAMILIES.ADVANCE_RECEIVED);
  const list = roles(event, decision);
  assert.equal(list.includes(ROLES.INCOME_CATEGORY), false, 'هیچ درآمدی شناسایی نمی‌شود');
  assert.ok(list.includes(ROLES.CUSTOMER_ADVANCE), 'پیش‌دریافت، بدهی ماست');
  assert.ok(list.includes(ROLES.CASH));
});

test('ج — بدون دورهٔ خدمت، برنامهٔ شناسایی ساخته نمی‌شود', () => {
  const decision = decide(factsFromEvent(advance()), { today: TODAY });
  assert.equal(decision.treatment, TREATMENTS.CUSTOMER_ADVANCE);
  assert.equal(decision.recognitionMethod, null, 'بدون دوره نمی‌شود پخش کرد');
});

test('ج — با دورهٔ خدمت، درآمد انتقالی با برنامهٔ ماهانه', () => {
  const decision = decide(factsFromEvent(advance({
    servicePeriodStart: TODAY, servicePeriodEnd: '2027-09-23T00:00:00.000Z',
  })), { today: TODAY });
  assert.equal(decision.treatment, TREATMENTS.DEFERRED_REVENUE);
  assert.equal(decision.recognitionMethod, 'monthly-straight-line');
});

// ---------------------------------------------------------------------------
// جهت د — انجام تعهد پیش از دریافت
// ---------------------------------------------------------------------------

const earned = (extra = {}) => normalizeFinancialEvent({
  kind: 'receivable-opened', amount: 45_000_000, occurredAt: TODAY,
  category: 'فروش', counterparty: 'شرکت بهار',
  evidence: 'کار پروژه تموم شد ولی هنوز فاکتور نزدیم',
  deliveryDate: '2026-09-20T00:00:00.000Z', ...extra,
});

test('د — خدمت انجام‌شدهٔ فاکتورنشده، درآمد تحقق‌یافته است', () => {
  const decision = decide(factsFromEvent(earned()), { today: TODAY });
  assert.equal(decision.family, ECONOMIC_FAMILIES.RECEIVABLE_CREATION);
  assert.equal(decision.treatment, TREATMENTS.ACCRUED_REVENUE);
});

test('د — سندش دریافتنی و درآمد است، بدون لمس نقد', () => {
  const event = earned();
  const list = roles(event, decide(factsFromEvent(event), { today: TODAY }));
  assert.ok(list.includes(ROLES.RECEIVABLE));
  assert.ok(list.includes(ROLES.INCOME_CATEGORY), 'تعهد انجام شده، پس درآمد شناسایی می‌شود');
  assert.equal(list.includes(ROLES.CASH), false);
});

// ---------------------------------------------------------------------------
// جهت الف — تعمیم: دورهٔ گفته‌شده در جمله
// ---------------------------------------------------------------------------

test('الف — «برای شش ماه جلوتر» پیش‌پرداخت است، حتی وقتی دسته خدمت دوره‌دار نیست', () => {
  // T009 آزمون صوتی: «پونزده میلیون شارژ ساختمان رو برای شش ماه جلوتر تسویه
  // کردم» ماهیتش نامشخص می‌شد، چون دستهٔ «قبوض» در فهرست خدمات دوره‌دار نیست.
  // ولی خودِ جمله دوره را گفته.
  const event = normalizeFinancialEvent({
    kind: 'cash-expense', amount: 15_000_000, occurredAt: TODAY,
    category: 'قبوض', accountId: 'bank-mellat',
    evidence: 'پونزده میلیون شارژ ساختمان اداری رو برای شش ماه جلوتر تسویه کردم',
    servicePeriodStart: TODAY, servicePeriodEnd: '2027-03-20T00:00:00.000Z',
  });
  const decision = decide(factsFromEvent(event), { today: TODAY });
  assert.equal(decision.family, ECONOMIC_FAMILIES.ASSET_CREATION);
  assert.equal(decision.treatment, TREATMENTS.PREPAID_EXPENSE);
});

// ---------------------------------------------------------------------------
// قاعدهٔ مشترک هر چهار جهت
// ---------------------------------------------------------------------------

test('هیچ‌کدام از چهار جهت، سند نامتوازن نمی‌سازد', () => {
  for (const event of [accrued(), advance(), earned()]) {
    const lines = planJournal(event, decide(factsFromEvent(event), { today: TODAY })).lines;
    const debit = lines.reduce((sum, line) => sum + line.debit, 0);
    const credit = lines.reduce((sum, line) => sum + line.credit, 0);
    assert.equal(debit, credit, `${event.kind}: سند نامتوازن`);
    assert.equal(debit, event.amount);
  }
});

test('هر تصمیم نسخهٔ قاعده‌اش را حمل می‌کند', () => {
  for (const event of [accrued(), advance(), earned()]) {
    const decision = decide(factsFromEvent(event), { today: TODAY });
    assert.ok(decision.policyVersion, `${event.kind}: تصمیم بدون نسخهٔ قاعده`);
  }
});
