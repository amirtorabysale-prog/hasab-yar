import { normalizePersian } from './normalize.js';
import { extractAmounts, wordsToNumber } from './parser.js';
import { PERSIAN_MONTHS, normalizeSpokenYears, readJalaliExpression, todayPersian } from './persianDate.js';
import { jalaliToISO, monthLength, parseQuickDate } from './quickDate.js';

/**
 * تعریف پرسنل — مرحله‌ها، خواندن پاسخ هر مرحله (گفتار یا تایپ) و کنترل‌ها.
 *
 * یک جا برای هر سه مسیر: راهنمای صوتی، فرم دستی و سرور. هر مرحله یک واقعیت
 * می‌پرسد و پاسخ را فقط وقتی می‌پذیرد که معتبر باشد؛ کد ملی با رقم کنترل، شبا با
 * باقی‌ماندهٔ ۹۷، موبایل با پیش‌شمارهٔ ۰۹. چیزی که خوانده نشود حدس زده نمی‌شود:
 * همان مرحله باز می‌ماند و دلیلش گفته می‌شود (قاعدهٔ ۴ CLAUDE.md).
 */

export const DEPARTMENTS = Object.freeze([
  { id: 'production', label: 'تولید' },
  { id: 'admin', label: 'اداری' },
  { id: 'sales', label: 'فروش' },
]);
export const EMPLOYMENT_TYPES = Object.freeze([
  { id: 'full', label: 'تمام‌وقت' },
  { id: 'part', label: 'پاره‌وقت' },
  { id: 'hourly', label: 'ساعتی' },
]);
export const MARITAL = Object.freeze([
  { id: 'single', label: 'مجرد' },
  { id: 'married', label: 'متأهل' },
]);

/**
 * مرحله‌ها به ترتیب پرسیدن. `say` نمونهٔ گفتن است، روی صفحه زیر پرسش.
 * فقط نام اجباری است؛ بقیه را می‌شود «بعداً» گفت و پرونده «ناقص» می‌ماند.
 */
export const PERSONNEL_STEPS = Object.freeze([
  { id: 'name', label: 'نام و نام خانوادگی', kind: 'name', required: true, say: '«علی رضایی»' },
  { id: 'nationalId', label: 'کد ملی', kind: 'nationalId', say: '«۰۰۸۴۵۷۵۹۴۸» یا رقم‌به‌رقم' },
  { id: 'startDate', label: 'تاریخ شروع کار', kind: 'date', say: '«اول مهر ۱۴۰۲» یا «۱۴۰۲/۰۷/۰۱»' },
  { id: 'jobTitle', label: 'سمت', kind: 'text', say: '«انباردار»، «حسابدار»' },
  { id: 'department', label: 'بخش', kind: 'choice', options: DEPARTMENTS, say: '«تولید»، «اداری» یا «فروش»' },
  { id: 'employmentType', label: 'نوع همکاری', kind: 'choice', options: EMPLOYMENT_TYPES, say: '«تمام‌وقت»، «پاره‌وقت» یا «ساعتی»' },
  { id: 'baseWage', label: 'مزد پایه', kind: 'amount', say: '«۱۸ میلیون تومان»' },
  { id: 'marital', label: 'وضعیت تأهل', kind: 'choice', options: MARITAL, say: '«مجرد» یا «متأهل»' },
  { id: 'children', label: 'تعداد فرزند', kind: 'count', say: '«دو تا» یا «ندارد»' },
  { id: 'insuranceNumber', label: 'شمارهٔ بیمه', kind: 'insuranceNumber', say: '«۱۲۳۴۵۶۷۸۹۰»' },
  { id: 'mobile', label: 'موبایل', kind: 'mobile', say: '«۰۹۱۲ ۳۴۵ ۶۷۸۹»' },
  { id: 'iban', label: 'شمارهٔ شبا', kind: 'iban', say: '«IR» و ۲۴ رقم' },
]);

const toLatin = (value) => String(value ?? '')
  .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
  .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
const clean = (value) => normalizePersian(toLatin(value)).replace(/‌/g, ' ').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ کنترل‌ها

/** کد ملی ده‌رقمی با رقم کنترل؛ «۱۱۱۱۱۱۱۱۱۱» با اینکه رقم کنترلش جور است، کد ملی نیست. */
export function validNationalId(value) {
  const digits = toLatin(value).replace(/\D/g, '');
  if (!/^\d{10}$/.test(digits) || /^(\d)\1{9}$/.test(digits)) return false;
  const sum = [...digits.slice(0, 9)].reduce((total, digit, index) => total + Number(digit) * (10 - index), 0);
  const remainder = sum % 11;
  const check = Number(digits[9]);
  return remainder < 2 ? check === remainder : check === 11 - remainder;
}

/** شبا: «IR» و ۲۴ رقم، با باقی‌ماندهٔ ۹۷ برابر یک (ISO 13616). */
export function normalizeIban(value) {
  const compact = toLatin(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = compact.startsWith('IR') ? compact.slice(2) : compact;
  return /^\d{24}$/.test(body) ? `IR${body}` : null;
}
export function validIban(value) {
  const iban = normalizeIban(value);
  if (!iban) return false;
  const rearranged = `${iban.slice(4)}1827${iban.slice(2, 4)}`; // I=18، R=27
  return BigInt(rearranged) % 97n === 1n;
}

/** موبایل ایران به شکل ۰۹xxxxxxxxx؛ «+98»، «0098» و «9…» هم پذیرفته می‌شوند. */
export function normalizeMobile(value) {
  let digits = toLatin(value).replace(/\D/g, '');
  if (digits.startsWith('0098')) digits = digits.slice(4);
  else if (digits.startsWith('98') && digits.length === 12) digits = digits.slice(2);
  if (/^9\d{9}$/.test(digits)) digits = `0${digits}`;
  return /^09\d{9}$/.test(digits) ? digits : null;
}

// ------------------------------------------------------------- خواندن گفتار

const NUMBER_WORD = /^(?:صفر|یک|یه|دو|سه|چهار|پنج|شش|شیش|هفت|هشت|نه|ده|یازده|دوازده|سیزده|چهارده|پانزده|پونزده|شانزده|شونزده|هفده|هیفده|هجده|هیجده|نوزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود|صد|یکصد|دویست|سیصد|چهارصد|پانصد|پونصد|ششصد|شیشصد|هفتصد|هشتصد|نهصد)$/;

/**
 * رشتهٔ رقمی از گفتار: «صفر نهصد و دوازده سیصد و چهل و پنج …» → «0912345…».
 *
 * هر گروهِ واژه‌های عددی که با «و» به هم وصل‌اند یک عدد است؛ دو گروه پشت‌سرهم
 * بی «و» دو تکهٔ جدای رقم‌اند («نهصد و دوازده سیصد» = ۹۱۲ و ۳۰۰). رقم‌های نوشته
 * همان‌طور می‌مانند. هر واژهٔ غیرعددی (مثل «کدش») نادیده گرفته می‌شود.
 */
export function spokenDigits(input) {
  const tokens = clean(input).replace(/[-–_/.،,]/g, ' ').split(' ').filter(Boolean);
  let out = '';
  let group = [];
  const flush = () => {
    if (!group.length) return;
    while (group.at(-1) === 'و') group.pop();
    out += group.length === 1 && group[0] === 'صفر' ? '0' : String(wordsToNumber(group));
    group = [];
  };
  for (const token of tokens) {
    if (/^\d+$/.test(token)) { flush(); out += token; continue; }
    if (/^IR\d*$/i.test(token)) { flush(); out += `IR${token.slice(2)}`; continue; }
    if (token === 'و' && group.length) { group.push(token); continue; }
    if (NUMBER_WORD.test(token)) {
      // «صفر» همیشه یک رقم جداست؛ گروه قبلی با آن ادامه پیدا نمی‌کند.
      if (token === 'صفر' || (group.length && group.at(-1) !== 'و')) flush();
      group.push(token);
      if (token === 'صفر') flush();
      continue;
    }
    flush();
  }
  flush();
  return out;
}

// پیش‌گفتار و پس‌گفتار محاوره که جزو پاسخ نیست: «اسمش علی رضاییه هست»، «سمتش انباردار».
const LEAD_WORDS = ['اسم', 'نام', 'اسم و فامیل', 'اسم و فامیلی', 'نام و نام خانوادگی', 'سمت', 'شغل', 'عنوان', 'کد ملی', 'کدملی',
  'شماره', 'شماره بیمه', 'بیمه', 'موبایل', 'شماره موبایل', 'تلفن', 'شبا', 'شماره شبا', 'حقوق', 'مزد', 'حقوق پایه', 'مزد پایه',
  'تاریخ شروع', 'تعداد فرزند', 'تعداد بچه', 'بخش', 'نوع همکاری', 'وضعیت تاهل'].sort((a, b) => b.length - a.length);
const LEAD = new RegExp(`^(?:(?:خب|خوب|بله|آره|اره)\\s+)?(?:(?:${LEAD_WORDS.join('|')})(?:ش|اش|شون|ایشون)?\\s*(?:هم\\s+)?(?::|\\s)\\s*)+`);
const TAIL = /\s+(?:هست|است|هستش|می باشد|میباشد|می‌باشد|ـه|هستن|هستند)$/;
const HONORIFIC = /^(?:آقای|اقای|آقا|اقا|خانم|خانوم|جناب|سرکار)\s+/;

function stripSpeech(text) {
  let value = clean(text).replace(/[.!؟?،,]+$/g, '').trim();
  for (let round = 0; round < 2; round += 1) value = value.replace(LEAD, '').replace(TAIL, '').trim();
  return value;
}

const SKIP = /^(?:رد|رد کن|بعدا|بعداً|بعد|بگذر|بذر|نمیدونم|نمی دونم|نمی‌دونم|نمیدانم|ندارم|نداره|ندارد|نداریم|خالی|هیچی|فعلا نه|فعلاً نه)$/;
const BACK = /^(?:برگرد|قبلی|مرحله قبل|مرحله ی قبل|عقب)$/;

const CHOICE_WORDS = {
  department: [
    ['production', /تولید|کارگاه|کارگر|خط تولید|ساخت/],
    ['sales', /فروش|بازاریاب|ویزیتور|فروشنده/],
    ['admin', /اداری|دفتر|مالی|حسابدار|منشی|مدیریت|پشتیبانی/],
  ],
  employmentType: [
    ['part', /پاره ?وقت|نیمه ?وقت|پارت ?تایم/],
    ['hourly', /ساعتی|روزمزد|روز مزد/],
    ['full', /تمام ?وقت|فول ?تایم|دائم|دایم|کامل/],
  ],
  // نفی اول: «ازدواج نکرده» واژهٔ «کرده» را هم دارد.
  marital: [
    ['single', /مجرد|ازدواج نکرده|عزب/],
    ['married', /متاهل|متأهل|ازدواج کرده|زن دار|زندار|شوهر دار|عیال/],
  ],
};

// «چهارصد و دو» پس از نام ماه سالِ کوتاه‌گفته است (۱۴۰۲)؛ «هزار و» جلویش می‌آید
// تا همان خوانندهٔ سال گفتاریِ برنامه بخواندش.
const MONTH_NAMES = PERSIAN_MONTHS.map(([name]) => name).join('|');
const SHORT_SPOKEN_YEAR = new RegExp(`((?:${MONTH_NAMES})(?:\\s+(?:ماه|سال))?\\s+)(?=(?:سیصد|چهارصد)(?![آ-ی]))`, 'g');

/** تاریخ گذشته: «اول مهر ۱۴۰۲»، «دهم آبان پارسال»، «۱۴۰۲/۷/۱»، «پارسال اول مهر». */
export function readPastDate(input, { now = new Date() } = {}) {
  const text = normalizeSpokenYears(clean(input).replace(/^(?:از|از تاریخ|تاریخ|شروع|شروعش|شروع کار)\s+/, '').replace(SHORT_SPOKEN_YEAR, '$1هزار و '));
  if (!text) return null;
  const expression = readJalaliExpression(text);
  if (expression && expression.day) {
    const today = todayPersian(now);
    let year = expression.year || today.year + (expression.yearOffset ?? 0);
    if (!expression.year && expression.yearOffset == null) {
      // بی سال: آخرین باری که آن روز گذشته است.
      if (expression.month > today.month || (expression.month === today.month && expression.day > today.day)) year -= 1;
    }
    if (expression.day > monthLength(year, expression.month)) return null;
    const iso = jalaliToISO({ year, month: expression.month, day: expression.day });
    return iso ? { iso, year, month: expression.month, day: expression.day } : null;
  }
  return parseQuickDate(text, { now, direction: 'past' });
}

/** مبلغ گفته‌شده به تومان (یا ریال وقتی «ریال» گفته شد). */
function readAmount(text) {
  const { spans } = extractAmounts(text);
  const span = spans.find((item) => !item.bareScale);
  if (!span) return null;
  return { amount: span.amount, unit: /ریال/.test(text) ? 'rial' : 'toman' };
}

/**
 * پاسخ یک مرحله → `{ ok, value, display }`، یا `{ skip }` (بعداً)، یا `{ back }`
 * (مرحلهٔ قبل)، یا `{ ok: false, message }` که همان مرحله را باز نگه می‌دارد.
 *
 * مبلغ گفتاری به تومان برمی‌گردد (`amountToman` یا `amountRial`)؛ بردنش به واحد
 * دفتر کار لایهٔ صفحه است، همان قاعدهٔ بقیهٔ گفتار برنامه.
 */
export function readPersonnelAnswer(stepId, input, { now = new Date() } = {}) {
  const step = PERSONNEL_STEPS.find((item) => item.id === stepId);
  if (!step) return { ok: false, message: 'مرحلهٔ ناشناخته.' };
  const raw = clean(input);
  if (!raw) return { ok: false, message: 'چیزی شنیده نشد.' };
  const text = stripSpeech(raw);
  if (BACK.test(text)) return { back: true };
  if (step.kind === 'count' && (SKIP.test(text) || /^(?:بچه|فرزند)\s*(?:نداره|ندارد|ندارم|نداریم)$|^(?:هیچ|صفر)$/.test(text))) return { ok: true, value: 0, display: 'ندارد' };
  if (SKIP.test(text)) {
    return step.required ? { ok: false, message: `«${step.label}» لازم است و نمی‌شود بعداً گفت.` } : { skip: true };
  }

  switch (step.kind) {
    case 'name': {
      const name = text.replace(HONORIFIC, '').replace(/[^آ-یa-zA-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (name.length < 2) return { ok: false, message: 'نام شنیده نشد؛ نام و نام خانوادگی را بگو.' };
      if (name.split(' ').length > 5) return { ok: false, message: 'این یک نام نیست؛ فقط نام و نام خانوادگی را بگو.' };
      return { ok: true, value: name, display: name };
    }
    case 'text': {
      if (text.length < 2) return { ok: false, message: 'شنیده نشد؛ دوباره بگو.' };
      const value = text.slice(0, 80);
      return { ok: true, value, display: value };
    }
    case 'nationalId': {
      const digits = spokenDigits(text);
      if (digits.length !== 10) return { ok: false, message: `کد ملی ده رقم است؛ ${digits.length ? `${digits.length} رقم شنیدم (${digits})` : 'رقمی شنیده نشد'}.` };
      if (!validNationalId(digits)) return { ok: false, message: `«${digits}» کد ملی معتبری نیست (رقم کنترل جور نیست)؛ دوباره بگو.` };
      return { ok: true, value: digits, display: digits };
    }
    case 'insuranceNumber': {
      const digits = spokenDigits(text);
      if (digits.length < 6 || digits.length > 12) return { ok: false, message: `شمارهٔ بیمه ۶ تا ۱۲ رقم است؛ ${digits.length} رقم شنیدم.` };
      return { ok: true, value: digits, display: digits };
    }
    case 'mobile': {
      const mobile = normalizeMobile(spokenDigits(text));
      if (!mobile) return { ok: false, message: 'موبایل باید ۱۱ رقم و با ۰۹ شروع شود؛ دوباره بگو.' };
      return { ok: true, value: mobile, display: mobile };
    }
    case 'iban': {
      const iban = normalizeIban(spokenDigits(text));
      if (!iban) return { ok: false, message: 'شبا «IR» و ۲۴ رقم است؛ کامل بگو یا بنویس.' };
      if (!validIban(iban)) return { ok: false, message: `«${iban}» شبای معتبری نیست؛ یک رقم جابه‌جا شده.` };
      return { ok: true, value: iban, display: iban };
    }
    case 'date': {
      const parsed = readPastDate(text, { now });
      if (!parsed) return { ok: false, message: 'تاریخ خوانده نشد؛ مثلاً «اول مهر ۱۴۰۲» بگو.' };
      // امروز پذیرفته است؛ فقط روزِ بعد از امروز آینده است.
      if (new Date(parsed.iso).getTime() - now.getTime() > 12 * 3_600_000) return { ok: false, message: 'تاریخ شروع کار در آینده است؛ دوباره بگو.' };
      return { ok: true, value: parsed.iso, display: `${parsed.year}/${String(parsed.month).padStart(2, '0')}/${String(parsed.day).padStart(2, '0')}` };
    }
    case 'choice': {
      const hit = (CHOICE_WORDS[step.id] || []).find(([, pattern]) => pattern.test(text));
      if (!hit) return { ok: false, message: `یکی از این‌ها را بگو: ${step.options.map((option) => `«${option.label}»`).join('، ')}.` };
      return { ok: true, value: hit[0], display: step.options.find((option) => option.id === hit[0]).label };
    }
    case 'count': {
      const digits = toLatin(text).match(/\d+/)?.[0];
      const words = text.split(' ').filter((token) => NUMBER_WORD.test(token) || token === 'و');
      const count = digits != null ? Number(digits) : words.length ? wordsToNumber(words) : null;
      if (count == null || !Number.isInteger(count) || count < 0 || count > 20) return { ok: false, message: 'تعداد فرزند را بگو؛ مثلاً «دو تا» یا «ندارد».' };
      return { ok: true, value: count, display: count ? `${count}` : 'ندارد' };
    }
    case 'amount': {
      const amount = readAmount(text);
      if (!amount || !(amount.amount > 0)) return { ok: false, message: 'مبلغ شنیده نشد؛ مثلاً «۱۸ میلیون تومان».' };
      return amount.unit === 'rial'
        ? { ok: true, amountRial: amount.amount, display: `${amount.amount.toLocaleString('en-US')} ریال` }
        : { ok: true, amountToman: amount.amount, display: `${amount.amount.toLocaleString('en-US')} تومان` };
    }
    default:
      return { ok: false, message: 'مرحلهٔ ناشناخته.' };
  }
}

// ---------------------------------------------------------------- پرونده

const OPTIONAL_STEPS = PERSONNEL_STEPS.filter((step) => !step.required).map((step) => step.id);

/** درصد کامل‌بودن پرونده (۰ تا ۱۰۰) و فهرست چیزهایی که هنوز گفته نشده. */
export function personnelCompleteness(values = {}) {
  const missing = PERSONNEL_STEPS.filter((step) => {
    const value = values[step.id];
    if (step.id === 'children') return value == null || value === '';
    return value == null || value === '' || value === 0;
  });
  return {
    percent: Math.round(((PERSONNEL_STEPS.length - missing.length) / PERSONNEL_STEPS.length) * 100),
    missing: missing.map((step) => step.label),
    optional: OPTIONAL_STEPS,
  };
}

/**
 * کنترل پرونده پیش از ذخیره؛ همان قاعده‌های مرحله‌ها برای ورود دستی و API.
 * `{ value, errors }` — خطا یعنی ذخیره نمی‌شود، نه اصلاح بی‌صدا.
 */
export function validatePersonnel(values = {}) {
  const errors = [];
  const text = (key, max = 80) => clean(values[key]).slice(0, max);
  const name = text('name', 100).replace(HONORIFIC, '');
  if (name.length < 2) errors.push({ field: 'name', message: 'نام و نام خانوادگی لازم است.' });
  const nationalId = toLatin(values.nationalId).replace(/\D/g, '');
  if (nationalId && !validNationalId(nationalId)) errors.push({ field: 'nationalId', message: 'کد ملی معتبر نیست.' });
  const insuranceNumber = toLatin(values.insuranceNumber).replace(/\D/g, '');
  if (insuranceNumber && (insuranceNumber.length < 6 || insuranceNumber.length > 12)) errors.push({ field: 'insuranceNumber', message: 'شمارهٔ بیمه ۶ تا ۱۲ رقم است.' });
  const mobileRaw = clean(values.mobile);
  const mobile = mobileRaw ? normalizeMobile(mobileRaw) : '';
  if (mobileRaw && !mobile) errors.push({ field: 'mobile', message: 'موبایل معتبر نیست.' });
  const ibanRaw = clean(values.iban);
  const iban = ibanRaw ? normalizeIban(ibanRaw) : '';
  if (ibanRaw && !(iban && validIban(iban))) errors.push({ field: 'iban', message: 'شمارهٔ شبا معتبر نیست.' });
  const pick = (key, list) => {
    const value = String(values[key] || '');
    if (value && !list.some((option) => option.id === value)) errors.push({ field: key, message: 'گزینهٔ نامعتبر.' });
    return list.some((option) => option.id === value) ? value : '';
  };
  const department = pick('department', DEPARTMENTS);
  const employmentType = pick('employmentType', EMPLOYMENT_TYPES);
  const marital = pick('marital', MARITAL);
  let startDate = '';
  if (values.startDate) {
    const date = new Date(values.startDate);
    if (Number.isNaN(date.getTime())) errors.push({ field: 'startDate', message: 'تاریخ شروع کار معتبر نیست.' });
    else startDate = date.toISOString();
  }
  const baseWage = values.baseWage === '' || values.baseWage == null ? 0 : Number(toLatin(values.baseWage).toString().replace(/[,٬\s]/g, ''));
  if (!Number.isSafeInteger(baseWage) || baseWage < 0) errors.push({ field: 'baseWage', message: 'مزد پایه باید عدد صحیح مثبت باشد.' });
  const children = values.children === '' || values.children == null ? null : Number(toLatin(values.children));
  if (children != null && (!Number.isInteger(children) || children < 0 || children > 20)) errors.push({ field: 'children', message: 'تعداد فرزند معتبر نیست.' });
  return {
    errors,
    value: {
      name, nationalId, startDate, jobTitle: text('jobTitle'), department, employmentType,
      baseWage: Number.isSafeInteger(baseWage) && baseWage > 0 ? baseWage : 0, marital, children,
      insuranceNumber, mobile: mobile || '', iban: iban || '', note: clean(values.note).slice(0, 300),
    },
  };
}
