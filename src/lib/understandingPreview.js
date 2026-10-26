/**
 * دستهٔ کنارِ حسابِ هر جزء در برگهٔ فهم.
 *
 * دسته فقط وقتی معنا دارد که سند سطر درآمد یا هزینه داشته باشد. آزمون زندهٔ ۴ آبان ۱۴۰۵:
 * آورده («بستانکار سرمایه»)، پیش‌دریافت و پول شریک کنار حساب «سایر درآمدها» نشان می‌دادند و
 * حسابدار سندی را می‌دید که درآمد نبود ولی برچسب درآمد داشت.
 */
export function componentCategoryLabel(component = {}) {
  if (!component.category) return '';
  const lines = component.preview?.lines || [];
  if (lines.length && !lines.some((line) => ['expense-category', 'income-category'].includes(line.role))) return '';
  return component.category;
}
