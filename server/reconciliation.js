import { createHash, randomUUID } from 'node:crypto';
import { unitLabel } from '../shared/amountUnit.js';
import { LEDGER_ONLY_SOURCES_SQL } from './balanceGuard.js';

function reconciliationError(message, code = 'RECONCILIATION_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function ensureColumn(database, table, definition) {
  try { database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`); }
  catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
}

export function ensureReconciliationSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS bank_statement_imports (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      file_name TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reconciled')),
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reconciled_by TEXT,
      reconciled_at TEXT,
      UNIQUE(account_id,file_hash)
    );
    CREATE TABLE IF NOT EXISTS bank_statement_lines (
      id TEXT PRIMARY KEY,
      import_id TEXT NOT NULL REFERENCES bank_statement_imports(id) ON DELETE CASCADE,
      row_number INTEGER NOT NULL,
      occurred_at TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount>0),
      direction TEXT NOT NULL CHECK(direction IN ('income','expense')),
      description TEXT NOT NULL DEFAULT '',
      reference TEXT NOT NULL DEFAULT '',
      statement_balance INTEGER,
      status TEXT NOT NULL DEFAULT 'unmatched' CHECK(status IN ('unmatched','matched','ignored')),
      transaction_id TEXT REFERENCES transactions(id) ON DELETE RESTRICT,
      resolution_note TEXT NOT NULL DEFAULT '',
      resolved_by TEXT,
      resolved_at TEXT,
      UNIQUE(import_id,row_number)
    );
    CREATE INDEX IF NOT EXISTS idx_statement_lines_import ON bank_statement_lines(import_id,status,occurred_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_statement_lines_transaction_unique
      ON bank_statement_lines(transaction_id) WHERE transaction_id IS NOT NULL;
  `);
  ensureColumn(database, 'bank_statement_imports', "format_name TEXT NOT NULL DEFAULT 'generic'");
  ensureColumn(database, 'bank_statement_imports', "column_map TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(database, 'bank_statement_imports', "import_warnings TEXT NOT NULL DEFAULT '[]'");
}

const digitMap = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9', '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
function latin(value) { return String(value ?? '').replace(/[۰-۹٠-٩]/g, (digit) => digitMap[digit]); }
function cleanHeader(value) { return latin(value).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_-]+/g, ''); }
function trunc(value) { return value < 0 ? Math.ceil(value) : Math.floor(value); }

function jalaliToGregorian(jy, jm, jd) {
  jy -= 979; jm -= 1; jd -= 1;
  let day = 365 * jy + trunc(jy / 33) * 8 + trunc((jy % 33 + 3) / 4);
  for (let index = 0; index < jm; index += 1) day += index < 6 ? 31 : 30;
  day += jd + 79;
  let gy = 1600 + 400 * trunc(day / 146097); day %= 146097;
  let leap = true;
  if (day >= 36525) {
    day -= 1; gy += 100 * trunc(day / 36524); day %= 36524;
    if (day >= 365) day += 1; else leap = false;
  }
  gy += 4 * trunc(day / 1461); day %= 1461;
  if (day >= 366) { leap = false; day -= 1; gy += trunc(day / 365); day %= 365; }
  const months = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gm < 12 && day >= months[gm]) { day -= months[gm]; gm += 1; }
  return [gy, gm + 1, day + 1];
}

function parseDate(value) {
  const normalized = latin(value).trim().replace(/[.]/g, '/');
  const parts = normalized.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!parts) throw reconciliationError(`تاریخ «${value}» قابل خواندن نیست.`, 'STATEMENT_DATE_INVALID');
  let [, year, month, day, hour = '12', minute = '00', second = '00'] = parts;
  let numbers = [Number(year), Number(month), Number(day)];
  if (numbers[0] < 1700) numbers = jalaliToGregorian(...numbers);
  const date = new Date(Date.UTC(numbers[0], numbers[1] - 1, numbers[2], Number(hour), Number(minute), Number(second)));
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() !== numbers[0] || date.getUTCMonth() !== numbers[1] - 1 || date.getUTCDate() !== numbers[2]) throw reconciliationError(`تاریخ «${value}» معتبر نیست.`, 'STATEMENT_DATE_INVALID');
  return date.toISOString();
}

function parseMoney(value, { allowNegative = false, allowZero = true } = {}) {
  const normalized = latin(value).trim().replace(/[٬,\s]/g, '').replace(/[(](.+)[)]/, '-$1');
  if (!normalized) return allowZero ? 0 : null;
  const amount = Math.round(Number(normalized));
  if (!Number.isSafeInteger(amount) || (!allowNegative && amount < 0) || Math.abs(amount) > 999_999_999_999) throw reconciliationError(`مبلغ «${value}» معتبر نیست.`, 'STATEMENT_AMOUNT_INVALID');
  return amount;
}

function splitCsvLine(line, separator) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === separator && !quoted) { cells.push(value.trim()); value = ''; }
    else value += char;
  }
  cells.push(value.trim());
  return cells;
}

const aliases = {
  date: ['date', 'transactiondate', 'effectivedate', 'تاریخ', 'تاریختراکنش', 'تاریخموثر', 'تاریخعملیات'],
  description: ['description', 'details', 'memo', 'narrative', 'شرح', 'توضیحات', 'بابت', 'شرحعملیات', 'شرحسند'],
  reference: ['reference', 'ref', 'tracking', 'documentno', 'پیگیری', 'شمارهپیگیری', 'مرجع', 'شمارهسند', 'شناسهتراکنش'],
  debit: ['debit', 'withdrawal', 'برداشت', 'بدهکار', 'مبلغبرداشت', 'گردشبدهکار'],
  credit: ['credit', 'deposit', 'واریز', 'بستانکار', 'مبلغواریز', 'گردشبستانکار'],
  amount: ['amount', 'مبلغ', 'مبلغتراکنش', 'گردش'],
  type: ['type', 'direction', 'نوع', 'نوعتراکنش', 'عملیات'],
  balance: ['balance', 'مانده', 'موجودی', 'ماندهحساب', 'موجودیپسازعملیات'],
};

export const BANK_CSV_FORMATS = [
  { id: 'mellat', label: 'بانک ملت', signatures: ['شرحعملیات', 'شمارهسند', 'موجودیپسازعملیات'] },
  { id: 'melli', label: 'بانک ملی', signatures: ['تاریخموثر', 'گردشبدهکار', 'گردشبستانکار'] },
  { id: 'saman', label: 'بانک سامان', signatures: ['شناسهتراکنش', 'مبلغبرداشت', 'مبلغواریز'] },
  { id: 'pasargad', label: 'بانک پاسارگاد', signatures: ['تاریخعملیات', 'شرحسند', 'ماندهحساب'] },
  { id: 'generic', label: 'CSV عمومی', signatures: [] },
];

function detectFormat(headers) {
  const normalized = headers.map(cleanHeader);
  return BANK_CSV_FORMATS.map((format) => ({
    ...format, matches: format.signatures.filter((signature) => normalized.includes(signature)).length,
  })).sort((a, b) => b.matches - a.matches)[0];
}

function columnMap(headers) {
  const normalized = headers.map(cleanHeader);
  const result = {};
  for (const [key, names] of Object.entries(aliases)) result[key] = normalized.findIndex((header) => names.includes(header));
  if (result.date < 0 || (result.amount < 0 && result.debit < 0 && result.credit < 0)) throw reconciliationError('ستون تاریخ و مبلغ در فایل پیدا نشد.', 'STATEMENT_COLUMNS_MISSING');
  return result;
}

export function parseBankCsv(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw reconciliationError('فایل بانکی خالی است یا ردیف داده ندارد.');
  if (lines.length > 5001) throw reconciliationError('حداکثر ۵۰۰۰ ردیف در هر فایل پذیرفته می‌شود.', 'STATEMENT_TOO_LARGE');
  const separator = [',', ';', '\t'].sort((a, b) => (lines[0].split(b).length - lines[0].split(a).length))[0];
  const headers = splitCsvLine(lines[0], separator);
  const columns = columnMap(headers);
  const format = detectFormat(headers);
  const warnings = [];
  if (columns.description < 0) warnings.push('ستون شرح پیدا نشد؛ پیشنهاد تطبیق فقط بر اساس مبلغ و تاریخ خواهد بود.');
  if (columns.balance < 0) warnings.push('ستون مانده پیدا نشد؛ کنترل اختلاف نهایی بانک و دفتر ممکن نیست.');
  if (!format.matches) warnings.push('قالب بانک مشخص نشد؛ نگاشت عمومی عنوان ستون‌ها استفاده شد.');
  const rows = [];
  for (let index = 1; index < lines.length; index += 1) {
    const cells = splitCsvLine(lines[index], separator);
    const debit = columns.debit >= 0 ? parseMoney(cells[columns.debit]) : 0;
    const credit = columns.credit >= 0 ? parseMoney(cells[columns.credit]) : 0;
    const signed = columns.amount >= 0 ? parseMoney(cells[columns.amount], { allowNegative: true }) : credit - debit;
    const typeText = columns.type >= 0 ? cleanHeader(cells[columns.type]) : '';
    const direction = ['expense', 'debit', 'برداشت', 'بدهکار'].includes(typeText) ? 'expense'
      : ['income', 'credit', 'واریز', 'بستانکار'].includes(typeText) ? 'income' : signed < 0 || debit > 0 ? 'expense' : 'income';
    const amount = Math.abs(signed || (direction === 'expense' ? debit : credit));
    if (!amount) continue;
    rows.push({
      rowNumber: index, occurredAt: parseDate(cells[columns.date]), amount, direction,
      description: columns.description >= 0 ? String(cells[columns.description] || '').trim().slice(0, 500) : '',
      reference: columns.reference >= 0 ? String(cells[columns.reference] || '').trim().slice(0, 120) : '',
      statementBalance: columns.balance >= 0 && String(cells[columns.balance] || '').trim() ? parseMoney(cells[columns.balance], { allowNegative: true }) : null,
    });
  }
  if (!rows.length) throw reconciliationError('هیچ ردیف مالی معتبری در فایل پیدا نشد.');
  Object.defineProperties(rows, {
    formatName: { value: format.matches ? format.label : 'CSV عمومی', enumerable: false },
    columnMap: { value: Object.fromEntries(Object.entries(columns).map(([key, index]) => [key, index >= 0 ? headers[index] : null])), enumerable: false },
    warnings: { value: warnings, enumerable: false },
  });
  return rows;
}

export function importBankStatement(database, { buffer, fileName, accountId }, { createdBy = null } = {}) {
  ensureReconciliationSchema(database);
  const account = database.prepare("SELECT id,name FROM accounts WHERE id=? AND active=1 AND kind IN ('cash','bank','wallet')").get(accountId);
  if (!account) throw reconciliationError('حساب صندوق، بانک یا کیف پول معتبر انتخاب کن.');
  const rows = parseBankCsv(buffer);
  const fileHash = createHash('sha256').update(buffer).digest('hex');
  const duplicate = database.prepare('SELECT id FROM bank_statement_imports WHERE account_id=? AND file_hash=?').get(account.id, fileHash);
  if (duplicate) throw reconciliationError('این فایل قبلاً برای همین حساب وارد شده است.', 'STATEMENT_DUPLICATE', 409);
  const id = randomUUID();
  const dates = rows.map((row) => row.occurredAt).sort();
  database.prepare(`INSERT INTO bank_statement_imports
    (id,account_id,file_name,file_hash,period_start,period_end,created_by,format_name,column_map,import_warnings) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, account.id, String(fileName || 'statement.csv').slice(0, 180), fileHash, dates[0], dates.at(-1), createdBy,
      rows.formatName, JSON.stringify(rows.columnMap), JSON.stringify(rows.warnings));
  const insert = database.prepare(`INSERT INTO bank_statement_lines
    (id,import_id,row_number,occurred_at,amount,direction,description,reference,statement_balance)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) insert.run(randomUUID(), id, row.rowNumber, row.occurredAt, row.amount, row.direction, row.description, row.reference, row.statementBalance);
  return getReconciliationImport(database, id);
}

function normalizedTerms(value) {
  return new Set(String(value || '').replace(/[۰-۹٠-٩]/g, (digit) => digitMap[digit]).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 3));
}

function candidateTransactions(database, line, accountId) {
  const candidates = database.prepare(`SELECT transactions.id,transactions.amount,transactions.type,transactions.category,
    transactions.raw_text AS rawText,transactions.occurred_at AS occurredAt,contacts.name AS contactName,
    ABS(julianday(transactions.occurred_at)-julianday(?)) AS dayDistance
    FROM transactions LEFT JOIN contacts ON contacts.id=transactions.contact_id
    WHERE transactions.status!='deleted' AND transactions.account_id=? AND transactions.amount=? AND transactions.type=?
      AND ABS(julianday(transactions.occurred_at)-julianday(?))<=3
      AND NOT EXISTS (SELECT 1 FROM bank_statement_lines WHERE bank_statement_lines.transaction_id=transactions.id)
    ORDER BY dayDistance,transactions.occurred_at LIMIT 8`)
    .all(line.occurredAt, accountId, line.amount, line.direction, line.occurredAt);
  const statementTerms = normalizedTerms(`${line.description} ${line.reference}`);
  return candidates.map((item) => {
    const transactionTerms = normalizedTerms(`${item.rawText} ${item.category} ${item.contactName || ''}`);
    const overlap = [...statementTerms].filter((term) => transactionTerms.has(term)).length;
    const dayDistance = Number(item.dayDistance);
    const dateScore = Math.max(0, 25 - dayDistance * 8);
    const textScore = Math.min(15, overlap * 5);
    const sameCalendarDay = String(item.occurredAt).slice(0, 10) === String(line.occurredAt).slice(0, 10);
    const score = sameCalendarDay && overlap > 0 ? 100 : Math.min(100, Math.max(0, Math.round(60 + dateScore + textScore)));
    const reasons = ['مبلغ، نوع و حساب دقیقاً برابر است.'];
    reasons.push(dayDistance < 0.25 ? 'تاریخ ثبت و بانک یک روز است.' : `فاصلهٔ تاریخ ${Math.max(1, Math.round(dayDistance))} روز است.`);
    if (overlap) reasons.push(`${overlap} واژهٔ مشترک در شرح پیدا شد.`);
    else reasons.push('واژهٔ مشترکی در شرح پیدا نشد.');
    return { ...item, score, reasons, evidence: { exactAmount: true, exactDirection: true, exactAccount: true, dayDistance, termOverlap: overlap } };
  }).sort((a, b) => b.score - a.score).slice(0, 3);
}

function importSummary(database, row) {
  const counts = database.prepare(`SELECT COUNT(*) AS rowCount,
    SUM(CASE WHEN status='matched' THEN 1 ELSE 0 END) AS matchedCount,
    SUM(CASE WHEN status='ignored' THEN 1 ELSE 0 END) AS ignoredCount,
    SUM(CASE WHEN status='unmatched' THEN 1 ELSE 0 END) AS unmatchedCount
    FROM bank_statement_lines WHERE import_id=?`).get(row.id);
  const lastBalance = database.prepare(`SELECT statement_balance AS balance FROM bank_statement_lines
    WHERE import_id=? AND statement_balance IS NOT NULL ORDER BY occurred_at DESC,row_number DESC LIMIT 1`).get(row.id)?.balance ?? null;
  const book = Number(database.prepare(`SELECT accounts.opening_balance + COALESCE(SUM(CASE WHEN transactions.type='income' THEN transactions.amount ELSE -transactions.amount END),0) AS balance
    FROM accounts LEFT JOIN transactions ON transactions.account_id=accounts.id AND transactions.status!='deleted' AND transactions.journal_deferred=0 AND transactions.occurred_at<=?
    WHERE accounts.id=? GROUP BY accounts.id`).get(row.periodEnd, row.accountId)?.balance ?? 0)
    // همان سندهای بی‌ردیف‌تراکنش که ماندهٔ حساب می‌شمارد (انتقال، سند دستی و بکاپ، افتتاحیهٔ اکسل)، تا پایان دورهٔ صورت‌حساب.
    + Number(database.prepare(`SELECT COALESCE(SUM(l.debit-l.credit),0) AS amount FROM journal_lines l
      JOIN ledger_accounts a ON a.id=l.account_id JOIN journal_entries j ON j.id=l.entry_id
      LEFT JOIN journal_entries original ON original.id=j.reverses_entry_id
      WHERE a.source_kind='operational-account' AND a.source_key=? AND j.occurred_at<=?
        AND (j.source_type IN (${LEDGER_ONLY_SOURCES_SQL}) OR original.source_type IN (${LEDGER_ONLY_SOURCES_SQL}))`).get(row.accountId, row.periodEnd)?.amount || 0);
  const summary = { ...row, ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value || 0)])), statementBalance: lastBalance, bookBalance: Number(book), difference: lastBalance == null ? null : Number(lastBalance) - Number(book) };
  summary.blockingReasons = [
    ...(summary.unmatchedCount ? [`${summary.unmatchedCount} ردیف هنوز تعیین‌تکلیف نشده است.`] : []),
    ...(summary.difference != null && summary.difference !== 0 ? [`ماندهٔ بانک و دفتر ${Math.abs(summary.difference).toLocaleString('fa-IR')} ${unitLabel()} اختلاف دارد.`] : []),
  ];
  summary.canClose = summary.status === 'open' && summary.blockingReasons.length === 0;
  return summary;
}

export function listReconciliationImports(database) {
  ensureReconciliationSchema(database);
  return database.prepare(`SELECT bank_statement_imports.id,bank_statement_imports.account_id AS accountId,accounts.name AS accountName,
    bank_statement_imports.file_name AS fileName,bank_statement_imports.period_start AS periodStart,bank_statement_imports.period_end AS periodEnd,
    bank_statement_imports.status,bank_statement_imports.format_name AS formatName,bank_statement_imports.column_map AS columnMap,
    bank_statement_imports.import_warnings AS importWarnings,bank_statement_imports.created_at AS createdAt,bank_statement_imports.reconciled_at AS reconciledAt
    FROM bank_statement_imports JOIN accounts ON accounts.id=bank_statement_imports.account_id ORDER BY bank_statement_imports.created_at DESC`)
    .all().map((row) => importSummary(database, {
      ...row,
      columnMap: JSON.parse(row.columnMap || '{}'),
      importWarnings: JSON.parse(row.importWarnings || '[]'),
    }));
}

export function getReconciliationImport(database, id) {
  const item = listReconciliationImports(database).find((row) => row.id === id);
  if (!item) return null;
  const rows = database.prepare(`SELECT id,row_number AS rowNumber,occurred_at AS occurredAt,amount,direction,description,reference,
    statement_balance AS statementBalance,status,transaction_id AS transactionId,resolution_note AS resolutionNote
    FROM bank_statement_lines WHERE import_id=? ORDER BY occurred_at,row_number`).all(id);
  item.lines = rows.map((line) => ({ ...line, candidates: line.status === 'unmatched' ? candidateTransactions(database, line, item.accountId) : [] }));
  return item;
}

export function getStatementLine(database, lineId) {
  ensureReconciliationSchema(database);
  return database.prepare(`SELECT bank_statement_lines.*,bank_statement_imports.account_id,bank_statement_imports.status AS import_status
    FROM bank_statement_lines JOIN bank_statement_imports ON bank_statement_imports.id=bank_statement_lines.import_id
    WHERE bank_statement_lines.id=?`).get(lineId) || null;
}

export function matchStatementLine(database, lineId, transactionId, { resolvedBy = null, note = 'تطبیق با ثبت موجود' } = {}) {
  const line = getStatementLine(database, lineId);
  if (!line || line.status !== 'unmatched' || line.import_status !== 'open') throw reconciliationError('ردیف باز برای تطبیق پیدا نشد.', 'STATEMENT_LINE_NOT_OPEN', 409);
  const transaction = database.prepare("SELECT id,amount,type,account_id FROM transactions WHERE id=? AND status!='deleted'").get(transactionId);
  if (!transaction || transaction.amount !== line.amount || transaction.type !== line.direction || transaction.account_id !== line.account_id) throw reconciliationError('تراکنش انتخاب‌شده از نظر حساب، نوع یا مبلغ با ردیف بانک برابر نیست.', 'STATEMENT_MATCH_MISMATCH', 409);
  try {
    database.prepare(`UPDATE bank_statement_lines SET status='matched',transaction_id=?,resolution_note=?,resolved_by=?,resolved_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='unmatched'`).run(transaction.id, String(note).slice(0, 300), resolvedBy, lineId);
  } catch (error) {
    if (/unique/i.test(error.message)) throw reconciliationError('این تراکنش قبلاً با ردیف دیگری تطبیق داده شده است.', 'STATEMENT_TRANSACTION_ALREADY_MATCHED', 409);
    throw error;
  }
  return getReconciliationImport(database, line.import_id);
}

export function ignoreStatementLine(database, lineId, reason, { resolvedBy = null } = {}) {
  const cleanReason = String(reason || '').trim().slice(0, 300);
  if (cleanReason.length < 5) throw reconciliationError('دلیل نادیده‌گرفتن را با حداقل ۵ نویسه ثبت کن.');
  const line = getStatementLine(database, lineId);
  if (!line || line.status !== 'unmatched' || line.import_status !== 'open') throw reconciliationError('ردیف باز پیدا نشد.', 'STATEMENT_LINE_NOT_OPEN', 409);
  database.prepare(`UPDATE bank_statement_lines SET status='ignored',resolution_note=?,resolved_by=?,resolved_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='unmatched'`).run(cleanReason, resolvedBy, lineId);
  return getReconciliationImport(database, line.import_id);
}

export function closeReconciliation(database, importId, userId) {
  const item = getReconciliationImport(database, importId);
  if (!item || item.status !== 'open') throw reconciliationError('تطبیق باز پیدا نشد.', 'RECONCILIATION_NOT_OPEN', 409);
  if (item.unmatchedCount > 0) throw reconciliationError('همهٔ ردیف‌ها باید تطبیق یا با دلیل نادیده گرفته شوند.', 'RECONCILIATION_INCOMPLETE', 409);
  if (item.difference != null && item.difference !== 0) throw reconciliationError('ماندهٔ بانک و دفتر برابر نیست؛ اختلاف را پیش از بستن بررسی کن.', 'RECONCILIATION_DIFFERENCE', 409);
  database.prepare("UPDATE bank_statement_imports SET status='reconciled',reconciled_by=?,reconciled_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").run(userId, importId);
  return getReconciliationImport(database, importId);
}
