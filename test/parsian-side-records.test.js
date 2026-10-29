// سابقهٔ سامانهٔ مؤدیان و چک‌های ضمانتِ بکاپ پارسیان.
//
// گزارش کاربر (۸ آبان ۱۴۰۵): پیش‌نمایش ورود گفت ۷ جدول خوانده نمی‌شود. دو تا به کار دفتر
// می‌آیند و خوانده شدند؛ چهار تا بی‌اثرند و دیگر در هشدار نمی‌آیند.
// خانواده:
//  - مؤدیان: پذیرفته، خطا با پیام خود سامانه، خطا و ارسال دوبارهٔ موفق (دیگر باز نیست)،
//    بی‌نتیجه، برگشت از فروش، ابطال بی‌شمارهٔ فاکتور، پیام خطای خراب (نه JSON).
//  - چک ضمانت: پرداختی و دریافتی، با طرف حساب و بانک از کدینگ؛ سند و مانده نمی‌سازد.
//  - رازِ مؤدیان (tbl_NEWMovadianInfo) همچنان خوانده نمی‌شود.
// داده ساختگی است.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParsianBackup } from './helpers/parsianBakFixture.js';
import { moadianMessages, moadianStatus } from '../server/parsianSideRecords.js';

const SECRET = 'secret-token-never-read';
const MISMATCH = 'مقدار فیلد «شماره مالیاتی صورتحساب» با اطلاعات سامانه منطبق نیست.';

function tables() {
  const kol = [
    { Code: 11, CName: 'موجودي نقد و بانک', GroupCode: 11, iType: 0 }, { Code: 12, CName: 'حسابهاي دريافتني', GroupCode: 11, iType: 0 },
    { Code: 23, CName: 'حسابهاي پرداختني', GroupCode: 21, iType: 0 }, { Code: 60, CName: 'فروش', GroupCode: 41, iType: 1 },
  ];
  const moeen = [
    { KolCode: 11, Code: 1, CName: 'بانک ها' }, { KolCode: 12, Code: 1, CName: 'مشتريان' },
    { KolCode: 23, Code: 1, CName: 'تامين کنندگان' }, { KolCode: 60, Code: 1, CName: 'فروش کالا' },
  ];
  const tafsili = [
    { KolCode: 11, MoeenCode: 1, Code: 1, CName: 'بانک نمونه' },
    { KolCode: 12, MoeenCode: 1, Code: 1, CName: 'مشتری نمونه' },
    { KolCode: 23, MoeenCode: 1, Code: 1, CName: 'شرکت نمونه آلفا' },
  ];
  let id = 1;
  const document = [];
  const factor = [];
  for (const [index, number] of [101, 102, 103].entries()) {
    const sanad = 10 + index;
    document.push(
      { ID: id++, Sanad_Num: sanad, SanadDate: '1405/02/10', KolCode: 12, MoeenCode: 1, TafsiliCode: 1, Comment: 'فروش', Bed: 1_000_000, Bes: 0, SanadComment: null, Factor_Num: number },
      { ID: id++, Sanad_Num: sanad, SanadDate: '1405/02/10', KolCode: 60, MoeenCode: 1, TafsiliCode: 0, Comment: 'فروش', Bed: 0, Bes: 1_000_000, SanadComment: null, Factor_Num: number },
    );
    factor.push({ ID: index + 1, Factor_Num: number, Factor_Date: '1405/02/10', TitleCode: 1, Sanad_Num: sanad, GoodsCode: 1, Tedad: 1, Price: 1_000_000 });
  }
  const failure = JSON.stringify([{ code: '0300101', message: MISMATCH }]);
  return {
    tbl_ACCGroup: [{ Code: 11, CName: 'دارايي هاي جاري' }, { Code: 21, CName: 'بدهي هاي جاري' }, { Code: 41, CName: 'فروش و درآمدها' }],
    tbl_Kol: kol, tbl_Moeen: moeen, tbl_Tafsili: tafsili, tbl_Document: document,
    tbl_AccSetting: [{ ID: 2, Cash_K: 0, Cash_M: 0, Cash_T: 0, Sell_K: 60, Sell_M: 1, Sell_T: 0, Wage_K: 0, Wage_M: 0, Wage_T: 0, Asset_K: 0, Asset_M: 0, Asset_T: 0 }],
    tbl_VATSetting: [{ ID: 6, VATSale_K: 0, VATSale_M: 0, VATSale_T: 0, VATBuy_K: 0, VATBuy_M: 0, VATBuy_T: 0 }],
    tbl_Goods: [{ Code: 1, GroupCode: 0, CName: 'کالای نمونه', UnitName_1: 'عدد', Equal: 1, Price_1: 1_000_000, VATPercent: 0, HaveChild: false, IsActive: true }],
    tbl_FactorKind: [{ Code: 1, CName: 'فاکتور فروش', HaveDocument: true }],
    tbl_Factor: factor,
    tbl_NEWMovadian: [
      { ID: 1, Code: 1, Num: 101, RecType: 1, Serial: 1, SDate: '1405/02/11', TaxId: 'A000000000000001', Status: 'SUCCESS', Error: '[]', Mozo: 1, Factor_Date: '1405/02/10' },
      // خطا، بعد ارسال دوبارهٔ موفق: دیگر مشکل باز نیست.
      { ID: 2, Code: 1, Num: 102, RecType: 1, Serial: 2, SDate: '1405/02/11', TaxId: 'A000000000000002', Status: 'FAILED', Error: failure, Mozo: 1, Factor_Date: '1405/02/10' },
      { ID: 3, Code: 1, Num: 102, RecType: 1, Serial: 3, SDate: '1405/02/12', TaxId: 'A000000000000003', Status: 'SUCCESS', Error: '[]', Mozo: 1, Factor_Date: '1405/02/10' },
      { ID: 4, Code: 1, Num: 103, RecType: 1, Serial: 4, SDate: '1405/02/11', TaxId: 'A000000000000004', Status: 'FAILED', Error: failure, Mozo: 1, Factor_Date: '1405/02/10' },
      // برگشت از فروش، بی‌نتیجه.
      { ID: 5, Code: 1, Num: 103, RecType: 4, Serial: 5, SDate: '1405/03/01', TaxId: '', Status: null, Error: '', Mozo: 4, Factor_Date: '1405/02/10' },
    ],
    tbl_NEWMovadian_Ebtal: [{ ID: 1, SDate: '1405/03/02', Status: 'FAILED', Error: 'خطای اتصال' }],
    tbl_CheckTazmin: [
      { ID: 1, Chk_Num: '700001', Acc_Num: '0000000000', Chk_Date: '1404/04/25', Chk_Money: 500_000_000, BankBranch: 'شعبهٔ نمونه',
        Bank_K: 11, Bank_M: 1, Bank_T: 1, Acc_K: 23, Acc_M: 1, Acc_T: 1, Chk_Kind: 1, Comment: 'ضمانت قرارداد', Sanad_Num: 0, IsActive: null },
      { ID: 2, Chk_Num: '700002', Acc_Num: '', Chk_Date: '1406/02/31', Chk_Money: 200_000_000, BankBranch: '',
        Bank_K: 0, Bank_M: 0, Bank_T: 0, Acc_K: 12, Acc_M: 1, Acc_T: 1, Chk_Kind: 0, Comment: '', Sanad_Num: 0, IsActive: null },
    ],
    tbl_Kamali: [{ ID: 1, Code: 1, Comment: 'جملهٔ روز نمونه' }],
    tbl_PeriodName: [{ ID: 1, YName: '1405' }],
    tbl_PrintCheck: [{ ID: 1, Comment: 'قالب چاپ' }],
    tbl_DBError: [{ ID: 1, Taraz: null }],
    tbl_Ghest: [{ ID: 1, Money: 100 }],
    tbl_NEWMovadianInfo: [{ ID: 1, PrivateKey: SECRET, Token: SECRET }],
  };
}

test('پیام و وضعیت سامانه: JSON، متن خراب و خالی', () => {
  assert.deepEqual(moadianMessages(JSON.stringify([{ code: '1', message: MISMATCH }])), [MISMATCH]);
  assert.deepEqual(moadianMessages('[]'), []);
  assert.deepEqual(moadianMessages('خطای اتصال'), ['خطای اتصال']);
  assert.deepEqual(['SUCCESS', 'FAILED', null, 'x'].map(moadianStatus), ['success', 'failed', 'pending', 'pending']);
});

const tempPathModule = await import('./helpers/tempPath.js');
const databasePath = tempPathModule.tempDatabase('parsian-side-records');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'side-owner';
process.env.ADMIN_PASSWORD = 'x-strong-password-1234';
const database = await import(`../server/db.js?side-records=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('side-owner', 'x-strong-password-1234');
test.after(() => tempPathModule.removeTempDatabase(databasePath));
const imp = await import(`../server/parsianImport.js?side=${process.pid}`);
const { completeParsianImport } = await import(`../server/parsianPhaseB.js?side=${process.pid}`);
const { listParsianInvoiceArchive } = await import(`../server/parsianExtras.js?side=${process.pid}`);
const { importParsianSideRecords, listGuaranteeCheques } = await import(`../server/parsianSideRecords.js?side=${process.pid}`);
const { parseParsianBackup } = await import('../server/parsianBackup.js');

test('ورود: مؤدیان روی فاکتور فروش و چک ضمانت جدا، بی‌سند؛ جدول‌های بی‌اثر در هشدار نیستند', () => {
  const workspace = database.createWorkspace(owner.id, { name: 'مؤدیان و ضمانت', profileType: 'business' });
  database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, () => {
    const active = database.activeWorkspaceDatabase();
    const backup = buildParsianBackup(tables());
    const preview = imp.previewParsianBackup(active, backup, 'side.bak', { amountUnit: 'toman' });
    const unread = preview.warnings.find((warning) => warning.includes('جدول دیگر')) || '';
    for (const name of ['tbl_Kamali', 'tbl_PeriodName', 'tbl_PrintCheck', 'tbl_DBError', 'tbl_NEWMovadian', 'tbl_CheckTazmin']) assert.equal(unread.includes(name), false, name);
    // جدول مالیِ خوانده‌نشدهٔ واقعی هنوز گفته می‌شود.
    assert.ok(unread.includes('tbl_Ghest'));
    assert.equal(preview.extras.moadianRecords, 6);
    assert.equal(preview.extras.guaranteeCheques, 2);

    const entriesBefore = 0;
    const result = imp.commitParsianBackup(active, backup, 'side.bak', { createdBy: owner.id, amountUnit: 'toman' });
    assert.deepEqual(result.side.moadian, { stored: 6, failed: 3, pending: 1 });
    assert.equal(result.side.guaranteeCheques.stored, 2);
    // فقط سه سند فروش؛ چک ضمانت سند نمی‌سازد.
    assert.equal(active.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, entriesBefore + 3);
    completeParsianImport(active, { createdBy: owner.id, contactIds: undefined });

    const archive = listParsianInvoiceArchive(active, { kind: 'sales' });
    const status = Object.fromEntries(archive.items.map((item) => [item.number, item.moadian?.status]));
    assert.deepEqual(status, { 101: 'success', 102: 'success', 103: 'failed' });
    assert.deepEqual(archive.items.find((item) => item.number === 103).moadian.messages, [MISMATCH]);
    assert.deepEqual({ success: archive.moadian.success, failed: archive.moadian.failed, pending: archive.moadian.pending }, { success: 2, failed: 3, pending: 1 });
    // هر سه فاکتور فروش دست‌کم یک ارسال دارند.
    assert.equal(archive.moadian.notSent, 0);
    // باز: ۱۰۳ (خطا)، برگشت ۱۰۳ (بی‌نتیجه)، ابطال (خطا). ۱۰۲ دوباره و موفق رفت.
    assert.deepEqual(archive.moadian.open.map((record) => [record.invoiceNumber, record.subjectLabel, record.status]),
      [[0, 'ابطال', 'failed'], [103, 'اصلی', 'failed'], [103, 'برگشت از فروش', 'pending']]);

    const guarantees = listGuaranteeCheques(active);
    assert.deepEqual(guarantees.map((item) => [item.direction, item.amount, item.dueJalali]),
      [['payable', 500_000_000, '1404/04/25'], ['receivable', 200_000_000, '1406/02/31']]);
    assert.equal(guarantees[0].party, 'شرکت نمونه آلفا');
    assert.equal(guarantees[0].bank, 'بانک نمونه');
    assert.equal(guarantees[1].party, 'مشتری نمونه');

    // اجرای دوبارهٔ همان فایل چیزی را تکرار نمی‌سازد (ورود کامل دوباره را خود ورود رد می‌کند).
    const again = importParsianSideRecords(active, parseParsianBackup(backup), { fileUnit: 'toman', ledgerUnit: 'toman' });
    assert.deepEqual([again.moadian.stored, again.guaranteeCheques.stored], [0, 0]);
    // راز مؤدیان هیچ‌جا ذخیره نشده.
    const dump = active.prepare("SELECT group_concat(messages) AS m FROM parsian_moadian_records").get().m || '';
    assert.equal(dump.includes(SECRET), false);
  });
});
