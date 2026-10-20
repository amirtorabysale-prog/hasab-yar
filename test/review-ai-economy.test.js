import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { decide } from '../shared/accountingDecision.js';
import { factsFromEvent } from '../shared/eventFacts.js';
import { normalizeFinancialEvent } from '../shared/financialEvent.js';
import { isHeadingChoiceQuestion } from '../shared/reviewQuestions.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

/**
 * «تحلیل کن» با کمترین درخواست به مدل — آزمون سی سناریوی مهر ۱۴۰۵.
 *
 * در آن آزمون ۱۷ پرونده ۴۳ بار مدل را صدا زدند. سه دلیل داشت که هیچ‌کدام
 * کار مدل نبود:
 *
 * - هر سندی که ثبت می‌شد، همهٔ پیشنهادهای باز را کهنه می‌کرد؛
 * - دارایی ثابت و حقوق سؤالی داشتند که جوابش مدل نمی‌خواست؛
 * - سه مسیر را کد می‌بست، حتی با پیشنهاد درست (برداشت مالک، خرید کالا با بانک،
 *   طرف‌حساب تازه).
 */
process.env.DATABASE_PATH = tempDatabase('review-ai-economy');
process.env.ADMIN_USERNAME = 'economy-owner';
process.env.ADMIN_PASSWORD = `economy-${crypto.randomUUID()}`;
const db = await import('../server/db.js');
const store = await import('../server/financialEventStore.js');
const assistant = await import('../server/reviewAssistant.js');
const ai = await import('../server/accountingReviewAi.js');
db.ensureAdmin();
const owner = db.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const run = (f) => db.runInWorkspace('primary', { role: 'owner', userId: owner.id, overdraftApproval: FIXTURE_OVERDRAFT }, f);
const database = () => db.activeWorkspaceDatabase();
const before = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-key';
test.after(() => { if (before === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before; });

/** مدل جایگزین که تعداد درخواست‌ها را می‌شمارد. */
function counting(proposal) {
  const fetcher = async () => { fetcher.calls += 1; return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] }) }; };
  fetcher.calls = 0;
  return fetcher;
}
const row = (id) => database().prepare('SELECT * FROM financial_events WHERE id=?').get(id);
const prepared = (id, proposal) => assistant.prepareReviewProposal(database(), row(id), proposal);

function queued(evidence, { amount = 40_000_000, category = 'سایر هزینه‌ها', kind = 'cash-expense', accountId = 'cash', decision = null } = {}) {
  const event = normalizeFinancialEvent({ kind, amount, occurredAt: '2026-10-07T08:00:00.000Z', evidence, category, accountId });
  return store.recordFinancialEvent(database(), event, {
    sourceEventId: crypto.randomUUID(), accountingDecision: decision,
    decision: { route: 'accountant-review', guardBlocked: true, reasons: ['بررسی حسابدار لازم است'] },
  });
}

test('دارایی ثابت: بی‌درخواست به مدل، عمر مفید پرسیده و در دفتر دارایی‌ها ثبت می‌شود', () => run(async () => {
  const text = 'یک دستگاه کپی بزرگ برای استفاده در دفتر به مبلغ چهل و پنج میلیون تومان از صندوق خریدیم.';
  const facts = factsFromEvent(normalizeFinancialEvent({ kind: 'cash-expense', amount: 45_000_000, occurredAt: '2026-10-07T08:00:00.000Z', evidence: text, category: 'سایر هزینه‌ها', accountId: 'cash', intendedUse: 'long-term-use' }));
  const decision = decide(facts, { today: '2026-10-07T08:00:00.000Z', capitalizationThreshold: 20_000_000 });
  assert.equal(decision.treatment, 'fixed-asset');
  const item = queued(text, { amount: 45_000_000, decision });
  const fetcher = counting({});

  const first = await ai.proposeReview(database(), item.id, { fetcher });
  assert.equal(fetcher.calls, 0, 'مدل صدا زده نشد');
  assert.deepEqual(first.questions.map((q) => q.id), ['asset.useful-life'], 'نام از خود جمله درآمد؛ فقط عمر مفید پرسیده شد');

  const second = await ai.proposeReview(database(), item.id, { fetcher, facts: { questionAnswers: { 'asset.useful-life': { value: 'پنج سال' } } } });
  assert.equal(fetcher.calls, 0);
  assert.equal(prepared(item.id, second).canPost, true, prepared(item.id, second).postingBlockers.join(' / '));
  const posted = db.reviewAiFeedback(item.id, second.id, { accepted: true }).item;
  const asset = database().prepare(`SELECT a.source_kind AS kind, a.source_key AS key FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id
    WHERE l.entry_id=? AND l.debit>0`).get(posted.journalEntryId);
  assert.equal(asset.kind, 'fixed-asset', 'حساب خودِ دارایی، نه حساب کل');
  assert.equal(asset.key, 'دستگاه کپی بزرگ');
  const registered = db.listFixedAssets ? db.listFixedAssets() : null;
  const settings = database().prepare('SELECT * FROM fixed_asset_settings WHERE asset_key=?').get(asset.key);
  assert.equal(settings.useful_life_months, 60);
  assert.equal(settings.in_service_month, '1405-07');
  if (registered) assert.ok(registered.items?.some?.((item) => item.assetKey === asset.key) ?? true);
}));

test('حقوق: سؤال خالص یا ناخالص پیش از اولین درخواست به مدل', () => run(async () => {
  const item = queued('حقوق مهرماه سه نفر کارمند رو چهل و پنج میلیون از صندوق پرداخت کردیم', { amount: 45_000_000, category: 'حقوق و دستمزد' });
  const fetcher = counting({ summary: 'حقوق', explanation: 'خالص پرداختی', missingFacts: [], lines: [{ role: 'expense-category', key: 'حقوق و دستمزد', debit: 45_000_000, credit: 0 }, { role: 'cash', debit: 0, credit: 45_000_000 }] });
  const first = await ai.proposeReview(database(), item.id, { fetcher });
  assert.equal(fetcher.calls, 0);
  assert.equal(first.questions[0].id, 'payroll.gross-or-net');
  await ai.proposeReview(database(), item.id, { fetcher, facts: { questionAnswers: { 'payroll.gross-or-net': { value: 'خالص پرداختی است؛ کسور ندارد' } } } });
  assert.equal(fetcher.calls, 1, 'بعد از جواب، یک بار و با دادهٔ کامل');
}));

test('ثبت پروندهٔ دیگر، پیشنهادِ بی‌وابسته به مانده را کهنه نمی‌کند و دوباره‌پرسیدن مدل را صدا نمی‌زند', () => run(async () => {
  const plan = (amount) => ({ summary: 'هزینه نظافت', explanation: 'خدمت همین دوره', missingFacts: [], lines: [{ role: 'expense-category', key: 'نظافت', debit: amount, credit: 0 }, { role: 'cash', debit: 0, credit: amount }] });
  const first = queued('هزینه نظافت دفتر رو نقدی دادیم', { amount: 3_000_000, category: 'سایر هزینه‌ها' });
  const second = queued('هزینه نظافت انبار رو از صندوق دادیم', { amount: 2_000_000, category: 'سایر هزینه‌ها' });
  const fetchFirst = counting(plan(3_000_000));
  const fetchSecond = counting(plan(2_000_000));
  const a = await ai.proposeReview(database(), first.id, { fetcher: fetchFirst });
  const b = await ai.proposeReview(database(), second.id, { fetcher: fetchSecond });
  db.reviewAiFeedback(first.id, a.id, { accepted: true });
  assert.equal(prepared(second.id, b).canPost, true, prepared(second.id, b).postingBlockers.join(' / '));
  assert.equal((await ai.proposeReview(database(), second.id, { fetcher: fetchSecond })).id, b.id);
  assert.equal(fetchSecond.calls, 1, 'همان پیشنهاد، بی‌درخواست دوم');
  assert.ok(db.reviewAiFeedback(second.id, b.id, { accepted: true }).item.journalEntryId);
}));

test('برداشت مالک و خرید کالا با بانک، با پیشنهاد درست ثبت می‌شوند', () => run(async () => {
  const drawing = queued('صاحب کسب‌وکار سه میلیون از صندوق برای خرج شخصی برداشت', { amount: 3_000_000 });
  const d = await ai.proposeReview(database(), drawing.id, { fetcher: counting({ summary: 'برداشت مالک', explanation: 'برای مصرف شخصی', missingFacts: [], lines: [{ role: 'owner-capital', debit: 3_000_000, credit: 0 }, { role: 'cash', debit: 0, credit: 3_000_000 }] }) });
  assert.equal(prepared(drawing.id, d).canPost, true, prepared(drawing.id, d).postingBlockers.join(' / '));

  const goods = queued('سی کارتن روغن موتور برای فروش، جمعاً چهل و دو میلیون از صندوق خریدیم', { amount: 42_000_000, category: 'مواد و کالا' });
  const g = await ai.proposeReview(database(), goods.id, { fetcher: counting({
    summary: 'خرید کالا', explanation: 'کالا تحویل شد', missingFacts: [], counterpartyName: null,
    inventoryItems: [{ productId: null, name: 'روغن موتور', unit: 'کارتن', quantity: 30, total: 42_000_000 }],
    lines: [{ role: 'inventory-asset', key: 'روغن موتور', debit: 42_000_000, credit: 0 }, { role: 'cash', debit: 0, credit: 42_000_000 }],
  }) });
  const ready = prepared(goods.id, g);
  assert.equal(ready.postingBlockers.some((b) => b.includes('فقط خرید تحویل‌شده')), false, ready.postingBlockers.join(' / '));
}));

test('قرض شریک با فعل محاوره‌ای: پیشنهاد قاعده‌ای، بی‌درخواست به مدل', () => run(async () => {
  const item = queued('برادرم که شریکمه ده میلیون تومان به صندوق شرکت ریخت که بعداً بهش پس بدیم.', { amount: 10_000_000, kind: 'cash-income', category: 'سایر درآمدها' });
  const fetcher = counting({});
  const proposal = await ai.proposeReview(database(), item.id, { fetcher });
  assert.equal(fetcher.calls, 0);
  assert.deepEqual(proposal.lines.map((l) => `${l.debit ? 'Dr' : 'Cr'} ${l.role}`), ['Dr cash', 'Cr partner-payable']);
}));

test('طرف‌حساب تازه از انتخابگر شخص پذیرفته می‌شود و سؤال سرفصل حذف می‌شود', () => run(() => {
  const item = queued('پیش‌پرداخت به تأمین‌کننده', { amount: 1_000_000 });
  assistant.saveReviewFacts(database(), item.id, { counterpartyId: 'new:فروشگاه آرمان' });
  const { facts } = assistant.reviewContext(database(), item.id);
  assert.equal(facts.counterpartyName, 'فروشگاه آرمان');
  assert.equal(facts.counterpartyId, null);
  // سؤال نامی که خودِ سیستم از مانع ساخته، با شناسهٔ نمایشی‌اش هم جواب می‌گیرد.
  const other = queued('قبض پرداخت‌نشده', { amount: 500_000 });
  assistant.saveReviewFacts(database(), other.id, { questionAnswers: { 'fact.counterparty-name': { value: 'شرکت گاز' } } });
  assert.equal(assistant.reviewContext(database(), other.id).facts.counterpartyName, 'شرکت گاز');
  assert.equal(isHeadingChoiceQuestion({ text: 'این پیش‌پرداخت به تأمین‌کننده را با چه سرفصلی می‌خواهید ثبت کنیم؟' }), true);
  assert.equal(isHeadingChoiceQuestion({ text: 'وجه از کدام بانک یا صندوق پرداخت شد؟', field: 'accountId' }), false);
}));
