// از DNA مالی به تصمیمِ پیش از ثبت.
//
// تا امروز DNA فقط یک برگهٔ تماشایی بود و هیچ تصمیمی را عوض نمی‌کرد. تنها کنترل
// مبلغِ پیش از ثبت، مقایسه با میانگین کلی همهٔ ثبت‌ها بود؛ میانگینی که خرید ملک و
// خرید نان را با هم جمع می‌کند و برای دفتری با دامنهٔ مبلغ زیاد عملاً هیچ‌وقت
// روشن نمی‌شود.
//
// اینجا همان گفته با عادت خودِ همان دسته در همان پرونده سنجیده می‌شود. قاعدهٔ
// سخت DNA اینجا هم برقرار است: بدون دادهٔ کافی هیچ ادعایی نمی‌شود.

/** زیر این تعداد ثبت در یک دسته، «معمول» هنوز معنایی ندارد. */
export const DNA_SIGNAL_MINIMUM_SAMPLES = 6;

/** چند برابر مبلغ معمولِ همان دسته، «خارج از عادت» شمرده می‌شود. */
export const DNA_AMOUNT_RATIO = 4;

const money = (value) => new Intl.NumberFormat('fa-IR').format(Math.round(value));

function profileFor(profiles, type, category) {
  return (profiles?.categories || []).find((item) => item.type === type && item.category === category) || null;
}

/**
 * نشانه‌های انحراف یک برداشت از الگوی خودِ پرونده.
 * هر پیام شاهدش را با خود می‌آورد؛ «غیرعادی است» بدون عدد، قابل قضاوت نیست.
 */
export function dnaSignals(profiles, transaction = {}) {
  const signals = [];
  if (!profiles || !Array.isArray(profiles.categories) || !profiles.categories.length) return signals;
  const amount = Math.round(Number(transaction.amount) || 0);
  const type = transaction.type === 'income' ? 'income' : 'expense';
  const category = String(transaction.category || '').trim();
  if (amount <= 0 || !category) return signals;

  const profile = profileFor(profiles, type, category);
  if (profile && profile.count >= DNA_SIGNAL_MINIMUM_SAMPLES && profile.median > 0 && amount >= profile.median * DNA_AMOUNT_RATIO) {
    signals.push({
      code: 'dna-amount-out-of-pattern',
      message: `مبلغ «${category}» در این پرونده معمولاً ${money(profile.median)} تومان است؛ این ثبت ${Math.round(amount / profile.median)} برابر آن است.`,
    });
  }

  // دستهٔ تازه فقط وقتی معنا دارد که پرونده سابقهٔ کافی داشته باشد؛ وگرنه هر ثبت
  // اول هر دسته پرچم می‌خورد و صف بررسی بی‌مصرف می‌شود.
  if (!profile && profiles.totalRows >= 20) {
    signals.push({
      code: 'dna-unseen-category',
      message: `«${category}» تا امروز در این پرونده ثبت نشده است؛ اگر دستهٔ درستی نیست همین‌جا عوضش کن.`,
    });
  }
  return signals;
}

/**
 * نشانه‌ها را روی نتیجهٔ پارس می‌نشاند.
 * چیزی خودکار ثبت یا رد نمی‌شود؛ فقط ردیف به صف «نیازمند بررسی» می‌رود تا کاربر
 * پیش از تأیید ببیندش.
 */
export function applyDnaSignals(result, profiles) {
  if (!result?.transactions?.length || !profiles) return result;
  return {
    ...result,
    transactions: result.transactions.map((item) => {
      const signals = dnaSignals(profiles, item);
      if (!signals.length) return item;
      return {
        ...item,
        needsReview: true,
        reviewState: item.reviewState === 'unintelligible' ? item.reviewState : 'review',
        reviewReasons: [...new Set([...(item.reviewReasons || []), ...signals.map((signal) => signal.message)])],
      };
    }),
  };
}
