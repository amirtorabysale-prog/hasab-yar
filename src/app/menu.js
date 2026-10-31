/**
 * درخت منو — هر صفحه یک مقصد؛ جزئیات هر صفحه بالای خود صفحه.
 *
 * درخواست مالک محصول (مهر ۱۴۰۵): «هر بخشی که توی نوار اصلی صفحه ذکر شده نیازی
 * نیست توی نوار سمت راستی سایت ذکر بشه؛ فقط باعث گیج شدن کاربر می‌شود.» پس هر
 * گروه منو فقط یک مقصد دارد: دفتر مالی، دفتر اسناد، کدینگ و تنظیمات هرکدام
 * نوار زبانهٔ خودشان را بالای صفحه دارند و کاربر از همان‌جا بین بخش‌ها می‌رود.
 *
 * ادغام‌های این نسخه:
 * - «دریافت و پرداخت» و «بانک، صندوق و اشخاص» یک گزینه‌اند؛ کارت‌ها و تطبیق بانک
 *   زبانهٔ همان دفتر مالی‌اند. تعریف صندوق و بانک فقط در تنظیمات می‌ماند.
 * - «حسابداری و اسناد» یک گزینه است؛ اسناد، تراز، ثبت سند، کارتابل، حقوق و
 *   دوره مالی زبانه‌های بالای همان صفحه‌اند.
 * - «صف حسابدار» بخش جداگانهٔ خودش را دارد و «قانون ثبت خودکار» از ناوبری
 *   بیرون است — پنلش همان‌جا داخل صف حسابدار هست.
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
      { label: 'دفتر مالی', screen: 'ledger', section: 'transactions', ledgerTab: 'transactions',
        keywords: 'دریافت پرداخت تراکنش طلب بدهی چک چک ضمانت سررسید چک پیش پرداخت پیش دریافت ثبت دوره ای فاکتور انبار موجودی تطبیق بانک کارت بانک صندوق اشخاص شرکت ابزار رسید بستن صندوق پرسش از دفتر' },
    ],
  },
  {
    id: 'bank-sms', label: 'پیامک بانکی', icon: 'sms', items: [
      { label: 'پیامک‌های بانکی', screen: 'bank-sms', keywords: 'پیامک اس ام اس sms بانک برداشت واریز مانده تطبیق' },
    ],
  },
  {
    id: 'petty', label: 'تنخواه‌گردان', icon: 'petty', items: [
      { label: 'مدیریت تنخواه', screen: 'petty-cash', keywords: 'تنخواه شارژ دارنده سقف پرداخت' },
    ],
  },
  {
    id: 'accounting', label: 'حسابداری و اسناد', icon: 'book', items: [
      { label: 'دفتر اسناد', screen: 'accounting', section: 'journals',
        keywords: 'سند دفتر روزنامه اسناد ثبت شده تراز آزمایشی ثبت سند دستی کارتابل تأیید حقوق و دستمزد دوره مالی بستن ماه' },
    ],
  },
  {
    id: 'review', label: 'صف حسابدار', icon: 'inbox', items: [
      { label: 'صف بررسی', screen: 'review',
        keywords: 'صف بررسی حسابدار تحلیل کن تایید رد قانون ثبت خودکار موتور تصمیم شادو حد سرمایه ای خودکار' },
    ],
  },
  {
    id: 'base', label: 'کدینگ و اطلاعات پایه', icon: 'tree', items: [
      { label: 'درخت کدینگ', screen: 'chart', section: 'chart',
        keywords: 'کل معین سرفصل نگاشت حسابها تفصیلی مرکز هزینه افتتاحیه ورود کدینگ اکسل' },
    ],
  },
  {
    id: 'reports', label: 'گزارش‌ها', icon: 'chart', items: [
      { label: 'نقدینگی و روند', screen: 'report', keywords: 'گزارش نقدینگی دوام روند هزینه درآمد نمودار' },
      { label: 'گزارش‌های حسابداری', screen: 'accounting-reports',
        keywords: 'تراز آزمایشی دو چهار شش هشت ستونی ترازنامه صورت سود و زیان جریان وجوه نقد حقوق مالکانه دفتر روزنامه دفتر کل معین تفصیلی کارت حساب بدهکاران بستانکاران گزارش سنی مرکز هزینه کنترل' },
    ],
  },
  {
    id: 'collaboration', label: 'همکاری با حسابدار', icon: 'users', items: [
      { label: 'تحویل و پرسش‌ها', screen: 'collaboration', section: 'delivery',
        keywords: 'خروجی پارسیان انتقال بسته پایان ماه سوال پاسخ' },
    ],
  },
  {
    id: 'dna', label: 'DNA مالی', icon: 'dna', items: [
      { label: 'DNA مالی', screen: 'dna', keywords: 'dna دی ان ای اثر انگشت الگو رفتار پرونده پروفایل انضباط ثبت' },
    ],
  },
  {
    id: 'settings', label: 'تنظیمات', icon: 'settings', items: [
      { label: 'عمومی', screen: 'settings', section: 'general',
        keywords: 'تنظیمات عمومی نام کسب و کار صوت محدوده تعریف صندوق و بانک اشخاص دفترها تیم دسترسی پشتیبان بازیابی حریم خصوصی امنیت رمز نشست یادگیری دسته کلمه' },
    ],
  },
]);

/** زبانه‌های دفتر مالی که نشانی‌های قدیمی (`#/ledger/…`) به آن‌ها می‌روند. */
export const LEDGER_SECTIONS = Object.freeze({
  transactions: 'transactions', obligations: 'obligations', cheques: 'cheques', timing: 'timing', invoices: 'invoices', reconciliation: 'reconciliation',
  recurring: 'recurring', inventory: 'inventory', tools: 'tools', counterparties: 'counterparties',
  'cards-banks': 'counterparties', 'cards-cash': 'counterparties', 'cards-people': 'counterparties',
});

/** بخش کارت حساب که نشانی قدیمی باز می‌کند. */
export const CARD_SECTIONS = Object.freeze({ 'cards-banks': 'banks', 'cards-cash': 'cash', 'cards-people': 'people' });

/** بخش‌های صفحهٔ تنظیمات، به ترتیب زبانه‌ها؛ تعریف صندوق و بانک هم همین‌جاست. */
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
 * بخشی که برگ ندارد (مثلاً زبانهٔ «طلب و بدهی» دفتر مالی که در منو تکرار نشده)
 * به برگ همان صفحه برمی‌گردد؛ نام زبانه بالای خود صفحه دیده می‌شود.
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
 * باشد. «چک» دفتر مالی را پیدا می‌کند و «پارسیان» تحویل به حسابدار را؛ «قانون
 * ثبت خودکار» هم به صف حسابدار می‌رسد.
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
