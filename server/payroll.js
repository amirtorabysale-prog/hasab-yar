// حقوق و دستمزد — از لیست حقوق دفتر تا سند و تسویه.
//
// حساب‌یار حقوق را **محاسبه نمی‌کند**. نرخ بیمه و پلکان مالیات حقوق هر سال
// عوض می‌شوند و هر دفتری هم قاعدهٔ خودش را دارد (مزایای غیرنقدی، اضافه‌کاری،
// حق اولاد). ادعای محاسبه یعنی یک عدد اشتباه با اعتماد کامل — بدترین چیزی که
// می‌شود به یک دفتر حسابداری داد.
//
// کاری که می‌کند این است: لیست حقوقی را که دفتر خودش بسته می‌گیرد و آن را به
// سندِ درست تبدیل می‌کند. و همان‌جا یک چیز را کنترل می‌کند که هیچ‌کس دستی
// نمی‌گیردش: اینکه «خالص = ناخالص − کسورات» برای تک‌تک نفرات برقرار باشد.
//
// چرا سند حقوق سه بدهی جدا می‌سازد: خالص به خودِ پرسنل پرداخت می‌شود، بیمه به
// سازمان تأمین اجتماعی و مالیات به سازمان امور مالیاتی. سه گیرندهٔ متفاوت با
// سه سررسید متفاوت. ریختنشان در یک حساب یعنی هیچ‌کدام قابل پیگیری نیست.

import { randomUUID } from 'node:crypto';

function payrollError(message, code = 'PAYROLL_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function ensurePayrollSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS payroll_runs (
      id TEXT PRIMARY KEY,
      period TEXT NOT NULL UNIQUE,
      occurred_at TEXT NOT NULL,
      gross INTEGER NOT NULL DEFAULT 0,
      insurance_employee INTEGER NOT NULL DEFAULT 0,
      insurance_employer INTEGER NOT NULL DEFAULT 0,
      income_tax INTEGER NOT NULL DEFAULT 0,
      other_deductions INTEGER NOT NULL DEFAULT 0,
      net INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      journal_entry_id TEXT,
      insurance_paid_at TEXT,
      tax_paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS payroll_lines (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      employee_name TEXT NOT NULL,
      national_id TEXT NOT NULL DEFAULT '',
      analytic_id TEXT,
      gross INTEGER NOT NULL DEFAULT 0,
      insurance_employee INTEGER NOT NULL DEFAULT 0,
      insurance_employer INTEGER NOT NULL DEFAULT 0,
      income_tax INTEGER NOT NULL DEFAULT 0,
      other_deductions INTEGER NOT NULL DEFAULT 0,
      net INTEGER NOT NULL DEFAULT 0,
      paid_at TEXT,
      paid_entry_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_lines_run ON payroll_lines(run_id);
  `);
}

const digitMap = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9', '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
const latin = (value) => String(value ?? '').replace(/[۰-۹٠-٩]/g, (digit) => digitMap[digit]);

/**
 * مبلغ یک سلول لیست حقوق.
 *
 * سلول خالی صفر است — در لیست حقوق، «بدون کسر بیمه» واقعاً یعنی صفر. ولی متنی
 * که عدد نیست صفر نمی‌شود؛ `null` برمی‌گردد تا ردیف رد شود و کسی مبلغی را
 * حدس نزند.
 */
export function payrollAmount(value) {
  const raw = latin(value).replace(/[,٬\s]/g, '').trim();
  if (!raw) return 0;
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  return Math.round(Number(raw));
}

const PAYROLL_FIELDS = ['gross', 'insuranceEmployee', 'insuranceEmployer', 'incomeTax', 'otherDeductions', 'net'];

/**
 * کنترل لیست حقوق — پیش از هر ثبتی.
 *
 * قاعدهٔ ثابت این ماژول مثل بقیهٔ ورودی‌ها: فایلِ ایرادکننده هیچ ردیفی وارد
 * نمی‌کند. علتش اینجا از همیشه مهم‌تر است: لیست حقوقِ نیمه‌واردشده یعنی بعضی
 * پرسنل بدهی دارند و بعضی نه، و کسی متوجه نمی‌شود کدام‌ها جا افتاده‌اند.
 */
export function validatePayrollRows(rows = []) {
  const errors = [];
  const lines = [];
  const seen = new Set();

  rows.forEach((row, index) => {
    const rowNumber = row.rowNumber || index + 2;
    const name = String(row.employeeName ?? row.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) { errors.push({ rowNumber, message: 'نام پرسنل خالی است.' }); return; }

    const amounts = {};
    for (const field of PAYROLL_FIELDS) {
      const parsed = payrollAmount(row[field]);
      if (parsed === null) { errors.push({ rowNumber, message: `مقدار «${row[field]}» عدد نیست.` }); return; }
      if (parsed < 0) { errors.push({ rowNumber, message: 'مبلغ منفی در لیست حقوق پذیرفته نمی‌شود.' }); return; }
      amounts[field] = parsed;
    }
    if (!amounts.gross) { errors.push({ rowNumber, message: `حقوق ناخالص «${name}» صفر است.` }); return; }

    // خالص یا در فایل هست یا از خودِ کسورات ساخته می‌شود؛ ولی اگر هست باید
    // با کسورات بخواند. این تنها کنترلی است که دستی گرفته نمی‌شود و همان‌جایی
    // است که اشتباه تایپی لیست حقوق بیرون می‌زند.
    const computed = amounts.gross - amounts.insuranceEmployee - amounts.incomeTax - amounts.otherDeductions;
    if (computed < 0) { errors.push({ rowNumber, message: `کسورات «${name}» از حقوق ناخالصش بیشتر است.` }); return; }
    if (amounts.net && amounts.net !== computed) {
      errors.push({ rowNumber, message: `خالص «${name}» با ناخالص منهای کسورات نمی‌خواند: ${amounts.net.toLocaleString('en-US')} در برابر ${computed.toLocaleString('en-US')}.` });
      return;
    }

    const key = `${name}::${String(row.nationalId ?? '').trim()}`;
    if (seen.has(key)) { errors.push({ rowNumber, message: `«${name}» در فایل تکراری است.` }); return; }
    seen.add(key);

    lines.push({
      rowNumber, employeeName: name,
      nationalId: latin(row.nationalId ?? '').replace(/\D/g, '').slice(0, 20),
      gross: amounts.gross,
      insuranceEmployee: amounts.insuranceEmployee,
      insuranceEmployer: amounts.insuranceEmployer,
      incomeTax: amounts.incomeTax,
      otherDeductions: amounts.otherDeductions,
      net: computed,
    });
  });

  const totals = lines.reduce((sum, line) => {
    for (const field of PAYROLL_FIELDS) sum[field] += line[field];
    return sum;
  }, Object.fromEntries(PAYROLL_FIELDS.map((field) => [field, 0])));

  return { lines, totals, errors };
}

/**
 * آرتیکل‌های سند حقوق.
 *
 * بدهکار: هزینهٔ حقوق (ناخالص) و هزینهٔ بیمهٔ سهم کارفرما.
 * بستانکار: خالص پرداختنی به هر نفر، کل بیمه (سهم کارمند + کارفرما)، مالیات
 * حقوق، و سایر کسورات.
 *
 * خالص به تفکیک هر نفر بستانکار می‌شود، نه یک‌جا: بدهی هر پرسنل باید جدا دیده
 * و جدا تسویه شود، و در پارسیان هم حقوق پرداختنی معمولاً تفصیلیِ پرسنل دارد.
 * جمعِ دو طرف با همان اتحادی برابر می‌شود که در کنترل ردیف‌ها تضمین شده:
 * ناخالص = خالص + بیمهٔ سهم کارمند + مالیات + سایر کسورات.
 */
export function payrollJournalLines(lines, accounts) {
  const totals = lines.reduce((sum, line) => {
    for (const field of PAYROLL_FIELDS) sum[field] += line[field];
    return sum;
  }, Object.fromEntries(PAYROLL_FIELDS.map((field) => [field, 0])));

  const journal = [
    { accountId: accounts.salaryExpense, debit: totals.gross, description: 'هزینهٔ حقوق و دستمزد' },
  ];
  if (totals.insuranceEmployer > 0) {
    journal.push({ accountId: accounts.insuranceExpense, debit: totals.insuranceEmployer, description: 'بیمهٔ سهم کارفرما' });
  }
  for (const line of lines) {
    journal.push({
      accountId: accounts.salaryPayable, credit: line.net,
      analyticId: line.analyticId || null,
      description: `خالص حقوق ${line.employeeName}`,
    });
  }
  const insuranceTotal = totals.insuranceEmployee + totals.insuranceEmployer;
  if (insuranceTotal > 0) journal.push({ accountId: accounts.insurancePayable, credit: insuranceTotal, description: 'بیمهٔ پرداختنی (سهم کارمند و کارفرما)' });
  if (totals.incomeTax > 0) journal.push({ accountId: accounts.taxPayable, credit: totals.incomeTax, description: 'مالیات حقوق پرداختنی' });
  if (totals.otherDeductions > 0) journal.push({ accountId: accounts.otherPayable, credit: totals.otherDeductions, description: 'سایر کسورات حقوق' });

  const debit = journal.reduce((sum, line) => sum + (line.debit || 0), 0);
  const credit = journal.reduce((sum, line) => sum + (line.credit || 0), 0);
  if (debit !== credit) {
    throw payrollError(`سند حقوق متوازن نشد: بدهکار ${debit.toLocaleString('en-US')} در برابر بستانکار ${credit.toLocaleString('en-US')}.`, 'PAYROLL_UNBALANCED');
  }
  return { lines: journal, totals };
}

/** شناسهٔ تازه — تا لایهٔ دفتر لازم نباشد خودش randomUUID را وارد کند. */
export const payrollId = () => randomUUID();

export { payrollError };
