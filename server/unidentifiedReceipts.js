import { randomUUID } from 'node:crypto';
import { counterpartyLedgerAccount, postJournalEntry, reverseJournalEntry } from './accounting.js';
import { analyticForContact } from './chartOfAccounts.js';
import { resolveEventAnalytic, resolveEventRole } from './roleResolver.js';
import { ROLES } from '../shared/accountingRules.js';

/**
 * چرخهٔ کامل وجه ناشناس: نگهداری ← تعیین تکلیف ← (در صورت لزوم) برگشت.
 *
 * واریزی که منشأش معلوم نیست در «وجوه دریافتی تعیین‌تکلیف‌نشده» (بدهی موقت)
 * نشسته است. وقتی منشأ معلوم شد، همان پول **دوباره دریافت نمی‌شود**؛ فقط از
 * بدهی موقت به جای درستش منتقل می‌شود:
 *
 *   فاکتور فروش     Dr وجوه ناشناس / Cr حساب دریافتنی مشتری + پرداخت روی همان فاکتور
 *   درآمد           Dr وجوه ناشناس / Cr درآمد (+ Cr ارزش افزودهٔ فروش)
 *   جاری شریک       Dr وجوه ناشناس / Cr جاری شریک — بدهی شرکت
 *   پیش‌دریافت      Dr وجوه ناشناس / Cr پیش‌دریافت مشتری
 *   استرداد به فرستنده  Dr وجوه ناشناس / Cr بانک — تنها حالتی که پول واقعاً جابه‌جا می‌شود
 *
 * سقف هر تعیین تکلیف، ماندهٔ همان واریز و ماندهٔ واقعی حساب است؛ تعیین تکلیف
 * جزئی مجاز است و باقی‌مانده باز می‌ماند.
 */
export const RESOLUTION_TARGETS = Object.freeze({
  invoice: 'تسویهٔ فاکتور فروش',
  income: 'درآمد',
  partner: 'جاری شریک — وجه در اختیار شرکت',
  advance: 'پیش‌دریافت مشتری',
  refund: 'استرداد به فرستنده',
});
const SOURCE_TYPE = 'unidentified_resolution';

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const fa = (value) => Number(value || 0).toLocaleString('fa-IR');

export function ensureUnidentifiedSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS unidentified_receipt_resolutions (
    id TEXT PRIMARY KEY,
    hold_line_id TEXT NOT NULL REFERENCES journal_lines(id) ON DELETE RESTRICT,
    target TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount>0),
    contact_id TEXT,
    invoice_id TEXT,
    invoice_payment_id TEXT,
    transaction_id TEXT,
    journal_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reversed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_unidentified_resolution_hold ON unidentified_receipt_resolutions(hold_line_id);`);
}

/** هر سطر بستانکار وجوه ناشناس در سند تأییدشده و برنگشته، یک «نگهداری» است. */
export function listUnidentifiedHoldings(database, { includeClosed = false } = {}) {
  ensureUnidentifiedSchema(database);
  const holds = database.prepare(`SELECT l.id AS lineId,l.credit AS amount,j.id AS journalId,j.occurred_at AS occurredAt,j.memo,
      j.fiscal_year AS fiscalYear,j.document_number AS documentNumber,
      (SELECT a2.source_key FROM journal_lines l2 JOIN ledger_accounts a2 ON a2.id=l2.account_id
        WHERE l2.entry_id=j.id AND a2.source_kind='operational-account' AND l2.debit>0 LIMIT 1) AS accountId,
      (SELECT e.id FROM financial_events e WHERE e.journal_entry_id=j.id LIMIT 1) AS eventId
    FROM journal_lines l JOIN journal_entries j ON j.id=l.entry_id JOIN ledger_accounts a ON a.id=l.account_id
    WHERE a.source_kind='unidentified-receipt' AND l.credit>0 AND j.entry_kind='normal' AND j.approval_state='approved'
      AND j.source_type<>? AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=j.id)
    ORDER BY j.occurred_at,j.document_number`).all(SOURCE_TYPE);
  const resolutions = database.prepare(`SELECT id,target,amount,contact_id AS contactId,invoice_id AS invoiceId,reason,occurred_at AS occurredAt,
    journal_id AS journalId FROM unidentified_receipt_resolutions WHERE hold_line_id=? AND reversed_at IS NULL ORDER BY created_at`);
  const evidence = database.prepare('SELECT payload FROM financial_events WHERE id=?');
  return holds.map((hold) => {
    const done = resolutions.all(hold.lineId).map((item) => ({ ...item, targetLabel: RESOLUTION_TARGETS[item.target] || item.target }));
    const resolved = done.reduce((sum, item) => sum + item.amount, 0);
    let text = hold.memo || '';
    try { text = JSON.parse(evidence.get(hold.eventId)?.payload || '{}').evidence || text; } catch { /* متن رویداد اختیاری است. */ }
    return { ...hold, evidence: text, reference: `${hold.fiscalYear}/${hold.documentNumber}`, resolved, remaining: hold.amount - resolved, resolutions: done };
  }).filter((hold) => includeClosed || hold.remaining > 0);
}

/**
 * واریز تازه‌ای که با یک وجه ناشناسِ باز به همان مبلغ و همان حساب می‌خواند.
 *
 * شاید همان پول باشد که حالا صاحبش معلوم شده؛ ثبتش به‌عنوان دریافت تازه، یک
 * ورود پول را دو بار در دفتر می‌نشاند. ثبت متوقف و به حسابدار سپرده می‌شود.
 */
export function matchingUnidentifiedHolding(database, { kind, amount, accountId } = {}) {
  if (kind !== 'cash-income' || !Number.isSafeInteger(amount) || amount <= 0) return null;
  const exists = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='journal_entries'").get();
  if (!exists) return null;
  return listUnidentifiedHoldings(database).find((hold) => hold.remaining === amount && (!accountId || !hold.accountId || hold.accountId === accountId)) || null;
}

function unidentifiedBalance(database) {
  return -database.prepare(`SELECT COALESCE(SUM(l.debit-l.credit),0) n FROM journal_lines l JOIN journal_entries j ON j.id=l.entry_id
    JOIN ledger_accounts a ON a.id=l.account_id WHERE a.source_kind='unidentified-receipt' AND j.approval_state='approved'`).get().n;
}

/**
 * تعیین تکلیف تمام یا بخشی از یک وجه ناشناس. داخل یک تراکنش صدا زده می‌شود.
 *
 * `helpers` توابع لایهٔ داده را می‌دهد (فاکتور، شخص، حساب) تا این ماژول به
 * لایهٔ db وابسته نشود.
 */
export function resolveUnidentifiedHolding(database, lineId, values = {}, { actor = null, timeZone = 'Asia/Tehran', helpers = {} } = {}) {
  ensureUnidentifiedSchema(database);
  const hold = listUnidentifiedHoldings(database, { includeClosed: true }).find((item) => item.lineId === String(lineId || ''));
  if (!hold) throw fail('وجه ناشناس پیدا نشد یا سندش برگشت خورده است.', 'UNIDENTIFIED_HOLD_MISSING', 404);
  const target = String(values.target || '');
  if (!RESOLUTION_TARGETS[target]) throw fail('نوع تعیین تکلیف را انتخاب کن.', 'UNIDENTIFIED_TARGET_INVALID');
  const amount = values.amount == null || values.amount === '' ? hold.remaining : Math.round(Number(values.amount));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw fail('مبلغ تعیین تکلیف معتبر نیست.', 'UNIDENTIFIED_AMOUNT_INVALID');
  if (amount > hold.remaining) throw fail(`مبلغ از ماندهٔ این وجه (${fa(hold.remaining)}) بیشتر است.`, 'UNIDENTIFIED_AMOUNT_EXCEEDS', 409);
  if (amount > unidentifiedBalance(database)) throw fail('ماندهٔ واقعی حساب وجوه ناشناس برای این مبلغ کافی نیست.', 'UNIDENTIFIED_BALANCE_SHORT', 409);
  const reason = String(values.reason || '').trim().slice(0, 500);
  if (reason.length < 8) throw fail('منشأ وجه را با دلیل یا مدرک (حداقل هشت نویسه) بنویس.', 'UNIDENTIFIED_REASON_REQUIRED');
  const occurredAt = values.occurredAt || new Date().toISOString();
  if (String(occurredAt).slice(0, 10) < String(hold.occurredAt).slice(0, 10)) throw fail('تعیین تکلیف پیش از تاریخ دریافت وجه ممکن نیست.', 'UNIDENTIFIED_DATE_INVALID');

  const id = randomUUID();
  const holdAccount = resolveEventRole(database, ROLES.UNIDENTIFIED_RECEIPT, null, {});
  const debit = { accountId: holdAccount, debit: amount, credit: 0, description: `تعیین تکلیف وجه ناشناس ${hold.reference}` };
  let lines;
  let contact = null;
  let invoice = null;
  let invoicePaymentId = null;
  let transactionId = null;

  if (['invoice', 'partner', 'advance'].includes(target)) {
    contact = values.contactId ? helpers.contact?.(values.contactId) : null;
    if (target !== 'invoice' && !contact) throw fail('شخص را انتخاب کن؛ این ماندهٔ اوست، نه یک حساب عمومی.', 'UNIDENTIFIED_CONTACT_REQUIRED');
  }
  if (target === 'invoice') {
    invoice = values.invoiceId ? helpers.invoice?.(values.invoiceId) : null;
    if (!invoice || invoice.documentType !== 'sales' || ['draft', 'cancelled'].includes(invoice.status)) throw fail('فاکتور فروش صادرشده‌ای را انتخاب کن.', 'UNIDENTIFIED_INVOICE_INVALID');
    if (amount > invoice.balanceDue) throw fail(`مبلغ از ماندهٔ فاکتور ${invoice.number} (${fa(invoice.balanceDue)}) بیشتر است.`, 'INVOICE_OVERPAYMENT', 409);
    const receivable = counterpartyLedgerAccount(database, invoice.contactId, invoice.contactName || invoice.customerName, 'sales');
    const analyticId = analyticForContact(database, invoice.contactId, invoice.contactName || invoice.customerName || 'مشتری متفرقه')?.id || null;
    lines = [debit, { accountId: receivable, debit: 0, credit: amount, analyticId, description: `وصول ${invoice.number}` }];
  } else if (target === 'income') {
    const category = String(values.category || '').trim().slice(0, 80);
    if (!category) throw fail('دستهٔ درآمد را بنویس.', 'UNIDENTIFIED_CATEGORY_REQUIRED');
    const vat = Math.round(Number(values.vatAmount || 0));
    if (!Number.isSafeInteger(vat) || vat < 0 || vat >= amount) throw fail('ارزش افزوده باید صفر یا کمتر از مبلغ باشد.', 'UNIDENTIFIED_VAT_INVALID');
    lines = [debit, { accountId: resolveEventRole(database, ROLES.INCOME_CATEGORY, category, {}), debit: 0, credit: amount - vat, description: category }];
    if (vat) lines.push({ accountId: resolveEventRole(database, ROLES.VAT_OUTPUT, null, {}), debit: 0, credit: vat, description: 'ارزش افزودهٔ فروش' });
  } else if (target === 'partner' || target === 'advance') {
    const role = target === 'partner' ? ROLES.PARTNER_PAYABLE : ROLES.CUSTOMER_ADVANCE;
    const event = { counterpartyId: contact.id, counterparty: contact.name };
    lines = [debit, { accountId: resolveEventRole(database, role, contact.name, event), debit: 0, credit: amount, analyticId: resolveEventAnalytic(database, role, event, contact.name), description: RESOLUTION_TARGETS[target] }];
  } else {
    if (!hold.accountId) throw fail('حساب بانکی که وجه به آن نشسته پیدا نشد؛ استرداد را دستی بررسی کن.', 'UNIDENTIFIED_ACCOUNT_MISSING', 409);
    lines = [debit, { accountId: resolveEventRole(database, ROLES.CASH, hold.accountId, {}), debit: 0, credit: amount, description: 'استرداد وجه ناشناس به فرستنده' }];
  }

  const posted = postJournalEntry(database, {
    sourceType: SOURCE_TYPE, sourceId: id, occurredAt,
    memo: `تعیین تکلیف وجه ناشناس ${hold.reference} — ${RESOLUTION_TARGETS[target]}`, lines,
  }, { createdBy: actor, timeZone });

  if (invoice) {
    invoicePaymentId = randomUUID();
    // پرداخت روی همان حسابی می‌نشیند که پول واقعاً به آن آمده بود؛ ردیف نقدی
    // تازه‌ای ساخته نمی‌شود چون پول یک بار و در روز نگهداری وارد شده است.
    database.prepare(`INSERT INTO invoice_payments (id,invoice_id,amount,account_id,transaction_id,occurred_at,note,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(invoicePaymentId, invoice.id, amount, hold.accountId || 'cash', null, occurredAt, `تعیین تکلیف وجه ناشناس ${hold.reference}`, actor);
    if (amount === invoice.balanceDue) database.prepare("UPDATE invoices SET status='paid',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(invoice.id);
  }
  if (target === 'refund') {
    transactionId = randomUUID();
    database.prepare(`INSERT INTO transactions(id,client_id,amount,type,category,raw_text,source,account_id,account,occurred_at,status,journal_deferred,accounting_role,review_state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?)`).run(transactionId, `${SOURCE_TYPE}:${id}`, amount, 'expense', 'استرداد وجه ناشناس',
      `استرداد وجه ناشناس ${hold.reference}`, 'text', hold.accountId, hold.accountId, occurredAt, 'allocated', 'unidentified-receipt', 'reviewed');
  }
  database.prepare(`INSERT INTO unidentified_receipt_resolutions(id,hold_line_id,target,amount,contact_id,invoice_id,invoice_payment_id,transaction_id,journal_id,reason,occurred_at,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, hold.lineId, target, amount, contact?.id || invoice?.contactId || null, invoice?.id || null,
    invoicePaymentId, transactionId, posted.id, reason, occurredAt, actor);
  return { id, holdLineId: hold.lineId, target, amount, journalId: posted.id, remaining: hold.remaining - amount };
}

/** برگشت یک تعیین تکلیف: سند معکوس، پرداخت فاکتور و ردیف استرداد حذف، وجه دوباره باز. */
export function reverseUnidentifiedResolution(database, resolutionId, { actor = null, timeZone = 'Asia/Tehran', occurredAt = null } = {}) {
  ensureUnidentifiedSchema(database);
  const row = database.prepare('SELECT * FROM unidentified_receipt_resolutions WHERE id=?').get(String(resolutionId || ''));
  if (!row || row.reversed_at) throw fail('این تعیین تکلیف پیدا نشد یا قبلاً برگشت خورده است.', 'UNIDENTIFIED_RESOLUTION_MISSING', 404);
  reverseJournalEntry(database, { sourceType: SOURCE_TYPE, sourceId: row.id, occurredAt: occurredAt || new Date().toISOString(), memo: 'برگشت تعیین تکلیف وجه ناشناس', createdBy: actor, timeZone });
  if (row.invoice_payment_id) {
    database.prepare('DELETE FROM invoice_payments WHERE id=?').run(row.invoice_payment_id);
    database.prepare("UPDATE invoices SET status='sent',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='paid'").run(row.invoice_id);
  }
  if (row.transaction_id) database.prepare("UPDATE transactions SET status='deleted',updated_at=? WHERE id=?").run(new Date().toISOString(), row.transaction_id);
  database.prepare('UPDATE unidentified_receipt_resolutions SET reversed_at=? WHERE id=?').run(new Date().toISOString(), row.id);
  return { id: row.id, reversed: true };
}

/** نگهداری که تعیین تکلیف فعال دارد، خودش قابل برگشت نیست. */
export function assertHoldHasNoResolutions(database, journalEntryId) {
  ensureUnidentifiedSchema(database);
  const active = database.prepare(`SELECT count(*) n FROM unidentified_receipt_resolutions r JOIN journal_lines l ON l.id=r.hold_line_id
    WHERE l.entry_id=? AND r.reversed_at IS NULL`).get(journalEntryId).n;
  if (active) throw fail('این وجه تعیین تکلیف شده است؛ اول تعیین تکلیف‌ها را برگردان.', 'UNIDENTIFIED_HAS_RESOLUTIONS', 409);
}
