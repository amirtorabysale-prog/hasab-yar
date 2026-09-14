import { randomUUID } from 'node:crypto';
import { audit, db, invalidInput } from './core.js';
import { normalizedCounterpartyInput, resolveCounterparty } from '../counterparties.js';

export function listContacts() {
  return db.prepare(`SELECT contacts.id,contacts.name,contacts.kind,contacts.phone,contacts.note,
    COALESCE((SELECT SUM(CASE WHEN obligations.direction='receivable' THEN obligations.amount ELSE -obligations.amount END)
      FROM obligations WHERE obligations.contact_id=contacts.id AND obligations.status='open'),0)
    + COALESCE((SELECT SUM(CASE WHEN invoices.document_type='sales' THEN invoices.total-COALESCE((SELECT SUM(invoice_payments.amount) FROM invoice_payments WHERE invoice_payments.invoice_id=invoices.id),0)
      ELSE -(invoices.total-COALESCE((SELECT SUM(invoice_payments.amount) FROM invoice_payments WHERE invoice_payments.invoice_id=invoices.id),0)) END)
      FROM invoices WHERE invoices.contact_id=contacts.id AND invoices.status IN ('sent','paid')),0) AS balance,
    (SELECT COUNT(*) FROM obligations WHERE obligations.contact_id=contacts.id AND obligations.status='open')
    + (SELECT COUNT(*) FROM invoices WHERE invoices.contact_id=contacts.id AND invoices.status='sent') AS openCount
    FROM contacts ORDER BY contacts.updated_at DESC,contacts.name`).all();
}

export function saveContact(values = {}) {
  const { displayName: name, canonicalName } = normalizedCounterpartyInput(values.name);
  if (name.length < 2) throw invalidInput('نام شخص را کامل وارد کن.');
  // نام مشابهِ موجود، بدون پاسخ ثبت‌کننده، به پرسش تبدیل می‌شود نه به ادغام.
  const matched = values.id ? null : resolveCounterparty(db, name, values.counterpartyResolution).contact;
  const id = values.id || matched?.id || randomUUID();
  const storedName = matched?.name || name;
  const kind = ['person', 'customer', 'vendor'].includes(values.kind) ? values.kind : 'person';
  // ویرایش صریح (با شناسه) انتخاب کاربر را می‌نشاند. قاعدهٔ «در تعارض، شخص» فقط
  // برای وقتی است که ثبتی تازه به طرف حساب موجود رسیده؛ اعمالش روی ویرایش یعنی
  // تغییر «شخص» به «مشتری» هیچ‌وقت ذخیره نمی‌شد.
  const explicitEdit = values.id ? 1 : 0;
  db.prepare(`INSERT INTO contacts (id,name,canonical_name,kind,phone,note) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,canonical_name=excluded.canonical_name,
      kind=CASE WHEN ${explicitEdit} THEN excluded.kind WHEN contacts.kind=excluded.kind THEN contacts.kind ELSE 'person' END,
      phone=CASE WHEN excluded.phone='' THEN contacts.phone ELSE excluded.phone END,
      note=CASE WHEN excluded.note='' THEN contacts.note ELSE excluded.note END,updated_at=CURRENT_TIMESTAMP`)
    .run(id, storedName, canonicalName, kind, String(values.phone || '').slice(0, 30), String(values.note || '').slice(0, 500));
  audit(values.id || matched ? 'update' : 'create', 'contact', id, { name: storedName, kind, canonicalName });
  return listContacts().find((item) => item.id === id);
}

export function deleteContact(id) {
  const result = db.prepare('DELETE FROM contacts WHERE id=?').run(id);
  if (result.changes) audit('delete', 'contact', id);
  return result.changes > 0;
}

/**
 * نام گفته‌شده را به شخص موجود وصل می‌کند و اگر نبود، می‌سازد.
 *
 * وقتی کاربر می‌گوید «حسن بدهکار شد»، انتظارش این نیست که اول برود شخص را
 * دستی اضافه کند. اما شخص تکراری هم نباید ساخته شود، وگرنه ماندهٔ یک نفر بین دو
 * ردیف پخش می‌شود: نام با همان نرمال‌سازی فارسیِ بقیهٔ محصول مقایسه می‌شود، پس
 * «مرتضي» و «مرتضی» یک نفرند.
 */
export function contactIdForName(name, resolution = '') {
  const clean = String(name || '').trim().slice(0, 100);
  if (clean.length < 2) return null;
  const { contact } = resolveCounterparty(db, clean, resolution);
  if (contact) return contact.id;
  // «جدا» یعنی ثبت‌کننده گفته این طرف حساب دیگری است؛ ساختنش دوباره پرسیده نمی‌شود.
  return saveContact({ name: clean, counterpartyResolution: 'separate' })?.id || null;
}
