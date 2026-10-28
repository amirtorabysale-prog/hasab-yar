// ثبت تولید: مواد از انبار به بهای میانگین موزون خارج می‌شوند و محصول با همان ارزش وارد.
//
// تولید پول جابه‌جا نمی‌کند و درآمد یا هزینه نمی‌سازد؛ فقط شکل دارایی عوض می‌شود. سندش
// فقط میان حساب‌های موجودی است: موجودی محصول بدهکار، موجودی هر جزء بستانکار، با یک مبلغ.
// دستمزد و سربار تولید این‌جا حدس زده نمی‌شوند؛ اگر باید جذب شوند، حسابدار سند جدا می‌زند.
//
// اجزا از فرمول تولیدِ واردشده از پارسیان پیشنهاد می‌شوند (همان نام کالا)؛ کاربر می‌تواند
// مقدار واقعی مصرف را عوض کند. کمبود هر جزء ثبت را متوقف می‌کند و دقیقاً می‌گوید چقدر کم است.

import { randomUUID } from 'node:crypto';
import { inventoryLedgerAccount } from './accounting.js';
import { insertJournal } from './accounting/journalCore.js';
import { ensureInventorySchema, recordInventoryMovement } from './inventory.js';
import { ensureParsianExtrasSchema } from './parsianExtras.js';

const EPSILON = 0.000001;

function productionError(message, code = 'PRODUCTION_INVALID', status = 400, details) {
  return Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
}

export function ensureProductionSchema(database) {
  ensureInventorySchema(database);
  database.exec(`CREATE TABLE IF NOT EXISTS production_runs (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity REAL NOT NULL CHECK(quantity > 0),
    value INTEGER NOT NULL DEFAULT 0,
    components TEXT NOT NULL DEFAULT '[]',
    entry_id TEXT,
    occurred_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  return database;
}

const productById = (database, id) => database.prepare(`SELECT id,name,unit,stock,average_cost AS averageCost,buy_price AS buyPrice,
  track_inventory AS trackInventory FROM products WHERE id=?`).get(String(id || ''));

/**
 * اجزای پیشنهادی تولید `quantity` واحد از یک کالا، از فرمول پارسیانِ همان نام، با موجودی
 * و بهای میانگین فعلی هر جزء. فرمول نداشتن خطا نیست: اجزا خالی برمی‌گردد.
 */
export function productionPlan(database, { productId, quantity = 1 } = {}) {
  ensureProductionSchema(database);
  ensureParsianExtrasSchema(database);
  const product = productById(database, productId);
  if (!product) throw productionError('کالا پیدا نشد.', 'PRODUCTION_PRODUCT_MISSING', 404);
  const amount = Number(quantity) > 0 ? Number(quantity) : 1;
  const rows = database.prepare(`SELECT component_name AS name,quantity,per_units AS perUnits FROM parsian_production_formulas
    WHERE product_name=? COLLATE NOCASE ORDER BY component_name`).all(product.name);
  const components = rows.map((row) => {
    const component = database.prepare('SELECT id,name,unit,stock,average_cost AS averageCost FROM products WHERE name=? COLLATE NOCASE').get(row.name);
    const needed = (row.quantity / (row.perUnits || 1)) * amount;
    return {
      productId: component?.id || null, name: row.name, unit: component?.unit || '', quantity: Math.round(needed * 1000) / 1000,
      stock: component ? Number(component.stock) : 0, averageCost: component ? Number(component.averageCost) : 0,
      shortage: component ? Math.max(0, needed - Number(component.stock)) : needed,
    };
  });
  return { product: { id: product.id, name: product.name, unit: product.unit }, quantity: amount, components, fromFormula: rows.length > 0 };
}

/**
 * ثبت یک تولید. `components` = [{ productId, quantity }] مقدار واقعی مصرف‌شده.
 * همه یا هیچ: گردش‌ها و سند در یک تراکنش.
 */
export function recordProduction(database, values = {}, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureProductionSchema(database);
  const product = productById(database, values.productId);
  if (!product || !product.trackInventory) throw productionError('محصولِ قابل رهگیری پیدا نشد.', 'PRODUCTION_PRODUCT_MISSING', 404);
  const quantity = Number(values.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw productionError('تعداد تولید باید بیشتر از صفر باشد.');
  const merged = new Map();
  for (const item of values.components || []) {
    const amount = Number(item.quantity);
    if (!item.productId || !(amount > 0)) continue;
    merged.set(item.productId, (merged.get(item.productId) || 0) + amount);
  }
  if (!merged.size) throw productionError('مواد مصرف‌شده را بگو؛ تولید بی‌مصرف مواد ارزشی ندارد و حدس زده نمی‌شود.', 'PRODUCTION_NO_COMPONENTS');
  if (merged.has(product.id)) throw productionError('محصول نمی‌تواند جزء مصرفی خودش باشد.');
  const components = [...merged].map(([id, amount]) => {
    const component = productById(database, id);
    if (!component || !component.trackInventory) throw productionError('یکی از اجزا کالای قابل رهگیری نیست.', 'PRODUCTION_COMPONENT_MISSING', 404);
    return { ...component, quantity: amount };
  });
  const short = components.filter((component) => component.quantity - Number(component.stock) > EPSILON);
  if (short.length) {
    throw productionError(`موجودی کافی نیست: ${short.map((component) => `«${component.name}» ${Number(component.stock)} ${component.unit} دارد و ${component.quantity} لازم است`).join('؛ ')}. اول خرید یا شمارش را ثبت کن.`,
      'PRODUCTION_SHORTAGE', 409, { shortages: short.map((component) => ({ productId: component.id, stock: Number(component.stock), needed: component.quantity })) });
  }
  const occurredAt = values.occurredAt || new Date().toISOString();
  const id = randomUUID();
  const note = String(values.note || '').trim().slice(0, 300);
  const memo = `تولید ${quantity} ${product.unit} ${product.name}${note ? ` — ${note}` : ''}`.slice(0, 200);
  database.exec('BEGIN IMMEDIATE');
  try {
    const consumed = components.map((component) => {
      const { movement } = recordInventoryMovement(database, component.id, {
        quantity: -component.quantity, movementType: 'consumption', sourceType: 'production', sourceId: id,
        occurredAt, note: `مصرف در ${memo}`,
      }, { createdBy, timeZone, journal: false });
      return { productId: component.id, name: component.name, unit: component.unit, quantity: component.quantity, value: -Number(movement.valueDelta) };
    });
    const value = consumed.reduce((sum, item) => sum + item.value, 0);
    if (!(value > 0)) throw productionError('مواد مصرفی بهای ثبت‌شده ندارند؛ بی‌بها، ارزش محصول حدس زده می‌شد. اول بهای خرید مواد را ثبت کن.', 'PRODUCTION_NO_COST');
    recordInventoryMovement(database, product.id, {
      quantity, valueDelta: value, movementType: 'production', sourceType: 'production', sourceId: id, occurredAt, note: memo,
    }, { createdBy, timeZone, journal: false });
    const entry = insertJournal(database, {
      sourceType: 'production', sourceId: id, revision: 1, occurredAt, memo, createdBy, timeZone,
      lines: [
        { accountId: inventoryLedgerAccount(database, product), debit: value, description: memo },
        ...consumed.filter((item) => item.value > 0).map((item) => ({
          accountId: inventoryLedgerAccount(database, { id: item.productId, name: item.name }), credit: item.value, description: `مصرف ${item.name}`,
        })),
      ],
    });
    database.prepare(`INSERT INTO production_runs (id,product_id,quantity,value,components,entry_id,occurred_at,note,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, product.id, quantity, value, JSON.stringify(consumed), entry.id, occurredAt, note, createdBy);
    database.exec('COMMIT');
    return { id, productId: product.id, productName: product.name, quantity, value, unitCost: Math.round(value / quantity), components: consumed, entryId: entry.id, documentNumber: entry.documentNumber };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function listProductionRuns(database, { limit = 50 } = {}) {
  ensureProductionSchema(database);
  return database.prepare(`SELECT production_runs.id,production_runs.product_id AS productId,products.name AS productName,products.unit,
      production_runs.quantity,production_runs.value,production_runs.components,production_runs.entry_id AS entryId,
      journal_entries.document_number AS documentNumber,production_runs.occurred_at AS occurredAt,production_runs.note
    FROM production_runs JOIN products ON products.id=production_runs.product_id
    LEFT JOIN journal_entries ON journal_entries.id=production_runs.entry_id
    ORDER BY production_runs.occurred_at DESC,production_runs.created_at DESC LIMIT ?`).all(limit)
    .map((row) => ({ ...row, components: JSON.parse(row.components || '[]') }));
}
