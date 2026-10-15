import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
import { runVoice } from './helpers/voicePipeline.js';
import { classifyCategory } from '../shared/categoryRules.js';
import { validateUnderstanding } from '../shared/eventUnderstanding.js';

/**
 * دستهٔ هزینه و درآمد از فهمِ موضوع، نه از واژهٔ توصیفی (۲۳ مهر ۱۴۰۵).
 *
 * گزارش مالک محصول: «پرداخت ۲ میلیون بابت خرید کلید برق از شرکت آریا از حساب تنخواه
 * شیرازی» از مسیر AI گذشت؛ مدل موضوع را «کلید برق، کالا» فهمید ولی طرح دسته را از
 * فهرست واژه گرفت، «برق» را دید و «قبوض» را بی‌سؤال ثبت کرد. خانواده:
 *
 * - مسیر AI: دستهٔ خودِ مدل، وقتی با نوع موضوع و جهت پول جور است؛ دستهٔ ناجورِ مدل یا
 *   فهرست واژه (کالا در «قبوض»، هزینه برای پول آمده) پذیرفته نمی‌شود.
 * - گفتهٔ چندمبلغی: دستهٔ مدل فقط به مبلغی می‌رسد که موضوع در بخش خودش است.
 * - تعمیر یا سرویسِ یک دارایی: پولِ خدمت است، نه خرید دارایی ثابت.
 * - مسیر بی‌AI: «برق»، «تلفن»، «اینترنت»، «گاز» و «حقوق» پس از اسم اصلی صفت‌اند.
 * - نمونه‌های منفی: قبض واقعی، پول برق، شارژ ساختمان و حقوق کارمند همان دستهٔ قبل.
 */

const NOW = '2026-10-14T08:00:00.000Z';
const none = { op: null, of: [] };

process.env.DATABASE_PATH = tempDatabase('category-understanding');
process.env.ADMIN_USERNAME = 'category-owner';
process.env.ADMIN_PASSWORD = 'category-strong-password-7731';
const database = await import('../server/db.js');
database.ensureAdmin();
const owner = database.authenticateUser('category-owner', 'category-strong-password-7731');

let counter = 0;
const inFreshWorkspace = (callback) => {
  const workspace = database.createWorkspace(owner.id, { name: `دفتر دسته — ${++counter}`, profileType: 'business' });
  return database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
};
const amt = (id, value, role, evidence) => ({ id, value, currency: 'toman', role, status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence });
const mv = (id, amountRef, direction, from, to, evidence = '') => ({ id, amountRef, direction, from, to, evidence });
const US = { kind: 'us', name: null };
const CASH = { kind: 'cash', name: 'صندوق' };
const NOBODY = { kind: 'counterparty', name: null };
const model = (partial) => ({
  event: { kind: 'expense', description: '', status: 'done' },
  amounts: [], nonAmountNumbers: [], dates: [], counterparties: [], movements: [],
  subject: { what: null, kind: null, use: 'unknown', category: null, delivered: 'unknown', usefulLifeMonths: null, evidence: null },
  conditions: [], ambiguities: [],
  ...partial,
});
const subject = (what, kind, category, extra = {}) => ({ what, kind, use: 'unknown', category, delivered: 'unknown', usefulLifeMonths: null, evidence: what, ...extra });
const fetcherFor = (said) => async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(said) }] }], usage: { input_tokens: 1, output_tokens: 1 } }) });
const ANSWERS = { 'movements.m1.account': { valueId: 'cash' }, 'counterparties.c1': { valueId: 'new' } };

/** دفتر آزمایشی سایت: موتور نسخهٔ دو و فهم برای همهٔ گفته‌ها. */
async function understood(text, said) {
  database.installChartTemplate();
  database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all' });
  database.saveAccount({ name: 'جاری ملت', kind: 'bank', bankId: 'mellat', openingBalance: 500_000_000 });
  database.saveAccount({ id: 'cash', name: 'صندوق نقدی', kind: 'cash', openingBalance: 100_000_000 });
  const options = { fetcher: fetcherFor(said), env: { OPENAI_API_KEY: 'test-key-not-real', OPENAI_UNDERSTANDING_MODEL: 'test-model' }, now: new Date(NOW) };
  let item = await database.createUnderstandingCase({ text, clientId: `category-${counter}-${Math.random()}` }, options);
  const open = Object.fromEntries(Object.entries(ANSWERS).filter(([id]) => (item.plan?.questions || []).some((question) => question.id === id)));
  if (Object.keys(open).length) item = await database.answerUnderstandingCase(item.id, open, options);
  return item;
}
const categories = (item) => (item.plan?.components || []).map((component) => component.category);
const treatments = (item) => (item.plan?.components || []).map((component) => component.preview?.treatment || null);

/** پرداختِ یک‌مبلغی از صندوق با موضوعی که مدل فهمیده. */
const paid = (text, value, evidence, subjectSaid, extra = {}) => understood(text, model({
  event: { kind: 'purchase', description: '', status: 'done' },
  amounts: [amt('a1', value, 'paid-now', evidence)],
  movements: [mv('m1', 'a1', 'out', CASH, NOBODY, evidence)],
  subject: subjectSaid,
  ...extra,
}));

test('گزارش مالک محصول: «کلید برق» کالاست؛ دستهٔ مدل جای «قبوض»ِ فهرست واژه را می‌گیرد', async () => {
  await inFreshWorkspace(async () => {
    const text = 'پرداخت ۲ میلیون بابت خرید کلید برق از شرکت آریا از حساب تنخواه شیرازی';
    const item = await understood(text, model({
      event: { kind: 'purchase', description: 'خرید کلید برق از شرکت آریا', status: 'done' },
      amounts: [amt('a1', 2_000_000, 'paid-now', '۲ میلیون')],
      counterparties: [{ id: 'c1', name: 'شرکت آریا', role: 'supplier', evidence: 'شرکت آریا' }],
      movements: [mv('m1', 'a1', 'out', { kind: 'petty-cash', name: 'تنخواه شیرازی' }, { kind: 'counterparty', name: 'شرکت آریا' }, 'از حساب تنخواه شیرازی')],
      subject: subject('کلید برق', 'goods', 'ملزومات اداری', { evidence: 'خرید کلید برق' }),
    }));
    assert.deepEqual(categories(item), ['ملزومات اداری']);
  });
});

test('کالا و تجهیزات با اسم توصیفیِ قبض: دستهٔ مدل می‌نشیند، هرگز «قبوض»', async () => {
  const family = [
    ['خرید مودم اینترنت برای دفتر ۳ میلیون', 3_000_000, '۳ میلیون', subject('مودم اینترنت', 'goods', 'ملزومات اداری'), 'ملزومات اداری'],
    ['یه گوشی تلفن برای منشی ۱ میلیون و ۵۰۰ خریدیم', 1_500_000, '۱ میلیون و ۵۰۰', subject('گوشی تلفن', 'goods', 'ملزومات اداری'), 'ملزومات اداری'],
    ['کابل برق و سیم واسه کارگاه ۸۰۰ هزار تومن', 800_000, '۸۰۰ هزار تومن', subject('کابل برق و سیم', 'goods', 'تعمیر و نگهداری'), 'تعمیر و نگهداری'],
    ['اجاق گاز آبدارخونه رو ۲ میلیون خریدیم', 2_000_000, '۲ میلیون', subject('اجاق گاز آبدارخونه', 'goods', 'ملزومات اداری'), 'ملزومات اداری'],
    ['کتاب حقوق تجارت برای کتابخونهٔ دفتر ۴۰۰ هزار تومن', 400_000, '۴۰۰ هزار تومن', subject('کتاب حقوق تجارت', 'goods', 'آموزش'), null],
  ];
  for (const [text, value, evidence, said, expected] of family) {
    await inFreshWorkspace(async () => {
      const item = await paid(text, value, evidence, said);
      const [category] = categories(item);
      // «آموزش» برای کالا ناجور است (خدمت است)؛ هرچه جایش بنشیند، «حقوق» یا «قبوض» نیست.
      if (expected) assert.equal(category, expected, text);
      assert.ok(!['قبوض', 'حقوق و دستمزد', 'آموزش'].includes(category), `${text} → ${category}`);
    });
  }
});

test('دستهٔ ناجورِ مدل پذیرفته نمی‌شود: کالا در «قبوض»، هزینه برای پولِ آمده', async () => {
  await inFreshWorkspace(async () => {
    // مدل کالا گفت ولی «قبوض» برگزید: هیچ‌کدام از دو منبع کالا را قبض نمی‌کنند.
    const item = await paid('پرداخت ۲ میلیون بابت خرید کلید برق', 2_000_000, '۲ میلیون', subject('کلید برق', 'goods', 'قبوض'));
    assert.notEqual(categories(item)[0], 'قبوض');
  });
  await inFreshWorkspace(async () => {
    // مدل دستهٔ هزینه برای دریافتی برگزید؛ دستهٔ درآمد از جای دیگر می‌آید.
    const item = await understood('بابت تعمیر لپ‌تاپ مشتری ۲ میلیون نقد گرفتیم', model({
      event: { kind: 'income', description: '', status: 'done' },
      amounts: [amt('a1', 2_000_000, 'received-now', '۲ میلیون')],
      movements: [mv('m1', 'a1', 'in', NOBODY, CASH, 'نقد گرفتیم')],
      subject: subject('تعمیر لپ‌تاپ مشتری', 'service', 'تعمیر و نگهداری'),
    }));
    // خدمتی که ما انجام دادیم و پولش آمده، درآمد خدمات است (محک دسته، I004 و I015).
    assert.deepEqual(categories(item), ['خدمات']);
  });
});

test('خدمتِ بیرونی با واژهٔ مالیات یا حقوق: دستهٔ مدل، نه دستهٔ واژه', async () => {
  await inFreshWorkspace(async () => {
    const item = await paid('حق‌الزحمهٔ مشاور مالیاتی ۵ میلیون نقد دادیم', 5_000_000, '۵ میلیون',
      subject('مشاور مالیاتی', 'service', 'پیمانکار و خدمات بیرونی'), { event: { kind: 'expense', description: '', status: 'done' } });
    assert.deepEqual(categories(item), ['پیمانکار و خدمات بیرونی']);
  });
});

test('تعمیر یک دارایی پولِ خدمت است، نه خرید دارایی ثابت', async () => {
  for (const [text, value, evidence, what] of [
    ['تعمیر کولر آبی دفتر ۱ میلیون و ۸۰۰', 1_800_000, '۱ میلیون و ۸۰۰', 'کولر آبی'],
    ['تعمیر ماشین شرکت ۴ میلیون', 4_000_000, '۴ میلیون', 'ماشین شرکت'],
  ]) {
    await inFreshWorkspace(async () => {
      const item = await paid(text, value, evidence, subject(what, 'asset', 'تعمیر و نگهداری', { use: 'internal' }),
        { event: { kind: 'asset-purchase', description: '', status: 'done' } });
      assert.deepEqual(categories(item), ['تعمیر و نگهداری'], text);
      assert.notEqual(treatments(item)[0], 'fixed-asset', text);
    });
  }
  // نمونهٔ منفی: خریدِ خودِ دستگاه همچنان دارایی است.
  await inFreshWorkspace(async () => {
    const item = await paid('یه کولر آبی برای دفتر ۴۰ میلیون خریدیم', 40_000_000, '۴۰ میلیون', subject('کولر آبی', 'asset', 'ملزومات اداری', { use: 'internal' }),
      { event: { kind: 'asset-purchase', description: '', status: 'done' } });
    assert.equal(treatments(item)[0], 'fixed-asset');
  });
});

test('نمونه‌های منفی: قبض واقعی همان «قبوض» است، با دستهٔ مدل یا بی آن', async () => {
  for (const [text, value, evidence, said] of [
    ['قبض برق دفتر ۸۰۰ هزار تومن نقد دادیم', 800_000, '۸۰۰ هزار تومن', subject('قبض برق دفتر', 'service', 'قبوض')],
    ['قبض گاز و آب این ماه ۶۰۰ هزار تومن', 600_000, '۶۰۰ هزار تومن', subject('قبض گاز و آب', 'service', null)],
    ['پول اینترنت این ماه دفتر ۴۰۰ هزار تومن', 400_000, '۴۰۰ هزار تومن', subject('اینترنت دفتر', 'service', null)],
  ]) {
    await inFreshWorkspace(async () => {
      const item = await paid(text, value, evidence, said, { event: { kind: 'expense', description: '', status: 'done' } });
      assert.deepEqual(categories(item), ['قبوض'], text);
    });
  }
});

test('گفتهٔ چندمبلغی: دستهٔ مدل فقط به مبلغی می‌رسد که موضوع در بخش خودش است', async () => {
  await inFreshWorkspace(async () => {
    const item = await understood('بیمه یک‌ساله تجهیزات ۱۲ میلیون و ناهار پرسنل ۲ میلیون، هر دو رو نقد دادیم', model({
      event: { kind: 'expense', description: '', status: 'done' },
      amounts: [amt('a1', 12_000_000, 'paid-now', 'بیمه یک‌ساله تجهیزات ۱۲ میلیون'), amt('a2', 2_000_000, 'paid-now', 'ناهار پرسنل ۲ میلیون')],
      movements: [mv('m1', 'a1', 'out', US, NOBODY, 'نقد دادیم'), mv('m2', 'a2', 'out', US, NOBODY, 'نقد دادیم')],
      subject: subject('بیمه تجهیزات', 'service', 'بیمه', { evidence: 'بیمه یک‌ساله تجهیزات' }),
      nonAmountNumbers: [{ value: 'یک‌ساله', role: 'duration', evidence: 'بیمه یک‌ساله تجهیزات ۱۲ میلیون' }],
    }));
    assert.deepEqual(categories(item), ['بیمه', 'خوراک']);
  });
});

test('درآمد: دستهٔ درآمدیِ مدل می‌نشیند', async () => {
  await inFreshWorkspace(async () => {
    const item = await understood('کلاس آموزش اکسل برگزار کردیم ۶ میلیون ثبت‌نام نقد گرفتیم', model({
      event: { kind: 'income', description: '', status: 'done' },
      amounts: [amt('a1', 6_000_000, 'received-now', '۶ میلیون')],
      movements: [mv('m1', 'a1', 'in', NOBODY, CASH, 'نقد گرفتیم')],
      subject: subject('کلاس آموزش اکسل', 'service', 'خدمات'),
    }));
    assert.deepEqual(categories(item), ['خدمات']);
  });
});

test('«سایر هزینه‌ها»ی مدل جای دستهٔ مشخصِ فهرست واژه را نمی‌گیرد', async () => {
  await inFreshWorkspace(async () => {
    const item = await paid('اجاره انبار این ماه ۸ میلیون نقد دادیم', 8_000_000, '۸ میلیون', subject('اجاره انبار', 'service', 'سایر هزینه‌ها'),
      { event: { kind: 'expense', description: '', status: 'done' } });
    assert.deepEqual(categories(item), ['اجاره']);
  });
});

test('اعتبارسنجی: دسته‌ای بیرون از فهرست برنامه پذیرفته نمی‌شود', () => {
  const said = model({ subject: subject('کلید برق', 'goods', 'لوازم برقی') });
  assert.equal(validateUnderstanding(said, { text: 'خرید کلید برق ۲ میلیون', now: new Date(NOW) }).understanding?.subject?.category ?? null, null);
  const fine = model({ subject: subject('کلید برق', 'goods', 'ملزومات اداری') });
  const validated = validateUnderstanding(fine, { text: 'خرید کلید برق ۲ میلیون', now: new Date(NOW) });
  assert.equal((validated.understanding || validated).subject.category, 'ملزومات اداری');
});

test('مسیر بی‌AI: واژهٔ قبض پس از اسمِ اصلی صفت است، نه دسته', () => {
  for (const text of ['خرید کلید برق', 'مودم اینترنت', 'گوشی تلفن', 'کابل برق', 'اجاق گاز', 'کتاب حقوق تجارت', 'تابلو برق جدید', 'شارژر لپ‌تاپ']) {
    const { category } = classifyCategory(text, 'expense');
    assert.ok(!['قبوض', 'حقوق و دستمزد'].includes(category), `${text} → ${category}`);
  }
  // جملهٔ واقعی کاربر روی مسیر بی‌AI هم «قبوض» ثبت نمی‌شود.
  const items = runVoice('پرداخت ۲ میلیون بابت خرید کلید برق از شرکت آریا از حساب تنخواه شیرازی', { today: NOW }).items || [];
  assert.ok(items.every((item) => item.category !== 'قبوض'), JSON.stringify(items.map((item) => item.category)));
});

test('مسیر بی‌AI، نمونه‌های منفی: قبض و پول برق، شارژ ساختمان و حقوق کارمند دستهٔ خودشان را دارند', () => {
  for (const [text, expected] of [
    ['قبض برق', 'قبوض'], ['پول برق این ماه', 'قبوض'], ['قبض گاز و آب', 'قبوض'], ['قبض تلفن', 'قبوض'],
    ['اینترنت ماهانه', 'قبوض'], ['شارژ ساختمان', 'قبوض'], ['حقوق کارمندا', 'حقوق و دستمزد'], ['هزینه حمل بار', 'حمل‌ونقل'],
    ['قبض برقش', 'قبوض'], ['شارژ ساختمونمون', 'قبوض'],
  ]) {
    assert.equal(classifyCategory(text, 'expense').category, expected, text);
  }
});

test('پنهان‌کاری: «مالیات نبینه»، «جایی ثبت نشه» به حسابدار؛ «ثبت نکن»ِ تکراری پنهان‌کاری نیست', async () => {
  const { judgmentReason } = await import('../shared/moneyPurpose.js');
  for (const text of [
    'مدیرعامل رفته از بازار آزاد با سود پنج درصد ماهانه دویست میلیون قرض گرفته، میگه فعلا ثبت نکن مالیات نبینه!',
    '۵۰ میلیون از مشتری نقد گرفتیم ولی جایی ثبت نشه',
    'این ۲۰ میلیون رو یه جوری بزن که ممیز نبینه',
    'پول رو گرفتیم، کسی نبینه',
    'فاکتور رو جدا نگه دار که اداره دارایی نبینه',
  ]) {
    assert.match(judgmentReason(text) || '', /پنهان‌کاری/, text);
  }
  for (const text of ['این قبض تکراریه، دوباره ثبت نکن', 'تا فاکتورش نیومده ثبتش نکن', 'خرید ۵ میلیون کاغذ نقد دادیم']) {
    assert.doesNotMatch(judgmentReason(text) || '', /پنهان‌کاری/, text);
  }
});

test('دریافتی بابت خدمت یا اجاره: دستهٔ هزینه‌ایِ مدل به دوقلوی درآمدی‌اش می‌رود', async () => {
  for (const [text, what, said, expected] of [
    ['تعمیر گوشی تلفن مشتری ۸۰۰ هزار تومن نقد گرفتیم', 'تعمیر گوشی تلفن مشتری', 'تعمیر و نگهداری', 'خدمات'],
    ['کلاس آموزش اکسل برگزار کردیم ۸۰۰ هزار تومن ثبت‌نام نقد گرفتیم', 'کلاس آموزش اکسل', 'آموزش', 'خدمات'],
    ['اجاره انبار رو ۸۰۰ هزار تومن از مستاجر نقد گرفتیم', 'اجاره انبار', 'اجاره', 'درآمد اجاره'],
  ]) {
    await inFreshWorkspace(async () => {
      const item = await understood(text, model({
        event: { kind: 'income', description: '', status: 'done' },
        amounts: [amt('a1', 800_000, 'received-now', '۸۰۰ هزار تومن')],
        movements: [mv('m1', 'a1', 'in', NOBODY, CASH, 'نقد گرفتیم')],
        subject: subject(what, 'service', said),
      }));
      assert.deepEqual(categories(item), [expected], text);
    });
  }
  // نمونهٔ منفی: کالایی که فروختیم، دوقلوی خدماتی نمی‌گیرد.
  await inFreshWorkspace(async () => {
    const item = await understood('یه کلید برق اضافه داشتیم ۸۰۰ هزار تومن نقد فروختیم', model({
      event: { kind: 'sale', description: '', status: 'done' },
      amounts: [amt('a1', 800_000, 'received-now', '۸۰۰ هزار تومن')],
      movements: [mv('m1', 'a1', 'in', NOBODY, CASH, 'نقد فروختیم')],
      subject: subject('کلید برق', 'goods', 'ملزومات اداری'),
    }));
    assert.notEqual(categories(item)[0], 'خدمات');
  });
});

test('ابزارِ کار «برای تولید» دارایی است، نه موجودی کالا؛ مادهٔ تولید همچنان موجودی است', async () => {
  await inFreshWorkspace(async () => {
    const item = await paid('دستگاه دوخت صنعتی برای خیاطی ۴۰ میلیون خریدیم', 40_000_000, '۴۰ میلیون', subject('دستگاه دوخت صنعتی', 'asset', null, { use: 'production' }));
    assert.equal(treatments(item)[0], 'fixed-asset');
  });
  await inFreshWorkspace(async () => {
    const item = await paid('اتو برقی برای خیاطی ۲ میلیون خریدیم', 2_000_000, '۲ میلیون', subject('اتو برقی', 'asset', null, { use: 'production' }));
    assert.notEqual(treatments(item)[0], 'inventory-purchase');
  });
  await inFreshWorkspace(async () => {
    const item = await paid('پارچه برای دوخت مانتو ۲۰ میلیون خریدیم', 20_000_000, '۲۰ میلیون', subject('پارچه', 'goods', 'مواد و کالا', { use: 'production' }));
    assert.equal(treatments(item)[0], 'inventory-purchase');
  });
});

test('فهرست واژه: شارژ موبایل، خدمت حرفه‌ای، پست و عوارض آزادراه دستهٔ خودشان را دارند', () => {
  for (const [text, expected] of [
    ['کارت شارژ موبایل برای پیک', 'قبوض'], ['شارژ سیم‌کارت شرکت', 'قبوض'], ['بسته اینترنت گوشی شرکت', 'قبوض'],
    ['هزینه کارشناسی رسمی برای دادگاه', 'پیمانکار و خدمات بیرونی'], ['حق‌الزحمهٔ حسابرس', 'پیمانکار و خدمات بیرونی'],
    ['نظافت دفتر توسط شرکت خدماتی', 'پیمانکار و خدمات بیرونی'],
    ['پست سفارشی نامه‌ها', 'حمل‌ونقل'], ['تیپاکس مدارک', 'حمل‌ونقل'], ['ترخیص بار از گمرک', 'حمل‌ونقل'],
    ['عوارض آزادراه', 'سوخت و ایاب‌وذهاب'], ['عوارض آزادراهی تهران قم', 'سوخت و ایاب‌وذهاب'],
    ['شیرینی و میوه برای جلسه', 'خوراک'], ['چای و شیرینی مهمونا', 'خوراک'],
    // منفی: جریمهٔ مالیاتی و عوارض شهرداری دستهٔ خودشان را نگه می‌دارند.
    ['جریمه مالیاتی حسابرسی', 'جرایم مالیاتی'], ['عوارض شهرداری', 'مالیات و عوارض'],
  ]) {
    assert.equal(classifyCategory(text, 'expense').category, expected, text);
  }
});

test('مسیر بی‌AI: دستگاه تلفن قبض نیست؛ قبض و پولِ همان دستگاه هنوز قبض است', () => {
  for (const text of ['یه تلفن رومیزی برای پذیرش ۱ میلیون و ۲۰۰ خریدیم', 'تلفن همراه منشی', 'تلفن‌های داخلی دفتر رو سیم‌کشی کردیم', 'تلفن های داخلی']) {
    assert.notEqual(classifyCategory(text, 'expense').category, 'قبوض', text);
  }
  for (const text of ['قبض تلفن همراه', 'پول تلفن همراه', 'شارژ تلفن همراه', 'پول تلفن این ماه', 'تلفن ها رو قطع کردن قبضش رو بده']) {
    assert.equal(classifyCategory(text, 'expense').category, 'قبوض', text);
  }
});
