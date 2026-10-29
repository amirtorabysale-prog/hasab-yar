// سابقهٔ سامانهٔ مؤدیان و چک‌های ضمانتِ بکاپ پارسیان.
//
// هیچ‌کدام سند نمی‌سازد و روی هیچ مانده‌ای اثر ندارد:
//  - مؤدیان: هر فاکتور فروش به سامانه رفته یا نه، و اگر خطا گرفته، پیام خود سامانه.
//    حسابدار باید بداند کدام صورت‌حساب هنوز ارسال‌نشده یا ردشده است.
//  - چک ضمانت: چکی که بابت تضمین داده یا گرفته شده، نه پرداخت. پارسیان آن را بیرون از
//    دفتر نگه می‌دارد؛ این‌جا فقط دیده می‌شود تا سررسید و برگرداندنش فراموش نشود.
// کلید و توکن سامانهٔ مؤدیان (tbl_NEWMovadianInfo) هرگز خوانده نمی‌شود.

import { randomUUID } from 'node:crypto';
import { convertAmount } from '../shared/amountUnit.js';
import { persianToISO } from '../shared/persianDate.js';

export const MOADIAN_SUBJECTS = Object.freeze({ 1: 'اصلی', 2: 'اصلاحی', 3: 'ابطال', 4: 'برگشت از فروش' });
const JALALI = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const toISO = (date) => {
  const match = JALALI.exec(String(date || '').trim());
  return match ? persianToISO(Number(match[1]), Number(match[2]), Number(match[3])) : null;
};
const clean = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
/** کد داخلی معین، همان قاعدهٔ ورود (server/parsianImport.js، internalMoeenCode). */
const moeenCode = (kol, moeen) => `${Number(kol)}${String(Number(moeen)).padStart(4, '0')}`;

export function ensureParsianSideSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS parsian_moadian_records (
      id TEXT PRIMARY KEY, file_sha256 TEXT NOT NULL, source TEXT NOT NULL, invoice_number INTEGER NOT NULL DEFAULT 0,
      subject INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('success','failed','pending')),
      sent_date TEXT NOT NULL DEFAULT '', invoice_date TEXT NOT NULL DEFAULT '', tax_id TEXT NOT NULL DEFAULT '',
      messages TEXT NOT NULL DEFAULT '[]', UNIQUE(file_sha256, source)
    );
    CREATE INDEX IF NOT EXISTS idx_parsian_moadian_invoice ON parsian_moadian_records(invoice_number, subject);
    CREATE TABLE IF NOT EXISTS parsian_guarantee_cheques (
      id TEXT PRIMARY KEY, file_sha256 TEXT NOT NULL, source_id INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('receivable','payable','unknown')),
      serial TEXT NOT NULL DEFAULT '', account_number TEXT NOT NULL DEFAULT '', due_jalali TEXT NOT NULL DEFAULT '', due_at TEXT,
      amount INTEGER, file_amount INTEGER NOT NULL DEFAULT 0, branch TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '',
      sanad INTEGER NOT NULL DEFAULT 0, party_chart_code TEXT NOT NULL DEFAULT '', party_analytic_id TEXT,
      bank_chart_code TEXT NOT NULL DEFAULT '', bank_analytic_id TEXT, UNIQUE(file_sha256, source_id)
    );
  `);
}

/** پیام‌های خطای سامانه: ستون Error آرایهٔ JSON است ({code, message})؛ متن خراب، همان متن. */
export function moadianMessages(raw) {
  const text = String(raw || '').trim();
  if (!text || text === '[]') return [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((item) => clean(item?.message || item?.Message || (typeof item === 'string' ? item : ''), 300)).filter(Boolean).slice(0, 5);
  } catch {
    return [clean(text, 300)];
  }
}

export function moadianStatus(raw) {
  const text = String(raw || '').trim().toUpperCase();
  if (text === 'SUCCESS') return 'success';
  if (text === 'FAILED') return 'failed';
  return 'pending';
}

/** ورود؛ اجرای دوبارهٔ همان فایل چیزی را تکرار نمی‌سازد. */
export function importParsianSideRecords(database, parsed, { fileUnit, ledgerUnit, analyticIdByKey = new Map() } = {}) {
  ensureParsianSideSchema(database);
  const extras = parsed?.extras || {};
  const sha = parsed?.meta?.sha256 || '';
  const result = { moadian: { stored: 0, failed: 0, pending: 0 }, guaranteeCheques: { stored: 0, inexact: 0 } };
  const insertMoadian = database.prepare(`INSERT OR IGNORE INTO parsian_moadian_records
    (id,file_sha256,source,invoice_number,subject,status,sent_date,invoice_date,tax_id,messages) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insertCheque = database.prepare(`INSERT OR IGNORE INTO parsian_guarantee_cheques
    (id,file_sha256,source_id,direction,serial,account_number,due_jalali,due_at,amount,file_amount,branch,comment,sanad,
     party_chart_code,party_analytic_id,bank_chart_code,bank_analytic_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const record of extras.moadian || []) {
      const status = moadianStatus(record.status);
      const stored = insertMoadian.run(randomUUID(), sha, record.source, record.invoiceNumber || 0, record.subject || 0, status,
        clean(record.sentDate, 10), clean(record.invoiceDate, 10), clean(record.taxId, 40), JSON.stringify(moadianMessages(record.error)));
      if (!stored.changes) continue;
      result.moadian.stored += 1;
      if (status === 'failed') result.moadian.failed += 1;
      if (status === 'pending') result.moadian.pending += 1;
    }
    for (const cheque of extras.guaranteeCheques || []) {
      const amount = cheque.money > 0 ? convertAmount(Math.round(cheque.money), fileUnit, ledgerUnit) : null;
      if (cheque.money > 0 && amount == null) result.guaranteeCheques.inexact += 1;
      const analytic = (kol, moeen, taf) => (taf > 0 ? analyticIdByKey.get(`${kol}:${moeen}:${taf}`) || null : null);
      const stored = insertCheque.run(randomUUID(), sha, cheque.id,
        cheque.kind === 0 ? 'receivable' : cheque.kind === 1 ? 'payable' : 'unknown',
        clean(cheque.serial, 40), clean(cheque.accountNumber, 40), clean(cheque.dueDate, 10), toISO(cheque.dueDate),
        amount, Math.round(cheque.money) || 0, clean(cheque.branch, 120), clean(cheque.comment, 300), cheque.sanad || 0,
        cheque.accKol ? moeenCode(cheque.accKol, cheque.accMoeen) : '', analytic(cheque.accKol, cheque.accMoeen, cheque.accTaf),
        cheque.bankKol ? moeenCode(cheque.bankKol, cheque.bankMoeen) : '', analytic(cheque.bankKol, cheque.bankMoeen, cheque.bankTaf));
      result.guaranteeCheques.stored += Number(stored.changes || 0);
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return result;
}

/**
 * وضعیت مؤدیان هر فاکتور فروش (فقط موضوع اصلی و اصلاحی؛ آخرین ارسال برنده است) و
 * فهرست آنچه هنوز به سامانه ننشسته.
 */
export function moadianOverview(database) {
  ensureParsianSideSchema(database);
  const rows = database.prepare(`SELECT source,invoice_number AS invoiceNumber,subject,status,sent_date AS sentDate,
      invoice_date AS invoiceDate,messages FROM parsian_moadian_records ORDER BY invoice_number,rowid`).all()
    .map((row) => ({ ...row, subjectLabel: MOADIAN_SUBJECTS[row.subject] || 'نامعلوم', messages: JSON.parse(row.messages || '[]') }));
  const byInvoice = new Map();
  for (const row of rows) if ([1, 2].includes(row.subject) && row.invoiceNumber) byInvoice.set(row.invoiceNumber, row);
  const count = (status) => rows.filter((row) => row.status === status).length;
  // فاکتوری که بعد از خطا دوباره و موفق رفته، دیگر مشکل نیست.
  const open = rows.filter((row) => row.status !== 'success'
    && !([1, 2].includes(row.subject) && byInvoice.get(row.invoiceNumber)?.status === 'success'));
  return { total: rows.length, success: count('success'), failed: count('failed'), pending: count('pending'), byInvoice, open };
}

/** چک‌های ضمانت با نام طرف حساب و بانک از کدینگ و اشخاصِ همین دفتر. */
export function listGuaranteeCheques(database) {
  ensureParsianSideSchema(database);
  const chartName = database.prepare('SELECT name FROM chart_accounts WHERE code=?');
  const analyticName = database.prepare(`SELECT COALESCE(contacts.name,analytic.name) AS name FROM analytic_accounts analytic
    LEFT JOIN contacts ON analytic.source_kind='contact' AND contacts.id=analytic.source_key WHERE analytic.id=?`);
  const nameOf = (analyticId, code) => (analyticId && analyticName.get(analyticId)?.name) || (code && chartName.get(code)?.name) || '';
  return database.prepare(`SELECT id,direction,serial,account_number AS accountNumber,due_jalali AS dueJalali,due_at AS dueAt,amount,
      branch,comment,sanad,party_chart_code AS partyChartCode,party_analytic_id AS partyAnalyticId,bank_chart_code AS bankChartCode,
      bank_analytic_id AS bankAnalyticId FROM parsian_guarantee_cheques ORDER BY due_at,source_id`).all()
    .map(({ partyChartCode, partyAnalyticId, bankChartCode, bankAnalyticId, ...row }) => ({
      ...row, party: nameOf(partyAnalyticId, partyChartCode), bank: nameOf(bankAnalyticId, bankChartCode),
    }));
}
