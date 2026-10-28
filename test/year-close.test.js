import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { persianToISO } from '../shared/persianDate.js';

/**
 * بستن سال مالی — معیار پذیرش فاز ۶: «سند اختتامیه حساب‌های موقت را صفر کند و افتتاحیهٔ
 * سال بعد دقیقاً همان مانده‌ها را بیاورد.»
 *
 * خانوادهٔ رویداد:
 *   سال سودده و زیان‌ده؛ تفصیلی و مرکز هزینه روی مانده؛ حساب و تفصیلیِ غیرفعالِ مانده‌دار؛
 *   سال کبیسه (۳۰ اسفند)؛ سندی در آخرین ساعت سال؛ سال بعد که از قبل سند دارد؛
 *   مانع‌ها (پیش‌نویس، سال قبلِ باز، بسته‌بودن، ثبت بی‌سند، انباشتهٔ نامعلوم در کدینگ واردشده)؛
 *   ثبت در سال بسته؛ بازگشایی و بستن دوباره؛ بازگشایی سال قدیمی‌تر وقتی سال بعد بسته است؛
 *   اختتامیه و افتتاحیهٔ آمده از بکاپ پارسیان (و سندی که فقط شبیه آن است)؛
 *   گزارش‌ها بعد از بستن (ترازنامهٔ روز آخر، تراز سال بعد، سود و زیان، روزنامه، جریان نقد)؛
 *   خلاصهٔ روز و فایل انتقال پارسیان که سند بستن را نمی‌برند.
 */

const databasePath = tempDatabase('year-close');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'year-close-owner';
process.env.ADMIN_PASSWORD = 'year-close-strong-password-5511';
const database = await import('../server/db.js');
const accounting = await import('../server/accounting.js');
const reports = await import('../server/accounting/reports.js');
const chartOfAccounts = await import('../server/chartOfAccounts.js');
database.ensureAdmin();
const owner = database.authenticateUser('year-close-owner', 'year-close-strong-password-5511');
test.after(() => removeTempDatabase(databasePath));

const TZ = 'Asia/Tehran';
const day = (y, m, d) => persianToISO(y, m, d, TZ);

let seq = 0;
async function ledger(name, build, { template = true } = {}) {
  const workspace = database.createWorkspace(owner.id, { name, profileType: 'business' });
  return database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, async () => {
    if (template) database.installChartTemplate();
    const db = database.activeWorkspaceDatabase();
    accounting.ensureAccountingSchema(db);
    const byRole = (role) => db.prepare('SELECT la.id FROM ledger_accounts la JOIN chart_accounts ca ON ca.id=la.chart_account_id WHERE ca.role=? ORDER BY la.code LIMIT 1').get(role).id;
    const post = (occurredAt, lines, extra = {}) => accounting.postJournalEntry(db, { sourceType: 'year-close-test', sourceId: `e${seq += 1}`, occurredAt, memo: extra.memo || `سند ${seq}`, lines, approvalState: extra.approvalState }, { timeZone: TZ });
    return build({ db, byRole, post });
  });
}

const close = (db, year, options = {}) => accounting.closeFiscalYear(db, year, { userId: owner.id, timeZone: TZ, ...options });
const preview = (db, year, options = {}) => accounting.previewYearClose(db, year, { timeZone: TZ, ...options });
const blockerCodes = (db, year, options) => preview(db, year, options).blockers.map((item) => item.code);

/** ماندهٔ (حساب، تفصیلی، مرکز) از ردیف‌های یک سند. */
function entryLines(db, entryId) {
  return db.prepare('SELECT account_id AS accountId,analytic_id AS analyticId,cost_center_id AS costCenterId,debit,credit FROM journal_lines WHERE entry_id=? ORDER BY account_id,analytic_id,cost_center_id').all(entryId)
    .map((line) => ({ ...line }));
}

/** یک سال کامل: سرمایه، فروش نسیه با تفصیلی، خرید، هزینه با مرکز هزینه، وصول. */
function businessYear({ db, byRole, post }, year, { revenue = 100_000_000, expense = 30_000_000 } = {}) {
  db.prepare('INSERT OR IGNORE INTO analytic_accounts (id,code,name,kind,source_kind,source_key,active) VALUES (?,?,?,?,?,?,1)').run('an-karimi', '7001', 'آقای کریمی', 'contact', 'contact', 'c-karimi');
  db.prepare('INSERT OR IGNORE INTO cost_centers (id,code,name,active) VALUES (?,?,?,1)').run('cc-shop', '10', 'فروشگاه');
  post(day(year, 1, 5), [{ accountId: byRole('bank'), debit: 500_000_000, credit: 0 }, { accountId: byRole('owner-capital'), debit: 0, credit: 500_000_000 }]);
  post(day(year, 3, 10), [{ accountId: byRole('receivable'), debit: revenue, credit: 0, analyticId: 'an-karimi' }, { accountId: byRole('sales'), debit: 0, credit: revenue, costCenterId: 'cc-shop' }]);
  post(day(year, 6, 1), [{ accountId: byRole('operating-expense'), debit: expense, credit: 0, costCenterId: 'cc-shop' }, { accountId: byRole('bank'), debit: 0, credit: expense }]);
  post(day(year, 9, 20), [{ accountId: byRole('bank'), debit: revenue / 2, credit: 0 }, { accountId: byRole('receivable'), debit: 0, credit: revenue / 2, analyticId: 'an-karimi' }]);
}

test('بستن سال سودده: موقت به انباشته، اختتامیه همه را صفر، افتتاحیه دقیقاً همان مانده‌ها؛ دوره‌ها قفل', async () => {
  await ledger('yc-profit', (book) => {
    const { db, byRole, post } = book;
    businessYear(book, 1404);
    const before = {
      sheet: reports.balanceSheetReport(db, { to: day(1404, 12, 29), timeZone: TZ }),
      income: reports.incomeStatementReport(db, { from: day(1404, 1, 1), to: day(1404, 12, 29), timeZone: TZ }),
      flow: reports.cashFlowReport(db, { from: day(1404, 1, 1), to: day(1404, 12, 29), timeZone: TZ }),
    };
    const plan = preview(db, 1404);
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.ready, true);
    assert.equal(plan.profit, 70_000_000);
    assert.equal(plan.retained.code, '5201');
    assert.ok(plan.reminders.some((text) => /مالیات عملکرد/.test(text)));

    const result = close(db, 1404);
    assert.equal(result.profit, 70_000_000);
    assert.deepEqual(Object.keys(result.documents).sort(), ['closing', 'opening', 'temporary']);
    assert.deepEqual(result.lockedPeriods.length, 12);

    // سند موقت: درآمد و هزینه (با مرکز هزینه‌شان) صفر، ۷۰ میلیون بستانکار انباشته.
    const temporary = entryLines(db, result.documents.temporary.id);
    const retainedId = db.prepare("SELECT la.id FROM ledger_accounts la JOIN chart_accounts ca ON ca.id=la.chart_account_id WHERE ca.role='retained-earnings'").get().id;
    assert.deepEqual(temporary.find((line) => line.accountId === retainedId), { accountId: retainedId, analyticId: null, costCenterId: null, debit: 0, credit: 70_000_000 });
    assert.deepEqual(temporary.find((line) => line.accountId === byRole('sales')), { accountId: byRole('sales'), analyticId: null, costCenterId: 'cc-shop', debit: 100_000_000, credit: 0 });

    // اختتامیه: هر کلیدِ ماندهٔ دائمی صفر؛ افتتاحیه دقیقاً قرینهٔ آن، با تفصیلی.
    const closing = entryLines(db, result.documents.closing.id);
    const opening = entryLines(db, result.documents.opening.id);
    assert.deepEqual(opening, closing.map((line) => ({ ...line, debit: line.credit, credit: line.debit })));
    assert.deepEqual(opening.find((line) => line.accountId === byRole('receivable')), { accountId: byRole('receivable'), analyticId: 'an-karimi', costCenterId: null, debit: 50_000_000, credit: 0 });
    assert.deepEqual(opening.find((line) => line.accountId === retainedId).credit, 70_000_000);
    assert.ok(!opening.some((line) => [byRole('sales'), byRole('operating-expense')].includes(line.accountId)), 'حساب موقت در افتتاحیه نیست');

    // تاریخ و شماره: موقت و اختتامیه روز آخر ۱۴۰۴ و بعد از هر سند آن روز، افتتاحیه اول ۱۴۰۵.
    const kinds = db.prepare("SELECT y.role,j.occurred_at AS at,j.fiscal_year AS year,j.document_number AS number FROM year_close_entries y JOIN journal_entries j ON j.id=y.entry_id").all();
    const toDay = (iso) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA-u-ca-persian-nu-latn', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    assert.deepEqual(kinds.map((row) => [row.role, toDay(row.at), row.year]).sort(), [['closing', '1404-12-29', '1404'], ['opening', '1405-01-01', '1405'], ['temporary', '1404-12-29', '1404']]);
    assert.equal(kinds.find((row) => row.role === 'opening').number, 1);

    // گزارش‌های سال بسته عوض نشده‌اند.
    const sheet = reports.balanceSheetReport(db, { to: day(1404, 12, 29), timeZone: TZ });
    assert.equal(sheet.totals.difference, 0);
    assert.deepEqual([sheet.totals.assets, sheet.totals.equity, sheet.totals.currentYear], [before.sheet.totals.assets, before.sheet.totals.equity, 70_000_000]);
    assert.deepEqual(reports.incomeStatementReport(db, { from: day(1404, 1, 1), to: day(1404, 12, 29), timeZone: TZ }).totals, before.income.totals);
    assert.equal(reports.cashFlowReport(db, { from: day(1404, 1, 1), to: day(1404, 12, 29), timeZone: TZ }).net, before.flow.net);
    const centers = reports.costCenterReport(db, { from: day(1404, 1, 1), to: day(1404, 12, 29), timeZone: TZ });
    assert.equal(centers.totals.net, 70_000_000);
    const equity = reports.equityChangesReport(db, { from: day(1404, 1, 1), to: day(1404, 12, 29), timeZone: TZ });
    assert.deepEqual([equity.totals.closing, equity.periodProfit, equity.profit.transferred], [sheet.totals.equity, 70_000_000, -70_000_000]);

    // تراز سال بعد: ماندهٔ اول دوره = ماندهٔ پایان سال (یک بار، نه دو بار)؛ حساب موقت صفر.
    post(day(1405, 2, 1), [{ accountId: byRole('cash'), debit: 1_000_000, credit: 0 }, { accountId: byRole('sales'), debit: 0, credit: 1_000_000 }]);
    const next = reports.trialBalanceReport(db, { from: day(1405, 1, 1), to: day(1405, 12, 29), level: 'account', timeZone: TZ });
    assert.equal(next.balanced, true);
    const row = (id) => next.rows.find((item) => item.key === id);
    assert.equal(row(byRole('bank')).openingDebitBalance, 500_000_000 - 30_000_000 + 50_000_000);
    assert.equal(row(byRole('bank')).periodDebit, 0, 'افتتاحیه در گردش دوره نیست');
    assert.equal(row(retainedId).openingCreditBalance, 70_000_000);
    assert.deepEqual([row(byRole('sales')).openingCreditBalance, row(byRole('sales')).closingCreditBalance], [0, 1_000_000]);
    const nextSheet = reports.balanceSheetReport(db, { to: day(1405, 2, 1), timeZone: TZ });
    assert.deepEqual([nextSheet.totals.difference, nextSheet.totals.retained, nextSheet.totals.currentYear], [0, 70_000_000, 1_000_000]);
    // تراز قبل از بستن: درآمد و هزینهٔ سال در روز آخر دیده می‌شوند.
    const beforeClose = reports.trialBalanceReport(db, { from: day(1404, 1, 1), to: day(1404, 12, 29), level: 'account', beforeClose: true, timeZone: TZ });
    assert.equal(beforeClose.rows.find((item) => item.key === byRole('sales')).closingCreditBalance, 100_000_000);
    const afterClose = reports.trialBalanceReport(db, { from: day(1404, 1, 1), to: day(1404, 12, 29), level: 'account', timeZone: TZ });
    assert.equal(afterClose.rows.find((item) => item.key === byRole('sales')).closingCreditBalance, 0);
    // کارت حساب بانک در سال بعد با ماندهٔ اول درست شروع می‌شود.
    const card = reports.accountLedgerReport(db, { from: day(1405, 1, 1), to: day(1405, 12, 29), level: 'account', key: byRole('bank'), timeZone: TZ });
    assert.deepEqual([card.opening, card.rows.length], [520_000_000, 0]);

    // دفتر روزنامه سه سند را نشان می‌دهد؛ گردش تراز = جمع روزنامه منهای اختتامیه و افتتاحیه.
    const journal = reports.journalBookReport(db, { from: day(1404, 1, 1), to: day(1405, 12, 29), timeZone: TZ });
    assert.deepEqual(journal.entries.filter((entry) => entry.yearCloseRole).map((entry) => entry.yearCloseRole), ['temporary', 'closing', 'opening']);
    const whole = reports.trialBalanceReport(db, { from: day(1404, 1, 1), to: day(1405, 12, 29), level: 'account', timeZone: TZ });
    assert.equal(journal.totals.debit - journal.yearCloseTotals.debit, whole.totals.periodDebit);
    assert.deepEqual(journal.unbalanced, []);

    // سال بسته قفل است: ثبت در آن رد می‌شود؛ بستن دوباره هم.
    assert.throws(() => post(day(1404, 11, 1), [{ accountId: byRole('cash'), debit: 1, credit: 0 }, { accountId: byRole('sales'), debit: 0, credit: 1 }]), { code: 'ACCOUNTING_PERIOD_LOCKED' });
    assert.ok(blockerCodes(db, 1404).includes('FISCAL_YEAR_ALREADY_CLOSED'));
    assert.throws(() => close(db, 1404), { code: 'FISCAL_YEAR_ALREADY_CLOSED' });
  });
});

test('سال زیان‌ده: انباشته بدهکار می‌شود و افتتاحیه زیان را می‌آورد', async () => {
  await ledger('yc-loss', (book) => {
    businessYear(book, 1404, { revenue: 20_000_000, expense: 50_000_000 });
    const result = close(book.db, 1404);
    assert.equal(result.profit, -30_000_000);
    const retainedId = book.db.prepare("SELECT la.id FROM ledger_accounts la JOIN chart_accounts ca ON ca.id=la.chart_account_id WHERE ca.role='retained-earnings'").get().id;
    assert.equal(entryLines(book.db, result.documents.temporary.id).find((line) => line.accountId === retainedId).debit, 30_000_000);
    assert.equal(entryLines(book.db, result.documents.opening.id).find((line) => line.accountId === retainedId).debit, 30_000_000);
    const sheet = reports.balanceSheetReport(book.db, { to: day(1405, 1, 10), timeZone: TZ });
    assert.deepEqual([sheet.totals.difference, sheet.totals.retained], [0, -30_000_000]);
  });
});

test('سال کبیسه و آخرین ساعت سال: ۳۰ اسفند ۱۴۰۳، سند ۲۳:۳۰ پیش از سند موقت', async () => {
  await ledger('yc-leap', ({ db, byRole, post }) => {
    const lastDay = new Date(Date.parse(day(1403, 12, 30)));
    const late = new Date(Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), lastDay.getUTCDate(), 20, 0)).toISOString();
    post(late, [{ accountId: byRole('cash'), debit: 9_000_000, credit: 0 }, { accountId: byRole('sales'), debit: 0, credit: 9_000_000 }]);
    const bounds = accounting.fiscalYearBounds(1403, TZ);
    assert.equal(bounds.lastDay, '1403-12-30');
    assert.ok(bounds.temporaryAt > late);
    const result = close(db, 1403);
    assert.equal(result.profit, 9_000_000);
    const income = reports.incomeStatementReport(db, { from: day(1403, 1, 1), to: day(1403, 12, 30), timeZone: TZ });
    assert.equal(income.totals.revenue, 9_000_000);
  });
});

test('مانع‌ها: پیش‌نویس، سال قبلِ باز، سال خالی، ثبت بی‌سند و دورهٔ قفلِ سال بعد', async () => {
  await ledger('yc-blockers', (book) => {
    const { db, byRole, post } = book;
    assert.deepEqual(blockerCodes(db, 1404), ['FISCAL_YEAR_EMPTY']);
    businessYear(book, 1403);
    businessYear(book, 1404);
    post(day(1404, 8, 1), [{ accountId: byRole('cash'), debit: 1_000, credit: 0 }, { accountId: byRole('sales'), debit: 0, credit: 1_000 }], { approvalState: 'draft' });
    const codes = blockerCodes(db, 1404);
    assert.ok(codes.includes('FISCAL_YEAR_UNAPPROVED_ENTRIES'), codes.join());
    assert.ok(codes.includes('FISCAL_YEAR_PREVIOUS_OPEN'), codes.join());
    // مانع کل کار را پیش از هر ثبتی متوقف می‌کند.
    assert.throws(() => close(db, 1404), { code: 'FISCAL_YEAR_UNAPPROVED_ENTRIES' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM year_close_entries').get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_periods WHERE status='locked'").get().n, 0);
    // ۱۴۰۳ بسته می‌شود؛ ۱۴۰۴ فقط پیش‌نویس را مانع دارد.
    close(db, 1403);
    assert.deepEqual(blockerCodes(db, 1404), ['FISCAL_YEAR_UNAPPROVED_ENTRIES']);
    // ثبت روزانه‌ای که هنوز سند ندارد.
    db.prepare("INSERT INTO transactions (id,type,amount,category,raw_text,account_id,occurred_at,status,journal_deferred) VALUES ('t-deferred','expense',5000,'سایر','خرید','cash',?,'confirmed',1)").run(day(1405, 3, 1));
    assert.ok(blockerCodes(db, 1405).includes('FISCAL_YEAR_DEFERRED_TRANSACTIONS'));
    // دورهٔ اول سال بعد قفل است: افتتاحیه جایی ندارد.
    accounting.lockAccountingPeriod(db, '1406-01', owner.id);
    assert.ok(blockerCodes(db, 1405).includes('NEXT_PERIOD_LOCKED'));
    assert.throws(() => preview(db, 99), { code: 'FISCAL_YEAR_INVALID' });
  });
});

test('کدینگ واردشده بی‌حساب «سود انباشته»: بستن متوقف می‌شود تا حسابدار معین را انتخاب کند', async () => {
  await ledger('yc-custom-chart', ({ db, post }) => {
    accounting.ensureAccountingSchema(db);
    const chart = [
      ['1', 'دارایی‌ها', 'group', '', 'asset', ''], ['11', 'نقد', 'general', '1', 'asset', ''], ['1101', 'بانک ملت', 'subsidiary', '11', 'asset', 'bank'],
      ['5', 'حقوق صاحبان سهام', 'group', '', 'equity', ''], ['51', 'سرمایه', 'general', '5', 'equity', ''], ['5101', 'سرمایه ثبت‌شده', 'subsidiary', '51', 'equity', ''], ['5102', 'اندوختهٔ قانونی', 'subsidiary', '51', 'equity', ''],
      ['6', 'درآمد', 'group', '', 'income', ''], ['61', 'فروش', 'general', '6', 'income', ''], ['6101', 'فروش کالا', 'subsidiary', '61', 'income', 'sales'],
    ].map(([code, name, level, parentCode, type, role]) => ({ code, name, level, parentCode, type, role }));
    chartOfAccounts.importChartOfAccounts(db, chart, { source: 'import' });
    const ledgerFor = (code, type) => {
      const chartId = db.prepare('SELECT id FROM chart_accounts WHERE code=?').get(code).id;
      const id = `la-${code}`;
      db.prepare("INSERT INTO ledger_accounts (id,code,name,type,normal_side,source_kind,source_key,chart_account_id) VALUES (?,?,?,?,?,'chart-account',?,?)")
        .run(id, `9${code}`, code, type, ['asset', 'expense'].includes(type) ? 'debit' : 'credit', code, chartId);
      return id;
    };
    const bank = ledgerFor('1101', 'asset');
    const sales = ledgerFor('6101', 'income');
    post(day(1404, 4, 1), [{ accountId: bank, debit: 8_000_000, credit: 0 }, { accountId: sales, debit: 0, credit: 8_000_000 }]);
    const plan = preview(db, 1404);
    assert.deepEqual(plan.blockers.map((item) => item.code), ['RETAINED_ACCOUNT_REQUIRED']);
    assert.deepEqual(plan.retainedCandidates.map((item) => item.code), ['5101', '5102']);
    assert.throws(() => close(db, 1404), { code: 'RETAINED_ACCOUNT_REQUIRED' });
    // حدس نه: اندوخته یا سرمایه را خودش انتخاب نمی‌کند. حسابدار انتخاب می‌کند.
    assert.throws(() => close(db, 1404, { retainedChartAccountId: 'nope' }), { code: 'RETAINED_ACCOUNT_INVALID' });
    const chosen = db.prepare("SELECT id FROM chart_accounts WHERE code='5101'").get().id;
    const result = close(db, 1404, { retainedChartAccountId: chosen });
    assert.equal(result.profit, 8_000_000);
    const retainedLine = entryLines(db, result.documents.temporary.id).find((line) => line.credit === 8_000_000);
    assert.equal(db.prepare('SELECT c.code FROM ledger_accounts l JOIN chart_accounts c ON c.id=l.chart_account_id WHERE l.id=?').get(retainedLine.accountId).code, '5101');
  }, { template: false });
});

test('حساب و تفصیلی غیرفعالِ مانده‌دار هم به سال بعد می‌رود', async () => {
  await ledger('yc-inactive', (book) => {
    const { db, byRole } = book;
    businessYear(book, 1404);
    db.prepare("UPDATE analytic_accounts SET active=0 WHERE id='an-karimi'").run();
    db.prepare('UPDATE ledger_accounts SET active=0 WHERE id=?').run(byRole('receivable'));
    const result = close(db, 1404);
    const line = entryLines(db, result.documents.opening.id).find((item) => item.accountId === byRole('receivable'));
    assert.deepEqual([line.analyticId, line.debit], ['an-karimi', 50_000_000]);
  });
});

test('بازگشایی: سند معکوس (نه حذف)، دوره‌ها باز، گزارش‌ها مثل پیش از بستن؛ بستن دوباره با بازنگری تازه', async () => {
  await ledger('yc-reopen', (book) => {
    const { db, byRole, post } = book;
    businessYear(book, 1403);
    close(db, 1403);
    businessYear(book, 1404);
    close(db, 1404);
    // بازگشایی ۱۴۰۳ وقتی ۱۴۰۴ بسته است ممنوع؛ دلیل کوتاه هم.
    assert.throws(() => accounting.reopenFiscalYear(db, 1403, { userId: owner.id, reason: 'اصلاح سند اسفند ۱۴۰۳', timeZone: TZ }), { code: 'LATER_YEAR_CLOSED' });
    assert.throws(() => accounting.reopenFiscalYear(db, 1404, { userId: owner.id, reason: 'کوتاه', timeZone: TZ }), { code: 'REOPEN_REASON_REQUIRED' });

    const entriesBefore = db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
    const result = accounting.reopenFiscalYear(db, 1404, { userId: owner.id, reason: 'ثبت ذخیرهٔ مالیات عملکرد جاافتاده', timeZone: TZ });
    assert.deepEqual(result.reversals.map((item) => item.role), ['opening', 'closing', 'temporary']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, entriesBefore + 3, 'هیچ سندی حذف نشد');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_periods WHERE period LIKE '1404-%' AND status='locked'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounting_periods WHERE period LIKE '1403-%' AND status='locked'").get().n, 12);

    // سود ۱۴۰۴ دوباره روی حساب‌های موقت است؛ ترازنامه همان.
    const trial = reports.trialBalanceReport(db, { from: day(1404, 1, 1), to: day(1404, 12, 29), level: 'account', timeZone: TZ });
    assert.equal(trial.rows.find((item) => item.key === byRole('sales')).closingCreditBalance, 100_000_000);
    const sheet = reports.balanceSheetReport(db, { to: day(1404, 12, 29), timeZone: TZ });
    assert.deepEqual([sheet.totals.difference, sheet.totals.retained, sheet.totals.currentYear], [0, 70_000_000, 70_000_000]);

    // ذخیرهٔ مالیات ثبت و سال دوباره بسته می‌شود.
    post(day(1404, 12, 29), [{ accountId: byRole('operating-expense'), debit: 10_000_000, credit: 0 }, { accountId: byRole('payable'), debit: 0, credit: 10_000_000 }]);
    const again = close(db, 1404);
    assert.equal(again.profit, 60_000_000);
    assert.equal(db.prepare("SELECT MAX(revision) AS r FROM journal_entries WHERE source_type='year-close' AND source_id='1404:temporary'").get().r, 3);
    const next = reports.trialBalanceReport(db, { from: day(1405, 1, 1), to: day(1405, 6, 1), level: 'account', timeZone: TZ });
    assert.equal(next.balanced, true);
    const retainedId = db.prepare("SELECT la.id FROM ledger_accounts la JOIN chart_accounts ca ON ca.id=la.chart_account_id WHERE ca.role='retained-earnings'").get().id;
    assert.equal(next.rows.find((item) => item.key === retainedId).openingCreditBalance, 130_000_000);
    assert.deepEqual(accounting.fiscalYearClosings(db).map((item) => [item.year, item.status]).sort(), [['1403', 'closed'], ['1404', 'closed'], ['1404', 'reopened']]);
  });
});

/** همان شکل ورود بکاپ: سند پیش‌نویس، ثبت‌شده در `parsian_imported_entries`، بعد تأیید. */
function importLike(db, documents, sha = 'sha-yc') {
  const created = accounting.createJournalBatch(db, documents.map(([date, lines, memo]) => ({ occurredAt: date, memo: memo || '[بکاپ پارسیان] سند', lines })), { createdBy: owner.id, timeZone: TZ });
  accounting.ensureParsianSourceSchema(db);
  created.entryIds.forEach((id, index) => db.prepare('INSERT INTO parsian_imported_entries (entry_id,sanad,file_sha256) VALUES (?,?,?)').run(id, index + 1, sha));
  db.prepare(`UPDATE journal_entries SET approval_state='approved' WHERE id IN (${created.entryIds.map(() => '?').join(',')})`).run(...created.entryIds);
  return created.entryIds;
}

test('اختتامیه و افتتاحیهٔ پارسیان از بکاپ: تشخیص دقیق، جای سند ما را می‌گیرند، مانده دو بار شمرده نمی‌شود', async () => {
  await ledger('yc-parsian', ({ db, byRole }) => {
    const [bank, capital, sales, expense, retained] = ['bank', 'owner-capital', 'sales', 'operating-expense', 'retained-earnings'].map(byRole);
    const ids = importLike(db, [
      [day(1403, 1, 1), [{ accountId: bank, debit: 100, credit: 0 }, { accountId: capital, debit: 0, credit: 100 }], 'افتتاحیه ۱۴۰۳'],
      [day(1403, 5, 1), [{ accountId: bank, debit: 40, credit: 0 }, { accountId: sales, debit: 0, credit: 40 }]],
      [day(1403, 7, 1), [{ accountId: expense, debit: 15, credit: 0 }, { accountId: bank, debit: 0, credit: 15 }]],
      // روز آخر: یک سند عادی، بستن موقت پارسیان، اختتامیهٔ پارسیان.
      [day(1403, 12, 30), [{ accountId: expense, debit: 5, credit: 0 }, { accountId: bank, debit: 0, credit: 5 }]],
      [day(1403, 12, 30), [{ accountId: sales, debit: 40, credit: 0 }, { accountId: expense, debit: 0, credit: 20 }, { accountId: retained, debit: 0, credit: 20 }]],
      [day(1403, 12, 30), [{ accountId: capital, debit: 100, credit: 0 }, { accountId: retained, debit: 20, credit: 0 }, { accountId: bank, debit: 0, credit: 120 }]],
      [day(1404, 1, 1), [{ accountId: bank, debit: 120, credit: 0 }, { accountId: capital, debit: 0, credit: 100 }, { accountId: retained, debit: 0, credit: 20 }]],
      [day(1404, 2, 1), [{ accountId: bank, debit: 7, credit: 0 }, { accountId: sales, debit: 0, credit: 7 }]],
    ]);
    // پیش از ثبت نقش: ترازنامهٔ روز آخر ۱۴۰۳ صفر است؛ همین ایراد بود.
    assert.equal(reports.balanceSheetReport(db, { to: day(1403, 12, 30), timeZone: TZ }).totals.assets, 0);

    const plan = preview(db, 1403);
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual([plan.imported.temporary.map((entry) => entry.id), plan.imported.closing?.id, plan.imported.opening?.id], [[ids[4]], ids[5], ids[6]]);
    assert.ok(plan.reminders.some((text) => /اختتامیهٔ همین سال/.test(text)));
    const result = close(db, 1403);
    assert.deepEqual(result.documents, {}, 'هیچ سند تازه‌ای لازم نبود');
    assert.deepEqual(db.prepare('SELECT entry_id AS id,role,origin FROM year_close_entries ORDER BY role').all().map((row) => ({ ...row })), [
      { id: ids[5], role: 'closing', origin: 'parsian' }, { id: ids[6], role: 'opening', origin: 'parsian' }]);
    // بستن موقت در سطح آرتیکل: هر سه آرتیکل سند ۵.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM year_close_lines WHERE entry_id=?').get(ids[4]).n, 3);

    const sheet = reports.balanceSheetReport(db, { to: day(1403, 12, 30), timeZone: TZ });
    assert.deepEqual([sheet.totals.assets, sheet.totals.difference, sheet.totals.currentYear], [120, 0, 20]);
    assert.equal(reports.incomeStatementReport(db, { from: day(1403, 1, 1), to: day(1403, 12, 30), timeZone: TZ }).totals.netProfit, 20);
    const next = reports.trialBalanceReport(db, { from: day(1404, 1, 1), to: day(1404, 12, 29), level: 'account', timeZone: TZ });
    assert.equal(next.rows.find((row) => row.key === bank).openingDebitBalance, 120, 'افتتاحیهٔ پارسیان دو بار شمرده نشد');
    assert.equal(next.rows.find((row) => row.key === bank).closingDebitBalance, 127);
    assert.equal(reports.balanceSheetReport(db, { to: day(1404, 2, 1), timeZone: TZ }).totals.difference, 0);

    // بازگشایی: سند پارسیان حذف یا معکوس نمی‌شود، فقط از نقش بیرون می‌آید.
    const reopened = accounting.reopenFiscalYear(db, 1403, { userId: owner.id, reason: 'بررسی دوبارهٔ بکاپ پارسیان', timeZone: TZ });
    assert.deepEqual([reopened.reversals.length, reopened.releasedImported], [0, 2]);
    // برچسب بستن موقت به بستن سال بسته نیست و می‌ماند: سود ۱۴۰۳ همان ۲۰ است.
    assert.equal(reports.incomeStatementReport(db, { from: day(1403, 1, 1), to: day(1403, 12, 30), timeZone: TZ }).totals.netProfit, 20);
  });
});

test('سندی که فقط شبیه اختتامیه است اختتامیه شمرده نمی‌شود', async () => {
  await ledger('yc-parsian-lookalike', ({ db, byRole }) => {
    const [bank, capital, sales] = ['bank', 'owner-capital', 'sales'].map(byRole);
    importLike(db, [
      [day(1403, 1, 1), [{ accountId: bank, debit: 100, credit: 0 }, { accountId: capital, debit: 0, credit: 100 }]],
      [day(1403, 5, 1), [{ accountId: bank, debit: 40, credit: 0 }, { accountId: sales, debit: 0, credit: 40 }]],
      // روز آخر، شرح «اختتامیه»، ولی بانک را صفر نمی‌کند: سند عادی می‌ماند.
      [day(1403, 12, 30), [{ accountId: capital, debit: 100, credit: 0 }, { accountId: bank, debit: 0, credit: 100 }], 'اختتامیه'],
    ]);
    const plan = preview(db, 1403);
    assert.deepEqual([plan.imported.closing, plan.imported.temporary, plan.imported.opening], [null, [], null]);
    const result = close(db, 1403);
    assert.deepEqual(Object.keys(result.documents).sort(), ['closing', 'opening', 'temporary']);
  });
});

test('هر سند بستن نقش دارد؛ همان نقش است که فایل انتقال و خلاصهٔ روز با آن کنارش می‌گذارند', async () => {
  await ledger('yc-consumers', (book) => {
    const { db, byRole, post } = book;
    post(day(1404, 12, 29), [{ accountId: byRole('cash'), debit: 3_000_000, credit: 0 }, { accountId: byRole('sales'), debit: 0, credit: 3_000_000 }]);
    close(db, 1404);
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM journal_entries WHERE source_type='year-close'
      AND NOT EXISTS (SELECT 1 FROM year_close_entries y WHERE y.entry_id=journal_entries.id)`).get().n;
    assert.equal(rows, 0, 'هر سند بستن نقش دارد و فیلتر انتقال آن را می‌شناسد');
  });
});

test('دسترسی: بستن و بازگشایی سال فقط مالک', async () => {
  const { minimumRoleForRequest: requiredRankForApi } = await import('../server/access.js');
  assert.equal(requiredRankForApi('POST', '/accounting/year-close/1404/close'), 'owner');
  assert.equal(requiredRankForApi('POST', '/accounting/year-close/1404/reopen'), 'owner');
  assert.equal(requiredRankForApi('GET', '/accounting/year-close/1404'), 'viewer');
});

// ---------------------------------------------------------------------------
// قانون‌های میان گزارش‌ها، بعد از بستن سال، روی دفتر تصادفی
// ---------------------------------------------------------------------------

function rng(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}
const RANDOM_ROLES = ['cash', 'bank', 'receivable', 'payable', 'inventory', 'sales', 'cogs', 'operating-expense', 'fixed-asset',
  'accumulated-depreciation', 'loan-payable', 'owner-capital', 'other-income', 'input-tax', 'output-tax'];

for (const seed of [7, 61, 409]) {
  test(`بستن ۱۴۰۴ روی دفتر تصادفی: هیچ قانونی نمی‌شکند و هیچ عددی از سال بسته عوض نمی‌شود (بذر ${seed})`, async () => {
    await ledger(`yc-random-${seed}`, ({ db, byRole, post }) => {
      const random = rng(seed);
      const accounts = RANDOM_ROLES.map(byRole);
      const analytics = ['الف', 'ب'].map((name, index) => {
        const id = `yr-${seed}-${index}`;
        db.prepare('INSERT INTO analytic_accounts (id,code,name,kind,source_kind,source_key,active) VALUES (?,?,?,?,?,?,1)').run(id, `8${seed}${index}`, name, 'contact', 'contact', id);
        return id;
      });
      const center = `yc-cc-${seed}`;
      db.prepare('INSERT INTO cost_centers (id,code,name,active) VALUES (?,?,?,1)').run(center, `7${seed}`, 'مرکز');
      for (let index = 0; index < 40; index += 1) {
        const year = random() < 0.6 ? 1404 : 1405;
        const amount = 1_000 + Math.floor(random() * 9_000_000);
        const pick = () => accounts[Math.floor(random() * accounts.length)];
        const extras = () => ({ analyticId: random() < 0.3 ? analytics[Math.floor(random() * 2)] : null, costCenterId: random() < 0.3 ? center : null });
        post(day(year, 1 + Math.floor(random() * 12), 1 + Math.floor(random() * 28)), [{ accountId: pick(), debit: amount, credit: 0, ...extras() }, { accountId: pick(), debit: 0, credit: amount, ...extras() }]);
      }
      const yearEnd = day(1404, 12, 29);
      const snapshot = () => ({
        sheet: reports.balanceSheetReport(db, { to: yearEnd, timeZone: TZ }).totals,
        income: reports.incomeStatementReport(db, { from: day(1404, 1, 1), to: yearEnd, timeZone: TZ }).totals,
        flow: reports.cashFlowReport(db, { from: day(1404, 1, 1), to: yearEnd, timeZone: TZ }).net,
        nextSheet: reports.balanceSheetReport(db, { to: day(1405, 12, 29), timeZone: TZ }).totals,
        nextIncome: reports.incomeStatementReport(db, { from: day(1405, 1, 1), to: day(1405, 12, 29), timeZone: TZ }).totals,
        nextFlow: reports.cashFlowReport(db, { from: day(1405, 1, 1), to: day(1405, 12, 29), timeZone: TZ }),
      });
      const before = snapshot();
      const result = close(db, 1404);
      assert.equal(result.profit, before.income.netProfit);
      const after = snapshot();
      assert.deepEqual(after.sheet, before.sheet, 'ترازنامهٔ روز آخر سال بسته');
      assert.deepEqual(after.income, before.income);
      assert.equal(after.flow, before.flow);
      assert.deepEqual(after.nextIncome, before.nextIncome);
      assert.deepEqual([after.nextFlow.opening, after.nextFlow.net, after.nextFlow.reconciled], [before.nextFlow.opening, before.nextFlow.net, true]);
      assert.equal(after.nextSheet.difference, 0);
      assert.equal(after.nextSheet.equity, before.nextSheet.equity);

      // تراز سال بعد: متوازن؛ ماندهٔ اول = ماندهٔ پایان سال بسته (بعد از سند موقت)؛ درآمد و هزینه صفر.
      const closed = reports.trialBalanceReport(db, { to: yearEnd, level: 'analytic', timeZone: TZ });
      const next = reports.trialBalanceReport(db, { from: day(1405, 1, 1), to: day(1405, 12, 29), level: 'account', timeZone: TZ });
      assert.equal(next.balanced, true);
      for (const row of next.rows) {
        if (['income', 'expense'].includes(row.type)) assert.equal(row.openingDebitBalance + row.openingCreditBalance, 0, row.name);
      }
      const openingEntry = result.documents.opening;
      if (openingEntry) {
        // افتتاحیه، کلید به کلید، همان ماندهٔ پایان سال بسته در سطح تفصیلی است.
        const byAnalytic = new Map();
        for (const line of entryLines(db, openingEntry.id)) byAnalytic.set(line.analyticId || 'none', (byAnalytic.get(line.analyticId || 'none') || 0) + line.debit - line.credit);
        for (const row of closed.rows) assert.equal(byAnalytic.get(row.key) || 0, row.closingNet, `تفصیلی ${row.name}`);
      }
      // کارت هر حساب در سال بعد = تراز.
      for (const row of next.rows) {
        const card = reports.accountLedgerReport(db, { from: day(1405, 1, 1), to: day(1405, 12, 29), level: 'account', key: row.key, timeZone: TZ });
        assert.equal(card.closing, row.closingNet, row.name);
      }
      const equity = reports.equityChangesReport(db, { from: day(1405, 1, 1), to: day(1405, 12, 29), timeZone: TZ });
      assert.equal(equity.totals.closing, after.nextSheet.equity);
      assert.equal(reports.ledgerControlsReport(db, { to: day(1405, 12, 29), timeZone: TZ }).balanced, true);
    });
  });
}

// ---------------------------------------------------------------------------
// بستن موقتِ پارسیان در چند سند و قاطی بهای تمام‌شدهٔ ادواری — شکل بکاپ واقعی ۱۴۰۳
// (دفتر «آزمون بکاپ ریالی»، ۷ آبان ۱۴۰۵: سود و زیان ۱۴۰۳ روی سایت صفر بود). عددها ساختگی‌اند.
// ---------------------------------------------------------------------------

test('بستن موقتِ پارسیان در دو سند، یکی قاطی بهای تمام‌شده: فقط آرتیکل‌های بستن از سود و زیان بیرون می‌روند', async () => {
  await ledger('yc-parsian-split-close', ({ db, byRole }) => {
    const [bank, inventory, capital, retained, sales, cogs, opex, otherIncome] = ['bank', 'inventory', 'owner-capital', 'retained-earnings', 'sales', 'cogs', 'operating-expense', 'other-income'].map(byRole);
    const purchases = accounting.categoryLedgerAccount(db, 'expense', 'خرید');
    const ids = importLike(db, [
      [day(1403, 1, 1), [{ accountId: bank, debit: 1000, credit: 0 }, { accountId: capital, debit: 0, credit: 1000 }]],
      [day(1403, 3, 1), [{ accountId: purchases, debit: 600, credit: 0 }, { accountId: bank, debit: 0, credit: 600 }]],
      [day(1403, 6, 1), [{ accountId: bank, debit: 900, credit: 0 }, { accountId: sales, debit: 0, credit: 900 }]],
      [day(1403, 9, 1), [{ accountId: opex, debit: 100, credit: 0 }, { accountId: bank, debit: 0, credit: 100 }]],
      // میانهٔ سال، درآمد به حقوق صاحبان سهام: ماه آخر نیست، بستن نیست.
      [day(1403, 6, 15), [{ accountId: sales, debit: 10, credit: 0 }, { accountId: capital, debit: 0, credit: 10 }]],
      // ۲۹ اسفند، «بستن حساب موقت»: هزینه‌ها.
      [day(1403, 12, 29), [{ accountId: retained, debit: 100, credit: 0 }, { accountId: opex, debit: 0, credit: 100 }], 'بستن حساب موقت'],
      // ۳۰ اسفند، «بهای تمام‌شده»: خرید ← موجودی و بهای تمام‌شده، و همان‌جا فروش و بهای تمام‌شده به انباشته.
      [day(1403, 12, 30), [
        { accountId: purchases, debit: 0, credit: 600 }, { accountId: inventory, debit: 200, credit: 0 }, { accountId: cogs, debit: 400, credit: 0 },
        { accountId: sales, debit: 900, credit: 0 }, { accountId: cogs, debit: 0, credit: 400 },
        { accountId: retained, debit: 0, credit: 900 }, { accountId: retained, debit: 400, credit: 0 },
      ], 'بهای تمام شده'],
      // ماه آخر ولی دو ترکیب می‌خوانند (فروش یا سایر درآمد): حدس نه، سند عادی می‌ماند.
      [day(1403, 12, 20), [{ accountId: sales, debit: 7, credit: 0 }, { accountId: otherIncome, debit: 7, credit: 0 }, { accountId: capital, debit: 0, credit: 7 }, { accountId: bank, debit: 0, credit: 7 }]],
    ]);
    const range = { from: day(1403, 1, 1), to: day(1403, 12, 30), timeZone: TZ };
    // بی‌بستن سال: سود و زیان درست است، نه صفر.
    const income = reports.incomeStatementReport(db, range).totals;
    assert.deepEqual([income.revenue, income.costOfSales, income.otherIncome], [900 - 10 - 7, 400, -7]);
    const tagged = db.prepare('SELECT entry_id AS id,COUNT(*) AS n FROM year_close_lines GROUP BY entry_id').all().map((row) => [row.id, row.n]);
    assert.deepEqual(new Map(tagged), new Map([[ids[5], 2], [ids[6], 4]]), 'سند ۶ دو آرتیکل، سند ۷ فقط فروش، بهای تمام‌شدهٔ بستانکار و دو آرتیکل انباشته');
    // بهای تمام‌شده و خریدِ محاسبهٔ ادواری در سود و زیان مانده‌اند: خرید خالص صفر، هزینهٔ عملیاتی ۱۰۰.
    assert.equal(income.expenses, 100);
    assert.equal(income.netProfit, 900 - 10 - 7 - 400 - 100 - 7);
    const sheet = reports.balanceSheetReport(db, { to: range.to, timeZone: TZ });
    assert.deepEqual([sheet.totals.difference, sheet.totals.currentYear], [0, income.netProfit]);
    const centers = reports.costCenterReport(db, range);
    assert.equal(centers.totals.net, income.netProfit);

    // بستن سال: سود موقت صفر (پارسیان بسته)، یادآوری سندها، و سود و زیان همان.
    const plan = preview(db, 1403);
    assert.deepEqual(plan.imported.temporary.map((entry) => entry.id), [ids[5], ids[6]]);
    assert.ok(plan.reminders.some((text) => /بستن حساب‌های موقت در سند/.test(text)), plan.reminders.join());
    close(db, 1403);
    assert.equal(reports.incomeStatementReport(db, range).totals.netProfit, income.netProfit);
    assert.equal(reports.balanceSheetReport(db, { to: day(1404, 1, 10), timeZone: TZ }).totals.difference, 0);
  });
});

test('سال مالی دیگر: بستن پارسیان در اسفند وقتی سال مالی تا شهریور است، بستن نیست؛ برگشت به فروردین دوباره برچسب می‌زند', async () => {
  await ledger('yc-parsian-rescan', ({ db, byRole }) => {
    const [bank, retained, sales] = ['bank', 'retained-earnings', 'sales'].map(byRole);
    importLike(db, [
      [day(1403, 5, 1), [{ accountId: bank, debit: 50, credit: 0 }, { accountId: sales, debit: 0, credit: 50 }]],
      [day(1403, 12, 30), [{ accountId: sales, debit: 50, credit: 0 }, { accountId: retained, debit: 0, credit: 50 }]],
    ]);
    const revenue = () => reports.incomeStatementReport(db, { from: day(1403, 1, 1), to: day(1403, 12, 30), timeZone: TZ }).totals.revenue;
    assert.equal(revenue(), 50);
    accounting.setFiscalYearStartMonth(db, 7, { timeZone: TZ });
    assert.equal(revenue(), 0, 'اسفند ماه آخر سال مالی نیست؛ سند عادی است');
    accounting.setFiscalYearStartMonth(db, 1, { timeZone: TZ });
    assert.equal(revenue(), 50);
  });
});
