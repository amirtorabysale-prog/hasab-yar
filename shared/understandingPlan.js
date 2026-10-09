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
  deposit: { paymentPurpose: 'deposit', refundable: true },
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
function counterpartyFor(understanding, movement, amount) {
  const loan = ['loan-received', 'loan-repayment'].includes(understanding.event.kind);
  const pool = loan ? understanding.counterparties : understanding.counterparties.filter((item) => !detectBank(item.name));
  const named = (name) => name && pool.find((item) => item.name === name || name.includes(item.name) || item.name.includes(name));
  const side = movement ? (movement.direction === 'in' ? movement.from : movement.to) : null;
  const bySide = side?.name ? named(side.name) : null;
  if (bySide) return bySide;
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
  if (PARTNER_CUE.test(said) && !/افزایش\s*سرمایه/.test(said)) toAccountant('حساب جاری شریک یا سهامدار با حسابدار است.');
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

  for (const amount of amounts) {
    const label = amount.evidence || amount.role;
    if (retracted.has(amount.id)) { notes.push({ amountRef: amount.id, kind: 'retracted', text: `«${label}» در همان گفته اصلاح شد و کنار گذاشته شد.` }); continue; }
    if (amount.status === 'context') {
      if (amount.role === 'prior-balance') notes.push({ amountRef: amount.id, kind: 'context', text: `${money(amount.value)} تومان بدهی یا طلبِ قبلی است؛ دوباره ثبت نمی‌شود.` });
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
        .filter((document) => document.direction === direction && ['obligation', 'invoice'].includes(document.kind) && document.remaining > 0);
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
    const purposes = amount.role === 'fee' ? { paymentPurpose: 'expense' } : serviceUpfront ? { receiptPurpose: 'advance' } : PURPOSE_BY_KIND[facts.event.kind] || {};
    // کالای ماندگار برای استفادهٔ خودمان، استفادهٔ بلندمدت است؛ حد سرمایه‌ای دفتر
    // می‌گوید دارایی است یا هزینه. آزمون زنده (V26): دستگاه کپی ۴۵ میلیونی هزینه شد.
    const intendedUse = (facts.subject.kind === 'asset' && facts.subject.use === 'internal' ? 'long-term-use' : SUBJECT_USE_TO_INTENT[facts.subject.use])
      || purposes.intendedUse || null;
    const cashSide = movement.direction === 'in' ? movement.to : movement.from;
    const endpoint = resolution.endpoints?.[`${movement.id}.${movement.direction === 'in' ? 'to' : 'from'}`];
    const answeredAccount = answers[`movements.${movement.id}.account`]?.valueId;
    const accountId = movement.direction === 'none' ? null : answeredAccount || endpoint?.accountId || null;
    if (movement.direction !== 'none' && !accountId) {
      question({
        id: `movements.${movement.id}.account`, kind: 'information', picker: 'account', options: [],
        text: endpoint?.status === 'unknown-bank' ? `حسابی برای «${cashSide?.name}» در دفتر تعریف نشده؛ پول ${type === 'income' ? 'به' : 'از'} کدام حساب ${type === 'income' ? 'آمد' : 'رفت'}؟`
          : `پول ${type === 'income' ? 'به' : 'از'} کدام حساب ${type === 'income' ? 'آمد' : 'رفت'}؟`,
      });
      continue;
    }

    const describe = [facts.subject.what, facts.event.description, amount.evidence].filter(Boolean).join(' ');
    const category = classifyCategory(describe, type).category;
    const item = {
      amount: amount.value, type, category, rawText: transcript, source, occurredAt: paymentDate,
      accountId, contactId: contactId || null, contactName: counterparty?.name || '',
      linkContact: Boolean(contactId) || createContact, contactNameConfident: true,
      // «هیچ‌کدام»: تسویه فقط از مسیر سند باز (بالا)؛ این ردیف هزینه یا درآمد خودش است.
      settlement: 'none',
      unpaidSignal: movement.direction === 'none',
      dueAt: movement.direction === 'none' ? dueAt : null,
      intendedUse, ...purposes,
      servicePeriodStart: coverageStart, servicePeriodEnd: coverageEnd,
      deliveryDate: deliveryDate || (facts.subject.delivered === 'yes' ? paymentDate : null),
      amountScaleAmbiguous: Boolean(amount.scaleAmbiguous),
      eventNature: 'new', factSource: 'understanding', userConfirmed: true, needsReview: false, reviewReasons: [],
      confidenceDetails: { amount: { score: 1, reason: amount.provenance === 'user' ? 'مبلغ را ثبت‌کننده تعیین کرد.' : 'مبلغ از شاهدِ جمله خوانده و کنترل شد.' } },
      usefulLifeMonths: facts.subject.usefulLifeMonths || null,
    };
    const verb = movement.direction === 'none' ? (type === 'income' ? 'طلب' : 'بدهی') : type === 'income' ? 'دریافت' : 'پرداخت';
    components.push({
      id: amount.id, amountRef: amount.id, kind: movement.direction === 'none' ? 'obligation' : 'cash',
      amount: amount.value, item,
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
