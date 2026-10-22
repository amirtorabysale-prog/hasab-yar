// نگاشت حساب‌های داخلی حساب‌یار به کدینگ دفتر: پیشنهاد، نگاشت تکی و گروهی، و نمای کلی.
//
// از server/chartOfAccounts.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// chartOfAccounts همه از همان server/chartOfAccounts.js می‌خوانند.

import { isTaxPenaltyCategory } from '../../shared/reviewTaxPenalty.js';
import { chartCodeForCategory, legacyChartCodeForCategory } from '../../shared/categoryRules.js';
import { normalizePersian } from '../../shared/normalize.js';
import { CHART_TYPES, chartError, normalizeChartCode, ensureChartSchema, listChartAccounts } from './base.js';

// ---------------------------------------------------------------------------
// نگاشت حساب‌های داخلی حساب‌یار به کدینگ دفتر
// ---------------------------------------------------------------------------

// حساب داخلی حساب‌یار از روی منبعش شناخته می‌شود؛ این جدول می‌گوید هر منبع
// طبیعتاً به کدام نقش کدینگ می‌نشیند. پیشنهاد است، نه تصمیم قطعی.
const ROLE_BY_SOURCE_KIND = {
  'customer-receivable': ['receivable'],
  'vendor-payable': ['payable'],
  'inventory-product': ['inventory'],
  // موجودی‌ای که هنوز به کارت کالا تفکیک نشده؛ همان معین موجودی کالا.
  'inventory-unsplit': ['inventory'],
  'cogs-product': ['cogs'],
  'income-category': ['sales', 'service-income', 'other-income'],
  'expense-category': ['operating-expense'],
  'payroll-salary-expense': ['salary-expense', 'operating-expense'],
  'payroll-insurance-expense': ['employer-insurance-expense', 'operating-expense'],
  'payroll-salary-payable': ['salary-payable', 'payable'],
  'payroll-insurance-payable': ['insurance-payable', 'payable'],
  'payroll-tax-payable': ['payroll-tax-payable', 'payable'],
  'cheque-receivable': ['note-receivable', 'receivable'],
  'cheque-payable': ['note-payable', 'payable'],
  'operational-account': ['cash', 'bank'],
  // هر دارایی ثابت حساب دفترکل خودش را می‌گیرد؛ همه به همان معین اموال نگاشته می‌شوند.
  'fixed-asset': ['fixed-asset'],
  'accumulated-depreciation': ['accumulated-depreciation'],
  'prepaid-asset': ['prepaid-asset'],
  // دفتری که کدینگش پیش از این معین نصب شده، مساعده را زیر دریافتنی‌ها می‌بیند.
  'employee-advance': ['employee-advance', 'receivable'],
  'customer-advance': ['customer-advance'],
  'deferred-revenue': ['deferred-revenue'],
  'unidentified-receipt': ['unidentified-receipt'],
  'tax-receivable': ['tax-receivable'],
};

const ROLE_BY_SOURCE_KEY = {
  'output-tax': 'output-tax',
  'input-tax': 'input-tax',
  'opening-equity': 'equity',
  'owner-capital': 'owner-capital',
  // برداشت مالک زیر همان معین سرمایه می‌نشیند و ماهیت بدهکارش آن را کم می‌کند.
  'owner-drawing': 'owner-capital',
  'inventory-gain': 'inventory-gain',
  'inventory-shrinkage': 'inventory-shrinkage',
  'depreciation-expense': 'depreciation-expense',
};

/**
 * برای یک حساب داخلی، مناسب‌ترین معین کدینگ را پیشنهاد می‌دهد.
 * اگر نقش دقیق پیدا نشود، اولین معین هم‌نوع پیشنهاد می‌شود و اگر آن هم نبود null.
 */
/**
 * واژه‌هایی که در نام حساب معنا اضافه نمی‌کنند.
 *
 * «هزینهٔ اجارهٔ محل» و «اجاره» یک چیزند؛ بدون کنار گذاشتن این واژه‌ها هر دو
 * نام تقریباً بی‌شباهت شمرده می‌شوند.
 */
const NAME_NOISE = new Set(['هزینه', 'هزینه‌های', 'هزینههای', 'حساب', 'حسابهای', 'حساب‌های', 'درآمد', 'درآمدها',
  'و', 'از', 'بابت', 'محل', 'مصرفی', 'جاری', 'سایر', 'تجاری', 'متفرقه', 'دریافتنی', 'پرداختنی', 'ها', 'های']);

function nameTokens(value) {
  return normalizePersian(String(value || ''))
    .replace(/[()\[\]{}«»"'،,؛;:.\-_/]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !NAME_NOISE.has(token));
}

/**
 * هم‌پوشانی نام حساب داخلی با نام معین دفتر.
 *
 * نسبت واژه‌های مشترک به نام کوتاه‌تر: «ملزومات اداری» و «هزینه ملزومات و نوشت
 * افزار» یک واژهٔ مشترک از دو واژه دارند، و همان کافی است.
 */
function nameScore(first, second) {
  const left = new Set(nameTokens(first));
  const right = new Set(nameTokens(second));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/**
 * بهترین معین هم‌نام، فقط وقتی یکی و آشکار باشد.
 *
 * دو معین با امتیاز برابر یعنی نام‌ها روشن نیستند؛ انتخاب یکی از آن دو سکه
 * انداختن است و جای آن اینجا نیست.
 */
function bestNameMatch(ledgerAccount, postable, threshold = 0.5) {
  const scored = postable
    .map((item) => ({ item, score: nameScore(ledgerAccount.name || ledgerAccount.sourceKey, item.name) }))
    .filter((entry) => entry.score >= threshold)
    .sort((first, second) => second.score - first.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;
  return scored[0].item;
}

export function suggestChartAccount(ledgerAccount, chartAccounts = [], { specific = true, confidentOnly = false } = {}) {
  // معینِ هم‌نوع، وگرنه اصلاً پیشنهاد نکن.
  //
  // کدهای دستهٔ هزینه و درآمد (`chartCodeForCategory`) از کدینگ پیشنهادی خودِ
  // حساب‌یار می‌آیند. وقتی دفتر کدینگ خودش را وارد می‌کند، همان کد معنای دیگری
  // دارد: «۱۳۰۱» در کدینگ ما «موجودی کالا» است و در کدینگ یک دفتر واقعی
  // «اسناد دریافتنی». پیشنهادِ بی‌توجه به نوع، یا نگاشت را با خطا می‌شکست یا
  // بدتر، هزینه را روی یک دارایی می‌نشاند.
  const sameType = (item) => !ledgerAccount.type || item.type === ledgerAccount.type;
  const postable = chartAccounts.filter((item) => item.postable !== false && item.level === 'subsidiary'
    && item.active !== false && sameType(item));
  const byRole = (role) => postable.find((item) => item.role === role) || null;

  const sourceKey = ledgerAccount.sourceKey || ledgerAccount.source_key;
  const keyRole = ROLE_BY_SOURCE_KEY[sourceKey];
  if (keyRole) {
    const matches=postable.filter(item=>item.role===keyRole);
    if(sourceKey==='opening-equity') return matches.length===1?matches[0]:null;
    return byRole(keyRole);
  }

  const sourceKind = ledgerAccount.sourceKind || ledgerAccount.source_kind;
  if(['partner-payable','partner-receivable','refundable-deposit','loan-payable'].includes(sourceKind)) return byRole(sourceKind);
  // نقشِ `operating-expense` را فقط یک معین دارد (۸۱۰۹ سایر هزینه‌های عملیاتی)،
  // پس هر دستهٔ هزینه‌ای — اجاره، حمل‌ونقل، قبوض — همان‌جا می‌نشست و در پارسیان
  // همه‌چیز در یک حساب کلی جمع می‌شد. حساب دستهٔ دفتر، `source_key` برابر نام
  // دسته دارد، پس کد اختصاصی همان دسته از قبل معلوم است.
  //
  // `specific: false` عمداً همان پیشنهادِ عمومیِ قبلی را برمی‌گرداند تا بشود
  // تشخیص داد یک نگاشت موجود، خودکارِ عمومی بوده یا انتخاب آگاهانهٔ حسابدار.
  if (['income-category', 'expense-category'].includes(sourceKind)) {
    if(sourceKind==='expense-category' && isTaxPenaltyCategory(sourceKey || ledgerAccount.name)) {
      const matches=postable.filter(item=>item.role==='tax-penalty-expense' || isTaxPenaltyCategory(item.name));
      return matches.length===1?matches[0]:null;
    }
    const code = specific ? chartCodeForCategory(sourceKey) : null;
    const exact = code ? postable.find((item) => normalizeChartCode(item.code) === code) : null;
    if (exact) return exact;
    // کدینگ پیش از تفکیک معین‌های هزینه: کد تازه را ندارد، کد عمومی قبلی را دارد.
    const legacy = specific ? legacyChartCodeForCategory(sourceKey) : null;
    const legacyExact = legacy && !postable.some((item) => normalizeChartCode(item.code) === code)
      ? postable.find((item) => normalizeChartCode(item.code) === legacy) : null;
    if (legacyExact) return legacyExact;
    // کد دسته‌ها از کدینگ پیشنهادی خودمان می‌آید و در کدینگ دفتر معنای دیگری
    // دارد. وقتی کد نخورد، نام تنها نشانهٔ قابل اتکاست: «حقوق و دستمزد» به
    // «هزینه حقوق و دستمزد» می‌خورد، نه به اولین معین هزینه‌ای فهرست.
    if (specific) {
      const byName = bestNameMatch(ledgerAccount, postable);
      if (byName) return byName;
    }
    // نقشِ `operating-expense` یک سطل عمومی است، نه نگاشت. برای پیشنهاد به
    // کاربر قابل قبول است، ولی نگاشت خودکارِ بی‌صدا با آن یعنی هر دستهٔ تازه
    // در «سایر هزینه‌ها» دفن می‌شود و هیچ‌وقت به چشم حسابدار نمی‌آید.
    if (confidentOnly) return null;
  }
  if (sourceKind === 'operational-account') {
    const name = String(ledgerAccount.name || '');
    // تنخواه زیر معین «تنخواه‌گردان» می‌نشیند. کدینگی که نقش ندارد ولی معینی
    // به این نام دارد — کدینگ‌های واقعی دفترها تقریباً همیشه دارند — همان را
    // می‌گیرد؛ و اگر هیچ‌کدام نبود، بی‌نگاشت می‌ماند. نشاندنِ بی‌صدای تنخواه روی
    // صندوق یعنی ماندهٔ صندوق در پارسیان با شمارش صندوق نمی‌خواند.
    if (ledgerAccount.operationalKind === 'petty' || /تنخواه/.test(name)) {
      const named = postable.filter((item) => /تنخواه/.test(item.name));
      return byRole('petty-cash') || (named.length === 1 ? named[0] : null);
    }
    const wantsBank = ledgerAccount.operationalKind === 'bank' || Boolean(ledgerAccount.bankId) || /بانک|کارت|شبا|حساب جاری/.test(name);
    return byRole(wantsBank ? 'bank' : 'cash');
  }
  for (const role of ROLE_BY_SOURCE_KIND[sourceKind] || []) {
    const match = byRole(role);
    if (match) return match;
  }
  // نام، آخرین نشانهٔ واقعی است.
  const byName = bestNameMatch(ledgerAccount, postable);
  if (byName) return byName;
  // و اگر نامی هم نخورد، هیچ پیشنهادی داده نمی‌شود.
  //
  // پیش از این «اولین معین هم‌نوع» برگردانده می‌شد. روی کدینگ یک دفتر واقعی،
  // همهٔ دسته‌های هزینه — حقوق، اجاره، قبوض، حمل — روی معین شمارهٔ یکِ کل
  // هزینه‌ها نشستند («بازاریاب») و در پارسیان همه‌چیز در یک حساب بی‌ربط جمع شد.
  // حساب بدون نگاشت در فهرست «بدون نگاشت» دیده می‌شود و حسابدار خودش
  // انتخاب می‌کند؛ این بسیار بهتر از نگاشت خاموشِ غلط است.
  return null;
}

export function mapLedgerAccountToChart(database, ledgerAccountId, chartAccountId) {
  ensureChartSchema(database);
  const ledger = database.prepare('SELECT id,type,name FROM ledger_accounts WHERE id=?').get(String(ledgerAccountId || ''));
  if (!ledger) throw chartError('حساب دفتر کل پیدا نشد.', 'LEDGER_ACCOUNT_MISSING', 404);
  if (!chartAccountId) {
    database.prepare('UPDATE ledger_accounts SET chart_account_id=NULL WHERE id=?').run(ledger.id);
    return { ledgerAccountId: ledger.id, chartAccount: null };
  }
  const chart = database.prepare('SELECT * FROM chart_accounts WHERE id=? OR code=?').get(String(chartAccountId), normalizeChartCode(chartAccountId));
  if (!chart) throw chartError('حساب کدینگ پیدا نشد.', 'CHART_ACCOUNT_MISSING', 404);
  if (chart.level !== 'subsidiary') throw chartError('فقط حساب معین قابل نگاشت است؛ گروه و کل سند نمی‌پذیرند.', 'CHART_NOT_POSTABLE');
  if (!chart.active) throw chartError('حساب کدینگ غیرفعال است.', 'CHART_ACCOUNT_INACTIVE');
  if (chart.type !== ledger.type) throw chartError(`نوع حساب «${ledger.name}» با معین ${chart.code} یکی نیست.`, 'CHART_TYPE_MISMATCH');
  database.prepare('UPDATE ledger_accounts SET chart_account_id=? WHERE id=?').run(chart.id, ledger.id);
  return { ledgerAccountId: ledger.id, chartAccount: chart };
}

/**
 * وضعیت نگاشت: چه چیزی نگاشت شده، چه چیزی نشده و برای نشده‌ها چه پیشنهادی هست.
 * این خروجی هم صفحهٔ کدینگ را می‌سازد و هم دروازهٔ آمادگی خروجی را تغذیه می‌کند.
 */
/**
 * نگاشت چند حساب به یک معین، در یک تصمیم.
 *
 * دفتری با ده‌ها دستهٔ هزینه، ده‌ها بار کشیدن فهرست کشویی را تحمل نمی‌کند؛ و
 * حساب‌یار هم دیگر «اولین معین هم‌نوع» را حدس نمی‌زند. پس انتخاب یک‌بارهٔ
 * معین برای یک گروه حساب، همان چیزی است که کار دستی را کوتاه می‌کند بی‌آنکه
 * تصمیم از دست حسابدار در برود.
 *
 * حساب‌هایی که با نوع معین نمی‌خوانند رد می‌شوند، ولی بقیه انجام می‌شوند: یک
 * ردیف ناسازگار نباید کل اقدام را برگرداند.
 */
export function bulkMapLedgerAccounts(database, ledgerAccountIds = [], chartAccountId = null) {
  ensureChartSchema(database);
  const ids = [...new Set((Array.isArray(ledgerAccountIds) ? ledgerAccountIds : []).map((item) => String(item || '')).filter(Boolean))];
  if (!ids.length) throw chartError('هیچ حسابی برای نگاشت انتخاب نشده است.', 'LEDGER_ACCOUNTS_EMPTY');
  const skipped = [];
  let mapped = 0;
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const id of ids) {
      try { mapLedgerAccountToChart(database, id, chartAccountId); mapped += 1; }
      catch (error) {
        if (!['CHART_TYPE_MISMATCH', 'LEDGER_ACCOUNT_MISSING'].includes(error.code)) throw error;
        skipped.push({ ledgerAccountId: id, message: error.message });
      }
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return { mapped, skipped };
}

export function chartMappingOverview(database) {
  ensureChartSchema(database);
  const chartAccounts = listChartAccounts(database);
  const ledgerAccounts = database.prepare(`SELECT ledger_accounts.id,ledger_accounts.code,ledger_accounts.name,ledger_accounts.type,
    ledger_accounts.source_kind AS sourceKind,ledger_accounts.source_key AS sourceKey,ledger_accounts.active,
    ledger_accounts.chart_account_id AS chartAccountId,
    chart_accounts.code AS chartCode,chart_accounts.name AS chartName
    FROM ledger_accounts LEFT JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    WHERE ledger_accounts.active=1 ORDER BY CAST(ledger_accounts.code AS INTEGER)`).all();

  const items = ledgerAccounts.map((account) => {
    const suggestion = account.chartAccountId ? null : suggestChartAccount(account, chartAccounts);
    return {
      ...account,
      mapped: Boolean(account.chartAccountId),
      typeLabel: CHART_TYPES[account.type]?.label || account.type,
      suggestion: suggestion ? { id: suggestion.id, code: suggestion.code, name: suggestion.name } : null,
    };
  });
  const unmapped = items.filter((item) => !item.mapped);
  // حسابی که هیچ سندی نخورده، جلوی خروجی را نمی‌گیرد. تفاوت این دو عدد مهم
  // است: کنترل آمادگی فقط حساب‌های استفاده‌شده را می‌بیند، ولی فهرست نگاشت
  // همه را نشان می‌دهد — و گفتن «تا رفع نشود خروجی ساخته نمی‌شود» دربارهٔ
  // حسابی که اصلاً استفاده نشده، دروغ است.
  const usedAccounts = new Set(database.prepare('SELECT DISTINCT account_id AS id FROM journal_lines').all().map((row) => row.id));
  const usedUnmapped = unmapped.filter((item) => usedAccounts.has(item.id));
  return {
    chartInstalled: chartAccounts.length > 0,
    chartAccountCount: chartAccounts.length,
    postableCount: chartAccounts.filter((item) => item.postable).length,
    items,
    mappedCount: items.length - unmapped.length,
    unmappedCount: unmapped.length,
    usedUnmappedCount: usedUnmapped.length,
    // کدینگ وقتی «کامل» است که هیچ حساب استفاده‌شده‌ای بدون معین نمانده
    // باشد. حسابی که سندی نخورده، چیزی را خراب نمی‌کند.
    complete: chartAccounts.length > 0 && usedUnmapped.length === 0,
    suggestionsAvailable: unmapped.filter((item) => item.suggestion).length,
  };
}

/**
 * `refine` نگاشت‌های موجودی را هم اصلاح می‌کند که پیش از شناختن معین اختصاصیِ
 * دسته‌ها ساخته شده‌اند — مثلاً «اجاره» که روی ۸۱۰۹ سایر هزینه‌ها نشسته بود.
 *
 * انتخاب آگاهانهٔ حسابدار بازنویسی نمی‌شود. چون جدول نگاشت ستون منشأ ندارد،
 * ملاک این است: فقط نگاشتی جابه‌جا می‌شود که **دقیقاً** همان پیشنهاد عمومیِ
 * قبلی باشد. هر کد دیگری یعنی کسی آگاهانه انتخابش کرده و دست‌نخورده می‌ماند.
 */
export function applySuggestedChartMappings(database, { refine = false } = {}) {
  const overview = chartMappingOverview(database);
  if (!overview.chartInstalled) throw chartError('ابتدا کدینگ را وارد کن یا کدینگ پیش‌فرض را نصب کن.', 'CHART_NOT_INSTALLED');
  const chartAccounts = listChartAccounts(database);
  let applied = 0;
  let refined = 0;
  for (const item of overview.items) {
    if (!item.mapped) {
      if (!item.suggestion) continue;
      // یک پیشنهاد نامناسب نباید بقیهٔ نگاشت‌ها را هم زمین بزند؛ همان یکی
      // نگاشت‌نشده می‌ماند و در فهرست «بدون نگاشت» به چشم حسابدار می‌آید.
      try { mapLedgerAccountToChart(database, item.id, item.suggestion.id); applied += 1; }
      catch (error) { if (error.code !== 'CHART_TYPE_MISMATCH') throw error; }
      continue;
    }
    if (!refine) continue;
    const specific = suggestChartAccount(item, chartAccounts);
    const generic = suggestChartAccount(item, chartAccounts, { specific: false });
    const current = normalizeChartCode(item.chartCode);
    if (!specific || !generic) continue;
    if (normalizeChartCode(specific.code) === current) continue;
    if (normalizeChartCode(generic.code) !== current) continue;
    mapLedgerAccountToChart(database, item.id, specific.id);
    refined += 1;
  }
  return { applied, refined, ...chartMappingOverview(database) };
}
