import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * تسویهٔ دورهٔ ارزش افزوده.
 *
 * ارزش افزوده هزینهٔ شرکت نیست؛ پول سازمان است که شرکت فقط جمعش کرده. بدون
 * تسویه، دو حساب ارزش افزوده تا ابد بزرگ می‌شوند — بدهی فروش و اعتبار خرید
 * هیچ‌وقت خنثی نمی‌شوند و ترازنامه هر دو را باد می‌کند. و وقتی شرکت واقعاً
 * مالیات را می‌پردازد، آن پرداخت جایی جز «هزینه» نمی‌نشیند و سود دوره را
 * بی‌دلیل کم می‌کند.
 */
const databasePath = tempDatabase('vat');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'vat-owner';
process.env.ADMIN_PASSWORD = 'vat-strong-password-4417';

const database = await import(`../server/db.js?vat=${process.pid}`);
const accounting = await import(`../server/accounting.js?vat=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('vat-owner', 'vat-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'کارخانهٔ پلاستیک', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const invoice = (documentType, unitPrice, tax) => {
  const created = database.createInvoice({
    documentType, customerName: documentType === 'purchase' ? 'مواد پارس' : 'پخش نوین', tax,
    items: [{ title: documentType === 'purchase' ? 'گرانول' : 'نایلون', quantity: 1, unitPrice }],
  });
  return database.issueInvoice(created.id);
};

test('بدون تسویه، دو حساب ارزش افزوده روی هم جمع می‌شوند', () => {
  inWorkspace(() => {
    invoice('sales', 100_000_000, 10_000_000);
    invoice('purchase', 40_000_000, 4_000_000);
    const ledger = accounting.vatBalances(db());
    assert.equal(ledger.outputTax, 10_000_000);
    assert.equal(ledger.inputTax, 4_000_000);
  });
});

test('تسویه، اعتبار خرید را خنثی می‌کند و فقط خالص را می‌پردازد', () => {
  inWorkspace(() => {
    const result = database.settleVatPeriod({ account: 'cash' });
    assert.equal(result.outputTax, 10_000_000);
    assert.equal(result.offset, 4_000_000);
    assert.equal(result.paid, 6_000_000, 'فقط خالص پرداخت می‌شود، نه کل مالیات فروش');
    assert.equal(result.carriedForward, 0);

    const after = accounting.vatBalances(db());
    assert.equal(after.outputTax, 0);
    assert.equal(after.inputTax, 0);
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

// پرداخت ارزش افزوده نباید سود دوره را کم کند: پول سازمان بود، نه هزینهٔ شرکت.
test('تسویه هیچ هزینه‌ای نمی‌سازد', () => {
  inWorkspace(() => {
    const expense = db().prepare(`SELECT COALESCE(SUM(debit)-SUM(credit),0) AS net FROM journal_lines
      JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE ledger_accounts.type='expense'`).get().net;
    invoice('sales', 50_000_000, 5_000_000);
    database.settleVatPeriod({ account: 'cash' });
    const after = db().prepare(`SELECT COALESCE(SUM(debit)-SUM(credit),0) AS net FROM journal_lines
      JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE ledger_accounts.type='expense'`).get().net;
    assert.equal(after, expense, 'تسویهٔ ارزش افزوده نباید به هزینه بنشیند');
  });
});

/**
 * اعتبار اضافی منتقل می‌شود، نه مطالبه.
 *
 * وقتی خرید بیشتر از فروش بوده، فقط به اندازهٔ بدهی فروش خنثی می‌شود و باقی
 * اعتبار برای دورهٔ بعد می‌ماند — همان کاری که در عمل انجام می‌شود.
 */
test('اعتبار بیشتر از بدهی، به دورهٔ بعد منتقل می‌شود', () => {
  inWorkspace(() => {
    invoice('purchase', 80_000_000, 8_000_000);
    invoice('sales', 20_000_000, 2_000_000);
    const result = database.settleVatPeriod({ account: 'cash' });
    assert.equal(result.paid, 0, 'وقتی اعتبار بیشتر است، پرداختی در کار نیست');
    assert.equal(result.carriedForward, 6_000_000);
    const after = accounting.vatBalances(db());
    assert.equal(after.outputTax, 0);
    assert.equal(after.inputTax, 6_000_000, 'اعتبار باقی باید بماند');
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

test('وقتی بدهی ارزش افزوده صفر است، تسویه‌ای ثبت نمی‌شود', () => {
  inWorkspace(() => {
    assert.throws(() => database.settleVatPeriod({ account: 'cash' }), (error) => error.code === 'VAT_NOTHING_TO_SETTLE');
  });
});

test.after(() => removeTempDatabase(databasePath));
