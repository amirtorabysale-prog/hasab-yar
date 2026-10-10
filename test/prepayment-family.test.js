import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
import { runVoice } from './helpers/voicePipeline.js';
import { ROLES } from '../shared/accountingRules.js';

/**
 * پیش‌پرداختِ خدمتِ دوره‌دار — بیمه، اجاره، اشتراک.
 *
 * گزارش کاربر (۱۸ مهر ۱۴۰۵): «پیش پرداخت بیمه آتش‌سوزی به مبلغ ۱۲ میلیون به بیمه
 * دی بابت بیمه انبار. تایم پوشش ۱ ساله، ماهیانه ۱ میلیون، از حساب تجارت».
 * مسیر قطعی دو پرداخت ثبت می‌کرد (۱۲ و ۱ — نرخ ماهانه پرداخت دوم شده بود) و مسیر
 * AI برچسب «ودیعه»ی مدل را پذیرفت و ۱۲ میلیون ودیعهٔ قابل استرداد زد. درست:
 * یک پرداخت ۱۲ میلیونی، پیش‌پرداخت، با دورهٔ پوشش یک‌ساله برای شناسایی ماهانه.
 */
const NOW = '2026-10-10T00:00:00.000Z';
const SAID = 'پیش پرداخت بیمه اتش سوزی به مبلغ 12 میلیون به بیمه دی بابت بیمه انبار .تایم پوشش 1 ساله ماهیانه 1 میلیون .از حساب تجارت';
const lines = (item) => (item.plan?.lines || []).map((line) => [line.role, line.debit || line.credit]);

test('مسیر قطعی: نرخ ماهانه پرداخت دوم نیست؛ یک پیش‌پرداخت با شناسایی ماهانه', () => {
  const result = runVoice(SAID, { today: NOW });
  assert.equal(result.items.length, 1);
  assert.deepEqual(lines(result.items[0]), [[ROLES.PREPAID_ASSET, 12_000_000], [ROLES.CASH, 12_000_000]]);
  assert.equal(result.items[0].decision.recognitionMethod, 'monthly-straight-line');
});

test('خانواده: بیمه، اجاره و اشتراکِ دوره‌دار با نرخ ماهانه', () => {
  for (const [text, amount] of [
    ['بیمه یک ساله انبار رو ۱۲ میلیون دادیم، ماهی یک میلیون', 12_000_000],
    ['اجاره ۶ ماه دفتر رو جلوتر دادیم ۳۰ میلیون، ماهی ۵ میلیون', 30_000_000],
    ['اشتراک یک ساله نرم افزار ۲۴ میلیون پرداخت کردیم ماهانه ۲ میلیون', 24_000_000],
  ]) {
    const result = runVoice(text, { today: NOW });
    assert.equal(result.items.length, 1, text);
    assert.deepEqual(lines(result.items[0]), [[ROLES.PREPAID_ASSET, amount], [ROLES.CASH, amount]], text);
  }
});

test('نرخِ دارای فعل پرداختِ خودش، پرداخت است؛ مبلغ تنهای ماهانه هم', () => {
  assert.deepEqual(runVoice('ودیعه ۵۰ میلیون دادیم و اجاره ماهانه ۵ میلیون هم دادیم', { today: NOW }).items.map((item) => item.amount), [50_000_000, 5_000_000]);
  assert.deepEqual(runVoice('حقوق ماهیانه آقای کریمی ۱۰ میلیون دادیم', { today: NOW }).items.map((item) => item.amount), [10_000_000]);
});

// ---------------------------------------------------------------------------
// مسیر AI — همان خروجی مدل که در تصویر کاربر بود.
// ---------------------------------------------------------------------------

process.env.DATABASE_PATH = tempDatabase('prepayment-family');
process.env.ADMIN_USERNAME = 'prepay-owner';
process.env.ADMIN_PASSWORD = 'prepay-strong-password-3381';
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser('prepay-owner', 'prepay-strong-password-3381');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر پیش‌پرداخت', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
const none = { op: null, of: [] };
const modelSaid = {
  event: { kind: 'advance-paid', description: 'پیش‌پرداخت بیمه آتش‌سوزی برای بیمه انبار از حساب تجارت', status: 'done' },
  amounts: [
    { id: 'a1', value: 12_000_000, currency: null, role: 'deposit', status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence: 'به مبلغ 12 میلیون' },
    { id: 'a2', value: 1_000_000, currency: null, role: 'unit-price', status: 'context', partOf: null, basis: 'explicit', computedFrom: none, evidence: 'ماهیانه 1 میلیون' },
  ],
  nonAmountNumbers: [], dates: [],
  counterparties: [{ id: 'c1', name: 'بیمه دی', role: 'supplier', evidence: 'به بیمه دی' }],
  movements: [{ id: 'm1', amountRef: 'a1', direction: 'out', from: { kind: 'bank', name: 'تجارت' }, to: { kind: 'counterparty', name: 'بیمه دی' }, evidence: 'از حساب تجارت' }],
  subject: { what: 'بیمه آتش‌سوزی انبار', kind: 'service', use: 'internal', delivered: 'unknown', usefulLifeMonths: null, evidence: 'بیمه انبار' },
  conditions: [], ambiguities: [{ field: 'movements.m1.from', kind: 'information', question: 'حساب تجارت بانک است یا صندوق؟' }],
};
const fetcher = async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(modelSaid) }] }], usage: { input_tokens: 1, output_tokens: 1 } }) });
const options = { fetcher, env: { OPENAI_API_KEY: 'test-key-not-real', OPENAI_UNDERSTANDING_MODEL: 'test-model' }, now: new Date(NOW) };

test('مسیر AI: برچسب «ودیعه»ی مدل بی‌واژهٔ ودیعه پذیرفته نمی‌شود؛ پیش‌پرداخت با دورهٔ پوشش', async () => {
  await inWorkspace(async () => {
    database.installChartTemplate();
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all' });
    const tejarat = database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 50_000_000 });
    const item = await database.createUnderstandingCase({ text: SAID, clientId: 'insurance-1' }, options);
    assert.equal(item.status, 'ready', JSON.stringify({ q: item.plan.questions, r: item.plan.reasons }));
    assert.equal(item.plan.components.length, 1, 'یک پرداخت، نه دو');
    const [component] = item.plan.components;
    assert.equal(component.amount, 12_000_000);
    assert.equal(component.accountId, tejarat.id);
    assert.deepEqual(component.preview.lines.map((line) => line.role), ['prepaid-asset', 'cash'], 'پیش‌پرداخت، نه ودیعه');
    const posted = database.commitUnderstandingCase(item.id, { now: new Date(NOW) });
    assert.equal(posted.status, 'posted');
    const schedule = database.activeWorkspaceDatabase().prepare("SELECT COUNT(*) AS n, SUM(amount) AS total FROM recognition_schedule_items WHERE status='planned'").get();
    assert.equal(schedule.n, 12, 'دوازده قسط ماهانهٔ هزینه');
    assert.equal(schedule.total, 12_000_000);
  });
});
