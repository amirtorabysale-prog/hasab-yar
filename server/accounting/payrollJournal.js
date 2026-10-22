// سند حقوق و پرداخت آن.
//
// از server/accounting.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// accounting همه از همان server/accounting.js می‌خوانند.

import { saveAnalyticAccount } from '../chartOfAccounts.js';
import { ensurePayrollSchema, payrollJournalLines } from '../payroll.js';
import { accountingError, ensureAccountingSchema, linkedLedgerAccount, operationalLedgerAccount, periodForDate } from './ledgerAccounts.js';
import { nextRevision, insertJournal, assertAccountingPeriodOpen } from './journalCore.js';

// ---------------------------------------------------------------------------
// حقوق و دستمزد
// ---------------------------------------------------------------------------

/**
 * پنج حسابی که سند حقوق لازم دارد.
 *
 * هر سه بدهی جدا می‌مانند چون سه گیرندهٔ متفاوت دارند: خالص به پرسنل، بیمه به
 * تأمین اجتماعی، مالیات به سازمان امور مالیاتی. یک حساب مشترک یعنی تسویهٔ
 * هرکدام ماندهٔ دو تای دیگر را هم تکان می‌دهد و هیچ‌کدام قابل پیگیری نیست.
 */
export function payrollLedgerAccounts(database) {
  ensureAccountingSchema(database);
  return {
    salaryExpense: linkedLedgerAccount(database, 'payroll-salary-expense', 'salary', 'هزینهٔ حقوق و دستمزد', 'expense'),
    insuranceExpense: linkedLedgerAccount(database, 'payroll-insurance-expense', 'employer', 'هزینهٔ بیمهٔ سهم کارفرما', 'expense'),
    salaryPayable: linkedLedgerAccount(database, 'payroll-salary-payable', 'net', 'حقوق و دستمزد پرداختنی', 'liability'),
    insurancePayable: linkedLedgerAccount(database, 'payroll-insurance-payable', 'social-security', 'بیمهٔ پرداختنی (تأمین اجتماعی)', 'liability'),
    taxPayable: linkedLedgerAccount(database, 'payroll-tax-payable', 'income-tax', 'مالیات حقوق پرداختنی', 'liability'),
    otherPayable: linkedLedgerAccount(database, 'payroll-other-payable', 'deductions', 'سایر کسورات حقوق پرداختنی', 'liability'),
  };
}

/**
 * تفصیلی هر پرسنل.
 *
 * کلید از کد ملی می‌آید اگر باشد، وگرنه از نام. کد ملی بین دو نفرِ هم‌نام فرق
 * می‌گذارد — چیزی که در لیست حقوق یک کارخانه واقعاً پیش می‌آید.
 */
export function employeeAnalytic(database, { employeeName, nationalId }) {
  const name = String(employeeName || '').trim().slice(0, 120);
  if (!name) return null;
  return saveAnalyticAccount(database, {
    name, kind: 'employee', sourceKind: 'employee', sourceKey: String(nationalId || name).slice(0, 120),
  })?.id || null;
}

/** سند لیست حقوق یک دوره. */
export function postPayrollJournal(database, run, lines, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensurePayrollSchema(database);
  const accounts = payrollLedgerAccounts(database);
  assertAccountingPeriodOpen(database, periodForDate(run.occurredAt, timeZone));
  const { lines: journalLines } = payrollJournalLines(lines, accounts);
  return insertJournal(database, {
    sourceType: 'payroll', sourceId: run.id, revision: nextRevision(database, 'payroll', run.id),
    occurredAt: run.occurredAt, memo: `لیست حقوق ${run.period}`, createdBy, timeZone, lines: journalLines,
  });
}

/**
 * سند پرداخت یک بدهیِ حقوق.
 *
 * فهرست ورودی می‌گوید کدام بدهی و برای چه کسی: خالص حقوق به تفکیک پرسنل تسویه
 * می‌شود تا ماندهٔ تفصیلیِ هر نفر واقعاً صفر شود، و بیمه و مالیات یک‌جا چون
 * یک گیرنده دارند.
 */
export function postPayrollPaymentJournal(database, { paymentId, occurredAt, memo, cashAccountId, entries = [] }, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const total = entries.reduce((sum, entry) => sum + Math.round(Number(entry.amount) || 0), 0);
  if (!Number.isSafeInteger(total) || total <= 0) throw accountingError('مبلغ پرداخت حقوق معتبر نیست.', 'PAYROLL_PAYMENT_INVALID');
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
  const cash = operationalLedgerAccount(database, cashAccountId || 'cash');
  const lines = [
    ...entries.map((entry) => ({
      accountId: entry.accountId, debit: Math.round(Number(entry.amount) || 0),
      analyticId: entry.analyticId || null, description: entry.description || memo,
    })),
    { accountId: cash, credit: total, description: memo },
  ];
  return insertJournal(database, {
    sourceType: 'payroll_payment', sourceId: paymentId, revision: 1,
    occurredAt, memo, createdBy, timeZone, lines,
  });
}
