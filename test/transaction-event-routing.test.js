import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('txn-events');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'event-owner';
process.env.ADMIN_PASSWORD = 'event-safe-password-7731';

const database = await import(`../server/db.js?events=${process.pid}`);
const accounting = await import(`../server/accounting.js?events=${process.pid}`);
const { transactionConfidenceComponents } = await import(`../server/transactionEvent.js?events=${process.pid}`);
database.ensureAdmin();

function inPrimary(callback) {
  return database.runInWorkspace('primary', { role: 'owner', userId: 'test-owner' }, callback);
}

/** یک ثبت با تردید گزارش‌شده — همان شکلی که تحلیلگر گفتار می‌سازد. */
const doubtful = (overrides = {}) => ({
  amount: 400_000, type: 'expense', category: 'سایر', rawText: 'یه چیزی حدود چهارصد دادم',
  source: 'voice', confidence: 0.44, needsReview: true,
  reviewReasons: ['مبلغ دقیق در گفتار مشخص نیست.'],
  confidenceDetails: { amount: { score: 0.4, reason: 'مبلغ تقریبی گفته شده.' } },
  occurredAt: '2026-06-01T08:00:00.000Z', ...overrides,
});

const journalCount = (db, transactionId) => db
  .prepare("SELECT COUNT(*) AS total FROM journal_entries WHERE source_type='transaction' AND source_id=?")
  .get(transactionId).total;

// ------------------------------------------------------------------ نگاشت

// نبودِ نمره یعنی تردیدی گزارش نشده. اگر این را «اطمینان صفر» بخوانیم، هر ثبت
// دستی هم به صف می‌رود و صف عملاً بی‌معنی می‌شود.
test('ثبت بدون تردیدِ گزارش‌شده مؤلفه‌های مطمئن می‌گیرد', () => {
  const components = transactionConfidenceComponents({
    amount: 100_000, type: 'income', category: 'فروش', accountId: 'cash-1',
  });
  assert.equal(components.amountCertainty.score, 1);
  assert.equal(components.moneyDirectionCertainty.score, 1);
  // چیزی که دربارهٔ آن نمی‌دانیم گزارش نمی‌شود تا وزنش از میانگین بیرون برود.
  assert.equal(components.bankReconciliationMatch, undefined);
  assert.equal(components.counterpartyCertainty, undefined);
});

test('تردید گزارش‌شده همان نمره را به موتور اطمینان می‌رساند', () => {
  const components = transactionConfidenceComponents(doubtful());
  assert.equal(components.amountCertainty.score, 0.4);
  assert.equal(components.aiExtractionConfidence.score, 0.44);
});

// ------------------------------------------------------- مسیر ثبت خودکار

test('ثبت مطمئن مثل قبل سند می‌خورد و وارد صف نمی‌شود', () => inPrimary(() => {
  const [id] = database.insertTransactions({ transcript: 'فروش نقدی', transactions: [
    { amount: 900_000, type: 'income', category: 'فروش', rawText: 'نهصد هزار فروش', occurredAt: '2026-06-02T09:00:00.000Z' },
  ] });
  const db = database.activeWorkspaceDatabase();
  assert.equal(journalCount(db, id), 1, 'سند باید همان لحظه زده شود');
  assert.equal(database.reviewQueue().items.some((item) => item.sourceEventId === `transaction:${id}`), false);
}));

// --------------------------------------------------- مسیر نگه‌داشتن سند

test('ثبت مشکوک سند نمی‌خورد و در صف بررسی می‌نشیند', () => inPrimary(() => {
  const [id] = database.insertTransactions({ transcript: 'یه چیزی حدود چهارصد دادم', transactions: [doubtful()] });
  const db = database.activeWorkspaceDatabase();
  assert.equal(journalCount(db, id), 0, 'سند نباید بدون تأیید زده شود');

  const queued = database.reviewQueue().items.find((item) => item.sourceEventId === `transaction:${id}`);
  assert.ok(queued, 'باید در صف بررسی باشد');
  assert.equal(queued.status, 'pending');
  assert.ok(queued.confidence.reasons.length > 0, 'دلیل توقف باید همراهش باشد');
  // ردیف تراکنش سر جایش است: کاربر ثبتش را کرده و آن واقعیت دارد.
  assert.ok(db.prepare('SELECT 1 FROM transactions WHERE id=?').get(id));
}));

/**
 * این همان تله‌ای است که یک بار در مسیر تسویه گرفتارش شدیم.
 *
 * `migrateAccountingLedger` هر تراکنش بی‌سند را سند می‌زند و روی هر بار باز شدن
 * تراز آزمایشی هم اجرا می‌شود. بدون استثنا کردن سندِ عمداً نگه‌داشته‌شده، همان
 * سندی که منتظر حسابدار بود، پشت سرش خودکار ثبت می‌شد.
 */
test('مهاجرت دفتر، سند نگه‌داشته‌شده را خودش نمی‌زند', () => inPrimary(() => {
  const [id] = database.insertTransactions({ transcript: 'مشکوک دوم', transactions: [doubtful({ amount: 310_000 })] });
  const db = database.activeWorkspaceDatabase();
  accounting.migrateAccountingLedger(db);
  accounting.trialBalance(db);
  assert.equal(journalCount(db, id), 0, 'مهاجرت نباید سند منتظر را ثبت کند');
}));

test('تأیید حسابدار، سند را با همان شکل تراکنش می‌زند', () => inPrimary(() => {
  const [id] = database.insertTransactions({ transcript: 'مشکوک سوم', transactions: [doubtful({ amount: 520_000, category: 'حمل و نقل' })] });
  const db = database.activeWorkspaceDatabase();
  const queued = database.reviewQueue().items.find((item) => item.sourceEventId === `transaction:${id}`);

  const approved = database.approveEvent(queued.id);
  assert.equal(approved.status, 'posted');
  // لنگر سند باید «تراکنش» بماند، وگرنه مهاجرت سند دومی می‌سازد.
  assert.equal(journalCount(db, id), 1);
  accounting.migrateAccountingLedger(db);
  assert.equal(journalCount(db, id), 1, 'سند دوم نباید ساخته شود');
  assert.equal(database.reviewQueue().items.some((item) => item.id === queued.id), false);
}));

test('رد کردن سند نمی‌سازد و دلیلش در تاریخچه می‌ماند', () => inPrimary(() => {
  const [id] = database.insertTransactions({ transcript: 'مشکوک چهارم', transactions: [doubtful({ amount: 77_000 })] });
  const db = database.activeWorkspaceDatabase();
  const queued = database.reviewQueue().items.find((item) => item.sourceEventId === `transaction:${id}`);

  database.rejectEvent(queued.id, 'این را صاحب کسب‌وکار اشتباه گفته بود.');
  assert.equal(journalCount(db, id), 0);
  accounting.migrateAccountingLedger(db);
  assert.equal(journalCount(db, id), 0, 'موردِ ردشده هیچ‌وقت نباید سند بگیرد');

  const trail = database.eventAudit(queued.id).items;
  assert.ok(trail.some((entry) => entry.stage === 'rejected'), 'رد کردن باید در تاریخچه بماند');
  assert.ok(trail.some((entry) => entry.stage === 'captured'), 'گفتهٔ اولیه هم باید مانده باشد');
}));

// همان گفته با ارسال دوباره نباید دو رویداد بسازد؛ `clientId` تضمین می‌کند ردیف
// تراکنش هم یکی بماند.
test('ارسال دوبارهٔ یک ثبت، رویداد دوم نمی‌سازد', () => inPrimary(() => {
  const payload = { transcript: 'تکراری', transactions: [doubtful({ amount: 145_000, clientId: 'client-repeat-1' })] };
  const [first] = database.insertTransactions(payload);
  const [second] = database.insertTransactions({ ...payload, allowDuplicates: true });
  assert.equal(first, second, 'ردیف تراکنش باید همان باشد');
  const matching = database.reviewQueue().items.filter((item) => item.sourceEventId === `transaction:${first}`);
  assert.equal(matching.length, 1);
}));
