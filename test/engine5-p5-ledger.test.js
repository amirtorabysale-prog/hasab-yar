import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

/**
 * موتور ۵، بستهٔ دفتر — برنامهٔ شناسایی پیش‌پرداخت و درآمد انتقالی در تمام عمرش.
 *
 * حقیقت حسابداری: پولی که برای پوشش آینده رفته دارایی است و ماه‌به‌ماه هزینه
 * می‌شود؛ پولی که برای خدمت آینده آمده بدهی است و ماه‌به‌ماه درآمد می‌شود. جمع
 * اقلام دقیقاً همان مبلغی است که دارایی یا بدهی را ساخت، و هر جا آن پول برگردد،
 * برنامه هم برمی‌گردد. هر بخش این فایل یک خانواده است: مثبت‌ها و منفی‌ها، با
 * جملهٔ واقعی کاربر عیناً.
 */

process.env.DATABASE_PATH = tempDatabase('engine5-p5-ledger');
process.env.ADMIN_USERNAME = 'p5-ledger-owner';
process.env.ADMIN_PASSWORD = 'p5-ledger-strong-password-7741';
const database = await import('../server/db.js');
const store = await import('../server/financialEventStore.js');
const accounting = await import('../server/accounting.js');
const { parseFinancialText } = await import('../shared/parser.js');
const { normalizeFinancialEvent } = await import('../shared/financialEvent.js');
const { routeEvent } = await import('../shared/confidenceEngine.js');
const { decide } = await import('../shared/accountingDecision.js');
const { factsFromEvent } = await import('../shared/eventFacts.js');

database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);

const NOW = '2026-10-10T08:00:00.000Z'; // ۱۸ مهر ۱۴۰۵
const AZAR = '2026-12-01T00:00:00.000Z'; // ۱۰ آذر ۱۴۰۵
const ESFAND = '2027-03-01T00:00:00.000Z';
const LONG_AFTER = '2027-12-01T00:00:00.000Z';

/** هر خانواده دفتر خودش را دارد تا مانده‌ها از هم نشت نکنند. */
async function freshBook(name) {
  const workspace = database.createWorkspace(owner.id, { name, profileType: 'business' });
  const inBook = (callback) => database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
  let bank = null;
  await inBook(() => {
    database.installChartTemplate();
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true });
    bank = database.saveAccount({ name: 'جاری تجارت', kind: 'bank', bankId: 'tejarat', openingBalance: 500_000_000 });
  });
  return { workspace, inBook, bank };
}

const sql = () => database.activeWorkspaceDatabase();
/** ماندهٔ خالص (بدهکار منهای بستانکار) همهٔ حساب‌های یک منشأ. */
const net = (kind) => Number(sql().prepare(`SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) AS n FROM journal_lines l
  JOIN journal_entries j ON j.id=l.entry_id JOIN ledger_accounts a ON a.id=l.account_id
  WHERE a.source_kind=? AND j.approval_state='approved'`).get(kind).n);
const balances = () => ({
  prepaid: net('prepaid-asset'), expense: net('expense-category'),
  deferred: net('deferred-revenue'), income: net('income-category'),
});
const items = (eventId) => sql().prepare('SELECT key,period_key AS periodKey,recognition_date AS recognitionDate,amount,status FROM recognition_schedule_items WHERE event_id=? ORDER BY period_key').all(eventId);
const eventOf = (transactionId) => sql().prepare('SELECT * FROM financial_events WHERE source_event_id=?').get(`transaction:${transactionId}`);
const run = (today) => store.postDueRecognitionItems(sql(), { today, actor: owner.id });

/** همان راهی که گفتهٔ کاربر می‌رود: پارسر، ردیف تراکنش، رویداد، و تأیید کارت. */
function capture(text, { now = NOW, clientId = `c-${Math.random()}`, approve = true } = {}) {
  const rows = parseFinancialText(text, { source: 'voice', now: new Date(now) }).transactions || [];
  assert.ok(rows.length >= 1, `پارسر چیزی از «${text}» نخواند`);
  const [transactionId] = database.insertTransactions({ transcript: text, transactions: rows.map((row) => ({ ...row, occurredAt: row.occurredAt || now, userConfirmed: true, clientId })) });
  let event = eventOf(transactionId);
  if (approve && event.status === 'pending') { database.approveEvent(event.id); event = eventOf(transactionId); }
  return { transactionId, eventId: event.id, event };
}

// ---------------------------------------------------------------------------
// خانوادهٔ «لغو»: حذف، برگرداندن، برگرداندن و بازگرداندن، حذفِ ثبتِ AI، برگشت
// رویداد، رد در صف — همه باید برنامه را با خود ببرند.
// ---------------------------------------------------------------------------

const INSURANCE_YEAR = 'بیمه یک ساله انبار رو ۱۲ میلیون دادیم، ماهی یک میلیون';
const INSURANCE_SIX = 'بیمه شش ماهه دفتر رو امروز ۶ میلیون از حساب تجارت دادیم';
const RENT_RECEIVED = 'اجاره شش ماه آینده انبار رو ۳۰ میلیون از آقای کریمی پیش دریافت کردیم';
const RENT_AHEAD = 'اجاره ۶ ماه دفتر رو جلوتر دادیم ۳۰ میلیون، ماهی ۵ میلیون';

test('حذف تراکنش پیش‌پرداخت: سند پرداخت، شناسایی‌های ثبت‌شده و اقلام آینده همه برمی‌گردند', async () => {
  const { inBook } = await freshBook('لغو — حذف');
  await inBook(() => {
    const first = capture(INSURANCE_YEAR);
    assert.equal(first.event.status, 'posted');
    assert.equal(run(AZAR).posted, 3);
    assert.deepEqual([balances().prepaid, balances().expense], [9_000_000, 3_000_000]);

    database.deleteTransaction(first.transactionId);
    assert.equal(eventOf(first.transactionId).status, 'reversed', 'رویداد پشت تراکنشِ حذف‌شده بسته می‌شود');
    assert.ok(items(first.eventId).every((item) => item.status === 'superseded'), 'هیچ قلم زنده‌ای نمی‌ماند');
    assert.deepEqual([balances().prepaid, balances().expense], [0, 0], 'پیش‌پرداخت صفر، هزینه صفر');
    assert.equal(run(ESFAND).posted, 0, 'اجرای بعدی برای پولی که برگشته هزینه نمی‌سازد');
    assert.deepEqual([balances().prepaid, balances().expense], [0, 0]);
    // پیام قفل ویرایش می‌گوید «حذفش کن و دوباره ثبت کن»: ثبت دوبارهٔ درست فقط
    // همان شش میلیون را هزینه می‌کند.
    const second = capture(INSURANCE_SIX);
    run(LONG_AFTER);
    assert.equal(second.event.status, 'posted');
    assert.deepEqual([balances().prepaid, balances().expense], [0, 6_000_000]);
  });
});

test('برگرداندن آخرین ثبت و بازگرداندنش: فقط یک برنامهٔ زنده می‌ماند', async () => {
  const { inBook } = await freshBook('لغو — برگرداندن');
  await inBook(() => {
    const first = capture(INSURANCE_SIX);
    // «برگرداندن» در App.jsx همان حذف آخرین ثبت است.
    database.deleteTransaction(first.transactionId);
    assert.equal(run(LONG_AFTER).posted, 0, 'پس از برگرداندن، هیچ هزینه‌ای برای پولی که از بانک نرفت');
    assert.deepEqual([balances().prepaid, balances().expense], [0, 0]);

    const restored = database.redoTransaction(first.transactionId);
    // بازگرداندن مثل هر ثبت تازه از کارت تأیید می‌گذرد.
    if (eventOf(restored.id).status === 'pending') database.approveEvent(eventOf(restored.id).id);
    assert.equal(eventOf(restored.id).status, 'posted');
    run(LONG_AFTER);
    assert.deepEqual([balances().prepaid, balances().expense], [0, 6_000_000], 'یک پرداخت، یک بار هزینه');
  });
});

test('برگشت رویداد پیش‌پرداخت از پرونده: شناسایی‌های گذشته معکوس و اقلام آینده باطل می‌شوند', async () => {
  const { inBook } = await freshBook('لغو — برگشت پیش‌پرداخت');
  await inBook(() => {
    const paid = capture(INSURANCE_SIX);
    assert.equal(run(AZAR).posted, 3);
    database.reverseEvent(paid.eventId, 'اشتباه ثبت شد');
    assert.deepEqual([balances().prepaid, balances().expense], [0, 0]);
    assert.ok(items(paid.eventId).every((item) => item.status === 'superseded'));
    assert.deepEqual(run(LONG_AFTER), { posted: 0, blocked: 0, skipped: 0 }, 'اقلام باطل دیگر در هیچ اجرایی دیده نمی‌شوند');
  });
});

test('آینه: برگشت درآمد انتقالیِ اجارهٔ پیش‌دریافت، طرف حساب را بدهکار نشان نمی‌دهد', async () => {
  const { inBook } = await freshBook('لغو — برگشت درآمد انتقالی');
  await inBook(() => {
    const received = capture(RENT_RECEIVED);
    assert.equal(received.event.status, 'posted');
    assert.equal(items(received.eventId).length, 6);
    assert.equal(run(AZAR).posted, 3);
    assert.deepEqual([balances().deferred, balances().income], [-15_000_000, -15_000_000]);
    database.reverseEvent(received.eventId, 'اشتباه ثبت شد');
    assert.deepEqual([balances().deferred, balances().income], [0, 0], 'نه بدهکاری مستأجر، نه درآمدِ دریافتِ برگشته');
  });
});

test('رد در صف: برنامهٔ ساخته‌شده در لحظهٔ ضبط باطل می‌شود', async () => {
  const { inBook } = await freshBook('لغو — رد');
  await inBook(() => {
    const queued = capture(RENT_AHEAD, { approve: false });
    if (queued.event.status === 'pending') {
      database.rejectEvent(queued.eventId, 'این پرداخت انجام نشده بود');
    } else {
      database.reverseEvent(queued.eventId, 'این پرداخت انجام نشده بود');
    }
    assert.ok(items(queued.eventId).length > 0, 'برنامه در لحظهٔ ضبط ساخته شده بود');
    assert.ok(items(queued.eventId).every((item) => item.status === 'superseded'));
  });
});

test('حذف ثبتِ تأییدشده از فهم AI: برنامهٔ همان پرداخت هم بسته می‌شود', async () => {
  const { inBook, bank } = await freshBook('لغو — مسیر AI');
  const SAID = 'پیش پرداخت بیمه اتش سوزی به مبلغ 12 میلیون به بیمه دی بابت بیمه انبار .تایم پوشش 1 ساله ماهیانه 1 میلیون .از حساب تجارت';
  const none = { op: null, of: [] };
  const modelSaid = {
    event: { kind: 'advance-paid', description: 'پیش‌پرداخت بیمه آتش‌سوزی برای بیمه انبار از حساب تجارت', status: 'done' },
    amounts: [
      { id: 'a1', value: 12_000_000, currency: null, role: 'deposit', status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence: 'به مبلغ 12 میلیون' },
      { id: 'a2', value: 1_000_000, currency: null, role: 'unit-price', status: 'context', partOf: null, basis: 'explicit', computedFrom: none, evidence: 'ماهیانه 1 میلیون' },
    ],
    nonAmountNumbers: [], dates: [],
    counterparties: [{ id: 'c1', name: 'بیمه دی', role: 'supplier', evidence: 'به بیمه دی' }],
    movements: [{ id: 'm1', amountRef: 'a1', direction: 'out', from: { kind: 'bank', name: 'تجارت' }, to: { kind: 'counterparty', name: 'بیمه دی' }, evidence: 'از حساب تجارت' }],
    subject: { what: 'بیمه آتش‌سوزی انبار', kind: 'service', use: 'internal', delivered: 'unknown', usefulLifeMonths: null, evidence: 'بیمه انبار' },
    conditions: [], ambiguities: [],
  };
  const fetcher = async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(modelSaid) }] }], usage: { input_tokens: 1, output_tokens: 1 } }) });
  await inBook(async () => {
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all' });
    const item = await database.createUnderstandingCase({ text: SAID, clientId: 'ai-cancel-1' }, { fetcher, env: { OPENAI_API_KEY: 'test-key-not-real', OPENAI_UNDERSTANDING_MODEL: 'test-model' }, now: new Date(NOW) });
    assert.equal(item.status, 'ready', JSON.stringify(item.plan?.questions));
    assert.equal(item.plan.components[0].accountId, bank.id);
    database.commitUnderstandingCase(item.id, { now: new Date(NOW) });
    const event = sql().prepare("SELECT * FROM financial_events WHERE status='posted' AND json_extract(journal_source,'$.type')='transaction'").get();
    assert.ok(event, 'ثبت AI روی یک تراکنش نشسته است');
    run(AZAR);
    database.deleteTransaction(JSON.parse(event.journal_source).id);
    run(LONG_AFTER);
    assert.deepEqual([balances().prepaid, balances().expense], [0, 0]);
  });
});

test('پنجرهٔ اجرا با اقلام رویدادهای ردشده یا منتظر پر نمی‌شود', async () => {
  const { inBook } = await freshBook('لغو — گرسنگی');
  await inBook(() => {
    const yearOf = (index, occurredAt) => normalizeFinancialEvent({
      kind: 'cash-expense', amount: 12_000_000, occurredAt, category: 'بیمه', accountId: 'cash',
      servicePeriodStart: occurredAt, servicePeriodEnd: new Date(new Date(occurredAt).getTime() + 364 * 86_400_000).toISOString(),
      evidence: `بیمه یکساله شمارهٔ ${index}`,
    });
    const record = (event, source) => store.recordFinancialEvent(sql(), event, {
      sourceEventId: source, decision: routeEvent({ kind: event.kind }, { blockers: ['تأیید لازم است'] }),
      actor: owner.id, accountingDecision: decide(factsFromEvent(event), { today: event.occurredAt }),
    });
    // ۴۵ پیش‌پرداخت یک‌ساله در فروردین ۱۴۰۴ که در صف رد شدند، و ۴۵ تای دیگر که
    // هنوز منتظرند: ۱۰۸۰ قلم کهنه پیش از قلم‌های واقعی.
    for (let index = 0; index < 90; index += 1) {
      const created = record(yearOf(index, '2025-03-25T08:00:00.000Z'), `stale:${index}`);
      if (index % 2 === 0) store.rejectFinancialEvent(sql(), created.id, { actor: owner.id, reason: 'تکراری بود' });
    }
    const real = capture('بیمه یک ساله دفتر رو امروز ۱۲ میلیون از حساب تجارت دادیم');
    assert.equal(real.event.status, 'posted');
    for (let attempt = 0; attempt < 3; attempt += 1) run(AZAR);
    const posted = items(real.eventId).filter((item) => item.status === 'posted').map((item) => item.periodKey);
    assert.deepEqual(posted, ['1405-07', '1405-08', '1405-09']);
    assert.deepEqual([balances().prepaid, balances().expense], [9_000_000, 3_000_000]);
  });
});

test('منفی: برگشت رویدادی که ماهِ شناسایی‌شده‌اش بسته شده، رد می‌شود و هیچ چیز را عوض نمی‌کند', async () => {
  const { inBook } = await freshBook('لغو — دورهٔ بسته');
  await inBook(() => {
    const paid = capture(INSURANCE_SIX);
    run(AZAR);
    const before = { balances: balances(), schedule: items(paid.eventId), status: eventOf(paid.transactionId).status };
    sql().prepare("INSERT INTO accounting_periods (period,status) VALUES ('1405-08','locked')").run();
    assert.throws(() => database.reverseEvent(paid.eventId, 'اشتباه ثبت شد'), { code: 'ACCOUNTING_PERIOD_LOCKED' });
    assert.deepEqual({ balances: balances(), schedule: items(paid.eventId), status: eventOf(paid.transactionId).status }, before);
    sql().prepare("UPDATE accounting_periods SET status='open' WHERE period='1405-08'").run();
  });
});

test('ترمیم دفتر قدیمی: رویداد یتیمِ تراکنشِ حذف‌شده و اقلام رویداد ردشده بسته می‌شوند', async () => {
  const { inBook } = await freshBook('لغو — ترمیم');
  await inBook(() => {
    const orphan = capture(INSURANCE_YEAR);
    run(AZAR);
    // حالتِ پیش از این اصلاح: حذف فقط سند تراکنش را معکوس می‌کرد.
    accounting.reverseTransactionJournal(sql(), orphan.transactionId, NOW, { memo: 'حذف قدیمی' });
    sql().prepare("UPDATE transactions SET status='deleted' WHERE id=?").run(orphan.transactionId);
    const rejected = capture(RENT_AHEAD, { approve: false });
    sql().prepare("UPDATE financial_events SET status='rejected' WHERE id=?").run(rejected.eventId);
    sql().prepare("UPDATE recognition_schedule_items SET status='planned' WHERE event_id=?").run(rejected.eventId);
    assert.deepEqual([balances().prepaid, balances().expense], [-3_000_000, 3_000_000], 'وضعیت خراب پیش از ترمیم');

    store.repairCancelledSchedules(sql());
    assert.equal(sql().prepare('SELECT status FROM financial_events WHERE id=?').get(orphan.eventId).status, 'reversed');
    assert.deepEqual([balances().prepaid, balances().expense], [0, 0]);
    assert.ok(items(rejected.eventId).every((item) => item.status === 'superseded'));
    // ترمیم دوباره چیزی را دوباره معکوس نمی‌کند.
    store.repairCancelledSchedules(sql());
    assert.deepEqual([balances().prepaid, balances().expense], [0, 0]);
  });
});

test('منفی: حذف یک هزینهٔ سادهٔ بی‌برنامه همان مسیر همیشگی را دارد', async () => {
  const { inBook } = await freshBook('لغو — هزینهٔ ساده');
  await inBook(() => {
    const fuel = capture('بنزین ۵۰۰ هزار تومان از صندوق دادیم');
    assert.equal(items(fuel.eventId).length, 0);
    database.deleteTransaction(fuel.transactionId);
    assert.equal(balances().expense, 0);
  });
});

// ---------------------------------------------------------------------------
// خانوادهٔ «ارزش افزوده»: برنامه همان خالصی را پخش می‌کند که دارایی یا بدهی را
// ساخت؛ مالیات یک بار اعتبار یا بدهی مالیاتی است، نه دوباره هزینه یا درآمد.
// ---------------------------------------------------------------------------

async function vatBook(name, { registered = true } = {}) {
  const book = await freshBook(name);
  if (registered) await book.inBook(() => database.saveTaxRate({ name: 'ارزش افزوده ۱۰', rate: 10, treatment: 'taxable', isDefault: true }));
  return book;
}
const plannedTotal = (eventId) => items(eventId).filter((item) => item.status !== 'superseded').reduce((sum, item) => sum + item.amount, 0);
const planLine = (eventId, role) => JSON.parse(sql().prepare('SELECT posting_plan FROM financial_events WHERE id=?').get(eventId).posting_plan)
  .lines.find((line) => line.role === role);

test('اشتراک یک‌ساله با ارزش افزوده: برنامه روی خالص پیش‌پرداخت، پیش‌پرداخت در پایان صفر', async () => {
  const { inBook } = await vatBook('ارزش افزوده — اشتراک');
  await inBook(() => {
    const paid = capture('اشتراک یک ساله نرم افزار رو امروز ۱۰۹ میلیون با ارزش افزوده از حساب تجارت پرداخت کردیم');
    assert.equal(paid.event.status, 'posted');
    assert.equal(planLine(paid.eventId, 'prepaid-asset').debit, 99_090_909);
    assert.equal(planLine(paid.eventId, 'vat-input').debit, 9_909_091);
    assert.equal(plannedTotal(paid.eventId), 99_090_909, 'جمع برنامه = بدهکار پیش‌پرداخت');
    run('2028-01-01T00:00:00.000Z');
    assert.deepEqual([balances().prepaid, balances().expense], [0, 99_090_909], 'مالیات دوباره هزینه نمی‌شود');
  });
});

test('بیمهٔ یک‌ساله با ارزش افزوده از مسیر پاسخ به سؤال: برنامه روی خالص', async () => {
  const { inBook } = await vatBook('ارزش افزوده — پاسخ');
  await inBook(() => {
    const said = capture('حق بیمه یک‌ساله ۱۱۰ میلیون با ارزش افزوده پرداخت کردم', { approve: false });
    if (said.event.status === 'pending') {
      database.answerEvent(said.eventId, { fact: 'servicePeriodStart', value: 'this-month' });
      database.answerEvent(said.eventId, { fact: 'servicePeriodEnd', value: 'one-year' });
      database.approveEvent(said.eventId, { reason: 'حسابدار: تفکیک بررسی شد' });
    }
    assert.equal(planLine(said.eventId, 'prepaid-asset').debit, 100_000_000);
    assert.equal(plannedTotal(said.eventId), 100_000_000);
    run('2028-01-01T00:00:00.000Z');
    assert.deepEqual([balances().prepaid, balances().expense], [0, 100_000_000]);
  });
});

test('آینه: اجارهٔ پیش‌دریافت با ارزش افزوده — درآمد خالص شناسایی و درآمد انتقالی صفر می‌شود', async () => {
  const { inBook } = await vatBook('ارزش افزوده — پیش‌دریافت');
  await inBook(() => {
    const received = capture('اجاره یک ساله انبار رو از مستاجر امروز ۱۱۰ میلیون با ارزش افزوده پیش دریافت کردیم به حساب تجارت');
    if (received.event.status !== 'posted') database.approveEvent(received.eventId, { reason: 'حسابدار: تفکیک بررسی شد' });
    assert.equal(planLine(received.eventId, 'deferred-revenue').credit, 100_000_000);
    assert.equal(plannedTotal(received.eventId), 100_000_000);
    run('2028-01-01T00:00:00.000Z');
    assert.deepEqual([balances().deferred, balances().income], [0, -100_000_000], 'درآمد = خالص، بدهی مالیات جدا می‌ماند');
  });
});

test('منفی: دفتر نامشمول و جملهٔ بی‌واژهٔ ارزش افزوده، برنامه همان کل مبلغ است', async () => {
  const unregistered = await vatBook('ارزش افزوده — نامشمول', { registered: false });
  await unregistered.inBook(() => {
    const paid = capture('اشتراک یک ساله نرم افزار رو امروز ۱۰۹ میلیون با ارزش افزوده از حساب تجارت پرداخت کردیم');
    assert.equal(plannedTotal(paid.eventId), 109_000_000);
    run('2028-01-01T00:00:00.000Z');
    assert.deepEqual([balances().prepaid, balances().expense], [0, 109_000_000]);
  });
  const registered = await vatBook('ارزش افزوده — بی‌واژه');
  await registered.inBook(() => {
    const paid = capture('اشتراک یک ساله نرم افزار رو امروز ۱۲۰ میلیون از حساب تجارت پرداخت کردیم');
    assert.equal(plannedTotal(paid.eventId), 120_000_000);
  });
});

// ---------------------------------------------------------------------------
// خانوادهٔ «تاریخ شناسایی»: هیچ سند شناسایی‌ای پیش از سند نقدیِ خودش نمی‌نشیند؛
// سهم ماه‌های گذشتهٔ پوشش همان روز پرداخت یا دریافت شناسایی می‌شود.
// ---------------------------------------------------------------------------

/** تاریخ سند نقدی رویداد و تاریخ همهٔ سندهای شناسایی‌اش. */
function recognitionDates(eventId) {
  const event = sql().prepare('SELECT journal_entry_id AS entryId FROM financial_events WHERE id=?').get(eventId);
  const paidAt = sql().prepare('SELECT occurred_at AS at FROM journal_entries WHERE id=?').get(event.entryId).at;
  const recognized = sql().prepare(`SELECT j.occurred_at AS at FROM recognition_schedule_items i
    JOIN journal_entries j ON j.id=i.journal_entry_id WHERE i.event_id=? ORDER BY j.occurred_at`).all(eventId).map((row) => row.at);
  return { paidAt, recognized };
}
/** ماندهٔ یک منشأ تا یک لحظه — همان چیزی که ترازِ تاریخ‌دار نشان می‌دهد. */
const netThrough = (kind, through) => Number(sql().prepare(`SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) AS n FROM journal_lines l
  JOIN journal_entries j ON j.id=l.entry_id JOIN ledger_accounts a ON a.id=l.account_id
  WHERE a.source_kind=? AND j.approval_state='approved' AND j.occurred_at<=?`).get(kind, through).n);
const hourBefore = (iso) => new Date(new Date(iso).getTime() - 3_600_000).toISOString();

test('پوشش از وسط ماه: شناسایی ماه اول روز پرداخت است، نه اول ماه', async () => {
  const { inBook } = await freshBook('تاریخ — وسط ماه');
  await inBook(() => {
    const paid = capture('امروز بیمه یک ساله ماشین رو ۱۲ میلیون از حساب تجارت دادیم');
    run(AZAR);
    const { paidAt, recognized } = recognitionDates(paid.eventId);
    assert.equal(recognized.length, 3);
    assert.ok(recognized.every((at) => at >= paidAt), JSON.stringify({ paidAt, recognized }));
    assert.equal(netThrough('prepaid-asset', hourBefore(paidAt)), 0, 'پیش از پرداخت، پیش‌پرداخت بستانکار نیست');
    assert.equal(netThrough('expense-category', hourBefore(paidAt)), 0);
  });
});

test('پوشش از فروردین، پرداخت در مهر: سهم ماه‌های گذشته همان روز پرداخت هزینه می‌شود', async () => {
  const { inBook } = await freshBook('تاریخ — فروردین');
  await inBook(() => {
    const paid = capture('امروز بیمه یک ساله انبار از اول فروردین تا آخر اسفند رو ۱۲ میلیون دادیم');
    assert.equal(items(paid.eventId).length, 12);
    run('2026-10-11T00:00:00.000Z');
    const { paidAt, recognized } = recognitionDates(paid.eventId);
    assert.equal(recognized.length, 7, 'فروردین تا مهر');
    assert.ok(recognized.every((at) => at === paidAt), 'همه روز پرداخت');
    assert.equal(netThrough('prepaid-asset', '2026-10-05T00:00:00.000Z'), 0, 'تراز ۱۳ مهر هیچ پیش‌پرداخت منفی‌ای ندارد');
    assert.equal(netThrough('expense-category', '2026-09-22T00:00:00.000Z'), 0, 'فروردین تا شهریور بی‌صدا بازنویسی نمی‌شوند');
    assert.deepEqual([balances().prepaid, balances().expense], [5_000_000, 7_000_000]);
  });
});

test('پوشش از شهریور، پرداخت در مهر: شهریور و مهر روز پرداخت، باقی اول ماه خودشان', async () => {
  const { inBook } = await freshBook('تاریخ — شهریور');
  await inBook(() => {
    const paid = capture('اجاره دفتر از اول شهریور تا آخر بهمن رو امروز ۳۰ میلیون از حساب تجارت دادیم');
    const schedule = items(paid.eventId);
    assert.equal(schedule.length, 6);
    const paidAt = paid.event.occurred_at;
    assert.ok(schedule.every((item) => item.recognitionDate >= paidAt));
    assert.equal(schedule[0].periodKey, '1405-06', 'قلم همچنان مال ماه پوشش خودش است');
    assert.equal(schedule[2].recognitionDate.slice(0, 10), '2026-10-23', 'آبان از اول آبان');
  });
});

test('آینه: درآمد انتقالی هم پیش از دریافت شناسایی نمی‌شود — وسط ماه و پوشش گذشته', async () => {
  const { inBook } = await freshBook('تاریخ — درآمد انتقالی');
  await inBook(() => {
    const received = capture('اجاره شش ماه آینده انبار رو ۳۰ میلیون از آقای کریمی پیش دریافت کردیم');
    run(AZAR);
    const mid = recognitionDates(received.eventId);
    assert.ok(mid.recognized.length >= 2 && mid.recognized.every((at) => at >= mid.paidAt), JSON.stringify(mid));
    assert.equal(netThrough('deferred-revenue', hourBefore(mid.paidAt)), 0, 'درآمد انتقالی پیش از دریافت بدهکار نیست');

    // اجارهٔ یک‌سالهٔ از فروردین که مهر دریافت شده — از مسیر رویداد.
    const event = normalizeFinancialEvent({
      kind: 'cash-income', amount: 120_000_000, occurredAt: NOW, category: 'اجاره', accountId: 'cash',
      counterparty: 'مستأجر انبار', servicePeriodStart: '2026-03-21T08:30:00.000Z', servicePeriodEnd: '2027-03-20T08:30:00.000Z',
      evidence: 'اجاره یک‌سالهٔ انبار از فروردین را مهر پیش گرفتیم',
    });
    const created = store.recordFinancialEvent(sql(), event, {
      sourceEventId: 'deferred-farvardin', decision: routeEvent({ kind: event.kind }, { blockers: ['تأیید لازم است'] }),
      actor: owner.id, accountingDecision: decide(factsFromEvent(event), { today: NOW }),
    });
    store.approveFinancialEvent(sql(), created.id, { actor: owner.id });
    run('2026-10-11T00:00:00.000Z');
    const farvardin = recognitionDates(created.id);
    assert.equal(farvardin.recognized.length, 7);
    assert.ok(farvardin.recognized.every((at) => at >= farvardin.paidAt));
    assert.equal(netThrough('income-category', '2026-09-22T00:00:00.000Z'), 0, 'درآمد فروردین تا شهریور پیش از دریافت نیست');
  });
});

test('منفی: پوششی که بعد از پرداخت شروع می‌شود، اقلامش اول ماه خودشان می‌مانند', async () => {
  const { inBook } = await freshBook('تاریخ — پوشش آینده');
  await inBook(() => {
    const said = capture('بیمه انبار ۱۲ میلیون از حساب تجارت دادیم', { approve: false });
    assert.equal(said.event.status, 'pending');
    database.answerEvent(said.eventId, { fact: 'servicePeriodStart', value: 'next-month' });
    database.answerEvent(said.eventId, { fact: 'servicePeriodEnd', value: 'one-year' });
    const schedule = items(said.eventId);
    assert.equal(schedule.length, 12);
    assert.equal(schedule[0].periodKey, '1405-08');
    assert.equal(schedule[0].recognitionDate.slice(0, 10), '2026-10-23', 'اول آبان، نه روز پرداخت');
  });
});

test('منفی: پوششی که کاملاً گذشته، هزینهٔ همان روز است و برنامه‌ای ندارد', async () => {
  const { inBook } = await freshBook('تاریخ — پوشش گذشته');
  await inBook(() => {
    const paid = capture('اجاره دفتر از اول فروردین تا آخر شهریور رو ۶ میلیون دادیم');
    assert.equal(store.decisionForEvent(sql(), paid.eventId).treatment, 'period-expense');
    assert.equal(items(paid.eventId).length, 0);
  });
});

test('برنامهٔ خالص: کف تاریخ، کلید و ماهِ قلم را عوض نمی‌کند', async () => {
  const { buildMonthlySchedule } = await import('../shared/recognitionSchedule.js');
  const base = { amount: 12_000_000, periodStart: '2026-03-21T08:30:00.000Z', periodEnd: '2027-03-20T08:30:00.000Z', sourceId: 'evt-floor' };
  const plain = buildMonthlySchedule(base);
  const floored = buildMonthlySchedule({ ...base, notBefore: NOW });
  assert.deepEqual(floored.map((item) => [item.key, item.periodKey, item.amount]), plain.map((item) => [item.key, item.periodKey, item.amount]));
  assert.ok(floored.slice(0, 7).every((item) => item.recognitionDate === new Date(NOW).toISOString()));
  assert.deepEqual(floored.slice(7).map((item) => item.recognitionDate), plain.slice(7).map((item) => item.recognitionDate));
  // تاریخِ نامعتبر کف را حذف می‌کند، نه برنامه را.
  assert.deepEqual(buildMonthlySchedule({ ...base, notBefore: 'نامعتبر' }), plain);
});

// ---------------------------------------------------------------------------
// خانوادهٔ «دورهٔ بسته»: قلمی که دورهٔ بسته جلویش را گرفته زنده می‌ماند، دیده
// می‌شود، با بازگشایی دوره ثبت می‌شود یا با تأیید صریح حسابدار در نخستین دورهٔ باز.
// ---------------------------------------------------------------------------

const lock = (period) => sql().prepare("INSERT INTO accounting_periods (period,status) VALUES (?,'locked') ON CONFLICT(period) DO UPDATE SET status='locked'").run(period);
const reopen = (period) => accounting.reopenAccountingPeriod(sql(), period, owner.id, 'بازگشایی برای ثبت شناسایی جامانده');
const auditStages = (eventId, stage) => store.financialEventAudit(sql(), eventId).filter((row) => row.stage === stage);

test('پوشش گذشته در ماه‌های بسته: روز پرداخت شناسایی می‌شود و چیزی جا نمی‌ماند', async () => {
  const { inBook } = await freshBook('دورهٔ بسته — پوشش گذشته');
  await inBook(() => {
    for (const month of ['01', '02', '03', '04', '05', '06']) lock(`1405-${month}`);
    const paid = capture('امروز بیمه یک ساله انبار از اول فروردین تا آخر اسفند رو ۱۲ میلیون دادیم');
    assert.equal(paid.event.status, 'posted');
    assert.ok(items(paid.eventId).every((item) => item.status === 'planned'), 'هیچ قلمی در دورهٔ بسته نمی‌افتد');
    run('2027-04-01T00:00:00.000Z');
    assert.deepEqual([balances().prepaid, balances().expense], [0, 12_000_000]);
  });
});

test('ماهی که پیش از اجرا بسته شد و بعد باز شد: بی‌ردپای تکراری منتظر می‌ماند و بعد ثبت می‌شود', async () => {
  const { inBook } = await freshBook('دورهٔ بسته — بازگشایی');
  await inBook(() => {
    const paid = capture('امروز بیمه یک ساله ماشین رو ۱۲ میلیون از حساب تجارت دادیم');
    lock('1405-08');
    assert.deepEqual(run(AZAR), { posted: 2, blocked: 1, skipped: 0 });
    assert.deepEqual(run(AZAR), { posted: 0, blocked: 1, skipped: 0 }, 'اجرای دوباره همان قلم را فقط می‌شمارد');
    assert.equal(auditStages(paid.eventId, 'recognition-blocked').length, 1, 'ردپای مسدودشدن یک بار');
    const [listed] = database.blockedRecognition().items;
    assert.equal(listed.periodKey, '1405-08');
    assert.match(listed.reason, /1405-08/);
    assert.equal(database.reviewQueue().blockedRecognition.length, 1, 'در صف حسابدار دیده می‌شود');

    reopen('1405-08');
    assert.equal(run(AZAR).posted, 1, 'دوره باز شد، قلم ثبت شد');
    assert.equal(database.blockedRecognition().items.length, 0);
    run(LONG_AFTER);
    assert.deepEqual([balances().prepaid, balances().expense], [0, 12_000_000], 'پایان پوشش: هیچ دارایی جامانده‌ای نیست');
  });
});

test('آینه: درآمد انتقالی هم با بازگشایی دوره به درآمد می‌رسد', async () => {
  const { inBook } = await freshBook('دورهٔ بسته — درآمد انتقالی');
  await inBook(() => {
    capture(RENT_RECEIVED);
    lock('1405-08');
    assert.equal(run(AZAR).blocked, 1);
    reopen('1405-08');
    run(LONG_AFTER);
    assert.deepEqual([balances().deferred, balances().income], [0, -30_000_000], 'هیچ بدهی درآمد انتقالی پس از ارائهٔ خدمت نمی‌ماند');
  });
});

test('ثبت جبرانی حسابدار: با دلیل، در نخستین دورهٔ باز و با ردپای دورهٔ اصلی', async () => {
  const { inBook } = await freshBook('دورهٔ بسته — ثبت جبرانی');
  await inBook(() => {
    const paid = capture('امروز بیمه یک ساله ماشین رو ۱۲ میلیون از حساب تجارت دادیم');
    lock('1405-08');
    run(AZAR);
    const [blocked] = database.blockedRecognition().items;
    assert.throws(() => store.postBlockedRecognitionCatchUp(sql(), blocked.key, { reason: 'کوتاه', today: AZAR }), { code: 'REVIEW_REASON_REQUIRED' });
    const result = store.postBlockedRecognitionCatchUp(sql(), blocked.key, { reason: 'آبان بسته و گزارش شده؛ در آذر ثبت شود', actor: owner.id, today: AZAR });
    assert.equal(result.period, '1405-09', 'نخستین دورهٔ باز پس از آبان');
    assert.equal(accounting.periodForDate(sql().prepare('SELECT occurred_at AS at FROM journal_entries WHERE id=?').get(result.journalEntryId).at), '1405-09');
    const [trail] = auditStages(paid.eventId, 'recognition-catch-up');
    assert.equal(trail.detail.originalPeriod, '1405-08');
    assert.match(trail.detail.reason, /آذر/);
    assert.throws(() => store.postBlockedRecognitionCatchUp(sql(), blocked.key, { reason: 'دوباره ثبت شود لطفاً', today: AZAR }), { code: 'RECOGNITION_NOT_BLOCKED' });
    assert.equal(sql().prepare("SELECT COUNT(*) AS n FROM accounting_periods WHERE period='1405-08' AND status='locked'").get().n, 1, 'دورهٔ بسته باز نشد');
    run(LONG_AFTER);
    assert.deepEqual([balances().prepaid, balances().expense], [0, 12_000_000]);
  });
});

test('قلمی که در لحظهٔ ضبط در دورهٔ بسته می‌افتد، مورد را با نام دوره و تاریخ به صف حسابدار می‌برد', async () => {
  const { inBook } = await freshBook('دورهٔ بسته — لحظهٔ ضبط');
  await inBook(() => {
    lock('1405-09');
    const paid = capture('امروز بیمه یک ساله ماشین رو ۱۲ میلیون از حساب تجارت دادیم', { approve: false });
    assert.equal(paid.event.status, 'pending');
    assert.equal(paid.event.route, 'accountant-review');
    assert.ok(JSON.parse(paid.event.confidence).reasons.some((reason) => /1405-09/.test(reason)), paid.event.confidence);
    assert.equal(store.decisionForEvent(sql(), paid.eventId).decisionStatus, 'decided', 'تصمیم حسابداری عوض نشده؛ فقط مسیر');
    assert.equal(items(paid.eventId).find((item) => item.periodKey === '1405-09').status, 'blocked-closed-period');
    assert.equal(auditStages(paid.eventId, 'recognition-blocked').length, 1);
    database.approveEvent(paid.eventId);
    assert.equal(database.blockedRecognition().items.length, 1);
  });
});

test('منفی: ماه آینده در دورهٔ باز دست نمی‌خورد و ردپای مسدودی نمی‌سازد', async () => {
  const { inBook } = await freshBook('دورهٔ بسته — منفی');
  await inBook(() => {
    const paid = capture('امروز بیمه یک ساله ماشین رو ۱۲ میلیون از حساب تجارت دادیم');
    run(AZAR);
    assert.equal(items(paid.eventId).filter((item) => item.status === 'planned').length, 9);
    assert.equal(auditStages(paid.eventId, 'recognition-blocked').length, 0);
    assert.equal(database.blockedRecognition().items.length, 0);
  });
});

// ---------------------------------------------------------------------------
// خانوادهٔ «اجرا»: شناسایی ماهانه بدون اینکه کسی دکمه‌ای بزند اجرا می‌شود، و
// بستن دوره هیچ قلمِ سررسیدرسیده‌ای را پشت در نمی‌گذارد.
// ---------------------------------------------------------------------------

test('کار دقیقه‌ای سرور هر دفتر را شناسایی می‌کند و بستن دوره پیش از قفل شناسایی را اجرا می‌کند', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const job = source.slice(source.indexOf('function runRecurringJob'), source.indexOf('runRecurringJob();'));
  assert.match(job, /for \(const workspace of workspaces\)/);
  assert.match(job, /runInWorkspace\(workspace\.id, \{ role: 'owner' \}, \(\) => runRecognition\(\)\)/, 'هر دفتر، جدا');
  assert.match(source, /setInterval\(runRecurringJob/);
  const lockRoute = source.slice(source.indexOf("app.post('/api/accounting/periods/:period/lock'"), source.indexOf("app.post('/api/accounting/periods/:period/reopen'"));
  assert.ok(lockRoute.indexOf('runRecognition()') > 0 && lockRoute.indexOf('runRecognition()') < lockRoute.indexOf('lockAccountingPeriod('), 'اول شناسایی، بعد قفل');
});

test('بدنهٔ کار زمان‌بندی‌شده — بی‌کاربر، با نقش مالک — پیش‌پرداخت و درآمد انتقالی سررسیده را ثبت می‌کند', async () => {
  const { workspace, inBook } = await freshBook('اجرا — کار زمان‌بندی‌شده');
  let paid = null;
  let received = null;
  await inBook(() => {
    paid = capture('اشتراک یک ساله نرم افزار رو امروز ۲۴ میلیون از حساب تجارت پرداخت کردیم');
    received = capture(RENT_RECEIVED);
  });
  // همان زمینه‌ای که `runRecurringJob` می‌سازد.
  const result = database.runInWorkspace(workspace.id, { role: 'owner' }, () => database.runRecognition());
  await inBook(() => {
    const now = new Date().toISOString();
    for (const eventId of [paid.eventId, received.eventId]) {
      for (const item of items(eventId)) {
        assert.equal(item.status, item.recognitionDate <= now ? 'posted' : 'planned', `${item.periodKey} ${item.recognitionDate}`);
      }
    }
    assert.ok(result.posted >= 2, JSON.stringify(result));
    const prepaidSchedule = items(paid.eventId).filter((item) => item.status === 'posted').reduce((sum, item) => sum + item.amount, 0);
    const deferredSchedule = items(received.eventId).filter((item) => item.status === 'posted').reduce((sum, item) => sum + item.amount, 0);
    assert.deepEqual([balances().prepaid, balances().expense], [24_000_000 - prepaidSchedule, prepaidSchedule], 'بدهکار هزینه، بستانکار پیش‌پرداخت');
    assert.deepEqual([balances().deferred, balances().income], [-30_000_000 + deferredSchedule, -deferredSchedule], 'بدهکار درآمد انتقالی، بستانکار درآمد');
    // اجرای دوباره در دقیقهٔ بعد سند دوم نمی‌سازد.
    assert.equal(database.runRecognition().posted, 0);
  });
});

test('بستن دوره با قلم شناسایی سندنخورده رد می‌شود؛ پس از اجرا بسته می‌شود و چیزی در آن جا نمی‌ماند', async () => {
  const { inBook } = await freshBook('اجرا — بستن دوره');
  await inBook(() => {
    accounting.lockAccountingPeriod(sql(), '1405-06', owner.id);
    const paid = capture('امروز بیمه یک ساله ماشین رو ۱۲ میلیون از حساب تجارت دادیم');
    assert.throws(() => accounting.lockAccountingPeriod(sql(), '1405-07', owner.id), { code: 'RECOGNITION_DUE_BEFORE_LOCK' });
    run(AZAR);
    accounting.lockAccountingPeriod(sql(), '1405-07', owner.id);
    const inside = items(paid.eventId).filter((item) => accounting.periodForDate(item.recognitionDate) === '1405-07');
    assert.ok(inside.length && inside.every((item) => item.status === 'posted'), 'هیچ قلم برنامه‌ریزی‌شده یا منتظری در ماه بسته نمی‌ماند');
  });
});

// ---------------------------------------------------------------------------
// خانوادهٔ «ثبت حسابدار»: وقتی حسابدار سطرهای خودش را ثبت می‌کند — قبول پیشنهاد
// دستیار، ثبت دستیِ گفتهٔ چندمبلغی — همان سطرها حقیقت دفترند. برنامهٔ لحظهٔ ضبط
// جایش را به برنامه‌ای می‌دهد که از سطر واقعی پیش‌پرداخت (یا درآمد انتقالی)
// ساخته شده، یا اگر حسابدار هزینه ثبت کرد، باطل می‌شود. دورهٔ نامعلوم پرسیده
// می‌شود، نه حدس زده.
// ---------------------------------------------------------------------------

const { proposeReview } = await import('../server/accountingReviewAi.js');
const { readCoverageAnswers } = await import('../shared/recognitionSchedule.js');
const previousAiKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'test-key-not-real';
test.after(() => { if (previousAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousAiKey; });

/** پاسخ ساختگی مدل؛ شبکه‌ای در کار نیست. */
const fakeAi = (proposal) => async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({
  summary: 'ثبت پیشنهادی حسابدار', explanation: 'بر اساس متن اصلی', counterpartyName: null, missingFacts: [], questions: [], inventoryItems: [], lines: [], ...proposal,
}) }] }], usage: { input_tokens: 1, output_tokens: 1 } }) });
const LINES = {
  prepaid: (amount, key) => [{ role: 'prepaid-asset', key, debit: amount, credit: 0 }, { role: 'cash', key: null, debit: 0, credit: amount }],
  expense: (amount, key) => [{ role: 'expense-category', key, debit: amount, credit: 0 }, { role: 'cash', key: null, debit: 0, credit: amount }],
  deferred: (amount, key) => [{ role: 'cash', key: null, debit: amount, credit: 0 }, { role: 'deferred-revenue', key, debit: 0, credit: amount }],
};

/** ماندهٔ هر حساب دوره‌دار (منشأ یا معین کدینگ)، جدا جدا — نه جمع که خطا را بپوشاند. */
const timingBalances = (role) => sql().prepare(`SELECT a.name, SUM(l.debit)-SUM(l.credit) AS n FROM journal_lines l
  JOIN journal_entries j ON j.id=l.entry_id JOIN ledger_accounts a ON a.id=l.account_id LEFT JOIN chart_accounts c ON c.id=a.chart_account_id
  WHERE (a.source_kind=? OR c.role=?) AND j.approval_state='approved' GROUP BY a.id HAVING n<>0`).all(role, role);
const byType = (type) => Number(sql().prepare(`SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) AS n FROM journal_lines l
  JOIN journal_entries j ON j.id=l.entry_id JOIN ledger_accounts a ON a.id=l.account_id WHERE a.type=? AND j.approval_state='approved'`).get(type).n);
const liveItems = (eventId) => items(eventId).filter((item) => item.status !== 'superseded');

/** «مطمئن نیستم» → «تحلیل کن» (با سؤال و جواب اختیاری) → پیشنهاد آماده در صف. */
async function accountantReview(eventId, lines, { bank, ask = null, answers = null, message = '' } = {}) {
  if (sql().prepare('SELECT route FROM financial_events WHERE id=?').get(eventId).route !== 'accountant-review') database.handOverPending(eventId);
  const facts = { accountId: bank.id };
  if (ask) await proposeReview(sql(), eventId, { fetcher: fakeAi({ questions: ask }), facts });
  const proposal = await proposeReview(sql(), eventId, { message, fetcher: fakeAi({ lines }), facts: answers ? { ...facts, questionAnswers: answers } : facts });
  const prepared = database.reviewQueue().items.find((item) => item.id === eventId).aiProposal;
  return { proposal, prepared, accept: () => database.reviewAiFeedback(eventId, proposal.id, { accepted: true }).item };
}

for (const [sentence, amount, key] of [
  ['اشتراک یک ساله نرم افزار ۲۴ میلیون از حساب تجارت دادیم', 24_000_000, 'اشتراک نرم افزار'],
  ['بیمه یک ساله انبار ۱۲ میلیون از حساب تجارت دادیم', 12_000_000, 'بیمه انبار'],
  ['اجاره ۶ ماه دفتر رو جلوتر دادیم ۳۰ میلیون از حساب تجارت', 30_000_000, 'اجاره دفتر'],
]) {
  test(`پیش‌پرداخت قطعی که به حسابدار سپرده شد و با حساب دیگری قبول شد، همان حساب صفر می‌شود: «${sentence}»`, async () => {
    const { inBook, bank } = await freshBook(`حسابدار — ${key}`);
    await inBook(async () => {
      const { eventId } = capture(sentence, { approve: false });
      assert.ok(items(eventId).length > 1, 'برنامهٔ لحظهٔ ضبط');
      const { prepared, accept } = await accountantReview(eventId, LINES.prepaid(amount, key), { bank });
      assert.equal(prepared.canPost, true, prepared.postingBlockers.join(' / '));
      const item = accept();
      const debited = sql().prepare('SELECT account_id AS id FROM journal_lines WHERE entry_id=? AND debit>0').get(item.journalEntryId).id;
      const live = liveItems(eventId);
      assert.equal(live.reduce((sum, row) => sum + row.amount, 0), amount, 'جمع برنامه همان سطر پیش‌پرداخت');
      assert.ok(sql().prepare("SELECT 1 FROM recognition_schedule_items WHERE event_id=? AND status='planned' AND account_id<>?").get(eventId, debited) === undefined, 'حساب برنامه همان حساب بدهکارشده');
      run(LONG_AFTER);
      assert.deepEqual(timingBalances('prepaid-asset'), [], 'هیچ حساب پیش‌پرداختی مانده ندارد — نه مثبت ابدی، نه منفی');
      assert.equal(byType('expense'), amount, 'هزینه یک بار، نه دو بار');
    });
  });
}

test('حسابدار پرداخت قطعیِ پیش‌پرداخت را هزینه ثبت کرد: برنامهٔ ضبط باطل و شناسایی روی آن هزینهٔ دوم نمی‌سازد', async () => {
  const { inBook, bank } = await freshBook('حسابدار — هزینه');
  await inBook(async () => {
    const { eventId } = capture('کرایه شش ماهه انبار رو از اول مهر ۳۰ میلیون از حساب تجارت دادیم', { approve: false });
    assert.equal(items(eventId).length, 6);
    const { accept } = await accountantReview(eventId, LINES.expense(30_000_000, 'اجاره'), { bank });
    accept();
    assert.deepEqual(liveItems(eventId), []);
    assert.equal(store.decisionForEvent(sql(), eventId).treatment, 'accountant-reviewed');
    assert.deepEqual(run(LONG_AFTER), { posted: 0, blocked: 0, skipped: 0 });
    assert.equal(byType('expense'), 30_000_000, 'نه ۶۰ میلیون');
    assert.deepEqual(timingBalances('prepaid-asset'), []);
  });
});

test('نگهبان جلوی اشتراک با ارزش افزوده را گرفت و حسابدار هزینه ثبت کرد: هزینه همان ۲۴ میلیون می‌ماند', async () => {
  const { inBook, bank } = await freshBook('حسابدار — نگهبان');
  await inBook(async () => {
    const text = 'اشتراک یک ساله نرم افزار رو امروز ۲۴ میلیون از حساب تجارت پرداخت کردیم، ارزش افزوده هم داره';
    const { eventId } = capture(text, { approve: false });
    const row = sql().prepare('SELECT route,payload FROM financial_events WHERE id=?').get(eventId);
    assert.equal(row.route, 'accountant-review');
    const { prepared, accept } = await accountantReview(eventId, LINES.expense(24_000_000, JSON.parse(row.payload).category), { bank });
    assert.equal(prepared.canPost, true, prepared.postingBlockers.join(' / '));
    accept();
    run(LONG_AFTER);
    assert.equal(byType('expense'), 24_000_000, 'نه ۴۸ میلیون');
    assert.deepEqual(timingBalances('prepaid-asset'), [], 'نه پیش‌پرداخت منفی');
  });
});

test('بیمهٔ بی‌دوره: حسابدار دوره را در جواب سؤال دستیار گفت — دوازده قلم از اول مهر و پیش‌پرداخت صفر', async () => {
  const { inBook, bank } = await freshBook('حسابدار — جواب دوره');
  await inBook(async () => {
    const { eventId } = capture('بیمه انبار ۱۲ میلیون از حساب تجارت دادیم', { approve: false });
    assert.equal(store.decisionForEvent(sql(), eventId).decisionStatus, 'needs-user-input');
    assert.deepEqual(items(eventId), []);
    const ask = [{ id: 'coverage.start', text: 'پوشش بیمه از چه تاریخی شروع شد و چند ماه است؟', field: null }];
    const { prepared, accept } = await accountantReview(eventId, LINES.prepaid(12_000_000, 'بیمه'), { bank, ask, answers: { 'coverage.start': { value: 'از اول مهر ۱۴۰۵ به مدت ۱۲ ماه' } } });
    assert.equal(prepared.canPost, true, prepared.postingBlockers.join(' / '));
    accept();
    const live = liveItems(eventId);
    assert.equal(live.length, 12);
    assert.deepEqual([live[0].periodKey, live.at(-1).periodKey], ['1405-07', '1406-06']);
    assert.equal(live.reduce((sum, row) => sum + row.amount, 0), 12_000_000);
    const decision = store.decisionForEvent(sql(), eventId);
    assert.deepEqual([decision.treatment, decision.decisionStatus, decision.recognitionMethod], ['prepaid-expense', 'decided', 'monthly-straight-line']);
    const payload = JSON.parse(sql().prepare('SELECT payload FROM financial_events WHERE id=?').get(eventId).payload);
    assert.ok(payload.servicePeriodStart && payload.servicePeriodEnd, 'دوره روی خودِ رویداد هم نشست');
    run(LONG_AFTER);
    assert.deepEqual(timingBalances('prepaid-asset'), []);
    assert.equal(byType('expense'), 12_000_000);
  });
});

test('منفی: بیمهٔ بی‌دوره بدون جواب — پیشنهاد پیش‌پرداخت قبول نمی‌شود و هیچ سندی نمی‌خورد', async () => {
  const { inBook, bank } = await freshBook('حسابدار — بی‌دوره');
  await inBook(async () => {
    const { eventId } = capture('بیمه انبار ۱۲ میلیون از حساب تجارت دادیم', { approve: false });
    // جواب نیمه: فقط شروع، از کارت سؤال موتور.
    database.answerEvent(eventId, { fact: 'servicePeriodStart', value: 'this-month' });
    const { prepared, accept } = await accountantReview(eventId, LINES.prepaid(12_000_000, 'بیمه'), { bank });
    assert.equal(prepared.canPost, false);
    assert.ok(prepared.postingBlockers.some((text) => /دورهٔ پوشش/.test(text)), prepared.postingBlockers.join(' / '));
    const journals = sql().prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
    assert.throws(accept, { code: 'REVIEW_DETAILS_REQUIRED' });
    assert.equal(sql().prepare('SELECT status FROM financial_events WHERE id=?').get(eventId).status, 'pending');
    assert.equal(sql().prepare('SELECT COUNT(*) n FROM journal_entries').get().n, journals);
  });
});

test('بیمهٔ بی‌دوره با هر دو جواب کارت سؤال، بعد پیشنهاد دستیار با حساب کلی: پیش‌پرداخت‌ها صفر می‌شود', async () => {
  const { inBook, bank } = await freshBook('حسابدار — کارت سؤال');
  await inBook(async () => {
    const { eventId } = capture('بیمه انبار ۱۲ میلیون از حساب تجارت دادیم', { approve: false });
    database.answerEvent(eventId, { fact: 'servicePeriodStart', value: 'this-month' });
    database.answerEvent(eventId, { fact: 'servicePeriodEnd', value: 'one-year' });
    const { accept } = await accountantReview(eventId, LINES.prepaid(12_000_000, 'بیمه'), { bank });
    accept();
    run(LONG_AFTER);
    assert.deepEqual(timingBalances('prepaid-asset'), []);
    assert.equal(byType('expense'), 12_000_000);
  });
});

test('گفتهٔ چندمبلغی که حسابدار با پیش‌پرداخت و ارزش افزوده ثبت کرد: برنامه روی خالص و به همان حساب', async () => {
  const { inBook, bank } = await freshBook('حسابدار — چندمبلغی');
  await inBook(async () => {
    const { resolveEventRole } = await import('../server/roleResolver.js');
    database.queueCompositeUtterance('اشتراک یک ساله نرم افزار ۲۶ میلیون و ۴۰۰ دادیم، ۲۴ میلیونش اصل و بقیه مالیات ارزش افزوده', { clientId: 'p5-composite' });
    const event = sql().prepare("SELECT id,kind FROM financial_events WHERE kind='review-placeholder' ORDER BY rowid DESC").get();
    assert.ok(event, 'گفته به صف حسابدار رفت');
    const prepaid = resolveEventRole(sql(), 'prepaid-asset', 'نرم‌افزار و اشتراک', {});
    const vat = resolveEventRole(sql(), 'vat-input', null, {});
    const cash = resolveEventRole(sql(), 'cash', bank.id, { accountId: bank.id });
    database.recordReviewedComposite(event.id, { lines: [
      { accountId: prepaid, debit: 24_000_000, credit: 0 }, { accountId: vat, debit: 2_400_000, credit: 0 }, { accountId: cash, debit: 0, credit: 26_400_000 },
    ], reason: 'اشتراک یک ساله؛ تفکیک ارزش افزوده' });
    const live = liveItems(event.id);
    assert.equal(live.length, 12);
    assert.equal(live.reduce((sum, row) => sum + row.amount, 0), 24_000_000, 'خالص، نه ۲۶٫۴ میلیون');
    run(LONG_AFTER);
    assert.deepEqual(timingBalances('prepaid-asset'), []);
    assert.equal(byType('expense'), 24_000_000);
  });
});

/** گفته‌ای که مستقیم به صف حسابدار رفته (فهم AI، گفتهٔ چندمبلغی): سندش را حسابدار می‌سازد. */
function placeholder(text, amount, sourceEventId) {
  return store.recordFinancialEvent(sql(), normalizeFinancialEvent({ kind: 'review-placeholder', amount, amountReferenceOnly: true, occurredAt: NOW, source: 'voice', evidence: text, utterance: text }),
    { sourceEventId, decision: { route: 'accountant-review', guardBlocked: true, reasons: ['سند این گفته با حسابدار است'] }, transcript: text, rawInput: text });
}

test('منفی: گفتهٔ چندمبلغی با دو حساب پیش‌پرداخت در یک سند — جدا ثبت شوند، نه یک برنامه برای هر دو', async () => {
  const { inBook, bank } = await freshBook('حسابدار — دو قرارداد');
  await inBook(async () => {
    const { resolveEventRole } = await import('../server/roleResolver.js');
    const event = placeholder('بیمه یک ساله ۱۲ میلیون و اجاره شش ماهه ۳۰ میلیون از حساب تجارت دادیم', 42_000_000, 'p5-two');
    const cash = resolveEventRole(sql(), 'cash', bank.id, { accountId: bank.id });
    assert.throws(() => database.recordReviewedComposite(event.id, { lines: [
      { accountId: resolveEventRole(sql(), 'prepaid-asset', 'بیمه', {}), debit: 12_000_000, credit: 0 },
      { accountId: resolveEventRole(sql(), 'prepaid-asset', 'اجاره', {}), debit: 30_000_000, credit: 0 },
      { accountId: cash, debit: 0, credit: 42_000_000 },
    ], reason: 'دو قرارداد جدا در یک گفته' }), { code: 'REVIEW_DETAILS_REQUIRED' });
    assert.equal(sql().prepare('SELECT status FROM financial_events WHERE id=?').get(event.id).status, 'pending');
  });
});

test('آینه: اجارهٔ پیش‌دریافت که به حسابدار سپرده شد و با درآمد انتقالی قبول شد — درآمد انتقالی صفر، درآمد ۳۰ میلیون', async () => {
  const { inBook, bank } = await freshBook('حسابدار — درآمد انتقالی');
  await inBook(async () => {
    const { eventId } = capture('اجاره شش ماه آینده انبار رو ۳۰ میلیون از آقای کریمی پیش دریافت کردیم، ریختن حساب تجارت', { approve: false });
    const status = sql().prepare('SELECT status FROM financial_events WHERE id=?').get(eventId).status;
    assert.equal(status, 'pending');
    const { prepared, accept } = await accountantReview(eventId, LINES.deferred(30_000_000, 'کریمی'), { bank, message: 'پیش‌دریافت اجارهٔ شش ماهه است؛ درآمد انتقالی ثبت کن' });
    assert.equal(prepared.canPost, true, prepared.postingBlockers.join(' / '));
    accept();
    assert.equal(liveItems(eventId).reduce((sum, row) => sum + row.amount, 0), 30_000_000);
    run(LONG_AFTER);
    assert.deepEqual(timingBalances('deferred-revenue'), [], 'بدهی پیش‌دریافت صفر — نه مستأجرِ بدهکار');
    assert.equal(byType('income'), -30_000_000);
  });
});

test('منفی: تأیید نقشهٔ قفل‌شده همان رفتار همیشگی را دارد و پیش‌پرداخت صفر می‌شود', async () => {
  const { inBook } = await freshBook('حسابدار — نقشهٔ قفل');
  await inBook(() => {
    const { eventId } = capture('بیمه یک ساله انبار ۱۲ میلیون از حساب تجارت دادیم');
    assert.equal(store.decisionForEvent(sql(), eventId).treatment, 'prepaid-expense');
    run(LONG_AFTER);
    assert.deepEqual(timingBalances('prepaid-asset'), []);
    assert.equal(byType('expense'), 12_000_000);
  });
});

test('منفی: پیش‌پرداخت خرید کالا به تأمین‌کننده دورهٔ پوشش نمی‌خواهد و برنامه‌ای نمی‌سازد', async () => {
  const { inBook, bank } = await freshBook('حسابدار — پیش‌پرداخت خرید');
  await inBook(async () => {
    const text = 'صد و بیست میلیون پیش‌پیش ریختیم حساب کارخانه فولاد مبارکه واسه خرید ورق هنوز بار نرسیده';
    const event = store.recordFinancialEvent(sql(), { kind: 'cash-expense', amount: 120_000_000, occurredAt: NOW, evidence: text, eventNature: 'new', category: 'مواد و کالا' },
      { sourceEventId: 'p5-supplier-advance', decision: { route: 'accountant-review', guardBlocked: true, reasons: ['بررسی حسابدار لازم است'] } });
    const proposal = await proposeReview(sql(), event.id, { fetcher: fakeAi({ counterpartyName: 'کارخانه فولاد مبارکه', lines: LINES.prepaid(120_000_000, 'پیش‌پرداخت‌ها') }), facts: { accountId: bank.id, counterpartyName: 'کارخانه فولاد مبارکه' } });
    const prepared = database.reviewQueue().items.find((item) => item.id === event.id).aiProposal;
    assert.equal(prepared.canPost, true, prepared.postingBlockers.join(' / '));
    database.reviewAiFeedback(event.id, proposal.id, { accepted: true });
    assert.deepEqual(items(event.id), []);
    assert.equal(run(LONG_AFTER).posted, 0);
  });
});

test('آینهٔ چندمبلغی: اجارهٔ پیش‌دریافتی که حسابدار درآمد انتقالی ثبت کرد شش قلم می‌گیرد؛ بی‌دوره پرسیده می‌شود', async () => {
  const { inBook, bank } = await freshBook('حسابدار — پیش‌دریافت چندمبلغی');
  await inBook(async () => {
    const { resolveEventRole } = await import('../server/roleResolver.js');
    const cash = resolveEventRole(sql(), 'cash', bank.id, { accountId: bank.id });
    const contact = database.saveContact({ name: 'کریمی' });
    const tenant = { counterparty: 'کریمی', counterpartyId: contact.id };
    const deferred = resolveEventRole(sql(), 'deferred-revenue', 'کریمی', tenant);
    const { resolveEventAnalytic } = await import('../server/roleResolver.js');
    const analyticId = resolveEventAnalytic(sql(), 'deferred-revenue', tenant, 'کریمی');
    const lines = (amount) => [{ accountId: cash, debit: amount, credit: 0 }, { accountId: deferred, debit: 0, credit: amount, analyticId }];
    const dated = placeholder('اجاره شش ماه آینده انبار رو ۳۰ میلیون از آقای کریمی پیش دریافت کردیم و ۵ میلیون هم ودیعه داد', 35_000_000, 'p5-deferred');
    database.recordReviewedComposite(dated.id, { lines: lines(30_000_000), reason: 'پیش‌دریافت اجاره؛ ودیعه جدا ثبت می‌شود' });
    assert.equal(liveItems(dated.id).length, 6);
    const undated = placeholder('آقای کریمی ۳۰ میلیون بابت اجاره انبار و ۵ میلیون ودیعه داد', 35_000_000, 'p5-deferred-undated');
    assert.throws(() => database.recordReviewedComposite(undated.id, { lines: lines(30_000_000), reason: 'پیش‌دریافت اجاره بی‌دوره' }), { code: 'REVIEW_DETAILS_REQUIRED', message: /دورهٔ خدمت/ });
    run(LONG_AFTER);
    assert.deepEqual(timingBalances('deferred-revenue'), []);
    assert.equal(byType('income'), -30_000_000);
  });
});

test('منفی: هزینهٔ عادیِ بی‌برنامه که حسابدار ثبت کرد تصمیم تازه یا برنامه‌ای نمی‌گیرد', async () => {
  const { inBook, bank } = await freshBook('حسابدار — هزینهٔ عادی');
  await inBook(async () => {
    const { eventId } = capture('خرید لوازم التحریر ۳ میلیون از حساب تجارت', { approve: false });
    const before = store.decisionForEvent(sql(), eventId);
    const { prepared, accept } = await accountantReview(eventId, LINES.expense(3_000_000, 'لوازم التحریر'), { bank, message: 'لوازم التحریر مصرفی همین ماه است' });
    assert.equal(prepared.canPost, true, prepared.postingBlockers.join(' / '));
    accept();
    assert.deepEqual(items(eventId), []);
    assert.equal(store.decisionForEvent(sql(), eventId)?.id, before?.id);
  });
});

test('جواب دورهٔ پوشش به هر شکلی که حسابدار بنویسد، همان دوازده ماه است — و جواب ناقص دوره نمی‌سازد', () => {
  const at = { occurredAt: NOW };
  const year = { start: '2026-09-23T08:30:00.000Z', end: '2027-09-22T08:30:00.000Z' };
  for (const answers of [
    [{ text: 'از اول مهر ۱۴۰۵ به مدت ۱۲ ماه', side: 'start' }],
    [{ text: 'از ۱ مهر ۱۴۰۵ تا ۳۱ شهریور ۱۴۰۶', side: 'any' }],
    [{ text: 'مهر ۱۴۰۵ تا شهریور ۱۴۰۶', side: 'any' }],
    [{ text: '1405/07/01', side: 'start' }, { text: '1406/06/31', side: 'end' }],
    [{ text: 'از اول مهر 1405 به مدت يك سال', side: 'start' }],
    [{ text: 'اول مهر ۱۴۰۵', side: 'start' }, { text: 'یک ساله', side: 'end' }],
  ]) assert.deepEqual(readCoverageAnswers(answers, at), year, JSON.stringify(answers));
  // دانستهٔ پیشین (طول از متن) با شروع تازهٔ جواب.
  assert.deepEqual(readCoverageAnswers([{ text: 'از اول مهر ۱۴۰۵', side: 'start' }], { ...at, start: NOW, end: '2027-10-09T08:30:00.000Z', months: 12 }), year);
  for (const answers of [[{ text: '۱۲ ماه', side: 'any' }], [{ text: 'نمی‌دانم', side: 'start' }], []]) {
    const coverage = readCoverageAnswers(answers, at);
    assert.ok(!(coverage.start && coverage.end), JSON.stringify(answers));
  }
});

// ---------------------------------------------------------------------------
// خانوادهٔ «استرداد و فسخ»: سندی که ماندهٔ قرارداد دوره‌دار را کم می‌کند
// (بیمه‌گر برگرداند، به مستأجر پس دادیم، اشتراک کنسل شد) برنامهٔ همان قرارداد
// را هم کم می‌کند. قرارداد نامعلوم یا سرنوشت نامعلوم پرسیده می‌شود؛ استرداد
// بیش از بخش شناسایی‌نشده رد می‌شود؛ و اجرای ماهانه هرگز حساب دوره‌دار را از
// صفر رد نمی‌کند.
// ---------------------------------------------------------------------------

const DEY1 = '2026-12-22T08:00:00.000Z'; // ۱ دی ۱۴۰۵
const REFUND_AT = '2026-12-27T08:00:00.000Z'; // ۶ دی ۱۴۰۵
const FIRE_INSURANCE = 'بیمه آتش سوزی یک ساله ۱۲ میلیون از حساب تجارت دادیم';
const AHMADI_RENT = 'اجاره گرفتم شش ماهه ۶۰ میلیون از آقای احمدی';

/** دفتر پایه: بیمهٔ ۱۲ میلیونی و اجارهٔ پیش‌دریافت ۶۰ میلیونی، سه ماهشان شناسایی شده. */
async function contractBook(name) {
  const book = await freshBook(name);
  await book.inBook(() => {
    book.insurance = capture(FIRE_INSURANCE).eventId;
    book.rent = capture(AHMADI_RENT).eventId;
    run(DEY1);
    const { resolveEventRole } = book;
    book.ledger = (where, ...args) => sql().prepare(`SELECT id FROM ledger_accounts WHERE ${where}`).get(...args)?.id;
    book.bankLedger = book.ledger("source_kind='operational-account' AND source_key=?", book.bank.id);
    book.cashLedger = book.ledger("source_kind='operational-account' AND name='صندوق نقدی'");
    book.prepaid = book.ledger("source_kind='prepaid-asset' AND source_key='بیمه'");
    book.deferred = book.ledger("source_kind='deferred-revenue' AND name LIKE '%احمدی%'");
    book.tenantAnalytic = sql().prepare('SELECT analytic_id AS a FROM journal_lines WHERE account_id=? AND analytic_id IS NOT NULL LIMIT 1').get(book.deferred)?.a;
    assert.equal(net('prepaid-asset'), 9_000_000);
    assert.equal(net('deferred-revenue'), -30_000_000);
  });
  return book;
}
/** جمع اقلامی که هنوز شناسایی نشده‌اند. */
const unrecognised = (eventId) => items(eventId).filter((item) => ['planned', 'blocked-closed-period'].includes(item.status)).reduce((sum, item) => sum + item.amount, 0);
const ledgerOf = (id) => Number(sql().prepare(`SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) n FROM journal_lines l JOIN journal_entries j ON j.id=l.entry_id
  WHERE l.account_id=? AND j.approval_state='approved'`).get(id).n);
const refundPlaceholder = (text, amount) => store.recordFinancialEvent(sql(), normalizeFinancialEvent({ kind: 'review-placeholder', amount, amountReferenceOnly: true, occurredAt: REFUND_AT, source: 'voice', evidence: text, utterance: text }),
  { sourceEventId: `refund:${Math.random()}`, decision: { route: 'accountant-review', guardBlocked: true, reasons: ['ارجاعش به سند اول با حسابدار است'] }, transcript: text, rawInput: text });

test('بیمه‌گر پس از فسخ ۶ میلیون برگرداند: برنامهٔ بیمه بسته می‌شود — پیش‌پرداخت صفر، هزینهٔ بیمه ۶ میلیون', async () => {
  const book = await contractBook('استرداد — بیمه‌گر');
  await book.inBook(() => {
    const event = refundPlaceholder('بیمه آتش سوزی رو فسخ کردیم بیمه پاسارگاد ۶ میلیون حق بیمه برگشت داد به حساب تجارت', 6_000_000);
    database.recordReviewedComposite(event.id, { lines: [{ accountId: book.bankLedger, debit: 6_000_000, credit: 0 }, { accountId: book.prepaid, debit: 0, credit: 6_000_000 }], reason: 'استرداد بخش مصرف‌نشده پس از فسخ قرارداد' });
    assert.equal(unrecognised(book.insurance), 3_000_000, 'فقط بخشِ برنگشته');
    assert.equal(JSON.parse(sql().prepare('SELECT payload FROM financial_events WHERE id=?').get(event.id).payload).contractEventId, book.insurance);
    run(LONG_AFTER);
    assert.equal(ledgerOf(book.prepaid), 0, 'نه منفی ۶ میلیون');
    assert.equal(net('expense-category'), 6_000_000, 'نه ۱۲ میلیون');
    assert.equal(net('deferred-revenue'), 0, 'قرارداد دیگرِ دفتر دست نخورد');
    assert.equal(net('income-category'), -60_000_000);
  });
});

test('آینه: مستأجر زودتر تخلیه کرد و ۱۰ میلیون از صندوق پس دادیم — درآمد انتقالی صفر، درآمد اجاره ۵۰ میلیون', async () => {
  const book = await contractBook('استرداد — مستأجر');
  await book.inBook(() => {
    const event = refundPlaceholder('آقای احمدی مستاجر زودتر تخلیه کرد ۱۰ میلیون از اجاره جلو گرفته رو از صندوق بهش پس دادیم', 10_000_000);
    database.recordReviewedComposite(event.id, { lines: [{ accountId: book.deferred, debit: 10_000_000, credit: 0, analyticId: book.tenantAnalytic }, { accountId: book.cashLedger, debit: 0, credit: 10_000_000 }], reason: 'استرداد بخش مصرف‌نشده پس از تخلیه' });
    run(LONG_AFTER);
    assert.equal(ledgerOf(book.deferred), 0, 'مستأجر به ما بدهکار نیست');
    assert.equal(net('income-category'), -50_000_000);
    assert.equal(net('expense-category'), 12_000_000, 'بیمهٔ دفتر دست نخورد');
  });
});

test('آینه از مسیر دستیار: «آقای احمدی مستاجر تخلیه کرد ۱۰ میلیون از پیش دریافت اجاره رو بهش پس دادیم» با قبول پیشنهاد', async () => {
  const book = await contractBook('استرداد — قبول پیشنهاد');
  await book.inBook(async () => {
    const { eventId } = capture('آقای احمدی مستاجر تخلیه کرد ۱۰ میلیون از پیش دریافت اجاره رو بهش پس دادیم', { now: REFUND_AT, approve: false });
    if (sql().prepare('SELECT route FROM financial_events WHERE id=?').get(eventId).route !== 'accountant-review') database.handOverPending(eventId);
    const cashBox = database.listAccounts().find((account) => account.name === 'صندوق نقدی');
    const ahmadi = sql().prepare("SELECT id FROM contacts WHERE name LIKE '%احمدی%'").get().id;
    const proposal = await proposeReview(sql(), eventId, { message: 'این عودت از درآمد انتقالی احمدی است', facts: { accountId: cashBox.id, counterpartyId: ahmadi }, fetcher: fakeAi({
      summary: 'عودت پیش‌دریافت اجاره پس از تخلیه',
      lines: [{ role: 'deferred-revenue', key: 'احمدی', accountId: book.deferred, debit: 10_000_000, credit: 0 }, { role: 'cash', key: null, accountId: book.cashLedger, debit: 0, credit: 10_000_000 }],
    }) });
    database.reviewAiFeedback(eventId, proposal.id, { accepted: true });
    run(LONG_AFTER);
    assert.equal(ledgerOf(book.deferred), 0);
    assert.equal(net('income-category'), -50_000_000);
  });
});

test('اشتراک نرم‌افزار کنسل شد و ۱۰ میلیون برگشت: بخش برنگشته همان روز هزینه و پیش‌پرداخت صفر', async () => {
  const { inBook, bank } = await freshBook('استرداد — اشتراک');
  await inBook(() => {
    const { eventId } = capture('اشتراک یک ساله نرم افزار رو امروز ۲۴ میلیون از حساب تجارت پرداخت کردیم');
    run(DEY1);
    const prepaid = sql().prepare("SELECT id FROM ledger_accounts WHERE source_kind='prepaid-asset'").get().id;
    const bankLedger = sql().prepare("SELECT id FROM ledger_accounts WHERE source_kind='operational-account' AND source_key=?").get(bank.id).id;
    const event = refundPlaceholder('اشتراک نرم افزار رو کنسل کردیم، ۱۰ میلیون از پول اشتراک رو به حساب تجارت برگردوندن', 10_000_000);
    database.recordReviewedComposite(event.id, { lines: [{ accountId: bankLedger, debit: 10_000_000, credit: 0 }, { accountId: prepaid, debit: 0, credit: 10_000_000 }], reason: 'استرداد اشتراک کنسل‌شده' });
    run(LONG_AFTER);
    assert.equal(ledgerOf(prepaid), 0);
    assert.equal(net('expense-category'), 14_000_000, 'سه ماه مصرف + هشت میلیونِ برنگشته');
    assert.equal(items(eventId).filter((item) => item.status === 'posted').length, 4, 'سه ماه و قلم پایانی');
  });
});

test('استرداد بخشی که قرارداد ادامه دارد: اقلام آینده کم می‌شوند و جمعشان همان باقی‌مانده است', async () => {
  const book = await contractBook('استرداد — ادامه');
  await book.inBook(() => {
    const event = refundPlaceholder('بیمه گر به خاطر کاهش پوشش ۳ میلیون از حق بیمه آتش سوزی رو به حساب تجارت برگردوند، بیمه ادامه داره', 3_000_000);
    database.recordReviewedComposite(event.id, { lines: [{ accountId: book.bankLedger, debit: 3_000_000, credit: 0 }, { accountId: book.prepaid, debit: 0, credit: 3_000_000 }], reason: 'کاهش پوشش؛ قرارداد ادامه دارد' });
    const live = liveItems(book.insurance).filter((item) => item.status === 'planned');
    assert.equal(live.length, 9, 'هیچ ماهی حذف نشد');
    assert.equal(live.reduce((sum, item) => sum + item.amount, 0), 6_000_000);
    run(LONG_AFTER);
    assert.equal(ledgerOf(book.prepaid), 0);
    assert.equal(net('expense-category'), 9_000_000);
  });
});

test('دو بیمه روی یک حساب پیش‌پرداخت: پرسیده می‌شود کدام — و با انتخاب حسابدار فقط همان کم می‌شود', async () => {
  const book = await contractBook('استرداد — دو قرارداد');
  await book.inBook(() => {
    const second = capture('بیمه بدنه ماشین یک ساله ۱۸ میلیون از حساب تجارت دادیم', { now: DEY1 }).eventId;
    const event = refundPlaceholder('بیمه آتش سوزی رو فسخ کردیم بیمه پاسارگاد ۶ میلیون حق بیمه برگشت داد به حساب تجارت', 6_000_000);
    const lines = [{ accountId: book.bankLedger, debit: 6_000_000, credit: 0 }, { accountId: book.prepaid, debit: 0, credit: 6_000_000 }];
    const journals = sql().prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
    let asked = null;
    try { database.recordReviewedComposite(event.id, { lines, reason: 'استرداد پس از فسخ بیمه' }); } catch (error) { asked = error; }
    assert.equal(asked?.code, 'REVIEW_DETAILS_REQUIRED');
    assert.equal(asked.question.id, 'contract.reference');
    assert.deepEqual(asked.candidates.map((item) => item.eventId).sort(), [book.insurance, second].sort());
    assert.equal(sql().prepare('SELECT COUNT(*) n FROM journal_entries').get().n, journals, 'هیچ سندی پیش از جواب');
    database.recordReviewedComposite(event.id, { lines, reason: 'استرداد پس از فسخ بیمه', contractEventId: book.insurance });
    assert.equal(unrecognised(book.insurance), 3_000_000);
    assert.equal(unrecognised(second), 18_000_000, 'بیمهٔ ماشین دست نخورد');
    run(LONG_AFTER);
    assert.equal(ledgerOf(book.prepaid), 0);
    assert.equal(net('expense-category'), 6_000_000 + 18_000_000);
  });
});

test('آینه، دو اجاره از یک مستأجر روی یک حساب درآمد انتقالی، از مسیر دستیار: جواب «سند شمارهٔ …» همان قرارداد را انتخاب می‌کند', async () => {
  const book = await contractBook('استرداد — جواب کدام قرارداد');
  await book.inBook(async () => {
    const second = capture('اجاره گرفتم سه ماهه ۹ میلیون از آقای احمدی', { now: DEY1 }).eventId;
    const documentNumber = sql().prepare('SELECT j.document_number AS n FROM financial_events e JOIN journal_entries j ON j.id=e.journal_entry_id WHERE e.id=?').get(second).n;
    const event = refundPlaceholder('آقای احمدی انبار رو زودتر تخلیه کرد ۳ میلیون از پیش دریافت اجاره رو از صندوق بهش پس دادیم', 3_000_000);
    const cashBox = database.listAccounts().find((account) => account.name === 'صندوق نقدی');
    const ahmadi = sql().prepare("SELECT id FROM contacts WHERE name LIKE '%احمدی%'").get().id;
    const facts = { accountId: cashBox.id, counterpartyId: ahmadi };
    const lines = [{ role: 'deferred-revenue', key: 'احمدی', accountId: book.deferred, debit: 3_000_000, credit: 0 }, { role: 'cash', key: null, accountId: book.cashLedger, debit: 0, credit: 3_000_000 }];
    const ask = [{ id: 'contract.reference', text: 'این استرداد کدام قرارداد اجاره را کم می‌کند؟', field: null }];
    // بی‌جواب: قبول به همان سؤال برمی‌خورد و سندی نمی‌خورد.
    const unanswered = await proposeReview(sql(), event.id, { message: 'عودت پیش‌دریافت اجاره است', facts, fetcher: fakeAi({ summary: 'عودت پیش‌دریافت اجاره', lines }) });
    assert.throws(() => database.reviewAiFeedback(event.id, unanswered.id, { accepted: true }), (error) => error.code === 'REVIEW_DETAILS_REQUIRED' && error.question?.id === 'contract.reference');
    await proposeReview(sql(), event.id, { message: 'کدام قرارداد؟', fetcher: fakeAi({ questions: ask }), facts });
    const proposal = await proposeReview(sql(), event.id, { message: 'عودت پیش‌دریافت اجاره است', facts: { ...facts, questionAnswers: { 'contract.reference': { value: `سند شماره ${documentNumber}` } } }, fetcher: fakeAi({ summary: 'عودت پیش‌دریافت اجاره', lines }) });
    database.reviewAiFeedback(event.id, proposal.id, { accepted: true });
    assert.equal(unrecognised(book.rent), 30_000_000, 'اجارهٔ اول دست نخورد');
    assert.deepEqual(items(second).filter((item) => item.status === 'planned').map((item) => item.amount), [6_000_000], 'یک قلم پایانی: ۹ منهای ۳');
    run(LONG_AFTER);
    assert.equal(ledgerOf(book.deferred), 0);
    assert.equal(net('income-category'), -(60_000_000 + 6_000_000));
  });
});

test('منفی: استرداد بیش از بخش شناسایی‌نشده رد می‌شود و هیچ چیز عوض نمی‌شود', async () => {
  const book = await contractBook('استرداد — بیش از مانده');
  await book.inBook(() => {
    const event = refundPlaceholder('بیمه آتش سوزی رو فسخ کردیم و ۱۰ میلیون برگشت داد به حساب تجارت', 10_000_000);
    const before = JSON.stringify(items(book.insurance));
    assert.throws(() => database.recordReviewedComposite(event.id, { lines: [{ accountId: book.bankLedger, debit: 10_000_000, credit: 0 }, { accountId: book.prepaid, debit: 0, credit: 10_000_000 }], reason: 'استرداد پس از فسخ بیمه' }),
      { code: 'REVIEW_DETAILS_REQUIRED', message: /بخش شناسایی‌نشده/ });
    assert.equal(JSON.stringify(items(book.insurance)), before);
    assert.equal(ledgerOf(book.prepaid), 9_000_000);
  });
});

test('استرداد بخشی بی‌آنکه معلوم باشد قرارداد تمام شد یا نه: پرسیده می‌شود؛ جواب «ادامه دارد» اقلام را کم می‌کند', async () => {
  const book = await contractBook('استرداد — سرنوشت نامعلوم');
  await book.inBook(() => {
    const event = refundPlaceholder('بیمه پاسارگاد ۲ میلیون از حق بیمه آتش سوزی رو به حساب تجارت برگردوند', 2_000_000);
    const lines = [{ accountId: book.bankLedger, debit: 2_000_000, credit: 0 }, { accountId: book.prepaid, debit: 0, credit: 2_000_000 }];
    assert.throws(() => database.recordReviewedComposite(event.id, { lines, reason: 'برگشت بخشی از حق بیمه' }), (error) => error.code === 'REVIEW_DETAILS_REQUIRED' && error.question?.id === 'contract.ended');
    database.recordReviewedComposite(event.id, { lines, reason: 'برگشت بخشی از حق بیمه', contractEnded: false });
    assert.equal(liveItems(book.insurance).filter((item) => item.status === 'planned').length, 9);
    run(LONG_AFTER);
    assert.equal(ledgerOf(book.prepaid), 0);
    assert.equal(net('expense-category'), 10_000_000);
  });
});

test('تور ایمنی: استرداد با سند دستیِ بیرون از برنامه — اجرای ماهانه پیش‌پرداخت را منفی نمی‌کند و قلم‌ها را برای حسابدار نگه می‌دارد', async () => {
  const book = await contractBook('استرداد — سند دستی');
  await book.inBook(() => {
    const batch = database.createJournalDocuments([{ occurredAt: REFUND_AT, memo: 'برگشت حق بیمهٔ آتش‌سوزی پس از فسخ',
      lines: [{ accountId: book.bankLedger, debit: 6_000_000 }, { accountId: book.prepaid, credit: 6_000_000 }] }]);
    for (const id of batch.entryIds) { database.submitJournalApproval(id, 'submitted'); database.submitJournalApproval(id, 'approved'); }
    // ماندهٔ ۳ میلیونی سه قلم را می‌کشد؛ شش قلم بعدی نگه داشته می‌شوند.
    const first = run(LONG_AFTER);
    assert.equal(first.held, 6, JSON.stringify(first));
    assert.equal(ledgerOf(book.prepaid), 0, 'نه منفی');
    const second = run(LONG_AFTER);
    assert.equal(second.posted, 0);
    assert.equal(sql().prepare("SELECT COUNT(*) n FROM financial_event_audit WHERE event_id=? AND stage='recognition-held-balance'").get(book.insurance).n, 6, 'ردپا یک بار برای هر قلم');
    const held = database.reviewQueue().heldRecognition;
    assert.equal(held.length, 6);
    assert.ok(held.every((item) => item.eventId === book.insurance));
    assert.match(held[0].reason, /ماندهٔ پیش‌پرداخت/);
  });
});

test('منفی: برگشت پیش‌پرداخت خرید کالا و ودیعهٔ قابل استرداد به هیچ برنامه‌ای دست نمی‌زند', async () => {
  const book = await contractBook('استرداد — کالا و ودیعه');
  await book.inBook(async () => {
    const { resolveEventRole } = await import('../server/roleResolver.js');
    const supplier = database.saveContact({ name: 'کارخانه فولاد مبارکه' });
    const advance = resolveEventRole(sql(), 'supplier-advance', 'کارخانه فولاد مبارکه', { counterpartyId: supplier.id });
    const deposit = resolveEventRole(sql(), 'refundable-deposit', 'آقای رضایی', {});
    const before = JSON.stringify([items(book.insurance), items(book.rent)]);
    const goods = refundPlaceholder('کارخانه فولاد مبارکه پیش پرداخت خرید ورق رو چون بار نرسید ۲۰ میلیون به حساب تجارت برگردوند', 20_000_000);
    database.recordReviewedComposite(goods.id, { lines: [{ accountId: book.bankLedger, debit: 20_000_000, credit: 0 }, { accountId: advance, debit: 0, credit: 20_000_000 }], reason: 'برگشت پیش‌پرداخت خرید کالا' });
    const returned = refundPlaceholder('آقای رضایی ودیعه انبار رو ۵ میلیون به حساب تجارت پس داد', 5_000_000);
    database.recordReviewedComposite(returned.id, { lines: [{ accountId: book.bankLedger, debit: 5_000_000, credit: 0 }, { accountId: deposit, debit: 0, credit: 5_000_000 }], reason: 'برگشت ودیعهٔ قابل استرداد' });
    assert.equal(JSON.stringify([items(book.insurance), items(book.rent)]), before);
    for (const id of [goods.id, returned.id]) assert.deepEqual(items(id), []);
  });
});

test('منفی: استرداد روی حساب پیش‌پرداختی که قرارداد زنده‌ای ندارد فقط تا ماندهٔ واقعی حساب ثبت می‌شود', async () => {
  const { inBook, bank } = await freshBook('استرداد — بی‌قرارداد');
  await inBook(async () => {
    const { resolveEventRole } = await import('../server/roleResolver.js');
    const prepaid = resolveEventRole(sql(), 'prepaid-asset', 'بیمه', {});
    const bankLedger = resolveEventRole(sql(), 'cash', bank.id, { accountId: bank.id });
    const event = refundPlaceholder('بیمه پاسارگاد ۴ میلیون حق بیمه رو به حساب تجارت برگردوند', 4_000_000);
    assert.throws(() => database.recordReviewedComposite(event.id, { lines: [{ accountId: bankLedger, debit: 4_000_000, credit: 0 }, { accountId: prepaid, debit: 0, credit: 4_000_000 }], reason: 'برگشت حق بیمه بی‌سند مبنا' }),
      { code: 'REVIEW_DETAILS_REQUIRED', message: /کافی نیست/ });
  });
});

// ---------------------------------------------------------------------------
// خانوادهٔ «ماندهٔ دفتر کل بی‌سند»: پیش‌پرداخت یا درآمد انتقالی‌ای که از
// افتتاحیه، سند دستی دسته‌ای یا سند اصلاحی آمده و رویدادی پشتش نیست. دفتر کل
// باید آن را ببیند و دوره‌اش را بپرسد؛ با جواب حسابدار برنامه می‌گیرد و هیچ
// سند نقدی تازه‌ای نمی‌خورد. دوره حدس زده نمی‌شود.
// ---------------------------------------------------------------------------

const OPENING_AT = '2026-09-22T20:30:00.000Z'; // ۱ مهر ۱۴۰۵
const OPENING_CSV = [
  'کد حساب,نام حساب,بدهکار,بستانکار,کد تفصیلی',
  '1101,صندوق,۲۰۰۰۰۰۰۰,,',
  '1401,پيش‌پرداخت بيمه يكساله (مهر ۱۴۰۵ تا شهريور ۱۴۰۶),۱۲۰۰۰۰۰۰,,',
  '3105,درآمد انتقالی اجاره ۶ ماهه,,۶۰۰۰۰۰۰,',
  '5101,سرمایه,,۲۶۰۰۰۰۰۰,',
].join('\n');
const chartLedger = (code) => sql().prepare('SELECT la.id FROM ledger_accounts la JOIN chart_accounts ca ON ca.id=la.chart_account_id WHERE ca.code=? LIMIT 1').get(code)?.id;
const approveJournal = (id) => { database.submitJournalApproval(id, 'submitted'); database.submitJournalApproval(id, 'approved'); };

test('ماندهٔ افتتاحیهٔ پیش‌پرداخت و درآمد انتقالی (ارقام فارسی، ي و ك): پرسیده می‌شود، چیزی ثبت نمی‌شود', async () => {
  const { inBook } = await freshBook('مانده — افتتاحیه');
  await inBook(() => {
    const opening = database.importOpeningBalanceFile(Buffer.from(OPENING_CSV, 'utf8'), 'opening.csv', { amountUnit: 'toman', occurredAt: OPENING_AT });
    const flagged = opening.unscheduledTimingBalances;
    assert.deepEqual(flagged.map((item) => [item.chartCode, item.kind, item.residual]), [['1401', 'prepaid', 12_000_000], ['3105', 'deferred', 6_000_000]]);
    const [insurance] = flagged[0].entries;
    assert.deepEqual(insurance.suggestedCoverage, { start: '2026-09-23T08:30:00.000Z', end: '2027-09-22T08:30:00.000Z' }, 'مهر ۱۴۰۵ تا شهریور ۱۴۰۶، از شرح خودِ ردیف');
    assert.equal(insurance.suggestedCategory, 'بیمه');
    assert.match(flagged[0].question, /دورهٔ پوشش/);
    assert.deepEqual(database.reviewQueue().unscheduledBalances.map((item) => item.chartCode), ['1401', '3105']);
    const journals = sql().prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
    assert.deepEqual(database.runRecognition(), { posted: 0, blocked: 0, skipped: 0, unscheduled: 2 });
    assert.equal(sql().prepare('SELECT COUNT(*) n FROM journal_entries').get().n, journals, 'پرسیدن سند نمی‌زند');
  });
});

test('جواب حسابدار به ماندهٔ افتتاحیه: برنامه بی سند نقدی تازه، و پیش‌پرداخت و درآمد انتقالی در پایان دوره صفر', async () => {
  const { inBook } = await freshBook('مانده — جواب افتتاحیه');
  await inBook(() => {
    database.importOpeningBalanceFile(Buffer.from(OPENING_CSV, 'utf8'), 'opening.csv', { amountUnit: 'toman', occurredAt: OPENING_AT });
    const [prepaid, deferred] = database.unscheduledBalances().items;
    const journals = sql().prepare('SELECT COUNT(*) n FROM journal_entries').get().n;
    const insurance = database.scheduleBalance(prepaid.accountId, { coverageText: prepaid.entries[0].description, category: 'بیمه', reason: 'بیمهٔ یک‌سالهٔ انبار طبق بیمه‌نامه' });
    assert.equal(insurance.items.length, 12);
    const rent = database.scheduleBalance(deferred.accountId, { coverageText: 'از اول مهر ۱۴۰۵ به مدت ۶ ماه', category: 'درآمد اجاره' });
    assert.equal(rent.items.length, 6);
    assert.equal(sql().prepare('SELECT COUNT(*) n FROM journal_entries').get().n, journals, 'هیچ سند نقدی یا دارایی تازه‌ای');
    assert.deepEqual(database.unscheduledBalances().items, []);
    run(LONG_AFTER);
    assert.equal(ledgerOf(chartLedger('1401')), 0);
    assert.equal(ledgerOf(chartLedger('3105')), 0);
    assert.equal(byType('expense'), 12_000_000);
    assert.equal(byType('income'), -6_000_000);
  });
});

test('سند دستی دسته‌ای و سند اصلاحی روی پیش‌پرداخت‌ها: هر سند جدا دوره می‌گیرد و حساب کلی صفر می‌شود', async () => {
  const { inBook } = await freshBook('مانده — سند دستی');
  await inBook(() => {
    database.importOpeningBalanceFile(Buffer.from(OPENING_CSV, 'utf8'), 'opening.csv', { amountUnit: 'toman', occurredAt: OPENING_AT });
    const prepaidId = chartLedger('1401');
    const cashId = chartLedger('1101');
    const batch = database.createJournalDocuments([{ occurredAt: NOW, memo: 'پیش‌پرداخت اجاره ۶ ماهه دفتر (مهر تا اسفند ۱۴۰۵)',
      lines: [{ accountId: prepaidId, debit: 30_000_000 }, { accountId: cashId, credit: 30_000_000 }] }]);
    approveJournal(batch.entryIds[0]);
    assert.deepEqual(database.unscheduledBalancesForEntry(batch.entryIds[0]).map((item) => item.residual), [42_000_000], 'پاسخ تأیید سند همان سؤال را دارد');
    const adjustment = accounting.createAdjustingJournal(sql(), { occurredAt: '2026-10-10T09:00:00.000Z', memo: 'اشتراک یک ساله نرم افزار از 1405/07/18',
      lines: [{ accountId: prepaidId, debit: 24_000_000 }, { accountId: cashId, credit: 24_000_000 }] }, { createdBy: owner.id });
    approveJournal(adjustment.id);
    const [open] = database.unscheduledBalances().items.filter((item) => item.accountId === prepaidId);
    assert.equal(open.residual, 66_000_000);
    assert.deepEqual(open.entries.map((entry) => entry.amount), [12_000_000, 30_000_000, 24_000_000]);
    assert.deepEqual(open.entries[1].suggestedCoverage, { start: '2026-09-23T08:30:00.000Z', end: '2027-03-20T08:30:00.000Z' }, 'مهر تا اسفند ۱۴۰۵');
    for (const [entry, category] of open.entries.map((entry, index) => [entry, ['بیمه', 'اجاره', 'نرم‌افزار و اشتراک'][index]])) {
      const coverage = entry.suggestedCoverage;
      assert.ok(coverage, entry.memo);
      database.scheduleBalance(prepaidId, { entryId: entry.entryId, amount: entry.amount, start: coverage.start, end: coverage.end, category });
    }
    assert.deepEqual(database.unscheduledBalances().items.filter((item) => item.accountId === prepaidId), []);
    run(LONG_AFTER);
    assert.equal(ledgerOf(prepaidId), 0);
    assert.equal(byType('expense'), 66_000_000);
  });
});

test('ماندهٔ بی‌دوره: بی‌جواب برنامه ساخته نمی‌شود — دوره و برای حساب کلی دسته پرسیده می‌شود', async () => {
  const { inBook } = await freshBook('مانده — بی‌دوره');
  await inBook(() => {
    const prepaidId = chartLedger('1401');
    const batch = database.createJournalDocuments([{ occurredAt: NOW, memo: 'پیش‌پرداخت',
      lines: [{ accountId: prepaidId, debit: 9_000_000 }, { accountId: chartLedger('1101'), credit: 9_000_000 }] }]);
    approveJournal(batch.entryIds[0]);
    const [open] = database.unscheduledBalances().items;
    assert.equal(open.entries[0].suggestedCoverage, null, 'شرح دوره ندارد؛ پیشنهادی ساخته نمی‌شود');
    assert.throws(() => database.scheduleBalance(prepaidId, { category: 'بیمه' }), (error) => error.code === 'REVIEW_DETAILS_REQUIRED' && error.question.id === 'coverage.start');
    assert.throws(() => database.scheduleBalance(prepaidId, { coverageText: '۱۲ ماه', category: 'بیمه' }), { code: 'REVIEW_DETAILS_REQUIRED' });
    assert.throws(() => database.scheduleBalance(prepaidId, { coverageText: 'از اول آبان ۱۴۰۵ به مدت ۳ ماه' }), (error) => error.question?.id === 'balance.category');
    assert.throws(() => database.scheduleBalance(prepaidId, { coverageText: 'از اول آبان ۱۴۰۵ به مدت ۳ ماه', category: 'بیمه', amount: 10_000_000 }), { code: 'TIMING_BALANCE_INVALID' });
    assert.equal(sql().prepare('SELECT COUNT(*) n FROM recognition_schedule_items').get().n, 0);
  });
});

test('پوششِ مانده که پیش از تاریخ مانده شروع شده: ماه‌های گذشته همان تاریخ مانده جبران می‌شوند، نه پیش از آن', async () => {
  const { inBook } = await freshBook('مانده — پوشش گذشته');
  await inBook(() => {
    const csv = ['کد حساب,نام حساب,بدهکار,بستانکار,کد تفصیلی', '1101,صندوق,10000000,,', '1401,بیمه انبار (فروردین 1405 تا اسفند 1405),12000000,,', '5101,سرمایه,,22000000,'].join('\n');
    database.importOpeningBalanceFile(Buffer.from(csv, 'utf8'), 'opening.csv', { amountUnit: 'toman', occurredAt: OPENING_AT });
    const [open] = database.unscheduledBalances().items;
    const { items: schedule } = database.scheduleBalance(open.accountId, { coverageText: open.entries[0].description, category: 'بیمه' });
    assert.equal(schedule.length, 12);
    assert.ok(schedule.every((item) => item.recognitionDate >= OPENING_AT), 'هیچ قلمی پیش از تاریخ مانده');
    assert.equal(schedule.filter((item) => item.recognitionDate === OPENING_AT).length, 6, 'فروردین تا شهریور همان روز؛ مهر اول خودش');
    assert.equal(run(NOW).posted, 7);
    assert.equal(ledgerOf(open.accountId), 5_000_000);
  });
});

test('برگشت برنامهٔ مانده: فقط برنامه برمی‌گردد، سند افتتاحیه دست نمی‌خورد و سؤال دوباره باز می‌شود', async () => {
  const { inBook } = await freshBook('مانده — برگشت');
  await inBook(() => {
    database.importOpeningBalanceFile(Buffer.from(OPENING_CSV, 'utf8'), 'opening.csv', { amountUnit: 'toman', occurredAt: OPENING_AT });
    const [prepaid] = database.unscheduledBalances().items;
    const { eventId } = database.scheduleBalance(prepaid.accountId, { coverageText: prepaid.entries[0].description, category: 'بیمه' });
    run(AZAR);
    const opening = sql().prepare("SELECT COUNT(*) n FROM journal_entries WHERE source_type<>'recognition-schedule'").get().n;
    database.reverseEvent(eventId, 'دورهٔ بیمه اشتباه وارد شده بود');
    assert.equal(sql().prepare("SELECT COUNT(*) n FROM journal_entries WHERE source_type<>'recognition-schedule' AND reverses_entry_id IS NULL").get().n, opening, 'سند مبنا معکوس نشد');
    assert.equal(ledgerOf(prepaid.accountId), 12_000_000, 'هزینهٔ شناسایی‌شده برگشت');
    assert.deepEqual(database.unscheduledBalances().items.find((item) => item.accountId === prepaid.accountId)?.residual, 12_000_000);
  });
});

test('منفی: ماندهٔ رویدادِ برنامه‌دار، و پیش‌پرداخت خرید کالا، ماندهٔ بی‌برنامه شمرده نمی‌شوند', async () => {
  const { inBook } = await freshBook('مانده — منفی');
  await inBook(async () => {
    capture('بیمه یک ساله انبار ۱۲ میلیون از حساب تجارت دادیم');
    run(AZAR);
    const { resolveEventRole } = await import('../server/roleResolver.js');
    const supplier = database.saveContact({ name: 'کارخانه فولاد مبارکه' });
    const advance = resolveEventRole(sql(), 'supplier-advance', 'کارخانه فولاد مبارکه', { counterpartyId: supplier.id });
    const batch = database.createJournalDocuments([{ occurredAt: NOW, memo: 'پیش پرداخت خرید ورق، بار نرسیده',
      lines: [{ accountId: advance, debit: 50_000_000 }, { accountId: chartLedger('1101'), credit: 50_000_000 }] }]);
    approveJournal(batch.entryIds[0]);
    assert.deepEqual(database.unscheduledBalances().items, []);
    assert.equal(database.runRecognition().unscheduled, undefined);
  });
});

test('بستن دوره و تأیید سند دستی، ماندهٔ بی‌برنامه را برمی‌گردانند', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const lockRoute = source.slice(source.indexOf("app.post('/api/accounting/periods/:period/lock'"), source.indexOf("app.post('/api/accounting/periods/:period/reopen'"));
  assert.match(lockRoute, /unscheduledTimingBalances: unscheduled/);
  const approval = source.slice(source.indexOf("app.post('/api/accounting/journal/:id/approval'"), source.indexOf("app.get('/api/accounting/templates'"));
  assert.match(approval, /unscheduledBalancesForEntry\(request\.params\.id\)/);
});
