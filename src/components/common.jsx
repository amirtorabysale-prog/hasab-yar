

export const EMPTY_SUMMARY = { income: 0, expense: 0, netCashFlow: 0, profit: 0, comparison: null };

export function digitsOnly(value) {
  return String(value ?? '').replace(/[^\d۰-۹٠-٩]/g, '').replace(/[۰-۹٠-٩]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) >= 0 ? String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)) : String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}
