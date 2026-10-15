import { withReviewAssessment } from './review.js';
import { normalizePersian } from './normalize.js';
import { CATEGORY_DEFINITIONS, chartCodeForCategory, classifyCategory } from './categoryRules.js';
import { PERSIAN_MONTHS, extractOccurrenceDate } from './persianDate.js';
import { BANKS, detectBank, detectTransferBanks } from './banks.js';
import { mentionsCapitalOrAsset } from './capitalSpeech.js';
import { readPrepaymentMention } from './prepaymentSpeech.js';
import { periodYearSpans, readServicePeriod } from './periodSpeech.js';
import { readUnpaidSignal } from './accrualSpeech.js';
import { EVENT_NATURES, natureNeedsAccountant, readEventNature } from './eventNature.js';
import { counterpartyMoneyDirection, extractContactCandidate } from './counterpartySpeech.js';
import { withoutVatQualifiers } from './vatSpeech.js';
import { TIME_BOUND_SERVICE_CATEGORIES } from './economicFamily.js';
import { CONTRACT_REFUND_REASON, contractRefundDirection, readContractRefund } from './refundSpeech.js';
import { readPettyCash } from './pettyCashSpeech.js';

const DIGITS = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

const VALUES = {
  صفر: 0, یک: 1, یه: 1, ی: 1, دو: 2, سه: 3, چهار: 4, چار: 4, پنج: 5, شش: 6, شیش: 6, هفت: 7, هشت: 8, نه: 9,
  ده: 10, یازده: 11, دوازده: 12, سیزده: 13, چهارده: 14, پونزده: 15, پانزده: 15, شانزده: 16, هفده: 17, هجده: 18, نوزده: 19,
  بیست: 20, سی: 30, چهل: 40, پنجاه: 50, شصت: 60, شست: 60, هفتاد: 70, هشتاد: 80, نود: 90,
  صد: 100, یکصد: 100, دویست: 200, دویس: 200, سیصد: 300, سیصدتا: 300, چهارصد: 400, چارصد: 400,
  پانصد: 500, پونصد: 500, پنصد: 500, ششصد: 600, شیشصد: 600, ششصدتا: 600,
  // گویش محاوره‌ای که موتور تشخیص گفتار واقعاً تولید می‌کند؛ نبودشان یعنی
  // «هفصد هزار» بی‌صدا ۱۰۰۰ خوانده می‌شد.
  هفتصد: 700, هفصد: 700, هشتصد: 800, هشصد: 800, نهصد: 900, نهصدتا: 900,
};
const FRACTIONS = { نیم: 0.5, نصف: 0.5 };
// پسوند «ی» صفتی همان مقیاس است: «چک سه میلیونی»، «اسکناس پنجاه هزاری»،
// «جنس ده میلیونی». بدون اینها مبلغ هزار یا یک‌میلیون برابر کوچک خوانده
// می‌شد — «چک سه میلیونی گرفتم» سه تومان ثبت می‌کرد — و بدتر، چون عدد از
// مقیاسش جدا می‌افتاد گاهی دو ثبت جداگانه از یک جمله ساخته می‌شد.
const SCALES = {
  هزار: 1_000, هزارتا: 1_000, هزاری: 1_000,
  میلیون: 1_000_000, میلیونی: 1_000_000,
  میلیارد: 1_000_000_000, میلیاردی: 1_000_000_000,
};
const NUMBER_WORDS = new Set([...Object.keys(VALUES), ...Object.keys(FRACTIONS), ...Object.keys(SCALES)]);
// پول آمده به حساب خودِ واحد. آزمون استرس نشان داد این شکل‌های رایج جهت نداشتند
// و «یه پولی اومده تو حساب ملی» یا «اداره دارایی… عودت داد» خروج پول ثبت
// می‌شد — ردیف تراکنش هم با همان جهت غلط ماندهٔ بانک را جابه‌جا می‌کرد.
const INCOME_WORDS = ['فروش', 'درآمد', 'دریافت', 'واریز', 'واریزی', 'گرفتم', 'فروختم', 'فروختیم', 'دخل', 'وصول', 'دستمزد گرفتم', 'به حسابم آمد', 'به حسابم اومد', 'مشتری کارت به کارت کرد',
  'اومده تو حساب', 'اومد تو حساب', 'به حساب اومده', 'به حساب اومد', 'عودت', 'به حساب شرکت انتقال داد', 'به حساب شرکت واریز کرد',
  // «از نوری قرض گرفتیم» پول آمده است، نه رفته؛ «گرفتیم» در «گرفتم» نمی‌گنجد.
  // «گرفتیم»ِ تنها عمداً نیست: «مشاوره/پشتیبانی یکساله/پیتزا گرفتیم» خرید است.
  // «اجاره رو از مستاجر گرفتیم» را نقش پرداخت‌کننده («از مستاجر») و «۲۰ میلیون
  // گرفتیم» را مفعولِ پولیِ فعل (`takenMoney`) وارد می‌کند.
  'قرض گرفت', 'وام گرفت'];
const EXPENSE_WORDS = ['هزینه', 'خرج', 'خرید', 'خریدم', 'خریدیم', 'حقوق', 'اجاره', 'پرداخت', 'دادم', 'دادیم', 'برداشت', 'قبض', 'کرایه', 'مواد', 'واریز کردیم', 'واریز کردم'];
// فعلِ جهت‌دار از اسم قوی‌تر است. «از مشتری ده میلیون گرفتم بابت پیش پرداخت»
// هم «گرفتم» دارد و هم «پرداخت»؛ با شمارش ساده مساوی می‌شدند و نوع بی‌دلیل
// هزینه می‌افتاد. آنچه جهت پول را تعیین می‌کند فعل است، نه اسمِ کنارش.
const INCOME_VERBS = new Set(['گرفتم', 'فروختم', 'فروختیم', 'واریز', 'واریزی', 'دریافت',
  'اومده تو حساب', 'اومد تو حساب', 'به حساب اومده', 'به حساب اومد', 'عودت', 'به حساب شرکت انتقال داد', 'به حساب شرکت واریز کرد',
  'قرض گرفت', 'وام گرفت']);
// «حقوق رو از ملت واریز کردیم»: «واریز» درآمدی شمرده می‌شد و نوع مبهم می‌ماند؛
// واریزِ اول‌شخص، پرداخت ماست.
const EXPENSE_VERBS = new Set(['دادم', 'دادیم', 'خریدم', 'خریدیم', 'برداشت', 'واریز کردیم', 'واریز کردم']);
const LEARNING_STOP_WORDS = new Set(['امروز', 'دیروز', 'تومان', 'تومن', 'تومنی', 'ریال', 'بابت', 'برای', 'از', 'به', 'را', 'رو', 'کردم', 'دادم', 'گرفتم', 'داشتم', 'خریدم', 'فروختم', 'پرداخت', 'هزینه', 'درآمد', 'فروش', 'حقوق', 'و']);

export const FINANCIAL_SPEECH_PHRASES = [
  'تومان', 'تومن', 'ریال', 'هزار', 'میلیون', 'میلیارد', 'نیم', 'فروش', 'درآمد', 'هزینه',
  'حقوق', 'اجاره', 'خرید', 'پرداخت', 'دریافت', 'مواد', 'کالا', 'قبض', 'کرایه', 'اسنپ',
];

export { normalizePersian };

// «جمع + اجزا» یک رویداد است، نه چند جابه‌جایی پول. تا وقتی مبلغ قابل ثبت و
// تفکیک سند جداگانه تأیید نشده، حتی ردیف نقدی هم نباید ساخته شود.
export const COMPOSITE_AMOUNT_MESSAGE = 'چند مبلغ برای یک رویداد گفته شد (جمع و اجزا)؛ هیچ ثبتی انجام نشد. مبلغ پرداخت یا دریافت و تفکیک اصل، سود، مالیات یا کسورات را با سند اصلی در بخش بررسی حسابداری مشخص کن.';
// واژهٔ نرخ پیش از مبلغ: «ماهی/ماهیانه/هر ماه(ه)/در ماه»، «سالی/سالانه/هر سال»،
// «هفته‌ای/هفتگی»، «روزی/روزانه»؛ با «ای»ِ محاوره‌ای («ماهی‌ای»، «سالی‌ای»).
// «اجاره یکساله ۱۲۰ میلیون، سالی ۱۲۰ میلیون دادیم» دو خروج ۱۲۰ میلیونی می‌ساخت.
const RATE_BEFORE = /(?:ماهیانه|ماهانه|(?<![آ-ی])ماهی(?:\s*ای)?|هر\s*ماهه?|در\s*ماه|ماهی\s*یک|سالانه|سالیانه|(?<![آ-ی])سالی(?:\s*ای)?|هر\s*ساله?|روزانه|(?<![آ-ی])روزی(?:\s*ای)?|هر\s*روز|هفتگی|(?<![آ-ی])هفته\s*ای|هر\s*هفته|قسطی|قسط\s*ماهانه)\s*(?:مبلغ\s*)?$/;
const RATE_AFTER = /^\s*(?:تومان|تومن|ریال)?\s*(?:در|هر|برای\s*هر|به\s*ازای\s*هر)\s*(?:ماه|سال|روز|هفته)ه?(?![آ-ی])|^\s*(?:تومان|تومن|ریال)?\s*(?:ماهیانه|ماهانه|سالانه|سالیانه|روزانه|هفتگی)(?![آ-ی])/;

/**
 * تغییر نرخ یا نرخ تازه، پرداخت نیست: «از ماه بعد اجاره ۲ میلیون اضافه شد،
 * مابه‌التفاوت شش ماه ۱۲ میلیون رو دادیم» یک پرداخت ۱۲ میلیونی است؛ «۲ میلیون
 * اضافه شد» فقط می‌گوید نرخ ماهانه چقدر بالا رفت. همین است «۲ میلیون رفت بالا»،
 * «۲ میلیون گرون شد»، «۱ میلیون کم شد» و سطح تازهٔ نرخ: «اجاره ۵ میلیون شد،
 * ۳۰ میلیون برای شش ماه دادیم»، «از ماه بعد ۷ میلیون میشه». «۲ میلیون اضافه
 * دادیم» (اول‌شخص) پرداخت است و اینجا نمی‌گنجد؛ فعل خودِ مبلغ همیشه برنده است.
 */
const RATE_INCREASE_AFTER = /^\s*(?:تومان|تومن|ریال)?\s*(?:(?:(?:اضافه|افزایش|گرون|گران|زیاد|بیشتر|کم|کاهش|ارزون|ارزان)\s*(?:تر\s*)?(?:شد|شده|شده\s*است|میشه|می\s*شود|کرد|کردن|کردند|یافت|یافته|پیدا\s*کرد|داشت))|(?:رفت|میره|می\s*رود)\s*بالا|بالا\s*رفت|(?:پایین|پائین)\s*(?:اومد|آمد|اومده|آمده))(?![آ-ی])/;
// «N شد / N میشه» فقط برای قیمتِ دوره‌ای سطح تازهٔ نرخ است. «خرید ۵ میلیون شد
// و حمل ۱ میلیون دادیم» جمع یک خرید است و حذفش حدس می‌شد.
const RATE_LEVEL_AFTER = /^\s*(?:تومان|تومن|ریال)?\s*(?:شد|شده|میشه|می\s*شود)(?![آ-ی])/;
// در گفتار بانکی «کم شد/اضافه شد» یعنی برداشت یا واریز: «سود سپرده ۵ میلیون
// اضافه شد به حساب»، «از حساب ملت ۱۰ میلیون کم شد». این تغییر نرخ نیست.
const ACCOUNT_MOVEMENT_AFTER = /^\s*(?:تومان|تومن|ریال)?\s*\S+(?:\s*\S+)?\s*(?:شد|شده|کرد|کردن|کردند)?\s*(?:از|به|تو|توی)\s*(?:حساب|کارت|بانک)(?![آ-ی])/;
const ACCOUNT_MOVEMENT_BEFORE = /(?:از|به|تو|توی)\s*(?:حساب|کارت|بانک)(?![آ-ی])[^،,.؛]*$/;
// مبلغِ دیگری که پرداختِ همان تغییر است: مابه‌التفاوت، یا کلِ یک دوره.
const DIFFERENCE_WORD = /مابه\s*التفاوت|ما\s*به\s*التفاوت|(?<![آ-ی])(?:تفاوت|اختلاف)(?![آ-ی])/;
const PERIOD_WORD = /(?<![آ-ی])(?:\d+|یک|یه|دو|سه|چهار|پنج|شش|شیش|هفت|هشت|نه|ده|یازده|دوازده)\s*(?:ماه|ماهه|سال|ساله)(?![آ-ی])|(?<![آ-ی])(?:یکساله|یکسال|دوساله)(?![آ-ی])|برای\s*(?:یک|یه)?\s*سال(?![آ-ی])/;
const PAYMENT_VERB = /(?<![آ-ی])(?:دادیم|دادم|داد|دادن|پرداخت|واریز|ریختیم|ریختم|ریخت|زدیم|زدم|گرفتیم|گرفتم|خریدیم|خریدم|کارت\s*به\s*کارت)/;
// ودیعه و رهن کلِ اقساط یک نرخ نیستند؛ پول جدایی‌اند که برمی‌گردد.
const DEPOSIT_HEAD = /(?<![آ-ی])(?:ودیعه|رهن|سپرده|تضمین)/;
const CURRENCY_ONLY = /^[\s،,]*(?:(?:تومان|تومن|ریال)[\s،,]*)?$/;

/**
 * مبلغ‌هایی که نرخ دوره‌اند، وقتی مبلغ دیگری کنارشان هست، کنار می‌روند.
 *
 * گزارش کاربر (۱۸ مهر ۱۴۰۵): «بیمهٔ یک‌ساله ۱۲ میلیون، ماهیانه ۱ میلیون». همین
 * جمله با فعل در آخرش («… ماهیانه ۱ میلیون تومان پرداخت شد») کل ۱۲ میلیون را
 * دور می‌ریخت و پیش‌پرداخت یک‌میلیونی ثبت می‌کرد، و بی‌فعلش دو ردیف ۱۲ و ۱
 * می‌ساخت. سه قاعدهٔ زبانی:
 *
 * ۱. **واژهٔ نرخ مال مبلغ بعدی است.** در «۱۲ میلیون (تومان) ماهیانه ۱ میلیون»
 *    «ماهیانه» پیش از مبلغی می‌آید که توصیفش می‌کند؛ کل را نرخ نمی‌کند. «حقوق
 *    ۱۰ میلیون ماهیانه» (بی‌مبلغ بعدی) همچنان نرخ است.
 * ۲. **فعل آخر جمله، فعل مشترک است.** فعلی که بعد از نرخ آمده فقط وقتی فعلِ
 *    خودِ نرخ است که مبلغ قبلی فعل خودش را گرفته باشد یا نرخ «هم» داشته باشد:
 *    «ودیعه ۵۰ میلیون دادیم و اجارهٔ ماهانه ۵ میلیون هم دادیم» دو پرداخت است.
 * ۳. **نرخ بی‌کل، نرخ نیست.** ودیعه کلِ نرخ اجاره نیست؛ اگر جز نرخ‌ها و ودیعه
 *    مبلغی نماند («حقوق ماهیانه ۱۰ و اجاره ماهیانه ۵ میلیون دادیم»، «اجاره
 *    ماهانه ۵ میلیون و ودیعه ۵۰ میلیون دادیم») همهٔ مبلغ‌ها می‌مانند — حذف
 *    بی‌صدای یک پرداخت واقعی، حدس است.
 */
// موضوعِ تغییرِ نرخ: قیمت دوره‌ای (اجاره، بیمه، اشتراک) یا حقوق. «کارمزد ۲۰۰ هزار
// کم شد» برداشت بانک است، نه تغییر نرخ.
// تابع، نه ثابت: economicFamily → purchasePurpose → partnerPaidSpeech → … → parser
// یک چرخهٔ import است و این فهرست هنگام بارگذاری parser هنوز ساخته نشده.
const rateChangeSubjects = () => [...TIME_BOUND_SERVICE_CATEGORIES, 'حقوق و دستمزد'];
// افزایش بی‌ابهام؛ «کم شد» تنها در گفتار بانکی کسرِ پول هم هست.
const RATE_RAISE_AFTER = /^\s*(?:تومان|تومن|ریال)?\s*(?:(?:اضافه|افزایش|گرون|گران|زیاد|بیشتر)\s*(?:تر\s*)?(?:شد|شده|شده\s*است|میشه|می\s*شود|کرد|کردن|کردند|یافت|یافته|پیدا\s*کرد|داشت)|(?:رفت|میره|می\s*رود)\s*بالا|بالا\s*رفت)(?![آ-ی])/;
export const RATE_CHANGE_REASON = 'این مبلغ تغییر نرخ را می‌گوید («اضافه شد»، «… شد»)، نه لزوماً پرداخت؛ اینکه پولی جابه‌جا شده یا نه با حسابدار است.';

export function withoutRateAmounts(text, spans) {
  if (!spans.length) return spans;
  const leadingOf = (index) => text.slice(spans[index - 1]?.end ?? 0, spans[index].start);
  const changeSubject = (index) => {
    const found = classifyCategory(leadingOf(index));
    return found.matched && rateChangeSubjects().includes(found.category);
  };
  const accountMovement = (span, index) => ACCOUNT_MOVEMENT_AFTER.test(text.slice(span.end, span.end + 30)) || ACCOUNT_MOVEMENT_BEFORE.test(leadingOf(index));
  if (spans.length < 2) {
    // «اجاره ۲ میلیون اضافه شد» تنها: افزایش نرخ است، نه پرداخت؛ ردیفش با حسابدار.
    const [span] = spans;
    const raise = RATE_RAISE_AFTER.test(text.slice(span.end, span.end + 30)) && changeSubject(0) && !accountMovement(span, 0);
    return raise ? [{ ...span, rateChange: true }] : spans;
  }
  const ownVerb = (span, index) => {
    const next = spans[index + 1]?.start ?? text.length;
    const clause = text.slice(span.end, next).split(/[.،,؛;\n]/)[0];
    if (!PAYMENT_VERB.test(clause)) return false;
    if (index === 0) return true;
    // فعلِ بعد از نرخ، فعل مشترک جمله است مگر مبلغ قبلی فعل خودش را داشته باشد.
    const gap = text.slice(spans[index - 1].end, span.start);
    return PAYMENT_VERB.test(gap) || /(?<![آ-ی])هم(?![آ-ی])/.test(clause);
  };
  const rateWordBelongsToNext = (span, index) => {
    const next = spans[index + 1];
    if (!next) return false;
    const between = text.slice(span.end, next.start);
    const match = RATE_BEFORE.exec(between);
    return Boolean(match) && CURRENCY_ONLY.test(between.slice(0, match.index));
  };
  const leading = (index) => text.slice(spans[index - 1]?.end ?? 0, spans[index].start);
  // دنبالهٔ بندِ خودِ مبلغ تا اولین مرز («و»، ویرگول): «۲ میلیون هم شارژ دادیم».
  const trailing = (index) => text.slice(spans[index].end, spans[index + 1]?.start ?? text.length)
    .split(/[.،,؛;\n]|(?<![آ-ی])و(?![آ-ی])/)[0];
  const category = (fragment) => {
    const found = classifyCategory(fragment);
    return found.matched ? found.category : null;
  };
  // موضوعِ بندِ پیش از مبلغ؛ «تومان ماهیانه» موضوعی ندارد و مال کلِ کنارش است.
  const subject = (index) => category(leading(index));
  // موضوعِ بندِ خودِ مبلغ، پیش یا پس از آن: «اجاره ۱۰ میلیون شد، ۲ میلیون هم
  // شارژ دادیم» — موضوعِ ۲ میلیون «شارژ» است که پس از مبلغ آمده.
  const ownSubject = (index) => subject(index) || category(trailing(index));
  // تغییر یا سطحِ تازهٔ نرخ: «۲ میلیون اضافه شد»، «۵ میلیون شد». جابه‌جاییِ حساب
  // («۵ میلیون اضافه شد به حساب»، «از حساب ملت ۱۰ میلیون کم شد») نیست.
  const changeOf = (span, index) => {
    const after = text.slice(span.end, span.end + 30);
    if (accountMovement(span, index) || !changeSubject(index)) return false;
    return RATE_INCREASE_AFTER.test(after) || (RATE_LEVEL_AFTER.test(after) && TIME_BOUND_SERVICE_CATEGORIES.includes(subject(index)));
  };
  const changes = spans.map((span, index) => changeOf(span, index) && !ownVerb(span, index));
  const isRate = (span, index) => {
    const before = RATE_BEFORE.test(text.slice(Math.max(0, span.start - 24), span.start));
    const after = text.slice(span.end, span.end + 30);
    const rateAfter = RATE_AFTER.test(after) && !rateWordBelongsToNext(span, index);
    return changes[index] || ((before || rateAfter) && !ownVerb(span, index));
  };
  const rates = spans.map(isRate);
  const totals = spans.map((_, index) => index).filter((index) => !rates[index] && !DEPOSIT_HEAD.test(leading(index)));
  const sameSubject = (index, total) => {
    const own = subject(index);
    const theirs = ownSubject(total);
    return !own || !theirs || theirs === own;
  };
  // نرخِ یک موضوع، کلِ موضوع دیگر را ندارد: «حقوق ۱۰ میلیون ماهیانه و اجاره ۳۰
  // میلیون شش ماهه دادیم» دو پرداخت است، نه یک اجاره با نرخ حقوق.
  //
  // تغییرِ نرخ سخت‌گیرتر است، چون «شد» و «کم شد» در گفتار شکل پرداخت هم هست:
  // فقط وقتی کنار می‌رود که مبلغ دیگر پرداختِ همان تغییر باشد — مابه‌التفاوت، کلِ
  // یک دوره، یا مضربی از همان نرخ. «اجاره ۱۰ میلیون شد، ۲ میلیون هم شارژ دادیم»
  // دو پرداخت است و حذف بی‌صدای اجاره حدس بود.
  const paysForChange = (index, total) => {
    const own = `${leading(total)} ${trailing(total)}`;
    const ratio = spans[total].amount / spans[index].amount;
    return DIFFERENCE_WORD.test(own) || PERIOD_WORD.test(own) || (Number.isInteger(ratio) && ratio >= 2 && ratio <= 36);
  };
  const droppable = (index) => totals.some((total) => sameSubject(index, total)
    && (!changes[index] || paysForChange(index, total)));
  // تغییرِ نرخی که پرداختِ همان تغییر کنارش نیست، بی‌صدا حذف نمی‌شود و بی‌صدا هم
  // پرداخت ثبت نمی‌شود: ردیفش با حسابدار است. «… ۲ میلیون هم شارژ دادیم» با «هم»
  // می‌گوید مبلغ قبلی هم پرداخت شده است.
  const alsoPaidNext = (index) => {
    const next = spans[index + 1];
    if (!next) return false;
    const clause = text.slice(next.start, spans[index + 2]?.start ?? text.length);
    return /(?<![آ-ی])هم(?![آ-ی])/.test(clause) && PAYMENT_VERB.test(clause);
  };
  return spans.flatMap((span, index) => {
    if (rates[index] && droppable(index)) return [];
    return changes[index] && !alsoPaidNext(index) ? [{ ...span, rateChange: true }] : [span];
  });
}

export function hasCompositeAmounts(input) {
  const normalized = normalizePersian(input);
  const spans = extractAmounts(normalized).spans;
  if (spans.length < 2) return false;
  return /سرمایه.*(?:افزایش|کاهش)|بدهکار.*(?:ببخش|می بخشم|می‌بخشم)/.test(normalized)
    || totalThenParts(spans)
    || /شامل|از این مبلغ|جمع کل|مجموع|تفکیک|ناخالص|(?:اصل\s*(?:وام|قسط|تسهیلات)?\s*و\s*(?:سود|بهره))/.test(normalized)
    || /(?:قسط|وام).*(?:اصل).*(?:سود|بهره)/.test(normalized)
    || /(?:اصل\s*(?:وام|قسط|تسهیلات)|سهم\s*کارمند|بهای\s*کالا).*(?:سود|بهره|مالیات|بیمه)/.test(normalized)
    || PART_OF_TOTAL.test(normalized)
    // «۱۵ میلیون فروختیم، ۱ میلیون تخفیف دادیم و ۱۴ میلیون زد»: ۱۵ به بانک
    // می‌نشست، در حالی که ۱۴ آمده بود. تخفیف با چند مبلغ، کل و جزء است. جملهٔ
    // چک بیرون می‌ماند: کارت چک خودش مبلغِ مانده را از ثبت‌کننده می‌پرسد.
    // «۱ میلیون ازش کم کردیم» همان تخفیف است؛ «کارمزدش کم شد» (مجهول، کار بانک)
    // نیست و کارت انتقال خودش کارمزد را جدا می‌کند.
    || (/(?<![آ-ی])(?:تخفیف|(?:کم|کسر)\s*کرد(?:یم|م|ن|ند)?(?![آ-ی]))/.test(normalized) && !/(?<![آ-ی])چک(?![آ-ی])/.test(normalized));
}

/**
 * «۴۰ میلیون از ملت دادیم: ۳۰ میلیون بیمه … و ۱۰ میلیون اجاره …» — کلی که اجزایش
 * پشتش آمده‌اند. سه ردیف ۴۰ و ۳۰ و ۱۰ ساخته می‌شد و با «تأیید» هر سه، ۸۰ میلیون از
 * بانک می‌رفت (آزمون زندهٔ موتور ۵، ۲۲ مهر ۱۴۰۵). نشانه عددی است، نه واژه: مبلغِ اول
 * دقیقاً جمعِ دست‌کم دو مبلغِ بعدی است. تصادفِ جمع («۱۵ قبض، ۱۰ اجاره و ۵ شارژ») هم
 * فقط به پرونده یا حسابدار می‌رود — هیچ‌وقت ثبت غلط نمی‌سازد.
 */
function totalThenParts(spans) {
  const values = spans.map((span) => span.amount).filter((value) => Number.isSafeInteger(value) && value > 0);
  if (values.length < 3) return false;
  const [first, ...rest] = values;
  return rest.reduce((sum, value) => sum + value, 0) === first;
}

/**
 * جزء یک کل، به زبان محاوره.
 *
 * «۸۰ میلیون فروختیم؛ ۳۰ میلیونش رو واریز کرد و بقیه‌اش رو آخر ماه می‌ده»
 * دو فروش ۸۰ و ۳۰ به بانک ثبت می‌کرد: ۱۱۰ میلیون فروش، و ۵۰ میلیونِ نسیه هم
 * نقد. «میلیونش»، «تاش» و «بقیه/مابقی/باقیمانده» یعنی عدد دوم بخشی از اولی است،
 * نه رویداد تازه — همان نشانهٔ «شامل» و «جمع کل»، فقط به زبان گفتار.
 */
const PART_OF_TOTAL = /(?:هزار|میلیون|میلیارد|تومن|تومان|تا)ی?(?:ش|شو|شم|شون)(?![آ-ی])|(?<![آ-ی])(?:بقیه|بقیش|بقیشو|مابقی|الباقی|باقیش|باقیمانده|باقی\s*مانده)(?![آ-ی])/;

// موتور تشخیص گفتار عدد و مقیاس را گاهی سرِ هم می‌نویسد («دوهزار»، «دومیلیون»)
// یا «و» را به عدد می‌چسباند («سیصدو»). بدون این ترمیم، هیچ مبلغی پیدا نمی‌شد.
const JOINABLE_VALUES = Object.keys(VALUES).sort((left, right) => right.length - left.length);
const SCALE_WORDS = Object.keys(SCALES).sort((left, right) => right.length - left.length);
const JOINED_SCALE_PATTERN = new RegExp(`(?<![آ-ی])(${JOINABLE_VALUES.join('|')})(${SCALE_WORDS.join('|')})(?![آ-ی])`, 'g');
const TRAILING_VAV_PATTERN = new RegExp(`(?<![آ-ی])(${JOINABLE_VALUES.join('|')})و(?![آ-ی])`, 'g');

// پسوند محاوره‌ای روی واژهٔ مقیاس: «پنجاه میلیونیش»، «چهل میلیونشو»، «ده
// هزارشو». بدون جدا کردنش واژهٔ مقیاس شناخته نمی‌شد و «بدهی پنجاه میلیونیش»
// یک ثبت پنجاه‌تومانی می‌ساخت — در آزمون استرس، به صف حسابدار با مبلغی
// یک‌میلیون‌بار کوچک‌تر.
const SCALE_ABBREVIATION = /^\s*(میل|م|ت|m|M|k|K)(?![آ-یa-zA-Z])/;
const MILLION_ABBREVIATIONS = ['م', 'میل', 'm', 'M'];
const THOUSAND_ABBREVIATIONS = ['ت', 'k', 'K'];
const SCALE_SUFFIX_PATTERN = /(?<![آ-ی])(هزار|میلیون|میلیارد)(?:ی(?:ش|شو|شم|شون)|ش|شو|شم|شون)(?![آ-ی])/g;
// «است»ِ چسبیده به مقیاس، پس از عدد: «قسط اولش ده میلیونه» و «قیمتش دو
// میلیونه» ده و دو تومان خوانده می‌شدند. فقط پس از عدد، تا «هزاره» مبلغ نشود.
const SCALE_COPULA_PATTERN = new RegExp(`(?<=(?:\\d|(?<![آ-ی])(?:${JOINABLE_VALUES.join('|')}))\\s*)(هزار|میلیون|میلیارد)(?:ی)?ه(?![آ-ی])`, 'g');

export function repairNumberSpeech(text) {
  return String(text || '')
    .replace(SCALE_SUFFIX_PATTERN, '$1')
    .replace(SCALE_COPULA_PATTERN, '$1')
    .replace(JOINED_SCALE_PATTERN, '$1 $2')
    .replace(TRAILING_VAV_PATTERN, '$1 و')
    .replace(/\s+/g, ' ')
    .trim();
}

// یک گفته یک مرجع زمانی دارد. تا امروز «دیروز» کاملاً نادیده گرفته می‌شد و سند
// در تاریخ اشتباه، یعنی در دورهٔ مالی اشتباه، می‌نشست.
const RELATIVE_DAYS = [
  [/پریروز/, -2, 'پریروز'],
  [/دیروز/, -1, 'دیروز'],
  [/هفته\s*ی?\s*(?:پیش|گذشته|قبل)/, -7, 'هفتهٔ پیش'],
];

export function relativeDayOffset(text) {
  const normalized = normalizePersian(text);
  for (const [pattern, days, label] of RELATIVE_DAYS) if (pattern.test(normalized)) return { days, label };
  return null;
}

function parseNumericToken(token) {
  const value = String(token || '');
  if (!/^\d[\d,.]*$/.test(value)) return null;
  const commaParts = value.split(',');
  const dotParts = value.split('.');
  if (commaParts.length > 2 || (commaParts.length === 2 && commaParts[1].length === 3)) return Number(value.replace(/,/g, ''));
  if (dotParts.length > 2 || (dotParts.length === 2 && dotParts[1].length === 3)) return Number(value.replace(/\./g, ''));
  if (commaParts.length === 2) return Number(`${commaParts[0]}.${commaParts[1]}`);
  return Number(value);
}

/**
 * «یه» و «یک» پیش از عدد دیگر، حرف تعریف‌اند نه عدد.
 *
 * «یه سی تومن» را ۳۱ می‌خواند، چون «یه» و «سی» با هم جمع می‌شدند. مبلغ اشتباه
 * بدترین نوع خطاست: سند با عددی غلط ثبت می‌شود و هیچ نشانه‌ای هم ندارد.
 *
 * پیش از **مقیاس** دست نمی‌خورد: «یک میلیون» باید یک میلیون بماند.
 */
function dropLeadingArticle(tokens) {
  if (tokens.length < 2) return tokens;
  const [first, second] = tokens;
  if (first !== 'یه' && first !== 'یک') return tokens;
  if (SCALES[second] || FRACTIONS[second] != null) return tokens;
  return VALUES[second] != null || /^\d/.test(second) ? tokens.slice(1) : tokens;
}

export function wordsToNumber(tokens) {
  const normalizedTokens = dropLeadingArticle(tokens.map(normalizePersian).filter(Boolean));
  const shorthandSeparator = normalizedTokens.lastIndexOf('و');
  const hasExplicitScale = normalizedTokens.some((token) => SCALES[token] || FRACTIONS[token] != null);
  if (!hasExplicitScale && shorthandSeparator > 0 && shorthandSeparator < normalizedTokens.length - 1) {
    const leading = wordsToNumber(normalizedTokens.slice(0, shorthandSeparator));
    const trailing = wordsToNumber(normalizedTokens.slice(shorthandSeparator + 1));
    // در گفتار مالی «یک و دویست» یا «دوازده و پونصد» به‌ترتیب
    // ۱٫۲ و ۱۲٫۵ میلیون تومان است. شرط‌ها مانع تبدیل «صد و بیست» می‌شوند.
    if (leading > 0 && leading < 100 && trailing >= 100 && trailing < 1_000) {
      return Math.round(leading * 1_000_000 + trailing * 1_000);
    }
  }
  let total = 0;
  let current = 0;
  let lastLargeScale = 0;
  for (const token of normalizedTokens) {
    if (!token || token === 'و') continue;
    const numeric = parseNumericToken(token);
    if (numeric != null) current += numeric;
    else if (VALUES[token] != null) current += VALUES[token];
    else if (FRACTIONS[token] != null) current += FRACTIONS[token];
    else if (SCALES[token]) {
      const scale = SCALES[token];
      total += (current || 1) * scale;
      current = 0;
      lastLargeScale = scale >= 1_000_000 ? scale : 0;
    }
  }
  // در گفتار روزمره «دو میلیون و پونصد» یعنی دو میلیون و پانصد هزار.
  if (current && lastLargeScale >= 1_000_000 && current < 1) total += current * lastLargeScale;
  else if (current && lastLargeScale >= 1_000_000 && current < 1_000) total += current * (lastLargeScale / 1_000);
  else total += current;
  return Math.round(total);
}

function tokenize(text) {
  return [...text.matchAll(/[0-9][0-9,.]*|[آ-ی]+/g)]
    .map((match) => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
}

function isNumericWord(value) { return /^\d/.test(value) || NUMBER_WORDS.has(value); }

// نام ماه پس از عدد یعنی تاریخ، نه مبلغ. بدون این، «۲۵ مرداد قبض دادم» یک ثبت
// بیست‌وپنج تومانی می‌ساخت — همان خطای بی‌صدایی که در بخش مبلغ بسته شد.
// واحد زمان هم مبلغ نیست و این در آزمون صوتی روی سناریوهای واقعی پیدا شد:
// «برای شش ماه جلوتر تسویه کردم» یک تراکنش شش تومانی می‌ساخت و «بیمه یک‌ساله»
// یک تراکنش یک‌تومانی. رکورد شبح در دفتر بدتر از ثبت‌نشدن است، چون هیچ‌کس
// دنبالش نمی‌گردد و در تراز هم گم می‌شود.
// شمارش کالا هم مبلغ نیست: «دسته چک پنجاه برگه» یک کارمزد پنجاه تومانی می‌ساخت.
const NON_AMOUNT_UNITS = ['تا', 'عدد', 'نفر', 'کیلو', 'کیلوگرم', 'گرم', 'متر', 'درصد', 'درصدی', 'بسته', 'کارتن',
  'برگ', 'برگه', 'دستگاه', 'جلد', 'قلم', 'جفت', 'لیتر', 'کیسه', 'رول', 'ورق',
  'ماه', 'ماهه', 'ماهانه', 'سال', 'ساله', 'سالانه', 'هفته', 'هفتگی', 'روزه', 'روزانه', 'ساعته',
  ...PERSIAN_MONTHS.map(([name]) => name)];
/**
 * واحد زمان با ضمیر محاوره‌ای: «شش ماهش رو جلو دادیم»، «سه ماهشو»، «یه سالش».
 *
 * «اجاره ماهی ۵ میلیون، شش ماهش رو جلو دادیم ۳۰ میلیون» کنار ۳۰ میلیون یک
 * پیش‌پرداخت شش‌تومانی ثبت می‌کرد: «ماهش» در فهرست واحدها نبود و فیلتر شمارنده
 * هم فقط عددِ چسبیده به مبلغ بعدی را می‌گرفت.
 */
const SUFFIXED_TIME_UNIT = /^(?:ماه|ماهه|سال|ساله|هفته|روز)(?:ش|شو|شم|شون|شونو|اش|اشو)$/;
const IDENTIFIER_PREFIXES = ['شماره', 'فاکتور', 'رسید', 'سفارش', 'کد', 'تلفن', 'موبایل', 'ساعت', 'روز', 'تاریخ'];

/**
 * تاریخ، مبلغ نیست.
 *
 * «امروز ۲۴ میلیون… از اول آبان ۱۴۰۵ تا پایان مهر ۱۴۰۶ پرداخت کردم» دو تراکنش
 * می‌ساخت: ۲۴ میلیون، و یک تراکنش «۱٬۴۰۶ تومانی» از سالِ پایان دوره. روز ماه
 * پیش از نام ماه («۲۰ آذر») از قبل کنار گذاشته می‌شد، ولی سالِ بعد از نام ماه،
 * سال بی‌نام ماه، و تاریخ عددی («۱۴۰۵/۰۷/۱۵») نه — تاریخ عددی حتی بدتر بود:
 * سه بخشش با هم جمع می‌شدند و یک مبلغ ۱۴۲۷ تومانی می‌ساختند.
 *
 * سه قاعده، از قطعی به محتاط:
 *
 * ۱. **تاریخ عددی کامل** — سال/ماه/روز یا روز/ماه/سال با یک جداکنندهٔ یکسان و
 *    محدودهٔ معتبر — پیش از هر چیز پوشانده می‌شود. «2.500.000» تاریخ نیست چون
 *    بخش میانی‌اش ماه نیست.
 * ۲. **سال در بافت تاریخ** — بعد از نام ماه، «ماه» یا «سال»، یا پیش از «شمسی»
 *    و «میلادی» — حتی اگر با حروف گفته شده باشد («مهر هزار و چهارصد و شش»).
 * ۳. **سالِ برهنه** — عدد چهاررقمی ۱۳۰۰ تا ۱۴۹۹ (یا ۱۹۰۰ تا ۲۱۰۰) که هیچ واحد
 *    پولی پشتش نیست. «۱۴۰۵ تومان» مبلغ می‌ماند؛ «مالیات ۱۴۰۴» نه.
 *
 * در هر سه حالت، واحد پولِ چسبیده («… ۱۴۰۵ تومان») قاعده را لغو می‌کند.
 */
const isYearLike = (value) => (value >= 1300 && value <= 1499) || (value >= 1900 && value <= 2100);
const MONEY_AFTER = /^(?:تومان|تومن|ریال|هزار|میلیون|میلیارد|دلار|یورو|درهم)/;
const DATE_SUFFIX = /^(?:شمسی|هجری|ه\s*\.?\s*ش|میلادی)/;
// «هزار و چهارصد و پنج تا آخر شهریور»: سالی که بازه‌ای از ماه‌ها پشتش آمده.
const YEAR_RANGE_AFTER = new RegExp(`^[\\s\\u200c]*تا[\\s\\u200c]+(?:(?:آخر|اخر|پایان|انتها[یي]?|اول|ابتدا[یي]?)[\\s\\u200c]+)?(?:${PERSIAN_MONTHS.map(([name]) => name).join('|')})(?![آ-ی])`);
const YEAR_CONTEXT = new RegExp(`(?:^|\\s)(?:${PERSIAN_MONTHS.map(([name]) => name).join('|')}|ماه|سال)(?:\\s+(?:ماه|سال|مالی))*$`);
const NUMERIC_DATE = /(?<![\d,.])(\d{1,4})([/\-.])(\d{1,2})\2(\d{1,4})(?![\d,]|\.\d)/g;

function looksLikeDate(first, month, last) {
  const [x, m, z] = [Number(first), Number(month), Number(last)];
  if (!(m >= 1 && m <= 12)) return false;
  const yearFirst = (first.length === 4 ? isYearLike(x) : first.length === 2) && z >= 1 && z <= 31;
  const dayFirst = x >= 1 && x <= 31 && (last.length === 4 ? isYearLike(z) : last.length === 2);
  return yearFirst || dayFirst;
}

/** تاریخ عددی کامل با فاصلهٔ هم‌طول جایگزین می‌شود تا جای بقیهٔ جمله تکان نخورد. */
function maskNumericDates(text) {
  return text.replace(NUMERIC_DATE, (match, first, _separator, month, last) => (
    looksLikeDate(first, month, last) ? ' '.repeat(match.length) : match));
}

function isYearSpan(span, before, after) {
  if (!isYearLike(span.amount) || MONEY_AFTER.test(after)) return false;
  if (YEAR_CONTEXT.test(before) || DATE_SUFFIX.test(after)) return true;
  // سالِ حروفی درست پیش از مبلغِ رقمیِ مقیاس‌دار («هزار و چهارصد و شش ۱۲ میلیون»):
  // آن مبلغ خودش گفته شده و این عدد سالِ آن است، نه ردیف دوم.
  if (!/^\d/.test(span.raw) && (/^[\s\u200c]*\d[\d,٬]*[\s\u200c]*(?:میلیون|میلیارد|هزار|تومان|تومن|ریال)/.test(after) || YEAR_RANGE_AFTER.test(after))) return true;
  // سال برهنه فقط به شکل رقمی؛ «هزار و چهارصد» با حروف بی‌بافت تاریخ، مبلغ است.
  return /^\d{4}$/.test(span.raw.replace(/[.,]+$/, ''));
}

// عبارت‌های دوکلمه‌ای که هیچ خوانش مبلغی ندارند. این‌ها از معافیتِ واژهٔ مقیاس
// هم قوی‌ترند: در «کد حساب هزار و دویست»، وجود «هزار» باعث می‌شد عدد مبلغ
// شمرده شود و کد حساب وارد دفتر شود. برعکسش «فاکتور پنج میلیون» یک مبلغ واقعی
// است، پس «فاکتور»ِ تنها در فهرست ضعیف می‌ماند.
const STRONG_IDENTIFIER_PREFIXES = [
  'کد حساب', 'شماره حساب', 'شماره فاکتور', 'شماره سند', 'کد ملی',
  'کد اقتصادی', 'شماره پیگیری', 'کد رهگیری', 'شماره کارت', 'شماره شبا',
];

function isNonAmountSpan(text, span) {
  const raw = text.slice(span.start, span.end);
  const before = text.slice(Math.max(0, span.start - 24), span.start).trim();
  const after = text.slice(span.end, Math.min(text.length, span.end + 18)).trim();
  const precededBy = (prefixes) => prefixes.some((prefix) => before === prefix || before.endsWith(` ${prefix}`));

  // شناسهٔ صریح، حتی با واژهٔ مقیاس، هرگز مبلغ نیست.
  if (precededBy(STRONG_IDENTIFIER_PREFIXES)) return true;
  // سال، حتی با «هزار» در خودش («مهر هزار و چهارصد و شش»)، مبلغ نیست.
  if (isYearSpan(span, before, after)) return true;
  // عددهای دارای مقیاس پولی، حتی اگر کنار واژه‌های دیگر باشند، مبلغ محسوب می‌شوند.
  if (/هزار|میلیون|میلیارد/.test(raw)) return false;
  // واژهٔ بعدی، بی‌توجه به ویرگول و نقطه: «پنجاه برگه، کارمزد…».
  const nextWord = after.split(/[\s،,.؛:]/)[0];
  if (NON_AMOUNT_UNITS.includes(nextWord) || SUFFIXED_TIME_UNIT.test(nextWord)) return true;
  return precededBy(IDENTIFIER_PREFIXES);
}

/**
 * سالِ تاریخ، درست پیش از مبلغ، جزء مبلغ نیست.
 *
 * «بیمه از اول آبان ۱۴۰۵ تا پایان مهر ۱۴۰۶ ۲۴ میلیون دادیم» یک پیش‌پرداخت
 * یک میلیارد و چهارصد و سی میلیونی ثبت می‌کرد: عددهای پشت‌سرهم یک مبلغ جمع
 * می‌شدند و آزمون سال (`isYearSpan`) فقط روی حاصل جمع اجرا می‌شد که دیگر شبیه
 * سال نبود. پس جمع‌کردن همان‌جا می‌ایستد که بخش جمع‌شده سال است و عدد بعدی
 * مقیاس نیست («۱۴۰۰ میلیون» یک مبلغ می‌ماند):
 *
 * - سالِ رقمیِ چهاررقمی کنار عدد دیگر، همیشه («۱۴۰۶ ۲۴ میلیون»)؛ دو گروه رقمِ
 *   جدا با فاصله در گفتار یک عدد نیستند.
 * - سالِ با حروف فقط در بافت تاریخ — بعد از نام ماه، «ماه» یا «سال».
 *
 * بخش سال بعداً با همان قاعدهٔ تاریخ کنار می‌رود و مبلغ دست‌نخورده می‌ماند.
 */
function yearEndsBefore(text, firstToken, collected, next) {
  if (SCALES[next.value] || FRACTIONS[next.value] != null) return false;
  if (!isYearLike(wordsToNumber(collected))) return false;
  if (collected.length === 1 && /^\d{4}$/.test(collected[0])) return true;
  return YEAR_CONTEXT.test(text.slice(Math.max(0, firstToken.start - 24), firstToken.start).trim());
}

/**
 * شمارِ یک واحد، پس از مبلغِ کامل، ادامهٔ مبلغ نیست.
 *
 * «اجاره ۳۰ میلیون شش ماهه دادیم» سی میلیون و شش هزار خوانده می‌شد: «شش» به
 * قاعدهٔ «دو میلیون و پونصد» به مبلغ قبلی چسبید، درحالی‌که مال «ماهه» است —
 * همان خطای سالِ چسبیده به مبلغ، این بار با طول دوره. فقط وقتی مبلغ قبلی
 * مقیاسش را گرفته («۳۰ میلیون») و دنبالهٔ عددی بعدی به واحد شمارش یا زمان
 * می‌رسد، جمع‌کردن می‌ایستد.
 */
// صفتِ نرخ («ماهانه»، «سالانه») شمارِ واحد نیست: «یک میلیون و دویست ماهانه»
// همان ۱٬۲۰۰٬۰۰۰ است، نه یک میلیون و «دویست ماه».
const RATE_ADJECTIVES = new Set(['ماهانه', 'ماهیانه', 'سالانه', 'سالیانه', 'هفتگی', 'روزانه']);
function countOfUnitFollows(tokens, from, collected) {
  if (!collected.some((value) => SCALES[value])) return false;
  let cursor = from;
  while (cursor < tokens.length && (isNumericWord(tokens[cursor].value) || tokens[cursor].value === 'و')) {
    if (SCALES[tokens[cursor].value]) return false;
    cursor += 1;
  }
  const unit = tokens[cursor]?.value || '';
  // «تا» اینجا بیشتر حرف اضافه است («هزار و چهارصد و پنج تا آخر شهریور»).
  return unit !== 'تا' && !RATE_ADJECTIVES.has(unit) && (NON_AMOUNT_UNITS.includes(unit) || SUFFIXED_TIME_UNIT.test(unit));
}

export function extractAmounts(input) {
  const text = maskNumericDates(repairNumberSpeech(normalizePersian(input)));
  const tokens = tokenize(text);
  const spans = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!isNumericWord(token.value)) continue;
    // «۱۶، نه ۱۸ میلیون»: «نه» پیش از عددِ رقمی، حرف نفی است نه «۹». بدون این،
    // «نه ۱۸ میلیون» با هم ۲۷ میلیون خوانده می‌شد — مبلغی که هیچ‌کس نگفته بود.
    // کسی که «نُه» می‌گوید، موتور گفتار آن را ۹ می‌نویسد؛ «نه میلیون» همان نُه میلیون می‌ماند.
    if (token.value === 'نه' && /^\d/.test(tokens[index + 1]?.value || '')) continue;
    // «هر دو رو نقد دادیم»، «هر سه تا»: شمارِ چیزهای گفته‌شده است، نه مبلغ. ردیفی دوتومانی
    // می‌ساخت که «بابت چه بود؟» می‌پرسید (آزمون زندهٔ موتور ۵، ۲۲ مهر ۱۴۰۵).
    if (tokens[index - 1]?.value === 'هر' && /^(?:دو|سه|چهار|پنج)$/.test(token.value) && !SCALES[tokens[index + 1]?.value]) continue;
    const collected = [token.value];
    let cursor = index + 1;
    let end = token.end;
    while (cursor < tokens.length) {
      const next = tokens[cursor];
      // ویرگول و نقطه میان دو واژهٔ عددی یعنی دو عدد جدا: «…هزار و چهارصد و شش،
      // دوازده میلیون» یک مبلغ ۴۱۸ میلیونی می‌ساخت.
      if (/[،,؛;.:!؟?\n]/.test(text.slice(end, next.start))) break;
      if (isNumericWord(next.value)) {
        if (collected.at(-1) !== 'و' && yearEndsBefore(text, token, collected, next)) break;
        // عددِ حروفی که بی «و» به رقم می‌رسد، یک عدد نیست: «هزار و چهارصد و شش ۱۲
        // میلیون» ۴۱۸ میلیون و «دو هزار و پونصد ۳ میلیون» ۵۰۳ میلیون خوانده می‌شد.
        // مقیاسِ حروفی پیش از رقم («یک میلیون ۲۰۰ هزار») همچنان ادامهٔ همان عدد است.
        if (/^\d/.test(next.value) && !SCALES[next.value] && !/^\d/.test(collected.at(-1)) && collected.at(-1) !== 'و' && !SCALES[collected.at(-1)]) break;
        if (countOfUnitFollows(tokens, cursor, collected)) break;
        collected.push(next.value);
        end = next.end;
        cursor += 1;
        continue;
      }
      if (next.value === 'و' && isNumericWord(tokens[cursor + 1]?.value) && !countOfUnitFollows(tokens, cursor + 1, collected)) {
        collected.push(next.value);
        end = next.end;
        cursor += 1;
        continue;
      }
      break;
    }
    const amount = wordsToNumber(collected);
    if (amount > 0) {
      // مقیاس بدون عدد («... هزار تومان») تقریباً همیشه یعنی عددِ پیش از آن
      // شنیده نشده است. wordsToNumber ناچار ۱×مقیاس برمی‌گرداند؛ این پرچم
      // جلوی ثبت آن به‌عنوان یک مبلغ مطمئن را می‌گیرد.
      // «یه» تنها هیچ‌وقت مبلغ نیست: «یه جوری ثبت کن» یک تراکنش هزارتومانی
      // می‌ساخت. حرف تعریف بدون عدد و بدون مقیاس، عدد نیست.
      // «ی» تنها هم همین است: کسرهٔ اضافهٔ جدانوشته («بیمه ی آتش‌سوزی»)، نه «یک».
      if (collected.length === 1 && ['یه', 'یک', 'ی'].includes(collected[0])) { index = cursor - 1; continue; }
      const bareScale = Boolean(SCALES[collected[0]]);
      const span = { amount, start: token.start, end, raw: text.slice(token.start, end), bareScale };
      if (!isNonAmountSpan(text, span)) spans.push(span);
    }
    index = cursor - 1;
  }
  /**
   * عددِ برهنهٔ کوچک، درست پیش از یک مبلغ، شمارنده است نه پول.
   *
   * «یه فروش یک و دویست»، «یک چک سه میلیونی»، «دو فاکتور دو میلیونی»: آن
   * «یک» تعداد سند است، ولی به‌عنوان یک تومان ثبت می‌شد و از یک جمله دو
   * تراکنش می‌ساخت. بدتر از پیدانکردن است، چون کاربر یک عدد می‌بیند و ممکن
   * است تأییدش کند.
   *
   * قاعده قبلاً فهرستی از اسم‌ها بود («فروش»، «خرید»…) و هر اسم تازه‌ای —
   * «قرارداد»، «اسکناس» — از آن رد می‌شد. حالا معیار خودِ ساختار است: عدد
   * کوچکِ بی‌مقیاس، چسبیده به مبلغ بعدی، بدون واحد پول در میانه. اگر واحد
   * پول آمده باشد («پنجاه تومان قبض دادم و دو میلیون فروختم») مبلغ واقعی
   * است و دست‌نخورده می‌ماند.
   */
  const currencyBetween = /تومان|تومن|ریال|\d/;
  const filteredSpans = spans.filter((span, index) => {
    const next = spans[index + 1];
    if (!next || span.amount >= 100) return true;
    const between = text.slice(span.end, next.start);
    if (currencyBetween.test(between)) return true;
    return between.trim().split(/\s+/).filter(Boolean).length > 3;
  });
  return { text, spans: filteredSpans };
}

export function inferLearningKeyword(input) {
  const normalized = normalizePersian(input).replace(/[0-9,.]/g, ' ');
  const words = normalized.split(/\s+/).filter((word) => word && !NUMBER_WORDS.has(word) && !LEARNING_STOP_WORDS.has(word));
  return words.slice(0, 3).join(' ').trim();
}

function containsAny(text, words) { return words.some((word) => text.includes(word)); }

/** فعل جهت‌دار دو امتیاز می‌گیرد و اسم یک امتیاز. */
function signalScore(text, words, verbs) {
  return words.reduce((sum, word) => (text.includes(word) ? sum + (verbs.has(word) ? 2 : 1) : sum), 0);
}

/**
 * جهت پول و دستهٔ یک تراکنش.
 *
 * `categoryContext` عمداً جداست از `context`.
 *
 * برای تشخیص **جهت**، متنِ بعد از مبلغ ترجیح دارد: در جمله‌ای که چند مبلغ
 * دارد، فعلِ هر تراکنش بعد از مبلغ خودش می‌آید و نگاه‌کردن به عقب، فعلِ
 * تراکنش قبلی را قرض می‌گیرد.
 *
 * برای تشخیص **دسته** عکسش درست است: در فارسی گفتاری موضوع تقریباً همیشه پیش
 * از مبلغ می‌آید — «قبض برق رو سه میلیون پرداخت کردم». اگر همان پنجرهٔ جهت را
 * برای دسته هم استفاده کنیم، «قبض برق» دور ریخته می‌شود و فقط «پرداخت کردم»
 * می‌ماند که هیچ دسته‌ای در آن نیست. نتیجه‌اش «سایر هزینه‌ها» بود با این دلیلِ
 * گمراه‌کننده که «واژهٔ شناخته‌شده‌ای در متن نبود» — در حالی که بود، فقط یک
 * کلمه آن‌طرف‌تر.
 */
/**
 * نام نقش، فعل نیست.
 *
 * «فروشنده»، «فروشگاه» و «خریدار» هر کدام واژهٔ جهت را در خود دارند و با
 * تطبیق زیررشته‌ای جهت پول را برعکس می‌کردند: «یه دستگاه خریدیم… فروشنده
 * فاکتور غیررسمی داده» درآمد ثبت می‌شد.
 */
const ROLE_NOUNS = /فروشنده|فروشگاه|خریدار/g;
// «پاداش فروش ویزیتورها»، «مدیر فروش»: «فروش» نام واحد یا مبنای پاداش است، نه پولی که
// آمده؛ «پاداش فروش ویزیتورها ۱۲ میلیون» درآمد فروش ثبت می‌شد (محک دسته، E054).
const SALES_ROLE = /(?:پاداش|پورسانت|کمیسیون|مدیر|کارشناس|تیم|واحد|نماینده|ویزیتور|بازاریاب)(?:\s*(?:ها|های|ی))?\s*فروش(?![آ-ی])/g;
// «کتاب‌فروشی»، «لوازم‌فروشی»: نام مغازه است. «عمده‌فروشی» و «خرده‌فروشی» خودِ فروش‌اند
// («کتاب … برای فروش در کتاب‌فروشی» درآمد ثبت می‌شد، محک دسته X015).
const SHOP_NAME = /(?<![آ-ی])(?!(?:عمده|خرده|خورده)[\s‌]*فروشی)([آ-ی]{2,})[\s‌]*فروشی(?![آ-ی])/g;
/** نام نقش، واحد فروش و نام مغازه را از متنِ جهت و دسته کنار می‌گذارد. */
function maskRoleNouns(text) {
  return text.replace(ROLE_NOUNS, ' ').replace(SALES_ROLE, (phrase) => phrase.replace(/فروش$/, ' ')).replace(SHOP_NAME, '$1 ');
}

/**
 * هدف خرید، نشانهٔ فروش نیست.
 *
 * «سی کارتن روغن موتور برای فروش در مغازه… از بانک ملت خریدیم» درآمد ثبت
 * می‌شد: «فروش» واژهٔ دستهٔ درآمد است و فعل «خریدیم» شمرده نمی‌شد. «برای
 * فروش» می‌گوید کالا چرا خریده شده، نه اینکه پولی آمده.
 */
const PURPOSE_PHRASES = /(?:برای|واسه|جهت)\s*(?:فروش|فروختن)(?:\s*مجدد)?/g;
/** فعل خرید یا پرداختِ اول‌شخص: جهت پول را صریح می‌گوید و دسته نقضش نمی‌کند. */
const FIRST_PERSON_OUT = /خرید(?:م|یم)(?![آ-ی])|پرداخت\s*کرد(?:م|یم)|(?<!تحویل\s)داد(?:م|یم)(?![آ-ی])/;
/** فعل گذشتهٔ جابه‌جایی پول — «دادیم»، «گرفتیم»، «واریز شد» — نه اسم «خرید». */
const PAST_MONEY_VERB = /(?:داد(?:یم|م)?|گرفت(?:یم|م)?|خرید(?:یم|م)|ریخت(?:یم|م)?)(?![آ-ی])|(?:واریز|پرداخت|کارت\s*به\s*کارت)\s*(?:شد|کرد(?:یم|م)?)(?![آ-ی])/;

const MONEY_IN_PHRASE = /اومده?\s*تو\s*حساب|به\s*حساب\s*(?:\S+\s*)?اومد|عودت\s*(?:داد|دادن|کرد)|به\s*حساب\s*شرکت\s*(?:انتقال\s*داد|واریز\s*کرد|ریخت)|واریز\s*شد\s*به\s*حساب/;
/**
 * کسی دیگر به حساب ما ریخت — فعل سوم‌شخص، مقصد حساب خودمان.
 *
 * «خانم رضایی… بیعانه به بانک ملت کارت به کارت کرد» پرداخت ما خوانده می‌شد
 * چون «کارت به کارت» واژهٔ عمومی پرداخت است. فعل سوم‌شخصِ بی‌پسوند («کرد» نه
 * «کردم») و مقصدی که حساب خودِ ماست، جهت را صریح می‌کنند.
 */
const THIRD_PERSON_IN = /(?:به|تو|توی)\s*(?:حساب\s*)?(?:بانک\s*\S+|حسابمون|حساب\s*(?:ما|شرکت))\s*(?:\S+\s*){0,3}?(?:کارت\s*به\s*کارت\s*کرد|واریز\s*کرد|انتقال\s*داد|ریخت)(?![آ-ی])|(?:بهمون|به\s*ما|بهم)\s*(?:\S+\s*){0,1}?(?:داد|پرداخت\s*کرد|واریز\s*کرد|کارت\s*به\s*کارت\s*کرد)(?![آ-ی])/;
/**
 * «۹ میلیون رو نقد آورد»، «ودیعه‌مون رو به تجارت برگردوند» — پولی که طرف
 * مقابل آورد یا پس داد. فقط با مفعولِ پول: «جنس آورد» خرید است و «جنس رو پس
 * آورد» برگشت کالا.
 */
const BROUGHT_MONEY_IN = /(?<!پس\s*)(?:نقد|پول|پولش|پولشو|وجه|وجهش)\s*(?:رو\s*)?آورد(?:ن)?(?![آ-ی])|(?:ودیعه|پول|پولمون|طلبمون)[\s\u200c]*(?:مون|مونو|ش|شو)?\s*(?:\S+\s*){0,4}?برگردوند(?:ن)?(?![آ-ی])/;
/** طلبی که هنوز وصول نشده: «قراره بدن ولی هنوز پولی نگرفتیم». */
const RECEIVABLE_STATEMENT = /قرار(?:ه)?\s*(?:بدن|بده|بدهند|پرداخت\s*کنن)|(?:پولش|پولی|پولشو)\s*(?:رو\s*)?(?:هنوز\s*)?نگرفتیم|هنوز\s*(?:پولش|پولی)\s*(?:رو\s*)?نگرفتیم/;
// فعل پرداختِ اول‌شخص. «برای خرید مواد اولیه» اسم است، نه فعل؛ جلوی تشخیص
// ورود را نمی‌گیرد.
const MONEY_OUT_VERB = /(?:دادم|دادیم|ریختم|ریختیم|زدم|زدیم|خریدم|خریدیم|پرداخت\s*(?:کردم|کردیم)|برداشت\s*کرد)/;
/**
 * «ریختیم به حساب ملت/شرکت/صندوق»: پول در حساب خودِ دفتر ماند، به کسی پرداخت
 * نشد. نام بانک پیش از این از پنجره برداشته شده، پس «به حساب ملت» این‌جا
 * «به حساب» خالی است؛ «به حساب بیمه ایران» نام گیرنده را نگه می‌دارد.
 */
/**
 * «قرارداد زدیم»، «قولنامه زدیم»، «ضرر زدیم»، «زنگ زدیم»: «زدن» این‌جا امضا،
 * زیان یا تماس است و هیچ پولی جابه‌جا نشده. «یه بیمه ۱۲ میلیونی زدیم» هم قیمتِ
 * چیزی را می‌گوید، نه پولی که رفت. «زدیم» فقط با نشانهٔ پرداخت («کارت زدیم»،
 * «واریز»، «به حساب X زدیم»، «پول») یا وقتی مبلغ خودش مفعول است («۱۸ میلیون
 * زدیم») پرداخت است.
 */
const STRUCK_NOT_PAID = /(?<![آ-ی])(?:قرارداد|قولنامه|ضرر|زیان|سود|بار|زنگ|حرف|تماس|امضا|تیک|جنس|کالا)(?![آ-ی])|[\d۰-۹]\s*(?:میلیون|هزار|تومن|تومان)\s*(?:ی|ای)(?![آ-ی])|(?:میلیون|هزار|تومن|تومان)ی(?![آ-ی])/;
const STRUCK_PAYMENT = /کارت|واریز|پول|انتقال|پایا|ساتنا|(?:به|تو|توی)\s*حساب/;
function struckNotPaid(text) {
  return /(?<![آ-ی])زد(?:یم|م)(?![آ-ی])/.test(text)
    && !/(?:دادم|دادیم|ریختم|ریختیم|خریدم|خریدیم|پرداخت\s*(?:کردم|کردیم))/.test(text)
    && STRUCK_NOT_PAID.test(text) && !STRUCK_PAYMENT.test(text);
}

function paidIntoOwnAccount(text) {
  if (/(?:به|تو|توی)\s*(?:بانک|صندوق|حساب(?:مون|مان|م))(?![آ-ی])/.test(text)) return true;
  const destination = /(?:(?:به|تو|توی)\s*|ریخت(?:یم|م)\s*)(?:حساب|کارت)(?![آ-ی])\s*(\S*)/.exec(text);
  if (!destination) return false;
  const next = destination[1];
  return !next || MONEY_OUT_VERB.test(next) || /^(?:بانک|شرکت|خود|صندوق)|^ما$/.test(next) || Boolean(detectBank(destination[0]));
}

/**
 * «مشتری ۹ میلیون داد»، «خانم توکلی از بدهیش پرداخت کرد»، «کارت به کارت کرد» —
 * فعل سوم‌شخص یعنی طرف مقابل پول داده، پس پول به ما آمده.
 *
 * فهرست واژه‌ها «پرداخت» را هزینه می‌شمرد و فعل سوم‌شخص را نمی‌شناخت؛ هر
 * اصلاح قبلی فقط یک شکل («آورد») را می‌گرفت. اینجا قاعده روی صیغهٔ فعل است، نه
 * روی یک واژه. فقط وقتی گیرنده کس دیگری نیست («به آقای رضایی داد») و فعل
 * پرداختِ اول‌شخص در جمله نیست؛ و فقط وقتی دستهٔ هزینه‌ای روشنی پیدا نشده
 * (برای «قبض رو پرداخت کرد» کسی از طرف ما پرداخته).
 */
// «آورد» اینجا نیست: «جنس آورد» تحویل کالاست؛ «پول/نقد آورد» را BROUGHT_MONEY_IN
// می‌گیرد. «پس داد/عودت داد» هم برگشت کالاست، نه پرداخت.
const THIRD_PERSON_GAVE = /(?<![آ-ی])(?<!(?:پس|عودت)\s*)(?:نقد\s*)?(?:داد|دادن|پرداخت\s*کرد(?:ن)?|کارت\s*به\s*کارت\s*کرد(?:ن)?|واریز\s*کرد(?:ن)?|تسویه\s*کرد(?:ن)?|ریخت(?:ن)?)(?![آ-ی])/;
const OTHER_RECIPIENT = /(?<![آ-ی])به\s*(?:آقای|خانم|جناب|شرکت|فروشنده|تامین|کارگر|کارمند|پرسنل|پیمانکار|راننده|صاحبخونه|صاحبخانه|صاحب\s*خانه|صاحب\s*خونه|موجر|مؤجر|مست[اأ]جر|مشتری)(?![آ-ی])/;
function thirdPersonGave(input) {
  const text = normalizePersian(input).replace(/(?:تحویل|انجام)\s*داد(?:یم|م)/g, ' ');
  return THIRD_PERSON_GAVE.test(text.replace(NOT_MONEY_GAVE, ' ')) && !OTHER_RECIPIENT.test(text) && !MONEY_OUT_VERB.test(text);
}

/**
 * طرف پرداخت‌کننده به ما — مستاجر، مشتری، خریدار، کارفرما.
 *
 * «مستاجر اجارهٔ شش ماه آینده رو ۶۰ میلیون واریز کرد» و «اجارهٔ مهر رو از
 * مستاجر ۱۰ میلیون گرفتیم» پیش‌پرداخت اجارهٔ خودمان ثبت می‌شدند: پول ۶۰ میلیون
 * از صندوق بیرون می‌رفت درحالی‌که ۶۰ میلیون آمده بود، و اجارهٔ جعلی هزینه
 * می‌شد. «اجاره» واژهٔ دستهٔ هزینه است و تنها دستهٔ درآمد اجاره فقط «اجاره
 * گرفتم»ِ چسبیده را می‌شناخت؛ پس جهتی که فعل گفته بود («واریز کرد»، «دریافت
 * کردیم») به‌خاطر دسته برعکس می‌شد.
 *
 * نقشِ پرداخت‌کننده خودش جهت را می‌گوید، هر شکلی که جمله داشته باشد:
 * - «از مستاجر/مشتری …» — پول از او آمده؛
 * - «مستاجر/مشتری … داد/واریز کرد/ریخت/پرداخت کرد» — فعل سوم‌شخص او؛
 * - «پیش‌دریافت»، «درآمد اجاره»، «اجارهٔ دریافتی»، «دریافت/وصول اجاره» یا
 *   «اجاره … دریافت کردیم/وصول شد» — خودِ واژه ورود است.
 *
 * نه وقتی ما پرداخته‌ایم («ودیعهٔ مستاجر رو پس دادیم»، «به مستاجر برگردوندیم»)
 * و نه وقتی پول به کس دیگری رسیده («… به آقای رضایی داد»).
 */
// شرکت‌کننده، هنرجو، دانشجو، شاگرد، مراجعه‌کننده و بیمار هم مشتریِ خدمت‌اند، و جمعِ هر نقش
// همان نقش است: «شهریه … از شرکت‌کننده‌ها گرفتیم» هزینهٔ آموزش ثبت می‌شد (محک دسته، I018).
const PAYER_ROLE = '(?<![آ-ی])(?:مست[اأ]جر|مشتری|خریدار|کارفرما|شرکت[\\s‌]*کننده|هنرجو|دانشجو|شاگرد|مراجعه[\\s‌]*کننده|بیمار)(?:[\\s‌]*(?:ها|های|ا|یان|ان|گان))?(?:\\s*(?:مون|مان|ش|شون|مونو))?(?![آ-ی])';
const FROM_PAYER = new RegExp(`(?<![آ-ی])از\\s*${PAYER_ROLE}`);
// «سفارش داد»، «قول داد»، «تحویل داد» کار یا تعهد است، نه پول.
const NOT_MONEY_GAVE = /(?:سفارش|قول|تحویل|انجام|نشون|نشان|گزارش|اجازه|خبر|رضایت|فاکتور|ضمانت)\s*داد(?:ن|ه)?(?![آ-ی])/g;
const PAYER_GAVE = new RegExp(`${PAYER_ROLE}(?:\\s+\\S+){0,16}?\\s+(?:نقد\\s*)?(?<!(?:پس|عودت)\\s*)(?:داد|دادن|پرداخت\\s*کرد(?:ن)?|واریز\\s*کرد(?:ن)?|کارت\\s*به\\s*کارت\\s*کرد(?:ن)?|تسویه\\s*کرد(?:ن)?|ریخت(?:ن)?)(?![آ-ی])`);
// «۶ میلیون ثبت‌نام گرفتیم»، «۴ میلیون شهریه گرفتیم»: ثبت‌نام و شهریه را کسی نمی‌خرد؛
// گرفتنش یعنی پولِ شرکت‌کننده آمده (محک دسته، I010). «شهریه … دادیم» پرداخت ماست.
const RECEIVED_AS_INCOME = /(?<![آ-ی])(?:ثبت[\s‌]*نام|شهریه|ورودیه|حق[\s‌]*عضویت)(?:\s+\S+){0,3}?\s+گرفت(?:یم|م)(?![آ-ی])|پیش\s*دریافت|درآمد\s*(?:اجاره|کرایه|اشتراک)|(?:اجاره|کرایه)\s*(?:بها\s*)?دریافتی|(?:حق\s*)?اشتراک\s*دریافتی|فروش\s*اشتراک|(?<![آ-ی])(?:دریافت|وصول)\s*(?:اجاره|کرایه)|(?<![آ-ی])(?:اجاره|کرایه)(?:\s+\S+){0,8}?\s+(?:دریافت|وصول)\s*(?:کرد(?:یم|م|ن|ند)?|شد)(?![آ-ی])/;
const PAID_BACK = /(?<![آ-ی])(?:پس|عودت)\s*داد(?:یم|م)|برگردوند(?:یم|م)|برگرداند(?:یم|م)/;

/**
 * «۲۰ میلیون (رو) گرفتیم»، «بیست میلیون از آقای کریمی گرفتم»: مفعولِ «گرفتن» خودِ
 * پول است، پس پول آمده. «پیتزا/مشاوره/پشتیبانی یکساله گرفتیم» و «۳ میلیون پیتزا
 * گرفتیم» خرید است: میان مبلغ و فعل چیزی جز «رو»، «نقد» یا مبدأِ «از X» نیست.
 */
const TAKEN_AFTER_AMOUNT = /^\s*(?:(?:تومان|تومن|ریال)\s*)?(?:(?:رو|را|شو)\s*)?(?:(?:هم|نقد|نقدی|کامل)\s*)?(?:از\s*(?:(?:آقای|اقای|خانم|جناب|شرکت|مهندس|دکتر|حاج|حاجی)\s+)?\S+\s*)?(?:(?:رو|را|هم|نقد|نقدی)\s*)?گرفت(?:یم|م)(?![آ-ی])/;
// پیش از مبلغ مفعولی نیست: آغاز بند، حرف ربط، قید، فعلِ قبلی یا مبدأِ «از X».
// «اشتراک یکساله رو ۲۴ میلیون گرفتیم» مفعولش اشتراک است و مبلغ بهای آن.
const NO_OBJECT_BEFORE = /(?:^|[،,.؛:]|(?<![آ-ی])(?:و|هم|ولی|اما|امروز|دیروز|الان|رفت|بعد|بعدش|نقد|فقط|تازه|کلا|داد(?:یم|م)|فروخت(?:یم|م)|کرد(?:یم|م)|شد)|(?<![آ-ی])از\s+(?:(?:آقای|اقای|خانم|جناب|شرکت|مهندس|دکتر|حاج|حاجی)\s+)?\S+)\s*$/;
function takenMoney(input) {
  const text = maskNumericDates(repairNumberSpeech(normalizePersian(input)));
  if (!/گرفت(?:یم|م)(?![آ-ی])/.test(text)) return false;
  return extractAmounts(input).spans.some((span) => TAKEN_AFTER_AMOUNT.test(text.slice(span.end))
    && NO_OBJECT_BEFORE.test(text.slice(0, span.start)));
}

// «دادیم رفت ۳ میلیون گرفتیم»: واگذاریِ وسیله است، نه پرداخت؛ پولِ جمله آمده.
const GAVE_AWAY = /داد(?:یم|م)\s*رفت(?![آ-ی])/g;

export function counterpartyPaidUs(input) {
  const text = normalizePersian(input).replace(/(?:تحویل|انجام)\s*داد(?:یم|م)/g, ' ');
  const vetoText = GAVE_AWAY.test(text) && takenMoney(text) ? text.replace(GAVE_AWAY, ' ') : text;
  GAVE_AWAY.lastIndex = 0;
  if (MONEY_OUT_VERB.test(vetoText) || PAID_BACK.test(text) || OTHER_RECIPIENT.test(text)) return false;
  if (payerHasNotPaid(text)) return false;
  // «اجاره … ۶۰ میلیون گرفتم» بی پرداخت‌کننده جهتِ روشنی ندارد (RENT_TAKEN).
  return FROM_PAYER.test(text) || PAYER_GAVE.test(text.replace(NOT_MONEY_GAVE, ' ')) || RECEIVED_AS_INCOME.test(text)
    || (!RENT_TAKEN.test(text) && takenMoney(text));
}

/**
 * پرداخت‌کننده‌ای که هنوز نداده یا فقط قرار است بدهد — پولی جابه‌جا نشده.
 *
 * «اجاره مهر مستاجر ۱۰ میلیون هنوز نداده» هزینهٔ اجاره با خروج ده میلیون از
 * صندوق ثبت می‌شد، و «مستاجر قراره ۶۰ میلیون اجاره شش ماه آینده رو واریز کنه»
 * پیش‌پرداخت شصت‌میلیونی خودمان. هیچ پولی نیامده و نرفته است (قاعدهٔ ۴):
 * - نداده/واریز نکرده/هنوز نگرفتیم — طلبی که شاید باید شناسایی شود؛ ردیفش
 *   پرداخت‌نشده است و قضاوتش با حسابدار (`PAYER_UNPAID`)؛
 * - قراره بده/میده/واریز می‌کنه — هنوز هیچ رویدادی نیست (`PAYER_PROMISE`).
 */
const PAYER_ROLE_RE = new RegExp(PAYER_ROLE);
const NOT_PAID_VERB = /(?<![آ-ی])ن(?:داده|داد|دادن|دادند|ریخته|ریخت|ریختن|پرداخته)(?![آ-ی])(?!\s*(?:ایم|ام|ای)(?![آ-ی]))|(?<![آ-ی])(?:پرداخت|واریز|تسویه|کارت\s*به\s*کارت)\s*ن(?:کرده|کرد|کردن|کردند|شده)(?![آ-ی])(?!\s*(?:ایم|ام)(?![آ-ی]))/;
const NOT_RECEIVED_VERB = /(?<![آ-ی])ن(?:گرفتیم|گرفتم|گرفته)(?![آ-ی])|(?<![آ-ی])(?:دریافت|وصول)\s*ن(?:کردیم|کردم|شده|شد)(?![آ-ی])/;
const PROMISED_VERB = /قرار(?:ه|\s*است)?(?:\s+\S+){0,8}?\s+(?:بده|بدن|بدهد|بدهند|بریزه|بریزن|بریزد|بپردازه|بپردازن|بپردازد)(?![آ-ی])|قرار(?:ه|\s*است)?(?:\s+\S+){0,8}?\s+(?:واریز|پرداخت|تسویه|کارت\s*به\s*کارت)\s*(?:کنه|کند|کنن|کنند)(?![آ-ی])|(?<![آ-ی])می\s*(?:ده|دن|دهد|دهند|ریزه|ریزن|ریزد|پردازه|پردازد)(?![آ-ی])|(?<![آ-ی])(?:واریز|پرداخت|تسویه)\s*(?:می\s*کنه|می\s*کنن|می\s*کند|خواهد\s*کرد|خواهند\s*کرد)(?![آ-ی])|(?<![آ-ی])(?:می\s*خواد|می\s*خواهد)(?:\s+\S+){0,6}?\s+(?:بده|بریزه|بپردازه|(?:واریز|پرداخت)\s*کنه)(?![آ-ی])/;
// فعلِ انجام‌شدهٔ جابه‌جایی پول، با مرزِ واژه: «نداده» و «بده» این نیستند.
const DONE_MONEY_VERB = /(?<![آ-ی])(?:داد(?:یم|م|ن|ند)?|گرفت(?:یم|م|ن|ند)?|خرید(?:یم|م)|ریخت(?:یم|م|ن|ند)?|زد(?:یم|م)|(?:واریز|پرداخت|کارت\s*به\s*کارت|دریافت|وصول)\s*(?:شد|کرد(?:یم|م|ن|ند)?))(?![آ-ی])/;
// کاری که تحویل یا تمام شده: پول نیست، ولی طلبِ وعده‌داده را واقعی می‌کند.
const DELIVERY_DONE = /(?:تحویل|انجام)\s*(?:دادیم|دادم|شد)|(?:تموم|تمام)\s*(?:کردیم|کردم|شد)|(?<![آ-ی])فروخت(?:یم|م)(?![آ-ی])/;
const DELIVERY_DONE_ALL = new RegExp(DELIVERY_DONE.source, 'g');
// «تحویل/جواب/اجازه نداده» پول نیست.
const NOT_MONEY_NOT_GIVEN = /(?:تحویل|انجام|جواب|اجازه|قول|خبر|سفارش)\s*ن(?:داده|داد|دادن|دادند)(?![آ-ی])/g;
// پرداخت‌کنندهٔ نام‌دار با عنوان: «آقای رضایی هنوز ۵ میلیون رو نداده».
const TITLED_PARTY = /(?<![آ-ی])(?:آقای|اقای|خانم|جناب|شرکت|مهندس|دکتر|حاج|حاجی)(?![آ-ی])/;

/**
 * «آقای نادری شهریهٔ دورهٔ سه‌ماهه رو ۹ میلیون نقد داد»: فاعل کسِ دیگری است و فعلش
 * «داد». یا به ما پول داده (پیش‌دریافت) یا از جیب خودش بابت ما پرداخته؛ در هیچ‌کدام
 * پولی از صندوق ما نرفته. چون جمله دستهٔ هزینه («شهریه») هم داشت، پیش‌پرداخت از
 * صندوق ثبت می‌شد (آزمون زندهٔ موتور ۵، ۲۲ مهر ۱۴۰۵). جهت را حدس نمی‌زنیم (قاعدهٔ ۴):
 * حسابدار تعیین می‌کند. «به ما داد»، «به حساب ملت ریخت» و «از مستاجر» جهت را
 * می‌گویند و این‌جا نمی‌رسند؛ «پرداخت کرد» و «تسویه کرد» (پرداختِ قبض از طرف ما) هم نه.
 */
const TITLED_SUBJECT_START = /^\s*(?:آقای|اقای|خانم|جناب|شرکت|مهندس|دکتر|حاج|حاجی)\s+\S+/;
const GAVE_MONEY_VERB = /(?<![آ-ی])(?<!(?:پس|عودت)\s*)(?:نقد\s*)?(?:داد|دادن|دادند|ریخت|ریختن|کارت\s*به\s*کارت\s*کرد(?:ن)?|واریز\s*کرد(?:ن)?)(?![آ-ی])/;
export const PAYER_GAVE_UNCLEAR = 'جهت پول روشن نیست: «… داد» یعنی طرف مقابل به ما پول داده یا از طرف ما پرداخته؛ در هیچ‌کدام پولی از صندوق یا بانک ما نرفته. حسابدار تعیین می‌کند. اگر به ما داده، «به ما داد» یا «به حساب … ریخت» را بگو.';
// «از جیب خودش داد»، «با پول شخصی‌اش»: پرداخت‌کننده و جهت روشن است و مسیر پول
// شخصیِ شریک یا کارمند (`partnerPaidSpeech`) آن را بی ردیف نقدی ثبت می‌کند.
const PERSONAL_FUNDS = /پول\s*(?:شخصی|خودش|خودشون|خودشان)|جیب\s*(?:خودش|خودشون|خودشان|شخصی|ش|شون)(?![آ-ی])|از\s*حساب\s*(?:شخصی|خودش|خودشون)|شخصا|شخصاً/;
function thirdPartyGaveMoney(input) {
  const text = normalizePersian(input).replace(/(?:تحویل|انجام)\s*داد(?:یم|م)/g, ' ');
  return TITLED_SUBJECT_START.test(text) && GAVE_MONEY_VERB.test(text.replace(NOT_MONEY_GAVE, ' '))
    && !OTHER_RECIPIENT.test(text) && !MONEY_OUT_VERB.test(text) && !PERSONAL_FUNDS.test(text);
}
// فقط صیغهٔ فعال سوم‌شخص؛ «پرداخت نشده» مجهول است و قبضِ پرداخت‌نشدهٔ خودمان هم هست.
const THEY_HAVE_NOT_PAID = /(?<![آ-ی])ن(?:داده|داد|دادن|دادند|ریخته|ریخت|ریختن|پرداخته)(?![آ-ی])(?!\s*(?:ایم|ام|ای)(?![آ-ی]))|(?<![آ-ی])(?:پرداخت|واریز|تسویه|کارت\s*به\s*کارت)\s*ن(?:کرده|کرد|کردن|کردند)(?![آ-ی])(?!\s*(?:ایم|ام)(?![آ-ی]))/;
function payerHasNotPaid(input) {
  const text = String(input).replace(NOT_MONEY_NOT_GIVEN, ' ');
  if (PAYER_ROLE_RE.test(text)) return NOT_PAID_VERB.test(text) || NOT_RECEIVED_VERB.test(text);
  // طرفِ نام‌دار: فقط وقتی هیچ پولِ انجام‌شده‌ای («دادیم»، «پرداخت شد») در بند نیست.
  return TITLED_PARTY.test(text) && THEY_HAVE_NOT_PAID.test(text) && !OTHER_RECIPIENT.test(text)
    && !MONEY_OUT_VERB.test(text) && !DONE_MONEY_VERB.test(text.replace(DELIVERY_DONE_ALL, ' '));
}
/** بندِ یک ردیف از جملهٔ چندپرداختی؛ پرداخت‌کننده ممکن است در بند دیگری نام برده شده باشد. */
function clauseNotYet(clause, sentencePayer) {
  const text = String(clause).replace(NOT_MONEY_NOT_GIVEN, ' ');
  if (sentencePayer === 'role' && (NOT_PAID_VERB.test(text) || NOT_RECEIVED_VERB.test(text))) return 'unpaid';
  if (sentencePayer === 'titled' && THEY_HAVE_NOT_PAID.test(text) && !MONEY_OUT_VERB.test(text)) return 'unpaid';
  return payerNotYet(clause);
}
/** 'unpaid' | 'promised' | null برای یک بند یا جمله. */
function payerNotYet(input) {
  const text = normalizePersian(input);
  if (payerHasNotPaid(text)) return 'unpaid';
  // وعدهٔ سوم‌شخص: «قراره بده»، «هفته بعد میریزه». جمله‌ای که پولِ انجام‌شده هم
  // دارد («۱۰ میلیون داد، بقیه رو ماه بعد میده») وعده نیست؛ مبلغِ آن بند مال وعده است.
  // «تحویل دادیم» پول نیست: «پروژه رو تحویل دادیم کارفرما قراره ۲۰ میلیون واریز
  // کنه» نقد بیست‌میلیونی ثبت می‌کرد. کارِ تحویل‌شده با وعدهٔ پرداخت طلب است، نه
  // «هیچ»: ردیفِ بی‌پول به حسابدار می‌رود.
  if (PROMISED_VERB.test(text) && !DONE_MONEY_VERB.test(text.replace(DELIVERY_DONE_ALL, ' ')) && !NOT_RECEIVED_VERB.test(text)) {
    return DELIVERY_DONE.test(text) ? 'unpaid' : 'promised';
  }
  return null;
}
export const PAYER_PROMISE_MESSAGE = 'این پول هنوز جابه‌جا نشده و فقط قرار است پرداخت شود؛ چیزی ثبت نشد. وقتی پول واقعاً رسید همان را بگو.';
export const PAYER_UNPAID = 'پرداخت‌کننده هنوز این پول را نداده است؛ ردیف نقدی ساخته نمی‌شود. اینکه طلب یا درآمد تعهدی شناسایی شود، با حسابدار است.';

/**
 * پرداخت‌کنندهٔ جمله برای هر ردیفِ جملهٔ چندپرداختی.
 *
 * «مشتری ۱۰ میلیون واریز کرد و ۲ میلیون کارمزد کسر شد» کارمزد را هم ورودی
 * می‌کرد، و «مستاجر ۱۰ میلیون اجاره داد و ۲ میلیون به لوله‌کش دادیم» اجارهٔ
 * مستاجر را پرداخت ما: جهت یک بار برای کل جمله خوانده می‌شد. هر ردیف فقط وقتی
 * پولِ آمده است که بندِ خودش پرداخت‌کننده یا فعل دریافت را داشته باشد، یا اصلاً
 * فعلی نداشته باشد و فعلِ مشترک بعدی‌اش فعل دریافت باشد («مستاجر ۱۰ میلیون
 * اجاره، ۲ میلیون شارژ و ۵۰۰ هزار قبض داد»). بندی که فعل دیگری دارد («کسر شد»،
 * «خرج حمل شد»، «دادیم») جهت خودش را دارد.
 */
const RECEIPT_VERB = new RegExp(`${THIRD_PERSON_GAVE.source}|(?<![آ-ی])(?:گرفت(?:یم|م)|(?:دریافت|وصول)\\s*(?:کرد(?:یم|م)|شد))(?![آ-ی])`);
const CLAUSE_VERB = /(?<![آ-ی])(?:شد|شده|میشه|کرد(?:یم|م|ن|ند)?|کرده|داد(?:یم|م|ن|ند)?|داده|گرفت(?:یم|م|ن|ند)?|زد(?:یم|م|ن|ند)?|ریخت(?:یم|م|ن|ند)?|خرید(?:یم|م|ن|ند)?|رفت|اومد|آمد|خورد)(?![آ-ی])/;
function clauseOwnDirection(clause) {
  const text = normalizePersian(clause).replace(/(?:تحویل|انجام)\s*داد(?:یم|م)/g, ' ');
  if (MONEY_OUT_VERB.test(text) || PAID_BACK.test(text) || OTHER_RECIPIENT.test(text)) return 'out';
  if (counterpartyPaidUs(text)) return 'in';
  const verbs = text.replace(NOT_MONEY_GAVE, ' ');
  if (RECEIPT_VERB.test(verbs)) return 'receipt';
  if (CLAUSE_VERB.test(verbs)) return 'other';
  return PAYER_ROLE_RE.test(text) ? 'payer' : null;
}
function rowsPaidUs(clauses, sentencePaid) {
  const own = clauses.map(clauseOwnDirection);
  // پرداخت‌کننده‌ای در جمله هست: کل جمله، یک بند، یا نقشی در یک بند و فعل دریافت در بندی دیگر.
  const payer = sentencePaid || own.includes('in') || (own.includes('payer') && own.includes('receipt'));
  if (!payer) return clauses.map(() => false);
  return own.map((direction, index) => {
    if (direction === 'in' || direction === 'receipt' || direction === 'payer') return true;
    if (direction) return false;
    // بی‌فعل: فعلِ مشترکِ بعدی حکم می‌کند.
    const governing = own.slice(index + 1).find((next) => next && next !== 'payer');
    return governing === 'in' || governing === 'receipt';
  });
}

/**
 * «اجارهٔ یک‌سالهٔ مغازه رو گرفتم» بی‌آنکه بگوید از چه کسی: هم دریافت اجاره از
 * مستاجر معنی می‌دهد و هم اجاره‌کردن ملک. پیش‌پرداخت اجارهٔ خودمان (پول بیرون)
 * و پیش‌دریافت از مستاجر (پول داخل) دو سند وارونه‌اند؛ هیچ‌کدام را حدس نمی‌زنیم.
 */
const TAKEN_BY_US = /گرفت(?:یم|م)(?![آ-ی])/;
const RENT_TAKEN = /(?<![آ-ی])(?:اجاره|کرایه)(?![آ-ی])(?:\s+\S+){0,8}?\s+گرفت(?:م|یم|ن|ند)?(?![آ-ی])/;
/**
 * ودیعه یا رهنی که مستاجر به ما داده درآمد نیست؛ بدهیِ برگشت‌پذیر به اوست.
 * دفتر برای ودیعهٔ دریافتی قاعدهٔ ثبتی ندارد و پرسش «بابت چه بود؟» هم گزینه‌اش
 * را ندارد، پس به حسابدار می‌رود — نه «درآمد اجاره» و نه پیش‌دریافتِ مستهلک‌شونده.
 */
const DEPOSIT_WORD = /(?<![آ-ی])(?:ودیعه|رهن)/;
export const DEPOSIT_RECEIVED = 'ودیعه یا رهنِ دریافتی از مستاجر بدهی برگشت‌پذیر به اوست، نه درآمد اجاره؛ حسابدار آن را در حساب ودیعه‌های دریافتی ثبت می‌کند.';
export const RENT_DIRECTION_UNCLEAR = 'جهت پول روشن نیست: «اجاره … گرفتیم» هم دریافت اجاره از مستاجر است (پیش‌دریافت، پول وارد) و هم اجاره‌کردن ملک (پیش‌پرداخت، پول خارج)؛ حسابدار با قرارداد تعیین می‌کند. اگر مستاجر داده، «از مستاجر» را بگو.';

function sentenceMoneyIn(input) {
  const text = normalizePersian(input);
  // «تحویل دادیم» و «انجام دادیم» دربارهٔ کار است، نه پول.
  const payments = text.replace(/(?:تحویل|انجام)\s*داد(?:یم|م)/g, ' ');
  return ((MONEY_IN_PHRASE.test(text) || THIRD_PERSON_IN.test(text) || thirdPersonIntoOurBank(text) || BROUGHT_MONEY_IN.test(text) || RECEIVABLE_STATEMENT.test(text)) && !MONEY_OUT_VERB.test(payments))
    || counterpartyPaidUs(input);
}

/** نشانهٔ ورودِ صریح، نه حدسی: اطمینانش پایین نمی‌آید. */
function explicitMoneyIn(input) {
  const text = normalizePersian(input);
  return THIRD_PERSON_IN.test(text) || thirdPersonIntoOurBank(text) || BROUGHT_MONEY_IN.test(text) || RECEIVABLE_STATEMENT.test(text) || counterpartyPaidUs(input);
}

/**
 * «… ۴۸ میلیون به حساب ملت ریخت»، «شرکت بتا ۱۵ میلیون بیعانه به ملت ریخت»: فعلِ
 * سوم‌شخص با مقصدِ بانکی که فقط با نامش آمده. الگوی بالا «بانک X» یا «حساب شرکت»
 * می‌خواست، و جمله‌ای که دستهٔ هزینه هم داشت («اجاره»، «سفارش کالا») پرداختِ ما
 * خوانده می‌شد — پیش‌پرداخت از صندوق برای پولی که آمده بود (آزمون زندهٔ موتور ۵،
 * ۲۲ مهر ۱۴۰۵). پولی که «از صندوق» یا «از حساب» خودمان رفته انتقال است، نه ورود.
 */
const KNOWN_BANK_NAMES = [...new Set(BANKS.flatMap((bank) => bank.strong).concat(['سامان']))]
  .sort((left, right) => right.length - left.length).join('|');
const THIRD_PERSON_INTO_BANK = new RegExp(`(?<![آ-ی])(?:به|تو|توی)\\s*(?:حساب\\s*)?(?:بانک\\s*)?(?:${KNOWN_BANK_NAMES})(?![آ-ی])\\s*(?:\\S+\\s*){0,3}?(?:کارت\\s*به\\s*کارت\\s*کرد|واریز\\s*کرد|انتقال\\s*داد|ریخت)(?:ن|ند)?(?![آ-ی])`);
const FROM_OUR_ACCOUNT = new RegExp(`(?<![آ-ی])از\\s*(?:صندوق|تنخواه|حساب|بانک|${KNOWN_BANK_NAMES})(?![آ-ی])`);
function thirdPersonIntoOurBank(text) {
  return THIRD_PERSON_INTO_BANK.test(text) && !FROM_OUR_ACCOUNT.test(text) && !MONEY_OUT_VERB.test(text);
}

/**
 * دوقلوی درآمدیِ یک موضوع هزینه.
 *
 * «مستاجر اجارهٔ شش ماه رو واریز کرد»: موضوع را قاعدهٔ هزینهٔ «اجاره» می‌شناسد
 * و جهت را پرداخت‌کننده می‌گوید. «اجاره» تنها در قاعدهٔ درآمد نیست، چون بی
 * پرداخت‌کننده («اجارهٔ مغازه رو گرفتم») دو معنی دارد؛ پس فقط وقتی پرداخت‌کننده
 * صریح است، موضوع به دستهٔ درآمدیِ همتایش می‌رود.
 */
// «کلاس آموزش برگزار کردیم … ثبت‌نام گرفتیم»، «تعمیر گوشی مشتری … گرفتیم»: آموزش و تعمیری که ما
// انجام دادیم و پولش آمده، درآمدِ خدمات است.
const INCOME_TWIN = Object.freeze({ اجاره: 'درآمد اجاره', 'نرم‌افزار و اشتراک': 'خدمات', آموزش: 'خدمات', 'تعمیر و نگهداری': 'خدمات' });
// «کرایه» بی ملک، قاعدهٔ حمل‌ونقل را می‌گیرد؛ کرایه‌ای که مستاجر می‌دهد اجارهٔ ملک است.
const TENANT_RENT = /(?<![آ-ی])مست[اأ]جر(?:[\s‌]*\S+){0,10}?[\s‌]*(?:اجاره|کرایه)|(?<![آ-ی])(?:اجاره|کرایه)(?:[\s‌]*\S+){0,10}?[\s‌]*مست[اأ]جر/;
export function incomeTwin(text) {
  const subject = classifyCategory(text, 'expense');
  const twin = TENANT_RENT.test(text) ? 'درآمد اجاره' : subject.matched ? INCOME_TWIN[subject.category] : null;
  if (!twin) return null;
  return {
    category: twin, chartCode: chartCodeForCategory(twin), confidence: Math.min(subject.matched ? subject.confidence : 0.86, 0.86),
    reason: `موضوع «${subject.matched ? subject.category : 'اجاره'}» است و پول را پرداخت‌کننده به ما داده؛ دستهٔ «${twin}» انتخاب شد.`,
    ambiguous: false, runnerUp: null, matched: true,
  };
}

function classify(context, learnings = [], categoryContext = '', { moneyIn = false, rentTaken = false, rowText = '' } = {}) {
  const normalizedContext = maskRoleNouns(normalizePersian(context)).replace(PURPOSE_PHRASES, ' ');
  const normalizedCategoryContext = maskRoleNouns(normalizePersian(categoryContext) || normalizePersian(context)).replace(PURPOSE_PHRASES, ' ');
  // نگاشت تأییدشدهٔ «اجاره → اجاره» برای پرداخت اجارهٔ خودمان بود؛ وقتی جمله
  // صریح می‌گوید مستاجر یا مشتری به ما داده، همان نگاشت جهت را برنمی‌گرداند.
  const learned = learnings.find((item) => normalizedCategoryContext.includes(normalizePersian(item.keyword))
    && !(moneyIn && CATEGORY_DEFINITIONS.find((definition) => definition.name === item.category)?.type === 'expense'));
  // «واریز کردیم» پرداخت ماست؛ همان «واریز» نباید در سمت درآمد هم شمرده شود.
  const incomeScore = signalScore(normalizedContext.replace(/واریز\s*کرد(?:یم|م)(?![آ-ی])/g, ' '), INCOME_WORDS, INCOME_VERBS);
  const expenseScore = signalScore(normalizedContext, EXPENSE_WORDS, EXPENSE_VERBS);
  const hasIncome = incomeScore > 0;
  const hasExpense = expenseScore > 0;
  const onlyOneSide = hasIncome !== hasExpense;
  // وقتی هر دو نشانه هست، فعلِ جهت‌دار برنده می‌شود؛ ولی اطمینان پایین می‌ماند
  // تا کاربر نگاهش کند، چون جمله واقعاً هر دو نشانه را داشته است.
  let type = incomeScore > expenseScore ? 'income' : 'expense';
  let confidence = onlyOneSide ? 0.93 : incomeScore === expenseScore ? 0.58 : 0.72;
  let typeReason = onlyOneSide
    ? `نوع از واژهٔ ${hasIncome ? 'درآمدی' : 'هزینه‌ای'} متن تشخیص داده شد.`
    : incomeScore === expenseScore
      ? 'متن هم‌زمان نشانهٔ روشن درآمد یا هزینه ندارد.'
      : `متن هر دو نشانه را دارد؛ نوع از فعل ${type === 'income' ? 'دریافت' : 'پرداخت'} برداشت شد و باید کنترل شود.`;
  // «سرور ابری ۱۲ ماهه ۱۸ میلیون ریختیم/زدیم»: فعل پرداختِ اول‌شخص است ولی در
  // فهرست واژه‌ها نیست، پس نوع بی‌نشانه می‌ماند و جمله به حسابدار می‌رفت. فقط
  // وقتی هیچ نشانهٔ دیگری نیست («فروش زدیم» درآمد است)، مقصد حسابِ خودِ دفتر
  // نیست («نقد رو ریختیم به حساب ملت» انتقال است) و فعل، صدور سند نیست.
  if (!hasIncome && !hasExpense && MONEY_OUT_VERB.test(normalizedContext) && !paidIntoOwnAccount(normalizedContext)
    && !struckNotPaid(normalizePersian(`${rowText} ${context}`)) && !/فاکتور|صورت\s*حساب|سفارش|کارتخوان|پوز|تخفیف|چک/.test(normalizedContext)) {
    type = 'expense';
    confidence = 0.93;
    typeReason = 'نوع از فعل پرداخت اول‌شخص تشخیص داده شد.';
  }
  // پرداخت‌کنندهٔ نام‌برده (مستاجر، مشتری) از هر واژهٔ دسته‌ای صریح‌تر است.
  // «اجاره» در «مستاجر اجاره رو واریز کرد» موضوع پول است، نه جهتش.
  if (moneyIn && type === 'expense') {
    type = 'income';
    confidence = 0.86;
    typeReason = 'جمله می‌گوید مستاجر، مشتری یا پرداخت‌کنندهٔ دیگری به ما پول داده؛ جهت از نقش پرداخت‌کننده برداشت شد.';
  }
  let directionUnclear = false;
  // نگاشت تأییدشدهٔ کاربر از هر قاعده‌ای قوی‌تر است: او یک‌بار همین را اصلاح
  // کرده و نباید دوباره از او پرسیده شود.
  let category = learned?.category;
  let categoryConfidence = 0.98;
  let categoryReason = learned ? `بر اساس نگاشت تأییدشدهٔ «${learned.keyword}» انتخاب شد.` : '';
  let categoryAmbiguous = false;
  let categoryRunnerUp = null;
  if (learned) confidence = Math.max(confidence, 0.96);
  if (!category) {
    let suggestion = classifyCategory(normalizedCategoryContext, type);
    if (type === 'income' && moneyIn && !suggestion.matched) suggestion = incomeTwin(normalizedCategoryContext) || suggestion;
    /**
     * وقتی سمتِ تشخیص‌داده‌شده هیچ واژه‌ای ندارد ولی سمت مقابل دارد، جهت پول
     * غلط خوانده شده است.
     *
     * «بنزین گرفتم» و «ناهار پرسنل گرفتم» درآمد ثبت می‌شدند، چون «گرفتم»
     * فعل درآمدی است — درحالی‌که اینجا یعنی «خریدم». و چون `classifyCategory`
     * با همان نوعِ غلط صدا زده می‌شود و بر اساس نوع فیلتر می‌کند، «سوخت» و
     * «خوراک» اصلاً نامزد نمی‌شدند؛ دسته روی «سایر درآمدها» می‌افتاد و کاربر
     * باید هم نوع و هم دسته را دستی درست می‌کرد.
     *
     * اصلاحِ وارونه‌اش از قبل بود («دستهٔ درآمدی روی تراکنش هزینه») ولی فقط
     * برای نگاشت تأییدشدهٔ کاربر کار می‌کرد، چون دستهٔ خودکار هرگز نمی‌تواند
     * نوع را نقض کند.
     *
     * شرط عمداً سخت است: سمت فعلی باید هیچ واژه‌ای نداشته باشد و سمت مقابل
     * تطابق روشن. «از مشتری گرفتم» هیچ‌کدام را ندارد و دست‌نخورده می‌ماند.
     */
    if (!suggestion.matched && !(type === 'expense' && FIRST_PERSON_OUT.test(normalizedContext)) && !(type === 'income' && moneyIn)) {
      const oppositeType = type === 'income' ? 'expense' : 'income';
      const opposite = classifyCategory(normalizedCategoryContext, oppositeType);
      if (opposite.matched && opposite.confidence >= 0.86) {
        type = oppositeType;
        typeReason = `نوع با واژهٔ دستهٔ «${opposite.category}» هماهنگ شد؛ فعل جمله جهت دیگری را نشان می‌داد.`;
        // زیر آستانهٔ بازبینی عمداً: فعل و اسمِ جمله با هم نخواندند و کاربر
        // باید یک نگاه بیندازد. یک‌بار. بعد از تأیید او، نگاشت یادگرفته‌شده
        // این مسیر را دور می‌زند و دیگر پرسیده نمی‌شود.
        confidence = Math.min(confidence, 0.68);
        suggestion = opposite;
      }
    }
    category = suggestion.category;
    categoryConfidence = suggestion.confidence;
    categoryReason = suggestion.reason;
    categoryAmbiguous = suggestion.ambiguous;
    categoryRunnerUp = suggestion.runnerUp;
  }
  /**
   * دسته و نوع هرگز نباید با هم نخوانند؛ دسته مرجع است چون از واژهٔ صریح‌تری
   * آمده.
   *
   * این اصلاح فقط یک‌طرفه بود — دستهٔ درآمدی می‌توانست «هزینه» را برگرداند
   * ولی عکسش نه — و روی نگاشت تأییدشدهٔ کاربر رکورد خودمتناقض می‌ساخت: کاربر
   * یک‌بار «بنزین» را به «سوخت و ایاب‌وذهاب» نگاشت می‌کرد و از آن به بعد
   * «بنزین گرفتم» نوعِ درآمد با دستهٔ هزینه‌ای می‌گرفت. یعنی همان تأییدِ کاربر
   * که قرار بود مسئله را حل کند، آن را بدتر می‌کرد.
   */
  const categoryType = CATEGORY_DEFINITIONS.find((item) => item.name === category)?.type;
  if (categoryType && categoryType !== type) {
    type = categoryType;
    typeReason = `نوع با دستهٔ «${category}» هماهنگ شد.`;
    confidence = Math.max(confidence, categoryConfidence);
  }
  // «اجاره … گرفتیم/گرفتم» بی پرداخت‌کننده و بی فعل پرداختِ ما: هزینه‌خواندنش
  // همان‌قدر حدس است که درآمدخواندنش؛ ردیف علامت می‌خورد تا حسابدار جهت را تعیین کند.
  // «کرایه دستگاه به یه شرکت دیگه ۵ میلیون گرفتیم»: «کرایه» دستهٔ حمل را می‌گیرد و هزینهٔ حمل
  // بی‌سؤال ثبت می‌شد (محک دسته، I016)؛ کرایه‌ای که ما گرفتیم همان ابهامِ اجاره را دارد.
  if (rentTaken && !learned && (category === 'اجاره' || (category === 'حمل‌ونقل' && TAKEN_BY_US.test(normalizedContext)))) directionUnclear = true;
  return {
    type, category, confidence, typeConfidence: confidence, typeReason, categoryConfidence, categoryReason,
    chartCode: chartCodeForCategory(category), categoryAmbiguous, categoryRunnerUp, directionUnclear,
  };
}

/**
 * یک جملهٔ گفته‌شده، چند بار شنیده شده.
 *
 * تشخیص زندهٔ اندروید هر نسخهٔ نیمه‌تمام جمله را جدا برمی‌گرداند و متن به
 * پلکان تبدیل می‌شود: «پرداخت ۹۳ / پرداخت ۹۳ میلیون / پرداخت ۹۳ میلیون
 * تومان …». ریشه‌اش در لایهٔ گفتار بسته شد، ولی این لایه هم نباید به آن
 * تکیه کند: هر منبع دیگری — Whisper، متن چسبانده‌شدهٔ کاربر — می‌تواند همین
 * تکرار را بسازد.
 *
 * و پیامدش از زشتیِ متن خیلی بدتر است: هر «۹۳» یک مبلغ جدا شمرده می‌شود و یک
 * جمله به چهارده ثبتِ ۹۳ میلیونی تبدیل می‌شود — یک‌میلیارد و سیصد میلیون
 * هزینهٔ ساختگی، با یک بار تأیید.
 *
 * قاعده: مبلغ‌های پشت‌سرهمِ یکسان با همان نوع و همان دسته، یک ثبت‌اند. حذف
 * بی‌صدا نیست؛ شمارشش در دلیل بررسی نوشته می‌شود تا اگر واقعاً دو پرداختِ
 * هم‌مبلغ بوده، کاربر خودش دومی را اضافه کند.
 */
function collapseRepeatedTransactions(transactions) {
  const collapsed = [];
  for (const transaction of transactions) {
    const previous = collapsed[collapsed.length - 1];
    const sameEntry = previous
      && previous.amount === transaction.amount
      && previous.type === transaction.type
      && previous.category === transaction.category;
    if (!sameEntry) { collapsed.push({ ...transaction, repeatCount: 1 }); continue; }
    previous.repeatCount += 1;
  }
  return collapsed.map((transaction) => {
    if (transaction.repeatCount < 2) { const { repeatCount, ...rest } = transaction; return rest; }
    const { repeatCount, ...rest } = transaction;
    const reason = `این مبلغ ${repeatCount} بار پشت سر هم شنیده شد و یک ثبت در نظر گرفته شد؛ اگر واقعاً چند پرداخت بوده، بقیه را خودت اضافه کن.`;
    return withReviewAssessment({
      ...rest,
      needsReview: true,
      reviewReasons: [...(rest.reviewReasons || []), reason],
      warning: rest.warning || reason,
      confidenceDetails: {
        ...rest.confidenceDetails,
        // تکرارِ غیرعادی یعنی خودِ شنیدن مشکوک است، نه فقط دسته‌بندی.
        amount: { score: 0.4, reason: `مبلغ ${repeatCount} بار تکرار شد؛ تشخیص گفتار احتمالاً یک جمله را چند بار نوشته است.` },
      },
    });
  });
}

const NUMBER_START = '(?:[0-9]|یک|یه|دو|سه|چهار|پنج|شش|شیش|هفت|هشت|نه|ده|یازده|دوازده|سیزده|چهارده|پانزده|پونزده|شانزده|شونزده|هفده|هیفده|هجده|هیجده|نوزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود|صد|یکصد|دویست|سیصد|چهارصد|پانصد|پونصد|ششصد|هفتصد|هشتصد|نهصد)(?![آ-ی])';
// «نه» به‌تنهایی فقط وقتی اصلاح است که پس از واژهٔ مقیاس و پیش از عدد بیاید؛
// «ده میلیون نه هزار» یعنی ده میلیون و نه هزار و دست نمی‌خورد.
const SPOKEN_CORRECTION = new RegExp(`(هزار|میلیون|میلیارد|تومن|تومان|ریال)\\s*[،,]?\\s*(?:نه\\s*(?:ببخشید|ببخشین|ببخش)|نه|ببخشید|ببخشین|اشتباه\\s*گفتم|منظورم|یعنی\\s*نه)\\s*[،,]?\\s+(?=${NUMBER_START})`);

/**
 * گوینده وسط جمله عدد را اصلاح کرده: «۱۲ میلیون، نه ببخشید ۱۸ میلیون».
 *
 * پارسر دو ردیف ۱۲ و ۱۸ می‌ساخت، و «دوازده میلیون نه هجده میلیون» را
 * ۳۹ میلیون می‌خواند — «نه»ی اصلاح را عددِ نه می‌شمرد و هر سه را جمع می‌کرد.
 * عددِ پیش از نشانهٔ اصلاح از جمله برداشته می‌شود و فقط عدد اصلاح‌شده می‌ماند.
 */
export function applySpokenCorrection(input) {
  let text = repairNumberSpeech(normalizePersian(input));
  for (let guard = 0; guard < 3; guard += 1) {
    const marker = SPOKEN_CORRECTION.exec(text);
    if (!marker) break;
    // نشانه با یک جداکننده جایگزین می‌شود تا دو عدد در هم جمع نشوند.
    const markerEnd = marker.index + marker[0].length;
    const split = `${text.slice(0, marker.index + marker[1].length)} ؛ ${text.slice(markerEnd)}`;
    const cut = marker.index + marker[1].length;
    const previous = extractAmounts(split).spans.filter((span) => span.end <= cut).at(-1);
    if (!previous) break;
    text = `${split.slice(0, previous.start)}${split.slice(cut + 3)}`.replace(/\s+/g, ' ').trim();
  }
  return text === repairNumberSpeech(normalizePersian(input)) ? input : text;
}

const CONDITION_MARKER = /(?:^|\s)(?:اگر|اگه|در\s*صورت(?:ی\s*که)?|به\s*شرط(?:ی\s*که)?|مشروط\s*به)(?:\s|$)/;
const FUTURE_MONEY_VERB = /(?<![آ-ی])(?:می\s?(?:ریز|ده|د|پرداز|گیر|خر|فروش|زن|فرست|کن)[آ-ی]*|خواه(?:یم|ند|د|م)|قرار\s*(?:ه|است)?\s*(?:بد|بری|بپرداز|بریز|بگیر))/;

export const UNPERFORMED_CONDITION_MESSAGE = 'این کار شرطی است و هنوز انجام نشده؛ چیزی ثبت نشد. وقتی پول واقعاً جابه‌جا شد همان را بگو.';

/**
 * «اگر سفارش رو تأیید کنه، هفتهٔ بعد ۲۰ میلیون پیش‌پرداخت می‌ریزیم.»
 *
 * این جمله یک پیش‌پرداخت ۲۰ میلیونی از صندوق ثبت می‌کرد، درحالی‌که هیچ پولی
 * جابه‌جا نشده و شاید هیچ‌وقت نشود. شرط + فعل آینده، بدون هیچ فعل انجام‌شده،
 * رویداد مالی نیست.
 */
export function describesUnperformedCondition(input) {
  const text = normalizePersian(input);
  return CONDITION_MARKER.test(text) && FUTURE_MONEY_VERB.test(text) && !PAST_MONEY_VERB.test(text);
}

/**
 * بندِ خودِ هر مبلغ در جملهٔ چندپرداختی.
 *
 * «اجاره شش ماهه ۳۰ میلیون دادیم، ودیعه هم ۵۰ میلیون دادیم» ودیعه را شش‌ماهه
 * مستهلک می‌کرد و از اجاره «قابل استرداد است؟» می‌پرسید؛ «بیمه یکساله ۱۲ میلیون
 * دادیم و ناهار پرسنل ۲ میلیون» بیمه را «خوراک» و ناهار را پیش‌پرداخت دوازده‌ماهه
 * می‌کرد. دوره یک بار برای کل جمله خوانده می‌شد، دسته از متنِ بعد از مبلغ — که در
 * گفتار چندپرداختی موضوعِ پرداختِ بعدی است — و شاهد ردیف همان متن بعدی بود.
 *
 * مرزِ دو بند، به ترتیب: نشانهٔ جداکننده (، . ؛)، «و»ِ بلافاصله بعد از مبلغ یا
 * فعل، فعلِ پرداختی که چیزی جز «بابت/به/از …»ِ خودش دنبالش نیامده، و آخرین «و».
 * فاصلهٔ بی‌مرز («اجاره ۵ میلیون شارژ ۱ میلیون دادیم») به ترتیب جمله سپرده
 * می‌شود: اگر جمله با موضوع شروع شده، موضوعِ مبلغ بعدی است؛ وگرنه مال قبلی.
 */
const GAP_VERB = /(?<![آ-ی])(?:دادیم|دادم|دادن|داد|پرداخت\s*(?:کردیم|کردم|کردن|کرد|شد)|واریز\s*(?:کردیم|کردم|کردن|کرد|شد)|ریختیم|ریختم|ریختن|ریخت|زدیم|زدم|گرفتیم|گرفتم|خریدیم|خریدم|کارت\s*به\s*کارت\s*(?:کردیم|کردم|کرد|شد)|دریافت\s*(?:کردیم|کردم|کرد|شد)|وصول\s*شد)(?![آ-ی])/;
const LEADING_AND = new RegExp(`^((?:\\s*(?:هم|رو|را|تومان|تومن|ریال)(?![آ-ی]))*\\s*(?:${GAP_VERB.source}\\s*(?:هم(?![آ-ی])\\s*)?)?)و(?![آ-ی])`);
const PURPOSE_AFTER_VERB = /^\s*(?:بابت|برای|واسه|جهت|به|از|تو|توی)(?![آ-ی])/;
function splitGap(gap) {
  const punctuation = gap.search(/[،,.؛;\n]/);
  if (punctuation >= 0) return [punctuation, punctuation + 1];
  const leading = LEADING_AND.exec(gap);
  if (leading) return [leading[1].length, leading[0].length];
  const verb = GAP_VERB.exec(gap);
  if (verb) {
    const end = verb.index + verb[0].length;
    const rest = gap.slice(end);
    if (rest.trim() && !PURPOSE_AFTER_VERB.test(rest)) {
      const and = /^\s*و(?![آ-ی])/.exec(rest);
      return [end, end + (and ? and[0].length : 0)];
    }
  }
  const ands = [...gap.matchAll(/(?<![آ-ی])و(?![آ-ی])/g)];
  return ands.length ? [ands.at(-1).index, ands.at(-1).index + 1] : null;
}
function rowSegments(text, spans, subjectFirst) {
  const cuts = spans.slice(0, -1).map((span, index) => {
    const gap = text.slice(span.end, spans[index + 1].start);
    const [endOfPrevious, startOfNext] = splitGap(gap) || (subjectFirst ? [0, 0] : [gap.length, gap.length]);
    return { end: span.end + endOfPrevious, start: span.end + startOfNext };
  });
  return spans.map((span, index) => ({
    start: index ? cuts[index - 1].start : 0,
    end: index < spans.length - 1 ? cuts[index].end : text.length,
  }));
}

/** سقف نمرهٔ جهت و دستهٔ ردیفی که قضاوت حسابدار می‌خواهد؛ زیر آستانهٔ تأیید. */
const JUDGMENT_SCORE = 0.4;

export function parseFinancialText(rawInput, { learnings = [], averages = {}, source = 'text', now = new Date() } = {}) {
  const input = applySpokenCorrection(rawInput);
  if (hasCompositeAmounts(input)) return { transcript: normalizePersian(input), transactions: [], clarification: COMPOSITE_AMOUNT_MESSAGE };
  if (describesUnperformedCondition(input)) return { transcript: normalizePersian(input), transactions: [], clarification: UNPERFORMED_CONDITION_MESSAGE };
  // «مستاجر قراره ۶۰ میلیون واریز کنه»: هنوز هیچ پولی جابه‌جا نشده.
  if (payerNotYet(input) === 'promised') return { transcript: normalizePersian(input), transactions: [], clarification: PAYER_PROMISE_MESSAGE };
  // تاریخ پیش از مبلغ خوانده می‌شود، چون رقم‌های تاریخ نباید مبلغ شمرده شوند.
  //
  // «در تاریخ 15 5 1405 13 میلیون تومان» مبلغ را ۱٬۴۳۸٬۰۰۰٬۰۰۰ می‌خواند:
  // ۱۵ و ۵ و ۱۴۰۵ و ۱۳ همه در یک عدد جمع می‌شدند. این بدترین نوع خطاست، چون
  // سند با مبلغی صد برابر ثبت می‌شود و هیچ نشانه‌ای هم ندارد.
  // طول خدمت («برای ۶ ماه آینده») تاریخ وقوع پرداخت نیست.
  const duration = readServicePeriod(normalizePersian(input), { occurredAt: now.toISOString() });
  const dateSource = duration
    ? normalizePersian(input).replace(/(?:برای\s*)?(?:\d+|یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|دوازده)\s*ماه\s*(?:آینده|جلوتر|بعد|پیش\s*رو|آتی)/g, ' ')
    : input;
  // A due-date clause is not the occurrence date of an unpaid bill.
  const occurrenceSource = normalizePersian(dateSource).replace(/(?:موعد\s*پرداخت(?:ش)?|سررسید(?:ش)?)\s*[^،,.؛]*/g, ' ');
  const mentionedDate = extractOccurrenceDate(occurrenceSource, { now, preferPast: true });
  // تاریخِ آینده در جمله‌ای که پول را با فعل گذشته گفته، تاریخ وقوع نیست.
  //
  // «ده میلیون پیش‌پرداخت دادیم که جنس رو هفته بعد تحویل بده» و «دویست میلیون
  // وام گرفتیم؛ قسط‌هاش از ماه بعد شروع می‌شه» پرداخت و دریافت را به هفته و ماه
  // بعد می‌بردند: آن تاریخ مال تحویل و قسط است. پولی که «دادیم» امروز رفته.
  const futureOfPast = mentionedDate?.iso && Date.parse(mentionedDate.iso) > now.getTime() + 43_200_000
    && PAST_MONEY_VERB.test(occurrenceSource);
  const occurredAt = futureOfPast ? null : mentionedDate?.iso || null;
  // بانک روی متن اصلی خوانده می‌شود، پیش از هر ماسکی، تا جای تطبیق جابه‌جا نشود.
  const bank = detectBank(input);
  // جابه‌جایی بین دو حساب خودِ دفتر. تا امروز این جمله هزینه ثبت می‌شد و یک
  // زیان جعلی می‌ساخت که — برخلاف خطای پیش‌پرداخت — هیچ‌وقت خودش را اصلاح
  // نمی‌کند. تشخیصش از قبل نوشته شده بود و هیچ‌کس صدایش نمی‌زد.
  const transferPair = detectTransferBanks(input);
  // «از تنخواه پذیرایی خریدیم»: پول از حساب تنخواه رفته، نه از صندوق اصلی.
  const petty = readPettyCash(input);
  // یک بار برای کل جمله، نه برای هر تراکنش: تایپ زنده بودجهٔ میلی‌ثانیه‌ای
  // دارد و همین اشتباه یک بار با تشخیص انتقال تکرار شده بود.
  const prepayment = readPrepaymentMention(input);
  // دوره و نشانهٔ پرداخت‌نشدن هم یک بار برای کل جمله، نه برای هر تراکنش.
  const unpaid = readUnpaidSignal(input);
  const eventNature = readEventNature(input);
  // دوره نسبت به تاریخ رویداد حساب می‌شود، نه تاریخ اجرای کد: «برای شش ماه
  // جلوتر» در جمله‌ای که تاریخش دیروز است، از دیروز شروع می‌شود.
  // سالی که خوانندهٔ دوره سال می‌خواند («مهر ۰۵ ۳۰ میلیون»، «سال ۱۴۰۶ ۱۲ میلیون»)
  // مبلغ نیست: پیش از خواندن مبلغ ماسک می‌شود، وگرنه ۳۵ و ۱٬۴۱۸ میلیون خوانده می‌شد.
  // چون ماسک شده، خوانندهٔ دوره هم دیگر لازم نیست چنین جمله‌ای را نخواند.
  const yearSpans = periodYearSpans(input, { occurredAt: occurredAt || now.toISOString() });
  const servicePeriod = readServicePeriod(normalizePersian(input), { occurredAt: occurredAt || now.toISOString(), yearsMasked: true });
  // فقط بخشِ تاریخ با فاصله جایگزین می‌شود تا بقیهٔ جمله و مبلغ دست‌نخورده بماند.
  let amountSource = mentionedDate?.match || bank || yearSpans.length
    ? normalizePersian(input)
    : input;
  for (const span of yearSpans) {
    amountSource = `${amountSource.slice(0, span.index)}${' '.repeat(span.length)}${amountSource.slice(span.index + span.length)}`;
  }
  if (mentionedDate?.match) amountSource = amountSource.replace(mentionedDate.match, ' '.repeat(mentionedDate.match.length));
  // نام بانک هم ماسک می‌شود، وگرنه «بانک صادرات» دستهٔ «صادرات» می‌سازد و
  // «بانک مسکن» را هزینهٔ اجاره می‌خواند.
  // همان جایی که بانک تطبیق خورد، نه اولین تکرار نام: در «به بیمه ملت از ملت
  // دادیم» ملتِ اول نام بیمه‌گر است.
  if (bank) {
    amountSource = amountSource.slice(bank.index, bank.index + bank.matchedText.length) === bank.matchedText
      ? `${amountSource.slice(0, bank.index)}${' '.repeat(bank.matchedText.length)}${amountSource.slice(bank.index + bank.matchedText.length)}`
      : amountSource.replace(bank.matchedText, ' '.repeat(bank.matchedText.length));
  }
  const extracted = extractAmounts(amountSource);
  const { text } = extracted;
  // نرخ دوره‌ای، پرداخت جدا نیست: «بیمهٔ یک‌ساله ۱۲ میلیون، ماهیانه ۱ میلیون» یک
  // پرداخت ۱۲ میلیونی است و «ماهیانه ۱ میلیون» فقط می‌گوید هر ماه چقدرش هزینه
  // می‌شود. بدون این، ۱۳ میلیون از حساب کم می‌شد (گزارش کاربر، ۱۸ مهر ۱۴۰۵).
  // فقط وقتی کنارش مبلغ دیگری هست؛ «حقوق ماهیانه ۱۰ میلیون دادیم» خودش پرداخت است.
  const spans = withoutRateAmounts(text, extracted.spans);
  // نام طرف حساب از همان جمله برداشته می‌شود، حتی وقتی جمله «طلب و بدهی»
  // نیست. «۹۳ میلیون تومان به شرکت آراد گستر آسیا پرداخت شد» تا امروز یک
  // هزینهٔ ساده ثبت می‌شد و نام شرکت دور ریخته می‌شد — شرکتی که کارت حساب
  // داشت، هیچ ردی از این پرداخت در کارتش نمی‌ماند.
  //
  // اینجا فقط نام برداشته می‌شود. اینکه این پرداخت تسویهٔ بدهی اوست یا هزینه،
  // به ماندهٔ همان شخص در دفتر بستگی دارد و تصمیمش با سرور است.
  //
  // دارندهٔ تنخواه طرف حساب نیست: در «آقای رضایی از تنخواه به آقای کریمی بابت
  // تعمیر داد» پول را کریمی گرفته و رضایی فقط از تنخواه پرداخته است.
  const contactSource = petty?.holder
    ? input.replace(new RegExp(`(?:(?:آقای|اقای|خانم|مهندس|دکتر|حاج|حاجی)[\\s\\u200c]*)?${petty.holder}`), (match) => ' '.repeat(match.length))
    : input;
  const counterparty = extractContactCandidate(contactSource);
  const counterpartyName = counterparty.name;
  const moneyDirection = counterpartyName ? counterpartyMoneyDirection(contactSource) : '';
  // جهتِ پول از نقش پرداخت‌کننده: «مستاجر … واریز کرد». در جملهٔ چندپرداختی هر
  // ردیف از بند خودش (rowsPaidUs پایین‌تر).
  const moneyIn = counterpartyPaidUs(input);
  // برگشت وجه یا فسخ قرارداد: قضاوتش با حسابدار است (shared/refundSpeech.js)؛
  // جهتش فقط از فعل صریحِ برگشت، برای هر ردیف جدا.
  const refundJudgment = readContractRefund(input);
  // پرداخت‌کنندهٔ جمله، برای بندی که فقط «۵ میلیون هنوز نداده» را دارد.
  const sentencePayer = PAYER_ROLE_RE.test(normalizePersian(input)) ? 'role'
    : TITLED_PARTY.test(normalizePersian(input)) && !OTHER_RECIPIENT.test(normalizePersian(input)) ? 'titled' : null;
  const categoryWords = CATEGORY_DEFINITIONS.flatMap((item) => item.keywords.map((keyword) => keyword.word));
  const signalWords = [...INCOME_WORDS, ...EXPENSE_WORDS, ...categoryWords];
  // جملهٔ چندپرداختی: هر مبلغ بندِ خودش را دارد — موضوع، دوره، نشانهٔ پیش‌پرداخت،
  // طرف حساب و شاهد. پنجرهٔ جهت عمداً پهن می‌ماند، چون فعلِ آخر جمله («اجاره
  // ماهانه ۵ میلیون و ودیعه ۵۰ میلیون دادیم») فعل مشترک همهٔ ردیف‌هاست.
  const segments = spans.length > 1 ? rowSegments(text, spans, containsAny(text.slice(0, spans[0].start), categoryWords)) : [];
  // متنِ نرمال‌شدهٔ بی‌ماسک، وقتی هم‌طول است، تا شاهد نام بانک و تاریخ را گم نکند.
  const unmaskedText = normalizePersian(input);
  const segmentSource = unmaskedText.length === text.length ? unmaskedText : text;
  const clauses = segments.map((segment) => segmentSource.slice(segment.start, segment.end));
  const paidUs = segments.length ? rowsPaidUs(clauses, moneyIn) : [moneyIn];
  const transactions = spans.map((span, index) => {
    const segment = segments[index];
    const ownText = segment ? clauses[index] : null;
    const clause = normalizePersian(ownText ?? input);
    // پرداخت‌کننده‌ای که این مبلغ را هنوز نداده یا فقط قولش را داده: ردیفِ بی‌پول.
    const notYet = segment ? clauseNotYet(clause, sentencePayer) : payerNotYet(input);
    const rowMoneyIn = paidUs[index] || Boolean(notYet);
    // «اجاره … گرفتیم» بی پرداخت‌کننده و بی فعل پرداختِ ما: جهت روشن نیست.
    const rentTaken = !rowMoneyIn && RENT_TAKEN.test(clause) && !MONEY_OUT_VERB.test(clause);
    const refund = contractRefundDirection(ownText ?? input, { subject: input });
    const previousEnd = spans[index - 1]?.end ?? 0;
    const nextStart = spans[index + 1]?.start ?? text.length;
    const afterRaw = text.slice(span.end, nextStart).trim();
    const beforeRaw = text.slice(previousEnd, span.start).trim();
    // نشانه‌های قیمتی ارزش افزوده — «با ارزش افزوده»، «به علاوهٔ مالیات» — از
    // پنجرهٔ دسته و جهت کنار می‌روند. آن‌ها می‌گویند قیمت چطور حساب شده، نه
    // موضوع خرج چیست؛ ولی قوی‌ترین واژهٔ جمله بودند و «لپ‌تاپ خریدم با احتساب
    // ارزش افزوده» را «مالیات و عوارض» می‌کردند و «فروش ۱۰۰ میلیون به علاوه
    // ارزش افزوده» را حتی هزینه. متن خام ردیف دست‌نخورده می‌ماند تا نگهبان
    // ارزش افزوده همان را ببیند.
    const afterAmount = withoutVatQualifiers(afterRaw);
    const beforeAmount = withoutVatQualifiers(beforeRaw);
    const afterSignals = containsAny(afterAmount, signalWords);
    const context = afterSignals ? afterAmount : `${beforeAmount} ${afterAmount}`.trim();
    const rawContext = afterSignals ? afterRaw : `${beforeRaw} ${afterRaw}`.trim();
    // پنجرهٔ دسته از پنجرهٔ جهت جداست.
    //
    // موضوعِ خرج در فارسی گفتاری تقریباً همیشه پیش از مبلغ می‌آید: «قبض برق رو
    // سه میلیون پرداخت کردم». پنجرهٔ بالا به‌محض دیدن یک فعل بعد از مبلغ، هرچه
    // قبلش بوده دور می‌ریزد — و دسته همان‌جا بود. پس فقط وقتی به متنِ بعد از
    // مبلغ بسنده می‌کنیم که خودش واژهٔ دسته داشته باشد.
    const ownBefore = segment ? withoutVatQualifiers(text.slice(segment.start, span.start).trim()) : beforeAmount;
    const ownAfter = segment ? withoutVatQualifiers(text.slice(span.end, segment.end).trim()) : afterAmount;
    const categoryContext = containsAny(ownAfter, categoryWords)
      ? ownAfter
      : `${ownBefore} ${ownAfter}`.trim();
    // «اشتراک یک‌ساله رو کنسل کرد» دورهٔ قرارداد قبلی است، نه پوششی که حالا خریده‌ایم.
    const rowPeriod = refundJudgment ? null : segment ? readServicePeriod(ownText, { occurredAt: occurredAt || now.toISOString(), yearsMasked: true }) : servicePeriod;
    const rowPrepayment = segment ? readPrepaymentMention(ownText) : prepayment;
    // نامی که خودِ بند گفته؛ وگرنه نام جمله، مثل همیشه. نام حدسیِ بند («به
    // تاریخ ۳۰ آبان»، «به سامان واریز کردند») جای نام مطمئنِ جمله را نمی‌گیرد.
    const ownContact = segment && !petty?.holder ? extractContactCandidate(ownText) : null;
    const rowCounterparty = ownContact?.name && (ownContact.confident || !counterparty.name) ? ownContact : counterparty;
    const rowMoneyDirection = rowCounterparty === ownContact ? counterpartyMoneyDirection(ownText) : moneyDirection;
    // «سرور ابری ۱۲ ماهه ۱۸ میلیون ریختیم»: فعل پرداختِ همین بند (نه کل جمله) نوع را می‌گوید.
    let classified = classify(context, learnings, categoryContext, { moneyIn: rowMoneyIn, rentTaken, rowText: text.slice(previousEnd, nextStart) });
    // جهت پول از کل جمله، وقتی جمله یک مبلغ بیشتر ندارد.
    //
    // پنجرهٔ جهت فقط متنِ کنار مبلغ را می‌بیند و «یه پولی اومده تو حساب ملی
    // بیست و دو میلیون، معلوم نیس کی ریخته» را خروج پول می‌خواند چون نشانهٔ
    // ورود پیش از مبلغ آمده. ردیف تراکنش با جهت غلط، ماندهٔ بانک را غلط
    // می‌گذارد — حتی وقتی سندش به صف حسابدار رفته.
    // در جملهٔ چندپرداختی همان فعلِ سوم‌شخص از بندِ خودِ ردیف: «آقای رضایی ۱۰
    // میلیون داد ولی ۵ میلیون هنوز نداده».
    if (classified.type === 'expense' && !refundJudgment && (spans.length === 1
      ? (sentenceMoneyIn(input) || (classified.category === 'سایر هزینه‌ها' && thirdPersonGave(input)))
      : (classified.category === 'سایر هزینه‌ها' && Boolean(ownText) && thirdPersonGave(ownText)))) {
      const incomeContext = maskRoleNouns(normalizePersian(categoryContext || context));
      const matchedIncome = classifyCategory(incomeContext, 'income');
      const incomeCategory = matchedIncome.matched ? matchedIncome : incomeTwin(incomeContext) || matchedIncome;
      classified = {
        ...classified, type: 'income', category: incomeCategory.category, chartCode: chartCodeForCategory(incomeCategory.category),
        confidence: explicitMoneyIn(input) ? 0.86 : Math.min(classified.confidence, 0.68),
        typeReason: explicitMoneyIn(input)
          ? 'جمله صریح می‌گوید طرف مقابل به حساب ما ریخته یا باید بدهد؛ جهت از کل جمله برداشت شد.'
          : 'جمله صریح می‌گوید پول به حساب آمده؛ جهت از کل جمله برداشت شد و باید کنترل شود.',
      };
    }
    const refundType = refund === 'in' ? 'income' : refund === 'out' ? 'expense' : null;
    if (refundType) {
      // پولِ برگشتی به ما درآمد اجاره یا خدمت نیست؛ دوقلوی درآمدی اینجا به کار نمی‌رود.
      const refundCategory = classified.type === refundType && refundType === 'expense' ? null
        : classifyCategory(maskRoleNouns(normalizePersian(categoryContext || context)), refundType);
      classified = {
        ...classified, type: refundType,
        ...(refundCategory ? { category: refundCategory.category, chartCode: chartCodeForCategory(refundCategory.category) } : {}),
        categoryAmbiguous: false, categoryRunnerUp: null, directionUnclear: false,
        typeReason: refundType === 'income' ? 'برگشت وجه قرارداد به ما؛ پول وارد شده است.' : 'برگشت وجه به مشتری یا مستاجر؛ پول خارج شده است.',
      };
    }
    let amount = span.amount;
    // «پنجاه تومن» یعنی پنجاه هزار تومان. هیچ چیزی در ایران امروز پنجاه تومان
    // نیست، پس محدودکردن این قاعده به سه‌رقمی‌ها فقط مبلغ‌های کوچک را خراب می‌کرد.
    const colloquialThousands = amount > 0 && amount < 1_000
      && !/\d|هزار|میلیون|میلیارد/.test(span.raw)
      && /تومان|تومن/.test(context);
    if (colloquialThousands) amount *= 1_000;
    // «بنزین ۸۰۰ تومن زدیم»: رقم تایپ‌شده تبدیل نمی‌شود، ولی هشتصد تومان چیزی
    // نمی‌خرد و بی‌صدا ثبت می‌شد. مقیاسش مبهم علامت می‌خورد و موتور می‌پرسد:
    // «۸۰۰ تومان یا ۸۰۰٬۰۰۰ تومان؟».
    // کوتاه‌نوشتِ مقیاس پس از رقم: «۱۲۰ م»، «۱۲۰م»، «۵۰۰ت»، «12 m». همان خانوادهٔ
    // «ملیون»: «اجاره یکساله ۱۲۰ م دادیم» پیش‌پرداخت ۱۲۰ تومانی ثبت می‌کرد.
    const abbreviation = amount > 0 && amount < 1_000 && /\d/.test(span.raw) && !/هزار|میلیون|میلیارد/.test(span.raw)
      ? SCALE_ABBREVIATION.exec(text.slice(span.end, span.end + 6))?.[1] || null : null;
    const typedSmallToman = !colloquialThousands && amount > 0 && amount < 1_000
      && /\d/.test(span.raw) && !/هزار|میلیون|میلیارد/.test(span.raw) && (/تومان|تومن/.test(context) || THOUSAND_ABBREVIATIONS.includes(abbreviation));
    // «م» یعنی میلیون (یا متر)؛ پرسش مقیاس فقط «×۱ یا ×۱۰۰۰» دارد، پس حدس زده نمی‌شود.
    const millionAbbreviation = MILLION_ABBREVIATIONS.includes(abbreviation)
      ? `«${span.raw} ${abbreviation}» کوتاه‌نوشت مقیاس است و مبلغ دقیقش روشن نیست؛ مبلغ را با «میلیون» یا «هزار» بگو.`
      : null;
    if (context.includes('ریال') && !containsAny(context, ['تومان', 'تومن'])) amount = Math.round(amount / 10);
    const average = Number(averages[classified.type] || 0);
    const unusual = average > 0 && amount >= average * 5;
    const ambiguous = classified.confidence < 0.7;
    const reviewReasons = [];
    // «بیمه یک ساله ۱۲ میلیون دادیم»: دورهٔ فقط‌مدت از همان تاریخ پرداخت (امروز)
    // شروع می‌شود؛ تاریخی گفته نشده که با تاریخ پرداخت اشتباه شود. فقط وقتی شروع
    // پوشش گفته شده («از اول فروردین تا آخر اسفند») تاریخ پرداخت را باید جدا پرسید.
    const paymentDateUnknown = Boolean(rowPeriod && !occurredAt && rowPeriod.start !== now.toISOString());
    if (paymentDateUnknown) reviewReasons.push('تاریخ پرداخت مشخص نیست؛ تاریخ پوشش یا دورهٔ خدمت جای تاریخ پرداخت نیست.');
    // آوردهٔ مالک درآمد نیست و دارایی ثابت هزینه نیست.
    //
    // برای این جمله‌ها برگهٔ مخصوص باز می‌شود، ولی اگر کاربر آن را ببندد و
    // همین‌جا ثبت کند، ۲۰۰ میلیون آورده بی‌صدا در درآمد می‌نشیند: سود دوره باد
    // می‌کند و مالیات روی پول خودِ مالک حساب می‌شود. پس این ثبت هرگز بی‌پرسش
    // رد نمی‌شود.
    const capitalWording = mentionsCapitalOrAsset(normalizePersian(context || text));
    if (capitalWording === 'capital') reviewReasons.push('این جمله از آوردهٔ سرمایه می‌گوید؛ آورده درآمد نیست و باید در بخش سرمایه ثبت شود.');
    if (capitalWording === 'fixed-asset') reviewReasons.push('این جمله از دارایی ثابت می‌گوید؛ دارایی ثابت هزینهٔ این ماه نیست.');
    if (natureNeedsAccountant(eventNature)) reviewReasons.push('این جمله اصلاح یک ثبت قبلی است؛ تراکنش تازه ساخته نمی‌شود و برای اصلاح به حسابدار می‌رسد.');
    if (unusual) reviewReasons.push('مبلغ نسبت به میانگین ثبت‌های مشابه غیرعادی است.');
    if (colloquialThousands || typedSmallToman) reviewReasons.push('مقیاس مبلغ مبهم است؛ مبلغ دقیق را با هزار، میلیون یا میلیارد مشخص کن.');
    if (ambiguous) reviewReasons.push('نوع تراکنش از متن با اطمینان کافی مشخص نیست.');
    if (classified.directionUnclear) reviewReasons.push(RENT_DIRECTION_UNCLEAR);
    // دستهٔ مساوی میان خدمتِ دوره‌دار و دستهٔ دیگر: کلید پیش‌پرداخت و هزینهٔ هر
    // ماهِ برنامه همین دسته است، پس انتخابِ ترتیبیِ برنده دوازده سند غلط می‌سازد.
    const serviceTie = classified.categoryAmbiguous
      && [classified.category, classified.categoryRunnerUp].some((name) => TIME_BOUND_SERVICE_CATEGORIES.includes(name))
      ? `دسته روشن نیست: «${classified.category}» یا «${classified.categoryRunnerUp}»؛ حساب پیش‌پرداخت و هزینهٔ ماهانه به همین دسته بسته است و حدس زده نمی‌شود.`
      : null;
    if (serviceTie) reviewReasons.push(serviceTie);
    if (refundJudgment) reviewReasons.push(CONTRACT_REFUND_REASON);
    if (millionAbbreviation) reviewReasons.push(millionAbbreviation);
    if (notYet) reviewReasons.push(PAYER_UNPAID);
    const depositReceived = !refundJudgment && !notYet && classified.type === 'income' && rowMoneyIn && DEPOSIT_WORD.test(clause);
    if (depositReceived) reviewReasons.push(DEPOSIT_RECEIVED);
    const rateChange = span.rateChange ? RATE_CHANGE_REASON : null;
    if (rateChange) reviewReasons.push(rateChange);
    const payerGaveUnclear = classified.type === 'expense' && spans.length === 1 && !refundJudgment && !notYet && thirdPartyGaveMoney(input);
    if (payerGaveUnclear) reviewReasons.push(PAYER_GAVE_UNCLEAR);
    const judgment = millionAbbreviation || rateChange || (refundJudgment ? CONTRACT_REFUND_REASON : notYet ? PAYER_UNPAID
      : depositReceived ? DEPOSIT_RECEIVED : classified.directionUnclear ? RENT_DIRECTION_UNCLEAR : payerGaveUnclear ? PAYER_GAVE_UNCLEAR : serviceTie);
    if (span.bareScale) reviewReasons.push(`عدد پیش از «${span.raw}» شنیده نشد؛ مبلغ را خودت بنویس.`);
    // دلیلِ قضاوت اول می‌آید: صف حسابدار همان را نشان می‌دهد، نه «نوع با اطمینان
    // کم» که فقط پیامدِ همان قضاوت است.
    if (judgment) reviewReasons.sort((left, right) => Number(right === judgment) - Number(left === judgment));
    const transaction = {
      amount, type: classified.type, category: classified.category,
      // مقیاس محاوره‌ای ابهام دارد و حدس‌زدنش خطای هزاربرابری می‌سازد.
      // مقدار همان ×۱۰۰۰ می‌ماند تا مسیر قدیمی نشکند؛ این پرچم می‌گوید موتور
      // تصمیم باید بپرسد.
      ...(colloquialThousands || typedSmallToman ? { amountScaleAmbiguous: true } : {}),
      // نشانهٔ ماهیت، نه دسته: پول رفته ولی هنوز هیچ چیزی بابتش نگرفته‌ایم.
      ...(rowPrepayment ? { prepaymentSignal: true } : {}),
      ...(unpaid || notYet ? { unpaidSignal: true } : {}),
      ...(eventNature !== EVENT_NATURES.NEW ? { eventNature } : {}),
      ...(rowPeriod ? { servicePeriodStart: rowPeriod.start, servicePeriodEnd: rowPeriod.end } : {}), ...(paymentDateUnknown ? { paymentDateUnknown: true } : {}), chartCode: classified.chartCode,
      // Amount extraction masks banks and dates. Those masks must never become
      // the user's evidence. Keep scoped context for genuinely separate amounts.
      rawText: spans.length === 1 ? String(input) : ownText.trim() || rawContext || text,
      ...(rowCounterparty.name ? {
        contactName: rowCounterparty.name, moneyDirection: rowMoneyDirection, contactNameConfident: rowCounterparty.confident,
      } : {}),
      // دستهٔ مبهم یعنی دو دسته به یک اندازه موجه بودند؛ ثبت چنین چیزی بدون
      // نگاه کاربر همان خطای بی‌صداست که در بخش مبلغ بستیم.
      confidence: classified.confidence,
      // جهتِ نامعلوم سؤال گزینه‌ای ندارد؛ قضاوتش با حسابدار است و موتور تصمیم
      // پیش از هر قاعده‌ای همین را می‌خواند.
      ...(judgment ? { needsJudgment: judgment } : {}),
      needsReview: Boolean(judgment) || unusual || ambiguous || colloquialThousands || typedSmallToman || span.bareScale || classified.categoryAmbiguous || Boolean(capitalWording) || natureNeedsAccountant(eventNature),
      source,
      ...(occurredAt ? { occurredAt, occurredAtLabel: mentionedDate.label, occurredAtSource: mentionedDate.kind } : {}),
      // شناسهٔ بانک می‌رود، نه شناسهٔ حساب: پارسر دفتر را نمی‌شناسد و نمی‌داند
      // این کاربر کدام حساب را به کدام بانک بسته است. نگاشت کار سرور است.
      ...(bank ? { bankId: bank.bankId, bankName: bank.bankName } : {}),
      // شناسهٔ بانک می‌رود نه شناسهٔ حساب، به همان دلیل بالا: نگاشت کار سرور است.
      // نام دارنده می‌رود نه شناسهٔ حساب، به همان دلیل: پارسر حساب‌های دفتر را نمی‌شناسد.
      ...(petty?.action === 'spend' && classified.type === 'expense' ? { pettyCash: { action: 'spend', holder: petty.holder } } : {}),
      ...(transferPair ? { transfer: { fromId: transferPair.from.id, fromName: transferPair.from.name, toId: transferPair.to.id, toName: transferPair.to.name } } : {}),
      confidenceDetails: {
        amount: {
          score: span.bareScale ? 0.3 : colloquialThousands ? 0.66 : source === 'voice' ? 0.93 : 0.98,
          reason: span.bareScale
            ? `فقط واژهٔ «${span.raw}» شنیده شد و عددِ پیش از آن گم شده است.`
            : colloquialThousands
              ? 'مبلغ با قاعدهٔ گفتار محاوره‌ای به هزار تومان تبدیل شد.'
              : source === 'voice' ? 'مبلغ از نتیجهٔ تشخیص گفتار استخراج شد.' : 'مبلغ مستقیم از متن استخراج شد.',
        },
        // قضاوتِ حسابدار یعنی ماهیت و جهت هنوز قطعی نیست. نمرهٔ پایین همین را
        // به مسیر می‌گوید تا حتی با موتور تصمیمِ خاموش، ردیف به صف حسابدار برود و
        // روی برگهٔ «امروز» صاحب کسب‌وکار ننشیند (confirmThreshold).
        type: judgment
          ? { score: Math.min(classified.typeConfidence, JUDGMENT_SCORE), reason: 'ماهیت و جهت این پول را حسابدار تعیین می‌کند.' }
          : { score: classified.typeConfidence, reason: classified.typeReason },
        category: judgment
          ? { score: Math.min(classified.categoryConfidence, JUDGMENT_SCORE), reason: 'دسته پس از قضاوت حسابدار قطعی می‌شود.' }
          : { score: classified.categoryConfidence, reason: classified.categoryReason },
        account: bank
          ? { score: 0.97, reason: `حساب از نام «${bank.bankName}» در گفتار مشخص شد.` }
          : { score: 0.82, reason: 'حساب پیش‌فرض دفتر انتخاب می‌شود؛ قبل از ثبت قابل تغییر است.' },
      },
      reviewReasons,
      warning: span.bareScale
        ? `عدد پیش از «${span.raw}» شنیده نشد؛ این مبلغ حدس است، نه برداشت.`
        : unusual
          ? 'این مبلغ بیشتر از پنج برابر میانگین ثبت‌های مشابه توست. مطمئنی؟'
          : colloquialThousands
          ? `«${span.raw} تومان» به‌صورت محاوره‌ای ${new Intl.NumberFormat('fa-IR').format(amount)} تومان برداشت شد؛ مبلغ را بررسی کن.`
          : ambiguous ? 'نوع این تراکنش با اطمینان کم تشخیص داده شد؛ لطفاً بررسی کن.' : null,
      alternatives: colloquialThousands ? [span.amount] : [],
    };
    return withReviewAssessment(transaction);
  });
  if (natureNeedsAccountant(eventNature) && transactions.length > 1) {
    const representative = /مبلغ\s+درست|صحیح|باید/.test(normalizePersian(input)) ? transactions.at(-1) : transactions[0];
    return { transcript: String(input), transactions: [{ ...representative, rawText: normalizePersian(input), needsReview: true,
      reviewReasons: [...representative.reviewReasons, 'این یک درخواست اصلاح است؛ مبلغ نمایش‌داده‌شده پیشنهادی است و سند قبلی باید توسط حسابدار بررسی شود.'] }] };
  }
  return { transcript: String(input), transactions: collapseRepeatedTransactions(transactions) };
}

export function parseRecognitionCandidates(candidates, options = {}) {
  const unique = [];
  for (const candidate of candidates || []) {
    const transcript = normalizePersian(typeof candidate === 'string' ? candidate : candidate?.transcript);
    if (!transcript || unique.some((item) => item.transcript === transcript)) continue;
    unique.push({ transcript, speechConfidence: Number(typeof candidate === 'string' ? 0 : candidate?.confidence) || 0 });
  }
  if (!unique.length) return { transcript: '', transactions: [], engine: 'browser-live' };
  const parsed = unique.map((candidate) => {
    const result = parseFinancialText(candidate.transcript, { ...options, source: 'voice' });
    const averageParserConfidence = result.transactions.length
      ? result.transactions.reduce((sum, item) => sum + item.confidence, 0) / result.transactions.length
      : 0;
    // تعداد بیشتر نباید یک برداشت کم‌اعتماد را برنده کند؛ این کار اعداد فرعی را به تراکنش جعلی تبدیل می‌کرد.
    const score = (result.transactions.length ? 250 : 0)
      + averageParserConfidence * 100
      + candidate.speechConfidence * 120;
    return { ...candidate, result, score };
  }).sort((left, right) => right.score - left.score);
  const best = parsed[0];
  if (!best.result.transactions.length) return { ...best.result, engine: 'browser-live', speechConfidence: best.speechConfidence };
  const candidateCountDisagreement = parsed.slice(1).some((candidate) => (
    candidate.result.transactions.length > 0
    && candidate.result.transactions.length !== best.result.transactions.length
  ));
  const transactions = best.result.transactions.map((item, index) => {
    const alternatives = [...new Set(parsed.slice(1)
      .filter((candidate) => candidate.result.transactions.length === best.result.transactions.length)
      .map((candidate) => candidate.result.transactions[index]?.amount)
      .filter((amount) => Number.isFinite(amount) && amount > 0 && amount !== item.amount))].slice(0, 2);
    const typeDisagreement = parsed.slice(1).some((candidate) => {
      if (candidate.result.transactions.length !== best.result.transactions.length) return false;
      const alternative = candidate.result.transactions[index];
      return alternative && (alternative.type !== item.type || alternative.category !== item.category);
    });
    if (!alternatives.length && !candidateCountDisagreement && !typeDisagreement) return { ...item, speechConfidence: best.speechConfidence };
    const warning = alternatives.length
      ? 'چند مبلغ متفاوت شنیده شد؛ مبلغ را با دقت بررسی کن.'
      : candidateCountDisagreement
        ? 'تعداد ثبت‌ها در برداشت‌های صدا یکسان نبود؛ همهٔ موارد را بررسی کن.'
        : 'نوع یا دستهٔ تراکنش در برداشت‌های صدا یکسان نبود؛ لطفاً بررسی کن.';
    const fieldChanges = {};
    if (alternatives.length || candidateCountDisagreement) fieldChanges.amount = {
      ...item.confidenceDetails?.amount,
      score: Math.min(item.confidenceDetails?.amount?.score ?? 0.93, 0.56),
      reason: alternatives.length ? 'موتور گفتار چند مبلغ متفاوت پیشنهاد کرد.' : 'برداشت‌های گفتار دربارهٔ تعداد مبلغ‌ها یکسان نبودند.',
    };
    if (typeDisagreement) {
      fieldChanges.type = { ...item.confidenceDetails?.type, score: 0.56, reason: 'برداشت‌های گفتار دربارهٔ نوع تراکنش یکسان نبودند.' };
      fieldChanges.category = { ...item.confidenceDetails?.category, score: 0.56, reason: 'برداشت‌های گفتار دربارهٔ دسته یکسان نبودند.' };
    }
    return withReviewAssessment({
      ...item,
      speechConfidence: best.speechConfidence,
      alternatives,
      needsReview: true,
      confidence: undefined,
      confidenceDetails: { ...item.confidenceDetails, ...fieldChanges },
      reviewReasons: [...(item.reviewReasons || []), warning],
      reviewCode: alternatives.length ? 'candidate-amount-disagreement' : candidateCountDisagreement ? 'candidate-count-disagreement' : 'candidate-type-disagreement',
      warning: item.warning ? `${item.warning} ${warning}` : warning,
    });
  });
  return {
    ...best.result,
    transactions,
    engine: 'browser-live',
    speechConfidence: best.speechConfidence,
    candidateDisagreement: transactions.some((item) => item.reviewCode?.startsWith('candidate-')),
  };
}
