// ورود داده از اکسل و پارسیان به حساب‌یار.
//
// جهت واقعی کار دفتر حسابداری دوطرفه است: کدینگ، طرف‌حساب‌ها و ماندهٔ افتتاحیه
// از قبل در نرم‌افزار اصلی وجود دارند. اگر حساب‌یار آن‌ها را نخواند، کمک‌حسابدار
// باید همه را دوباره تایپ کند و همان دوباره‌کاری‌ای که قرار بود حذف شود برمی‌گردد.
//
// قاعدهٔ ثابت این ماژول: فایل ایرادکننده هیچ ردیفی وارد نمی‌کند و هیچ مبلغی
// حدس زده نمی‌شود.

import { randomUUID } from 'node:crypto';
import { readTabularFile } from './spreadsheet.js';
import {
  ANALYTIC_KINDS, chartCodeIsValid, ensureChartSchema, normalizeChartCode, saveAnalyticAccount,
} from './chartOfAccounts.js';

function importError(message, code = 'IMPORT_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

const digitMap = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9', '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
function latin(value) { return String(value ?? '').replace(/[۰-۹٠-٩]/g, (digit) => digitMap[digit]); }
function headerKey(value) { return latin(value).replace(/^﻿/, '').trim().toLowerCase().replace(/[\s_\-()]+/g, ''); }
function cleanText(value, limit = 120) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit); }

/**
 * مبلغ سلول را می‌خواند. جداکنندهٔ هزار، ارقام فارسی و پرانتز منفی حسابداری
 * پشتیبانی می‌شوند. سلول غیرعددی «صفر» تلقی نمی‌شود و null برمی‌گردد.
 */
export function parseCellAmount(value) {
  const raw = latin(value).trim();
  if (!raw) return 0;
  const negative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  const digits = raw.replace(/[()\-\s,٬]/g, '');
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const number = Math.round(Number(digits));
  if (!Number.isSafeInteger(number)) return null;
  return negative ? -number : number;
}

function matchColumns(headerRow, aliases) {
  const headers = (headerRow || []).map(headerKey);
  const index = {};
  for (const [field, names] of Object.entries(aliases)) {
    const position = headers.findIndex((header) => names.includes(header));
    if (position >= 0) index[field] = position;
  }
  return index;
}

/**
 * یک شیت را به ردیف‌های نام‌دار تبدیل می‌کند و نبود ستون اجباری را صریح می‌گوید.
 */
export function tableFromSheet(sheet, { aliases, required = [], labels = {}, label = 'فایل' }) {
  const rows = (sheet?.rows || []).filter((row) => (row || []).some((cell) => String(cell ?? '').trim().length));
  if (rows.length < 2) throw importError(`${label} باید سرستون و حداقل یک ردیف داشته باشد.`, 'IMPORT_EMPTY');
  const columnIndex = matchColumns(rows[0], aliases);
  const missing = required.filter((field) => columnIndex[field] == null);
  if (missing.length) {
    // عنوان خواناى ستون گفته می‌شود، نه نام فنی یا آخرین مترادف فهرست.
    const names = missing.map((field) => labels[field] || field).join('، ');
    throw importError(`${label}: این ستون‌ها پیدا نشدند: ${names}.`, 'IMPORT_COLUMN_MISSING');
  }
  return rows.slice(1).map((cells, index) => {
    const record = { rowNumber: index + 2 };
    for (const [field, position] of Object.entries(columnIndex)) record[field] = cells[position] ?? '';
    return record;
  });
}

// ---------------------------------------------------------------------------
// تفصیلی و طرف حساب
// ---------------------------------------------------------------------------

const ANALYTIC_ALIASES = {
  code: ['code', 'کد', 'کدتفصیلی', 'کدطرفحساب', 'کدشناور'],
  name: ['name', 'title', 'نام', 'نامتفصیلی', 'شرح', 'عنوان', 'نامطرفحساب'],
  kind: ['kind', 'type', 'نوع', 'گروه', 'نوعتفصیلی'],
};

const KIND_ALIASES = {
  مشتری: 'contact', تامینکننده: 'contact', 'تأمین‌کننده': 'contact', طرفحساب: 'contact', contact: 'contact',
  پروژه: 'project', project: 'project',
  پرسنل: 'employee', کارمند: 'employee', employee: 'employee',
};

export function importAnalyticRows(database, rows = []) {
  ensureChartSchema(database);
  const errors = [];
  const prepared = [];
  const seen = new Set();

  for (const row of rows) {
    const name = cleanText(row.name);
    const code = normalizeChartCode(row.code);
    if (!name) { errors.push({ rowNumber: row.rowNumber, message: 'نام تفصیلی خالی است.' }); continue; }
    if (code && !chartCodeIsValid(code)) { errors.push({ rowNumber: row.rowNumber, message: `کد «${row.code}» فقط می‌تواند رقم باشد.` }); continue; }
    const key = code || name;
    if (seen.has(key)) { errors.push({ rowNumber: row.rowNumber, message: `«${key}» در فایل تکراری است.` }); continue; }
    seen.add(key);
    const kind = KIND_ALIASES[headerKey(row.kind)] || 'custom';
    prepared.push({ code, name, kind: Object.hasOwn(ANALYTIC_KINDS, kind) ? kind : 'custom' });
  }
  if (errors.length) throw Object.assign(importError('فایل تفصیلی ایراد دارد و هیچ ردیفی وارد نشد.', 'IMPORT_ROWS_INVALID'), { details: { errors } });
  if (!prepared.length) throw importError('هیچ تفصیلی معتبری در فایل نبود.', 'IMPORT_ROWS_EMPTY');

  database.exec('BEGIN IMMEDIATE');
  try {
    let created = 0;
    let updated = 0;
    for (const item of prepared) {
      const existing = item.code ? database.prepare('SELECT id FROM analytic_accounts WHERE code=?').get(item.code) : null;
      saveAnalyticAccount(database, {
        id: existing?.id, code: item.code || undefined, name: item.name, kind: item.kind,
        sourceKind: 'import', sourceKey: item.code || item.name,
      });
      if (existing) updated += 1; else created += 1;
    }
    database.exec('COMMIT');
    return { created, updated, total: prepared.length };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

// ---------------------------------------------------------------------------
// ماندهٔ افتتاحیه
// ---------------------------------------------------------------------------

const OPENING_ALIASES = {
  code: ['code', 'accountcode', 'کد', 'کدحساب', 'کدمعین', 'کدینگ'],
  name: ['name', 'accountname', 'نام', 'نامحساب', 'شرححساب', 'عنوان'],
  debit: ['debit', 'بدهکار', 'ماندهبدهکار', 'گردشبدهکار', 'بدهکارریال', 'بدهکارتومان'],
  credit: ['credit', 'بستانکار', 'ماندهبستانکار', 'گردشبستانکار', 'بستانکارریال', 'بستانکارتومان'],
  analyticCode: ['analytic', 'analyticcode', 'کدتفصیلی', 'تفصیلی', 'شناور'],
};

/**
 * ماندهٔ افتتاحیه را از تراز نرم‌افزار مقصد می‌خواند و **یک** سند افتتاحیهٔ
 * متوازن می‌سازد.
 *
 * - هر ردیف باید به یک «معین» موجود در کدینگ همین دفتر بخورد؛ کد ناشناس
 *   ساکت ساخته نمی‌شود چون معنی حساب را نمی‌دانیم.
 * - جمع بدهکار و بستانکار باید دقیقاً برابر باشد؛ اختلاف با عدد گزارش می‌شود.
 * - واحد فایل (تومان یا ریال) باید صریح اعلام شود؛ حدس‌زدنش یعنی خطای ده‌برابری.
 */
export function prepareOpeningBalanceRows(database, rows = [], { amountUnit = 'toman' } = {}) {
  ensureChartSchema(database);
  const divisor = amountUnit === 'rial' ? 10 : 1;
  const errors = [];
  const prepared = [];
  const seen = new Set();
  let debitTotal = 0;
  let creditTotal = 0;

  for (const row of rows) {
    const code = normalizeChartCode(row.code);
    if (!chartCodeIsValid(code)) { errors.push({ rowNumber: row.rowNumber, message: `کد حساب «${row.code}» معتبر نیست.` }); continue; }
    const chart = database.prepare('SELECT id,code,name,level,type,active FROM chart_accounts WHERE code=?').get(code);
    if (!chart) { errors.push({ rowNumber: row.rowNumber, message: `کد ${code} در کدینگ این دفتر نیست؛ اول کدینگ را وارد کن.` }); continue; }
    if (chart.level !== 'subsidiary') { errors.push({ rowNumber: row.rowNumber, message: `${code} یک ${chart.level === 'group' ? 'گروه' : 'حساب کل'} است و سند نمی‌پذیرد.` }); continue; }
    if (!chart.active) { errors.push({ rowNumber: row.rowNumber, message: `معین ${code} غیرفعال است.` }); continue; }

    const debitRaw = parseCellAmount(row.debit);
    const creditRaw = parseCellAmount(row.credit);
    if (debitRaw == null || creditRaw == null) { errors.push({ rowNumber: row.rowNumber, message: 'مبلغ بدهکار یا بستانکار عدد خوانا نیست.' }); continue; }
    if (debitRaw < 0 || creditRaw < 0) { errors.push({ rowNumber: row.rowNumber, message: 'مبلغ منفی در ماندهٔ افتتاحیه پذیرفته نیست؛ آن را به سمت مقابل ببر.' }); continue; }
    if (debitRaw && creditRaw) { errors.push({ rowNumber: row.rowNumber, message: `حساب ${code} هم بدهکار دارد و هم بستانکار؛ فقط یک سمت مجاز است.` }); continue; }
    if (debitRaw % divisor || creditRaw % divisor) { errors.push({ rowNumber: row.rowNumber, message: `مبلغ ردیف به ${amountUnit === 'rial' ? 'ریال' : 'تومان'} گرد نمی‌شود؛ واحد فایل را کنترل کن.` }); continue; }

    const debit = debitRaw / divisor;
    const credit = creditRaw / divisor;
    if (!debit && !credit) continue; // ردیف با ماندهٔ صفر عمداً حذف می‌شود، نه خطا.

    let analyticId = null;
    const analyticCode = normalizeChartCode(row.analyticCode);
    if (analyticCode) {
      const analytic = database.prepare('SELECT id FROM analytic_accounts WHERE code=? AND active=1').get(analyticCode);
      if (!analytic) { errors.push({ rowNumber: row.rowNumber, message: `تفصیلی ${analyticCode} تعریف نشده است.` }); continue; }
      analyticId = analytic.id;
    }

    const key = `${chart.id}:${analyticId || ''}`;
    if (seen.has(key)) { errors.push({ rowNumber: row.rowNumber, message: `ترکیب حساب ${code} و تفصیلی در فایل تکراری است.` }); continue; }
    seen.add(key);

    debitTotal += debit;
    creditTotal += credit;
    prepared.push({ rowNumber: row.rowNumber, chart, debit, credit, analyticId, name: cleanText(row.name) || chart.name });
  }

  if (errors.length) throw Object.assign(importError('فایل ماندهٔ افتتاحیه ایراد دارد و هیچ ردیفی ثبت نشد.', 'IMPORT_ROWS_INVALID'), { details: { errors } });
  if (!prepared.length) throw importError('هیچ ماندهٔ غیرصفری در فایل نبود.', 'IMPORT_ROWS_EMPTY');
  if (debitTotal !== creditTotal) {
    throw Object.assign(
      importError(`تراز افتتاحیه متوازن نیست؛ اختلاف ${Math.abs(debitTotal - creditTotal).toLocaleString('en-US')} تومان است.`, 'IMPORT_UNBALANCED', 409),
      { details: { debitTotal, creditTotal, difference: debitTotal - creditTotal } },
    );
  }
  return { rows: prepared, debitTotal, creditTotal, amountUnit: amountUnit === 'rial' ? 'rial' : 'toman' };
}

/**
 * برای هر معین کدینگ یک حساب دفتر کل متصل می‌سازد یا برمی‌گرداند.
 * این حساب مستقیماً به کدینگ گره خورده، پس از همان لحظه نگاشتش کامل است.
 */
export function ledgerAccountForChart(database, chart, nextCode) {
  const existing = database.prepare('SELECT id FROM ledger_accounts WHERE chart_account_id=? AND source_kind=?').get(chart.id, 'chart-account');
  if (existing) return existing.id;
  const mapped = database.prepare('SELECT id FROM ledger_accounts WHERE chart_account_id=? AND active=1 ORDER BY rowid LIMIT 1').get(chart.id);
  if (mapped) return mapped.id;
  const id = randomUUID();
  const normalSide = ['asset', 'expense'].includes(chart.type) ? 'debit' : 'credit';
  database.prepare(`INSERT INTO ledger_accounts (id,code,name,type,normal_side,source_kind,source_key,chart_account_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, nextCode(chart.type), chart.name, chart.type, normalSide, 'chart-account', chart.code, chart.id);
  return id;
}
