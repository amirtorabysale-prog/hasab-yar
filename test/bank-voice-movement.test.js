import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { detectBankMovementIntent, mentionedAccounts } from '../shared/bankSpeech.js';

/**
 * کار بانکی با صدا.
 *
 * دو کاری که تا امروز فقط از تنظیمات ممکن بود و وسط کار روزانه کسی سراغشان
 * نمی‌رفت: ساختن حساب بانک، و جابه‌جایی پول میان حساب‌های خودمان.
 *
 * دومی از اولی مهم‌تر است: «دو میلیون از صندوق به بانک ملت واریز شد» نه
 * درآمد است نه هزینه. تا امروز راهی برایش نبود و کاربر مجبور بود یک هزینه
 * از صندوق و یک درآمد در بانک ثبت کند — سود همان ماه دو بار جعل می‌شد.
 */
const ACCOUNTS = [
  { id: 'cash', name: 'صندوق نقدی', kind: 'cash', active: true, bankId: null },
  { id: 'a1', name: 'جاری ملت', kind: 'bank', active: true, bankId: 'mellat' },
];

test('حساب از روی نام بانک شناخته می‌شود، نه فقط نام حساب', () => {
  const found = mentionedAccounts('دو میلیون به بانک ملت واریز شد', ACCOUNTS);
  assert.equal(found.length, 1);
  assert.equal(found[0].account.id, 'a1', 'کاربر «بانک ملت» می‌گوید، نه «جاری ملت»');
});

test('ساخت حساب با صدا، با و بدون موجودی اولیه', () => {
  const plain = detectBankMovementIntent('حساب بانک ملت را بساز', { accounts: ACCOUNTS });
  assert.equal(plain.intent, 'create-account');
  assert.equal(plain.bankId, 'mellat');
  assert.equal(plain.openingBalance, 0);

  const withBalance = detectBankMovementIntent('حساب بانک صادرات رو بساز با موجودی ده میلیون تومان', { accounts: ACCOUNTS });
  assert.equal(withBalance.bankId, 'saderat');
  assert.equal(withBalance.openingBalance, 10_000_000);
});

/** حرف اضافه جهت را تعیین می‌کند؛ وارونه‌گرفتنش مانده‌ی هر دو حساب را غلط می‌کند. */
test('«از» مبدأ است و «به» مقصد', () => {
  const forward = detectBankMovementIntent('دو میلیون تومان از صندوق به بانک ملت واریز شد', { accounts: ACCOUNTS });
  assert.equal(forward.intent, 'transfer');
  assert.equal(forward.fromAccountId, 'cash');
  assert.equal(forward.toAccountId, 'a1');

  const backward = detectBankMovementIntent('دو میلیون تومان از بانک ملت به صندوق منتقل شد', { accounts: ACCOUNTS });
  assert.equal(backward.fromAccountId, 'a1');
  assert.equal(backward.toAccountId, 'cash');
});

/** طرف گفته‌نشده حدس زده نمی‌شود: پول از حسابی که کسی نگفته نباید کم شود. */
test('وقتی یک طرف گفته شده، طرف دیگر خالی می‌ماند', () => {
  const incoming = detectBankMovementIntent('سه میلیون تومان به بانک ملت واریز شد', { accounts: ACCOUNTS });
  assert.equal(incoming.partial, true);
  assert.equal(incoming.toAccountId, 'a1');
  assert.equal(incoming.fromAccountId, undefined);

  const outgoing = detectBankMovementIntent('پنج میلیون از بانک ملت برداشت شد', { accounts: ACCOUNTS });
  assert.equal(outgoing.partial, true);
  assert.equal(outgoing.fromAccountId, 'a1');
});

test('جملهٔ هزینهٔ عادی کار این بخش نیست', () => {
  assert.equal(detectBankMovementIntent('دو میلیون تومان قبض برق دادم', { accounts: ACCOUNTS }), null);
});

// ---------------------------------------------------------------------------
// و اثرش روی دفتر
// ---------------------------------------------------------------------------
const databasePath = tempDatabase('bankvoice');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'bankvoice-owner';
process.env.ADMIN_PASSWORD = 'bankvoice-strong-password-4417';

const database = await import(`../server/db.js?bankvoice=${process.pid}`);
const accounting = await import(`../server/accounting.js?bankvoice=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('bankvoice-owner', 'bankvoice-strong-password-4417');
const workspace = database.createWorkspace(owner.id, { name: 'کارخانه', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const profitTotal = () => db().prepare(`SELECT COALESCE(SUM(credit)-SUM(debit),0) AS net FROM journal_lines
  JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
  WHERE ledger_accounts.type IN ('income','expense')`).get().net;

test('انتقال بین حساب‌ها سود دوره را تکان نمی‌دهد', () => {
  inWorkspace(() => {
    database.installChartTemplate();
    const bank = database.saveAccount({ name: 'جاری ملت', kind: 'bank', bankId: 'mellat', openingBalance: 0 });
    database.saveAccount({ id: 'cash', name: 'صندوق نقدی', kind: 'cash', openingBalance: 50_000_000 });
    const before = profitTotal();

    database.transferBetweenAccounts({ fromAccountId: 'cash', toAccountId: bank.id, amount: 20_000_000 });

    assert.equal(profitTotal(), before, 'انتقال نه درآمد است نه هزینه');
    assert.equal(accounting.trialBalance(db()).balanced, true);

    const balances = db().prepare(`SELECT ledger_accounts.source_key AS accountId,
      COALESCE(SUM(journal_lines.debit)-SUM(journal_lines.credit),0) AS net
      FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE ledger_accounts.source_kind='operational-account' GROUP BY ledger_accounts.source_key`).all();
    const of = (id) => balances.find((row) => row.accountId === id)?.net ?? 0;
    assert.equal(of(bank.id), 20_000_000, 'بانک باید بدهکار شود');
    assert.equal(of('cash'), 50_000_000 - 20_000_000, 'و صندوق به همان اندازه کم شود');
  });
});

test('انتقال به همان حساب یا با مبدأ نامشخص رد می‌شود', () => {
  inWorkspace(() => {
    assert.throws(() => database.transferBetweenAccounts({ fromAccountId: 'cash', toAccountId: 'cash', amount: 1_000_000 }), /یک حساب/);
    assert.throws(() => database.transferBetweenAccounts({ toAccountId: 'cash', amount: 1_000_000 }), /مبدأ/);
    assert.throws(() => database.transferBetweenAccounts({ fromAccountId: 'cash', toAccountId: 'cash', amount: 0 }), /مبلغ/);
  });
});

test.after(() => removeTempDatabase(databasePath));
