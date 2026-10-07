/**
 * برنامهٔ شناسایی — پخش یک مبلغ روی ماه‌های دوره.
 *
 * روش مصوب نسخهٔ اول: ماهانه، خط مستقیم، بر مبنای ماه شمسی
 * (`docs/wp0-open-decisions.md`، تصمیم ۲).
 *
 * سه چیز که اینجا اهمیت دارند و اگر رعایت نشوند در دفتر واقعی خودشان را نشان
 * می‌دهند:
 *
 * ۱. **جمع اقلام باید دقیقاً برابر مبلغ اصلی باشد.** تقسیم ۱۰۰ بر ۳ سه قلم
 *    ۳۳ می‌دهد و یک تومان گم می‌شود. ته‌مانده به قلم آخر می‌چسبد، نه اینکه
 *    روی همه پخش شود — پخش کردنش اعداد را غیررُند می‌کند و حسابدار نمی‌تواند
 *    با ماشین‌حساب تأییدش کند.
 *
 * ۲. **اجرای دوباره نباید قلم دوم بسازد.** هر قلم کلید یکتای خودش را دارد:
 *    ترکیب شناسهٔ منبع و شناسهٔ دوره. اجرای مجدد همان کلید را می‌سازد و لایهٔ
 *    ثبت آن را تکراری می‌بیند.
 *
 * ۳. **دورهٔ بسته سند نمی‌سازد.** قلمی که در دورهٔ بسته بیفتد علامت می‌خورد و
 *    به صف حسابدار می‌رود (تصمیم ۳). نه به دورهٔ بعد منتقل می‌شود و نه دورهٔ
 *    بسته را باز می‌کند.
 */

export const SCHEDULE_ITEM_STATUS = Object.freeze({
  PLANNED: 'planned',
  POSTED: 'posted',
  BLOCKED_CLOSED_PERIOD: 'blocked-closed-period',
  // برنامه عوض شده و این قلم دیگر جزو آن نیست. حذف نمی‌شود: تاریخچه باید
  // بگوید چرا برنامه عوض شد.
  SUPERSEDED: 'superseded',
});

import { persianToISO, todayPersian } from './persianDate.js';

/**
 * شمارهٔ مطلق ماه شمسی — برای شمردن و مقایسه.
 *
 * ماه‌های شمسی ۲۹ تا ۳۱ روزند، پس «دوازده ماه» را نمی‌شود با ۳۶۵ روز یا با
 * ۳۰ روز در ماه حساب کرد. تبدیل به یک عدد صحیح، شمردن را دقیق و مقایسه را
 * ساده می‌کند.
 */
function persianMonthIndex(iso) {
  const parts = todayPersian(new Date(iso));
  return (parts.year * 12) + (parts.month - 1);
}

/**
 * طول دوره به ماه — نه تعداد ماه‌های تقویمی که لمس می‌کند.
 *
 * اجارهٔ شش ماهه‌ای که ۱۵ مهر شروع شده تا ۱۴ فروردین است و هفت ماه تقویمی را
 * لمس می‌کند؛ شمردن ماه‌های لمس‌شده آن را هفت قسط ۵٫۱۴ میلیونی می‌کرد، به‌جای
 * شش قسط شش میلیونی. تصمیم مهر ۱۴۰۵: N قسط مساوی، از همان ماه شروع.
 *
 * پایان دوره روز آخرِ آن است، پس یک روز جلو می‌رود تا «تا ۱۴ فروردین» با «از
 * ۱۵ مهر» شش ماه کامل شود. اختلاف روزِ باقی‌مانده به نزدیک‌ترین ماه گرد
 * می‌شود: «تا ۲۸ فروردین» برای شروعِ ۳۰ مهر هم شش ماه است.
 */
function periodMonths(periodStart, periodEnd) {
  // پایان پیش از شروع یعنی دادهٔ خراب؛ برنامه‌ای از آن ساخته نمی‌شود.
  if (!(Date.parse(periodEnd) >= Date.parse(periodStart))) return 0;
  const start = todayPersian(new Date(periodStart));
  const end = todayPersian(new Date(new Date(periodEnd).getTime() + 86_400_000));
  const months = ((end.year * 12) + end.month) - ((start.year * 12) + start.month);
  return Math.max(1, months + Math.round((end.day - start.day) / 30));
}

function persianMonthKey(index) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * کلید یکتای یک قلم.
 *
 * ترکیب شناسهٔ منبع و شناسهٔ دوره است، نه شمارهٔ ردیف: اگر برنامه دوباره ساخته
 * شود، همان کلید درمی‌آید و لایهٔ ثبت آن را تکراری می‌بیند. کلید مبتنی بر
 * ردیف، با هر بازسازی عوض می‌شد و سند دوم می‌ساخت.
 */
export function scheduleItemKey(sourceId, periodKey) {
  return `${String(sourceId || '')}:${String(periodKey || '')}`;
}

/**
 * برنامهٔ ماهانه را می‌سازد.
 *
 * ورودی: مبلغ کل، شروع و پایان دوره، و شناسهٔ منبع.
 * خروجی: آرایه‌ای از اقلام، هرکدام با `periodKey` یکتا، مبلغ، و وضعیت اولیه.
 *
 * تعداد اقساط، طول دوره به ماه است و اقساط مساوی از ماهِ شروع پشت سر هم
 * می‌آیند؛ خرده‌ریز روزانه محاسبه نمی‌شود (تصمیم ۲، `docs/wp0-open-decisions.md`؛
 * دورهٔ وسط ماه: تصمیم مهر ۱۴۰۵).
 */
export function buildMonthlySchedule({ amount, periodStart, periodEnd, sourceId } = {}) {
  const total = Math.round(Number(amount) || 0);
  if (!(total > 0) || !periodStart || !periodEnd) return [];

  const firstMonth = persianMonthIndex(periodStart);
  const count = periodMonths(periodStart, periodEnd);
  if (!(count > 0)) return [];

  // ته‌ماندهٔ گرد کردن روی قلم آخر می‌نشیند، نه پخش‌شده روی همه: پخش کردنش
  // اعداد را غیررُند می‌کند و حسابدار دیگر نمی‌تواند با ماشین‌حساب تأییدشان
  // کند. جمع اقلام باید دقیقاً برابر مبلغ اصلی بماند.
  const share = Math.floor(total / count);
  const items = [];
  for (let offset = 0; offset < count; offset += 1) {
    const index = firstMonth + offset;
    const periodKey = persianMonthKey(index);
    const last = offset === count - 1;
    items.push(Object.freeze({
      key: scheduleItemKey(sourceId, periodKey),
      periodKey,
      recognitionDate: persianToISO(Math.floor(index / 12), (index % 12) + 1, 1),
      amount: last ? total - (share * (count - 1)) : share,
      status: SCHEDULE_ITEM_STATUS.PLANNED,
    }));
  }
  return items;
}
