import { resolveAutomationPolicy } from '../shared/automationPolicy.js';
import { reviewQuestionFact } from '../shared/reviewQuestions.js';

/**
 * حد سرمایه‌ای مصوب دفتر در صف حسابدار.
 *
 * وقتی دفتر عددش را تصویب کرده، «سیاست سرمایه‌ای شدن چیست؟» دیگر سؤال نیست،
 * و دارایی ثابتِ زیر آن عدد خلاف سیاست خود دفتر است. بدون عدد، رفتار همان قبلی
 * است: سؤال پرسیده می‌شود و چیزی فرض نمی‌شود.
 */
export function reviewCapitalizationThreshold(database) {
  try {
    const raw = database.prepare("SELECT value FROM settings WHERE key='automationPolicy'").get()?.value;
    return resolveAutomationPolicy(JSON.parse(raw || '{}')).capitalizationThreshold;
  } catch { return null; }
}

const fa = (value) => Number(value || 0).toLocaleString('fa-IR');

export function capitalizationIssues(threshold, lines = []) {
  if (!threshold) return [];
  const asset = lines.filter((line) => line.role === 'fixed-asset').reduce((sum, line) => sum + Number(line.debit || 0), 0);
  if (!asset || asset >= threshold) return [];
  return [{ id: 'policy.capitalization-threshold', text: `بهای این مورد (${fa(asset)} تومان) کمتر از حد سرمایه‌ای مصوب دفتر (${fa(threshold)} تومان) است؛ طبق سیاست دفتر هزینهٔ دوره ثبت می‌شود، نه دارایی ثابت.` }];
}

/** سؤال‌هایی که سیاست مصوب دفتر پاسخشان را دارد، پرسیده نمی‌شوند. */
export function withoutPolicyAnsweredQuestions(questions = [], threshold, amount) {
  if (!threshold) return questions;
  const below = Number.isFinite(amount) && amount > 0 && amount < threshold;
  return questions.filter((question) => {
    const fact = reviewQuestionFact(question.text || '');
    if (fact === 'capitalization-policy' || question.id === 'leasehold.capitalization-policy') return false;
    if (below && ['capitalization-choice', 'useful-life'].includes(fact)) return false;
    return true;
  });
}

export function capitalizationPromptLine(threshold) {
  return threshold
    ? `سیاست مصوب این دفتر: خرید تجهیز و اموال با بهای کمتر از ${threshold} تومان هزینهٔ دوره است و از آن به بالا دارایی ثابت (با پرسش عمر مفید). دربارهٔ سیاست سرمایه‌ای شدن سؤال نپرس.`
    : '';
}
