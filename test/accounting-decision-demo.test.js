import test from 'node:test';
import assert from 'node:assert/strict';

import { ECONOMIC_FAMILIES, FAMILY_UNKNOWN } from '../shared/economicFamily.js';
import { FACT_KEYS, QUESTION_KINDS, TREATMENTS } from '../shared/factRequirements.js';
import {
  DECISION_STATUS, RECOGNITION_METHODS, decide, decisionAuthorizesPosting,
} from '../shared/accountingDecision.js';
import { SCHEDULE_ITEM_STATUS, buildMonthlySchedule } from '../shared/recognitionSchedule.js';

/**
 * سه سناریوی دمو — همان ایرادی که مدیر دفتر گرفت.
 *
 * یک پرداخت بیمه، سه حالت، سه نتیجهٔ متفاوت. اگر هر سه از یک سند دربیایند،
 * موتور هنوز «نوع تراکنش» را می‌بیند و نه «ماهیت رویداد».
 */

const TODAY = '2026-09-23T00:00:00.000Z';
const BASE = Object.freeze({
  [FACT_KEYS.AMOUNT]: 120_000_000,
  [FACT_KEYS.OCCURRED_AT]: TODAY,
  [FACT_KEYS.CASH_ACCOUNT]: 'bank-mellat',
  [FACT_KEYS.CATEGORY]: 'بیمه',
  [FACT_KEYS.COUNTERPARTY]: 'بیمه آسیا',
  moneyDirection: 'out',
});

test('سناریوی ۱ — دورهٔ پوشش مشخص است: دارایی ساخته می‌شود، نه هزینه', () => {
  const decision = decide({
    ...BASE,
    [FACT_KEYS.SERVICE_PERIOD_START]: '2026-09-23T00:00:00.000Z',
    [FACT_KEYS.SERVICE_PERIOD_END]: '2027-09-22T00:00:00.000Z',
  }, { today: TODAY });

  assert.equal(decision.family, ECONOMIC_FAMILIES.ASSET_CREATION);
  assert.equal(decision.treatment, TREATMENTS.PREPAID_EXPENSE);
  assert.equal(decision.decisionStatus, DECISION_STATUS.DECIDED);
  assert.equal(decision.recognitionMethod, RECOGNITION_METHODS.MONTHLY_STRAIGHT_LINE);
  assert.deepEqual([...decision.missingFacts], []);
  assert.ok(decision.policyVersion, 'تصمیم بدون نسخهٔ قاعده ساخته نمی‌شود');
  assert.ok(decisionAuthorizesPosting(decision));
});

test('سناریوی ۲ — دوره نامشخص است: سؤال پرسیده می‌شود، هیچ سندی ساخته نمی‌شود', () => {
  const decision = decide({ ...BASE }, { today: TODAY });

  assert.equal(decision.decisionStatus, DECISION_STATUS.NEEDS_USER_INPUT);
  assert.ok(decision.missingFacts.includes(FACT_KEYS.SERVICE_PERIOD_START), 'شروع دوره باید مفقود اعلام شود');
  assert.equal(decisionAuthorizesPosting(decision), false, 'تا جواب نیامده هیچ سندی مجاز نیست');

  assert.ok(decision.question, 'باید سؤالی ساخته شود');
  assert.equal(decision.question.fact, FACT_KEYS.SERVICE_PERIOD_START);
  assert.equal(decision.question.kind, QUESTION_KINDS.OPTIONS, 'جواب شمردنی است، پس گزینه دارد');
  assert.ok(decision.question.options.length >= 2);
});

test('سناریوی ۲ — با اطمینان کامل هم سؤال سر جایش می‌ماند', () => {
  // این همان شکاف سوم ممیزی خط مبناست: مبلغ و تاریخ و بانک قطعی‌اند، ولی
  // ماهیت مبهم است. اطمینان بالا نباید جای واقعیت مفقود را بگیرد.
  const decision = decide({ ...BASE, confidence: 1 }, { today: TODAY });
  assert.equal(decision.decisionStatus, DECISION_STATUS.NEEDS_USER_INPUT);
});

test('سناریوی ۳ — دوره کاملاً گذشته است: هزینهٔ مستقیم', () => {
  const decision = decide({
    ...BASE,
    [FACT_KEYS.SERVICE_PERIOD_START]: '2025-01-01T00:00:00.000Z',
    [FACT_KEYS.SERVICE_PERIOD_END]: '2025-12-31T00:00:00.000Z',
  }, { today: TODAY });

  assert.equal(decision.treatment, TREATMENTS.PERIOD_EXPENSE);
  assert.equal(decision.decisionStatus, DECISION_STATUS.DECIDED);
  assert.equal(decision.recognitionMethod, RECOGNITION_METHODS.IMMEDIATE);
  assert.ok(decisionAuthorizesPosting(decision));
});

test('جواب کاربر، سؤال را می‌بندد و تصمیم را قطعی می‌کند', () => {
  const asked = decide({ ...BASE }, { today: TODAY });
  assert.equal(asked.decisionStatus, DECISION_STATUS.NEEDS_USER_INPUT);

  const answered = decide({
    ...BASE,
    [FACT_KEYS.SERVICE_PERIOD_START]: '2026-09-23T00:00:00.000Z',
    [FACT_KEYS.SERVICE_PERIOD_END]: '2027-09-22T00:00:00.000Z',
  }, { today: TODAY });
  assert.equal(answered.decisionStatus, DECISION_STATUS.DECIDED);
});

test('تصمیم تابع خالص است: همان ورودی، همان خروجی', () => {
  // بدون این، replay بعد از تغییر نسخهٔ قاعده قابل اثبات نیست.
  const facts = { ...BASE, [FACT_KEYS.SERVICE_PERIOD_START]: TODAY, [FACT_KEYS.SERVICE_PERIOD_END]: '2027-09-22T00:00:00.000Z' };
  assert.deepEqual(decide(facts, { today: TODAY }), decide(facts, { today: TODAY }));
});

test('خانواده‌ای که قاعدهٔ ثبت ندارد، تصمیمش ثبت می‌شود ولی سند نمی‌سازد', () => {
  // یازده خانوادهٔ دیگر در این فاز همین وضع را دارند: ماهیت شناخته می‌شود و
  // ثبت می‌شود — همان دادهٔ خامی که ضبط شادو در فاز بعد لازم دارد — ولی
  // تصمیم حاکم نیست.
  const decision = decide({
    [FACT_KEYS.AMOUNT]: 5_000_000,
    [FACT_KEYS.OCCURRED_AT]: TODAY,
    [FACT_KEYS.CASH_ACCOUNT]: 'bank-mellat',
    [FACT_KEYS.DESTINATION_ACCOUNT]: 'cash',
    moneyDirection: 'none',
  }, { today: TODAY });

  assert.equal(decision.family, ECONOMIC_FAMILIES.INTERNAL_TRANSFER, 'ماهیت باید شناخته شود');
  assert.equal(decision.decisionStatus, DECISION_STATUS.UNSUPPORTED, 'قاعدهٔ ثبتش در این فاز ساخته نشده');
  assert.equal(decisionAuthorizesPosting(decision), false);
});

test('پرداخت ساده بدون نشانهٔ منفعت آینده، «ایجاد دارایی» برچسب نمی‌خورد', () => {
  // خرید چای دفتر و پیش‌پرداخت بیمه هر دو «پول خارج شد» هستند. اگر هر دو یک
  // خانواده بگیرند، همان اشتباه KIND_BY_TYPE یک پله بالاتر تکرار شده. تا وقتی
  // هدف خرید پرسیده نشده (فاز ۳)، «نمی‌دانم» صادقانه‌تر از یک برچسب مطمئن است.
  const decision = decide({
    moneyDirection: 'out',
    [FACT_KEYS.AMOUNT]: 2_000_000,
    [FACT_KEYS.OCCURRED_AT]: TODAY,
    [FACT_KEYS.CASH_ACCOUNT]: 'cash',
    [FACT_KEYS.CATEGORY]: 'پذیرایی',
  }, { today: TODAY });

  assert.notEqual(decision.family, ECONOMIC_FAMILIES.ASSET_CREATION);
  assert.equal(decisionAuthorizesPosting(decision), false);
});

test('همان پرداخت با نشانهٔ منفعت آینده، ایجاد دارایی است', () => {
  const decision = decide({
    moneyDirection: 'out',
    [FACT_KEYS.AMOUNT]: 2_000_000,
    [FACT_KEYS.OCCURRED_AT]: TODAY,
    [FACT_KEYS.CASH_ACCOUNT]: 'cash',
    [FACT_KEYS.CATEGORY]: 'پذیرایی',
    [FACT_KEYS.INTENDED_USE]: 'resale',
  }, { today: TODAY });

  assert.equal(decision.family, ECONOMIC_FAMILIES.ASSET_CREATION);
});

test('ودیعه، سؤال استرداد می‌گیرد — نه سؤال دورهٔ پوشش', () => {
  // «بیست میلیون ودیعهٔ دفتر رو دادم» و «اجارهٔ سه ماه را جلوجلو دادم» هر دو
  // دستهٔ اجاره‌اند و هر دو پول خارج‌شده. پرسیدن دوره از ودیعه، سؤال غلط از
  // رویداد درست است.
  const deposit = {
    moneyDirection: 'out',
    [FACT_KEYS.AMOUNT]: 20_000_000,
    [FACT_KEYS.OCCURRED_AT]: TODAY,
    [FACT_KEYS.CASH_ACCOUNT]: 'bank-mellat',
    [FACT_KEYS.CATEGORY]: 'اجاره',
    // گفتهٔ کاربر لازم است: سؤال استرداد فقط وقتی پرسیده می‌شود که نشانه‌اش
    // در جمله باشد، وگرنه هر اجارهٔ عادی هم بازجویی می‌شد.
    evidence: 'بیست میلیون ودیعه دفتر را پرداخت کردم',
  };
  const asked = decide(deposit, { today: TODAY });
  assert.equal(asked.decisionStatus, DECISION_STATUS.NEEDS_USER_INPUT);
  assert.equal(asked.question.fact, FACT_KEYS.REFUNDABLE, 'اول باید استرداد پرسیده شود');

  // پولی که برمی‌گردد هیچ‌وقت هزینه نمی‌شود — نه امسال، نه سال بعد.
  const refundable = decide({ ...deposit, [FACT_KEYS.REFUNDABLE]: true }, { today: TODAY });
  assert.equal(refundable.treatment, TREATMENTS.REFUNDABLE_DEPOSIT);
  assert.equal(refundable.decisionStatus, DECISION_STATUS.UNSUPPORTED, 'قاعدهٔ ثبتش در این فاز نیست، پس حسابدار');
  assert.equal(decisionAuthorizesPosting(refundable), false);

  // همان دسته، جواب دیگر: حالا دوره پرسیده می‌شود.
  const consumable = decide({ ...deposit, [FACT_KEYS.REFUNDABLE]: false }, { today: TODAY });
  assert.equal(consumable.treatment, TREATMENTS.PREPAID_EXPENSE);
  assert.equal(consumable.question.fact, FACT_KEYS.SERVICE_PERIOD_START);
});

test('بیمه سؤال استرداد نمی‌گیرد؛ ذاتاً مصرف‌شدنی است', () => {
  // سؤال اضافه هم هزینه دارد: کاربری که برای هر ثبت دو بار بازجویی شود،
  // سؤال‌ها را دور می‌زند و کل طرح بی‌اثر می‌شود.
  const decision = decide({ ...BASE }, { today: TODAY });
  assert.equal(decision.question.fact, FACT_KEYS.SERVICE_PERIOD_START);
});

test('ماهیت نامشخص به حسابدار می‌رود، نه به نزدیک‌ترین خانواده', () => {
  const decision = decide({ moneyDirection: 'out' }, { today: TODAY });
  assert.equal(decision.family, FAMILY_UNKNOWN);
  assert.equal(decisionAuthorizesPosting(decision), false);
  assert.ok(decision.explanation?.trim(), 'باید بگوید چرا نتوانست تصمیم بگیرد');
});

test('برنامهٔ شناسایی: جمع اقلام دقیقاً برابر مبلغ اصلی است', () => {
  // تقسیم ۱۰۰ بر ۳ یک تومان گم می‌کند. ته‌مانده به قلم آخر می‌چسبد تا
  // اعداد رُند بمانند و حسابدار بتواند با ماشین‌حساب تأییدشان کند.
  const schedule = buildMonthlySchedule({
    amount: 100_000_000,
    periodStart: '2026-09-23T00:00:00.000Z',
    periodEnd: '2027-09-22T00:00:00.000Z',
    sourceId: 'evt-1',
  });
  assert.equal(schedule.length, 12);
  assert.equal(schedule.reduce((sum, item) => sum + item.amount, 0), 100_000_000);
  assert.equal(schedule.every((item) => item.status === SCHEDULE_ITEM_STATUS.PLANNED), true);
});

test('برنامهٔ شناسایی: اجرای دوباره قلم دوم نمی‌سازد', () => {
  const input = {
    amount: 120_000_000,
    periodStart: '2026-09-23T00:00:00.000Z',
    periodEnd: '2027-09-22T00:00:00.000Z',
    sourceId: 'evt-2',
  };
  const first = buildMonthlySchedule(input);
  const second = buildMonthlySchedule(input);
  assert.deepEqual(first, second, 'اجرای مجدد باید همان برنامه را بدهد');
  assert.equal(new Set(first.map((item) => item.periodKey)).size, first.length, 'کلید دوره باید یکتا باشد');
});

test('برنامهٔ شناسایی: هر قلم کلید یکتای خودش را دارد', () => {
  const a = buildMonthlySchedule({ amount: 12_000_000, periodStart: '2026-09-23T00:00:00.000Z', periodEnd: '2027-09-22T00:00:00.000Z', sourceId: 'evt-a' });
  const b = buildMonthlySchedule({ amount: 12_000_000, periodStart: '2026-09-23T00:00:00.000Z', periodEnd: '2027-09-22T00:00:00.000Z', sourceId: 'evt-b' });
  assert.equal(a[0].key === b[0].key, false, 'دو منبع متفاوت نباید کلید یکسان بسازند');
});

/**
 * اجارهٔ یک ماه مشخص، سؤال استرداد نمی‌گیرد.
 *
 * در آزمون صوتی پیدا شد: «دوازده میلیون بابت اجاره اردیبهشت ماه دفتر» سؤال
 * «قابل استرداد است یا مصرف می‌شود؟» می‌گرفت. ودیعه سؤال لازم دارد، ولی
 * اجارهٔ یک ماهِ نام‌برده آشکارا مصرف‌شدنی است و پرسیدن از آن فقط اصطکاک است —
 * کاربری که برای هر اجاره بازجویی شود، سؤال‌ها را دور می‌زند.
 */
test('اجاره با دورهٔ نام‌برده، سؤال استرداد نمی‌گیرد', () => {
  const decision = decide({
    moneyDirection: 'out',
    [FACT_KEYS.AMOUNT]: 12_000_000,
    [FACT_KEYS.OCCURRED_AT]: TODAY,
    [FACT_KEYS.CASH_ACCOUNT]: 'bank-saman',
    [FACT_KEYS.CATEGORY]: 'اجاره',
    evidence: 'دوازده میلیون بابت اجاره اردیبهشت ماه دفتر مرکزی',
  }, { today: TODAY });

  assert.notEqual(decision.question?.fact, FACT_KEYS.REFUNDABLE, 'نباید استرداد بپرسد');
});

test('ولی ودیعه همچنان سؤال استرداد می‌گیرد', () => {
  const decision = decide({
    moneyDirection: 'out',
    [FACT_KEYS.AMOUNT]: 20_000_000,
    [FACT_KEYS.OCCURRED_AT]: TODAY,
    [FACT_KEYS.CASH_ACCOUNT]: 'bank-mellat',
    [FACT_KEYS.CATEGORY]: 'اجاره',
    evidence: 'بیست میلیون ودیعه دفتر را پرداخت کردم',
  }, { today: TODAY });

  assert.equal(decision.question.fact, FACT_KEYS.REFUNDABLE);
});
