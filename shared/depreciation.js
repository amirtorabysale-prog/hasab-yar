/**
 * استهلاک خط مستقیم.
 *
 * این ماژول به دیتابیس دست نمی‌زند و فقط جدول استهلاک را می‌سازد، تا بشود همهٔ
 * حالت‌های مرزی را بدون سند و بدون دفتر آزمود.
 *
 * مهم‌ترین خاصیتی که تضمین می‌کند: **جمع اقساط دقیقاً برابر بهای مستهلک‌شدنی
 * است.** تقسیم ساده و گردکردن هر قسط، در پنج سال چند هزار تومان رانش می‌سازد و
 * ارزش دفتری دارایی هیچ‌وقت صفر نمی‌شود — دارایی‌ای که تا ابد چند تومان ارزش
 * دارد، هر سال در تراز می‌ماند و حسابدار باید دستی ببنددش.
 */

/** ماه شمسی بعدی؛ ورودی و خروجی هر دو «YYYY-MM». */
export function nextPersianMonth(month) {
  const [year, index] = String(month).split('-').map(Number);
  if (!year || !index) return '';
  return index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, '0')}`;
}

/** فاصلهٔ دو ماه شمسی بر حسب ماه؛ منفی یعنی ماه دوم جلوتر است. */
export function monthsBetween(from, to) {
  const [fromYear, fromIndex] = String(from).split('-').map(Number);
  const [toYear, toIndex] = String(to).split('-').map(Number);
  if (!fromYear || !fromIndex || !toYear || !toIndex) return 0;
  return (toYear - fromYear) * 12 + (toIndex - fromIndex);
}

/**
 * جدول کامل استهلاک یک دارایی.
 *
 * قسط آخر عمداً «باقی‌مانده» است، نه نتیجهٔ تقسیم. با این کار جمع ستون دقیقاً
 * برابر بهای مستهلک‌شدنی می‌شود و ارزش دفتری در پایان عمر دقیقاً به ارزش
 * اسقاط می‌رسد.
 */
export function straightLineSchedule({ cost = 0, salvage = 0, usefulLifeMonths = 0, inServiceMonth = '' } = {}) {
  const base = Math.round(Number(cost) || 0);
  const residual = Math.max(0, Math.round(Number(salvage) || 0));
  const life = Math.floor(Number(usefulLifeMonths) || 0);
  if (base <= 0 || life <= 0 || !inServiceMonth || residual >= base) return [];

  const depreciable = base - residual;
  const perMonth = Math.floor(depreciable / life);
  const schedule = [];
  let posted = 0;
  let month = inServiceMonth;
  for (let index = 0; index < life; index += 1) {
    // قسط آخر باقی‌ماندهٔ دقیق است تا جمع با بهای مستهلک‌شدنی مو نزند.
    const amount = index === life - 1 ? depreciable - posted : perMonth;
    posted += amount;
    schedule.push({ month, amount, accumulated: posted, bookValue: base - posted });
    month = nextPersianMonth(month);
  }
  return schedule;
}

/**
 * قسط‌هایی که تا یک ماه مشخص سررسید شده‌اند ولی هنوز سند نخورده‌اند.
 *
 * `postedMonths` ماه‌هایی است که از قبل ثبت شده‌اند. ثبت دوبارهٔ یک ماه، هزینهٔ
 * دوره را باد می‌کند و استهلاک انباشته را از بهای دارایی جلو می‌اندازد؛ پس
 * فیلترکردنش شرط درستی است، نه یک بهینه‌سازی.
 */
export function dueDepreciation(asset = {}, { throughMonth = '', postedMonths = [] } = {}) {
  if (!throughMonth) return [];
  const already = new Set(postedMonths.map((month) => String(month)));
  return straightLineSchedule(asset)
    .filter((row) => monthsBetween(row.month, throughMonth) >= 0)
    .filter((row) => !already.has(row.month));
}

/**
 * وضعیت امروزِ یک دارایی: چقدر مستهلک شده و چقدر مانده.
 * ورودی `postedAmount` جمع سندهای استهلاکِ واقعاً زده‌شده است، نه جدول نظری —
 * چون ممکن است دفتر عقب باشد و گزارش باید واقعیت را بگوید نه نقشه را.
 */
export function assetStatus(asset = {}, { postedAmount = 0, throughMonth = '' } = {}) {
  const cost = Math.round(Number(asset.cost) || 0);
  const salvage = Math.max(0, Math.round(Number(asset.salvage) || 0));
  const schedule = straightLineSchedule(asset);
  const posted = Math.max(0, Math.round(Number(postedAmount) || 0));
  const dueRows = throughMonth ? schedule.filter((row) => monthsBetween(row.month, throughMonth) >= 0) : [];
  const scheduledToDate = dueRows.reduce((sum, row) => sum + row.amount, 0);
  return {
    cost,
    salvage,
    depreciable: Math.max(0, cost - salvage),
    months: schedule.length,
    accumulated: posted,
    bookValue: Math.max(salvage, cost - posted),
    // عقب‌ماندگی دفتر: چقدر باید ثبت می‌شد و نشده.
    behindAmount: Math.max(0, scheduledToDate - posted),
    complete: schedule.length > 0 && posted >= cost - salvage,
    lastMonth: schedule.at(-1)?.month || '',
  };
}
