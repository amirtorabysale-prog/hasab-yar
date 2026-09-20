import { db, invalidInput } from './core.js';

/**
 * کارت حساب طرف حساب — گردش یک شخص یا شرکت با مانده‌گیری تجمعی.
 *
 * منبع عمداً دفتر کل است، نه جمع‌زدن جدول‌های تراکنش و فاکتور و تعهد و چک.
 * دو دلیل:
 *
 * ۱. **درستی.** همان رویداد در چند جدول رد دارد — فاکتور فروش، تسویه‌اش و چکی
 *    که بابتش گرفته شده، سه ردیف در سه جدول‌اند ولی یک گردش حساب. جمع‌زدن
 *    جدول‌ها یعنی شمارش دوباره؛ سند دوطرفه این را از تعریف حل کرده است.
 * ۲. **کامل‌بودن.** هر رویدادی که به طرف حساب می‌خورد سند می‌زند. هر منبع
 *    تازه‌ای که فردا اضافه شود، بدون تغییر اینجا در کارت دیده می‌شود.
 *
 * حساب یک طرف حساب می‌تواند با شناسه‌اش کلید خورده باشد یا با نامش — بسته به
 * اینکه موقع اولین سند کدام در دست بوده. هر دو گرفته می‌شوند، وگرنه نیمی از
 * گردشِ همان شخص از کارت جا می‌ماند.
 */

const COUNTERPARTY_KINDS = ['customer-receivable', 'vendor-payable', 'cheque-receivable', 'cheque-payable'];

/** بدهکار مثبت، بستانکار منفی. مانده از دید ما: مثبت یعنی او به ما بدهکار است. */
const movement = (row) => Number(row.debit || 0) - Number(row.credit || 0);

/**
 * ماندهٔ سندهای باز این طرف حساب — دقیقاً همان چیزی که فهرست نشان می‌دهد.
 *
 * کارت از دفتر کل می‌خواند و فهرست از جدول تعهد و فاکتور. تا وقتی هر سند
 * ردش در دفتر هست، هر دو یک عدد می‌دهند. ولی سندی که طرف حسابش موقع ثبت
 * وصل نبوده، در دفتر کل حسابی به نام خودش می‌سازد که به این شخص نمی‌چسبد —
 * و آن‌وقت فهرست عدد نشان می‌دهد و کارت «تسویه».
 *
 * این تابع همان عدد فهرست را برمی‌گرداند تا کارت بتواند اختلاف را ببیند و
 * بگوید، نه اینکه پنهانش کند.
 */
function documentBalance(contactId) {
  const row = db.prepare(`SELECT
    COALESCE((SELECT SUM(CASE WHEN direction='receivable' THEN amount ELSE -amount END)
      FROM obligations WHERE contact_id=? AND status='open'),0)
    + COALESCE((SELECT SUM(CASE WHEN document_type='sales' THEN total-COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id=invoices.id),0)
      ELSE -(total-COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id=invoices.id),0)) END)
      FROM invoices WHERE contact_id=? AND status IN ('sent','paid')),0) AS balance,
    (SELECT COUNT(*) FROM obligations WHERE contact_id=? AND status='open')
    + (SELECT COUNT(*) FROM invoices WHERE contact_id=? AND status='sent') AS openCount`)
    .get(contactId, contactId, contactId, contactId);
  return { balance: Number(row?.balance || 0), openCount: Number(row?.openCount || 0) };
}

function counterpartyAccounts(contact) {
  const keys = [contact.id, contact.name].map((value) => String(value || '').trim().slice(0, 120)).filter(Boolean);
  if (!keys.length) return [];
  const kindHoles = COUNTERPARTY_KINDS.map(() => '?').join(',');
  const keyHoles = keys.map(() => '?').join(',');
  return db.prepare(`SELECT id,code,name,source_kind AS sourceKind FROM ledger_accounts
    WHERE source_kind IN (${kindHoles}) AND source_key IN (${keyHoles}) ORDER BY code`)
    .all(...COUNTERPARTY_KINDS, ...keys);
}

export function counterpartyCard(contactId, { from = '', to = '' } = {}) {
  const contact = db.prepare('SELECT id,name,kind,phone,note FROM contacts WHERE id=?').get(String(contactId || ''));
  if (!contact) throw invalidInput('این طرف حساب پیدا نشد.', 'CONTACT_NOT_FOUND');

  const accounts = counterpartyAccounts(contact);
  const openDocuments = documentBalance(contact.id);
  const reconcile = (ledgerBalance) => ({
    documents: openDocuments.balance,
    ledger: ledgerBalance,
    // اختلاف یعنی سندی هست که در دفتر کل به این شخص نچسبیده. صفر یعنی کارت
    // کامل است.
    unexplained: openDocuments.balance - ledgerBalance,
    openCount: openDocuments.openCount,
  });
  if (!accounts.length) {
    return {
      contact, accounts, opening: 0, lines: [], period: { from, to },
      totals: { debit: 0, credit: 0, balance: 0, documents: 0 },
      reconciliation: reconcile(0),
    };
  }

  const holes = accounts.map(() => '?').join(',');
  const ids = accounts.map((account) => account.id);
  const rows = db.prepare(`SELECT journal_lines.id,journal_entries.occurred_at AS occurredAt,journal_entries.memo,
      journal_entries.source_type AS sourceType,journal_entries.source_id AS sourceId,
      journal_entries.entry_kind AS entryKind,journal_lines.debit,journal_lines.credit,
      journal_lines.description,ledger_accounts.code AS accountCode,ledger_accounts.name AS accountName,
      ledger_accounts.source_kind AS accountKind
    FROM journal_lines
    JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
    JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
    WHERE journal_lines.account_id IN (${holes})
    ORDER BY journal_entries.occurred_at,journal_entries.id,journal_lines.rowid`).all(...ids);

  // مانده افتتاحیه یعنی هرچه پیش از بازهٔ خواسته‌شده رخ داده. بدون این، کارتِ
  // یک ماه، مانده را از صفر شروع می‌کند و عدد پایانی‌اش با دفتر نمی‌خواند.
  const before = from ? rows.filter((row) => row.occurredAt < from) : [];
  const within = rows.filter((row) => (!from || row.occurredAt >= from) && (!to || row.occurredAt <= to));
  const opening = before.reduce((sum, row) => sum + movement(row), 0);

  let balance = opening;
  const lines = within.map((row) => {
    balance += movement(row);
    return {
      id: row.id,
      occurredAt: row.occurredAt,
      title: String(row.description || row.memo || '').trim(),
      memo: row.memo,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      entryKind: row.entryKind,
      accountCode: row.accountCode,
      accountName: row.accountName,
      accountKind: row.accountKind,
      debit: Number(row.debit || 0),
      credit: Number(row.credit || 0),
      balance,
    };
  });

  return {
    contact,
    accounts,
    opening,
    lines,
    period: { from, to },
    totals: {
      debit: lines.reduce((sum, line) => sum + line.debit, 0),
      credit: lines.reduce((sum, line) => sum + line.credit, 0),
      balance,
      documents: new Set(lines.map((line) => `${line.sourceType}:${line.sourceId}`)).size,
    },
    // اختلاف فقط وقتی معنا دارد که کل گردش دیده شود؛ با بازه، بخشی از سندها
    // عمداً بیرون‌اند و مقایسه گمراه‌کننده می‌شود.
    reconciliation: from || to ? null : reconcile(balance),
  };
}
