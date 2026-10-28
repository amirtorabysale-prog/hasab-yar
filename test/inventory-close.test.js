// سند پایان دورهٔ انبار (روش ادواری پارسیان) — شکل بکاپ اتیه سازان، با عددهای ساختگی.
//
// خانوادهٔ رویداد:
//   - دفتر ادواری با موجودی اول دوره، خرید کالا با فاکتور، برگشت از خرید با فاکتور و فروش:
//     سند «منتظر کنترل» با بستن موجودی اول دوره، خرید و برگشت، موجودی پایان دوره و بهای تمام‌شده؛
//   - خرید لوازم مصرفی زیر همان کل «خرید» ولی بی‌فاکتور: دست نمی‌خورد (حساب خرید از شاهد، نه نام)؛
//   - پیش از کنترل هیچ گزارشی عوض نمی‌شود؛ بعد از کنترل موجودی دفتر = موجودی گردش کالا؛
//   - بازسازی همان شماره را نگه می‌دارد؛ سند کنترل‌شده بازسازی نمی‌شود؛
//   - منفی‌ها: پارسیان خودش سند انبار زده، دفتر بی‌گردش کالای پارسیان، گردش دائمی حساب‌یار در
//     همان سال، حساب بهای تمام‌شده نیست — هیچ‌کدام سندی نمی‌سازند.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParsianBackup } from './helpers/parsianBakFixture.js';

const tempPathModule = await import('./helpers/tempPath.js');
const databasePath = tempPathModule.tempDatabase('inventory-close');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'inventory-close-owner';
process.env.ADMIN_PASSWORD = 'Qv7-harbor-lantern-Xp93';
const database = await import(`../server/db.js?inventory-close=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('inventory-close-owner', 'Qv7-harbor-lantern-Xp93');
const { commitParsianBackup } = await import('../server/parsianImport.js');
const { previewInventoryClose, proposeInventoryClose } = await import('../server/accounting/inventoryClose.js');
const { setJournalApproval } = await import('../server/accounting/journalBook.js');
const { recordInventoryMovement } = await import('../server/inventory.js');
test.after(() => tempPathModule.removeTempDatabase(databasePath));

const RAW = 100;
const GOODS = 200;

/** یک سال کار ادواری: افتتاحیه، دو خرید کالا، یک خرید مصرفی، یک برگشت از خرید، دو فروش. */
function periodicTables({ parsianClosed = false, withCogs = true } = {}) {
  const kol = [
    { Code: 15, CName: 'موجودي مواد و كالـا', GroupCode: 1, iType: 0 }, { Code: 12, CName: 'حسابهاي دريافتني', GroupCode: 1, iType: 0 },
    { Code: 22, CName: 'حسابهاي پرداختي', GroupCode: 2, iType: 0 }, { Code: 31, CName: 'سرمايه', GroupCode: 3, iType: 0 },
    { Code: 60, CName: 'فروش', GroupCode: 4, iType: 1 }, { Code: 62, CName: 'خريــــد', GroupCode: 5, iType: 1 },
    { Code: 63, CName: 'برگشت از خريد و تخفيفات', GroupCode: 5, iType: 1 },
    ...(withCogs ? [{ Code: 67, CName: 'قيمت تمام شده کالاي فروش رفته', GroupCode: 5, iType: 1 }] : []),
  ];
  const moeen = [
    { KolCode: 15, Code: 1, CName: 'موجودي مواد اوليه' }, { KolCode: 15, Code: 3, CName: 'موجودي کالاي پايان دوره' },
    { KolCode: 12, Code: 1, CName: 'مشتريان' }, { KolCode: 22, Code: 1, CName: 'تامين کنندگان' }, { KolCode: 31, Code: 1, CName: 'سرمايه' },
    { KolCode: 60, Code: 1, CName: 'فروش' }, { KolCode: 62, Code: 1, CName: 'خريد' }, { KolCode: 62, Code: 2, CName: 'خريد لوازم و مواد مصرفي' },
    { KolCode: 63, Code: 1, CName: 'برگشت از خريد' },
    ...(withCogs ? [{ KolCode: 67, Code: 1, CName: 'قيمت تمام شده کالاي فروش رفته' }] : []),
  ];
  let id = 1;
  const row = (sanad, date, kolCode, moeenCode, bed, bes, factor = 0) => ({
    ID: id++, Sanad_Num: sanad, SanadDate: date, KolCode: kolCode, MoeenCode: moeenCode, TafsiliCode: 0, Comment: 'آزمون', Bed: bed, Bes: bes, Factor_Num: factor,
  });
  const document = [
    row(1, '1403/01/01', 15, 3, 900_000, 0), row(1, '1403/01/01', 31, 1, 0, 900_000),       // افتتاحیه: دفتر ۹۰۰٬۰۰۰
    row(2, '1403/02/01', 62, 1, 2_000_000, 0, 1), row(2, '1403/02/01', 22, 1, 0, 2_000_000, 1), // خرید ۱
    row(3, '1403/03/01', 62, 1, 1_000_000, 0, 2), row(3, '1403/03/01', 22, 1, 0, 1_000_000, 2), // خرید ۲
    row(4, '1403/03/05', 62, 2, 50_000, 0), row(4, '1403/03/05', 22, 1, 0, 50_000),             // لوازم مصرفی، بی‌فاکتور
    row(5, '1403/04/01', 22, 1, 200_000, 0, 1), row(5, '1403/04/01', 63, 1, 0, 200_000, 1),     // برگشت از خرید
    row(6, '1403/05/01', 12, 1, 3_000_000, 0, 1), row(6, '1403/05/01', 60, 1, 0, 3_000_000, 1), // فروش
    ...(parsianClosed ? [row(7, '1403/12/30', 67, 1, 100, 0), row(7, '1403/12/30', 15, 3, 0, 100)] : []),
  ];
  let line = 1;
  const factor = (title, number, date, sanad, goods, quantity, price) => ({ ID: line++, Factor_Num: number, Factor_Date: date, TitleCode: title, Sanad_Num: sanad, GoodsCode: goods, Tedad: quantity, Price: price, Discont: 0 });
  const tbl_Factor = [
    factor(5, 1, '1403/01/01', 0, RAW, 100, 10_000),       // اول دوره در فاکتور: ۱٬۰۰۰٬۰۰۰ (دفتر ۹۰۰٬۰۰۰)
    factor(2, 1, '1403/02/01', 2, RAW, 100, 20_000),        // ۲٬۰۰۰٬۰۰۰
    factor(2, 2, '1403/03/01', 3, GOODS, 50, 20_000),       // ۱٬۰۰۰٬۰۰۰
    factor(3, 1, '1403/04/01', 5, GOODS, 10, 20_000),       // برگشت ۲۰۰٬۰۰۰
    factor(1, 1, '1403/05/01', 6, RAW, 150, 20_000),        // فروش ۱۵۰ مواد به میانگین ۱۵٬۰۰۰
  ];
  return {
    tbl_ACCGroup: [1, 2, 3, 4, 5].map((Code) => ({ Code, CName: `گروه ${Code}` })), tbl_Kol: kol, tbl_Moeen: moeen, tbl_Tafsili: [], tbl_Document: document,
    tbl_GoodsGroup: [{ Code: 1, CName: 'کالا', IsService: false }],
    tbl_Goods: [{ Code: RAW, GroupCode: 1, CName: 'مادهٔ نمونه', UnitName_1: 'کیلو', Price_1: 0, IsActive: true },
      { Code: GOODS, GroupCode: 1, CName: 'کالای نمونه', UnitName_1: 'عدد', Price_1: 0, IsActive: true }],
    tbl_FactorKind: [[1, 'فاکتور فروش'], [2, 'فاکتور خريد'], [3, 'برگشت از خريد'], [5, 'موجودي اول دوره']].map(([Code, CName]) => ({ Code, CName, HaveDocument: Code !== 5 })),
    tbl_Factor,
    tbl_AccSetting: [{ ID: 2, Cash_K: 0, Cash_M: 0, Cash_T: 0, Sell_K: 0, Sell_M: 0, Sell_T: 0, Wage_K: 0, Wage_M: 0, Wage_T: 0, Asset_K: 0, Asset_M: 0, Asset_T: 0 }],
    tbl_VATSetting: [{ ID: 6, VATSale_K: 0, VATSale_M: 0, VATSale_T: 0, VATBuy_K: 0, VATBuy_M: 0, VATBuy_T: 0 }],
  };
}

const KOL_TYPES = { 15: 'asset', 12: 'asset', 22: 'liability', 31: 'equity', 60: 'income', 62: 'expense', 63: 'expense', 67: 'expense' };

function importedWorkspace(name, options) {
  const workspace = database.createWorkspace(owner.id, { name, profileType: 'business' });
  return (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, () => {
    const active = database.activeWorkspaceDatabase();
    if (!active.prepare('SELECT 1 FROM journal_entries LIMIT 1').get()) {
      database.setLedgerAmountUnit('rial');
      commitParsianBackup(active, buildParsianBackup(periodicTables(options)), `${name}.bak`, { createdBy: owner.id, amountUnit: 'rial', kolTypes: KOL_TYPES });
    }
    return callback(active);
  });
}

const chartNet = (active, code, { approvedOnly = false } = {}) => Number(active.prepare(`SELECT COALESCE(SUM(jl.debit)-SUM(jl.credit),0) AS net FROM journal_lines jl
  JOIN journal_entries je ON je.id=jl.entry_id JOIN ledger_accounts la ON la.id=jl.account_id JOIN chart_accounts ca ON ca.id=la.chart_account_id
  WHERE ca.code=? ${approvedOnly ? "AND je.approval_state='approved'" : ''}`).get(code).net);

test('سند ادواری: موجودی اول دوره، خرید کالا و برگشت بسته؛ موجودی پایان دوره از گردش کالا؛ بهای تمام‌شده مابه‌التفاوت', () => {
  importedWorkspace('ادواری')((active) => {
    const preview = previewInventoryClose(active, 1403);
    assert.equal(preview.ready, true, JSON.stringify(preview.blockers));
    // پایان دوره: مواد ۵۰ × ۱۵٬۰۰۰ + کالا ۴۰ × ۲۰٬۰۰۰ = ۱٬۵۵۰٬۰۰۰.
    assert.deepEqual(preview.amounts, { opening: 900_000, purchases: 3_000_000, returns: 200_000, ending: 1_550_000, cogs: 900_000 + 3_000_000 - 200_000 - 1_550_000 });
    assert.deepEqual(preview.accounts.purchases.map((item) => item.name), ['خريد'], 'لوازم مصرفی بی‌فاکتور خرید کالا نیست');
    assert.match(preview.accounts.target.name, /پايان دوره/);
    assert.ok(preview.notes.some((text) => /900,000.*1,000,000/.test(text)), 'فاصلهٔ اول دوره در دفتر و فاکتور گفته می‌شود');

    const proposal = proposeInventoryClose(active, 1403, { userId: owner.id });
    assert.equal(proposal.state, 'submitted');
    // پیش از کنترل: هیچ ماندهٔ کنترل‌شده‌ای عوض نشده.
    assert.equal(chartNet(active, '670001', { approvedOnly: true }), 0);
    // سند متوازن است و خرید مصرفی دست نخورد.
    const lines = active.prepare('SELECT SUM(debit) AS d,SUM(credit) AS c FROM journal_lines WHERE entry_id=?').get(proposal.entryId);
    assert.equal(lines.d, lines.c);
    assert.equal(chartNet(active, '620002'), 50_000);

    // بازسازی: همان شماره.
    const again = proposeInventoryClose(active, 1403, { userId: owner.id });
    assert.deepEqual([again.rebuilt, again.documentNumber, again.entryId], [true, proposal.documentNumber, proposal.entryId]);

    setJournalApproval(active, proposal.entryId, 'approved', { userId: 'checker' });
    assert.equal(chartNet(active, '150003') + chartNet(active, '150001'), 1_550_000, 'موجودی دفتر = موجودی گردش کالا');
    assert.equal(chartNet(active, '620001'), 0);
    assert.equal(chartNet(active, '630001'), 0);
    assert.equal(chartNet(active, '670001'), 2_150_000);
    const blocked = previewInventoryClose(active, 1403);
    assert.ok(blocked.blockers.some((item) => item.code === 'INVENTORY_CLOSE_APPROVED'));
    assert.throws(() => proposeInventoryClose(active, 1403, { userId: owner.id }), { code: 'INVENTORY_CLOSE_APPROVED' });
  });
});

test('پارسیان خودش سند انبار زده: سند دوم ساخته نمی‌شود', () => {
  importedWorkspace('ادواری بسته', { parsianClosed: true })((active) => {
    const preview = previewInventoryClose(active, 1403);
    assert.ok(preview.blockers.some((item) => item.code === 'INVENTORY_ALREADY_CLOSED'), JSON.stringify(preview.blockers));
    assert.throws(() => proposeInventoryClose(active, 1403, { userId: owner.id }), { code: preview.blockers[0].code });
  });
});

test('حساب بهای تمام‌شده در کدینگ نیست: حدس نه', () => {
  importedWorkspace('ادواری بی‌بها', { withCogs: false })((active) => {
    assert.ok(previewInventoryClose(active, 1403).blockers.some((item) => item.code === 'COGS_ACCOUNT_AMBIGUOUS'));
  });
});

test('گردش دائمی حساب‌یار در همان سال، و دفتر بی‌گردش کالای پارسیان: سندی ساخته نمی‌شود', () => {
  importedWorkspace('ادواری و دائمی')((active) => {
    const product = active.prepare("SELECT id FROM products WHERE name='کالای نمونه'").get();
    recordInventoryMovement(active, product.id, { quantity: 1, unitCost: 1_000, movementType: 'adjustment', occurredAt: '2024-09-01T08:00:00.000Z' }, { journal: false });
    assert.ok(previewInventoryClose(active, 1403).blockers.some((item) => item.code === 'INVENTORY_CLOSE_MIXED'));
  });
  const plain = database.createWorkspace(owner.id, { name: 'دفتر بی‌پارسیان', profileType: 'business' });
  database.runInWorkspace(plain.id, { role: 'owner', userId: owner.id }, () => {
    const preview = previewInventoryClose(database.activeWorkspaceDatabase(), 1403);
    assert.ok(preview.blockers.some((item) => item.code === 'INVENTORY_CLOSE_NOT_PERIODIC'));
  });
});
