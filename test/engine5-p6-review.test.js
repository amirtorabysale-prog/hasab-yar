import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { tempDatabase } from './helpers/tempPath.js';
import { serverSource } from './helpers/serverSource.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
import { parseFinancialText } from '../shared/parser.js';
import { FACT_QUESTIONS } from '../shared/factRequirements.js';
import { recognitionPreview } from '../shared/recognitionPreview.js';

/**
 * موتور ۵ — بستهٔ p6: صف حسابدار، دستیار بررسی و رفت‌وبرگشت رابط برای
 * پیش‌پرداخت دوره‌دار (بیمه، اجاره، اشتراک) و آینه‌اش (درآمد انتقالی).
 *
 * هر بخش یک خانواده است: جملهٔ واقعی کاربر عیناً، شکل‌های هم‌ارز، و نمونهٔ
 * منفی که نباید وارد همان مسیر شود.
 */

process.env.DATABASE_PATH = tempDatabase('engine5-p6-review');
process.env.ADMIN_USERNAME = 'p6-review-owner';
process.env.ADMIN_PASSWORD = 'p6-review-strong-password-5521';
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser('p6-review-owner', 'p6-review-strong-password-5521');

let workspaceCount = 0;
/** هر آزمون دفتر تازهٔ خودش را دارد تا مانده‌ها و صف‌ها در هم نروند. */
function freshWorkspace({ understanding = false } = {}) {
  workspaceCount += 1;
  const workspace = database.createWorkspace(owner.id, { name: `دفتر p6 ${workspaceCount}`, profileType: 'business' });
  const run = (callback) => database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
  run(() => {
    database.installChartTemplate();
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, ...(understanding ? { understandingMode: 'active', understandingScope: 'all' } : {}) });
  });
  return run;
}

const NOW = '2026-10-10T08:00:00.000Z';
const none = { op: null, of: [] };
const modelFetcher = (modelSaid) => async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(modelSaid) }] }], usage: { input_tokens: 1, output_tokens: 1 } }) });
const aiOptions = (modelSaid) => ({ fetcher: modelFetcher(modelSaid), env: { OPENAI_API_KEY: 'test-key-not-real', OPENAI_UNDERSTANDING_MODEL: 'test-model' }, now: new Date(NOW) });

/** خروجی مدل برای یک پرداخت خدمت دوره‌دار؛ دوره را مدل نمی‌دهد، سرور از جمله می‌خواند. */
function servicePaid(said, { what = 'بیمه انبار', counterparty = null, bank = null } = {}) {
  const amountEvidence = said.match(/[۰-۹0-9]+ میلیون/)[0];
  return {
    event: { kind: 'expense', description: `پرداخت ${what}`, status: 'done' },
    amounts: [{ id: 'a1', value: null, currency: null, role: 'paid-now', status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence: amountEvidence }],
    nonAmountNumbers: [], dates: [],
    counterparties: counterparty ? [{ id: 'c1', name: counterparty, role: 'supplier', evidence: counterparty }] : [],
    movements: [{ id: 'm1', amountRef: 'a1', direction: 'out', from: bank ? { kind: 'bank', name: bank } : { kind: 'unknown', name: null }, to: counterparty ? { kind: 'counterparty', name: counterparty } : { kind: 'unknown', name: null }, evidence: amountEvidence }],
    subject: { what, kind: 'service', use: 'internal', delivered: 'unknown', usefulLifeMonths: null, evidence: what },
    conditions: [], ambiguities: [],
  };
}

async function withVite(callback) {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try { return await callback(vite); } finally { await vite.close(); }
}

// ---------------------------------------------------------------------------
// ai-sheet-no-accountant-option — «نمی‌دانم» روی برگهٔ فهم گفته
// ---------------------------------------------------------------------------

const SEND_LABEL = 'نمی‌دانم — به حسابدار بسپار';

test('برگهٔ فهم گفته: سؤال دورهٔ پوشش «نمی‌دانم → حسابدار» دارد؛ ارسال، هیچ ردیف نقدی و سندی نمی‌سازد', async () => {
  const run = freshWorkspace({ understanding: true });
  const drafts = await run(async () => {
    const cash = database.saveAccount({ name: 'صندوق', kind: 'cash', openingBalance: 100_000_000 });
    const out = [];
    for (const [said, what] of [
      ['بیمه انبار ۱۲ میلیون دادیم', 'بیمه انبار'],
      ['اجاره مغازه ۳۰ میلیون دادیم', 'اجاره مغازه'],
      ['اشتراک نرم‌افزار 24 میلیون پرداخت کردیم', 'اشتراک نرم‌افزار'],
    ]) {
      let item = await database.createUnderstandingCase({ text: said, clientId: `idk-${out.length}` }, aiOptions(servicePaid(said, { what })));
      // اول حساب پرسیده می‌شود؛ بعد از جواب، فقط سؤال دوره می‌ماند.
      const account = item.plan.questions.find((question) => question.picker === 'account');
      if (account) item = await database.answerUnderstandingCase(item.id, { [account.id]: { valueId: cash.id } }, aiOptions(servicePaid(said, { what })));
      out.push({ said, item });
    }
    return out;
  });
  await withVite(async (vite) => {
    const { UnderstandingSheet } = await vite.ssrLoadModule('/src/features/understanding/UnderstandingSheet.jsx');
    const render = (draft) => renderToStaticMarkup(React.createElement(UnderstandingSheet, { draft, setDraft() {}, close() {}, notify() {} }));
    for (const { said, item } of drafts) {
      assert.equal(item.status, 'needs-answers', said);
      assert.ok(item.plan.questions.some((question) => /servicePeriodStart$/.test(question.id)), `${said}: سؤال دوره`);
      assert.match(render(item), new RegExp(SEND_LABEL), said);
    }
    // سؤالی که فقط حساب را می‌پرسد هم همین راه را دارد.
    const accountOnly = { ...drafts[0].item, plan: { ...drafts[0].item.plan, questions: [{ id: 'account.a1', kind: 'information', text: 'پول از کدام حساب رفت؟', picker: 'account' }] } };
    assert.match(render(accountOnly), new RegExp(SEND_LABEL));
    // منفی: آماده، ثبت‌شده، فرستاده‌شده و کنارگذاشته این دکمه را ندارند.
    for (const status of ['ready', 'posted', 'sent-to-accountant', 'dismissed', 'needs-accountant']) {
      assert.doesNotMatch(render({ ...drafts[0].item, status, plan: { ...drafts[0].item.plan, questions: [] } }), new RegExp(SEND_LABEL), status);
    }
  });
  run(() => {
    const sql = database.activeWorkspaceDatabase();
    const journalsBefore = sql.prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
    const sent = database.sendUnderstandingToAccountant(drafts[0].item.id);
    assert.equal(sent.status, 'sent-to-accountant');
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM transactions WHERE status!='deleted'").get().n, 0, 'هیچ ردیف نقدی');
    assert.equal(sql.prepare('SELECT COUNT(*) n FROM journal_entries').get().n, journalsBefore, 'هیچ سند تازه‌ای');
    const queued = sql.prepare("SELECT kind,route,status,amount FROM financial_events WHERE kind='review-placeholder'").all();
    assert.deepEqual(queued.map((row) => [row.route, row.status, row.amount]), [['accountant-review', 'pending', 12_000_000]]);
  });
});

// ---------------------------------------------------------------------------
// review-question-card-stale-state — کارت سؤال صف حسابدار
// ---------------------------------------------------------------------------

test('کارت سؤال: متن «۱ مهر ۱۴۰۵» که برای شروع دوره تایپ شد، برای پایان دوره فرستاده نمی‌شود', async () => {
  const { draftForQuestion, questionCardKey } = await withVite((vite) => vite.ssrLoadModule('/src/components/DecisionQuestionCard.jsx'));
  const start = { fact: 'servicePeriodStart', ...FACT_QUESTIONS.servicePeriodStart };
  const end = { fact: 'servicePeriodEnd', ...FACT_QUESTIONS.servicePeriodEnd };
  // هر دو سؤال گزینهٔ آزاد `custom` دارند — همان چیزی که پاسخ کهنه را معتبر جلوه می‌داد.
  assert.ok(start.options.some((option) => option.value === 'custom' && option.freeInput));
  assert.ok(end.options.some((option) => option.value === 'custom' && option.freeInput));
  const typed = { fact: 'servicePeriodStart', option: 'custom', text: '۱ مهر ۱۴۰۵' };
  assert.deepEqual(draftForQuestion(typed, end), { fact: 'servicePeriodEnd', option: null, text: '' });
  assert.equal(draftForQuestion(typed, start), typed, 'همان سؤال، همان متن');
  assert.notEqual(questionCardKey('decision-1', start), questionCardKey('decision-2', end));
  assert.notEqual(questionCardKey('decision-1', start), questionCardKey('decision-2', start), 'تصمیم تازه، کارت تازه');
  // صف حسابدار کارت را با همین کلید می‌سازد.
  const page = readFileSync(new URL('../src/features/review/ReviewQueuePage.jsx', import.meta.url), 'utf8');
  assert.match(page, /<DecisionQuestionCard key=\{questionCardKey\(/);
  assert.doesNotMatch(page, /function QuestionCard\(/, 'یک کارت سؤال، نه دو');
  await withVite(async (vite) => {
    const { DecisionQuestionCard } = await vite.ssrLoadModule('/src/components/DecisionQuestionCard.jsx');
    const html = renderToStaticMarkup(React.createElement(DecisionQuestionCard, { question: end, busy: false, onAnswer() {} }));
    assert.match(html, /تا کِی ادامه دارد؟/);
    for (const label of ['یک سال', 'شش ماه', 'سه ماه', 'تاریخش را می‌گویم']) assert.match(html, new RegExp(label));
    assert.doesNotMatch(html, /<input/, 'کارت تازه ورودی پرشده ندارد');
  });
});

// ---------------------------------------------------------------------------
// sheet-hides-coverage-period — دوره و برنامهٔ ماهانه پیش از ثبت
// ---------------------------------------------------------------------------

const deterministicPreview = (run, text, patch = {}) => run(() => {
  const now = new Date(NOW);
  const transactions = parseFinancialText(text, { source: 'voice', now }).transactions
    .map((item) => ({ ...item, ...patch, occurredAt: item.occurredAt || NOW }));
  return database.previewTransactions({ transcript: text, transactions });
});

test('پیش‌نمایش سرور دوره و اقساط ماهانه را همان‌طور می‌دهد که ثبت می‌سازد؛ هزینهٔ یک‌جا و پیش‌پرداخت کالا برنامه ندارند', () => {
  const run = freshWorkspace();
  run(() => database.saveAccount({ name: 'صندوق', kind: 'cash', openingBalance: 100_000_000 }));
  for (const [text, count, amount, patch] of [
    ['اجاره ۶ ماه دفتر رو جلوتر دادیم ۳۰ میلیون', 6, 30_000_000],
    ['بیمه یک ساله انبار رو ۱۲ میلیون دادیم', 12, 12_000_000],
    ['اشتراک یک ساله نرم افزار 24 میلیون پرداخت کردیم', 12, 24_000_000],
    ['بيمه يك ساله بدنه ماشين ۹ ميليون داديم', 12, 9_000_000],
    // آینه: درآمد اجارهٔ یک‌ساله که جلو گرفته شد — درآمد انتقالی، همان برنامه.
    ['پیش دریافت اجاره یک ساله ۶۰ میلیون از مستاجر گرفتیم', 12, 60_000_000, { type: 'income', category: 'درآمد اجاره' }],
  ]) {
    const [preview] = deterministicPreview(run, text, patch);
    assert.equal(preview.decisionStatus, 'decided', text);
    assert.ok(preview.recognition, `${text}: پیش‌نمایش برنامه`);
    assert.equal(preview.recognition.method, 'monthly-straight-line', text);
    assert.equal(preview.recognition.count, count, text);
    assert.equal(preview.recognition.schedule.reduce((sum, item) => sum + item.amount, 0), amount, `${text}: جمع اقساط = مبلغ`);
    assert.ok(preview.recognition.periodStart && preview.recognition.periodEnd, text);
    if (patch?.type === 'income') assert.equal(preview.treatment, 'deferred-revenue', text);
  }
  // منفی: دورهٔ گذشته یا همین ماه یک‌جا هزینه می‌شود و برنامه‌ای ندارد؛ دوره‌اش اما دیده می‌شود.
  for (const text of ['بیمه انبار از اول فروردین تا آخر شهریور ۱۴۰۵ رو ۶ میلیون دادیم', 'اشتراک ماه مهر نرم افزار ۲ میلیون دادیم']) {
    const [preview] = deterministicPreview(run, text);
    assert.equal(preview.treatment, 'period-expense', text);
    assert.equal(preview.recognition, null, text);
    assert.ok(preview.servicePeriod?.start && preview.servicePeriod?.end, text);
  }
  // منفی: پیش‌پرداخت خرید کالا، پیش‌پرداخت خدمت نیست.
  const [goods] = deterministicPreview(run, 'پیش پرداخت خرید کالا ۲۰ میلیون به شرکت پارس دادیم');
  assert.equal(goods.treatment, 'supplier-advance');
  assert.equal(goods.recognition, null);
  // دوره هنوز پرسیده می‌شود: نه برنامه‌ای، نه دوره‌ای.
  const [asking] = deterministicPreview(run, 'بیمه انبار ۱۲ میلیون دادیم');
  assert.equal(asking.question?.fact, 'servicePeriodStart');
  assert.equal(asking.recognition, null);
});

test('برگهٔ فهم گفته: «یک ساله» → پوشش ۱۸ مهر ۱۴۰۵ تا ۱۷ مهر ۱۴۰۶ با ۱۲ قسط، همان که ثبت می‌نویسد', async () => {
  const run = freshWorkspace({ understanding: true });
  const SAID = 'بیمه آتش سوزی انبار یک ساله ۱۲ میلیون به بیمه دی از تجارت دادیم';
  const item = await run(async () => {
    database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 500_000_000 });
    return database.createUnderstandingCase({ text: SAID, clientId: 'cover-1' }, aiOptions(servicePaid(SAID, { what: 'بیمه آتش‌سوزی انبار', counterparty: 'بیمه دی', bank: 'تجارت' })));
  });
  assert.equal(item.status, 'ready', JSON.stringify(item.plan?.questions));
  const [component] = item.plan.components;
  const { recognition } = component.preview;
  assert.equal(recognition.count, 12);
  assert.equal(recognition.periodStart.slice(0, 10), '2026-10-10');
  assert.equal(recognition.periodEnd.slice(0, 10), '2027-10-09');
  assert.deepEqual([recognition.schedule[0].periodKey, recognition.schedule.at(-1).periodKey], ['1405-07', '1406-06']);
  await withVite(async (vite) => {
    const { UnderstandingSheet } = await vite.ssrLoadModule('/src/features/understanding/UnderstandingSheet.jsx');
    const html = renderToStaticMarkup(React.createElement(UnderstandingSheet, { draft: item, setDraft() {}, close() {}, notify() {} }));
    assert.match(html, /پوشش <b>۱۸ مهر ۱۴۰۵<\/b> تا <b>۱۷ مهر ۱۴۰۶<\/b>/);
    assert.match(html, /۱۲<\/span> قسط ماهانهٔ <span class="numbers">۱٬۰۰۰٬۰۰۰<\/span>/);
    assert.match(html, /از مهر ۱۴۰۵ تا شهریور ۱۴۰۶/);
  });
  // همان چیزی که برگه نشان داد، همان است که ثبت نوشت.
  run(() => {
    const posted = database.commitUnderstandingCase(item.id, { now: new Date(NOW) });
    assert.equal(posted.status, 'posted');
    const rows = database.activeWorkspaceDatabase().prepare("SELECT period_key AS periodKey, amount FROM recognition_schedule_items WHERE status='planned' ORDER BY period_key").all();
    assert.deepEqual(rows.map((row) => ({ ...row })), recognition.schedule);
  });
});

test('برگهٔ فهم گفته: دوره‌ای که از جواب سؤال‌ها ساخته شد، پیش از ثبت به کاربر برگردانده می‌شود', async () => {
  const run = freshWorkspace({ understanding: true });
  const SAID = 'بیمه انبار ۱۲ میلیون از تجارت دادیم';
  const model = servicePaid(SAID, { bank: 'تجارت' });
  const item = await run(async () => {
    database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 500_000_000 });
    let current = await database.createUnderstandingCase({ text: SAID, clientId: 'answers-1' }, aiOptions(model));
    for (const value of ['next-month', 'one-year']) {
      const question = current.plan.questions.find((entry) => entry.id.startsWith('engine.'));
      assert.ok(question, JSON.stringify(current.plan.questions));
      current = await database.answerUnderstandingCase(current.id, { [question.id]: { value } }, aiOptions(model));
    }
    return current;
  });
  assert.equal(item.status, 'ready', JSON.stringify(item.plan.questions));
  const { recognition } = item.plan.components[0].preview;
  assert.equal(recognition.count, 12);
  assert.equal(recognition.schedule.reduce((sum, entry) => sum + entry.amount, 0), 12_000_000);
  assert.equal(recognition.schedule[0].periodKey, '1405-08', 'از اول ماه بعد = آبان');
});

test('یادداشت دوره: هزینهٔ یک‌جا دوره‌اش را می‌گوید؛ بی‌دوره و پیش از تصمیم چیزی نمی‌گوید', async () => {
  await withVite(async (vite) => {
    const { RecognitionNote, periodKeyLabel } = await vite.ssrLoadModule('/src/components/RecognitionNote.jsx');
    const render = (props) => renderToStaticMarkup(React.createElement(RecognitionNote, props));
    assert.equal(periodKeyLabel('1405-07'), 'مهر ۱۴۰۵');
    assert.match(render({ servicePeriod: { start: '2026-03-21T00:00:00.000Z', end: '2026-09-22T00:00:00.000Z' }, decided: true }), /یک‌جا در همین دوره شناسایی می‌شود/);
    assert.equal(render({ servicePeriod: { start: '2026-03-21T00:00:00.000Z', end: '2026-09-22T00:00:00.000Z' }, decided: false }), '');
    assert.equal(render({ recognition: null, servicePeriod: null, decided: true }), '');
    const deferred = recognitionPreview({ amount: 60_000_000, servicePeriodStart: '2026-10-10', servicePeriodEnd: '2027-10-09' }, { recognitionMethod: 'monthly-straight-line' });
    assert.match(render({ recognition: deferred }), /۱۲<\/span> قسط ماهانهٔ <span class="numbers">۵٬۰۰۰٬۰۰۰/);
    assert.equal(recognitionPreview({ amount: 60_000_000, servicePeriodStart: '2026-10-10', servicePeriodEnd: '2027-10-09' }, { recognitionMethod: 'immediate' }), null);
  });
});

// ---------------------------------------------------------------------------
// today-card-drops-engine-question — کارت «یک سؤال کوتاه» صاحب کسب‌وکار
// ---------------------------------------------------------------------------

const TODAY = new Date('2026-10-12T08:00:00.000Z');
/** یک گفته از مسیر قطعی (همان insertTransactions کارت ثبت) در دفتر تازه. */
function capture(text) {
  const run = freshWorkspace();
  run(() => {
    database.saveAccount({ name: 'صندوق', kind: 'cash', openingBalance: 100_000_000 });
    const transactions = parseFinancialText(text, { source: 'voice', now: TODAY }).transactions
      .map((item) => ({ ...item, occurredAt: item.occurredAt || TODAY.toISOString() }));
    database.insertTransactions({ transcript: text, transactions });
  });
  return run;
}
const journalLines = (entryId) => database.activeWorkspaceDatabase()
  .prepare('SELECT l.debit,l.credit,a.name FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.entry_id=? ORDER BY l.debit DESC')
  .all(entryId).map((row) => [row.debit ? 'Dr' : 'Cr', row.name, row.debit || row.credit]);

/** کارت امروز را تا آخرین سؤال جواب می‌دهد و بعد «بله» می‌زند. */
function answerThroughToday(run, answers) {
  return run(() => {
    const asked = [];
    for (const answer of answers) {
      const [card] = database.pendingConfirmations().items;
      assert.ok(card?.ask, `سؤالی برای جواب ${JSON.stringify(answer)} نیست`);
      assert.equal(card.hint, card.ask.text, 'راهنما همان سؤال زنده است');
      asked.push(card.ask.fact);
      database.answerPending(card.id, { fact: card.ask.fact, ...answer });
    }
    const [card] = database.pendingConfirmations().items;
    assert.equal(card.ask, null, 'بعد از آخرین جواب سؤالی نمی‌ماند');
    assert.notEqual(card.hint, 'دورهٔ پوشش از کِی شروع می‌شود؟', 'راهنمای کهنه نمی‌ماند');
    const posted = database.confirmPending(card.id);
    assert.equal(posted.status, 'posted');
    const schedule = database.activeWorkspaceDatabase().prepare("SELECT COUNT(*) n, COALESCE(SUM(amount),0) total FROM recognition_schedule_items WHERE status='planned'").get();
    return { asked, lines: journalLines(posted.journalEntryId), schedule: { n: schedule.n, total: schedule.total } };
  });
}

test('کارت امروز: سؤال دورهٔ پوشش با گزینه‌هایش؛ «بله» فقط بعد از جواب، با پیش‌پرداخت و دوازده قسط', () => {
  for (const [text, amount] of [
    ['بیمه انبار ۱۲ میلیون دادیم', 12_000_000],
    ['اجاره دفتر رو جلو جلو دادیم ۳۰ میلیون', 30_000_000],
    ['اشتراک نرم افزار 24 میلیون پرداخت کردیم', 24_000_000],
    ['بيمه بدنه ماشين ۹ ميليون داديم', 9_000_000],
  ]) {
    const run = capture(text);
    run(() => {
      const [card] = database.pendingConfirmations().items;
      assert.deepEqual(card.ask.options.map((option) => option.label), ['از همین ماه', 'از اول ماه بعد', 'دوره‌اش گذشته', 'تاریخش را می‌گویم'], text);
      // «بله» پیش از جواب همان خطای قبلی است؛ کارت دیگر آن را نشان نمی‌دهد.
      assert.throws(() => database.confirmPending(card.id), { code: 'EVENT_PLAN_REVISION_REQUIRED' });
    });
    const result = answerThroughToday(run, [{ value: 'this-month' }, { value: 'one-year' }]);
    assert.deepEqual(result.asked, ['servicePeriodStart', 'servicePeriodEnd'], text);
    assert.equal(result.lines.length, 2, text);
    assert.match(result.lines[0][1], /پیش‌پرداخت/, `${text}: ${JSON.stringify(result.lines)}`);
    assert.deepEqual([result.lines[0][0], result.lines[0][2]], ['Dr', amount], text);
    assert.deepEqual([result.lines[1][0], result.lines[1][2]], ['Cr', amount], text);
    assert.match(result.lines[1][1], /صندوق/, text);
    assert.deepEqual(result.schedule, { n: 12, total: amount }, text);
  }
  // تاریخ آزاد: «تاریخش را می‌گویم» با متن.
  const typed = answerThroughToday(capture('بیمه انبار ۱۲ میلیون دادیم'), [{ value: 'custom', freeText: '۱ آبان ۱۴۰۵' }, { value: 'one-year' }]);
  assert.deepEqual(typed.schedule, { n: 12, total: 12_000_000 });
});

test('کارت امروز: هر سؤال موتور — قابل استرداد، کاربرد خرید، بابت پرداخت و بابت دریافت — همین‌جا جواب می‌گیرد', () => {
  // ودیعه بی‌سؤال استرداد است؛ فقط صاحبخانهٔ ناگفته پرسیده می‌شود (۲۲ مهر ۱۴۰۵).
  const deposit = answerThroughToday(capture('ودیعه اجاره دفتر ۵۰ میلیون دادیم'), [{ freeText: 'آقای کریمی' }]);
  assert.deepEqual(deposit.asked, ['counterparty']);
  assert.equal(deposit.schedule.n, 0, 'ودیعهٔ قابل استرداد برنامهٔ هزینه ندارد');
  assert.doesNotMatch(deposit.lines[0][1], /هزینه|اجاره$/, JSON.stringify(deposit.lines));
  // سؤال استرداد هنوز هست، برای ودیعه‌ای که از اجاره کم می‌شود.
  assert.deepEqual(answerThroughToday(capture('ودیعه ۲۰ میلیون دادیم که از اجاره ماهانه کم میشه'), [{ value: true }]).asked, ['refundable']);
  assert.deepEqual(answerThroughToday(capture('لپ تاپ ۸۰ میلیون خریدیم'), [{ value: 'current-consumption' }]).asked, ['intendedUse']);
  assert.deepEqual(answerThroughToday(capture('۵۰ میلیون به آقای رضایی دادیم'), [{ value: 'advance' }]).asked, ['paymentPurpose']);
  assert.deepEqual(answerThroughToday(capture('اقای کریمی ۲۰ میلیون داد'), [{ value: 'sale' }]).asked, ['receiptPurpose']);
});

test('کارت امروز: جواب فقط برای همان سؤال و گزینه‌های خودش؛ مورد بی‌سؤال همان «بله» را دارد', () => {
  const run = capture('بیمه انبار ۱۲ میلیون دادیم');
  run(() => {
    const [card] = database.pendingConfirmations().items;
    assert.throws(() => database.answerPending(card.id, { fact: 'servicePeriodEnd', value: 'one-year' }), { code: 'CONFIRMATION_QUESTION_CHANGED' });
    assert.throws(() => database.answerPending(card.id, { fact: 'servicePeriodStart', value: 'one-year' }), { code: 'CONFIRMATION_OPTION_INVALID' });
    assert.throws(() => database.answerPending(card.id, { fact: 'servicePeriodStart', value: 'custom', freeText: '  ' }), { code: 'CONFIRMATION_ANSWER_REQUIRED' });
    assert.equal(database.pendingConfirmations().items[0].ask.fact, 'servicePeriodStart', 'جواب ردشده چیزی را عوض نکرد');
  });
  // منفی: مورد کم‌اطمینان عادی سؤالی ندارد و «بله» همچنان ثبت می‌کند.
  const plain = capture('ناهار پرسنل ۲ میلیون دادیم');
  plain(() => {
    const [card] = database.pendingConfirmations().items;
    assert.equal(card.ask, null);
    assert.throws(() => database.answerPending(card.id, { fact: 'servicePeriodStart', value: 'this-month' }), { code: 'CONFIRMATION_NO_QUESTION' });
    assert.equal(database.confirmPending(card.id).status, 'posted');
  });
});

test('کارت امروز: مسیر جواب در تجربهٔ ساده باز است و همان رتبهٔ «بله» را می‌خواهد', async () => {
  const { minimumRoleForRequest } = await import('../server/access.js');
  const { pathNeedsProfessional } = await import('../shared/experience.js');
  assert.equal(minimumRoleForRequest('POST', '/confirmations/abc/answer'), minimumRoleForRequest('POST', '/confirmations/abc/confirm'));
  assert.equal(pathNeedsProfessional('/confirmations/abc/answer'), false);
  assert.equal(pathNeedsProfessional('/financial-events/abc/answer'), true, 'ابزار حسابدار همچنان حرفه‌ای است');
  const server = serverSource();
  assert.match(server, /app\.post\('\/api\/confirmations\/:id\/answer'/);
  await withVite(async (vite) => {
    const { PendingQuestionView } = await vite.ssrLoadModule('/src/features/today/TodayPage.jsx');
    const render = (question) => renderToStaticMarkup(React.createElement(PendingQuestionView, { question, onYes() {}, onHandover() {}, onAnswer() {} }));
    const ask = { fact: 'servicePeriodStart', kind: 'options', text: 'دورهٔ پوشش از کِی شروع می‌شود؟', options: FACT_QUESTIONS.servicePeriodStart.options.map((option) => ({ ...option, freeInput: Boolean(option.freeInput) })) };
    const asking = render({ id: 'e1', question: 'پرداخت بابت بیمه — ۱۲٬۰۰۰٬۰۰۰ تومان', hint: ask.text, ask });
    for (const label of ['از همین ماه', 'از اول ماه بعد', 'دوره‌اش گذشته', 'تاریخش را می‌گویم', 'مطمئن نیستم']) assert.match(asking, new RegExp(label));
    assert.doesNotMatch(asking, /بله، درست است/);
    const plain = render({ id: 'e2', question: 'پرداخت بابت خوراک — ۲٬۰۰۰٬۰۰۰ تومان', hint: '', ask: null });
    assert.match(plain, /بله، درست است/);
    assert.match(plain, /مطمئن نیستم/);
  });
});

// ---------------------------------------------------------------------------
// review-insurance-settlement-misfire — حق بیمهٔ کارکنان، لیست تأمین اجتماعی نیست
// ---------------------------------------------------------------------------

const { proposeReview } = await import('../server/accountingReviewAi.js');
const { buildWorkbook } = await import('../server/spreadsheet.js');
const { reviewNature } = await import('../shared/reviewNature.js');
const { isTimeBoundService } = await import('../shared/economicFamily.js');

const PAYROLL_HEADER = ['نام پرسنل', 'کد ملی', 'حقوق ناخالص', 'بیمه سهم کارمند', 'بیمه سهم کارفرما', 'مالیات', 'سایر کسورات', 'خالص پرداختی'];
// بیمهٔ لیست: ۳٫۵ + ۱۱٫۵ = ۱۵ میلیون.
const PAYROLL_PEOPLE = [
  ['رضا کریمی', '0012345678', 30_000_000, 2_100_000, 6_900_000, 600_000, 0, 27_300_000],
  ['مینا رجبی', '0023456789', 20_000_000, 1_400_000, 4_600_000, 400_000, 0, 18_200_000],
];

/** مدل، اگر پرسیده شود، همان پیش‌پرداخت را پیشنهاد می‌دهد؛ شمارنده نشان می‌دهد پرسیده شد یا نه. */
function prepaidModel() {
  const calls = { n: 0 };
  const fetcher = async (_url, init) => {
    calls.n += 1;
    const amount = Number(JSON.parse(init.body).input[0].content[0].text.match(/مبلغ قطعی رویداد: (\d+)/)?.[1]);
    const out = { questions: [], summary: 'پیش‌پرداخت بیمه', explanation: 'حق بیمهٔ دوره‌دار', missingFacts: [], counterpartyName: null, inventoryItems: [],
      lines: [{ role: 'prepaid-asset', key: 'پیش‌پرداخت بیمه', accountId: null, chartAccountId: null, debit: amount, credit: 0 }, { role: 'cash', key: null, accountId: null, chartAccountId: null, debit: 0, credit: amount }] };
    return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(out) }] }], usage: {} }) };
  };
  return { fetcher, calls };
}

async function withModelKey(callback) {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key-not-real';
  try { return await callback(); } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
}

/** گفته از کارت ثبت، «مطمئن نیستم»، و پیشنهاد دستیار حسابدار. */
async function reviewOf(text, { payroll = false, message = '' } = {}) {
  const run = freshWorkspace();
  return withModelKey(() => run(async () => {
    const cash = database.saveAccount({ name: 'صندوق', kind: 'cash', openingBalance: 500_000_000 });
    if (payroll) database.importPayrollFile(buildWorkbook([{ name: 'حقوق', rows: [PAYROLL_HEADER, ...PAYROLL_PEOPLE] }]), 'payroll.xlsx', { period: '۱۴۰۵/۰۶', occurredAt: '2026-09-01' });
    const transactions = parseFinancialText(text, { source: 'voice', now: TODAY }).transactions
      .map((item) => ({ ...item, accountId: cash.id, occurredAt: item.occurredAt || TODAY.toISOString() }));
    database.insertTransactions({ transcript: text, transactions, allowDuplicates: true });
    const sql = database.activeWorkspaceDatabase();
    const event = sql.prepare('SELECT id,route FROM financial_events ORDER BY rowid DESC').get();
    if (event.route !== 'accountant-review') database.handOverPending(event.id);
    const model = prepaidModel();
    const proposal = await proposeReview(sql, event.id, { fetcher: model.fetcher, message, facts: { accountId: cash.id } });
    const item = database.reviewQueue().items.find((entry) => entry.id === event.id);
    return { proposal, modelCalled: model.calls.n > 0, canPost: item?.aiProposal?.canPost, eventId: event.id, decision: database.eventDecision(event.id).decision, sql };
  }));
}
const roleShape = (proposal) => proposal.lines.map((line) => [line.role, line.debit || 0, line.credit || 0]);

test('دستیار حسابدار: حق بیمهٔ کارکنان و کارگران با دورهٔ پوشش به مدل می‌رسد و پیش‌پرداخت می‌شود، نه لیست حقوق', async () => {
  for (const [text, amount] of [
    ['بیمه تکمیلی کارکنان یک ساله ۲۴ میلیون پرداخت کردیم', 24_000_000],
    ['بیمه مسئولیت کارگران یک ساله ۱۲ میلیون پرداخت کردیم', 12_000_000],
    ['بیمه درمان کارکنان شش ماهه ۱۸ میلیون واریز کردیم', 18_000_000],
    ['بیمه عمر کارکنان یک ساله ۱۰ میلیون دادیم', 10_000_000],
    ['بیمه حوادث كارگران دوازده ماهه 6 میلیون پرداخت شد', 6_000_000],
    ['بیمه تکمیلي كاركنان يكساله 24 میلیون پرداخت کردیم', 24_000_000],
  ]) {
    const review = await reviewOf(text);
    assert.equal(review.modelCalled, true, `${text}: مدل پرسیده شد`);
    assert.notEqual(review.proposal.model, 'nature-rules-v1', text);
    assert.deepEqual(roleShape(review.proposal), [['prepaid-asset', amount, 0], ['cash', 0, amount]], text);
    assert.equal(review.canPost, true, text);
  }
});

test('دستیار حسابدار: «حقوقی» و «لیست قیمت» در جملهٔ بیمه‌نامه، لیست حقوق نمی‌سازند؛ پیام آزاد حسابدار به مدل می‌رسد', async () => {
  for (const text of [
    'بیمه مسئولیت شخص حقوقی شرکت یک ساله ۲۰ میلیون پرداخت شد',
    'بیمه آتش سوزی کارگاه یک ساله ۱۵ میلیون طبق لیست قیمت بیمه دی پرداخت شد',
  ]) {
    const review = await reviewOf(text);
    assert.equal(review.modelCalled, true, text);
    assert.ok(!review.proposal.lines.some((line) => line.role === 'payroll-insurance-payable'), text);
    assert.doesNotMatch(JSON.stringify(review.proposal.questions), /لیست حقوق/, text);
  }
  const corrected = await reviewOf('بیمه تکمیلی کارکنان یک ساله ۳۰ میلیون پرداخت کردیم', { message: 'این حق بیمه تکمیلی یک ساله به شرکت بیمه است نه لیست تامین اجتماعی؛ پیش پرداخت ثبت کن' });
  assert.equal(corrected.modelCalled, true);
  assert.deepEqual(roleShape(corrected.proposal), [['prepaid-asset', 30_000_000, 0], ['cash', 0, 30_000_000]]);
});

test('دستیار حسابدار: لیست حقوق باز با همان مبلغ، حق بیمهٔ تکمیلی را تسویهٔ لیست نمی‌کند؛ لیست واقعی همچنان تسویه می‌شود', async () => {
  const premium = await reviewOf('بیمه تکمیلی کارکنان یک ساله ۱۵ میلیون پرداخت کردیم', { payroll: true });
  assert.equal(premium.modelCalled, true);
  assert.deepEqual(roleShape(premium.proposal), [['prepaid-asset', 15_000_000, 0], ['cash', 0, 15_000_000]]);
  assert.equal(premium.sql.prepare('SELECT insurance_paid_at AS paid FROM payroll_runs').get().paid, null, 'لیست حقوق پرداخت‌نشده می‌ماند');
  for (const text of [
    '۱۵ میلیون تومن بیمه تامین اجتماعی پرسنل (سهم کارفرما، بیکاری و کارگر) به تامین اجتماعی پرداخت شد',
    'لیست بیمه شهریور رو ۱۵ میلیون دادیم',
  ]) {
    const list = await reviewOf(text, { payroll: true });
    assert.equal(list.proposal.model, 'nature-rules-v1', text);
    assert.equal(list.modelCalled, false, text);
    assert.deepEqual(roleShape(list.proposal), [['payroll-insurance-payable', 15_000_000, 0], ['cash', 0, 15_000_000]], text);
  }
});

test('ماهیت بیمه: موتور و دستیار یک قاعده می‌خوانند', () => {
  const premiums = [
    'بیمه تکمیلی کارکنان یک ساله ۲۴ میلیون پرداخت کردیم',
    'بیمه مسئولیت کارگران یک ساله ۱۲ میلیون پرداخت کردیم',
    'بیمه کارکنان یک ساله ۲۴ میلیون پرداخت کردیم',
    'بیمه مسئولیت شخص حقوقی شرکت یک ساله ۲۰ میلیون پرداخت شد',
    'بیمه آتش سوزی کارگاه یک ساله ۱۵ میلیون طبق لیست قیمت بیمه دی پرداخت شد',
    'بیمه انبار یک ساله ۱۲ میلیون پرداخت کردیم',
  ];
  const lists = [
    '۱۵ میلیون تومن بیمه تامین اجتماعی پرسنل (سهم کارفرما، بیکاری و کارگر) به تامین اجتماعی پرداخت شد',
    'لیست بیمه شهریور رو ۱۵ میلیون دادیم',
    'سه میلیون حق بیمه پرسنل دادم',
    'بیمه کارکنان شهریور ۱۵ میلیون پرداخت شد',
    'حق بیمه تأمین اجتماعی لیست حقوق مهر رو ریختیم',
  ];
  for (const text of premiums) {
    const nature = reviewNature(text);
    assert.equal(nature.insuranceSettlement, false, text);
    assert.equal(nature.prepaid, true, `${text}: نگهبان «منفعت آینده هزینه نیست» روشن است`);
    assert.equal(isTimeBoundService({ category: 'بیمه', utterance: text }), true, text);
  }
  for (const text of lists) {
    assert.equal(reviewNature(text).insuranceSettlement, true, text);
    assert.equal(reviewNature(text).prepaid, false, text);
    assert.equal(isTimeBoundService({ category: 'بیمه', utterance: text }), false, text);
  }
  // خسارت دریافتی از بیمه‌گر: نه حق بیمه، نه لیست.
  const claim = 'خسارت بیمه انبار ۲۵ میلیون واریز شد';
  assert.equal(reviewNature(claim).insuranceSettlement, false);
  assert.equal(isTimeBoundService({ category: 'بیمه', utterance: claim }), false);
});

test('دستیار حسابدار: حق بیمهٔ حوادث کارگران که دستهٔ «حقوق و دستمزد» خورده، سؤال خالص/ناخالص حقوق نمی‌گیرد', async () => {
  const text = 'بیمه حوادث کارگران دوازده ماهه ۶ میلیون پرداخت شد';
  const review = await reviewOf(text);
  assert.ok(!review.proposal.questions.some((question) => question.id === 'payroll.gross-or-net'), JSON.stringify(review.proposal.questions));
  // منفی: حقوق واقعی همان سؤال را می‌گیرد.
  const salary = await reviewOf('حقوق مهر کارکنان ۴۰ میلیون پرداخت شد');
  assert.ok(salary.proposal.questions.some((question) => question.id === 'payroll.gross-or-net'), JSON.stringify(salary.proposal));
});

// ---------------------------------------------------------------------------
// review-blocks-refund-cash-direction — برگشت وجه پیش‌پرداخت، ودیعه و درآمد انتقالی
// ---------------------------------------------------------------------------

const T0 = '2026-10-10T08:00:00.000Z';
const T1 = '2026-12-27T08:00:00.000Z';
const fixedModel = (lines) => async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ questions: [], summary: 'بازبینی', explanation: 'سند طبق شواهد متن.', missingFacts: [], counterpartyName: null, inventoryItems: [], lines: lines.map((line) => ({ key: null, accountId: null, chartAccountId: null, ...line })) }) }] }], usage: {} }) });

/** دفتر تازه با یک ثبت پایه (اختیاری) و یک گفتهٔ عودت در صف حسابدار؛ پیشنهاد مدل با سطرهای داده‌شده. */
async function refundReview({ base = null, text, party = null, lines, message = '' }) {
  const run = freshWorkspace();
  return withModelKey(() => run(async () => {
    const sql = database.activeWorkspaceDatabase();
    database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 300_000_000 });
    const cashBox = database.listAccounts().find((account) => account.name === 'صندوق نقدی');
    const capture = (said, at, tag) => {
      const rows = parseFinancialText(said, { source: 'voice', now: new Date(at) }).transactions;
      const ids = database.insertTransactions({ transcript: said, transactions: rows.map((row, index) => ({ ...row, occurredAt: row.occurredAt || at, userConfirmed: true, clientId: `${tag}-${index}` })) });
      return ids.map((id) => sql.prepare('SELECT * FROM financial_events WHERE source_event_id=?').get(`transaction:${id}`));
    };
    if (base) {
      const [event] = capture(base, T0, 'base');
      // ثبت پایه یا خودکار سند خورده یا با تأیید.
      if (sql.prepare('SELECT status FROM financial_events WHERE id=?').get(event.id).status === 'pending') database.approveEvent(event.id);
      assert.equal(sql.prepare('SELECT status FROM financial_events WHERE id=?').get(event.id).status, 'posted', base);
    }
    const [event] = capture(text, T1, 'refund');
    if (event.route !== 'accountant-review') database.handOverPending(event.id);
    const contact = party ? sql.prepare('SELECT id FROM contacts WHERE name=?').get(party) || sql.prepare('SELECT id FROM contacts WHERE name LIKE ? ORDER BY rowid').get(`%${party}%`) || database.saveContact({ name: party }) : null;
    const ledger = (kind, like = '') => sql.prepare('SELECT id FROM ledger_accounts WHERE source_kind=? AND name LIKE ?').get(kind, `%${like}%`)?.id || null;
    const said = lines({ ledger });
    const proposal = await proposeReview(sql, event.id, { fetcher: fixedModel(said), facts: { accountId: cashBox.id, ...(contact ? { counterpartyId: contact.id } : {}) }, message });
    const prepared = database.reviewAssistantHistory(event.id).proposal;
    const balance = (kind, like = '') => sql.prepare('SELECT COALESCE(SUM(l.debit-l.credit),0) n FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE a.source_kind=? AND a.name LIKE ?').get(kind, `%${like}%`).n;
    const cash = () => database.listAccounts().find((account) => account.id === cashBox.id).balance;
    let accepted = null;
    const cashBefore = cash();
    if (prepared.canPost) accepted = database.reviewAiFeedback(event.id, proposal.id, { accepted: true }).item;
    return { proposal, prepared, accepted, cashMoved: cash() - cashBefore, balance };
  }));
}

test('صف حسابدار: برگشت حق بیمه، ودیعه و پیش‌پرداخت خرید ورود وجه و کاهش همان دارایی است؛ عودت اجارهٔ جلو گرفته خروج وجه و کاهش درآمد انتقالی', async () => {
  const insurer = await refundReview({
    base: 'بیمه آتش سوزی یک ساله ۱۲ میلیون از حساب تجارت دادیم',
    text: 'بیمه رو فسخ کردیم ۶ میلیون پس دادن',
    lines: ({ ledger }) => [{ role: 'cash', debit: 6e6, credit: 0 }, { role: 'prepaid-asset', key: 'بیمه', accountId: ledger('prepaid-asset', 'بیمه'), debit: 0, credit: 6e6 }],
  });
  assert.equal(insurer.prepared.canPost, true, insurer.prepared.postingBlockers?.join('|'));
  assert.equal(insurer.accepted.status, 'posted');
  assert.equal(insurer.cashMoved, 6_000_000);
  assert.equal(insurer.balance('prepaid-asset', 'بیمه'), 6_000_000, 'نیمی از پیش‌پرداخت می‌ماند');

  const deposit = await refundReview({
    base: 'ودیعه دفتر ۵۰ میلیون به آقای کریمی صاحبخونه دادیم که برمیگرده',
    text: 'دفتر رو تخلیه کردیم آقای کریمی ودیعه ۵۰ میلیون رو پس داد', party: 'کریمی',
    lines: ({ ledger }) => [{ role: 'cash', debit: 50e6, credit: 0 }, { role: 'refundable-deposit', accountId: ledger('refundable-deposit'), debit: 0, credit: 50e6 }],
  });
  assert.equal(deposit.prepared.canPost, true, deposit.prepared.postingBlockers?.join('|'));
  assert.equal(deposit.cashMoved, 50_000_000);
  assert.equal(deposit.balance('refundable-deposit'), 0);

  const tenant = await refundReview({
    base: 'اجاره گرفتم شش ماهه ۶۰ میلیون از آقای احمدی',
    text: 'مستاجر زودتر تخلیه کرد ۱۰ میلیون از اجاره جلو گرفته رو بهش پس دادیم', party: 'احمدی',
    lines: ({ ledger }) => [{ role: 'deferred-revenue', key: 'احمدی', accountId: ledger('deferred-revenue', 'احمدی'), debit: 10e6, credit: 0 }, { role: 'cash', debit: 0, credit: 10e6 }],
  });
  assert.equal(tenant.prepared.canPost, true, tenant.prepared.postingBlockers?.join('|'));
  assert.equal(tenant.cashMoved, -10_000_000);
  assert.equal(tenant.balance('deferred-revenue', 'احمدی'), -50_000_000);

  const supplier = await refundReview({
    base: 'پیش پرداخت خرید کالا ۵ میلیون به شرکت پارس کالا دادیم',
    text: 'شرکت پارس کالا پیش پرداخت ۵ میلیون رو پس داد', party: 'شرکت پارس کالا',
    lines: () => [{ role: 'cash', debit: 5e6, credit: 0 }, { role: 'supplier-advance', debit: 0, credit: 5e6 }],
  });
  assert.equal(supplier.prepared.canPost, true, supplier.prepared.postingBlockers?.join('|'));
  assert.equal(supplier.cashMoved, 5_000_000);
  assert.equal(supplier.balance('prepaid-asset', 'پارس کالا'), 0, 'همان پیش‌پرداخت خرید بسته شد');
});

test('صف حسابدار: «پیش دریافت» مستأجری که موتور درآمد انتقالی ثبت کرده، پیشنهاد قاعده‌ای را از همان حساب کم می‌کند', async () => {
  const review = await refundReview({
    base: 'اجاره گرفتم شش ماهه ۶۰ میلیون از آقای احمدی',
    text: 'آقای احمدی مستاجر تخلیه کرد ۱۰ میلیون از پیش دریافت اجاره رو بهش پس دادیم', party: 'احمدی',
    lines: () => [],
  });
  assert.equal(review.proposal.model, 'nature-rules-v1');
  assert.deepEqual(roleShape(review.proposal), [['deferred-revenue', 10_000_000, 0], ['cash', 0, 10_000_000]]);
  assert.equal(review.prepared.canPost, true, review.prepared.postingBlockers?.join('|'));
  assert.equal(review.cashMoved, -10_000_000);
});

test('صف حسابدار: برگشت وجه بی‌سند مبنا، بیش از مانده، بی‌گفتهٔ عودت، یا در جهت پرداخت اولیه ثبت نمی‌شود', async () => {
  const insuranceBase = 'بیمه آتش سوزی یک ساله ۱۲ میلیون از حساب تجارت دادیم';
  const back = (amount) => ({ ledger }) => [{ role: 'cash', debit: amount, credit: 0 }, { role: 'prepaid-asset', key: 'بیمه', accountId: ledger('prepaid-asset', 'بیمه'), debit: 0, credit: amount }];
  const noBase = await refundReview({ text: 'بیمه رو فسخ کردیم ۶ میلیون پس دادن', lines: back(6e6) });
  assert.equal(noBase.prepared.canPost, false);
  assert.ok(noBase.prepared.postingBlockers.some((blocker) => /ماندهٔ واقعی این پیش‌پرداخت/.test(blocker)));
  const over = await refundReview({ base: insuranceBase, text: 'بیمه رو فسخ کردیم ۲۰ میلیون پس دادن', lines: back(20e6) });
  assert.equal(over.prepared.canPost, false);
  assert.equal(over.cashMoved, 0);
  // پول به صندوق آمد ولی متن از برگشت نمی‌گوید: جهت همان قاعدهٔ یک‌طرفه.
  const silent = await refundReview({ base: insuranceBase, text: 'بابت بیمه ۶ میلیون به صندوق اومد', lines: back(6e6) });
  assert.equal(silent.prepared.canPost, false);
  assert.ok(silent.prepared.postingBlockers.includes('جهت ورود یا خروج نقد با ماهیت سطر مقابل سازگار نیست.'));
  // سند وارونه روی جملهٔ عودت: صندوق را منفی می‌کرد.
  const wrongWay = await refundReview({ base: insuranceBase, text: 'بیمه رو فسخ کردیم ۶ میلیون پس دادن',
    lines: ({ ledger }) => [{ role: 'prepaid-asset', key: 'بیمه', accountId: ledger('prepaid-asset', 'بیمه'), debit: 6e6, credit: 0 }, { role: 'cash', debit: 0, credit: 6e6 }] });
  assert.equal(wrongWay.prepared.canPost, false);
  assert.equal(wrongWay.cashMoved, 0);
});

test('ماهیت عودت: فقط پولی که برگشت، نه وعدهٔ برگشت یا «قابل استرداد»', () => {
  for (const text of [
    'بیمه رو فسخ کردیم ۶ میلیون پس دادن', 'آقای کریمی ودیعه ۵۰ میلیون رو پس داد', 'ده میلیون به مستاجر پس دادیم',
    'ودیعه رو از صاحبخونه پس گرفتیم', 'پیش دریافت مشتری عودت داده شد', 'سپرده مزایده مسترد شد', 'شرکت بیمه پول رو برگردوند', 'پیش پرداخت رو برگشت دادن',
  ]) assert.equal(reviewNature(text).refund, true, text);
  for (const text of [
    'ودیعه ۵۰ میلیون به آقای کریمی دادیم که پس میده', 'ودیعه قابل استرداد ۵۰ میلیون پرداخت شد', 'پول ودیعه برمیگرده', 'چک مشتری برگشت خورد', 'بیمه یک ساله ۱۲ میلیون پرداخت شد',
  ]) assert.equal(reviewNature(text).refund, false, text);
});

// ---------------------------------------------------------------------------
// بازبینی: نگهبان «منفعت آینده» فقط با طول صریح چندماهه — پوشش همین ماه یا
// «سالانه» کنار مبلغ، ثبت را گیر نمی‌اندازد.
// ---------------------------------------------------------------------------

/** گفته از کارت ثبت با صندوق؛ مسیر، دلیل‌های صف و نتیجهٔ تأیید. */
function captureOf(text) {
  const run = freshWorkspace();
  return run(() => {
    const cash = database.saveAccount({ name: 'صندوق', kind: 'cash', openingBalance: 500_000_000 });
    const transactions = parseFinancialText(text, { source: 'voice', now: TODAY }).transactions
      .map((item) => ({ ...item, accountId: cash.id, occurredAt: item.occurredAt || TODAY.toISOString() }));
    database.insertTransactions({ transcript: text, transactions, allowDuplicates: true });
    const sql = database.activeWorkspaceDatabase();
    const event = sql.prepare('SELECT id,route,status FROM financial_events ORDER BY rowid DESC').get();
    const reasons = database.reviewQueue().items.find((entry) => entry.id === event.id)?.confidence?.reasons || [];
    let approveError = null;
    if (event.status === 'pending') { try { database.approveEvent(event.id); } catch (error) { approveError = error.code; } }
    const status = sql.prepare('SELECT status FROM financial_events WHERE id=?').get(event.id).status;
    return { route: event.route, reasons, approveError, status, decision: database.eventDecision(event.id).decision };
  });
}
const FUTURE_BENEFIT = /پرداخت برای منفعت آینده هزینه جاری نیست/;

test('نگهبان منفعت آینده: پوشش همین ماه و «سالانه» کنار مبلغ، ثبت را متوقف نمی‌کنند؛ طول چندماههٔ صریح همچنان پیش‌پرداخت است', () => {
  // پوشش مهر، پرداخت در مهر: هزینهٔ همین ماه؛ موتور period-expense می‌گوید و ثبت می‌شود.
  const inMonth = captureOf('بیمه ماشین از اول مهر تا آخر مهر ۲ میلیون دادیم');
  assert.equal(inMonth.decision.treatment, 'period-expense');
  assert.ok(!inMonth.reasons.some((reason) => FUTURE_BENEFIT.test(reason)), JSON.stringify(inMonth.reasons));
  assert.equal(inMonth.approveError, null);
  assert.equal(inMonth.status, 'posted');
  // «سالانه» کنار مبلغ: نگهبان متنی روشن نمی‌شود؛ تصمیم دوره با موتور است.
  const yearly = captureOf('بیمه کالای انبار سالانه ۱۲ میلیون پرداخت کردیم');
  assert.ok(!yearly.reasons.some((reason) => FUTURE_BENEFIT.test(reason)), JSON.stringify(yearly.reasons));
  for (const text of [
    'بیمه ماشین از اول مهر تا آخر مهر ۲ میلیون دادیم',
    'بیمه کالای انبار سالانه ۱۲ میلیون پرداخت کردیم',
    'بیمه ماشین از اول فروردین تا آخر شهریور ۶ میلیون دادیم',
    'پوشش بیمه دفتر ۳ میلیون پرداخت شد',
  ]) assert.equal(reviewNature(text).prepaid, false, text);
  // مثبت: طول صریح سالانه و دوازده‌ماهه، از جمله حق بیمهٔ کارکنان.
  for (const text of [
    'بیمه انبار یک ساله ۱۲ میلیون پرداخت کردیم', 'بیمه تکمیلی کارکنان یکساله ۲۴ میلیون پرداخت کردیم',
    'بیمه حوادث کارگران دوازده ماهه ۶ میلیون پرداخت شد', 'بیمه آتش سوزی 12 ماه 9 میلیون دادیم', 'پیش پرداخت اجاره ۳۰ میلیون دادیم',
  ]) assert.equal(reviewNature(text).prepaid, true, text);
  // یک‌ساله که موتور پیش‌پرداخت تصمیم می‌گیرد، همچنان بی‌مانع ثبت می‌شود.
  const annual = captureOf('بیمه انبار یک ساله ۱۲ میلیون پرداخت کردیم');
  assert.equal(annual.decision.treatment, 'prepaid-expense');
  assert.equal(annual.status, 'posted');
});

// ---------------------------------------------------------------------------
// بازبینی: «پس داده میشه»، «برگردونده میشه»، «عودت داده میشه» وعده است، نه
// برگشت — پرداخت ودیعه و دریافت اجارهٔ جلو همچنان ثبت می‌شوند.
// ---------------------------------------------------------------------------

test('ماهیت عودت: مجهول آینده، شرط و نفیِ برگشت عودت نیستند؛ فعل گذشته و ماضی نقلی هستند', () => {
  for (const text of [
    'ودیعه اجاره دفتر ۵۰ میلیون به آقای کریمی دادیم که موقع تخلیه پس داده میشه',
    'ودیعه دفتر ۵۰ میلیون به آقای کریمی دادیم آخر قرارداد برگردونده میشه',
    'اجاره ۶ ماه جلو از آقای احمدی ۶۰ میلیون گرفتیم که اگه زودتر بره عودت داده میشه',
    'مساعده ۵ میلیون به علی دادیم از حقوقش پس گرفته میشه',
    'پیش پرداخت خرید ۲۰ میلیون به پارس کالا دادیم اگه جنس نیاد پول پس داده میشه',
    'ودیعه ۵۰ میلیون به صاحبخونه دادیم که پس داده می‌شود',
    'ودیعه ۵۰ میلیون دادیم باید آخر قرارداد پس داده بشه',
    'ودیعه ۵۰ میلیون دادیم هنوز پس داده نشده',
    'ودیعه ۵۰ میلیون دادیم که عودت داده خواهد شد',
  ]) assert.equal(reviewNature(text).refund, false, text);
  for (const text of [
    'شرکت بیمه پول رو برگردونده', 'ودیعه پس داده شد', 'سپرده مزایده مسترد شده', '۵ میلیون ودیعه رو به صاحبخونه برگردوندیم',
    'صاحبخونه قبلی ۶۰ میلیون ودیعه‌مون رو به تجارت برگردوند.', 'پیش دریافت مشتری عودت داده شد',
  ]) assert.equal(reviewNature(text).refund, true, text);
  // پیش‌دریافتی که شرط عودت دارد، دریافت است؛ عنوان سند عودت، عودت.
  assert.equal(reviewNature('پیش دریافت اجاره ۶ ماه از آقای احمدی ۶۰ میلیون گرفتیم که اگه زودتر بره عودت داده میشه').advanceRefund, false);
  assert.equal(reviewNature('پیش دریافت ۲۰ میلیون از مشتری واریز شد با شرط عودت اگه کار انجام نشه').advanceRefund, false);
  assert.equal(reviewNature('عودت پیش دریافت مشتری ۱۰ میلیون').advanceRefund, true);
  assert.equal(reviewNature('آقای احمدی مستاجر تخلیه کرد ۱۰ میلیون از پیش دریافت اجاره رو بهش پس دادیم').advanceRefund, true);
});

test('صف حسابدار: ودیعه‌ای که «موقع تخلیه پس داده میشه» و اجارهٔ جلو که «اگه زودتر بره عودت داده میشه» با جهت پرداخت و دریافت اولیه ثبت می‌شوند', async () => {
  for (const text of [
    'ودیعه اجاره دفتر ۵۰ میلیون به آقای کریمی دادیم که موقع تخلیه پس داده میشه',
    'ودیعه دفتر ۵۰ میلیون به آقای کریمی دادیم آخر قرارداد برگردونده میشه',
  ]) {
    const opening = await refundReview({ text, party: 'کریمی',
      lines: () => [{ role: 'refundable-deposit', debit: 50e6, credit: 0 }, { role: 'cash', debit: 0, credit: 50e6 }] });
    assert.equal(opening.prepared.canPost, true, `${text}: ${opening.prepared.postingBlockers?.join('|')}`);
    assert.equal(opening.cashMoved, -50_000_000, text);
  }
  for (const [text, role] of [
    ['اجاره ۶ ماه جلو از آقای احمدی ۶۰ میلیون گرفتیم که اگه زودتر بره عودت داده میشه', 'deferred-revenue'],
    ['پیش دریافت اجاره ۶ ماه از آقای احمدی ۶۰ میلیون گرفتیم که اگه زودتر بره عودت داده میشه', 'customer-advance'],
  ]) {
    const received = await refundReview({ text, party: 'احمدی',
      lines: () => [{ role: 'cash', debit: 60e6, credit: 0 }, { role, debit: 0, credit: 60e6 }] });
    assert.equal(received.prepared.canPost, true, `${text}: ${received.prepared.postingBlockers?.join('|')}`);
    assert.equal(received.cashMoved, 60_000_000, text);
  }
  // منفی: برگشت واقعی ودیعه در جهت پرداخت اولیه همچنان رد می‌شود.
  const wrongWay = await refundReview({ base: 'ودیعه دفتر ۵۰ میلیون به آقای کریمی صاحبخونه دادیم که برمیگرده',
    text: 'دفتر رو تخلیه کردیم آقای کریمی ودیعه ۵۰ میلیون رو پس داد', party: 'کریمی',
    lines: ({ ledger }) => [{ role: 'refundable-deposit', accountId: ledger('refundable-deposit'), debit: 50e6, credit: 0 }, { role: 'cash', debit: 0, credit: 50e6 }] });
  assert.equal(wrongWay.prepared.canPost, false);
  assert.equal(wrongWay.cashMoved, 0);
});

// ---------------------------------------------------------------------------
// بازبینی: «بیمه پرسنلو»، «بیمه کارکنانمون»، «بیمه کارگرهای کارگاه» — پسوند
// چسبیده به واژهٔ کارکنان، لیست بیمهٔ حقوق را حق بیمهٔ دوره‌دار نمی‌کند.
// ---------------------------------------------------------------------------

const { runVoice } = await import('./helpers/voicePipeline.js');
const { isNotInsurancePremium } = await import('../shared/insuranceNature.js');

test('ماهیت بیمه: واژهٔ کارکنان با پسوند جمع، ملکی، اضافه و مفعولی همان لیست بیمهٔ حقوق است؛ موتور دورهٔ پوشش نمی‌پرسد', () => {
  const lists = [
    'بیمه پرسنلو ۱۵ میلیون دادیم',
    'بیمه پرسنلمون رو ۱۵ میلیون دادیم',
    'بیمه کارکنانمون ۱۵ میلیون واریز شد',
    'بیمه کارگرهای کارگاه ۱۵ میلیون پرداخت شد',
    'بیمه کارگرا رو ۱۵ میلیون ریختیم',
    'بیمه کارمندامونو ۸ میلیون دادیم',
    'بیمه کارکنان‌مون ۱۵ میلیون پرداخت شد',
    'بیمه پرسنلی شهریور ۱۵ میلیون پرداخت شد',
  ];
  for (const text of lists) {
    assert.equal(isNotInsurancePremium(text), true, text);
    assert.equal(reviewNature(text).insuranceSettlement, true, text);
    assert.equal(reviewNature(text).prepaid, false, text);
    assert.equal(isTimeBoundService({ category: 'بیمه', utterance: text }), false, text);
  }
  for (const text of lists.slice(0, 3)) {
    const items = runVoice(text, { today: TODAY.toISOString() }).items;
    assert.ok(!items.some((item) => item.fact === 'servicePeriodStart' || item.decision?.treatment === 'prepaid-expense'), `${text}: ${JSON.stringify(items.map((item) => [item.outcome, item.fact]))}`);
  }
  // منفی: حق بیمهٔ بیمه‌نامه با همان پسوندها پیش‌پرداخت می‌ماند؛ «کارگاه» واژهٔ کارگر نیست.
  for (const text of [
    'بیمه تکمیلی کارکنانمون یک ساله ۲۴ میلیون پرداخت کردیم',
    'بیمه حوادث کارگرامون یک ساله ۱۲ میلیون دادیم',
    'بیمه کارگاه یک ساله ۱۵ میلیون پرداخت شد',
  ]) {
    assert.equal(isNotInsurancePremium(text), false, text);
    assert.equal(reviewNature(text).insuranceSettlement, false, text);
    assert.equal(isTimeBoundService({ category: 'بیمه', utterance: text }), true, text);
  }
});

test('دستیار حسابدار: «بیمه کارکنانمون ۱۵ میلیون واریز شد» با لیست باز همان مبلغ، تسویهٔ بیمهٔ لیست حقوق است', async () => {
  for (const text of ['بیمه کارکنانمون ۱۵ میلیون واریز شد', 'بیمه پرسنلو ۱۵ میلیون دادیم']) {
    const list = await reviewOf(text, { payroll: true });
    assert.equal(list.proposal.model, 'nature-rules-v1', text);
    assert.deepEqual(roleShape(list.proposal), [['payroll-insurance-payable', 15_000_000, 0], ['cash', 0, 15_000_000]], text);
    assert.equal(list.canPost, true, text);
  }
});

// ---------------------------------------------------------------------------
// بازبینی: «تأمین اجتماعی … بهمون پس داد» پول آمده است؛ پرداخت لیست بیمه نیست
// و لیست باز را «پرداخت‌شده» نمی‌کند.
// ---------------------------------------------------------------------------

const { insuranceNature } = await import('../shared/insuranceNature.js');
const { insuranceSettlementContext } = await import('../server/reviewInsurance.js');

test('ماهیت بیمه: برگشت پول از تأمین اجتماعی پرداخت لیست نیست؛ واریزِ تأمین اجتماعی به حساب شرکت هم تسویهٔ لیست نیست', async () => {
  for (const text of [
    'سازمان تامین اجتماعی ۱۵ میلیون پول بیمه رو بهمون پس داد',
    'تامین اجتماعی اضافه پرداختی بیمه پرسنل رو برگردوند ۲ میلیون',
    'تامین اجتماعی ۲ میلیون از بیمه کارکنان رو عودت داد',
    'لیست بیمه رو پرداخت کردیم ولی ۲ میلیون اضافه رو تامین اجتماعی پس داد',
  ]) {
    assert.equal(insuranceNature(text).paid, false, text);
    assert.equal(reviewNature(text).insuranceSettlement, false, text);
  }
  // مثبت: «دادیم»، «داد» (پرداخت‌کننده سوم‌شخص) و «پرداخت شد» همچنان پرداخت‌اند.
  for (const text of ['لیست بیمه شهریور رو ۱۵ میلیون دادیم', 'حسابدار بیمه پرسنل رو ۱۵ میلیون داد', 'بیمه تامین اجتماعی مهر پرداخت شد']) {
    assert.equal(reviewNature(text).insuranceSettlement, true, text);
  }
  const run = freshWorkspace();
  await run(async () => {
    database.importPayrollFile(buildWorkbook([{ name: 'حقوق', rows: [PAYROLL_HEADER, ...PAYROLL_PEOPLE] }]), 'payroll.xlsx', { period: '۱۴۰۵/۰۶', occurredAt: '2026-09-01' });
    const sql = database.activeWorkspaceDatabase();
    const deposited = 'تامین اجتماعی ۱۵ میلیون بیمه پرسنل رو به حساب شرکت واریز کرد';
    assert.equal(reviewNature(deposited).insuranceSettlement, true, 'متن به‌تنهایی جهت را نمی‌داند');
    assert.equal(insuranceSettlementContext(sql, deposited, 15_000_000, { kind: 'cash-income', occurredAt: TODAY.toISOString() }), null);
    assert.ok(insuranceSettlementContext(sql, 'لیست بیمه شهریور رو ۱۵ میلیون دادیم', 15_000_000, { kind: 'cash-expense', occurredAt: TODAY.toISOString() })?.run);
  });
  for (const text of ['سازمان تامین اجتماعی ۱۵ میلیون پول بیمه رو بهمون پس داد', 'تامین اجتماعی ۱۵ میلیون بیمه پرسنل رو به حساب شرکت واریز کرد']) {
    const review = await reviewOf(text, { payroll: true });
    assert.notEqual(review.proposal.model, 'nature-rules-v1', text);
    assert.ok(!review.proposal.lines.some((line) => line.role === 'payroll-insurance-payable'), text);
    assert.equal(review.sql.prepare('SELECT insurance_paid_at AS paid FROM payroll_runs').get().paid, null, `${text}: لیست پرداخت‌نشده می‌ماند`);
  }
});

// ---------------------------------------------------------------------------
// بازبینی: «حقوق کارگرا با بیمه درمان ۴۰ میلیون» حقوق است؛ نام بردن از یک
// بیمه‌نامه کنار حقوق، سؤال خالص/ناخالص را حذف نمی‌کند.
// ---------------------------------------------------------------------------

test('دستیار حسابدار: حقوقی که کنارش بیمهٔ درمان یا حوادث آمده، همچنان سؤال خالص/ناخالص می‌گیرد و حدس نمی‌زند', async () => {
  for (const text of [
    'حقوق کارگرا با بیمه درمان ۴۰ میلیون واریز شد',
    'دستمزد کارگرها همراه بیمه حوادث ۲۰ میلیون دادیم',
    'حقوقشون با بیمه عمر ۳۰ میلیون ریختیم',
  ]) {
    const review = await reviewOf(text);
    assert.ok(review.proposal.questions.some((question) => question.id === 'payroll.gross-or-net'), `${text}: ${JSON.stringify(review.proposal.questions)}`);
    assert.equal(review.modelCalled, false, text);
    assert.equal(review.canPost, false, text);
  }
  // منفی: حق بیمهٔ بیمه‌نامهٔ کارکنان بی واژهٔ حقوق، سؤال حقوق نمی‌گیرد.
  const premium = await reviewOf('بیمه حوادث کارگران دوازده ماهه ۶ میلیون پرداخت شد');
  assert.ok(!premium.proposal.questions.some((question) => question.id === 'payroll.gross-or-net'));
});
