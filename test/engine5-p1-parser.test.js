import test from 'node:test';
import assert from 'node:assert/strict';
import { runVoice } from './helpers/voicePipeline.js';
import { extractAmounts, parseFinancialText } from '../shared/parser.js';
import { normalizePersian } from '../shared/normalize.js';
import { detectVoiceIntent } from '../shared/voiceIntent.js';
import { validateUnderstanding } from '../shared/eventUnderstanding.js';
import { ROLES } from '../shared/accountingRules.js';
import { classifyCategory } from '../shared/categoryRules.js';
import { detectBank, detectTransferBanks, mentionsMultipleBanks } from '../shared/banks.js';
import { detectCaptureTransfer } from '../shared/bankSpeech.js';
import { extractContactCandidate, extractContactName } from '../shared/counterpartySpeech.js';
import { readContractRefund } from '../shared/refundSpeech.js';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

/**
 * موتور ۵ — پارسر قطعی: جهت، مبلغ، نرخ، بند هر ردیف، دسته و نام بانک.
 *
 * پیش‌پرداخت خدمتِ دوره‌دار (بیمه، اجاره، اشتراک) و آینه‌اش (پیش‌دریافت از
 * مستاجر یا مشتری) از هر شکل گفتن. هر جدول یک خانواده است: جملهٔ واقعی کاربر
 * عیناً، شکل‌های هم‌ارز (رقم لاتین و فارسی، ي/ك، نیم‌فاصله، غلط تایپی، فعل
 * چسبیده) و نمونه‌های منفی که نباید وارد همان مسیر شوند.
 */
const NOW = '2026-10-12T00:00:00.000Z'; // ۲۰ مهر ۱۴۰۵
const voice = (text) => runVoice(text, { today: NOW });
const parse = (text) => parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions;
const amountsOf = (text) => voice(text).items.map((item) => item.amount);
const lines = (item) => (item.plan?.lines || []).map((line) => [line.role, line.debit || line.credit]);

// ---------------------------------------------------------------------------
// amount-scale-typo-milyon — «ملیون» غلط تایپی رایج «میلیون» است
// ---------------------------------------------------------------------------

test('غلط تایپی «ملیون/ملیارد»: مقیاس گم نمی‌شود، در هر خوانندهٔ مبلغ', () => {
  for (const [text, amount] of [
    ['اجاره یکساله ۱۲۰ ملیون دادیم', 120_000_000],
    ['بیمه شش ماهه ۱۸ ملیون پرداخت کردیم', 18_000_000],
    ['اشتراک یکساله نرم افزار ۲۴ ملیون دادیم', 24_000_000],
    ['اجاره یکساله 120 ملیون دادیم', 120_000_000],
    ['اجاره یکساله ۱۲۰ مليون دادیم', 120_000_000],
    ['اجاره یکساله صد و بیست ملیون دادیم', 120_000_000],
    ['۱۲۰ ملیونش رو دادیم بابت اجاره یکساله', 120_000_000],
    ['دوملیون بنزین زدیم', 2_000_000],
    ['وام ۱ ملیارد گرفتیم', 1_000_000_000],
    ['یه چک ۱ ملیاردی به آقای رضایی دادیم', 1_000_000_000],
    // «است»ِ چسبیده به مقیاس: همان خانوادهٔ مقیاسِ گم‌شده.
    ['قسط اولش ده میلیونه', 10_000_000],
    ['قیمتش 2 میلیونه', 2_000_000],
    ['چک ده میلیونیه', 10_000_000],
    ['پونصد هزاره', 500_000],
  ]) {
    assert.deepEqual(extractAmounts(text).spans.map((span) => span.amount), [amount], text);
  }
  // پیش‌پرداخت نقدی: ۱۲۰ میلیون با برنامهٔ ماهانه، نه ۱۲۰ تومان.
  const cash = voice('اجاره یکساله ۱۲۰ ملیون دادیم').items;
  assert.equal(cash.length, 1);
  assert.deepEqual(lines(cash[0]), [[ROLES.PREPAID_ASSET, 120_000_000], [ROLES.CASH, 120_000_000]]);
  assert.equal(cash[0].decision.recognitionMethod, 'monthly-straight-line');
});

test('غلط تایپی «ملیون» روی کارت چک، جملهٔ نرخ، شاهد AI و دریافت از مستاجر', () => {
  // کارت چک مبلغ را فقط‌خواندنی نشان می‌دهد؛ ۱۲۰ تومان یعنی چک ۱۲۰ تومانی.
  for (const text of ['اجاره یکساله رو چک ۱۲۰ ملیونی به اقای رضایی دادیم', 'اجاره یکساله رو چک ۱۲۰ ملیون به اقای رضایی دادیم', 'اجاره یکساله رو چک 120 مليوني به اقای رضایی دادیم']) {
    const intent = detectVoiceIntent(text, { now: new Date(NOW) });
    assert.equal(intent.intent, 'cheque', text);
    assert.equal(intent.amount, 120_000_000, text);
  }
  assert.deepEqual(amountsOf('بیمه یکساله ۱۲ ملیون دادیم، ماهی ۱ ملیون'), [12_000_000]);
  const none = { op: null, of: [] };
  const understanding = validateUnderstanding({
    event: { kind: 'other', description: '', status: 'done' }, nonAmountNumbers: [], dates: [], counterparties: [], movements: [],
    subject: { what: null, kind: null, use: 'unknown', delivered: 'unknown', usefulLifeMonths: null, evidence: null }, conditions: [], ambiguities: [],
    amounts: [{ id: 'a1', value: 120_000_000, currency: null, role: 'total', status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence: '۱۲۰ ملیون' }],
  }, { text: 'اجاره یکساله ۱۲۰ ملیون دادیم', now: new Date(NOW) }).understanding;
  assert.equal(understanding.amounts[0].accepted, true);
  assert.equal(understanding.amounts[0].value, 120_000_000);
  const tenant = parse('اجاره یکساله مغازه رو ۱۲۰ ملیون از مستاجر گرفتیم');
  assert.deepEqual(tenant.map((row) => [row.type, row.amount]), [['income', 120_000_000]]);
});

test('کوتاه‌نوشت مقیاس («۱۲۰ م»، «۵۰۰ت») مبلغ ۱۲۰ یا ۵۰۰ تومانی بی‌صدا ثبت نمی‌کند', () => {
  for (const text of ['اجاره یکساله ۱۲۰ م دادیم', 'اجاره یکساله ۱۲۰م دادیم', 'بیمه ۱۲ m دادیم']) {
    const [item] = voice(text).items;
    assert.equal(item.outcome, 'accountant', text);
    assert.match(parse(text)[0].needsJudgment, /کوتاه‌نوشت مقیاس/, text);
  }
  for (const text of ['بنزین ۵۰۰ت زدیم', 'بنزین ۵۰۰ ت زدیم']) {
    assert.deepEqual(voice(text).items.map((item) => [item.outcome, item.fact]), [['ask', 'amountScale']], text);
  }
});

test('منفی: «میلیون» درست و «ملی» دست نمی‌خورند؛ «۱۲۰ تومن» همچنان مقیاس را می‌پرسد', () => {
  assert.equal(normalizePersian('۱۲۰ میلیون'), '120 میلیون');
  assert.equal(normalizePersian('از بانک ملی دادیم'), 'از بانک ملی دادیم');
  assert.equal(normalizePersian('کد ملی'), 'کد ملی');
  assert.deepEqual(extractAmounts('هزاره سوم').spans, []);
  assert.deepEqual(voice('بیمه ۱۲۰ تومن دادیم').items.map((item) => [item.outcome, item.fact]), [['ask', 'amountScale']]);
});

// ---------------------------------------------------------------------------
// year-merged-into-amount — سالِ تاریخ درست پیش از مبلغ
// ---------------------------------------------------------------------------

test('سالِ پوشش که درست پیش از مبلغ آمده، با مبلغ جمع نمی‌شود', () => {
  for (const [text, amount] of [
    ['بیمه از اول آبان ۱۴۰۵ تا پایان مهر ۱۴۰۶ ۲۴ میلیون دادیم', 24_000_000],
    ['بیمه از اول آبان 1405 تا پایان مهر 1406 24 میلیون دادیم', 24_000_000],
    ['بیمه انبار از مهر ۱۴۰۵ تا شهریور ۱۴۰۶ دوازده میلیون دادیم', 12_000_000],
    ['اجاره سال ۱۴۰۶ ۱۲۰ میلیون دادیم', 120_000_000],
    ['لایسنس تا آخر اسفند ۱۴۰۵ ۶ میلیون دادیم', 6_000_000],
  ]) {
    assert.deepEqual(amountsOf(text), [amount], text);
  }
  // همان جملهٔ کاربر حالا پیش‌پرداخت ۲۴ میلیونی با دورهٔ آبان تا مهر است.
  const [item] = voice('بیمه از اول آبان ۱۴۰۵ تا پایان مهر ۱۴۰۶ ۲۴ میلیون دادیم').items;
  assert.deepEqual(lines(item), [[ROLES.PREPAID_ASSET, 24_000_000], [ROLES.CASH, 24_000_000]]);
});

test('منفی: مبلغِ چهاررقمیِ با مقیاس، عدد مرکب و طول دوره دست‌نخورده‌اند', () => {
  for (const [text, amounts] of [
    ['اجاره ۱۴۰۰ میلیون دادیم', [1_400_000_000]],
    ['مالیات سال ۱۴۰۴ رو بیست میلیون دادیم', [20_000_000]],
    ['دو میلیون و پونصد دادیم بابت تعمیر', [2_500_000]],
    ['اجاره ۳۰ میلیون شش ماهه دادیم', [30_000_000]],
  ]) {
    assert.deepEqual(extractAmounts(text).spans.map((span) => span.amount), amounts, text);
  }
});

// ---------------------------------------------------------------------------
// phantom-small-amounts-suffix-ezafe — «شش ماهش» و «بیمه‌ی» مبلغ نیستند
// ---------------------------------------------------------------------------

test('«ماهش/ماهشو» و کسرهٔ «ـه‌ی» ردیف نقدی شش‌تومانی یا یک‌تومانی نمی‌سازند', () => {
  for (const [text, amount, category] of [
    ['اجاره دفتر ماهی ۵ میلیون، شش ماهش رو جلو دادیم ۳۰ میلیون', 30_000_000, 'اجاره'],
    ['اجاره ماهی ۵ میلیون، ۳ ماهش رو جلو دادیم ۱۵ میلیون', 15_000_000, 'اجاره'],
    ['سه ماهشو جلو دادیم اجاره ۱۵ میلیون', 15_000_000, 'اجاره'],
    ['بیمه‌ی آتش‌سوزی یک‌ساله ۱۲ میلیون پرداخت شد', 12_000_000, 'بیمه'],
    ['یه سالشو جلو دادیم بیمه ۱۲ میلیون', 12_000_000, 'بیمه'],
    ['اجاره‌ی شش ماهه‌ی دفتر ۳۰ میلیون دادیم', 30_000_000, 'اجاره'],
  ]) {
    const items = voice(text).items;
    assert.deepEqual(items.map((item) => item.amount), [amount], text);
    assert.equal(items[0].category, category, text);
    assert.equal(items[0].decision.treatment, 'prepaid-expense', text);
  }
});

test('منفی: «یه میلیون» و «یک ماه» همچنان درست خوانده می‌شوند', () => {
  assert.deepEqual(extractAmounts('یه میلیون دادیم').spans.map((span) => span.amount), [1_000_000]);
  assert.deepEqual(extractAmounts('یک ماه اجاره ۵ میلیون دادیم').spans.map((span) => span.amount), [5_000_000]);
});

// ---------------------------------------------------------------------------
// det-rate-phrase-sentence-final-verb — نرخ کنار کل، پرداخت نیست
// ---------------------------------------------------------------------------

test('نرخ با فعل آخر جمله: یک پرداختِ کل، نه نرخ و نه دو ردیف', () => {
  for (const [text, amount] of [
    ['بیمه یکساله ۱۲ میلیون تومان ماهیانه ۱ میلیون تومان پرداخت شد', 12_000_000],
    ['بیمه یکساله 12 میلیون ماهیانه 1 میلیون پرداخت شد', 12_000_000],
    ['بیمه یکساله دوازده میلیون تومن ماهی یک میلیون تومن دادیم', 12_000_000],
    ['بیمه یکساله ۱۲,۰۰۰,۰۰۰ تومان ماهی ۱,۰۰۰,۰۰۰ دادیم', 12_000_000],
    ['بیمه یکساله ۱۲ میلیون، ماهیانه ۱ میلیون پرداخت شد', 12_000_000],
    ['اشتراک یکساله نرم افزار ۲۴ میلیون ماهانه ۲ میلیون پرداخت کردیم', 24_000_000],
    ['بيمه يكساله ۱۲ ميليون ماهيانه ۱ ميليون پرداخت شد', 12_000_000],
    ['اجاره دو ساله ۱۲۰ میلیون سالانه ۶۰ میلیون دادیم', 120_000_000],
    ['اجاره دفتر ۶ ماهه ۳۰ میلیون در ماه ۵ میلیون از ملت دادیم', 30_000_000],
    ['بیمه یکساله ۱۲۰۰۰۰۰۰۰ ریال ماهیانه ۱۰۰۰۰۰۰۰ ریال پرداخت شد', 12_000_000],
  ]) {
    const items = voice(text).items;
    assert.deepEqual(items.map((item) => item.amount), [amount], text);
    assert.deepEqual(lines(items[0]), [[ROLES.PREPAID_ASSET, amount], [ROLES.CASH, amount]], text);
  }
  // بی‌فعل و کارت‌به‌کارت: فقط کل می‌ماند.
  for (const [text, amount] of [
    ['اجاره دفتر ۶ ماهه ۳۰ میلیون ماهیانه ۵ میلیون از حساب ملت', 30_000_000],
    ['اجاره دفتر ۶ ماهه ۳۰ میلیون هر ماه ۵ میلیون', 30_000_000],
    ['بیمه یک ساله ۱۲ میلیون ماهیانه یک میلیون', 12_000_000],
    ['بیمه یکساله ۱۲ میلیون ماهیانه ۱ میلیون کارت به کارت کردیم', 12_000_000],
  ]) {
    assert.deepEqual(amountsOf(text), [amount], text);
  }
  // آینهٔ مستاجر: کلِ دریافتی، نه نرخ.
  const tenant = voice('مستاجر اجاره یکساله ۶۰ میلیون ماهیانه ۵ میلیون واریز کرد').items;
  assert.deepEqual(tenant.map((item) => [item.kind, item.amount]), [['cash-income', 60_000_000]]);
});

test('نرخ بی‌کل حذف نمی‌شود: ودیعه کلِ اجاره نیست و دو نرخ مستقل هر دو می‌مانند', () => {
  for (const [text, amounts] of [
    ['اجاره ماهانه ۵ میلیون و ودیعه ۵۰ میلیون دادیم', [5_000_000, 50_000_000]],
    ['حقوق ماهیانه ۱۰ میلیون و اجاره ماهیانه ۵ میلیون دادیم', [10_000_000, 5_000_000]],
    // منفی‌های کنونی که درست بودند و باید بمانند.
    ['ودیعه ۵۰ میلیون دادیم و اجاره ماهانه ۵ میلیون هم دادیم', [50_000_000, 5_000_000]],
    ['حقوق ماهیانه ۱۰ میلیون دادیم', [10_000_000]],
    ['بیمه یکساله ۱۲ میلیون دادیم، ماهی یک میلیون', [12_000_000]],
  ]) {
    assert.deepEqual(amountsOf(text), amounts, text);
  }
});

// ---------------------------------------------------------------------------
// rate-increase-not-masked — افزایش نرخ وسط قرارداد
// ---------------------------------------------------------------------------

test('افزایش یا سطح تازهٔ نرخ پرداخت دوم نیست؛ مابه‌التفاوت دستهٔ خودش را دارد', () => {
  for (const [text, amount, category] of [
    ['از ماه بعد اجاره ۲ میلیون اضافه شد مابه التفاوت شش ماه ۱۲ میلیون رو از حساب تجارت دادیم', 12_000_000, 'اجاره'],
    ['اجاره از ماه بعد ۲ میلیون افزایش پیدا کرد، مابه‌التفاوت شش ماه ۱۲ میلیون رو دادیم', 12_000_000, 'اجاره'],
    ['اجاره ۲ میلیون رفت بالا، مابه التفاوت شش ماه ۱۲ میلیون رو دادیم', 12_000_000, 'اجاره'],
    ['بیمه ۲ میلیون گرون شد مابه التفاوت ۱۲ میلیون رو دادیم', 12_000_000, 'بیمه'],
    ['اشتراک نرم افزار ۵۰۰ هزار تومن گرون شد، ۶ میلیون برای یک سال دادیم', 6_000_000, 'نرم‌افزار و اشتراک'],
    ['از ماه بعد اجاره دو میلیون اضافه شد مابه التفاوت شش ماه دوازده میلیون رو کارت به کارت کردیم', 12_000_000, 'اجاره'],
    ['اجاره ۵ میلیون شد، ۳۰ میلیون برای شش ماه دادیم', 30_000_000, 'اجاره'],
    ['اجاره از ماه بعد ۷ میلیون میشه، شش ماه رو ۴۲ میلیون پیش دادیم', 42_000_000, 'اجاره'],
  ]) {
    const items = voice(text).items;
    assert.deepEqual(items.map((item) => item.amount), [amount], text);
    assert.equal(items[0].category, category, text);
    assert.equal(items[0].decision.treatment, 'prepaid-expense', text);
  }
});

test('منفی: پرداختِ اضافه با فعل خودش، دو پرداخت مستقل و جمع یک خرید، همه می‌مانند', () => {
  for (const [text, amounts] of [
    ['اجاره ۱۲ میلیون دادیم، ۲ میلیون هم اضافه دادیم', [12_000_000, 2_000_000]],
    ['ودیعه ۵۰ میلیون دادیم و اجاره ماهانه ۵ میلیون هم دادیم', [50_000_000, 5_000_000]],
    ['اجاره ۲ میلیون و شارژ ۱ میلیون دادیم', [2_000_000, 1_000_000]],
    ['خرید ۵ میلیون شد و حمل ۱ میلیون دادیم', [5_000_000, 1_000_000]],
    ['اجاره ۵ میلیون شد', [5_000_000]],
  ]) {
    assert.deepEqual(amountsOf(text), amounts, text);
  }
});

// ---------------------------------------------------------------------------
// det-income-mirror-direction-flip / rental-income-flipped-to-expense
// پولی که مستاجر یا مشتری به ما داده، ورود است — هرگز «Cr صندوق».
// ---------------------------------------------------------------------------

/** ورود پول: یا Dr صندوق / Cr پیش‌دریافت، یا یک سؤال؛ هرگز پیش‌پرداخت یا هزینه. */
function assertMoneyIn(text, amount) {
  const items = voice(text).items;
  assert.equal(items.length, 1, text);
  const [item] = items;
  assert.equal(item.kind, 'cash-income', text);
  if (amount) assert.equal(item.amount, amount, text);
  const roles = lines(item).map(([role]) => role);
  assert.ok(!roles.includes(ROLES.PREPAID_ASSET) && !roles.includes(ROLES.EXPENSE_CATEGORY), `${text}: ${roles}`);
  const cashCredit = (item.plan?.lines || []).some((line) => line.role === ROLES.CASH && line.credit);
  assert.equal(cashCredit, false, text);
  if (item.outcome === 'post') {
    assert.deepEqual(lines(item), [[ROLES.CASH, item.amount], [ROLES.DEFERRED_REVENUE, item.amount]], text);
    assert.equal(item.decision.recognitionMethod, 'monthly-straight-line', text);
  } else {
    assert.ok(['ask', 'accountant'].includes(item.outcome), text);
  }
  return item;
}

test('پیش‌دریافت اجاره یا اشتراک از مستاجر و مشتری: ورود پول، نه پیش‌پرداخت ما', () => {
  for (const [text, amount] of [
    // جمله‌های کاربر و بازبین‌ها، عیناً.
    ['اجاره دفتر رو ۶ ماهه از مستاجر گرفتیم ۳۰ میلیون', 30_000_000],
    ['مستاجر اجاره شش ماه آینده رو ۶۰ میلیون واریز کرد', 60_000_000],
    ['پیش دریافت اجاره شش ماهه ۳۰ میلیون از مستاجر گرفتیم', 30_000_000],
    ['درآمد اجاره شش ماهه ۳۰ میلیون دریافت شد', 30_000_000],
    ['آقای احمدی مستاجرمون اجاره شش ماهه ۳۰ میلیون واریز کرد', 30_000_000],
    ['مشتری اشتراک یکساله ۲۴ میلیون واریز کرد', 24_000_000],
    ['اجاره مهر رو از مستاجر ۱۰ میلیون گرفتیم', 10_000_000],
    ['مستاجر اجاره ۶ ماه آینده رو ۶۰ میلیون واریز کرد', 60_000_000],
    ['اجاره شش ماه آینده مغازه رو از مستاجر گرفتیم ۶۰ میلیون', 60_000_000],
    ['مستاجر اجاره مهر رو ۱۰ میلیون واریز کرد', 10_000_000],
    ['اجاره شش ماهه مغازه رو از مستاجر ۳۰ میلیون گرفتیم', 30_000_000],
    ['مستاجرمون اجاره یک ساله رو ۶۰ میلیون جلوتر به حساب تجارت واریز کرد', 60_000_000],
    ['۳۰ میلیون اجاره شش ماه آینده رو از مستاجر دریافت کردیم', 30_000_000],
    ['مستاجر اجاره شش ماهه مغازه رو ۳۰ میلیون داد', 30_000_000],
    ['مستاجر اجاره ۶ ماه مغازه رو جلو جلو داد ۳۰ میلیون', 30_000_000],
    ['درآمد اجاره شش ماه آینده مغازه ۳۰ میلیون دریافت شد', 30_000_000],
    ['مستاجر ۳۰ میلیون بابت اجاره شش ماه جلو داد', 30_000_000],
    ['اجاره شش ماه مغازه رو از مستاجر دریافت کردیم ۳۰ میلیون', 30_000_000],
    ['پیش دریافت اجاره از مستاجر ۳۰ میلیون گرفتیم', 30_000_000],
    ['مستاجر اجاره شش ماه آینده رو ۶۰ میلیون به حساب ملت ریخت', 60_000_000],
    ['اجاره شش ماه آینده مغازه رو ۶۰ میلیون از مستاجر گرفتیم', 60_000_000],
    ['آقای رضایی مستاجر ۶۰ میلیون اجاره شش ماه جلوتر رو داد', 60_000_000],
    ['اجاره یک سال آینده رو ۱۲۰ میلیون از مستاجر دریافت کردیم', 120_000_000],
    ['پیش دریافت اجاره شش ماه آینده ۶۰ میلیون از مستاجر', 60_000_000],
    ['مستاجر ۶۰ میلیون پیش پرداخت اجاره شش ماه آینده رو داد', 60_000_000],
    ['کرایه شش ماه آینده رو مستاجر ۶۰ میلیون داد', 60_000_000],
    ['مستاجر 10 میلیون اجاره این ماه رو داد', 10_000_000],
    ['اجاره مغازه رو از مستاجر گرفتم ده میلیون', 10_000_000],
    ['رهن مغازه رو ۱۰۰ میلیون از مستاجر گرفتیم', 100_000_000],
    // شکل‌های نوشتاری: همزه، ي/ك، رقم لاتین، نیم‌فاصله، «وصول شد».
    ['مستأجر اجاره‌ی شش ماه آینده رو ۶۰ میلیون واریز کرد', 60_000_000],
    ['كرايه شش ماه آينده رو از مستاجر ۶۰ ميليون گرفتيم', 60_000_000],
    ['مستاجر‌مون اجاره شش ماهه رو 30 میلیون واریز کرد', 30_000_000],
    ['اجاره شش ماهه ۳۰ میلیون از مستاجر وصول شد', 30_000_000],
    // مشتری و کارفرما، همان آینه برای خدمت فروخته‌شده.
    ['مشتری قرارداد پشتیبانی یکساله ۳۶ میلیون واریز کرد', 36_000_000],
    ['کارفرما پیش پرداخت پروژه ۵۰ میلیون واریز کرد', 50_000_000],
    // کنترل: جمله‌ای که از قبل درست بود.
    ['اجاره گرفتم شش ماهه ۳۰ میلیون از آقای احمدی', 30_000_000],
  ]) {
    assertMoneyIn(text, amount);
  }
});

test('پیش‌دریافتِ مستاجر به دستهٔ «درآمد اجاره» و اشتراکِ فروخته به «خدمات» می‌رود', () => {
  assert.equal(parse('مستاجر اجاره شش ماه آینده رو ۶۰ میلیون واریز کرد')[0].category, 'درآمد اجاره');
  assert.equal(parse('اجاره شش ماهه مغازه رو از مستاجر ۳۰ میلیون گرفتیم')[0].category, 'درآمد اجاره');
  assert.equal(parse('کرایه شش ماه آینده رو مستاجر ۶۰ میلیون داد')[0].category, 'درآمد اجاره');
  assert.equal(parse('مشتری اشتراک یکساله ۲۴ میلیون واریز کرد')[0].category, 'خدمات');
  // با طرف حساب، همان سند پیش‌دریافت با برنامهٔ ماهانهٔ شش‌ماهه.
  const item = assertMoneyIn('اجاره شش ماهه مغازه رو از مستاجر ۳۰ میلیون گرفتیم', 30_000_000);
  assert.equal(item.outcome, 'post');
  assert.equal(item.decision.treatment, 'deferred-revenue');
});

test('منفی: پرداخت ما، حتی با «گرفتیم» یا نام مستاجر، پرداخت می‌ماند', () => {
  for (const text of [
    'بنزین گرفتم ۵۰۰ هزار',
    'بنزین گرفتیم ۵۰۰ هزار',
    'ناهار پرسنل گرفتیم ۲ میلیون',
    'قبض برق دریافت شد ۲ میلیون',
    'اجاره دفتر رو ۱۰ میلیون به صاحبخونه واریز کردیم',
    'اجاره شش ماهه دفتر ۳۰ میلیون دادیم',
    'ودیعه مستاجر رو ۵۰ میلیون پس دادیم',
    'اجاره شش ماه آینده مغازه رو ۶۰ میلیون به صاحبخانه دادیم',
    'اجاره مغازه رو ۱۰ میلیون دادم',
    'ودیعه مستاجر رو ۱۰۰ میلیون پس دادیم',
    'به مستاجر ۵ میلیون دادیم',
    'مستاجر رو بیرون کردیم ۵ میلیون خرج شد',
    'اشتراک یکساله نرم افزار رو ۲۴ میلیون گرفتیم',
  ]) {
    const items = voice(text).items;
    assert.equal(items.length, 1, text);
    assert.equal(items[0].kind, 'cash-expense', text);
  }
  // «تحویل داد» و «سفارش داد» پول نیستند.
  assert.notEqual(parse('مشتری سفارش داد ۱۰ میلیون')[0].category, 'درآمد اجاره');
});

test('«اجاره … گرفتم» بی پرداخت‌کننده: جهت حدس زده نمی‌شود، به حسابدار می‌رود', () => {
  for (const text of ['اجاره یک ساله مغازه رو گرفتم ۶۰ میلیون', 'اجاره شش ماهه دفتر رو گرفتیم ۳۰ میلیون']) {
    const [item] = voice(text).items;
    assert.notEqual(item.outcome, 'post', text);
    assert.equal(item.outcome, 'accountant', text);
    assert.match(parse(text)[0].reviewReasons.join(' '), /جهت پول روشن نیست/, text);
  }
});

// ---------------------------------------------------------------------------
// det-multi-payment-period-category-leak — هر ردیف بند خودش را دارد
// ---------------------------------------------------------------------------

const rowsOf = (text) => voice(text).items.map((item) => ({
  amount: item.amount, category: item.category, months: monthsOf(item), fact: item.outcome === 'ask' ? item.fact : null,
  treatment: item.decision?.treatment || null, outcome: item.outcome,
}));
function monthsOf(item) {
  const facts = item.decision?.facts || {};
  const start = facts.servicePeriodStart || item.decision?.servicePeriodStart;
  const end = facts.servicePeriodEnd || item.decision?.servicePeriodEnd;
  return start && end ? Math.round((Date.parse(end) - Date.parse(start)) / (30.4 * 86_400_000)) : null;
}
const parsedRows = (text) => parse(text).map((row) => ({
  amount: row.amount, category: row.category,
  period: row.servicePeriodStart ? Math.round((Date.parse(row.servicePeriodEnd) - Date.parse(row.servicePeriodStart)) / (30.4 * 86_400_000)) : null,
  rawText: row.rawText, prepayment: row.prepaymentSignal === true, contact: row.contactName || null,
}));

test('دو پرداخت در یک جمله: دوره، دسته و شاهدِ ودیعه به ردیف دیگر نشت نمی‌کند', () => {
  // ۱. اجارهٔ شش‌ماهه پیش‌پرداخت؛ ودیعه استرداد را می‌پرسد، نه شروع دوره.
  let rows = parsedRows('اجاره شش ماهه ۳۰ میلیون دادیم، ودیعه هم ۵۰ میلیون دادیم');
  assert.deepEqual(rows.map((row) => [row.amount, row.period]), [[30_000_000, 6], [50_000_000, null]]);
  assert.doesNotMatch(rows[0].rawText, /ودیعه/);
  assert.match(rows[1].rawText, /ودیعه/);
  let items = voice('اجاره شش ماهه ۳۰ میلیون دادیم، ودیعه هم ۵۰ میلیون دادیم').items;
  assert.deepEqual(lines(items[0]), [[ROLES.PREPAID_ASSET, 30_000_000], [ROLES.CASH, 30_000_000]]);
  assert.deepEqual([items[1].outcome, items[1].fact], ['ask', 'refundable']);

  // ۲. ودیعه اول، اجارهٔ ماهانه دوم.
  items = voice('ودیعه ۵۰ میلیون دادیم و اجاره ماهانه ۵ میلیون هم دادیم').items;
  assert.deepEqual(items.map((item) => [item.amount, item.outcome === 'ask' ? item.fact : item.outcome]), [[50_000_000, 'refundable'], [5_000_000, 'servicePeriodStart']]);
  items = voice('اجاره ماهانه ۵ میلیون و ودیعه ۵۰ میلیون دادیم').items;
  assert.deepEqual(items.map((item) => [item.amount, item.outcome === 'ask' ? item.fact : item.outcome]), [[5_000_000, 'servicePeriodStart'], [50_000_000, 'refundable']]);

  // ۳. اجارهٔ مهر و بیمهٔ یک‌ساله: بیمه هزینهٔ یک‌جا نمی‌شود و اجاره «بیمه» نمی‌شود.
  rows = parsedRows('اجاره مهر ۱۰ میلیون دادیم و بیمه یکساله ۱۲ میلیون هم پرداخت کردیم');
  assert.deepEqual(rows.map((row) => [row.category, row.period]), [['اجاره', 1], ['بیمه', 12]]);
  items = voice('اجاره مهر ۱۰ میلیون دادیم و بیمه یکساله ۱۲ میلیون هم پرداخت کردیم').items;
  assert.deepEqual(lines(items[1]), [[ROLES.PREPAID_ASSET, 12_000_000], [ROLES.CASH, 12_000_000]]);

  // ۴ و ۵. ناهار پرسنل هزینهٔ همین دوره است؛ بیمه و اشتراک پیش‌پرداخت دوازده‌ماهه.
  for (const [text, expected] of [
    ['بیمه یکساله ۱۲ میلیون دادیم و ناهار پرسنل ۲ میلیون', [['بیمه', 12, 'prepaid-expense'], ['خوراک', null, 'period-expense']]],
    ['ناهار پرسنل ۲ میلیون دادیم و اشتراک یکساله نرم افزار ۲۴ میلیون', [['خوراک', null, 'period-expense'], ['نرم‌افزار و اشتراک', 12, 'prepaid-expense']]],
    ['۱۲ میلیون دادیم بابت بیمه یکساله و ۲ میلیون ناهار', [['بیمه', 12, 'prepaid-expense'], ['خوراک', null, 'period-expense']]],
  ]) {
    rows = parsedRows(text);
    items = voice(text).items;
    assert.deepEqual(rows.map((row, index) => [row.category, row.period, items[index].decision?.treatment]), expected, text);
  }

  // ۶. دو خدمت دوره‌دار، هر کدام دورهٔ خودش.
  rows = parsedRows('اجاره ۶ ماهه دفتر ۳۰ میلیون دادیم و بیمه یکساله انبار ۱۲ میلیون هم دادیم');
  assert.deepEqual(rows.map((row) => [row.category, row.period]), [['اجاره', 6], ['بیمه', 12]]);
});

test('ردیف‌های یک جمله: دستهٔ هر نرخ، نشانهٔ پیش‌پرداخت و طرف حسابِ هر بند', () => {
  assert.deepEqual(parsedRows('حقوق ماهیانه ۱۰ میلیون و اجاره ماهیانه ۵ میلیون دادیم').map((row) => row.category), ['حقوق و دستمزد', 'اجاره']);
  assert.deepEqual(parsedRows('اجاره ۲ میلیون و شارژ ۱ میلیون دادیم').map((row) => row.category), ['اجاره', 'قبوض']);
  assert.deepEqual(parsedRows('اجاره ۵ میلیون شارژ ۱ میلیون دادیم').map((row) => row.category), ['اجاره', 'قبوض']);
  assert.deepEqual(parsedRows('پیش پرداخت بیمه یکساله ۱۲ میلیون دادیم و ناهار پرسنل ۲ میلیون').map((row) => row.prepayment), [true, false]);
  assert.deepEqual(parsedRows('۵۰ میلیون از آقای رضایی گرفتیم و ۳۰ میلیون به آقای کریمی دادیم').map((row) => row.contact), ['رضایی', 'کریمی']);
  // نام حدسیِ یک بند («به تاریخ …») جای نام مطمئن جمله را نمی‌گیرد.
  assert.deepEqual(parsedRows('از شرکت پخش البرز ۵۰ میلیون کالا خریدیم و تحویل گرفتیم؛ یه چک ۵۵ میلیونی به تاریخ ۳۰ آبان بهشون دادیم.').map((row) => row.contact), ['شرکت پخش البرز', 'شرکت پخش البرز']);
  // تاریخ و نام بانک در جملهٔ چندپرداختی دوره را از بین نمی‌برند.
  assert.deepEqual(parsedRows('بیمه از اول آبان ۱۴۰۵ تا پایان مهر ۱۴۰۶ ۲۴ میلیون دادیم و ناهار پرسنل ۲ میلیون').map((row) => [row.amount, row.period]), [[24_000_000, 12], [2_000_000, null]]);
});

test('منفی: جملهٔ یک‌پرداختی دوره و شاهدِ کل جمله را نگه می‌دارد', () => {
  const [row] = parsedRows('اجاره شش ماهه دفتر ۳۰ میلیون دادیم');
  assert.equal(row.period, 6);
  assert.equal(row.rawText, 'اجاره شش ماهه دفتر ۳۰ میلیون دادیم');
  assert.deepEqual(parsedRows('برای شش ماه آینده اجاره دفتر ۳۰ میلیون دادیم').map((row) => row.period), [6]);
});

// ---------------------------------------------------------------------------
// category-rules-prepaid-account — کلید پیش‌پرداخت و هزینهٔ ماهانه همان دسته است
// ---------------------------------------------------------------------------

test('کلید پیش‌پرداخت: کرایهٔ ملک اجاره است، بیمهٔ انبار بیمه، آنتی‌ویروس اشتراک', () => {
  for (const [text, category] of [
    ['کرایه مغازه شش ماه جلوتر ۶۰ میلیون دادیم', 'اجاره'],
    ['کرایه دفتر یک ساله ۱۲۰ میلیون پرداخت کردیم', 'اجاره'],
    ['کرایه سوله ۶ ماهه ۹۰ میلیون واریز کردیم', 'اجاره'],
    ['کرایه انبار سه ماه آینده رو ۳۰ میلیون دادیم', 'اجاره'],
    ['بیمه یک ساله انبار رو ۱۲ میلیون دادیم، ماهی یک میلیون', 'بیمه'],
    ['بیمه یکساله انبار رو دوازده میلیون دادیم', 'بیمه'],
    ['بیمع انبار یک ساله دوازده میلیون دادیم', 'بیمه'],
    ['آنتی ویروس دو ساله ۸ میلیون خریدیم', 'نرم‌افزار و اشتراک'],
    ['انتی ویروس یکساله ۴ میلیون دادیم', 'نرم‌افزار و اشتراک'],
    ['اجاره شش ماهه انبار رو ۳۰ میلیون دادیم', 'اجاره'],
    ['بیمه یک ساله کالاهای انبار رو ۱۲ میلیون دادیم', 'بیمه'],
    ['بیمه یک ساله انبار ۱۲ میلیون دادیم', 'بیمه'],
    ['اجاره شش ماه انبار رو جلوتر دادیم ۳۰ میلیون', 'اجاره'],
    ['بیمه‌ی انبار یک ساله ۱۲ میلیون دادیم', 'بیمه'],
    ['بیمه موجودی انبار یک ساله ۱۲ میلیون دادیم', 'بیمه'],
    ['بيمه يكساله انبار ۱۲ ميليون دادیم', 'بیمه'],
  ]) {
    const items = voice(text).items;
    assert.equal(items.length, 1, text);
    assert.equal(items[0].category, category, text);
    assert.equal(items[0].decision.treatment, 'prepaid-expense', text);
    if (items[0].outcome === 'post') {
      const prepaid = items[0].plan.lines.find((line) => line.role === ROLES.PREPAID_ASSET);
      assert.equal(prepaid.key, category, text);
    }
  }
  // دورهٔ داخل همان ماه: هزینهٔ اجاره، نه حمل‌ونقل.
  const [month] = voice('کرایه دفتر مهر ۱۰ میلیون دادیم').items;
  assert.equal(month.category, 'اجاره');
  assert.equal(month.plan.lines.find((line) => line.role === ROLES.EXPENSE_CATEGORY).key, 'اجاره');
});

test('منفی: کرایهٔ تاکسی و حمل و خرید کالا برای انبار دستهٔ خودشان را نگه می‌دارند', () => {
  for (const [text, category] of [
    ['کرایه تاکسی ۲۰۰ هزار دادیم', 'حمل‌ونقل'],
    ['کرایه حمل بار ۵ میلیون دادیم', 'حمل‌ونقل'],
    ['کرایه تاکسی تا دفتر ۲۰۰ هزار دادیم', 'حمل‌ونقل'],
    ['خرید کالا برای انبار ۵۰ میلیون', 'مواد و کالا'],
    ['کالا رو به انبار بردیم ۵ میلیون دادیم', 'مواد و کالا'],
  ]) {
    assert.equal(parse(text)[0].category, category, text);
  }
  // «و» زنجیرهٔ اضافه را می‌شکند: کالای بعد از «و» مفعول بیمه نیست.
  assert.equal(classifyCategory('بیمه رو دادیم و خرید کالا', 'expense').category, 'مواد و کالا');
});

test('دستهٔ مساوی میان خدمتِ دوره‌دار و دستهٔ دیگر حدس زده نمی‌شود', () => {
  const [item] = voice('اجاره و شارژ ۱۰ میلیون دادیم').items;
  assert.equal(item.outcome, 'accountant');
  assert.match(item.reason, /دسته روشن نیست/);
});

// ---------------------------------------------------------------------------
// insurer-name-read-as-bank — نام بانک درون نام بیمه‌گر یا شخص، حساب ما نیست
// ---------------------------------------------------------------------------

test('بیمه‌گر هم‌نام بانک، حساب پرداخت ما نیست؛ بانکی که گفته شده گم نمی‌شود', () => {
  for (const text of [
    'بیمه یکساله ۱۲ میلیون به بیمه پاسارگاد دادیم',
    'بیمه بدنه یکساله ۲۴ میلیون به بیمه ملت پرداخت کردیم',
    'بیمه یکساله ۱۲ میلیون به بیمه کارآفرین دادیم',
    'بیمه یکساله ۱۲ میلیون به بیمه سینا دادیم',
    'بیمه یکساله ۱۲ میلیون به بیمه پارسیان دادیم',
    'حق بیمه یک ساله انبار ۱۲ میلیون به شرکت بیمه پاسارگاد پرداخت کردیم',
    'بیمه یکساله ۱۲ میلیون به بيمه پاسارگاد دادیم',
    'بیمه یکساله ۱۲ میلیون به بیمه‌پاسارگاد دادیم',
    'بیمه آتش سوزی ۱۲ میلیون به بیمه تجارت نو دادیم',
    'اقساط ماشین رو ۱۰ میلیون به لیزینگ پارسیان دادیم',
    'دستمزد طراحی ۵ میلیون به آقای سینا دادیم',
    'اجاره غرفه ۲۰ میلیون به مجتمع تجاری پاسارگاد دادیم',
  ]) {
    const rows = parse(text);
    assert.equal(rows.length, 1, text);
    assert.equal(rows[0].bankId, undefined, text);
    assert.equal(detectBank(text), null, text);
  }
  // بیمه‌گر طرف حساب است.
  assert.equal(parse('بیمه یکساله ۱۲ میلیون به بیمه پاسارگاد دادیم')[0].contactName, 'بیمه پاسارگاد');
  // بانکِ گفته‌شده، کنار نام بیمه‌گر هم‌نام بانک دیگر، همان بانک است.
  assert.equal(parse('بیمه یکساله ۱۲ میلیون از حساب ملت به بیمه پاسارگاد دادیم')[0].bankId, 'mellat');
  assert.equal(parse('بیمه یکساله ۱۲ میلیون به بیمه ملت از ملت دادیم')[0].bankId, 'mellat');
  // حق‌بیمه به بیمه‌گر انتقال داخلی نیست.
  const premium = 'حق بیمه ۱۲ میلیون از ملت به بیمه پاسارگاد منتقل کردیم';
  assert.equal(detectTransferBanks(premium), null);
  assert.equal(mentionsMultipleBanks(premium), false);
  assert.equal(detectCaptureTransfer(premium, { now: new Date(NOW) }), null);
});

test('مسیر AI: بیمه‌گر هم‌نام بانک نقش بانکِ ما نمی‌گیرد', () => {
  const none = { op: null, of: [] };
  const text = 'حق بیمه یک ساله انبار ۱۲ میلیون به بیمه پاسارگاد پرداخت کردیم';
  for (const name of ['بیمه پاسارگاد', 'شرکت بیمه پاسارگاد', 'بیمه ملت']) {
    const { understanding, violations } = validateUnderstanding({
      event: { kind: 'advance-paid', description: 'حق بیمه', status: 'done' }, nonAmountNumbers: [], dates: [], movements: [],
      subject: { what: 'بیمه انبار', kind: 'service', use: 'business', delivered: 'unknown', usefulLifeMonths: null, evidence: 'حق بیمه یک ساله انبار' }, conditions: [], ambiguities: [],
      amounts: [{ id: 'a1', value: 12_000_000, currency: null, role: 'total', status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence: '۱۲ میلیون' }],
      counterparties: [{ id: 'c1', name, role: 'supplier', evidence: `به ${name}` }],
    }, { text: text.replace('بیمه پاسارگاد', name), now: new Date(NOW), ledgerBanks: ['pasargad', 'mellat', 'tejarat'] });
    assert.equal(understanding.counterparties[0].role, 'supplier', name);
    assert.ok(!violations.some((violation) => violation.endsWith(':our-bank')), name);
  }
});

test('منفی: بانک‌های واقعی و انتقال میان دو بانک همان‌اند که بودند', () => {
  for (const [text, bankId] of [
    ['از بانک ملت دادیم', 'mellat'],
    ['از ملت دادیم', 'mellat'],
    ['به بیمه پاسارگاد از پاسارگاد دادیم', 'pasargad'],
    ['از کارت ملت دادیم', 'mellat'],
    ['از حساب جاری ملت دادیم', 'mellat'],
    ['مؤسسه اعتباری ملل', 'blubank-melal'],
  ]) {
    assert.equal(detectBank(text)?.bankId, bankId, text);
  }
  const transfer = detectTransferBanks('از ملت به پاسارگاد منتقل کردیم');
  assert.deepEqual([transfer.from.id, transfer.to.id], ['mellat', 'pasargad']);
});

// ---------------------------------------------------------------------------
// counterparty-role-noun-glued — نقش و موضوع بخشی از نام طرف حساب نیستند
// ---------------------------------------------------------------------------

test('نام طرف حساب در نقش (مستاجر، صاحبخانه، پیمانکار…) و موضوع (اجاره…) بسته می‌شود', () => {
  const said = 'از آقای احمدی مستاجر بابت اجاره شش ماهه چک ۶۰ میلیونی گرفتیم';
  assert.equal(extractContactCandidate(said).name, 'احمدی');
  assert.equal(detectVoiceIntent(said, { now: new Date(NOW) }).contactName, 'احمدی');
  assert.equal(parse(said)[0].contactName, 'احمدی');
  for (const [text, name] of [
    ['چک ۶۰ میلیونی اجاره شش ماه آینده رو از آقای احمدی گرفتیم', 'احمدی'],
    ['از آقای رضایی مستاجر ۶۰ میلیون اجاره شش ماه آینده رو گرفتیم', 'رضایی'],
    ['به آقای کاظمی صاحبخونه ۱۲۰ میلیون بابت اجاره یک ساله دادیم', 'کاظمی'],
    ['به آقای کاظمی صاحب‌خانه ۱۲۰ میلیون دادیم', 'کاظمی'],
    ['به آقای کاظمی صاحب خونه ۱۲۰ میلیون دادیم', 'کاظمی'],
    ['به آقای رضایی موجر ۱۰ میلیون دادیم', 'رضایی'],
    ['از آقای احمدی مستأجر ۱۰ میلیون گرفتیم', 'احمدی'],
    ['آقای احمدی مستاجرمون اجاره شش ماهه ۳۰ میلیون واریز کرد', 'احمدی'],
    ['به آقای رضایی اجاره یک سال رو ۱۲۰ میلیون دادیم', 'رضایی'],
    ['به اقای رضایی پیمانکار ۵ میلیون دادیم', 'رضایی'],
    ['به آقای کریمی کارمندمون ۱۰ میلیون مساعده دادیم', 'کریمی'],
    ['به آقای نوری مدیرعامل ۵ میلیون دادیم', 'نوری'],
    ['از آقای صالحی مشتری ۲۰ میلیون گرفتیم', 'صالحی'],
    ['به آقای احمدی بیمه‌گذار ۵ میلیون دادیم', 'احمدی'],
    ['از رضا مستاجر ۱۰ میلیون گرفتیم', 'رضا'],
    ['بدهی 280 میلیونی به شرکت آریا داشتیم مدیر عامل اقای سهرابی ماشین شخصی خودشون رو فروختن و بدهی رو پرداخت کردند', 'شرکت آریا'],
  ]) {
    assert.equal(extractContactCandidate(text).name, name, text);
  }
  // صفحهٔ طلب و بدهی: نام بی‌عنوان پیش از نقش.
  assert.equal(extractContactName('احمدی مستاجر ۶۰ میلیون بدهکار شد', { allowBare: true }), 'احمدی');
  // فعل و نام بانک نام نیستند.
  assert.equal(parse('اجاره شش ماهه ۳۰ میلیون از مستاجر وصول شد')[0].contactName, 'مستاجر');
  assert.equal(parse('اجاره دفتر ۶ ماهه ۳۰ میلیون در ماه ۵ میلیون از ملت دادیم')[0].contactName, undefined);
});

test('منفی: نام‌های چندبخشی و شرکت‌هایی که با واژهٔ نقش شروع می‌شوند کامل می‌مانند', () => {
  for (const [text, name] of [
    ['۹۳ میلیون تومان به شرکت آراد گستر آسیا پرداخت شد', 'شرکت آراد گستر آسیا'],
    ['آقای علی احمدی ۵ میلیون داد', 'علی احمدی'],
    ['خانم سارا محمدی نیا ۵ میلیون داد', 'سارا محمدی نیا'],
    ['به شرکت بیمه ایران ۱۲ میلیون دادیم', 'شرکت بیمه ایران'],
    ['به شرکت پیمانکاری آبادگران ۱۲ میلیون دادیم', 'شرکت پیمانکاری آبادگران'],
  ]) {
    assert.equal(extractContactCandidate(text).name, name, text);
  }
});

// ---------------------------------------------------------------------------
// refund-cancel-not-recognised — برگشت وجه یا فسخ، پرداخت یا دریافت تازه نیست
// ---------------------------------------------------------------------------

const REFUND_TO_US = [
  'بیمه آتش سوزی رو فسخ کردیم بیمه دی ۶ میلیون حق بیمه برگشت داد به حساب تجارت',
  'شرکت بیمه بابت فسخ ۶ میلیون واریز کرد به حساب تجارت',
  'حق بیمه برگشتی ۶ میلیون دریافت کردیم',
  'بابت فسخ بیمه ۶ میلیون برگشت خورد به حساب',
  'اشتراک نرم افزار رو کنسل کردیم ۸ میلیون برگشت زدن به کارت',
  'بابت کنسلی اشتراک ۸ میلیون به حسابمون واریز کردن',
  'لایسنس نرم افزار رو کنسل کردیم ۸ میلیون پس گرفتیم',
  'اشتراک ادوبی کنسل شد و ۸ میلیون ریفاند شد',
  'لایسنس رو کنسل کردیم پولش ۸ میلیون برگشت',
  'دفتر رو تخلیه کردیم و ودیعه ۵۰ میلیون رو پس گرفتیم',
  'صاحبخونه ودیعه رو ۵۰ میلیون پس داد',
  'صاحبخونه قبلی ۶۰ میلیون ودیعه‌مون رو به تجارت برگردوند',
  // شکل‌های نوشتاری.
  'حق بيمه برگشتي ۶ ميليون دريافت كرديم',
  'اشتراک کنسل شد 8 میلیون refund شد',
];
const REFUND_BY_US = [
  'مشتری اشتراک یکساله رو کنسل کرد ۶ میلیون بهش برگشت زدیم',
  'اشتراک یکساله مشتری رو کنسل کردیم و ۶ میلیون بهش برگشت زدیم',
  'وجه اشتراک یکساله مشتری ۶ میلیون عودت شد',
  'آقای رضایی اشتراک سالانه اش رو لغو کرد ۶ میلیون براش برگشت زدیم',
  'مشتری قرارداد پشتیبانی یکساله رو فسخ کرد ۶ میلیون بهش برگشت زدیم',
  'ودیعه مستاجر رو ۵۰ میلیون پس دادیم',
  'ودیعه مستاجر رو ۵۰ میلیون برگردوندیم',
];

test('برگشت وجه از بیمه‌گر، فروشنده یا موجر: ورود پول و صف حسابدار، نه پیش‌پرداخت تازه', () => {
  for (const text of REFUND_TO_US) {
    const [row] = parse(text);
    assert.equal(row.type, 'income', text);
    assert.equal(row.servicePeriodStart, undefined, text);
    const [item] = voice(text).items;
    assert.equal(item.outcome, 'accountant', text);
    assert.match(item.reason, /برگشت وجه یا فسخ قرارداد/, text);
    // پولِ برگشتی درآمد اجاره یا خدمت نیست.
    assert.ok(!['درآمد اجاره', 'خدمات'].includes(row.category), text);
  }
});

test('ودیعه یا رهنِ دریافتی از مستاجر: ورود پول، ولی بدهی است نه درآمد؛ صف حسابدار', () => {
  for (const text of ['رهن مغازه رو ۱۰۰ میلیون از مستاجر گرفتیم', 'ودیعه ۵۰ میلیون از مستاجر گرفتیم', 'مستاجر ۵۰ میلیون ودیعه واریز کرد']) {
    const [row] = parse(text);
    assert.equal(row.type, 'income', text);
    const [item] = voice(text).items;
    assert.equal(item.outcome, 'accountant', text);
    assert.match(item.reason, /ودیعه یا رهنِ دریافتی/, text);
  }
  // اجارهٔ پیش‌دریافتِ همان مستاجر همچنان پیش‌دریافت است.
  assert.equal(voice('اجاره شش ماهه مغازه رو از مستاجر ۳۰ میلیون گرفتیم').items[0].outcome, 'post');
});

test('برگشت وجه به مشتری یا مستاجر: خروج پول و صف حسابدار، نه اشتراکِ خودمان', () => {
  for (const text of REFUND_BY_US) {
    const [row] = parse(text);
    assert.equal(row.type, 'expense', text);
    assert.equal(row.servicePeriodStart, undefined, text);
    const [item] = voice(text).items;
    assert.equal(item.outcome, 'accountant', text);
    assert.notEqual(item.decision?.treatment, 'prepaid-expense', text);
  }
});

test('منفی: ودیعهٔ قابل استرداد، شرط آیندهٔ «پس می‌گیریم»، برگشت چک و برگشت کالا برگشت قرارداد نیستند', () => {
  for (const text of [
    'ودیعه ۵۰ میلیون دادیم که آخر قرارداد پس می‌گیریم',
    'ودیعه قابل استرداد ۵۰ میلیون دادیم',
    'اجاره گرفتم شش ماهه ۳۰ میلیون از آقای احمدی',
    'لیست بیمه ۱۰ میلیون دادیم',
    'بیمه یکساله ۱۲ میلیون دادیم',
    'چک ۱۰ میلیونی آقای رضایی برگشت خورد',
    'جنس برگشتی فروشنده رو ۵ میلیون پس دادیم',
    'تخلیه بار ۲ میلیون دادیم',
    'مستاجر اجاره شش ماه آینده رو ۶۰ میلیون واریز کرد',
  ]) {
    assert.equal(readContractRefund(text), false, text);
  }
  // پیش‌پرداخت عادی همان سند پیش‌پرداخت است.
  assert.deepEqual(lines(voice('بیمه یکساله ۱۲ میلیون دادیم').items[0]), [[ROLES.PREPAID_ASSET, 12_000_000], [ROLES.CASH, 12_000_000]]);
});

// ---------------------------------------------------------------------------
// بازبینی: «حساب/کارت شرکت <بانک>» حساب خودِ ماست
// ---------------------------------------------------------------------------

test('«حساب/کارت شرکت ملت» بانکِ ماست؛ انتقال میان دو حساب شرکت انتقال داخلی می‌ماند', () => {
  const accounts = [{ id: 'cash', kind: 'cash' }, { id: 'acc-mellat', kind: 'bank', bankId: 'mellat' }, { id: 'acc-pasargad', kind: 'bank', bankId: 'pasargad' }, { id: 'acc-tejarat', kind: 'bank', bankId: 'tejarat' }];
  for (const [text, from, to] of [
    ['از حساب شرکت ملت به حساب شرکت پاسارگاد ۱۰ میلیون منتقل کردیم', 'acc-mellat', 'acc-pasargad'],
    ['از کارت شرکت ملت به کارت شرکت تجارت ۵ میلیون انتقال دادیم', 'acc-mellat', 'acc-tejarat'],
    ['از حساب‌شرکت ملت به حساب شرکت پاسارگاد ۱۰ میلیون منتقل کردیم', 'acc-mellat', 'acc-pasargad'],
  ]) {
    const transfer = detectCaptureTransfer(text, { now: new Date(NOW), accounts });
    assert.equal(transfer?.intent, 'transfer', text);
    assert.deepEqual([transfer.fromAccountId, transfer.toAccountId], [from, to], text);
  }
  for (const [text, bankId] of [
    ['مشتری ۵ میلیون به حساب شرکت ملت واریز کرد', 'mellat'],
    ['از حساب شرکت ملت ۵ میلیون اجاره دادیم', 'mellat'],
    ['حقوق آقای رضایی رو از حساب شرکت تجارت ۱۰ میلیون دادیم', 'tejarat'],
    ['از کارت شرکت پاسارگاد ۲ میلیون بنزین زدیم', 'pasargad'],
    ['از حساب جاری شرکت ملت ۵ میلیون اجاره دادیم', 'mellat'],
  ]) {
    assert.equal(parse(text)[0].bankId, bankId, text);
    assert.equal(detectBank(text)?.bankId, bankId, text);
  }
  assert.equal(voice('از کارت شرکت پاسارگاد ۲ میلیون بنزین زدیم').items[0].outcome, 'post');
  // منفی: شرکت یا بیمه‌گرِ هم‌نام بانک، بانکِ ما نیست.
  for (const text of ['به بیمه پاسارگاد ۱۲ میلیون دادیم', 'به شرکت ملت ۵ میلیون دادیم', 'به حساب شرکت بیمه ملت ۵ میلیون دادیم']) {
    assert.equal(parse(text)[0].bankId, undefined, text);
  }
});

// ---------------------------------------------------------------------------
// دفتر: سه گفته از یک مستاجر، یک طرف حساب و یک حساب تفصیلی.
// ---------------------------------------------------------------------------

process.env.DATABASE_PATH = tempDatabase('engine5-p1-parser');
process.env.ADMIN_USERNAME = 'e5-parser-owner';
process.env.ADMIN_PASSWORD = 'e5-parser-strong-password-5521';
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser('e5-parser-owner', 'e5-parser-strong-password-5521');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر مستاجر', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);

test('دفتر: دو چک و یک دریافت نقدی از «آقای احمدی مستاجر» روی یک طرف حساب می‌نشینند', () => {
  inWorkspace(() => {
    database.installChartTemplate();
    for (const sentence of [
      'از آقای احمدی مستاجر بابت اجاره شش ماهه چک ۶۰ میلیونی گرفتیم',
      'چک ۶۰ میلیونی اجاره شش ماه آینده رو از آقای احمدی گرفتیم',
    ]) {
      const intent = detectVoiceIntent(sentence, { now: new Date(NOW) });
      database.recordCheque({
        direction: intent.direction, counterpartyName: intent.contactName, amount: intent.amount,
        against: 'income', category: 'درآمد اجاره', note: sentence,
      });
    }
    const receipt = 'از آقای احمدی مستاجر ۱۰ میلیون اجاره مهر رو گرفتیم';
    const [item] = parseFinancialText(receipt, { source: 'voice', now: new Date(NOW) }).transactions;
    database.insertTransactions({ transcript: receipt, transactions: [item] });
    const names = database.listContacts().map((contact) => contact.name);
    assert.deepEqual(names.filter((name) => name.includes('احمدی')), ['احمدی']);
    const split = database.activeWorkspaceDatabase().prepare("SELECT COUNT(*) AS count FROM ledger_accounts WHERE name LIKE '%احمدی مستاجر%'").get().count;
    assert.equal(split, 0);
  });
});

test('دفتر: برگشت حق‌بیمه به صف حسابدار می‌رود و هیچ سندی بانک را جابه‌جا نمی‌کند', () => {
  inWorkspace(() => {
    const sentence = 'بیمه آتش سوزی رو فسخ کردیم بیمه دی ۶ میلیون حق بیمه برگشت داد به حساب تجارت';
    const rows = parseFinancialText(sentence, { source: 'voice', now: new Date(NOW) }).transactions;
    const [id] = database.insertTransactions({ transcript: sentence, transactions: rows.map((row) => ({ ...row, userConfirmed: true })) });
    const db = database.activeWorkspaceDatabase();
    const event = db.prepare('SELECT status FROM financial_events WHERE source_event_id=?').get(`transaction:${id}`);
    assert.notEqual(event.status, 'posted');
    const posted = db.prepare("SELECT COUNT(*) AS count FROM journal_entries WHERE source_type='transaction' AND source_id=?").get(id).count;
    assert.equal(posted, 0);
  });
});

test.after(() => removeTempDatabase(process.env.DATABASE_PATH));
