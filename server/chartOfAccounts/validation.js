// اعتبارسنجی ردیف‌های کدینگ — منطق خالص، بدون دیتابیس.
//
// از server/chartOfAccounts.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// chartOfAccounts همه از همان server/chartOfAccounts.js می‌خوانند.

import { CHART_LEVELS, CHART_TYPES, CHART_ROLES, latin, normalizeChartCode, chartCodeIsValid, cleanName } from './base.js';
import { readFlag, ANALYTIC_ROLES } from './csvFile.js';

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
