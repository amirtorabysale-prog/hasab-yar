import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * چک — ابزار اصلی پرداخت، و تا امروز بدون چرخهٔ عمر.
 *
 * حساب‌یار چک را ثبت می‌کرد ولی هیچ راهی برای بستنش نبود: «اسناد دریافتنی»
 * تا ابد بدهکار می‌ماند. و بدتر، چکی که بابت طلب قبلی گرفته می‌شد دوباره
 * درآمد شناسایی می‌کرد — همان فروش دو بار در سود دوره و دو بار در مالیات.
 */
const databasePath = tempDatabase('cheques');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'cheque-owner';
process.env.ADMIN_PASSWORD = 'cheque-strong-password-4417';

const database = await import(`../server/db.js?cheque=${process.pid}`);
const accounting = await import(`../server/accounting.js?cheque=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('cheque-owner', 'cheque-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'کارخانهٔ پلاستیک', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

// حساب چک و حساب طرف حساب هر دو به تفکیک شخص‌اند، پس جمعِ همهٔ حساب‌های آن
// نوع گرفته می‌شود — نه اولین حسابی که پیدا شود.
const balanceOfKind = (sourceKind, like = '') => db().prepare(`SELECT COALESCE(SUM(journal_lines.debit)-SUM(journal_lines.credit),0) AS net
  FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
  WHERE ledger_accounts.source_kind=? AND ledger_accounts.name LIKE ?`).get(sourceKind, like ? `%${like}%` : '%').net;
const incomeTotal = () => db().prepare(`SELECT COALESCE(SUM(credit)-SUM(debit),0) AS net FROM journal_lines
  JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id WHERE ledger_accounts.type='income'`).get().net;

test('چک دریافتی بابت فروش تازه، اسناد دریافتنی و درآمد را می‌سازد', () => {
  inWorkspace(() => {
    const cheque = database.recordCheque({
      direction: 'receivable', counterpartyName: 'پخش نوین', amount: 12_000_000,
      dueAt: '2026-12-20T00:00:00.000Z', serial: '۴۴۱۷۸', bankName: 'ملت', category: 'فروش', against: 'income',
    });
    assert.equal(cheque.status, 'open');
    assert.equal(cheque.statusLabel, 'در جریان');
    assert.equal(balanceOfKind('cheque-receivable'), 12_000_000);
    assert.equal(incomeTotal(), 12_000_000);
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

/**
 * وصول، حق دریافت را به پول تبدیل می‌کند — نه درآمد تازه.
 *
 * درآمدش موقع ثبت چک شناسایی شده بود؛ شناسایی دوباره یعنی سود دوره دو برابر.
 */
test('وصول چک، پول می‌آورد و درآمد تازه نمی‌سازد', () => {
  inWorkspace(() => {
    const [open] = database.listCheques({ status: 'open', direction: 'receivable' });
    const before = incomeTotal();
    const cleared = database.clearCheque(open.id, { account: 'cash' });
    assert.equal(cleared.status, 'cleared');
    assert.equal(balanceOfKind('cheque-receivable'), 0, 'اسناد دریافتنی باید بسته شود');
    assert.equal(incomeTotal(), before, 'وصول نباید درآمد بسازد');
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

test('چک وصول‌شده دوباره وصول نمی‌شود', () => {
  inWorkspace(() => {
    const [cleared] = database.listCheques({ status: 'cleared' });
    assert.throws(() => database.clearCheque(cleared.id, { account: 'cash' }), (error) => error.code === 'CHEQUE_NOT_OPEN');
  });
});

/**
 * چک بابت طلب قبلی، درآمد دوباره نمی‌سازد.
 *
 * آن فروش قبلاً درآمد شده است. اینجا فقط شکل طلب عوض می‌شود: از حساب
 * دریافتنی به اسناد دریافتنی.
 */
test('چک بابت طلب قبلی فقط شکل طلب را عوض می‌کند', () => {
  inWorkspace(() => {
    const contact = database.saveContact({ name: 'صنایع آریا' });
    database.saveObligation({ title: 'فروش گرانول', amount: 20_000_000, direction: 'receivable', contactId: contact.id });
    const beforeIncome = incomeTotal();
    assert.equal(balanceOfKind('customer-receivable', 'آریا'), 20_000_000);

    database.recordCheque({
      direction: 'receivable', contactId: contact.id, counterpartyName: 'صنایع آریا',
      amount: 20_000_000, against: 'receivable',
    });
    assert.equal(incomeTotal(), beforeIncome, 'درآمد نباید دوباره شناسایی شود');
    assert.equal(balanceOfKind('customer-receivable', 'آریا'), 0, 'طلب عادی باید بسته شود');
    assert.equal(balanceOfKind('cheque-receivable'), 20_000_000, 'و به اسناد دریافتنی منتقل شود');
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

/**
 * چک برگشتی طلب را از بین نمی‌برد.
 *
 * فقط ابزارش باطل شده؛ مبلغ به حساب دریافتنیِ همان شخص برمی‌گردد و او دوباره
 * بدهکار می‌شود. پاک‌کردن چک به‌جای این کار، طلب را از دفتر حذف می‌کرد.
 */
test('چک برگشتی، بدهی شخص را برمی‌گرداند', () => {
  inWorkspace(() => {
    const [open] = database.listCheques({ status: 'open', direction: 'receivable' });
    const bounced = database.bounceCheque(open.id);
    assert.equal(bounced.status, 'bounced');
    assert.equal(bounced.statusLabel, 'برگشتی');
    assert.equal(balanceOfKind('cheque-receivable'), 0);
    assert.equal(balanceOfKind('customer-receivable', 'آریا'), 20_000_000, 'طلب باید برگردد');
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

test('چک پرداختی، اسناد پرداختنی می‌سازد و با پرداخت بسته می‌شود', () => {
  inWorkspace(() => {
    const cheque = database.recordCheque({
      direction: 'payable', counterpartyName: 'مواد شیمیایی پارس', amount: 6_000_000, category: 'مواد و کالا', against: 'income',
    });
    assert.equal(balanceOfKind('cheque-payable'), -6_000_000, 'اسناد پرداختنی بستانکار می‌شود');
    database.clearCheque(cheque.id, { account: 'cash' });
    assert.equal(balanceOfKind('cheque-payable'), 0);
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

/**
 * حساب چک باید به معین کدینگ نگاشت شود، وگرنه خروجی پارسیان قفل می‌ماند —
 * و این دقیقاً چیزی است که تا امروز اتفاق می‌افتاد، چون نقش چک در جدول
 * نگاشت خودکار نبود.
 */
test('حساب چک خودکار به معین اسناد دریافتنی نگاشت می‌شود', () => {
  inWorkspace(() => {
    database.installChartTemplate();
    database.applyChartSuggestions();
    const row = db().prepare(`SELECT chart_accounts.code AS code FROM ledger_accounts
      JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
      WHERE ledger_accounts.source_kind='cheque-receivable'`).get();
    assert.equal(row?.code, '1203');
  });
});

test.after(() => removeTempDatabase(databasePath));

test('چک بدون پاسخ «بابت چه؟» ثبت نمی‌شود', () => {
  // پیش‌فرض «معاملهٔ تازه» همان فروش را دو بار در درآمد می‌آورد وقتی چک بابت
  // طلب قبلی بود؛ مسیر صدا این را هیچ‌وقت نمی‌پرسید.
  inWorkspace(() => {
    assert.throws(() => database.recordCheque({ direction: 'receivable', counterpartyName: 'پخش نوین', amount: 5_000_000 }),
      /بابت معاملهٔ تازه است یا حساب قبلی/);
  });
});

/**
 * خانوادهٔ چرخهٔ چک بعد از ثبت: نزد بانک، پس‌گرفتن از بانک، وصول به همان بانک، واگذاری
 * به تأمین‌کننده، برگشت چک نزد بانک، تقویم سررسید و تاریخچه. منفی‌ها: چک پرداختی نه
 * واگذار می‌شود نه به بانک سپرده می‌شود؛ سپردن بی‌بانک رد می‌شود.
 */
test('نزد بانک: سند نمی‌خورد؛ وصول بی‌انتخاب حساب به همان بانک می‌نشیند', () => {
  inWorkspace(() => {
    const bank = database.saveAccount({ name: 'بانک صادرات جاری', kind: 'bank' });
    const cheque = database.recordCheque({ direction: 'receivable', counterpartyName: 'بازرگانی آریا', amount: 8_000_000,
      dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), category: 'فروش', against: 'income' });
    const entries = () => db().prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
    const before = entries();
    assert.throws(() => database.depositCheque(cheque.id, {}), /بانکی/);
    const deposited = database.depositCheque(cheque.id, { accountId: bank.id });
    assert.deepEqual([deposited.status, deposited.statusLabel, deposited.bankAccountId], ['deposited', 'نزد بانک', bank.id]);
    assert.equal(entries(), before, 'سپردن به بانک سند نمی‌سازد');
    // نزد بانک هنوز در جریان است: در خلاصه و تقویم.
    assert.ok(database.chequeSummary().openReceivable.total >= 8_000_000);
    assert.ok(database.chequeCalendar({ days: 30 }).days.some((day) => day.items.some((item) => item.id === cheque.id)));
    // پس‌گرفتن و سپردن دوباره.
    assert.equal(database.withdrawChequeDeposit(cheque.id).status, 'open');
    database.depositCheque(cheque.id, { accountId: bank.id });
    const cleared = database.clearCheque(cheque.id);
    assert.equal(cleared.status, 'cleared');
    const bankLine = db().prepare(`SELECT journal_lines.debit FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE journal_lines.entry_id=? AND ledger_accounts.source_key=?`).get(cleared.settledEntryId, bank.id);
    assert.equal(bankLine?.debit, 8_000_000, 'پول به بانکِ چک آمد، نه صندوق');
    assert.deepEqual(database.chequeHistory(cheque.id).map((row) => row.status), ['open', 'deposited', 'open', 'deposited', 'cleared']);
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

test('چک نزد بانک برگشت می‌خورد و طلب برمی‌گردد', () => {
  inWorkspace(() => {
    const bank = database.listAccounts().find((account) => account.name === 'بانک صادرات جاری');
    const cheque = database.recordCheque({ direction: 'receivable', counterpartyName: 'بازرگانی آریا', amount: 3_000_000, category: 'فروش', against: 'income' });
    database.depositCheque(cheque.id, { accountId: bank.id });
    assert.equal(database.bounceCheque(cheque.id).status, 'bounced');
    assert.throws(() => database.withdrawChequeDeposit(cheque.id), { code: 'CHEQUE_NOT_OPEN' });
  });
});

test('واگذاری چک مشتری به تأمین‌کننده: بدهی به گیرنده کم می‌شود، پولی جابه‌جا نمی‌شود، درآمدی ساخته نمی‌شود', () => {
  inWorkspace(() => {
    const cheque = database.recordCheque({ direction: 'receivable', counterpartyName: 'فروشگاه کیان', amount: 4_000_000, category: 'فروش', against: 'income' });
    const income = incomeTotal();
    const cash = () => db().prepare(`SELECT COALESCE(SUM(journal_lines.debit)-SUM(journal_lines.credit),0) AS net FROM journal_lines
      JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id WHERE ledger_accounts.source_kind='operational-account'`).get().net;
    const cashBefore = cash();
    assert.throws(() => database.transferCheque(cheque.id, {}), /گیرنده/);
    const transferred = database.transferCheque(cheque.id, { counterpartyName: 'تولیدی مهر' });
    assert.deepEqual([transferred.status, transferred.transferredTo], ['transferred', 'تولیدی مهر']);
    assert.equal(incomeTotal(), income);
    assert.equal(cash(), cashBefore);
    assert.equal(balanceOfKind('vendor-payable', 'تولیدی مهر'), 4_000_000, 'بدهکار شدن حساب پرداختنی گیرنده');
    assert.equal(balanceOfKind('cheque-receivable', 'فروشگاه کیان'), 0);
    // چک پرداختی واگذار نمی‌شود و به بانک سپرده نمی‌شود.
    const payable = database.recordCheque({ direction: 'payable', counterpartyName: 'تولیدی مهر', amount: 1_000_000, category: 'اجاره', against: 'income' });
    if (payable.id && !payable.queuedForAccountant) {
      assert.throws(() => database.transferCheque(payable.id, { counterpartyName: 'کسی' }), /فقط چک دریافتی/);
      assert.throws(() => database.depositCheque(payable.id, { account: 'cash' }), /فقط چک دریافتی/);
    }
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

test('تقویم سررسید: سررسیدگذشته جدا، روزها با خالص دریافتنی منهای پرداختنی', () => {
  inWorkspace(() => {
    const day = 86_400_000;
    database.recordCheque({ direction: 'receivable', counterpartyName: 'مشتری تقویم', amount: 2_000_000, dueAt: new Date(Date.now() - 3 * day).toISOString(), category: 'فروش', against: 'income' });
    const due = new Date(Date.now() + 10 * day).toISOString();
    database.recordCheque({ direction: 'receivable', counterpartyName: 'مشتری تقویم', amount: 5_000_000, dueAt: due, category: 'فروش', against: 'income' });
    database.recordCheque({ direction: 'payable', counterpartyName: 'مشتری تقویم', amount: 1_500_000, dueAt: due, against: 'receivable' });
    const calendar = database.chequeCalendar({ days: 30 });
    assert.ok(calendar.overdue.items.some((item) => item.amount === 2_000_000));
    const tenth = calendar.days.find((row) => row.items.some((item) => item.amount === 5_000_000));
    assert.ok(tenth.receivable >= 5_000_000 && tenth.payable >= 1_500_000);
    assert.equal(tenth.net, tenth.receivable - tenth.payable);
    assert.ok(!database.chequeCalendar({ days: 5 }).days.some((row) => row.items.some((item) => item.amount === 5_000_000)), 'بیرون از بازه نمی‌آید');
  });
});
