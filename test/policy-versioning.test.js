import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DECISION_STATUS, DEFAULT_POLICIES, decide, selectPolicy, simulatePolicyChange,
} from '../shared/accountingDecision.js';
import { ECONOMIC_FAMILIES, RISK_LEVELS } from '../shared/economicFamily.js';
import { TREATMENTS } from '../shared/factRequirements.js';

/**
 * موتور قواعد نسخه‌دار.
 *
 * سه قاعدهٔ غیرقابل‌مذاکره:
 *
 * ۱. انتخاب قاعده بر اساس **تاریخ رویداد** است، نه تاریخ اجرای کد. رویدادی که
 *    برای اسفند پارسال ثبت می‌شود باید قاعدهٔ اسفند پارسال را بگیرد.
 * ۲. نسخهٔ قاعده روی تصمیم ذخیره می‌شود.
 * ۳. بالا بردن نسخه نباید خروجی تاریخی را عوض کند.
 *
 * سومی مهم‌ترین است: بدون آن، هر اصلاح قاعده بی‌صدا گذشته را بازنویسی می‌کند و
 * حسابرسی غیرممکن می‌شود.
 */

const EVENT_2025 = '2025-06-15T00:00:00.000Z';
const EVENT_2026 = '2026-09-24T00:00:00.000Z';

const facts = (occurredAt) => ({
  moneyDirection: 'out',
  amount: 12_000_000,
  occurredAt,
  cashAccountId: 'bank-mellat',
  category: 'بیمه',
  servicePeriodStart: occurredAt,
  servicePeriodEnd: '2030-01-01T00:00:00.000Z',
});

const policy = (version, extra = {}) => ({
  policyKey: 'prepaid-service',
  version,
  family: ECONOMIC_FAMILIES.ASSET_CREATION,
  riskLevel: RISK_LEVELS.YELLOW,
  supportedTreatments: [TREATMENTS.PREPAID_EXPENSE],
  appliesTo() { return true; },
  resolve() { return { treatment: TREATMENTS.PREPAID_EXPENSE, recognitionMethod: 'monthly-straight-line' }; },
  ...extra,
});

// ---------------------------------------------------------------------------
// انتخاب بر اساس تاریخ رویداد
// ---------------------------------------------------------------------------

test('قاعده‌ای که هنوز اثر ندارد، انتخاب نمی‌شود', () => {
  const future = policy('2.0.0', { effectiveFrom: '2026-01-01T00:00:00.000Z' });
  assert.equal(selectPolicy([future], ECONOMIC_FAMILIES.ASSET_CREATION, facts(EVENT_2025), EVENT_2025), null);
});

test('قاعده‌ای که اثرش تمام شده، انتخاب نمی‌شود', () => {
  const expired = policy('1.0.0', { effectiveTo: '2025-01-01T00:00:00.000Z' });
  assert.equal(selectPolicy([expired], ECONOMIC_FAMILIES.ASSET_CREATION, facts(EVENT_2026), EVENT_2026), null);
});

test('قاعدهٔ بدون تاریخ، همیشه اثر دارد', () => {
  // سازگاری با قاعده‌های موجود که تاریخ ندارند.
  const timeless = policy('1.0.0');
  assert.ok(selectPolicy([timeless], ECONOMIC_FAMILIES.ASSET_CREATION, facts(EVENT_2025), EVENT_2025));
});

test('از میان چند نسخهٔ معتبر، تازه‌ترین انتخاب می‌شود', () => {
  const old = policy('1.0.0', { effectiveFrom: '2024-01-01T00:00:00.000Z' });
  const fresh = policy('2.0.0', { effectiveFrom: '2026-01-01T00:00:00.000Z' });
  const chosen = selectPolicy([old, fresh], ECONOMIC_FAMILIES.ASSET_CREATION, facts(EVENT_2026), EVENT_2026);
  assert.equal(chosen.version, '2.0.0');
});

test('رویداد قدیمی، قاعدهٔ قدیمی را می‌گیرد — حتی وقتی نسخهٔ تازه موجود است', () => {
  // این قلب کل موضوع است: تاریخ رویداد، نه تاریخ اجرای کد.
  const old = policy('1.0.0', { effectiveFrom: '2024-01-01T00:00:00.000Z' });
  const fresh = policy('2.0.0', { effectiveFrom: '2026-01-01T00:00:00.000Z' });
  const chosen = selectPolicy([old, fresh], ECONOMIC_FAMILIES.ASSET_CREATION, facts(EVENT_2025), EVENT_2025);
  assert.equal(chosen.version, '1.0.0');
});

// ---------------------------------------------------------------------------
// تصمیم، نسخه را حمل می‌کند
// ---------------------------------------------------------------------------

test('تصمیم نسخه‌ای را ذخیره می‌کند که واقعاً استفاده شده', () => {
  const policies = [
    policy('1.0.0', { effectiveFrom: '2024-01-01T00:00:00.000Z' }),
    policy('2.0.0', { effectiveFrom: '2026-01-01T00:00:00.000Z' }),
  ];
  assert.equal(decide(facts(EVENT_2025), { policies, today: EVENT_2026 }).policyVersion, '1.0.0');
  assert.equal(decide(facts(EVENT_2026), { policies, today: EVENT_2026 }).policyVersion, '2.0.0');
});

test('تاریخ رویداد ملاک است، نه today', () => {
  // اگر انتخاب قاعده به `today` تکیه کند، ثبت گذشته‌نگر قاعدهٔ امروز را
  // می‌گیرد و سند با چیزی متفاوت از آنچه آن روز درست بود ساخته می‌شود.
  const policies = [
    policy('1.0.0', { effectiveFrom: '2024-01-01T00:00:00.000Z' }),
    policy('2.0.0', { effectiveFrom: '2026-01-01T00:00:00.000Z' }),
  ];
  const decision = decide(facts(EVENT_2025), { policies, today: '2027-01-01T00:00:00.000Z' });
  assert.equal(decision.policyVersion, '1.0.0');
});

// ---------------------------------------------------------------------------
// replay — بالا بردن نسخه گذشته را عوض نمی‌کند
// ---------------------------------------------------------------------------

test('افزودن نسخهٔ تازه، تصمیم رویدادهای قدیمی را بیت‌به‌بیت دست‌نخورده می‌گذارد', () => {
  const before = [policy('1.0.0', { effectiveFrom: '2024-01-01T00:00:00.000Z' })];
  const after = [...before, policy('2.0.0', {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    resolve() { return { treatment: TREATMENTS.PERIOD_EXPENSE, recognitionMethod: 'immediate' }; },
    supportedTreatments: [TREATMENTS.PERIOD_EXPENSE],
  })];

  const historical = facts(EVENT_2025);
  assert.deepEqual(
    decide(historical, { policies: before, today: EVENT_2026 }),
    decide(historical, { policies: after, today: EVENT_2026 }),
    'تصمیم رویداد قدیمی نباید با افزودن نسخهٔ تازه عوض شود',
  );
});

test('شبیه‌سازی، اثر تغییر قاعده را پیش از فعال‌سازی نشان می‌دهد', () => {
  const before = [policy('1.0.0', { effectiveFrom: '2024-01-01T00:00:00.000Z' })];
  const after = [...before, policy('2.0.0', {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    resolve() { return { treatment: TREATMENTS.PERIOD_EXPENSE, recognitionMethod: 'immediate' }; },
    supportedTreatments: [TREATMENTS.PERIOD_EXPENSE],
  })];

  const report = simulatePolicyChange([facts(EVENT_2025), facts(EVENT_2026)], before, after, { today: EVENT_2026 });
  assert.equal(report.total, 2);
  assert.equal(report.unchanged, 1, 'رویداد قدیمی نباید عوض شود');
  assert.equal(report.changed.length, 1, 'فقط رویداد تازه عوض می‌شود');
  assert.equal(report.changed[0].after.treatment, TREATMENTS.PERIOD_EXPENSE);
});

// ---------------------------------------------------------------------------
// قاعده‌های واقعیِ امروز
// ---------------------------------------------------------------------------

test('همهٔ قاعده‌های پیش‌فرض نسخه دارند', () => {
  for (const item of DEFAULT_POLICIES) {
    assert.ok(item.policyKey, 'قاعده بدون کلید');
    assert.match(item.version, /^\d+\.\d+\.\d+$/, `${item.policyKey}: نسخهٔ نامعتبر`);
  }
});

test('کلید و نسخه با هم یکتا هستند', () => {
  const keys = DEFAULT_POLICIES.map((item) => `${item.policyKey}@${item.version}`);
  assert.equal(new Set(keys).size, keys.length, 'دو قاعده با کلید و نسخهٔ یکسان');
});

test('قاعده‌های امروز همچنان کار می‌کنند', () => {
  const decision = decide(facts(EVENT_2026), { today: EVENT_2026 });
  assert.equal(decision.decisionStatus, DECISION_STATUS.DECIDED);
  assert.ok(decision.policyVersion);
});
