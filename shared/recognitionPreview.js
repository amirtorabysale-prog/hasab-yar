import { buildMonthlySchedule } from './recognitionSchedule.js';

/**
 * پیش‌نمایش شناسایی ماهانه — همان برنامه‌ای که ثبت خواهد ساخت، پیش از ثبت.
 *
 * برگهٔ تأیید (کارت قطعی و برگهٔ فهم گفته) فقط «بدهکار پیش‌پرداخت ۱۲٬۰۰۰٬۰۰۰»
 * نشان می‌داد، درحالی‌که ثبت دورهٔ پوشش و دوازده قسط «هزینه / پیش‌پرداخت» را هم
 * می‌نوشت. دوره‌ای که سرور از «یک ساله»، «از اول ماه بعد» یا جواب سؤال درآورده
 * دقیقاً همان جایی است که اشتباه دوره (سیزده ماه به‌جای دوازده) پنهان می‌ماند؛
 * و این برگه تنها جایی است که کاربر پیش از ثبت آن را می‌بیند.
 *
 * از همان `buildMonthlySchedule` ساخته می‌شود که `storeSchedule` ثبت می‌کند، تا
 * پیش‌نمایش و دفتر یک عدد بگویند. برای پیش‌پرداخت هزینه و درآمد انتقالی یکی
 * است؛ هزینهٔ یک‌جا (دورهٔ گذشته یا همین ماه) و پیش‌پرداخت خرید کالا برنامه
 * ندارند و `null` می‌گیرند.
 */
export function recognitionPreview(event, decision) {
  if (decision?.recognitionMethod !== 'monthly-straight-line') return null;
  const periodStart = event?.servicePeriodStart || null;
  const periodEnd = event?.servicePeriodEnd || null;
  const schedule = buildMonthlySchedule({ amount: event?.amount, periodStart, periodEnd, sourceId: 'preview' })
    .map(({ periodKey, amount }) => ({ periodKey, amount }));
  if (!schedule.length) return null;
  return { method: decision.recognitionMethod, periodStart, periodEnd, count: schedule.length, schedule };
}

/**
 * دورهٔ پوششی که رویداد دارد، حتی وقتی یک‌جا شناسایی می‌شود — تا کاربر ببیند
 * چرا «بیمهٔ پارسال» یک‌جا هزینه شد.
 */
export function servicePeriodPreview(event) {
  const start = event?.servicePeriodStart || null;
  const end = event?.servicePeriodEnd || null;
  return start || end ? { start, end } : null;
}
