// یادگیری از سابقهٔ دفتر — بعد از ورود بکاپ پارسیان (یا هر سند دستیِ تأییدشده).
//
// بکاپ چند سال تصمیمِ واقعیِ حسابدارِ همان شرکت را دارد. یادگیری‌های دیگر از صفر
// شروع می‌کنند و باید چند بار تأیید ببینند؛ این ماژول همان تصمیم‌ها را می‌خواند و دو
// چیز **پیشنهاد** می‌دهد:
//
//  ۱) پرداخت یا دریافتِ ماهانهٔ تکراری (اجاره، قبض، حق شارژ، اینترنت…): همان حساب
//     هزینه یا درآمد، همان بانک یا صندوق، ماه‌به‌ماه. با مبلغ ثابت قاعدهٔ «ثبت دوره‌ای»
//     می‌شود؛ با مبلغ متغیر (قبض) فقط الگو و واژه‌اش، چون مبلغ ماه بعد را کسی نمی‌داند
//     و قاعدهٔ دوره‌ای با مبلغ حدسی سند غلط می‌زند.
//  ۲) واژهٔ شرح سند ← حساب: «قبض برق» در ده سند همیشه به یک حساب رفته است.
//
// مرزها، عمداً سخت:
//  - فقط سند تأییدشدهٔ انسانی (ورود بکاپ یا سند دستی)؛ پیش‌نویس، معکوس، اختتامیه و
//    سندهای ساختهٔ خود برنامه خوانده نمی‌شوند.
//  - فقط سندِ ساده: یک حساب هزینه یا درآمد در برابر یک حساب پولی. تسویهٔ بدهی به
//    شرکت، خرید نسیه، حقوق و هر سند چندسطری الگوی دوره‌ای نمی‌سازد.
//  - هیچ چیز خودکار به کار نمی‌رود؛ حسابدار تأیید می‌کند. یادگیری دستیِ کاربر بی‌صدا
//    بازنویسی نمی‌شود و واژه‌ای که در سابقه به دو حساب رفته، یاد گرفته نمی‌شود.
//  - بدون شاهد کافی هیچ ادعایی نیست (همان قاعدهٔ DNA مالی).

import { randomUUID } from 'node:crypto';
import { normalizePersian } from '../shared/normalize.js';
import { PERSIAN_MONTHS, persianToISO, todayPersian } from '../shared/persianDate.js';
import { ensureAccountingSchema } from './accounting/ledgerAccounts.js';
import { ensureJournalWorkflowSchema } from './journalWorkflow.js';

/** سندهایی که انسان زده: ورود بکاپ و اکسل (`manual-batch`) و سند دستی. */
const HUMAN_SOURCES = ['manual-batch', 'manual'];
/** حساب‌هایی که درآمد یا هزینه‌اند ولی الگوی پرداخت روزمره نیستند. */
const EXCLUDED_ROLES = new Set(['cogs', 'depreciation-expense', 'inventory', 'inventory-gain', 'inventory-product',
  'inventory-shrinkage', 'inventory-unsplit', 'tax-penalty-expense']);
const EXCLUDED_NAMES = /بها[یي]\s*تمام|استهلاک|برگشت|تخف[یي]ف|سود\s*و\s*ز[یي]ان|خلاصه\s*سود|افتتاح[یي]ه|اختتام[یي]ه|موجود[یي]\s*کالا|خر[یي]د\s*(?:کالا|مواد)/;

export const HISTORY_RULES = Object.freeze({
  /** الگوی ماهانه دست‌کم در این تعداد ماه دیده شده باشد. */
  minMonths: 3,
  /** آخرین تکرار حداکثر این‌قدر ماه پیش از آخرین سند دفتر باشد؛ قدیمی‌تر یعنی تمام‌شده. */
  staleMonths: 2,
  /** مبلغ ثابت: سه تکرار آخر حداکثر این‌قدر نسبت به هم فاصله دارند. */
  fixedTolerance: 0.02,
  /** واژه: دست‌کم این تعداد سند و این تعداد ماه جدا. */
  minKeywordEntries: 3,
  minKeywordMonths: 2,
  /** سهم حسابِ غالب برای واژه؛ کمتر یعنی واژه به چند حساب رفته و مبهم است. */
  keywordPurity: 0.9,
  maxKeywords: 60,
});

const STOPWORDS = new Set([
  'بابت', 'پرداخت', 'پرداختی', 'دریافت', 'دریافتی', 'هزینه', 'هزینه‌های', 'هزینه‌ها', 'مبلغ', 'طی', 'سند', 'شماره', 'فاکتور',
  'ریال', 'تومان', 'بانک', 'حساب', 'چک', 'واریز', 'شرکت', 'آقای', 'اقای', 'خانم', 'جهت', 'برای', 'از', 'به', 'با', 'و', 'در',
  'ماه', 'سال', 'روز', 'تاریخ', 'مورخ', 'فیش', 'ثبت', 'اصلاح', 'انتقال', 'بستانکار', 'بدهکار', 'محل', 'نقد', 'نقدی',
  'کارت', 'شعبه', 'کد', 'ردیف', 'طبق', 'لیست', 'مربوط', 'مربوطه', 'ماهه', 'ماهانه', 'این', 'آن', 'که', 'تا', 'یا', 'هر',
  'شد', 'شده', 'گردید', 'می', 'های', 'ها', 'بر', 'را', 'سایر', 'متفرقه', 'عمومی', 'اداری', 'جاری', 'قبلی', 'بعدی',
  'تنخواه', 'صندوق', 'خرید', 'فروش', 'کالا', 'اجناس', 'مواد', 'بهای', 'تسویه', 'علی‌الحساب', 'علی', 'الحساب',
].map((word) => normalizePersian(word)));
const MONTH_WORDS = new Set(PERSIAN_MONTHS.map(([name]) => normalizePersian(name)));

function historyError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export function ensureHistoryLearningSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS history_lessons (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('recurring','keyword')),
    fingerprint TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','dismissed')),
    proposal TEXT NOT NULL,
    result TEXT,
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

/** کلمه‌های معنادار یک شرح: بی‌عدد، بی‌نام ماه، بی‌واژهٔ عمومی حسابداری. */
export function descriptionWords(text) {
  return normalizePersian(String(text || ''))
    .replace(/[\d۰-۹]+/g, ' ')
    .replace(/[^\p{L}‌\s]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^‌+|‌+$/g, ''))
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word) && !MONTH_WORDS.has(word));
}

const monthIndex = (parts) => parts.year * 12 + parts.month - 1;
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

/** حساب پولیِ (صندوق، بانک، تنخواه) یک ردیف، یا null. */
function moneyResolver(database) {
  const units = tableExists(database, 'parsian_money_units')
    ? database.prepare('SELECT account_id AS accountId FROM parsian_money_units WHERE chart_account_id=? AND analytic_id=?') : null;
  const live = database.prepare('SELECT id,name FROM accounts WHERE id=? AND active=1');
  const cache = new Map();
  return (line) => {
    const key = `${line.accountId}|${line.analyticId || ''}`;
    if (cache.has(key)) return cache.get(key);
    let accountId = null;
    if (units && line.chartAccountId) accountId = units.get(line.chartAccountId, line.analyticId || '')?.accountId || null;
    if (!accountId && line.sourceKind === 'operational-account') accountId = line.sourceKey;
    const account = accountId ? live.get(accountId) || null : null;
    cache.set(key, account);
    return account;
  };
}

function categoryEligible(line) {
  return ['income', 'expense'].includes(line.type) && !EXCLUDED_ROLES.has(line.role || '') && !EXCLUDED_NAMES.test(normalizePersian(line.accountName));
}

/** سندهای تأییدشدهٔ انسانی، ردیف‌به‌ردیف، با نقش هر ردیف. */
function readHistory(database) {
  ensureAccountingSchema(database);
  ensureJournalWorkflowSchema(database);
  const closing = tableExists(database, 'year_close_lines') ? 'AND NOT EXISTS (SELECT 1 FROM year_close_lines y WHERE y.entry_id=je.id)' : '';
  const chart = tableExists(database, 'chart_accounts');
  const rows = database.prepare(`SELECT je.id AS entryId,je.occurred_at AS occurredAt,je.document_number AS documentNumber,
      je.fiscal_year AS fiscalYear,je.memo,jl.account_id AS accountId,jl.debit,jl.credit,jl.description,jl.analytic_id AS analyticId,
      la.type,la.name AS accountName,la.code AS accountCode,la.source_kind AS sourceKind,la.source_key AS sourceKey,
      la.chart_account_id AS chartAccountId,${chart ? 'ca.role' : "''"} AS role
    FROM journal_entries je
    JOIN journal_lines jl ON jl.entry_id=je.id
    JOIN ledger_accounts la ON la.id=jl.account_id
    ${chart ? 'LEFT JOIN chart_accounts ca ON ca.id=la.chart_account_id' : ''}
    WHERE je.source_type IN (${HUMAN_SOURCES.map(() => '?').join(',')})
      AND je.entry_kind IN ('normal','adjustment') AND je.approval_state='approved'
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=je.id)
      ${closing}
    ORDER BY je.occurred_at,je.id`).all(...HUMAN_SOURCES);
  const entries = new Map();
  for (const row of rows) {
    if (!entries.has(row.entryId)) entries.set(row.entryId, { id: row.entryId, occurredAt: row.occurredAt, documentNumber: row.documentNumber, fiscalYear: row.fiscalYear, memo: row.memo, lines: [] });
    entries.get(row.entryId).lines.push(row);
  }
  return [...entries.values()];
}

/**
 * سند ساده: همهٔ ردیف‌ها یا روی یک حساب پولی‌اند یا روی یک حساب هزینه/درآمد، با
 * جهت درست (هزینه بدهکار و پول بستانکار؛ درآمد برعکس). هر چیز دیگری null است.
 */
function simpleShape(entry, moneyOf) {
  let money = null;
  let category = null;
  let moneySide = null;
  let amount = 0;
  for (const line of entry.lines) {
    const account = moneyOf(line);
    const side = line.debit > 0 ? 'debit' : 'credit';
    if (account) {
      if ((money && money.id !== account.id) || (moneySide && moneySide !== side)) return null;
      money = account; moneySide = side;
      continue;
    }
    if (!categoryEligible(line)) return null;
    if (category && category.accountId !== line.accountId) return null;
    category = line;
    amount += line.type === 'expense' ? line.debit - line.credit : line.credit - line.debit;
  }
  if (!money || !category || amount <= 0) return null;
  const type = category.type;
  if ((type === 'expense' && moneySide !== 'credit') || (type === 'income' && moneySide !== 'debit')) return null;
  return { type, amount, money, category };
}

function cleanTitle(texts, fallback) {
  const counts = new Map();
  for (const text of texts) {
    const words = descriptionWords(text).slice(0, 4);
    if (!words.length) continue;
    const title = words.join(' ');
    counts.set(title, (counts.get(title) || 0) + 1);
  }
  const best = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  return (best && best[1] >= 2 ? best[0] : fallback).slice(0, 80);
}

/** پرداخت و دریافتِ ماهانهٔ تکراری از سندهای ساده. */
function recurringPatterns(simple, lastMonth) {
  const groups = new Map();
  for (const item of simple) {
    const key = `${item.type}|${item.category.accountId}|${item.money.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const patterns = [];
  for (const [key, items] of groups) {
    const byMonth = new Map();
    for (const item of items) {
      const index = monthIndex(item.parts);
      if (!byMonth.has(index)) byMonth.set(index, []);
      byMonth.get(index).push(item);
    }
    const months = [...byMonth.keys()].sort((left, right) => left - right);
    if (months.length < HISTORY_RULES.minMonths) continue;
    // خرید روزمره (چند بار در ماه) ماهانه نیست؛ یک ماهِ دوباره (پرداخت عقب‌افتاده) اشکالی ندارد.
    const crowded = months.filter((month) => byMonth.get(month).length > 1).length;
    if (crowded / months.length > 0.25) continue;
    const gaps = months.slice(1).map((month, index) => month - months[index]);
    if (gaps.some((gap) => gap > 3) || gaps.filter((gap) => gap === 1).length / gaps.length < 0.6) continue;
    if (lastMonth - months.at(-1) > HISTORY_RULES.staleMonths) continue;
    const ordered = months.map((month) => byMonth.get(month)[0]);
    const recent = ordered.slice(-3).map((item) => item.amount);
    const fixed = Math.max(...recent) / Math.min(...recent) - 1 <= HISTORY_RULES.fixedTolerance;
    const sample = ordered[0];
    const lastSix = ordered.slice(-6).map((item) => item.amount);
    patterns.push({
      fingerprint: `recurring|${key}`,
      type: sample.type,
      ledgerAccountId: sample.category.accountId,
      accountName: sample.category.accountName,
      moneyAccountId: sample.money.id,
      moneyAccountName: sample.money.name,
      title: cleanTitle(ordered.map((item) => item.text), sample.category.accountName),
      amountMode: fixed ? 'fixed' : 'variable',
      amount: ordered.at(-1).amount,
      amountMin: Math.min(...lastSix),
      amountMax: Math.max(...lastSix),
      dayOfMonth: median(ordered.map((item) => item.parts.day)),
      months: months.length,
      evidence: ordered.slice(-12).map((item) => ({ entryId: item.entryId, documentNumber: item.documentNumber, fiscalYear: item.fiscalYear, occurredAt: item.occurredAt, amount: item.amount })),
    });
  }
  return patterns.sort((left, right) => right.months - left.months || right.amount - left.amount);
}

/** واژهٔ شرح ← حساب: فقط واژه‌ای که همیشه به یک حساب رفته است. */
function keywordPatterns(lines, excludedWords) {
  const stats = new Map();
  for (const line of lines) {
    const words = descriptionWords(line.text).filter((word) => !excludedWords.has(word));
    const candidates = new Set(words);
    for (let index = 1; index < words.length; index += 1) candidates.add(`${words[index - 1]} ${words[index]}`);
    for (const keyword of candidates) {
      if (!stats.has(keyword)) stats.set(keyword, new Map());
      const byAccount = stats.get(keyword);
      if (!byAccount.has(line.accountId)) byAccount.set(line.accountId, { line, entries: new Set(), months: new Set(), samples: [] });
      const bucket = byAccount.get(line.accountId);
      if (bucket.entries.has(line.entryId)) continue;
      bucket.entries.add(line.entryId);
      bucket.months.add(line.month);
      if (bucket.samples.length < 5) bucket.samples.push({ entryId: line.entryId, documentNumber: line.documentNumber, fiscalYear: line.fiscalYear, occurredAt: line.occurredAt, text: line.text.slice(0, 120) });
    }
  }
  const accepted = [];
  for (const [keyword, byAccount] of stats) {
    const buckets = [...byAccount.values()].sort((left, right) => right.entries.size - left.entries.size);
    const total = buckets.reduce((sum, bucket) => sum + bucket.entries.size, 0);
    const top = buckets[0];
    if (top.entries.size < HISTORY_RULES.minKeywordEntries || top.months.size < HISTORY_RULES.minKeywordMonths) continue;
    if (top.entries.size / total < HISTORY_RULES.keywordPurity) continue;
    accepted.push({
      fingerprint: `keyword|${keyword}`,
      keyword,
      type: top.line.type,
      ledgerAccountId: top.line.accountId,
      accountName: top.line.accountName,
      entries: top.entries.size,
      months: top.months.size,
      elsewhere: total - top.entries.size,
      evidence: top.samples,
    });
  }
  // «قبض برق» وقتی «برق» تنها هم به همان حساب می‌رود، تکرار است؛ دوکلمه‌ای فقط وقتی
  // می‌ماند که تک‌کلمه‌اش مبهم بوده یا به حساب دیگری رفته.
  const single = new Map(accepted.filter((item) => !item.keyword.includes(' ')).map((item) => [item.keyword, item]));
  return accepted
    .filter((item) => !item.keyword.includes(' ') || !item.keyword.split(' ').some((word) => single.get(word)?.ledgerAccountId === item.ledgerAccountId))
    .sort((left, right) => right.entries - left.entries || left.keyword.localeCompare(right.keyword))
    .slice(0, HISTORY_RULES.maxKeywords);
}

/** تحلیل خالص سابقه؛ چیزی نمی‌نویسد. */
export function analyzeLedgerHistory(database, { timeZone = 'Asia/Tehran' } = {}) {
  const entries = readHistory(database);
  const moneyOf = moneyResolver(database);
  // نام اشخاص و بانک‌ها واژهٔ دسته نیست: «پرداخت به فلانی» دربارهٔ طرف حساب است.
  const excludedWords = new Set();
  const names = [
    ...(tableExists(database, 'analytic_accounts') ? database.prepare('SELECT name FROM analytic_accounts').all() : []),
    ...database.prepare('SELECT name FROM accounts').all(),
    ...(tableExists(database, 'contacts') ? database.prepare('SELECT name FROM contacts').all() : []),
  ];
  for (const { name } of names) for (const word of descriptionWords(name)) excludedWords.add(word);

  let lastMonth = -Infinity;
  const simple = [];
  const keywordLines = [];
  for (const entry of entries) {
    const parts = todayPersian(new Date(entry.occurredAt), timeZone);
    const month = monthIndex(parts);
    lastMonth = Math.max(lastMonth, month);
    const shape = simpleShape(entry, moneyOf);
    if (shape) {
      const text = shape.category.description || entry.memo || '';
      simple.push({ ...shape, parts, text, entryId: entry.id, documentNumber: entry.documentNumber, fiscalYear: entry.fiscalYear, occurredAt: entry.occurredAt });
    }
    for (const line of entry.lines) {
      if (!categoryEligible(line)) continue;
      const rightSide = line.type === 'expense' ? line.debit > 0 : line.credit > 0;
      const text = line.description || entry.memo || '';
      if (!rightSide || !text.trim()) continue;
      keywordLines.push({ ...line, text, month, entryId: entry.id, documentNumber: entry.documentNumber, fiscalYear: entry.fiscalYear, occurredAt: entry.occurredAt });
    }
  }
  return {
    entries: entries.length,
    simpleEntries: simple.length,
    recurring: recurringPatterns(simple, lastMonth),
    keywords: keywordPatterns(keywordLines, excludedWords),
  };
}

const parseJson = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };

function settingValue(database, key) {
  return database.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || null;
}

/** تحلیل را اجرا و پیشنهادها را به‌روز می‌کند؛ تصمیم‌های قبلی دست نمی‌خورند. */
export function refreshHistoryLessons(database, options = {}) {
  ensureHistoryLearningSchema(database);
  const analysis = analyzeLedgerHistory(database, options);
  const proposals = [
    ...analysis.recurring.map((proposal) => ({ kind: 'recurring', proposal })),
    ...analysis.keywords.map((proposal) => ({ kind: 'keyword', proposal })),
  ];
  const existing = new Map(database.prepare('SELECT id,fingerprint,status FROM history_lessons').all().map((row) => [row.fingerprint, row]));
  const seen = new Set();
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const { kind, proposal } of proposals) {
      seen.add(proposal.fingerprint);
      const row = existing.get(proposal.fingerprint);
      if (!row) {
        database.prepare('INSERT INTO history_lessons (id,kind,fingerprint,proposal) VALUES (?,?,?,?)')
          .run(randomUUID(), kind, proposal.fingerprint, JSON.stringify(proposal));
      } else if (row.status === 'pending') {
        database.prepare('UPDATE history_lessons SET proposal=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(proposal), row.id);
      }
    }
    // پیشنهادِ منتظری که دیگر از سابقه درنمی‌آید (سندش برگشت خورد) کنار می‌رود.
    for (const [fingerprint, row] of existing) {
      if (!seen.has(fingerprint) && row.status === 'pending') database.prepare('DELETE FROM history_lessons WHERE id=?').run(row.id);
    }
    database.prepare(`INSERT INTO settings (key,value) VALUES ('historyLearning.analyzedAt',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify({ at: new Date().toISOString(), entries: analysis.entries, simpleEntries: analysis.simpleEntries }));
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return listHistoryLessons(database);
}

/** دسته‌ای که الان به این حساب دفتر کل وصل است، یا نامی که بعد از تأیید می‌گیرد. */
function categoryNameFor(database, ledgerAccountId) {
  const account = database.prepare('SELECT name,code,type,source_kind AS sourceKind,source_key AS sourceKey FROM ledger_accounts WHERE id=?').get(ledgerAccountId);
  if (!account) return null;
  if (account.sourceKind === `${account.type}-category`) return account.sourceKey;
  const name = String(account.name).trim().slice(0, 80);
  const taken = database.prepare('SELECT id FROM ledger_accounts WHERE source_kind=? AND source_key=? AND id<>?').get(`${account.type}-category`, name, ledgerAccountId);
  return taken ? `${name} (${account.code})`.slice(0, 80) : name;
}

function decorate(database, row, learnings) {
  const proposal = parseJson(row.proposal, {});
  const item = { id: row.id, kind: row.kind, status: row.status, decidedAt: row.decided_at, result: parseJson(row.result, null), ...proposal };
  delete item.fingerprint;
  item.category = categoryNameFor(database, proposal.ledgerAccountId);
  if (row.kind === 'keyword' && row.status === 'pending') {
    const current = learnings.get(normalizePersian(proposal.keyword));
    if (current && current.category === item.category) item.known = true;
    else if (current) item.conflict = { category: current.category, source: current.source };
  }
  return item;
}

export function listHistoryLessons(database) {
  ensureHistoryLearningSchema(database);
  const learnings = new Map(database.prepare('SELECT keyword,category,source FROM learnings').all().map((row) => [normalizePersian(row.keyword), row]));
  const items = database.prepare(`SELECT * FROM history_lessons ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,kind DESC,created_at`).all()
    .map((row) => decorate(database, row, learnings))
    .filter((item) => !item.known);
  return { analyzed: parseJson(settingValue(database, 'historyLearning.analyzedAt'), null), items };
}

/**
 * حساب هزینه/درآمدِ سابقه را دستهٔ حساب‌یار می‌کند تا ثبت تازه با همین دسته روی
 * همان حساب بنشیند، نه حساب تازه‌ای کنار آن. همان کاری که `categoryLedgerAccount`
 * برای حساب الگوی بی‌گردش می‌کند، این بار با تأیید صریح حسابدار.
 */
export function bindLedgerAccountAsCategory(database, ledgerAccountId) {
  const account = database.prepare('SELECT id,name,code,type,source_kind AS sourceKind FROM ledger_accounts WHERE id=? AND active=1').get(ledgerAccountId);
  if (!account || !['income', 'expense'].includes(account.type)) throw historyError('حساب این الگو دیگر در دفتر نیست.', 'HISTORY_ACCOUNT_MISSING', 409);
  const category = categoryNameFor(database, ledgerAccountId);
  if (account.sourceKind !== `${account.type}-category`) {
    database.prepare('UPDATE ledger_accounts SET source_kind=?,source_key=? WHERE id=?').run(`${account.type}-category`, category, account.id);
  }
  const existing = database.prepare('SELECT type FROM categories WHERE name=?').get(category);
  if (existing && existing.type !== account.type) throw historyError(`دستهٔ «${category}» با نوع دیگری در دفتر هست.`, 'HISTORY_CATEGORY_TYPE', 409);
  if (!existing) {
    const order = database.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM categories').get().next;
    database.prepare('INSERT INTO categories (id,name,type,sort_order) VALUES (?,?,?,?)').run(randomUUID(), category, account.type, order);
  }
  return { category, type: account.type };
}

/** اولین سررسید شمسی با همان روزِ ماه، بعد از امروز. */
export function nextJalaliDue(day, now = new Date(), timeZone = 'Asia/Tehran') {
  const today = todayPersian(now, timeZone);
  for (let offset = 0; offset < 3; offset += 1) {
    const total = today.year * 12 + today.month - 1 + offset;
    const year = Math.floor(total / 12);
    const month = total % 12 + 1;
    // اسفند و ماه‌های ۳۰روزه روز ۳۱ ندارند؛ روز آخر همان ماه.
    let iso = null;
    for (let candidate = Math.min(day, 31); candidate >= 28 && !iso; candidate -= 1) iso = persianToISO(year, month, candidate, timeZone);
    if (!iso) iso = persianToISO(year, month, Math.min(day, 28), timeZone);
    if (iso && new Date(iso) > now) return iso;
  }
  return null;
}

/** واژه‌ای که از سابقه یاد گرفته شد؛ منشأش جداست تا یک‌جا برگردد. */
function saveHistoryLearning(database, keyword, category) {
  const current = database.prepare('SELECT id FROM learnings WHERE keyword=?').get(keyword);
  if (current) {
    database.prepare("UPDATE learnings SET category=?,source='history',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(category, current.id);
    return current.id;
  }
  const id = randomUUID();
  database.prepare("INSERT INTO learnings (id,keyword,category,source) VALUES (?,?,?,'history')").run(id, keyword, category);
  return id;
}

export function decideHistoryLesson(database, id, { action, actor = null, saveRecurringRule, now = new Date() } = {}) {
  ensureHistoryLearningSchema(database);
  const row = database.prepare('SELECT * FROM history_lessons WHERE id=?').get(id);
  if (!row) throw historyError('این پیشنهاد پیدا نشد.', 'HISTORY_LESSON_MISSING', 404);
  if (row.status !== 'pending') throw historyError('دربارهٔ این پیشنهاد قبلاً تصمیم گرفته شده.', 'HISTORY_LESSON_DECIDED', 409);
  const proposal = parseJson(row.proposal, {});
  const mark = (status, result = null) => database.prepare('UPDATE history_lessons SET status=?,result=?,decided_by=?,decided_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(status, result ? JSON.stringify(result) : null, actor, now.toISOString(), id);
  if (action === 'dismiss') { mark('dismissed'); return listHistoryLessons(database).items.find((item) => item.id === id) || null; }
  if (!['accept', 'replace'].includes(action)) throw historyError('تصمیم نامعتبر است.', 'HISTORY_LESSON_ACTION');

  database.exec('BEGIN IMMEDIATE');
  try {
    const { category, type } = bindLedgerAccountAsCategory(database, proposal.ledgerAccountId);
    let result;
    if (row.kind === 'keyword') {
      const current = database.prepare('SELECT id,category,source FROM learnings WHERE keyword=?').get(proposal.keyword);
      if (current && current.category !== category && action !== 'replace') {
        throw historyError(`برای «${proposal.keyword}» یادگیری دیگری هست (${current.category})؛ اگر می‌خواهی عوض شود «جایگزین کن» را بزن.`, 'HISTORY_LESSON_CONFLICT', 409);
      }
      result = { learningId: saveHistoryLearning(database, proposal.keyword, category), category, type };
    } else {
      // مبلغ متغیر (قبض) قاعدهٔ دوره‌ای نمی‌شود؛ فقط واژهٔ عنوانش یاد گرفته می‌شود
      // تا «قبض برق ۳ میلیون» همان حساب و همان دسته را بگیرد.
      if (proposal.amountMode === 'fixed') {
        const nextDueAt = nextJalaliDue(proposal.dayOfMonth, now);
        if (!nextDueAt) throw historyError('سررسید بعدی این الگو ساخته نشد.', 'HISTORY_DUE_MISSING', 409);
        const rule = saveRecurringRule({
          title: proposal.title, amount: proposal.amount, type, category, accountId: proposal.moneyAccountId,
          dayOfMonth: new Date(nextDueAt).getUTCDate(), nextDueAt,
        });
        result = { recurringId: rule.id, category, type, nextDueAt };
      } else {
        result = { category, type };
      }
      const keyword = descriptionWords(proposal.title).join(' ');
      if (keyword.length >= 2 && !database.prepare('SELECT 1 FROM learnings WHERE keyword=?').get(keyword)) {
        result.learningId = saveHistoryLearning(database, keyword, category);
      }
    }
    mark('accepted', result);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return listHistoryLessons(database).items.find((item) => item.id === id) || null;
}

/** همهٔ آنچه از سابقه یاد گرفته شد برمی‌گردد؛ پیشنهادها دوباره منتظر تصمیم می‌شوند. */
export function forgetHistoryLessons(database, { deleteRecurringRule } = {}) {
  ensureHistoryLearningSchema(database);
  const accepted = database.prepare("SELECT id,result FROM history_lessons WHERE status='accepted'").all();
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const row of accepted) {
      const result = parseJson(row.result, {});
      if (result.recurringId) deleteRecurringRule(result.recurringId);
    }
    const learnings = database.prepare("DELETE FROM learnings WHERE source='history'").run().changes;
    database.prepare("UPDATE history_lessons SET status='pending',result=NULL,decided_by=NULL,decided_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE status='accepted'").run();
    database.exec('COMMIT');
    return { learnings, recurring: accepted.filter((row) => parseJson(row.result, {}).recurringId).length };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
