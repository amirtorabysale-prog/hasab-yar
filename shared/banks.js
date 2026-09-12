import { normalizePersian } from './normalize.js';

/**
 * شناسنامهٔ بانک‌های ایران.
 *
 * چرا یک فهرست ثابت و نه متن آزاد: کاربر می‌گوید «از ملت دادم» ولی حسابش را
 * «جاری شرکت» اسم گذاشته. بدون هویت مشترک، این دو هیچ‌وقت به هم نمی‌رسند و هر
 * ثبت بانکی در صندوق می‌نشیند.
 *
 * دو ردهٔ نام:
 *
 * - `strong`: نامی که در فارسی روزمره تقریباً همیشه یعنی بانک — «پاسارگاد»،
 *   «رفاه»، «بلوبانک». این‌ها تنها هم که بیایند قابل اتکا هستند.
 * - `weak`: نامی که واژهٔ روزمره هم هست — «شهر»، «آینده»، «دی»، «ملی»، «سامان».
 *   «دی» اسم ماه است و «۱۰ دی پول دادم» هیچ ربطی به بانک ندارد. این‌ها فقط با
 *   نشانه‌ای مثل «بانک»، «کارت» یا «حساب» شناخته می‌شوند.
 *
 * همان درسی که یک بار با «دیگه»/«دی» گرفتیم: نام کوتاه بدون مرز و بدون نشانه،
 * بی‌صدا چیز دیگری را می‌بلعد.
 */
export const BANKS = Object.freeze([
  { id: 'melli', name: 'بانک ملی ایران', strong: [], weak: ['ملی', 'ملی ایران'] },
  { id: 'mellat', name: 'بانک ملت', strong: ['ملت'], weak: [] },
  { id: 'saderat', name: 'بانک صادرات ایران', strong: ['صادرات'], weak: [] },
  { id: 'tejarat', name: 'بانک تجارت', strong: ['تجارت'], weak: [] },
  { id: 'sepah', name: 'بانک سپه', strong: ['سپه'], weak: [] },
  { id: 'keshavarzi', name: 'بانک کشاورزی', strong: ['کشاورزی'], weak: [] },
  { id: 'maskan', name: 'بانک مسکن', strong: ['مسکن'], weak: [] },
  { id: 'refah', name: 'بانک رفاه کارگران', strong: ['رفاه', 'رفاه کارگران'], weak: [] },
  { id: 'post', name: 'پست بانک ایران', strong: ['پست بانک'], weak: [] },
  { id: 'sanat', name: 'بانک صنعت و معدن', strong: ['صنعت و معدن'], weak: [] },
  { id: 'tosee-saderat', name: 'بانک توسعه صادرات ایران', strong: ['توسعه صادرات'], weak: [] },
  { id: 'tosee-taavon', name: 'بانک توسعه تعاون', strong: ['توسعه تعاون'], weak: [] },
  { id: 'parsian', name: 'بانک پارسیان', strong: ['پارسیان'], weak: [] },
  { id: 'pasargad', name: 'بانک پاسارگاد', strong: ['پاسارگاد'], weak: [] },
  { id: 'saman', name: 'بانک سامان', strong: [], weak: ['سامان'] },
  { id: 'eghtesad-novin', name: 'بانک اقتصاد نوین', strong: ['اقتصاد نوین'], weak: [] },
  { id: 'karafarin', name: 'بانک کارآفرین', strong: ['کارآفرین', 'کار آفرین'], weak: [] },
  { id: 'sina', name: 'بانک سینا', strong: ['سینا'], weak: [] },
  { id: 'shahr', name: 'بانک شهر', strong: [], weak: ['شهر'] },
  { id: 'dey', name: 'بانک دی', strong: [], weak: ['دی'] },
  { id: 'saramad', name: 'بانک سرمایه', strong: [], weak: ['سرمایه'] },
  { id: 'ayandeh', name: 'بانک آینده', strong: [], weak: ['آینده'] },
  { id: 'gardeshgari', name: 'بانک گردشگری', strong: ['گردشگری'], weak: [] },
  { id: 'iranzamin', name: 'بانک ایران زمین', strong: ['ایران زمین'], weak: [] },
  { id: 'khavarmianeh', name: 'بانک خاورمیانه', strong: ['خاورمیانه'], weak: [] },
  { id: 'resalat', name: 'بانک قرض الحسنه رسالت', strong: ['رسالت'], weak: [] },
  { id: 'mehr-iran', name: 'بانک قرض الحسنه مهر ایران', strong: ['مهر ایران'], weak: [] },
  { id: 'blu', name: 'بلوبانک', strong: ['بلوبانک', 'بلو بانک', 'blu'], weak: [] },
  { id: 'blubank-melal', name: 'مؤسسه اعتباری ملل', strong: ['ملل'], weak: [] },
  { id: 'noor', name: 'مؤسسه اعتباری نور', strong: [], weak: ['نور'] },
]);

/** نشانه‌هایی که یک واژهٔ روزمره را به نام بانک تبدیل می‌کنند. */
const MARKERS = ['بانک', 'کارت', 'حساب', 'شبا', 'سپرده'];

const BOUNDARY_BEFORE = '(?<![آ-یa-zA-Z0-9])';
const BOUNDARY_AFTER = '(?![آ-یa-zA-Z0-9])';

/**
 * الگوی یک نام.
 *
 * `\b` با حروف فارسی کار نمی‌کند، برای همین مرز دستی گذاشته شده — همان چیزی که
 * یک بار نبودش باعث شد «یک ماه دیگه» به «اول دی» تبدیل شود.
 */
function aliasPattern(alias, requireMarker) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  if (!requireMarker) return new RegExp(`${BOUNDARY_BEFORE}${escaped}${BOUNDARY_AFTER}`);
  // نشانه یا پیش از نام می‌آید («بانک دی») یا پس از آن («دی بانک»).
  const markers = MARKERS.join('|');
  return new RegExp(`${BOUNDARY_BEFORE}(?:(?:${markers})\\s+${escaped}|${escaped}\\s+(?:${markers}))${BOUNDARY_AFTER}`);
}

const COMPILED = BANKS.flatMap((bank) => [
  ...bank.strong.map((alias) => ({ bank, alias, pattern: aliasPattern(alias, false), weight: alias.length + 10 })),
  ...bank.weak.map((alias) => ({ bank, alias, pattern: aliasPattern(alias, true), weight: alias.length })),
]).sort((left, right) => right.weight - left.weight);

export function bankById(id) {
  return BANKS.find((bank) => bank.id === id) || null;
}

/**
 * بانکِ گفته‌شده در یک جمله.
 *
 * خروجی شامل متنی است که تطبیق خورده، تا فراخوان بتواند پیش از تشخیص دسته و
 * مبلغ آن را ماسک کند. «بانک صادرات» نباید دستهٔ «صادرات» بسازد.
 *
 * فقط یک بانک برمی‌گردد: جمله‌ای که دو بانک دارد («از ملت به پاسارگاد») انتقال
 * بین حساب‌هاست، نه هزینه، و حدس زدن یکی از آن دو بدتر از نگفتن است.
 */
export function detectBank(text) {
  const normalized = normalizePersian(text);
  if (!normalized) return null;
  const hits = [];
  for (const entry of COMPILED) {
    const match = entry.pattern.exec(normalized);
    if (!match) continue;
    if (hits.some((hit) => hit.bank.id === entry.bank.id)) continue;
    hits.push({ bank: entry.bank, matchedText: match[0], index: match.index });
  }
  if (hits.length !== 1) return null;
  const [hit] = hits;
  return { bankId: hit.bank.id, bankName: hit.bank.name, matchedText: hit.matchedText, index: hit.index };
}

/**
 * حسابِ متناظر با یک بانک، از میان حساب‌های دفتر.
 *
 * اینجا می‌ماند تا رابط کاربری و سرور یک قاعده داشته باشند. یک بار همین قاعده
 * در دو جا نوشته شده بود و برگهٔ تأیید پیش از ارسال حساب را روی صندوق می‌گذاشت؛
 * نتیجه‌اش این بود که گفتنِ نام بانک روی مسیر واقعی هیچ اثری نداشت، درحالی‌که
 * آزمون‌های سرور سبز بودند.
 *
 * دو حساب از یک بانک یعنی جمله روشن نیست و هیچ‌کدام انتخاب نمی‌شود: برداشت از
 * حساب اشتباه بدتر از نپرسیدن است.
 */
export function pickBankAccount(accounts = [], bankId = '') {
  if (!bankId) return null;
  const matches = accounts.filter((account) => account
    && account.active !== false && account.kind === 'bank' && account.bankId === bankId);
  return matches.length === 1 ? matches[0] : null;
}

/** آیا جمله بیش از یک بانک نام می‌برد؟ یعنی احتمالاً انتقال بین حساب‌هاست. */
export function mentionsMultipleBanks(text) {
  const normalized = normalizePersian(text);
  const seen = new Set();
  for (const entry of COMPILED) {
    if (entry.pattern.test(normalized)) seen.add(entry.bank.id);
  }
  return seen.size > 1;
}
