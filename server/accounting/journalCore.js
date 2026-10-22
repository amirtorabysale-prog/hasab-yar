// هستهٔ ثبت سند: اعتبار ردیف‌ها، بازنگری و سند معکوس، دورهٔ باز، سندهای تحویل‌شده به حسابدار و واردشده از پارسیان، ترمیم نگاشت حساب‌های نقدی، و ثبت و برگشت عمومی سند.
//
// از server/accounting.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// accounting همه از همان server/accounting.js می‌خوانند.

import { randomUUID } from 'node:crypto';
import { approvalRequiredError, currentApproval, recordOverdraftApproval } from '../balanceGuard.js';
import { listChartAccounts, mapLedgerAccountToChart, resolveLineDimensions } from '../chartOfAccounts.js';
import { nextDocumentNumber, normalizeApprovalState } from '../journalWorkflow.js';
import { accountingError, ensureAccountingSchema, fiscalYearForDate, isPettyCashAccount, periodForDate } from './ledgerAccounts.js';

export function validateLines(database, lines) {
  // سقف بالا عمداً بزرگ است: سند حقوق یک آرتیکل به‌ازای هر نفر دارد تا
  // بدهی هر پرسنل جدا دیده و جدا تسویه شود.
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > 1000) throw accountingError('سند باید بین دو تا هزار آرتیکل داشته باشد.');
  let debit = 0;
  let credit = 0;
  const normalized = lines.map((line) => {
    const accountId = String(line.accountId || '').trim();
    if (!database.prepare('SELECT 1 FROM ledger_accounts WHERE id=? AND active=1').get(accountId)) throw accountingError('یکی از حساب‌های دفتر کل معتبر یا فعال نیست.');
    const lineDebit = Math.round(Number(line.debit) || 0);
    const lineCredit = Math.round(Number(line.credit) || 0);
    if (!Number.isSafeInteger(lineDebit) || !Number.isSafeInteger(lineCredit) || (lineDebit > 0) === (lineCredit > 0)) throw accountingError('هر آرتیکل باید فقط بدهکار یا فقط بستانکار و دارای مبلغ مثبت باشد.');
    debit += lineDebit;
    credit += lineCredit;
    const dimensions = resolveLineDimensions(database, line);
    return {
      accountId, debit: lineDebit, credit: lineCredit,
      description: String(line.description || '').slice(0, 300),
      ...dimensions,
    };
  });
  if (debit !== credit || debit <= 0) throw accountingError('جمع بدهکار و بستانکار سند برابر نیست.', 'JOURNAL_UNBALANCED');
  return { lines: normalized, total: debit };
}

export function nextRevision(database, sourceType, sourceId) {
  return Number(database.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM journal_entries WHERE source_type=? AND source_id=?').get(sourceType, sourceId).revision) + 1;
}

/**
 * آرتیکل معکوسِ یک آرتیکل.
 *
 * بدهکار و بستانکار جا عوض می‌کنند و **همهٔ ابعاد سطر با آن می‌آیند**. تفصیلی و
 * مرکز هزینه جزو هویت سطرند، نه زینت: سطر اصلی روی «شرکت الف» نشسته و اگر
 * معکوسش روی خودِ معین بنشیند، بدهی آن شرکت در دفتر تفصیلی هرگز بسته نمی‌شود —
 * و در پارسیان همان سطرِ بی‌تفصیلی روی معینِ تفصیلی‌دار کنار گذاشته می‌شود و
 * سند را نامتوازن نشان می‌دهد.
 */
export function reversedLine(line) {
  return {
    accountId: line.accountId,
    debit: line.credit,
    credit: line.debit,
    description: line.description,
    analyticId: line.analyticId || null,
    costCenterId: line.costCenterId || null,
  };
}

/**
 * نگاشت قدیمی و اشتباهِ حساب‌های پول به کدینگ.
 *
 * نسخه‌های قدیمی حساب بانکی را گاهی روی معین «صندوق» می‌نشاندند (و تنخواه را
 * روی صندوق). نگهبانِ ثبت جلوی سند تازه روی چنین حسابی را می‌گیرد، چون ماندهٔ
 * بانک و صندوق در تراز کدینگ و فایل پارسیان قاطی می‌شود. ولی جواب درست معمولاً
 * معلوم است: کدینگ دفتر یک معین بانک دارد. پس همان‌جا اصلاح می‌شود و ردش می‌ماند.
 *
 * توقف فقط وقتی است که جواب معلوم نیست — هیچ معین بانکی، چند معین بانک بی‌نامِ
 * منطبق — یا اصلاح، دورهٔ بسته‌شده را تغییر می‌دهد. پیام دقیقاً همان را می‌گوید.
 */
const OPERATIONAL_ROLES = new Set(['cash', 'bank', 'petty-cash']);

function ensureChartMappingRepairLog(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS chart_mapping_repairs (
    id TEXT PRIMARY KEY, ledger_account_id TEXT NOT NULL, from_chart_id TEXT, to_chart_id TEXT NOT NULL,
    reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
}

export function repairOperationalChartMapping(database, ledgerAccountId, { timeZone = 'Asia/Tehran' } = {}) {
  const row = database.prepare(`SELECT a.id,a.name,a.type,a.chart_account_id AS chartId,c.role AS chartRole,c.code AS chartCode,c.name AS chartName,
      o.id AS accountId,o.name AS accountName,o.kind,o.bank_id AS bankId
    FROM ledger_accounts a JOIN accounts o ON a.source_kind='operational-account' AND a.source_key=o.id
    LEFT JOIN chart_accounts c ON c.id=a.chart_account_id WHERE a.id=?`).get(String(ledgerAccountId || ''));
  if (!row || !row.chartId || !OPERATIONAL_ROLES.has(row.chartRole)) return { status: 'not-applicable' };
  const petty = isPettyCashAccount(database, row.accountId);
  const expectedRole = petty || row.kind === 'petty' ? 'petty-cash' : row.kind === 'bank' || row.bankId ? 'bank' : 'cash';
  if (row.chartRole === expectedRole) return { status: 'ok' };
  const label = { bank: 'بانک', cash: 'صندوق', 'petty-cash': 'تنخواه‌گردان' };
  const what = `حساب ${label[expectedRole]} «${row.accountName}» به معین ${label[row.chartRole]} (${row.chartCode} ${row.chartName}) نگاشت شده است`;
  const candidates = listChartAccounts(database).filter((item) => item.level === 'subsidiary' && item.active && item.type === row.type && item.role === expectedRole);
  // چند معین بانک (یکی برای هر بانک): همان که نامش با نام این حساب می‌خواند — «جاری سامان» → «بانک سامان».
  const tokens = String(row.accountName || '').split(/\s+/).filter((word) => word.length > 1 && !/^(?:جاری|حساب|بانک|کارت|سپرده|کوتاه|مدت|قرض|الحسنه)$/.test(word));
  const named = candidates.filter((item) => tokens.some((word) => String(item.name || '').includes(word)));
  const target = candidates.length === 1 ? candidates[0] : named.length === 1 ? named[0] : null;
  const ambiguous = candidates.length > 1 && !target;
  if (!target) {
    return { status: 'blocked', message: `${what}. در کدینگ حساب‌ها ${ambiguous ? `چند معین ${label[expectedRole]} هست؛ معین درست این حساب را` : `معینی با نقش «${label[expectedRole]}» تعریف کن و این حساب را`} به آن نگاشت کن و دوباره ثبت کن.` };
  }
  // سندهای قبلیِ همین حساب با نگاشت تازه در تراز کدینگ جابه‌جا می‌شوند؛ دورهٔ بسته نباید عوض شود.
  const locked = new Set(database.prepare("SELECT period FROM accounting_periods WHERE status='locked'").all().map((item) => item.period));
  if (locked.size) {
    const touched = database.prepare(`SELECT DISTINCT journal_entries.occurred_at AS at FROM journal_lines
      JOIN journal_entries ON journal_entries.id=journal_lines.entry_id WHERE journal_lines.account_id=?`).all(row.id)
      .some((item) => locked.has(periodForDate(item.at, timeZone)));
    if (touched) return { status: 'blocked', message: `${what} و این حساب در دورهٔ بسته‌شده سند دارد؛ اصلاح نگاشت آن دوره را عوض می‌کند. حسابدار نگاشت را در کدینگ حساب‌ها اصلاح کند.` };
  }
  mapLedgerAccountToChart(database, row.id, target.id);
  ensureChartMappingRepairLog(database);
  database.prepare('INSERT INTO chart_mapping_repairs (id,ledger_account_id,from_chart_id,to_chart_id,reason) VALUES (?,?,?,?,?)')
    .run(randomUUID(), row.id, row.chartId, target.id, `${what}؛ خودکار به ${target.code} ${target.name} اصلاح شد.`);
  return { status: 'repaired', from: { id: row.chartId, code: row.chartCode, name: row.chartName }, to: { id: target.id, code: target.code, name: target.name } };
}

/**
 * سندی که به پارسیان رفته، بی‌صدا عوض نمی‌شود.
 *
 * وقتی بستهٔ انتقال «تحویل‌شده» یا «پذیرفته‌شده» است، اسناد داخلش در دفتر
 * مقصد هم هست. ویرایش یا حذف ردیفِ پشت آن سند (که این‌جا با معکوس و سند تازه
 * انجام می‌شود) دو دفتر را از هم جدا می‌کند. پس معکوس کردن چنین سندی فقط با
 * تأیید حسابدار ممکن است و سند معکوس و جایگزین «اصلاحیه» نام می‌گیرند تا در
 * بستهٔ بعدی دیده شوند.
 */
export function ensureTransferEntriesSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS accounting_transfer_entries (
    batch_id TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY (batch_id, entry_id));
    CREATE INDEX IF NOT EXISTS idx_transfer_entries_entry ON accounting_transfer_entries(entry_id)`);
}

export function recordTransferBatchEntries(database, batchId, entryIds = []) {
  ensureTransferEntriesSchema(database);
  const insert = database.prepare('INSERT OR IGNORE INTO accounting_transfer_entries (batch_id,entry_id) VALUES (?,?)');
  for (const entryId of new Set(entryIds)) insert.run(batchId, entryId);
}

/**
 * سندهایی که از بکاپ پارسیان آمده‌اند همین حالا در پارسیان هستند.
 *
 * فرستادن دوباره‌شان یعنی سند تکراری در دفتر مشتری، چون پارسیان تکراری را
 * تشخیص نمی‌دهد. پس فایل انتقال پارسیان آن‌ها را نمی‌برد. این سندها معکوس‌پذیر
 * نیستند (فقط سند `normal` معکوس می‌شود)؛ اصلاحشان سند اصلاحی تازه است که
 * مثل هر ثبت تازه به پارسیان می‌رود.
 */
export function ensureParsianSourceSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS parsian_imported_entries (
    entry_id TEXT PRIMARY KEY, sanad INTEGER, file_sha256 TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')))`);
}

/** بستهٔ تحویل‌شده‌ای که این سند در آن رفته؛ `null` اگر هنوز صادر نشده. */
export function exportedBatchOf(database, entryId, { timeZone = 'Asia/Tehran' } = {}) {
  let batches;
  try {
    batches = database.prepare(`SELECT id,file_name AS fileName,period,status,created_at AS createdAt,
      first_downloaded_at AS firstDownloadedAt,
      EXISTS(SELECT 1 FROM accounting_transfer_entries e WHERE e.batch_id=accounting_transfer_batches.id) AS listed,
      EXISTS(SELECT 1 FROM accounting_transfer_entries e WHERE e.batch_id=accounting_transfer_batches.id AND e.entry_id=?) AS contains
      FROM accounting_transfer_batches WHERE status IN ('delivered','accepted') ORDER BY created_at`).all(String(entryId || ''));
  } catch (error) {
    if (/no such table/i.test(error.message)) { ensureTransferEntriesSchema(database); return exportedBatchOf(database, entryId, { timeZone }); }
    throw error;
  }
  if (!batches.length) return null;
  const listed = batches.find((batch) => batch.contains);
  if (listed) return listed;
  // بسته‌های پیش از این نسخه فهرست سند ندارند: سند همان دوره که پیش از ساخت
  // بسته ثبت شده بود، در آن بسته رفته است (افتتاحیه به پارسیان نمی‌رود).
  const legacy = batches.filter((batch) => !batch.listed);
  if (!legacy.length) return null;
  const entry = database.prepare(`SELECT j.occurred_at AS occurredAt,j.created_at AS createdAt,j.entry_kind AS entryKind,
    original.entry_kind AS originalKind FROM journal_entries j LEFT JOIN journal_entries original ON original.id=j.reverses_entry_id WHERE j.id=?`).get(String(entryId || ''));
  if (!entry || entry.entryKind === 'opening' || entry.originalKind === 'opening') return null;
  const period = periodForDate(entry.occurredAt, timeZone);
  return legacy.find((batch) => batch.period === period && String(entry.createdAt) <= String(batch.createdAt)) || null;
}

function assertExportedEntryCorrection(database, values) {
  if (!values.reversesEntryId) return values;
  const batch = exportedBatchOf(database, values.reversesEntryId, { timeZone: values.timeZone || 'Asia/Tehran' });
  if (!batch) return values;
  const original = database.prepare('SELECT document_number AS documentNumber,fiscal_year AS fiscalYear,memo FROM journal_entries WHERE id=?').get(values.reversesEntryId) || {};
  const item = { accountId: `entry:${values.reversesEntryId}`, entryId: values.reversesEntryId, name: `سند ${original.documentNumber ?? '—'} سال ${original.fiscalYear ?? '—'}`,
    memo: original.memo || '', batchId: batch.id, fileName: batch.fileName, period: batch.period, before: 0, after: 0 };
  const approval = currentApproval(database);
  if (!approval) {
    throw approvalRequiredError('export', `${item.name} در بستهٔ ${batch.period} به پارسیان رفته است («${batch.fileName}»). اصلاح یا حذفِ آن، دفتر حساب‌یار و پارسیان را از هم جدا می‌کند؛ فقط با سند اصلاحیه و تأیید حسابدار ممکن است و حسابدار باید همان اصلاحیه را در پارسیان هم وارد کند.`, [item]);
  }
  recordOverdraftApproval(database, [item], approval, 'export');
  return { ...values, memo: `اصلاحیهٔ سند صادرشده به پارسیان (${item.name}) — ${values.memo || ''}`.trim() };
}

export function insertJournal(database, rawValues) {
  const values = assertExportedEntryCorrection(database, rawValues);
  // نگاشت قدیمیِ اشتباهِ بانک، صندوق یا تنخواه پیش از ثبت اصلاح می‌شود، اگر جواب
  // معلوم باشد؛ وگرنه ثبت با پیامی که دقیقاً می‌گوید چه کنی متوقف می‌شود.
  // سند افتتاحیه و معکوس، تاریخچه‌اند و همان‌طور قابل استفاده می‌مانند.
  if ((values.entryKind || 'normal') === 'normal') {
    for (const line of values.lines || []) {
      const repair = repairOperationalChartMapping(database, line.accountId, { timeZone: values.timeZone || 'Asia/Tehran' });
      if (repair.status === 'blocked') throw accountingError(repair.message, 'BANK_CHART_MAPPING_INVALID');
    }
  }
  const validated = validateLines(database, values.lines);
  const id = randomUUID();
  // شماره در همان لحظهٔ درج و در همان تراکنش گرفته می‌شود تا دنبالهٔ سال مالی گپ نگیرد.
  const fiscalYear = fiscalYearForDate(values.occurredAt, values.timeZone || 'Asia/Tehran');
  const documentNumber = nextDocumentNumber(database, fiscalYear);
  // سند خودکار سیستم «کنترل‌شده» است؛ فقط ثبت دستی و انبوه وارد گردش تأیید می‌شوند.
  const approvalState = normalizeApprovalState(values.approvalState || 'approved');
  database.prepare(`INSERT INTO journal_entries
    (id,source_type,source_id,revision,entry_kind,occurred_at,memo,reverses_entry_id,created_by,
     document_number,fiscal_year,approval_state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, values.sourceType, values.sourceId, values.revision, values.entryKind || 'normal', values.occurredAt, String(values.memo || '').slice(0, 500), values.reversesEntryId || null, values.createdBy || null, documentNumber, fiscalYear, approvalState);
  const insert = database.prepare('INSERT INTO journal_lines (id,entry_id,account_id,debit,credit,description,analytic_id,cost_center_id) VALUES (?,?,?,?,?,?,?,?)');
  for (const line of validated.lines) insert.run(randomUUID(), id, line.accountId, line.debit, line.credit, line.description, line.analyticId || null, line.costCenterId || null);
  return { id, total: validated.total, documentNumber, fiscalYear, approvalState };
}

export function assertAccountingPeriodOpen(database, period) {
  ensureAccountingSchema(database);
  const row = database.prepare('SELECT status FROM accounting_periods WHERE period=?').get(period);
  if (row?.status === 'locked') throw accountingError(`دورهٔ ${period} بسته شده و قابل تغییر نیست.`, 'ACCOUNTING_PERIOD_LOCKED', 409);
}

/**
 * ورودی عمومی لایهٔ ثبت.
 *
 * `accounting.js` از این پس دو نقش دارد و باید به یکی برسد: مجموعهٔ توابع
 * `postXJournal` که هم **تصمیم** می‌گیرند سند چه باشد و هم آن را **ثبت**
 * می‌کنند. تصمیم باید به `shared/accountingRules.js` برود و اینجا فقط اجرا
 * بماند.
 *
 * این تابع همان ورودیِ «فقط اجرا» است: یک سند از پیش تصمیم‌گرفته‌شده را ثبت
 * می‌کند و هیچ نظری دربارهٔ محتوایش ندارد. توابع قدیمی دست‌نخورده می‌مانند تا
 * مهاجرت تدریجی و بی‌ریسک باشد.
 *
 * `sourceType` و `sourceId` یکتایی را تضمین می‌کنند: ثبت دوبارهٔ یک رویداد
 * همین‌جا رد می‌شود، نه در لایهٔ بالاتر که ممکن است دور زده شود.
 */
export function postJournalEntry(database, values, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const sourceType = String(values.sourceType || '').trim();
  const sourceId = String(values.sourceId || '').trim();
  if (!sourceType || !sourceId) throw accountingError('منبع سند برای ثبت لازم است.', 'JOURNAL_SOURCE_MISSING');
  const occurredAt = values.occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));

  const existing = database.prepare(
    "SELECT id,document_number AS documentNumber FROM journal_entries WHERE source_type=? AND source_id=? AND entry_kind='normal'",
  ).get(sourceType, sourceId);
  if (existing) throw accountingError('برای این رویداد از قبل سند ثبت شده است.', 'JOURNAL_DUPLICATE', 409);

  return insertJournal(database, {
    sourceType,
    sourceId,
    revision: nextRevision(database, sourceType, sourceId),
    entryKind: values.entryKind || 'normal',
    occurredAt,
    memo: values.memo || '',
    createdBy,
    timeZone,
    approvalState: values.approvalState || 'approved',
    lines: values.lines,
  });
}

/**
 * سند معکوس برای یک رویداد.
 *
 * سند ثبت‌شده هرگز حذف نمی‌شود. حسابرسی باید بتواند بگوید چه چیزی ثبت شد، چه
 * کسی اصلاحش کرد و چرا؛ حذف، همین زنجیره را پاک می‌کند و هیچ راهی برای
 * بازسازی‌اش نمی‌ماند.
 */
export function reverseJournalEntry(database, { sourceType, sourceId, occurredAt, memo = 'سند معکوس', createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const prior = database.prepare(
    "SELECT id,occurred_at AS occurredAt FROM journal_entries WHERE source_type=? AND source_id=? AND entry_kind='normal' ORDER BY revision DESC LIMIT 1",
  ).get(String(sourceType || ''), String(sourceId || ''));
  if (!prior) return null;
  const already = database.prepare("SELECT 1 FROM journal_entries WHERE reverses_entry_id=?").get(prior.id);
  if (already) throw accountingError('این سند قبلاً معکوس شده است.', 'JOURNAL_ALREADY_REVERSED', 409);

  const lines = database.prepare(`SELECT account_id AS accountId,debit,credit,description,
    analytic_id AS analyticId,cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=? ORDER BY rowid`)
    .all(prior.id).map((line) => reversedLine(line));
  const at = occurredAt || prior.occurredAt;
  assertAccountingPeriodOpen(database, periodForDate(at, timeZone));
  return insertJournal(database, {
    sourceType, sourceId, revision: nextRevision(database, sourceType, sourceId), entryKind: 'reversal',
    occurredAt: at, memo, reversesEntryId: prior.id, createdBy, timeZone, lines,
  });
}
