import { FACT_KEYS, FACT_QUESTIONS, QUESTION_KINDS } from './factRequirements.js';
import { persianPeriodEnd, persianToISO, readJalaliExpression, readTypedDate, todayPersian } from './persianDate.js';
import { readServiceLength, readServicePeriod } from './periodSpeech.js';

/**
 * جواب کاربر را به واقعیت تبدیل می‌کند.
 *
 * چرا این لایه لازم است: گزینه‌ای که کاربر می‌زند «از اول ماه بعد» است، ولی
 * رویداد یک تاریخ می‌خواهد. ترجمه باید یک‌جا و آزمون‌پذیر باشد، نه پخش در
 * رابط کاربری — وگرنه «اول ماه بعد» در دو صفحه دو معنی پیدا می‌کند.
 *
 * تابع خالص است و `today` صریح می‌گیرد. هیچ‌جا `Date.now()` خوانده نمی‌شود،
 * وگرنه همان جواب فردا تاریخ دیگری می‌ساخت و replay شکست می‌خورد.
 */

function answerError(message, code = 'ANSWER_INVALID') {
  return Object.assign(new Error(message), { code, status: 400 });
}

/** اول ماه شمسی، با اختلافِ ماه نسبت به تاریخ مرجع. */
function persianMonthStart(iso, offsetMonths = 0) {
  const parts = todayPersian(new Date(iso));
  const total = (parts.year * 12) + (parts.month - 1) + offsetMonths;
  return persianToISO(Math.floor(total / 12), (total % 12) + 1, 1);
}

const START_OPTIONS = Object.freeze({
  'this-month': (event, { today }) => ({ [FACT_KEYS.SERVICE_PERIOD_START]: persianMonthStart(today, 0) }),
  'next-month': (event, { today }) => ({ [FACT_KEYS.SERVICE_PERIOD_START]: persianMonthStart(today, 1) }),
  /**
   * «دوره‌اش گذشته» یک تاریخ نیست، یک حکم است: منفعتی برای آینده نمانده.
   *
   * دوره را روی خودِ تاریخ پرداخت می‌بندد تا موتور همان نتیجه‌ای را بگیرد که
   * کاربر گفت — هزینهٔ همین دوره، بدون دارایی و بدون برنامهٔ تخصیص. ساختن یک
   * تاریخ شروعِ حدسی برای دوره‌ای که تمام شده، فقط یک عدد جعلی به دفتر اضافه
   * می‌کرد.
   */
  'already-passed': (event) => ({
    [FACT_KEYS.SERVICE_PERIOD_START]: event.occurredAt,
    [FACT_KEYS.SERVICE_PERIOD_END]: event.occurredAt,
  }),
});

const END_MONTHS = Object.freeze({ 'one-year': 12, 'six-months': 6, 'three-months': 3 });

/**
 * جواب را به تکه‌ای از رویداد تبدیل می‌کند.
 *
 * خروجی یک patch است، نه رویداد کامل: تصمیم‌گیری دربارهٔ اینکه این patch کجا
 * بنشیند کار لایهٔ ذخیره‌سازی است.
 */
export function applyAnswer(event, { fact, value, freeText = '' } = {}, { today = null } = {}) {
  const question = FACT_QUESTIONS[fact];
  if (!question) throw answerError(`برای «${fact}» سؤالی تعریف نشده است.`, 'ANSWER_FACT_UNKNOWN');
  const reference = today || event?.occurredAt;

  if (question.kind === QUESTION_KINDS.OPTIONS) {
    // گزینهٔ پویا از خودِ رویداد ساخته می‌شود؛ فهرست ثابت برایش خالی است.
    const choices = question.buildOptions ? question.buildOptions(event) : question.options;
    const chosen = choices.find((option) => option.value === value);
    if (!chosen) throw answerError('این گزینه برای این سؤال معتبر نیست.', 'ANSWER_OPTION_UNKNOWN');
    // گزینهٔ «تاریخش را می‌گویم» خودش مقدار نیست؛ ورودی آزاد می‌خواهد.
    if (chosen.freeInput) {
      if (!freeText) throw answerError('مقدار وارد نشده است.', 'ANSWER_VALUE_MISSING');
      if (PERIOD_FACTS.has(fact)) return orderedPeriod(event, withSpokenLength(event, coverageAnswer(fact, freeText, event, reference)), { typed: true });
      return { [fact]: typedValue(fact, freeText, reference) };
    }
    if (fact === FACT_KEYS.SERVICE_PERIOD_START) return orderedPeriod(event, withSpokenLength(event, START_OPTIONS[value](event, { today: reference })));
    if (fact === FACT_KEYS.SERVICE_PERIOD_END) {
      const start = event?.servicePeriodStart;
      if (!start) throw answerError('اول باید شروع دوره مشخص شود.', 'ANSWER_ORDER_INVALID');
      // همان قاعدهٔ جمله (`persianPeriodEnd`): ۲۰ مهر + سه ماه یعنی ۱۹ دی. پیش از
      // این از اول ماهِ شروع حساب می‌شد و ۳۰ آذر می‌شد: برنامه دو قسط به‌جای سه.
      return { [fact]: persianPeriodEnd(start, END_MONTHS[value]) };
    }
    // جواب مقیاس مبلغ، خودِ مبلغ را می‌نشاند و ابهام را می‌بندد؛ وگرنه همان
    // سؤال دوباره پرسیده می‌شود.
    if (fact === FACT_KEYS.AMOUNT_SCALE) return { amount: chosen.value, amountScaleAmbiguous: false };
    // گزینهٔ «بابت چه بود» خودش استرداد را هم می‌گوید: آورده و برداشت شخصی
    // برنمی‌گردند و ودیعه برمی‌گردد. پرسیدن دوباره‌اش فقط یک سؤال اضافه است.
    if (fact === FACT_KEYS.RECEIPT_PURPOSE && chosen.value === 'owner') return { receiptPurpose: 'owner', refundable: false };
    if (fact === FACT_KEYS.PAYMENT_PURPOSE && chosen.value === 'owner-drawing') return { paymentPurpose: 'owner-drawing', refundable: false };
    if (fact === FACT_KEYS.PAYMENT_PURPOSE && chosen.value === 'deposit') return { paymentPurpose: 'deposit', refundable: true };
    return { [fact]: chosen.value };
  }

  if (!freeText) throw answerError('مقدار وارد نشده است.', 'ANSWER_VALUE_MISSING');
  if (PERIOD_FACTS.has(fact)) return orderedPeriod(event, withSpokenLength(event, coverageAnswer(fact, freeText, event, reference)), { typed: true });
  return { [fact]: typedValue(fact, freeText, reference) };
}

const PERIOD_FACTS = new Set([FACT_KEYS.SERVICE_PERIOD_START, FACT_KEYS.SERVICE_PERIOD_END]);

const DATE_FACTS = new Set([FACT_KEYS.SERVICE_PERIOD_START, FACT_KEYS.SERVICE_PERIOD_END, FACT_KEYS.OCCURRED_AT,
  FACT_KEYS.DELIVERY_DATE, FACT_KEYS.READY_FOR_USE_DATE].filter(Boolean));

/** پاسخ تایپی؛ تاریخ به تاریخ واقعی تبدیل می‌شود و تاریخِ نخوانده رد می‌شود. */
function typedValue(fact, freeText, reference) {
  if (!DATE_FACTS.has(fact)) return freeText;
  const iso = readTypedDate(freeText, { now: reference ? new Date(reference) : new Date() });
  if (!iso) throw answerError('تاریخ خوانده نشد؛ مثل ۱۴۰۵/۰۷/۳۰ یا «۳۰ مهر ۱۴۰۵» بنویس.', 'ANSWER_DATE_INVALID');
  return iso;
}

const DAY_MS = 86_400_000;

/** روز آخرِ یک ماه شمسی. */
function lastDayOfMonth(year, month) {
  const next = month === 12 ? persianToISO(year + 1, 1, 1) : persianToISO(year, month + 1, 1);
  return next ? new Date(Date.parse(next) - DAY_MS).toISOString() : null;
}

/** متن گفتهٔ اصلی رویداد؛ طولِ گفته‌شده («یک‌ساله تمدید کردیم») از همین خوانده می‌شود. */
const sentenceOf = (event) => String(event?.evidence || event?.rawText || '');

/**
 * طولی که جمله گفته بود، پایان را می‌سازد وقتی فقط شروع پرسیده شده بود.
 *
 * «بیمه آتش سوزی رو یک ساله تمدید کردیم» طول را دارد و شروع را نه: پوشش تازه از
 * پایان قرارداد جاری شروع می‌شود، نه از روز پرداخت، پس شروع پرسیده می‌شود. کسی که
 * «یک‌ساله» گفته، بعد از جواب شروع نباید دوباره «تا کِی؟» بشنود.
 */
function withSpokenLength(event, patch) {
  const start = patch[FACT_KEYS.SERVICE_PERIOD_START];
  if (!start || patch[FACT_KEYS.SERVICE_PERIOD_END] || event?.servicePeriodEnd) return patch;
  // جمله با همین شروع دوباره خوانده می‌شود؛ بازهٔ ناسازگار در جمله («یک‌ساله، از
  // مهر تا اسفند») دورهٔ دیگری می‌دهد و پایان همچنان پرسیده می‌شود.
  const period = readServicePeriod(sentenceOf(event), { occurredAt: event?.occurredAt || start, start });
  return period?.end && period.start === start ? { ...patch, [FACT_KEYS.SERVICE_PERIOD_END]: period.end } : patch;
}

/**
 * جواب تایپی یا گفتاریِ سؤال دورهٔ پوشش.
 *
 * پیش از این فقط یک تاریخ تقویمی پذیرفته می‌شد: «۱۲ ماه»، «یک سال»، «آخر شهریور
 * ۱۴۰۶» و «۶ ماه از مهر» رد می‌شدند، و بازهٔ «از اول مهر ۱۴۰۵ تا آخر شهریور
 * ۱۴۰۶» فقط شروعش را نگه می‌داشت و «تا کِی؟» را دوباره می‌پرسید. بیمهٔ دوساله یا
 * نُه‌ماهه پایانی می‌خواست که کاربر با دست حساب کند.
 *
 * به همین ترتیب خوانده می‌شود و خروجی یک patch است، نه یک مقدار:
 *
 * ۱. بازه یا شروع + طول («از اول مهر تا آخر شهریور ۱۴۰۶»، «۶ ماه از مهر») — هر دو طرف؛
 * ۲. طولِ تنها («۱۲ ماه»، «دو سال»، «یکساله») — فقط برای پایان، از شروعِ رویداد؛
 * ۳. ماهِ بی‌روز («آخر شهریور ۱۴۰۶»، «مهر ۱۴۰۵») — پایان، روز آخرِ ماه؛ شروع، روز اول؛
 * ۴. یک تاریخ.
 *
 * همان خوانندهٔ جمله (`readServicePeriod`) به کار می‌رود، تا جواب و جمله یک قاعده
 * داشته باشند.
 */
function coverageAnswer(fact, freeText, event, reference) {
  const isEnd = fact === FACT_KEYS.SERVICE_PERIOD_END;
  const start = event?.servicePeriodStart || null;
  const anchor = reference || event?.occurredAt || new Date().toISOString();

  const period = readServicePeriod(freeText, { occurredAt: anchor, answer: true });
  if (period && period.basis !== 'length') {
    return {
      [FACT_KEYS.SERVICE_PERIOD_START]: period.start,
      ...(period.end ? { [FACT_KEYS.SERVICE_PERIOD_END]: period.end } : {}),
    };
  }

  if (isEnd) {
    const length = readServiceLength(freeText, { bare: true });
    if (length) {
      if (!start) throw answerError('اول باید شروع دوره مشخص شود.', 'ANSWER_ORDER_INVALID');
      return { [fact]: persianPeriodEnd(start, length.months) };
    }
  }

  const expression = readJalaliExpression(freeText);
  if (expression && expression.day == null) {
    const now = todayPersian(new Date(anchor));
    const year = expression.year || (now.year + (expression.yearOffset || 0));
    const iso = isEnd || expression.end ? lastDayOfMonth(year, expression.month) : persianToISO(year, expression.month, 1);
    if (iso) return { [fact]: rollYearless(iso, expression, isEnd ? start : null) };
  }

  const iso = readTypedDate(freeText, { now: new Date(anchor) });
  if (!iso) throw answerError('تاریخ خوانده نشد؛ مثل ۱۴۰۵/۰۷/۳۰، «۳۰ مهر ۱۴۰۵»، «۱۲ ماه» یا «آخر شهریور ۱۴۰۶» بنویس.', 'ANSWER_DATE_INVALID');
  return { [fact]: rollYearless(iso, expression, isEnd ? start : null) };
}

/**
 * پایانِ بی‌سال پیش از شروع، سالِ بعد است.
 *
 * «۳۱ شهریور» برای بیمه‌ای که از اول مهر شروع شده، شهریورِ سال بعد است — همان
 * قاعده‌ای که مسیر فهم برای تاریخ‌های بی‌سالِ مدل دارد. پایانی که سالش گفته شده
 * دست نمی‌خورد؛ اگر پیش از شروع باشد، رد می‌شود.
 */
function rollYearless(iso, expression, start) {
  const yearless = expression && expression.year == null && expression.yearOffset == null;
  if (!yearless || !start || Date.parse(iso) >= Date.parse(start)) return iso;
  const parts = todayPersian(new Date(iso));
  return persianToISO(parts.year + 1, parts.month, parts.day) || lastDayOfMonth(parts.year + 1, parts.month) || iso;
}

/**
 * پایان پیش از شروع پذیرفته نمی‌شود.
 *
 * دوره‌ای که پایانش پیش از شروعش است، در موتور تصمیم «گذشته» دیده می‌شد و کل
 * مبلغ همان روز هزینه می‌شد — یک کلیک روی جواب کهنه («۱ مهر» که برای شروع تایپ
 * شده بود و به سؤال پایان رفت) یا یک تاریخ اشتباه، پیش‌پرداخت دوازده‌ماهه را
 * هزینه می‌کرد. شروع و پایانِ برابر فقط از گزینهٔ «دوره‌اش گذشته» می‌آید؛ جواب
 * تایپی باید دوره‌ای واقعی بسازد.
 */
function orderedPeriod(event, patch, { typed = false } = {}) {
  const start = patch[FACT_KEYS.SERVICE_PERIOD_START] ?? event?.servicePeriodStart;
  const end = patch[FACT_KEYS.SERVICE_PERIOD_END] ?? event?.servicePeriodEnd;
  if (start && end && (typed ? Date.parse(end) <= Date.parse(start) : Date.parse(end) < Date.parse(start))) {
    throw answerError('پایان دوره پیش از شروع آن است؛ دوباره بگو.', 'ANSWER_PERIOD_ORDER_INVALID');
  }
  return patch;
}
