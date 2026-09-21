import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * پول باید جایی برود که واقعاً رفته — نه به «سایر هزینه‌ها» و «صندوق».
 *
 * دو شکایت واقعی کاربر، هر دو از یک جنس: حساب‌یار چیزی را که در جمله صریح
 * گفته شده بود نادیده می‌گرفت و همه‌چیز را به دستهٔ عمومی و صندوق می‌بست.
 */
const databasePath = tempDatabase('routing');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'routing-owner';
process.env.ADMIN_PASSWORD = 'routing-strong-password-4417';

const database = await import(`../server/db.js?routing=${process.pid}`);
const { parseFinancialText } = await import(`../shared/parser.js?routing=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('routing-owner', 'routing-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'کارخانهٔ پلاستیک', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

/** سند نهاییِ یک ثبت — بعد از تأیید، اگر منتظر مانده باشد. */
function postedLines(transactionId) {
  const pending = db().prepare('SELECT id,status FROM financial_events WHERE source_event_id=?').get(`transaction:${transactionId}`);
  if (pending && pending.status !== 'posted') database.approveEvent(pending.id);
  return db().prepare(`SELECT ledger_accounts.name AS account,ledger_accounts.source_kind AS kind,
    journal_lines.debit,journal_lines.credit
    FROM journal_lines JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
    JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
    WHERE journal_entries.source_type='transaction' AND journal_entries.source_id=?
    ORDER BY journal_lines.rowid`).all(transactionId);
}

const speak = (sentence) => {
  const [item] = parseFinancialText(sentence, { source: 'voice' }).transactions;
  const [id] = database.insertTransactions({ transcript: sentence, transactions: [item] });
  return { id, item };
};

/**
 * پرداخت به کسی که به او بدهکاریم، هزینه نیست.
 *
 * ثبتش به‌عنوان هزینه دو خطا با هم دارد: سود دوره بی‌دلیل کم می‌شود، و بدهی
 * آن شرکت در دفتر باز می‌ماند انگار پولی نداده‌ایم.
 */
test('پرداخت به تأمین‌کننده‌ای که به او بدهکاریم، بدهی‌اش را می‌بندد', () => {
  inWorkspace(() => {
    database.installChartTemplate();
    const contact = database.saveContact({ name: 'شرکت آراد گستر آسیا' });
    database.saveObligation({ title: 'خرید گرانول', amount: 120_000_000, direction: 'payable', contactId: contact.id });

    const { id, item } = speak('نود و سه میلیون تومان به شرکت آراد گستر آسیا پرداخت شد');
    assert.equal(item.contactName, 'شرکت آراد گستر آسیا', 'نام شرکت باید از خود جمله برداشته شود');

    const lines = postedLines(id);
    assert.deepEqual(lines.map((line) => line.kind), ['vendor-payable', 'operational-account']);
    assert.equal(lines[0].debit, 93_000_000);
    assert.ok(!lines.some((line) => line.kind === 'expense-category'), 'هیچ هزینه‌ای ساخته نمی‌شود');

    // و ماندهٔ شرکت دقیقاً همان‌قدر کم می‌شود — در فهرست و در کارت، یک عدد.
    assert.equal(database.listContacts().find((row) => row.id === contact.id).balance, -27_000_000);
    assert.equal(database.counterpartyCard(contact.id).totals.balance, -27_000_000);
  });
});

/**
 * ولی پرداخت به کسی که حسابش صاف است، هزینه می‌ماند.
 *
 * وگرنه هر خریدِ نقدی از یک فروشندهٔ شناخته‌شده، به‌جای هزینه یک طلب از او
 * می‌ساخت — و سود دوره هیچ‌وقت درست نمی‌شد.
 */
test('پرداخت به طرف حسابی که بدهی‌اش صفر است، هزینهٔ عادی می‌ماند', () => {
  inWorkspace(() => {
    database.saveContact({ name: 'شرکت پاک‌سازان البرز' });
    const { id } = speak('سه میلیون تومان به شرکت پاک‌سازان البرز پرداخت شد');
    const lines = postedLines(id);
    assert.ok(lines.some((line) => line.kind === 'expense-category'), 'باید هزینه بماند');
    assert.ok(!lines.some((line) => line.kind === 'vendor-payable'));
  });
});

test('دریافت از بدهکار، طلبش را کم می‌کند نه اینکه درآمد بسازد', () => {
  inWorkspace(() => {
    const contact = database.saveContact({ name: 'شرکت پخش البرز' });
    database.saveObligation({ title: 'فروش نایلون', amount: 40_000_000, direction: 'receivable', contactId: contact.id });
    const before = db().prepare(`SELECT COALESCE(SUM(credit)-SUM(debit),0) AS net FROM journal_lines
      JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id WHERE ledger_accounts.type='income'`).get().net;

    const { id } = speak('از شرکت پخش البرز پانزده میلیون تومان دریافت شد');
    const lines = postedLines(id);
    assert.ok(lines.some((line) => line.kind === 'customer-receivable'), JSON.stringify(lines));

    const after = db().prepare(`SELECT COALESCE(SUM(credit)-SUM(debit),0) AS net FROM journal_lines
      JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id WHERE ledger_accounts.type='income'`).get().net;
    assert.equal(after, before, 'وصول طلب درآمد تازه نمی‌سازد');
    assert.equal(database.counterpartyCard(contact.id).totals.balance, 25_000_000);
  });
});

/**
 * بانکی که در جمله گفته شده، باید از حساب همان بانک کم شود.
 *
 * نشستن همه‌چیز روی صندوق یعنی آخر ماه ماندهٔ صندوق و بانک هر دو غلط است و
 * تطبیق بانکی هیچ‌وقت نمی‌خواند.
 */
test('هزینه‌ای که با نام بانک گفته شود، از حساب همان بانک کم می‌شود', () => {
  inWorkspace(() => {
    const bank = database.saveAccount({ name: 'جاری ملت', kind: 'bank', openingBalance: 500_000_000 });
    assert.equal(bank.kind, 'bank');
    // نام بانک از روی نام حساب حدس زده می‌شود؛ پرسیدنش اضافه است.
    assert.ok(bank.bankId, 'بانک باید از نام حساب شناخته شود');

    const { id } = speak('هشت میلیون تومان قبض برق از بانک ملت پرداخت شد');
    const row = database.getTransaction(id);
    assert.equal(row.accountId, bank.id, `باید روی حساب بانک بنشیند، نه ${row.accountName}`);

    const lines = postedLines(id);
    const cashSide = lines.find((line) => line.kind === 'operational-account');
    assert.equal(cashSide.account, 'جاری ملت');
    assert.equal(cashSide.credit, 8_000_000);
  });
});

/**
 * بانکی که گفته شده ولی حسابی ندارد، بی‌صدا روی صندوق نمی‌نشیند.
 *
 * این همان خطایی است که کاربر هیچ‌وقت نمی‌بیند و آخر ماه هر دو مانده غلط است.
 */
test('بانکِ بدون حساب، ثبت را علامت می‌زند', () => {
  inWorkspace(() => {
    const { id } = speak('دو میلیون تومان کارمزد از بانک سامان کم شد');
    const row = database.getTransaction(id);
    assert.equal(row.needsReview, true);
    assert.match(row.reviewReasons.join(' '), /حسابی برای/);
  });
});

/** موجودی اولیه دستی ثبت می‌شود و همان لحظه سند افتتاحیه می‌خورد. */
test('موجودی اولیهٔ بانک دستی ثبت می‌شود و در دفتر می‌نشیند', () => {
  inWorkspace(() => {
    const bank = database.saveAccount({ name: 'جاری پاسارگاد', kind: 'bank', openingBalance: 250_000_000 });
    const opening = db().prepare(`SELECT COALESCE(SUM(journal_lines.debit),0) AS total FROM journal_lines
      JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
      JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE journal_entries.entry_kind='opening' AND ledger_accounts.source_key=?`).get(bank.id).total;
    assert.equal(opening, 250_000_000);
  });
});

test.after(() => removeTempDatabase(databasePath));
