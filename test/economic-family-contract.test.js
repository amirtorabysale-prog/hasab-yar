import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ECONOMIC_FAMILIES, FAMILY_DEFAULT_RISK, FAMILY_EXAMPLES, FAMILY_LABELS, FAMILY_RULES,
  FAMILY_UNKNOWN, RISK_LEVELS, TIME_BOUND_SERVICE_CATEGORIES,
  classifyFamily, isEconomicFamily, listEconomicFamilies,
} from '../shared/economicFamily.js';
import {
  FACT_KEYS, FACT_LABELS, FACT_QUESTIONS, FACT_REQUIREMENTS, QUESTION_KINDS,
  TREATMENTS, TREATMENT_EXTRA_REQUIREMENTS, isFactKey, missingFactsFor, nextQuestionFor, requiredFactsFor,
} from '../shared/factRequirements.js';

/**
 * قرارداد خانواده‌ها — این تست‌ها ادعای مرکزی فاز صفر را نگه می‌دارند:
 * موتور هر ۱۲ خانواده را می‌شناسد و برای هر کدام می‌داند چه چیزی لازم دارد،
 * حتی وقتی هنوز قاعدهٔ ثبتش را ندارد.
 */

test('هر دوازده خانوادهٔ اقتصادی اعلام شده‌اند', () => {
  const families = listEconomicFamilies();
  assert.equal(families.length, 12, 'تعداد خانواده‌ها باید دقیقاً دوازده باشد');
  assert.equal(new Set(families).size, 12, 'شناسهٔ خانواده‌ها باید یکتا باشد');
  for (const family of families) assert.ok(isEconomicFamily(family));
});

test('«نامشخص» خانوادهٔ عادی شمرده نمی‌شود ولی برچسب و ریسک دارد', () => {
  assert.equal(isEconomicFamily(FAMILY_UNKNOWN), false, 'نامشخص نباید در فهرست خانواده‌های عادی باشد');
  assert.ok(FAMILY_LABELS[FAMILY_UNKNOWN], 'نامشخص باید برچسب فارسی داشته باشد');
  assert.equal(FAMILY_DEFAULT_RISK[FAMILY_UNKNOWN], RISK_LEVELS.RED, 'ماهیت نامشخص همیشه قرمز است');
});

test('هر خانواده برچسب، نمونه، ریسک و فهرست واقعیت دارد', () => {
  for (const family of listEconomicFamilies()) {
    assert.ok(FAMILY_LABELS[family]?.trim(), `${family}: برچسب فارسی ندارد`);
    assert.ok(FAMILY_EXAMPLES[family]?.length, `${family}: نمونه ندارد`);
    assert.ok(Object.values(RISK_LEVELS).includes(FAMILY_DEFAULT_RISK[family]), `${family}: ریسک پیش‌فرض ندارد`);

    const requirement = FACT_REQUIREMENTS[family];
    assert.ok(requirement, `${family}: فهرست واقعیت‌های لازم ندارد`);
    assert.ok(requirement.required.length > 0, `${family}: باید دست‌کم یک واقعیت لازم داشته باشد`);
    for (const fact of [...requirement.required, ...requirement.optional]) {
      assert.ok(isFactKey(fact), `${family}: واقعیت ناشناخته «${fact}»`);
    }
  }
});

test('هر واقعیت برچسب فارسی و سؤال دارد', () => {
  for (const fact of Object.values(FACT_KEYS)) {
    assert.ok(FACT_LABELS[fact]?.trim(), `${fact}: برچسب فارسی ندارد`);
    const question = FACT_QUESTIONS[fact];
    assert.ok(question?.text?.trim(), `${fact}: سؤالی برایش تعریف نشده`);
    assert.ok(Object.values(QUESTION_KINDS).includes(question.kind), `${fact}: نوع سؤال نامعتبر`);
    if (question.kind === QUESTION_KINDS.OPTIONS) {
      assert.ok(question.options?.length >= 2, `${fact}: سؤال گزینه‌ای باید دست‌کم دو گزینه داشته باشد`);
      for (const option of question.options) assert.ok(option.label?.trim(), `${fact}: گزینهٔ بی‌برچسب`);
    }
  }
});

test('واقعیت اضافهٔ هر برخورد از واژگان شناخته‌شده است', () => {
  for (const [treatment, facts] of Object.entries(TREATMENT_EXTRA_REQUIREMENTS)) {
    assert.ok(Object.values(TREATMENTS).includes(treatment), `برخورد ناشناخته «${treatment}»`);
    for (const fact of facts) assert.ok(isFactKey(fact), `${treatment}: واقعیت ناشناخته «${fact}»`);
  }
});

test('پیش‌پرداخت بدون دورهٔ پوشش قابل ثبت نیست', () => {
  const extra = TREATMENT_EXTRA_REQUIREMENTS[TREATMENTS.PREPAID_EXPENSE];
  assert.ok(extra.includes(FACT_KEYS.SERVICE_PERIOD_START), 'شروع دوره باید لازم باشد');
  assert.ok(extra.includes(FACT_KEYS.SERVICE_PERIOD_END), 'پایان دوره باید لازم باشد');
});

test('قاعده به دسته‌ای اشاره نمی‌کند که وجود ندارد', async () => {
  // قاعده‌ای که روی نام دسته‌ای تطبیق می‌دهد که خط تولید هیچ‌وقت نمی‌سازد،
  // بی‌صدا مرده است: نه خطا می‌دهد، نه هیچ‌وقت شلیک می‌کند. سه نام از فهرست
  // اولیه («اشتراک»، «پشتیبانی»، «حق عضویت») دقیقاً همین‌طور بودند.
  const { CATEGORY_DEFINITIONS } = await import('../shared/categoryRules.js');
  const names = new Set(CATEGORY_DEFINITIONS.map((item) => item.name));
  for (const category of TIME_BOUND_SERVICE_CATEGORIES) {
    assert.ok(names.has(category), `دستهٔ «${category}» در قواعد دسته‌بندی وجود ندارد`);
  }
});

test('افزودن خانوادهٔ تازه نباید هستهٔ طبقه‌بند را عوض کند', () => {
  // قاعده‌ها داده‌اند، نه شاخه‌های یک `switch`. اگر روزی این تست بشکند یعنی
  // کسی تشخیص را داخل خود تابع برده و خانوادهٔ سیزدهم دیگر یک ردیف نیست.
  assert.ok(Array.isArray(FAMILY_RULES), 'قاعده‌های تشخیص باید یک آرایه باشند');
});

test('طبقه‌بند هر دوازده خانواده را تشخیص می‌دهد', () => {
  for (const family of listEconomicFamilies()) {
    assert.ok(FAMILY_RULES.some((rule) => rule.family === family), `${family}: هیچ قاعدهٔ تشخیصی ندارد`);
  }
});

test('طبقه‌بند وقتی نمی‌داند، «نامشخص» می‌دهد و استثنا پرتاب نمی‌کند', () => {
  const result = classifyFamily({});
  assert.equal(result.family, FAMILY_UNKNOWN);
  assert.ok(result.reason?.trim(), 'دلیل نامشخص بودن باید نوشته شود');
});

test('انتقال بین دو حساب خودِ واحد، انتقال داخلی است — نه هزینه', () => {
  const result = classifyFamily({
    [FACT_KEYS.AMOUNT]: 5_000_000,
    [FACT_KEYS.OCCURRED_AT]: '2026-09-23T00:00:00.000Z',
    [FACT_KEYS.CASH_ACCOUNT]: 'bank-mellat',
    [FACT_KEYS.DESTINATION_ACCOUNT]: 'bank-saderat',
  });
  assert.equal(result.family, ECONOMIC_FAMILIES.INTERNAL_TRANSFER);
});

test('واقعیت لازم خانواده و برخورد با هم جمع می‌شوند', () => {
  const facts = requiredFactsFor(ECONOMIC_FAMILIES.ASSET_CREATION, TREATMENTS.PREPAID_EXPENSE);
  assert.ok(facts.includes(FACT_KEYS.AMOUNT), 'واقعیت پایهٔ خانواده باید بماند');
  assert.ok(facts.includes(FACT_KEYS.SERVICE_PERIOD_START), 'واقعیت اضافهٔ برخورد باید اضافه شود');
  assert.equal(new Set(facts).size, facts.length, 'واقعیت تکراری نباید برگردد');
});

test('«نه» یک جواب است، نه نبودِ جواب', () => {
  // اگر `false` مفقود شمرده شود، سیستم برای هر «قابل استرداد نیست» دوباره
  // همان سؤال را می‌پرسد و کاربر حلقه می‌خورد.
  const missing = missingFactsFor(ECONOMIC_FAMILIES.OWNER_CAPITAL_MOVEMENT, null, {
    [FACT_KEYS.AMOUNT]: 1_000_000,
    [FACT_KEYS.OCCURRED_AT]: '2026-09-23T00:00:00.000Z',
    [FACT_KEYS.CASH_ACCOUNT]: 'bank-mellat',
    [FACT_KEYS.REFUNDABLE]: false,
  });
  assert.deepEqual(missing, [], 'هیچ واقعیتی نباید مفقود شمرده شود');
});

test('صفر هم یک جواب است', () => {
  const missing = missingFactsFor(ECONOMIC_FAMILIES.INTERNAL_TRANSFER, null, {
    [FACT_KEYS.AMOUNT]: 0,
    [FACT_KEYS.OCCURRED_AT]: '2026-09-23T00:00:00.000Z',
    [FACT_KEYS.CASH_ACCOUNT]: 'bank-mellat',
    [FACT_KEYS.DESTINATION_ACCOUNT]: 'cash',
  });
  assert.equal(missing.includes(FACT_KEYS.AMOUNT), false, 'صفر نبودِ مقدار نیست');
});

test('هر بار فقط یک سؤال پرسیده می‌شود', () => {
  const question = nextQuestionFor([FACT_KEYS.SERVICE_PERIOD_START, FACT_KEYS.SERVICE_PERIOD_END]);
  assert.equal(question.fact, FACT_KEYS.SERVICE_PERIOD_START, 'اولین کمبود باید پرسیده شود');
  assert.equal(question.kind, QUESTION_KINDS.OPTIONS);
  assert.ok(question.options.some((option) => option.value === 'already-passed'), 'گزینهٔ دورهٔ گذشته باید باشد');
});

test('وقتی چیزی کم نیست، سؤالی هم نیست', () => {
  assert.equal(nextQuestionFor([]), null);
});
