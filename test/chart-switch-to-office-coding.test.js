import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('chart-switch');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'chart-owner';
process.env.ADMIN_PASSWORD = 'Chart-Long-Passphrase-2288';

const database = await import(`../server/db.js?chart=${process.pid}`);
database.ensureAdmin();
const inPrimary = (callback) => database.runInWorkspace('primary', { role: 'owner', userId: 'test-owner' }, callback);

/** کدینگ واقعی یک دفتر پارسیانی: کلِ ریشه با کد خودش، معین با کد کوتاه. */
const OFFICE_CSV = [
  'کد,نام,سطح,کد والد,نوع,کد سطح,نقش',
  '10,صندوق,کل,,دارایی,10,',
  '1001,صندوق,معین,10,دارایی,1,cash',
  '12,بدهکاران (حسابهای دریافتنی),کل,,دارایی,12,',
  '1202,مشتریان,معین,12,دارایی,2,receivable',
  '23,بستانکاران (حسابهای پرداختنی),کل,,بدهی,23,',
  '2301,تامین کنندگان,معین,23,بدهی,1,payable',
  '40,درآمدها,کل,,درآمد,40,',
  '4001,فروش,معین,40,درآمد,1,sales',
  '50,هزینه ها,کل,,هزینه,50,',
  '5001,هزینه های عمومی,معین,50,هزینه,1,operating-expense',
  // کد ۵۱ در کدینگ پیشنهادی حساب‌یار «سرمایه» است و اینجا هزینه — همان تداخلی
  // که کاربر واقعی به آن خورد.
  '51,قیمت تمام شده کالای فروش رفته,کل,,هزینه,51,',
  '5101,بهای تمام شده,معین,51,هزینه,1,cogs',
].join('\n');

const importOffice = (options) => database.importChart(OFFICE_CSV, options);

test('کدینگ پیشنهادی نصب و نگاشت می‌شود', () => inPrimary(() => {
  database.insertTransactions({ transcript: 'فروش', transactions: [
    { amount: 2_000_000, type: 'income', category: 'فروش', rawText: 'دو میلیون فروش' },
  ] });
  database.installChartTemplate();
  database.applyChartSuggestions();
  assert.ok(database.chartOverview().mapping.mappedCount > 0);
}));

/**
 * دفتری که کدینگ پیشنهادی را نصب کرده نمی‌تواند کدینگ خودش را جایش بگذارد،
 * چون کدها با سطح یا نوع دیگری از قبل هستند و جایگزینی هم تا وقتی نگاشتی
 * باقی است مجاز نیست. پیام خطا باید راه خروج را بگوید.
 */
test('ورود کدینگ دفتر روی کدینگ پیشنهادی، با پیام راهنما رد می‌شود', () => inPrimary(() => {
  assert.throws(() => importOffice(), (error) => {
    assert.equal(error.code, 'CHART_CONFLICT');
    assert.match(error.message, /برداشتن همهٔ نگاشت‌ها/);
    return true;
  });
}));

test('جایگزینی تا وقتی نگاشتی مانده مجاز نیست', () => inPrimary(() => {
  assert.throws(() => importOffice({ replace: true }), (error) => error.code === 'CHART_IN_USE');
}));

// مسیر کامل: برداشتن نگاشت‌ها، جایگزینی کدینگ، و رسیدن به کدهای واقعی پارسیان.
test('پس از برداشتن نگاشت‌ها، کدینگ دفتر جایگزین می‌شود و کدها درست‌اند', () => inPrimary(() => {
  const cleared = database.clearChartMappings();
  assert.ok(cleared.cleared > 0);
  assert.equal(database.chartOverview().mapping.mappedCount, 0);

  importOffice({ replace: true });
  const db = database.activeWorkspaceDatabase();
  const codes = new Map(db.prepare('SELECT code,level_code AS levelCode FROM chart_accounts').all().map((row) => [row.code, row.levelCode]));
  assert.equal(codes.get('12'), '12', 'کل باید همان کد پارسیان را بدهد، نه کد تفاضلی');
  assert.equal(codes.get('1202'), '2');
  assert.equal(codes.get('23'), '23');
  assert.equal(codes.get('5101'), '1');
  // کدینگ پیشنهادی باید کاملاً رفته باشد، وگرنه خروجی دو دنیای کد قاطی می‌کند.
  assert.equal(codes.has('1101'), false);

  // و نگاشت دوباره بسته می‌شود، این بار روی کدینگ دفتر.
  database.applyChartSuggestions();
  assert.ok(database.chartOverview().mapping.mappedCount > 0);
}));

test.after(() => removeTempDatabase(databasePath));
