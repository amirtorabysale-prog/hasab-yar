import {
  DAY_WORD_PATTERN, NOT_A_YEAR, PERSIAN_MONTHS, dayOfToken, normalizeSpokenYears, persianPeriodEnd, persianToISO,
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
const ADJECTIVE = new RegExp(`${NUMBER_PATTERN}${GAP}(ماهه|ساله|سال${GAP}ه)`, 'g');
/** «برای شش ماه جلوتر» — عدد و واحد، با نشانهٔ صریح آینده. */
// تا سه واژه میان مدت و نشانهٔ آینده: «شش ماه دفتر را جلوتر دادیم».
const FORWARD = new RegExp(`${NUMBER_PATTERN}${GAP}(ماه|سال)(?:${GAP}[^\\s.،؛]+){0,3}?${GAP}(?:${['جلوتر', 'جلو', '[آا]' + YA + 'نده', 'بعد', 'پ' + YA + 'ش' + GAP + 'رو', 'آت' + YA, 'پ' + YA + 'ش' + GAP + '?پرداخت'].join('|')})(?![آ-ی])`, 'g');
/** «به مدت شش ماه»، «برای سه ماه»، «ظرف دوازده ماه» — حرف اضافه + طول. */
const DURATION = new RegExp(`(?<![آ-ی])(?:به${GAP}مدت|بمدت|برا${YA}?|واسه|ظرف|ط${YA})${GAP}${NUMBER_PATTERN}${GAP}(ماه|سال)(?![آ-ی])(?!${GAP}${PAST_WORDS})`, 'g');
/**
 * «شش ماه» بی‌صفت و بی‌نشانه، فقط کنار شروعِ گفته‌شده («اجاره شش ماه دفتر رو از
 * مهر دادیم») یا در جواب سؤال دوره. تنها، می‌تواند «شش ماه کار کرد» باشد.
 */
const BARE = new RegExp(`${NUMBER_PATTERN}${GAP}(ماه|سال)(?![آ-ی])(?!${GAP}(?:${PAST_WORDS}|د${YA}گه|د${YA}گر))`, 'g');
/** گذشته: صریحاً یک زمان است، نه دوره. */
const PAST = new RegExp(`${NUMBER_PATTERN}${GAP}(?:ماه|سال)${GAP}${PAST_WORDS}`);

/**
 * زمان تحویل کالا، دورهٔ خدمت نیست.
 *
 * «۳۰ میلیون به تولیدی دادیم برای پارچه که سه ماه بعد تحویل میده» با «سه ماه
 * بعد» پیش‌پرداخت خدمتِ سه‌ماهه می‌شد و پارچه — و حتی دستگاه — طی زمان تحویل
 * هزینه می‌شد. پیش‌پرداخت کالا تا رسیدن کالا دارایی است، نه هزینهٔ ماهانه.
 */
const DELIVERY_VERB = `(?:تحو${YA}ل|م${YA}${GAP}رس|برس|م${YA}${GAP}[آا]${YA}?د|م${YA}اد|ب${YA}اد|ارسال|م${YA}${GAP}فرست|بفرست|حمل|بار${GAP}م${YA}|آماده|م${YA}${GAP}ساز|بساز|نصب)`;
const LEAD_TIME_AFTER = new RegExp(`^${GAP}(?:[^\\s.،؛]+${GAP}){0,1}?${DELIVERY_VERB}`);
const LEAD_TIME_BEFORE = new RegExp(`(?:تحو${YA}ل|ارسال|حمل|رس${YA}دن)[^\\s]*${GAP}(?:[^\\s]+${GAP}){0,2}$`);

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
 */
export function readServiceLength(input, { bare = false } = {}) {
  const text = normalizePersian(String(input || ''));
  if (!/ماه|سال/.test(text) || PAST.test(text)) return null;
  const service = COVERAGE_CONTEXT.test(text);
  if (!service && LENDING.test(text)) return null;
  // «برای دو ماه» بی‌نام خدمت هر چیزی می‌تواند باشد — «حقوق کارمندا برای دو ماه»،
  // «به مدت دو ماه قرض دادیم» — پس فقط کنار خدمت دوره‌دار یا در جواب سؤال دوره.
  const patterns = [ADJECTIVE, FORWARD, ...(bare || service ? [DURATION] : []), ...(bare ? [BARE] : [])];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (termOfPayment(text, match.index) || deliveryLeadTime(text, match)) continue;
      const count = monthsOf(match[1]);
      const months = /سال/.test(match[2]) ? count * 12 : count;
      if (months > 0 && months <= 120) return { months, index: match.index };
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
 * جمله‌ای که دوره‌اش خوانده نمی‌شود، با جمله‌ای که دوره ندارد فرق دارد: اولی نباید
 * به خواننده‌های بعدی برسد. «بیمه از فروردین ۱۳۹۴ تا اسفند ۱۳۹۴» سالِ صریح دارد؛
 * جایگزین کردنش با سال رویداد یعنی ۱۲ میلیون پیش‌پرداختِ ۱۴۰۵ — حدس، نه خواندن.
 */
const UNREADABLE = Object.freeze({ unreadable: true });

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
 * «از اول فروردین تا آخر اسفند»، «آبان تا اسفند»، «از ۱ آبان تا ۳۰ بهمن» — بازهٔ
 * صریح، با «از» یا بی آن، با روز و سالِ اختیاری کنار هر ماه.
 *
 * بی «از»، «اجاره مهر تا اسفند دفتر» فقط «اجارهٔ مهر» خوانده می‌شد: یک ماه، و
 * ۲۵ میلیون اجارهٔ ماه‌های آینده همان روز هزینه می‌شد.
 */
const MONTH_RANGE = new RegExp(`(?<![آ-ی])(?:(?<from>از)${GAP})?${DAY_PART('startDay', START_DAY)}${MONTH_PART('startMonth')}${YEAR_PART('startYear')}${GAP}(?:تا|الی|لغایت)${GAP}${DAY_PART('endDay', END_DAY)}${MONTH_PART('endMonth')}${YEAR_PART('endYear')}`, 'g');
/** «از اول آبان»، «از فروردین ۱۴۰۵» — شروعِ تنها. */
const START_MONTH = new RegExp(`(?<![آ-ی])از${GAP}${DAY_PART('startDay', START_DAY)}${MONTH_PART('startMonth')}${YEAR_PART('startYear')}(?!${GAP}(?:تا|الی|لغایت)(?![آ-ی]))`);
/** «که اول آذر شروع میشه» — شروعِ تنها، با فعل شروع به‌جای «از». */
const START_VERB = new RegExp(`(?<![آ-ی])${DAY_PART('startDay', START_DAY)}${MONTH_PART('startMonth')}${YEAR_PART('startYear')}${GAP}(?:شروع|آغاز)`);
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
const NAMED_MONTH = new RegExp(`(?<![آ-ی])(?:بابت|مال|برا${YA}|واسه)(?![آ-ی])${GAP}(?:[^\\s\\d]+[\\s\\u200c]+){0,3}?(?:(${DISTINCT_MONTHS})(?![آ-ی])|(${COMMON_WORD_MONTHS.join('|')})${GAP}ماه)(?![^\\s]*\\d)`);

/**
 * «اجارهٔ مهر»، «شارژ ماه آبان» — ماه درست پشت نام خدمت دوره‌دار.
 *
 * بی‌حرف «بابت» هم روشن است که ماه موضوع پرداخت است؛ پشت «اجاره» حتی «مهر» و
 * «دی» واژهٔ روزمره نیستند. بدون این، «اجارهٔ مهر» بی‌دوره می‌ماند و برای
 * اجارهٔ همین ماه، شروع دوره پرسیده می‌شد.
 */
const SERVICE_MONTH = new RegExp(`(?<![آ-ی])(?:اجاره|اجاره${GAP}بها|کرا${YA}ه${GAP}(?:دفتر|مغازه|انبار|خانه|خونه)|شارژ|اشتراک)(?:${GAP}${YA}(?![آ-ی])|ٔ)?${GAP}(?:ماه${GAP})?(${MONTH_NAMES})(?![آ-ی])`);

/** تا دو واژه میان نام خدمت و ماه («اجاره خونه ماه بعد»)، به شرط آنکه عدد نباشند. */
const BETWEEN = `(?:${GAP}${YA}(?![آ-ی]))?(?:[\\s\\u200c]+(?!(?:${NUMBER_SOURCE})(?![آ-ی]))[^\\s\\d]+){0,2}?[\\s\\u200c]+`;
/**
 * ماه و سالِ نسبی («همین ماه»، «ماه قبل»، «سال ۱۴۰۶») فقط پشت نام خدمت دوره‌دار
 * دورهٔ پوشش‌اند. «ماه پیش اجاره دادیم» تاریخ پرداخت است، نه اجارهٔ ماه پیش؛ و
 * «پارچه برای ماه بعد سفارش دادیم» یا «بابت ماه قبل به آقای رضایی دادیم» دوره
 * ندارند — اولی کالاست و دومی شاید تسویهٔ بدهی؛ ساختن دوره برایشان یعنی هزینهٔ حدسی.
 */
const RELATIVE_MONTH = new RegExp(`(?<![آ-ی])${SERVICE_NOUN}${BETWEEN}(?:(?<current>هم${YA}ن|ا${YA}ن)${GAP}ماه|ماه${GAP}(?:(?<thisMonth>جار${YA})|(?<previous>قبل|گذشته|پ${YA}ش(?!${GAP}پرداخت))|(?<next>بعد${YA}?|[آا]${YA}نده|د${YA}گه|د${YA}گر)))(?![آ-ی])`);
const RELATIVE_YEAR = new RegExp(`(?<![آ-ی])${SERVICE_NOUN}${BETWEEN}(?:سال${GAP}(?:مال${YA}${GAP})?(?<year>\\d{4}|\\d{2})(?!\\d)${NOT_A_YEAR}|(?<thisYear>امسال|سال${GAP}جار${YA})|(?<lastYear>پارسال|سال${GAP}(?:قبل|گذشته|پ${YA}ش))|(?<nextYear>سال${GAP}(?:بعد${YA}?|[آا]${YA}نده|د${YA}گه|د${YA}گر)))(?![آ-ی\\d])`);

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

function readRange(text, reference, baseYear) {
  for (const range of text.matchAll(MONTH_RANGE)) {
    const groups = range.groups;
    // «بیمه دی تا اسفند»: «بیمه دی» نام بیمه‌گر است؛ بی «از» بازه خوانده نمی‌شود.
    if (!groups.from && groups.startMonth === 'دی' && /ب[یي]مه[\s‌]*$/.test(text.slice(0, range.index))) continue;
    // سالِ گفته‌شده بر سال تاریخ رویداد مقدم است؛ اگر فقط سالِ پایان گفته شده،
    // سال شروع از روی ترتیب ماه‌ها پیدا می‌شود.
    const fromMonth = monthNumber(groups.startMonth);
    const toMonth = monthNumber(groups.endMonth);
    const saidStartYear = saidYear(groups.startYear, reference);
    const saidEndYear = saidYear(groups.endYear, reference);
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

/** شروعِ گفته‌شده، به ISO؛ `null` یعنی جمله شروعی نگفته. */
function readStart(text, reference, baseYear, occurredAt) {
  const dated = START_DATE.exec(text);
  if (dated) {
    const { y1, m1, d1, d2, m2, y2 } = dated.groups;
    const [year, month, day] = y1 ? [Number(y1), Number(m1), Number(d1)] : [Number(y2), Number(m2), Number(d2)];
    // سالِ زیر ۱۷۰۰ همیشه شمسی است؛ بالاتر میلادی.
    const gregorian = year >= 1700 ? new Date(Date.UTC(year, month - 1, day, 8, 30)) : null;
    const iso = gregorian ? (gregorian.getUTCMonth() === month - 1 ? gregorian.toISOString() : null) : persianToISO(year, month, day);
    if (iso) return iso;
  }
  for (const pattern of [START_MONTH, START_VERB]) {
    const found = pattern.exec(text);
    if (!found || UNTIL_NOW.test(text.slice(found.index + found[0].length))) continue;
    const said = saidYear(found.groups.startYear, reference);
    if (said === UNREADABLE) return UNREADABLE;
    const year = said || baseYear;
    const iso = dayIn(year, monthNumber(found.groups.startMonth), dayOfToken(found.groups.startDay) || 1);
    if (iso) return iso;
  }
  const today = START_TODAY.exec(text);
  if (today && !UNTIL_NOW.test(text.slice(today.index + today[0].length))) return occurredAt;
  return null;
}

/** «اجارهٔ مهر»، «بابت اردیبهشت ماه» — یک ماهِ نام‌برده. */
function singleMonth(text, baseYear) {
  const named = NAMED_MONTH.exec(text);
  const service = named ? null : SERVICE_MONTH.exec(text);
  const month = named ? monthNumber(named[1] || named[2]) : service ? monthNumber(service[1]) : 0;
  return month ? monthSpan(baseYear, month, month) : null;
}

/**
 * «اجارهٔ همین ماه»، «اجاره ماه قبل»، «اجاره دفتر برای سال ۱۴۰۶».
 *
 * این‌ها همان «اجارهٔ مهر» و «اجارهٔ شهریور»اند که از قبل خوانده می‌شدند، فقط
 * نسبی گفته شده‌اند؛ بی‌این، برای اجارهٔ همین ماه شروع دوره پرسیده می‌شد.
 */
function relativeSpan(text, reference) {
  const month = RELATIVE_MONTH.exec(text);
  if (month) {
    const { current, thisMonth, previous } = month.groups;
    const total = (reference.year * 12) + (reference.month - 1) + (current || thisMonth ? 0 : previous ? -1 : 1);
    const target = (total % 12) + 1;
    return monthSpan(Math.floor(total / 12), target, target, 'relative-month');
  }
  const year = RELATIVE_YEAR.exec(text);
  if (!year) return null;
  const { year: said, thisYear, lastYear } = year.groups;
  const target = said ? saidYear(said, reference) : thisYear ? reference.year : lastYear ? reference.year - 1 : reference.year + 1;
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
export function readServicePeriod(input, { occurredAt, answer = false, start: knownStart = null } = {}) {
  // «مهر هزار و چهارصد و پنج» همان «مهر 1405» است؛ بی‌این، بازه شناخته نمی‌شد.
  // آزمون ارزان پیش از تبدیل: تایپ زنده بودجهٔ میلی‌ثانیه‌ای دارد.
  const raw = normalizePersian(String(input || ''));
  const text = /هزار\s+و\s+(?:سیصد|چهارصد)/.test(raw) ? normalizeSpokenYears(raw) : raw;
  if (!/ماه|سال|فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|ابان|آذر|اذر|دی|بهمن|اسفند|\d{4}\s*[/\-.]/.test(text)) return null;
  if (PAST.test(text)) return null;
  if (!occurredAt) return null;

  // ماه‌های نام‌برده بر روز پرداخت مقدم‌اند. «بیمهٔ یک‌ساله، از اول فروردین تا
  // آخر اسفند» دوره را از خودِ جمله دارد؛ شروع کردنش از روز پرداخت — که ممکن
  // است مهر باشد — نیمی از پوشش را به آینده هل می‌داد. سال از تاریخ رویداد
  // می‌آید، مگر جمله خودش سال دیگری بگوید.
  const reference = todayPersian(new Date(occurredAt));
  const baseYear = reference.year + yearShift(text);
  const stated = knownStart || readStart(text, reference, baseYear, occurredAt);
  if (stated === UNREADABLE) return null;
  const length = readServiceLength(text, { bare: answer || Boolean(stated) });

  const range = readRange(text, reference, baseYear);
  if (range === UNREADABLE) return null;
  if (range) {
    // بازه و صفتِ ناسازگار («یک‌ساله، از مهر تا اسفند») حدس نمی‌خورد؛ پرسیده می‌شود.
    return length && length.months !== range.months ? null : range;
  }

  // شروع: یا گفته شده، یا ماهِ نام‌بردهٔ کنار طول («اجاره مهر برای شش ماه جلوتر»).
  const named = length && !stated ? singleMonth(text, baseYear) || relativeSpan(text, reference) : null;
  if (named === UNREADABLE) return null;
  // «اشتراک یک‌ساله سال آینده»: سالِ نام‌برده خودش دوره است؛ طولِ ناسازگار پرسیده می‌شود.
  if (named?.basis === 'year') return named.months === length.months ? named : null;
  const start = stated || named?.start || null;
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
  const single = singleMonth(text, baseYear) || relativeSpan(text, reference);
  return single === UNREADABLE ? null : single;
}
