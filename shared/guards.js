import { ECONOMIC_FAMILIES } from './economicFamily.js';
import { ROLES, planJournal } from './accountingRules.js';

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

const GUARDS = Object.freeze([internalTransferGuard]);

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

  for (const guard of GUARDS) {
    let result;
    // نگهبان خراب نباید مسیر را بشکند، ولی نباید هم بی‌صدا از رویداد رد شود:
    // شکستش خودش یک مانع است و مورد به حسابدار می‌رود.
    try { result = guard(event, facts, context); }
    catch (error) { result = check(guard.name || 'guard', GUARD_VERDICTS.BLOCK, `نگهبان اجرا نشد: ${error.message}`); }
    checks.push(result);

    if (result.verdict === GUARD_VERDICTS.BLOCK) { verdict = GUARD_VERDICTS.BLOCK; reason = result.reason; break; }
    if (result.verdict === GUARD_VERDICTS.REWRITE && verdict === GUARD_VERDICTS.PASS) {
      verdict = GUARD_VERDICTS.REWRITE; reason = result.reason; plan = result.plan || null;
    }
  }

  return Object.freeze({ verdict, reason, plan, checks: Object.freeze(checks) });
}

/**
 * نقشهٔ نهایی سند — با در نظر گرفتن حکم نگهبان‌ها.
 *
 * نگهبانی که ماهیت را تصحیح کرده، نقشهٔ خودش را می‌دهد؛ وگرنه قاعدهٔ عادی.
 * این تابع تنها جایی است که این دو با هم جمع می‌شوند، تا هیچ مسیری نتواند
 * نقشه را بدون عبور از نگهبان بسازد.
 */
export function guardedPlan(event, decision, guardResult) {
  if (guardResult?.verdict === GUARD_VERDICTS.REWRITE && guardResult.plan) return guardResult.plan;
  return planJournal(event, decision);
}
