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

export function accountingTransferReadiness({ packageData = {}, journalRows = [], settings = {}, mappings = [] } = {}) {
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

  const ready = checks.every((item) => item.passed);
  return {
    ready, target, checks, rowCount: journalRows.length, entryCount: entryIds.size, debitTotal, creditTotal,
    accountCount: accounts.length, accounts, missingMappings,
    compatibility: target.id === 'generic-csv' ? 'generic-ledger-csv-v1' : 'parsian-mapping-review-v1',
    directImportCertified: false,
    disclaimer: target.id === 'generic-csv'
      ? 'این CSV خروجی استاندارد حساب‌یار است؛ پیش از ورود به هر نرم‌افزار، ستون‌ها و واحد پول باید روی شرکت آزمایشی کنترل شوند.'
      : 'این فایل برای نگاشت و کنترل حسابدار است؛ فایل .bak یا خروجی رسمی و تضمین‌شدهٔ پارسیان نیست و ورود مستقیم بدون آزمون شرکت نمونه مجاز نیست.',
  };
}

export function buildAccountingTransferCsv({ period, journalRows = [], settings = {}, mappings = [], timeZone = 'Asia/Tehran' } = {}) {
  const mappingByAccount = new Map(mappings.map((item) => [item.ledgerAccountId, item]));
  const lineNumbers = new Map();
  const headers = [
    'شناسه سند حساب‌یار', 'ردیف سند', 'دوره شمسی', 'تاریخ شمسی', 'تاریخ ISO', 'نوع سند', 'نوع منبع', 'شناسه منبع',
    'شرح سند', 'شرح ردیف', 'کد حساب حساب‌یار', 'نام حساب حساب‌یار', 'بدهکار تومان', 'بستانکار تومان',
    'بدهکار ریال', 'بستانکار ریال', 'کد حساب مقصد', 'نام حساب مقصد',
  ];
  const rows = journalRows.map((item) => {
    const mapping = mappingByAccount.get(item.accountId) || {};
    const lineNumber = (lineNumbers.get(item.entryId) || 0) + 1;
    lineNumbers.set(item.entryId, lineNumber);
    return [
      item.entryId, lineNumber, period, persianDateToken(item.occurredAt, timeZone), item.occurredAt,
      item.entryKind, item.sourceType, item.sourceId, item.memo, item.lineDescription || '', item.accountCode,
      item.accountName, Number(item.debit || 0), Number(item.credit || 0), Number(item.debit || 0) * 10,
      Number(item.credit || 0) * 10, mapping.targetCode || '', mapping.targetName || '',
    ];
  });
  const body = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  return Buffer.from(`\uFEFF${body}\r\n`, 'utf8');
}
