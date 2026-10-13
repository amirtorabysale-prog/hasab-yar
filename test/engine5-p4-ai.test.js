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
