import { randomUUID } from 'node:crypto';
import { applyInvoiceInventory, reverseInvoiceInventory } from '../inventory.js';
import { assertAccountingPeriodOpen, periodForDate, postInvoiceJournal, postInvoicePaymentJournal, reverseInvoiceJournal, reverseJournalEntry } from '../accounting.js';
import { activeWorkspaceDatabase, audit, cleanAmount, currentTimeZone, currentWorkspace, db, invalidInput } from './core.js';
import { calculateInvoiceTax } from '../tax.js';
import { contactIdForName } from './contacts.js';
import { insertTransactionRows } from './transactions.js';
import { resolveAccountId } from './accounts.js';
import { ensureFinancialEventSchema, recordFinancialEvent } from '../financialEventStore.js';
import { resolveEventAnalytic, resolveEventRole } from '../roleResolver.js';
import { EVENT_KINDS, normalizeFinancialEvent } from '../../shared/financialEvent.js';
import { DECISION_STATUS } from '../../shared/accountingDecision.js';
import { ROUTES } from '../../shared/confidenceEngine.js';
import { ROLES } from '../../shared/accountingRules.js';
import { ENGINE_POSTED_TREATMENTS, documentServiceDecision, isTimeBoundCategory, readDocumentService } from '../../shared/documentService.js';

/**
 * ردیف خدمت دوره‌دار در فاکتور — همان موتوری که پرداخت نقدی، چک و طلب/بدهی را
 * تصمیم می‌گیرد.
 *
 * تا امروز صدور فاکتور کل مبلغ هر ردیف غیرکالایی را همان روز به حساب دستهٔ
 * فاکتور می‌برد: «حق بیمه آتش‌سوزی یکسالهٔ انبار» در فاکتور خرید دوازده ماه
 * هزینهٔ مهر می‌شد و «اشتراک دوازده‌ماهه» در فاکتور فروش دوازده ماه درآمد مهر؛
 * درحالی‌که همان جمله با پرداخت نقدی پیش‌پرداخت با شناسایی ماهانه بود. حالا هر
 * ردیف خدمت با دسته و دورهٔ پوششِ خودش به موتور می‌رود:
 *
 * - دورهٔ آینده → پیش‌پرداخت (خرید) یا درآمد انتقالی (فروش) در همان سند صدور،
 *   با رویداد ثبت‌شده و برنامهٔ شناسایی ماهانه که جمعش دقیقاً مبلغ ردیف است؛
 * - دورهٔ گذشته یا همین ماه → همان هزینه یا درآمد دستهٔ فاکتور، مثل قبل؛
 * - دورهٔ نامعلوم یا ودیعه → صدور نمی‌شود و سؤال برمی‌گردد (۴۰۹)، نه هزینه یا
 *   درآمد حدسی. فاکتوری که «همین حالا صادر کن» خواسته بود پیش‌نویس می‌ماند.
 *
 * حساب طرف، مالیات و موجودی عوض نمی‌شوند: تاریخ فاکتور نقطهٔ تعهد و مالیات است،
 * نه تاریخ شناسایی هزینه یا درآمد.
 */
const GENERIC_CATEGORY = Object.freeze({ purchase: 'مواد و کالا', sales: 'فروش' });
// نام خدمتی که بی‌دوره هم خدمت دوره‌دار است. «سرور» یا «دامنه» بی‌دوره ممکن است
// خرید سخت‌افزار باشد؛ فقط وقتی دوره‌ای گفته شده باشد خدمت حساب می‌شوند.
const SERVICE_WITHOUT_PERIOD = new Set(['اجاره', 'بیمه', 'درآمد اجاره']);

const serviceColumnsChecked = new WeakSet();
function ensureInvoiceServiceColumns() {
  const database = activeWorkspaceDatabase();
  if (serviceColumnsChecked.has(database)) return;
  const columns = new Set(database.prepare('PRAGMA table_info(invoices)').all().map((column) => column.name));
  for (const [name, type] of [['service_period_start', 'TEXT'], ['service_period_end', 'TEXT']]) {
    if (!columns.has(name)) database.exec(`ALTER TABLE invoices ADD COLUMN ${name} ${type}`);
  }
  serviceColumnsChecked.add(database);
}

const isServiceItem = (documentType, item) => (documentType === 'purchase'
  ? !(item.productId && Number(item.inventoryCost) > 0)
  : !item.productId) && Number(item.taxBase) > 0;

/**
 * تصمیم موتور برای ردیف‌های خدمت یک فاکتور.
 *
 * دستهٔ صریح کاربر بر متن مقدم است؛ ولی پیش‌فرضِ خالیِ «مواد و کالا» یا «فروش»
 * انتخاب نیست و جای خود را به دسته‌ای می‌دهد که خودِ ردیف می‌گوید («حق بیمهٔ
 * یکساله» بیمه است، نه مواد و کالا). یادداشت فاکتور فقط وقتی مال ردیف است که
 * فاکتور یک ردیف خدمت دارد؛ وگرنه «یکساله»ی یادداشت به ردیف چای هم می‌چسبید.
 */
function invoiceServiceGate(invoice, items, { issuedAt, servicePeriodStart = null, servicePeriodEnd = null, today = null }) {
  const documentType = invoice.documentType === 'purchase' ? 'purchase' : 'sales';
  const direction = documentType === 'purchase' ? 'payable' : 'receivable';
  const generic = !invoice.category || invoice.category === GENERIC_CATEGORY[documentType];
  const services = items.filter((item) => isServiceItem(documentType, item));
  const note = String(invoice.note || '').trim();
  const deferred = [];
  for (const item of services) {
    const title = String(item.title || '').trim();
    const evidence = services.length === 1 && note ? `${title} — ${note}` : title;
    const read = readDocumentService(evidence, {
      direction, occurredAt: issuedAt, category: generic ? null : invoice.category, servicePeriodStart, servicePeriodEnd,
    });
    const period = Boolean(read.servicePeriodStart && read.servicePeriodEnd);
    if (generic && !period && !SERVICE_WITHOUT_PERIOD.has(read.category)) continue;
    if (!generic && !period && !isTimeBoundCategory(read.category)) continue;
    const event = normalizeFinancialEvent({
      kind: documentType === 'purchase' ? EVENT_KINDS.PURCHASE_INVOICE : EVENT_KINDS.SALES_INVOICE,
      amount: Number(item.taxBase),
      occurredAt: issuedAt,
      counterparty: invoice.contactName || invoice.customerName || (documentType === 'purchase' ? 'تأمین‌کننده' : 'مشتری'),
      counterpartyId: invoice.contactId || null,
      category: read.category || invoice.category || GENERIC_CATEGORY[documentType],
      description: title,
      servicePeriodStart: read.servicePeriodStart, servicePeriodEnd: read.servicePeriodEnd,
      refundable: read.refundable,
      source: 'text',
      evidence, utterance: evidence,
    });
    const decision = documentServiceDecision(event, { today: today || new Date().toISOString() });
    if (!decision) continue;
    if (decision.decisionStatus === DECISION_STATUS.NEEDS_USER_INPUT) {
      const question = decision.question?.text || decision.explanation || 'دورهٔ پوشش این ردیف از کِی تا کِی است؟';
      return { deferred, blocked: { code: 'INVOICE_SERVICE_QUESTION', itemTitle: title, question, missing: decision.missingFacts || [] } };
    }
    if (decision.decisionStatus !== DECISION_STATUS.DECIDED) {
      return { deferred, blocked: { code: 'INVOICE_SERVICE_REVIEW', itemTitle: title, question: decision.explanation || 'ماهیت این ردیف قضاوت حسابدار لازم دارد.' } };
    }
    if (ENGINE_POSTED_TREATMENTS.includes(decision.treatment)) deferred.push({ item, event, decision, evidence });
  }
  return { deferred, blocked: null };
}

function serviceBlockedError(blocked) {
  const message = blocked.code === 'INVOICE_SERVICE_QUESTION'
    ? `ردیف «${blocked.itemTitle}» خدمت دوره‌دار است: ${blocked.question} دورهٔ پوشش (یا دسته) را بگو تا صادر شود؛ هزینه یا درآمد یک‌جا ساخته نشد.`
    : `ردیف «${blocked.itemTitle}»: ${blocked.question} فاکتور صادر نشد؛ ماهیت این ردیف را با حسابدار روشن کن و دسته‌اش را در فاکتور درست کن — درآمد یا هزینهٔ یک‌جا ساخته نشد.`;
  return Object.assign(new Error(message), { code: blocked.code, status: 409, question: blocked.question, itemTitle: blocked.itemTitle });
}

/**
 * سند صدور با سهم ردیف‌های خدمت.
 *
 * هر ردیف خدمت دوره‌دار یک رویداد مالی ثبت‌شده می‌گیرد که تصمیم و برنامهٔ
 * شناسایی‌اش به آن وصل است؛ سندش همان سند صدور فاکتور است (لنگر `invoice`)،
 * نه سند دوم. حساب پیش‌پرداخت یا درآمد انتقالی را همان نقشهٔ موتور می‌دهد که
 * شناسایی ماهانه از آن برمی‌دارد، تا مانده دقیقاً صفر شود.
 */
function postIssuedInvoice(invoice, gate, { createdBy, timeZone }) {
  const documentType = invoice.documentType === 'purchase' ? 'purchase' : 'sales';
  const counterRole = documentType === 'purchase' ? ROLES.PAYABLE : ROLES.RECEIVABLE;
  const deferrals = [];
  const recorded = [];
  if (gate.deferred.length) ensureFinancialEventSchema(db);
  for (const { item, event, decision, evidence } of gate.deferred) {
    const result = recordFinancialEvent(db, event, {
      sourceEventId: `invoice-line:${item.id}`,
      // ثبت سند با صدور فاکتور است، نه با تأیید جداگانهٔ این رویداد.
      decision: { route: ROUTES.CONFIRM, reasons: [`سند این ردیف با صدور ${invoice.number} زده می‌شود.`] },
      accountingDecision: decision,
      actor: createdBy, rawInput: evidence, transcript: evidence, timeZone, withinTransaction: true,
    });
    const own = (result.plan?.lines || []).filter((line) => line.role !== counterRole);
    const counter = (result.plan?.lines || []).filter((line) => line.role === counterRole);
    const side = documentType === 'purchase' ? 'debit' : 'credit';
    const shaped = !result.duplicate && result.route !== ROUTES.ACCOUNTANT_REVIEW && counter.length === 1 && own.length > 0
      && own.every((line) => Number(line[side]) > 0 && !Number(line[side === 'debit' ? 'credit' : 'debit']))
      && own.reduce((sum, line) => sum + Number(line[side]), 0) === event.amount;
    if (!shaped) {
      throw serviceBlockedError({ code: 'INVOICE_SERVICE_REVIEW', itemTitle: item.title, question: result.duplicate
        ? 'همین رویداد پیش‌تر از مسیر دیگری ثبت شده است.'
        : (result.guards?.find?.((check) => check.verdict === 'block')?.reason || 'نقشهٔ سند این ردیف قطعی نیست.') });
    }
    for (const line of own) {
      deferrals.push({
        accountId: resolveEventRole(db, line.role, line.key, event),
        analyticId: resolveEventAnalytic(db, line.role, event, line.key) || null,
        amount: Number(line[side]),
        description: item.title,
      });
    }
    recorded.push({ id: result.id, treatment: decision.treatment });
  }
  applyInvoiceInventory(db, invoice, { createdBy, timeZone });
  const posted = postInvoiceJournal(db, invoice, { createdBy, timeZone, deferrals });
  const anchor = JSON.stringify({ type: 'invoice', id: invoice.id });
  for (const { id } of recorded) {
    db.prepare("UPDATE financial_events SET status='posted',route=?,journal_entry_id=?,journal_source=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(ROUTES.AUTO, posted.id, anchor, id);
  }
  return { journalEntryId: posted.id, serviceEvents: recorded };
}

/**
 * ابطال ردیف‌های خدمت همراه فاکتور.
 *
 * سند صدور برمی‌گردد و پیش‌پرداخت یا درآمد انتقالی‌اش با آن؛ پس شناسایی‌هایی هم
 * که تا امروز از آن مانده برداشته‌اند باید برگردند، وگرنه هزینهٔ ماه‌های گذشته
 * می‌ماند و حساب پیش‌پرداخت منفی می‌شد. اقلام آینده باطل می‌شوند تا اجرای
 * شناسایی چیزی از فاکتور ابطال‌شده نسازد.
 */
function withdrawServiceEvents(invoice, occurredAt, { createdBy, timeZone }) {
  const sources = (invoice.items || []).map((item) => `invoice-line:${item.id}`);
  if (!sources.length) return [];
  ensureFinancialEventSchema(db);
  const events = db.prepare(`SELECT id FROM financial_events WHERE status='posted' AND source_event_id IN (${sources.map(() => '?').join(',')})`).all(...sources);
  for (const { id } of events) {
    for (const item of db.prepare("SELECT key,status FROM recognition_schedule_items WHERE event_id=? AND status IN ('planned','posted','blocked-closed-period')").all(id)) {
      if (item.status === 'posted') {
        reverseJournalEntry(db, { sourceType: 'recognition-schedule', sourceId: item.key, occurredAt, memo: `ابطال ${invoice.number}`, createdBy, timeZone });
      }
      db.prepare("UPDATE recognition_schedule_items SET status='superseded' WHERE key=?").run(item.key);
    }
    db.prepare("UPDATE financial_events SET status='reversed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
  }
  return events.map((row) => row.id);
}

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
  const category = String(values.category || GENERIC_CATEGORY[documentType]).trim().slice(0, 80);
  const servicePeriod = explicitServicePeriod(values);
  const id = randomUUID();
  for (const item of taxedItems) item.id = randomUUID();
  const year = new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: currentTimeZone(), year: 'numeric' }).format(new Date());
  const count = db.prepare('SELECT COUNT(*) AS count FROM invoices').get().count + 1;
  const number = `${documentType === 'purchase' ? 'KH' : 'FR'}-${year}-${String(count).padStart(4, '0')}`;
  const contact = values.contactId
    ? db.prepare('SELECT id,name FROM contacts WHERE id=?').get(values.contactId)
    : (values.customerName ? db.prepare('SELECT id,name FROM contacts WHERE id=?').get(contactIdForName(values.customerName, values.counterpartyResolution)) : null);
  const counterpartyName = String(contact?.name || values.customerName || (documentType === 'purchase' ? 'تأمین‌کننده' : 'مشتری')).trim().slice(0, 100);
  const note = String(values.note || '').slice(0, 500);
  let issueNow = values.issueNow === true || values.status === 'sent';
  const issuedAt = issueNow ? (values.issuedAt || new Date().toISOString()) : null;
  if (issuedAt) assertAccountingPeriodOpen(db, periodForDate(issuedAt, currentTimeZone()));
  // «همین حالا صادر کن» برای ردیف خدمتی که دوره‌اش معلوم نیست، صدور نیست:
  // فاکتور پیش‌نویس می‌ماند و سؤالش برمی‌گردد. ثبت یک‌جای هزینه یا درآمد،
  // یا رد کل فاکتور، هر دو بدتر بودند.
  const gate = issueNow
    ? invoiceServiceGate({ documentType, category, note, contactId: contact?.id || null, contactName: counterpartyName, number }, taxedItems, { issuedAt, ...servicePeriod })
    : null;
  let pendingQuestion = null;
  if (gate?.blocked) {
    pendingQuestion = serviceBlockedError(gate.blocked).message;
    issueNow = false;
  }
  if (servicePeriod.servicePeriodStart) ensureInvoiceServiceColumns();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO invoices
      (id,number,contact_id,customer_name,document_type,category,subtotal,discount,tax,total,tax_calculation,status,due_at,issued_at,posted_at,note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, number, contact?.id || null, counterpartyName, documentType, category, subtotal, discount, tax, total, taxResult.taxCalculation, issueNow ? 'sent' : 'draft', values.dueAt || null, issueNow ? issuedAt : null, issueNow ? issuedAt : null, note);
    if (servicePeriod.servicePeriodStart) {
      db.prepare('UPDATE invoices SET service_period_start=?,service_period_end=? WHERE id=?').run(servicePeriod.servicePeriodStart, servicePeriod.servicePeriodEnd, id);
    }
    const insert = db.prepare(`INSERT INTO invoice_items
      (id,invoice_id,title,quantity,unit_price,total,product_id,inventory_cost,tax_rate_id,tax_rate_bps,tax_treatment,tax_base,tax_amount)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const item of taxedItems) insert.run(item.id, id, item.title, item.quantity, item.unitPrice, item.total, item.productId, item.inventoryCost,
      item.taxRateId, item.taxRateBps, item.taxTreatment, item.taxBase, item.taxAmount);
    let serviceEvents = [];
    if (issueNow) {
      ({ serviceEvents } = postIssuedInvoice(getInvoice(id), gate, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() }));
    }
    audit('create', 'invoice', id, { number, total, documentType, issueNow, ...(pendingQuestion ? { pendingQuestion } : {}), ...(serviceEvents.length ? { serviceEvents } : {}) });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const created = getInvoice(id);
  return pendingQuestion ? { ...created, issueRequested: true, pendingQuestion } : created;
}

/** دورهٔ پوششی که فرم یا API صریح فرستاده — هر دو سر لازم است. */
function explicitServicePeriod(values = {}) {
  const read = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  const start = read(values.servicePeriodStart);
  const end = read(values.servicePeriodEnd);
  if ((values.servicePeriodStart || values.servicePeriodEnd) && !(start && end)) throw invalidInput('دورهٔ پوشش هم شروع لازم دارد و هم پایان.');
  if (start && end && new Date(end) < new Date(start)) throw invalidInput('پایان دورهٔ پوشش پیش از شروعش است.');
  return start && end ? { servicePeriodStart: start, servicePeriodEnd: end } : {};
}

function storedServicePeriod(id) {
  ensureInvoiceServiceColumns();
  const row = db.prepare('SELECT service_period_start AS start,service_period_end AS end FROM invoices WHERE id=?').get(id);
  return row?.start && row?.end ? { servicePeriodStart: row.start, servicePeriodEnd: row.end } : {};
}

/**
 * صدور پیش‌نویس.
 *
 * `category` و دورهٔ پوشش (`servicePeriodStart`/`servicePeriodEnd`) همان جواب
 * سؤالی است که صدور پرسیده بود؛ پیش‌نویس صوتیِ «مواد و کالا» هم پیش از صدور
 * دستهٔ درستش را می‌گیرد، نه اینکه باطل و از نو ساخته شود.
 */
export function issueInvoice(id, { issuedAt, category, servicePeriodStart, servicePeriodEnd } = {}) {
  let invoice = getInvoice(id);
  if (!invoice) return null;
  if (invoice.status !== 'draft') return invoice;
  const occurredAt = issuedAt || new Date().toISOString();
  assertAccountingPeriodOpen(db, periodForDate(occurredAt, currentTimeZone()));
  const answered = explicitServicePeriod({ servicePeriodStart, servicePeriodEnd });
  const chosenCategory = String(category || '').trim().slice(0, 80);
  if (chosenCategory) invoice = { ...invoice, category: chosenCategory };
  const gate = invoiceServiceGate(invoice, invoice.items, { issuedAt: occurredAt, ...storedServicePeriod(id), ...answered });
  if (gate.blocked) throw serviceBlockedError(gate.blocked);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (chosenCategory) db.prepare('UPDATE invoices SET category=? WHERE id=?').run(chosenCategory, id);
    if (answered.servicePeriodStart) db.prepare('UPDATE invoices SET service_period_start=?,service_period_end=? WHERE id=?').run(answered.servicePeriodStart, answered.servicePeriodEnd, id);
    db.prepare("UPDATE invoices SET status='sent',issued_at=?,posted_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='draft'").run(occurredAt, occurredAt, id);
    const { serviceEvents } = postIssuedInvoice(getInvoice(id), gate, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    audit('issue', 'invoice', id, { issuedAt: occurredAt, ...(serviceEvents.length ? { serviceEvents } : {}) });
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
    let withdrawn = [];
    if (invoice.postedAt) {
      reverseInvoiceInventory(db, invoice, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
      reverseInvoiceJournal(db, invoice, occurredAt, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
      withdrawn = withdrawServiceEvents(invoice, occurredAt, { createdBy: currentWorkspace()?.userId, timeZone: currentTimeZone() });
    }
    const result = db.prepare("UPDATE invoices SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
    if (!result.changes) throw invalidInput('سند قابل ابطال نیست.');
    audit('cancel', 'invoice', id, { reversal: Boolean(invoice.postedAt), ...(withdrawn.length ? { serviceEvents: withdrawn } : {}) });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return true;
}
