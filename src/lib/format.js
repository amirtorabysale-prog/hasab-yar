const fa = new Intl.NumberFormat('fa-IR');

export const formatAmount = (value) => fa.format(Math.round(Number(value) || 0));
export const formatSignedAmount = (item) => `${item.type === 'income' ? '+' : '−'} ${formatAmount(item.amount)}`;
export const toPersianDigits = (value) => String(value).replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[digit]);
export const todayKey = () => new Date().toISOString().slice(0, 10);
export const persianDate = (date = new Date()) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
export const clock = (iso) => new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
