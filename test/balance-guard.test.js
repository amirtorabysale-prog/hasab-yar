import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { readOverdraftApproval } from '../server/balanceGuard.js';

/**
 * صندوق، بانک و تنخواه منفی نمی‌شوند — مگر با تأیید حسابدار.
 *
 * نگهبان در لایهٔ مشترک دیتابیس است؛ پس هر مسیری که پول را از حساب کم می‌کند
 * باید یک‌جور رفتار کند: ثبت، انتقال، تسویه، ویرایش، حذف، ثبت دوره‌ای. و عملیاتی
 * که برگردانده شد هیچ ردی نمی‌گذارد — نه ردیف، نه سند.
 */
process.env.DATABASE_PATH = tempDatabase('balance-guard');
process.env.ADMIN_USERNAME = 'guard-owner';
process.env.ADMIN_PASSWORD = 'guard-strong-password-6612';
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser('guard-owner', 'guard-strong-password-6612');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر نگهبان موجودی', profileType: 'business' });
const plain = { role: 'owner', userId: owner.id };
const approved = { ...plain, overdraftApproval: { reason: 'دریافت دیروز هنوز ثبت نشده', role: 'accountant', userId: owner.id } };
const inWorkspace = (callback, member = plain) => database.runInWorkspace(workspace.id, member, callback);
const db = () => database.activeWorkspaceDatabase();
const count = (table) => db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const balanceOf = (id) => database.listAccounts().find((account) => account.id === id).balance;
const spend = (amount, extra = {}) => database.insertTransactions({ transcript: `${amount} هزینه`, transactions: [{ clientId: `spend-${Math.random()}`, amount, type: 'expense', category: 'سایر هزینه‌ها', source: 'text', settlement: 'none', ...extra }] });
const receive = (amount, extra = {}) => database.insertTransactions({ transcript: `${amount} دریافت`, transactions: [{ clientId: `recv-${Math.random()}`, amount, type: 'income', category: 'فروش', source: 'text', settlement: 'none', ...extra }] });
const blocked = (callback) => assert.throws(callback, (error) => error.code === 'NEGATIVE_BALANCE' && error.status === 409 && Array.isArray(error.details?.accounts));

let bank;
test('آماده‌سازی: صندوق ۱۰ میلیون، بانک ۵ میلیون', () => inWorkspace(() => {
  database.installChartTemplate();
  receive(10_000_000);
  bank = database.saveAccount({ name: 'جاری ملت', kind: 'bank', bankId: 'mellat', openingBalance: 5_000_000 });
  assert.equal(balanceOf('cash'), 10_000_000);
}));

test('هزینهٔ بیش از موجودی برمی‌گردد و هیچ ردی نمی‌گذارد', () => inWorkspace(() => {
  const rows = count('transactions');
  const entries = count('journal_entries');
  blocked(() => spend(12_000_000));
  assert.equal(count('transactions'), rows, 'ردیفی نماند');
  assert.equal(count('journal_entries'), entries, 'سندی نماند');
  assert.equal(balanceOf('cash'), 10_000_000);
  // تا صفرِ دقیق مجاز است.
  spend(10_000_000);
  assert.equal(balanceOf('cash'), 0);
  receive(10_000_000);
}));

test('با تأیید حسابدار ثبت می‌شود و دلیل می‌ماند', () => inWorkspace(() => {
  spend(12_000_000);
  assert.equal(balanceOf('cash'), -2_000_000);
  const log = db().prepare('SELECT * FROM overdraft_approvals ORDER BY id DESC').get();
  assert.equal(log.account_id, 'cash');
  assert.equal(log.balance_after, -2_000_000);
  assert.equal(log.reason, 'دریافت دیروز هنوز ثبت نشده');
}, approved));

test('دریافت روی حسابِ از قبل منفی جلوی‌اش گرفته نمی‌شود؛ هزینهٔ بیشتر گرفته می‌شود', () => inWorkspace(() => {
  receive(1_000_000);
  assert.equal(balanceOf('cash'), -1_000_000);
  blocked(() => spend(500_000));
  receive(1_000_000);
}));

test('انتقال: مبدأ منفی نمی‌شود؛ مقصد هرگز سد نیست', () => inWorkspace(() => {
  blocked(() => database.transferBetweenAccounts({ fromAccountId: bank.id, toAccountId: 'cash', amount: 6_000_000 }));
  assert.equal(balanceOf(bank.id), 5_000_000);
  database.transferBetweenAccounts({ fromAccountId: bank.id, toAccountId: 'cash', amount: 5_000_000 });
  assert.equal(balanceOf(bank.id), 0);
  database.transferBetweenAccounts({ fromAccountId: 'cash', toAccountId: bank.id, amount: 5_000_000 });
}));

test('تسویهٔ نقدی بدهی هم همان قاعده؛ تسویه از پول شریک صندوق را لمس نمی‌کند', () => inWorkspace(() => {
  const supplier = database.saveContact({ name: 'شرکت نگهبان' });
  const debt = database.saveObligation({ title: 'خرید ورق', amount: 50_000_000, direction: 'payable', contactId: supplier.id });
  blocked(() => database.settleObligation(debt.id, { amount: 50_000_000 }));
  assert.equal(database.listObligations({ status: 'all' }).find((item) => item.id === debt.id).remaining, 50_000_000);
  database.settleObligation(debt.id, { amount: 50_000_000, paidBy: { name: 'آقای سهرابی' } });
  assert.equal(database.listObligations({ status: 'all' }).find((item) => item.id === debt.id).status, 'paid');
}));

test('ویرایش و حذف: منفی کردن موجودی از راه اصلاح هم سد است', () => inWorkspace(() => {
  const cash = balanceOf('cash');
  const [income] = receive(3_000_000);
  const [expense] = spend(cash + 1_000_000);
  blocked(() => database.deleteTransaction(income));
  blocked(() => database.updateTransaction(expense, { amount: cash + 5_000_000, type: 'expense', category: 'سایر هزینه‌ها', settlement: 'none' }));
  assert.equal(balanceOf('cash'), 2_000_000);
}));

test('حساب با اجازهٔ اضافه‌برداشت منفی می‌شود بی‌تأیید', () => inWorkspace(() => {
  const overdraft = database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 1_000_000, allowNegative: true });
  assert.equal(overdraft.allowNegative, 1);
  spend(3_000_000, { accountId: overdraft.id });
  assert.equal(balanceOf(overdraft.id), -2_000_000);
  // ذخیرهٔ دوبارهٔ حساب بدون این فیلد، اجازه را خاموش نمی‌کند.
  assert.equal(database.saveAccount({ id: overdraft.id, name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 1_000_000 }).allowNegative, 1);
}));

test('ثبت دوره‌ای که صندوق را منفی می‌کند در نوبت می‌ماند و بقیه ثبت می‌شوند', () => inWorkspace(() => {
  const cash = balanceOf('cash');
  const past = new Date(Date.now() - 2 * 86_400_000);
  db().prepare(`INSERT INTO recurring_rules (id,title,amount,type,category,day_of_month,next_due_at,active) VALUES (?,?,?,?,?,?,?,1)`)
    .run('rule-big', 'اجارهٔ گران', cash + 50_000_000, 'expense', 'اجاره', past.getDate(), past.toISOString());
  db().prepare(`INSERT INTO recurring_rules (id,title,amount,type,category,day_of_month,next_due_at,active) VALUES (?,?,?,?,?,?,?,1)`)
    .run('rule-small', 'شارژ ساختمان', 100_000, 'expense', 'شارژ', past.getDate(), past.toISOString());
  assert.doesNotThrow(() => database.materializeRecurringRules());
  assert.deepEqual(database.materializeRecurringRules.lastHeld.map((item) => item.ruleId), ['rule-big']);
  assert.equal(db().prepare("SELECT next_due_at FROM recurring_rules WHERE id='rule-big'").get().next_due_at, past.toISOString(), 'سررسید سر جایش ماند');
  assert.equal(balanceOf('cash'), cash - 100_000, 'قاعدهٔ کوچک ثبت شد');
}));

test('تأیید فقط با نقش مجاز و دلیل نوشته‌شده پذیرفته می‌شود', () => {
  assert.equal(readOverdraftApproval(encodeURIComponent('اضافه‌برداشت مصوب'), { role: 'viewer', userId: 'u' }), null);
  assert.equal(readOverdraftApproval(encodeURIComponent('اک'), { role: 'accountant', userId: 'u' }), null);
  assert.deepEqual(readOverdraftApproval(encodeURIComponent('اضافه‌برداشت مصوب'), { role: 'accountant', userId: 'u' }),
    { reason: 'اضافه‌برداشت مصوب', role: 'accountant', userId: 'u' });
});
