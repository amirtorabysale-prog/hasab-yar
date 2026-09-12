import { CONFIDENCE_COMPONENTS, routeEvent } from '../shared/confidenceEngine.js';
import { EVENT_KINDS, normalizeFinancialEvent } from '../shared/financialEvent.js';

/**
 * پل میان ردیف تراکنش و لایهٔ رویداد مالی.
 *
 * چرا این فایل لازم است: تعهد و تسویه و چک هرکدام از اول به شکل رویداد ساخته
 * می‌شوند، ولی هزینه و درآمد ساده — که بیشترین حجم ثبت‌اند — شکل خودشان را
 * دارند. بدون این نگاشت، موتور اطمینان روی همان مسیری که بیشتر از همه استفاده
 * می‌شود اصلاً اجرا نمی‌شد و صف بررسی همیشه خالی می‌ماند.
 *
 * اینجا هیچ تصمیم حسابداری گرفته نمی‌شود. فقط می‌گوید «چه اتفاقی افتاد» و
 * «چقدر مطمئنیم». اینکه سندش چه می‌شود کار `shared/accountingRules.js` است.
 */

const KIND_BY_TYPE = Object.freeze({
  income: EVENT_KINDS.CASH_INCOME,
  expense: EVENT_KINDS.CASH_EXPENSE,
});

const score = (detail) => {
  if (detail == null) return null;
  if (typeof detail === 'number') return Number.isFinite(detail) ? { score: detail, reason: '' } : null;
  if (!Number.isFinite(Number(detail.score))) return null;
  return { score: Number(detail.score), reason: String(detail.reason || '') };
};

/**
 * مؤلفه‌های اطمینان یک تراکنش.
 *
 * مؤلفه‌ای که دربارهٔ آن چیزی نمی‌دانیم گزارش *نمی‌شود* و وزنش از میانگین بیرون
 * می‌رود — نه اینکه نمرهٔ پایین بگیرد. یک هزینهٔ نقدی ساده طرف حساب ندارد و
 * تاریخ هم ندارد چون همین امروز است؛ نمرهٔ کم دادن به این دو یعنی فرستادن هر
 * ثبت عادی به صف بررسی.
 */
export function transactionConfidenceComponents(item = {}) {
  const supplied = item.confidenceDetails || {};
  const components = {};
  const put = (name, value) => { const detail = score(value); if (detail) components[name] = detail; };

  // نبودِ نمره یعنی «تردیدی گزارش نشده»، نه «اطمینانی نداریم».
  //
  // تردید را تحلیلگر گفتار گزارش می‌کند. ثبتی که از فرم یا از API می‌آید، انتخاب
  // خود کاربر است و هیچ برداشتی در آن نیست که بشود به آن شک کرد. صفر گرفتن
  // این‌ها یعنی هر ثبت دستی هم به صف بررسی می‌رفت — صفی که آن‌وقت هیچ حسابداری
  // نمی‌توانست خالی‌اش کند.
  const certain = (present, reason) => (present ? { score: 1, reason } : null);
  const amount = Math.round(Number(item.amount));
  put(CONFIDENCE_COMPONENTS.AMOUNT, supplied.amount ?? certain(Number.isSafeInteger(amount) && amount > 0, 'مبلغ مشخص است.'));
  put(CONFIDENCE_COMPONENTS.DIRECTION, supplied.type ?? certain(['income', 'expense'].includes(item.type), 'جهت پول مشخص است.'));
  put(CONFIDENCE_COMPONENTS.COMPLETENESS, supplied.category ?? certain(Boolean(item.category), 'دسته انتخاب شده است.'));
  put(CONFIDENCE_COMPONENTS.ACCOUNT, supplied.account ?? certain(Boolean(item.accountId), 'حساب مشخص است.'));

  // تاریخ فقط وقتی مؤلفه است که کاربر تاریخی گفته باشد. نگفتنش یعنی «امروز»،
  // که ابهام نیست.
  if (item.dateExplicit) put(CONFIDENCE_COMPONENTS.DATE, { score: 1, reason: 'تاریخ در متن آمده است.' });
  if (item.contactId) put(CONFIDENCE_COMPONENTS.COUNTERPARTY, { score: 1, reason: 'طرف حساب مشخص است.' });
  if (item.source === 'voice' && Number.isFinite(Number(item.confidence))) {
    put(CONFIDENCE_COMPONENTS.AI, { score: Number(item.confidence), reason: 'برداشت از گفتار.' });
  }
  return components;
}

/**
 * رویداد مالی و تصمیم مسیرش برای یک تراکنش.
 *
 * `aiOnly` عمداً پیش‌فرض `false` است: تراکنشی که از این مسیر می‌آید، پیش از
 * ارسال در برگهٔ تأیید به کاربر نشان داده شده. برداشت خام مدل زبانی نیست و
 * رفتار با آن مثل برداشت خام، کل صف را از ثبت‌های عادی پر می‌کرد.
 */
export function transactionEventDecision(item = {}, { transcript = '', aiOnly = false, policy = {} } = {}) {
  const kind = KIND_BY_TYPE[item.type];
  if (!kind) return null;
  const event = normalizeFinancialEvent({
    kind,
    amount: item.amount,
    occurredAt: item.occurredAt,
    category: item.category,
    description: item.category,
    counterparty: item.contactName || '',
    counterpartyId: item.contactId || null,
    accountId: item.accountId || null,
    source: item.source === 'voice' ? 'voice' : 'text',
    evidence: String(item.rawText || transcript || '').slice(0, 1000),
  });
  const blockers = Array.isArray(item.reviewReasons) ? item.reviewReasons.filter(Boolean) : [];
  // پرچم بررسی بدون دلیلِ نوشته‌شده هم باید جلوی ثبت بی‌پرسش را بگیرد، وگرنه
  // تنها نشانهٔ تردید بی‌اثر می‌ماند.
  if (item.needsReview && !blockers.length) blockers.push('این ثبت هنگام برداشت نیازمند بررسی علامت خورده است.');
  const decision = routeEvent(event, {
    components: transactionConfidenceComponents(item), blockers, aiOnly, policy,
  });
  return { event, decision };
}
