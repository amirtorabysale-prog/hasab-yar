import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('event-consistency');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'consistency-owner';
process.env.ADMIN_PASSWORD = 'Consistency-Long-Passphrase-6620';

const database = await import(`../server/db.js?consistency=${process.pid}`);
const accounting = await import(`../server/accounting.js?consistency=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('consistency-owner', 'Consistency-Long-Passphrase-6620');
const workspace = database.createWorkspace(owner.id, { name: 'شرکت تطابق', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

const doubtful = (amount) => ({
  amount, type: 'expense', category: 'سایر', rawText: `حدود ${amount}`,
  source: 'voice', confidence: 0.3, needsReview: true,
  reviewReasons: ['مبلغ دقیق مشخص نیست.'],
  confidenceDetails: { amount: { score: 0.25, reason: 'تقریبی' } },
});

const cashBalance = () => database.listAccounts().find((item) => item.id === 'cash').balance;
const queuedFor = (id) => database.reviewQueue().items.find((item) => item.sourceEventId === `transaction:${id}`);

/**
 * ماندهٔ حساب و گزارش‌های کاربر از جدول تراکنش ساخته می‌شوند، نه از دفتر کل.
 *
 * پس رد کردن رویداد به‌تنهایی کافی نیست: ردیف تراکنش سر جایش می‌ماند و تا ابد
 * در ماندهٔ صندوق دیده می‌شود، درحالی‌که هیچ سندی ندارد و نخواهد داشت. دفتر و
 * برنامه دائم اختلاف نشان می‌دهند و هیچ‌کس نمی‌فهمد چرا.
 */
test('رد کردن، ردیف تراکنش را هم از ماندهٔ کاربر بیرون می‌برد', () => inWorkspace(() => {
  const before = cashBalance();
  const [id] = database.insertTransactions({ transcript: 'مشکوک', transactions: [doubtful(500_000)] });
  assert.equal(cashBalance(), before, 'مورد معلق پیش از تأیید نباید ماندهٔ قطعی را تغییر دهد');

  database.rejectEvent(queuedFor(id).id, 'اصلاً اتفاق نیفتاده بود');

  assert.equal(cashBalance(), before, 'بعد از رد، ماندهٔ صندوق باید سر جای اولش برگردد');
  const row = database.activeWorkspaceDatabase().prepare('SELECT status FROM transactions WHERE id=?').get(id);
  assert.equal(row.status, 'deleted');
  assert.equal(database.getToday().transactions.some((item) => item.id === id), false,
    'ثبتِ ردشده نباید در فهرست امروز بماند');
}));

test('ردیف ردشده حذف فیزیکی نمی‌شود و ردپایش می‌ماند', () => inWorkspace(() => {
  const [id] = database.insertTransactions({ transcript: 'مشکوک دوم', transactions: [doubtful(310_000)] });
  database.rejectEvent(queuedFor(id).id, 'دوباره‌کاری بود');
  const row = database.activeWorkspaceDatabase().prepare('SELECT id,status FROM transactions WHERE id=?').get(id);
  assert.ok(row, 'ردیف باید بماند، فقط با وضعیت حذف‌شده');
  assert.equal(row.status, 'deleted');
}));

/**
 * `reverseJournalEntry` وقتی سندی پیدا نکند بی‌صدا `null` برمی‌گرداند.
 *
 * چون سند این رویدادها به تراکنش لنگر می‌خورد و نه به خودِ رویداد، جست‌وجوی
 * لنگر اشتباه هیچ‌چیز پیدا نمی‌کرد: رویداد «معکوس‌شده» علامت می‌خورد ولی سندش
 * سر جایش می‌ماند. دفتر غلط می‌شد و هیچ نشانه‌ای هم نداشت.
 */
test('برگشت رویدادِ ثبت‌شده واقعاً سند معکوس می‌زند', () => inWorkspace(() => {
  const db = database.activeWorkspaceDatabase();
  const before = cashBalance();
  const [id] = database.insertTransactions({ transcript: 'مشکوک سوم', transactions: [doubtful(220_000)] });
  const queued = queuedFor(id);
  assert.equal(cashBalance(), before, 'تا پیش از تأیید، ماندهٔ قطعی ثابت است');
  database.approveEvent(queued.id);
  assert.equal(cashBalance(), before - 220_000, 'پس از تأیید، ردیف در مانده می‌نشیند');

  const normal = () => db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type='transaction' AND source_id=? AND entry_kind='normal'").get(id).n;
  const reversals = () => db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type='transaction' AND source_id=? AND entry_kind='reversal'").get(id).n;
  assert.equal(normal(), 1);
  assert.equal(reversals(), 0);

  database.reverseEvent(queued.id, 'اشتباه ثبت شده بود');

  assert.equal(reversals(), 1, 'سند معکوس باید واقعاً زده شود');
  assert.equal(accounting.trialBalance(db).balanced, true);
  // و ردیف کاربر هم باید برود، وگرنه ماندهٔ صندوق با دفتر نمی‌خواند.
  assert.equal(db.prepare('SELECT status FROM transactions WHERE id=?').get(id).status, 'deleted');
  assert.equal(cashBalance(), before, 'پس از برگشت، مانده دوباره اصلاح می‌شود');
}));

// دفتر و برنامه باید یک عدد بگویند. این آزمون همان اختلافی را می‌گیرد که
// کاربر آخر ماه می‌بیند و نمی‌تواند توضیحش بدهد.
test('پس از رد و برگشت، دفتر کل و ماندهٔ برنامه یک چیز می‌گویند', () => inWorkspace(() => {
  const db = database.activeWorkspaceDatabase();
  const [kept] = database.insertTransactions({ transcript: 'قطعی', transactions: [
    { amount: 1_000_000, type: 'income', category: 'فروش', rawText: 'یک میلیون فروش' },
  ] });
  assert.ok(kept);

  const [rejected] = database.insertTransactions({ transcript: 'مشکوک', transactions: [doubtful(400_000)] });
  database.rejectEvent(queuedFor(rejected).id, 'این رویداد مالی رخ نداده است');

  const balance = accounting.trialBalance(db);
  assert.equal(balance.balanced, true);
  const cashRow = balance.rows.find((row) => row.name === 'صندوق نقدی');
  assert.equal(cashRow.debitBalance - cashRow.creditBalance, cashBalance(),
    'ماندهٔ صندوق در دفتر کل باید دقیقاً همان چیزی باشد که برنامه نشان می‌دهد');
}));

test.after(() => removeTempDatabase(databasePath));
