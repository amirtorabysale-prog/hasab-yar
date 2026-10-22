// راه‌اندازی دفتر: ماندهٔ افتتاحیه (دستی و واردشده)، کوچ دفتر قدیمی و تفصیلی طرف حساب‌ها.
//
// از server/accounting.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// accounting همه از همان server/accounting.js می‌خوانند.

import { randomUUID } from 'node:crypto';
import { counterpartyAnalyticForKey, ensureChartSchema } from '../chartOfAccounts.js';
import { backfillDocumentNumbers } from '../journalWorkflow.js';
import { accountingError, ensureAccountingSchema, fiscalYearForDate, nextCode, operationalLedgerAccount, periodForDate } from './ledgerAccounts.js';
import { nextRevision, reversedLine, insertJournal, assertAccountingPeriodOpen } from './journalCore.js';
import { syncTransactionJournal } from './documents.js';

export function syncOpeningBalanceJournal(database, operationalAccountId, { createdBy = null } = {}) {
  ensureAccountingSchema(database);
  const account = database.prepare('SELECT id,name,opening_balance AS openingBalance,created_at AS createdAt FROM accounts WHERE id=?').get(operationalAccountId);
  if (!account) return null;
  const sourceId = account.id;
  const prior = database.prepare(`SELECT * FROM journal_entries WHERE source_type='opening_balance' AND source_id=? AND entry_kind='opening' ORDER BY revision DESC LIMIT 1`).get(sourceId);
  if (prior && !database.prepare('SELECT 1 FROM journal_entries WHERE reverses_entry_id=?').get(prior.id)) {
    const lines = database.prepare(`SELECT account_id AS accountId,debit,credit,description,
      analytic_id AS analyticId,cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=? ORDER BY rowid`)
      .all(prior.id).map((line) => reversedLine(line));
    insertJournal(database, { sourceType: 'opening_balance', sourceId, revision: nextRevision(database, 'opening_balance', sourceId), entryKind: 'reversal', occurredAt: prior.occurred_at, memo: `معکوس مانده افتتاحیه ${account.name}`, reversesEntryId: prior.id, createdBy, lines });
  }
  const amount = Math.abs(Math.round(Number(account.openingBalance) || 0));
  if (!amount) return null;
  const asset = operationalLedgerAccount(database, account.id);
  const equity = 'ledger-opening-equity';
  const positive = Number(account.openingBalance) > 0;
  return insertJournal(database, {
    sourceType: 'opening_balance', sourceId, revision: nextRevision(database, 'opening_balance', sourceId), entryKind: 'opening',
    occurredAt: account.createdAt || new Date().toISOString(), memo: `مانده افتتاحیه ${account.name}`, createdBy,
    lines: positive ? [{ accountId: asset, debit: amount }, { accountId: equity, credit: amount }] : [{ accountId: equity, debit: amount }, { accountId: asset, credit: amount }],
  });
}

/**
 * ماندهٔ افتتاحیهٔ واردشده از نرم‌افزار مقصد را به یک سند افتتاحیهٔ متوازن
 * تبدیل می‌کند. ورود دوباره، سند قبلی را معکوس می‌کند و سند تازه می‌سازد؛
 * تاریخچه بازنویسی نمی‌شود.
 */
/**
 * تاریخ شروع ثبت در این دفتر: نخستین سند عملیاتی، بدون اسناد افتتاحیه.
 *
 * مانده‌ای که در طرف «سرمایهٔ افتتاحیه» می‌نشیند فقط تا این تاریخ معنا دارد؛
 * بعد از آن، بدهی یا طلب از خرید و فروش همین دوره آمده و سند خودش را می‌خواهد.
 */
export function ledgerStartDate(database) {
  ensureAccountingSchema(database);
  return database.prepare(`SELECT MIN(substr(occurred_at,1,10)) d FROM journal_entries
    WHERE entry_kind='normal' AND source_type NOT IN ('opening_balance','opening_import','review-prior-basis')`).get()?.d || null;
}

export function postImportedOpeningBalances(database, prepared = [], { occurredAt, memo = 'ماندهٔ افتتاحیهٔ واردشده', createdBy = null, timeZone = 'Asia/Tehran', replace = false } = {}) {
  ensureAccountingSchema(database);
  // افتتاحیهٔ دفتری که سابقه دارد، پیش‌فرض در روز شروع ثبت می‌نشیند، نه امروز؛
  // وگرنه سرمایهٔ افتتاحیه وسط سال و بعد از عملیات واقعی ظاهر می‌شود.
  const start = ledgerStartDate(database);
  if (occurredAt && start && String(occurredAt).slice(0, 10) > start) {
    throw accountingError(`تاریخ ماندهٔ افتتاحیه باید روز شروع ثبت در این دفتر (${start}) یا پیش از آن باشد؛ مانده‌ای که بعد از آن ایجاد شده، سند اصلی خودش را لازم دارد.`, 'OPENING_DATE_AFTER_START', 409);
  }
  const postedAt = occurredAt || (start ? `${start}T00:00:00.000Z` : new Date().toISOString());
  assertAccountingPeriodOpen(database, periodForDate(postedAt, timeZone));

  const prior = database.prepare(`SELECT * FROM journal_entries WHERE source_type='opening_import'
    AND entry_kind='opening' ORDER BY revision DESC,created_at DESC LIMIT 1`).get();
  const priorLive = prior && !database.prepare('SELECT 1 FROM journal_entries WHERE reverses_entry_id=?').get(prior.id);
  if (priorLive && !replace) {
    throw accountingError('برای این دفتر از قبل سند افتتاحیهٔ واردشده وجود دارد؛ برای جایگزینی گزینهٔ جایگزینی را روشن کن.', 'OPENING_IMPORT_EXISTS', 409);
  }
  if (priorLive) {
    const reverseLines = database.prepare(`SELECT account_id AS accountId,debit,credit,description,
      analytic_id AS analyticId,cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=? ORDER BY rowid`)
      .all(prior.id).map((line) => reversedLine(line));
    insertJournal(database, {
      sourceType: 'opening_import', sourceId: prior.source_id,
      revision: nextRevision(database, 'opening_import', prior.source_id), entryKind: 'reversal',
      occurredAt: postedAt, memo: 'معکوس ماندهٔ افتتاحیهٔ قبلی', reversesEntryId: prior.id, createdBy, lines: reverseLines,
    });
  }

  const sourceId = randomUUID();
  const lines = prepared.map((item) => ({
    accountId: item.ledgerAccountId,
    debit: item.debit || 0,
    credit: item.credit || 0,
    description: item.name || '',
    analyticId: item.analyticId || null,
  }));
  const result = insertJournal(database, {
    sourceType: 'opening_import', sourceId, revision: 1, entryKind: 'opening',
    occurredAt: postedAt, memo, createdBy, lines,
  });
  return { ...result, replacedEntryId: priorLive ? prior.id : null, lineCount: lines.length };
}

// برای ماژول ورود داده: ساخت کد داخلی تازه در همان بازه‌های همیشگی.
export function nextLedgerCode(database, type) {
  return nextCode(database, type);
}

export function migrateAccountingLedger(database, { createdBy = null } = {}) {
  ensureAccountingSchema(database);
  // دفترهایی که پیش از این قابلیت ساخته شده‌اند این ستون را ندارند و پرس‌وجوی
  // پایین بدون آن می‌شکند.
  try { database.exec('ALTER TABLE transactions ADD COLUMN journal_deferred INTEGER NOT NULL DEFAULT 0'); }
  catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
  const accounts = database.prepare('SELECT id FROM accounts').all();
  for (const account of accounts) {
    const exists = database.prepare("SELECT 1 FROM journal_entries WHERE source_type='opening_balance' AND source_id=?").get(account.id);
    if (!exists) syncOpeningBalanceJournal(database, account.id, { createdBy });
  }
  // تراکنشی که سندش عمداً منتظر تأیید مانده، «بی‌سند» نیست؛ نباید اینجا سند بخورد.
  const transactions = database.prepare(`SELECT id,amount,type,category,raw_text AS rawText,account_id AS accountId,occurred_at AS occurredAt,topic_label AS topicLabel
    FROM transactions WHERE status NOT IN ('deleted','allocated')
      AND COALESCE(journal_deferred,0)=0 ORDER BY occurred_at,id`).all();
  for (const transaction of transactions) {
    const exists = database.prepare("SELECT 1 FROM journal_entries WHERE source_type='transaction' AND source_id=?").get(transaction.id);
    if (!exists) syncTransactionJournal(database, transaction, { createdBy });
  }
  // اسناد پیش از فاز ۳ شماره ندارند؛ به ترتیب تاریخ وقوع شماره می‌گیرند.
  const numbered = backfillDocumentNumbers(database, (occurredAt) => fiscalYearForDate(occurredAt));
  return { accounts: accounts.length, transactions: transactions.length, numbered: numbered.numbered };
}

// حساب‌هایی که خودشان مالِ یک طرف حساب‌اند: نامشان همان شخص است.
const COUNTERPARTY_SOURCE_KINDS = ['customer-receivable', 'vendor-payable', 'cheque-receivable', 'cheque-payable'];

/**
 * چسباندن تفصیلی به ردیف‌هایی که از قبل بی‌تفصیلی ثبت شده‌اند.
 *
 * تا پیش از این، رویدادی که طرف حسابش در دفتر ثبت نشده بود حساب اختصاصی
 * می‌گرفت ولی تفصیلی نمی‌گرفت. در پارسیان معین دریافتنی و پرداختنی تفصیلی
 * اجباری دارند، پس همان ردیف‌ها کنار گذاشته می‌شدند و سند نامتوازن می‌شد.
 *
 * این اصلاح هیچ مبلغی را دست نمی‌زند: فقط می‌گوید ردیفی که روی «حساب پرداختنی
 * — شرکت آران گستر» نشسته، مال شرکت آران گستر است. چیزی که از نام خودِ حساب
 * پیداست و جای دیگری جعل نمی‌شود.
 *
 * صریح است و خودکار اجرا نمی‌شود: کاربر آن را از صفحهٔ تحویل می‌زند.
 */
export function attachMissingCounterpartyAnalytics(database) {
  ensureChartSchema(database);
  const placeholders = COUNTERPARTY_SOURCE_KINDS.map(() => '?').join(',');
  const rows = database.prepare(`SELECT journal_lines.id,ledger_accounts.source_key AS sourceKey,ledger_accounts.name AS accountName
    FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
    WHERE journal_lines.analytic_id IS NULL AND ledger_accounts.source_kind IN (${placeholders})`)
    .all(...COUNTERPARTY_SOURCE_KINDS);
  if (!rows.length) return { attached: 0, skipped: 0, analytics: 0 };

  const update = database.prepare('UPDATE journal_lines SET analytic_id=? WHERE id=?');
  const cache = new Map();
  let attached = 0;
  let skipped = 0;
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const key = String(row.sourceKey || '').trim();
      if (!key) { skipped += 1; continue; }
      if (!cache.has(key)) cache.set(key, counterpartyAnalyticForKey(database, key));
      const analyticId = cache.get(key);
      if (!analyticId) { skipped += 1; continue; }
      update.run(analyticId, row.id);
      attached += 1;
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return { attached, skipped, analytics: cache.size };
}
