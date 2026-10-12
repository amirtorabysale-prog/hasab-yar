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
