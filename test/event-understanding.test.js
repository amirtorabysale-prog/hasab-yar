import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { understandingSchema, validateUnderstanding } from '../shared/eventUnderstanding.js';
import { buildUnderstandingPlan } from '../shared/understandingPlan.js';
import { inUnderstandingScope } from '../shared/understandingScope.js';
import { todayPersian } from '../shared/persianDate.js';

/**
 * فهم رویداد با AI — قرارداد، نقشه و پرونده.
 *
 * مدل در این آزمون شبیه‌سازی می‌شود: خروجیِ از پیش نوشته‌شده برمی‌گرداند. آن‌چه
 * آزموده می‌شود همه‌چیزِ بعد از مدل است — اعتبارسنجی، تبدیل، پاسخ، ثبت و
 * مقایسه — یعنی جایی که خطای مدل باید گرفته شود. دقتِ خودِ مدل را فقط اجرای
 * واقعی روی محیط آزمایشی می‌سنجد (`scripts/understanding-eval.mjs`).
 */

const NOW = new Date('2026-10-09T09:00:00.000Z'); // ۱۷ مهر ۱۴۰۵
const QIASI = '۸۰ میلیون به شرکت قیاسی بدهکار بودیم، امروز ۵۰ میلیون از بانک سامان دادیم، گفت اگر ۱۰ میلیون دیگر بدهید، ۲۰ میلیون باقی‌مانده را می‌بخشم.';
const qiasiOutput = JSON.parse(readFileSync(new URL('./fixtures/understanding-qiasi.json', import.meta.url), 'utf8'));
const fa = (iso) => { const p = todayPersian(new Date(iso)); return `${p.year}/${p.month}/${p.day}`; };

const none = { op: null, of: [] };
const blank = () => ({
  event: { kind: 'other', description: '', status: 'done' }, amounts: [], nonAmountNumbers: [], dates: [], counterparties: [], movements: [],
  subject: { what: null, kind: null, use: 'unknown', delivered: 'unknown', usefulLifeMonths: null, evidence: null }, conditions: [], ambiguities: [],
});
const amount = (id, value, evidence, extra = {}) => ({ id, value, currency: null, role: 'total', status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence, ...extra });
const movement = (id, amountRef, direction, from, to, evidence) => ({ id, amountRef, direction, from, to, evidence });
const party = (kind, name = null) => ({ kind, name });

// ---------------------------------------------------------------------------
// قرارداد
// ---------------------------------------------------------------------------

test('schema سخت است: هر شیء additionalProperties=false و همهٔ فیلدها required', () => {
  const check = (node) => {
    if (node?.type === 'object' || (Array.isArray(node?.type) && node.type.includes('object'))) {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(check);
    }
    if (node?.items) check(node.items);
  };
  check(understandingSchema());
  // نام هیچ فیلدی حسابداری نیست: نه حساب، نه بدهکار و بستانکار، نه «نوع» درآمد/هزینه.
  const names = new Set();
  const collect = (node) => {
    if (node?.properties) for (const [name, child] of Object.entries(node.properties)) { names.add(name.toLowerCase()); collect(child); }
    if (node?.items) collect(node.items);
  };
  collect(understandingSchema());
  for (const forbidden of ['account', 'accountid', 'debit', 'credit', 'journal', 'type', 'treatment', 'family', 'posting']) assert.equal(names.has(forbidden), false, forbidden);
});

test('مثال الزامی: ۸۰ زمینه، ۵۰ انجام‌شده، ۱۰ آینده، ۲۰ مشروط', () => {
  const { ok, understanding, violations } = validateUnderstanding(qiasiOutput, { text: QIASI, now: NOW });
  assert.equal(ok, true);
  assert.deepEqual(violations, []);
  const byValue = Object.fromEntries(understanding.amounts.map((item) => [item.value, item]));
  assert.equal(byValue[80_000_000].status, 'context');
  assert.equal(byValue[50_000_000].status, 'done');
  assert.equal(byValue[10_000_000].status, 'future');
  assert.equal(byValue[20_000_000].status, 'conditional');
  assert.equal(fa(understanding.dates[0].iso), '1405/7/17');
});

test('شماره، سال، تعداد و قسط مبلغ ساختگی نمی‌شوند؛ عددِ ساختهٔ مدل رد می‌شود', () => {
  const run = (text, claim) => validateUnderstanding({ ...blank(), amounts: [claim] }, { text, now: NOW }).understanding.amounts[0];
  for (const [text, claim] of [
    ['فاکتور شماره ۱۴۰۵ رو ده میلیون پرداخت کردیم', amount('a1', 1405, 'فاکتور شماره ۱۴۰۵')],
    ['مالیات سال ۱۴۰۴ رو بیست میلیون دادیم', amount('a1', 1404, 'مالیات سال ۱۴۰۴')],
    ['ده کارتن روغن خریدیم دو میلیون', amount('a1', 10, 'ده کارتن روغن')],
    ['۱۰۰۰۰ عدد پیچ خریدیم پنج میلیون', amount('a1', 10000, '۱۰۰۰۰ عدد پیچ')],
    ['وام ۱۲۰ میلیون در ۱۲ قسط', amount('a1', 12, '۱۲ قسط')],
    ['چک شماره ۸۸۷۷۶۶ رو دادیم', amount('a1', 887766, 'چک شماره ۸۸۷۷۶۶')],
    ['اجاره رو دادیم', amount('a1', 5_000_000, 'اجاره رو دادیم')],
    ['اجاره رو پنج میلیون دادیم', amount('a1', 5_000_000, 'پنج میلیون تومان اجاره')],
  ]) {
    const result = run(text, claim);
    assert.equal(result.accepted, false, `${text} → ${claim.value}`);
    assert.equal(result.value, null);
  }
  assert.equal(run('اجاره رو پنج میلیون دادیم', amount('a1', 5_000_000, 'پنج میلیون')).value, 5_000_000);
  assert.equal(run('پنجاه میلیون ریال قبض دادیم', amount('a1', 5_000_000, 'پنجاه میلیون ریال', { currency: 'rial' })).value, 5_000_000);
});

test('مبلغ رد‌شده یک سؤال می‌سازد، نه حذف بی‌صدا؛ استنباط مدل مبلغ سند نمی‌شود', () => {
  const { understanding } = validateUnderstanding({ ...blank(), amounts: [amount('a1', 7_000_000, 'بقیه‌اش', { basis: 'inferred' })] }, { text: 'بقیه‌اش رو دادیم', now: NOW });
  assert.equal(understanding.amounts[0].accepted, false);
  assert.ok(understanding.ambiguities.some((item) => item.field === 'amounts.a1.value' && item.kind === 'information'));
});

test('کل و اجزا: مانده از اعداد صریح محاسبه می‌شود؛ جمعِ ناجور سؤال می‌سازد', () => {
  const text = 'صد میلیون جنس خریدیم چهل نقد دادیم بقیه نسیه';
  const amounts = [
    amount('a1', 100_000_000, 'صد میلیون'),
    amount('a2', 40_000_000, 'چهل نقد', { role: 'cash-part', partOf: 'a1' }),
    amount('a3', 60_000_000, 'بقیه نسیه', { role: 'credit-part', partOf: 'a1', basis: 'computed', computedFrom: { op: 'difference', of: ['a1', 'a2'] } }),
  ];
  const good = validateUnderstanding({ ...blank(), amounts }, { text, now: NOW }).understanding;
  assert.deepEqual(good.amounts.map((item) => item.value), [100_000_000, 40_000_000, 60_000_000]);
  assert.equal(good.amounts[1].provenance, 'explicit-scale-from-sentence');
  assert.equal(good.amounts[2].provenance, 'computed');
  const bad = validateUnderstanding({ ...blank(), amounts: [amounts[0], amounts[1], { ...amounts[2], basis: 'explicit', value: 70_000_000, evidence: 'صد میلیون' }] }, { text, now: NOW }).understanding;
  assert.ok(bad.ambiguities.length > 0);
});

test('فیلد حسابداری در خروجی مدل کل پاسخ را رد می‌کند', () => {
  assert.equal(validateUnderstanding({ ...blank(), journalEntry: {} }, { text: 'x', now: NOW }).ok, false);
  assert.equal(validateUnderstanding({ ...blank(), amounts: [{ ...amount('a1', 1, 'x'), debitAccount: '1101' }] }, { text: 'x', now: NOW }).ok, false);
});

test('نام و تاریخی که در متن نیست پذیرفته نمی‌شود؛ تاریخ پوشش جای تاریخ پرداخت نمی‌نشیند', () => {
  const text = 'بیمه آتش‌سوزی رو دوازده میلیون دادیم، از اول آبان تا آخر مهر سال بعد';
  const output = {
    ...blank(),
    event: { kind: 'expense', description: 'بیمه', status: 'done' },
    amounts: [amount('a1', 12_000_000, 'دوازده میلیون')],
    counterparties: [{ id: 'c1', name: 'بیمه ایران', role: 'other', evidence: 'بیمه' }],
    dates: [
      { id: 'd1', role: 'coverage-start', expression: 'اول آبان', relative: null, jalali: { year: null, month: 8, day: 1 } },
      { id: 'd2', role: 'payment', expression: 'پنجم مهر', relative: null, jalali: { year: null, month: 7, day: 5 } },
    ],
  };
  const { understanding, violations } = validateUnderstanding(output, { text, now: NOW });
  assert.equal(understanding.counterparties.length, 0, 'بیمه ایران در متن نیست');
  assert.ok(violations.includes('dates.d2:evidence-not-found'));
  const plan = buildUnderstandingPlan(understanding, { transcript: text, now: NOW });
  assert.ok(plan.questions.some((item) => item.id === 'dates.payment'), 'تاریخ پرداخت پرسیده می‌شود');
});

test('محدودهٔ پیش‌فرض: جملهٔ سادهٔ تک‌مبلغی به مدل نمی‌رود', () => {
  assert.equal(inUnderstandingScope('اجاره رو ده میلیون دادیم'), false);
  assert.equal(inUnderstandingScope(QIASI), true);
  assert.equal(inUnderstandingScope('قبض برق اومده هنوز پرداخت نکردیم سه میلیون'), true);
  assert.equal(inUnderstandingScope('اجاره رو ده میلیون دادیم', 'all'), true);
});

// ---------------------------------------------------------------------------
// نقشه
// ---------------------------------------------------------------------------

test('نقشه: نقد و نسیهٔ یک خرید دو جزءِ همان رویدادند و کل دوباره شمرده نمی‌شود', () => {
  const text = 'صد میلیون جنس برای فروش از شرکت آلفا خریدیم چهل نقد از صندوق دادیم بقیه نسیه';
  const output = {
    ...blank(), event: { kind: 'purchase', description: 'خرید کالا', status: 'done' },
    amounts: [
      amount('a1', 100_000_000, 'صد میلیون'),
      amount('a2', 40_000_000, 'چهل نقد', { role: 'cash-part', partOf: 'a1' }),
      amount('a3', null, 'بقیه نسیه', { role: 'credit-part', partOf: 'a1', basis: 'computed', computedFrom: { op: 'difference', of: ['a1', 'a2'] } }),
    ],
    counterparties: [{ id: 'c1', name: 'شرکت آلفا', role: 'supplier', evidence: 'از شرکت آلفا خریدیم' }],
    movements: [movement('m1', 'a2', 'out', party('cash'), party('counterparty', 'شرکت آلفا'), 'چهل نقد از صندوق دادیم')],
    subject: { what: 'جنس', kind: 'goods', use: 'resale', delivered: 'unknown', usefulLifeMonths: null, evidence: 'جنس برای فروش' },
  };
  const { understanding } = validateUnderstanding(output, { text, now: NOW });
  const plan = buildUnderstandingPlan(understanding, {
    transcript: text, now: NOW,
    resolution: { counterparties: { c1: { status: 'exact', contactId: 'k-alpha', name: 'شرکت آلفا', candidates: [], balance: 0 } }, endpoints: { 'm1.from': { status: 'resolved', accountId: 'cash' } } },
  });
  assert.equal(plan.route, 'ready');
  assert.deepEqual(plan.components.map((item) => [item.kind, item.amount]), [['cash', 40_000_000], ['obligation', 60_000_000]]);
  assert.ok(plan.notes.some((note) => note.kind === 'total'));
  assert.equal(plan.components[0].item.intendedUse, 'resale');
  assert.equal(plan.components[1].item.unpaidSignal, true);
});

test('نقشه: نفیِ «هنوز پرداخت نکردیم» خروج وجه نمی‌سازد', () => {
  const text = 'قبض برق سه میلیون اومده ولی هنوز پرداخت نکردیم';
  const output = {
    ...blank(), event: { kind: 'expense', description: 'قبض برق', status: 'done' },
    amounts: [amount('a1', 3_000_000, 'قبض برق سه میلیون')],
    counterparties: [],
    movements: [movement('m1', 'a1', 'out', party('unknown'), party('unknown'), 'قبض برق سه میلیون')],
    conditions: [{ kind: 'negation', text: 'پرداخت نشده', affects: ['a1'], evidence: 'هنوز پرداخت نکردیم' }],
  };
  const { understanding } = validateUnderstanding(output, { text, now: NOW });
  const plan = buildUnderstandingPlan(understanding, { transcript: text, now: NOW });
  assert.equal(plan.components.length, 0);
  assert.ok(plan.questions.some((item) => item.id === 'movements.m1.done'));
  const answered = buildUnderstandingPlan(understanding, { transcript: text, now: NOW, answers: { 'movements.m1.done': { value: 'not-yet' } } });
  assert.ok(answered.components.every((item) => item.kind !== 'cash'), 'پاسخ «هنوز نه» یعنی پولی جابه‌جا نشده');
});

test('نقشه: خرید دارایی با عمر مفید، تغییر برآورد نیست', () => {
  const text = 'یک لپ‌تاپ برای حسابداری چهل میلیون از صندوق خریدیم، عمر مفیدش سه سال است';
  const output = {
    ...blank(), event: { kind: 'asset-purchase', description: 'خرید لپ‌تاپ', status: 'done' },
    amounts: [amount('a1', 40_000_000, 'چهل میلیون')],
    nonAmountNumbers: [{ value: 'سه', role: 'duration', evidence: 'عمر مفیدش سه سال' }],
    movements: [movement('m1', 'a1', 'out', party('cash'), party('unknown'), 'چهل میلیون از صندوق خریدیم')],
    subject: { what: 'لپ‌تاپ', kind: 'asset', use: 'long-term', delivered: 'yes', usefulLifeMonths: 36, evidence: 'عمر مفیدش سه سال' },
  };
  const { understanding } = validateUnderstanding(output, { text, now: NOW });
  const plan = buildUnderstandingPlan(understanding, { transcript: text, now: NOW, resolution: { endpoints: { 'm1.from': { status: 'resolved', accountId: 'cash' } } } });
  assert.equal(plan.components[0].item.eventNature, 'new');
  assert.equal(plan.components[0].item.intendedUse, 'long-term-use');
  assert.equal(plan.components[0].item.usefulLifeMonths, 36);
});

test('نقشه: دریافت وام امروز سند دارد، قسط‌های آینده نه', () => {
  const text = 'امروز ۱۲۰ میلیون وام از بانک ملت گرفتیم که به حساب ملت واریز شد، قسط اولش ماه بعد ده میلیونه';
  const output = {
    ...blank(), event: { kind: 'loan-received', description: 'دریافت وام', status: 'mixed' },
    amounts: [amount('a1', 120_000_000, '۱۲۰ میلیون وام'), amount('a2', 10_000_000, 'ده میلیونه', { role: 'installment', status: 'future' })],
    counterparties: [{ id: 'c1', name: 'بانک ملت', role: 'lender', evidence: 'وام از بانک ملت' }],
    movements: [movement('m1', 'a1', 'in', party('counterparty', 'بانک ملت'), party('bank', 'ملت'), 'به حساب ملت واریز شد')],
    dates: [{ id: 'd1', role: 'payment', expression: 'امروز', relative: 'today', jalali: { year: null, month: null, day: null } }],
  };
  const { understanding } = validateUnderstanding(output, { text, now: NOW });
  const plan = buildUnderstandingPlan(understanding, {
    transcript: text, now: NOW,
    resolution: { counterparties: { c1: { status: 'exact', contactId: 'k-bank', name: 'بانک ملت', candidates: [], balance: 0 } }, endpoints: { 'm1.to': { status: 'resolved', accountId: 'mellat-1' } } },
  });
  assert.deepEqual(plan.components.map((item) => [item.amount, item.item.receiptPurpose]), [[120_000_000, 'loan']]);
  assert.ok(plan.notes.some((note) => note.kind === 'future'));
});

test('نقشه: تسویه فقط روی سند باز؛ بدون سند به حسابدار، با چند سند سؤال', () => {
  const { understanding } = validateUnderstanding(qiasiOutput, { text: QIASI, now: NOW });
  const plan = (documents) => buildUnderstandingPlan(understanding, {
    transcript: QIASI, now: NOW,
    resolution: {
      counterparties: { c1: { status: 'exact', contactId: 'k1', name: 'شرکت قیاسی', candidates: [], balance: -80_000_000 } },
      endpoints: { 'm1.from': { status: 'resolved', accountId: 'saman' } }, documents: { k1: documents },
    },
  });
  const doc = (id, remaining) => ({ kind: 'obligation', id, direction: 'payable', remaining, reference: `بدهی ${id}` });
  assert.equal(plan([]).route, 'accountant', 'بدهیِ ثبت‌نشده را پرونده نمی‌سازد');
  assert.equal(plan([doc('o1', 30_000_000)]).route, 'accountant', 'پرداختِ بیش از ماندهٔ سند');
  const many = plan([doc('o1', 50_000_000), doc('o2', 30_000_000)]);
  assert.equal(many.route, 'needs-answers');
  assert.equal(many.questions[0].picker, 'document');
  const one = plan([doc('o1', 80_000_000)]);
  assert.equal(one.route, 'ready');
  assert.deepEqual(one.components.map((item) => [item.kind, item.amount, item.target.id, item.accountId]), [['settlement', 50_000_000, 'o1', 'saman']]);
});

// ---------------------------------------------------------------------------
// پرونده، روی دیتابیس واقعی و با مدل شبیه‌سازی‌شده
// ---------------------------------------------------------------------------

const databasePath = tempDatabase('understanding');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'understanding-owner';
process.env.ADMIN_PASSWORD = 'understanding-strong-password-9921';

const database = await import('../server/db.js');
const accounting = await import('../server/accounting.js');
database.ensureAdmin();
const owner = database.authenticateUser('understanding-owner', 'understanding-strong-password-9921');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر فهم رویداد', profileType: 'business' });
const other = database.createWorkspace(owner.id, { name: 'دفتر دیگر', profileType: 'business' });
const inWorkspace = (callback, id = workspace.id) => database.runInWorkspace(id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const env = { OPENAI_API_KEY: 'test-key-not-real', OPENAI_UNDERSTANDING_MODEL: 'test-model' };
const calls = [];
/** مدل شبیه‌سازی‌شده: هر متن خروجیِ از پیش نوشته‌شدهٔ خودش را دارد. */
const outputs = new Map();
const fetcher = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  const said = JSON.parse(body.input[1].content[0].text)['گفتهٔ کاربر'];
  const output = outputs.get(said);
  if (output instanceof Error) throw output;
  return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(output) }] }], usage: { input_tokens: 900, output_tokens: 400 } }) };
};
const options = { fetcher, env, now: NOW };

const PURCHASE = 'هشتاد میلیون جنس برای فروش از شرکت قیاسی نسیه خریدیم و تحویل گرفتیم';
outputs.set(PURCHASE, {
  ...blank(), event: { kind: 'purchase', description: 'خرید نسیهٔ کالا', status: 'done' },
  amounts: [amount('a1', 80_000_000, 'هشتاد میلیون', { role: 'credit-part' })],
  counterparties: [{ id: 'c1', name: 'شرکت قیاسی', role: 'supplier', evidence: 'از شرکت قیاسی نسیه خریدیم' }],
  movements: [movement('m1', 'a1', 'none', party('us'), party('counterparty', 'شرکت قیاسی'), 'نسیه خریدیم')],
  subject: { what: 'جنس', kind: 'goods', use: 'resale', delivered: 'yes', usefulLifeMonths: null, evidence: 'جنس برای فروش' },
});
outputs.set(QIASI, qiasiOutput);

const balanceOf = (id) => database.listAccounts().find((account) => account.id === id)?.balance;

let saman;
test('آماده‌سازی: موتور روشن، فهم فعال، حساب سامان', () => inWorkspace(() => {
  database.installChartTemplate();
  database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active' });
  saman = database.saveAccount({ name: 'جاری سامان', kind: 'bank', bankId: 'saman', openingBalance: 200_000_000 });
  assert.equal(database.automationPolicy().understandingMode, 'active');
}));

test('پرونده: درخواست به مدل فقط متن را دارد و متن جدا از دستور است', async () => {
  await inWorkspace(async () => {
    const item = await database.createUnderstandingCase({ text: PURCHASE, clientId: 'c-purchase' }, options);
    assert.equal(item.status, 'ready', JSON.stringify(item.plan?.questions || item.error));
    const request = calls.at(-1).body;
    assert.equal(request.input[0].role, 'system');
    assert.doesNotMatch(request.input[0].content[0].text, /قیاسی/);
    assert.equal(request.text.format.strict, true);
    assert.doesNotMatch(JSON.stringify(request), /جاری سامان|saman/, 'حساب‌ها و اشخاص دفتر به مدل نمی‌روند');
    const posted = database.commitUnderstandingCase(item.id, { now: NOW });
    assert.equal(posted.status, 'posted');
    assert.equal(posted.result.components[0].kind, 'obligation');
  });
});

let qiasiCase;
test('مثال الزامی روی دفتر: فقط ۵۰ میلیون پرداخت ثبت می‌شود، از بانک سامان، به‌عنوان تسویه', async () => {
  await inWorkspace(async () => {
    const before = balanceOf(saman.id);
    qiasiCase = await database.createUnderstandingCase({ text: QIASI, clientId: 'c-qiasi', source: 'voice' }, options);
    assert.equal(qiasiCase.status, 'ready', JSON.stringify(qiasiCase.plan));
    assert.deepEqual(qiasiCase.plan.components.map((item) => [item.kind, item.amount, item.accountId]), [['settlement', 50_000_000, saman.id]]);
    assert.deepEqual(qiasiCase.plan.notes.map((note) => note.kind).sort(), ['conditional', 'context', 'future']);
    const posted = database.commitUnderstandingCase(qiasiCase.id, { now: NOW });
    assert.equal(posted.status, 'posted');
    assert.equal(balanceOf(saman.id), before - 50_000_000);
    const contact = db().prepare("SELECT id FROM contacts WHERE name='شرکت قیاسی'").get();
    assert.equal(database.counterpartyCard(contact.id).totals.balance, -30_000_000, 'بدهی ۸۰ با پرداخت ۵۰ به ۳۰ رسید؛ بخشودگی شناسایی نشد');
    const income = db().prepare(`SELECT COALESCE(SUM(l.credit),0) AS total FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE a.type='income'`).get().total;
    assert.equal(income, 0, 'بخشودگی مشروط درآمد نساخت');
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

test('دو بار کلیک: سند دوم ساخته نمی‌شود', () => inWorkspace(() => {
  const count = () => [db().prepare('SELECT COUNT(*) AS n FROM transactions').get().n, db().prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n];
  const before = count();
  const again = database.commitUnderstandingCase(qiasiCase.id, { now: NOW });
  assert.equal(again.status, 'posted');
  assert.deepEqual(count(), before, 'نه ردیف تازه، نه سند تازه');
  assert.deepEqual(again.result, database.getUnderstandingCase(qiasiCase.id).result);
}));

test('کش: همان متن، پروندهٔ تازه، بدون درخواست دوم به مدل', async () => {
  await inWorkspace(async () => {
    const before = calls.length;
    const item = await database.createUnderstandingCase({ text: QIASI, clientId: 'c-qiasi-2' }, options);
    assert.equal(calls.length, before);
    assert.equal(item.ai.cacheHit, true);
    database.dismissUnderstandingCase(item.id);
  });
  // دفتر دیگر کش این دفتر را نمی‌بیند.
  await inWorkspace(async () => {
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active' });
    const before = calls.length;
    await database.createUnderstandingCase({ text: QIASI, clientId: 'c-other' }, options);
    assert.equal(calls.length, before + 1);
  }, other.id);
});

const UNKNOWN_BANK = 'سی میلیون جنس برای فروش از بانک تجارت خریدیم، ده میلیونش رو هم کرایه حمل دادیم';
outputs.set(UNKNOWN_BANK, {
  ...blank(), event: { kind: 'purchase', description: 'خرید کالا', status: 'done' },
  amounts: [amount('a1', 30_000_000, 'سی میلیون'), amount('a2', 10_000_000, 'ده میلیونش', { role: 'fee' })],
  movements: [movement('m1', 'a1', 'out', party('bank', 'بانک تجارت'), party('unknown'), 'از بانک تجارت خریدیم')],
  subject: { what: 'جنس', kind: 'goods', use: 'resale', delivered: 'unknown', usefulLifeMonths: null, evidence: 'جنس برای فروش' },
});

test('پاسخ: حساب با شناسهٔ واقعی؛ حساب ناموجود رد؛ سؤال جواب‌داده‌شده تکرار نمی‌شود', async () => {
  await inWorkspace(async () => {
    const item = await database.createUnderstandingCase({ text: UNKNOWN_BANK, clientId: 'c-bank' }, options);
    assert.equal(item.status, 'needs-answers');
    const accountQuestion = item.plan.questions.find((question) => question.picker === 'account');
    assert.ok(accountQuestion, JSON.stringify(item.plan.questions));
    await assert.rejects(() => database.answerUnderstandingCase(item.id, { [accountQuestion.id]: { valueId: 'not-a-real-account' } }, options), /فعال نیست/);
    const before = calls.length;
    const answered = await database.answerUnderstandingCase(item.id, { [accountQuestion.id]: { valueId: 'cash' } }, options);
    assert.equal(calls.length, before, 'پاسخِ انتخابی درخواست تازه به مدل نمی‌فرستد');
    assert.ok(!answered.plan.questions.some((question) => question.id === accountQuestion.id));
    assert.equal(answered.answers[accountQuestion.id].valueId, 'cash');
    assert.ok(answered.version > item.version, 'پاسخ نسخهٔ تازه می‌سازد');
  });
});

test('قطع یا خطای مدل: پرونده می‌ماند، سندی ساخته نمی‌شود، تلاش دوباره کار می‌کند', async () => {
  const text = 'دو فاکتور داریم یکی دوازده میلیون یکی هشت میلیون، هر دو رو از صندوق دادیم';
  outputs.set(text, Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
  await inWorkspace(async () => {
    const transactions = () => db().prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
    const before = transactions();
    const failed = await database.createUnderstandingCase({ text, clientId: 'c-timeout' }, options);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'UNDERSTANDING_TIMEOUT');
    assert.equal(failed.transcript, text, 'متن اصلی حفظ می‌شود');
    assert.throws(() => database.commitUnderstandingCase(failed.id), /قابل ثبت نیست/);
    assert.equal(transactions(), before);
    outputs.set(text, { ...blank(), event: { kind: 'expense', description: 'دو فاکتور', status: 'done' },
      amounts: [amount('a1', 12_000_000, 'دوازده میلیون'), amount('a2', 8_000_000, 'هشت میلیون')],
      movements: [movement('m1', 'a1', 'out', party('cash'), party('unknown'), 'از صندوق دادیم'), movement('m2', 'a2', 'out', party('cash'), party('unknown'), 'از صندوق دادیم')] });
    const retried = await database.retryUnderstandingCase(failed.id, options);
    assert.notEqual(retried.status, 'failed');
  });
});

test('خروجی خارج از قرارداد: رد کامل، بدون ذخیره در کش', async () => {
  const text = 'ده میلیون از صندوق به آقای کریمی دادیم و بیست میلیون گرفتیم';
  outputs.set(text, { ...blank(), postingPlan: [{ debit: 1 }] });
  await inWorkspace(async () => {
    const item = await database.createUnderstandingCase({ text, clientId: 'c-violation' }, options);
    assert.equal(item.status, 'failed');
    assert.equal(item.error.code, 'UNDERSTANDING_CONTRACT_VIOLATION');
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM understanding_extractions WHERE output LIKE ?').get('%postingPlan%').n, 0);
  });
});

test('شادو: مقایسه ساخته می‌شود و هیچ سند، ردیف یا ثبتی از مسیر تازه نیست', async () => {
  await inWorkspace(async () => {
    database.saveAutomationPolicy({ ...database.automationPolicy(), understandingMode: 'shadow' });
    const text = 'شصت میلیون فروش داشتیم، بیست نقد گرفتیم بقیه رو قراره هفته بعد بدن';
    outputs.set(text, { ...blank(), event: { kind: 'sale', description: 'فروش', status: 'mixed' },
      amounts: [amount('a1', 60_000_000, 'شصت میلیون'), amount('a2', 20_000_000, 'بیست نقد', { role: 'cash-part', partOf: 'a1' }),
        amount('a3', 40_000_000, 'بقیه', { role: 'credit-part', partOf: 'a1', basis: 'computed', computedFrom: { op: 'difference', of: ['a1', 'a2'] } })],
      movements: [movement('m1', 'a2', 'in', party('unknown'), party('cash'), 'بیست نقد گرفتیم')] });
    const before = db().prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
    const scheduled = database.scheduleShadowUnderstanding({ text, legacy: database.legacySnapshot('composite-review', { queued: 1 }), clientId: 'shadow-1' }, options);
    await scheduled.done;
    const item = database.getUnderstandingCase(scheduled.id);
    assert.equal(item.mode, 'shadow');
    assert.ok(item.comparison, JSON.stringify(item));
    assert.equal(item.comparison.legacyToAccountant, true);
    assert.equal(db().prepare('SELECT COUNT(*) AS n FROM transactions').get().n, before);
    assert.throws(() => database.commitUnderstandingCase(item.id), /شادو/);
    const report = database.understandingReport();
    assert.equal(report.total, 1);
    assert.equal(report.compared, 1);
  });
});

test.after(() => removeTempDatabase(databasePath));
