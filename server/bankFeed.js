/**
 * اینترفیس منبع بانکی — جدا از موتور حسابداری.
 *
 * تطبیق بانکی نباید داخل موتور حسابداری باشد: موتور از رویداد سند می‌سازد، و
 * بانک یک **شاهد بیرونی** است که می‌گوید آن رویداد واقعاً اتفاق افتاده یا نه.
 * قاطی‌کردنشان یعنی هر تغییر در فرمت یک بانک، منطق سند را تکان می‌دهد.
 *
 * امروز تنها پیاده‌سازی، ایمپورت اکسل/CSV است. فردا API بانک به‌عنوان منبع
 * دیگری از همین قرارداد اضافه می‌شود، بدون اینکه چیزی در موتور عوض شود.
 */

/**
 * قرارداد یک منبع بانکی.
 *
 * هر منبع باید ردیف‌ها را به این شکل یکسان برساند:
 *   { externalId, occurredAt, amount, direction: 'in'|'out', description, balanceAfter? }
 *
 * `externalId` کلید یکتایی است. بدون آن، هر بار ایمپورت دوباره همان ردیف‌ها را
 * تکراری می‌سازد.
 */
export const BANK_SOURCE_KINDS = Object.freeze({
  SPREADSHEET: 'spreadsheet',
  BANK_API: 'bank-api',
});

function feedError(message, code = 'BANK_FEED_INVALID') {
  return Object.assign(new Error(message), { code, status: 400 });
}

/** یک ردیف بانکی را به شکل قانونی می‌آورد. */
export function normalizeBankLine(raw = {}, { sourceKind = BANK_SOURCE_KINDS.SPREADSHEET } = {}) {
  const externalId = String(raw.externalId || '').trim();
  if (!externalId) throw feedError('ردیف بانکی بدون شناسهٔ یکتا قابل استفاده نیست.', 'BANK_LINE_ID_MISSING');
  const amount = Math.round(Number(raw.amount) || 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw feedError('مبلغ ردیف بانکی معتبر نیست.', 'BANK_LINE_AMOUNT_INVALID');
  const direction = raw.direction === 'out' ? 'out' : raw.direction === 'in' ? 'in' : null;
  if (!direction) throw feedError('جهت ردیف بانکی مشخص نیست.', 'BANK_LINE_DIRECTION_MISSING');
  const occurredAt = raw.occurredAt ? new Date(raw.occurredAt) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) throw feedError('تاریخ ردیف بانکی معتبر نیست.', 'BANK_LINE_DATE_INVALID');
  return Object.freeze({
    externalId, amount, direction,
    occurredAt: occurredAt.toISOString(),
    description: String(raw.description || '').trim().slice(0, 300),
    sourceKind: Object.values(BANK_SOURCE_KINDS).includes(sourceKind) ? sourceKind : BANK_SOURCE_KINDS.SPREADSHEET,
  });
}

/**
 * امتیاز تطبیق یک ردیف بانکی با یک رویداد مالی.
 *
 * این تابع تصمیم نمی‌گیرد؛ فقط شاهد می‌دهد. خروجی‌اش یکی از مؤلفه‌های موتور
 * اطمینان است (`bankReconciliationMatch`) و هرگز به‌تنهایی سند نمی‌سازد.
 *
 * مبلغ باید دقیق بخورد. تاریخ چند روز فاصله می‌تواند داشته باشد چون ثبت بانک و
 * لحظهٔ رویداد همیشه یکی نیستند، ولی فاصلهٔ بیشتر یعنی شاهد ضعیف‌تر.
 */
export function scoreBankMatch(line, event, { toleranceDays = 3 } = {}) {
  if (!line || !event) return 0;
  if (Math.round(Number(line.amount)) !== Math.round(Number(event.amount))) return 0;
  const expected = event.kind && String(event.kind).includes('income') ? 'in' : 'out';
  // جهت متضاد یعنی این ردیف اصلاً همان رویداد نیست، نه اینکه کمی مشکوک باشد.
  if (line.direction !== expected && event.kind) return 0;
  const days = Math.abs(new Date(line.occurredAt).getTime() - new Date(event.occurredAt).getTime()) / 86_400_000;
  if (days > toleranceDays) return 0;
  return Math.max(0, 1 - (days / (toleranceDays + 1)));
}
