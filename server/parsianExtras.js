// اطلاعات پایهٔ بکاپ پارسیان، بیرون از اسناد: کالا، کارت طرف حساب، فاکتورها و
// مشخصات شرکت.
//
// ورود اسناد (parsianImport.js) دفتر کل را می‌سازد و فاز ب (parsianPhaseB.js)
// بانک و صندوق و اشخاص را به آن وصل می‌کند. این ماژول بقیهٔ چیزهایی را می‌آورد که
// پارسیان دربارهٔ همان شرکت می‌داند تا بخش‌های حساب‌یار خالی نمانند:
//
//   - کالا با واحد و قیمت فروش. تعداد و ارزش موجودی را server/parsianStock.js از گردش
//     فاکتورها (با تولید و مصرف) می‌سازد؛ کالایی که گردشش به منفی می‌رسد را حسابدار
//     با شمارش می‌گذارد.
//   - کارت طرف حساب (تلفن، همراه، نشانی، کد اقتصادی، شناسهٔ ملی، کد پستی) کنار
//     تفصیلی همان شخص نگه داشته می‌شود و هر وقت فاز ب آن تفصیلی را شخص کرد، روی
//     کارت او می‌نشیند.
//   - فاکتورها بایگانیِ فقط‌خواندنی‌اند، هر کدام با سند پارسیانِ خودش. فاکتور
//     باز حساب‌یار نمی‌شوند: پارسیان نمی‌گوید کدام دریافت کدام فاکتور را بست، و
//     فاکتور باز در طلب‌ها شمرده می‌شود؛ طلب واقعی همان ماندهٔ دفتر کل است.
//   - مشخصات شرکت (کد اقتصادی، شناسهٔ ملی، نشانی) در تنظیمات، فقط اگر خالی باشد.
//
// قاعدهٔ ثابت: هیچ سند و هیچ مبلغی در دفتر کل ساخته یا جابه‌جا نمی‌شود، هیچ رازی
// (کلید سامانهٔ مؤدیان، رمز کاربران) خوانده نمی‌شود و اجرای دوباره چیزی را تکرار
// نمی‌سازد.

import { randomUUID } from 'node:crypto';
import { convertAmount, unitLabel } from '../shared/amountUnit.js';
import { persianToISO } from '../shared/persianDate.js';

const JALALI = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const dateToISO = (date) => {
  const match = JALALI.exec(String(date || '').trim());
  return match ? persianToISO(Number(match[1]), Number(match[2]), Number(match[3])) : null;
};

// نوع فاکتور پارسیان (tbl_FactorKind.Code) به نوع بایگانی.
const INVOICE_KINDS = { 1: 'sales', 2: 'purchase', 3: 'purchase-return', 4: 'sales-return', 5: 'opening-stock' };
export const INVOICE_KIND_LABELS = Object.freeze({
  sales: 'فاکتور فروش', purchase: 'فاکتور خرید', 'purchase-return': 'برگشت از خرید', 'sales-return': 'برگشت از فروش',
  'opening-stock': 'موجودی اول دوره', other: 'سایر',
});
// طرف حسابِ فروش در سمت بدهکار سند فاکتور است و طرف خرید در سمت بستانکار.
const PARTY_SIDE = { sales: 'bed', 'purchase-return': 'bed', purchase: 'bes', 'sales-return': 'bes' };

export function ensureParsianExtrasSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS parsian_contact_cards (
      analytic_id TEXT PRIMARY KEY, file_sha256 TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '', mobile TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
      economic_code TEXT NOT NULL DEFAULT '', national_id TEXT NOT NULL DEFAULT '', postal_code TEXT NOT NULL DEFAULT '',
      applied_contact_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS parsian_invoice_archive (
      id TEXT PRIMARY KEY, file_sha256 TEXT NOT NULL, title INTEGER NOT NULL, title_name TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL, number INTEGER NOT NULL, jalali_date TEXT NOT NULL DEFAULT '', occurred_at TEXT,
      sanad INTEGER NOT NULL DEFAULT 0, entry_id TEXT, analytic_id TEXT, counterparty_name TEXT NOT NULL DEFAULT '',
      subtotal INTEGER, gross INTEGER, amounts_exact INTEGER NOT NULL DEFAULT 1, lines TEXT NOT NULL DEFAULT '[]',
      note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(file_sha256, title, number)
    );
    CREATE INDEX IF NOT EXISTS idx_parsian_invoice_archive_kind ON parsian_invoice_archive(kind, occurred_at);
  `);
}

/** شمارش اطلاعات پایهٔ بکاپ برای پیش‌نمایش؛ هیچ چیزی نمی‌نویسد. */
export function parsianExtrasSummary(parsed) {
  const extras = parsed?.extras || {};
  const invoices = extras.invoices || [];
  const kindCount = (kind) => invoices.filter((invoice) => (INVOICE_KINDS[invoice.title] || 'other') === kind).length;
  return {
    goods: (extras.goods || []).length,
    cards: (extras.cards || []).filter((card) => card.taf > 0).length,
    unlinkedCards: (extras.cards || []).filter((card) => !(card.taf > 0)).length,
    salesInvoices: kindCount('sales'),
    purchaseInvoices: kindCount('purchase'),
    otherInvoices: invoices.length - kindCount('sales') - kindCount('purchase'),
    company: Boolean(extras.company && (extras.company.economicCode || extras.company.nationalId || extras.company.address)),
  };
}

const clean = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// «۰» در پارسیان یعنی خالی، نه کد.
const code = (value) => { const text = clean(value, 30); return /^0*$/.test(text) ? '' : text; };

/**
 * ورود اطلاعات پایه پس از ورود اسناد، در یک تراکنش. خطای این بخش اسناد را
 * برنمی‌گرداند؛ فراخوان آن را هشدار می‌کند.
 */
export function importParsianExtras(database, parsed, {
  fileUnit, ledgerUnit, analyticIdByKey = new Map(), designated = [], createdBy = null,
} = {}) {
  ensureParsianExtrasSchema(database);
  const extras = parsed?.extras || {};
  const sha = parsed?.meta?.sha256 || '';
  const result = { products: { created: 0, existing: 0, withoutPrice: 0 }, cards: { stored: 0, unlinked: 0 },
    invoices: { archived: 0, existing: 0, inexact: 0, byKind: {} }, company: false, warnings: [] };
  const toLedger = (amount) => convertAmount(Math.round(Number(amount) || 0), fileUnit, ledgerUnit);
  const goodsByCode = new Map((extras.goods || []).map((item) => [item.code, item]));

  database.exec('BEGIN IMMEDIATE');
  try {
    // --- کالا ---
    const existingProduct = database.prepare('SELECT id FROM products WHERE name=? COLLATE NOCASE');
    const insertProduct = database.prepare(`INSERT INTO products (id,name,stock,unit,low_threshold,buy_price,sale_price,average_cost,inventory_value,track_inventory)
      VALUES (?,?,0,?,0,0,?,0,0,?)`);
    for (const item of extras.goods || []) {
      const name = clean(item.name, 100);
      if (!name) continue;
      if (existingProduct.get(name)) { result.products.existing += 1; continue; }
      const price = item.price > 0 ? toLedger(item.price) : 0;
      if (item.price > 0 && price == null) result.products.withoutPrice += 1;
      insertProduct.run(randomUUID(), name, clean(item.unit, 30) || 'عدد', price || 0, item.service ? 0 : 1);
      result.products.created += 1;
    }
    if (result.products.withoutPrice) {
      result.warnings.push(`قیمت ${result.products.withoutPrice} کالا به ${unitLabel(fileUnit)} است و در دفتر ${unitLabel(ledgerUnit)}ی به عدد صحیح درنمی‌آید؛ قیمتشان خالی ماند.`);
    }

    // --- کارت طرف حساب، کنار تفصیلیِ همان شخص ---
    const storeCard = database.prepare(`INSERT INTO parsian_contact_cards (analytic_id,file_sha256,name,phone,mobile,address,economic_code,national_id,postal_code)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(analytic_id) DO NOTHING`);
    for (const card of extras.cards || []) {
      const analyticId = card.taf > 0 ? analyticIdByKey.get(`${card.kol}:${card.moeen}:${card.taf}`) : null;
      if (!analyticId) { result.cards.unlinked += 1; continue; }
      const stored = storeCard.run(analyticId, sha, clean(card.name, 120), clean(card.tel, 40), clean(card.mobile, 40), clean(card.address, 300),
        code(card.economicCode), code(card.nationalId), code(card.postalCode));
      result.cards.stored += Number(stored.changes || 0);
    }

    // --- بایگانی فاکتورها ---
    const entryBySanad = new Map(database.prepare('SELECT sanad,entry_id AS entryId FROM parsian_imported_entries WHERE file_sha256=?').all(sha)
      .map((row) => [row.sanad, row.entryId]));
    const vatKeys = new Set(designated.filter((item) => /^VAT/.test(item.key)).map((item) => `${item.kol}:${item.moeen}:${item.taf}`));
    const rowsByVoucher = new Map();
    for (const row of parsed?.documents?.rows || []) {
      if (!rowsByVoucher.has(row.sanad)) rowsByVoucher.set(row.sanad, []);
      rowsByVoucher.get(row.sanad).push(row);
    }
    const analyticName = database.prepare('SELECT name FROM analytic_accounts WHERE id=?');
    const archive = database.prepare(`INSERT INTO parsian_invoice_archive (id,file_sha256,title,title_name,kind,number,jalali_date,occurred_at,sanad,entry_id,
      analytic_id,counterparty_name,subtotal,gross,amounts_exact,lines,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(file_sha256,title,number) DO NOTHING`);
    for (const invoice of extras.invoices || []) {
      const kind = INVOICE_KINDS[invoice.title] || 'other';
      let exact = true;
      const lines = invoice.lines.filter((line) => line.quantity || line.unitPrice).map((line) => {
        const goods = goodsByCode.get(line.goodsCode);
        const unitPrice = toLedger(line.unitPrice);
        const total = toLedger(line.quantity * line.unitPrice - line.discount);
        if (unitPrice == null || total == null) exact = false;
        return { title: clean(goods?.name || line.comment || `کالای ${line.goodsCode ?? ''}`, 120), goodsCode: line.goodsCode,
          unit: clean(goods?.unit, 30), quantity: line.quantity, unitPrice, discount: toLedger(line.discount), total };
      });
      if (!lines.length && kind === 'opening-stock') continue; // فقط ردیف‌های صفر: چیزی برای بایگانی نیست
      // طرف حساب و مبلغ با مالیات از ردیف همان فاکتور در سند خودش؛ ردیف ارزش افزوده طرف حساب نیست.
      const side = PARTY_SIDE[kind];
      const partyRow = side ? (rowsByVoucher.get(invoice.sanad) || []).find((row) => row.factor === invoice.number && row.taf > 0
        && row[side] > 0 && !vatKeys.has(`${row.kol}:${row.moeen}:${row.taf}`)) : null;
      const analyticId = partyRow ? analyticIdByKey.get(`${partyRow.kol}:${partyRow.moeen}:${partyRow.taf}`) || null : null;
      const gross = partyRow ? toLedger(partyRow[side]) : null;
      if (partyRow && gross == null) exact = false;
      const subtotal = lines.every((line) => line.total != null) ? lines.reduce((sum, line) => sum + line.total, 0) : null;
      if (!exact) result.invoices.inexact += 1;
      const saved = archive.run(randomUUID(), sha, invoice.title, clean(invoice.titleName, 60) || INVOICE_KIND_LABELS[kind], kind, invoice.number,
        clean(invoice.date, 10), dateToISO(invoice.date), invoice.sanad || 0, entryBySanad.get(invoice.sanad) || null, analyticId,
        analyticId ? clean(analyticName.get(analyticId)?.name, 120) : '', subtotal, gross, exact ? 1 : 0, JSON.stringify(lines), clean(invoice.comment, 300));
      if (saved.changes) {
        result.invoices.archived += 1;
        result.invoices.byKind[kind] = (result.invoices.byKind[kind] || 0) + 1;
      } else result.invoices.existing += 1;
    }
    if (result.invoices.inexact) {
      result.warnings.push(`مبلغ ${result.invoices.inexact} فاکتور در دفتر ${unitLabel(ledgerUnit)}ی دقیق درنمی‌آمد؛ آن مبلغ‌ها خالی ماندند و سند پارسیانِ همان فاکتور مرجع است.`);
    }

    // --- مشخصات شرکت، فقط اگر هنوز نگذاشته‌اند ---
    const company = extras.company;
    if (company && (code(company.economicCode) || code(company.nationalId) || clean(company.address))) {
      const profile = { economicCode: code(company.economicCode), nationalId: code(company.nationalId), postalCode: code(company.postalCode),
        address: clean(company.address, 300), phone: clean(company.phone, 40), province: clean(company.province, 60), city: clean(company.city, 60),
        source: 'parsian-backup' };
      result.company = Boolean(database.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').run('companyProfile', JSON.stringify(profile)).changes);
    }
    database.prepare(`INSERT INTO audit_log (id,action,entity_type,entity_id,payload) VALUES (?,?,?,?,?)`)
      .run(randomUUID(), 'import', 'parsian_extras', sha.slice(0, 64) || 'parsian', JSON.stringify({ ...result, warnings: undefined, createdBy }));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return result;
}

/**
 * کارت پارسیانِ تفصیلی‌هایی که فاز ب به یک شخص وصل کرد، روی همان شخص. تلفن فقط
 * وقتی پر می‌شود که خالی باشد؛ نشانی و کدها یک‌بار به یادداشت اضافه می‌شوند.
 */
export function applyParsianCards(database, contactId, analyticIds = []) {
  ensureParsianExtrasSchema(database);
  if (!contactId || !analyticIds.length) return 0;
  const cards = database.prepare(`SELECT * FROM parsian_contact_cards WHERE analytic_id IN (${analyticIds.map(() => '?').join(',')})`).all(...analyticIds);
  if (!cards.length) return 0;
  const contact = database.prepare('SELECT phone,note FROM contacts WHERE id=?').get(contactId);
  if (!contact) return 0;
  const phone = contact.phone || cards.map((card) => card.mobile || card.phone).find(Boolean) || '';
  const details = [];
  for (const card of cards) {
    const parts = [
      card.mobile && card.phone && card.mobile !== phone ? `همراه ${card.mobile}` : '',
      card.phone && card.phone !== phone ? `تلفن ${card.phone}` : '',
      card.economic_code ? `کد اقتصادی ${card.economic_code}` : '',
      card.national_id ? `شناسهٔ ملی ${card.national_id}` : '',
      card.postal_code ? `کد پستی ${card.postal_code}` : '',
      card.address ? `نشانی: ${card.address}` : '',
    ].filter(Boolean);
    if (parts.length) details.push(parts.join(' — '));
  }
  const marker = 'از کارت پارسیان:';
  const note = details.length && !String(contact.note || '').includes(marker)
    ? [contact.note, `${marker} ${details.join(' | ')}`].filter(Boolean).join('\n').slice(0, 1000)
    : contact.note;
  database.prepare('UPDATE contacts SET phone=?,note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(phone.slice(0, 40), note || '', contactId);
  database.prepare(`UPDATE parsian_contact_cards SET applied_contact_id=? WHERE analytic_id IN (${analyticIds.map(() => '?').join(',')})`).run(contactId, ...analyticIds);
  return cards.length;
}

/** بایگانی فاکتورهای پارسیان برای صفحهٔ فاکتورها؛ نام طرف حساب از شخصِ وصل‌شده. */
export function listParsianInvoiceArchive(database, { kind = '', limit = 300 } = {}) {
  ensureParsianExtrasSchema(database);
  const rows = database.prepare(`SELECT archive.id,archive.kind,archive.title_name AS titleName,archive.number,archive.jalali_date AS jalaliDate,
      archive.occurred_at AS occurredAt,archive.sanad,archive.entry_id AS entryId,archive.subtotal,archive.gross,archive.amounts_exact AS amountsExact,
      archive.lines,archive.note,COALESCE(contacts.name,archive.counterparty_name) AS counterpartyName,contacts.id AS contactId
    FROM parsian_invoice_archive archive
    LEFT JOIN analytic_accounts analytic ON analytic.id=archive.analytic_id
    LEFT JOIN contacts ON analytic.source_kind='contact' AND contacts.id=analytic.source_key
    ${kind ? 'WHERE archive.kind=?' : ''}
    ORDER BY archive.occurred_at DESC,archive.number DESC LIMIT ?`).all(...(kind ? [kind, limit] : [limit]));
  const items = rows.map((row) => ({ ...row, amountsExact: Boolean(row.amountsExact), lines: JSON.parse(row.lines || '[]'), kindLabel: INVOICE_KIND_LABELS[row.kind] || row.titleName }));
  const totals = database.prepare(`SELECT kind,COUNT(*) AS count,COALESCE(SUM(gross),0) AS gross FROM parsian_invoice_archive GROUP BY kind`).all();
  return { items, totals };
}

/** فروش هر کالا در بایگانی فاکتورها، برای DNA (کالاهای اصلی فروش). */
export function archivedSalesByProduct(database) {
  try {
    const sales = new Map();
    for (const row of database.prepare("SELECT lines FROM parsian_invoice_archive WHERE kind='sales'").all()) {
      for (const line of JSON.parse(row.lines || '[]')) {
        if (!(line.total > 0)) continue;
        sales.set(line.title, (sales.get(line.title) || 0) + line.total);
      }
    }
    return [...sales].map(([product, amount]) => ({ product, amount }));
  } catch { return []; }
}
