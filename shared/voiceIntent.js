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
import { parseFinancialText, wordsToNumber } from './parser.js';
import { detectTaxMention, parseInvoiceLines, wantsImmediateIssue } from './invoiceSpeech.js';
import { EVENT_KINDS, normalizeFinancialEvent } from './financialEvent.js';
import { EVENT_NATURES, readEventNature } from './eventNature.js';
import { detectBank } from './banks.js';
import { isTimeBoundCategory, readDocumentService } from './documentReading.js';

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
// «X از ما طلب داره»، «… ازمون طلب داره»، «… از من طلبکاره»: بدهکار خودِ ماییم و
// طلبکار طرف مقابل — بدهی ما، نه طلب. «از X طلب» فقط وقتی طلب ماست که X خودمان
// نباشیم و فعل اول‌شخص باشد («از آقای رضایی طلب داریم/طلبکار شدیم»)؛ «آقای احمدی
// از آقای رضایی طلب داره» میان دو نفر دیگر است و هیچ جهتی برای ما نمی‌سازد.
const NOT_US_AFTER_AZ = '(?<![آ-ی])از(?![آ-ی])\\s*(?!(?:ما|من)(?![آ-ی]))';
const THIRD_PERSON_CLAIM = '(?:\\s*دار(?:ه|ن|ند|د)|\\s*داشت(?:ن|ند)?|کار\\s*(?:ه|است|هست(?!\\s*(?:م|یم))|ند|شد(?!\\s*(?:م|یم))|شده(?!\\s*(?:ام|ایم))))(?![آ-ی])';
const US_AS_DEBTOR = /(?:(?<![آ-ی])از\s*(?:ما|من)|(?<![آ-ی])(?:ازمون|ازمان|ازم))(?![آ-ی])\s*(?:\S+\s+){0,4}?طلب/;
const THIRD_PARTY_DEBTOR = new RegExp(`${NOT_US_AFTER_AZ}(?:\\S+\\s+){0,4}طلب${THIRD_PERSON_CLAIM}`);
const THEY_ARE_OWED = { test: (text) => /(?<![آ-ی])طلب\s*(?:دار(?:ه|ن|ند)|داشت(?:ن|ند)?)(?![آ-ی])/.test(text) && !THIRD_PARTY_DEBTOR.test(text) };
const RECEIVABLE_PATTERNS = [
  /بدهکار\s*(?:ه|است|هست(?:ند)?|شد(?!\s*(?:م|یم))|شده(?!\s*(?:ام|ایم))|ند)/,
  /طلب\s*دار(?:م|یم)/, /طلبم\s*شد/, /باید\s*به\s*(?:ما|من)\s*بده/,
  // «از X طلبکار شدیم» یعنی X به ما بدهکار است. نام شرکتی چندبخشی است
  // («شرکت آراد گستر آسیا»)، پس فاصلهٔ «از» تا «طلب» نباید یک واژه باشد.
  new RegExp(`${NOT_US_AFTER_AZ}(?:\\S+\\s+){0,4}طلب(?!${THIRD_PERSON_CLAIM})`),
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
  // «بیمه ایران … از ما طلب داره»، «صاحبخونه … ازمون طلب داره»، «آقای رضایی ۵
  // میلیون طلب داره»: طرف مقابل از ما طلب دارد.
  US_AS_DEBTOR, THEY_ARE_OWED,
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
const MONEY_ARRIVED = /واریز\s*(?:شده|شد|کرد|کردن)|ریخته(?:ن)?(?![آ-ی])|اومده\s*(?:تو|به)\s*حساب|دریافت\s*(?:شد|کردیم|کردم)|وصول\s*شد/;
// مرز آغاز واژه لازم است: «ندادیم» و «نزدیم» درست برعکس پرداخت‌اند.
const PAYMENT_DONE = /(?<![آ-ی])(?:زدیم|زدم|ریختیم|ریختم|واریز\s*کرد(?:یم|م)|پرداخت\s*کرد(?:یم|م)|دادیم|دادم)(?![آ-ی])/;

/**
 * «فاکتور فروش برای آلفا زدیم ولی پولش هنوز نیومده» — «زدیم» اینجا صدور فاکتور
 * است، نه پرداخت. فقط با نشانهٔ صریح نرسیدن پول؛ «فاکتور زدیم و کارت به کارت
 * کرد» فروش نقدی است و کارت فاکتور، دریافتش را گم می‌کرد.
 */
const INVOICE_ISSUED = /فاکتور(?:\s*[^\s،,.]+){0,8}?\s*(?:زد(?:یم|م)|صادر\s*کرد(?:یم|م))(?![آ-ی])/;
const STILL_UNPAID = /هنوز\s*(?:[^\s،,.]+\s*){0,3}?(?:ن(?:یومده|یامده|رسیده|داده|دادن|ریخته|ریختن|زده|کرده|گرفتیم|گرفتم)|پرداخت\s*نکرده|تسویه\s*نکرده)(?![آ-ی])|(?<![آ-ی])نسیه(?![آ-ی])/;

function issuedUnpaidInvoice(text) {
  const issued = INVOICE_ISSUED.exec(text);
  if (!issued || !STILL_UNPAID.test(text)) return false;
  const rest = text.slice(0, issued.index) + text.slice(issued.index + issued[0].length);
  return !PAYMENT_DONE.test(rest) && !MONEY_ARRIVED.test(rest);
}

/**
 * چکِ طرف سوم که ما خرجش کردیم — پشت‌نویسی.
 *
 * نه چک صادرهٔ ماست و نه دریافتی تازه: چک دریافتنی از دفتر بیرون می‌رود و بدهی
 * طرف مقابل بسته می‌شود. کارت چک یا کارت تسویه هیچ‌کدام این شکل را ندارند و
 * هرکدام سند غلطی می‌زدند (نقد یا چک پرداختنی)؛ پس به حسابدار می‌رود.
 */
/**
 * چکی که طرف مقابل به ما داد — با فعل سوم‌شخص، به ترتیب عادی جملهٔ فارسی.
 *
 * «مستاجر … یه چک ۶۰ میلیونی داد»، «… به ما داد»، «… بهمون داد»: فعل در آخر
 * می‌آید و فاعل طرف مقابل است. پیش از این فقط «داد به ما» و «چک دادن» چسبیده
 * شناخته می‌شد؛ بقیه از مسیر چک بیرون می‌افتادند و در صف حسابدار به‌عنوان
 * پیش‌پرداخت اجارهٔ **خودمان** (پول خارج‌شده) با مبلغ یک قسط می‌نشستند.
 *
 * «آقای احمدی چک ۵ میلیونی به آقای رضایی داد» میان دو نفر دیگر است و جهتی برای
 * ما نمی‌سازد؛ «به <کسی جز ما>» این حالت را بیرون نگه می‌دارد. «به تاریخ» و
 * «به مبلغ» گیرنده نیستند.
 */
const NOT_A_RECIPIENT = '(?:ما|من|تاریخ|مبلغ|ارزش|عنوان|مدت|نام\\s*(?:ما|من|شرکت))(?![آ-ی])';
/**
 * «داد» فقط وقتی چکِ دریافتی است که دهنده بیرون از شرکت باشد و چک تازه باشد.
 *
 * «مدیرعامل از حساب شخصیش چک … اجاره مهر رو داد»، «حسابدارمون/شریکم/کارمندمون
 * … چک … داد»: دهنده خودیِ شرکت است و چک یا هزینهٔ خودِ ما را پرداخته (طرف
 * مقابلش شریک یا تنخواه است، نه درآمد) یا تحویل یک چکِ دیگر است؛ «اسناد دریافتنی
 * / درآمد اجاره» اجارهٔ پرداختیِ خودمان را درآمد می‌کرد. «چک ما رو برگشت داد/پس
 * داد/عودت داد» برگشتِ چکِ خودمان است، نه چکِ تازه از طرف مقابل. هیچ‌کدام کارت
 * چک دریافتی نمی‌سازند و مثل قبل به حسابدار می‌روند. «مدیرعامل شرکت پارس» و
 * «مستاجرمون/مشتریمون» خودی نیستند.
 */
const INSIDER_GIVER = new RegExp(
  '(?<![آ-ی])(?:مدیر\\s*عامل|مدیرعامل|شریک|سهامدار|سهام\\s*دار|صاحب\\s*شرکت|رئیس|رییس|حسابدار|کارمند|منشی|کارگر|پرسنل|همکار|تنخواه\\s*دار|خودم|خودمون|خودمان|برادرم|پدرم|مادرم|همسرم|خانمم)'
  + '(?:\\s*(?:ه|ها|ا|ان))?(?:\\s*(?:مون|مان|م|ش|امون))?(?![آ-ی])'
  // «مدیرعامل شرکت پارس»: مدیر طرف مقابل است، نه خودیِ ما.
  + '(?!\\s*(?:شرکت|فروشگاه|کارخانه|موسسه|مؤسسه|بیمه|بانک)\\s+(?!چک|یه|یک|از|رو|را|بهمون|به(?![آ-ی]))[آ-ی])',
);
const RETURNED_CHEQUE = new RegExp([
  '(?:برگشت|پس|عودت|مرجوع)\\s*(?:ش\\s*)?(?:داد|دادن|دادند|زد|زدن|فرستاد|فرستادن)(?![آ-ی])',
  'برگردوند|برگرداند',
  // «چک ۵ میلیونی ما رو …»، «چک مارو …»، «چکمون رو …»: چکِ خودمان است.
  '(?<![آ-ی])چک\\s*(?:\\S+\\s+){0,3}?(?:(?:ما|من)\\s*(?:رو|را|و)|مارو|مارا|منو)(?![آ-ی])',
  'چک(?:مون|مان)(?![آ-ی])',
].join('|'));
function chequeGivenToUs(part) {
  if (INSIDER_GIVER.test(part) || RETURNED_CHEQUE.test(part)) return false;
  if (/(?:به\s*(?:ما|من)|بهمون|بهم|بمون|بما)\s*(?:\S+\s+){0,2}داد(?:ن|ند|ه)?(?![آ-ی])/.test(part)) return true;
  return /(?<![آ-ی])داد(?:ن|ند)?(?![آ-ی])/.test(part)
    && !new RegExp(`(?<![آ-ی])به\\s+(?!${NOT_A_RECIPIENT})\\S+`).test(part);
}

/**
 * چند برگ چک در یک جمله: «۱۲ تا چک»، «شش فقره چک»، «دوازده برگ چک»، «۱۲تا چک»،
 * عددِ تنها پیش از چک («۱۲ چک ۱۰ میلیونی»، «شش چک‌های …») و شمارِ پس از مبلغ
 * («چک ۱۰ میلیونی ۱۲ تا»). «دسته چک پنجاه برگه» تعداد برگ دسته‌چک است، نه سری؛
 * «نه»ی تنها نفی است، نه عدد نُه.
 */
const SERIES_COUNT = /(?<![آ-ی\d])((?:\d{1,2})|(?:[آ-ی]+(?:\s+و\s+[آ-ی]+)?))\s*(?:تا|فقره|برگ|برگه|عدد|قطعه)\s*(?:چک|چکِ)(?![آ-ی])/;
const SERIES_NUMBER = '(?:\\d{1,2}|(?:یک|دو|سه|چهار|پنج|شش|شیش|هفت|هشت|ده|یازده|دوازده|سیزده|چهارده|پانزده|پونزده|شانزده|شونزده|هفده|هیفده|هجده|هیجده|نوزده|بیست|سی|چهل|پنجاه|شصت)(?:\\s+و\\s+(?:یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه))?)';
const SERIES_BARE_BEFORE = new RegExp(`(?<![آ-ی\\d])(${SERIES_NUMBER})\\s+(?:چک|چکِ)(?![آ-ی])`);
// «چک ۱۰ میلیونی ۱۲ تا»: شمار پس از صفت مبلغ.
const SERIES_COUNT_AFTER = new RegExp(`((?<![آ-ی])چک(?:\\s*ها(?:ی)?)?\\s+(?:\\S+\\s+){0,3}?\\S*(?:میلیونی|ملیونی|هزاری|تومنی|تومانی))\\s+(${SERIES_NUMBER})\\s*(?:تا|فقره|برگ|برگه|عدد|قطعه)(?![آ-ی])`);

/**
 * شمارِ پس از مبلغ پیش از خواندن مبلغ کنار می‌رود؛ وگرنه «۱۰ میلیونی ۱۲ تا»
 * یک مبلغ ۱۰٬۰۱۲٬۰۰۰ خوانده می‌شد. مدتِ خودِ چک پس از مبلغ («چک ۱۰ میلیونی
 * دو ماهه») هم به همان شکل در مبلغ ادغام می‌شد و فقط از خواندن مبلغ کنار می‌رود.
 */
const CHEQUE_TENOR_AFTER = new RegExp(`((?<![آ-ی])چک(?:\\s*ها(?:ی)?)?\\s+(?:\\S+\\s+){0,3}?\\S*(?:میلیونی|ملیونی|هزاری|تومنی|تومانی))\\s+${SERIES_NUMBER}\\s*(?:ماهه|روزه|ساله|هفته\\s*ای)(?![آ-ی])`);
function withoutSeriesCountAfter(text) {
  return text.replace(SERIES_COUNT_AFTER, '$1').replace(CHEQUE_TENOR_AFTER, '$1');
}

export function chequeSeriesCount(input) {
  const text = normalizePersian(input);
  const match = SERIES_COUNT.exec(text) || SERIES_COUNT_AFTER.exec(text)?.slice(1) || SERIES_BARE_BEFORE.exec(text);
  if (!match) return 0;
  const token = match[1].trim();
  const count = /^\d+$/.test(token) ? Number(token) : wordsToNumber(token.split(/\s+/));
  return Number.isInteger(count) && count >= 2 && count <= 60 ? count : 0;
}

/**
 * مبلغ گفته‌شده در جملهٔ سری، مالِ هر برگ است یا جمع؟
 *
 * «چک ۱۰ میلیونی» صفت است و مبلغ هر برگ را می‌گوید؛ «جمعاً ۱۲۰ میلیون» جمع را.
 * بی‌هیچ‌کدام («شش تا چک دادیم ۶۰ میلیون») معلوم نیست و `null` برمی‌گردد تا مبلغ
 * پرسیده شود.
 */
function seriesAmounts(text, count, spoken) {
  if (/جمعا|جمعاً|مجموعا|مجموعاً|در\s*مجموع|روی\s*هم|کلا|کلاً|کل\s*مبلغ/.test(text)) {
    return spoken % count === 0 ? { total: spoken, per: spoken / count } : { total: spoken, per: null };
  }
  if (/(?:میلیون|ملیون|هزار|تومن|تومان)ی(?![آ-ی])/.test(text)) return { total: spoken * count, per: spoken };
  return null;
}

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

/**
 * دورهٔ پوشش تاریخِ سند نیست.
 *
 * «اجاره شش ماه آینده رو با چک ۶۰ میلیونی دادیم» دربارهٔ شش ماه **اجاره** است؛
 * چک تاریخ خودش را نگفته. خواندن «شش ماه آینده» به‌عنوان سررسید، چکِ امروز را
 * شش ماه عقب‌تر در فهرست چک‌ها می‌نشاند و «از اول آبان تا آخر اسفند» اولِ آبان
 * را سررسید می‌کرد. پیش از جست‌وجوی تاریخِ تنها، هر عبارتی که پوشش را می‌گوید
 * کنار گذاشته می‌شود: بازهٔ ماه‌ها (با سال و بی‌سال، روز عددی یا «اول/آخر»، و
 * تایپ «ابان/اخر»)، طولِ آینده پس از نام خدمت («اجاره/بیمه/اشتراک … شش ماه
 * آینده»)، «اجارهٔ آبان»، و «پوشش از …». تاریخی که با نشانهٔ صریح آمده —
 * «سررسید ۱۵ آذر»، «به تاریخ ۲۰ آذر» — و تاریخِ خودِ چک («چک … دو ماه دیگه»)
 * دست نمی‌خورند. چیزی نماند یعنی سررسید خالی است و پرسیده می‌شود، نه حدس.
 */
const COVERAGE_MONTH = 'فروردین|اردیبهشت|ارديبهشت|خرداد|تیر|تير|مرداد|امرداد|شهریور|شهريور|مهر|آبان|ابان|آذر|اذر|دی|بهمن|اسفند';
const COVERAGE_SERVICE = '(?:اجاره|کرایه|بیمه|بیمع|اشتراک|لایسنس|لاینسس|پشتیبانی|شارژ|پوشش|قرارداد|سرویس|هاستینگ|هاست|سرور|آبونمان|عضویت|نگهداری|رهن|ودیعه)(?:\\s*(?:ی|ٔ|ء|بها))?';
const COVERAGE_COUNT = '(?:\\d{1,2}|یک|یه|دو|سه|چهار|پنج|شش|شیش|هفت|هشت|نه|ده|یازده|دوازده|هجده|بیست(?:\\s*و\\s*چهار)?)';
const COVERAGE_AHEAD = '(?:آینده|اینده|بعد|بعدی|جلوتر|جلو|آتی|پیش\\s*رو|دیگه|دیگر)(?![آ-ی])';
// واژهٔ میان نام خدمت و طولش؛ «چک» و مبلغ یعنی آن طول مالِ چک است، نه خدمت.
const COVERAGE_GAP = '(?:\\s+(?!چک|چکی|میلیون|ملیون|تومن|تومان|هزار)[^\\s\\d]+){0,3}?';
const COVERAGE_YEAR = '(?:\\s+(?:سال\\s+)?\\d{2,4}(?!\\d))?';
const COVERAGE_PATTERNS = [
  // «از اول آبان تا آخر اسفند»، «از ۱ آبان تا ۳۰ بهمن»، «مهر ۱۴۰۵ تا شهریور ۱۴۰۶».
  new RegExp(`(?:از\\s+)?(?:[^\\s]+\\s+)?(?:${COVERAGE_MONTH})(?:\\s*ماه)?${COVERAGE_YEAR}\\s+تا\\s+(?:[^\\s]+\\s+)?(?:${COVERAGE_MONTH})(?![آ-ی])(?:\\s*ماه)?${COVERAGE_YEAR}`, 'g'),
  new RegExp(`(?:پوشش|شروع\\s*(?:پوشش|بیمه|قرارداد))\\s*(?:بیمه\\s*)?(?:از|برای)\\s*[^،,؛.]+`, 'g'),
  // «اجاره شش ماه آینده»، «بیمه یک سال بعد»، «اشتراک ماه آینده».
  new RegExp(`(${COVERAGE_SERVICE}${COVERAGE_GAP})\\s+(?:${COVERAGE_COUNT}\\s*)?(?:ماه|سال)(?:\\s*ه)?\\s*${COVERAGE_AHEAD}`, 'g'),
  // «شش ماه آینده اجاره رو …» — طول پیش از نام خدمت.
  new RegExp(`(?:${COVERAGE_COUNT}\\s*)?(?:ماه|سال)\\s*${COVERAGE_AHEAD}(?=\\s+(?:رو\\s+|را\\s+)?${COVERAGE_SERVICE})`, 'g'),
  // «اجارهٔ آبان»، «اجاره ماه آذر».
  new RegExp(`(${COVERAGE_SERVICE})\\s*(?:ماه\\s*)?(?:${COVERAGE_MONTH})(?![آ-ی])`, 'g'),
];

export function maskCoveragePhrases(input) {
  let text = normalizePersian(input);
  for (const pattern of COVERAGE_PATTERNS) {
    // نام خدمت می‌ماند؛ فقط خودِ دوره پاک می‌شود تا الگوی بعدی هم آن را ببیند.
    text = text.replace(pattern, (match, service) => (typeof service === 'string' ? `${service} ` : ' '));
  }
  return text.replace(/\s+/g, ' ').trim();
}
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
  // «چک … به تاریخ ۲۰ آذر» یعنی تاریخِ خودِ چک، که همان سررسید است. با نشانهٔ
  // عمومیِ «تاریخ» تاریخ رویداد خوانده می‌شد و با ترجیح گذشته به آذرِ پارسال
  // می‌رفت: فروش امسال در سال بسته‌شده ثبت می‌شد و چک سررسید نداشت.
  if (isCheque && /به\s*تاریخ|تاریخ\s*چک/.test(text) && !DUE_MARKERS.test(text)) {
    return { occurredAt: null, dueAt: dateAfter(text, /به\s*تاریخ|تاریخ\s*چک/, now, false) };
  }
  const dueAt = dateAfter(text, DUE_MARKERS, now, false);
  const occurredAt = dateAfter(text, OCCURRED_MARKERS, now, true);
  if (dueAt || occurredAt) return { occurredAt, dueAt };

  // تاریخِ تنها فقط از آنچه پس از کنار گذاشتن دورهٔ پوشش می‌ماند خوانده می‌شود.
  const dated = maskCoveragePhrases(input);
  // چک اصلاً دربارهٔ سررسید است، پس تاریخِ تنها در جملهٔ چک سررسید است.
  if (isCheque) {
    const cheque = extractDateMention(dated, { now, preferPast: false });
    return { occurredAt: null, dueAt: cheque?.iso || null };
  }
  // برای طلب و بدهی، خودِ تاریخ نقشش را می‌گوید: کسی در آینده بدهکار نمی‌شود،
  // پس تاریخ آینده فقط می‌تواند سررسید باشد و تاریخ گذشته فقط رویداد.
  const forward = extractDateMention(dated, { now, preferPast: false });
  if (forward && new Date(forward.iso).getTime() > now.getTime()) return { occurredAt: null, dueAt: forward.iso };
  const lone = extractDateMention(dated, { now, preferPast: true });
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
  if (/نمی\s*دونم|نمیدونم|نمی\s*دانم|معلوم\s*نیس|مشخص\s*نیس|مطمئن\s*نیست(?:م|یم|ن)?|احتمالا|احتمالاً|(?<![آ-ی])شاید(?![آ-ی])/.test(text)) return null;
  if (/ضمانت|تضمین|وثیقه|نه\s*تاریخ\s*داره|در\s*وجه\s*کسی|دستت\s*باشه/.test(text)) return null;

  // «چک ۱۰ میلیونی ۱۲ تا»: شمار برگ‌ها جزو مبلغ خوانده نمی‌شود.
  const countless = withoutSeriesCountAfter(text);
  const amountInput = countless === text ? input : countless;
  const amount = spokenAmount(amountInput);
  const contactName = extractContactName(input, { allowBare: obligationContext });
  // «دسته چک جدید رو تحویل گرفتیم… کارمزدش کم شد» دربارهٔ کارمزد بانک است، نه
  // یک چک؛ کارت چک برایش سؤال «بابت فروش تازه یا طلب قبلی؟» می‌پرسید.
  const isCheque = matchesAny(text, CHEQUE_PATTERNS) && !/دسته\s*چک/.test(text);

  // پولی که آمده «بابت فاکتور فروش»، وصول همان فاکتور است، نه صدور فاکتور تازه.
  const issuedUnpaid = issuedUnpaidInvoice(text);
  if (issuedUnpaid || ((matchesAny(text, INVOICE_PURCHASE_PATTERNS) || matchesAny(text, INVOICE_SALES_PATTERNS)) && !PAYMENT_DONE.test(text) && !MONEY_ARRIVED.test(text))) {
    if (!amount) return null;
    const documentType = matchesAny(text, INVOICE_PURCHASE_PATTERNS) ? 'purchase' : 'sales';
    return {
      intent: 'invoice',
      documentType,
      amount,
      contactName: withoutIssueVerb(contactName),
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
      // «به حساب بانک ملت واریز کرد» یعنی پول در بانک ملت نشسته، نه صندوق.
      // آزمون مهر ۱۴۰۵ صد میلیون آورده را در صندوق نشان داد.
      ...accountOf(input),
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
      ...accountOf(input),
      occurredAt: extractDateMention(input, { now, preferPast: true })?.iso || null,
      transcript: text,
    };
  }

  // جهت پیش از چک سنجیده می‌شود: «چک پنج میلیون از آقای احمدی گرفتم» طلب است
  // و «چک دادم» بدهی؛ خودِ واژهٔ چک جهت نمی‌سازد.
  // فعل معمولاً از «چک» فاصله دارد («چک پنج میلیون دادم»)، پس چسبیدگی شرط
  // نیست؛ وجود فعل جهت‌دار در همان جمله کافی است.
  const directionText = isCheque ? text.replace(/تخفیف(?:\s+تجاری)?\s+داد(?:یم|م)/g, '') : text;
  const readDirection = (part) => ({
    receivable: matchesAny(part, RECEIVABLE_PATTERNS)
      || (isCheque && (/(?:گرفتم|گرفتیم|دریافت\s*کردم|داد\s*به\s*(?:من|ما)|دادن\s*به\s*(?:من|ما)|به\s*(?:ما|من)\s*واگذار\s*کرد|چک\s*(?:\d+\s*روزه\s*)?دادن(?![آ-ی]))/.test(part)
        || chequeGivenToUs(part))),
    payable: matchesAny(part, PAYABLE_PATTERNS)
      || (isCheque && /(?:دادم|دادیم|نوشتم|کشیدم|صادر\s*کردم)/.test(part)),
  });
  // جمله‌ای که هم «جنس را تحویل گرفتیم» دارد و هم «چک دادیم»، دو جهت دارد؛
  // جهت چک را جملهٔ خودِ چک می‌گوید، نه بقیهٔ گفته.
  const chequeClause = isCheque ? (directionText.split(/[؛;.،,]/).find((part) => matchesAny(part, CHEQUE_PATTERNS)) || '') : '';
  const own = isCheque ? readDirection(chequeClause) : null;
  const whole = readDirection(directionText);
  const decided = own && own.receivable !== own.payable ? own : whole;
  const { receivable, payable } = decided;
  if (!receivable && !payable) return null;
  if (!amount && !obligationContext) return null;
  // «۵۰ میلیون از نوری قرض گرفتیم، ریخت به ملت»: پول همین حالا جابه‌جا شده.
  // کارت تعهد فقط بدهی را می‌ساخت و طرف دیگرش «سایر هزینه‌ها» می‌شد؛ مسیر ثبت
  // روزانه وام دریافتی را درست می‌نشاند. در صفحهٔ طلب و بدهی، کارت تعهد بجاست.
  if (!isCheque && !obligationContext && /قرض\s*(?:\S+\s*)?(?:گرفت|داد)(?:م|یم|ن)?(?![آ-ی])/.test(text)) return null;

  // هر دو نشانه یعنی جمله واقعاً مبهم است؛ اجرا نمی‌شود تا کاربر روشنش کند.
  const direction = receivable && payable ? null : receivable ? 'receivable' : 'payable';
  // «یه چک ۵۵ میلیونی… دادیم»: مبلغ چک همان عددی است که در جملهٔ خودِ چک آمده،
  // حتی وقتی جمله عددهای دیگری (بهای کالا، درصد) هم دارد.
  const chequeAmounts = isCheque && chequeClause ? parseFinancialText(withoutSeriesCountAfter(chequeClause), { source: 'voice' }).transactions.map((item) => Number(item.amount) || 0).filter(Boolean) : [];
  const ownAmount = chequeAmounts.length === 1 ? chequeAmounts[0] : 0;
  const severalAmounts = !ownAmount && hasSeveralAmounts(amountInput);
  const spoken = ownAmount || amount;
  // «۱۲ تا چک ۱۰ میلیونی»: پارسر عدد شمارش را عمداً مبلغ نمی‌خواند، پس مبلغ
  // گفته‌شده مالِ **یک** چک است. کارت تک‌چکی آن را کل سند می‌کرد و ۱۱۰ میلیون
  // بدهی گم می‌شد. سری با جمعِ کامل و تعدادش برمی‌گردد؛ ثبت تک‌چکی برایش ساخته
  // نمی‌شود چون سررسید هر برگ را جمله نگفته (سرور به حسابدار می‌فرستد). وقتی
  // معلوم نیست مبلغ گفته‌شده مال هر برگ است یا جمع، مبلغ پرسیده می‌شود.
  const series = isCheque ? chequeSeriesCount(chequeClause || text) : 0;
  const seriesRead = series && spoken ? seriesAmounts(chequeClause || text, series, spoken) : null;
  const seriesUnclear = Boolean(series) && !seriesRead;
  const finalAmount = seriesRead ? seriesRead.total : spoken;
  return {
    intent: isCheque ? 'cheque' : 'obligation',
    direction,
    ambiguous: !direction,
    amount: severalAmounts || seriesUnclear ? 0 : finalAmount,
    // مبلغ خالی یعنی «هنوز گفته نشده»، نه صفر؛ کارت تأیید تا نوشتنش پیش نمی‌رود.
    needsAmount: !finalAmount || severalAmounts || seriesUnclear,
    ...(severalAmounts ? { amountHint: amount } : {}),
    ...(series ? { chequeCount: series, ...(seriesRead ? { perChequeAmount: seriesRead.per } : {}) } : {}),
    // چک خرید یا فروش با ارزش افزوده: کل مبلغ چک بهای کالا یا درآمد نیست.
    ...(isCheque && /ارزش\s*افزوده|مالیات\s*بر\s*ارزش/.test(text) ? { vatMentioned: true } : {}),
    contactName,
    ...splitDateRoles(input, { now, isCheque }),
    title: [isCheque ? (series ? `${series.toLocaleString('fa-IR')} چک` : 'چک') : '', contactName].filter(Boolean).join(' ') || (isCheque ? 'چک' : 'طلب/بدهی'),
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
// «فاکتور فروش … به شرکت آلفا صادرش کن»: فعل صدور جزو نام طرف حساب نیست؛ بدون
// این، حساب «دریافتنی — شرکت آلفا صادرش کن» ساخته می‌شد.
const ISSUE_VERB_TAIL = /\s+(?:رو\s+|را\s+)?(?:صادر|نهایی|قطعی|ثبت)\s*(?:ش|اش)?\s*(?:کن|بکن|کنید|بکنید|بشه|کنش|شود)?\s*$/;
function withoutIssueVerb(name) {
  if (!name) return name;
  const cleaned = String(name).replace(ISSUE_VERB_TAIL, '').trim();
  return cleaned || name;
}

/**
 * دستهٔ پیش‌نویس فاکتور از خودِ گفته.
 *
 * «فاکتور خرید لایسنس یک ساله» نرم‌افزار و اشتراک است، «… بیمه یک ساله انبار»
 * بیمه و «… اجاره شش ماهه دفتر» اجاره — نه پیش‌فرضِ «مواد و کالا»ی سرور که
 * صدور را یک‌جا هزینه می‌کرد. فقط وقتی دسته فرستاده می‌شود که خدمت دوره‌دار است
 * (یا خدمتی که دوره‌اش گفته شده)؛ فاکتور کالا همان پیش‌فرض قبلی را می‌گیرد.
 */
export function invoiceCategoryFromSpeech(intent = {}, { now = new Date() } = {}) {
  const documentType = intent.documentType === 'purchase' ? 'purchase' : 'sales';
  const said = String(intent.transcript || '').trim();
  if (!said) return null;
  const read = readDocumentService(said, {
    direction: documentType === 'purchase' ? 'payable' : 'receivable',
    occurredAt: intent.occurredAt || new Date(now).toISOString(),
  });
  if (!read.category) return null;
  if (isTimeBoundCategory(read.category)) return read.category;
  return read.servicePeriodStart && read.servicePeriodEnd && ['خدمات', 'نرم‌افزار و اشتراک'].includes(read.category) ? read.category : null;
}

export function invoiceDraftPayload(intent = {}, { taxRateId = null } = {}) {
  const documentType = intent.documentType === 'purchase' ? 'purchase' : 'sales';
  const category = invoiceCategoryFromSpeech(intent);
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
    ...(category ? { category } : {}),
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
/** حسابی که جمله نام برده: بانکِ گفته‌شده، وگرنه صندوق. */
function accountOf(input) {
  const bank = detectBank(input);
  return bank?.bankId ? { accountId: null, bankId: bank.bankId } : { accountId: 'cash', bankId: null };
}

export function capitalEntryPayload(draft = {}) {
  const amount = Math.round(Number(draft.amount) || 0);
  const title = String(draft.title || '').trim().slice(0, 100);
  if (!amount || amount <= 0 || !title) return null;
  if (!['capital', 'fixed-asset'].includes(draft.intent)) return null;
  return {
    kind: draft.intent === 'capital' ? 'capital-in' : 'fixed-asset',
    amount,
    title,
    accountId: draft.accountId || (draft.bankId ? null : 'cash'),
    ...(draft.bankId ? { bankId: draft.bankId } : {}),
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
      category: invoiceCategoryFromSpeech(intent) || (intent.documentType === 'purchase' ? 'مواد و کالا' : 'فروش'),
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
