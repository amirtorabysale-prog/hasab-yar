import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { extractContactCandidate } from '../shared/counterpartySpeech.js';
import { counterpartyChoice, settlementPreview } from '../shared/counterpartySettlement.js';

/**
 * مردم عنوان نمی‌گویند.
 *
 * «۲۵ میلیون و ۶۸۰ به محسن احتسامی پرداخت شد» هیچ «آقای» و «شرکت»ی ندارد، و
 * مسیر عمومی فقط به همین عنوان‌ها تکیه می‌کرد — پس کل نام دور ریخته می‌شد و
 * ثبت در «سایر هزینه‌ها» می‌نشست، بی‌ربط به کارت حساب او.
 *
 * ولی نامِ بدون عنوان قطعی هم نیست: همان قاعده «به پیک پول دادم» را «پیک
 * پول» می‌خواند. پس برداشته می‌شود و حدسی علامت می‌خورد:
 *
 * - با طرف حسابِ موجود بخواند → بی‌پرسش وصل می‌شود.
 * - نخواند → پرسیده می‌شود، ساخته نمی‌شود.
 */
test('نام بدون عنوان برداشته می‌شود ولی حدسی علامت می‌خورد', () => {
  assert.deepEqual(extractContactCandidate('۲۵ میلیون و ۶۸۰ به محسن احتسامی پرداخت شد'),
    { name: 'محسن احتسامی', confident: false });
  assert.deepEqual(extractContactCandidate('۲۵ میلیون به آقای احتسامی پرداخت شد'),
    { name: 'احتسامی', confident: true });
  assert.deepEqual(extractContactCandidate('دو میلیون تومان قبض برق دادم'),
    { name: '', confident: false });
});

test('نام حدسیِ ناشناخته ساخته نمی‌شود، پرسیده می‌شود', () => {
  const preview = settlementPreview({ contactName: 'پیک پول', type: 'expense', contactNameConfident: false }, []);
  assert.deepEqual(counterpartyChoice(preview), { mode: 'ask', link: false, settlement: 'none' });
});

test('همان نام حدسی، وقتی طرف حساب باشد، بی‌پرسش وصل می‌شود', () => {
  const contacts = [{ id: 'c1', name: 'محسن احتسامی', balance: 0 }];
  const preview = settlementPreview({ contactName: 'محسن احتسامی', type: 'expense', contactNameConfident: false }, contacts);
  assert.equal(preview.contact.id, 'c1');
  assert.deepEqual(counterpartyChoice(preview), { mode: 'link', link: true, settlement: 'none' });
});

test('نام با عنوان، حتی ناشناخته، پیش‌فرضش ساختن کارت است', () => {
  const preview = settlementPreview({ contactName: 'شرکت تازه', type: 'expense', contactNameConfident: true }, []);
  assert.deepEqual(counterpartyChoice(preview), { mode: 'create', link: true, settlement: 'none' });
});

// ---------------------------------------------------------------------------
// و همین رفتار روی دفتر واقعی
// ---------------------------------------------------------------------------
const databasePath = tempDatabase('bare');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'bare-owner';
process.env.ADMIN_PASSWORD = 'bare-strong-password-4417';

const database = await import(`../server/db.js?bare=${process.pid}`);
const { parseFinancialText } = await import(`../shared/parser.js?bare=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('bare-owner', 'bare-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'کارخانه', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

const speak = (sentence, extra = {}) => {
  const [item] = parseFinancialText(sentence, { source: 'voice' }).transactions;
  const [id] = database.insertTransactions({ transcript: sentence, transactions: [{ ...item, ...extra }] });
  return database.getTransaction(id);
};

test('پرداخت به طرف حسابِ موجود، بدون عنوان هم به کارتش می‌رسد', () => {
  inWorkspace(() => {
    database.installChartTemplate();
    const contact = database.saveContact({ name: 'محسن احتسامی' });
    const row = speak('۲۵ میلیون و ۶۸۰ هزار تومان به محسن احتسامی پرداخت شد');
    assert.equal(row.contactId, contact.id, 'باید به همان کارت حساب وصل شود');
    assert.equal(database.counterpartyCard(contact.id).totals.balance, 25_680_000);
  });
});

test('نام حدسیِ ناشناخته، بی‌اجازه کارت حساب نمی‌سازد', () => {
  inWorkspace(() => {
    const before = database.listContacts().length;
    const row = speak('دویست هزار تومان به پیک پول دادم');
    assert.equal(row.contactId, null);
    assert.equal(database.listContacts().length, before);
  });
});

test('ولی با تأیید کاربر، همان نام کارت حساب می‌گیرد', () => {
  inWorkspace(() => {
    const row = speak('یک میلیون تومان به سعید مرادی پرداخت شد', { linkContact: true, contactNameConfident: true });
    assert.ok(row.contactId, 'با تأیید باید ساخته شود');
    assert.equal(row.contactName, 'سعید مرادی');
  });
});

test.after(() => removeTempDatabase(databasePath));
