/**
 * صندوق، بانک و تنخواه منفی نمی‌شوند — مگر با تأیید حسابدار.
 *
 * پولِ نقدی که نیست را نمی‌شود خرج کرد. ماندهٔ منفیِ صندوق تقریباً همیشه یعنی
 * ثبتی جا افتاده یا ثبتی اشتباه (حساب اشتباه، مبلغ اشتباه، دریافتی که ثبت نشده).
 * بانک هم بدون قرارداد اضافه‌برداشت منفی نمی‌شود.
 *
 * این قاعده روی **همهٔ** راه‌های نوشتن یک‌جا نشسته، نه روی هر فرم جدا: لایهٔ
 * مشترک دیتابیس (`core.js`) پیش از هر تراکنش ماندهٔ حساب‌ها را عکس می‌گیرد و
 * پیش از ثبت نهایی دوباره می‌سنجد. حسابی که با همین عملیات منفی‌تر شده، کل
 * عملیات را برمی‌گرداند — ثبت صوتی، انتقال، تسویه، پرداخت فاکتور، حقوق، چک،
 * تنخواه، ویرایش، حذف و ثبت از مسیر AI یک‌جور.
 *
 * دو راه عبور:
 * - حسابی که مدیر برایش «اجازهٔ منفی شدن» (اضافه‌برداشت) را روشن کرده.
 * - تأیید صریح حسابدار با دلیل، که در `overdraft_approvals` می‌ماند.
 *
 * فقط حسابی جلوی ثبت را می‌گیرد که با همین عملیات **منفی‌تر** شده؛ دریافت روی
 * حسابی که از قبل منفی بوده، جلویش گرفته نمی‌شود.
 */

const BALANCE_SQL = `SELECT accounts.id,accounts.name,COALESCE(accounts.allow_negative,0) AS allowNegative,
  accounts.opening_balance + COALESCE(SUM(CASE WHEN transactions.status!='deleted' AND COALESCE(transactions.journal_deferred,0)=0 THEN
    CASE WHEN transactions.type='income' THEN transactions.amount ELSE -transactions.amount END ELSE 0 END),0)
  + COALESCE((SELECT SUM(l.debit-l.credit) FROM journal_lines l
    JOIN ledger_accounts a ON a.id=l.account_id JOIN journal_entries j ON j.id=l.entry_id
    LEFT JOIN journal_entries original ON original.id=j.reverses_entry_id
    WHERE a.source_kind='operational-account' AND a.source_key=accounts.id
      AND (j.source_type='account_transfer' OR original.source_type='account_transfer')),0) AS balance
  FROM accounts LEFT JOIN transactions ON transactions.account_id=accounts.id
  GROUP BY accounts.id`;

export function ensureOverdraftSchema(database) {
  try { database.exec('ALTER TABLE accounts ADD COLUMN allow_negative INTEGER NOT NULL DEFAULT 0'); } catch (error) {
    if (!/duplicate column name|no such table/i.test(error.message)) throw error;
  }
  database.exec(`CREATE TABLE IF NOT EXISTS overdraft_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, account_name TEXT NOT NULL,
    balance_before INTEGER NOT NULL, balance_after INTEGER NOT NULL, reason TEXT NOT NULL,
    approved_by TEXT, approver_role TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
}

/** ماندهٔ همهٔ حساب‌های پول؛ `null` وقتی جدول‌ها هنوز ساخته نشده‌اند. */
export function balanceSnapshot(database) {
  try {
    return new Map(database.prepare(BALANCE_SQL).all().map((row) => [row.id, row]));
  } catch { return null; }
}

/** حساب‌هایی که با همین عملیات منفی‌تر شده‌اند و اجازهٔ منفی شدن ندارند. */
export function negativeViolations(database, before) {
  if (!before) return [];
  const after = balanceSnapshot(database);
  if (!after) return [];
  const violations = [];
  for (const row of after.values()) {
    if (row.allowNegative) continue;
    const previous = before.get(row.id)?.balance ?? 0;
    if (row.balance < 0 && row.balance < previous) violations.push({ accountId: row.id, name: row.name, before: previous, after: row.balance });
  }
  return violations;
}

const money = (value) => Math.abs(Math.round(Number(value) || 0)).toLocaleString('fa-IR');

export function overdraftError(violations) {
  const parts = violations.map((item) => `«${item.name}» ${item.before < 0 ? `از منفی ${money(item.before)}` : `از ${money(item.before)}`} به منفی ${money(item.after)} تومان`);
  return Object.assign(new Error(`با این ثبت موجودی ${parts.join(' و ')} می‌رسد. صندوق و بانک منفی نمی‌شوند مگر با تأیید حسابدار؛ اگر واقعاً چنین است (اضافه‌برداشت یا ثبتی که جا افتاده)، با دلیل تأیید کن.`), {
    code: 'NEGATIVE_BALANCE', status: 409, requiresAction: true, details: { accounts: violations },
  });
}

/** تأیید حسابدار، با دلیل، در همان تراکنش ثبت می‌شود تا با خودِ عملیات بماند یا برود. */
export function recordOverdraftApproval(database, violations, approval) {
  ensureOverdraftSchema(database);
  const insert = database.prepare(`INSERT INTO overdraft_approvals (account_id,account_name,balance_before,balance_after,reason,approved_by,approver_role)
    VALUES (?,?,?,?,?,?,?)`);
  for (const item of violations) insert.run(item.accountId, item.name, item.before, item.after, approval.reason, approval.userId || null, approval.role || null);
}

/** نقش‌هایی که می‌توانند منفی شدن موجودی را تأیید کنند. */
export const OVERDRAFT_APPROVER_ROLES = Object.freeze(['owner', 'manager', 'accountant']);

/** تأییدی که از هدر درخواست آمده؛ فقط با نقش مجاز و دلیلِ نوشته‌شده پذیرفته می‌شود. */
export function readOverdraftApproval(header, { role, userId } = {}) {
  let reason = '';
  try { reason = decodeURIComponent(String(header || '')).trim().slice(0, 300); } catch { reason = ''; }
  if (reason.length < 3 || !OVERDRAFT_APPROVER_ROLES.includes(role)) return null;
  return { reason, role, userId: userId || null };
}
