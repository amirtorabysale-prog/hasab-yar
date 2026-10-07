import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { describePlan, runVoice } from './helpers/voicePipeline.js';
import { ROLES } from '../shared/accountingRules.js';

/**
 * آزمون استرس — ۴۰ سناریوی در دامنهٔ فاز ۰ تا ۲.
 *
 * متن سناریوها عین برگهٔ «تست کور» فایل `docs/testing/stress-test-scenarios.xlsx`
 * است و از همان راهی رد می‌شود که برنامه می‌رود (`test/helpers/voicePipeline.js`).
 *
 * معیار، سه حالت است و حالت چهارمی نیست:
 *
 *   ثبت       فقط وقتی مجاز است که سندش درست باشد
 *   سؤال      فقط سؤالی که واقعاً به ابهام همان سناریو مربوط است
 *   حسابدار   به صف حسابدار، جایی که صاحب کسب‌وکار نمی‌تواند تأییدش کند
 *
 * «ثبت اشتباه با اطمینان» آستانه‌اش صفر است — هم در این ۴۰ و هم در کل ۱۲۰.
 */

const all = JSON.parse(readFileSync(new URL('./fixtures/stress-scenarios-v1.json', import.meta.url), 'utf8'));
const scenario = (id) => all.find((item) => item.id === id);

const { CASH, EXPENSE_CATEGORY, PAYABLE, PREPAID_ASSET, SUPPLIER_ADVANCE } = ROLES;
const lines = (plan) => (plan?.lines || []).map((line) => `${line.debit ? 'Dr' : 'Cr'} ${line.role}`).sort();
const post = (roles, amount) => ({ outcome: 'post', roles: [...roles].sort(), amount });
const ask = (...facts) => ({ outcome: 'ask', facts });
const ACCOUNTANT = { outcome: 'accountant' };
const NONE = { outcome: 'none' };

/**
 * رفتار مجاز هر سناریو. هر ردیفی که موتور می‌سازد باید با **یکی** از این‌ها
 * بخواند؛ «none» یعنی جمله هیچ ردیفی نساخت (مثلاً مبلغی گفته نشده).
 *
 * `direction` وقتی آمده که جهت پول در ردیفِ صف هم مهم است: ردیف تراکنش حتی
 * وقتی سندش به حسابدار رفته ماندهٔ بانک را جابه‌جا می‌کند.
 */
const EXPECTED = {
  // ---- پیش‌پرداخت و دوره
  T001: { allow: [post([`Dr ${EXPENSE_CATEGORY}`, `Cr ${CASH}`], 12_000_000), ask('servicePeriodStart')] },
  T002: { allow: [post([`Dr ${PREPAID_ASSET}`, `Cr ${CASH}`], 50_000_000), ACCOUNTANT] },
  T004: { allow: [ask('amountScale'), ACCOUNTANT] },
  // پیش‌پرداخت به تأمین‌کننده از مهر ۱۴۰۵ قاعدهٔ ثبت دارد: دارایی به تفکیک
  // تأمین‌کننده، هرگز هزینه. نام کارخانه از جمله درنمی‌آید و پرسیده می‌شود.
  T006: { allow: [ask('counterparty'), post([`Dr ${SUPPLIER_ADVANCE}`, `Cr ${CASH}`], 120_000_000), ACCOUNTANT] },
  T008: { allow: [ask('counterparty'), post([`Dr ${EXPENSE_CATEGORY}`, `Cr ${PAYABLE}`], 9_000_000)] },
  T009: { allow: [post([`Dr ${PREPAID_ASSET}`, `Cr ${CASH}`], 15_000_000), ACCOUNTANT] },
  T010: { allow: [ACCOUNTANT] },
  // بیعانهٔ زمین نزد بنگاه، تا قطعی شدن معامله پیش‌پرداخت خرید است — دارایی.
  T016: { allow: [post([`Dr ${SUPPLIER_ADVANCE}`, `Cr ${CASH}`], 20_000_000), ask('counterparty'), ACCOUNTANT] },
  T062: { allow: [ACCOUNTANT] },
  // ---- بدهی تحقق‌یافته
  T055: { allow: [ACCOUNTANT] },
  T068: { allow: [ACCOUNTANT] },
  // ---- تسویه
  T031: { allow: [ACCOUNTANT, ask('settlement-target')], amount: 50_000_000, direction: 'income' },
  T032: { allow: [ask('settlement-target')] },
  T033: { allow: [ACCOUNTANT] },
  T035: { allow: [ACCOUNTANT, ask('amountScale')] },
  // ---- چک
  T023: { allow: [ask('chequeAgainst')], amountAsked: true },
  T041: { allow: [ask('chequeAgainst')] },
  T042: { allow: [ask('bounce')] },
  T050: { allow: [ACCOUNTANT], noCashRow: true },
  T099: { allow: [ask('chequeAgainst')] },
  // ---- ارزش افزوده
  T025: { allow: [ACCOUNTANT], direction: 'income' },
  T071: { allow: [ACCOUNTANT] },
  T073: { allow: [ACCOUNTANT] },
  T074: { allow: [ACCOUNTANT], direction: 'expense' },
  T076: { allow: [ACCOUNTANT], direction: 'income' },
  T079: { allow: [ACCOUNTANT] },
  // ---- جابه‌جایی مالک
  T081: { allow: [ACCOUNTANT] },
  T082: { allow: [ACCOUNTANT], direction: 'income' },
  T083: { allow: [ACCOUNTANT] },
  // ---- اصلاح و تغییر برآورد: هیچ ردیف نقدی تازه‌ای
  T090: { allow: [ACCOUNTANT], noCashRow: true },
  T101: { allow: [ACCOUNTANT], noCashRow: true },
  T102: { allow: [ACCOUNTANT], noCashRow: true },
  T103: { allow: [ACCOUNTANT], noCashRow: true },
  T106: { allow: [ACCOUNTANT], noCashRow: true },
  T108: { allow: [ACCOUNTANT], noCashRow: true },
  T109: { allow: [ACCOUNTANT, NONE] },
  // ---- امتناع وقتی ماهیت یا مبلغ روشن نیست
  T037: { allow: [ACCOUNTANT], direction: 'income' },
  T040: { allow: [ACCOUNTANT, NONE] },
  T100: { allow: [ACCOUNTANT, NONE] },
  T120: { allow: [ACCOUNTANT] },
};

function matches(item, allowed) {
  if (allowed.outcome !== item.outcome) return false;
  if (allowed.outcome === 'ask') return allowed.facts.includes(item.fact);
  if (allowed.outcome === 'post') {
    return JSON.stringify(lines(item.plan)) === JSON.stringify(allowed.roles) && item.amount === allowed.amount;
  }
  return true;
}

const directionOf = (item) => (['cash-income', 'income'].includes(item.kind) ? 'income' : ['cash-expense', 'expense'].includes(item.kind) ? 'expense' : null);

test('فهرست دامنه دقیقاً چهل سناریوست و همه در فایل هستند', () => {
  assert.equal(Object.keys(EXPECTED).length, 40);
  for (const id of Object.keys(EXPECTED)) assert.ok(scenario(id), `${id} در فایل سناریوها نیست`);
});

for (const [id, expected] of Object.entries(EXPECTED)) {
  test(`${id} — ثبت درست، سؤال مرتبط، یا صف حسابدار`, () => {
    const { text } = scenario(id);
    const result = runVoice(text);
    const items = result.items.length ? result.items : [{ outcome: 'none' }];
    for (const item of items) {
      const ok = expected.allow.some((allowed) => matches(item, allowed));
      assert.ok(ok, `${id}: «${text}»\n  نتیجه: ${item.outcome}${item.fact ? ` (${item.fact})` : ''} ${describePlan(item.plan)} مبلغ ${item.amount}\n  مجاز: ${JSON.stringify(expected.allow)}`);
      if (expected.direction && item.outcome !== 'none') {
        assert.equal(directionOf(item), expected.direction, `${id}: جهت پول در ردیف صف غلط است`);
      }
    }
    if (expected.amount) assert.ok(items.some((item) => item.amount === expected.amount), `${id}: مبلغ ${expected.amount} برداشت نشد`);
    if (expected.noCashRow) assert.ok(items.every((item) => item.outcome === 'none' || item.noCashRow), `${id}: نباید ردیف نقدی ساخته شود`);
    if (expected.amountAsked) assert.ok(items.every((item) => !item.amount), `${id}: جمله چند مبلغ دارد؛ مبلغ باید پرسیده شود`);
  });
}

/**
 * کل ۱۲۰ سناریو: هیچ «ثبت با اطمینان» بیرون از فهرست تأییدشده.
 *
 * هر سناریوی دیگری — در دامنه یا نه — یا می‌پرسد یا به حسابدار می‌رود. اگر روزی
 * قاعدهٔ تازه‌ای سناریوی دیگری را «ثبت» کند، این تست می‌شکند تا کسی سندش را
 * نگاه کند و به این فهرست اضافه‌اش کند؛ نه اینکه بی‌صدا شروع به ثبت کند.
 */
const APPROVED_POSTINGS = {
  T001: 'Dr expense-category 12000000 / Cr cash 12000000',
  T009: 'Dr prepaid-asset 15000000 / Cr cash 15000000',
  // کارمزد بانکی هزینهٔ همان دوره است و سؤالی لازم ندارد؛ «پنجاه برگه» شمارش
  // است نه مبلغ و ردیفی نمی‌سازد.
  T049: 'Dr expense-category 200000 / Cr cash 200000',
  T059: 'Dr expense-category 6500000 / Cr cash 6500000',
  // بیعانهٔ زمین نزد بنگاه: پیش‌پرداخت خرید، نه هزینه (بازبینی مهر ۱۴۰۵).
  T016: 'Dr supplier-advance 20000000 / Cr cash 20000000',
  // بیمهٔ مسئولیت یک‌ساله، فروردین تا اسفند: همان پیش‌پرداخت مورد انتظار سناریو.
  // تا مهر ۱۴۰۵ «بیمه مسئولیت» دستهٔ بیمه نمی‌گرفت و به حسابدار می‌رفت.
  T002: 'Dr prepaid-asset 50000000 / Cr cash 50000000',
};

test('در کل ۱۲۰ سناریو، هیچ سندی بدون بررسی و بیرون از فهرست تأییدشده ساخته نمی‌شود', () => {
  const unexpected = [];
  for (const { id, text } of all) {
    for (const item of runVoice(text).items) {
      if (item.outcome !== 'post' && item.outcome !== 'draft') continue;
      const described = describePlan(item.plan) || item.outcome;
      if (APPROVED_POSTINGS[id] !== described) unexpected.push(`${id}: ${described} «${text.slice(0, 60)}…»`);
    }
  }
  assert.deepEqual(unexpected, [], `ثبت‌های تأییدنشده:\n${unexpected.join('\n')}`);
});

test('هیچ سناریویی دورهٔ پوشش را از چیزی جز خدمت دوره‌دار نمی‌پرسد', () => {
  // سؤال غلط از رویداد درست هم خطاست: بیمهٔ تأمین اجتماعی و خسارت بیمه
  // حق‌بیمهٔ دوره‌دار نیستند.
  for (const id of ['T062', 'T113']) {
    for (const item of runVoice(scenario(id).text).items) {
      assert.notEqual(item.fact, 'servicePeriodStart', `${id} نباید دورهٔ پوشش بپرسد`);
    }
  }
});
