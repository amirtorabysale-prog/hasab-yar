import { useEffect, useState } from 'react';
import { persianToISO } from '../../shared/persianDate.js';

export const EMPTY_SUMMARY = { income: 0, expense: 0, netCashFlow: 0, profit: 0, comparison: null };

export function digitsOnly(value) {
  return String(value ?? '').replace(/[^\d۰-۹٠-٩]/g, '').replace(/[۰-۹٠-٩]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) >= 0 ? String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)) : String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

/** ISO به متن شمسی، برای نمایش داخل ورودی. */
function isoToPersianInput(iso, timeZone = 'Asia/Tehran') {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).filter((part) => part.type !== 'literal')
    .reduce((value, part) => ({ ...value, [part.type]: part.value }), {});
  return `${parts.year}/${parts.month}/${parts.day}`;
}

function toLatinDigits(value) {
  return String(value || '').replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

/**
 * ورودی تاریخ شمسی.
 *
 * <input type="date"> همیشه میلادی نشان می‌دهد و برای کاربر ایرانی بی‌معناست:
 * «۲۰۲۶/۰۸/۰۶» هیچ نمی‌گوید، «۱۴۰۵/۰۵/۱۵» همه‌چیز. تاریخ به‌صورت متن شمسی
 * گرفته و نشان داده می‌شود و تبدیل همین‌جا انجام می‌گیرد.
 *
 * تا وقتی کاربر در حال تایپ است مقدار بیرونی روی متن او نوشته نمی‌شود، وگرنه
 * نیمهٔ تایپ‌شده مدام پاک می‌شد.
 */
export function PersianDateInput({ value, onChange, placeholder = '۱۴۰۵/۰۵/۱۵', className = '' }) {
  const [text, setText] = useState(() => isoToPersianInput(value));
  const [typing, setTyping] = useState(false);
  useEffect(() => { if (!typing) setText(isoToPersianInput(value)); }, [value, typing]);
  const commit = (raw) => {
    setText(raw);
    setTyping(true);
    const digits = toLatinDigits(raw).trim();
    if (!digits) { onChange(''); return; }
    const match = digits.match(/^(\d{4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})$/);
    if (!match) return;
    const iso = persianToISO(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso) onChange(iso);
  };
  const typed = toLatinDigits(text).trim();
  const invalid = Boolean(typed) && !value;
  return <span className="block">
    <input
      dir="ltr" inputMode="numeric" value={text} placeholder={placeholder}
      onChange={(event) => commit(event.target.value)} onBlur={() => setTyping(false)}
      className={`tap w-full rounded-lg border px-3 text-left numbers ${invalid ? 'border-expense' : 'border-line'} ${className}`}
    />
    {invalid && <span className="mt-1 block text-[10px] text-expense">تاریخ شمسی را به شکل ۱۴۰۵/۰۵/۱۵ بنویس.</span>}
  </span>;
}
