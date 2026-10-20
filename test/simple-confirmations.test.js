import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { minimumRoleForRequest } from '../server/access.js';
import { pathNeedsProfessional } from '../shared/experience.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

const databasePath = tempDatabase('confirmations');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'confirm-owner';
process.env.ADMIN_PASSWORD = 'confirm-safe-password-5512';

const database = await import(`../server/db.js?confirm=${process.pid}`);
database.ensureAdmin();

function inPrimary(callback) {
  return database.runInWorkspace('primary', { role: 'owner', userId: 'test-owner', overdraftApproval: FIXTURE_OVERDRAFT }, callback);
}

/**
 * ثبتی که در بازهٔ «از کاربر بپرس» می‌افتد.
 *
 * تردید گزارش شده ولی آن‌قدر نیست که به دانش حسابداری نیاز باشد — کاربر خودش
 * می‌تواند بگوید درست است یا نه.
 */
const askable = (overrides = {}) => ({
  amount: 250_000, type: 'expense', category: 'حمل و نقل', rawText: 'دویست و پنجاه کرایه دادم',
  source: 'voice', confidence: 0.9, needsReview: true,
  reviewReasons: ['دستهٔ هزینه از روی سابقه حدس زده شده است.'],
  occurredAt: '2026-07-01T08:00:00.000Z', ...overrides,
});

// ------------------------------------------------------------------- مرز

// این مسیر عمداً بیرون از `/financial-events` است؛ اگر روزی زیر آن برود،
// کاربر سادهٔ کسب‌وکار ۴۰۳ می‌گیرد و پرسشش را هیچ‌وقت نمی‌بیند.
test('مسیر پرسش‌ها در محیط ساده باز می‌ماند', () => {
  assert.equal(pathNeedsProfessional('/confirmations'), false);
  assert.equal(pathNeedsProfessional('/confirmations/abc/confirm'), false);
  // در حالی که صف حسابدار بسته است.
  assert.equal(pathNeedsProfessional('/financial-events/review-queue'), true);
});

test('پاسخ دادن رتبهٔ ثبت می‌خواهد، نه فقط تماشا', () => {
  assert.equal(minimumRoleForRequest('GET', '/confirmations'), 'viewer');
  assert.equal(minimumRoleForRequest('POST', '/confirmations/abc/confirm'), 'accountant');
  assert.equal(minimumRoleForRequest('POST', '/confirmations/abc/handover'), 'accountant');
});

// ------------------------------------------------------------------ جریان

test('فقط مواردی که کاربر می‌تواند جواب بدهد به او نشان داده می‌شود', () => inPrimary(() => {
  database.insertTransactions({ transcript: 'کرایه', transactions: [askable()] });
  // موردی که به حسابدار می‌رود نباید در پرسش‌های کاربر بیاید.
  database.insertTransactions({ transcript: 'مبهم', transactions: [askable({
    amount: 88_000, confidence: 0.3, confidenceDetails: { amount: { score: 0.2, reason: 'مبلغ نامشخص.' } },
  })] });

  const shown = database.pendingConfirmations().items;
  const queue = database.reviewQueue().items;
  assert.ok(queue.length > shown.length, 'صف حسابدار باید بزرگ‌تر از پرسش‌های کاربر باشد');
  assert.ok(shown.length >= 1);
}));

// کاربری که دانش حسابداری ندارد با دیدن نمره و نام مسیر تصمیم بهتری نمی‌گیرد.
test('پرسش کاربر هیچ عدد اطمینان و اصطلاح حسابداری ندارد', () => inPrimary(() => {
  database.insertTransactions({ transcript: 'کرایه دوم', transactions: [askable({ amount: 310_000 })] });
  const question = database.pendingConfirmations().items[0];
  assert.ok(question, 'باید پرسشی وجود داشته باشد');
  for (const field of ['confidence', 'route', 'components', 'plan', 'percent', 'kind']) {
    assert.equal(question[field], undefined, `${field} نباید به کاربر ساده برسد`);
  }
  const text = `${question.question} ${question.hint}`;
  for (const word of ['بدهکار', 'بستانکار', 'سند', 'معین', 'تفصیلی']) {
    assert.ok(!text.includes(word), `«${word}» نباید در پرسش کاربر بیاید`);
  }
}));

test('«بله» همان لحظه سند را می‌زند', () => inPrimary(() => {
  const [id] = database.insertTransactions({ transcript: 'کرایه سوم', transactions: [askable({ amount: 120_000 })] });
  const db = database.activeWorkspaceDatabase();
  const question = database.pendingConfirmations().items.find((item) => item.amount === 120_000);
  assert.ok(question);

  database.confirmPending(question.id);
  const posted = db.prepare("SELECT COUNT(*) AS total FROM journal_entries WHERE source_type='transaction' AND source_id=?").get(id).total;
  assert.equal(posted, 1);
  assert.equal(database.pendingConfirmations().items.some((item) => item.id === question.id), false);
}));

// «نمی‌دانم» نباید مورد را پاک کند؛ باید برود سر میز کسی که می‌داند.
test('«مطمئن نیستم» مورد را به صف حسابدار می‌برد، نه سطل زباله', () => inPrimary(() => {
  const [id] = database.insertTransactions({ transcript: 'کرایه چهارم', transactions: [askable({ amount: 95_000 })] });
  const db = database.activeWorkspaceDatabase();
  const question = database.pendingConfirmations().items.find((item) => item.amount === 95_000);

  database.handOverPending(question.id);
  assert.equal(database.pendingConfirmations().items.some((item) => item.id === question.id), false,
    'دیگر نباید از کاربر پرسیده شود');

  const queued = database.reviewQueue().items.find((item) => item.id === question.id);
  assert.ok(queued, 'باید در صف حسابدار باشد');
  assert.equal(queued.route, 'accountant-review');
  assert.equal(queued.status, 'pending');
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM journal_entries WHERE source_type='transaction' AND source_id=?").get(id).total, 0,
    'سپردن به حسابدار نباید سند بزند');

  assert.ok(database.eventAudit(question.id).items.some((entry) => entry.stage === 'handed-over'),
    'این جابه‌جایی باید در تاریخچه بماند');
}));
