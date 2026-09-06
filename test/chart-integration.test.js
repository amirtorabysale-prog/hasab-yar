import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('chart');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'chart-owner';
process.env.ADMIN_PASSWORD = 'chart-strong-password-123456';

const database = await import(`../server/db.js?chart=${process.pid}`);
const accounting = await import(`../server/accounting.js?chart=${process.pid}`);
const chart = await import(`../server/chartOfAccounts.js?chart=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('chart-owner', 'chart-strong-password-123456');
const workspace = database.createWorkspace(owner.id, { name: 'شرکت کدینگ', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

let costCenter;
let project;

test('the default template installs a usable four-level chart', () => {
  inWorkspace(() => {
    const result = database.installChartTemplate();
    assert.equal(result.total, chart.DEFAULT_CHART_TEMPLATE.length);
    assert.equal(result.created, chart.DEFAULT_CHART_TEMPLATE.length);
    const overview = database.chartOverview();
    assert.ok(overview.accounts.some((item) => item.code === '1101' && item.level === 'subsidiary'));
    assert.ok(overview.accounts.some((item) => item.code === '1' && item.level === 'group'));
    assert.equal(overview.accounts.find((item) => item.code === '1101').levelLabel, 'معین');
    assert.equal(overview.mapping.chartInstalled, true);
  });
});

test('reinstalling the same template updates instead of duplicating', () => {
  inWorkspace(() => {
    const before = database.chartOverview().accounts.length;
    const result = database.installChartTemplate();
    assert.equal(result.created, 0);
    assert.equal(result.updated, chart.DEFAULT_CHART_TEMPLATE.length);
    assert.equal(database.chartOverview().accounts.length, before);
  });
});

test('a broken import changes nothing at all', () => {
  inWorkspace(() => {
    const before = database.chartOverview().accounts.length;
    assert.throws(
      () => database.importChart('کد,نام,سطح,کد والد,نوع\n1,دارایی,گروه,,دارایی\n9901,پرت,معین,1,دارایی'),
      (error) => error.code === 'CHART_ROWS_INVALID',
    );
    assert.equal(database.chartOverview().accounts.length, before, 'ایراد فایل نباید نیمی از ردیف‌ها را وارد کند');
  });
});

test('an office chart imports on top and keeps its own codes', () => {
  inWorkspace(() => {
    const result = database.importChart([
      'کد,نام,سطح,کد والد,نوع',
      '۹,هزینه‌های اداری دفتر,گروه,,هزینه',
      '۹۱,هزینه اداری,کل,۹,هزینه',
      '۹۱۰۱,ملزومات اداری,معین,۹۱,هزینه',
    ].join('\n'));
    assert.equal(result.created, 3);
    const added = database.chartOverview().accounts.find((item) => item.code === '9101');
    assert.equal(added.name, 'ملزومات اداری');
    assert.equal(added.parentCode, '91');
    assert.equal(added.source, 'import');
    assert.equal(added.typeLabel, 'هزینه');
  });
});

test('an existing code cannot silently change level or type', () => {
  inWorkspace(() => {
    assert.throws(
      () => database.importChart('کد,نام,سطح,کد والد,نوع\n9101,ملزومات,گروه,,هزینه'),
      (error) => error.code === 'CHART_CONFLICT',
    );
  });
});

test('suggested mappings connect every internal account to the office chart', () => {
  inWorkspace(() => {
    database.insertTransactions({
      transcript: 'فروش نقدی',
      transactions: [{ amount: 4_000_000, type: 'income', category: 'فروش', rawText: 'فروش نقدی' }],
    });
    const before = database.chartOverview().mapping;
    assert.ok(before.unmappedCount > 0);
    assert.ok(before.suggestionsAvailable > 0);

    const applied = database.applyChartSuggestions();
    assert.ok(applied.applied > 0);
    assert.equal(applied.unmappedCount, 0);
    assert.equal(applied.complete, true);

    const cash = database.chartOverview().mapping.items.find((item) => item.sourceKind === 'operational-account');
    assert.equal(cash.chartCode, '1101');
    assert.equal(cash.mapped, true);
  });
});

test('only a subsidiary account accepts a mapping, and only of the same type', () => {
  inWorkspace(() => {
    const mapping = database.chartOverview().mapping;
    const cash = mapping.items.find((item) => item.sourceKind === 'operational-account');
    const group = database.chartOverview().accounts.find((item) => item.code === '1');
    const payable = database.chartOverview().accounts.find((item) => item.code === '3101');
    assert.throws(() => database.mapLedgerAccount(cash.id, group.id), (error) => error.code === 'CHART_NOT_POSTABLE');
    assert.throws(() => database.mapLedgerAccount(cash.id, payable.id), (error) => error.code === 'CHART_TYPE_MISMATCH');
    assert.throws(() => database.mapLedgerAccount('no-such-account', payable.id), (error) => error.code === 'LEDGER_ACCOUNT_MISSING');
  });
});

test('a mapped chart cannot be replaced out from under the ledger', () => {
  inWorkspace(() => {
    assert.throws(
      () => database.importChart('کد,نام,سطح,کد والد,نوع\n1,دارایی,گروه,,دارایی', { replace: true }),
      (error) => error.code === 'CHART_IN_USE',
    );
  });
});

test('cost centres and floating analytics are created with generated codes', () => {
  inWorkspace(() => {
    costCenter = database.saveCostCenterEntry({ name: 'شعبه مرکزی' });
    project = database.saveAnalytic({ name: 'پروژهٔ برج آبان', kind: 'project' });
    assert.match(costCenter.code, /^\d+$/);
    assert.match(project.code, /^\d+$/);
    assert.equal(database.chartOverview().costCenters.length, 1);
    assert.equal(database.chartOverview().analytics.some((item) => item.name === 'پروژهٔ برج آبان'), true);
    assert.throws(() => database.saveCostCenterEntry({ name: '' }), /نام مرکز هزینه/);
  });
});

test('a manual entry carries both dimensions onto its lines', () => {
  inWorkspace(() => {
    const db = database.db;
    const accounts = accounting.listLedgerAccounts(db);
    const cash = accounts.find((item) => item.type === 'asset');
    const income = accounts.find((item) => item.type === 'income');
    const entry = accounting.createAdjustingJournal(db, {
      memo: 'درآمد پروژه',
      lines: [
        { accountId: cash.id, debit: 900_000, description: 'دریافت پروژه', analyticId: project.id, costCenterId: costCenter.id },
        { accountId: income.id, credit: 900_000, description: 'درآمد پروژه' },
      ],
    });
    const line = entry.lines.find((item) => item.debit === 900_000);
    assert.equal(line.analyticName, 'پروژهٔ برج آبان');
    assert.equal(line.costCenterName, 'شعبه مرکزی');
    assert.equal(entry.lines.find((item) => item.credit === 900_000).analyticId, null);
  });
});

test('an unknown dimension id is refused rather than dropped silently', () => {
  inWorkspace(() => {
    const db = database.db;
    const accounts = accounting.listLedgerAccounts(db);
    const cash = accounts.find((item) => item.type === 'asset');
    const income = accounts.find((item) => item.type === 'income');
    assert.throws(() => accounting.createAdjustingJournal(db, {
      memo: 'بعد جعلی',
      lines: [
        { accountId: cash.id, debit: 1_000, costCenterId: 'not-a-real-cost-centre' },
        { accountId: income.id, credit: 1_000 },
      ],
    }), (error) => error.code === 'COST_CENTER_INVALID');
  });
});

test('the dimension report shows both assigned and unassigned turnover', () => {
  inWorkspace(() => {
    const report = database.dimensionReport({ dimension: 'costCenter' });
    const branch = report.rows.find((item) => item.name === 'شعبه مرکزی');
    assert.equal(report.dimensionLabel, 'مرکز هزینه');
    assert.equal(branch.debit, 900_000);
    assert.equal(branch.balance, 900_000);
    // ردیف بدون مرکز هزینه پنهان نمی‌شود.
    assert.ok(report.unassigned.lineCount > 0);

    const analytic = database.dimensionReport({ dimension: 'analytic' });
    assert.equal(analytic.dimensionLabel, 'تفصیلی شناور');
    assert.equal(analytic.rows.find((item) => item.name === 'پروژهٔ برج آبان').debit, 900_000);
  });
});

test('a customer becomes a floating analytic on its own receivable line', () => {
  inWorkspace(() => {
    const contact = database.saveContact({ name: 'شرکت آبان', kind: 'customer' });
    const invoice = database.createInvoice({
      contactId: contact.id, documentType: 'sales',
      items: [{ title: 'خدمات مشاوره', quantity: 1, unitPrice: 2_000_000 }],
    });
    database.issueInvoice(invoice.id, {});
    const analytics = database.chartOverview().analytics;
    assert.equal(analytics.some((item) => item.name === 'شرکت آبان' && item.kind === 'contact'), true);

    const journal = accounting.listJournal(database.db, { limit: 50 });
    const receivableLine = journal.items.flatMap((item) => item.lines).find((line) => line.analyticName === 'شرکت آبان');
    assert.ok(receivableLine, 'ردیف حساب دریافتنی باید تفصیلی مشتری را داشته باشد');
    assert.equal(receivableLine.debit, 2_000_000);
  });
});

test('the ledger stays balanced after every phase two posting', () => {
  inWorkspace(() => {
    assert.equal(accounting.trialBalance(database.db).balanced, true);
  });
});

test('the transfer export carries chart, analytic and cost centre columns', () => {
  inWorkspace(() => {
    // فاکتور و تفصیلی‌های تازه حساب‌های تازه ساخته‌اند؛ نگاشت دوباره اعمال می‌شود.
    assert.equal(database.applyChartSuggestions().unmappedCount, 0);
    const overview = database.accountingTransferOverview('', 'generic-csv');
    assert.equal(overview.readiness.chart.installed, true);
    const chartCheck = overview.readiness.checks.find((item) => item.id === 'chart');
    assert.equal(chartCheck.severity, 'blocker');
    assert.equal(chartCheck.passed, true, 'وقتی همهٔ حساب‌ها نگاشت شده‌اند این کنترل باید پاس شود');
    assert.equal(overview.readiness.chart.unmappedUsedCount, 0);
  });
});

test('a newly used account without a mapping blocks the export', () => {
  inWorkspace(() => {
    database.insertTransactions({
      transcript: 'هزینه تازه',
      transactions: [{ amount: 150_000, type: 'expense', category: 'دستهٔ کاملاً تازه', rawText: 'هزینه تازه' }],
    });
    const overview = database.accountingTransferOverview('', 'generic-csv');
    const chartCheck = overview.readiness.checks.find((item) => item.id === 'chart');
    assert.equal(chartCheck.passed, false);
    assert.equal(overview.readiness.ready, false);
    assert.equal(overview.readiness.chart.unmappedUsedCount, 1);
    assert.match(overview.readiness.chart.unmappedUsedAccounts[0].name, /دستهٔ کاملاً تازه/);
  });
});

// وضعیت واقعی کاربر در production: نگاشت‌ها پیش از شناختن معین اختصاصی دسته‌ها
// ساخته شده بودند، پس اجاره و حمل‌ونقل هر دو روی ۸۱۰۹ «سایر هزینه‌های عملیاتی»
// نشسته بودند و در پارسیان همه‌چیز در یک حساب کلی جمع می‌شد.
test('اصلاح، نگاشت عمومیِ خودکار را دقیق‌تر می‌کند و انتخاب حسابدار را دست نمی‌زند', () => {
  inWorkspace(() => {
    database.insertTransactions({
      transcript: 'هزینه‌های دوره',
      transactions: [
        { amount: 5_000_000, type: 'expense', category: 'اجاره', rawText: 'اجاره' },
        { amount: 800_000, type: 'expense', category: 'حمل‌ونقل', rawText: 'حمل‌ونقل' },
        { amount: 300_000, type: 'expense', category: 'خوراک', rawText: 'خوراک' },
      ],
    });
    const idOf = (name) => database.chartOverview().mapping.items.find((item) => item.sourceKey === name)?.id;
    const [rent, transport, food] = ['اجاره', 'حمل‌ونقل', 'خوراک'].map(idOf);

    // همان چیزی که کاربر امروز دارد: همه روی معین عمومی.
    for (const id of [rent, transport, food]) database.mapLedgerAccount(id, '8109');
    // این یکی را حسابدار آگاهانه جای دیگری گذاشته است.
    database.mapLedgerAccount(food, '8104');

    const result = database.applyChartSuggestions({ refine: true });
    const codeOf = (id) => result.items.find((item) => item.id === id)?.chartCode;
    assert.equal(codeOf(rent), '8102');
    assert.equal(codeOf(transport), '8103');
    assert.equal(codeOf(food), '8104', 'انتخاب آگاهانهٔ حسابدار نباید بازنویسی شود');
    assert.equal(result.refined, 2);
  });
});

test('بدون refine هیچ نگاشت موجودی دست نمی‌خورد', () => {
  inWorkspace(() => {
    database.insertTransactions({
      transcript: 'اجاره', transactions: [{ amount: 5_000_000, type: 'expense', category: 'اجاره', rawText: 'اجاره' }],
    });
    const rent = database.chartOverview().mapping.items.find((item) => item.sourceKey === 'اجاره').id;
    database.mapLedgerAccount(rent, '8109');
    const result = database.applyChartSuggestions();
    assert.equal(result.items.find((item) => item.id === rent).chartCode, '8109');
    assert.equal(result.refined, 0);
  });
});

test.after(() => removeTempDatabase(databasePath));
