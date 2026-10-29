// بکاپ پارسیان با کدینگ سه‌رقمی (کل ۱۰۱ تا ۹۰۲، گروه ۱۰۰ تا ۹۰۰).
//
// گزارش کاربر (۸ آبان ۱۴۰۵): بکاپ تازه وارد نشد و بخش یادگیری پیشنهادی نداد. سه علت:
//  ۱) نوع هیچ‌کدام از ۲۲ کل پیشنهاد نداشت (حساب‌یار فقط گروه دورقمی را می‌شناخت) و
//     «پذیرش پیشنهادها» کاری نمی‌کرد.
//  ۲) فاز ب صندوق و بانک را فقط زیر کل ۱۰ و ۱۱ می‌جست؛ زیر کل ۱۰۱ «نقد و بانک» هیچ
//     حساب پولی ساخته نشد و هیچ پرداختی پرداخت شناخته نمی‌شد.
//  ۳) سندهای هزینهٔ این شرکت چندسطری‌اند؛ یادگیری فقط سند «یک هزینه در برابر یک پول» را می‌دید.
// خانواده: پیشنهاد از کد سه‌رقمی و از نام، کد و نامِ ناسازگار (بی‌پیشنهاد)، کل پولی از نام و از
// تنظیمات پارسیان، کل «تسهیلات بانکی» که پولی نیست، سند چندهزینه‌ای از یک بانک، و سندی که
// شخص هم منبع پولش است (خوانده نمی‌شود). داده ساختگی است.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParsianBackup } from './helpers/parsianBakFixture.js';
import { kolTypeSuggestion } from '../server/parsianImport.js';

test('پیشنهاد نوع کل از کد سه‌رقمی و نام؛ ناسازگاری یعنی بی‌پیشنهاد', () => {
  const cases = [
    [101, 'نقد و بانک', 'asset'], [105, 'سفارشات و پيش پرداخت ها', 'asset'], [202, 'دارايي ثابت نامشهود', 'asset'],
    [301, 'حساب ها و اسناد پرداختني', 'liability'], [303, 'سفارشات و پيش دريافت ها', 'liability'],
    [401, 'حساب ها و اسناد پرداختني بلند مدت', 'liability'], [501, 'حقوق صاحبان سرمايه', 'equity'],
    [601, 'درآمد و فروش', 'income'], [602, 'ساير درآمد هاي مالي', 'income'], [701, 'بهاي تمام شده', 'expense'],
    [805, 'هزينه هاي غير عملياتي', 'expense'], [901, 'حساب هاي انتظامي و کنترلي', 'memorandum'],
    // دورقمیِ قبلی دست نمی‌خورد.
    [10, 'موجودي نقد و بانک', 'asset'], [22, 'حسابهاي پرداختي', 'liability'], [67, 'قيمت تمام شده کالاي فروش رفته', 'expense'],
    // کد بی‌قاعده: فقط نام.
    [0, 'تسهيلات مالي بلند مدت', 'liability'], [0, 'سرمايه گذاري ها', 'asset'], [0, 'سایر هزینه‌ها و درآمدها', null],
    // کد و نام با هم نمی‌خوانند: حدس زده نمی‌شود.
    [601, 'هزينه هاي عملياتي', null],
  ];
  for (const [code, name, type] of cases) assert.equal(kolTypeSuggestion(code, name), type, `${code} ${name}`);
});

const GROUPS = [{ Code: 11, CName: 'دارايي هاي جاري' }, { Code: 21, CName: 'بدهي هاي جاري' }];
function threeDigitTables() {
  // گروه کل‌ها در جدول گروه نیست (۱۰۰، ۳۰۰ …)، درست مثل بکاپ واقعی.
  const kol = [
    { Code: 101, CName: 'نقد و بانک', GroupCode: 100, iType: 0 },
    { Code: 102, CName: 'حساب ها و اسناد دريافتني تجاري', GroupCode: 100, iType: 0 },
    { Code: 301, CName: 'حساب ها و اسناد پرداختني', GroupCode: 300, iType: 0 },
    { Code: 401, CName: 'تسهيلات بانکي بلند مدت', GroupCode: null, iType: 0 },
    { Code: 501, CName: 'حقوق صاحبان سرمايه', GroupCode: 500, iType: 0 },
    { Code: 601, CName: 'درآمد و فروش', GroupCode: 600, iType: 1 },
    { Code: 802, CName: 'هزينه هاي عمومي اداري فروش', GroupCode: 800, iType: 1 },
  ];
  const moeen = [
    { KolCode: 101, Code: 1, CName: 'بانک ها' }, { KolCode: 101, Code: 2, CName: 'تنخواه گردان' }, { KolCode: 101, Code: 3, CName: 'صندوق' },
    { KolCode: 102, Code: 1, CName: 'مشتريان' }, { KolCode: 301, Code: 1, CName: 'تامين کنندگان' },
    { KolCode: 401, Code: 1, CName: 'وام بانک نمونه' }, { KolCode: 501, Code: 1, CName: 'سرمايه' },
    { KolCode: 601, Code: 1, CName: 'فروش' },
    { KolCode: 802, Code: 1, CName: 'هزينه اجاره' }, { KolCode: 802, Code: 2, CName: 'هزينه آب و برق' }, { KolCode: 802, Code: 3, CName: 'هزينه پذيرايي' },
  ];
  const tafsili = [
    { KolCode: 101, MoeenCode: 1, Code: 1, CName: 'بانک نمونه جاري' }, { KolCode: 101, MoeenCode: 1, Code: 2, CName: 'بانک نمونه دوم' },
    { KolCode: 102, MoeenCode: 1, Code: 1, CName: 'مشتری نمونه' }, { KolCode: 301, MoeenCode: 1, Code: 1, CName: 'شرکت نمونه آلفا' },
  ];
  let id = 1;
  let sanad = 0;
  const document = [];
  const voucher = (date, rows) => {
    sanad += 1;
    for (const [kolCode, moeenCode, taf, bed, bes, comment] of rows) document.push({ ID: id++, Sanad_Num: sanad, SanadDate: date, KolCode: kolCode, MoeenCode: moeenCode, TafsiliCode: taf, Comment: comment, Bed: bed, Bes: bes, SanadComment: null });
  };
  voucher('1405/01/02', [[101, 1, 1, 9_000_000_000, 0, 'آورده'], [501, 1, 0, 0, 9_000_000_000, 'آورده']]);
  for (let month = 1; month <= 5; month += 1) {
    const day = (value) => `1405/${String(month).padStart(2, '0')}/${String(value).padStart(2, '0')}`;
    // سند چندسطری: اجاره، قبض و علی‌الحساب شخص، همه از یک بانک.
    voucher(day(3), [
      [802, 1, 0, 40_000_000, 0, 'اجاره دفتر'], [802, 2, 0, 1_000_000 + month * 150_000, 0, 'قبض برق'],
      [102, 1, 1, 5_000_000, 0, 'علی‌الحساب'], [101, 1, 1, 0, 46_000_000 + month * 150_000, 'پرداخت'],
    ]);
    // هزینه‌ای که نیمی از بانک و نیمی از طلب شخص پوشانده شد: منبع روشن نیست، خوانده نمی‌شود.
    voucher(day(10), [[802, 3, 0, 2_000_000, 0, 'پذیرایی'], [101, 1, 2, 0, 1_000_000, 'پرداخت'], [102, 1, 1, 0, 1_000_000, 'کسر از طلب']]);
  }
  return {
    tbl_ACCGroup: GROUPS, tbl_Kol: kol, tbl_Moeen: moeen, tbl_Tafsili: tafsili, tbl_Document: document,
    tbl_AccSetting: [{ ID: 2, Cash_K: 101, Cash_M: 3, Cash_T: 0, Sell_K: 0, Sell_M: 0, Sell_T: 0, Wage_K: 0, Wage_M: 0, Wage_T: 0, Asset_K: 0, Asset_M: 0, Asset_T: 0 }],
    tbl_VATSetting: [{ ID: 6, VATSale_K: 0, VATSale_M: 0, VATSale_T: 0, VATBuy_K: 0, VATBuy_M: 0, VATBuy_T: 0 }],
  };
}

const tempPathModule = await import('./helpers/tempPath.js');
const databasePath = tempPathModule.tempDatabase('parsian-three-digit');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'three-owner';
process.env.ADMIN_PASSWORD = 'x-strong-password-1234';
const database = await import(`../server/db.js?three-digit=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('three-owner', 'x-strong-password-1234');
const inWorkspace = (name, callback) => database.runInWorkspace(database.createWorkspace(owner.id, { name, profileType: 'business' }).id, { role: 'owner', userId: owner.id }, callback);
test.after(() => tempPathModule.removeTempDatabase(databasePath));
const imp = await import(`../server/parsianImport.js?three-digit=${process.pid}`);
const { completeParsianImport } = await import(`../server/parsianPhaseB.js?three-digit=${process.pid}`);
const history = await import(`../server/historyLearning.js?three-digit=${process.pid}`);

test('کدینگ سه‌رقمی: همهٔ کل‌ها پیشنهاد دارند، با پذیرش پیشنهادها وارد می‌شود، صندوق و بانک‌ها ساخته می‌شوند', () => {
  inWorkspace('سه‌رقمی', () => {
    const active = database.activeWorkspaceDatabase();
    const backup = buildParsianBackup(threeDigitTables());
    const preview = imp.previewParsianBackup(active, backup, 'three.bak', { amountUnit: 'toman' });
    assert.equal(preview.kolTypeChoices.length, 7);
    assert.deepEqual(preview.kolTypeChoices.filter((choice) => !choice.suggestion).map((choice) => choice.code), []);
    // همان کار دکمهٔ «پذیرش پیشنهادها».
    const kolTypes = Object.fromEntries(preview.kolTypeChoices.map((choice) => [choice.code, choice.suggestion]));
    assert.deepEqual(kolTypes, { 101: 'asset', 102: 'asset', 301: 'liability', 401: 'liability', 501: 'equity', 601: 'income', 802: 'expense' });
    const result = imp.commitParsianBackup(active, backup, 'three.bak', { createdBy: owner.id, amountUnit: 'toman', kolTypes });
    assert.equal(result.journals.entries, 11);

    completeParsianImport(active, { createdBy: owner.id });
    const accounts = database.listAccounts().map((account) => [account.name, account.kind]).sort();
    // دو بانکِ تفصیلی، تنخواه بی‌مانده ساخته نمی‌شود، صندوق پیش‌فرض بازاستفاده می‌شود؛ «وام بانک» حساب پولی نیست.
    assert.ok(accounts.some(([name, kind]) => name === 'بانک نمونه جاري' && kind === 'bank'), JSON.stringify(accounts));
    assert.ok(accounts.some(([name, kind]) => name === 'بانک نمونه دوم' && kind === 'bank'), JSON.stringify(accounts));
    assert.equal(accounts.some(([name]) => name.includes('وام')), false);

    active.prepare("UPDATE journal_entries SET approval_state='approved'").run();
    const analysis = history.analyzeLedgerHistory(active);
    const byAccount = Object.fromEntries(analysis.recurring.map((item) => [item.accountName, item]));
    // اجاره و قبضِ داخل سند چندسطری، از همان بانک.
    assert.equal(byAccount['هزينه اجاره']?.amountMode, 'fixed');
    assert.equal(byAccount['هزينه اجاره'].moneyAccountName, 'بانک نمونه جاري');
    assert.equal(byAccount['هزينه اجاره'].amount, 40_000_000);
    assert.equal(byAccount['هزينه آب و برق']?.amountMode, 'variable');
    // پذیرایی‌ای که شخص هم پوشانده، منبع روشنی ندارد.
    assert.equal(byAccount['هزينه پذيرايي'], undefined);
  });
});

test('واژه: حرف اضافهٔ چسبیده جدا می‌شود و واژهٔ عمومی یاد گرفته نمی‌شود', () => {
  assert.deepEqual(history.descriptionWords('پرداخت قبض توسط آقای نمونه شناسه ۱۲۳'), ['قبض', 'نمونه']);
  inWorkspace('واژهٔ چسبیده', () => {
    const active = database.activeWorkspaceDatabase();
    const tables = threeDigitTables();
    // «خوارباربابت» و «ازملت» به شکل چسبیده در شرح، و یک بار هم جدا.
    tables.tbl_Document.forEach((row) => { if (row.Comment === 'پذیرایی') row.Comment = 'خوارباربابت دفتر ازملت'; });
    tables.tbl_Document.push(
      { ID: 9001, Sanad_Num: 99, SanadDate: '1405/05/20', KolCode: 802, MoeenCode: 3, TafsiliCode: 0, Comment: 'خواربار', Bed: 100, Bes: 0, SanadComment: null },
      { ID: 9002, Sanad_Num: 99, SanadDate: '1405/05/20', KolCode: 101, MoeenCode: 3, TafsiliCode: 0, Comment: 'ملت', Bed: 0, Bes: 100, SanadComment: null },
    );
    const backup = buildParsianBackup(tables);
    const preview = imp.previewParsianBackup(active, backup, 'glued.bak', { amountUnit: 'toman' });
    const kolTypes = Object.fromEntries(preview.kolTypeChoices.map((choice) => [choice.code, choice.suggestion]));
    imp.commitParsianBackup(active, backup, 'glued.bak', { createdBy: owner.id, amountUnit: 'toman', kolTypes });
    active.prepare("UPDATE journal_entries SET approval_state='approved'").run();
    const keywords = history.analyzeLedgerHistory(active).keywords.map((item) => item.keyword);
    assert.ok(keywords.includes('خواربار'), JSON.stringify(keywords));
    for (const junk of ['خوارباربابت', 'ازملت', 'توسط', 'شناسه']) assert.equal(keywords.includes(junk), false, junk);
  });
});
