import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * یک ماه کامل از زندگی یک کارخانهٔ پلاستیک — تا فایل پارسیان.
 *
 * آزمون‌های دیگر هرکدام یک تکه را می‌گیرند. این یکی تنها جایی است که کل
 * زنجیره با هم اجرا می‌شود: آورده، خرید با ارزش افزوده، فروش، هزینه، حقوق،
 * چک، تسویهٔ جزئی، و آخرش فایل انتقال. اشکال‌هایی که فقط در ترکیب پیدا
 * می‌شوند — دو حساب برای یک شخص، سطری که تفصیلی ندارد، سندی که دو بار
 * می‌رود — هیچ‌جای دیگر دیده نمی‌شوند.
 *
 * و این دقیقاً همان چیزی است که دفتر حسابداری موقع تحویل می‌بیند.
 */
const databasePath = tempDatabase('factory');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'factory-owner';
process.env.ADMIN_PASSWORD = 'factory-strong-password-4417';

const database = await import(`../server/db.js?factory=${process.pid}`);
const accounting = await import(`../server/accounting.js?factory=${process.pid}`);
const sheet = await import(`../server/spreadsheet.js?factory=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('factory-owner', 'factory-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'پلاستیک سازان پارس', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

test('یک ماه کامل ثبت می‌شود و دفتر متوازن می‌ماند', () => {
  inWorkspace(() => {
    database.installChartTemplate();
    // حساب بانکی کارخانه؛ دفتر تازه فقط صندوق دارد.
    const bank = database.saveAccount({ name: 'بانک ملت — جاری', kind: 'bank' });

    // ۱) آوردهٔ مالک — درآمد نیست.
    database.recordCapitalEntry({ kind: 'capital-in', title: 'آوردهٔ آقای حیدری', amount: 500_000_000, accountId: bank.id });

    // ۲) خرید مواد اولیه با ارزش افزوده.
    const supplier = database.saveContact({ name: 'پتروشیمی جم' });
    const purchase = database.createInvoice({
      documentType: 'purchase', contactId: supplier.id, tax: 12_000_000,
      items: [{ title: 'گرانول پلی‌اتیلن', quantity: 10, unitPrice: 12_000_000 }],
    });
    database.issueInvoice(purchase.id);

    // ۳) فروش با ارزش افزوده.
    const customer = database.saveContact({ name: 'پخش البرز' });
    const sale = database.createInvoice({
      documentType: 'sales', contactId: customer.id, tax: 20_000_000,
      items: [{ title: 'نایلون صنعتی', quantity: 4, unitPrice: 50_000_000 }],
    });
    database.issueInvoice(sale.id);

    // ۴) هزینهٔ نقدی و کارمزد بانکی.
    database.insertTransactions({
      transcript: 'هزینه‌های ماه',
      transactions: [
        { amount: 8_000_000, type: 'expense', category: 'قبوض و انرژی', rawText: 'قبض برق کارخانه' },
        { amount: 350_000, type: 'expense', category: 'کارمزد بانکی', rawText: 'کارمزد انتقال وجه' },
      ],
    });

    // ۵) حقوق دو نفر پرسنل.
    database.importPayrollFile(sheet.buildWorkbook([{
      name: 'حقوق',
      rows: [
        ['نام پرسنل', 'حقوق ناخالص', 'بیمه سهم کارمند', 'بیمه سهم کارفرما', 'مالیات', 'خالص پرداختی'],
        ['رضا کریمی', 30_000_000, 2_100_000, 6_900_000, 600_000, 27_300_000],
        ['مینا رجبی', 20_000_000, 1_400_000, 4_600_000, 400_000, 18_200_000],
      ],
    }]), 'payroll.xlsx', { period: '۱۴۰۴/۰۶' });
    database.payPayrollSalaries(database.listPayrollRuns()[0].id, { accountId: bank.id });

    // ۶) چک از مشتری بابت همان طلب — درآمد دوباره نمی‌سازد.
    database.recordCheque({
      direction: 'receivable', contactId: customer.id, counterpartyName: 'پخش البرز',
      amount: 120_000_000, against: 'receivable', serial: '۱۲۳۴۵', bankName: 'ملت',
    });

    // ۷) تسویهٔ جزئی بدهی به تأمین‌کننده.
    const debt = database.saveObligation({
      title: 'بدهی به پتروشیمی جم', amount: 60_000_000, direction: 'payable', contactId: supplier.id,
    });
    database.settleObligation(debt.id, { amount: 25_000_000, accountId: bank.id });

    assert.equal(accounting.trialBalance(db()).balanced, true, 'دفتر باید بعد از همهٔ این‌ها متوازن بماند');
  });
});

/**
 * هیچ شخصی دو حساب ندارد.
 *
 * یک مشتری که هم فاکتور دارد، هم چک، هم تعهد — باید یک حساب دریافتنی داشته
 * باشد. دو حساب یعنی مانده‌اش نصف اینجا و نصف آنجا، و در صورت‌حساب پارسیان
 * دو ردیف جدا با یک نام.
 */
test('هر طرف حساب دقیقاً یک حساب دارد', () => {
  inWorkspace(() => {
    const duplicates = db().prepare(`SELECT source_kind AS sourceKind,name,COUNT(*) AS count
      FROM ledger_accounts WHERE source_kind IN ('customer-receivable','vendor-payable')
      GROUP BY source_kind,name HAVING COUNT(*) > 1`).all();
    assert.deepEqual(duplicates, [], `حساب تکراری پیدا شد: ${JSON.stringify(duplicates)}`);
  });
});

/** هر سطر باید حسابی داشته باشد که به کدینگ دفتر نگاشت شده، وگرنه خروجی قفل است. */
test('همهٔ حساب‌های استفاده‌شده به کدینگ نگاشت می‌شوند', () => {
  inWorkspace(() => {
    database.applyChartSuggestions();
    const unmapped = db().prepare(`SELECT DISTINCT ledger_accounts.code,ledger_accounts.name
      FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE ledger_accounts.chart_account_id IS NULL`).all()
      .map((row) => `${row.code} ${row.name}`);
    assert.deepEqual(unmapped, [], `این حساب‌ها معین ندارند: ${unmapped.join(' | ')}`);
  });
});

/**
 * هیچ سندی نامتوازن نیست و هیچ سطری بی‌حساب.
 *
 * پارسیان سند نامتوازن را می‌پذیرد ولی علامت می‌زند؛ سطر بی‌حساب را اصلاً
 * نمی‌پذیرد و بی‌صدا کنارش می‌گذارد — و همان سند را نامتوازن نشان می‌دهد.
 */
test('هیچ سند نامتوازن یا تک‌سطری در دفتر نیست', () => {
  inWorkspace(() => {
    const broken = db().prepare(`SELECT journal_entries.memo,
      SUM(journal_lines.debit) AS debit,SUM(journal_lines.credit) AS credit,COUNT(*) AS lineCount
      FROM journal_entries JOIN journal_lines ON journal_lines.entry_id=journal_entries.id
      GROUP BY journal_entries.id
      HAVING SUM(journal_lines.debit)<>SUM(journal_lines.credit) OR COUNT(*)<2`).all()
      .map((row) => `${row.memo}: ${row.debit} در برابر ${row.credit} (${row.lineCount} سطر)`);
    assert.deepEqual(broken, [], broken.join(' | '));
  });
});

/**
 * فایل پارسیان ساخته می‌شود و هر ریالش قابل ردیابی است.
 *
 * جمع فایل باید دقیقاً برابر جمع سندهای دوره باشد — منهای افتتاحیه، که
 * عمداً نمی‌رود چون در پارسیان از قبل هست.
 */
/**
 * تا کد تفصیلی نیاید، خروجی باز نمی‌شود.
 *
 * معین بدهکاران و بستانکاران در پارسیان تفصیلی اجباری دارند. ردیفی که
 * تفصیلی‌اش کد مقصد ندارد، آنجا کنار گذاشته می‌شود و سند را نامتوازن نشان
 * می‌دهد — بی‌آنکه پیامی بدهد. پس همین‌جا جلویش گرفته می‌شود.
 */
test('بدون کد تفصیلی، بستهٔ پارسیان ساخته نمی‌شود', () => {
  inWorkspace(() => {
    const check = database.accountingTransferOverview('', 'generic-csv').readiness.checks
      .find((item) => item.id === 'analytic-required');
    assert.equal(check.passed, false);
    assert.equal(check.severity, 'blocker');
    assert.ok(check.analyticRequiredGaps.some((gap) => gap.analyticName === 'پخش البرز'));
  });
});

test('بستهٔ انتقال ساخته می‌شود و جمعش با دفتر می‌خواند', () => {
  inWorkspace(() => {
    // فایل تفصیلی نرم‌افزار دفتر: همان کاری که حسابدار یک بار انجام می‌دهد.
    database.importAnalyticsFile(sheet.buildWorkbook([{
      name: 'تفصیلی',
      rows: [
        ['کد', 'نام', 'نوع'],
        ['1001', 'پخش البرز', 'مشتری'],
        ['1002', 'پتروشیمی جم', 'تامین کننده'],
      ],
    }]), 'tafsili.xlsx');

    const overview = database.accountingTransferOverview('', 'generic-csv');
    const blocking = overview.readiness.checks.filter((item) => !item.passed && item.severity !== 'advisory');
    assert.deepEqual(blocking.map((item) => item.label), [], JSON.stringify(blocking));

    const expected = db().prepare(`SELECT COALESCE(SUM(journal_lines.debit),0) AS total
      FROM journal_lines JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
      WHERE journal_entries.entry_kind<>'opening'`).get().total;
    assert.equal(overview.readiness.debitTotal, expected);
    assert.equal(overview.readiness.debitTotal, overview.readiness.creditTotal);

    const batch = database.createAccountingTransferBatch({ targetSystem: 'generic-csv' });
    assert.equal(batch.debitTotal, expected);
    assert.equal(batch.creditTotal, expected);
    assert.ok(batch.rowCount > 0);
  });
});

/**
 * آوردهٔ مالک در سود دوره نیست.
 *
 * پانصد میلیون آورده اگر درآمد شمرده شود، سود دوره همان‌قدر باد می‌کند و
 * مالیات روی پول خودِ مالک حساب می‌شود.
 */
test('آورده و ارزش افزوده در سود و زیان دوره نیستند', () => {
  inWorkspace(() => {
    const income = db().prepare(`SELECT COALESCE(SUM(credit)-SUM(debit),0) AS net FROM journal_lines
      JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE ledger_accounts.type='income'`).get().net;
    // فقط فروش دویست‌میلیونی؛ نه آورده، نه مالیات ارزش افزوده.
    assert.equal(income, 200_000_000);
  });
});

test.after(() => removeTempDatabase(databasePath));
