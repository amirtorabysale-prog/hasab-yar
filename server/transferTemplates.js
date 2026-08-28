// قالب ستونی خروجی انتقال — فاز پل دوطرفهٔ اکسل و پارسیان.
//
// حساب‌یار قالب رسمی هیچ نسخه‌ای از پارسیان را نمی‌داند و ادعای دانستنش را هم
// نمی‌کند. راه درست این است که خود دفتر حسابداری یک بار بگوید «فایل ورودی
// نرم‌افزار من این ستون‌ها را با این نام و این ترتیب می‌خواهد»، و حساب‌یار
// دقیقاً همان را بسازد. این ماژول همان قرارداد است.

const AMOUNT_UNITS = Object.freeze({
  toman: Object.freeze({ id: 'toman', label: 'تومان', multiplier: 1 }),
  rial: Object.freeze({ id: 'rial', label: 'ریال', multiplier: 10 }),
});

function templateError(message, code = 'TRANSFER_TEMPLATE_INVALID', status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function normalizeAmountUnit(value) {
  return Object.hasOwn(AMOUNT_UNITS, value) ? value : 'toman';
}

export function amountUnitLabel(value) {
  return AMOUNT_UNITS[normalizeAmountUnit(value)].label;
}

/**
 * فهرست فیلدهایی که یک ستون خروجی می‌تواند حمل کند.
 * `amount` یعنی مقدار بر اساس واحد قالب ضرب می‌شود؛ بقیه متن‌اند.
 */
export const TRANSFER_FIELDS = Object.freeze([
  Object.freeze({ id: 'entryId', label: 'شناسه سند حساب‌یار', kind: 'text' }),
  Object.freeze({ id: 'lineNumber', label: 'ردیف سند', kind: 'text' }),
  Object.freeze({ id: 'period', label: 'دوره شمسی', kind: 'text' }),
  Object.freeze({ id: 'dateJalali', label: 'تاریخ شمسی', kind: 'text' }),
  Object.freeze({ id: 'dateIso', label: 'تاریخ میلادی', kind: 'text' }),
  Object.freeze({ id: 'entryKind', label: 'نوع سند', kind: 'text' }),
  Object.freeze({ id: 'sourceType', label: 'نوع منبع', kind: 'text' }),
  Object.freeze({ id: 'sourceId', label: 'شناسه منبع', kind: 'text' }),
  Object.freeze({ id: 'memo', label: 'شرح سند', kind: 'text' }),
  Object.freeze({ id: 'lineDescription', label: 'شرح ردیف', kind: 'text' }),
  Object.freeze({ id: 'accountCode', label: 'کد حساب حساب‌یار', kind: 'text' }),
  Object.freeze({ id: 'accountName', label: 'نام حساب حساب‌یار', kind: 'text' }),
  Object.freeze({ id: 'chartCode', label: 'کد کامل کدینگ', kind: 'text' }),
  Object.freeze({ id: 'chartName', label: 'نام معین کدینگ', kind: 'text' }),
  // پارسیان حساب را سه عدد جدا می‌خواهد، نه یک کد یکجا.
  Object.freeze({ id: 'kolCode', label: 'کد کل', kind: 'text' }),
  Object.freeze({ id: 'kolName', label: 'نام کل', kind: 'text' }),
  Object.freeze({ id: 'moeenCode', label: 'کد معین', kind: 'text' }),
  Object.freeze({ id: 'moeenName', label: 'نام معین', kind: 'text' }),
  Object.freeze({ id: 'tafsiliCode', label: 'کد تفصیلی (پارسیان)', kind: 'text' }),
  Object.freeze({ id: 'tafsiliName', label: 'نام تفصیلی (پارسیان)', kind: 'text' }),
  // کدی که اپراتور پارسیان روی صفحه می‌بیند: تفصیلی-معین-کل، برعکسِ ترتیب
  // معمول کدینگ. برخاسته از VW_HCode در خود پارسیان.
  Object.freeze({ id: 'parsianHCode', label: 'کد حساب پارسیان (تفصیلی-معین-کل)', kind: 'text' }),
  Object.freeze({ id: 'analyticCode', label: 'کد تفصیلی', kind: 'text' }),
  Object.freeze({ id: 'analyticName', label: 'نام تفصیلی', kind: 'text' }),
  Object.freeze({ id: 'costCenterCode', label: 'کد مرکز هزینه', kind: 'text' }),
  Object.freeze({ id: 'costCenterName', label: 'نام مرکز هزینه', kind: 'text' }),
  Object.freeze({ id: 'targetCode', label: 'کد حساب مقصد', kind: 'text' }),
  Object.freeze({ id: 'targetName', label: 'نام حساب مقصد', kind: 'text' }),
  Object.freeze({ id: 'debit', label: 'بدهکار (واحد قالب)', kind: 'amount' }),
  Object.freeze({ id: 'credit', label: 'بستانکار (واحد قالب)', kind: 'amount' }),
  Object.freeze({ id: 'debitToman', label: 'بدهکار تومان', kind: 'amount', unit: 'toman' }),
  Object.freeze({ id: 'creditToman', label: 'بستانکار تومان', kind: 'amount', unit: 'toman' }),
  Object.freeze({ id: 'debitRial', label: 'بدهکار ریال', kind: 'amount', unit: 'rial' }),
  Object.freeze({ id: 'creditRial', label: 'بستانکار ریال', kind: 'amount', unit: 'rial' }),
]);

const FIELD_BY_ID = new Map(TRANSFER_FIELDS.map((item) => [item.id, item]));

// قالب پیش‌فرض: همان چیدمان کامل و بی‌ادعای «Generic Ledger CSV v1» که تا
// امروز ساخته می‌شد، تا دفترهای فعلی چیزی از دست ندهند.
export const DEFAULT_TRANSFER_COLUMNS = Object.freeze([
  'entryId', 'lineNumber', 'period', 'dateJalali', 'dateIso', 'entryKind', 'sourceType', 'sourceId',
  'memo', 'lineDescription', 'accountCode', 'accountName', 'chartCode', 'chartName',
  'analyticCode', 'analyticName', 'costCenterCode', 'costCenterName',
  'debitToman', 'creditToman', 'debitRial', 'creditRial', 'targetCode', 'targetName',
].map((field) => Object.freeze({ field, header: FIELD_BY_ID.get(field).label })));

/**
 * ستون‌های تعریف‌شدهٔ کاربر را می‌سنجد و پاک‌سازی می‌کند.
 * قالبی که ستون مبلغ ندارد پذیرفته نمی‌شود؛ فایل بدون بدهکار و بستانکار
 * برای هیچ نرم‌افزار حسابداری قابل ورود نیست.
 */
export function normalizeTransferColumns(columns = []) {
  const list = Array.isArray(columns) ? columns : [];
  if (!list.length) return { columns: [...DEFAULT_TRANSFER_COLUMNS], errors: [] };
  if (list.length > 40) throw templateError('قالب خروجی حداکثر ۴۰ ستون می‌پذیرد.');

  const errors = [];
  const seenHeaders = new Set();
  const normalized = [];
  list.forEach((item, index) => {
    const position = index + 1;
    const field = String(item?.field || '').trim();
    if (!FIELD_BY_ID.has(field)) { errors.push({ position, message: `فیلد «${field || '—'}» در ستون ${position} شناخته نشد.` }); return; }
    const header = String(item?.header || FIELD_BY_ID.get(field).label).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!header) { errors.push({ position, message: `عنوان ستون ${position} خالی است.` }); return; }
    const key = header.toLowerCase();
    if (seenHeaders.has(key)) { errors.push({ position, message: `عنوان ستون «${header}» تکراری است؛ نرم‌افزار مقصد نمی‌داند کدام را بخواند.` }); return; }
    seenHeaders.add(key);
    normalized.push({ field, header });
  });

  if (errors.length) throw Object.assign(templateError('قالب ستونی ایراد دارد.', 'TRANSFER_TEMPLATE_ROWS_INVALID'), { details: { errors } });
  const hasDebit = normalized.some((item) => ['debit', 'debitToman', 'debitRial'].includes(item.field));
  const hasCredit = normalized.some((item) => ['credit', 'creditToman', 'creditRial'].includes(item.field));
  if (!hasDebit || !hasCredit) throw templateError('قالب باید هم ستون بدهکار داشته باشد و هم ستون بستانکار.', 'TRANSFER_TEMPLATE_NO_AMOUNT');
  const hasAccount = normalized.some((item) => ['accountCode', 'chartCode', 'targetCode', 'moeenCode', 'kolCode'].includes(item.field));
  if (!hasAccount) throw templateError('قالب باید حداقل یک ستون کد حساب داشته باشد (کد حساب‌یار، کد معین کدینگ یا کد مقصد).', 'TRANSFER_TEMPLATE_NO_ACCOUNT');
  return { columns: normalized, errors: [] };
}

/**
 * کد حسابی که اپراتور پارسیان می‌بیند و می‌شناسد.
 *
 * پارسیان در VW_HCode آن را این‌طور می‌سازد:
 *   cast(TafsiliCode) + '-' + cast(MoeenCode) + '-' + cast(KolCode)
 * و برای معینی که تفصیلی ندارد تفصیلی را صفر می‌گذارد. یعنی ترتیب برعکس
 * کدینگ است و صندوق «۰-۱-۱۰» دیده می‌شود، نه «۱۰۰۱».
 *
 * بدون کل و معین کدی وجود ندارد؛ در آن حالت رشتهٔ خالی برمی‌گردد تا ستون
 * ناقص، عدد نادرست به نرم‌افزار مقصد ندهد.
 */
export function parsianHCode({ kolCode = '', moeenCode = '', tafsiliCode = '' } = {}) {
  const segment = (value) => String(value ?? '').trim();
  const kol = segment(kolCode);
  const moeen = segment(moeenCode);
  if (!kol || !moeen) return '';
  return `${segment(tafsiliCode) || '0'}-${moeen}-${kol}`;
}

function amountFor(field, row, unit) {
  const toman = Number((field.startsWith('debit') ? row.debit : row.credit) || 0);
  const multiplier = field === 'debit' || field === 'credit'
    ? AMOUNT_UNITS[normalizeAmountUnit(unit)].multiplier
    : AMOUNT_UNITS[FIELD_BY_ID.get(field).unit].multiplier;
  return toman * multiplier;
}

/**
 * ردیف‌های دفتر کل را طبق قالب به جدول خروجی تبدیل می‌کند.
 * خروجی: { headers, rows, totals } — منطق خالص و بدون فایل.
 */
export function applyTransferTemplate({ columns = DEFAULT_TRANSFER_COLUMNS, amountUnit = 'toman', journalRows = [], period = '', mappings = [], persianDate = () => '' } = {}) {
  const mappingByAccount = new Map(mappings.map((item) => [item.ledgerAccountId, item]));
  const lineNumbers = new Map();
  const unit = normalizeAmountUnit(amountUnit);

  const rows = journalRows.map((item) => {
    const lineNumber = (lineNumbers.get(item.entryId) || 0) + 1;
    lineNumbers.set(item.entryId, lineNumber);
    const mapping = mappingByAccount.get(item.accountId) || {};
    const source = {
      entryId: item.entryId, lineNumber, period,
      dateJalali: persianDate(item.occurredAt), dateIso: item.occurredAt,
      entryKind: item.entryKind, sourceType: item.sourceType, sourceId: item.sourceId,
      memo: item.memo || '', lineDescription: item.lineDescription || '',
      accountCode: item.accountCode || '', accountName: item.accountName || '',
      chartCode: item.chartCode || '', chartName: item.chartName || '',
      kolCode: item.kolCode || '', kolName: item.kolName || '',
      moeenCode: item.moeenCode || '', moeenName: item.moeenName || '',
      tafsiliCode: item.tafsiliCode || '', tafsiliName: item.tafsiliName || '',
      parsianHCode: parsianHCode(item),
      analyticCode: item.analyticCode || '', analyticName: item.analyticName || '',
      costCenterCode: item.costCenterCode || '', costCenterName: item.costCenterName || '',
      targetCode: mapping.targetCode || '', targetName: mapping.targetName || '',
    };
    return columns.map(({ field }) => (
      FIELD_BY_ID.get(field).kind === 'amount' ? amountFor(field, item, unit) : source[field] ?? ''
    ));
  });

  const totals = { debit: 0, credit: 0 };
  for (const item of journalRows) { totals.debit += Number(item.debit || 0); totals.credit += Number(item.credit || 0); }
  return {
    headers: columns.map((item) => item.header),
    rows,
    amountUnit: unit,
    amountUnitLabel: amountUnitLabel(unit),
    totals: {
      debitToman: totals.debit, creditToman: totals.credit,
      debit: totals.debit * AMOUNT_UNITS[unit].multiplier,
      credit: totals.credit * AMOUNT_UNITS[unit].multiplier,
    },
  };
}
