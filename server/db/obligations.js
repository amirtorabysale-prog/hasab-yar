import { randomUUID } from 'node:crypto';
import { EVENT_KINDS, normalizeFinancialEvent } from '../../shared/financialEvent.js';
import { audit, cleanAmount, currentWorkspace, db, invalidInput } from './core.js';
import { automationPolicy } from './settings.js';
import { contactIdForName } from './contacts.js';
import { ensureFinancialEventSchema, findEventBySource, recordFinancialEvent } from '../financialEventStore.js';
import { insertTransactionRows, transactionRow } from './transactions.js';
import { resolveAccountId } from './accounts.js';
import { routeEvent } from '../../shared/confidenceEngine.js';

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
    LEFT JOIN financial_events AS opened ON opened.source_event_id='obligation:' || obligations.id
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
  const id = values.id || randomUUID();
  db.prepare(`INSERT INTO obligations (id,contact_id,title,amount,direction,due_at,occurred_at,status,note) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET contact_id=excluded.contact_id,title=excluded.title,amount=excluded.amount,
      direction=excluded.direction,due_at=excluded.due_at,occurred_at=excluded.occurred_at,status=excluded.status,note=excluded.note,updated_at=CURRENT_TIMESTAMP`)
    .run(id, contactId, title, amount, direction, values.dueAt || null, values.occurredAt || null, ['open', 'paid', 'cancelled'].includes(values.status) ? values.status : 'open', String(values.note || '').slice(0, 500));
  audit(values.id ? 'update' : 'create', 'obligation', id, { amount, direction, title });
  // تعهدِ باز تا امروز هیچ سندی در دفتر نمی‌زد، پس نه در تراز دیده می‌شد و نه در
  // فایل انتقال پارسیان. طلب و بدهی رویداد مستقل‌اند: حق دریافت یا تعهد پرداخت
  // همان لحظه ساخته می‌شود، حتی وقتی هنوز پولی جابه‌جا نشده.
  //
  // فقط تعهد تازه سند می‌گیرد؛ ویرایش یک تعهد موجود سند دوم نمی‌سازد، چون شناسهٔ
  // منبع یکتاست و لایهٔ رویداد همان نتیجهٔ قبلی را برمی‌گرداند.
  if (!values.id) {
    postObligationOpened(id, { amount, direction, title, contactId, occurredAt: values.occurredAt, note: values.note });
  }
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
export function settleObligation(id, { occurredAt, account = 'cash', accountId, amount: requested } = {}) {
  const item = db.prepare("SELECT * FROM obligations WHERE id=? AND status='open'").get(id);
  if (!item) return null;
  // تعهدهای قدیمی ممکن است قبلاً در دفتر یا در فاکتور دیگری شناسایی شده باشند.
  // هیچ راه مطمئنی برای حدسِ حساب مقابل از عنوان آن‌ها نداریم؛ مسیر قدیمی هنگام
  // وصول، «درآمد/هزینهٔ تازه» می‌ساخت. پیش از هر تغییر در مانده یا تراکنش متوقف شو.
  const opened = findEventBySource(db, `obligation:${id}`);
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
    throw invalidInput(`مبلغ تسویه از ماندهٔ این تعهد بیشتر است؛ مانده ${remaining.toLocaleString('en-US')} تومان است.`);
  }
  let transactionId;
  db.exec('BEGIN IMMEDIATE');
  try {
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
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { item: listObligations({ status: 'all' }).find((row) => row.id === id), transaction: transactionRow(transactionId) };
}

export function deleteObligation(id) {
  const result = db.prepare('DELETE FROM obligations WHERE id=?').run(id);
  if (result.changes) audit('delete', 'obligation', id);
  return result.changes > 0;
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
function postObligationOpened(obligationId, { amount, direction, title, contactId, occurredAt, note }) {
  try {
    const contact = contactId ? db.prepare('SELECT name FROM contacts WHERE id=?').get(contactId) : null;
    const event = normalizeFinancialEvent({
      kind: direction === 'receivable' ? EVENT_KINDS.RECEIVABLE_OPENED : EVENT_KINDS.PAYABLE_OPENED,
      amount,
      occurredAt: occurredAt || new Date().toISOString(),
      counterparty: contact?.name || title,
      counterpartyId: contactId || null,
      category: direction === 'receivable' ? 'سایر درآمدها' : 'سایر هزینه‌ها',
      description: title,
      source: 'text',
      evidence: note || title,
    });
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
      sourceEventId: `obligation:${obligationId}`,
      decision,
      actor: currentWorkspace()?.userId || null,
      rawInput: title,
    });
  } catch (error) {
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
