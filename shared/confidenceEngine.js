import { EVENT_KINDS, describeEvent } from './financialEvent.js';

/**
 * موتور اطمینان — تصمیم می‌گیرد یک رویداد خودکار ثبت شود، از کاربر پرسیده شود،
 * یا به صف بررسی حسابدار برود.
 *
 * این موتور عمداً از منطق حسابداری جداست. کارش فقط یک چیز است: «چقدر مطمئنیم
 * که این رویداد را درست فهمیده‌ایم؟» — و بر پایهٔ همان، مسیر را انتخاب می‌کند.
 *
 * آستانه‌ها سیاست محصول‌اند، نه عدد دلبخواه، پس یکجا و نام‌دار می‌مانند.
 */

export const CONFIDENCE_THRESHOLDS = Object.freeze({
  /** بالای این حد، رویداد بدون پرسیدن ثبت می‌شود. */
  auto: 0.95,
  /** بالای این حد ولی زیر خودکار، یک خلاصهٔ ساده برای تأیید کاربر. */
  confirm: 0.80,
});

export const ROUTES = Object.freeze({
  AUTO: 'auto',
  CONFIRM: 'confirm',
  ACCOUNTANT_REVIEW: 'accountant-review',
});

/**
 * وزن هر میدان در اطمینان کل.
 *
 * مبلغ بیشترین وزن را دارد چون خطایش مستقیم پول است و هیچ لایهٔ بعدی نمی‌گیردش.
 * دسته کمترین را دارد چون اصلاح‌شدنی است و DNA هم به مرور درستش می‌کند.
 */
const FIELD_WEIGHTS = Object.freeze({
  amount: 0.40,
  kind: 0.25,
  date: 0.15,
  counterparty: 0.10,
  category: 0.10,
});

/**
 * رویدادهایی که هرگز خودکار ثبت نمی‌شوند، حتی با اطمینان کامل.
 *
 * معیار ساده است: آیا برگرداندنش برای کاربر عادی آسان است؟ فاکتور صادرشده سند
 * برگشتی می‌خواهد، آورده و دارایی ثابت ساختار سرمایه را عوض می‌کنند، و استهلاک
 * تصمیم دوره‌ای حسابدار است. اینها با یک «باشه» از کاربر عادی رد نمی‌شوند.
 */
const NEVER_AUTOMATIC = new Set([
  EVENT_KINDS.SALES_INVOICE,
  EVENT_KINDS.PURCHASE_INVOICE,
  EVENT_KINDS.CAPITAL_CONTRIBUTION,
  EVENT_KINDS.FIXED_ASSET_PURCHASE,
  EVENT_KINDS.DEPRECIATION,
]);

const clamp = (value) => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0));

/**
 * اطمینان کل از اطمینان میدان‌ها.
 *
 * میدانی که اصلاً گفته نشده (مثل طرف حساب در یک هزینهٔ ساده) وزنش از محاسبه
 * بیرون می‌رود، نه اینکه صفر بگیرد — وگرنه هر جملهٔ کوتاه و کاملاً روشن هم
 * اطمینان پایین می‌گرفت و همه‌چیز به صف بررسی می‌رفت.
 */
export function scoreConfidence(fields = {}) {
  let weighted = 0;
  let totalWeight = 0;
  const detail = {};
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const supplied = fields[field];
    if (supplied == null) continue;
    const score = clamp(typeof supplied === 'number' ? supplied : supplied.score);
    detail[field] = { score, reason: typeof supplied === 'object' ? String(supplied.reason || '') : '' };
    weighted += score * weight;
    totalWeight += weight;
  }
  if (!totalWeight) return { score: 0, fields: detail };
  return { score: clamp(weighted / totalWeight), fields: detail };
}

/**
 * مسیر یک رویداد.
 *
 * `blockers` دلایلی هستند که فارغ از عدد اطمینان، ثبت خودکار را ممنوع می‌کنند —
 * مثل جهت مبهم پول یا نبود طرف حساب در یک تعهد. یک عدد بالا نباید بتواند روی
 * یک ایراد ساختاری سرپوش بگذارد.
 */
export function routeEvent(event, { fields = {}, blockers = [] } = {}) {
  const { score, fields: detail } = scoreConfidence(fields);
  const reasons = [...new Set(blockers.filter(Boolean))];

  if (reasons.length) {
    return {
      route: score >= CONFIDENCE_THRESHOLDS.confirm ? ROUTES.CONFIRM : ROUTES.ACCOUNTANT_REVIEW,
      score, percent: Math.round(score * 100), fields: detail, reasons,
      summary: humanSummary(event),
    };
  }
  const neverAuto = NEVER_AUTOMATIC.has(event?.kind);
  const route = score >= CONFIDENCE_THRESHOLDS.auto && !neverAuto
    ? ROUTES.AUTO
    : score >= CONFIDENCE_THRESHOLDS.confirm
      ? ROUTES.CONFIRM
      : ROUTES.ACCOUNTANT_REVIEW;
  return {
    route,
    score,
    percent: Math.round(score * 100),
    fields: detail,
    reasons: neverAuto && score >= CONFIDENCE_THRESHOLDS.auto
      ? ['این نوع سند همیشه تأیید می‌خواهد، چون برگرداندنش ساده نیست.']
      : [],
    summary: humanSummary(event),
  };
}

const money = (value) => new Intl.NumberFormat('fa-IR').format(Math.round(Number(value) || 0));

/**
 * خلاصهٔ رویداد به زبان ساده.
 *
 * قاعده: هیچ اصطلاح دفترداری. کاربر عادی «بدهکار» و «بستانکار» را در معنای
 * حسابداری نمی‌فهمد و بدتر، در معنای روزمره برعکس می‌فهمد. او باید فقط بداند
 * چه چیزی، چقدر، با چه کسی و چه تاریخی ثبت می‌شود.
 */
export function humanSummary(event) {
  if (!event) return '';
  const parts = [describeEvent(event), `${money(event.amount)} تومان`];
  if (event.dueAt) parts.push('با سررسید مشخص');
  return parts.join(' — ');
}
