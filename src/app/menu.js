/**
 * درخت منو — هر قابلیت یک مقصد مستقیم.
 *
 * تا امروز منو فقط صفحه‌ها را می‌شناخت و هر قابلیت پشت یک زبانه پنهان بود:
 * چک داخل «طلب و بدهی» دفتر مالی، تراز آزمایشی داخل «حسابداری»، پشتیبان در
 * انتهای یک ستون بلند تنظیمات. کاربر باید می‌دانست هر چیز کجاست. این درخت مثل
 * منوی نرم‌افزارهای حسابداری هر برگه را جدا نام می‌برد و همان زبانه را باز می‌کند.
 *
 * داده است، نه منطق دسترسی: هر برگ فقط وقتی دیده می‌شود که صفحه‌اش در فهرست
 * صفحه‌های مجاز سرور باشد (`access.screens`). مرز واقعی همچنان در سرور است.
 */

/**
 * `screen` شناسهٔ صفحه در `shared/experience.js` است و `section` زبانه یا بخش
 * داخل همان صفحه. `ledgerTab` می‌گوید این برگ به کدام زبانهٔ دفتر مالی نیاز دارد
 * تا در پروندهٔ شخصی، زبانه‌ای که وجود ندارد در منو نیاید.
 */
export const MENU = Object.freeze([
  {
    id: 'desk', label: 'میز کار', icon: 'home', items: [
      { label: 'امروز و ثبت گفتاری', screen: 'today', keywords: 'ثبت سریع صدا خلاصه روز داشبورد' },
      { label: 'میز کار دفترها', screen: 'firm', keywords: 'کارتابل وضعیت دفتر مشتری' },
    ],
  },
  {
    id: 'cash', label: 'دریافت و پرداخت', icon: 'wallet', items: [
      { label: 'تراکنش‌ها', screen: 'ledger', section: 'transactions', ledgerTab: 'transactions', keywords: 'دریافت پرداخت ثبت ها جستجو اصلاح حذف' },
      { label: 'طلب، بدهی و چک', screen: 'ledger', section: 'obligations', ledgerTab: 'obligations', keywords: 'چک اسناد دریافتنی پرداختنی سررسید قسط اشخاص' },
      { label: 'پیش‌پرداخت و پیش‌دریافت', screen: 'ledger', section: 'timing', ledgerTab: 'timing', keywords: 'پیش پرداخت پیش دریافت درآمد انتقالی بیمه اجاره اشتراک قسط ماهانه شناسایی' },
      { label: 'تنخواه‌گردان', screen: 'petty-cash', keywords: 'تنخواه شارژ دارنده' },
      { label: 'ثبت‌های دوره‌ای', screen: 'ledger', section: 'recurring', ledgerTab: 'recurring', keywords: 'تکرار ماهانه اجاره قسط' },
      { label: 'رسید، بستن صندوق و پرسش از دفتر', screen: 'ledger', section: 'tools', ledgerTab: 'tools', keywords: 'رسید عکس بستن صندوق شمارش ابزار سوال' },
    ],
  },
  {
    id: 'trade', label: 'خرید و فروش', icon: 'receipt', items: [
      { label: 'فاکتورهای خرید و فروش', screen: 'ledger', section: 'invoices', ledgerTab: 'invoices', keywords: 'فاکتور صورتحساب فروش خرید ارزش افزوده' },
      { label: 'انبار و موجودی کالا', screen: 'ledger', section: 'inventory', ledgerTab: 'inventory', keywords: 'کالا انبار موجودی بهای تمام شده' },
    ],
  },
  {
    id: 'accounts', label: 'بانک، صندوق و اشخاص', icon: 'landmark', items: [
      { label: 'کارت بانک‌ها', screen: 'ledger', section: 'cards-banks', ledgerTab: 'counterparties', keywords: 'صورتحساب بانک گردش مانده' },
      { label: 'کارت صندوق و تنخواه', screen: 'ledger', section: 'cards-cash', ledgerTab: 'counterparties', keywords: 'صندوق گردش مانده' },
      { label: 'کارت اشخاص و شرکت‌ها', screen: 'ledger', section: 'cards-people', ledgerTab: 'counterparties', keywords: 'طرف حساب مشتری تامین کننده شخص شرکت معین' },
      { label: 'تطبیق بانک', screen: 'ledger', section: 'reconciliation', ledgerTab: 'reconciliation', keywords: 'صورتحساب بانک مغایرت تطبیق' },
      { label: 'تعریف صندوق و بانک', screen: 'settings', section: 'accounts', keywords: 'حساب بانکی کیف پول افتتاح موجودی اولیه' },
    ],
  },
  {
    id: 'accounting', label: 'حسابداری و اسناد', icon: 'book', items: [
      { label: 'صف بررسی حسابدار', screen: 'review', keywords: 'صف بررسی تحلیل کن تایید رد' },
      { label: 'اسناد ثبت‌شده', screen: 'accounting', section: 'journals', keywords: 'سند دفتر روزنامه' },
      { label: 'ثبت سند دستی', screen: 'accounting', section: 'entry', keywords: 'سند اصلاحی سند جدید' },
      { label: 'کارتابل تأیید اسناد', screen: 'accounting', section: 'worklist', keywords: 'تایید پیش نویس برگشتی' },
      { label: 'حقوق و دستمزد', screen: 'accounting', section: 'payroll', keywords: 'لیست حقوق بیمه مالیات کارکنان' },
      { label: 'دوره مالی و بستن ماه', screen: 'accounting', section: 'period', keywords: 'بستن دوره قفل ماه' },
      { label: 'قانون ثبت خودکار', screen: 'review', section: 'automation-policy', keywords: 'موتور تصمیم شادو حد سرمایه ای خودکار' },
    ],
  },
  {
    id: 'base', label: 'کدینگ و اطلاعات پایه', icon: 'tree', items: [
      { label: 'درخت کدینگ', screen: 'chart', section: 'chart', keywords: 'کل معین سرفصل' },
      { label: 'نگاشت حساب‌ها', screen: 'chart', section: 'mapping', keywords: 'اتصال کدینگ نگاشت' },
      { label: 'تفصیلی و مرکز هزینه', screen: 'chart', section: 'dimensions', keywords: 'تفصیلی پروژه مرکز هزینه' },
      { label: 'ورود کدینگ و ماندهٔ افتتاحیه', screen: 'chart', section: 'import', keywords: 'اکسل افتتاحیه ورود فایل' },
    ],
  },
  {
    id: 'reports', label: 'گزارش‌ها', icon: 'chart', items: [
      { label: 'تراز آزمایشی', screen: 'accounting', section: 'trial', keywords: 'تراز مانده حساب ها' },
      { label: 'گزارش نقدینگی و روند', screen: 'report', keywords: 'نقدینگی دوام روند هزینه درآمد نمودار' },
    ],
  },
  {
    id: 'collaboration', label: 'همکاری با حسابدار', icon: 'users', items: [
      { label: 'تحویل به حسابدار', screen: 'collaboration', section: 'delivery', keywords: 'خروجی پارسیان انتقال بسته پایان ماه' },
      { label: 'سؤال و پاسخ', screen: 'collaboration', section: 'questions', keywords: 'درخواست توضیح سوال' },
      { label: 'DNA مالی', screen: 'collaboration', section: 'dna', keywords: 'الگو رفتار مالی' },
    ],
  },
  {
    id: 'settings', label: 'تنظیمات', icon: 'settings', items: [
      { label: 'تنظیمات عمومی', screen: 'settings', section: 'general', keywords: 'نام کسب و کار صوت محدوده' },
      { label: 'دفترها و دسترسی تیم', screen: 'settings', section: 'team', keywords: 'کاربر دسترسی نقش دفتر بایگانی دعوت' },
      { label: 'پشتیبان و بازیابی', screen: 'settings', section: 'backup', keywords: 'بکاپ پشتیبان بازیابی' },
      { label: 'حریم خصوصی داده', screen: 'settings', section: 'privacy', keywords: 'حذف داده نگهداری' },
      { label: 'امنیت، نشست‌ها و رمز', screen: 'settings', section: 'security', keywords: 'رمز عبور دستگاه نشست خروج' },
      // صفحهٔ جدا بود؛ حالا زبانهٔ تنظیمات است ولی همان مجوز صفحهٔ یادگیری را می‌خواهد.
      { label: 'یادگیری‌های دسته‌بندی', screen: 'settings', section: 'learning', requires: 'learning', keywords: 'یادگیری دسته کلمه' },
    ],
  },
]);

/** زبانه‌های دفتر مالی که برگ‌های منو به آن‌ها می‌روند. */
export const LEDGER_SECTIONS = Object.freeze({
  transactions: 'transactions', obligations: 'obligations', timing: 'timing', invoices: 'invoices', reconciliation: 'reconciliation',
  recurring: 'recurring', inventory: 'inventory', tools: 'tools', counterparties: 'counterparties',
  'cards-banks': 'counterparties', 'cards-cash': 'counterparties', 'cards-people': 'counterparties',
});

/** بخش کارت حساب که هر برگ باز می‌کند. */
export const CARD_SECTIONS = Object.freeze({ 'cards-banks': 'banks', 'cards-cash': 'cash', 'cards-people': 'people' });

/** بخش‌های صفحهٔ تنظیمات، به ترتیب زبانه‌ها. */
export const SETTINGS_SECTIONS = Object.freeze([
  ['general', 'عمومی'], ['accounts', 'صندوق و بانک'], ['team', 'دفترها و تیم'],
  ['backup', 'پشتیبان'], ['privacy', 'حریم خصوصی'], ['security', 'امنیت و ورود'], ['learning', 'یادگیری‌ها'],
]);

/** بخش‌هایی از تنظیمات که مجوز صفحهٔ دیگری لازم دارند. */
export const SETTINGS_REQUIRES = Object.freeze({ learning: 'learning' });

/**
 * منوی همین کاربر: فقط برگ‌هایی که صفحه‌شان مجاز است، و در دفتر مالی فقط
 * زبانه‌هایی که نوع پرونده دارد. گروه خالی حذف می‌شود.
 */
export function visibleMenu(screens = [], { ledgerTabs = null } = {}) {
  const allowed = new Map(screens.map((item) => [item.id, item]));
  return MENU.map((group) => ({
    ...group,
    items: group.items.filter((item) => allowed.has(item.screen) && (!item.requires || allowed.has(item.requires))
      && (!item.ledgerTab || !ledgerTabs || ledgerTabs.includes(item.ledgerTab))),
  })).filter((group) => group.items.length);
}

/**
 * برگ متناظر با صفحه و بخش فعلی، برای مسیر بالای صفحه و پررنگ‌کردن منو.
 *
 * بخشی که برگ ندارد (مثلاً پرش به یک هشدار در گزارش) به اولین برگ همان صفحه
 * برمی‌گردد.
 */
export function findMenuItem(groups, screen, section = '') {
  let fallback = null;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.screen !== screen) continue;
      if ((item.section || '') === (section || '')) return { group, item };
      if (!fallback) fallback = { group, item };
    }
  }
  return fallback;
}

const normalize = (value) => String(value || '')
  .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[‌‏‎]/g, ' ')
  .replace(/[ًٌٍَُِّْٔ]/g, '').replace(/ۀ/g, 'ه').replace(/أ|إ|آ/g, 'ا')
  .replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * جست‌وجو در منو: هر واژهٔ پرسش باید در نام برگ، نام گروه یا واژه‌های هم‌معنا
 * باشد. «چک» برگ «طلب، بدهی و چک» را پیدا می‌کند و «پارسیان» تحویل به حسابدار را.
 */
export function searchMenu(groups, query) {
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const results = [];
  for (const group of groups) {
    for (const item of group.items) {
      const haystack = normalize(`${item.label} ${group.label} ${item.keywords || ''}`);
      if (words.every((word) => haystack.includes(word))) results.push({ group, item });
    }
  }
  // نام خودِ برگ بر واژهٔ هم‌معنا مقدم است.
  return results.sort((a, b) => Number(!normalize(a.item.label).includes(words[0])) - Number(!normalize(b.item.label).includes(words[0])));
}
