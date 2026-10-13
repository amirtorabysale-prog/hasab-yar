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
import { classifyCategory } from './categoryRules.js';
import { detectBank } from './banks.js';
import { normalizePersian } from './normalize.js';
import { persianMonthRange, todayPersian } from './persianDate.js';
import { detectPartnerFundedSpend, detectPartnerPaidDebt } from './partnerPaidSpeech.js';
import { readServicePeriod } from './periodSpeech.js';
import { saysRefundable } from './moneyPurpose.js';

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
/** پولِ خدمتی که پیشاپیش آمده. */
const UPFRONT = /از\s*اول|یک\s*جا|یکجا|پیش\s*پیش|پیشاپیش|جلوتر|کل\s*مبلغ/;
const SERVICE_DONE = /انجام\s*(?:دادیم|دادم|شد)|(?:تموم|تمام)\s*(?:کردیم|شد)|تحویل\s*دادیم/;
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
const THIS_MONTH_WORDS = /(?:این|همین)\s*ماه|ماه\s*جاری/;
const PARTY_TITLE = /آقای|خانم|شرکت|دکتر|مهندس|حاج|فروشگاه|موسسه|مؤسسه|کارخانه/;

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
/** بندِ یک شاهد در متنِ کامل: تکه‌ای میان دو نشانهٔ جداکننده. */
function clauseOf(said, evidence) {
  const key = normalizePersian(evidence || '').trim();
  const at = key ? said.indexOf(key) : -1;
  if (at < 0) return '';
  const separator = /[.،,؛;!؟?\n:]/;
  let start = at;
  while (start > 0 && !separator.test(said[start - 1])) start -= 1;
  let end = at + key.length;
  while (end < said.length && !separator.test(said[end])) end += 1;
  return said.slice(start, end);
}

/** جای شاهد در متن؛ «۲ میلیون» درونِ «۱۲ میلیون» پیدا نمی‌شود. */
function locate(said, evidence, taken) {
  const key = normalizePersian(evidence || '').trim();
  if (!key) return null;
  for (let at = said.indexOf(key); at >= 0; at = said.indexOf(key, at + 1)) {
    const end = at + key.length;
    if (/[0-9۰-۹٠-٩]/.test(said[at - 1] || '') && /^[0-9۰-۹٠-٩]/.test(key)) continue;
    if (taken.some((span) => at < span.end && end > span.start)) continue;
    return { start: at, end };
  }
  return null;
}

/** «آبان و آذر»، «۶ و نیم»: «و» میان دو ماه یا دو عدد مرزِ دو مبلغ نیست. */
const MONTH_NAMES = 'فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند';
const AND_NOT_BOUNDARY = new RegExp(`^\\s+و\\s+(?:${MONTH_NAMES}|نیم|[0-9۰-۹٠-٩]|یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده)(?![آ-ی])`);
const PUNCTUATION = /[.،,؛;!؟?\n:]/;

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
 * اجزای یک کل («۳۰ میلیون اجاره، ۱۰ نقد و ۲۰ از تجارت») یک صاحب‌اند و دوره را با هم
 * می‌برند. وقتی مبلغِ دیگری برای ثبت نیست، کل جمله مالِ همین مبلغ است.
 */
function amountScope(said, amount, amounts, retracted) {
  const group = (item) => item.partOf || item.id;
  // مبلغِ آینده یا شرطی هم بخشِ خودش را دارد: «اجارهٔ شش ماه آینده رو ماه بعد میدیم
  // و قبض ۲ میلیون دادیم» دورهٔ اجاره را به قبض نمی‌دهد. نرخ و قسط و ماندهٔ قبلی
  // زمینهٔ مبلغ دیگرند و بخشی از جمله را از آن جدا نمی‌کنند.
  const claims = (item) => item.accepted && item.status !== 'context' && !retracted.has(item.id)
    && !['unit-price', 'installment', 'prior-balance'].includes(item.role);
  const mine = group(amount);
  const isMine = (item) => group(item) === mine || item.id === mine;
  const others = amounts.filter((item) => claims(item) && !isMine(item));
  if (!others.length) return { alone: true, own: said, shared: '' };
  const members = [...amounts.filter(isMine), ...others]
    .sort((a, b) => normalizePersian(b.evidence || '').length - normalizePersian(a.evidence || '').length);
  const spans = [];
  for (const item of members) {
    const span = locate(said, item.evidence, spans);
    if (span) spans.push({ ...span, mine: isMine(item) });
  }
  spans.sort((a, b) => a.start - b.start);
  if (!spans.some((span) => span.mine)) return { alone: false, own: normalizePersian(amount.evidence || ''), shared: said, spans: [], owned: [] };
  // برش‌ها: میان دو شاهدِ دو صاحبِ متفاوت، اولین مرز؛ بی‌مرز، فاصله مشترک می‌ماند.
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
    if (left.mine === right.mine) { owned[index - 1].to = right.start; owned[index].from = left.end; continue; }
    const gap = said.slice(left.end, right.start);
    let cut = -1;
    for (let at = 0; at < gap.length; at += 1) {
      if (PUNCTUATION.test(gap[at])) { cut = at; break; }
      if (/^\s+و\s/.test(gap.slice(at)) && (at === 0 || !/\s/.test(gap[at - 1])) && !AND_NOT_BOUNDARY.test(gap.slice(at))) { cut = at; break; }
    }
    owned[index - 1].to = cut < 0 ? left.end : left.end + cut;
    owned[index].from = cut < 0 ? right.start : left.end + cut;
  }
  const own = [];
  const claimed = new Array(said.length).fill(false);
  spans.forEach((span, index) => {
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

function monthOf(iso) {
  const day = todayPersian(new Date(iso));
  return persianMonthRange(day.year, day.month);
}

function counterpartyFor(understanding, movement, amount) {
  const loan = ['loan-received', 'loan-repayment'].includes(understanding.event.kind);
  const pool = loan ? understanding.counterparties : understanding.counterparties.filter((item) => !detectBank(item.name) && item.role !== 'bank');
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
    const createContact = pickedContact === 'new' || (resolved?.status === 'new' && Boolean(counterparty));

    const isSettlement = movement.direction !== 'none' && (facts.event.kind === 'settlement' || (priorBalance && ['paid-now', 'received-now', 'part'].includes(amount.role)));
    // تسویه و پیش‌پرداخت و وام بدون طرف حساب معنا ندارند. تعهدِ بی‌نام — «قبض
    // برق اومده» — همان مسیر امروز را می‌رود: اگر موتور طرف حساب بخواهد، خودش می‌پرسد.
    const needsCounterparty = isSettlement || (movement.direction === 'none' && Boolean(counterparty)) || ['advance-paid', 'advance-received', 'deposit', 'loan-received'].includes(facts.event.kind);
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
    // درآمد شد. آغاز دوره حدس زده نمی‌شود؛ پخشش با حسابدار است.
    const serviceUpfront = type === 'income' && facts.subject.kind === 'service' && !coverageStart
      && (facts.nonAmountNumbers || []).some((item) => item.role === 'duration') && UPFRONT.test(said) && !SERVICE_DONE.test(said);
    // «۳۰ میلیون ودیعه … ۶ میلیون اجارهٔ همین ماه»: ماهیتِ هر مبلغ از شاهدِ خودش.
    // نوعِ کل رویداد («ودیعه») به هر دو می‌رسید و اجاره ودیعه می‌شد؛ در گفتهٔ
    // دیگری ودیعه اجاره می‌شد (آزمون بازبین و گزارش مالک محصول، مهر ۱۴۰۵).
    const own = normalizePersian(amount.evidence || '');
    const clause = clauseOf(said, amount.evidence);
    const scope = amountScope(said, amount, amounts, retracted);
    // برچسب «ودیعه»ی مدل به‌تنهایی کافی نیست: «پیش‌پرداخت بیمه … ۱۲ میلیون» را مدل
    // «ودیعه» نامید و ۱۲ میلیون ودیعهٔ قابل استرداد شد (۱۸ مهر ۱۴۰۵). ودیعه یعنی
    // پولی که برمی‌گردد و جمله باید خودش این را بگوید؛ «پیش‌پرداخت» بر برچسب مقدم است.
    //
    // نگاه به کل جمله فقط وقتی است که شاهدِ خودِ مبلغ ماهیتی نگفته: در «۳۰ میلیون
    // رهن و ۶ میلیون اجاره مهر» برچسب «ودیعه» روی ۶ میلیونِ اجاره، رهنِ مبلغ دیگر
    // را قرض می‌گرفت و اجارهٔ مهر هرگز هزینه نمی‌شد.
    const refundableHere = REFUNDABLE_WORDS.test(own)
      || (amount.role === 'deposit' && REFUNDABLE_WORDS.test(said) && !ADVANCE_WORDS.test(own) && !classifyCategory(own, 'expense').matched);
    if (type === 'expense' && movement.direction !== 'none' && DEPOSIT_AND_SERVICE.test(own)) {
      toAccountant(`«${label}» هم ودیعه است و هم اجاره یا هزینهٔ دوره؛ سهم هر کدام گفته نشده و تفکیکش با حسابدار است.`);
      continue;
    }
    if (type === 'income' && movement.direction !== 'none' && (DEPOSIT_IN_WORDS.test(own) || (DEPOSIT_IN_WORDS.test(clause) && !classifyCategory(own, 'income').matched))) {
      toAccountant(`«${label}» ودیعه یا رهن است، نه درآمد: یا بدهیِ برگشت‌پذیر به پرداخت‌کننده است یا ودیعهٔ قبلیِ ما که برگشته؛ ثبتش در حساب ودیعه با حسابدار است.`);
      continue;
    }
    // ودیعه یعنی پولی که برمی‌گردد؛ اینکه برمی‌گردد یا مصرف می‌شود را جمله باید
    // بگوید («آخر قرارداد پس می‌گیریم»)، همان قاعدهٔ مسیر قطعی (`saysRefundable`).
    // وگرنه استرداد پرسیده می‌شود — نامِ «ودیعه» یا «رهن» به‌تنهایی جواب نیست.
    const returns = saysRefundable(clause || own);
    const advanceHere = ADVANCE_WORDS.test(own) || (ADVANCE_WORDS.test(clause) && !REFUNDABLE_WORDS.test(clause))
      || (ADVANCE_WORDS.test(said) && !REFUNDABLE_WORDS.test(said) && amounts.filter((item) => item.accepted && item.status === 'done' && !retracted.has(item.id)).length === 1);
    const depositSibling = amounts.some((other) => other !== amount && other.accepted && other.partOf === amount.partOf
      && (other.role === 'deposit' || REFUNDABLE_WORDS.test(normalizePersian(other.evidence || ''))));
    const purposes = amount.role === 'fee' ? { paymentPurpose: 'expense' }
      : type === 'expense' && refundableHere ? (typeof returns === 'boolean' ? { paymentPurpose: 'deposit', refundable: returns } : { paymentPurpose: 'deposit' })
        : advanceHere ? (type === 'expense' ? { paymentPurpose: 'advance' } : { receiptPurpose: 'advance' })
          : serviceUpfront ? { receiptPurpose: 'advance' }
            : type === 'expense' && depositSibling ? { paymentPurpose: 'expense', refundable: false }
              : PURPOSE_BY_KIND[facts.event.kind] || {};
    // کالای ماندگار برای استفادهٔ خودمان، استفادهٔ بلندمدت است؛ حد سرمایه‌ای دفتر
    // می‌گوید دارایی است یا هزینه. آزمون زنده (V26): دستگاه کپی ۴۵ میلیونی هزینه شد.
    const intendedUse = (facts.subject.kind === 'asset' && facts.subject.use === 'internal' ? 'long-term-use' : SUBJECT_USE_TO_INTENT[facts.subject.use])
      || purposes.intendedUse || null;
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

    // دسته هم اول از شاهدِ خودِ مبلغ و بندِ آن (در جملهٔ چندمبلغی، بخشِ خودِ آن)،
    // و فقط اگر چیزی نگفتند از شرحِ کل.
    const describe = [facts.subject.what, facts.event.description, amount.evidence].filter(Boolean).join(' ');
    const category = [amount.evidence, scope.alone ? clause : scope.own].map((part) => (part ? classifyCategory(part, type) : null)).find((result) => result?.matched)?.category
      || classifyCategory(describe, type).category;
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
    if (!periodStart && !periodEnd && type === 'expense' && movement.direction !== 'none' && paymentDate) {
      const spokenPeriod = readServicePeriod(scope.own, { occurredAt: paymentDate });
      if (spokenPeriod) { periodStart = spokenPeriod.start; periodEnd = spokenPeriod.end; }
      else if (!scope.alone && readServicePeriod(scope.shared, { occurredAt: paymentDate })) periodUnowned = true;
    }
    if (periodUnowned && !periodStart && !periodEnd) {
      toAccountant(`دورهٔ پوششی که در جمله آمده مالِ «${label}» است یا مبلغِ دیگرِ همین جمله، روشن نیست؛ کدام هزینهٔ امروز است و کدام پیش‌پرداخت، با حسابدار است.`);
      continue;
    }
    if (!periodStart && !periodEnd && paidMonth && type === 'expense' && movement.direction !== 'none' && THIS_MONTH_WORDS.test(own + ' ' + clause)) {
      periodStart = paidMonth.from;
      periodEnd = paidMonth.to;
    }
    if (type === 'income' && inPaidMonth(periodStart) && (!periodEnd || inPaidMonth(periodEnd))) { periodStart = null; periodEnd = null; }
    const item = {
      // در جملهٔ چندمبلغی، متنِ ردیف بخشِ خودِ همان مبلغ است — همان قرارداد ردیف‌های
      // مسیر قطعی. نگهبان‌هایی که متن را می‌خوانند («بیمهٔ یک‌ساله» یعنی پیش‌پرداخت)
      // دیگر دورهٔ بیمه را به کرایهٔ حملِ کنارش نمی‌چسبانند.
      amount: amount.value, type, category, rawText: scope.alone ? transcript : scope.own, source, occurredAt: paymentDate,
      accountId, contactId: contactId || null, contactName: counterparty?.name || '',
      linkContact: Boolean(contactId) || createContact, contactNameConfident: true,
      // «هیچ‌کدام»: تسویه فقط از مسیر سند باز (بالا)؛ این ردیف هزینه یا درآمد خودش است.
      settlement: 'none',
      unpaidSignal: movement.direction === 'none',
      dueAt: movement.direction === 'none' ? dueAt : null,
      intendedUse, ...purposes,
      servicePeriodStart: periodStart, servicePeriodEnd: periodEnd,
      deliveryDate: deliveryDate || (facts.subject.delivered === 'yes' ? paymentDate : null),
      amountScaleAmbiguous: Boolean(amount.scaleAmbiguous),
      eventNature: 'new', factSource: 'understanding', userConfirmed: true, needsReview: false, reviewReasons: [],
      confidenceDetails: { amount: { score: 1, reason: amount.provenance === 'user' ? 'مبلغ را ثبت‌کننده تعیین کرد.' : 'مبلغ از شاهدِ جمله خوانده و کنترل شد.' } },
      usefulLifeMonths: facts.subject.usefulLifeMonths || null,
      ...(funder && type === 'expense' && movement.direction !== 'none' ? { fundedBy: funder } : {}),
    };
    const verb = movement.direction === 'none' ? (type === 'income' ? 'طلب' : 'بدهی') : type === 'income' ? 'دریافت' : 'پرداخت';
    components.push({
      id: amount.id, amountRef: amount.id, kind: movement.direction === 'none' ? 'obligation' : 'cash',
      amount: amount.value, item, text: scope.alone ? null : scope.own,
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
  const parties = facts.counterparties.filter((item) => !detectBank(item.name) && item.role !== 'bank');
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
