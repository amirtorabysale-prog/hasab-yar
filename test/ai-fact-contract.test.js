import test from 'node:test';
import assert from 'node:assert/strict';

import { AI_FACT_SCHEMA, FORBIDDEN_FACT_FIELDS, MONEY_DIRECTIONS, validateExtraction } from '../shared/aiFactContract.js';

/**
 * قرارداد استخراج — مرز میان مدل زبانی و حسابداری.
 *
 * این تست‌ها یک ادعا را نگه می‌دارند: مدل واقعیت می‌گوید، موتور تصمیم می‌گیرد.
 * هر بار که این مرز جابه‌جا شود، یکی از این‌ها می‌شکند.
 */

test('schema هیچ فیلد حسابداری‌ای را مجاز نمی‌کند', () => {
  const allowed = Object.keys(AI_FACT_SCHEMA.properties).map((name) => name.toLowerCase());
  for (const forbidden of FORBIDDEN_FACT_FIELDS) {
    assert.equal(allowed.includes(forbidden), false, `فیلد ممنوع «${forbidden}» در schema مجاز شده است`);
  }
  assert.equal(AI_FACT_SCHEMA.additionalProperties, false, 'فیلد ناشناخته نباید پذیرفته شود');
});

test('«درآمد یا هزینه» از مدل پرسیده نمی‌شود؛ فقط جهت حرکت پول', () => {
  // این همان فیلدی است که جدول دوسطری KIND_BY_TYPE را تغذیه می‌کرد و
  // «هر پرداختی هزینه است» را قفل کرده بود.
  assert.equal('type' in AI_FACT_SCHEMA.properties, false, 'type نباید در قرارداد باشد');
  assert.ok(AI_FACT_SCHEMA.properties.moneyDirection, 'جهت حرکت پول باید پرسیده شود');
  assert.deepEqual([...AI_FACT_SCHEMA.properties.moneyDirection.enum].sort(), [...Object.values(MONEY_DIRECTIONS)].sort());
});

test('فقط جهت پول و شاهد اجباری‌اند تا «نمی‌دانم» قابل بیان بماند', () => {
  // مدلی که مجبور شود مبلغ بدهد، مبلغ می‌سازد.
  assert.deepEqual([...AI_FACT_SCHEMA.required].sort(), ['evidence', 'moneyDirection']);
});

test('خروجی سالم پذیرفته می‌شود و واقعیت‌هایش برمی‌گردد', () => {
  const result = validateExtraction({
    moneyDirection: 'out',
    amount: 120_000_000,
    counterparty: 'بیمه آسیا',
    evidence: 'حق بیمه یک‌ساله را از بانک ملت پرداخت کردم',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.equal(result.facts.amount, 120_000_000);
});

test('خروجی دارای حساب، رد و ثبت می‌شود — نه تمیز و ادامه', () => {
  const result = validateExtraction({
    moneyDirection: 'out',
    amount: 1_000_000,
    evidence: 'اجاره را دادم',
    accountCode: '8102',
  });
  assert.equal(result.ok, false, 'پاسخ دارای کد حساب باید رد شود');
  assert.ok(result.violations.includes('accountCode'), 'نام فیلد متخلف باید گزارش شود');
  assert.equal(result.facts, null, 'پاسخ رد شده نباید واقعیت برگرداند');
});

test('بدهکار و بستانکار هم همین‌طور', () => {
  for (const field of ['debit', 'credit', 'journalEntry', 'treatment', 'family']) {
    const result = validateExtraction({ moneyDirection: 'out', evidence: 'x', [field]: 'y' });
    assert.equal(result.ok, false, `فیلد «${field}» باید رد شود`);
  }
});

test('نام فیلد ممنوع، هر شکلی که نوشته شود، گرفته می‌شود', () => {
  for (const field of ['account_code', 'AccountCode', 'ACCOUNTNAME']) {
    const result = validateExtraction({ moneyDirection: 'out', evidence: 'x', [field]: 'y' });
    assert.equal(result.ok, false, `شکل «${field}» باید گرفته شود`);
  }
});

test('فیلد ناشناخته هم رد می‌شود', () => {
  const result = validateExtraction({ moneyDirection: 'in', evidence: 'x', somethingNew: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.violations.includes('somethingNew'));
});

test('نبودِ جهت پول یا شاهد، خطای قرارداد است', () => {
  assert.equal(validateExtraction({ evidence: 'x' }).ok, false);
  assert.equal(validateExtraction({ moneyDirection: 'in' }).ok, false);
});

test('confidence بالا به‌تنهایی چیزی را معتبر نمی‌کند', () => {
  const result = validateExtraction({ moneyDirection: 'out', evidence: 'x', confidence: 1, debit: 'نقد' });
  assert.equal(result.ok, false, 'اطمینان کامل نباید فیلد ممنوع را مجاز کند');
});
