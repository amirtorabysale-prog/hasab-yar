// لیست حقوق روی دفتر فعال — از فایل دفتر تا سند و تسویه.
//
// چرا از فایل و نه فرم: هر دفتر حسابداری لیست حقوق را از قبل در اکسل یا در
// نرم‌افزار خودش می‌بندد. تایپ دوبارهٔ پنجاه ردیف در حساب‌یار، همان
// دوباره‌کاری‌ای است که قرار بود برداشته شود — و هر بار یک فرصت تازه برای
// اشتباه تایپی.

import {
  employeeAnalytic, payrollLedgerAccounts, postPayrollJournal, postPayrollPaymentJournal, reverseJournalEntry,
} from '../accounting.js';
import { ensurePayrollSchema, payrollError, payrollId, validatePayrollRows } from '../payroll.js';
import { activeWorkspaceDatabase, audit, currentTimeZone, currentWorkspace } from './core.js';
import { payrollRowsFromFile } from '../spreadsheetImport.js';
import { resolveAccountId } from './accounts.js';

const database = () => {
  const db = activeWorkspaceDatabase();
  ensurePayrollSchema(db);
  return db;
};

const RUN_COLUMNS = `id,period,occurred_at AS occurredAt,gross,insurance_employee AS insuranceEmployee,
  insurance_employer AS insuranceEmployer,income_tax AS incomeTax,other_deductions AS otherDeductions,net,note,
  journal_entry_id AS journalEntryId,insurance_paid_at AS insurancePaidAt,tax_paid_at AS taxPaidAt,created_at AS createdAt`;

function runLines(db, runId) {
  return db.prepare(`SELECT id,employee_name AS employeeName,national_id AS nationalId,analytic_id AS analyticId,
    gross,insurance_employee AS insuranceEmployee,insurance_employer AS insuranceEmployer,income_tax AS incomeTax,
    other_deductions AS otherDeductions,net,paid_at AS paidAt,paid_entry_id AS paidEntryId
    FROM payroll_lines WHERE run_id=? ORDER BY rowid`).all(runId);
}

function hydrate(db, row) {
  if (!row) return null;
  const lines = runLines(db, row.id);
  const unpaid = lines.filter((line) => !line.paidAt);
  return {
    ...row,
    lines,
    employeeCount: lines.length,
    unpaidCount: unpaid.length,
    unpaidNet: unpaid.reduce((sum, line) => sum + line.net, 0),
    insuranceTotal: row.insuranceEmployee + row.insuranceEmployer,
  };
}

export function listPayrollRuns({ limit = 24 } = {}) {
  const db = database();
  return db.prepare(`SELECT ${RUN_COLUMNS} FROM payroll_runs ORDER BY period DESC,created_at DESC LIMIT ?`)
    .all(Math.min(60, Math.max(1, Number(limit) || 24)))
    .map((row) => hydrate(db, row));
}

export function getPayrollRun(id) {
  const db = database();
  return hydrate(db, db.prepare(`SELECT ${RUN_COLUMNS} FROM payroll_runs WHERE id=?`).get(String(id || '')));
}

/**
 * ورود لیست حقوق یک دوره و ساخت سندش.
 *
 * دوره یکتاست: لیست حقوق شهریور دو بار ثبت نمی‌شود. اگر دفتر لیست را اصلاح
 * کرده، باید اول ثبت قبلی را برگرداند تا سندش هم معکوس شود — وگرنه هزینهٔ
 * حقوق دو برابر می‌شود و هیچ‌کس هم نمی‌فهمد کدام درست است.
 */
export function importPayrollFile(buffer, fileName = '', { period = '', occurredAt = '', note = '' } = {}) {
  const db = database();
  const cleanPeriod = String(period || '').trim().slice(0, 20);
  if (!cleanPeriod) throw payrollError('دورهٔ لیست حقوق مشخص نشده است.', 'PAYROLL_PERIOD_MISSING');
  if (db.prepare('SELECT 1 FROM payroll_runs WHERE period=?').get(cleanPeriod)) {
    throw payrollError(`لیست حقوق «${cleanPeriod}» از قبل ثبت شده است؛ برای اصلاح، اول همان را برگردان.`, 'PAYROLL_PERIOD_EXISTS', 409);
  }

  const { lines, totals, errors } = validatePayrollRows(payrollRowsFromFile(buffer, fileName));
  if (errors.length) throw Object.assign(payrollError('لیست حقوق ایراد دارد و هیچ ردیفی وارد نشد.', 'PAYROLL_ROWS_INVALID'), { details: { errors } });
  if (!lines.length) throw payrollError('هیچ ردیف معتبری در لیست حقوق نبود.', 'PAYROLL_ROWS_EMPTY');

  const runId = payrollId();
  const postedAt = occurredAt || new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    // هر پرسنل یک تفصیلی می‌گیرد تا بدهی‌اش جدا دیده و جدا تسویه شود.
    const withAnalytics = lines.map((line) => ({ ...line, analyticId: employeeAnalytic(db, line) }));
    db.prepare(`INSERT INTO payroll_runs (id,period,occurred_at,gross,insurance_employee,insurance_employer,
      income_tax,other_deductions,net,note) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(runId, cleanPeriod, postedAt, totals.gross, totals.insuranceEmployee, totals.insuranceEmployer,
        totals.incomeTax, totals.otherDeductions, withAnalytics.reduce((sum, line) => sum + line.net, 0),
        String(note || '').slice(0, 300));
    const insert = db.prepare(`INSERT INTO payroll_lines (id,run_id,employee_name,national_id,analytic_id,gross,
      insurance_employee,insurance_employer,income_tax,other_deductions,net) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const line of withAnalytics) {
      insert.run(payrollId(), runId, line.employeeName, line.nationalId, line.analyticId, line.gross,
        line.insuranceEmployee, line.insuranceEmployer, line.incomeTax, line.otherDeductions, line.net);
    }
    const posted = postPayrollJournal(db, { id: runId, period: cleanPeriod, occurredAt: postedAt }, withAnalytics, {
      createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone(),
    });
    db.prepare('UPDATE payroll_runs SET journal_entry_id=? WHERE id=?').run(posted.id, runId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }

  audit('import', 'payroll_run', runId, { period: cleanPeriod, employees: lines.length, gross: totals.gross, fileName });
  return getPayrollRun(runId);
}

/**
 * پرداخت خالص حقوق — به تفکیک پرسنل.
 *
 * یک‌جا پرداخت‌کردن وسوسه‌انگیز است ولی ماندهٔ تفصیلیِ هیچ‌کس را صفر نمی‌کند:
 * بدهی هر نفر جدا ثبت شده و باید جدا هم بسته شود، وگرنه در دفتر تفصیلی همه
 * بدهکار می‌مانند درحالی‌که پولشان را گرفته‌اند.
 */
export function payPayrollSalaries(runId, { lineIds = [], accountId, account = 'cash', occurredAt = '' } = {}) {
  const db = database();
  const run = db.prepare(`SELECT ${RUN_COLUMNS} FROM payroll_runs WHERE id=?`).get(String(runId || ''));
  if (!run) throw payrollError('لیست حقوق پیدا نشد.', 'PAYROLL_RUN_MISSING', 404);
  const wanted = new Set((Array.isArray(lineIds) ? lineIds : []).map((item) => String(item)));
  const targets = runLines(db, run.id).filter((line) => !line.paidAt && (!wanted.size || wanted.has(line.id)));
  if (!targets.length) throw payrollError('همهٔ خالص‌های این لیست از قبل پرداخت شده‌اند.', 'PAYROLL_ALREADY_PAID', 409);

  const accounts = payrollLedgerAccounts(db);
  const paymentId = payrollId();
  const paidAt = occurredAt || new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const posted = postPayrollPaymentJournal(db, {
      paymentId, occurredAt: paidAt, memo: `پرداخت حقوق ${run.period}`,
      cashAccountId: resolveAccountId({ account, accountId }),
      entries: targets.map((line) => ({
        accountId: accounts.salaryPayable, amount: line.net, analyticId: line.analyticId,
        description: `پرداخت حقوق ${line.employeeName}`,
      })),
    }, { createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone() });
    const mark = db.prepare('UPDATE payroll_lines SET paid_at=?,paid_entry_id=? WHERE id=?');
    for (const line of targets) mark.run(paidAt, posted.id, line.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }

  audit('pay', 'payroll_run', run.id, { kind: 'salary', employees: targets.length, amount: targets.reduce((sum, line) => sum + line.net, 0) });
  return getPayrollRun(run.id);
}

const LIABILITY_KINDS = {
  insurance: { column: 'insurance_paid_at', label: 'بیمهٔ تأمین اجتماعی', account: 'insurancePayable' },
  tax: { column: 'tax_paid_at', label: 'مالیات حقوق', account: 'taxPayable' },
};

/**
 * پرداخت بیمه یا مالیات حقوق.
 *
 * این دو یک گیرنده دارند، پس یک‌جا پرداخت می‌شوند و تفصیلی پرسنل نمی‌گیرند؛
 * گذاشتن تفصیلیِ یک نفر روی فیشِ کلِ تأمین اجتماعی، داده‌ای می‌سازد که هیچ
 * معنایی ندارد.
 */
export function payPayrollLiability(runId, kind, { accountId, account = 'cash', occurredAt = '' } = {}) {
  const db = database();
  const spec = LIABILITY_KINDS[kind];
  if (!spec) throw payrollError('نوع بدهی حقوق معتبر نیست.', 'PAYROLL_LIABILITY_UNKNOWN');
  const run = db.prepare(`SELECT ${RUN_COLUMNS} FROM payroll_runs WHERE id=?`).get(String(runId || ''));
  if (!run) throw payrollError('لیست حقوق پیدا نشد.', 'PAYROLL_RUN_MISSING', 404);
  if (kind === 'insurance' && run.insurancePaidAt) throw payrollError('بیمهٔ این دوره از قبل پرداخت شده است.', 'PAYROLL_ALREADY_PAID', 409);
  if (kind === 'tax' && run.taxPaidAt) throw payrollError('مالیات حقوق این دوره از قبل پرداخت شده است.', 'PAYROLL_ALREADY_PAID', 409);
  const amount = kind === 'insurance' ? run.insuranceEmployee + run.insuranceEmployer : run.incomeTax;
  if (amount <= 0) throw payrollError(`${spec.label} این دوره صفر است و پرداختی ندارد.`, 'PAYROLL_NOTHING_TO_PAY');

  const accounts = payrollLedgerAccounts(db);
  const paymentId = payrollId();
  const paidAt = occurredAt || new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    postPayrollPaymentJournal(db, {
      paymentId, occurredAt: paidAt, memo: `پرداخت ${spec.label} ${run.period}`,
      cashAccountId: resolveAccountId({ account, accountId }),
      entries: [{ accountId: accounts[spec.account], amount, description: `${spec.label} ${run.period}` }],
    }, { createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone() });
    db.prepare(`UPDATE payroll_runs SET ${spec.column}=? WHERE id=?`).run(paidAt, run.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }

  audit('pay', 'payroll_run', run.id, { kind, amount });
  return getPayrollRun(run.id);
}

/**
 * برگرداندن یک لیست حقوق.
 *
 * سند معکوس می‌شود، حذف نمی‌شود: دفتر باید بتواند نشان بدهد چه چیزی ثبت شده
 * بود و چرا برگشت. و تا وقتی خالصی پرداخت شده، برگرداندن ممکن نیست — پولی که
 * از حساب رفته با پاک‌کردن سند برنمی‌گردد.
 */
export function reversePayrollRun(runId) {
  const db = database();
  const run = db.prepare(`SELECT ${RUN_COLUMNS} FROM payroll_runs WHERE id=?`).get(String(runId || ''));
  if (!run) throw payrollError('لیست حقوق پیدا نشد.', 'PAYROLL_RUN_MISSING', 404);
  const paid = runLines(db, run.id).filter((line) => line.paidAt).length;
  if (paid || run.insurancePaidAt || run.taxPaidAt) {
    throw payrollError('بخشی از این لیست پرداخت شده است؛ اول پرداخت‌ها را برگردان.', 'PAYROLL_HAS_PAYMENTS', 409);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    reverseJournalEntry(db, {
      sourceType: 'payroll', sourceId: run.id, memo: `برگشت لیست حقوق ${run.period}`,
      createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone(),
    });
    db.prepare('DELETE FROM payroll_runs WHERE id=?').run(run.id);
    db.prepare('DELETE FROM payroll_lines WHERE run_id=?').run(run.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  audit('reverse', 'payroll_run', run.id, { period: run.period });
  return { reversed: true, period: run.period };
}
