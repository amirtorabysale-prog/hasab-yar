import { audit } from './core.js';

/**
 * رویدادِ مالی‌ای که پشتش یک سند پایه نشسته — ردیف فاکتور، چک، طلب و بدهی.
 *
 * سند دفتر کلِ این رویدادها مال خودِ سند پایه است: ردیف خدمتِ فاکتور روی سند
 * صدور فاکتور (لنگر `invoice`) می‌نشیند، چک روی `cheque_record`، طلب و بدهی روی
 * رویداد `obligation:…`. اگر رویداد از صف بررسی تنها برگردد یا رد شود و سند
 * پایه همچنان زنده بماند، فهرست و دفتر دو عدد می‌گویند:
 *
 * - برگشتِ یک ردیف، کل سند فاکتور را برمی‌گرداند ولی فاکتور «صادرشده» می‌ماند؛
 *   پرداختش حساب پرداختنی را بدهکار و بانک را منفی می‌کرد و برنامهٔ ردیف دیگر
 *   پیش‌پرداخت را منفی.
 * - چکِ رویدادِ برگشته یا ردشده باز می‌ماند؛ وصولش اسناد پرداختنی را بدهکار
 *   می‌کرد و چک ردشده تا ابد در «چک‌های باز» می‌ماند (وصول و برگشت هر دو قفل).
 * - طلب و بدهیِ رویدادِ برگشته در فهرست باز بود و در دفتر صفر.
 *
 * پس: ردیف فاکتور تنها برنمی‌گردد (فاکتور ابطال می‌شود)؛ چک و طلب/بدهیِ باز همراه
 * رویدادشان ابطال می‌شوند؛ چک وصول‌شده یا طلبِ تسویه‌شده اول باید اصلاح شوند.
 */
function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function conflict(message, code) {
  return Object.assign(new Error(message), { code, status: 409 });
}

export function documentBehindEvent(database, eventId) {
  const row = database.prepare('SELECT source_event_id AS source, journal_source AS journalSource FROM financial_events WHERE id=?')
    .get(String(eventId || ''));
  if (!row) return null;
  const source = String(row.source || '');
  let anchor = null;
  try { anchor = row.journalSource ? JSON.parse(row.journalSource) : null; } catch { anchor = null; }

  if ((source.startsWith('invoice-line:') || anchor?.type === 'invoice') && tableExists(database, 'invoices')) {
    const invoice = source.startsWith('invoice-line:')
      ? database.prepare(`SELECT i.id,i.number,i.status FROM invoices i JOIN invoice_items ii ON ii.invoice_id=i.id WHERE ii.id=?`)
        .get(source.slice('invoice-line:'.length))
      : database.prepare('SELECT id,number,status FROM invoices WHERE id=?').get(String(anchor.id || ''));
    return invoice ? { kind: 'invoice', ...invoice } : null;
  }
  const chequeId = source.startsWith('cheque:') ? source.slice('cheque:'.length) : anchor?.type === 'cheque_record' ? String(anchor.id || '') : '';
  if (chequeId && tableExists(database, 'cheques')) {
    const cheque = database.prepare('SELECT id,status,counterparty_name AS name FROM cheques WHERE id=?').get(chequeId);
    return cheque ? { kind: 'cheque', ...cheque } : null;
  }
  const obligation = /^obligation:([^#]+)/.exec(source);
  if (obligation && tableExists(database, 'obligations')) {
    const item = database.prepare('SELECT id,status,title,COALESCE(paid_amount,0) AS paidAmount FROM obligations WHERE id=?').get(obligation[1]);
    // فقط رویدادِ جاریِ آن طلب/بدهی؛ نسخه‌های قبلیِ ویرایش، تاریخچه‌اند.
    const current = database.prepare(`SELECT id FROM financial_events WHERE (source_event_id=? OR source_event_id LIKE ?)
      ORDER BY rowid DESC LIMIT 1`).get(`obligation:${obligation[1]}`, `obligation:${obligation[1]}#r%`);
    return item && current?.id === String(eventId) ? { kind: 'obligation', ...item } : null;
  }
  return null;
}

/**
 * پیش از برگشت یا ردِ رویداد از صف بررسی: آیا سند پایه اجازه می‌دهد؟
 * `action`: «reverse» یا «reject».
 */
export function assertEventChangeAllowed(database, eventId, action = 'reverse') {
  const document = documentBehindEvent(database, eventId);
  if (!document) return null;
  const verb = action === 'reject' ? 'رد' : 'برگشت';
  if (document.kind === 'invoice' && document.status !== 'cancelled') {
    throw conflict(`این رویداد یک ردیف فاکتور ${document.number || ''} است و سندش همان سند صدور فاکتور است؛ ${verb} تنهایش کل فاکتور را در دفتر برمی‌گرداند و فاکتور باز می‌ماند. خودِ فاکتور را ابطال کن.`,
      'EVENT_OWNED_BY_INVOICE');
  }
  if (document.kind === 'cheque' && document.status !== 'open') {
    throw conflict(`این چک پیش‌تر وصول یا تعیین تکلیف شده؛ ${verb} سند ثبتش حساب اسناد را نیمه‌کاره می‌گذارد. اول وصول یا برگشت چک را اصلاح کن.`,
      'CHEQUE_EVENT_DEPENDENCY');
  }
  if (document.kind === 'obligation' && (document.status === 'paid' || Number(document.paidAmount) > 0)) {
    throw conflict(`طلب/بدهی «${document.title}» (یا بخشی از آن) تسویه شده؛ ${verb} سند ایجادش تسویه را بی‌پشتوانه می‌گذارد. اول تسویه را اصلاح کن.`,
      'OBLIGATION_EVENT_DEPENDENCY');
  }
  return document;
}

/** پس از برگشت یا رد: چک یا طلب/بدهیِ بازِ پشت رویداد هم ابطال می‌شود. */
export function retireDocumentBehindEvent(database, document, { eventId, action = 'reverse' } = {}) {
  if (!document) return;
  if (document.kind === 'cheque' && document.status === 'open') {
    const changed = database.prepare("UPDATE cheques SET status='cancelled' WHERE id=? AND status='open'").run(document.id).changes;
    if (changed) audit('cancel', 'cheque', document.id, { because: 'financial-event', action, eventId });
  }
  if (document.kind === 'obligation' && document.status === 'open') {
    const changed = database.prepare("UPDATE obligations SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").run(document.id).changes;
    if (changed) audit('cancel', 'obligation', document.id, { because: 'financial-event', action, eventId });
  }
}
