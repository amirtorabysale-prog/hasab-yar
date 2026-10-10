import { randomUUID } from 'node:crypto';
import {
  assertAccountingPeriodOpen, periodForDate, postInventoryMovementJournal, reverseInventoryMovementJournal,
} from './accounting.js';
import { approvalRequiredError, currentApproval, recordOverdraftApproval } from './balanceGuard.js';

function inventoryError(message, code = 'INVENTORY_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function ensureColumn(database, table, definition) {
  try { database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`); }
  catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
}

export function ensureInventorySchema(database) {
  ensureColumn(database, 'products', 'average_cost INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'products', 'inventory_value INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'products', 'track_inventory INTEGER NOT NULL DEFAULT 1');
  ensureColumn(database, 'stock_movements', "movement_type TEXT NOT NULL DEFAULT 'adjustment'");
  ensureColumn(database, 'stock_movements', 'unit_cost INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'stock_movements', 'value_delta INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'stock_movements', "source_type TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(database, 'stock_movements', 'source_id TEXT');
  ensureColumn(database, 'stock_movements', 'occurred_at TEXT');
  ensureColumn(database, 'stock_movements', 'created_by TEXT');
  ensureColumn(database, 'invoice_items', 'product_id TEXT REFERENCES products(id) ON DELETE RESTRICT');
  ensureColumn(database, 'invoice_items', 'inventory_cost INTEGER NOT NULL DEFAULT 0');
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_stock_movements_product_date ON stock_movements(product_id,occurred_at,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_movements_source_unique
      ON stock_movements(source_type,source_id,product_id,movement_type) WHERE source_id IS NOT NULL;
  `);
  database.prepare('UPDATE stock_movements SET occurred_at=created_at WHERE occurred_at IS NULL').run();
}

function productRow(database, id) {
  return database.prepare(`SELECT id,name,stock,unit,low_threshold AS lowThreshold,buy_price AS buyPrice,sale_price AS salePrice,
    average_cost AS averageCost,inventory_value AS inventoryValue,track_inventory AS trackInventory
    FROM products WHERE id=?`).get(id) || null;
}

export function recordInventoryMovement(database, productId, values = {}, { createdBy = null, timeZone = 'Asia/Tehran', journal = true } = {}) {
  ensureInventorySchema(database);
  const product = productRow(database, productId);
  if (!product || !product.trackInventory) throw inventoryError('کالای قابل رهگیری پیدا نشد.', 'INVENTORY_PRODUCT_MISSING', 404);
  const quantity = Number(values.quantity);
  if (!Number.isFinite(quantity) || quantity === 0 || Math.abs(quantity) > 1_000_000_000) throw inventoryError('تعداد گردش موجودی معتبر نیست.');
  const occurredAt = values.occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
  const movementType = ['opening', 'purchase', 'sale', 'adjustment', 'reversal'].includes(values.movementType) ? values.movementType : 'adjustment';
  const newStock = Number(product.stock) + quantity;
  // کالا هم مثل صندوق: خروج بیش از موجودی فقط با تأیید حسابدار (مثلاً فروشی که
  // خریدش هنوز ثبت نشده). ورود روی کالایی که از قبل منفی است سد نمی‌شود.
  const shortage = quantity < 0 && newStock < -0.000001;
  const stockApproval = shortage ? currentApproval(database) : null;
  if (shortage && !stockApproval) {
    const items = [{ accountId: `product:${product.id}`, productId: product.id, name: product.name, before: Number(product.stock), after: newStock, unit: product.unit }];
    throw approvalRequiredError('stock', `موجودی «${product.name}» ${Number(product.stock)} ${product.unit || ''} است و این خروج ${Math.abs(quantity)} ${product.unit || ''} آن را به منفی ${Math.abs(newStock)} می‌رساند. کالا بیش از موجودی خارج نمی‌شود مگر با تأیید حسابدار؛ اگر خرید یا ورودی‌اش هنوز ثبت نشده، با دلیل تأیید کن.`.replace(/\s+/g, ' '), items);
  }
  let valueDelta;
  if (values.valueDelta != null) valueDelta = Math.round(Number(values.valueDelta));
  else if (quantity > 0) {
    const unitCost = Math.max(0, Math.round(Number(values.unitCost ?? product.averageCost ?? product.buyPrice) || 0));
    valueDelta = Math.round(quantity * unitCost);
  } else valueDelta = -Math.round(Math.abs(quantity) * Number(product.averageCost || product.buyPrice || 0));
  if (!Number.isSafeInteger(valueDelta) || (quantity > 0 && valueDelta < 0) || (quantity < 0 && valueDelta > 0)) throw inventoryError('ارزش گردش موجودی معتبر نیست.');
  let newValue = Number(product.inventoryValue) + valueDelta;
  // ماندهٔ منفیِ تأییدشده به همان بهای میانگین ارزش منفی می‌گیرد تا خریدِ بعدی آن را بپوشاند.
  const negativeStock = newStock < -0.000001 || (Number(product.stock) < -0.000001 && newStock <= 0.000001);
  if (newValue < -1 && !negativeStock) throw inventoryError('ارزش خروج از ارزش ثبت‌شدهٔ موجودی بیشتر است.', 'INVENTORY_VALUE_NEGATIVE', 409);
  if (Math.abs(newStock) < 0.000001) { newValue = 0; }
  if (!negativeStock) newValue = Math.max(0, newValue);
  const averageCost = newStock > 0 ? Math.round(newValue / newStock) : negativeStock ? Number(product.averageCost || product.buyPrice || 0) : 0;
  const id = values.id || randomUUID();
  const sourceType = String(values.sourceType || 'manual').slice(0, 40);
  const sourceId = values.sourceId ? String(values.sourceId).slice(0, 100) : null;
  try {
    database.prepare(`INSERT INTO stock_movements
      (id,product_id,quantity,note,movement_type,unit_cost,value_delta,source_type,source_id,occurred_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, product.id, quantity, String(values.note || '').slice(0, 300), movementType,
      quantity ? Math.round(Math.abs(valueDelta / quantity)) : 0, valueDelta, sourceType, sourceId, occurredAt, createdBy);
  } catch (error) {
    if (/unique/i.test(error.message) && sourceId) return database.prepare('SELECT * FROM stock_movements WHERE source_type=? AND source_id=? AND product_id=? AND movement_type=?').get(sourceType, sourceId, product.id, movementType);
    throw error;
  }
  database.prepare('UPDATE products SET stock=?,inventory_value=?,average_cost=?,buy_price=CASE WHEN ?>0 THEN ? ELSE buy_price END,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(Math.abs(newStock) < 0.000001 ? 0 : newStock, newValue, averageCost, averageCost, averageCost, product.id);
  if (stockApproval) recordOverdraftApproval(database, [{ accountId: `product:${product.id}`, name: product.name, before: Number(product.stock), after: newStock }], stockApproval, 'stock');
  const movement = database.prepare(`SELECT id,product_id AS productId,quantity,note,movement_type AS movementType,unit_cost AS unitCost,
    value_delta AS valueDelta,source_type AS sourceType,source_id AS sourceId,occurred_at AS occurredAt FROM stock_movements WHERE id=?`).get(id);
  if (journal) postInventoryMovementJournal(database, movement, product, { createdBy, timeZone });
  return { movement, product: productRow(database, product.id) };
}

function groupedProductItems(invoice) {
  const grouped = new Map();
  for (const item of invoice.items || []) {
    if (!item.productId) continue;
    const current = grouped.get(item.productId) || { productId: item.productId, quantity: 0, inventoryCost: 0, title: item.title };
    current.quantity += Number(item.quantity);
    current.inventoryCost += Number(item.inventoryCost || 0);
    grouped.set(item.productId, current);
  }
  return [...grouped.values()];
}

export function applyInvoiceInventory(database, invoice, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureInventorySchema(database);
  const occurredAt = invoice.issuedAt || invoice.issued_at || new Date().toISOString();
  const results = [];
  for (const item of groupedProductItems(invoice)) {
    if (invoice.documentType === 'purchase') {
      results.push(recordInventoryMovement(database, item.productId, {
        quantity: item.quantity, valueDelta: item.inventoryCost, movementType: 'purchase', sourceType: 'invoice', sourceId: invoice.id,
        occurredAt, note: `ورود از صورتحساب ${invoice.number}`,
      }, { createdBy, timeZone, journal: false }));
    } else {
      results.push(recordInventoryMovement(database, item.productId, {
        quantity: -item.quantity, movementType: 'sale', sourceType: 'invoice', sourceId: invoice.id,
        occurredAt, note: `خروج و بهای تمام‌شده ${invoice.number}`,
      }, { createdBy, timeZone, journal: true }));
    }
  }
  return results;
}

export function reverseInvoiceInventory(database, invoice, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureInventorySchema(database);
  const movements = database.prepare("SELECT rowid AS movement_rowid,* FROM stock_movements WHERE source_type='invoice' AND source_id=? ORDER BY rowid DESC").all(invoice.id);
  const occurredAt = new Date().toISOString();
  for (const original of movements) {
    const existing = database.prepare("SELECT id FROM stock_movements WHERE source_type='invoice_reversal' AND source_id=? AND product_id=?").get(invoice.id, original.product_id);
    if (existing) continue;
    if (original.movement_type === 'purchase') {
      const later = database.prepare(`SELECT id FROM stock_movements WHERE product_id=? AND rowid>? AND
        NOT (source_type='invoice_reversal' AND source_id=?) LIMIT 1`).get(original.product_id, original.movement_rowid, invoice.id);
      if (later) throw inventoryError('بعد از این خرید برای کالا گردش دیگری ثبت شده است؛ ابتدا گردش‌های بعدی را اصلاح کن.', 'INVENTORY_PURCHASE_HAS_LATER_MOVEMENTS', 409);
    }
    if (original.movement_type === 'sale') reverseInventoryMovementJournal(database, original.id, occurredAt, { createdBy, timeZone });
    recordInventoryMovement(database, original.product_id, {
      quantity: -Number(original.quantity), valueDelta: -Number(original.value_delta), movementType: 'reversal',
      sourceType: 'invoice_reversal', sourceId: invoice.id, occurredAt, note: `برگشت گردش ${invoice.number}`,
    }, { createdBy, timeZone, journal: false });
  }
}

export function migrateInventory(database, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureInventorySchema(database);
  const products = database.prepare('SELECT id,name,stock,buy_price,inventory_value FROM products WHERE track_inventory=1').all();
  for (const product of products) {
    const exists = database.prepare(`SELECT id FROM stock_movements WHERE product_id=? AND
      (source_type='migration' OR movement_type IN ('opening','purchase','sale','reversal') OR value_delta!=0) LIMIT 1`).get(product.id);
    if (exists || Number(product.stock) <= 0) continue;
    const value = Number(product.inventory_value) > 0 ? Number(product.inventory_value) : Math.round(Number(product.stock) * Number(product.buy_price || 0));
    const id = randomUUID();
    const occurredAt = new Date().toISOString();
    assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
    database.prepare(`INSERT INTO stock_movements
      (id,product_id,quantity,note,movement_type,unit_cost,value_delta,source_type,source_id,occurred_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, product.id, Number(product.stock), 'ماندهٔ افتتاحیهٔ مهاجرت انبار', 'opening',
      Math.round(value / Number(product.stock)), value, 'migration', product.id, occurredAt, createdBy);
    database.prepare('UPDATE products SET inventory_value=?,average_cost=? WHERE id=?')
      .run(value, Math.round(value / Number(product.stock)), product.id);
    postInventoryMovementJournal(database, { id, quantity: Number(product.stock), valueDelta: value, movementType: 'opening', occurredAt }, product, { createdBy, timeZone });
  }
}

export function inventoryOverview(database) {
  ensureInventorySchema(database);
  const products = database.prepare(`SELECT id,name,stock,unit,low_threshold AS lowThreshold,buy_price AS buyPrice,sale_price AS salePrice,
    average_cost AS averageCost,inventory_value AS inventoryValue,track_inventory AS trackInventory,
    CASE WHEN low_threshold>0 AND stock<=low_threshold THEN 1 ELSE 0 END AS isLow FROM products ORDER BY isLow DESC,name`).all();
  const movements = database.prepare(`SELECT stock_movements.id,stock_movements.product_id AS productId,products.name AS productName,
    stock_movements.quantity,stock_movements.movement_type AS movementType,stock_movements.unit_cost AS unitCost,
    stock_movements.value_delta AS valueDelta,stock_movements.note,stock_movements.occurred_at AS occurredAt
    FROM stock_movements JOIN products ON products.id=stock_movements.product_id ORDER BY stock_movements.occurred_at DESC,stock_movements.created_at DESC LIMIT 100`).all();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const cogs30 = Number(database.prepare(`SELECT COALESCE(SUM(CASE
    WHEN movement_type='sale' THEN -value_delta
    WHEN movement_type='reversal' AND source_type='invoice_reversal' THEN -value_delta
    ELSE 0 END),0) AS total FROM stock_movements WHERE occurred_at>=?`).get(cutoff).total);
  return {
    products, movements,
    summary: { inventoryValue: products.reduce((sum, product) => sum + Number(product.inventoryValue), 0), lowStockCount: products.filter((product) => product.isLow).length, cogs30 },
  };
}
