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
  ACCUMULATED_DEPRECIATION: 'accumulated-depreciation',
  DEPRECIATION_EXPENSE: 'depreciation-expense',
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
  'prepaid-expense': (event, amount) => plan(event.kind,
    { role: ROLES.PREPAID_ASSET, key: event.category },
    { role: ROLES.CASH, key: event.accountId }, amount, event.category),
});

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
  if (!event || !event.kind) throw ruleError('رویداد برای ساخت سند معتبر نیست.');
  const { amount, category, counterparty, description, reference } = event;

  const fromTreatment = decision?.treatment ? TREATMENT_PLANS[decision.treatment] : null;
  if (fromTreatment) return fromTreatment(event, amount);

  switch (event.kind) {
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
