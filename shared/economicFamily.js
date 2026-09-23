/**
 * خانوادهٔ اقتصادی — ماهیت رویداد، نه شکل تراکنش.
 *
 * چرا این لایه وجود دارد:
 *
 * تا امروز موتور «نوع تراکنش» را تشخیص می‌داد: درآمد یا هزینه. این تشخیص برای
 * ساختن سند کافی نیست، چون یک خروج وجه می‌تواند هزینهٔ دوره باشد، می‌تواند
 * پیش‌پرداخت باشد، می‌تواند خرید موجودی باشد و می‌تواند تسویهٔ بدهی قبلی باشد.
 * هر چهار حالت «پرداخت» هستند و هیچ‌کدام یک سند ندارند.
 *
 * پس اول باید پرسید این رویداد از نظر اقتصادی چیست، بعد پرسید آن ماهیت چه
 * واقعیت‌هایی لازم دارد. دوازده خانواده، همهٔ حالت‌های ممکن را می‌پوشانند.
 *
 * `unknown` عمداً یک خانواده است، نه یک خطا: رویدادی که در هیچ خانواده‌ای
 * نمی‌نشیند باید به حسابدار برسد، نه اینکه به نزدیک‌ترین خانواده هل داده شود.
 *
 * این ماژول هیچ وابستگی‌ای ندارد: نه دیتابیس، نه شبکه، نه رابط کاربری.
 */

/**
 * دوازده خانوادهٔ اقتصادی.
 *
 * ترتیب، ترتیب چرخهٔ عمر است نه اهمیت: دارایی ساخته می‌شود و مصرف می‌شود،
 * بدهی ساخته می‌شود و تسویه می‌شود، دریافتنی ساخته می‌شود و وصول می‌شود.
 */
export const ECONOMIC_FAMILIES = Object.freeze({
  ASSET_CREATION: 'asset-creation',
  ASSET_CONSUMPTION: 'asset-consumption',
  LIABILITY_CREATION: 'liability-creation',
  LIABILITY_SETTLEMENT: 'liability-settlement',
  RECEIVABLE_CREATION: 'receivable-creation',
  RECEIVABLE_COLLECTION: 'receivable-collection',
  REVENUE_RECOGNITION: 'revenue-recognition',
  ADVANCE_RECEIVED: 'advance-received',
  OWNER_CAPITAL_MOVEMENT: 'owner-capital-movement',
  INTERNAL_TRANSFER: 'internal-transfer',
  VALUE_OR_ESTIMATE_CHANGE: 'value-or-estimate-change',
  CORRECTION_OR_REVERSAL: 'correction-or-reversal',
});

/**
 * «نمی‌دانم» یک پاسخ معتبر است.
 *
 * عمداً بیرون از فهرست بالاست تا هیچ‌جا به‌عنوان یک خانوادهٔ عادی شمرده نشود و
 * هیچ قاعده‌ای نتواند برایش سند بسازد.
 */
export const FAMILY_UNKNOWN = 'unknown';

const FAMILY_VALUES = Object.freeze(Object.values(ECONOMIC_FAMILIES));

export function isEconomicFamily(value) {
  return FAMILY_VALUES.includes(value);
}

export function listEconomicFamilies() {
  return [...FAMILY_VALUES];
}

/** نام فارسی هر خانواده — یک‌جا، تا صف بررسی و تاریخچه دو عنوان متفاوت نشان ندهند. */
export const FAMILY_LABELS = Object.freeze({
  [ECONOMIC_FAMILIES.ASSET_CREATION]: 'ایجاد دارایی',
  [ECONOMIC_FAMILIES.ASSET_CONSUMPTION]: 'مصرف دارایی و شناسایی هزینه',
  [ECONOMIC_FAMILIES.LIABILITY_CREATION]: 'ایجاد بدهی',
  [ECONOMIC_FAMILIES.LIABILITY_SETTLEMENT]: 'تسویهٔ بدهی',
  [ECONOMIC_FAMILIES.RECEIVABLE_CREATION]: 'ایجاد دریافتنی',
  [ECONOMIC_FAMILIES.RECEIVABLE_COLLECTION]: 'وصول دریافتنی',
  [ECONOMIC_FAMILIES.REVENUE_RECOGNITION]: 'انجام تعهد و شناسایی درآمد',
  [ECONOMIC_FAMILIES.ADVANCE_RECEIVED]: 'دریافت پیش از انجام تعهد',
  [ECONOMIC_FAMILIES.OWNER_CAPITAL_MOVEMENT]: 'سرمایه‌گذاری یا برداشت مالک',
  [ECONOMIC_FAMILIES.INTERNAL_TRANSFER]: 'انتقال بین حساب‌های خود واحد',
  [ECONOMIC_FAMILIES.VALUE_OR_ESTIMATE_CHANGE]: 'تغییر ارزش یا برآورد',
  [ECONOMIC_FAMILIES.CORRECTION_OR_REVERSAL]: 'اصلاح، برگشت یا ابطال رویداد قبلی',
  [FAMILY_UNKNOWN]: 'ماهیت نامشخص',
});

/**
 * نمونه‌های هر خانواده — برای صف بررسی و برای توضیح تصمیم به حسابدار.
 *
 * اینجا می‌مانند و نه در رابط کاربری، به همان دلیلی که برچسب‌ها اینجا می‌مانند.
 */
export const FAMILY_EXAMPLES = Object.freeze({
  [ECONOMIC_FAMILIES.ASSET_CREATION]: ['پیش‌پرداخت بیمه', 'خرید موجودی', 'خرید دارایی ثابت'],
  [ECONOMIC_FAMILIES.ASSET_CONSUMPTION]: ['استهلاک', 'مصرف مواد', 'تخصیص ماهانهٔ پیش‌پرداخت'],
  [ECONOMIC_FAMILIES.LIABILITY_CREATION]: ['قبض دریافت‌نشده', 'حقوق تحقق‌یافتهٔ پرداخت‌نشده'],
  [ECONOMIC_FAMILIES.LIABILITY_SETTLEMENT]: ['پرداخت به فروشنده', 'پرداخت قسط وام'],
  [ECONOMIC_FAMILIES.RECEIVABLE_CREATION]: ['فروش نسیه', 'صورت‌وضعیت پیمانکاری'],
  [ECONOMIC_FAMILIES.RECEIVABLE_COLLECTION]: ['دریافت از مشتری بابت فاکتور قبلی'],
  [ECONOMIC_FAMILIES.REVENUE_RECOGNITION]: ['تحویل کالا', 'اتمام خدمت'],
  [ECONOMIC_FAMILIES.ADVANCE_RECEIVED]: ['بیعانه', 'پیش‌دریافت اشتراک سالانه'],
  [ECONOMIC_FAMILIES.OWNER_CAPITAL_MOVEMENT]: ['آوردهٔ شریک', 'برداشت شخصی مالک'],
  [ECONOMIC_FAMILIES.INTERNAL_TRANSFER]: ['بانک به بانک', 'بانک به صندوق'],
  [ECONOMIC_FAMILIES.VALUE_OR_ESTIMATE_CHANGE]: ['کاهش ارزش', 'تسعیر ارز', 'ذخیرهٔ مطالبات'],
  [ECONOMIC_FAMILIES.CORRECTION_OR_REVERSAL]: ['سند اشتباه', 'چک برگشتی', 'ابطال فاکتور'],
});

/**
 * سطح ریسک پیش‌فرض هر خانواده.
 *
 * سبز یعنی می‌تواند خودکار شود، ولی فقط بعد از گذراندن دروازهٔ فعال‌سازی فاز ۴.
 * زرد یعنی یک سؤال کوتاه. قرمز یعنی همیشه حسابدار، حتی وقتی سیستم مطمئن است.
 *
 * قرمزها اینجا قرمزند چون قضاوت یا برآورد می‌خواهند، نه چون داده کم دارند.
 * اضافه شدن داده، قرمز را زرد نمی‌کند.
 */
export const RISK_LEVELS = Object.freeze({ GREEN: 'green', YELLOW: 'yellow', RED: 'red' });

export const FAMILY_DEFAULT_RISK = Object.freeze({
  [ECONOMIC_FAMILIES.INTERNAL_TRANSFER]: RISK_LEVELS.GREEN,
  [ECONOMIC_FAMILIES.LIABILITY_SETTLEMENT]: RISK_LEVELS.YELLOW,
  [ECONOMIC_FAMILIES.RECEIVABLE_COLLECTION]: RISK_LEVELS.YELLOW,
  [ECONOMIC_FAMILIES.ASSET_CREATION]: RISK_LEVELS.YELLOW,
  [ECONOMIC_FAMILIES.ASSET_CONSUMPTION]: RISK_LEVELS.YELLOW,
  [ECONOMIC_FAMILIES.LIABILITY_CREATION]: RISK_LEVELS.YELLOW,
  [ECONOMIC_FAMILIES.RECEIVABLE_CREATION]: RISK_LEVELS.YELLOW,
  [ECONOMIC_FAMILIES.REVENUE_RECOGNITION]: RISK_LEVELS.YELLOW,
  [ECONOMIC_FAMILIES.ADVANCE_RECEIVED]: RISK_LEVELS.YELLOW,
  [ECONOMIC_FAMILIES.OWNER_CAPITAL_MOVEMENT]: RISK_LEVELS.RED,
  [ECONOMIC_FAMILIES.VALUE_OR_ESTIMATE_CHANGE]: RISK_LEVELS.RED,
  [ECONOMIC_FAMILIES.CORRECTION_OR_REVERSAL]: RISK_LEVELS.RED,
  [FAMILY_UNKNOWN]: RISK_LEVELS.RED,
});

/**
 * قاعده‌های تشخیص، به‌صورت داده.
 *
 * چرا داده و نه `switch`: شرط پذیرش این فاز می‌گوید «افزودن خانوادهٔ جدید نباید
 * هستهٔ طبقه‌بند را عوض کند». تا وقتی قاعده‌ها یک آرایه‌اند، خانوادهٔ سیزدهم یک
 * ردیف تازه است. اگر `switch` بود، هر خانواده یک شاخه در همان تابع می‌شد و
 * هستهٔ طبقه‌بند با هر افزودن تغییر می‌کرد.
 *
 * هر قاعده `test` دارد که روی واقعیت‌های استخراج‌شده اجرا می‌شود، و `weight`
 * که وقتی چند قاعده هم‌زمان می‌گیرند، قوی‌ترین برنده باشد. هیچ قاعده‌ای از
 * واژه‌های جمله استفاده نمی‌کند؛ همه از واقعیت می‌خوانند.
 */
export const FAMILY_RULES = Object.freeze([]);

function notImplemented(name) {
  return Object.assign(new Error(`${name} هنوز پیاده‌سازی نشده است.`), { code: 'NOT_IMPLEMENTED' });
}

/**
 * خانوادهٔ یک رویداد را از روی واقعیت‌هایش تعیین می‌کند.
 *
 * خروجی همیشه یک شیء است، حتی وقتی نتیجه `unknown` باشد: `{ family, confidence, reason }`.
 * هیچ‌وقت به خانوادهٔ پیش‌فرض برنمی‌گردد و هیچ‌وقت استثنا پرتاب نمی‌کند — رویدادی
 * که جایش معلوم نیست باید به صف حسابدار برسد، نه اینکه مسیر را بشکند.
 */
export function classifyFamily(/* facts */) {
  throw notImplemented('classifyFamily');
}
