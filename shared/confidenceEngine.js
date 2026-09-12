import { describeEvent } from './financialEvent.js';
import { resolveAutomationPolicy } from './automationPolicy.js';

/**
 * موتور اطمینان — مؤلفه‌محور، نه یک عدد خام.
 *
 * یک عدد تنها از مدل زبانی هیچ نمی‌گوید: نمی‌شود فهمید مبلغ مشکوک است یا
 * تاریخ، و نمی‌شود گفت چرا. وقتی اطمینان از مؤلفه‌های نام‌دار ساخته شود، هم
 * تصمیم قابل توضیح است و هم می‌شود روی یک مؤلفهٔ خاص شرط گذاشت — مثل «مبلغ
 * باید حتماً بالای این حد باشد، فارغ از میانگین کل».
 */

export const CONFIDENCE_COMPONENTS = Object.freeze({
  COMPLETENESS: 'completeness',
  AMOUNT: 'amountCertainty',
  DATE: 'dateCertainty',
  DIRECTION: 'moneyDirectionCertainty',
  ACCOUNT: 'accountCertainty',
  COUNTERPARTY: 'counterpartyCertainty',
  DNA: 'historicalMatch',
  BANK: 'bankReconciliationMatch',
  AI: 'aiExtractionConfidence',
});

/**
 * وزن هر مؤلفه.
 *
 * مبلغ و جهت پول بیشترین وزن را دارند چون خطایشان مستقیم پول است و هیچ لایهٔ
 * بعدی نمی‌گیردشان. تطبیق بانکی وزن بالایی دارد چون تنها شاهد بیرونی است —
 * بقیهٔ مؤلفه‌ها برداشت خودِ سیستم‌اند، این یکی واقعیت بانک است.
 *
 * برداشت مدل زبانی عمداً وزن کمی دارد: شاهد است، نه مرجع.
 */
const COMPONENT_WEIGHTS = Object.freeze({
  [CONFIDENCE_COMPONENTS.AMOUNT]: 0.26,
  [CONFIDENCE_COMPONENTS.DIRECTION]: 0.20,
  [CONFIDENCE_COMPONENTS.COMPLETENESS]: 0.14,
  [CONFIDENCE_COMPONENTS.BANK]: 0.12,
  [CONFIDENCE_COMPONENTS.DATE]: 0.09,
  [CONFIDENCE_COMPONENTS.COUNTERPARTY]: 0.07,
  [CONFIDENCE_COMPONENTS.ACCOUNT]: 0.06,
  [CONFIDENCE_COMPONENTS.DNA]: 0.03,
  [CONFIDENCE_COMPONENTS.AI]: 0.03,
});

export const ROUTES = Object.freeze({
  AUTO: 'auto',
  CONFIRM: 'confirm',
  ACCOUNTANT_REVIEW: 'accountant-review',
});

export const CONFIDENCE_THRESHOLDS = Object.freeze({ auto: 0.95, confirm: 0.80 });

const clamp = (value) => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0));

function componentScore(supplied) {
  if (supplied == null) return null;
  if (typeof supplied === 'number') return { score: clamp(supplied), reason: '' };
  return { score: clamp(supplied.score), reason: String(supplied.reason || '') };
}

/**
 * ترکیب مؤلفه‌ها.
 *
 * مؤلفهٔ گزارش‌نشده وزنش از محاسبه بیرون می‌رود، نه اینکه صفر بگیرد. یک هزینهٔ
 * نقدی ساده اصلاً طرف حساب و تطبیق بانکی ندارد؛ صفر دادن به آن‌ها یعنی هر
 * جملهٔ کوتاه و کاملاً روشن هم به صف بررسی می‌رفت.
 */
export function scoreConfidence(components = {}) {
  let weighted = 0;
  let totalWeight = 0;
  const detail = {};
  for (const [name, weight] of Object.entries(COMPONENT_WEIGHTS)) {
    const value = componentScore(components[name]);
    if (!value) continue;
    detail[name] = value;
    weighted += value.score * weight;
    totalWeight += weight;
  }
  if (!totalWeight) return { score: 0, components: detail };
  return { score: clamp(weighted / totalWeight), components: detail };
}

/**
 * مسیر یک رویداد.
 *
 * ترتیب کنترل‌ها عمدی است: مانع ساختاری پیش از عدد، و شرط‌های تک‌مؤلفه‌ای پیش
 * از میانگین. یک میانگین بالا نباید بتواند روی «مبلغ را مطمئن نیستیم» یا «جهت
 * پول مبهم است» سرپوش بگذارد.
 */
export function routeEvent(event, { components = {}, blockers = [], policy: policyOverrides = {}, aiOnly = false } = {}) {
  const policy = resolveAutomationPolicy(policyOverrides);
  const { score, components: detail } = scoreConfidence(components);
  const percent = Math.round(score * 100);
  const reasons = [...new Set(blockers.filter(Boolean))];
  const summary = humanSummary(event);
  const below = (route) => ({ route, score, percent, components: detail, reasons, summary, policy });

  if (reasons.length) {
    return below(score >= policy.confirmThreshold ? ROUTES.CONFIRM : ROUTES.ACCOUNTANT_REVIEW);
  }

  const guards = [];
  if (policy.neverAutomatic.includes(event?.kind)) {
    guards.push('این نوع سند همیشه تأیید می‌خواهد، چون برگرداندنش ساده نیست.');
  }
  // برداشت مدل زبانی به‌تنهایی مرجع نیست. بدون شاهد دیگری، ثبت بی‌پرسش یعنی
  // سپردن دفتر به یک برداشت آماری.
  if (aiOnly && !policy.allowAiOnlyAutoPost) {
    guards.push('این برداشت فقط از مدل زبانی آمده و شاهد دیگری ندارد.');
  }
  const amount = detail[CONFIDENCE_COMPONENTS.AMOUNT];
  if (amount && amount.score < policy.minimumAmountCertainty) {
    guards.push('اطمینان از مبلغ برای ثبت بی‌پرسش کافی نیست.');
  }

  if (score >= policy.autoThreshold && !guards.length) return below(ROUTES.AUTO);
  if (score >= policy.confirmThreshold) {
    return { ...below(ROUTES.CONFIRM), reasons: guards };
  }
  return { ...below(ROUTES.ACCOUNTANT_REVIEW), reasons: guards };
}

const money = (value) => new Intl.NumberFormat('fa-IR').format(Math.round(Number(value) || 0));

/**
 * خلاصهٔ رویداد به زبان ساده.
 *
 * قاعده: هیچ اصطلاح دفترداری. کاربر عادی «بدهکار» و «بستانکار» را در معنای
 * حسابداری نمی‌فهمد و بدتر، در معنای روزمره برعکس می‌فهمد.
 */
export function humanSummary(event) {
  if (!event) return '';
  const parts = [describeEvent(event), `${money(event.amount)} تومان`];
  if (event.dueAt) parts.push('با سررسید مشخص');
  return parts.join(' — ');
}
