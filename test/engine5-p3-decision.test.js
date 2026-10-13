import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
import { runVoice } from './helpers/voicePipeline.js';
import { parseFinancialText } from '../shared/parser.js';
import { buildMonthlySchedule } from '../shared/recognitionSchedule.js';
import { decide } from '../shared/accountingDecision.js';
import { isPrepaidServiceCandidate, signalsGoodsDeliveryLater } from '../shared/economicFamily.js';

/**
 * موتور ۵ — بستهٔ تصمیم حسابداری (p3).
 *
 * هر بخش یک خانواده است: جملهٔ واقعی گزارش عیناً، شکل‌های هم‌ارز، و نمونه‌های
 * منفی که نباید وارد همان مسیر شوند. امروز ۱۸ مهر ۱۴۰۵.
 */
const NOW = '2026-10-10T00:00:00.000Z';
const roles = (item) => (item.plan?.lines || []).map((line) => [line.role, line.debit || line.credit]);
const voice = (text) => runVoice(text, { today: NOW });

// ---------------------------------------------------------------------------
// پیش‌پرداخت خدمت در برابر پیش‌پرداخت خرید: با واقعیت‌ها، نه با ترتیب قاعده‌ها
// ---------------------------------------------------------------------------

test('واژهٔ «پیش پرداخت» کنار دورهٔ صریح، پیش‌پرداخت خدمت با شناسایی ماهانه است، نه پیش‌پرداخت خرید', () => {
  for (const [text, amount, months] of [
    ['قرارداد تبلیغات شش ماهه ۶۰ میلیون پیش پرداخت کردیم', 60_000_000, 6],
    ['پیش پرداخت قرارداد پشتیبانی یکساله ۲۴ میلیون دادیم', 24_000_000, 12],
    ['پیش پرداخت شارژ ساختمان شش ماهه ۱۵ میلیون دادیم', 15_000_000, 6],
    ['پیش پرداخت کرایه مغازه شش ماهه ۶۰ میلیون دادیم', 60_000_000, 6],
    ['پیش پرداخت بیمع انبار یک ساله ۱۲ میلیون دادیم', 12_000_000, 12],
    ['شارژ ساختمان شش ماه رو جلوتر دادیم ۱۲ میلیون', 12_000_000, 6],
    ['پیش‌پرداخت قرارداد پشتیبانی 12 ماهه 24 میلیون دادیم', 24_000_000, 12],
  ]) {
    const [item] = voice(text).items;
    assert.equal(item.decision.treatment, 'prepaid-expense', text);
    assert.equal(item.decision.recognitionMethod, 'monthly-straight-line', text);
    assert.deepEqual(roles(item), [['prepaid-asset', amount], ['cash', amount]], text);
    const [parsed] = parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions;
    const schedule = buildMonthlySchedule({ amount, periodStart: parsed.servicePeriodStart, periodEnd: parsed.servicePeriodEnd, sourceId: 't' });
    assert.equal(schedule.length, months, text);
    assert.equal(schedule.reduce((sum, row) => sum + row.amount, 0), amount, text);
  }
});

test('پول کالایی که «N ماه بعد تحویل میده/میرسه/میاد» پیش‌پرداخت خرید است؛ هیچ برنامهٔ هزینهٔ ماهانه‌ای ندارد', () => {
  for (const text of [
    '۳۰ میلیون به تولیدی نوری دادیم برای پارچه که سه ماه بعد تحویل میده',
    'برای خرید دستگاه که دو ماه بعد میرسه ۵۰ میلیون به آقای رضایی دادیم',
    '۲۰ میلیون به آقای رضایی دادیم بابت ورق، دو ماه آینده تحویل میده',
    'سفارش کالا دادیم ۴۰ میلیون واریز کردیم سه ماه بعد میاد',
    '۳۰ میلیون به تولیدی نوری دادیم برای پارچه که 3 ماه بعد تحویل میده',
    '۳۰ میلیون به تولیدی نوری دادیم برای پارچه که هنوز تحویل نداده',
    'پیش پرداخت خرید آهن ۵۰ میلیون به آقای رضایی دادیم',
    'بیعانه ۱۰ میلیون به تامین کننده پارچه دادیم',
  ]) {
    const [item] = voice(text).items;
    assert.equal(item.decision.treatment, 'supplier-advance', text);
    assert.notEqual(item.decision.recognitionMethod, 'monthly-straight-line', text);
    assert.ok(!roles(item).some(([role]) => role === 'prepaid-asset' || role === 'expense'), text);
    // یا سند پیش‌پرداخت خرید، یا پرسیدن طرف حساب — هیچ حدسی.
    assert.ok(item.outcome === 'ask' ? item.fact === 'counterparty' : roles(item)[0][0] === 'supplier-advance', text);
  }
});

test('وارونه: پیش‌دریافتِ کالایی که «سه ماه بعد تحویلش میدیم» پیش‌دریافت فروش است، نه درآمد ماه‌به‌ماه', () => {
  const [item] = voice('آقای رضایی ۳۰ میلیون بیعانه داد برای پارچه که سه ماه بعد تحویلش میدیم').items;
  assert.equal(item.decision.treatment, 'customer-advance');
  assert.notEqual(item.decision.recognitionMethod, 'monthly-straight-line');
});

test('تحویل کالا دورهٔ خدمت را از دستهٔ دوره‌دار نمی‌گیرد؛ نشانهٔ رسیدن بی‌کالا هم کالا نیست', () => {
  const base = { moneyDirection: 'out', amount: 1, servicePeriodStart: '2026-10-10', servicePeriodEnd: '2027-04-09' };
  assert.equal(isPrepaidServiceCandidate({ ...base, category: 'اجاره', evidence: 'اجاره شش ماهه دفتر رو دادیم کلید رو اول آبان تحویل میدن' }), true);
  assert.equal(signalsGoodsDeliveryLater({ evidence: '۳۰ میلیون دادیم سه ماه بعد پولش میاد' }), false);
  assert.equal(signalsGoodsDeliveryLater({ evidence: 'کالا رو دیروز تحویل دادن' }), false);
  assert.equal(signalsGoodsDeliveryLater({ evidence: 'پارچه رو سه ماه بعد تحويل ميده' }), true, 'ي و ك عربی');
});

test('مسیر AI با «advance-paid» همان تصمیم مسیر قطعی را می‌گیرد', () => {
  const facts = (extra) => ({
    moneyDirection: 'out', amount: 24_000_000, occurredAt: NOW, counterparty: 'شرکت داده پردازان', paymentPurpose: 'advance', ...extra,
  });
  const service = decide(facts({ category: 'سایر هزینه‌ها', servicePeriodStart: NOW, servicePeriodEnd: '2027-10-09T00:00:00.000Z', evidence: 'پیش پرداخت قرارداد پشتیبانی شبکه یک ساله ۲۴ میلیون به شرکت داده پردازان از تجارت دادیم' }), { today: NOW });
  assert.equal(service.policyKey, 'prepaid-service');
  assert.equal(service.treatment, 'prepaid-expense');
  const goods = decide(facts({ category: 'سایر هزینه‌ها', evidence: 'پیش پرداخت خرید آهن ۵۰ میلیون به آقای رضایی از تجارت دادیم' }), { today: NOW });
  assert.equal(goods.policyKey, 'supplier-advance');
  // دوره‌ای که در واقع زمان تحویل کالاست، پیش‌پرداخت خدمت نمی‌سازد.
  const leadTime = decide(facts({ category: 'سایر هزینه‌ها', servicePeriodStart: NOW, servicePeriodEnd: '2027-01-08T00:00:00.000Z', evidence: '۳۰ میلیون به تولیدی نوری دادیم برای پارچه که سه ماه بعد تحویل میده' }), { today: NOW });
  assert.equal(leadTime.policyKey, 'supplier-advance');
});

// ---------------------------------------------------------------------------
// دفتر واقعی — مسیر AI با برچسب «advance-paid» و برنامهٔ شناسایی در دیتابیس
// ---------------------------------------------------------------------------

process.env.DATABASE_PATH = tempDatabase('engine5-p3-decision');
process.env.ADMIN_USERNAME = 'p3-owner';
process.env.ADMIN_PASSWORD = 'p3-strong-password-7719';
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser('p3-owner', 'p3-strong-password-7719');
let workspaceCount = 0;
/** هر آزمون دفتر خودش را دارد تا مانده‌ها و برنامه‌ها روی هم نیفتند. */
const inFreshWorkspace = (callback) => {
  const workspace = database.createWorkspace(owner.id, { name: `دفتر p3 ${++workspaceCount}`, profileType: 'business' });
  return database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, async () => {
    database.installChartTemplate();
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all' });
    return callback();
  });
};
const none = { op: null, of: [] };
const modelFetcher = (said) => async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(said) }] }], usage: { input_tokens: 1, output_tokens: 1 } }) });
const aiOptions = (said) => ({ fetcher: modelFetcher(said), env: { OPENAI_API_KEY: 'test-key-not-real', OPENAI_UNDERSTANDING_MODEL: 'test-model' }, now: new Date(NOW) });
const modelSaid = ({ kind, what, value, evidence, party, subjectKind = 'service' }) => ({
  event: { kind, description: what, status: 'done' },
  amounts: [{ id: 'a1', value, currency: null, role: 'paid-now', status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence }],
  nonAmountNumbers: [], dates: [],
  counterparties: party ? [{ id: 'c1', name: party, role: 'supplier', evidence: party }] : [],
  movements: [{ id: 'm1', amountRef: 'a1', direction: 'out', from: { kind: 'bank', name: 'تجارت' }, to: party ? { kind: 'counterparty', name: party } : { kind: 'unknown', name: null }, evidence: 'از تجارت' }],
  subject: { what, kind: subjectKind, use: 'internal', delivered: 'no', usefulLifeMonths: null, evidence: what },
  conditions: [], ambiguities: [],
});
const ledgerRows = () => database.activeWorkspaceDatabase().prepare(`
  SELECT a.name AS name, l.debit AS debit, l.credit AS credit FROM journal_lines l
  JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.id = l.account_id
  WHERE e.source_type NOT LIKE '%opening%'`).all();
const scheduleTotals = () => database.activeWorkspaceDatabase().prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM recognition_schedule_items').get();

test('مسیر AI: «advance-paid» با دورهٔ صریح، پیش‌پرداخت خدمت با برنامهٔ ماهانه است؛ کالا بی‌دوره پیش‌پرداخت خرید می‌ماند', async () => {
  for (const sample of [
    { text: 'پیش پرداخت قرارداد پشتیبانی شبکه یک ساله ۲۴ میلیون به شرکت داده پردازان از تجارت دادیم', value: 24_000_000, evidence: '۲۴ میلیون', party: 'شرکت داده پردازان', what: 'پشتیبانی شبکه', months: 12 },
    { text: 'پیش پرداخت قرارداد تبلیغات شش ماهه ۶۰ میلیون به شرکت نوآوران از تجارت دادیم', value: 60_000_000, evidence: '۶۰ میلیون', party: 'شرکت نوآوران', what: 'تبلیغات', months: 6 },
  ]) {
    await inFreshWorkspace(async () => {
      database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 500_000_000 });
      const item = await database.createUnderstandingCase({ text: sample.text, clientId: `p3-ai-${sample.value}` }, aiOptions(modelSaid({ ...sample, kind: 'advance-paid' })));
      assert.equal(item.status, 'ready', sample.text);
      assert.deepEqual(item.plan.components[0].preview.lines.map((line) => line.role), ['prepaid-asset', 'cash'], sample.text);
      database.commitUnderstandingCase(item.id, { now: new Date(NOW) });
      assert.ok(!ledgerRows().some((row) => row.name.startsWith('پیش‌پرداخت خرید')), sample.text);
      const schedule = scheduleTotals();
      assert.equal(schedule.n, sample.months, sample.text);
      assert.equal(schedule.total, sample.value, sample.text);
    });
  }
  await inFreshWorkspace(async () => {
    database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 500_000_000 });
    const text = 'پیش پرداخت خرید آهن ۵۰ میلیون به آقای رضایی از تجارت دادیم';
    const item = await database.createUnderstandingCase({ text, clientId: 'p3-ai-goods' }, aiOptions(modelSaid({ kind: 'advance-paid', what: 'آهن', value: 50_000_000, evidence: '۵۰ میلیون', party: 'آقای رضایی', subjectKind: 'goods' })));
    assert.equal(item.status, 'ready');
    assert.deepEqual(item.plan.components[0].preview.lines.map((line) => line.role), ['supplier-advance', 'cash']);
    database.commitUnderstandingCase(item.id, { now: new Date(NOW) });
    assert.equal(scheduleTotals().n, 0);
  });
});
