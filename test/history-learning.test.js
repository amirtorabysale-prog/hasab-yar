// یادگیری از سابقهٔ دفتر — بعد از ورود بکاپ پارسیان.
//
// خانوادهٔ رویداد:
//  - پرداخت ماهانه با مبلغ ثابت (اجاره) ← قاعدهٔ دوره‌ای از همان بانک.
//  - پرداخت ماهانه با مبلغ متغیر (قبض برق) ← فقط الگو و واژه؛ قاعده با مبلغ حدسی نه.
//  - دریافت ماهانه (اجارهٔ دریافتی) ← همان، در جهت درآمد.
//  - منفی‌ها: تسویهٔ ماهانهٔ بدهی به شرکت، خرید نسیهٔ ماهانه، خرج چندبار در ماه،
//    الگوی تمام‌شده، سند پیش‌نویس، واژه‌ای که به دو حساب رفته، نام شخص.
//  - مرز جهت: واژهٔ یادگرفتهٔ هزینه، جملهٔ «فروختیم» را هزینه نمی‌کند.
// دادهٔ آزمون ساختگی است (مخزن عمومی است).

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildParsianBackup } from './helpers/parsianBakFixture.js';

const GROUPS = [
  { Code: 11, CName: 'دارايي هاي جاري' }, { Code: 21, CName: 'بدهي هاي جاري' },
  { Code: 41, CName: 'فروش و درآمدها' }, { Code: 61, CName: 'هزينه هاي فعاليت' },
];

function historyTables({ lastMonth = 8 } = {}) {
  const kol = [
    { Code: 10, CName: 'صندوق', GroupCode: 11, iType: 0 },
    { Code: 11, CName: 'بانک ها', GroupCode: 11, iType: 0 },
    { Code: 23, CName: 'بستانکاران', GroupCode: 21, iType: 0 },
    { Code: 60, CName: 'درآمدها', GroupCode: 41, iType: 1 },
    { Code: 81, CName: 'هزینه های عمومی', GroupCode: 61, iType: 1 },
  ];
  const moeen = [
    { KolCode: 10, Code: 1, CName: 'صندوق' },
    { KolCode: 11, Code: 1, CName: 'بانک نمونه' },
    { KolCode: 23, Code: 1, CName: 'بستانکاران تجاري' },
    { KolCode: 60, Code: 1, CName: 'درآمد اجاره انبار' },
    { KolCode: 60, Code: 2, CName: 'درآمد خدمات' },
    { KolCode: 81, Code: 1, CName: 'هزینه اجاره دفتر' },
    { KolCode: 81, Code: 2, CName: 'هزینه آب و برق' },
    { KolCode: 81, Code: 3, CName: 'هزینه پذیرایی' },
    { KolCode: 81, Code: 4, CName: 'هزینه تعمیرات' },
    { KolCode: 81, Code: 5, CName: 'هزینه حمل' },
  ];
  const tafsili = [{ KolCode: 23, MoeenCode: 1, Code: 1, CName: 'شرکت نمونه آلفا' }];
  let id = 1;
  let sanad = 100;
  const document = [];
  const voucher = (date, rows) => {
    sanad += 1;
    for (const [kolCode, moeenCode, taf, bed, bes, comment] of rows) {
      document.push({ ID: id++, Sanad_Num: sanad, SanadDate: date, KolCode: kolCode, MoeenCode: moeenCode, TafsiliCode: taf, Comment: comment, Bed: bed, Bes: bes, SanadComment: null });
    }
  };
  const day = (month, value) => `1403/${String(month).padStart(2, '0')}/${String(value).padStart(2, '0')}`;
  // یک دریافت بزرگ تا بانک منفی نشود؛ یک‌باره است و الگو نمی‌سازد.
  voucher('1403/01/01', [[11, 1, 0, 2_000_000_000, 0, 'قرارداد خدمات'], [60, 2, 0, 0, 2_000_000_000, 'قرارداد خدمات']]);
  const electricity = [2_100_000, 2_650_000, 3_100_000, 2_400_000, 2_900_000, 3_300_000, 2_200_000, 2_750_000];
  for (let month = 1; month <= lastMonth; month += 1) {
    voucher(day(month, 2), [[81, 1, 0, 50_000_000, 0, `پرداخت اجاره دفتر ماه ${month}`], [11, 1, 0, 0, 50_000_000, 'اجاره دفتر']]);
    voucher(day(month, 11), [[81, 2, 0, electricity[month - 1], 0, 'قبض برق دفتر'], [11, 1, 0, 0, electricity[month - 1], 'قبض برق']]);
    voucher(day(month, 5), [[11, 1, 0, 12_000_000, 0, 'اجاره انبار'], [60, 1, 0, 0, 12_000_000, 'دریافت اجاره انبار از مستاجر']]);
    // تسویهٔ ماهانهٔ بدهی به شرکت: پول رفته ولی هزینه نیست — الگوی دوره‌ای نمی‌سازد.
    voucher(day(month, 20), [[23, 1, 1, 8_000_000, 0, 'تسویه بدهی شرکت نمونه آلفا'], [11, 1, 0, 0, 8_000_000, 'تسویه']]);
    // خرید نسیه ماهانه: پولی جابه‌جا نشده.
    voucher(day(month, 21), [[81, 3, 0, 1_000_000, 0, 'خرید نسیه شیرینی'], [23, 1, 1, 0, 1_000_000, 'نسیه']]);
    // خرج پذیرایی چند بار در ماه از صندوق: روزمره است، ماهانه نیست.
    for (const value of [3, 9, 17]) voucher(day(month, value), [[81, 3, 0, 300_000, 0, 'چای و قند'], [10, 1, 0, 0, 300_000, 'چای']]);
  }
  // «حمل» به دو حساب رفته: مبهم است و یاد گرفته نمی‌شود.
  for (const [month, moeenCode] of [[1, 4], [2, 5], [3, 4], [4, 5], [5, 4], [6, 5]]) {
    voucher(day(month, 25), [[81, moeenCode, 0, 700_000, 0, 'حمل بار'], [10, 1, 0, 0, 700_000, 'حمل']]);
  }
  // نام طرف حساب در شرح: «آلفا» واژهٔ دسته نیست.
  for (const month of [1, 2, 3, 4]) voucher(day(month, 26), [[81, 4, 0, 400_000, 0, 'تعمیر کولر آلفا'], [10, 1, 0, 0, 400_000, 'تعمیر']]);
  return {
    tbl_ACCGroup: GROUPS, tbl_Kol: kol, tbl_Moeen: moeen, tbl_Tafsili: tafsili, tbl_Document: document,
    tbl_AccSetting: [{ ID: 2, Cash_K: 0, Cash_M: 0, Cash_T: 0, Sell_K: 0, Sell_M: 0, Sell_T: 0, Wage_K: 0, Wage_M: 0, Wage_T: 0, Asset_K: 0, Asset_M: 0, Asset_T: 0 }],
    tbl_VATSetting: [{ ID: 6, VATSale_K: 0, VATSale_M: 0, VATSale_T: 0, VATBuy_K: 0, VATBuy_M: 0, VATBuy_T: 0 }],
  };
}

const tempPathModule = await import('./helpers/tempPath.js');
const databasePath = tempPathModule.tempDatabase('history-learning');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'history-owner';
process.env.ADMIN_PASSWORD = 'x-strong-password-1234';
const database = await import(`../server/db.js?history-learning=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('history-owner', 'x-strong-password-1234');
const newWorkspace = (name) => database.createWorkspace(owner.id, { name, profileType: 'business' });
const inWorkspace = (workspace, callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
test.after(() => tempPathModule.removeTempDatabase(databasePath));

const { commitParsianBackup } = await import(`../server/parsianImport.js?history=${process.pid}`);
const { completeParsianImport } = await import(`../server/parsianPhaseB.js?history=${process.pid}`);
const history = await import(`../server/historyLearning.js?history=${process.pid}`);
const { categoryLedgerAccount } = await import(`../server/accounting/ledgerAccounts.js?history=${process.pid}`);
const { parseFinancialText } = await import('../shared/parser.js');
const recurring = await import(`../server/db/recurring.js?history=${process.pid}`);

// «۸ آبان ۱۴۰۳»: یک ماه بعد از آخرین سند فیکسچر.
const NOW = new Date('2024-10-29T08:00:00Z');

function importHistory(active, options) {
  commitParsianBackup(active, buildParsianBackup(historyTables(options)), 'history.bak', {
    createdBy: owner.id, amountUnit: 'toman', kolTypes: { 60: 'income', 81: 'expense' },
  });
  completeParsianImport(active, { createdBy: owner.id });
}
const approveAll = (active) => active.prepare("UPDATE journal_entries SET approval_state='approved'").run();
const byAccount = (items, name) => items.filter((item) => item.accountName === name);

test('سند پیش‌نویس سابقه نیست: قبل از تأیید هیچ پیشنهادی ساخته نمی‌شود', () => {
  inWorkspace(newWorkspace('سابقه پیش‌نویس'), () => {
    const active = database.activeWorkspaceDatabase();
    importHistory(active);
    const result = history.refreshHistoryLessons(active);
    assert.equal(result.items.length, 0);
    assert.equal(result.analyzed.entries, 0);
  });
});

test('خانوادهٔ الگوی ماهانه: اجاره ثابت، قبض متغیر، اجارهٔ دریافتی — و هیچ تسویه، نسیه یا خرج روزمره', () => {
  inWorkspace(newWorkspace('سابقه الگو'), () => {
    const active = database.activeWorkspaceDatabase();
    importHistory(active);
    approveAll(active);
    const { recurring: patterns } = history.analyzeLedgerHistory(active);
    const names = patterns.map((item) => item.accountName).sort();
    assert.deepEqual(names, ['درآمد اجاره انبار', 'هزینه آب و برق', 'هزینه اجاره دفتر']);

    const [rent] = byAccount(patterns, 'هزینه اجاره دفتر');
    assert.equal(rent.type, 'expense');
    assert.equal(rent.amountMode, 'fixed');
    assert.equal(rent.amount, 50_000_000);
    assert.equal(rent.moneyAccountName, 'بانک نمونه');
    assert.equal(rent.dayOfMonth, 2);
    assert.equal(rent.months, 8);
    assert.equal(rent.title, 'اجاره دفتر');

    const [power] = byAccount(patterns, 'هزینه آب و برق');
    assert.equal(power.amountMode, 'variable');
    assert.equal(power.amountMin, 2_200_000);
    assert.equal(power.amountMax, 3_300_000);

    const [income] = byAccount(patterns, 'درآمد اجاره انبار');
    assert.equal(income.type, 'income');
    assert.equal(income.amountMode, 'fixed');
  });
});

test('الگوی تمام‌شده پیشنهاد نمی‌شود: آخرین تکرار خیلی پیش از آخرین سند دفتر', () => {
  inWorkspace(newWorkspace('سابقه کهنه'), () => {
    const active = database.activeWorkspaceDatabase();
    importHistory(active, { lastMonth: 4 });
    // یک سند ساده در آخر سال: دفتر تا اسفند ادامه داشته ولی اجاره از تیر قطع شده.
    const late = active.prepare(`SELECT id FROM journal_entries ORDER BY occurred_at DESC LIMIT 1`).get();
    active.prepare("UPDATE journal_entries SET occurred_at='2025-03-10T08:00:00.000Z' WHERE id=?").run(late.id);
    approveAll(active);
    const { recurring: patterns } = history.analyzeLedgerHistory(active);
    assert.equal(byAccount(patterns, 'هزینه اجاره دفتر').length, 0);
  });
});

test('خانوادهٔ واژه: فقط واژه‌ای که همیشه به یک حساب رفته، بی نام شخص و بی واژهٔ عمومی', () => {
  inWorkspace(newWorkspace('سابقه واژه'), () => {
    const active = database.activeWorkspaceDatabase();
    importHistory(active);
    approveAll(active);
    const keywords = new Map(history.analyzeLedgerHistory(active).keywords.map((item) => [item.keyword, item.accountName]));
    assert.equal(keywords.get('برق'), 'هزینه آب و برق');
    assert.equal(keywords.get('چای'), 'هزینه پذیرایی');
    assert.equal(keywords.get('کولر'), 'هزینه تعمیرات');
    // مبهم، عمومی یا نام طرف حساب.
    for (const word of ['حمل', 'بار', 'پرداخت', 'هزینه', 'آلفا', 'نمونه', 'تسویه', 'ماه']) assert.equal(keywords.has(word), false, word);
    // «قبض برق» تکرار «برق» است.
    assert.equal(keywords.has('قبض برق'), false);
  });
});

test('تأیید اجاره: قاعدهٔ دوره‌ای از همان بانک، روی همان حساب کدینگ، و برگشت یک‌جا', () => {
  inWorkspace(newWorkspace('سابقه تأیید'), () => {
    const active = database.activeWorkspaceDatabase();
    importHistory(active);
    approveAll(active);
    const listed = history.refreshHistoryLessons(active);
    const rent = listed.items.find((item) => item.kind === 'recurring' && item.accountName === 'هزینه اجاره دفتر');
    assert.equal(rent.category, 'هزینه اجاره دفتر');
    const decided = history.decideHistoryLesson(active, rent.id, { action: 'accept', actor: owner.id, saveRecurringRule: recurring.saveRecurringRule, now: NOW });
    assert.equal(decided.status, 'accepted');

    const rule = recurring.listRecurringRules().find((item) => item.id === decided.result.recurringId);
    const bank = database.listAccounts().find((account) => account.name === 'بانک نمونه');
    assert.equal(rule.amount, 50_000_000);
    assert.equal(rule.category, 'هزینه اجاره دفتر');
    assert.equal(rule.accountId, bank.id);
    // سررسید بعدی: ۲ آذر ۱۴۰۳، بعد از «امروز» آزمون.
    assert.ok(new Date(rule.nextDueAt) > NOW);

    // ثبت تازه با همین دسته روی همان حساب کدینگِ بکاپ می‌نشیند، نه حساب تازه.
    const ledger = active.prepare(`SELECT la.id FROM ledger_accounts la JOIN chart_accounts ca ON ca.id=la.chart_account_id WHERE ca.name='هزینه اجاره دفتر'`).get();
    assert.equal(categoryLedgerAccount(active, 'expense', 'هزینه اجاره دفتر'), ledger.id);

    // ثبت دوره‌ای در سررسید از بانک می‌رود.
    recurring.materializeRecurringRules(new Date(new Date(rule.nextDueAt).getTime() + 3_600_000));
    const posted = active.prepare("SELECT account_id AS accountId,amount,category FROM transactions WHERE note='ثبت خودکار دوره‌ای'").all().map((row) => ({ ...row }));
    assert.deepEqual(posted, [{ accountId: bank.id, amount: 50_000_000, category: 'هزینه اجاره دفتر' }]);

    // واژهٔ عنوان هم یاد گرفته شد.
    const learnings = database.getLearnings();
    assert.ok(learnings.some((item) => item.keyword === 'اجاره دفتر' && item.source === 'history' && item.type === 'expense'));

    const undone = history.forgetHistoryLessons(active, { deleteRecurringRule: recurring.deleteRecurringRule });
    assert.equal(undone.recurring, 1);
    assert.equal(database.getLearnings().filter((item) => item.source === 'history').length, 0);
    assert.equal(recurring.listRecurringRules().some((item) => item.id === rule.id), false);
    assert.equal(history.listHistoryLessons(active).items.find((item) => item.id === rent.id).status, 'pending');
  });
});

test('قبض متغیر قاعده با مبلغ حدسی نمی‌سازد؛ فقط واژه', () => {
  inWorkspace(newWorkspace('سابقه قبض'), () => {
    const active = database.activeWorkspaceDatabase();
    importHistory(active);
    approveAll(active);
    const power = history.refreshHistoryLessons(active).items.find((item) => item.kind === 'recurring' && item.accountName === 'هزینه آب و برق');
    const before = recurring.listRecurringRules().length;
    const decided = history.decideHistoryLesson(active, power.id, { action: 'accept', saveRecurringRule: recurring.saveRecurringRule, now: NOW });
    assert.equal(decided.result.recurringId, undefined);
    assert.equal(recurring.listRecurringRules().length, before);
  });
});

test('واژهٔ تأییدشده جملهٔ تازه را به همان حساب می‌برد؛ جهت جمله را عوض نمی‌کند؛ یادگیری دستی بی‌صدا عوض نمی‌شود', () => {
  inWorkspace(newWorkspace('سابقه پارسر'), () => {
    const active = database.activeWorkspaceDatabase();
    importHistory(active);
    approveAll(active);
    database.saveLearning({ keyword: 'چای', category: 'پذیرایی' });
    const items = history.refreshHistoryLessons(active).items;
    const power = items.find((item) => item.kind === 'keyword' && item.keyword === 'برق');
    history.decideHistoryLesson(active, power.id, { action: 'accept', now: NOW });

    const learnings = database.getLearnings();
    const paid = parseFinancialText('قبض برق دو میلیون و سیصد پرداخت کردم', { learnings }).transactions[0];
    assert.equal(paid.type, 'expense');
    assert.equal(paid.category, 'هزینه آب و برق');
    // «برق» اینجا موضوع فروش است؛ یادگیری هزینه جهت را برنمی‌گرداند.
    const sold = parseFinancialText('کابل برق اضافه رو فروختیم سه میلیون', { learnings }).transactions[0];
    assert.equal(sold.type, 'income');
    assert.notEqual(sold.category, 'هزینه آب و برق');

    const tea = items.find((item) => item.kind === 'keyword' && item.keyword === 'چای');
    assert.deepEqual(tea.conflict, { category: 'پذیرایی', source: 'manual' });
    assert.throws(() => history.decideHistoryLesson(active, tea.id, { action: 'accept', now: NOW }), (error) => error.code === 'HISTORY_LESSON_CONFLICT');
    assert.equal(database.getLearnings().find((item) => item.keyword === 'چای').category, 'پذیرایی');
  });
});

test('تحلیل دوباره تصمیم‌های قبلی را نگه می‌دارد و ردشده را برنمی‌گرداند', () => {
  inWorkspace(newWorkspace('سابقه تکرار'), () => {
    const active = database.activeWorkspaceDatabase();
    importHistory(active);
    approveAll(active);
    const first = history.refreshHistoryLessons(active).items;
    const dismissed = first.find((item) => item.kind === 'keyword');
    history.decideHistoryLesson(active, dismissed.id, { action: 'dismiss' });
    const second = history.refreshHistoryLessons(active).items;
    assert.equal(second.length, first.length);
    assert.equal(second.find((item) => item.id === dismissed.id).status, 'dismissed');
  });
});

test('نام ماه شمسی روز آخر را نگه می‌دارد: سررسید روز ۳۱ در ماه سی‌روزه روز آخر می‌شود', () => {
  const due = history.nextJalaliDue(31, new Date('2024-10-29T08:00:00Z'));
  // آبان ۳۰ روز است.
  assert.equal(new Intl.DateTimeFormat('en-US-u-ca-persian', { timeZone: 'Asia/Tehran', day: 'numeric', month: 'numeric' }).format(new Date(due)), '8/30');
});
