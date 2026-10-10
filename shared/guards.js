import { ECONOMIC_FAMILIES } from './economicFamily.js';
import { ROLES, planJournal, applyFunding } from './accountingRules.js';
import { SETTLEMENT_MATCH, matchOpenDocument } from './settlementMatch.js';
import { EVENT_KINDS } from './financialEvent.js';
import { VAT_FORMS, readVatMention, splitInclusive } from './vatSpeech.js';

/**
 * نگهبان‌ها — ایست بازرسی پیش از ورود به دفتر.
 *
 * چرا این لایه جدا از موتور تصمیم است:
 *
 * تصمیم می‌گوید «این رویداد از نظر اقتصادی چیست». نگهبان می‌پرسد «آیا اصلاً
 * باید چیزی ثبت شود، و اگر بله، آیا آنچه قرار است ثبت شود ایمن است». این دو
 * سؤال متفاوت‌اند: رویدادی می‌تواند ماهیتش کاملاً روشن باشد و باز هم ثبتش
 * اشتباه باشد — چون تکراری است، چون تعهد موجودی را می‌بندد، یا چون اصل مبلغ
 * هرگز نباید به سود و زیان بخورد.
 *
 * خطاهای کشندهٔ یک سیستم حسابداری خودکار، خطاهای «ماهیت» نیستند؛ خطاهای
 * «تکرار» و «درآمد جعلی» هستند. یک پیش‌پرداخت که اشتباه هزینه شده در بستن سال
 * پیدا می‌شود. یک چک که سه بار درآمد ساخته، پیدا نمی‌شود.
 *
 * ترتیب اجرا: پس از تصمیم، پیش از قاعده. نگهبان تسویه باید بداند ماهیت چیست
 * تا بفهمد آیا این «درآمد یا هزینهٔ تازه» است که باید جلویش را بگیرد.
 */

export const GUARD_VERDICTS = Object.freeze({
  /** چیزی پیدا نشد؛ رویداد همان‌طور که بود ادامه می‌دهد. */
  PASS: 'pass',
  /** ثبت نباید انجام شود؛ مورد با دلیل خوانا به صف می‌رود. */
  BLOCK: 'block',
  /** ماهیت اشتباه است ولی رویداد درست؛ نقشهٔ سند عوض می‌شود. */
  REWRITE: 'rewrite',
});

function check(name, verdict, reason, extra = {}) {
  // `checked` همیشه `true` است و این عمدی است: «نگهبان اجرا شد و چیزی نیافت»
  // با «نگهبان اجرا نشد» یکی نیست. بدون این تفاوت نمی‌شود ثابت کرد نگهبان
  // روی همهٔ مسیرها رفته، و گزارش اختلاف فاز بعد هم نمی‌تواند بگوید موتور
  // کجا نگاه کرد و چه دید.
  return Object.freeze({ name, verdict, reason, checked: true, ...extra });
}

/**
 * نگهبان انتقال داخلی.
 *
 * پول از یک جیب کسب‌وکار به جیب دیگرش رفته. اگر از مسیر عادی رد شود، یک بار
 * هزینهٔ حساب مبدأ ثبت می‌شود و سود دوره بی‌دلیل کم می‌شود — و برخلاف خطای
 * پیش‌پرداخت، این هیچ‌وقت خودش را اصلاح نمی‌کند.
 *
 * حکمش `rewrite` است نه `block`: سیستم جواب درست را می‌داند، پس فرستادنش به
 * صف حسابدار فقط اصطکاک است.
 */
function internalTransferGuard(event, facts, { decision }) {
  const isTransfer = decision?.family === ECONOMIC_FAMILIES.INTERNAL_TRANSFER
    || (event.accountId && event.destinationAccountId && event.accountId !== event.destinationAccountId);
  if (!isTransfer) return check('internal-transfer', GUARD_VERDICTS.PASS, 'جابه‌جایی بین حساب‌های خود دفتر نبود.');

  return check('internal-transfer', GUARD_VERDICTS.REWRITE,
    'این جابه‌جایی بین دو حساب خودِ دفتر است؛ نه هزینه است و نه درآمد.', {
      plan: {
        kind: 'internal-transfer',
        lines: [
          { role: ROLES.CASH, key: event.destinationAccountId, debit: event.amount, credit: 0 },
          { role: ROLES.CASH, key: event.accountId, debit: 0, credit: event.amount },
        ],
        memoHint: 'انتقال بین حساب‌ها',
      },
    });
}

/**
 * نگهبان «اول تسویه».
 *
 * پیش از ساختن هر درآمد یا هزینهٔ تازه، اسناد باز آن طرف حساب بررسی می‌شوند.
 * «۹۳ میلیون به شرکت آراد پرداخت کردم» وقتی به او بدهکاریم، هزینهٔ تازه
 * نمی‌سازد — بدهی موجود را می‌بندد. ثبتش به‌عنوان هزینه دو خطا با هم دارد: سود
 * دوره بی‌دلیل کم می‌شود، و بدهی آن شرکت در دفتر باز می‌ماند انگار پولی
 * نداده‌ایم.
 *
 * `openDocuments === null` یعنی بررسی **ممکن نبود** — طرف حساب شناسایی نشده.
 * این با «بررسی شد و چیزی نبود» یکی نیست و همین تفاوت، چیزی است که امروز در
 * `transactionEvent.js` بی‌صدا گم می‌شود.
 */
function settlementFirstGuard(event, facts, { openDocuments }) {
  const name = 'settlement-first';
  if (openDocuments === null || openDocuments === undefined) {
    return check(name, GUARD_VERDICTS.PASS,
      'بررسی تسویه ممکن نبود، چون طرف حساب شناسایی نشده است.', { openDocumentCount: null });
  }

  const match = matchOpenDocument({ amount: event.amount, moneyDirection: facts.moneyDirection }, openDocuments);
  const counted = { openDocumentCount: openDocuments.length };

  if (match.kind === SETTLEMENT_MATCH.NONE) {
    return check(name, GUARD_VERDICTS.PASS, 'سند بازی که با این مبلغ بخواند پیدا نشد.', counted);
  }

  // ابهام حدس نمی‌زند. بستن سند اشتباه در تراز دیده نمی‌شود و هیچ‌وقت پیدا
  // نمی‌شود — بدترین نوع خطا.
  if (match.kind === SETTLEMENT_MATCH.AMBIGUOUS) {
    const names = match.candidates.map((document) => document.reference).filter(Boolean).join(' یا ');
    return check(name, GUARD_VERDICTS.BLOCK,
      `این مبلغ با بیش از یک سند باز می‌خواند (${names}); کدام‌یک بسته شود؟`, counted);
  }

  const document = match.document;
  const settling = document.direction === 'payable';
  const partial = match.kind === SETTLEMENT_MATCH.PARTIAL ? ' (تسویهٔ جزئی)' : '';
  return check(name, GUARD_VERDICTS.REWRITE,
    `این پول «${document.reference}» را می‌بندد${partial}؛ هزینه یا درآمد تازه‌ای ساخته نمی‌شود.`, {
      ...counted,
      settlement: { documentKind: document.kind, documentId: document.id, reference: document.reference, matchKind: match.kind },
      plan: {
        kind: 'settlement',
        lines: settling
          ? [
            { role: ROLES.PAYABLE, key: event.counterparty, debit: event.amount, credit: 0 },
            { role: ROLES.CASH, key: event.accountId, debit: 0, credit: event.amount },
          ]
          : [
            { role: ROLES.CASH, key: event.accountId, debit: event.amount, credit: 0 },
            { role: ROLES.RECEIVABLE, key: event.counterparty, debit: 0, credit: event.amount },
          ],
        memoHint: document.reference,
      },
    });
}

/**
 * نگهبان تفکیک ارزش افزوده.
 *
 * ارزش افزوده پول سازمان امور مالیاتی است که کسب‌وکار در فروش جمعش می‌کند و
 * در خرید جلو می‌دهد. هیچ‌کدام درآمد یا هزینه نیست. ولی تا امروز «۱۱۰ میلیون
 * فروختم با ارزش افزوده» کل ۱۱۰ میلیون را درآمد می‌کرد: سود دوره ده میلیون
 * باد می‌کرد، مالیات عملکرد روی پولِ سازمان حساب می‌شد، و بدهی ارزش افزوده
 * در دفتر اصلاً ساخته نمی‌شد — پس تسویهٔ دوره هم چیزی برای بستن نداشت.
 *
 * سه حالت، سه حکم:
 *
 *   مالیات داخل مبلغ      → `rewrite`: خالص به همان سطر، مالیات به حساب ارزش افزوده
 *   پرداخت به سازمان      → `rewrite`: بدهی مالیات فروش بسته می‌شود، نه هزینه
 *   هرچه مبهم است         → `block`: مالیات بیرون از مبلغ، نرخ ناشناخته، ماندهٔ ناکافی
 *
 * `context.vat` نبودش یعنی «نتوانستم بررسی کنم» و برخلاف نگهبان تسویه، اینجا
 * مانع است: پیش‌فرض ناامن این نگهبان «کل مبلغ در سود و زیان» است، و وقتی
 * کاربر خودش گفته ارزش افزوده در کار است، آن پیش‌فرض قطعاً غلط است.
 */
const VAT_SPLIT_KINDS = new Set([EVENT_KINDS.CASH_EXPENSE, EVENT_KINDS.CASH_INCOME, EVENT_KINDS.FIXED_ASSET_PURCHASE]);
const SETTLING_KINDS = new Set([EVENT_KINDS.OBLIGATION_SETTLED, EVENT_KINDS.INVOICE_PAYMENT]);

const percentOf = (bps) => `${Number(bps) / 100} درصد`;

/**
 * نرخی که این رویداد با آن تفکیک می‌شود، یا دلیل اینکه نمی‌شود.
 *
 * نرخ گفته‌شده فقط وقتی پذیرفته است که یکی از نرخ‌های مشمول همین دفتر باشد:
 * «۹ درصد» نرخ سال قبل است، و سند با نرخی که در دفتر تعریف نشده، مانده‌ای
 * می‌سازد که گزارش مالیاتی دوره هرگز با آن نمی‌خواند.
 */
function vatRateFor(mention, vat) {
  const rates = Array.isArray(vat.ratesBps) ? vat.ratesBps : [];
  if (mention.ratePercent !== null) {
    const stated = Math.round(mention.ratePercent * 100);
    return rates.includes(stated)
      ? { rateBps: stated }
      : { reason: `نرخ ${percentOf(stated)} در نرخ‌های مشمول این دفتر تعریف نشده است.` };
  }
  if (Number.isFinite(vat.rateBps) && vat.rateBps > 0) return { rateBps: vat.rateBps };
  return { reason: rates.length > 1
    ? 'این دفتر چند نرخ مشمول دارد و هیچ‌کدام پیش‌فرض نیست؛ کدام نرخ؟'
    : 'نرخ ارزش افزودهٔ مشمول در این دفتر تعریف نشده است.' };
}

function vatSplitGuard(event, facts, { decision, vat, sentence, rewrittenBy }) {
  const name = 'vat-split';
  const mention = readVatMention(sentence || facts.evidence || '');
  const noted = { vatForm: mention.form };

  if (mention.form === VAT_FORMS.NONE) return check(name, GUARD_VERDICTS.PASS, 'حرفی از ارزش افزوده نبود.', noted);
  if (mention.form === VAT_FORMS.EXEMPT) return check(name, GUARD_VERDICTS.PASS, 'صریحاً گفته شده ارزش افزوده ندارد.', noted);
  // جریمه و دیرکرد هزینهٔ واقعی‌اند، نه تسویهٔ مالیات؛ مسیر عادی درست است.
  if (mention.penalty) return check(name, GUARD_VERDICTS.PASS, 'جریمهٔ مالیاتی هزینه است، نه پرداخت ارزش افزوده.', noted);
  // انتقال داخلی و تسویه، ارزش افزودهٔ تازه‌ای نمی‌سازند: مالیاتِ یک فاکتور
  // همان روزی شناسایی شده که فاکتور ثبت شد. تفکیک دوباره‌اش اینجا، همان مالیات
  // را دو بار در دفتر می‌نشاند.
  if (rewrittenBy) {
    return check(name, GUARD_VERDICTS.PASS, `ماهیت را نگهبان «${rewrittenBy}» عوض کرد؛ ارزش افزوده در سند اصلی شناسایی شده است.`, noted);
  }
  if (SETTLING_KINDS.has(event.kind)) {
    return check(name, GUARD_VERDICTS.PASS, 'تسویهٔ تعهد قبلی است؛ ارزش افزوده همان‌جا شناسایی شده است.', noted);
  }
  if (mention.refund) {
    return check(name, GUARD_VERDICTS.BLOCK, 'استرداد ارزش افزوده اعتبار مالیاتی را کم می‌کند و درآمد نیست؛ حسابدار باید ببیند.', noted);
  }

  const direction = facts.moneyDirection;
  // پرداخت به سازمان: پول رفته، ارزش افزوده موضوع جمله است و خرید و فروشی در
  // کار نیست.
  if (mention.form === VAT_FORMS.BARE && direction === 'out' && !mention.trade) {
    // «اظهارنامه ارسال شد، بدهی قابل پرداخت ۲۷ میلیون شد» پرداخت نیست. بستن
    // بدهی با پولی که نرفته، ماندهٔ بانک را غلط می‌گذارد.
    if (!mention.paid) {
      return check(name, GUARD_VERDICTS.BLOCK, 'از ارزش افزوده گفته شده ولی پرداختی انجام نشده؛ ثبت بدهی اظهارنامه کار حسابدار است.', noted);
    }
    if (!vat) return check(name, GUARD_VERDICTS.BLOCK, 'ماندهٔ ارزش افزودهٔ دفتر بررسی نشد؛ این پرداخت بدون آن ثبت نمی‌شود.', noted);
    const outputTax = Math.max(0, Number(vat.outputTax) || 0);
    if (outputTax < event.amount) {
      return check(name, GUARD_VERDICTS.BLOCK,
        `ماندهٔ مالیات فروش در دفتر ${outputTax.toLocaleString('fa-IR')} است و این پرداخت ${Number(event.amount).toLocaleString('fa-IR')}؛ شاید دوره‌های قبل در دفتر نیامده‌اند.`,
        { ...noted, outputTax });
    }
    return check(name, GUARD_VERDICTS.REWRITE, 'این پرداخت بدهی ارزش افزوده به سازمان را می‌بندد؛ هزینه نیست.', {
      ...noted, outputTax,
      plan: {
        kind: 'vat-remittance',
        lines: [
          { role: ROLES.VAT_OUTPUT, key: null, debit: event.amount, credit: 0 },
          { role: ROLES.CASH, key: event.accountId, debit: 0, credit: event.amount },
        ],
        memoHint: 'پرداخت ارزش افزوده',
      },
    });
  }

  if (mention.form === VAT_FORMS.EXCLUSIVE) {
    return check(name, GUARD_VERDICTS.BLOCK, 'مبلغ بدون ارزش افزوده گفته شده؛ پولی که واقعاً جابه‌جا شد چقدر بود؟', noted);
  }
  if (mention.form === VAT_FORMS.BARE) {
    return check(name, GUARD_VERDICTS.BLOCK, 'ارزش افزوده گفته شده ولی معلوم نیست داخل این مبلغ است یا جدا از آن.', noted);
  }

  // از اینجا: مالیات داخل مبلغ است.
  if (!VAT_SPLIT_KINDS.has(event.kind) || !['in', 'out'].includes(direction)) {
    return check(name, GUARD_VERDICTS.BLOCK, 'تفکیک ارزش افزوده برای این نوع سند هنوز قاعده ندارد.', noted);
  }
  if (!vat) return check(name, GUARD_VERDICTS.BLOCK, 'نرخ‌های ارزش افزودهٔ دفتر بررسی نشد؛ تفکیک بدون آن ممکن نیست.', noted);

  const registered = Array.isArray(vat.ratesBps) && vat.ratesBps.length > 0;
  // دفتری که مشمول نیست اعتبار خرید ندارد: مالیاتی که پرداخته جزو بهای همان
  // خرید است. جدا کردنش، دارایی‌ای می‌ساخت که هیچ‌وقت قابل استفاده نیست.
  if (!registered && direction === 'out') {
    return check(name, GUARD_VERDICTS.PASS, 'این دفتر مشمول ارزش افزوده نیست؛ مالیات خرید جزو بهای خرید می‌ماند.', noted);
  }
  const rate = vatRateFor(mention, vat);
  if (!rate.rateBps) return check(name, GUARD_VERDICTS.BLOCK, rate.reason, noted);
  const split = splitInclusive(event.amount, rate.rateBps);
  if (!split) return check(name, GUARD_VERDICTS.BLOCK, 'مبلغ برای تفکیک ارزش افزوده معتبر نیست.', noted);

  // تفکیک روی نقشهٔ خودِ تصمیم سوار می‌شود، نه روی یک نقشهٔ ثابت: خرید بیمهٔ
  // یک‌ساله با ارزش افزوده، خالصش پیش‌پرداخت است نه هزینه، و خرید دارایی ثابت
  // خالصش بهای دارایی.
  const base = planJournal(event, decision);
  const counterLine = base.lines.find((line) => line.role !== ROLES.CASH);
  if (base.lines.length !== 2 || !counterLine) {
    return check(name, GUARD_VERDICTS.BLOCK, 'سند این رویداد شکل ساده ندارد و تفکیک خودکار ممکن نیست.', noted);
  }
  const selling = direction === 'in';
  const lines = base.lines.map((line) => (line === counterLine
    ? { ...line, debit: line.debit ? split.net : 0, credit: line.credit ? split.net : 0 }
    : { ...line }));
  lines.push(selling
    ? { role: ROLES.VAT_OUTPUT, key: null, debit: 0, credit: split.tax }
    : { role: ROLES.VAT_INPUT, key: null, debit: split.tax, credit: 0 });

  return check(name, GUARD_VERDICTS.REWRITE,
    `${percentOf(rate.rateBps)} ارزش افزوده از مبلغ جدا شد؛ ${split.tax.toLocaleString('fa-IR')} ${selling ? 'بدهی به سازمان' : 'اعتبار مالیاتی'} است، نه ${selling ? 'درآمد' : 'هزینه'}.`, {
      ...noted, rateBps: rate.rateBps, net: split.net, tax: split.tax,
      plan: { kind: `${base.kind}+vat`, lines, memoHint: base.memoHint },
    });
}

const GUARDS = Object.freeze([internalTransferGuard, settlementFirstGuard, vatSplitGuard]);

/**
 * همهٔ نگهبان‌ها را روی یک تلاش ثبت اجرا می‌کند.
 *
 * بدون استثنا برای هیچ خانواده‌ای: وقتی همه یک امضا دارند، اجرای همه‌شان یک
 * حلقه است و جاانداختن یکی‌شان ممکن نیست.
 *
 * خروجی همیشه فهرست کامل بررسی‌ها را دارد، حتی آن‌هایی که چیزی پیدا نکردند.
 */
export function runGuards(event, facts = {}, context = {}) {
  const checks = [];
  let verdict = GUARD_VERDICTS.PASS;
  let reason = '';
  let plan = null;
  let rewrittenBy = null;

  for (const guard of GUARDS) {
    let result;
    // نگهبان خراب نباید مسیر را بشکند، ولی نباید هم بی‌صدا از رویداد رد شود:
    // شکستش خودش یک مانع است و مورد به حسابدار می‌رود.
    //
    // `rewrittenBy` به نگهبان‌های بعدی می‌گوید ماهیت قبلاً عوض شده: تسویه‌ای
    // که بدهی فاکتور را می‌بندد نباید دوباره ارزش افزوده بسازد.
    try { result = guard(event, facts, { ...context, rewrittenBy }); }
    catch (error) { result = check(guard.name || 'guard', GUARD_VERDICTS.BLOCK, `نگهبان اجرا نشد: ${error.message}`); }
    checks.push(result);

    if (result.verdict === GUARD_VERDICTS.BLOCK) { verdict = GUARD_VERDICTS.BLOCK; reason = result.reason; break; }
    if (result.verdict === GUARD_VERDICTS.REWRITE && verdict === GUARD_VERDICTS.PASS) {
      verdict = GUARD_VERDICTS.REWRITE; reason = result.reason; plan = result.plan || null; rewrittenBy = result.name;
    }
  }

  return Object.freeze({ verdict, reason, plan, rewrittenBy, checks: Object.freeze(checks) });
}

/**
 * نقشهٔ نهایی سند — با در نظر گرفتن حکم نگهبان‌ها.
 *
 * نگهبانی که ماهیت را تصحیح کرده، نقشهٔ خودش را می‌دهد؛ وگرنه قاعدهٔ عادی.
 * این تابع تنها جایی است که این دو با هم جمع می‌شوند، تا هیچ مسیری نتواند
 * نقشه را بدون عبور از نگهبان بسازد.
 */
export function guardedPlan(event, decision, guardResult) {
  if (guardResult?.verdict !== GUARD_VERDICTS.REWRITE || !guardResult.plan) return planJournal(event, decision);
  const { lines } = guardResult.plan;
  const debit = lines.reduce((sum, line) => sum + line.debit, 0);
  const credit = lines.reduce((sum, line) => sum + line.credit, 0);
  // نقشهٔ نگهبان از `plan()` قواعد رد نمی‌شود، پس توازنش همین‌جا کنترل می‌شود.
  if (debit !== credit || debit !== event.amount) {
    throw Object.assign(new Error('نقشهٔ اصلاح‌شدهٔ نگهبان متوازن نیست.'), { code: 'GUARD_PLAN_UNBALANCED', status: 500 });
  }
  // نام نگهبان روی نقشه می‌ماند. لایهٔ ثبت با همین می‌فهمد این نقشه را نباید
  // با سندِ جاافتادهٔ تراکنش عوض کند — آن مسیر فقط هزینه و درآمد می‌شناسد.
  return applyFunding({ ...guardResult.plan, guard: guardResult.rewrittenBy }, event);
}

/** آیا این نقشه را نگهبانی بازنویسی کرده است؟ */
export function isGuardPlan(plan) {
  return Boolean(plan?.guard);
}
