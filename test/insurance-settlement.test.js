import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

/**
 * پرداخت لیست بیمه از صف حسابدار (T062).
 *
 * لیست حقوق بیمهٔ سهم کارمند و کارفرما را بدهی کرده و سهم کارفرما را همان‌جا
 * هزینه کرده است. پرداختی که بعداً با صدا یا متن می‌رسد باید همان بدهی را
 * ببندد: هزینه‌کردنش سهم کارفرما را دو بار می‌شمارد و بدهی بیمه را تا ابد باز
 * می‌گذارد.
 */
const databasePath = tempDatabase('insurance-settlement');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'insurance-owner';
process.env.ADMIN_PASSWORD = 'insurance-strong-password-6631';

const database = await import('../server/db.js');
const sheet = await import('../server/spreadsheet.js');
const store = await import('../server/financialEventStore.js');
const assistant = await import('../server/reviewAssistant.js');
const ai = await import('../server/accountingReviewAi.js');
database.ensureAdmin();

const owner = database.authenticateUser('insurance-owner', 'insurance-strong-password-6631');
const workspace = database.createWorkspace(owner.id, { name: 'ازمایشی', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id, overdraftApproval: FIXTURE_OVERDRAFT }, callback);
const db = () => database.activeWorkspaceDatabase();
const noNetwork = async () => { throw new Error('پرداخت بیمه نباید سراغ API برود'); };

const HEADER = ['نام پرسنل', 'کد ملی', 'حقوق ناخالص', 'بیمه سهم کارمند', 'بیمه سهم کارفرما', 'مالیات', 'سایر کسورات', 'خالص پرداختی'];
// بیمهٔ کارمند ۳٬۵۰۰٬۰۰۰ + کارفرما ۱۱٬۵۰۰٬۰۰۰ = ۱۵٬۰۰۰٬۰۰۰
const TWO_PEOPLE = [
  ['رضا کریمی', '0012345678', 30_000_000, 2_100_000, 6_900_000, 600_000, 0, 27_300_000],
  ['مینا رجبی', '0023456789', 20_000_000, 1_400_000, 4_600_000, 400_000, 0, 18_200_000],
];
const importRun = (period, occurredAt) => database.importPayrollFile(sheet.buildWorkbook([{ name: 'حقوق', rows: [HEADER, ...TWO_PEOPLE] }]), 'payroll.xlsx', { period, occurredAt });

const insuranceText = (amount) => `${amount} میلیون تومن بیمه تامین اجتماعی پرسنل (سهم کارفرما، بیکاری و کارگر) به تامین اجتماعی پرداخت شد.`;
const paymentEvent = (millions) => store.recordFinancialEvent(db(), {
  kind: 'cash-expense', amount: millions * 1_000_000, occurredAt: '2026-10-03', evidence: insuranceText(millions), eventNature: 'new', category: 'بیمه',
}, { sourceEventId: crypto.randomUUID(), decision: { route: 'accountant-review', guardBlocked: true, reasons: ['بررسی حسابدار لازم است'] } });
const row = (item) => db().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id);
const propose = (item, answer) => ai.proposeReview(db(), item.id, {
  facts: { accountId: 'cash', ...(answer ? { questionAnswers: { 'nature.insurance-settlement': { value: answer } } } : {}) }, fetcher: noNetwork,
});
const balanceOf = (kind) => db().prepare(`SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) n FROM journal_lines l
  JOIN ledger_accounts a ON a.id=l.account_id WHERE a.source_kind=?`).get(kind).n;
const expenseTotal = () => db().prepare(`SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) n FROM journal_lines l
  JOIN ledger_accounts a ON a.id=l.account_id WHERE a.type='expense'`).get().n;

let june;
let paid;

test('بدون لیست حقوق، پرداخت بیمه هزینه نمی‌شود و سؤال راه درست را می‌گوید', async () => inWorkspace(async () => {
  const item = paymentEvent(15);
  const proposal = await propose(item);
  assert.equal(proposal.lines.length, 0);
  assert.ok(proposal.questions.some((q) => q.text.includes('لیست حقوقی با بیمهٔ پرداخت‌نشده پیدا نشد')), JSON.stringify(proposal.questions));
  const forged = { ...proposal, questions: [], lines: [{ role: 'expense-category', key: 'بیمه', debit: 15_000_000, credit: 0 }, { role: 'cash', debit: 0, credit: 15_000_000 }] };
  assert.equal(assistant.prepareReviewProposal(db(), row(item), forged).canPost, false);
  database.rejectEvent(item.id, 'آزمون: لیست حقوق هنوز وارد نشده');
}));

test('پرداخت بیمه (T062) بدهی بیمهٔ همان لیست را می‌بندد، نه هزینه', async () => inWorkspace(async () => {
  june = importRun('۱۴۰۵/۰۶', '2026-09-01');
  assert.equal(balanceOf('payroll-insurance-payable'), -15_000_000);
  const expenseBefore = expenseTotal();
  paid = paymentEvent(15);
  const proposal = await propose(paid);
  assert.equal(proposal.analysisCost.source, 'rules');
  const prepared = assistant.prepareReviewProposal(db(), row(paid), proposal);
  assert.equal(prepared.canPost, true, prepared.postingBlockers.join(' | '));
  assert.equal(prepared.insuranceRun.id, june.id);
  const posted = database.reviewAiFeedback(paid.id, proposal.id, { accepted: true }).item;
  const lines = db().prepare(`SELECT a.source_kind kind,l.debit,l.credit FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.entry_id=?`).all(posted.journalEntryId);
  assert.deepEqual(lines.map((l) => [l.kind, l.debit, l.credit]).sort(), [['operational-account', 0, 15_000_000], ['payroll-insurance-payable', 15_000_000, 0]]);
  assert.equal(balanceOf('payroll-insurance-payable'), 0);
  assert.equal(expenseTotal(), expenseBefore, 'سهم کارفرما دوباره هزینه نمی‌شود');
  assert.ok(database.getPayrollRun(june.id).insurancePaidAt);
  assert.throws(() => database.payPayrollLiability(june.id, 'insurance', { account: 'cash' }), { code: 'PAYROLL_ALREADY_PAID' });
  assert.throws(() => database.reversePayrollRun(june.id), { code: 'PAYROLL_HAS_PAYMENTS' });
}));

test('مبلغ نابرابر یا دو لیست باز: سؤال، بدون ثبت؛ پاسخ دوره همان لیست را می‌بندد', async () => inWorkspace(async () => {
  const july = importRun('۱۴۰۵/۰۷', '2026-09-28');
  const partial = paymentEvent(14);
  const mismatch = await propose(partial);
  assert.equal(mismatch.lines.length, 0);
  assert.ok(mismatch.questions.some((q) => q.text.includes('برابر نیست')), JSON.stringify(mismatch.questions));
  const insurancePayable = db().prepare("SELECT id FROM ledger_accounts WHERE source_kind='payroll-insurance-payable'").get().id;
  assert.throws(() => database.recordReviewedComposite(partial.id, {
    lines: [{ accountId: insurancePayable, debit: 14_000_000, credit: 0 }, { accountId: 'cash', debit: 0, credit: 14_000_000 }],
    reason: 'ثبت دستی پرداخت بیمه', proposalId: mismatch.id,
  }), { code: 'REVIEW_NATURE_REQUIRED' });
  database.rejectEvent(partial.id, 'آزمون: مبلغ با لیست برابر نیست');

  // برگشت پرداخت خرداد، آن لیست را دوباره باز می‌کند.
  database.reverseEvent(paid.id, 'آزمون: برگشت پرداخت بیمه');
  assert.equal(database.getPayrollRun(june.id).insurancePaidAt, null);
  assert.equal(balanceOf('payroll-insurance-payable'), -30_000_000);

  const item = paymentEvent(15);
  const ambiguous = await propose(item);
  assert.equal(ambiguous.lines.length, 0);
  assert.ok(ambiguous.questions.some((q) => q.text.includes('کدام دوره')), JSON.stringify(ambiguous.questions));
  const answered = await propose(item, '۱۴۰۵/۰۷');
  const prepared = assistant.prepareReviewProposal(db(), row(item), answered);
  assert.equal(prepared.canPost, true, prepared.postingBlockers.join(' | '));
  assert.equal(prepared.insuranceRun.id, july.id);
  database.reviewAiFeedback(item.id, answered.id, { accepted: true });
  assert.ok(database.getPayrollRun(july.id).insurancePaidAt);
  assert.equal(database.getPayrollRun(june.id).insurancePaidAt, null);
  // خرداد هنوز از صفحهٔ حقوق قابل پرداخت است.
  database.payPayrollLiability(june.id, 'insurance', { account: 'cash' });
  assert.equal(balanceOf('payroll-insurance-payable'), 0);
}));

test('تخصیص پرداخت بیمه در پشتیبان می‌ماند', () => inWorkspace(() => {
  const snapshot = database.financialBackupSnapshot();
  assert.equal(snapshot.tables.accounting_review_insurance.length, 1);
}));

test.after(() => removeTempDatabase(databasePath));
