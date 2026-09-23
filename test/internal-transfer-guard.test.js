import test from 'node:test';
import assert from 'node:assert/strict';

import { detectTransferBanks } from '../shared/banks.js';
import { parseFinancialText } from '../shared/parser.js';
import { normalizeFinancialEvent } from '../shared/financialEvent.js';
import { factsFromEvent } from '../shared/eventFacts.js';
import { decide } from '../shared/accountingDecision.js';
import { ECONOMIC_FAMILIES } from '../shared/economicFamily.js';
import { GUARD_VERDICTS, runGuards } from '../shared/guards.js';
import { ROLES, planJournal } from '../shared/accountingRules.js';

/**
 * انتقال داخلی — پرهزینه‌ترین خطای این مرحله.
 *
 * جابه‌جایی پول بین دو جیب خودِ کسب‌وکار هیچ‌وقت هزینه یا درآمد نیست. برخلاف
 * پیش‌پرداخت که بالاخره هزینه می‌شود و فقط زمانش غلط است، این خطا هیچ‌وقت
 * خودش را اصلاح نمی‌کند: یک زیان جعلی می‌سازد که تا ابد در دفتر می‌ماند.
 *
 * تست‌های منفی پیش از پیاده‌سازی نوشته شده‌اند، چون معیار این نگهبان «چه چیزی
 * می‌سازد» نیست، «چه چیزی هرگز نمی‌سازد» است.
 */

const TODAY = '2026-09-23T00:00:00.000Z';

test('دو بانک در یک جمله، مبدأ و مقصد را می‌دهد', () => {
  const pair = detectTransferBanks('از ملت به پاسارگاد 50 میلیون منتقل کردم');
  assert.ok(pair, 'جفت باید تشخیص داده شود');
  assert.equal(pair.from.kind, 'bank');
  assert.equal(pair.to.kind, 'bank');
  assert.notEqual(pair.from.id, pair.to.id);
});

test('بانک به صندوق هم انتقال داخلی است', () => {
  const pair = detectTransferBanks('50 میلیون از بانک ملت به صندوق آوردم');
  assert.ok(pair, 'صندوق هم یک حساب خودِ واحد است');
  assert.equal(pair.to.kind, 'cash');
});

test('یک بانک تنها، انتقال نیست', () => {
  assert.equal(detectTransferBanks('از بانک ملت 5 میلیون اجاره دادم'), null);
});

test('جملهٔ بدون نشانهٔ جابه‌جایی، انتقال نیست', () => {
  // «به» و «از» به‌تنهایی کافی نیستند؛ باید فعل جابه‌جایی باشد، وگرنه
  // «از بانک ملت به شرکت بهار پرداخت کردم» انتقال داخلی خوانده می‌شد.
  assert.equal(detectTransferBanks('از بانک ملت به بانک بهار پول دادم بابت خرید'), null);
});

test('پارسر انتقال را از جمله بیرون می‌کشد', () => {
  const [item] = parseFinancialText('از ملت به پاسارگاد 50 میلیون منتقل کردم').transactions;
  assert.ok(item.transfer, 'تراکنش باید نشانهٔ انتقال داشته باشد');
  assert.ok(item.transfer.fromId && item.transfer.toId);
  assert.notEqual(item.transfer.fromId, item.transfer.toId);
});

test('انتقال داخلی، خانوادهٔ درست را می‌گیرد', () => {
  const event = normalizeFinancialEvent({
    kind: 'cash-expense', amount: 50_000_000, occurredAt: TODAY,
    accountId: 'bank-mellat', destinationAccountId: 'bank-pasargad',
  });
  assert.equal(event.destinationAccountId, 'bank-pasargad', 'رویداد باید مقصد را نگه دارد');
  assert.equal(decide(factsFromEvent(event), { today: TODAY }).family, ECONOMIC_FAMILIES.INTERNAL_TRANSFER);
});

// ---------------------------------------------------------------------------
// تست‌های منفی — آنچه هرگز نباید ساخته شود
// ---------------------------------------------------------------------------

const transferEvent = () => normalizeFinancialEvent({
  kind: 'cash-expense', amount: 50_000_000, occurredAt: TODAY,
  category: 'سایر هزینه‌ها', accountId: 'bank-mellat', destinationAccountId: 'bank-pasargad',
});

test('اصل انتقال هرگز به سود و زیان نمی‌خورد', () => {
  const event = transferEvent();
  const decision = decide(factsFromEvent(event), { today: TODAY });
  const result = runGuards(event, factsFromEvent(event), { decision });

  assert.notEqual(result.verdict, GUARD_VERDICTS.PASS, 'نقشهٔ هزینه‌ای نباید بی‌چون‌وچرا عبور کند');
  const plan = result.plan || planJournal(event, decision);
  const roles = plan.lines.map((line) => line.role);
  assert.equal(roles.includes(ROLES.EXPENSE_CATEGORY), false, 'هیچ سطری نباید هزینه باشد');
  assert.equal(roles.includes(ROLES.INCOME_CATEGORY), false, 'هیچ سطری نباید درآمد باشد');
});

test('نگهبان انتقال، ماهیت را تصحیح می‌کند نه اینکه رد کند', () => {
  // رد کردن یعنی رویدادِ درست به صف حسابدار برود. سیستم جوابش را می‌داند.
  const event = transferEvent();
  const decision = decide(factsFromEvent(event), { today: TODAY });
  const result = runGuards(event, factsFromEvent(event), { decision });
  assert.equal(result.verdict, GUARD_VERDICTS.REWRITE);
  assert.ok(result.reason?.trim(), 'تصحیح باید دلیل خوانا داشته باشد');
});

test('نگهبان همیشه ثبت می‌کند که اجرا شده', () => {
  // «اجرا شد و چیزی نیافت» با «اجرا نشد» یکی نیست.
  const event = normalizeFinancialEvent({ kind: 'cash-expense', amount: 1_000_000, occurredAt: TODAY, category: 'اجاره', accountId: 'cash' });
  const result = runGuards(event, factsFromEvent(event), { decision: decide(factsFromEvent(event), { today: TODAY }) });
  const transfer = result.checks.find((check) => check.name === 'internal-transfer');
  assert.ok(transfer, 'نگهبان انتقال باید در فهرست بررسی‌ها باشد');
  assert.equal(transfer.checked, true);
  assert.equal(transfer.verdict, GUARD_VERDICTS.PASS);
});

test('مبدأ و مقصد یکسان، انتقال نیست', () => {
  const event = normalizeFinancialEvent({
    kind: 'cash-expense', amount: 1_000_000, occurredAt: TODAY, accountId: 'cash', destinationAccountId: 'cash',
  });
  assert.equal(event.destinationAccountId, null, 'مقصدِ برابر مبدأ باید حذف شود');
});
