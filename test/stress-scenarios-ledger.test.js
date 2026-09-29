import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('stress-ledger');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'stress-owner';
process.env.ADMIN_PASSWORD = `stress-${crypto.randomUUID()}`;

const database = await import(`../server/db.js?stress=${process.pid}`);
const store = await import(`../server/financialEventStore.js?stress=${process.pid}`);
const { parseFinancialText } = await import('../shared/parser.js');

database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const inPrimary = (callback) => database.runInWorkspace('primary', { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const all = JSON.parse(readFileSync(new URL('./fixtures/stress-scenarios-v1.json', import.meta.url), 'utf8'));
const textOf = (id) => all.find((item) => item.id === id).text;

/**
 * آزمون استرس روی دیتابیس، با موتور روشن — همان چیزی که روی دفتر آزمایشی
 * اجرا می‌شود.
 *
 * `stress-scenarios.test.js` رفتار موتور را بدون دیتابیس می‌سنجد. اینجا سه چیزی
 * سنجیده می‌شود که فقط با دیتابیس معنا دارد: ردیف نقدی ساخته می‌شود یا نه، مورد
 * به کدام صف می‌رود، و کلید «تأیید» چه چیزی را اجازه می‌دهد.
 */

function say(id) {
  const text = textOf(id);
  const transactions = parseFinancialText(text, { source: 'voice' }).transactions.map((item) => ({ ...item, source: 'voice' }));
  const before = db().prepare("SELECT COUNT(*) AS count FROM transactions WHERE status!='deleted'").get().count;
  const ids = database.insertTransactions({ transcript: text, transactions });
  const after = db().prepare("SELECT COUNT(*) AS count FROM transactions WHERE status!='deleted'").get().count;
  const events = ids.map((id) => store.findEventBySource(db(), `transaction:${id}`));
  return { ids, rowsAdded: after - before, events, queued: ids.queuedForAccountant || 0 };
}

const journalFor = (transactionId) => db().prepare(`SELECT ledger_accounts.source_kind AS kind,journal_lines.debit,journal_lines.credit
  FROM journal_entries JOIN journal_lines ON journal_lines.entry_id=journal_entries.id
  JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
  WHERE journal_entries.source_type='transaction' AND journal_entries.source_id=?`).all(transactionId);

test('آماده‌سازی: دفتر آزمایشی با موتور تصمیم روشن', () => {
  inPrimary(() => {
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true });
    assert.equal(database.automationPolicy().engineV2, true);
  });
});

test('T101 — اصلاح ثبت قبلی، هیچ ردیف نقدی نمی‌سازد و به حسابدار می‌رود', () => {
  inPrimary(() => {
    const beforeQueue = store.listReviewQueue(db(), { route: 'accountant-review' }).length;
    const result = say('T101');
    assert.equal(result.rowsAdded, 0, 'ماندهٔ صندوق نباید تکان بخورد');
    assert.ok(result.queued >= 1);
    assert.ok(store.listReviewQueue(db(), { route: 'accountant-review' }).length > beforeQueue, 'مورد باید در صف حسابدار باشد');
  });
});

test('T050 — چک دستی که وصول نشده، پول نیست', () => {
  inPrimary(() => {
    const result = say('T050');
    assert.equal(result.rowsAdded, 0);
    assert.ok(result.queued >= 1);
  });
});

test('خرید نسیهٔ آزمون واقعی، نه ماندهٔ نقدی می‌سازد نه با تأیید ساده سند نقدی', () => {
  inPrimary(() => {
    const text = 'امروز 15 میلیون تومان کالا نسیه از شرکت اپسیلون خریدیم و پولی ندادیم';
    const transactions = parseFinancialText(text, { source: 'voice' }).transactions.map((item) => ({ ...item, source: 'voice' }));
    const before = db().prepare("SELECT COUNT(*) AS count FROM transactions WHERE status!='deleted'").get().count;
    const ids = database.insertTransactions({ transcript: text, transactions });
    assert.ok(ids.queuedForAccountant >= 1);
    assert.equal(db().prepare("SELECT COUNT(*) AS count FROM transactions WHERE status!='deleted'").get().count, before);
    const event = store.listReviewQueue(db(), { route: 'accountant-review' }).find((item) => item.event.evidence === text);
    assert.ok(event);
    assert.throws(() => database.approveEvent(event.id), { code: 'EVENT_PLAN_REVISION_REQUIRED' });
    assert.equal(db().prepare('SELECT status FROM financial_events WHERE id=?').get(event.id).status, 'pending');
  });
});

test('سه گفتهٔ جمع و اجزا هرکدام فقط یک پروندهٔ بررسی می‌سازند، بدون سند یا ردیف نقدی', () => {
  inPrimary(() => {
    const texts = [
      'امروز 22 میلیون تومان فروش داشتیم شامل 20 میلیون تومان کالا و 2 میلیون تومان مالیات ارزش افزوده',
      'امروز 15 میلیون تومان قسط وام پرداخت کردم که 12 میلیون تومان اصل و 3 میلیون تومان سود بود',
      'امروز 30 میلیون تومان حقوق ناخالص شناسایی شد که 3 میلیون تومان بیمه و 2 میلیون تومان مالیات کسر میشود و هنوز پرداخت نکردیم',
    ];
    const cashBefore = db().prepare('SELECT COUNT(*) AS count FROM transactions').get().count;
    const journalBefore = db().prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count;
    for (const [index, text] of texts.entries()) {
      const created = database.queueCompositeUtterance(text, { clientId: `real-composite-${index}` });
      assert.equal(created.status, 'pending');
      const again = database.queueCompositeUtterance(text, { clientId: `real-composite-${index}` });
      assert.equal(again.duplicate, true, 'ارسال تکراری همان شناسه پروندهٔ دوم نمی‌سازد');
      const row = store.listReviewQueue(db(), { route: 'accountant-review' }).find((item) => item.id === created.id);
      assert.equal(row.event.kind, 'review-placeholder');
      assert.equal(row.event.utterance, text);
      assert.equal(row.event.amountReferenceOnly, true);
      assert.equal(db().prepare('SELECT posting_plan FROM financial_events WHERE id=?').get(created.id).posting_plan.includes('"lines":[]'), true);
      assert.throws(() => database.approveEvent(created.id), { code: 'EVENT_PLAN_REVISION_REQUIRED' });
    }
    assert.equal(db().prepare('SELECT COUNT(*) AS count FROM transactions').get().count, cashBefore);
    assert.equal(db().prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count, journalBefore);
  });
});

test('اصلاح مبلغ از ۲۱ به ۱۲ میلیون یک مورد در صف است، نه دو اصلاح جدا', () => {
  inPrimary(() => {
    const text = 'قبلا هزینه تعمیر را اشتباها 21 میلیون تومان ثبت کردم مبلغ درست 12 میلیون تومان است';
    const transactions = parseFinancialText(text, { source: 'text' }).transactions;
    assert.equal(transactions.length, 1);
    const before = store.listReviewQueue(db(), { route: 'accountant-review' }).filter((item) => item.event.evidence === text).length;
    const ids = database.insertTransactions({ transcript: text, transactions });
    assert.equal(ids.length, 0);
    assert.equal(ids.queuedForAccountant, 1);
    const queued = store.listReviewQueue(db(), { route: 'accountant-review' }).filter((item) => item.event.evidence === text);
    assert.equal(queued.length, before + 1);
    assert.equal(queued[0].amount, 12_000_000, 'مبلغ درست فقط برای نمایش است؛ سند خودکار نمی‌خورد');
    assert.throws(() => database.approveEvent(queued[0].id), { code: 'EVENT_PLAN_REVISION_REQUIRED' });
  });
});

test('نوع پروندهٔ بررسی حتی با مسیر خودکار تزریق‌شده سند نمی‌سازد', async () => {
  const { normalizeFinancialEvent, EVENT_KINDS } = await import('../shared/financialEvent.js');
  inPrimary(() => {
    const created = store.recordFinancialEvent(db(), normalizeFinancialEvent({
      kind: EVENT_KINDS.REVIEW_PLACEHOLDER, amount: 22_000_000, occurredAt: new Date().toISOString(),
      evidence: 'جمع و اجزا هنوز روشن نیست', amountReferenceOnly: true,
    }), { sourceEventId: 'composite:forced-auto-test', decision: { route: 'auto', reasons: [] } });
    assert.equal(created.status, 'pending');
    assert.equal(created.route, 'accountant-review');
    assert.throws(() => store.approveFinancialEvent(db(), created.id), { code: 'EVENT_PLAN_REVISION_REQUIRED' });
  });
});

test('T010 — «نمی‌دانم» به صف حسابدار می‌رود و بدون دلیل تأیید نمی‌شود', () => {
  inPrimary(() => {
    const { ids, events } = say('T010');
    const [event] = events;
    assert.equal(event.route, 'accountant-review');
    assert.deepEqual(journalFor(ids[0]), [], 'پیش از بررسی هیچ سندی نباید بخورد');
    assert.throws(() => database.approveEvent(event.id), { code: 'EVENT_PLAN_REVISION_REQUIRED' });
    assert.throws(() => database.approveEvent(event.id, { reason: 'ثبت به تشخیص حسابدار' }), { code: 'EVENT_PLAN_REVISION_REQUIRED' });
    assert.deepEqual(journalFor(ids[0]), [], 'توضیح متنی نقشهٔ سند مبهم را تأیید نمی‌کند');
  });
});

test('رویداد معلق تا زمان تصمیم، موجودی حساب و گزارش نقدی را تغییر نمی‌دهد', () => {
  inPrimary(() => {
    const before = database.listAccounts().find((account) => account.id === 'cash').balance;
    const beforeToday = database.getToday().summary.netCashFlow;
    const beforeReport = database.report('month').summary.netCashFlow;
    const beforeClosing = database.previewDayClosing().expectedCash;
    const text = 'فروش نسیه ۲۰ میلیون تومان به شرکت گاما، پولی دریافت نکردیم';
    const transactions = parseFinancialText(text, { source: 'text' }).transactions;
    const ids = database.insertTransactions({ transcript: text, transactions });
    assert.equal(ids.length, 0, 'رویداد غیرنقدی ردیف نقدی نمی‌سازد');
    assert.ok(ids.queuedForAccountant > 0, 'شاهد در صف حسابدار حفظ می‌شود');
    const event = store.listReviewQueue(db(), { route: 'accountant-review' }).find((item) => item.event.evidence === text);
    assert.ok(event);
    assert.throws(() => database.approveEvent(event.id), { code: 'EVENT_PLAN_REVISION_REQUIRED' });
    assert.equal(database.listAccounts().find((account) => account.id === 'cash').balance, before);
    assert.equal(database.getToday().summary.netCashFlow, beforeToday);
    assert.equal(database.report('month').summary.netCashFlow, beforeReport);
    assert.equal(database.previewDayClosing().expectedCash, beforeClosing);
  });
});

test('T006 — پیش‌پرداخت به تأمین‌کننده هزینهٔ ماه نمی‌شود', () => {
  inPrimary(() => {
    const { ids, events } = say('T006');
    assert.equal(events[0].route, 'accountant-review');
    assert.equal(journalFor(ids[0]).some((line) => line.kind === 'expense-category'), false);
  });
});

test('T001 — اجارهٔ اردیبهشتِ گذشته، هزینهٔ اجاره است و با تأیید درست ثبت می‌شود', () => {
  inPrimary(() => {
    const { ids, events } = say('T001');
    const [event] = events;
    const decision = store.decisionForEvent(db(), event.id);
    assert.equal(decision.decisionStatus, 'decided');
    assert.equal(decision.treatment, 'period-expense');
    if (event.status !== 'posted') database.approveEvent(event.id);
    const lines = journalFor(ids[0]);
    assert.ok(lines.some((line) => line.kind === 'expense-category' && line.debit === 12_000_000), JSON.stringify(lines));
    assert.equal(lines.some((line) => line.kind === 'prepaid-asset'), false);
  });
});

test('مسیرهای داخلی با واژهٔ «چک» یا «اصلاح» همچنان ردیف می‌سازند', () => {
  // خط صورت‌حساب بانک («واریز چک») و رسید («شماره چک») متن خودشان را می‌سازند
  // و شناسهٔ ردیف ساخته‌شده را لازم دارند؛ فقط گفتهٔ کاربر صف می‌شود.
  inPrimary(() => {
    const ids = database.insertTransactionRows({ transcript: 'واریز چک شماره ۱۲۳ اصلاح شده', transactions: [{
      amount: 4_000_000, type: 'income', category: 'سایر درآمدها', rawText: 'واریز چک', source: 'text', accountId: 'cash',
    }] });
    assert.equal(ids.length, 1, 'ردیف باید ساخته شود');
  });
});
