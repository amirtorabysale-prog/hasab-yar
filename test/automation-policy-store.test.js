import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { minimumRoleForRequest } from '../server/access.js';
import { pathNeedsProfessional } from '../shared/experience.js';

const databasePath = tempDatabase('policy');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'policy-owner';
process.env.ADMIN_PASSWORD = 'policy-safe-password-9004';

const database = await import(`../server/db.js?policy=${process.pid}`);
database.ensureAdmin();

function inPrimary(callback) {
  return database.runInWorkspace('primary', { role: 'owner', userId: 'test-owner' }, callback);
}

const confident = (overrides = {}) => ({
  amount: 640_000, type: 'expense', category: 'اجاره', rawText: 'ششصد و چهل اجاره دادم',
  occurredAt: '2026-08-01T08:00:00.000Z', ...overrides,
});

const journalCount = (db, id) => db
  .prepare("SELECT COUNT(*) AS total FROM journal_entries WHERE source_type='transaction' AND source_id=?")
  .get(id).total;

// -------------------------------------------------------------------- مرز

test('تنظیم قانون، ابزار حسابدار است و رتبهٔ مدیر می‌خواهد', () => {
  assert.equal(pathNeedsProfessional('/automation-policy'), true);
  assert.equal(minimumRoleForRequest('PUT', '/automation-policy'), 'manager');
});

// ------------------------------------------------------------ ماندگاری

test('پیش‌فرض همان سیاست پایلوت است', () => inPrimary(() => {
  const policy = database.automationPolicy();
  assert.equal(policy.autoThreshold, 0.95);
  assert.equal(policy.confirmThreshold, 0.80);
  assert.equal(policy.allowAiOnlyAutoPost, false);
}));

// سیاستِ خراب نباید دروازه را باز کند.
test('مقدار نامعتبر بی‌صدا به پیش‌فرض امن برمی‌گردد', () => inPrimary(() => {
  const saved = database.saveAutomationPolicy({ autoThreshold: 'خیلی زیاد', confirmThreshold: -3 });
  assert.equal(saved.autoThreshold, 0.95);
  assert.equal(saved.confirmThreshold, 0.80);
}));

// آستانهٔ تأیید بالاتر از آستانهٔ خودکار یعنی هیچ‌کس به مسیر تأیید نمی‌رسد.
test('دو آستانه هیچ‌وقت جابه‌جا نمی‌شوند', () => inPrimary(() => {
  const saved = database.saveAutomationPolicy({ autoThreshold: 0.5, confirmThreshold: 0.9 });
  assert.equal(saved.autoThreshold, 0.9);
  assert.equal(saved.confirmThreshold, 0.5);
}));

// ------------------------------------------------------------ اثر واقعی

/**
 * مهم‌ترین آزمون این فایل.
 *
 * تنظیمی که ذخیره می‌شود ولی مسیر ثبت را عوض نمی‌کند، فقط یک صفحهٔ تزئینی
 * است. دفتر باید بتواند بگوید «هیچ‌چیز بدون تأیید من» و همان لحظه اثرش را
 * ببیند.
 */
test('«هیچ‌چیز بدون تأیید من» واقعاً جلوی سند خودکار را می‌گیرد', () => inPrimary(() => {
  const db = database.activeWorkspaceDatabase();
  database.saveAutomationPolicy({ autoThreshold: 0.95, confirmThreshold: 0.8 });
  const [normal] = database.insertTransactions({ transcript: 'اجاره', transactions: [confident()] });
  assert.equal(journalCount(db, normal), 1, 'با سیاست پیش‌فرض باید خودکار ثبت شود');

  // کلید صریح، نه ترفند عددی: مقایسه `>=` است و آستانهٔ ۱ جلوی نمرهٔ ۱ را نمی‌گیرد.
  database.saveAutomationPolicy({ ...database.automationPolicy(), manualOnly: true });
  const [held] = database.insertTransactions({ transcript: 'اجاره دوم', transactions: [confident({ amount: 510_000 })] });
  assert.equal(journalCount(db, held), 0, 'حالا هیچ ثبتی نباید خودکار سند بخورد');
  assert.ok(database.reviewQueue().items.some((item) => item.sourceEventId === `transaction:${held}`));

  // و برگشت به حالت قبل، رفتار قبلی را برمی‌گرداند.
  database.saveAutomationPolicy({ autoThreshold: 0.95, confirmThreshold: 0.8 });
  const [again] = database.insertTransactions({ transcript: 'اجاره سوم', transactions: [confident({ amount: 220_000 })] });
  assert.equal(journalCount(db, again), 1);
}));

test('تغییر قانون در Audit Log می‌ماند', () => inPrimary(() => {
  database.saveAutomationPolicy({ autoThreshold: 0.99, confirmThreshold: 0.7 });
  const db = database.activeWorkspaceDatabase();
  const row = db.prepare("SELECT COUNT(*) AS total FROM audit_log WHERE entity_type='automation-policy'").get();
  assert.ok(row.total > 0, 'چه کسی و کی آستانه را عوض کرد، بخشی از زنجیرهٔ حسابرسی است');
}));
