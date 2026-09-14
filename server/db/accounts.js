import { randomUUID } from 'node:crypto';
import { assertAccountingPeriodOpen, periodForDate, syncOpeningBalanceJournal } from '../accounting.js';
import { audit, currentTimeZone, currentWorkspace, db, insertSetting, invalidInput } from './core.js';
import { bankById, detectBank } from '../../shared/banks.js';

export function listAccounts() {
  return db.prepare(`SELECT accounts.id,accounts.name,accounts.kind,accounts.opening_balance AS openingBalance,accounts.active,
    accounts.created_at AS createdAt,accounts.bank_id AS bankId,
    accounts.opening_balance + COALESCE(SUM(CASE WHEN transactions.status!='deleted' THEN
      CASE WHEN transactions.type='income' THEN transactions.amount ELSE -transactions.amount END ELSE 0 END),0) AS balance
    FROM accounts LEFT JOIN transactions ON transactions.account_id=accounts.id
    GROUP BY accounts.id ORDER BY accounts.active DESC,accounts.sort_order,accounts.name`).all();
}

export function saveAccount(values = {}) {
  const id = String(values.id || randomUUID()).trim().slice(0, 80);
  const name = String(values.name || '').trim().slice(0, 100);
  const kind = ['cash', 'bank', 'wallet', 'other'].includes(values.kind) ? values.kind : 'other';
  const openingBalance = Math.round(Number(values.openingBalance) || 0);
  if (!name) throw invalidInput('نام حساب را وارد کن.');
  // بانک فقط روی حساب بانکی معنی دارد. اگر کاربر بانکی انتخاب نکرده، از نام
  // خود حساب حدس زده می‌شود — «جاری ملت» همان بانک ملت است و پرسیدنش اضافه است.
  let bankId = null;
  if (kind === 'bank') {
    const chosen = values.bankId ? String(values.bankId).trim() : '';
    bankId = (chosen && bankById(chosen)?.id) || detectBank(name)?.bankId || null;
    if (chosen && !bankId) throw invalidInput('بانک انتخاب‌شده در فهرست نیست.');
  }
  if (!Number.isSafeInteger(openingBalance)) throw invalidInput('ماندهٔ ابتدای دوره معتبر نیست.');
  const current = db.prepare('SELECT created_at AS createdAt,opening_balance AS openingBalance FROM accounts WHERE id=?').get(id);
  if (current && Number(current.openingBalance) !== openingBalance) assertAccountingPeriodOpen(db, periodForDate(current.createdAt, currentTimeZone()));
  if (!current && openingBalance !== 0) assertAccountingPeriodOpen(db, periodForDate(new Date(), currentTimeZone()));
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO accounts (id,name,kind,opening_balance,active,bank_id) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,opening_balance=excluded.opening_balance,
        active=excluded.active,bank_id=excluded.bank_id,updated_at=CURRENT_TIMESTAMP`)
      .run(id, name, kind, openingBalance, values.active === false ? 0 : 1, bankId);
    if (id === 'cash') insertSetting.run('openingBalance', String(openingBalance));
    if (!current || Number(current.openingBalance) !== openingBalance) syncOpeningBalanceJournal(db, id, { createdBy: currentWorkspace()?.userId });
    audit(values.id ? 'update' : 'create', 'account', id, { name, kind, openingBalance, bankId });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return listAccounts().find((item) => item.id === id);
}

export function getCategories() {
  return db.prepare('SELECT id,name,type FROM categories ORDER BY type DESC, sort_order, name').all();
}

/**
 * حسابِ بانکی که کاربر نامش را گفته.
 *
 * اگر دفتر دو حساب از یک بانک داشته باشد، هیچ‌کدام برنمی‌گردد: «از ملت دادم»
 * وقتی دو حساب ملت هست، جمله را روشن نمی‌کند و انتخاب یکی از آن دو یعنی
 * برداشت از حساب اشتباه.
 */
export function accountForBank(bankId) {
  if (!bankId) return null;
  const matches = db.prepare("SELECT id,name FROM accounts WHERE bank_id=? AND active=1 AND kind='bank' ORDER BY sort_order,name").all(String(bankId));
  return matches.length === 1 ? matches[0] : null;
}

export function resolveAccountId(item = {}) {
  // نام بانکِ گفته‌شده بر پیش‌فرض مقدم است، ولی بر انتخاب صریح کاربر نه:
  // اگر در فرم تأیید حسابی انتخاب شده، همان حرف آخر است.
  if (!item.accountId && !item.account && item.bankId) {
    const matched = accountForBank(item.bankId);
    if (matched) return matched.id;
  }
  const requested = String(item.accountId || item.account || 'cash').trim().slice(0, 80);
  const account = db.prepare('SELECT id FROM accounts WHERE id=? AND active=1').get(requested)
    || db.prepare('SELECT id FROM accounts WHERE name=? AND active=1').get(requested);
  if (!account) throw invalidInput('حساب مالی انتخاب‌شده معتبر یا فعال نیست.');
  return account.id;
}
