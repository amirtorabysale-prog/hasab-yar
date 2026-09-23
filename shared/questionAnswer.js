import { FACT_KEYS, FACT_QUESTIONS, QUESTION_KINDS } from './factRequirements.js';
import { persianToISO, todayPersian } from './persianDate.js';

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

/** همان روزِ ماه، چند ماه شمسی جلوتر، منهای یک روز — یعنی پایان دوره. */
function persianPeriodEnd(startIso, months) {
  const start = persianMonthStart(startIso, months);
  return start ? new Date(new Date(start).getTime() - 86_400_000).toISOString() : null;
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
    const chosen = question.options.find((option) => option.value === value);
    if (!chosen) throw answerError('این گزینه برای این سؤال معتبر نیست.', 'ANSWER_OPTION_UNKNOWN');
    // گزینهٔ «تاریخش را می‌گویم» خودش مقدار نیست؛ ورودی آزاد می‌خواهد.
    if (chosen.freeInput) {
      if (!freeText) throw answerError('مقدار وارد نشده است.', 'ANSWER_VALUE_MISSING');
      return { [fact]: freeText };
    }
    if (fact === FACT_KEYS.SERVICE_PERIOD_START) return START_OPTIONS[value](event, { today: reference });
    if (fact === FACT_KEYS.SERVICE_PERIOD_END) {
      const start = event?.servicePeriodStart;
      if (!start) throw answerError('اول باید شروع دوره مشخص شود.', 'ANSWER_ORDER_INVALID');
      return { [fact]: persianPeriodEnd(start, END_MONTHS[value]) };
    }
    return { [fact]: chosen.value };
  }

  if (!freeText) throw answerError('مقدار وارد نشده است.', 'ANSWER_VALUE_MISSING');
  return { [fact]: freeText };
}
