// موجودی کالای بکاپ پارسیان از گردش فاکتورها، به روش میانگین موزون.
//
// پارسیان ادواری است: حساب موجودی در دفتر تا بستن سال همان ماندهٔ اول دوره می‌ماند و
// گردش کالا فقط در فاکتورها است. حساب‌یار دائمی است: هر کالا تعداد و ارزش جاری دارد. این
// ماژول همان گردش را به ترتیب تاریخ می‌رود و برای هر کالا تعداد و بهای میانگین می‌سازد.
//
// قاعده‌ها:
//   - ورود: اول دوره، خرید (خالص تخفیف)، برگشت از فروش، تولید، اضافات. خروج: فروش،
//     برگشت از خرید، مصرف، کسری.
//   - ارزش ورود: خرید و اول دوره به قیمت فاکتور؛ تولید به قیمتی که خود پارسیان از مصرف
//     همان تولید ساخته؛ برگشت از فروش و اضافات به میانگین جاری. خروج به میانگین جاری،
//     جز برگشت از خرید که به قیمت همان فاکتور برمی‌گردد.
//   - هر نوع دیگر (امانات، انتقال بین انبار، پیش‌فاکتور، حواله و رسید انبار، ابطالی) گردش
//     مالکیت کالا نیست یا معنایش در این بکاپ ثابت نشده؛ کنار می‌رود و شمارش گفته می‌شود.
//   - کالایی که پایان گردشش منفی است حدس زده نمی‌شود: تعدادش را حسابدار با شمارش می‌گذارد.
//   - هیچ سندی ساخته نمی‌شود. ارزش موجودی با ماندهٔ حساب موجودی دفتر مقایسه و اختلاف گفته
//     می‌شود؛ اختلاف در پارسیانِ ادواری طبیعی است و تا سند بستن انبار پیدا است.

import { randomUUID } from 'node:crypto';
import { AMOUNT_UNITS, normalizeAmountUnit } from '../shared/amountUnit.js';
import { persianToISO } from '../shared/persianDate.js';
import { ensureInventorySchema } from './inventory.js';

// نوع فاکتور پارسیان (tbl_FactorKind.Code) به جهت و قاعدهٔ ارزش. همان I/O و پرچم تولید و
// مصرف جدول انواع در بکاپ اتیه سازان.
export const STOCK_KINDS = Object.freeze({
  5: { direction: 1, type: 'opening', cost: 'price', label: 'موجودی اول دوره' },
  2: { direction: 1, type: 'purchase', cost: 'price', label: 'خرید' },
  4: { direction: 1, type: 'sales-return', cost: 'average', label: 'برگشت از فروش' },
  12: { direction: 1, type: 'production', cost: 'price', label: 'تولید' },
  6: { direction: 1, type: 'surplus', cost: 'average', label: 'اضافات' },
  1: { direction: -1, type: 'sale', cost: 'average', label: 'فروش' },
  3: { direction: -1, type: 'purchase-return', cost: 'price', label: 'برگشت از خرید' },
  13: { direction: -1, type: 'consumption', cost: 'average', label: 'مصرف' },
  7: { direction: -1, type: 'shortage', cost: 'average', label: 'کسری' },
});

const JALALI = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const toISO = (date) => {
  const match = JALALI.exec(String(date || '').trim());
  return match ? persianToISO(Number(match[1]), Number(match[2]), Number(match[3])) : null;
};
const EPSILON = 0.000001;

/**
 * گردش و ماندهٔ هر کالا از فاکتورهای بکاپ (بدون دیتابیس). مبلغ‌ها به واحد فایل.
 * خروجی: `products` (کد کالا ← تعداد، ارزش، گردش‌ها) و شمارش انواع کنارگذاشته.
 */
export function parsianStockLedger(parsed) {
  const extras = parsed?.extras || {};
  const service = new Set((extras.goods || []).filter((item) => item.service).map((item) => item.code));
  const known = new Set((extras.goods || []).map((item) => item.code));
  const excluded = {};
  const lines = [];
  for (const invoice of extras.invoices || []) {
    const kind = STOCK_KINDS[invoice.title];
    if (!kind) {
      if (invoice.lines.some((line) => line.quantity)) excluded[invoice.titleName || invoice.title] = (excluded[invoice.titleName || invoice.title] || 0) + 1;
      continue;
    }
    for (const line of invoice.lines) {
      if (!(line.quantity > 0) || line.goodsCode == null || service.has(line.goodsCode)) continue;
      lines.push({ invoice, kind, line, known: known.has(line.goodsCode) });
    }
  }
  // ترتیب: تاریخ، در یک روز اول ورودها (تا خروجِ همان روز کالای رسیده را ببیند)، بعد شماره.
  lines.sort((first, second) => (first.invoice.date === second.invoice.date ? 0 : first.invoice.date < second.invoice.date ? -1 : 1)
    || second.kind.direction - first.kind.direction || first.invoice.number - second.invoice.number || first.line.id - second.line.id);

  const products = new Map();
  for (const { invoice, kind, line, known: isKnown } of lines) {
    if (!products.has(line.goodsCode)) products.set(line.goodsCode, { code: line.goodsCode, known: isKnown, quantity: 0, value: 0, movements: [], wentNegative: false });
    const product = products.get(line.goodsCode);
    const average = product.quantity > EPSILON ? product.value / product.quantity : product.movements.findLast?.((move) => move.unitCost > 0)?.unitCost || 0;
    const priced = Math.max(0, line.quantity * line.unitPrice - (kind.type === 'purchase' ? line.discount || 0 : 0));
    const value = kind.cost === 'price' ? priced : line.quantity * average;
    product.quantity += kind.direction * line.quantity;
    product.value += kind.direction * value;
    if (product.quantity < -EPSILON) product.wentNegative = true;
    if (Math.abs(product.quantity) < EPSILON) { product.quantity = 0; product.value = 0; }
    product.movements.push({
      kind: kind.type, label: kind.label, title: invoice.title, number: invoice.number, date: invoice.date, lineId: line.id,
      quantity: kind.direction * line.quantity, value: kind.direction * value, unitCost: line.quantity ? value / line.quantity : 0,
    });
  }
  return { products, excluded };
}

/**
 * گردش را در انبار حساب‌یار می‌نشاند: هر ردیف یک گردش کالا (بی‌سند) و ماندهٔ کالا با
 * بهای میانگین. اجرای دوباره چیزی را تکرار نمی‌سازد.
 */
export function importParsianStock(database, parsed, { fileUnit, ledgerUnit, inventoryChartIds = [] } = {}) {
  ensureInventorySchema(database);
  const sha = parsed?.meta?.sha256 || '';
  const result = { products: 0, movements: 0, negative: [], unknownGoods: 0, excluded: {}, value: 0, byKind: {}, control: null, warnings: [], existing: false };
  const { products, excluded } = parsianStockLedger(parsed);
  result.excluded = excluded;
  if (!products.size) return result;
  const ratio = AMOUNT_UNITS[normalizeAmountUnit(ledgerUnit)].perToman / AMOUNT_UNITS[normalizeAmountUnit(fileUnit)].perToman;
  const toLedger = (value) => Math.round(value * ratio);
  const prefix = `parsian-stock:${sha.slice(0, 16)}:`;
  if (database.prepare('SELECT 1 FROM stock_movements WHERE source_type=? AND source_id LIKE ? LIMIT 1').get('parsian_invoice', `${prefix}%`)) {
    result.existing = true;
    return result;
  }
  const goodsByCode = new Map((parsed.extras.goods || []).map((item) => [item.code, item]));
  const productByName = database.prepare('SELECT id,stock,track_inventory AS track FROM products WHERE name=? COLLATE NOCASE');
  const insert = database.prepare(`INSERT OR IGNORE INTO stock_movements
    (id,product_id,quantity,note,movement_type,unit_cost,value_delta,source_type,source_id,occurred_at)
    VALUES (?,?,?,?,?,?,?,'parsian_invoice',?,?)`);
  const update = database.prepare(`UPDATE products SET stock=?,inventory_value=?,average_cost=?,
    buy_price=CASE WHEN buy_price=0 THEN ? ELSE buy_price END,updated_at=CURRENT_TIMESTAMP WHERE id=?`);
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const product of products.values()) {
      const goods = goodsByCode.get(product.code);
      const row = goods ? productByName.get(String(goods.name).replace(/\s+/g, ' ').trim().slice(0, 100)) : null;
      if (!row) { result.unknownGoods += 1; continue; }
      if (!row.track) continue;
      // پایان منفی یعنی گردشی جا افتاده؛ تعداد حدسی نمی‌گذاریم.
      if (product.quantity < -EPSILON) { result.negative.push({ name: goods.name, quantity: product.quantity }); continue; }
      for (const move of product.movements) {
        const changes = insert.run(randomUUID(), row.id, move.quantity, `${move.label} — فاکتور ${move.number} پارسیان (${move.date})`,
          move.kind, toLedger(Math.abs(move.unitCost)), toLedger(move.value), `${prefix}${move.title}:${move.number}:${move.lineId}`, toISO(move.date)).changes;
        result.movements += changes;
        result.byKind[move.kind] = (result.byKind[move.kind] || 0) + toLedger(move.value);
      }
      const value = Math.max(0, toLedger(product.value));
      update.run(product.quantity, value, product.quantity > EPSILON ? Math.round(value / product.quantity) : 0,
        product.quantity > EPSILON ? Math.round(value / product.quantity) : 0, row.id);
      result.products += 1;
      result.value += value;
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  result.control = inventoryControl(database, result.value, inventoryChartIds);
  if (result.negative.length) {
    result.warnings.push(`گردش ${result.negative.length} کالا در فاکتورهای پارسیان به ماندهٔ منفی می‌رسد (${result.negative.slice(0, 5).map((item) => item.name).join('، ')}${result.negative.length > 5 ? '، …' : ''})؛ تعدادشان را با شمارش بگذار.`);
  }
  const skipped = Object.entries(result.excluded);
  if (skipped.length) result.warnings.push(`فاکتورهای ${skipped.map(([name, count]) => `${name} (${count})`).join('، ')} در موجودی شمرده نشدند؛ گردش مالکیت کالا نیستند یا معنایشان در این بکاپ ثابت نشده.`);
  if (result.unknownGoods) result.warnings.push(`${result.unknownGoods} کد کالا در فاکتورها هست که در فهرست کالای بکاپ نیست؛ گردششان وارد نشد.`);
  // تولید را پارسیان با بهای خودش ارزش داده و مصرفِ همان تولید را ما با میانگین؛ فاصله گفته می‌شود.
  if (result.byKind.production && result.byKind.consumption && Math.abs(result.byKind.production + result.byKind.consumption) > 0) {
    result.warnings.push(`ارزش تولید در فاکتورهای پارسیان ${result.byKind.production.toLocaleString('en-US')} است و بهای مصرف مواد به میانگین موزون ${(-result.byKind.consumption).toLocaleString('en-US')}؛ فاصله (${(result.byKind.production + result.byKind.consumption).toLocaleString('en-US')}) از روش قیمت‌گذاری تولید پارسیان است و حسابدار با فرمول تولید بسنجد.`);
  }
  if (result.control?.difference) {
    result.warnings.push(`ارزش موجودی از گردش فاکتورها ${result.value.toLocaleString('en-US')} است و ماندهٔ حساب موجودی در دفتر ${result.control.balance.toLocaleString('en-US')}؛ اختلاف ${result.control.difference.toLocaleString('en-US')}. پارسیان ادواری است و گردش کالا را تا سند بستن انبار در دفتر نمی‌آورد؛ این اختلاف را حسابدار با سند پایان دوره روشن کند.`);
  }
  return result;
}

/** ماندهٔ حساب‌های موجودی کالا و مواد در دفتر (همهٔ سندها، پیش‌نویس‌های بکاپ هم). */
export function inventoryControl(database, value, chartIds = []) {
  const ids = chartIds.length ? chartIds : database.prepare(`SELECT id FROM chart_accounts
    WHERE (name LIKE '%موجودی مواد%' OR name LIKE '%موجودي مواد%' OR name LIKE '%موجودی کالا%' OR name LIKE '%موجودي کالا%')`).all().map((row) => row.id);
  if (!ids.length) return null;
  const balance = Number(database.prepare(`SELECT COALESCE(SUM(journal_lines.debit)-SUM(journal_lines.credit),0) AS net FROM journal_lines
    JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id WHERE ledger_accounts.chart_account_id IN (${ids.map(() => '?').join(',')})`).get(...ids).net);
  return { accounts: ids.length, balance, value, difference: value - balance };
}
