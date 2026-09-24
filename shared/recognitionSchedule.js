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
 * دورهٔ ناقص اول یا آخر به همان ماه تعلق می‌گیرد؛ خرده‌ریز روزانه محاسبه
 * نمی‌شود (تصمیم ۲، `docs/wp0-open-decisions.md`).
 */
export function buildMonthlySchedule({ amount, periodStart, periodEnd, sourceId } = {}) {
  const total = Math.round(Number(amount) || 0);
  if (!(total > 0) || !periodStart || !periodEnd) return [];

  const firstMonth = persianMonthIndex(periodStart);
  const lastMonth = persianMonthIndex(periodEnd);
  const count = lastMonth - firstMonth + 1;
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
