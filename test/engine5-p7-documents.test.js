import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
import { chequeSeriesCount, detectVoiceIntent, maskCoveragePhrases } from '../shared/voiceIntent.js';

/**
 * موتور ۵ — بستهٔ «سندهای پایهٔ دیگر»: چک، فاکتور، طلب و بدهی، قاعدهٔ تکرار،
 * صورت‌حساب بانک و رسید.
 *
 * حقیقت حسابداری یکی است، از هر سندی که بیاید: پولی که امروز بابت پوشش آینده
 * رفته پیش‌پرداخت است و ماه‌به‌ماه هزینه می‌شود؛ پولی که بابت پوشش آینده گرفته‌ایم
 * پیش‌دریافت است. ودیعه هرگز هزینه یا درآمد نیست. واقعیت کم پرسیده می‌شود و هیچ
 * سطر نقدی برای پولی که جابه‌جا نشده ساخته نمی‌شود. جمله‌های کاربر عیناً اینجا
 * می‌مانند.
 */

const NOW = new Date('2026-10-10T08:30:00.000Z');
const intent = (text) => detectVoiceIntent(text, { now: NOW });

// ---------------------------------------------------------------------------
// خوشهٔ cheque-due-date-from-coverage — دورهٔ پوشش سررسید چک نیست.
// ---------------------------------------------------------------------------

test('دورهٔ پوشش سررسید چک یا بدهی نمی‌شود — جمله‌های کاربر و خانواده', () => {
  for (const text of [
    'چک ۶۰ میلیونی اجاره شش ماه آینده رو از آقای احمدی گرفتیم',
    'اجاره شش ماه آینده رو با چک ۶۰ میلیونی به آقای رضایی دادیم',
    'اجاره از اول آبان تا آخر اسفند رو چک ۵۰ میلیونی به آقای رضایی دادیم',
    // رقم لاتین، «سه ماه بعد»، بیمه و اشتراک، بازه با سال، تایپ بی‌دقت، روز عددی.
    'اجاره 6 ماه آینده رو با چک 60 میلیونی به اقای رضایی دادیم',
    'اجاره سه ماه بعد رو چک ۳۰ میلیونی به آقای رضایی دادیم',
    'بیمه شش ماه آینده انبار رو با چک ۶ میلیونی به بیمه ایران دادیم',
    'اشتراک سه ماه آینده رو چک ۹ میلیونی به شرکت پارس دادیم',
    'اجاره از اول آبان ۱۴۰۵ تا پایان مهر ۱۴۰۶ رو چک ۱۲۰ میلیونی به آقای رضایی دادیم',
    'اجاره از اول ابان تا اخر اسفند رو چک ۵۰ میلیونی به اقای رضایی دادیم',
    'اجاره از ۱ آبان تا ۳۰ بهمن رو چک ۵۰ میلیونی به آقای رضایی دادیم',
    'اجاره آبان رو با چک ۵ میلیونی به آقای رضایی دادیم',
  ]) {
    const found = intent(text);
    assert.equal(found?.intent, 'cheque', text);
    assert.equal(found.dueAt, null, `${text} → ${found.dueAt}`);
  }
  // کارت طلب و بدهی همان خطا را داشت.
  for (const text of [
    'اجاره شش ماه آینده رو به آقای رضایی بدهکار شدیم ۶۰ میلیون',
    'بابت اجاره از اول آبان تا آخر اسفند آقای رضایی ۵۰ میلیون بهمون بدهکار شد',
  ]) {
    const found = intent(text);
    assert.equal(found?.intent, 'obligation', text);
    assert.equal(found.dueAt, null, text);
    assert.equal(found.occurredAt, null, text);
  }
});

test('تاریخی که با نشانه آمده یا مال خودِ چک است، می‌ماند', () => {
  const day = (iso) => iso && new Intl.DateTimeFormat('en-US-u-ca-persian', { timeZone: 'Asia/Tehran', month: 'numeric', day: 'numeric' }).format(new Date(iso));
  assert.equal(day(intent('یه چک ۱۰ میلیونی سررسید ۱۵ آذر به آقای رضایی دادیم').dueAt), '9/15');
  assert.equal(day(intent('اجاره شش ماه آینده رو چک ۶۰ میلیونی سررسید ۱۵ آذر به آقای رضایی دادیم').dueAt), '9/15');
  assert.equal(day(intent('اجاره شش ماه آینده دفتر رو چک ۶۰ میلیونی به تاریخ ۱ آذر به آقای رضایی دادیم').dueAt), '9/1');
  assert.equal(day(intent('آقای احمدی یه چک ۶۰ میلیونی به تاریخ ۲۰ آذر داد').dueAt), '9/20');
  // «چک … دو ماه دیگه» تاریخ خودِ چک است، نه پوشش خدمت.
  assert.ok(intent('چک ۱۰ میلیونی دو ماه دیگه به آقای رضایی دادیم').dueAt);
  assert.match(maskCoveragePhrases('چک ۱۰ میلیونی دو ماه دیگه'), /دو ماه دیگه/);
});

// ---------------------------------------------------------------------------
// خوشهٔ cheque-receivable-direction-third-person — «مستاجر … چک … داد».
// ---------------------------------------------------------------------------

test('چکی که طرف مقابل با فعل سوم‌شخص به ما داد، دریافتی است', () => {
  for (const text of [
    'مستاجر اجاره شش ماه آینده رو شش تا چک ۱۰ میلیونی داد',
    'آقای احمدی مستاجرمون اجاره شش ماه آینده رو یه چک ۶۰ میلیونی داد',
    'مستاجر برای اجاره یک سال ۱۲ تا چک ۱۰ میلیونی داد',
    'آقای احمدی بابت اشتراک یکساله نرم افزار چک ۲۴ میلیونی به ما داد',
    'آقای احمدی چک ۶۰ میلیونی اجاره شش ماه آینده رو بهمون داد',
    'مستاجرمون آقای احمدی چک شش ماه اجاره رو داد ۶۰ میلیون',
    'آقای احمدی یه چک ۵ میلیونی داد',
    'آقای احمدی یه چک ۵ میلیونی بهم داد',
    'آقای احمدی چک ۵ میلیونی دادن',
    'مشتری یه چک ۵ میلیونی داد',
    'اقای احمدی چک 5 میلیونی داد',
  ]) {
    const found = intent(text);
    assert.equal(found?.intent, 'cheque', text);
    assert.equal(found.direction, 'receivable', text);
  }
  // اول‌شخص همچنان پرداختی است.
  for (const text of [
    'یه چک ۵ میلیونی به آقای احمدی دادیم',
    'یه چک ۵ میلیونی دادم به آقای احمدی',
    'اجاره یکساله رو چک ۱۲۰ میلیونی به اقای رضایی دادیم',
    'بیمه آتش سوزی یکساله رو با چک ۱۲ میلیون به آقای کریمی دادیم',
  ]) assert.equal(intent(text)?.direction, 'payable', text);
  // میان دو نفر دیگر: جهتی برای ما ندارد، حدس زده نمی‌شود.
  assert.equal(intent('آقای احمدی یه چک ۵ میلیونی به آقای رضایی داد'), null);
});

// ---------------------------------------------------------------------------
// خوشهٔ cheque-series-count-dropped — «۱۲ تا چک ۱۰ میلیونی» یک چک نیست.
// ---------------------------------------------------------------------------

test('سری چک با جمع کامل و تعدادش خوانده می‌شود، نه یک قسط', () => {
  for (const [text, count, per, direction] of [
    ['اجاره یک سال رو ۱۲ تا چک ۱۰ میلیونی به آقای رضایی دادیم', 12, 10_000_000, 'payable'],
    ['برای اجاره دفتر شش تا چک ده میلیونی به آقای رضایی دادیم', 6, 10_000_000, 'payable'],
    ['شش فقره چک ده میلیونی بابت اجاره از مستاجر گرفتیم', 6, 10_000_000, 'receivable'],
    ['مستاجر اجاره شش ماه آینده رو شش تا چک ۱۰ میلیونی داد', 6, 10_000_000, 'receivable'],
    ['اجاره یک سال رو ۱۲تا چک ۱۰ میلیونی به آقای رضایی دادیم', 12, 10_000_000, 'payable'],
    ['دوازده تا چک ده میلیون تومنی به آقای رضایی دادیم', 12, 10_000_000, 'payable'],
    ['دوازده برگ چک ۵ میلیونی از آقای احمدی گرفتیم', 12, 5_000_000, 'receivable'],
    ['اقساط وام رو ۱۲ تا چک ۵ میلیونی به بانک ملت دادیم', 12, 5_000_000, 'payable'],
  ]) {
    const found = intent(text);
    assert.equal(found?.intent, 'cheque', text);
    assert.equal(found.direction, direction, text);
    assert.equal(found.chequeCount, count, text);
    assert.equal(found.perChequeAmount, per, text);
    assert.equal(found.amount, count * per, text);
  }
  // «۶ تا چک … ۶۰ میلیون» — هر برگ یا جمع؟ پرسیده می‌شود.
  const unclear = intent('شش تا چک دادیم ۶۰ میلیون به آقای رضایی');
  assert.equal(unclear.chequeCount, 6);
  assert.equal(unclear.needsAmount, true);
  assert.equal(unclear.amount, 0);
  // منفی‌ها: یک چک، و برگ‌های دسته‌چک.
  assert.equal(intent('یه چک ۶۰ میلیونی به آقای رضایی دادیم').chequeCount, undefined);
  assert.equal(intent('چک ۱۲۰ میلیونی اجاره یک سال به آقای رضایی دادیم').chequeCount, undefined);
  assert.equal(chequeSeriesCount('دسته چک پنجاه برگه گرفتیم'), 0);
  assert.equal(chequeSeriesCount('یه چک ۵ میلیونی'), 0);
});

// ---------------------------------------------------------------------------
// دیتابیس — مسیر ثبت.
// ---------------------------------------------------------------------------

process.env.DATABASE_PATH = tempDatabase('engine5-p7-documents');
process.env.ADMIN_USERNAME = 'p7-owner';
process.env.ADMIN_PASSWORD = 'p7-strong-password-3381';
const database = await import('../server/db.js');
const { activeWorkspaceDatabase } = await import('../server/db/core.js');
database.ensureAdmin();
const owner = database.authenticateUser('p7-owner', 'p7-strong-password-3381');
const freshWorkspace = (name) => database.createWorkspace(owner.id, { name, profileType: 'business' });
const inWorkspace = (workspace, callback) => database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
const lines = (entryId) => activeWorkspaceDatabase().prepare(`SELECT a.source_kind AS kind, a.name, l.debit, l.credit
  FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE l.entry_id=? ORDER BY l.debit DESC`).all(entryId)
  .map((line) => [line.kind, line.debit || line.credit]);
const schedule = (eventId) => ({ ...activeWorkspaceDatabase().prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
  FROM recognition_schedule_items WHERE event_id=? AND status<>'superseded'`).get(eventId) });
/** رویدادِ صف: نوع و مبلغی که حسابدار می‌بیند. */
const queuedEvent = (item) => ({ ...activeWorkspaceDatabase().prepare('SELECT kind,amount,route,status FROM financial_events WHERE id=?').get(item.id) });
const kindBalance = (kind) => activeWorkspaceDatabase().prepare(`SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) AS net
  FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id WHERE a.source_kind=?`).get(kind).net;

const engineOn = () => database.saveAutomationPolicy({ engineV2: true });

// ---------------------------------------------------------------------------
// خوشهٔ cheque-path-bypasses-engine — چک همان ماهیت پرداخت نقدی را دارد.
// ---------------------------------------------------------------------------

/** همان payload کارت چک در App.jsx: یادداشت = گفتهٔ کاربر. */
const voiceCheque = (text, extra = {}) => {
  const found = intent(text);
  return database.recordCheque({
    direction: found.direction, counterpartyName: found.contactName || extra.name, amount: found.amount,
    against: 'income', dueAt: found.dueAt, note: text, source: 'voice',
    ...(found.chequeCount > 1 ? { chequeCount: found.chequeCount, perChequeAmount: found.perChequeAmount } : {}),
    ...extra,
  });
};

for (const mode of ['engine-on', 'engine-off']) {
  test(`چک پرداختی اجاره، بیمه و لایسنس پیش‌پرداخت با برنامهٔ ماهانه است (${mode})`, () => inWorkspace(freshWorkspace(`چک پیش‌پرداخت ${mode}`), () => {
    if (mode === 'engine-on') engineOn();
    for (const [text, amount, months, prepaid, name] of [
      ['اجاره یک ساله دفتر رو با چک ۱۲۰ میلیون به آقای رضایی دادیم', 120_000_000, 12, 'پیش‌پرداخت — اجاره'],
      ['اجاره شش ماه آینده دفتر رو چک ۶۰ میلیونی به تاریخ ۱ آذر به آقای رضایی دادیم', 60_000_000, 6, 'پیش‌پرداخت — اجاره'],
      ['بیمه آتش سوزی یکساله رو با چک ۱۲ میلیون به بیمه ایران دادیم', 12_000_000, 12, 'پیش‌پرداخت — بیمه', 'بیمه ایران'],
      ['لایسنس یک ساله نرم افزار رو با چک ۲۴ میلیونی به شرکت همکاران سیستم دادیم', 24_000_000, 12, 'پیش‌پرداخت — نرم‌افزار و اشتراک'],
      ['یه چک ۱۲ میلیونی بابت بیمه یکساله انبار به بیمه ایران دادیم', 12_000_000, 12, 'پیش‌پرداخت — بیمه', 'بیمه ایران'],
      ['یه چک ۲۴ میلیونی بابت اشتراک یک ساله نرم افزار به شرکت پارس دادیم', 24_000_000, 12, 'پیش‌پرداخت — نرم‌افزار و اشتراک'],
    ]) {
      const cheque = voiceCheque(text, name ? { counterpartyName: name } : {});
      assert.ok(cheque.journalEntryId, text);
      assert.deepEqual(lines(cheque.journalEntryId), [['prepaid-asset', amount], ['cheque-payable', amount]], text);
      const accountName = activeWorkspaceDatabase().prepare(`SELECT a.name FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id
        WHERE l.entry_id=? AND l.debit>0`).get(cheque.journalEntryId).name;
      assert.equal(accountName, prepaid, text);
      assert.deepEqual(schedule(cheque.eventId), { count: months, total: amount }, text);
    }
    assert.equal(kindBalance('expense-category'), 0, 'هیچ هزینهٔ یک‌جایی ساخته نشد');
    // وصول چک فقط اسناد پرداختنی را با نقد می‌بندد.
    const first = database.listCheques({ status: 'open', direction: 'payable' })[0];
    database.clearCheque(first.id, { account: 'cash' });
    assert.equal(kindBalance('expense-category'), 0);
  }));
}

test('چک دریافتی مستاجر برای اجارهٔ آینده پیش‌دریافت است، نه فروش', () => inWorkspace(freshWorkspace('چک پیش‌دریافت'), () => {
  engineOn();
  for (const [text, extra] of [
    ['از آقای احمدی مستاجر بابت اجاره شش ماهه چک ۶۰ میلیونی گرفتیم', {}],
    ['چک ۶۰ میلیونی اجاره شش ماه آینده رو از آقای احمدی گرفتیم', {}],
    ['آقای احمدی چک ۶۰ میلیونی اجاره شش ماه آینده رو بهمون داد', {}],
    ['آقای احمدی بابت اشتراک یکساله نرم افزار چک ۲۴ میلیونی به ما داد', {}],
  ]) {
    const cheque = voiceCheque(text, extra);
    const amount = intent(text).amount;
    assert.deepEqual(lines(cheque.journalEntryId), [['cheque-receivable', amount], ['deferred-revenue', amount]], text);
    assert.ok(schedule(cheque.eventId).count >= 6, text);
    assert.equal(schedule(cheque.eventId).total, amount, text);
  }
  // فرم/API با یادداشت دوره.
  const form = database.recordCheque({ direction: 'receivable', counterpartyName: 'آقای رضایی', amount: 60_000_000, against: 'income',
    note: 'اجاره شش ماه آینده مغازه (آبان تا فروردین)' });
  assert.deepEqual(lines(form.journalEntryId), [['cheque-receivable', 60_000_000], ['deferred-revenue', 60_000_000]]);
  assert.equal(kindBalance('income-category'), 0, 'هیچ درآمدی امروز شناسایی نشد');
  // برگشت چک: طلب از مستاجر برمی‌گردد و پیش‌دریافت دست نمی‌خورد.
  database.bounceCheque(form.id);
  assert.equal(kindBalance('income-category'), 0);
  // ماه اول با اجرای شناسایی درآمد می‌شود.
  database.runRecognition();
  assert.ok(kindBalance('income-category') < 0, 'سهم ماه جاری شناسایی شد');
}));

test('ودیعه و رهن با چک: پرسش استرداد؛ ودیعهٔ مستاجر به حسابدار؛ هرگز هزینه یا درآمد', () => inWorkspace(freshWorkspace('چک ودیعه'), () => {
  engineOn();
  for (const text of ['ودیعه اجاره دفتر رو یه چک ۵۰ میلیونی به آقای رضایی دادیم', 'رهن مغازه رو با چک ۲۰۰ میلیونی به آقای رضایی دادیم']) {
    const cheque = voiceCheque(text);
    assert.equal(cheque.journalEntryId, null, text);
    assert.match(cheque.pendingQuestion, /استرداد/, text);
    // تا جواب نیامده وصول هم ممکن نیست.
    assert.throws(() => database.clearCheque(cheque.id, { account: 'cash' }), /منتظر/);
    database.answerEvent(cheque.eventId, { fact: 'refundable', value: true });
    const posted = database.approveEvent(cheque.eventId);
    assert.deepEqual(lines(posted.journalEntryId), [['refundable-deposit', intent(text).amount], ['cheque-payable', intent(text).amount]], text);
    assert.equal(database.clearCheque(cheque.id, { account: 'cash' }).status, 'cleared');
  }
  const tenant = voiceCheque('ودیعه مستاجر رو چک ۱۰۰ میلیونی از آقای احمدی گرفتیم');
  assert.equal(tenant.queuedForAccountant, true);
  assert.deepEqual(queuedEvent(tenant), { kind: 'cheque-received', amount: 100_000_000, route: 'accountant-review', status: 'pending' });
  assert.equal(kindBalance('expense-category'), 0);
  assert.equal(kindBalance('income-category'), 0);
}));

test('دورهٔ نامعلوم پرسیده می‌شود؛ دورهٔ گذشته هزینهٔ دوره است', () => inWorkspace(freshWorkspace('چک دوره'), () => {
  engineOn();
  const asked = voiceCheque('اجاره دفتر رو با چک ۵ میلیونی به آقای رضایی دادیم');
  assert.match(asked.pendingQuestion, /دورهٔ پوشش/);
  database.answerEvent(asked.eventId, { fact: 'servicePeriodStart', value: 'this-month' });
  database.answerEvent(asked.eventId, { fact: 'servicePeriodEnd', value: 'six-months' });
  const posted = database.approveEvent(asked.eventId);
  assert.deepEqual(lines(posted.journalEntryId), [['prepaid-asset', 5_000_000], ['cheque-payable', 5_000_000]]);
  // API با دستهٔ صریح «اجاره» و بی‌یادداشت هم یک‌جا هزینه نمی‌شود.
  const api = database.recordCheque({ direction: 'payable', counterpartyName: 'آقای رضایی', amount: 120_000_000, against: 'income', category: 'اجاره' });
  assert.match(api.pendingQuestion, /دورهٔ پوشش/);
  // اجارهٔ ماهِ گذشته با چک: هزینهٔ همان دوره.
  const elapsed = voiceCheque('اجاره شهریور دفتر رو با چک ۵ میلیونی به آقای رضایی دادیم');
  assert.deepEqual(lines(elapsed.journalEntryId), [['expense-category', 5_000_000], ['cheque-payable', 5_000_000]]);
}));

test('فرم بی‌شرح و بی‌دسته حدس نمی‌زند؛ چک کالا و فروش ساده همان قبلی است', () => inWorkspace(freshWorkspace('چک بی‌دسته'), () => {
  engineOn();
  const form = database.recordCheque({ direction: 'payable', counterpartyName: 'آقای رضایی', amount: 120_000_000, against: 'income', dueAt: '2026-11-22T08:30:00.000Z' });
  assert.equal(form.queuedForAccountant, true);
  assert.equal(queuedEvent(form).kind, 'cheque-issued');
  const received = database.recordCheque({ direction: 'receivable', counterpartyName: 'آقای احمدی', amount: 60_000_000, against: 'income' });
  assert.equal(received.queuedForAccountant, true);
  assert.equal(database.listCheques().length, 0, 'چک حدسی در دفتر چک ننشست');
  // منفی‌ها.
  const goods = database.recordCheque({ direction: 'payable', counterpartyName: 'شرکت پارس پلاست', amount: 40_000_000, against: 'income',
    note: 'چک دادیم برای خرید مواد اولیه ۴۰ میلیون به شرکت پارس پلاست' });
  assert.deepEqual(lines(goods.journalEntryId), [['inventory-unsplit', 40_000_000], ['cheque-payable', 40_000_000]]);
  const sale = database.recordCheque({ direction: 'receivable', counterpartyName: 'پخش نوین', amount: 12_000_000, against: 'income', category: 'فروش' });
  assert.deepEqual(lines(sale.journalEntryId), [['cheque-receivable', 12_000_000], ['income-category', 12_000_000]]);
  const saleVoice = voiceCheque('یه چک ۵ میلیونی بابت فروش کالا از آقای احمدی گرفتیم');
  assert.deepEqual(lines(saleVoice.journalEntryId), [['cheque-receivable', 5_000_000], ['income-category', 5_000_000]]);
}));

test('سری چک تک‌چک ثبت نمی‌شود؛ با جمع کامل به صف حسابدار می‌رود', () => inWorkspace(freshWorkspace('سری چک'), () => {
  engineOn();
  for (const [text, total, kind] of [
    ['اجاره یک سال رو ۱۲ تا چک ۱۰ میلیونی به آقای رضایی دادیم', 120_000_000, 'cheque-issued'],
    ['برای اجاره دفتر شش تا چک ده میلیونی به آقای رضایی دادیم', 60_000_000, 'cheque-issued'],
    ['شش فقره چک ده میلیونی بابت اجاره از مستاجر گرفتیم', 60_000_000, 'cheque-received'],
  ]) {
    const queued = voiceCheque(text, { counterpartyName: intent(text).contactName || 'مستاجر' });
    assert.equal(queued.queuedForAccountant, true, text);
    assert.deepEqual(queuedEvent(queued), { kind, amount: total, route: 'accountant-review', status: 'pending' }, text);
    assert.match(queued.queuedReason, /سری/);
  }
  assert.equal(database.listCheques().length, 0);
  assert.equal(kindBalance('cheque-payable') + kindBalance('cheque-receivable'), 0);
}));

// ---------------------------------------------------------------------------
// خوشه‌های obligation-* — طلب و بدهی از موتور تصمیم، ویرایش و حذف با سندش،
// و طرف حساب کارت صوتی.
// ---------------------------------------------------------------------------

/** همان payload کارت طلب/بدهی در App.jsx، با طرف حسابِ گفته‌شده. */
const voiceObligation = (text) => {
  const found = intent(text);
  assert.equal(found?.intent, 'obligation', text);
  return database.saveObligation({
    title: found.title, amount: found.amount, direction: found.direction,
    dueAt: found.dueAt || null, occurredAt: found.occurredAt || null,
    note: found.transcript.slice(0, 300), contactName: found.contactName || '',
  });
};
const openingOf = (obligation) => {
  const row = activeWorkspaceDatabase().prepare(`SELECT id,status,journal_entry_id AS journalEntryId FROM financial_events
    WHERE (source_event_id=? OR source_event_id LIKE ?) AND status NOT IN ('reversed','rejected') ORDER BY rowid DESC LIMIT 1`)
    .get(`obligation:${obligation.id}`, `obligation:${obligation.id}#r%`);
  return row ? { ...row } : null;
};
const decisionOf = (eventId) => ({ ...activeWorkspaceDatabase().prepare('SELECT treatment,decision_status AS status FROM accounting_decisions WHERE event_id=? ORDER BY rowid DESC LIMIT 1').get(eventId) });

for (const mode of ['engine-on', 'engine-off']) {
  test(`طلب و بدهی برای پوشش آینده پیش‌پرداخت یا پیش‌دریافت است، نه سایر هزینه/درآمد (${mode})`, () => inWorkspace(freshWorkspace(`تعهد دوره‌دار ${mode}`), () => {
    if (mode === 'engine-on') engineOn();
    for (const [text, amount, debitKind, creditKind, months] of [
      ['مستاجر اجاره شش ماه بعد رو ۶۰ میلیون بدهکاره', 60_000_000, 'customer-receivable', 'deferred-revenue', 6],
      ['آقای رضایی اجاره ۶ ماه آینده مغازه رو ۳۰ میلیون به ما بدهکاره', 30_000_000, 'customer-receivable', 'deferred-revenue', 6],
      ['اقای رضایی اجاره ي شش ماه آينده مغازه رو 30 ميليون بهمون بدهکاره', 30_000_000, 'customer-receivable', 'deferred-revenue', 6],
      ['اشتراک یک ساله نرم افزار رو ۲۴ میلیون به شرکت پارس بدهکاریم', 24_000_000, 'prepaid-asset', 'vendor-payable', 12],
      ['بیمه یک ساله انبار رو ۱۲ میلیون به بیمه ایران بدهکاریم', 12_000_000, 'prepaid-asset', 'vendor-payable', 12],
      ['لایسنس دو ساله آنتی ویروس ۸ میلیون به شرکت امن بدهکاریم', 8_000_000, 'prepaid-asset', 'vendor-payable', 24],
    ]) {
      const obligation = voiceObligation(text);
      const opened = openingOf(obligation);
      assert.equal(opened.status, 'posted', text);
      assert.deepEqual(lines(opened.journalEntryId), [[debitKind, amount], [creditKind, amount]], text);
      assert.deepEqual(schedule(opened.id), { count: months, total: amount }, text);
      assert.equal(obligation.dueAt, null, `دورهٔ پوشش سررسید نیست: ${text}`);
    }
    // فرم با یادداشت دوره: عنوان هم شاهد است.
    const form = database.saveObligation({ title: 'حق بیمه یکساله آتش سوزی انبار', contactName: 'بیمه ایران', amount: 12_000_000,
      direction: 'payable', note: 'پوشش ۱۸ مهر ۱۴۰۵ تا ۱۷ مهر ۱۴۰۶' });
    assert.deepEqual(lines(openingOf(form).journalEntryId), [['prepaid-asset', 12_000_000], ['vendor-payable', 12_000_000]]);
    assert.equal(kindBalance('expense-category'), 0);
    assert.equal(kindBalance('income-category'), 0);
  }));
}

test('طلب و بدهی: دورهٔ نامعلوم پرسیده می‌شود؛ منفی‌ها همان سند قبلی‌اند', () => inWorkspace(freshWorkspace('تعهد منفی'), () => {
  engineOn();
  const asked = database.saveObligation({ title: 'اجاره دفتر', contactName: 'آقای رضایی', amount: 5_000_000, direction: 'payable' });
  assert.equal(asked.journalStatus, 'pending');
  assert.equal(decisionOf(openingOf(asked).id).status, 'needs-user-input');
  // اجارهٔ ماهِ گذشته که هنوز نداده‌ایم: هزینهٔ همان دوره و بدهی.
  const past = voiceObligation('اجاره شهریور دفتر رو ۵ میلیون به آقای رضایی بدهکاریم');
  assert.deepEqual(lines(openingOf(past).journalEntryId), [['expense-category', 5_000_000], ['vendor-payable', 5_000_000]]);
  // فروش نسیهٔ کالا: درآمد همین حالا.
  const sale = database.saveObligation({ title: 'فروش گرانول', contactName: 'صنایع آریا', amount: 20_000_000, direction: 'receivable' });
  assert.deepEqual(lines(openingOf(sale).journalEntryId), [['customer-receivable', 20_000_000], ['income-category', 20_000_000]]);
  // قبض مصرف‌شده: هزینهٔ تعهدی.
  const bill = database.saveObligation({ title: 'قبض برق شهریور', contactName: 'اداره برق', amount: 9_000_000, direction: 'payable' });
  assert.deepEqual(lines(openingOf(bill).journalEntryId), [['expense-category', 9_000_000], ['vendor-payable', 9_000_000]]);
}));

test('کارت صوتی طلب و بدهی طرف حساب را وصل می‌کند؛ بی‌نام، حساب جعلی «طلب/بدهی» نمی‌سازد', () => inWorkspace(freshWorkspace('تعهد طرف حساب'), () => {
  engineOn();
  for (const text of [
    'اشتراک یک ساله نرم افزار رو ۲۴ میلیون به شرکت پارس بدهکاریم',
    'آقای رضایی ۵ میلیون به ما بدهکاره',
    'به شرکت البرز ۱۰ ميليون بدهكاريم',
    'اقای کریمی ۳ میلیون بهمون بدهکاره',
  ]) {
    const obligation = voiceObligation(text);
    assert.ok(obligation.contactId, text);
    const balances = database.ledgerSideBalances(obligation.contactId);
    assert.equal(balances.uncoveredPayable, 0, text);
    assert.equal(balances.uncoveredReceivable, 0, text);
    assert.ok(database.openDocumentsFor(obligation.contactId).some((doc) => doc.id === obligation.id), text);
  }
  const unnamed = voiceObligation('مستاجر اجاره شش ماه بعد رو ۶۰ میلیون بدهکاره');
  assert.equal(unnamed.contactId, null);
  const names = activeWorkspaceDatabase().prepare("SELECT name FROM ledger_accounts WHERE name LIKE '%طلب/بدهی%'").all();
  assert.deepEqual(names, [], 'هیچ زیرحسابی به نام عنوان پیش‌فرض ساخته نشد');
}));

test('ویرایش و حذف طلب/بدهی سند را هم عوض می‌کند؛ فهرست، کارت و دفتر یک عدد می‌گویند', () => inWorkspace(freshWorkspace('ویرایش تعهد'), () => {
  engineOn();
  const agree = (obligation, contactId, side) => {
    const balances = database.ledgerSideBalances(contactId);
    assert.equal(balances[side] + 0, obligation ? obligation.remaining : 0, `${side} دفتر`);
    assert.equal(balances[side === 'payable' ? 'uncoveredPayable' : 'uncoveredReceivable'] + 0, 0, 'بی‌پوشش');
  };
  // ۱۲ → ۶ (بیمهٔ نیم‌ساله) و بعد حذف.
  const insurer = database.saveContact({ name: 'بیمه ایران' });
  const policy = database.saveObligation({ title: 'حق بیمه یکساله آتش سوزی انبار', contactId: insurer.id, amount: 12_000_000, direction: 'payable' });
  agree(policy, insurer.id, 'payable');
  const halved = database.saveObligation({ id: policy.id, title: 'حق بیمه یکساله آتش سوزی انبار', contactId: insurer.id, amount: 6_000_000, direction: 'payable' });
  assert.equal(halved.remaining, 6_000_000);
  agree(halved, insurer.id, 'payable');
  assert.equal(kindBalance('prepaid-asset'), 6_000_000, 'پیش‌پرداخت هم با مبلغ تازه');
  assert.equal(database.deleteObligation(policy.id), true);
  agree(null, insurer.id, 'payable');
  assert.equal(kindBalance('prepaid-asset'), 0);
  assert.equal(database.listObligations({ status: 'all' }).find((item) => item.id === policy.id).status, 'cancelled');
  assert.throws(() => database.settleLedgerBalance(insurer.id, { direction: 'payable' }));
  // بالا بردن مبلغ و تسویه: بدهکارِ معکوس نمی‌ماند.
  const vendor = database.saveContact({ name: 'شرکت پخش البرز' });
  const debt = database.saveObligation({ title: 'بدهی خرید', contactId: vendor.id, amount: 2_000_000, direction: 'payable' });
  const raised = database.saveObligation({ id: debt.id, title: 'بدهی خرید', contactId: vendor.id, amount: 9_000_000, direction: 'payable' });
  database.settleObligation(raised.id, { account: 'cash' });
  agree(null, vendor.id, 'payable');
  // وارونه کردن جهت.
  const customer = database.saveContact({ name: 'آقای احمدی' });
  const flip = database.saveObligation({ title: 'حساب احمدی', contactId: customer.id, amount: 5_000_000, direction: 'receivable' });
  const flipped = database.saveObligation({ id: flip.id, title: 'حساب احمدی', contactId: customer.id, amount: 5_000_000, direction: 'payable' });
  assert.equal(database.ledgerSideBalances(customer.id).receivable + 0, 0);
  agree(flipped, customer.id, 'payable');
  // عوض کردن طرف حساب.
  const other = database.saveContact({ name: 'آقای کریمی' });
  const moved = database.saveObligation({ id: flip.id, title: 'حساب احمدی', contactId: other.id, amount: 5_000_000, direction: 'payable' });
  assert.equal(database.ledgerSideBalances(customer.id).payable + 0, 0);
  agree(moved, other.id, 'payable');
  // حذفِ تعهدِ بخشی‌تسویه‌شده رد می‌شود.
  const partial = database.saveObligation({ title: 'بدهی بخشی', contactId: vendor.id, amount: 10_000_000, direction: 'payable' });
  database.settleObligation(partial.id, { account: 'cash', amount: 4_000_000 });
  assert.throws(() => database.deleteObligation(partial.id), /تسویه/);
  assert.throws(() => database.saveObligation({ id: partial.id, title: 'بدهی بخشی', contactId: vendor.id, amount: 3_000_000, direction: 'payable' }), /تسویه/);
  // حذف تعهدی که سندش منتظر سؤال است: رویداد رد می‌شود و در صف نمی‌ماند.
  const pending = database.saveObligation({ title: 'اجاره دفتر', contactId: other.id, amount: 7_000_000, direction: 'payable' });
  const pendingEvent = openingOf(pending).id;
  database.deleteObligation(pending.id);
  assert.equal(activeWorkspaceDatabase().prepare('SELECT status FROM financial_events WHERE id=?').get(pendingEvent).status, 'rejected');
  // شناسهٔ ناشناخته ردیف بی‌سند نمی‌سازد.
  assert.throws(() => database.saveObligation({ id: 'no-such-obligation', title: 'x', amount: 1_000_000, direction: 'payable' }), /پیدا نشد/);
  // ویرایش عنوانِ تعهدِ پرداخت‌شده وضعیتش را «باز» نمی‌کند؛ وضعیت از بدنه خوانده نمی‌شود.
  const paid = database.saveObligation({ title: 'بدهی کوچک', contactId: vendor.id, amount: 1_000_000, direction: 'payable' });
  database.settleObligation(paid.id, { account: 'cash' });
  assert.equal(database.saveObligation({ id: paid.id, title: 'بدهی کوچک (فاکتور ۱۲)', contactId: vendor.id, amount: 1_000_000, direction: 'payable', status: 'open' }).status, 'paid');
  const open = database.saveObligation({ title: 'بدهی باز', contactId: vendor.id, amount: 2_000_000, direction: 'payable' });
  assert.equal(database.saveObligation({ id: open.id, title: 'بدهی باز', contactId: vendor.id, amount: 2_000_000, direction: 'payable', status: 'cancelled' }).status, 'open');
}));

// ---------------------------------------------------------------------------
// خوشهٔ invoice-path-bypasses-engine — فاکتور همان ماهیت پرداخت نقدی را دارد.
// ---------------------------------------------------------------------------

const { invoiceDraftPayload } = await import('../shared/voiceIntent.js');
const store = await import('../server/financialEventStore.js');
const ISSUED = '2026-10-10T08:30:00.000Z';
const invoiceJournal = (invoice) => activeWorkspaceDatabase().prepare(`SELECT id FROM journal_entries
  WHERE source_type='invoice' AND source_id=? AND entry_kind='normal' ORDER BY revision DESC LIMIT 1`).get(invoice.id)?.id;
const invoiceEvents = (invoice) => activeWorkspaceDatabase().prepare(`SELECT fe.id,fe.status,fe.journal_entry_id AS journalEntryId
  FROM financial_events fe JOIN invoice_items ii ON fe.source_event_id='invoice-line:' || ii.id WHERE ii.invoice_id=?`).all(invoice.id);
const accountNameOf = (entryId, kind) => activeWorkspaceDatabase().prepare(`SELECT a.name FROM journal_lines l JOIN ledger_accounts a ON a.id=l.account_id
  WHERE l.entry_id=? AND a.source_kind=?`).get(entryId, kind)?.name;
/** همان payload کارت فاکتور در App.jsx. */
const voiceInvoice = (text) => {
  const found = intent(text);
  assert.equal(found?.intent, 'invoice', text);
  const payload = invoiceDraftPayload(found);
  return { found, payload, item: database.createInvoice({ ...payload, documentType: found.documentType, customerName: found.contactName || '', ...(payload.issueNow ? { issuedAt: ISSUED } : {}) }) };
};

for (const mode of ['engine-on', 'engine-off']) {
  test(`فاکتور خرید بیمه، لایسنس و اجارهٔ شش‌ماهه پیش‌پرداخت با برنامهٔ ماهانه است (${mode})`, () => inWorkspace(freshWorkspace(`فاکتور خرید ${mode}`), () => {
    if (mode === 'engine-on') engineOn();
    for (const [category, items, amount, months, prepaid, contact] of [
      ['بیمه', [{ title: 'حق بیمه آتش سوزی یکساله انبار', unitPrice: 12_000_000 }], 12_000_000, 12, 'پیش‌پرداخت — بیمه', 'بیمه ایران'],
      ['نرم‌افزار و اشتراک', [{ title: 'لایسنس یک ساله نرم افزار حسابداری (مهر ۱۴۰۵ تا شهریور ۱۴۰۶)', unitPrice: 24_000_000 }], 24_000_000, 12, 'پیش‌پرداخت — نرم‌افزار و اشتراک', 'شرکت نرم افزاری'],
      ['اجاره', [{ title: 'اجاره شش ماهه دفتر', quantity: 6, unitPrice: 5_000_000 }], 30_000_000, 6, 'پیش‌پرداخت — اجاره', 'آقای رضایی'],
    ]) {
      const invoice = database.createInvoice({ documentType: 'purchase', category, customerName: contact, items, issueNow: true, issuedAt: ISSUED });
      assert.equal(invoice.status, 'sent', category);
      const entry = invoiceJournal(invoice);
      assert.deepEqual(lines(entry), [['prepaid-asset', amount], ['vendor-payable', amount]], category);
      assert.equal(accountNameOf(entry, 'prepaid-asset'), prepaid);
      const [event] = invoiceEvents(invoice);
      assert.equal(event.status, 'posted');
      assert.equal(event.journalEntryId, entry);
      assert.deepEqual(schedule(event.id), { count: months, total: amount }, category);
      // پرداخت فقط حساب پرداختنی را با بانک می‌بندد؛ هزینه‌ای نمی‌سازد.
      database.recordInvoicePayment(invoice.id, { account: 'cash', occurredAt: ISSUED });
    }
    assert.equal(kindBalance('expense-category'), 0, 'هیچ هزینهٔ یک‌جایی ساخته نشد');
    assert.equal(kindBalance('vendor-payable'), 0);
    // شناسایی ماه‌به‌ماه همان حساب پیش‌پرداخت را خالی می‌کند.
    const before = kindBalance('prepaid-asset');
    const run = store.postDueRecognitionItems(activeWorkspaceDatabase(), { today: '2026-12-25T00:00:00.000Z' });
    assert.ok(run.posted >= 3, JSON.stringify(run));
    assert.equal(kindBalance('expense-category') + kindBalance('prepaid-asset'), before);
  }));
}

test('فاکتور خرید با مالیات: مالیات و حساب پرداختنی همان قبلی؛ فقط سهم خدمت پیش‌پرداخت است', () => inWorkspace(freshWorkspace('فاکتور مالیات'), () => {
  const invoice = database.createInvoice({ documentType: 'purchase', category: 'بیمه', customerName: 'بیمه ایران', tax: 1_080_000,
    items: [{ title: 'حق بیمه آتش سوزی یکساله انبار', unitPrice: 12_000_000 }], issueNow: true, issuedAt: ISSUED });
  assert.deepEqual(lines(invoiceJournal(invoice)), [['prepaid-asset', 12_000_000], ['system', 1_080_000], ['vendor-payable', 13_080_000]]);
  assert.equal(accountNameOf(invoiceJournal(invoice), 'system'), 'اعتبار مالیات و عوارض خرید');
  assert.deepEqual(schedule(invoiceEvents(invoice)[0].id), { count: 12, total: 12_000_000 });
  assert.equal(kindBalance('expense-category'), 0);
}));

test('فاکتور فروش اشتراک یا پشتیبانی دوازده‌ماهه درآمد انتقالی است، نه فروش امروز', () => inWorkspace(freshWorkspace('فاکتور فروش'), () => {
  const form = database.createInvoice({ documentType: 'sales', category: 'خدمات', customerName: 'شرکت آلفا',
    items: [{ title: 'اشتراک دوازده ماهه نرم افزار (مهر ۱۴۰۵ تا شهریور ۱۴۰۶)', unitPrice: 36_000_000 }], issueNow: true, issuedAt: ISSUED });
  assert.deepEqual(lines(invoiceJournal(form)), [['customer-receivable', 36_000_000], ['deferred-revenue', 36_000_000]]);
  assert.deepEqual(schedule(invoiceEvents(form)[0].id), { count: 12, total: 36_000_000 });
  // جمله‌های کاربر، عیناً — با «صادر کن» و «صادرش کن».
  for (const [text, amount, contact] of [
    ['فاکتور فروش قرارداد پشتیبانی یک ساله ۲۴ میلیون برای شرکت بتا صادر کن', 24_000_000, 'شرکت بتا'],
    ['فاکتور فروش اشتراک دوازده ماهه نرم افزار ۳۶ میلیون به شرکت آلفا صادر کن', 36_000_000, 'شرکت آلفا'],
    ['فاکتور فروش اشتراک دوازده ماهه نرم افزار ۳۶ میلیون به شرکت آلفا صادرش کن', 36_000_000, 'شرکت آلفا'],
  ]) {
    const { found, item } = voiceInvoice(text);
    assert.equal(found.contactName, contact, `فعل صدور جزو نام نیست: ${text}`);
    assert.equal(item.status, 'sent', text);
    const entry = invoiceJournal(item);
    assert.deepEqual(lines(entry), [['customer-receivable', amount], ['deferred-revenue', amount]], text);
    assert.equal(accountNameOf(entry, 'customer-receivable'), `حساب دریافتنی — ${contact}`);
    assert.deepEqual(schedule(invoiceEvents(item)[0].id), { count: 12, total: amount }, text);
  }
  assert.equal(kindBalance('income-category'), 0, 'هیچ درآمد یک‌جایی ساخته نشد');
  // وصول فقط حساب دریافتنی را می‌بندد؛ درآمد همچنان ماه‌به‌ماه است.
  database.recordInvoicePayment(form.id, { account: 'cash', occurredAt: ISSUED });
  assert.equal(kindBalance('income-category'), 0);
}));

test('پیش‌نویس صوتی فاکتور خرید دستهٔ خدمت را از گفته می‌گیرد و صدورش پیش‌پرداخت است', () => inWorkspace(freshWorkspace('فاکتور صوتی خرید'), () => {
  for (const [text, category, amount, months] of [
    ['فاکتور خرید لایسنس یک ساله ۲۴ میلیون از شرکت نرم افزاری', 'نرم‌افزار و اشتراک', 24_000_000, 12],
    ['فاکتور خرید بیمه یک ساله انبار ۱۲ میلیون از بیمه ایران', 'بیمه', 12_000_000, 12],
    ['فاکتور خرید اجاره شش ماهه دفتر ۳۰ میلیون', 'اجاره', 30_000_000, 6],
    // تایپ بی‌دقت و رقم لاتین.
    ['فاکتور خريد بيمه يکساله انبار 12 میلیون از بیمه ایران', 'بیمه', 12_000_000, 12],
  ]) {
    const { payload, item } = voiceInvoice(text);
    assert.equal(payload.category, category, text);
    assert.equal(item.status, 'draft', text);
    assert.equal(item.category, category, text);
    const issued = database.issueInvoice(item.id, { issuedAt: ISSUED });
    const entry = invoiceJournal(issued);
    assert.deepEqual(lines(entry), [['prepaid-asset', amount], ['vendor-payable', amount]], text);
    assert.deepEqual(schedule(invoiceEvents(issued)[0].id), { count: months, total: amount }, text);
  }
  assert.equal(kindBalance('expense-category'), 0);
  // فاکتور کالا همان پیش‌فرض قبلی است.
  const goods = voiceInvoice('فاکتور فروش ۱۰ کیسه سیمان ۵ میلیون به آقای کریمی');
  assert.equal(goods.payload.category, undefined);
  assert.equal(goods.item.category, 'فروش');
}));

test('دورهٔ پوشش نامعلوم پرسیده می‌شود؛ هزینه یا درآمد یک‌جا ساخته نمی‌شود', () => inWorkspace(freshWorkspace('فاکتور بی‌دوره'), () => {
  // فرم با «همین حالا صادر کن»: پیش‌نویس می‌ماند و سؤال برمی‌گردد.
  const form = database.createInvoice({ documentType: 'purchase', category: 'اجاره', customerName: 'آقای رضایی',
    items: [{ title: 'اجاره دفتر', unitPrice: 5_000_000 }], issueNow: true, issuedAt: ISSUED });
  assert.equal(form.status, 'draft');
  assert.match(form.pendingQuestion, /دورهٔ پوشش/);
  assert.equal(invoiceJournal(form), undefined);
  // صدور بی‌جواب ۴۰۹ است، نه هزینهٔ یک‌جا.
  assert.throws(() => database.issueInvoice(form.id, { issuedAt: ISSUED }), (error) => error.status === 409 && error.code === 'INVOICE_SERVICE_QUESTION');
  assert.equal(database.getInvoice(form.id).status, 'draft');
  // جوابِ دوره همراه صدور: آبان تا دی → سه ماه پیش‌پرداخت.
  const issued = database.issueInvoice(form.id, { issuedAt: ISSUED, servicePeriodStart: '2026-10-23T00:00:00.000Z', servicePeriodEnd: '2027-01-19T00:00:00.000Z' });
  assert.equal(issued.status, 'sent');
  assert.deepEqual(lines(invoiceJournal(issued)), [['prepaid-asset', 5_000_000], ['vendor-payable', 5_000_000]]);
  assert.equal(schedule(invoiceEvents(issued)[0].id).total, 5_000_000);
  // صوت با «صادر کن» همان: پیش‌نویس با سؤال.
  const { item: spoken } = voiceInvoice('فاکتور خرید اجاره دفتر ۵ میلیون از آقای رضایی صادر کن');
  assert.equal(spoken.status, 'draft');
  assert.ok(spoken.pendingQuestion);
  // فاکتور فروش اشتراک بی‌دوره هم می‌پرسد (دستهٔ دوره‌دار درآمد: اجارهٔ مستاجر).
  const tenant = database.createInvoice({ documentType: 'sales', category: 'اجاره', customerName: 'آقای احمدی',
    items: [{ title: 'اجاره مغازه', unitPrice: 8_000_000 }], issueNow: true, issuedAt: ISSUED });
  assert.equal(tenant.status, 'draft');
  assert.equal(kindBalance('expense-category'), 0);
  assert.equal(kindBalance('income-category'), 0);
  // دورهٔ صریحِ فرم روی پیش‌نویس می‌ماند و صدور بعدی همان را می‌خواند.
  const draft = database.createInvoice({ documentType: 'purchase', category: 'نرم‌افزار و اشتراک', customerName: 'شرکت پارس',
    items: [{ title: 'اشتراک نرم افزار', unitPrice: 12_000_000 }], servicePeriodStart: '2026-10-23T00:00:00.000Z', servicePeriodEnd: '2027-10-22T00:00:00.000Z' });
  const later = database.issueInvoice(draft.id, { issuedAt: ISSUED });
  assert.deepEqual(lines(invoiceJournal(later)), [['prepaid-asset', 12_000_000], ['vendor-payable', 12_000_000]]);
  assert.equal(schedule(invoiceEvents(later)[0].id).count, 12);
}));

test('دورهٔ گذشته یا همین ماه هزینه و درآمد همان دوره است؛ منفی‌ها همان سند قبلی‌اند', () => inWorkspace(freshWorkspace('فاکتور منفی'), () => {
  const rentThisMonth = database.createInvoice({ documentType: 'purchase', category: 'اجاره', customerName: 'آقای رضایی',
    items: [{ title: 'اجاره مهر دفتر', unitPrice: 5_000_000 }], issueNow: true, issuedAt: ISSUED });
  assert.deepEqual(lines(invoiceJournal(rentThisMonth)), [['expense-category', 5_000_000], ['vendor-payable', 5_000_000]]);
  assert.equal(invoiceEvents(rentThisMonth).length, 0);
  const elapsed = database.createInvoice({ documentType: 'purchase', category: 'بیمه', customerName: 'بیمه ایران',
    items: [{ title: 'حق بیمه یکساله انبار', unitPrice: 12_000_000 }], issueNow: true, issuedAt: ISSUED,
    servicePeriodStart: '2025-09-23T00:00:00.000Z', servicePeriodEnd: '2026-09-22T00:00:00.000Z' });
  assert.deepEqual(lines(invoiceJournal(elapsed)), [['expense-category', 12_000_000], ['vendor-payable', 12_000_000]]);
  // فاکتور کالا، بیمهٔ تأمین اجتماعی، «سرور» بی‌دوره و فروش کالا: بی‌سؤال، مثل قبل.
  const goods = database.createInvoice({ documentType: 'purchase', customerName: 'پخش البرز', items: [{ title: 'چای', quantity: 10, unitPrice: 50_000 }], issueNow: true, issuedAt: ISSUED });
  assert.deepEqual(lines(invoiceJournal(goods)), [['expense-category', 500_000], ['vendor-payable', 500_000]]);
  assert.equal(accountNameOf(invoiceJournal(goods), 'expense-category'), 'مواد و کالا');
  const social = database.createInvoice({ documentType: 'purchase', category: 'بیمه', customerName: 'سازمان تامین اجتماعی',
    items: [{ title: 'بیمه تامین اجتماعی مهر', unitPrice: 7_000_000 }], issueNow: true, issuedAt: ISSUED });
  assert.equal(social.status, 'sent');
  assert.deepEqual(lines(invoiceJournal(social)), [['expense-category', 7_000_000], ['vendor-payable', 7_000_000]]);
  const server = database.createInvoice({ documentType: 'purchase', customerName: 'شرکت سخت افزار', items: [{ title: 'سرور اچ پی', unitPrice: 90_000_000 }], issueNow: true, issuedAt: ISSUED });
  assert.equal(server.status, 'sent');
  const sale = database.createInvoice({ documentType: 'sales', customerName: 'آقای کریمی', items: [{ title: 'چای', quantity: 10, unitPrice: 50_000 }], issueNow: true, issuedAt: ISSUED });
  assert.deepEqual(lines(invoiceJournal(sale)), [['customer-receivable', 500_000], ['income-category', 500_000]]);
  assert.equal(kindBalance('prepaid-asset'), 0);
  assert.equal(kindBalance('deferred-revenue'), 0);
}));

test('فاکتور چندردیفی: فقط ردیف خدمت دوره‌دار پیش‌پرداخت است؛ دستهٔ پیش‌فرض جای دستهٔ ردیف را می‌دهد', () => inWorkspace(freshWorkspace('فاکتور چندردیفی'), () => {
  const invoice = database.createInvoice({ documentType: 'purchase', customerName: 'بیمه ایران', note: 'یکساله',
    items: [{ title: 'چای', quantity: 10, unitPrice: 50_000 }, { title: 'حق بیمه آتش سوزی یکساله انبار', unitPrice: 12_000_000 }], issueNow: true, issuedAt: ISSUED });
  const entry = invoiceJournal(invoice);
  assert.deepEqual(lines(entry), [['prepaid-asset', 12_000_000], ['expense-category', 500_000], ['vendor-payable', 12_500_000]]);
  assert.equal(accountNameOf(entry, 'prepaid-asset'), 'پیش‌پرداخت — بیمه');
  assert.equal(invoiceEvents(invoice).length, 1);
}));

test('ابطال فاکتور خدمت: پیش‌پرداخت، شناسایی‌های گذشته و برنامهٔ آینده با هم برمی‌گردند', () => inWorkspace(freshWorkspace('ابطال فاکتور'), () => {
  const invoice = database.createInvoice({ documentType: 'purchase', category: 'بیمه', customerName: 'بیمه ایران',
    items: [{ title: 'حق بیمه آتش سوزی یکساله انبار', unitPrice: 12_000_000 }], issueNow: true, issuedAt: ISSUED });
  const [event] = invoiceEvents(invoice);
  const run = store.postDueRecognitionItems(activeWorkspaceDatabase(), { today: '2026-12-25T00:00:00.000Z' });
  assert.ok(run.posted >= 1);
  assert.ok(kindBalance('expense-category') > 0);
  assert.equal(database.deleteInvoice(invoice.id), true);
  assert.equal(kindBalance('expense-category'), 0);
  assert.equal(kindBalance('prepaid-asset'), 0);
  assert.equal(kindBalance('vendor-payable'), 0);
  assert.deepEqual(schedule(event.id), { count: 0, total: 0 });
  assert.equal(activeWorkspaceDatabase().prepare('SELECT status FROM financial_events WHERE id=?').get(event.id).status, 'reversed');
  // اجرای بعدی شناسایی از فاکتور ابطال‌شده چیزی نمی‌سازد.
  store.postDueRecognitionItems(activeWorkspaceDatabase(), { today: '2027-12-25T00:00:00.000Z' });
  assert.equal(kindBalance('expense-category'), 0);
}));
