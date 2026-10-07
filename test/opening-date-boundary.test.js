import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * افتتاحیه در روز شروع ثبت دفتر می‌نشیند، نه امروز.
 *
 * ورود ماندهٔ افتتاحیه از اکسل تاریخ نمی‌گرفت و همیشه «امروز» ثبت می‌شد؛ در
 * دفتری که سابقه دارد یعنی سرمایهٔ افتتاحیه وسط سال و بعد از عملیات واقعی.
 */
const databasePath = tempDatabase('opening-date');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'opening-owner';
process.env.ADMIN_PASSWORD = 'opening-strong-password-3381';

const database = await import('../server/db.js');
const accounting = await import('../server/accounting.js');
database.ensureAdmin();
const owner = database.authenticateUser('opening-owner', 'opening-strong-password-3381');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر افتتاحیه', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

test('بی‌تاریخ: روز شروع ثبت؛ تاریخ بعد از آن رد؛ تاریخ پیش از آن پذیرفته', () => inWorkspace(() => {
  database.insertTransactions({ transcript: 'قبض برق', transactions: [{ amount: 3_000_000, type: 'expense', category: 'قبوض و انرژی', rawText: 'قبض برق', occurredAt: '2026-09-10T08:00:00.000Z' }] });
  assert.equal(accounting.ledgerStartDate(db()), '2026-09-10');
  const cash = db().prepare("SELECT id FROM ledger_accounts WHERE source_kind='operational-account' AND source_key='cash'").get().id;
  const equity = db().prepare("SELECT id FROM ledger_accounts WHERE source_kind='system' AND source_key='opening-equity'").get().id;
  const lines = [{ ledgerAccountId: cash, debit: 50_000_000, credit: 0, name: 'صندوق' }, { ledgerAccountId: equity, debit: 0, credit: 50_000_000, name: 'سرمایه' }];

  const posted = accounting.postImportedOpeningBalances(db(), lines, {});
  assert.equal(db().prepare('SELECT substr(occurred_at,1,10) d FROM journal_entries WHERE id=?').get(posted.id).d, '2026-09-10');
  assert.throws(() => accounting.postImportedOpeningBalances(db(), lines, { occurredAt: '2026-09-20', replace: true }), { code: 'OPENING_DATE_AFTER_START' });
  const earlier = accounting.postImportedOpeningBalances(db(), lines, { occurredAt: '2026-03-21', replace: true });
  assert.equal(db().prepare('SELECT substr(occurred_at,1,10) d FROM journal_entries WHERE id=?').get(earlier.id).d, '2026-03-21');
  assert.equal(accounting.ledgerStartDate(db()), '2026-09-10', 'افتتاحیه خودش شروع دفتر را جابه‌جا نمی‌کند');
  assert.equal(accounting.trialBalance(db()).balanced, true);
}));

test.after(() => removeTempDatabase(databasePath));
