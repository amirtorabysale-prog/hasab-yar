import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * حقوق و دستمزد — سه بدهی، سه گیرنده.
 *
 * ثبت حقوق به‌صورت «یک هزینهٔ نقدی» ساده‌ترین کار است و غلط‌ترین: بیمه و
 * مالیاتِ کسرشده هنوز پرداخت نشده‌اند و بدهی شرکت‌اند، نه هزینهٔ پرداخت‌شده.
 * دفتری که این‌طور ثبت کند، در تاریخ پرداخت بیمه هیچ بدهی‌ای در دفترش نمی‌بیند
 * و مبلغ را دوباره هزینه می‌کند.
 */
const databasePath = tempDatabase('payroll');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'payroll-owner';
process.env.ADMIN_PASSWORD = 'payroll-strong-password-4417';

const database = await import(`../server/db.js?payroll=${process.pid}`);
const accounting = await import(`../server/accounting.js?payroll=${process.pid}`);
const sheet = await import(`../server/spreadsheet.js?payroll=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('payroll-owner', 'payroll-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'کارخانهٔ پلاستیک', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const HEADER = ['نام پرسنل', 'کد ملی', 'حقوق ناخالص', 'بیمه سهم کارمند', 'بیمه سهم کارفرما', 'مالیات', 'سایر کسورات', 'خالص پرداختی'];
const payrollFile = (rows) => sheet.buildWorkbook([{ name: 'حقوق', rows: [HEADER, ...rows] }]);

// ناخالص ۵۰٬۰۰۰٬۰۰۰ · بیمهٔ کارمند ۳٬۵۰۰٬۰۰۰ · بیمهٔ کارفرما ۱۱٬۵۰۰٬۰۰۰
// مالیات ۱٬۰۰۰٬۰۰۰ · خالص ۴۵٬۵۰۰٬۰۰۰
const TWO_PEOPLE = [
  ['رضا کریمی', '0012345678', 30_000_000, 2_100_000, 6_900_000, 600_000, 0, 27_300_000],
  ['مینا رجبی', '0023456789', 20_000_000, 1_400_000, 4_600_000, 400_000, 0, 18_200_000],
];

const balanceOf = (role) => {
  const account = db().prepare('SELECT id FROM ledger_accounts WHERE source_kind=?').get(role);
  if (!account) return null;
  return db().prepare('SELECT COALESCE(SUM(debit)-SUM(credit),0) AS net FROM journal_lines WHERE account_id=?').get(account.id).net;
};

let run;

test('لیست حقوق از فایل دفتر وارد می‌شود و سند درست می‌سازد', () => {
  inWorkspace(() => {
    run = database.importPayrollFile(payrollFile(TWO_PEOPLE), 'payroll.xlsx', { period: '۱۴۰۴/۰۶' });
    assert.equal(run.employeeCount, 2);
    assert.equal(run.gross, 50_000_000);
    assert.equal(run.net, 45_500_000);
    assert.equal(run.insuranceEmployee, 3_500_000);
    assert.equal(run.insuranceEmployer, 11_500_000);
    assert.equal(run.incomeTax, 1_000_000);
    assert.ok(run.journalEntryId, 'سند باید ساخته شود');
    assert.equal(accounting.trialBalance(db()).balanced, true);

    // هزینهٔ دوره = ناخالص + سهم کارفرما، نه فقط آنچه از حساب می‌رود.
    assert.equal(balanceOf('payroll-salary-expense'), 50_000_000);
    assert.equal(balanceOf('payroll-insurance-expense'), 11_500_000);
    // و سه بدهیِ جدا، هرکدام با گیرندهٔ خودش.
    assert.equal(balanceOf('payroll-salary-payable'), -45_500_000);
    assert.equal(balanceOf('payroll-insurance-payable'), -15_000_000);
    assert.equal(balanceOf('payroll-tax-payable'), -1_000_000);
  });
});

/**
 * بدهی هر پرسنل جدا دیده می‌شود.
 *
 * یک آرتیکل جمعی، در دفتر تفصیلی هیچ‌کس را بدهکار نشان نمی‌دهد و در پارسیان
 * هم روی معینِ تفصیلی‌دار کنار گذاشته می‌شود.
 */
test('خالص هر نفر، تفصیلی خودش را دارد', () => {
  inWorkspace(() => {
    const rows = db().prepare(`SELECT analytic_accounts.name AS name,journal_lines.credit AS credit
      FROM journal_lines JOIN analytic_accounts ON analytic_accounts.id=journal_lines.analytic_id
      WHERE journal_lines.entry_id=? ORDER BY journal_lines.rowid`).all(run.journalEntryId)
      .map((row) => ({ name: row.name, credit: row.credit }));
    assert.deepEqual(rows, [
      { name: 'رضا کریمی', credit: 27_300_000 },
      { name: 'مینا رجبی', credit: 18_200_000 },
    ]);
  });
});

test('خالصی که با ناخالص منهای کسورات نمی‌خواند، کل فایل را رد می‌کند', () => {
  inWorkspace(() => {
    assert.throws(() => database.importPayrollFile(payrollFile([
      ['حسن نوری', '', 10_000_000, 700_000, 2_300_000, 200_000, 0, 9_500_000],
    ]), 'bad.xlsx', { period: '۱۴۰۴/۰۵' }), (error) => {
      assert.equal(error.code, 'PAYROLL_ROWS_INVALID');
      assert.match(error.details.errors[0].message, /خالص «حسن نوری»/);
      return true;
    });
    assert.equal(database.listPayrollRuns().length, 1, 'فایل ردشده نباید چیزی در دفتر بگذارد');
  });
});

test('یک دوره دو بار ثبت نمی‌شود', () => {
  inWorkspace(() => {
    assert.throws(() => database.importPayrollFile(payrollFile(TWO_PEOPLE), 'again.xlsx', { period: '۱۴۰۴/۰۶' }),
      (error) => error.code === 'PAYROLL_PERIOD_EXISTS');
  });
});

test('پرداخت خالص، بدهی تفصیلیِ هر نفر را صفر می‌کند', () => {
  inWorkspace(() => {
    const paid = database.payPayrollSalaries(run.id, { account: 'cash' });
    assert.equal(paid.unpaidCount, 0);
    assert.equal(balanceOf('payroll-salary-payable'), 0);
    for (const line of paid.lines) {
      const net = db().prepare('SELECT COALESCE(SUM(debit)-SUM(credit),0) AS net FROM journal_lines WHERE analytic_id=?')
        .get(line.analyticId).net;
      assert.equal(net, 0, `بدهی ${line.employeeName} باید بسته شود`);
    }
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

test('پرداخت بیمه و مالیات، بدهی خودشان را می‌بندد و دوباره پذیرفته نمی‌شود', () => {
  inWorkspace(() => {
    database.payPayrollLiability(run.id, 'insurance', { account: 'cash' });
    assert.equal(balanceOf('payroll-insurance-payable'), 0);
    assert.throws(() => database.payPayrollLiability(run.id, 'insurance', { account: 'cash' }),
      (error) => error.code === 'PAYROLL_ALREADY_PAID');

    database.payPayrollLiability(run.id, 'tax', { account: 'cash' });
    assert.equal(balanceOf('payroll-tax-payable'), 0);
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

// پولی که از حساب رفته با پاک‌کردن سند برنمی‌گردد.
test('لیستی که پرداخت شده برگردانده نمی‌شود', () => {
  inWorkspace(() => {
    assert.throws(() => database.reversePayrollRun(run.id), (error) => error.code === 'PAYROLL_HAS_PAYMENTS');
  });
});

test('لیست پرداخت‌نشده برمی‌گردد و سندش معکوس می‌شود', () => {
  inWorkspace(() => {
    const fresh = database.importPayrollFile(payrollFile([
      ['سعید مرادی', '', 8_000_000, 560_000, 1_840_000, 0, 0, 7_440_000],
    ]), 'mordad.xlsx', { period: '۱۴۰۴/۰۵' });
    const before = balanceOf('payroll-salary-expense');
    database.reversePayrollRun(fresh.id);
    assert.equal(balanceOf('payroll-salary-expense'), before - 8_000_000, 'هزینه باید برگردد');
    assert.equal(accounting.trialBalance(db()).balanced, true);
    assert.equal(database.listPayrollRuns().find((item) => item.period === '۱۴۰۴/۰۵'), undefined);
  });
});

test.after(() => removeTempDatabase(databasePath));
