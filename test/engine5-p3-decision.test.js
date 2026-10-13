import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
import { runVoice } from './helpers/voicePipeline.js';
import { parseFinancialText } from '../shared/parser.js';
import { buildMonthlySchedule } from '../shared/recognitionSchedule.js';
import { decide } from '../shared/accountingDecision.js';
import { awaitsSupplierGoods, goodsDeliveryLater, isPrepaidServiceCandidate, signalsGoodsDeliveryLater } from '../shared/economicFamily.js';

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
  // صیغه می‌گوید کالا را چه کسی می‌دهد؛ تحویلِ ما پیش‌پرداخت به تأمین‌کننده نیست.
  assert.equal(goodsDeliveryLater({ evidence: 'برای کالایی که هنوز تحویل نداده ایم' }), 'us');
  assert.equal(goodsDeliveryLater({ evidence: 'سه ماه بعد تحویلش میدیم' }), 'us');
  assert.equal(goodsDeliveryLater({ evidence: 'ورق رو ماه بعد تحویل می‌گیریم' }), 'supplier');
  assert.equal(goodsDeliveryLater({ evidence: 'پارچه رو هنوز تحویل نداده' }), 'supplier');
  assert.equal(awaitsSupplierGoods({ evidence: 'سفارش کالا دادیم سه ماه بعد میاد' }), true);
  const [wrongWay] = voice('امروز 25 میلیون تومان پیش دریافت از مشتری برای کالایی که هنوز تحویل نداده ایم گرفتم').items;
  assert.notEqual(wrongWay.outcome, 'post');
  assert.notEqual(wrongWay.decision?.treatment, 'supplier-advance');
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
// کالا با دورهٔ گفته‌شده، و تحویلِ چیزی که کالا نیست (بازبینی دوم)
// ---------------------------------------------------------------------------

/** پیش‌پرداخت خرید: نه دارایی پیش‌پرداخت خدمت، نه برنامهٔ ماهانه، نه حدس. */
const assertSupplierAdvance = (text) => {
  const [item] = voice(text).items;
  assert.equal(item.decision.treatment, 'supplier-advance', text);
  assert.notEqual(item.decision.recognitionMethod, 'monthly-straight-line', text);
  assert.ok(!roles(item).some(([role]) => role === 'prepaid-asset' || role === 'expense'), text);
  assert.ok(item.outcome === 'ask' ? item.fact === 'counterparty' : roles(item)[0][0] === 'supplier-advance', text);
};

test('پیش‌پرداخت/بیعانه/علی‌الحساب خرید کالا با دورهٔ گفته‌شده پیش‌پرداخت خرید می‌ماند، نه هزینهٔ ماهانه', () => {
  // جمله‌های بازبین، عیناً.
  for (const text of [
    'علی الحساب خرید مواد اولیه سه ماه آینده ۳۰ میلیون به شرکت آلفا دادیم',
    'پیش پرداخت قرارداد تامین مواد اولیه شش ماهه ۶۰ میلیون به شرکت آلفا دادیم',
    'پیش پرداخت خرید آهن شش ماه آینده ۵۰ میلیون به آقای رضایی دادیم',
    'پیش پرداخت خرید پارچه برای شش ماه آینده ۶۰ میلیون به تولیدی نوری دادیم',
    'بیعانه خرید پارچه شش ماهه ۶۰ میلیون به تولیدی نوری دادیم',
  ]) assertSupplierAdvance(text);
  // واژهٔ پیش‌پرداخت × کالا × شکل دوره، با عدد لاتین.
  for (const advance of ['پیش پرداخت', 'بیعانه', 'علی الحساب']) {
    for (const [goods, party] of [['خرید آهن', 'آقای رضایی'], ['خرید پارچه', 'تولیدی نوری'], ['خرید مواد اولیه', 'شرکت آلفا']]) {
      for (const period of ['شش ماه آینده', 'شش ماهه', 'سه ماه آینده', '6 ماهه']) {
        assertSupplierAdvance(`${advance} ${goods} ${period} ۴۰ میلیون به ${party} دادیم`);
      }
    }
  }
  // مسیر AI: «advance-paid» همان واقعیت‌ها را می‌دهد.
  const ai = decide({
    moneyDirection: 'out', amount: 50_000_000, occurredAt: NOW, counterparty: 'آقای رضایی', paymentPurpose: 'advance', category: 'سایر هزینه‌ها',
    servicePeriodStart: NOW, servicePeriodEnd: '2027-04-09T00:00:00.000Z', evidence: 'پیش پرداخت خرید آهن شش ماه آینده ۵۰ میلیون به آقای رضایی دادیم',
  }, { today: NOW });
  assert.equal(ai.policyKey, 'supplier-advance');
});

test('منفی: خدمتی که کالا فقط وصفش است، پیش‌پرداخت خدمت می‌ماند؛ خرید کالا با دوره و بی نشانهٔ پیش‌پرداخت حدس زده نمی‌شود', () => {
  for (const [text, amount] of [
    ['پیش پرداخت قرارداد پشتیبانی دستگاه یکساله ۲۴ میلیون دادیم', 24_000_000],
    ['قرارداد نگهداری تجهیزات شش ماهه ۳۰ میلیون پیش پرداخت کردیم', 30_000_000],
    ['پیش پرداخت بیمه انبار کالا یک ساله ۱۲ میلیون دادیم', 12_000_000],
    ['اجاره دستگاه شش ماهه ۳۰ میلیون پیش پرداخت کردیم', 30_000_000],
  ]) {
    const [item] = voice(text).items;
    assert.equal(item.decision.treatment, 'prepaid-expense', text);
    assert.deepEqual(roles(item), [['prepaid-asset', amount], ['cash', amount]], text);
  }
  // «خرید مواد اولیه شش ماهه»: پیش‌پرداخت است یا مواد رسیده؟ — نه هزینهٔ ماهانه، نه سند خودکار.
  const [unclear] = voice('خرید مواد اولیه شش ماهه ۶۰ میلیون به شرکت آلفا دادیم').items;
  assert.notEqual(unclear.outcome, 'post');
  assert.notEqual(unclear.decision.treatment, 'prepaid-expense');
});

test('تحویلِ سند، گزارش یا آدم، تحویل کالا نیست: برنامهٔ خدمت، موجودیِ رسیده و پیش‌دریافت خدمت سر جایشان می‌مانند', () => {
  // خدمت دوره‌دار با «فاکتورش/گزارشش رو … ارسال میکنن»: همچنان برنامهٔ ماهانه.
  for (const [text, amount] of [
    ['قرارداد پشتیبانی یکساله ۲۴ میلیون به شرکت آلفا دادیم، فاکتورش رو هفته بعد ارسال میکنن', 24_000_000],
    ['قرارداد تبلیغات شش ماهه ۶۰ میلیون دادیم، گزارشش رو ماهانه ارسال میکنن', 60_000_000],
    ['قرارداد پشتیبانی یکساله ۲۴ میلیون به شرکت آلفا دادیم، نصابشون هفته بعد میاد', 24_000_000],
  ]) {
    const [item] = voice(text).items;
    assert.equal(item.decision.treatment, 'prepaid-expense', text);
    assert.equal(item.decision.recognitionMethod, 'monthly-straight-line', text);
    assert.deepEqual(roles(item), [['prepaid-asset', amount], ['cash', amount]], text);
  }
  // کالای رسیده که فقط فاکتورش نیامده، موجودی است، نه پیش‌پرداخت خرید.
  const [received] = voice('۲۰ میلیون مواد اولیه از شرکت آلفا خریدیم ولی فاکتورش ارسال نشده').items;
  assert.notEqual(received.decision.treatment, 'supplier-advance');
  assert.ok(!roles(received).some(([role]) => role === 'supplier-advance'));
  // «نصابش/حسابدار فردا میاد» آدم است؛ همان سؤال‌های خرید کالا، نه پیش‌پرداخت خرید.
  for (const text of ['خرید دستگاه ۵۰ میلیون نقدی دادیم، نصابش فردا میاد', '۲۰ میلیون جنس خریدیم حسابدار فردا میاد ثبت کنه']) {
    const [item] = voice(text).items;
    assert.notEqual(item.decision.treatment, 'supplier-advance', text);
    assert.equal(item.outcome, 'ask', text);
    assert.ok(['intendedUse', 'paymentPurpose'].includes(item.fact), text);
  }
  // وارونه: پیش‌دریافت خدمت با «گزارش/فاکتور رو براشون میفرستیم» درآمد انتقالی با برنامه است.
  for (const text of [
    'شرکت آلفا قرارداد پشتیبانی یکساله ۲۴ میلیون به ما واریز کرد، گزارش ماهانه رو براشون میفرستیم',
    'شرکت آلفا قرارداد پشتیبانی یکساله ۲۴ میلیون به ما واریز کرد، فاکتورش رو هفته بعد براشون ارسال میکنیم',
  ]) {
    const [item] = voice(text).items;
    assert.equal(item.decision.treatment, 'deferred-revenue', text);
    assert.deepEqual(roles(item), [['cash', 24_000_000], ['deferred-revenue', 24_000_000]], text);
  }
  for (const evidence of ['فاکتورش رو هفته بعد ارسال میکنن', 'گزارشش رو ماهانه ارسال میکنن', 'نصابش فردا میاد', 'حسابدار فردا میاد ثبت کنه', 'گزارش ماهانه رو براشون میفرستیم', 'مواد اولیه خریدیم ولی فاکتورش ارسال نشده']) {
    assert.equal(goodsDeliveryLater({ evidence }), null, evidence);
  }
});

test('تحویل مجهول و مرکب: «تحویل داده میشه/می‌شود»، «ارسال خواهد شد» پیش‌پرداخت خرید است', () => {
  for (const text of [
    '۳۰ میلیون به تولیدی نوری دادیم برای پارچه که سه ماه بعد تحویل داده میشه',
    '۳۰ میلیون به تولیدی نوری دادیم برای پارچه که سه ماه بعد تحویل داده می‌شود',
    '۳۰ میلیون به تولیدی نوری دادیم برای پارچه که 3 ماه بعد تحویل داده میشه',
    '۵۰ میلیون به آقای رضایی دادیم برای دستگاه که دو ماه دیگه ارسال خواهد شد',
    '۳۰ میلیون به تولیدی نوری دادیم پارچه رو سه ماه بعد تحویلش میدن به ما',
  ]) assertSupplierAdvance(text);
  assert.equal(goodsDeliveryLater({ evidence: 'پارچه سه ماه بعد تحویل داده می شود' }), 'unknown');
  assert.equal(goodsDeliveryLater({ evidence: 'ورق رو از آقای رضایی ماه بعد تحویل می گیریم' }), 'supplier');
  // وارونه: پیش‌دریافت با تحویل مجهول هم درآمد ماه‌به‌ماه نمی‌شود.
  const [received] = voice('آقای رضایی ۳۰ میلیون بیعانه داد برای پارچه که سه ماه بعد تحویل داده میشه').items;
  assert.notEqual(received.decision.treatment, 'deferred-revenue');
  assert.notEqual(received.decision.recognitionMethod, 'monthly-straight-line');
});

// ---------------------------------------------------------------------------
// «افزایش سرمایه» در حق بیمهٔ اضافه و هزینهٔ ثبت: پول رفته، آوردهٔ مالک نیست
// ---------------------------------------------------------------------------

test('سرمایهٔ بیمه و هزینهٔ افزایش سرمایه برگهٔ آورده را باز نمی‌کنند و هیچ ورود وجهی نمی‌سازند', () => {
  for (const text of [
    'اضافه حق بیمه آتش سوزی بابت افزایش سرمایه ۲ میلیون دادیم',
    'الحاقیه افزایش سرمایه بیمه انبار ۲ میلیون از حساب تجارت دادیم',
    'بابت افزایش سرمایه بیمه ۲ میلیون به بیمه دی دادیم',
    'حق بیمه افزایش سرمایه بیمه آتش سوزی ۲ میلیون از حساب ملت',
    'برای افزایش سرمایه بیمه انبار ۲ میلیون واریز کردیم به بیمه ایران',
    'بیمه نامه آتش سوزی رو افزایش سرمایه دادیم ۲ میلیون حق بیمه اضافه پرداخت کردیم',
    'هزینه ثبت افزایش سرمایه شرکت ۳ میلیون دادیم',
    'حق الزحمه وکیل بابت افزایش سرمایه ۵ میلیون پرداخت کردیم',
    'حق‌الزحمه وکیل بابت افزایش سرمایه 5 میلیون پرداخت کردیم',
    'هزینه آگهی روزنامه رسمی افزایش سرمایه ۸۰۰ هزار تومن دادیم',
    'مالیات و حق تمبر افزایش سرمایه ۱ میلیون پرداخت کردیم',
    'حق بیمه اضافی بابت افزایش سرمایهٔ بیمه انبار ۲ میلیون پرداخت شد',
    'حق‌بیمهٔ الحاقیهٔ افزایش سرمایه ۲ میلیون پرداخت شد',
  ]) {
    const result = voice(text);
    assert.notEqual(result.path, 'capital', text);
    for (const item of result.items) {
      assert.ok(!(item.plan?.lines || []).some((line) => line.role === 'owner-capital'), text);
      assert.ok(!(item.plan?.lines || []).some((line) => line.role === 'cash' && line.debit > 0), text);
      assert.ok(['ask', 'accountant'].includes(item.outcome), text);
    }
    const [row] = parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions;
    assert.ok(!(row.reviewReasons || []).some((reason) => /آورده/.test(reason)), text);
  }
});

test('منفی: افزایش سرمایهٔ واقعی همچنان برگهٔ آورده است', () => {
  for (const text of [
    'افزایش سرمایه صد میلیون',
    'شریک بابت افزایش سرمایه ۱۰۰ میلیون واریز کرد',
    'افزایش سرمایه برای هزینه های جاری ۱۰۰ میلیون واریز کردم',
    'آقای محمدی ۲۰۰ میلیون به عنوان افزایش سرمایه به حساب بانک ملت واریز کرد.',
  ]) assert.equal(voice(text).path, 'capital', text);
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
const inFreshWorkspace = (callback, policy = { understandingMode: 'active', understandingScope: 'all' }) => {
  const workspace = database.createWorkspace(owner.id, { name: `دفتر p3 ${++workspaceCount}`, profileType: 'business' });
  return database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, async () => {
    database.installChartTemplate();
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, ...policy });
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

test('دفتر: کالا با دورهٔ گفته‌شده پیش‌پرداخت خرید از تأمین‌کننده است و برنامه ندارد؛ خدمتی که «فاکتورش رو ارسال میکنن» برنامه‌اش را دارد', async () => {
  const confirm = (text) => {
    const cash = database.saveAccount({ name: 'صندوق', kind: 'cash', openingBalance: 200_000_000 });
    const parsed = parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions;
    database.insertTransactions({ transcript: text, transactions: parsed.map((row) => ({ ...row, accountId: cash.id, userConfirmed: true, needsReview: false, reviewState: 'ready' })) });
    const db = database.activeWorkspaceDatabase();
    for (const event of db.prepare("SELECT id FROM financial_events WHERE route = 'confirm' AND status = 'pending'").all()) database.confirmPending(event.id);
  };
  for (const [text, amount] of [
    ['علی الحساب خرید مواد اولیه سه ماه آینده ۳۰ میلیون به شرکت آلفا دادیم', 30_000_000],
    ['پیش پرداخت قرارداد تامین مواد اولیه شش ماهه ۶۰ میلیون به شرکت آلفا دادیم', 60_000_000],
  ]) {
    await inFreshWorkspace(async () => {
      confirm(text);
      const debit = ledgerRows().find((row) => row.debit === amount);
      assert.ok(debit?.name.startsWith('پیش‌پرداخت خرید'), `${text}: ${debit?.name}`);
      assert.equal(scheduleTotals().n, 0, text);
    }, {});
  }
  await inFreshWorkspace(async () => {
    confirm('قرارداد پشتیبانی یکساله ۲۴ میلیون به شرکت آلفا دادیم، فاکتورش رو هفته بعد ارسال میکنن');
    assert.ok(!ledgerRows().some((row) => row.name.startsWith('پیش‌پرداخت خرید')));
    assert.deepEqual({ ...scheduleTotals() }, { n: 12, total: 24_000_000 });
  }, {});
});

test('مسیر AI: «advance-paid» برای کالا با دورهٔ گفته‌شده پیش‌پرداخت خرید است و برنامه نمی‌سازد', async () => {
  await inFreshWorkspace(async () => {
    database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 500_000_000 });
    const text = 'پیش پرداخت خرید آهن شش ماه آینده ۵۰ میلیون به آقای رضایی از تجارت دادیم';
    const item = await database.createUnderstandingCase({ text, clientId: 'p3-ai-goods-period' }, aiOptions(modelSaid({ kind: 'advance-paid', what: 'آهن', value: 50_000_000, evidence: '۵۰ میلیون', party: 'آقای رضایی', subjectKind: 'goods' })));
    assert.equal(item.status, 'ready');
    assert.deepEqual(item.plan.components[0].preview.lines.map((line) => line.role), ['supplier-advance', 'cash']);
    database.commitUnderstandingCase(item.id, { now: new Date(NOW) });
    assert.equal(scheduleTotals().n, 0);
  });
});

// ---------------------------------------------------------------------------
// هزینه از جیب شریک: «شریک» و «سهامدار» همان «مدیرعامل»اند
// ---------------------------------------------------------------------------

test('پیش‌پرداخت از جیب شریک/سهامدار مثل مدیرعامل ثبت می‌شود: پیش‌پرداخت در برابر جاری شریک، با برنامهٔ ماهانه', () => {
  for (const [text, amount, payer] of [
    ['آقای رضایی شریکمون اجاره شش ماهه دفتر رو ۳۰ میلیون از جیب خودش داد', 30_000_000, 'آقای رضایی'],
    ['مدیرعامل اجاره شش ماهه دفتر رو ۳۰ میلیون از پول شخصیش داد', 30_000_000, 'مدیرعامل'],
    ['سهامدارمون آقای رضایی بیمه یکساله ماشین شرکت رو ۱۲ میلیون از جیب خودش داد', 12_000_000, 'آقای رضایی'],
    ['آقای رضایی سهامدارمون بیمه یکساله ماشین شرکت رو ۱۲ میلیون از جیب خودش داد', 12_000_000, 'آقای رضایی'],
    ['شریکم اشتراک یک ساله نرم افزار رو ۲۴ میلیون از پول شخصیش پرداخت کرد', 24_000_000, null],
    ['سهام دار شرکت اشتراک دوازده ماهه نرم افزار رو ۲۴ میلیون از جیب خودش داد', 24_000_000, null],
  ]) {
    const [item] = voice(text).items;
    assert.equal(item.outcome, 'post', text);
    assert.equal(item.decision.treatment, 'prepaid-expense', text);
    assert.equal(item.decision.recognitionMethod, 'monthly-straight-line', text);
    assert.deepEqual(item.plan.lines.map((line) => line.role), ['prepaid-asset', 'partner-payable'], text);
    if (payer) assert.equal(item.plan.lines[1].key, payer, text);
  }
  const [goods] = voice('آقای سهرابی شریکمون با پول شخصی خودش ۱۰۰ میلیون مواد اولیه برای شرکت خرید').items;
  assert.equal(goods.outcome, 'post');
  assert.deepEqual(goods.plan.lines.map((line) => line.role), ['inventory-unsplit', 'partner-payable']);
  assert.equal(goods.plan.lines[1].key, 'آقای سهرابی');
  // هزینهٔ سادهٔ شریک همان سؤال هدفی را می‌گیرد که مدیرعامل می‌گیرد.
  for (const text of ['شریکمون هزینه تعمیر کولر ۵ میلیون از جیب خودش داد', 'مدیرعامل هزینه تعمیر کولر ۵ میلیون از جیب خودش داد']) {
    assert.equal(voice(text).items[0].outcome, 'ask', text);
  }
});

test('منفی: پول شریک که به شرکت آمد، وام به دیگری، برداشت و مصرف شخصی، با حسابدار می‌ماند', () => {
  for (const text of [
    'شریکمون از جیب خودش ۵۰ میلیون به شرکت داد',
    'شریکمون ۵۰ میلیون از پول شخصیش به صندوق داد',
    'شریکمون از جیب خودش ۲۰ میلیون به آقای کریمی قرض داد',
    '۳۰ میلیون به شریکمون دادیم',
    'شریک شرکت هفتاد میلیون از حساب شرکت برداشت کرد',
    'شریکمون وسایل ویلای شخصی خودش رو ۲۰ میلیون از پول شخصیش خرید',
  ]) {
    for (const item of voice(text).items) {
      assert.equal(item.outcome, 'accountant', text);
      assert.ok(!item.plan, text);
    }
  }
});

test('دفتر: پیش‌پرداخت از جیب شریک تأیید می‌شود و شش قسط ۳۰ میلیونی می‌سازد', async () => {
  await inFreshWorkspace(async () => {
    const text = 'آقای رضایی شریکمون اجاره شش ماهه دفتر رو ۳۰ میلیون از جیب خودش داد';
    const rows = parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions;
    const result = database.insertTransactions({ transcript: text, transactions: rows.map((row, index) => ({ ...row, occurredAt: row.occurredAt || NOW, userConfirmed: true, clientId: `p3-partner-${index}` })) });
    const eventId = result.nonCash?.[0]?.eventId;
    assert.ok(eventId, JSON.stringify(result));
    const db = database.activeWorkspaceDatabase();
    if (db.prepare('SELECT status FROM financial_events WHERE id = ?').get(eventId).status === 'pending') database.approveEvent(eventId);
    const schedule = db.prepare('SELECT COUNT(*) AS n, SUM(amount) AS total FROM recognition_schedule_items WHERE event_id = ?').get(eventId);
    assert.equal(schedule.n, 6);
    assert.equal(schedule.total, 30_000_000);
    const credit = ledgerRows().find((row) => row.credit === 30_000_000);
    assert.match(credit.name, /جاری شریک/);
    assert.match(credit.name, /آقای رضایی$/);
  }, {});
});

// ---------------------------------------------------------------------------
// بازبینی حسابدار: اشتراک و بیمهٔ «خریدیم … پیش پرداخت» پیش‌پرداخت خرید نیست
// ---------------------------------------------------------------------------

const { isReviewSupplierAdvance } = await import('../shared/reviewSupplierAdvance.js');
const { proposeReview } = await import('../server/accountingReviewAi.js');
const prepaidLines = (amount, key) => [
  { role: 'prepaid-asset', key, accountId: null, chartAccountId: null, debit: amount, credit: 0 },
  { role: 'cash', key: null, accountId: null, chartAccountId: null, debit: 0, credit: amount },
];

test('isReviewSupplierAdvance خدمت دوره‌دار را با همان قاعدهٔ موتور کنار می‌گذارد', () => {
  const eventOf = (text) => {
    const [row] = parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions;
    return { category: row.category, servicePeriodStart: row.servicePeriodStart, servicePeriodEnd: row.servicePeriodEnd };
  };
  for (const text of [
    'اشتراک یک ساله نرم افزار رو خریدیم پیش پرداخت ۲۴ میلیون',
    'لایسنس یک ساله آنتی ویروس خریدیم پیش‌پرداخت ۱۲ میلیون',
    'سرور مجازی شش ماهه خریدیم پیش پرداخت ۶ میلیون',
    'پیش‌پرداخت بیمه بدنه خودرو یک ساله خریداری شد ۳۰ میلیون',
  ]) assert.equal(isReviewSupplierAdvance(text, prepaidLines(1, null), eventOf(text)), false, text);
  // کلید پیشنهادی حسابدار هم کافی است، حتی وقتی دستهٔ رویداد عمومی است.
  assert.equal(isReviewSupplierAdvance('بیمه انبار رو خریدیم پیش پرداخت ۱۲ میلیون', prepaidLines(1, 'بیمه'), { category: 'مواد و کالا' }), false);
  for (const text of [
    'صد و بیست میلیون پیش‌پیش ریختیم واسه خرید ورق',
    'پیش پرداخت خرید کالا ۴۰ میلیون به شرکت آلفا دادیم',
  ]) assert.equal(isReviewSupplierAdvance(text, prepaidLines(1, null), eventOf(text)), true, text);
});

test('دفتر: اشتراکِ «خریدیم پیش پرداخت» در بازبینی نام تأمین‌کننده نمی‌خواهد و پیش‌پرداخت خرید نمی‌شود', async () => {
  for (const [text, amount, key, supplierAdvance] of [
    ['اشتراک یک ساله نرم افزار رو خریدیم پیش پرداخت ۲۴ میلیون', 24_000_000, 'اشتراک', false],
    ['پیش‌پرداخت بیمه بدنه خودرو یک ساله خریداری شد ۳۰ میلیون', 30_000_000, 'بیمه', false],
    ['پیش پرداخت خرید کالا ۴۰ میلیون به شرکت آلفا دادیم', 40_000_000, 'کالا', true],
  ]) {
    await inFreshWorkspace(async () => {
      const cash = database.saveAccount({ name: 'صندوق', kind: 'cash', openingBalance: 100_000_000 });
      const parsed = parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions;
      database.insertTransactions({ transcript: text, transactions: parsed.map((row) => ({ ...row, accountId: cash.id, occurredAt: row.occurredAt || NOW })) });
      const db = database.activeWorkspaceDatabase();
      const event = db.prepare('SELECT id, route FROM financial_events').get();
      if (event.route !== 'accountant-review') database.handOverPending(event.id);
      const proposal = { summary: 'پیش‌پرداخت', explanation: 'پیشنهاد', counterpartyName: null, missingFacts: [], questions: [], inventoryItems: [], lines: prepaidLines(amount, key) };
      const fetcher = async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }], usage: {} }) });
      process.env.OPENAI_API_KEY = 'test-key-not-real';
      await proposeReview(db, event.id, { fetcher, facts: { accountId: cash.id } });
      const queued = database.reviewQueue().items.find((item) => item.id === event.id);
      const nameBlocker = (queued.aiProposal?.postingBlockers || []).some((reason) => /طرف[‌\s]*حساب/.test(reason));
      if (supplierAdvance) {
        // پیش‌پرداخت خرید واقعی همچنان به نام تأمین‌کننده بسته است.
        assert.ok(queued.aiProposal.lines.some((line) => /شرکت آلفا/.test(line.accountName || '')), text);
      } else {
        assert.equal(nameBlocker, false, text);
        assert.equal(queued.aiProposal.canPost, true, text);
        assert.ok(!queued.aiProposal.lines.some((line) => /پیش‌پرداخت خرید/.test(line.accountName || '')), text);
      }
    }, {});
  }
});

// ---------------------------------------------------------------------------
// باقی یا قسط بعدیِ قرارداد موجود: بدهی یا طلب همان قرارداد، نه پیش‌پرداخت تازه
// ---------------------------------------------------------------------------

const { readsContractRemainder, priorSettlementDirection } = await import('../shared/priorSettlement.js');
const { detectSettleIntent, ledgerBalanceTargets } = await import('../shared/settleSpeech.js');
const { judgmentReason } = await import('../shared/moneyPurpose.js');
const { understandingReasons } = await import('../shared/understandingScope.js');
const { EVENT_KINDS, normalizeFinancialEvent } = await import('../shared/financialEvent.js');
const { routeEvent } = await import('../shared/confidenceEngine.js');
const { recordFinancialEvent } = await import('../server/financialEventStore.js');

// جملهٔ واقعی گزارش عیناً، با شکل‌های هم‌ارز: باقی/بقیه/مابقی/باقیمانده، قسط
// دوم/دومین قسط/قسط ۲، بیمه/حق بیمه/بیمه‌نامه/اجاره/کرایه/اشتراک، رقم لاتین،
// ی و ک عربی.
const CONTRACT_PAID = [
  ['باقی حق بیمه انبار ۹ میلیون رو هم از حساب تجارت دادیم', 'remainder', 9_000_000],
  ['قسط دوم بیمه آتش سوزی ۳ میلیون از حساب تجارت دادیم', 'later-instalment', 3_000_000],
  ['قسط دوم حق بیمه آتش سوزی ۳ میلیون پرداخت شد', 'later-instalment', 3_000_000],
  ['دومین قسط بیمه نامه آتش سوزی رو ۳ میلیون دادیم', 'later-instalment', 3_000_000],
  ['قسط دوم اجاره دفتر ۳ میلیون دادیم', 'later-instalment', 3_000_000],
  ['بقیه حق بیمه ۹ میلیون رو به بیمه ایران دادیم', 'remainder', 9_000_000],
  ['مابقی حق اشتراک یک ساله نرم افزار ۶ میلیون رو دادیم', 'remainder', 6_000_000],
  ['باقیمانده اجاره دفتر 9 ميليون پرداخت كرديم', 'remainder', 9_000_000],
  ['قسط 2 بیمه 3 میلیون دادیم', 'later-instalment', 3_000_000],
  ['آخرین قسط بیمه‌نامه انبار ۳ میلیون رو کارت به کارت کردیم', 'later-instalment', 3_000_000],
  ['بقیه پول اجاره رو ۹ میلیون دادیم', 'remainder', 9_000_000],
];
// آینه: مستاجر یا مشتری باقی قرارداد را به ما داد — طلب ما بسته می‌شود.
const CONTRACT_RECEIVED = [
  ['بقیه اجاره رو مستاجر ۹ میلیون واریز کرد', 'remainder', 9_000_000],
  ['قسط دوم اجاره رو مستاجر ۳ میلیون واریز کرد', 'later-instalment', 3_000_000],
  ['مابقی کرایه مغازه رو مستاجر ریخت ۹ میلیون', 'remainder', 9_000_000],
];

test('باقی یا قسط بعدیِ قرارداد، پرداختِ بدهی همان قرارداد است و کارت تسویه را باز می‌کند؛ آینه‌اش طلب را می‌بندد', () => {
  for (const [rows, direction] of [[CONTRACT_PAID, 'payable'], [CONTRACT_RECEIVED, 'receivable']]) {
    for (const [text, cue, amount] of rows) {
      assert.equal(readsContractRemainder(text), cue, text);
      assert.equal(priorSettlementDirection(text), direction, text);
      const result = voice(text);
      assert.equal(result.path, 'settle', text);
      assert.equal(result.items[0].amount, amount, text);
      // هیچ دارایی پیش‌پرداخت و هیچ دورهٔ پوشش تازه‌ای.
      assert.ok(!(result.items[0].plan?.lines || []).some((line) => line.role === 'prepaid-asset'), text);
      // مسیر AI هم این جمله را تسویهٔ قبلی می‌شناسد، نه رویداد تازه.
      assert.ok(understandingReasons(text).includes('prior-settlement'), text);
    }
  }
});

test('قسط بیمه و اجاره قسط وام نیست؛ قسط وام بانک همچنان وام است', () => {
  for (const [text] of [...CONTRACT_PAID, ...CONTRACT_RECEIVED]) {
    assert.doesNotMatch(judgmentReason(text) || '', /وام/, text);
  }
  // قسطِ بی‌شماره یا قسط اولِ یک قرارداد: کل مبلغ و بدهی باقی در جمله نیست — حسابدار.
  for (const text of ['قسط بیمه آتش سوزی ۳ میلیون دادیم', 'قسط اول اجاره دفتر ۳ میلیون دادیم']) {
    assert.equal(readsContractRemainder(text), 'instalment', text);
    assert.match(judgmentReason(text), /قرارداد/, text);
    const item = voice(text).items[0];
    assert.equal(item.outcome, 'accountant', text);
    assert.equal(roles(item).length, 0, text);
  }
  // «قسطی میدیم» آینده است: بدهی باقی به همان طرف، نه وام و نه پرداخت امروز.
  for (const text of ['بقیه‌اش رو قسطی میدیم', 'بیمه یک ساله انبار ۱۲ میلیون، ۳ میلیونش رو الان از حساب تجارت دادیم بقیه رو قسطی میدیم']) {
    assert.equal(readsContractRemainder(text), null, text);
    assert.equal(priorSettlementDirection(text), null, text);
    assert.doesNotMatch(judgmentReason(text) || '', /اصل و سود/, text);
  }
  for (const text of ['قسط وام بانک ملت ۳ میلیون دادیم', 'قسط وام ۱۱ میلیون تومان دادم، ۹ میلیون اصل و ۲ میلیون سود', 'قسط تسهیلات ۵ میلیون از حساب ملت کم شد']) {
    assert.equal(readsContractRemainder(text), null, text);
    assert.match(judgmentReason(text), /وام/, text);
  }
});

test('منفی: قرارداد تازه، استرداد و «بقیه» بی‌قرارداد وارد مسیر باقی قرارداد نمی‌شوند', () => {
  for (const text of [
    'بیمه یک ساله انبار ۱۲ میلیون دادیم',
    'اجاره ۶ ماه دفتر رو جلوتر دادیم ۳۰ میلیون',
    'مابقی حق بیمه رو بیمه ایران برگشت داد ۵ میلیون',
    'باقی اجاره رو موجر پس داد',
    'بقیه ۹ میلیون رو به حساب ملت ریختیم',
  ]) {
    assert.equal(readsContractRemainder(text), null, text);
    assert.notEqual(voice(text).path, 'settle', text);
  }
  // قرارداد تازه همان پیش‌پرداخت با برنامهٔ ماهانه می‌ماند.
  assert.deepEqual(roles(voice('بیمه یک ساله انبار ۱۲ میلیون دادیم').items[0]).map(([role]) => role), ['prepaid-asset', 'cash']);
});

test('موتور تصمیم از هر مسیری برای باقی یا قسطِ قرارداد، دورهٔ پوشش تازه نمی‌سازد', () => {
  const base = { moneyDirection: 'out', amount: 9_000_000, occurredAt: NOW, category: 'بیمه', servicePeriodStart: NOW, servicePeriodEnd: '2027-10-09T00:00:00.000Z' };
  for (const [text] of CONTRACT_PAID) {
    // ردیف «فهم رویداد» قضاوت جمله را با خود نمی‌آورد؛ خود موتور جمله را می‌خواند.
    const decision = decide({ ...base, evidence: text, utterance: text }, { today: NOW });
    assert.equal(decision.decisionStatus, 'needs-accountant-review', text);
    assert.notEqual(decision.treatment, 'prepaid-expense', text);
  }
  const fresh = decide({ ...base, evidence: 'بیمه یک ساله انبار ۱۲ میلیون دادیم', utterance: 'بیمه یک ساله انبار ۱۲ میلیون دادیم' }, { today: NOW });
  assert.equal(fresh.treatment, 'prepaid-expense');
});

test('دفتر: «باقی حق بیمه» بدهی بیمه‌گر را می‌بندد؛ پیش‌پرداخت دوم و برنامهٔ تازه ساخته نمی‌شود', async () => {
  await inFreshWorkspace(async () => {
    const db = database.activeWorkspaceDatabase();
    database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 500_000_000 });
    // بدهی ۹ میلیونی بیمه‌گر که حسابدار هنگام صدور بیمه‌نامه ثبت کرده است.
    const insurer = database.saveContact({ name: 'بیمه ایران' });
    const opened = normalizeFinancialEvent({ kind: EVENT_KINDS.PAYABLE_OPENED, amount: 9_000_000, occurredAt: NOW, counterparty: insurer.name, counterpartyId: insurer.id, category: 'بیمه', source: 'text' });
    recordFinancialEvent(db, opened, { sourceEventId: 'review-approved:policy-inception', decision: routeEvent(opened, { components: { amountCertainty: 1, moneyDirectionCertainty: 1, dateCertainty: 1, completeness: 1, counterpartyCertainty: 1 } }) });
    assert.equal(database.ledgerSideBalances(insurer.id).uncoveredPayable, 9_000_000);
    const schedule = scheduleTotals().n;

    for (const [text, amount] of [['قسط دوم بیمه آتش سوزی ۳ میلیون از حساب تجارت دادیم', 3_000_000], ['باقی حق بیمه انبار ۶ میلیون رو هم از حساب تجارت دادیم', 6_000_000]]) {
      // ثبت مستقیم به‌عنوان هزینه یا پیش‌پرداخت تازه پذیرفته نمی‌شود.
      const parsed = parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions;
      assert.throws(() => database.insertTransactions({ transcript: text, transactions: parsed }), /طلب یا بدهی قبلی/, text);
      // کارت تسویه همان بدهی دفتر کل را پیشنهاد می‌کند.
      const draft = detectSettleIntent(text, { now: new Date(NOW) });
      const target = ledgerBalanceTargets(draft, { contacts: database.listContacts() }).find((item) => item.contactId === insurer.id);
      assert.ok(target, text);
      assert.equal(target.direction, 'payable', text);
      database.settleLedgerBalance(target.contactId, { direction: target.direction, amount, clientId: `p3-remainder-${amount}` });
    }
    assert.equal(database.ledgerSideBalances(insurer.id).uncoveredPayable, 0);
    assert.equal(scheduleTotals().n, schedule);
    assert.ok(!ledgerRows().some((row) => row.name.startsWith('پیش‌پرداخت') && row.debit > 0));
  });
});

test('مسیر AI: باقی یا قسطِ قرارداد، هر برچسبی که مدل بزند، دورهٔ پوشش تازه نمی‌سازد', async () => {
  for (const [text, kind, value, evidence] of [
    ['باقی حق بیمه انبار ۹ میلیون رو هم از حساب تجارت دادیم', 'advance-paid', 9_000_000, '۹ میلیون'],
    ['باقی حق بیمه انبار ۹ میلیون رو هم از حساب تجارت دادیم', 'expense', 9_000_000, '۹ میلیون'],
    ['مابقی حق اشتراک یک ساله نرم افزار ۶ میلیون رو از حساب تجارت دادیم', 'advance-paid', 6_000_000, '۶ میلیون'],
    ['قسط دوم بیمه آتش سوزی ۳ میلیون از حساب تجارت دادیم', 'expense', 3_000_000, '۳ میلیون'],
  ]) {
    await inFreshWorkspace(async () => {
      database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 500_000_000 });
      const item = await database.createUnderstandingCase({ text, clientId: `p3-ai-rest-${kind}-${value}` }, aiOptions(modelSaid({ kind, what: 'بیمه', value, evidence })));
      assert.equal(item.status, 'needs-accountant', `${kind}: ${text}`);
      assert.ok(!item.plan.components.some((component) => (component.preview?.lines || []).some((line) => line.role === 'prepaid-asset')), text);
      assert.equal(scheduleTotals().n, 0, text);
    });
  }
});

// ---------------------------------------------------------------------------
// پیش‌پرداخت بی‌تاریخ: «تاریخ نگفته یعنی امروز»؛ «ریختیم/زدیم» فعل پرداخت است
// ---------------------------------------------------------------------------

const PAYMENT_DATE_REASON = /^تاریخ پرداخت مشخص نیست/;
// جمله‌های واقعی گزارش عیناً، به‌علاوهٔ فعل‌های هم‌ارز با بیمه، اجاره، اشتراک و لایسنس.
const UNDATED_PREPAID = [
  ['سرور ابری ۱۲ ماهه ۱۸ میلیون ریختیم', 18_000_000, 12],
  ['بیمه آتش سوزی یکساله ۱۲ میلیون ریختیم به حساب بیمه ایران', 12_000_000, 12],
  ['بیمه یکساله ۱۲ میلیون دادیم', 12_000_000, 12],
  ['اجاره ۶ ماه دفتر رو جلوتر دادیم ۳۰ میلیون', 30_000_000, 6],
  ['بیمه یک ساله مغازه ۱۲ میلیون دادیم', 12_000_000, 12],
  ['سرور ابری ۱۲ ماهه ۱۸ میلیون زدیم', 18_000_000, 12],
  ['لایسنس یک ساله آنتی ویروس ۸ میلیون زدم', 8_000_000, 12],
  ['اشتراک شش ماهه نرم افزار ۶ میلیون ریختم', 6_000_000, 6],
  ['اجاره شش ماهه مغازه ۴۸ میلیون ریختیم', 48_000_000, 6],
  ['بیمه یکساله خودرو ۹ میلیون زدیم', 9_000_000, 12],
];

test('پیش‌پرداخت بی‌تاریخ گفته‌شده، امروز پرداخت شده است: نه دلیل «تاریخ پرداخت مشخص نیست»، نه ابهام نوع، نه حسابدار', () => {
  for (const [text, amount] of UNDATED_PREPAID) {
    const row = parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions[0];
    assert.equal(row.amount, amount, text);
    assert.equal(row.type, 'expense', text);
    assert.ok(row.confidence >= 0.9, `${text}: ${row.confidence}`);
    assert.ok(row.servicePeriodStart, text);
    assert.equal(row.paymentDateUnknown, undefined, text);
    assert.ok(!(row.reviewReasons || []).some((reason) => PAYMENT_DATE_REASON.test(reason)), text);
    assert.ok(!(row.reviewReasons || []).some((reason) => /نوع/.test(reason)), text);
    const item = voice(text).items[0];
    assert.notEqual(item.outcome, 'accountant', text);
    assert.deepEqual(roles(item).map(([role]) => role), ['prepaid-asset', 'cash'], text);
  }
});

test('تاریخ گفته‌شده همان تاریخ پرداخت است؛ شروع پوششِ گفته‌شده بی‌تاریخ پرداخت هنوز پرسیده می‌شود', () => {
  for (const [text, iso] of [
    ['بیمه یک ساله مغازه ۱۲ میلیون امروز دادیم', '2026-10-10'],
    ['بیمه یک ساله مغازه ۱۲ میلیون دیروز دادیم', '2026-10-09'],
    ['بیمه یک ساله مغازه ۱۲ میلیون ۱۵ مهر دادیم', '2026-10-07'],
  ]) {
    const row = parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions[0];
    assert.equal(row.occurredAt.slice(0, 10), iso, text);
    assert.equal(row.paymentDateUnknown, undefined, text);
    assert.ok(!(row.reviewReasons || []).some((reason) => PAYMENT_DATE_REASON.test(reason)), text);
  }
  // دورهٔ پوشش با ماه‌های نام‌برده: تاریخ پوشش جای تاریخ پرداخت نیست.
  for (const text of ['بیمه آتش سوزی از اول آبان تا آخر مهر سال بعد ۱۲ میلیون دادیم', 'اجاره دفتر از اول فروردین تا آخر اسفند ۱۲۰ میلیون دادیم']) {
    const row = parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions[0];
    assert.equal(row.paymentDateUnknown, true, text);
    assert.ok(row.reviewReasons.some((reason) => PAYMENT_DATE_REASON.test(reason)), text);
  }
});

test('منفی: «فروش زدیم»، پولی که به حساب ما ریخته شد و صدور فاکتور، پرداخت مطمئن نمی‌شوند', () => {
  const row = (text) => parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions[0];
  assert.equal(row('امروز ۵۰ میلیون فروش زدیم').type, 'income');
  assert.equal(row('مشتری ۱۰ میلیون ریخت به حساب شرکت').type, 'income');
  assert.equal(row('۱۰ میلیون ریختن به حسابمون معلوم نیس کی ریخته').type, 'income');
  // واریز نقد به بانک خودمان انتقال است، نه هزینهٔ مطمئن.
  for (const text of ['۵ میلیون نقد رو ریختیم به حساب ملت', 'نقد ۵ میلیون رو به حساب ملت ریختیم', '۵ میلیون نقد رو ریختیم تو کارت ملت', '۵ میلیون ریختیم به حساب شرکت', '۵ میلیون ریختیم به صندوق', '۲۰ میلیون فاکتور زدیم برای مشتری']) {
    const parsed = row(text);
    assert.ok(parsed.type !== 'expense' || parsed.confidence < 0.8, `${text}: ${parsed.type} ${parsed.confidence}`);
  }
  // پرداخت به حساب شخص دیگر، پرداخت است.
  assert.equal(row('۳ میلیون ریختیم به حساب آقای رضایی').type, 'expense');
});

test('منفی: «قرارداد/قولنامه … زدیم/بستیم»، «ضرر زدیم» و قیمتِ «N میلیونی» پرداخت نیستند و هیچ سندی نمی‌سازند', () => {
  for (const text of [
    // جمله‌های بازبین، عیناً.
    'یه قرارداد بیمه یکساله ۱۲ میلیونی با بیمه ایران زدیم',
    '۱۰۰ میلیون قرارداد زدیم با شرکت آلفا',
    'یه قرارداد پشتیبانی یکساله ۲۴ میلیونی با شرکت آلفا زدیم',
    'قرارداد اجاره یکساله دفتر ۱۲۰ میلیونی با آقای رضایی زدیم',
    'اقای رضایی قرارداد اجاره یکساله ۱۲۰ میلیونی زدیم',
    'قولنامه اجاره مغازه رو زدیم ۶۰ میلیون',
    'قرارداد تبلیغات شش ماهه 60 میلیونی بستیم',
    'شرکت آلفا قرارداد پشتیبانی یکساله ۲۴ میلیونی با ما بست',
    'یه بیمه یکساله ۱۲ میلیونی زدیم',
    '۵۰ میلیون ضرر زدیم',
  ]) {
    for (const item of voice(text).items) {
      assert.notEqual(item.outcome, 'post', text);
      assert.ok(item.outcome === 'accountant', `${text}: ${item.outcome} ${item.fact || ''}`);
    }
  }
  // پرداختِ گفته‌شده کنار قرارداد همچنان پرداخت است.
  const [paid] = voice('قرارداد اجاره شش ماهه بستیم ۳۰ میلیون دادیم').items;
  assert.equal(paid.decision.treatment, 'prepaid-expense');
  assert.equal(judgmentReason('قرارداد پشتیبانی یکساله ۲۴ میلیون کارت به کارت زدیم به شرکت آلفا'), null);
});

test('دفتر: «قرارداد بیمه … زدیم» با تأیید برگه سند نقدی و برنامه نمی‌سازد', async () => {
  await inFreshWorkspace(async () => {
    const text = 'یه قرارداد بیمه یکساله ۱۲ میلیونی با بیمه ایران زدیم';
    const cash = database.saveAccount({ name: 'صندوق', kind: 'cash', openingBalance: 100_000_000 });
    const parsed = parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions;
    database.insertTransactions({ transcript: text, transactions: parsed.map((row) => ({ ...row, accountId: cash.id, userConfirmed: true, needsReview: false, reviewState: 'ready' })) });
    const db = database.activeWorkspaceDatabase();
    for (const event of db.prepare("SELECT id FROM financial_events WHERE route = 'confirm' AND status = 'pending'").all()) {
      try { database.confirmPending(event.id); } catch { /* حسابدار */ }
    }
    assert.ok(!db.prepare('SELECT status FROM financial_events').all().some((event) => event.status === 'posted'));
    assert.ok(!ledgerRows().some((row) => row.name === 'صندوق' && row.credit > 0));
    assert.equal(scheduleTotals().n, 0);
  }, {});
});

test('دفتر: «سرور ابری ۱۲ ماهه ۱۸ میلیون ریختیم» با یک تأیید برگه ثبت می‌شود و دوازده قسط می‌سازد', async () => {
  for (const [text, amount, months] of [UNDATED_PREPAID[0], UNDATED_PREPAID[4]]) {
    await inFreshWorkspace(async () => {
      const cash = database.saveAccount({ name: 'صندوق', kind: 'cash', openingBalance: 100_000_000 });
      const parsed = parseFinancialText(text, { source: 'voice', now: new Date(NOW) }).transactions;
      // همان چیزی که برگهٔ تأیید می‌فرستد: بی‌تاریخ، با دلیل‌های خود پارسر.
      database.insertTransactions({ transcript: text, transactions: parsed.map((row) => ({ ...row, accountId: cash.id, userConfirmed: true, needsReview: false, reviewState: 'ready' })) });
      const event = database.activeWorkspaceDatabase().prepare('SELECT route, status FROM financial_events').get();
      assert.notEqual(event.route, 'accountant-review', text);
      assert.equal(event.status, 'posted', text);
      const schedule = scheduleTotals();
      assert.equal(schedule.n, months, text);
      assert.equal(schedule.total, amount, text);
    }, {});
  }
});
