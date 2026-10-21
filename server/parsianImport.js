// ورود بکاپ پارسیان به یک دفتر خام حساب‌یار — فاز الف: کدینگ و اسناد.
//
// تصمیم‌های این لایه (قابل مشاهده برای کاربر در پیش‌نمایش، نه پنهان):
//   - کل پارسیان → سطح «کل» کدینگ با همان کد؛ نوع حساب از بازهٔ استاندارد
//     کدینگ ایرانی (۱۰تا۱۸ دارایی، ۲۰ها بدهی، ۳۰ها سرمایه، ۴۰ها درآمد،
//     ۵۰ها هزینه و ۶۰/۶۱ فروش، ۶۲/۶۳ خرید، ۶۶ تراز افتتاحیه) گرفته می‌شود.
//   - معین پارسیان زیر هر کل کد مستقل دارد (معین «۱» هم زیر صندوق هست هم زیر
//     بانک). کد یکتای داخلی معین = کد کل + کد معین با لایهٔ چهاررقمی؛ کد اصیل
//     پارسیان در «کد سطح» (level_code) می‌ماند — همان قراردادی که فایل انتقال
//     به پارسیان (db/accountingTransfer.js) از کدینگ می‌خواند، پس رفت‌وبرگشت
//     به پارسیان با کد اصلی حفظ می‌شود.
//   - تفصیلی زیر کل ۱۲ (دریافتنی) و ۲۳ (پرداختنی) با نوع «طرف حساب» و بقیه با
//     نوع «سایر» وارد می‌شود؛ تفصیلی تکراری در چند کل/معین با کلید منبع
//     «کل:معین:کد» از هم جدا می‌مانند.
//   - فقط اسناد متوازن و با حساب‌های قابل‌حل ثبت می‌شوند و همه به‌صورت
//     پیش‌نویس می‌آیند تا حسابدار تأیید کند. اسناد نامتوازن یا با حساب
//     ناشناس «نمایش داده می‌شوند با هشدار مشخص» و وارد نمی‌شوند — هیچ مبلغی
//     حدس زده نمی‌شود و هیچ ردیفی اصلاح نمی‌شود.
//   - ورود فقط در دفتر خام مجاز است: بدون هیچ سند، کدینگ، تفصیلی و سابقهٔ
//     ورود پارسیان.

import { randomUUID } from 'node:crypto';
import { parseParsianBackup } from './parsianBackup.js';
import {
  importChartOfAccounts, listChartAccounts, saveAnalyticAccount,
} from './chartOfAccounts.js';
import { ledgerAccountForChart } from './ledgerImport.js';
import { createJournalBatch, nextLedgerCode } from './accounting.js';
import { persianToISO } from '../shared/persianDate.js';

const JOURNAL_CHUNK = 200;
const TYPE_LABELS = { asset: 'دارایی', liability: 'بدهی', equity: 'سرمایه', income: 'درآمد', expense: 'هزینه' };

function parsianImportError(message, code = 'PARSIAN_IMPORT_INVALID', status = 400, details = undefined) {
  return Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
}

/** نوع حسابداری کل از بازهٔ کد — ناشناس یعنی خارج از قرارداد رایج پارسیان. */
export function kolAccountType(code) {
  if (code >= 10 && code < 20) return 'asset';
  if (code >= 20 && code < 30) return 'liability';
  if (code >= 30 && code < 40) return 'equity';
  if (code >= 40 && code < 50) return 'income';
  if (code >= 50 && code < 60) return 'expense';
  if (code === 60 || code === 61) return 'income';
  if (code === 62 || code === 63) return 'expense';
  if (code === 66) return 'equity';
  // ۶۴ و ۶۵ حساب‌های انتظامی‌اند؛ نزدیک‌ترین سبد موجود «هزینه» است و در
  // پیش‌نمایش صریح اعلام می‌شود تا حسابدار در کدینگ قابل ویرایش باشد.
  if (code === 64 || code === 65) return 'expense';
  return null;
}

/** کد یکتای داخلی معین: کد کل + کد معینِ چهاررقمی. برگشت‌پذیر و بدون برخورد. */
export function internalMoeenCode(kol, moeen) {
  return `${Number(kol)}${String(Number(moeen)).padStart(4, '0')}`;
}

function tafsiliSourceKey(row) {
  return `${row.kol}:${row.moeen}:${row.code}`;
}

function tafsiliKind(row) {
  return row.kol === 12 || row.kol === 23 ? 'contact' : 'custom';
}

/** وضعیت خام بودن دفتر: هیچ سند، کدینگ، تفصیلی و سابقهٔ ورود پارسیان نباشد. */
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
    database.exec(`CREATE TABLE IF NOT EXISTS parsian_import_log (
      id TEXT PRIMARY KEY, file_name TEXT, file_sha256 TEXT, status TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      kol_count INTEGER, moeen_count INTEGER, tafsili_count INTEGER,
      voucher_count INTEGER, line_count INTEGER, skipped_voucher_count INTEGER,
      bed_total INTEGER, bes_total INTEGER,
      sanad_min INTEGER, sanad_max INTEGER, date_min TEXT, date_max TEXT,
      created_by TEXT, note TEXT)`);
    importedBefore = count('SELECT COUNT(*) AS count FROM parsian_import_log');
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

/**
 * ساختن طرح ورود از بکاپ رمزگشایی‌شده. هیچ چیزِ این تابع به دیتابیس دست
 * ندارد؛ همان طرح در پیش‌نمایش نشان داده می‌شود و همان در ثبت اجرا می‌شود.
 */
export function buildParsianImportPlan(parsed) {
  const warnings = [...parsed.warnings];
  const kolByNameCode = new Map();
  const chartRows = [];

  // --- کدینگ: کل‌ها ---
  parsed.chart.kol.forEach((row, index) => {
    const type = kolAccountType(row.code);
    if (!Number.isInteger(row.code) || row.code < 1 || row.code > 999999999) {
      warnings.push(`کل با کد «${row.code}» کد معتبری نیست و وارد نشد.`);
      return;
    }
    if (!type) {
      warnings.push(`کل «${row.code} ${row.name}» خارج از بازه‌های استاندارد کدینگ است و نوع آن معلوم نبود؛ وارد نشد تا دستی تعریف شود.`);
      return;
    }
    kolByNameCode.set(row.code, { name: row.name, type });
    chartRows.push({
      rowNumber: index + 1, code: String(row.code), name: row.name, level: 'general',
      type, parentCode: '', levelCode: String(row.code),
    });
  });

  // --- کدینگ: معین‌ها (کد یکتا = کل + معینِ چهاررقمی؛ کد سطح = کد اصیل پارسیان) ---
  const moeenIndex = new Map(); // "kol:moeen" -> composite code
  const excludedMoeen = new Set();
  parsed.chart.moeen.forEach((row, index) => {
    const key = `${row.kol}:${row.code}`;
    const parent = kolByNameCode.get(row.kol);
    if (!parent) {
      excludedMoeen.add(key);
      warnings.push(`معین «${row.code} ${row.name}» زیر کل ${row.kol} است که در فایل تعریف نشده؛ وارد نشد.`);
      return;
    }
    if (!(Number.isInteger(row.code) && row.code >= 1 && row.code < 10000)) {
      excludedMoeen.add(key);
      warnings.push(`کد معین «${row.code} ${row.name}» بزرگ‌تر از محدودهٔ پشتیبانی‌شده است؛ وارد نشد.`);
      return;
    }
    const composite = internalMoeenCode(row.kol, row.code);
    if (moeenIndex.has(key) || chartRows.some((item) => item.code === composite)) {
      excludedMoeen.add(key);
      warnings.push(`معین «${row.kol}/${row.code} ${row.name}» کد داخلی تکراری می‌سازد؛ وارد نشد.`);
      return;
    }
    moeenIndex.set(key, composite);
    chartRows.push({
      rowNumber: parsed.chart.kol.length + index + 1, code: composite, name: row.name,
      level: 'subsidiary', type: parent.type, parentCode: String(row.kol), levelCode: String(row.code),
    });
  });

  // --- تفصیلی‌ها ---
  const analyticSpecs = [];
  const analyticKeys = new Map();
  const seenAnalyticKey = new Set();
  for (const row of parsed.chart.tafsili) {
    const key = tafsiliSourceKey(row);
    if (seenAnalyticKey.has(key)) continue;
    seenAnalyticKey.add(key);
    const spec = {
      name: row.name, kind: tafsiliKind(row), sourceKey: key,
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
      issues.push(`سند متوازن نیست: بدهکار ${voucher.bedTotal.toLocaleString('en-US')} ≠ بستانکار ${voucher.besTotal.toLocaleString('en-US')} (اختلاف ${(voucher.bedTotal - voucher.besTotal).toLocaleString('en-US')})`);
    }
    const dateISO = JALALI_TO_ISO(voucher.date);
    if (!dateISO) issues.push(`تاریخ ${voucher.date || '—'} به تاریخ تقویم تبدیل نشد.`);

    const lines = [];
    const lineIssues = [];
    let validLineCount = 0;
    voucher.lines.forEach((line, index) => {
      if (!line.bed && !line.bes) { skippedZeroRows += 1; return; }
      const label = line.comment ? ` «${line.comment.slice(0, 60)}»` : '';
      if (line.bed == null || line.bes == null) { lineIssues.push(`ردیف ${index + 1}${label}: مبلغ ناخوانا است.`); return; }
      if (line.bed < 0 || line.bes < 0) { lineIssues.push(`ردیف ${index + 1}${label}: مبلغ منفی پذیرفته نیست.`); return; }
      if (line.bed > 0 && line.bes > 0) { lineIssues.push(`ردیف ${index + 1}${label}: هم بدهکار دارد هم بستانکار.`); return; }
      const composite = moeenIndex.get(`${line.kol}:${line.moeen}`);
      if (!composite) {
        lineIssues.push(`ردیف ${index + 1}${label}: حساب (کل ${line.kol}، معین ${line.moeen}) در کدینگ فایل نیست.`);
        return;
      }
      const analyticKey = line.taf > 0 ? analyticKeys.get(`${line.kol}:${line.moeen}:${line.taf}`) : null;
      if (line.taf > 0 && !analyticKey) {
        issues.push(`ردیف ${index + 1}: تفصیلی ${line.taf} در فایل تعریف نشده؛ سطر بدون تفصیلی وارد می‌شود.`);
      }
      validLineCount += 1;
      lines.push({
        kol: line.kol, moeen: line.moeen, taf: line.taf,
        bed: line.bed || 0, bes: line.bes || 0,
        comment: line.comment || '', sanadComment: line.sanadComment || '',
        composite, analyticKey: analyticKey ? analyticKey.sourceKey : null,
      });
    });
    if (validLineCount < 2) issues.push(`سند فقط ${validLineCount} آرتیکل معتبر دارد؛ سند باید دست‌کم دو آرتیکل داشته باشد.`);

    const firstComment = voucher.lines.find((line) => (line.comment || '').trim())?.comment || '';
    vouchers.push({
      sanad: voucher.sanad, date: voucher.date, dateISO, balanced: voucher.balanced,
      bedTotal: voucher.bedTotal, besTotal: voucher.besTotal,
      lineCount: voucher.lines.length, validLineCount, lines, lineIssues, issues,
      memo: `[بکاپ پارسیان] سند ${voucher.sanad} — ${voucher.date}${firstComment ? ` — ${firstComment.slice(0, 120)}` : ''}`,
      importable: Boolean(voucher.balanced && dateISO && validLineCount >= 2 && lineIssues.length === 0),
    });
  }

  if (skippedZeroRows) {
    warnings.push(`${skippedZeroRows.toLocaleString('fa-IR')} ردیف با مبلغ صفر عمداً وارد نشد (سطرهای تهی سندها).`);
  }

  const importable = vouchers.filter((voucher) => voucher.importable);
  const dates = importable.map((voucher) => voucher.date).sort();
  return {
    chartRows, analyticSpecs, vouchers, warnings,
    summary: {
      kolCount: parsed.chart.kol.length,
      moeenCount: parsed.chart.moeen.length,
      tafsiliCount: parsed.chart.tafsili.length,
      chartRowsCount: chartRows.length,
      voucherCount: vouchers.length,
      importableCount: importable.length,
      unbalancedCount: vouchers.filter((voucher) => !voucher.balanced).length,
      lineCount: importable.reduce((sum, voucher) => sum + voucher.lines.length, 0),
      bedTotal: importable.reduce((sum, voucher) => sum + voucher.bedTotal, 0),
      besTotal: importable.reduce((sum, voucher) => sum + voucher.besTotal, 0),
      sanadMin: vouchers.length ? Math.min(...vouchers.map((voucher) => voucher.sanad)) : null,
      sanadMax: vouchers.length ? Math.max(...vouchers.map((voucher) => voucher.sanad)) : null,
      dateMin: dates[0] || null,
      dateMax: dates[dates.length - 1] || null,
    },
  };
}

const JALALI_TO_ISO = (date) => {
  const match = /^(\d{4})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/.exec(date || '');
  return match ? persianToISO(Number(match[1]), Number(match[2]), Number(match[3])) : null;
};

function voucherPreview(voucher) {
  return {
    sanad: voucher.sanad, date: voucher.date, dateISO: voucher.dateISO,
    balanced: voucher.balanced, importable: voucher.importable,
    bedTotal: voucher.bedTotal, besTotal: voucher.besTotal,
    lineCount: voucher.lineCount, validLineCount: voucher.validLineCount,
    issues: voucher.issues, lineIssues: voucher.lineIssues, memo: voucher.memo,
    lines: voucher.lines.map((line) => ({
      kol: line.kol, moeen: line.moeen, taf: line.taf, bed: line.bed, bes: line.bes,
      comment: line.comment, composite: line.composite,
      hasAnalytic: Boolean(line.analyticKey),
    })),
  };
}

/** پیش‌نمایش کامل: بدون هیچ نوشتنی در دفتر. */
export function previewParsianBackup(database, buffer, fileName) {
  const parsed = parseParsianBackup(buffer, { fileName });
  const plan = buildParsianImportPlan(parsed);
  const raw = rawLedgerStatus(database);
  return {
    meta: parsed.meta,
    rawLedger: raw,
    summary: plan.summary,
    warnings: plan.warnings,
    chart: {
      kol: plan.chartRows.filter((row) => row.level === 'general').map((row) => ({
        code: row.code, name: row.name, type: row.type, typeLabel: TYPE_LABELS[row.type] || row.type,
      })),
      moeen: plan.chartRows.filter((row) => row.level === 'subsidiary').map((row) => ({
        code: row.code, kolCode: row.parentCode, moeenCode: row.levelCode,
        name: row.name, typeLabel: TYPE_LABELS[row.type] || row.type,
      })),
      tafsili: plan.analyticSpecs.map((spec) => ({
        kol: spec.kol, moeen: spec.moeen, code: spec.code, name: spec.name,
        kindLabel: spec.kind === 'contact' ? 'طرف حساب' : 'سایر',
      })),
    },
    vouchers: plan.vouchers.map(voucherPreview),
  };
}

/** ثبت طرح در دفتر خام. همان دادهٔ پیش‌نمایش، همان نگاشت، دوباره سنجیده می‌شود. */
export function commitParsianBackup(database, buffer, fileName, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  const raw = rawLedgerStatus(database);
  if (!raw.ok) {
    throw parsianImportError(raw.message, 'PARSIAN_IMPORT_LEDGER_NOT_RAW', 409, {
      journalCount: raw.journalCount, chartCount: raw.chartCount, analyticCount: raw.analyticCount,
    });
  }
  const parsed = parseParsianBackup(buffer, { fileName });
  const plan = buildParsianImportPlan(parsed);
  const importable = plan.vouchers.filter((voucher) => voucher.importable);
  if (!plan.chartRows.length) {
    throw parsianImportError('هیچ ردیف کدینگ قابل ورودی در این بکاپ نیست.', 'PARSIAN_IMPORT_EMPTY');
  }
  if (!importable.length && plan.summary.voucherCount > 0) {
    throw parsianImportError('هیچ سند متوازنی برای ورود پیدا نشد؛ فهرست هشدارهای پیش‌نمایش را ببین.', 'PARSIAN_IMPORT_NO_VALID_VOUCHERS', 422);
  }

  const logImport = (status, note) => {
    try {
      database.prepare(`INSERT INTO parsian_import_log (id,file_name,file_sha256,status,kol_count,moeen_count,tafsili_count,
          voucher_count,line_count,skipped_voucher_count,bed_total,bes_total,sanad_min,sanad_max,date_min,date_max,created_by,note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), parsed.meta.fileName, parsed.meta.sha256, status,
        plan.summary.kolCount, plan.summary.moeenCount, plan.summary.tafsiliCount,
        importable.length, plan.summary.lineCount, plan.summary.voucherCount - importable.length,
        plan.summary.bedTotal, plan.summary.besTotal,
        plan.summary.sanadMin, plan.summary.sanadMax, plan.summary.dateMin, plan.summary.dateMax,
        createdBy, String(note || '').slice(0, 400),
      );
    } catch { /* ثبت گزارش هرگز خودِ ورود را نشکند. */ }
  };

  // ۱) کدینگ — همه یا هیچ. منبع «import» (محدودیت CHECK ستون source)؛
  // جزئیات دقیق منبع در جدول گزارش ورود پارسیان ثبت می‌شود.
  const chartResult = importChartOfAccounts(database, plan.chartRows, { source: 'import', codingStyle: 'segmented' });

  // ۲) تفصیلی‌ها و حساب‌های دفتر کلِ متصل به معین‌ها.
  const analyticIdByKey = new Map();
  for (const spec of plan.analyticSpecs) {
    const saved = saveAnalyticAccount(database, {
      name: spec.name, kind: spec.kind, sourceKind: 'parsian-tafsili', sourceKey: spec.sourceKey,
      ...(spec.externalCode ? { externalCode: spec.externalCode } : {}),
    });
    analyticIdByKey.set(spec.sourceKey, saved.id);
  }
  const ledgerIdByComposite = new Map();
  for (const chart of listChartAccounts(database).filter((item) => item.active && item.postable)) {
    const ledgerId = ledgerAccountForChart(database, chart, (type) => nextLedgerCode(database, type));
    ledgerIdByComposite.set(chart.code, ledgerId);
  }

  // ۳) اسناد متوازن — دسته‌دسته، به‌صورت پیش‌نویس برای تأیید حسابدار.
  const documents = importable.map((voucher) => ({
    occurredAt: voucher.dateISO,
    memo: voucher.memo,
    lines: voucher.lines.map((line) => ({
      accountId: ledgerIdByComposite.get(line.composite),
      debit: line.bed, credit: line.bes,
      description: line.comment.slice(0, 300),
      analyticId: line.analyticKey ? analyticIdByKey.get(line.analyticKey) || null : null,
    })),
  }));
  const created = { entries: 0, documentNumbers: [], total: 0 };
  try {
    for (let offset = 0; offset < documents.length; offset += JOURNAL_CHUNK) {
      const chunk = documents.slice(offset, offset + JOURNAL_CHUNK);
      const result = createJournalBatch(database, chunk, { createdBy, timeZone });
      created.entries += result.created;
      created.documentNumbers.push(...result.documentNumbers);
      created.total += result.total;
    }
  } catch (error) {
    logImport('partial', `کدینگ وارد شد ولی ثبت اسناد در میانه متوقف شد: ${error.message}`);
    throw parsianImportError(
      `کدینگ و تفصیلی وارد شد ولی ثبت اسناد کامل نشد: ${error.message} — وضعیت در گزارش ورود پارسیان ثبت شد.`,
      'PARSIAN_IMPORT_PARTIAL', 500,
      { details: error.details },
    );
  }

  logImport('complete', `ورود کامل: ${created.entries} سند پیش‌نویس.`);
  const skipped = plan.vouchers.filter((voucher) => !voucher.importable).map(voucherPreview);
  return {
    chart: chartResult,
    analytics: analyticIdByKey.size,
    ledgerAccounts: ledgerIdByComposite.size,
    journals: { ...created, unit: 'IRT' },
    skippedVouchers: skipped,
    summary: plan.summary,
  };
}
