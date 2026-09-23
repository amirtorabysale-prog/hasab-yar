/**
 * سیاست خودکارسازی — قابل تنظیم، نه hard-code.
 *
 * آستانه‌ها و فهرست «هرگز خودکار» تصمیم محصول‌اند، نه ثابت مهندسی. یک دفتر
 * محافظه‌کار ممکن است هیچ ثبت خودکاری نخواهد و دفتری با حجم بالا ممکن است
 * آستانه را پایین‌تر بیاورد. وقتی این اعداد داخل کد قفل باشند، تنها راه
 * تغییرشان دیپلوی تازه است.
 *
 * پیش‌فرضِ پایلوت همان سیاست فعلی است: ۹۵ برای خودکار، ۸۰ برای تأیید.
 */

export const DEFAULT_AUTOMATION_POLICY = Object.freeze({
  autoThreshold: 0.95,
  confirmThreshold: 0.80,
  /**
   * رویدادهایی که حتی با اطمینان کامل هم تأیید می‌خواهند.
   *
   * معیار: آیا برگرداندنش برای کاربر عادی آسان است؟ فاکتور صادرشده سند برگشتی
   * می‌خواهد، آورده و دارایی ثابت ساختار سرمایه را عوض می‌کنند، و استهلاک
   * تصمیم دوره‌ای حسابدار است.
   */
  neverAutomatic: Object.freeze([
    'sales-invoice', 'purchase-invoice', 'capital-contribution', 'fixed-asset-purchase', 'depreciation',
  ]),
  /**
   * آیا برداشت مدل زبانی به‌تنهایی اجازهٔ ثبت خودکار دارد؟
   *
   * پیش‌فرض خیر. مدل زبانی فقط واقعیت معنایی استخراج می‌کند؛ وقتی هیچ تأیید
   * قطعی دیگری (پارسر محلی، تطبیق بانکی، الگوی تأییدشدهٔ پرونده) پشت آن نباشد،
   * ثبت بی‌پرسش یعنی سپردن دفتر به یک برداشت آماری.
   */
  allowAiOnlyAutoPost: false,
  /** حداقل اطمینان مبلغ برای ثبت خودکار، فارغ از میانگین کل. */
  minimumAmountCertainty: 0.9,
  /**
   * «هیچ‌چیز بدون تأیید انسان وارد دفتر نشود.»
   *
   * چرا کلید جداگانه و نه بردن آستانه روی ۱: مقایسه `>=` است، پس رویدادی با
   * اطمینان کامل از آستانهٔ ۱ هم رد می‌شود. عددی که بشود با آن «هرگز» را بیان
   * کرد وجود ندارد، و دفتری که این را می‌خواهد نباید به یک ترفند عددی تکیه کند.
   */
  manualOnly: false,
  /**
   * موتور تصمیم نسخهٔ دو.
   *
   * تا وقتی خاموش است، هیچ مسیر فعالی عوض نمی‌شود: تصمیم نه ساخته می‌شود و نه
   * ذخیره. روشن که باشد، موتور برای هر رویداد ماهیتش را تعیین می‌کند و اگر
   * واقعیت لازمی کم باشد، جلوی ثبت بی‌پرسش را می‌گیرد.
   *
   * فلگ در سطح دفتر است، نه سراسری: فعال‌سازی باید دفتر‌به‌دفتر و بعداً
   * خانواده‌به‌خانواده باشد، نه یک کلید که همه‌جا را با هم روشن کند.
   */
  engineV2: false,
});

const clamp01 = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
};

/**
 * سیاست را از تنظیمات دفتر می‌سازد و هر مقدار نامعتبر را به پیش‌فرض برمی‌گرداند.
 * سیاستِ خراب نباید دروازه را باز کند؛ باید بی‌صدا به حالت امن برگردد.
 */
export function resolveAutomationPolicy(overrides = {}) {
  const autoThreshold = clamp01(overrides.autoThreshold, DEFAULT_AUTOMATION_POLICY.autoThreshold);
  const confirmThreshold = clamp01(overrides.confirmThreshold, DEFAULT_AUTOMATION_POLICY.confirmThreshold);
  return Object.freeze({
    // آستانهٔ تأیید هرگز نباید از آستانهٔ خودکار بالاتر برود، وگرنه هیچ رویدادی
    // به مسیر تأیید نمی‌رسد و همه یا خودکار می‌شوند یا به صف بررسی.
    autoThreshold: Math.max(autoThreshold, confirmThreshold),
    confirmThreshold: Math.min(autoThreshold, confirmThreshold),
    neverAutomatic: Object.freeze(Array.isArray(overrides.neverAutomatic)
      ? overrides.neverAutomatic.map(String)
      : [...DEFAULT_AUTOMATION_POLICY.neverAutomatic]),
    allowAiOnlyAutoPost: overrides.allowAiOnlyAutoPost === true,
    minimumAmountCertainty: clamp01(overrides.minimumAmountCertainty, DEFAULT_AUTOMATION_POLICY.minimumAmountCertainty),
    manualOnly: overrides.manualOnly === true,
    // مثل `manualOnly`، فقط `true` صریح روشنش می‌کند. مقدار خراب یا نامعلوم
    // نباید دروازه را باز کند.
    engineV2: overrides.engineV2 === true,
  });
}
