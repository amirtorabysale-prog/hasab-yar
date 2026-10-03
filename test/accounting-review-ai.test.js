import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureReviewAiSchema, proposeReview, recordReviewFeedback, proposalMatchesPlan } from '../server/accountingReviewAi.js';

function fixture() {
  const database = new DatabaseSync(':memory:');
  ensureReviewAiSchema(database);
  database.prepare(`INSERT INTO financial_events
    (id,source_event_id,kind,amount,occurred_at,payload,confidence,route,status)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('one', 'voice:test', 'cash-expense', 3_000_000, '2026-09-23', JSON.stringify({ evidence: 'موجودی انبار بدون پرداخت کم شد', kind: 'cash-expense' }), '{}', 'accountant-review', 'pending');
  return database;
}

test('پیشنهاد AI در صف می‌ماند و رد با دلیل در DNA همان دفتر ذخیره می‌شود', async () => {
  const database = fixture();
  const before = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const fake = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      summary: 'نیازمند بررسی کسری انبار', explanation: 'پول جابه‌جا نشده است', missingFacts: [],
      lines: [{ role: 'expense-category', key: 'کسری انبار', debit: 3_000_000, credit: 0 }, { role: 'payable', key: null, debit: 0, credit: 3_000_000 }],
    }) }] } }] }) });
    const proposal = await proposeReview(database, 'one', { fetcher: fake });
    assert.equal(database.prepare('SELECT status FROM financial_events WHERE id=?').get('one').status, 'pending');
    assert.equal((await proposeReview(database, 'one', { fetcher: fake })).id, proposal.id, 'درخواست دوباره پیشنهاد تکراری نمی‌سازد');
    assert.throws(() => recordReviewFeedback(database, 'one', proposal.id, { state: 'rejected', reason: 'نه' }), { code: 'AI_REASON_REQUIRED' });
    const rejected = recordReviewFeedback(database, 'one', proposal.id, { state: 'rejected', reason: 'این کسری باید پس از شمارش فیزیکی بررسی شود', actor: 'accountant' });
    assert.equal(rejected.state, 'rejected');
    assert.match(rejected.reason, /شمارش فیزیکی/);
    assert.equal(database.prepare('SELECT status FROM financial_events WHERE id=?').get('one').status, 'pending');
  } finally { if (before === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = before; database.close(); }
});

test('پیشنهاد متفاوت یا با واقعیت گمشده اجازهٔ تأیید نقشهٔ قبلی را نمی‌دهد', () => {
  const plan = { lines: [{ role: 'prepaid-asset', debit: 12, credit: 0 }, { role: 'cash', debit: 0, credit: 12 }] };
  assert.equal(proposalMatchesPlan({ lines: plan.lines, missingFacts: [] }, plan), true);
  assert.equal(proposalMatchesPlan({ lines: plan.lines, missingFacts: ['دوره'] }, plan), false);
  assert.equal(proposalMatchesPlan({ lines: [{ role: 'expense-category', debit: 12, credit: 0 }, plan.lines[1]], missingFacts: [] }, plan), false);
});

test('OpenAI review is explicitly requested, cached and never posts', async () => {
  const database = fixture();
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai';
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer test-openai');
    assert.equal(JSON.parse(options.body).store, false);
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
      summary: 'بررسی', explanation: 'پیشنهاد حسابدار', missingFacts: [],
      lines: [{ role: 'expense-category', debit: 3000000, credit: 0 }, { role: 'cash', debit: 0, credit: 3000000 }],
    }) }] }] }) };
  };
  try {
    assert.equal(calls, 0);
    await proposeReview(database, 'one', { fetcher });
    await proposeReview(database, 'one', { fetcher });
    assert.equal(calls, 1);
    assert.equal(database.prepare("SELECT status FROM financial_events WHERE id='one'").get().status, 'pending');
  } finally { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; database.close(); }
});

test('OpenAI provider failures are actionable and leave the queue untouched', async () => {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai';
  try {
    for (const [status, code] of [[401, 'AI_AUTH'], [403, 'AI_AUTH'], [429, 'AI_QUOTA'], [404, 'AI_MODEL']]) {
      const database = fixture();
      await assert.rejects(proposeReview(database, 'one', { fetcher: async () => ({ ok: false, status }) }), { code });
      assert.equal(database.prepare('SELECT COUNT(*) n FROM accounting_review_ai').get().n, 0);
      database.close();
    }
  } finally { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; }
});
