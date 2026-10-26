import { randomUUID } from 'node:crypto';
import { EVENT_KINDS, normalizeFinancialEvent } from '../../shared/financialEvent.js';
import { audit, cleanAmount, currentTimeZone, currentWorkspace, db, invalidInput } from './core.js';
import { automationPolicy } from './settings.js';
import { contactIdForName } from './contacts.js';
import { ensureFinancialEventSchema, findEventBySource, recordFinancialEvent, rejectFinancialEvent, reverseFinancialEvent } from '../financialEventStore.js';
import { documentRouting, documentServiceDecision, readDocumentService } from '../../shared/documentService.js';
import { insertTransactionRows, transactionRow } from './transactions.js';
import { resolveAccountId } from './accounts.js';
import { routeEvent } from '../../shared/confidenceEngine.js';
import { ledgerSideBalances } from './counterpartyCard.js';
import { unitLabel } from '../../shared/amountUnit.js';

/**
 * سندِ ایجادِ زندهٔ یک تعهد.
 *
 * ویرایش مبلغ، جهت، طرف حساب یا تاریخ، سند قبلی را برمی‌گرداند و سند تازه‌ای با
 * شناسهٔ بازنگری (`obligation:<id>#r<n>`) می‌زند؛ همیشه آخرین سندی که برگشت یا
 * رد نخورده، سند این تعهد است — در فهرست، در تسویه و در حذف.
 */
const OPENING_EVENT_SQL = `SELECT fe.id FROM financial_events fe
  WHERE (fe.source_event_id='obligation:' || obligations.id OR fe.source_event_id LIKE 'obligation:' || obligations.id || '#r%')
    AND fe.status NOT IN ('reversed','rejected')
  ORDER BY fe.rowid DESC LIMIT 1`;

function openingEvent(id) {
  ensureFinancialEventSchema(db);
  const row = db.prepare(`SELECT source_event_id FROM financial_events
    WHERE (source_event_id=? OR source_event_id LIKE ?) AND status NOT IN ('reversed','rejected')
    ORDER BY rowid DESC LIMIT 1`).get(`obligation:${id}`, `obligation:${id}#r%`);
  return row ? findEventBySource(db, row.source_event_id) : null;
}

function openingRevision(id) {
  return db.prepare("SELECT COUNT(*) AS count FROM financial_events WHERE source_event_id=? OR source_event_id LIKE ?")
    .get(`obligation:${id}`, `obligation:${id}#r%`).count;
}

/** سند ایجاد را پس می‌گیرد: ثبت‌شده برمی‌گردد، منتظر رد می‌شود. */
function withdrawOpening(id, reason) {
  const opened = openingEvent(id);
  if (!opened) return null;
  const actor = currentWorkspace()?.userId || null;
  if (opened.status === 'posted') return reverseFinancialEvent(db, opened.id, { actor, reason, timeZone: currentTimeZone(), withinTransaction: true });
  if (opened.status === 'pending') return rejectFinancialEvent(db, opened.id, { actor, reason });
  return opened;
}

export function listObligations({ status = 'open' } = {}) {
  ensureFinancialEventSchema(db);
  const where = ['open', 'paid', 'cancelled'].includes(status) ? 'WHERE obligations.status=?' : '';
  const args = where ? [status] : [];
  return db.prepare(`SELECT obligations.id,obligations.contact_id AS contactId,contacts.name AS contactName,
    obligations.title,obligations.amount,obligations.direction,obligations.due_at AS dueAt,
    obligations.occurred_at AS occurredAt,COALESCE(obligations.paid_amount,0) AS paidAmount,
    obligations.amount-COALESCE(obligations.paid_amount,0) AS remaining,
    obligations.status,obligations.note,obligations.created_at AS createdAt,
    CASE WHEN opened.status='posted' AND journal.id IS NOT NULL THEN 'posted'
      WHEN opened.id IS NULL THEN 'legacy' ELSE 'pending' END AS journalStatus
    FROM obligations LEFT JOIN contacts ON contacts.id=obligations.contact_id
    LEFT JOIN financial_events AS opened ON opened.id=(${OPENING_EVENT_SQL})
    LEFT JOIN journal_entries AS journal ON journal.id=opened.journal_entry_id ${where}
    ORDER BY CASE WHEN obligations.due_at IS NULL THEN 1 ELSE 0 END,obligations.due_at,obligations.created_at DESC`).all(...args);
}

export function saveObligation(values = {}) {
  const amount = cleanAmount(values.amount);
  const direction = ['receivable', 'payable'].includes(values.direction) ? values.direction : null;
  if (!direction) throw invalidInput('نوع طلب یا بدهی معتبر نیست.');
  const title = String(values.title || '').trim().slice(0, 120);
  if (!title) throw invalidInput('عنوان طلب یا بدهی را وارد کن.');
  const contactId = values.contactId || (values.contactName ? contactIdForName(values.contactName, values.counterpartyResolution) : null);
  if (values.id) return updateObligation(String(values.id), { ...values, amount, direction, title, contactId });
  const id = randomUUID();
  db.prepare(`INSERT INTO obligations (id,contact_id,title,amount,direction,due_at,occurred_at,status,note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, contactId, title, amount, direction, values.dueAt || null, values.occurredAt || null, 'open', String(values.note || '').slice(0, 500));
  audit('create', 'obligation', id, { amount, direction, title });
  // تعهدِ باز تا امروز هیچ سندی در دفتر نمی‌زد، پس نه در تراز دیده می‌شد و نه در
  // فایل انتقال پارسیان. طلب و بدهی رویداد مستقل‌اند: حق دریافت یا تعهد پرداخت
  // همان لحظه ساخته می‌شود، حتی وقتی هنوز پولی جابه‌جا نشده.
  postObligationOpened(id, { amount, direction, title, contactId, occurredAt: values.occurredAt, note: values.note, category: values.category });
  return listObligations({ status: 'all' }).find((item) => item.id === id);
}

/**
 * ویرایش یک تعهد — فهرست و دفتر کل با هم عوض می‌شوند.
 *
 * تا امروز ویرایش فقط ردیف فهرست را عوض می‌کرد: بیمهٔ دوازده میلیونی که شش شد،
 * در دفتر دوازده می‌ماند و کارت طرف حساب شش میلیون «بدهی بی‌پوشش» نشان می‌داد که
 * تسویهٔ کارت از صندوق می‌پرداخت. حالا هر تغییری که سند را عوض می‌کند (مبلغ،
 * جهت، طرف حساب، تاریخ)، سند قبلی را برمی‌گرداند و سند تازه می‌زند. تعهدی که
 * بخشی‌اش تسویه شده، اول باید تسویه‌هایش برگردد. وضعیت از بدنهٔ درخواست
 * خوانده نمی‌شود: فقط تسویه و حذف آن را عوض می‌کنند.
 */
/**
 * عنوان و یادداشت تعهد دسته و دورهٔ پوششِ سندش را می‌سازند («اشتراک یک ساله نرم
 * افزار — پوشش مهر تا شهریور» پیش‌پرداخت است، «بدهی به شرکت پارس» سایر هزینه‌ها).
 * ویرایشی که خواندنِ آن‌ها را عوض کند — یا دستهٔ صریح تازه بیاورد — سند را هم عوض
 * می‌کند؛ وگرنه پیش‌پرداخت و برنامهٔ دوازده‌ماهه زیر عنوان «خرید جنس» می‌ماند.
 */
function serviceReadingChanged(id, existing, values) {
  const at = new Date(values.occurredAt || existing.occurred_at || existing.created_at || Date.now());
  const when = Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
  const read = (title, note, category, direction) => readDocumentService(
    [title, note].map((part) => String(part || '').trim()).filter(Boolean).join(' — '),
    { direction, occurredAt: when, category },
  );
  const opened = openingEvent(id);
  let stored = null;
  try { stored = opened ? JSON.parse(db.prepare('SELECT payload FROM financial_events WHERE id=?').get(opened.id)?.payload || 'null') : null; } catch { stored = null; }
  const before = read(existing.title, existing.note, null, existing.direction);
  const after = read(values.title, values.note, values.category || null, values.direction);
  if (values.category && stored?.category && values.category !== stored.category) return true;
  return before.category !== after.category || before.servicePeriodStart !== after.servicePeriodStart
    || before.servicePeriodEnd !== after.servicePeriodEnd || before.refundable !== after.refundable;
}

function updateObligation(id, values) {
  const existing = db.prepare('SELECT * FROM obligations WHERE id=?').get(id);
  if (!existing) throw Object.assign(invalidInput('این طلب یا بدهی پیدا نشد.'), { status: 404, code: 'OBLIGATION_MISSING' });
  if (existing.status === 'cancelled') throw Object.assign(invalidInput('این طلب یا بدهی حذف شده و قابل ویرایش نیست.'), { status: 409, code: 'OBLIGATION_CANCELLED' });
  const occurredAt = values.occurredAt === undefined ? existing.occurred_at : (values.occurredAt || null);
  const note = values.note === undefined ? existing.note : values.note;
  const ledgerChanged = values.amount !== existing.amount || values.direction !== existing.direction
    || (values.contactId || null) !== (existing.contact_id || null) || (occurredAt || null) !== (existing.occurred_at || null)
    || serviceReadingChanged(id, existing, { ...values, note, occurredAt });
  const paid = Number(existing.paid_amount) || 0;
  if (ledgerChanged && paid > 0) {
    throw Object.assign(invalidInput('بخشی از این طلب یا بدهی تسویه شده؛ برای تغییر مبلغ، جهت یا طرف حساب اول تسویه‌هایش را برگردان.'), { status: 409, code: 'OBLIGATION_PARTLY_SETTLED' });
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE obligations SET contact_id=?,title=?,amount=?,direction=?,due_at=?,occurred_at=?,note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(values.contactId || null, values.title, values.amount, values.direction,
        values.dueAt === undefined ? existing.due_at : (values.dueAt || null), occurredAt,
        values.note === undefined ? existing.note : String(values.note || '').slice(0, 500), id);
    if (ledgerChanged) {
      withdrawOpening(id, 'ویرایش طلب/بدهی');
      postObligationOpened(id, {
        amount: values.amount, direction: values.direction, title: values.title, contactId: values.contactId || null,
        occurredAt, note, category: values.category,
      }, { sourceEventId: `obligation:${id}#r${openingRevision(id)}`, withinTransaction: true });
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  audit('update', 'obligation', id, { amount: values.amount, direction: values.direction, title: values.title, reposted: ledgerChanged });
  return listObligations({ status: 'all' }).find((item) => item.id === id);
}

/**
 * تسویهٔ یک تعهد — کامل یا جزئی.
 *
 * مشتری سی درصد می‌دهد و بقیه را ماه بعد؛ این قاعده است نه استثنا. تا پیش از
 * این تعهد یا کامل بسته می‌شد یا اصلاً، پس دفتر مجبور بود یا طلب را زودتر از
 * موعد ببندد — و مانده‌اش را از دست بدهد — یا پرداخت واقعی را جایی ثبت نکند.
 *
 * هر پرداخت سند خودش را دارد و مبلغ خودش را می‌برد؛ تعهد وقتی «پرداخت‌شده»
 * می‌شود که ماندهٔ صفر داشته باشد، نه وقتی یک بار دستش زده‌اند.
 */
// `withinTransaction`: همان قاعدهٔ `recordInvoicePayment` — تراکنش تودرتو نه.
//
// `paidBy`: شریک یا مدیرعاملی که از پول شخصی خودش این تعهد را بست. آن‌وقت هیچ
// ردیف نقدی ساخته نمی‌شود — پولی از صندوق یا بانک شرکت نرفته — و سند، بدهی
// طلبکار را در برابر جاری همان شریک می‌بندد.
export function settleObligation(id, { occurredAt, account = 'cash', accountId, amount: requested, withinTransaction = false, paidBy = null } = {}) {
  const item = db.prepare("SELECT * FROM obligations WHERE id=? AND status='open'").get(id);
  if (!item) return null;
  // تعهدهای قدیمی ممکن است قبلاً در دفتر یا در فاکتور دیگری شناسایی شده باشند.
  // هیچ راه مطمئنی برای حدسِ حساب مقابل از عنوان آن‌ها نداریم؛ مسیر قدیمی هنگام
  // وصول، «درآمد/هزینهٔ تازه» می‌ساخت. پیش از هر تغییر در مانده یا تراکنش متوقف شو.
  const opened = openingEvent(id);
  const journalExists = opened?.journalEntryId && db.prepare('SELECT 1 FROM journal_entries WHERE id=?').get(opened.journalEntryId);
  if (opened?.status !== 'posted' || !journalExists) {
    throw invalidInput(opened
      ? 'سند حسابداری این طلب یا بدهی قطعی نشده است؛ پیش از تسویه، وضعیت سند را در صف بررسی حسابدار پیگیری کن.'
      : 'این طلب یا بدهی قدیمی سند ایجاد ندارد؛ پیش از تسویه باید مانده و سند اولیه با حسابدار تطبیق داده شود. برای جلوگیری از ثبت دوبارهٔ درآمد یا هزینه، تسویه انجام نشد.');
  }
  const remaining = item.amount - (item.paid_amount || 0);
  const amount = requested == null || requested === '' ? remaining : cleanAmount(requested);
  if (amount <= 0) throw invalidInput('مبلغ تسویه باید بیشتر از صفر باشد.');
  if (amount > remaining) {
    throw invalidInput(`مبلغ تسویه از ماندهٔ این تعهد بیشتر است؛ مانده ${remaining.toLocaleString('en-US')} ${unitLabel()} است.`);
  }
  const payerName = String(paidBy?.name || '').trim().slice(0, 120);
  if (paidBy && !payerName) throw invalidInput('نام شریکی که از پول شخصی پرداخت کرده لازم است.');
  let transactionId;
  if (!withinTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    if (payerName) {
      const payerId = paidBy.contactId || contactIdForName(payerName, paidBy.counterpartyResolution);
      if (payerId && payerId === item.contact_id) throw invalidInput('پرداخت‌کننده همان طرف حساب این تعهد است؛ این تسویه از پول شریک نیست.');
      const posted = postObligationSettledByPartner(id, item, { occurredAt, amount, payerName, payerId });
      if (!posted || posted.status !== 'posted') {
        throw invalidInput('سند تسویه از پول شریک قطعی نشد؛ هیچ تغییری در بدهی ثبت نشد. گفته را به صف حسابدار بفرست.');
      }
      const updated = db.prepare(`UPDATE obligations SET paid_amount=COALESCE(paid_amount,0)+?,
        status=CASE WHEN COALESCE(paid_amount,0)+? >= amount THEN 'paid' ELSE 'open' END,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status='open' AND COALESCE(paid_amount,0)+? <= amount`).run(amount, amount, id, amount);
      if (!updated.changes) throw invalidInput('این طلب یا بدهی قبلاً تسویه شده است.');
      audit('settle-by-partner', 'obligation', id, { amount, payerName, eventId: posted.id, partial: amount < remaining });
      if (!withinTransaction) db.exec('COMMIT');
      return { item: listObligations({ status: 'all' }).find((row) => row.id === id), transaction: null, event: { id: posted.id, status: posted.status }, paidBy: { name: payerName, contactId: payerId } };
    }
    // تعهدی که خودش سند خورده، درآمد یا هزینه‌اش همان موقع شناخته شده. اگر تسویه
    // دوباره به دستهٔ درآمد/هزینه بخورد، همان مبلغ دو بار در سود دوره می‌آید.
    // ردیف تراکنش می‌ماند — مانده و گزارش نقدی به آن نیاز دارند — ولی سندش را
    // خودمان می‌زنیم: نقد در برابر حساب دریافتنی/پرداختنی.
    //
    [transactionId] = insertTransactionRows({ transcript: `تسویه ${item.title}`, transactions: [{
      clientId: `obligation:${id}:${(item.paid_amount || 0) + amount}`, amount,
      type: item.direction === 'receivable' ? 'income' : 'expense',
      category: item.direction === 'receivable' ? 'سایر درآمدها' : 'سایر هزینه‌ها',
      rawText: `تسویه ${item.title}`, source: 'text', contactId: item.contact_id, occurredAt, account, accountId,
      // مثل تسویهٔ فاکتور «تخصیص‌یافته» است: سندش را همین‌جا زده‌ایم و اگر
      // جداگانه ویرایش شود، سند تسویه معکوس می‌شود و به‌جایش سند درآمد
      // می‌نشیند — همان فروش، دو بار در سود دوره.
      status: 'allocated',
      journalManaged: true,
    }] });
    postObligationSettled(id, item, { occurredAt, accountId: resolveAccountId({ account, accountId }), transactionId, amount });
    // شرط روی مبلغ پرداخت‌شده است، نه فقط روی وضعیت: دو تسویهٔ هم‌زمان نباید
    // بتوانند بیشتر از ماندهٔ تعهد را ببرند.
    const updated = db.prepare(`UPDATE obligations SET paid_amount=COALESCE(paid_amount,0)+?,
      status=CASE WHEN COALESCE(paid_amount,0)+? >= amount THEN 'paid' ELSE 'open' END,
      paid_transaction_id=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='open' AND COALESCE(paid_amount,0)+? <= amount`).run(amount, amount, transactionId, id, amount);
    if (!updated.changes) throw invalidInput('این طلب یا بدهی قبلاً تسویه شده است.');
    audit('settle', 'obligation', id, { transactionId, amount, partial: amount < remaining });
    if (!withinTransaction) db.exec('COMMIT');
  } catch (error) { if (!withinTransaction) db.exec('ROLLBACK'); throw error; }
  return { item: listObligations({ status: 'all' }).find((row) => row.id === id), transaction: transactionRow(transactionId) };
}

/**
 * حذف تعهد — همراه با سندش.
 *
 * حذفِ تنهای ردیف، سند ایجاد را در دفتر می‌گذاشت: بدهی‌ای که کاربر پاک کرده بود
 * در کارت طرف حساب «بی‌پوشش» دیده می‌شد و تسویهٔ کارت آن را از صندوق می‌پرداخت.
 * حالا سند ثبت‌شده برمی‌گردد (یا رویداد منتظر رد می‌شود) و ردیف «ابطال‌شده»
 * می‌ماند تا ردپای برگشت گم نشود. تعهدی که بخشی‌اش تسویه شده حذف نمی‌شود.
 */
export function deleteObligation(id) {
  const existing = db.prepare('SELECT * FROM obligations WHERE id=?').get(String(id || ''));
  if (!existing) return false;
  if ((Number(existing.paid_amount) || 0) > 0) {
    throw Object.assign(invalidInput('بخشی از این طلب یا بدهی تسویه شده؛ اول تسویه‌هایش را برگردان، بعد حذفش کن.'), { status: 409, code: 'OBLIGATION_PARTLY_SETTLED' });
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const withdrawn = withdrawOpening(existing.id, 'حذف طلب/بدهی');
    if (withdrawn) db.prepare("UPDATE obligations SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(existing.id);
    else db.prepare('DELETE FROM obligations WHERE id=?').run(existing.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  audit('delete', 'obligation', existing.id);
  return true;
}

/**
 * سند یک تعهد تازه.
 *
 * چرا مسیر رویداد و نه یک `postXJournal` تازه: تصمیمِ «چه سندی» در
 * `shared/accountingRules.js` است و اینجا فقط رویداد ساخته می‌شود. همین باعث
 * می‌شود همان قاعده‌ای که آزمون دارد اجرا شود، نه یک نسخهٔ دوم از آن.
 *
 * شکست اینجا نباید ساخت تعهد را از بین ببرد: کاربر طلبش را ثبت کرده و آن حقیقت
 * دارد، حتی اگر کدینگ دفتر هنوز آمادهٔ سند نباشد. رویداد به صف بررسی می‌رود.
 */
// تعهدی که طرف حساب ندارد زیر یک حساب خنثی می‌نشیند، نه زیر حسابی به نام عنوانش.
// «طلب/بدهی» یا «شرکت پارس»ِ تایپ‌شده در عنوان، بعداً با ساخته‌شدن مخاطبی به همان
// نام، ماندهٔ این تعهد را «بی‌پوشش» نشان می‌داد و تسویهٔ کارت دوباره می‌پرداخت.
const NO_COUNTERPARTY = 'بدون طرف حساب';

function postObligationOpened(obligationId, { amount, direction, title, contactId, occurredAt, note, category = null },
  { sourceEventId = `obligation:${obligationId}`, withinTransaction = false } = {}) {
  try {
    const contact = contactId ? db.prepare('SELECT name FROM contacts WHERE id=?').get(contactId) : null;
    const when = occurredAt || new Date().toISOString();
    // شاهد، عنوان و یادداشت با هم است؛ «note || title» عنوانِ «حق بیمه یکساله» را
    // هر بار که یادداشتی بود دور می‌انداخت.
    const evidence = [title, note].map((part) => String(part || '').trim()).filter(Boolean).join(' — ');
    // «اشتراک یک ساله … بدهکاریم»، «مستاجر اجاره شش ماه بعد رو بدهکاره»: همان
    // دسته و دورهٔ پوششی که پرداخت نقدی می‌خواند. دستهٔ ثابت «سایر هزینه‌ها /
    // سایر درآمدها» فقط وقتی می‌ماند که متن هیچ دسته‌ای نگوید.
    const service = readDocumentService(evidence, { direction, occurredAt: when, category });
    const event = normalizeFinancialEvent({
      kind: direction === 'receivable' ? EVENT_KINDS.RECEIVABLE_OPENED : EVENT_KINDS.PAYABLE_OPENED,
      amount,
      occurredAt: when,
      counterparty: contact?.name || NO_COUNTERPARTY,
      counterpartyId: contactId || null,
      category: service.category || (direction === 'receivable' ? 'سایر درآمدها' : 'سایر هزینه‌ها'),
      description: title,
      servicePeriodStart: service.servicePeriodStart,
      servicePeriodEnd: service.servicePeriodEnd,
      refundable: service.refundable,
      source: 'text',
      evidence,
    });
    const actor = currentWorkspace()?.userId || null;
    // خدمت دوره‌دار: هر چه موتور بگوید — پیش‌پرداخت یا پیش‌دریافت با برنامهٔ
    // ماهانه، سؤال دوره، یا حسابدار — و هرگز هزینه یا درآمد یک‌جا.
    const accountingDecision = documentServiceDecision(event, { today: new Date().toISOString() });
    if (accountingDecision) {
      return recordFinancialEvent(db, event, {
        sourceEventId, decision: documentRouting(accountingDecision), accountingDecision,
        actor, rawInput: evidence, transcript: evidence, timeZone: currentTimeZone(), withinTransaction,
      });
    }
    // ورودی فرم برداشت نیست: کاربر مبلغ و جهت را خودش انتخاب کرده و دکمهٔ ذخیره
    // را زده. خودِ همان ثبت، تأیید است.
    //
    // نداشتن طرف حساب هم ابهام نیست؛ «بدون شخص» یک انتخاب معتبر است. پایین‌آوردن
    // اطمینان به‌خاطر آن، تعهد را بی‌دلیل در صف بررسی نگه می‌داشت.
    const decision = routeEvent(event, {
      components: {
        amountCertainty: 1, moneyDirectionCertainty: 1, dateCertainty: 1, completeness: 1,
        ...(contact?.name ? { counterpartyCertainty: 1 } : {}),
      },
      policy: automationPolicy(),
    });
    return recordFinancialEvent(db, event, {
      sourceEventId,
      decision,
      actor,
      rawInput: title,
      withinTransaction,
    });
  } catch (error) {
    // ویرایشی که سند قبلی را برگردانده ولی سند تازه نخورده، نیمه‌کاره است؛
    // کل ویرایش برمی‌گردد تا فهرست و دفتر از هم جدا نیفتند.
    if (withinTransaction) throw error;
    // سند نخوردن یک تعهد نباید ثبت خودِ تعهد را برگرداند؛ ولی بی‌صدا هم نباید
    // رد شود، چون یعنی دفتر و فهرست طلب‌ها از هم جدا افتاده‌اند.
    audit('journal-failed', 'obligation', obligationId, { code: error.code || 'UNKNOWN', message: String(error.message).slice(0, 200) });
    return null;
  }
}

/** سند تسویهٔ تعهدی که خودش سند خورده: فقط جابه‌جایی پول، بدون درآمد دوباره. */
function postObligationSettled(obligationId, item, { occurredAt, accountId, transactionId, amount }) {
  const contact = item.contact_id ? db.prepare('SELECT name FROM contacts WHERE id=?').get(item.contact_id) : null;
  const event = normalizeFinancialEvent({
    kind: EVENT_KINDS.OBLIGATION_SETTLED,
    amount,
    occurredAt: occurredAt || new Date().toISOString(),
    counterparty: contact?.name || item.title,
    counterpartyId: item.contact_id || null,
    accountId,
    reference: item.title,
    settlementDirection: item.direction,
    source: 'text',
  });
  const decision = routeEvent(event, {
    components: { amountCertainty: 1, moneyDirectionCertainty: 1, dateCertainty: 1, completeness: 1 },
    policy: automationPolicy(),
  });
  // تسویه داخل تراکنش خودش اجرا می‌شود؛ تراکنش تودرتو را SQLite نمی‌پذیرد.
  return recordFinancialEvent(db, event, {
    withinTransaction: true,
    // سند به خودِ تراکنش لنگر می‌خورد، وگرنه مهاجرت دفتر آن را بی‌سند می‌بیند و
    // دوباره سند درآمد/هزینه می‌زند.
    journalSource: { type: 'transaction', id: transactionId },
    sourceEventId: `obligation-settled:${obligationId}:${(item.paid_amount || 0) + amount}`,
    decision,
    actor: currentWorkspace()?.userId || null,
    rawInput: `تسویه ${item.title}`,
  });
}

/**
 * سند تسویهٔ تعهد از پول شخصی شریک: نه ردیف نقدی، نه درآمد یا هزینه.
 *
 * مثل `postObligationSettled` از مسیر رویداد و قاعدهٔ `accountingRules` می‌رود،
 * ولی سندش به خودِ رویداد لنگر می‌خورد؛ تراکنشی نیست که مهاجرت دفتر بخواهد
 * دوباره سندش بزند.
 */
function postObligationSettledByPartner(obligationId, item, { occurredAt, amount, payerName, payerId }) {
  const contact = item.contact_id ? db.prepare('SELECT name FROM contacts WHERE id=?').get(item.contact_id) : null;
  const event = normalizeFinancialEvent({
    kind: EVENT_KINDS.OBLIGATION_SETTLED_BY_PARTNER,
    amount,
    occurredAt: occurredAt || new Date().toISOString(),
    counterparty: contact?.name || item.title,
    counterpartyId: item.contact_id || null,
    reference: item.title,
    settlementDirection: item.direction,
    payerName,
    payerId,
    source: 'text',
  });
  const decision = routeEvent(event, {
    components: { amountCertainty: 1, moneyDirectionCertainty: 1, dateCertainty: 1, completeness: 1, counterpartyCertainty: 1 },
    policy: automationPolicy(),
  });
  return recordFinancialEvent(db, event, {
    withinTransaction: true,
    sourceEventId: `obligation-settled-by-partner:${obligationId}:${(item.paid_amount || 0) + amount}`,
    decision,
    actor: currentWorkspace()?.userId || null,
    rawInput: `تسویه ${item.title} از پول شخصی ${payerName}`,
  });
}

/**
 * تسویهٔ ماندهٔ بی‌سندِ دفتر کلِ یک طرف حساب — بدهی‌ای که ما داریم یا طلبی که از
 * او داریم، وقتی سند «طلب و بدهی» یا فاکتورِ بازی ندارد (خرید تأییدشده از صف
 * حسابدار، ماندهٔ افتتاحیه، …). سقف همان مانده‌ای است که هیچ سند بازی پوشش
 * نمی‌دهد؛ سند باز از مسیر خودش بسته می‌شود.
 *
 * دو منبع پول:
 * - صندوق یا بانک: ردیف نقدی ساخته می‌شود و سند «نقد در برابر طلب/بدهی» است.
 * - `paidBy` (شریک یا مدیرعامل): هیچ ردیف نقدی؛ سند در برابر جاری همان شریک.
 *   برای بدهی یعنی او از جیبش داد، برای طلب یعنی پول مشتری به حساب شخصی او رفت.
 */
export function settleLedgerBalance(contactId, { direction = 'payable', amount: requested, paidBy = null, occurredAt, account = 'cash', accountId, clientId = '', withinTransaction = false } = {}) {
  if (!['payable', 'receivable'].includes(direction)) throw invalidInput('جهت تسویه معتبر نیست.');
  const contact = db.prepare('SELECT id,name FROM contacts WHERE id=?').get(String(contactId || ''));
  if (!contact) throw invalidInput('طرف حساب پیدا نشد.');
  const payerName = paidBy ? String(paidBy.name || '').trim().slice(0, 120) : '';
  if (paidBy && !payerName) throw invalidInput('نام شریکی که پول از حساب شخصی او گذشته لازم است.');
  // همان کلیک یا همان پرونده دوباره رسید: نتیجهٔ قبلی، نه سند دوم.
  const sourceEventId = clientId ? `ledger-settle:${String(clientId).slice(0, 100)}` : '';
  const repeated = sourceEventId ? db.prepare('SELECT id,status,amount FROM financial_events WHERE source_event_id=?').get(sourceEventId) : null;
  const sideLeft = () => ledgerSideBalances(contact.id)[direction === 'payable' ? 'uncoveredPayable' : 'uncoveredReceivable'];
  if (repeated) return { contact: { id: contact.id, name: contact.name }, direction, amount: repeated.amount, remaining: sideLeft(), event: { id: repeated.id, status: repeated.status }, duplicate: true };
  const available = sideLeft();
  const what = direction === 'payable' ? `بدهی به «${contact.name}»` : `طلب از «${contact.name}»`;
  if (available <= 0) throw invalidInput(`در دفتر کل ماندهٔ ${what} بیرون از سندهای باز نیست.`);
  const amount = requested == null || requested === '' ? available : cleanAmount(requested);
  if (amount <= 0) throw invalidInput('مبلغ تسویه باید بیشتر از صفر باشد.');
  if (amount > available) throw invalidInput(`مبلغ از ماندهٔ ${what} در دفتر کل بیشتر است؛ مانده ${available.toLocaleString('en-US')} ${unitLabel()} است.`);
  const at = occurredAt || new Date().toISOString();
  const reference = direction === 'payable' ? 'ماندهٔ حساب پرداختنی' : 'ماندهٔ حساب دریافتنی';
  const decisionFor = (event) => routeEvent(event, {
    components: { amountCertainty: 1, moneyDirectionCertainty: 1, dateCertainty: 1, completeness: 1, counterpartyCertainty: 1 },
    policy: automationPolicy(),
  });
  const done = (posted, transactionId = null) => {
    if (!posted || posted.status !== 'posted') throw invalidInput('سند تسویه قطعی نشد؛ هیچ تغییری ثبت نشد. گفته را به صف حسابدار بفرست.');
    audit(payerName ? 'settle-balance-by-partner' : 'settle-balance', 'contact', contact.id, { direction, amount, payerName, eventId: posted.id, transactionId });
    return { contact: { id: contact.id, name: contact.name }, direction, amount, remaining: sideLeft(), event: { id: posted.id, status: posted.status }, transactionId, ...(payerName ? { paidBy: { name: payerName } } : {}) };
  };

  if (payerName) {
    const payerId = paidBy.contactId || contactIdForName(payerName, paidBy.counterpartyResolution);
    if (payerId && payerId === contact.id) throw invalidInput('پرداخت‌کننده همان طرف حساب است؛ این تسویه از پول شریک نیست.');
    const event = normalizeFinancialEvent({
      kind: EVENT_KINDS.OBLIGATION_SETTLED_BY_PARTNER, amount, occurredAt: at, counterparty: contact.name, counterpartyId: contact.id,
      reference, settlementDirection: direction, payerName, payerId, source: 'text',
    });
    return done(recordFinancialEvent(db, event, {
      sourceEventId: sourceEventId || `ledger-settle:${contact.id}:${direction}:${available}:${amount}`,
      decision: decisionFor(event), actor: currentWorkspace()?.userId || null, withinTransaction,
      rawInput: `تسویهٔ ${what} از پول شخصی ${payerName}`,
    }));
  }

  if (!withinTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const [transactionId] = insertTransactionRows({ transcript: `تسویه ${reference} ${contact.name}`, transactions: [{
      clientId: sourceEventId || `ledger-settle:${contact.id}:${direction}:${available}:${amount}`, amount,
      type: direction === 'receivable' ? 'income' : 'expense',
      category: direction === 'receivable' ? 'وصول حساب دریافتنی' : 'پرداخت حساب پرداختنی',
      rawText: `تسویه ${reference} ${contact.name}`, source: 'text', contactId: contact.id, occurredAt: at, account, accountId,
      status: 'allocated', journalManaged: true,
    }] });
    const event = normalizeFinancialEvent({
      kind: EVENT_KINDS.OBLIGATION_SETTLED, amount, occurredAt: at, counterparty: contact.name, counterpartyId: contact.id,
      accountId: resolveAccountId({ account, accountId }), reference, settlementDirection: direction, source: 'text',
    });
    const posted = recordFinancialEvent(db, event, {
      withinTransaction: true, journalSource: { type: 'transaction', id: transactionId },
      sourceEventId: sourceEventId || `ledger-settle:${transactionId}`,
      decision: decisionFor(event), actor: currentWorkspace()?.userId || null, rawInput: `تسویه ${reference} ${contact.name}`,
    });
    const result = done(posted, transactionId);
    if (!withinTransaction) db.exec('COMMIT');
    return result;
  } catch (error) { if (!withinTransaction) db.exec('ROLLBACK'); throw error; }
}

/** سازگاری با کلاینت قبلی: بدهیِ دفتر کل از پول شریک. */
export function settlePayableBalanceByPartner(contactId, options = {}) {
  return settleLedgerBalance(contactId, { ...options, direction: 'payable' });
}
