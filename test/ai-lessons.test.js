import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

/**
 * پارسر از ثبت‌های تأییدشدهٔ AI یاد می‌گیرد (خواستهٔ مالک محصول، ۲۹ مهر ۱۴۰۵).
 *
 * خانواده:
 * - درس دسته (جهت یکی، دسته فرق دارد): بار اول دیده، بعد از آستانه یاد گرفته؛ فقط دسته،
 *   هرگز جهت؛ یادگیریِ خودِ کاربر بازنویسی نمی‌شود؛ AI دو جور گفته ← تصمیم با انسان؛
 *   پاک‌شده دوباره برنمی‌گردد؛ هر پرونده یک بار.
 * - اختلاف ساختاری (هرگز خودکار): ردیف نقدی برای پولِ نرفته (T18)، جهت برعکس، پولِ جیبِ
 *   شریک، انتقال، تسویه، مبلغِ دیگر، دسته‌ای که موضوعِ یادگیری ندارد.
 * - منفی: پارسری که کارت یا صف باز می‌کرد، هم‌نظری، دستهٔ عمومیِ AI، موضوعِ عمومی.
 * جمله‌های T01 و T18 عیناً از دور ۲۰ سناریوی سخت (docs/testing/scenarios-20-hard.json).
 */

const NOW = '2026-10-14T08:00:00.000Z';
const none = { op: null, of: [] };
const T01 = 'یه کلید برق ۴۵۰ هزار تومانی برای تابلوی برق دفتر خریدیم که کلید سوختهٔ قبلی رو عوض کردیم؛ نقد از صندوق.';
const T18 = 'قبض برق مهر مغازه ۴ میلیون تومان اومده ولی قراره تا آبان پرداختش کنیم.';
// پارسر خودِ T01 را حالا درست می‌گیرد (قطعهٔ سوخته که عوض شد)؛ همان کلید بی «سوخته» هنوز دستهٔ عمومی می‌گیرد.
const SWITCH = 'یه کلید برق ۴۵۰ هزار تومانی برای تابلوی برق دفتر خریدیم؛ نقد از صندوق.';
const REPAIR = 'تعمیر و نگهداری';

process.env.DATABASE_PATH = tempDatabase('ai-lessons');
process.env.ADMIN_USERNAME = 'ai-lessons-owner';
process.env.ADMIN_PASSWORD = 'Lantern-Quarry-Harbor-4471';
const database = await import('../server/db.js');
const { parseFinancialText } = await import('../shared/parser.js');
const { minimumRoleForRequest } = await import('../server/access.js');
database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);

let books = 0;
const inBook = (callback) => {
  const workspace = database.createWorkspace(owner.id, { name: `دفتر درس‌های AI ${++books}`, profileType: 'business' });
  return database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, async () => {
    database.installChartTemplate();
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all' });
    database.saveAccount({ name: 'جاری ملت', kind: 'bank', bankId: 'mellat', openingBalance: 500_000_000 });
    database.saveAccount({ id: 'cash', name: 'صندوق نقدی', kind: 'cash', openingBalance: 100_000_000 });
    return callback();
  });
};
const amt = (id, value, role, evidence) => ({ id, value, currency: 'toman', role, status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence });
const mv = (id, amountRef, direction, from, to, evidence = '') => ({ id, amountRef, direction, from, to, evidence });
const US = { kind: 'us', name: null };
const CASH = { kind: 'cash', name: 'صندوق' };
const NOBODY = { kind: 'counterparty', name: null };
const model = (partial) => ({
  event: { kind: 'expense', description: '', status: 'done' },
  amounts: [], nonAmountNumbers: [], dates: [], counterparties: [], movements: [],
  subject: { what: null, kind: null, use: 'unknown', delivered: 'unknown', usefulLifeMonths: null, evidence: null },
  conditions: [], ambiguities: [],
  ...partial,
});
const fetcherFor = (said) => async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(said) }] }], usage: { input_tokens: 1, output_tokens: 1 } }) });
let cases = 0;

/** همان مسیر سایت: فهم، جواب سؤال‌ها، ثبت. */
async function viaAi(text, said, answers = {}) {
  const options = { fetcher: fetcherFor(said), env: { OPENAI_API_KEY: 'test-key-not-real', OPENAI_UNDERSTANDING_MODEL: 'test-model' }, now: new Date(NOW) };
  let item = await database.createUnderstandingCase({ text, clientId: `ai-lesson-${++cases}` }, options);
  const open = Object.fromEntries(Object.entries(answers).filter(([id]) => (item.plan?.questions || []).some((question) => question.id === id)));
  if (Object.keys(open).length) item = await database.answerUnderstandingCase(item.id, open, options);
  assert.equal(item.status, 'ready', `پرونده آمادهٔ ثبت نشد: ${JSON.stringify(item.plan?.questions?.map((question) => question.id))} ${JSON.stringify(item.plan?.reasons)}`);
  return database.commitUnderstandingCase(item.id, { now: new Date(NOW) });
}
const switchSaid = (what, category = REPAIR, value = 450_000, evidence = '۴۵۰ هزار تومانی', paidWith = 'نقد از صندوق') => model({
  amounts: [amt('a1', value, 'paid-now', evidence)],
  movements: [mv('m1', 'a1', 'out', CASH, NOBODY, paidWith)],
  subject: { what, kind: 'goods', use: 'internal', category, delivered: 'yes', usefulLifeMonths: null, evidence: what },
});
const lessons = (kind) => database.listAiLessons().lessons.filter((lesson) => !kind || lesson.kind === kind);
const aiLearnings = () => database.getLearnings().filter((item) => item.source === 'ai');
const parsed = (text) => parseFinancialText(text, { learnings: database.getLearnings() }).transactions[0];
/** یک جزءِ ثبت‌شده، همان شکلی که نقشهٔ AI به ثبت می‌دهد. */
const record = (caseId, transcript, components) => database.recordAiLessons({ caseId, transcript, components, now: new Date(NOW) });
const cash = (amount, type, category, extra = {}) => ({ id: 'a1', kind: 'cash', amount, item: { amount, type, category, ...extra } });

test('«کلید برق» بار اول دیده می‌شود، با تأیید دوم یاد گرفته می‌شود و پارسر جملهٔ تازه را درست می‌گیرد', async () => {
  await inBook(async () => {
    assert.equal(parsed(SWITCH).category, 'سایر هزینه‌ها', 'نقطهٔ شروع: پارسر «کلید برق» را نمی‌شناسد');
    const first = await viaAi(SWITCH, switchSaid('کلید برق'));
    assert.equal(first.status, 'posted');
    let [lesson] = lessons('category');
    assert.equal(lesson.keyword, 'کلید برق');
    assert.equal(lesson.category, REPAIR);
    assert.equal(lesson.parserCategory, 'سایر هزینه‌ها');
    assert.equal(lesson.status, 'watching');
    assert.equal(lesson.confirmations, 1);
    assert.deepEqual(aiLearnings(), [], 'از یک بار یاد نمی‌گیرد');
    // اعداد لاتین، جملهٔ دیگر، همان موضوع.
    await viaAi('کلید برق راهرو رو عوض کردیم 300 هزار تومن نقد دادیم', switchSaid('کلید برق', REPAIR, 300_000, '300 هزار تومن', 'نقد دادیم'));
    [lesson] = lessons('category');
    assert.equal(lesson.confirmations, 2);
    assert.equal(lesson.status, 'learned');
    assert.deepEqual(aiLearnings().map((item) => [item.keyword, item.category]), [['کلید برق', REPAIR]]);
    const next = parsed('یه کلید برق دیگه ۲۰۰ هزار تومن خریدیم');
    assert.equal(next.type, 'expense');
    assert.equal(next.category, REPAIR);
    assert.match(next.confidenceDetails.category.reason, /AI/);
  });
});

test('یادگیریِ AI جهت پول را عوض نمی‌کند؛ یادگیریِ دستیِ کاربر همان رفتار قبلی را دارد', () => {
  const said = 'بابت کلید برق ۲۰۰ هزار تومن دریافت کردیم';
  const withSource = (source) => parseFinancialText(said, { learnings: [{ keyword: 'کلید برق', category: REPAIR, source }] }).transactions[0];
  assert.equal(withSource('ai').type, 'income');
  assert.notEqual(withSource('ai').category, REPAIR);
  assert.equal(withSource('manual').category, REPAIR, 'نگاشت تأییدشدهٔ کاربر همچنان از هر قاعده‌ای قوی‌تر است');
});

test('نگاشت مشخص‌تر برنده است، هر کدام که دیرتر ذخیره شده باشد', () => {
  const learnings = [{ keyword: 'برق', category: 'قبوض', source: 'manual' }, { keyword: 'کلید برق', category: REPAIR, source: 'ai' }];
  assert.equal(parseFinancialText('یه کلید برق ۲۰۰ هزار تومن خریدیم', { learnings }).transactions[0].category, REPAIR);
  assert.equal(parseFinancialText('قبض برق ۲ میلیون پرداخت کردیم', { learnings }).transactions[0].category, 'قبوض');
});

test('T18: پارسر هم حالا تعهدِ پرداخت می‌بیند؛ با AI هم‌نظر است و درسی نمی‌ماند', async () => {
  await inBook(async () => {
    assert.equal(parsed(T18).unpaidSignal, true, 'پارسر دیگر خروج نقدی نمی‌سازد (test/burnt-and-unpaid-family.test.js)');
    const posted = await viaAi(T18, model({
      event: { kind: 'obligation', description: '', status: 'done' },
      amounts: [amt('a1', 4_000_000, 'total', '۴ میلیون تومان')],
      movements: [mv('m1', 'a1', 'none', US, NOBODY, 'قراره تا آبان پرداختش کنیم')],
      subject: { what: 'قبض برق', kind: 'service', use: 'internal', category: 'قبوض', delivered: 'yes', usefulLifeMonths: null, evidence: 'قبض برق' },
    }), { 'counterparties.c1': { valueId: 'new' }, 'engine.a1.counterparty': { value: 'اداره برق' } });
    assert.equal(posted.status, 'posted');
    assert.equal(lessons().length, 0);
    assert.deepEqual(aiLearnings(), []);
  });
});

test('هر نوع اختلاف ساختاری علامت خودش را دارد و هیچ‌کدام یادگیری نمی‌سازد', async () => {
  await inBook(async () => {
    const lunch = 'ناهار پرسنل ۲ میلیون نقد دادیم';
    record('c-direction', lunch, [cash(2_000_000, 'income', 'فروش')]);
    record('c-partner', lunch, [cash(2_000_000, 'expense', 'خوراک', { fundedBy: { kind: 'partner', name: 'سعیدی' } })]);
    record('c-transfer', lunch, [{ id: 'a1', kind: 'transfer', amount: 2_000_000 }]);
    record('c-settle', lunch, [{ id: 'a1', kind: 'settlement', amount: 2_000_000 }]);
    record('c-partner-settle', lunch, [{ id: 'a1', kind: 'partner-settlement', amount: 2_000_000 }]);
    record('c-amount', lunch, [cash(20_000_000, 'expense', 'خوراک')]);
    record('c-unpaid', lunch, [{ id: 'a1', kind: 'obligation', amount: 2_000_000, item: { amount: 2_000_000, type: 'expense', category: 'خوراک' } }]);
    record('c-paid', T18, [cash(4_000_000, 'expense', 'قبوض')]);
    const flags = Object.fromEntries(lessons('structural').map((lesson) => [lesson.caseIds[0], lesson.flags.map((flag) => flag.id)]));
    assert.deepEqual(flags, {
      'c-direction': ['direction'], 'c-partner': ['paid-by-other'], 'c-transfer': ['transfer-as-row'],
      'c-settle': ['settlement-as-row'], 'c-partner-settle': ['settlement-as-row'], 'c-amount': ['amount'],
      'c-unpaid': ['cash-for-unpaid'], 'c-paid': ['unpaid-for-paid'],
    });
    const open = lessons('structural').find((lesson) => lesson.caseIds[0] === 'c-unpaid');
    assert.throws(() => database.decideAiLesson(open.id, { decision: 'learn' }), /خودکار یاد گرفته نمی‌شود/);
    assert.equal(database.decideAiLesson(open.id, { decision: 'reviewed' }).status, 'reviewed');
    assert.equal(lessons('category').length, 0);
    assert.deepEqual(aiLearnings(), []);
    for (const lesson of lessons('structural')) assert.ok(lesson.flags.every((flag) => flag.label && flag.label !== flag.id));
  });
});

test('دسته‌ای که موضوعِ یادگرفتنی ندارد: بی‌موضوع، موضوعِ عمومی، یا موضوعی که در جمله نیست', async () => {
  await inBook(async () => {
    const goods = 'پول اجناس رو ۳ میلیون نقد دادیم';
    record('c-no-subject', goods, [cash(3_000_000, 'expense', 'مواد و کالا')]);
    record('c-generic', goods, [cash(3_000_000, 'expense', 'مواد و کالا', { topicLabel: 'اجناس' })]);
    record('c-elsewhere', goods, [cash(3_000_000, 'expense', 'مواد و کالا', { topicLabel: 'پارچه' })]);
    assert.deepEqual(lessons('structural').map((lesson) => lesson.flags.map((flag) => flag.id)), [['category-unlearnable'], ['category-unlearnable'], ['category-unlearnable']]);
    assert.equal(lessons('category').length, 0);
  });
});

test('بی‌درس: پارسری که کارت یا صف باز می‌کرد، هم‌نظری، و دستهٔ عمومیِ AI', async () => {
  await inBook(async () => {
    assert.deepEqual(record('c-settle-card', 'طلب رضایی ۵ میلیون وصول شد', [cash(5_000_000, 'income', 'فروش', { topicLabel: 'طلب رضایی' })]), []);
    assert.deepEqual(record('c-composite', '۲ میلیون نقد و ۳ میلیون چک دادیم', [cash(2_000_000, 'expense', 'مواد و کالا')]), []);
    assert.deepEqual(record('c-agree', 'ناهار پرسنل ۲ میلیون نقد دادیم', [cash(2_000_000, 'expense', 'خوراک', { topicLabel: 'ناهار پرسنل' })]), []);
    assert.deepEqual(record('c-generic-ai', 'قبض برق ۲ میلیون پرداخت کردیم', [cash(2_000_000, 'expense', 'سایر هزینه‌ها', { topicLabel: 'قبض برق' })]), []);
    assert.equal(lessons().length, 0);
  });
});

test('یادگیریِ خودِ کاربر بی‌صدا بازنویسی نمی‌شود؛ فقط با «جایگزین کن»', async () => {
  await inBook(async () => {
    database.saveLearning({ keyword: 'کلید برق', category: 'ملزومات اداری' });
    const text = 'یه کلید برق ۲۰۰ هزار تومن خریدیم';
    record('c1', text, [cash(200_000, 'expense', REPAIR, { topicLabel: 'کلید برق' })]);
    record('c2', text, [cash(200_000, 'expense', REPAIR, { topicLabel: 'کلید برق' })]);
    const [lesson] = lessons('category');
    assert.equal(lesson.status, 'conflict');
    assert.deepEqual(database.getLearnings().map((item) => [item.keyword, item.category, item.source]), [['کلید برق', 'ملزومات اداری', 'manual']]);
    assert.throws(() => database.decideAiLesson(lesson.id, { decision: 'learn' }), (error) => error.code === 'AI_LESSON_CONFLICT');
    assert.equal(database.decideAiLesson(lesson.id, { decision: 'replace' }).status, 'learned');
    assert.deepEqual(database.getLearnings().map((item) => [item.keyword, item.category, item.source]), [['کلید برق', REPAIR, 'ai']]);
  });
});

test('AI همان موضوع را دو جور فهمیده: خودکار یاد گرفته نمی‌شود، تصمیم با انسان', async () => {
  await inBook(async () => {
    const text = 'یه کلید برق ۲۰۰ هزار تومن خریدیم';
    record('c0', text, [cash(200_000, 'expense', 'ملزومات اداری', { topicLabel: 'کلید برق' })]);
    record('c1', text, [cash(200_000, 'expense', REPAIR, { topicLabel: 'کلید برق' })]);
    record('c2', text, [cash(200_000, 'expense', REPAIR, { topicLabel: 'کلید برق' })]);
    const repair = lessons('category').find((lesson) => lesson.category === REPAIR);
    assert.equal(repair.confirmations, 2);
    assert.equal(repair.status, 'watching');
    assert.deepEqual(aiLearnings(), []);
    assert.equal(database.decideAiLesson(repair.id, { decision: 'learn' }).status, 'learned');
    assert.deepEqual(aiLearnings().map((item) => item.category), [REPAIR]);
  });
});

test('یادگیریِ AI که کاربر پاک یا اصلاح کرد، دوباره خودکار برنمی‌گردد', async () => {
  await inBook(async () => {
    const text = 'یه کلید برق ۲۰۰ هزار تومن خریدیم';
    for (const id of ['c1', 'c2']) record(id, text, [cash(200_000, 'expense', REPAIR, { topicLabel: 'کلید برق' })]);
    const [learned] = aiLearnings();
    assert.equal(database.deleteLearning(learned.id), true);
    assert.equal(lessons('category')[0].status, 'dismissed');
    record('c3', text, [cash(200_000, 'expense', REPAIR, { topicLabel: 'کلید برق' })]);
    assert.equal(lessons('category')[0].status, 'dismissed');
    assert.deepEqual(aiLearnings(), []);
    // اصلاح: همان درس در دفتر دیگر، یادگرفته و بعد دستی عوض‌شده.
  });
  await inBook(async () => {
    const text = 'یه کلید برق ۲۰۰ هزار تومن خریدیم';
    for (const id of ['c1', 'c2']) record(id, text, [cash(200_000, 'expense', REPAIR, { topicLabel: 'کلید برق' })]);
    const [learned] = aiLearnings();
    database.updateLearning(learned.id, { keyword: learned.keyword, category: 'ملزومات اداری' });
    assert.equal(lessons('category')[0].status, 'dismissed');
    assert.deepEqual(database.getLearnings().map((item) => [item.category, item.source]), [['ملزومات اداری', 'manual']]);
  });
});

test('«نه، یاد نگیر» روی درسِ یادگرفته، یادگیری را هم برمی‌دارد', async () => {
  await inBook(async () => {
    const text = 'یه کلید برق ۲۰۰ هزار تومن خریدیم';
    for (const id of ['c1', 'c2']) record(id, text, [cash(200_000, 'expense', REPAIR, { topicLabel: 'کلید برق' })]);
    const [lesson] = lessons('category');
    assert.equal(database.decideAiLesson(lesson.id, { decision: 'dismiss' }).status, 'dismissed');
    assert.deepEqual(database.getLearnings(), []);
  });
});

test('هر پرونده یک بار شمرده می‌شود — دوباره ثبت‌کردنِ همان پرونده هم', async () => {
  await inBook(async () => {
    const posted = await viaAi(SWITCH, switchSaid('کلید برق'));
    database.commitUnderstandingCase(posted.id, { now: new Date(NOW) });
    record(posted.id, SWITCH, posted.plan.components);
    assert.equal(lessons('category')[0].confirmations, 1);
  });
});

test('تعداد تأییدِ لازم: ۲ تا ۵، و پایین آوردنش درسِ به‌حدرسیده را همان لحظه یاد می‌گیرد', async () => {
  await inBook(async () => {
    assert.equal(database.aiLessonThreshold(), 2);
    assert.throws(() => database.saveAiLessonThreshold(1), /بین ۲ تا ۵/);
    assert.throws(() => database.saveAiLessonThreshold(6), /بین ۲ تا ۵/);
    database.saveAiLessonThreshold(3);
    const text = 'یه کلید برق ۲۰۰ هزار تومن خریدیم';
    for (const id of ['c1', 'c2']) record(id, text, [cash(200_000, 'expense', REPAIR, { topicLabel: 'کلید برق' })]);
    assert.equal(lessons('category')[0].status, 'watching');
    database.saveAiLessonThreshold(2);
    assert.equal(lessons('category')[0].status, 'learned');
  });
});

test('شکستِ یادگیری هرگز ثبتِ پرونده را برنمی‌گرداند', async () => {
  await inBook(async () => {
    // جدولی که ساخته نمی‌شود (یک view هم‌نام) تا یادگیری حتماً خطا بدهد.
    database.activeWorkspaceDatabase().exec('CREATE VIEW ai_lessons AS SELECT 1 AS id');
    const original = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const posted = await viaAi(T01, switchSaid('کلید برق'));
      assert.equal(posted.status, 'posted');
    } finally { console.warn = original; }
    assert.ok(warnings.some((line) => line.includes('[ai-lessons]')));
  });
});

test('نقش‌ها: دیدن برای همه، تصمیم با حسابدار، آستانه با مدیر', () => {
  // مسیرها بدون پیشوند /api، همان‌طور که میان‌افزار دسترسی می‌بیند.
  assert.equal(minimumRoleForRequest('GET', '/ai-lessons'), 'viewer');
  assert.equal(minimumRoleForRequest('GET', '/ai-lessons/export'), 'viewer');
  assert.equal(minimumRoleForRequest('GET', '/ai-lessons/threshold'), 'viewer');
  assert.equal(minimumRoleForRequest('POST', '/ai-lessons/al-1/decide'), 'accountant');
  assert.equal(minimumRoleForRequest('POST', '/ai-lessons/threshold'), 'manager');
});

test('پشتیبان: درس‌ها همراه دفترند و پشتیبانِ قدیمیِ بی‌درس هم بازیابی می‌شود', async () => {
  await inBook(async () => {
    record('c1', 'یه کلید برق ۲۰۰ هزار تومن خریدیم', [cash(200_000, 'expense', REPAIR, { topicLabel: 'کلید برق' })]);
    const snapshot = database.financialBackupSnapshot();
    assert.equal(snapshot.tables.ai_lessons.length, 1);
    const old = structuredClone(snapshot);
    delete old.tables.ai_lessons;
    database.restoreFinancialSnapshot(old);
    assert.equal(lessons().length, 0);
    database.restoreFinancialSnapshot(snapshot);
    assert.equal(lessons()[0].keyword, 'کلید برق');
  });
});

test('گزارش اختلاف‌ها: بدون نام دفتر و کاربر، با جمله و علامت‌ها', async () => {
  await inBook(async () => {
    record('c1', 'ناهار پرسنل ۲ میلیون نقد دادیم', [cash(2_000_000, 'income', 'فروش')]);
    const report = database.exportAiLessons();
    assert.equal(report.format, 'hesab-yar-ai-lessons');
    assert.deepEqual(report.lessons.map((lesson) => [lesson.kind, lesson.flags, lesson.sample]), [['structural', ['direction'], 'ناهار پرسنل ۲ میلیون نقد دادیم']]);
    assert.doesNotMatch(JSON.stringify(report), /دفتر درس‌های AI|ai-lessons-owner/);
  });
});

test('T01 عیناً: پارسر حالا همان دستهٔ AI را می‌گوید؛ درسی ساخته نمی‌شود', async () => {
  await inBook(async () => {
    assert.equal(parsed(T01).category, REPAIR);
    await viaAi(T01, switchSaid('کلید برق'));
    assert.equal(lessons().length, 0);
  });
});
