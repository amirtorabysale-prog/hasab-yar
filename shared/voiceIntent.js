import { normalizePersian } from './normalize.js';
import { extractDateMention } from './persianDate.js';
import { parseFinancialText } from './parser.js';

/**
 * نیت گفته را تشخیص می‌دهد.
 *
 * تا امروز صدا فقط دو کار می‌کرد: ثبت تراکنش و اصلاح آخرین ثبت. هر چیز دیگری —
 * بدهکار، طلبکار، چک، فاکتور — باید دستی در فرم وارد می‌شد. برای دفتری که
 * روزانه ده‌ها قلم دارد این یعنی صدا عملاً بی‌مصرف است.
 *
 * تشخیص عمداً قطعی و محلی است: هزینهٔ صفر، تأخیر صفر، و مهم‌تر از همه
 * قابل‌آزمون. هیچ نیتی بدون تأیید صریح کاربر اجرا نمی‌شود.
 */

// «بدهکاره» و «بدهکارم» جهت مخالف دارند: اولی طلب ماست، دومی بدهی ما.
// اشتباه‌گرفتنشان یعنی طلب به‌عنوان بدهی وارد دفتر می‌شود.
// «بدهکار شد» و «بدهکار شدم» یک حرف نیستند: اولی طرف مقابل بدهکار شده (طلب ما)
// و دومی خودِ ما. فاصله بین «بدهکار» و فعل باید پذیرفته شود — گفتار محاوره‌ای
// تقریباً همیشه فاصله دارد — ولی صیغهٔ اول‌شخص باید از طلب بیرون بماند، وگرنه
// «بدهکار شدم» طلب ثبت می‌شد.
const RECEIVABLE_PATTERNS = [
  /بدهکار\s*(?:ه|است|هست(?:ند)?|شد(?!\s*(?:م|یم))|شده(?!\s*(?:ام|ایم))|ند)/,
  /طلب\s*دار(?:م|یم)/, /طلبم\s*شد/, /از\s*\S+\s*طلب/, /باید\s*به\s*(?:ما|من)\s*بده/,
  /قرض\s*داد(?:م|یم)/,
];
const PAYABLE_PATTERNS = [
  /بدهکار(?:م|یم)(?![آ-ی])/, /بدهکار\s*شد(?:م|یم)/, /بدهکار\s*هست(?:م|یم)/,
  /طلبکار(?:ه|است|هست|ند)/, /بدهی\s*دار(?:م|یم)/, /بدهیم\s*شد/,
  /باید\s*(?:بهش|به\s*\S+)\s*بدم/, /قرض\s*گرفت(?:م|یم)/,
];

// `\b` با حروف فارسی کار نمی‌کند — برای جاوااسکریپت حرف فارسی «word» نیست، پس
// `\bچک\b` هیچ‌وقت تطبیق نمی‌خورد. مرز واژه باید با lookaround ساخته شود.
const CHEQUE_PATTERNS = [/(?<![آ-ی])چک(?![آ-ی])/, /(?<![آ-ی])چکی(?![آ-ی])/, /صیاد/];
const INVOICE_SALES_PATTERNS = [/فاکتور\s*فروش/, /فاکتور\s*زدم\s*برای/, /پیش\s*فاکتور\s*فروش/];
const INVOICE_PURCHASE_PATTERNS = [/فاکتور\s*خرید/, /فاکتور\s*خریدم/];

// آوردهٔ مالک درآمد نیست. اگر به‌عنوان درآمد ثبت شود، سود دوره به اندازهٔ همان
// آورده باد می‌کند و مالیات روی پولی حساب می‌شود که خودِ مالک گذاشته است.
const CAPITAL_PATTERNS = [
  /سرمایه\s*(?:را\s*)?(?:گذاشتم|گذاشتیم|آوردم|آوردیم|اضافه\s*کردم|اضافه\s*کردیم|واریز\s*کردم|ریختم)/,
  /افزایش\s*سرمایه/,
  /آورده\s*(?:نقدی|مالک|شریک)/,
  /سرمایه\s*اولیه/,
];

// دارایی ثابت هزینهٔ دوره نیست؛ خرجِ امسال نیست، دارایی چند ساله است.
//
// تشخیص فقط با نشانهٔ صریح انجام می‌شود. حدس‌زدن از روی نام کالا («لپ‌تاپ
// خریدم») وسوسه‌انگیز است ولی همان لپ‌تاپ می‌تواند کالای فروش یک مغازهٔ
// کامپیوتر باشد؛ سرمایه‌ای‌کردن یک خرید عادی، هم سود دوره را جعل می‌کند و هم
// یک حساب دارایی بی‌صاحب در دفتر کل می‌سازد. همان قاعده‌ای که برای نام طرف
// حساب پذیرفته‌ایم: بدون نشانهٔ صریح، حدس نمی‌زنیم.
const FIXED_ASSET_PATTERNS = [/دارایی\s*ثابت/, /اموال\s*و\s*تجهیزات/, /خرید\s*سرمایه\s*ای/];

const CONTACT_STOP_WORDS = new Set([
  'آقای', 'اقای', 'خانم', 'جناب', 'شرکت', 'مهندس', 'دکتر', 'حاج', 'حاجی', 'سرکار',
  'از', 'به', 'برای', 'بابت', 'با', 'رو', 'را', 'که', 'و', 'در', 'تا', 'یک', 'یه',
  'بدهکاره', 'بدهکارم', 'طلبکاره', 'طلبکارم', 'چک', 'فاکتور', 'فروش', 'خرید', 'تومان', 'تومن', 'ریال',
  'سررسید', 'سر', 'رسید', 'دادم', 'گرفتم', 'دارم', 'داره', 'هست', 'است', 'شد', 'میشه', 'بشه',
]);

// واژه‌های عددی نباید بخشی از نام شوند: «آقای احمدی سه میلیون» نام را
// «احمدی سه» می‌ساخت.
const NUMBER_WORDS = new Set(['صفر', 'یک', 'یه', 'دو', 'سه', 'چهار', 'چار', 'پنج', 'شش', 'شیش', 'هفت', 'هشت', 'نه',
  'ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'پونزده', 'شانزده', 'هفده', 'هجده', 'نوزده',
  'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود', 'صد', 'دویست', 'سیصد', 'چهارصد',
  'پانصد', 'پونصد', 'ششصد', 'هفتصد', 'هفصد', 'هشتصد', 'هشصد', 'نهصد', 'هزار', 'میلیون', 'میلیارد', 'نیم']);

// واژه‌هایی که کنار نشانهٔ دارایی می‌آیند و نام دارایی نیستند.
const ASSET_STOP_WORDS = new Set(['خریدم', 'خریدیم', 'گرفتم', 'گرفتیم', 'ثبت', 'کن', 'بزن', 'به', 'عنوان',
  'یک', 'بابت', 'برای', 'با', 'از', 'در', 'و', 'را', 'رو', 'شد', 'است', 'هست', 'دارایی', 'ثابت', 'اموال', 'تجهیزات']);

// فعل و حرف اضافه هرگز نام طرف حساب نیستند؛ رد می‌شوند تا نام پشتشان پیدا شود.
const CURRENCY_WORDS = new Set(['تومان', 'تومن', 'ریال', 'هزارتومان', 'میلیونی']);

const FILLER_WORDS = new Set(['شد', 'شده', 'شدم', 'شدیم', 'شدند', 'شدن', 'هست', 'هستم', 'هستیم', 'هستند',
  'است', 'میشه', 'بشه', 'دارم', 'داریم', 'داره', 'دارند', 'دادم', 'دادیم', 'گرفتم', 'گرفتیم', 'بده', 'بدم',
  'به', 'از', 'برای', 'با', 'رو', 'را']);

// واژه‌هایی که خودشان جهت را می‌سازند؛ نام طرف حساب کنارشان می‌نشیند، نه رویشان.
const DIRECTION_WORDS = new Set(['بدهکار', 'بدهکاره', 'بدهکارم', 'بدهکاریم', 'بدهکارند',
  'طلبکار', 'طلبکاره', 'طلبکارم', 'طلبکارند', 'طلب', 'طلبم', 'بدهی', 'بدهیم', 'قرض', 'قرضی']);

const TITLE_PREFIXES = ['آقای', 'اقای', 'خانم', 'جناب', 'مهندس', 'دکتر', 'حاج', 'حاجی', 'سرکار خانم', 'شرکت'];

/**
 * نام دارایی را از کنار نشانهٔ صریح برمی‌دارد.
 * «لپ‌تاپ به عنوان دارایی ثابت خریدم» → «لپ تاپ»، «دارایی ثابت کولر گازی» →
 * «کولر گازی». چیزی پیدا نشد یعنی کاربر باید خودش بنویسد؛ حساب دارایی بدون نام،
 * ردیفی است که شش ماه بعد هیچ‌کس نمی‌داند چیست.
 */
export function extractAssetTitle(input) {
  const text = normalizePersian(input);
  const marker = text.match(/(?:به\s*عنوان\s*)?(?:دارایی\s*ثابت|اموال\s*و\s*تجهیزات)/);
  if (!marker) return '';
  const pick = (words) => {
    const picked = [];
    for (const word of words) {
      if (CONTACT_STOP_WORDS.has(word) || NUMBER_WORDS.has(word) || ASSET_STOP_WORDS.has(word) || /\d/.test(word)) break;
      picked.push(word);
      if (picked.length === 2) break;
    }
    return picked;
  };
  const before = text.slice(0, marker.index).split(' ').filter(Boolean).reverse();
  const beforePick = pick(before).reverse();
  if (beforePick.length) return beforePick.join(' ');
  const after = text.slice(marker.index + marker[0].length).split(' ').filter(Boolean);
  return pick(after).join(' ');
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * نام طرف حساب را از جمله بیرون می‌کشد.
 *
 * پس از یک عنوان («آقای»، «شرکت») تا دو واژه برداشته می‌شود. بدون عنوان،
 * حدس‌زدن نام از میان واژه‌های عادی خطای بیشتری می‌سازد تا فایده — پس نامی
 * برنمی‌گردد و کاربر خودش می‌نویسد.
 */
/**
 * نام بدون عنوان، فقط وقتی صفحه خودش می‌گوید موضوع چیست.
 *
 * در ثبت آزاد، حدس‌زدن نام از میان واژه‌های عادی خطای بیشتری می‌سازد تا فایده —
 * «قبض» و «پیک» و «تعمیر» همه می‌توانند به‌جای نام برداشته شوند. ولی وقتی کاربر
 * روی صفحهٔ طلب و بدهی ایستاده و می‌گوید «حسن بدهکار شد»، موضوع از قبل روشن است
 * و واژهٔ چسبیده به فعلِ جهت، تقریباً همیشه نام طرف حساب است. پس این حالت فقط
 * با `allowBare` روشن می‌شود، نه در مسیر عمومی.
 */
function bareContactName(text) {
  const words = text.split(' ').filter(Boolean);
  const usable = (word) => word
    && !CONTACT_STOP_WORDS.has(word) && !NUMBER_WORDS.has(word)
    && !DIRECTION_WORDS.has(word) && !/\d/.test(word) && word.length > 1;
  // «از رضا دو میلیون طلب دارم»: نام به حرف اضافه چسبیده، نه به فعل جهت.
  for (let index = 0; index < words.length - 1; index += 1) {
    if (!['از', 'به'].includes(words[index])) continue;
    const picked = [];
    for (let ahead = index + 1; ahead < words.length && picked.length < 2; ahead += 1) {
      if (!usable(words[ahead])) break;
      picked.push(words[ahead]);
    }
    if (picked.length) return picked.join(' ');
  }
  for (let index = 0; index < words.length; index += 1) {
    if (!DIRECTION_WORDS.has(words[index])) continue;
    // «حسن بدهکار شد» → واژهٔ پیش از فعل؛ تا دو واژه برای نام‌های دوقسمتی.
    // مبلغ از وسط رد می‌شود: در «حسن سه میلیون بدهکار شد» نام پشت عدد است و
    // ایستادن روی اولین واژهٔ عددی، نام را از دست می‌داد.
    let back = index - 1;
    while (back >= 0 && (NUMBER_WORDS.has(words[back]) || CURRENCY_WORDS.has(words[back]) || /\d/.test(words[back]) || words[back] === 'و')) back -= 1;
    const before = [];
    for (; back >= 0 && before.length < 2; back -= 1) {
      if (!usable(words[back])) break;
      before.unshift(words[back]);
    }
    if (before.length) return before.join(' ');
    // «بدهکار شد حسن» یا «طلب دارم از حسن» → واژهٔ پس از فعل. واژه‌های پرکنندهٔ
    // میانی رد می‌شوند، وگرنه «شد» جلوی رسیدن به نام را می‌گرفت.
    const after = [];
    let ahead = index + 1;
    while (ahead < words.length && FILLER_WORDS.has(words[ahead])) ahead += 1;
    for (; ahead < words.length && after.length < 2; ahead += 1) {
      if (!usable(words[ahead])) break;
      after.push(words[ahead]);
    }
    if (after.length) return after.join(' ');
  }
  return '';
}

export function extractContactName(input, { allowBare = false } = {}) {
  const words = normalizePersian(input).split(' ').filter(Boolean);
  for (let index = 0; index < words.length; index += 1) {
    const prefix = TITLE_PREFIXES.find((title) => {
      const parts = title.split(' ');
      return parts.every((part, offset) => words[index + offset] === part);
    });
    if (!prefix) continue;
    const skip = prefix.split(' ').length;
    const picked = [];
    for (let offset = index + skip; offset < words.length && picked.length < 2; offset += 1) {
      const word = words[offset];
      if (CONTACT_STOP_WORDS.has(word) || NUMBER_WORDS.has(word) || /\d/.test(word)) break;
      picked.push(word);
    }
    if (picked.length) return `${prefix === 'شرکت' ? 'شرکت ' : ''}${picked.join(' ')}`.trim();
  }
  return allowBare ? bareContactName(normalizePersian(input)) : '';
}

/**
 * مبلغ گفته‌شده در یک جملهٔ نیت‌دار.
 *
 * بزرگ‌ترین عدد برداشته می‌شود، نه اولی: «یک دستگاه پراید ... چهارصد میلیون» و
 * «دو تا چک پنج میلیونی» با اولین عدد به مبلغ ۱ و ۲ ثبت می‌شدند، چون واژهٔ
 * شمارش هم برای پارسر یک عدد است. در این جمله‌ها عدد شمارش همیشه کوچک و بی‌مقیاس
 * است و مبلغ همان عددی است که مقیاس (هزار، میلیون) را با خود دارد.
 */
function spokenAmount(input) {
  const parsed = parseFinancialText(input, { source: 'voice' });
  return parsed.transactions.reduce((largest, item) => Math.max(largest, Number(item.amount) || 0), 0);
}

/**
 * سررسید همیشه آینده است، پس ترجیح گذشته خاموش می‌شود؛ وگرنه «سررسید دهم مهر»
 * در شهریور روی مهرِ سال گذشته می‌نشست و چکِ آینده تاریخ‌گذشته ثبت می‌شد.
 */
function dueDate(input, now) {
  const found = extractDateMention(input, { now, preferPast: false });
  return found?.iso || null;
}

/**
 * تشخیص نیت گفته.
 *
 * `context` می‌گوید کاربر کجا ایستاده. در مسیر عمومی («امروز چه اتفاقی افتاد؟»)
 * هیچ فرضی دربارهٔ موضوع نمی‌شود. روی صفحهٔ طلب و بدهی، موضوع از قبل روشن است و
 * دو چیز عوض می‌شود: نام بدون عنوان هم پذیرفته می‌شود، و جملهٔ بدون مبلغ رد
 * نمی‌شود — «حسن بدهکار شد» یک ثبت ناقص است، نه یک جملهٔ بی‌معنا؛ فرم با نام و
 * جهت پر می‌شود و مبلغ را کاربر می‌نویسد.
 */
export function detectVoiceIntent(input, { now = new Date(), context = '' } = {}) {
  const text = normalizePersian(input);
  if (!text) return null;
  const obligationContext = context === 'obligation';

  const amount = spokenAmount(input);
  const contactName = extractContactName(input, { allowBare: obligationContext });
  const isCheque = matchesAny(text, CHEQUE_PATTERNS);

  if (matchesAny(text, INVOICE_PURCHASE_PATTERNS) || matchesAny(text, INVOICE_SALES_PATTERNS)) {
    if (!amount) return null;
    const documentType = matchesAny(text, INVOICE_PURCHASE_PATTERNS) ? 'purchase' : 'sales';
    return {
      intent: 'invoice',
      documentType,
      amount,
      contactName,
      title: documentType === 'purchase' ? 'خرید' : 'فروش',
      occurredAt: extractDateMention(input, { now, preferPast: true })?.iso || null,
      transcript: text,
    };
  }

  if (matchesAny(text, CAPITAL_PATTERNS)) {
    if (!amount) return null;
    return {
      intent: 'capital',
      amount,
      title: 'آورده و افزایش سرمایه',
      accountId: 'cash',
      occurredAt: extractDateMention(input, { now, preferPast: true })?.iso || null,
      transcript: text,
    };
  }

  if (!isCheque && matchesAny(text, FIXED_ASSET_PATTERNS)) {
    if (!amount) return null;
    return {
      intent: 'fixed-asset',
      amount,
      title: extractAssetTitle(input),
      accountId: 'cash',
      occurredAt: extractDateMention(input, { now, preferPast: true })?.iso || null,
      transcript: text,
    };
  }

  // جهت پیش از چک سنجیده می‌شود: «چک پنج میلیون از آقای احمدی گرفتم» طلب است
  // و «چک دادم» بدهی؛ خودِ واژهٔ چک جهت نمی‌سازد.
  // فعل معمولاً از «چک» فاصله دارد («چک پنج میلیون دادم»)، پس چسبیدگی شرط
  // نیست؛ وجود فعل جهت‌دار در همان جمله کافی است.
  const receivable = matchesAny(text, RECEIVABLE_PATTERNS)
    || (isCheque && /(?:گرفتم|گرفتیم|دریافت\s*کردم|داد\s*به\s*(?:من|ما)|دادن\s*به\s*(?:من|ما))/.test(text));
  const payable = matchesAny(text, PAYABLE_PATTERNS)
    || (isCheque && /(?:دادم|دادیم|نوشتم|کشیدم|صادر\s*کردم)/.test(text));
  if (!receivable && !payable) return null;
  if (!amount && !obligationContext) return null;

  // هر دو نشانه یعنی جمله واقعاً مبهم است؛ اجرا نمی‌شود تا کاربر روشنش کند.
  const direction = receivable && payable ? null : receivable ? 'receivable' : 'payable';
  return {
    intent: isCheque ? 'cheque' : 'obligation',
    direction,
    ambiguous: !direction,
    amount,
    // مبلغ خالی یعنی «هنوز گفته نشده»، نه صفر؛ کارت تأیید تا نوشتنش پیش نمی‌رود.
    needsAmount: !amount,
    contactName,
    dueAt: dueDate(input, now),
    title: [isCheque ? 'چک' : '', contactName].filter(Boolean).join(' ') || (isCheque ? 'چک' : 'طلب/بدهی'),
    transcript: text,
  };
}

/**
 * پیش‌نویس فاکتور از نیت گفته.
 *
 * فاکتور واقعی ردیف کالا، تعداد، نرخ و مالیات می‌خواهد و هیچ‌کدام از یک جملهٔ
 * گفتاری درنمی‌آید. پس صدا فقط یک پیش‌نویس با یک ردیف به کل مبلغ گفته‌شده
 * می‌سازد و سند در وضعیت `draft` می‌ماند: نه در دفتر کل سند می‌خورد، نه انبار را
 * تکان می‌دهد، نه در گزارش مالیاتی و نه در جمع طلب/بدهی می‌آید. تکمیل ردیف‌ها و
 * نرخ مالیات در برگهٔ فاکتورها انجام می‌شود و صدور، آگاهانه و دستی است.
 *
 * تاریخ گفته‌شده عمداً روی سند نمی‌نشیند؛ تاریخ فاکتور هنگام صدور تعیین می‌شود و
 * نشاندن تاریخِ حرف روی پیش‌نویسِ ناتمام فقط یک عدد بی‌پشتوانه می‌ساخت.
 */
export function invoiceDraftPayload(intent = {}) {
  const documentType = intent.documentType === 'purchase' ? 'purchase' : 'sales';
  const amount = Math.round(Number(intent.amount) || 0);
  if (!amount || amount <= 0) return null;
  return {
    documentType,
    customerName: intent.contactName || '',
    note: String(intent.transcript || '').slice(0, 300),
    issueNow: false,
    items: [{
      title: documentType === 'purchase' ? 'ردیف خرید — از گفتهٔ صوتی' : 'ردیف فروش — از گفتهٔ صوتی',
      quantity: 1,
      unitPrice: amount,
    }],
  };
}

/**
 * ورودی ثبت سرمایه یا دارایی ثابت.
 *
 * هر دو از صندوق یا بانک عبور می‌کنند — پس ماندهٔ حساب و کنترل پایان روز باید
 * حرکتشان را ببیند — ولی هیچ‌کدام درآمد یا هزینهٔ دوره نیستند. سمت دیگر سند،
 * حساب سرمایه یا حساب همان دارایی است، نه یک دستهٔ درآمد/هزینه.
 */
export function capitalEntryPayload(draft = {}) {
  const amount = Math.round(Number(draft.amount) || 0);
  const title = String(draft.title || '').trim().slice(0, 100);
  if (!amount || amount <= 0 || !title) return null;
  if (!['capital', 'fixed-asset'].includes(draft.intent)) return null;
  return {
    kind: draft.intent === 'capital' ? 'capital-in' : 'fixed-asset',
    amount,
    title,
    accountId: draft.accountId || 'cash',
    occurredAt: draft.occurredAt || null,
    note: String(draft.transcript || '').slice(0, 300),
  };
}
