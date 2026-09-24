/**
 * رویداد مالی — لایهٔ میانیِ مستقل بین فهم زبان و حسابداری.
 *
 * چرا این لایه وجود دارد:
 *
 * مدل زبانی فقط باید زبان را بفهمد. اگر بگذاریم سند حسابداری هم بسازد، دو چیز
 * خراب می‌شود. اول اینکه منطق حسابداری داخل پرامپت می‌رود و دیگر قابل آزمون
 * نیست — نمی‌شود ثابت کرد «خرید دارایی ثابت هرگز هزینهٔ دوره نمی‌شود»، فقط
 * می‌شود امید داشت. دوم اینکه هر تغییر در کدینگ حساب‌ها یعنی تغییر پرامپت، و
 * رفتار مدل با هر نسخه عوض می‌شود.
 *
 * پس مرز اینجاست: لایهٔ زبان می‌گوید **چه اتفاقی افتاده**، و موتور حسابداری
 * جداگانه تصمیم می‌گیرد **سند چه باشد**. این فایل شکل همان «چه اتفاقی افتاده»
 * را تعریف می‌کند و هیچ چیزی دربارهٔ بدهکار و بستانکار نمی‌داند.
 *
 * این ماژول عمداً هیچ وابستگی‌ای ندارد: نه دیتابیس، نه شبکه، نه رابط کاربری.
 */

/**
 * انواع رویداد.
 *
 * هر نوع یک اتفاق واقعی در کسب‌وکار است، نه یک الگوی سند. «چک دریافتی» و «طلب»
 * عمداً جدا هستند چون سرنوشتشان فرق دارد: چک سررسید و وضعیت وصول دارد.
 */
export const EVENT_KINDS = Object.freeze({
  CASH_EXPENSE: 'cash-expense',
  CASH_INCOME: 'cash-income',
  RECEIVABLE_OPENED: 'receivable-opened',
  PAYABLE_OPENED: 'payable-opened',
  CHEQUE_RECEIVED: 'cheque-received',
  CHEQUE_ISSUED: 'cheque-issued',
  OBLIGATION_SETTLED: 'obligation-settled',
  CAPITAL_CONTRIBUTION: 'capital-contribution',
  FIXED_ASSET_PURCHASE: 'fixed-asset-purchase',
  SALES_INVOICE: 'sales-invoice',
  PURCHASE_INVOICE: 'purchase-invoice',
  INVOICE_PAYMENT: 'invoice-payment',
  DEPRECIATION: 'depreciation',
});

const KIND_VALUES = new Set(Object.values(EVENT_KINDS));

/** رویدادهایی که پول را همان لحظه جابه‌جا می‌کنند و حساب نقدی لازم دارند. */
const CASH_MOVING = new Set([
  EVENT_KINDS.CASH_EXPENSE, EVENT_KINDS.CASH_INCOME, EVENT_KINDS.OBLIGATION_SETTLED,
  EVENT_KINDS.CAPITAL_CONTRIBUTION, EVENT_KINDS.FIXED_ASSET_PURCHASE, EVENT_KINDS.INVOICE_PAYMENT,
]);

/** رویدادهایی که سررسید معنا دارند. */
const DATED_FORWARD = new Set([
  EVENT_KINDS.RECEIVABLE_OPENED, EVENT_KINDS.PAYABLE_OPENED,
  EVENT_KINDS.CHEQUE_RECEIVED, EVENT_KINDS.CHEQUE_ISSUED,
  EVENT_KINDS.SALES_INVOICE, EVENT_KINDS.PURCHASE_INVOICE,
]);

export function eventMovesCash(kind) { return CASH_MOVING.has(kind); }
export function eventHasDueDate(kind) { return DATED_FORWARD.has(kind); }

function invalidEvent(message, code = 'EVENT_INVALID') {
  return Object.assign(new Error(message), { code, status: 400 });
}

function cleanText(value, limit) {
  return String(value ?? '').trim().slice(0, limit);
}

function cleanIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * رویداد را به شکل قانونی‌اش می‌آورد و اگر نشود، صریح شکست می‌خورد.
 *
 * شکست صریح عمدی است: رویداد نیمه‌ساخته که از اینجا رد شود، در موتور حسابداری
 * به سند نیمه‌ساخته تبدیل می‌شود و آنجا تشخیصش خیلی سخت‌تر است.
 */
export function normalizeFinancialEvent(raw = {}) {
  const kind = cleanText(raw.kind, 40);
  if (!KIND_VALUES.has(kind)) throw invalidEvent(`نوع رویداد «${kind || '—'}» شناخته نشد.`, 'EVENT_KIND_UNKNOWN');

  const amount = Math.round(Number(raw.amount) || 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw invalidEvent('مبلغ رویداد باید عددی مثبت باشد.', 'EVENT_AMOUNT_INVALID');

  const occurredAt = cleanIso(raw.occurredAt);
  if (!occurredAt) throw invalidEvent('تاریخ وقوع رویداد لازم است.', 'EVENT_DATE_MISSING');

  // سررسید فقط روی رویدادهایی معنا دارد که تعهد آینده می‌سازند. نشاندنش روی
  // یک هزینهٔ نقدی یعنی داده‌ای که هیچ‌کس بعداً نمی‌داند یعنی چه.
  const dueAt = eventHasDueDate(kind) ? cleanIso(raw.dueAt) : null;

  return Object.freeze({
    kind,
    amount,
    occurredAt,
    dueAt,
    // دسته فقط برچسب کسب‌وکاری است؛ نگاشتش به حساب، کار موتور حسابداری است.
    category: cleanText(raw.category, 80) || null,
    counterparty: cleanText(raw.counterparty, 120) || null,
    counterpartyId: cleanText(raw.counterpartyId, 64) || null,
    // حساب نقدی فقط برای رویدادهای پول‌جابه‌جاکن؛ بقیه خودشان طرف حساب دارند.
    accountId: eventMovesCash(kind) ? (cleanText(raw.accountId, 64) || 'cash') : null,
    // ارجاع به سندی که این رویداد رویش اثر می‌گذارد (تسویه، پرداخت فاکتور).
    reference: cleanText(raw.reference, 120) || null,
    // جهت تسویه: طلبی وصول شد یا بدهی‌ای پرداخت. قواعد بدون این نمی‌دانند کدام
    // طرف باید نقد شود، و چسباندنش بیرون از نرمال‌سازی یعنی رویدادی که از
    // دیتابیس خوانده می‌شود آن را ندارد.
    settlementDirection: ['receivable', 'payable'].includes(raw.settlementDirection) ? raw.settlementDirection : null,
    description: cleanText(raw.description, 300) || null,
    // منشأ رویداد: صدا، متن، ایمپورت، یا خودکار. برای ردیابی و برای DNA.
    source: ['voice', 'text', 'import', 'system'].includes(raw.source) ? raw.source : 'text',
    // متن خام گفتهٔ کاربر؛ شاهدِ رویداد و ورودی یادگیری DNA.
    evidence: cleanText(raw.evidence, 500) || null,

    // --- واقعیت‌های ماهیت ---
    //
    // تا پیش از این، رویداد جایی برای این‌ها نداشت. نتیجه‌اش این نبود که گم
    // می‌شدند؛ این بود که **نبودشان قابل گزارش نبود**. موتور نمی‌توانست بگوید
    // «دورهٔ پوشش را نمی‌دانم»، چون جایی برای ندانستنش نداشت — و برای امتناع
    // کردن، اول باید جایی برای ندانستن وجود داشته باشد.
    //
    // همه اختیاری‌اند و رویدادی که نداشته باشدشان معتبر می‌ماند. هیچ دادهٔ
    // تاریخی با افزودن این‌ها بازتفسیر نمی‌شود.
    servicePeriodStart: cleanIso(raw.servicePeriodStart),
    servicePeriodEnd: cleanIso(raw.servicePeriodEnd),
    // `null` یعنی پرسیده نشده؛ `false` یعنی پرسیده شد و جواب «نه» بود. یکی
    // کردنشان باعث می‌شود سیستم برای هر «نه» دوباره همان سؤال را بپرسد.
    refundable: typeof raw.refundable === 'boolean' ? raw.refundable : null,
    intendedUse: ['resale', 'production', 'long-term-use', 'current-consumption'].includes(raw.intendedUse) ? raw.intendedUse : null,
    contractReference: cleanText(raw.contractReference, 120) || null,
    // حساب مقصد، فقط برای جابه‌جایی بین حساب‌های خود واحد. برابر بودنش با
    // مبدأ یعنی انتقالی در کار نیست، پس حذف می‌شود تا نگهبان گمراه نشود.
    destinationAccountId: (() => {
      const destination = cleanText(raw.destinationAccountId, 64) || null;
      const source = eventMovesCash(kind) ? (cleanText(raw.accountId, 64) || 'cash') : null;
      return destination && destination !== source ? destination : null;
    })(),
    // چک بابت فروش تازه است یا بابت طلبی که قبلاً ثبت شده؟ فرم این را می‌پرسد
    // و صدا نمی‌پرسید؛ نتیجه‌اش شناسایی دوبارهٔ همان فروش بود.
    // ابهام مقیاس مبلغ در گفتار محاوره‌ای: «سی تومن» یعنی سی هزار یا سی
    // میلیون؟ تا جواب نیامده، هیچ سندی از این رویداد ساخته نمی‌شود.
    amountScaleAmbiguous: raw.amountScaleAmbiguous === true,
    chequeAgainst: ['income', 'receivable'].includes(raw.chequeAgainst) ? raw.chequeAgainst : null,
    counterpartyRole: ['owner', 'supplier', 'customer', 'employee', 'authority'].includes(raw.counterpartyRole) ? raw.counterpartyRole : null,
  });
}

/**
 * توضیح رویداد به زبان آدمیزاد.
 *
 * تأیید کاربر عادی هرگز نباید با «بدهکار» و «بستانکار» نوشته شود؛ آن‌ها زبان
 * دفترند، نه زبان کسی که فقط می‌خواهد بداند چه چیزی ثبت می‌شود.
 */
export function describeEvent(event) {
  const who = event.counterparty ? ` ${event.counterparty}` : '';
  const what = event.category ? ` بابت ${event.category}` : '';
  switch (event.kind) {
    case EVENT_KINDS.CASH_EXPENSE: return `پرداخت${what}`;
    case EVENT_KINDS.CASH_INCOME: return `دریافت${what}`;
    case EVENT_KINDS.RECEIVABLE_OPENED: return `طلب از${who || ' طرف حساب'}`;
    case EVENT_KINDS.PAYABLE_OPENED: return `بدهی به${who || ' طرف حساب'}`;
    case EVENT_KINDS.CHEQUE_RECEIVED: return `چک دریافتی از${who || ' طرف حساب'}`;
    case EVENT_KINDS.CHEQUE_ISSUED: return `چک پرداختی به${who || ' طرف حساب'}`;
    case EVENT_KINDS.OBLIGATION_SETTLED: return `تسویهٔ ${event.reference || 'تعهد'}`;
    case EVENT_KINDS.CAPITAL_CONTRIBUTION: return 'آوردهٔ مالک';
    case EVENT_KINDS.FIXED_ASSET_PURCHASE: return `خرید ${event.description || 'دارایی ثابت'}`;
    case EVENT_KINDS.SALES_INVOICE: return `فاکتور فروش${who ? ` برای${who}` : ''}`;
    case EVENT_KINDS.PURCHASE_INVOICE: return `فاکتور خرید${who ? ` از${who}` : ''}`;
    case EVENT_KINDS.INVOICE_PAYMENT: return `پرداخت فاکتور ${event.reference || ''}`.trim();
    case EVENT_KINDS.DEPRECIATION: return `استهلاک ${event.description || ''}`.trim();
    default: return 'رویداد مالی';
  }
}
