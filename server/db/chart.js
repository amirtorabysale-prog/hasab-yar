import { DEFAULT_CHART_TEMPLATE, applySuggestedChartMappings, bulkMapLedgerAccounts, chartMappingOverview, dimensionBalance, importChartOfAccounts, installDefaultChartTemplate, listAnalyticAccounts, listChartAccounts, listCostCenters, mapLedgerAccountToChart, parseChartCsv, saveAnalyticAccount, saveChartAccount, saveCostCenter } from '../chartOfAccounts.js';
import { activeWorkspaceDatabase, audit, currentTimeZone, currentWorkspace } from './core.js';
import { analyticRowsFromFile, chartRowsFromFile, openingRowsFromFile } from '../spreadsheetImport.js';
import { buildWorkbook } from '../spreadsheet.js';
import { importAnalyticRows, ledgerAccountForChart, prepareOpeningBalanceRows } from '../ledgerImport.js';
import { nextLedgerCode, postImportedOpeningBalances } from '../accounting.js';
import { normalizeAmountUnit } from '../transferTemplates.js';

// ---------------------------------------------------------------------------
// فاز ۲ — کدینگ دفتر، تفصیلی شناور و مرکز هزینه (روی دیتابیس دفتر فعال)
// ---------------------------------------------------------------------------

export function chartOverview() {
  const database = activeWorkspaceDatabase();
  return {
    accounts: listChartAccounts(database, { includeInactive: true }),
    mapping: chartMappingOverview(database),
    analytics: listAnalyticAccounts(database, { includeInactive: true }),
    costCenters: listCostCenters(database, { includeInactive: true }),
    template: { accountCount: DEFAULT_CHART_TEMPLATE.length },
  };
}

export function importChart(csvText, { replace = false } = {}) {
  const { rows } = parseChartCsv(csvText);
  const result = importChartOfAccounts(activeWorkspaceDatabase(), rows, { source: 'import', replace });
  audit('import', 'chart_of_accounts', 'chart', result);
  return { ...result, ...chartOverview() };
}

export function installChartTemplate() {
  const result = installDefaultChartTemplate(activeWorkspaceDatabase());
  audit('install-template', 'chart_of_accounts', 'chart', result);
  return { ...result, ...chartOverview() };
}

export function saveChartAccountEntry(values = {}) {
  const item = saveChartAccount(activeWorkspaceDatabase(), values);
  audit('save', 'chart_account', item.id, { code: item.code, name: item.name, level: item.level });
  return item;
}

export function mapLedgerAccount(ledgerAccountId, chartAccountId) {
  const result = mapLedgerAccountToChart(activeWorkspaceDatabase(), ledgerAccountId, chartAccountId);
  audit('map', 'ledger_account', ledgerAccountId, { chartCode: result.chartAccount?.code || null });
  return { ...result, mapping: chartMappingOverview(activeWorkspaceDatabase()) };
}

export function mapLedgerAccountsInBulk(ledgerAccountIds = [], chartAccountId = null) {
  const database = activeWorkspaceDatabase();
  const result = bulkMapLedgerAccounts(database, ledgerAccountIds, chartAccountId);
  audit('map-bulk', 'chart_of_accounts', 'chart', { mapped: result.mapped, skipped: result.skipped.length, chartAccountId });
  return { ...result, mapping: chartMappingOverview(database) };
}

/**
 * برداشتن همهٔ نگاشت‌های کدینگ.
 *
 * جایگزینی کدینگ فقط وقتی مجاز است که هیچ حساب داخلی به آن وصل نباشد، وگرنه
 * اسناد قبلی به کدی اشاره می‌کنند که دیگر وجود ندارد. تا پیش از این راهی جز
 * برداشتن تک‌تکِ نگاشت‌ها نبود و دفتری با ده‌ها حساب عملاً نمی‌توانست کدینگ
 * پیشنهادی را با کدینگ خودش عوض کند.
 *
 * سند و ثبتی پاک نمی‌شود؛ فقط پیوند حساب داخلی به کدینگ برداشته می‌شود و پس از
 * ورود کدینگ تازه دوباره بسته می‌شود.
 */
export function clearChartMappings() {
  const database = activeWorkspaceDatabase();
  const cleared = database.prepare('UPDATE ledger_accounts SET chart_account_id=NULL WHERE chart_account_id IS NOT NULL').run().changes;
  if (cleared) audit('clear', 'chart_mappings', 'chart', { cleared });
  return { cleared, ...chartMappingOverview(database) };
}

export function applyChartSuggestions({ refine = false } = {}) {
  const result = applySuggestedChartMappings(activeWorkspaceDatabase(), { refine });
  audit('map-suggested', 'chart_of_accounts', 'chart', { applied: result.applied, refined: result.refined });
  return result;
}

export function saveAnalytic(values = {}) {
  const item = saveAnalyticAccount(activeWorkspaceDatabase(), values);
  audit('save', 'analytic_account', item.id, { code: item.code, name: item.name });
  return item;
}

export function saveCostCenterEntry(values = {}) {
  const item = saveCostCenter(activeWorkspaceDatabase(), values);
  audit('save', 'cost_center', item.id, { code: item.code, name: item.name });
  return item;
}

// ---------------------------------------------------------------------------
// ورود داده از اکسل و پارسیان
// ---------------------------------------------------------------------------

/** ورود کدینگ از اکسل یا CSV — همان قواعد اعتبارسنجی فاز کدینگ. */
export function importChartFile(buffer, fileName = '', { replace = false } = {}) {
  const rows = chartRowsFromFile(buffer, fileName);
  const result = importChartOfAccounts(activeWorkspaceDatabase(), rows, { source: 'import', replace });
  audit('import', 'chart_of_accounts', 'chart', { ...result, fileName });
  return { ...result, ...chartOverview() };
}

/** ورود تفصیلی و طرف حساب از اکسل یا CSV. */
export function importAnalyticsFile(buffer, fileName = '') {
  const rows = analyticRowsFromFile(buffer, fileName);
  const result = importAnalyticRows(activeWorkspaceDatabase(), rows);
  audit('import', 'analytic_accounts', 'analytics', { ...result, fileName });
  return { ...result, ...chartOverview() };
}

/**
 * ورود ماندهٔ افتتاحیه از تراز نرم‌افزار مقصد و ساخت یک سند افتتاحیهٔ متوازن.
 * واحد مبلغ اجباری است؛ حدس‌زدن تومان/ریال یعنی خطای ده‌برابری.
 */
export function importOpeningBalanceFile(buffer, fileName = '', { amountUnit = 'toman', replace = false, occurredAt = '' } = {}) {
  const database = activeWorkspaceDatabase();
  const rows = openingRowsFromFile(buffer, fileName);
  const prepared = prepareOpeningBalanceRows(database, rows, { amountUnit: normalizeAmountUnit(amountUnit) === 'rial' ? 'rial' : 'toman' });

  database.exec('BEGIN IMMEDIATE');
  try {
    const lines = prepared.rows.map((item) => ({
      ...item, ledgerAccountId: ledgerAccountForChart(database, item.chart, (type) => nextLedgerCode(database, type)),
    }));
    const posted = postImportedOpeningBalances(database, lines, {
      occurredAt: occurredAt || new Date().toISOString(),
      createdBy: currentWorkspace()?.userId || null,
      timeZone: currentTimeZone(),
      replace,
    });
    database.exec('COMMIT');
    audit('import', 'opening_balance', posted.id, {
      fileName, amountUnit: prepared.amountUnit, lineCount: posted.lineCount,
      debitTotal: prepared.debitTotal, replacedEntryId: posted.replacedEntryId,
    });
    return {
      entryId: posted.id, lineCount: posted.lineCount, replacedEntryId: posted.replacedEntryId,
      debitTotal: prepared.debitTotal, creditTotal: prepared.creditTotal, amountUnit: prepared.amountUnit,
      mapping: chartMappingOverview(database),
    };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

/** الگوهای خالی اکسل تا حسابدار بداند دقیقاً چه ستون‌هایی لازم است. */
export function importTemplateWorkbook() {
  return buildWorkbook([
    { name: 'کدینگ', rows: [['کد', 'نام', 'سطح', 'کد والد', 'نوع', 'کد سطح', 'نقش', 'تفصیلی اجباری'], ['1', 'دارایی‌های جاری', 'گروه', '', 'دارایی', '1', '', ''], ['11', 'موجودی نقد و بانک', 'کل', '1', 'دارایی', '1', '', ''], ['1101', 'صندوق', 'معین', '11', 'دارایی', '01', 'cash', 'خیر'], ['12', 'حساب‌های دریافتنی', 'کل', '1', 'دارایی', '2', '', ''], ['1201', 'بدهکاران تجاری', 'معین', '12', 'دارایی', '01', 'receivable', 'بله']] },
    { name: 'تفصیلی', rows: [['کد', 'نام', 'نوع', 'کد مقصد'], ['1001', 'شرکت آبان', 'مشتری', '1001'], ['1002', 'پروژهٔ برج', 'پروژه', '1002']] },
    { name: 'مانده افتتاحیه', rows: [['کد حساب', 'نام حساب', 'بدهکار', 'بستانکار', 'کد تفصیلی'], ['1101', 'صندوق', 5_000_000, '', ''], ['5101', 'سرمایه', '', 5_000_000, '']] },
    { name: 'راهنما', rows: [['هر شیت را جداگانه بارگذاری کن.'], ['سطح: گروه / کل / معین'],
      ['نوع: دارایی / بدهی / سرمایه / درآمد / هزینه'],
      ['کد فرزند باید با کد والد شروع شود — مگر آنکه ستون «کد سطح» را خودت پر کنی.'],
      ['کد سطح: همان کدی که نرم‌افزار دفتر برای آن سطح می‌شناسد (در پارسیان کد معین سراسری نیست).'],
      ['شیت تفصیلی: «کد مقصد» همان کد تفصیلی در نرم‌افزار دفتر است. اگر خالی بماند، کد ستون اول به‌جایش می‌نشیند.'],
      ['ردیفی که کد تفصیلی نداشته باشد، در پارسیان کنار گذاشته می‌شود و سند را نامتوازن نشان می‌دهد.'],
      ['واحد مبلغ ماندهٔ افتتاحیه را هنگام بارگذاری صریح انتخاب کن.']] },
  ]);
}

export function dimensionReport(query = {}) {
  return dimensionBalance(activeWorkspaceDatabase(), {
    dimension: query.dimension === 'analytic' ? 'analytic' : 'costCenter',
    from: query.from || '', to: query.to || '',
  });
}
