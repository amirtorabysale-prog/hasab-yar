import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const corpus = JSON.parse(readFileSync(new URL('./fixtures/accounting-decision-golden-v1.json', import.meta.url), 'utf8'));
const STATUSES = new Set(['decided', 'needs-user-input', 'accountant-review', 'unsupported', 'blocked']);
const RISKS = new Set(['green', 'yellow', 'red']);

test('accounting golden corpus has unique and structurally valid cases', () => {
  assert.ok(corpus.length >= 36, 'نسخهٔ پایه باید دست‌کم ۳۶ سناریو داشته باشد');
  assert.equal(new Set(corpus.map((item) => item.id)).size, corpus.length, 'شناسهٔ سناریوها باید یکتا باشد');

  for (const item of corpus) {
    assert.match(item.id, /^[A-Z]{3,4}-\d{3}$/);
    assert.ok(item.family);
    assert.ok(item.input?.trim());
    assert.ok(RISKS.has(item.risk), `${item.id}: سطح ریسک نامعتبر`);
    assert.ok(STATUSES.has(item.expectedStatus), `${item.id}: وضعیت مورد انتظار نامعتبر`);
    assert.ok(Array.isArray(item.missingFacts), `${item.id}: missingFacts باید آرایه باشد`);
    assert.ok(item.expectedTreatment, `${item.id}: treatment لازم است`);

    if (item.expectedStatus === 'needs-user-input') {
      assert.ok(item.missingFacts.length > 0, `${item.id}: مسیر پرسش باید واقعیت مفقود داشته باشد`);
    }
    if (item.expectedStatus === 'decided') {
      assert.ok(item.posting?.debitRole && item.posting?.creditRole, `${item.id}: تصمیم قطعی باید posting مورد انتظار داشته باشد`);
    }
  }
});

test('golden corpus covers every release-one accounting family', () => {
  const families = new Set(corpus.map((item) => item.family));
  const required = [
    'prepayment', 'accrual', 'deferred-revenue', 'inventory', 'fixed-asset',
    'settlement', 'advance-deposit', 'loan', 'equity', 'internal-transfer',
    'tax-vat', 'payroll',
  ];
  for (const family of required) assert.ok(families.has(family), `خانوادهٔ ${family} پوشش داده نشده است`);
});

test('red-risk cases are never marked as directly decided in the foundation corpus', () => {
  for (const item of corpus.filter((candidate) => candidate.risk === 'red')) {
    assert.notEqual(item.expectedStatus, 'decided', `${item.id}: سناریوی قرمز نباید آمادهٔ ثبت خودکار باشد`);
  }
});

test('prepayment cases prove that payment does not imply immediate expense', () => {
  const prepayments = corpus.filter((item) => item.family === 'prepayment');
  assert.ok(prepayments.some((item) => item.expectedTreatment === 'prepaid-expense'));
  assert.ok(prepayments.some((item) => item.missingFacts.includes('servicePeriodStart')));
  assert.ok(prepayments.some((item) => item.expectedTreatment === 'period-expense'));
});
