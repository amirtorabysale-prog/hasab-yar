import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * ویرایش یک ثبت نباید ماهیتش را عوض کند.
 *
 * ویرایش، سند قبلی را معکوس می‌کند و سند تازه می‌زند. ولی «سند تازه» را
 * همیشه از روی دستهٔ درآمد/هزینه می‌ساخت — درحالی‌که سند بعضی ثبت‌ها اصلاً
 * از آن مسیر نیامده بود. نتیجه‌اش دو خطای خاموش بود که جمع سند را هم به هم
 * نمی‌ریختند، پس هیچ کنترلی نمی‌گرفتشان.
 */
const databasePath = tempDatabase('editguard');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'editguard-owner';
process.env.ADMIN_PASSWORD = 'editguard-strong-password-4417';

const database = await import(`../server/db.js?editguard=${process.pid}`);
const accounting = await import(`../server/accounting.js?editguard=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('editguard-owner', 'editguard-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'کارخانهٔ پلاستیک', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const byType = (type) => db().prepare(`SELECT COALESCE(SUM(credit)-SUM(debit),0) AS net FROM journal_lines
  JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id WHERE ledger_accounts.type=?`).get(type).net;

/**
 * آوردهٔ مالک، بعد از ویرایش هم آورده می‌ماند.
 *
 * تا امروز ویرایش مبلغِ آورده، سند سرمایه را معکوس می‌کرد و به‌جایش سند
 * درآمد می‌زد: سود دوره به اندازهٔ کل آورده باد می‌کرد و مالیات روی پول خودِ
 * مالک حساب می‌شد — همان چیزی که کل طراحی «جریان سرمایه» برای جلوگیری از آن
 * ساخته شده بود.
 */
test('ویرایش آورده، سرمایه را به درآمد تبدیل نمی‌کند', () => {
  inWorkspace(() => {
    const entry = database.recordCapitalEntry({ kind: 'capital-in', title: 'آوردهٔ آقای حیدری', amount: 200_000_000 });
    assert.equal(byType('equity'), 200_000_000);
    assert.equal(byType('income'), 0);

    database.updateTransaction(entry.id, { amount: 250_000_000 });

    assert.equal(byType('income'), 0, 'آورده نباید درآمد شود');
    assert.equal(byType('equity'), 250_000_000, 'و مبلغ تازه باید روی سرمایه بنشیند');
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

test('حذف آورده هم سرمایه را برمی‌گرداند، نه درآمد', () => {
  inWorkspace(() => {
    const entry = database.recordCapitalEntry({ kind: 'capital-in', title: 'آوردهٔ دوم', amount: 50_000_000 });
    const before = byType('equity');
    database.deleteTransaction(entry.id);
    assert.equal(byType('equity'), before - 50_000_000);
    assert.equal(byType('income'), 0);
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

/**
 * ویرایش خرید دارایی ثابت هم نباید آن را هزینه کند.
 */
test('ویرایش خرید دارایی ثابت، آن را هزینهٔ دوره نمی‌کند', () => {
  inWorkspace(() => {
    const entry = database.recordCapitalEntry({ kind: 'fixed-asset', title: 'دستگاه تزریق', amount: 300_000_000 });
    const expenseBefore = byType('expense');
    database.updateTransaction(entry.id, { amount: 320_000_000 });
    assert.equal(byType('expense'), expenseBefore, 'دارایی ثابت هزینهٔ دوره نیست');
    const asset = db().prepare(`SELECT COALESCE(SUM(debit)-SUM(credit),0) AS net FROM journal_lines
      JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE ledger_accounts.source_kind='fixed-asset'`).get().net;
    assert.equal(asset, 320_000_000);
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

/**
 * تسویهٔ یک تعهد فقط پول را جابه‌جا می‌کند.
 *
 * ویرایش آن ردیف، سند تسویه را معکوس می‌کرد و به‌جایش سند درآمد می‌زد: همان
 * فروش دو بار در سود دوره. حالا مثل تسویهٔ فاکتور قفل است و از خودِ تعهد
 * اصلاح می‌شود.
 */
test('ثبتِ ساخته‌شده از تسویهٔ تعهد، جداگانه ویرایش نمی‌شود', () => {
  inWorkspace(() => {
    const contact = database.saveContact({ name: 'شرکت آریا' });
    const item = database.saveObligation({ title: 'طلب آریا', amount: 10_000_000, direction: 'receivable', contactId: contact.id });
    const incomeBefore = byType('income');
    const { transaction } = database.settleObligation(item.id, { amount: 10_000_000 });

    assert.equal(byType('income'), incomeBefore, 'تسویه درآمد تازه نمی‌سازد');
    assert.throws(() => database.updateTransaction(transaction.id, { amount: 4_000_000 }),
      (error) => error.code === 'ALLOCATED_TRANSACTION_LOCKED');
    assert.equal(byType('income'), incomeBefore, 'و بعد از تلاش برای ویرایش هم نمی‌سازد');
  });
});

test('ثبت عادی مثل قبل ویرایش می‌شود', () => {
  inWorkspace(() => {
    const [id] = database.insertTransactions({
      transcript: 'قبض برق',
      transactions: [{ amount: 3_000_000, type: 'expense', category: 'قبوض و انرژی', rawText: 'قبض برق' }],
    });
    const before = byType('expense');
    database.updateTransaction(id, { amount: 4_000_000 });
    // هزینه بدهکار است، پس در این تابعِ «بستانکار منهای بدهکار» منفی می‌شود.
    assert.equal(byType('expense'), before - 1_000_000);
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

test.after(() => removeTempDatabase(databasePath));
