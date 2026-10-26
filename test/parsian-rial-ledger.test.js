import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildParsianBackup } from './helpers/parsianBakFixture.js';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * بکاپ ریالی پارسیان در دفتر ریالی.
 *
 * بکاپ واقعی مشتری (db_111403) ریالی است. در دفتر تومانی ۷۵ سند از ۱۵۲ سندش وارد
 * نمی‌شد، از جمله سند افتتاحیه و همهٔ سندهای حقوق، چون ۵۶۷٬۹۰۵٬۰۲۷ ریال به تومانِ
 * صحیح درنمی‌آید. پیام هم «نامتوازن/نامعتبر» و «واحد فایل را کنترل کن» بود و کاربر
 * را به انتخاب تومان می‌راند، که همهٔ مبلغ‌ها را ده برابر می‌کرد.
 *
 * حالا دفتر بی‌مبلغ را می‌شود ریالی کرد و همان فایل دقیق و بی‌تبدیل وارد می‌شود.
 * حساب‌های انتظامی (گروه ۹۱ و ۹۲) هم گزینهٔ «انتظامی» دارند، نه یکی از پنج نوع.
 */

const databasePath = tempDatabase('parsian-rial-ledger');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'rial-owner';
process.env.ADMIN_PASSWORD = randomBytes(24).toString('base64url');
const database = await import(`../server/db.js?parsian-rial=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('rial-owner', process.env.ADMIN_PASSWORD);
const { previewParsianBackup, commitParsianBackup, buildParsianImportPlan } = await import(`../server/parsianImport.js?parsian-rial=${process.pid}`);
const { parseParsianBackup } = await import('../server/parsianBackup.js');
const { applyTransferTemplate } = await import('../server/transferTemplates.js');
const { parsianDocumentsFromJournal } = await import('../server/accountingTransfer.js');
const newWorkspace = (name) => database.createWorkspace(owner.id, { name, profileType: 'business' });
const inWorkspace = (workspace, callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
test.after(() => removeTempDatabase(databasePath));

const GROUPS = [
  { Code: 11, CName: 'دارايي هاي جاري' }, { Code: 21, CName: 'بدهي هاي جاري' }, { Code: 31, CName: 'حقوق صاحبان سهام' },
  { Code: 41, CName: 'فروش و درآمدها' }, { Code: 61, CName: 'هزينه هاي فعاليت' },
  { Code: 91, CName: 'حسابهاي انتظامي' }, { Code: 92, CName: 'طرف حسابهاي انتضامي' },
];

function rialBackup() {
  let id = 1;
  const row = (sanad, date, kol, moeen, bed, bes, comment) => ({ ID: id++, Sanad_Num: sanad, SanadDate: date, KolCode: kol, MoeenCode: moeen, TafsiliCode: 0, Comment: comment, Bed: bed, Bes: bes, SanadComment: null });
  return buildParsianBackup({
    tbl_ACCGroup: GROUPS,
    tbl_Kol: [
      { Code: 10, CName: 'صندوق', GroupCode: 11, iType: 0 }, { Code: 11, CName: 'بانک ها', GroupCode: 11, iType: 0 },
      { Code: 23, CName: 'بستانکاران', GroupCode: 21, iType: 0 }, { Code: 30, CName: 'حقوق صاحبان سهام', GroupCode: 31, iType: 0 },
      { Code: 50, CName: 'هزينه ها', GroupCode: 61, iType: 1 },
      { Code: 64, CName: 'حسابهاي انتظامي', GroupCode: 91, iType: 0 }, { Code: 65, CName: 'طرف حسابهاي انتظامي', GroupCode: 92, iType: 0 },
    ],
    tbl_Moeen: [
      { KolCode: 10, Code: 1, CName: 'صندوق' }, { KolCode: 11, Code: 1, CName: 'رفاه' }, { KolCode: 23, Code: 4, CName: 'ساير حساب هاي پرداختني' },
      { KolCode: 30, Code: 1, CName: 'سرمایه' }, { KolCode: 50, Code: 2, CName: 'هزينه حقوق و دستمزد' }, { KolCode: 50, Code: 300, CName: 'هزینه کارمزد بانک' },
      { KolCode: 64, Code: 1, CName: 'حسابهاي انتظامي به نفع شركت' }, { KolCode: 65, Code: 1, CName: 'طرف حساب انتظامي بنفع شركت' },
    ],
    tbl_Tafsili: [],
    tbl_Document: [
      // افتتاحیه: ۳۱۶٬۸۳۰٬۴۱۳ ریال؛ به تومانِ صحیح درنمی‌آید.
      row(1, '1403/01/01', 11, 1, 316830413, 0, 'افتتاحيه'), row(1, '1403/01/01', 30, 1, 0, 316830413, 'افتتاحيه'),
      // حقوق فروردین با عدد واقعی فایل مشتری.
      row(4, '1403/01/31', 50, 2, 567905027, 0, 'حقوق دستمزد پرسنل فروردين'), row(4, '1403/01/31', 23, 4, 0, 567905027, 'حقوق دستمزد پرسنل فروردين'),
      // کارمزد بانک ۷٬۳۸۴ ریال.
      row(132, '1403/12/10', 50, 300, 7384, 0, 'کارمزد بانک'), row(132, '1403/12/10', 11, 1, 0, 7384, 'کارمزد بانک'),
      // سندی که در تومان هم سالم است.
      row(5, '1403/02/03', 10, 1, 25006200, 0, 'دريافت'), row(5, '1403/02/03', 30, 1, 0, 25006200, 'دريافت'),
      // ضمانت‌نامه: حساب انتظامی و طرفش.
      row(7, '1403/02/20', 64, 1, 500000000, 0, 'ضمانت نامه'), row(7, '1403/02/20', 65, 1, 0, 500000000, 'ضمانت نامه'),
    ],
  });
}

test('فایل ریالی در دفتر تومانی: سند متوازن به‌خاطر واحد می‌ماند و پیام راهِ درست را می‌گوید', () => {
  const workspace = newWorkspace('تومانی برای فایل ریالی');
  inWorkspace(workspace, () => {
    const preview = previewParsianBackup(database.activeWorkspaceDatabase(), rialBackup(), 'rial.bak', { amountUnit: 'rial', kolTypes: { 64: 'memorandum', 65: 'memorandum' } });
    assert.equal(preview.ledgerUnit, 'toman');
    assert.equal(preview.summary.unitBlockedCount, 3, 'افتتاحیه، حقوق و کارمزد');
    assert.equal(preview.summary.unbalancedCount, 0);
    assert.equal(preview.summary.invalidCount, 0);
    assert.equal(preview.summary.importableCount, 2);
    assert.deepEqual(preview.unitAdvice, { fileUnit: 'rial', ledgerUnit: 'toman', fileUnitLabel: 'ریال', ledgerUnitLabel: 'تومان', blockedVouchers: 3 });
    const opening = preview.vouchers.find((voucher) => voucher.sanad === 1);
    assert.equal(opening.blockReason, 'unit');
    assert.ok(opening.lineIssues.every((issue) => !issue.includes('واحد فایل را کنترل کن')));
  });
});

test('دفتر ریالی همان فایل را کامل و بی‌تبدیل وارد می‌کند، با حساب‌های انتظامی', () => {
  const workspace = newWorkspace('ریالی پارسیان');
  inWorkspace(workspace, () => {
    database.setLedgerAmountUnit('rial');
    const active = database.activeWorkspaceDatabase();
    const preview = previewParsianBackup(active, rialBackup(), 'rial.bak', { amountUnit: 'rial' });
    assert.equal(preview.unitAdvice, null);
    assert.equal(preview.summary.importableCount, 5);
    // انتظامی پیشنهادِ خودش را دارد، نه یکی از پنج نوع.
    const memo = preview.kolTypeChoices.filter((choice) => [64, 65].includes(choice.code));
    assert.deepEqual(memo.map((choice) => [choice.code, choice.suggestion, choice.memorandumSide, choice.suggestionLabel]), [
      [64, 'memorandum', 'asset', 'انتظامی (بدهکار)'], [65, 'memorandum', 'liability', 'انتظامی (بستانکار)'],
    ]);
    const result = commitParsianBackup(active, rialBackup(), 'rial.bak', { amountUnit: 'rial', kolTypes: { 64: 'memorandum', 65: 'memorandum' }, createdBy: owner.id });
    assert.equal(result.ledgerUnit, 'rial');
    assert.equal(result.journals.unit, 'rial');
    assert.equal(result.journals.entries, 5);
    assert.equal(result.journals.total, 316830413 + 567905027 + 7384 + 25006200 + 500000000);
    // مبلغ ردیف‌ها همان ریالِ فایل است، بی‌هیچ گرد شدنی.
    const amounts = active.prepare('SELECT debit FROM journal_lines WHERE debit>0 ORDER BY debit').all().map((row) => row.debit);
    assert.deepEqual(amounts, [7384, 25006200, 316830413, 500000000, 567905027]);
    const memoAccounts = active.prepare("SELECT code,type,normal_side AS side,role FROM chart_accounts WHERE role='memorandum' ORDER BY code").all();
    assert.deepEqual(memoAccounts.map((row) => [row.code, row.type, row.side]), [
      ['64', 'asset', 'debit'], ['640001', 'asset', 'debit'], ['65', 'liability', 'credit'], ['650001', 'liability', 'credit'],
    ]);
  });
});

test('فایل تومانی در دفتر ریالی ده برابر و دقیق وارد می‌شود', () => {
  const parsed = parseParsianBackup(rialBackup());
  const plan = buildParsianImportPlan(parsed, { amountUnit: 'toman', ledgerUnit: 'rial', kolTypes: { 64: 'memorandum', 65: 'memorandum' } });
  assert.equal(plan.summary.importableCount, 5);
  assert.equal(plan.vouchers.find((voucher) => voucher.sanad === 132).lines[0].debit, 73840);
});

test('کل انتظامی بی‌انتخاب منتظر می‌ماند؛ انتظامی برای کل غیرانتظامی پیشنهاد نمی‌شود', () => {
  const parsed = parseParsianBackup(rialBackup());
  const plan = buildParsianImportPlan(parsed, { amountUnit: 'rial', ledgerUnit: 'rial' });
  assert.deepEqual(plan.pendingKolTypes.map((choice) => choice.code), [64, 65]);
  assert.ok(plan.kolTypeChoices.every((choice) => choice.suggestion === 'memorandum'));
  const wrong = buildParsianImportPlan(parsed, { amountUnit: 'rial', ledgerUnit: 'rial', kolTypes: { 64: 'asset', 65: 'liability' } });
  assert.ok(!wrong.chartRows.some((row) => row.role === 'memorandum'), 'انتخاب صریح نوع، انتظامی نمی‌سازد');
});

test('فایل انتقال به پارسیان از دفتر ریالی: ریال دقیق، تومانِ ناصحیح با پیام روشن رد می‌شود', () => {
  const rows = [
    { entryId: 'e1', debit: 7384, credit: 0, kolCode: 50, moeenCode: 300, occurredAt: '2025-02-28T00:00:00.000Z' },
    { entryId: 'e1', debit: 0, credit: 7384, kolCode: 11, moeenCode: 1, occurredAt: '2025-02-28T00:00:00.000Z' },
  ];
  const rial = applyTransferTemplate({ amountUnit: 'rial', journalRows: rows, ledgerUnit: 'rial' });
  assert.equal(rial.totals.debit, 7384);
  // قالب پیش‌فرض دو ستون دارد: ریال دقیق، و تومان با یک رقم اعشار کنارش.
  const tomanColumn = rial.headers.indexOf('بدهکار تومان');
  const rialColumn = rial.headers.indexOf('بدهکار ریال');
  assert.deepEqual([rial.rows[0][tomanColumn], rial.rows[0][rialColumn]], [738.4, 7384]);
  // قالبی که فقط تومان می‌خواهد، مبلغ را گرد نمی‌کند.
  assert.throws(() => applyTransferTemplate({ amountUnit: 'rial', journalRows: rows, ledgerUnit: 'rial', columns: [{ field: 'debitToman', header: 'Bed' }, { field: 'creditToman', header: 'Bes' }] }),
    (error) => error.code === 'TRANSFER_AMOUNT_NOT_EXACT');
  assert.equal(rial.totals.debitLedger, 7384);
  assert.equal(rial.totals.debitToman, null);
  assert.throws(() => applyTransferTemplate({ amountUnit: 'toman', journalRows: rows, ledgerUnit: 'rial' }), (error) => error.code === 'TRANSFER_AMOUNT_NOT_EXACT' && /ریال بگذار/.test(error.message));
  const parsian = parsianDocumentsFromJournal({ journalRows: rows, amountUnit: 'rial', ledgerUnit: 'rial' });
  assert.equal(parsian[0].lines[0].debit, 7384);
  assert.throws(() => parsianDocumentsFromJournal({ journalRows: rows, amountUnit: 'toman', ledgerUnit: 'rial' }),
    (error) => error.code === 'PARSIAN_JOURNAL_NOT_READY' && error.details.errors.some((item) => /ریال بگذار/.test(item)));
  // دفتر تومانی همان رفتار قبلی را دارد: ریال = تومان × ۱۰.
  const toman = applyTransferTemplate({ amountUnit: 'rial', journalRows: rows, ledgerUnit: 'toman' });
  assert.equal(toman.totals.debit, 73840);
  assert.equal(toman.totals.debitToman, 7384);
});

test('از راه HTTP: پیش‌نمایش می‌گوید دفتر را می‌شود ریالی کرد؛ پس از ریالی شدن همهٔ سندها قابل ورودند', async () => {
  const workspace = newWorkspace('HTTP ریالی');
  database.setExperiencePreference(workspace.id, owner.id, 'professional');
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '0', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`سرور بالا نیامد: ${output}`)), 15_000);
      child.stdout.on('data', (chunk) => { output += chunk; const match = output.match(/listening on port (\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
      child.stderr.on('data', (chunk) => { output += chunk; });
    });
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'rial-owner', password: process.env.ADMIN_PASSWORD }) });
    const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const { csrfToken } = await login.json();
    const headers = { cookie, 'x-csrf-token': csrfToken, 'x-workspace-id': workspace.id };
    const preview = async () => {
      const form = new FormData();
      form.append('file', new Blob([rialBackup()]), 'rial.bak');
      form.append('amountUnit', 'rial');
      const response = await fetch(`${base}/api/import/parsian-backup/preview`, { method: 'POST', body: form, headers });
      return { status: response.status, data: await response.json() };
    };
    const before = await preview();
    assert.equal(before.status, 200, JSON.stringify(before.data));
    assert.equal(before.data.unitAdvice.blockedVouchers, 3);
    assert.equal(before.data.unitAdvice.canSwitch, true);
    const unit = await fetch(`${base}/api/settings/amount-unit`, { method: 'PUT', body: JSON.stringify({ amountUnit: 'rial' }), headers: { ...headers, 'content-type': 'application/json' } });
    assert.equal(unit.status, 200, await unit.clone().text());
    assert.equal((await unit.json()).amountUnit, 'rial');
    const status = await (await fetch(`${base}/api/settings/amount-unit`, { headers })).json();
    assert.deepEqual([status.amountUnit, status.label, status.locked], ['rial', 'ریال', false]);
    const after = await preview();
    assert.equal(after.data.unitAdvice, null);
    assert.equal(after.data.summary.importableCount, 5);
  } finally { child.kill(); }
});
