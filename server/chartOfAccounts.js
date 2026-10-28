// فاز ۲ — کدینگ استاندارد، تفصیلی شناور و مرکز هزینه.
//
// حساب‌یار تا پیش از این کد حساب را خودش می‌ساخت
// (server/accounting/ledgerAccounts.js:nextCode). هیچ دفتر حسابداری کدینگ خودش را
// رها نمی‌کند، پس از این پس کدینگ دفتر وارد می‌شود و حساب‌های داخلی حساب‌یار فقط به
// آن «نگاشت» می‌شوند. کد داخلی حذف نمی‌شود تا اسناد قبلی و ارجاع‌هایشان دست‌نخورده بمانند.
//
// پیاده‌سازی در server/chartOfAccounts/ است. این فایل همان نام‌هایی را بیرون می‌دهد که پیش‌تر
// داشت، تا هیچ‌یک از فراخوان‌ها عوض نشود. فایل‌های آن پوشه هرگز از این فایل نمی‌خوانند.

export {
  CHART_LEVELS, CHART_TYPES, CHART_ROLES, ANALYTIC_KINDS, TOPIC_SOURCE_KIND, normalizeTopicLabel,
  topicLabelKey, meaningfulTopicLabel, normalizeChartCode, chartCodeIsValid, ensureChartSchema,
  backfillLevelCodes, listChartAccounts,
} from './chartOfAccounts/base.js';
export {
  parseChartCsv,
} from './chartOfAccounts/csvFile.js';
export {
  normalizeChartLevel, normalizeChartType, CHART_CODING_STYLES, normalizeCodingStyle,
  validateChartRows,
} from './chartOfAccounts/validation.js';
export {
  DEFAULT_CHART_TEMPLATE,
} from './chartOfAccounts/defaultTemplate.js';
export {
  suggestChartAccount, mapLedgerAccountToChart, bulkMapLedgerAccounts, chartMappingOverview,
  applySuggestedChartMappings,
} from './chartOfAccounts/ledgerMapping.js';
export {
  chartAccountByCode, importChartOfAccounts, ensureOpeningEquityMapping, ensureTaxPenaltyTemplate, ensureRetainedEarningsTemplate,
  ensurePettyCashChartRole, installDefaultChartTemplate, saveChartAccount,
} from './chartOfAccounts/chartStore.js';
export {
  topicAnalytic, costCenterForTopic, saveAnalyticAccount, counterpartyAnalyticForKey, analyticForContact,
  listAnalyticAccounts, saveCostCenter, listCostCenters, resolveLineDimensions, dimensionBalance,
} from './chartOfAccounts/dimensions.js';
