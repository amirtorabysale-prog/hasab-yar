import { normalizePersian } from './normalize.js';
import { extractDateMention } from './persianDate.js';
import { parseFinancialText } from './parser.js';

/**
 * نیت گفته را تشخیص می‌دهد.
 *
 * تا امروز صدا فقط دو کار می‌کرد: ثبت تراکنش و اصلاح آخرین ثبت. هر چیز دیگری —
 * بدهکار، طلبکار، چک، فاکتور — باید دستی در فرم وارد می‌شد. برای دفتری که
 * روزانه ده‌ها قلم دارد این یعنی صدا عملاً بی‌مصرف است.
 *
 * تشخیص عمداً قطعی و محلی است: هزینهٔ صفر، تأخیر صفر، و مهم‌تر از همه
 * قابل‌آزمون. هیچ نیتی بدون تأیید صریح کاربر اجرا نمی‌شود.
 */

// «بدهکاره» و «بدهکارم» جهت مخالف دارند: اولی طلب ماست، دومی بدهی ما.
// اشتباه‌گرفتنشان یعنی طلب به‌عنوان بدهی وارد دفتر می‌شود.
const RECEIVABLE_PATTERNS = [
  /بدهکار(?:ه|است|هست|شد|ند)/, /طلب\s*دار(?:م|یم)/, /از\s*\S+\s*طلب/, /باید\s*به\s*(?:ما|من)\s*بده/,
];
const PAYABLE_PATTERNS = [
  /بدهکار(?:م|یم)/, /طلبکار(?:ه|است|هست|ند)/, /بدهی\s*دار(?:م|یم)/, /باید\s*(?:بهش|به\s*\S+)\s*بدم/,
];

// `\b` با حروف فارسی کار نمی‌کند — برای جاوااسکریپت حرف فارسی «word» نیست، پس
// `\bچک\b` هیچ‌وقت تطبیق نمی‌خورد. مرز واژه باید با lookaround ساخته شود.
const CHEQUE_PATTERNS = [/(?<![آ-ی])چک(?![آ-ی])/, /(?<![آ-ی])چکی(?![آ-ی])/, /صیاد/];
const INVOICE_SALES_PATTERNS = [/فاکتور\s*فروش/, /فاکتور\s*زدم\s*برای/, /پیش\s*فاکتور\s*فروش/];
const INVOICE_PURCHASE_PATTERNS = [/فاکتور\s*خرید/, /فاکتور\s*خریدم/];

const CONTACT_STOP_WORDS = new Set([
  'آقای', 'اقای', 'خانم', 'جناب', 'شرکت', 'مهندس', 'دکتر', 'حاج', 'حاجی', 'سرکار',
  'از', 'به', 'برای', 'بابت', 'با', 'رو', 'را', 'که', 'و', 'در', 'تا', 'یک', 'یه',
  'بدهکاره', 'بدهکارم', 'طلبکاره', 'طلبکارم', 'چک', 'فاکتور', 'فروش', 'خرید', 'تومان', 'تومن', 'ریال',
  'سررسید', 'سر', 'رسید', 'دادم', 'گرفتم', 'دارم', 'داره', 'هست', 'است', 'شد', 'میشه', 'بشه',
]);

// واژه‌های عددی نباید بخشی از نام شوند: «آقای احمدی سه میلیون» نام را
// «احمدی سه» می‌ساخت.
const NUMBER_WORDS = new Set(['صفر', 'یک', 'یه', 'دو', 'سه', 'چهار', 'چار', 'پنج', 'شش', 'شیش', 'هفت', 'هشت', 'نه',
  'ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'پونزده', 'شانزده', 'هفده', 'هجده', 'نوزده',
  'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود', 'صد', 'دویست', 'سیصد', 'چهارصد',
  'پانصد', 'پونصد', 'ششصد', 'هفتصد', 'هفصد', 'هشتصد', 'هشصد', 'نهصد', 'هزار', 'میلیون', 'میلیارد', 'نیم']);

const TITLE_PREFIXES = ['آقای', 'اقای', 'خانم', 'جناب', 'مهندس', 'دکتر', 'حاج', 'حاجی', 'سرکار خانم', 'شرکت'];

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * نام طرف حساب را از جمله بیرون می‌کشد.
 *
 * پس از یک عنوان («آقای»، «شرکت») تا دو واژه برداشته می‌شود. بدون عنوان،
 * حدس‌زدن نام از میان واژه‌های عادی خطای بیشتری می‌سازد تا فایده — پس نامی
 * برنمی‌گردد و کاربر خودش می‌نویسد.
 */
export function extractContactName(input) {
  const words = normalizePersian(input).split(' ').filter(Boolean);
  for (let index = 0; index < words.length; index += 1) {
    const prefix = TITLE_PREFIXES.find((title) => {
      const parts = title.split(' ');
      return parts.every((part, offset) => words[index + offset] === part);
    });
    if (!prefix) continue;
    const skip = prefix.split(' ').length;
    const picked = [];
    for (let offset = index + skip; offset < words.length && picked.length < 2; offset += 1) {
      const word = words[offset];
      if (CONTACT_STOP_WORDS.has(word) || NUMBER_WORDS.has(word) || /\d/.test(word)) break;
      picked.push(word);
    }
    if (picked.length) return `${prefix === 'شرکت' ? 'شرکت ' : ''}${picked.join(' ')}`.trim();
  }
  return '';
}

function firstAmount(input) {
  const parsed = parseFinancialText(input, { source: 'voice' });
  return parsed.transactions[0]?.amount || 0;
}

/**
 * سررسید همیشه آینده است، پس ترجیح گذشته خاموش می‌شود؛ وگرنه «سررسید دهم مهر»
 * در شهریور روی مهرِ سال گذشته می‌نشست و چکِ آینده تاریخ‌گذشته ثبت می‌شد.
 */
function dueDate(input, now) {
  const found = extractDateMention(input, { now, preferPast: false });
  return found?.iso || null;
}

export function detectVoiceIntent(input, { now = new Date() } = {}) {
  const text = normalizePersian(input);
  if (!text) return null;

  const amount = firstAmount(input);
  const contactName = extractContactName(input);
  const isCheque = matchesAny(text, CHEQUE_PATTERNS);

  if (matchesAny(text, INVOICE_PURCHASE_PATTERNS) || matchesAny(text, INVOICE_SALES_PATTERNS)) {
    if (!amount) return null;
    const documentType = matchesAny(text, INVOICE_PURCHASE_PATTERNS) ? 'purchase' : 'sales';
    return {
      intent: 'invoice',
      documentType,
      amount,
      contactName,
      title: documentType === 'purchase' ? 'خرید' : 'فروش',
      occurredAt: extractDateMention(input, { now, preferPast: true })?.iso || null,
      transcript: text,
    };
  }

  // جهت پیش از چک سنجیده می‌شود: «چک پنج میلیون از آقای احمدی گرفتم» طلب است
  // و «چک دادم» بدهی؛ خودِ واژهٔ چک جهت نمی‌سازد.
  // فعل معمولاً از «چک» فاصله دارد («چک پنج میلیون دادم»)، پس چسبیدگی شرط
  // نیست؛ وجود فعل جهت‌دار در همان جمله کافی است.
  const receivable = matchesAny(text, RECEIVABLE_PATTERNS)
    || (isCheque && /(?:گرفتم|گرفتیم|دریافت\s*کردم|داد\s*به\s*(?:من|ما)|دادن\s*به\s*(?:من|ما))/.test(text));
  const payable = matchesAny(text, PAYABLE_PATTERNS)
    || (isCheque && /(?:دادم|دادیم|نوشتم|کشیدم|صادر\s*کردم)/.test(text));
  if (!receivable && !payable) return null;
  if (!amount) return null;

  // هر دو نشانه یعنی جمله واقعاً مبهم است؛ اجرا نمی‌شود تا کاربر روشنش کند.
  const direction = receivable && payable ? null : receivable ? 'receivable' : 'payable';
  return {
    intent: isCheque ? 'cheque' : 'obligation',
    direction,
    ambiguous: !direction,
    amount,
    contactName,
    dueAt: dueDate(input, now),
    title: [isCheque ? 'چک' : '', contactName].filter(Boolean).join(' ') || (isCheque ? 'چک' : 'طلب/بدهی'),
    transcript: text,
  };
}

/**
 * پیش‌نویس فاکتور از نیت گفته.
 *
 * فاکتور واقعی ردیف کالا، تعداد، نرخ و مالیات می‌خواهد و هیچ‌کدام از یک جملهٔ
 * گفتاری درنمی‌آید. پس صدا فقط یک پیش‌نویس با یک ردیف به کل مبلغ گفته‌شده
 * می‌سازد و سند در وضعیت `draft` می‌ماند: نه در دفتر کل سند می‌خورد، نه انبار را
 * تکان می‌دهد، نه در گزارش مالیاتی و نه در جمع طلب/بدهی می‌آید. تکمیل ردیف‌ها و
 * نرخ مالیات در برگهٔ فاکتورها انجام می‌شود و صدور، آگاهانه و دستی است.
 *
 * تاریخ گفته‌شده عمداً روی سند نمی‌نشیند؛ تاریخ فاکتور هنگام صدور تعیین می‌شود و
 * نشاندن تاریخِ حرف روی پیش‌نویسِ ناتمام فقط یک عدد بی‌پشتوانه می‌ساخت.
 */
export function invoiceDraftPayload(intent = {}) {
  const documentType = intent.documentType === 'purchase' ? 'purchase' : 'sales';
  const amount = Math.round(Number(intent.amount) || 0);
  if (!amount || amount <= 0) return null;
  return {
    documentType,
    customerName: intent.contactName || '',
    note: String(intent.transcript || '').slice(0, 300),
    issueNow: false,
    items: [{
      title: documentType === 'purchase' ? 'ردیف خرید — از گفتهٔ صوتی' : 'ردیف فروش — از گفتهٔ صوتی',
      quantity: 1,
      unitPrice: amount,
    }],
  };
}
