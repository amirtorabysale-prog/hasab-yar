/**
 * گزارش اختلاف — موتور چه گفت، حسابدار چه کرد.
 *
 * چرا این لایه ارزش دارد:
 *
 * تا وقتی موتور روی دفتر واقعی ننشسته، هر ادعایی دربارهٔ درستی‌اش حدس است.
 * پیکرهٔ طلایی می‌گوید روی سی سناریوی ساختگی چه می‌کند؛ این می‌گوید روی
 * دفتر واقعیِ یک دفتر حسابداری چه می‌کند. آن دو یکی نیستند.
 *
 * شدت اختلاف سه سطح دارد و مرزشان عمدی است:
 *
 * - **بحرانی**: اختلافی که در تراز دیده نمی‌شود یا سود دوره را تکان می‌دهد.
 *   مبلغ متفاوت، یا اینکه یکی از دو طرف سود و زیان را لمس کرده و دیگری نه.
 * - **مهم**: حساب متفاوت ولی هر دو در یک سمت ترازنامه. اشتباه است، ولی در
 *   گزارش‌ها پیدا می‌شود.
 * - **ظاهری**: شرح و عنوان. هیچ عددی را عوض نمی‌کند.
 *
 * قاعدهٔ حاکم طرح: **ثبت اشتباه بی‌صدا همیشه بحرانی است، فارغ از مبلغ.**
 */

export const DIFFERENCE_SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  MATERIAL: 'material',
  COSMETIC: 'cosmetic',
});

/** نقش‌هایی که سود دوره را تکان می‌دهند. */
const PROFIT_ROLES = new Set(['income-category', 'expense-category', 'depreciation-expense']);

const rolesOf = (plan) => (plan?.lines || []).map((line) => line.role).filter(Boolean).sort();
const touchesProfit = (plan) => rolesOf(plan).some((role) => PROFIT_ROLES.has(role));
const totalOf = (plan) => (plan?.lines || []).reduce((sum, line) => sum + Number(line.debit || 0), 0);

/**
 * پیشنهاد موتور را با ثبت واقعی مقایسه می‌کند.
 *
 * تابع خالص: هیچ دیتابیسی. همان ورودی همیشه همان فهرست اختلاف را می‌دهد، تا
 * گزارش دوره‌ای قابل بازتولید بماند.
 */
export function compareProposalWithActual(proposal = {}, actual = {}) {
  const differences = [];
  if (!proposal.plan || !actual.plan) return differences;

  const proposedAmount = Number(proposal.amount ?? totalOf(proposal.plan));
  const actualAmount = Number(actual.amount ?? totalOf(actual.plan));
  if (proposedAmount !== actualAmount) {
    differences.push({
      field: 'amount', severity: DIFFERENCE_SEVERITY.CRITICAL,
      proposed: proposedAmount, actual: actualAmount,
      note: 'مبلغ ثبت‌شده با مبلغ پیشنهادی یکی نیست.',
    });
  }

  const proposedRoles = rolesOf(proposal.plan);
  const actualRoles = rolesOf(actual.plan);
  if (proposedRoles.join(',') !== actualRoles.join(',')) {
    // یکی سود دوره را لمس کرده و دیگری نه: همان تفاوت دارایی و هزینه، یا
    // تسویه و هزینه. این در تراز دیده نمی‌شود چون هر دو متوازن‌اند.
    const profitDiffers = touchesProfit(proposal.plan) !== touchesProfit(actual.plan);
    differences.push({
      field: 'accounts',
      severity: profitDiffers ? DIFFERENCE_SEVERITY.CRITICAL : DIFFERENCE_SEVERITY.MATERIAL,
      proposed: proposedRoles, actual: actualRoles,
      note: profitDiffers
        ? 'یکی از دو ثبت سود دوره را تکان می‌دهد و دیگری نه.'
        : 'حساب‌ها فرق دارند ولی هر دو در یک سمت ترازنامه‌اند.',
    });
  }

  if (proposal.memo && actual.memo && proposal.memo !== actual.memo) {
    differences.push({ field: 'memo', severity: DIFFERENCE_SEVERITY.COSMETIC, proposed: proposal.memo, actual: actual.memo, note: 'فقط شرح فرق دارد.' });
  }

  return differences;
}

/**
 * خلاصهٔ یک دسته، خانواده‌به‌خانواده.
 *
 * چرا به تفکیک خانواده: فعال‌سازی خودکار هم خانواده‌به‌خانواده است. خلاصهٔ کل
 * نمی‌گوید کدام خانواده آمادهٔ فعال شدن است و کدام نه.
 */
export function summarizeDisagreements(runs = []) {
  const summary = { total: 0, agreed: 0, critical: 0, material: 0, cosmetic: 0, byFamily: {} };
  for (const run of runs) {
    summary.total += 1;
    const family = run.family || 'unknown';
    const bucket = summary.byFamily[family] || (summary.byFamily[family] = { total: 0, agreed: 0, critical: 0, material: 0, cosmetic: 0 });
    bucket.total += 1;

    const differences = run.differences || [];
    if (!differences.length) { summary.agreed += 1; bucket.agreed += 1; continue; }
    for (const difference of differences) {
      if (difference.severity === DIFFERENCE_SEVERITY.CRITICAL) { summary.critical += 1; bucket.critical += 1; }
      else if (difference.severity === DIFFERENCE_SEVERITY.MATERIAL) { summary.material += 1; bucket.material += 1; }
      else { summary.cosmetic += 1; bucket.cosmetic += 1; }
    }
  }
  return summary;
}
