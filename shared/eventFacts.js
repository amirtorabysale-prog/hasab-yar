import { EVENT_KINDS } from './financialEvent.js';
import { FACT_KEYS } from './factRequirements.js';

/**
 * از رویداد مالی، واقعیت‌های موتور تصمیم.
 *
 * چرا این ترجمه لازم است:
 *
 * رویداد مالی شکل تاریخی خودش را دارد و نمی‌شود یک‌شبه عوضش کرد — همهٔ مسیرهای
 * موجود رویش سوارند. موتور تصمیم واژگان خودش را دارد که بسته و آزمون‌پذیر است.
 * این فایل پل میان آن دو است و هیچ تصمیمی نمی‌گیرد؛ فقط نام‌ها را ترجمه می‌کند.
 *
 * یک نکته که ساده به نظر می‌رسد و نیست: جهت حرکت پول از **نوع رویداد**
 * درمی‌آید، نه از واژه‌های جمله و نه از برداشت مدل. `cash-expense` یعنی پول
 * خارج شد — همین، و نه «هزینه شد». آن دومی یک تصمیم است و اینجا گرفته نمی‌شود.
 */

const MONEY_OUT = new Set([
  EVENT_KINDS.CASH_EXPENSE,
  EVENT_KINDS.FIXED_ASSET_PURCHASE,
]);

const MONEY_IN = new Set([
  EVENT_KINDS.CASH_INCOME,
  EVENT_KINDS.CAPITAL_CONTRIBUTION,
]);

/**
 * رویدادهایی که تعهد می‌سازند و پولی جابه‌جا نمی‌کنند.
 *
 * فاکتور و طلب و بدهی، پول را تکان نمی‌دهند. اگر «خروج وجه» شمرده شوند، موتور
 * دنبال حساب بانکی می‌گردد که اصلاً درگیر نبوده.
 */
const MONEY_NONE = new Set([
  EVENT_KINDS.RECEIVABLE_OPENED, EVENT_KINDS.PAYABLE_OPENED,
  EVENT_KINDS.CHEQUE_RECEIVED, EVENT_KINDS.CHEQUE_ISSUED,
  EVENT_KINDS.SALES_INVOICE, EVENT_KINDS.PURCHASE_INVOICE,
  EVENT_KINDS.DEPRECIATION,
]);

export function moneyDirectionOf(event) {
  const kind = event?.kind;
  if (MONEY_OUT.has(kind)) return 'out';
  if (MONEY_IN.has(kind)) return 'in';
  if (MONEY_NONE.has(kind)) return 'none';
  // تسویه و پرداخت فاکتور، جهتشان از خودِ رویداد درنمی‌آید: بستگی دارد طلب
  // وصول شده یا بدهی پرداخت. `settlementDirection` همان را می‌گوید.
  if (kind === EVENT_KINDS.OBLIGATION_SETTLED || kind === EVENT_KINDS.INVOICE_PAYMENT) {
    return event?.settlementDirection === 'payable' ? 'out' : 'in';
  }
  return null;
}

/**
 * واقعیت‌های یک رویداد، به واژگان موتور تصمیم.
 *
 * فقط چیزهایی که واقعاً در رویداد هستند برگردانده می‌شوند. مقدار خالی حذف
 * می‌شود تا «نبودِ واقعیت» از «واقعیتِ خالی» قابل تفکیک بماند — موتور تصمیم
 * روی همین تفاوت کار می‌کند.
 */
export function factsFromEvent(event = {}) {
  const facts = {
    moneyDirection: moneyDirectionOf(event),
    [FACT_KEYS.AMOUNT]: event.amount,
    [FACT_KEYS.OCCURRED_AT]: event.occurredAt,
    [FACT_KEYS.CASH_ACCOUNT]: event.accountId,
    [FACT_KEYS.DESTINATION_ACCOUNT]: event.destinationAccountId,
    [FACT_KEYS.COUNTERPARTY]: event.counterparty,
    [FACT_KEYS.COUNTERPARTY_ROLE]: event.counterpartyRole,
    [FACT_KEYS.CATEGORY]: event.category,
    [FACT_KEYS.DESCRIPTION]: event.description,
    [FACT_KEYS.SERVICE_PERIOD_START]: event.servicePeriodStart,
    [FACT_KEYS.SERVICE_PERIOD_END]: event.servicePeriodEnd,
    [FACT_KEYS.REFUNDABLE]: event.refundable,
    [FACT_KEYS.INTENDED_USE]: event.intendedUse,
    [FACT_KEYS.CONTRACT_REFERENCE]: event.contractReference,
    // ارجاع تسویه فقط وقتی معنا دارد که رویداد واقعاً تسویه باشد. چسباندنش به
    // هر رویدادی که `reference` دارد، یک هزینهٔ عادی را تسویه جا می‌زد.
    [FACT_KEYS.SETTLEMENT_REFERENCE]: event.settlementDirection ? event.reference : undefined,
    [FACT_KEYS.CHEQUE_AGAINST]: event.chequeAgainst,
    // چک ابزار است نه ماهیت؛ ولی جهتش تعیین می‌کند دریافتنی ساخته می‌شود یا
    // بدهی، و طبقه‌بند بدون آن چک دریافتی را بدهی می‌خواند.
    chequeDirection: event.kind === EVENT_KINDS.CHEQUE_RECEIVED ? 'receivable'
      : event.kind === EVENT_KINDS.CHEQUE_ISSUED ? 'payable' : undefined,
    prepaymentSignal: event.prepaymentSignal || undefined,
    amountScaleAmbiguous: event.amountScaleAmbiguous || undefined,
    evidence: event.evidence,
  };
  for (const [key, value] of Object.entries(facts)) {
    if (value === undefined || value === null || value === '') delete facts[key];
  }
  return facts;
}
