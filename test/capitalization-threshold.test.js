import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { resolveAutomationPolicy } from '../shared/automationPolicy.js';

/**
 * حد سرمایه‌ای دارایی کم‌ارزش — سیاست مصوب دفتر، بدون پیش‌فرض.
 *
 * بدون عدد، صف حسابدار همان سؤال «سیاست سرمایه‌ای شدن» را می‌پرسد. با عدد،
 * آن سؤال پاسخ دارد و دارایی ثابتِ زیر حد خلاف سیاست خود دفتر است.
 */
const databasePath = tempDatabase('capitalization');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'capital-owner';
process.env.ADMIN_PASSWORD = 'capital-strong-password-5519';
const previousKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'test-key';

const database = await import('../server/db.js');
const store = await import('../server/financialEventStore.js');
const assistant = await import('../server/reviewAssistant.js');
const ai = await import('../server/accountingReviewAi.js');
database.ensureAdmin();
const owner = database.authenticateUser('capital-owner', 'capital-strong-password-5519');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر سیاست', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const fake = (proposal) => async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] }) });
const assetProposal = (amount, name) => ({
  summary: 'خرید تجهیز', explanation: 'تجهیز دفتر', missingFacts: [],
  questions: [{ id: 'policy.cap', text: 'طبق سیاست سرمایه‌ای شدن شرکت، این خرید دارایی است؟' }],
  lines: [{ role: 'fixed-asset', key: name, debit: amount, credit: 0 }, { role: 'cash', debit: 0, credit: amount }],
});
const purchase = (text, amount) => store.recordFinancialEvent(db(), {
  kind: 'cash-expense', amount, accountId: 'cash', occurredAt: '2026-10-03', evidence: text, eventNature: 'new', category: 'تجهیزات',
}, { sourceEventId: crypto.randomUUID(), decision: { route: 'accountant-review', guardBlocked: true, reasons: ['بررسی حسابدار'] } });
const prepared = async (text, amount, name) => {
  const item = purchase(text, amount);
  const proposal = await ai.proposeReview(db(), item.id, { facts: { accountId: 'cash' }, fetcher: fake(assetProposal(amount, name)) });
  return assistant.prepareReviewProposal(db(), db().prepare('SELECT * FROM financial_events WHERE id=?').get(item.id), proposal);
};
const asksPolicy = (result) => result.questions.some((q) => /سیاست/.test(q.text));
const thresholdBlock = (result) => result.postingBlockers.some((b) => b.includes('حد سرمایه‌ای'));

test('حد سرمایه‌ای فقط عدد صحیح مثبت است؛ پیش‌فرض ندارد', () => {
  assert.equal(resolveAutomationPolicy({}).capitalizationThreshold, null);
  assert.equal(resolveAutomationPolicy({ capitalizationThreshold: '20000000' }).capitalizationThreshold, 20_000_000);
  for (const bad of [0, -5, 'abc', 1.5, '']) assert.equal(resolveAutomationPolicy({ capitalizationThreshold: bad }).capitalizationThreshold, null, String(bad));
});

test('بدون عدد مصوب: سؤال سیاست پرسیده می‌شود و چیزی فرض نمی‌شود', async () => inWorkspace(async () => {
  const result = await prepared('یک چاپگر ۸ میلیون برای دفتر خریدیم', 8_000_000, 'چاپگر');
  assert.equal(asksPolicy(result), true);
  assert.equal(thresholdBlock(result), false);
}));

test('با حد ۲۰ میلیون: چاپگر ۸ میلیونی دارایی ثابت نمی‌شود؛ لپ‌تاپ ۴۵ میلیونی سؤال سیاست نمی‌خواهد', async () => inWorkspace(async () => {
  const policy = database.saveAutomationPolicy({ ...database.automationPolicy(), capitalizationThreshold: 20_000_000 });
  assert.equal(policy.capitalizationThreshold, 20_000_000);
  assert.equal(database.automationPolicy().capitalizationThreshold, 20_000_000);
  const below = await prepared('یک چاپگر ۸ میلیون برای دفتر خریدیم', 8_000_000, 'چاپگر');
  assert.equal(thresholdBlock(below), true, below.postingBlockers.join(' | '));
  assert.equal(below.canPost, false);
  assert.equal(asksPolicy(below), false);
  const above = await prepared('یه لپ تاپ ۴۵ میلیون برای دفتر خریدیم', 45_000_000, 'لپ تاپ');
  assert.equal(thresholdBlock(above), false);
  assert.equal(asksPolicy(above), false);
}));

test.after(() => {
  if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  removeTempDatabase(databasePath);
});
