const DAY_MS = 24 * 60 * 60 * 1000;

export const FINANCIAL_UNIT = 'تومان';
export const FINANCIAL_DISCLAIMER = 'محاسبه فقط بر پایهٔ دریافت‌ها و پرداخت‌های ثبت‌شده است؛ سود حسابداری، مالیات و تعهدات ثبت‌نشده را شامل نمی‌شود.';

export function sensitivityProfile(value = 'balanced') {
  if (value === 'high') return { id: 'high', growthRatio: 1.2, anomalyRatio: 2, minimumDelta: 300_000 };
  if (value === 'low') return { id: 'low', growthRatio: 1.5, anomalyRatio: 3, minimumDelta: 1_000_000 };
  return { id: 'balanced', growthRatio: 1.35, anomalyRatio: 2.5, minimumDelta: 500_000 };
}

export function exactWindow(now = new Date(), days = 30, offsetDays = 0) {
  const end = new Date(now.getTime() - offsetDays * DAY_MS);
  const start = new Date(end.getTime() - days * DAY_MS);
  return { from: start.toISOString(), to: end.toISOString(), days };
}

export function financialScope(window, label) {
  return {
    from: window.from,
    to: window.to,
    days: window.days,
    label: label || `${window.days} روز اخیر`,
    basis: 'cash',
    basisLabel: 'مبنای دریافت و پرداخت',
    unit: FINANCIAL_UNIT,
  };
}

export function transactionSource(item, period = 'current') {
  return {
    kind: 'transaction', id: item.id, label: item.rawText || item.category,
    amount: Number(item.amount || 0), occurredAt: item.occurredAt, type: item.type,
    category: item.category, accountName: item.accountName || '', period,
  };
}

export function obligationSource(item) {
  return {
    kind: 'obligation', id: item.id, label: item.title, amount: Number(item.amount || 0),
    dueAt: item.dueAt || null, createdAt: item.createdAt || null, direction: item.direction, contactName: item.contactName || '',
  };
}

export function invoiceSource(item) {
  return {
    kind: 'invoice', id: item.id, label: item.number,
    amount: Number(item.balanceDue || 0), dueAt: item.dueAt || null, createdAt: item.createdAt || null,
    direction: item.documentType === 'purchase' ? 'payable' : 'receivable',
    contactName: item.contactName || item.customerName || '',
  };
}

export function median(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

export function buildRunway({ cash = 0, expenseTotal = 0, lookbackDays = 30, scope, sources = [] } = {}) {
  const safeCash = Math.max(0, Number(cash) || 0);
  const safeExpense = Math.max(0, Number(expenseTotal) || 0);
  const averageDailyExpense = safeExpense / Math.max(1, Number(lookbackDays) || 30);
  const scenario = (id, label, factor) => ({
    id, label, factor,
    dailyExpense: Math.round(averageDailyExpense * factor),
    days: averageDailyExpense > 0 ? Math.max(0, Math.round(safeCash / (averageDailyExpense * factor))) : null,
  });
  return {
    cash: safeCash,
    averageDailyExpense: Math.round(averageDailyExpense),
    lookbackDays,
    scenarios: [scenario('optimistic', 'خوش‌بینانه', 0.8), scenario('base', 'پایه', 1), scenario('pessimistic', 'بدبینانه', 1.2)],
    scope,
    sources,
    formula: 'ماندهٔ نقدی ÷ میانگین هزینهٔ روزانه؛ سناریوها فقط نرخ هزینه را ۲۰٪ کمتر یا بیشتر می‌کنند و درآمد آینده را فرض نمی‌کنند.',
    disclaimer: FINANCIAL_DISCLAIMER,
  };
}

export function findUnusualTransaction(rows = [], sensitivity = 'balanced', candidateFrom = '') {
  const profile = sensitivityProfile(sensitivity);
  for (const current of rows) {
    if (candidateFrom && new Date(current.occurredAt) < new Date(candidateFrom)) continue;
    const baseline = rows.filter((item) => item.id !== current.id && item.type === current.type && item.category === current.category && new Date(item.occurredAt) < new Date(current.occurredAt));
    if (baseline.length < 4) continue;
    const baselineMedian = median(baseline.map((item) => item.amount));
    const delta = Number(current.amount) - baselineMedian;
    if (baselineMedian > 0 && Number(current.amount) >= baselineMedian * profile.anomalyRatio && delta >= profile.minimumDelta) {
      return { current, baseline, baselineMedian: Math.round(baselineMedian), ratio: Number((Number(current.amount) / baselineMedian).toFixed(1)) };
    }
  }
  return null;
}

export function detectExpenseGrowth(currentRows = [], previousRows = [], sensitivity = 'balanced') {
  const profile = sensitivityProfile(sensitivity);
  const current = currentRows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const previous = previousRows.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const delta = current - previous;
  if (previous <= 0 || current < previous * profile.growthRatio || delta < profile.minimumDelta) return null;
  return { current, previous, delta, percent: Math.round((delta / previous) * 100) };
}

export function prioritizeAlerts(alerts = []) {
  return [...alerts].sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0))[0] || null;
}

export function isGuardedAdviceQuestion(question = '') {
  return /مالیات|مالیاتی|حقوقی|قانون|جریمه|اظهارنامه|بیمه/.test(question);
}
