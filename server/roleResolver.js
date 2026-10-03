import { randomUUID } from 'node:crypto';
import { ROLES } from '../shared/accountingRules.js';
import {
  analyticForContact, listChartAccounts, mapLedgerAccountToChart, suggestChartAccount,
} from './chartOfAccounts.js';
import { counterpartyAnalyticForKey } from './chartOfAccounts.js';
import { counterpartyAccountKey, inputTaxLedgerAccount, outputTaxLedgerAccount } from './accounting.js';

// همان‌جایی که تفصیلی ساخته می‌شود تعریف شده؛ اینجا فقط مصرف و بازصادر می‌شود.
export { counterpartyAnalyticForKey };

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
/**
 * حساب اختصاصی یک طرف حساب.
 *
 * نام برای دیدن است و شناسه برای شناختن. کلید از همان تابعی می‌آید که مسیر
 * فاکتور هم از آن استفاده می‌کند، وگرنه یک مشتری بسته به مسیرِ ثبت دو حساب
 * پیدا می‌کند.
 */
function counterpartyRoleAccount(database, sourceKind, event, key, label, type) {
  const name = String(key || '').trim() || label;
  const accountKey = counterpartyAccountKey(database, sourceKind, event.counterpartyId, name);
  return linkedAccount(database, sourceKind, accountKey, `${label} — ${name}`, type);
}

export function resolveEventRole(database, role, key, event = {}) {
  switch (role) {
    case ROLES.CASH:
      return operationalAccount(database, key || event.accountId);

    case ROLES.INCOME_CATEGORY:
      return linkedAccount(database, 'income-category', key || 'سایر درآمدها', key || 'سایر درآمدها', 'income');

    case ROLES.EXPENSE_CATEGORY:
      return linkedAccount(database, 'expense-category', key || 'سایر هزینه‌ها', key || 'سایر هزینه‌ها', 'expense');

    case ROLES.RECEIVABLE:
      return counterpartyRoleAccount(database, 'customer-receivable', event, key || 'مشتری متفرقه', 'حساب دریافتنی', 'asset');

    case ROLES.PAYABLE:
      return counterpartyRoleAccount(database, 'vendor-payable', event, key || 'تأمین‌کننده متفرقه', 'حساب پرداختنی', 'liability');

    // چک حساب جدا دارد تا در تراز از مطالبات عادی قابل تفکیک باشد.
    case ROLES.CHEQUE_RECEIVABLE:
      return counterpartyRoleAccount(database, 'cheque-receivable', event, key || 'متفرقه', 'اسناد دریافتنی', 'asset');

    case ROLES.CHEQUE_PAYABLE:
      return counterpartyRoleAccount(database, 'cheque-payable', event, key || 'متفرقه', 'اسناد پرداختنی', 'liability');

    // پیش‌پرداخت به تفکیک دسته، نه یک حساب یک‌کاسه: «پیش‌پرداخت بیمه» و
    // «پیش‌پرداخت اجاره» دو ماندهٔ جدا دارند و حسابدار باید بتواند هرکدام را
    // مستقل ببیند و تخصیصشان را دنبال کند.
    case ROLES.PREPAID_ASSET:
      return linkedAccount(database, 'prepaid-asset', key || 'عمومی', `پیش‌پرداخت — ${key || 'عمومی'}`, 'asset');

    // پیش‌دریافت و درآمد انتقالی هر دو بدهی‌اند و به تفکیک طرف حساب نگه
    // داشته می‌شوند: ماندهٔ هر مشتری باید مستقل دیده شود.
    case ROLES.CUSTOMER_ADVANCE:
      return counterpartyRoleAccount(database, 'customer-advance', event, key || 'مشتری متفرقه', 'پیش‌دریافت از مشتری', 'liability');

    case ROLES.DEFERRED_REVENUE:
      return counterpartyRoleAccount(database, 'deferred-revenue', event, key || 'مشتری متفرقه', 'درآمد انتقالی', 'liability');

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

    // همان حساب‌های فاکتور و تسویهٔ دوره. ساختنشان با `linkedAccount` این فایل
    // نامشان را متفاوت می‌کرد و `vatBalances` هر دو را با کلید سیستمی پیدا
    // می‌کند؛ یک منبع، یک نام.
    case ROLES.VAT_OUTPUT:
      return outputTaxLedgerAccount(database);

    case ROLES.VAT_INPUT:
      return inputTaxLedgerAccount(database);

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
  ROLES.RECEIVABLE, ROLES.PAYABLE, ROLES.CHEQUE_RECEIVABLE, ROLES.CHEQUE_PAYABLE, ROLES.CUSTOMER_ADVANCE, ROLES.DEFERRED_REVENUE,
]);

export function resolveEventAnalytic(database, role, event = {}, key = '') {
  if (!COUNTERPARTY_ROLES.has(role)) return null;
  const contactId = String(event.counterpartyId || '').trim();
  // کلید از شناسهٔ شخص می‌آید نه از نامش، تا تغییر نام تفصیلی تازه‌ای نسازد.
  if (contactId) return analyticForContact(database, contactId, String(event.counterparty || '').trim() || 'طرف حساب')?.id || null;
  // شخص ثبت‌نشده: همان کلیدی که حساب اختصاصی با آن ساخته شد.
  return counterpartyAnalyticForKey(database, key || event.counterparty);
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
