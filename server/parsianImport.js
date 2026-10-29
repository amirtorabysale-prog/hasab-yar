// ورود بکاپ پارسیان به یک دفتر خام حساب‌یار — کدینگ و اسناد.
//
// تصمیم‌های این لایه (قابل مشاهده برای کاربر در پیش‌نمایش، نه پنهان):
//   - واحد مبلغ را پارسیان نگه نمی‌دارد؛ دفتر باید بگوید ریال است یا تومان.
//     بدون آن نه پیش‌نمایش ساخته می‌شود نه ثبت. مبلغی که به تومانِ صحیح
//     تبدیل نشود گرد نمی‌شود؛ سندش با هشدار می‌ماند.
//   - نوع حساب از گروه حساب خود پارسیان (tbl_Kol.GroupCode → tbl_ACCGroup) و
//     پرچم دائمی/موقت (iType) خوانده می‌شود. کلی که این دو برایش یک نوع روشن
//     نمی‌دهند (بی‌گروه، انتظامی، یا گروه و پرچم ناسازگار) «نیازمند انتخاب»
//     است: پیشنهاد کدینگ استاندارد نشان داده می‌شود ولی تا حسابدار نوعش را
//     انتخاب نکند ثبت انجام نمی‌شود.
//   - معین پارسیان زیر هر کل کد مستقل دارد (معین «۱» هم زیر صندوق هست هم زیر
//     بانک). کد یکتای داخلی معین = کد کل + کد معین با لایهٔ چهاررقمی؛ کد اصیل
//     پارسیان در «کد سطح» (level_code) می‌ماند تا رفت‌وبرگشت به پارسیان با کد
//     اصلی حفظ شود.
//   - تفصیلی زیر کل ۱۲ (دریافتنی) و ۲۳ (پرداختنی) با نوع «طرف حساب» و بقیه با
//     نوع «سایر» وارد می‌شود؛ تفصیلی هم‌شماره در چند کل/معین با کلید منبع
//     «کل:معین:کد» از هم جدا می‌مانند.
//   - فقط سند متوازنی که همهٔ ردیف‌هایش عیناً قابل ثبت‌اند وارد می‌شود، به‌صورت
//     پیش‌نویس. سند دیگر با هشدار مشخص در گزارش می‌ماند؛ هیچ ردیفی اصلاح یا
//     بی‌تفصیلی نمی‌شود.
//   - نقش حساب (صندوق، فروش، بهای تمام‌شده، ارزش افزوده و ...) از حساب‌هایی
//     خوانده می‌شود که خود پارسیان در تنظیماتش برای همان کار تعیین کرده؛ با آن،
//     حساب‌های عملیاتی حساب‌یار بی‌دخالت دست به همان معین‌ها نگاشت می‌شوند.
//     حسابی که پارسیان با تفصیلی تعیین کرده نقش نمی‌گیرد، چون نگاشت معین
//     تفصیلی‌اش را نمی‌برد و ردیف در پارسیان روی معین بی‌تفصیلی می‌نشست.
//   - سندهای واردشده در parsian_imported_entries ثبت می‌شوند تا فایل انتقال
//     به پارسیان آن‌ها را دوباره نفرستد (پارسیان تکرار را تشخیص نمی‌دهد).
//   - ورود فقط در دفتر خام مجاز است و همه یا هیچ: اگر هر مرحله شکست بخورد،
//     هرچه ساخته شده برداشته می‌شود و دفتر دوباره خام است.

import { randomUUID } from 'node:crypto';
import { parseParsianBackup } from './parsianBackup.js';
import {
  importChartOfAccounts, listChartAccounts, mapLedgerAccountToChart, saveAnalyticAccount, suggestChartAccount,
} from './chartOfAccounts.js';
import { ledgerAccountForChart } from './ledgerImport.js';
import { assertAccountingPeriodOpen, createJournalBatch, ensureParsianSourceSchema, nextLedgerCode, periodForDate } from './accounting.js';
import { persianToISO } from '../shared/persianDate.js';
import { AMOUNT_UNITS, convertAmount, normalizeAmountUnit, unitLabel } from '../shared/amountUnit.js';
import { importParsianExtras, parsianExtrasSummary } from './parsianExtras.js';
import { importParsianCheques } from './parsianCheques.js';
import { importParsianSideRecords } from './parsianSideRecords.js';
import { importParsianStock } from './parsianStock.js';

const JOURNAL_CHUNK = 200;
const TYPE_LABELS = { asset: 'دارایی', liability: 'بدهی', equity: 'سرمایه', income: 'درآمد', expense: 'هزینه' };
// حساب انتظامی در ترازنامه و سود و زیان نیست. حساب‌یار نوع جدایی برایش ندارد؛ با نوعِ
// طرفش (بدهکار → دارایی، بستانکار → بدهی) و نقش «memorandum» وارد می‌شود تا ماندهٔ
// طبیعی‌اش درست بماند و هیچ نقش عملیاتی‌ای به آن نگاشت نشود.
const MEMORANDUM = 'memorandum';
const CHOICE_LABELS = { ...TYPE_LABELS, [MEMORANDUM]: 'انتظامی' };
const JALALI = /^(\d{4})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/;

/** واحد مبلغ دفتر مقصد؛ دفتر ریالی بکاپ ریالی را بی‌هیچ تبدیلی و دقیق می‌گیرد. */
export function ledgerUnitOf(database) {
  try { return normalizeAmountUnit(database.prepare("SELECT value FROM settings WHERE key='amountUnit'").get()?.value); }
  catch { return 'toman'; }
}

/** کل انتظامی پارسیان: گروه ۹۱ و ۹۲ («حساب‌های انتظامی» و «طرف حساب‌های انتظامی»). */
function isMemorandumKol(kol) {
  const group = Number(kol.group);
  // گروه دورقمی ۹x یا سه‌رقمی ۹xx.
  const family = group >= 100 ? Math.floor(group / 100) : Math.floor(group / 10);
  return family === 9 || /انتظامي|انتظامی|انتضامي|انتضامی/.test(`${kol.groupName || ''} ${kol.name || ''}`);
}

/** طرف حساب انتظامی: «طرف حساب‌های انتظامی» (گروه ۹۲) بستانکار است، بقیه بدهکار. */
function memorandumType(kol) {
  return Number(kol.group) === 92 || /طرف/.test(`${kol.groupName || ''} ${kol.name || ''}`) ? 'liability' : 'asset';
}

// حساب تعیین‌شده در تنظیمات پارسیان ← نقش حساب‌یار، با نوعی که نقش لازم دارد.
const DESIGNATED_ROLES = {
  Cash: { role: 'cash', type: 'asset', label: 'صندوق' },
  Sell: { role: 'sales', type: 'income', label: 'فروش' },
  BahayeTam: { role: 'cogs', type: 'expense', label: 'بهای تمام‌شدهٔ کالای فروش‌رفته' },
  Wage: { role: 'salary-expense', type: 'expense', label: 'هزینهٔ حقوق و دستمزد' },
  Loan: { role: 'loan-payable', type: 'liability', label: 'تسهیلات دریافتی' },
  Asset: { role: 'owner-capital', type: 'equity', label: 'سرمایه' },
  RecDoc: { role: 'note-receivable', type: 'asset', label: 'اسناد دریافتنی' },
  DlDoc: { role: 'note-payable', type: 'liability', label: 'اسناد پرداختنی' },
  MojodyMavad: { role: 'inventory', type: 'asset', label: 'موجودی کالا' },
  VATSale: { role: 'output-tax', type: 'liability', label: 'ارزش افزودهٔ فروش' },
  VATBuy: { role: 'input-tax', type: 'asset', label: 'ارزش افزودهٔ خرید' },
};

function parsianImportError(message, code = 'PARSIAN_IMPORT_INVALID', status = 400, details = undefined) {
  return Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
}

/** واحد مبلغ فایل؛ پیش‌فرض ندارد چون پارسیان آن را نگه نمی‌دارد. */
export function parsianAmountUnit(value) {
  if (!Object.hasOwn(AMOUNT_UNITS, value)) {
    throw parsianImportError('واحد مبلغ‌های پارسیان این دفتر را انتخاب کن: ریال یا تومان. پارسیان واحد را در بکاپ نگه نمی‌دارد.', 'PARSIAN_IMPORT_UNIT_REQUIRED');
  }
  return value;
}

/**
 * پیشنهاد نوع از کد و نام کل — فقط پیشنهاد، هرگز تصمیم.
 *
 * کدینگ دورقمیِ استاندارد (۱۰ تا ۶۶) و سه‌رقمی (۱۰۱ تا ۹۰۲: صدگان ۱ و ۲ دارایی، ۳ و ۴ بدهی،
 * ۵ سرمایه، ۶ درآمد، ۷ و ۸ هزینه، ۹ انتظامی). در بکاپی با کدینگ سه‌رقمی هیچ‌کدام از ۲۲ کل
 * پیشنهادی نداشت و «پذیرش پیشنهادها» کاری نمی‌کرد. وقتی کد و نام با هم نمی‌خوانند،
 * پیشنهادی نیست.
 */
export function kolTypeSuggestion(code, name = '') {
  const byCode = kolAccountType(code);
  const byName = kolTypeFromName(name);
  if (byCode && byName && byCode !== byName) return null;
  return byCode || byName;
}

/**
 * نوع از نام کل. ترتیب مهم است: «پیش‌پرداخت هزینه» دارایی است، «پیش‌دریافت فروش» بدهی،
 * «سرمایه‌گذاری» دارایی، و «بهای تمام‌شدهٔ کالای فروش‌رفته» هزینه نه فروش.
 */
export function kolTypeFromName(name) {
  const text = String(name || '').replace(/ي/g, 'ی').replace(/ك/g, 'ک');
  if (/انتظامی|انتضامی/.test(text)) return MEMORANDUM;
  if (/پیش\s*پرداخت|سرمایه\s*گذاری/.test(text)) return 'asset';
  if (/پیش\s*دریافت/.test(text)) return 'liability';
  // «سایر هزینه‌ها و درآمدها» هر دو است؛ نام چیزی نمی‌گوید.
  if (/هزینه/.test(text) && /درآمد/.test(text)) return null;
  if (/هزینه|بهای\s*تمام|قیمت\s*تمام/.test(text)) return 'expense';
  if (/درآمد|فروش/.test(text)) return 'income';
  if (/سرمایه|صاحبان\s*سهام|اندوخته|سود\s*(?:و\s*زیان\s*)?انباشته/.test(text)) return 'equity';
  if (/پرداختنی|پرداختی|بدهی|تسهیلات|وام\s*دریافتی|ذخیره/.test(text)) return 'liability';
  if (/دارایی|موجودی|نقد|بانک|صندوق|دریافتنی|دریافتی|سفارشات/.test(text)) return 'asset';
  return null;
}

export function kolAccountType(code) {
  if (code >= 100 && code < 1000) {
    const hundred = Math.floor(code / 100);
    return hundred <= 2 ? 'asset' : hundred <= 4 ? 'liability' : hundred === 5 ? 'equity' : hundred === 6 ? 'income'
      : hundred <= 8 ? 'expense' : MEMORANDUM;
  }
  if (code >= 10 && code < 20) return 'asset';
  if (code >= 20 && code < 30) return 'liability';
  if (code >= 30 && code < 40) return 'equity';
  if (code >= 40 && code < 50) return 'income';
  if (code >= 50 && code < 60) return 'expense';
  if (code === 60 || code === 61) return 'income';
  if (code === 62 || code === 63) return 'expense';
  if (code === 66) return 'equity';
  return null;
}

/**
 * نوع کل از داده‌های خود پارسیان. گروه‌های استاندارد پارسیان: ۱x دارایی، ۲x
 * بدهی، ۳x سرمایه، ۴x فروش و درآمد، ۵x بهای تمام‌شده، ۶۱ هزینهٔ فعالیت. گروه
 * ۶۲ (سایر درآمدها و هزینه‌ها) و ۹x (انتظامی) یک نوع روشن ندارند. حساب دائمی
 * (iType=0) باید ترازنامه‌ای و حساب موقت (iType=1) باید سودوزیانی باشد؛
 * ناسازگاری یعنی تصمیم با حسابدار است.
 */
export function parsianKolType(kol) {
  const group = Number(kol.group);
  let type = null;
  if (Number.isInteger(group)) {
    const family = Math.floor(group / 10);
    if (family === 1) type = 'asset';
    else if (family === 2) type = 'liability';
    else if (family === 3) type = 'equity';
    else if (family === 4) type = 'income';
    else if (family === 5 || group === 61) type = 'expense';
  }
  if (!type) return { type: null, reason: kol.group == null ? 'در پارسیان گروه ندارد' : `گروه ${kol.group}${kol.groupName ? ` (${kol.groupName})` : ''} نوع روشنی ندارد` };
  const temporary = ['income', 'expense'].includes(type);
  if (kol.temporary != null && kol.temporary !== temporary) {
    return { type: null, reason: `گروه «${kol.groupName || kol.group}» ${temporary ? 'سودوزیانی' : 'ترازنامه‌ای'} است ولی حساب در پارسیان ${kol.temporary ? 'موقت' : 'دائمی'} تعریف شده` };
  }
  return { type, reason: '' };
}

/** کد یکتای داخلی معین: کد کل + کد معینِ چهاررقمی. برگشت‌پذیر و بدون برخورد. */
export function internalMoeenCode(kol, moeen) {
  return `${Number(kol)}${String(Number(moeen)).padStart(4, '0')}`;
}

function tafsiliSourceKey(row) {
  return `${row.kol}:${row.moeen}:${row.code}`;
}

/**
 * سمت طرف حسابِ یک کل پارسیان: دریافتنی، پرداختنی یا هیچ.
 *
 * کد ۱۲ و ۲۳ قرارداد کدینگ نمونهٔ پارسیان است، نه قاعده: در بکاپ «اتیه سازان» بستانکاران
 * کل ۲۲ («حسابهاي پرداختي») بودند و هیچ تأمین‌کننده‌ای شخص نشد، پس چک‌های پرداختی هم صاحب
 * نداشتند. نام کل همان‌قدر معتبر است.
 */
export function partySideOfKol(code, name) {
  if (Number(code) === 12) return 'receivable';
  if (Number(code) === 23) return 'payable';
  const text = String(name || '').replace(/ي/g, 'ی').replace(/ك/g, 'ک');
  if (/دریافتنی|دریافتی|بدهکاران/.test(text)) return 'receivable';
  if (/پرداختنی|پرداختی|بستانکاران/.test(text)) return 'payable';
  return null;
}

function tafsiliKind(row, kolName) {
  return partySideOfKol(row.kol, kolName) ? 'contact' : 'custom';
}

function ensureImportLog(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS parsian_import_log (
    id TEXT PRIMARY KEY, file_name TEXT, file_sha256 TEXT, status TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    kol_count INTEGER, moeen_count INTEGER, tafsili_count INTEGER,
    voucher_count INTEGER, line_count INTEGER, skipped_voucher_count INTEGER,
    bed_total INTEGER, bes_total INTEGER,
    sanad_min INTEGER, sanad_max INTEGER, date_min TEXT, date_max TEXT,
    created_by TEXT, note TEXT)`);
}

/** وضعیت خام بودن دفتر: هیچ سند، کدینگ، تفصیلی و ورود موفق پارسیان نباشد. */
function rawLedgerStatus(database) {
  const count = (sql) => {
    try { return Number(database.prepare(sql).get()?.count || 0); }
    catch { return 0; }
  };
  const journalCount = count('SELECT COUNT(*) AS count FROM journal_entries');
  const chartCount = count('SELECT COUNT(*) AS count FROM chart_accounts');
  const analyticCount = count('SELECT COUNT(*) AS count FROM analytic_accounts');
  let importedBefore = 0;
  try {
    ensureImportLog(database);
    // ورودی که شکست خورد و برگردانده شد دفتر را از خام بودن بیرون نمی‌برد.
    importedBefore = count("SELECT COUNT(*) AS count FROM parsian_import_log WHERE status='complete'");
  } catch { importedBefore = -1; }
  const ok = journalCount === 0 && chartCount === 0 && analyticCount === 0 && importedBefore === 0;
  const message = ok
    ? 'دفتر خام است و آمادهٔ ورود بکاپ پارسیان.'
    : importedBefore
      ? 'این دفتر قبلاً یک بار بکاپ پارسیان گرفته است؛ ورود دوباره فقط در دفتر خام مجاز است.'
      : chartCount || analyticCount
        ? 'برای این دفتر قبلاً کدینگ یا تفصیلی ثبت شده است؛ ورود بکاپ پارسیان فقط در دفتری ممکن است که هیچ کدینگ و تفصیلی نداشته باشد.'
        : 'این دفتر سند دارد؛ ورود بکاپ پارسیان فقط در دفتر خام (بدون هیچ سند) مجاز است.';
  return { ok, journalCount, chartCount, analyticCount, importedBefore, message };
}

const JALALI_TO_ISO = (date) => {
  const match = JALALI.exec(date || '');
  return match ? persianToISO(Number(match[1]), Number(match[2]), Number(match[3])) : null;
};

/**
 * ساختن طرح ورود از بکاپ رمزگشایی‌شده. هیچ چیزِ این تابع به دیتابیس دست
 * ندارد؛ همان طرح در پیش‌نمایش نشان داده می‌شود و همان در ثبت اجرا می‌شود.
 *
 * amountUnit: واحد مبلغ‌های فایل پارسیان. ledgerUnit: واحد دفتر مقصد. مبلغ فقط
 * دقیق تبدیل می‌شود؛ ریالی که به تومانِ صحیح درنیاید گرد نمی‌شود و سندش می‌ماند.
 * kolTypes: نوعی که حسابدار برای کل‌های «نیازمند انتخاب» برگزیده، با کلید کد کل.
 */
export function buildParsianImportPlan(parsed, { amountUnit, kolTypes = {}, ledgerUnit = 'toman' } = {}) {
  const unit = parsianAmountUnit(amountUnit);
  const targetUnit = normalizeAmountUnit(ledgerUnit);
  const warnings = [...parsed.warnings];
  const kolByCode = new Map();
  const chartRows = [];
  const kolTypeChoices = [];

  // --- کدینگ: کل‌ها ---
  parsed.chart.kol.forEach((row, index) => {
    if (!Number.isInteger(row.code) || row.code < 1) {
      warnings.push(`کل با کد «${row.code}» کد معتبری نیست و وارد نشد.`);
      return;
    }
    const resolved = parsianKolType(row);
    const chosen = Object.hasOwn(CHOICE_LABELS, kolTypes[row.code]) ? kolTypes[row.code] : null;
    const memorandum = chosen === MEMORANDUM;
    const type = resolved.type || (memorandum ? memorandumType(row) : chosen);
    if (!resolved.type) {
      // کل انتظامی با هیچ‌کدام از پنج نوع جور نیست؛ پیشنهادش «انتظامی» است، نه یک نوع ترازنامه‌ای.
      const suggestion = isMemorandumKol(row) ? MEMORANDUM : kolTypeSuggestion(row.code, row.name);
      kolTypeChoices.push({ code: row.code, name: row.name, reason: resolved.reason, suggestion, chosen, memorandumSide: isMemorandumKol(row) ? memorandumType(row) : null });
    }
    kolByCode.set(row.code, { name: row.name, type, memorandum });
    chartRows.push({
      rowNumber: index + 1, code: String(row.code), name: row.name, level: 'general',
      type, typeSource: resolved.type ? 'parsian' : chosen ? 'accountant' : 'pending',
      parentCode: '', levelCode: String(row.code), ...(memorandum ? { role: MEMORANDUM } : {}),
    });
  });

  // --- کدینگ: معین‌ها (کد یکتا = کل + معینِ چهاررقمی؛ کد سطح = کد اصیل پارسیان) ---
  const moeenIndex = new Map(); // "kol:moeen" -> composite code
  parsed.chart.moeen.forEach((row, index) => {
    const key = `${row.kol}:${row.code}`;
    const parent = kolByCode.get(row.kol);
    if (!parent) {
      warnings.push(`معین «${row.code} ${row.name}» زیر کل ${row.kol} است که در فایل تعریف نشده؛ وارد نشد.`);
      return;
    }
    if (!(Number.isInteger(row.code) && row.code >= 1 && row.code < 10000)) {
      warnings.push(`کد معین «${row.kol}/${row.code} ${row.name}» بیرون از محدودهٔ ۱ تا ۹۹۹۹ است؛ وارد نشد.`);
      return;
    }
    if (moeenIndex.has(key)) {
      warnings.push(`معین «${row.kol}/${row.code} ${row.name}» در فایل تکراری است؛ وارد نشد.`);
      return;
    }
    const composite = internalMoeenCode(row.kol, row.code);
    moeenIndex.set(key, composite);
    chartRows.push({
      rowNumber: parsed.chart.kol.length + index + 1, code: composite, name: row.name,
      level: 'subsidiary', type: parent.type, parentCode: String(row.kol), levelCode: String(row.code),
      ...(parent.memorandum ? { role: MEMORANDUM } : {}),
    });
  });

  // --- نقش معین‌ها از حساب‌های تعیین‌شدهٔ پارسیان ---
  const designatedRoles = [];
  const usedRoles = new Set();
  for (const item of parsed.chart.designated || []) {
    const spec = DESIGNATED_ROLES[item.key];
    if (!spec) continue;
    const row = chartRows.find((candidate) => candidate.code === moeenIndex.get(`${item.kol}:${item.moeen}`));
    let reason = '';
    if (!item.moeen) reason = `پارسیان فقط کل ${item.kol} را تعیین کرده، نه یک معین`;
    else if (item.taf) reason = `پارسیان آن را با تفصیلی ${item.taf} تعیین کرده؛ نگاشت معین تفصیلی را نمی‌برد`;
    else if (!row) reason = `معین ${item.kol}/${item.moeen} در کدینگ فایل نیست`;
    else if (!row.type) reason = `نوع کل ${item.kol} هنوز انتخاب نشده`;
    else if (row.type !== spec.type) reason = `نوع معین (${TYPE_LABELS[row.type]}) با نقش ${spec.label} (${TYPE_LABELS[spec.type]}) نمی‌خواند`;
    else if (usedRoles.has(spec.role)) reason = 'این نقش قبلاً به معین دیگری داده شده';
    if (!reason) { row.role = spec.role; usedRoles.add(spec.role); }
    designatedRoles.push({ key: item.key, label: spec.label, kol: item.kol, moeen: item.moeen, taf: item.taf, name: row?.name || '', applied: !reason, reason });
  }

  // --- تفصیلی‌ها ---
  const analyticSpecs = [];
  const analyticKeys = new Map();
  const kolNames = new Map(parsed.chart.kol.map((kol) => [kol.code, kol.name]));
  for (const row of parsed.chart.tafsili) {
    const key = tafsiliSourceKey(row);
    if (analyticKeys.has(key)) continue;
    const spec = {
      name: row.name, kind: tafsiliKind(row, kolNames.get(row.kol)), sourceKey: key,
      externalCode: row.code > 0 ? String(row.code) : '', kol: row.kol, moeen: row.moeen, code: row.code,
    };
    analyticSpecs.push(spec);
    analyticKeys.set(key, spec);
  }

  // --- اسناد ---
  const vouchers = [];
  let skippedZeroRows = 0;
  for (const voucher of parsed.documents.vouchers) {
    const issues = [];
    if (!voucher.balanced) {
      issues.push(`سند در خود پارسیان متوازن نیست: بدهکار ${voucher.bedTotal.toLocaleString('en-US')} ≠ بستانکار ${voucher.besTotal.toLocaleString('en-US')}`);
    }
    if (voucher.dates.length > 1) issues.push(`ردیف‌های سند چند تاریخ دارند: ${voucher.dates.join('، ')}`);
    const dateISO = voucher.dates.length === 1 ? JALALI_TO_ISO(voucher.date) : null;
    if (voucher.dates.length === 1 && !dateISO) issues.push(`تاریخ «${voucher.date || '—'}» تاریخ شمسی معتبر نیست.`);

    const lines = [];
    const lineIssues = [];
    let unitIssues = 0;
    voucher.lines.forEach((line, index) => {
      if (!line.bed && !line.bes) { skippedZeroRows += 1; return; }
      const label = `ردیف ${index + 1}${line.comment ? ` «${line.comment.slice(0, 60)}»` : ''}`;
      if (line.bed < 0 || line.bes < 0) { lineIssues.push(`${label}: مبلغ منفی پذیرفته نیست.`); return; }
      if (line.bed > 0 && line.bes > 0) { lineIssues.push(`${label}: هم بدهکار دارد هم بستانکار.`); return; }
      const amount = line.bed || line.bes;
      if (!Number.isInteger(amount)) { lineIssues.push(`${label}: مبلغ ${amount.toLocaleString('en-US')} عدد صحیح نیست.`); return; }
      const debit = convertAmount(line.bed, unit, targetUnit);
      const credit = convertAmount(line.bes, unit, targetUnit);
      if (debit == null || credit == null) {
        // سند متوازن است؛ فقط مبلغ ریالی در دفتر تومانی جا نمی‌شود. راهش ریالی کردن
        // دفتر است، نه عوض کردن واحد فایل (که همهٔ مبلغ‌ها را ده برابر می‌کند).
        unitIssues += 1;
        lineIssues.push(`${label}: ${amount.toLocaleString('fa-IR')} ${unitLabel(unit)} در دفتر ${unitLabel(targetUnit)}ی به عدد صحیح درنمی‌آید.`);
        return;
      }
      const composite = moeenIndex.get(`${line.kol}:${line.moeen}`);
      if (!composite) { lineIssues.push(`${label}: حساب (کل ${line.kol}، معین ${line.moeen}) در کدینگ فایل نیست.`); return; }
      const analytic = line.taf > 0 ? analyticKeys.get(`${line.kol}:${line.moeen}:${line.taf}`) : null;
      if (line.taf > 0 && !analytic) { lineIssues.push(`${label}: تفصیلی ${line.taf} زیر ${line.kol}/${line.moeen} در فایل تعریف نشده.`); return; }
      lines.push({
        kol: line.kol, moeen: line.moeen, taf: line.taf,
        bed: line.bed, bes: line.bes, debit, credit,
        comment: line.comment || '', composite, analyticKey: analytic ? analytic.sourceKey : null,
      });
    });
    if (lines.length < 2 && !lineIssues.length) issues.push(`سند فقط ${lines.length} آرتیکل دارد؛ سند باید دست‌کم دو آرتیکل داشته باشد.`);

    const firstComment = voucher.lines.find((line) => (line.comment || '').trim())?.comment || '';
    vouchers.push({
      sanad: voucher.sanad, date: voucher.date, dateISO, balanced: voucher.balanced,
      bedTotal: voucher.bedTotal, besTotal: voucher.besTotal,
      debitTotal: lines.reduce((sum, line) => sum + line.debit, 0),
      lineCount: voucher.lines.length, validLineCount: lines.length, lines, lineIssues, issues,
      memo: `[بکاپ پارسیان] سند ${voucher.sanad} — ${voucher.date}${firstComment ? ` — ${firstComment.slice(0, 120)}` : ''}`,
      importable: Boolean(voucher.balanced && dateISO && lines.length >= 2 && !lineIssues.length && !issues.length),
      // چرا وارد نمی‌شود: نامتوازن در خود پارسیان، فقط واحد، یا ایراد دیگر.
      blockReason: !voucher.balanced ? 'unbalanced'
        : unitIssues && unitIssues === lineIssues.length && !issues.length ? 'unit'
          : (lineIssues.length || issues.length || lines.length < 2 || !dateISO) ? 'invalid' : null,
    });
  }

  if (skippedZeroRows) {
    warnings.push(`${skippedZeroRows.toLocaleString('fa-IR')} ردیف با مبلغ صفر عمداً وارد نشد (سطرهای تهی سندها).`);
  }

  const importable = vouchers.filter((voucher) => voucher.importable);
  const dates = importable.map((voucher) => voucher.date).sort();
  const pendingKolTypes = kolTypeChoices.filter((choice) => !choice.chosen);
  return {
    amountUnit: unit, ledgerUnit: targetUnit, chartRows, analyticSpecs, vouchers, warnings, kolTypeChoices, pendingKolTypes, designatedRoles,
    summary: {
      amountUnit: unit,
      ledgerUnit: targetUnit,
      kolCount: parsed.chart.kol.length,
      moeenCount: parsed.chart.moeen.length,
      tafsiliCount: parsed.chart.tafsili.length,
      chartRowsCount: chartRows.length,
      voucherCount: vouchers.length,
      importableCount: importable.length,
      unbalancedCount: vouchers.filter((voucher) => voucher.blockReason === 'unbalanced').length,
      unitBlockedCount: vouchers.filter((voucher) => voucher.blockReason === 'unit').length,
      invalidCount: vouchers.filter((voucher) => voucher.blockReason === 'invalid').length,
      pendingKolTypeCount: pendingKolTypes.length,
      fileRowCount: parsed.documents.rows.length,
      lineCount: importable.reduce((sum, voucher) => sum + voucher.lines.length, 0),
      // جمع‌ها به واحد خود فایل؛ جمع ثبت‌شدنی به واحد دفتر جداست.
      bedTotal: importable.reduce((sum, voucher) => sum + voucher.bedTotal, 0),
      besTotal: importable.reduce((sum, voucher) => sum + voucher.besTotal, 0),
      ledgerTotal: importable.reduce((sum, voucher) => sum + voucher.debitTotal, 0),
      sanadMin: vouchers.length ? Math.min(...vouchers.map((voucher) => voucher.sanad)) : null,
      sanadMax: vouchers.length ? Math.max(...vouchers.map((voucher) => voucher.sanad)) : null,
      dateMin: dates[0] || null,
      dateMax: dates[dates.length - 1] || null,
    },
  };
}

function voucherPreview(voucher) {
  return {
    sanad: voucher.sanad, date: voucher.date, dateISO: voucher.dateISO,
    balanced: voucher.balanced, importable: voucher.importable, blockReason: voucher.blockReason,
    bedTotal: voucher.bedTotal, besTotal: voucher.besTotal,
    lineCount: voucher.lineCount, validLineCount: voucher.validLineCount,
    issues: voucher.issues, lineIssues: voucher.lineIssues, memo: voucher.memo,
  };
}

function parseKolTypes(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)) || {}; }
  catch { throw parsianImportError('انتخاب نوع حساب‌ها خوانا نیست.'); }
}

/** پیش‌نمایش کامل: بدون هیچ نوشتنی در دفتر. */
export function previewParsianBackup(database, buffer, fileName, { amountUnit, kolTypes } = {}) {
  const unit = parsianAmountUnit(amountUnit);
  const ledgerUnit = ledgerUnitOf(database);
  const parsed = parseParsianBackup(buffer, { fileName });
  const plan = buildParsianImportPlan(parsed, { amountUnit: unit, kolTypes: parseKolTypes(kolTypes), ledgerUnit });
  const raw = rawLedgerStatus(database);
  const typeLabel = (row) => (row.role === MEMORANDUM ? `انتظامی (${row.type === 'asset' ? 'بدهکار' : 'بستانکار'})` : TYPE_LABELS[row.type] || 'نیازمند انتخاب');
  return {
    meta: parsed.meta,
    rawLedger: raw,
    summary: plan.summary,
    ledgerUnit,
    // فایل ریالی در دفتر تومانی: ریالی که به تومانِ صحیح درنیاید سندش را نگه می‌دارد.
    // راه درست ریالی کردن دفتر است؛ رابط آن را پیشنهاد می‌دهد.
    unitAdvice: unit !== ledgerUnit ? {
      fileUnit: unit, ledgerUnit, fileUnitLabel: unitLabel(unit), ledgerUnitLabel: unitLabel(ledgerUnit),
      blockedVouchers: plan.summary.unitBlockedCount,
    } : null,
    warnings: plan.warnings,
    // کالا، کارت طرف حساب، فاکتورها و مشخصات شرکت که همراه اسناد وارد می‌شوند.
    extras: parsianExtrasSummary(parsed),
    designatedRoles: plan.designatedRoles,
    kolTypeChoices: plan.kolTypeChoices.map((choice) => ({
      ...choice,
      suggestionLabel: choice.suggestion === MEMORANDUM
        ? `انتظامی (${choice.memorandumSide === 'liability' ? 'بستانکار' : 'بدهکار'})`
        : choice.suggestion ? TYPE_LABELS[choice.suggestion] : '',
    })),
    chart: {
      kol: plan.chartRows.filter((row) => row.level === 'general').map((row) => ({
        code: row.code, name: row.name, type: row.type, typeSource: row.typeSource,
        typeLabel: typeLabel(row),
      })),
      moeen: plan.chartRows.filter((row) => row.level === 'subsidiary').map((row) => ({
        code: row.code, kolCode: row.parentCode, moeenCode: row.levelCode,
        name: row.name, typeLabel: typeLabel(row),
      })),
      tafsili: plan.analyticSpecs.map((spec) => ({
        kol: spec.kol, moeen: spec.moeen, code: spec.code, name: spec.name,
        kindLabel: spec.kind === 'contact' ? 'طرف حساب' : 'سایر',
      })),
    },
    vouchers: plan.vouchers.map(voucherPreview),
  };
}

/** برداشتن هرچه این ورود ساخته — دفتر پیش از ورود خام بوده، پس همه‌اش مال همین ورود است. */
function undoImport(database, entryIds) {
  ensureParsianSourceSchema(database);
  database.exec('BEGIN IMMEDIATE');
  try {
    const remove = (sql, ...values) => database.prepare(sql).run(...values);
    for (const id of entryIds) {
      remove('DELETE FROM parsian_imported_entries WHERE entry_id=?', id);
      remove('DELETE FROM journal_lines WHERE entry_id=?', id);
      remove('DELETE FROM journal_entries WHERE id=?', id);
    }
    // نگاشت حساب‌های عملیاتی به کدینگِ همین ورود هم برداشته می‌شود.
    remove("UPDATE ledger_accounts SET chart_account_id=NULL WHERE chart_account_id IS NOT NULL AND (source_kind IS NULL OR source_kind<>'chart-account')");
    remove("DELETE FROM ledger_accounts WHERE source_kind='chart-account' AND chart_account_id IS NOT NULL");
    remove("DELETE FROM analytic_accounts WHERE source_kind='parsian-tafsili'");
    for (const level of ['subsidiary', 'general', 'group']) remove('DELETE FROM chart_accounts WHERE level=?', level);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

/** ثبت طرح در دفتر خام. همان دادهٔ پیش‌نمایش، همان نگاشت، دوباره سنجیده می‌شود. */
export function commitParsianBackup(database, buffer, fileName, { createdBy = null, timeZone = 'Asia/Tehran', amountUnit, kolTypes } = {}) {
  const unit = parsianAmountUnit(amountUnit);
  const raw = rawLedgerStatus(database);
  if (!raw.ok) {
    throw parsianImportError(raw.message, 'PARSIAN_IMPORT_LEDGER_NOT_RAW', 409, {
      journalCount: raw.journalCount, chartCount: raw.chartCount, analyticCount: raw.analyticCount,
    });
  }
  const parsed = parseParsianBackup(buffer, { fileName });
  const ledgerUnit = ledgerUnitOf(database);
  const plan = buildParsianImportPlan(parsed, { amountUnit: unit, kolTypes: parseKolTypes(kolTypes), ledgerUnit });
  if (plan.pendingKolTypes.length) {
    throw parsianImportError(
      `نوع ${plan.pendingKolTypes.length} حساب کل از پارسیان روشن نیست؛ پیش از ورود نوعشان را انتخاب کن: ${plan.pendingKolTypes.map((choice) => `${choice.code} ${choice.name}`).join('، ')}`,
      'PARSIAN_IMPORT_TYPES_REQUIRED', 400, { pendingKolTypes: plan.pendingKolTypes },
    );
  }
  const importable = plan.vouchers.filter((voucher) => voucher.importable);
  if (!plan.chartRows.length) throw parsianImportError('هیچ ردیف کدینگ قابل ورودی در این بکاپ نیست.', 'PARSIAN_IMPORT_EMPTY');
  if (!importable.length && plan.summary.voucherCount > 0) {
    throw parsianImportError('هیچ سند قابل ورودی پیدا نشد؛ فهرست هشدارهای پیش‌نمایش را ببین.', 'PARSIAN_IMPORT_NO_VALID_VOUCHERS', 422);
  }
  // دورهٔ بسته پیش از هر نوشتنی سنجیده می‌شود تا ورود در میانه نشکند.
  for (const voucher of importable) {
    try { assertAccountingPeriodOpen(database, periodForDate(voucher.dateISO, timeZone)); }
    catch (error) { throw parsianImportError(`سند ${voucher.sanad} پارسیان (${voucher.date}) در دوره‌ای است که بسته شده؛ هیچ چیزی وارد نشد.`, error.code || 'ACCOUNTING_PERIOD_LOCKED', 409); }
  }

  const logImport = (status, note, voucherCount) => {
    try {
      ensureImportLog(database);
      database.prepare(`INSERT INTO parsian_import_log (id,file_name,file_sha256,status,kol_count,moeen_count,tafsili_count,
          voucher_count,line_count,skipped_voucher_count,bed_total,bes_total,sanad_min,sanad_max,date_min,date_max,created_by,note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), parsed.meta.fileName, parsed.meta.sha256, status,
        plan.summary.kolCount, plan.summary.moeenCount, plan.summary.tafsiliCount,
        voucherCount, plan.summary.lineCount, plan.summary.voucherCount - importable.length,
        plan.summary.ledgerTotal, plan.summary.ledgerTotal,
        plan.summary.sanadMin, plan.summary.sanadMax, plan.summary.dateMin, plan.summary.dateMax,
        createdBy, String(note || '').slice(0, 400),
      );
    } catch { /* ثبت گزارش هرگز خودِ ورود را نشکند. */ }
  };

  const created = { entries: 0, documentNumbers: [], total: 0, entryIds: [] };
  let mappedOperational = 0;
  let chartResult;
  const analyticIdByKey = new Map();
  const ledgerIdByComposite = new Map();
  try {
    // ۱) کدینگ با نوعی که از پارسیان یا انتخاب حسابدار آمده.
    chartResult = importChartOfAccounts(database, plan.chartRows, { source: 'import', codingStyle: 'segmented' });

    // ۲) تفصیلی‌ها و حساب‌های دفتر کلِ متصل به معین‌ها.
    for (const spec of plan.analyticSpecs) {
      const saved = saveAnalyticAccount(database, {
        name: spec.name, kind: spec.kind, sourceKind: 'parsian-tafsili', sourceKey: spec.sourceKey,
        ...(spec.externalCode ? { externalCode: spec.externalCode } : {}),
      });
      analyticIdByKey.set(spec.sourceKey, saved.id);
    }
    const chartAccounts = listChartAccounts(database);
    for (const chart of chartAccounts.filter((item) => item.active && item.postable)) {
      ledgerIdByComposite.set(chart.code, ledgerAccountForChart(database, chart, (type) => nextLedgerCode(database, type)));
    }
    // حساب‌های عملیاتیِ از پیش موجود (صندوق، فروش و ...) با نقش‌های پارسیان،
    // فقط با نگاشت مطمئن؛ بقیه برای حسابدار در فهرست «بدون نگاشت» می‌مانند.
    for (const ledger of database.prepare(`SELECT id,code,name,type,source_kind AS sourceKind,source_key AS sourceKey
      FROM ledger_accounts WHERE chart_account_id IS NULL AND active=1`).all()) {
      const suggestion = suggestChartAccount(ledger, chartAccounts, { confidentOnly: true });
      if (suggestion) { mapLedgerAccountToChart(database, ledger.id, suggestion.id); mappedOperational += 1; }
    }

    // ۳) اسناد — دسته‌دسته، به‌صورت پیش‌نویس برای تأیید حسابدار.
    const documents = importable.map((voucher) => ({
      occurredAt: voucher.dateISO,
      memo: voucher.memo,
      lines: voucher.lines.map((line) => ({
        accountId: ledgerIdByComposite.get(line.composite),
        debit: line.debit, credit: line.credit,
        description: line.comment.slice(0, 300),
        analyticId: line.analyticKey ? analyticIdByKey.get(line.analyticKey) || null : null,
      })),
    }));
    ensureParsianSourceSchema(database);
    const markSource = database.prepare('INSERT INTO parsian_imported_entries (entry_id,sanad,file_sha256) VALUES (?,?,?)');
    for (let offset = 0; offset < documents.length; offset += JOURNAL_CHUNK) {
      const result = createJournalBatch(database, documents.slice(offset, offset + JOURNAL_CHUNK), { createdBy, timeZone });
      created.entries += result.created;
      created.documentNumbers.push(...result.documentNumbers);
      created.total += result.total;
      created.entryIds.push(...result.entryIds);
      // ترتیب شناسه‌ها همان ترتیب سندهای فرستاده‌شده است.
      result.entryIds.forEach((entryId, index) => markSource.run(entryId, importable[offset + index].sanad, parsed.meta.sha256));
    }
  } catch (error) {
    let undone = true;
    try { undoImport(database, created.entryIds); } catch { undone = false; }
    logImport(undone ? 'rolled-back' : 'partial', `ورود شکست خورد${undone ? ' و برگردانده شد' : ' و برگرداندن هم ممکن نشد'}: ${error.message}`, created.entries);
    const detailErrors = error.details?.errors;
    throw parsianImportError(
      undone
        ? `ورود انجام نشد و هیچ چیزی در دفتر نماند: ${error.message}`
        : `ورود در میانه متوقف شد و برگرداندن کامل ممکن نشد: ${error.message} — وضعیت در گزارش ورود پارسیان ثبت شد.`,
      undone ? 'PARSIAN_IMPORT_FAILED' : 'PARSIAN_IMPORT_PARTIAL', 500,
      detailErrors ? { errors: detailErrors } : undefined,
    );
  }

  logImport('complete', `ورود کامل: ${created.entries} سند پیش‌نویس، واحد فایل ${unitLabel(unit)}، واحد دفتر ${unitLabel(ledgerUnit)}.`, created.entries);
  // اطلاعات پایه (کالا، کارت طرف حساب، بایگانی فاکتورها، مشخصات شرکت) پس از اسناد.
  // خطایش اسناد واردشده را برنمی‌گرداند؛ فقط گفته می‌شود چه نیامد.
  let extras;
  try {
    extras = importParsianExtras(database, parsed, { fileUnit: unit, ledgerUnit, analyticIdByKey, designated: parsed.chart.designated, createdBy });
  } catch (error) {
    extras = { error: `اسناد و کدینگ وارد شدند، ولی کالا و فاکتورها و کارت‌های طرف حساب نیامدند: ${error.message}` };
  }
  // چک‌ها پس از اسناد، چون به سند ثبت و تسویهٔ خودشان وصل می‌شوند؛ هیچ سند تازه‌ای نمی‌سازند.
  let cheques;
  try {
    cheques = importParsianCheques(database, parsed, { fileUnit: unit, ledgerUnit, analyticIdByKey, timeZone });
  } catch (error) {
    cheques = { error: `اسناد وارد شدند، ولی چک‌ها نیامدند: ${error.message}` };
  }
  // سابقهٔ مؤدیان و چک‌های ضمانت؛ بی‌سند و بی‌اثر روی مانده.
  let side;
  try {
    side = importParsianSideRecords(database, parsed, { fileUnit: unit, ledgerUnit, analyticIdByKey });
  } catch (error) {
    side = { error: `اسناد وارد شدند، ولی سابقهٔ مؤدیان و چک‌های ضمانت نیامدند: ${error.message}` };
  }
  // موجودی کالا از گردش فاکتورها، پس از ساخت کالاها؛ بی‌سند.
  let stock;
  try {
    stock = extras?.error ? { error: 'کالاها نیامدند؛ موجودی هم ساخته نشد.' } : importParsianStock(database, parsed, { fileUnit: unit, ledgerUnit });
  } catch (error) {
    stock = { error: `اسناد و کالاها وارد شدند، ولی موجودی کالا ساخته نشد: ${error.message}` };
  }
  const skipped = plan.vouchers.filter((voucher) => !voucher.importable).map(voucherPreview);
  return {
    chart: chartResult,
    analytics: analyticIdByKey.size,
    ledgerAccounts: ledgerIdByComposite.size,
    mappedOperational,
    designatedRoles: plan.designatedRoles,
    journals: { entries: created.entries, documentNumbers: created.documentNumbers, total: created.total, unit: ledgerUnit },
    amountUnit: unit,
    ledgerUnit,
    skippedVouchers: skipped,
    summary: plan.summary,
    extras,
    cheques,
    side,
    stock,
  };
}
