/**
 * پرسش «این همان طرف حساب است؟» پیش از ثبت.
 *
 * سرور وقتی نامی شبیه طرف حساب موجود می‌بیند، ثبت را متوقف می‌کند و خطای
 * `COUNTERPARTY_SIMILAR` می‌دهد؛ چون نمی‌داند «آرمان» همان «شرکت آرمان» است یا نه.
 * این ماژول آن خطا را به یک پرسش تبدیل می‌کند و همان درخواست را با جواب کاربر
 * دوباره می‌فرستد.
 *
 * چرا رویداد پنجره و نه state: پرسش باید از هر جای برنامه — برگهٔ صوتی، فرم طلب،
 * فرم فاکتور — بیاید و همه یک برگه را ببینند. همان الگوی
 * `hesabyar:auth-required` که برنامه پیش‌تر دارد.
 */

export const COUNTERPARTY_PROMPT_EVENT = 'hesabyar:counterparty-similar';

/** پاسخ کاربر: 'merge'، 'separate'، یا null اگر برگه را بست. */
export function askCounterpartyMatch(details) {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent(COUNTERPARTY_PROMPT_EVENT, { detail: { details, resolve } }));
  });
}

/**
 * اجرای یک ثبت، با پرسش در صورت نیاز.
 *
 * `run(resolution)` همان درخواست است؛ بار اول بدون پاسخ و در صورت پرسش، دوباره با
 * پاسخ کاربر صدا زده می‌شود. بستن برگه ثبت را لغو می‌کند — نه اینکه بی‌صدا یکی از
 * دو گزینه را انتخاب کند.
 */
export async function withCounterpartyConfirmation(run) {
  try {
    return await run('');
  } catch (error) {
    if (error?.code !== 'COUNTERPARTY_SIMILAR') throw error;
    const resolution = await askCounterpartyMatch(error.details || {});
    if (!resolution) throw Object.assign(new Error('ثبت لغو شد؛ چیزی ذخیره نشد.'), { code: 'COUNTERPARTY_CANCELLED' });
    return run(resolution);
  }
}
