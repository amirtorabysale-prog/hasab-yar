const fa = new Intl.NumberFormat('fa-IR');

export const formatAmount = (value) => fa.format(Math.round(Number(value) || 0));
export const formatSignedAmount = (item) => `${item.type === 'income' ? '+' : '−'} ${formatAmount(item.amount)}`;
export const toPersianDigits = (value) => String(value).replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[digit]);
export const todayKey = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const persianDateFormat = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', weekday: 'long', day: 'numeric', month: 'long' });
const clockFormat = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' });

// Intl.format روی رشته خطای «Invalid time value» می‌دهد و چون این تابع داخل
// رندر صدا زده می‌شود، همان خطا کل صفحه را سفید می‌کرد. تاریخ‌ها از API
// همیشه رشتهٔ ISO هستند، پس تبدیل و کنترل اعتبار باید همین‌جا انجام شود.
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const persianDate = (date = new Date()) => {
  const parsed = toDate(date);
  return parsed ? persianDateFormat.format(parsed) : '—';
};

export const clock = (iso) => {
  const parsed = toDate(iso);
  return parsed ? clockFormat.format(parsed) : '—';
};
