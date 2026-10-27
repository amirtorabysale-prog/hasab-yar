import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { persianToISO } from '../shared/persianDate.js';

/**
 * گزارش‌های حسابداری — قانون‌هایی که میان گزارش‌ها برقرارند، روی دفترهای تصادفی.
 *
 * هر گزارش جدا هم می‌تواند غلط باشد و هم به‌ظاهر درست؛ ولی این‌ها با هم فقط وقتی
 * می‌خوانند که هر کدام درست باشد:
 *   تراز در هر سطح متوازن است و جمعِ همهٔ سطح‌ها یکی است؛
 *   ماندهٔ اول دوره + گردش دوره = ماندهٔ پایان، و همان ماندهٔ تراز بی‌بازه؛
 *   ترازنامه می‌خواند و سود سال جاری‌اش همان سود خالص صورت سود و زیان است؛
 *   موجودی نقد اول + جریان خالص = موجودی نقد پایان = نقدِ ترازنامه؛
 *   جمع حقوق مالکانهٔ صورت تغییرات = حقوق مالکانهٔ ترازنامه؛
 *   ماندهٔ پایان کارت هر حساب = ماندهٔ همان حساب در تراز؛
 *   جمع دفتر روزنامه = گردش دورهٔ تراز؛ خالص مراکز هزینه = سود خالص.
 *
 * مولّد تصادفی با بذر ثابت است تا هر شکست دقیقاً تکرار شود.
 */

const databasePath = tempDatabase('accounting-reports');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'reports-owner';
process.env.ADMIN_PASSWORD = 'reports-strong-password-5511';
const database = await import('../server/db.js');
const accounting = await import('../server/accounting.js');
const reports = await import('../server/accounting/reports.js');
database.ensureAdmin();
const owner = database.authenticateUser('reports-owner', 'reports-strong-password-5511');
test.after(() => removeTempDatabase(databasePath));

const TZ = 'Asia/Tehran';
const day = (y, m, d) => persianToISO(y, m, d, TZ);

function rng(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

let seq = 0;
async function ledger(name, build) {
  const workspace = database.createWorkspace(owner.id, { name, profileType: 'business' });
  return database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, async () => {
    database.installChartTemplate();
    const db = database.activeWorkspaceDatabase();
    const byRole = (role) => db.prepare(`SELECT la.id FROM ledger_accounts la JOIN chart_accounts ca ON ca.id=la.chart_account_id WHERE ca.role=? ORDER BY la.code LIMIT 1`).get(role).id;
    const post = (occurredAt, lines, extra = {}) => accounting.postJournalEntry(db, { sourceType: 'report-test', sourceId: `e${seq += 1}`, occurredAt, memo: extra.memo || `سند ${seq}`, lines, approvalState: extra.approvalState, entryKind: extra.entryKind }, { timeZone: TZ });
    return build({ db, byRole, post });
  });
}

const ROLES = ['cash', 'bank', 'receivable', 'payable', 'inventory', 'sales', 'cogs', 'operating-expense', 'fixed-asset',
  'accumulated-depreciation', 'loan-payable', 'owner-capital', 'other-income', 'input-tax', 'output-tax', 'prepaid-asset'];

/** دفتر تصادفی: سندهای متوازن دو تا چهار سطری در دو سال شمسی، با تفصیلی و مرکز هزینه. */
function randomLedger({ db, byRole, post }, seed) {
  const random = rng(seed);
  const accounts = ROLES.map(byRole);
  const contactAnalytics = ['کریمی', 'نوری', 'شرکت آلفا'].map((name, index) => {
    const id = `an-${seed}-${index}`;
    db.prepare('INSERT INTO analytic_accounts (id,code,name,kind,source_kind,source_key,active) VALUES (?,?,?,?,?,?,1)').run(id, `9${seed % 1000}${index}`, name, 'contact', 'contact', `c-${seed}-${index}`);
    return id;
  });
  const centers = ['10', '20'].map((code) => {
    const id = `cc-${seed}-${code}`;
    db.prepare('INSERT INTO cost_centers (id,code,name,active) VALUES (?,?,?,1)').run(id, `${seed % 1000}${code}`, `مرکز ${code}`);
    return id;
  });
  const count = 25 + Math.floor(random() * 25);
  for (let index = 0; index < count; index += 1) {
    const year = random() < 0.4 ? 1404 : 1405;
    const month = 1 + Math.floor(random() * 12);
    const date = day(year, month, 1 + Math.floor(random() * 28));
    const lines = [];
    const amount = 1_000 + Math.floor(random() * 5_000_000);
    const split = Math.floor(random() * amount);
    const pick = () => accounts[Math.floor(random() * accounts.length)];
    const extras = () => ({ analyticId: random() < 0.3 ? contactAnalytics[Math.floor(random() * 3)] : null, costCenterId: random() < 0.3 ? centers[Math.floor(random() * 2)] : null });
    lines.push({ accountId: pick(), debit: amount, credit: 0, ...extras() });
    if (split > 0 && random() < 0.5) {
      lines.push({ accountId: pick(), debit: 0, credit: split, ...extras() }, { accountId: pick(), debit: 0, credit: amount - split, ...extras() });
    } else lines.push({ accountId: pick(), debit: 0, credit: amount, ...extras() });
    // دو سطر روی یک حساب (بدهکار و بستانکار) مجاز است و گزارش‌ها نباید با آن بشکنند.
    post(date, lines, { approvalState: random() < 0.1 ? 'draft' : undefined });
  }
}

const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);

for (const seed of [11, 29, 47, 83, 131, 977]) {
  test(`قانون‌های میان گزارش‌ها روی دفتر تصادفی (بذر ${seed})`, async () => {
    await ledger(`reports-${seed}`, (book) => {
      randomLedger(book, seed);
      const { db } = book;
      const from = day(1405, 1, 1);
      const to = day(1405, 9, 30);

      // ۱. تراز: متوازن در هر سطح؛ جمعِ سطح‌ها یکی؛ اول + گردش = پایان.
      const levels = Object.fromEntries(reports.TRIAL_LEVELS.map((level) => [level, reports.trialBalanceReport(db, { from, to, level, timeZone: TZ })]));
      for (const [level, report] of Object.entries(levels)) {
        assert.equal(report.balanced, true, `تراز ${level}`);
        for (const row of report.rows) {
          assert.equal(row.closingDebitBalance - row.closingCreditBalance, row.openingDebitBalance - row.openingCreditBalance + row.periodDebit - row.periodCredit, `${level} ${row.name}`);
          assert.ok(row.closingDebitBalance === 0 || row.closingCreditBalance === 0);
        }
      }
      for (const level of reports.TRIAL_LEVELS) {
        assert.deepEqual(levels[level].totals.periodDebit, levels.account.totals.periodDebit, `گردش ${level}`);
        assert.deepEqual(levels[level].totals.openingDebit, levels.account.totals.openingDebit, `اول دوره ${level}`);
      }
      const noRange = reports.trialBalanceReport(db, { to, level: 'account', timeZone: TZ });
      const closingOf = (report) => new Map(report.rows.map((row) => [row.key, row.closingNet]));
      assert.deepEqual(closingOf(noRange), closingOf(levels.account), 'ماندهٔ پایان مستقل از شروع بازه');
      // همان تراز قدیمیِ برنامه (بی‌مرز روز): در بازه‌ای که کل دفتر را می‌گیرد یکی است.
      const legacy = accounting.trialBalance(db);
      const all = reports.trialBalanceReport(db, { to: day(1406, 12, 29), level: 'account', timeZone: TZ });
      assert.equal(all.totals.closingDebitBalance, legacy.totals.debitBalance);

      // ۲. ترازنامه می‌خواند؛ سود سال جاری = سود خالص از اول سال تا همان روز.
      const sheet = reports.balanceSheetReport(db, { to, timeZone: TZ });
      assert.equal(sheet.totals.difference, 0, 'ترازنامه');
      const yearProfit = reports.incomeStatementReport(db, { from, to, timeZone: TZ });
      assert.equal(sheet.totals.currentYear, yearProfit.totals.netProfit, 'سود سال جاری');
      const priorProfit = reports.incomeStatementReport(db, { to: day(1404, 12, 29), timeZone: TZ });
      assert.equal(sheet.totals.retained, priorProfit.totals.netProfit, 'سود انباشته');
      const statement = yearProfit.totals;
      assert.equal(statement.netProfit, statement.revenue - statement.costOfSales - statement.expenses + statement.otherIncome);

      // ۳. جریان نقد: اول + خالص = پایان = نقدِ ترازنامه.
      const flow = reports.cashFlowReport(db, { from, to, timeZone: TZ });
      assert.equal(flow.reconciled, true, 'جریان نقد');
      const cashIds = new Set(db.prepare(`SELECT la.id FROM ledger_accounts la JOIN chart_accounts ca ON ca.id=la.chart_account_id WHERE ca.role IN ('cash','bank','petty-cash')`).all().map((row) => row.id));
      assert.equal(flow.closing, levels.account.rows.filter((row) => cashIds.has(row.key)).reduce((total, row) => total + row.closingNet, 0));
      for (const name of ['operating', 'investing', 'financing']) assert.equal(flow[name].inflow - flow[name].outflow, flow[name].net);

      // ۴. صورت تغییرات حقوق مالکانه = حقوق مالکانهٔ ترازنامه.
      const equity = reports.equityChangesReport(db, { from, to, timeZone: TZ });
      assert.equal(equity.totals.closing, sheet.totals.equity, 'حقوق مالکانه');
      assert.equal(equity.periodProfit, yearProfit.totals.netProfit);

      // ۵. کارت هر حساب = ماندهٔ همان حساب در تراز، در هر سطح کدینگ.
      for (const level of ['subsidiary', 'general', 'analytic']) {
        for (const row of levels[level].rows) {
          const card = reports.accountLedgerReport(db, { from, to, level, key: row.key, timeZone: TZ });
          assert.equal(card.closing, row.closingNet, `کارت ${level} ${row.name}`);
          assert.equal(card.opening, row.openingDebitBalance - row.openingCreditBalance);
          if (card.rows.length) assert.equal(card.rows.at(-1).balance, card.closing);
        }
      }

      // ۶. دفتر روزنامه = گردش دوره؛ هر سند متوازن.
      const journal = reports.journalBookReport(db, { from, to, timeZone: TZ });
      assert.equal(journal.totals.debit, levels.account.totals.periodDebit);
      assert.deepEqual(journal.unbalanced, []);

      // ۷. خالص مراکز هزینه (با «بدون مرکز») = سود خالص بازه.
      const centers = reports.costCenterReport(db, { from, to, timeZone: TZ });
      assert.equal(centers.totals.net, yearProfit.totals.netProfit);

      // ۸. کنترل‌ها: دفتر متوازن؛ پیش‌نویس‌ها شمرده می‌شوند و در هیچ گزارشی نیستند.
      const controls = reports.ledgerControlsReport(db, { to, timeZone: TZ });
      assert.equal(controls.balanced, true);
      const drafts = db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE approval_state='draft'").get().n;
      assert.equal(sum(controls.pending, 'count'), drafts);

      // ۹. خروجی اکسل همان جمع‌ها را دارد.
      const [sheetRows] = reports.reportSheets(levels.subsidiary, { columns: 8 });
      assert.deepEqual(sheetRows.rows.at(-1).slice(2), reports.TRIAL_COLUMNS[8].map(([field]) => levels.subsidiary.totals[field]));
    });
  });
}

// ---------------------------------------------------------------------------
// نمونه‌های دقیق
// ---------------------------------------------------------------------------

test('مرز سال به وقت تهران: سند ۲۳:۳۰ آخرین روز اسفند مال همان سال است', async () => {
  await ledger('reports-boundary', ({ db, byRole, post }) => {
    // ۲۹ اسفند ۱۴۰۴، ساعت ۲۳:۳۰ تهران = ۲۰:۰۰ UTC.
    const lastDay = new Date(Date.parse(day(1404, 12, 29)));
    const late = new Date(Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), lastDay.getUTCDate(), 20, 0)).toISOString();
    post(late, [{ accountId: byRole('cash'), debit: 1_000_000, credit: 0 }, { accountId: byRole('sales'), debit: 0, credit: 1_000_000 }]);
    const thisYear = reports.incomeStatementReport(db, { from: day(1405, 1, 1), to: day(1405, 12, 29), timeZone: TZ });
    const lastYear = reports.incomeStatementReport(db, { from: day(1404, 1, 1), to: day(1404, 12, 29), timeZone: TZ });
    assert.equal(thisYear.totals.revenue, 0);
    assert.equal(lastYear.totals.revenue, 1_000_000);
    const sheet = reports.balanceSheetReport(db, { to: day(1405, 2, 1), timeZone: TZ });
    assert.deepEqual([sheet.totals.retained, sheet.totals.currentYear], [1_000_000, 0]);
  });
});

test('صورت سود و زیان: بهای تمام‌شده، سود ناخالص، هزینهٔ عملیاتی و سایر درآمدها جدا', async () => {
  await ledger('reports-income', ({ db, byRole, post }) => {
    const at = day(1405, 3, 10);
    post(at, [{ accountId: byRole('receivable'), debit: 110_000_000, credit: 0 }, { accountId: byRole('sales'), debit: 0, credit: 100_000_000 }, { accountId: byRole('output-tax'), debit: 0, credit: 10_000_000 }]);
    post(at, [{ accountId: byRole('cogs'), debit: 60_000_000, credit: 0 }, { accountId: byRole('inventory'), debit: 0, credit: 60_000_000 }]);
    post(at, [{ accountId: byRole('operating-expense'), debit: 15_000_000, credit: 0 }, { accountId: byRole('bank'), debit: 0, credit: 15_000_000 }]);
    post(at, [{ accountId: byRole('bank'), debit: 2_000_000, credit: 0 }, { accountId: byRole('other-income'), debit: 0, credit: 2_000_000 }]);
    const { totals } = reports.incomeStatementReport(db, { from: day(1405, 1, 1), to: day(1405, 12, 29), timeZone: TZ });
    assert.deepEqual(totals, { revenue: 100_000_000, costOfSales: 60_000_000, expenses: 15_000_000, otherIncome: 2_000_000, grossProfit: 40_000_000, operatingProfit: 25_000_000, netProfit: 27_000_000 });
    // مقایسه با بازهٔ هم‌طولِ قبل: خالی، ولی ساختارش هست.
    const compared = reports.incomeStatementReport(db, { from: day(1405, 3, 1), to: day(1405, 3, 31), compare: true, timeZone: TZ });
    assert.equal(compared.previous.totals.revenue, 0);
    assert.equal(compared.previous.range.toDay, '1405-02-31');
  });
});

test('جریان نقد: وام تأمین مالی، خرید دارایی سرمایه‌گذاری، انتقال بانک به صندوق هیچ', async () => {
  await ledger('reports-cashflow', ({ db, byRole, post }) => {
    const at = day(1405, 4, 5);
    post(at, [{ accountId: byRole('bank'), debit: 200_000_000, credit: 0 }, { accountId: byRole('loan-payable'), debit: 0, credit: 200_000_000 }]);
    post(at, [{ accountId: byRole('fixed-asset'), debit: 80_000_000, credit: 0 }, { accountId: byRole('bank'), debit: 0, credit: 80_000_000 }]);
    post(at, [{ accountId: byRole('cash'), debit: 5_000_000, credit: 0 }, { accountId: byRole('bank'), debit: 0, credit: 5_000_000 }]);
    // فروش با ارزش افزوده: هر دو سطر عملیاتی‌اند و جمعشان دقیقاً پولِ آمده است.
    post(at, [{ accountId: byRole('cash'), debit: 11_000_000, credit: 0 }, { accountId: byRole('sales'), debit: 0, credit: 10_000_000 }, { accountId: byRole('output-tax'), debit: 0, credit: 1_000_000 }]);
    const flow = reports.cashFlowReport(db, { from: day(1405, 1, 1), to: day(1405, 12, 29), timeZone: TZ });
    assert.deepEqual([flow.operating.net, flow.investing.net, flow.financing.net, flow.net], [11_000_000, -80_000_000, 200_000_000, 131_000_000]);
    assert.equal(flow.closing, 131_000_000);
  });
});

test('پیش‌نویس و سند انتظامی در صورت‌های مالی نیستند؛ کنترل‌ها مانده‌های خلاف ماهیت را می‌گویند', async () => {
  await ledger('reports-controls', ({ db, byRole, post }) => {
    const at = day(1405, 5, 1);
    post(at, [{ accountId: byRole('operating-expense'), debit: 3_000_000, credit: 0 }, { accountId: byRole('cash'), debit: 0, credit: 3_000_000 }]);
    post(at, [{ accountId: byRole('cash'), debit: 50_000_000, credit: 0 }, { accountId: byRole('sales'), debit: 0, credit: 50_000_000 }], { approvalState: 'draft' });
    const sheet = reports.balanceSheetReport(db, { to: day(1405, 12, 29), timeZone: TZ });
    assert.equal(sheet.totals.difference, 0);
    assert.equal(sheet.totals.currentYear, -3_000_000);
    const controls = reports.ledgerControlsReport(db, { to: day(1405, 12, 29), timeZone: TZ });
    assert.deepEqual(controls.pending.map((row) => [row.state, row.count, row.amount]), [['draft', 1, 50_000_000]]);
    // صندوق ۳ میلیون منفی شده: خلاف ماهیت.
    assert.ok(controls.abnormal.some((row) => row.balance === -3_000_000 && /منفی/.test(row.reason)), JSON.stringify(controls.abnormal));
  });
});

test('اشخاص و گزارش سنی: مانده از دفتر کل، سن از سررسید سند، تفاوت بی‌سند جدا', async () => {
  await ledger('reports-persons', ({ db, byRole, post }) => {
    const contact = database.saveContact({ name: 'آقای کریمی' });
    const analytic = db.prepare("SELECT id FROM analytic_accounts WHERE kind='contact'").get()?.id
      || (db.prepare('INSERT INTO analytic_accounts (id,code,name,kind,source_kind,source_key,active) VALUES (?,?,?,?,?,?,1)').run('an-karimi', '7001', 'آقای کریمی', 'contact', 'contact', contact.id), 'an-karimi');
    const at = new Date(Date.now() - 45 * 86_400_000).toISOString();
    post(at, [{ accountId: byRole('receivable'), debit: 30_000_000, credit: 0, analyticId: analytic }, { accountId: byRole('sales'), debit: 0, credit: 30_000_000 }]);
    db.prepare(`INSERT INTO obligations (id,contact_id,title,amount,direction,due_at,occurred_at,status,note) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('ob-1', contact.id, 'فروش نسیه', 20_000_000, 'receivable', new Date(Date.now() - 40 * 86_400_000).toISOString(), at, 'open', '');
    const persons = reports.personsReport(db, { timeZone: TZ });
    assert.deepEqual(persons.debtors.map((row) => [row.name, row.balance]), [['آقای کریمی', 30_000_000]]);
    const aging = reports.agingReport(db, { timeZone: TZ });
    const [row] = aging.receivable;
    assert.equal(row.buckets.d60, 20_000_000);
    assert.deepEqual([row.documents, row.ledgerBalance, row.unallocated], [20_000_000, 30_000_000, 10_000_000]);
  });
});

test('ورودی نادرست: تاریخ و سطح نامعتبر، شروع بعد از پایان', async () => {
  await ledger('reports-invalid', ({ db }) => {
    assert.throws(() => reports.trialBalanceReport(db, { level: 'x' }), { code: 'REPORT_LEVEL_INVALID' });
    assert.throws(() => reports.trialBalanceReport(db, { from: 'not-a-date' }), { code: 'REPORT_DATE_INVALID' });
    assert.throws(() => reports.trialBalanceReport(db, { from: day(1405, 5, 1), to: day(1405, 4, 1) }), { code: 'REPORT_RANGE_INVALID' });
    assert.throws(() => reports.accountLedgerReport(db, { key: 'missing' }), { code: 'REPORT_ACCOUNT_MISSING' });
  });
});

test('دسترسی: «گزارش‌های حسابداری» زیر «گزارش‌ها»، فقط حرفه‌ای، حسابدار به بالا و پروندهٔ کسب‌وکار', async () => {
  const { screensFor } = await import('../shared/experience.js');
  const { visibleMenu } = await import('../src/app/menu.js');
  const ids = (context) => screensFor(context).map((screen) => screen.id);
  assert.ok(ids({ role: 'accountant', experience: 'professional' }).includes('accounting-reports'));
  assert.ok(!ids({ role: 'viewer', experience: 'professional' }).includes('accounting-reports'));
  assert.ok(!ids({ role: 'owner', experience: 'simple' }).includes('accounting-reports'));
  assert.ok(!ids({ role: 'owner', experience: 'professional', profileType: 'personal' }).includes('accounting-reports'));
  const reportsGroup = visibleMenu(screensFor({ role: 'owner', experience: 'professional' })).find((group) => group.id === 'reports');
  assert.deepEqual(reportsGroup.items.map((item) => item.screen), ['report', 'accounting-reports']);
});
