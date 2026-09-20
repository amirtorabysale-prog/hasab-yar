import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * تسویهٔ جزئی — قاعده است، نه استثنا.
 *
 * مشتری سی درصد می‌دهد و بقیه را ماه بعد. تا پیش از این تعهد یا کامل بسته
 * می‌شد یا اصلاً؛ پس دفتر مجبور بود یا طلب را زودتر از موعد ببندد — و ماندهٔ
 * واقعی را از دست بدهد — یا پرداخت واقعی را جایی ثبت نکند و پول دریافتی در
 * صندوق بی‌سند بماند.
 */
const databasePath = tempDatabase('partial');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'partial-owner';
process.env.ADMIN_PASSWORD = 'partial-strong-password-4417';

const database = await import(`../server/db.js?partial=${process.pid}`);
const accounting = await import(`../server/accounting.js?partial=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('partial-owner', 'partial-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'کارخانهٔ پلاستیک', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const receivableOf = (contactName) => {
  const account = db().prepare(`SELECT id FROM ledger_accounts WHERE source_kind='customer-receivable' AND name LIKE ?`).get(`%${contactName}%`);
  return account ? db().prepare('SELECT COALESCE(SUM(debit)-SUM(credit),0) AS net FROM journal_lines WHERE account_id=?').get(account.id).net : null;
};

test('طلب ده‌میلیونی با سه‌میلیون تسویه، هفت‌میلیون مانده می‌ماند', () => {
  inWorkspace(() => {
    const contact = database.saveContact({ name: 'پلاستیک سازان' });
    const item = database.saveObligation({ title: 'فروش نایلون', amount: 10_000_000, direction: 'receivable', contactId: contact.id });
    assert.equal(receivableOf('پلاستیک سازان'), 10_000_000);

    const first = database.settleObligation(item.id, { amount: 3_000_000 });
    assert.equal(first.item.status, 'open', 'تعهدِ نیمه‌تسویه هنوز باز است');
    assert.equal(first.item.paidAmount, 3_000_000);
    assert.equal(first.item.remaining, 7_000_000);
    assert.equal(receivableOf('پلاستیک سازان'), 7_000_000, 'حساب دریافتنی باید دقیقاً به اندازهٔ دریافتی کم شود');
    assert.equal(accounting.trialBalance(db()).balanced, true);

    const second = database.settleObligation(item.id, { amount: 7_000_000 });
    assert.equal(second.item.status, 'paid');
    assert.equal(second.item.remaining, 0);
    assert.equal(receivableOf('پلاستیک سازان'), 0);
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

test('تسویهٔ بدون مبلغ، همان ماندهٔ باقی را می‌بندد', () => {
  inWorkspace(() => {
    const item = database.saveObligation({ title: 'بدهی به تأمین‌کننده', amount: 5_000_000, direction: 'payable' });
    database.settleObligation(item.id, { amount: 2_000_000 });
    const closed = database.settleObligation(item.id, {});
    assert.equal(closed.item.status, 'paid');
    assert.equal(closed.item.paidAmount, 5_000_000);
  });
});

// پرداختی بیشتر از مانده یعنی یا مبلغ اشتباه تایپ شده یا تعهد اشتباهی
// انتخاب شده. هر دو حالت باید جلویش گرفته شود، نه اینکه حساب منفی شود.
test('تسویهٔ بیشتر از مانده پذیرفته نمی‌شود', () => {
  inWorkspace(() => {
    const item = database.saveObligation({ title: 'طلب کوچک', amount: 1_000_000, direction: 'receivable' });
    assert.throws(() => database.settleObligation(item.id, { amount: 1_500_000 }), /مانده/);
    assert.equal(database.listObligations({ status: 'open' }).find((row) => row.id === item.id).remaining, 1_000_000);
  });
});

test('تسویهٔ صفر یا منفی رد می‌شود', () => {
  inWorkspace(() => {
    const item = database.saveObligation({ title: 'طلب دیگر', amount: 2_000_000, direction: 'receivable' });
    assert.throws(() => database.settleObligation(item.id, { amount: 0 }), /بیشتر از صفر|مبلغ/);
  });
});

/**
 * هر پرداخت سند خودش را دارد.
 *
 * اگر شناسهٔ منبع بین پرداخت‌ها مشترک بماند، لایهٔ رویداد پرداخت دوم را
 * «همان قبلی» می‌شناسد و سندی نمی‌زند: پول در صندوق می‌آید و طلب کم
 * نمی‌شود.
 */
test('دو پرداخت، دو سند جدا می‌سازند', () => {
  inWorkspace(() => {
    const contact = database.saveContact({ name: 'شیمی گستر' });
    const item = database.saveObligation({ title: 'طلب دوقسطی', amount: 8_000_000, direction: 'receivable', contactId: contact.id });
    database.settleObligation(item.id, { amount: 4_000_000 });
    database.settleObligation(item.id, { amount: 4_000_000 });
    const entries = db().prepare(`SELECT COUNT(*) AS count FROM journal_entries
      WHERE memo LIKE '%طلب دوقسطی%' OR memo LIKE '%تسویه%'`).get().count;
    assert.ok(entries >= 2, `دو پرداخت باید دو سند بسازند، نه ${entries}`);
    assert.equal(receivableOf('شیمی گستر'), 0);
  });
});

test.after(() => removeTempDatabase(databasePath));
