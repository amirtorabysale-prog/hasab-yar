import {
  COVERAGE_BETWEEN, DAY_WORD_PATTERN, NOT_A_YEAR, PERSIAN_MONTHS, coverageStartsAfterPayment, dayOfToken, normalizeSpokenYears, persianPeriodEnd, persianToISO,
  spokenYear, todayPersian,
} from './persianDate.js';
import { normalizePersian } from './normalize.js';

/**
 * پاک‌کردن عبارت‌های پوشش از متنی که دنبال تاریخ دیگری است (روز پرداخت، سررسید
 * چک یا طلب). یک‌جا در `persianDate.js` نوشته شده تا خواندن تاریخ پرداخت هم بدون
 * وابستگی چرخه‌ای از آن استفاده کند؛ از این‌جا هم در دسترس است، کنار خوانندهٔ دوره.
 */
export { maskCoveragePhrases } from './persianDate.js';

/**
 * دورهٔ پوششِ گفته‌شده در جمله.
 *
 * چرا لازم شد:
 *
 * قاعدهٔ پیش‌پرداخت از فاز صفر ساخته شده بود، ولی فقط وقتی کار می‌کرد که دسته
 * در فهرست خدمات دوره‌دار باشد. «پونزده میلیون شارژ ساختمان رو برای شش ماه
 * جلوتر تسویه کردم» دسته‌اش «قبوض» است و در آن فهرست نیست — در حالی که خودِ
 * جمله دوره را صریح گفته. قاعده بود و داده نمی‌رسید.
 *
 * جمله سه چیز جدا می‌تواند بگوید و هر سه جدا خوانده و بعد کنار هم گذاشته می‌شوند:
 *
 * - **بازه**: «از اول آبان تا آخر اسفند»، «مهر تا اسفند»، «سال ۱۴۰۶»، «اجارهٔ همین ماه».
 * - **شروع**: «از اول آبان»، «از ۱۴۰۵/۰۸/۰۱»، «که اول آذر شروع میشه».
 * - **طول**: «یک‌ساله»، «شش ماهه»، «سه ماه آینده»، «به مدت شش ماه»، «برای سه ماه».
 *
 * شروع + طول یک دوره است؛ طولِ تنها از روز پرداخت شروع می‌شود (همان قراردادی که
 * «یک‌ساله» همیشه داشت)؛ شروعِ تنها فقط شروع را می‌نشاند و پایان پرسیده می‌شود.
 * پیش از این، این‌ها یکی‌درمیان خوانده می‌شدند: «بیمه یکساله از اول آبان» از روز
 * پرداخت شروع می‌شد و «اجاره آبان تا اسفند» فقط آبان بود و کل ۵۰ میلیون همان ماه
 * هزینه می‌شد.
 *
 * «شش ماه پیش» عمداً بیرون است: یک زمان است، نه یک دورهٔ پوشش. بدون این مرز،
 * هر اشارهٔ زمانی به پیش‌پرداخت تبدیل می‌شد. زمان تحویل کالا («سه ماه بعد تحویل
 * میده») هم دوره نیست: پیش‌پرداخت کالا ماه‌به‌ماه هزینه نمی‌شود.
 *
 * خروجی `{ start, end, months, basis }` است. `end: null` یعنی شروع گفته شده و
 * پایان نه؛ گیرنده همان طرفِ گفته‌شده را می‌نشاند و موتور پایان را می‌پرسد.
 *
 * الگو روی متن خام اجرا می‌شود و نرمال‌سازی فارسی صدا زده نمی‌شود: تایپ زنده
 * بودجهٔ میلی‌ثانیه‌ای دارد و این درس دو بار گرفته شده.
 */

const GAP = '[\\s\\u200c]*';

/**
 * جمله‌ای که دوره‌اش خوانده نمی‌شود، با جمله‌ای که دوره ندارد فرق دارد: اولی نباید
 * به خواننده‌های بعدی برسد. «بیمه از فروردین ۱۳۹۴ تا اسفند ۱۳۹۴» سالِ صریح دارد؛
 * جایگزین کردنش با سال رویداد یعنی ۱۲ میلیون پیش‌پرداختِ ۱۴۰۵ — حدس، نه خواندن.
 */
const UNREADABLE = Object.freeze({ unreadable: true });

/** عددی که درست پشت سال یا «نیم» آمده: «سال ۱۴۰۶ ۱۲ میلیون»، «یک سال و نیم ۱۸ میلیون». */
const NUMBER_NEXT = /^[\s\u200c]*\d/;

const YA = '[یي]';
/** مرز چپ واژه: «نه» درون «خونه» و «ماهانه»، و «یه» درون «کرایه» عدد نیستند. */
const WORD_START = '(?<![آ-ی\\d])';

/**
 * عددهای گفتاریِ طول دوره. ترکیبی‌ها («بیست و چهار») پیش از جزءشان امتحان
 * می‌شوند تا «بیست» از «بیست و چهار» جدا نشود.
 */
const NUMBER_WORDS = Object.freeze([
  ['بیست و چهار', 24], ['سی و شش', 36], ['چهل و هشت', 48],
  ['یک', 1], ['یه', 1], ['دو', 2], ['سه', 3], ['چهار', 4], ['چار', 4], ['پنج', 5], ['شش', 6], ['شیش', 6],
  ['هفت', 7], ['هشت', 8], ['نه', 9], ['ده', 10], ['یازده', 11], ['دوازده', 12], ['پانزده', 15], ['پونزده', 15],
  ['هجده', 18], ['هیجده', 18], ['بیست', 20], ['سی', 30], ['شصت', 60],
]);
const WORD_VALUE = new Map(NUMBER_WORDS.map(([word, value]) => [word.replace(/\s+/g, ''), value]));
const NUMBER_SOURCE = NUMBER_WORDS.map(([word]) => word.split(' ').join(GAP))
  .sort((left, right) => right.length - left.length).join('|');
/** تا سه رقم: «۱۲۰ ماهه» ده سال است، نه ۲۰ ماه. */
const NUMBER_PATTERN = `${WORD_START}(\\d{1,3}|${NUMBER_SOURCE})`;

const monthsOf = (token) => (/^\d+$/.test(token) ? Number(token) : WORD_VALUE.get(String(token).replace(/[\s‌]+/g, '')) || 0);

const PAST_WORDS = `(?:پ${YA}ش|قبل|گذشته|اخ${YA}ر)`;
/** «شش ماهه»، «یک‌ساله» — صفت، یعنی طول پوشش. */
const ADJECTIVE = new RegExp(`${NUMBER_PATTERN}${GAP}(ماهه|ساله|سال${GAP}ه)`, 'gd');
/** «برای شش ماه جلوتر» — عدد و واحد، با نشانهٔ صریح آینده. */
// تا سه واژه میان مدت و نشانهٔ آینده: «شش ماه دفتر را جلوتر دادیم».
const FORWARD = new RegExp(`${NUMBER_PATTERN}${GAP}(ماه|سال)(?:${GAP}[^\\s.،؛]+){0,3}?${GAP}(?:${['جلوتر', 'جلو', '[آا]' + YA + 'نده', 'بعد', 'پ' + YA + 'ش' + GAP + 'رو', 'آت' + YA, 'پ' + YA + 'ش' + GAP + '?پرداخت'].join('|')})(?![آ-ی])`, 'gd');
/** «به مدت شش ماه»، «برای سه ماه»، «ظرف دوازده ماه» — حرف اضافه + طول. */
const DURATION = new RegExp(`(?<![آ-ی])(?:به${GAP}مدت|بمدت|برا${YA}?|واسه|ظرف|ط${YA})${GAP}${NUMBER_PATTERN}${GAP}(ماه|سال)(?![آ-ی])(?!${GAP}${PAST_WORDS})`, 'gd');
/**
 * «شش ماه» بی‌صفت و بی‌نشانه، فقط کنار شروعِ گفته‌شده («اجاره شش ماه دفتر رو از
 * مهر دادیم») یا در جواب سؤال دوره. تنها، می‌تواند «شش ماه کار کرد» باشد.
 */
const BARE = new RegExp(`${NUMBER_PATTERN}${GAP}(ماه|سال)(?![آ-ی])(?!${GAP}(?:${PAST_WORDS}|د${YA}گه|د${YA}گر))`, 'gd');
/**
 * طولِ مرکب: «یک سال و شش ماه»، «یک سال و نیم»، «یک سال و سه ماهه».
 *
 * الگوهای طول بعد از «یک سال» می‌ایستادند: «اشتراک به مدت یک سال و شش ماه ۱۸
 * میلیون» دوازده قسط ۱٫۵ میلیونی می‌شد و شش ماهِ آخر هزینه نمی‌شد. «سه ماه و
 * نیم» نیم‌ماه دارد و برنامهٔ ماهانه نیم‌ماه ندارد؛ خوانده نمی‌شود و پرسیده می‌شود.
 */
const YEAR_TAIL = new RegExp(`^${GAP}و${GAP}(?:(?<count>\\d{1,2}|${NUMBER_SOURCE})${GAP}ماه(?:${GAP}ه)?|(?<half>ن${YA}م)(?:${GAP}ه)?)(?![آ-ی])`, 'd');
const YEAR_HEAD = new RegExp(`${WORD_START}(\\d{1,2}|${NUMBER_SOURCE})${GAP}سال${GAP}و${GAP}$`);
const MONTH_HALF = new RegExp(`^${GAP}و${GAP}ن${YA}م(?![آ-ی])`);

/** گذشته: صریحاً یک زمان است، نه دوره. */
const PAST = new RegExp(`${NUMBER_PATTERN}${GAP}(?:ماه|سال)${GAP}${PAST_WORDS}`);

/**
 * زمان تحویل کالا، دورهٔ خدمت نیست.
 *
 * «۳۰ میلیون به تولیدی دادیم برای پارچه که سه ماه بعد تحویل میده» با «سه ماه
 * بعد» پیش‌پرداخت خدمتِ سه‌ماهه می‌شد و پارچه — و حتی دستگاه — طی زمان تحویل
 * هزینه می‌شد. پیش‌پرداخت کالا تا رسیدن کالا دارایی است، نه هزینهٔ ماهانه.
 */
//
// «حمل» فقط وقتی فعل است («حمل میشه»، «حمل کردن») زمان تحویل است؛ «بیمه حمل» و
// «اجاره کامیون حمل بار» نام خدمت‌اند. «تحویل کلید» هم شروع اجاره است، نه تحویل کالا.
const DELIVERY_VERB = `(?:تحو${YA}ل(?!${GAP}کل${YA}د)|م${YA}${GAP}رس|برس|م${YA}${GAP}[آا]${YA}?د|م${YA}اد|ب${YA}اد|ارسال|م${YA}${GAP}فرست|بفرست|حمل${GAP}(?:م${YA}|بش|بک|کرد|شد|شه)|بار${GAP}م${YA}|آماده|م${YA}${GAP}ساز|بساز|نصب)`;
const LEAD_TIME_AFTER = new RegExp(`^${GAP}(?:[^\\s.،؛]+${GAP}){0,1}?${DELIVERY_VERB}`);
const LEAD_TIME_BEFORE = new RegExp(`(?:تحو${YA}ل(?!${GAP}کل${YA}د)|ارسال|رس${YA}دن)[^\\s]*${GAP}(?:[^\\s]+${GAP}){0,2}$`);

function deliveryLeadTime(text, match) {
  const end = match.index + match[0].length;
  return LEAD_TIME_AFTER.test(text.slice(end, end + 30)) || LEAD_TIME_BEFORE.test(text.slice(Math.max(0, match.index - 30), match.index));
}

/**
 * شرط پرداخت، دورهٔ خدمت نیست.
 *
 * «نسیه دو ماهه»، «چک شش‌ماهه»، «وام دوساله» همان صفت دوره را دارند ولی
 * دربارهٔ **مهلت پرداخت** حرف می‌زنند، نه مدت خدمتی که خریده شده. در آزمون
 * استرس، «پنج تا صندلی… نسیه دو ماهه» پیش‌پرداخت قطعی شد و «سهم‌الشرکه… چک
 * شش‌ماهه» هم — هر دو با اطمینان و هر دو غلط.
 */
const CREDIT_TERM = new RegExp(`(?:نس${YA}ه|چک|وام|قسط|اقساط|مهلت|سررس${YA}د|مدت${GAP}دار|تسه${YA}لات|سپرده|اعتبار|ضمانت)${GAP}(?:[^\\s]+${GAP}){0,2}$`);

function termOfPayment(text, index) {
  return CREDIT_TERM.test(text.slice(Math.max(0, index - 30), index));
}

/**
 * نام خدمت دوره‌دار. «قرارداد» عمداً نیست: قرارداد خرید پارچه هم قرارداد است؛
 * «قرارداد اجاره» و «قرارداد پشتیبانی» نام خدمتشان را خودشان دارند.
 */
const SERVICE_NOUN = `(?:اجاره|کرا${YA}ه|شارژ|اشتراک|ب${YA}مه|لا${YA}سنس|ل${YA}سانس|پشت${YA}بان${YA}|آبونمان)`;
/** خدمت دوره‌دار در جمله: فقط آن‌وقت «از اول آبان» و «برای سه ماه» مال پوشش‌اند. */
const COVERAGE_CONTEXT = new RegExp(`${SERVICE_NOUN}|پوشش|حق${GAP}عضو${YA}ت`);
/**
 * قرض و وام: مدتشان مهلت بازپرداخت است. «دو ماهه ۱۰ میلیون قرض دادیم» پیش‌پرداختِ
 * دو ماهه می‌شد و قرضی که برمی‌گردد ماه‌به‌ماه هزینه می‌شد. «بیمهٔ وام یک‌ساله»
 * نام خدمت دارد و همچنان دوره است.
 */
const LENDING = new RegExp(`(?<![آ-ی])(?:قرض|وام|مساعده)`);

/**
 * طولِ گفته‌شدهٔ پوشش، به ماه؛ `null` یعنی جمله طولی نگفته.
 *
 * `bare` شکل بی‌نشانهٔ «شش ماه» را هم می‌پذیرد — فقط وقتی شروع جدا گفته شده یا
 * متن جواب سؤال دوره است. همین تابع طولِ جمله را برای جواب سؤال شروع هم می‌خواند:
 * کسی که گفته «یک‌ساله»، بعد از گفتن شروع نباید دوباره پایان را بگوید.
 *
 * طولی که خوانده نمی‌شود («سه ماه و نیم») هم `null` است؛ خوانندهٔ دوره آن را از
 * `lengthOf` جدا می‌شناسد و دوره را نمی‌سازد.
 */
export function readServiceLength(input, options = {}) {
  const length = lengthOf(normalizePersian(String(input || '')), options);
  return length === UNREADABLE ? null : length;
}

/** «با ۲ ماه تاخیر»، «ودیعه ۳ ماه»، «معادل ۳ ماه اجاره» — عدد و ماه، ولی طول پوشش نه. */
const BARE_NOT_BEFORE = new RegExp(`(?<![آ-ی])(?:با|ود${YA}عه|رهن|جر${YA}مه|د${YA}رکرد|معادل|اندازه|قدر)${GAP}$`);
/** «۳ ماه عقب بودیم»، «انبار ۶ ماه خالی بود»، «۲ ماه اجاره معوق». */
const BARE_NOT_AFTER = new RegExp(`^(?:${GAP}[^\\s،,.؛]+){0,2}?${GAP}(?:ت[اأ]خ${YA}ر|عقب|خال${YA}|معوق|د${YA}رکرد|د${YA}ر|جر${YA}مه)(?![آ-ی])`);
/** «اجاره ۶ ماه»، «اجاره دفتر برای ۶ ماه» — طول بلافاصله بعد از نام خدمت. */
const BARE_AFTER_SERVICE = new RegExp(`(?<![آ-ی])${SERVICE_NOUN}${COVERAGE_BETWEEN}$`);
/** «۶ ماه اجاره» — طول بلافاصله پیش از نام خدمت. */
const BARE_BEFORE_SERVICE = new RegExp(`^${GAP}${SERVICE_NOUN}`);
/** فاصلهٔ «۶ ماه» تا شروع: هیچ، یا دنبالهٔ طول مرکب («یک سال و شش ماه از مهر»). */
const BARE_START_GAP = new RegExp(`^(?:${GAP}و${GAP}(?:ن${YA}م|[^\\s]+${GAP}ماه))?${GAP}$|^$`);

/**
 * «شش ماه» بی‌نشانه فقط وقتی طول پوشش است که کنار نام خدمت («اجاره شش ماه
 * دفتر»، «شش ماه اجاره») یا کنار شروعِ گفته‌شده («۶ ماه از مهر») آمده باشد.
 *
 * پیش از این هر «N ماه» در جمله، همین که شروعی معلوم بود، طول خوانده می‌شد:
 * «اجاره دفتر از اول مهر با ۲ ماه تاخیر ۱۰ میلیون دادیم» دو ماه پیش‌پرداخت
 * می‌ساخت و «بیمه انبار ۱۲ میلیون دادیم، انبار ۶ ماه خالی بود» بعد از جواب شروع
 * پایانِ حدسی می‌گرفت.
 */
function bareIsLength(text, match, { start = null } = {}) {
  const unitEnd = match.indices[2][1];
  const before = text.slice(0, match.index);
  const after = text.slice(unitEnd);
  if (BARE_NOT_BEFORE.test(before) || BARE_NOT_AFTER.test(after)) return false;
  if (BARE_AFTER_SERVICE.test(before) || BARE_BEFORE_SERVICE.test(after)) return true;
  if (start?.index == null) return false;
  if (start.index >= unitEnd) return BARE_START_GAP.test(text.slice(unitEnd, start.index));
  return match.index >= start.end && BARE_START_GAP.test(text.slice(start.end, match.index));
}

/**
 * `bare`: `true` یعنی متن جواب سؤال دوره است و «شش ماه» هرجا طول است؛
 * `{ start }` یعنی جمله شروعی دارد (`start` جای آن در متن، یا `null` وقتی شروع از
 * جواب آمده) و «شش ماه» فقط کنار نام خدمت یا همان شروع طول است.
 */
function lengthOf(text, { bare = false, consumed = [] } = {}) {
  if (!/ماه|سال/.test(text) || PAST.test(text)) return null;
  const service = COVERAGE_CONTEXT.test(text);
  if (!service && LENDING.test(text)) return null;
  // «برای دو ماه» بی‌نام خدمت هر چیزی می‌تواند باشد — «حقوق کارمندا برای دو ماه»،
  // «به مدت دو ماه قرض دادیم» — پس فقط کنار خدمت دوره‌دار یا در جواب سؤال دوره.
  // «سه ماه آینده» هم همین‌طور: «۳۰ میلیون دادیم برای پارچه سه ماه آینده» زمانِ
  // کالاست و سه ماه هزینهٔ پارچه می‌ساخت.
  const patterns = [ADJECTIVE, ...(bare || service ? [FORWARD, DURATION] : []), ...(bare ? [BARE] : [])];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      // صفت طول در جملهٔ خدمت دوره‌دار («اجاره کامیون حمل بار یکساله»، «لایسنس
      // یکساله میاد») طول پوشش است، نه زمان تحویل؛ پیش از این یازده ماه اجاره
      // همان روز هزینه می‌شد. در جملهٔ کالا («پارچه رو سه ماهه تحویل میدن») زمان تحویل است.
      const leadTimeMatters = pattern !== ADJECTIVE || !service;
      if (termOfPayment(text, match.index) || (leadTimeMatters && deliveryLeadTime(text, match))) continue;
      if (pattern === BARE && bare !== true && !bareIsLength(text, match, bare)) continue;
      const count = monthsOf(match[1]);
      const unitEnd = match.indices[2][1];
      let months = /سال/.test(match[2]) ? count * 12 : count;
      let end = unitEnd;
      if (/سال/.test(match[2])) {
        const tail = YEAR_TAIL.exec(text.slice(unitEnd));
        if (tail) {
          const extra = tail.groups.half ? 6 : monthsOf(tail.groups.count);
          if (!extra || extra >= 12) return UNREADABLE;
          months += extra;
          end = unitEnd + tail[0].length;
          if (tail.groups.half) {
            // «نیم» را خوانندهٔ مبلغ به عددِ بعدش می‌چسباند («نیم ۱۸ میلیون» = ۱۸٫۵):
            // جایش گزارش می‌شود و تا آن را کنار نگذارد، ثبت خودکار نمی‌شود.
            const [from, to] = tail.indices.groups.half;
            consumed.push({ index: unitEnd + from, length: to - from });
            if (NUMBER_NEXT.test(text.slice(end))) return UNREADABLE;
          }
        }
      } else {
        if (MONTH_HALF.test(text.slice(unitEnd))) return UNREADABLE;
        const head = YEAR_HEAD.exec(text.slice(0, match.index));
        if (head) months += monthsOf(head[1]) * 12;
      }
      if (months > 0 && months <= 120) return { months, index: match.index, end };
    }
  }
  return null;
}

const MONTH_NAMES = PERSIAN_MONTHS.map(([name]) => name).sort((left, right) => right.length - left.length).join('|');
const monthNumber = (name) => PERSIAN_MONTHS.find(([candidate]) => candidate === name)?.[1] || 0;

const YEAR_PART = (name) => `(?:${GAP}(?:سال${GAP})?(?<${name}>\\d{4}|\\d{2})(?!\\d)${NOT_A_YEAR})?`;
const DAY_PART = (name, extra) => `(?:(?<${name}>${extra}|${DAY_WORD_PATTERN}|\\d{1,2})${GAP}(?:ام${GAP})?)?`;
const MONTH_PART = (name) => `(?:ماه${GAP})?(?<${name}>${MONTH_NAMES})(?![آ-ی])(?:${GAP}ماه(?![آ-ی]))?`;
const START_DAY = `ابتدا${YA}?`;
const END_DAY = `آخر|اخر|پا${YA}ان|انتها${YA}?`;


/**
 * سالِ گفته‌شده بعد از ماه (`spokenYear`): باورپذیر همان سال است؛ صریح ولی دور
 * («۱۳۹۴»، «۰۸ مبلغ»، «۱۴۱۰») خواندنی نیست و پرسیده می‌شود؛ عددی که سال نیست
 * (`null`) کنار گذاشته می‌شود و سال از تاریخ رویداد می‌آید.
 */
function saidYear(digits, reference) {
  const said = spokenYear(digits, reference.year);
  if (!said) return null;
  return said.plausible ? said.year : UNREADABLE;
}


/**
 * سالِ یک گروهِ تطبیق، و ثبتِ جایش در متن.
 *
 * سالی که دوره از آن خوانده شد، مبلغ نیست؛ جایش (`consumed`) به خروجی می‌رود تا
 * خوانندهٔ مبلغ همان رقم‌ها را کنار بگذارد. تا وقتی خوانندهٔ مبلغ این را نمی‌خواند،
 * سالی که عددی درست پشتش آمده خواندنی نیست: «بیمه سال ۱۴۰۶ ۱۲ میلیون» ۱٬۴۱۸ میلیون
 * پیش‌پرداخت قطعی می‌شد و «اجاره سال ۰۶ ۱۲۰ میلیون» ۱۲۶ میلیون. پرسیدنِ شروع
 * بهتر از ثبت خودکارِ مبلغی است که سال در آن جمع شده.
 */
function takeYear(match, name, text, reference, consumed) {
  const year = saidYear(match.groups[name], reference);
  if (year === null || year === UNREADABLE) return year;
  const [from, to] = match.indices.groups[name];
  consumed.push({ index: from, length: to - from });
  // فراخوانی که همین جای‌ها را پیش از خواندن مبلغ ماسک می‌کند (پارسر)، عددِ
  // پشتِ سال را مبلغی جدا می‌خواند؛ برای او سال خواندنی است.
  return NUMBER_NEXT.test(text.slice(to)) && !consumed.yearsMaskedByCaller ? UNREADABLE : year;
}

/**
 * «از اول فروردین تا آخر اسفند»، «آبان تا اسفند»، «از ۱ آبان تا ۳۰ بهمن» — بازهٔ
 * صریح، با «از» یا بی آن، با روز و سالِ اختیاری کنار هر ماه.
 *
 * بی «از»، «اجاره مهر تا اسفند دفتر» فقط «اجارهٔ مهر» خوانده می‌شد: یک ماه، و
 * ۲۵ میلیون اجارهٔ ماه‌های آینده همان روز هزینه می‌شد.
 */
const MONTH_RANGE = new RegExp(`(?<![آ-ی])(?:(?<from>از)${GAP})?${DAY_PART('startDay', START_DAY)}${MONTH_PART('startMonth')}${YEAR_PART('startYear')}${GAP}(?:تا|الی|لغایت)${GAP}${DAY_PART('endDay', END_DAY)}${MONTH_PART('endMonth')}${YEAR_PART('endYear')}`, 'gd');
/** ماهِ شروع، با فعل ربطِ چسبیده: «شروعش از اول آبانه». */
const START_MONTH_PART = (name) => `(?:ماه${GAP})?(?<${name}>${MONTH_NAMES})(?:ه)?(?![آ-ی])(?:${GAP}ماه(?![آ-ی]))?`;
const START_AT = `${DAY_PART('startDay', START_DAY)}${START_MONTH_PART('startMonth')}${YEAR_PART('startYear')}`;
/** «از اول آبان»، «از فروردین ۱۴۰۵» — شروعِ تنها. */
const START_MONTH = new RegExp(`(?<![آ-ی])از${GAP}${START_AT}(?!${GAP}(?:تا|الی|لغایت)(?![آ-ی]))`, 'd');
/**
 * «که اول آذر شروع میشه»، «که اول آبان فعال میشه»، «اول آذر کلید رو میگیریم» —
 * شروعِ تنها، با فعل شروع به‌جای «از».
 */
const START_VERB = new RegExp(`(?<![آ-ی])${START_AT}${GAP}(?:شروع|آغاز|فعال|کل${YA}د)`, 'd');
/**
 * «تاریخ شروع اول آبان»، «شروعش اول آبانه»، «اعتبارش از اول آبان»، «تحویل کلید
 * اول آبان» — نشانهٔ شروع پیش از تاریخ.
 *
 * بی‌این، «بیمه یکساله ۱۲ میلیون دادیم، تاریخ شروع اول آبان» پوشش را از روز
 * پرداخت می‌گرفت و «اول آبان» تاریخ پرداختِ پارسال خوانده می‌شد.
 */
const START_CUE_WORD = `(?:(?:تار${YA}خ${GAP})?(?:شروع|آغاز|اعتبار|فعال${GAP}?ساز${YA})(?:${GAP}?ش)?|تحو${YA}ل${GAP}کل${YA}د)`;
const START_CUE = new RegExp(`(?<![آ-ی])${START_CUE_WORD}${GAP}(?:از${GAP})?(?::${GAP})?${START_AT}`, 'd');
/** «از اول ماه بعد»، «از ماه بعد»، «از همین ماه». */
const START_RELATIVE = new RegExp(`(?<![آ-ی])(?:از|${START_CUE_WORD})${GAP}(?:از${GAP})?(?:(?:اول|ابتدا${YA}?)${GAP})?(?:(?<current>(?:ا${YA}ن|هم${YA}ن)${GAP}ماه|ماه${GAP}جار${YA})|ماه${GAP}(?:(?<next>بعد${YA}?|[آا]${YA}نده|د${YA}گه|د${YA}گر)|(?<previous>قبل|گذشته|پ${YA}ش)))(?![آ-ی])`, 'd');
/**
 * «از اول ۱۴۰۶»، «از سال ۱۴۰۶»، «از ۱۴۰۶»، «از اول سال بعد»، «از اول امسال».
 * دورقمی فقط پشت «اول» یا «سال» سال است: «از ۱۰ تا ۲۰ مهر» سال ندارد.
 */
const YEAR_START_WORD = `(?:(?:اول|ابتدا${YA}?)${GAP})`;
const START_YEAR = new RegExp(`(?<![آ-ی])(?:از|${START_CUE_WORD})${GAP}(?:از${GAP})?(?:(?:${YEAR_START_WORD}(?:سال${GAP})?|سال${GAP})(?<startYear>\\d{4}|\\d{2})|(?<bareYear>\\d{4}))(?!\\d)${NOT_A_YEAR}(?![آ-ی\\d])|(?<![آ-ی])(?:از|${START_CUE_WORD})${GAP}(?:از${GAP})?${YEAR_START_WORD}?(?:(?<nextYear>سال${GAP}(?:بعد${YA}?|[آا]${YA}نده|د${YA}گه|د${YA}گر))|(?<thisYear>امسال|سال${GAP}جار${YA}))(?![آ-ی])|(?<![آ-ی])(?:از|${START_CUE_WORD})${GAP}(?:از${GAP})?${YEAR_START_WORD}(?<yearStart>سال)(?![آ-ی])(?!${GAP}(?:قبل|گذشته|پ${YA}ش|\\d))`, 'd');
/** «از فردا»، «از پس‌فردا». */
const START_DAY_WORD = new RegExp(`(?<![آ-ی])(?:از|${START_CUE_WORD})${GAP}(?:از${GAP})?(?:(?<dayAfter>پس${GAP}فردا)|(?<tomorrow>فردا))(?![آ-ی])`, 'd');
/**
 * «از» یا نشانهٔ شروعی که پشتش زمانی آمده که خوانده نمی‌شود: «از اواسط آبان»،
 * «شروعش هفته بعد»، «تحویل کلید آخر ماه». شروع گفته شده ولی معلوم نیست؛ دوره از
 * روز پرداخت ساختن یعنی حدس — پس پرسیده می‌شود.
 */
const START_UNREAD = new RegExp(`(?<![آ-ی])(?:از|${START_CUE_WORD})${GAP}(?:از${GAP})?(?:[^\\s\\d،,.؛]+${GAP})?(?:${MONTH_NAMES}|ماه|سال|امسال|هفته|فردا|\\d{4}|\\d{1,2}${GAP}[/\\-.])(?![آ-ی])`);
/**
 * شروعی که هنوز نرسیده («که از اول فروردین شروع میشه»، «اول آذر کلید رو میگیریم»):
 * ماهِ بی‌سالش اولین همان ماه از روز پرداخت به بعد است. در اسفند، «از اول فروردین
 * شروع میشه» فروردینِ پیش روست؛ فروردینِ همین سال پوششی را می‌ساخت که تقریباً
 * تمام شده و یک‌جا هزینه می‌شد.
 */
const FUTURE_START = new RegExp(`^[^،,.؛]{0,30}?(?<![آ-ی])(?:م${YA}${GAP}?(?:شه|شود|شن|شوند|گ${YA}ر${YA}م|گ${YA}رن|گ${YA}رند|ده|دن|دهند|د${YA}م)|خواهد|بشه)(?![آ-ی])`);
/** «از 1405/08/01»، «از ۱/۸/۱۴۰۵». */
const START_DATE = /(?<![آ-ی])از[\s‌]*(?:(?<y1>\d{4})\s*[/\-.]\s*(?<m1>\d{1,2})\s*[/\-.]\s*(?<d1>\d{1,2})|(?<d2>\d{1,2})\s*[/\-.]\s*(?<m2>\d{1,2})\s*[/\-.]\s*(?<y2>\d{4}))(?![\d/\-.])/;
/** «از امروز به مدت یک سال». */
const START_TODAY = new RegExp(`(?<![آ-ی])از${GAP}(?:همین${GAP})?(?:امروز|الان|حالا)(?![آ-ی])`);
/** «از اول مهر تا حالا»: جمعِ گذشته است، نه شروع پوشش. */
const UNTIL_NOW = new RegExp(`^${GAP}(?:تا|الی)${GAP}(?:حالا|الان|امروز)`);

/**
 * «بابت اجاره اردیبهشت ماه» — یک ماه نام‌برده، به‌عنوان موضوع پرداخت.
 *
 * مرز واژه لازم است: «مال» درون «مالیات» و «دی» درون «عیدی» پیدا می‌شد و
 * «مالیات عیدی» دورهٔ دی‌ماه می‌گرفت. «مهر»، «تیر» و «دی» واژه‌های روزمره هم
 * هستند («بابت مهر شرکت»)، پس فقط با «ماه» پشتشان ماه شمرده می‌شوند.
 */
const COMMON_WORD_MONTHS = ['تیر', 'تير', 'مهر', 'دی'];
const DISTINCT_MONTHS = PERSIAN_MONTHS.map(([name]) => name).filter((name) => !COMMON_WORD_MONTHS.includes(name)).join('|');
const NAMED_MONTH = new RegExp(`(?<![آ-ی])(?:بابت|مال|برا${YA}|واسه)(?![آ-ی])${GAP}(?:[^\\s\\d]+[\\s\\u200c]+){0,3}?(?:(${DISTINCT_MONTHS})(?![آ-ی])|(${COMMON_WORD_MONTHS.join('|')})${GAP}ماه)(?![^\\s]*\\d)`, 'd');

/**
 * «اجارهٔ مهر»، «شارژ ماه آبان» — ماه درست پشت نام خدمت دوره‌دار.
 *
 * بی‌حرف «بابت» هم روشن است که ماه موضوع پرداخت است؛ پشت «اجاره» حتی «مهر» و
 * «دی» واژهٔ روزمره نیستند. بدون این، «اجارهٔ مهر» بی‌دوره می‌ماند و برای
 * اجارهٔ همین ماه، شروع دوره پرسیده می‌شد.
 */
const SERVICE_MONTH = new RegExp(`(?<![آ-ی])(?:اجاره|اجاره${GAP}بها|کرا${YA}ه${GAP}(?:دفتر|مغازه|انبار|خانه|خونه)|شارژ|اشتراک)(?:${GAP}${YA}(?![آ-ی])|ٔ)?${GAP}(?:ماه${GAP})?(${MONTH_NAMES})(?![آ-ی])`, 'd');

/**
 * میان نام خدمت و ماهِ نسبی فقط کسره، مکان یا موضوع خدمت، صفت دوره‌ای و «برای/بابت»
 * (`COVERAGE_BETWEEN`، همان قاعدهٔ ماسک تاریخ پرداخت). «اجاره رو ماه پیش دادیم» و
 * «بیمه یکساله ماه پیش دادیم» ماه پیش را زمان پرداخت می‌گویند، نه دورهٔ پوشش.
 */
const BETWEEN = COVERAGE_BETWEEN;
/**
 * ماه و سالِ نسبی («همین ماه»، «ماه قبل»، «سال ۱۴۰۶») فقط پشت نام خدمت دوره‌دار
 * دورهٔ پوشش‌اند. «ماه پیش اجاره دادیم» تاریخ پرداخت است، نه اجارهٔ ماه پیش؛ و
 * «پارچه برای ماه بعد سفارش دادیم» یا «بابت ماه قبل به آقای رضایی دادیم» دوره
 * ندارند — اولی کالاست و دومی شاید تسویهٔ بدهی؛ ساختن دوره برایشان یعنی هزینهٔ حدسی.
 */
const RELATIVE_MONTH = new RegExp(`(?<![آ-ی])${SERVICE_NOUN}${BETWEEN}(?:(?<current>هم${YA}ن|ا${YA}ن)${GAP}ماه|ماه${GAP}(?:(?<thisMonth>جار${YA})|(?<previous>قبل|گذشته|پ${YA}ش(?!${GAP}پرداخت))|(?<next>بعد${YA}?|[آا]${YA}نده|د${YA}گه|د${YA}گر)))(?![آ-ی])`);
const RELATIVE_YEAR = new RegExp(`(?<![آ-ی])${SERVICE_NOUN}${BETWEEN}(?:سال${GAP}(?:مال${YA}${GAP})?(?<year>\\d{4}|\\d{2})(?!\\d)${NOT_A_YEAR}|(?<thisYear>امسال|سال${GAP}جار${YA})|(?<lastYear>پارسال|سال${GAP}(?:قبل|گذشته|پ${YA}ش))|(?<nextYear>سال${GAP}(?:بعد${YA}?|[آا]${YA}نده|د${YA}گه|د${YA}گر)))(?![آ-ی\\d])`, 'd');

/** «تمدید»: پوششِ تازه از پایان قرارداد جاری شروع می‌شود، نه لزوماً از روز پرداخت. */
const RENEWAL = new RegExp(`تمد${YA}د`);

function yearShift(text) {
  if (/پارسال|سال[\s‌]*(?:قبل|گذشته)/.test(text)) return -1;
  if (/سال[\s‌]*(?:بعد|[آا][یي]نده)/.test(text)) return 1;
  return 0;
}

/** روز آخرِ یک ماه شمسی: یک روز پیش از اول ماه بعد. */
function lastDayOf(year, month) {
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const first = persianToISO(nextYear, nextMonth, 1);
  return first ? new Date(new Date(first).getTime() - 86_400_000).toISOString() : null;
}

/** روزِ گفته‌شده در ماه؛ روزی که در آن ماه نیست (۳۱ مهر) روز آخر همان ماه است. */
function dayIn(year, month, day) {
  return persianToISO(year, month, day) || lastDayOf(year, month);
}

function spanOf(startIso, endIso, basis) {
  if (!startIso || !endIso || Date.parse(endIso) < Date.parse(startIso)) return null;
  const from = todayPersian(new Date(startIso));
  const to = todayPersian(new Date(endIso));
  // ماهِ کامل‌شده: ۱ مهر تا ۲۹ اسفند شش ماه است، ۱۵ آبان تا ۱۴ آبانِ بعد دوازده.
  const months = Math.max(1, Math.round(((to.year - from.year) * 12) + (to.month - from.month) + ((to.day - from.day + 1) / 30)));
  return { start: startIso, end: endIso, months, basis };
}

function monthSpan(year, fromMonth, toMonth, basis = 'month') {
  const endYear = toMonth < fromMonth ? year + 1 : year;
  return spanOf(persianToISO(year, fromMonth, 1), lastDayOf(endYear, toMonth), basis);
}

function readRange(text, reference, baseYear, consumed) {
  for (const range of text.matchAll(MONTH_RANGE)) {
    const groups = range.groups;
    // «بیمه دی تا اسفند»: «بیمه دی» نام بیمه‌گر است؛ بی «از» بازه خوانده نمی‌شود.
    if (!groups.from && groups.startMonth === 'دی' && /ب[یي]مه[\s‌]*$/.test(text.slice(0, range.index))) continue;
    // سالِ گفته‌شده بر سال تاریخ رویداد مقدم است؛ اگر فقط سالِ پایان گفته شده،
    // سال شروع از روی ترتیب ماه‌ها پیدا می‌شود.
    const fromMonth = monthNumber(groups.startMonth);
    const toMonth = monthNumber(groups.endMonth);
    const saidStartYear = takeYear(range, 'startYear', text, reference, consumed);
    const saidEndYear = takeYear(range, 'endYear', text, reference, consumed);
    if (saidStartYear === UNREADABLE || saidEndYear === UNREADABLE) return UNREADABLE;
    const startYear = saidStartYear || (saidEndYear ? (toMonth < fromMonth ? saidEndYear - 1 : saidEndYear) : baseYear);
    const endYear = saidEndYear || (toMonth < fromMonth ? startYear + 1 : startYear);
    const startDay = dayOfToken(groups.startDay) || 1;
    const endDay = groups.endDay && !new RegExp(`^(?:${END_DAY})$`).test(groups.endDay) ? dayOfToken(groups.endDay) : null;
    const span = spanOf(dayIn(startYear, fromMonth, startDay), endDay ? dayIn(endYear, toMonth, endDay) : lastDayOf(endYear, toMonth), 'range');
    if (span) return span;
  }
  return null;
}

/**
 * شروعِ گفته‌شده: `{ iso, index, end }`؛ `null` یعنی جمله شروعی نگفته و
 * `UNREADABLE` یعنی شروعی گفته شده که خوانده نمی‌شود.
 */
function readStart(text, reference, baseYear, occurredAt, consumed) {
  const at = (iso, found) => (iso ? { iso, index: found.index, end: found.index + found[0].length } : null);
  const dated = START_DATE.exec(text);
  if (dated) {
    const { y1, m1, d1, d2, m2, y2 } = dated.groups;
    const [year, month, day] = y1 ? [Number(y1), Number(m1), Number(d1)] : [Number(y2), Number(m2), Number(d2)];
    // سالِ زیر ۱۷۰۰ همیشه شمسی است؛ بالاتر میلادی.
    const gregorian = year >= 1700 ? new Date(Date.UTC(year, month - 1, day, 8, 30)) : null;
    const iso = gregorian ? (gregorian.getUTCMonth() === month - 1 ? gregorian.toISOString() : null) : persianToISO(year, month, day);
    if (iso) return at(iso, dated);
  }
  for (const pattern of [START_CUE, START_MONTH, START_VERB]) {
    const found = pattern.exec(text);
    if (!found || UNTIL_NOW.test(text.slice(found.index + found[0].length))) continue;
    const said = takeYear(found, 'startYear', text, reference, consumed);
    if (said === UNREADABLE) return UNREADABLE;
    const month = monthNumber(found.groups.startMonth);
    const day = dayOfToken(found.groups.startDay) || 1;
    let year = said || baseYear;
    if (!said && year === reference.year && FUTURE_START.test(text.slice(found.index + found[0].length))) {
      year = month > reference.month || (month === reference.month && day >= reference.day) ? reference.year : reference.year + 1;
    }
    const iso = dayIn(year, month, day);
    if (iso) return at(iso, found);
  }
  const relative = START_RELATIVE.exec(text);
  if (relative) {
    const { current, previous } = relative.groups;
    const total = (reference.year * 12) + (reference.month - 1) + (current ? 0 : previous ? -1 : 1);
    return at(persianToISO(Math.floor(total / 12), (total % 12) + 1, 1), relative);
  }
  const yearStart = START_YEAR.exec(text);
  if (yearStart) {
    const { startYear, bareYear, nextYear } = yearStart.groups;
    const year = startYear || bareYear ? takeYear(yearStart, startYear ? 'startYear' : 'bareYear', text, reference, consumed)
      : nextYear ? reference.year + 1 : reference.year;
    if (year === UNREADABLE) return UNREADABLE;
    if (year) return at(persianToISO(year, 1, 1), yearStart);
  }
  const later = START_DAY_WORD.exec(text);
  if (later) {
    const days = later.groups.dayAfter ? 2 : 1;
    const { year, month, day } = todayPersian(new Date(Date.parse(occurredAt) + (days * 86_400_000)));
    return at(persianToISO(year, month, day), later);
  }
  const today = START_TODAY.exec(text);
  if (today && !UNTIL_NOW.test(text.slice(today.index + today[0].length))) return at(occurredAt, today);
  const unread = START_UNREAD.exec(text);
  if (unread && !UNTIL_NOW_AFTER.test(text.slice(unread.index))) return UNREADABLE;
  // «بیمه یکساله ۱۲ میلیون دادیم اول آبان»: روزِ پیشِ رو بعد از فعلِ گذشته روز
  // پرداخت نیست (خوانندهٔ تاریخ پرداخت پاکش می‌کند) و بی نشانهٔ شروع هم معلوم
  // نیست شروع پوشش است یا چیز دیگر؛ پوشش از روز پرداخت ساختن حدس است، پس پرسیده می‌شود.
  if (coverageStartsAfterPayment(text, { now: new Date(occurredAt) }).length) return UNREADABLE;
  return null;
}

/** «از اول مهر تا حالا»، «از ماه قبل تا حالا»: جمعِ گذشته است، نه شروع پوشش. */
const UNTIL_NOW_AFTER = new RegExp(`^[^،,.؛]*?(?:تا|الی)${GAP}(?:حالا|الان|امروز)(?![آ-ی])`);

/** «اجارهٔ مهر»، «بابت اردیبهشت ماه» — یک ماهِ نام‌برده. */
function singleMonth(text, baseYear, reference) {
  const named = NAMED_MONTH.exec(text);
  const service = named ? null : SERVICE_MONTH.exec(text);
  const found = named || service;
  const group = named ? (named[1] ? 1 : 2) : 1;
  const month = found ? monthNumber(found[group]) : 0;
  if (!month) return null;
  const [from, to] = found.indices[group];
  return monthList(text, { from, to: named && group === 2 ? found.index + found[0].length : to }, (baseYear * 12) + month - 1, reference, 'month');
}

/**
 * ادامه و آغازِ فهرست ماه‌ها: «مهر و آبان و آذر»، «این ماه و ماه بعد»، «ماه بعد و
 * ماه بعدش»، «مهر، آبان و آذر».
 *
 * پیش از این فقط ماه اول خوانده می‌شد: «اجاره این ماه و ماه بعد رو ۲۰ میلیون
 * دادیم» کل ۲۰ میلیون را هزینهٔ مهر می‌کرد و «اجاره مهر و آبان و آذر» سی میلیون را.
 * فهرستِ پیوسته یک بازه است (از ماه اول تا ماه آخر)؛ فهرستی که پیوسته نیست
 * («مهر و آذر») خوانده نمی‌شود و پرسیده می‌شود — نه یک ماهش، نه بازهٔ حدسی.
 */
const LIST_SEPARATOR = `(?:${GAP}[،,]${GAP}|${GAP}و${GAP})`;
const LIST_NEXT = new RegExp(`^(?:${GAP}ماه(?![آ-ی]))?${LIST_SEPARATOR}(?:(?:ماه${GAP})?(?<named>${MONTH_NAMES})(?![آ-ی])(?:${GAP}ماه(?![آ-ی]))?|(?<current>(?:ا${YA}ن|هم${YA}ن)${GAP}ماه|ماه${GAP}جار${YA})|ماه${GAP}(?:(?<after>بعد${YA}?ش)|(?<next>بعد${YA}?|[آا]${YA}نده|د${YA}گه|د${YA}گر)|(?<before>قبلش)|(?<previous>قبل|گذشته|پ${YA}ش)))(?![آ-ی])`);
/** «این ماه و سه ماه آینده»: چهار ماه یا سه؟ فهرستی که با طول ادامه می‌یابد خوانده نمی‌شود. */
const LIST_COUNTED = new RegExp(`^(?:${GAP}ماه(?![آ-ی]))?${LIST_SEPARATOR}(?:\\d{1,3}|${NUMBER_SOURCE})${GAP}(?:ماه|سال)(?![آ-ی])`);
const LIST_PREVIOUS = new RegExp(`(?<![آ-ی])(?:ماه${GAP})?(${MONTH_NAMES})(?:${GAP}ماه)?${LIST_SEPARATOR}$`);

function monthList(text, { from, to }, first, reference, basis) {
  const months = [first];
  // ماه‌های پیش از ماهِ پیداشده («بابت مهر، آبان»: «مهر» واژهٔ روزمره است و
  // جست‌وجو از «آبان» شروع شده بود).
  for (let before = LIST_PREVIOUS.exec(text.slice(0, from)); before; before = LIST_PREVIOUS.exec(text.slice(0, from))) {
    const month = monthNumber(before[1]);
    let abs = (Math.floor(months[0] / 12) * 12) + month - 1;
    if (abs >= months[0]) abs -= 12;
    months.unshift(abs);
    from = before.index;
  }
  const current = (reference.year * 12) + reference.month - 1;
  let rest = text.slice(to);
  for (let found = LIST_NEXT.exec(rest); found; found = LIST_NEXT.exec(rest)) {
    const { named, current: thisMonth, after, next, before } = found.groups;
    const last = months.at(-1);
    let abs;
    if (named) {
      abs = (Math.floor(last / 12) * 12) + monthNumber(named) - 1;
      if (abs <= last) abs += 12;
    } else if (thisMonth) abs = current;
    else if (after) abs = last + 1;
    else if (before) abs = last - 1;
    else if (next) abs = current + 1;
    else abs = current - 1;
    months.push(abs);
    rest = rest.slice(found[0].length);
  }
  if (LIST_COUNTED.test(rest)) return UNREADABLE;
  if (months.some((abs, index) => index > 0 && abs !== months[index - 1] + 1)) return UNREADABLE;
  const [start, end] = [months[0], months.at(-1)];
  return spanOf(persianToISO(Math.floor(start / 12), (start % 12) + 1, 1), lastDayOf(Math.floor(end / 12), (end % 12) + 1), months.length > 1 ? 'month-list' : basis);
}

/**
 * «اجارهٔ همین ماه»، «اجاره ماه قبل»، «اجاره دفتر برای سال ۱۴۰۶».
 *
 * این‌ها همان «اجارهٔ مهر» و «اجارهٔ شهریور»اند که از قبل خوانده می‌شدند، فقط
 * نسبی گفته شده‌اند؛ بی‌این، برای اجارهٔ همین ماه شروع دوره پرسیده می‌شد.
 */
function relativeSpan(text, reference, consumed = []) {
  const month = RELATIVE_MONTH.exec(text);
  if (month) {
    const { current, thisMonth, previous } = month.groups;
    const total = (reference.year * 12) + (reference.month - 1) + (current || thisMonth ? 0 : previous ? -1 : 1);
    const end = month.index + month[0].length;
    return monthList(text, { from: end, to: end }, total, reference, 'relative-month');
  }
  const year = RELATIVE_YEAR.exec(text);
  if (!year) return null;
  const { year: said, thisYear, lastYear } = year.groups;
  const target = said ? takeYear(year, 'year', text, reference, consumed) : thisYear ? reference.year : lastYear ? reference.year - 1 : reference.year + 1;
  if (target === UNREADABLE) return UNREADABLE;
  return target ? monthSpan(target, 1, 12, 'year') : null;
}

/**
 * دوره‌ای که از ماهِ پرداخت جلوتر می‌رود — یعنی دست‌کم بخشی از پول پیش‌پرداخت
 * است. شروعِ تنها (پایان هنوز پرسیده نشده) هم همین است.
 *
 * «اجارهٔ همین ماه» یا «بدهی اجاره شهریور» دوره دارند ولی چیزی را جلو نمی‌برند:
 * «تسویه»ی آن‌ها بستن همان بدهی یا هزینهٔ همین ماه است، نه پیش‌پرداخت.
 */
export function runsPastMonth(period, occurredAt) {
  if (!period) return false;
  if (!period.end) return true;
  const end = todayPersian(new Date(period.end));
  const paid = todayPersian(new Date(occurredAt));
  return (end.year * 12) + end.month > (paid.year * 12) + paid.month;
}

/**
 * `answer: true` یعنی متن جواب سؤال دوره است، نه یک جملهٔ مالی: خودِ سؤال
 * زمینهٔ پوشش است، پس «از اول مهر» و «شش ماه» بی‌نام خدمت هم دوره‌اند.
 *
 * `start` شروعی است که کاربر در جواب سؤال گفته؛ جمله با آن دوباره خوانده می‌شود
 * تا طولِ گفته‌شده («یک‌ساله تمدید کردیم»، «اجاره شش ماه دفتر») پایان را بسازد.
 */
export function readServicePeriod(input, { occurredAt, answer = false, start: knownStart = null, yearsMasked = false } = {}) {
  // «مهر هزار و چهارصد و پنج» همان «مهر 1405» است؛ بی‌این، بازه شناخته نمی‌شد.
  // آزمون ارزان پیش از تبدیل: تایپ زنده بودجهٔ میلی‌ثانیه‌ای دارد.
  const raw = normalizePersian(String(input || ''));
  const text = /هزار\s+و\s+(?:سیصد|چهارصد)/.test(raw) ? normalizeSpokenYears(raw) : raw;
  if (!/ماه|سال|فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|ابان|آذر|اذر|دی|بهمن|اسفند|\d{4}\s*[/\-.]/.test(text)) return null;
  if (PAST.test(text)) return null;
  if (!occurredAt) return null;
  const consumed = [];
  // `yearsMasked`: فراخوان سال‌های `periodYearSpans` را پیش از خواندن مبلغ ماسک
  // کرده است. سالِ حروفیِ تبدیل‌شده جایی در متن اصلی ندارد و ماسک نشده است.
  if (yearsMasked && text === raw) consumed.yearsMaskedByCaller = true;
  const period = readPeriod(text, { occurredAt, answer, knownStart, consumed });
  if (!period || period === UNREADABLE) return null;
  // جای سال‌های خوانده‌شده در متنِ نرمال‌شده؛ وقتی سالِ حروفی به رقم تبدیل شده،
  // جای رقم‌ها در متن اصلی نیست و گزارش نمی‌شود.
  return consumed.length && text === raw ? { ...period, consumed: consumed.sort((left, right) => left.index - right.index) } : period;
}

/**
 * جای سال‌هایی که خوانندهٔ دوره در جمله سال می‌خواند، حتی وقتی دوره پرسیده
 * می‌شود: «بیمه سال ۱۴۰۶ ۱۲ میلیون دادیم» شروعش را می‌پرسد، ولی «۱۴۰۶» همچنان
 * سال است و خوانندهٔ مبلغ نباید آن را به «۱۲ میلیون» بچسباند (۱٬۴۱۸ میلیون).
 * جای‌ها در متنِ `normalizePersian` شده‌اند؛ سالِ حروفی («هزار و چهارصد و شش»)
 * گزارش نمی‌شود چون جایش در متن اصلی نیست.
 */
export function periodYearSpans(input, { occurredAt } = {}) {
  const text = normalizePersian(String(input || ''));
  if (!occurredAt || /هزار\s+و\s+(?:سیصد|چهارصد)/.test(text) || PAST.test(text) || !/سال|\d{2}/.test(text)) return [];
  const consumed = [];
  readPeriod(text, { occurredAt, answer: false, knownStart: null, consumed });
  // «تا اسفند ۰۵ ۶۰ میلیون»: عددی که بین نام ماه و عددِ دیگر نشسته سالِ همان ماه
  // است (روز پیش از ماه می‌آید)، حتی وقتی خوانندهٔ دوره آن جمله را نمی‌خواند.
  for (const match of text.matchAll(MONTH_YEAR_BEFORE_NUMBER)) {
    const [from] = match.indices.groups.year;
    if (!consumed.some((span) => span.index === from)) consumed.push({ index: from, length: match.groups.year.length });
  }
  return consumed.sort((left, right) => left.index - right.index);
}
const MONTH_YEAR_BEFORE_NUMBER = new RegExp(`(?<![آ-ی])(?:${MONTH_NAMES})(?![آ-ی])(?:${GAP}ماه)?${GAP}(?:سال${GAP})?(?<year>\\d{4}|\\d{2})(?!\\d)(?=[\\s\\u200c]+\\d)`, 'gd');

function readPeriod(text, { occurredAt, answer, knownStart, consumed }) {
  // ماه‌های نام‌برده بر روز پرداخت مقدم‌اند. «بیمهٔ یک‌ساله، از اول فروردین تا
  // آخر اسفند» دوره را از خودِ جمله دارد؛ شروع کردنش از روز پرداخت — که ممکن
  // است مهر باشد — نیمی از پوشش را به آینده هل می‌داد. سال از تاریخ رویداد
  // می‌آید، مگر جمله خودش سال دیگری بگوید.
  const reference = todayPersian(new Date(occurredAt));
  const baseYear = reference.year + yearShift(text);

  const range = readRange(text, reference, baseYear, consumed);
  if (range === UNREADABLE) return UNREADABLE;
  if (range) {
    // بازه و صفتِ ناسازگار («یک‌ساله، از مهر تا اسفند») حدس نمی‌خورد؛ پرسیده می‌شود.
    const length = lengthOf(text, { bare: answer, consumed });
    return length === UNREADABLE || (length && length.months !== range.months) ? null : range;
  }

  const stated = knownStart ? { iso: knownStart } : readStart(text, reference, baseYear, occurredAt, consumed);
  if (stated === UNREADABLE) return UNREADABLE;
  const length = lengthOf(text, { bare: answer || (stated ? { start: stated.index == null ? null : stated } : false), consumed });
  if (length === UNREADABLE) return UNREADABLE;

  // شروع: یا گفته شده، یا ماهِ نام‌بردهٔ کنار طول («اجاره مهر برای شش ماه جلوتر»).
  const named = length && !stated ? singleMonth(text, baseYear, reference) || relativeSpan(text, reference, consumed) : null;
  if (named === UNREADABLE) return UNREADABLE;
  // «اشتراک یک‌ساله سال آینده»: سالِ نام‌برده خودش دوره است؛ طولِ ناسازگار پرسیده می‌شود.
  if (named?.basis === 'year') return named.months === length.months ? named : null;
  const start = stated?.iso || named?.start || null;
  if (start && length) {
    const end = persianPeriodEnd(start, length.months);
    return end ? { start, end, months: length.months, basis: 'start+length' } : null;
  }
  if (start) {
    // شروعِ تنها، فقط در جملهٔ خدمت دوره‌دار؛ پایانش پرسیده می‌شود، نه حدس زده.
    return answer || COVERAGE_CONTEXT.test(text) ? { start, end: null, months: null, basis: 'start' } : null;
  }
  if (length) {
    // «تمدید»: پوشش تازه از پایان قرارداد جاری شروع می‌شود که در جمله نیست؛
    // «یک‌ساله پارسال»: دوره مال سال گذشته است. شروع از روز پرداخت در هر دو
    // حدس است و دو قرارداد را روی ماه‌های یکسان هزینه می‌کرد — پس شروع پرسیده
    // می‌شود و طولِ گفته‌شده بعد از جواب، پایان را می‌سازد.
    if (!answer && (RENEWAL.test(text) || yearShift(text) !== 0)) return null;
    const end = persianPeriodEnd(occurredAt, length.months);
    return end ? { start: occurredAt, end, months: length.months, basis: 'length' } : null;
  }
  return singleMonth(text, baseYear, reference) || relativeSpan(text, reference, consumed);
}
