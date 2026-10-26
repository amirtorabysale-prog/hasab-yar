import { resolveAutomationPolicy } from '../shared/automationPolicy.js';
import { reviewQuestionFact } from '../shared/reviewQuestions.js';
import { unitLabel } from '../shared/amountUnit.js';

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

export function capitalizationIssues(threshold, lines = [], { durable = false } = {}) {
  if (!threshold) return [];
  const asset = lines.filter((line) => line.role === 'fixed-asset').reduce((sum, line) => sum + Number(line.debit || 0), 0);
  // آینه‌اش: کالای ماندگاری که هم‌اندازه یا بالاتر از حد است و پیشنهاد آن را هزینه کرده.
  // «پرینتر لیزری ۲۵ میلیونی» با حد ۲۰ میلیون، با پیشنهاد «ملزومات اداری» ثبت شد (R049).
  const expensed = lines.filter((line) => line.role === 'expense-category').reduce((sum, line) => sum + Number(line.debit || 0), 0);
  if (durable && !asset && expensed >= threshold) {
    return [{ id: 'policy.capitalization-threshold', text: `این کالای ماندگار (${fa(expensed)} ${unitLabel()}) هم‌اندازه یا بالاتر از حد سرمایه‌ای مصوب دفتر (${fa(threshold)} ${unitLabel()}) است؛ طبق سیاست دفتر دارایی ثابت با عمر مفید ثبت می‌شود، نه هزینهٔ دوره.` }];
  }
  if (!asset || asset >= threshold) return [];
  return [{ id: 'policy.capitalization-threshold', text: `بهای این مورد (${fa(asset)} ${unitLabel()}) کمتر از حد سرمایه‌ای مصوب دفتر (${fa(threshold)} ${unitLabel()}) است؛ طبق سیاست دفتر هزینهٔ دوره ثبت می‌شود، نه دارایی ثابت.` }];
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
    ? `سیاست مصوب این دفتر: خرید تجهیز و اموال با بهای کمتر از ${threshold} ${unitLabel()} هزینهٔ دوره است و از آن به بالا دارایی ثابت (با پرسش عمر مفید). دربارهٔ سیاست سرمایه‌ای شدن سؤال نپرس.`
    : '';
}
