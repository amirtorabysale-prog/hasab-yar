import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * آزمون ۱۰۰ سناریوی حالت AI (۲۹ مهر ۱۴۰۵) — با خروجیِ واقعیِ مدل.
 *
 * `fixtures/scenarios-100-ai-model-outputs.json` همان چیزی است که مدل فهم روی سایت
 * برای این جمله‌ها برگرداند. این‌جا همان خروجی به سرور داده می‌شود و کل مسیر —
 * اعتبارسنجی، تطبیق با دفتر، نقشه، موتور قاعده و ثبت — اجرا می‌شود. هر خانواده یک
 * جملهٔ واقعیِ گزارش، شکل‌های دیگرش و نمونهٔ منفی‌ای دارد که نباید وارد مسیر شود.
 */

const fixture = JSON.parse(readFileSync(new URL('./fixtures/scenarios-100-ai-model-outputs.json', import.meta.url), 'utf8'));
const NOW = new Date(fixture.now);
const real = Object.fromEntries(fixture.cases.map((item) => [item.id, item]));

/** شکل دیگری از یک خروجیِ واقعی: همان ساختار، جملهٔ دیگر. */
const clone = (value) => JSON.parse(JSON.stringify(value));
const variants = new Map();
function variant(text, from, patch) {
  const output = clone(real[from].modelOutput);
  patch(output);
  variants.set(text, output);
  return text;
}

const oracle = (said) => variants.get(said) || fixture.cases.find((item) => item.transcript === said)?.modelOutput;
const fetcher = async (_url, init) => {
  const said = JSON.parse(JSON.parse(init.body).input[1].content[0].text)['گفتهٔ کاربر'];
  const output = oracle(said);
  if (!output) throw new Error(`خروجی مدل برای «${said}» در فیکسچر نیست`);
  return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(output) }] }], usage: {} }) };
};
const env = { OPENAI_API_KEY: 'oracle', OPENAI_UNDERSTANDING_MODEL: 'oracle' };

const databasePath = tempDatabase('scenarios-100-ai');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'hundred-owner';
process.env.ADMIN_PASSWORD = 'hundred-strong-password-5511';
const database = await import('../server/db.js');
const accounting = await import('../server/accounting.js');
database.ensureAdmin();
const owner = database.authenticateUser('hundred-owner', 'hundred-strong-password-5511');
test.after(() => removeTempDatabase(databasePath));

/** همان دفترِ راهنمای آزمون: صندوق، جاری ملت، جاری تجارت و حد سرمایه‌ای ۲۰ میلیون. */
async function ledger(name) {
  const workspace = database.createWorkspace(owner.id, { name, profileType: 'business' });
  const run = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
  await run(() => {
    database.installChartTemplate();
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all', capitalizationThreshold: 20_000_000 });
    database.saveAccount({ id: 'cash', name: 'صندوق نقدی', kind: 'cash', openingBalance: 100_000_000 });
    database.saveAccount({ name: 'جاری ملت', kind: 'bank', bankId: 'mellat', openingBalance: 500_000_000 });
    database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 200_000_000 });
  });
  return run;
}

let clientSeq = 0;
const say = (text) => database.createUnderstandingCase({ text, clientId: `hundred-${clientSeq += 1}` }, { fetcher, env, now: NOW });
const answer = (id, answers) => database.answerUnderstandingCase(id, answers, { fetcher, env, now: NOW });
const commit = (id) => {
  const item = database.commitUnderstandingCase(id, { now: NOW });
  assert.equal(accounting.trialBalance(database.activeWorkspaceDatabase()).balanced, true, 'تراز پس از ثبت');
  return item;
};
const roles = (item) => item.plan.components.flatMap((component) => component.preview?.lines || []).map((line) => `${line.role}:${line.debit || 0}:${line.credit || 0}`).sort();
const hasCashLine = (item) => item.plan.components.some((component) => (component.preview?.lines || []).some((line) => line.role === 'cash'));
const reasonsOf = (item) => [...(item.reasons || []), ...(item.plan?.reasons || [])].join(' ');

// ---------------------------------------------------------------------------
// مبلغی که مدل «جزءِ خودش» نوشت
// ---------------------------------------------------------------------------

test('R014: تنها مبلغی که مدل جزءِ خودش نوشت، همان پرداخت است — اجارهٔ ماه ثبت می‌شود', async () => {
  const run = await ledger('R014');
  const other = variant('۸ میلیون اجاره این ماه انبار از تجارت دادیم', 'R014', (output) => {
    output.amounts[0] = { ...output.amounts[0], value: 8_000_000, evidence: '۸ میلیون' };
    output.movements[0] = { ...output.movements[0], from: { kind: 'bank', name: 'تجارت' }, to: { kind: 'counterparty', name: null }, evidence: 'از تجارت دادیم' };
    output.counterparties = [];
    output.subject = { ...output.subject, what: 'اجاره این ماه انبار', evidence: 'اجاره این ماه انبار' };
  });
  await run(async () => {
    for (const [text, amount] of [[real.R014.transcript, 15_000_000], [other, 8_000_000]]) {
      const item = await say(text);
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify(item.plan?.reasons)}`);
      assert.deepEqual(item.plan.components.map((component) => [component.kind, component.amount]), [['cash', amount]]);
      commit(item.id);
    }
  });
});

// ---------------------------------------------------------------------------
// قبضی که آمده و فاکتوری که زده شده: بدهی و طلبِ امروز، پولش بعداً
// ---------------------------------------------------------------------------

test('R025 و R026: قبضِ آمده و فاکتورِ زده‌شده با «قراره بعداً» بدهی و طلبِ امروزند، بی سطر نقد', async () => {
  const run = await ledger('R025-R026');
  const water = variant('قبض آب ۲ میلیون اومده، قراره هفته بعد بدیم.', 'R025', (output) => {
    output.amounts[0] = { ...output.amounts[0], value: 2_000_000, evidence: '۲ میلیون' };
    output.dates = [];
    output.movements[0].evidence = 'قراره هفته بعد بدیم';
    output.conditions[0] = { ...output.conditions[0], text: 'قراره هفته بعد بدیم', evidence: 'قراره هفته بعد بدیم' };
    output.subject = { ...output.subject, what: 'قبض آب', evidence: 'قبض آب' };
  });
  const service = variant('فاکتور خدمات ۱۰ میلیونی برای آقای نوری زدیم، قراره ماه بعد بده.', 'R026', (output) => {
    output.event.kind = 'income';
    output.amounts = [{ ...output.amounts[1], value: 10_000_000, evidence: '۱۰ میلیونی' }];
    output.amounts[0].id = 'a2';
    output.counterparties[0] = { id: 'c1', name: 'آقای نوری', role: 'customer', evidence: 'برای آقای نوری' };
    output.movements[0] = { ...output.movements[0], from: { kind: 'counterparty', name: 'آقای نوری' }, evidence: 'قراره ماه بعد بده' };
    output.dates = [];
    output.subject = { ...output.subject, what: 'فاکتور خدمات', kind: 'service', category: 'خدمات', evidence: 'فاکتور خدمات' };
  });
  await run(async () => {
    for (const [text, flow, amount, payee] of [[real.R025.transcript, 'payable', 4_000_000, 'اداره برق'], [water, 'payable', 2_000_000, 'اداره آب'], [real.R026.transcript, 'receivable', 25_000_000], [service, 'receivable', 10_000_000]]) {
      let item = await say(text);
      // قبضِ بی‌نامِ طرف حساب: موتور می‌پرسد از کیست — همان سؤالِ کلید پاسخ («اداره برق»).
      if (payee) {
        assert.equal(item.status, 'needs-answers', text);
        assert.deepEqual(item.plan.questions.map((question) => question.text), ['طرف حساب چه کسی است؟']);
        item = await answer(item.id, { [item.plan.questions[0].id]: { value: payee } });
      }
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify(item.plan?.reasons || item.plan?.questions)}`);
      assert.deepEqual(item.plan.components.map((component) => [component.kind, component.flow, component.amount]), [['obligation', flow, amount]], text);
      assert.equal(hasCashLine(item), false, `${text}: پولی جابه‌جا نشده`);
    }
    // فروش نسیه به نامِ همان شرکت ثبت می‌شود، نه بی‌طرف‌حساب.
    const invoice = await say(real.R026.transcript);
    assert.ok(invoice.plan.components[0].contactId || invoice.plan.counterparties, 'طرف حساب دارد');
  });
});

test('نمونه‌های منفی: پیش‌فاکتور، قرار آینده و قبضی که هنوز نیامده هیچ سندی نمی‌سازند', async () => {
  const run = await ledger('منفی قبض');
  const notYet = variant('قبض برق ماه بعد میاد، حدود ۴ میلیون.', 'R025', (output) => {
    output.amounts[0].evidence = '۴ میلیون';
    output.dates = [];
    output.movements[0].evidence = 'ماه بعد میاد';
    output.conditions = [];
    output.subject = { ...output.subject, what: 'قبض برق', evidence: 'قبض برق' };
  });
  await run(async () => {
    for (const text of [real.R095.transcript, real.R096.transcript, real.R097.transcript, real.R098.transcript, real.R099.transcript, real.R100.transcript, notYet]) {
      const item = await say(text);
      assert.equal(item.status, 'no-entry', `${text}: ${JSON.stringify(item.plan?.components?.map((component) => component.kind))}`);
    }
  });
});

// ---------------------------------------------------------------------------
// نام شرکتی که واژهٔ یک بانک را دارد
// ---------------------------------------------------------------------------

test('R002: «شرکت آریا تجارت» طرف حساب است نه بانک تجارت؛ «حساب ملت» همچنان بانک است', async () => {
  const run = await ledger('R002');
  await run(async () => {
    const item = await say(real.R002.transcript);
    assert.equal(item.status, 'ready');
    assert.equal(item.plan.components.length, 1);
    const bank = database.activeWorkspaceDatabase().prepare("SELECT id FROM accounts WHERE bank_id='mellat'").get().id;
    assert.equal(item.plan.components[0].accountId, bank, 'پول به حساب ملت آمد');
    commit(item.id);
    assert.ok(database.activeWorkspaceDatabase().prepare("SELECT 1 FROM contacts WHERE name='شرکت آریا تجارت'").get(), 'طرف حساب ساخته شد');
  });
});

// ---------------------------------------------------------------------------
// نقش به‌جای نام: «تعمیرکار»، «مشتری»، «موجر»
// ---------------------------------------------------------------------------

test('R028 → R037: نام «تعمیرکار» پرسیده می‌شود؛ پرداختِ بعدی به همان شخص تسویهٔ بدهی است، نه هزینهٔ دوباره', async () => {
  const run = await ledger('R028-R037');
  await run(async () => {
    const debt = await say(real.R028.transcript);
    assert.equal(debt.status, 'needs-answers');
    assert.deepEqual(debt.plan.questions.map((question) => question.id), ['counterparties.c1.name']);
    const named = await answer(debt.id, { 'counterparties.c1.name': { value: 'آقای رضایی' } });
    assert.equal(named.status, 'ready', JSON.stringify(named.plan?.questions));
    commit(named.id);
    const contact = database.activeWorkspaceDatabase().prepare("SELECT id FROM contacts WHERE name='آقای رضایی'").get();
    assert.ok(contact, 'بدهی به نام آقای رضایی');
    assert.equal(database.activeWorkspaceDatabase().prepare("SELECT COUNT(*) AS n FROM contacts WHERE name='تعمیرکار'").get().n, 0, 'طرف حسابی به نام «تعمیرکار» ساخته نشد');

    const payment = await say(real.R037.transcript);
    assert.equal(payment.status, 'needs-answers', 'هزینهٔ دوباره ساخته نمی‌شود');
    const question = payment.plan.questions.find((item) => item.id.startsWith('settlements.'));
    assert.ok(question, 'می‌پرسد تسویهٔ کدام بدهی است');
    const document = question.options.find((option) => option.value !== 'new');
    const settled = await answer(payment.id, { [question.id]: { valueId: document.value } });
    assert.equal(settled.status, 'ready');
    assert.deepEqual(settled.plan.components.map((component) => component.kind), ['settlement']);
    assert.deepEqual(roles(settled), ['cash:0:3000000', 'payable:3000000:0']);
  });
});

test('R030، R057 و R058: «مشتری» و «موجر» نام نیستند؛ با نامِ گفته‌شده طلب، پیش‌دریافت و ودیعه ساخته می‌شود', async () => {
  const run = await ledger('نقش بی‌نام');
  await run(async () => {
    for (const [id, name, roleLine] of [['R030', 'شرکت آریا تجارت', 'receivable'], ['R057', 'شرکت آریا تجارت', 'customer-advance'], ['R058', 'آقای اسدی', 'refundable-deposit']]) {
      const item = await say(real[id].transcript);
      assert.equal(item.status, 'needs-answers', id);
      const ask = item.plan.questions.find((question) => question.id.endsWith('.name'));
      assert.ok(ask, `${id}: نام پرسیده می‌شود`);
      const named = await answer(item.id, { [ask.id]: { value: name } });
      if (named.status === 'needs-answers') {
        // ودیعهٔ ملک: استرداد پرسیده می‌شود؛ جمله گفته «پس می‌ده».
        assert.ok(named.plan.questions.every((question) => !question.id.endsWith('.name')), `${id}: نام دیگر پرسیده نمی‌شود`);
        continue;
      }
      assert.equal(named.status, 'ready', `${id}: ${JSON.stringify(named.plan?.reasons)}`);
      assert.ok(roles(named).some((line) => line.startsWith(`${roleLine}:`)), `${id}: ${roles(named)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// تسویهٔ فاکتور و قبضِ قبلی
// ---------------------------------------------------------------------------

test('R026 → R033: واریزِ شرکت بابت فاکتور قبلی طلب را می‌بندد، فروش دوباره ثبت نمی‌شود', async () => {
  const run = await ledger('R026-R033');
  await run(async () => {
    commit((await say(real.R026.transcript)).id);
    const receipt = await say(real.R033.transcript);
    const settled = receipt.status === 'needs-answers'
      ? await answer(receipt.id, Object.fromEntries(receipt.plan.questions.map((question) => [question.id, { valueId: question.options.find((option) => option.value !== 'new')?.value }])))
      : receipt;
    assert.equal(settled.status, 'ready', JSON.stringify(settled.plan?.reasons || settled.plan?.questions));
    assert.deepEqual(settled.plan.components.map((component) => component.kind), ['settlement']);
    assert.deepEqual(roles(settled), ['cash:25000000:0', 'receivable:0:25000000']);
  });
});

test('R025 → R035: پرداختِ قبضی که «اومده بود» هزینهٔ تازه نیست و با حسابدار است', async () => {
  const run = await ledger('R025-R035');
  await run(async () => {
    const bill = await say(real.R025.transcript);
    commit((await answer(bill.id, { [bill.plan.questions[0].id]: { value: 'اداره برق' } })).id);
    const payment = await say(real.R035.transcript);
    assert.equal(payment.status, 'needs-accountant');
    assert.match(reasonsOf(payment), /پیش‌تر آمده بود/);
  });
});

// ---------------------------------------------------------------------------
// حساب‌های هم‌خانوادهٔ اشتباه
// ---------------------------------------------------------------------------

test('R065: مساعده و علی‌الحساب حقوق طلب از کارمند است، نه پیش‌پرداخت خرید', async () => {
  const run = await ledger('R065');
  const onAccount = variant('۳ میلیون علی‌الحساب حقوق به آقای کریمی دادیم از صندوق.', 'R065', (output) => {
    output.amounts[0] = { ...output.amounts[0], value: 3_000_000, evidence: '۳ میلیون' };
    output.nonAmountNumbers = [];
    output.counterparties[0] = { id: 'c1', name: 'آقای کریمی', role: 'employee', evidence: 'آقای کریمی' };
    output.movements[0] = { ...output.movements[0], to: { kind: 'counterparty', name: 'آقای کریمی' }, evidence: 'به آقای کریمی دادیم از صندوق' };
    output.conditions = [];
    output.subject = { ...output.subject, what: 'علی‌الحساب حقوق', evidence: 'علی‌الحساب حقوق' };
  });
  await run(async () => {
    for (const text of [real.R065.transcript, onAccount]) {
      const item = await say(text);
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify(item.plan?.reasons)}`);
      assert.ok(roles(item).some((line) => line.startsWith('employee-advance:')), `${text}: ${roles(item)}`);
      assert.ok(!roles(item).some((line) => line.startsWith('supplier-advance:') || line.startsWith('prepaid-asset:')));
    }
  });
});

test('R089: واریزی که «نمی‌دونم از کیه» وجوهِ تعیین‌تکلیف‌نشده است، نه درآمد', async () => {
  const run = await ledger('R089');
  const unknown = variant('۳ میلیون ریختن به ملت، معلوم نیست از کیه.', 'R089', (output) => {
    output.amounts[0] = { ...output.amounts[0], value: 3_000_000, evidence: '۳ میلیون' };
    output.movements[0] = { ...output.movements[0], to: { kind: 'bank', name: 'ملت' }, evidence: 'ریختن به ملت' };
  });
  await run(async () => {
    for (const text of [real.R089.transcript, unknown]) {
      const item = await say(text);
      assert.ok(!roles(item).some((line) => line.startsWith('income-category:')), `${text}: درآمد نشد — ${roles(item)}`);
      assert.ok(roles(item).some((line) => line.startsWith('unidentified-receipt:')) || item.status === 'needs-accountant', `${text}: ${item.status} ${roles(item)}`);
    }
  });
});

test('R032: فروشِ نسیهٔ کالا «فروش» است، نه «سایر درآمدها»', async () => {
  const run = await ledger('R032');
  await run(async () => {
    const item = await say(real.R032.transcript);
    assert.equal(item.status, 'ready');
    assert.equal(item.plan.components[0].category, 'فروش');
  });
});

// ---------------------------------------------------------------------------
// تعمیر یا دارایی
// ---------------------------------------------------------------------------

test('R048: تعویضِ قطعهٔ سوخته تعمیر است؛ خریدِ همان کلید بی‌خرابی همان ملزومات می‌ماند', async () => {
  const run = await ledger('R048');
  const plain = variant('یه کلید برق ۴۵۰ هزار تومانی برای دفتر خریدیم؛ نقد از صندوق.', 'R048', (output) => {
    output.subject = { ...output.subject, what: 'کلید برق', evidence: 'یه کلید برق' };
  });
  await run(async () => {
    const replaced = await say(real.R048.transcript);
    assert.equal(replaced.plan.components[0].category, 'تعمیر و نگهداری');
    const motor = await say(real.R053.transcript);
    assert.equal(motor.plan.components[0].category, 'تعمیر و نگهداری');
    const bought = await say(plain);
    assert.equal(bought.plan.components[0].category, 'ملزومات اداری');
  });
});

test('R050: بازسازی و ارتقای اساسیِ بالای حد سرمایه‌ای با حسابدار است؛ زیر حد هزینه، و تعمیرِ عادی تعمیر', async () => {
  const run = await ledger('R050');
  const small = variant('تابلوی برق ساختمان رو با ۵ میلیون تومان کامل بازسازی و ارتقا دادیم؛ نقد از صندوق.', 'R050', (output) => {
    output.amounts[0] = { ...output.amounts[0], value: 5_000_000, evidence: '۵ میلیون تومان' };
    output.subject.evidence = 'تابلوی برق ساختمان رو با ۵ میلیون تومان کامل بازسازی و ارتقا دادیم';
  });
  await run(async () => {
    const big = await say(real.R050.transcript);
    assert.notEqual(big.status, 'ready', 'بالای حد خودکار هزینه نمی‌شود');
    assert.ok(!roles(big).some((line) => line.startsWith('expense-category:22000000')), `${roles(big)}`);
    const below = await say(small);
    assert.equal(below.status, 'ready', JSON.stringify(below.plan?.reasons));
    const repair = await say(real.R053.transcript);
    assert.equal(repair.status, 'ready');
  });
});

// ---------------------------------------------------------------------------
// شریک، مالک، برگشت و تحویلِ بی‌مبلغ
// ---------------------------------------------------------------------------

test('R042: برداشتِ شخصیِ کسی که با نام گفته شده با حسابدار است؛ «برای خودم برداشتم» برداشتِ مالک می‌ماند', async () => {
  const run = await ledger('R042');
  const mine = variant('۸ میلیون از حساب تجارت برای خرج شخصی خودم برداشتم.', 'R042', (output) => {
    output.counterparties = [];
    output.subject = { ...output.subject, evidence: 'برای خرج شخصی خودم' };
  });
  await run(async () => {
    const named = await say(real.R042.transcript);
    assert.equal(named.status, 'needs-accountant');
    assert.match(reasonsOf(named), /مالکِ دفتر است یا شریک/);
    const own = await say(mine);
    assert.notEqual(own.status, 'needs-accountant', JSON.stringify(own.plan?.reasons));
  });
});

test('R043: قبضی که شریک از جیب خودش داد هزینه است در برابر جاری او، نه بدهیِ بی‌نام', async () => {
  const run = await ledger('R043');
  await run(async () => {
    const item = await say(real.R043.transcript);
    assert.equal(hasCashLine(item), false, 'از حساب شرکت پولی نرفت');
    assert.ok(!roles(item).some((line) => line.startsWith('payable:')), `${roles(item)}`);
    assert.ok(roles(item).some((line) => line.startsWith('expense-category:700000')), `${roles(item)}`);
  });
});

test('R083: برگشتِ جنس به فروشنده خرید تازه نیست — با حسابدار است', async () => {
  const run = await ledger('R083');
  const other = variant('۲ میلیون جنس معیوب رو به پخش گلستان برگرداندیم.', 'R083', (output) => {
    output.amounts = [{ ...output.amounts[0], value: 2_000_000, evidence: '۲ میلیون' }];
    output.movements[0].evidence = 'به پخش گلستان برگرداندیم';
    output.counterparties[0].evidence = 'پخش گلستان';
    output.subject = { ...output.subject, what: 'جنس معیوب', evidence: 'جنس معیوب' };
  });
  await run(async () => {
    for (const text of [real.R083.transcript, other]) {
      const item = await say(text);
      assert.equal(item.status, 'needs-accountant', text);
      assert.match(reasonsOf(item), /برگشت یا استرداد/);
      assert.throws(() => database.commitUnderstandingCase(item.id, { now: NOW }), 'پروندهٔ حسابدار سندی نمی‌زند');
    }
  });
});

test('R060: کارِ تحویل‌شده بی‌مبلغ بی‌صدا بسته نمی‌شود؛ تحویلِ فردا هم سندی ندارد', async () => {
  const run = await ledger('R060');
  await run(async () => {
    const delivered = await say(real.R060.transcript);
    assert.equal(delivered.status, 'needs-accountant');
    const tomorrow = await say(real.R098.transcript);
    assert.equal(tomorrow.status, 'no-entry');
  });
});

// ---------------------------------------------------------------------------
// آنچه درست بود، درست می‌ماند
// ---------------------------------------------------------------------------

test('موارد درستِ همان آزمون همان‌طور می‌مانند', async () => {
  const run = await ledger('درست‌ها');
  await run(async () => {
    for (const [id, kind, amount] of [['R027', 'obligation', 18_000_000], ['R031', 'obligation', 850_000], ['R051', 'cash', 18_000_000], ['R054', 'cash', 36_000_000]]) {
      let item = await say(real[id].transcript);
      if (id === 'R031') item = await answer(item.id, { [item.plan.questions[0].id]: { value: 'شرکت گاز' } });
      assert.equal(item.status, 'ready', `${id}: ${JSON.stringify(item.plan?.reasons || item.plan?.questions)}`);
      assert.deepEqual(item.plan.components.map((component) => [component.kind, component.amount]), [[kind, amount]], id);
    }
  });
});

test('R049: پیشنهادِ صف که کالای ماندگارِ بالای حد را هزینه کرده، با سیاست دفتر نمی‌خواند', async () => {
  const { capitalizationIssues } = await import('../server/reviewCapitalization.js');
  const expensed = [{ role: 'expense-category', debit: 25_000_000, credit: 0 }, { role: 'cash', debit: 0, credit: 25_000_000 }];
  assert.equal(capitalizationIssues(20_000_000, expensed, { durable: true }).length, 1, 'پرینتر ۲۵ میلیونی هزینه نمی‌شود');
  assert.equal(capitalizationIssues(20_000_000, expensed, { durable: false }).length, 0, 'هزینهٔ خدمت بالای حد ایرادی ندارد');
  const small = [{ role: 'expense-category', debit: 5_000_000, credit: 0 }, { role: 'cash', debit: 0, credit: 5_000_000 }];
  assert.equal(capitalizationIssues(20_000_000, small, { durable: true }).length, 0, 'کالای ماندگارِ زیر حد هزینه است');
  const asset = [{ role: 'fixed-asset', debit: 5_000_000, credit: 0 }, { role: 'cash', debit: 0, credit: 5_000_000 }];
  assert.equal(capitalizationIssues(20_000_000, asset).length, 1, 'دارایی ثابتِ زیر حد همان ایرادِ قبلی');
});
