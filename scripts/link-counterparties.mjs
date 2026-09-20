/**
 * وصل‌کردن ثبت‌های قدیمی به طرف حسابی که نامشان در متن خودشان است.
 *
 * تا پیش از این، مسیر ثبت تراکنش نام طرف حساب را درنمی‌آورد. «۹۳ میلیون
 * تومان به شرکت آراد گستر آسیا پرداخت شد» یک هزینهٔ ساده می‌شد و هیچ‌وقت به
 * کارت آن شرکت نمی‌رسید. ثبت‌های تازه از حالا وصل می‌شوند؛ این اسکریپت
 * همان کار را برای گذشته می‌کند.
 *
 * سه قید، چون روی دفتر واقعی اجرا می‌شود:
 *
 * ۱. **پیش‌فرض فقط گزارش است.** بدون `--apply` هیچ‌چیز نوشته نمی‌شود. روی
 *    دادهٔ مالی، دیدنِ نتیجه پیش از اعمالش شرط است نه تجمل.
 * ۲. **ثبتی که از قبل طرف حساب دارد دست نمی‌خورد.** انتخاب کاربر از حدسِ
 *    متن مهم‌تر است.
 * ۳. **نام مشابه، خودکار ادغام نمی‌شود.** «آرمان» و «شرکت آرمان» ممکن است
 *    یکی باشند یا نباشند؛ اسکریپت این‌ها را جدا گزارش می‌کند تا خودت
 *    تصمیم بگیری. حدسِ خاموش روی طرف حساب یعنی سند به دفترِ اشتباه می‌رود.
 *
 * هیچ سندی بازنویسی نمی‌شود: کارت حساب ثبت‌های مستقیم را از روی `contact_id`
 * می‌خواند، پس پرکردن همین یک ستون کافی است و حسابداری دست‌نخورده می‌ماند.
 *
 *   node scripts/link-counterparties.mjs            # فقط گزارش
 *   node scripts/link-counterparties.mjs --apply    # اعمال
 *   node scripts/link-counterparties.mjs --apply --create   # طرف حساب نبود، بساز
 */
import { extractContactName } from '../shared/voiceIntent.js';
import {
  allWorkspaces, audit, db, listContacts, runInWorkspace, saveContact,
} from '../server/db.js';

const apply = process.argv.includes('--apply');
const create = process.argv.includes('--create');
const fa = (value) => new Intl.NumberFormat('fa-IR').format(value);

function planForWorkspace() {
  const rows = db.prepare(`SELECT id,amount,type,raw_text AS rawText,occurred_at AS occurredAt
    FROM transactions WHERE (contact_id IS NULL OR contact_id='') AND status!='allocated'`).all();
  const contacts = listContacts();
  const byName = new Map(contacts.map((contact) => [contact.name.trim(), contact]));

  const linked = [];
  const missing = new Map();
  for (const row of rows) {
    const name = extractContactName(String(row.rawText || ''));
    if (!name) continue;
    const contact = byName.get(name.trim());
    if (contact) linked.push({ row, contact });
    else missing.set(name, [...(missing.get(name) || []), row]);
  }
  return { scanned: rows.length, linked, missing };
}

let totalLinked = 0;
let totalCreated = 0;
const workspaces = allWorkspaces();

for (const workspace of workspaces) {
  runInWorkspace(workspace.id, { userId: 'backfill', role: 'owner' }, () => {
    const plan = planForWorkspace();
    if (!plan.linked.length && !plan.missing.size) return;

    console.log(`\n▸ دفتر «${workspace.name}» — ${fa(plan.scanned)} ثبت بدون طرف حساب بررسی شد`);

    for (const { row, contact } of plan.linked) {
      console.log(`   ${row.occurredAt.slice(0, 10)}  ${fa(row.amount)} تومان  →  ${contact.name}`);
      if (!apply) continue;
      db.prepare('UPDATE transactions SET contact_id=? WHERE id=?').run(contact.id, row.id);
      audit('link-counterparty', 'transaction', row.id, { contactId: contact.id, name: contact.name });
      totalLinked += 1;
    }

    for (const [name, items] of plan.missing) {
      const sum = items.reduce((total, item) => total + Number(item.amount || 0), 0);
      if (!create) {
        console.log(`   ⚠ «${name}» طرف حسابی ندارد — ${fa(items.length)} ثبت، ${fa(sum)} تومان (با --create ساخته می‌شود)`);
        continue;
      }
      // نام مشابه از اینجا رد نمی‌شود: `saveContact` خطای طرف حساب مشابه
      // می‌دهد و اسکریپت به‌جای حدس‌زدن، آن را گزارش می‌کند.
      let contact = null;
      try { contact = apply ? saveContact({ name }) : { id: 'می‌سازد', name }; }
      catch (error) {
        console.log(`   ⚠ «${name}» شبیه یک طرف حساب موجود است؛ خودت تصمیم بگیر (${error.code || 'نامشخص'})`);
        continue;
      }
      console.log(`   + «${name}» ساخته شد — ${fa(items.length)} ثبت، ${fa(sum)} تومان`);
      if (!apply) continue;
      totalCreated += 1;
      for (const item of items) {
        db.prepare('UPDATE transactions SET contact_id=? WHERE id=?').run(contact.id, item.id);
        audit('link-counterparty', 'transaction', item.id, { contactId: contact.id, name });
        totalLinked += 1;
      }
    }
  });
}

console.log(`\n${apply ? `✅ ${fa(totalLinked)} ثبت وصل شد` : 'گزارش بود؛ چیزی نوشته نشد'}${totalCreated ? ` و ${fa(totalCreated)} طرف حساب ساخته شد` : ''}.`);
if (!apply) console.log('برای اعمال: node scripts/link-counterparties.mjs --apply');
