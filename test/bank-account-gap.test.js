import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { pickBankAccount } from '../shared/banks.js';
import { parseFinancialText } from '../shared/parser.js';

/**
 * بانکی که گفته شده باید از حساب همان بانک کم شود.
 *
 * تشخیص بانک از همان اول درست کار می‌کرد — «از بانک ملت» را می‌شنید و
 * `bankId` را روی ثبت می‌گذاشت. ولی وقتی حسابی برای آن بانک در دفتر نبود،
 * برگه بی‌صدا «صندوق نقدی» می‌گذاشت و هیچ اشاره‌ای نمی‌کرد که بانکی شنیده
 * شده و جایی برای نشستن نداشته.
 *
 * نتیجه‌اش این بود که کاربر هر بار نام بانک را می‌گفت و هر بار همه‌چیز روی
 * صندوق می‌نشست: آخر ماه ماندهٔ صندوق و بانک هر دو غلط، و تطبیق بانکی هرگز
 * نمی‌خواند.
 */
test('نام بانک از جمله شنیده می‌شود، حتی وسط شرح هزینه', () => {
  for (const sentence of [
    'سه میلیون تومن قبض و آب از بانک ملت پرداخت شد',
    'سه میلیون تومان قبض آب از بانک ملت پرداخت شد',
    'هشت میلیون تومان قبض برق از بانک ملت پرداخت شد',
  ]) {
    const [item] = parseFinancialText(sentence, { source: 'voice' }).transactions;
    assert.equal(item.bankId, 'mellat', sentence);
    assert.equal(item.bankName, 'بانک ملت');
  }
});

/** یک حساب برای آن بانک یعنی انتخاب روشن است. */
test('با یک حساب بانکی، همان انتخاب می‌شود', () => {
  const accounts = [
    { id: 'cash', name: 'صندوق نقدی', kind: 'cash', active: true, bankId: null },
    { id: 'a1', name: 'جاری ملت', kind: 'bank', active: true, bankId: 'mellat' },
  ];
  assert.equal(pickBankAccount(accounts, 'mellat').id, 'a1');
});

/**
 * دو حساب از یک بانک یعنی جمله روشن نیست؛ حدس‌زدن یکی از آن دو، پول را در
 * حساب اشتباه می‌نشاند و تطبیق بانکی را خراب می‌کند.
 */
test('دو حساب از یک بانک، خودکار انتخاب نمی‌شوند', () => {
  const accounts = [
    { id: 'a1', name: 'جاری ملت', kind: 'bank', active: true, bankId: 'mellat' },
    { id: 'a2', name: 'پس‌انداز ملت', kind: 'bank', active: true, bankId: 'mellat' },
  ];
  assert.equal(pickBankAccount(accounts, 'mellat'), null);
});

test('حساب غیرفعال یا غیربانکی انتخاب نمی‌شود', () => {
  assert.equal(pickBankAccount([{ id: 'a1', kind: 'bank', active: false, bankId: 'mellat' }], 'mellat'), null);
  assert.equal(pickBankAccount([{ id: 'a2', kind: 'other', active: true, bankId: 'mellat' }], 'mellat'), null);
});

// ---------------------------------------------------------------------------
// و همان رفتار روی دفتر واقعی
// ---------------------------------------------------------------------------
const databasePath = tempDatabase('bankgap');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'bankgap-owner';
process.env.ADMIN_PASSWORD = 'bankgap-strong-password-4417';

const database = await import(`../server/db.js?bankgap=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('bankgap-owner', 'bankgap-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'کارخانه', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

const speak = (sentence) => {
  const [item] = parseFinancialText(sentence, { source: 'voice' }).transactions;
  const [id] = database.insertTransactions({ transcript: sentence, transactions: [item] });
  return database.getTransaction(id);
};

test('بدون حساب بانک، ثبت روی صندوق می‌نشیند ولی علامت می‌خورد', () => {
  inWorkspace(() => {
    const row = speak('سه میلیون تومن قبض و آب از بانک ملت پرداخت شد');
    assert.equal(row.accountId, 'cash');
    assert.equal(row.needsReview, true, 'نباید بی‌صدا روی صندوق بنشیند');
    assert.match(row.reviewReasons.join(' '), /حسابی برای/);
  });
});

/** حسابی که همان‌جا ساخته می‌شود، بلافاصله همان بانک را می‌گیرد. */
test('حساب ساخته‌شده از روی نام بانک، بلافاصله مقصد ثبت‌های بعدی می‌شود', () => {
  inWorkspace(() => {
    const account = database.saveAccount({ name: 'بانک ملت', kind: 'bank', bankId: 'mellat', openingBalance: 0 });
    assert.equal(account.bankId, 'mellat');

    const row = speak('چهار میلیون تومان قبض برق از بانک ملت پرداخت شد');
    assert.equal(row.accountId, account.id, 'باید روی حساب بانک بنشیند');
    assert.equal(row.needsReview, false, 'حالا دیگر ابهامی نیست');
  });
});

test.after(() => removeTempDatabase(databasePath));
