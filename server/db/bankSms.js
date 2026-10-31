import { createHash, randomUUID } from 'node:crypto';
import { audit, currentWorkspace, db, invalidInput, ledgerAmountUnit } from './core.js';
import { listAccounts } from './accounts.js';
import { insertTransactionRows } from './transactions.js';
import { BANKS } from '../../shared/banks.js';
import { parseBankSms, smsFingerprint } from '../../shared/bankSms.js';

/**
 * پیامک‌های بانکی: صف تطبیق، نه ثبت خودکار.
 *
 * هر پیامکِ تراکنش یک «ردیف بانکی» می‌سازد که سه حالت دارد:
 * - «تطبیق خورد»: همان مبلغ، همان جهت، همان حساب، در همان روزها یک تراکنش ثبت‌شده
 *   هست (یکی و فقط یکی) — پیامک گواهِ همان ثبت است و چیزی دوباره ثبت نمی‌شود.
 * - «منتظر»: تراکنشی نیست یا چند نامزد هست؛ کاربر یکی را انتخاب می‌کند یا بابت را
 *   می‌گوید و ثبت می‌شود. بابت هرگز حدس زده نمی‌شود (قاعدهٔ ۴ CLAUDE.md).
 * - «کنار گذاشته»: کاربر گفته این پیامک ثبت نمی‌خواهد.
 *
 * مانده‌ای که پیامک می‌گوید با ماندهٔ دفتر مقایسه می‌شود: اختلاف یعنی ثبتی جا افتاده.
 * کل قابلیت و هر بانک جدا قابل خاموش کردن است؛ پیامکِ بانک خاموش اصلاً ذخیره نمی‌شود،
 * و رمز یک‌بارمصرف هیچ‌وقت.
 */

const DAY = 86_400_000;
const MATCH_WINDOW_DAYS = 2;

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_sms_config (
      id INTEGER PRIMARY KEY CHECK(id = 1), enabled INTEGER NOT NULL DEFAULT 0,
      disabled_banks TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS bank_sms_account_hints (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, hint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bank_sms_messages (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, bank_id TEXT NOT NULL, account_id TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('income','expense')), amount INTEGER NOT NULL, amount_rial INTEGER NOT NULL,
      balance INTEGER, account_hint TEXT, reference TEXT, occurred_at TEXT NOT NULL, raw_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','matched','recorded','ignored')),
      match_kind TEXT, transaction_id TEXT, note TEXT NOT NULL DEFAULT '', resolved_by TEXT, resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS idx_bank_sms_status ON bank_sms_messages(status, occurred_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_sms_transaction ON bank_sms_messages(transaction_id) WHERE transaction_id IS NOT NULL;
    INSERT OR IGNORE INTO bank_sms_config (id) VALUES (1);
  `);
}

const toLedger = (rial) => (rial == null ? null : ledgerAmountUnit() === 'rial' ? rial : Math.round(rial / 10));

export function bankSmsSettings() {
  ensureSchema();
  const row = db.prepare('SELECT enabled, disabled_banks AS disabledBanks FROM bank_sms_config WHERE id=1').get();
  const disabled = new Set(JSON.parse(row.disabledBanks || '[]'));
  const hints = new Map(db.prepare('SELECT account_id AS accountId, hint FROM bank_sms_account_hints').all().map((item) => [item.accountId, item.hint]));
  const bankAccounts = listAccounts().filter((account) => account.kind === 'bank' && account.active !== 0);
  const usedBanks = new Set(bankAccounts.map((account) => account.bankId).filter(Boolean));
  return {
    enabled: Boolean(row.enabled),
    // بانک‌هایی که دفتر حسابش را دارد اول، بقیه بعد؛ هر کدام جدا روشن یا خاموش.
    banks: BANKS.map((bank) => ({ id: bank.id, name: bank.name, enabled: !disabled.has(bank.id), inLedger: usedBanks.has(bank.id) }))
      .sort((a, b) => Number(b.inLedger) - Number(a.inLedger)),
    accounts: bankAccounts.map((account) => ({ id: account.id, name: account.name, bankId: account.bankId, hint: hints.get(account.id) || '' })),
  };
}

export function saveBankSmsSettings(values = {}) {
  ensureSchema();
  const current = bankSmsSettings();
  const enabled = values.enabled === undefined ? current.enabled : Boolean(values.enabled);
  let disabled = new Set(current.banks.filter((bank) => !bank.enabled).map((bank) => bank.id));
  for (const [bankId, on] of Object.entries(values.banks || {})) {
    if (!BANKS.some((bank) => bank.id === bankId)) continue;
    if (on) disabled.delete(bankId); else disabled.add(bankId);
  }
  db.prepare('UPDATE bank_sms_config SET enabled=?, disabled_banks=?, updated_at=CURRENT_TIMESTAMP WHERE id=1').run(enabled ? 1 : 0, JSON.stringify([...disabled]));
  for (const [accountId, hint] of Object.entries(values.hints || {})) {
    const digits = String(hint || '').replace(/\D/g, '').slice(-4);
    if (!current.accounts.some((account) => account.id === accountId)) continue;
    if (digits.length === 4) db.prepare('INSERT INTO bank_sms_account_hints (account_id,hint) VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET hint=excluded.hint').run(accountId, digits);
    else db.prepare('DELETE FROM bank_sms_account_hints WHERE account_id=?').run(accountId);
  }
  audit('update', 'bank_sms_settings', '1', { enabled, disabled: [...disabled] });
  return bankSmsSettings();
}

/** حسابِ پیامک: چهار رقم آخرِ ثبت‌شده، وگرنه تنها حسابِ همان بانک؛ دو حساب بی‌نشانه یعنی پرسیدن. */
function accountForSms(parsed, settings) {
  const sameBank = settings.accounts.filter((account) => account.bankId === parsed.bankId);
  if (parsed.accountHint) {
    const byHint = sameBank.filter((account) => account.hint && account.hint === parsed.accountHint);
    if (byHint.length === 1) return byHint[0].id;
  }
  return sameBank.length === 1 ? sameBank[0].id : null;
}

/** تراکنش‌های ثبت‌شده‌ای که می‌توانند همین پیامک باشند. */
function candidatesFor(message) {
  const at = new Date(message.occurred_at).getTime();
  const from = new Date(at - MATCH_WINDOW_DAYS * DAY).toISOString();
  const to = new Date(at + MATCH_WINDOW_DAYS * DAY).toISOString();
  return db.prepare(`SELECT t.id, t.amount, t.type, t.category, t.raw_text AS rawText, t.occurred_at AS occurredAt, t.account_id AS accountId
    FROM transactions t WHERE t.status!='deleted' AND t.type=? AND t.amount=? AND t.occurred_at BETWEEN ? AND ?
      AND (t.account_id=? OR (? IS NULL AND t.account_id IN (SELECT id FROM accounts WHERE bank_id=?)))
      AND NOT EXISTS (SELECT 1 FROM bank_sms_messages m WHERE m.transaction_id=t.id AND m.id<>?)
    ORDER BY ABS(julianday(t.occurred_at)-julianday(?)) LIMIT 5`)
    .all(message.direction, message.amount, from, to, message.account_id, message.account_id, message.bank_id, message.id, message.occurred_at);
}

function hydrate(row, latestByAccount, balances) {
  if (!row) return null;
  const bank = BANKS.find((item) => item.id === row.bank_id);
  const latest = row.account_id && latestByAccount.get(row.account_id) === row.id;
  const ledgerBalance = row.account_id ? balances.get(row.account_id) : undefined;
  return {
    id: row.id, bankId: row.bank_id, bankName: bank?.name || row.bank_id, accountId: row.account_id,
    direction: row.direction, amount: row.amount, balance: row.balance, accountHint: row.account_hint, reference: row.reference,
    occurredAt: row.occurred_at, rawText: row.raw_text, status: row.status, matchKind: row.match_kind, transactionId: row.transaction_id,
    note: row.note, createdAt: row.created_at,
    candidates: row.status === 'pending' ? candidatesFor(row) : [],
    // مقایسهٔ مانده فقط برای آخرین پیامکِ هر حساب معنی دارد: پیامکِ قدیمی‌تر ماندهٔ امروز را نمی‌گوید.
    balanceCheck: latest && row.balance != null && ledgerBalance != null
      ? { sms: row.balance, ledger: ledgerBalance, difference: row.balance - ledgerBalance } : null,
  };
}

function context() {
  const rows = db.prepare(`SELECT account_id, id FROM bank_sms_messages WHERE account_id IS NOT NULL AND balance IS NOT NULL
    ORDER BY occurred_at DESC, created_at DESC`).all();
  const latestByAccount = new Map();
  for (const row of rows) if (!latestByAccount.has(row.account_id)) latestByAccount.set(row.account_id, row.id);
  const balances = new Map(listAccounts().map((account) => [account.id, account.balance]));
  return { latestByAccount, balances };
}

export function getBankSms(id) {
  ensureSchema();
  const { latestByAccount, balances } = context();
  return hydrate(db.prepare('SELECT * FROM bank_sms_messages WHERE id=?').get(String(id || '')), latestByAccount, balances);
}

export function listBankSms({ status = '' } = {}) {
  ensureSchema();
  // تراکنشی که از دفتر حذف شد، دیگر گواهِ پیامک نیست: پیامک دوباره منتظر می‌شود.
  db.prepare(`UPDATE bank_sms_messages SET status='pending', match_kind=NULL, transaction_id=NULL, resolved_at=NULL
    WHERE status IN ('matched','recorded') AND transaction_id IN (SELECT id FROM transactions WHERE status='deleted')`).run();
  const { latestByAccount, balances } = context();
  const rows = status
    ? db.prepare('SELECT * FROM bank_sms_messages WHERE status=? ORDER BY occurred_at DESC, created_at DESC LIMIT 300').all(status)
    : db.prepare('SELECT * FROM bank_sms_messages ORDER BY occurred_at DESC, created_at DESC LIMIT 300').all();
  const items = rows.map((row) => hydrate(row, latestByAccount, balances));
  const count = (name) => db.prepare('SELECT COUNT(*) AS n FROM bank_sms_messages WHERE status=?').get(name).n;
  return { items, summary: { pending: count('pending'), matched: count('matched'), recorded: count('recorded'), ignored: count('ignored') } };
}

/**
 * یک یا چند پیامک (کپی، اشتراک‌گذاری یا خوانندهٔ اپ اندروید).
 *
 * خروجیِ هر پیامک: `stored` (ردیف ساخته شد)، `duplicate`، `otp`، `not-bank`،
 * `unknown` (پیامک بانکِ بی‌تراکنش)، `bank-disabled`. رمز و پیامکِ غیربانکی ذخیره نمی‌شوند.
 */
export function ingestBankSms(messages = []) {
  ensureSchema();
  const settings = bankSmsSettings();
  if (!settings.enabled) throw Object.assign(new Error('خواندن پیامک بانکی خاموش است؛ از بخش «پیامک بانکی» روشنش کن.'), { status: 409, code: 'BANK_SMS_DISABLED' });
  const list = (Array.isArray(messages) ? messages : [messages]).slice(0, 200);
  if (!list.length) throw invalidInput('متن پیامکی نیامد.');
  const disabled = new Set(settings.banks.filter((bank) => !bank.enabled).map((bank) => bank.id));
  const results = [];
  for (const message of list) {
    const text = String(message?.text || '').slice(0, 1000);
    const parsed = parseBankSms(text, { sender: message?.sender, receivedAt: message?.receivedAt });
    if (parsed.kind !== 'transaction') { results.push({ result: parsed.kind, bankId: parsed.bankId || null, reason: parsed.reason }); continue; }
    if (disabled.has(parsed.bankId)) { results.push({ result: 'bank-disabled', bankId: parsed.bankId }); continue; }
    const fingerprint = createHash('sha256').update(smsFingerprint(parsed)).digest('hex');
    const existing = db.prepare('SELECT id FROM bank_sms_messages WHERE fingerprint=?').get(fingerprint);
    if (existing) { results.push({ result: 'duplicate', id: existing.id }); continue; }
    const id = randomUUID();
    db.prepare(`INSERT INTO bank_sms_messages (id,fingerprint,bank_id,account_id,direction,amount,amount_rial,balance,account_hint,reference,occurred_at,raw_text)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, fingerprint, parsed.bankId, accountForSms(parsed, settings), parsed.direction,
      toLedger(parsed.amountRial), parsed.amountRial, toLedger(parsed.balanceRial), parsed.accountHint, parsed.reference, parsed.occurredAt, text);
    // تطبیق خودکار فقط با یک نامزدِ یکتا روی همان حساب؛ چند نامزد یا حسابِ نامعلوم یعنی انتخاب کاربر.
    const row = db.prepare('SELECT * FROM bank_sms_messages WHERE id=?').get(id);
    const candidates = row.account_id ? candidatesFor(row) : [];
    if (candidates.length === 1) {
      db.prepare("UPDATE bank_sms_messages SET status='matched', match_kind='auto', transaction_id=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(candidates[0].id, id);
    }
    audit('ingest', 'bank_sms', id, { bankId: parsed.bankId, amount: row.amount, direction: parsed.direction, auto: candidates.length === 1 });
    results.push({ result: 'stored', id, status: candidates.length === 1 ? 'matched' : 'pending' });
  }
  return { results, ...listBankSms() };
}

function openMessage(id) {
  ensureSchema();
  const row = db.prepare('SELECT * FROM bank_sms_messages WHERE id=?').get(String(id || ''));
  if (!row) throw Object.assign(new Error('پیامک پیدا نشد.'), { status: 404, code: 'BANK_SMS_NOT_FOUND' });
  return row;
}

/** کاربر حسابِ پیامکی را که حسابش معلوم نبود تعیین می‌کند. */
export function assignBankSmsAccount(id, accountId) {
  const row = openMessage(id);
  if (row.status !== 'pending') throw invalidInput('فقط پیامکِ منتظر حساب تازه می‌گیرد.');
  const account = listAccounts().find((item) => item.id === accountId && item.kind === 'bank');
  if (!account) throw invalidInput('حساب بانکی معتبر نیست.');
  db.prepare('UPDATE bank_sms_messages SET account_id=? WHERE id=?').run(account.id, row.id);
  return getBankSms(row.id);
}

export function matchBankSms(id, transactionId) {
  const row = openMessage(id);
  if (row.status !== 'pending') throw invalidInput('این پیامک قبلاً تعیین تکلیف شده است.');
  const transaction = db.prepare("SELECT id, amount, type, account_id AS accountId FROM transactions WHERE id=? AND status!='deleted'").get(String(transactionId || ''));
  if (!transaction) throw invalidInput('تراکنش پیدا نشد.');
  // تطبیق یعنی همان پول: مبلغ و جهت باید یکی باشد، وگرنه دو ثبت جدا با هم بسته می‌شوند.
  if (transaction.amount !== row.amount || transaction.type !== row.direction) throw invalidInput('مبلغ یا جهت این تراکنش با پیامک یکی نیست.');
  if (row.account_id && transaction.accountId && transaction.accountId !== row.account_id) throw invalidInput('این تراکنش روی حساب دیگری ثبت شده است.');
  if (db.prepare('SELECT 1 FROM bank_sms_messages WHERE transaction_id=? AND id<>?').get(transaction.id, row.id)) throw invalidInput('این تراکنش با پیامک دیگری تطبیق خورده است.');
  // حسابِ نامعلومِ پیامک از تراکنشِ انتخاب‌شده معلوم می‌شود.
  db.prepare("UPDATE bank_sms_messages SET status='matched', match_kind='manual', transaction_id=?, account_id=COALESCE(account_id, ?), resolved_by=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(transaction.id, transaction.accountId, currentWorkspace()?.userId || null, row.id);
  audit('match', 'bank_sms', row.id, { transactionId: transaction.id });
  return getBankSms(row.id);
}

/** پیامکی که ثبتی ندارد: کاربر دسته و بابت را می‌گوید و تراکنش روی همان حساب و تاریخ ساخته می‌شود. */
export function recordBankSms(id, values = {}) {
  const row = openMessage(id);
  if (row.status !== 'pending') throw invalidInput('این پیامک قبلاً تعیین تکلیف شده است.');
  if (!row.account_id) throw invalidInput('اول حساب بانکیِ این پیامک را انتخاب کن.');
  const category = String(values.category || '').trim().slice(0, 80);
  if (!category) throw invalidInput('دسته را انتخاب کن؛ بابتِ پول از پیامک معلوم نیست.');
  const description = String(values.description || '').trim().slice(0, 300);
  let transactionId;
  db.exec('BEGIN IMMEDIATE');
  try {
    [transactionId] = insertTransactionRows({ transcript: description || 'ثبت از پیامک بانکی', transactions: [{
      clientId: `bank-sms:${row.id}`, amount: row.amount, type: row.direction, category, source: 'text',
      rawText: description || `${row.direction === 'income' ? 'واریز' : 'برداشت'} طبق پیامک بانک`, accountId: row.account_id, occurredAt: row.occurred_at,
      note: `ثبت از پیامک بانکی${row.reference ? ` · پیگیری ${row.reference}` : ''}`, userConfirmed: true,
    }] });
    db.prepare("UPDATE bank_sms_messages SET status='recorded', match_kind='created', transaction_id=?, note=?, resolved_by=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(transactionId, description, currentWorkspace()?.userId || null, row.id);
    audit('record', 'bank_sms', row.id, { transactionId, category });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getBankSms(row.id);
}

export function ignoreBankSms(id, reason = '') {
  const row = openMessage(id);
  if (row.status !== 'pending') throw invalidInput('این پیامک قبلاً تعیین تکلیف شده است.');
  db.prepare("UPDATE bank_sms_messages SET status='ignored', note=?, resolved_by=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(String(reason || '').trim().slice(0, 300), currentWorkspace()?.userId || null, row.id);
  audit('ignore', 'bank_sms', row.id, { reason });
  return getBankSms(row.id);
}

/** برگرداندن تطبیق یا کنار گذاشتن؛ تراکنشی که از پیامک ساخته شده جداگانه حذف می‌شود. */
export function reopenBankSms(id) {
  const row = openMessage(id);
  if (row.status === 'recorded') throw invalidInput('این پیامک تراکنش ساخته؛ برای برگرداندن، همان تراکنش را از دفتر حذف کن.');
  db.prepare("UPDATE bank_sms_messages SET status='pending', match_kind=NULL, transaction_id=NULL, resolved_by=NULL, resolved_at=NULL WHERE id=?").run(row.id);
  audit('reopen', 'bank_sms', row.id, {});
  return getBankSms(row.id);
}
