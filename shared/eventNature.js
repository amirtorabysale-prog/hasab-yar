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
  [EVENT_NATURES.CORRECTION, new RegExp([
    `اشتباه${GAP}(?:شد|بود|ثبت|زدم|کردم)`,
    `غلط${GAP}(?:بود|ثبت|شد)`,
    `درستش${GAP}`,
    `اصلاح${GAP}کن`,
  ].join('|'))],
  [EVENT_NATURES.POST_REPORTING, new RegExp(`بعد${GAP}از${GAP}تار${YA}خ${GAP}(?:ترازنامه|گزارشگر${YA})`)],
]);

const CHEAP_HINT = /اشتباه|غلط|درستش|اصلاح|برآورد|تخمین|عمر|ابطال|باطل|برگشت|افتتاح|تعدیل|بستن|گزارشگر/;

export function readEventNature(input) {
  const text = String(input || '');
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
