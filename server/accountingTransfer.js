import { buildWorkbook } from './spreadsheet.js';
import { DEFAULT_TRANSFER_COLUMNS, applyTransferTemplate } from './transferTemplates.js';
import { createHash } from 'node:crypto';
import { buildZipArchive } from './archive.js';
import { buildParsianTransfer, PARSIAN_TRANSFER_LIMITS, readParsianTemplate } from './parsianAccessFile.js';

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
    label: 'پارسیان',
    description: 'خروجی کنترل‌شده برای نگاشت، یا فایل انتقال واقعی پارسیان روی الگویی که خود دفتر از نصبش گرفته است. فایل بکاپ SQL Server ساخته نمی‌شود.',
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

/**
 * پایان سال شمسی: اسفند بسته به کبیسه ۲۹ یا ۳۰ روز است.
 *
 * قاعدهٔ کبیسه را از حفظ ننوشتم؛ از تقویم خود پلتفرم پرسیده می‌شود. روزهای
 * پیرامون نوروز سال بعد میلادی بررسی و بزرگ‌ترین روزِ ماه ۱۲ برداشته می‌شود.
 */
export function persianYearEnd(year, timeZone = 'Asia/Tehran') {
  // پایان سال شمسی Y در اسفند، یعنی مارس سال میلادی Y+۶۲۲ می‌افتد؛ نوروزِ
  // خودِ Y در Y+۶۲۱ است. اشتباه‌گرفتن این دو، هر سال را ۲۹ روزه نشان می‌داد.
  const gregorian = Number(year) + 622;
  let lastDay = 29;
  for (let day = 15; day <= 25; day += 1) {
    const token = persianDateToken(Date.UTC(gregorian, 2, day, 9), timeZone);
    const [tokenYear, month, dayOfMonth] = token.split('/');
    if (Number(tokenYear) === Number(year) && month === '12') lastDay = Math.max(lastDay, Number(dayOfMonth));
  }
  return `${year}/12/${String(lastDay).padStart(2, '0')}`;
}

/**
 * وقتی بازه‌ای ثبت نشده، سالِ خود سندها را پیشنهاد می‌دهد.
 *
 * پرسیدن «سال مالی باز پارسیان چیست؟» بدون پیشنهاد، کاربر را با یک فیلد خالی
 * تنها می‌گذارد — درحالی‌که تاریخ سندها همین‌جاست و در بیشتر پرونده‌ها بازه
 * دقیقاً همان سال شمسی است.
 */
export function suggestFiscalYearRange(documentDates = [], timeZone = 'Asia/Tehran') {
  const years = [...new Set(documentDates.map((item) => String(item || '').slice(0, 4)).filter((item) => /^\d{4}$/.test(item)))].sort();
  if (!years.length) return null;
  // چند سال در یک بسته یعنی بازه را نمی‌شود حدس زد؛ آن‌وقت پیشنهاد ندادن
  // صادقانه‌تر از پیشنهاد غلط است.
  if (years.length > 1) return null;
  const [year] = years;
  return { start: `${year}/01/01`, end: persianYearEnd(year, timeZone), year };
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

  // فایل انتقال پارسیان بدون الگو ساخته نمی‌شود، و بدون کد کل/معین روی هر ردیف
  // هم نه — چون فایل انتقال حساب نمی‌سازد و کد باید از قبل در مقصد باشد.
  if (normalizeTransferFileFormat(settings.fileFormat) === 'mdb') {
    checks.push({
      id: 'parsian-template', label: 'الگوی فایل انتقال پارسیان بارگذاری شده', count: settings.hasTransferTemplate ? 0 : 1,
      passed: Boolean(settings.hasTransferTemplate), severity: 'blocker',
    });
    const missingSegments = [...new Map(journalRows
      .filter((item) => !/^\d+$/.test(String(item.kolCode ?? '')) || !/^\d+$/.test(String(item.moeenCode ?? '')))
      .map((item) => [item.accountId, { id: item.accountId, code: item.accountCode, name: item.accountName }])).values()];
    checks.push({
      id: 'parsian-segments', label: 'هر حساب استفاده‌شده کد کل و معین عددی دارد', count: missingSegments.length,
      passed: missingSegments.length === 0, severity: 'blocker',
    });
    const fiscalYearStart = String(settings.fiscalYearStart || '').trim();
    const fiscalYearEnd = String(settings.fiscalYearEnd || '').trim();
    const validDate = /^\d{4}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/;
    const rangeValid = validDate.test(fiscalYearStart) && validDate.test(fiscalYearEnd) && fiscalYearStart <= fiscalYearEnd;
    const documents = [...new Map(journalRows.map((item) => {
      const date = persianDateToken(item.occurredAt, packageData.scope?.timeZone || 'Asia/Tehran');
      return [item.entryId, {
        entryId: item.entryId, documentNumber: item.documentNumber ?? null,
        date, memo: String(item.memo || '').slice(0, 120),
      }];
    })).values()];
    const outsideFiscalYear = rangeValid
      ? documents.filter((item) => !item.date || item.date < fiscalYearStart || item.date > fiscalYearEnd)
      : documents;
    checks.push({
      id: 'parsian-fiscal-year',
      label: rangeValid
        ? `همهٔ سندها داخل سال مالی مقصد (${fiscalYearStart} تا ${fiscalYearEnd}) هستند`
        : 'بازهٔ سال مالی باز پارسیان ثبت شده است',
      count: rangeValid ? outsideFiscalYear.length : 1,
      passed: rangeValid && outsideFiscalYear.length === 0,
      severity: 'blocker',
      fiscalYearStart, fiscalYearEnd,
      outsideDocuments: outsideFiscalYear.slice(0, 40),
      // بازهٔ پیشنهادی تا رابط بتواند به‌جای یک فیلد خالی، یک دکمه بدهد.
      suggestedFiscalYear: suggestFiscalYearRange(
        documents.map((item) => item.date),
        packageData.scope?.timeZone || 'Asia/Tehran',
      ),
    });
  }

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
  // فایل «انتقال اسناد» خود پارسیان. برخلاف دو قالب بالا این یکی برای خواندن
  // آدم نیست؛ مستقیم به «انتقال اسناد از فایل» پارسیان داده می‌شود و نیاز به
  // الگویی دارد که دفتر یک بار از نصب خودش گرفته باشد.
  mdb: Object.freeze({ id: 'mdb', label: 'فایل انتقال پارسیان', extension: 'mdb', mimeType: 'application/x-msaccess', requiresTemplate: true }),
});

export function normalizeTransferFileFormat(value) {
  return Object.hasOwn(TRANSFER_FILE_FORMATS, value) ? value : 'csv';
}

/**
 * ردیف‌های دفتر کل را به سندهای پارسیان تبدیل می‌کند.
 *
 * گروه‌بندی با شناسهٔ سند حساب‌یار است، چون فایل انتقال پارسیان سرصفحه ندارد و
 * فقط از روی تکرار شمارهٔ سند روی ردیف‌ها می‌فهمد کدام ردیف‌ها یک سندند.
 *
 * شمارهٔ سند حساب‌یار در شرح سند می‌رود، چون پارسیان موقع ورود شمارهٔ فایل را
 * دور می‌ریزد و خودش شماره می‌دهد؛ بدون این، سند پارسیان به سند حساب‌یار قابل
 * ردیابی نیست.
 */
export function parsianDocumentsFromJournal({ journalRows = [], timeZone = 'Asia/Tehran', amountUnit = 'toman' } = {}) {
  const multiplier = amountUnit === 'rial' ? 10 : 1;
  const errors = [];
  const order = [];
  const byEntry = new Map();

  journalRows.forEach((item, index) => {
    if (!byEntry.has(item.entryId)) {
      const documentNumber = item.documentNumber == null ? '' : String(item.documentNumber);
      byEntry.set(item.entryId, {
        date: persianDateToken(item.occurredAt, timeZone),
        comment: [documentNumber ? `حساب‌یار ${documentNumber}` : '', item.memo || ''].filter(Boolean).join(' — ').slice(0, 250),
        lines: [],
      });
      order.push(item.entryId);
    }
    const position = `ردیف ${index + 1}`;
    // کد کل و معین از کدینگ دفتر می‌آیند. پارسیان آن‌ها را عدد می‌خواهد و
    // حسابی که در مقصد نباشد ساخته نمی‌شود، پس نبودشان بازدارنده است.
    const kolCode = Number(item.kolCode);
    const moeenCode = Number(item.moeenCode);
    if (!Number.isInteger(kolCode) || kolCode <= 0) errors.push(`${position}: حساب «${item.accountName || item.accountCode || '—'}» کد کل ندارد؛ نگاشت کدینگ را کامل کن.`);
    if (!Number.isInteger(moeenCode) || moeenCode <= 0) errors.push(`${position}: حساب «${item.accountName || item.accountCode || '—'}» کد معین ندارد؛ نگاشت کدینگ را کامل کن.`);

    // تفصیلی اگر هست باید عدد باشد. تبدیل بی‌صدا به صفر یعنی ردیف روی معین
    // می‌نشیند و طرف‌حساب گم می‌شود، پس به‌جای حدس، خطا می‌دهیم.
    let tafsiliCode = 0;
    const rawTafsili = String(item.tafsiliCode ?? '').trim();
    if (rawTafsili) {
      if (!/^\d+$/.test(rawTafsili)) errors.push(`${position}: کد تفصیلی «${rawTafsili}» عدد نیست و پارسیان آن را نمی‌پذیرد.`);
      else tafsiliCode = Number(rawTafsili);
    }

    byEntry.get(item.entryId).lines.push({
      kolCode, moeenCode, tafsiliCode,
      debit: Number(item.debit || 0) * multiplier,
      credit: Number(item.credit || 0) * multiplier,
      comment: String(item.lineDescription || item.memo || '').slice(0, 100),
    });
  });

  if (errors.length) {
    throw Object.assign(new Error('ردیف‌های دفتر برای ساخت فایل پارسیان آماده نیستند.'), {
      status: 400, code: 'PARSIAN_JOURNAL_NOT_READY', details: { errors: errors.slice(0, 40) },
    });
  }
  return order.map((entryId) => byEntry.get(entryId));
}

export function splitParsianDocuments(documents = [], maxRows = PARSIAN_TRANSFER_LIMITS.maxRows) {
  const parts = [];
  let current = [];
  let currentRows = 0;
  for (const document of documents) {
    const rows = Array.isArray(document?.lines) ? document.lines.length : 0;
    if (rows > maxRows) {
      throw Object.assign(new Error(`یک سند ${rows} ردیف دارد و از سقف ${maxRows} ردیف یک فایل پارسیان بزرگ‌تر است؛ سند را نمی‌توان بین دو فایل شکست.`), {
        status: 409, code: 'PARSIAN_DOCUMENT_TOO_LARGE', details: { rowCount: rows, maxRows },
      });
    }
    if (current.length && currentRows + rows > maxRows) {
      parts.push(current); current = []; currentRows = 0;
    }
    current.push(document); currentRows += rows;
  }
  if (current.length) parts.push(current);
  return parts;
}

export function buildParsianMultipartPackage({ template, documents, period, buildPart = null }) {
  const groups = splitParsianDocuments(documents);
  const width = Math.max(3, String(groups.length).length);
  const parts = groups.map((group, index) => {
    const buffer = buildPart ? buildPart(group, index) : buildParsianTransfer({ template, documents: group });
    const rowCount = group.reduce((sum, document) => sum + document.lines.length, 0);
    const debitTotal = group.reduce((sum, document) => sum + document.lines.reduce((value, line) => value + Number(line.debit || 0), 0), 0);
    const creditTotal = group.reduce((sum, document) => sum + document.lines.reduce((value, line) => value + Number(line.credit || 0), 0), 0);
    return {
      name: `parsian-${period}-part-${String(index + 1).padStart(width, '0')}-of-${String(groups.length).padStart(width, '0')}.mdb`,
      buffer, rowCount, documentCount: group.length, debitTotal, creditTotal,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    };
  });
  const manifest = {
    schema: 'hasab-yar-parsian-multipart-v1', period, importOrder: parts.map((item) => item.name),
    warning: 'هر فایل را دقیقاً یک بار و به ترتیب فهرست‌شده وارد پارسیان کنید.',
    totals: {
      partCount: parts.length,
      rowCount: parts.reduce((sum, item) => sum + item.rowCount, 0),
      documentCount: parts.reduce((sum, item) => sum + item.documentCount, 0),
      debit: parts.reduce((sum, item) => sum + item.debitTotal, 0),
      credit: parts.reduce((sum, item) => sum + item.creditTotal, 0),
    },
    parts: parts.map(({ name, rowCount, documentCount, debitTotal, creditTotal, sha256 }) => (
      { name, rowCount, documentCount, debitTotal, creditTotal, sha256 }
    )),
  };
  const archive = buildZipArchive([
    { name: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: 'README-FA.txt', content: 'فایل‌ها را دقیقاً به ترتیب manifest.json و هرکدام فقط یک بار در پارسیان وارد کنید. هش SHA-256 هر بخش پیش از ورود قابل کنترل است.\n' },
    ...parts.map((item) => ({ name: item.name, content: item.buffer })),
  ]);
  return { archive, manifest };
}

/**
 * خروجی را طبق قالب ستونی دفتر می‌سازد — CSV، اکسل واقعی، یا فایل انتقال پارسیان.
 * در اکسل، شیت دوم عمداً «شناسنامهٔ فایل» است: واحد مبلغ، دوره، جمع‌ها و مرز
 * صراحت محصول، تا کسی فایل را بدون دانستن واحدش وارد نرم‌افزار نکند.
 */
export function buildAccountingTransferFile({ period, journalRows = [], settings = {}, mappings = [], timeZone = 'Asia/Tehran', fileFormat = 'csv', columns, amountUnit = 'toman', targetLabel = '', template = null } = {}) {
  const table = applyTransferTemplate({
    columns: columns && columns.length ? columns : DEFAULT_TRANSFER_COLUMNS,
    amountUnit, journalRows, period, mappings,
    persianDate: (value) => persianDateToken(value, timeZone),
  });
  const format = normalizeTransferFileFormat(fileFormat);
  if (format === 'csv') {
    const body = [table.headers, ...table.rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    return { buffer: Buffer.from(`﻿${body}\r\n`, 'utf8'), table };
  }
  if (format === 'mdb') {
    if (!template || !template.length) {
      throw Object.assign(new Error('برای ساخت فایل انتقال پارسیان اول باید الگو را بارگذاری کنی: یک بار در پارسیان خودت «انتقال اسناد به فایل» بگیر و همان فایل را اینجا بده.'), {
        status: 409, code: 'PARSIAN_TEMPLATE_MISSING',
      });
    }
    const documents = parsianDocumentsFromJournal({ journalRows, timeZone, amountUnit });
    const groups = splitParsianDocuments(documents);
    if (groups.length === 1) {
      return { buffer: buildParsianTransfer({ template, documents }), table, documentCount: documents.length,
        extension: 'mdb', mimeType: TRANSFER_FILE_FORMATS.mdb.mimeType, multipart: false };
    }
    const multipart = buildParsianMultipartPackage({ template, documents, period });
    return { buffer: multipart.archive, table, documentCount: documents.length, extension: 'zip', mimeType: 'application/zip',
      multipart: true, manifest: multipart.manifest };
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
