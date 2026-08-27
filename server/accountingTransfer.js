import { buildWorkbook } from './spreadsheet.js';
import { DEFAULT_TRANSFER_COLUMNS, applyTransferTemplate } from './transferTemplates.js';

const TARGET_CATALOG = Object.freeze({
  'generic-csv': Object.freeze({
    id: 'generic-csv',
    label: 'CSV استاندارد دفتر کل',
    description: 'خروجی UTF-8 ردیف‌های بدهکار و بستانکار با مبلغ تومان و ریال برای تطبیق حسابدار.',
    templateRequired: false,
    directImportCertified: false,
  }),
  'parsian-review-csv': Object.freeze({
    id: 'parsian-review-csv',
    label: 'پارسیان — فایل آمادهٔ نگاشت',
    description: 'خروجی کنترل‌شده با کد حساب مقصد؛ فایل بکاپ SQL Server یا قالب تأییدشدهٔ مستقیم پارسیان نیست.',
    templateRequired: true,
    directImportCertified: false,
  }),
});

export const ACCOUNTING_TRANSFER_TARGETS = Object.freeze(Object.values(TARGET_CATALOG));

export function normalizeAccountingTransferTarget(value) {
  return Object.hasOwn(TARGET_CATALOG, value) ? value : 'generic-csv';
}

export function accountingTransferTarget(value) {
  return TARGET_CATALOG[normalizeAccountingTransferTarget(value)];
}

function safeText(value) {
  const text = String(value ?? '');
  return /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
}

function csvCell(value) {
  const text = safeText(value).replace(/\r\n?/g, '\n');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function persianDateToken(value, timeZone = 'Asia/Tehran') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}/${part('month')}/${part('day')}`;
}

export function accountingTransferReadiness({ packageData = {}, journalRows = [], settings = {}, mappings = [], chart = {}, workflow = {} } = {}) {
  const target = accountingTransferTarget(settings.targetSystem);
  const checks = [];
  for (const item of packageData.checklist?.checks || []) checks.push({
    id: `package-${item.id}`, label: item.label, count: Number(item.count || 0), passed: Boolean(item.passed), severity: 'blocker',
  });

  const entryIds = new Set(journalRows.map((item) => item.entryId));
  const debitTotal = journalRows.reduce((sum, item) => sum + Number(item.debit || 0), 0);
  const creditTotal = journalRows.reduce((sum, item) => sum + Number(item.credit || 0), 0);
  const entryTotals = new Map();
  for (const item of journalRows) {
    const total = entryTotals.get(item.entryId) || { debit: 0, credit: 0 };
    total.debit += Number(item.debit || 0);
    total.credit += Number(item.credit || 0);
    entryTotals.set(item.entryId, total);
  }
  const unbalancedEntries = [...entryTotals.values()].filter((item) => item.debit !== item.credit).length;
  const unreviewed = (packageData.sections?.transactions || []).filter((item) => !['ready', 'reviewed'].includes(item.reviewState)).length;
  checks.push({ id: 'rows', label: 'حداقل یک سند دفتر کل در دوره وجود دارد', count: entryIds.size, passed: entryIds.size > 0, severity: 'blocker' });
  checks.push({ id: 'balanced', label: 'هر سند و جمع خروجی متوازن است', count: unbalancedEntries || Math.abs(debitTotal - creditTotal), passed: debitTotal === creditTotal && unbalancedEntries === 0, severity: 'blocker' });
  checks.push({ id: 'review', label: 'ثبت بررسی‌نشده باقی نمانده', count: unreviewed, passed: unreviewed === 0, severity: 'blocker' });

  const mappingByAccount = new Map(mappings.map((item) => [item.ledgerAccountId, item]));
  const accounts = [...new Map(journalRows.map((item) => [item.accountId, {
    id: item.accountId, code: item.accountCode, name: item.accountName, mapping: mappingByAccount.get(item.accountId) || null,
  }])).values()];
  const missingMappings = target.templateRequired ? accounts.filter((item) => !item.mapping?.targetCode) : [];
  if (target.templateRequired) {
    checks.push({
      id: 'template', label: 'قالب مقصد توسط حسابدار کنترل و نام‌گذاری شده', count: settings.templateVerified ? 0 : 1,
      passed: Boolean(settings.templateVerified && String(settings.templateName || '').trim()), severity: 'blocker',
    });
    checks.push({
      id: 'mappings', label: 'همهٔ حساب‌های استفاده‌شده کد مقصد دارند', count: missingMappings.length,
      passed: missingMappings.length === 0, severity: 'blocker',
    });
  }

  // کدینگ دفتر: تا وقتی نصب نشده، فقط یک یادآوری است و جلوی خروجی را نمی‌گیرد.
  // به‌محض نصب، هر حساب استفاده‌شدهٔ بدون معین مقصد یک ایراد بازدارنده است.
  const unmappedUsedAccounts = [...new Map(journalRows.filter((item) => !item.chartCode)
    .map((item) => [item.accountId, { id: item.accountId, code: item.accountCode, name: item.accountName }])).values()];
  checks.push(chart.installed
    ? { id: 'chart', label: 'هر حساب استفاده‌شده به معین کدینگ دفتر نگاشت شده', count: unmappedUsedAccounts.length, passed: unmappedUsedAccounts.length === 0, severity: 'blocker' }
    : { id: 'chart', label: 'کدینگ دفتر حسابداری هنوز وارد نشده است', count: 1, passed: false, severity: 'advisory' });

  // سند کنترل‌نشده نباید تحویل دفتر شود؛ گردش ثبت‌کننده/کنترل‌کننده وقتی معنا
  // دارد که خروجی هم به آن پایبند باشد.
  const pendingApproval = Number(workflow.pendingInPeriod || 0);
  checks.push({
    id: 'approval', label: 'سند کنترل‌نشده در دوره باقی نمانده', count: pendingApproval,
    passed: pendingApproval === 0, severity: 'blocker',
  });

  const ready = checks.filter((item) => item.severity !== 'advisory').every((item) => item.passed);
  return {
    ready, target, checks, rowCount: journalRows.length, entryCount: entryIds.size, debitTotal, creditTotal,
    accountCount: accounts.length, accounts, missingMappings,
    chart: { installed: Boolean(chart.installed), unmappedUsedAccounts, unmappedUsedCount: unmappedUsedAccounts.length },
    compatibility: target.id === 'generic-csv' ? 'generic-ledger-csv-v1' : 'parsian-mapping-review-v1',
    directImportCertified: false,
    disclaimer: target.id === 'generic-csv'
      ? 'این CSV خروجی استاندارد حساب‌یار است؛ پیش از ورود به هر نرم‌افزار، ستون‌ها و واحد پول باید روی شرکت آزمایشی کنترل شوند.'
      : 'این فایل برای نگاشت و کنترل حسابدار است؛ فایل .bak یا خروجی رسمی و تضمین‌شدهٔ پارسیان نیست و ورود مستقیم بدون آزمون شرکت نمونه مجاز نیست.',
  };
}

export const TRANSFER_FILE_FORMATS = Object.freeze({
  csv: Object.freeze({ id: 'csv', label: 'CSV برای اکسل', extension: 'csv', mimeType: 'text/csv; charset=utf-8' }),
  xlsx: Object.freeze({ id: 'xlsx', label: 'اکسل (xlsx)', extension: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
});

export function normalizeTransferFileFormat(value) {
  return Object.hasOwn(TRANSFER_FILE_FORMATS, value) ? value : 'csv';
}

/**
 * خروجی را طبق قالب ستونی دفتر می‌سازد — CSV یا اکسل واقعی.
 * شیت دوم عمداً «شناسنامهٔ فایل» است: واحد مبلغ، دوره، جمع‌ها و مرز صراحت
 * محصول، تا کسی فایل را بدون دانستن واحدش وارد نرم‌افزار نکند.
 */
export function buildAccountingTransferFile({ period, journalRows = [], settings = {}, mappings = [], timeZone = 'Asia/Tehran', fileFormat = 'csv', columns, amountUnit = 'toman', targetLabel = '' } = {}) {
  const table = applyTransferTemplate({
    columns: columns && columns.length ? columns : DEFAULT_TRANSFER_COLUMNS,
    amountUnit, journalRows, period, mappings,
    persianDate: (value) => persianDateToken(value, timeZone),
  });
  if (normalizeTransferFileFormat(fileFormat) === 'csv') {
    const body = [table.headers, ...table.rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    return { buffer: Buffer.from(`﻿${body}\r\n`, 'utf8'), table };
  }
  const manifest = [
    ['شناسنامهٔ فایل انتقال حساب‌یار'],
    ['دوره', period],
    ['مقصد', targetLabel || settings.targetSystem || ''],
    ['واحد مبلغ ستون‌های مبلغ', table.amountUnitLabel],
    ['تعداد ردیف', table.rows.length],
    ['جمع بدهکار (تومان)', table.totals.debitToman],
    ['جمع بستانکار (تومان)', table.totals.creditToman],
    [`جمع بدهکار (${table.amountUnitLabel})`, table.totals.debit],
    [`جمع بستانکار (${table.amountUnitLabel})`, table.totals.credit],
    ['قالب کنترل‌شده', settings.templateName || '—'],
    ['توضیح', 'این فایل خروجی کنترل‌شدهٔ حساب‌یار است و ادعای ورود مستقیم تأییدشده به هیچ نرم‌افزاری ندارد.'],
  ];
  return {
    buffer: buildWorkbook([
      { name: 'ردیف‌های دفتر کل', rows: [table.headers, ...table.rows] },
      { name: 'شناسنامه', rows: manifest },
    ]),
    table,
  };
}

export function buildAccountingTransferCsv({ period, journalRows = [], settings = {}, mappings = [], timeZone = 'Asia/Tehran' } = {}) {
  const mappingByAccount = new Map(mappings.map((item) => [item.ledgerAccountId, item]));
  const lineNumbers = new Map();
  const headers = [
    'شناسه سند حساب‌یار', 'ردیف سند', 'دوره شمسی', 'تاریخ شمسی', 'تاریخ ISO', 'نوع سند', 'نوع منبع', 'شناسه منبع',
    'شرح سند', 'شرح ردیف', 'کد حساب حساب‌یار', 'نام حساب حساب‌یار', 'کد معین کدینگ', 'نام معین کدینگ',
    'کد تفصیلی', 'نام تفصیلی', 'کد مرکز هزینه', 'نام مرکز هزینه', 'بدهکار تومان', 'بستانکار تومان',
    'بدهکار ریال', 'بستانکار ریال', 'کد حساب مقصد', 'نام حساب مقصد',
  ];
  const rows = journalRows.map((item) => {
    const mapping = mappingByAccount.get(item.accountId) || {};
    const lineNumber = (lineNumbers.get(item.entryId) || 0) + 1;
    lineNumbers.set(item.entryId, lineNumber);
    return [
      item.entryId, lineNumber, period, persianDateToken(item.occurredAt, timeZone), item.occurredAt,
      item.entryKind, item.sourceType, item.sourceId, item.memo, item.lineDescription || '', item.accountCode,
      item.accountName, item.chartCode || '', item.chartName || '',
      item.analyticCode || '', item.analyticName || '', item.costCenterCode || '', item.costCenterName || '',
      Number(item.debit || 0), Number(item.credit || 0), Number(item.debit || 0) * 10,
      Number(item.credit || 0) * 10, mapping.targetCode || '', mapping.targetName || '',
    ];
  });
  const body = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  return Buffer.from(`\uFEFF${body}\r\n`, 'utf8');
}
