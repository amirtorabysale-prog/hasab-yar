// سند هر رویداد عملیاتی: تراکنش، آورده، فاکتور و دریافت وجهش، گردش کالا، و انتقال بین حساب‌ها.
//
// از server/accounting.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// accounting همه از همان server/accounting.js می‌خوانند.

import { analyticForContact, meaningfulTopicLabel, topicAnalytic } from '../chartOfAccounts.js';
import { accountingError, ensureAccountingSchema, linkedLedgerAccount, operationalLedgerAccount, categoryLedgerAccount, counterpartyLedgerAccount, inventoryLedgerAccount, cogsLedgerAccount, outputTaxLedgerAccount, inputTaxLedgerAccount, periodForDate } from './ledgerAccounts.js';
import { nextRevision, reversedLine, insertJournal, assertAccountingPeriodOpen } from './journalCore.js';

/**
 * سند یک ثبت روزانه.
 *
 * `settlement` وقتی می‌آید که این جابه‌جایی پول، تسویهٔ حساب یک طرف حساب
 * باشد نه هزینه یا درآمد تازه: «۹۳ میلیون به شرکت آراد گستر آسیا پرداخت شد»
 * وقتی به آن شرکت بدهکاریم، بدهی‌اش را کم می‌کند. ثبتش به‌عنوان هزینه دو
 * خطا با هم دارد — سود دوره بی‌دلیل کم می‌شود و بدهی آن شرکت در دفتر باز
 * می‌ماند، انگار پولی نداده‌ایم.
 *
 * تصمیمش اینجا گرفته نمی‌شود؛ لایهٔ دفتر که ماندهٔ واقعی را می‌بیند آن را
 * می‌فرستد. اینجا فقط حساب درست انتخاب می‌شود — و تفصیلی همان شخص هم روی
 * سطر می‌نشیند، وگرنه در پارسیان روی معین می‌نشیند و طرف حساب گم می‌شود.
 */
export function syncTransactionJournal(database, transaction, { createdBy = null, settlement = null } = {}) {
  ensureAccountingSchema(database);
  const amount = Math.round(Number(transaction.amount));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw accountingError('مبلغ سند تراکنش معتبر نیست.');
  const cash = operationalLedgerAccount(database, transaction.accountId || transaction.account || 'cash');
  const counterparty = settlement
    ? counterpartyLedgerAccount(database, settlement.contactId, settlement.contactName, settlement.direction === 'payable' ? 'purchase' : 'sales')
    : null;
  const category = counterparty || categoryLedgerAccount(database, transaction.type, transaction.category);
  // طرح ترکیبی: برچسبِ موضوع («کلید برق») روی سطرِ دسته تفصیلی می‌شود؛ دستهٔ
  // جدید نمی‌سازد و کدینگ را تکان نمی‌دهد. تسویهٔ طرف حساب، تفصیلیِ شخص می‌گیرد.
  const topicLabel = meaningfulTopicLabel(transaction.topicLabel || transaction.topic_label, transaction.category);
  const topicAnalyticId = !counterparty && topicLabel ? topicAnalytic(database, topicLabel).id : null;
  const analyticId = settlement ? analyticForContact(database, settlement.contactId, settlement.contactName)?.id || null : topicAnalyticId;
  const lines = transaction.type === 'income'
    ? [{ accountId: cash, debit: amount }, { accountId: category, credit: amount, analyticId }]
    : [{ accountId: category, debit: amount, analyticId }, { accountId: cash, credit: amount }];
  return insertJournal(database, {
    sourceType: 'transaction', sourceId: transaction.id,
    revision: nextRevision(database, 'transaction', transaction.id), entryKind: 'normal',
    occurredAt: transaction.occurredAt || transaction.occurred_at,
    memo: transaction.rawText || transaction.raw_text || transaction.category,
    createdBy, lines,
  });
}

/**
 * سند سرمایه و دارایی ثابت.
 *
 * هر دو پول را از صندوق یا بانک رد می‌کنند، ولی هیچ‌کدام سود و زیان دوره را
 * تکان نمی‌دهند: آوردهٔ مالک بستانکارِ حساب سرمایه است و خرید دارایی ثابت
 * بدهکارِ حساب همان دارایی. اگر مثل یک ثبت عادی به دستهٔ درآمد/هزینه می‌رفتند،
 * آورده سود را باد می‌کرد و خرید دارایی، سود همان ماه را می‌خورد.
 *
 * استهلاک اینجا نیست و ادعا هم نمی‌شود؛ دارایی به بهای تمام‌شده می‌نشیند و
 * استهلاک کار فاز جداگانه است.
 */
export function postCapitalJournal(database, entry, { createdBy = null } = {}) {
  ensureAccountingSchema(database);
  const amount = Math.round(Number(entry.amount));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw accountingError('مبلغ سند سرمایه معتبر نیست.');
  const cash = operationalLedgerAccount(database, entry.accountId || 'cash');
  const title = String(entry.title || '').trim().slice(0, 100);
  if (!title) throw accountingError('عنوان سرمایه یا دارایی ثابت لازم است.');
  const lines = entry.kind === 'capital-in'
    ? [
      { accountId: cash, debit: amount },
      { accountId: linkedLedgerAccount(database, 'system', 'owner-capital', 'سرمایه — آوردهٔ مالک', 'equity'), credit: amount },
    ]
    : [
      { accountId: linkedLedgerAccount(database, 'fixed-asset', title, `دارایی ثابت — ${title}`, 'asset'), debit: amount },
      { accountId: cash, credit: amount },
    ];
  return insertJournal(database, {
    sourceType: 'transaction', sourceId: entry.transactionId,
    revision: nextRevision(database, 'transaction', entry.transactionId), entryKind: 'normal',
    occurredAt: entry.occurredAt, memo: title, createdBy, lines,
  });
}

/**
 * آیا سند فعال این تراکنش همان شکل ساده‌ای است که `syncTransactionJournal` می‌سازد؟
 *
 * ویرایش، سند را معکوس می‌کند و از همان مسیر ساده دوباره می‌زند. برای سندی
 * که لایهٔ رویداد ساخته — تفکیک ارزش افزوده، پیش‌پرداخت، تسویهٔ طرف حساب —
 * این بازسازی ماهیت را بی‌صدا عوض می‌کند و جمع سند هم به هم نمی‌خورد.
 */
const PLAIN_TRANSACTION_SOURCES = new Set(['operational-account', 'income-category', 'expense-category']);

export function transactionJournalIsPlain(database, transactionId) {
  ensureAccountingSchema(database);
  const entry = database.prepare(`SELECT id FROM journal_entries j WHERE source_type='transaction' AND source_id=? AND entry_kind='normal'
    AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id=j.id) ORDER BY revision DESC LIMIT 1`).get(transactionId);
  if (!entry) return true;
  const kinds = database.prepare(`SELECT ledger_accounts.source_kind AS kind FROM journal_lines
    JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id WHERE journal_lines.entry_id=?`).all(entry.id);
  return kinds.length === 2 && kinds.every(({ kind }) => PLAIN_TRANSACTION_SOURCES.has(kind));
}

export function reverseTransactionJournal(database, transactionId, occurredAt, { createdBy = null, memo = 'سند معکوس اصلاح' } = {}) {
  ensureAccountingSchema(database);
  const original = database.prepare(`SELECT * FROM journal_entries WHERE source_type='transaction' AND source_id=?
    AND entry_kind='normal' ORDER BY revision DESC LIMIT 1`).get(transactionId);
  if (!original) return null;
  const alreadyReversed = database.prepare('SELECT 1 FROM journal_entries WHERE reverses_entry_id=?').get(original.id);
  if (alreadyReversed) return null;
  const lines = database.prepare('SELECT account_id AS accountId,debit,credit,description,analytic_id AS analyticId,cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=? ORDER BY rowid').all(original.id)
    .map((line) => reversedLine(line));
  return insertJournal(database, {
    sourceType: 'transaction', sourceId: transactionId,
    revision: nextRevision(database, 'transaction', transactionId), entryKind: 'reversal',
    occurredAt, memo, reversesEntryId: original.id, createdBy, lines,
  });
}

/**
 * سند صدور فاکتور.
 *
 * `deferrals` سهمی از ردیف‌های خدمت است که موتور تصمیم به حساب دیگری برده:
 * حق‌بیمه یا لایسنس یک‌ساله در فاکتور خرید «پیش‌پرداخت» است و اشتراک
 * دوازده‌ماههٔ فروخته‌شده «درآمد انتقالی»؛ هر دو ماه‌به‌ماه با برنامهٔ شناسایی
 * به هزینه و درآمد می‌روند. پیش از این کل مبلغ همان روز صدور به حساب دستهٔ
 * فاکتور می‌نشست. حساب طرف (پرداختنی/دریافتنی)، مالیات و موجودی عوض نمی‌شوند:
 * تاریخ فاکتور نقطهٔ مالیات و تعهد است، نه تاریخ شناسایی هزینه یا درآمد.
 */
export function postInvoiceJournal(database, invoice, { createdBy = null, timeZone = 'Asia/Tehran', deferrals = [] } = {}) {
  ensureAccountingSchema(database);
  const amount = Math.round(Number(invoice.total));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw accountingError('مبلغ فاکتور معتبر نیست.');
  const occurredAt = invoice.issuedAt || invoice.issued_at || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
  const existing = database.prepare("SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=? AND entry_kind='normal'").get(invoice.id);
  if (existing) return existing;
  const documentType = invoice.documentType || invoice.document_type || 'sales';
  const contactName = invoice.contactName || invoice.customerName || invoice.customer_name;
  const counterparty = counterpartyLedgerAccount(database, invoice.contactId || invoice.contact_id, contactName, documentType);
  // طرف حساب علاوه بر حساب معین، به‌عنوان تفصیلی شناور روی همان آرتیکل می‌نشیند.
  const counterpartyAnalytic = analyticForContact(database, invoice.contactId || invoice.contact_id, contactName || (documentType === 'purchase' ? 'تأمین‌کننده متفرقه' : 'مشتری متفرقه'))?.id || null;
  const category = categoryLedgerAccount(database, documentType === 'purchase' ? 'expense' : 'income', invoice.category || (documentType === 'purchase' ? 'مواد و کالا' : 'فروش'));
  const tax = Math.max(0, Math.round(Number(invoice.tax) || 0));
  const netAmount = amount - tax;
  if (netAmount < 0) throw accountingError('مالیات فاکتور از مبلغ نهایی بیشتر است.', 'INVOICE_TAX_INVALID');
  const deferralLines = (Array.isArray(deferrals) ? deferrals : []).map((line) => {
    const value = Math.round(Number(line?.amount));
    if (!line?.accountId || !Number.isSafeInteger(value) || value <= 0) throw accountingError('سهم ردیف خدمت فاکتور معتبر نیست.', 'INVOICE_DEFERRAL_INVALID');
    return { accountId: line.accountId, amount: value, analyticId: line.analyticId || null, description: line.description || null };
  });
  const deferredTotal = deferralLines.reduce((sum, line) => sum + line.amount, 0);
  let lines;
  if (documentType === 'purchase') {
    const inventoryLines = (invoice.items || []).filter((item) => item.productId && Number(item.inventoryCost) > 0).map((item) => {
      const product = database.prepare('SELECT id,name FROM products WHERE id=?').get(item.productId);
      if (!product) throw accountingError('کالای متصل به صورتحساب خرید پیدا نشد.', 'INVOICE_PRODUCT_MISSING');
      return { accountId: inventoryLedgerAccount(database, product), debit: Number(item.inventoryCost), description: item.title };
    });
    const inventoryTotal = inventoryLines.reduce((sum, line) => sum + line.debit, 0);
    const serviceBase = netAmount - inventoryTotal;
    if (serviceBase < 0) throw accountingError('ارزش موجودی ردیف‌های خرید از مبلغ خالص فاکتور بیشتر است.', 'INVOICE_INVENTORY_VALUE_INVALID');
    const categoryBase = serviceBase - deferredTotal;
    if (categoryBase < 0) throw accountingError('سهم پیش‌پرداخت ردیف‌های خدمت از مبلغ خالص فاکتور بیشتر است.', 'INVOICE_DEFERRAL_INVALID');
    lines = [...inventoryLines, ...(categoryBase > 0 ? [{ accountId: category, debit: categoryBase }] : []),
      ...deferralLines.map(({ amount: value, ...line }) => ({ ...line, debit: value })),
      ...(tax > 0 ? [{ accountId: inputTaxLedgerAccount(database), debit: tax }] : []), { accountId: counterparty, credit: amount, analyticId: counterpartyAnalytic }];
  } else {
    const categoryBase = netAmount - deferredTotal;
    if (categoryBase < 0) throw accountingError('سهم درآمد انتقالی ردیف‌های خدمت از مبلغ خالص فاکتور بیشتر است.', 'INVOICE_DEFERRAL_INVALID');
    lines = [{ accountId: counterparty, debit: amount, analyticId: counterpartyAnalytic }, ...(categoryBase > 0 ? [{ accountId: category, credit: categoryBase }] : []),
      ...deferralLines.map(({ amount: value, ...line }) => ({ ...line, credit: value })),
      ...(tax > 0 ? [{ accountId: outputTaxLedgerAccount(database), credit: tax }] : [])];
  }
  return insertJournal(database, {
    sourceType: 'invoice', sourceId: invoice.id, revision: nextRevision(database, 'invoice', invoice.id),
    occurredAt, memo: `${documentType === 'purchase' ? 'صورتحساب خرید' : 'فاکتور فروش'} ${invoice.number}`,
    createdBy, lines,
  });
}

export function postInventoryMovementJournal(database, movement, product, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const value = Math.abs(Math.round(Number(movement.valueDelta ?? movement.value_delta) || 0));
  if (!value || movement.movementType === 'purchase' || movement.movement_type === 'purchase') return null;
  const occurredAt = movement.occurredAt || movement.occurred_at || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
  const existing = database.prepare("SELECT id FROM journal_entries WHERE source_type='inventory_movement' AND source_id=?").get(movement.id);
  if (existing) return existing;
  const type = movement.movementType || movement.movement_type;
  const inventory = inventoryLedgerAccount(database, product);
  let lines;
  if (type === 'opening') lines = [{ accountId: inventory, debit: value }, { accountId: 'ledger-opening-equity', credit: value }];
  else if (type === 'sale') lines = [{ accountId: cogsLedgerAccount(database, product), debit: value }, { accountId: inventory, credit: value }];
  else if (Number(movement.quantity) > 0) {
    const gain = linkedLedgerAccount(database, 'system', 'inventory-gain', 'اضافی موجودی و تعدیلات', 'income');
    lines = [{ accountId: inventory, debit: value }, { accountId: gain, credit: value }];
  } else {
    const shrinkage = linkedLedgerAccount(database, 'system', 'inventory-shrinkage', 'کسری و ضایعات موجودی', 'expense');
    lines = [{ accountId: shrinkage, debit: value }, { accountId: inventory, credit: value }];
  }
  return insertJournal(database, {
    sourceType: 'inventory_movement', sourceId: movement.id, revision: 1, occurredAt,
    memo: movement.note || `${type === 'sale' ? 'بهای تمام‌شده' : 'اصلاح موجودی'} ${product.name}`,
    createdBy, lines,
  });
}

export function reverseInventoryMovementJournal(database, movementId, occurredAt, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  const original = database.prepare("SELECT * FROM journal_entries WHERE source_type='inventory_movement' AND source_id=? AND entry_kind='normal' ORDER BY revision DESC LIMIT 1").get(movementId);
  if (!original || database.prepare('SELECT 1 FROM journal_entries WHERE reverses_entry_id=?').get(original.id)) return null;
  const reversalAt = occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(reversalAt, timeZone));
  const lines = database.prepare('SELECT account_id AS accountId,debit,credit,description,analytic_id AS analyticId,cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=? ORDER BY rowid').all(original.id)
    .map((line) => reversedLine(line));
  return insertJournal(database, {
    sourceType: 'inventory_movement', sourceId: movementId, revision: nextRevision(database, 'inventory_movement', movementId), entryKind: 'reversal',
    occurredAt: reversalAt, memo: 'معکوس گردش انبار', reversesEntryId: original.id, createdBy, lines,
  });
}

export function postInvoicePaymentJournal(database, invoice, payment, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const amount = Math.round(Number(payment.amount));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw accountingError('مبلغ تسویه معتبر نیست.');
  const occurredAt = payment.occurredAt || payment.occurred_at || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(occurredAt, timeZone));
  const existing = database.prepare("SELECT id FROM journal_entries WHERE source_type='invoice_payment' AND source_id=?").get(payment.id);
  if (existing) return existing;
  const documentType = invoice.documentType || invoice.document_type || 'sales';
  const contactName = invoice.contactName || invoice.customerName || invoice.customer_name;
  const counterparty = counterpartyLedgerAccount(database, invoice.contactId || invoice.contact_id, contactName, documentType);
  const counterpartyAnalytic = analyticForContact(database, invoice.contactId || invoice.contact_id, contactName || (documentType === 'purchase' ? 'تأمین‌کننده متفرقه' : 'مشتری متفرقه'))?.id || null;
  const cash = operationalLedgerAccount(database, payment.accountId || payment.account_id || 'cash');
  const lines = documentType === 'purchase'
    ? [{ accountId: counterparty, debit: amount, analyticId: counterpartyAnalytic }, { accountId: cash, credit: amount }]
    : [{ accountId: cash, debit: amount }, { accountId: counterparty, credit: amount, analyticId: counterpartyAnalytic }];
  return insertJournal(database, {
    sourceType: 'invoice_payment', sourceId: payment.id, revision: 1, occurredAt,
    memo: `${documentType === 'purchase' ? 'پرداخت' : 'وصول'} ${invoice.number}`,
    createdBy, lines,
  });
}

export function reverseInvoiceJournal(database, invoice, occurredAt, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const original = database.prepare("SELECT * FROM journal_entries WHERE source_type='invoice' AND source_id=? AND entry_kind='normal' ORDER BY revision DESC LIMIT 1").get(invoice.id);
  if (!original) return null;
  if (database.prepare('SELECT 1 FROM journal_entries WHERE reverses_entry_id=?').get(original.id)) return null;
  const reversalAt = occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(reversalAt, timeZone));
  const lines = database.prepare('SELECT account_id AS accountId,debit,credit,description,analytic_id AS analyticId,cost_center_id AS costCenterId FROM journal_lines WHERE entry_id=? ORDER BY rowid').all(original.id)
    .map((line) => reversedLine(line));
  return insertJournal(database, {
    sourceType: 'invoice', sourceId: invoice.id, revision: nextRevision(database, 'invoice', invoice.id), entryKind: 'reversal',
    occurredAt: reversalAt, memo: `ابطال ${invoice.number}`, reversesEntryId: original.id, createdBy, lines,
  });
}

/**
 * انتقال پول میان دو حساب خودمان.
 *
 * «دو میلیون از صندوق به بانک ملت واریز شد» نه درآمد است نه هزینه — پول از
 * جیبی به جیب دیگرِ همین کسب‌وکار رفته. اگر از مسیر عادی رد شود، یک بار
 * درآمدِ بانک ثبت می‌شود و یک بار هزینهٔ صندوق، و سود دوره دو بار جعل
 * می‌شود.
 *
 * سند دوطرفه است و هیچ حساب درآمد یا هزینه‌ای را لمس نمی‌کند؛ فقط مانده‌ی
 * دو حساب جابه‌جا می‌شود.
 */
export function postAccountTransferJournal(database, { transferId, fromAccountId, toAccountId, amount, occurredAt, memo }, { createdBy = null, timeZone = 'Asia/Tehran' } = {}) {
  ensureAccountingSchema(database);
  const value = Math.round(Number(amount) || 0);
  if (!Number.isSafeInteger(value) || value <= 0) throw accountingError('مبلغ انتقال معتبر نیست.', 'TRANSFER_AMOUNT_INVALID');
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) {
    throw accountingError('مبدأ و مقصد انتقال باید دو حساب متفاوت باشند.', 'TRANSFER_SAME_ACCOUNT');
  }
  const at = occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(database, periodForDate(at, timeZone));
  return insertJournal(database, {
    sourceType: 'account_transfer', sourceId: transferId, revision: 1,
    occurredAt: at, memo: String(memo || 'انتقال بین حساب‌ها').slice(0, 200), createdBy, timeZone,
    lines: [
      { accountId: operationalLedgerAccount(database, toAccountId), debit: value, description: memo },
      { accountId: operationalLedgerAccount(database, fromAccountId), credit: value, description: memo },
    ],
  });
}
