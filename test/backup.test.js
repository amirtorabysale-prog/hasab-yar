import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';

const databasePath = `/tmp/hesab-yar-backup-${process.pid}.sqlite`;
const backupDirectory = `/tmp/hesab-yar-backups-${process.pid}`;
process.env.DATABASE_PATH = databasePath;
process.env.BACKUP_DIR = backupDirectory;
process.env.ADMIN_USERNAME = 'backup-owner';
process.env.ADMIN_PASSWORD = 'independent-safe-password-4829';
process.env.BACKUP_ENCRYPTION_KEY = 'server-side-backup-secret-with-32-bytes-minimum';

const database = await import('../server/db.js');
const backup = await import('../server/backup.js');
database.ensureAdmin();

let encrypted;
const passphrase = 'portable-secret-phrase-7429';

test('creates a complete encrypted backup including receipt bytes', () => {
  database.runInWorkspace('primary', { role: 'owner' }, () => {
    database.insertTransactions({ transcript: 'عبارت کاملاً محرمانه', transactions: [{ amount: 345_678, type: 'income', category: 'فروش', rawText: 'عبارت کاملاً محرمانه' }] });
    database.saveReceipt({ buffer: Buffer.from('private-receipt-bytes'), fileName: 'receipt.png', mimeType: 'image/png', note: 'رسید محرمانه', amount: 345_678, type: 'income', category: 'فروش' });
    const snapshot = database.financialBackupSnapshot({ id: 'primary' });
    encrypted = backup.createEncryptedBackup(snapshot, passphrase);
    assert.equal(encrypted.includes(Buffer.from('عبارت کاملاً محرمانه')), false);
    assert.equal(encrypted.includes(Buffer.from('private-receipt-bytes')), false);
    const opened = backup.openEncryptedBackup(encrypted, passphrase);
    assert.deepEqual(Buffer.from(opened.tables.receipts[0].image_data), Buffer.from('private-receipt-bytes'));
    assert.deepEqual(backup.backupSummary(opened), {
      exportedAt: opened.exportedAt, sourceWorkspaceId: 'primary', transactions: 1,
      income: 345_678, expense: 0, contacts: 0, invoices: 0, receipts: 1, products: 0,
    });
  });
});

test('rejects a wrong password and a structurally incomplete backup', () => {
  assert.throws(() => backup.openEncryptedBackup(encrypted, 'this-password-is-wrong-999'), (error) => error.code === 'BACKUP_DECRYPT_FAILED');
  const valid = database.runInWorkspace('primary', { role: 'owner' }, () => database.financialBackupSnapshot({ id: 'primary' }));
  delete valid.tables.accounts;
  assert.throws(() => backup.validateFinancialBackup(valid), /accounts/);
});

test('keeps backups from before the ledger upgrade restorable', () => {
  const legacy = database.runInWorkspace('primary', { role: 'owner' }, () => database.financialBackupSnapshot({ id: 'primary' }));
  for (const table of ['ledger_accounts', 'journal_entries', 'journal_lines', 'accounting_periods']) delete legacy.tables[table];
  assert.doesNotThrow(() => backup.validateFinancialBackup(legacy));
  assert.deepEqual(legacy.tables.journal_entries, []);
});

test('restores atomically and writes a decrypt-tested checkpoint first', async () => {
  await database.runInWorkspace('primary', { role: 'owner' }, async () => {
    database.insertTransactions({ transcript: 'بعد از پشتیبان', transactions: [{ amount: 999_000, type: 'expense', category: 'مواد و کالا', rawText: 'بعد از پشتیبان' }] });
    assert.equal(database.getToday().summary.expense, 999_000);
    const result = await backup.restorePortableBackup(encrypted, passphrase, { id: 'primary' });
    assert.equal(result.source.transactions, 1);
    assert.match(result.checkpoint.fileName, /pre-restore/);
    assert.equal(database.getToday().summary.income, 345_678);
    assert.equal(database.getToday().summary.expense, 0);
    const checkpoint = readdirSync(backupDirectory).find((file) => file.includes('pre-restore'));
    assert.ok(checkpoint);
  });
});

test('writes and reports an automated encrypted snapshot', async () => {
  await database.runInWorkspace('primary', { role: 'owner' }, async () => {
    const saved = await backup.writeServerBackup({ id: 'primary' }, { reason: 'daily' });
    assert.ok(saved.bytes > 100);
    const status = await backup.automaticBackupStatus('primary');
    assert.equal(status.configured, true);
    assert.equal(status.count, 1);
    assert.match(status.lastBackup.fileName, /daily/);
  });
});

test.after(() => {
  database.closeWorkspaceDatabases();
  database.db.close();
  rmSync(backupDirectory, { recursive: true, force: true });
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
});
