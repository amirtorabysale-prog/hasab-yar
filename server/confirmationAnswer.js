import { DECISION_STATUS } from '../shared/accountingDecision.js';
import { FACT_QUESTIONS } from '../shared/factRequirements.js';
import { ROUTES } from '../shared/confidenceEngine.js';

/**
 * سؤال موتور برای کارت «یک سؤال کوتاه» صاحب کسب‌وکار.
 *
 * رویدادی که موتور برایش واقعیتی کم دارد (دورهٔ پوشش، قابل استرداد بودن، بابت
 * پول، کاربرد خرید) عمداً به مسیر «تأیید کاربر» می‌رود تا همان کسی که گفته
 * جواب بدهد (`shared/transactionEvent.js`). ولی کارت امروز فقط خلاصه و
 * «بله، درست است» را می‌دید؛ «بله» تا جواب نیامده حتماً رد می‌شد و تنها راه،
 * سپردن به حسابدار بود. این‌جا همان سؤال زنده — نه متنی که لحظهٔ ثبت یخ زده —
 * با گزینه‌هایش به کارت داده می‌شود.
 *
 * خروجی عمداً تنگ است: واقعیت، متن سؤال و برچسب گزینه‌ها؛ نه نام مسیر و نه
 * اصطلاح حسابداری.
 */
export function confirmationAsk(decision) {
  const question = decision?.decisionStatus === DECISION_STATUS.NEEDS_USER_INPUT ? decision.question : null;
  if (!question?.fact) return null;
  return {
    fact: question.fact,
    text: question.text,
    kind: question.kind,
    options: (question.options || []).map((option) => ({ value: option.value, label: option.label, freeInput: Boolean(option.freeInput) })),
  };
}

/** متن سؤال‌های موتور؛ دلیلی که فقط همین سؤال بود، بعد از جوابش کهنه است. */
const QUESTION_TEXTS = new Set(Object.values(FACT_QUESTIONS).map((question) => question.text));

/**
 * یک خط توضیح زیر پرسش: سؤال زنده اگر هست، وگرنه نخستین دلیلی که خودش یک
 * سؤال موتورِ جواب‌داده‌شده نیست.
 */
export function confirmationHint(reasons = [], ask = null) {
  if (ask) return ask.text;
  return (reasons || []).find((reason) => reason && !QUESTION_TEXTS.has(reason)) || '';
}

function answerError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

/**
 * جواب کارت امروز، پیش از آن‌که به موتور برسد.
 *
 * فقط رویداد در انتظارِ همین مسیر، فقط همان سؤالی که الان پرسیده می‌شود، و فقط
 * یکی از گزینه‌های خودش؛ متن آزاد فقط برای گزینه‌ای که ورودی آزاد دارد. بقیه
 * را همان `answerEventQuestion` می‌سنجد (تاریخ نامعتبر، ترتیب دوره).
 */
export function checkConfirmationAnswer(row, decision, { fact, value, freeText = '' } = {}) {
  if (!row) throw answerError('این مورد پیدا نشد.', 'CONFIRMATION_MISSING', 404);
  if (row.status !== 'pending' || row.route !== ROUTES.CONFIRM) throw answerError('این مورد دیگر منتظر جواب تو نیست.', 'CONFIRMATION_NOT_PENDING', 409);
  const ask = confirmationAsk(decision);
  if (!ask) throw answerError('این مورد سؤالی ندارد؛ با «بله» یا «مطمئن نیستم» جواب بده.', 'CONFIRMATION_NO_QUESTION', 409);
  if (ask.fact !== fact) throw answerError('سؤال این مورد عوض شده است؛ دوباره نگاه کن.', 'CONFIRMATION_QUESTION_CHANGED', 409);
  const text = String(freeText || '').trim().slice(0, 200);
  if (!ask.options.length) {
    if (!text) throw answerError('جواب را بنویس.', 'CONFIRMATION_ANSWER_REQUIRED');
    return { fact, freeText: text };
  }
  const option = ask.options.find((entry) => entry.value === value);
  if (!option) throw answerError('این گزینه برای این سؤال نیست.', 'CONFIRMATION_OPTION_INVALID');
  if (option.freeInput && !text) throw answerError('تاریخ یا مقدار را بنویس.', 'CONFIRMATION_ANSWER_REQUIRED');
  return option.freeInput ? { fact, value: option.value, freeText: text } : { fact, value: option.value };
}
