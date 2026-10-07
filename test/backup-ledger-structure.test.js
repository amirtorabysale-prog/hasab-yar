import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * پشتیبان باید ساختار دفتر را هم ببرد، نه فقط ردیف‌ها را.
 *
 * کدینگ، تفصیلی‌ها، مرکز هزینه و لیست حقوق در پشتیبان نبودند. نتیجه: بازیابی
 * در دفتر دیگر به‌خاطر ارجاع حساب‌ها و سطرهای سند به کدینگ و تفصیلیِ ناموجود
 * شکست می‌خورد، و لیست حقوق و وضعیت پرداخت بیمه‌اش از دست می‌رفت.
 */
const databasePath = tempDatabase('backup-structure');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'structure-owner';
process.env.ADMIN_PASSWORD = 'structure-strong-password-6612';

const database = await import('../server/db.js');
const accounting = await import('../server/accounting.js');
const backup = await import('../server/backup.js');
const sheet = await import('../server/spreadsheet.js');
database.ensureAdmin();
const owner = database.authenticateUser('structure-owner', 'structure-strong-password-6612');
const source = database.createWorkspace(owner.id, { name: 'دفتر مبدأ', profileType: 'business' });
const target = database.createWorkspace(owner.id, { name: 'دفتر مقصد', profileType: 'business' });
const inWorkspace = (workspace, callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();
const count = (table) => db().prepare(`SELECT count(*) n FROM ${table}`).get().n;

const HEADER = ['نام پرسنل', 'کد ملی', 'حقوق ناخالص', 'بیمه سهم کارمند', 'بیمه سهم کارفرما', 'مالیات', 'سایر کسورات', 'خالص پرداختی'];
let snapshot;
let expected;

test('دفتر مبدأ با کدینگ، تفصیلی، لیست حقوق و بیمهٔ پرداخت‌شده', () => inWorkspace(source, () => {
  database.installChartTemplate();
  const customer = database.saveContact({ name: 'شرکت آبان', kind: 'customer' });
  const invoice = database.createInvoice({ contactId: customer.id, documentType: 'sales', items: [{ title: 'مشاوره', quantity: 1, unitPrice: 2_000_000 }] });
  database.issueInvoice(invoice.id, {});
  const run = database.importPayrollFile(sheet.buildWorkbook([{ name: 'حقوق', rows: [HEADER, ['رضا کریمی', '0012345678', 30_000_000, 2_100_000, 6_900_000, 600_000, 0, 27_300_000]] }]), 'p.xlsx', { period: '۱۴۰۵/۰۶' });
  database.payPayrollLiability(run.id, 'insurance', { account: 'cash' });
  expected = {
    chart: count('chart_accounts'), analytics: count('analytic_accounts'), runs: count('payroll_runs'), lines: count('payroll_lines'),
    mapped: db().prepare('SELECT count(*) n FROM ledger_accounts WHERE chart_account_id IS NOT NULL').get().n,
  };
  assert.ok(expected.chart > 50 && expected.analytics > 0 && expected.mapped > 0);
  snapshot = backup.openEncryptedBackup(backup.createPortableBackup(source, 'structure-passphrase-1234'), 'structure-passphrase-1234');
}));

test('بازیابی در دفتر دیگر: کدینگ، نگاشت، تفصیلی و لیست حقوق با وضعیت پرداخت می‌آیند', () => inWorkspace(target, () => {
  database.restoreFinancialSnapshot(snapshot);
  assert.equal(count('chart_accounts'), expected.chart);
  assert.equal(count('analytic_accounts'), expected.analytics);
  assert.equal(db().prepare('SELECT count(*) n FROM ledger_accounts WHERE chart_account_id IS NOT NULL').get().n, expected.mapped);
  assert.equal(count('payroll_runs'), expected.runs);
  assert.equal(count('payroll_lines'), expected.lines);
  const [run] = database.listPayrollRuns().items || database.listPayrollRuns();
  assert.ok(run.insurancePaidAt, 'وضعیت پرداخت بیمه از دست نمی‌رود');
  assert.equal(accounting.trialBalance(db()).balanced, true);
}));

test('پشتیبان قدیمیِ بدون این جدول‌ها، کدینگ موجود دفتر را پاک نمی‌کند', () => inWorkspace(source, () => {
  const legacy = structuredClone(snapshot);
  for (const table of ['chart_accounts', 'analytic_accounts', 'cost_centers', 'payroll_runs', 'payroll_lines', 'fixed_asset_settings', 'journal_templates']) delete legacy.tables[table];
  backup.validateFinancialBackup(legacy);
  database.restoreFinancialSnapshot(legacy);
  assert.equal(count('chart_accounts'), expected.chart);
  assert.equal(count('payroll_runs'), expected.runs);
}));

test.after(() => removeTempDatabase(databasePath));
