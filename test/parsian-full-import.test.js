// خانوادهٔ «بکاپ پارسیان کل حساب‌یار را پر می‌کند».
//
// گزارش کاربر: «وقتی بکاپ می‌زنیم صرفاً اسناد میاد». اسناد وارد می‌شدند ولی:
//  - موجودی بانک و صندوق صفر می‌ماند، چون ماندهٔ حساب فقط ردیف تراکنش و انتقال را
//    می‌شمرد و سند واردشده (و هر سند دستی و افتتاحیهٔ اکسل) را نه؛
//  - طلب و بدهی خلاصهٔ مالی صفر بود، چون فقط تعهد و فاکتور باز را می‌شمرد؛
//  - بانک‌ها و اشخاص فقط با دکمهٔ جدای «قدم بعد» ساخته می‌شدند؛
//  - کالا، کارت طرف حساب (تلفن، کد اقتصادی)، فاکتورها و مشخصات شرکت اصلاً خوانده نمی‌شد؛
//  - DNA فقط ثبت‌های روزانهٔ شش ماه اخیر را می‌خواند و برای سابقهٔ واردشده خالی بود.
//
// هر عضو یک آزمون دارد، به‌علاوهٔ نمونهٔ منفی: دفتر تومانی با فایل ریالی هیچ مبلغی را
// گرد نمی‌کند، راز بکاپ (کلید سامانهٔ مؤدیان) هرگز خوانده نمی‌شود، زمان ثبت ساختگی
// برای انضباط ثبت ساخته نمی‌شود و سند دستیِ تازه هم از نگهبان موجودی رد نمی‌شود.
// همهٔ نام‌ها ساختگی‌اند؛ دادهٔ مشتری وارد مخزن نمی‌شود.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildParsianBackup } from './helpers/parsianBakFixture.js';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { parseParsianBackup } from '../server/parsianBackup.js';
import { financialDna } from '../server/financialDna.js';
import { operationalLedgerAccount } from '../server/accounting/ledgerAccounts.js';

const SECRET = 'MIIEvQ-test-private-key-never-read';
const GROUPS = [
  { Code: 11, CName: 'دارايي هاي جاري' }, { Code: 21, CName: 'بدهي هاي جاري' }, { Code: 31, CName: 'حقوق صاحبان سهام' },
  { Code: 41, CName: 'فروش و درآمدها' }, { Code: 61, CName: 'هزينه هاي فعاليت' },
];
const CUSTOMERS = [[1, 'شرکت نمونه آلفا'], [2, 'شرکت نمونه بتا'], [3, 'فروشگاه نمونه گاما']];
const SUPPLIERS = [[1, 'تأمین نمونه دلتا'], [2, 'بازرگانی نمونه اپسیلون']];

/** یک سال کار یک تولیدی کوچک: فروش نسیه با ارزش افزوده، خرید نسیه، اجاره، وصول و پرداخت. */
function companyTables() {
  const kol = [
    { Code: 10, CName: 'صندوق', GroupCode: 11, iType: 0 }, { Code: 11, CName: 'بانک ها', GroupCode: 11, iType: 0 },
    { Code: 12, CName: 'حسابهاي دريافتني', GroupCode: 11, iType: 0 }, { Code: 23, CName: 'حسابهاي پرداختني', GroupCode: 21, iType: 0 },
    { Code: 31, CName: 'سرمايه', GroupCode: 31, iType: 0 }, { Code: 60, CName: 'فروش', GroupCode: 41, iType: 1 },
    { Code: 50, CName: 'هزينه ها', GroupCode: 61, iType: 1 }, { Code: 62, CName: 'خريد', GroupCode: 61, iType: 1 },
  ];
  const moeen = [
    { KolCode: 10, Code: 1, CName: 'صندوق' }, { KolCode: 11, Code: 1, CName: 'بانک نمونه' },
    { KolCode: 12, Code: 1, CName: 'مشتريان' }, { KolCode: 12, Code: 3, CName: 'ارزش افزوده خريد' },
    { KolCode: 23, Code: 1, CName: 'تامين کنندگان' }, { KolCode: 23, Code: 4, CName: 'ارزش افزوده فروش' },
    { KolCode: 31, Code: 1, CName: 'سرمايه' }, { KolCode: 60, Code: 1, CName: 'فروش کالا' },
    { KolCode: 50, Code: 1, CName: 'اجاره' }, { KolCode: 62, Code: 1, CName: 'خريد مواد' },
  ];
  const tafsili = [
    ...CUSTOMERS.map(([code, name]) => ({ KolCode: 12, MoeenCode: 1, Code: code, CName: name })),
    { KolCode: 12, MoeenCode: 3, Code: 1, CName: 'ارزش افزوده خريد' },
    ...SUPPLIERS.map(([code, name]) => ({ KolCode: 23, MoeenCode: 1, Code: code, CName: name })),
    { KolCode: 23, MoeenCode: 4, Code: 1, CName: 'ارزش افزوده فروش' },
  ];
  let id = 1;
  let sanad = 1;
  let factorId = 1;
  const document = [];
  const factor = [];
  const row = (number, date, kolCode, moeenCode, taf, bed, bes, comment, factorNum = 0) => document.push({
    ID: id++, Sanad_Num: number, SanadDate: date, KolCode: kolCode, MoeenCode: moeenCode, TafsiliCode: taf,
    Comment: comment, Bed: bed, Bes: bes, SanadComment: null, Factor_Num: factorNum,
  });
  // افتتاحیه: سرمایه در بانک.
  row(sanad, '1403/01/01', 11, 1, 0, 9_000_000_000, 0, 'افتتاحيه');
  row(sanad, '1403/01/01', 31, 1, 0, 0, 9_000_000_000, 'افتتاحيه');
  sanad += 1;
  let saleNumber = 0;
  let buyNumber = 0;
  for (let month = 1; month <= 12; month += 1) {
    const day = (value) => `1403/${String(month).padStart(2, '0')}/${String(value).padStart(2, '0')}`;
    // دو فروش در ماه؛ مشتری آلفا بیشترِ فروش را دارد.
    for (const [dayOfMonth, customer, quantity] of [[5, CUSTOMERS[0], 40], [18, CUSTOMERS[1 + (month % 2)], 10]]) {
      saleNumber += 1;
      const net = quantity * 1_500_000;
      row(sanad, day(dayOfMonth), 12, 1, customer[0], (net * 11) / 10, 0, `فاکتور فروش ${saleNumber}`, saleNumber);
      row(sanad, day(dayOfMonth), 60, 1, 0, 0, net, `فاکتور فروش ${saleNumber}`, saleNumber);
      row(sanad, day(dayOfMonth), 23, 4, 1, 0, net / 10, 'ارزش افزوده فروش', saleNumber);
      factor.push({ ID: factorId++, Factor_Num: saleNumber, Factor_Date: day(dayOfMonth), TitleCode: 1, Sanad_Num: sanad, GoodsCode: 1001, Tedad: quantity * 0.75, Price: 1_500_000 });
      factor.push({ ID: factorId++, Factor_Num: saleNumber, Factor_Date: day(dayOfMonth), TitleCode: 1, Sanad_Num: sanad, GoodsCode: 1002, Tedad: quantity * 0.25, Price: 1_500_000 });
      sanad += 1;
    }
    // خرید ماهانه از تأمین‌کننده.
    buyNumber += 1;
    const supplier = SUPPLIERS[month % 2];
    row(sanad, day(9), 62, 1, 0, 30_000_000, 0, `فاکتور خريد ${buyNumber}`, buyNumber);
    row(sanad, day(9), 12, 3, 1, 3_000_000, 0, 'ارزش افزوده خريد', buyNumber);
    row(sanad, day(9), 23, 1, supplier[0], 0, 33_000_000, `فاکتور خريد ${buyNumber}`, buyNumber);
    factor.push({ ID: factorId++, Factor_Num: buyNumber, Factor_Date: day(9), TitleCode: 2, Sanad_Num: sanad, GoodsCode: 2001, Tedad: 300, Price: 100_000 });
    sanad += 1;
    // اجاره از بانک.
    row(sanad, day(2), 50, 1, 0, 40_000_000, 0, 'اجاره');
    row(sanad, day(2), 11, 1, 0, 0, 40_000_000, 'اجاره');
    sanad += 1;
    // وصول بخشی از طلب آلفا.
    row(sanad, day(25), 11, 1, 0, 50_000_000, 0, 'وصول');
    row(sanad, day(25), 12, 1, 1, 0, 50_000_000, 'وصول');
    sanad += 1;
  }
  return {
    tbl_ACCGroup: GROUPS, tbl_Kol: kol, tbl_Moeen: moeen, tbl_Tafsili: tafsili, tbl_Document: document,
    tbl_AccSetting: [{ ID: 2, Cash_K: 10, Cash_M: 1, Cash_T: 0, Sell_K: 60, Sell_M: 1, Sell_T: 0, Wage_K: 0, Wage_M: 0, Wage_T: 0, Asset_K: 0, Asset_M: 0, Asset_T: 0 }],
    tbl_VATSetting: [{ ID: 6, VATSale_K: 23, VATSale_M: 4, VATSale_T: 1, VATBuy_K: 12, VATBuy_M: 3, VATBuy_T: 1 }],
    tbl_GoodsGroup: [{ Code: 100, CName: 'محصول', IsService: false }, { Code: 200, CName: 'خدمات', IsService: true }],
    tbl_Goods: [
      { Code: 1001, GroupCode: 100, CName: 'محصول نمونه یک', UnitName_1: 'عدد', Equal: 12, Price_1: 1_500_000, VATPercent: 10, HaveChild: false, IsActive: true },
      { Code: 1002, GroupCode: 100, CName: 'محصول نمونه دو', UnitName_1: 'کيلوگرم', Equal: 1, Price_1: 1_500_005, VATPercent: 10, HaveChild: true, IsActive: false },
      { Code: 2001, GroupCode: 200, CName: 'خدمت نمونه', UnitName_1: '', Equal: 0, Price_1: 0, VATPercent: 0, HaveChild: false, IsActive: true },
    ],
    tbl_Telephone: [
      { ID: 1, KolCode: 12, MoeenCode: 1, TafsiliCode: 1, CName: 'شرکت نمونه آلفا', Tel: '021-00000001', Mobile: '09000000001', Address: 'خیابان نمونه یک', CodeEco: '100000000001', CodeNat: '10000000001', CodePost: '1000000001' },
      { ID: 2, KolCode: 23, MoeenCode: 1, TafsiliCode: 2, CName: 'بازرگانی نمونه اپسیلون', Tel: '', Mobile: '09000000002', Address: '', CodeEco: '0', CodeNat: '0', CodePost: '0' },
      // کارت دفترچه تلفن بی‌تفصیلی: شخصی ساخته نمی‌شود.
      { ID: 3, KolCode: null, MoeenCode: null, TafsiliCode: null, CName: 'شرکت حذف‌شده (حذف شده)', Tel: '', Mobile: '09000000003', Address: '', CodeEco: '', CodeNat: '', CodePost: '' },
    ],
    tbl_FactorKind: [{ Code: 1, CName: 'فاکتور فروش', HaveDocument: true }, { Code: 2, CName: 'فاکتور خريد', HaveDocument: true }],
    tbl_Factor: factor,
    tbl_CoSpec: [{ ID: 1, ECOcode: '999999999999', PostalCode: '9999999999', Code: '99999999999', Address: 'شهرک صنعتی نمونه', Tel: '000-0000000', Estate: 'استان نمونه', City: 'شهر نمونه' }],
    tbl_NEWMovadianInfo: [{ ID: 1, PrivateKey: SECRET, Token: SECRET }],
  };
}

const databasePath = tempDatabase('parsian-full-import');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'full-import-owner';
process.env.ADMIN_PASSWORD = randomBytes(24).toString('base64url');
const database = await import(`../server/db.js?parsian-full-import=${process.pid}`);
const { commitParsianBackup, previewParsianBackup } = await import('../server/parsianImport.js');
const { completeParsianImport } = await import('../server/parsianPhaseB.js');
const { listParsianInvoiceArchive } = await import('../server/parsianExtras.js');
database.ensureAdmin();
const owner = database.authenticateUser('full-import-owner', process.env.ADMIN_PASSWORD);
const ledger = (name, unit = 'rial') => {
  const workspace = database.createWorkspace(owner.id, { name, profileType: 'business' });
  const run = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
  run(() => { if (unit === 'rial') database.setLedgerAmountUnit('rial'); });
  return run;
};
test.after(() => removeTempDatabase(databasePath));

/** همان مسیر دکمهٔ «ورود»: اسناد و اطلاعات پایه، بعد بانک‌ها و اشخاص. */
function importCompany(run, { fileUnit = 'rial' } = {}) {
  return run(() => {
    const active = database.activeWorkspaceDatabase();
    const buffer = buildParsianBackup(companyTables());
    const result = commitParsianBackup(active, buffer, 'company.bak', { createdBy: owner.id, amountUnit: fileUnit });
    result.phaseB = completeParsianImport(active, { createdBy: owner.id });
    return result;
  });
}
const ledgerNet = (active, moeenCode) => Number(active.prepare(`SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) AS net FROM journal_lines l
  JOIN ledger_accounts a ON a.id=l.account_id JOIN chart_accounts c ON c.id=a.chart_account_id WHERE c.code=?`).get(moeenCode).net);

test('خواننده: کالا، کارت طرف حساب، فاکتورها و مشخصات شرکت، با decimal و bit؛ راز بکاپ خوانده نمی‌شود', () => {
  const parsed = parseParsianBackup(buildParsianBackup(companyTables()), { fileName: 'company.bak' });
  assert.equal(parsed.documents.vouchers.length, 61);
  assert.deepEqual(parsed.extras.goods.map((item) => [item.name, item.unit, item.price, item.vatPercent, item.service]), [
    ['محصول نمونه یک', 'عدد', 1_500_000, 10, false], ['محصول نمونه دو', 'کيلوگرم', 1_500_005, 10, false], ['خدمت نمونه', '', 0, 0, true],
  ]);
  assert.equal(parsed.extras.invoices.filter((item) => item.title === 1).length, 24);
  assert.equal(parsed.extras.invoices.filter((item) => item.title === 2).length, 12);
  // تعداد decimal(18,2) دقیق خوانده می‌شود (۴۰ × ۰٫۷۵ = ۳۰).
  assert.equal(parsed.extras.invoices[0].lines[0].quantity, 30);
  assert.equal(parsed.extras.cards.length, 3);
  assert.equal(parsed.extras.company.economicCode, '999999999999');
  assert.ok(!JSON.stringify(parsed).includes(SECRET), 'کلید سامانهٔ مؤدیان نباید در خروجی خواننده باشد');
  assert.equal(parsed.stats.rows.tbl_NEWMovadianInfo, undefined);
});

test('بکاپ بدون جدول‌های پایه: اسناد مثل قبل وارد می‌شوند و بخش‌های پایه خالی می‌مانند، بی‌خطا', () => {
  const tables = companyTables();
  for (const name of ['tbl_Goods', 'tbl_GoodsGroup', 'tbl_Telephone', 'tbl_Factor', 'tbl_FactorKind', 'tbl_CoSpec', 'tbl_NEWMovadianInfo']) delete tables[name];
  const parsed = parseParsianBackup(buildParsianBackup(tables), { fileName: 'bare.bak' });
  assert.equal(parsed.documents.vouchers.length, 61);
  assert.deepEqual([parsed.extras.goods.length, parsed.extras.cards.length, parsed.extras.invoices.length, parsed.extras.company], [0, 0, 0, null]);
});

test('ورود کامل در دفتر ریالی: همهٔ بخش‌ها از همان بکاپ پر می‌شوند', () => {
  const run = ledger('شرکت نمونه — ریالی');
  const preview = run(() => previewParsianBackup(database.activeWorkspaceDatabase(), buildParsianBackup(companyTables()), 'company.bak', { amountUnit: 'rial' }));
  assert.deepEqual(preview.extras, { goods: 3, cards: 2, unlinkedCards: 1, salesInvoices: 24, purchaseInvoices: 12, otherInvoices: 0, company: true, moadianRecords: 0, guaranteeCheques: 0 });
  const result = importCompany(run);
  assert.equal(result.journals.entries, 61);
  assert.equal(result.extras.products.created, 3);
  assert.deepEqual(result.extras.invoices.byKind, { sales: 24, purchase: 12 });
  assert.equal(result.extras.cards.stored, 2);
  assert.equal(result.extras.company, true);

  run(() => {
    const active = database.activeWorkspaceDatabase();
    // صندوق و بانک: ماندهٔ فهرست حساب‌ها = کارت حساب = دفتر کل.
    const bank = database.listAccounts().find((account) => account.name === 'بانک نمونه');
    assert.equal(bank.balance, 9_000_000_000 - 12 * 40_000_000 + 12 * 50_000_000);
    assert.equal(bank.balance, ledgerNet(active, '110001'));
    assert.equal(database.moneyAccountCard(bank.id).totals.balance, bank.balance);
    // سند تازه‌ای ساخته نشد.
    assert.equal(active.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, 61);

    // اشخاص: مشتری‌ها و تأمین‌کننده‌ها، نه ردیف‌های ارزش افزوده؛ کارت پارسیان روی شخص.
    const contacts = database.listContacts();
    assert.deepEqual(contacts.map((contact) => contact.name).sort(), [...CUSTOMERS, ...SUPPLIERS].map(([, name]) => name).sort());
    const alpha = contacts.find((contact) => contact.name === 'شرکت نمونه آلفا');
    assert.equal(alpha.phone, '09000000001');
    assert.match(alpha.note, /کد اقتصادی 100000000001/);
    assert.match(alpha.note, /نشانی: خیابان نمونه یک/);
    const epsilon = contacts.find((contact) => contact.name === 'بازرگانی نمونه اپسیلون');
    assert.equal(epsilon.phone, '09000000002');
    assert.doesNotMatch(epsilon.note, /کد اقتصادی 0/, '«۰» پارسیان خالی است، نه کد');
    assert.ok(!contacts.some((contact) => contact.name.includes('حذف')), 'کارت بی‌تفصیلی شخص نمی‌سازد');

    // طلب و بدهی خلاصهٔ مالی = ماندهٔ اشخاص در دفتر کل.
    const overview = database.financialOverview();
    const receivable = contacts.reduce((sum, contact) => sum + contact.uncoveredReceivable, 0);
    const payable = contacts.reduce((sum, contact) => sum + contact.uncoveredPayable, 0);
    assert.equal(receivable, ledgerNet(active, '120001'));
    assert.equal(payable, -ledgerNet(active, '230001'));
    assert.equal(overview.receivable, receivable);
    assert.equal(overview.payable, payable);
    assert.equal(overview.cash, bank.balance);

    // کالا: واحد و قیمت؛ خدمت ردیابی موجودی ندارد؛ موجودی تعدادی حدس زده نمی‌شود.
    const products = database.listProducts();
    assert.deepEqual(products.map((product) => [product.name, product.unit, product.salePrice ?? product.sale_price, product.stock]).sort(),
      [['خدمت نمونه', 'عدد', 0, 0], ['محصول نمونه دو', 'کيلوگرم', 1_500_005, 0], ['محصول نمونه یک', 'عدد', 1_500_000, 0]].sort());

    // بایگانی فاکتورها: هر کدام با سند و طرف حساب خودش؛ مبلغ با مالیات از ردیف طرف حساب.
    const archive = listParsianInvoiceArchive(active, { kind: 'sales' });
    assert.equal(archive.items.length, 24);
    assert.ok(archive.items.every((item) => item.entryId && item.contactId && item.amountsExact));
    const first = archive.items.find((item) => item.number === 1);
    assert.equal(first.counterpartyName, 'شرکت نمونه آلفا');
    assert.equal(first.subtotal, 60_000_000);
    assert.equal(first.gross, 66_000_000);
    assert.deepEqual(first.lines.map((line) => [line.title, line.quantity, line.total]), [['محصول نمونه یک', 30, 45_000_000], ['محصول نمونه دو', 10, 15_000_000]]);
    // بایگانی در طلب‌ها شمرده نمی‌شود: فاکتور باز حساب‌یار نیست.
    assert.equal(database.listInvoices().items.length, 0);

    // مشخصات شرکت در تنظیمات.
    assert.equal(JSON.parse(database.getSettings().companyProfile).economicCode, '999999999999');

    // DNA از اسناد واردشده و در بازهٔ خود بکاپ.
    const dna = database.financialDnaOverview({ months: 6, now: new Date('2026-10-26T00:00:00Z') });
    assert.equal(dna.basis.source, 'parsian-import');
    assert.equal(dna.sufficiency.level, 'ok');
    const traits = Object.fromEntries(dna.traits.map((trait) => [trait.id, trait]));
    assert.match(traits['customer-concentration'].value, /شرکت نمونه آلفا/);
    assert.ok(traits['supplier-concentration']);
    assert.match(traits['product-concentration'].value, /محصول نمونه یک/);
    assert.ok(traits['expense-backbone'].evidence.fixed.some((item) => item.category === 'اجاره'));
    // زمان ثبت واقعی در بکاپ نیست: انضباط ثبت و سهم صوتی ادعا نمی‌شوند.
    assert.equal(traits['entry-discipline'], undefined);
    assert.equal(traits['voice-adoption'], undefined);
  });

  // اجرای دوبارهٔ بخش اشخاص چیزی تکرار نمی‌سازد.
  const again = run(() => completeParsianImport(database.activeWorkspaceDatabase(), { createdBy: owner.id }));
  assert.equal(again.contacts.created, 0);
  assert.equal(again.accounts.created, 0);
});

test('فایل ریالی در دفتر تومانی: قیمت و مبلغی که به تومان صحیح درنمی‌آید خالی می‌ماند، هرگز گرد نمی‌شود', () => {
  const run = ledger('شرکت نمونه — تومانی', 'toman');
  const result = importCompany(run);
  assert.equal(result.extras.products.withoutPrice, 1);
  assert.ok(result.extras.warnings.some((item) => item.includes('عدد صحیح درنمی‌آید')));
  run(() => {
    const products = Object.fromEntries(database.listProducts().map((product) => [product.name, product.salePrice ?? product.sale_price]));
    assert.equal(products['محصول نمونه یک'], 150_000);
    assert.equal(products['محصول نمونه دو'], 0, '۱٬۵۰۰٬۰۰۵ ریال به تومان صحیح نیست؛ قیمت خالی می‌ماند');
  });
});

test('ماندهٔ صندوق و بانک: سند دستی هم شمرده می‌شود و فهرست حساب با کارت یکی است؛ ثبت گفتاری دو بار نه', () => {
  const run = ledger('سندهای بی‌تراکنش', 'toman');
  run(() => {
    database.installChartTemplate();
    const active = database.activeWorkspaceDatabase();
    const cash = database.listAccounts().find((account) => account.id === 'cash');
    const cashLedger = { id: operationalLedgerAccount(active, 'cash') };
    const capital = active.prepare("SELECT id FROM ledger_accounts WHERE type='equity' AND active=1 ORDER BY code LIMIT 1").get();
    assert.ok(cashLedger?.id && capital?.id);
    const before = cash.balance;
    database.createJournalDocuments([{ occurredAt: '2026-10-01T08:00:00.000Z', memo: 'آورده دستی', lines: [
      { accountId: cashLedger.id, debit: 5_000_000, credit: 0 }, { accountId: capital.id, debit: 0, credit: 5_000_000 },
    ] }]);
    const after = database.listAccounts().find((account) => account.id === 'cash');
    assert.equal(after.balance, before + 5_000_000);
    assert.equal(database.moneyAccountCard('cash').totals.balance, after.balance);
    // ثبت گفتاری هم ردیف تراکنش دارد و هم سند؛ فقط یک بار شمرده می‌شود.
    database.insertTransactions({ transcript: 'یک میلیون فروش', transactions: [
      { amount: 1_000_000, type: 'income', category: 'فروش', rawText: 'یک میلیون فروش', occurredAt: '2026-10-03T10:00:00.000Z' },
    ] });
    const withVoice = database.listAccounts().find((account) => account.id === 'cash');
    assert.equal(withVoice.balance, after.balance + 1_000_000);
    assert.equal(database.moneyAccountCard('cash').totals.balance, withVoice.balance);
  });
});

test('نگهبان موجودی: سند دستی که صندوق را منفی می‌کند رد می‌شود؛ سابقهٔ واردشده با دلیل ثبت می‌شود', async () => {
  const { acknowledgeImportedHistory } = await import('../server/balanceGuard.js');
  const run = ledger('نگهبان و سابقه', 'toman');
  run(() => {
    database.installChartTemplate();
    const active = database.activeWorkspaceDatabase();
    const cashLedger = { id: operationalLedgerAccount(active, 'cash') };
    const capital = active.prepare("SELECT id FROM ledger_accounts WHERE type='equity' AND active=1 ORDER BY code LIMIT 1").get();
    const overdraw = [{ occurredAt: '2026-10-02T08:00:00.000Z', memo: 'برداشت بیش از موجودی', lines: [
      { accountId: capital.id, debit: 7_000_000, credit: 0 }, { accountId: cashLedger.id, debit: 0, credit: 7_000_000 },
    ] }];
    assert.throws(() => database.createJournalDocuments(overdraw), (error) => error.code === 'NEGATIVE_BALANCE');
    // همان منفی، وقتی سابقهٔ واقعیِ واردشده است: ثبت می‌شود و در تأییدهای منفی می‌ماند.
    active.exec('BEGIN IMMEDIATE');
    active.prepare(`INSERT INTO journal_entries (id,source_type,source_id,revision,entry_kind,occurred_at,memo,document_number,fiscal_year,approval_state)
      VALUES ('history-1','manual-batch','history-1',1,'adjustment','2024-04-01T08:00:00.000Z','سابقه',90001,1403,'draft')`).run();
    active.prepare('INSERT INTO journal_lines (id,entry_id,account_id,debit,credit,description) VALUES (?,?,?,?,?,?)').run('history-1a', 'history-1', capital.id, 3_000_000, 0, '');
    active.prepare('INSERT INTO journal_lines (id,entry_id,account_id,debit,credit,description) VALUES (?,?,?,?,?,?)').run('history-1b', 'history-1', cashLedger.id, 0, 3_000_000, '');
    acknowledgeImportedHistory(active, { reason: 'ماندهٔ منفی از اسناد واردشده', userId: owner.id, role: 'import' });
    active.exec('COMMIT');
    assert.equal(database.listAccounts().find((account) => account.id === 'cash').balance, -3_000_000);
    assert.equal(active.prepare("SELECT COUNT(*) AS n FROM overdraft_approvals WHERE reason LIKE '%اسناد واردشده%'").get().n, 1);
  });
});

test('DNA خالص: ردیف بی‌زمان ثبت انضباط نمی‌سازد؛ زیر هشت ردیفِ طرف‌دار ادعای مشتری اصلی نیست', () => {
  const rows = [];
  for (let day = 1; day <= 24; day += 1) {
    rows.push({ amount: 1_000_000, type: 'income', category: 'فروش', source: 'parsian-import', occurredAt: `2024-05-${String(day).padStart(2, '0')}T08:00:00Z`, createdAt: null, counterparty: day <= 7 ? 'مشتری نمونه' : '' });
  }
  const traits = Object.fromEntries(financialDna(rows, { now: new Date('2024-07-01T00:00:00Z') }).traits.map((trait) => [trait.id, trait]));
  assert.equal(traits['entry-discipline'], undefined);
  assert.equal(traits['voice-adoption'], undefined);
  assert.equal(traits['customer-concentration'], undefined, 'هفت ردیف کافی نیست');
  rows[7].counterparty = 'مشتری نمونه';
  const withEight = Object.fromEntries(financialDna(rows, { now: new Date('2024-07-01T00:00:00Z') }).traits.map((trait) => [trait.id, trait]));
  assert.ok(withEight['customer-concentration']);
  // ثبت روزانهٔ واقعی (با زمان ثبت) همچنان انضباط و سهم صوتی دارد.
  const daily = rows.map((row) => ({ ...row, source: 'voice', createdAt: row.occurredAt }));
  const dailyTraits = Object.fromEntries(financialDna(daily, { now: new Date('2024-07-01T00:00:00Z') }).traits.map((trait) => [trait.id, trait]));
  assert.ok(dailyTraits['entry-discipline']);
  assert.equal(dailyTraits['voice-adoption'].value, '100٪');
});

test('از راه HTTP: دکمهٔ «ورود» بانک‌ها و اشخاص را هم می‌سازد؛ بایگانی فاکتور و DNA از API خوانده می‌شوند', async () => {
  const { spawn } = await import('node:child_process');
  const workspace = database.createWorkspace(owner.id, { name: 'HTTP ورود کامل', profileType: 'business' });
  database.setExperiencePreference(workspace.id, owner.id, 'professional');
  database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, () => database.setLedgerAmountUnit('rial'));
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: '0', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`سرور بالا نیامد: ${output}`)), 15_000);
      child.stdout.on('data', (chunk) => { output += chunk; const match = output.match(/listening on port (\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
      child.stderr.on('data', (chunk) => { output += chunk; });
    });
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'full-import-owner', password: process.env.ADMIN_PASSWORD }) });
    const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const { csrfToken } = await login.json();
    const headers = { cookie, 'x-csrf-token': csrfToken, 'x-workspace-id': workspace.id };
    const form = new FormData();
    form.append('file', new Blob([buildParsianBackup(companyTables())]), 'company.bak');
    form.append('amountUnit', 'rial');
    const commit = await fetch(`${base}/api/import/parsian-backup/commit`, { method: 'POST', body: form, headers });
    const result = await commit.json();
    assert.equal(commit.status, 201, JSON.stringify(result).slice(0, 400));
    assert.equal(result.phaseB.contacts.created, 5);
    assert.equal(result.phaseB.contacts.enriched, 2);
    assert.ok(result.phaseB.accounts.bound + result.phaseB.accounts.created >= 1);
    const archive = await (await fetch(`${base}/api/invoices/parsian-archive?kind=purchase`, { headers })).json();
    assert.equal(archive.items.length, 12);
    const dna = await (await fetch(`${base}/api/financial-dna?months=6`, { headers })).json();
    assert.equal(dna.basis.source, 'parsian-import');
  } finally { child.kill(); }
});
