// سال مالی دلخواه: هر دفتر یک «ماه شروع» دارد (۱ = فروردین تا ۱۲ = اسفند).
//
// نام سال مالی، سالِ شمسی‌ای است که سال در آن تمام می‌شود — همان «سال مالی منتهی به
// ۱۴۰۴/۰۶/۳۱» که در اظهارنامه و صورت‌های مالی نوشته می‌شود. با شروع از فروردین، سال مالی
// همان سال شمسی است و هیچ دفتر قدیمی‌ای چیزی را عوض‌شده نمی‌بیند.
//
// همهٔ محاسبه‌ها روی «کلید روز» شمسی (`1404-07-01`) و «کلید دوره» (`1404-07`) است تا سمت
// سرور و رابط یک قاعده داشته باشند.

export const PERSIAN_MONTH_NAMES = Object.freeze(['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند']);

export function normalizeFiscalStartMonth(value) {
  const month = Number(value);
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : 1;
}

/** سال مالیِ یک سال و ماه شمسی. */
export function fiscalYearOf(year, month, startMonth = 1) {
  const start = normalizeFiscalStartMonth(startMonth);
  return start === 1 || Number(month) < start ? Number(year) : Number(year) + 1;
}

/** سال مالیِ یک کلید روز یا دوره (`YYYY-MM…`). */
export function fiscalYearOfKey(key, startMonth = 1) {
  const [year, month] = String(key).split('-').map(Number);
  return fiscalYearOf(year, month, startMonth);
}

/** ماه اول و آخر سال مالی، و دوازده دوره‌اش به ترتیب. */
export function fiscalYearMonths(fiscalYear, startMonth = 1) {
  const start = normalizeFiscalStartMonth(startMonth);
  const first = { year: start === 1 ? Number(fiscalYear) : Number(fiscalYear) - 1, month: start };
  const periods = Array.from({ length: 12 }, (_, index) => {
    const offset = first.month - 1 + index;
    return { year: first.year + Math.floor(offset / 12), month: (offset % 12) + 1 };
  });
  return { first, last: periods[11], periods: periods.map(({ year, month }) => `${year}-${String(month).padStart(2, '0')}`), months: periods };
}

/** کلید روز اولِ سال مالیِ یک روز. */
export function fiscalYearStartKey(dayKey, startMonth = 1) {
  const { first } = fiscalYearMonths(fiscalYearOfKey(dayKey, startMonth), startMonth);
  return `${first.year}-${String(first.month).padStart(2, '0')}-01`;
}

/** برچسب کوتاه: «۱۴۰۴» برای سال شمسی، «منتهی به شهریور ۱۴۰۴» برای سال دلخواه. */
export function fiscalYearLabel(fiscalYear, startMonth = 1) {
  const start = normalizeFiscalStartMonth(startMonth);
  if (start === 1) return String(fiscalYear);
  const { last } = fiscalYearMonths(fiscalYear, start);
  return `منتهی به ${PERSIAN_MONTH_NAMES[last.month - 1]} ${last.year}`;
}
