/**
 * گفتار حساب‌های بانکی: ساخت حساب و جابه‌جایی پول میان حساب‌های خودمان.
 *
 * چرا جدا از مسیر عمومی: «دو میلیون از صندوق به بانک ملت واریز شد» نه درآمد
 * است نه هزینه — پول از جیبی به جیب دیگرِ همین کسب‌وکار رفته. اگر از مسیر
 * عادی رد شود، یک بار درآمدِ بانک ثبت می‌شود و یک بار هزینهٔ صندوق، و سود
 * دوره دو بار جعل می‌شود. این جابه‌جایی باید سند دوطرفهٔ خودش را داشته باشد
 * که هیچ اثری بر سود و زیان ندارد.
 *
 * و «حساب بانک ملت را بساز»: تا امروز ساختن حساب فقط از تنظیمات ممکن بود.
 * وسط کار روزانه، فرستادن کاربر به تنظیمات یعنی رها کردن همان کاری که داشت
 * می‌کرد.
 */

import { normalizePersian } from './normalize.js';
import { BANKS, detectBank } from './banks.js';
import { parseFinancialText } from './parser.js';

const CREATE_PATTERNS = [
  /(?:حساب|اکانت)\s+.*?(?:بساز|ایجاد\s*کن|اضافه\s*کن|باز\s*کن)/,
  /(?:بساز|ایجاد\s*کن|اضافه\s*کن|باز\s*کن)\s+.*?(?:حساب|بانک)/,
];

const TRANSFER_WORDS = /(?:واریز|انتقال|منتقل|ریختم|ریختیم|جابه\s*جا|جابجا)/;
const WITHDRAW_WORDS = /(?:برداشت|برداشتم|برداشتیم|خارج\s*شد)/;
const OPENING_WORDS = /(?:موجودی|مانده|با\s*موجودی|موجودی\s*اولیه)/;

/** «صندوق» همیشه یک حساب است، حتی وقتی کاربر نامش را دقیق نگوید. */
const CASH_WORDS = ['صندوق', 'نقد', 'نقدی', 'کش'];

/**
 * هر حسابی که در جمله نام برده شده، با جای دقیقش.
 *
 * جا مهم است، چون جهت پول را حرف اضافهٔ پیش از نام تعیین می‌کند: «از صندوق
 * به بانک ملت» با «از بانک ملت به صندوق» دو چیز مخالف‌اند و اشتباه‌گرفتنشان
 * یعنی مانده‌ی هر دو حساب وارونه می‌شود.
 */
export function mentionedAccounts(input, accounts = []) {
  const text = normalizePersian(input);
  const found = [];
  const push = (index, account) => {
    if (index < 0 || found.some((item) => item.account.id === account.id)) return;
    found.push({ index, account });
  };

  for (const account of accounts) {
    if (account.active === false) continue;
    const name = normalizePersian(account.name || '');
    if (name.length > 1) push(text.indexOf(name), account);
  }
  // نام بانکِ حساب هم همان حساب را نشان می‌دهد: کاربر «بانک ملت» می‌گوید،
  // نه «جاری ملت».
  for (const account of accounts) {
    if (account.active === false || !account.bankId) continue;
    const bank = BANKS.find((item) => item.id === account.bankId);
    for (const alias of bank ? [bank.name, ...(bank.strong || [])] : []) {
      const index = text.indexOf(normalizePersian(alias));
      if (index >= 0) { push(index, account); break; }
    }
  }
  for (const account of accounts) {
    if (account.active === false || account.kind !== 'cash') continue;
    for (const word of CASH_WORDS) {
      const index = text.indexOf(word);
      if (index >= 0) { push(index, account); break; }
    }
  }
  return found.sort((left, right) => left.index - right.index);
}

/** حرف اضافهٔ درست پیش از نام: «از» مبدأ است و «به» مقصد. */
function prepositionBefore(text, index) {
  const before = text.slice(Math.max(0, index - 14), index);
  if (/\bاز\s*$/.test(before) || /از\s+\S{0,6}$/.test(before)) return 'from';
  if (/\bبه\s*$/.test(before) || /به\s+\S{0,6}$/.test(before)) return 'to';
  return '';
}

/**
 * نیت جمله‌های بخش تطبیق بانک.
 *
 * `null` یعنی این جمله کار این بخش نیست و باید به مسیر عمومی ثبت برود — یک
 * هزینه یا درآمد معمولی که حسابش بانک است.
 */
export function detectBankMovementIntent(input, { accounts = [], now = new Date() } = {}) {
  const text = normalizePersian(input);
  if (!text) return null;
  const parsed = parseFinancialText(input, { source: 'voice', now });
  const amount = parsed.transactions.reduce((largest, item) => Math.max(largest, Number(item.amount) || 0), 0);

  // ۱) ساخت حساب. پیش از بقیه سنجیده می‌شود چون «حساب بانک ملت را بساز و ده
  //    میلیون موجودی‌اش کن» هم فعل ساخت دارد هم مبلغ.
  if (CREATE_PATTERNS.some((pattern) => pattern.test(text))) {
    const bank = detectBank(input);
    if (bank) {
      return {
        intent: 'create-account',
        bankId: bank.bankId,
        bankName: bank.bankName,
        openingBalance: OPENING_WORDS.test(text) ? amount : 0,
        transcript: text,
      };
    }
  }

  if (!amount) return null;
  const mentions = mentionedAccounts(input, accounts);
  const sides = mentions.map((item) => ({ ...item, role: prepositionBefore(text, item.index) }));
  const from = sides.find((item) => item.role === 'from');
  const to = sides.find((item) => item.role === 'to');

  // ۲) انتقال میان دو حساب خودمان — نه درآمد، نه هزینه.
  if (from && to && from.account.id !== to.account.id) {
    return {
      intent: 'transfer', amount,
      fromAccountId: from.account.id, fromName: from.account.name,
      toAccountId: to.account.id, toName: to.account.name,
      transcript: text,
    };
  }

  // ۳) یک طرف گفته شده: «دو میلیون به بانک ملت واریز شد». طرف دیگر را
  //    کاربر انتخاب می‌کند؛ حدس‌زدنش یعنی پول از حسابی کم شود که کسی
  //    نگفته.
  const single = to || from || (sides.length === 1 ? sides[0] : null);
  if (single && (TRANSFER_WORDS.test(text) || WITHDRAW_WORDS.test(text))) {
    const incoming = single.role === 'to' || (!single.role && TRANSFER_WORDS.test(text) && !WITHDRAW_WORDS.test(text));
    return {
      intent: 'transfer', amount, partial: true,
      ...(incoming
        ? { toAccountId: single.account.id, toName: single.account.name }
        : { fromAccountId: single.account.id, fromName: single.account.name }),
      transcript: text,
    };
  }

  return null;
}
