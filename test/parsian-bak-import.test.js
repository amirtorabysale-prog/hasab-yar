// آزمون ورود بکاپ پارسیان — پارسر بومی MTF/SQL Server 2000 + جریان دفتر خام.
//
// دو لایه:
//  ۱) فیکسچر سینتتیک: یک بکاپ کوچک با ساختار واقعی (کانتینر MTF، صفحات دادهٔ
//     SQL Server 2000، ستون حذف‌شدهٔ tbl_Document) ساخته می‌شود تا پارسر به
//     هیچ فایل مشتری وابسته نباشد.
//  ۲) اگر بکاپ واقعی از طریق PARSIAN_BAK_PATH در دسترس باشد، سنجه‌های رمزگشایی
//     همان فایل هم راستی‌آزمایی می‌شود (فایل مشتری هرگز وارد Git نمی‌شود).
//
// قاعدهٔ ثابت: اسناد نامتوازن وارد نمی‌شوند و در پیش‌نمایش با هشدار می‌آیند؛
// ثبت دوم در همان دفتر باید رد شود (فقط دفتر خام).

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// فیکسچر سینتتیک بکاپ
// ---------------------------------------------------------------------------

function utf16le(text) { return Buffer.from(text, 'utf16le'); }

// ردیف جدول‌های کدینگ: [30 00 39 00][اعداد ثابت][پرکننده][شمارندهٔ متغیر=۱ در k-2][انتها در k][متن از k+2]
function chartRow(fixedBytes, name, k) {
  const nameBytes = utf16le(name);
  const head = Buffer.from([0x30, 0x00, 0x39, 0x00]);
  const fixed = Buffer.from(fixedBytes);
  const meta = Buffer.alloc(k - 6 - fixedBytes.length);
  const varCount = Buffer.alloc(2); varCount.writeUInt16LE(1, 0);
  const rowLength = k + 2 + nameBytes.length;
  const endOffset = Buffer.alloc(2); endOffset.writeUInt16LE(rowLength, 0);
  return Buffer.concat([head, fixed, meta, varCount, endOffset, nameBytes]);
}

// کل: کد i16 در ۴، دو بایت پرکننده در ۶-۷، شمارنده در ۸، انتها در ۱۰.
const kolRow = (code, name) => chartRow([
  code & 0xff, (code >> 8) & 0xff, 0, 0,
], name, 10);

const moeenRow = (kol, code, name) => chartRow([
  kol & 0xff, (kol >> 8) & 0xff, code & 0xff, (code >> 8) & 0xff,
], name, 10);

const tafsiliRow = (kol, moeen, code, name) => {
  const fixed = Buffer.alloc(8);
  fixed.writeInt16LE(kol, 0); fixed.writeInt16LE(moeen, 2); fixed.writeInt32LE(code, 4);
  return chartRow([...fixed], name, 14);
};

// ردیف سند با چیدمان واقعی tbl_Document: ستون حذف‌شده در ۴، ستون‌های واقعی
// از ۸، و ناحیهٔ نقشهٔ تهی تا ۶۲؛ شمارندهٔ متغیر=۲ در ۶۲، دو انتها در ۶۴/۶۶،
// متن‌ها از ۶۸ — دقیقاً مثل ردیف واقعی فایل نمونه (۸۸ و ۱۱۴).
function documentRow({ seq, sanad, kol, moeen, taf, bed, bes, date, comment }) {
  const fixed = Buffer.alloc(62);
  fixed[0] = 0x30; fixed[1] = 0x00; fixed[2] = 0x39; fixed[3] = 0x00; // بایت وضعیت ردیف واقعی SQL Server
  fixed.writeInt32LE(seq, 4);
  fixed.writeInt32LE(sanad, 8);
  fixed.writeInt16LE(kol, 12);
  fixed.writeInt16LE(moeen, 14);
  fixed.writeInt32LE(taf, 16);
  fixed.writeDoubleLE(bed, 20);
  fixed.writeDoubleLE(bes, 28);
  const dateBytes = utf16le(date);
  const commentBytes = utf16le(comment);
  const varCount = Buffer.alloc(2); varCount.writeUInt16LE(2, 0);
  const end1 = Buffer.alloc(2); end1.writeUInt16LE(68 + dateBytes.length, 0);
  const rowLength = 68 + dateBytes.length + commentBytes.length;
  const end2 = Buffer.alloc(2); end2.writeUInt16LE(rowLength, 0);
  return Buffer.concat([fixed, varCount, end1, end2, dateBytes, commentBytes]);
}

// صفحهٔ دادهٔ SQL Server 2000: نوع ۰x01، ObjectId در ۰x18، ردیف‌ها از ۹۶.
function dataPage(objectId, rows) {
  const page = Buffer.alloc(8192);
  page[0] = 0x01; page[1] = 0x01;
  page.writeUInt32LE(objectId, 0x18);
  let offset = 96;
  for (const row of rows) { row.copy(page, offset); offset += row.length; }
  return page;
}

// ردیف sysobjects: امضای ۰x0030، شناسهٔ شیء در ۴، لنگرِ 'U ' در ۸، نام متغیر.
function sysObjectRow(objectId, name) {
  const row = Buffer.alloc(80);
  row[0] = 0x30; row[1] = 0x00;
  row.writeUInt16LE(42, 2);
  row.writeUInt32LE(objectId, 4);
  Buffer.from([0x55, 0x20, 0x00, 0x00]).copy(row, 8); // xtype 'U '
  row.writeUInt16LE(1, 48);
  const endOffset = 52 + utf16le(name).length;
  row.writeUInt16LE(endOffset, 50);
  utf16le(name).copy(row, 52);
  return row;
}

function buildFixtureBackup() {
  const KOL = 10001, MOEEN = 10002, TAFSILI = 10003, DOCUMENT = 10004;
  const header = Buffer.concat([
    Buffer.from('TAPE', 'ascii'),
    sysObjectRow(KOL, 'tbl_Kol'),
    sysObjectRow(MOEEN, 'tbl_Moeen'),
    sysObjectRow(TAFSILI, 'tbl_Tafsili'),
    sysObjectRow(DOCUMENT, 'tbl_Document'),
  ]);
  const kolPage = dataPage(KOL, [
    kolRow(10, 'صندوق'), kolRow(12, 'بدهکاران'), kolRow(23, 'بستانکاران'), kolRow(60, 'فروش'),
  ]);
  const moeenPage = dataPage(MOEEN, [
    moeenRow(10, 1, 'صندوق'), moeenRow(12, 2, 'مشتریان'), moeenRow(23, 4, 'پرداختنی متفرقه'), moeenRow(60, 1, 'فروش'),
  ]);
  const tafsiliPage = dataPage(TAFSILI, [
    tafsiliRow(12, 2, 4, 'شرکت طلايي سبز گستر'), tafsiliRow(12, 2, 5, 'شرکت بهاران بام پايدار'),
    tafsiliRow(23, 4, 1, 'بیمه سامان'), tafsiliRow(23, 4, 2, 'تامین اجتماعی'),
  ]);
  // سند ۱۲ متوازن: فروش + ارزش افزودهٔ ۱۰٪. سند ۱۳ نامتوازن. یک ردیف صفر و
  // یک ردیف تکراری دقیق هم داخل سند متوازن گذاشته می‌شود.
  const docPage = dataPage(DOCUMENT, [
    documentRow({ seq: 1, sanad: 12, kol: 12, moeen: 2, taf: 4, bed: 1172600000, bes: 0, date: '1403/03/08', comment: 'فاکتور فروش 1' }),
    documentRow({ seq: 2, sanad: 12, kol: 60, moeen: 1, taf: 0, bed: 0, bes: 1066000000, date: '1403/03/08', comment: 'فاکتور فروش 1 شرکت طلايي سبز گستر' }),
    documentRow({ seq: 3, sanad: 12, kol: 23, moeen: 4, taf: 1, bed: 0, bes: 106600000, date: '1403/03/08', comment: 'ماليات بر ارزش افزوده فروش فاكتور 1' }),
    documentRow({ seq: 3, sanad: 12, kol: 23, moeen: 4, taf: 1, bed: 0, bes: 106600000, date: '1403/03/08', comment: 'ماليات بر ارزش افزوده فروش فاكتور 1' }),
    documentRow({ seq: 6, sanad: 13, kol: 10, moeen: 1, taf: 0, bed: 500000, bes: 0, date: '1403/03/09', comment: 'سند ناقص' }),
  ]);
  const pad = (size) => Buffer.alloc(size);
  return Buffer.concat([header, pad(0x1200 - header.length), kolPage, moeenPage, tafsiliPage, docPage]);
}

// ---------------------------------------------------------------------------
// لایهٔ دادهٔ دفتر
// ---------------------------------------------------------------------------

const tempPathModule = await import('./helpers/tempPath.js');
const databasePath = tempPathModule.tempDatabase('parsian-bak');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'parsian-owner';
process.env.ADMIN_PASSWORD = 'parsian-strong-password-12345';
const database = await import(`../server/db.js?parsian-bak=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('parsian-owner', 'parsian-strong-password-12345');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر خام پارسیان', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

test.after(() => tempPathModule.removeTempDatabase(databasePath));

const { parseParsianBackup } = await import('../server/parsianBackup.js');
const { previewParsianBackup, commitParsianBackup, buildParsianImportPlan, internalMoeenCode } = await import(`../server/parsianImport.js?fixture=${process.pid}`);

test('فیکسچر سینتتیک: کدینگ و سند متوازن درست رمزگشایی می‌شود', () => {
  const parsed = parseParsianBackup(buildFixtureBackup(), { fileName: 'fixture.bak' });
  assert.equal(parsed.chart.kol.length, 4);
  assert.equal(parsed.chart.moeen.length, 4);
  assert.equal(parsed.chart.tafsili.length, 4);
  assert.equal(parsed.documents.vouchers.length, 2);
  const voucher = parsed.documents.vouchers.find((item) => item.sanad === 12);
  assert.ok(voucher.balanced);
  assert.equal(voucher.bedTotal, 1172600000);
  assert.equal(voucher.besTotal, 1172600000);
});

test('کد داخلی معین یکتا و برگشت‌پذیر است', () => {
  assert.equal(internalMoeenCode(12, 2), '120002');
  assert.equal(internalMoeenCode(10, 1), '100001');
  assert.notEqual(internalMoeenCode(12, 2), internalMoeenCode(120, 2));
});

test('طرح ورود: سند متوازن قابل ورود، ردیف صفر و تکراری حذف، نامتوازن هشدار', () => {
  const parsed = parseParsianBackup(buildFixtureBackup(), { fileName: 'fixture.bak' });
  const plan = buildParsianImportPlan(parsed);
  assert.equal(plan.vouchers.length, 2);
  const balanced = plan.vouchers.find((item) => item.sanad === 12);
  assert.ok(balanced.importable);
  // سه ردیف واقعی؛ ردیف صفر و تکراریِ دقیق کنار گذاشته می‌شوند.
  assert.equal(balanced.lines.length, 3);
  assert.equal(balanced.bedTotal, balanced.besTotal);
  const unbalanced = plan.vouchers.find((item) => item.sanad === 13);
  assert.ok(!unbalanced.importable);
  assert.ok(unbalanced.issues.some((issue) => issue.includes('متوازن نیست')));
  // کد یکتای معین = کل + معین چهاررقمی؛ کد سطح = کد اصیل پارسیان.
  const subsidiary = plan.chartRows.filter((row) => row.level === 'subsidiary');
  assert.deepEqual(subsidiary.map((row) => row.code).sort(), ['100001', '120002', '230004', '600001']);
  assert.equal(subsidiary.find((row) => row.code === '120002').levelCode, '2');
});

test('پیش‌نمایش در دفتر خام مجاز است و چیزی نمی‌نویسد', () => {
  inWorkspace(() => {
    const preview = previewParsianBackup(database.activeWorkspaceDatabase(), buildFixtureBackup(), 'fixture.bak');
    assert.ok(preview.rawLedger.ok);
    assert.equal(preview.summary.importableCount, 1);
    assert.equal(preview.summary.unbalancedCount, 1);
    // پیش‌نمایش هیچ ردی در دفتر نگذاشته باشد.
    const status = preview.rawLedger;
    assert.equal(status.journalCount, 0);
    assert.equal(status.chartCount, 0);
  });
});

test('ثبت در دفتر خام: کدینگ، تفصیلی و سند پیش‌نویس وارد می‌شود', () => {
  inWorkspace(() => {
    const active = database.activeWorkspaceDatabase();
    const result = commitParsianBackup(active, buildFixtureBackup(), 'fixture.bak', {
      createdBy: owner.id, timeZone: 'Asia/Tehran',
    });
    assert.equal(result.chart.created, 8); // ۴ کل + ۴ معین
    assert.equal(result.analytics, 4);
    assert.equal(result.ledgerAccounts, 4);
    assert.equal(result.journals.entries, 1);
    // سند به‌صورت پیش‌نویس ثبت شده و متوازن است.
    const draft = active.prepare("SELECT approval_state, memo FROM journal_entries").get();
    assert.equal(draft.approval_state, 'draft');
    assert.ok(draft.memo.includes('سند 12'));
    const lines = active.prepare(`SELECT journal_lines.debit, chart_accounts.code AS chartCode
      FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id`).all();
    assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), 1172600000);
    // خط فروش به معین «مشتریان» پارسیان (کل ۱۲، معین ۲ → کد داخلی ۱۲۰۰۰۲) می‌خورد.
    assert.ok(lines.some((line) => line.chartCode === '120002'));
    // سند پیش‌نویس فقط با تفصیلیِ طرف حساب ثبت شده باشد.
    const analytic = active.prepare("SELECT kind FROM analytic_accounts WHERE source_kind='parsian-tafsili'").get();
    assert.equal(analytic.kind, 'contact');
  });
});

test('ثبت دوم در همان دفتر رد می‌شود (فقط دفتر خام)', () => {
  inWorkspace(() => {
    assert.throws(
      () => commitParsianBackup(database.activeWorkspaceDatabase(), buildFixtureBackup(), 'fixture.bak', { createdBy: owner.id }),
      (error) => error.code === 'PARSIAN_IMPORT_LEDGER_NOT_RAW',
    );
  });
});

// ---------------------------------------------------------------------------
// راستی‌آزمایی با بکاپ واقعی (در صورت وجود) — فایل مشتری وارد Git نمی‌شود.
// ---------------------------------------------------------------------------

const realPath = process.env.PARSIAN_BAK_PATH || '/home/z/my-project/upload/db_111403.bak';
if (existsSync(realPath)) {
  test('بکاپ واقعی پارسیان: سنجه‌های رمزگشایی صحه‌گذاری شده', () => {
    const parsed = parseParsianBackup(readFileSync(realPath), { fileName: 'db_111403.bak' });
    assert.equal(parsed.chart.kol.length, 26);
    assert.equal(parsed.chart.moeen.length, 84);
    assert.equal(parsed.chart.tafsili.length, 37);
    assert.equal(parsed.documents.rows.length, 2297);
    assert.equal(parsed.documents.vouchers.length, 157);
    assert.equal(parsed.documents.vouchers.filter((item) => item.balanced).length, 89);
    const plan = buildParsianImportPlan(parsed);
    assert.equal(plan.summary.importableCount, 88);
    assert.equal(plan.summary.lineCount, 404);
    assert.equal(plan.summary.bedTotal, plan.summary.besTotal);
  });
} else {
  test('بکاپ واقعی در دسترس نیست؛ آزمون صحه‌گذاری رد شد', { skip: true }, () => {});
}
