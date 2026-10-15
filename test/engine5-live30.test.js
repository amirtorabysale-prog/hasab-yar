import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

/**
 * موتور ۵ — اجرای زندهٔ ۳۰ آزمون روی سایت (۲۲ مهر ۱۴۰۵، `docs/testing/engine5-live-30.json`).
 *
 * هر آزمون خروجیِ واقعیِ مدل روی سایت را (همان برچسب‌ها، همان شاهدها) با جملهٔ
 * کاربر از مسیر واقعی می‌گذراند: اعتبارسنجی، تطبیق حساب، طرح و ثبت. دفترِ آزمون
 * همان حساب‌های دفتر آزمایشی سایت را دارد: صندوق، جاری ملت، جاری سامان و جاری تجارت.
 */

const NOW = '2026-10-14T08:00:00.000Z';
const none = { op: null, of: [] };

process.env.DATABASE_PATH = tempDatabase('engine5-live30');
process.env.ADMIN_USERNAME = 'e5-live-owner';
process.env.ADMIN_PASSWORD = 'e5-live-strong-password-5521';
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser('e5-live-owner', 'e5-live-strong-password-5521');

let counter = 0;
const inFreshWorkspace = (callback) => {
  const workspace = database.createWorkspace(owner.id, { name: `دفتر زندهٔ موتور ۵ — ${++counter}`, profileType: 'business' });
  return database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
};
const amt = (id, value, role, evidence, extra = {}) => ({ id, value, currency: 'toman', role, status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence, ...extra });
const mv = (id, amountRef, direction, from, to, evidence = '') => ({ id, amountRef, direction, from, to, evidence });
const US = { kind: 'us', name: null };
const NOBODY = { kind: 'counterparty', name: null };
const model = (partial) => ({
  event: { kind: 'expense', description: '', status: 'done' },
  amounts: [], nonAmountNumbers: [], dates: [], counterparties: [], movements: [],
  subject: { what: null, kind: null, use: 'unknown', delivered: 'unknown', usefulLifeMonths: null, evidence: null },
  conditions: [], ambiguities: [],
  ...partial,
});
const fetcherFor = (said) => async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(said) }] }], usage: { input_tokens: 1, output_tokens: 1 } }) });

/** همان دفتر آزمایشی سایت: موتور نسخهٔ دو و فهم برای همهٔ گفته‌ها. */
async function live(text, said, { answers = {} } = {}) {
  database.installChartTemplate();
  database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all' });
  for (const [name, bankId] of [['جاری ملت', 'mellat'], ['جاری سامان', 'saman'], ['جاری تجارت', 'tejarat']]) {
    database.saveAccount({ name, kind: 'bank', bankId, openingBalance: 500_000_000 });
  }
  database.saveAccount({ id: 'cash', name: 'صندوق نقدی', kind: 'cash', openingBalance: 100_000_000 });
  const options = { fetcher: fetcherFor(said), env: { OPENAI_API_KEY: 'test-key-not-real', OPENAI_UNDERSTANDING_MODEL: 'test-model' }, now: new Date(NOW) };
  let item = await database.createUnderstandingCase({ text, clientId: `live-${counter}-${Math.random()}` }, options);
  // جوابِ سؤالی که پرونده نپرسیده فرستاده نمی‌شود؛ کاربر هم فقط به سؤالِ باز جواب می‌دهد.
  const open = Object.fromEntries(Object.entries(answers).filter(([id]) => (item.plan?.questions || []).some((question) => question.id === id)));
  if (Object.keys(open).length) item = await database.answerUnderstandingCase(item.id, open, options);
  let posted = null;
  if (item.status === 'ready') {
    database.commitUnderstandingCase(item.id, { now: new Date(NOW) });
    const db = database.activeWorkspaceDatabase();
    posted = {
      lines: db.prepare(`SELECT a.name AS account, l.debit, l.credit FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
        JOIN ledger_accounts a ON a.id=l.account_id WHERE e.source_type NOT IN ('opening','account-opening','opening_balance') ORDER BY e.created_at, e.id, l.debit DESC`).all()
        .map((line) => [line.account, line.debit || -line.credit]),
      schedule: { ...db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS total FROM recognition_schedule_items').get() },
    };
  }
  return { item, posted };
}
const treatments = (item) => (item.plan?.components || []).map((component) => [component.amount, component.preview?.treatment || null, component.category]);
const questions = (item) => (item.plan?.questions || []).map((question) => question.id);

test('زنده S04: «نقد دادیم» با سمتِ «ما»ی بی‌نام، صندوق است — حساب پرسیده نمی‌شود', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await live('هاست و دامنهٔ سایت رو دو ساله ۴ میلیون و ۸۰۰ هزار تومان نقد دادیم', model({
      event: { kind: 'advance-paid', description: '', status: 'done' },
      amounts: [amt('a1', 4_800_000, 'paid-now', '۴ میلیون و ۸۰۰ هزار تومان')],
      movements: [mv('m1', 'a1', 'out', US, NOBODY, 'نقد دادیم')],
      subject: { what: 'هاست و دامنهٔ سایت', kind: 'service', use: 'internal', delivered: 'unknown', usefulLifeMonths: 24, evidence: 'هاست و دامنهٔ سایت' },
      nonAmountNumbers: [{ value: 'دو ساله', role: 'duration', evidence: 'دو ساله' }],
    }));
    assert.deepEqual(questions(item), []);
    assert.equal(item.status, 'ready');
    assert.deepEqual(posted.lines.at(-1), ['صندوق نقدی', -4_800_000]);
    assert.deepEqual(posted.schedule, { count: 24, total: 4_800_000 });
  });
});

test('زنده S19: «هر دو رو نقد دادیم» — بیمهٔ یک‌ساله پیش‌پرداخت و ناهار هزینه، هر دو از صندوق', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await live('بیمه یک‌ساله تجهیزات ۱۲ میلیون و ناهار پرسنل ۲ میلیون، هر دو رو نقد دادیم', model({
      event: { kind: 'advance-paid', description: '', status: 'done' },
      amounts: [amt('a1', 12_000_000, 'paid-now', 'بیمه یک‌ساله تجهیزات ۱۲ میلیون'), amt('a2', 2_000_000, 'paid-now', 'ناهار پرسنل ۲ میلیون')],
      movements: [mv('m1', 'a1', 'out', US, NOBODY, 'نقد دادیم'), mv('m2', 'a2', 'out', US, NOBODY, 'نقد دادیم')],
      subject: { what: 'بیمه تجهیزات', kind: 'service', use: 'long-term', delivered: 'unknown', usefulLifeMonths: null, evidence: 'بیمه یک‌ساله تجهیزات' },
      nonAmountNumbers: [{ value: 'یک‌ساله', role: 'duration', evidence: 'بیمه یک‌ساله تجهیزات ۱۲ میلیون' }],
    }));
    assert.deepEqual(questions(item), []);
    assert.deepEqual(treatments(item).map(([amount, treatment]) => [amount, treatment]), [[12_000_000, 'prepaid-expense'], [2_000_000, 'period-expense']]);
    assert.equal(posted.lines.filter(([account]) => account === 'صندوق نقدی').reduce((sum, [, value]) => sum + value, 0), -14_000_000);
    assert.deepEqual(posted.schedule, { count: 12, total: 12_000_000 });
  });
});

test('زنده S13: «آقای نادری … نقد داد، دوره از اول آبان» — پیش‌دریافت سه‌ماهه در صندوق', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await live('آقای نادری شهریه دوره آموزشی سه ماهه رو ۹ میلیون نقد داد، دوره از اول آبان شروع میشه', model({
      event: { kind: 'advance-paid', description: '', status: 'future' },
      amounts: [amt('a1', 9_000_000, 'paid-now', '۹ میلیون نقد داد')],
      movements: [mv('m1', 'a1', 'in', { kind: 'counterparty', name: 'آقای نادری' }, US, 'آقای نادری شهریه دوره آموزشی سه ماهه رو ۹ میلیون نقد داد')],
      counterparties: [{ id: 'c1', name: 'آقای نادری', role: 'other', evidence: 'آقای نادری' }],
      dates: [{ id: 'd1', role: 'coverage-start', expression: 'از اول آبان', relative: null, jalali: { year: null, month: 8, day: 1 } }],
      subject: { what: 'دوره آموزشی', kind: 'service', use: 'unknown', delivered: 'no', usefulLifeMonths: null, evidence: 'دوره آموزشی سه ماهه' },
      nonAmountNumbers: [{ value: 'سه ماهه', role: 'duration', evidence: 'دوره آموزشی سه ماهه' }],
    }), { answers: { 'counterparties.c1': { valueId: 'new' } } });
    assert.deepEqual(questions(item), []);
    assert.deepEqual(treatments(item).map(([amount, treatment]) => [amount, treatment]), [[9_000_000, 'deferred-revenue']]);
    assert.deepEqual(posted.lines[0], ['صندوق نقدی', 9_000_000]);
    assert.deepEqual(posted.schedule, { count: 3, total: 9_000_000 });
  });
});

test('زنده S20: «۴۰ میلیون از ملت دادیم: ۳۰ … و ۱۰ …» — اجزا حساب کل را می‌گیرند، کل دوباره ثبت نمی‌شود', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await live('۴۰ میلیون از ملت دادیم: ۳۰ میلیون بیمه یک‌ساله کارگاه و ۱۰ میلیون اجاره همین ماه', model({
      event: { kind: 'advance-paid', description: '', status: 'done' },
      amounts: [amt('a1', 40_000_000, 'paid-now', '۴۰ میلیون'), amt('a2', 30_000_000, 'part', '۳۰ میلیون', { partOf: 'a1' }), amt('a3', 10_000_000, 'part', '۱۰ میلیون', { partOf: 'a1' })],
      movements: [mv('m1', 'a1', 'out', US, { kind: 'bank', name: 'ملت' }, 'از ملت دادیم')],
      counterparties: [{ id: 'c1', name: 'ملت', role: 'bank', evidence: 'از ملت' }],
      subject: { what: 'بیمه کارگاه و اجاره همین ماه', kind: 'service', use: 'internal', delivered: 'unknown', usefulLifeMonths: 12, evidence: 'بیمه یک‌ساله کارگاه و ۱۰ میلیون اجاره همین ماه' },
      nonAmountNumbers: [{ value: 'یک‌ساله', role: 'duration', evidence: 'بیمه یک‌ساله' }, { value: 'همین ماه', role: 'other', evidence: 'اجاره همین ماه' }],
    }));
    assert.deepEqual(questions(item), []);
    assert.deepEqual(treatments(item).map(([amount, treatment, category]) => [amount, treatment, category]), [[30_000_000, 'prepaid-expense', 'بیمه'], [10_000_000, 'period-expense', 'اجاره']]);
    assert.equal(posted.lines.filter(([account]) => account === 'جاری ملت').reduce((sum, [, value]) => sum + value, 0), -40_000_000);
    assert.deepEqual(posted.schedule, { count: 12, total: 30_000_000 });
  });
});

test('زنده S17: «پول پیش انبار … به آقای رستمی» ودیعهٔ قابل استرداد است، نه پیش‌پرداخت خرید', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await live('پول پیش انبار ۸۰ میلیون به آقای رستمی از ملت دادیم', model({
      event: { kind: 'advance-paid', description: '', status: 'done' },
      amounts: [amt('a1', 80_000_000, 'paid-now', '۸۰ میلیون')],
      movements: [mv('m1', 'a1', 'out', { kind: 'bank', name: 'ملت' }, { kind: 'counterparty', name: 'آقای رستمی' }, 'از ملت دادیم')],
      counterparties: [{ id: 'c1', name: 'آقای رستمی', role: 'other', evidence: 'آقای رستمی' }, { id: 'c2', name: 'ملت', role: 'bank', evidence: 'ملت' }],
      subject: { what: 'انبار', kind: 'asset', use: 'long-term', delivered: 'unknown', usefulLifeMonths: null, evidence: 'پول پیش انبار' },
    }), { answers: { 'counterparties.c1': { valueId: 'new' } } });
    assert.deepEqual(treatments(item).map(([amount, treatment]) => [amount, treatment]), [[80_000_000, 'refundable-deposit']]);
    assert.match(posted.lines[0][0], /ودیعه/);
    assert.equal(posted.schedule.count, 0);
  });
});

test('زنده S11 و S14: اجارهٔ گرفته‌شده از مستاجر «درآمد اجاره» است، نه «سایر درآمدها»', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await live('مستاجر طبقه دوم، اجاره شش ماه آینده رو ۴۸ میلیون به حساب ملت ریخت', model({
      event: { kind: 'advance-received', description: '', status: 'done' },
      amounts: [amt('a1', 48_000_000, 'received-now', '۴۸ میلیون')],
      movements: [mv('m1', 'a1', 'in', { kind: 'counterparty', name: 'مستاجر طبقه دوم' }, { kind: 'bank', name: 'ملت' }, 'به حساب ملت ریخت')],
      counterparties: [{ id: 'c1', name: 'مستاجر طبقه دوم', role: 'customer', evidence: 'مستاجر طبقه دوم' }],
      subject: { what: 'اجاره شش ماه آینده', kind: 'service', use: 'internal', delivered: 'unknown', usefulLifeMonths: null, evidence: 'اجاره شش ماه آینده' },
      nonAmountNumbers: [{ value: 'شش ماه', role: 'duration', evidence: 'شش ماه آینده' }],
    }), { answers: { 'counterparties.c1': { valueId: 'new' } } });
    assert.deepEqual(treatments(item), [[48_000_000, 'deferred-revenue', 'درآمد اجاره']]);
    assert.deepEqual(posted.schedule, { count: 6, total: 48_000_000 });
  });
  await inFreshWorkspace(async () => {
    const { item } = await live('مستاجر اجاره مهر مغازه رو ۸ میلیون به ملت ریخت', model({
      event: { kind: 'advance-received', description: '', status: 'done' },
      amounts: [amt('a1', 8_000_000, 'received-now', '۸ میلیون')],
      movements: [mv('m1', 'a1', 'in', { kind: 'counterparty', name: 'مستاجر' }, { kind: 'bank', name: 'ملت' }, 'مستاجر ... ۸ میلیون به ملت ریخت')],
      counterparties: [{ id: 'c1', name: 'مستاجر', role: 'customer', evidence: 'مستاجر' }, { id: 'c2', name: 'ملت', role: 'bank', evidence: 'ملت' }],
      dates: [{ id: 'd1', role: 'coverage-start', expression: 'مهر', relative: null, jalali: { year: null, month: 7, day: null } }, { id: 'd2', role: 'coverage-end', expression: 'مهر', relative: null, jalali: { year: null, month: 7, day: null } }],
      subject: { what: 'اجاره مغازه', kind: 'service', use: 'internal', delivered: 'unknown', usefulLifeMonths: null, evidence: 'اجاره مهر مغازه' },
    }));
    assert.deepEqual(treatments(item), [[8_000_000, 'recognized-revenue', 'درآمد اجاره']]);
  });
});

test('زنده S08: «اجاره ماهی ۸ میلیون، سه ماه آینده انبار رو یک‌جا ۲۴ میلیون» — پیش‌پرداخت اجاره، نه «مواد و کالا»', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await live('اجاره ماهی ۸ میلیون، سه ماه آینده انبار رو یک‌جا ۲۴ میلیون از سامان دادیم', model({
      event: { kind: 'advance-paid', description: '', status: 'done' },
      amounts: [amt('a1', 24_000_000, 'paid-now', 'یک‌جا ۲۴ میلیون'), amt('a2', 8_000_000, 'unit-price', 'ماهی ۸ میلیون', { status: 'context' })],
      movements: [mv('m1', 'a1', 'out', US, { kind: 'counterparty', name: 'سامان' }, 'از سامان دادیم')],
      counterparties: [{ id: 'c1', name: 'سامان', role: 'landlord', evidence: 'از سامان' }],
      subject: { what: 'انبار', kind: 'asset', use: 'internal', delivered: 'unknown', usefulLifeMonths: null, evidence: 'انبار' },
      nonAmountNumbers: [{ value: '3', role: 'duration', evidence: 'سه ماه آینده' }],
    }));
    assert.deepEqual(treatments(item), [[24_000_000, 'prepaid-expense', 'اجاره']]);
    assert.equal(posted.lines.filter(([account]) => account === 'جاری سامان').reduce((sum, [, value]) => sum + value, 0), -24_000_000);
    assert.deepEqual(posted.schedule, { count: 3, total: 24_000_000 });
  });
});

test('زنده S26: بیعانهٔ سفارشِ کالای تحویل‌نشده که مشتری به ملت ریخت، پیش‌دریافت است — نه درآمد', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await live('شرکت بتا ۱۵ میلیون بیعانهٔ سفارش کالا به ملت ریخت، جنس ماه بعد تحویل میشه', model({
      event: { kind: 'advance-paid', description: 'شرکت بتا ۱۵ میلیون بیعانهٔ سفارش کالا به ملت ریخت، جنس ماه بعد تحویل میشه', status: 'future' },
      amounts: [amt('a1', 15_000_000, 'deposit', '۱۵ میلیون بیعانهٔ سفارش کالا')],
      movements: [mv('m1', 'a1', 'out', { kind: 'us', name: 'شرکت بتا' }, { kind: 'counterparty', name: 'ملت' }, '۱۵ میلیون بیعانهٔ سفارش کالا به ملت ریخت')],
      subject: { what: 'سفارش کالا', kind: 'goods', use: 'resale', delivered: 'no', usefulLifeMonths: null, evidence: 'سفارش کالا' },
    }), { answers: { 'counterparties.c-m1-from': { valueId: 'new' } } });
    assert.notEqual(treatments(item)[0]?.[1], 'recognized-revenue', JSON.stringify([treatments(item), item.plan?.questions, item.plan?.reasons]));
    if (posted) assert.equal(posted.lines.some(([account, value]) => /درآمد|فروش/.test(account) && value < 0), false, JSON.stringify(posted.lines));
  });
});

// ---------------------------------------------------------------------------
// مسیر بی‌AI — همان جمله‌ها در دفتری که فهم را فقط برای گفتهٔ مرکب روشن کرده
// (دفتر اصلی سایت): گفتهٔ ساده از پارسر و موتور می‌گذرد.
// ---------------------------------------------------------------------------

const { runVoice } = await import('./helpers/voicePipeline.js');
const { extractAmounts, hasCompositeAmounts, PAYER_GAVE_UNCLEAR } = await import('../shared/parser.js');
const roles = (item) => (item.plan?.lines || []).map((line) => [line.debit ? 'Dr' : 'Cr', line.role]);

test('بی‌AI: پولی که طرف مقابل «به (حساب) ملت/سامان ریخت» آمده است، حتی کنار دستهٔ هزینه', () => {
  for (const text of [
    'مستاجر طبقه دوم، اجاره شش ماه آینده رو ۴۸ میلیون به حساب ملت ریخت',
    'مستاجر طبقه دوم واحد شمالی ساختمان اداری خیابان آزادی، اجاره شش ماه آینده رو ۴۸ میلیون به حساب ملت ریخت',
    'شرکت بتا ۱۵ میلیون بیعانهٔ سفارش کالا به ملت ریخت، جنس ماه بعد تحویل میشه',
    'شرکت بتا ۱۵ میلیون بیعانه سفارش کالا رو به سامان واریز کرد',
  ]) {
    const items = runVoice(text, { today: NOW }).items;
    assert.equal(items.length, 1, text);
    assert.ok(!roles(items[0]).some(([side, role]) => side === 'Cr' && role === 'cash'), `${text}: ${JSON.stringify(roles(items[0]))}`);
    assert.ok(!roles(items[0]).some(([side, role]) => side === 'Dr' && ['prepaid-asset', 'supplier-advance'].includes(role)), text);
  }
  assert.deepEqual(roles(runVoice('شرکت بتا ۱۵ میلیون بیعانهٔ سفارش کالا به ملت ریخت، جنس ماه بعد تحویل میشه', { today: NOW }).items[0]),
    [['Dr', 'cash'], ['Cr', 'customer-advance']]);
  // منفی: پرداختِ اول‌شخص به بانک دیگری همان پرداخت است.
  const [ours] = runVoice('اجاره شش ماه آینده رو ۴۸ میلیون از حساب ملت دادیم', { today: NOW }).items;
  assert.deepEqual(roles(ours), [['Dr', 'prepaid-asset'], ['Cr', 'cash']]);
});

test('بی‌AI: «آقای نادری شهریه رو … نقد داد» جهت روشن ندارد و پیش‌پرداخت از صندوق نمی‌شود', () => {
  const [item] = runVoice('آقای نادری شهریه دوره آموزشی سه ماهه رو ۹ میلیون نقد داد، دوره از اول آبان شروع میشه', { today: NOW }).items;
  assert.equal(item.outcome, 'accountant');
  assert.match(item.routing.reasons[0], /جهت پول روشن نیست/);
  assert.ok(PAYER_GAVE_UNCLEAR);
  // منفی: بی دستهٔ هزینه دریافت است؛ «به ما داد» دریافت است؛ پرداختِ قبض و فعل اول‌شخص همان قبلی‌اند.
  assert.equal(runVoice('آقای نادری ۹ میلیون نقد داد', { today: NOW }).items[0].kind, 'cash-income');
  assert.equal(runVoice('آقای نادری شهریه رو ۹ میلیون به ما داد', { today: NOW }).items[0].kind, 'cash-income');
  assert.equal(runVoice('آقای رضایی قبض برق رو پرداخت کرد ۲ میلیون', { today: NOW }).items[0].outcome, 'post');
  assert.equal(runVoice('شهریه دوره آموزشی ۹ میلیون دادیم', { today: NOW }).items[0].outcome, 'post');
  assert.equal(runVoice('به آقای نادری ۹ میلیون شهریه دادیم', { today: NOW }).items[0].kind, 'cash-expense');
});

test('بی‌AI: کلی که اجزایش پشتش آمده، یک پرونده است — نه سه ردیف ۴۰ و ۳۰ و ۱۰', () => {
  assert.equal(hasCompositeAmounts('۴۰ میلیون از ملت دادیم: ۳۰ میلیون بیمه یک‌ساله کارگاه و ۱۰ میلیون اجاره همین ماه'), true);
  assert.equal(hasCompositeAmounts('۱۰۰ میلیون دادیم، ۶۰ میلیون رهن و ۳۰ میلیون اجاره و ۱۰ میلیون کمیسیون'), true);
  assert.equal(runVoice('۴۰ میلیون از ملت دادیم: ۳۰ میلیون بیمه یک‌ساله کارگاه و ۱۰ میلیون اجاره همین ماه', { today: NOW }).path, 'composite-review');
  // منفی: دو پرداختِ جدا، و سه مبلغی که اولی جمعِ بقیه نیست.
  assert.equal(hasCompositeAmounts('۱۰ میلیون اجاره و ۵ میلیون شارژ دادیم'), false);
  assert.equal(hasCompositeAmounts('۱۰ میلیون اجاره، ۵ میلیون شارژ و ۲ میلیون قبض دادیم'), false);
});

test('بی‌AI: «هر دو»، «هر سه تا» شمار است، نه مبلغ دوتومانی', () => {
  const amounts = (text) => extractAmounts(text).spans.map((span) => span.amount);
  assert.deepEqual(amounts('بیمه یک‌ساله تجهیزات ۱۲ میلیون و ناهار پرسنل ۲ میلیون، هر دو رو نقد دادیم'), [12_000_000, 2_000_000]);
  assert.deepEqual(amounts('هر سه تا رو ۹ میلیون خریدیم'), [9_000_000]);
  // منفی: «هر دو میلیون» خودِ مبلغ است.
  assert.deepEqual(amounts('هر دو میلیون رو دادیم'), [2_000_000]);
  assert.equal(runVoice('بیمه یک‌ساله تجهیزات ۱۲ میلیون و ناهار پرسنل ۲ میلیون، هر دو رو نقد دادیم', { today: NOW }).items.length, 2);
});
