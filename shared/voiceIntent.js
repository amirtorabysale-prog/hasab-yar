import { normalizePersian } from './normalize.js';
import { priorSettlementDirection } from './priorSettlement.js';
import {
  CONTACT_STOP_WORDS, DIRECTION_WORDS, NUMBER_WORDS, TITLE_PREFIXES, extractContactName,
} from './counterpartySpeech.js';

// همان‌جایی که تعریف شده مصرف می‌شود؛ بازصادر می‌شود تا مصرف‌کننده‌های قدیمی
// نشکنند و دو نسخه از یک منطق ساخته نشود.
export { extractContactName };
import { CAPITAL_PATTERNS, FIXED_ASSET_PATTERNS } from './capitalSpeech.js';
import { extractDateMention } from './persianDate.js';
import { parseFinancialText } from './parser.js';
import { detectTaxMention, parseInvoiceLines, wantsImmediateIssue } from './invoiceSpeech.js';
import { EVENT_KINDS, normalizeFinancialEvent } from './financialEvent.js';
import { EVENT_NATURES, readEventNature } from './eventNature.js';

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
// «بدهکار شد» و «بدهکار شدم» یک حرف نیستند: اولی طرف مقابل بدهکار شده (طلب ما)
// و دومی خودِ ما. فاصله بین «بدهکار» و فعل باید پذیرفته شود — گفتار محاوره‌ای
// تقریباً همیشه فاصله دارد — ولی صیغهٔ اول‌شخص باید از طلب بیرون بماند، وگرنه
// «بدهکار شدم» طلب ثبت می‌شد.
const RECEIVABLE_PATTERNS = [
  /بدهکار\s*(?:ه|است|هست(?:ند)?|شد(?!\s*(?:م|یم))|شده(?!\s*(?:ام|ایم))|ند)/,
  /طلب\s*دار(?:م|یم)/, /طلبم\s*شد/, /باید\s*به\s*(?:ما|من)\s*بده/,
  // «از X طلبکار شدیم» یعنی X به ما بدهکار است. نام شرکتی چندبخشی است
  // («شرکت آراد گستر آسیا»)، پس فاصلهٔ «از» تا «طلب» نباید یک واژه باشد.
  /از\s*(?:\S+\s+){0,4}طلب/,
  // اول‌شخص: خودِ ما طلبکاریم، پس طرف مقابل بدهکار است.
  /طلبکار\s*(?:شد|شده|هست)(?:م|یم)(?![آ-ی])/, /طلبکار(?:م|یم)(?![آ-ی])/,
  /قرض\s*داد(?:م|یم)/,
];
const PAYABLE_PATTERNS = [
  /بدهکار(?:م|یم)(?![آ-ی])/, /بدهکار\s*شد(?:م|یم)/, /بدهکار\s*هست(?:م|یم)/,
  // سوم‌شخص: طرف مقابل طلبکار است، یعنی ما بدهکاریم. صیغهٔ اول‌شخص باید بیرون
  // بماند، وگرنه «طلبکار هستم» بدهی ثبت می‌شد — یعنی طلب وارونه وارد دفتر.
  /طلبکار\s*(?:ه|است|هست(?!\s*(?:م|یم))|ند|شد(?!\s*(?:م|یم))|شده(?!\s*(?:ام|ایم)))/,
  /بدهی\s*دار(?:م|یم)/, /بدهیم\s*شد/,
  /باید\s*(?:بهش|به\s*\S+)\s*بدم/, /قرض\s*گرفت(?:م|یم)/,
  // «طلبکارش کنین» — دستور به ما: او را طلبکار کن، یعنی بدهی ما.
  /طلبکار(?:ش|شون)\s*(?:کن|کنین|کنید|بکن)/,
];

// `\b` با حروف فارسی کار نمی‌کند — برای جاوااسکریپت حرف فارسی «word» نیست، پس
// `\bچک\b` هیچ‌وقت تطبیق نمی‌خورد. مرز واژه باید با lookaround ساخته شود.
const CHEQUE_PATTERNS = [/(?<![آ-ی])چک(?![آ-ی])/, /(?<![آ-ی])چکی(?![آ-ی])/, /صیاد/];
// «فاکتور فروشنده» فاکتوری است که فروشنده به ما داده، نه فاکتور فروش ما.
const INVOICE_SALES_PATTERNS = [/فاکتور\s*فروش(?!نده)/, /فاکتور\s*زدم\s*برای/, /پیش\s*فاکتور\s*فروش(?!نده)/];
const INVOICE_PURCHASE_PATTERNS = [/فاکتور\s*خرید/, /فاکتور\s*خریدم/];


// واژه‌هایی که کنار نشانهٔ دارایی می‌آیند و نام دارایی نیستند.
const ASSET_STOP_WORDS = new Set(['خریدم', 'خریدیم', 'گرفتم', 'گرفتیم', 'ثبت', 'کن', 'بزن', 'به', 'عنوان',
  'یک', 'بابت', 'برای', 'با', 'از', 'در', 'و', 'را', 'رو', 'شد', 'است', 'هست', 'دارایی', 'ثابت', 'اموال', 'تجهیزات']);

// فعل و حرف اضافه هرگز نام طرف حساب نیستند؛ رد می‌شوند تا نام پشتشان پیدا شود.
const CURRENCY_WORDS = new Set(['تومان', 'تومن', 'ریال', 'هزارتومان', 'میلیونی']);

const FILLER_WORDS = new Set(['شد', 'شده', 'شدم', 'شدیم', 'شدند', 'شدن', 'هست', 'هستم', 'هستیم', 'هستند',
  'است', 'میشه', 'بشه', 'دارم', 'داریم', 'داره', 'دارند', 'دادم', 'دادیم', 'گرفتم', 'گرفتیم', 'بده', 'بدم',
  'به', 'از', 'برای', 'با', 'رو', 'را']);

/**
 * نام دارایی را از کنار نشانهٔ صریح برمی‌دارد.
 * «لپ‌تاپ به عنوان دارایی ثابت خریدم» → «لپ تاپ»، «دارایی ثابت کولر گازی» →
 * «کولر گازی». چیزی پیدا نشد یعنی کاربر باید خودش بنویسد؛ حساب دارایی بدون نام،
 * ردیفی است که شش ماه بعد هیچ‌کس نمی‌داند چیست.
 */
export function extractAssetTitle(input) {
  const text = normalizePersian(input);
  const marker = text.match(/(?:به\s*عنوان\s*)?(?:دارایی\s*ثابت|اموال\s*و\s*تجهیزات)/);
  if (!marker) return '';
  const pick = (words) => {
    const picked = [];
    for (const word of words) {
      if (CONTACT_STOP_WORDS.has(word) || NUMBER_WORDS.has(word) || ASSET_STOP_WORDS.has(word) || /\d/.test(word)) break;
      picked.push(word);
      if (picked.length === 2) break;
    }
    return picked;
  };
  const before = text.slice(0, marker.index).split(' ').filter(Boolean).reverse();
  const beforePick = pick(before).reverse();
  if (beforePick.length) return beforePick.join(' ');
  const after = text.slice(marker.index + marker[0].length).split(' ').filter(Boolean);
  return pick(after).join(' ');
}

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

/**
 * مبلغ گفته‌شده در یک جملهٔ نیت‌دار.
 *
 * بزرگ‌ترین عدد برداشته می‌شود، نه اولی: «یک دستگاه پراید ... چهارصد میلیون» و
 * «دو تا چک پنج میلیونی» با اولین عدد به مبلغ ۱ و ۲ ثبت می‌شدند، چون واژهٔ
 * شمارش هم برای پارسر یک عدد است. در این جمله‌ها عدد شمارش همیشه کوچک و بی‌مقیاس
 * است و مبلغ همان عددی است که مقیاس (هزار، میلیون) را با خود دارد.
 */
function spokenAmount(input) {
  const parsed = parseFinancialText(input, { source: 'voice' });
  return parsed.transactions.reduce((largest, item) => Math.max(largest, Number(item.amount) || 0), 0);
}

/**
 * چند مبلغ مستقل در یک جمله — مبلغ سند از خودِ جمله درنمی‌آید.
 *
 * «جمع فاکتور هشتاد میلیون شد، پنج میلیون تخفیف دادیم، مانده رو چک دادن» چکِ
 * هفتاد و پنج میلیونی است؛ ولی بزرگ‌ترین عدد، هشتاد، روی کارت می‌نشست و با یک
 * «تأیید» چک هشتاد میلیونی ثبت می‌شد. وقتی جمله بیش از یک مبلغ دارد، مبلغ
 * پرسیده می‌شود.
 */
function hasSeveralAmounts(input) {
  // از پارسر، نه از استخراج خام: تاریخ («۱۵/۳/۱۴۰۵») و واحدهای زمان آنجا
  // کنار گذاشته شده‌اند و مبلغ حساب نمی‌شوند.
  const amounts = parseFinancialText(input, { source: 'voice' }).transactions
    .filter((item) => !item.amountScaleAmbiguous && Number(item.amount) >= 1_000)
    .map((item) => Number(item.amount));
  return new Set(amounts).size > 1;
}

// پرداختِ انجام‌شده، نه صدور فاکتور. «سی میلیون به حساب کاظمی زدیم ولی نمیدونم
// فاکتور خریدش قبلاً ثبت شده» دربارهٔ پولی است که رفته؛ پیش‌نویس فاکتور خرید
// برایش ساختن یعنی یک خرید دوم.
const PAYMENT_DONE = /(?:زدیم|زدم|ریختیم|ریختم|واریز\s*کرد(?:یم|م)|پرداخت\s*کرد(?:یم|م)|دادیم|دادم)(?![آ-ی])/;

/**
 * چکِ طرف سوم که ما خرجش کردیم — پشت‌نویسی.
 *
 * نه چک صادرهٔ ماست و نه دریافتی تازه: چک دریافتنی از دفتر بیرون می‌رود و بدهی
 * طرف مقابل بسته می‌شود. کارت چک یا کارت تسویه هیچ‌کدام این شکل را ندارند و
 * هرکدام سند غلطی می‌زدند (نقد یا چک پرداختنی)؛ پس به حسابدار می‌رود.
 */
export function isChequeEndorsement(input) {
  const text = normalizePersian(input);
  if (!/(?<![آ-ی])چک/.test(text)) return false;
  if (/خرج\s*کرد|پشت\s*نویس/.test(text)) return true;
  return /چک\s*(?:\S+\s*){0,2}(?:مشتری|شخص\s*ثالث)/.test(text) && /(?:دادیم|دادم|واگذار\s*کردیم)(?![آ-ی])/.test(text);
}

/**
 * سررسید همیشه آینده است، پس ترجیح گذشته خاموش می‌شود؛ وگرنه «سررسید دهم مهر»
 * در شهریور روی مهرِ سال گذشته می‌نشست و چکِ آینده تاریخ‌گذشته ثبت می‌شد.
 */
/**
 * دو تاریخِ متفاوت در یک جمله.
 *
 * «در تاریخ ۱۵/۵/۱۴۰۵ به شرکت آزاد بدهکار شدیم» تاریخِ **بدهکارشدن** است، نه
 * سررسید. نشاندن آن روی سررسید یعنی سندی که همین امروز بدهکار شده، سررسیدش در
 * گذشته نشان داده می‌شود و در فهرست عقب‌افتاده‌ها می‌نشیند — گزارشی که کاملاً
 * غلط است.
 *
 * پس نقش هر تاریخ از واژهٔ معرفی‌کننده‌اش فهمیده می‌شود، نه از جایش در جمله.
 */
const DUE_MARKERS = /(?:سررسید|سر\s*رسید|مهلت|تا\s*تاریخ|موعد|تسویه\s*تا|پرداخت\s*تا)/;
const OCCURRED_MARKERS = /(?:در\s*تاریخ|مورخ|تاریخِ?)/;

function dateAfter(text, marker, now, preferPast) {
  const match = text.match(marker);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const found = extractDateMention(rest, { now, preferPast });
  return found?.iso || null;
}

/**
 * برمی‌گرداند { occurredAt, dueAt }.
 *
 * وقتی هیچ واژهٔ معرفی‌کننده‌ای نیست، تاریخِ تنها برای چک سررسید است — چک اصلاً
 * دربارهٔ سررسید است — و برای طلب و بدهی عادی، تاریخ رویداد. این پیش‌فرض
 * محافظه‌کارانه است: سررسیدِ خالی فقط یعنی «نمی‌دانیم»، ولی سررسیدِ غلط سند را
 * در فهرست عقب‌افتاده می‌نشاند.
 */
export function splitDateRoles(input, { now, isCheque = false } = {}) {
  const text = normalizePersian(input);
  const dueAt = dateAfter(text, DUE_MARKERS, now, false);
  const occurredAt = dateAfter(text, OCCURRED_MARKERS, now, true);
  if (dueAt || occurredAt) return { occurredAt, dueAt };

  // چک اصلاً دربارهٔ سررسید است، پس تاریخِ تنها در جملهٔ چک سررسید است.
  if (isCheque) {
    const cheque = extractDateMention(input, { now, preferPast: false });
    return { occurredAt: null, dueAt: cheque?.iso || null };
  }
  // برای طلب و بدهی، خودِ تاریخ نقشش را می‌گوید: کسی در آینده بدهکار نمی‌شود،
  // پس تاریخ آینده فقط می‌تواند سررسید باشد و تاریخ گذشته فقط رویداد.
  const forward = extractDateMention(input, { now, preferPast: false });
  if (forward && new Date(forward.iso).getTime() > now.getTime()) return { occurredAt: null, dueAt: forward.iso };
  const lone = extractDateMention(input, { now, preferPast: true });
  return { occurredAt: lone?.iso || null, dueAt: null };
}

/**
 * تشخیص نیت گفته.
 *
 * `context` می‌گوید کاربر کجا ایستاده. در مسیر عمومی («امروز چه اتفاقی افتاد؟»)
 * هیچ فرضی دربارهٔ موضوع نمی‌شود. روی صفحهٔ طلب و بدهی، موضوع از قبل روشن است و
 * دو چیز عوض می‌شود: نام بدون عنوان هم پذیرفته می‌شود، و جملهٔ بدون مبلغ رد
 * نمی‌شود — «حسن بدهکار شد» یک ثبت ناقص است، نه یک جملهٔ بی‌معنا؛ فرم با نام و
 * جهت پر می‌شود و مبلغ را کاربر می‌نویسد.
 */
export function detectVoiceIntent(input, { now = new Date(), context = '' } = {}) {
  const text = normalizePersian(input);
  if (!text) return null;
  // دریافتِ طلبِ قبلی نباید کارت «ساخت طلب» را باز کند.
  if (priorSettlementDirection(input)) return null;
  const obligationContext = context === 'obligation';

  // اصلاح، برگشت، تغییر برآورد و مانندشان رویداد تازه نیستند. «فاکتور خرید
  // دیروز اشتباهاً بیست و یک میلیون ثبت شده بود» پیش‌نویس فاکتور تازه می‌ساخت؛
  // این جمله‌ها از مسیر موتور تصمیم به حسابدار می‌روند.
  if (readEventNature(input) !== EVENT_NATURES.NEW) return null;
  if (isChequeEndorsement(input)) return null;
  // کاربر خودش گفته نمی‌داند، یا چک ضمانت است. کارت ساختاری فقط بین دو گزینهٔ
  // از پیش تعیین‌شده می‌پرساند و هیچ‌کدام درست نیست؛ این‌ها به حسابدار می‌روند.
  if (/نمی\s*دونم|نمیدونم|نمی\s*دانم|معلوم\s*نیس|مشخص\s*نیس|مطمئن\s*نیستم/.test(text)) return null;
  if (/ضمانت|تضمین|وثیقه|نه\s*تاریخ\s*داره|در\s*وجه\s*کسی|دستت\s*باشه/.test(text)) return null;

  const amount = spokenAmount(input);
  const contactName = extractContactName(input, { allowBare: obligationContext });
  // «دسته چک جدید رو تحویل گرفتیم… کارمزدش کم شد» دربارهٔ کارمزد بانک است، نه
  // یک چک؛ کارت چک برایش سؤال «بابت فروش تازه یا طلب قبلی؟» می‌پرسید.
  const isCheque = matchesAny(text, CHEQUE_PATTERNS) && !/دسته\s*چک/.test(text);

  if ((matchesAny(text, INVOICE_PURCHASE_PATTERNS) || matchesAny(text, INVOICE_SALES_PATTERNS)) && !PAYMENT_DONE.test(text)) {
    if (!amount) return null;
    const documentType = matchesAny(text, INVOICE_PURCHASE_PATTERNS) ? 'purchase' : 'sales';
    return {
      intent: 'invoice',
      documentType,
      amount,
      contactName,
      title: documentType === 'purchase' ? 'خرید' : 'فروش',
      occurredAt: extractDateMention(input, { now, preferPast: true })?.iso || null,
      // ردیف‌ها فقط وقتی ساخته می‌شوند که جمله نرخ واحد را صریح گفته باشد؛
      // وگرنه آرایه خالی می‌ماند و رابط همان ردیف تک‌خطی قبلی را می‌سازد.
      lines: parseInvoiceLines(input),
      tax: detectTaxMention(input),
      issueNow: wantsImmediateIssue(input),
      transcript: text,
    };
  }

  // آورده یعنی پول تازه از مالک. جابه‌جایی درون حقوق صاحبان سهام — جاری شرکا یا
  // سود انباشته به سرمایه — پولی جابه‌جا نمی‌کند؛ کارت آورده صندوق را بدهکار
  // می‌کرد و پولی که نیامده بود در بانک می‌نشست.
  if (matchesAny(text, CAPITAL_PATTERNS) && !/جاری\s*شرکا|مطالبات|سود\s*انباشته|اندوخته|منتقل\s*شد|انتقال\s*(?:به|یافت)/.test(text)) {
    if (!amount) return null;
    return {
      intent: 'capital',
      amount,
      title: 'آورده و افزایش سرمایه',
      accountId: 'cash',
      occurredAt: extractDateMention(input, { now, preferPast: true })?.iso || null,
      transcript: text,
    };
  }

  if (!isCheque && matchesAny(text, FIXED_ASSET_PATTERNS)) {
    if (!amount) return null;
    return {
      intent: 'fixed-asset',
      amount,
      title: extractAssetTitle(input),
      accountId: 'cash',
      occurredAt: extractDateMention(input, { now, preferPast: true })?.iso || null,
      transcript: text,
    };
  }

  // جهت پیش از چک سنجیده می‌شود: «چک پنج میلیون از آقای احمدی گرفتم» طلب است
  // و «چک دادم» بدهی؛ خودِ واژهٔ چک جهت نمی‌سازد.
  // فعل معمولاً از «چک» فاصله دارد («چک پنج میلیون دادم»)، پس چسبیدگی شرط
  // نیست؛ وجود فعل جهت‌دار در همان جمله کافی است.
  const directionText = isCheque ? text.replace(/تخفیف(?:\s+تجاری)?\s+داد(?:یم|م)/g, '') : text;
  const receivable = matchesAny(directionText, RECEIVABLE_PATTERNS)
    || (isCheque && /(?:گرفتم|گرفتیم|دریافت\s*کردم|داد\s*به\s*(?:من|ما)|دادن\s*به\s*(?:من|ما)|به\s*(?:ما|من)\s*واگذار\s*کرد|چک\s*(?:\d+\s*روزه\s*)?دادن(?![آ-ی]))/.test(text));
  const payable = matchesAny(directionText, PAYABLE_PATTERNS)
    || (isCheque && /(?:دادم|دادیم|نوشتم|کشیدم|صادر\s*کردم)/.test(directionText));
  if (!receivable && !payable) return null;
  if (!amount && !obligationContext) return null;

  // هر دو نشانه یعنی جمله واقعاً مبهم است؛ اجرا نمی‌شود تا کاربر روشنش کند.
  const direction = receivable && payable ? null : receivable ? 'receivable' : 'payable';
  const severalAmounts = hasSeveralAmounts(input);
  return {
    intent: isCheque ? 'cheque' : 'obligation',
    direction,
    ambiguous: !direction,
    amount: severalAmounts ? 0 : amount,
    // مبلغ خالی یعنی «هنوز گفته نشده»، نه صفر؛ کارت تأیید تا نوشتنش پیش نمی‌رود.
    needsAmount: !amount || severalAmounts,
    ...(severalAmounts ? { amountHint: amount } : {}),
    contactName,
    ...splitDateRoles(input, { now, isCheque }),
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
export function invoiceDraftPayload(intent = {}, { taxRateId = null } = {}) {
  const documentType = intent.documentType === 'purchase' ? 'purchase' : 'sales';
  const spoken = Array.isArray(intent.lines) ? intent.lines : [];
  // ردیف‌های گفته‌شده بر مبلغ کل مقدم‌اند: کاربر خودش تعداد و نرخ واحد را گفته،
  // پس جمعشان همان چیزی است که خواسته.
  const items = spoken.length
    ? spoken.map((line) => ({
      title: String(line.title || '').slice(0, 120),
      quantity: Math.max(0.01, Number(line.quantity) || 1),
      unitPrice: Math.round(Number(line.unitPrice) || 0),
      ...(taxRateId ? { taxRateId } : {}),
    })).filter((line) => line.title && line.unitPrice > 0)
    : [];
  if (!items.length) {
    const amount = Math.round(Number(intent.amount) || 0);
    if (!amount || amount <= 0) return null;
    items.push({
      title: documentType === 'purchase' ? 'ردیف خرید — از گفتهٔ صوتی' : 'ردیف فروش — از گفتهٔ صوتی',
      quantity: 1,
      unitPrice: amount,
      ...(taxRateId ? { taxRateId } : {}),
    });
  }
  return {
    documentType,
    customerName: intent.contactName || '',
    note: String(intent.transcript || '').slice(0, 300),
    // صدور فقط وقتی که کاربر صریح خواسته باشد و روی کارت تأیید هم بماند.
    issueNow: intent.issueNow === true,
    ...(intent.issueNow === true && intent.occurredAt ? { issuedAt: intent.occurredAt } : {}),
    items,
  };
}

/** جمع ردیف‌های گفته‌شده، برای نمایش روی کارت تأیید پیش از ذخیره. */
export function invoiceLinesTotal(intent = {}) {
  const spoken = Array.isArray(intent.lines) ? intent.lines : [];
  if (!spoken.length) return Math.round(Number(intent.amount) || 0);
  return spoken.reduce((sum, line) => sum + Math.round((Number(line.quantity) || 1) * (Number(line.unitPrice) || 0)), 0);
}

/**
 * ورودی ثبت سرمایه یا دارایی ثابت.
 *
 * هر دو از صندوق یا بانک عبور می‌کنند — پس ماندهٔ حساب و کنترل پایان روز باید
 * حرکتشان را ببیند — ولی هیچ‌کدام درآمد یا هزینهٔ دوره نیستند. سمت دیگر سند،
 * حساب سرمایه یا حساب همان دارایی است، نه یک دستهٔ درآمد/هزینه.
 */
export function capitalEntryPayload(draft = {}) {
  const amount = Math.round(Number(draft.amount) || 0);
  const title = String(draft.title || '').trim().slice(0, 100);
  if (!amount || amount <= 0 || !title) return null;
  if (!['capital', 'fixed-asset'].includes(draft.intent)) return null;
  return {
    kind: draft.intent === 'capital' ? 'capital-in' : 'fixed-asset',
    amount,
    title,
    accountId: draft.accountId || 'cash',
    occurredAt: draft.occurredAt || null,
    note: String(draft.transcript || '').slice(0, 300),
  };
}

/**
 * از نیتِ گفتار به رویداد مالی.
 *
 * این تابع عمداً همین‌جاست و نه در یک ماژول جدا: نیت و رویداد دو نمایش از یک
 * چیزند و جداکردنشان یک لایهٔ ترجمهٔ اضافه می‌ساخت که باید با هر تغییر نیت
 * هم‌زمان نگه داشته می‌شد.
 *
 * خروجی `null` یعنی این نیت هنوز رویداد کاملی نیست — مبلغ ندارد، جهتش مبهم
 * است، یا هنوز پیش‌نویس است. تصمیم دربارهٔ چنین نیتی کار رابط کاربر است، نه
 * موتور حسابداری.
 */
export function intentToFinancialEvent(intent, { now = new Date(), accountId = 'cash' } = {}) {
  if (!intent || !intent.amount) return null;
  const shared = {
    amount: intent.amount,
    occurredAt: intent.occurredAt || now.toISOString(),
    counterparty: intent.contactName || null,
    source: 'voice',
    evidence: intent.transcript || null,
    accountId,
  };

  if (intent.intent === 'cheque') {
    if (!intent.direction) return null;
    return normalizeFinancialEvent({
      ...shared,
      kind: intent.direction === 'receivable' ? EVENT_KINDS.CHEQUE_RECEIVED : EVENT_KINDS.CHEQUE_ISSUED,
      dueAt: intent.dueAt || null,
      description: intent.title || null,
    });
  }
  if (intent.intent === 'obligation') {
    if (!intent.direction) return null;
    return normalizeFinancialEvent({
      ...shared,
      kind: intent.direction === 'receivable' ? EVENT_KINDS.RECEIVABLE_OPENED : EVENT_KINDS.PAYABLE_OPENED,
      dueAt: intent.dueAt || null,
      description: intent.title || null,
    });
  }
  if (intent.intent === 'capital') {
    return normalizeFinancialEvent({ ...shared, kind: EVENT_KINDS.CAPITAL_CONTRIBUTION, description: intent.title || null });
  }
  if (intent.intent === 'fixed-asset') {
    if (!String(intent.title || '').trim()) return null;
    return normalizeFinancialEvent({ ...shared, kind: EVENT_KINDS.FIXED_ASSET_PURCHASE, description: intent.title });
  }
  if (intent.intent === 'invoice') {
    return normalizeFinancialEvent({
      ...shared,
      kind: intent.documentType === 'purchase' ? EVENT_KINDS.PURCHASE_INVOICE : EVENT_KINDS.SALES_INVOICE,
      category: intent.documentType === 'purchase' ? 'مواد و کالا' : 'فروش',
    });
  }
  return null;
}

/**
 * اطمینان میدان‌به‌میدان یک نیت، برای موتور اطمینان.
 *
 * عددها از همان چیزی می‌آیند که تشخیص واقعاً می‌داند: مبلغ صریح گفته شده یا
 * حدس زده شده، جهت از فعل آمده یا مبهم مانده، تاریخ صریح بوده یا نسبی.
 */
export function intentConfidenceFields(intent) {
  if (!intent) return { fields: {}, blockers: ['گفته به هیچ رویداد مالی نرسید.'] };
  const blockers = [];
  if (!intent.amount) blockers.push('مبلغ در جمله گفته نشد.');
  if (['obligation', 'cheque'].includes(intent.intent) && !intent.direction) blockers.push('جهت پول از جمله روشن نشد.');
  if (intent.intent === 'fixed-asset' && !String(intent.title || '').trim()) blockers.push('نام دارایی ثابت گفته نشد.');

  const fields = { amount: intent.amount ? 0.95 : 0.2, kind: intent.ambiguous ? 0.55 : 0.94 };
  if (['obligation', 'cheque', 'invoice'].includes(intent.intent)) {
    fields.counterparty = intent.contactName ? 0.9 : 0.5;
  }
  if (intent.occurredAt || intent.dueAt) fields.date = 0.93;
  return { fields, blockers };
}
