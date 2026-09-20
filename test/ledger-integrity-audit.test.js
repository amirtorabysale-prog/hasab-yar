import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * بازرسی یکپارچگی دفتر — سه نشتی که از چشم آزمون‌های قبلی رد شده بودند.
 *
 * هر سه از یک جنس‌اند: سند درست ثبت می‌شد و جمع بدهکار و بستانکارش هم برابر
 * بود، ولی چیزی از سطر گم می‌شد یا دو بار می‌آمد. چنین خطایی در تراز کل دیده
 * نمی‌شود؛ فقط وقتی بیرون می‌زند که حسابدار دفتر تفصیلی را باز کند یا فایل را
 * در پارسیان بگذارد — یعنی دیرترین و بدترین لحظهٔ ممکن.
 */
const databasePath = tempDatabase('integrity');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'integrity-owner';
process.env.ADMIN_PASSWORD = 'integrity-strong-password-4417';

const database = await import(`../server/db.js?integrity=${process.pid}`);
const store = await import(`../server/financialEventStore.js?integrity=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('integrity-owner', 'integrity-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'کارخانهٔ پلاستیک', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const linesOf = (entryId) => db().prepare(`SELECT account_id AS accountId,debit,credit,analytic_id AS analyticId,
  cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=? ORDER BY rowid`).all(entryId);

/**
 * سند معکوس باید تفصیلی را با خودش ببرد.
 *
 * ستون‌ها در پرس‌وجو خوانده می‌شدند و در نگاشت کنار می‌افتادند. نتیجه: بدهی
 * «شرکت الف» در دفتر تفصیلی باز می‌ماند حتی بعد از ابطال، و در پارسیان همان
 * سطرِ بی‌تفصیلی روی معینِ تفصیلی‌دار کنار گذاشته می‌شد و سند نامتوازن
 * می‌آمد. جمع کل سند درست بود، پس هیچ کنترلی آن را نمی‌گرفت.
 */
test('سند معکوس، تفصیلی هر آرتیکل را نگه می‌دارد', () => {
  inWorkspace(() => {
    const contact = database.saveContact({ name: 'شرکت الف' });
    const item = database.saveObligation({ title: 'طلب معکوس', amount: 5_000_000, direction: 'receivable', contactId: contact.id });
    const event = store.findEventBySource(db(), `obligation:${item.id}`);
    assert.ok(event?.journalEntryId, 'تعهد باید سند خورده باشد');
    const original = linesOf(event.journalEntryId);
    const receivable = original.find((line) => line.analyticId);
    assert.ok(receivable, 'سطر دریافتنی باید تفصیلی داشته باشد');

    database.reverseEvent(event.id, 'اشتباه ثبت');
    const reversal = db().prepare("SELECT id FROM journal_entries WHERE reverses_entry_id=?").get(event.journalEntryId);
    assert.ok(reversal, 'سند معکوس باید ساخته شود');
    const mirrored = linesOf(reversal.id);
    assert.equal(mirrored.length, original.length);
    assert.ok(mirrored.some((line) => line.analyticId === receivable.analyticId && line.credit === receivable.debit),
      'سطر معکوسِ دریافتنی باید همان تفصیلی را داشته باشد');

    // و در دفتر تفصیلی، مانده‌اش دقیقاً صفر می‌شود.
    const net = db().prepare('SELECT COALESCE(SUM(debit)-SUM(credit),0) AS net FROM journal_lines WHERE analytic_id=?')
      .get(receivable.analyticId).net;
    assert.equal(net, 0, 'طلبِ ابطال‌شده نباید در دفتر تفصیلی باز بماند');
  });
});

/**
 * یک مشتری، یک حساب.
 *
 * مسیر فاکتور حساب را با شناسهٔ شخص کلید می‌زد و مسیر رویداد با نامش. یک
 * مشتری بسته به ترتیب ثبت، دو حساب دریافتنیِ هم‌نام پیدا می‌کرد: مانده‌اش
 * نصف اینجا و نصف آنجا، و در صورت‌حساب دو ردیف جدا.
 */
test('طلب و فاکتورِ یک مشتری روی یک حساب می‌نشینند', () => {
  inWorkspace(() => {
    const contact = database.saveContact({ name: 'پخش البرز' });
    database.saveObligation({ title: 'طلب اول', amount: 3_000_000, direction: 'receivable', contactId: contact.id });
    const invoice = database.createInvoice({
      documentType: 'sales', contactId: contact.id, tax: 0,
      items: [{ title: 'فروش نایلون', quantity: 1, unitPrice: 7_000_000 }],
    });
    database.issueInvoice(invoice.id);

    const accounts = db().prepare(`SELECT id,name,source_key AS sourceKey FROM ledger_accounts
      WHERE source_kind='customer-receivable' AND name LIKE '%البرز%'`).all();
    assert.equal(accounts.length, 1, `یک مشتری نباید دو حساب دریافتنی داشته باشد: ${JSON.stringify(accounts)}`);
    const net = db().prepare('SELECT COALESCE(SUM(debit)-SUM(credit),0) AS net FROM journal_lines WHERE account_id=?')
      .get(accounts[0].id).net;
    assert.equal(net, 10_000_000, 'هر دو مبلغ باید روی همان یک حساب جمع شوند');
  });
});

/**
 * افتتاحیه به مقصد برنمی‌گردد.
 *
 * ماندهٔ افتتاحیه از خودِ نرم‌افزار دفتر آمده و همان مانده آنجا هست. اگر در
 * بسته بیاید، دارایی و سرمایه دو برابر می‌شوند و هیچ‌کس هم نمی‌فهمد چرا.
 */
test('ماندهٔ افتتاحیه در بستهٔ انتقال نیست ولی گزارش می‌شود', () => {
  inWorkspace(() => {
    database.installChartTemplate();
    database.importOpeningBalanceFile(Buffer.from(
      ['کد حساب,بدهکار,بستانکار', '1101,9000000,', '5101,,9000000'].join('\n'), 'utf8',
    ), 'trial.csv', { amountUnit: 'toman' });
    database.insertTransactions({
      transcript: 'فروش نقدی',
      transactions: [{ amount: 1_000_000, type: 'income', category: 'فروش', rawText: 'فروش نقدی' }],
    });
    database.applyChartSuggestions();

    const overview = database.accountingTransferOverview('', 'generic-csv');
    const excluded = overview.readiness.checks.find((item) => item.id === 'opening-excluded');
    assert.ok(excluded && excluded.count > 0, 'کنار گذاشتن افتتاحیه باید گزارش شود');
    assert.equal(excluded.severity, 'advisory', 'این یک اطلاع است، نه ایراد');
    // جمع بسته دقیقاً «همه‌چیز منهای افتتاحیه» است — نه بیشتر، نه کمتر.
    const all = db().prepare('SELECT COALESCE(SUM(debit),0) AS total FROM journal_lines').get().total;
    const opening = db().prepare(`SELECT COALESCE(SUM(journal_lines.debit),0) AS total FROM journal_lines
      JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
      WHERE journal_entries.entry_kind='opening'`).get().total;
    assert.ok(opening >= 9_000_000, 'افتتاحیه باید در دفتر ثبت شده باشد');
    assert.equal(overview.readiness.debitTotal, all - opening);
  });
});

test.after(() => removeTempDatabase(databasePath));
