import { normalizePersian } from './normalize.js';
import { classifyCategory } from './categoryRules.js';
import { readServicePeriod } from './periodSpeech.js';
import { saysRefundable } from './moneyPurpose.js';
import { TIME_BOUND_SERVICE_CATEGORIES } from './economicFamily.js';
import { readPrepaymentMention } from './prepaymentSpeech.js';
import { GOODS_CATEGORIES, namesTimeBoundService, withoutNonCoveragePeriods } from './serviceCoverageSpeech.js';

/**
 * خدمت دوره‌دار روی سندِ پایه — چک، طلب و بدهی، فاکتور، قاعدهٔ تکرار.
 *
 * چرا یک خواننده برای همه: مسیر نقدی دسته و دورهٔ پوشش را از جمله می‌خواند و
 * پیش‌پرداخت می‌سازد، ولی چک و فاکتور و طلب/بدهی هر کدام دستهٔ ثابت خودشان را
 * داشتند («مواد و کالا»، «فروش»، «سایر هزینه‌ها») و دوره را اصلاً نمی‌خواندند.
 * نتیجه: همان «اجارهٔ یک‌ساله» با نقد پیش‌پرداخت می‌شد و با چک یک‌جا «مواد و
 * کالا». این فایل همان واقعیت‌ها را برای هر سند پایه یکسان می‌خواند تا موتور
 * تصمیم یک جواب بدهد.
 *
 * فقط می‌خواند، تصمیم نمی‌گیرد: نبودِ دوره `null` است تا موتور بپرسد، و نبودِ
 * دسته `null` است تا هیچ هزینه یا درآمد حدسی ساخته نشود.
 */

const has = (pattern, text) => pattern.test(text);

// نام خدمتی که دستهٔ دوره‌دار را می‌گوید، حتی وقتی واژهٔ «خرید» یا «انبار» کنارش
// است: «فاکتور خرید اجاره شش ماهه» اجاره است، نه مواد و کالا.
const RENT = /(?<![آ-ی])(?:اجاره|اجارهٔ|اجاره‌ی|کرایه\s*(?:دفتر|مغازه|انبار|سوله|ملک|خانه|خونه|واحد|کارگاه)|رهن|ودیعه|مستاجر|مستأجر|موجر|صاحبخونه|صاحبخانه)(?![آ-ی])/;
const INSURANCE = /(?<![آ-ی])(?:بیمه|بیمع|حق\s*بیمه)(?![آ-ی])/;
const NOT_A_PREMIUM = /ت[اأ]مین\s*اجتماع|لیست\s*بیمه|بیمه\s*(?:پرسنل|کارگر|کارکنان|بیکاری)|سهم\s*(?:کارفرما|کارگر)|خسارت|غرامت/;
const SOFTWARE = /(?<![آ-ی])(?:اشتراک|لایسنس|لاینسس|نرم\s*افزار|هاست|هاستینگ|سرور|دامنه|آنتی\s*ویروس|آبونمان|سرویس\s*ابری)(?![آ-ی])/;
// «قرارداد» به‌تنهایی خدمت نیست: «قرارداد فروش یکساله چای» فروش کالاست.
const SERVICE_INCOME = /(?<![آ-ی])(?:اشتراک|لایسنس|پشتیبانی|نگهداری|سرویس|خدمات|مشاوره|آموزش|هاست|هاستینگ)(?![آ-ی])/;

/**
 * دستهٔ سند از روی متنش.
 *
 * `payable` — هزینه یا خریدی که بابتش بدهکار شدیم یا چک دادیم.
 * `receivable` — درآمدی که بابتش طلبکار شدیم یا چک گرفتیم. اجاره‌ای که می‌گیریم
 * «درآمد اجاره» است، نه «اجاره» که نام هزینه است.
 */
export function documentCategory(input, direction) {
  const text = normalizePersian(input);
  if (!text) return null;
  // نام خدمت از متنی خوانده می‌شود که گارانتی و شرط پرداخت از آن کنار رفته:
  // «یخچال با گارانتی و پشتیبانی ۱۸ ماهه» فروش یخچال است، نه خدمات پشتیبانی.
  const named = withoutNonCoveragePeriods(text);
  if (direction === 'receivable') {
    if (has(RENT, named)) return 'درآمد اجاره';
    if (has(SERVICE_INCOME, named)) return 'خدمات';
    const read = classifyCategory(text, 'income');
    return read.matched === false || read.confidence <= 0.5 ? null : read.category;
  }
  if (has(INSURANCE, named) && !has(NOT_A_PREMIUM, text)) return 'بیمه';
  if (has(RENT, named)) return 'اجاره';
  if (has(SOFTWARE, named)) return 'نرم‌افزار و اشتراک';
  const read = classifyCategory(text, 'expense');
  return read.matched === false || read.confidence <= 0.5 ? null : read.category;
}

/**
 * دستهٔ صریحی که فرم یا API فرستاده، به زبان همان طرفِ سند.
 *
 * «اجاره» روی چک دریافتی یعنی اجاره‌ای که گرفته‌ایم؛ نام حساب درآمدش «درآمد
 * اجاره» است. بدون این، درآمد در حسابی با نام هزینه می‌نشست.
 */
export function sideCategory(category, direction) {
  const name = String(category || '').trim();
  if (!name) return null;
  if (direction === 'receivable' && name === 'اجاره') return 'درآمد اجاره';
  return name;
}

/**
 * واقعیت‌های خدمت دوره‌دار یک سند پایه.
 *
 * دورهٔ صریحِ سند (فیلد فرم یا API) بر خواندن متن مقدم است. خواندن متن نسبت به
 * تاریخ خودِ سند است، نه امروز: «اجاره شش ماه آینده» در چکِ مهر از مهر شروع
 * می‌شود.
 */
export function readDocumentService(input, { direction, occurredAt, category = null, servicePeriodStart = null, servicePeriodEnd = null, refundable = null } = {}) {
  const text = normalizePersian(input);
  const resolvedCategory = sideCategory(category, direction) || documentCategory(text, direction);
  const period = servicePeriodStart && servicePeriodEnd
    ? { start: servicePeriodStart, end: servicePeriodEnd }
    : (text && occurredAt && coversService(text, resolvedCategory) ? readServicePeriod(withoutNonCoveragePeriods(text), { occurredAt }) : null);
  return {
    category: resolvedCategory,
    servicePeriodStart: period?.start || null,
    servicePeriodEnd: period?.end || null,
    refundable: typeof refundable === 'boolean' ? refundable : (text ? saysRefundable(text) : null),
  };
}

/** دسته‌ای که خدمت دوره‌دار است — هزینه یا درآمدش. */
export function isTimeBoundCategory(category) {
  const name = String(category || '').trim();
  return TIME_BOUND_SERVICE_CATEGORIES.includes(name) || name === 'درآمد اجاره';
}

/**
 * آیا مدتی که متن گفته می‌تواند دورهٔ پوشش باشد؟
 *
 * فقط برای خدمت دوره‌دار: دستهٔ دوره‌دار (اجاره، بیمه، اشتراک، درآمد اجاره)، یا
 * دسته‌ای غیرکالایی که متنش نام خدمتی را می‌برد. «لپ تاپ با گارانتی یکساله»،
 * «برنج — تسویه سه ماه آینده»، «چای — تسویه شش ماه بعد» و «قرارداد فروش یکساله
 * چای» کالا یا شرط پرداخت‌اند و دوره‌ای نمی‌سازند؛ مدتِ تنها کافی نیست.
 */
export function coversService(input, category = null) {
  const name = String(category || '').trim();
  if (isTimeBoundCategory(name)) return true;
  if (GOODS_CATEGORIES.includes(name)) return false;
  return namesTimeBoundService(input);
}

/**
 * دورهٔ پوششی که شرح بانک یا متن رسید گفته — برای ردیفی که از پارسر صدا رد نشده.
 *
 * «حق بیمه آتش سوزی یکساله انبار» در صورت‌حساب یا «مدت پوشش یکساله» در رسید
 * همان دوازده ماهی است که جملهٔ صوتی می‌گفت؛ ولی فقط پارسر صدا دوره را می‌خواند
 * و این ردیف‌ها هر بار «دورهٔ پوشش از کِی؟» می‌پرسیدند. اینجا همان خواننده نسبت
 * به تاریخ خودِ ردیف اجرا می‌شود.
 *
 * فقط پرداخت، و دریافتِ اجاره (آینهٔ پیش‌دریافت)؛ دورهٔ گفته‌نشده `null` می‌ماند
 * تا موتور بپرسد. «پیش پرداخت» بی‌دوره نشانهٔ پیش‌پرداخت است، نه دوره.
 */
export function bookedServiceFacts(input, { type, category = null, occurredAt = null } = {}) {
  const text = normalizePersian(input);
  if (!text || !occurredAt) return {};
  const expense = type === 'expense';
  const rentIncome = type === 'income' && ['اجاره', 'درآمد اجاره'].includes(String(category || '').trim());
  if (!expense && !rentIncome) return {};
  // «خرید کالا تسویه سه ماهه» یا «لپ تاپ گارانتی یکساله» دوره ندارند؛ فقط خدمت دوره‌دار.
  const period = coversService(text, category) ? readServicePeriod(withoutNonCoveragePeriods(text), { occurredAt }) : null;
  return {
    ...(period?.start && period?.end ? { servicePeriodStart: period.start, servicePeriodEnd: period.end } : {}),
    ...(expense && readPrepaymentMention(text) === true ? { prepaymentSignal: true } : {}),
  };
}
