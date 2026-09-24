import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('schedule-edges');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'schedule-owner';
process.env.ADMIN_PASSWORD = `schedule-${crypto.randomUUID()}`;

const database = await import(`../server/db.js?sched=${process.pid}`);
const store = await import(`../server/financialEventStore.js?sched=${process.pid}`);
const { SCHEDULE_ITEM_STATUS, buildMonthlySchedule } = await import('../shared/recognitionSchedule.js');
const { normalizeFinancialEvent } = await import('../shared/financialEvent.js');
const { routeEvent } = await import('../shared/confidenceEngine.js');
const { decide } = await import('../shared/accountingDecision.js');
const { factsFromEvent } = await import('../shared/eventFacts.js');

database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const inPrimary = (callback) => database.runInWorkspace('primary', { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const PAID_AT = '2026-09-24T00:00:00.000Z';

/**
 * لبه‌های برنامهٔ شناسایی.
 *
 * برنامه‌ای که فقط حالت خوش‌بینانه را درست کار کند، در دفتر واقعی خطرناک‌تر از
 * نداشتنش است: کاربر به آن اعتماد می‌کند و لبه‌ها بی‌صدا غلط می‌شوند.
 */

// ---------------------------------------------------------------------------
// منطق خالص
// ---------------------------------------------------------------------------

test('شروع پوشش پیش از تاریخ پرداخت، از خودِ پوشش شروع می‌شود', () => {
  // بیمه‌ای که از اول مهر شروع شده ولی آبان پرداخت شده: مهر هم باید در
  // برنامه باشد، وگرنه یک ماه پوشش هیچ‌وقت هزینه نمی‌شود.
  const items = buildMonthlySchedule({
    amount: 12_000_000,
    periodStart: '2026-09-23T00:00:00.000Z',
    periodEnd: '2027-09-22T00:00:00.000Z',
    sourceId: 'evt-early',
  });
  assert.equal(items.length, 12);
  assert.equal(items[0].periodKey, '1405-07', 'از ماه شروع پوشش، نه ماه پرداخت');
});

test('پرداخت جزئی، برنامه را به همان مبلغ می‌بندد', () => {
  // نصف قرارداد پرداخت شده: برنامه هم نصف است، نه کل قرارداد.
  const items = buildMonthlySchedule({
    amount: 6_000_000, periodStart: PAID_AT, periodEnd: '2027-09-23T00:00:00.000Z', sourceId: 'evt-partial',
  });
  assert.equal(items.reduce((sum, item) => sum + item.amount, 0), 6_000_000);
});

test('دورهٔ یک‌روزه، یک قلم می‌سازد', () => {
  const items = buildMonthlySchedule({ amount: 1_000_000, periodStart: PAID_AT, periodEnd: PAID_AT, sourceId: 'evt-one' });
  assert.equal(items.length, 1);
  assert.equal(items[0].amount, 1_000_000);
});

test('دورهٔ وارونه، برنامه نمی‌سازد', () => {
  // پایان پیش از شروع یعنی داده خراب است؛ ساختن برنامه از آن، اعداد بی‌معنا
  // در دفتر می‌گذارد.
  assert.deepEqual(buildMonthlySchedule({
    amount: 1_000_000, periodStart: '2027-01-01T00:00:00.000Z', periodEnd: PAID_AT, sourceId: 'evt-bad',
  }), []);
});

// ---------------------------------------------------------------------------
// لبه‌های سطح دیتابیس
// ---------------------------------------------------------------------------

const prepaidEvent = (extra = {}) => normalizeFinancialEvent({
  kind: 'cash-expense', amount: 12_000_000, occurredAt: PAID_AT,
  category: 'بیمه', accountId: 'bank-mellat',
  servicePeriodStart: PAID_AT, servicePeriodEnd: '2027-09-22T00:00:00.000Z', ...extra,
});

const record = (sourceEventId, event) => store.recordFinancialEvent(db(), event, {
  sourceEventId,
  decision: routeEvent({ kind: event.kind }, { blockers: ['تأیید لازم است'] }),
  actor: owner.id,
  accountingDecision: decide(factsFromEvent(event), { today: PAID_AT }),
});

test('دوره که کوتاه‌تر شود، اقلام اضافی باطل می‌شوند', () => {
  // بدون این، قرارداد یک‌ساله‌ای که به شش ماه تغییر می‌کند، شش قلم یتیم در
  // برنامه باقی می‌گذارد که شش ماه هزینهٔ جعلی می‌سازند.
  inPrimary(() => {
    const created = record('edge:shorten', prepaidEvent());
    assert.equal(store.scheduleForEvent(db(), created.id).length, 12);

    store.answerEventQuestion(db(), created.id, {
      fact: 'servicePeriodEnd', value: 'six-months', actor: owner.id, today: PAID_AT,
    });

    const active = store.scheduleForEvent(db(), created.id).filter((item) => item.status !== 'superseded');
    assert.equal(active.length, 6, 'فقط شش ماه باید فعال بماند');
    assert.equal(active.reduce((sum, item) => sum + item.amount, 0), 12_000_000, 'کل مبلغ روی شش ماه پخش می‌شود');
  });
});

test('اقلام باطل‌شده حذف نمی‌شوند، علامت می‌خورند', () => {
  // حذف یعنی تاریخچه پاک می‌شود و هیچ‌کس نمی‌فهمد چرا برنامه عوض شد.
  inPrimary(() => {
    const created = record('edge:history', prepaidEvent());
    store.answerEventQuestion(db(), created.id, {
      fact: 'servicePeriodEnd', value: 'three-months', actor: owner.id, today: PAID_AT,
    });
    const all = store.scheduleForEvent(db(), created.id);
    assert.ok(all.some((item) => item.status === 'superseded'), 'اقلام قبلی باید در تاریخچه بمانند');
  });
});

test('شناسایی در دورهٔ بسته، ثبت نمی‌شود و علامت می‌خورد', () => {
  // تصمیم ۳ فاز صفر: نه به دورهٔ بعد منتقل می‌شود و نه دورهٔ بسته را باز
  // می‌کند؛ با دلیل روشن به حسابدار می‌رود.
  inPrimary(() => {
    db().prepare("INSERT INTO accounting_periods (period,status) VALUES ('1405-07','locked') ON CONFLICT(period) DO UPDATE SET status='locked'").run();
    const created = record('edge:locked', prepaidEvent());
    const blocked = store.scheduleForEvent(db(), created.id).filter((item) => item.status === SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD);
    assert.ok(blocked.length > 0, 'قلمِ دورهٔ بسته باید علامت بخورد');
    assert.equal(blocked[0].periodKey, '1405-07');
    db().prepare("UPDATE accounting_periods SET status='open' WHERE period='1405-07'").run();
  });
});

test('اجرای دوباره، همان برنامه را می‌دهد', () => {
  inPrimary(() => {
    const created = record('edge:idempotent', prepaidEvent());
    const first = store.scheduleForEvent(db(), created.id);
    store.answerEventQuestion(db(), created.id, {
      fact: 'servicePeriodEnd', value: 'one-year', actor: owner.id, today: PAID_AT,
    });
    assert.deepEqual(store.scheduleForEvent(db(), created.id), first);
  });
});
