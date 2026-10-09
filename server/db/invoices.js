import { randomUUID } from 'node:crypto';
import { applyInvoiceInventory, reverseInvoiceInventory } from '../inventory.js';
import { assertAccountingPeriodOpen, periodForDate, postInvoiceJournal, postInvoicePaymentJournal, reverseInvoiceJournal } from '../accounting.js';
import { audit, cleanAmount, currentTimeZone, currentWorkspace, db, invalidInput } from './core.js';
import { calculateInvoiceTax } from '../tax.js';
import { contactIdForName } from './contacts.js';
import { insertTransactionRows } from './transactions.js';
import { resolveAccountId } from './accounts.js';

function invoiceRows({ status = '', documentType = '' } = {}) {
  const clauses = [];
  const params = [];
  if (['draft', 'sent', 'paid', 'cancelled'].includes(status)) { clauses.push('invoices.status=?'); params.push(status); }
  if (['sales', 'purchase'].includes(documentType)) { clauses.push('invoices.document_type=?'); params.push(documentType); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT invoices.id,invoices.number,invoices.contact_id AS contactId,invoices.customer_name AS customerName,
    invoices.document_type AS documentType,invoices.category,invoices.subtotal,invoices.discount,invoices.tax,invoices.total,
    invoices.tax_calculation AS taxCalculation,invoices.status,invoices.due_at AS dueAt,invoices.issued_at AS issuedAt,invoices.posted_at AS postedAt,invoices.note,
    invoices.created_at AS createdAt,contacts.name AS contactName,COALESCE(SUM(invoice_payments.amount),0) AS paidAmount
    FROM invoices LEFT JOIN contacts ON contacts.id=invoices.contact_id
    LEFT JOIN invoice_payments ON invoice_payments.invoice_id=invoices.id ${where}
    GROUP BY invoices.id ORDER BY invoices.created_at DESC`).all(...params).map((invoice) => {
      const balanceDue = Math.max(0, Number(invoice.total) - Number(invoice.paidAmount));
      const overdue = Boolean(invoice.dueAt && new Date(invoice.dueAt) < new Date() && balanceDue > 0 && invoice.status !== 'draft' && invoice.status !== 'cancelled');
      const displayStatus = invoice.status === 'cancelled' ? 'cancelled' : invoice.status === 'draft' ? 'draft' : balanceDue === 0 ? 'paid' : Number(invoice.paidAmount) > 0 ? 'partial' : overdue ? 'overdue' : 'open';
      return { ...invoice, balanceDue, overdue, displayStatus };
    });
}

export function listInvoices(filters = {}) {
  const items = invoiceRows(filters);
  const open = items.filter((item) => !['draft', 'cancelled', 'paid'].includes(item.displayStatus));
  return {
    items,
    summary: {
      receivable: open.filter((item) => item.documentType === 'sales').reduce((sum, item) => sum + item.balanceDue, 0),
      payable: open.filter((item) => item.documentType === 'purchase').reduce((sum, item) => sum + item.balanceDue, 0),
      overdueReceivable: open.filter((item) => item.documentType === 'sales' && item.overdue).reduce((sum, item) => sum + item.balanceDue, 0),
      overduePayable: open.filter((item) => item.documentType === 'purchase' && item.overdue).reduce((sum, item) => sum + item.balanceDue, 0),
    },
  };
}

export function getInvoice(id) {
  const invoice = invoiceRows().find((item) => item.id === id);
  if (!invoice) return null;
  invoice.items = db.prepare(`SELECT id,title,quantity,unit_price AS unitPrice,total,product_id AS productId,
    inventory_cost AS inventoryCost,tax_rate_id AS taxRateId,tax_rate_bps AS taxRateBps,tax_treatment AS taxTreatment,
    tax_base AS taxBase,tax_amount AS taxAmount FROM invoice_items WHERE invoice_id=? ORDER BY rowid`).all(id);
  invoice.payments = db.prepare(`SELECT invoice_payments.id,invoice_payments.amount,invoice_payments.account_id AS accountId,
    accounts.name AS accountName,invoice_payments.occurred_at AS occurredAt,invoice_payments.note,invoice_payments.created_at AS createdAt
    FROM invoice_payments JOIN accounts ON accounts.id=invoice_payments.account_id WHERE invoice_payments.invoice_id=?
    ORDER BY invoice_payments.occurred_at DESC`).all(id);
  return invoice;
}

export function createInvoice(values = {}) {
  const items = Array.isArray(values.items) ? values.items.filter((item) => String(item.title || '').trim()) : [];
  if (!items.length) throw invalidInput('حداقل یک ردیف برای سند لازم است.');
  const normalized = items.map((item) => {
    const quantity = Math.max(0.01, Number(item.quantity) || 1);
    const unitPrice = cleanAmount(item.unitPrice);
    const product = item.productId ? db.prepare('SELECT id,name,track_inventory AS trackInventory FROM products WHERE id=?').get(item.productId) : null;
    if (item.productId && (!product || !product.trackInventory)) throw Object.assign(new Error('کالای انتخاب‌شده پیدا نشد.'), { code: 'INVOICE_PRODUCT_MISSING', status: 404 });
    return { title: String(item.title).trim().slice(0, 120), quantity, unitPrice, total: Math.round(quantity * unitPrice), productId: product?.id || null, taxRateId: item.taxRateId || null, inventoryCost: 0 };
  });
  const subtotal = normalized.reduce((sum, item) => sum + item.total, 0);
  const discount = Math.min(subtotal, Math.max(0, Math.round(Number(values.discount) || 0)));
  const taxResult = calculateInvoiceTax(db, normalized, discount, values.tax);
  const tax = taxResult.tax;
  const total = subtotal - discount + tax;
  if (total <= 0) throw invalidInput('مبلغ نهایی سند باید بیشتر از صفر باشد.');
  const documentType = values.documentType === 'purchase' ? 'purchase' : 'sales';
  const taxedItems = taxResult.items.map((item) => {
    if (documentType === 'purchase' && item.productId) item.inventoryCost = item.taxBase;
    return item;
  });
  const category = String(values.category || (documentType === 'purchase' ? 'مواد و کالا' : 'فروش')).trim().slice(0, 80);
  const issueNow = values.issueNow === true || values.status === 'sent';
  const issuedAt = issueNow ? (values.issuedAt || new Date().toISOString()) : null;
  if (issuedAt) assertAccountingPeriodOpen(db, periodForDate(issuedAt, currentTimeZone()));
  const id = randomUUID();
  const year = new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: currentTimeZone(), year: 'numeric' }).format(new Date());
  const count = db.prepare('SELECT COUNT(*) AS count FROM invoices').get().count + 1;
  const number = `${documentType === 'purchase' ? 'KH' : 'FR'}-${year}-${String(count).padStart(4, '0')}`;
  const contact = values.contactId
    ? db.prepare('SELECT id,name FROM contacts WHERE id=?').get(values.contactId)
    : (values.customerName ? db.prepare('SELECT id,name FROM contacts WHERE id=?').get(contactIdForName(values.customerName, values.counterpartyResolution)) : null);
  const counterpartyName = String(contact?.name || values.customerName || (documentType === 'purchase' ? 'تأمین‌کننده' : 'مشتری')).trim().slice(0, 100);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO invoices
      (id,number,contact_id,customer_name,document_type,category,subtotal,discount,tax,total,tax_calculation,status,due_at,issued_at,posted_at,note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, number, contact?.id || null, counterpartyName, documentType, category, subtotal, discount, tax, total, taxResult.taxCalculation, issueNow ? 'sent' : 'draft', values.dueAt || null, issuedAt, issueNow ? issuedAt : null, String(values.note || '').slice(0, 500));
    const insert = db.prepare(`INSERT INTO invoice_items
      (id,invoice_id,title,quantity,unit_price,total,product_id,inventory_cost,tax_rate_id,tax_rate_bps,tax_treatment,tax_base,tax_amount)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const item of taxedItems) insert.run(randomUUID(), id, item.title, item.quantity, item.unitPrice, item.total, item.productId, item.inventoryCost,
      item.taxRateId, item.taxRateBps, item.taxTreatment, item.taxBase, item.taxAmount);
    if (issueNow) {
      const posted = getInvoice(id);
      applyInvoiceInventory(db, posted, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
      postInvoiceJournal(db, posted, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    }
    audit('create', 'invoice', id, { number, total, documentType, issueNow });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getInvoice(id);
}

export function issueInvoice(id, { issuedAt } = {}) {
  const invoice = getInvoice(id);
  if (!invoice) return null;
  if (invoice.status !== 'draft') return invoice;
  const occurredAt = issuedAt || new Date().toISOString();
  assertAccountingPeriodOpen(db, periodForDate(occurredAt, currentTimeZone()));
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE invoices SET status='sent',issued_at=?,posted_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='draft'").run(occurredAt, occurredAt, id);
    const posted = getInvoice(id);
    applyInvoiceInventory(db, posted, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    postInvoiceJournal(db, posted, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    audit('issue', 'invoice', id, { issuedAt: occurredAt });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getInvoice(id);
}

// `withinTransaction`: فراخوانی که خودش تراکنش باز کرده (ثبتِ همه‌یا‌هیچِ پروندهٔ
// فهم رویداد)، تراکنش تودرتو نمی‌سازد؛ SQLite آن را نمی‌پذیرد.
export function recordInvoicePayment(id, { amount, occurredAt, account = 'cash', accountId, note = '', withinTransaction = false } = {}) {
  let invoice = getInvoice(id);
  if (!invoice || ['draft', 'cancelled'].includes(invoice.status)) return null;
  const paymentAmount = cleanAmount(amount == null ? invoice.balanceDue : amount);
  if (paymentAmount > invoice.balanceDue) throw Object.assign(new Error('مبلغ تسویه از ماندهٔ سند بیشتر است.'), { code: 'INVOICE_OVERPAYMENT', status: 409 });
  const paymentAt = occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(db, periodForDate(paymentAt, currentTimeZone()));
  const resolvedAccountId = resolveAccountId({ account, accountId });
  const paymentId = randomUUID();
  if (!withinTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const [transactionId] = insertTransactionRows({ transcript: `${invoice.documentType === 'purchase' ? 'پرداخت' : 'وصول'} ${invoice.number}`, transactions: [{
      clientId: `invoice-payment:${paymentId}`, amount: paymentAmount, type: invoice.documentType === 'purchase' ? 'expense' : 'income',
      category: invoice.documentType === 'purchase' ? 'پرداخت حساب پرداختنی' : 'وصول حساب دریافتنی',
      rawText: `${invoice.documentType === 'purchase' ? 'پرداخت' : 'وصول'} ${invoice.number}`, source: 'text', contactId: invoice.contactId,
      occurredAt: paymentAt, accountId: resolvedAccountId, note, status: 'allocated', journalManaged: true,
    }] });
    db.prepare(`INSERT INTO invoice_payments (id,invoice_id,amount,account_id,transaction_id,occurred_at,note,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(paymentId, id, paymentAmount, resolvedAccountId, transactionId, paymentAt, String(note || '').slice(0, 500), currentWorkspace()?.userId || null);
    postInvoicePaymentJournal(db, invoice, { id: paymentId, amount: paymentAmount, accountId: resolvedAccountId, occurredAt: paymentAt }, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    invoice = getInvoice(id);
    if (invoice.balanceDue === 0) db.prepare("UPDATE invoices SET status='paid',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    audit('payment', 'invoice', id, { paymentId, amount: paymentAmount, transactionId });
    if (!withinTransaction) db.exec('COMMIT');
  } catch (error) { if (!withinTransaction) db.exec('ROLLBACK'); throw error; }
  return getInvoice(id);
}

export function markInvoicePaid(id, values = {}) {
  let invoice = getInvoice(id);
  if (!invoice || invoice.status === 'cancelled') return invoice;
  if (invoice.status === 'paid') return invoice;
  if (invoice.status === 'draft') invoice = issueInvoice(id, { issuedAt: values.occurredAt });
  return recordInvoicePayment(id, { ...values, amount: invoice.balanceDue });
}

export function deleteInvoice(id) {
  const invoice = getInvoice(id);
  if (!invoice || invoice.status === 'cancelled' || invoice.paidAmount > 0) return false;
  const occurredAt = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (invoice.postedAt) {
      reverseInvoiceInventory(db, invoice, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
      reverseInvoiceJournal(db, invoice, occurredAt, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    }
    const result = db.prepare("UPDATE invoices SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    if (!result.changes) throw invalidInput('سند قابل ابطال نیست.');
    audit('cancel', 'invoice', id, { reversal: Boolean(invoice.postedAt) });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return true;
}
