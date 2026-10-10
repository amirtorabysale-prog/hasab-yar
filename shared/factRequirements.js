import { ECONOMIC_FAMILIES, FAMILY_UNKNOWN, isFactPresent } from './economicFamily.js';

// جایش در `economicFamily.js` است تا حلقهٔ import ساخته نشود؛ مصرف‌کننده‌ها
// آن را از همین‌جا برمی‌دارند چون مفهوماً به واقعیت مربوط است.
export { isFactPresent };

/**
 * واقعیت‌های لازم هر خانواده — و سؤالی که برای هر کمبود پرسیده می‌شود.
 *
 * چرا این ماژول وجود دارد:
 *
 * امروز موتور نمی‌تواند بگوید چه چیزی را نمی‌داند. رویداد مالی اصلاً فیلدی برای
 * «دورهٔ پوشش» یا «قابل استرداد بودن» ندارد، پس نبودشان قابل گزارش نیست و
 * اطمینان بالا روی یک ماهیت مبهم می‌نشیند. برای اینکه بشود امتناع کرد، اول باید
 * جایی برای ندانستن وجود داشته باشد.
 *
 * پس هر خانواده صریح اعلام می‌کند چه واقعیت‌هایی لازم دارد. موتور واقعیت‌های
 * موجود را با این فهرست مقایسه می‌کند و کمبودها را نام می‌برد — نه به‌صورت یک
 * نمرهٔ پایین، بلکه به‌صورت فهرستی از چیزهایی که باید پرسیده شوند.
 */

/**
 * واژگان واقعیت.
 *
 * فهرست بسته است: هر واقعیتی که موتور می‌خواهد باید اینجا نام داشته باشد، وگرنه
 * نه قابل پرسیدن است و نه قابل گزارش. کلید رشته‌ای آزاد یعنی همان وضعیت امروز،
 * که هر لایه اسم خودش را می‌گذارد و هیچ‌کس نمی‌داند دو اسم یک چیزند یا نه.
 */
export const FACT_KEYS = Object.freeze({
  AMOUNT: 'amount',
  OCCURRED_AT: 'occurredAt',
  CASH_ACCOUNT: 'cashAccountId',
  DESTINATION_ACCOUNT: 'destinationAccountId',
  COUNTERPARTY: 'counterparty',
  // نسبت طرف حساب با کسب‌وکار. بدون این، آوردهٔ مالک از پرداخت به فروشنده
  // قابل تفکیک نیست و اصل سرمایه می‌تواند درآمد ثبت شود.
  COUNTERPARTY_ROLE: 'counterpartyRole',
  CATEGORY: 'category',
  DESCRIPTION: 'description',
  SERVICE_PERIOD_START: 'servicePeriodStart',
  SERVICE_PERIOD_END: 'servicePeriodEnd',
  REFUNDABLE: 'refundable',
  INTENDED_USE: 'intendedUse',
  CONTRACT_REFERENCE: 'contractReference',
  SETTLEMENT_REFERENCE: 'settlementReference',
  OBLIGATION_REFERENCE: 'obligationReference',
  DELIVERY_DATE: 'deliveryDate',
  ASSET_NAME: 'assetName',
  READY_FOR_USE_DATE: 'readyForUseDate',
  USEFUL_LIFE_MONTHS: 'usefulLifeMonths',
  ESTIMATE_BASIS: 'estimateBasis',
  ORIGINAL_EVENT_REFERENCE: 'originalEventReference',
  CORRECTION_REASON: 'correctionReason',
  CHEQUE_AGAINST: 'chequeAgainst',
  AMOUNT_SCALE: 'amountScale',
  RECEIPT_PURPOSE: 'receiptPurpose',
  PAYMENT_PURPOSE: 'paymentPurpose',
});

const FACT_VALUES = Object.freeze(Object.values(FACT_KEYS));

export function isFactKey(value) { return FACT_VALUES.includes(value); }

/** نام فارسی هر واقعیت — برای صف بررسی و برای متن سؤال. */
export const FACT_LABELS = Object.freeze({
  [FACT_KEYS.AMOUNT]: 'مبلغ',
  [FACT_KEYS.OCCURRED_AT]: 'تاریخ وقوع',
  [FACT_KEYS.CASH_ACCOUNT]: 'حساب پرداخت یا دریافت',
  [FACT_KEYS.DESTINATION_ACCOUNT]: 'حساب مقصد',
  [FACT_KEYS.COUNTERPARTY]: 'طرف حساب',
  [FACT_KEYS.COUNTERPARTY_ROLE]: 'نسبت طرف حساب',
  [FACT_KEYS.CATEGORY]: 'دسته',
  [FACT_KEYS.DESCRIPTION]: 'شرح',
  [FACT_KEYS.SERVICE_PERIOD_START]: 'شروع دورهٔ پوشش',
  [FACT_KEYS.SERVICE_PERIOD_END]: 'پایان دورهٔ پوشش',
  [FACT_KEYS.REFUNDABLE]: 'قابل استرداد بودن',
  [FACT_KEYS.INTENDED_USE]: 'هدف از خرید',
  [FACT_KEYS.CONTRACT_REFERENCE]: 'قرارداد مرتبط',
  [FACT_KEYS.SETTLEMENT_REFERENCE]: 'سندی که تسویه می‌شود',
  [FACT_KEYS.OBLIGATION_REFERENCE]: 'تعهد مرتبط',
  [FACT_KEYS.DELIVERY_DATE]: 'تاریخ تحویل یا انجام',
  [FACT_KEYS.ASSET_NAME]: 'نام دارایی',
  [FACT_KEYS.READY_FOR_USE_DATE]: 'تاریخ آماده‌به‌کاری',
  [FACT_KEYS.USEFUL_LIFE_MONTHS]: 'عمر مفید',
  [FACT_KEYS.ESTIMATE_BASIS]: 'مبنای برآورد',
  [FACT_KEYS.ORIGINAL_EVENT_REFERENCE]: 'رویداد اصلی',
  [FACT_KEYS.CORRECTION_REASON]: 'علت اصلاح',
  [FACT_KEYS.CHEQUE_AGAINST]: 'بابت چه چیزی',
  [FACT_KEYS.AMOUNT_SCALE]: 'مقیاس مبلغ',
  [FACT_KEYS.RECEIPT_PURPOSE]: 'بابت دریافت',
  [FACT_KEYS.PAYMENT_PURPOSE]: 'بابت پرداخت',
});

/**
 * واقعیت‌های لازم هر خانواده.
 *
 * `required` یعنی بدون آن سند ساخته نمی‌شود. `optional` یعنی اگر بود تصمیم
 * دقیق‌تر می‌شود ولی نبودش مانع نیست.
 *
 * مبلغ و تاریخ در همهٔ خانواده‌ها لازم‌اند و عمداً در تک‌تک فهرست‌ها تکرار
 * شده‌اند، نه به‌صورت یک پایهٔ مشترک: خانواده‌ای که روزی مبلغ نخواهد، نباید
 * مجبور باشد یک ارث ناخواسته را دور بزند.
 */
export const FACT_REQUIREMENTS = Object.freeze({
  // `intendedUse` عمداً پایهٔ خانواده نیست، اگرچه برای خرید کالا حیاتی است:
  // پیش‌پرداخت خدمت هدفش از خود دوره پیداست و پرسیدنش فقط یک سؤال اضافه است.
  // تفکیک موجودی از دارایی از هزینه، کار برخورد است و در فاز ۳ اجباری می‌شود.
  [ECONOMIC_FAMILIES.ASSET_CREATION]: Object.freeze({
    required: Object.freeze([FACT_KEYS.AMOUNT, FACT_KEYS.OCCURRED_AT]),
    optional: Object.freeze([FACT_KEYS.CASH_ACCOUNT, FACT_KEYS.COUNTERPARTY, FACT_KEYS.CATEGORY,
      FACT_KEYS.INTENDED_USE, FACT_KEYS.CONTRACT_REFERENCE, FACT_KEYS.DESCRIPTION]),
  }),
  // ارجاع به رویداد اصلی مالِ برخورد تخصیص است، نه خانواده: قبض برقی که
  // همین امروز پرداخت و مصرف شد، رویداد قبلی ندارد که به آن ارجاع بدهد.
  [ECONOMIC_FAMILIES.ASSET_CONSUMPTION]: Object.freeze({
    required: Object.freeze([FACT_KEYS.AMOUNT, FACT_KEYS.OCCURRED_AT]),
    optional: Object.freeze([FACT_KEYS.CATEGORY, FACT_KEYS.DESCRIPTION]),
  }),
  [ECONOMIC_FAMILIES.LIABILITY_CREATION]: Object.freeze({
    required: Object.freeze([FACT_KEYS.AMOUNT, FACT_KEYS.OCCURRED_AT, FACT_KEYS.COUNTERPARTY]),
    optional: Object.freeze([FACT_KEYS.CATEGORY, FACT_KEYS.SERVICE_PERIOD_START, FACT_KEYS.SERVICE_PERIOD_END, FACT_KEYS.CONTRACT_REFERENCE]),
  }),
  [ECONOMIC_FAMILIES.LIABILITY_SETTLEMENT]: Object.freeze({
    required: Object.freeze([FACT_KEYS.AMOUNT, FACT_KEYS.OCCURRED_AT, FACT_KEYS.CASH_ACCOUNT, FACT_KEYS.SETTLEMENT_REFERENCE]),
    optional: Object.freeze([FACT_KEYS.COUNTERPARTY]),
  }),
  [ECONOMIC_FAMILIES.RECEIVABLE_CREATION]: Object.freeze({
    required: Object.freeze([FACT_KEYS.AMOUNT, FACT_KEYS.OCCURRED_AT, FACT_KEYS.COUNTERPARTY]),
    optional: Object.freeze([FACT_KEYS.CATEGORY, FACT_KEYS.CONTRACT_REFERENCE, FACT_KEYS.DELIVERY_DATE]),
  }),
  [ECONOMIC_FAMILIES.RECEIVABLE_COLLECTION]: Object.freeze({
    required: Object.freeze([FACT_KEYS.AMOUNT, FACT_KEYS.OCCURRED_AT, FACT_KEYS.CASH_ACCOUNT, FACT_KEYS.SETTLEMENT_REFERENCE]),
    optional: Object.freeze([FACT_KEYS.COUNTERPARTY]),
  }),
  // تاریخ تحویل پایهٔ خانواده نیست: در فروش نقدی، تحویل و دریافت همان لحظه‌اند
  // و پرسیدن «کِی تحویل شد؟» از «امروز فروش نقدی داشتیم» فقط اصطکاک است.
  // وقتی گفته شده، تاریخ شناسایی همان است.
  [ECONOMIC_FAMILIES.REVENUE_RECOGNITION]: Object.freeze({
    required: Object.freeze([FACT_KEYS.AMOUNT, FACT_KEYS.OCCURRED_AT]),
    optional: Object.freeze([FACT_KEYS.DELIVERY_DATE, FACT_KEYS.COUNTERPARTY, FACT_KEYS.CATEGORY, FACT_KEYS.CASH_ACCOUNT, FACT_KEYS.CONTRACT_REFERENCE]),
  }),
  [ECONOMIC_FAMILIES.ADVANCE_RECEIVED]: Object.freeze({
    required: Object.freeze([FACT_KEYS.AMOUNT, FACT_KEYS.OCCURRED_AT, FACT_KEYS.COUNTERPARTY, FACT_KEYS.CASH_ACCOUNT]),
    optional: Object.freeze([FACT_KEYS.CONTRACT_REFERENCE, FACT_KEYS.SERVICE_PERIOD_START, FACT_KEYS.SERVICE_PERIOD_END]),
  }),
  // `refundable` اینجا لازم است چون همان سؤالی است که آورده را از وام شریک جدا
  // می‌کند: پولی که پس داده می‌شود بدهی است، پولی که پس داده نمی‌شود سرمایه.
  [ECONOMIC_FAMILIES.OWNER_CAPITAL_MOVEMENT]: Object.freeze({
    required: Object.freeze([FACT_KEYS.AMOUNT, FACT_KEYS.OCCURRED_AT, FACT_KEYS.CASH_ACCOUNT, FACT_KEYS.REFUNDABLE]),
    optional: Object.freeze([FACT_KEYS.COUNTERPARTY, FACT_KEYS.COUNTERPARTY_ROLE, FACT_KEYS.DESCRIPTION]),
  }),
  [ECONOMIC_FAMILIES.INTERNAL_TRANSFER]: Object.freeze({
    required: Object.freeze([FACT_KEYS.AMOUNT, FACT_KEYS.OCCURRED_AT, FACT_KEYS.CASH_ACCOUNT, FACT_KEYS.DESTINATION_ACCOUNT]),
    optional: Object.freeze([FACT_KEYS.DESCRIPTION]),
  }),
  [ECONOMIC_FAMILIES.VALUE_OR_ESTIMATE_CHANGE]: Object.freeze({
    required: Object.freeze([FACT_KEYS.AMOUNT, FACT_KEYS.OCCURRED_AT, FACT_KEYS.ESTIMATE_BASIS, FACT_KEYS.ORIGINAL_EVENT_REFERENCE]),
    optional: Object.freeze([FACT_KEYS.DESCRIPTION]),
  }),
  [ECONOMIC_FAMILIES.CORRECTION_OR_REVERSAL]: Object.freeze({
    required: Object.freeze([FACT_KEYS.ORIGINAL_EVENT_REFERENCE, FACT_KEYS.CORRECTION_REASON]),
    optional: Object.freeze([FACT_KEYS.AMOUNT, FACT_KEYS.OCCURRED_AT]),
  }),
  // خانوادهٔ نامشخص واقعیت لازم ندارد، چون اصلاً قرار نیست سند بسازد. فهرست
  // خالی یعنی «هیچ سؤالی کمکی نمی‌کند»، نه «همه‌چیز موجود است».
  [FAMILY_UNKNOWN]: Object.freeze({ required: Object.freeze([]), optional: Object.freeze([]) }),
});

/**
 * نحوهٔ برخورد — یک لایه زیر خانواده.
 *
 * چرا جدا از خانواده: «ایجاد دارایی» یک خانواده است ولی پیش‌پرداخت بیمه و خرید
 * موجودی و خرید دارایی ثابت سه برخورد متفاوت‌اند، و هر کدام واقعیت‌های اضافهٔ
 * خودش را می‌خواهد. اگر این‌ها خانوادهٔ جدا می‌شدند، تعداد خانواده‌ها منفجر
 * می‌شد و طبقه‌بندی بی‌معنا؛ اگر یکی می‌شدند، پیش‌پرداخت بدون دورهٔ پوشش ثبت
 * می‌شد.
 */
export const TREATMENTS = Object.freeze({
  PREPAID_EXPENSE: 'prepaid-expense',
  PERIOD_EXPENSE: 'period-expense',
  INVENTORY_PURCHASE: 'inventory-purchase',
  FIXED_ASSET: 'fixed-asset',
  REFUNDABLE_DEPOSIT: 'refundable-deposit',
  ACCRUED_EXPENSE: 'accrued-expense',
  PAYABLE_SETTLEMENT: 'payable-settlement',
  RECEIVABLE_SETTLEMENT: 'receivable-settlement',
  RECOGNIZED_REVENUE: 'recognized-revenue',
  DEFERRED_REVENUE: 'deferred-revenue',
  OWNER_CAPITAL: 'owner-capital',
  OWNER_DRAWING: 'owner-drawing',
  INTERNAL_MOVE: 'internal-move',
  SCHEDULED_ALLOCATION: 'scheduled-allocation',
  // تغییر شکل طلب: از حساب دریافتنی به اسناد دریافتنی. درآمدی شناسایی نمی‌شود
  // چون آن فروش قبلاً درآمد شده.
  CHEQUE_FORM_CHANGE: 'cheque-form-change',
  // پیش‌پرداخت به تأمین‌کننده: پول رفته، کالا یا خدمت هنوز نیامده. دارایی است
  // نه هزینه، و تا تحویل، هیچ سود و زیانی نمی‌سازد.
  SUPPLIER_ADVANCE: 'supplier-advance',
  // مساعدهٔ کارمند: طلب شرکت از همان کارمند، تا از حقوق بعدی کم شود.
  EMPLOYEE_ADVANCE: 'employee-advance',
  // درآمد تحقق‌یافته: تعهد انجام شده، پول نیامده.
  ACCRUED_REVENUE: 'accrued-revenue',
  // پیش‌دریافت بدون دورهٔ مشخص: بدهی، بدون برنامهٔ پخش.
  CUSTOMER_ADVANCE: 'customer-advance',
  // وام دریافتی: پول آمده ولی مال ما نیست؛ بدهی است، نه درآمد.
  LOAN_RECEIVED: 'loan-received',
  // واریزی که منشأش معلوم نیست: در «وجوه تعیین‌تکلیف‌نشده» می‌ماند تا روشن شود.
  UNIDENTIFIED_RECEIPT: 'unidentified-receipt',
});

/**
 * واقعیت‌های اضافه‌ای که هر برخورد می‌خواهد، فراتر از خانواده‌اش.
 *
 * `prepaid-expense` بدون دورهٔ پوشش نمی‌شود: مبلغ معلوم است، بانک معلوم است،
 * تاریخ معلوم است، ولی هیچ‌کس نمی‌داند این مبلغ روی چند ماه پخش شود. این دقیقاً
 * همان ایرادی است که مدیر دفتر گرفت.
 */
export const TREATMENT_EXTRA_REQUIREMENTS = Object.freeze({
  [TREATMENTS.PREPAID_EXPENSE]: Object.freeze([FACT_KEYS.SERVICE_PERIOD_START, FACT_KEYS.SERVICE_PERIOD_END]),
  [TREATMENTS.DEFERRED_REVENUE]: Object.freeze([FACT_KEYS.SERVICE_PERIOD_START, FACT_KEYS.SERVICE_PERIOD_END]),
  [TREATMENTS.FIXED_ASSET]: Object.freeze([FACT_KEYS.ASSET_NAME, FACT_KEYS.READY_FOR_USE_DATE, FACT_KEYS.USEFUL_LIFE_MONTHS]),
  // شمارهٔ قرارداد ودیعه را صاحب کسب‌وکار معمولاً سرِ ثبت نمی‌داند؛ لازم‌کردنش
  // ساده‌ترین ودیعه را به صف حسابدار می‌فرستاد. طرف حساب کافی است تا مانده
  // به تفکیک صاحبخانه دیده شود.
  [TREATMENTS.REFUNDABLE_DEPOSIT]: Object.freeze([FACT_KEYS.COUNTERPARTY]),
  [TREATMENTS.SUPPLIER_ADVANCE]: Object.freeze([FACT_KEYS.COUNTERPARTY]),
  [TREATMENTS.EMPLOYEE_ADVANCE]: Object.freeze([FACT_KEYS.COUNTERPARTY]),
  // نام و تعداد اقلام شرط ثبت موجودی نیست: ارزش خرید در «موجودی کالا —
  // تفکیک‌نشده» می‌نشیند و تفکیکش به کارت کالا بعداً انجام می‌شود (تصمیم مهر ۱۴۰۵).
  [TREATMENTS.INVENTORY_PURCHASE]: Object.freeze([]),
  [TREATMENTS.SCHEDULED_ALLOCATION]: Object.freeze([FACT_KEYS.ORIGINAL_EVENT_REFERENCE]),
});

/**
 * سؤالِ هر واقعیت مفقود.
 *
 * دو شکل دارد و انتخاب میانشان یک قاعده است، نه سلیقه:
 *
 * - جواب شمردنی است → گزینه. کاربر می‌زند، مقدار مستقیم می‌نشیند، هیچ متنی
 *   تفسیر نمی‌شود. یک کلاس کامل از خطای برداشت اینجا حذف می‌شود.
 * - جواب شمردنی نیست → ورودی آزاد؛ تایپ یا صدا، هرکدام که کاربر خواست.
 *
 * هر سؤال فقط یک واقعیت را می‌پرسد. دو کمبود یعنی دو سؤال پشت سر هم، نه یک فرم —
 * فرم یعنی کاربر باید همه را با هم بداند، و کسی که یکی را نمی‌داند کل کار را رها
 * می‌کند.
 */
export const QUESTION_KINDS = Object.freeze({ OPTIONS: 'options', FREE_INPUT: 'free-input' });

export const FACT_QUESTIONS = Object.freeze({
  [FACT_KEYS.SERVICE_PERIOD_START]: Object.freeze({
    kind: QUESTION_KINDS.OPTIONS,
    text: 'دورهٔ پوشش از کِی شروع می‌شود؟',
    options: Object.freeze([
      Object.freeze({ value: 'this-month', label: 'از همین ماه' }),
      Object.freeze({ value: 'next-month', label: 'از اول ماه بعد' }),
      Object.freeze({ value: 'already-passed', label: 'دوره‌اش گذشته' }),
      Object.freeze({ value: 'custom', label: 'تاریخش را می‌گویم', freeInput: true }),
    ]),
  }),
  [FACT_KEYS.SERVICE_PERIOD_END]: Object.freeze({
    kind: QUESTION_KINDS.OPTIONS,
    text: 'تا کِی ادامه دارد؟',
    options: Object.freeze([
      Object.freeze({ value: 'one-year', label: 'یک سال' }),
      Object.freeze({ value: 'six-months', label: 'شش ماه' }),
      Object.freeze({ value: 'three-months', label: 'سه ماه' }),
      Object.freeze({ value: 'custom', label: 'تاریخش را می‌گویم', freeInput: true }),
    ]),
  }),
  [FACT_KEYS.REFUNDABLE]: Object.freeze({
    kind: QUESTION_KINDS.OPTIONS,
    text: 'این مبلغ قابل استرداد است یا مصرف می‌شود؟',
    options: Object.freeze([
      Object.freeze({ value: true, label: 'قابل استرداد است' }),
      Object.freeze({ value: false, label: 'مصرف می‌شود' }),
    ]),
  }),
  [FACT_KEYS.INTENDED_USE]: Object.freeze({
    kind: QUESTION_KINDS.OPTIONS,
    text: 'این خرید برای چیست؟',
    options: Object.freeze([
      Object.freeze({ value: 'resale', label: 'فروش مجدد' }),
      Object.freeze({ value: 'production', label: 'مصرف در تولید' }),
      Object.freeze({ value: 'long-term-use', label: 'استفادهٔ بلندمدت' }),
      Object.freeze({ value: 'current-consumption', label: 'مصرف جاری' }),
    ]),
  }),
  [FACT_KEYS.COUNTERPARTY_ROLE]: Object.freeze({
    kind: QUESTION_KINDS.OPTIONS,
    text: 'این شخص چه نسبتی با کسب‌وکار دارد؟',
    options: Object.freeze([
      Object.freeze({ value: 'owner', label: 'مالک یا شریک' }),
      Object.freeze({ value: 'supplier', label: 'فروشنده' }),
      Object.freeze({ value: 'customer', label: 'مشتری' }),
      Object.freeze({ value: 'employee', label: 'کارمند' }),
      Object.freeze({ value: 'authority', label: 'سازمان یا اداره' }),
    ]),
  }),
  /**
   * گزینه‌هایش پویاست: خودِ دو مبلغ نشان داده می‌شوند، نه اصطلاح فنی.
   * «۳۰٬۰۰۰ تومان» یا «۳۰٬۰۰۰٬۰۰۰ تومان» — کاربر عدد را می‌بیند و انتخاب
   * می‌کند؛ پرسیدن «هزار یا میلیون؟» یک پلهٔ فکری اضافه است.
   */
  [FACT_KEYS.AMOUNT_SCALE]: Object.freeze({
    kind: QUESTION_KINDS.OPTIONS,
    text: 'کدام مبلغ درست است؟',
    options: Object.freeze([]),
    buildOptions(facts) {
      const base = Math.round(Number(facts?.amount) || 0);
      if (!(base > 0)) return [];
      const money = (value) => value.toLocaleString('fa-IR');
      return [
        { value: base, label: `${money(base)} تومان` },
        { value: base * 1000, label: `${money(base * 1000)} تومان` },
      ];
    },
  }),
  [FACT_KEYS.CHEQUE_AGAINST]: Object.freeze({
    kind: QUESTION_KINDS.OPTIONS,
    text: 'این چک بابت چیست؟',
    options: Object.freeze([
      Object.freeze({ value: 'income', label: 'بابت فروش یا خرید تازه' }),
      Object.freeze({ value: 'receivable', label: 'بابت طلب یا بدهی قبلی' }),
    ]),
  }),
  /**
   * «این پول بابت چه بود؟» — جای صف حسابدار برای ساده‌ترین دریافت‌ها.
   *
   * دستهٔ «سایر درآمدها» هم فروش است، هم وام، هم واریزی که معلوم نیست از
   * کیست. حدس زدن میانشان یعنی وام درآمد شود؛ فرستادنشان به حسابدار یعنی
   * ساده‌ترین دریافت روز کار حسابدار شود. یک سؤال گزینه‌ای هر دو را حل می‌کند.
   */
  [FACT_KEYS.RECEIPT_PURPOSE]: Object.freeze({
    kind: QUESTION_KINDS.OPTIONS,
    text: 'این پول بابت چه بود؟',
    options: Object.freeze([
      Object.freeze({ value: 'sale', label: 'فروش کالا یا خدمتی که انجام شد' }),
      Object.freeze({ value: 'advance', label: 'پیش‌دریافت؛ کار یا کالا هنوز تحویل نشده' }),
      Object.freeze({ value: 'loan', label: 'وام یا قرض؛ باید پس داده شود' }),
      Object.freeze({ value: 'owner', label: 'آوردهٔ مالک یا شریک' }),
      Object.freeze({ value: 'other-income', label: 'سود بانکی یا درآمد متفرقه' }),
      Object.freeze({ value: 'unknown', label: 'معلوم نیست از کیست' }),
      Object.freeze({ value: 'other', label: 'هیچ‌کدام؛ حسابدار بررسی کند' }),
    ]),
  }),
  [FACT_KEYS.PAYMENT_PURPOSE]: Object.freeze({
    kind: QUESTION_KINDS.OPTIONS,
    text: 'این پرداخت بابت چه بود؟',
    options: Object.freeze([
      Object.freeze({ value: 'expense', label: 'هزینهٔ جاری کسب‌وکار' }),
      Object.freeze({ value: 'goods', label: 'خرید کالا یا تجهیزات' }),
      Object.freeze({ value: 'owner-drawing', label: 'برداشت شخصی مالک یا شریک' }),
      Object.freeze({ value: 'advance', label: 'پیش‌پرداخت؛ کالا یا خدمت هنوز نرسیده' }),
      Object.freeze({ value: 'deposit', label: 'ودیعه یا سپرده‌ای که برمی‌گردد' }),
      Object.freeze({ value: 'other', label: 'هیچ‌کدام؛ حسابدار بررسی کند' }),
    ]),
  }),
  [FACT_KEYS.AMOUNT]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'مبلغ چقدر بود؟' }),
  [FACT_KEYS.CASH_ACCOUNT]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'از کدام حساب؟' }),
  [FACT_KEYS.DESTINATION_ACCOUNT]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'به کدام حساب؟' }),
  [FACT_KEYS.COUNTERPARTY]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'طرف حساب چه کسی است؟' }),
  [FACT_KEYS.SETTLEMENT_REFERENCE]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'بابت کدام سند؟' }),
  [FACT_KEYS.OBLIGATION_REFERENCE]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'مربوط به کدام تعهد است؟' }),
  [FACT_KEYS.CONTRACT_REFERENCE]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'شمارهٔ قرارداد چیست؟' }),
  [FACT_KEYS.DELIVERY_DATE]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'کِی تحویل شد یا انجام شد؟' }),
  [FACT_KEYS.OCCURRED_AT]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'تاریخش چه بود؟' }),
  [FACT_KEYS.CATEGORY]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'در چه دسته‌ای ثبت شود؟' }),
  [FACT_KEYS.DESCRIPTION]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'بابت چه چیزی بود؟' }),
  [FACT_KEYS.ASSET_NAME]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'نام دارایی چیست؟' }),
  [FACT_KEYS.READY_FOR_USE_DATE]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'از چه تاریخی آمادهٔ استفاده شد؟' }),
  [FACT_KEYS.USEFUL_LIFE_MONTHS]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'عمر مفیدش چند ماه است؟' }),
  [FACT_KEYS.ESTIMATE_BASIS]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'برآورد بر چه مبنایی است؟' }),
  [FACT_KEYS.ORIGINAL_EVENT_REFERENCE]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'کدام ثبت قبلی؟' }),
  [FACT_KEYS.CORRECTION_REASON]: Object.freeze({ kind: QUESTION_KINDS.FREE_INPUT, text: 'چه چیزی اشتباه بود؟' }),
});

/**
 * واقعیت‌های لازم یک خانواده و برخوردش را برمی‌گرداند.
 *
 * `treatment` اختیاری است: وقتی هنوز معلوم نیست برخورد چیست، فقط پایهٔ خانواده
 * لازم است. ترتیب حفظ می‌شود — اول پایهٔ خانواده، بعد اضافه‌های برخورد — چون
 * همین ترتیب تعیین می‌کند کدام سؤال اول پرسیده شود.
 */
export function requiredFactsFor(family, treatment = null) {
  const base = FACT_REQUIREMENTS[family]?.required || [];
  const extra = treatment ? (TREATMENT_EXTRA_REQUIREMENTS[treatment] || []) : [];
  return [...new Set([...base, ...extra])];
}

/**
 * کمبودها را نام می‌برد.
 *
 * واقعیتی که مقدارش `null` یا `undefined` یا رشتهٔ خالی باشد، مفقود است.
 * `false` و `0` مفقود نیستند — «قابل استرداد نیست» یک جواب است، نه نبودِ جواب.
 * این تفاوت کوچک به نظر می‌رسد ولی اگر رعایت نشود، سیستم برای هر «نه» دوباره
 * سؤال می‌پرسد.
 */
export function missingFactsFor(family, treatment = null, facts = {}) {
  return requiredFactsFor(family, treatment).filter((key) => !isFactPresent(facts?.[key]));
}

/**
 * سؤال بعدی — یکی، نه همه.
 *
 * وقتی چند واقعیت کم است، فقط اولی پرسیده می‌شود. فرم یعنی کاربر باید همه را
 * با هم بداند، و کسی که یکی را نمی‌داند کل کار را رها می‌کند.
 */
export function nextQuestionFor(missingFacts = [], facts = {}) {
  const fact = (missingFacts || []).find((key) => FACT_QUESTIONS[key]);
  if (!fact) return null;
  const question = FACT_QUESTIONS[fact];
  // گزینه‌های پویا از خودِ واقعیت‌ها ساخته می‌شوند: سؤال مقیاس مبلغ باید دو
  // عددِ واقعی را نشان بدهد، نه دو اصطلاح.
  const options = question.buildOptions ? question.buildOptions(facts) : (question.options ? [...question.options] : null);
  return Object.freeze({
    fact,
    kind: question.kind,
    text: question.text,
    label: FACT_LABELS[fact],
    options: options && options.length ? options : null,
  });
}
