import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { convertAmount, normalizeAmountUnit, tomanToLedger, unitLabel } from '../shared/amountUnit.js';

/**
 * واحد مبلغ دفتر (تومان یا ریال).
 *
 * دفترهای موجود تومانی می‌مانند و هیچ رفتاری از آن‌ها عوض نمی‌شود. دفتر ریالی برای
 * کار با پارسیان است که مبلغ را به ریال نگه می‌دارد. واحد فقط پیش از اولین مبلغ عوض
 * می‌شود، چون عوض کردنش بعد از آن یعنی همهٔ عددهای قبلی ده برابر یا یک‌دهم خوانده شوند.
 */

const databasePath = tempDatabase('ledger-amount-unit');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'unit-owner';
process.env.ADMIN_PASSWORD = randomBytes(24).toString('base64url');
const database = await import(`../server/db.js?ledger-amount-unit=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('unit-owner', process.env.ADMIN_PASSWORD);
const newWorkspace = (name) => database.createWorkspace(owner.id, { name, profileType: 'business' });
const inWorkspace = (workspace, callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
test.after(() => removeTempDatabase(databasePath));

test('تبدیل دقیق: ریال به تومان فقط وقتی بر ۱۰ بخش‌پذیر است', () => {
  assert.equal(convertAmount(567_905_020, 'rial', 'toman'), 56_790_502);
  assert.equal(convertAmount(567_905_027, 'rial', 'toman'), null);
  assert.equal(convertAmount(56_790_502, 'toman', 'rial'), 567_905_020);
  assert.equal(convertAmount(1_200, 'rial', 'rial'), 1_200);
  assert.equal(convertAmount(12.5, 'toman', 'toman'), null);
  assert.equal(tomanToLedger(2_000_000, 'toman'), 2_000_000);
  assert.equal(tomanToLedger(2_000_000, 'rial'), 20_000_000);
  assert.equal(normalizeAmountUnit('ريال'), 'toman');
  assert.equal(unitLabel('rial'), 'ریال');
  assert.equal(unitLabel('toman'), 'تومان');
});

test('دفتر تازه تومانی است و برچسب و تبدیل همان رفتار قبلی را دارند', () => {
  const workspace = newWorkspace('تومانی');
  inWorkspace(workspace, () => {
    assert.equal(database.ledgerAmountUnit(), 'toman');
    assert.equal(unitLabel(), 'تومان');
    assert.equal(tomanToLedger(750_000), 750_000);
    assert.deepEqual(database.amountRecordsInLedger(), {});
  });
});

test('دفتر خالی ریالی می‌شود و دو تنظیمِ مبلغ‌دار با آن تبدیل می‌شوند', () => {
  const workspace = newWorkspace('ریالی');
  inWorkspace(workspace, () => {
    database.saveSettings({ lowBalanceThreshold: '2000000' });
    database.saveAutomationPolicy({ capitalizationThreshold: 50_000_000 });
    const result = database.setLedgerAmountUnit('rial');
    assert.deepEqual(result, { amountUnit: 'rial', label: 'ریال', changed: true });
    assert.equal(database.ledgerAmountUnit(), 'rial');
    assert.equal(unitLabel(), 'ریال');
    assert.equal(tomanToLedger(750_000), 7_500_000);
    assert.equal(database.getSettings().lowBalanceThreshold, '20000000');
    assert.equal(database.automationPolicy().capitalizationThreshold, 500_000_000);
    // برگشت به تومان هم ممکن است، تا وقتی دفتر هنوز مبلغی ندارد.
    database.setLedgerAmountUnit('toman');
    assert.equal(database.getSettings().lowBalanceThreshold, '2000000');
    assert.equal(database.automationPolicy().capitalizationThreshold, 50_000_000);
    assert.equal(database.setLedgerAmountUnit('toman').changed, false);
  });
});

test('واحد هر دفتر جداست؛ دفتر دیگر از واحد این دفتر خبر ندارد', () => {
  const rial = newWorkspace('دفتر ریالی دوم');
  const toman = newWorkspace('دفتر تومانی دوم');
  inWorkspace(rial, () => database.setLedgerAmountUnit('rial'));
  inWorkspace(rial, () => assert.equal(unitLabel(), 'ریال'));
  inWorkspace(toman, () => assert.equal(unitLabel(), 'تومان'));
});

test('پس از اولین مبلغ، واحد قفل می‌شود و می‌گوید چرا', () => {
  const workspace = newWorkspace('دفتر قفل‌شده');
  inWorkspace(workspace, () => {
    database.saveObligation({ title: 'طلب نمونه', amount: 2_000_000, direction: 'receivable' });
    const records = database.amountRecordsInLedger();
    assert.ok(records.obligations >= 1, JSON.stringify(records));
    assert.throws(() => database.setLedgerAmountUnit('rial'), (error) => error.code === 'AMOUNT_UNIT_LOCKED' && error.status === 409 && error.details.records.obligations >= 1);
    assert.equal(database.ledgerAmountUnit(), 'toman');
  });
});

test('ماندهٔ افتتاحیهٔ حساب هم مبلغ است و واحد را قفل می‌کند', () => {
  const workspace = newWorkspace('دفتر با افتتاحیه');
  inWorkspace(workspace, () => {
    database.saveSettings({ openingBalance: '5000000' });
    assert.equal(database.amountRecordsInLedger().openingBalances, 1);
    assert.throws(() => database.setLedgerAmountUnit('rial'), (error) => error.code === 'AMOUNT_UNIT_LOCKED');
  });
});

test('واحد نامعتبر پذیرفته نمی‌شود', () => {
  const workspace = newWorkspace('واحد نامعتبر');
  inWorkspace(workspace, () => {
    assert.throws(() => database.setLedgerAmountUnit('dollar'), (error) => error.code === 'AMOUNT_UNIT_INVALID');
    assert.throws(() => database.setLedgerAmountUnit(''), (error) => error.code === 'AMOUNT_UNIT_INVALID');
  });
});
