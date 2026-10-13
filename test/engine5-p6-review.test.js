import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { tempDatabase } from './helpers/tempPath.js';
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
