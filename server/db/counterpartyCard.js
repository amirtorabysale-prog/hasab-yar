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
    COALESCE((SELECT SUM(CASE WHEN direction='receivable'
      THEN amount-COALESCE(paid_amount,0) ELSE -(amount-COALESCE(paid_amount,0)) END)
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

/**
 * ماندهٔ دفتریِ یک طرف حساب — مثبت یعنی او به ما بدهکار است.
 *
 * لازم است تا هنگام ثبت یک پرداخت بدانیم این پول «تسویهٔ بدهی اوست» یا
 * «هزینه». همان حساب‌هایی خوانده می‌شوند که کارت حساب می‌خواند، وگرنه دو
 * جای برنامه دو عدد متفاوت می‌گویند.
 */
export function counterpartyLedgerBalance(contact) {
  const accounts = counterpartyAccounts(contact);
  if (!accounts.length) return 0;
  const holes = accounts.map(() => '?').join(',');
  return Number(db.prepare(`SELECT COALESCE(SUM(debit)-SUM(credit),0) AS net
    FROM journal_lines WHERE account_id IN (${holes})`).get(...accounts.map((account) => account.id)).net || 0);
}

/**
 * ماندهٔ یک طرف حساب — همان عددی که کارتش نشان می‌دهد.
 *
 * فهرست اشخاص تا امروز خودش جمع می‌زد: تعهدهای باز به‌اضافهٔ فاکتورهای
 * تسویه‌نشده. کارت اما از دفتر می‌خواند. تا وقتی هر سند ردش در دفتر بود هر
 * دو یک عدد می‌دادند، ولی به‌محض اینکه پرداختی بدهی را کم کرد بی‌آنکه تعهد
 * را ببندد، دو عدد از هم جدا شدند — و حسابدار نمی‌دانست کدام درست است.
 *
 * حالا یک تابع، یک عدد. کند بودنش مهم نیست: چند پرس‌وجوی کوچک به‌ازای هر
 * شخص، در برابر دو عددِ متناقض روی صفحه چیزی نیست.
 */
export function counterpartyBalance(contactId) {
  try { return counterpartyCard(contactId).totals.balance; } catch { return 0; }
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
  const holes = accounts.map(() => '?').join(',');
  const ids = accounts.map((account) => account.id);
  const rows = !accounts.length ? [] : db.prepare(`SELECT journal_lines.id,journal_entries.occurred_at AS occurredAt,journal_entries.memo,
      journal_entries.source_type AS sourceType,journal_entries.source_id AS sourceId,
      journal_entries.entry_kind AS entryKind,journal_lines.debit,journal_lines.credit,
      journal_lines.description,ledger_accounts.code AS accountCode,ledger_accounts.name AS accountName,
      ledger_accounts.source_kind AS accountKind
    FROM journal_lines
    JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
    JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
    WHERE journal_lines.account_id IN (${holes})
    ORDER BY journal_entries.occurred_at,journal_entries.id,journal_lines.rowid`).all(...ids);

  /**
   * ثبت‌های مستقیمی که به این طرف حساب وصل‌اند ولی حساب او را لمس نمی‌کنند.
   *
   * پرداخت نقدی به یک تأمین‌کننده در حسابداری دوطرفه «بدهکار هزینه، بستانکار
   * صندوق» است — به حساب خودِ او نمی‌خورد. پس کارتی که فقط ردیف‌های دفتر کل
   * را بخواند، «۹۳ میلیون به شرکت آراد گستر پرداخت شد» را هرگز نشان نمی‌دهد.
   *
   * ولی چیزی که از کارت حساب انتظار می‌رود، گردش حسابداری نیست: همهٔ داد و
   * ستد با آن شخص است. پس ثبت‌های وصل‌شده هم می‌آیند. ثبت‌هایی که تسویهٔ سند
   * هستند (`allocated`) کنار گذاشته می‌شوند، چون ردشان از قبل در دفتر کل هست
   * و دو بار شمرده می‌شدند.
   */
  // ثبتی که سندش به حساب خودِ همین شخص خورده، از ردیف‌های دفتر بالا آمده و
  // شمردن دوباره‌اش مانده را دو برابر می‌کند. این از وقتی ممکن شد که پرداخت
  // به یک بدهکار، به‌جای هزینه روی حساب خودش بنشیند.
  const postedToOwnAccount = accounts.length
    ? new Set(db.prepare(`SELECT journal_entries.source_id AS id FROM journal_entries
        JOIN journal_lines ON journal_lines.entry_id=journal_entries.id
        WHERE journal_entries.source_type='transaction' AND journal_lines.account_id IN (${accounts.map(() => '?').join(',')})`)
      .all(...accounts.map((account) => account.id)).map((row) => row.id))
    : new Set();
  const direct = db.prepare(`SELECT transactions.id,transactions.occurred_at AS occurredAt,
      transactions.raw_text AS memo,transactions.category,transactions.type,transactions.amount
    FROM transactions WHERE contact_id=? AND status!='allocated' AND capital_flow='' AND accounting_role=''`).all(contact.id)
    .filter((row) => !postedToOwnAccount.has(row.id))
    .map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      memo: row.category,
      description: row.memo,
      sourceType: 'transaction',
      sourceId: row.id,
      entryKind: 'normal',
      accountCode: '',
      accountName: row.category,
      accountKind: 'transaction',
      // پولی که به او دادیم بدهکارش می‌کند، پولی که از او گرفتیم بستانکار.
      debit: row.type === 'expense' ? Number(row.amount || 0) : 0,
      credit: row.type === 'income' ? Number(row.amount || 0) : 0,
    }));

  // مانده افتتاحیه یعنی هرچه پیش از بازهٔ خواسته‌شده رخ داده. بدون این، کارتِ
  // یک ماه، مانده را از صفر شروع می‌کند و عدد پایانی‌اش با دفتر نمی‌خواند.
  const all = [...rows, ...direct].sort((left, right) => String(left.occurredAt).localeCompare(String(right.occurredAt)));
  const before = from ? all.filter((row) => row.occurredAt < from) : [];
  const within = all.filter((row) => (!from || row.occurredAt >= from) && (!to || row.occurredAt <= to));
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

/**
 * اسناد بازِ یک طرف حساب — ردیف‌به‌ردیف، نه جمعشان.
 *
 * `documentBalance` بالا همین منابع را جمع می‌زند و یک عدد می‌دهد. نگهبان
 * تسویه به عدد نیاز ندارد؛ به خودِ سندها نیاز دارد تا بتواند بگوید «این پول
 * فاکتور ۱۲۳ را می‌بندد» — نه فقط «این شخص بدهکار است».
 *
 * `remaining` همان ماندهٔ واقعی است، نه مبلغ اولیه: سندی که نیمی‌اش پرداخت
 * شده، با مبلغ کاملش تطبیق داده نمی‌شود.
 */
export function openDocumentsFor(contactId) {
  const id = String(contactId || '').trim();
  if (!id) return [];

  const obligations = db.prepare(`SELECT id,direction,title,occurred_at AS occurredAt,
    amount-COALESCE(paid_amount,0) AS remaining
    FROM obligations WHERE contact_id=? AND status='open' AND amount-COALESCE(paid_amount,0) > 0`).all(id);

  const invoices = db.prepare(`SELECT id,number,document_type AS documentType,created_at AS occurredAt,
    total-COALESCE((SELECT SUM(amount) FROM invoice_payments WHERE invoice_id=invoices.id),0) AS remaining
    FROM invoices WHERE contact_id=? AND status='sent'`).all(id);

  // جدول چک تنبل ساخته می‌شود — دفتری که هنوز چکی ثبت نکرده آن را ندارد.
  // پرسیدن از `sqlite_master` صریح‌تر از بلعیدن خطاست: اگر روزی کوئری واقعاً
  // خراب شود، باید بشکند نه اینکه بی‌صدا فهرست ناقص بدهد.
  const chequeTableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cheques'").get();
  const cheques = chequeTableExists
    ? db.prepare(`SELECT id,direction,serial,occurred_at AS occurredAt,amount AS remaining
      FROM cheques WHERE contact_id=? AND status='open'`).all(id)
    : [];

  return [
    ...obligations.map((row) => ({
      kind: 'obligation', id: row.id, direction: row.direction,
      remaining: Number(row.remaining), occurredAt: row.occurredAt,
      reference: row.title || 'تعهد بدون عنوان',
    })),
    ...invoices.filter((row) => Number(row.remaining) > 0).map((row) => ({
      kind: 'invoice', id: row.id,
      // فاکتور فروش یعنی او به ما بدهکار است؛ فاکتور خرید یعنی ما به او.
      direction: row.documentType === 'purchase' ? 'payable' : 'receivable',
      remaining: Number(row.remaining), occurredAt: row.occurredAt,
      reference: `فاکتور ${row.number}`,
    })),
    ...cheques.map((row) => ({
      kind: 'cheque', id: row.id, direction: row.direction,
      remaining: Number(row.remaining), occurredAt: row.occurredAt,
      reference: row.serial ? `چک ${row.serial}` : 'چک بدون شماره',
    })),
  ].sort((left, right) => String(left.occurredAt).localeCompare(String(right.occurredAt)));
}
