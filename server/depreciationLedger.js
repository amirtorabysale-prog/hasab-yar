import { assetStatus, dueDepreciation } from '../shared/depreciation.js';
import {
  assertAccountingPeriodOpen, ensureAccountingSchema, postDepreciationJournal, postedDepreciationMonths,
} from './accounting.js';

/**
 * دفتر دارایی ثابت و اجرای ماهانهٔ استهلاک.
 *
 * دارایی‌ها از قبل به‌صورت حساب دفتر کل با `source_kind='fixed-asset'` وجود
 * دارند؛ این ماژول چیزی موازی نمی‌سازد و فقط عمر مفید و ارزش اسقاط را کنارشان
 * می‌گذارد و سند ماهانه را می‌زند.
 *
 * تا وقتی عمر مفید ثبت نشده، هیچ استهلاکی محاسبه نمی‌شود. عمر مفید حدس‌زدنی
 * نیست: همان دارایی در یک پرونده پنج‌ساله است و در پرونده‌ای دیگر ده‌ساله، و
 * حدسِ اشتباه یعنی هزینهٔ هر ماه و سود دوره غلط است.
 */

function ledgerError(message, code = 'DEPRECIATION_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function ensureDepreciationSchema(database) {
  ensureAccountingSchema(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS fixed_asset_settings (
      asset_key TEXT PRIMARY KEY,
      useful_life_months INTEGER NOT NULL,
      salvage INTEGER NOT NULL DEFAULT 0,
      in_service_month TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'straight-line' CHECK(method IN ('straight-line')),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * بهای تمام‌شدهٔ هر دارایی از جمع بدهکار حساب خودش می‌آید، نه از یک ستون جدا.
 * اگر بعداً بهبود سرمایه‌ای روی همان دارایی ثبت شود، بها خودبه‌خود درست می‌ماند.
 */
export function listFixedAssets(database, { throughMonth = '' } = {}) {
  ensureDepreciationSchema(database);
  const rows = database.prepare(`SELECT ledger_accounts.id AS accountId, ledger_accounts.source_key AS assetKey,
      ledger_accounts.name AS name,
      COALESCE(SUM(journal_lines.debit),0) - COALESCE(SUM(journal_lines.credit),0) AS cost
    FROM ledger_accounts
    LEFT JOIN journal_lines ON journal_lines.account_id=ledger_accounts.id
    WHERE ledger_accounts.source_kind='fixed-asset'
    GROUP BY ledger_accounts.id ORDER BY ledger_accounts.name`).all();

  const settings = new Map(database.prepare('SELECT * FROM fixed_asset_settings').all()
    .map((row) => [row.asset_key, row]));

  return rows.map((row) => {
    const setting = settings.get(row.assetKey) || null;
    const asset = {
      cost: Math.round(Number(row.cost) || 0),
      salvage: setting ? Number(setting.salvage) : 0,
      usefulLifeMonths: setting ? Number(setting.useful_life_months) : 0,
      inServiceMonth: setting ? String(setting.in_service_month) : '',
    };
    const postedMonths = postedDepreciationMonths(database, row.assetKey);
    const accumulated = database.prepare(`SELECT COALESCE(SUM(journal_lines.credit),0) - COALESCE(SUM(journal_lines.debit),0) AS total
      FROM journal_lines JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE ledger_accounts.source_kind='accumulated-depreciation' AND ledger_accounts.source_key=?`).get(row.assetKey).total;
    return {
      assetKey: row.assetKey,
      name: row.name,
      configured: Boolean(setting),
      ...asset,
      postedMonths,
      ...assetStatus(asset, { postedAmount: Math.round(Number(accumulated) || 0), throughMonth }),
      due: throughMonth ? dueDepreciation(asset, { throughMonth, postedMonths }) : [],
    };
  });
}

export function saveFixedAssetSettings(database, values = {}) {
  ensureDepreciationSchema(database);
  const assetKey = String(values.assetKey || '').trim();
  if (!assetKey) throw ledgerError('دارایی مشخص نیست.');
  const known = database.prepare("SELECT id FROM ledger_accounts WHERE source_kind='fixed-asset' AND source_key=?").get(assetKey);
  if (!known) throw ledgerError('این دارایی ثابت در دفتر پیدا نشد.', 'ASSET_MISSING', 404);

  const usefulLifeMonths = Math.floor(Number(values.usefulLifeMonths) || 0);
  if (usefulLifeMonths < 1 || usefulLifeMonths > 600) throw ledgerError('عمر مفید باید بین ۱ تا ۶۰۰ ماه باشد.');
  const salvage = Math.max(0, Math.round(Number(values.salvage) || 0));
  const inServiceMonth = String(values.inServiceMonth || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(inServiceMonth)) throw ledgerError('ماه بهره‌برداری را به شکل ۱۴۰۵-۰۶ وارد کن.');

  database.prepare(`INSERT INTO fixed_asset_settings (asset_key,useful_life_months,salvage,in_service_month,method)
    VALUES (?,?,?,?,'straight-line')
    ON CONFLICT(asset_key) DO UPDATE SET useful_life_months=excluded.useful_life_months,
      salvage=excluded.salvage,in_service_month=excluded.in_service_month,updated_at=CURRENT_TIMESTAMP`)
    .run(assetKey, usefulLifeMonths, salvage, inServiceMonth);
  return listFixedAssets(database).find((item) => item.assetKey === assetKey) || null;
}

/**
 * سند استهلاک همهٔ دارایی‌های سررسیدشده تا یک ماه.
 *
 * یا همه با هم ثبت می‌شوند یا هیچ‌کدام: ثبت نیمه‌کاره، دفتری می‌سازد که بعضی
 * دارایی‌ها به‌روزند و بعضی نه، و فهمیدن اینکه کجا مانده کار دستی می‌خواهد.
 *
 * دوره‌ای که بسته شده سند نمی‌پذیرد؛ این کنترل عمداً پیش از نوشتن انجام می‌شود
 * تا خطا به‌جای نیمهٔ کار، پیش از شروع بیاید.
 */
export function runDepreciation(database, { throughMonth = '', occurredAtFor, createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureDepreciationSchema(database);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(throughMonth))) throw ledgerError('ماه اجرای استهلاک معتبر نیست.');
  const assets = listFixedAssets(database, { throughMonth }).filter((asset) => asset.configured && asset.due.length);
  if (!assets.length) return { posted: 0, amount: 0, entries: [], months: [] };

  const planned = [];
  for (const asset of assets) {
    for (const row of asset.due) {
      const occurredAt = occurredAtFor(row.month);
      if (!occurredAt) throw ledgerError(`تاریخ پایان ماه ${row.month} ساخته نشد.`);
      planned.push({ asset, row, occurredAt });
    }
  }
  // کنترل قفل دوره پیش از هر نوشتنی، روی همهٔ ماه‌های درگیر.
  for (const period of new Set(planned.map((item) => item.row.month))) assertAccountingPeriodOpen(database, period);

  const entries = [];
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const item of planned) {
      const result = postDepreciationJournal(database, {
        assetKey: item.asset.assetKey, title: item.asset.name.replace(/^دارایی ثابت — /, ''),
        amount: item.row.amount, month: item.row.month, occurredAt: item.occurredAt,
      }, { createdBy, timeZone });
      entries.push({ assetKey: item.asset.assetKey, month: item.row.month, amount: item.row.amount, documentNumber: result.documentNumber });
    }
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }

  return {
    posted: entries.length,
    amount: entries.reduce((sum, entry) => sum + entry.amount, 0),
    entries,
    months: [...new Set(entries.map((entry) => entry.month))].sort(),
  };
}
