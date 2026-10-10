import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { periodForDate } from '../server/accounting.js';

/**
 * سه قاعدهٔ هم‌خانواده، یک سازوکار تأیید:
 *
 * ۱. تأیید دونفره — در دفتری که حسابدار یا مدیر دیگری دارد، ثبت‌کننده منفی شدن
 *    صندوقِ خودش را تأیید نمی‌کند؛ درخواست به صف می‌رود، نفر دوم تأیید می‌کند و
 *    همان درخواست (همان مسیر، همان بدنه) یک بار اجرا می‌شود.
 * ۲. کالا بیش از موجودی خارج نمی‌شود — فروش با فاکتور، کاهش دستی — مگر با تأیید؛
 *    ورود روی کالای منفی سد نیست.
 * ۳. سندی که به پارسیان رفته بی‌صدا عوض یا حذف نمی‌شود — ویرایش و حذف ردیف،
 *    حتی برای بسته‌های قدیمی که فهرست سند ندارند — مگر با اصلاحیه و تأیید.
 */
process.env.DATABASE_PATH = tempDatabase('approval-family');
process.env.ADMIN_USERNAME = 'family-owner';
process.env.ADMIN_PASSWORD = 'family-strong-password-7731';
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser('family-owner', 'family-strong-password-7731');
const approval = { reason: 'خرید این کالا فردا ثبت می‌شود', role: 'accountant', userId: owner.id };
const db = () => database.activeWorkspaceDatabase();

// ─── ۲. کالا ─────────────────────────────────────────────────────────────────
const shop = database.createWorkspace(owner.id, { name: 'فروشگاه آزمون', profileType: 'business' });
const inShop = (callback, extra = {}) => database.runInWorkspace(shop.id, { role: 'owner', userId: owner.id, ...extra }, callback);
const stockBlocked = (callback) => assert.throws(callback, (error) => error.code === 'INVENTORY_NEGATIVE_STOCK'
  && error.status === 409 && error.details?.approvalKind === 'stock' && error.details.accounts[0].after < 0);

let product;
test('کالا: فروش بیش از موجودی بی‌تأیید برمی‌گردد و ردی نمی‌گذارد', () => inShop(() => {
  database.installChartTemplate();
  product = database.saveProduct({ name: 'کارتن ۵ لایه', stock: 5, buyPrice: 100_000, salePrice: 150_000 });
  const invoices = database.listInvoices().items.length;
  stockBlocked(() => database.createInvoice({
    documentType: 'sales', customerName: 'فروشگاه رضایی', issueNow: true,
    items: [{ productId: product.id, title: product.name, quantity: 7, unitPrice: 150_000 }],
  }));
  assert.equal(database.listInvoices().items.length, invoices, 'فاکتوری نماند');
  assert.equal(database.listProducts().find((item) => item.id === product.id).stock, 5);
  // کاهش دستی هم همان قاعده.
  stockBlocked(() => database.adjustStock(product.id, { quantity: -6, note: 'ضایعات' }));
  // تا صفرِ دقیق مجاز است.
  database.adjustStock(product.id, { quantity: -5, note: 'شمارش انبار' });
  assert.equal(database.listProducts().find((item) => item.id === product.id).stock, 0);
  database.adjustStock(product.id, { quantity: 5, unitCost: 100_000 });
}));

test('کالا: با تأیید حسابدار فروش ثبت می‌شود، منفی می‌ماند و دلیلش ثبت است', () => inShop(() => {
  database.createInvoice({
    documentType: 'sales', customerName: 'فروشگاه رضایی', issueNow: true,
    items: [{ productId: product.id, title: product.name, quantity: 7, unitPrice: 150_000 }],
  });
  assert.equal(database.listProducts().find((item) => item.id === product.id).stock, -2);
  const log = db().prepare("SELECT * FROM overdraft_approvals WHERE kind='stock' ORDER BY id DESC").get();
  assert.equal(log.account_id, `product:${product.id}`);
  assert.equal(log.balance_after, -2);
  assert.equal(log.reason, approval.reason);
}, { overdraftApproval: approval }));

test('کالا: ورود روی کالای منفی سد نیست؛ خروج بیشتر دوباره تأیید می‌خواهد', () => inShop(() => {
  database.adjustStock(product.id, { quantity: 1, unitCost: 100_000 });
  assert.equal(database.listProducts().find((item) => item.id === product.id).stock, -1);
  stockBlocked(() => database.adjustStock(product.id, { quantity: -1 }));
  database.adjustStock(product.id, { quantity: 10, unitCost: 120_000 });
  const after = database.listProducts().find((item) => item.id === product.id);
  assert.equal(after.stock, 9);
  assert.ok(after.inventoryValue > 0, 'خرید، ارزش منفی را پوشاند');
}));

// ─── ۱. تأیید دونفره ─────────────────────────────────────────────────────────
const office = database.createWorkspace(owner.id, { name: 'دفتر دونفره', profileType: 'business' });
let accountant;
const asOwner = (callback, extra = {}) => database.runInWorkspace(office.id, {
  role: 'owner', userId: owner.id, approvalMode: database.approvalModeFor(office.id, owner.id, 'owner'), ...extra,
}, callback);
const asAccountant = (callback) => database.runInWorkspace(office.id, { role: 'accountant', userId: accountant.id }, callback);
const spendBody = (amount) => ({ transcript: `${amount} خرید لوازم`, transactions: [{ amount, type: 'expense', category: 'سایر هزینه‌ها', source: 'text', settlement: 'none' }] });
const replay = (requestId, body) => ({ approvalRequestId: requestId, requestMethod: 'POST', requestPath: '/api/transactions', requestBody: body });

test('تنها تأییدکننده خودش تأیید می‌کند؛ با حسابدار دوم، نه', () => {
  assert.equal(database.approvalModeFor(office.id, owner.id, 'owner'), 'inline', 'مالک تنها');
  database.runInWorkspace(office.id, { role: 'owner', userId: owner.id }, () => {
    database.installChartTemplate();
    database.insertTransactions({ transcript: 'فروش', transactions: [{ clientId: 'office-in', amount: 1_000_000, type: 'income', category: 'فروش', source: 'text', settlement: 'none' }] });
    database.addWorkspaceMember(office.id, { username: 'family-accountant', displayName: 'حسابدار', temporaryPassword: 'Temp-family-pass-5521', role: 'accountant' });
  });
  accountant = database.authenticateUser('family-accountant', 'Temp-family-pass-5521');
  assert.equal(database.approvalModeFor(office.id, owner.id, 'owner'), 'request', 'مالک با حسابدار');
  assert.equal(database.approvalModeFor(office.id, accountant.id, 'accountant'), 'request', 'حسابدار با مالک');
  assert.equal(database.approvalModeFor(office.id, owner.id, 'viewer'), 'request', 'نقش بی‌اختیار');
});

let requestId;
test('دونفره: خطا می‌گوید «درخواست بفرست»؛ ثبت‌کننده درخواست خودش را تأیید نمی‌کند', () => asOwner(() => {
  assert.throws(() => database.insertTransactions(spendBody(3_000_000)),
    (error) => error.code === 'NEGATIVE_BALANCE' && error.details.approvalMode === 'request' && error.details.approvalKind === 'cash');
  const created = database.createApprovalRequest({ kind: 'cash', method: 'POST', path: '/api/transactions', body: spendBody(3_000_000), note: 'خرید فوری', message: 'صندوق منفی می‌شود' });
  requestId = created.id;
  assert.equal(created.status, 'pending');
  assert.throws(() => database.decideApprovalRequest(requestId, { decision: 'approve', reason: 'تأیید خودم' }), { code: 'APPROVAL_SELF_FORBIDDEN' });
  // درخواستِ تأییدنشده اجرا نمی‌شود.
  assert.throws(() => database.insertTransactions(spendBody(3_000_000)), { code: 'NEGATIVE_BALANCE' });
}));

test('دونفره: حسابدار تأیید می‌کند؛ فقط همان بدنه و فقط یک بار اجرا می‌شود', () => {
  asAccountant(() => {
    assert.throws(() => database.decideApprovalRequest(requestId, { decision: 'approve', reason: 'نه' }), { code: 'INVALID_INPUT' });
    assert.equal(database.decideApprovalRequest(requestId, { decision: 'approve', reason: 'تنخواه فردا شارژ می‌شود' }).status, 'approved');
  });
  // بدنهٔ دیگر (مبلغ بیشتر) با همان شناسه پذیرفته نمی‌شود.
  asOwner(() => assert.throws(() => database.insertTransactions(spendBody(9_000_000)), { code: 'NEGATIVE_BALANCE' }), replay(requestId, spendBody(9_000_000)));
  asOwner(() => database.insertTransactions(spendBody(3_000_000)), replay(requestId, spendBody(3_000_000)));
  asOwner(() => {
    assert.equal(database.getApprovalRequest(requestId).status, 'executed');
    const log = db().prepare("SELECT * FROM overdraft_approvals WHERE request_id=?").get(requestId);
    assert.equal(log.approved_by, accountant.id);
    assert.equal(log.requested_by, owner.id);
    assert.equal(log.reason, 'تنخواه فردا شارژ می‌شود');
  });
  // اجرای دوباره همان درخواست سد است.
  asOwner(() => assert.throws(() => database.insertTransactions(spendBody(3_000_000)), { code: 'NEGATIVE_BALANCE' }), replay(requestId, spendBody(3_000_000)));
});

test('دونفره: رد درخواست و لغو آن', () => {
  const created = asOwner(() => database.createApprovalRequest({ kind: 'stock', method: 'POST', path: '/api/products/x/adjust', body: { quantity: -3 } }));
  asAccountant(() => assert.equal(database.decideApprovalRequest(created.id, { decision: 'reject', reason: 'شمارش انبار لازم است' }).status, 'rejected'));
  asOwner(() => assert.throws(() => database.decideApprovalRequest(created.id, { decision: 'approve', reason: 'دوباره' }), { code: 'APPROVAL_REQUEST_DECIDED' }));
  const other = asOwner(() => database.createApprovalRequest({ kind: 'cash', method: 'DELETE', path: '/api/transactions/abc' }));
  assert.equal(asOwner(() => database.cancelApprovalRequest(other.id)).status, 'cancelled');
  assert.throws(() => asOwner(() => database.createApprovalRequest({ method: 'POST', path: '/api/approval-requests' })), { code: 'INVALID_INPUT' });
  assert.throws(() => asOwner(() => database.createApprovalRequest({ method: 'GET', path: '/api/transactions' })), { code: 'INVALID_INPUT' });
  assert.equal(asAccountant(() => database.listApprovalRequests({ status: 'all' })).length, 3);
});

// ─── ۳. قفل سند صادرشده به پارسیان ───────────────────────────────────────────
const inPrimary = (callback, extra = {}) => database.runInWorkspace('primary', { role: 'owner', userId: owner.id, overdraftApproval: null, ...extra }, callback);
const exportLocked = (callback) => assert.throws(callback, (error) => error.code === 'EXPORTED_ENTRY_LOCKED'
  && error.status === 409 && error.details?.approvalKind === 'export' && Boolean(error.details.accounts[0].entryId));
const now = new Date();
const month = periodForDate(now.toISOString());
let sale;
let fee;

test('صدور: بستهٔ تحویل‌شده اسنادش را قفل می‌کند — ویرایش و حذف ردیف سد است', () => inPrimary(() => {
  [sale] = database.insertTransactions({ transcript: 'فروش پروژه', transactions: [{ amount: 9_000_000, type: 'income', category: 'فروش', rawText: 'فروش پروژه', occurredAt: now.toISOString(), reviewState: 'ready' }] });
  [fee] = database.insertTransactions({ transcript: 'کارمزد', transactions: [{ amount: 200_000, type: 'expense', category: 'سایر هزینه‌ها', rawText: 'کارمزد', occurredAt: now.toISOString(), reviewState: 'ready' }] });
  const overview = database.accountingTransferOverview(month, 'generic-csv', now);
  assert.equal(overview.readiness.ready, true, JSON.stringify(overview.readiness.checks.filter((check) => !check.passed)));
  const batch = database.createAccountingTransferBatch({ month, targetSystem: 'generic-csv' }, now);
  // «تولیدشده» هنوز به پارسیان نرفته: اصلاح آزاد است.
  database.updateTransaction(fee, { amount: 250_000, type: 'expense', category: 'سایر هزینه‌ها', settlement: 'none' });
  const fresh = database.createAccountingTransferBatch({ month, targetSystem: 'generic-csv' }, now);
  assert.notEqual(fresh.id, batch.id);
  database.claimAccountingTransferBatchDownload(fresh.id);
  const before = db().prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  exportLocked(() => database.deleteTransaction(sale));
  exportLocked(() => database.updateTransaction(fee, { amount: 300_000, type: 'expense', category: 'سایر هزینه‌ها', settlement: 'none' }));
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, before, 'سندی ساخته نشد');
  assert.equal(database.getTransaction(fee).amount, 250_000, 'ردیف دست نخورد');
}));

test('صدور: با تأیید حسابدار، اصلاحیه ثبت می‌شود و در آمادگی بستهٔ بعد دیده می‌شود', () => {
  inPrimary(() => database.updateTransaction(fee, { amount: 300_000, type: 'expense', category: 'سایر هزینه‌ها', settlement: 'none' }),
    { overdraftApproval: { reason: 'کارمزد واقعی ۳۰۰ هزار بود', role: 'accountant', userId: owner.id } });
  inPrimary(() => {
    const reversal = db().prepare("SELECT memo FROM journal_entries WHERE entry_kind='reversal' ORDER BY created_at DESC,rowid DESC").get();
    assert.match(reversal.memo, /اصلاحیهٔ سند صادرشده به پارسیان/);
    const log = db().prepare("SELECT * FROM overdraft_approvals WHERE kind='export'").get();
    assert.match(log.account_id, /^entry:/);
    assert.equal(log.reason, 'کارمزد واقعی ۳۰۰ هزار بود');
    const check = database.accountingTransferOverview(month, 'generic-csv', now).readiness.checks.find((item) => item.id === 'post-export-corrections');
    assert.equal(check?.count, 2, 'معکوس و سند جایگزین');
    // سند تازه (اصلاحیه) هنوز صادر نشده، پس دوباره اصلاح‌پذیر است.
    database.updateTransaction(fee, { amount: 310_000, type: 'expense', category: 'سایر هزینه‌ها', settlement: 'none' });
  });
});

test('صدور: بستهٔ قدیمی بی‌فهرست هم از دورهٔ خودش محافظت می‌کند', () => inPrimary(() => {
  db().prepare('DELETE FROM accounting_transfer_entries').run();
  exportLocked(() => database.deleteTransaction(sale));
  // سندی که بعد از بسته ساخته شده، در آن نبوده است.
  db().prepare("UPDATE journal_entries SET created_at='2999-01-01 00:00:00' WHERE source_type='transaction' AND source_id=?").run(fee);
  database.deleteTransaction(fee);
}));
