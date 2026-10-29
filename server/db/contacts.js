import { randomUUID } from 'node:crypto';
import { audit, db, invalidInput } from './core.js';
import { normalizedCounterpartyInput, resolveCounterparty } from '../counterparties.js';
import { counterpartyBalance, ledgerSideBalances } from './counterpartyCard.js';

/**
 * فهرست اشخاص با ماندهٔ واقعی.
 *
 * مانده از همان‌جایی می‌آید که کارت حساب می‌خواند، نه از جمع‌زدن دوبارهٔ
 * تعهدها و فاکتورها. دو محاسبهٔ جدا برای یک عدد، همیشه سرِ اولین حالتی که
 * یکی‌شان ندیده از هم جدا می‌شوند — و آن‌وقت صفحه دو رقم متفاوت نشان می‌دهد
 * و هیچ‌کدام معلوم نیست کدام درست است.
 */
export function listContacts() {
  const rows = db.prepare(`SELECT contacts.id,contacts.name,contacts.kind,contacts.role,contacts.phone,contacts.note,
    (SELECT COUNT(*) FROM obligations WHERE obligations.contact_id=contacts.id AND obligations.status='open')
    + (SELECT COUNT(*) FROM invoices WHERE invoices.contact_id=contacts.id AND invoices.status='sent') AS openCount
    FROM contacts ORDER BY contacts.updated_at DESC,contacts.name`).all();
  // ماندهٔ بی‌سندِ دفتر کل: کارت تسویه بدهی یا طلبی را که فقط در دفتر کل است هم می‌بیند.
  return rows.map((row) => {
    const { uncoveredPayable, uncoveredReceivable } = ledgerSideBalances(row.id);
    return { ...row, balance: counterpartyBalance(row.id), uncoveredPayable, uncoveredReceivable };
  });
}

export function saveContact(values = {}) {
  const { displayName: name, canonicalName } = normalizedCounterpartyInput(values.name);
  if (name.length < 2) throw invalidInput('نام شخص را کامل وارد کن.');
  // نام مشابهِ موجود، بدون پاسخ ثبت‌کننده، به پرسش تبدیل می‌شود نه به ادغام.
  const matched = values.id ? null : resolveCounterparty(db, name, values.counterpartyResolution).contact;
  const id = values.id || matched?.id || randomUUID();
  const storedName = matched?.name || name;
  // پرسنل و شریک نقش‌اند روی «شخص»؛ نوع فاکتور و تعهد سه‌مقداری می‌ماند.
  // نقشِ نفرستاده (فرمی که فقط نوع را عوض می‌کند) نقش قبلی را پاک نمی‌کند.
  const roleGiven = values.role !== undefined;
  const role = ['employee', 'partner'].includes(values.role) ? values.role : '';
  const kind = role ? 'person' : ['person', 'customer', 'vendor'].includes(values.kind) ? values.kind : 'person';
  // ویرایش صریح (با شناسه) انتخاب کاربر را می‌نشاند. قاعدهٔ «در تعارض، شخص» فقط
  // برای وقتی است که ثبتی تازه به طرف حساب موجود رسیده؛ اعمالش روی ویرایش یعنی
  // تغییر «شخص» به «مشتری» هیچ‌وقت ذخیره نمی‌شد.
  const explicitEdit = values.id ? 1 : 0;
  db.prepare(`INSERT INTO contacts (id,name,canonical_name,kind,role,phone,note) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,canonical_name=excluded.canonical_name,
      kind=CASE WHEN ${explicitEdit} THEN excluded.kind WHEN contacts.kind=excluded.kind THEN contacts.kind ELSE 'person' END,
      role=CASE WHEN ${explicitEdit} AND ${roleGiven ? 1 : 0} THEN excluded.role WHEN contacts.role='' THEN excluded.role ELSE contacts.role END,
      phone=CASE WHEN excluded.phone='' THEN contacts.phone ELSE excluded.phone END,
      note=CASE WHEN excluded.note='' THEN contacts.note ELSE excluded.note END,updated_at=CURRENT_TIMESTAMP`)
    .run(id, storedName, canonicalName, kind, role, String(values.phone || '').slice(0, 30), String(values.note || '').slice(0, 500));
  audit(values.id || matched ? 'update' : 'create', 'contact', id, { name: storedName, kind, role, canonicalName });
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
