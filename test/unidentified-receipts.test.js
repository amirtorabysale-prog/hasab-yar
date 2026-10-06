import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * چرخهٔ کامل وجه ناشناس: نگهداری ← تعیین تکلیف ← برگشت.
 *
 * وقتی منشأ معلوم می‌شود، همان پول دوباره دریافت نمی‌شود؛ فقط از بدهی موقت
 * به جای درستش منتقل می‌شود. و واریز تازه‌ای که با یک وجه ناشناسِ باز
 * می‌خواند، بی‌صدا دوباره ثبت نمی‌شود.
 */
const databasePath = tempDatabase('unidentified');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'unidentified-owner';
process.env.ADMIN_PASSWORD = 'unidentified-strong-password-7713';

const database = await import('../server/db.js');
const store = await import('../server/financialEventStore.js');
const ai = await import('../server/accountingReviewAi.js');
const accounting = await import('../server/accounting.js');
const { minimumRoleForRequest } = await import('../server/access.js');
database.ensureAdmin();

const owner = database.authenticateUser('unidentified-owner', 'unidentified-strong-password-7713');
const workspace = database.createWorkspace(owner.id, { name: 'ازمایشی', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const reviewEvent = (text, amount, accountId) => store.recordFinancialEvent(db(), {
  kind: 'cash-income', accountId, amount, occurredAt: '2026-10-03', evidence: text, eventNature: 'new', category: 'سایر درآمدها',
}, { sourceEventId: crypto.randomUUID(), decision: { route: 'accountant-review', guardBlocked: true, reasons: ['بررسی حسابدار لازم است'] } });
const sum = (kind) => db().prepare(`SELECT COALESCE(SUM(l.credit)-SUM(l.debit),0) n FROM journal_lines l JOIN journal_entries j ON j.id=l.entry_id
  JOIN ledger_accounts a ON a.id=l.account_id WHERE a.source_kind=? AND j.approval_state='approved'`).get(kind).n;
const incomeTotal = () => db().prepare(`SELECT COALESCE(SUM(l.credit)-SUM(l.debit),0) n FROM journal_lines l
  JOIN ledger_accounts a ON a.id=l.account_id WHERE a.type='income'`).get().n;
const bankBalance = (id) => database.listAccounts().find((item) => item.id === id).balance;
const transactionCount = () => db().prepare("SELECT count(*) n FROM transactions WHERE status!='deleted'").get().n;

let bank;
let customer;
let partner;
let invoice;
let hold;
let holdEvent;

test('آماده‌سازی: وجه ناشناس ۵۰ میلیونی در بانک نگه داشته می‌شود', async () => inWorkspace(async () => {
  bank = database.saveAccount({ name: 'بانک ملت آزمایشی', kind: 'bank', bankId: 'mellat' });
  customer = database.saveContact({ name: 'شرکت آریا', kind: 'customer' });
  partner = database.saveContact({ name: 'یوسفی شریک' });
  invoice = database.createInvoice({ contactId: customer.id, documentType: 'sales', items: [{ title: 'خدمات نصب', quantity: 1, unitPrice: 20_000_000 }] });
  database.issueInvoice(invoice.id, {});
  holdEvent = reviewEvent('پنجاه میلیون اومده تو حساب ملت، معلوم نیس کی ریخته، هیچکی فیش نیاورده.', 50_000_000, bank.id);
  const proposal = await ai.proposeReview(db(), holdEvent.id, { facts: { accountId: bank.id }, fetcher: () => { throw new Error('بدون API'); } });
  assert.equal(proposal.lines[1].role, 'unidentified-receipt');
  database.reviewAiFeedback(holdEvent.id, proposal.id, { accepted: true });
  const { items } = database.listUnidentifiedReceipts();
  assert.equal(items.length, 1);
  [hold] = items;
  assert.equal(hold.remaining, 50_000_000);
  assert.equal(hold.accountId, bank.id);
  assert.equal(sum('unidentified-receipt'), 50_000_000);
}));

test('واریز تازه با همان مبلغ و حساب، دوباره ثبت نمی‌شود و به حسابدار می‌رود', () => inWorkspace(() => {
  const item = store.recordFinancialEvent(db(), {
    kind: 'cash-income', accountId: bank.id, amount: 50_000_000, occurredAt: '2026-10-04', evidence: 'شرکت آریا پنجاه میلیون واریز کرد', eventNature: 'new', category: 'فروش',
  }, { sourceEventId: crypto.randomUUID(), decision: { route: 'auto' }, postJournal: () => { throw new Error('نباید ثبت شود'); } });
  assert.equal(item.route, 'accountant-review');
  const stored = JSON.parse(db().prepare('SELECT confidence FROM financial_events WHERE id=?').get(item.id).confidence);
  assert.ok(stored.reasons.some((reason) => reason.includes('وجه ناشناس')), stored.reasons.join(' | '));
  database.rejectEvent(item.id, 'آزمون: همان وجه ناشناس است');
}));

test('تعیین تکلیف روی فاکتور: فاکتور تسویه، بدون ردیف نقدی تازه و بدون درآمد', () => inWorkspace(() => {
  const [transactionsBefore, cashBefore, incomeBefore] = [transactionCount(), bankBalance(bank.id), incomeTotal()];
  assert.throws(() => database.resolveUnidentifiedReceipt(hold.lineId, { target: 'invoice', invoiceId: invoice.id, amount: 20_000_000, reason: 'کوتاه' }), { code: 'UNIDENTIFIED_REASON_REQUIRED' });
  assert.throws(() => database.resolveUnidentifiedReceipt(hold.lineId, { target: 'invoice', invoiceId: invoice.id, amount: 25_000_000, reason: 'فیش بانکی شرکت آریا رسید' }), { code: 'INVOICE_OVERPAYMENT' });
  const result = database.resolveUnidentifiedReceipt(hold.lineId, { target: 'invoice', invoiceId: invoice.id, amount: 20_000_000, occurredAt: '2026-10-05', reason: 'فیش بانکی شرکت آریا رسید' });
  assert.equal(result.remaining, 30_000_000);
  assert.equal(database.getInvoice(invoice.id).balanceDue, 0);
  assert.equal(database.getInvoice(invoice.id).status, 'paid');
  assert.equal(transactionCount(), transactionsBefore, 'پول یک بار وارد شده؛ ردیف نقدی تازه‌ای ساخته نمی‌شود');
  assert.equal(bankBalance(bank.id), cashBefore);
  assert.equal(incomeTotal(), incomeBefore, 'وصول فاکتور درآمد تازه نیست');
  assert.throws(() => database.recordInvoicePayment(invoice.id, { amount: 1_000_000, accountId: bank.id }), { code: 'INVOICE_OVERPAYMENT' });
}));

test('درآمد با ارزش افزوده، جاری شریک و استرداد؛ سقف مبلغ', () => inWorkspace(() => {
  const incomeBefore = incomeTotal();
  database.resolveUnidentifiedReceipt(hold.lineId, { target: 'income', category: 'خدمات پشتیبانی', amount: 11_000_000, vatAmount: 1_000_000, occurredAt: '2026-10-05', reason: 'قرارداد پشتیبانی مشتری حضوری' });
  assert.equal(incomeTotal(), incomeBefore + 10_000_000);
  assert.equal(accounting.vatBalances(db()).outputTax, 1_000_000);

  assert.throws(() => database.resolveUnidentifiedReceipt(hold.lineId, { target: 'partner', amount: 9_000_000, reason: 'یوسفی گفت خودش ریخته' }), { code: 'UNIDENTIFIED_CONTACT_REQUIRED' });
  database.resolveUnidentifiedReceipt(hold.lineId, { target: 'partner', contactId: partner.id, amount: 9_000_000, occurredAt: '2026-10-05', reason: 'یوسفی گفت خودش ریخته' });
  assert.equal(sum('partner-payable'), 9_000_000);

  assert.throws(() => database.resolveUnidentifiedReceipt(hold.lineId, { target: 'refund', amount: 10_000_001, reason: 'واریز اشتباهی بود و برگشت داده شد' }), { code: 'UNIDENTIFIED_AMOUNT_EXCEEDS' });
  const cashBefore = bankBalance(bank.id);
  database.resolveUnidentifiedReceipt(hold.lineId, { target: 'refund', amount: 10_000_000, occurredAt: '2026-10-06', reason: 'واریز اشتباهی بود و برگشت داده شد' });
  assert.equal(bankBalance(bank.id), cashBefore - 10_000_000, 'استرداد تنها حالتی است که پول واقعاً می‌رود');
  assert.equal(sum('unidentified-receipt'), 0);
  assert.equal(database.listUnidentifiedReceipts().items.length, 0);
  assert.equal(accounting.trialBalance(db()).balanced, true);
}));

test('نگهداری با تعیین تکلیف فعال برنمی‌گردد؛ برگشت تعیین تکلیف فاکتور را دوباره باز می‌کند', () => inWorkspace(() => {
  assert.throws(() => database.reverseEvent(holdEvent.id, 'آزمون برگشت وجه ناشناس'), { code: 'UNIDENTIFIED_HAS_RESOLUTIONS' });
  const closed = database.listUnidentifiedReceipts({ includeClosed: true }).items[0];
  const onInvoice = closed.resolutions.find((item) => item.target === 'invoice');
  database.reverseUnidentifiedReceiptResolution(onInvoice.id);
  assert.equal(database.getInvoice(invoice.id).balanceDue, 20_000_000);
  assert.equal(database.getInvoice(invoice.id).status, 'sent');
  assert.equal(database.listUnidentifiedReceipts().items[0].remaining, 20_000_000);
  assert.equal(sum('unidentified-receipt'), 20_000_000);
  assert.throws(() => database.reverseUnidentifiedReceiptResolution(onInvoice.id), { code: 'UNIDENTIFIED_RESOLUTION_MISSING' });
  assert.equal(accounting.trialBalance(db()).balanced, true);
}));

test('سند دستی وجه ناشناس را نمی‌بندد؛ تعیین تکلیف کار حسابدار است و در پشتیبان می‌ماند', async () => inWorkspace(async () => {
  const item = reviewEvent('ده میلیون پول ناشناس واریز شده معلوم نیس از کیه', 10_000_000, bank.id);
  const proposal = await ai.proposeReview(db(), item.id, { facts: { accountId: bank.id }, fetcher: () => { throw new Error('بدون API'); } });
  const holdAccount = db().prepare("SELECT id FROM ledger_accounts WHERE source_kind='unidentified-receipt'").get().id;
  const income = db().prepare("SELECT id FROM ledger_accounts WHERE type='income' LIMIT 1").get().id;
  assert.throws(() => database.recordReviewedComposite(item.id, {
    lines: [{ accountId: holdAccount, debit: 10_000_000, credit: 0 }, { accountId: income, debit: 0, credit: 10_000_000 }],
    reason: 'بستن دستی وجه ناشناس', proposalId: proposal.id,
  }), { code: 'REVIEW_NATURE_REQUIRED' });
  assert.equal(minimumRoleForRequest('POST', '/financial-events/unidentified/x/resolve'), 'accountant');
  assert.ok(database.financialBackupSnapshot().tables.unidentified_receipt_resolutions.length >= 4);
}));

test.after(() => removeTempDatabase(databasePath));
