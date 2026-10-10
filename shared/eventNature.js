import { normalizePersian } from './normalize.js';
/**
 * نوع رویداد در دوره — هفت چیز که شبیه هم‌اند و سند متفاوتی دارند.
 *
 * مهم‌ترین تمایز، میان **اصلاح اشتباه** و **تغییر برآورد** است:
 *
 * - اصلاح اشتباه: آن روز غلط ثبت شده. گذشته باید درست شود.
 * - تغییر برآورد: آن روز درست بود، امروز اطلاعات تازه‌ای داریم. گذشته
 *   دست‌نخورده می‌ماند و اثر از این به بعد است.
 *
 * اشتباه‌گرفتنشان یعنی دورهٔ گذشته — که ممکن است بسته و اظهار شده باشد —
 * بی‌دلیل دست‌کاری می‌شود. عمر مفید که از پنج سال به هفت سال تغییر می‌کند،
 * استهلاک سال‌های گذشته را باطل نمی‌کند؛ فقط استهلاک از این به بعد عوض
 * می‌شود.
 *
 * تشخیص روی متن خام است و نرمال‌سازی صدا زده نمی‌شود: تایپ زنده بودجهٔ
 * میلی‌ثانیه‌ای دارد و این درس سه بار گرفته شده.
 */

export const EVENT_NATURES = Object.freeze({
  /** رویداد تازه — حالت عادی. */
  NEW: 'new',
  /** ثبت قبلی غلط بوده و باید درست شود. */
  CORRECTION: 'correction',
  /** ثبت قبلی درست بوده؛ برآورد به‌روز شده. گذشته دست نمی‌خورد. */
  ESTIMATE_CHANGE: 'estimate-change',
  /** سند باطل می‌شود با سند معکوس. */
  REVERSAL: 'reversal',
  /** ثبت تعدیلی پایان دوره. */
  PERIOD_END_ADJUSTMENT: 'period-end-adjustment',
  /** ثبت افتتاحیه — خارج از سود و زیان. */
  OPENING: 'opening',
  /** رویداد پس از تاریخ گزارشگری — افشا، نه ثبت. */
  POST_REPORTING: 'post-reporting',
});

const GAP = '[\\s\\u200c]*';
const YA = '[یي]';

// ترتیب مهم است: «برآورد» پیش از «اشتباه» بررسی می‌شود، چون جمله‌ای مثل
// «برآورد قبلی اشتباه بود» هر دو واژه را دارد و تغییر برآورد است، نه اصلاح
// سند — و اصلاح‌شمردنش گذشته را بی‌دلیل دست می‌زند.
const PATTERNS = Object.freeze([
  [EVENT_NATURES.ESTIMATE_CHANGE, new RegExp([
    `عمر${GAP}مف${YA}د`,
    `برآورد`,
    `تخم${YA}ن`,
    `ذخ${YA}ره${GAP}(?:مطالبات|تعهدات)`,
  ].join('|'))],
  [EVENT_NATURES.OPENING, new RegExp(`افتتاح${YA}ه`)],
  [EVENT_NATURES.PERIOD_END_ADJUSTMENT, new RegExp(`تعد${YA}ل${YA}${GAP}(?:پا${YA}ان|آخر)|بستن${GAP}(?:حساب|دوره|سال)`)],
  [EVENT_NATURES.REVERSAL, new RegExp(`برگشت${GAP}(?:بزن|بخوره|بده)|ابطال|باطل${GAP}کن`)],
  // شکل‌های گفتاری اصلاح که آزمون استرس نشان داد جا مانده بودند: «اشتباهاً …
  // ثبت شده بود»، «اصلاحش کن»، «جابجا کن»، «جا افتاده بوده»، «کمتر محاسبه
  // شده»، «تعدیل سنواتی»، «برگردون به حالت اول». هرکدام که جا می‌ماند، یک
  // رویداد تازه — گاهی پیش‌نویس فاکتور تازه — می‌ساخت.
  [EVENT_NATURES.CORRECTION, new RegExp([
    `اشتباه${GAP}(?:شد|بود|ثبت|زدم|کردم)`,
    `اشتباه(?:اً|ا|ی)?${GAP}[^.؟!]{0,40}(?:ثبت|منظور|برده|وارد|زده)${GAP}(?:شده|شد|کرد)`,
    `غلط${GAP}(?:بود|ثبت|شد)`,
    `درستش${GAP}`,
    `اصلاح(?:ش|شون)?${GAP}(?:کن|بشه|شود|شه)`,
    `جا${GAP}افتاده`,
    `جا(?:به)?${GAP}جا${GAP}کن`,
    `(?:کمتر|ب${YA}شتر)${GAP}(?:محاسبه|حساب|ثبت)${GAP}شده`,
    `تعد${YA}ل(?:ات)?${GAP}سنوات${YA}`,
    `برگردون${GAP}به${GAP}حالت`,
  ].join('|'))],
  [EVENT_NATURES.POST_REPORTING, new RegExp(`بعد${GAP}از${GAP}تار${YA}خ${GAP}(?:ترازنامه|گزارشگر${YA})`)],
]);

const CHEAP_HINT = /اشتباه|غلط|درستش|اصلاح|برآورد|تخمین|عمر|ابطال|باطل|برگشت|افتتاح|تعدیل|بستن|گزارشگر|افتاده|جابجا|جا\s*به\s*جا|محاسبه|سنواتی|برگردون/;

export function readEventNature(input) {
  const text = normalizePersian(String(input || ''));
  if (!CHEAP_HINT.test(text)) return EVENT_NATURES.NEW;
  for (const [nature, pattern] of PATTERNS) {
    if (pattern.test(text)) return nature;
  }
  return EVENT_NATURES.NEW;
}

/**
 * آیا این نوع رویداد، دورهٔ گذشته را دست می‌زند؟
 *
 * فقط اصلاح اشتباه و برگشت سند. تغییر برآورد عمداً بیرون است و همین قاعدهٔ
 * اصلی این بخش است.
 */
const PAST_TOUCHING = new Set([EVENT_NATURES.CORRECTION, EVENT_NATURES.REVERSAL]);

export function natureAffectsPast(nature) {
  return PAST_TOUCHING.has(nature);
}

/** انواعی که هیچ‌وقت خودکار ثبت نمی‌شوند، فارغ از اطمینان. */
const ALWAYS_REVIEWED = new Set([
  EVENT_NATURES.CORRECTION,
  EVENT_NATURES.REVERSAL,
  EVENT_NATURES.ESTIMATE_CHANGE,
  EVENT_NATURES.PERIOD_END_ADJUSTMENT,
  EVENT_NATURES.OPENING,
  EVENT_NATURES.POST_REPORTING,
]);

export function natureNeedsAccountant(nature) {
  return ALWAYS_REVIEWED.has(nature);
}

/** چرا این مورد متوقف شده — به زبان حسابدار. */
export const NATURE_EXPLANATIONS = Object.freeze({
  [EVENT_NATURES.CORRECTION]: 'این یک اصلاح ثبت قبلی است؛ سند اصلاحی باید به سند اول ارجاع بدهد.',
  [EVENT_NATURES.ESTIMATE_CHANGE]: 'این تغییر برآورد است، نه اصلاح اشتباه؛ گذشته دست نمی‌خورد و اثرش از این به بعد است.',
  [EVENT_NATURES.REVERSAL]: 'برگشت سند با سند معکوس انجام می‌شود، نه با حذف.',
  [EVENT_NATURES.PERIOD_END_ADJUSTMENT]: 'ثبت تعدیلی پایان دوره در دورهٔ قبل می‌نشیند و قضاوت حسابدار لازم دارد.',
  [EVENT_NATURES.OPENING]: 'ثبت افتتاحیه خارج از سود و زیان است.',
  [EVENT_NATURES.POST_REPORTING]: 'رویداد پس از تاریخ گزارشگری افشا می‌شود، نه ثبت.',
});

/**
 * چکی که پول نیست — ابزاری که هنوز وصول نشده، یا ضمانت.
 *
 * «یه چک صد میلیونی دادم دست آهنگر، نه تاریخ داره نه در وجه کسی» و «چک
 * دست‌لاف دادم به شریکم، نمیدونم نقدش میکنه یا نه» هیچ پولی جابه‌جا نکرده‌اند؛
 * ولی اگر از مسیر تراکنش بروند، ردیف نقدی می‌سازند و ماندهٔ صندوق را کم
 * می‌کنند. چکِ پاس‌شده یا وصول‌شده پول است و اینجا نمی‌آید.
 */
const CHEQUE_WORD = /(?<![آ-ی])چک(?![آ-ی])|(?<![آ-ی])سفته/;
const CHEQUE_CLEARED = /پاس\s*(?:شد|کرد)|وصول\s*(?:شد|کرد)|نقد\s*(?:شد|کرد)|خوابوند|دسته\s*چک/;

export function readNonCashInstrument(input) {
  const text = normalizePersian(String(input || '')).replace(/\u200c/g, ' ');
  return CHEQUE_WORD.test(text) && !CHEQUE_CLEARED.test(text);
}

/** تصریح «هنوز پولی جابه‌جا نشده» نباید حتی ردیف نقدیِ در انتظار بسازد. */
export function readExplicitNonCash(input) {
  const text = normalizePersian(String(input || '')).replace(/\u200c/g, ' ');
  if (/سود|بهره/.test(text) && /تسهیلات|وام/.test(text) && /سررسید\s+نشده/.test(text) && /تحقق|تعلق/.test(text)) return true;
  return /(?:بدون\s+(?:پرداخت|دریافت)\s+(?:وجه|پول)|پولی\s+(?:ندادیم|نگرفتیم|پرداخت\s+نشد|دریافت\s+نشد)|هنوز\s+(?:پرداخت|دریافت)\s+(?:نکردیم|نکردم|نشده)|نسیه)/.test(text);
}


export function readMixedSettlement(input) {
  const text = normalizePersian(String(input || '')).replace(/\u200c/g, ' ');
  return /نسیه|بقیه.*(?:بدهی|بعد|مانده)/.test(text)
    && /نصف|بخشی|قسمتی|درصد|بقیه/.test(text)
    && /کارت\s*کش|پرداخت\s*(?:شد|کرد)|نقدی|واریز\s*(?:شد|کرد)/.test(text);
}
export const MIXED_SETTLEMENT_REASON = 'بخشی از وجه پرداخت شده و بخشی نسیه است؛ مبلغ هر بخش، مالیات و حساب تسویه باید مشخص شود. ثبت نقدی یک‌جای کل مبلغ ساخته نشد.';
