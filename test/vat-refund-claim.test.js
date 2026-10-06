import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * طلب استرداد ارزش افزوده.
 *
 * وصول استرداد (T076) فقط وقتی سند می‌خورد که «سند طلب» واقعی در دفتر باشد؛
 * وگرنه یا درآمد تازه ساخته می‌شود یا پرونده بن‌بست می‌ماند. طلب از ماندهٔ
 * واقعی دو حساب ارزش افزوده ساخته می‌شود — اعتبار خرید یا اضافه‌پرداخت —
 * و هیچ‌وقت بیشتر از آن.
 */
const databasePath = tempDatabase('vat-refund-claim');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'vat-claim-owner';
process.env.ADMIN_PASSWORD = 'vat-claim-strong-password-5521';

const database = await import('../server/db.js');
const accounting = await import('../server/accounting.js');
const store = await import('../server/financialEventStore.js');
const assistant = await import('../server/reviewAssistant.js');
const ai = await import('../server/accountingReviewAi.js');
const { minimumRoleForRequest, roleAllows } = await import('../server/access.js');
database.ensureAdmin();

const owner = database.authenticateUser('vat-claim-owner', 'vat-claim-strong-password-5521');
const workspace = database.createWorkspace(owner.id, { name: 'بازرگانی آزمون استرداد', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();
const noNetwork = async () => { throw new Error('استرداد مالیات نباید سراغ API برود'); };
const refundText = 'اداره دارایی ده میلیون تومن از مالیات ارزش افزوده فصول قبل رو بابت اضافه پرداختی به حساب شرکت عودت داد.';
const refundEvent = (amount) => store.recordFinancialEvent(db(), {
  kind: 'cash-income', amount, occurredAt: '2026-10-03', evidence: refundText, eventNature: 'new', category: 'سایر',
}, { sourceEventId: crypto.randomUUID(), decision: { route: 'accountant-review', guardBlocked: true, reasons: ['بررسی حسابدار لازم است'] } });
const row = (item) => db().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id);
const receivable = () => db().prepare("SELECT id FROM ledger_accounts WHERE source_kind='tax-receivable' AND source_key='vat-refund'").get()?.id;

test('طلب استرداد فقط از ماندهٔ واقعی و با شمارهٔ اظهارنامه ثبت می‌شود', () => inWorkspace(() => {
  database.issueInvoice(database.createInvoice({
    documentType: 'purchase', customerName: 'مواد پارس', tax: 4_000_000,
    items: [{ title: 'گرانول', quantity: 1, unitPrice: 40_000_000 }],
  }).id);
  assert.deepEqual(accounting.vatRefundClaimable(db()), { fromInput: 4_000_000, fromOverpayment: 0, total: 4_000_000 });
  assert.equal(database.taxReport({}).ledger.refundClaimable, 4_000_000);
  assert.throws(() => database.claimVatRefund({ amount: 1_000_000, reference: '' }), { code: 'VAT_CLAIM_REFERENCE_REQUIRED' });
  assert.throws(() => database.claimVatRefund({ amount: 0, reference: 'اظهارنامه ۱۲' }), { code: 'VAT_CLAIM_AMOUNT_INVALID' });
  assert.throws(() => database.claimVatRefund({ amount: 4_000_001, reference: 'اظهارنامه ۱۲' }), { code: 'VAT_CLAIM_EXCEEDS_BALANCE' });
  assert.equal(receivable(), undefined, 'طلب ردشده نباید حسابی بسازد یا سندی بزند');
}));

test('اعتبار خرید و اضافه‌پرداخت هر دو به طلب منتقل می‌شوند و تراز می‌ماند', () => inWorkspace(() => {
  // اضافه‌پرداخت: بیش از بدهی فروش به حساب مالیات فروش پرداخت شده.
  database.issueInvoice(database.createInvoice({
    documentType: 'sales', customerName: 'پخش نوین', tax: 1_000_000,
    items: [{ title: 'نایلون', quantity: 1, unitPrice: 10_000_000 }],
  }).id);
  const outputId = accounting.vatBalances(db()).outputAccountId;
  const equity = db().prepare("SELECT id FROM ledger_accounts WHERE source_kind='system' AND source_key='opening-equity'").get().id;
  accounting.postJournalEntry(db(), {
    sourceType: 'vat-overpayment-test', sourceId: crypto.randomUUID(), occurredAt: '2026-09-20', memo: 'پرداخت بیش از بدهی',
    lines: [{ accountId: outputId, debit: 3_000_000, credit: 0 }, { accountId: equity, debit: 0, credit: 3_000_000 }],
  });
  assert.deepEqual(accounting.vatRefundClaimable(db()), { fromInput: 4_000_000, fromOverpayment: 2_000_000, total: 6_000_000 });

  const claim = database.claimVatRefund({ amount: 5_000_000, occurredAt: '2026-10-01', reference: 'اظهارنامه ۱۴۰۵-۲' });
  assert.equal(claim.fromInput, 4_000_000);
  assert.equal(claim.fromOverpayment, 1_000_000);
  const lines = db().prepare('SELECT account_id,debit,credit FROM journal_lines WHERE entry_id=?').all(claim.id);
  assert.equal(lines.find((line) => line.account_id === receivable()).debit, 5_000_000);
  assert.equal(lines.reduce((sum, line) => sum + line.debit - line.credit, 0), 0);
  const after = accounting.vatBalances(db());
  assert.equal(after.inputTax, 0);
  assert.equal(after.outputTax, -1_000_000);
  assert.equal(accounting.vatRefundClaimable(db()).total, 1_000_000);
  assert.equal(accounting.trialBalance(db()).balanced, true);
  // هیچ درآمد یا هزینه‌ای: طلب فقط جابه‌جایی بین حساب‌های ترازنامه است.
  const pnl = db().prepare(`SELECT count(*) n FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id
    WHERE l.entry_id=? AND a.type IN ('income','expense')`).get(claim.id).n;
  assert.equal(pnl, 0);
}));

test('وصول استرداد (T076) به طلب ثبت‌شده وصل می‌شود، نه درآمد تازه', async () => inWorkspace(async () => {
  const item = refundEvent(5_000_000);
  const proposal = await ai.proposeReview(db(), item.id, { facts: { accountId: 'cash' }, fetcher: noNetwork });
  const prepared = assistant.prepareReviewProposal(db(), row(item), proposal);
  assert.equal(prepared.canPost, true, prepared.postingBlockers.join(' | '));
  assert.equal(prepared.taxRefundClaim.accountId, receivable());
  const posted = database.reviewAiFeedback(item.id, proposal.id, { accepted: true }).item;
  const lines = db().prepare(`SELECT a.type,l.account_id,l.debit,l.credit FROM journal_lines l
    JOIN ledger_accounts a ON a.id=l.account_id WHERE l.entry_id=?`).all(posted.journalEntryId);
  assert.ok(lines.every((line) => line.type === 'asset'), 'استرداد درآمد نیست');
  assert.equal(lines.find((line) => line.account_id === receivable()).credit, 5_000_000);
  const balance = db().prepare('SELECT COALESCE(SUM(debit-credit),0) n FROM journal_lines WHERE account_id=?').get(receivable()).n;
  assert.equal(balance, 0);
}));

test('بدون سند طلب، سؤال راه ثبت طلب را نشان می‌دهد؛ سند دستی حساب طلب را نمی‌بندد', async () => inWorkspace(async () => {
  // طلب قبلی کامل وصول شده و ۱ میلیون اضافه‌پرداخت هنوز طلب نشده.
  const item = refundEvent(1_000_000);
  const proposal = await ai.proposeReview(db(), item.id, { facts: { accountId: 'cash' }, fetcher: noNetwork });
  assert.equal(proposal.lines.length, 0);
  assert.ok(proposal.questions.some((question) => question.text.includes('ثبت طلب استرداد')), JSON.stringify(proposal.questions));
  assert.throws(() => database.recordReviewedComposite(item.id, {
    lines: [{ accountId: 'cash', debit: 1_000_000, credit: 0 }, { accountId: receivable(), debit: 0, credit: 1_000_000 }],
    reason: 'ثبت دستی وصول مالیات', proposalId: proposal.id,
  }), { code: 'REVIEW_NATURE_REQUIRED' });
  assert.equal(row(item).status, 'pending');
}));

test('سند پیش‌نویس طلب نمی‌سازد ولی بستانکارِ پیش‌نویس ماندهٔ طلب را کم می‌کند', async () => inWorkspace(async () => {
  const { taxRefundContext } = await import('../server/reviewTaxRefund.js');
  const claim = database.claimVatRefund({ amount: 1_000_000, occurredAt: '2026-10-01', reference: 'اظهارنامه ۱۴۰۵-۳' });
  const reference = `${claim.fiscalYear}/${claim.documentNumber}`;
  const equity = db().prepare("SELECT id FROM ledger_accounts WHERE source_kind='system' AND source_key='opening-equity'").get().id;
  const draft = (lines, approvalState) => accounting.postJournalEntry(db(), {
    sourceType: 'tax-draft-test', sourceId: crypto.randomUUID(), occurredAt: '2026-10-02', memo: 'سند دستی پیش‌نویس', approvalState, lines,
  });
  draft([{ accountId: receivable(), debit: 2_000_000, credit: 0 }, { accountId: equity, debit: 0, credit: 2_000_000 }], 'submitted');
  draft([{ accountId: equity, debit: 400_000, credit: 0 }, { accountId: receivable(), debit: 0, credit: 400_000 }], 'draft');
  const context = (amount, answer) => taxRefundContext(db(), refundText, amount, {
    occurredAt: '2026-10-03', questionAnswers: answer ? { 'nature.vat-refund': { value: answer } } : undefined,
  });
  // بستانکار پیش‌نویس وصل نشده: انتخاب خودکار نه، ولی شمارهٔ صریح پذیرفته می‌شود.
  assert.equal(context(500_000).claim, null);
  const explicit = context(500_000, reference);
  assert.equal(explicit.claim?.journalId, claim.id, explicit.question?.text);
  assert.equal(explicit.claim.available, 600_000, 'بدهکار در انتظار کنترل حساب نمی‌شود، بستانکار پیش‌نویس می‌شود');
  assert.equal(context(700_000, reference).claim, null);
}));

test('ثبت طلب استرداد کار مدیر دفتر است', () => {
  assert.equal(minimumRoleForRequest('POST', '/tax/vat-refund-claim'), 'manager');
  assert.equal(roleAllows('accountant', minimumRoleForRequest('POST', '/tax/vat-refund-claim')), false);
});

test.after(() => removeTempDatabase(databasePath));
