import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { persianToISO } from '../shared/persianDate.js';
import { fiscalYearLabel, fiscalYearMonths, fiscalYearOf, fiscalYearOfKey, fiscalYearStartKey, normalizeFiscalStartMonth } from '../shared/fiscalYear.js';

/**
 * سال مالی دلخواه — خانوادهٔ رویداد:
 *   شروع از فروردین (هیچ دفتر قدیمی عوض نمی‌شود)، از مهر، از اسفند؛ سال کبیسه در وسط سال؛
 *   شمارهٔ سند در هر سال مالی از ۱؛ تغییر ماه شروع بعد از ثبت سند (شماره‌گذاری دوباره)؛
 *   مانع‌های تغییر (سال بسته، دورهٔ قفل، تحویل به پارسیان، ماه نامعتبر)؛
 *   بستن سالی که از مهر شروع می‌شود؛ «سود سال جاری» ترازنامه؛ فهرست سال‌های گزارش.
 */

// ---------------------------------------------------------------------------
// قاعدهٔ خالص
// ---------------------------------------------------------------------------

test('قاعده: هر ماه دقیقاً در یک سال مالی؛ دوازده ماه پشت هم؛ سال‌ها بی‌فاصله پشت هم', () => {
  for (let start = 1; start <= 12; start += 1) {
    for (const fiscalYear of [1402, 1403, 1404]) {
      const { periods, first, last } = fiscalYearMonths(fiscalYear, start);
      assert.equal(new Set(periods).size, 12);
      for (const period of periods) assert.equal(fiscalYearOfKey(period, start), fiscalYear, `${start} ${period}`);
      // سال بعد درست از ماهِ بعد از ماه آخر شروع می‌شود.
      const next = fiscalYearMonths(fiscalYear + 1, start).first;
      assert.deepEqual(next, last.month === 12 ? { year: last.year + 1, month: 1 } : { year: last.year, month: last.month + 1 });
      assert.equal(first.month, start);
      // سال مالی همان سالی است که در آن تمام می‌شود.
      assert.equal(last.year, fiscalYear);
      assert.equal(fiscalYearStartKey(`${last.year}-${String(last.month).padStart(2, '0')}-15`, start), `${first.year}-${String(first.month).padStart(2, '0')}-01`);
    }
  }
  assert.equal(fiscalYearOf(1404, 6, 7), 1404);
  assert.equal(fiscalYearOf(1404, 7, 7), 1405);
  assert.equal(fiscalYearOf(1404, 12, 1), 1404);
  assert.equal(fiscalYearLabel(1404, 1), '1404');
  assert.equal(fiscalYearLabel(1404, 7), 'منتهی به شهریور 1404');
  assert.equal(fiscalYearLabel(1404, 12), 'منتهی به بهمن 1404');
  assert.deepEqual([0, 13, 'x', 2.5, undefined].map(normalizeFiscalStartMonth), [1, 1, 1, 1, 1]);
});

// ---------------------------------------------------------------------------
// دفتر
// ---------------------------------------------------------------------------

const databasePath = tempDatabase('fiscal-year');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'fiscal-owner';
process.env.ADMIN_PASSWORD = 'fiscal-strong-password-5511';
const database = await import('../server/db.js');
const accounting = await import('../server/accounting.js');
const reports = await import('../server/accounting/reports.js');
database.ensureAdmin();
const owner = database.authenticateUser('fiscal-owner', 'fiscal-strong-password-5511');
test.after(() => removeTempDatabase(databasePath));

const TZ = 'Asia/Tehran';
const day = (y, m, d) => persianToISO(y, m, d, TZ);
let seq = 0;
async function ledger(name, build) {
  const workspace = database.createWorkspace(owner.id, { name, profileType: 'business' });
  return database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, async () => {
    database.installChartTemplate();
    const db = database.activeWorkspaceDatabase();
    accounting.ensureAccountingSchema(db);
    const byRole = (role) => db.prepare('SELECT la.id FROM ledger_accounts la JOIN chart_accounts ca ON ca.id=la.chart_account_id WHERE ca.role=? ORDER BY la.code LIMIT 1').get(role).id;
    const sale = (occurredAt, amount) => accounting.postJournalEntry(db, { sourceType: 'fiscal-test', sourceId: `e${seq += 1}`, occurredAt, memo: 'فروش', lines: [{ accountId: byRole('cash'), debit: amount, credit: 0 }, { accountId: byRole('sales'), debit: 0, credit: amount }] }, { timeZone: TZ });
    return build({ db, byRole, sale });
  });
}
const setStart = (db, month) => accounting.setFiscalYearStartMonth(db, month, { timeZone: TZ });
const numbers = (db) => db.prepare('SELECT fiscal_year AS year,document_number AS number FROM journal_entries ORDER BY occurred_at,created_at,rowid').all().map((row) => [row.year, row.number]);

test('دفتر بی‌تنظیم همان سال شمسی است؛ شروع از مهر شمارهٔ سند را در مرز مهر از ۱ می‌کند', async () => {
  await ledger('fy-numbering', ({ db, sale }) => {
    assert.equal(accounting.fiscalStartMonth(db), 1);
    sale(day(1403, 8, 1), 1_000);
    assert.deepEqual(numbers(db), [['1403', 1]]);
    // تغییر بعد از سند: سند آبان ۱۴۰۳ مال سال مالی منتهی به شهریور ۱۴۰۴ می‌شود.
    const result = setStart(db, 7);
    assert.deepEqual([result.changed, result.previous, result.startMonth, result.renumbered], [true, 1, 7, 1]);
    sale(day(1404, 6, 31), 2_000);
    sale(day(1404, 7, 1), 3_000);
    sale(day(1403, 6, 31), 4_000);
    assert.deepEqual(numbers(db), [['1403', 1], ['1404', 1], ['1404', 2], ['1405', 1]]);
    assert.equal(setStart(db, 7).changed, false);
    // برگشت به فروردین، دوباره به ترتیب تاریخ.
    setStart(db, 1);
    assert.deepEqual(numbers(db), [['1403', 1], ['1403', 2], ['1404', 1], ['1404', 2]]);
    assert.throws(() => setStart(db, 13), { code: 'FISCAL_START_INVALID' });
  });
});

test('مانع تغییر: دورهٔ قفل، سال بسته و بستهٔ تحویل‌شده به پارسیان', async () => {
  await ledger('fy-locks', ({ db, sale }) => {
    sale(day(1403, 3, 1), 1_000);
    accounting.lockAccountingPeriod(db, '1403-03', owner.id);
    assert.throws(() => setStart(db, 7), { code: 'FISCAL_START_LOCKED' });
    accounting.reopenAccountingPeriod(db, '1403-03', owner.id, 'آزمون تغییر سال مالی');
    accounting.closeFiscalYear(db, 1403, { userId: owner.id, timeZone: TZ });
    assert.throws(() => setStart(db, 7), /بسته شده/);
    accounting.reopenFiscalYear(db, 1403, { userId: owner.id, reason: 'آزمون تغییر سال مالی', timeZone: TZ });
    db.prepare(`INSERT INTO accounting_transfer_batches (id,period,target_system,file_name,row_count,entry_count,debit_total,credit_total,digest,readiness_snapshot,file_data,status)
      VALUES ('b1','1403-03','parsian-review-csv','f.mdb',2,1,1000,1000,'d','{}',x'00','delivered')`).run();
    assert.throws(() => setStart(db, 7), /پارسیان/);
    db.prepare("DELETE FROM accounting_transfer_batches").run();
    assert.equal(setStart(db, 7).changed, true);
  });
});

test('بستن سال مالی منتهی به شهریور: مهر تا شهریور، سند روز ۳۱ شهریور، افتتاحیه ۱ مهر، دوازده دورهٔ درست قفل', async () => {
  await ledger('fy-close-mehr', ({ db, byRole, sale }) => {
    setStart(db, 7);
    sale(day(1403, 7, 1), 10_000_000); // اول سال مالی ۱۴۰۴
    sale(day(1404, 6, 31), 5_000_000); // آخر سال مالی ۱۴۰۴
    sale(day(1404, 7, 1), 7_000_000); // سال مالی ۱۴۰۵
    const plan = accounting.previewYearClose(db, 1404, { timeZone: TZ });
    assert.deepEqual([plan.from, plan.to, plan.label, plan.ready, plan.profit], ['1403-07-01', '1404-06-31', 'منتهی به شهریور 1404', true, 15_000_000]);
    assert.ok(plan.reminders.some((text) => /سال 1405 از قبل 1 سند/.test(text)), plan.reminders.join());
    const result = accounting.closeFiscalYear(db, 1404, { userId: owner.id, timeZone: TZ });
    assert.deepEqual(result.lockedPeriods, ['1403-07', '1403-08', '1403-09', '1403-10', '1403-11', '1403-12', '1404-01', '1404-02', '1404-03', '1404-04', '1404-05', '1404-06']);
    const roles = db.prepare('SELECT y.role,j.fiscal_year AS year,j.occurred_at AS at FROM year_close_entries y JOIN journal_entries j ON j.id=y.entry_id ORDER BY y.role').all();
    assert.deepEqual(roles.map((row) => [row.role, row.year]), [['closing', '1404'], ['opening', '1405'], ['temporary', '1404']]);
    assert.equal(roles.find((row) => row.role === 'opening').at, accounting.fiscalYearBounds(1405, TZ, 7).from);
    // سود و زیانِ بازهٔ سال مالی دست نخورده؛ تراز سال بعد فقط فروش مهر ۱۴۰۴ را دارد.
    assert.equal(reports.incomeStatementReport(db, { from: day(1403, 7, 1), to: day(1404, 6, 31), timeZone: TZ }).totals.revenue, 15_000_000);
    const next = reports.trialBalanceReport(db, { from: day(1404, 7, 1), to: day(1405, 6, 31), level: 'account', timeZone: TZ });
    const salesRow = next.rows.find((row) => row.key === byRole('sales'));
    assert.deepEqual([salesRow.openingCreditBalance, salesRow.closingCreditBalance], [0, 7_000_000]);
    assert.equal(next.balanced, true);
    // سال بعد هنوز باز است: سال مالی ۱۴۰۵ بسته نمی‌شود چون ۱۴۰۴… بسته است؛ سال قبلِ باز ندارد.
    assert.ok(!accounting.previewYearClose(db, 1405, { timeZone: TZ }).blockers.some((item) => item.code === 'FISCAL_YEAR_PREVIOUS_OPEN'));
  });
});

test('سال مالی منتهی به بهمن، با اسفند کبیسهٔ ۱۴۰۳ در آغازش', async () => {
  await ledger('fy-esfand', ({ db, sale }) => {
    setStart(db, 12);
    sale(day(1403, 12, 30), 1_000);
    const bounds = accounting.fiscalYearBounds(1404, TZ, 12);
    assert.deepEqual([bounds.firstDay, bounds.lastDay, bounds.nextFirstDay], ['1403-12-01', '1404-11-30', '1404-12-01']);
    assert.deepEqual(numbers(db), [['1404', 1]]);
    assert.equal(accounting.previewYearClose(db, 1404, { timeZone: TZ }).profit, 1_000);
  });
});

test('ترازنامه: «سود سال جاری» از اول سال مالی؛ سال‌های گزارش به سال مالی و با برچسب', async () => {
  await ledger('fy-reports', ({ db, sale }) => {
    sale(day(1403, 5, 1), 1_000); // سال مالی ۱۴۰۳ (منتهی به شهریور ۱۴۰۳)
    sale(day(1403, 8, 1), 2_000); // سال مالی ۱۴۰۴
    sale(day(1404, 3, 1), 4_000); // سال مالی ۱۴۰۴
    setStart(db, 7);
    const sheet = reports.balanceSheetReport(db, { to: day(1404, 3, 1), compare: true, timeZone: TZ });
    assert.deepEqual([sheet.totals.retained, sheet.totals.currentYear, sheet.yearStart], [1_000, 6_000, '1403-07-01']);
    assert.equal(sheet.previous.asOf, '1403-06-31');
    const { years, startMonth } = reports.ledgerYears(db, { timeZone: TZ });
    assert.equal(startMonth, 7);
    assert.deepEqual(years.map((item) => [item.year, item.label, item.approved]), [[1404, 'منتهی به شهریور 1404', 2], [1403, 'منتهی به شهریور 1403', 1]]);
  });
});

test('دسترسی: تغییر ماه شروع سال مالی فقط مالک', async () => {
  const { minimumRoleForRequest } = await import('../server/access.js');
  assert.equal(minimumRoleForRequest('POST', '/accounting/fiscal-year'), 'owner');
});
