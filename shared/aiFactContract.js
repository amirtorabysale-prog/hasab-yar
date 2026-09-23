/**
 * قرارداد استخراج واقعیت — مرز سخت میان مدل زبانی و حسابداری.
 *
 * چرا این فایل وجود دارد:
 *
 * قرارداد امروز (`server/gemini.js`) نام و کد حساب نمی‌خواهد و این درست است.
 * ولی `type: income | expense` می‌خواهد، و آن یک واقعیت نیست — یک طبقه‌بندی
 * حسابداری است. با پرسیدنش از مدل، اولین و مهم‌ترین انشعاب ماهیت به برداشت
 * آماری سپرده شده.
 *
 * پس مرز دقیق این است: مدل فقط چیزی را می‌گوید که در متن یا مدرک **هست**.
 * اینکه آن واقعیت‌ها به کدام خانواده و کدام سند می‌رسند، کار موتور قاعده است.
 *
 * فیلدهای ممنوع فقط یک فهرست نیستند؛ اگر در خروجی باشند، کل پاسخ رد و لاگ
 * می‌شود. رد کردنِ نرم — یعنی حذف فیلد و ادامه دادن — بدترین حالت است: مدل
 * یاد نمی‌گیرد و ما نمی‌فهمیم چند بار از مرز رد شده.
 */

/**
 * فیلدهایی که خروجی مدل هرگز نباید داشته باشد.
 *
 * تطبیق روی نام فیلد است و به حروف بزرگ و کوچک حساس نیست، چون مدل ممکن است
 * `accountCode` یا `account_code` یا `AccountCode` برگرداند و هر سه یک چیزند.
 */
export const FORBIDDEN_FACT_FIELDS = Object.freeze([
  'account', 'accountname', 'accountcode', 'accountid', 'ledgeraccount',
  'debit', 'credit', 'debitaccount', 'creditaccount',
  'journal', 'journalentry', 'entry', 'posting', 'postingplan',
  'treatment', 'family', 'type',
]);

/**
 * `type` هم ممنوع است و این عمدی‌ترین قلم فهرست بالاست.
 *
 * `income | expense` بی‌ضرر به نظر می‌رسد ولی همان جدول دوسطری
 * `KIND_BY_TYPE` را تغذیه می‌کند که «هر پرداختی هزینه است» را قفل کرده. جهت
 * حرکت پول یک واقعیت است و `moneyDirection` نامش است؛ «درآمد» و «هزینه» نتیجهٔ
 * تصمیم‌اند، نه ورودی‌اش.
 */
export const MONEY_DIRECTIONS = Object.freeze({ IN: 'in', OUT: 'out', NONE: 'none' });

/**
 * schema استخراج.
 *
 * شکل عمومی است تا هم برای Gemini و هم برای OpenAI قابل ترجمه باشد؛ ترجمه به
 * قالب هر ارائه‌دهنده کار لایهٔ سرور است، نه این ماژول.
 *
 * هیچ فیلدی `required` نیست جز `moneyDirection` و `evidence`. دلیلش این است که
 * «نمی‌دانم» باید قابل بیان باشد: مدلی که مجبور شود مبلغ بدهد، مبلغ می‌سازد.
 */
export const AI_FACT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['moneyDirection', 'evidence']),
  properties: Object.freeze({
    moneyDirection: Object.freeze({ type: 'string', enum: Object.freeze(['in', 'out', 'none']) }),
    amount: Object.freeze({ type: 'integer', minimum: 1, description: 'به تومان، عدد صحیح' }),
    occurredAt: Object.freeze({ type: 'string', description: 'تاریخ میلادی ISO یا تاریخ شمسی خام' }),
    counterparty: Object.freeze({ type: 'string' }),
    category: Object.freeze({ type: 'string' }),
    description: Object.freeze({ type: 'string' }),
    cashAccountHint: Object.freeze({ type: 'string', description: 'نام بانک یا صندوق آن‌طور که گفته شد' }),
    destinationAccountHint: Object.freeze({ type: 'string' }),
    servicePeriodStart: Object.freeze({ type: 'string' }),
    servicePeriodEnd: Object.freeze({ type: 'string' }),
    contractReference: Object.freeze({ type: 'string' }),
    settlementReference: Object.freeze({ type: 'string' }),
    deliveryDate: Object.freeze({ type: 'string' }),
    assetName: Object.freeze({ type: 'string' }),
    // هدف از خرید فقط وقتی پر می‌شود که در متن صریح گفته شده باشد. حدس زدنش از
    // روی نام کالا دقیقاً همان کاری است که فاز ۳ تست شکست برایش می‌نویسد.
    intendedUse: Object.freeze({ type: 'string', enum: Object.freeze(['resale', 'production', 'long-term-use', 'current-consumption']) }),
    refundable: Object.freeze({ type: 'boolean' }),
    confidence: Object.freeze({ type: 'number', minimum: 0, maximum: 1 }),
    evidence: Object.freeze({ type: 'string', description: 'عین گفتهٔ کاربر، بدون خلاصه‌سازی' }),
  }),
});

function notImplemented(name) {
  return Object.assign(new Error(`${name} هنوز پیاده‌سازی نشده است.`), { code: 'NOT_IMPLEMENTED' });
}

/**
 * خروجی مدل را اعتبارسنجی می‌کند.
 *
 * خروجی: `{ ok, facts, violations }`. `violations` نام هر فیلد ممنوع یا
 * ناشناخته را می‌برد تا لاگ بتواند بگوید مدل دقیقاً کجا از مرز رد شده.
 *
 * هرگز پاسخ نامعتبر را «تمیز» نمی‌کند و ادامه نمی‌دهد.
 */
export function validateExtraction(/* payload */) {
  throw notImplemented('validateExtraction');
}
