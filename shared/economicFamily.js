import { isRoutineExpense } from './purchasePurpose.js';

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
/**
 * آیا این واقعیت مقدار دارد؟
 *
 * `false` و `0` مقدارند، نه نبودِ مقدار. «قابل استرداد نیست» یک جواب است؛ اگر
 * مفقود شمرده شود، سیستم برای هر «نه» دوباره همان سؤال را می‌پرسد و کاربر
 * حلقه می‌خورد.
 *
 * اینجا زندگی می‌کند و نه در `factRequirements.js`، چون آن ماژول از این یکی
 * import می‌کند و برعکسش حلقه می‌ساخت. از آنجا بازصادر می‌شود.
 */
export function isFactPresent(value) {
  return value !== undefined && value !== null && value !== '';
}

const has = (facts, key) => isFactPresent(facts?.[key]);
const direction = (facts) => facts?.moneyDirection ?? null;

/**
 * دسته‌هایی که ذاتاً خدمت دوره‌دار می‌سازند.
 *
 * اینجا زندگی می‌کند چون هم طبقه‌بند به آن نیاز دارد و هم قاعدهٔ پیش‌پرداخت.
 * این یک فهرست کلیدواژه نیست: سیاست دفتر است و حسابدار تأییدش می‌کند. تفاوتش
 * با حدس‌زدن از روی واژه این است که قابل آزمون و قابل بازبینی است.
 */
export const TIME_BOUND_SERVICE_CATEGORIES = Object.freeze(['بیمه', 'اجاره', 'نرم‌افزار و اشتراک']);

/**
 * «بیمه» همیشه حق‌بیمهٔ دوره‌دار نیست.
 *
 * بیمهٔ تأمین اجتماعی پرسنل، بدهیِ حقوق است که تسویه می‌شود؛ و پولی که شرکت
 * بیمه بابت خسارت می‌دهد، اصلاً پرداخت ما نیست. هر دو دستهٔ «بیمه» می‌گیرند و
 * تا امروز سؤال «دورهٔ پوشش از کی تا کی؟» می‌گرفتند — سؤال غلط از رویداد درست.
 */
const NOT_A_PREMIUM = /ت[اأ]مین\s*اجتماع|لیست\s*بیمه|بیمه\s*(?:پرسنل|کارگر|کارکنان|بیکاری)|سهم\s*(?:کارفرما|کارگر)|خسارت|غرامت/;

export function isTimeBoundService(facts) {
  const category = String(facts?.category || '').trim();
  if (!TIME_BOUND_SERVICE_CATEGORIES.includes(category)) return false;
  // کل گفته هم دیده می‌شود: «انبار آتش گرفت… شرکت بیمه بیست و پنج میلیونش رو
  // واریز کرد» دو ردیف دارد و «خسارت» فقط در تکهٔ ردیف اول است.
  return !(category === 'بیمه' && NOT_A_PREMIUM.test(`${facts?.evidence || ''} ${facts?.utterance || ''}`));
}

/**
 * آیا نشانه‌ای هست که این پرداخت منفعت آینده می‌سازد؟
 *
 * بدون این کنترل، هر خروج وجهی «ایجاد دارایی» می‌شد — و خرید چای دفتر کنار
 * پیش‌پرداخت بیمه می‌نشست. این دقیقاً همان حدسی است که کل طرح برای حذفش نوشته
 * شده، فقط یک پله بالاتر از `KIND_BY_TYPE`.
 *
 * پرداختی که هیچ‌کدام از این نشانه‌ها را ندارد، ماهیتش واقعاً معلوم نیست: ممکن
 * است هزینهٔ همین دوره باشد، ممکن است موجودی باشد. جوابش یک سؤال است که فاز ۳
 * می‌پرسد؛ تا آن‌وقت «نمی‌دانم» صادقانه‌تر از یک برچسب مطمئنِ غلط است.
 */
function signalsFutureBenefit(facts) {
  // ثبت‌کننده خودش گفته پیش‌پرداخت یا ودیعه است، یا گفته پول برمی‌گردد.
  if (['advance', 'deposit'].includes(facts?.paymentPurpose) || facts?.refundable === true) return true;
  if (has(facts, 'servicePeriodStart') || has(facts, 'servicePeriodEnd') || has(facts, 'contractReference')) return true;
  if (has(facts, 'assetName') || has(facts, 'readyForUseDate')) return true;
  if (['resale', 'production', 'long-term-use'].includes(facts?.intendedUse)) return true;
  // «پیش‌پیش»، «بیعانه»، «علی‌الحساب»: پول رفته و هنوز هیچ چیزی مصرف نشده.
  if (facts?.prepaymentSignal === true) return true;
  return isTimeBoundService(facts);
}

/**
 * دریافتی که درآمدِ همان لحظه است.
 *
 * «امروز هشت میلیون فروش نقدی داشتیم» تا امروز ماهیت «نامعلوم» می‌گرفت، چون
 * تنها قاعدهٔ درآمد تاریخ تحویل جدا می‌خواست. در فروش و خدمت نقدی، تحویل و
 * دریافت همان لحظه‌اند. دستهٔ عمومیِ «سایر درآمدها» عمداً بیرون است: همان
 * دسته‌ای است که وام و واریز ناشناس هم می‌گیرند؛ آن‌ها با یک سؤال روشن
 * می‌شوند. سود بانکی تنها استثناست، چون خودِ جمله آن را می‌گوید.
 */
export const REVENUE_AT_RECEIPT_CATEGORIES = Object.freeze(['فروش', 'خدمات', 'پروژه و دستمزد']);
const INTEREST_INCOME = /سود\s*(?:بانکی|سپرده|حساب)/;

export function isRevenueAtReceipt(facts) {
  if (direction(facts) !== 'in') return false;
  if (['sale', 'other-income'].includes(facts?.receiptPurpose)) return true;
  if (facts?.receiptPurpose) return false;
  if (facts?.prepaymentSignal === true || has(facts, 'servicePeriodStart') || has(facts, 'contractReference')) return false;
  if (REVENUE_AT_RECEIPT_CATEGORIES.includes(String(facts?.category || '').trim())) return true;
  return INTEREST_INCOME.test(String(facts?.evidence || ''));
}

export const FAMILY_RULES = Object.freeze([
  // اصلاح، پیش از هر چیز دیگری. جمله‌ای که به ثبت قبلی ارجاع می‌دهد و می‌گوید
  // چه چیزی اشتباه بود، هرگز نباید رویداد مستقل تازه بسازد.
  Object.freeze({
    family: ECONOMIC_FAMILIES.CORRECTION_OR_REVERSAL,
    weight: 100,
    reason: 'به یک ثبت قبلی ارجاع دارد و علت اصلاح را می‌گوید.',
    test: (facts) => has(facts, 'originalEventReference') && has(facts, 'correctionReason'),
  }),
  Object.freeze({
    family: ECONOMIC_FAMILIES.VALUE_OR_ESTIMATE_CHANGE,
    weight: 95,
    reason: 'مبنای برآورد دارد، پس رویداد جدیدی اتفاق نیفتاده؛ ارزش تغییر کرده.',
    test: (facts) => has(facts, 'estimateBasis'),
  }),
  // دو حساب که هر دو مال خودِ واحدند. این قاعده عمداً وزن بالایی دارد: انتقال
  // داخلی که به هزینه یا درآمد تبدیل شود، سود دوره را بی‌دلیل تکان می‌دهد.
  Object.freeze({
    family: ECONOMIC_FAMILIES.INTERNAL_TRANSFER,
    weight: 90,
    reason: 'مبدأ و مقصد هر دو حساب خودِ واحد هستند.',
    test: (facts) => has(facts, 'cashAccountId') && has(facts, 'destinationAccountId'),
  }),
  Object.freeze({
    family: ECONOMIC_FAMILIES.ASSET_CONSUMPTION,
    weight: 85,
    reason: 'پولی جابه‌جا نشده و به دارایی ثبت‌شدهٔ قبلی ارجاع دارد.',
    test: (facts) => direction(facts) === 'none' && has(facts, 'originalEventReference') && !has(facts, 'correctionReason'),
  }),
  Object.freeze({
    family: ECONOMIC_FAMILIES.OWNER_CAPITAL_MOVEMENT,
    weight: 84,
    reason: 'طرف حساب، خودِ مالک یا شریک است.',
    test: (facts) => facts?.counterpartyRole === 'owner' || facts?.receiptPurpose === 'owner' || facts?.paymentPurpose === 'owner-drawing',
  }),
  // وام دریافتی بدهی است، نه درآمد؛ وزنش بالای قاعده‌های عمومی دریافت است
  // تا دستهٔ «سایر درآمدها» هرگز آن را درآمد نکند.
  Object.freeze({
    family: ECONOMIC_FAMILIES.LIABILITY_CREATION,
    weight: 83,
    reason: 'پول وام یا قرض آمده و باید پس داده شود.',
    test: (facts) => direction(facts) === 'in' && facts?.receiptPurpose === 'loan',
  }),
  // واریزی که منشأش معلوم نیست، تا روشن شدن در اختیار ماست ولی مال ما نیست.
  Object.freeze({
    family: ECONOMIC_FAMILIES.LIABILITY_CREATION,
    weight: 82,
    reason: 'پول آمده ولی معلوم نیست از کیست؛ تا تعیین تکلیف، بدهی موقت است.',
    test: (facts) => direction(facts) === 'in' && facts?.receiptPurpose === 'unknown',
  }),
  // ارجاع به سند باز یعنی این پول تعهد موجود را می‌بندد، نه اینکه درآمد یا
  // هزینهٔ تازه بسازد. نگهبان کاملش در WP-1 می‌آید؛ اینجا فقط ماهیت است.
  // تعهدی که خودِ رویداد جهتش را می‌گوید، پیش از قاعده‌های عمومی. بدون این،
  // «طلب باز شد» با «بدهی باز شد» یکی دیده می‌شود: هر دو پولی جابه‌جا نمی‌کنند
  // و طرف حساب دارند، و قاعدهٔ عمومی هر دو را بدهی می‌خواند.
  Object.freeze({
    family: ECONOMIC_FAMILIES.RECEIVABLE_CREATION,
    weight: 88,
    reason: 'تعهدی به نفع ما ساخته شده؛ هنوز پولی نیامده.',
    test: (facts) => facts?.obligationDirection === 'receivable',
  }),
  Object.freeze({
    family: ECONOMIC_FAMILIES.LIABILITY_CREATION,
    weight: 88,
    reason: 'تعهدی به عهدهٔ ما ساخته شده؛ هنوز پولی پرداخت نشده.',
    test: (facts) => facts?.obligationDirection === 'payable',
  }),
  // چک، پیش از قاعده‌های عمومی. بدون این، چک دریافتی — که پولی جابه‌جا نمی‌کند
  // و طرف حساب دارد — «ایجاد بدهی» خوانده می‌شد.
  Object.freeze({
    family: ECONOMIC_FAMILIES.RECEIVABLE_CREATION,
    weight: 86,
    reason: 'چک دریافتی، حق دریافت آینده می‌سازد.',
    test: (facts) => facts?.chequeDirection === 'receivable',
  }),
  Object.freeze({
    family: ECONOMIC_FAMILIES.LIABILITY_CREATION,
    weight: 86,
    reason: 'چک پرداختی، تعهد پرداخت آینده می‌سازد.',
    test: (facts) => facts?.chequeDirection === 'payable',
  }),
  Object.freeze({
    family: ECONOMIC_FAMILIES.LIABILITY_SETTLEMENT,
    weight: 80,
    reason: 'پول خارج شد و به یک سند باز ارجاع دارد.',
    test: (facts) => direction(facts) === 'out' && has(facts, 'settlementReference'),
  }),
  Object.freeze({
    family: ECONOMIC_FAMILIES.RECEIVABLE_COLLECTION,
    weight: 80,
    reason: 'پول وارد شد و به یک سند باز ارجاع دارد.',
    test: (facts) => direction(facts) === 'in' && has(facts, 'settlementReference'),
  }),
  Object.freeze({
    family: ECONOMIC_FAMILIES.ADVANCE_RECEIVED,
    weight: 70,
    reason: 'پول پیش از انجام تعهد دریافت شده است.',
    test: (facts) => direction(facts) === 'in' && !has(facts, 'deliveryDate')
      && (has(facts, 'contractReference') || has(facts, 'servicePeriodStart') || facts?.prepaymentSignal === true || facts?.receiptPurpose === 'advance'),
  }),
  Object.freeze({
    family: ECONOMIC_FAMILIES.REVENUE_RECOGNITION,
    weight: 65,
    reason: 'تعهد انجام شده و پول هم دریافت شده است.',
    test: (facts) => has(facts, 'deliveryDate') && direction(facts) === 'in',
  }),
  Object.freeze({
    family: ECONOMIC_FAMILIES.REVENUE_RECOGNITION,
    weight: 60,
    reason: 'فروش یا خدمتی که همین حالا انجام شد و پولش هم آمد.',
    test: (facts) => isRevenueAtReceipt(facts),
  }),
  Object.freeze({
    family: ECONOMIC_FAMILIES.RECEIVABLE_CREATION,
    weight: 64,
    reason: 'تعهد انجام شده ولی هنوز پولی نیامده است.',
    test: (facts) => has(facts, 'deliveryDate') && direction(facts) === 'none' && has(facts, 'counterparty'),
  }),
  Object.freeze({
    family: ECONOMIC_FAMILIES.LIABILITY_CREATION,
    weight: 50,
    reason: 'تعهدی به طرف حساب ساخته شده ولی هنوز پولی پرداخت نشده است.',
    test: (facts) => direction(facts) === 'none' && has(facts, 'counterparty') && has(facts, 'amount'),
  }),
  // پایین‌ترین وزن عمدی است: «پول خارج شد» ضعیف‌ترین نشانهٔ ممکن است و فقط
  // وقتی برنده می‌شود که هیچ نشانهٔ قوی‌تری نباشد. اینجا همان جایی است که
  // پیش‌پرداخت، موجودی و دارایی ثابت می‌نشینند و برخوردشان را قاعده تعیین
  // می‌کند، نه طبقه‌بند.
  //
  // شرط `signalsFutureBenefit` حیاتی است: بدون آن، هر پرداخت سادهٔ نقدی هم
  // «ایجاد دارایی» برچسب می‌خورد و دادهٔ شادو از همان روز اول آلوده می‌شود.
  Object.freeze({
    family: ECONOMIC_FAMILIES.ASSET_CREATION,
    weight: 40,
    reason: 'پول خارج شد، به سند بازی ارجاع ندارد، و نشانهٔ منفعت آینده دارد.',
    test: (facts) => direction(facts) === 'out' && has(facts, 'amount') && signalsFutureBenefit(facts),
  }),
  // مصرف همین دوره: قبض، سوخت، کارمزد — یا خریدی که کاربر گفته مصرف جاری
  // است. پایین‌تر از ایجاد دارایی، چون هر نشانهٔ منفعت آینده (دورهٔ پوشش،
  // پیش‌پرداخت، هدف ماندگار) باید بر برچسب «هزینه» برنده شود.
  Object.freeze({
    family: ECONOMIC_FAMILIES.ASSET_CONSUMPTION,
    weight: 30,
    reason: 'پول خارج شد و آنچه بابتش گرفته شد، در همین دوره مصرف می‌شود.',
    test: (facts) => direction(facts) === 'out' && has(facts, 'amount') && !signalsFutureBenefit(facts)
      && (facts?.intendedUse === 'current-consumption' || facts?.paymentPurpose === 'expense'
        || isRoutineExpense(facts, { capitalizationThreshold: facts?.capitalizationThreshold ?? null })),
  }),
]);

/**
 * خانوادهٔ یک رویداد را از روی واقعیت‌هایش تعیین می‌کند.
 *
 * خروجی همیشه یک شیء است، حتی وقتی نتیجه `unknown` باشد: `{ family, confidence, reason }`.
 * هیچ‌وقت به خانوادهٔ پیش‌فرض برنمی‌گردد و هیچ‌وقت استثنا پرتاب نمی‌کند — رویدادی
 * که جایش معلوم نیست باید به صف حسابدار برسد، نه اینکه مسیر را بشکند.
 *
 * وقتی چند قاعده هم‌زمان بگیرند، قوی‌ترین برنده است. تساوی وزن ممکن نیست چون
 * وزن‌ها یکتا انتخاب شده‌اند؛ اگر روزی تساوی پیش بیاید، اولی برنده می‌شود و
 * این رفتار قابل‌پیش‌بینی است، نه تصادفی.
 */
export function classifyFamily(facts = {}) {
  let winner = null;
  for (const rule of FAMILY_RULES) {
    let matched = false;
    // قاعدهٔ خراب نباید کل مسیر را بشکند؛ رویداد باید به حسابدار برسد.
    try { matched = Boolean(rule.test(facts)); } catch { matched = false; }
    if (matched && (!winner || rule.weight > winner.weight)) winner = rule;
  }
  if (!winner) {
    return Object.freeze({
      family: FAMILY_UNKNOWN,
      confidence: 0,
      reason: 'هیچ‌کدام از نشانه‌های دوازده خانواده در واقعیت‌های موجود پیدا نشد.',
    });
  }
  return Object.freeze({ family: winner.family, confidence: winner.weight / 100, reason: winner.reason });
}
