import { normalizePersian } from './normalize.js';
import { extractAmounts } from './parser.js';
import { PERSIAN_MONTHS } from './persianDate.js';
import {
  DEPARTMENTS, EMPLOYMENT_TYPES, MARITAL, PERSONNEL_STEPS, normalizeIban, normalizeMobile, readPastDate, readPersonnelAnswer, validIban, validNationalId,
} from './personnel.js';

/**
 * تعریف سریع پرسنل بی صدا — یک خط یا چند خط، هر ترتیبی.
 *
 * «امیرحسین ترابی ۱۲۷۳۹۲۵۳۵۱ تولید تمام‌وقت ۱۸ میلیون ۰۹۱۲۳۴۵۶۷۸۹ متاهل ۲ بچه»
 *
 * هر تکه از **شکل خودش** شناخته می‌شود، نه از جایش: کد ملی ده رقم با رقم کنترل،
 * موبایل ۰۹ و یازده رقم، شبا IR و ۲۴ رقم، تاریخ با نام ماه یا ۱۴۰۲/۰۷/۰۱،
 * مبلغ فقط با «میلیون/هزار/تومان/ریال» یا پس از «حقوق/مزد»، فرزند با «بچه/فرزند».
 * تکه‌ای که شکلش دو معنا دارد حدس زده نمی‌شود: «نامشخص» می‌ماند تا کاربر بگوید
 * چیست (قاعدهٔ ۴ CLAUDE.md). نام نخستین تکهٔ حروفیِ باقی‌مانده است.
 *
 * چند خط یعنی چند نفر؛ اگر خط اول عنوان ستون‌ها باشد (اکسل)، هر ستون با عنوانش.
 */

const toLatin = (value) => String(value ?? '')
  .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
  .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
const clean = (value) => normalizePersian(toLatin(value)).replace(/‌/g, ' ').replace(/[ \t]+/g, ' ').trim();

const LABEL = (list) => Object.fromEntries(list.map((item) => [item.id, item.label]));
const LABELS = { department: LABEL(DEPARTMENTS), employmentType: LABEL(EMPLOYMENT_TYPES), marital: LABEL(MARITAL) };
const STEP_LABEL = Object.fromEntries(PERSONNEL_STEPS.map((step) => [step.id, step.label]));

const CUT = ' | ';
const MONTHS = PERSIAN_MONTHS.map(([name]) => name).sort((a, b) => b.length - a.length).join('|');
const DAY_WORD = '(?:\\d{1,2}|[آ-ی]+(?:\\s+و\\s+[آ-ی]+)?)';

// واژه‌های گزینه‌ای: فقط واژهٔ کامل، نه «حسابدار» یا «دفتر» که سمت هم می‌توانند باشند.
const CHOICES = [
  ['employmentType', 'part', /(?:^|\s)(?:پاره ?وقت|نیمه ?وقت|پارت ?تایم)(?=\s|$)/],
  ['employmentType', 'hourly', /(?:^|\s)(?:ساعتی|روزمزد)(?=\s|$)/],
  ['employmentType', 'full', /(?:^|\s)(?:تمام ?وقت|فول ?تایم)(?=\s|$)/],
  ['marital', 'single', /(?:^|\s)(?:مجرد|عزب)(?=\s|$)/],
  ['marital', 'married', /(?:^|\s)(?:متاهل|متأهل)(?=\s|$)/],
  ['department', 'production', /(?:^|\s)(?:بخش\s+)?(?:تولید|تولیدی)(?=\s|$)/],
  ['department', 'admin', /(?:^|\s)(?:بخش\s+)?(?:اداری)(?=\s|$)/],
  ['department', 'sales', /(?:^|\s)(?:بخش\s+)?(?:فروش)(?=\s|$)/],
];
const NUMBER_WORDS = { یک: 1, یه: 1, دو: 2, سه: 3, چهار: 4, پنج: 5, شش: 6, شیش: 6, هفت: 7, هشت: 8, نه: 9, ده: 10 };
// برچسب‌هایی که کنار مقدار می‌آیند و خودشان داده نیستند.
const FILLER = new Set(['کد', 'ملی', 'کدملی', 'موبایل', 'همراه', 'تلفن', 'شبا', 'شماره', 'حساب', 'حقوق', 'مزد', 'پایه', 'ماهانه', 'تاریخ', 'شروع', 'کار', 'استخدام',
  'از', 'و', 'با', 'به', 'تا', 'بخش', 'نوع', 'همکاری', 'وضعیت', 'تاهل', 'تعداد', 'فرزند', 'بچه', 'نام', 'اسم', 'خانوادگی', 'فامیل', 'بیمه', 'تومان', 'تومن', 'ریال', 'میلیون', 'هزار']);
const HONORIFIC = /^(?:آقای|اقای|آقا|اقا|خانم|خانوم|جناب|سرکار)\s+/;

/**
 * یک خط → `{ values, fields, unknown, issues }`.
 * `values.baseWage` خالی است و مزد در `wage` (`{ amount, unit }`، تومان یا ریال)
 * می‌آید؛ بردنش به واحد دفتر کار صفحه است، همان قاعدهٔ گفتار.
 */
export function parsePersonnelLine(input, { now = new Date() } = {}) {
  let text = ` ${clean(input).replace(/[\t;؛]+/g, CUT).replace(/[،,]/g, CUT)} `;
  const values = {};
  const issues = [];
  const unknown = [];
  let wage = null;
  const take = (pattern, handle) => {
    text = text.replace(pattern, (...match) => (handle(...match) === false ? match[0] : CUT));
  };

  // لقب: «…» یا «لقب X»
  take(/«([^»]{1,40})»/, (_m, nickname) => { values.nickname = nickname.trim(); });
  take(/(?:^|\s)(?:لقبش|لقب)\s*:?\s*([آ-ی]+(?:\s+[آ-ی]+)?)(?=\s*\||\s*$)/, (_m, nickname) => { values.nickname = nickname.trim(); });
  take(/(?:^|\s)(?:لقبش|لقب)\s*:?\s*([آ-ی]+)/, (_m, nickname) => { if (!values.nickname) values.nickname = nickname; });
  // سمت: «سمت X» تا جداکننده، وگرنه یک واژه.
  take(/(?:^|\s)(?:سمتش|سمت|شغلش|شغل)\s*:?\s*([^|\d]+?)(?=\s*\|)/, (_m, title) => { values.jobTitle = title.trim(); });
  take(/(?:^|\s)(?:سمتش|سمت|شغلش|شغل)\s*:?\s*([آ-ی]+)/, (_m, title) => { if (!values.jobTitle) values.jobTitle = title; });

  // شبا
  take(/(?:شبا\s*:?\s*)?\bIR\s*((?:\d[\s-]?){24})(?!\d)/i, (match, digits) => {
    const iban = normalizeIban(`IR${digits}`);
    if (iban && validIban(iban)) values.iban = iban;
    else issues.push({ field: 'iban', text: match.trim(), message: 'شبای معتبر نیست.' });
  });

  // تاریخ: «۱۴۰۲/۰۷/۰۱» یا «اول مهر ۱۴۰۲»
  take(/(?:از\s+)?(?<!\d)(1[34]\d{2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?!\d)/, (match) => {
    const parsed = readPastDate(match, { now });
    if (parsed && new Date(parsed.iso) <= new Date(now.getTime() + 12 * 3_600_000)) values.startDate = parsed.iso;
    else issues.push({ field: 'startDate', text: match.trim(), message: 'تاریخ شروع معتبر نیست یا در آینده است.' });
  });
  take(new RegExp(`(?:از\\s+)?(${DAY_WORD}\\s+(?:${MONTHS})(?:\\s+(?:ماه\\s+)?(?:\\d{2,4}|پارسال|امسال))?)(?=\\s|\\|)`), (match, phrase) => {
    const parsed = readPastDate(phrase, { now });
    if (!parsed) return false;
    if (new Date(parsed.iso) > new Date(now.getTime() + 12 * 3_600_000)) { issues.push({ field: 'startDate', text: phrase, message: 'تاریخ شروع در آینده است.' }); return undefined; }
    values.startDate = parsed.iso;
    return undefined;
  });

  // موبایل: ۰۹… یا +98 / 0098، با فاصله یا خط تیره.
  take(/(?<![\d])(?:\+?98|0098|0)?\s?9\d{2}[\s-]?\d{3}[\s-]?\d{4}(?!\d)/, (match) => {
    const mobile = normalizeMobile(match);
    if (!mobile) return false;
    values.mobile = mobile;
    return undefined;
  });

  // شمارهٔ بیمه فقط با برچسب؛ عدد بی‌برچسب بیمه حدس زده نمی‌شود.
  take(/(?:شماره\s+)?بیمه(?:ش)?\s*:?\s*(\d{6,12})(?!\d)/, (_m, digits) => { values.insuranceNumber = digits; });

  // کد ملی: ده رقم (با خط تیره یا بی آن).
  take(/(?<![\d])(?:کد\s*ملی(?:ش)?\s*:?\s*)?(\d{3}-?\d{6}-?\d)(?!\d)/, (match, raw) => {
    const digits = raw.replace(/\D/g, '');
    if (validNationalId(digits)) values.nationalId = digits;
    else issues.push({ field: 'nationalId', text: digits, message: `«${digits}» ده رقم است ولی کد ملی معتبری نیست.` });
  });

  // فرزند
  take(/(?:^|\s)(?:بدون\s+(?:بچه|فرزند)|(?:بچه|فرزند)\s+(?:نداره|ندارد|نداشته))(?=\s|\||$)/, () => { values.children = 0; });
  take(/(?:^|\s)(\d{1,2}|یک|یه|دو|سه|چهار|پنج|شش|شیش|هفت|هشت|نه|ده)\s*(?:تا\s*)?(?:بچه|فرزند|اولاد)(?:ش)?(?:\s+(?:داره|دارد))?(?=\s|\||$)/, (_m, count) => {
    values.children = /^\d+$/.test(count) ? Number(count) : NUMBER_WORDS[count];
  });

  // گزینه‌ها
  for (const [field, id, pattern] of CHOICES) {
    if (values[field]) continue;
    take(pattern, () => { values[field] = id; });
  }

  // مزد: فقط عددِ با مقیاس یا واحد، یا پس از «حقوق/مزد».
  // مختصات span روی متنِ نرمال‌شدهٔ خودِ extractAmounts است.
  // جداکنندهٔ «|» برای extractAmounts جداکننده نیست؛ «۱۸ میلیون | ۴۴۵۵۶۶» را یک عدد
  // می‌خواند. ویرگول فارسی هست، و پس از برش برمی‌گردد.
  const { text: amountText, spans } = extractAmounts(text.replace(/\|/g, '،'));
  for (const span of spans) {
    const after = amountText.slice(span.end, span.end + 8);
    const before = amountText.slice(Math.max(0, span.start - 14), span.start);
    const scaled = /میلیون|هزار/.test(span.raw) || /^\s*(?:میلیون|هزار|تومان|تومن|ریال)/.test(after);
    const labelled = /(?:حقوق|مزد|حقوقش|مزدش)(?:\s+(?:پایه|ماهانه))?\s*:?\s*$/.test(before);
    if (!scaled && !labelled) continue;
    // «۱۸ میلیون ۲۰ میلیون» دو مبلغ است که جمع خوانده می‌شود؛ جمعش مزد کسی نیست.
    if ((span.raw.match(/میلیون/g) || []).length > 1 || (span.raw.match(/هزار/g) || []).length > 1) {
      issues.push({ field: 'baseWage', text: span.raw, message: 'دو مبلغ پشت هم آمده؛ مزد کدام است؟' });
      break;
    }
    if (wage) { issues.push({ field: 'baseWage', text: span.raw, message: 'دو مبلغ در خط هست؛ مزد کدام است؟' }); break; }
    const unit = /^\s*(?:میلیون\s+|هزار\s+)?ریال/.test(after) ? 'rial' : 'toman';
    wage = { amount: span.amount, unit };
    text = `${amountText.slice(0, span.start).replace(/(?:حقوق|مزد|حقوقش|مزدش)(?:\s+(?:پایه|ماهانه))?\s*:?\s*$/, '')}${CUT}${amountText.slice(span.end).replace(/^\s*(?:میلیون|هزار)?\s*(?:تومان|تومن|ریال)?/, '')}`;
    break;
  }
  text = text.replace(/،/g, '|');

  // عدد باقی‌مانده: نامشخص، حدس زده نمی‌شود.
  take(/(?<!\d)\d[\d-]*\d?(?!\d)/g, (match) => { unknown.push(match); });

  // باقی‌ماندهٔ حروفی: اولین تکه نام است؛ بقیه نامشخص.
  const chunks = text.split('|').map((chunk) => chunk.split(/\s+/).filter((word) => word && !FILLER.has(word) && /[آ-یa-zA-Z]/.test(word)).join(' ').trim()).filter(Boolean);
  if (chunks.length) {
    const [first, ...rest] = chunks;
    const words = first.replace(HONORIFIC, '').split(' ');
    if (words.length <= 4) values.name = words.join(' ');
    else { values.name = words.slice(0, 2).join(' '); unknown.push(words.slice(2).join(' ')); issues.push({ field: 'name', text: first, message: 'نام از کجا تا کجاست؟ بررسی کن.' }); }
    unknown.push(...rest);
  }

  const fields = PERSONNEL_STEPS.filter((step) => (step.id === 'baseWage' ? wage : values[step.id] != null && values[step.id] !== ''))
    .map((step) => ({ id: step.id, label: STEP_LABEL[step.id], display: displayOf(step.id, step.id === 'baseWage' ? wage : values[step.id]) }));
  return { values, wage, fields, unknown: unknown.filter(Boolean), issues };
}

function displayOf(id, value) {
  if (id === 'baseWage') return `${value.amount.toLocaleString('en-US')} ${value.unit === 'rial' ? 'ریال' : 'تومان'}`;
  if (LABELS[id]) return LABELS[id][value];
  if (id === 'children') return value ? `${value} فرزند` : 'ندارد';
  if (id === 'startDate') {
    const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
    const part = (type) => parts.find((item) => item.type === type)?.value;
    return `${part('year')}/${part('month')}/${part('day')}`;
  }
  return String(value);
}

// ------------------------------------------------------------- چند خط و اکسل

const HEADERS = [
  ['nickname', /^لقب$/],
  ['nationalId', /^(?:کد ?ملی|شماره ملی)$/],
  ['name', /^(?:نام(?: و نام خانوادگی)?|اسم|نام کامل|نام و فامیل|اسم و فامیل)$/],
  ['startDate', /^(?:تاریخ شروع(?: کار| همکاری)?|تاریخ استخدام|شروع کار|تاریخ ورود)$/],
  ['jobTitle', /^(?:سمت|شغل|عنوان شغلی)$/],
  ['department', /^(?:بخش|واحد)$/],
  ['employmentType', /^(?:نوع همکاری|نوع قرارداد|نوع استخدام)$/],
  ['baseWage', /^(?:حقوق|مزد|حقوق پایه|مزد پایه|مزد ماهانه|حقوق ماهانه)(?:\s*\((?:تومان|ریال)\))?$/],
  ['marital', /^(?:تاهل|وضعیت تاهل|وضعیت تأهل)$/],
  ['children', /^(?:فرزند|تعداد فرزند|تعداد فرزندان|اولاد)$/],
  ['insuranceNumber', /^(?:بیمه|شماره بیمه)$/],
  ['mobile', /^(?:موبایل|تلفن همراه|همراه|شماره موبایل|تلفن)$/],
  ['iban', /^(?:شبا|شماره شبا|حساب شبا)$/],
];

function headerOf(cell) {
  const text = clean(cell).replace(/[:：]$/, '');
  return HEADERS.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

/** ستون‌های اکسل با عنوان: هر خانه با خوانندهٔ همان مرحله. */
function parseTableRow(cells, columns, { now, rialWage }) {
  const values = {};
  const issues = [];
  let wage = null;
  columns.forEach((field, index) => {
    const cell = String(cells[index] ?? '').trim();
    if (!field || !cell) return;
    if (field === 'baseWage') {
      const digits = toLatin(cell).replace(/[,٬\s]/g, '');
      if (/^\d+$/.test(digits)) { wage = { amount: Number(digits), unit: rialWage ? 'rial' : 'toman' }; return; }
    }
    const result = readPersonnelAnswer(field, cell, { now });
    if (result.skip) return;
    if (!result.ok) { issues.push({ field, text: cell, message: result.message }); return; }
    if (field === 'baseWage') wage = result.amountRial != null ? { amount: result.amountRial, unit: 'rial' } : { amount: result.amountToman, unit: 'toman' };
    else values[field] = result.value;
  });
  const fields = PERSONNEL_STEPS.filter((step) => (step.id === 'baseWage' ? wage : values[step.id] != null && values[step.id] !== ''))
    .map((step) => ({ id: step.id, label: STEP_LABEL[step.id], display: displayOf(step.id, step.id === 'baseWage' ? wage : values[step.id]) }));
  return { values, wage, fields, unknown: [], issues };
}

/**
 * چند خط → `{ rows, columns }`. هر ردیف همان خروجی `parsePersonnelLine` است
 * به‌اضافهٔ `line` (شمارهٔ خط). خط خالی نادیده گرفته می‌شود.
 */
export function parsePersonnelBlock(input, { now = new Date() } = {}) {
  const lines = String(input || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], columns: null };
  const delimiter = lines[0].includes('\t') ? '\t' : /[,،;]/.test(lines[0]) ? /[,،;]/ : null;
  const headerCells = delimiter ? lines[0].split(delimiter) : [];
  const columns = headerCells.map(headerOf);
  if (delimiter && columns.filter(Boolean).length >= 2) {
    const rialWage = headerCells.some((cell) => /ریال/.test(cell) && headerOf(cell) === 'baseWage');
    return {
      columns: columns.map((field, index) => ({ field, header: headerCells[index].trim() })),
      rows: lines.slice(1).map((line, index) => ({ line: index + 2, ...parseTableRow(line.split(delimiter), columns, { now, rialWage }) })),
    };
  }
  return { columns: null, rows: lines.map((line, index) => ({ line: index + 1, ...parsePersonnelLine(line, { now }) })) };
}
