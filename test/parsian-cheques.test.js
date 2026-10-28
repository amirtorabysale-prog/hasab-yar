// چک‌های بکاپ پارسیان در دفتر چک — شکل بکاپ اتیه سازان (۷ آبان ۱۴۰۵)، با عددهای ساختگی.
//
// خانوادهٔ رویداد:
//   دریافتی: در جریان، وصول‌شده، واگذارشده به تأمین‌کننده، برگشتی؛ پرداختی: در جریان، پاس‌شده؛
//   کد ناشناخته (۲۵) و کد شناخته‌شده‌ای که با «فعال» نمی‌خواند ← نیازمند بررسی، نه در جریان؛
//   شمارهٔ سندی که مال سال دیگر است (تاریخ نمی‌خواند) ← بی‌پیوند؛ نوع ناشناخته ← رد با هشدار؛
//   هیچ سند تازه‌ای در ورود؛ وصول و برگشت چک در جریان در حساب‌یار همان حساب پارسیان را
//   می‌بندد؛ ابطال چک پارسیان رد می‌شود؛ اجرای دوباره چیزی نمی‌سازد؛ شخص بعد از فاز ب؛
//   کنترل جمع چک‌های در جریان با ماندهٔ اسناد دریافتنی و پرداختنی؛ جدول چک قدیمی.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParsianBackup } from './helpers/parsianBakFixture.js';

const tempPathModule = await import('./helpers/tempPath.js');
const databasePath = tempPathModule.tempDatabase('parsian-cheques');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'cheques-owner';
process.env.ADMIN_PASSWORD = 'cheques-strong-password-12345';
const database = await import(`../server/db.js?parsian-cheques=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('cheques-owner', 'cheques-strong-password-12345');
const newWorkspace = (name) => database.createWorkspace(owner.id, { name, profileType: 'business' });
const inWorkspace = (workspace, callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
test.after(() => tempPathModule.removeTempDatabase(databasePath));

const { commitParsianBackup } = await import(`../server/parsianImport.js?cheques=${process.pid}`);
const { commitParsianPhaseB, previewParsianPhaseB } = await import(`../server/parsianPhaseB.js?cheques=${process.pid}`);
const { importParsianCheques, chequeLedgerControls } = await import(`../server/parsianCheques.js?cheques=${process.pid}`);
const { parseParsianBackup } = await import(`../server/parsianBackup.js?cheques=${process.pid}`);

const GROUPS = [
  { Code: 11, CName: 'دارايي هاي جاري' }, { Code: 21, CName: 'بدهي هاي جاري' },
  { Code: 41, CName: 'فروش و درآمدها' }, { Code: 61, CName: 'هزينه هاي فعاليت' },
];

function chequeTables() {
  const kol = [
    { Code: 10, CName: 'موجودي نقد و بانک', GroupCode: 11, iType: 0 },
    { Code: 12, CName: 'حسابهاي دريافتني', GroupCode: 11, iType: 0 },
    { Code: 13, CName: 'ساير حسابها و اسناد دريافتني', GroupCode: 11, iType: 0 },
    { Code: 22, CName: 'حسابهاي پرداختي', GroupCode: 21, iType: 0 },
    { Code: 60, CName: 'فروش', GroupCode: 41, iType: 1 },
    { Code: 62, CName: 'خريد', GroupCode: 61, iType: 1 },
  ];
  const moeen = [
    { KolCode: 10, Code: 3, CName: 'بانک ها' }, { KolCode: 12, Code: 2, CName: 'بدهکاران تجاري' },
    { KolCode: 13, Code: 1, CName: 'اسناد دريافتني' }, { KolCode: 22, Code: 1, CName: 'اسناد پرداختني' },
    { KolCode: 22, Code: 15, CName: 'بستانکاران تجاري' }, { KolCode: 60, Code: 1, CName: 'فروش' }, { KolCode: 62, Code: 1, CName: 'خريد' },
  ];
  const tafsili = [
    { KolCode: 10, MoeenCode: 3, Code: 1, CName: 'بانک ملت 111' },
    { KolCode: 12, MoeenCode: 2, Code: 1, CName: 'شرکت نمونه سبز' },
    { KolCode: 22, MoeenCode: 15, Code: 1, CName: 'تامين کننده آبي' },
  ];
  let id = 1;
  const row = (sanad, date, kolCode, moeenCode, taf, bed, bes) => ({
    ID: id++, Sanad_Num: sanad, SanadDate: date, KolCode: kolCode, MoeenCode: moeenCode, TafsiliCode: taf,
    Comment: 'آزمون', Bed: bed, Bes: bes, SanadComment: null,
  });
  const document = [
    row(1, '1403/05/01', 12, 2, 1, 1000, 0), row(1, '1403/05/01', 60, 1, 0, 0, 1000),
    // دریافت پنج چک از مشتری: اسناد دریافتنی بدهکار، مشتری بستانکار.
    row(2, '1403/06/01', 13, 1, 0, 530, 0), row(2, '1403/06/01', 12, 2, 1, 0, 530),
    row(3, '1403/07/01', 10, 3, 1, 200, 0), row(3, '1403/07/01', 13, 1, 0, 0, 200), // وصول
    row(4, '1403/07/05', 22, 15, 1, 150, 0), row(4, '1403/07/05', 13, 1, 0, 0, 150), // واگذاری به تأمین‌کننده
    row(5, '1403/07/10', 12, 2, 1, 50, 0), row(5, '1403/07/10', 13, 1, 0, 0, 50), // برگشت
    row(6, '1403/05/02', 62, 1, 0, 500, 0), row(6, '1403/05/02', 22, 15, 1, 0, 500), // خرید نسیه
    row(7, '1403/06/02', 22, 15, 1, 300, 0), row(7, '1403/06/02', 22, 1, 0, 0, 300), // دو چک پرداختی
    row(8, '1403/08/01', 22, 1, 0, 200, 0), row(8, '1403/08/01', 10, 3, 1, 0, 200), // پاس
  ];
  let chequeId = 100;
  const cheque = (values) => ({
    ID: chequeId++, Chk_Num: 500000 + chequeId, Sanad_Num: 0, Sanad_Num_VosolPas: 0, ExpDate: '1403/06/01', RecDate: '1404/02/01', Giv_Date: null,
    Money: 0, Bank_K: 0, Bank_M: 0, Bank_T: 0, Acc_K: 12, Acc_M: 2, Acc_T: 1, Taraf_K: 13, Taraf_M: 1, Taraf_T: 0, Chk_Kind: 0,
    Comment: '', Bank: 'تجارت', Vos_Pas: 0, IsActive: false, Tick: false, Lashe: false, IsREG: false, Sayad: '', ...values,
  });
  const tbl_Check = [
    cheque({ Money: 100, Sanad_Num: 2, Vos_Pas: 0, IsActive: true, Sayad: '1234567890123456' }),
    cheque({ Money: 200, Sanad_Num: 2, Vos_Pas: 2, Sanad_Num_VosolPas: 3, Giv_Date: '1403/07/01' }),
    cheque({ Money: 150, Sanad_Num: 2, Vos_Pas: 3, Sanad_Num_VosolPas: 4, Giv_Date: '1403/07/05', Bank_K: 22, Bank_M: 15, Bank_T: 1 }),
    cheque({ Money: 50, Sanad_Num: 2, Vos_Pas: 5, Sanad_Num_VosolPas: 5, Giv_Date: '1403/07/10' }),
    // کد ۲۵: غیرفعال و بی‌سند تسویه. معنایش معلوم نیست.
    cheque({ Money: 30, Sanad_Num: 2, Vos_Pas: 25, Sanad_Num_VosolPas: -1 }),
    // کد «در جریان» ولی غیرفعال: با هم نمی‌خوانند.
    cheque({ Money: 70, Sanad_Num: 0, Vos_Pas: 0, IsActive: false, ExpDate: '1403/06/03' }),
    // چک سال قبل: شمارهٔ ۲ در این بکاپ سند دیگری است (تاریخ نمی‌خواند).
    cheque({ Money: 40, Sanad_Num: 2, ExpDate: '1402/11/01', Vos_Pas: 2, Sanad_Num_VosolPas: 3, Giv_Date: '1403/07/01' }),
    // نوع ناشناخته.
    cheque({ Money: 10, Chk_Kind: 2 }),
    // پرداختی‌ها: صاحب تأمین‌کننده، حساب اسناد پرداختنی.
    cheque({ Chk_Kind: 1, Money: 200, Sanad_Num: 7, ExpDate: '1403/06/02', Vos_Pas: 7, Sanad_Num_VosolPas: 8, Giv_Date: '1403/08/01', Acc_K: 22, Acc_M: 15, Acc_T: 1, Taraf_K: 22, Taraf_M: 1, Bank: 'بانک ملت 111' }),
    cheque({ Chk_Kind: 1, Money: 100, Sanad_Num: 7, ExpDate: '1403/06/02', Vos_Pas: 0, IsActive: true, Acc_K: 22, Acc_M: 15, Acc_T: 1, Taraf_K: 22, Taraf_M: 1, Bank: 'بانک ملت 111' }),
  ];
  const zeroAcc = { ID: 2, Cash_K: 0, Cash_M: 0, Cash_T: 0, Sell_K: 0, Sell_M: 0, Sell_T: 0, Wage_K: 0, Wage_M: 0, Wage_T: 0, Asset_K: 0, Asset_M: 0, Asset_T: 0 };
  const zeroVat = { ID: 6, VATSale_K: 0, VATSale_M: 0, VATSale_T: 0, VATBuy_K: 0, VATBuy_M: 0, VATBuy_T: 0 };
  return { tbl_ACCGroup: GROUPS, tbl_Kol: kol, tbl_Moeen: moeen, tbl_Tafsili: tafsili, tbl_Document: document, tbl_Check, tbl_AccSetting: [zeroAcc], tbl_VATSetting: [zeroVat] };
}

const KOL_TYPES = { 62: 'expense', 13: 'asset', 22: 'liability' };
// کلید: «r» دریافتی و «p» پرداختی، به‌اضافهٔ مبلغ (مبلغ‌ها در هر سمت یکتایند).
const byAmount = (active) => new Map(active.prepare('SELECT * FROM cheques').all().map((row) => [`${row.direction[0]}${row.amount}`, row]));

test('پارسر: tbl_Check با بیت «فعال» و تاریخ‌ها خوانده می‌شود', () => {
  const parsed = parseParsianBackup(buildParsianBackup(chequeTables()), { fileName: 'cheques.bak' });
  assert.equal(parsed.extras.cheques.length, 10);
  const open = parsed.extras.cheques.find((row) => row.money === 100);
  assert.deepEqual([open.kind, open.status, open.active, open.registeredDate, open.dueDate, open.sayad], [0, 0, true, '1403/06/01', '1404/02/01', '1234567890123456']);
});

test('ورود چک‌ها: هر وضعیت درست، بی‌هیچ سند تازه، پیوند به سند خودش فقط وقتی تاریخ می‌خواند', () => {
  inWorkspace(newWorkspace('چک پارسیان'), () => {
    const active = database.activeWorkspaceDatabase();
    const result = commitParsianBackup(active, buildParsianBackup(chequeTables()), 'cheques.bak', { createdBy: owner.id, amountUnit: 'toman', kolTypes: KOL_TYPES });
    // هشت سند پارسیان، هیچ سند دیگری.
    assert.equal(active.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n, 8);
    assert.equal(result.cheques.imported, 9);
    assert.equal(result.cheques.skipped, 1);
    assert.ok(result.cheques.warnings.some((text) => /نوع ناشناخته \(2\)/.test(text)), result.cheques.warnings.join());

    const cheques = byAmount(active);
    const entryOf = (sanad) => active.prepare('SELECT entry_id AS id FROM parsian_imported_entries WHERE sanad=?').get(sanad).id;
    assert.deepEqual([cheques.get('r100').status, cheques.get('r100').direction, cheques.get('r100').sayad, cheques.get('r100').counterparty_name], ['open', 'receivable', '1234567890123456', 'شرکت نمونه سبز']);
    assert.equal(cheques.get('r100').journal_entry_id, entryOf(2));
    assert.deepEqual([cheques.get('r200').status, cheques.get('r200').settled_entry_id], ['cleared', entryOf(3)]);
    assert.deepEqual([cheques.get('r150').status, cheques.get('r150').transferred_to, cheques.get('r150').settled_entry_id], ['transferred', 'تامين کننده آبي', entryOf(4)]);
    assert.equal(cheques.get('r50').status, 'bounced');
    assert.equal(cheques.get('r30').status, 'review');
    assert.match(cheques.get('r30').review_reason, /کد 25.*سند وصول، پاس یا واگذاری ندارد/);
    assert.equal(cheques.get('r70').status, 'review', 'در جریان ولی غیرفعال: حدس نه');
    // چک سال قبل: سند ثبتش در این بکاپ نیست؛ شمارهٔ ۲ این بکاپ پیوند نمی‌خورد.
    assert.equal(cheques.get('r40').journal_entry_id, null);
    assert.equal(cheques.get('r40').status, 'cleared');
    assert.deepEqual([cheques.get('r200').due_at !== null, cheques.get('r100').note_account_id !== null], [true, true]);

    // کنترل: اسناد دریافتنی ۱۳۰ = ۱۰۰ چک در جریان + ۳۰ چکِ کد ۲۵ که سند ندارد. اختلاف گفته می‌شود.
    const controls = new Map(result.cheques.controls.map((control) => [control.direction, control]));
    assert.deepEqual([controls.get('receivable').open, controls.get('receivable').balance, controls.get('receivable').difference], [100, 130, 30]);
    assert.deepEqual([controls.get('payable').open, controls.get('payable').balance, controls.get('payable').difference], [100, 100, 0]);
    assert.ok(result.cheques.warnings.some((text) => /اختلاف 30/.test(text)), result.cheques.warnings.join());

    // اجرای دوباره هیچ چیز را تکرار نمی‌سازد.
    const parsed = parseParsianBackup(buildParsianBackup(chequeTables()), { fileName: 'cheques.bak' });
    const analyticIdByKey = new Map(active.prepare("SELECT source_key AS key,id FROM analytic_accounts WHERE source_kind='parsian-tafsili'").all().map((row) => [row.key, row.id]));
    const again = importParsianCheques(active, parsed, { fileUnit: 'toman', ledgerUnit: 'toman', analyticIdByKey });
    assert.deepEqual([again.imported, again.existing], [0, 9]);
    assert.equal(active.prepare('SELECT COUNT(*) AS n FROM cheques').get().n, 9);

    // چکِ پارسیان ابطال نمی‌شود؛ سند ثبتش در بکاپ است.
    assert.throws(() => database.cancelCheque(cheques.get('r100').id, { reason: 'آزمون' }), { code: 'CHEQUE_FROM_PARSIAN' });
    const summary = database.chequeSummary();
    assert.deepEqual([summary.openReceivable.total, summary.openPayable.total, summary.review.count], [100, 100, 2]);
  });
});

test('وصول و برگشت چکِ در جریانِ پارسیان در حساب‌یار، همان حساب‌های پارسیان را می‌بندد؛ شخص بعد از فاز ب', () => {
  inWorkspace(newWorkspace('چک پارسیان وصول'), () => {
    const active = database.activeWorkspaceDatabase();
    commitParsianBackup(active, buildParsianBackup(chequeTables()), 'cheques.bak', { createdBy: owner.id, amountUnit: 'toman', kolTypes: KOL_TYPES });
    const phase = commitParsianPhaseB(active, { contactIds: previewParsianPhaseB(active).suggestedContactIds, createdBy: owner.id });
    assert.equal(phase.chequesLinked, 9, 'هر چک به صاحبش وصل شد؛ تأمین‌کنندهٔ کل ۲۲ هم شخص است');
    const cheques = byAmount(active);
    assert.ok(cheques.get('r100').contact_id);

    const chartNet = (code) => Number(active.prepare(`SELECT COALESCE(SUM(jl.debit)-SUM(jl.credit),0) AS net FROM journal_lines jl
      JOIN ledger_accounts la ON la.id=jl.account_id JOIN chart_accounts ca ON ca.id=la.chart_account_id WHERE ca.code=?`).get(code).net);
    database.clearCheque(cheques.get('r100').id, { account: 'cash', occurredAt: new Date().toISOString() });
    // اسناد دریافتنی پارسیان (۱۳-۱) فقط ۳۰ِ کد ۲۵ را نگه می‌دارد؛ هیچ حساب چکِ دیگری ساخته نشد.
    assert.equal(chartNet('130001'), 30);
    assert.equal(active.prepare("SELECT COUNT(*) AS n FROM ledger_accounts WHERE source_kind IN ('cheque-receivable','cheque-payable')").get().n, 0);

    // برگشت چک پرداختیِ در جریان: اسناد پرداختنی (۲۲-۱) بسته و بدهی به همان تأمین‌کننده، روی حساب خودش با تفصیلی‌اش.
    const bounced = database.bounceCheque(cheques.get('p100').id, { occurredAt: new Date().toISOString() });
    assert.equal(bounced.status, 'bounced');
    assert.equal(chartNet('220001'), 0);
    const lines = active.prepare(`SELECT ca.code,jl.debit,jl.credit,jl.analytic_id AS analyticId FROM journal_lines jl
      JOIN ledger_accounts la ON la.id=jl.account_id JOIN chart_accounts ca ON ca.id=la.chart_account_id WHERE jl.entry_id=? ORDER BY ca.code`).all(bounced.settledEntryId).map((row) => ({ ...row }));
    const supplier = active.prepare("SELECT id FROM analytic_accounts WHERE name='تامين کننده آبي'").get().id;
    assert.deepEqual(lines, [{ code: '220001', debit: 100, credit: 0, analyticId: supplier }, { code: '220015', debit: 0, credit: 100, analyticId: supplier }]);
    // بدهی تأمین‌کننده: خرید ۵۰۰، منهای چک‌ها ۳۰۰ و چک واگذاری ۱۵۰، به‌اضافهٔ برگشت ۱۰۰.
    assert.equal(chartNet('220015'), -(500 - 300 - 150 + 100));
  });
});

test('جدول چکِ دفتر قدیمی: ردیف‌ها می‌مانند و وضعیت تازه پذیرفته می‌شود', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { ensureChequeSchema } = await import(`../server/db/cheques.js?legacy=${process.pid}`);
  const legacy = new DatabaseSync(':memory:');
  legacy.exec(`CREATE TABLE cheques (id TEXT PRIMARY KEY, direction TEXT NOT NULL CHECK(direction IN ('receivable','payable')),
    contact_id TEXT, counterparty_name TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL CHECK(amount > 0), due_at TEXT, occurred_at TEXT NOT NULL,
    serial TEXT NOT NULL DEFAULT '', bank_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','cleared','bounced','cancelled')),
    against TEXT NOT NULL DEFAULT 'income' CHECK(against IN ('income','receivable')), obligation_id TEXT, analytic_id TEXT,
    note TEXT NOT NULL DEFAULT '', journal_entry_id TEXT, settled_entry_id TEXT, settled_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  legacy.prepare("INSERT INTO cheques (id,direction,counterparty_name,amount,occurred_at,status) VALUES ('old','receivable','قدیمی',5,'2024-01-01','cleared')").run();
  assert.throws(() => legacy.prepare("UPDATE cheques SET status='transferred'").run());
  ensureChequeSchema(legacy);
  ensureChequeSchema(legacy);
  assert.deepEqual({ ...legacy.prepare("SELECT id,amount,status,source FROM cheques").get() }, { id: 'old', amount: 5, status: 'cleared', source: '' });
  legacy.prepare("UPDATE cheques SET status='transferred' WHERE id='old'").run();
  assert.throws(() => legacy.prepare("UPDATE cheques SET status='lost' WHERE id='old'").run());
  assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='cheques_before_statuses'").get().n, 0);
  legacy.close();
});
