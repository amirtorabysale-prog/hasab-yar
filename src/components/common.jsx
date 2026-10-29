import { QuickDateInput } from './QuickDateInput.jsx';

export const EMPTY_SUMMARY = { income: 0, expense: 0, netCashFlow: 0, profit: 0, comparison: null };

export function digitsOnly(value) {
  return String(value ?? '').replace(/[^\d۰-۹٠-٩]/g, '').replace(/[۰-۹٠-٩]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) >= 0 ? String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)) : String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

/**
 * ورودی تاریخ شمسی — همان انتخاب‌گر سریع (QuickDateInput.jsx) با مقدار ISO.
 *
 * <input type="date"> همیشه میلادی نشان می‌دهد و برای کاربر ایرانی بی‌معناست؛
 * تایپ «۱۴۰۵/۰۵/۱۵» هم کند و پرخطا بود. `direction` می‌گوید «۲۵» تنها گذشته است
 * (تاریخ وقوع) یا آینده (سررسید).
 */
export function PersianDateInput({ value, onChange, className = '', direction = 'any', ...rest }) {
  return <QuickDateInput value={value} onChange={onChange} className={className} direction={direction} {...rest} />;
}
