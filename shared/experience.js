/**
 * تجربهٔ کاربر — جدا از سطح دسترسی.
 *
 * سیستم نقش امروز یک نردبان است: viewer < accountant < manager < owner. این
 * برای «چه کسی اجازهٔ چه کاری دارد» درست کار می‌کند، ولی برای «چه کسی چه چیزی
 * باید ببیند» وارونه است: صاحب کسب‌وکار بالاترین رتبه را دارد و در نتیجه
 * کدینگ حساب‌ها، کارتابل سند و لاگ‌های فنی را هم می‌بیند — دقیقاً چیزهایی که
 * برایشان هیچ استفاده‌ای ندارد و فقط او را می‌ترساند.
 *
 * پس یک محور دوم لازم است که با رتبه قاطی نشود: **تجربه**.
 *
 * - `simple` — کسی که حسابداری بلد نیست. یک دکمهٔ صحبت، خلاصهٔ امروز، و فقط
 *   وقتی چیزی مبهم بود یک سؤال ساده. هیچ اصطلاح دفترداری.
 * - `professional` — حسابدار. صف بررسی، اصلاح سند، کدینگ، تطبیق بانکی و
 *   تنظیم قواعد.
 *
 * این ماژول هیچ وابستگی‌ای ندارد تا هم سرور و هم مرورگر از یک منبع تصمیم
 * بگیرند؛ مخفی‌کردن منو در فرانت‌اند بدون همان قاعده در بک‌اند، امنیت نیست.
 */

export const EXPERIENCES = Object.freeze({
  SIMPLE: 'simple',
  PROFESSIONAL: 'professional',
});

/**
 * تجربهٔ پیش‌فرض هر نقش.
 *
 * حسابدار و مدیر دفتر کارشان با سند است، پس محیط حرفه‌ای می‌گیرند. صاحب
 * کسب‌وکار و ناظر، تجربهٔ ساده.
 *
 * صاحب کسب‌وکار می‌تواند خودش به حرفه‌ای سوییچ کند — بعضی صاحبان کسب‌وکار
 * دفترشان را خودشان می‌بندند. ولی حسابدار نمی‌تواند به ساده برود، چون ابزارهای
 * کارش آنجا نیست.
 */
const DEFAULT_BY_ROLE = Object.freeze({
  owner: EXPERIENCES.SIMPLE,
  manager: EXPERIENCES.PROFESSIONAL,
  accountant: EXPERIENCES.PROFESSIONAL,
  viewer: EXPERIENCES.SIMPLE,
});

/** نقش‌هایی که همیشه محیط حرفه‌ای می‌گیرند و انتخاب ساده برایشان معنا ندارد. */
const ALWAYS_PROFESSIONAL = new Set(['manager', 'accountant']);

export function experienceForRole(role, preference = null) {
  const fallback = DEFAULT_BY_ROLE[role] ?? EXPERIENCES.SIMPLE;
  if (ALWAYS_PROFESSIONAL.has(role)) return EXPERIENCES.PROFESSIONAL;
  return preference === EXPERIENCES.PROFESSIONAL || preference === EXPERIENCES.SIMPLE ? preference : fallback;
}

export function canChooseExperience(role) {
  return !ALWAYS_PROFESSIONAL.has(role) && role === 'owner';
}

/**
 * صفحه‌ها.
 *
 * `experiences` می‌گوید این صفحه در کدام تجربه دیده می‌شود و `minimumRole`
 * سطح دسترسی لازم را. هر دو باید برقرار باشند: تجربهٔ ساده به کدینگ راه ندارد
 * حتی اگر کاربر مالک باشد، و ناظر به تنظیمات راه ندارد حتی در محیط حرفه‌ای.
 */
export const SCREENS = Object.freeze([
  // --- تجربهٔ ساده: فقط چیزی که یک کسب‌وکار روزمره لازم دارد.
  Object.freeze({
    id: 'today', label: 'امروز', icon: 'home', primary: true,
    experiences: [EXPERIENCES.SIMPLE, EXPERIENCES.PROFESSIONAL], minimumRole: 'viewer',
  }),
  Object.freeze({
    id: 'ledger', label: 'دفتر مالی', icon: 'wallet', primary: true,
    experiences: [EXPERIENCES.SIMPLE, EXPERIENCES.PROFESSIONAL], minimumRole: 'viewer',
  }),
  Object.freeze({
    id: 'report', label: 'گزارش', icon: 'chart', primary: true,
    experiences: [EXPERIENCES.SIMPLE, EXPERIENCES.PROFESSIONAL], minimumRole: 'viewer',
  }),
  // تنخواه‌گردان در هر کسب‌وکاری هست، ساده یا حرفه‌ای؛ فقط پروندهٔ شخصی ندارد.
  Object.freeze({
    id: 'petty-cash', label: 'تنخواه‌گردان', icon: 'petty',
    experiences: [EXPERIENCES.SIMPLE, EXPERIENCES.PROFESSIONAL], minimumRole: 'viewer',
  }),
  Object.freeze({
    id: 'settings', label: 'تنظیمات', icon: 'settings',
    experiences: [EXPERIENCES.SIMPLE, EXPERIENCES.PROFESSIONAL], minimumRole: 'viewer',
  }),

  // --- فقط محیط حرفه‌ای.
  Object.freeze({
    id: 'firm', label: 'میز کار دفتر', icon: 'grid', primary: true,
    experiences: [EXPERIENCES.PROFESSIONAL], minimumRole: 'viewer',
  }),
  Object.freeze({
    id: 'review', label: 'صف بررسی', icon: 'inbox', primary: true,
    experiences: [EXPERIENCES.PROFESSIONAL], minimumRole: 'accountant',
  }),
  Object.freeze({
    id: 'accounting', label: 'حسابداری', icon: 'book',
    experiences: [EXPERIENCES.PROFESSIONAL], minimumRole: 'accountant',
  }),
  Object.freeze({
    id: 'chart', label: 'کدینگ حساب‌ها', icon: 'landmark',
    experiences: [EXPERIENCES.PROFESSIONAL], minimumRole: 'manager',
  }),
  // مالیات فعلاً پنهان است، نه حذف.
  //
  // صفحه، مسیرهای سرور و آزمون‌هایش همه سر جایشان‌اند؛ فقط از ناوبری بیرون
  // است. برگرداندنش یعنی برداشتن همین یک پرچم — نه بازنویسی دوبارهٔ چیزی که
  // ساخته و آزموده شده.
  Object.freeze({
    id: 'tax', label: 'مالیات', icon: 'coins',
    experiences: [EXPERIENCES.PROFESSIONAL], minimumRole: 'accountant', hidden: true,
  }),
  Object.freeze({
    id: 'collaboration', label: 'همکاری حسابدار', icon: 'users',
    experiences: [EXPERIENCES.PROFESSIONAL], minimumRole: 'accountant',
  }),
  Object.freeze({
    id: 'learning', label: 'یادگیری‌ها', icon: 'book',
    experiences: [EXPERIENCES.PROFESSIONAL], minimumRole: 'accountant',
  }),
]);

const RANK = Object.freeze({ viewer: 0, accountant: 1, manager: 2, owner: 3 });

function rankAllows(role, minimum) {
  return (RANK[role] ?? -1) >= (RANK[minimum] ?? Number.POSITIVE_INFINITY);
}

/**
 * صفحه‌هایی که این نقش و تجربه می‌بیند.
 *
 * `profileType` صفحه‌های مخصوص کسب‌وکار را کنار می‌گذارد؛ پروندهٔ شخصی کدینگ و
 * مالیات ندارد.
 */
export function screensFor({ role = 'viewer', experience = EXPERIENCES.SIMPLE, profileType = 'business' } = {}) {
  const businessOnly = new Set(['accounting', 'chart', 'tax', 'collaboration', 'petty-cash']);
  return SCREENS.filter((screen) => {
    // صفحهٔ پنهان از ناوبری و از دروازهٔ سرور بیرون است، ولی تعریفش می‌ماند.
    if (screen.hidden) return false;
    if (!screen.experiences.includes(experience)) return false;
    if (!rankAllows(role, screen.minimumRole)) return false;
    if (profileType !== 'business' && businessOnly.has(screen.id)) return false;
    return true;
  });
}

export function canSeeScreen(screenId, context) {
  return screensFor(context).some((screen) => screen.id === screenId);
}

/**
 * مسیرهای API که فقط در محیط حرفه‌ای معنا دارند.
 *
 * مخفی‌کردن منو امنیت نیست: کسی که آدرس را بداند همچنان صدا می‌زند. این فهرست
 * همان مرز را در سرور هم می‌گذارد.
 *
 * عمداً فقط مسیرهای «ابزار حسابدار» اینجا هستند، نه دادهٔ پایه‌ای که تجربهٔ
 * ساده هم به آن نیاز دارد (مثل `/bootstrap` یا `/transactions`).
 */
const PROFESSIONAL_PATHS = [
  /^\/accounting(\/|$)/,
  /^\/chart(\/|$)/,
  /^\/financial-events(\/|$)/,
  // این اعداد تعیین می‌کنند چه چیزی بدون نگاه انسان وارد دفتر می‌شود؛ تنظیمشان
  // کار حسابدار است، نه کسی که فقط ثبت روزانه می‌زند.
  /^\/automation-policy(\/|$)/,
  /^\/reconciliation(\/|$)/,
  /^\/accountant-transfer(\/|$)/,
  /^\/collaboration(\/|$)/,
  /^\/tax(\/|$)/,
  /^\/learnings(\/|$)/,
  /^\/fixed-assets(\/|$)/,
  /^\/import\//,
];

export function pathNeedsProfessional(path) {
  const normalized = String(path || '');
  return PROFESSIONAL_PATHS.some((pattern) => pattern.test(normalized));
}
