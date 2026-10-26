/**
 * واحد مبلغ دفتر: تومان یا ریال.
 *
 * هر مبلغی که در یک دفتر ذخیره می‌شود عدد صحیحی به واحد همان دفتر است. دفترهای
 * قدیمی و پیش‌فرض تومانی‌اند. دفتر ریالی برای دفتر حسابداری‌ای است که با پارسیان
 * کار می‌کند: پارسیان مبلغ را به ریال نگه می‌دارد و ۵۶۷٬۹۰۵٬۰۲۷ ریال به تومانِ
 * صحیح درنمی‌آید؛ تا پیش از این، نیمی از سندهای یک بکاپ ریالی وارد نمی‌شد.
 *
 * منطق دفتر به واحد کاری ندارد؛ واحد فقط در مرزها معنا دارد:
 * - گفتار و متن کاربر و خروجی AI همیشه به تومان خوانده می‌شود (مردم «۲ میلیون تومان»
 *   می‌گویند) و در مرز به واحد دفتر برده می‌شود: `tomanToLedger`.
 * - برچسب مبلغ در پیام‌ها و صفحه‌ها: `unitLabel()`.
 * - آستانه‌هایی که در کد به تومان نوشته شده‌اند: `tomanToLedger`.
 * - فایل‌های ورودی و خروجی (پارسیان، اکسل): `convertAmount` که فقط تبدیل دقیق را
 *   می‌پذیرد.
 *
 * واحد دفتر جاری را «resolver» می‌دهد: روی سرور از تنظیمات همان دفتری که درخواست
 * در آن اجرا می‌شود (AsyncLocalStorage)، در مرورگر از تنظیماتی که bootstrap آورده.
 * پیش‌فرض تومان است تا هر کدی که resolver ندارد رفتار قبلی را داشته باشد.
 */

export const AMOUNT_UNITS = Object.freeze({
  toman: Object.freeze({ id: 'toman', label: 'تومان', perToman: 1 }),
  rial: Object.freeze({ id: 'rial', label: 'ریال', perToman: 10 }),
});

export function normalizeAmountUnit(value) {
  return value === 'rial' ? 'rial' : 'toman';
}

let resolver = () => 'toman';

/** روی سرور: واحد دفترِ درخواست جاری. در مرورگر: واحدی که از سرور آمده. */
export function setAmountUnitResolver(next) {
  resolver = typeof next === 'function' ? next : () => 'toman';
}

export function currentAmountUnit() {
  try { return normalizeAmountUnit(resolver()); } catch { return 'toman'; }
}

/** «تومان» یا «ریال» برای پیام‌ها و برچسب‌ها. */
export function unitLabel(unit = currentAmountUnit()) {
  return AMOUNT_UNITS[normalizeAmountUnit(unit)].label;
}

/**
 * مبلغی که به تومان گفته یا نوشته شده (گفتار، AI، آستانهٔ کد) در واحد دفتر.
 * در دفتر تومانی همان عدد است؛ پس رفتار دفترهای موجود عوض نمی‌شود.
 */
export function tomanToLedger(amount, unit = currentAmountUnit()) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  return value * AMOUNT_UNITS[normalizeAmountUnit(unit)].perToman;
}

/** مبلغی به واحد دفتر، به تومان؛ فقط برای مقایسه با منطق گفتار (میانگین‌ها)، نه ذخیره. */
export function ledgerToToman(amount, unit = currentAmountUnit()) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  return value / AMOUNT_UNITS[normalizeAmountUnit(unit)].perToman;
}

/** میانگین مبلغ هر نوع (به واحد دفتر) برای قاعدهٔ «مبلغ غیرعادی» پارسر که به تومان می‌سنجد. */
export function averagesInToman(averages = {}, unit = currentAmountUnit()) {
  if (normalizeAmountUnit(unit) === 'toman') return averages;
  return Object.fromEntries(Object.entries(averages || {}).map(([key, value]) => [key, ledgerToToman(value, unit)]));
}

/**
 * نتیجهٔ پارسر (به تومان) در واحد دفتر. مبلغی که خود کاربر به ریال گفته
 * (`spokenRial`) در دفتر ریالی همان عدد دقیق می‌ماند، نه تومانِ گردشده ضرب در ده.
 */
export function parseResultInLedgerUnit(result, unit = currentAmountUnit()) {
  if (!result || normalizeAmountUnit(unit) === 'toman') return result;
  return {
    ...result,
    transactions: (result.transactions || []).map((item) => ({
      ...item,
      amount: Number.isSafeInteger(item.spokenRial) && normalizeAmountUnit(unit) === 'rial' ? item.spokenRial : tomanToLedger(item.amount, unit),
    })),
  };
}

// فیلدهای مبلغِ کارت‌های نیت (طلب و بدهی، چک، فاکتور، آورده، دارایی، انتقال، تنخواه، تسویه،
// ساخت حساب بانکی با موجودی اولیه).
const DRAFT_MONEY_FIELDS = Object.freeze(['amount', 'amountHint', 'rateAmount', 'perChequeAmount', 'fee', 'openingBalance']);

/**
 * کارت نیتی که از گفتار (به تومان) ساخته شده، در واحد دفتر. مبلغی که از خود دفتر
 * آمده (`amountInLedgerUnit`، مثلاً کسری سقف تنخواه) از پیش به واحد دفتر است.
 */
export function draftInLedgerUnit(draft, unit = currentAmountUnit()) {
  if (!draft || normalizeAmountUnit(unit) === 'toman') return draft;
  const next = { ...draft };
  for (const field of DRAFT_MONEY_FIELDS) {
    if (field === 'amount' && next.amountInLedgerUnit) continue;
    if (typeof next[field] === 'number') next[field] = tomanToLedger(next[field], unit);
  }
  if (Array.isArray(next.lines)) {
    next.lines = next.lines.map((line) => (typeof line?.unitPrice === 'number' ? { ...line, unitPrice: tomanToLedger(line.unitPrice, unit) } : line));
  }
  return next;
}

/**
 * تبدیل دقیق میان دو واحد؛ اگر نتیجه عدد صحیح نشود null برمی‌گرداند و هرگز گرد
 * نمی‌کند. ریال به تومان فقط وقتی دقیق است که مبلغ بر ۱۰ بخش‌پذیر باشد.
 */
export function convertAmount(amount, from, to) {
  const value = Number(amount);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  const source = AMOUNT_UNITS[normalizeAmountUnit(from)].perToman;
  const target = AMOUNT_UNITS[normalizeAmountUnit(to)].perToman;
  if (source === target) return value;
  if (target > source) return value * (target / source);
  const factor = source / target;
  return value % factor === 0 ? value / factor : null;
}
