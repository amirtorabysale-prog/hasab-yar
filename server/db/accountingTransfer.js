import { createHash, randomUUID } from 'node:crypto';
import { ACCOUNTING_TRANSFER_TARGETS, TRANSFER_FILE_FORMATS, accountingTransferReadiness, buildAccountingTransferFile, normalizeAccountingTransferTarget, normalizeTransferFileFormat } from '../accountingTransfer.js';
import { DEFAULT_TRANSFER_COLUMNS, TRANSFER_FIELDS, amountUnitLabel, normalizeAmountUnit, normalizeTransferColumns } from '../transferTemplates.js';
import { activeWorkspaceDatabase, audit, currentWorkspace, db, invalidInput, ledgerAmountUnit, parseStoredJson, userIdentity } from './core.js';
import { convertAmount } from '../../shared/amountUnit.js';
import { chartMappingOverview } from '../chartOfAccounts.js';
import { monthlyAccountantPackage } from './collaboration.js';
import { readParsianTemplate } from '../parsianAccessFile.js';
import { ensureParsianSourceSchema, ensureTransferEntriesSchema, recordTransferBatchEntries } from '../accounting.js';

export function transferFieldCatalog() {
  return { fields: TRANSFER_FIELDS, defaultColumns: DEFAULT_TRANSFER_COLUMNS, formats: Object.values(TRANSFER_FILE_FORMATS) };
}

function accountingTransferSettings(targetSystem = 'generic-csv') {
  const target = normalizeAccountingTransferTarget(targetSystem);
  const row = db.prepare(`SELECT target_system AS targetSystem,template_name AS templateName,
    template_verified AS templateVerified,note,updated_at AS updatedAt,
    file_format AS fileFormat,amount_unit AS amountUnit,columns_json AS columnsJson,
    transfer_template_name AS transferTemplateName,
    fiscal_year_start AS fiscalYearStart,fiscal_year_end AS fiscalYearEnd,
    LENGTH(transfer_template) AS transferTemplateSize
    FROM accounting_transfer_settings WHERE target_system=?`).get(target);
  const stored = parseStoredJson(row?.columnsJson, []);
  const columns = Array.isArray(stored) && stored.length ? stored : [...DEFAULT_TRANSFER_COLUMNS];
  return {
    targetSystem: target,
    templateName: row?.templateName || '',
    templateVerified: Boolean(row?.templateVerified),
    note: row?.note || '',
    updatedAt: row?.updatedAt || null,
    fileFormat: normalizeTransferFileFormat(row?.fileFormat),
    amountUnit: normalizeAmountUnit(row?.amountUnit),
    columns,
    usingDefaultColumns: !(Array.isArray(stored) && stored.length),
    // خود بلاب الگو هرگز به کلاینت نمی‌رود؛ فقط اینکه هست و چقدر است.
    hasTransferTemplate: Number(row?.transferTemplateSize || 0) > 0,
    transferTemplateName: row?.transferTemplateName || '',
    transferTemplateSize: Number(row?.transferTemplateSize || 0),
    fiscalYearStart: row?.fiscalYearStart || '',
    fiscalYearEnd: row?.fiscalYearEnd || '',
  };
}

function accountingTransferTemplate(targetSystem = 'generic-csv') {
  const row = db.prepare('SELECT transfer_template AS template FROM accounting_transfer_settings WHERE target_system=?')
    .get(normalizeAccountingTransferTarget(targetSystem));
  return row?.template ? Buffer.from(row.template) : null;
}

/**
 * الگوی فایل انتقال پارسیان را ذخیره می‌کند.
 *
 * الگو باید خروجی واقعی «انتقال اسناد به فایل» همان نصب باشد. اینجا قبل از
 * ذخیره خوانده و سنجیده می‌شود تا فایل اشتباه ماه‌ها بعد سر بزنگاه لو نرود.
 */
export function saveAccountingTransferTemplate(targetSystem, buffer, fileName = '') {
  const target = normalizeAccountingTransferTarget(targetSystem);
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!data.length) throw Object.assign(new Error('فایل الگو خالی است.'), { status: 400, code: 'TRANSFER_TEMPLATE_EMPTY' });
  if (data.length > 32 * 1024 * 1024) throw Object.assign(new Error('فایل الگو بیش از ۳۲ مگابایت است.'), { status: 413, code: 'TRANSFER_TEMPLATE_TOO_LARGE' });
  const info = readParsianTemplate(data); // خطای گویا می‌دهد اگر فایل پارسیان نباشد
  const name = String(fileName || '').trim().slice(0, 160);
  db.prepare(`INSERT INTO accounting_transfer_settings (target_system,transfer_template,transfer_template_name)
    VALUES (?,?,?) ON CONFLICT(target_system) DO UPDATE SET transfer_template=excluded.transfer_template,
    transfer_template_name=excluded.transfer_template_name,updated_at=CURRENT_TIMESTAMP`)
    .run(target, data, name);
  audit('save-transfer-template', 'accounting_transfer_settings', target, {
    fileName: name, size: data.length, existingRows: info.rowCount,
  });
  return accountingTransferSettings(target);
}

function accountingTransferMappings(targetSystem = 'generic-csv') {
  const target = normalizeAccountingTransferTarget(targetSystem);
  return db.prepare(`SELECT accounting_transfer_mappings.target_system AS targetSystem,
    accounting_transfer_mappings.ledger_account_id AS ledgerAccountId,ledger_accounts.code AS sourceCode,
    ledger_accounts.name AS sourceName,accounting_transfer_mappings.target_code AS targetCode,
    accounting_transfer_mappings.target_name AS targetName,accounting_transfer_mappings.updated_at AS updatedAt
    FROM accounting_transfer_mappings JOIN ledger_accounts ON ledger_accounts.id=accounting_transfer_mappings.ledger_account_id
    WHERE accounting_transfer_mappings.target_system=? ORDER BY ledger_accounts.code`).all(target);
}

/**
 * سندهای افتتاحیه به مقصد فرستاده نمی‌شوند.
 *
 * ماندهٔ افتتاحیه یا از تراز خودِ نرم‌افزار دفتر وارد شده («opening_import») یا
 * ماندهٔ اول دورهٔ حساب‌های حساب‌یار است. در هر دو حالت، همان مانده در پارسیان
 * از قبل هست — سند افتتاحیهٔ خودش. فرستادنش یعنی دارایی و سرمایه دو برابر
 * می‌شوند و کسی هم نمی‌فهمد چرا.
 *
 * معکوسِ یک افتتاحیه هم باید بماند، وگرنه یک سندِ تنهای منفی به پارسیان می‌رود
 * که طرف مقابلش هرگز نرفته بود.
 *
 * این «حذف» نیست و پنهان هم نمی‌ماند: تعدادشان در کنترل‌های آمادگی نوشته
 * می‌شود تا حسابدار بداند چه چیزی در بسته نیست و چرا.
 *
 * سندهای بستن سال (موقت، اختتامیه، افتتاحیه و معکوسشان) هم به همین دلیل نمی‌روند:
 * نرم‌افزار مقصد سال را خودش می‌بندد و سند دوم، سود سال را دو بار جابه‌جا می‌کرد.
 */
const OPENING_ENTRY_FILTER = `journal_entries.entry_kind<>'opening'
    AND NOT EXISTS (SELECT 1 FROM journal_entries AS reversed
      WHERE reversed.id=journal_entries.reverses_entry_id AND reversed.entry_kind='opening')
    AND NOT EXISTS (SELECT 1 FROM year_close_entries AS year_close WHERE year_close.entry_id=journal_entries.id)`;

function openingEntriesInScope(range) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM journal_entries
    WHERE occurred_at>=? AND occurred_at<? AND NOT (${OPENING_ENTRY_FILTER})`)
    .get(range.from, range.toExclusive).count || 0);
}

// سندی که از بکاپ پارسیان آمده همین حالا در پارسیان هست؛ فرستادن دوباره‌اش
// سند تکراری می‌سازد، چون پارسیان تکرار را تشخیص نمی‌دهد. برای مقصد عمومی
// (اکسل و نرم‌افزارهای دیگر) همان سند هم بخشی از دفتر است و می‌ماند.
const PARSIAN_SOURCE_FILTER = `NOT EXISTS (SELECT 1 FROM parsian_imported_entries AS parsian_source
    WHERE parsian_source.entry_id=journal_entries.id)`;

function parsianSourcedEntriesInScope(range) {
  ensureParsianSourceSchema(activeWorkspaceDatabase());
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM journal_entries
    WHERE occurred_at>=? AND occurred_at<? AND NOT (${PARSIAN_SOURCE_FILTER})`)
    .get(range.from, range.toExclusive).count || 0);
}

function accountingTransferJournalRows(range, target = 'generic-csv') {
  const parsianOnly = target === 'parsian-review-csv';
  if (parsianOnly) ensureParsianSourceSchema(activeWorkspaceDatabase());
  return db.prepare(`SELECT journal_entries.id AS entryId,journal_entries.occurred_at AS occurredAt,
    journal_entries.memo,journal_entries.entry_kind AS entryKind,journal_entries.source_type AS sourceType,
    journal_entries.source_id AS sourceId,journal_entries.revision,journal_lines.account_id AS accountId,
    journal_entries.document_number AS documentNumber,journal_entries.fiscal_year AS fiscalYear,
    ledger_accounts.code AS accountCode,ledger_accounts.name AS accountName,journal_lines.debit,journal_lines.credit,
    journal_lines.description AS lineDescription,
    chart_accounts.code AS chartCode,chart_accounts.name AS chartName,
    -- پارسیان حساب را سه ستون عددی جدا می‌خواهد: کل، معین، تفصیلی.
    chart_parent.level_code AS kolCode,chart_parent.name AS kolName,
    chart_accounts.level_code AS moeenCode,chart_accounts.name AS moeenName,
    chart_accounts.requires_analytic AS requiresAnalytic,
    -- کد مقصد، نه کد داخلی. کد داخلی خودکار ساخته می‌شود و در پارسیان یعنی
    -- شخص دیگری؛ تا وقتی نگاشت نشده، خالی می‌رود و هشدار داده می‌شود.
    analytic_accounts.external_code AS tafsiliCode,analytic_accounts.name AS tafsiliName,
    analytic_accounts.id AS analyticId,analytic_accounts.source_kind AS analyticSourceKind,
    analytic_accounts.code AS analyticCode,analytic_accounts.name AS analyticName,
    cost_centers.code AS costCenterCode,cost_centers.name AS costCenterName
    FROM journal_entries JOIN journal_lines ON journal_lines.entry_id=journal_entries.id
    JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
    LEFT JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    LEFT JOIN chart_accounts AS chart_parent ON chart_parent.id=chart_accounts.parent_id
    LEFT JOIN analytic_accounts ON analytic_accounts.id=journal_lines.analytic_id
    LEFT JOIN cost_centers ON cost_centers.id=journal_lines.cost_center_id
    WHERE journal_entries.occurred_at>=? AND journal_entries.occurred_at<? AND ${OPENING_ENTRY_FILTER}
    ${parsianOnly ? `AND ${PARSIAN_SOURCE_FILTER}` : ''}
    ORDER BY journal_entries.occurred_at,journal_entries.created_at,journal_entries.id,journal_lines.rowid`).all(range.from, range.toExclusive);
}

function accountingTransferState(month = '', targetSystem = 'generic-csv', now = new Date()) {
  const target = normalizeAccountingTransferTarget(targetSystem);
  const packageData = monthlyAccountantPackage(month, now);
  const settings = accountingTransferSettings(target);
  const mappings = accountingTransferMappings(target);
  const journalRows = accountingTransferJournalRows(packageData.scope, target);
  const chart = chartMappingOverview(activeWorkspaceDatabase());
  const parsianSourced = target === 'parsian-review-csv' ? parsianSourcedEntriesInScope(packageData.scope) : 0;
  // پیش‌نویسِ آمده از پارسیان در این فایل نمی‌رود، پس جلوی ساختش را هم نمی‌گیرد.
  const pendingInPeriod = Number(db.prepare(`SELECT COUNT(*) AS count FROM journal_entries
    WHERE approval_state<>'approved' AND occurred_at>=? AND occurred_at<?
    ${target === 'parsian-review-csv' ? `AND ${PARSIAN_SOURCE_FILTER}` : ''}`)
    .get(packageData.scope.from, packageData.scope.toExclusive).count || 0);
  const readiness = accountingTransferReadiness({
    packageData, journalRows, settings, mappings,
    chart: { installed: chart.chartInstalled, complete: chart.complete },
    workflow: { pendingInPeriod, openingEntriesExcluded: openingEntriesInScope(packageData.scope) },
  });
  if (parsianSourced) readiness.checks.push({
    id: 'parsian-sourced', severity: 'advisory', passed: true, count: parsianSourced,
    label: `${parsianSourced} سند این دوره از بکاپ پارسیان آمده و همین حالا در پارسیان هست؛ در فایل انتقال نمی‌رود تا تکراری نشود.`,
  });
  const corrections = postExportEntries(packageData.scope.period, journalRows);
  if (corrections) readiness.checks.push({
    id: 'post-export-corrections', severity: 'advisory', passed: true, count: corrections,
    label: `${corrections} سند (اصلاحیه یا ثبت تازه) پس از بستهٔ تحویل‌شدهٔ این دوره ثبت شده؛ بستهٔ تازه کل دوره را دارد، پس در پارسیان یا بستهٔ قبلی را حذف کن یا فقط همین اسناد را وارد کن.`,
  });
  return { packageData, settings, mappings, journalRows, readiness, chart, workflow: { pendingInPeriod } };
}

/** اسناد این دوره که در هیچ بستهٔ تحویل‌شده‌ای نبوده‌اند، وقتی بستهٔ تحویل‌شده‌ای هست. */
function postExportEntries(period, journalRows) {
  ensureTransferEntriesSchema(activeWorkspaceDatabase());
  const delivered = db.prepare(`SELECT id FROM accounting_transfer_batches WHERE period=? AND status IN ('delivered','accepted')
    AND EXISTS(SELECT 1 FROM accounting_transfer_entries e WHERE e.batch_id=accounting_transfer_batches.id)`).all(period);
  if (!delivered.length) return 0;
  const sent = new Set(db.prepare(`SELECT entry_id AS entryId FROM accounting_transfer_entries
    WHERE batch_id IN (${delivered.map(() => '?').join(',')})`).all(...delivered.map((row) => row.id)).map((row) => row.entryId));
  return new Set(journalRows.map((row) => row.entryId).filter((entryId) => !sent.has(entryId))).size;
}

function hydrateAccountingTransferBatch(row, includeFile = false) {
  if (!row) return null;
  const latestValidation = db.prepare(`SELECT id,batch_id AS batchId,software_name AS softwareName,
    software_version AS softwareVersion,test_company_label AS testCompanyLabel,attempt_type AS attemptType,
    outcome,amount_unit AS amountUnit,imported_rows AS importedRows,rejected_rows AS rejectedRows,
    imported_debit_total AS importedDebitTotal,imported_credit_total AS importedCreditTotal,
    error_summary AS errorSummary,note,tested_by AS testedBy,created_at AS createdAt
    FROM accounting_transfer_validations WHERE batch_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(row.id);
  const passedTrial = db.prepare(`SELECT id FROM accounting_transfer_validations
    WHERE batch_id=? AND attempt_type='trial-import' AND outcome='passed' ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(row.id);
  const readinessSnapshot = parseStoredJson(row.readinessSnapshot, {});
  const item = {
    id: row.id, period: row.period, targetSystem: row.targetSystem, fileName: row.fileName,
    rowCount: Number(row.rowCount), entryCount: Number(row.entryCount), debitTotal: Number(row.debitTotal),
    creditTotal: Number(row.creditTotal), digest: row.digest, status: row.status, statusNote: row.statusNote,
    generatedBy: userIdentity(row.generatedBy), reviewedBy: userIdentity(row.reviewedBy),
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    fileFormat: normalizeTransferFileFormat(row.fileFormat),
    fileFormatLabel: String(row.fileName || '').endsWith('.zip') ? 'بستهٔ چندبخشی پارسیان (ZIP)' : TRANSFER_FILE_FORMATS[normalizeTransferFileFormat(row.fileFormat)].label,
    mimeType: String(row.fileName || '').endsWith('.zip') ? 'application/zip' : TRANSFER_FILE_FORMATS[normalizeTransferFileFormat(row.fileFormat)].mimeType,
    amountUnit: normalizeAmountUnit(row.amountUnit),
    amountUnitLabel: amountUnitLabel(row.amountUnit),
    downloadCount: Number(row.downloadCount || 0),
    firstDownloadedAt: row.firstDownloadedAt || null,
    lastDownloadedAt: row.lastDownloadedAt || null,
    lastDownloadedBy: userIdentity(row.lastDownloadedBy),
    lastDownloadReason: row.lastDownloadReason || '',
    redownloadRequired: Number(row.downloadCount || 0) > 0,
    fiscalYearCheck: readinessSnapshot.checks?.find((check) => check.id === 'parsian-fiscal-year') || null,
    latestValidation: latestValidation ? { ...latestValidation, testedBy: userIdentity(latestValidation.testedBy) } : null,
    acceptanceReady: row.targetSystem !== 'parsian-review-csv' || Boolean(passedTrial),
  };
  if (includeFile) item.fileData = Buffer.from(row.fileData || []);
  return item;
}

const accountingTransferBatchColumns = `id,period,target_system AS targetSystem,file_name AS fileName,
  row_count AS rowCount,entry_count AS entryCount,debit_total AS debitTotal,credit_total AS creditTotal,digest,status,
  status_note AS statusNote,generated_by AS generatedBy,reviewed_by AS reviewedBy,created_at AS createdAt,
  updated_at AS updatedAt,file_format AS fileFormat,amount_unit AS amountUnit,download_count AS downloadCount,
  first_downloaded_at AS firstDownloadedAt,last_downloaded_at AS lastDownloadedAt,
  last_downloaded_by AS lastDownloadedBy,last_download_reason AS lastDownloadReason,
  readiness_snapshot AS readinessSnapshot`;

const accountingTransferBatchSelect = `SELECT ${accountingTransferBatchColumns} FROM accounting_transfer_batches`;

const accountingTransferBatchFileSelect = `SELECT ${accountingTransferBatchColumns},file_data AS fileData FROM accounting_transfer_batches`;

export function listAccountingTransferBatches({ period = '', targetSystem = '', limit = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) { clauses.push('period=?'); params.push(period); }
  if (targetSystem) { clauses.push('target_system=?'); params.push(normalizeAccountingTransferTarget(targetSystem)); }
  params.push(Math.min(200, Math.max(1, Number(limit) || 50)));
  return db.prepare(`${accountingTransferBatchSelect}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY created_at DESC LIMIT ?`).all(...params).map((row) => hydrateAccountingTransferBatch(row));
}

export function accountingTransferOverview(month = '', targetSystem = 'generic-csv', now = new Date()) {
  const state = accountingTransferState(month, targetSystem, now);
  return {
    generatedAt: now.toISOString(), scope: state.packageData.scope, settings: state.settings,
    targets: ACCOUNTING_TRANSFER_TARGETS, readiness: state.readiness,
    batches: listAccountingTransferBatches({ period: state.packageData.scope.period, targetSystem: state.settings.targetSystem }),
  };
}

export function saveAccountingTransferSettings(values = {}) {
  const targetSystem = normalizeAccountingTransferTarget(values.targetSystem);
  const current = accountingTransferSettings(targetSystem);
  // این سه فیلد ادغام نمی‌شدند و در نبودشان خالی می‌شدند، درحالی‌که بقیهٔ
  // فیلدها ادغام می‌شوند. پنل چیدمان هنگام ذخیرهٔ سال مالی این‌ها را نمی‌فرستد،
  // پس هر بار ثبت سال مالی، تأیید قالب را پاک می‌کرد — و کاربر هرگز نمی‌توانست
  // هر دو دروازه را هم‌زمان سبز کند. این تنها بن‌بست واقعی مسیر خروجی بود.
  const templateName = values.templateName == null ? String(current.templateName || '') : String(values.templateName).trim().slice(0, 160);
  const templateVerified = values.templateVerified == null ? Boolean(current.templateVerified) : Boolean(values.templateVerified);
  const note = values.note == null ? String(current.note || '') : String(values.note).trim().slice(0, 800);
  if (targetSystem === 'parsian-review-csv' && templateVerified && templateName.length < 3) {
    throw invalidInput('برای تأیید نگاشت پارسیان، نام یا نسخهٔ قالب کنترل‌شده را وارد کن.');
  }
  const fileFormat = values.fileFormat == null ? current.fileFormat : normalizeTransferFileFormat(values.fileFormat);
  const amountUnit = values.amountUnit == null ? current.amountUnit : normalizeAmountUnit(values.amountUnit);
  const latinDate = (value) => String(value || '').trim().replace(/[۰-۹٠-٩]/g, (digit) => ({
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  })[digit]);
  const fiscalYearStart = values.fiscalYearStart == null ? current.fiscalYearStart : latinDate(values.fiscalYearStart);
  const fiscalYearEnd = values.fiscalYearEnd == null ? current.fiscalYearEnd : latinDate(values.fiscalYearEnd);
  if (targetSystem === 'parsian-review-csv' && (fiscalYearStart || fiscalYearEnd)) {
    const validDate = /^\d{4}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/;
    if (!validDate.test(fiscalYearStart) || !validDate.test(fiscalYearEnd)) {
      throw Object.assign(new Error('شروع و پایان سال مالی را با قالب ۱۴۰۵/۰۱/۰۱ وارد کن.'), { status: 400, code: 'TRANSFER_FISCAL_RANGE_INVALID' });
    }
    if (fiscalYearStart > fiscalYearEnd) {
      throw Object.assign(new Error('تاریخ پایان سال مالی نمی‌تواند قبل از تاریخ شروع باشد.'), { status: 400, code: 'TRANSFER_FISCAL_RANGE_INVALID' });
    }
  }
  // ستون‌ها فقط وقتی بازنویسی می‌شوند که کاربر صریحاً فرستاده باشد؛ ذخیرهٔ
  // نام قالب نباید چیدمان ستون‌های کنترل‌شده را پاک کند.
  const columns = values.columns == null ? null : normalizeTransferColumns(values.columns).columns;

  db.prepare(`INSERT INTO accounting_transfer_settings (target_system,template_name,template_verified,note,updated_by,file_format,amount_unit,columns_json,fiscal_year_start,fiscal_year_end)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(target_system) DO UPDATE SET template_name=excluded.template_name,
    template_verified=excluded.template_verified,note=excluded.note,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP,
    file_format=excluded.file_format,amount_unit=excluded.amount_unit,columns_json=excluded.columns_json,
    fiscal_year_start=excluded.fiscal_year_start,fiscal_year_end=excluded.fiscal_year_end`)
    .run(targetSystem, templateName, templateVerified ? 1 : 0, note, currentWorkspace()?.userId || null,
      fileFormat, amountUnit, JSON.stringify(columns ?? (current.usingDefaultColumns ? [] : current.columns)), fiscalYearStart, fiscalYearEnd);
  audit('update-transfer-settings', 'accounting_transfer_settings', targetSystem, {
    templateName, templateVerified, fileFormat, amountUnit, fiscalYearStart, fiscalYearEnd,
    previousFiscalYearStart: current.fiscalYearStart, previousFiscalYearEnd: current.fiscalYearEnd,
    columnCount: (columns || current.columns).length,
  });
  return accountingTransferSettings(targetSystem);
}

/**
 * کد مقصد را از کدینگ دفتر پر می‌کند.
 *
 * دفتر حسابداری کدینگ خودش را وارد حساب‌یار کرده و همان کدینگ، کدینگ نرم‌افزار
 * مقصدش هم هست. پس تایپ دوبارهٔ کد مقصد برای ده‌ها حساب، دوباره‌کاری محض بود.
 * نگاشت دستی موجود بازنویسی نمی‌شود مگر صریحاً خواسته شود.
 */
export function fillTransferMappingsFromChart(targetSystem = 'parsian-review-csv', { overwrite = false } = {}) {
  const target = normalizeAccountingTransferTarget(targetSystem);
  const rows = db.prepare(`SELECT ledger_accounts.id,ledger_accounts.code,ledger_accounts.name,
    chart_accounts.code AS chartCode,chart_accounts.name AS chartName
    FROM ledger_accounts JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    WHERE ledger_accounts.active=1`).all();
  if (!rows.length) {
    throw Object.assign(new Error('هیچ حسابی به کدینگ دفتر نگاشت نشده است؛ اول در صفحهٔ کدینگ نگاشت را کامل کن.'), {
      status: 409, code: 'CHART_MAPPING_EMPTY',
    });
  }
  const existing = new Map(accountingTransferMappings(target).map((item) => [item.ledgerAccountId, item]));
  const insert = db.prepare(`INSERT INTO accounting_transfer_mappings (target_system,ledger_account_id,target_code,target_name,updated_by)
    VALUES (?,?,?,?,?) ON CONFLICT(target_system,ledger_account_id) DO UPDATE SET target_code=excluded.target_code,
    target_name=excluded.target_name,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`);
  const userId = currentWorkspace()?.userId || null;
  let filled = 0;
  let kept = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const current = existing.get(row.id);
      if (current?.targetCode && !overwrite) { kept += 1; continue; }
      insert.run(target, row.id, row.chartCode, row.chartName, userId);
      filled += 1;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  audit('fill-transfer-mappings', 'accounting_transfer_settings', target, { filled, kept, overwrite });
  return { targetSystem: target, filled, kept, mappings: accountingTransferMappings(target) };
}

export function saveAccountingTransferMapping(values = {}) {
  const targetSystem = normalizeAccountingTransferTarget(values.targetSystem);
  const ledgerAccountId = String(values.ledgerAccountId || '').trim();
  const targetCode = String(values.targetCode || '').trim().slice(0, 80);
  const targetName = String(values.targetName || '').trim().slice(0, 160);
  const account = db.prepare('SELECT id,code,name FROM ledger_accounts WHERE id=?').get(ledgerAccountId);
  if (!account) throw Object.assign(new Error('حساب دفتر کل در این دفتر پیدا نشد.'), { status: 404, code: 'TRANSFER_ACCOUNT_NOT_FOUND' });
  if (!targetCode) throw invalidInput('کد حساب مقصد را وارد کن.');
  db.prepare(`INSERT INTO accounting_transfer_mappings (target_system,ledger_account_id,target_code,target_name,updated_by)
    VALUES (?,?,?,?,?) ON CONFLICT(target_system,ledger_account_id) DO UPDATE SET target_code=excluded.target_code,
    target_name=excluded.target_name,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
    .run(targetSystem, ledgerAccountId, targetCode, targetName, currentWorkspace()?.userId || null);
  audit('map-transfer-account', 'ledger_account', ledgerAccountId, { targetSystem, targetCode, targetName });
  return accountingTransferMappings(targetSystem).find((item) => item.ledgerAccountId === ledgerAccountId);
}

export function createAccountingTransferBatch(values = {}, now = new Date()) {
  const targetSystem = normalizeAccountingTransferTarget(values.targetSystem);
  const state = accountingTransferState(values.month, targetSystem, now);
  if (!state.readiness.ready) throw Object.assign(new Error('خروجی هنوز آماده نیست؛ موارد کنترل‌نشده را برطرف کن.'), {
    status: 409, code: 'ACCOUNTING_TRANSFER_NOT_READY', details: { readiness: state.readiness },
  });
  const fileFormat = normalizeTransferFileFormat(values.fileFormat || state.settings.fileFormat);
  const built = buildAccountingTransferFile({
    period: state.packageData.scope.period, journalRows: state.journalRows, settings: state.settings,
    mappings: state.mappings, timeZone: state.packageData.scope.timeZone,
    fileFormat, columns: state.settings.columns, amountUnit: state.settings.amountUnit,
    targetLabel: state.readiness.target?.label || '',
    template: fileFormat === 'mdb' ? accountingTransferTemplate(targetSystem) : null,
  });
  const fileData = built.buffer;
  const digest = createHash('sha256').update(fileData).digest('hex');
  const existing = db.prepare(`${accountingTransferBatchSelect} WHERE period=? AND target_system=? AND digest=?`)
    .get(state.packageData.scope.period, targetSystem, digest);
  // فهرست اسنادِ بسته همراهش می‌ماند تا وقتی تحویل شد، همان اسناد قفل شوند.
  const entryIds = state.journalRows.map((row) => row.entryId);
  if (existing) {
    recordTransferBatchEntries(activeWorkspaceDatabase(), existing.id, entryIds);
    return hydrateAccountingTransferBatch(existing);
  }
  const id = randomUUID();
  const workspaceId = String(currentWorkspace()?.id || 'primary').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'primary';
  // هش کوتاه در نام فایل، دو بستهٔ یک ماه را در پوشهٔ دانلود از هم متمایز
  // می‌کند. پارسیان محتوای تکراری را تشخیص نمی‌دهد و نام مبهم خطر ورود دوباره را بالا می‌برد.
  const extension = built.extension || TRANSFER_FILE_FORMATS[fileFormat].extension;
  const fileName = `hesab-yar-ledger-${workspaceId}-${state.packageData.scope.period}-${targetSystem}-${digest.slice(0, 12)}.${extension}`;
  db.prepare(`INSERT INTO accounting_transfer_batches (id,period,target_system,file_name,row_count,entry_count,debit_total,
    credit_total,digest,readiness_snapshot,file_data,generated_by,file_format,amount_unit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, state.packageData.scope.period, targetSystem, fileName, state.readiness.rowCount, state.readiness.entryCount,
      state.readiness.debitTotal, state.readiness.creditTotal, digest, JSON.stringify(state.readiness), fileData,
      currentWorkspace()?.userId || null, fileFormat, state.settings.amountUnit);
  recordTransferBatchEntries(activeWorkspaceDatabase(), id, entryIds);
  audit('generate-transfer-batch', 'accounting_transfer_batch', id, {
    period: state.packageData.scope.period, targetSystem, digest, rowCount: state.readiness.rowCount, fileFormat,
    amountUnit: state.settings.amountUnit, multipart: Boolean(built.multipart),
    partCount: built.manifest?.totals?.partCount || 1,
  });
  return hydrateAccountingTransferBatch(db.prepare(`${accountingTransferBatchSelect} WHERE id=?`).get(id));
}

export function accountingTransferBatchFile(id) {
  return hydrateAccountingTransferBatch(db.prepare(`${accountingTransferBatchFileSelect} WHERE id=?`).get(id), true);
}

/**
 * یک دریافت قابل‌ردیابی از فایل انتقال ثبت می‌کند.
 *
 * اولین دریافت برای حسابدار مجاز است و بسته را به «تحویل‌شده» می‌برد. هر
 * دریافت بعدی، چون پارسیان فایل تکراری را بی‌هشدار دوباره وارد می‌کند، فقط با
 * نقش مدیر/مالک، تأیید صریح و علت ثبت‌شده ممکن است.
 */
export function claimAccountingTransferBatchDownload(id, values = {}) {
  const batchId = String(id || '').trim();
  const confirmRedownload = values.confirmRedownload === true;
  const reason = String(values.reason || '').trim().slice(0, 600);
  const actor = currentWorkspace() || {};
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare(`${accountingTransferBatchFileSelect} WHERE id=?`).get(batchId);
    if (!current) {
      db.exec('ROLLBACK');
      return null;
    }
    if (normalizeTransferFileFormat(current.fileFormat) === 'mdb') {
      const snapshot = parseStoredJson(current.readinessSnapshot, {});
      const fiscalCheck = snapshot.checks?.find((check) => check.id === 'parsian-fiscal-year');
      if (!fiscalCheck?.passed) {
        throw Object.assign(new Error('این بسته تأیید سال مالی مقصد ندارد؛ برای جلوگیری از ورود سند به دورهٔ اشتباه، تنظیمات سال مالی را کامل و بستهٔ تازه‌ای تولید کن.'), {
          status: 409, code: 'TRANSFER_FISCAL_YEAR_NOT_VERIFIED',
          details: { fiscalYearCheck: fiscalCheck || null },
        });
      }
    }
    const previousDownloads = Number(current.downloadCount || 0);
    if (previousDownloads > 0) {
      if (!['manager', 'owner'].includes(actor.role)) {
        throw Object.assign(new Error('این بسته قبلاً دریافت شده است؛ دریافت دوباره فقط با تأیید مدیر یا مالک دفتر ممکن است.'), {
          status: 403, code: 'TRANSFER_REDOWNLOAD_MANAGER_REQUIRED',
          details: { downloadCount: previousDownloads, lastDownloadedAt: current.lastDownloadedAt || null },
        });
      }
      if (!confirmRedownload) {
        throw Object.assign(new Error('این بسته قبلاً دریافت شده است. برای جلوگیری از ثبت تکراری در پارسیان، دریافت دوباره را صریحاً تأیید کن.'), {
          status: 409, code: 'TRANSFER_REDOWNLOAD_CONFIRM_REQUIRED',
          details: { downloadCount: previousDownloads, lastDownloadedAt: current.lastDownloadedAt || null },
        });
      }
      if (reason.length < 8) {
        throw Object.assign(new Error('علت دریافت دوباره را حداقل در ۸ نویسه بنویس تا در سابقهٔ حسابرسی بماند.'), {
          status: 400, code: 'TRANSFER_REDOWNLOAD_REASON_REQUIRED',
        });
      }
    }
    db.prepare(`UPDATE accounting_transfer_batches SET download_count=download_count+1,
      first_downloaded_at=COALESCE(first_downloaded_at,CURRENT_TIMESTAMP),last_downloaded_at=CURRENT_TIMESTAMP,
      last_downloaded_by=?,last_download_reason=?,status=CASE WHEN status='generated' THEN 'delivered' ELSE status END,
      reviewed_by=CASE WHEN status='generated' THEN ? ELSE reviewed_by END,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(actor.userId || null, previousDownloads > 0 ? reason : '', actor.userId || null, batchId);
    audit(previousDownloads > 0 ? 'redownload-transfer-batch' : 'download-transfer-batch', 'accounting_transfer_batch', batchId, {
      downloadCount: previousDownloads + 1,
      reason: previousDownloads > 0 ? reason : undefined,
      digest: current.digest,
    });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  }
  return hydrateAccountingTransferBatch(db.prepare(`${accountingTransferBatchFileSelect} WHERE id=?`).get(batchId), true);
}

export function listAccountingTransferValidations(batchId) {
  return db.prepare(`SELECT id,batch_id AS batchId,software_name AS softwareName,
    software_version AS softwareVersion,test_company_label AS testCompanyLabel,attempt_type AS attemptType,
    outcome,amount_unit AS amountUnit,imported_rows AS importedRows,rejected_rows AS rejectedRows,
    imported_debit_total AS importedDebitTotal,imported_credit_total AS importedCreditTotal,
    error_summary AS errorSummary,note,tested_by AS testedBy,created_at AS createdAt
    FROM accounting_transfer_validations WHERE batch_id=? ORDER BY created_at DESC,rowid DESC`).all(String(batchId || ''))
    .map((item) => ({ ...item, testedBy: userIdentity(item.testedBy) }));
}

export function createAccountingTransferValidation(batchId, values = {}) {
  const batch = db.prepare(`${accountingTransferBatchSelect} WHERE id=?`).get(String(batchId || ''));
  if (!batch) return null;
  if (['accepted', 'rejected'].includes(batch.status)) throw Object.assign(new Error('بستهٔ نهایی‌شده آزمون تازه نمی‌پذیرد؛ پس از اصلاح، بستهٔ جدید بساز.'), { status: 409, code: 'TRANSFER_BATCH_FINAL' });
  const softwareName = String(values.softwareName || (batch.targetSystem === 'parsian-review-csv' ? 'پارسیان' : '')).trim().slice(0, 100);
  const softwareVersion = String(values.softwareVersion || '').trim().slice(0, 100);
  const testCompanyLabel = String(values.testCompanyLabel || '').trim().slice(0, 160);
  const attemptType = values.attemptType === 'trial-import' ? 'trial-import' : 'dry-run';
  const outcome = values.outcome === 'passed' ? 'passed' : 'failed';
  const amountUnit = values.amountUnit === 'toman' ? 'toman' : 'rial';
  const importedRows = Math.max(0, Math.round(Number(values.importedRows) || 0));
  const rejectedRows = Math.max(0, Math.round(Number(values.rejectedRows) || 0));
  const importedDebitTotal = Math.max(0, Math.round(Number(values.importedDebitTotal) || 0));
  const importedCreditTotal = Math.max(0, Math.round(Number(values.importedCreditTotal) || 0));
  const errorSummary = String(values.errorSummary || '').trim().slice(0, 1600);
  const note = String(values.note || '').trim().slice(0, 1600);
  if (softwareName.length < 2 || softwareVersion.length < 1 || testCompanyLabel.length < 2) throw invalidInput('نام نرم‌افزار، نسخه و برچسب شرکت آزمایشی را کامل وارد کن.');
  if (outcome === 'failed' && errorSummary.length < 5) throw invalidInput('برای آزمون ناموفق، خلاصهٔ خطا را کامل وارد کن.');
  // جمع بسته به واحد دفتر ذخیره شده؛ به واحدی که آزمون با آن گزارش شده دقیق تبدیل می‌شود.
  const expectedDebitTotal = convertAmount(Number(batch.debitTotal), ledgerAmountUnit(), amountUnit);
  const expectedCreditTotal = convertAmount(Number(batch.creditTotal), ledgerAmountUnit(), amountUnit);
  const exactMatch = importedRows === Number(batch.rowCount) && rejectedRows === 0
    && importedDebitTotal === expectedDebitTotal && importedCreditTotal === expectedCreditTotal;
  if (outcome === 'passed' && !exactMatch) throw Object.assign(new Error('آزمون موفق فقط وقتی ثبت می‌شود که تعداد ردیف، ردیف ردشده و جمع بدهکار/بستانکار دقیقاً با بسته برابر باشد.'), {
    status: 409, code: 'TRANSFER_VALIDATION_MISMATCH', details: {
      expectedRows: Number(batch.rowCount), expectedDebitTotal, expectedCreditTotal, amountUnit,
    },
  });
  const id = randomUUID();
  db.prepare(`INSERT INTO accounting_transfer_validations (id,batch_id,software_name,software_version,
    test_company_label,attempt_type,outcome,amount_unit,imported_rows,rejected_rows,imported_debit_total,
    imported_credit_total,error_summary,note,tested_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, batch.id, softwareName, softwareVersion, testCompanyLabel, attemptType, outcome, amountUnit,
      importedRows, rejectedRows, importedDebitTotal, importedCreditTotal, errorSummary, note,
      currentWorkspace()?.userId || null);
  audit('validate-transfer-batch', 'accounting_transfer_batch', batch.id, {
    validationId: id, attemptType, outcome, softwareName, softwareVersion, testCompanyLabel,
    amountUnit, importedRows, rejectedRows, importedDebitTotal, importedCreditTotal,
  });
  return listAccountingTransferValidations(batch.id).find((item) => item.id === id);
}

export function updateAccountingTransferBatchStatus(id, values = {}) {
  const status = ['delivered', 'accepted', 'rejected'].includes(values.status) ? values.status : '';
  const note = String(values.note || '').trim().slice(0, 1200);
  if (!status) throw invalidInput('وضعیت تحویل معتبر نیست.');
  if (status === 'rejected' && note.length < 5) throw invalidInput('دلیل رد خروجی را کامل وارد کن.');
  const current = db.prepare('SELECT id,status,target_system AS targetSystem FROM accounting_transfer_batches WHERE id=?').get(id);
  if (!current) return null;
  if (['accepted', 'rejected'].includes(current.status) && status !== current.status) throw Object.assign(new Error('خروجی نهایی‌شده قابل بازگرداندن نیست؛ پس از اصلاح داده یک بستهٔ جدید بساز.'), { status: 409, code: 'TRANSFER_BATCH_FINAL' });
  if (status === 'accepted' && current.targetSystem === 'parsian-review-csv') {
    const passedTrial = db.prepare(`SELECT id FROM accounting_transfer_validations
      WHERE batch_id=? AND attempt_type='trial-import' AND outcome='passed' LIMIT 1`).get(id);
    if (!passedTrial) throw Object.assign(new Error('پذیرش پارسیان فقط بعد از ثبت آزمون ورود موفق روی شرکت آزمایشی ممکن است.'), { status: 409, code: 'TRANSFER_TRIAL_REQUIRED' });
  }
  db.prepare(`UPDATE accounting_transfer_batches SET status=?,status_note=?,reviewed_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(status, note, currentWorkspace()?.userId || null, id);
  audit('update-transfer-status', 'accounting_transfer_batch', id, { status, note });
  return hydrateAccountingTransferBatch(db.prepare(`${accountingTransferBatchSelect} WHERE id=?`).get(id));
}
