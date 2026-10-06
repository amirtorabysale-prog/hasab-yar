import { taxPenaltyFacts } from './reviewTaxPenalty.js';
import { normalizePersian } from './normalize.js';

/**
 * دسته‌بندی هزینه و درآمد برای دفتر حسابداری.
 *
 * تا امروز ۹ قاعدهٔ hardcode با `.find()` کار می‌کرد، یعنی **اولین** تطابق
 * برنده بود نه بهترین. «اجارهٔ انبار برای کالا» بسته به ترتیب نوشتن قاعده‌ها
 * یک‌بار «اجاره» می‌افتاد و یک‌بار «مواد و کالا» — و کاربر هیچ‌وقت نمی‌فهمید چرا.
 *
 * دو تغییر بنیادی اینجاست:
 *
 * ۱. امتیازدهی به‌جای اولین تطابق. هر واژه وزن دارد: عبارت دوکلمه‌ایِ صریح
 *    («کارمزد بانک») از واژهٔ تک‌کلمه‌ایِ عمومی («بانک») قوی‌تر است، چون
 *    واژهٔ عمومی در ده جملهٔ بی‌ربط هم پیدا می‌شود.
 * ۲. هر دسته به کدینگ حساب نگاشت می‌شود. مشتری ما دفتر حسابداری است؛
 *    «هزینهٔ اسنپ» برایش سند نیست، «۸۱۰۳ حمل‌ونقل» هست.
 */

// وزن‌ها: عبارت اختصاصی ۳، واژهٔ معمول دسته ۲، واژهٔ عمومی که در جای دیگر هم
// دیده می‌شود ۱. عدد مطلق مهم نیست؛ فاصلهٔ بین آن‌ها مهم است.
const STRONG = 3;
const NORMAL = 2;
const WEAK = 1;

/**
 * کد معین پیش از تفکیک کدینگ پیشنهادی.
 *
 * تا مهر ۱۴۰۵ ده دستهٔ هزینه — کارمزد بانکی، ملزومات، تبلیغات، تعمیر و … —
 * همه روی «۸۱۰۹ سایر هزینه‌های عملیاتی» می‌نشستند و «بیمه» حتی روی «۸۱۰۱ حقوق
 * و دستمزد». دفتری که کدینگ را پیش از تفکیک نصب کرده، کد تازه را ندارد؛ برای
 * او همان کد عمومی قبلی پیشنهاد می‌شود تا نگاشت خودکارش خالی نماند. بیمه
 * عمداً به ۸۱۰۹ برمی‌گردد، نه ۸۱۰۱: حق‌بیمهٔ دارایی و مسئولیت، حقوق نیست.
 */
const LEGACY_CHART_CODES = Object.freeze({ 'inc-rent': '6201', 'exp-insurance': '8109', 'exp-tax': '8109', 'exp-fuel': '8103', 'exp-office': '8109', 'exp-marketing': '8109', 'exp-software': '8109', 'exp-bank': '8109', 'exp-repair': '8109', 'exp-contractor': '8109', 'exp-food': '8109', 'exp-training': '8109' });

function rule(id, name, type, chartCode, groups) {
  const keywords = [];
  for (const [weight, words] of groups) for (const word of words) keywords.push({ word: normalizePersian(word), weight });
  return Object.freeze({ id, name, type, chartCode, legacyChartCode: LEGACY_CHART_CODES[id] || null, keywords: Object.freeze(keywords) });
}

export const CATEGORY_DEFINITIONS = Object.freeze([
  // ---------------------------------------------------------------- درآمدها
  rule('inc-sale', 'فروش', 'income', '6101', [
    [STRONG, ['فروش رفت', 'فروش داشتم', 'فاکتور فروش', 'فروش نقدی', 'فروش اعتباری']],
    [NORMAL, ['فروختم', 'فروختیم', 'فروش', 'مشتری خرید']],
  ]),
  rule('inc-service', 'خدمات', 'income', '6102', [
    [STRONG, ['درآمد خدمات', 'حق الزحمه', 'حق‌الزحمه', 'کارمزد دریافتی', 'اجرت']],
    [NORMAL, ['خدمات', 'سرویس', 'تعمیر برای مشتری']],
  ]),
  rule('inc-project', 'پروژه و دستمزد', 'income', '6102', [
    [STRONG, ['دستمزد گرفتم', 'پول پروژه', 'قرارداد بستم', 'فاز پروژه']],
    [NORMAL, ['پروژه', 'قرارداد']],
  ]),
  rule('inc-rent', 'درآمد اجاره', 'income', '6203', [
    [STRONG, ['اجاره گرفتم', 'اجاره دادم به', 'اجاره بها گرفتم', 'کرایه گرفتم']],
  ]),
  rule('inc-other', 'سایر درآمدها', 'income', '6201', [
    [STRONG, ['سود بانکی', 'سود سپرده', 'تخفیف گرفتم', 'خسارت گرفتم', 'برگشت از خرید']],
  ]),

  // ---------------------------------------------------------------- هزینه‌ها
  rule('exp-material', 'مواد و کالا', 'expense', '1301', [
    [STRONG, ['خرید کالا', 'خرید جنس', 'خرید مواد', 'مواد اولیه', 'فاکتور خرید', 'بار خریدم', 'جنس خریدم']],
    [NORMAL, ['مواد', 'کالا', 'موجودی', 'انبار', 'ملزومات تولید']],
  ]),
  rule('exp-cogs', 'بهای تمام‌شدهٔ فروش', 'expense', '7101', [
    [STRONG, ['بهای تمام شده', 'بهای تمام‌شده', 'قیمت تمام شده', 'کالای فروش رفته']],
  ]),
  rule('exp-salary', 'حقوق و دستمزد', 'expense', '8101', [
    [STRONG, ['حقوق دادم', 'حقوق پرسنل', 'حقوق کارگر', 'دستمزد دادم', 'عیدی', 'سنوات', 'پاداش پرسنل', 'اضافه کاری', 'اضافه‌کاری', 'مساعده']],
    [NORMAL, ['حقوق', 'دستمزد', 'کارگر', 'پرسنل', 'کارمند']],
  ]),
  rule('exp-insurance', 'بیمه', 'expense', '8119', [
    [STRONG, ['بیمه تامین اجتماعی', 'بیمه تأمین اجتماعی', 'حق بیمه', 'لیست بیمه', 'بیمه پرسنل', 'بیمه تکمیلی']],
    [NORMAL, ['بیمه']],
  ]),
  rule('exp-tax-penalty', 'جرایم مالیاتی', 'expense', '8120', [[STRONG, ['جریمه مالیاتی', 'جرایم مالیاتی', 'جرائم مالیاتی', 'جریمه دیرکرد ارزش افزوده']]]),
  rule('exp-tax', 'مالیات و عوارض', 'expense', '8114', [
    [STRONG, ['مالیات بر ارزش افزوده', 'مالیات عملکرد', 'ارزش افزوده', 'مالیات دادم', 'عوارض شهرداری', 'جریمه مالیاتی']],
    [NORMAL, ['مالیات', 'عوارض', 'دارایی']],
  ]),
  rule('exp-rent', 'اجاره', 'expense', '8102', [
    [STRONG, ['اجاره دادم', 'اجاره مغازه', 'اجاره دفتر', 'اجاره انبار', 'اجاره بها', 'اجاره‌بها', 'ودیعه', 'رهن']],
    [NORMAL, ['اجاره']],
  ]),
  rule('exp-delivery', 'حمل‌ونقل', 'expense', '8103', [
    [STRONG, ['حمل بار', 'کرایه حمل', 'باربری', 'پست کردم', 'هزینه ارسال', 'تیپاکس', 'ترخیص']],
    [NORMAL, ['اسنپ', 'تپسی', 'تاکسی', 'پیک', 'کرایه', 'حمل', 'باربر', 'راننده', 'بارنامه']],
  ]),
  rule('exp-fuel', 'سوخت و ایاب‌وذهاب', 'expense', '8118', [
    [STRONG, ['بنزین زدم', 'گازوئیل', 'سوخت ماشین', 'عوارض آزادراهی', 'ایاب و ذهاب', 'ایاب‌وذهاب']],
    [NORMAL, ['بنزین', 'سوخت', 'پارکینگ', 'جریمه رانندگی']],
  ]),
  rule('exp-bill', 'قبوض', 'expense', '8104', [
    [STRONG, ['قبض برق', 'قبض گاز', 'قبض آب', 'قبض تلفن', 'پول اینترنت', 'شارژ ساختمان']],
    [NORMAL, ['قبض', 'برق', 'گاز', 'اینترنت', 'تلفن', 'مخابرات', 'شارژ']],
  ]),
  rule('exp-office', 'ملزومات اداری', 'expense', '8108', [
    [STRONG, ['لوازم التحریر', 'لوازم‌التحریر', 'ملزومات اداری', 'کاغذ ای فور', 'کاغذ a4', 'تونر', 'کارتریج', 'زونکن']],
    [NORMAL, ['ملزومات', 'نوشت افزار', 'پرینتر', 'کاغذ']],
  ]),
  rule('exp-marketing', 'تبلیغات و بازاریابی', 'expense', '8110', [
    [STRONG, ['تبلیغات', 'تبلیغ', 'بازاریابی', 'کمپین', 'بنر', 'تراکت', 'کاتالوگ', 'اینفلوئنسر', 'گوگل ادز', 'ادوردز']],
    [NORMAL, ['بیلبورد', 'اسپانسر', 'نمایشگاه']],
  ]),
  rule('exp-software', 'نرم‌افزار و اشتراک', 'expense', '8112', [
    [STRONG, ['اشتراک نرم افزار', 'اشتراک نرم‌افزار', 'لایسنس', 'هاست', 'دامنه', 'سرور مجازی', 'پنل پیامک']],
    [NORMAL, ['نرم افزار', 'نرم‌افزار', 'اشتراک', 'سرور']],
  ]),
  rule('exp-bank', 'کارمزد بانکی', 'expense', '8107', [
    [STRONG, ['کارمزد بانک', 'کارمزد انتقال', 'کارمزد دستگاه', 'کارمزد پوز', 'هزینه صدور چک', 'کارمزد درگاه']],
    [NORMAL, ['کارمزد']],
  ]),
  rule('exp-repair', 'تعمیر و نگهداری', 'expense', '8111', [
    [STRONG, ['تعمیر دستگاه', 'تعمیر ماشین', 'سرویس دستگاه', 'قطعه یدکی', 'نگهداری تجهیزات']],
    [NORMAL, ['تعمیر', 'تعمیرات', 'سرویس کار', 'قطعه']],
  ]),
  rule('exp-contractor', 'پیمانکار و خدمات بیرونی', 'expense', '8113', [
    [STRONG, ['پیمانکار', 'حق الزحمه دادم', 'حق‌الزحمه دادم', 'مشاور حقوقی', 'وکیل', 'حسابدار', 'خدمات بیرونی', 'برون سپاری']],
    [NORMAL, ['مشاور', 'طراح', 'مترجم']],
  ]),
  rule('exp-food', 'خوراک', 'expense', '8115', [
    [STRONG, ['پذیرایی', 'ناهار پرسنل', 'اسنپ فود', 'میوه و شیرینی']],
    [NORMAL, ['غذا', 'خوراک', 'ناهار', 'شام', 'چای', 'رستوران']],
  ]),
  rule('exp-training', 'آموزش', 'expense', '8116', [
    [STRONG, ['دوره آموزشی', 'کلاس آموزش', 'شهریه', 'سمینار', 'وبینار']],
    [NORMAL, ['آموزش', 'کتاب']],
  ]),
  rule('exp-shrinkage', 'کسری و ضایعات موجودی', 'expense', '8105', [
    [STRONG, ['ضایعات', 'کسری انبار', 'کالای خراب', 'تاریخ گذشته', 'مرجوعی خراب']],
  ]),
  rule('exp-other', 'سایر هزینه‌ها', 'expense', '8109', []),
]);

const OTHER_INCOME = CATEGORY_DEFINITIONS.find((item) => item.id === 'inc-other');
const OTHER_EXPENSE = CATEGORY_DEFINITIONS.find((item) => item.id === 'exp-other');

export function fallbackCategory(type) {
  return type === 'income' ? OTHER_INCOME : OTHER_EXPENSE;
}

export function categoryByName(name) {
  const normalized = normalizePersian(name);
  return CATEGORY_DEFINITIONS.find((item) => normalizePersian(item.name) === normalized) || null;
}

/** کد حساب پیشنهادی برای یک نام دسته؛ برای دسته‌های دست‌ساز کاربر null است. */
export function chartCodeForCategory(name) {
  return categoryByName(name)?.chartCode || null;
}

/** کد معین همین دسته در کدینگ پیشنهادیِ پیش از تفکیک؛ برای دفترهای قدیمی. */
export function legacyChartCodeForCategory(name) {
  return categoryByName(name)?.legacyChartCode || null;
}

/**
 * همهٔ دسته‌های سازگار با نوع تراکنش را امتیاز می‌دهد و مرتب‌شده برمی‌گرداند.
 * دسته‌های بدون امتیاز حذف می‌شوند تا صفر با صفر مقایسه نشود.
 */
export function scoreCategories(text, type) {
  const normalized = normalizePersian(text);
  if (!normalized) return [];
  const scored = [];
  for (const definition of CATEGORY_DEFINITIONS) {
    if (type && definition.type !== type) continue;
    let score = 0;
    const matched = [];
    for (const { word, weight } of definition.keywords) {
      if (!normalized.includes(word)) continue;
      if (word === 'سنوات' && !/(?:^|[\s،,])سنوات(?:$|[\s،,.])/.test(normalized)) continue;
      score += weight;
      matched.push(word);
    }
    if (score > 0) scored.push({ definition, score, matched });
  }
  // امتیاز مساوی را طولانی‌ترین واژهٔ منطبق می‌شکند: عبارت بلندتر یعنی
  // تطابق مشخص‌تر، نه تصادفی‌تر.
  return scored.sort((left, right) => right.score - left.score
    || Math.max(...right.matched.map((word) => word.length)) - Math.max(...left.matched.map((word) => word.length)));
}

/**
 * دستهٔ نهایی به‌همراه اطمینان و دلیلِ قابل‌خواندن برای کاربر.
 *
 * اطمینان از فاصلهٔ گزینهٔ اول تا دوم می‌آید، نه از امتیاز مطلق. «اجارهٔ انبار»
 * که هر دو دسته را با امتیاز نزدیک می‌زند باید کنترل شود؛ «قبض برق» که رقیبی
 * ندارد نباید کاربر را معطل کند.
 */
export function classifyCategory(text, type) {
  const fine=taxPenaltyFacts(text);
  if(type==='expense' && fine.penalty && !fine.mixed) return {category:'جرایم مالیاتی',chartCode:'8120',confidence:.94,reason:'جریمه مالیاتی از اصل مالیات و عوارض جدا شناسایی شد.',ambiguous:false,runnerUp:null,matched:true};
  const ranked = scoreCategories(text, type);
  const fallback = fallbackCategory(type);
  if (!ranked.length) {
    return {
      category: fallback.name,
      chartCode: fallback.chartCode,
      confidence: 0.5,
      reason: 'واژهٔ شناخته‌شده‌ای برای دسته‌بندی در متن نبود؛ دستهٔ عمومی پیشنهاد شد.',
      ambiguous: false,
      runnerUp: null,
      // تفاوتِ «دستهٔ عمومی چون چیزی پیدا نشد» با «دسته‌ای که واقعاً از متن
      // آمده»؛ صداکنندهٔ این تابع باید بتواند این دو را از هم جدا کند.
      matched: false,
    };
  }
  const [best, second] = ranked;
  const gap = best.score - (second?.score || 0);
  // فاصلهٔ صفر یعنی دو دسته به یک اندازه موجه‌اند — این را نباید مطمئن جا زد.
  const confidence = gap >= STRONG ? 0.94 : gap >= NORMAL ? 0.86 : gap >= WEAK ? 0.74 : 0.6;
  const longest = best.matched.reduce((chosen, word) => (word.length > chosen.length ? word : chosen), '');
  return {
    category: best.definition.name,
    chartCode: best.definition.chartCode,
    confidence,
    reason: gap === 0 && second
      ? `متن هم‌زمان نشانهٔ «${best.definition.name}» و «${second.definition.name}» داشت؛ باید کنترل شود.`
      : `واژهٔ «${longest}» در متن پیدا شد.`,
    ambiguous: gap === 0 && Boolean(second),
    runnerUp: second?.definition.name || null,
    matched: true,
  };
}
