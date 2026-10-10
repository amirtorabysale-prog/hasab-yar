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
import { BANKS, detectBank, detectTransferBanks } from './banks.js';
import { parseFinancialText } from './parser.js';
import { pickPettyCashAccount, readPettyCash } from './pettyCashSpeech.js';

/**
 * «پنج میلیون تنخواه به رضایی دادیم»، «تنخواه رضایی رو از ملت شارژ کردیم».
 *
 * پرداخت یا شارژ تنخواه هزینه نیست؛ پیش از مسیر انتقال سنجیده می‌شود چون «از
 * بانک ملت به تنخواه منتقل کردیم» هم فعل انتقال دارد و مقصدش در حساب‌های عادی
 * پیدا نمی‌شود. اگر دارنده تنخواهِ باز دارد، شارژ است؛ وگرنه تنخواهِ تازه با
 * همان مبلغ به‌عنوان سقف. مبدأ فقط وقتی پر می‌شود که جمله آن را روشن گفته باشد.
 */
export function detectPettyCashFunding(input, { accounts = [], now } = {}) {
  const petty = readPettyCash(input);
  if (petty?.action !== 'fund') return null;
  const parsed = parseFinancialText(input, { source: 'voice', now });
  const amounts = parsed.transactions.map((item) => Number(item.amount) || 0).filter(Boolean);
  const amount = amounts.length === 1 ? amounts[0] : 0;
  const active = accounts.filter((account) => account.active !== false && account.active !== 0 && account.kind !== 'petty');
  const bank = detectBank(input);
  const single = (matches) => (matches.length === 1 ? matches[0].id : '');
  const fromAccountId = bank
    ? single(active.filter((account) => account.kind === 'bank' && account.bankId === bank.bankId))
    : /(?<![آ-ی])(?:صندوق|نقد|نقدی)(?![آ-ی])/.test(normalizePersian(input)) ? single(active.filter((account) => account.kind === 'cash')) : '';
  const fund = pickPettyCashAccount(accounts, { holder: petty.holder });
  return {
    intent: 'petty-fund', holder: petty.holder || fund?.holderName || '', fundId: fund?.id || null,
    amount: amount || (fund ? Math.max(0, Number(fund.pettyCeiling || 0) - Number(fund.balance || 0)) : 0),
    needsAmount: !amount, fromAccountId, transcript: String(input), occurredAt: parsed.transactions[0]?.occurredAt || null,
  };
}

/** Main capture only accepts an explicit internal transfer. An ordinary
 * customer payment mentioning a bank must stay on the income/expense path. */
// «پایا زدیم»، «ساتنا کردیم»، «حواله زدیم»: انتقال بانکی به زبان روزمره، ولی
// فقط وقتی دو حساب خودِ شرکت در جمله باشند؛ «به آقای رضایی پایا زدیم» پرداخت است.
const BANK_WIRE = /(?:پایا|ساتنا|حواله)\s*(?:زد|کرد|شد)/;
const FEE = /کارمزد/;

export function detectCaptureTransfer(input, options = {}) {
  const text = normalizePersian(input);
  const spokenMove = /(?:انتقال|منتقل|جابه\s*جا|جابجا)\s*(?:داد|ده|کن|کرد|شد|می|بین|از|به)/.test(text);
  // پایا به حساب شخص دیگر پرداخت است؛ با عنوان شخص، انتقال داخلی حدس زده نمی‌شود.
  const wire = !spokenMove && BANK_WIRE.test(text) && !/(?<![آ-ی])(?:آقای|خانم|شرکت|جناب|مشتری|فروشنده)(?![آ-ی])/.test(text);
  if (!spokenMove && !wire) return null;
  const pair = detectTransferBanks(wire ? text.replace(BANK_WIRE, 'منتقل کرد') : input);
  if (wire && !pair) return null;
  const parsed=parseFinancialText(input,{now:options.now});
  // کارمزد همان انتقال، مبلغ دوم جمله است، نه انتقال دوم: جدا نگه داشته می‌شود
  // و هزینهٔ کارمزد بانکیِ حساب مبدأ ثبت می‌شود.
  const feeRow = parsed.transactions.length === 2 && FEE.test(text)
    ? parsed.transactions.find((item) => item.category === 'کارمزد بانکی' || FEE.test(String(item.rawText || ''))) : null;
  const moved = feeRow ? parsed.transactions.filter((item) => item !== feeRow) : parsed.transactions;
  if(moved.length!==1) return null;
  if (feeRow && !(Number(feeRow.amount) < Number(moved[0].amount))) return null;
  const fee = feeRow ? Number(feeRow.amount) : 0;
  if(pair) {
    const unique=side=>{
      const matches=(options.accounts || []).filter(a=>a.active!==false && (side.id==='cash' ? a.kind==='cash' : a.bankId===side.id));
      return matches.length===1 ? matches[0].id : '';
    };
    return {intent:'transfer',amount:moved[0].amount,fee,fromAccountId:unique(pair.from),toAccountId:unique(pair.to),
      transcript:String(input),occurredAt:moved[0].occurredAt || null};
  }
  if (fee) return null;
  const draft=detectBankMovementIntent(input,options);
  return draft?.intent==='transfer' ? { ...draft, transcript: String(input), occurredAt: parsed.transactions[0].occurredAt || null } : null;
}

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
  if (/(?:^|\s)از\s*(?:بانک|حساب|کارت)?\s*$/.test(before)) return 'from';
  if (/(?:^|\s)به\s*(?:بانک|حساب|کارت)?\s*$/.test(before)) return 'to';
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
