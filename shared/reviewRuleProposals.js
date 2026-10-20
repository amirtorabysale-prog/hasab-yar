import { normalizePersian } from './normalize.js';

/**
 * پیشنهادهای «تحلیل کن» که مدل زبانی لازم ندارند.
 *
 * هر درخواست به مدل هزینه دارد، و برای بعضی پرونده‌ها جواب از پیش معلوم است:
 * موتور تصمیم ماهیت را قطعی کرده و فقط یک واقعیت کسب‌وکار کم است که از
 * حسابدار پرسیده می‌شود. پرسیدن آن واقعیت مدل نمی‌خواهد؛ ساختن سند بعد از
 * جوابش هم نه.
 *
 * - **دارایی ثابت:** نام دارایی و عمر مفیدش. بعد از جواب، سند به حساب خودِ
 *   همان دارایی می‌نشیند و در دفتر دارایی‌ها با عمر مفیدش ثبت می‌شود تا
 *   استهلاکش اجرا شود. آزمون مهر ۱۴۰۵ نشان داد مدل عمر مفید را نمی‌پرسید و
 *   دارایی روی حساب کل می‌نشست — هرگز مستهلک نمی‌شد.
 * - **حقوق:** خالص یا ناخالص، و کسور. این سؤال پیش از اولین درخواست به مدل
 *   پرسیده می‌شود؛ مدل بعد از جوابش یک بار و با دادهٔ کامل صدا زده می‌شود.
 */

const WORD_NUMBERS = Object.freeze({
  یک: 1, یه: 1, دو: 2, سه: 3, چهار: 4, پنج: 5, شش: 6, شیش: 6, هفت: 7, هشت: 8, نه: 9, ده: 10,
  یازده: 11, دوازده: 12, پانزده: 15, پونزده: 15, بیست: 20, سی: 30, چهل: 40, پنجاه: 50, شصت: 60,
});

/** «پنج سال»، «۶۰ ماه»، «60» (ماه) — به ماه. نامعتبر یعنی `null`. */
export function usefulLifeMonths(value) {
  const text = normalizePersian(String(value || ''));
  if (!text) return null;
  const digits = text.match(/(\d+(?:\.\d+)?)/);
  const word = Object.keys(WORD_NUMBERS).find((name) => new RegExp(`(?<![آ-ی])${name}(?![آ-ی])`).test(text));
  const count = digits ? Number(digits[1]) : word ? WORD_NUMBERS[word] + (/و\s*نیم/.test(text) ? 0.5 : 0) : null;
  if (!(count > 0)) return null;
  const months = /سال/.test(text) ? Math.round(count * 12) : Math.round(count);
  return months >= 1 && months <= 600 ? months : null;
}

/** نام دارایی از خودِ جمله: «یک دستگاه کپی بزرگ برای…» → «دستگاه کپی بزرگ». */
const ASSET_NAME = /(?:یک|یه)\s+((?:[^\s،,.؛\d]+\s+){0,3}?[^\s،,.؛\d]+?)\s+(?:برای|به\s*مبلغ|به\s*قیمت|از\s|با\s|\d|(?:[^\s]+\s+)?(?:میلیون|هزار|تومان|تومن))/;
export function assetNameFromSpeech(input) {
  const text = normalizePersian(String(input || ''));
  const match = ASSET_NAME.exec(text);
  const name = match?.[1]?.trim();
  return name && name.length >= 3 && name.length <= 60 ? name : null;
}

const answerOf = (answers, id) => String(answers?.[id]?.value || '').trim();

export function fixedAssetReviewProposal({ text = '', amount, decision = null, answers = {}, kind = 'cash-expense' } = {}) {
  if (decision?.treatment !== 'fixed-asset' || !Number.isSafeInteger(amount) || amount <= 0) return null;
  const name = answerOf(answers, 'asset.name') || assetNameFromSpeech(text);
  const life = usefulLifeMonths(answerOf(answers, 'asset.useful-life'));
  const questions = [
    ...(name ? [] : [{ id: 'asset.name', text: 'نام این دارایی چیست؟ (مثلاً «دستگاه کپی»)' }]),
    ...(life ? [] : [{ id: 'asset.useful-life', text: `عمر مفید ${name ? `«${name}»` : 'این دارایی'} چند سال یا چند ماه است؟` }]),
  ];
  const summary = `خرید دارایی ثابت${name ? ` «${name}»` : ''}`;
  if (questions.length) {
    return {
      summary, questions, missingFacts: [], lines: [],
      explanation: 'بالای حد سرمایه‌ای شدن دفتر است و دارایی ثابت می‌شود، نه هزینهٔ این ماه. برای استهلاک، نام دارایی و عمر مفیدش لازم است.',
    };
  }
  const credit = kind === 'payable-opened' ? { role: 'payable', debit: 0, credit: amount } : { role: 'cash', debit: 0, credit: amount };
  return {
    summary, questions: [], missingFacts: [],
    explanation: `بالای حد سرمایه‌ای شدن دفتر است؛ «${name}» دارایی ثابت می‌شود و با عمر مفید ${life} ماه از ماه خرید مستهلک می‌شود.`,
    lines: [{ role: 'fixed-asset', key: name, debit: amount, credit: 0 }, credit],
    fixedAsset: { name, usefulLifeMonths: life },
  };
}

/**
 * آنچه جمله گفته، دوباره پرسیده نمی‌شود: «حقوق مهر ۳۰ میلیون خالص بود» خالص بودن را گفته و
 * فقط کسورش مانده (آزمون صف روی سایت، ۲۹ مهر ۱۴۰۵). شناسهٔ سؤال همان می‌ماند تا جوابِ قبلی
 * و مسیرِ پس از آن عوض نشود.
 */
const NET_SAID = /(?<![آ-ی])خالص(?![آ-ی])/;
const GROSS_SAID = /(?<![آ-ی])ناخالص(?![آ-ی])/;
export function payrollReviewQuestion({ category = '', answers = {}, text = '' } = {}) {
  if (String(category).trim() !== 'حقوق و دستمزد' || answerOf(answers, 'payroll.gross-or-net')) return null;
  const said = normalizePersian(String(text || ''));
  const question = GROSS_SAID.test(said)
    ? 'مبلغ ناخالص گفته شده؛ بیمه و مالیات کسرشده چقدر بود و چقدر واقعاً پرداخت شد؟'
    : NET_SAID.test(said)
      ? 'مبلغ خالص گفته شده؛ بیمه و مالیات کسرشدهٔ این حقوق چقدر بود؟ اگر کسوری نداشت، بنویس «کسوری نداشت».'
      : 'این مبلغ خالص پرداختی به کارکنان است یا ناخالص حقوق؟ اگر بیمه و مالیات کسر شده، مبلغ هرکدام را هم بنویس.';
  return {
    summary: 'پرداخت حقوق',
    explanation: 'حقوق کسور بیمه و مالیات دارد؛ پیش از پیشنهاد سند، باید معلوم شود این مبلغ خالص پرداختی است یا ناخالص و کسورش چقدر است.',
    questions: [{ id: 'payroll.gross-or-net', text: question }],
    missingFacts: [], lines: [],
  };
}
