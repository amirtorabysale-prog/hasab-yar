import { randomUUID } from 'node:crypto';

function taxError(message, code = 'TAX_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function ensureColumn(database, table, definition) {
  try { database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`); }
  catch (error) { if (!/duplicate column name/i.test(error.message)) throw error; }
}

export function ensureTaxSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tax_rates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(rate_bps>=0 AND rate_bps<=10000),
      treatment TEXT NOT NULL DEFAULT 'exempt' CHECK(treatment IN ('taxable','zero','exempt')),
      active INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  ensureColumn(database, 'invoices', "tax_calculation TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(database, 'invoice_items', 'tax_rate_id TEXT REFERENCES tax_rates(id) ON DELETE SET NULL');
  ensureColumn(database, 'invoice_items', 'tax_rate_bps INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'invoice_items', "tax_treatment TEXT NOT NULL DEFAULT 'exempt'");
  ensureColumn(database, 'invoice_items', 'tax_base INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'invoice_items', 'tax_amount INTEGER NOT NULL DEFAULT 0');
  database.prepare(`INSERT OR IGNORE INTO tax_rates (id,name,rate_bps,treatment,active,is_default)
    VALUES ('tax-none','بدون مالیات / معاف',0,'exempt',1,1)`).run();
  database.prepare(`UPDATE invoice_items SET tax_base=total WHERE tax_base=0 AND invoice_id IN
    (SELECT id FROM invoices WHERE tax_calculation IN ('none','manual'))`).run();
  database.prepare("UPDATE invoices SET tax_calculation=CASE WHEN tax>0 THEN 'manual' ELSE 'none' END WHERE tax_calculation='none'").run();
}

export function listTaxRates(database, { includeInactive = true } = {}) {
  ensureTaxSchema(database);
  const where = includeInactive ? '' : 'WHERE active=1';
  return database.prepare(`SELECT id,name,rate_bps AS rateBps,rate_bps/100.0 AS rate,treatment,active,is_default AS isDefault,
    created_at AS createdAt,updated_at AS updatedAt FROM tax_rates ${where} ORDER BY is_default DESC,active DESC,rate_bps,name`).all();
}

export function saveTaxRate(database, values = {}) {
  ensureTaxSchema(database);
  if (values.id === 'tax-none') throw taxError('نرخ سیستمی «بدون مالیات» قابل ویرایش نیست.', 'TAX_SYSTEM_RATE', 409);
  const name = String(values.name || '').trim().slice(0, 100);
  if (name.length < 2) throw taxError('نام نرخ مالیاتی باید حداقل دو نویسه باشد.');
  const treatment = ['taxable', 'zero', 'exempt'].includes(values.treatment) ? values.treatment : 'taxable';
  const rate = Number(values.rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw taxError('نرخ مالیات باید بین صفر تا صد درصد باشد.');
  const rateBps = Math.round(rate * 100);
  if (treatment !== 'taxable' && rateBps !== 0) throw taxError('نرخ صفر و معاف باید درصد صفر داشته باشند.');
  if (treatment === 'taxable' && rateBps === 0) throw taxError('برای نرخ مشمول، درصدی بیشتر از صفر وارد کن.');
  const id = values.id || randomUUID();
  const current = values.id ? database.prepare('SELECT id,is_default AS isDefault FROM tax_rates WHERE id=?').get(id) : null;
  if (values.id && !current) throw taxError('نرخ مالیاتی پیدا نشد.', 'TAX_RATE_MISSING', 404);
  const active = values.active === false ? 0 : 1;
  const isDefault = active && values.isDefault ? 1 : 0;
  database.exec('BEGIN IMMEDIATE');
  try {
    if (isDefault) database.prepare('UPDATE tax_rates SET is_default=0').run();
    if (current) database.prepare(`UPDATE tax_rates SET name=?,rate_bps=?,treatment=?,active=?,is_default=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(name, rateBps, treatment, active, isDefault, id);
    else database.prepare('INSERT INTO tax_rates (id,name,rate_bps,treatment,active,is_default) VALUES (?,?,?,?,?,?)')
      .run(id, name, rateBps, treatment, active, isDefault);
    if (!database.prepare('SELECT 1 FROM tax_rates WHERE active=1 AND is_default=1').get()) {
      database.prepare("UPDATE tax_rates SET is_default=1 WHERE id=(SELECT id FROM tax_rates WHERE active=1 ORDER BY CASE WHEN id='tax-none' THEN 0 ELSE 1 END,created_at LIMIT 1)").run();
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    if (/UNIQUE constraint failed: tax_rates\.name/i.test(error.message)) throw taxError('نرخی با این نام قبلاً ثبت شده است.', 'TAX_RATE_DUPLICATE', 409);
    throw error;
  }
  return listTaxRates(database).find((item) => item.id === id);
}

export function calculateInvoiceTax(database, items, discount = 0, manualTax = 0) {
  ensureTaxSchema(database);
  const subtotal = items.reduce((sum, item) => sum + Number(item.total), 0);
  let allocatedDiscount = 0;
  const explicit = items.some((item) => item.taxRateId);
  const normalized = items.map((item, index) => {
    const remainingDiscount = Math.max(0, Number(discount) - allocatedDiscount);
    const proportionalDiscount = subtotal > 0 ? Math.round(Number(discount) * (Number(item.total) / subtotal)) : 0;
    const lineDiscount = index === items.length - 1 ? remainingDiscount : Math.min(remainingDiscount, proportionalDiscount);
    allocatedDiscount += lineDiscount;
    const taxBase = Math.max(0, Number(item.total) - lineDiscount);
    const rate = item.taxRateId ? database.prepare('SELECT * FROM tax_rates WHERE id=? AND active=1').get(item.taxRateId) : null;
    if (item.taxRateId && !rate) throw taxError('یکی از نرخ‌های مالیاتی انتخاب‌شده معتبر یا فعال نیست.', 'TAX_RATE_MISSING', 404);
    const taxRateBps = Number(rate?.rate_bps || 0);
    const taxTreatment = rate?.treatment || 'exempt';
    const taxAmount = taxTreatment === 'taxable' ? Math.round(taxBase * taxRateBps / 10000) : 0;
    return { ...item, lineDiscount, taxBase, taxRateId: rate?.id || null, taxRateBps, taxTreatment, taxAmount };
  });
  if (explicit) return { items: normalized, tax: normalized.reduce((sum, item) => sum + item.taxAmount, 0), taxCalculation: 'line' };
  const legacyTax = Math.max(0, Math.round(Number(manualTax) || 0));
  if (!Number.isSafeInteger(legacyTax) || legacyTax > 999_999_999_999) throw taxError('مبلغ مالیات دستی معتبر نیست.');
  return { items: normalized, tax: legacyTax, taxCalculation: legacyTax ? 'manual' : 'none' };
}

export function taxReport(database, { from, to } = {}) {
  ensureTaxSchema(database);
  const fromDate = from ? new Date(from) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const toDate = to ? new Date(to) : new Date();
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate >= toDate) throw taxError('بازهٔ گزارش مالیاتی معتبر نیست.');
  const start = fromDate.toISOString();
  const end = toDate.toISOString();
  const invoices = database.prepare(`SELECT id,number,document_type AS documentType,subtotal,discount,tax,total,
    tax_calculation AS taxCalculation,issued_at AS issuedAt,customer_name AS customerName
    FROM invoices WHERE status NOT IN ('draft','cancelled') AND issued_at>=? AND issued_at<? ORDER BY issued_at DESC`).all(start, end);
  const itemQuery = database.prepare(`SELECT tax_base AS taxBase,tax_amount AS taxAmount,tax_treatment AS taxTreatment
    FROM invoice_items WHERE invoice_id=?`);
  const summary = { outputTax: 0, inputTax: 0, netTax: 0, taxableSales: 0, taxablePurchases: 0, zeroSales: 0, exemptSales: 0, manualTax: 0, salesTotal: 0, purchaseTotal: 0 };
  const rows = invoices.map((invoice) => {
    const items = itemQuery.all(invoice.id);
    const allocatedTax = items.reduce((sum, item) => sum + Number(item.taxAmount), 0);
    const manual = Math.max(0, Number(invoice.tax) - allocatedTax);
    if (invoice.documentType === 'sales') {
      summary.outputTax += Number(invoice.tax); summary.salesTotal += Number(invoice.total);
      summary.taxableSales += items.filter((item) => item.taxTreatment === 'taxable').reduce((sum, item) => sum + Number(item.taxBase), 0);
      summary.zeroSales += items.filter((item) => item.taxTreatment === 'zero').reduce((sum, item) => sum + Number(item.taxBase), 0);
      summary.exemptSales += items.filter((item) => item.taxTreatment === 'exempt').reduce((sum, item) => sum + Number(item.taxBase), 0);
    } else {
      summary.inputTax += Number(invoice.tax); summary.purchaseTotal += Number(invoice.total);
      summary.taxablePurchases += items.filter((item) => item.taxTreatment === 'taxable').reduce((sum, item) => sum + Number(item.taxBase), 0);
    }
    summary.manualTax += manual;
    return { ...invoice, manualTax: manual };
  });
  summary.netTax = summary.outputTax - summary.inputTax;
  return { from: start, to: end, summary, rows, rates: listTaxRates(database), disclaimer: 'این گزارش مدیریتی است و اظهارنامه یا صورتحساب الکترونیکی رسمی محسوب نمی‌شود.' };
}
