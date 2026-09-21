import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * کارت حساب، فهرست اشخاص و دفتر باید یک عدد بگویند.
 *
 * کارت از دفتر کل می‌خواند و فهرست از جدول تعهد. بعد از تسویهٔ جزئی، دفتر
 * ماندهٔ واقعی را نشان می‌داد ولی فهرست هنوز مبلغ اولیهٔ تعهد را — و کارت
 * اختلافشان را «توضیح‌داده‌نشده» اعلام می‌کرد: اختلافی که اصلاً وجود نداشت.
 *
 * برای حسابداری که کارت حساب را باز می‌کند تا بگوید فلانی چقدر بدهکار است،
 * این بدترین حالت است: دو عدد متفاوت، و هیچ‌کدام معلوم نیست کدام درست است.
 */
const databasePath = tempDatabase('card');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'card-owner';
process.env.ADMIN_PASSWORD = 'card-strong-password-4417';

const database = await import(`../server/db.js?card=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('card-owner', 'card-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'کارخانهٔ پلاستیک', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

const view = (contactId) => {
  const listed = database.listContacts().find((item) => item.id === contactId);
  const card = database.counterpartyCard(contactId);
  return {
    listed: listed.balance,
    ledger: card.reconciliation.ledger,
    documents: card.reconciliation.documents,
    unexplained: card.reconciliation.unexplained,
    closing: card.totals.balance,
  };
};

test('تسویهٔ جزئی در هر سه جا یک‌جور دیده می‌شود', () => {
  inWorkspace(() => {
    database.installChartTemplate();
    const contact = database.saveContact({ name: 'شرکت آراد گستر آسیا' });
    const item = database.saveObligation({
      title: 'فروش گرانول', amount: 10_000_000, direction: 'receivable', contactId: contact.id,
    });

    assert.deepEqual(view(contact.id), {
      listed: 10_000_000, ledger: 10_000_000, documents: 10_000_000, unexplained: 0, closing: 10_000_000,
    });

    database.settleObligation(item.id, { amount: 3_000_000 });
    assert.deepEqual(view(contact.id), {
      listed: 7_000_000, ledger: 7_000_000, documents: 7_000_000, unexplained: 0, closing: 7_000_000,
    }, 'بعد از پرداخت سه میلیون، هر سه باید هفت میلیون بگویند');

    database.settleObligation(item.id, { amount: 7_000_000 });
    assert.deepEqual(view(contact.id), {
      listed: 0, ledger: 0, documents: 0, unexplained: 0, closing: 0,
    }, 'تسویهٔ کامل یعنی صفر — در هر سه جا');
  });
});

/**
 * کارت باید خودِ گردش را نشان بدهد، نه فقط یک عدد.
 *
 * حسابدار می‌خواهد ببیند این مانده از کجا آمده: چه سندی بدهکارش کرد و چه
 * پرداختی بستانکار.
 */
test('کارت، هر حرکت را با ماندهٔ تجمعی نشان می‌دهد', () => {
  inWorkspace(() => {
    const contact = database.saveContact({ name: 'پخش البرز' });
    const item = database.saveObligation({
      title: 'فروش نایلون', amount: 8_000_000, direction: 'receivable', contactId: contact.id,
    });
    database.settleObligation(item.id, { amount: 5_000_000 });

    const card = database.counterpartyCard(contact.id);
    assert.equal(card.lines.length, 2);
    assert.deepEqual(card.lines.map((line) => [line.debit, line.credit, line.balance]), [
      [8_000_000, 0, 8_000_000],
      [0, 5_000_000, 3_000_000],
    ]);
    assert.equal(card.totals.balance, 3_000_000);
  });
});

/**
 * چکی که بابت طلب گرفته می‌شود، طلب را از بین نمی‌برد — شکلش را عوض می‌کند.
 * کارت باید هر دو طرف این جابه‌جایی را نشان بدهد، وگرنه حسابدار فکر می‌کند
 * پول رسیده است.
 */
test('چک بابت طلب، در کارت همان شخص دیده می‌شود', () => {
  inWorkspace(() => {
    const contact = database.saveContact({ name: 'صنایع آریا' });
    database.saveObligation({ title: 'فروش لوله', amount: 12_000_000, direction: 'receivable', contactId: contact.id });
    database.recordCheque({
      direction: 'receivable', contactId: contact.id, counterpartyName: 'صنایع آریا',
      amount: 12_000_000, against: 'receivable',
    });

    const card = database.counterpartyCard(contact.id);
    // طلب عادی بسته شد، ولی اسناد دریافتنی باز است: مجموع همان ۱۲ میلیون.
    assert.equal(card.totals.balance, 12_000_000, 'چک، طلب را از بین نمی‌برد');
    assert.ok(card.accounts.some((account) => account.sourceKind === 'cheque-receivable'),
      'حساب اسناد دریافتنی باید در کارت همین شخص باشد');
  });
});

test.after(() => removeTempDatabase(databasePath));
