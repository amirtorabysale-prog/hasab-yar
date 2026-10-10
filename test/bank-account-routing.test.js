import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { parseFinancialText } from '../shared/parser.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

const databasePath = tempDatabase('bank-routing');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'bank-owner';
process.env.ADMIN_PASSWORD = 'Bank-Long-Passphrase-3390';

const database = await import(`../server/db.js?bank=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('bank-owner', 'Bank-Long-Passphrase-3390');
const workspace = database.createWorkspace(owner.id, { name: 'شرکت بانکی', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);

const accountOf = (id) => database.listAccounts().find((item) => item.id === id);

// ------------------------------------------------------------ تعریف حساب

test('حساب بانکی هویت بانکش را از نام خودش می‌گیرد', () => inWorkspace(() => {
  const account = database.saveAccount({ name: 'جاری ملت', kind: 'bank', openingBalance: 0 });
  assert.equal(account.bankId, 'mellat', 'اسم حساب خودش بانک را می‌گوید؛ پرسیدنش اضافه است');
}));

test('انتخاب صریح بانک بر حدس از روی نام مقدم است', () => inWorkspace(() => {
  const account = database.saveAccount({ name: 'حساب اصلی شرکت', kind: 'bank', bankId: 'karafarin', openingBalance: 0 });
  assert.equal(account.bankId, 'karafarin');
}));

test('بانک فقط روی حساب بانکی می‌نشیند', () => inWorkspace(() => {
  const account = database.saveAccount({ name: 'صندوق ملت‌آباد', kind: 'cash', bankId: 'mellat', openingBalance: 0 });
  assert.equal(account.bankId, null, 'صندوق بانک ندارد');
}));

test('بانک بیرون از فهرست رد می‌شود، نه اینکه بی‌صدا خالی بماند', () => inWorkspace(() => {
  assert.throws(() => database.saveAccount({ name: 'حساب عجیب', kind: 'bank', bankId: 'بانک ناموجود' }), /فهرست/);
}));

// ------------------------------------------------------ گفتار تا حساب

/**
 * زنجیرهٔ کامل: کاربر نام بانک را می‌گوید، پارسر شناسهٔ بانک را بیرون می‌کشد و
 * سرور آن را به حساب همین دفتر می‌بندد. هیچ‌کدام از این سه به‌تنهایی کافی نیست.
 */
test('نام بانک در گفتار، ثبت را روی همان حساب می‌نشاند', () => inWorkspace(() => {
  const bank = database.saveAccount({ name: 'جاری پاسارگاد', kind: 'bank', openingBalance: 0 });
  const parsed = parseFinancialText('دویست هزار تومان از پاسارگاد بابت اجاره دادم');
  assert.equal(parsed.transactions[0].bankId, 'pasargad');

  const [id] = database.insertTransactions({ transcript: 'از پاسارگاد', transactions: parsed.transactions });
  const row = database.activeWorkspaceDatabase().prepare('SELECT account_id AS accountId FROM transactions WHERE id=?').get(id);
  assert.equal(row.accountId, bank.id, 'ثبت باید روی حساب پاسارگاد بنشیند، نه صندوق');
}));

// انتخاب کاربر در برگهٔ تأیید حرف آخر است؛ نام بانک فقط پیش‌فرض را بهتر می‌کند.
test('انتخاب صریح حساب بر نام بانک مقدم است', () => inWorkspace(() => {
  database.saveAccount({ id: 'bank-mellat', name: 'جاری ملت شرکت', kind: 'bank', openingBalance: 0 });
  const [id] = database.insertTransactions({ transcript: 'دستی', transactions: [{
    amount: 90_000, type: 'expense', category: 'سایر', rawText: 'از ملت دادم',
    bankId: 'mellat', accountId: 'cash',
  }] });
  const row = database.activeWorkspaceDatabase().prepare('SELECT account_id AS accountId FROM transactions WHERE id=?').get(id);
  assert.equal(row.accountId, 'cash');
}));

/**
 * بانکی که حساب ندارد نباید بی‌صدا روی صندوق بنشیند.
 *
 * این همان خطایی است که کاربر هیچ‌وقت نمی‌بیند و آخر ماه ماندهٔ صندوق و بانک
 * هر دو غلط است.
 */
test('بانکِ تعریف‌نشده سؤال می‌سازد، نه سکوت', () => inWorkspace(() => {
  const [id] = database.insertTransactions({ transcript: 'سینا', transactions: [{
    amount: 120_000, type: 'expense', category: 'سایر', rawText: 'از سینا دادم',
    bankId: 'sina', bankName: 'بانک سینا',
  }] });
  const row = database.activeWorkspaceDatabase()
    .prepare('SELECT account_id AS accountId,review_reasons AS reviewReasons FROM transactions WHERE id=?').get(id);
  assert.equal(row.accountId, 'cash', 'تا وقتی حسابی نیست، جای دیگری ندارد');
  assert.match(row.reviewReasons, /سینا/, 'ولی باید گفته شود که چرا اینجا نشسته');
}));

// دو حساب از یک بانک یعنی جمله روشن نیست؛ انتخاب یکی از آن دو، برداشت از
// حساب اشتباه است.
test('دو حساب از یک بانک، هیچ‌کدام خودکار انتخاب نمی‌شوند', () => inWorkspace(() => {
  database.saveAccount({ id: 'saman-1', name: 'سامان یک', kind: 'bank', bankId: 'saman', openingBalance: 0 });
  database.saveAccount({ id: 'saman-2', name: 'سامان دو', kind: 'bank', bankId: 'saman', openingBalance: 0 });
  assert.equal(database.accountForBank('saman'), null);

  const [id] = database.insertTransactions({ transcript: 'سامان', transactions: [{
    amount: 55_000, type: 'expense', category: 'سایر', rawText: 'از بانک سامان دادم', bankId: 'saman', bankName: 'بانک سامان',
  }] });
  const row = database.activeWorkspaceDatabase().prepare('SELECT account_id AS accountId FROM transactions WHERE id=?').get(id);
  assert.equal(row.accountId, 'cash');
}));

// ------------------------------------------------------------- ماسک نام

// «بانک صادرات» نباید دستهٔ «صادرات» بسازد و «بانک مسکن» نباید اجاره شود.
test('نام بانک وارد دسته‌بندی نمی‌شود', () => {
  const parsed = parseFinancialText('سیصد هزار تومان از بانک مسکن قبض برق دادم');
  const [transaction] = parsed.transactions;
  assert.equal(transaction.bankId, 'maskan');
  assert.ok(!transaction.category.includes('اجاره'), `دسته «${transaction.category}» از نام بانک آمده است`);
});

test('گفتنِ بانک، اطمینان حساب را بالا می‌برد', () => {
  const withBank = parseFinancialText('صد هزار از بانک تجارت دادم').transactions[0];
  const without = parseFinancialText('صد هزار دادم').transactions[0];
  assert.ok(withBank.confidenceDetails.account.score > without.confidenceDetails.account.score);
});

test.after(() => removeTempDatabase(databasePath));
