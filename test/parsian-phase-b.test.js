// آزمون فاز ب ورود پارسیان — حساب‌های عملیاتی و اشخاص از کدینگِ واردشده.
//
// سه چیز سنجیده می‌شود:
//  ۱) پیش‌نمایش فقط می‌خواند: معین‌های پولی زیر کل صندوق/بانک و تفصیلی‌های
//     شخص‌پذیر با پیش‌انتخاب درست (نام‌های حسابداری‌نما کنار می‌مانند).
//  ۲) ثبت: صندوق پیش‌فرض بازاستفاده می‌شود، بانک و تنخواه ساخته می‌شوند،
//     ردیف‌های هر شخص به حساب اختصاصی همان معین می‌رود و کارت‌ها همان لحظه
//     گردش را نشان می‌دهند. هیچ سند تازه‌ای ثبت نمی‌شود، جمع هر معین کدینگ
//     عیناً حفظ می‌شود و تفصیلی ردیف‌ها سر جایش می‌ماند — یعنی فایل انتقال
//     به پارسیان تغییری نمی‌کند.
//  ۳) اجرای دوباره هیچ چیز را تکرار نمی‌سازد.
//
// اگر بکاپ واقعی روی دیسک باشد، همین جریان روی آن هم می‌رود (فایل مشتری
// هرگز وارد Git نمی‌شود).

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildParsianBackup } from './helpers/parsianBakFixture.js';

const GROUPS = [
  { Code: 11, CName: 'دارايي هاي جاري' }, { Code: 21, CName: 'بدهي هاي جاري' },
  { Code: 41, CName: 'فروش و درآمدها' }, { Code: 61, CName: 'هزينه هاي فعاليت' },
];

function phaseBTables() {
  const kol = [
    { Code: 10, CName: 'صندوق', GroupCode: 11, iType: 0 },
    { Code: 11, CName: 'بانک ها', GroupCode: 11, iType: 0 },
    { Code: 12, CName: 'بدهکاران', GroupCode: 11, iType: 0 },
    { Code: 23, CName: 'بستانکاران', GroupCode: 21, iType: 0 },
    { Code: 60, CName: 'فروش', GroupCode: 41, iType: 1 },
    { Code: 62, CName: 'خريد', GroupCode: 11, iType: 1 },
  ];
  const moeen = [
    { KolCode: 10, Code: 1, CName: 'صندوق' },
    { KolCode: 10, Code: 2, CName: 'تنخواه گردانها' },
    { KolCode: 11, Code: 1, CName: 'بانک نمونه' },
    { KolCode: 11, Code: 2, CName: 'شاپرک' },
    { KolCode: 12, Code: 2, CName: 'مشتریان' },
    { KolCode: 23, Code: 1, CName: 'بستانکاران تجاري' },
    { KolCode: 60, Code: 1, CName: 'فروش' },
    { KolCode: 62, Code: 1, CName: 'خريد' },
  ];
  const tafsili = [
    { KolCode: 12, MoeenCode: 2, Code: 1, CName: 'شرکت نمونه سبز' },
    { KolCode: 12, MoeenCode: 2, Code: 2, CName: 'ماليات حقوق' },
    { KolCode: 23, MoeenCode: 1, Code: 1, CName: 'شرکت شیمیایی نمونه' },
  ];
  let id = 1;
  const row = (sanad, date, kolCode, moeenCode, taf, bed, bes, comment) => ({
    ID: id++, Sanad_Num: sanad, SanadDate: date, KolCode: kolCode, MoeenCode: moeenCode, TafsiliCode: taf,
    Comment: comment, Bed: bed, Bes: bes, SanadComment: null,
  });
  const document = [
    // فروش نسیه: مشتری بدهکار، فروش بستانکار.
    row(100, '1403/05/01', 12, 2, 1, 1100000, 0, 'فاکتور فروش'),
    row(100, '1403/05/01', 60, 1, 0, 0, 1100000, 'فاکتور فروش'),
    // وصول از مشتری در بانک رفاه.
    row(101, '1403/05/02', 11, 1, 0, 500000, 0, 'وصول از مشتری'),
    row(101, '1403/05/02', 12, 2, 1, 0, 500000, 'وصول از مشتری'),
    // خرید نسیه از تأمین‌کننده.
    row(102, '1403/05/03', 62, 1, 0, 300000, 0, 'خرید'),
    row(102, '1403/05/03', 23, 1, 1, 0, 300000, 'خرید'),
    // خرج از تنخواه.
    row(103, '1403/05/04', 62, 1, 0, 50000, 0, 'خرج تنخواه'),
    row(103, '1403/05/04', 10, 2, 0, 0, 50000, 'خرج تنخواه'),
    // وصول شاپرک بابت مالیات حقوق — تفصیلیِ حسابداری‌نما، شخص نیست.
    row(104, '1403/05/05', 11, 2, 0, 200000, 0, 'شاپرک'),
    row(104, '1403/05/05', 12, 2, 2, 0, 200000, 'ماليات حقوق'),
  ];
  const zeroAcc = { ID: 2, Cash_K: 0, Cash_M: 0, Cash_T: 0, Sell_K: 0, Sell_M: 0, Sell_T: 0, Wage_K: 0, Wage_M: 0, Wage_T: 0, Asset_K: 0, Asset_M: 0, Asset_T: 0 };
  const zeroVat = { ID: 6, VATSale_K: 0, VATSale_M: 0, VATSale_T: 0, VATBuy_K: 0, VATBuy_M: 0, VATBuy_T: 0 };
  return { tbl_ACCGroup: GROUPS, tbl_Kol: kol, tbl_Moeen: moeen, tbl_Tafsili: tafsili, tbl_Document: document, tbl_AccSetting: [zeroAcc], tbl_VATSetting: [zeroVat] };
}

const tempPathModule = await import('./helpers/tempPath.js');
const databasePath = tempPathModule.tempDatabase('parsian-phase-b');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'phaseb-owner';
process.env.ADMIN_PASSWORD = 'phaseb-strong-password-12345';
const database = await import(`../server/db.js?parsian-phase-b=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('phaseb-owner', 'phaseb-strong-password-12345');
const newWorkspace = (name) => database.createWorkspace(owner.id, { name, profileType: 'business' });
const inWorkspace = (workspace, callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

test.after(() => tempPathModule.removeTempDatabase(databasePath));

const { commitParsianBackup, previewParsianBackup } = await import(`../server/parsianImport.js?phaseb=${process.pid}`);
const { previewParsianPhaseB, commitParsianPhaseB } = await import(`../server/parsianPhaseB.js?phaseb=${process.pid}`);

/** جمع بدهکار/بستانکار هر معین کدینگ — سنجهٔ «فایل انتقال به پارسیان تغییر نمی‌کند». */
function chartSums(active) {
  return active.prepare(`SELECT chart_accounts.code,COALESCE(SUM(journal_lines.debit),0) AS debit,COALESCE(SUM(journal_lines.credit),0) AS credit
    FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
    JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    GROUP BY chart_accounts.id`).all();
}

test('دفتری که ورود پارسیان ندارد: فاز ب پیشنهاد نمی‌شود و ثبتش رد می‌شود', () => {
  const workspace = newWorkspace('خام بدون پارسیان');
  inWorkspace(workspace, () => {
    const active = database.activeWorkspaceDatabase();
    const preview = previewParsianPhaseB(active);
    assert.equal(preview.eligible, false);
    assert.throws(() => commitParsianPhaseB(active, { contactIds: [] }), (error) => error.code === 'PARSIAN_PHASEB_NO_IMPORT');
  });
});

test('پیش‌نمایش فاز ب: معین‌های پولی، بازاستفادهٔ صندوق و پیش‌انتخاب شخص‌ها', () => {
  const workspace = newWorkspace('پیش‌نمایش فاز ب');
  inWorkspace(workspace, () => {
    const active = database.activeWorkspaceDatabase();
    commitParsianBackup(active, buildParsianBackup(phaseBTables()), 'phaseb.bak', {
      createdBy: owner.id, amountUnit: 'toman', kolTypes: { 62: 'expense' },
    });
    const preview = previewParsianPhaseB(active);
    assert.equal(preview.eligible, true);
    assert.deepEqual(preview.money.map((moeen) => [moeen.code, moeen.kind]), [
      ['100001', 'cash'], ['100002', 'petty'], ['110001', 'bank'], ['110002', 'bank'],
    ]);
    const cash = preview.money.find((moeen) => moeen.code === '100001');
    assert.equal(cash.reuseExistingCash, true);
    assert.equal(cash.reuseExistingCashName, 'صندوق نقدی');
    assert.equal(preview.money.find((moeen) => moeen.code === '110001').balance, 500000);
    assert.equal(preview.money.find((moeen) => moeen.code === '110002').balance, 200000);
    assert.equal(preview.money.find((moeen) => moeen.code === '100002').balance, -50000);
    // تنخواه در این فیکسچر ماندهٔ منفی دارد (خرج بدون شارژ در همین سال)؛ صندوق تنخواه
    // با سقف حدسی ساخته نمی‌شود و پیامش می‌آید.
    assert.equal(preview.money.find((moeen) => moeen.code === '100002').fundPossible, false);
    // سه تفصیلی طرف حساب؛ مالیات حقوق شخص نیست.
    assert.equal(preview.contacts.length, 3);
    const byName = Object.fromEntries(preview.contacts.map((contact) => [contact.name, contact]));
    assert.equal(byName['شرکت نمونه سبز'].suggested, true);
    assert.equal(byName['شرکت شیمیایی نمونه'].suggested, true);
    assert.equal(byName['ماليات حقوق'].suggested, false);
    assert.deepEqual(byName['شرکت نمونه سبز'].sides, ['receivable']);
    assert.deepEqual(byName['شرکت شیمیایی نمونه'].sides, ['payable']);
    assert.equal(preview.suggestedContactIds.length, 2);
  });
});

test('ثبت فاز ب: کارت‌ها وصل می‌شوند، هیچ سندی تازه نمی‌آید و کدینگ ردیف‌ها عیناً می‌ماند', () => {
  const workspace = newWorkspace('ثبت فاز ب');
  inWorkspace(workspace, () => {
    const active = database.activeWorkspaceDatabase();
    commitParsianBackup(active, buildParsianBackup(phaseBTables()), 'phaseb.bak', {
      createdBy: owner.id, amountUnit: 'toman', kolTypes: { 62: 'expense' },
    });
    const sumsBefore = chartSums(active);
    const entriesBefore = active.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count;
    const linesBefore = active.prepare('SELECT COUNT(*) AS count FROM journal_lines').get().count;
    const preview = previewParsianPhaseB(active);

    const result = commitParsianPhaseB(active, { contactIds: preview.suggestedContactIds, createdBy: owner.id });
    // دو بانک تازه + صندوق پیش‌فرض؛ حساب دفتر کل هر سه معین به حساب عملیاتی‌اش وصل شد؛ تنخواهِ بی‌مانده ساخته نشد.
    assert.deepEqual([result.accounts.created, result.accounts.bound, result.petty], [2, 3, 0]);
    assert.equal(result.contacts.created, 2);
    assert.equal(result.analyticsLinked, 2);
    assert.equal(result.linesRepointed, 3);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.skipped.length, 1);
    assert.ok(result.skipped[0].includes('تنخواه'));
    // هیچ سند و ردیفی اضافه یا کم نشد.
    assert.equal(active.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count, entriesBefore);
    assert.equal(active.prepare('SELECT COUNT(*) AS count FROM journal_lines').get().count, linesBefore);
    // جمع هر معین عیناً همان است — فایل انتقال به پارسیان تغییر نمی‌کند.
    assert.deepEqual(chartSums(active), sumsBefore);

    // حساب‌های عملیاتی: صندوق پیش‌فرض + دو بانک (تنخواه ساخته نشد).
    const accounts = database.listAccounts();
    assert.deepEqual(accounts.map((account) => account.name).sort(), ['بانک نمونه', 'شاپرک', 'صندوق نقدی']);
    const refah = accounts.find((account) => account.name === 'بانک نمونه');
    const shaparak = accounts.find((account) => account.name === 'شاپرک');
    assert.equal(refah.kind, 'bank');
    // ماندهٔ فهرست حساب‌ها دید عملیاتی است (تراکنش و انتقال)؛ مرجع، کارت حساب است.
    assert.equal(database.moneyAccountCard(refah.id).totals.balance, 500000);
    assert.equal(database.moneyAccountCard(shaparak.id).totals.balance, 200000);
    assert.equal(active.prepare('SELECT COUNT(*) AS count FROM petty_cash_funds').get().count, 0);

    // حساب دفتر کلِ معین رفاه به حساب عملیاتی وصل شد و نگاشت کدینگش ماند.
    const refahLedger = active.prepare(`SELECT source_kind AS sk,source_key AS skey,chart_account_id AS chart
      FROM ledger_accounts WHERE id=(SELECT id FROM ledger_accounts WHERE chart_account_id=(SELECT id FROM chart_accounts WHERE code='110001') LIMIT 1)`).get();
    assert.equal(refahLedger.sk, 'operational-account');
    assert.equal(refahLedger.skey, refah.id);
    assert.ok(refahLedger.chart);

    // کارت بانک، گردش واردشده را نشان می‌دهد.
    const refahCard = database.moneyAccountCard(refah.id);
    assert.equal(refahCard.lines.length, 1);
    assert.equal(refahCard.totals.balance, 500000);
    assert.equal(database.moneyAccountCard(shaparak.id).totals.balance, 200000);

    // کارت طرف حساب: مشتری و تأمین‌کننده، از دفتر کل.
    const contacts = database.listContacts();
    assert.equal(contacts.length, 2);
    const customer = contacts.find((contact) => contact.name.includes('نمونه سبز'));
    const vendor = contacts.find((contact) => contact.name.includes('شیمیایی نمونه'));
    assert.equal(customer.kind, 'customer');
    assert.equal(vendor.kind, 'vendor');
    const customerCard = database.counterpartyCard(customer.id);
    assert.equal(customerCard.lines.length, 2);
    assert.equal(customerCard.totals.balance, 600000);
    assert.equal(database.counterpartyCard(vendor.id).totals.balance, -300000);

    // تفصیلی روی ردیف‌ها مانده و به شخص وصل شده؛ تفصیلی غیرشخصی همان معین مشترک را دارد.
    const repointed = active.prepare(`SELECT journal_lines.analytic_id AS analytic,ledger_accounts.source_kind AS sk
      FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE journal_lines.analytic_id=(SELECT id FROM analytic_accounts WHERE name='شرکت نمونه سبز')`).all();
    assert.equal(repointed.length, 2);
    assert.ok(repointed.every((line) => line.sk === 'customer-receivable'));
    const taxLine = active.prepare(`SELECT ledger_accounts.source_kind AS sk FROM journal_lines
      JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE journal_lines.analytic_id=(SELECT id FROM analytic_accounts WHERE name='ماليات حقوق')`).all();
    assert.ok(taxLine.every((line) => line.sk === 'chart-account'));
    const linkedAnalytic = active.prepare(`SELECT source_kind AS sk,source_key AS skey FROM analytic_accounts WHERE name='شرکت نمونه سبز'`).get();
    assert.equal(linkedAnalytic.sk, 'contact');
    assert.equal(linkedAnalytic.skey, customer.id);

    // تراز کلی دفتر هنوز برقرار است.
    const totals = active.prepare('SELECT COALESCE(SUM(debit),0) AS d,COALESCE(SUM(credit),0) AS c FROM journal_lines').get();
    assert.equal(totals.d, totals.c);
  });
});

test('اجرای دوبارهٔ فاز ب هیچ چیز را تکرار نمی‌سازد', () => {
  const workspace = newWorkspace('فاز ب دوباره');
  inWorkspace(workspace, () => {
    const active = database.activeWorkspaceDatabase();
    commitParsianBackup(active, buildParsianBackup(phaseBTables()), 'phaseb.bak', {
      createdBy: owner.id, amountUnit: 'toman', kolTypes: { 62: 'expense' },
    });
    const preview = previewParsianPhaseB(active);
    const first = commitParsianPhaseB(active, { contactIds: preview.suggestedContactIds, createdBy: owner.id });
    assert.equal(first.linesRepointed, 3);
    const accountsAfterFirst = active.prepare('SELECT COUNT(*) AS count FROM accounts').get().count;
    const contactsAfterFirst = active.prepare('SELECT COUNT(*) AS count FROM contacts').get().count;

    const again = commitParsianPhaseB(active, { contactIds: preview.suggestedContactIds, createdBy: owner.id });
    assert.equal(again.accounts.created, 0);
    assert.equal(again.accounts.existing, 3);
    assert.equal(again.contacts.created, 0);
    assert.equal(again.linesRepointed, 0);
    assert.equal(again.skipped.length, 3); // تنخواه بی‌مانده + دو تفصیلی که دیگر کاندید نیستند
    assert.equal(active.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, accountsAfterFirst);
    assert.equal(active.prepare('SELECT COUNT(*) AS count FROM contacts').get().count, contactsAfterFirst);
  });
});

test('تفصیلی‌های هم‌نام زیر کل ۱۲ و ۲۳ یک شخص می‌شوند و کارتش دو سمت را با هم می‌بیند', () => {
  const workspace = newWorkspace('هم‌نام فاز ب');
  inWorkspace(workspace, () => {
    const active = database.activeWorkspaceDatabase();
    // همان فیکسچر + یک نفر هم مشتری است هم فروشنده: «شرکت آريا» زیر ۱۲/۲ و ۲۳/۱.
    const tables = phaseBTables();
    tables.tbl_Tafsili.push({ KolCode: 12, MoeenCode: 2, Code: 3, CName: 'شرکت آريا' });
    tables.tbl_Tafsili.push({ KolCode: 23, MoeenCode: 1, Code: 7, CName: 'شرکت آريا' });
    let id = 900;
    tables.tbl_Document.push(
      { ID: id++, Sanad_Num: 200, SanadDate: '1403/06/01', KolCode: 12, MoeenCode: 2, TafsiliCode: 1, Comment: 'فروش', Bed: 400000, Bes: 0, SanadComment: null },
      { ID: id++, Sanad_Num: 200, SanadDate: '1403/06/01', KolCode: 60, MoeenCode: 1, TafsiliCode: 0, Comment: 'فروش', Bed: 0, Bes: 400000, SanadComment: null },
      { ID: id++, Sanad_Num: 201, SanadDate: '1403/06/02', KolCode: 12, MoeenCode: 2, TafsiliCode: 3, Comment: 'فروش به آريا', Bed: 700000, Bes: 0, SanadComment: null },
      { ID: id++, Sanad_Num: 201, SanadDate: '1403/06/02', KolCode: 60, MoeenCode: 1, TafsiliCode: 0, Comment: 'فروش به آريا', Bed: 0, Bes: 700000, SanadComment: null },
      { ID: id++, Sanad_Num: 202, SanadDate: '1403/06/03', KolCode: 23, MoeenCode: 1, TafsiliCode: 7, Comment: 'خرید از آريا', Bed: 0, Bes: 200000, SanadComment: null },
      { ID: id++, Sanad_Num: 202, SanadDate: '1403/06/03', KolCode: 62, MoeenCode: 1, TafsiliCode: 0, Comment: 'خرید از آريا', Bed: 200000, Bes: 0, SanadComment: null },
    );
    commitParsianBackup(active, buildParsianBackup(tables), 'dup.bak', {
      createdBy: owner.id, amountUnit: 'toman', kolTypes: { 62: 'expense' },
    });
    const preview = previewParsianPhaseB(active);
    // دو تفصیلی هم‌نام؛ پیش‌نمایش خبر می‌دهد.
    assert.ok(preview.warnings.some((item) => item.includes('هم‌نام')));
    const aria = preview.contacts.filter((contact) => contact.name === 'شرکت آريا');
    assert.equal(aria.length, 2);
    const ids = aria.map((contact) => contact.id);
    const result = commitParsianPhaseB(active, { contactIds: ids, createdBy: owner.id });
    // یک شخص، دو حساب (دریافتنی و پرداختنی)، دو ردیف جابه‌جا.
    assert.equal(result.contacts.created, 1);
    assert.equal(result.linesRepointed, 2);
    const contact = database.listContacts().find((item) => item.name === 'شرکت آريا');
    assert.equal(contact.kind, 'person');
    const card = database.counterpartyCard(contact.id);
    // کارت هر دو سمت را می‌بیند: ۷۰۰٬۰۰۰ دریافتنی منهای ۲۰۰٬۰۰۰ پرداختنی.
    assert.equal(card.totals.balance, 500000);
    assert.equal(card.accounts.length, 2);
    const kinds = card.accounts.map((account) => account.sourceKind).sort();
    assert.deepEqual(kinds, ['customer-receivable', 'vendor-payable']);
  });
});

// ---------------------------------------------------------------------------
// بکاپ واقعی (در صورت وجود) — فایل مشتری وارد Git نمی‌شود.
// ---------------------------------------------------------------------------

const realPath = process.env.PARSIAN_BAK_PATH || '/home/z/my-project/upload/db_111403.bak';
if (existsSync(realPath)) {
  test('بکاپ واقعی: فاز ب روی دفتر واردشده کار می‌کند و کارت‌ها با ماندهٔ درست باز می‌شوند', async () => {
    const workspace = newWorkspace('فاز ب بکاپ واقعی');
    inWorkspace(workspace, () => {
      const active = database.activeWorkspaceDatabase();
      const buffer = readFileSync(realPath);
      // نوع کل‌های مبهم را از پیشنهاد خود پیش‌نمایش می‌گیریم تا ثبت کامل شود.
      const peek = previewParsianBackup(active, buffer, 'db_111403.bak', { amountUnit: 'toman' });
      // کل‌های انتظامی (۶۴/۶۵) پیشنهاد خودکار ندارند؛ هزینه — همان قرارداد کدینگ ایرانی.
      const kolTypes = Object.fromEntries(peek.kolTypeChoices
        .map((choice) => [choice.code, choice.suggestion || (Number(choice.code) === 64 || Number(choice.code) === 65 ? 'expense' : '')])
        .filter(([, type]) => type));
      const imported = commitParsianBackup(active, buffer, 'db_111403.bak', {
        createdBy: owner.id, amountUnit: 'toman', kolTypes,
      });
      assert.ok(imported.journals.entries > 0);

      const preview = previewParsianPhaseB(active);
      assert.equal(preview.eligible, true);
      assert.deepEqual(preview.money.map((moeen) => [moeen.code, moeen.kind]), [
        ['100001', 'cash'], ['100002', 'petty'], ['110001', 'bank'], ['110002', 'bank'],
      ]);
      const bankName = (code) => preview.money.find((moeen) => moeen.code === code).name;
      // تفصیلی‌های شخص‌نما از پیش‌انتخاب کنار مانده‌اند.
      const notSuggested = preview.contacts.filter((contact) => !contact.suggested).map((contact) => contact.name);
      for (const name of ['ارزش افزوده خريد', 'تهاتر', 'مشتريان پوز', 'حقوق پرداختني پرسنل', 'ماليات حقوق']) {
        assert.ok(notSuggested.includes(name), `${name} باید شخص‌پذیر نباشد`);
      }
      assert.ok(preview.suggestedContactIds.length >= 20);

      const sumsBefore = chartSums(active);
      const entriesBefore = active.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count;

      const result = commitParsianPhaseB(active, { contactIds: preview.suggestedContactIds, createdBy: owner.id });
      // تنخواه این بکاپ مانده و گردشی ندارد؛ پیامش باید آمده باشد.
      assert.ok(result.skipped.some((item) => item.includes('تنخواه')));
      assert.equal(result.petty, 0);
      // همهٔ ردیف‌های تفصیلی‌های انتخاب‌شده که روی معینِ دریافتنی/پرداختنی‌اند جابه‌جا شدند.
      const expectedLines = active.prepare(`SELECT COUNT(*) AS count FROM journal_lines
        WHERE analytic_id IN (${preview.suggestedContactIds.map(() => '?').join(',') || 'NULL'})`).get(...preview.suggestedContactIds).count;
      assert.equal(result.linesRepointed, expectedLines);
      assert.equal(result.contacts.created, preview.suggestedContactIds.length);
      assert.equal(active.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count, entriesBefore);
      assert.deepEqual(chartSums(active), sumsBefore);

      // کارت بانک رفاه و شاپرک با ماندهٔ خودشان — از خود دفتر کل حساب می‌کنیم تا
      // مستقل از اینکه کدام سندها واجد شرایط ورود بوده‌اند.
      const bankNet = (code) => Number(active.prepare(`SELECT COALESCE(SUM(journal_lines.debit)-SUM(journal_lines.credit),0) AS net
        FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
        JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id WHERE chart_accounts.code=?`).get(code).net);
      const accounts = database.listAccounts();
      const refah = accounts.find((account) => account.name === bankName('110001'));
      const shaparak = accounts.find((account) => account.name === bankName('110002'));
      assert.notEqual(bankNet('110001'), 0, 'بانک رفاه باید گردش واردشده داشته باشد');
      assert.equal(database.moneyAccountCard(refah.id).totals.balance, bankNet('110001'));
      assert.equal(database.moneyAccountCard(shaparak.id).totals.balance, bankNet('110002'));

      // کارت پرگردش‌ترین شخص با ماندهٔ دفتر کل یکی است (نام مشتری در مخزن عمومی نمی‌آید).
      const busiest = active.prepare(`SELECT analytic_id AS id,COUNT(*) AS n FROM journal_lines JOIN analytic_accounts ON analytic_accounts.id=journal_lines.analytic_id
        WHERE analytic_accounts.source_kind='contact' GROUP BY analytic_id ORDER BY n DESC LIMIT 1`).get();
      const contact = { id: active.prepare('SELECT source_key AS id FROM analytic_accounts WHERE id=?').get(busiest.id).id };
      const expected = active.prepare(`SELECT COALESCE(SUM(journal_lines.debit)-SUM(journal_lines.credit),0) AS net FROM journal_lines
        WHERE analytic_id=?`).get(busiest.id).net;
      assert.equal(database.counterpartyCard(contact.id).totals.balance, Number(expected));

      // اجرای دوباره: هیچ تکراری.
      const again = commitParsianPhaseB(active, { contactIds: preview.suggestedContactIds, createdBy: owner.id });
      assert.equal(again.accounts.created, 0);
      assert.equal(again.contacts.created, 0);
      assert.equal(again.linesRepointed, 0);
    });
  });
} else {
  test('بکاپ واقعی در دسترس نیست؛ آزمون فاز ب روی آن رد شد', { skip: true }, () => {});
}
