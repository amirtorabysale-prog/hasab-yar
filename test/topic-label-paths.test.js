import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tempDatabase } from './helpers/tempPath.js';

/**
 * برچسب موضوعی در همهٔ راه‌های ثبت، ویرایش و تصمیم (بررسی تغییرات z.ai، ۲۸ مهر ۱۴۰۵،
 * ایرادهای ۵ تا ۱۰):
 * ۵. ویرایش ثبتِ برچسب‌دار برچسب را از سند تازه می‌انداخت. خانواده: ویرایش،
 *    بازیابیِ ثبت حذف‌شده، و تأییدِ صف برای برچسبی که روی تراکنشِ در انتظار گذاشته شده.
 * ۶. عوض‌کردن یا برداشتن برچسب روی رویدادِ ثبت‌شده هیچ اثری نداشت.
 * ۷. هر املای موضوع («اجاره دفتر»، «اجارهٔ دفتر»، «اجاره‌ی دفتر») تفصیلی جدا می‌ساخت؛
 *    برچسبِ هم‌نام دسته هم تفصیلی می‌ساخت؛ و پارسیان برچسب‌ها را «طرف حساب» می‌نامید.
 * ۸. پیشنهاد ارتقا فقط با باز کردن صف ساخته می‌شد و ماه پیش را نمی‌دید.
 * ۹. تأیید ارتقا یادگیریِ قبلیِ کاربر برای همان واژه را بی‌صدا بازنویسی می‌کرد.
 * ۱۰. حسابدار دکمهٔ تصمیم و آستانه را می‌دید و از سرور ۴۰۳ می‌گرفت.
 */

process.env.DATABASE_PATH = tempDatabase('topic-label-paths');
process.env.ADMIN_USERNAME = 'topic-paths-owner';
process.env.ADMIN_PASSWORD = 'Mosaic-Harbor-Lantern-3307';
const database = await import('../server/db.js');
const topics = await import('../server/topicPromotion.js');
const { periodForDate } = await import('../server/accounting.js');
const { saveAnalyticAccount, TOPIC_SOURCE_KIND } = await import('../server/chartOfAccounts.js');
const { accountingTransferReadiness } = await import('../server/accountingTransfer.js');
const { minimumRoleForRequest } = await import('../server/access.js');
const { parseFinancialText } = await import('../shared/parser.js');
database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);

const MILLION = 1_000_000;
let books = 0;
function freshBook({ engine = false } = {}) {
  const workspace = database.createWorkspace(owner.id, { name: `دفتر برچسب ${++books}`, profileType: 'business' });
  const inBook = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
  let cash = null;
  inBook(() => {
    database.installChartTemplate();
    database.applyChartSuggestions();
    if (engine) database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true });
    cash = database.saveAccount({ name: 'جاری سامان', kind: 'bank', bankId: 'saman', openingBalance: 500 * MILLION });
  });
  return { inBook, cash };
}
const sql = () => database.activeWorkspaceDatabase();
function post(cash, label, { amount = MILLION, category = 'تعمیرات', occurredAt = new Date().toISOString(), userConfirmed = true } = {}) {
  const [id] = database.insertTransactions({ transcript: `${label} ${amount}`, transactions: [{
    amount, type: 'expense', category, rawText: `${label} ${amount}`, accountId: cash.id, occurredAt,
    userConfirmed, clientId: `paths-${Math.random()}`, topicLabel: label,
  }] });
  return id;
}
/** برچسب‌های موضوعیِ سطرهای سندِ زندهٔ یک تراکنش. */
const liveLabels = (transactionId) => sql().prepare(`SELECT aa.name FROM journal_lines jl
  JOIN journal_entries je ON je.id=jl.entry_id
  JOIN analytic_accounts aa ON aa.id=jl.analytic_id AND aa.source_kind='topic-label'
  WHERE je.source_type='transaction' AND je.source_id=? AND je.entry_kind='normal'
    AND NOT EXISTS (SELECT 1 FROM journal_entries rev WHERE rev.reverses_entry_id=je.id)`).all(transactionId).map((row) => row.name);
const eventOf = (transactionId) => sql().prepare('SELECT * FROM financial_events WHERE source_event_id=?').get(`transaction:${transactionId}`);
/** ثبتی که به صف رفته، همان‌طور که حسابدار تأییدش می‌کند. */
function approveQueued(transactionId) {
  const event = eventOf(transactionId);
  if (!event || event.status !== 'pending') return event;
  answerQueue(event.id);
  database.approveEvent(event.id);
  return eventOf(transactionId);
}
function answerQueue(eventId) {
  for (let round = 0; round < 6; round += 1) {
    const question = database.eventDecision(eventId)?.decision?.question;
    if (!question) return;
    database.answerEvent(eventId, { fact: question.fact, value: question.fact === 'servicePeriodStart' ? 'already-passed' : question.options?.[0]?.value });
  }
}

// --- ۵. برچسب با ویرایش، بازیابی و تأیید صف نمی‌افتد --------------------------

test('بازبینی: ویرایش مبلغِ ثبت برچسب‌دار، برچسب را روی سندِ تازه نگه می‌دارد', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    const id = post(cash, 'کابل');
    database.updateTransaction(id, { amount: 1_200_000 });
    assert.deepEqual(liveLabels(id), ['کابل']);
  });
});

test('بازیابیِ ثبتِ حذف‌شده برچسبش را برمی‌گرداند', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    const id = post(cash, 'کابل');
    database.deleteTransaction(id);
    const restored = database.redoTransaction(id);
    assert.equal(restored.topicLabel, 'کابل');
    // ثبتِ بازیابی‌شده پیش از سند خوردن بازبینی می‌شود؛ برچسب با تأیید روی سند می‌نشیند.
    approveQueued(restored.id);
    assert.deepEqual(liveLabels(restored.id), ['کابل']);
  });
});

test('برچسبی که روی تراکنشِ در صف گذاشته شده، با تأیید صف روی سند می‌نشیند', () => {
  const { inBook, cash } = freshBook({ engine: true });
  inBook(() => {
    const text = 'اجاره دفتر مهر 15 میلیون از حساب سامان';
    const [row] = parseFinancialText(text, { source: 'text', now: new Date() }).transactions;
    const [id] = database.insertTransactions({ transcript: text, transactions: [{ ...row, accountId: cash.id, userConfirmed: false, clientId: `queue-${Math.random()}` }] });
    const event = eventOf(id);
    assert.equal(event.status, 'pending');
    topics.setTransactionTopicLabel(id, 'دفتر مرکزی');
    assert.equal(JSON.parse(eventOf(id).payload).topicLabel, 'دفتر مرکزی', 'صف همان برچسب را نشان می‌دهد');
    answerQueue(event.id);
    database.approveEvent(event.id);
    assert.deepEqual(liveLabels(id), ['دفتر مرکزی']);
  });
});

// --- ۶. برچسب رویدادِ ثبت‌شده عوض و برداشته می‌شود -----------------------------

test('بازبینی: عوض‌کردن و برداشتنِ برچسب روی رویدادِ ثبت‌شده اثر دارد و با تراکنش یکی می‌ماند', () => {
  const { inBook, cash } = freshBook({ engine: true });
  inBook(() => {
    const id = post(cash, 'کلید برق');
    const event = approveQueued(id);
    assert.ok(event?.journal_entry_id, 'رویداد سند خورده است');
    assert.deepEqual(liveLabels(id), ['کلید برق']);
    topics.setEventTopicLabel(event.id, 'پریز');
    assert.deepEqual(liveLabels(id), ['پریز']);
    assert.equal(sql().prepare('SELECT topic_label AS label FROM transactions WHERE id=?').get(id).label, 'پریز');
    topics.setEventTopicLabel(event.id, '');
    assert.deepEqual(liveLabels(id), []);
    // ویرایشِ بعدی برچسبِ برداشته‌شده را زنده نمی‌کند.
    database.updateTransaction(id, { amount: 1_100_000 });
    assert.deepEqual(liveLabels(id), []);
  });
});

// --- ۷. یک موضوع، یک تفصیلی ----------------------------------------------------

test('بازبینی: «اجاره دفتر»، «اجارهٔ دفتر» و «اجاره‌ی دفتر» یک تفصیلی‌اند، با برچسبِ قدیمیِ ذخیره‌شده', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    // برچسبی که پیش از کلید مقایسه با متن خودش ذخیره شده بود.
    const legacy = saveAnalyticAccount(sql(), { name: 'اجاره ی دفتر', kind: 'custom', sourceKind: TOPIC_SOURCE_KIND, sourceKey: 'اجاره ی دفتر' });
    const ids = ['اجاره دفتر', 'اجارهٔ دفتر', 'اجاره‌ی دفتر', 'اجارۀ دفتر'].map((label) => post(cash, label, { category: 'سایر هزینه‌ها' }));
    const analytics = sql().prepare(`SELECT DISTINCT jl.analytic_id AS id FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
      WHERE je.source_id IN (${ids.map(() => '?').join(',')}) AND jl.analytic_id IS NOT NULL`).all(...ids);
    assert.deepEqual(analytics.map((row) => row.id), [legacy.id]);
    const label = topics.topicLabelStats(database.db).labels.find((item) => item.analyticId === legacy.id);
    assert.equal(label.current, 4);
  });
});

test('برچسبِ هم‌نام دسته تفصیلی نمی‌سازد؛ برچسبِ دیگر می‌سازد', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    const same = post(cash, 'اجاره', { category: 'اجاره' });
    const other = post(cash, 'اجاره انبار', { category: 'اجاره' });
    assert.deepEqual(liveLabels(same), []);
    assert.deepEqual(liveLabels(other), ['اجاره انبار']);
  });
});

test('خروجی پارسیان برچسب موضوعی را جدا از طرف حساب می‌گوید', () => {
  const readiness = accountingTransferReadiness({
    journalRows: [
      { entryId: 'e1', accountId: 'a1', analyticId: 'person', analyticSourceKind: 'contact', tafsiliName: 'شرکت بی‌کد', tafsiliCode: null, debit: 1000, credit: 0, chartCode: '1201' },
      { entryId: 'e1', accountId: 'a2', analyticId: 'topic', analyticSourceKind: 'topic-label', tafsiliName: 'کلید برق', tafsiliCode: null, debit: 0, credit: 1000, chartCode: '8111' },
    ],
    chart: { installed: true },
  });
  const people = readiness.checks.find((item) => item.id === 'analytic-mapping');
  const labels = readiness.checks.find((item) => item.id === 'topic-label-mapping');
  assert.deepEqual(people.unmappedAnalytics.map((item) => item.name), ['شرکت بی‌کد']);
  assert.deepEqual(labels.unmappedAnalytics.map((item) => item.name), ['کلید برق']);
  assert.equal(labels.severity, 'advisory');
  assert.doesNotMatch(labels.label, /طرف حساب/);
});

// --- ۸. گشت در کار زمان‌بندی‌شده، با ماه پیش -----------------------------------

test('برچسبی که ماه پیش به آستانه رسید هم پیشنهاد می‌شود', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    const now = new Date();
    const thisMonth = periodForDate(now.toISOString(), 'Asia/Tehran');
    let earlier = new Date(now.getTime() - 20 * 86_400_000);
    while (periodForDate(earlier.toISOString(), 'Asia/Tehran') === thisMonth) earlier = new Date(earlier.getTime() - 86_400_000);
    for (let index = 0; index < 3; index += 1) post(cash, 'باتری', { occurredAt: earlier.toISOString() });
    const [id] = topics.topicPromotionSweep(database.db);
    assert.equal(topics.getTopicPromotion(sql(), id).period, periodForDate(earlier.toISOString(), 'Asia/Tehran'));
  });
});

test('دیدن صف و صفحهٔ برچسب‌ها پیشنهادی نمی‌سازد؛ کار دقیقه‌ای می‌سازد', () => {
  const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const route = (path) => server.slice(server.indexOf(`app.get('${path}'`), server.indexOf('\n});', server.indexOf(`app.get('${path}'`)));
  assert.doesNotMatch(route('/api/financial-events/review-queue'), /topicPromotionSweep/);
  assert.doesNotMatch(route('/api/topics/overview'), /topicPromotionSweep/);
  const job = server.slice(server.indexOf('function runRecurringJob'), server.indexOf('runRecurringJob();'));
  assert.match(job, /topicPromotionSweep/);
});

// --- ۹. یادگیریِ کاربر بی‌صدا عوض نمی‌شود --------------------------------------

test('بازبینی: یادگیریِ قبلیِ واژه می‌ماند مگر تأییدکننده جایگزینی را بخواهد', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    database.saveLearning({ keyword: 'کلید برق', category: 'تعمیرات' });
    for (const label of ['کلید برق', 'لامپ']) { post(cash, label); post(cash, label); post(cash, label); }
    database.saveLearning({ keyword: 'لامپ', category: 'تعمیرات' });
    topics.topicPromotionSweep(database.db);
    const pending = Object.fromEntries(topics.listTopicPromotions(database.db, { status: 'pending' }).map((item) => [item.label, item]));
    assert.equal(topics.listTopicPromotions(database.db).find((item) => item.label === 'کلید برق').existingLearning, 'تعمیرات');
    const kept = topics.decideTopicPromotion(database.db, pending['کلید برق'].id, { decision: 'approve', reason: 'هر ماه تکرار می‌شود' });
    assert.equal(kept.learning, 'kept');
    assert.equal(sql().prepare("SELECT category FROM learnings WHERE keyword='کلید برق'").get().category, 'تعمیرات');
    const replaced = topics.decideTopicPromotion(database.db, pending['لامپ'].id, { decision: 'approve', reason: 'هر ماه تکرار می‌شود', replaceLearning: true });
    assert.equal(replaced.learning, 'replaced');
    assert.equal(sql().prepare("SELECT category FROM learnings WHERE keyword='لامپ'").get().category, 'لامپ');
  });
});

test('واژه‌ای که یادگیری ندارد همان‌طور یاد گرفته می‌شود', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    post(cash, 'سیم'); post(cash, 'سیم'); post(cash, 'سیم');
    const [id] = topics.topicPromotionSweep(database.db);
    assert.equal(topics.decideTopicPromotion(database.db, id, { decision: 'approve', reason: 'هر ماه تکرار می‌شود' }).learning, 'created');
    assert.equal(sql().prepare("SELECT category FROM learnings WHERE keyword='سیم'").get().category, 'سیم');
  });
});

// --- ۱۰. نقش‌ها -------------------------------------------------------------

test('حسابدار آستانه را می‌بیند و فقط مدیر تصمیم می‌گیرد؛ کارت همین را می‌داند', () => {
  assert.equal(minimumRoleForRequest('GET', '/topics/threshold'), 'accountant');
  assert.equal(minimumRoleForRequest('POST', '/topics/threshold'), 'manager');
  assert.equal(minimumRoleForRequest('POST', '/topics/promotions/p1/decide'), 'manager');
  assert.equal(minimumRoleForRequest('GET', '/topics/overview'), 'accountant');
  const queue = readFileSync(new URL('../src/features/review/ReviewQueuePage.jsx', import.meta.url), 'utf8');
  assert.match(queue, /<TopicPromotionsCard[^>]*canDecide=\{\['owner', 'manager'\]\.includes\(access\?\.workspace\?\.role\)\}/);
  const card = readFileSync(new URL('../src/features/review/TopicPromotionsCard.jsx', import.meta.url), 'utf8');
  assert.match(card, /\{canDecide && <>/, 'ورودی‌های تصمیم فقط برای مدیر');
  assert.match(card, /\{canDecide && <div/, 'ورودی آستانه فقط برای مدیر');
});
