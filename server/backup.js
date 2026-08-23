import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  FINANCIAL_BACKUP_TABLES, financialBackupSnapshot, restoreFinancialSnapshot,
} from './db.js';

const FORMAT = 'hesab-yar-encrypted-backup';
const AAD = Buffer.from('hesab-yar-backup:v1', 'utf8');
const MAX_BACKUP_BYTES = 30 * 1024 * 1024;
const MAX_BACKUP_ROWS = 500_000;
const OPTIONAL_ACCOUNTING_TABLES = new Set(['ledger_accounts', 'journal_entries', 'journal_lines', 'accounting_periods', 'invoice_payments', 'bank_statement_imports', 'bank_statement_lines']);

function backupError(message, code = 'BACKUP_INVALID') {
  return Object.assign(new Error(message), { status: 400, code });
}

function deriveKey(passphrase, salt) {
  const value = String(passphrase || '');
  if (value.length < 12) throw backupError('رمز پشتیبان باید حداقل ۱۲ نویسه باشد.', 'BACKUP_WEAK_PASSPHRASE');
  return scryptSync(value, salt, 32, { maxmem: 64 * 1024 * 1024 });
}

function binaryReplacer(_key, value) {
  if (value?.type === 'Buffer' && Array.isArray(value.data)) return { $binary: Buffer.from(value.data).toString('base64') };
  if (value instanceof Uint8Array) return { $binary: Buffer.from(value).toString('base64') };
  return value;
}

function binaryReviver(_key, value) {
  if (value && typeof value.$binary === 'string') return Buffer.from(value.$binary, 'base64');
  return value;
}

export function validateFinancialBackup(snapshot) {
  if (!snapshot || snapshot.format !== 'hesab-yar-financial-data' || snapshot.version !== 1) throw backupError('این فایل، پشتیبان معتبر حساب‌یار نیست.');
  if (!snapshot.tables || typeof snapshot.tables !== 'object') throw backupError('جدول‌های پشتیبان پیدا نشد.');
  let rows = 0;
  for (const table of FINANCIAL_BACKUP_TABLES) {
    if (!Array.isArray(snapshot.tables[table]) && OPTIONAL_ACCOUNTING_TABLES.has(table)) snapshot.tables[table] = [];
    if (!Array.isArray(snapshot.tables[table])) throw backupError(`جدول ${table} در پشتیبان ناقص است.`);
    rows += snapshot.tables[table].length;
    if (rows > MAX_BACKUP_ROWS) throw backupError('تعداد رکوردهای پشتیبان بیش از حد مجاز است.', 'BACKUP_TOO_LARGE');
    if (snapshot.tables[table].some((row) => !row || typeof row !== 'object' || Array.isArray(row))) throw backupError(`دادهٔ جدول ${table} معتبر نیست.`);
  }
  if (!snapshot.tables.accounts.some((item) => item.id === 'cash')) throw backupError('حساب صندوق اصلی در پشتیبان وجود ندارد.');
  return snapshot;
}

export function backupSummary(snapshot) {
  validateFinancialBackup(snapshot);
  const transactions = snapshot.tables.transactions.filter((item) => item.status !== 'deleted');
  return {
    exportedAt: snapshot.exportedAt,
    sourceWorkspaceId: snapshot.workspace?.id || null,
    transactions: transactions.length,
    income: transactions.filter((item) => item.type === 'income').reduce((sum, item) => sum + Number(item.amount || 0), 0),
    expense: transactions.filter((item) => item.type === 'expense').reduce((sum, item) => sum + Number(item.amount || 0), 0),
    contacts: snapshot.tables.contacts.length,
    invoices: snapshot.tables.invoices.length,
    receipts: snapshot.tables.receipts.length,
    products: snapshot.tables.products.length,
  };
}

export function createEncryptedBackup(snapshot, passphrase, { purpose = 'portable' } = {}) {
  validateFinancialBackup(snapshot);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify(snapshot, binaryReplacer), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    format: FORMAT, version: 1, algorithm: 'aes-256-gcm', kdf: 'scrypt', purpose,
    createdAt: new Date().toISOString(), salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

export function openEncryptedBackup(buffer, passphrase) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!input.length || input.length > MAX_BACKUP_BYTES) throw backupError('اندازهٔ فایل پشتیبان معتبر نیست.', 'BACKUP_TOO_LARGE');
  let envelope;
  try { envelope = JSON.parse(input.toString('utf8')); }
  catch { throw backupError('فایل پشتیبان قابل خواندن نیست.'); }
  if (envelope?.format !== FORMAT || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm' || envelope.kdf !== 'scrypt') throw backupError('قالب رمزگذاری پشتیبان پشتیبانی نمی‌شود.');
  try {
    const salt = Buffer.from(envelope.salt, 'base64');
    const iv = Buffer.from(envelope.iv, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    return validateFinancialBackup(JSON.parse(plaintext.toString('utf8'), binaryReviver));
  } catch (error) {
    if (error.code?.startsWith('BACKUP_')) throw error;
    throw backupError('رمز پشتیبان اشتباه است یا فایل آسیب دیده است.', 'BACKUP_DECRYPT_FAILED');
  }
}

function backupDirectory() {
  const databasePath = resolve(process.env.DATABASE_PATH || './data/hesab-yar.sqlite');
  return resolve(process.env.BACKUP_DIR || dirname(databasePath), process.env.BACKUP_DIR ? '' : 'backups');
}

function safeWorkspaceId(workspaceId) {
  return String(workspaceId || 'primary').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'primary';
}

function retentionDays() {
  return Math.min(365, Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS) || 14));
}

export function automaticBackupConfigured() {
  return String(process.env.BACKUP_ENCRYPTION_KEY || '').length >= 32;
}

async function pruneBackups(workspaceId, now = Date.now()) {
  const folder = backupDirectory();
  const prefix = `${safeWorkspaceId(workspaceId)}-`;
  const cutoff = now - retentionDays() * 24 * 60 * 60 * 1000;
  const files = await readdir(folder).catch(() => []);
  for (const file of files.filter((item) => item.startsWith(prefix) && item.endsWith('.hybackup'))) {
    const path = resolve(folder, file);
    const info = await stat(path).catch(() => null);
    if (info && info.mtimeMs < cutoff) await unlink(path);
  }
}

export async function writeServerBackup(workspace, { reason = 'daily', passphrase = process.env.BACKUP_ENCRYPTION_KEY } = {}) {
  const workspaceId = safeWorkspaceId(workspace?.id);
  const snapshot = financialBackupSnapshot(workspace);
  const encrypted = createEncryptedBackup(snapshot, passphrase, { purpose: reason });
  const folder = backupDirectory();
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${workspaceId}-${reason}-${timestamp}.hybackup`;
  const path = resolve(folder, fileName);
  await writeFile(path, encrypted, { mode: 0o600, flag: 'wx' });
  // A written backup is only considered healthy after a real decrypt + schema validation.
  openEncryptedBackup(encrypted, passphrase);
  await pruneBackups(workspaceId);
  return { fileName, createdAt: new Date().toISOString(), bytes: encrypted.length, reason };
}

export async function automaticBackupStatus(workspaceId) {
  const configured = automaticBackupConfigured();
  const prefix = `${safeWorkspaceId(workspaceId)}-`;
  const folder = backupDirectory();
  const files = await readdir(folder).catch(() => []);
  const candidates = [];
  for (const file of files.filter((item) => item.startsWith(prefix) && (item.includes('-daily-') || item.includes('-manual-')) && item.endsWith('.hybackup'))) {
    const info = await stat(resolve(folder, file)).catch(() => null);
    if (info) candidates.push({ fileName: file, createdAt: info.mtime.toISOString(), bytes: info.size });
  }
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { configured, retentionDays: retentionDays(), count: candidates.length, lastBackup: candidates[0] || null };
}

export function createPortableBackup(workspace, passphrase) {
  return createEncryptedBackup(financialBackupSnapshot(workspace), passphrase, { purpose: 'portable' });
}

export async function restorePortableBackup(buffer, passphrase, workspace) {
  const snapshot = openEncryptedBackup(buffer, passphrase);
  const checkpoint = await writeServerBackup(workspace, { reason: 'pre-restore', passphrase });
  const restored = restoreFinancialSnapshot(snapshot);
  return { checkpoint, summary: backupSummary(restored), source: backupSummary(snapshot) };
}
