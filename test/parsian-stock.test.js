// موجودی کالای بکاپ پارسیان از گردش فاکتورها — شکل بکاپ اتیه سازان (۷ آبان ۱۴۰۵)، با عددهای ساختگی.
//
// خانوادهٔ رویداد:
//   ورود: اول دوره، خرید (خالص تخفیف)، برگشت از فروش، تولید (به قیمت خود پارسیان)؛
//   خروج: فروش و مصرف به میانگین موزون جاری، برگشت از خرید به قیمت همان فاکتور؛
//   کنار می‌روند: ابطالی، امانات، خدمت؛ کالایی که گردشش منفی تمام می‌شود ← شمارش، نه حدس؛
//   هیچ سند تازه‌ای؛ ارزش موجودی در برابر حساب موجودی دفتر با اختلاف گفته‌شده؛
//   فایل ریالی در دفتر تومانی؛ اجرای دوباره چیزی را تکرار نمی‌سازد.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParsianBackup } from './helpers/parsianBakFixture.js';
import { parseParsianBackup } from '../server/parsianBackup.js';
import { parsianStockLedger, importParsianStock } from '../server/parsianStock.js';

const tempPathModule = await import('./helpers/tempPath.js');
const databasePath = tempPathModule.tempDatabase('parsian-stock');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'stock-owner';
process.env.ADMIN_PASSWORD = 'stock-strong-password-12345';
const database = await import(`../server/db.js?parsian-stock=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('stock-owner', 'stock-strong-password-12345');
const { commitParsianBackup } = await import('../server/parsianImport.js');
test.after(() => tempPathModule.removeTempDatabase(databasePath));

const RAW = 100;   // مواد اولیه
const PRODUCT = 200; // محصول ساخته‌شده
const RESOLD = 300;  // کالای خرید و فروش
const LOST = 400;    // فروش بی‌خرید: منفی
const SERVICE = 500;

function stockTables() {
  const kol = [
    { Code: 11, CName: 'موجودي مواد و کالا', GroupCode: 1, iType: 0 }, { Code: 12, CName: 'حسابهاي دريافتني', GroupCode: 1, iType: 0 },
    { Code: 31, CName: 'سرمايه', GroupCode: 2, iType: 0 },
  ];
  const moeen = [{ KolCode: 11, Code: 1, CName: 'موجودي مواد اوليه' }, { KolCode: 12, Code: 1, CName: 'مشتريان' }, { KolCode: 31, Code: 1, CName: 'سرمايه' }];
  // سند افتتاحیه: موجودی مواد ۱٬۰۰۰٬۰۰۰ ریال.
  const document = [
    { ID: 1, Sanad_Num: 1, SanadDate: '1403/01/01', KolCode: 11, MoeenCode: 1, TafsiliCode: 0, Comment: 'افتتاحيه', Bed: 1_000_000, Bes: 0 },
    { ID: 2, Sanad_Num: 1, SanadDate: '1403/01/01', KolCode: 31, MoeenCode: 1, TafsiliCode: 0, Comment: 'افتتاحيه', Bed: 0, Bes: 1_000_000 },
  ];
  let id = 1;
  const line = (title, number, date, goods, quantity, price, discount = 0) => ({
    ID: id++, Factor_Num: number, Factor_Date: date, TitleCode: title, Sanad_Num: 0, GoodsCode: goods, Tedad: quantity, Price: price, Discont: discount,
  });
  const factor = [
    line(5, 1, '1403/01/01', RAW, 100, 10_000),                 // اول دوره: ۱۰۰ × ۱۰٬۰۰۰
    line(2, 1, '1403/02/01', RAW, 100, 12_000, 200_000),        // خرید با تخفیف: ۱٬۲۰۰٬۰۰۰ − ۲۰۰٬۰۰۰
    line(13, 1, '1403/03/01', RAW, 50, 99_999),                 // مصرف: به میانگین (۱۰٬۰۰۰)، نه قیمت فاکتور
    line(12, 1, '1403/03/01', PRODUCT, 10, 60_000),             // تولید: به قیمت پارسیان
    line(1, 1, '1403/04/01', PRODUCT, 4, 150_000),              // فروش: به میانگین (۶۰٬۰۰۰)
    line(4, 1, '1403/04/10', PRODUCT, 1, 150_000),              // برگشت از فروش: به میانگین
    line(2, 2, '1403/05/01', RESOLD, 10, 30_000),
    line(3, 1, '1403/05/02', RESOLD, 2, 30_000),                // برگشت از خرید: به قیمت فاکتور
    line(1, 2, '1403/05/03', LOST, 5, 10_000),                  // بی‌خرید: منفی
    line(1, 3, '1403/05/04', SERVICE, 1, 10_000),               // خدمت
    line(263, 1, '1403/05/05', RAW, 30, 10_000),                // ابطالی
    line(9, 1, '1403/05/06', RESOLD, 3, 10_000),                // امانات دریافتنی
  ];
  return {
    tbl_ACCGroup: [{ Code: 1, CName: 'دارايي' }, { Code: 2, CName: 'حقوق' }], tbl_Kol: kol, tbl_Moeen: moeen, tbl_Tafsili: [], tbl_Document: document,
    tbl_GoodsGroup: [{ Code: 1, CName: 'کالا', IsService: false }, { Code: 2, CName: 'خدمات', IsService: true }],
    tbl_Goods: [
      { Code: RAW, GroupCode: 1, CName: 'گرانول نمونه', UnitName_1: 'کيلوگرم', Price_1: 0, IsActive: true },
      { Code: PRODUCT, GroupCode: 1, CName: 'قطعهٔ نمونه', UnitName_1: 'عدد', Price_1: 150_000, IsActive: true },
      { Code: RESOLD, GroupCode: 1, CName: 'کالای بازرگانی نمونه', UnitName_1: 'عدد', Price_1: 0, IsActive: true },
      { Code: LOST, GroupCode: 1, CName: 'کالای بی‌خرید نمونه', UnitName_1: 'عدد', Price_1: 0, IsActive: true },
      { Code: SERVICE, GroupCode: 2, CName: 'خدمت نمونه', UnitName_1: '', Price_1: 0, IsActive: true },
    ],
    tbl_FactorKind: [[1, 'فاکتور فروش'], [2, 'فاکتور خريد'], [3, 'برگشت از خريد'], [4, 'برگشت ازفروش'], [5, 'موجودي اول دوره'],
      [9, 'امانات دريافتني'], [12, 'فاکتور توليد'], [13, 'فاکتور مصرف'], [263, 'صورت حساب ها ابطالي']].map(([Code, CName]) => ({ Code, CName, HaveDocument: false })),
    tbl_Factor: factor,
    tbl_AccSetting: [{ ID: 2, Cash_K: 0, Cash_M: 0, Cash_T: 0, Sell_K: 0, Sell_M: 0, Sell_T: 0, Wage_K: 0, Wage_M: 0, Wage_T: 0, Asset_K: 0, Asset_M: 0, Asset_T: 0 }],
    tbl_VATSetting: [{ ID: 6, VATSale_K: 0, VATSale_M: 0, VATSale_T: 0, VATBuy_K: 0, VATBuy_M: 0, VATBuy_T: 0 }],
  };
}

const parsed = () => parseParsianBackup(buildParsianBackup(stockTables()), { fileName: 'stock.bak' });

test('گردش موجودی: هر نوع فاکتور جهت و بهای درست، به میانگین موزون', () => {
  const { products, excluded } = parsianStockLedger(parsed());
  const raw = products.get(RAW);
  // ۱۰۰×۱۰٬۰۰۰ + (۱۰۰×۱۲٬۰۰۰ − ۲۰۰٬۰۰۰) = ۲٬۰۰۰٬۰۰۰ برای ۲۰۰؛ میانگین ۱۰٬۰۰۰؛ مصرف ۵۰ ← ۵۰۰٬۰۰۰.
  assert.deepEqual([raw.quantity, raw.value], [150, 1_500_000]);
  assert.equal(raw.movements.find((move) => move.kind === 'consumption').value, -500_000);
  // تولید ۱۰ × ۶۰٬۰۰۰، فروش ۴ و برگشت ۱ هر دو به ۶۰٬۰۰۰.
  assert.deepEqual([products.get(PRODUCT).quantity, products.get(PRODUCT).value], [7, 420_000]);
  // برگشت از خرید به قیمت فاکتور.
  assert.deepEqual([products.get(RESOLD).quantity, products.get(RESOLD).value], [8, 240_000]);
  assert.equal(products.get(LOST).quantity, -5);
  assert.equal(products.has(SERVICE), false, 'خدمت موجودی ندارد');
  assert.deepEqual(excluded, { 'امانات دريافتني': 1, 'صورت حساب ها ابطالي': 1 });
});

test('ورود موجودی در دفتر تومانی: بی‌سند، ماندهٔ کالا با بهای میانگین، منفی ← شمارش، اختلاف با دفتر گفته می‌شود، اجرای دوباره هیچ', () => {
  const workspace = database.createWorkspace(owner.id, { name: 'موجودی پارسیان', profileType: 'business' });
  database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, () => {
    const active = database.activeWorkspaceDatabase();
    const result = commitParsianBackup(active, buildParsianBackup(stockTables()), 'stock.bak', { createdBy: owner.id, amountUnit: 'rial', kolTypes: { 11: 'asset', 12: 'asset', 31: 'equity' } });
    assert.equal(result.stock.error, undefined, result.stock.error);
    assert.equal(active.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, 1, 'فقط سند افتتاحیهٔ پارسیان');
    const product = (name) => active.prepare('SELECT stock,inventory_value AS value,average_cost AS average FROM products WHERE name=?').get(name);
    const ratio = result.ledgerUnit === 'toman' ? 10 : 1;
    assert.deepEqual({ ...product('گرانول نمونه') }, { stock: 150, value: 1_500_000 / ratio, average: 10_000 / ratio });
    assert.deepEqual({ ...product('قطعهٔ نمونه') }, { stock: 7, value: 420_000 / ratio, average: 60_000 / ratio });
    assert.equal(product('کالای بی‌خرید نمونه').stock, 0, 'منفی حدس زده نمی‌شود');
    assert.equal(result.stock.products, 3);
    assert.ok(result.stock.warnings.some((text) => /کالای بی‌خرید نمونه.*شمارش/.test(text)), result.stock.warnings.join('\n'));
    assert.ok(result.stock.warnings.some((text) => /امانات/.test(text)));
    // دفتر: موجودی مواد ۱٬۰۰۰٬۰۰۰ ریال (اول دوره)؛ گردش: ۲٬۱۶۰٬۰۰۰ ریال.
    assert.deepEqual([result.stock.control.balance, result.stock.control.value], [1_000_000 / ratio, 2_160_000 / ratio]);
    assert.ok(result.stock.warnings.some((text) => /ادواری/.test(text)));
    // تولید ۶۰۰٬۰۰۰ در برابر مصرف ۵۰۰٬۰۰۰: فاصله گفته می‌شود.
    assert.ok(result.stock.warnings.some((text) => /ارزش تولید/.test(text)));
    const movements = active.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE source_type='parsian_invoice'").get().n;
    assert.equal(movements, 8);
    const again = importParsianStock(active, parsed(), { fileUnit: 'rial', ledgerUnit: result.ledgerUnit });
    assert.equal(again.existing, true);
    assert.equal(active.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE source_type='parsian_invoice'").get().n, movements);
  });
});
