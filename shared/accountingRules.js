import { EVENT_KINDS } from './financialEvent.js';

/**
 * قواعد حسابداری — از رویداد مالی، نقشهٔ سند.
 *
 * این ماژول عمداً هیچ دیتابیسی نمی‌شناسد و هیچ حسابی نمی‌سازد. فقط می‌گوید
 * «برای این رویداد، کدام نقش‌ها بدهکار و کدام بستانکار می‌شوند». نگاشت نقش به
 * حساب واقعی کار لایهٔ سرور است، چون کدینگ هر دفتر فرق می‌کند.
 *
 * چرا جدا از مدل زبانی: این قواعد باید **اثبات‌پذیر** باشند. وقتی داخل پرامپت
 * باشند، فقط می‌شود امید داشت که «خرید دارایی ثابت هزینهٔ دوره نمی‌شود»؛ وقتی
 * اینجا باشند، یک آزمون همین را تضمین می‌کند و با هر نسخهٔ مدل هم عوض نمی‌شود.
 */

/**
 * نقش‌های حساب.
 *
 * نقش، نه کد: «۸۱۰۲» در یک دفتر اجاره است و در دفتر دیگر چیز دیگری. قاعده باید
 * با معنا کار کند تا با هر کدینگی درست بماند.
 */
export const ROLES = Object.freeze({
  CASH: 'cash',
  TAX_RECEIVABLE: 'tax-receivable',
  PARTNER_PAYABLE: 'partner-payable',
  PARTNER_RECEIVABLE: 'partner-receivable',
  UNIDENTIFIED_RECEIPT: 'unidentified-receipt',
  RECEIVABLE: 'receivable',
  PAYABLE: 'payable',
  CHEQUE_RECEIVABLE: 'cheque-receivable',
  CHEQUE_PAYABLE: 'cheque-payable',
  INCOME_CATEGORY: 'income-category',
  EXPENSE_CATEGORY: 'expense-category',
  OWNER_CAPITAL: 'owner-capital',
  FIXED_ASSET: 'fixed-asset',
  // پیش‌پرداخت: پولی که رفته ولی منفعتش هنوز نیامده. دارایی است تا وقتی دوره‌اش
  // مصرف شود. حساب «۱۴۰۱ — پیش‌پرداخت‌ها» از قبل در جدول حساب‌ها بود و هیچ
  // قاعده‌ای به آن نمی‌رسید.
  PREPAID_ASSET: 'prepaid-asset',
  REFUNDABLE_DEPOSIT: 'refundable-deposit',
  LOAN_PAYABLE: 'loan-payable',
  // پیش‌دریافت از مشتری: پول آمده ولی هنوز کاری نکرده‌ایم. بدهی ماست، نه
  // درآمد. شناسایی درآمد وقتی است که تعهد انجام شود.
  CUSTOMER_ADVANCE: 'customer-advance',
  // درآمد انتقالی: پیش‌دریافتی که دوره‌اش مشخص است و ماه‌به‌ماه درآمد می‌شود.
  DEFERRED_REVENUE: 'deferred-revenue',
  // ارزش افزوده پول سازمان است که کسب‌وکار فقط جمعش می‌کند یا جلو می‌دهد؛
  // هیچ‌کدام هزینه یا درآمد نیست. همان دو حسابی که فاکتور و تسویهٔ دوره
  // می‌شناسند، نه حساب تازه، وگرنه ماندهٔ تسویه از دو جا جمع می‌شود.
  VAT_OUTPUT: 'vat-output',
  VAT_INPUT: 'vat-input',
  ACCUMULATED_DEPRECIATION: 'accumulated-depreciation',
  DEPRECIATION_EXPENSE: 'depreciation-expense',
  // برداشت شخصی مالک: از حقوق صاحبان سهام کم می‌کند، ولی جدا از آورده نگه
  // داشته می‌شود تا مانده‌ها قابل خواندن بمانند. هزینه نیست.
  OWNER_DRAWING: 'owner-drawing',
  // پیش‌پرداخت خرید به تفکیک تأمین‌کننده؛ همان حسابی که مسیر بررسی حسابدار
  // می‌سازد، تا یک تأمین‌کننده دو حساب پیش‌پرداخت پیدا نکند.
  SUPPLIER_ADVANCE: 'supplier-advance',
  // موجودی کالایی که نام و تعدادش هنوز گفته نشده. ارزشش درست می‌نشیند و
  // تفکیکش به کارت کالا بعداً انجام می‌شود؛ بهتر از اینکه کل خرید منتظر بماند.
  INVENTORY_UNSPLIT: 'inventory-unsplit',
  // مساعده و طلب از کارکنان، به تفکیک هر کارمند.
  EMPLOYEE_ADVANCE: 'employee-advance',
});

function ruleError(message, code = 'RULE_UNSUPPORTED') {
  return Object.assign(new Error(message), { code, status: 400 });
}

/**
 * نقشهٔ سند: دو طرف با نقش و مبلغ.
 *
 * خروجی همیشه متوازن است و همین‌جا کنترل می‌شود، نه در لایهٔ ثبت. سند نامتوازن
 * نباید اصلاً ساخته شود تا لازم نباشد جایی بعداً ردش کند.
 */
function plan(kind, debit, credit, amount, memoHint) {
  const lines = [
    { role: debit.role, key: debit.key || null, debit: amount, credit: 0 },
    { role: credit.role, key: credit.key || null, debit: 0, credit: amount },
  ];
  const debitTotal = lines.reduce((sum, line) => sum + line.debit, 0);
  const creditTotal = lines.reduce((sum, line) => sum + line.credit, 0);
  if (debitTotal !== creditTotal) throw ruleError('نقشهٔ سند متوازن نیست.', 'RULE_UNBALANCED');
  return { kind, lines, memoHint };
}

/**
 * نقشهٔ سند برای یک رویداد.
 *
 * `key` شناسهٔ زیرحساب است — نام دسته، نام طرف حساب یا نام دارایی — تا لایهٔ
 * سرور بتواند حساب دقیق را پیدا یا بسازد.
 */
/**
 * نقشه‌هایی که از **تصمیم** می‌آیند، نه از نوع رویداد.
 *
 * این همان جای خالی مسیر قدیمی است. تا امروز `cash-expense` هم‌زمان می‌گفت
 * «پول خارج شد» و «هزینهٔ دوره شد»، پس اگر بالادست می‌فهمید این پرداخت یک
 * پیش‌پرداخت است، جایی برای گفتنش نبود. حالا هست: تصمیم برخورد را می‌گوید و
 * قاعده سند همان برخورد را می‌سازد.
 *
 * فقط برخوردهایی اینجا هستند که در این فاز قاعده دارند. بقیه به مسیر قدیمی
 * می‌افتند و رفتارشان عوض نمی‌شود.
 */
const TREATMENT_PLANS = Object.freeze({
  // جهت ب — مصرف پیش از پرداخت. هزینه در دورهٔ مصرف شناسایی می‌شود و بدهی
  // ساخته می‌شود؛ نقد اصلاً لمس نمی‌شود چون هنوز پولی جابه‌جا نشده.
  'accrued-expense': (event, amount) => plan(event.kind,
    { role: ROLES.EXPENSE_CATEGORY, key: event.category },
    { role: ROLES.PAYABLE, key: event.counterparty }, amount, event.category),

  // جهت ج — دریافت پیش از انجام تعهد. پیش‌دریافت بدهی ماست، نه درآمد.
  // شناسایی درآمد وقتی است که تعهد انجام شود.
  'customer-advance': (event, amount) => plan(event.kind,
    { role: ROLES.CASH, key: event.accountId },
    { role: ROLES.CUSTOMER_ADVANCE, key: event.counterparty }, amount, event.counterparty),

  'deferred-revenue': (event, amount) => plan(event.kind,
    { role: ROLES.CASH, key: event.accountId },
    { role: ROLES.DEFERRED_REVENUE, key: event.counterparty }, amount, event.counterparty),

  // جهت د — انجام تعهد پیش از دریافت. تعهد انجام شده، پس درآمد شناسایی
  // می‌شود و طلب ساخته می‌شود.
  'accrued-revenue': (event, amount) => plan(event.kind,
    { role: ROLES.RECEIVABLE, key: event.counterparty },
    { role: ROLES.INCOME_CATEGORY, key: event.category }, amount, event.counterparty),

  // چک بابت طلب قبلی: فقط شکل طلب عوض می‌شود. آن فروش همان روزی که فاکتور
  // ثبت شد درآمد شده؛ شناسایی دوباره‌اش یعنی یک فروش، دو بار در سود دوره و
  // دو بار در مالیات.
  'cheque-form-change': (event, amount) => plan(event.kind,
    { role: ROLES.CHEQUE_RECEIVABLE, key: event.counterparty },
    { role: ROLES.RECEIVABLE, key: event.counterparty }, amount, event.counterparty),
  'prepaid-expense': (event, amount) => plan(event.kind,
    { role: ROLES.PREPAID_ASSET, key: event.category },
    { role: ROLES.CASH, key: event.accountId }, amount, event.category),

  // وام دریافتی بدهی است؛ درآمد کردنش سود دوره را به اندازهٔ کل وام باد می‌کرد.
  'loan-received': (event, amount) => plan(event.kind,
    { role: ROLES.CASH, key: event.accountId },
    { role: ROLES.LOAN_PAYABLE, key: event.counterparty }, amount, event.counterparty || 'وام دریافتی'),

  // واریزی که منشأش معلوم نیست تا تعیین تکلیف بدهی موقت است، نه درآمد.
  'unidentified-receipt': (event, amount) => plan(event.kind,
    { role: ROLES.CASH, key: event.accountId },
    { role: ROLES.UNIDENTIFIED_RECEIPT, key: null }, amount, 'واریز با منشأ نامعلوم'),

  'owner-capital': (event, amount) => plan(event.kind,
    { role: ROLES.CASH, key: event.accountId },
    { role: ROLES.OWNER_CAPITAL, key: null }, amount, 'آوردهٔ مالک'),

  'owner-drawing': (event, amount) => plan(event.kind,
    { role: ROLES.OWNER_DRAWING, key: null },
    { role: ROLES.CASH, key: event.accountId }, amount, 'برداشت شخصی مالک'),

  // پول رفته و کالا یا خدمت هنوز نرسیده: دارایی است، نه هزینه و نه موجودی.
  'employee-advance': (event, amount) => plan(event.kind,
    { role: ROLES.EMPLOYEE_ADVANCE, key: event.counterparty },
    { role: ROLES.CASH, key: event.accountId }, amount, event.counterparty),
  'supplier-advance': (event, amount) => plan(event.kind,
    { role: ROLES.SUPPLIER_ADVANCE, key: event.counterparty },
    { role: ROLES.CASH, key: event.accountId }, amount, event.counterparty),

  'refundable-deposit': (event, amount) => plan(event.kind,
    { role: ROLES.REFUNDABLE_DEPOSIT, key: event.counterparty },
    { role: ROLES.CASH, key: event.accountId }, amount, event.counterparty),

  // کالای خریده‌شده برای فروش یا تولید موجودی است. طرف بستانکار از خودِ
  // رویداد می‌آید: نقد، نسیه یا چک — همان خرید، سه شکل پرداخت.
  'inventory-purchase': (event, amount) => plan(event.kind,
    { role: ROLES.INVENTORY_UNSPLIT, key: null },
    purchaseCreditSide(event), amount, event.counterparty || event.description || event.category),
});

function purchaseCreditSide(event) {
  if (event.kind === EVENT_KINDS.PAYABLE_OPENED) return { role: ROLES.PAYABLE, key: event.counterparty };
  if (event.kind === EVENT_KINDS.CHEQUE_ISSUED) return { role: ROLES.CHEQUE_PAYABLE, key: event.counterparty };
  return { role: ROLES.CASH, key: event.accountId };
}

/**
 * آیا این برخورد نقشهٔ مخصوص خودش را دارد؟
 *
 * لایهٔ ثبت به این نیاز دارد: رویدادی که از یک ردیف تراکنش آمده، سندش را از
 * مسیر جاافتادهٔ تراکنش می‌گیرد — و آن مسیر فقط هزینه و درآمد می‌شناسد. اگر
 * تصمیم گفته باشد این پرداخت پیش‌پرداخت است، آن مسیر حرف تصمیم را نمی‌فهمد و
 * بی‌صدا هزینه ثبت می‌کند. یعنی کل لایهٔ تصمیم برای پرحجم‌ترین مسیر دور زده
 * می‌شد.
 */
export function treatmentHasPlan(treatment) {
  return Boolean(treatment) && Object.hasOwn(TREATMENT_PLANS, treatment);
}

/**
 * نقشهٔ سند برای یک رویداد.
 *
 * `decision` اختیاری است. وقتی نیاید — یعنی موتور نسخهٔ دو خاموش است — رفتار
 * دقیقاً همان قبلی است و هیچ مسیر موجودی عوض نمی‌شود.
 */
export function planJournal(event, decision = null) {
  return applyFunding(planJournalCore(event, decision), event);
}

/**
 * منبع پولی جز صندوق و بانک شرکت.
 *
 * هزینه یا خریدی که شریک یا کارمند از پول شخصی‌اش داد، همان سند عادی را دارد —
 * هزینه، پیش‌پرداخت، موجودی یا دارایی ثابت، هرچه موتور تصمیم گفته — با این
 * تفاوت که سطرِ صندوق یا بانک جایش را به جاری شریک یا پرداختنیِ کارمند می‌دهد.
 * یک قاعده برای همهٔ برخوردها، نه یک نسخهٔ دوم از هر کدام.
 */
export function applyFunding(plan, event) {
  if (!event?.fundedBy || !plan?.lines) return plan;
  const role = event.fundedBy === 'employee' ? ROLES.PAYABLE : ROLES.PARTNER_PAYABLE;
  const key = event.payerName || (event.fundedBy === 'employee' ? 'کارمند' : 'شریک');
  return { ...plan, fundedBy: event.fundedBy, lines: plan.lines.map((line) => (line.role === ROLES.CASH ? { ...line, role, key } : line)) };
}

function planJournalCore(event, decision = null) {
  if (!event || !event.kind) throw ruleError('رویداد برای ساخت سند معتبر نیست.');
  const { amount, category, counterparty, description, reference } = event;

  const fromTreatment = decision?.treatment ? TREATMENT_PLANS[decision.treatment] : null;
  if (fromTreatment) return fromTreatment(event, amount);

  switch (event.kind) {
    // این «نقشه» عمداً سطری ندارد و با نگهبان صف مسدود است؛ حتی یک تأیید
    // اشتباهی نباید برای گفتهٔ چندمبلغی سند نقدی بسازد.
    case EVENT_KINDS.REVIEW_PLACEHOLDER:
      return { kind: event.kind, lines: [], memoHint: 'گفتهٔ چندمبلغی نیازمند بازسازی سند' };
    // پول از صندوق بیرون رفت و هزینهٔ دوره شد.
    case EVENT_KINDS.CASH_EXPENSE:
      return plan(event.kind, { role: ROLES.EXPENSE_CATEGORY, key: category }, { role: ROLES.CASH, key: event.accountId }, amount, category);

    case EVENT_KINDS.CASH_INCOME:
      return plan(event.kind, { role: ROLES.CASH, key: event.accountId }, { role: ROLES.INCOME_CATEGORY, key: category }, amount, category);

    // طلب: هنوز پولی جابه‌جا نشده، ولی حق دریافت ساخته شده.
    case EVENT_KINDS.RECEIVABLE_OPENED:
      return plan(event.kind, { role: ROLES.RECEIVABLE, key: counterparty }, { role: ROLES.INCOME_CATEGORY, key: category }, amount, counterparty);

    case EVENT_KINDS.PAYABLE_OPENED:
      return plan(event.kind, { role: ROLES.EXPENSE_CATEGORY, key: category }, { role: ROLES.PAYABLE, key: counterparty }, amount, counterparty);

    // چک جای طلب و بدهی عادی نمی‌نشیند: سررسید و وضعیت وصول دارد، پس حساب
    // جداگانه می‌خواهد تا در تراز از مطالبات عادی قابل تفکیک باشد.
    case EVENT_KINDS.CHEQUE_RECEIVED:
      return plan(event.kind, { role: ROLES.CHEQUE_RECEIVABLE, key: counterparty }, { role: ROLES.INCOME_CATEGORY, key: category }, amount, counterparty);

    case EVENT_KINDS.CHEQUE_ISSUED:
      return plan(event.kind, { role: ROLES.EXPENSE_CATEGORY, key: category }, { role: ROLES.CHEQUE_PAYABLE, key: counterparty }, amount, counterparty);

    // تسویه فقط پول را جابه‌جا می‌کند؛ درآمد یا هزینه‌ای دوباره نمی‌سازد. اگر
    // اینجا دوباره به دستهٔ درآمد/هزینه می‌خورد، همان مبلغ دو بار در سود دوره
    // می‌آمد.
    case EVENT_KINDS.OBLIGATION_SETTLED: {
      const direction = event.settlementDirection === 'payable' ? 'payable' : 'receivable';
      return direction === 'receivable'
        ? plan(event.kind, { role: ROLES.CASH, key: event.accountId }, { role: ROLES.RECEIVABLE, key: counterparty }, amount, reference)
        : plan(event.kind, { role: ROLES.PAYABLE, key: counterparty }, { role: ROLES.CASH, key: event.accountId }, amount, reference);
    }

    // شریک یا مدیرعامل از پول شخصی خودش تعهد شرکت را بست. صندوق و بانک شرکت
    // لمس نمی‌شوند: بدهی به طلبکار بسته می‌شود و شرکت به همان اندازه به شریک
    // بدهکار می‌شود (جاری شریک). فروش داراییِ شخصیِ او هم درآمد شرکت نیست و
    // هیچ‌جای این سند نمی‌آید. وارونه‌اش — مشتری طلب ما را به حساب شخصی شریک
    // داد — طلب از مشتری را می‌بندد و شریک به شرکت بدهکار می‌شود.
    case EVENT_KINDS.OBLIGATION_SETTLED_BY_PARTNER: {
      const partner = event.payerName || 'شریک';
      return event.settlementDirection === 'receivable'
        ? plan(event.kind, { role: ROLES.PARTNER_RECEIVABLE, key: partner }, { role: ROLES.RECEIVABLE, key: counterparty }, amount, reference)
        : plan(event.kind, { role: ROLES.PAYABLE, key: counterparty }, { role: ROLES.PARTNER_PAYABLE, key: partner }, amount, reference);
    }

    // آوردهٔ مالک درآمد نیست: اگر به درآمد می‌خورد، سود دوره به اندازهٔ پولی که
    // خودِ مالک گذاشته باد می‌کرد و مالیات رویش حساب می‌شد.
    case EVENT_KINDS.CAPITAL_CONTRIBUTION:
      return plan(event.kind, { role: ROLES.CASH, key: event.accountId }, { role: ROLES.OWNER_CAPITAL, key: null }, amount, 'آوردهٔ مالک');

    // دارایی ثابت هزینهٔ دوره نیست: به بهای تمام‌شده می‌نشیند و به‌مرور مستهلک
    // می‌شود.
    case EVENT_KINDS.FIXED_ASSET_PURCHASE:
      return plan(event.kind, { role: ROLES.FIXED_ASSET, key: description }, { role: ROLES.CASH, key: event.accountId }, amount, description);

    // استهلاک، بهای دارایی را دست نمی‌زند؛ در حساب انباشتهٔ جدا می‌نشیند.
    case EVENT_KINDS.DEPRECIATION:
      return plan(event.kind, { role: ROLES.DEPRECIATION_EXPENSE, key: null }, { role: ROLES.ACCUMULATED_DEPRECIATION, key: description }, amount, description);

    case EVENT_KINDS.SALES_INVOICE:
      return plan(event.kind, { role: ROLES.RECEIVABLE, key: counterparty }, { role: ROLES.INCOME_CATEGORY, key: category }, amount, reference);

    case EVENT_KINDS.PURCHASE_INVOICE:
      return plan(event.kind, { role: ROLES.EXPENSE_CATEGORY, key: category }, { role: ROLES.PAYABLE, key: counterparty }, amount, reference);

    case EVENT_KINDS.INVOICE_PAYMENT: {
      const purchase = event.settlementDirection === 'payable';
      return purchase
        ? plan(event.kind, { role: ROLES.PAYABLE, key: counterparty }, { role: ROLES.CASH, key: event.accountId }, amount, reference)
        : plan(event.kind, { role: ROLES.CASH, key: event.accountId }, { role: ROLES.RECEIVABLE, key: counterparty }, amount, reference);
    }

    default:
      throw ruleError(`برای رویداد «${event.kind}» قاعدهٔ سند تعریف نشده است.`);
  }
}

/**
 * آیا این رویداد سود و زیان دوره را تکان می‌دهد؟
 *
 * برای گزارش و برای کنترل‌های کیفی لازم است: آورده، خرید دارایی و تسویه هیچ‌کدام
 * نباید در سود دوره دیده شوند، و این یک ادعای آزمون‌پذیر است نه یک قرارداد شفاهی.
 */
export function affectsProfit(kind) {
  const plan_ = { kind, amount: 1, category: 'x', counterparty: 'y', description: 'z', accountId: 'cash' };
  const lines = planJournal(plan_).lines;
  return lines.some((line) => [ROLES.INCOME_CATEGORY, ROLES.EXPENSE_CATEGORY, ROLES.DEPRECIATION_EXPENSE].includes(line.role));
}
