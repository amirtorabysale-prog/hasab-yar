// تفصیلی شناور و مرکز هزینه: ساخت، تفصیلی طرف حساب و برچسب موضوعی، بُعد هر ردیف سند و ماندهٔ هر بُعد.
//
// از server/chartOfAccounts.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// chartOfAccounts همه از همان server/chartOfAccounts.js می‌خوانند.

import { randomUUID } from 'node:crypto';
import { canonicalCounterpartyName } from '../../shared/counterpartyIdentity.js';
import { ANALYTIC_KINDS, TOPIC_SOURCE_KIND, normalizeTopicLabel, topicLabelKey, chartError, normalizeChartCode, chartCodeIsValid, cleanName, ensureChartSchema } from './base.js';

export function topicAnalytic(database, label) {
  const clean = normalizeTopicLabel(label);
  if (!clean) throw chartError('برچسب موضوعی خالی است.');
  const key = topicLabelKey(clean);
  ensureChartSchema(database);
  // برچسب‌های پیش از کلید مقایسه با متن خودشان ذخیره شده‌اند؛ همان تفصیلی دوباره
  // به کار می‌رود و سطرهای سندهای قبلی دست نمی‌خورند.
  const existing = database.prepare('SELECT id FROM analytic_accounts WHERE source_kind=? AND source_key=?').get(TOPIC_SOURCE_KIND, key)
    || database.prepare('SELECT id,source_key AS sourceKey FROM analytic_accounts WHERE source_kind=?').all(TOPIC_SOURCE_KIND)
      .find((row) => topicLabelKey(row.sourceKey) === key);
  if (existing) return database.prepare('SELECT * FROM analytic_accounts WHERE id=?').get(existing.id);
  return saveAnalyticAccount(database, { name: clean, kind: 'custom', sourceKind: TOPIC_SOURCE_KIND, sourceKey: key });
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
