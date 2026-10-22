/**
 * از «فهم رویداد» به ردیف‌های همان مسیر ثبت.
 *
 * خروجی معتبر مدل این‌جا به جملهٔ فارسی برنمی‌گردد تا پارسر دوباره تفسیرش کند.
 * مستقیم به همان قالب ردیفی تبدیل می‌شود که `insertTransactionRows` می‌پذیرد —
 * با واقعیت‌های صریح (`paymentPurpose`، `intendedUse`، `settlement`، …) و با
 * `factSource: 'understanding'`، که به لایهٔ رویداد می‌گوید این واقعیت‌ها از متن
 * با الگو حدس زده نشوند. موتور قاعده، نگهبان‌ها و ثبت همان‌اند که بودند.
 *
 * سه قاعده که این فایل به خاطرشان نوشته شده:
 *
 * - **دوباره‌شماری نه:** کلی که اجزایش جدا انجام شده‌اند، خودش ردیف نمی‌شود؛
 *   «صد میلیون خریدیم، چهل نقد، بقیه نسیه» یک خروج ۴۰ و یک بدهی ۶۰ است، نه
 *   سه ردیف.
 * - **آینده و مشروط سند نیستند:** پرداخت قول‌داده‌شده و بخشودگی مشروط فقط
 *   یادداشت پرونده‌اند تا وقتی انجام شوند.
 * - **زمینه، رویداد نیست:** «۸۰ میلیون بدهکار بودیم» بدهی را دوباره نمی‌سازد؛
 *   فقط می‌گوید پرداخت امروز تسویهٔ همان بدهی است.
 *
 * تابع خالص است: شناسهٔ حساب و شخص از «تفکیک» سرور می‌آید و تاریخ امروز صریح
 * داده می‌شود.
 */
import { CATEGORY_DEFINITIONS, classifyCategory } from './categoryRules.js';
import { TIME_BOUND_SERVICE_CATEGORIES } from './economicFamily.js';
import { incomeTwin } from './parser.js';
import { detectBank } from './banks.js';
import { normalizePersian } from './normalize.js';
import { persianMonthRange, persianToISO, todayPersian } from './persianDate.js';
import { detectPartnerFundedSpend, detectPartnerPaidDebt } from './partnerPaidSpeech.js';
import { readServicePeriod } from './periodSpeech.js';
import { mentionsPropertyDeposit, paymentPurposeFromSpeech, receiptPurposeFromSpeech, saysRefundable } from './moneyPurpose.js';
import { evidenceKey } from './eventUnderstanding.js';

const SUBJECT_USE_TO_INTENT = Object.freeze({
  resale: 'resale', production: 'production', 'long-term': 'long-term-use', internal: 'current-consumption',
});

/** جزئی که خودش جابه‌جایی پول یا تعهد است، نه مالیات و تخفیفِ داخلِ یک کل. */
const SPLIT_ROLES = new Set(['cash-part', 'credit-part', 'paid-now', 'received-now', 'part', 'deposit', 'fee']);
const JUDGMENT_PART_ROLES = new Set(['tax', 'discount', 'interest', 'waiver']);
/** «چک» به‌عنوان یک واژه — نه «کوچک» — و «پاس شد» یعنی پول جابه‌جا شده است. */
const CHEQUE_CUE = /(?:^|[\s«(،])چک(?=$|[\s.،؛!؟»)ِ‌]|ی\s)/;
const CHEQUE_CLEARED = /پاس\s*شد|وصول\s*شد|نقد\s*شد/;
const UNIDENTIFIED_DEPOSIT = /معلوم\s*نیس(?:ت)?\s*(?:از\s*طرف\s*)?(?:کی|چه\s*کسی)|بدون\s*مشخصات|ناشناس|مشکوک/;
const TAX_RETURN = /اظهارنامه[^.،؛!؟]{0,30}(?:ارسال|تسلیم)\s*شد|تهاتر/;
/** «بعداً می‌گم چی بود»: بابتِ پول گفته نشده. */
const PURPOSE_UNSAID = /بعد(?:ا|اً)?\s*(?:بهت\s*)?(?:می\s*گم|میگم|می\s*گویم)\s*(?:چی|بابت|برای)/;
/** بیمهٔ پرسنل: سهم کارفرما و کارگر، بدهیِ لیست بیمه است، نه هزینهٔ تازه. */
const PAYROLL_CUE = /ت[اأ]مین\s*اجتماعی|لیست\s*بیمه|سهم\s*کارفرما|بیمه\s*(?:پرسنل|کارکنان|کارگران)/;
/** «سرمایه از پانصد میلیون به یک میلیارد افزایش یافت»: مبلغ، تفاوتِ دو عدد است. */
const CAPITAL_CHANGE = /سرمایه[^.؛]{0,80}از\s[^.،؛]{1,40}\sبه\s[^.،؛]{1,60}(?:افزایش|کاهش)/;
/** حساب جاری شریک یا سهامدار؛ «افزایش سرمایه»ی صریح سرمایه است. */
const PARTNER_CUE = /سهامدار|شریک|شرکا/;
/** ثبت تعدیلی پایان دوره: ذخیره، سودِ تحقق‌یافتهٔ سررسیدنشده. */
const ADJUSTING_CUE = /ذخیره\s*(?:مرخصی|سنوات|مزایا|مطالبات|کاهش)|سررسید\s*نشده|تحقق\s*(?:پیدا\s*کرده|یافته)|در\s*دفاتر\s*منظور/;
/** قسط یا باقیِ یک قراردادِ موجود: «قسط دوم بیمه»، «باقی حق بیمه»، «مابقی اجاره». */
const CONTRACT_REMAINDER = /(?:(?<![آ-ی])(?:باقی|بقیه|بقیش|مابقی|الباقی|باقیمانده|باقی\s*مانده)(?![آ-ی])|قسط\s*(?:دوم|سوم|چهارم|پنجم|ششم|بعدی|آخر|[0-9۰-۹]+)(?![آ-ی])|(?:دومین|سومین|چهارمین|پنجمین|آخرین)\s*قسط)\s*(?:\S+\s*){0,2}?(?:حق\s*(?:بیمه|اشتراک)|بیمه|اجاره|کرایه|اشتراک|لایسنس|قرارداد)/;
/** پولِ خدمتی که پیشاپیش آمده. */
const UPFRONT = /از\s*اول|یک\s*جا|یکجا|پیش\s*پیش|پیشاپیش|جلوتر|کل\s*مبلغ/;
const SERVICE_DONE = /انجام\s*(?:دادیم|دادم|شد)|(?:تموم|تمام)\s*(?:کردیم|کردم|شد)|تحویل\s*(?:دادیم|دادم|شد)|(?:نصب|اجرا|راه\s*اندازی)\s*(?:کردیم|کردم|شد)(?![آ-ی])/;
/**
 * گارانتی و ضمانت دورهٔ درآمد نیست: «گارانتی یک ساله» کنار خدمتِ انجام‌شده، ۴۰
 * میلیونِ نصب را ۱۲ ماه پیش‌دریافت می‌کرد (بازبین موتور ۵). عبارتِ گارانتی با
 * طولش از خواندنِ دورهٔ درآمد کنار می‌رود؛ خدمتِ انجام‌شده‌ای که گارانتی یا
 * پشتیبانیِ دوره‌دار دارد، اینکه سهمی برای تعهدِ بعدی کنار برود، قضاوت حسابدار است.
 */
const WARRANTY_WORD = '(?:گارانتی|ضمانت|وارانتی|پشتیبانی\\s*رایگان|خدمات\\s*پس\\s*از\\s*فروش)';
const WARRANTY_PHRASE = new RegExp(`(?:[^\\s،,.؛]+\\s+){0,2}${WARRANTY_WORD}(?:\\s+[^\\s،,.؛]+){0,3}`, 'g');
const AFTER_SERVICE = new RegExp(`(?:[^\\s،,.؛]+\\s+){0,2}(?:${WARRANTY_WORD}|پشتیبانی|نگهداری)(?:\\s+[^\\s،,.؛]+){0,3}`, 'g');
/** ماهیتِ هر مبلغ از شاهدِ خودش، نه از نوعِ کل رویداد. */
const REFUNDABLE_WORDS = /ودیعه|رهن|سپرده|تضمین|حسن\s*انجام|قرض\s*الحسنه/;
const ADVANCE_WORDS = /بیعانه|پیش\s*پرداخت|پیش\s*دریافت|علی[\s‌]*الحساب/;
/**
 * ودیعه و اجاره در شاهدِ یک مبلغ: «۳۶ میلیون بابت ودیعه و اجاره مهر». سهم هر کدام
 * گفته نشده؛ هر برچسبی برای کل مبلغ حدس است (اجارهٔ مهر یا پنهان می‌ماند یا ودیعه
 * هزینه می‌شود). «ودیعهٔ اجارهٔ دفتر» یک چیز است و این‌جا نمی‌گنجد.
 */
const DEPOSIT_AND_SERVICE = /(?:ودیعه|رهن|سپرده)\s*و\s*(?:اجاره|کرایه|شارژ)|(?:اجاره|کرایه|شارژ)[^.،,؛\d]{0,24}?\s+و\s+(?:ودیعه|رهن|سپرده)/;
/**
 * ودیعه یا رهنی که به ما رسیده: مستاجر داده، یا صاحبخانه ودیعهٔ ما را پس داده.
 * هیچ‌کدام درآمد نیست؛ اولی بدهیِ برگشت‌پذیر است و دومی طلب قبلی را می‌بندد.
 * «سود سپرده» درآمد است و این‌جا نمی‌آید.
 */
const DEPOSIT_IN_WORDS = /(?<![آ-ی])(?:ودیعه|رهن)|حسن\s*انجام|(?<!سود\s*)(?<![آ-ی])سپرده(?!\s*گذاری)/;
/** درآمدِ دوره‌دار: اجاره، اشتراک، پشتیبانی — نه «کرایهٔ حمل» که خدمتِ یک‌باره است. */
const TIME_BOUND_INCOME = /اجاره|کرایه(?!\s*(?:حمل|بار|ماشین\s*بار))|اشتراک|لایسنس|پشتیبانی|نگهداری|شارژ|حق\s*عضویت|آبونمان/;
const THIS_MONTH_WORDS = /(?:این|همین)\s*ماه|ماه\s*جاری/;
const PARTY_TITLE = /آقای|خانم|شرکت|دکتر|مهندس|حاج|فروشگاه|موسسه|مؤسسه|کارخانه/;
/**
 * نقش، نه نام: «تعمیرکار»، «مشتری»، «موجر». مدل این‌ها را نام طرف حساب می‌نوشت و
 * بدهی و طلب و پیش‌دریافت به نامِ «تعمیرکار» و «مشتری» ساخته می‌شد؛ پرداختِ بعدی به
 * «آقای رضایی» هیچ‌وقت به آن بدهی نمی‌رسید و هزینه دو بار ثبت می‌شد (آزمون ۱۰۰ سناریو،
 * R028، R030، R037، R057، R058).
 */
const GENERIC_PARTY = /^(?:یه\s*|یک\s*)?(?:تعمیرکار|تعمیرکاره|مشتری|مشتریه|موجر|مالک\s*ملک|صاحب\s*(?:خونه|خانه|ملک|مغازه)|مستاجر|مستأجر|فروشنده|خریدار|راننده|کارگر|پیمانکار|نقاش|برقکار|لوله\s*کش|بنا|نصاب|پیک|باربر|سرویس\s*کار|تامین\s*کننده|تأمین\s*کننده|عرضه\s*کننده|طرف|شخص|نفر|یکی|همکار|کارمند|کارفرما)(?:\s*(?:مون|مان|ها|ه))?$/;
/** تعویضِ قطعه‌ای که سوخته یا خراب شده: «کلید سوخته رو عوض کردیم»، «موتور خراب شد، یکی نو گذاشتیم». */
const BROKEN = '(?:سوخت|سوخته|خراب|معیوب|شکست|شکسته|ترکید|ترکیده|از\\s*کار\\s*افتاد|از\\s*کار\\s*افتاده)';
const REPLACE = '(?:عوض|تعویض|جایگزین|جاش|جایش|به\\s*جاش|به\\s*جای)';
const REPLACED_BROKEN = new RegExp(`${BROKEN}[^.؛!؟]{0,50}${REPLACE}|${REPLACE}[^.؛!؟]{0,50}${BROKEN}`);
/** بهسازیِ اساسیِ دارایی، نه تعمیرِ عادی: «کامل بازسازی و ارتقا دادیم». */
const CAPITAL_WORK = /بازسازی|نوسازی|بهسازی|ارتقا|افزایش\s*ظرفیت/;
/** فاکتورِ زده‌شده — نه پیش‌فاکتور. */
const INVOICE_ISSUED = /(?<!پیش\s*)فاکتور(?:\s*فروش)?(?:ش)?[^.،؛!؟]{0,40}?(?:زدیم|زدم|صادر\s*(?:کردیم|کردم|شد|شده)|فرستادیم|رفته)(?![آ-ی])/;
/** سندی که پیش‌تر آمده: «قبضی که اومده بود»، «بابت فاکتور قبلی»، «بدهیِ قبلی». */
const PRIOR_DOCUMENT = /(?:قبض|فاکتور|صورت\s*حساب)[^.،؛!؟]{0,30}که\s*(?:اومده|آمده|رسیده|زده)\s*بود|(?:فاکتور|قبض|بدهی|طلب|خرید|فروش)\s*(?:ی\s*)?(?:قبلی|قبل)(?![آ-ی])|که\s*(?:قبلا|قبلاً)\s*(?:اومده|آمده|رسیده|ثبت\s*شده)/;
/** برداشتِ اول‌شخص («برای خودم برداشتم») برداشتِ مالک است و پرسش ندارد. */
const FIRST_PERSON_DRAWING = /(?:^|\s)(?:خودم|خودمون|خودمان|برداشتم|برداشتیم)(?=$|[\s.،؛!؟])/;
const genericParty = (name) => GENERIC_PARTY.test(normalizePersian(name || '').replace(/[«»"]/g, '').trim());
/** «شرکت آریا تجارت» طرف حساب است، نه بانک تجارت؛ همان قاعدهٔ اعتبارسنجی فهم. */
const bankName = (name) => Boolean(name) && !(PARTY_TITLE.test(name) && !/بانک/.test(name)) && Boolean(detectBank(name));
/** نوع‌هایی که ماهیتِ یک مبلغ‌اند، نه کل گفته؛ در گفتهٔ چندمبلغی به همه نمی‌رسند. */
const PER_AMOUNT_KINDS = new Set(['advance-paid', 'advance-received', 'deposit']);

/**
 * نوع رویداد → هدف دریافت یا پرداخت، همان واژگان موتور تصمیم.
 *
 * فقط آن‌چه نوع رویداد قطعاً می‌گوید. «پرداخت» بی‌نوع، هدفی نمی‌گیرد تا موتور
 * خودش «بابت چه بود؟» را بپرسد.
 */
const PURPOSE_BY_KIND = Object.freeze({
  purchase: { paymentPurpose: 'goods' },
  'asset-purchase': { paymentPurpose: 'goods', intendedUse: 'long-term-use' },
  expense: { paymentPurpose: 'expense' },
  'owner-drawing': { paymentPurpose: 'owner-drawing', refundable: false },
  'advance-paid': { paymentPurpose: 'advance' },
  // برچسب «ودیعه»ی رویداد به‌تنهایی نه هدف می‌گوید نه استرداد: مدل «بیمهٔ یک‌ساله
  // انبار»، «اجارهٔ سه ماه آینده» و «اشتراک یک‌ساله» را «ودیعه» نامید و هر سه ودیعهٔ
  // قابل استرداد شدند — هرگز هزینه نمی‌شدند (موتور ۵، مهر ۱۴۰۵). ماهیتِ ودیعه از
  // شاهدِ خودِ مبلغ می‌آید (`refundableHere`)؛ بی آن، دسته و دوره تصمیم می‌گیرند.
  deposit: {},
  sale: { receiptPurpose: 'sale' },
  income: { receiptPurpose: 'other-income' },
  'advance-received': { receiptPurpose: 'advance' },
  'loan-received': { receiptPurpose: 'loan' },
  'capital-in': { receiptPurpose: 'owner', refundable: false },
});

/** رویدادهایی که بدون قضاوت حسابدار سند نمی‌شوند — همان فهرست امروزِ موتور. */
const ACCOUNTANT_KINDS = Object.freeze({
  'loan-repayment': 'قسط وام اصل و سود دارد؛ تفکیکش با حسابدار است.',
  payroll: 'حقوق خالص و ناخالص، بیمه و مالیات دارد؛ ثبتش با حسابدار است.',
  correction: 'این گفته اصلاح یک ثبت قبلی است، نه رویداد تازه؛ سند اصلاحی با حسابدار است.',
  refund: 'برگشت یا استرداد، فروش یا خرید قبلی را کم می‌کند؛ ارجاعش به سند اول با حسابدار است.',
  cheque: 'چک تا وصول نشود پول نیست؛ ثبت چک از کارت چک یا با حسابدار است.',
});

const money = (value) => Number(value || 0).toLocaleString('fa-IR');

/**
 * پاسخ‌های ثبت‌کننده روی فهم.
 *
 * پاسخ کاربر بر برداشت مدل مقدم است و منشأش `user` می‌شود؛ استخراج تازهٔ مدل
 * نمی‌تواند رویش بنویسد، چون هر بار همین تابع دوباره اجرا می‌شود.
 */
export function applyUnderstandingAnswers(understanding, answers = {}) {
  const copy = JSON.parse(JSON.stringify(understanding));
  for (const [field, answer] of Object.entries(answers)) {
    const [section, id, prop] = field.split('.');
    if (section === 'amounts') {
      const amount = copy.amounts.find((item) => item.id === id);
      if (!amount) continue;
      if (prop === 'value' && Number.isSafeInteger(Number(answer.value)) && Number(answer.value) > 0) {
        Object.assign(amount, { value: Number(answer.value), accepted: true, provenance: 'user', issue: null, scaleAmbiguous: false });
      }
      if (prop === 'scale' && answer.value === 'yes') amount.scaleAmbiguous = false;
      if (prop === 'scale' && answer.value === 'no') Object.assign(amount, { accepted: false, issue: 'user-rejected-scale' });
      if (prop === 'parts' && Number.isSafeInteger(Number(answer.value))) Object.assign(amount, { value: Number(answer.value), accepted: true, provenance: 'user' });
    }
    if (section === 'movements' && prop === 'done') {
      const movement = copy.movements.find((item) => item.id === id);
      if (movement && answer.value === 'not-yet') movement.direction = 'none';
      if (movement) movement.confirmedDone = answer.value === 'done';
    }
    if (section === 'dates') {
      const iso = answer.value && !Number.isNaN(Date.parse(answer.value)) ? new Date(answer.value).toISOString() : null;
      const existing = copy.dates.find((item) => item.role === id);
      if (iso && existing) Object.assign(existing, { iso, accepted: true, issue: null, provenance: 'user' });
      else if (iso) copy.dates.push({ id: `user-${id}`, role: id, expression: '', iso, accepted: true, provenance: 'user' });
    }
    // نامِ طرف حسابی که جمله فقط نقشش را گفته بود («تعمیرکار» ← «آقای رضایی»).
    if (section === 'counterparties' && prop === 'name' && String(answer.value || '').trim()) {
      const party = copy.counterparties.find((item) => item.id === id);
      if (party) Object.assign(party, { name: String(answer.value).trim().slice(0, 100), provenance: 'user' });
    }
    if (section === 'subject' && id === 'use' && ['internal', 'resale', 'production', 'long-term'].includes(answer.value)) {
      copy.subject.use = answer.value;
      copy.subject.provenance = 'user';
    }
  }
  return copy;
}

function dateFor(understanding, roles) {
  return understanding.dates.find((date) => date.accepted && roles.includes(date.role))?.iso || null;
}

/**
 * طرف حسابِ یک جزء.
 *
 * بانک فقط در وام طرف حساب است؛ در بقیه، بانکی که مدل در فهرست طرف حساب‌ها
 * آورده حسابِ خودِ ماست و کارت شخص برایش ساخته نمی‌شود. نامِ سمتِ دیگرِ
 * جابه‌جایی — هر نوعی که مدل گفته باشد — اولین نشانه است.
 */
/**
 * کلیدِ تطبیقِ شاهد، با نقشهٔ برگشت به متن.
 *
 * اعتبارسنج شاهد را با `evidenceKey` پذیرفته است: بی‌نشانه‌گذاری، «آ» مثل «ا»،
 * تکه‌تکه برای «...». جای شاهد در متن هم باید همان‌طور پیدا شود؛ وگرنه شاهدِ
 * پذیرفته‌شده‌ای مثل «اجاره ۶ ماه جلوتر ... ۳۰ میلیون» یا «به آقای رضایی» (متن:
 * «اقای») پیدا نمی‌شد و بخشِ آن مبلغ به مبلغِ دیگر می‌رسید (بازبین موتور ۵).
 */
const KEY_PUNCTUATION = /[«»"'“”()[\]{}،,؛;:!؟?.\-–—]/;
function keyedText(said) {
  let key = '';
  const map = [];
  for (let at = 0; at < said.length; at += 1) {
    let char = said[at] === 'آ' ? 'ا' : KEY_PUNCTUATION.test(said[at]) ? ' ' : said[at];
    if (/\s/.test(char)) {
      if (!key.length || key.endsWith(' ')) continue;
      char = ' ';
    }
    key += char;
    map.push(at);
  }
  return { key, map };
}
const evidenceParts = (evidence) => String(evidence || '').split(/\.{2,}|…/).map((part) => evidenceKey(part)).filter(Boolean);
const DIGIT = /[0-9۰-۹٠-٩]/;

/** همهٔ جاهای یک شاهد در متن؛ «۲ میلیون» درونِ «۱۲ میلیون» نیست. */
function occurrences(keyed, evidence) {
  const parts = evidenceParts(evidence);
  if (!parts.length) return [];
  const { key, map } = keyed;
  const found = [];
  for (let at = key.indexOf(parts[0]); at >= 0; at = key.indexOf(parts[0], at + 1)) {
    if (DIGIT.test(key[at - 1] || '') && DIGIT.test(parts[0][0])) continue;
    let end = at + parts[0].length;
    let whole = true;
    for (const part of parts.slice(1)) {
      const next = key.indexOf(part, end);
      if (next < 0) { whole = false; break; }
      end = next + part.length;
    }
    if (!whole) continue;
    if (DIGIT.test(key[end] || '') && DIGIT.test(parts.at(-1).at(-1))) continue;
    found.push({ start: map[at], end: map[end - 1] + 1 });
  }
  return found;
}

/**
 * دسته با نوعِ موضوع و جهتِ پول جور است؟
 *
 * کالا و دارایی «قبوض»، «اجاره»، «بیمه»، حقوق، حمل، خدمت بیرونی، کارمزد، مالیات یا آموزش
 * نیستند؛ خدمت «مواد و کالا» نیست. دستهٔ هزینه برای پولِ رفته و دستهٔ درآمد برای پولِ
 * آمده. نوعِ نامعلوم یا «پول» قیدی نمی‌گذارد.
 */
const SERVICE_ONLY_CATEGORIES = new Set(['قبوض', 'اجاره', 'بیمه', 'حقوق و دستمزد', 'حمل‌ونقل', 'پیمانکار و خدمات بیرونی', 'کارمزد بانکی', 'مالیات و عوارض', 'جرایم مالیاتی', 'آموزش']);
const SERVICE_ON_ASSET_CATEGORIES = new Set([...SERVICE_ONLY_CATEGORIES, 'تعمیر و نگهداری']);
const SERVICE_ON_OBJECT_CATEGORIES = new Set(['اجاره', 'بیمه', 'تعمیر و نگهداری', 'حمل‌ونقل', 'پیمانکار و خدمات بیرونی']);
const STRONG_KEYWORD = 0.94;
const GENERIC_CATEGORIES = new Set(['سایر هزینه‌ها', 'سایر درآمدها']);
const SERVICE_INCOME_TWIN = Object.freeze({
  اجاره: 'درآمد اجاره', 'تعمیر و نگهداری': 'خدمات', آموزش: 'خدمات', 'پیمانکار و خدمات بیرونی': 'خدمات', 'حمل‌ونقل': 'خدمات', 'نرم‌افزار و اشتراک': 'خدمات',
});
const CATEGORY_TYPES = new Map(CATEGORY_DEFINITIONS.map((definition) => [definition.name, definition.type]));
function categoryFits(name, kind, type) {
  if (!name || CATEGORY_TYPES.get(name) !== type) return false;
  if (['goods', 'asset'].includes(kind) && SERVICE_ONLY_CATEGORIES.has(name)) return false;
  if (kind === 'service' && name === 'مواد و کالا') return false;
  return true;
}

/** بندِ یک شاهد در متنِ کامل: تکه‌ای میان دو نشانهٔ جداکننده. */
function clauseOf(said, evidence) {
  const span = occurrences(keyedText(said), evidence)[0];
  if (!span) return '';
  const separator = /[.،,؛;!؟?\n:]/;
  let start = span.start;
  while (start > 0 && !separator.test(said[start - 1])) start -= 1;
  let end = span.end;
  while (end < said.length && !separator.test(said[end])) end += 1;
  return said.slice(start, end);
}

/**
 * جای همهٔ مبالغ در متن، یک بار و برای همه یکسان.
 *
 * هر مبلغ فقط یک جا دارد. مبلغی که تنها یک جای آزاد دارد اول می‌نشیند و جایش را
 * از بقیه می‌گیرد («۱۰ میلیون» بعد از «اجاره شش ماه آینده دفتر ۱۰ میلیون»). اگر
 * دو مبلغ همچنان چند جای ممکن دارند («۱۰ میلیون» و «۱۰ میلیون»)، کدام کجاست حدس
 * است: `null`، و دوره و تاریخِ جمله صاحب ندارد. ترتیبِ مبلغی که بخشش را حساب
 * می‌کنیم در این جاگذاری اثری ندارد.
 */
function placeAmounts(said, items) {
  const keyed = keyedText(said);
  let pending = items.map((entry) => ({ ...entry, options: occurrences(keyed, entry.item.evidence) }));
  const placed = new Map();
  const taken = [];
  const free = (entry) => entry.options.filter((span) => !taken.some((other) => span.start < other.end && span.end > other.start));
  for (;;) {
    let progress = false;
    for (const entry of pending) {
      const open = free(entry);
      if (!open.length) {
        if (entry.required) return null;
        entry.dropped = true;
        continue;
      }
      if (open.length === 1) { placed.set(entry.item.id, open[0]); taken.push(open[0]); progress = true; }
    }
    pending = pending.filter((entry) => !entry.dropped && !placed.has(entry.item.id));
    if (!pending.length) return placed;
    if (!progress) return pending.some((entry) => entry.required) ? null : placed;
  }
}

/** «آبان و آذر»، «۶ و نیم»: «و» میان دو ماه یا دو عدد مرزِ دو مبلغ نیست. */
const MONTH_NAMES = 'فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند';
const AND_NOT_BOUNDARY = new RegExp(`^\\s+و\\s+(?:${MONTH_NAMES}|نیم|[0-9۰-۹٠-٩]|یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده)(?![آ-ی])`);
const PUNCTUATION = /[.،,؛;!؟?\n:]/;

/**
 * برش‌های جمله میان مبالغِ جاگذاری‌شده. `owner` صاحبِ هر شاهد است؛ شاهدِ بی‌صاحب
 * (کلی که اجزایش ماهیت‌های جدا دارند) مرز می‌سازد ولی بخشش مشترک می‌ماند.
 */
function sliceByOwner(said, spans) {
  const owned = spans.map(() => ({ from: 0, to: said.length }));
  let lead = spans[0].start;
  while (lead > 0 && !PUNCTUATION.test(said[lead - 1])) lead -= 1;
  owned[0].from = lead;
  let tail = spans[spans.length - 1].end;
  while (tail < said.length && !PUNCTUATION.test(said[tail])) tail += 1;
  owned[spans.length - 1].to = tail;
  for (let index = 1; index < spans.length; index += 1) {
    const left = spans[index - 1];
    const right = spans[index];
    if (left.owner && left.owner === right.owner) { owned[index - 1].to = right.start; owned[index].from = left.end; continue; }
    const gap = said.slice(left.end, right.start);
    let cut = -1;
    for (let at = 0; at < gap.length; at += 1) {
      if (PUNCTUATION.test(gap[at])) { cut = at; break; }
      if (/^\s+و\s/.test(gap.slice(at)) && (at === 0 || !/\s/.test(gap[at - 1])) && !AND_NOT_BOUNDARY.test(gap.slice(at))) { cut = at; break; }
    }
    owned[index - 1].to = cut < 0 ? left.end : left.end + cut;
    owned[index].from = cut < 0 ? right.start : left.end + cut;
  }
  return owned;
}

/**
 * بخشی از جمله که فقط مالِ یک مبلغ است.
 *
 * «قبض برق ۲ میلیون و اجاره ۶ ماه جلوتر دفتر ۳۰ میلیون از تجارت دادیم»: دورهٔ «۶ ماه
 * جلوتر» مالِ اجاره است، نه قبض. خواندنِ دوره از کل جمله برای هر مبلغ، قبض برق و
 * کرایهٔ حمل را پیش‌پرداختِ ۶ و ۱۲ ماهه می‌کرد (موتور ۵، مهر ۱۴۰۵) — هزینه‌ای که
 * همین امروز مصرف شده ماه‌ها در دارایی می‌ماند. بندِ نقطه‌گذاری کافی نیست، چون گفتار
 * بی‌ویرگول است؛ مرزِ دو مبلغ اولین «و» یا نشانهٔ جداکننده میانِ شاهدهای آن‌هاست
 * (توضیحِ هر مبلغ در فارسی پیش از خودش می‌آید). متنِ پیش از مبلغِ اول و پس از
 * مبلغِ آخر تا نشانهٔ جداکننده مالِ همان مبلغ است؛ آن‌سوی نشانه، و فاصلهٔ بی‌مرزِ
 * میان دو مبلغ، مشترک است: دوره‌ای که آن‌جا گفته شده صاحبِ روشنی ندارد.
 *
 * اجزای یک کل وقتی یک صاحب‌اند که با هم همان کل‌اند و ماهیتِ جدایی نمی‌گویند
 * («۳۰ میلیون اجاره ۶ ماه، ۱۰ نقد و ۲۰ از تجارت»): دورهٔ کل به هر دو می‌رسد. وقتی
 * ماهیت‌شان جداست («قبض برق ۲ میلیون و اجاره ۶ ماه … ۳۰ میلیون، جمعاً ۳۲») یا جمعشان
 * کل نیست («قرارداد یک ساله ۱۲۰ میلیون … اجاره این ماه ۱۰ میلیون دادیم»)، هر جزء
 * فقط بخشِ خودش را دارد و بخشِ کل مشترک است. وقتی جای مبلغی در متن پیدا نشد یا
 * دو مبلغ جایشان معلوم نیست، هیچ بخشی به کسی داده نمی‌شود.
 */
function amountScope(said, amount, amounts, retracted, natureOf = () => null) {
  // مبلغِ آینده یا شرطی هم بخشِ خودش را دارد: «اجارهٔ شش ماه آینده رو ماه بعد میدیم
  // و قبض ۲ میلیون دادیم» دورهٔ اجاره را به قبض نمی‌دهد. نرخ و قسط و ماندهٔ قبلی
  // زمینهٔ مبلغ دیگرند و بخشی از جمله را از آن جدا نمی‌کنند.
  const claims = (item) => item.accepted && item.status !== 'context' && !retracted.has(item.id)
    && !['unit-price', 'installment', 'prior-balance'].includes(item.role);
  const claimants = amounts.filter(claims);
  // کلی که خودش ثبت نمی‌شود هم مرز است: «قرارداد اجاره یک ساله ۱۲۰ میلیون بستیم
  // (زمینه)، … اجاره این ماه ۱۰ میلیون رو دادیم» — «یک ساله» مالِ قرارداد است، نه ۱۰ میلیون.
  const totals = amounts.filter((item) => item.accepted && !retracted.has(item.id)
    && (claimants.some((part) => part.partOf === item.id) || (item.role === 'total' && !claims(item))));
  const unknown = { alone: false, own: normalizePersian(amount.evidence || ''), shared: said, spans: [], owned: [] };
  if (claimants.length <= 1 && !totals.length) return { alone: true, own: said, shared: '' };
  const entries = [...new Set([...claimants, ...totals])].map((item) => ({ item, required: true }));
  const placed = placeAmounts(said, entries);
  if (!placed || !placed.has(amount.id)) return unknown;
  const located = entries.filter((entry) => placed.has(entry.item.id)).map((entry) => ({ item: entry.item, ...placed.get(entry.item.id) }))
    .sort((left, right) => left.start - right.start);
  // دور اول: هر جزء صاحبِ خودش، کلِ دارای جزء بی‌صاحب.
  const ownerOf = new Map(located.map(({ item }) => [item.id, totals.includes(item) ? null : item.id]));
  const textOf = (owners, id) => {
    const spans = located.map((span) => ({ ...span, owner: owners.get(span.item.id) }));
    const owned = sliceByOwner(said, spans);
    return spans.map((span, index) => (span.owner === id ? said.slice(owned[index].from, owned[index].to) : '')).filter(Boolean).join(' ');
  };
  for (const total of totals) {
    const parts = claimants.filter((part) => part.partOf === total.id && placed.has(part.id));
    const natures = new Set(parts.map((part) => natureOf(textOf(ownerOf, part.id))).filter(Boolean));
    const whole = parts.reduce((sum, part) => sum + (Number(part.value) || 0), 0) === Number(total.value);
    if (!whole || natures.size > 1) continue;
    for (const item of [total, ...parts]) ownerOf.set(item.id, total.id);
  }
  const mine = ownerOf.get(amount.id);
  if (!mine) return unknown;
  const spans = located.map((span) => ({ start: span.start, end: span.end, owner: ownerOf.get(span.item.id), mine: ownerOf.get(span.item.id) === mine }));
  if (spans.every((span) => span.mine)) return { alone: true, own: said, shared: '' };
  const owned = sliceByOwner(said, spans);
  const own = [];
  const claimed = new Array(said.length).fill(false);
  spans.forEach((span, index) => {
    if (!span.owner) return;
    for (let at = owned[index].from; at < owned[index].to; at += 1) claimed[at] = true;
    if (span.mine) own.push(said.slice(owned[index].from, owned[index].to));
  });
  const shared = said.split('').map((char, at) => (claimed[at] ? ' ' : char)).join('').replace(/\s+/g, ' ').trim();
  return { alone: false, own: own.join(' ').trim(), shared, spans, owned };
}

/** تاریخی که عبارتش درونِ بخشِ این مبلغ است: `true` مالِ همین، `false` مالِ دیگری، `null` نامعلوم. */
function dateInScope(said, date, scope) {
  if (scope.alone) return true;
  const key = normalizePersian(date?.expression || '').trim();
  const at = key ? said.indexOf(key) : -1;
  if (at < 0) return null;
  const index = scope.spans.findIndex((span, position) => at >= scope.owned[position].from && at + key.length <= scope.owned[position].to);
  return index < 0 ? null : scope.spans[index].mine;
}

/**
 * پایانِ دوره‌ای که آغاز و طولش گفته شده: همان روزِ ماه، N ماه شمسی جلوتر، منهای یک
 * روز — همان حسابِ مسیر قطعی («یک ساله») و گزینه‌های «شش ماه» و «یک سال».
 */
export function periodEndFrom(startIso, months) {
  if (!startIso || !(months > 0)) return null;
  const day = todayPersian(new Date(startIso));
  const total = (day.year * 12) + (day.month - 1) + months;
  const next = persianToISO(Math.floor(total / 12), (total % 12) + 1, Math.min(day.day, 28));
  return next ? new Date(Date.parse(next) - 86_400_000).toISOString() : null;
}

/**
 * طولِ دوره به ماه از شاهدِ «۶ ماه»، «یک سال»، «یکساله»، «پانزده ماه»، «بیست و
 * چهار ماه»، «یک سال و نیم».
 *
 * عددِ فارسی مرزِ واژه دارد: «پانزده» «ده» نیست و «بیست و چهار» «چهار» نیست —
 * وگرنه ۴۸ میلیونِ پشتیبانیِ ۲۴ ماهه در ۴ ماه هزینه می‌شد (بازبین موتور ۵). عددِ
 * مدل (`value`) فقط وقتی پذیرفته است که شاهد همان را بگوید؛ هر جا طول با اطمینان
 * خوانده نشد، صفر است و پایانِ دوره پرسیده می‌شود، نه حدس زده.
 */
const COUNT_WORDS = Object.freeze({
  یک: 1, یه: 1, دو: 2, سه: 3, چهار: 4, پنج: 5, شش: 6, شیش: 6, هفت: 7, هشت: 8, نه: 9, ده: 10,
  یازده: 11, دوازده: 12, سیزده: 13, چهارده: 14, پانزده: 15, پونزده: 15, شانزده: 16, شونزده: 16,
  هفده: 17, هیفده: 17, هجده: 18, هیجده: 18, نوزده: 19, بیست: 20, سی: 30, چهل: 40, پنجاه: 50,
  شصت: 60, هفتاد: 70, هشتاد: 80, نود: 90, صد: 100,
});
const NUMBER_WORD = `(?:${Object.keys(COUNT_WORDS).sort((a, b) => b.length - a.length).join('|')})`;
const LENGTH_SAID = new RegExp(`(?<![آ-ی0-9])([0-9]{1,3}|${NUMBER_WORD}(?:\\s+و\\s+${NUMBER_WORD})*)[\\s\\u200c]*(ماه|سال)ه?(?![آ-ی])(?:\\s+و\\s+(نیم|${NUMBER_WORD}[\\s\\u200c]*ماه)(?![آ-ی]))?`);
const countOf = (said) => (/^\d+$/.test(said) ? Number(said)
  : said.split(/\s+و\s+/).reduce((sum, word) => sum + (COUNT_WORDS[word.trim()] || Number.NaN), 0));

function monthsIn(evidence, claimed = null) {
  const text = normalizePersian(evidence || '').replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
  const matches = [...text.matchAll(new RegExp(LENGTH_SAID.source, 'g'))];
  // دو طول در یک شاهد («۶ ماه از یک سال») یعنی طولِ این دوره روشن نیست.
  if (matches.length !== 1) return 0;
  const [, number, unit, extra] = matches[0];
  const count = countOf(number);
  let months = unit === 'سال' ? count * 12 : count;
  if (extra === 'نیم') months += unit === 'سال' ? 6 : Number.NaN;
  else if (extra) months += countOf(extra.replace(/[\s‌]*ماه$/, ''));
  if (!Number.isInteger(months) || months <= 0 || months > 120) return 0;
  const value = Number(claimed);
  if (claimed != null && claimed !== '' && Number.isFinite(value) && value !== months && value !== count) return 0;
  return months;
}

function monthOf(iso) {
  const day = todayPersian(new Date(iso));
  return persianMonthRange(day.year, day.month);
}

function counterpartyFor(understanding, movement, amount) {
  const loan = ['loan-received', 'loan-repayment'].includes(understanding.event.kind);
  const pool = loan ? understanding.counterparties : understanding.counterparties.filter((item) => !bankName(item.name) && item.role !== 'bank');
  const named = (name) => name && pool.find((item) => item.name === name || name.includes(item.name) || item.name.includes(name));
  const side = movement ? (movement.direction === 'in' ? movement.from : movement.to) : null;
  const bySide = side?.name ? named(side.name) : null;
  if (bySide) return bySide;
  // «شرکت آفتاب ۶ میلیون واریز کرد … ۲ میلیون به شرکت پاکیزه دادیم»: وقتی جابه‌جایی
  // نامِ خاصی دارد که در فهرست نیست، تنها نامِ فهرست جایش نمی‌نشیند.
  if (side?.name && PARTY_TITLE.test(side.name)) return null;
  // شاهدهای همین پول: خودِ مبلغ، جابه‌جایی‌اش، و کل یا بدهیِ قبلی‌ای که این مبلغ
  // جزء آن است. «جلسه با حسابرس» در جملهٔ اضافی، طرف حسابِ پرداخت به قیاسی نیست.
  const parent = understanding.amounts.find((item) => item.id === amount?.partOf);
  const prior = understanding.amounts.find((item) => item.role === 'prior-balance');
  for (const evidence of [amount?.evidence, movement?.evidence, parent?.evidence, prior?.evidence]) {
    const matches = evidence ? pool.filter((item) => evidence.includes(item.name)) : [];
    if (matches.length === 1) return matches[0];
  }
  return pool.length === 1 ? pool[0] : null;
}

/**
 * نقشهٔ پرونده.
 *
 * `resolution` را سرور می‌سازد:
 *
 * - `counterparties[id]`: `{ contactId, name, status: exact|similar|new|none, candidates, balance }`
 * - `endpoints['<movement>.from'|'<movement>.to']`: `{ accountId, label, status }`
 * - `accounts`: حساب‌های فعال برای گزینه‌های سؤال
 *
 * خروجی: اجزای قابل ثبت، یادداشت‌هایی که سند نمی‌سازند، سؤال‌ها، و مسیر پرونده.
 */
export function buildUnderstandingPlan(understanding, { resolution = {}, answers = {}, transcript = '', source = 'text', now = new Date() } = {}) {
  const facts = applyUnderstandingAnswers(understanding, answers);
  const components = [];
  const notes = [];
  const questions = [];
  const reasons = [];
  const accountantReasons = [];
  const question = (entry) => {
    if (answers[entry.id] && !entry.reopen) return;
    if (!questions.some((item) => item.id === entry.id)) questions.push(entry);
  };
  const toAccountant = (reason) => { if (!accountantReasons.includes(reason)) accountantReasons.push(reason); };

  // ابهام‌های اعتبارسنجی و مدل: اطلاعاتی پرسیده می‌شود، قضاوتی به حسابدار.
  for (const ambiguity of facts.ambiguities || []) {
    if (answers[ambiguity.field]) continue;
    // سؤال‌های خودِ مدل یادداشت پرونده‌اند، نه مانع ثبت.
    //
    // آزمون زندهٔ ۱۷ مهر ۱۴۰۵: مدل برای جمله‌هایی که همه‌چیزشان روشن بود
    // می‌پرسید «واحد پول؟»، «مقایسهٔ قیمت؟»، «مدت پوشش؟» و ثبت را معطل می‌کرد.
    // اختیار توقف با اعتبارسنجی سرور، نقشه و موتور قاعده است — همان‌ها که مبلغِ
    // نامعلوم، حساب، تاریخ پرداخت، طرف حساب، سند تسویه و کاربرد کالا را خودشان
    // می‌پرسند — نه با برداشت آماری مدل از «چه چیزی مبهم است».
    if (ambiguity.source === 'model') { notes.push({ kind: 'model-note', text: ambiguity.question }); continue; }
    if (ambiguity.kind === 'judgment') { toAccountant(ambiguity.question); continue; }
    const amountValue = /^amounts\.[^.]+\.(?:value|parts)$/.test(ambiguity.field);
    const scale = /^amounts\.[^.]+\.scale$/.test(ambiguity.field);
    const movementDone = /^movements\.[^.]+\.done$/.test(ambiguity.field);
    const dateField = /^dates\./.test(ambiguity.field);
    const subjectUse = ambiguity.field === 'subject.use';
    // مقدارِ این پاسخ‌ها قطعی اعمال می‌شود. ابهامی که هیچ‌کدام از این‌ها نیست
    // جوابِ آزاد می‌گیرد و پرونده با آن جواب یک بار دیگر خوانده می‌شود.
    question({
      id: ambiguity.field, kind: 'information', text: ambiguity.question,
      picker: amountValue ? 'amount' : dateField ? 'date' : scale || movementDone || subjectUse ? 'options' : 'text',
      options: scale ? [{ value: 'yes', label: 'بله' }, { value: 'no', label: 'نه، مبلغ دیگری است' }]
        : movementDone ? [{ value: 'done', label: 'انجام شده' }, { value: 'not-yet', label: 'هنوز انجام نشده' }]
          : subjectUse ? [{ value: 'internal', label: 'مصرف خود شرکت' }, { value: 'resale', label: 'برای فروش' }, { value: 'production', label: 'مواد تولید' }, { value: 'long-term', label: 'استفادهٔ چندساله' }]
            : [],
      needsReread: !(amountValue || scale || movementDone || dateField || subjectUse),
    });
  }

  const kindReason = ACCOUNTANT_KINDS[facts.event.kind];
  if (kindReason) toAccountant(kindReason);
  // هر نوعی که مدل گفته باشد: چکِ وصول‌نشده پول نیست، واریزِ بی‌نام درآمد نیست، و
  // اظهارنامه و تهاتر مالیات قضاوت است. آزمون زنده: «چک ۲۵ میلیونی از آقای نادری
  // گرفتیم» پرسید «پول به کدام حساب آمد؟» و با جوابش دریافت وجه ثبت می‌شد.
  const said = normalizePersian(transcript || '');
  if (CHEQUE_CUE.test(said) && !CHEQUE_CLEARED.test(said)) toAccountant(ACCOUNTANT_KINDS.cheque);
  if (UNIDENTIFIED_DEPOSIT.test(said)) toAccountant('واریزِ بی‌نام یا مشکوک درآمد نیست؛ تا شناختنِ واریزکننده، ثبتش با حسابدار است.');
  if (TAX_RETURN.test(said)) toAccountant('اظهارنامه و تهاتر مالیات با حسابدار است.');
  // آزمون زنده با پاسخِ سادهٔ «کدام حساب»: «بعداً می‌گم چی بود» هزینهٔ بی‌بابت شد،
  // بیمهٔ تأمین اجتماعی هزینه شد، «سرمایه از ۵۰۰ به یک میلیارد» یک میلیارد سرمایه
  // شد، و پولِ سهامدار سرمایه و برداشتِ شریک برداشتِ مالک.
  if (PURPOSE_UNSAID.test(said)) toAccountant('بابتِ این پول گفته نشده؛ بی‌بابت سندی ساخته نمی‌شود.');
  if (PAYROLL_CUE.test(said)) toAccountant(ACCOUNTANT_KINDS.payroll);
  if (CAPITAL_CHANGE.test(said)) toAccountant('تغییرِ سرمایهٔ ثبت‌شده سند حقوقی دارد و مبلغش تفاوتِ دو عدد است؛ با حسابدار است.');
  // بدهیِ شرکت که شریک از پول شخصی‌اش داد مسیر خودش را دارد (پایین)؛ بقیهٔ
  // جابه‌جایی‌های جاری شریک همچنان با حسابدار است.
  // پولِ شخصی را خودِ جمله می‌گوید، نه فقط برچسب مدل. مدل «ماشین شخصی‌اش را
  // فروخت و بدهی را داد» را گاهی «تسویه» یا «خرید» می‌نامد و آن‌وقت حساب شرکت
  // پرسیده می‌شد. همان تشخیص قطعیِ مسیر کارت این‌جا هم داور است.
  const partnerPaid = facts.event.kind === 'paid-by-partner' || Boolean(detectPartnerPaidDebt(said)) || Boolean(detectPartnerFundedSpend(said));
  if (PARTNER_CUE.test(said) && !partnerPaid && !/افزایش\s*سرمایه/.test(said)) toAccountant('حساب جاری شریک یا سهامدار با حسابدار است.');
  if (ADJUSTING_CUE.test(said)) toAccountant('ثبتِ تعدیلیِ پایان دوره (ذخیره یا سودِ تحقق‌یافته) قضاوت حسابدار است.');
  // «آقای سعیدی ۸ میلیون ... برای خرج شخصی خودش برداشت»: برداشتِ شخصیِ کسی که با نام
  // گفته شده — نه «خودم» — مالکِ دفتر است یا شریک. «برداشت مالک» نوشتنِ بی‌قضاوت، طلبِ
  // شرکت از شریک را گم می‌کرد (آزمون ۱۰۰ سناریو، R042).
  const drawing = facts.event.kind === 'owner-drawing' || paymentPurposeFromSpeech(said) === 'owner-drawing';
  const namedDrawer = facts.counterparties.find((item) => PARTY_TITLE.test(item.name) && !bankName(item.name));
  if (drawing && namedDrawer && !FIRST_PERSON_DRAWING.test(said)) {
    toAccountant(`برداشتِ شخصیِ «${namedDrawer.name}»: مالکِ دفتر است یا شریک (جاری شریک)؟ تشخیصش با حسابدار است.`);
  }
  // «پروژهٔ شرکت آریا تجارت ... تموم شد و تحویل دادیم»: کار تحویل شد و مبلغی گفته نشد.
  // بستنِ بی‌سند یعنی پیش‌دریافتِ همان مشتری هرگز درآمد نمی‌شد (R060).
  if (!facts.amounts.length && ['income', 'sale'].includes(facts.event.kind) && facts.subject.delivered === 'yes'
    && facts.counterparties.some((item) => !bankName(item.name))) {
    toAccountant('کار یا کالا تحویل شد ولی مبلغی گفته نشد؛ اگر پیش‌دریافتی از این مشتری هست، شناسایی درآمدش با حسابدار است.');
  }
  // «باقی حق بیمه ۹ میلیون رو دادیم»، «قسط دوم اجاره»: پرداختِ بعدیِ قراردادی که
  // پیش‌تر ثبت شده. پیش‌پرداختِ تازه با دورهٔ تازه نیست (دفتر برای یک بیمه‌نامهٔ ۱۲
  // میلیونی ۲۱ میلیون پیش‌پرداخت نشان می‌داد) و قسط وام هم نیست. وقتی مدل خودش
  // تسویه نگفته — که روی سند باز می‌نشیند — کدام سند را می‌بندد، با حسابدار است.
  if (CONTRACT_REMAINDER.test(said) && facts.event.kind !== 'settlement') {
    toAccountant('این پول قسط یا باقیِ یک قرارداد موجود (بیمه، اجاره، اشتراک) است؛ بستنش روی کدام سند یا بدهی، با حسابدار است — نه پیش‌پرداخت تازه، نه قسط وام.');
  }
  // «۱۲ میلیون، نه ببخشید ۱۵»: اصلاحِ همان گفته است، نه اصلاح یک ثبت قبلی.
  // مبلغِ پس‌گرفته‌شده کنار می‌رود و یادداشت می‌شود؛ اصلاح سند قبلی (نوع رویداد
  // `correction`) همچنان با حسابدار است.
  const retracted = new Set((facts.conditions || []).filter((condition) => condition.kind === 'correction').flatMap((condition) => condition.affects));

  const occurredAt = dateFor(facts, ['payment', 'occurrence']);
  const coverageStart = dateFor(facts, ['coverage-start']);
  const coverageEnd = dateFor(facts, ['coverage-end']);
  // «تحویل دادیم» بی‌تاریخ یعنی همین امروز تحویل شد: زمان شناسایی درآمد فروشِ نسیه.
  const deliveryDate = dateFor(facts, ['delivery']);
  const dueAt = dateFor(facts, ['due']);
  // «امروز» نگفتن یعنی امروز — همان قاعدهٔ پارسر. نقش هر تاریخ این‌جا صریح است،
  // پس شروع پوشش یا سررسید هیچ‌وقت جای تاریخ پرداخت نمی‌نشیند و دلیلی برای
  // پرسیدن نیست. فقط وقتی پرسیده می‌شود که روز پرداخت گفته شده ولی خوانده نشد.
  const unresolvedPaymentDate = facts.dates.some((date) => !date.accepted && ['payment', 'occurrence'].includes(date.role));
  if (!occurredAt && unresolvedPaymentDate && !answers['dates.payment']) {
    question({ id: 'dates.payment', kind: 'information', text: 'پول در چه تاریخی پرداخت یا دریافت شد؟ تاریخ پوشش یا تحویل جای آن نیست.', picker: 'date', options: [] });
  }
  const paymentDate = occurredAt || (unresolvedPaymentDate ? null : new Date(now).toISOString());

  const amounts = facts.amounts;
  // ماندهٔ پرداخت‌نشدهٔ یک خرید یا فروشِ انجام‌شده، طلب یا بدهیِ همین امروز است.
  //
  // آزمون زنده: در «۶۰ میلیون فروختیم و تحویل دادیم، ۲۵ واریز شد، بقیه آخر ماه»
  // مدل ۳۵ را «پرداخت آینده» نامید — درست از نظر زمانِ پول — و فقط ۲۵ ثبت شد؛
  // طلبِ ۳۵ و درآمدش گم شد. کالا تحویل شده، پس طلب امروز هست؛ آینده فقط
  // دریافتش است. مانده از اعداد صریح محاسبه می‌شود — کل منهای پرداخت‌شده.
  if (['purchase', 'sale', 'asset-purchase'].includes(facts.event.kind) && facts.subject.delivered !== 'no') {
    for (const total of amounts.filter((item) => item.accepted && item.role === 'total' && item.status === 'done' && !retracted.has(item.id))) {
      const parts = amounts.filter((item) => item.partOf === total.id && item.accepted && !retracted.has(item.id));
      const paid = parts.filter((item) => item.status === 'done' && SPLIT_ROLES.has(item.role));
      if (!paid.length) continue;
      const remainder = total.value - paid.reduce((sum, item) => sum + item.value, 0);
      if (remainder <= 0) continue;
      const pending = parts.find((item) => item.role === 'future-payment' && item.value === remainder);
      if (pending) Object.assign(pending, { role: 'credit-part', status: 'done' });
      else amounts.push({ id: `${total.id}-remainder`, value: remainder, role: 'credit-part', status: 'done', partOf: total.id, accepted: true, provenance: 'computed-remainder', evidence: total.evidence });
    }
  }
  const byId = new Map(amounts.map((amount) => [amount.id, amount]));
  const movementOf = (id) => facts.movements.find((movement) => movement.amountRef === id) || null;
  const priorBalance = amounts.find((amount) => amount.role === 'prior-balance');

  // پول شخصی دو شکل دارد: بستن طلب یا بدهیِ موجود (کارت تسویه)، یا هزینه و خریدی
  // که همان مسیر عادی را می‌رود و فقط منبع پولش جاری شریک یا پرداختنیِ کارمند است.
  const funder = partnerPaid ? fundingOf(facts, said) : null;
  if (partnerPaid && !funder) planPartnerPaid({ facts, said, amounts, retracted, resolution, answers, paymentDate, components, notes, question, toAccountant });

  for (const amount of partnerPaid && !funder ? [] : amounts) {
    const label = amount.evidence || amount.role;
    if (retracted.has(amount.id)) { notes.push({ amountRef: amount.id, kind: 'retracted', text: `«${label}» در همان گفته اصلاح شد و کنار گذاشته شد.` }); continue; }
    if (amount.status === 'context') {
      if (amount.role === 'prior-balance' && amount.accepted) notes.push({ amountRef: amount.id, kind: 'context', text: `${money(amount.value)} تومان بدهی یا طلبِ قبلی است؛ دوباره ثبت نمی‌شود.` });
      continue;
    }
    if (amount.status === 'future') { notes.push({ amountRef: amount.id, kind: 'future', text: `«${label}» هنوز انجام نشده؛ تا انجام نشود سندی ندارد.` }); continue; }
    if (amount.status === 'conditional') { notes.push({ amountRef: amount.id, kind: 'conditional', text: `«${label}» مشروط است؛ تا شرطش محقق نشود شناسایی نمی‌شود.` }); continue; }
    if (!amount.accepted) continue; // سؤالش بالا ساخته شده است.
    if (amount.role === 'unit-price' || amount.role === 'installment') { notes.push({ amountRef: amount.id, kind: 'context', text: `«${label}» نرخ یا قسط است، نه مبلغ همین سند.` }); continue; }

    // کلی که اجزای انجام‌شده دارد، از راه اجزایش ثبت می‌شود.
    // فقط جزءِ پذیرفته‌شده جای کل را می‌گیرد؛ جزءِ کنارگذاشته (تکرار یا بی‌عدد)
    // نباید کل را از ثبت بیندازد.
    const doneParts = amounts.filter((part) => part.partOf === amount.id && part.accepted && !retracted.has(part.id) && part.status === 'done' && SPLIT_ROLES.has(part.role));
    if (doneParts.length) { notes.push({ amountRef: amount.id, kind: 'total', text: `جمع کل ${money(amount.value)} تومان؛ اجزایش جداگانه ثبت می‌شوند.` }); continue; }
    if (amount.partOf && JUDGMENT_PART_ROLES.has(amount.role)) {
      toAccountant(`«${label}» بخشی از یک مبلغ کل است (مالیات، تخفیف یا سود)؛ تفکیکش با حسابدار است.`);
      continue;
    }

    let movement = movementOf(amount.id);
    // نسیه یعنی پولی جابه‌جا نشده، حتی اگر مدل جابه‌جایی گفته باشد.
    if (amount.role === 'credit-part') movement = { id: `${amount.id}-credit`, amountRef: amount.id, direction: 'none', from: { kind: 'unknown', name: null }, to: { kind: 'unknown', name: null } };
    // «۴۰ میلیون از ملت دادیم: ۳۰ میلیون بیمه … و ۱۰ میلیون اجاره …»: جزءِ بی‌جابه‌جایی
    // از همان حسابی رفته که کلش رفت؛ پرسیدن حساب برای هر جزء، سؤالی بود که جمله جواب داده
    // بود (آزمون زندهٔ موتور ۵، ۲۲ مهر ۱۴۰۵).
    if (!movement && amount.partOf) {
      const whole = movementOf(amount.partOf);
      if (whole && ['in', 'out'].includes(whole.direction)) movement = whole;
    }
    if (!movement) {
      // بخش نقدیِ یک خرید یا فروش جهتش از خودِ رویداد معلوم است؛ فقط حسابش پرسیده می‌شود.
      const implied = ['purchase', 'asset-purchase', 'expense', 'advance-paid', 'deposit', 'owner-drawing'].includes(facts.event.kind) ? 'out'
        : ['sale', 'income', 'advance-received', 'loan-received', 'capital-in'].includes(facts.event.kind) ? 'in' : null;
      if (!implied) {
        question({ id: `movements.${amount.id}-implied.done`, kind: 'information', text: `برای «${label}» پولی دریافت یا پرداخت شد؟`, picker: 'options',
          options: [{ value: 'done', label: 'بله' }, { value: 'not-yet', label: 'نه، هنوز نه' }] });
        continue;
      }
      movement = { id: `${amount.id}-implied`, amountRef: amount.id, direction: implied, from: { kind: 'unknown', name: null }, to: { kind: 'unknown', name: null } };
    }
    // «قبض تلفن دفتر رو خانم کریمی از جیب خودش داد»: مدل درست گفت از حساب شرکت پولی
    // نرفت، و همین ردیف را بدهیِ بی‌نامِ پرداخت‌نشده کرد. پرداخت انجام شده — از جیب او؛
    // هزینه همان است و جای سطر نقد را جاری او می‌گیرد (`fundedBy`، آزمون ۱۰۰ سناریو، R043).
    if (funder && movement.direction === 'none' && amount.role !== 'credit-part' && !['sale', 'income', 'advance-received'].includes(facts.event.kind)) {
      movement = { ...movement, direction: 'out' };
    }

    if (movement.direction === 'transfer') {
      const from = resolution.endpoints?.[`${movement.id}.from`];
      const to = resolution.endpoints?.[`${movement.id}.to`];
      for (const [side, endpoint] of [['from', from], ['to', to]]) {
        const answered = answers[`movements.${movement.id}.${side}`]?.valueId;
        if (answered) endpoint && Object.assign(endpoint, { accountId: answered, status: 'resolved' });
        if (!answered && !endpoint?.accountId) question({ id: `movements.${movement.id}.${side}`, kind: 'information', text: side === 'from' ? 'پول از کدام حساب رفت؟' : 'پول به کدام حساب رفت؟', picker: 'account', options: [] });
      }
      const fromId = answers[`movements.${movement.id}.from`]?.valueId || from?.accountId;
      const toId = answers[`movements.${movement.id}.to`]?.valueId || to?.accountId;
      if (fromId && toId && fromId !== toId) {
        components.push({ id: amount.id, amountRef: amount.id, kind: 'transfer', amount: amount.value, fromAccountId: fromId, toAccountId: toId,
          occurredAt: paymentDate, label: `انتقال ${money(amount.value)} تومان بین حساب‌های خود شرکت`, item: null });
      }
      continue;
    }

    const counterparty = counterpartyFor(facts, movement, amount);
    const resolved = counterparty ? resolution.counterparties?.[counterparty.id] : null;
    const pickedContact = counterparty ? answers[`counterparties.${counterparty.id}`]?.valueId : null;
    const contactId = pickedContact && pickedContact !== 'new' ? pickedContact : resolved?.status === 'exact' ? resolved.contactId : null;
    // نقشِ بی‌نام («تعمیرکار»، «مشتری») طرف حسابِ تازه نمی‌سازد؛ نامش پرسیده می‌شود.
    // استثنا: اجاره یا خدمتِ دوره‌داری که پولش آمد یا رفت ماه‌به‌ماه خودکار شناسایی می‌شود و
    // تسویه‌ای با آن شخص ندارد («مستاجر اجارهٔ ۶ ماه رو جلو داد» — آزمون‌های موتور ۵). ودیعه،
    // بدهی، طلب و پیش‌دریافتِ پروژه با همان شخص بسته می‌شوند و نام می‌خواهند.
    const recognisedOverTime = movement.direction !== 'none' && !REFUNDABLE_WORDS.test(said)
      && (TIME_BOUND_SERVICE_CATEGORIES.includes(facts.subject.category) || /اجاره|کرایه/.test(said));
    const unnamed = Boolean(counterparty) && !contactId && genericParty(counterparty.name) && !recognisedOverTime;
    const createContact = !unnamed && (pickedContact === 'new' || (resolved?.status === 'new' && Boolean(counterparty)));

    // پرداخت به کسی یا دریافت از کسی که بدهی یا طلبِ باز دارد: «۳ میلیون آقای رضایی بابت
    // تعمیر کولر رو ... دادیم» بعد از بدهیِ همان تعمیر. ثبتش به‌عنوان هزینه، هزینه را دو
    // بار ثبت می‌کرد (آزمون ۱۰۰ سناریو، R037). حدس زده نمی‌شود: می‌پرسد تسویهٔ کدام سند
    // است یا رویدادِ تازه.
    const flowSide = movement.direction === 'out' ? 'payable' : movement.direction === 'in' ? 'receivable' : null;
    const openForParty = contactId && flowSide
      ? (resolution.documents?.[contactId] || []).filter((document) => document.direction === flowSide && ['obligation', 'invoice', 'ledger-balance'].includes(document.kind) && document.remaining > 0)
      : [];
    const settleChoice = answers[`settlements.${amount.id}`]?.valueId;
    const explicitSettlement = facts.event.kind === 'settlement' || (priorBalance && ['paid-now', 'received-now', 'part'].includes(amount.role));
    if (!explicitSettlement && openForParty.length && !settleChoice && !funder) {
      question({
        id: `settlements.${amount.id}`, kind: 'information', picker: 'document',
        text: `«${counterparty.name}» ${flowSide === 'payable' ? 'بدهیِ' : 'طلبِ'} باز دارد. این ${money(amount.value)} تومان تسویهٔ کدام است؟`,
        options: [...openForParty.map((document) => ({ value: document.id, label: `${document.reference} — مانده ${money(document.remaining)} تومان` })),
          { value: 'new', label: flowSide === 'payable' ? 'هیچ‌کدام؛ هزینه یا خریدِ تازه است' : 'هیچ‌کدام؛ فروش یا درآمدِ تازه است' }],
      });
      continue;
    }
    // «قبض برق مهر که اومده بود رو امروز ... پرداخت کردیم»: پرداختِ سندی که پیش‌تر آمده و
    // ثبت شده — بی‌طرف‌حسابی که بدهی‌اش را پیدا کند. هزینهٔ تازه نوشتنش بدهیِ قبض را باز
    // می‌گذاشت و هزینه را دو بار ثبت می‌کرد (R035، پس از ثبتِ بدهیِ R025). کدام بدهی، با حسابدار.
    if (!explicitSettlement && !openForParty.length && !funder && movement.direction === 'out' && PRIOR_DOCUMENT.test(said) && !settleChoice) {
      toAccountant(`«${label}» پرداختِ قبض یا فاکتوری است که پیش‌تر آمده بود؛ تسویهٔ کدام بدهیِ ثبت‌شده است، با حسابدار است — هزینهٔ تازه نیست.`);
      continue;
    }
    const isSettlement = movement.direction !== 'none' && (explicitSettlement || Boolean(settleChoice && settleChoice !== 'new' && openForParty.length));
    // تسویه و پیش‌پرداخت و وام بدون طرف حساب معنا ندارند. تعهدِ بی‌نام — «قبض
    // برق اومده» — همان مسیر امروز را می‌رود: اگر موتور طرف حساب بخواهد، خودش می‌پرسد.
    const needsCounterparty = isSettlement || (movement.direction === 'none' && Boolean(counterparty)) || ['advance-paid', 'advance-received', 'deposit', 'loan-received'].includes(facts.event.kind);
    if (needsCounterparty && unnamed && !isSettlement && !answers[`counterparties.${counterparty.id}.name`]) {
      question({
        id: `counterparties.${counterparty.id}.name`, kind: 'information', picker: 'text', needsReread: false,
        text: `«${counterparty.name}» نام طرف حساب نیست؛ ${movement.direction === 'none' ? 'این بدهی یا طلب' : 'این پول'} به نامِ چه کسی یا چه شرکتی ثبت شود؟`,
      });
      continue;
    }
    if (needsCounterparty && counterparty && !contactId && !(createContact && !isSettlement) && !answers[`counterparties.${counterparty.id}`]) {
      question({
        id: `counterparties.${counterparty.id}`, kind: 'information', picker: 'contact',
        text: resolved?.status === 'similar' ? `«${counterparty.name}» همان «${resolved.candidates?.[0]?.name}» است؟` : `«${counterparty.name}» کدام طرف حساب است؟`,
        options: [...(resolved?.candidates || []).map((item) => ({ value: item.id, label: item.name })), ...(isSettlement ? [] : [{ value: 'new', label: `طرف حساب تازه: ${counterparty.name}` }])],
      });
      continue;
    }
    // تسویه بدون طرف حساب معنا ندارد. وام و پیش‌پرداختِ بی‌نام از همان مسیر
    // همیشگی می‌روند؛ اگر موتور طرف حساب بخواهد، خودش از ثبت‌کننده می‌پرسد.
    if (isSettlement && !counterparty) {
      toAccountant(`برای «${label}» طرف حساب در جمله نیست؛ تسویه بدون طرف حساب ثبت نمی‌شود.`);
      continue;
    }

    if (isSettlement) {
      const direction = movement.direction === 'out' ? 'payable' : 'receivable';
      // تسویه همیشه روی یک سند باز می‌نشیند — همان قاعدهٔ کارت «تسویه». بدهیِ
      // ثبت‌نشده را این پرونده نمی‌سازد و از ماندهٔ خالی حدس نمی‌زند؛ آن قضاوت
      // حسابدار است.
      const documents = (resolution.documents?.[contactId] || [])
        .filter((document) => document.direction === direction && ['obligation', 'invoice', 'ledger-balance'].includes(document.kind) && document.remaining > 0);
      const pickedDocument = answers[`settlements.${amount.id}`]?.valueId;
      const target = pickedDocument ? documents.find((document) => document.id === pickedDocument) : documents.length === 1 ? documents[0] : null;
      if (!documents.length) {
        toAccountant(`${direction === 'payable' ? 'بدهیِ' : 'طلبِ'} باز «${counterparty.name}» در دفتر پیدا نشد؛ این پول بدون سند مبنا، تسویه یا هزینه بودنش با حسابدار است.`);
        continue;
      }
      if (!target) {
        question({
          id: `settlements.${amount.id}`, kind: 'information', picker: 'document',
          text: `این ${money(amount.value)} تومان بابت کدام ${direction === 'payable' ? 'بدهی' : 'طلب'} «${counterparty.name}» است؟`,
          options: documents.map((document) => ({ value: document.id, label: `${document.reference} — مانده ${money(document.remaining)} تومان` })),
        });
        continue;
      }
      if (target.remaining < amount.value) {
        toAccountant(`ماندهٔ «${target.reference}» (${money(target.remaining)} تومان) از مبلغ این پرداخت کمتر است.`);
        continue;
      }
      const totalOpen = documents.reduce((sum, document) => sum + document.remaining, 0);
      if (priorBalance?.accepted && priorBalance.value !== totalOpen) {
        notes.push({ amountRef: priorBalance.id, kind: 'warning', text: `جمله ${money(priorBalance.value)} تومان گفته ولی ماندهٔ باز در دفتر ${money(totalOpen)} تومان است؛ فقط پرداخت امروز ثبت می‌شود.` });
      }
      const endpoint = resolution.endpoints?.[`${movement.id}.${movement.direction === 'in' ? 'to' : 'from'}`];
      const accountId = answers[`movements.${movement.id}.account`]?.valueId || endpoint?.accountId || null;
      if (!accountId) {
        question({ id: `movements.${movement.id}.account`, kind: 'information', picker: 'account', options: [],
          text: `پول ${direction === 'receivable' ? 'به' : 'از'} کدام حساب ${direction === 'receivable' ? 'آمد' : 'رفت'}؟` });
        continue;
      }
      components.push({
        id: amount.id, amountRef: amount.id, kind: 'settlement', amount: amount.value, accountId, contactId, occurredAt: paymentDate,
        target: { kind: target.kind, id: target.id, reference: target.reference, remaining: target.remaining }, direction, item: null,
        label: `${direction === 'payable' ? 'پرداخت' : 'دریافت'} ${money(amount.value)} تومان ${direction === 'payable' ? 'به' : 'از'} ${counterparty.name} — تسویهٔ «${target.reference}»`,
      });
      continue;
    }

    const type = movement.direction === 'in' ? 'income' : movement.direction === 'out' ? 'expense'
      : ['sale', 'income', 'advance-received'].includes(facts.event.kind) ? 'income' : 'expense';
    // کارمزد خودش هزینهٔ جاری است، هر رویدادی که کنارش آمده باشد.
    // «قرارداد پشتیبانی سه‌ماهه بستیم و کل مبلغش را از اول واریز کرد»: پولِ خدمتی که
    // هنوز انجام نشده پیش‌دریافت است، نه درآمد. آزمون زنده (V13): ۹ میلیون یک‌جا
    // درآمد شد. دوره همان قاعدهٔ هزینه را دارد: «یک‌ساله» از روز دریافت؛ وقتی گفته
    // نشده، آغاز و پایانش پرسیده می‌شود (`timeBound`) — نه پیش‌دریافتی که هرگز درآمد نشود.
    const serviceUpfront = type === 'income' && facts.subject.kind === 'service' && !coverageStart
      && (facts.nonAmountNumbers || []).some((item) => item.role === 'duration') && UPFRONT.test(said) && !SERVICE_DONE.test(said);
    // «۳۰ میلیون ودیعه … ۶ میلیون اجارهٔ همین ماه»: ماهیتِ هر مبلغ از شاهدِ خودش.
    // نوعِ کل رویداد («ودیعه») به هر دو می‌رسید و اجاره ودیعه می‌شد؛ در گفتهٔ
    // دیگری ودیعه اجاره می‌شد (آزمون بازبین و گزارش مالک محصول، مهر ۱۴۰۵).
    const own = normalizePersian(amount.evidence || '');
    const clause = clauseOf(said, amount.evidence);
    const scope = amountScope(said, amount, amounts, retracted, (part) => (part ? (classifyCategory(part, type).matched ? classifyCategory(part, type).category : null) : null));
    // برچسب «ودیعه»ی مدل به‌تنهایی کافی نیست: «پیش‌پرداخت بیمه … ۱۲ میلیون» را مدل
    // «ودیعه» نامید و ۱۲ میلیون ودیعهٔ قابل استرداد شد (۱۸ مهر ۱۴۰۵). ودیعه یعنی
    // پولی که برمی‌گردد و جمله باید خودش این را بگوید؛ «پیش‌پرداخت» بر برچسب مقدم است.
    //
    // نگاه به کل جمله فقط وقتی است که شاهدِ خودِ مبلغ ماهیتی نگفته: در «۳۰ میلیون
    // رهن و ۶ میلیون اجاره مهر» برچسب «ودیعه» روی ۶ میلیونِ اجاره، رهنِ مبلغ دیگر
    // را قرض می‌گرفت و اجارهٔ مهر هرگز هزینه نمی‌شد.
    // «پول پیش»ِ ملک همان ودیعه است (`mentionsPropertyDeposit`، مشترک با مسیر قطعی).
    const depositWord = (part) => REFUNDABLE_WORDS.test(part) || mentionsPropertyDeposit(part);
    // «پول پیش انبار ۸۰ میلیون … دادیم»: مدل شاهدِ مبلغ را فقط «۸۰ میلیون» نوشت؛ نامِ
    // ودیعهٔ ملک در بندِ خودِ همین مبلغ است وقتی بند پرداخت دیگری ندارد.
    const soleInClause = amounts.filter((other) => other.accepted && !retracted.has(other.id) && other.status === 'done'
      && clauseOf(said, other.evidence) === clause).length <= 1;
    const refundableHere = depositWord(own)
      || (soleInClause && mentionsPropertyDeposit(clause) && !classifyCategory(own, 'expense').matched)
      || (amount.role === 'deposit' && depositWord(said) && !ADVANCE_WORDS.test(own) && !classifyCategory(own, 'expense').matched);
    if (type === 'expense' && movement.direction !== 'none' && DEPOSIT_AND_SERVICE.test(own)) {
      toAccountant(`«${label}» هم ودیعه است و هم اجاره یا هزینهٔ دوره؛ سهم هر کدام گفته نشده و تفکیکش با حسابدار است.`);
      continue;
    }
    if (type === 'income' && movement.direction !== 'none' && (DEPOSIT_IN_WORDS.test(own) || (DEPOSIT_IN_WORDS.test(clause) && !classifyCategory(own, 'income').matched))) {
      toAccountant(`«${label}» ودیعه یا رهن است، نه درآمد: یا بدهیِ برگشت‌پذیر به پرداخت‌کننده است یا ودیعهٔ قبلیِ ما که برگشته؛ ثبتش در حساب ودیعه با حسابدار است.`);
      continue;
    }
    // اینکه پول برمی‌گردد یا مصرف می‌شود، همان قاعدهٔ مسیر قطعی است (`saysRefundable`):
    // «آخر قرارداد پس می‌گیریم»، یا نامِ ودیعه، رهن و پول پیشِ ملک (تصمیم مالک محصول،
    // ۲۲ مهر ۱۴۰۵). «سپرده» و «تضمین» و ودیعه‌ای که از اجاره کم می‌شود همچنان پرسیده
    // می‌شوند. برچسب «ودیعه»ی مدل بی این واژه‌ها در شاهدِ خودِ مبلغ، ودیعه نمی‌سازد.
    const returns = saysRefundable(clause || own);
    const advanceHere = ADVANCE_WORDS.test(own) || (ADVANCE_WORDS.test(clause) && !REFUNDABLE_WORDS.test(clause))
      || (ADVANCE_WORDS.test(said) && !REFUNDABLE_WORDS.test(said) && amounts.filter((item) => item.accepted && item.status === 'done' && !retracted.has(item.id)).length === 1);
    const depositSibling = amounts.some((other) => other !== amount && other.accepted && other.partOf === amount.partOf
      && (other.role === 'deposit' || REFUNDABLE_WORDS.test(normalizePersian(other.evidence || ''))));
    let purposes = amount.role === 'fee' ? { paymentPurpose: 'expense' }
      : type === 'expense' && refundableHere ? (typeof returns === 'boolean' ? { paymentPurpose: 'deposit', refundable: returns } : { paymentPurpose: 'deposit' })
        : advanceHere ? (type === 'expense' ? { paymentPurpose: 'advance' } : { receiptPurpose: 'advance' })
          : serviceUpfront ? { receiptPurpose: 'advance' }
            : type === 'expense' && depositSibling ? { paymentPurpose: 'expense', refundable: false }
              // نوعِ رویداد برای کل گفته است: «بیمهٔ یک‌ساله ۱۲ میلیون و ناهار پرسنل ۲ میلیون» را
              // مدل «پیش‌پرداخت» نامید و ناهار پیش‌پرداخت خرید شد که طرف حسابش پرسیده می‌شد.
              // در گفتهٔ چندمبلغی، پیش‌پرداخت و ودیعه فقط از بخشِ خودِ مبلغ می‌آیند (بالا).
              : !scope.alone && PER_AMOUNT_KINDS.has(facts.event.kind) ? {}
                : PURPOSE_BY_KIND[facts.event.kind] || {};
    // همان داورِ قطعیِ مسیر فعلی (`moneyPurpose`): «مساعده» طلب از کارمند است، نه پیش‌پرداختِ
    // خرید (R065)؛ واریزی که «نمی‌دونم از کیه» وجوهِ تعیین‌تکلیف‌نشده است، نه درآمد (R089).
    const spokenScope = scope.alone ? said : `${scope.own} ${clause}`;
    if (type === 'expense' && paymentPurposeFromSpeech(spokenScope) === 'employee-advance') purposes = { paymentPurpose: 'employee-advance' };
    if (type === 'income' && receiptPurposeFromSpeech(spokenScope) === 'unknown') purposes = { receiptPurpose: 'unknown' };
    // «کلید سوختهٔ قبلی رو عوض کردیم»: تعویضِ قطعهٔ خراب تعمیر است، نه خریدِ ملزومات (R048) —
    // همان که «موتور کولر سوخت، یه موتور نو جاش گذاشتیم» تعمیر شد.
    const replacedBroken = type === 'expense' && REPLACED_BROKEN.test(spokenScope);
    if (replacedBroken) purposes = { paymentPurpose: 'expense' };
    // «تابلوی برق ... کامل بازسازی و ارتقا دادیم»: بهسازیِ اساسیِ یک دارایی تعمیرِ عادی نیست؛
    // مثل خریدِ دارایی، حد سرمایه‌ای دفتر می‌گوید دارایی ثابت است یا هزینهٔ دوره (R050).
    const capitalWork = type === 'expense' && !replacedBroken && facts.subject.kind === 'asset' && CAPITAL_WORK.test(spokenScope);
    if (capitalWork) purposes = { ...PURPOSE_BY_KIND['asset-purchase'] };
    // کالای ماندگار برای استفادهٔ خودمان، استفادهٔ بلندمدت است؛ حد سرمایه‌ای دفتر
    // می‌گوید دارایی است یا هزینه. آزمون زنده (V26): دستگاه کپی ۴۵ میلیونی هزینه شد.
    // موضوعِ مدل یکی است و برای کل گفته؛ در گفتهٔ چندمبلغی فقط به مبلغی می‌رسد که
    // موضوع در بخشِ خودش آمده. «بیمهٔ یک‌سالهٔ تجهیزات … و ناهار پرسنل ۲ میلیون»: کاربردِ
    // «بلندمدت»ِ تجهیزات ناهار را دارایی ثابت می‌کرد (آزمون زندهٔ موتور ۵).
    const ownText = normalizePersian(scope.own || '');
    const subjectHere = scope.alone || [facts.subject.evidence, facts.subject.what].filter(Boolean)
      .some((part) => ownText.includes(normalizePersian(part)));
    // «تعمیر کولر آبی دفتر»: مدل موضوع را خودِ کولر (دارایی) نامید و پولِ تعمیر دارایی
    // ثابت شد (محک دسته، مهر ۱۴۰۵). وقتی دستهٔ خودِ مدل خدمت است، پول بابت خدمتی روی
    // دارایی رفته، نه خریدِ آن.
    const boughtService = !capitalWork && (replacedBroken || (subjectHere && SERVICE_ON_ASSET_CATEGORIES.has(facts.subject.category)));
    // «اتو برقی برای خیاطی»: مدل دارایی را «برای تولید» نامید و موجودی کالا شد. دارایی ماده‌ای
    // نیست که در محصول مصرف شود؛ ابزارِ کار، استفادهٔ بلندمدت است.
    const durableUse = capitalWork || (facts.subject.kind === 'asset' && ['internal', 'production'].includes(facts.subject.use) && !boughtService);
    const subjectIntent = durableUse ? 'long-term-use' : SUBJECT_USE_TO_INTENT[facts.subject.use];
    // پولِ تعمیر و سرویس، هر کاربردی که مدل برای خودِ دستگاه گفته باشد («بلندمدت»)، خریدِ
    // دارایی نیست (محک دسته، دور دوم: تعمیر کولر، ماشین، آسانسور و پرینتر).
    const intendedUse = (subjectHere ? (boughtService && subjectIntent === 'long-term-use' ? null : subjectIntent) : null)
      || (boughtService ? null : purposes.intendedUse) || null;
    const cashSide = movement.direction === 'in' ? movement.to : movement.from;
    const endpoint = resolution.endpoints?.[`${movement.id}.${movement.direction === 'in' ? 'to' : 'from'}`];
    const answeredAccount = answers[`movements.${movement.id}.account`]?.valueId;
    // پول از جیب شریک یا کارمند رفته: حسابی از شرکت پرسیده نمی‌شود؛ سطر نقد در سند
    // جایش را به جاری او می‌دهد (`fundedBy`).
    const accountId = movement.direction === 'none' ? null : funder && type === 'expense' ? 'cash' : answeredAccount || endpoint?.accountId || null;
    if (movement.direction !== 'none' && !accountId) {
      question({
        id: `movements.${movement.id}.account`, kind: 'information', picker: 'account', options: [],
        text: endpoint?.status === 'unknown-bank' ? `حسابی برای «${cashSide?.name}» در دفتر تعریف نشده؛ پول ${type === 'income' ? 'به' : 'از'} کدام حساب ${type === 'income' ? 'آمد' : 'رفت'}؟`
          : `پول ${type === 'income' ? 'به' : 'از'} کدام حساب ${type === 'income' ? 'آمد' : 'رفت'}؟`,
      });
      continue;
    }

    // دسته اول از فهمِ مدل: «کلید برق» را مدل کالا فهمید ولی فهرستِ واژه «برق» را دید و
    // «قبوض» ثبت شد (گزارش مالک محصول، ۲۳ مهر ۱۴۰۵). دستهٔ مدل فقط وقتی پذیرفته است که
    // موضوع مالِ همین مبلغ باشد و دسته با نوعِ موضوع و جهتِ پول جور باشد؛ وگرنه همان
    // فهرست واژه، و آن هم فقط دسته‌ای که با فهمِ مدل در تضاد نیست.
    // «اجاره مهر دفتر»: مدل موضوع را «دفتر» (دارایی) و دسته را «اجاره» گفت؛ موضوع مفعولِ خدمت
    // است، نه چیزی که خریده شد (محک دسته، دور سوم). «قبوض» و «حقوق» این‌طور نیستند: کالا قبض نیست.
    const serviceOnObject = subjectHere && SERVICE_ON_OBJECT_CATEGORIES.has(facts.subject.category);
    const fits = (name) => categoryFits(name, !subjectHere ? null : serviceOnObject ? 'service' : facts.subject.kind, type);
    // «سایر …»ِ مدل یعنی «دستهٔ خاصی ندیدم»؛ جای دستهٔ مشخصِ فهرست واژه را نمی‌گیرد.
    const modelCategory = !subjectHere ? null
      : fits(facts.subject.category) && !GENERIC_CATEGORIES.has(facts.subject.category) ? facts.subject.category
        // «تعمیر لپ‌تاپ مشتری … گرفتیم»: مدل دستهٔ خودِ خدمت (تعمیر) را گفت، ولی پول آمده؛
        // خدمتی که ما انجام دادیم درآمدِ خدمات است، و اجاره‌ای که گرفتیم درآمد اجاره.
        : type === 'income' && facts.subject.kind === 'service' ? SERVICE_INCOME_TWIN[facts.subject.category] || null : null;
    const describe = [facts.subject.what, facts.event.description, amount.evidence].filter(Boolean).join(' ');
    const matchedIn = (part) => (part ? classifyCategory(part, type) : null);
    // عبارتِ دقیقِ فهرست واژه در گفتهٔ خودِ کاربر («پول گاز انبار»، «شارژ ساختمان») بر دستهٔ
    // مدل مقدم است، اگر با نوعِ موضوع جور باشد؛ واژهٔ تکی («برق») نه. محک دسته، دور دوم: در
    // ۹ اختلاف، عبارت دقیق ۵ بار درست بود و مدل غلط، و مدل فقط یک بار، که نقصِ خودِ فهرست بود.
    const strong = [amount.evidence, scope.alone ? clause : scope.own].map(matchedIn)
      .find((result) => result?.matched && result.confidence >= STRONG_KEYWORD && fits(result.category))?.category || null;
    let category = strong || modelCategory || [amount.evidence, scope.alone ? clause : scope.own, describe].map(matchedIn)
      .find((result) => result?.matched && fits(result.category))?.category || null;
    // «اجاره ماهی ۸ میلیون، سه ماه آینده انبار رو یک‌جا ۲۴ میلیون»: نرخ همان خدمت را نام
    // می‌برد که پرداخت یک‌جا برایش است؛ «انبار»ِ بندِ پرداخت آن را «مواد و کالا» می‌کرد.
    if (!modelCategory && scope.alone && !TIME_BOUND_SERVICE_CATEGORIES.includes(category)) {
      const rated = amounts.filter((other) => other !== amount && other.accepted && other.role === 'unit-price')
        .map((other) => matchedIn(clauseOf(said, other.evidence))).find((result) => result?.matched && TIME_BOUND_SERVICE_CATEGORIES.includes(result.category));
      if (rated) category = rated.category;
    }
    // «مستاجر اجارهٔ شش ماه آینده رو ریخت»: موضوعِ هزینه‌ایِ دریافتی دوقلوی درآمدی دارد
    // (اجاره ← درآمد اجاره)؛ بی آن درآمد اجاره در «سایر درآمدها» می‌نشست (همان قاعدهٔ پارسر).
    if (!category && type === 'income') category = incomeTwin(scope.alone ? said : `${scope.own} ${clause}`)?.category || null;
    const described = classifyCategory(describe, type).category;
    // «آقای کاظمی ۱۲ میلیون نسیه از ما جنس برد»: دستهٔ مدل («مواد و کالا») دستهٔ خرید است و با
    // پولِ آمده جور نیست؛ فروشِ کالا «فروش» است، نه «سایر درآمدها» (آزمون ۱۰۰ سناریو، R032).
    if (!category && type === 'income' && facts.event.kind === 'sale' && fits('فروش')) category = 'فروش';
    category = category || (fits(described) ? described : (type === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها'));
    if (replacedBroken) category = 'تعمیر و نگهداری';
    // «۶ میلیون اجارهٔ همین ماه»: پوششی که در ماهِ پرداخت تمام می‌شود هزینهٔ همین
    // دوره است. برای درآمد، پوششِ درونِ همین ماه چیزی را به بعد نمی‌برد.
    const paidMonth = paymentDate ? monthOf(paymentDate) : null;
    const inPaidMonth = (iso) => Boolean(iso && paidMonth && Date.parse(iso) >= Date.parse(paidMonth.from) && Date.parse(iso) <= Date.parse(paidMonth.to));
    // تاریخ پوششِ مدل برای کل رویداد است، نه برای یک مبلغ: در جملهٔ چندمبلغی فقط
    // به مبلغی می‌رسد که عبارتش در بخشِ خودِ آن است (`amountScope`).
    const coverageHere = (date) => {
      const at = facts.dates.find((item) => item.accepted && item.role === date && item.iso);
      return at ? dateInScope(said, at, scope) : true;
    };
    const coverageOwner = [coverageHere('coverage-start'), coverageHere('coverage-end')];
    let periodStart = coverageOwner[0] === true ? coverageStart : null;
    let periodEnd = coverageOwner[1] === true ? coverageEnd : null;
    let periodUnowned = coverageOwner.includes(null);
    // «پوشش یک‌ساله»، «شش ماه جلوتر»: همان قاعدهٔ مسیر قطعی (`readServicePeriod`)،
    // شروع از روز پرداخت. مدل این را عدد «مدت» می‌نوشت و دوره هرگز به سند نمی‌رسید.
    // فقط از بخشِ خودِ همین مبلغ؛ دوره‌ای در متنِ مشترک صاحب ندارد.
    //
    // آینه‌اش: «مستاجر اجارهٔ ۶ ماه آینده را واریز کرد»، «پشتیبانی یک‌ساله … از اول
    // واریز کرد». فقط برای خدمت یا اجاره و اشتراک — «گارانتی یک ساله»ی کالای فروخته‌شده
    // دورهٔ درآمد نیست.
    const serviceDone = type === 'income' && SERVICE_DONE.test(scope.alone ? said : `${scope.own} ${clause}`);
    if (serviceDone && movement.direction !== 'none'
      && [...said.matchAll(AFTER_SERVICE)].some(([phrase]) => monthsIn(phrase) > 0 || (paymentDate && readServicePeriod(phrase, { occurredAt: paymentDate })))) {
      toAccountant(`«${label}» بابت خدمتی است که انجام شده و برایش گارانتی یا پشتیبانیِ دوره‌دار گفته شده؛ اینکه سهمی از آن برای تعهدِ بعدی کنار برود یا همه درآمد امروز است، قضاوت حسابدار است.`);
      continue;
    }
    const incomeText = (text) => (type === 'income' ? String(text || '').replace(WARRANTY_PHRASE, ' ') : text);
    const timeBoundIncome = type === 'income' && !serviceDone && (facts.subject.kind === 'service' || TIME_BOUND_INCOME.test(`${facts.subject.what || ''} ${scope.own}`));
    if (!periodStart && !periodEnd && (type === 'expense' || timeBoundIncome) && movement.direction !== 'none' && paymentDate) {
      const spokenPeriod = readServicePeriod(incomeText(scope.own), { occurredAt: paymentDate });
      if (spokenPeriod) { periodStart = spokenPeriod.start; periodEnd = spokenPeriod.end; }
      // بخشِ مشترک تنهاست («برای شش ماه آینده،») و نام خدمتش در بند دیگری آمده؛
      // همین که عبارتِ دوره در آن هست کافی است تا دوره صاحب نداشته باشد.
      else if (!scope.alone && readServicePeriod(incomeText(scope.shared), { occurredAt: paymentDate, answer: true })) periodUnowned = true;
    }
    // «اجاره ۶ ماه دفتر از اول آبان»، «از امروز به مدت یک سال»: آغاز گفته شده و طول
    // هم؛ پایان از همین دو ساخته می‌شود و دوباره پرسیده نمی‌شود. طول یا عددِ «مدت»ِ
    // مدل است، یا همان دورهٔ گفته‌شدهٔ مسیر قطعی — هر دو از بخشِ خودِ همین مبلغ.
    const durationMonths = (facts.nonAmountNumbers || [])
      .filter((number) => number.role === 'duration' && dateInScope(said, { expression: number.evidence }, scope) !== false
        && !(type === 'income' && [...said.matchAll(WARRANTY_PHRASE)].some(([phrase]) => phrase.includes(normalizePersian(number.evidence || '').trim()))))
      .map((number) => monthsIn(number.evidence, number.value))
      .find(Boolean)
      || (paymentDate ? readServicePeriod(incomeText(scope.own), { occurredAt: paymentDate })?.months : 0) || 0;
    if (periodStart && !periodEnd && durationMonths) periodEnd = periodEndFrom(periodStart, durationMonths);
    if (periodUnowned && !periodStart && !periodEnd) {
      toAccountant(`دورهٔ پوششی که در جمله آمده مالِ «${label}» است یا مبلغِ دیگرِ همین جمله، روشن نیست؛ کدام هزینهٔ امروز است و کدام پیش‌پرداخت، با حسابدار است.`);
      continue;
    }
    if (!periodStart && !periodEnd && paidMonth && type === 'expense' && movement.direction !== 'none' && THIS_MONTH_WORDS.test(own + ' ' + clause)) {
      periodStart = paidMonth.from;
      periodEnd = paidMonth.to;
    }
    // درآمدِ دوره‌ای که تا پایانِ ماهِ دریافت تمام می‌شود («اجارهٔ مهر» که در مهر رسید،
    // یا اجارهٔ عقب‌افتادهٔ مرداد) همین امروز درآمد است، هر برچسبی که مدل زده باشد؛
    // «پیش پیش» دربارهٔ زمانِ پول است، نه تعهدی که مانده. دوره‌ای که از ماهِ دریافت
    // جلوتر می‌رود پیش‌دریافت است و ماه‌به‌ماه درآمد می‌شود — نه درآمدِ یک‌جای امروز.
    // آزمون موتور ۵: اجارهٔ ۶ ماه آینده ۶۰ میلیون یک‌جا درآمد شد و اجارهٔ مهرِ «پیش پیش»
    // برای همیشه پیش‌دریافت ماند.
    let receiptPurpose = null;
    if (type === 'income' && (periodStart || periodEnd)) {
      const earned = periodEnd ? Boolean(paidMonth) && Date.parse(periodEnd) <= Date.parse(paidMonth.to) : inPaidMonth(periodStart);
      if (earned) {
        periodStart = null;
        periodEnd = null;
        if (purposes.receiptPurpose === 'advance') receiptPurpose = 'other-income';
      } else if (movement.direction !== 'none' && periodStart && periodEnd && !purposes.receiptPurpose?.match(/^(?:loan|owner)$/)) receiptPurpose = 'advance';
    }
    const item = {
      // در جملهٔ چندمبلغی، متنِ ردیف بخشِ خودِ همان مبلغ است — همان قرارداد ردیف‌های
      // مسیر قطعی. نگهبان‌هایی که متن را می‌خوانند («بیمهٔ یک‌ساله» یعنی پیش‌پرداخت)
      // دیگر دورهٔ بیمه را به کرایهٔ حملِ کنارش نمی‌چسبانند.
      amount: amount.value, type, category, rawText: scope.alone ? transcript : scope.own, source, occurredAt: paymentDate,
      accountId, contactId: contactId || null, contactName: unnamed ? '' : counterparty?.name || '',
      linkContact: Boolean(contactId) || createContact, contactNameConfident: true,
      // «هیچ‌کدام»: تسویه فقط از مسیر سند باز (بالا)؛ این ردیف هزینه یا درآمد خودش است.
      settlement: 'none',
      unpaidSignal: movement.direction === 'none',
      dueAt: movement.direction === 'none' ? dueAt : null,
      // نوعِ «خرید دارایی» برای پولِ تعمیرِ آن دارایی، خرید نیست (`boughtService`).
      intendedUse, ...(boughtService && purposes.paymentPurpose === 'goods' ? { paymentPurpose: 'expense' } : purposes),
      ...(receiptPurpose ? { receiptPurpose } : {}),
      servicePeriodStart: periodStart, servicePeriodEnd: periodEnd,
      // فاکتورِ فروشی که زده شده، فروشِ انجام‌شده است: «فاکتور فروش ۲۵ میلیونی ... زدیم» بی
      // تاریخ تحویل به «قاعده‌ای تعریف نشده» می‌خورد و طلبش ثبت نمی‌شد (R026).
      deliveryDate: deliveryDate || (facts.subject.delivered === 'yes' || (type === 'income' && INVOICE_ISSUED.test(said)) ? paymentDate : null),
      amountScaleAmbiguous: Boolean(amount.scaleAmbiguous),
      eventNature: 'new', factSource: 'understanding', userConfirmed: true, needsReview: false, reviewReasons: [],
      confidenceDetails: { amount: { score: 1, reason: amount.provenance === 'user' ? 'مبلغ را ثبت‌کننده تعیین کرد.' : 'مبلغ از شاهدِ جمله خوانده و کنترل شد.' } },
      usefulLifeMonths: facts.subject.usefulLifeMonths || null,
      // طرح ترکیبی: موضوعِ فهم‌شده («کلید برق») دستهٔ جدید نمی‌شود؛ برچسبی است
      // که روی سطرِ دسته تفصیلی می‌شود. فقط وقتی موضوع در بخشِ خودِ همین مبلغ
      // آمده باشد، وگرنه برچسبِ یک ردیف به ردیفِ دیگر نمی‌چسبد.
      ...(subjectHere && facts.subject.what ? { topicLabel: facts.subject.what } : {}),
      ...(funder && type === 'expense' && movement.direction !== 'none' ? { fundedBy: funder } : {}),
    };
    const verb = movement.direction === 'none' ? (type === 'income' ? 'طلب' : 'بدهی') : type === 'income' ? 'دریافت' : 'پرداخت';
    components.push({
      id: amount.id, amountRef: amount.id, kind: movement.direction === 'none' ? 'obligation' : 'cash',
      amount: amount.value, item, text: scope.alone ? null : scope.own,
      // طولِ گفته‌شده بی‌آغاز: آغاز پرسیده می‌شود و پایان از همین طول ساخته می‌شود.
      durationMonths: durationMonths || null,
      // پیش‌دریافتِ اجاره یا خدمتِ دوره‌دار بی‌دوره هرگز درآمد نمی‌شود؛ دوره پرسیده می‌شود.
      timeBound: timeBoundIncome && movement.direction !== 'none',
      label: `${verb} ${money(amount.value)} تومان${counterparty ? ` ${type === 'income' ? 'از' : 'به'} ${counterparty.name}` : ''}`,
    });
  }

  if (accountantReasons.length) reasons.push(...accountantReasons);
  const openQuestions = questions.filter((item) => !answers[item.id]);
  const route = accountantReasons.length ? 'accountant'
    : openQuestions.length ? 'needs-answers'
      : components.length ? 'ready' : 'no-entry';
  if (route === 'no-entry') reasons.push('در این گفته هیچ دریافت، پرداخت یا تعهدِ انجام‌شده‌ای نیست؛ سندی ساخته نمی‌شود.');
  return { route, components, notes, questions: openQuestions, reasons, facts };
}

const OUR_ACCOUNT_SIDES = new Set(['bank', 'cash', 'petty-cash']);

/**
 * بدهیِ کسب‌وکار که شریک یا مدیرعامل از پول شخصی‌اش داد.
 *
 * از حساب‌های شرکت پولی نرفته؛ بدهیِ باز طلبکار بسته می‌شود و شرکت به همان
 * اندازه به شریک بدهکار می‌شود. همان قاعدهٔ کارت تسویه: فقط روی یک بدهیِ بازِ
 * ثبت‌شده، بی‌حدس. بهای داراییِ شخصی‌ای که فروخته شد زمینه است و سندی ندارد.
 */
/**
 * هزینه یا خرید از پول شخصی، نه بستن طلب و بدهی: نه بدهیِ قبلی گفته شده و نه
 * نشانهٔ بستن آن. همان تشخیص قطعیِ مسیر کارت داور است تا دو مسیر یک جور بفهمند.
 */
function fundingOf(facts, said) {
  if (facts.amounts.some((item) => item.role === 'prior-balance')) return null;
  const spoken = detectPartnerFundedSpend(said);
  if (!spoken) return null;
  const person = facts.counterparties.find((item) => ['owner', 'partner', 'employee'].includes(item.role))
    || facts.counterparties.find((item) => spoken.name && normalizePersian(item.name).replace(/آ/g, 'ا') === normalizePersian(spoken.name).replace(/آ/g, 'ا'));
  return { kind: person?.role === 'employee' ? 'employee' : spoken.kind, name: person?.name || spoken.name, role: spoken.role };
}

function planPartnerPaid({ facts, said, amounts, retracted, resolution, answers, paymentDate, components, notes, question, toAccountant }) {
  const parties = facts.counterparties.filter((item) => !bankName(item.name) && item.role !== 'bank');
  const spoken = detectPartnerPaidDebt(said);
  const sameName = (left, right) => Boolean(left && right) && (() => {
    const a = normalizePersian(left).replace(/آ/g, 'ا');
    const b = normalizePersian(right).replace(/آ/g, 'ا');
    return a.includes(b) || b.includes(a);
  })();
  // پرداخت‌کننده: نقشِ شریک در فهم مدل، یا همان آدمی که جمله از پول شخصی‌اش می‌گوید.
  // مدل گاهی نقش او را «other» می‌نویسد یا اصلاً در فهرست نمی‌آورد.
  const payer = parties.find((item) => ['owner', 'partner'].includes(item.role))
    || parties.find((item) => sameName(item.name, spoken?.paidBy?.name))
    || (spoken?.paidBy?.name || spoken?.paidBy?.role ? { id: 'spoken-payer', name: spoken.paidBy.name || spoken.paidBy.role, role: 'owner' } : null);
  const creditor = parties.find((item) => item !== payer && sameName(item.name, spoken?.contactName) && !sameName(item.name, payer?.name))
    || parties.find((item) => item !== payer && !['owner', 'partner', 'employee'].includes(item.role) && !sameName(item.name, payer?.name)) || null;
  // پول مشتری به حساب شخصی شریک رفت: طلب ما بسته می‌شود، شریک بدهکار می‌شود.
  const direction = spoken?.direction || (creditor?.role === 'customer'
    || facts.movements.some((movement) => movement.direction === 'in') ? 'receivable' : 'payable');
  const side = direction === 'payable' ? 'بدهی' : 'طلب';
  if (!payer) { toAccountant('شریکی که پول از حساب شخصی او گذشت در جمله معلوم نیست؛ جاری کدام شریک؟ با حسابدار است.'); return; }
  if (!creditor) { toAccountant(`طرف حسابی که ${side}ش بسته شد در جمله نیست؛ تسویه بدون طرف حساب ثبت نمی‌شود.`); return; }

  const live = amounts.filter((item) => item.accepted && !retracted.has(item.id));
  for (const item of live.filter((amount) => amount.status === 'context' && amount.role !== 'prior-balance')) {
    notes.push({ amountRef: item.id, kind: 'context', text: `«${item.evidence || item.role}» پولِ شخصی است، نه رویداد شرکت؛ ثبت نمی‌شود.` });
  }
  const paid = live.filter((item) => item.status === 'done' && ['paid-now', 'received-now', 'total', 'part'].includes(item.role));
  const prior = live.find((item) => item.role === 'prior-balance');
  const values = [...new Set(paid.map((item) => item.value))];
  if (values.length > 1) { toAccountant('چند مبلغ پرداخت در جمله است؛ کدام بدهی با کدام مبلغ بسته شد، با حسابدار است.'); return; }
  const amount = paid[0] || prior || null;
  if (!amount) { toAccountant('مبلغی که از پول شخصی پرداخت شد در جمله نیست.'); return; }

  // جمله‌ای که هم از پول شخصی می‌گوید و هم از حساب شرکت، دو رویداد است.
  const fromOurs = facts.movements.some((movement) => ['in', 'out'].includes(movement.direction)
    && (OUR_ACCOUNT_SIDES.has(movement.from?.kind) || OUR_ACCOUNT_SIDES.has(movement.to?.kind)));
  if (fromOurs) { toAccountant('جمله هم از پول شخصی شریک می‌گوید هم از حساب شرکت؛ سهم هر کدام با حسابدار است.'); return; }

  const resolved = resolution.counterparties?.[creditor.id];
  const picked = answers[`counterparties.${creditor.id}`]?.valueId;
  const contactId = picked && picked !== 'new' ? picked : resolved?.status === 'exact' ? resolved.contactId : null;
  if (!contactId) {
    question({
      id: `counterparties.${creditor.id}`, kind: 'information', picker: 'contact',
      text: resolved?.status === 'similar' ? `«${creditor.name}» همان «${resolved.candidates?.[0]?.name}» است؟` : `«${creditor.name}» کدام طرف حساب است؟`,
      options: (resolved?.candidates || []).map((item) => ({ value: item.id, label: item.name })),
    });
    return;
  }
  const open = (resolution.documents?.[contactId] || []).filter((document) => document.direction === direction && document.remaining > 0);
  // بدهیِ ثبت‌شده در «طلب و بدهی»، یا ماندهٔ دفتر کل که سندی ندارد.
  const documents = open.filter((document) => ['obligation', 'ledger-balance'].includes(document.kind));
  // طلبی که پولش به حساب شخصی شریک رفت هم از همین مسیر است، با جهت وارونه.
  if (!documents.length) {
    toAccountant(open.length
      ? `${side}ِ «${creditor.name}» فاکتور است؛ تسویهٔ فاکتور از حساب شخصی شریک با حسابدار است.`
      : `${side}ِ باز «${creditor.name}» نه در سندها پیدا شد نه در ماندهٔ دفتر کل؛ بدون مبنا، سند با حسابدار است.`);
    return;
  }
  const pickedDocument = answers[`settlements.${amount.id}`]?.valueId;
  const target = pickedDocument ? documents.find((document) => document.id === pickedDocument) : documents.length === 1 ? documents[0] : null;
  if (!target) {
    question({
      id: `settlements.${amount.id}`, kind: 'information', picker: 'document',
      text: `این ${money(amount.value)} تومان کدام ${side}ِ «${creditor.name}» را بست؟`,
      options: documents.map((document) => ({ value: document.id, label: `${document.reference} — مانده ${money(document.remaining)} تومان` })),
    });
    return;
  }
  if (target.remaining < amount.value) {
    toAccountant(`ماندهٔ «${target.reference}» (${money(target.remaining)} تومان) از مبلغ این پرداخت کمتر است.`);
    return;
  }
  const payerResolved = resolution.counterparties?.[payer.id];
  components.push({
    id: amount.id, amountRef: amount.id, kind: 'partner-settlement', amount: amount.value, contactId, occurredAt: paymentDate,
    target: { kind: target.kind, id: target.id, reference: target.reference, remaining: target.remaining }, direction,
    paidBy: { name: payer.name, contactId: payerResolved?.status === 'exact' ? payerResolved.contactId : null }, item: null,
    label: direction === 'payable'
      ? `بستن ${money(amount.value)} تومان بدهی «${creditor.name}» (${target.reference}) از پول شخصی ${payer.name} — بدون برداشت از صندوق یا بانک`
      : `وصول ${money(amount.value)} تومان طلب از «${creditor.name}» (${target.reference}) به حساب شخصی ${payer.name} — بدون ورود به صندوق یا بانک`,
  });
}
