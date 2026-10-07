import { normalizePersian } from './normalize.js';

export const TAX_PENALTY_CATEGORY = 'جرایم مالیاتی';
export const isTaxPenaltyCategory = value => /^(?:جرایم|جرائم|جریمه)(?: های)? مالیاتی$/.test(normalizePersian(String(value || '')).trim());

export function taxPenaltyFacts(text) {
  const t = normalizePersian(String(text || '')).replace(/\s+/g, ' ');
  const penalty = /جریمه|جرایم|جرائم/.test(t) && /مالیات|ارزش افزوده/.test(t);
  const noPrior=/(?:ثبت|شناسایی) نشده|(?:ثبت|شناسایی) نکرد/.test(t);
  const prior = !noPrior && /قبلا|پیش تر|دوره قبل|سال قبل/.test(t) && /ثبت|شناسایی|پرداختنی|بدهی/.test(t);
  const mixed = /اصل مالیات|مالیات و جریمه|جریمه و مالیات|بخشی.*جریمه/.test(t);
  const paid = /پرداخت شد|پرداخت کرد|پرداخت کردم|پرداخت کردیم|واریز کرد|واریز شد/.test(t);
  const negated = /پرداخت نشده|پرداخت نکرد|هنوز.*پرداخت|بخشود|بخشید|اعتراض/.test(t);
  return { penalty, prior, mixed, paid: paid && !negated };
}

// Only a paid, standalone, first-recognition fine has this two-line shape.
// Tax deductibility is not inferred here; settlement of an existing accrual
// must use its actual liability rather than recognize a second expense.
export function taxPenaltyProposal(text, amount, facts={}) {
  const f = taxPenaltyFacts(text);
  if (!f.penalty || !Number.isSafeInteger(amount) || amount <= 0) return null;
  if (f.prior || f.mixed || !f.paid) return {
    summary: 'بررسی جریمه مالیاتی و سند مبنا',
    explanation: 'جریمه باید از اصل مالیات جدا باشد؛ پرداخت بدهی ثبت‌شده هزینه دوباره نیست.',
    workflowBlockers:facts.questionAnswers?.['nature.tax-penalty-basis'] ? ['پاسخ و تفکیک مبالغ محفوظ است؛ سند واقعی شناسایی اصل مالیات/جریمه و مسیر تسویه هر بخش باید تکمیل شود. این مسیر هنوز ثبت نقدی چندبخشی را پشتیبانی نمی‌کند.'] : [],
    questions: facts.questionAnswers?.['nature.tax-penalty-basis'] ? [] : [{ id: 'nature.tax-penalty-basis', text: f.prior
      ? 'شماره سند شناسایی قبلی جریمه و مانده حساب پرداختنی آن چیست؟'
      : f.mixed ? 'مبلغ اصل مالیات و جریمه، و سند مبنای هر بخش چیست؟'
        : 'جریمه قطعی شده و پرداخت انجام شده است یا هنوز در مرحله اعتراض یا مطالبه است؟' }],
    missingFacts: [], lines: [],
  };
  return { summary: 'پرداخت جریمه مالیاتی مستقل',
    explanation: 'هزینه جریمه جدا از اصل مالیات و عوارض ثبت می‌شود؛ قابل قبول بودن مالیاتی از این ثبت نتیجه‌گیری نمی‌شود.',
    missingFacts: [], questions: [], lines: [
      { role: 'expense-category', key: TAX_PENALTY_CATEGORY, debit: amount, credit: 0 },
      { role: 'cash', debit: 0, credit: amount },
    ] };
}
