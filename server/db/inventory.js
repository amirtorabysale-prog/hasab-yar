import { randomUUID } from 'node:crypto';
import { audit, currentTimeZone, currentWorkspace, db, invalidInput } from './core.js';
import { inventoryOverview as inventoryOverviewCore, recordInventoryMovement } from '../inventory.js';
import { listProductionRuns as listProductionRunsCore, productionPlan as productionPlanCore, recordProduction as recordProductionCore } from '../production.js';
import { parsianProductionArchive as parsianProductionArchiveCore } from '../parsianExtras.js';

export function listProducts() {
  return inventoryOverviewCore(db).products;
}

export function saveProduct(values = {}) {
  const name = String(values.name || '').trim().slice(0, 100);
  if (!name) throw invalidInput('نام کالا را وارد کن.');
  const id = values.id || randomUUID();
  const openingStock = Math.max(0, Number(values.stock) || 0);
  const buyPrice = Math.max(0, Math.round(Number(values.buyPrice) || 0));
  db.exec('BEGIN IMMEDIATE');
  try {
    if (values.id) {
      const result = db.prepare(`UPDATE products SET name=?,unit=?,low_threshold=?,buy_price=?,sale_price=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(name, String(values.unit || 'عدد').slice(0, 30), Math.max(0, Number(values.lowThreshold) || 0), buyPrice, Math.max(0, Math.round(Number(values.salePrice) || 0)), id);
      if (!result.changes) throw Object.assign(new Error('کالا پیدا نشد.'), { status: 404 });
    } else {
      db.prepare(`INSERT INTO products (id,name,stock,unit,low_threshold,buy_price,sale_price,average_cost,inventory_value)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, name, 0, String(values.unit || 'عدد').slice(0, 30), Math.max(0, Number(values.lowThreshold) || 0), buyPrice,
        Math.max(0, Math.round(Number(values.salePrice) || 0)), 0, 0);
      if (openingStock > 0) recordInventoryMovement(db, id, {
        quantity: openingStock, unitCost: buyPrice, movementType: 'opening', sourceType: 'product_opening', sourceId: id,
        note: 'موجودی ابتدای تعریف کالا',
      }, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    }
    audit(values.id ? 'update' : 'create', 'product', id, { name, openingStock: values.id ? undefined : openingStock });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return listProducts().find((item) => item.id === id);
}

export function adjustStock(id, values = {}) {
  const quantity = Number(values.quantity);
  if (!Number.isFinite(quantity) || quantity === 0) throw invalidInput('تغییر موجودی معتبر نیست.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = recordInventoryMovement(db, id, {
      quantity, unitCost: values.unitCost, movementType: 'adjustment', sourceType: 'manual',
      note: String(values.note || (quantity > 0 ? 'افزایش دستی موجودی' : 'کاهش دستی موجودی')).slice(0, 300),
    }, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    audit('adjust', 'product', id, { quantity, valueDelta: result.movement.valueDelta });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return listProducts().find((item) => item.id === id);
}

export function inventoryOverview() {
  return inventoryOverviewCore(db);
}

export function productionPlan(values = {}) {
  return productionPlanCore(db, values);
}

export function recordProduction(values = {}) {
  const run = recordProductionCore(db, values, { createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone() });
  audit('create', 'production_run', run.id, { productId: run.productId, quantity: run.quantity, value: run.value });
  return run;
}

export function listProductionRuns() {
  return listProductionRunsCore(db);
}

/** فرمول و تاریخچهٔ تولیدِ بکاپ پارسیان، فقط‌خواندنی. */
export function parsianProductionArchive() {
  return parsianProductionArchiveCore(db);
}
