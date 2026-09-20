// فاز ۲ — کدینگ استاندارد، تفصیلی شناور و مرکز هزینه.
//
// حساب‌یار تا پیش از این کد حساب را خودش می‌ساخت (accounting.js:nextCode). هیچ دفتر
// حسابداری کدینگ خودش را رها نمی‌کند، پس از این پس کدینگ دفتر وارد می‌شود و
// حساب‌های داخلی حساب‌یار فقط به آن «نگاشت» می‌شوند. کد داخلی حذف نمی‌شود تا
// اسناد قبلی و ارجاع‌هایشان دست‌نخورده بمانند.

import { randomUUID } from 'node:crypto';
import { canonicalCounterpartyName } from '../shared/counterpartyIdentity.js';
import { chartCodeForCategory } from '../shared/categoryRules.js';
import { normalizePersian } from '../shared/normalize.js';

export const CHART_LEVELS = Object.freeze({
  group: Object.freeze({ id: 'group', label: 'گروه', order: 1 }),
  general: Object.freeze({ id: 'general', label: 'کل', order: 2 }),
  subsidiary: Object.freeze({ id: 'subsidiary', label: 'معین', order: 3 }),
});

export const CHART_TYPES = Object.freeze({
  asset: Object.freeze({ id: 'asset', label: 'دارایی', normalSide: 'debit' }),
  liability: Object.freeze({ id: 'liability', label: 'بدهی', normalSide: 'credit' }),
  equity: Object.freeze({ id: 'equity', label: 'سرمایه', normalSide: 'credit' }),
  income: Object.freeze({ id: 'income', label: 'درآمد', normalSide: 'credit' }),
  expense: Object.freeze({ id: 'expense', label: 'هزینه', normalSide: 'debit' }),
});

// نقش‌ها فقط برای پیشنهاد خودکار نگاشت به کار می‌روند؛ هیچ سندی بر پایهٔ نقش ثبت نمی‌شود.
export const CHART_ROLES = Object.freeze([
  'cash', 'bank', 'receivable', 'payable', 'inventory', 'cogs',
  'sales', 'service-income', 'other-income', 'operating-expense',
  'output-tax', 'input-tax', 'equity', 'inventory-gain', 'inventory-shrinkage',
  'fixed-asset', 'owner-capital',
  // حقوق و دستمزد سه بدهی جدا می‌سازد و هر سه به گیرندهٔ متفاوتی پرداخت
  // می‌شوند: خالص به خودِ پرسنل، بیمه به تأمین اجتماعی و مالیات به سازمان
  // امور مالیاتی. ریختنشان در یک «سایر پرداختنی» یعنی هیچ‌کدام قابل پیگیری
  // نیست و تسویهٔ هرکدام، ماندهٔ دو تای دیگر را هم دست‌کاری می‌کند.
  'salary-expense', 'employer-insurance-expense',
  'salary-payable', 'insurance-payable', 'payroll-tax-payable',
  // چک از مطالبات عادی جداست: سررسید دارد، ممکن است برگشت بخورد، و تا وصول
  // نشود پول نیست. در تراز هم باید جدا دیده شود.
  'note-receivable', 'note-payable',
]);

export const ANALYTIC_KINDS = Object.freeze({
  contact: 'طرف حساب',
  project: 'پروژه',
  employee: 'پرسنل',
  custom: 'سایر',
});

function chartError(message, code = 'CHART_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

const digitMap = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9', '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
function latin(value) { return String(value ?? '').replace(/[۰-۹٠-٩]/g, (digit) => digitMap[digit]); }

// کد حساب فقط رقم است. جداکننده‌های رایج کدینگ (خط تیره، نقطه، فاصله) پاک می‌شوند
// تا «۱۱-۰۱» و «1101» یک حساب شناخته شوند، نه دو حساب موازی.
export function normalizeChartCode(value) {
  return latin(value).replace(/[\s._-]/g, '').trim();
}

export function chartCodeIsValid(code) {
  return /^\d{1,12}$/.test(code);
}

function cleanName(value, limit = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function ensureColumn(database, table, definition) {
  try { database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`); }
  catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
}

export function ensureChartSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chart_accounts (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('group','general','subsidiary')),
      parent_id TEXT REFERENCES chart_accounts(id) ON DELETE RESTRICT,
      type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','income','expense')),
      normal_side TEXT NOT NULL CHECK(normal_side IN ('debit','credit')),
      role TEXT NOT NULL DEFAULT '',
      level_code TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','template','import')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_chart_accounts_parent ON chart_accounts(parent_id,code);
    CREATE INDEX IF NOT EXISTS idx_chart_accounts_role ON chart_accounts(role) WHERE role<>'';

    CREATE TABLE IF NOT EXISTS analytic_accounts (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'custom' CHECK(kind IN ('contact','project','employee','custom')),
      source_kind TEXT,
      source_key TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_kind,source_key)
    );

    CREATE TABLE IF NOT EXISTS cost_centers (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES cost_centers(id) ON DELETE RESTRICT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // ابعاد روی آرتیکل سند می‌نشینند، نه روی حساب — این تعریف «شناور» بودن تفصیلی است.
  ensureColumn(database, 'journal_lines', 'analytic_id TEXT REFERENCES analytic_accounts(id) ON DELETE RESTRICT');
  // کد تفصیلی در نرم‌افزار مقصد. کد داخلی ما خودکار ساخته می‌شود و هیچ ربطی به
  // کدهای پارسیان ندارد؛ فرستادنش یعنی ردیف به شخص اشتباهی می‌چسبد — خطایی که
  // از گم‌شدن طرف حساب بدتر است.
  ensureColumn(database, 'analytic_accounts', 'external_code TEXT');
  ensureColumn(database, 'journal_lines', 'cost_center_id TEXT REFERENCES cost_centers(id) ON DELETE RESTRICT');
  ensureColumn(database, 'chart_accounts', "level_code TEXT NOT NULL DEFAULT ''");
  // معینی که در نرم‌افزار دفتر «تفصیلی اجباری» است: ردیفی که روی آن بنشیند و
  // کد تفصیلی نداشته باشد، در پارسیان پذیرفته نمی‌شود. پارسیان آن ردیف را کنار
  // می‌گذارد و طرف دیگرِ همان سند تنها می‌ماند — سند غیرموازنه دقیقاً از همین
  // جا می‌آید و هیچ پیامی هم نمی‌دهد. پس این را از قبل می‌دانیم و جلوی خروجی
  // را می‌گیریم.
  ensureColumn(database, 'chart_accounts', 'requires_analytic INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'ledger_accounts', 'chart_account_id TEXT REFERENCES chart_accounts(id) ON DELETE RESTRICT');
  backfillLevelCodes(database);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_journal_lines_analytic ON journal_lines(analytic_id) WHERE analytic_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_journal_lines_cost_center ON journal_lines(cost_center_id) WHERE cost_center_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_ledger_accounts_chart ON ledger_accounts(chart_account_id);
  `);
}

/**
 * کد سطح را برای کدینگ‌هایی که پیش از افزودن این ستون نصب شده‌اند پر می‌کند.
 *
 * ستون `level_code` با پیش‌فرض خالی اضافه شد، پس هر کدینگی که از قبل نصب بود
 * کد سطح نداشت. این تا وقتی خروجی فقط کد کامل می‌داد بی‌ضرر بود، ولی از وقتی
 * فایل انتقال پارسیان کد کل و معین را جدا می‌خواهد، خالی‌بودنش یعنی خروجی
 * ساخته نمی‌شود. قاعده همان قاعدهٔ سبک پیشوندی است: کد سطح، تفاضل کد فرزند و
 * کد والد؛ و برای ریشه، خود کد.
 */
export function backfillLevelCodes(database) {
  const rows = database.prepare(`SELECT chart_accounts.id,chart_accounts.code,parent.code AS parentCode
    FROM chart_accounts LEFT JOIN chart_accounts AS parent ON parent.id=chart_accounts.parent_id
    WHERE chart_accounts.level_code=''`).all();
  if (!rows.length) return 0;
  const update = database.prepare('UPDATE chart_accounts SET level_code=? WHERE id=?');
  let filled = 0;
  for (const row of rows) {
    const code = String(row.code || '');
    const parentCode = String(row.parentCode || '');
    const derived = parentCode && code.startsWith(parentCode) && code.length > parentCode.length
      ? code.slice(parentCode.length)
      : code;
    if (!derived) continue;
    update.run(derived, row.id);
    filled += 1;
  }
  return filled;
}

// ---------------------------------------------------------------------------
// اعتبارسنجی کدینگ — منطق خالص
// ---------------------------------------------------------------------------

const LEVEL_ALIASES = {
  group: 'group', گروه: 'group', 'گروه حساب': 'group', 1: 'group', '1': 'group',
  general: 'general', کل: 'general', 'حساب کل': 'general', 2: 'general', '2': 'general',
  subsidiary: 'subsidiary', معین: 'subsidiary', 'حساب معین': 'subsidiary', moein: 'subsidiary', 3: 'subsidiary', '3': 'subsidiary',
};

const TYPE_ALIASES = {
  asset: 'asset', دارایی: 'asset', داراییها: 'asset', 'دارایی ها': 'asset',
  liability: 'liability', بدهی: 'liability', بدهیها: 'liability', 'بدهی ها': 'liability',
  equity: 'equity', سرمایه: 'equity', 'حقوق صاحبان سهام': 'equity',
  income: 'income', درآمد: 'income', درآمدها: 'income', فروش: 'income',
  expense: 'expense', هزینه: 'expense', هزینهها: 'expense', 'هزینه ها': 'expense', 'بهای تمام شده': 'expense',
};

export function normalizeChartLevel(value) {
  const key = cleanName(latin(value)).toLowerCase();
  return LEVEL_ALIASES[key] || null;
}

export function normalizeChartType(value) {
  const key = cleanName(value).toLowerCase();
  return TYPE_ALIASES[key] || null;
}

/**
 * درخت کدینگ را می‌سنجد. قواعد عمدی و سخت‌گیرانه:
 * - کد فقط رقم باشد و تکراری نباشد؛
 * - سطح‌ها گروه ← کل ← معین تو در تو باشند؛
 * - کد فرزند با کد والد شروع شود و از آن بلندتر باشد (قرارداد کدینگ ایرانی)؛
 * - نوع حساب فرزند با والد یکی باشد؛
 * - فقط «معین» قابل ثبت سند است.
 * هر ایراد با شمارهٔ ردیف برمی‌گردد تا حسابدار دقیقاً بداند کدام سطر فایلش خراب است.
 */
// سبک کدینگ. `prefix` قرارداد رایج است (کد فرزند با کد والد شروع می‌شود).
// `segmented` همان چیزی است که پارسیان واقعاً دارد: هر سطح کد مستقل خودش را
// دارد و کد کل هیچ ربطی به کد گروهش ندارد؛ بعضی کل‌ها اصلاً گروه ندارند.
export const CHART_CODING_STYLES = Object.freeze({
  prefix: Object.freeze({ id: 'prefix', label: 'پیشوندی (کد فرزند با کد والد شروع می‌شود)' }),
  segmented: Object.freeze({ id: 'segmented', label: 'سطحی و مستقل (مانند پارسیان)' }),
});

export function normalizeCodingStyle(value) {
  return Object.hasOwn(CHART_CODING_STYLES, value) ? value : 'prefix';
}

export function validateChartRows(rows = [], { codingStyle = 'prefix' } = {}) {
  const style = normalizeCodingStyle(codingStyle);
  const errors = [];
  const byCode = new Map();
  const accounts = [];

  rows.forEach((row, index) => {
    const rowNumber = row.rowNumber || index + 1;
    const code = normalizeChartCode(row.code);
    const name = cleanName(row.name);
    const level = normalizeChartLevel(row.level);
    const type = normalizeChartType(row.type);
    const parentCode = row.parentCode == null || row.parentCode === '' ? '' : normalizeChartCode(row.parentCode);

    if (!chartCodeIsValid(code)) { errors.push({ rowNumber, code: row.code, message: 'کد حساب باید فقط رقم و حداکثر ۱۲ رقم باشد.' }); return; }
    if (!name) { errors.push({ rowNumber, code, message: 'نام حساب خالی است.' }); return; }
    if (!level) { errors.push({ rowNumber, code, message: 'سطح حساب باید گروه، کل یا معین باشد.' }); return; }
    if (!type) { errors.push({ rowNumber, code, message: 'نوع حساب باید دارایی، بدهی، سرمایه، درآمد یا هزینه باشد.' }); return; }
    if (byCode.has(code)) { errors.push({ rowNumber, code, message: `کد ${code} در فایل تکراری است.` }); return; }

    // کد سطح: کدی که خود نرم‌افزار مقصد برای این حساب می‌شناسد. اگر داده نشود،
    // در سبک پیشوندی از تفاضل کد فرزند و والد و در سبک سطحی از خود کد می‌آید.
    const levelCode = normalizeChartCode(row.levelCode);
    if (levelCode && !chartCodeIsValid(levelCode)) { errors.push({ rowNumber, code, message: 'کد سطح باید فقط رقم باشد.' }); return; }
    const role = CHART_ROLES.includes(String(row.role || '').trim()) ? String(row.role).trim() : '';
    const declaredAnalytic = readFlag(row.requiresAnalytic);
    const account = {
      rowNumber, code, name, level, type,
      normalSide: CHART_TYPES[type].normalSide,
      parentCode: parentCode || null,
      levelCode,
      role,
      requiresAnalytic: declaredAnalytic === undefined ? (level === 'subsidiary' && ANALYTIC_ROLES.has(role)) : declaredAnalytic,
      postable: level === 'subsidiary',
    };
    byCode.set(code, account);
    accounts.push(account);
  });

  for (const account of accounts) {
    if (account.level === 'group') {
      if (account.parentCode) errors.push({ rowNumber: account.rowNumber, code: account.code, message: 'گروه نباید والد داشته باشد.' });
      account.levelCode ||= account.code;
      continue;
    }
    if (!account.parentCode) {
      // در سبک سطحی، حسابی که والد ندارد پذیرفته می‌شود؛ پارسیان چنین کل‌هایی
      // واقعاً دارد (مثلاً «تراز افتتاحیه»).
      // کدینگ پارسیان کلِ بدون والد دارد: «۱۲ بدهکاران» زیر هیچ گروهی نیست و
      // کد خودش همان کدی است که پارسیان می‌شناسد. تا وقتی کد سطح صریح آمده،
      // نبودِ والد ابهامی نمی‌سازد.
      if (style === 'segmented' || account.levelCode) { account.levelCode ||= account.code; continue; }
      errors.push({ rowNumber: account.rowNumber, code: account.code, message: `${CHART_LEVELS[account.level].label} باید کد والد داشته باشد یا ستون «کد سطح» داشته باشد.` });
      continue;
    }
    const parent = byCode.get(account.parentCode);
    if (!parent) {
      errors.push({ rowNumber: account.rowNumber, code: account.code, message: `والد با کد ${account.parentCode} در فایل نیست.` });
      continue;
    }
    const expectedParentLevel = account.level === 'general' ? 'group' : 'general';
    if (parent.level !== expectedParentLevel) {
      errors.push({ rowNumber: account.rowNumber, code: account.code, message: `والد ${CHART_LEVELS[account.level].label} باید ${CHART_LEVELS[expectedParentLevel].label} باشد.` });
      continue;
    }
    if (style === 'prefix') {
      if (!account.code.startsWith(parent.code) || account.code.length <= parent.code.length) {
        errors.push({ rowNumber: account.rowNumber, code: account.code, message: `کد ${account.code} باید با کد والد ${parent.code} شروع شود و از آن بلندتر باشد.` });
        continue;
      }
      account.levelCode ||= account.code.slice(parent.code.length);
    } else {
      account.levelCode ||= account.code;
    }
    if (parent.type !== account.type) {
      errors.push({ rowNumber: account.rowNumber, code: account.code, message: `نوع حساب با والد ${parent.code} یکی نیست.` });
    }
  }

  // ترتیب درج: والد همیشه پیش از فرزند، وگرنه کلید خارجی می‌شکند.
  const ordered = [...accounts].sort((first, second) => CHART_LEVELS[first.level].order - CHART_LEVELS[second.level].order || first.code.localeCompare(second.code));
  return { accounts: ordered, errors };
}

// ---------------------------------------------------------------------------
// خواندن فایل کدینگ
// ---------------------------------------------------------------------------

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

function headerKey(value) {
  return latin(value).replace(/^﻿/, '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

const COLUMN_ALIASES = {
  code: ['code', 'accountcode', 'کد', 'کدحساب', 'کدینگ'],
  name: ['name', 'title', 'accountname', 'نام', 'نامحساب', 'شرح', 'عنوان'],
  level: ['level', 'سطح', 'نوعسطح', 'ردهحساب'],
  parentCode: ['parent', 'parentcode', 'کدوالد', 'والد', 'کدبالاسری', 'حسابوالد'],
  type: ['type', 'accounttype', 'نوع', 'نوعحساب', 'ماهیت'],
  role: ['role', 'نقش', 'کاربرد'],
  levelCode: ['levelcode', 'کدسطح', 'کدمقصدسطح', 'کدپارسیان', 'کدنرمافزار'],
  requiresAnalytic: ['requiresanalytic', 'تفصیلیاجباری', 'تفصیلیدارد', 'داراىتفصیلی', 'دارایتفصیلی', 'شناوراجباری', 'تفصیلی'],
};

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'y', 'بله', 'آری', 'اری', 'دارد', 'اجباری', 'الزامی', 'دارد.']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'n', 'خیر', 'ندارد', 'اختیاری', '-']);

/**
 * خواندن یک ستون بله/خیر از فایل.
 *
 * سلول خالی «خیر» نیست، «نامشخص» است: یعنی فایل دربارهٔ این حساب چیزی
 * نگفته. تفاوت این دو مهم است — «نگفته» اجازه می‌دهد از نقش حساب حدس بزنیم،
 * ولی «خیر» تصمیم صریح کاربر است و روی آن دست نمی‌گذاریم.
 */
function readFlag(value) {
  const token = latin(String(value ?? '')).trim().toLowerCase().replace(/[\s‌]+/g, '');
  if (!token) return undefined;
  if (TRUE_WORDS.has(token)) return true;
  if (FALSE_WORDS.has(token)) return false;
  return undefined;
}

// معین‌هایی که در هر کدینگی تفصیلی‌دارند: بدهکاران و بستانکاران بدون طرف حساب
// معنا ندارند. وقتی فایل چیزی نگفته باشد، همین حدس زده می‌شود — حدسی که فقط
// یک هشدار می‌سازد و حسابدار می‌تواند خاموشش کند.
const ANALYTIC_ROLES = new Set(['receivable', 'payable']);

export function parseChartCsv(input) {
  const text = String(input ?? '').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length);
  if (lines.length < 2) throw chartError('فایل کدینگ باید سرستون و حداقل یک ردیف داشته باشد.', 'CHART_FILE_EMPTY');

  const separator = [',', ';', '\t'].reduce((best, candidate) => (
    splitCsvLine(lines[0], candidate).length > splitCsvLine(lines[0], best).length ? candidate : best
  ), ',');
  const headers = splitCsvLine(lines[0], separator).map(headerKey);
  const columnIndex = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = headers.findIndex((header) => aliases.includes(header));
    if (index >= 0) columnIndex[field] = index;
  }
  for (const required of ['code', 'name', 'level', 'type']) {
    if (columnIndex[required] == null) throw chartError(`ستون «${required}» در فایل کدینگ پیدا نشد. سرستون‌های لازم: کد، نام، سطح، نوع و در صورت وجود کد والد.`, 'CHART_COLUMN_MISSING');
  }

  const rows = lines.slice(1).map((line, index) => {
    const cells = splitCsvLine(line, separator);
    const cell = (field) => (columnIndex[field] == null ? '' : cells[columnIndex[field]] ?? '');
    return {
      rowNumber: index + 2,
      code: cell('code'), name: cell('name'), level: cell('level'),
      type: cell('type'), parentCode: cell('parentCode'), role: cell('role'),
      levelCode: cell('levelCode'), requiresAnalytic: cell('requiresAnalytic'),
    };
  }).filter((row) => `${row.code}${row.name}`.trim().length);

  return { rows, separator, columnIndex };
}

// ---------------------------------------------------------------------------
// کدینگ پیش‌فرض پیشنهادی
// ---------------------------------------------------------------------------

// کدینگ شروع، نه کدینگ رسمی. دفتر می‌تواند آن را بپذیرد یا کدینگ خودش را وارد کند.
export const DEFAULT_CHART_TEMPLATE = Object.freeze([
  ['1', 'دارایی‌های جاری', 'group', '', 'asset', ''],
  ['11', 'موجودی نقد و بانک', 'general', '1', 'asset', ''],
  ['1101', 'صندوق', 'subsidiary', '11', 'asset', 'cash'],
  ['1102', 'بانک', 'subsidiary', '11', 'asset', 'bank'],
  ['1103', 'تنخواه‌گردان', 'subsidiary', '11', 'asset', ''],
  ['12', 'حساب‌ها و اسناد دریافتنی', 'general', '1', 'asset', ''],
  ['1201', 'حساب‌های دریافتنی تجاری', 'subsidiary', '12', 'asset', 'receivable'],
  ['1203', 'اسناد دریافتنی (چک)', 'subsidiary', '12', 'asset', 'note-receivable'],
  ['1202', 'اسناد دریافتنی', 'subsidiary', '12', 'asset', ''],
  ['13', 'موجودی کالا', 'general', '1', 'asset', ''],
  ['1301', 'موجودی کالا و مواد', 'subsidiary', '13', 'asset', 'inventory'],
  ['14', 'پیش‌پرداخت‌ها و مالیات', 'general', '1', 'asset', ''],
  ['1401', 'پیش‌پرداخت‌ها', 'subsidiary', '14', 'asset', ''],
  ['1402', 'مالیات و عوارض ارزش افزودهٔ خرید', 'subsidiary', '14', 'asset', 'input-tax'],
  ['2', 'دارایی‌های غیرجاری', 'group', '', 'asset', ''],
  ['21', 'دارایی‌های ثابت مشهود', 'general', '2', 'asset', ''],
  ['2101', 'اموال، ماشین‌آلات و تجهیزات', 'subsidiary', '21', 'asset', 'fixed-asset'],
  ['3', 'بدهی‌های جاری', 'group', '', 'liability', ''],
  ['31', 'حساب‌ها و اسناد پرداختنی', 'general', '3', 'liability', ''],
  ['3101', 'حساب‌های پرداختنی تجاری', 'subsidiary', '31', 'liability', 'payable'],
  ['3102', 'اسناد پرداختنی (چک)', 'subsidiary', '31', 'liability', 'note-payable'],
  ['32', 'مالیات و عوارض پرداختنی', 'general', '3', 'liability', ''],
  ['3201', 'مالیات و عوارض ارزش افزودهٔ فروش', 'subsidiary', '32', 'liability', 'output-tax'],
  ['33', 'حقوق و بیمهٔ پرداختنی', 'general', '3', 'liability', ''],
  ['3301', 'حقوق و دستمزد پرداختنی', 'subsidiary', '33', 'liability', 'salary-payable'],
  ['3302', 'بیمهٔ پرداختنی (تأمین اجتماعی)', 'subsidiary', '33', 'liability', 'insurance-payable'],
  ['3303', 'مالیات حقوق پرداختنی', 'subsidiary', '33', 'liability', 'payroll-tax-payable'],
  ['5', 'حقوق صاحبان سرمایه', 'group', '', 'equity', ''],
  ['51', 'سرمایه', 'general', '5', 'equity', ''],
  ['5101', 'سرمایه و ماندهٔ افتتاحیه', 'subsidiary', '51', 'equity', 'equity'],
  ['5102', 'آورده و افزایش سرمایه', 'subsidiary', '51', 'equity', 'owner-capital'],
  ['6', 'درآمدها', 'group', '', 'income', ''],
  ['61', 'درآمد عملیاتی', 'general', '6', 'income', ''],
  ['6101', 'فروش کالا', 'subsidiary', '61', 'income', 'sales'],
  ['6102', 'درآمد خدمات', 'subsidiary', '61', 'income', 'service-income'],
  ['62', 'درآمد غیرعملیاتی', 'general', '6', 'income', ''],
  ['6201', 'سایر درآمدها', 'subsidiary', '62', 'income', 'other-income'],
  ['6202', 'اضافی موجودی و تعدیلات', 'subsidiary', '62', 'income', 'inventory-gain'],
  ['7', 'بهای تمام‌شده', 'group', '', 'expense', ''],
  ['71', 'بهای تمام‌شدهٔ فروش', 'general', '7', 'expense', ''],
  ['7101', 'بهای تمام‌شدهٔ کالای فروش‌رفته', 'subsidiary', '71', 'expense', 'cogs'],
  ['8', 'هزینه‌ها', 'group', '', 'expense', ''],
  ['81', 'هزینه‌های عملیاتی', 'general', '8', 'expense', ''],
  ['8101', 'حقوق و دستمزد', 'subsidiary', '81', 'expense', 'salary-expense'],
  ['8106', 'بیمهٔ سهم کارفرما', 'subsidiary', '81', 'expense', 'employer-insurance-expense'],
  ['8102', 'اجاره', 'subsidiary', '81', 'expense', ''],
  ['8103', 'حمل‌ونقل', 'subsidiary', '81', 'expense', ''],
  ['8104', 'قبوض و انرژی', 'subsidiary', '81', 'expense', ''],
  ['8105', 'کسری و ضایعات موجودی', 'subsidiary', '81', 'expense', 'inventory-shrinkage'],
  ['8109', 'سایر هزینه‌های عملیاتی', 'subsidiary', '81', 'expense', 'operating-expense'],
].map(([code, name, level, parentCode, type, role]) => Object.freeze({ code, name, level, parentCode, type, role })));

// ---------------------------------------------------------------------------
// نوشتن و خواندن کدینگ
// ---------------------------------------------------------------------------

export function chartAccountByCode(database, code) {
  return database.prepare('SELECT * FROM chart_accounts WHERE code=?').get(normalizeChartCode(code)) || null;
}

export function importChartOfAccounts(database, rows = [], { source = 'import', replace = false, codingStyle = 'prefix' } = {}) {
  ensureChartSchema(database);
  const { accounts, errors } = validateChartRows(rows, { codingStyle });
  if (errors.length) throw Object.assign(chartError('فایل کدینگ ایراد دارد و هیچ ردیفی وارد نشد.', 'CHART_ROWS_INVALID'), { details: { errors } });
  if (!accounts.length) throw chartError('هیچ حساب معتبری در فایل نبود.', 'CHART_ROWS_EMPTY');

  database.exec('BEGIN IMMEDIATE');
  try {
    if (replace) {
      // فقط کدینگی که هنوز به هیچ حساب داخلی و هیچ سندی وصل نشده قابل جایگزینی است.
      const linked = database.prepare('SELECT COUNT(*) AS count FROM ledger_accounts WHERE chart_account_id IS NOT NULL').get().count;
      if (linked) throw chartError('کدینگ فعلی به حساب‌های دفتر نگاشت شده است؛ پیش از جایگزینی باید نگاشت‌ها برداشته شوند.', 'CHART_IN_USE', 409);
      // فرزند پیش از والد. حذف یک‌جا به کلید خارجیِ خودارجاع می‌خورد و
      // جایگزینی کدینگ را — حتی با نبودِ هر نگاشتی — غیرممکن می‌کرد.
      for (const level of ['subsidiary', 'general', 'group']) {
        database.prepare('DELETE FROM chart_accounts WHERE level=?').run(level);
      }
    }
    const insert = database.prepare(`INSERT INTO chart_accounts (id,code,name,level,parent_id,type,normal_side,role,source,level_code,requires_analytic)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET name=excluded.name,role=excluded.role,level_code=excluded.level_code,
        requires_analytic=excluded.requires_analytic`);
    let created = 0;
    let updated = 0;
    for (const account of accounts) {
      const existing = database.prepare('SELECT id,level,type FROM chart_accounts WHERE code=?').get(account.code);
      if (existing && (existing.level !== account.level || existing.type !== account.type)) {
        throw chartError(`حساب ${account.code} از قبل با سطح یا نوع دیگری وجود دارد و بی‌سروصدا بازنویسی نمی‌شود. اگر می‌خواهی کدینگ دفتر جای کدینگ فعلی را بگیرد، اول «برداشتن همهٔ نگاشت‌ها» را بزن و بعد با گزینهٔ «کدینگ فعلی جایگزین شود» وارد کن.`, 'CHART_CONFLICT', 409);
      }
      const parentId = account.parentCode ? database.prepare('SELECT id FROM chart_accounts WHERE code=?').get(account.parentCode)?.id || null : null;
      if (account.parentCode && !parentId) throw chartError(`والد ${account.parentCode} پیدا نشد.`, 'CHART_PARENT_MISSING');
      insert.run(existing?.id || randomUUID(), account.code, account.name, account.level, parentId, account.type, account.normalSide, account.role, source, account.levelCode || account.code, account.requiresAnalytic ? 1 : 0);
      if (existing) updated += 1; else created += 1;
    }
    database.exec('COMMIT');
    return { created, updated, total: accounts.length, source };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

export function installDefaultChartTemplate(database) {
  return importChartOfAccounts(database, DEFAULT_CHART_TEMPLATE.map((item) => ({ ...item })), { source: 'template' });
}

export function saveChartAccount(database, values = {}) {
  ensureChartSchema(database);
  const code = normalizeChartCode(values.code);
  const existing = values.id ? database.prepare('SELECT * FROM chart_accounts WHERE id=?').get(values.id) : chartAccountByCode(database, code);
  const level = normalizeChartLevel(values.level) || existing?.level;
  const type = normalizeChartType(values.type) || existing?.type;
  const name = cleanName(values.name) || existing?.name;
  if (!chartCodeIsValid(code)) throw chartError('کد حساب باید فقط رقم و حداکثر ۱۲ رقم باشد.');
  if (!name) throw chartError('نام حساب خالی است.');
  if (!level || !type) throw chartError('سطح و نوع حساب لازم است.');

  const parentCode = values.parentCode == null ? existing?.parent_id && database.prepare('SELECT code FROM chart_accounts WHERE id=?').get(existing.parent_id)?.code : normalizeChartCode(values.parentCode);
  const siblings = database.prepare('SELECT code,name,level,type,role FROM chart_accounts WHERE code<>?').all(code)
    .map((row) => ({ ...row, parentCode: null }));
  const parent = parentCode ? chartAccountByCode(database, parentCode) : null;
  if (parentCode && !parent) throw chartError(`حساب والد با کد ${parentCode} در کدینگ نیست.`, 'CHART_PARENT_MISSING');

  const { errors } = validateChartRows([
    ...(parent ? [{ rowNumber: 0, code: parent.code, name: parent.name, level: parent.level, type: parent.type, parentCode: '' }] : []),
    { rowNumber: 1, code, name, level, type, parentCode: parent ? parent.code : '', role: values.role },
  ].filter((row, index, all) => all.findIndex((item) => item.code === row.code) === index));
  // ایراد والد ساختگی (که والد خودش را در این نمونه ندارد) نادیده گرفته می‌شود.
  const realErrors = errors.filter((item) => item.code === code);
  if (realErrors.length) throw Object.assign(chartError(realErrors[0].message), { details: { errors: realErrors } });
  void siblings;

  const role = CHART_ROLES.includes(String(values.role || '').trim()) ? String(values.role).trim() : (existing?.role || '');
  const id = existing?.id || randomUUID();
  const requiresAnalytic = values.requiresAnalytic === undefined
    ? (existing?.requires_analytic ?? (level === 'subsidiary' && ANALYTIC_ROLES.has(role) ? 1 : 0))
    : (values.requiresAnalytic ? 1 : 0);
  database.prepare(`INSERT INTO chart_accounts (id,code,name,level,parent_id,type,normal_side,role,active,source,requires_analytic)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,parent_id=excluded.parent_id,role=excluded.role,
      active=excluded.active,requires_analytic=excluded.requires_analytic`)
    .run(id, code, name, level, parent?.id || null, type, CHART_TYPES[type].normalSide, role,
      values.active === false ? 0 : (existing?.active ?? 1), existing?.source || 'manual', requiresAnalytic);
  return database.prepare('SELECT * FROM chart_accounts WHERE id=?').get(id);
}

export function listChartAccounts(database, { includeInactive = false } = {}) {
  ensureChartSchema(database);
  const rows = database.prepare(`SELECT chart_accounts.id,chart_accounts.code,chart_accounts.name,chart_accounts.level,
    chart_accounts.type,chart_accounts.normal_side AS normalSide,chart_accounts.role,chart_accounts.active,chart_accounts.source,
    chart_accounts.level_code AS levelCode,chart_accounts.requires_analytic AS requiresAnalytic,
    parent.code AS parentCode,parent.name AS parentName,
    (SELECT COUNT(*) FROM ledger_accounts WHERE ledger_accounts.chart_account_id=chart_accounts.id) AS mappedAccounts
    FROM chart_accounts LEFT JOIN chart_accounts AS parent ON parent.id=chart_accounts.parent_id
    ${includeInactive ? '' : 'WHERE chart_accounts.active=1'}
    ORDER BY chart_accounts.code`).all();
  return rows.map((row) => ({
    ...row,
    active: Boolean(row.active),
    requiresAnalytic: Boolean(row.requiresAnalytic),
    levelLabel: CHART_LEVELS[row.level].label,
    typeLabel: CHART_TYPES[row.type].label,
    postable: row.level === 'subsidiary',
  }));
}

// ---------------------------------------------------------------------------
// نگاشت حساب‌های داخلی حساب‌یار به کدینگ دفتر
// ---------------------------------------------------------------------------

// حساب داخلی حساب‌یار از روی منبعش شناخته می‌شود؛ این جدول می‌گوید هر منبع
// طبیعتاً به کدام نقش کدینگ می‌نشیند. پیشنهاد است، نه تصمیم قطعی.
const ROLE_BY_SOURCE_KIND = {
  'customer-receivable': ['receivable'],
  'vendor-payable': ['payable'],
  'inventory-product': ['inventory'],
  'cogs-product': ['cogs'],
  'income-category': ['sales', 'service-income', 'other-income'],
  'expense-category': ['operating-expense'],
  'payroll-salary-expense': ['salary-expense', 'operating-expense'],
  'payroll-insurance-expense': ['employer-insurance-expense', 'operating-expense'],
  'payroll-salary-payable': ['salary-payable', 'payable'],
  'payroll-insurance-payable': ['insurance-payable', 'payable'],
  'payroll-tax-payable': ['payroll-tax-payable', 'payable'],
  'cheque-receivable': ['note-receivable', 'receivable'],
  'cheque-payable': ['note-payable', 'payable'],
  'operational-account': ['cash', 'bank'],
  // هر دارایی ثابت حساب دفترکل خودش را می‌گیرد؛ همه به همان معین اموال نگاشته می‌شوند.
  'fixed-asset': ['fixed-asset'],
};

const ROLE_BY_SOURCE_KEY = {
  'output-tax': 'output-tax',
  'input-tax': 'input-tax',
  'opening-equity': 'equity',
  'owner-capital': 'owner-capital',
  'inventory-gain': 'inventory-gain',
  'inventory-shrinkage': 'inventory-shrinkage',
};

/**
 * برای یک حساب داخلی، مناسب‌ترین معین کدینگ را پیشنهاد می‌دهد.
 * اگر نقش دقیق پیدا نشود، اولین معین هم‌نوع پیشنهاد می‌شود و اگر آن هم نبود null.
 */
/**
 * واژه‌هایی که در نام حساب معنا اضافه نمی‌کنند.
 *
 * «هزینهٔ اجارهٔ محل» و «اجاره» یک چیزند؛ بدون کنار گذاشتن این واژه‌ها هر دو
 * نام تقریباً بی‌شباهت شمرده می‌شوند.
 */
const NAME_NOISE = new Set(['هزینه', 'هزینه‌های', 'هزینههای', 'حساب', 'حسابهای', 'حساب‌های', 'درآمد', 'درآمدها',
  'و', 'از', 'بابت', 'محل', 'مصرفی', 'جاری', 'سایر', 'تجاری', 'متفرقه', 'دریافتنی', 'پرداختنی', 'ها', 'های']);

function nameTokens(value) {
  return normalizePersian(String(value || ''))
    .replace(/[()\[\]{}«»"'،,؛;:.\-_/]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !NAME_NOISE.has(token));
}

/**
 * هم‌پوشانی نام حساب داخلی با نام معین دفتر.
 *
 * نسبت واژه‌های مشترک به نام کوتاه‌تر: «ملزومات اداری» و «هزینه ملزومات و نوشت
 * افزار» یک واژهٔ مشترک از دو واژه دارند، و همان کافی است.
 */
function nameScore(first, second) {
  const left = new Set(nameTokens(first));
  const right = new Set(nameTokens(second));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/**
 * بهترین معین هم‌نام، فقط وقتی یکی و آشکار باشد.
 *
 * دو معین با امتیاز برابر یعنی نام‌ها روشن نیستند؛ انتخاب یکی از آن دو سکه
 * انداختن است و جای آن اینجا نیست.
 */
function bestNameMatch(ledgerAccount, postable, threshold = 0.5) {
  const scored = postable
    .map((item) => ({ item, score: nameScore(ledgerAccount.name || ledgerAccount.sourceKey, item.name) }))
    .filter((entry) => entry.score >= threshold)
    .sort((first, second) => second.score - first.score);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;
  return scored[0].item;
}

export function suggestChartAccount(ledgerAccount, chartAccounts = [], { specific = true, confidentOnly = false } = {}) {
  // معینِ هم‌نوع، وگرنه اصلاً پیشنهاد نکن.
  //
  // کدهای دستهٔ هزینه و درآمد (`chartCodeForCategory`) از کدینگ پیشنهادی خودِ
  // حساب‌یار می‌آیند. وقتی دفتر کدینگ خودش را وارد می‌کند، همان کد معنای دیگری
  // دارد: «۱۳۰۱» در کدینگ ما «موجودی کالا» است و در کدینگ یک دفتر واقعی
  // «اسناد دریافتنی». پیشنهادِ بی‌توجه به نوع، یا نگاشت را با خطا می‌شکست یا
  // بدتر، هزینه را روی یک دارایی می‌نشاند.
  const sameType = (item) => !ledgerAccount.type || item.type === ledgerAccount.type;
  const postable = chartAccounts.filter((item) => item.postable !== false && item.level === 'subsidiary'
    && item.active !== false && sameType(item));
  const byRole = (role) => postable.find((item) => item.role === role) || null;

  const sourceKey = ledgerAccount.sourceKey || ledgerAccount.source_key;
  const keyRole = ROLE_BY_SOURCE_KEY[sourceKey];
  if (keyRole) return byRole(keyRole);

  const sourceKind = ledgerAccount.sourceKind || ledgerAccount.source_kind;
  // نقشِ `operating-expense` را فقط یک معین دارد (۸۱۰۹ سایر هزینه‌های عملیاتی)،
  // پس هر دستهٔ هزینه‌ای — اجاره، حمل‌ونقل، قبوض — همان‌جا می‌نشست و در پارسیان
  // همه‌چیز در یک حساب کلی جمع می‌شد. حساب دستهٔ دفتر، `source_key` برابر نام
  // دسته دارد، پس کد اختصاصی همان دسته از قبل معلوم است.
  //
  // `specific: false` عمداً همان پیشنهادِ عمومیِ قبلی را برمی‌گرداند تا بشود
  // تشخیص داد یک نگاشت موجود، خودکارِ عمومی بوده یا انتخاب آگاهانهٔ حسابدار.
  if (['income-category', 'expense-category'].includes(sourceKind)) {
    const code = specific ? chartCodeForCategory(sourceKey) : null;
    const exact = code ? postable.find((item) => normalizeChartCode(item.code) === code) : null;
    if (exact) return exact;
    // کد دسته‌ها از کدینگ پیشنهادی خودمان می‌آید و در کدینگ دفتر معنای دیگری
    // دارد. وقتی کد نخورد، نام تنها نشانهٔ قابل اتکاست: «حقوق و دستمزد» به
    // «هزینه حقوق و دستمزد» می‌خورد، نه به اولین معین هزینه‌ای فهرست.
    if (specific) {
      const byName = bestNameMatch(ledgerAccount, postable);
      if (byName) return byName;
    }
    // نقشِ `operating-expense` یک سطل عمومی است، نه نگاشت. برای پیشنهاد به
    // کاربر قابل قبول است، ولی نگاشت خودکارِ بی‌صدا با آن یعنی هر دستهٔ تازه
    // در «سایر هزینه‌ها» دفن می‌شود و هیچ‌وقت به چشم حسابدار نمی‌آید.
    if (confidentOnly) return null;
  }
  if (sourceKind === 'operational-account') {
    const name = String(ledgerAccount.name || '');
    const wantsBank = /بانک|کارت|شبا|حساب جاری/.test(name);
    return byRole(wantsBank ? 'bank' : 'cash') || byRole(wantsBank ? 'cash' : 'bank');
  }
  for (const role of ROLE_BY_SOURCE_KIND[sourceKind] || []) {
    const match = byRole(role);
    if (match) return match;
  }
  // نام، آخرین نشانهٔ واقعی است.
  const byName = bestNameMatch(ledgerAccount, postable);
  if (byName) return byName;
  // و اگر نامی هم نخورد، هیچ پیشنهادی داده نمی‌شود.
  //
  // پیش از این «اولین معین هم‌نوع» برگردانده می‌شد. روی کدینگ یک دفتر واقعی،
  // همهٔ دسته‌های هزینه — حقوق، اجاره، قبوض، حمل — روی معین شمارهٔ یکِ کل
  // هزینه‌ها نشستند («بازاریاب») و در پارسیان همه‌چیز در یک حساب بی‌ربط جمع شد.
  // حساب بدون نگاشت در فهرست «بدون نگاشت» دیده می‌شود و حسابدار خودش
  // انتخاب می‌کند؛ این بسیار بهتر از نگاشت خاموشِ غلط است.
  return null;
}

export function mapLedgerAccountToChart(database, ledgerAccountId, chartAccountId) {
  ensureChartSchema(database);
  const ledger = database.prepare('SELECT id,type,name FROM ledger_accounts WHERE id=?').get(String(ledgerAccountId || ''));
  if (!ledger) throw chartError('حساب دفتر کل پیدا نشد.', 'LEDGER_ACCOUNT_MISSING', 404);
  if (!chartAccountId) {
    database.prepare('UPDATE ledger_accounts SET chart_account_id=NULL WHERE id=?').run(ledger.id);
    return { ledgerAccountId: ledger.id, chartAccount: null };
  }
  const chart = database.prepare('SELECT * FROM chart_accounts WHERE id=? OR code=?').get(String(chartAccountId), normalizeChartCode(chartAccountId));
  if (!chart) throw chartError('حساب کدینگ پیدا نشد.', 'CHART_ACCOUNT_MISSING', 404);
  if (chart.level !== 'subsidiary') throw chartError('فقط حساب معین قابل نگاشت است؛ گروه و کل سند نمی‌پذیرند.', 'CHART_NOT_POSTABLE');
  if (!chart.active) throw chartError('حساب کدینگ غیرفعال است.', 'CHART_ACCOUNT_INACTIVE');
  if (chart.type !== ledger.type) throw chartError(`نوع حساب «${ledger.name}» با معین ${chart.code} یکی نیست.`, 'CHART_TYPE_MISMATCH');
  database.prepare('UPDATE ledger_accounts SET chart_account_id=? WHERE id=?').run(chart.id, ledger.id);
  return { ledgerAccountId: ledger.id, chartAccount: chart };
}

/**
 * وضعیت نگاشت: چه چیزی نگاشت شده، چه چیزی نشده و برای نشده‌ها چه پیشنهادی هست.
 * این خروجی هم صفحهٔ کدینگ را می‌سازد و هم دروازهٔ آمادگی خروجی را تغذیه می‌کند.
 */
/**
 * نگاشت چند حساب به یک معین، در یک تصمیم.
 *
 * دفتری با ده‌ها دستهٔ هزینه، ده‌ها بار کشیدن فهرست کشویی را تحمل نمی‌کند؛ و
 * حساب‌یار هم دیگر «اولین معین هم‌نوع» را حدس نمی‌زند. پس انتخاب یک‌بارهٔ
 * معین برای یک گروه حساب، همان چیزی است که کار دستی را کوتاه می‌کند بی‌آنکه
 * تصمیم از دست حسابدار در برود.
 *
 * حساب‌هایی که با نوع معین نمی‌خوانند رد می‌شوند، ولی بقیه انجام می‌شوند: یک
 * ردیف ناسازگار نباید کل اقدام را برگرداند.
 */
export function bulkMapLedgerAccounts(database, ledgerAccountIds = [], chartAccountId = null) {
  ensureChartSchema(database);
  const ids = [...new Set((Array.isArray(ledgerAccountIds) ? ledgerAccountIds : []).map((item) => String(item || '')).filter(Boolean))];
  if (!ids.length) throw chartError('هیچ حسابی برای نگاشت انتخاب نشده است.', 'LEDGER_ACCOUNTS_EMPTY');
  const skipped = [];
  let mapped = 0;
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const id of ids) {
      try { mapLedgerAccountToChart(database, id, chartAccountId); mapped += 1; }
      catch (error) {
        if (!['CHART_TYPE_MISMATCH', 'LEDGER_ACCOUNT_MISSING'].includes(error.code)) throw error;
        skipped.push({ ledgerAccountId: id, message: error.message });
      }
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return { mapped, skipped };
}

export function chartMappingOverview(database) {
  ensureChartSchema(database);
  const chartAccounts = listChartAccounts(database);
  const ledgerAccounts = database.prepare(`SELECT ledger_accounts.id,ledger_accounts.code,ledger_accounts.name,ledger_accounts.type,
    ledger_accounts.source_kind AS sourceKind,ledger_accounts.source_key AS sourceKey,ledger_accounts.active,
    ledger_accounts.chart_account_id AS chartAccountId,
    chart_accounts.code AS chartCode,chart_accounts.name AS chartName
    FROM ledger_accounts LEFT JOIN chart_accounts ON chart_accounts.id=ledger_accounts.chart_account_id
    WHERE ledger_accounts.active=1 ORDER BY CAST(ledger_accounts.code AS INTEGER)`).all();

  const items = ledgerAccounts.map((account) => {
    const suggestion = account.chartAccountId ? null : suggestChartAccount(account, chartAccounts);
    return {
      ...account,
      mapped: Boolean(account.chartAccountId),
      typeLabel: CHART_TYPES[account.type]?.label || account.type,
      suggestion: suggestion ? { id: suggestion.id, code: suggestion.code, name: suggestion.name } : null,
    };
  });
  const unmapped = items.filter((item) => !item.mapped);
  // حسابی که هیچ سندی نخورده، جلوی خروجی را نمی‌گیرد. تفاوت این دو عدد مهم
  // است: کنترل آمادگی فقط حساب‌های استفاده‌شده را می‌بیند، ولی فهرست نگاشت
  // همه را نشان می‌دهد — و گفتن «تا رفع نشود خروجی ساخته نمی‌شود» دربارهٔ
  // حسابی که اصلاً استفاده نشده، دروغ است.
  const usedAccounts = new Set(database.prepare('SELECT DISTINCT account_id AS id FROM journal_lines').all().map((row) => row.id));
  const usedUnmapped = unmapped.filter((item) => usedAccounts.has(item.id));
  return {
    chartInstalled: chartAccounts.length > 0,
    chartAccountCount: chartAccounts.length,
    postableCount: chartAccounts.filter((item) => item.postable).length,
    items,
    mappedCount: items.length - unmapped.length,
    unmappedCount: unmapped.length,
    usedUnmappedCount: usedUnmapped.length,
    // کدینگ وقتی «کامل» است که هیچ حساب استفاده‌شده‌ای بدون معین نمانده
    // باشد. حسابی که سندی نخورده، چیزی را خراب نمی‌کند.
    complete: chartAccounts.length > 0 && usedUnmapped.length === 0,
    suggestionsAvailable: unmapped.filter((item) => item.suggestion).length,
  };
}

/**
 * `refine` نگاشت‌های موجودی را هم اصلاح می‌کند که پیش از شناختن معین اختصاصیِ
 * دسته‌ها ساخته شده‌اند — مثلاً «اجاره» که روی ۸۱۰۹ سایر هزینه‌ها نشسته بود.
 *
 * انتخاب آگاهانهٔ حسابدار بازنویسی نمی‌شود. چون جدول نگاشت ستون منشأ ندارد،
 * ملاک این است: فقط نگاشتی جابه‌جا می‌شود که **دقیقاً** همان پیشنهاد عمومیِ
 * قبلی باشد. هر کد دیگری یعنی کسی آگاهانه انتخابش کرده و دست‌نخورده می‌ماند.
 */
export function applySuggestedChartMappings(database, { refine = false } = {}) {
  const overview = chartMappingOverview(database);
  if (!overview.chartInstalled) throw chartError('ابتدا کدینگ را وارد کن یا کدینگ پیش‌فرض را نصب کن.', 'CHART_NOT_INSTALLED');
  const chartAccounts = listChartAccounts(database);
  let applied = 0;
  let refined = 0;
  for (const item of overview.items) {
    if (!item.mapped) {
      if (!item.suggestion) continue;
      // یک پیشنهاد نامناسب نباید بقیهٔ نگاشت‌ها را هم زمین بزند؛ همان یکی
      // نگاشت‌نشده می‌ماند و در فهرست «بدون نگاشت» به چشم حسابدار می‌آید.
      try { mapLedgerAccountToChart(database, item.id, item.suggestion.id); applied += 1; }
      catch (error) { if (error.code !== 'CHART_TYPE_MISMATCH') throw error; }
      continue;
    }
    if (!refine) continue;
    const specific = suggestChartAccount(item, chartAccounts);
    const generic = suggestChartAccount(item, chartAccounts, { specific: false });
    const current = normalizeChartCode(item.chartCode);
    if (!specific || !generic) continue;
    if (normalizeChartCode(specific.code) === current) continue;
    if (normalizeChartCode(generic.code) !== current) continue;
    mapLedgerAccountToChart(database, item.id, specific.id);
    refined += 1;
  }
  return { applied, refined, ...chartMappingOverview(database) };
}

// ---------------------------------------------------------------------------
// تفصیلی شناور و مرکز هزینه
// ---------------------------------------------------------------------------

function nextDimensionCode(database, table, prefix) {
  const rows = database.prepare(`SELECT code FROM ${table} WHERE code LIKE ?`).all(`${prefix}%`);
  const used = new Set(rows.map((row) => Number(String(row.code).slice(prefix.length))).filter(Number.isFinite));
  let index = 1;
  while (used.has(index)) index += 1;
  return `${prefix}${String(index).padStart(4, '0')}`;
}

export function saveAnalyticAccount(database, values = {}) {
  ensureChartSchema(database);
  const name = cleanName(values.name);
  if (!name) throw chartError('نام تفصیلی خالی است.');
  const kind = Object.hasOwn(ANALYTIC_KINDS, values.kind) ? values.kind : 'custom';
  const sourceKind = values.sourceKind ? String(values.sourceKind).slice(0, 40) : null;
  const sourceKey = values.sourceKey ? String(values.sourceKey).slice(0, 120) : null;
  const existing = values.id
    ? database.prepare('SELECT * FROM analytic_accounts WHERE id=?').get(values.id)
    : (sourceKind && sourceKey ? database.prepare('SELECT * FROM analytic_accounts WHERE source_kind=? AND source_key=?').get(sourceKind, sourceKey) : null);
  const code = normalizeChartCode(values.code) || existing?.code || nextDimensionCode(database, 'analytic_accounts', '');
  if (!chartCodeIsValid(code)) throw chartError('کد تفصیلی باید فقط رقم باشد.');
  const id = existing?.id || randomUUID();
  const externalCode = values.externalCode === undefined ? existing?.external_code || null : (normalizeChartCode(values.externalCode) || null);
  if (externalCode && !chartCodeIsValid(externalCode)) throw chartError('کد تفصیلی مقصد باید فقط رقم باشد.');
  database.prepare(`INSERT INTO analytic_accounts (id,code,name,kind,source_kind,source_key,active,external_code) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,kind=excluded.kind,
      active=excluded.active,external_code=excluded.external_code`)
    .run(id, code, name, kind, sourceKind, sourceKey, values.active === false ? 0 : 1, externalCode);
  return database.prepare('SELECT * FROM analytic_accounts WHERE id=?').get(id);
}

/**
 * تفصیلیِ متناظر با نامِ روی حسابِ طرف حساب — فقط وقتی آن نام واقعاً یک شخص است.
 *
 * حسابِ اختصاصی گاهی به نام کسی باز می‌شود که در دفتر ثبت شده و گاهی با عنوان
 * خودِ تعهد («بدهی بابت اجاره»). این تابع فقط حالت اول را برمی‌گرداند: شخصی که
 * در طرف‌حساب‌های دفتر هست، یا از قبل تفصیلی دارد.
 *
 * چرا حالت دوم نه: تفصیلیِ ساختگی در فهرست اشخاصِ نرم‌افزار دفتر می‌ماند و با
 * هیچ‌کس یکی نمی‌شود. آن ردیف به تفصیلی نیاز ندارد، به طرف حساب نیاز دارد — و
 * حالا کنترل «تفصیلی اجباری» جلوی خروجی را می‌گیرد و همین را می‌گوید، پس
 * دیگر بی‌صدا هم نمی‌شکند.
 */
export function counterpartyAnalyticForKey(database, key) {
  const name = String(key || '').trim().slice(0, 120);
  const canonical = canonicalCounterpartyName(name);
  if (!name || !canonical) return null;
  try {
    const contact = database.prepare('SELECT id,name FROM contacts WHERE canonical_name=? ORDER BY created_at,rowid LIMIT 1').get(canonical);
    if (contact) return analyticForContact(database, contact.id, contact.name)?.id || null;
  } catch { /* دفتری که هنوز جدول طرف حساب ندارد. */ }
  // تفصیلیِ هم‌نامِ موجود هم همان شخص است — چه از ثبت قبلی آمده باشد چه از
  // فایل تفصیلی نرم‌افزار دفتر.
  const existing = database.prepare('SELECT id,name FROM analytic_accounts WHERE active=1').all()
    .filter((item) => canonicalCounterpartyName(item.name) === canonical);
  return existing.length === 1 ? existing[0].id : null;
}

// طرف حساب دفتر به‌طور خودکار یک تفصیلی می‌گیرد؛ این همان چیزی است که حسابدار
// انتظار دارد: یک معین «حساب‌های دریافتنی» و مشتری‌ها به‌عنوان تفصیلی زیر آن.
export function analyticForContact(database, contactId, name) {
  if (!contactId && !name) return null;
  const key = String(contactId || name).slice(0, 120);
  return saveAnalyticAccount(database, { name: name || 'طرف حساب', kind: 'contact', sourceKind: 'contact', sourceKey: key });
}

export function listAnalyticAccounts(database, { includeInactive = false } = {}) {
  ensureChartSchema(database);
  // کد مقصد هم برمی‌گردد، وگرنه حسابدار نمی‌بیند کدام طرف حساب هنوز در نرم‌افزار
  // دفتر کدی ندارد — و همان‌ها در فایل انتقال بی‌نام بالا می‌آیند.
  return database.prepare(`SELECT id,code,name,kind,source_kind AS sourceKind,source_key AS sourceKey,active,
    external_code AS externalCode
    FROM analytic_accounts ${includeInactive ? '' : 'WHERE active=1'} ORDER BY code`).all()
    .map((row) => ({ ...row, active: Boolean(row.active), kindLabel: ANALYTIC_KINDS[row.kind] || ANALYTIC_KINDS.custom }));
}

export function saveCostCenter(database, values = {}) {
  ensureChartSchema(database);
  const name = cleanName(values.name);
  if (!name) throw chartError('نام مرکز هزینه خالی است.');
  const existing = values.id ? database.prepare('SELECT * FROM cost_centers WHERE id=?').get(values.id) : null;
  const code = normalizeChartCode(values.code) || existing?.code || nextDimensionCode(database, 'cost_centers', '');
  if (!chartCodeIsValid(code)) throw chartError('کد مرکز هزینه باید فقط رقم باشد.');
  let parentId = null;
  if (values.parentId) {
    const parent = database.prepare('SELECT id FROM cost_centers WHERE id=?').get(values.parentId);
    if (!parent) throw chartError('مرکز هزینهٔ والد پیدا نشد.', 'COST_CENTER_PARENT_MISSING');
    if (existing && parent.id === existing.id) throw chartError('مرکز هزینه نمی‌تواند والد خودش باشد.');
    parentId = parent.id;
  }
  const id = existing?.id || randomUUID();
  database.prepare(`INSERT INTO cost_centers (id,code,name,parent_id,active) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,parent_id=excluded.parent_id,active=excluded.active`)
    .run(id, code, name, parentId, values.active === false ? 0 : 1);
  return database.prepare('SELECT * FROM cost_centers WHERE id=?').get(id);
}

export function listCostCenters(database, { includeInactive = false } = {}) {
  ensureChartSchema(database);
  return database.prepare(`SELECT cost_centers.id,cost_centers.code,cost_centers.name,cost_centers.active,
    parent.code AS parentCode,parent.name AS parentName FROM cost_centers
    LEFT JOIN cost_centers AS parent ON parent.id=cost_centers.parent_id
    ${includeInactive ? '' : 'WHERE cost_centers.active=1'} ORDER BY cost_centers.code`).all()
    .map((row) => ({ ...row, active: Boolean(row.active) }));
}

/**
 * آرتیکل سند را برای ابعاد می‌سنجد. بعد فقط وقتی پذیرفته می‌شود که واقعاً وجود
 * داشته باشد و فعال باشد؛ شناسهٔ دلخواه ساکت نادیده گرفته نمی‌شود.
 */
export function resolveLineDimensions(database, line = {}) {
  const analyticId = String(line.analyticId || '').trim() || null;
  const costCenterId = String(line.costCenterId || '').trim() || null;
  if (analyticId && !database.prepare('SELECT 1 FROM analytic_accounts WHERE id=? AND active=1').get(analyticId)) {
    throw chartError('تفصیلی انتخاب‌شده معتبر یا فعال نیست.', 'ANALYTIC_INVALID');
  }
  if (costCenterId && !database.prepare('SELECT 1 FROM cost_centers WHERE id=? AND active=1').get(costCenterId)) {
    throw chartError('مرکز هزینهٔ انتخاب‌شده معتبر یا فعال نیست.', 'COST_CENTER_INVALID');
  }
  return { analyticId, costCenterId };
}

/**
 * گردش و ماندهٔ هر بعد در یک بازه. این گزارش تنها دلیل واقعی داشتن تفصیلی و
 * مرکز هزینه است: «این پروژه/این شعبه چقدر خرج برداشت؟»
 */
export function dimensionBalance(database, { dimension = 'costCenter', from = '', to = '' } = {}) {
  ensureChartSchema(database);
  const isAnalytic = dimension === 'analytic';
  const table = isAnalytic ? 'analytic_accounts' : 'cost_centers';
  const column = isAnalytic ? 'analytic_id' : 'cost_center_id';
  const conditions = [];
  const params = [];
  if (from) { conditions.push('journal_entries.occurred_at>=?'); params.push(new Date(from).toISOString()); }
  if (to) { conditions.push('journal_entries.occurred_at<=?'); params.push(new Date(to).toISOString()); }
  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

  const rows = database.prepare(`SELECT ${table}.id,${table}.code,${table}.name,
    COALESCE(SUM(journal_lines.debit),0) AS debit,COALESCE(SUM(journal_lines.credit),0) AS credit,
    COUNT(journal_lines.id) AS lineCount
    FROM ${table}
    LEFT JOIN journal_lines ON journal_lines.${column}=${table}.id
    LEFT JOIN journal_entries ON journal_entries.id=journal_lines.entry_id ${where}
    GROUP BY ${table}.id ORDER BY ${table}.code`).all(...params)
    .map((row) => ({ ...row, balance: Number(row.debit) - Number(row.credit) }));

  const unassigned = database.prepare(`SELECT COALESCE(SUM(journal_lines.debit),0) AS debit,COALESCE(SUM(journal_lines.credit),0) AS credit,
    COUNT(journal_lines.id) AS lineCount FROM journal_lines
    JOIN journal_entries ON journal_entries.id=journal_lines.entry_id
    WHERE journal_lines.${column} IS NULL ${where.replace(/^AND /, 'AND ')}`).get(...params);

  return {
    dimension: isAnalytic ? 'analytic' : 'costCenter',
    dimensionLabel: isAnalytic ? 'تفصیلی شناور' : 'مرکز هزینه',
    unit: 'IRT',
    rows,
    // ردیف‌های بدون بعد پنهان نمی‌شوند؛ حسابدار باید بداند چه بخشی تخصیص نیافته.
    unassigned: { debit: Number(unassigned?.debit || 0), credit: Number(unassigned?.credit || 0), lineCount: Number(unassigned?.lineCount || 0) },
    generatedAt: new Date().toISOString(),
  };
}
