import { normalizePersian } from './normalize.js';
import { extractDateMention } from './persianDate.js';
import { parseFinancialText } from './parser.js';

/**
 * تسویه و پرداخت سندهای موجود با صدا.
 *
 * تا امروز صدا فقط سند **می‌ساخت** و هیچ‌وقت سند موجود را تغییر نمی‌داد. برای
 * دفتری که روزانه ده‌ها چک و فاکتور را تسویه می‌کند، این یعنی نیمی از کار
 * روزانه بیرون از صدا می‌ماند.
 *
 * خطر این مسیر از ساختن بیشتر است: تسویهٔ سند اشتباه یعنی پول در جای اشتباه
 * جابه‌جا می‌شود و یک سند باز، بسته اعلام می‌شود. پس دو قاعده سخت‌گیرانه‌اند:
 *
 * ۱. **هیچ تطبیق حدسی.** اگر بیش از یک سند بخورد، هیچ‌کدام اجرا نمی‌شود و
 *    انتخاب با کاربر است.
 * ۲. **هر قیدِ گفته‌شده باید بخورد.** نام، شماره و مبلغ هر کدام که گفته شده
 *    باشند فیلتر می‌کنند؛ قید نادیده‌گرفته‌شده یعنی سند دیگری تسویه می‌شود.
 */

const SETTLE_PATTERNS = [
  /تسویه/, /تصفیه/, /(?<![آ-ی])پاس\s*(?:شد|شده|کرد|کردم|گردید)/,
  /وصول\s*(?:شد|شده|کردم|کردیم|گردید)/, /نقد\s*(?:شد|شده|کردم)/,
  /پرداخت\s*(?:شد|شده|کردم|کردیم|گردید)/, /صاف\s*(?:شد|کردم|کردیم)/,
  /(?:حساب|بدهی|طلب)\s*\S*\s*بسته\s*شد/, /خورد\s*به\s*حساب/,
];

// «برگشت خورد» تسویه نیست — سند باز می‌ماند و باید جدا رسیدگی شود.
const BOUNCE_PATTERNS = [/برگشت\s*(?:خورد|زد|شد)/, /بی\s*محل/, /کسر\s*موجودی/];

const INVOICE_HINTS = [/فاکتور/, /صورتحساب/, /صورت\s*حساب/];
const CHEQUE_HINTS = [/(?<![آ-ی])چک(?![آ-ی])/, /صیاد/];
const OBLIGATION_HINTS = [/طلب/, /بدهی/, /قرض/, /بدهکار/, /طلبکار/];

const TITLE_PREFIXES = ['آقای', 'اقای', 'خانم', 'جناب', 'مهندس', 'دکتر', 'حاج', 'حاجی', 'شرکت'];

const NAME_STOP_WORDS = new Set([
  'رو', 'را', 'به', 'از', 'با', 'برای', 'بابت', 'که', 'در', 'و',
  'تسویه', 'تصفیه', 'پاس', 'وصول', 'نقد', 'پرداخت', 'صاف', 'شد', 'شده', 'کن', 'کردم', 'کردیم',
  'فاکتور', 'صورتحساب', 'چک', 'طلب', 'بدهی', 'قرض', 'حساب', 'تومان', 'تومن', 'ریال',
  'یک', 'یه', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه', 'ده',
  'بیست', 'سی', 'صد', 'هزار', 'میلیون', 'میلیارد',
]);

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

/** شمارهٔ سند، هم به شکل کامل («FR-1405-0001») و هم «فاکتور شمارهٔ ۱۲». */
function extractDocumentNumber(text) {
  const full = text.match(/(?:^|\s)((?:FR|KH)-\d{3,4}-\d{1,6})(?:\s|$)/i);
  if (full) return full[1].toUpperCase();
  const numbered = text.match(/(?:شماره|شمارهٔ|شمارهٕ)\s*(\d{1,6})/);
  return numbered ? numbered[1] : '';
}

function extractName(text) {
  const words = text.split(' ').filter(Boolean);
  for (let index = 0; index < words.length; index += 1) {
    const prefix = TITLE_PREFIXES.find((title) => words[index] === title);
    if (!prefix) continue;
    const picked = [];
    for (let ahead = index + 1; ahead < words.length && picked.length < 2; ahead += 1) {
      const word = words[ahead];
      if (NAME_STOP_WORDS.has(word) || /\d/.test(word)) break;
      picked.push(word);
    }
    if (picked.length) return `${prefix === 'شرکت' ? 'شرکت ' : ''}${picked.join(' ')}`.trim();
  }
  // بدون عنوان: واژهٔ پیش از فعل تسویه، اگر واژهٔ دستوری نباشد.
  for (let index = 1; index < words.length; index += 1) {
    if (!/^(?:تسویه|پاس|وصول|پرداخت|صاف|نقد)$/.test(words[index])) continue;
    let back = index - 1;
    while (back >= 0 && NAME_STOP_WORDS.has(words[back])) back -= 1;
    if (back >= 0 && !/\d/.test(words[back]) && words[back].length > 1 && !NAME_STOP_WORDS.has(words[back])) return words[back];
  }
  return '';
}

/**
 * نیت تسویه را تشخیص می‌دهد. برگشت `null` یعنی این جمله تسویه نیست و باید به
 * مسیرهای دیگر برود.
 */
export function detectSettleIntent(input, { now = new Date() } = {}) {
  const text = normalizePersian(input);
  if (!text) return null;
  const mentionsDocument = matchesAny(text, [...INVOICE_HINTS, ...CHEQUE_HINTS, ...OBLIGATION_HINTS]);
  // برگشت چک پیش از فعل تسویه سنجیده می‌شود: «چک احمدی برگشت خورد» هیچ فعل
  // تسویه‌ای ندارد و بدون این بررسی بی‌صدا از مسیر بیرون می‌افتاد، درحالی‌که
  // دقیقاً همان چیزی است که کاربر باید دربارهٔ آن هشدار بگیرد.
  if (mentionsDocument && matchesAny(text, BOUNCE_PATTERNS)) {
    return { intent: 'settle', bounced: true, transcript: text };
  }
  if (!matchesAny(text, SETTLE_PATTERNS)) return null;
  const number = extractDocumentNumber(text);
  // شمارهٔ سند نباید مبلغ خوانده شود: «FR-1405-0002» مبلغ ۱۴۰۷ می‌ساخت و همان
  // قید، سند درست را از نتیجه حذف می‌کرد.
  const withoutNumber = number ? text.replace(new RegExp(number.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'), 'ig'), ' ') : text;
  const amount = parseFinancialText(withoutNumber, { source: 'voice' }).transactions[0]?.amount || 0;
  const kind = matchesAny(text, INVOICE_HINTS) ? 'invoice'
    : matchesAny(text, CHEQUE_HINTS) ? 'cheque'
      : matchesAny(text, OBLIGATION_HINTS) ? 'obligation' : 'any';
  return {
    intent: 'settle',
    kind,
    contactName: extractName(text),
    number,
    amount,
    occurredAt: extractDateMention(input, { now, preferPast: true })?.iso || null,
    transcript: text,
  };
}

function includesName(haystack, needle) {
  const left = normalizePersian(haystack);
  const right = normalizePersian(needle);
  if (!left || !right) return false;
  // نام چندبخشی باید همهٔ بخش‌هایش پیدا شود، وگرنه «پارس خودرو» با «پارس سیر»
  // هم می‌خورد و سند اشتباه تسویه می‌شود.
  return right.split(' ').filter(Boolean).every((part) => left.includes(part));
}

/**
 * سندهای باز را با قیدهای گفته‌شده فیلتر می‌کند.
 *
 * `invoices` سندهای باز (صادرشده و تسویه‌نشده) و `obligations` طلب/بدهی‌های باز.
 * خروجی همهٔ گزینه‌های سازگار است — انتخاب میان چند گزینه کار رابط و کاربر است،
 * نه این تابع.
 */
export function matchSettleTargets(intent = {}, { invoices = [], obligations = [] } = {}) {
  if (!intent || intent.intent !== 'settle' || intent.bounced) return [];
  const wantsInvoice = intent.kind === 'invoice' || intent.kind === 'any';
  const wantsObligation = ['obligation', 'cheque', 'any'].includes(intent.kind);

  const candidates = [];
  if (wantsInvoice) {
    for (const invoice of invoices) {
      if (['draft', 'cancelled', 'paid'].includes(invoice.status)) continue;
      candidates.push({
        kind: 'invoice', id: invoice.id, label: invoice.number,
        name: invoice.customerName || invoice.contactName || '',
        amount: Number(invoice.balanceDue ?? invoice.total ?? 0),
        number: invoice.number || '',
        documentType: invoice.documentType,
      });
    }
  }
  if (wantsObligation) {
    for (const obligation of obligations) {
      if (obligation.status && obligation.status !== 'open') continue;
      candidates.push({
        kind: 'obligation', id: obligation.id, label: obligation.title,
        name: obligation.contactName || obligation.title || '',
        amount: Number(obligation.amount || 0),
        number: '',
        direction: obligation.direction,
      });
    }
  }

  return candidates.filter((candidate) => {
    // چک فقط وقتی خواسته شده که خودِ عنوان چک باشد؛ «چک احمدی» نباید طلب عادی
    // احمدی را تسویه کند.
    if (intent.kind === 'cheque' && !/چک/.test(normalizePersian(candidate.label))) return false;
    if (intent.number && !normalizePersian(candidate.number).includes(normalizePersian(intent.number))) return false;
    if (intent.contactName && !includesName(`${candidate.name} ${candidate.label}`, intent.contactName)) return false;
    if (intent.amount && candidate.amount !== intent.amount) return false;
    return true;
  });
}
