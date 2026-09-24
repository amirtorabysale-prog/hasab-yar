import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('fingerprint');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'print-owner';
process.env.ADMIN_PASSWORD = `print-${crypto.randomUUID()}`;

const database = await import(`../server/db.js?print=${process.pid}`);
const accounting = await import(`../server/accounting.js?print=${process.pid}`);
const store = await import(`../server/financialEventStore.js?print=${process.pid}`);
const { eventFingerprint } = await import('../shared/eventFingerprint.js');
const { normalizeFinancialEvent } = await import('../shared/financialEvent.js');
const { routeEvent } = await import('../shared/confidenceEngine.js');

database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const inPrimary = (callback) => database.runInWorkspace('primary', { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const OCCURRED = '2026-09-24T09:00:00.000Z';

/**
 * همان فاکتور، از دو کانال.
 *
 * `source_event_id` یکتاست و کار می‌کند، ولی تک‌کاناله است: همان فاکتور اگر یک
 * بار با صدا و یک بار با عکس ثبت شود، دو شناسهٔ منبع متفاوت دارد و دو سند
 * می‌سازد. کاربر هم هیچ‌وقت نمی‌فهمد، چون هر دو ثبت از دید خودش درست بوده‌اند.
 */

const event = (extra = {}) => normalizeFinancialEvent({
  kind: 'cash-expense', amount: 12_000_000, occurredAt: OCCURRED,
  category: 'بیمه', accountId: 'bank-mellat', ...extra,
});

const confident = () => routeEvent({ kind: 'cash-expense' }, {
  components: { amountCertainty: 0.99, moneyDirectionCertainty: 0.99, dateCertainty: 0.99, completeness: 0.98 },
});

test('اثر انگشت از محتوا ساخته می‌شود، نه از کانال', () => {
  const fromVoice = eventFingerprint(event({ source: 'voice', evidence: 'حق بیمه دوازده میلیون' }));
  const fromImage = eventFingerprint(event({ source: 'import', evidence: 'رسید اسکن‌شده' }));
  assert.equal(fromVoice, fromImage, 'یک رویداد، یک اثر انگشت — از هر کانالی که آمده باشد');
});

test('مبلغ متفاوت، اثر انگشت متفاوت', () => {
  assert.notEqual(eventFingerprint(event()), eventFingerprint(event({ amount: 12_000_001 })));
});

test('طرف حساب متفاوت، اثر انگشت متفاوت', () => {
  assert.notEqual(eventFingerprint(event({ counterparty: 'الف' })), eventFingerprint(event({ counterparty: 'ب' })));
});

test('ساعتِ متفاوت در همان روز، همان اثر انگشت', () => {
  // کاربر صبح ضبط می‌کند و ظهر عکس رسید را می‌فرستد. اگر ساعت در اثر انگشت
  // بیاید، هیچ‌وقت هیچ تکراری پیدا نمی‌شود.
  assert.equal(
    eventFingerprint(event({ occurredAt: '2026-09-24T06:00:00.000Z' })),
    eventFingerprint(event({ occurredAt: '2026-09-24T20:00:00.000Z' })),
  );
});

test('روز متفاوت، اثر انگشت متفاوت', () => {
  assert.notEqual(eventFingerprint(event()), eventFingerprint(event({ occurredAt: '2026-09-25T09:00:00.000Z' })));
});

test('همان فاکتور از دو کانال، سند دوم نمی‌سازد', () => {
  inPrimary(() => {
    const first = store.recordFinancialEvent(db(), event({ source: 'voice' }), {
      sourceEventId: 'voice:inv-1', decision: confident(), actor: owner.id,
    });
    assert.equal(first.status, 'posted');
    const before = accounting.listJournal(db(), { limit: 200 }).items.length;

    const second = store.recordFinancialEvent(db(), event({ source: 'import' }), {
      sourceEventId: 'image:inv-1', decision: confident(), actor: owner.id,
    });
    assert.equal(second.duplicate, true, 'باید تکراری تشخیص داده شود');
    assert.equal(second.id, first.id, 'همان رویداد قبلی برگردانده می‌شود');
    assert.equal(accounting.listJournal(db(), { limit: 200 }).items.length, before, 'سند دوم نباید ساخته شود');
  });
});

test('دو ثبت واقعاً متفاوت در یک روز، هر دو ثبت می‌شوند', () => {
  // دو قبض برق در یک روز با مبلغ متفاوت، تکرار نیستند. نگهبانی که این‌ها را
  // یکی کند، ثبت درست کاربر را می‌خورد.
  inPrimary(() => {
    const before = accounting.listJournal(db(), { limit: 200 }).items.length;
    store.recordFinancialEvent(db(), event({ amount: 3_000_000, category: 'قبوض' }), {
      sourceEventId: 'voice:bill-1', decision: confident(), actor: owner.id,
    });
    store.recordFinancialEvent(db(), event({ amount: 4_000_000, category: 'قبوض' }), {
      sourceEventId: 'voice:bill-2', decision: confident(), actor: owner.id,
    });
    assert.equal(accounting.listJournal(db(), { limit: 200 }).items.length, before + 2);
  });
});

test('رویداد رد یا معکوس‌شده، جلوی ثبت تازه را نمی‌گیرد', () => {
  // کاربر یک ثبت را رد کرده و دوباره درستش را گفته. اگر اثر انگشتِ ردشده
  // همچنان مسدود کند، ثبت درست هیچ‌وقت وارد نمی‌شود.
  inPrimary(() => {
    const rejected = store.recordFinancialEvent(db(), event({ amount: 7_000_000, category: 'خوراک' }), {
      sourceEventId: 'voice:food-1', decision: routeEvent({ kind: 'cash-expense' }, { blockers: ['تأیید لازم است'] }), actor: owner.id,
    });
    store.rejectFinancialEvent(db(), rejected.id, { actor: owner.id, reason: 'اشتباه بود' });

    const again = store.recordFinancialEvent(db(), event({ amount: 7_000_000, category: 'خوراک' }), {
      sourceEventId: 'voice:food-2', decision: confident(), actor: owner.id,
    });
    assert.equal(again.duplicate, undefined === again.duplicate ? undefined : false, 'ثبت تازه نباید تکراری شمرده شود');
    assert.equal(again.status, 'posted');
  });
});

test('دو ثبت یکسان از همان کانال، هر دو ثبت می‌شوند', () => {
  // دو بار بنزین پانصد هزاری در یک روز، محتوای یکسان دارند و هر دو درست‌اند.
  // یکی‌کردنشان ثبت درست کاربر را می‌خورد و او هیچ‌وقت نمی‌فهمد. آنچه واقعاً
  // مشکوک است همان فاکتوری است که یک بار گفته شده و یک بار عکسش فرستاده شده.
  inPrimary(() => {
    const before = accounting.listJournal(db(), { limit: 200 }).items.length;
    store.recordFinancialEvent(db(), event({ amount: 500_000, category: 'سوخت و ایاب‌وذهاب', source: 'voice' }), {
      sourceEventId: 'voice:fuel-1', decision: confident(), actor: owner.id,
    });
    store.recordFinancialEvent(db(), event({ amount: 500_000, category: 'سوخت و ایاب‌وذهاب', source: 'voice' }), {
      sourceEventId: 'voice:fuel-2', decision: confident(), actor: owner.id,
    });
    assert.equal(accounting.listJournal(db(), { limit: 200 }).items.length, before + 2, 'هر دو باید ثبت شوند');
  });
});
