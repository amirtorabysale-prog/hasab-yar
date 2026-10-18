const clampScore = (value, fallback = 0.5) => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : fallback));

const DEFAULT_FIELDS = Object.freeze({
  amount: { score: 0.9, reason: 'مبلغ از عبارت مالی استخراج شد.' },
  type: { score: 0.82, reason: 'نوع ثبت از فعل و واژه‌های مالی برداشت شد.' },
  category: { score: 0.78, reason: 'دسته از متن و قواعد دسته‌بندی پیشنهاد شد.' },
  account: { score: 0.82, reason: 'حساب پیش‌فرض دفتر انتخاب شد.' },
});

export const REVIEW_FIELD_LABELS = Object.freeze({ amount: 'مبلغ', type: 'نوع', category: 'دسته', account: 'حساب' });

function normalizedField(value, fallback) {
  if (typeof value === 'number') return { ...fallback, score: clampScore(value) };
  return { ...fallback, ...(value || {}), score: clampScore(value?.score, fallback.score) };
}

export function assessTransactionReview(item = {}) {
  const supplied = item.confidenceDetails || {};
  const hasSuppliedFields = Object.keys(supplied).length > 0;
  const fields = Object.fromEntries(Object.entries(DEFAULT_FIELDS).map(([key, fallback]) => [key, normalizedField(supplied[key], fallback)]));
  const weighted = fields.amount.score * 0.42 + fields.type.score * 0.24 + fields.category.score * 0.22 + fields.account.score * 0.12;
  // P2 بازخورد UX — یکدستی اطمینان کلی با فیلدها در «نمایش»: کارت «چرا این
  // تصمیم؟» عدد کلی را کنار درصد هر فیلد نشان می‌دهد؛ پیش از این «کلی ۹۱٪»
  // کنار «دسته ۶۰٪» می‌نشست و با نشان «نیازمند بررسی» نمی‌خواند. عدد نمایشی
  // حالا هرگز از ضعیف‌ترین فیلدِ سنجیده‌شده بالاتر نیست. مسیریابی (صف حسابدار
  // یا آماده) با همان overallScore قبلی می‌ماند تا رفتار ثبت عوض نشود.
  const measuredScores = Object.entries(fields).filter(([key]) => supplied[key] != null).map(([, detail]) => detail.score);
  const weakestMeasured = measuredScores.length ? Math.min(...measuredScores) : 1;
  const overallScore = hasSuppliedFields ? clampScore(weighted, weighted) : clampScore(item.confidence ?? weighted, weighted);
  const displayPercent = Math.round(clampScore(Math.min(overallScore, weakestMeasured), overallScore) * 100);
  const reasons = [...new Set([
    ...(Array.isArray(item.reviewReasons) ? item.reviewReasons : []),
    ...(item.warning ? [item.warning] : []),
    ...Object.entries(fields).filter(([, detail]) => detail.score < 0.7).map(([field, detail]) => `${REVIEW_FIELD_LABELS[field]}: ${detail.reason}`),
  ].filter(Boolean))];
  const blocked = !Number.isSafeInteger(Math.round(Number(item.amount))) || Number(item.amount) <= 0 || !['income', 'expense'].includes(item.type) || !item.category;
  const state = blocked
    ? 'unintelligible'
    : item.needsReview || item.reviewCode || reasons.length > 0 || overallScore < 0.82
      ? 'review'
      : 'ready';
  return { state, overallScore, percent: Math.round(overallScore * 100), displayPercent, fields, reasons };
}

export function withReviewAssessment(item = {}) {
  const assessment = assessTransactionReview(item);
  return {
    ...item,
    confidence: assessment.overallScore,
    confidenceDetails: assessment.fields,
    reviewReasons: assessment.reasons,
    reviewState: assessment.state,
    needsReview: assessment.state !== 'ready',
  };
}

export function reviewBatchSummary(result = {}) {
  const summary = { ready: 0, review: 0, unintelligible: 0, total: 0 };
  for (const item of result.transactions || []) {
    const state = assessTransactionReview(item).state;
    summary[state] += 1;
    summary.total += 1;
  }
  if (!summary.total) summary.unintelligible = 1;
  return summary;
}
