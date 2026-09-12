import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('obligation-journal');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'obligation-owner';
process.env.ADMIN_PASSWORD = `obligation-${crypto.randomUUID()}`;

const database = await import(`../server/db.js?obligation=${process.pid}`);
const accounting = await import(`../server/accounting.js?obligation=${process.pid}`);
const store = await import(`../server/financialEventStore.js?obligation=${process.pid}`);

database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const inPrimary = (callback) => database.runInWorkspace('primary', { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();
const balanced = () => {
  const trial = accounting.trialBalance(db());
  assert.equal(trial.totals.debit, trial.totals.credit, 'دفتر باید متوازن بماند');
};

// این همان چیزی است که در پارسیان دیده نمی‌شد: تعهد باز هیچ سندی نداشت، پس نه
// در تراز بود و نه در فایل انتقال.
test('طلب باز همان لحظه سند می‌خورد', () => {
  inPrimary(() => {
    const contact = database.saveContact({ name: 'شرکت آراد گستر آسیا' });
    const item = database.saveObligation({
      title: 'طلب از آراد', amount: 23_000_000, direction: 'receivable', contactId: contact.id,
    });
    const event = store.findEventBySource(db(), `obligation:${item.id}`);
    assert.ok(event, 'تعهد باید رویداد داشته باشد');
    assert.equal(event.kind, 'receivable-opened');
    assert.equal(event.status, 'posted');
    assert.ok(event.journalEntryId, 'باید سند دفتر کل بخورد');
    balanced();
  });
});

test('سند طلب روی حساب دریافتنیِ همان طرف حساب می‌نشیند', () => {
  inPrimary(() => {
    const accounts = accounting.listLedgerAccounts(db());
    const receivable = accounts.find((account) => account.name.includes('حساب دریافتنی') && account.name.includes('آراد'));
    assert.ok(receivable, 'حساب دریافتنی این طرف حساب باید ساخته شود');
    const trial = accounting.trialBalance(db());
    const row = trial.rows.find((entry) => entry.id === receivable.id);
    assert.ok(row && row.debit >= 23_000_000, 'طلب ما باید بدهکار حساب دریافتنی باشد');
  });
});

test('بدهی باز هم سند می‌خورد و سمت مقابلش پرداختنی است', () => {
  inPrimary(() => {
    const item = database.saveObligation({ title: 'بدهی به پارس', amount: 8_000_000, direction: 'payable' });
    const event = store.findEventBySource(db(), `obligation:${item.id}`);
    assert.equal(event.kind, 'payable-opened');
    const payable = accounting.listLedgerAccounts(db()).find((account) => account.name.includes('حساب پرداختنی'));
    assert.ok(payable, 'حساب پرداختنی باید ساخته شود');
    balanced();
  });
});

// ویرایش نباید سند دوم بسازد؛ شناسهٔ منبع یکتاست.
test('ویرایش تعهد سند دوم نمی‌سازد', () => {
  inPrimary(() => {
    const item = database.saveObligation({ title: 'طلب ویرایشی', amount: 1_000_000, direction: 'receivable' });
    const before = accounting.listJournal(db(), { limit: 300 }).items.length;
    database.saveObligation({ id: item.id, title: 'طلب ویرایشی', amount: 1_500_000, direction: 'receivable' });
    assert.equal(accounting.listJournal(db(), { limit: 300 }).items.length, before, 'ویرایش نباید سند تازه بزند');
    balanced();
  });
});

/**
 * مهم‌ترین آزمون این فایل.
 *
 * وقتی طلب هنگام ساخت درآمد را شناخته، تسویه فقط جابه‌جایی پول است. اگر تسویه
 * دوباره به دستهٔ درآمد بخورد، همان مبلغ دو بار در سود دوره می‌آید.
 */
test('تسویه درآمد را دوباره نمی‌شناسد', () => {
  inPrimary(() => {
    const contact = database.saveContact({ name: 'حسن مشتری' });
    const item = database.saveObligation({ title: 'طلب از حسن', amount: 5_000_000, direction: 'receivable', contactId: contact.id });

    const incomeBefore = accounting.trialBalance(db()).rows
      .filter((row) => row.type === 'income').reduce((sum, row) => sum + row.credit, 0);

    database.settleObligation(item.id);

    const incomeAfter = accounting.trialBalance(db()).rows
      .filter((row) => row.type === 'income').reduce((sum, row) => sum + row.credit, 0);
    assert.equal(incomeAfter, incomeBefore, 'تسویه نباید درآمد تازه بشناسد');
    balanced();
  });
});

test('پس از تسویه، حساب دریافتنی آن طرف حساب صفر می‌شود', () => {
  inPrimary(() => {
    const receivable = accounting.listLedgerAccounts(db())
      .find((account) => account.name.includes('حساب دریافتنی') && account.name.includes('حسن'));
    const row = accounting.trialBalance(db()).rows.find((entry) => entry.id === receivable.id);
    assert.equal(row.debit - row.credit, 0, 'طلب وصول‌شده نباید ماندهٔ باز بگذارد');
  });
});

// تعهدهای پیش از این تغییر سند ندارند؛ تسویه‌شان نباید حساب دریافتنی را منفی کند.
test('تعهد قدیمیِ بدون سند، مسیر قبلی را نگه می‌دارد', () => {
  inPrimary(() => {
    const item = database.saveObligation({ title: 'طلب قدیمی', amount: 2_000_000, direction: 'receivable' });
    // شبیه‌سازی تعهدی که پیش از این تغییر ساخته شده: رویدادش را برمی‌داریم.
    db().prepare('DELETE FROM financial_events WHERE source_event_id=?').run(`obligation:${item.id}`);

    const settled = database.settleObligation(item.id);
    assert.equal(settled.item.status, 'paid');
    assert.equal(settled.transaction.type, 'income', 'مسیر قدیمی باید دست‌نخورده بماند');
    balanced();
  });
});

test('تسویهٔ دوباره ممکن نیست', () => {
  inPrimary(() => {
    const item = database.saveObligation({ title: 'طلب یک‌بارمصرف', amount: 3_000_000, direction: 'receivable' });
    database.settleObligation(item.id);
    assert.equal(database.settleObligation(item.id), null, 'تعهد بسته دوباره تسویه نمی‌شود');
    balanced();
  });
});

test.after(() => {
  database.closeAllDatabases?.();
  removeTempDatabase(databasePath);
});

/**
 * این همان چیزی است که در فایل انتقال کاربر غایب بود: هفتادوهشت ردیف با تفصیلی
 * صفر. در پارسیان اشخاص در تفصیلی زندگی می‌کنند، نه در معین.
 */
test('سطر طرف حساب تفصیلی می‌گیرد', () => {
  inPrimary(() => {
    const contact = database.saveContact({ name: 'شرکت تفصیلی' });
    const item = database.saveObligation({
      title: 'طلب تفصیلی', amount: 7_000_000, direction: 'receivable', contactId: contact.id,
    });
    const event = store.findEventBySource(db(), `obligation:${item.id}`);
    const lines = db().prepare(`SELECT jl.analytic_id AS analyticId, la.name AS accountName, aa.name AS analyticName
      FROM journal_lines jl
      JOIN ledger_accounts la ON la.id=jl.account_id
      LEFT JOIN analytic_accounts aa ON aa.id=jl.analytic_id
      WHERE jl.entry_id=?`).all(event.journalEntryId);

    const receivableLine = lines.find((line) => line.accountName.includes('حساب دریافتنی'));
    assert.ok(receivableLine.analyticId, 'سطر حساب دریافتنی باید تفصیلی داشته باشد');
    assert.equal(receivableLine.analyticName, 'شرکت تفصیلی');

    // تفصیلی روی حساب درآمد بی‌معناست؛ گذاشتنش داده‌ای می‌سازد که کسی نمی‌فهمد.
    const incomeLine = lines.find((line) => !line.accountName.includes('حساب دریافتنی'));
    assert.equal(incomeLine.analyticId, null, 'حساب درآمد نباید تفصیلی بگیرد');
  });
});

test('تعهد بدون طرف حساب تفصیلی جعلی نمی‌سازد', () => {
  inPrimary(() => {
    const item = database.saveObligation({ title: 'بدهی بی‌نام', amount: 1_200_000, direction: 'payable' });
    const event = store.findEventBySource(db(), `obligation:${item.id}`);
    const lines = db().prepare('SELECT analytic_id AS analyticId FROM journal_lines WHERE entry_id=?').all(event.journalEntryId);
    assert.ok(lines.every((line) => !line.analyticId), 'بدون طرف حساب، تفصیلی ساخته نمی‌شود');
  });
});

test('تفصیلی همان شخص با ثبت دوم تکرار نمی‌شود', () => {
  inPrimary(() => {
    const contact = database.saveContact({ name: 'شرکت تکراری' });
    database.saveObligation({ title: 'اول', amount: 1_000_000, direction: 'receivable', contactId: contact.id });
    database.saveObligation({ title: 'دوم', amount: 2_000_000, direction: 'receivable', contactId: contact.id });
    const count = db().prepare("SELECT COUNT(*) AS count FROM analytic_accounts WHERE name='شرکت تکراری'").get().count;
    assert.equal(count, 1, 'یک شخص باید یک تفصیلی داشته باشد، نه یکی به‌ازای هر ثبت');
  });
});

// کد داخلی تفصیلی خودکار ساخته می‌شود و در پارسیان یعنی شخص دیگری. تا وقتی
// نگاشت نشده باید خالی برود — فرستادن کد اشتباه از گم‌شدن طرف حساب بدتر است.
test('کد تفصیلی مقصد جدا از کد داخلی است', () => {
  inPrimary(() => {
    const contact = database.saveContact({ name: 'شرکت نگاشتی' });
    database.saveObligation({ title: 'طلب نگاشتی', amount: 4_000_000, direction: 'receivable', contactId: contact.id });

    const analytic = db().prepare("SELECT id,code,external_code AS externalCode FROM analytic_accounts WHERE name='شرکت نگاشتی'").get();
    assert.ok(analytic.code, 'کد داخلی باید ساخته شود');
    assert.equal(analytic.externalCode, null, 'کد مقصد تا نگاشت نشدن خالی می‌ماند');

    const saved = database.saveAnalytic({ id: analytic.id, name: 'شرکت نگاشتی', externalCode: '۵۰۲۱' });
    assert.equal(saved.external_code, '5021', 'رقم فارسی باید لاتین شود');
  });
});

test('کد تفصیلی غیرعددی پذیرفته نمی‌شود', () => {
  inPrimary(() => {
    const analytic = db().prepare("SELECT id FROM analytic_accounts WHERE name='شرکت نگاشتی'").get();
    assert.throws(
      () => database.saveAnalytic({ id: analytic.id, name: 'شرکت نگاشتی', externalCode: 'AB12' }),
      /کد تفصیلی مقصد/,
    );
  });
});

test('طرف حساب بدون کد مقصد هشدار می‌گیرد، ولی خروجی را قفل نمی‌کند', async () => {
  const { accountingTransferReadiness } = await import(`../server/accountingTransfer.js?obligation=${process.pid}`);
  const readiness = accountingTransferReadiness({
    journalRows: [
      { entryId: 'e1', accountId: 'a1', analyticId: 'an1', tafsiliName: 'شرکت بی‌کد', tafsiliCode: null, debit: 1000, credit: 0, chartCode: '1201' },
      { entryId: 'e1', accountId: 'a2', analyticId: null, tafsiliCode: null, debit: 0, credit: 1000, chartCode: '6101' },
    ],
    chart: { installed: true },
  });
  const check = readiness.checks.find((item) => item.id === 'analytic-mapping');
  assert.equal(check.count, 1);
  assert.equal(check.passed, false);
  assert.equal(check.severity, 'advisory', 'نبود کد تفصیلی نباید ساخت فایل را قفل کند');
  assert.equal(check.unmappedAnalytics[0].name, 'شرکت بی‌کد');
});

/**
 * ریشهٔ «همه‌چیز روی یک معین» در فایل انتقال کاربر.
 *
 * حساب تازه بدون نگاشت ساخته می‌شد و کاربر باید دستی «اعمال پیشنهادها» را
 * می‌زد. چون کسی آن دکمه را نزده بود، همهٔ هزینه‌ها روی یک معین عمومی رفتند.
 */
test('حساب تازه همان لحظه به معین خودش نگاشت می‌شود', () => {
  inPrimary(() => {
    database.installChartTemplate();
    const expected = [
      ['اجاره', 'expense', '8102'],
      ['حمل‌ونقل', 'expense', '8103'],
      ['قبوض', 'expense', '8104'],
      ['حقوق و دستمزد', 'expense', '8101'],
      ['فروش', 'income', '6101'],
      ['خدمات', 'income', '6102'],
    ];
    for (const [category, type] of expected) {
      database.insertTransactions({ transcript: category, transactions: [{ amount: 1_000_000, type, category, rawText: category }] });
    }
    const accounts = accounting.listLedgerAccounts(db());
    for (const [category, , chartCode] of expected) {
      const account = accounts.find((item) => item.name === category);
      assert.ok(account, `حساب «${category}» ساخته نشد`);
      assert.equal(account.chartCode, chartCode, `«${category}» باید روی ${chartCode} بنشیند، نه روی معین عمومی`);
    }
  });
});

test('حساب طرف حساب هم خودکار نگاشت می‌شود', () => {
  inPrimary(() => {
    const contact = database.saveContact({ name: 'شرکت نگاشت خودکار' });
    database.saveObligation({ title: 'طلب', amount: 2_000_000, direction: 'receivable', contactId: contact.id });
    const account = accounting.listLedgerAccounts(db())
      .find((item) => item.name.includes('حساب دریافتنی') && item.name.includes('نگاشت خودکار'));
    assert.equal(account.chartCode, '1201', 'حساب دریافتنی باید روی معین دریافتنی تجاری بنشیند');
  });
});

// سند نگاشت‌نشده بهتر از سند ثبت‌نشده است؛ نبود کدینگ نباید ثبت را بشکند.
test('نبود کدینگ، ثبت سند را نمی‌شکند', () => {
  inPrimary(() => {
    const item = database.saveObligation({ title: 'طلب بدون کدینگ', amount: 900_000, direction: 'receivable' });
    const event = store.findEventBySource(db(), `obligation:${item.id}`);
    assert.equal(event.status, 'posted');
    balanced();
  });
});
