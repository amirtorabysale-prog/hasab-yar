import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverySteps, isSetupCheck, splitReadinessChecks } from '../src/lib/deliveryFlow.js';

const check = (id, passed, label = id, severity = 'blocking') => ({ id, passed, label, severity });

// کنترل‌های تنظیم یک‌باره از کنترل‌های دادهٔ ماهانه جدا هستند؛ قاطی‌شدنشان
// همان چیزی بود که کاربر نمی‌فهمید باید تنظیم را درست کند یا سند را.
test('کنترل تنظیم از کنترل دادهٔ ماه جدا می‌شود', () => {
  assert.equal(isSetupCheck(check('parsian-template', false)), true);
  assert.equal(isSetupCheck(check('mappings', false)), true);
  assert.equal(isSetupCheck(check('approval', false)), false);
  assert.equal(isSetupCheck(check('balanced', false)), false);
  assert.equal(isSetupCheck(undefined), false);

  const split = splitReadinessChecks({
    checks: [check('parsian-template', false), check('mappings', true), check('approval', false), check('rows', true)],
  });
  assert.deepEqual(split.setup.map((item) => item.id), ['parsian-template', 'mappings']);
  assert.deepEqual(split.month.map((item) => item.id), ['approval', 'rows']);
  assert.deepEqual(split.setupBlocking.map((item) => item.id), ['parsian-template']);
  assert.deepEqual(split.monthBlocking.map((item) => item.id), ['approval']);
});

test('کنترل توصیه‌ای گام را قرمز نمی‌کند', () => {
  const split = splitReadinessChecks({ checks: [check('mappings', false, 'نگاشت', 'advisory')] });
  assert.equal(split.setupBlocking.length, 0);
});

test('چهار گام به ترتیب واقعی کار برمی‌گردند', () => {
  const steps = deliverySteps({ checks: [], ready: false }, 'پارسیان');
  assert.deepEqual(steps.map((item) => item.id), ['target', 'setup', 'month', 'deliver']);
});

test('وقتی همه چیز آماده است، هیچ گامی مانع ندارد', () => {
  const steps = deliverySteps({
    ready: true,
    checks: [check('parsian-template', true), check('mappings', true), check('approval', true), check('rows', true)],
  }, 'پارسیان');
  assert.equal(steps.every((item) => item.blocking === 0), true);
  assert.equal(steps[0].done, true);
  assert.equal(steps[1].done, true);
  assert.equal(steps[2].done, true);
  assert.equal(steps[3].hint, 'می‌توانی بسته را بسازی');
});

test('نقص تنظیم فقط گام تنظیم را قرمز می‌کند، نه گام دادهٔ ماه', () => {
  const steps = deliverySteps({
    ready: false,
    checks: [check('parsian-template', false, 'قالب مقصد کنترل شود'), check('mappings', false, 'کد مقصد حساب‌ها'), check('approval', true), check('rows', true)],
  }, 'پارسیان');
  const [, setup, month, deliver] = steps;
  assert.equal(setup.blocking, 2);
  assert.equal(setup.done, false);
  assert.equal(setup.hint, 'قالب مقصد کنترل شود', 'اولین مانع باید مستقیم نشان داده شود');
  assert.equal(month.blocking, 0);
  assert.equal(month.done, true);
  assert.equal(deliver.blocking, 1, 'تا رفع موانع، ساخت بسته قفل می‌ماند');
});

test('نقص دادهٔ ماه، گام تنظیم را متهم نمی‌کند', () => {
  const steps = deliverySteps({
    ready: false,
    checks: [check('parsian-template', true), check('mappings', true), check('approval', false, 'سند کنترل‌نشده مانده')],
  }, 'پارسیان');
  const [, setup, month] = steps;
  assert.equal(setup.blocking, 0);
  assert.equal(setup.done, true);
  assert.equal(month.blocking, 1);
  assert.equal(month.hint, 'سند کنترل‌نشده مانده');
});

test('بدون انتخاب مقصد، گام اول ناتمام است', () => {
  const steps = deliverySteps({ checks: [] }, '');
  assert.equal(steps[0].done, false);
  assert.equal(steps[0].hint, 'انتخاب نشده');
});

test('readiness خالی هیچ گامی را به‌دروغ سبز نمی‌کند', () => {
  const steps = deliverySteps({}, 'پارسیان');
  assert.equal(steps[1].done, false, 'وقتی هنوز کنترلی نیامده، تنظیم نباید سبز شود');
  assert.equal(steps[2].done, false);
});
