import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

const databasePath = tempDatabase('recognition-run');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'recog-owner';
process.env.ADMIN_PASSWORD = `recog-${crypto.randomUUID()}`;

const database = await import(`../server/db.js?recog=${process.pid}`);
const accounting = await import(`../server/accounting.js?recog=${process.pid}`);
const store = await import(`../server/financialEventStore.js?recog=${process.pid}`);
const { normalizeFinancialEvent } = await import('../shared/financialEvent.js');
const { routeEvent } = await import('../shared/confidenceEngine.js');
const { decide } = await import('../shared/accountingDecision.js');
const { factsFromEvent } = await import('../shared/eventFacts.js');

database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
// رویدادهای ساختگی بی‌موجودیِ پیشین سند می‌خورند؛ نگهبان صندوق با تأیید صریح آزمون، نه خاموش.
const inPrimary = (callback) => database.runInWorkspace('primary', { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const PAID_AT = '2026-09-24T00:00:00.000Z';        // مهر ۱۴۰۵
const AFTER_TWO_MONTHS = '2026-11-25T00:00:00.000Z'; // آذر ۱۴۰۵

/**
 * اجرای اقلام شناسایی در سررسید — نیمهٔ گمشدهٔ فاز ۲.
 *
 * تا امروز برنامهٔ شناسایی ساخته و ذخیره و باطل می‌شد، ولی کسی سررسید که
 * می‌رسید ثبتش نمی‌کرد. یعنی پیش‌پرداخت تا ابد دارایی می‌ماند و هیچ‌وقت
 * هزینه نمی‌شود — که دقیقاً همان خطایی است که این پروژه برای حذفش نوشته شد،
 * فقط در جهت مخالف.
 */

const prepaid = (extra = {}) => normalizeFinancialEvent({
  kind: 'cash-expense', amount: 12_000_000, occurredAt: PAID_AT,
  category: 'بیمه', accountId: 'bank-mellat',
  servicePeriodStart: PAID_AT, servicePeriodEnd: '2027-09-22T00:00:00.000Z', ...extra,
});

/** رویداد را ثبت و سندش را می‌زند تا دارایی واقعاً در دفتر باشد. */
function postedPrepaid(sourceEventId, event = prepaid()) {
  const created = store.recordFinancialEvent(db(), event, {
    sourceEventId,
    decision: routeEvent({ kind: event.kind }, { blockers: ['تأیید لازم است'] }),
    actor: owner.id,
    accountingDecision: decide(factsFromEvent(event), { today: PAID_AT }),
  });
  store.approveFinancialEvent(db(), created.id, { actor: owner.id });
  return created;
}

const accountNames = (entryId) => accounting.listJournal(db(), { limit: 500 }).items
  .find((item) => item.id === entryId)?.lines
  .map((line) => db().prepare('SELECT name FROM ledger_accounts WHERE id=?').get(line.accountId)?.name || '') || [];

test('قلمِ سررسیدرسیده ثبت می‌شود', () => {
  inPrimary(() => {
    const created = postedPrepaid('run:1');
    const result = store.postDueRecognitionItems(db(), { today: AFTER_TWO_MONTHS, actor: owner.id });
    assert.ok(result.posted >= 2, `دو ماه گذشته، پس دست‌کم دو قلم باید ثبت شود — شد ${result.posted}`);

    const schedule = store.scheduleForEvent(db(), created.id);
    const posted = schedule.filter((item) => item.status === 'posted');
    assert.ok(posted.length >= 2);
    assert.ok(posted.every((item) => item.journalEntryId), 'هر قلم ثبت‌شده باید سند داشته باشد');
  });
});

test('سندِ تخصیص، دارایی را کم و هزینه را زیاد می‌کند', () => {
  inPrimary(() => {
    const created = postedPrepaid('run:2');
    store.postDueRecognitionItems(db(), { today: AFTER_TWO_MONTHS, actor: owner.id });
    const [item] = store.scheduleForEvent(db(), created.id).filter((entry) => entry.status === 'posted');
    const names = accountNames(item.journalEntryId);
    assert.ok(names.some((name) => name.includes('پیش‌پرداخت')), 'از پیش‌پرداخت کم می‌شود');
    assert.ok(names.some((name) => name.includes('بیمه') && !name.includes('پیش‌پرداخت')), 'و به هزینه می‌رود');
  });
});

test('اجرای دوباره، سند دوم نمی‌سازد', () => {
  // این حیاتی‌ترین تضمین این بخش است: کار زمان‌بندی‌شده ممکن است چند بار در
  // روز اجرا شود، و هر اجرای اضافه نباید هزینه را دوباره بسازد.
  inPrimary(() => {
    postedPrepaid('run:3');
    const before = accounting.listJournal(db(), { limit: 500 }).items.length;
    store.postDueRecognitionItems(db(), { today: AFTER_TWO_MONTHS, actor: owner.id });
    const middle = accounting.listJournal(db(), { limit: 500 }).items.length;
    store.postDueRecognitionItems(db(), { today: AFTER_TWO_MONTHS, actor: owner.id });
    const after = accounting.listJournal(db(), { limit: 500 }).items.length;
    assert.ok(middle > before, 'اجرای اول باید سند بزند');
    assert.equal(after, middle, 'اجرای دوم نباید هیچ سندی بزند');
  });
});

test('قلمِ آینده ثبت نمی‌شود', () => {
  inPrimary(() => {
    const created = postedPrepaid('run:4');
    store.postDueRecognitionItems(db(), { today: PAID_AT, actor: owner.id });
    const planned = store.scheduleForEvent(db(), created.id).filter((item) => item.status === 'planned');
    assert.ok(planned.length >= 10, 'ماه‌های آینده باید دست‌نخورده بمانند');
  });
});

test('قلمِ دورهٔ بسته ثبت نمی‌شود و علامت می‌خورد', () => {
  inPrimary(() => {
    const created = postedPrepaid('run:5');
    db().prepare("INSERT INTO accounting_periods (period,status) VALUES ('1405-08','locked') ON CONFLICT(period) DO UPDATE SET status='locked'").run();
    store.postDueRecognitionItems(db(), { today: AFTER_TWO_MONTHS, actor: owner.id });

    const blocked = store.scheduleForEvent(db(), created.id).filter((item) => item.status === 'blocked-closed-period');
    assert.ok(blocked.length > 0, 'قلمِ دورهٔ بسته باید علامت بخورد');
    assert.equal(blocked.every((item) => !item.journalEntryId), true, 'و سندی نزده باشد');
    db().prepare("UPDATE accounting_periods SET status='open' WHERE period='1405-08'").run();
    // علامت پایان راه نیست: دوره که باز شود، اجرای بعدی همان قلم را ثبت می‌کند.
    store.postDueRecognitionItems(db(), { today: AFTER_TWO_MONTHS, actor: owner.id });
    const resumed = store.scheduleForEvent(db(), created.id).filter((item) => blocked.some((entry) => entry.key === item.key));
    assert.ok(resumed.every((item) => item.status === 'posted' && item.journalEntryId), 'قلمِ دورهٔ بازشده ثبت می‌شود');
  });
});

test('قلمِ رویدادی که هنوز سند نخورده، ثبت نمی‌شود', () => {
  // تخصیص از دارایی‌ای کم می‌کند که هنوز ساخته نشده: مانده منفی می‌شود و
  // هیچ‌کس نمی‌فهمد از کجا آمده.
  inPrimary(() => {
    const event = prepaid();
    const created = store.recordFinancialEvent(db(), event, {
      sourceEventId: 'run:6',
      decision: routeEvent({ kind: event.kind }, { blockers: ['تأیید لازم است'] }),
      actor: owner.id,
      accountingDecision: decide(factsFromEvent(event), { today: PAID_AT }),
    });
    const before = accounting.listJournal(db(), { limit: 500 }).items.length;
    store.postDueRecognitionItems(db(), { today: AFTER_TWO_MONTHS, actor: owner.id });
    assert.equal(accounting.listJournal(db(), { limit: 500 }).items.length, before, 'هیچ سندی نباید زده شود');
    assert.equal(store.scheduleForEvent(db(), created.id).every((item) => item.status !== 'posted'), true);
  });
});

test('قلمِ باطل‌شده هیچ‌وقت ثبت نمی‌شود', () => {
  inPrimary(() => {
    // دوره پیش از ثبت کوتاه می‌شود؛ روی رویدادِ ثبت‌شده نمی‌شود جواب داد و
    // همین درست است — سند خورده و تغییر دوره‌اش کار اصلاح است، نه پاسخ.
    const event = prepaid();
    const created = store.recordFinancialEvent(db(), event, {
      sourceEventId: 'run:7',
      decision: routeEvent({ kind: event.kind }, { blockers: ['تأیید لازم است'] }),
      actor: owner.id,
      accountingDecision: decide(factsFromEvent(event), { today: PAID_AT }),
    });
    store.answerEventQuestion(db(), created.id, {
      fact: 'servicePeriodEnd', value: 'three-months', actor: owner.id, today: PAID_AT,
    });
    store.approveFinancialEvent(db(), created.id, { actor: owner.id });
    store.postDueRecognitionItems(db(), { today: '2027-06-01T00:00:00.000Z', actor: owner.id });
    const superseded = store.scheduleForEvent(db(), created.id).filter((item) => item.status === 'superseded');
    assert.ok(superseded.length > 0);
    assert.equal(superseded.every((item) => !item.journalEntryId), true, 'قلم باطل نباید سند بزند');
  });
});

test('گزارش اجرا می‌گوید چه شد', () => {
  inPrimary(() => {
    const result = store.postDueRecognitionItems(db(), { today: AFTER_TWO_MONTHS, actor: owner.id });
    assert.equal(typeof result.posted, 'number');
    assert.equal(typeof result.blocked, 'number');
    assert.equal(typeof result.skipped, 'number');
  });
});
