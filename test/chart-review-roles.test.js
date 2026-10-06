import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('chart-review-roles');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'chart-owner';
process.env.ADMIN_PASSWORD = `chart-${crypto.randomUUID()}`;

const database = await import(`../server/db.js?chartroles=${process.pid}`);
const chart = await import(`../server/chartOfAccounts.js?chartroles=${process.pid}`);
const { resolveEventRole } = await import(`../server/roleResolver.js?chartroles=${process.pid}`);

database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const inPrimary = (callback) => database.runInWorkspace('primary', { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

/**
 * حساب‌هایی که مسیر بررسی حسابدار می‌سازد، در کدینگ پیشنهادی جا دارند.
 *
 * آزمون زندهٔ ۱۳ مهر: سند اصل وام، ودیعه و پیش‌دریافت متوازن ساخته شد ولی در
 * خروجی پارسیان «بدون نگاشت» ماند، و کارمزد بانک و لوازم اداری در «سایر
 * هزینه‌ها» نشستند. سند متوازن بدون کدینگ درست، ثبت کامل نیست.
 */

const codeOf = (ledgerAccountId) => db().prepare(`SELECT c.code FROM ledger_accounts l
  LEFT JOIN chart_accounts c ON c.id=l.chart_account_id WHERE l.id=?`).get(ledgerAccountId)?.code || null;
const suggestFor = (ledgerAccountId) => {
  const ledger = db().prepare('SELECT * FROM ledger_accounts WHERE id=?').get(ledgerAccountId);
  return chart.suggestChartAccount(ledger, chart.listChartAccounts(db()), { confidentOnly: true })?.code || null;
};

test('آماده‌سازی: کدینگ پیشنهادی نصب شده است', () => {
  inPrimary(() => {
    chart.installDefaultChartTemplate(db());
    assert.ok(chart.listChartAccounts(db()).some((item) => item.code === '3401'));
  });
});

const event = { counterparty: 'بانک آزمون', counterpartyId: null, accountId: 'cash' };
for (const [role, key, code] of [
  ['loan-payable', 'بانک آزمون', '3401'],
  ['refundable-deposit', 'موجر آزمون', '2201'],
  ['customer-advance', 'مشتری آزمون', '3104'],
  ['deferred-revenue', 'مشتری آزمون', '3105'],
  ['unidentified-receipt', null, '3106'],
  ['prepaid-asset', 'بیمه', '1401'],
  ['accumulated-depreciation', 'لپ‌تاپ', '2102'],
  ['depreciation-expense', null, '8117'],
]) {
  test(`نقش «${role}» به معین ${code} نگاشت می‌شود`, () => {
    inPrimary(() => {
      const id = resolveEventRole(db(), role, key, event);
      assert.equal(codeOf(id) || suggestFor(id), code);
    });
  });
}

for (const [category, code] of [
  ['کارمزد بانکی', '8107'], ['ملزومات اداری', '8108'], ['تبلیغات و بازاریابی', '8110'],
  ['تعمیر و نگهداری', '8111'], ['بیمه', '8119'],
]) {
  test(`دستهٔ «${category}» معین خودش (${code}) را می‌گیرد، نه «سایر هزینه‌ها»`, () => {
    inPrimary(() => {
      const id = resolveEventRole(db(), 'expense-category', category, event);
      assert.equal(codeOf(id) || suggestFor(id), code);
    });
  });
}

test('بیمه دیگر به معین حقوق و دستمزد پیشنهاد نمی‌شود', () => {
  inPrimary(() => {
    const id = resolveEventRole(db(), 'expense-category', 'بیمه', event);
    assert.notEqual(codeOf(id) || suggestFor(id), '8101');
  });
});

test('کدینگ پیش از تفکیک: کد عمومی قبلی پیشنهاد می‌شود، نه «بدون نگاشت»', () => {
  // دفتری که کدینگ را پیش از این تغییر نصب کرده، ۸۱۰۷ ندارد.
  const oldChart = [
    { id: 'c8109', code: '8109', name: 'سایر هزینه‌های عملیاتی', level: 'subsidiary', type: 'expense', role: 'operating-expense', postable: true, active: true },
    { id: 'c8101', code: '8101', name: 'حقوق و دستمزد', level: 'subsidiary', type: 'expense', role: 'salary-expense', postable: true, active: true },
  ];
  const ledger = (key) => ({ type: 'expense', sourceKind: 'expense-category', sourceKey: key, name: key });
  assert.equal(chart.suggestChartAccount(ledger('کارمزد بانکی'), oldChart, { confidentOnly: true })?.code, '8109');
  assert.equal(chart.suggestChartAccount(ledger('بیمه'), oldChart, { confidentOnly: true })?.code, '8109', 'بیمه نباید به حقوق برود');
});
