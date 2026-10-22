// خواندن فایل CSV کدینگ دفتر.
//
// از server/chartOfAccounts.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// chartOfAccounts همه از همان server/chartOfAccounts.js می‌خوانند.

import { chartError, latin } from './base.js';

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
export function readFlag(value) {
  const token = latin(String(value ?? '')).trim().toLowerCase().replace(/[\s‌]+/g, '');
  if (!token) return undefined;
  if (TRUE_WORDS.has(token)) return true;
  if (FALSE_WORDS.has(token)) return false;
  return undefined;
}

// معین‌هایی که در هر کدینگی تفصیلی‌دارند: بدهکاران و بستانکاران بدون طرف حساب
// معنا ندارند. وقتی فایل چیزی نگفته باشد، همین حدس زده می‌شود — حدسی که فقط
// یک هشدار می‌سازد و حسابدار می‌تواند خاموشش کند.
export const ANALYTIC_ROLES = new Set(['partner-payable','partner-receivable','receivable', 'payable']);

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
