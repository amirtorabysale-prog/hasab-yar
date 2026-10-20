import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { counterpartyChoice, settlementPreview } from '../shared/counterpartySettlement.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

/**
 * نامی که در جمله گفته می‌شود باید به کارت حساب همان شخص برسد.
 *
 * کاربر چند بار گفت «۲۵ میلیون به آقای اعتصامی پرداخت داشتیم» و ثبت در
 * «سایر هزینه‌ها» نشست، بی‌آنکه به کارت او وصل شود. نام درست شنیده می‌شد و
 * درست هم استخراج می‌شد؛ چیزی که نبود، یک تصمیمِ صریح بود: وصل بشود یا نه، و
 * اگر شخص تازه است کارت برایش ساخته شود یا نه.
 *
 * حالا هر سه حالت پیش‌فرض دارند و هر سه روی برگه پرسیده می‌شوند — و انتخاب
 * کاربر تا لحظهٔ ثبت سند زنده می‌ماند، حتی اگر ثبت به صف بررسی برود.
 */
const databasePath = tempDatabase('choice');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'choice-owner';
process.env.ADMIN_PASSWORD = 'choice-strong-password-4417';

const database = await import(`../server/db.js?choice=${process.pid}`);
const { parseFinancialText } = await import(`../shared/parser.js?choice=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('choice-owner', 'choice-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'کارخانهٔ پلاستیک', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id, overdraftApproval: FIXTURE_OVERDRAFT }, callback);
const db = () => database.activeWorkspaceDatabase();

function postedLines(transactionId) {
  const pending = db().prepare('SELECT id,status FROM financial_events WHERE source_event_id=?').get(`transaction:${transactionId}`);
  if (pending && pending.status !== 'posted') database.approveEvent(pending.id);
  return db().prepare(`SELECT ledger_accounts.source_kind AS kind,journal_lines.debit,journal_lines.credit
    FROM journal_lines JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
    JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
    WHERE journal_entries.source_type='transaction' AND journal_entries.source_id=?`).all(transactionId);
}

const speak = (sentence, extra = {}) => {
  const [item] = parseFinancialText(sentence, { source: 'voice' }).transactions;
  const [id] = database.insertTransactions({ transcript: sentence, transactions: [{ ...item, ...extra }] });
  return { id, item };
};

test('نام گفته‌شده به کارت حساب همان شخص وصل می‌شود، حتی وقتی تازه است', () => {
  inWorkspace(() => {
    database.installChartTemplate();
    const { id, item } = speak('۲۵ میلیون و ۶۸۰ هزار تومان به آقای اعتصامی پرداخت داشتیم');
    assert.equal(item.contactName, 'اعتصامی', 'نام باید از جمله برداشته شود');

    const row = database.getTransaction(id);
    assert.ok(row.contactId, 'ثبت باید به یک طرف حساب وصل شده باشد');
    assert.equal(row.contactName, 'اعتصامی');

    // و کارت حسابش همین گردش را نشان می‌دهد.
    const card = database.counterpartyCard(row.contactId);
    assert.equal(card.lines.length, 1);
    assert.equal(card.totals.balance, 25_680_000, 'پرداخت به او، او را بدهکار ما می‌کند');
  });
});

/**
 * ولی اگر کاربر بگوید «این ثبت طرف حساب ندارد»، نامی که شنیده شده هم نباید
 * پشت سرش کارت حساب بسازد.
 */
test('انتخاب «بدون طرف حساب» جلوی ساخت کارت را می‌گیرد', () => {
  inWorkspace(() => {
    const before = database.listContacts().length;
    const { id } = speak('سه میلیون تومان به آقای رضایی پرداخت شد', { linkContact: false });
    assert.equal(database.getTransaction(id).contactId, null);
    assert.equal(database.listContacts().length, before, 'طرف حساب تازه‌ای ساخته نمی‌شود');
  });
});

test('پرداخت به بدهکار، بدهی‌اش را می‌بندد', () => {
  inWorkspace(() => {
    const contact = database.saveContact({ name: 'شرکت آراد گستر آسیا' });
    database.saveObligation({ title: 'خرید مواد', amount: 100_000_000, direction: 'payable', contactId: contact.id });
    const { id } = speak('چهل میلیون تومان به شرکت آراد گستر آسیا پرداخت شد');
    const lines = postedLines(id);
    assert.ok(lines.some((line) => line.kind === 'vendor-payable'), JSON.stringify(lines));
    assert.equal(database.counterpartyCard(contact.id).totals.balance, -60_000_000);
  });
});

/**
 * انتخاب صریحِ «هزینهٔ عادی» بر ماندهٔ دفتر مقدم است.
 *
 * شاید واقعاً هزینه‌ای جدا بوده و ربطی به آن بدهی نداشته. حدس ما حق ندارد
 * روی چیزی که کاربر دیده و گفته بنویسد.
 */
test('انتخاب «هزینهٔ عادی» بر حدس ما مقدم است', () => {
  inWorkspace(() => {
    const contact = database.listContacts().find((row) => row.name === 'شرکت آراد گستر آسیا');
    const before = database.counterpartyCard(contact.id).totals.balance;
    const { id } = speak('پنج میلیون تومان به شرکت آراد گستر آسیا پرداخت شد', { settlement: 'none' });
    const lines = postedLines(id);
    assert.ok(lines.some((line) => line.kind === 'expense-category'), 'باید هزینه بماند');
    assert.ok(!lines.some((line) => line.kind === 'vendor-payable'), 'و به بدهی‌اش نخورد');
    // ولی هنوز در کارتش دیده می‌شود، چون به او وصل است.
    assert.equal(database.counterpartyCard(contact.id).totals.balance, before + 5_000_000);
  });
});

/**
 * انتخاب باید تا لحظهٔ ثبت سند زنده بماند.
 *
 * مبلغ غیرعادی ثبت را به صف بررسی می‌برد؛ اگر انتخاب آنجا گم شود، سند در
 * لحظهٔ تأیید دوباره حدس زده می‌شود و خلاف چیزی که کاربر گفته ثبت می‌شود.
 */
test('انتخاب کاربر از صف بررسی هم سالم بیرون می‌آید', () => {
  inWorkspace(() => {
    const contact = database.listContacts().find((row) => row.name === 'شرکت آراد گستر آسیا');
    const { id } = speak('نهصد میلیون تومان به شرکت آراد گستر آسیا پرداخت شد', { settlement: 'none' });
    assert.equal(db().prepare('SELECT settlement_choice AS choice FROM transactions WHERE id=?').get(id).choice, 'none');
    const lines = postedLines(id);
    assert.ok(lines.some((line) => line.kind === 'expense-category'), JSON.stringify(lines));
    void contact;
  });
});

// پیش‌فرض‌ها همان چیزی‌اند که برگه نشان می‌دهد.
test('پیش‌فرض هر سه حالت روشن است', () => {
  const contacts = [{ id: 'c1', name: 'شرکت الف', balance: -50_000_000 }, { id: 'c2', name: 'شرکت ب', balance: 0 }];
  const known = settlementPreview({ contactName: 'شرکت الف', type: 'expense' }, contacts);
  assert.deepEqual(counterpartyChoice(known), { mode: 'settle', link: true, settlement: 'payable' });

  const flat = settlementPreview({ contactName: 'شرکت ب', type: 'expense' }, contacts);
  assert.deepEqual(counterpartyChoice(flat), { mode: 'link', link: true, settlement: 'none' });

  const fresh = settlementPreview({ contactName: 'آقای اعتصامی', type: 'expense' }, contacts);
  assert.deepEqual(counterpartyChoice(fresh), { mode: 'create', link: true, settlement: 'none' });

  assert.equal(counterpartyChoice(null), null);
});

test.after(() => removeTempDatabase(databasePath));
