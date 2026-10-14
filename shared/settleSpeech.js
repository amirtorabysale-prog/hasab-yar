import { normalizePersian } from './normalize.js';
import { readServicePeriod, runsPastMonth } from './periodSpeech.js';
import { isChequeEndorsement } from './voiceIntent.js';
import { extractOccurrenceDate } from './persianDate.js';
import { parseFinancialText } from './parser.js';
import { priorSettlementDirection, readsWholeContractRemainder } from './priorSettlement.js';

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

/**
 * فعل‌هایی که خودشان یعنی تسویه، حتی بدون نام بردن از سندی.
 *
 * «تسویه کردم» یعنی کاربر می‌خواهد سندی را ببندد، حتی اگر نگوید کدام؛ نشان
 * دادن فهرست سندهای باز همان چیزی است که می‌خواهد.
 */
const EXPLICIT_SETTLE_PATTERNS = [
  /تسویه/, /تصفیه/, /(?:حساب|بدهی|طلب)\s*\S*\s*بسته\s*شد/,
];

/**
 * فعل‌هایی که فقط در کنار نام یک سند یعنی تسویه.
 *
 * «پرداخت کردم» معمول‌ترین شکل بیان یک هزینهٔ ساده در فارسی است. شمردنش به
 * عنوان تسویه یعنی «دو میلیون بابت اجاره پرداخت کردم» به‌جای ثبت هزینه، برگهٔ
 * «کدام سند تسویه شود؟» را باز می‌کند — و چون سند بازی وجود ندارد، کاربر در
 * بن‌بست می‌ماند و باید جمله‌اش را دور بیندازد.
 *
 * قاعده: تسویه بدون سند بی‌معنی است. اگر هیچ سندی نام برده نشده و فعل هم
 * صریح نیست، این یک ثبت عادی است.
 */
const DOCUMENT_SETTLE_PATTERNS = [
  /(?<![آ-ی])پاس\s*(?:شد|شده|کرد|کردم|گردید)/,
  /وصول\s*(?:شد|شده|کردم|کردیم|گردید)/, /نقد\s*(?:شد|شده|کردم)/,
  /پرداخت\s*(?:شد|شده|کردم|کردیم|گردید)/, /صاف\s*(?:شد|کردم|کردیم)/,
  /خورد\s*به\s*حساب/,
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
  const settles = matchesAny(text, EXPLICIT_SETTLE_PATTERNS)
    || (mentionsDocument && matchesAny(text, DOCUMENT_SETTLE_PATTERNS))
    || Boolean(priorSettlementDirection(text));
  if (!settles) return null;
  // «تسویه» همیشه بستن یک سند باز نیست.
  //
  // «پونزده میلیون شارژ ساختمان رو برای شش ماه جلوتر تسویه کردم» یعنی پرداخت
  // کردم — پیش‌پرداخت شش‌ماهه، نه بستن بدهی. کارت تسویه اینجا سندی برای انتخاب
  // ندارد و رویداد درست هیچ‌وقت ساخته نمی‌شد.
  // فقط پوششی که از ماه پرداخت جلوتر می‌رود؛ «بدهی اجاره ماه قبل رو تسویه کردیم»
  // بستن همان بدهی است و کارت تسویه سندش را می‌پرسد. و «مابقی حق اشتراک یک ساله»
  // دورهٔ قرارداد موجود را نام می‌برد، نه دورهٔ تازه — وقتی کل جمله همان یک پرداخت است.
  if (!readsWholeContractRemainder(input) && runsPastMonth(readServicePeriod(input, { occurredAt: now.toISOString() }), now.toISOString())) return null;
  // چک ابزار تسویه است، نه نقد. «برای تسویهٔ طلب ما چک شخص ثالث واگذار کرد»
  // با کارت تسویه به‌صورت وصول نقدی بسته می‌شد؛ کارت چک همان را با پرسش
  // «بابت طلب قبلی؟» درست ثبت می‌کند. پشت‌نویسی چک مشتری هم هیچ‌کدام نیست.
  if (matchesAny(text, CHEQUE_HINTS) && (/واگذار\s*کرد|چک\s*دادن|داد\s*به\s*ما/.test(text) || isChequeEndorsement(input))) return null;
  const number = extractDocumentNumber(text);
  // شمارهٔ سند نباید مبلغ خوانده شود: «FR-1405-0002» مبلغ ۱۴۰۷ می‌ساخت و همان
  // قید، سند درست را از نتیجه حذف می‌کرد.
  const withoutNumber = number ? text.replace(new RegExp(number.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'), 'ig'), ' ') : text;
  const amount = parseFinancialText(withoutNumber, { source: 'voice' }).transactions[0]?.amount || 0;
  const kind = matchesAny(text, INVOICE_HINTS) ? 'invoice'
    : matchesAny(text, CHEQUE_HINTS) ? 'cheque'
      // «طلب قبلی» می‌تواند از فاکتور فروش یا از تعهد ثبت‌شده آمده باشد.
      // هر دو سندِ باز نشان داده می‌شوند و انتخاب با کاربر است.
      : 'any';
  return {
    intent: 'settle',
    kind,
    direction: priorSettlementDirection(text),
    contactName: extractName(text),
    number,
    amount,
    occurredAt: extractOccurrenceDate(input, { now, preferPast: true })?.iso || null,
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
/**
 * طلب یا بدهیِ دفتر کل که سند بازی ندارد — هدف تسویه، نقدی یا از پول شریک.
 *
 * خریدی که حسابدار از صف تأیید کرد، یا ماندهٔ افتتاحیه، مستقیم در دفتر کل
 * می‌نشیند؛ کارت حساب طرف آن را نشان می‌دهد ولی فهرست تعهدها و فاکتورها نه.
 * `uncoveredPayable` و `uncoveredReceivable` را سرور می‌سازد: ماندهٔ دفتر کل منهای
 * سندهای باز همان جهت. سرور هنگام ثبت دوباره همین سقف را می‌سنجد.
 */
export function ledgerBalanceTargets(intent = {}, { contacts = [] } = {}) {
  if (!intent || intent.intent !== 'settle' || intent.bounced) return [];
  if (!['any', 'obligation'].includes(intent.kind || 'any')) return [];
  const directions = intent.direction ? [intent.direction] : ['payable', 'receivable'];
  const targets = [];
  for (const contact of contacts) {
    if (intent.contactName && !includesName(contact.name, intent.contactName)) continue;
    for (const direction of directions) {
      const amount = Number(direction === 'payable' ? contact.uncoveredPayable : contact.uncoveredReceivable) || 0;
      if (amount <= 0 || (intent.amount && amount < intent.amount)) continue;
      targets.push({
        kind: 'ledger-balance', id: `${contact.id}:${direction}`, contactId: contact.id, direction, name: contact.name, number: '',
        label: direction === 'payable' ? `ماندهٔ بدهی به ${contact.name} در دفتر کل` : `ماندهٔ طلب از ${contact.name} در دفتر کل`,
        amount, paymentAmount: intent.amount || amount,
      });
    }
  }
  return targets;
}

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
      // تعهد تاریخیِ بدون سند اولیه با دریافت پول، خودکار به درآمد تبدیل نشود.
      if (obligation.journalStatus && obligation.journalStatus !== 'posted') continue;
      candidates.push({
        kind: 'obligation', id: obligation.id, label: obligation.title, contactId: obligation.contactId || null,
        name: obligation.contactName || obligation.title || '',
        amount: Number(obligation.remaining ?? obligation.amount ?? 0),
        number: '',
        direction: obligation.direction,
      });
    }
  }

  return candidates.filter((candidate) => {
    // چک فقط وقتی خواسته شده که خودِ عنوان چک باشد؛ «چک احمدی» نباید طلب عادی
    // احمدی را تسویه کند.
    if (intent.kind === 'cheque' && !/چک/.test(normalizePersian(candidate.label))) return false;
    if (intent.direction && candidate.direction && intent.direction !== candidate.direction) return false;
    if (intent.direction && candidate.kind === 'invoice'
      && (candidate.documentType === 'purchase' ? 'payable' : 'receivable') !== intent.direction) return false;
    if (intent.number && !normalizePersian(candidate.number).includes(normalizePersian(intent.number))) return false;
    if (intent.contactName && !includesName(`${candidate.name} ${candidate.label}`, intent.contactName)) return false;
    if (intent.amount && (candidate.amount < intent.amount || (intent.kind === 'cheque' && candidate.amount !== intent.amount))) return false;
    return true;
  }).map((candidate) => ({ ...candidate, paymentAmount: intent.amount || candidate.amount }));
}
