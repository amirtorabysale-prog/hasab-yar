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
