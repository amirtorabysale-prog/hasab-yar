/**
 * «این پول تسویهٔ حساب اوست یا هزینه؟» — یک قاعده، سه مصرف‌کننده.
 *
 * برگهٔ تأیید باید پیش از ثبت بگوید پول کجا می‌رود، سرور باید سند را همان‌جا
 * بزند، و لایهٔ رویداد باید همان را بفهمد. اگر هر کدام قاعدهٔ خودش را داشت،
 * دقیقاً همان چیزی پیش می‌آمد که کاربر دید: برگه «سایر هزینه‌ها» وعده می‌داد
 * و دفتر چیز دیگری ثبت می‌کرد. آنچه دیده می‌شود همان است که باور می‌شود؛
 * برگه‌ای که چیز دیگری بگوید اعتماد را از بین می‌برد، حتی وقتی دفتر درست است.
 *
 * قاعده از ماندهٔ واقعی می‌آید، نه از واژه‌های جمله:
 * پول رفت و به او بدهکار بودیم → بدهی‌اش کم می‌شود.
 * پول آمد و او به ما بدهکار بود → طلبمان کم می‌شود.
 * هر حالت دیگری همان هزینه یا درآمد عادی است — وگرنه هر خرید نقدی از یک
 * فروشندهٔ شناخته‌شده به‌جای هزینه یک طلب می‌ساخت و سود دوره هیچ‌وقت درست
 * نمی‌شد.
 */

import { canonicalCounterpartyName } from './counterpartyIdentity.js';

/** مثبت یعنی او به ما بدهکار است. */
export function settlementDirection(type, balance) {
  const amount = Number(balance) || 0;
  if (type === 'expense' && amount < 0) return 'payable';
  if (type === 'income' && amount > 0) return 'receivable';
  return null;
}

/**
 * پیش‌نمایش برای برگهٔ تأیید: این ثبت به حساب چه کسی می‌نشیند.
 *
 * `null` یعنی جمله اصلاً طرف حسابی نداشت. شیءِ با `direction: null` یعنی
 * شخص شناخته شد ولی این ثبت تسویه نیست — نامش دیده می‌شود، ادعایی نمی‌شود.
 */
export function settlementPreview(item, contacts = []) {
  const name = String(item?.contactName || '').trim();
  if (!name) return null;
  const canonical = canonicalCounterpartyName(name);
  const contact = contacts.find((entry) => canonicalCounterpartyName(entry.name) === canonical) || null;
  const balance = Number(contact?.balance) || 0;
  return {
    name: contact?.name || name,
    contact,
    balance,
    direction: contact ? settlementDirection(item.type, balance) : null,
  };
}
