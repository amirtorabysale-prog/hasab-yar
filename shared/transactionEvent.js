import { CONFIDENCE_COMPONENTS, ROUTES, routeEvent } from './confidenceEngine.js';
import { EVENT_KINDS, normalizeFinancialEvent } from './financialEvent.js';
import { settlementDirection } from './counterpartySettlement.js';
import { resolveAutomationPolicy } from './automationPolicy.js';
import { DECISION_STATUS, decide } from './accountingDecision.js';
import { factsFromEvent } from './eventFacts.js';
import { FACT_LABELS } from './factRequirements.js';
import { purchasePurposeFromSpeech } from './purchasePurpose.js';
import { judgmentReason, lenderFromSpeech, paymentPurposeFromSpeech, receiptPurposeFromSpeech, saysRefundable } from './moneyPurpose.js';

/**
 * پل میان ردیف تراکنش و لایهٔ رویداد مالی.
 *
 * چرا این فایل لازم است: تعهد و تسویه و چک هرکدام از اول به شکل رویداد ساخته
 * می‌شوند، ولی هزینه و درآمد ساده — که بیشترین حجم ثبت‌اند — شکل خودشان را
 * دارند. بدون این نگاشت، موتور اطمینان روی همان مسیری که بیشتر از همه استفاده
 * می‌شود اصلاً اجرا نمی‌شد و صف بررسی همیشه خالی می‌ماند.
 *
 * اینجا هیچ تصمیم حسابداری گرفته نمی‌شود. فقط می‌گوید «چه اتفاقی افتاد» و
 * «چقدر مطمئنیم». اینکه سندش چه می‌شود کار `shared/accountingRules.js` است.
 */

/**
 * هزینه‌ای که هنوز پرداخت نشده، بدهی می‌سازد نه خروج وجه.
 *
 * بدون این، «قبض اومده، موعد پرداختش هفته بعده» یک پرداخت نقدی ثبت می‌شد:
 * ماندهٔ بانک بی‌دلیل کم می‌شد و بدهی به ادارهٔ برق اصلاً ساخته نمی‌شد. بعد هم
 * پرداخت واقعی همان قبض، هزینهٔ دوم می‌ساخت.
 */
const UNPAID_KIND = Object.freeze({
  expense: EVENT_KINDS.PAYABLE_OPENED,
  income: EVENT_KINDS.RECEIVABLE_OPENED,
});

const KIND_BY_TYPE = Object.freeze({
  income: EVENT_KINDS.CASH_INCOME,
  expense: EVENT_KINDS.CASH_EXPENSE,
});

const score = (detail) => {
  if (detail == null) return null;
  if (typeof detail === 'number') return Number.isFinite(detail) ? { score: detail, reason: '' } : null;
  if (!Number.isFinite(Number(detail.score))) return null;
  return { score: Number(detail.score), reason: String(detail.reason || '') };
};

/**
 * مؤلفه‌های اطمینان یک تراکنش.
 *
 * مؤلفه‌ای که دربارهٔ آن چیزی نمی‌دانیم گزارش *نمی‌شود* و وزنش از میانگین بیرون
 * می‌رود — نه اینکه نمرهٔ پایین بگیرد. یک هزینهٔ نقدی ساده طرف حساب ندارد و
 * تاریخ هم ندارد چون همین امروز است؛ نمرهٔ کم دادن به این دو یعنی فرستادن هر
 * ثبت عادی به صف بررسی.
 */
export function transactionConfidenceComponents(item = {}) {
  const supplied = item.confidenceDetails || {};
  const components = {};
  const put = (name, value) => { const detail = score(value); if (detail) components[name] = detail; };

  // نبودِ نمره یعنی «تردیدی گزارش نشده»، نه «اطمینانی نداریم».
  //
  // تردید را تحلیلگر گفتار گزارش می‌کند. ثبتی که از فرم یا از API می‌آید، انتخاب
  // خود کاربر است و هیچ برداشتی در آن نیست که بشود به آن شک کرد. صفر گرفتن
  // این‌ها یعنی هر ثبت دستی هم به صف بررسی می‌رفت — صفی که آن‌وقت هیچ حسابداری
  // نمی‌توانست خالی‌اش کند.
  const certain = (present, reason) => (present ? { score: 1, reason } : null);
  const amount = Math.round(Number(item.amount));
  put(CONFIDENCE_COMPONENTS.AMOUNT, supplied.amount ?? certain(Number.isSafeInteger(amount) && amount > 0, 'مبلغ مشخص است.'));
  put(CONFIDENCE_COMPONENTS.DIRECTION, supplied.type ?? certain(['income', 'expense'].includes(item.type), 'جهت پول مشخص است.'));
  put(CONFIDENCE_COMPONENTS.COMPLETENESS, supplied.category ?? certain(Boolean(item.category), 'دسته انتخاب شده است.'));
  put(CONFIDENCE_COMPONENTS.ACCOUNT, supplied.account ?? certain(Boolean(item.accountId), 'حساب مشخص است.'));

  // تاریخ فقط وقتی مؤلفه است که کاربر تاریخی گفته باشد. نگفتنش یعنی «امروز»،
  // که ابهام نیست.
  if (item.dateExplicit) put(CONFIDENCE_COMPONENTS.DATE, { score: 1, reason: 'تاریخ در متن آمده است.' });
  if (item.contactId) put(CONFIDENCE_COMPONENTS.COUNTERPARTY, { score: 1, reason: 'طرف حساب مشخص است.' });
  if (item.source === 'voice' && Number.isFinite(Number(item.confidence))) {
    put(CONFIDENCE_COMPONENTS.AI, { score: Number(item.confidence), reason: 'برداشت از گفتار.' });
  }
  return components;
}

/**
 * رویداد مالی و تصمیم مسیرش برای یک تراکنش.
 *
 * `aiOnly` عمداً پیش‌فرض `false` است: تراکنشی که از این مسیر می‌آید، پیش از
 * ارسال در برگهٔ تأیید به کاربر نشان داده شده. برداشت خام مدل زبانی نیست و
 * رفتار با آن مثل برداشت خام، کل صف را از ثبت‌های عادی پر می‌کرد.
 */
/**
 * آیا این جابه‌جایی پول، تسویهٔ حساب همان شخص است؟
 *
 * «۹۳ میلیون تومان به شرکت آراد گستر آسیا پرداخت شد» تا امروز یک هزینهٔ ساده
 * ثبت می‌شد. ولی وقتی به آن شرکت بدهکاریم، این پرداخت هزینهٔ تازه نمی‌سازد —
 * بدهی موجود را کم می‌کند. ثبتش به‌عنوان هزینه دو خطا با هم دارد: سود دوره
 * بی‌دلیل کم می‌شود، و بدهی آن شرکت در دفتر باز می‌ماند انگار پولی نداده‌ایم.
 *
 * تصمیم از ماندهٔ واقعی دفتر می‌آید، نه از واژه‌های جمله: پول رفت و به او
 * بدهکار بودیم → بدهی‌اش کم می‌شود؛ پول آمد و او به ما بدهکار بود → طلبمان
 * کم می‌شود. هر حالت دیگری همان ثبت عادی است.
 */
function settlementDirectionFor(item, counterpartyBalance) {
  if (!item.contactId || !Number.isFinite(Number(counterpartyBalance))) return null;
  return settlementDirection(item.type, counterpartyBalance);
}

export function transactionEventDecision(item = {}, { transcript = '', sentence = '', aiOnly = false, policy = {}, counterpartyBalance = null } = {}) {
  const baseKind = (item.unpaidSignal === true ? UNPAID_KIND[item.type] : null) || KIND_BY_TYPE[item.type];
  if (!baseKind) return null;
  const settlementDirection = settlementDirectionFor(item, counterpartyBalance);
  const kind = settlementDirection ? EVENT_KINDS.OBLIGATION_SETTLED : baseKind;
  const said = String(item.rawText || sentence || transcript || '');
  // ردیفی که از «فهم رویداد» آمده، واقعیت‌هایش را صریح و سنجیده دارد. الگوهای
  // متنی این‌جا دوباره روی همان جمله اجرا نمی‌شوند: «واریز» یا «بدهکار بودیم»
  // در یک جملهٔ مرکب، نباید هدف پرداخت یا قضاوتی را برگرداند که فهم ساختاریافته
  // جزءبه‌جزء روشن کرده است.
  const structured = item.factSource === 'understanding';
  // «بابت چه بود» وقتی خودِ جمله گفته، سؤالش پرسیده نمی‌شود.
  const receiptPurpose = item.type === 'income' ? (item.receiptPurpose || (structured ? null : receiptPurposeFromSpeech(said))) : null;
  const paymentPurpose = item.type === 'expense' ? (item.paymentPurpose || (structured ? null : paymentPurposeFromSpeech(said))) : null;
  // وام‌دهنده همان بانکی است که جمله نام برده؛ نامِ حدسی دیگر جایش را نمی‌گیرد.
  const lender = receiptPurpose === 'loan' && !structured ? lenderFromSpeech(said) : null;
  const event = normalizeFinancialEvent({
    kind,
    ...(settlementDirection ? { settlementDirection, reference: item.contactName || '' } : {}),
    amount: item.amount,
    occurredAt: item.occurredAt,
    category: item.category,
    description: item.category,
    counterparty: lender || item.contactName || '',
    counterpartyId: item.contactId || null,
    accountId: item.accountId || null,
    source: item.source === 'voice' ? 'voice' : 'text',
    // ابهام مقیاس از پارسر می‌آید و باید تا موتور تصمیم برسد، وگرنه «سی تومن»
    // بی‌صدا سی هزار ثبت می‌شود.
    amountScaleAmbiguous: item.amountScaleAmbiguous === true,
    prepaymentSignal: item.prepaymentSignal === true,
    eventNature: item.eventNature || 'new',
    // هدف خرید وقتی خودِ کاربر گفته («جنس خریدم برای فروش»)، سؤالش پرسیده نمی‌شود.
    intendedUse: item.intendedUse || (structured ? null : purchasePurposeFromSpeech(item.rawText || sentence || transcript)) || null,
    // کار تحویل شده یا جنس فروخته شده: زمان شناسایی درآمدی که هنوز پولش نیامده.
    deliveryDate: item.deliveryDate || null,
    servicePeriodStart: item.servicePeriodStart || null,
    servicePeriodEnd: item.servicePeriodEnd || null,
    // آورده و برداشت شخصی برنمی‌گردند؛ «آخر قرارداد پس می‌گیریم» یعنی برمی‌گردد.
    refundable: typeof item.refundable==='boolean' ? item.refundable
      : (receiptPurpose === 'owner' || paymentPurpose === 'owner-drawing') ? false
      : structured ? null : saysRefundable(said),
    receiptPurpose,
    paymentPurpose,
    // کل گفته، نه تکهٔ کنار مبلغ: «وانت شرکت که قیمت دفتریش چهل بود رو صد و ده
    // فروختیم» دو ردیف می‌سازد و نشانه در هیچ‌کدام از دو تکه کامل نیست.
    needsJudgment: item.needsJudgment || (structured ? null : judgmentReason(transcript || said)),
    // شاهد، عین گفتهٔ کاربر است — همان تعریف قرارداد واقعیت. جملهٔ کامل وقتی
    // فراخوان مطمئن است مالِ همین ردیف است، وگرنه تکهٔ کنار مبلغ.
    evidence: String(item.rawText || sentence || transcript || '').slice(0, 1000),
    utterance: sentence ? null : String(transcript || '').slice(0, 1000) || null,
  });
  const blockers = Array.isArray(item.reviewReasons) ? item.reviewReasons.filter(Boolean) : [];
  // تسویه بازدارنده نیست: برگهٔ تأیید پیش از ارسال صریح می‌گوید این پول به
  // حساب چه کسی می‌نشیند و بدهی فعلی‌اش چقدر است. فرستادنش به صف بررسی یعنی
  // کاربر دو بار یک چیز را تأیید کند.
  // پرچم بررسی بدون دلیلِ نوشته‌شده هم باید جلوی ثبت بی‌پرسش را بگیرد، وگرنه
  // تنها نشانهٔ تردید بی‌اثر می‌ماند.
  if (item.needsReview && !blockers.length) blockers.push('این ثبت هنگام برداشت نیازمند بررسی علامت خورده است.');

  // موتور تصمیم، اگر روشن باشد.
  //
  // خروجی‌اش دو کار می‌کند: ذخیره می‌شود (دادهٔ خام گزارش اختلاف)، و اگر
  // واقعیت لازمی کم باشد یک بازدارنده می‌سازد. بازدارنده عمداً به `blockers`
  // اضافه می‌شود و نه به مؤلفه‌های اطمینان: نبودِ دورهٔ پوشش یک نمرهٔ پایین
  // نیست، یک مانع است. میانگین بالا نباید بتواند رویش سرپوش بگذارد.
  const accountingDecision = decideForEvent(event, policy, item);
  if (accountingDecision && blocksPosting(accountingDecision)) {
    blockers.push(explainBlock(accountingDecision));
  }

  const routed = routeEvent(event, {
    components: transactionConfidenceComponents(item), blockers, aiOnly, policy,
  });
  // تصمیمی که نه قطعی است و نه با یک سؤال حل می‌شود، جایش صف حسابدار است.
  //
  // تا اینجا «نمی‌دانم» و «قاعده ندارم» فقط یک بازدارنده بودند و اگر اطمینان
  // برداشت بالا بود، مسیر «تأیید کاربر» می‌گرفتند. تأیید کاربر همان نقشهٔ
  // قدیمی نوع تراکنش را ثبت می‌کرد: وام دریافتی درآمد می‌شد، برداشت شریک
  // هزینه، و پیش‌پرداخت به تأمین‌کننده هزینهٔ همان ماه — دقیقاً همان‌جایی که
  // موتور گفته بود ماهیت را نمی‌داند. صاحب کسب‌وکار نمی‌تواند ماهیتی را تأیید
  // کند که موتور هم نمی‌داند.
  //
  // برعکسش هم برقرار است: وقتی تنها کمبود یک سؤال گزینه‌ای از ثبت‌کننده است —
  // «سی تومن یعنی سی هزار یا سی میلیون؟»، «این پول بابت چه بود؟» — جایش برگهٔ
  // خود ثبت‌کننده است، حتی اگر اطمینان برداشت پایین بوده. جوابِ او همان ابهام
  // را برطرف می‌کند و فرستادنش به حسابدار، ساده‌ترین ثبت روز را کار حسابدار
  // می‌کرد.
  const decision = accountingDecision && needsAccountant(accountingDecision)
    ? { ...routed, route: ROUTES.ACCOUNTANT_REVIEW }
    : accountingDecision?.decisionStatus === DECISION_STATUS.NEEDS_USER_INPUT && accountingDecision.question
      ? { ...routed, route: ROUTES.CONFIRM }
      // موتور ماهیت را قطعی کرده و ثبت‌کننده برگه را — با همان هشدارهای برداشت —
      // دیده و تأیید کرده. تردیدِ برداشت را خودِ او برطرف کرده؛ جای مورد برگهٔ
      // خودِ اوست، نه صف حسابدار. ثبت همچنان با یک «تأیید» آگاهانه است.
      : accountingDecision?.decisionStatus === DECISION_STATUS.DECIDED && item.userConfirmed === true && routed.route === ROUTES.ACCOUNTANT_REVIEW
        ? { ...routed, route: ROUTES.CONFIRM }
        : routed;
  return { event, decision, accountingDecision };
}

/**
 * تصمیم حسابداری این رویداد، یا `null` وقتی موتور خاموش است.
 *
 * شکست تصمیم در دفترِ دارای موتور نسخهٔ دو نباید به ثبت قطعیِ مسیر قدیمی
 * تبدیل شود؛ دروازهٔ ثبت‌کننده خطا را به کاربر برمی‌گرداند.
 */
function decideForEvent(event, policyOverrides, item) {
  const policy = resolveAutomationPolicy(policyOverrides);
  if (!policy.engineV2) return null;
  try {
    return decide(factsFromEvent(event), {
      today: item?.occurredAt || event.occurredAt, capitalizationThreshold: policy.capitalizationThreshold,
    });
  } catch (error) { throw error; }
}

/**
 * آیا این تصمیم جلوی ثبت بی‌پرسش را می‌گیرد؟
 *
 * فقط `decided` اجازه می‌دهد. چهار وضعیت دیگر هرکدام دلیل خودشان را دارند ولی
 * نتیجه‌شان یکی است: تا قبل از روشن شدن ماهیت، سند ساخته نمی‌شود.
 */
function blocksPosting(accountingDecision) {
  return accountingDecision.decisionStatus !== DECISION_STATUS.DECIDED;
}

/** وضعیتی که فقط حسابدار می‌تواند تمامش کند — نه یک سؤال ساده از کاربر. */
function needsAccountant(accountingDecision) {
  return ![DECISION_STATUS.DECIDED, DECISION_STATUS.NEEDS_USER_INPUT].includes(accountingDecision.decisionStatus);
}

/** دلیل، به زبان حسابدار — نه نام فنی وضعیت. */
function explainBlock(accountingDecision) {
  const { decisionStatus, missingFacts, question, policyKey, explanation } = accountingDecision;
  if (decisionStatus === DECISION_STATUS.NEEDS_USER_INPUT) {
    const gap = FACT_LABELS[missingFacts?.[0]] || '';
    return question?.text || (gap ? `${gap} هنوز معلوم نیست.` : 'یک اطلاعات لازم هنوز معلوم نیست.');
  }
  // خرید کالا دلیل مشخص خودش را دارد — موجودی یا دارایی ثابت — و همان به
  // حسابدار گفته می‌شود، نه جملهٔ عمومی.
  if (decisionStatus === DECISION_STATUS.UNSUPPORTED) return policyKey === 'goods-purchase' && explanation ? explanation : 'برای این ماهیت هنوز قاعدهٔ ثبتی تعریف نشده است.';
  if (decisionStatus === DECISION_STATUS.BLOCKED) return 'یک مانع ساختاری جلوی ثبت را گرفته است.';
  // دلیلِ مشخص — شریک، حقوق، تسویهٔ قبلی، مبلغ مشکوک — بهتر از جملهٔ عمومی است؛
  // حسابدار باید ببیند چرا این پرونده به او رسید. پیام فنیِ طبقه‌بند اینجا نمی‌آید.
  if (explanation && !/دوازده خانواده/.test(explanation)) return explanation;
  return 'ماهیت این رویداد برای ثبت خودکار روشن نیست.';
}
