import { randomUUID } from 'node:crypto';
import { ROLES } from '../shared/accountingRules.js';
import {
  analyticForContact, listChartAccounts, mapLedgerAccountToChart, suggestChartAccount,
} from './chartOfAccounts.js';

/**
 * نگاشت نقش به حساب واقعی دفتر.
 *
 * قواعد حسابداری با **نقش** کار می‌کنند («طلب»، «هزینهٔ دسته»)، نه با کد حساب.
 * دلیلش این است که کدینگ هر دفتر فرق می‌کند و قاعده باید با هر کدینگی درست
 * بماند. اینجا تنها جایی است که هر دو را می‌شناسد.
 *
 * این فایل عمداً هیچ تصمیم حسابداری نمی‌گیرد: نمی‌گوید چه چیزی بدهکار شود،
 * فقط می‌گوید «حسابِ نقشِ طلب برای این طرف حساب کدام است».
 */

function resolverError(message, code = 'ROLE_UNRESOLVED') {
  return Object.assign(new Error(message), { code, status: 400 });
}

/**
 * حسابی با همین منشأ پیدا یا ساخته می‌شود.
 *
 * ساختن خودکار عمدی است: اولین باری که کاربر با «شرکت آراد» کار می‌کند، نباید
 * مجبور باشد اول دستی حساب بسازد. ولی کلید همیشه از منشأ می‌آید، نه از نام
 * نمایشی، تا تغییر نام حساب تازه‌ای نسازد.
 */
function linkedAccount(database, sourceKind, sourceKey, name, type, normalSide = null) {
  const key = String(sourceKey || '').trim() || 'default';
  const existing = database.prepare('SELECT id FROM ledger_accounts WHERE source_kind=? AND source_key=?').get(sourceKind, key);
  if (existing) return existing.id;
  const id = randomUUID();
  const side = normalSide || (['asset', 'expense'].includes(type) ? 'debit' : 'credit');
  const ranges = { asset: 1100, liability: 2100, equity: 3100, income: 4100, expense: 5100 };
  const base = ranges[type] || 9100;
  const used = new Set(database.prepare('SELECT code FROM ledger_accounts WHERE CAST(code AS INTEGER)>=? AND CAST(code AS INTEGER)<?')
    .all(base, base + 900).map((row) => Number(row.code)));
  let code = base;
  while (used.has(code)) code += 1;
  database.prepare('INSERT INTO ledger_accounts (id,code,name,type,normal_side,source_kind,source_key) VALUES (?,?,?,?,?,?,?)')
    .run(id, String(code), String(name).slice(0, 120), type, side, sourceKind, key);
  autoMapToChart(database, { id, type, sourceKind, sourceKey: key, name });
  return id;
}

function operationalAccount(database, accountId) {
  const account = database.prepare('SELECT id,name FROM accounts WHERE id=?').get(String(accountId || 'cash'))
    || database.prepare('SELECT id,name FROM accounts WHERE id=?').get('cash');
  if (!account) throw resolverError('حساب نقدی دفتر پیدا نشد.', 'CASH_ACCOUNT_MISSING');
  return linkedAccount(database, 'operational-account', account.id, account.name, 'asset');
}

/**
 * حساب متناظر یک نقش.
 *
 * `key` زیرحساب را مشخص می‌کند: نام دسته، نام طرف حساب یا نام دارایی. نبودش
 * برای نقش‌هایی که زیرحساب دارند خطاست، نه «حساب پیش‌فرض» — حسابِ بی‌نام،
 * ردیفی است که شش ماه بعد هیچ‌کس نمی‌داند چیست.
 */
export function resolveEventRole(database, role, key, event = {}) {
  switch (role) {
    case ROLES.CASH:
      return operationalAccount(database, key || event.accountId);

    case ROLES.INCOME_CATEGORY:
      return linkedAccount(database, 'income-category', key || 'سایر درآمدها', key || 'سایر درآمدها', 'income');

    case ROLES.EXPENSE_CATEGORY:
      return linkedAccount(database, 'expense-category', key || 'سایر هزینه‌ها', key || 'سایر هزینه‌ها', 'expense');

    case ROLES.RECEIVABLE:
      return linkedAccount(database, 'customer-receivable', key || 'مشتری متفرقه', `حساب دریافتنی — ${key || 'مشتری متفرقه'}`, 'asset');

    case ROLES.PAYABLE:
      return linkedAccount(database, 'vendor-payable', key || 'تأمین‌کننده متفرقه', `حساب پرداختنی — ${key || 'تأمین‌کننده متفرقه'}`, 'liability');

    // چک حساب جدا دارد تا در تراز از مطالبات عادی قابل تفکیک باشد.
    case ROLES.CHEQUE_RECEIVABLE:
      return linkedAccount(database, 'cheque-receivable', key || 'چک دریافتی', `اسناد دریافتنی — ${key || 'متفرقه'}`, 'asset');

    case ROLES.CHEQUE_PAYABLE:
      return linkedAccount(database, 'cheque-payable', key || 'چک پرداختی', `اسناد پرداختنی — ${key || 'متفرقه'}`, 'liability');

    case ROLES.OWNER_CAPITAL:
      return linkedAccount(database, 'system', 'owner-capital', 'سرمایه — آوردهٔ مالک', 'equity');

    case ROLES.FIXED_ASSET: {
      if (!String(key || '').trim()) throw resolverError('نام دارایی ثابت برای ساخت حساب لازم است.', 'ASSET_NAME_MISSING');
      return linkedAccount(database, 'fixed-asset', key, `دارایی ثابت — ${key}`, 'asset');
    }

    case ROLES.ACCUMULATED_DEPRECIATION: {
      if (!String(key || '').trim()) throw resolverError('نام دارایی برای استهلاک انباشته لازم است.', 'ASSET_NAME_MISSING');
      // حساب کاهنده: نوعش دارایی است ولی ماهیتش بستانکار، وگرنه به‌جای
      // کم‌کردن، دارایی را زیاد نشان می‌دهد.
      return linkedAccount(database, 'accumulated-depreciation', key, `استهلاک انباشته — ${key}`, 'asset', 'credit');
    }

    case ROLES.DEPRECIATION_EXPENSE:
      return linkedAccount(database, 'system', 'depreciation-expense', 'هزینهٔ استهلاک', 'expense');

    default:
      throw resolverError(`نقش «${role}» به هیچ حسابی نگاشت نشده است.`);
  }
}

/**
 * تفصیلی یک سطر — یعنی «این ردیف مال کدام شخص است».
 *
 * در پارسیان اشخاص در تفصیلی زندگی می‌کنند، نه در معین. یک معین «حساب‌های
 * دریافتنی» داریم و هر مشتری زیرش یک تفصیلی است. اگر تفصیلی خالی برود، ردیف
 * روی معین می‌نشیند و طرف حساب کاملاً گم می‌شود — همان چیزی که در فایل انتقال
 * دیده شد: هفتادوهشت ردیف با تفصیلی صفر.
 *
 * فقط نقش‌هایی تفصیلی می‌گیرند که واقعاً طرف حساب دارند. گذاشتن تفصیلی روی
 * صندوق یا حساب هزینه، داده‌ای می‌سازد که هیچ معنایی ندارد.
 */
const COUNTERPARTY_ROLES = new Set([
  ROLES.RECEIVABLE, ROLES.PAYABLE, ROLES.CHEQUE_RECEIVABLE, ROLES.CHEQUE_PAYABLE,
]);

export function resolveEventAnalytic(database, role, event = {}) {
  if (!COUNTERPARTY_ROLES.has(role)) return null;
  // تفصیلی فقط از شخصِ تعریف‌شده ساخته می‌شود، نه از یک متن آزاد.
  //
  // وقتی طرف حسابی ثبت نشده، عنوان تعهد («بدهی بابت اجاره») می‌تواند به‌جای نام
  // برداشته شود و یک تفصیلیِ جعلی بسازد که نه در پارسیان وجود دارد و نه با
  // هیچ شخص واقعی یکی می‌شود. نبودِ تفصیلی صادقانه‌تر از تفصیلی ساختگی است.
  const contactId = String(event.counterpartyId || '').trim();
  if (!contactId) return null;
  const name = String(event.counterparty || '').trim();
  // کلید از شناسهٔ شخص می‌آید نه از نامش، تا تغییر نام تفصیلی تازه‌ای نسازد.
  const analytic = analyticForContact(database, contactId, name || 'طرف حساب');
  return analytic?.id || null;
}

/**
 * حساب تازه همان لحظه به کدینگ دفتر نگاشت می‌شود.
 *
 * بدون این، هر حسابی که مسیر رویداد می‌سازد بدون معین مقصد می‌ماند و چون
 * «هر حساب استفاده‌شده باید معین داشته باشد» یک کنترل بازدارنده است، **کل
 * خروجی پارسیان قفل می‌شود**.
 *
 * پیشنهاد از همان `suggestChartAccount` می‌آید که معین اختصاصی هر دسته را
 * می‌شناسد؛ پس اجاره روی حساب اجاره می‌نشیند نه روی «سایر هزینه‌ها».
 *
 * شکست اینجا بی‌صداست و عمدی: کدینگ ممکن است هنوز نصب نشده باشد یا معین
 * متناسبی نداشته باشد. نگاشت‌نشدن یک ایراد قابل‌دیدن در صفحهٔ آمادگی است، ولی
 * نباید جلوی ثبت خودِ سند را بگیرد.
 */
function autoMapToChart(database, ledgerAccount) {
  try {
    const chart = listChartAccounts(database);
    if (!chart.length) return;
    // فقط نگاشت مطمئن: دستهٔ ناشناخته بدون نگاشت می‌ماند تا حسابدار خودش
    // تصمیم بگیرد، نه اینکه بی‌صدا روی معین عمومی بنشیند.
    const suggestion = suggestChartAccount(ledgerAccount, chart, { confidentOnly: true });
    if (suggestion) mapLedgerAccountToChart(database, ledgerAccount.id, suggestion.id);
  } catch { /* کدینگ هنوز آمادهٔ نگاشت نیست؛ صفحهٔ آمادگی آن را نشان می‌دهد. */ }
}
