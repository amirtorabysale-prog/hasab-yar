import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
import { parseBankSms } from '../shared/bankSms.js';

/**
 * پیامک بانکی: خواندن، تنظیمات، جلوگیری از تکرار، تطبیق و ثبت — بی حدسِ «بابت».
 */
const RECEIVED = '2026-10-31T10:00:00.000Z';
const read = (text, sender = '') => parseBankSms(text, { sender, receivedAt: RECEIVED });

test('خواندن: قالب بانک‌های اصلی، مبلغ و مانده به ریال، جهت، چهار رقم آخر و تاریخ', () => {
  for (const [text, sender, bankId, direction, amountRial, balanceRial, hint] of [
    ['بانک ملت\nبرداشت: 1,250,000\nحساب: 12345678\nمانده: 10,500,000\n1405/07/15-10:20', 'Mellat', 'mellat', 'expense', 1_250_000, 10_500_000, '5678'],
    ['بانك ملي ايران\nانتقال:-5,000,000\nاز:0123456\nمانده:12,345,678\n0715-10:20', 'Bank Melli', 'melli', 'expense', 5_000_000, 12_345_678, '3456'],
    ['تجارت\nحساب 1234567\nواريز 2,000,000\nمانده 3,000,000\n1405/07/18 10:20', '', 'tejarat', 'income', 2_000_000, 3_000_000, '4567'],
    ['Bank Saderat\n+1,500,000\nحساب 0102030405\n1405/08/01 09:12\nمانده 9,000,000', '', 'saderat', 'income', 1_500_000, 9_000_000, '0405'],
    ['BPI\nAcc: 210.8100.12345678.1\nWithdraw: 100,000\nBal: 4,000,000', '', 'pasargad', 'expense', 100_000, 4_000_000, '5678'],
    ['خرید از پایانه 1,200,000 کارت 6037-****-****-1234 مانده 800,000 بانک صادرات', '', 'saderat', 'expense', 1_200_000, 800_000, '1234'],
    ['بانک ملت\nانتقال به حساب شما 3,000,000\nمانده 5,000,000', '', 'mellat', 'income', 3_000_000, 5_000_000, null],
    ['بانک ملت\nبرداشت: ۱٬۲۵۰٬۰۰۰\nمانده: ۵۰۰٬۰۰۰', '', 'mellat', 'expense', 1_250_000, 500_000, null],
  ]) {
    const parsed = read(text, sender);
    assert.equal(parsed.kind, 'transaction', text);
    assert.deepEqual([parsed.bankId, parsed.direction, parsed.amountRial, parsed.balanceRial, parsed.accountHint],
      [bankId, direction, amountRial, balanceRial, hint], text);
  }
  // ساعت تهران: ۱۰:۲۰ روز ۱۵ مهر ۱۴۰۵.
  assert.equal(read('بانک ملت\nبرداشت: 1,250,000\n1405/07/15-10:20').occurredAt, '2026-10-07T06:50:00.000Z');
  // بی تاریخ: زمان دریافت.
  assert.equal(read('بانک ملت\nبرداشت: 1,000').occurredAt, RECEIVED);
});

test('منفی: رمز یک‌بارمصرف، کد تأیید، پیامک غیربانکی و تبلیغ بانک تراکنش نیستند', () => {
  assert.equal(read('رمز پویا: 123456 \nبانک ملت').kind, 'otp');
  assert.equal(read('بانک ملت: کد تایید 54321').kind, 'otp');
  assert.equal(read('رمز دوم شما 98765432').kind, 'otp');
  assert.equal(read('سلام فردا میام').kind, 'not-bank');
  assert.equal(read('بانک سامان\nجشنواره قرعه کشی').kind, 'unknown');
});

process.env.DATABASE_PATH = tempDatabase('bank-sms');
process.env.ADMIN_USERNAME = 'sms-owner';
process.env.ADMIN_PASSWORD = 'sms-strong-password-4471';
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser('sms-owner', 'sms-strong-password-4471');
const book = (name) => database.createWorkspace(owner.id, { name, profileType: 'business' });
const inBook = (workspace, callback) => database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
const sms = (text) => ({ text, receivedAt: RECEIVED });

test('خاموش، روشن، و خاموشیِ یک بانک', () => {
  const workspace = book('پیامک خاموش');
  inBook(workspace, () => {
    database.saveAccount({ name: 'جاری ملت', kind: 'bank', bankId: 'mellat', openingBalance: 10_000_000 });
    assert.equal(database.bankSmsSettings().enabled, false, 'پیش‌فرض خاموش است');
    assert.throws(() => database.ingestBankSms([sms('بانک ملت\nبرداشت: 1,000,000')]), (error) => error.code === 'BANK_SMS_DISABLED');
    database.saveBankSmsSettings({ enabled: true, banks: { tejarat: false } });
    const { results } = database.ingestBankSms([sms('بانک تجارت\nبرداشت 2,000,000'), sms('رمز پویا 123456 بانک ملت'), sms('سلام')]);
    assert.deepEqual(results.map((item) => item.result), ['bank-disabled', 'otp', 'not-bank']);
    assert.equal(database.listBankSms().items.length, 0, 'هیچ‌کدام ذخیره نشد');
    assert.equal(database.bankSmsSettings().banks.find((bank) => bank.id === 'mellat').inLedger, true);
  });
});

test('ریال به تومان، تکرار ذخیره نمی‌شود، تطبیق خودکار با تنها ثبتِ همان روز', () => {
  const workspace = book('پیامک تطبیق');
  inBook(workspace, () => {
    const mellat = database.saveAccount({ name: 'جاری ملت', kind: 'bank', bankId: 'mellat', openingBalance: 10_000_000 });
    database.saveBankSmsSettings({ enabled: true });
    const [paid] = database.insertTransactions({ transcript: 'خرید ملزومات', transactions: [{ clientId: 'office-1', amount: 125_000, type: 'expense',
      category: 'ملزومات اداری', source: 'text', accountId: mellat.id, occurredAt: '2026-10-07T08:00:00.000Z', settlement: 'none' }] });
    const text = 'بانک ملت\nبرداشت: 1,250,000\nحساب: 12345678\nمانده: 98,750,000\n1405/07/15-10:20';
    const first = database.ingestBankSms([sms(text)]);
    assert.equal(first.results[0].status, 'matched');
    const item = first.items[0];
    assert.equal(item.amount, 125_000, '۱٬۲۵۰٬۰۰۰ ریال = ۱۲۵٬۰۰۰ تومان');
    assert.equal(item.transactionId, paid);
    assert.equal(item.matchKind, 'auto');
    // مانده: پیامک ۹٬۸۷۵٬۰۰۰ تومان، دفتر ۱۰٬۰۰۰٬۰۰۰ − ۱۲۵٬۰۰۰.
    assert.deepEqual(item.balanceCheck, { sms: 9_875_000, ledger: 9_875_000, difference: 0 });
    assert.equal(database.ingestBankSms([sms(text)]).results[0].result, 'duplicate');
    // حذف تراکنش، پیامک را دوباره منتظر می‌کند.
    database.deleteTransaction(paid);
    assert.equal(database.listBankSms().items[0].status, 'pending');
  });
});

test('دو نامزد یا حساب نامعلوم: منتظر می‌ماند؛ تطبیق دستی فقط با همان مبلغ و جهت؛ ثبت فقط با دسته', () => {
  const workspace = book('پیامک دستی');
  inBook(workspace, () => {
    const a = database.saveAccount({ name: 'ملت ۱', kind: 'bank', bankId: 'mellat', openingBalance: 50_000_000 });
    const b = database.saveAccount({ name: 'ملت ۲', kind: 'bank', bankId: 'mellat', openingBalance: 50_000_000 });
    database.saveBankSmsSettings({ enabled: true, hints: { [b.id]: '...9999' } });
    // دو حساب ملت و بی‌نشانه: حساب پرسیده می‌شود.
    const unknown = database.ingestBankSms([sms('بانک ملت\nبرداشت: 3,000,000\nمانده: 1,000')]).items[0];
    assert.equal(unknown.accountId, null);
    assert.throws(() => database.recordBankSms(unknown.id, { category: 'قبوض' }), /حساب/);
    database.assignBankSmsAccount(unknown.id, a.id);
    // نشانهٔ ۹۹۹۹ حساب دوم را پیدا می‌کند.
    const hinted = database.ingestBankSms([sms('بانک ملت\nواریز 7,000,000\nحساب 1239999')]).items.find((item) => item.direction === 'income');
    assert.equal(hinted.accountId, b.id);
    // دو تراکنش هم‌مبلغ در همان روزها: خودکار نمی‌بندد.
    for (const id of ['x1', 'x2']) database.insertTransactions({ transcript: 'هزینه', transactions: [{ clientId: id, amount: 300_000, type: 'expense', category: 'سایر هزینه‌ها', source: 'text', accountId: a.id, occurredAt: RECEIVED, settlement: 'none' }] });
    const twice = database.ingestBankSms([sms('بانک ملت\nبرداشت: 3,000,000\nحساب 11112222\nمانده 2,000')]).items.find((item) => item.accountHint === '2222');
    assert.equal(twice.status, 'pending');
    // حساب نامعلوم: نامزدها فقط از حساب‌های همان بانک.
    assert.equal(twice.candidates.length, 2);
    database.assignBankSmsAccount(twice.id, a.id);
    const candidates = database.listBankSms().items.find((item) => item.id === twice.id).candidates;
    assert.equal(candidates.length, 2);
    const [other] = database.insertTransactions({ transcript: 'فروش', transactions: [{ clientId: 'in-1', amount: 300_000, type: 'income', category: 'فروش', source: 'text', accountId: a.id, occurredAt: RECEIVED, settlement: 'none' }] });
    assert.throws(() => database.matchBankSms(twice.id, other), /جهت/);
    assert.equal(database.matchBankSms(twice.id, candidates[0].id).status, 'matched');
    // ثبت بی‌دسته ممکن نیست؛ با دسته روی همان حساب و تاریخ.
    assert.throws(() => database.recordBankSms(unknown.id, {}), /دسته/);
    const recorded = database.recordBankSms(unknown.id, { category: 'قبوض', description: 'قبض برق مهر' });
    assert.equal(recorded.status, 'recorded');
    const transaction = database.getTransaction(recorded.transactionId);
    assert.deepEqual([transaction.amount, transaction.type, transaction.accountId, transaction.category], [300_000, 'expense', a.id, 'قبوض']);
    // کنار گذاشتن و برگرداندن.
    assert.equal(database.ignoreBankSms(hinted.id, 'انتقال داخلی').status, 'ignored');
    assert.equal(database.reopenBankSms(hinted.id).status, 'pending');
    assert.throws(() => database.reopenBankSms(recorded.id), /تراکنش/);
  });
});

test('دفتر ریالی: مبلغ همان ریال می‌ماند', () => {
  const workspace = book('پیامک ریالی');
  inBook(workspace, () => {
    database.setLedgerAmountUnit('rial');
    database.saveAccount({ name: 'جاری ملت', kind: 'bank', bankId: 'mellat', openingBalance: 0 });
    database.saveBankSmsSettings({ enabled: true });
    const item = database.ingestBankSms([sms('بانک ملت\nواریز: 1,250,000\nمانده: 1,250,000')]).items[0];
    assert.equal(item.amount, 1_250_000);
  });
});
