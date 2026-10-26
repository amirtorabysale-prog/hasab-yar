// آزمون ورود بکاپ پارسیان — خوانندهٔ بومی SQL Server 2000 + جریان دفتر خام.
//
// سه لایه:
//  ۱) رفت‌وبرگشت: دفترهای تصادفی در بکاپ سینتتیکی با ساختار واقعی (صفحهٔ نامرتب،
//     torn bits، صفحهٔ کهنهٔ PFS، ردیف حذف‌شده) نوشته و عیناً بازخوانده می‌شوند.
//  ۲) طرح و ثبت در دفتر خام: واحد مبلغ، نوع حساب از گروه پارسیان، همه‌یا‌هیچ.
//  ۳) اگر بکاپ‌های واقعی روی دیسک باشند، با عددهایی که مستقل از این کد از
//     همان فایل‌ها درآمده سنجیده می‌شوند (فایل مشتری هرگز وارد Git نمی‌شود).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { buildParsianBackup } from './helpers/parsianBakFixture.js';

// ---------------------------------------------------------------------------
// دفتر نمونه و دفتر تصادفی
// ---------------------------------------------------------------------------

const GROUPS = [
  { Code: 11, CName: 'دارايي هاي جاري' }, { Code: 21, CName: 'بدهي هاي جاري' }, { Code: 31, CName: 'حقوق صاحبان سهام' },
  { Code: 41, CName: 'فروش و درآمدها' }, { Code: 61, CName: 'هزينه هاي فعاليت' }, { Code: 91, CName: 'حسابهاي انتظامي' },
];

function sampleTables() {
  const kol = [
    { Code: 10, CName: 'صندوق', GroupCode: 11, iType: 0 },
    { Code: 12, CName: 'بدهکاران', GroupCode: 11, iType: 0 },
    { Code: 23, CName: 'بستانکاران', GroupCode: 21, iType: 0 },
    { Code: 27, CName: 'جاري شرکا', GroupCode: null, iType: 0 },
    { Code: 60, CName: 'فروش', GroupCode: 41, iType: 1 },
    { Code: 62, CName: 'خريد', GroupCode: 11, iType: 1 },
  ];
  const moeen = [
    { KolCode: 10, Code: 1, CName: 'صندوق' }, { KolCode: 12, Code: 2, CName: 'مشتریان' },
    { KolCode: 23, Code: 4, CName: 'ماليات بر ارزش افزوده' }, { KolCode: 27, Code: 1, CName: 'جاري آرش' },
    { KolCode: 60, Code: 1, CName: 'فروش' }, { KolCode: 62, Code: 1, CName: 'خريد' },
  ];
  const tafsili = [
    { KolCode: 12, MoeenCode: 2, Code: 4, CName: 'شرکت نمونه سبز' },
    { KolCode: 23, MoeenCode: 4, Code: 1, CName: 'ارزش افزوده فروش' },
  ];
  let id = 1;
  const row = (sanad, date, kolCode, moeenCode, taf, bed, bes, comment) => ({
    ID: id++, Sanad_Num: sanad, SanadDate: date, KolCode: kolCode, MoeenCode: moeenCode, TafsiliCode: taf,
    Comment: comment, Bed: bed, Bes: bes, SanadComment: null,
  });
  const document = [
    // سند ۱۲ متوازن: فروش + ارزش افزوده ۱۰٪ (همان سند فایل واقعی).
    row(12, '1403/03/08', 12, 2, 4, 1172600000, 0, 'فاکتور فروش 1'),
    row(12, '1403/03/08', 60, 1, 0, 0, 1066000000, 'فاکتور فروش 1 شرکت نمونه سبز'),
    row(12, '1403/03/08', 23, 4, 1, 0, 106600000, 'ماليات بر ارزش افزوده فروش فاكتور 1'),
    // سند ۱۳ در خود پارسیان نامتوازن است (پارسیان سند نامتوازن را می‌پذیرد).
    row(13, '1403/03/09', 10, 1, 0, 500000, 0, 'سند ناقص'),
    // سند ۱۴: آورده شریک — حساب بی‌گروه.
    row(14, '1403/03/10', 10, 1, 0, 250000000, 0, 'آورده نقدی'),
    row(14, '1403/03/10', 27, 1, 0, 0, 250000000, 'آورده نقدی'),
  ];
  // تنظیمات پارسیان: صندوق و فروش معین دارند؛ حقوق به معینی اشاره می‌کند که در
  // کدینگ نیست؛ سرمایه به جاری شرکا (بدهی/انتخابی) می‌خورد؛ ارزش افزوده با تفصیلی.
  const accSetting = [{ ID: 2, Cash_K: 10, Cash_M: 1, Cash_T: 0, Sell_K: 60, Sell_M: 1, Sell_T: 0, Wage_K: 50, Wage_M: 2, Wage_T: 0, Asset_K: 27, Asset_M: 1, Asset_T: 0 }];
  const vatSetting = [{ ID: 6, VATSale_K: 23, VATSale_M: 4, VATSale_T: 1, VATBuy_K: 0, VATBuy_M: 0, VATBuy_T: 0 }];
  return { tbl_ACCGroup: GROUPS, tbl_Kol: kol, tbl_Moeen: moeen, tbl_Tafsili: tafsili, tbl_Document: document, tbl_AccSetting: accSetting, tbl_VATSetting: vatSetting };
}

function sampleBackup(options = {}) {
  const tables = sampleTables();
  // ردیف کهنه با همان شناسهٔ ردیف زنده ولی سند و حساب دیگر، و ردیف حذف‌شده.
  const stale = [{ ...tables.tbl_Document[2], Sanad_Num: 130, KolCode: 21, Bes: 3530000 }];
  const deleted = [{ ...tables.tbl_Document[0], ID: 9001, Sanad_Num: 12, Bed: 10000000, Comment: 'واريزي شاپرک' }];
  return buildParsianBackup(tables, { stale, deleted, ...options });
}

function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

const WORDS = ['فاکتور', 'فروش', 'خريد', 'کارمزد', 'بانک', 'شرکت', 'محترم', 'ماليات', 'ي', 'ك', 'ۀ', 'A1', '۱۲۳', ' ', '—'];

/** دفتر تصادفی: کدینگ بی‌تکرار و سندهای چندردیفه با متن‌هایی که از مرز بخش‌ها می‌گذرند. */
function randomTables(seed) {
  const random = seededRandom(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const text = (max) => Array.from({ length: Math.floor(random() * max) }, () => pick(WORDS)).join(' ').trim();
  const kolCodes = [...new Set(Array.from({ length: 3 + Math.floor(random() * 12) }, () => 10 + Math.floor(random() * 60)))];
  const kol = kolCodes.map((code) => ({ Code: code, CName: text(4) || `کل ${code}`, GroupCode: random() < 0.2 ? null : pick(GROUPS).Code, iType: random() < 0.5 ? 0 : 1 }));
  const moeen = kol.flatMap((item) => Array.from({ length: 1 + Math.floor(random() * 4) }, (_, index) => ({ KolCode: item.Code, Code: index + 1, CName: text(5) || 'معین' })));
  const tafsili = moeen.filter(() => random() < 0.4).map((item, index) => ({ KolCode: item.KolCode, MoeenCode: item.Code, Code: index + 1, CName: text(6) || 'تفصیلی' }));
  const document = [];
  let id = 1 + Math.floor(random() * 5000);
  const voucherCount = 1 + Math.floor(random() * 120);
  for (let sanad = 1; sanad <= voucherCount; sanad += 1) {
    const date = `1403/${String(1 + Math.floor(random() * 12)).padStart(2, '0')}/${String(1 + Math.floor(random() * 29)).padStart(2, '0')}`;
    const lineCount = 2 + Math.floor(random() * 8);
    for (let line = 0; line < lineCount; line += 1) {
      const account = pick(moeen);
      const tafsiliRow = tafsili.find((item) => item.KolCode === account.KolCode && item.MoeenCode === account.Code);
      const amount = Math.floor(random() * 10 ** (1 + Math.floor(random() * 12)));
      const debit = random() < 0.5;
      document.push({
        ID: id, Sanad_Num: sanad, SanadDate: date, KolCode: account.KolCode, MoeenCode: account.Code,
        TafsiliCode: tafsiliRow && random() < 0.7 ? tafsiliRow.Code : 0,
        Comment: random() < 0.15 ? null : text(30), Bed: debit ? amount : 0, Bes: debit ? 0 : amount,
        SanadComment: random() < 0.8 ? null : text(10),
      });
      id += 1 + Math.floor(random() * 3);
    }
  }
  return { tbl_ACCGroup: GROUPS, tbl_Kol: kol, tbl_Moeen: moeen, tbl_Tafsili: tafsili, tbl_Document: document };
}

const { parseParsianBackup, restoreTornBits } = await import('../server/parsianBackup.js');

function normalizedRows(parsed) {
  return parsed.documents.rows
    .map((row) => [row.id, row.sanad, row.date, row.kol, row.moeen, row.taf, row.bed, row.bes, row.comment, row.sanadComment].join('|'))
    .sort();
}

function expectedRows(tables) {
  return tables.tbl_Document
    .map((row) => [row.ID, row.Sanad_Num, row.SanadDate, row.KolCode, row.MoeenCode, row.TafsiliCode, row.Bed, row.Bes, (row.Comment || '').trim(), (row.SanadComment || '').trim()].join('|'))
    .sort();
}

// ---------------------------------------------------------------------------
// ۱) رفت‌وبرگشت خواننده
// ---------------------------------------------------------------------------

test('رفت‌وبرگشت: هر دفتر تصادفی عیناً از بکاپ سینتتیک بازخوانده می‌شود', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const tables = randomTables(seed);
    const parsed = parseParsianBackup(buildParsianBackup(tables, { seed }), { fileName: `seed-${seed}.bak` });
    assert.deepEqual(normalizedRows(parsed), expectedRows(tables), `seed ${seed}`);
    assert.deepEqual(parsed.chart.kol.map((row) => `${row.code}|${row.name}|${row.group}|${row.temporary}`).sort(),
      tables.tbl_Kol.map((row) => `${row.Code}|${row.CName.trim()}|${row.GroupCode}|${row.iType === 1}`).sort(), `seed ${seed}`);
    assert.deepEqual(parsed.chart.moeen.map((row) => `${row.kol}/${row.code}|${row.name}`).sort(),
      tables.tbl_Moeen.map((row) => `${row.KolCode}/${row.Code}|${row.CName.trim()}`).sort(), `seed ${seed}`);
    assert.deepEqual(parsed.chart.tafsili.map((row) => `${row.kol}/${row.moeen}/${row.code}|${row.name}`).sort(),
      tables.tbl_Tafsili.map((row) => `${row.KolCode}/${row.MoeenCode}/${row.Code}|${row.CName.trim()}`).sort(), `seed ${seed}`);
  }
});

test('torn bits: بدون برگرداندن، متن روی مرز بخش خراب است؛ با برگرداندن عین اصل', () => {
  const page = Buffer.alloc(8192);
  page[0] = 1; page.writeUInt16LE(0x100, 4);
  const original = Buffer.from('صندوق قرض الحسنه'.repeat(400), 'utf16le').subarray(0, 8192 - 96);
  original.copy(page, 96);
  const pristine = Buffer.from(page);
  let torn = 1;
  for (let sector = 1; sector < 16; sector += 1) {
    const at = 512 * (sector + 1) - 1;
    torn |= (page[at] & 3) << (2 * sector);
    page[at] = (page[at] & 0xfc) | 1;
  }
  page.writeUInt32LE(torn >>> 0, 60);
  pristine.writeUInt32LE(torn >>> 0, 60);
  assert.notDeepEqual(page, pristine);
  assert.ok(restoreTornBits(page) > 0);
  assert.deepEqual(page, pristine);
});

test('صفحهٔ کهنه و ردیف حذف‌شده خوانده نمی‌شوند؛ سند واقعی متوازن می‌ماند', () => {
  const parsed = parseParsianBackup(sampleBackup(), { fileName: 'sample.bak' });
  assert.equal(parsed.documents.rows.length, 6);
  assert.ok(!parsed.documents.rows.some((row) => row.sanad === 130 || row.id === 9001));
  assert.equal(parsed.meta.pagesByTable.tbl_Document.stale, 1);
  const voucher = parsed.documents.vouchers.find((item) => item.sanad === 12);
  assert.ok(voucher.balanced);
  assert.equal(voucher.bedTotal, 1172600000);
});

test('فایل غیربکاپ و بکاپ ناقص خطای روشن می‌دهند، نه خطای سرور', () => {
  assert.throws(() => parseParsianBackup(Buffer.alloc(40000)), (error) => error.code === 'PARSIAN_BACKUP_NOT_MTF' && error.status === 400);
  const truncated = sampleBackup().subarray(0, 20000);
  assert.throws(() => parseParsianBackup(truncated), (error) => error.status === 400 && /^PARSIAN_BACKUP_/.test(error.code));
});

// ---------------------------------------------------------------------------
// ۲) طرح و ثبت در دفتر خام
// ---------------------------------------------------------------------------

const tempPathModule = await import('./helpers/tempPath.js');
const databasePath = tempPathModule.tempDatabase('parsian-bak');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'parsian-owner';
process.env.ADMIN_PASSWORD = 'parsian-strong-password-12345';
const database = await import(`../server/db.js?parsian-bak=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('parsian-owner', 'parsian-strong-password-12345');
const newWorkspace = (name) => database.createWorkspace(owner.id, { name, profileType: 'business' });
const inWorkspace = (workspace, callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

test.after(() => tempPathModule.removeTempDatabase(databasePath));

const { previewParsianBackup, commitParsianBackup, buildParsianImportPlan, internalMoeenCode, parsianKolType } = await import(`../server/parsianImport.js?fixture=${process.pid}`);

test('کد داخلی معین یکتا و برگشت‌پذیر است', () => {
  assert.equal(internalMoeenCode(12, 2), '120002');
  assert.equal(internalMoeenCode(10, 1), '100001');
  assert.notEqual(internalMoeenCode(12, 2), internalMoeenCode(120, 2));
});

test('نوع کل از گروه پارسیان؛ بی‌گروه، انتظامی و ناسازگار نیازمند انتخاب‌اند', () => {
  assert.equal(parsianKolType({ group: 11, temporary: false }).type, 'asset');
  assert.equal(parsianKolType({ group: 21, temporary: false }).type, 'liability');
  assert.equal(parsianKolType({ group: 31, temporary: false }).type, 'equity');
  assert.equal(parsianKolType({ group: 41, temporary: true }).type, 'income');
  assert.equal(parsianKolType({ group: 51, temporary: true }).type, 'expense');
  assert.equal(parsianKolType({ group: 61, temporary: true }).type, 'expense');
  assert.equal(parsianKolType({ group: null, temporary: false }).type, null);
  assert.equal(parsianKolType({ group: 62, temporary: true }).type, null);
  assert.equal(parsianKolType({ group: 91, temporary: false }).type, null);
  // «خرید» پارسیان در گروه دارایی جاری ولی موقت است: تصمیم با حسابدار.
  assert.equal(parsianKolType({ group: 11, groupName: 'دارايي هاي جاري', temporary: true }).type, null);
});

test('طرح بدون واحد مبلغ ساخته نمی‌شود', () => {
  const parsed = parseParsianBackup(sampleBackup());
  assert.throws(() => buildParsianImportPlan(parsed, {}), (error) => error.code === 'PARSIAN_IMPORT_UNIT_REQUIRED');
});

test('واحد ریال: مبلغ بر ۱۰ تقسیم می‌شود و مبلغ ناصحیح گرد نمی‌شود', () => {
  const tables = sampleTables();
  tables.tbl_Document.push(
    { ID: 50, Sanad_Num: 20, SanadDate: '1403/04/01', KolCode: 10, MoeenCode: 1, TafsiliCode: 0, Comment: 'کارمزد', Bed: 7384, Bes: 0, SanadComment: null },
    { ID: 51, Sanad_Num: 20, SanadDate: '1403/04/01', KolCode: 60, MoeenCode: 1, TafsiliCode: 0, Comment: 'کارمزد', Bed: 0, Bes: 7384, SanadComment: null },
  );
  const parsed = parseParsianBackup(buildParsianBackup(tables));
  const rial = buildParsianImportPlan(parsed, { amountUnit: 'rial' });
  assert.equal(rial.vouchers.find((item) => item.sanad === 12).lines[0].debit, 117260000);
  const fee = rial.vouchers.find((item) => item.sanad === 20);
  assert.ok(!fee.importable);
  // سند متوازن است؛ فقط واحد جلویش را گرفته، نه «نامتوازن/نامعتبر».
  assert.equal(fee.blockReason, 'unit');
  assert.equal(rial.summary.unitBlockedCount, 1);
  assert.ok(fee.lineIssues.some((issue) => issue.includes('در دفتر تومانی به عدد صحیح درنمی‌آید')));
  assert.ok(!fee.lineIssues.some((issue) => issue.includes('واحد فایل را کنترل کن')));
  const toman = buildParsianImportPlan(parsed, { amountUnit: 'toman' });
  assert.ok(toman.vouchers.find((item) => item.sanad === 20).importable);
  assert.equal(toman.vouchers.find((item) => item.sanad === 12).lines[0].debit, 1172600000);
  // همان فایل ریالی در دفتر ریالی بی‌هیچ تبدیل و دقیق وارد می‌شود.
  const rialLedger = buildParsianImportPlan(parsed, { amountUnit: 'rial', ledgerUnit: 'rial' });
  assert.ok(rialLedger.vouchers.find((item) => item.sanad === 20).importable);
  assert.equal(rialLedger.vouchers.find((item) => item.sanad === 20).lines[0].debit, 7384);
  assert.equal(rialLedger.vouchers.find((item) => item.sanad === 12).lines[0].debit, 1172600000);
  assert.equal(rialLedger.summary.unitBlockedCount, 0);
  // فایل تومانی در دفتر ریالی ده برابر و باز هم دقیق.
  const tomanFileRialLedger = buildParsianImportPlan(parsed, { amountUnit: 'toman', ledgerUnit: 'rial' });
  assert.equal(tomanFileRialLedger.vouchers.find((item) => item.sanad === 20).lines[0].debit, 73840);
});

test('پیش‌نمایش در دفتر خام چیزی نمی‌نویسد و کل‌های مبهم را با پیشنهاد نشان می‌دهد', () => {
  const workspace = newWorkspace('پیش‌نمایش پارسیان');
  inWorkspace(workspace, () => {
    const preview = previewParsianBackup(database.activeWorkspaceDatabase(), sampleBackup(), 'sample.bak', { amountUnit: 'toman' });
    assert.ok(preview.rawLedger.ok);
    assert.equal(preview.summary.importableCount, 2);
    assert.equal(preview.summary.unbalancedCount, 1);
    assert.deepEqual(preview.kolTypeChoices.map((choice) => choice.code).sort(), [27, 62]);
    assert.equal(preview.kolTypeChoices.find((choice) => choice.code === 62).suggestion, 'expense');
    assert.equal(preview.rawLedger.journalCount, 0);
    assert.equal(preview.rawLedger.chartCount, 0);
  });
});

test('ثبت بدون انتخاب نوع کل‌های مبهم رد می‌شود و چیزی نمی‌نویسد', () => {
  const workspace = newWorkspace('بی‌نوع پارسیان');
  inWorkspace(workspace, () => {
    const active = database.activeWorkspaceDatabase();
    assert.throws(() => commitParsianBackup(active, sampleBackup(), 'sample.bak', { amountUnit: 'toman', kolTypes: { 27: 'equity' } }),
      (error) => error.code === 'PARSIAN_IMPORT_TYPES_REQUIRED' && error.details.pendingKolTypes.length === 1);
    assert.equal(active.prepare('SELECT COUNT(*) AS count FROM chart_accounts').get().count, 0);
  });
});

test('ثبت در دفتر خام: کدینگ با نوع درست، تفصیلی و سند پیش‌نویس به تومان', () => {
  const workspace = newWorkspace('دفتر خام پارسیان');
  inWorkspace(workspace, () => {
    const active = database.activeWorkspaceDatabase();
    const result = commitParsianBackup(active, sampleBackup(), 'sample.bak', {
      createdBy: owner.id, timeZone: 'Asia/Tehran', amountUnit: 'rial', kolTypes: JSON.stringify({ 27: 'equity', 62: 'expense' }),
    });
    assert.equal(result.chart.created, 12); // ۶ کل + ۶ معین
    assert.equal(result.analytics, 2);
    assert.equal(result.journals.entries, 2);
    assert.equal(result.amountUnit, 'rial');
    const types = Object.fromEntries(active.prepare("SELECT code,type FROM chart_accounts WHERE level='general'").all().map((row) => [row.code, row.type]));
    assert.deepEqual(types, { 10: 'asset', 12: 'asset', 23: 'liability', 27: 'equity', 60: 'income', 62: 'expense' });
    const drafts = active.prepare('SELECT approval_state AS state, memo FROM journal_entries ORDER BY memo').all();
    assert.ok(drafts.every((draft) => draft.state === 'draft'));
    assert.ok(drafts.some((draft) => draft.memo.includes('سند 12')));
    const lines = active.prepare(`SELECT journal_lines.debit, journal_lines.analytic_id AS analytic, chart_accounts.code AS chartCode
      FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id`).all();
    // ریال به تومان: ۱٬۱۷۲٬۶۰۰٬۰۰۰ ریال + ۲۵۰٬۰۰۰٬۰۰۰ ریال.
    assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), 142260000);
    assert.ok(lines.some((line) => line.chartCode === '120002' && line.analytic));
    // دوباره در همان دفتر رد می‌شود.
    assert.throws(() => commitParsianBackup(active, sampleBackup(), 'sample.bak', { amountUnit: 'rial', kolTypes: { 27: 'equity', 62: 'expense' } }),
      (error) => error.code === 'PARSIAN_IMPORT_LEDGER_NOT_RAW');
  });
});

test('نقش حساب‌ها از تنظیمات خود پارسیان؛ نقشی که با تفصیلی یا نوع ناسازگار است داده نمی‌شود', () => {
  const plan = buildParsianImportPlan(parseParsianBackup(sampleBackup()), { amountUnit: 'toman', kolTypes: { 27: 'liability', 62: 'expense' } });
  const roles = Object.fromEntries(plan.designatedRoles.map((item) => [item.key, item]));
  assert.ok(roles.Cash.applied);
  assert.ok(roles.Sell.applied);
  assert.equal(plan.chartRows.find((row) => row.code === '100001').role, 'cash');
  assert.equal(plan.chartRows.find((row) => row.code === '600001').role, 'sales');
  assert.match(roles.Wage.reason, /در کدینگ فایل نیست/);
  assert.match(roles.Asset.reason, /نمی‌خواند/); // جاری شرکا بدهی است، سرمایه نیست
  assert.match(roles.VATSale.reason, /تفصیلی 1/);
  assert.ok(!('VATBuy' in roles), 'کل صفر یعنی پارسیان حسابی تعیین نکرده');
});

test('سند آمده از بکاپ به پارسیان برنمی‌گردد و جلوی خروجی را نمی‌گیرد؛ سند اصلاحی تازه می‌رود', async () => {
  const { createAdjustingJournal } = await import('../server/accounting.js');
  const workspace = newWorkspace('رفت‌وبرگشت پارسیان');
  inWorkspace(workspace, () => {
    const active = database.activeWorkspaceDatabase();
    const result = commitParsianBackup(active, sampleBackup(), 'sample.bak', { amountUnit: 'toman', kolTypes: { 27: 'equity', 62: 'expense' } });
    assert.equal(active.prepare('SELECT COUNT(*) AS count FROM parsian_imported_entries').get().count, 2);
    assert.deepEqual(active.prepare('SELECT sanad FROM parsian_imported_entries ORDER BY sanad').all().map((row) => row.sanad), [12, 14]);
    assert.ok(result.designatedRoles.some((item) => item.key === 'Cash' && item.applied));

    // سندها پیش‌نویس‌اند؛ برای پارسیان نه در فایل می‌روند نه جلوی ساختش را می‌گیرند.
    const parsian = database.accountingTransferOverview('1403-03', 'parsian-review-csv');
    assert.equal(parsian.readiness.rowCount, 0);
    assert.equal(parsian.readiness.checks.find((check) => check.id === 'approval').count, 0);
    assert.equal(parsian.readiness.checks.find((check) => check.id === 'parsian-sourced').count, 2);
    // برای مقصد عمومی (اکسل) همان سندها بخشی از دفتر ماه‌اند.
    const generic = database.accountingTransferOverview('1403-03', 'generic-csv');
    assert.ok(generic.readiness.rowCount > 0);
    assert.ok(!generic.readiness.checks.some((check) => check.id === 'parsian-sourced'));

    // اصلاحِ یک سند آمده از پارسیان، سند تازه است و همان در فایل انتقال می‌رود.
    const cash = active.prepare("SELECT ledger_accounts.id FROM ledger_accounts JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id WHERE chart_accounts.code='100001'").get().id;
    const sales = active.prepare("SELECT ledger_accounts.id FROM ledger_accounts JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id WHERE chart_accounts.code='600001'").get().id;
    const adjustment = createAdjustingJournal(active, {
      occurredAt: active.prepare("SELECT occurred_at AS at FROM journal_entries WHERE memo LIKE '%سند 12 %'").get().at,
      memo: 'اصلاح سند ۱۲ پارسیان', lines: [{ accountId: cash, debit: 1000, credit: 0 }, { accountId: sales, debit: 0, credit: 1000 }],
    });
    active.prepare("UPDATE journal_entries SET approval_state='approved' WHERE id=?").run(adjustment.id);
    const after = database.accountingTransferOverview('1403-03', 'parsian-review-csv');
    assert.equal(after.readiness.entryCount, 1);
    assert.equal(after.readiness.debitTotal, 1000);

    // ثبت روزمرهٔ تازه: صندوق و فروش حساب‌یار خودکار روی معین‌هایی می‌نشینند که
    // خود پارسیان برای صندوق و فروش تعیین کرده، بدون نگاشت دستی.
    database.insertTransactions({ transcript: 'فروش نقدی', transactions: [{ amount: 2_000_000, type: 'income', category: 'فروش', rawText: 'فروش نقدی' }] });
    const codes = active.prepare(`SELECT chart_accounts.code FROM journal_lines
      JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
      JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      LEFT JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
      WHERE journal_entries.source_type='transaction'`).all().map((row) => row.code).sort();
    assert.deepEqual(codes, ['100001', '600001']);
  });
});

test('شکست در میانهٔ ثبت همه‌چیز را برمی‌گرداند و دفتر خام می‌ماند', () => {
  const workspace = newWorkspace('شکست پارسیان');
  inWorkspace(workspace, () => {
    const active = database.activeWorkspaceDatabase();
    // سندی که موتور ثبت ردش می‌کند: مبلغ بزرگ‌تر از سقف عدد صحیح امن.
    const tables = sampleTables();
    tables.tbl_Document.push(
      { ID: 60, Sanad_Num: 30, SanadDate: '1403/05/01', KolCode: 10, MoeenCode: 1, TafsiliCode: 0, Comment: 'بزرگ', Bed: 2 ** 60, Bes: 0, SanadComment: null },
      { ID: 61, Sanad_Num: 30, SanadDate: '1403/05/01', KolCode: 60, MoeenCode: 1, TafsiliCode: 0, Comment: 'بزرگ', Bed: 0, Bes: 2 ** 60, SanadComment: null },
    );
    assert.throws(() => commitParsianBackup(active, buildParsianBackup(tables), 'big.bak', { amountUnit: 'toman', kolTypes: { 27: 'equity', 62: 'expense' } }),
      (error) => error.code === 'PARSIAN_IMPORT_FAILED');
    for (const table of ['chart_accounts', 'analytic_accounts', 'journal_entries']) {
      assert.equal(active.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
    }
    // دفتر هنوز خام است و ورود درست انجام می‌شود.
    const result = commitParsianBackup(active, sampleBackup(), 'sample.bak', { amountUnit: 'toman', kolTypes: { 27: 'equity', 62: 'expense' } });
    assert.equal(result.journals.entries, 2);
  });
});

test('از راه HTTP: واحد و نوع‌ها از فرم به پیش‌نمایش و ثبت می‌رسند و واحد خروجی پارسیان همان می‌شود', async () => {
  const workspace = newWorkspace('HTTP پارسیان');
  // ورود بکاپ ابزار حسابدار است و فقط در محیط حرفه‌ای باز است.
  database.setExperiencePreference(workspace.id, owner.id, 'professional');
  const port = 4800 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let index = 0; index < 60; index += 1) {
      if (await fetch(`${base}/api/health`).then((response) => response.ok).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'parsian-owner', password: 'parsian-strong-password-12345' }),
    });
    const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const { csrfToken } = await login.json();
    const send = async (path, fields) => {
      const form = new FormData();
      form.append('file', new Blob([sampleBackup()]), 'sample.bak');
      for (const [name, value] of Object.entries(fields)) form.append(name, value);
      const response = await fetch(base + path, { method: 'POST', body: form, headers: { cookie, 'x-csrf-token': csrfToken, 'x-workspace-id': workspace.id } });
      return { status: response.status, data: await response.json() };
    };
    const missing = await send('/api/import/parsian-backup/preview', {});
    assert.equal(missing.status, 400, JSON.stringify(missing.data));
    assert.equal(missing.data.code, 'PARSIAN_IMPORT_UNIT_REQUIRED');
    const preview = await send('/api/import/parsian-backup/preview', { amountUnit: 'rial' });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.summary.amountUnit, 'rial');
    const commit = await send('/api/import/parsian-backup/commit', { amountUnit: 'rial', kolTypes: JSON.stringify({ 27: 'equity', 62: 'expense' }) });
    assert.equal(commit.status, 201, JSON.stringify(commit.data));
    assert.equal(commit.data.journals.entries, 2);
  } finally { child.kill(); }
  inWorkspace(workspace, () => {
    const row = database.activeWorkspaceDatabase().prepare("SELECT amount_unit AS unit FROM accounting_transfer_settings WHERE target_system='parsian-review-csv'").get();
    assert.equal(row?.unit, 'rial');
  });
});

// ---------------------------------------------------------------------------
// ۳) بکاپ‌های واقعی — عددها از خوانش مستقلِ همان فایل‌ها (syscolumns، slot، PFS)
// ---------------------------------------------------------------------------

// db_111403: سال ۱۴۰۳ مشتری؛ سندهای ۱ تا ۱۵۲ پیوسته و همه متوازن. db_1402: شرکت آزمایشی.
const realFiles = [process.env.PARSIAN_BAK_PATH, 'parsian/db_111403.bak', 'parsian/db_1402.bak'].filter((path) => path && existsSync(path));
const KNOWN = {
  db_111403: { kol: 26, moeen: 84, tafsili: 37, rows: 2499, vouchers: 152, balanced: 152, total: 283884754448, sanadMin: 1, sanadMax: 152 },
  db_1402: { kol: 24, moeen: 55, tafsili: 1, rows: 6, vouchers: 2, balanced: 1, total: 876050000, sanadMin: 2, sanadMax: 3 },
};
const KNOWN_SHA1 = {
  '33d67942e8fdcdafd6c689a6e895912512aa6765': 'db_111403',
  fe4eb25e68bdc98b74b03fc558d423a6279fb31f: 'db_1402',
};

for (const path of new Set(realFiles)) {
  const buffer = readFileSync(path);
  const known = KNOWN_SHA1[createHash('sha1').update(buffer).digest('hex')];
  test(`بکاپ واقعی ${known || path}: کدینگ و سندها عیناً خوانده می‌شوند`, () => {
    const parsed = parseParsianBackup(buffer, { fileName: path });
    const ids = new Set(parsed.documents.rows.map((row) => row.id));
    assert.equal(ids.size, parsed.documents.rows.length);
    if (!known) return;
    const expected = KNOWN[known];
    const vouchers = parsed.documents.vouchers;
    assert.equal(parsed.chart.kol.length, expected.kol);
    assert.equal(parsed.chart.moeen.length, expected.moeen);
    assert.equal(parsed.chart.tafsili.length, expected.tafsili);
    assert.equal(parsed.documents.rows.length, expected.rows);
    assert.equal(vouchers.length, expected.vouchers);
    assert.equal(vouchers.filter((voucher) => voucher.balanced).length, expected.balanced);
    assert.equal(vouchers.reduce((sum, voucher) => sum + voucher.bedTotal, 0), expected.total);
    assert.equal(Math.min(...vouchers.map((voucher) => voucher.sanad)), expected.sanadMin);
    assert.equal(Math.max(...vouchers.map((voucher) => voucher.sanad)), expected.sanadMax);
    assert.ok(parsed.chart.moeen.every((row) => /^[؀-ۿ‌\s\d()\-ـ‌.،/]+$/.test(row.name)), 'نام معین خراب نیست');
    const plan = buildParsianImportPlan(parsed, { amountUnit: 'toman' });
    assert.equal(plan.summary.importableCount, expected.balanced);
  });
}
if (!realFiles.length) test('بکاپ واقعی در دسترس نیست؛ آزمون فایل واقعی رد شد', { skip: true }, () => {});
