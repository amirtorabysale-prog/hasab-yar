import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { runVoice } from './helpers/voicePipeline.js';
import { unpaidVatTotal } from '../shared/unpaidVatTotal.js';
import { topicParts } from '../shared/topicParts.js';
import { classifyCategory } from '../shared/categoryRules.js';
import { runGuards } from '../shared/guards.js';
import { EVENT_KINDS, normalizeFinancialEvent } from '../shared/financialEvent.js';
import { factsFromEvent } from '../shared/eventFacts.js';
import { decide } from '../shared/accountingDecision.js';
import { meaningfulTopicLabel } from '../server/chartOfAccounts.js';

/**
 * چهار تصمیمِ بازِ آزمون زندهٔ ۴ آبان ۱۴۰۵ — با خروجیِ واقعیِ مدل از سایت.
 *
 * `fixtures/live-ai-1405-08-04-model-outputs.json` همان چیزی است که مدل فهم برای
 * این جمله‌ها برگرداند. کل مسیر سرور — اعتبارسنجی، تطبیق با دفتر، نقشه، موتور
 * قاعده و ثبت — روی همان خروجی اجرا می‌شود.
 */

const fixture = JSON.parse(readFileSync(new URL('./fixtures/live-ai-1405-08-04-model-outputs.json', import.meta.url), 'utf8'));
const NOW = new Date(fixture.now);
const real = Object.fromEntries(fixture.cases.map((item) => [item.id, item]));

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

const databasePath = tempDatabase('live-ai-four-decisions');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'four-owner';
process.env.ADMIN_PASSWORD = 'four-strong-password-5511';
const database = await import('../server/db.js');
const accounting = await import('../server/accounting.js');
database.ensureAdmin();
const owner = database.authenticateUser('four-owner', 'four-strong-password-5511');
test.after(() => removeTempDatabase(databasePath));

/** دفتر راهنمای آزمون؛ `vatRates` نرخ‌های مشمول ارزش افزوده به درصد (خالی = نامشمول). */
async function ledger(name, { vatRates = [] } = {}) {
  const workspace = database.createWorkspace(owner.id, { name, profileType: 'business' });
  const run = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
  await run(() => {
    database.installChartTemplate();
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all', capitalizationThreshold: 20_000_000 });
    database.saveAccount({ id: 'cash', name: 'صندوق نقدی', kind: 'cash', openingBalance: 100_000_000 });
    database.saveAccount({ name: 'جاری ملت', kind: 'bank', bankId: 'mellat', openingBalance: 500_000_000 });
    database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 200_000_000 });
    for (const rate of vatRates) database.saveTaxRate({ name: `مشمول ${rate} درصد`, rate, treatment: 'taxable', isDefault: true });
  });
  return run;
}

let clientSeq = 0;
const say = (text) => database.createUnderstandingCase({ text, clientId: `four-${clientSeq += 1}` }, { fetcher, env, now: NOW });
const answer = (id, answers) => database.answerUnderstandingCase(id, answers, { fetcher, env, now: NOW });
const commit = (id) => {
  const item = database.commitUnderstandingCase(id, { now: NOW });
  assert.equal(accounting.trialBalance(database.activeWorkspaceDatabase()).balanced, true, 'تراز پس از ثبت');
  return item;
};
const roles = (item) => item.plan.components.flatMap((component) => component.preview?.lines || []).map((line) => `${line.role}:${line.debit || 0}:${line.credit || 0}`).sort();
const sql = (query, ...args) => database.activeWorkspaceDatabase().prepare(query).all(...args);
/** به هر سؤال باز، مقدارِ داده‌شده (با تکه‌ای از شناسه یا متن سؤال) یا اولین گزینه. */
async function answerAll(item, picks = {}) {
  for (let round = 0; round < 4 && item.status === 'needs-answers'; round += 1) {
    const replies = Object.fromEntries(item.plan.questions.map((question) => {
      const wanted = Object.entries(picks).find(([fragment]) => question.id.includes(fragment) || question.text.includes(fragment))?.[1];
      const value = wanted ?? question.options?.[0]?.value ?? 'x';
      return [question.id, question.picker === 'options' || !question.options?.length ? { value } : { valueId: value }];
    }));
    item = await answer(item.id, replies);
  }
  return item;
}

// ---------------------------------------------------------------------------
// ۲. «۴۰ میلیون به‌علاوهٔ ۱۰ درصد ارزش افزوده، پولش هنوز ندادیم»
// ---------------------------------------------------------------------------

const VAT_BUY = real['vat-on-top-unpaid'].transcript;
const REGISTERED = { ratesBps: [1000], rateBps: 1000, outputTax: 0 };

test('ارزش افزودهٔ روی فاکتور پرداخت‌نشده (مسیر AI): مالیات «آینده» نیست؛ بدهی ۴۴ = ۴۰ کالا + ۴ اعتبار', async () => {
  const run = await ledger('vat-ai', { vatRates: [10] });
  await run(async () => {
    let item = await say(VAT_BUY);
    assert.ok(!item.plan.notes.some((note) => note.kind === 'future'), JSON.stringify(item.plan.notes));
    assert.ok(item.plan.notes.some((note) => note.kind === 'vat'));
    assert.ok(!item.plan.questions.some((question) => /جمع فاکتور/.test(question.text)), 'جمع از خودِ جمله معلوم است');
    // «فروش مجدد» در جمله گفته نشده؛ کاربرد پرسیده می‌شود (همان سؤال کلید پاسخ R068).
    item = await answerAll(item, { intendedUse: 'resale' });
    assert.equal(item.status, 'ready', JSON.stringify([item.plan.reasons, item.plan.questions]));
    const [component] = item.plan.components;
    assert.deepEqual([component.kind, component.amount], ['obligation', 44_000_000]);
    assert.match(component.label, /۴۴٬۰۰۰٬۰۰۰.*۴۰٬۰۰۰٬۰۰۰ \+ ۴٬۰۰۰٬۰۰۰ ارزش افزوده/);
    assert.deepEqual(roles(item), ['inventory-unsplit:40000000:0', 'payable:0:44000000', 'vat-input:4000000:0'].sort());
    commit(item.id);
    const [obligation] = sql("SELECT amount,direction FROM obligations WHERE status='open'");
    assert.deepEqual({ ...obligation }, { amount: 44_000_000, direction: 'payable' });
  });
});

test('ارزش افزوده: دفترِ نامشمول اعتبار خرید ندارد — کل ۴۴ بهای کالاست؛ نرخِ تعریف‌نشده به حسابدار', async () => {
  const plain = await ledger('vat-plain');
  await plain(async () => {
    const item = await answerAll(await say(VAT_BUY), { intendedUse: 'resale' });
    assert.equal(item.status, 'ready');
    assert.deepEqual(roles(item), ['inventory-unsplit:44000000:0', 'payable:0:44000000']);
  });
  const nine = variant('فاکتور خرید از شرکت پخش گلستان زدیم ۴۰ میلیون تومان به‌علاوهٔ ۹ درصد ارزش افزوده، پولش هنوز ندادیم.', 'vat-on-top-unpaid', (output) => {
    output.amounts[1].evidence = '۹ درصد ارزش افزوده';
    output.nonAmountNumbers = [{ value: '9', role: 'percentage', evidence: '۹ درصد' }];
  });
  const registered = await ledger('vat-nine', { vatRates: [10] });
  await registered(async () => {
    const item = await answerAll(await say(nine), { intendedUse: 'resale' });
    assert.equal(item.status, 'needs-accountant');
    assert.match(item.plan.reasons.join(' '), /نرخ ۹ درصد/);
  });
});

test('ارزش افزوده (مسیر بی‌AI): خانوادهٔ جمله — خرید، فروش، نرخ به حروف؛ و نمونه‌های منفی', () => {
  const said = (text) => runVoice(text, { vat: REGISTERED }).items[0];
  const planOf = (item) => (item.guards?.plan?.lines || []).map((line) => `${line.role}:${line.debit}:${line.credit}`).sort();
  const buy = said(VAT_BUY);
  assert.equal(buy.amount, 44_000_000);
  assert.deepEqual(planOf(buy), ['inventory-unsplit:40000000:0', 'payable:0:44000000', 'vat-input:4000000:0'].sort());
  const words = said('فاکتور خرید از شرکت پخش گلستان زدیم چهل میلیون تومان به علاوه ده درصد ارزش افزوده، پولش هنوز ندادیم');
  assert.equal(words.amount, 44_000_000);
  // آینهٔ فروش: طلبِ ۳۳ = ۳۰ فروش + ۳ بدهی مالیات؛ ردیف نقدی نه.
  const sale = said('به شرکت آلفا ۳۰ میلیون به‌علاوهٔ ۱۰ درصد ارزش افزوده جنس فروختیم، پولش رو هنوز نگرفتیم');
  assert.equal(sale.kind, 'receivable-opened');
  assert.equal(sale.amount, 33_000_000, JSON.stringify(sale.reason));
  assert.deepEqual(planOf(sale), ['income-category:0:30000000', 'receivable:33000000:0', 'vat-output:0:3000000'].sort());
  // نرخ گفته نشده: جمع از جمله درنمی‌آید.
  const bare = said('فاکتور خرید از شرکت پخش گلستان زدیم ۴۰ میلیون به علاوه ارزش افزوده، پولش هنوز ندادیم');
  assert.equal(bare.amount, 40_000_000);
  assert.match(bare.reason, /جمع فاکتور با ارزش افزوده چقدر است/);
  // پول جابه‌جا شده: مبلغ واقعیِ پرداخت را فقط ثبت‌کننده می‌داند.
  const paid = said('خرید ۴۰ میلیون به علاوه ۱۰ درصد ارزش افزوده نقد دادیم');
  assert.equal(paid.amount, 40_000_000);
  assert.match(paid.reason, /پولی که واقعاً جابه‌جا شد/);
});

test('ارزش افزوده: جمعِ گفته‌شده دوباره جمع نمی‌شود؛ ریال و تومان یک جمع؛ رویدادِ ۴۰ نگهبان را ۳۶٫۴ نمی‌کند', () => {
  const said = 'فاکتور خرید ۴۰ میلیون به‌علاوهٔ ۱۰ درصد ارزش افزوده شد ۴۴ میلیون، پولش هنوز ندادیم';
  assert.equal(unpaidVatTotal(said, 40_000_000).gross, 44_000_000);
  assert.equal(unpaidVatTotal(said, 44_000_000), null);
  assert.equal(unpaidVatTotal(VAT_BUY, 400_000_000).gross, 440_000_000);
  assert.equal(unpaidVatTotal(said, 440_000_000), null);
  assert.equal(unpaidVatTotal('فاکتور خرید ۴۰ میلیون با احتساب ۱۰ درصد ارزش افزوده', 40_000_000), null);
  const event = normalizeFinancialEvent({ kind: EVENT_KINDS.PAYABLE_OPENED, amount: 40_000_000, occurredAt: '2026-10-26T00:00:00.000Z', category: 'مواد و کالا', counterparty: 'شرکت پخش گلستان', evidence: VAT_BUY });
  const facts = factsFromEvent(event);
  const check = runGuards(event, facts, { decision: decide(facts, { today: '2026-10-26T00:00:00.000Z' }), vat: REGISTERED }).checks.find((item) => item.name === 'vat-split');
  assert.equal(check.verdict, 'block');
});

// ---------------------------------------------------------------------------
// ۳. «قهوهٔ دفتر رو ۴۲۰ هزار تومان از ملت گرفتیم»
// ---------------------------------------------------------------------------

const COFFEE = real['goods-taken-from-our-bank'].transcript;

test('«X رو از ملت گرفتیم» (مسیر AI): بهای کالا از حساب ملت رفت؛ دریافت نیست', async () => {
  const run = await ledger('coffee');
  const cartridge = variant('کارتریج پرینتر رو ۹۰۰ هزار تومان از تجارت گرفتیم', 'goods-taken-from-our-bank', (output) => {
    output.amounts[0] = { ...output.amounts[0], value: 900_000, evidence: '۹۰۰ هزار تومان' };
    output.counterparties = [{ id: 'c1', name: 'تجارت', role: 'bank', evidence: 'تجارت' }];
    output.movements[0] = { ...output.movements[0], from: { kind: 'bank', name: 'تجارت' }, evidence: 'از تجارت گرفتیم' };
    output.subject = { ...output.subject, what: 'کارتریج پرینتر', category: 'ملزومات اداری', evidence: 'کارتریج پرینتر' };
  });
  const fromCash = variant('آب معدنی دفتر رو ۲۱۰ هزار از صندوق گرفتیم', 'goods-taken-from-our-bank', (output) => {
    output.amounts[0] = { ...output.amounts[0], value: 210_000, evidence: '۲۱۰ هزار' };
    output.counterparties = [];
    output.movements[0] = { ...output.movements[0], from: { kind: 'cash', name: 'صندوق' }, evidence: 'از صندوق گرفتیم' };
    output.subject = { ...output.subject, what: 'آب معدنی دفتر', evidence: 'آب معدنی دفتر' };
  });
  await run(async () => {
    const account = (name) => database.listAccounts().find((item) => item.name === name);
    for (const [text, name, amount] of [[COFFEE, 'جاری ملت', 420_000], [cartridge, 'جاری تجارت', 900_000], [fromCash, 'صندوق نقدی', 210_000]]) {
      const before = account(name).balance;
      const item = await say(text);
      assert.equal(item.status, 'ready', `${text}: ${JSON.stringify([item.plan.questions, item.plan.reasons])}`);
      const [component] = item.plan.components;
      assert.deepEqual([component.kind, component.flow, component.accountId], ['cash', 'out', account(name).id], text);
      commit(item.id);
      assert.equal(account(name).balance, before - amount, text);
    }
  });
});

test('منفی: وامِ بانک با همان شکلِ «از ملت گرفتیم» دریافت می‌ماند', async () => {
  const run = await ledger('coffee-negative');
  const loan = variant('۲۰۰ میلیون وام از بانک ملت گرفتیم', 'goods-taken-from-our-bank', (output) => {
    output.event = { kind: 'loan-received', description: 'وام از بانک ملت', status: 'done' };
    output.amounts[0] = { ...output.amounts[0], value: 200_000_000, role: 'received-now', evidence: '۲۰۰ میلیون' };
    output.counterparties = [{ id: 'c1', name: 'بانک ملت', role: 'lender', evidence: 'بانک ملت' }];
    output.movements[0] = { ...output.movements[0], from: { kind: 'counterparty', name: 'بانک ملت' }, to: { kind: 'bank', name: 'ملت' }, evidence: 'وام از بانک ملت گرفتیم' };
    output.subject = { what: 'وام', kind: 'other', use: 'unknown', category: null, delivered: 'unknown', usefulLifeMonths: null, evidence: null };
  });
  await run(async () => {
    const item = await say(loan);
    assert.ok(item.plan.components.every((component) => component.flow !== 'out'), JSON.stringify(item.plan.components));
    assert.ok(!item.understanding.movements.some((movement) => movement.direction === 'out'));
  });
});

test('«از ملت گرفتیم» (مسیر بی‌AI): وام و قرض دریافت‌اند، کالا پرداخت', () => {
  const lines = (text) => (runVoice(text).items[0].plan?.lines || []).map((line) => `${line.role}:${line.debit}:${line.credit}`).sort();
  assert.deepEqual(lines('۲۰۰ میلیون وام از بانک ملت گرفتیم'), ['cash:200000000:0', 'loan-payable:0:200000000']);
  assert.deepEqual(lines('۳۰ میلیون قرض از آقای نوری گرفتیم'), ['cash:30000000:0', 'loan-payable:0:30000000']);
  assert.equal(runVoice('۵۰ میلیون وام از ملت گرفتیم').items[0].kind, 'cash-income');
  assert.equal(runVoice(COFFEE).items[0].kind, 'cash-expense');
  assert.equal(runVoice('کارتریج پرینتر ۹۰۰ هزار از ملت گرفتیم').items[0].kind, 'cash-expense');
  // منفی: پرداختِ قسط وام پرداخت می‌ماند.
  assert.equal(runVoice('۵ میلیون قسط وام از ملت دادیم').items[0].kind, 'cash-expense');
});

// ---------------------------------------------------------------------------
// ۱. برچسب = «چه چیزی»؛ محل = مرکز هزینه
// ---------------------------------------------------------------------------

test('برچسب موضوع: «قهوه»، «قهوهٔ دفتر» و «قهوه برای دفتر» یک برچسب‌اند؛ اجارهٔ دفتر و مغازه دو تا', () => {
  for (const label of ['قهوه', 'قهوهٔ دفتر', 'قهوه‌ی دفتر', 'قهوه برای دفتر']) assert.equal(meaningfulTopicLabel(label, 'خوراک'), 'قهوه', label);
  for (const label of ['کارتریج پرینتر', 'یه کارتریج پرینتر دیگه']) assert.equal(meaningfulTopicLabel(label, 'ملزومات اداری'), 'کارتریج پرینتر', label);
  assert.equal(meaningfulTopicLabel('دو کارتن آب معدنی', 'خوراک'), 'آب معدنی');
  assert.equal(meaningfulTopicLabel('اجارهٔ دفتر', 'اجاره'), 'اجارهٔ دفتر');
  assert.equal(meaningfulTopicLabel('اجاره مغازه', 'اجاره'), 'اجاره مغازه');
  assert.equal(meaningfulTopicLabel('اجاره', 'اجاره'), '');
  // زیر دستهٔ عمومی هم اجارهٔ دفتر و مغازه یکی نمی‌شوند: محل جزءِ خدمتِ روی محل است.
  assert.equal(meaningfulTopicLabel('اجاره دفتر', 'سایر هزینه‌ها'), 'اجاره دفتر');
  assert.notEqual(meaningfulTopicLabel('اجاره مغازه', 'سایر هزینه‌ها'), meaningfulTopicLabel('اجاره دفتر', 'سایر هزینه‌ها'));
  assert.deepEqual(topicParts('لوازم التحریر دفتر کار'), { item: 'لوازم التحریر', place: 'دفتر کار' });
  // منفی: «دفترچه» و «دفتر» تنها محل نیستند.
  assert.deepEqual(topicParts('دفترچه حساب'), { item: 'دفترچه حساب', place: null });
  assert.deepEqual(topicParts('دفتر'), { item: 'دفتر', place: null });
});

test('برچسب و مرکز هزینه در سند: یک تفصیلیِ «قهوه»؛ «دفتر» فقط وقتی مرکز هزینه است که تعریف شده باشد', async () => {
  const forOffice = variant('۳۸۰ هزار تومان قهوه برای دفتر از ملت خریدیم', 'goods-taken-from-our-bank', (output) => {
    output.amounts[0] = { ...output.amounts[0], value: 380_000, evidence: '۳۸۰ هزار تومان' };
    output.movements[0] = { ...output.movements[0], direction: 'out', from: { kind: 'bank', name: 'ملت' }, to: { kind: 'unknown', name: null }, evidence: 'از ملت خریدیم' };
    output.subject = { ...output.subject, what: 'قهوه برای دفتر', evidence: 'قهوه برای دفتر' };
  });
  const categoryLine = () => sql(`SELECT aa.name AS analytic, jl.cost_center_id AS costCenterId FROM journal_lines jl
    JOIN analytic_accounts aa ON aa.id=jl.analytic_id WHERE aa.source_kind='topic-label' ORDER BY jl.rowid DESC LIMIT 1`)[0];
  const bare = await ledger('topic-no-center');
  await bare(async () => {
    commit((await say(COFFEE)).id);
    assert.deepEqual({ ...categoryLine() }, { analytic: 'قهوه', costCenterId: null });
  });
  const centred = await ledger('topic-center');
  await centred(async () => {
    const office = database.saveCostCenterEntry({ code: '10', name: 'دفتر' });
    commit((await say(COFFEE)).id);
    assert.deepEqual({ ...categoryLine() }, { analytic: 'قهوه', costCenterId: office.id });
    commit((await say(forOffice)).id);
    assert.deepEqual({ ...categoryLine() }, { analytic: 'قهوه', costCenterId: office.id });
    assert.equal(sql("SELECT COUNT(*) AS n FROM analytic_accounts WHERE source_kind='topic-label'")[0].n, 1);
  });
});

// ---------------------------------------------------------------------------
// ۴. آب معدنی دفتر: یک قلم، یک دسته
// ---------------------------------------------------------------------------

const water = (text, amount, patch) => variant(text, 'goods-taken-from-our-bank', (output) => {
  output.amounts[0] = { ...output.amounts[0], value: amount, evidence: text.match(/[۰-۹]+ (?:هزار|میلیون) تومان/)[0] };
  output.counterparties = [{ id: 'c1', name: 'ملت', role: 'bank', evidence: 'ملت' }];
  output.movements[0] = { ...output.movements[0], direction: 'out', from: { kind: 'bank', name: 'ملت' }, to: { kind: 'unknown', name: null }, evidence: 'از ملت خریدیم' };
  patch(output);
});

test('آب معدنی: «فروش مجدد» بی‌نشانه پذیرفته نمی‌شود و مصرف داخلی «مواد و کالا» نمی‌گیرد', async () => {
  const run = await ledger('water');
  // همان سه جملهٔ آزمون زنده، با همان برچسب‌های مدل.
  const office = water('آب معدنی دفتر ۲۱۰ هزار تومان از ملت خریدیم', 210_000, (output) => {
    output.subject = { ...output.subject, what: 'آب معدنی دفتر', use: 'internal', category: 'مواد و کالا', evidence: 'آب معدنی دفتر' };
  });
  const cartons = water('دو کارتن آب معدنی ۲۴۰ هزار تومان از ملت خریدیم', 240_000, (output) => {
    output.subject = { ...output.subject, what: 'دو کارتن آب معدنی', use: 'resale', category: 'مواد و کالا', evidence: 'دو کارتن آب معدنی' };
  });
  const forSale = water('۳۰ کارتن آب معدنی برای فروش ۳ میلیون تومان از ملت خریدیم', 3_000_000, (output) => {
    output.subject = { ...output.subject, what: 'آب معدنی', use: 'resale', category: 'مواد و کالا', evidence: '۳۰ کارتن آب معدنی برای فروش' };
  });
  await run(async () => {
    const officeItem = await say(office);
    assert.equal(officeItem.status, 'ready', JSON.stringify(officeItem.plan.questions));
    assert.equal(officeItem.plan.components[0].category, 'خوراک');
    const cartonItem = await say(cartons);
    assert.equal(cartonItem.understanding.subject.use, 'unknown');
    assert.notEqual(cartonItem.plan.components[0]?.preview?.treatment, 'inventory-purchase');
    // منفی: «برای فروش» در جمله هست؛ موجودی کالا درست است.
    const saleItem = await say(forSale);
    assert.equal(saleItem.understanding.subject.use, 'resale');
    assert.equal(saleItem.plan.components[0].category, 'مواد و کالا');
  });
});

test('همان قلم، همان دسته: دو ثبتِ هم‌دستهٔ قبلی دستهٔ سوم را می‌گیرند؛ ناهمخوانی یادداشت می‌شود', async () => {
  const as = (text, amount, category) => water(text, amount, (output) => {
    output.subject = { ...output.subject, what: 'آب معدنی دفتر', use: 'internal', category, evidence: 'آب معدنی دفتر' };
  });
  const categoryOf = (item) => item.plan.components[0].category;
  const run = await ledger('water-history');
  await run(async () => {
    for (const text of ['آب معدنی دفتر ۲۰۰ هزار تومان از ملت خریدیم', 'آب معدنی دفتر ۲۰۵ هزار تومان از ملت خریدیم']) {
      const item = await say(as(text, Number(text.match(/۲۰[۰۵]/)[0] === '۲۰۰' ? 200_000 : 205_000), 'خوراک'));
      assert.equal(categoryOf(item), 'خوراک');
      commit(item.id);
    }
    const third = await say(as('آب معدنی دفتر ۲۲۰ هزار تومان از ملت خریدیم', 220_000, 'ملزومات اداری'));
    assert.equal(categoryOf(third), 'خوراک', 'دو ثبتِ قبلی «خوراک» بودند');
  });
  const mixed = await ledger('water-mixed');
  await mixed(async () => {
    commit((await say(as('آب معدنی دفتر ۲۳۰ هزار تومان از ملت خریدیم', 230_000, 'خوراک'))).id);
    commit((await say(as('آب معدنی دفتر ۲۴۰ هزار تومان از ملت خریدیم', 240_000, 'ملزومات اداری'))).id);
    const third = await say(as('آب معدنی دفتر ۲۵۰ هزار تومان از ملت خریدیم', 250_000, 'خوراک'));
    assert.ok(third.plan.notes.some((note) => note.kind === 'warning' && /با دسته‌های/.test(note.text)), JSON.stringify(third.plan.notes));
  });
});

test('دستهٔ واژه‌ها: قهوه و آب معدنی خوراک‌اند؛ قهوه‌ساز نه', () => {
  for (const text of [COFFEE, 'دو کارتن آب معدنی ۲۴۰ هزار', 'چای و قهوه آبدارخونه ۴۰۰ هزار تومن']) assert.equal(classifyCategory(text, 'expense').category, 'خوراک', text);
  for (const text of ['دستگاه قهوه ساز ۱۸ میلیون خریدیم', 'قهوه‌ساز دفتر', 'قهوه‌جوش']) assert.notEqual(classifyCategory(text, 'expense').category, 'خوراک', text);
});

test('آینهٔ فاکتور پرداخت‌نشده: فروشی که پولش نیامده دریافت نقدی نمی‌سازد', () => {
  for (const text of [
    'به شرکت آلفا ۳۰ میلیون جنس فروختیم، هنوز پولشو نداده',
    '۳۰ میلیون جنس به آقای کریمی فروختیم، پولش رو هنوز نگرفتیم',
  ]) {
    const [item] = runVoice(text).items;
    assert.equal(item.kind, 'receivable-opened', text);
    assert.notEqual(item.outcome, 'post', text);
  }
  // منفی: پولِ فروش آمده است.
  for (const text of ['به شرکت آلفا ۳۰ میلیون جنس فروختیم، پولش رو گرفتیم', '۳۰ میلیون جنس فروختیم نقد']) {
    assert.equal(runVoice(text).items[0].kind, 'cash-income', text);
  }
});
