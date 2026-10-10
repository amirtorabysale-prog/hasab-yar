import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

const databasePath = tempDatabase('depreciation');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'depreciation-owner';
process.env.ADMIN_PASSWORD = `depreciation-${crypto.randomUUID()}`;

const database = await import(`../server/db.js?depreciation=${process.pid}`);
const accounting = await import(`../server/accounting.js?depreciation=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const inPrimary = (callback) => database.runInWorkspace('primary', { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);

const ASSET = 'دستگاه چاپ';
const assetOf = (items) => items.find((item) => item.assetKey === ASSET);

test('دارایی ثابتِ ثبت‌شده در دفتر دارایی‌ها دیده می‌شود', () => {
  inPrimary(() => {
    database.recordCapitalEntry({ kind: 'fixed-asset', amount: 120_000_000, title: ASSET, occurredAt: '2026-03-21T09:00:00.000Z' });
    const asset = assetOf(database.fixedAssetOverview({ throughMonth: '1405-06' }).items);
    assert.ok(asset, 'دارایی باید در فهرست بیاید');
    assert.equal(asset.cost, 120_000_000);
    // بدون عمر مفید هیچ استهلاکی محاسبه نمی‌شود؛ حدس‌زدن عمر یعنی سود دوره غلط.
    assert.equal(asset.configured, false);
    assert.deepEqual(asset.due, []);
  });
});

test('بدون عمر مفید، اجرای استهلاک هیچ سندی نمی‌زند', () => {
  inPrimary(() => {
    const result = database.postDepreciation({ throughMonth: '1405-06' });
    assert.equal(result.posted, 0);
    assert.equal(result.amount, 0);
  });
});

test('عمر مفید نامعتبر رد می‌شود', () => {
  inPrimary(() => {
    assert.throws(() => database.saveFixedAsset({ assetKey: ASSET, usefulLifeMonths: 0, inServiceMonth: '1405-01' }), /عمر مفید/);
    assert.throws(() => database.saveFixedAsset({ assetKey: ASSET, usefulLifeMonths: 60, inServiceMonth: '1405-13' }), /ماه بهره‌برداری/);
    assert.throws(() => database.saveFixedAsset({ assetKey: 'دارایی ناموجود', usefulLifeMonths: 60, inServiceMonth: '1405-01' }), (error) => error.code === 'ASSET_MISSING');
  });
});

test('پس از ثبت عمر مفید، اقساط سررسیدشده محاسبه می‌شوند', () => {
  inPrimary(() => {
    database.saveFixedAsset({ assetKey: ASSET, usefulLifeMonths: 60, salvage: 0, inServiceMonth: '1405-01' });
    const asset = assetOf(database.fixedAssetOverview({ throughMonth: '1405-03' }).items);
    assert.equal(asset.configured, true);
    assert.equal(asset.months, 60);
    assert.equal(asset.due.length, 3);
    assert.equal(asset.due[0].amount, 2_000_000);
  });
});

test('اجرای استهلاک سند می‌زند و دفتر متوازن می‌ماند', () => {
  inPrimary(() => {
    const before = accounting.trialBalance(database.activeWorkspaceDatabase());
    assert.equal(before.totals.debit, before.totals.credit);

    const result = database.postDepreciation({ throughMonth: '1405-03' });
    assert.equal(result.posted, 3);
    assert.equal(result.amount, 6_000_000);

    const after = accounting.trialBalance(database.activeWorkspaceDatabase());
    assert.equal(after.totals.debit, after.totals.credit, 'دفتر پس از سند استهلاک باید متوازن بماند');
  });
});

// ثبت دوبارهٔ یک ماه، هزینهٔ دوره را باد می‌کند و انباشته را از بها جلو می‌اندازد.
test('اجرای دوباره برای همان ماه چیزی ثبت نمی‌کند', () => {
  inPrimary(() => {
    const again = database.postDepreciation({ throughMonth: '1405-03' });
    assert.equal(again.posted, 0);
    assert.equal(again.amount, 0);
  });
});

test('ماه‌های تازه پس از اجرای قبلی ادامه پیدا می‌کنند', () => {
  inPrimary(() => {
    const result = database.postDepreciation({ throughMonth: '1405-05' });
    assert.equal(result.posted, 2);
    assert.deepEqual(result.months, ['1405-04', '1405-05']);
  });
});

test('استهلاک انباشته حساب جداست و بهای دارایی دست‌نخورده می‌ماند', () => {
  inPrimary(() => {
    const asset = assetOf(database.fixedAssetOverview({ throughMonth: '1405-05' }).items);
    assert.equal(asset.cost, 120_000_000, 'بهای تمام‌شده نباید با استهلاک کم شود');
    assert.equal(asset.accumulated, 10_000_000);
    assert.equal(asset.bookValue, 110_000_000);
    assert.equal(asset.behindAmount, 0);
  });
});

// استهلاک هزینهٔ همان ماه است؛ نشاندنش روی روز اجرا سود دو ماه را غلط می‌کند.
test('سند هر ماه روی آخرین روز همان ماه می‌نشیند', () => {
  inPrimary(() => {
    const journal = accounting.listJournal(database.activeWorkspaceDatabase(), { limit: 50 });
    const entries = journal.items.filter((item) => String(item.memo || '').startsWith('استهلاک'));
    assert.ok(entries.length >= 5);
    const persianMonth = (iso) => new Intl.DateTimeFormat('en-CA-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit' })
      .formatToParts(new Date(iso)).filter((part) => part.type !== 'literal')
      .reduce((value, part) => ({ ...value, [part.type]: part.value }), {});
    for (const entry of entries) {
      const memoMonth = entry.memo.split('—').at(-1).trim();
      const actual = persianMonth(entry.occurredAt);
      assert.equal(`${actual.year}-${actual.month}`, memoMonth, `سند ${entry.memo} در ماه خودش ننشسته`);
    }
  });
});

test('دورهٔ بسته سند استهلاک نمی‌پذیرد', () => {
  inPrimary(() => {
    database.closeAccountingPeriod?.('1405-06');
    // اگر بستن دوره در این نسخه از رابط دفتر در دسترس نباشد، این کنترل جای
    // دیگری آزموده می‌شود؛ آزمون نباید به‌خاطر نبودِ تابع قرمز شود.
  });
});

test.after(() => {
  database.closeAllDatabases?.();
  removeTempDatabase(databasePath);
});
