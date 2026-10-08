import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { parseFinancialText } from '../shared/parser.js';
import { readPettyCash, pickPettyCashAccount } from '../shared/pettyCashSpeech.js';
import { detectCaptureTransfer, detectPettyCashFunding } from '../shared/bankSpeech.js';
import { detectTransferBanks } from '../shared/banks.js';
import { judgmentReason } from '../shared/moneyPurpose.js';

/**
 * تنخواه‌گردان — مهر ۱۴۰۵.
 *
 * تا امروز «تنخواه» نامِ دیگرِ صندوق بود: پرداخت تنخواه هزینه یا پیش‌پرداخت
 * خوانده می‌شد، «از ملت به تنخواه» انتقال به صندوق اصلی بود، و خرج از تنخواه از
 * صندوق اصلی کم می‌شد. تصمیم مالک محصول: سقف ثابت که به اندازهٔ خرج‌شده شارژ
 * می‌شود، و صفحهٔ جدا در منو.
 */

const parse = (text) => parseFinancialText(text, { source: 'voice', now: new Date('2026-10-08T09:00:00.000Z') }).transactions[0];

// ---------------------------------------------------------------------------
// گفتار
// ---------------------------------------------------------------------------

test('پرداخت تنخواه از خرج از تنخواه جداست، و دارنده از گیرندهٔ پول', () => {
  assert.deepEqual(readPettyCash('پنج میلیون تومان تنخواه به آقای رضایی دادیم'), { action: 'fund', holder: 'رضایی' });
  assert.deepEqual(readPettyCash('سه میلیون از صندوق تنخواه دادیم به کریمی'), { action: 'fund', holder: 'کریمی' });
  assert.deepEqual(readPettyCash('تنخواه رضایی رو از بانک ملت شارژ کردیم'), { action: 'fund', holder: 'رضایی' });
  assert.deepEqual(readPettyCash('از تنخواه دویست هزار تومان پذیرایی خریدیم'), { action: 'spend', holder: null }, 'واژهٔ عددی نام نیست');
  assert.deepEqual(readPettyCash('رضایی از تنخواه دویست هزار تومان کرایه داد'), { action: 'spend', holder: 'رضایی' });
  assert.deepEqual(readPettyCash('از تنخواه به آقای کریمی سیصد هزار بابت تعمیر دادیم'), { action: 'spend', holder: null },
    'در خرج، «به» گیرندهٔ پول است نه دارندهٔ تنخواه');
  assert.equal(readPettyCash('دو میلیون قبض برق دادیم'), null);
});

test('خرج از تنخواه هزینه است با نشانهٔ تنخواه؛ تنخواه و دارنده‌اش طرف حساب نیستند', () => {
  const plain = parse('از تنخواه دویست هزار تومان پذیرایی خریدیم');
  assert.equal(plain.type, 'expense');
  assert.deepEqual(plain.pettyCash, { action: 'spend', holder: null });
  assert.equal(plain.contactName, undefined, '«تنخواه» طرف حساب نیست');

  const named = parse('آقای رضایی از تنخواه سیصد هزار تومان به آقای کریمی بابت تعمیر داد');
  assert.equal(named.pettyCash.holder, 'رضایی');
  assert.equal(named.contactName, 'کریمی', 'پول را تعمیرکار گرفته، نه دارندهٔ تنخواه');
  assert.equal(parse('با تنخواه خانم احمدی پونصد هزار تومان لوازم التحریر خریدیم').contactName, undefined);
});

test('«تنخواه» دیگر صندوق اصلی نیست', () => {
  assert.equal(detectTransferBanks('ده میلیون از بانک ملت به تنخواه منتقل کردیم'), null);
  const accounts = [{ id: 'cash', kind: 'cash', name: 'صندوق نقدی', active: 1 }, { id: 'm', kind: 'bank', bankId: 'mellat', name: 'جاری ملت', active: 1 }];
  const transfer = detectCaptureTransfer('ده میلیون از بانک ملت به تنخواه منتقل کردیم', { accounts });
  assert.notEqual(transfer?.toAccountId, 'cash');
});

test('برگهٔ پرداخت تنخواه: شارژ تنخواهِ باز، یا تنخواه تازه با همان مبلغ', () => {
  const accounts = [
    { id: 'cash', kind: 'cash', name: 'صندوق نقدی', active: 1 },
    { id: 'm', kind: 'bank', bankId: 'mellat', name: 'جاری ملت', active: 1 },
    { id: 'p1', kind: 'petty', holderName: 'رضایی', name: 'تنخواه رضایی', active: 1, pettyCeiling: 5_000_000, balance: 3_200_000 },
  ];
  const recharge = detectPettyCashFunding('تنخواه رضایی رو از بانک ملت شارژ کردیم', { accounts });
  assert.equal(recharge.intent, 'petty-fund');
  assert.equal(recharge.fundId, 'p1');
  assert.equal(recharge.amount, 1_800_000, 'مبلغ گفته نشد: همان خرج‌شده تا سقف');
  assert.equal(recharge.needsAmount, true);
  assert.equal(recharge.fromAccountId, 'm');

  const fresh = detectPettyCashFunding('ده میلیون از صندوق تنخواه دادیم به خانم احمدی', { accounts });
  assert.equal(fresh.fundId, null);
  assert.equal(fresh.holder, 'احمدی');
  assert.equal(fresh.amount, 10_000_000);
  assert.equal(fresh.fromAccountId, 'cash');

  assert.equal(detectPettyCashFunding('از تنخواه دویست هزار پذیرایی خریدیم', { accounts }), null);
  assert.equal(pickPettyCashAccount(accounts, { holder: null })?.id, 'p1', 'یک تنخواه باز: بی‌نام هم روشن است');
  assert.equal(pickPettyCashAccount([...accounts, { ...accounts[2], id: 'p2', holderName: 'احمدی' }], { holder: null }), null, 'دو تنخواه و بی‌نام: حدس نه');
  assert.match(judgmentReason('پنج میلیون تومان تنخواه به آقای رضایی دادیم'), /تنخواه/, 'اگر از برگه رد شد، به حسابدار برود');
});

// ---------------------------------------------------------------------------
// دفتر
// ---------------------------------------------------------------------------

const databasePath = tempDatabase('petty-cash');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'petty-owner';
process.env.ADMIN_PASSWORD = 'petty-strong-password-7713';

const database = await import('../server/db.js');
const accounting = await import('../server/accounting.js');
database.ensureAdmin();
const owner = database.authenticateUser('petty-owner', 'petty-strong-password-7713');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر تنخواه', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const balanceOf = (id) => database.listAccounts().find((account) => account.id === id).balance;
const profit = () => db().prepare(`SELECT COALESCE(SUM(l.credit)-SUM(l.debit),0) AS net FROM journal_lines l
  JOIN ledger_accounts a ON a.id=l.account_id WHERE a.type IN ('income','expense')`).get().net;
function say(text, extra = {}) {
  const transactions = parseFinancialText(text, { source: 'voice' }).transactions
    .map((item) => ({ ...item, source: 'voice', userConfirmed: true, needsReview: false, reviewReasons: [], ...extra }));
  return database.insertTransactions({ transcript: text, transactions });
}

let bank;
let fund;

test('پرداخت تنخواه: انتقال از بانک، نه هزینه؛ حسابش زیر معین تنخواه‌گردان', () => inWorkspace(() => {
  database.installChartTemplate();
  bank = database.saveAccount({ name: 'جاری ملت', kind: 'bank', bankId: 'mellat', openingBalance: 50_000_000 });
  const before = profit();
  fund = database.openPettyCashFund({ holderName: 'رضایی', ceiling: 5_000_000, fromAccountId: bank.id });

  assert.equal(fund.balance, 5_000_000);
  assert.equal(fund.spent, 0);
  assert.equal(balanceOf(bank.id), 45_000_000);
  assert.equal(profit(), before, 'پرداخت تنخواه سود را تکان نمی‌دهد');
  assert.equal(accounting.trialBalance(db()).balanced, true);

  const listed = database.listAccounts().find((account) => account.id === fund.id);
  assert.equal(listed.kind, 'petty');
  assert.equal(listed.holderName, 'رضایی');
  const mapped = db().prepare(`SELECT c.code,c.role FROM ledger_accounts l JOIN chart_accounts c ON c.id=l.chart_account_id
    WHERE l.source_kind='operational-account' AND l.source_key=?`).get(fund.id);
  assert.equal(mapped.code, '1103', 'تنخواه روی صندوق نمی‌نشیند');
  assert.equal(mapped.role, 'petty-cash');

  assert.throws(() => database.openPettyCashFund({ holderName: 'رضایی', ceiling: 1_000_000, fromAccountId: bank.id }), /از قبل هست/);
  assert.throws(() => database.openPettyCashFund({ holderName: 'کریمی', ceiling: 1_000_000, fromAccountId: fund.id }), /تنخواهِ دیگر/);
}));

test('خرج از تنخواه از حساب تنخواه کم می‌شود، نه از صندوق', () => inWorkspace(() => {
  const cashBefore = balanceOf('cash');
  const [id] = say('از تنخواه رضایی دویست هزار تومان پذیرایی خریدیم');
  const row = db().prepare('SELECT account_id AS accountId,type,amount FROM transactions WHERE id=?').get(id);
  assert.equal(row.accountId, fund.id);
  assert.equal(row.type, 'expense');
  assert.equal(balanceOf(fund.id), 4_800_000);
  assert.equal(balanceOf('cash'), cashBefore, 'صندوق اصلی دست نخورد');
  const [current] = database.listPettyCashFunds();
  assert.equal(current.spent, 200_000);
  assert.equal(current.recentSpends.length, 1);
  assert.equal(accounting.trialBalance(db()).balanced, true);
}));

test('شارژ: پیش‌فرض دقیقاً همان خرج‌شده است', () => inWorkspace(() => {
  const refilled = database.replenishPettyCashFund(fund.id, { fromAccountId: bank.id });
  assert.equal(refilled.balance, 5_000_000);
  assert.equal(refilled.spent, 0);
  assert.equal(balanceOf(bank.id), 44_800_000);
  assert.throws(() => database.replenishPettyCashFund(fund.id, { fromAccountId: bank.id }), /پر است/);
}));

test('تنخواه از تنظیمات غیرفعال نمی‌شود و ماندهٔ اول دوره نمی‌گیرد', () => inWorkspace(() => {
  const account = database.listAccounts().find((item) => item.id === fund.id);
  assert.throws(() => database.saveAccount({ ...account, active: false }), /تنخواه‌گردان/);
  assert.throws(() => database.saveAccount({ ...account, openingBalance: 1_000_000 }), /ماندهٔ اول دوره/);
}));

test('بستن با خرجِ بیش از تنخواه: کسری به دارنده پرداخت می‌شود و مانده صفر', () => inWorkspace(() => {
  say('رضایی از تنخواه شش میلیون تومان تعمیرات دفتر داد');
  assert.equal(balanceOf(fund.id), -1_000_000);
  assert.equal(database.listPettyCashFunds()[0].overspent, 1_000_000);
  const bankBefore = balanceOf(bank.id);
  const closed = database.closePettyCashFund(fund.id, { toAccountId: bank.id });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.balance, 0);
  assert.equal(balanceOf(bank.id), bankBefore - 1_000_000);
  assert.equal(database.listPettyCashFunds().length, 0);
  assert.equal(database.listPettyCashFunds({ includeClosed: true }).length, 1);
  assert.equal(accounting.trialBalance(db()).balanced, true);
}));

test('از گفتار: تنخواه تازه، و بعد شارژ همان؛ نام حساب تنخواهِ بسته تکرار نمی‌شود', () => inWorkspace(() => {
  const opened = database.fundPettyCashFromSpeech({ holderName: 'رضایی', amount: 3_000_000, fromAccountId: 'cash' });
  assert.equal(opened.action, 'opened');
  assert.equal(opened.item.ceiling, 3_000_000);
  assert.notEqual(opened.item.accountName, 'تنخواه رضایی', 'نام تنخواهِ بسته‌شده آزاد نیست');
  say('از تنخواه پونصد هزار تومان پذیرایی خریدیم');
  const recharged = database.fundPettyCashFromSpeech({ amount: 500_000, fromAccountId: 'cash' });
  assert.equal(recharged.action, 'replenished', 'بی‌نام، چون فقط یک تنخواه باز هست');
  assert.equal(recharged.item.balance, 3_000_000);
}));

test('با موتور تصمیم روشن هم سند خرج، بستانکارِ حساب تنخواه است', async () => {
  const store = await import('../server/financialEventStore.js');
  inWorkspace(() => {
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, capitalizationThreshold: 20_000_000 });
    const [open] = database.listPettyCashFunds();
    const [id] = say('از تنخواه سیصد هزار تومان کرایه تاکسی دادیم');
    const event = store.findEventBySource(db(), `transaction:${id}`);
    assert.equal(event.status, 'posted');
    const credit = db().prepare(`SELECT a.source_key AS key, l.credit FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id
      WHERE l.entry_id=? AND l.credit>0`).get(event.journalEntryId);
    assert.equal(credit.key, open.id);
    assert.equal(credit.credit, 300_000);
    assert.equal(database.listPettyCashFunds()[0].spent, 300_000);
  });
});

test('پشتیبان، جدول تنخواه را هم دارد', () => inWorkspace(() => {
  const snapshot = database.financialBackupSnapshot();
  assert.equal(snapshot.tables.petty_cash_funds.length, 2);
}));

test.after(() => removeTempDatabase(databasePath));
