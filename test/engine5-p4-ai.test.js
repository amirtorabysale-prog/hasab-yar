import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
import { validateUnderstanding } from '../shared/eventUnderstanding.js';

/**
 * موتور ۵ — مسیر فهم با AI برای پیش‌پرداختِ خدمتِ دوره‌دار و آینه‌اش (پیش‌دریافت).
 *
 * هر آزمون خروجیِ یک مدل را (برچسب‌هایی که مدل واقعی یا محتمل می‌دهد) با جملهٔ
 * کاربر از مسیر واقعی می‌گذراند: اعتبارسنجی، طرح، سؤال، جواب و ثبت در دفتر.
 * برچسب مدل حدس است؛ آزمون می‌گوید سرور با همان برچسب چه می‌کند. امروز ۱۸ مهر ۱۴۰۵.
 */
const NOW = '2026-10-10T00:00:00.000Z';
const none = { op: null, of: [] };

process.env.DATABASE_PATH = tempDatabase('engine5-p4-ai');
process.env.ADMIN_USERNAME = 'e5-ai-owner';
process.env.ADMIN_PASSWORD = 'e5-ai-strong-password-5521';
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser('e5-ai-owner', 'e5-ai-strong-password-5521');

let counter = 0;
const inFreshWorkspace = (callback) => {
  const workspace = database.createWorkspace(owner.id, { name: `دفتر موتور ۵ — ${++counter}`, profileType: 'business' });
  return database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
};

const amt = (id, role, evidence, extra = {}) => ({ id, value: null, currency: null, role, status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence, ...extra });
const mv = (id, amountRef, direction, from, to, evidence = '') => ({ id, amountRef, direction, from, to, evidence });
const BANK = { kind: 'bank', name: 'تجارت' };
const UNKNOWN = { kind: 'unknown', name: null };
const service = (what) => ({ what, kind: 'service', use: 'internal', delivered: 'unknown', usefulLifeMonths: null, evidence: null });
const model = (partial) => ({
  event: { kind: 'expense', description: '', status: 'done' },
  amounts: [], nonAmountNumbers: [], dates: [], counterparties: [], movements: [],
  subject: { what: null, kind: null, use: 'unknown', delivered: 'unknown', usefulLifeMonths: null, evidence: null },
  conditions: [], ambiguities: [],
  ...partial,
});
const fetcherFor = (said) => async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(said) }] }], usage: { input_tokens: 1, output_tokens: 1 } }) });

/**
 * یک جمله با خروجی مدل، از ساختِ پرونده تا جواب‌ها و ثبت. `answers` به ترتیب
 * فرستاده می‌شوند؛ «$tejarat» و «$cash» شناسهٔ حساب واقعی می‌شوند.
 */
async function understandCase(text, said, { answers = [], now = NOW, commit = true } = {}) {
  database.installChartTemplate();
  database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all' });
  const accounts = {
    tejarat: database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 500_000_000 }),
    cash: database.saveAccount({ name: 'صندوق', kind: 'cash', openingBalance: 500_000_000 }),
  };
  const options = { fetcher: fetcherFor(said), env: { OPENAI_API_KEY: 'test-key-not-real', OPENAI_UNDERSTANDING_MODEL: 'test-model' }, now: new Date(now) };
  let item = await database.createUnderstandingCase({ text, clientId: `e5-${counter}-${Math.random()}` }, options);
  const resolve = (value) => (value === '$tejarat' ? { valueId: accounts.tejarat.id } : value === '$cash' ? { valueId: accounts.cash.id } : value);
  for (const answer of answers) {
    item = await database.answerUnderstandingCase(item.id, Object.fromEntries(Object.entries(answer).map(([key, value]) => [key, resolve(value)])), options);
  }
  let posted = null;
  if (commit && item.status === 'ready') {
    database.commitUnderstandingCase(item.id, { now: new Date(now) });
    posted = ledgerNow();
  }
  return { item, posted, accounts, options };
}

function ledgerNow() {
  const db = database.activeWorkspaceDatabase();
  const lines = db.prepare(`SELECT a.name AS account, l.debit, l.credit FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
    JOIN ledger_accounts a ON a.id=l.account_id WHERE e.source_type NOT IN ('opening','account-opening') ORDER BY e.created_at, e.id, l.debit DESC`).all();
  const schedule = db.prepare('SELECT period_key, amount FROM recognition_schedule_items ORDER BY period_key').all();
  return {
    lines: lines.map((line) => [line.account, line.debit || -line.credit]),
    schedule,
    scheduled: schedule.reduce((sum, row) => sum + row.amount, 0),
  };
}

const components = (item) => (item.plan?.components || []).map((component) => ({ amount: component.amount, treatment: component.preview?.treatment || null }));
const questionIds = (item) => (item.plan?.questions || []).map((question) => question.id);
const debitOf = (posted, pattern) => posted.lines.filter(([account, value]) => pattern.test(account) && value > 0).reduce((sum, [, value]) => sum + value, 0);
const creditOf = (posted, pattern) => -posted.lines.filter(([account, value]) => pattern.test(account) && value < 0).reduce((sum, [, value]) => sum + value, 0);

// ---------------------------------------------------------------------------
// ۱. نرخِ دوره کنار کل، پرداخت نیست؛ نرخی که فعل پرداختِ خودش را دارد، هست.
// ---------------------------------------------------------------------------

const INSURANCE = 'بیمه یک ساله انبار رو ۱۲ میلیون به بیمه دی از تجارت دادیم، ماهی ۱ میلیون';
const USER_SENTENCE = 'پیش پرداخت بیمه اتش سوزی به مبلغ 12 میلیون به بیمه دی بابت بیمه انبار .تایم پوشش 1 ساله ماهیانه 1 میلیون .از حساب تجارت';
const insurerMove = [mv('m1', 'a1', 'out', BANK, { kind: 'counterparty', name: 'بیمه دی' }, 'از تجارت دادیم')];

test('نرخ با هر برچسبی کنار کل پرداخت نیست: یک پیش‌پرداخت با ۱۲ قسط، بی‌سؤال حساب برای نرخ', async () => {
  const family = [
    ['نرخ «سایر» انجام‌شده', INSURANCE, [amt('a1', 'paid-now', '۱۲ میلیون'), amt('a2', 'other', 'ماهی ۱ میلیون')], insurerMove, 12_000_000],
    ['نرخ «کارمزد» با جابه‌جایی ساختگی', INSURANCE, [amt('a1', 'paid-now', '۱۲ میلیون'), amt('a2', 'fee', 'ماهی ۱ میلیون')], [...insurerMove, mv('m2', 'a2', 'out', BANK, UNKNOWN)], 12_000_000],
    ['کل + نرخ «پرداخت‌شده»', INSURANCE, [amt('a1', 'total', '۱۲ میلیون'), amt('a2', 'paid-now', 'ماهی ۱ میلیون')], insurerMove, 12_000_000],
    ['کل + نرخ «جزء» وصل به کل', INSURANCE, [amt('a1', 'total', '۱۲ میلیون'), amt('a2', 'part', 'ماهی ۱ میلیون', { partOf: 'a1' })], insurerMove, 12_000_000],
    ['جملهٔ واقعی کاربر، نرخ «ودیعه»', USER_SENTENCE, [amt('a1', 'paid-now', 'به مبلغ 12 میلیون'), amt('a2', 'deposit', 'ماهیانه 1 میلیون')], [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از حساب تجارت')], 12_000_000],
    ['اشتراک، نرخ بعد از فعل با جابه‌جایی', 'اشتراک یک ساله نرم افزار ۲۴ میلیون از تجارت پرداخت کردیم ماهانه ۲ میلیون',
      [amt('a1', 'paid-now', '۲۴ میلیون'), amt('a2', 'paid-now', 'ماهانه ۲ میلیون')], [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت پرداخت کردیم'), mv('m2', 'a2', 'out', BANK, UNKNOWN)], 24_000_000],
    ['نرخ پس از مبلغ «در ماه»', 'اجاره شش ماه آینده دفتر رو ۳۰ میلیون از تجارت دادیم، ۵ میلیون در ماه',
      [amt('a1', 'paid-now', '۳۰ میلیون'), amt('a2', 'other', '۵ میلیون در ماه')], [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت دادیم')], 30_000_000],
  ];
  for (const [name, text, amounts, movements, amount] of family) {
    await inFreshWorkspace(async () => {
      const { item, posted } = await understandCase(text, model({ amounts, movements, subject: service('بیمه انبار') }));
      assert.equal(item.status, 'ready', `${name}: ${JSON.stringify(item.plan?.questions)}`);
      assert.deepEqual(components(item).map((c) => c.amount), [amount], name);
      assert.equal(components(item)[0].treatment, 'prepaid-expense', name);
      assert.equal(debitOf(posted, /پیش‌پرداخت/), amount, name);
      assert.equal(creditOf(posted, /تجارت/), amount, `${name}: فقط همان یک مبلغ از بانک رفت`);
      assert.equal(posted.scheduled, amount, `${name}: جدول شناسایی دقیقاً همان مبلغ`);
    });
  }
});

test('آینه: پیش‌دریافت اجاره با نرخ ماهانه — کل ۳۰ میلیون دریافت می‌شود، نه نرخ ۵ میلیونی', async () => {
  await inFreshWorkspace(async () => {
    const { item } = await understandCase('مستاجر اجاره ۶ ماه رو یکجا ۳۰ میلیون به حساب تجارت واریز کرد، ماهی ۵ میلیون', model({
      event: { kind: 'advance-received', description: 'اجاره', status: 'done' },
      amounts: [amt('a1', 'total', '۳۰ میلیون'), amt('a2', 'received-now', 'ماهی ۵ میلیون')],
      movements: [mv('m1', 'a1', 'in', { kind: 'counterparty', name: 'مستاجر' }, BANK, 'به حساب تجارت واریز کرد')],
      counterparties: [{ id: 'c1', name: 'مستاجر', role: 'customer', evidence: 'مستاجر' }],
      subject: service('اجاره مغازه'),
    }), { commit: false });
    assert.deepEqual(components(item).map((c) => c.amount), [30_000_000]);
  });
});

test('نرخی که فعل پرداختِ خودش را دارد پرداخت است، با هر برچسبی؛ قسطِ وام و فعلِ مشترک نه', async () => {
  const SAID = 'ودیعه ۵۰ میلیون دادیم و اجاره ماهانه ۵ میلیون هم دادیم، هر دو از تجارت';
  for (const role of ['unit-price', 'installment', 'paid-now']) {
    await inFreshWorkspace(async () => {
      const { item } = await understandCase(SAID, model({
        event: { kind: 'deposit', description: 'ودیعه و اجاره', status: 'done' },
        amounts: [amt('a1', 'deposit', 'ودیعه ۵۰ میلیون'), amt('a2', role, 'اجاره ماهانه ۵ میلیون')],
        movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'ودیعه ۵۰ میلیون دادیم'), mv('m2', 'a2', 'out', BANK, UNKNOWN, 'اجاره ماهانه ۵ میلیون هم دادیم')],
      }), { commit: false });
      assert.deepEqual(components(item).map((c) => c.amount), [50_000_000, 5_000_000], role);
    });
  }
  // منفی: فعلِ آخرِ جمله فعلِ مشترک است؛ نرخِ بی‌«هم» پرداخت دوم نمی‌شود.
  const shared = validateUnderstanding(model({
    amounts: [amt('a1', 'paid-now', '۱۲ میلیون'), amt('a2', 'unit-price', 'ماهیانه ۱ میلیون', { status: 'context' })],
    movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت پرداخت شد')],
  }), { text: 'بیمه یک ساله انبار ۱۲ میلیون، ماهیانه ۱ میلیون از تجارت پرداخت شد', now: new Date(NOW) });
  assert.equal(shared.understanding.amounts.find((a) => a.id === 'a2').status, 'context');
  // منفی: قسطِ وام قاعدهٔ نرخ نیست؛ اصل و سودش با حسابدار است.
  const loan = validateUnderstanding(model({
    event: { kind: 'loan-repayment', description: 'قسط وام', status: 'done' },
    amounts: [amt('a1', 'installment', 'قسط ماهانه وام ۵ میلیون'), amt('a2', 'prior-balance', 'کل وام ۱۰۰ میلیون', { status: 'context' })],
    movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت دادیم')],
  }), { text: 'قسط ماهانه وام ۵ میلیون از تجارت دادیم، کل وام ۱۰۰ میلیون', now: new Date(NOW) });
  assert.equal(loan.understanding.amounts.find((a) => a.id === 'a1').role, 'installment');
});

test('منفی: تقسیمِ واقعی بی‌واژهٔ نرخ دست نمی‌خورد — ۴ میلیون پرداخت، ۸ میلیون آینده', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await understandCase('تعمیر دستگاه ۱۲ میلیون شد، ۴ میلیونش رو از تجارت دادیم بقیه رو ماه بعد میدیم', model({
      amounts: [amt('a1', 'total', '۱۲ میلیون'), amt('a2', 'paid-now', '۴ میلیونش', { partOf: 'a1' }),
        amt('a3', 'future-payment', 'بقیه رو', { value: 8_000_000, partOf: 'a1', basis: 'computed', computedFrom: { op: 'difference', of: ['a1', 'a2'] }, status: 'future' })],
      movements: [mv('m1', 'a2', 'out', BANK, UNKNOWN, 'از تجارت دادیم')],
    }));
    assert.deepEqual(components(item).map((c) => c.amount), [4_000_000]);
    assert.equal(creditOf(posted, /تجارت/), 4_000_000);
  });
});

// ---------------------------------------------------------------------------
// ۲. «ودیعه» فقط وقتی ودیعه است که شاهدِ مبلغ بگوید؛ برگشت‌پذیری را جمله می‌گوید.
// ---------------------------------------------------------------------------

const party = (name, role = 'supplier') => [{ id: 'c1', name, role, evidence: name }];
const depositModel = (evidence, role, extra = {}) => model({
  event: { kind: 'deposit', description: '', status: 'done' },
  amounts: [amt('a1', role, evidence)],
  movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت')],
  ...extra,
});

test('برچسب رویدادِ «ودیعه» بی‌واژهٔ ودیعه: بیمه، اجاره و اشتراک پیش‌پرداخت با جدول ماهانه‌اند', async () => {
  for (const [text, evidence, role, extra, amount, months] of [
    ['بیمه یک ساله انبار رو ۱۲ میلیون به بیمه دی از تجارت دادیم، ماهی یک میلیون', '۱۲ میلیون', 'paid-now', { counterparties: party('بیمه دی'), subject: service('بیمه انبار') }, 12_000_000, 12],
    ['اجاره سه ماه آینده دفتر رو ۱۸ میلیون پیش پیش به آقای رضایی از تجارت دادیم', '۱۸ میلیون', 'total', { counterparties: party('آقای رضایی'), subject: service('اجاره دفتر') }, 18_000_000, 3],
    ['اشتراک یک ساله نرم افزار ۲۴ میلیون از تجارت پرداخت کردیم', '۲۴ میلیون', 'paid-now', { subject: service('اشتراک نرم افزار') }, 24_000_000, 12],
  ]) {
    await inFreshWorkspace(async () => {
      const { item, posted } = await understandCase(text, depositModel(evidence, role, extra));
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify(item.plan?.questions)}`);
      assert.equal(components(item)[0].treatment, 'prepaid-expense', text);
      assert.equal(debitOf(posted, /ودیعه/), 0, `${text}: ودیعهٔ قابل استرداد ساخته نشد`);
      assert.equal(posted.schedule.length, months, text);
      assert.equal(posted.scheduled, amount, text);
    });
  }
});

test('رهن و اجارهٔ مهر در یک جمله: اجارهٔ مهر هزینهٔ دوره است، رهن استردادش پرسیده می‌شود', async () => {
  await inFreshWorkspace(async () => {
    const { item } = await understandCase('۳۰ میلیون رهن و ۶ میلیون اجاره مهر به آقای رضایی از تجارت دادیم', model({
      event: { kind: 'deposit', description: '', status: 'done' },
      amounts: [amt('a1', 'deposit', '۳۰ میلیون رهن'), amt('a2', 'deposit', '۶ میلیون اجاره مهر')],
      movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت'), mv('m2', 'a2', 'out', BANK, UNKNOWN, 'از تجارت')],
      counterparties: party('آقای رضایی'),
    }), { commit: false });
    assert.deepEqual(questionIds(item), ['engine.a1.refundable']);
    assert.equal(components(item).find((c) => c.amount === 6_000_000).treatment, 'period-expense');
  });
});

test('یک مبلغ برای ودیعه و اجاره با هم: سهم‌ها گفته نشده، حسابدار — نه ودیعهٔ کامل', async () => {
  for (const kind of ['deposit', 'expense']) {
    await inFreshWorkspace(async () => {
      const { item, posted } = await understandCase('۳۶ میلیون بابت ودیعه و اجاره مهر به آقای رضایی از تجارت دادیم', model({
        event: { kind, description: '', status: 'done' },
        amounts: [amt('a1', 'paid-now', '۳۶ میلیون بابت ودیعه و اجاره مهر')],
        movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت')], counterparties: party('آقای رضایی'),
      }));
      assert.equal(item.status, 'needs-accountant', kind);
      assert.equal(posted, null, kind);
    });
  }
});

test('ودیعه/رهن/سپرده بی‌واژهٔ برگشت، استرداد را می‌پرسد؛ با «پس می‌گیریم» نه', async () => {
  for (const [text, evidence, name] of [
    ['ودیعه اجاره دفتر ۵۰ میلیون به آقای رضایی از تجارت دادیم', 'ودیعه اجاره دفتر ۵۰ میلیون', 'آقای رضایی'],
    ['رهن دفتر ۱۰۰ میلیون به آقای رضایی از تجارت دادیم', 'رهن دفتر ۱۰۰ میلیون', 'آقای رضایی'],
    ['سپرده ۲۰ میلیون بابت قرارداد پیمانکاری به شرکت آلفا از تجارت دادیم', 'سپرده ۲۰ میلیون', 'شرکت آلفا'],
  ]) {
    await inFreshWorkspace(async () => {
      const first = await understandCase(text, depositModel(evidence, 'deposit', { counterparties: party(name) }), { commit: false });
      assert.deepEqual(questionIds(first.item), ['engine.a1.refundable'], text);
      const answered = await database.answerUnderstandingCase(first.item.id, { 'engine.a1.refundable': { value: true } }, first.options);
      assert.equal(components(answered)[0].treatment, 'refundable-deposit', text);
    });
  }
  await inFreshWorkspace(async () => {
    const { item } = await understandCase('ودیعه اجاره دفتر ۵۰ میلیون به آقای رضایی از تجارت دادیم که آخر قرارداد پس می‌گیریم',
      depositModel('ودیعه اجاره دفتر ۵۰ میلیون', 'deposit', { counterparties: party('آقای رضایی') }), { commit: false });
    assert.ok(!questionIds(item).includes('engine.a1.refundable'));
    assert.equal(components(item)[0].treatment, 'refundable-deposit');
  });
});

test('ودیعه یا رهنی که به ما رسیده درآمد نیست: حسابدار؛ «سود سپرده» درآمد می‌ماند', async () => {
  for (const [text, evidence, kind] of [
    ['آقای کریمی مستاجر ۵۰ میلیون ودیعه به حساب تجارت واریز کرد', '۵۰ میلیون ودیعه', 'income'],
    ['۵۰ میلیون رهن مغازه رو از آقای کریمی گرفتیم، به تجارت ریخت', '۵۰ میلیون رهن مغازه', 'deposit'],
    ['آقای کریمی ۵۰ میلیون واریز کرد بابت رهن مغازه', '۵۰ میلیون', 'income'],
  ]) {
    await inFreshWorkspace(async () => {
      const { item, posted } = await understandCase(text, model({
        event: { kind, description: '', status: 'done' },
        amounts: [amt('a1', 'received-now', evidence)],
        movements: [mv('m1', 'a1', 'in', { kind: 'counterparty', name: 'آقای کریمی' }, BANK, 'واریز')],
        counterparties: party('آقای کریمی', 'customer'),
      }));
      assert.equal(item.status, 'needs-accountant', text);
      assert.equal(posted, null, `${text}: درآمدی ساخته نشد`);
    });
  }
  await inFreshWorkspace(async () => {
    const { posted } = await understandCase('سود سپرده ۲ میلیون به حساب تجارت واریز شد', model({
      event: { kind: 'income', description: '', status: 'done' },
      amounts: [amt('a1', 'received-now', '۲ میلیون')], movements: [mv('m1', 'a1', 'in', UNKNOWN, BANK, 'واریز شد')],
    }));
    assert.equal(creditOf(posted, /درآمد/), 2_000_000);
  });
});

// ---------------------------------------------------------------------------
// ۳. پایان پوششِ ماهِ نام‌برده به آغازش بسته است، نه به امروز.
// ---------------------------------------------------------------------------

const coverage = (start, end, startJalali = {}, endJalali = {}) => [
  { id: 'd1', role: 'coverage-start', expression: start, relative: null, jalali: { year: null, month: null, day: null, ...startJalali } },
  { id: 'd2', role: 'coverage-end', expression: end, relative: null, jalali: { year: null, month: null, day: null, ...endJalali } },
];

test('اجارهٔ ماهِ گذشته که امروز پرداخت شد هزینهٔ دوره است، نه پیش‌پرداخت ۱۳ ماهه', async () => {
  for (const [text, evidence, start, end, amount] of [
    ['اجاره مرداد دفتر رو امروز ۱۰ میلیون از حساب تجارت پرداخت کردیم', '۱۰ میلیون', 'مرداد', 'مرداد', 10_000_000],
    ['اجاره تیر ماه دفتر رو ۸ میلیون از تجارت دادیم', '۸ میلیون', 'تیر ماه', 'تیر ماه', 8_000_000],
    ['اجاره انبار از اول فروردین تا آخر مرداد رو امروز ۵۰ میلیون از تجارت دادیم', '۵۰ میلیون', 'اول فروردین', 'آخر مرداد', 50_000_000],
  ]) {
    await inFreshWorkspace(async () => {
      const { item, posted } = await understandCase(text, model({
        amounts: [amt('a1', 'paid-now', evidence)],
        movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از')], dates: coverage(start, end), subject: service('اجاره'),
      }));
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify(item.plan?.questions)}`);
      assert.equal(components(item)[0].treatment, 'period-expense', text);
      assert.equal(posted.schedule.length, 0, `${text}: جدولی برای دورهٔ گذشته ساخته نشد`);
      assert.equal(debitOf(posted, /اجاره|هزینه/), amount, text);
    });
  }
});

test('پایانِ پیش از آغاز هنوز به سال بعد می‌رود؛ پایانِ تنها هم همچنان آینده است', () => {
  const read = (text, dates) => validateUnderstanding(model({ amounts: [amt('a1', 'paid-now', '۱۲ میلیون')], dates }), { text, now: new Date(NOW) }).understanding.dates;
  const [, aban] = read('بیمه انبار از اول آبان تا آخر مهر ۱۲ میلیون دادیم', coverage('اول آبان', 'آخر مهر'));
  assert.equal(aban.iso.slice(0, 7), '2027-10', 'مهرِ سال بعد');
  // دورهٔ نیمه‌گذشته: پایانش همان سال است، نه سال بعد.
  const [from, to] = read('اجاره از اول مرداد تا آخر آبان ۱۲ میلیون دادیم', coverage('اول مرداد', 'آخر آبان'));
  assert.equal(from.iso.slice(0, 7), '2026-07');
  assert.equal(to.iso.slice(0, 7), '2026-11');
  // «بیمه تا آخر فروردین» بی‌آغاز: فروردینِ پیش رو.
  const [only] = read('بیمه تا آخر فروردین ۱۲ میلیون دادیم', [{ id: 'd1', role: 'coverage-end', expression: 'آخر فروردین', relative: null, jalali: { year: null, month: 1, day: null } }]);
  assert.equal(only.iso.slice(0, 7), '2027-04');
});

// ---------------------------------------------------------------------------
// ۴. «آینده»ی دورهٔ پوشش زمانِ پول نیست؛ قراردادِ اجرانشده بدهی نمی‌سازد.
// ---------------------------------------------------------------------------

const negation = (evidence) => [{ kind: 'negation', affects: ['a1'], evidence, text: evidence }];

test('مبلغی که مدل «آینده» خواند ولی فعل انجام‌شده در بند خودش است، پرداخت شده است', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await understandCase('اجاره شش ماه آینده دفتر رو ۳۰ میلیون از تجارت پرداخت کردیم', model({
      amounts: [amt('a1', 'paid-now', '۳۰ میلیون', { status: 'future' })],
      movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت')], subject: service('اجاره دفتر'),
    }));
    assert.equal(item.status, 'ready', JSON.stringify(item.plan?.reasons));
    assert.equal(debitOf(posted, /پیش‌پرداخت/), 30_000_000);
    assert.equal(posted.schedule.length, 6);
    assert.equal(posted.scheduled, 30_000_000);
  });
  // منفی: پرداختی که واقعاً آینده است («پرداخت می‌کنیم») سند ندارد.
  await inFreshWorkspace(async () => {
    const { item, posted } = await understandCase('اجاره شش ماه آینده رو ۳۰ میلیون ماه بعد از تجارت پرداخت می‌کنیم', model({
      amounts: [amt('a1', 'paid-now', '۳۰ میلیون', { status: 'future' })],
      movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت')], subject: service('اجاره دفتر'),
    }));
    assert.equal(item.status, 'no-entry');
    assert.equal(posted, null);
  });
});

test('اجاره یا بیمهٔ دورهٔ آینده که هنوز پرداخت نشده: نه هزینه نه بدهیِ امروز — حسابدار', async () => {
  for (const [text, extra] of [
    ['اجاره ۶ ماه آینده دفتر ۳۰ میلیون شد ولی هنوز پرداخت نکردیم', { conditions: negation('هنوز پرداخت نکردیم') }],
    ['اجاره ۶ ماه آینده دفتر ۳۰ میلیون شد ولی هنوز پرداخت نکردیم', {}],
    ['اجاره آبان تا دی دفتر ۳۰ میلیون شد ولی هنوز پرداخت نکردیم', { conditions: negation('هنوز پرداخت نکردیم'), dates: coverage('آبان', 'دی', { month: 8 }, { month: 10 }) }],
    ['مستاجر اجاره شش ماه بعد رو ۳۰ میلیون هنوز نداده', { event: { kind: 'income', description: '', status: 'done' }, conditions: negation('هنوز نداده') }],
  ]) {
    await inFreshWorkspace(async () => {
      const { item, posted } = await understandCase(text, model({ amounts: [amt('a1', 'total', '۳۰ میلیون')], subject: service('اجاره دفتر'), ...extra }),
        { answers: [] });
      assert.equal(item.status, 'needs-accountant', `${text}: ${JSON.stringify(item.plan?.questions)}`);
      assert.deepEqual(questionIds(item), [], `${text}: «از کدام حساب» برای پولی که نرفته پرسیده نمی‌شود`);
      assert.equal(posted, null, text);
    });
  }
});

test('منفی: قبض و اجارهٔ همین ماه یا ماهِ گذشته که پرداخت نشده، بدهی/طلبِ امروز است', async () => {
  for (const [text, evidence, kind, negated] of [
    ['قبض برق ۲ میلیون اومده هنوز پرداخت نکردیم', '۲ میلیون', 'expense', 'هنوز پرداخت نکردیم'],
    ['اجاره مهر دفتر ۱۰ میلیون شد هنوز ندادیم', '۱۰ میلیون', 'expense', 'هنوز ندادیم'],
    ['مستاجر اجاره مرداد رو ۱۰ میلیون هنوز نداده', '۱۰ میلیون', 'income', 'هنوز نداده'],
  ]) {
    const result = validateUnderstanding(model({ event: { kind, description: '', status: 'done' }, amounts: [amt('a1', 'total', evidence)], conditions: negation(negated) }),
      { text, now: new Date(NOW) });
    assert.ok(result.violations.includes('amounts.a1:unpaid-obligation'), `${text}: ${result.violations}`);
    assert.ok(!result.violations.includes('amounts.a1:executory-contract'), text);
  }
});

// ---------------------------------------------------------------------------
// ۵. دورهٔ یک مبلغ به مبلغ دیگرِ همان جمله نمی‌رسد.
// ---------------------------------------------------------------------------

const twoPayments = (first, second, extra = {}) => model({
  amounts: [amt('a1', 'paid-now', first), amt('a2', 'paid-now', second)],
  movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت'), mv('m2', 'a2', 'out', BANK, UNKNOWN, 'از تجارت')],
  ...extra,
});

test('قبض یا کرایهٔ حمل کنار اجاره یا بیمهٔ دوره‌دار: فقط اجاره و بیمه پیش‌پرداخت‌اند', async () => {
  for (const [text, first, second, prepaid, expensed, months] of [
    ['قبض برق ۲ میلیون و اجاره ۶ ماه جلوتر دفتر ۳۰ میلیون از تجارت دادیم', '۲ میلیون', 'اجاره ۶ ماه جلوتر دفتر ۳۰ میلیون', 30_000_000, 2_000_000, 6],
    ['قبض برق ۲ میلیون و اجاره ۶ ماه جلوتر دفتر ۳۰ میلیون از تجارت دادیم', '۲ میلیون', '۳۰ میلیون', 30_000_000, 2_000_000, 6],
    ['کرایه حمل بار ۳ میلیون دادیم و بیمه یک ساله ماشین ۱۲ میلیون هم از تجارت پرداخت کردیم', 'کرایه حمل بار ۳ میلیون', 'بیمه یک ساله ماشین ۱۲ میلیون', 12_000_000, 3_000_000, 12],
    ['کرایه حمل بار ۳ میلیون دادیم و بیمه یک ساله ماشین ۱۲ میلیون هم از تجارت پرداخت کردیم', '۳ میلیون', '۱۲ میلیون', 12_000_000, 3_000_000, 12],
    ['بیمه یک ساله ماشین ۱۲ میلیون و کرایه حمل بار ۳ میلیون از تجارت دادیم', '۱۲ میلیون', '۳ میلیون', 12_000_000, 3_000_000, 12],
    ['قبض برق ۲ میلیون، اجاره ۶ ماه جلوتر دفتر ۳۰ میلیون، از تجارت دادیم', '۲ میلیون', '۳۰ میلیون', 30_000_000, 2_000_000, 6],
    ['۳۰ میلیون اجاره دفتر برای شش ماه آینده و ۲ میلیون قبض برق از تجارت دادیم', '۳۰ میلیون', '۲ میلیون', 30_000_000, 2_000_000, 6],
  ]) {
    await inFreshWorkspace(async () => {
      const { item, posted } = await understandCase(text, twoPayments(first, second));
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify([item.plan?.questions, item.plan?.reasons])}`);
      assert.equal(debitOf(posted, /پیش‌پرداخت/), prepaid, `${text}: ${JSON.stringify(posted.lines)}`);
      assert.equal(posted.schedule.length, months, text);
      assert.equal(posted.scheduled, prepaid, text);
      assert.equal(creditOf(posted, /تجارت/), prepaid + expensed, `${text}: ${JSON.stringify([posted.lines, components(item)])}`);
      assert.ok(!posted.lines.some(([account, value]) => value > 0 && /پیش‌پرداخت\s*—\s*(?:قبوض|حمل)/.test(account)), `${text}: قبض و کرایه پیش‌پرداخت نشدند`);
    });
  }
});

test('تاریخ پوششِ مدل فقط به مبلغی می‌رسد که عبارتش در بخش خودِ آن است', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await understandCase('قبض برق ۲ میلیون و اجاره آبان و آذر دفتر ۲۰ میلیون از تجارت دادیم',
      twoPayments('۲ میلیون', '۲۰ میلیون', { dates: coverage('آبان', 'آذر', { month: 8 }, { month: 9 }) }));
    assert.equal(item.status, 'ready', JSON.stringify([item.plan?.questions, item.plan?.reasons]));
    assert.equal(debitOf(posted, /پیش‌پرداخت/), 20_000_000);
    assert.deepEqual(posted.schedule.map((row) => row.period_key), ['1405-08', '1405-09']);
  });
  // ترتیب وارونه: پوشش پیش از مبلغ اول، قبض پس از «و».
  await inFreshWorkspace(async () => {
    const { item, posted } = await understandCase('بیمه ماشین از اول آبان تا آخر مهر سال بعد ۱۲ میلیون و کرایه حمل ۳ میلیون از تجارت دادیم',
      twoPayments('۱۲ میلیون', '۳ میلیون', { dates: coverage('اول آبان', 'آخر مهر سال بعد', { month: 8, day: 1 }, { month: 7 }) }));
    assert.equal(item.status, 'ready', JSON.stringify([item.plan?.questions, item.plan?.reasons]));
    assert.equal(debitOf(posted, /پیش‌پرداخت/), 12_000_000);
    assert.equal(posted.scheduled, 12_000_000);
  });
});

test('دوره‌ای که در متنِ مشترکِ چند مبلغ آمده صاحب ندارد: حسابدار، نه حدس', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await understandCase('برای شش ماه آینده، اجاره ۳۰ میلیون و شارژ ۶ میلیون از تجارت دادیم', twoPayments('اجاره ۳۰ میلیون', 'شارژ ۶ میلیون'));
    assert.equal(item.status, 'needs-accountant', JSON.stringify(item.plan?.questions));
    assert.equal(posted, null);
  });
});

test('منفی: مبلغِ تنها، اجزای یک کل، و اجارهٔ همین ماه کنار قبض', async () => {
  for (const [text, said, expected] of [
    ['قبض برق ۲ میلیون از تجارت دادیم', model({ amounts: [amt('a1', 'paid-now', '۲ میلیون')], movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت')] }), { prepaid: 0, items: 0 }],
    ['بیمه یک ساله ماشین ۱۲ میلیون از تجارت دادیم', model({ amounts: [amt('a1', 'paid-now', '۱۲ میلیون')], movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت')] }), { prepaid: 12_000_000, items: 12 }],
    ['اجاره همین ماه ۶ میلیون و قبض برق ۲ میلیون از تجارت دادیم', twoPayments('اجاره همین ماه ۶ میلیون', 'قبض برق ۲ میلیون'), { prepaid: 0, items: 0 }],
    ['اجاره ۶ ماه جلوتر دفتر ۳۰ میلیون، ۱۰ میلیون از تجارت و ۲۰ میلیون از تجارت دادیم', model({
      amounts: [amt('a1', 'total', 'اجاره ۶ ماه جلوتر دفتر ۳۰ میلیون'), amt('a2', 'paid-now', '۱۰ میلیون', { partOf: 'a1' }), amt('a3', 'paid-now', '۲۰ میلیون', { partOf: 'a1' })],
      movements: [mv('m2', 'a2', 'out', BANK, UNKNOWN, 'از تجارت'), mv('m3', 'a3', 'out', BANK, UNKNOWN, 'از تجارت')],
    }), { prepaid: 30_000_000, items: 12 }],
    // اجارهٔ آینده که هنوز پرداخت نشده، دوره‌اش را به قبضِ پرداخت‌شده نمی‌دهد.
    ['اجاره شش ماه آینده رو ۳۰ میلیون ماه بعد میدیم و قبض برق ۲ میلیون از تجارت دادیم', model({
      amounts: [amt('a1', 'paid-now', '۳۰ میلیون', { status: 'future' }), amt('a2', 'paid-now', '۲ میلیون')],
      movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'میدیم'), mv('m2', 'a2', 'out', BANK, UNKNOWN, 'از تجارت دادیم')],
    }), { prepaid: 0, items: 0, paid: 2_000_000 }],
  ]) {
    await inFreshWorkspace(async () => {
      const { item, posted } = await understandCase(text, said);
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify([item.plan?.questions, item.plan?.reasons])}`);
      assert.equal(debitOf(posted, /پیش‌پرداخت/), expected.prepaid, `${text}: ${JSON.stringify(posted.lines)}`);
      assert.equal(posted.schedule.length, expected.items, text);
      if (expected.paid) assert.equal(creditOf(posted, /تجارت/), expected.paid, text);
    });
  }
});

// ---------------------------------------------------------------------------
// ۶. آغاز و طولِ گفته‌شده با هم یک دوره‌اند؛ طولِ تنها فقط آغاز را می‌پرسد.
// ---------------------------------------------------------------------------

const duration = (evidence) => [{ value: evidence.replace(/[^\d۰-۹]/g, '') || '1', role: 'duration', evidence }];

test('آغاز + طول: «از اول آبان ۶ ماه» و «از امروز به مدت یک سال» بی‌سؤال یک دوره‌اند', async () => {
  for (const [text, evidence, startDate, months, first, amount] of [
    ['اجاره ۶ ماه دفتر از اول آبان رو ۳۰ میلیون از تجارت دادیم', '۶ ماه', { id: 'd1', role: 'coverage-start', expression: 'از اول آبان', relative: null, jalali: { year: null, month: 8, day: 1 } }, 6, '1405-08', 30_000_000],
    ['اجاره دفتر از امروز به مدت یک سال ۶۰ میلیون از تجارت دادیم', 'یک سال', { id: 'd1', role: 'coverage-start', expression: 'از امروز', relative: 'today', jalali: { year: null, month: null, day: null } }, 12, '1405-07', 60_000_000],
  ]) {
    await inFreshWorkspace(async () => {
      const { item, posted } = await understandCase(text, model({
        amounts: [amt('a1', 'paid-now', amount === 30_000_000 ? '۳۰ میلیون' : '۶۰ میلیون')], nonAmountNumbers: duration(evidence),
        movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت')], dates: [startDate], subject: service('اجاره دفتر'),
      }));
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify([item.plan?.questions, item.plan?.reasons])}`);
      assert.equal(posted.schedule.length, months, text);
      assert.equal(posted.schedule[0].period_key, first, text);
      assert.equal(posted.scheduled, amount, text);
    });
  }
});

test('طولِ تنها («به مدت یک سال»، «برای شش ماه»): فقط آغاز پرسیده می‌شود، پایان از طول', async () => {
  for (const [text, evidence, amount, start, months, first] of [
    ['بیمه آتش سوزی انبار به مدت یک سال ۱۲ میلیون از تجارت دادیم', 'یک سال', '۱۲ میلیون', 'this-month', 12, '1405-07'],
    ['اجاره دفتر برای شش ماه ۳۰ میلیون از تجارت دادیم', 'شش ماه', '۳۰ میلیون', 'next-month', 6, '1405-08'],
  ]) {
    const said = model({ amounts: [amt('a1', 'paid-now', amount)], nonAmountNumbers: duration(evidence), movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت')], subject: service(text.split(' ')[0]) });
    await inFreshWorkspace(async () => {
      const { item } = await understandCase(text, said, { commit: false });
      assert.deepEqual(questionIds(item), ['engine.a1.servicePeriodStart'], text);
    });
    await inFreshWorkspace(async () => {
      const { item, posted } = await understandCase(text, said, { answers: [{ 'engine.a1.servicePeriodStart': { value: start } }] });
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify(item.plan?.questions)}`);
      assert.equal(posted.schedule.length, months, text);
      assert.equal(posted.schedule[0].period_key, first, text);
    });
  }
});

// ---------------------------------------------------------------------------
// ۷. آینه: اجاره و خدمتی که پیشاپیش به ما رسیده پیش‌دریافت است و ماه‌به‌ماه درآمد می‌شود.
// ---------------------------------------------------------------------------

const KARIMI = { kind: 'counterparty', name: 'آقای کریمی' };
const received = (kind, evidence, extra = {}) => model({
  event: { kind, description: '', status: 'done' },
  amounts: [amt('a1', 'received-now', evidence)],
  movements: [mv('m1', 'a1', 'in', KARIMI, BANK, 'به حساب تجارت واریز کرد')],
  counterparties: party('آقای کریمی', 'customer'), subject: service('اجاره مغازه'),
  ...extra,
});

test('اجاره یا پشتیبانیِ دورهٔ آینده که پیشاپیش دریافت شد: پیش‌دریافت با جدول ماهانه', async () => {
  for (const [text, said, months, amount] of [
    ['آقای کریمی مستاجر مغازه اجاره ۶ ماه آینده رو ۶۰ میلیون به حساب تجارت واریز کرد', received('income', '۶۰ میلیون', { nonAmountNumbers: duration('۶ ماه') }), 6, 60_000_000],
    ['آقای کریمی مستاجر مغازه اجاره ۶ ماه آینده رو یکجا ۶۰ میلیون به حساب تجارت واریز کرد', received('advance-received', '۶۰ میلیون', { nonAmountNumbers: duration('۶ ماه') }), 6, 60_000_000],
    ['قرارداد پشتیبانی یک ساله با شرکت آلفا بستیم و کل مبلغ ۲۴ میلیون رو از اول به حساب تجارت واریز کرد', received('income', '۲۴ میلیون', {
      movements: [mv('m1', 'a1', 'in', { kind: 'counterparty', name: 'شرکت آلفا' }, BANK, 'به حساب تجارت واریز کرد')],
      counterparties: party('شرکت آلفا', 'customer'), subject: service('قرارداد پشتیبانی'), nonAmountNumbers: duration('یک ساله'),
    }), 12, 24_000_000],
    ['مستاجر اجاره ۶ ماه مغازه رو جلو جلو داد ۳۰ میلیون', received('advance-received', '۳۰ میلیون', {
      movements: [mv('m1', 'a1', 'in', { kind: 'counterparty', name: 'مستاجر' }, BANK, 'داد')], counterparties: party('مستاجر', 'customer'), nonAmountNumbers: duration('۶ ماه'),
    }), 6, 30_000_000],
  ]) {
    await inFreshWorkspace(async () => {
      const { item, posted } = await understandCase(text, said);
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify([item.plan?.questions, item.plan?.reasons])}`);
      assert.equal(components(item)[0].treatment, 'deferred-revenue', text);
      assert.equal(posted.schedule.length, months, text);
      assert.equal(posted.scheduled, amount, text);
      assert.equal(creditOf(posted, /درآمد(?!.*انتقالی)/) || 0, 0, `${text}: درآمدِ امروز ساخته نشد ${JSON.stringify(posted.lines)}`);
      assert.equal(creditOf(posted, /درآمد انتقالی|پیش‌دریافت/), amount, text);
    });
  }
});

test('اجارهٔ همین ماه که «پیش پیش» رسید درآمدِ همین ماه است؛ بی‌طول، دوره پرسیده می‌شود', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await understandCase('آقای کریمی اجاره مهر مغازه رو ۱۰ میلیون پیش پیش به حساب تجارت واریز کرد',
      received('advance-received', '۱۰ میلیون', { dates: coverage('مهر', 'مهر', { month: 7 }, { month: 7 }) }));
    assert.equal(item.status, 'ready', JSON.stringify([item.plan?.questions, item.plan?.reasons]));
    assert.equal(components(item)[0].treatment, 'recognized-revenue');
    assert.equal(creditOf(posted, /درآمد/), 10_000_000, JSON.stringify(posted.lines));
    assert.equal(posted.schedule.length, 0);
  });
  // بی‌طول و بی‌آغاز: پیش‌دریافتِ اجاره بی‌دوره هرگز درآمد نمی‌شد؛ حالا آغاز و پایان پرسیده می‌شوند.
  const text = 'مستاجر اجاره مغازه رو پیش پیش داد ۳۰ میلیون به حساب تجارت';
  const said = received('advance-received', '۳۰ میلیون', { movements: [mv('m1', 'a1', 'in', { kind: 'counterparty', name: 'مستاجر' }, BANK, 'داد')], counterparties: party('مستاجر', 'customer') });
  await inFreshWorkspace(async () => {
    const { item } = await understandCase(text, said, { commit: false });
    assert.deepEqual(questionIds(item), ['engine.a1.servicePeriodStart'], JSON.stringify(item.plan?.reasons));
  });
  await inFreshWorkspace(async () => {
    const { item, posted } = await understandCase(text, said, { answers: [{ 'engine.a1.servicePeriodStart': { value: 'next-month' } }, { 'engine.a1.servicePeriodEnd': { value: 'three-months' } }] });
    assert.equal(item.status, 'ready', JSON.stringify(item.plan?.questions));
    assert.equal(posted.schedule.length, 3);
    assert.equal(posted.schedule[0].period_key, '1405-08');
  });
});

test('منفی: بیعانهٔ کالا پیش‌دریافت از مشتری می‌ماند، فروشِ کالا با گارانتی درآمد است', async () => {
  await inFreshWorkspace(async () => {
    const { item, posted } = await understandCase('آقای کریمی ۱۰ میلیون بیعانه خرید مبل به حساب تجارت واریز کرد',
      received('advance-received', '۱۰ میلیون بیعانه', { subject: { what: 'مبل', kind: 'goods', use: 'resale', delivered: 'no', usefulLifeMonths: null, evidence: null } }));
    assert.equal(item.status, 'ready', JSON.stringify([item.plan?.questions, item.plan?.reasons]));
    assert.equal(components(item)[0].treatment, 'customer-advance');
    assert.equal(posted.schedule.length, 0);
  });
  await inFreshWorkspace(async () => {
    const { item, posted } = await understandCase('دستگاه کپی با گارانتی یک ساله به آقای کریمی ۵۰ میلیون فروختیم و به حساب تجارت واریز کرد',
      received('sale', '۵۰ میلیون', { subject: { what: 'دستگاه کپی', kind: 'goods', use: 'resale', delivered: 'yes', usefulLifeMonths: null, evidence: null } }));
    assert.equal(item.status, 'ready', JSON.stringify([item.plan?.questions, item.plan?.reasons]));
    assert.equal(posted.schedule.length, 0);
    assert.equal(creditOf(posted, /فروش|درآمد/), 50_000_000, JSON.stringify(posted.lines));
  });
});

// ---------------------------------------------------------------------------
// ۸. پاسخ همه یا هیچ؛ متنِ تایپ‌شده جوابِ سؤالِ متنیِ موتور است.
// ---------------------------------------------------------------------------

const versions = (id) => database.activeWorkspaceDatabase().prepare('SELECT COUNT(*) AS count FROM understanding_versions WHERE case_id=?').get(id).count;

test('پایانِ دورهٔ نامفهوم رد می‌شود و هیچ چیز ذخیره نمی‌شود؛ پرونده همچنان قابل پاسخ و ثبت است', async () => {
  await inFreshWorkspace(async () => {
    const text = 'اجاره دفتر برای شش ماه ۳۰ میلیون از تجارت دادیم';
    const { item: asked, options } = await understandCase(text, model({
      amounts: [amt('a1', 'paid-now', '۳۰ میلیون')], movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت')], subject: service('اجاره دفتر'),
    }), { answers: [{ 'engine.a1.servicePeriodStart': { value: 'next-month' } }], commit: false });
    assert.deepEqual(questionIds(asked), ['engine.a1.servicePeriodEnd']);
    const before = versions(asked.id);
    for (const bad of [{ value: 'custom', freeText: 'آخر فروردین' }, { value: 'custom', freeText: '۶ ماه از مهر' }, { value: 'custom' }]) {
      await assert.rejects(database.answerUnderstandingCase(asked.id, { 'engine.a1.servicePeriodEnd': bad }, options), (error) => error.status === 400 && /^ANSWER_/.test(error.code));
    }
    const still = database.getUnderstandingCase(asked.id);
    assert.equal(versions(asked.id), before, 'نسخهٔ تازه‌ای ساخته نشد');
    assert.ok(still.plan, 'نقشه سر جایش است');
    assert.deepEqual(questionIds(still), ['engine.a1.servicePeriodEnd']);
    assert.equal(still.answers['engine.a1.servicePeriodEnd'], undefined);
    assert.equal(still.answers['engine.a1.servicePeriodStart'].value, 'next-month', 'آغاز بی‌صدا عوض نشد');
    const ready = await database.answerUnderstandingCase(asked.id, { 'engine.a1.servicePeriodEnd': { value: 'six-months' } }, options);
    assert.equal(ready.status, 'ready');
    database.commitUnderstandingCase(asked.id, { now: new Date(NOW) });
    const posted = ledgerNow();
    assert.equal(posted.schedule.length, 6);
    assert.equal(posted.schedule[0].period_key, '1405-08');
  });
});

test('پاسخِ خرابی که از پیش ذخیره شده پرونده را قفل نمی‌کند: سؤال دوباره پرسیده می‌شود و ثبت «آماده نیست» می‌گوید', async () => {
  await inFreshWorkspace(async () => {
    const { item: asked } = await understandCase('بیمه انبار ۱۲ میلیون از تجارت دادیم', model({
      amounts: [amt('a1', 'paid-now', '۱۲ میلیون')], movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت')], subject: service('بیمه انبار'),
    }), { commit: false });
    assert.deepEqual(questionIds(asked), ['engine.a1.servicePeriodStart']);
    const db = database.activeWorkspaceDatabase();
    const answers = { ...asked.answers, 'engine.a1.servicePeriodStart': { value: 'custom', freeText: '۶ ماه از مهر', picker: 'options' } };
    db.prepare('UPDATE understanding_cases SET answers=? WHERE id=?').run(JSON.stringify(answers), asked.id);
    assert.throws(() => database.commitUnderstandingCase(asked.id, { now: new Date(NOW) }), (error) => error.code === 'UNDERSTANDING_NOT_READY');
    assert.deepEqual(questionIds(database.getUnderstandingCase(asked.id)), ['engine.a1.servicePeriodStart']);
  });
});

test('طرف حسابِ تایپ‌شده در سؤال متنیِ موتور پذیرفته می‌شود: ودیعه، پیش‌پرداخت خرید، مساعده', async () => {
  for (const [text, kind, evidence, role, answersFor] of [
    ['ودیعه اجاره دفتر ۵۰ میلیون از تجارت دادیم', 'deposit', 'ودیعه اجاره دفتر ۵۰ میلیون', 'deposit', [{ 'engine.a1.refundable': { value: true } }]],
    ['پیش پرداخت خرید کالا ۲۰ میلیون از تجارت دادیم', 'advance-paid', '۲۰ میلیون', 'paid-now', []],
    ['مساعده ۵ میلیون از تجارت دادیم', 'advance-paid', 'مساعده ۵ میلیون', 'paid-now', []],
  ]) {
    await inFreshWorkspace(async () => {
      let { item, options } = await understandCase(text, model({
        event: { kind, description: '', status: 'done' }, amounts: [amt('a1', role, evidence)], movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت')],
      }), { answers: answersFor, commit: false });
      for (let guard = 0; guard < 4 && item.status === 'needs-answers'; guard += 1) {
        const open = item.plan.questions[0];
        const answer = open.picker === 'text' ? { value: 'آقای رضایی' } : { value: open.options?.[0]?.value };
        item = await database.answerUnderstandingCase(item.id, { [open.id]: answer }, options);
      }
      assert.ok(Object.keys(item.answers).some((key) => /counterparty$/.test(key)), `${text}: ${JSON.stringify(item.plan?.questions)}`);
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify([item.plan?.questions, item.plan?.reasons])}`);
      database.commitUnderstandingCase(item.id, { now: new Date(NOW) });
      assert.ok(database.listContacts().some((contact) => contact.name === 'آقای رضایی'), text);
    });
  }
});

// ---------------------------------------------------------------------------
// ۹. «از همین ماه» یعنی ماهِ پرداخت، نه ماهِ امروز یا ماهِ ثبت — همان مسیر قطعی.
// ---------------------------------------------------------------------------

const paidOn = (expression, jalali) => [{ id: 'p1', role: 'payment', expression, relative: null, jalali: { year: null, month: null, day: null, ...jalali } }];

test('مرجعِ پاسخ‌های نسبی و تاریخِ تایپ‌شده تاریخ پرداخت است؛ ثبتِ دیرتر دوره را جابه‌جا نمی‌کند', async () => {
  for (const [text, payment, start, end, first, last, commitAt] of [
    ['۱۵ شهریور بیمه انبار ۱۲ میلیون دادیم', paidOn('۱۵ شهریور', { month: 6, day: 15 }), { value: 'this-month' }, { value: 'one-year' }, '1405-06', '1406-05', NOW],
    ['۱۵ شهریور بیمه انبار ۱۲ میلیون دادیم', paidOn('۱۵ شهریور', { month: 6, day: 15 }), { value: 'this-month' }, { value: 'one-year' }, '1405-06', '1406-05', '2026-10-25T09:00:00.000Z'],
    ['۱۵ شهریور بیمه انبار ۱۲ میلیون دادیم', paidOn('۱۵ شهریور', { month: 6, day: 15 }), { value: 'next-month' }, { value: 'one-year' }, '1405-07', '1406-06', NOW],
    ['۲۰ اسفند ۱۴۰۴ بیمه انبار ۱۲ میلیون دادیم', paidOn('۲۰ اسفند ۱۴۰۴', { year: 1404, month: 12, day: 20 }), { value: 'custom', freeText: '۱ اسفند' }, { value: 'one-year' }, '1404-12', '1405-11', NOW],
    // منفی: پرداختِ همین ماه در هر دو مسیر یکی است.
    ['۲ مهر بیمه انبار ۱۲ میلیون دادیم', paidOn('۲ مهر', { month: 7, day: 2 }), { value: 'this-month' }, { value: 'one-year' }, '1405-07', '1406-06', NOW],
  ]) {
    await inFreshWorkspace(async () => {
      const { item, options } = await understandCase(text, model({
        amounts: [amt('a1', 'paid-now', '۱۲ میلیون')], movements: [mv('m1', 'a1', 'out', UNKNOWN, UNKNOWN, 'دادیم')], dates: payment, subject: service('بیمه انبار'),
      }), { answers: [{ 'movements.m1.account': '$tejarat' }, { 'engine.a1.servicePeriodStart': start }, { 'engine.a1.servicePeriodEnd': end }], commit: false });
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify([item.plan?.questions, item.plan?.reasons])}`);
      database.commitUnderstandingCase(item.id, { now: new Date(commitAt) });
      const posted = ledgerNow();
      assert.equal(posted.schedule[0].period_key, first, `${text} ${start.value} @${commitAt}`);
      assert.equal(posted.schedule.at(-1).period_key, last, text);
      assert.equal(posted.scheduled, 12_000_000, text);
      assert.ok(options);
    });
  }
});

test('آینه: پیش‌دریافتِ اجارهٔ پرداخت‌شده در شهریور با «از همین ماه» از شهریور درآمد می‌شود', async () => {
  await inFreshWorkspace(async () => {
    const { item } = await understandCase('۱۵ شهریور مستاجر اجاره مغازه رو پیش پیش داد ۳۰ میلیون به حساب تجارت', received('advance-received', '۳۰ میلیون', {
      movements: [mv('m1', 'a1', 'in', { kind: 'counterparty', name: 'مستاجر' }, BANK, 'داد')], counterparties: party('مستاجر', 'customer'), dates: paidOn('۱۵ شهریور', { month: 6, day: 15 }),
    }), { answers: [{ 'engine.a1.servicePeriodStart': { value: 'this-month' } }, { 'engine.a1.servicePeriodEnd': { value: 'three-months' } }], commit: false });
    assert.equal(item.status, 'ready', JSON.stringify([item.plan?.questions, item.plan?.reasons]));
    database.commitUnderstandingCase(item.id, { now: new Date('2026-10-25T09:00:00.000Z') });
    assert.deepEqual(ledgerNow().schedule.map((row) => row.period_key), ['1405-06', '1405-07', '1405-08']);
  });
});

// ---------------------------------------------------------------------------
// ۱۰. ردیفِ صف حسابدار واقعیت‌های گفته‌شده را با خودش می‌برد.
// ---------------------------------------------------------------------------

test('چکِ پیش‌پرداخت یا پیش‌دریافت که به حسابدار رفت: دوره، طرف حساب و دسته روی ردیف صف هست', async () => {
  for (const [text, said, months, party_] of [
    ['اجاره یک ساله دفتر رو با چک ۱۲۰ میلیون به آقای رضایی دادیم', model({
      event: { kind: 'advance-paid', description: '', status: 'done' }, amounts: [amt('a1', 'paid-now', 'چک ۱۲۰ میلیون')],
      movements: [mv('m1', 'a1', 'out', UNKNOWN, { kind: 'counterparty', name: 'آقای رضایی' }, 'با چک')], counterparties: party('آقای رضایی', 'landlord'), subject: service('اجاره دفتر'),
    }), 12, 'آقای رضایی'],
    ['آقای احمدی مستاجرمون اجاره شش ماه آینده رو یه چک ۶۰ میلیونی داد', model({
      event: { kind: 'advance-received', description: '', status: 'done' }, amounts: [amt('a1', 'received-now', 'چک ۶۰ میلیونی')],
      movements: [mv('m1', 'a1', 'in', { kind: 'counterparty', name: 'آقای احمدی' }, UNKNOWN, 'داد')], counterparties: party('آقای احمدی', 'customer'), subject: service('اجاره مغازه'),
    }), 6, 'آقای احمدی'],
    // منفی: چکِ خرید کالا دوره ندارد.
    ['چک ۵۰ میلیونی بابت خرید کالا به آقای رضایی دادیم', model({
      event: { kind: 'purchase', description: '', status: 'done' }, amounts: [amt('a1', 'paid-now', 'چک ۵۰ میلیونی')],
      movements: [mv('m1', 'a1', 'out', UNKNOWN, { kind: 'counterparty', name: 'آقای رضایی' }, 'دادیم')], counterparties: party('آقای رضایی', 'supplier'),
    }), 0, 'آقای رضایی'],
  ]) {
    await inFreshWorkspace(async () => {
      const { item } = await understandCase(text, said, { commit: false });
      assert.equal(item.status, 'needs-accountant', `${text}: ${JSON.stringify(item.plan?.questions)}`);
      database.sendUnderstandingToAccountant(item.id);
      const row = database.activeWorkspaceDatabase().prepare('SELECT payload FROM financial_events WHERE source_event_id=?').get(`understanding:${item.id}`);
      const payload = JSON.parse(row.payload);
      assert.equal(payload.counterparty, party_, text);
      if (!months) {
        assert.equal(payload.servicePeriodStart, null, text);
        return;
      }
      assert.ok(payload.servicePeriodStart && payload.servicePeriodEnd, `${text}: ${row.payload}`);
      const span = (Date.parse(payload.servicePeriodEnd) - Date.parse(payload.servicePeriodStart)) / 86_400_000;
      assert.ok(Math.abs(span - months * 30.4) < 10, `${text}: ${span} روز`);
      // دستهٔ «درآمد اجاره» برای جملهٔ سوم‌شخصِ مستاجر از قاعدهٔ دسته‌هاست (بستهٔ پارسر).
      if (said.event.kind === 'advance-paid') assert.match(payload.category || '', /اجاره/, text);
    });
  }
});

// ---------------------------------------------------------------------------
// ۱۱. دستور مدل خانوادهٔ پیش‌پرداخت را راهنمایی می‌کند؛ قسطِ قرارداد قسطِ وام نیست.
// ---------------------------------------------------------------------------

test('دستور مدل: پیش‌پرداخت، ودیعهٔ برگشت‌پذیر، نرخ کنار کل، طول پوشش، آغاز + طول، پیش‌دریافت', async () => {
  const { UNDERSTANDING_INSTRUCTIONS: said } = await import('../server/eventUnderstandingAi.js');
  for (const [pattern, what] of [
    [/advance-paid/, 'پیش‌پرداخت خدمت دوره‌دار'],
    [/ودیعه[^\n]*برمی‌گردد/, 'ودیعه یعنی برگشت‌پذیر'],
    [/advance-received/, 'پیش‌دریافت از مستاجر یا مشتری'],
    [/نرخِ دوره[^\n]*unit-price[^\n]*context/, 'نرخ کنار کل پرداخت نیست'],
    [/شش ماه آینده[^\n]*زمانِ پول نیست/, 'آیندهٔ پوشش زمان پول نیست'],
    [/role=duration[^\n]*coverage-start/, 'آغاز + طول'],
    [/چند مبلغ[^\n]*دوره/, 'دورهٔ یک مبلغ مال همان مبلغ'],
    [/ماهِ گذشته/, 'ماه گذشته به سال بعد نمی‌رود'],
    [/قسط دوم بیمه[^\n]*loan-repayment/, 'قسط قرارداد قسط وام نیست'],
  ]) assert.match(said, pattern, what);
});

test('قسط یا باقیِ بیمه و اجاره: نه پیش‌پرداخت تازه، نه قسط وام — حسابدار با دلیلِ درست', async () => {
  for (const [text, kind, evidence] of [
    ['باقی حق بیمه انبار ۹ میلیون رو هم از حساب تجارت دادیم', 'expense', '۹ میلیون'],
    ['قسط دوم بیمه آتش سوزی ۳ میلیون از حساب تجارت دادیم', 'loan-repayment', '۳ میلیون'],
    ['دومین قسط بیمه نامه آتش سوزی رو ۳ میلیون از تجارت دادیم', 'loan-repayment', '۳ میلیون'],
    ['مابقی حق اشتراک یک ساله نرم افزار ۶ میلیون رو از تجارت دادیم', 'advance-paid', '۶ میلیون'],
    ['باقیمانده اجاره دفتر 9 ميليون رو از تجارت پرداخت كرديم', 'expense', '9 ميليون'],
    ['بقیه اجاره مغازه ۲۰ میلیون رو مستاجر به حساب تجارت واریز کرد', 'income', '۲۰ میلیون'],
  ]) {
    await inFreshWorkspace(async () => {
      const incoming = kind === 'income';
      const { item, posted } = await understandCase(text, model({
        event: { kind, description: '', status: 'done' }, amounts: [amt('a1', incoming ? 'received-now' : 'paid-now', evidence)],
        movements: [incoming ? mv('m1', 'a1', 'in', { kind: 'counterparty', name: 'مستاجر' }, BANK, 'واریز کرد') : mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت')],
      }));
      assert.equal(item.status, 'needs-accountant', `${text}: ${JSON.stringify(item.plan?.questions)}`);
      assert.ok(item.plan.reasons.some((reason) => /قرارداد موجود/.test(reason)), `${text}: ${item.plan.reasons}`);
      assert.ok(!item.plan.reasons.some((reason) => /وام/.test(reason) && !/نه قسط وام/.test(reason)), `${text}: ${item.plan.reasons}`);
      assert.equal(posted, null, text);
    });
  }
});

test('منفی: قسط وام بانک وام می‌ماند؛ بیمهٔ یک‌سالهٔ تازه پیش‌پرداخت است؛ «بقیه‌اش رو قسطی میدیم» قرارداد موجود نیست', async () => {
  const loan = validateUnderstanding(model({ event: { kind: 'loan-repayment', description: '', status: 'done' }, amounts: [amt('a1', 'installment', '۳ میلیون')] }),
    { text: 'قسط وام بانک ملت ۳ میلیون دادیم', now: new Date(NOW) }).understanding;
  assert.equal(loan.event.kind, 'loan-repayment');
  const instalment = validateUnderstanding(model({ event: { kind: 'loan-repayment', description: '', status: 'done' }, amounts: [amt('a1', 'paid-now', '۳ میلیون')] }),
    { text: 'قسط دوم بیمه آتش سوزی ۳ میلیون از حساب تجارت دادیم', now: new Date(NOW) });
  assert.notEqual(instalment.understanding.event.kind, 'loan-repayment');
  await inFreshWorkspace(async () => {
    const { item, posted } = await understandCase('بیمه یک ساله انبار ۱۲ میلیون از تجارت دادیم', model({
      amounts: [amt('a1', 'paid-now', '۱۲ میلیون')], movements: [mv('m1', 'a1', 'out', BANK, UNKNOWN, 'از تجارت')], subject: service('بیمه انبار'),
    }));
    assert.equal(item.status, 'ready');
    assert.equal(posted.schedule.length, 12);
  });
  await inFreshWorkspace(async () => {
    const { item } = await understandCase('مبل خریدیم ۳۰ میلیون، ۱۰ میلیون از تجارت دادیم بقیه‌اش رو قسطی میدیم', model({
      event: { kind: 'purchase', description: '', status: 'done' },
      amounts: [amt('a1', 'total', '۳۰ میلیون'), amt('a2', 'paid-now', '۱۰ میلیون', { partOf: 'a1' })],
      movements: [mv('m1', 'a2', 'out', BANK, UNKNOWN, 'از تجارت')],
    }), { commit: false });
    assert.ok(!(item.plan?.reasons || []).some((reason) => /قرارداد موجود/.test(reason)), JSON.stringify(item.plan?.reasons));
  });
});
