import { DEFAULT_CHART_TEMPLATE, applySuggestedChartMappings, chartMappingOverview, dimensionBalance, importChartOfAccounts, installDefaultChartTemplate, listAnalyticAccounts, listChartAccounts, listCostCenters, mapLedgerAccountToChart, parseChartCsv, saveAnalyticAccount, saveChartAccount, saveCostCenter } from '../chartOfAccounts.js';
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
    { name: 'کدینگ', rows: [['کد', 'نام', 'سطح', 'کد والد', 'نوع', 'نقش'], ['1', 'دارایی‌های جاری', 'گروه', '', 'دارایی', ''], ['11', 'موجودی نقد و بانک', 'کل', '1', 'دارایی', ''], ['1101', 'صندوق', 'معین', '11', 'دارایی', 'cash']] },
    { name: 'تفصیلی', rows: [['کد', 'نام', 'نوع'], ['1001', 'شرکت آبان', 'مشتری'], ['1002', 'پروژهٔ برج', 'پروژه']] },
    { name: 'مانده افتتاحیه', rows: [['کد حساب', 'نام حساب', 'بدهکار', 'بستانکار', 'کد تفصیلی'], ['1101', 'صندوق', 5_000_000, '', ''], ['5101', 'سرمایه', '', 5_000_000, '']] },
    { name: 'راهنما', rows: [['هر شیت را جداگانه بارگذاری کن.'], ['سطح: گروه / کل / معین'], ['نوع: دارایی / بدهی / سرمایه / درآمد / هزینه'], ['کد فرزند باید با کد والد شروع شود.'], ['واحد مبلغ ماندهٔ افتتاحیه را هنگام بارگذاری صریح انتخاب کن.']] },
  ]);
}

export function dimensionReport(query = {}) {
  return dimensionBalance(activeWorkspaceDatabase(), {
    dimension: query.dimension === 'analytic' ? 'analytic' : 'costCenter',
    from: query.from || '', to: query.to || '',
  });
}
