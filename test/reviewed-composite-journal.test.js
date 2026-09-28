import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { proposeReview } from '../server/accountingReviewAi.js';
import { listLedgerAccounts } from '../server/accounting.js';
import { resolveEventRole } from '../server/roleResolver.js';
import { analyticForContact } from '../server/chartOfAccounts.js';

process.env.DATABASE_PATH = tempDatabase('reviewed-composite');
process.env.ADMIN_USERNAME = 'composite-owner';
process.env.ADMIN_PASSWORD = `composite-${crypto.randomUUID()}`;
const app = await import(`../server/db.js?composite=${process.pid}`);
app.ensureAdmin();
const owner = app.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const within = (fn) => app.runInWorkspace('primary', { role: 'owner', userId: owner.id }, fn);
const text = 'امروز 22 میلیون تومان فروش داشتیم شامل 20 میلیون تومان کالا و 2 میلیون تومان مالیات ارزش افزوده';
const utterance = () => app.queueCompositeUtterance(text, { clientId: crypto.randomUUID() });
const accounts = () => listLedgerAccounts(app.activeWorkspaceDatabase());
const lines = () => {
  resolveEventRole(app.activeWorkspaceDatabase(), 'cash', 'cash');
  resolveEventRole(app.activeWorkspaceDatabase(), 'income-category', 'فروش کالا');
  const cash = accounts().find((account) => account.type === 'asset');
  const income = accounts().find((account) => account.type === 'income');
  assert.ok(cash && income);
  return [{ accountId: cash.id, debit: 22_000_000, credit: 0 }, { accountId: income.id, debit: 0, credit: 22_000_000 }];
};

test('حسابدار برای یک گفتهٔ چندمبلغی سطرهای متوازن را یک بار ثبت می‌کند', () => within(() => {
  const event = utterance();
  const before = app.activeWorkspaceDatabase().prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
  const result = app.recordReviewedComposite(event.id, { lines: lines(), reason: 'بررسی مدارک و تخصیص حساب توسط حسابدار' });
  assert.equal(result.item.status, 'posted');
  assert.equal(app.activeWorkspaceDatabase().prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, before + 1);
  const journal = app.activeWorkspaceDatabase().prepare('SELECT source_type AS sourceType,source_id AS sourceId FROM journal_entries WHERE id=?').get(result.item.journalEntryId);
  assert.equal(journal.sourceType, 'financial-event');
  assert.equal(journal.sourceId, event.id);
  assert.equal(app.activeWorkspaceDatabase().prepare("SELECT COUNT(*) AS n FROM financial_event_audit WHERE event_id=? AND stage='accountant-reviewed'").get(event.id).n, 1);
  assert.throws(() => app.recordReviewedComposite(event.id, { lines: lines(), reason: 'دوباره ثبت نکن' }), { code: 'EVENT_NOT_PENDING' });
}));

test('سطر نامتوازن، حساب نامعتبر و دلیل ناقص پرونده را باز نگه می‌دارند', () => within(() => {
  const event = utterance();
  const good = lines();
  const attempt = (rows, reason = 'بررسی دقیق فاکتور فروش') => app.recordReviewedComposite(event.id, { lines: rows, reason });
  assert.throws(() => attempt([{ ...good[0], debit: 21_000_000 }, good[1]]), { code: 'JOURNAL_UNBALANCED' });
  assert.throws(() => attempt([{ ...good[0], accountId: 'unknown' }, good[1]]));
  assert.throws(() => attempt(good, 'کوتاه'), { code: 'REVIEW_REASON_REQUIRED' });
  assert.throws(() => attempt([{ ...good[0], debit: 22_000_000.4 }, good[1]]), { code: 'REVIEW_LINES_INVALID' });
  assert.equal(app.activeWorkspaceDatabase().prepare('SELECT status FROM financial_events WHERE id=?').get(event.id).status, 'pending');
  assert.equal(app.activeWorkspaceDatabase().prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type='financial-event' AND source_id=?").get(event.id).n, 0);
}));

test('سطر طرف حساب بدون تفصیلی پذیرفته نمی‌شود', () => within(() => {
  const event = utterance();
  const payableId = resolveEventRole(app.activeWorkspaceDatabase(), 'payable', 'شرکت آزمایشی', { counterparty: 'شرکت آزمایشی' });
  const source = lines()[0];
  const reviewed = [{ ...source }, { accountId: payableId, debit: 0, credit: 22_000_000 }];
  assert.throws(() => app.recordReviewedComposite(event.id, { lines: reviewed, reason: 'بررسی قرارداد طرف حساب' }), { code: 'REVIEW_ANALYTIC_REQUIRED' });
  const analyticId = analyticForContact(app.activeWorkspaceDatabase(), null, 'شرکت آزمایشی')?.id;
  assert.ok(analyticId);
  assert.equal(app.recordReviewedComposite(event.id, { lines: [{ ...source }, { ...reviewed[1], analyticId }], reason: 'بررسی قرارداد طرف حساب' }).item.status, 'posted');
}));

test('پذیرش AI فقط با همان مبالغ و بدون واقعیت گمشده ثبت می‌شود؛ اصلاح دلیل می‌خواهد', async () => {
  const before = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    await within(async () => {
      const event = utterance();
      const fake = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        summary: 'فروش شامل مالیات', explanation: 'بررسی فاکتور', missingFacts: [],
        lines: [{ role: 'cash', debit: 22_000_000, credit: 0 }, { role: 'income-category', debit: 0, credit: 22_000_000 }],
      }) }] } }] }) });
      const proposal = await proposeReview(app.activeWorkspaceDatabase(), event.id, { fetcher: fake });
      assert.throws(() => app.recordReviewedComposite(event.id, { lines: [{ ...lines()[0], debit: 21_000_000 }, lines()[1]], reason: 'اصلاح ثبت با شواهد', proposalId: proposal.id, aiAccepted: true }), { code: 'AI_PLAN_REVISION_REQUIRED' });
      const result = app.recordReviewedComposite(event.id, { lines: lines(), reason: 'بررسی فاکتور و تأیید حساب‌های سند', proposalId: proposal.id, aiAccepted: true });
      assert.equal(result.item.status, 'posted');
      assert.equal(app.activeWorkspaceDatabase().prepare('SELECT state FROM accounting_review_ai WHERE id=?').get(proposal.id).state, 'accepted');
    });
  } finally { if (before === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = before; }
});
