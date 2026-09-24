import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * چک — ابزار اصلی پرداخت، و تا امروز بدون چرخهٔ عمر.
 *
 * حساب‌یار چک را ثبت می‌کرد ولی هیچ راهی برای بستنش نبود: «اسناد دریافتنی»
 * تا ابد بدهکار می‌ماند. و بدتر، چکی که بابت طلب قبلی گرفته می‌شد دوباره
 * درآمد شناسایی می‌کرد — همان فروش دو بار در سود دوره و دو بار در مالیات.
 */
const databasePath = tempDatabase('cheques');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'cheque-owner';
process.env.ADMIN_PASSWORD = 'cheque-strong-password-4417';

const database = await import(`../server/db.js?cheque=${process.pid}`);
const accounting = await import(`../server/accounting.js?cheque=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('cheque-owner', 'cheque-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'کارخانهٔ پلاستیک', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

// حساب چک و حساب طرف حساب هر دو به تفکیک شخص‌اند، پس جمعِ همهٔ حساب‌های آن
// نوع گرفته می‌شود — نه اولین حسابی که پیدا شود.
const balanceOfKind = (sourceKind, like = '') => db().prepare(`SELECT COALESCE(SUM(journal_lines.debit)-SUM(journal_lines.credit),0) AS net
  FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
  WHERE ledger_accounts.source_kind=? AND ledger_accounts.name LIKE ?`).get(sourceKind, like ? `%${like}%` : '%').net;
const incomeTotal = () => db().prepare(`SELECT COALESCE(SUM(credit)-SUM(debit),0) AS net FROM journal_lines
  JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id WHERE ledger_accounts.type='income'`).get().net;

test('چک دریافتی بابت فروش تازه، اسناد دریافتنی و درآمد را می‌سازد', () => {
  inWorkspace(() => {
    const cheque = database.recordCheque({
      direction: 'receivable', counterpartyName: 'پخش نوین', amount: 12_000_000,
      dueAt: '2026-12-20T00:00:00.000Z', serial: '۴۴۱۷۸', bankName: 'ملت', category: 'فروش', against: 'income',
    });
    assert.equal(cheque.status, 'open');
    assert.equal(cheque.statusLabel, 'در جریان');
    assert.equal(balanceOfKind('cheque-receivable'), 12_000_000);
    assert.equal(incomeTotal(), 12_000_000);
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

/**
 * وصول، حق دریافت را به پول تبدیل می‌کند — نه درآمد تازه.
 *
 * درآمدش موقع ثبت چک شناسایی شده بود؛ شناسایی دوباره یعنی سود دوره دو برابر.
 */
test('وصول چک، پول می‌آورد و درآمد تازه نمی‌سازد', () => {
  inWorkspace(() => {
    const [open] = database.listCheques({ status: 'open', direction: 'receivable' });
    const before = incomeTotal();
    const cleared = database.clearCheque(open.id, { account: 'cash' });
    assert.equal(cleared.status, 'cleared');
    assert.equal(balanceOfKind('cheque-receivable'), 0, 'اسناد دریافتنی باید بسته شود');
    assert.equal(incomeTotal(), before, 'وصول نباید درآمد بسازد');
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

test('چک وصول‌شده دوباره وصول نمی‌شود', () => {
  inWorkspace(() => {
    const [cleared] = database.listCheques({ status: 'cleared' });
    assert.throws(() => database.clearCheque(cleared.id, { account: 'cash' }), (error) => error.code === 'CHEQUE_NOT_OPEN');
  });
});

/**
 * چک بابت طلب قبلی، درآمد دوباره نمی‌سازد.
 *
 * آن فروش قبلاً درآمد شده است. اینجا فقط شکل طلب عوض می‌شود: از حساب
 * دریافتنی به اسناد دریافتنی.
 */
test('چک بابت طلب قبلی فقط شکل طلب را عوض می‌کند', () => {
  inWorkspace(() => {
    const contact = database.saveContact({ name: 'صنایع آریا' });
    database.saveObligation({ title: 'فروش گرانول', amount: 20_000_000, direction: 'receivable', contactId: contact.id });
    const beforeIncome = incomeTotal();
    assert.equal(balanceOfKind('customer-receivable', 'آریا'), 20_000_000);

    database.recordCheque({
      direction: 'receivable', contactId: contact.id, counterpartyName: 'صنایع آریا',
      amount: 20_000_000, against: 'receivable',
    });
    assert.equal(incomeTotal(), beforeIncome, 'درآمد نباید دوباره شناسایی شود');
    assert.equal(balanceOfKind('customer-receivable', 'آریا'), 0, 'طلب عادی باید بسته شود');
    assert.equal(balanceOfKind('cheque-receivable'), 20_000_000, 'و به اسناد دریافتنی منتقل شود');
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

/**
 * چک برگشتی طلب را از بین نمی‌برد.
 *
 * فقط ابزارش باطل شده؛ مبلغ به حساب دریافتنیِ همان شخص برمی‌گردد و او دوباره
 * بدهکار می‌شود. پاک‌کردن چک به‌جای این کار، طلب را از دفتر حذف می‌کرد.
 */
test('چک برگشتی، بدهی شخص را برمی‌گرداند', () => {
  inWorkspace(() => {
    const [open] = database.listCheques({ status: 'open', direction: 'receivable' });
    const bounced = database.bounceCheque(open.id);
    assert.equal(bounced.status, 'bounced');
    assert.equal(bounced.statusLabel, 'برگشتی');
    assert.equal(balanceOfKind('cheque-receivable'), 0);
    assert.equal(balanceOfKind('customer-receivable', 'آریا'), 20_000_000, 'طلب باید برگردد');
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

test('چک پرداختی، اسناد پرداختنی می‌سازد و با پرداخت بسته می‌شود', () => {
  inWorkspace(() => {
    const cheque = database.recordCheque({
      direction: 'payable', counterpartyName: 'مواد شیمیایی پارس', amount: 6_000_000, category: 'مواد و کالا', against: 'income',
    });
    assert.equal(balanceOfKind('cheque-payable'), -6_000_000, 'اسناد پرداختنی بستانکار می‌شود');
    database.clearCheque(cheque.id, { account: 'cash' });
    assert.equal(balanceOfKind('cheque-payable'), 0);
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

/**
 * حساب چک باید به معین کدینگ نگاشت شود، وگرنه خروجی پارسیان قفل می‌ماند —
 * و این دقیقاً چیزی است که تا امروز اتفاق می‌افتاد، چون نقش چک در جدول
 * نگاشت خودکار نبود.
 */
test('حساب چک خودکار به معین اسناد دریافتنی نگاشت می‌شود', () => {
  inWorkspace(() => {
    database.installChartTemplate();
    database.applyChartSuggestions();
    const row = db().prepare(`SELECT chart_accounts.code AS code FROM ledger_accounts
      JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
      WHERE ledger_accounts.source_kind='cheque-receivable'`).get();
    assert.equal(row?.code, '1203');
  });
});

test.after(() => removeTempDatabase(databasePath));

test('چک بدون پاسخ «بابت چه؟» ثبت نمی‌شود', () => {
  // پیش‌فرض «معاملهٔ تازه» همان فروش را دو بار در درآمد می‌آورد وقتی چک بابت
  // طلب قبلی بود؛ مسیر صدا این را هیچ‌وقت نمی‌پرسید.
  inWorkspace(() => {
    assert.throws(() => database.recordCheque({ direction: 'receivable', counterpartyName: 'پخش نوین', amount: 5_000_000 }),
      /بابت معاملهٔ تازه است یا حساب قبلی/);
  });
});
