// نوشتن کدینگ: ورود (و ترمیم نگاشت حساب افتتاحیه پس از آن)، نصب و ترمیم الگوی خودمان، و ذخیرهٔ یک حساب.
//
// از server/chartOfAccounts.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// chartOfAccounts همه از همان server/chartOfAccounts.js می‌خوانند.

import { randomUUID } from 'node:crypto';
import { CHART_TYPES, CHART_ROLES, chartError, normalizeChartCode, chartCodeIsValid, cleanName, ensureChartSchema } from './base.js';
import { ANALYTIC_ROLES } from './csvFile.js';
import { normalizeChartLevel, normalizeChartType, validateChartRows } from './validation.js';
import { DEFAULT_CHART_TEMPLATE } from './defaultTemplate.js';
import { mapLedgerAccountToChart } from './ledgerMapping.js';

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
    ensureOpeningEquityMapping(database);
    database.exec('COMMIT');
    return { created, updated, total: accounts.length, source };
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}

/** Repairs only an unmapped system opening ledger; never changes an explicit mapping. */
export function ensureOpeningEquityMapping(database) {
  const columns=database.prepare('PRAGMA table_info(ledger_accounts)').all().map(c=>c.name);
  if(!['source_kind','source_key','active','chart_account_id'].every(c=>columns.includes(c))) return;
  const ledger=database.prepare("SELECT id,chart_account_id FROM ledger_accounts WHERE source_kind='system' AND source_key='opening-equity' AND active=1").get();
  if(!ledger || ledger.chart_account_id) return;
  const matches=database.prepare("SELECT id FROM chart_accounts WHERE role='equity' AND level='subsidiary' AND type='equity' AND normal_side='credit' AND active=1").all();
  if(matches.length===1) mapLedgerAccountToChart(database,ledger.id,matches[0].id);
}

/** Add the new subsidiary to our installed template only, not a custom chart. */
export function ensureTaxPenaltyTemplate(database) {
  const parent=database.prepare("SELECT id FROM chart_accounts WHERE code='81' AND source='template' AND type='expense' AND level='general' AND active=1").get();
  const tax=database.prepare("SELECT id FROM chart_accounts WHERE code='8114' AND source='template' AND name='مالیات و عوارض' AND active=1").get();
  if(!parent || !tax || database.prepare("SELECT 1 FROM chart_accounts WHERE code='8120' OR role='tax-penalty-expense'").get()) return;
  database.prepare("INSERT INTO chart_accounts(id,code,name,level,parent_id,type,normal_side,role,source,level_code) VALUES(?,'8120','جرایم مالیاتی','subsidiary',?,'expense','debit','tax-penalty-expense','template','8120')").run(randomUUID(),parent.id);
}

/**
 * «سود (زیان) انباشته» مقصد سند بستن حساب‌های موقت است. کدینگ پیشنهادیِ نصب‌شده پیش از
 * آبان ۱۴۰۵ آن را ندارد؛ فقط روی همان کدینگ خودمان اضافه می‌شود. کدینگ واردشدهٔ دفتر
 * دست نمی‌خورد و حسابدار هنگام بستن سال حسابش را انتخاب می‌کند.
 */
export function ensureRetainedEarningsTemplate(database) {
  const group=database.prepare("SELECT id FROM chart_accounts WHERE code='5' AND source='template' AND type='equity' AND level='group' AND active=1").get();
  if(!group || database.prepare("SELECT 1 FROM chart_accounts WHERE code IN ('52','5201') OR role='retained-earnings'").get()) return;
  const generalId=randomUUID();
  database.prepare("INSERT INTO chart_accounts(id,code,name,level,parent_id,type,normal_side,role,source,level_code) VALUES(?,'52','سود (زیان) انباشته','general',?,'equity','credit','','template','52')").run(generalId,group.id);
  database.prepare("INSERT INTO chart_accounts(id,code,name,level,parent_id,type,normal_side,role,source,level_code) VALUES(?,'5201','سود (زیان) انباشته','subsidiary',?,'equity','credit','retained-earnings','template','5201')").run(randomUUID(),generalId);
}

/**
 * کدینگ پیشنهادی که پیش از مهر ۱۴۰۵ نصب شده، معین «تنخواه‌گردان» را بی‌نقش
 * دارد؛ نقشش فقط روی همان کدینگِ خودمان داده می‌شود، نه روی کدینگ وارد‌شدهٔ دفتر.
 */
export function ensurePettyCashChartRole(database) {
  if (database.prepare("SELECT 1 FROM chart_accounts WHERE role='petty-cash'").get()) return;
  database.prepare(`UPDATE chart_accounts SET role='petty-cash'
    WHERE code='1103' AND source='template' AND role='' AND level='subsidiary' AND type='asset' AND name LIKE '%تنخواه%'`).run();
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
