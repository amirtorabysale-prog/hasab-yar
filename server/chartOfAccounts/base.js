// پایهٔ کدینگ: سطح‌ها، نوع‌ها، نقش‌ها و نوع تفصیلی، برچسب موضوعی، کد حساب، جدول‌ها و فهرست حساب‌های کدینگ.
//
// از server/chartOfAccounts.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// chartOfAccounts همه از همان server/chartOfAccounts.js می‌خوانند.

import { normalizePersian } from '../../shared/normalize.js';
import { topicParts } from '../../shared/topicParts.js';

export const CHART_LEVELS = Object.freeze({
  group: Object.freeze({ id: 'group', label: 'گروه', order: 1 }),
  general: Object.freeze({ id: 'general', label: 'کل', order: 2 }),
  subsidiary: Object.freeze({ id: 'subsidiary', label: 'معین', order: 3 }),
});

export const CHART_TYPES = Object.freeze({
  asset: Object.freeze({ id: 'asset', label: 'دارایی', normalSide: 'debit' }),
  liability: Object.freeze({ id: 'liability', label: 'بدهی', normalSide: 'credit' }),
  equity: Object.freeze({ id: 'equity', label: 'سرمایه', normalSide: 'credit' }),
  income: Object.freeze({ id: 'income', label: 'درآمد', normalSide: 'credit' }),
  expense: Object.freeze({ id: 'expense', label: 'هزینه', normalSide: 'debit' }),
});

// نقش‌ها فقط برای پیشنهاد خودکار نگاشت به کار می‌روند؛ هیچ سندی بر پایهٔ نقش ثبت نمی‌شود.
export const CHART_ROLES = Object.freeze([
  'cash', 'bank', 'receivable', 'payable', 'inventory', 'cogs',
  'sales', 'service-income', 'other-income', 'operating-expense',
  'output-tax', 'input-tax', 'equity', 'inventory-gain', 'inventory-shrinkage',
  'tax-penalty-expense', 'tax-receivable', 'partner-payable', 'partner-receivable',
  'fixed-asset', 'owner-capital', 'refundable-deposit', 'loan-payable',
  // حقوق و دستمزد سه بدهی جدا می‌سازد و هر سه به گیرندهٔ متفاوتی پرداخت
  // می‌شوند: خالص به خودِ پرسنل، بیمه به تأمین اجتماعی و مالیات به سازمان
  // امور مالیاتی. ریختنشان در یک «سایر پرداختنی» یعنی هیچ‌کدام قابل پیگیری
  // نیست و تسویهٔ هرکدام، ماندهٔ دو تای دیگر را هم دست‌کاری می‌کند.
  'salary-expense', 'employer-insurance-expense',
  'salary-payable', 'insurance-payable', 'payroll-tax-payable',
  // چک از مطالبات عادی جداست: سررسید دارد، ممکن است برگشت بخورد، و تا وصول
  // نشود پول نیست. در تراز هم باید جدا دیده شود.
  'note-receivable', 'note-payable',
  // حساب‌هایی که مسیر بررسی حسابدار می‌سازد. بدون نقش در کدینگ، سندشان متوازن
  // بود ولی در خروجی پارسیان «بدون نگاشت» می‌ماند: پیش‌پرداخت، پیش‌دریافت،
  // درآمد انتقالی، وجوه تعیین‌تکلیف‌نشده و استهلاک.
  'prepaid-asset', 'customer-advance', 'deferred-revenue', 'unidentified-receipt', 'employee-advance',
  'accumulated-depreciation', 'depreciation-expense',
  // تنخواه پولِ شرکت است که دست یک نفر است؛ نه صندوق اصلی است و نه بانک.
  'petty-cash',
  // حساب انتظامی (و طرف آن) از بکاپ پارسیان: در ترازنامه و سود و زیان نیست و هیچ
  // حساب روزمره‌ای به آن نگاشت نمی‌شود.
  'memorandum',
  // مقصد سند بستن حساب‌های موقت در پایان سال مالی.
  'retained-earnings',
]);

export const ANALYTIC_KINDS = Object.freeze({
  contact: 'طرف حساب',
  project: 'پروژه',
  employee: 'پرسنل',
  custom: 'سایر',
});

/**
 * برچسب موضوعی (طرح ترکیبی) — تفصیلیِ شناورِ «بابت چه؟»
 *
 * وقتی مدل یا حسابدار می‌گوید این هزینه «کلید برق» بود، آن «کلید برق» دستهٔ
 * جدید نمی‌شود؛ یک تفصیلی روی سطرِ دسته می‌نشیند. کدینگ دست‌نخورده می‌ماند،
 * سند همان‌جا که باید ثبت می‌شود، و موضوع در گزارش ابعاد و در فایل انتقال
 * پارسیان (ستون تفصیلی) زنده می‌ماند. اگر همان برچسب در ماه تکرار شود، موتور
 * شمارش پیشنهاد ارتقا به دسته می‌دهد — تصمیم با حسابدار است، نه با این تابع.
 *
 * کلید منشأ (`topic-label` + کلید مقایسه) همان برچسب را دوباره می‌سازد، پس یک
 * موضوع همیشه یک تفصیلی است. کلید از متن یکسان‌شدهٔ فارسی می‌آید: موضوعی که مدل
 * هر بار کمی متفاوت می‌نویسد («اجاره دفتر»، «اجارهٔ دفتر»، «اجاره‌ی دفتر») یک
 * تفصیلی است، نه سه؛ وگرنه شمارش ارتقا پخش می‌شد و پارسیان سه تفصیلی می‌گرفت.
 */
export const TOPIC_SOURCE_KIND = 'topic-label';

export function normalizeTopicLabel(value) {
  return String(value || '').replace(/[‌s]+/g, ' ').trim().slice(0, 60);
}

/** کلید مقایسهٔ برچسب: املاهای یک موضوع یک کلیدند. */
export function topicLabelKey(value) {
  // از متن خام، تا کسرهٔ «ه‌ی» پیش از تبدیل نیم‌فاصله دیده شود؛ «ه ی» برچسب‌های
  // قدیمی است که نیم‌فاصله‌شان فاصله ذخیره شده.
  return normalizePersian(String(value || '').replace(/ۀ/g, 'ه')).replace(/ه ی(?= |$)/g, 'ه').slice(0, 60);
}

/**
 * برچسبی که چیزی به دسته اضافه می‌کند. «اجاره» روی دستهٔ «اجاره» تفصیلی تازه‌ای
 * نمی‌سازد؛ فقط دسته را تکرار می‌کرد و فهرست تفصیلی‌های پارسیان را پر.
 */
//
// برچسب فقط «چه چیزی» است (`topicParts`): «قهوه»، «قهوهٔ دفتر» و «قهوه برای دفتر» یک
// تفصیلی‌اند. وقتی خودِ قلم همان دسته است («اجارهٔ دفتر» روی دستهٔ «اجاره»)، محل تنها
// چیزی است که برچسب اضافه می‌کند و می‌ماند؛ وگرنه اجارهٔ دفتر و مغازه یکی می‌شدند.
export function meaningfulTopicLabel(label, category = '') {
  const clean = normalizeTopicLabel(label);
  if (!clean) return '';
  const { item, place } = topicParts(clean);
  // چیزی جدا نشد: املای خودِ برچسب می‌ماند («اجارهٔ دفتر»).
  if (topicLabelKey(item) !== topicLabelKey(category)) return topicLabelKey(item) === topicLabelKey(clean) ? clean : normalizeTopicLabel(item);
  return place && topicLabelKey(clean) !== topicLabelKey(category) ? clean : '';
}

export function chartError(message, code = 'CHART_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

const digitMap = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9', '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };

export function latin(value) { return String(value ?? '').replace(/[۰-۹٠-٩]/g, (digit) => digitMap[digit]); }

// کد حساب فقط رقم است. جداکننده‌های رایج کدینگ (خط تیره، نقطه، فاصله) پاک می‌شوند
// تا «۱۱-۰۱» و «1101» یک حساب شناخته شوند، نه دو حساب موازی.
export function normalizeChartCode(value) {
  return latin(value).replace(/[\s._-]/g, '').trim();
}

export function chartCodeIsValid(code) {
  return /^\d{1,12}$/.test(code);
}

export function cleanName(value, limit = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function ensureColumn(database, table, definition) {
  try { database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`); }
  catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
}

export function ensureChartSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chart_accounts (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('group','general','subsidiary')),
      parent_id TEXT REFERENCES chart_accounts(id) ON DELETE RESTRICT,
      type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','income','expense')),
      normal_side TEXT NOT NULL CHECK(normal_side IN ('debit','credit')),
      role TEXT NOT NULL DEFAULT '',
      level_code TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','template','import')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_chart_accounts_parent ON chart_accounts(parent_id,code);
    CREATE INDEX IF NOT EXISTS idx_chart_accounts_role ON chart_accounts(role) WHERE role<>'';

    CREATE TABLE IF NOT EXISTS analytic_accounts (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'custom' CHECK(kind IN ('contact','project','employee','custom')),
      source_kind TEXT,
      source_key TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_kind,source_key)
    );

    CREATE TABLE IF NOT EXISTS cost_centers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES cost_centers(id) ON DELETE RESTRICT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // ابعاد روی آرتیکل سند می‌نشینند، نه روی حساب — این تعریف «شناور» بودن تفصیلی است.
  ensureColumn(database, 'journal_lines', 'analytic_id TEXT REFERENCES analytic_accounts(id) ON DELETE RESTRICT');
  // کد تفصیلی در نرم‌افزار مقصد. کد داخلی ما خودکار ساخته می‌شود و هیچ ربطی به
  // کدهای پارسیان ندارد؛ فرستادنش یعنی ردیف به شخص اشتباهی می‌چسبد — خطایی که
  // از گم‌شدن طرف حساب بدتر است.
  ensureColumn(database, 'analytic_accounts', 'external_code TEXT');
  ensureColumn(database, 'journal_lines', 'cost_center_id TEXT REFERENCES cost_centers(id) ON DELETE RESTRICT');
  ensureColumn(database, 'chart_accounts', "level_code TEXT NOT NULL DEFAULT ''");
  // معینی که در نرم‌افزار دفتر «تفصیلی اجباری» است: ردیفی که روی آن بنشیند و
  // کد تفصیلی نداشته باشد، در پارسیان پذیرفته نمی‌شود. پارسیان آن ردیف را کنار
  // می‌گذارد و طرف دیگرِ همان سند تنها می‌ماند — سند غیرموازنه دقیقاً از همین
  // جا می‌آید و هیچ پیامی هم نمی‌دهد. پس این را از قبل می‌دانیم و جلوی خروجی
  // را می‌گیریم.
  ensureColumn(database, 'chart_accounts', 'requires_analytic INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'ledger_accounts', 'chart_account_id TEXT REFERENCES chart_accounts(id) ON DELETE RESTRICT');
  backfillLevelCodes(database);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_journal_lines_analytic ON journal_lines(analytic_id) WHERE analytic_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_journal_lines_cost_center ON journal_lines(cost_center_id) WHERE cost_center_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_ledger_accounts_chart ON ledger_accounts(chart_account_id);
  `);
}

/**
 * کد سطح را برای کدینگ‌هایی که پیش از افزودن این ستون نصب شده‌اند پر می‌کند.
 *
 * ستون `level_code` با پیش‌فرض خالی اضافه شد، پس هر کدینگی که از قبل نصب بود
 * کد سطح نداشت. این تا وقتی خروجی فقط کد کامل می‌داد بی‌ضرر بود، ولی از وقتی
 * فایل انتقال پارسیان کد کل و معین را جدا می‌خواهد، خالی‌بودنش یعنی خروجی
 * ساخته نمی‌شود. قاعده همان قاعدهٔ سبک پیشوندی است: کد سطح، تفاضل کد فرزند و
 * کد والد؛ و برای ریشه، خود کد.
 */
export function backfillLevelCodes(database) {
  const rows = database.prepare(`SELECT chart_accounts.id,chart_accounts.code,parent.code AS parentCode
    FROM chart_accounts LEFT JOIN chart_accounts AS parent ON parent.id=chart_accounts.parent_id
    WHERE chart_accounts.level_code=''`).all();
  if (!rows.length) return 0;
  const update = database.prepare('UPDATE chart_accounts SET level_code=? WHERE id=?');
  let filled = 0;
  for (const row of rows) {
    const code = String(row.code || '');
    const parentCode = String(row.parentCode || '');
    const derived = parentCode && code.startsWith(parentCode) && code.length > parentCode.length
      ? code.slice(parentCode.length)
      : code;
    if (!derived) continue;
    update.run(derived, row.id);
    filled += 1;
  }
  return filled;
}

export function listChartAccounts(database, { includeInactive = false } = {}) {
  ensureChartSchema(database);
  const rows = database.prepare(`SELECT chart_accounts.id,chart_accounts.code,chart_accounts.name,chart_accounts.level,
    chart_accounts.type,chart_accounts.normal_side AS normalSide,chart_accounts.role,chart_accounts.active,chart_accounts.source,
    chart_accounts.level_code AS levelCode,chart_accounts.requires_analytic AS requiresAnalytic,
    parent.code AS parentCode,parent.name AS parentName,
    (SELECT COUNT(*) FROM ledger_accounts WHERE ledger_accounts.chart_account_id=chart_accounts.id) AS mappedAccounts
    FROM chart_accounts LEFT JOIN chart_accounts AS parent ON parent.id=chart_accounts.parent_id
    ${includeInactive ? '' : 'WHERE chart_accounts.active=1'}
    ORDER BY chart_accounts.code`).all();
  return rows.map((row) => ({
    ...row,
    active: Boolean(row.active),
    requiresAnalytic: Boolean(row.requiresAnalytic),
    levelLabel: CHART_LEVELS[row.level].label,
    typeLabel: CHART_TYPES[row.type].label,
    postable: row.level === 'subsidiary',
  }));
}
