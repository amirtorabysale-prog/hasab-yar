import { normalizePersian } from './normalize.js';
import { BANKS, detectBank } from './banks.js';
import { persianToISO, todayPersian } from './persianDate.js';

/**
 * پیامکِ بانکی — خواندنِ یک پیامک، بی هیچ حدسی دربارهٔ «بابت».
 *
 * پیامک بانک چهار واقعیت را صریح می‌گوید: کدام بانک، برداشت یا واریز، چقدر،
 * و (اغلب) مانده و زمان و چند رقم آخر حساب یا کارت. «بابت» را نمی‌گوید؛ پس هیچ
 * پیامکی خودش سند هزینه یا درآمد نمی‌شود. ردیفِ بانکیِ منتظر است تا با تراکنشی
 * که ثبت شده تطبیق بخورد یا کاربر بابتش را بگوید (قاعدهٔ ۴ CLAUDE.md).
 *
 * مبلغ پیامک بانک‌های ایران به **ریال** است؛ خروجی هر دو را دارد و تبدیل به
 * واحد دفتر کارِ لایهٔ داده است.
 *
 * پیامک رمز یک‌بارمصرف، کد تأیید و تبلیغ اصلاً پیامک تراکنش نیست: `kind` آن را
 * می‌گوید و متنش هرگز ذخیره نمی‌شود.
 */

/** فرستنده‌های شناخته‌شده (نام انگلیسی سرشماره) → شناسهٔ بانک. */
const SENDER_ALIASES = Object.freeze({
  mellat: 'mellat', bankmellat: 'mellat', melli: 'melli', bmi: 'melli', banki: 'melli', tejarat: 'tejarat', saderat: 'saderat', bsi: 'saderat',
  sepah: 'sepah', keshavarzi: 'keshavarzi', bki: 'keshavarzi', maskan: 'maskan', refah: 'refah', postbank: 'post', parsian: 'parsian',
  pasargad: 'pasargad', bpi: 'pasargad', saman: 'saman', sb24: 'saman', enbank: 'eghtesad-novin', karafarin: 'karafarin', sina: 'sina',
  shahr: 'shahr', citybank: 'shahr', dey: 'dey', ayandeh: 'ayandeh', tourism: 'gardeshgari', blu: 'blu', blubank: 'blu',
  resalat: 'resalat', mehriran: 'mehr-iran', sanat: 'sanat', edbi: 'tosee-saderat', ttbank: 'tosee-taavon', iranzamin: 'iranzamin',
});

// رمز پویا، کد تأیید، رمز دوم — هرگز تراکنش نیست و متنش جایی نمی‌ماند.
const OTP = /(?:رمز|کد)\s*(?:پویا|یک\s*بار|یکبار|تایید|تأیید|دوم|ورود|فعال)|(?:OTP|one[\s-]*time|verification\s*code|password)|(?:رمز|کد)\s*[:：]?\s*\d{4,8}(?!\d)/i;

// واژه‌های جهت؛ «انتقال از/به» جهت را به خودِ حساب صاحب پیامک نسبت می‌دهند.
const OUT = /(?:برداشت|برداشتی|خرید|پرداخت|کسر|انتقال\s*(?:از\s*حساب|وجه)?\s*[:：]?\s*-|انتقالی\s*-|withdraw(?:al)?|purchase|debit|-\s*\d)/i;
const IN = /(?:واریز|واریزی|افزایش|بستانکار|انتقال\s*به\s*حساب\s*شما|credit|deposit|\+\s*\d)/i;

const NUMBER = '(\\d{1,3}(?:[,٬،]\\d{3})+|\\d+)';
const AMOUNT_AFTER = new RegExp(`(?:برداشت(?:ی)?|خرید|پرداخت|کسر|واریز(?:ی)?|افزایش|انتقال(?:ی)?|مبلغ|withdraw(?:al)?|purchase|deposit|debit|credit|amount|amt)(?:\\s+[^\\d\\s:：]+){0,3}?\\s*[:：]?\\s*([+-]?)\\s*${NUMBER}`, 'i');
const SIGNED = new RegExp(`(^|\\s)([+-])\\s*${NUMBER}(?!\\s*[/:])`);
const BALANCE = new RegExp(`(?:مانده|موجودی|ماندہ|bal(?:ance)?|mande)\\s*[:：]?\\s*(-?)\\s*${NUMBER}`, 'i');
const ACCOUNT = /(?:حساب|سپرده|کارت|از|acc(?:ount)?|card|no)\s*[:：.]?\s*([\d*.\-]{4,30})/i;
const REFERENCE = /(?:پیگیری|مرجع|شناسه|ref(?:erence)?|trace)\s*[:：]?\s*(\d{4,20})/i;
const FULL_DATE = /(1[34]\d{2})[/\-.](\d{1,2})[/\-.](\d{1,2})/;
const SHORT_DATE = /(?<![\d/])(\d{2})[/\-.]?(\d{2})(?=[\s_\-]+\d{1,2}:\d{2})/;
const TIME = /(\d{1,2}):(\d{2})/;

const digits = (value) => Number(String(value || '').replace(/[,٬،\s]/g, ''));

/** بانکِ پیامک: اول از سرشماره، بعد از متن (همان شناسه‌های `banks.js`). */
export function bankOfSms(text, sender = '') {
  // سرشماره و نامِ لاتینِ داخل متن («Bank Saderat»، «BPI»).
  for (const source of [sender, text]) {
    const key = String(source || '').toLowerCase().replace(/[^a-z]/g, '');
    for (const [alias, id] of Object.entries(SENDER_ALIASES)) if (key && key.includes(alias)) return id;
  }
  return detectBank(`${sender || ''} ${text || ''}`)?.bankId || null;
}

/** تاریخ و ساعت پیامک؛ بی تاریخ، زمان دریافت. سال کوتاه («۰۷۱۵») سالِ زمان دریافت است. */
function occurredAtOf(text, receivedAt) {
  const received = receivedAt ? new Date(receivedAt) : new Date();
  const time = text.match(TIME);
  const at = (iso) => {
    const date = new Date(iso);
    if (time) date.setUTCHours(Number(time[1]) - 3, Number(time[2]) - 30, 0, 0); // ساعت تهران (+۳:۳۰)
    return date.toISOString();
  };
  const full = text.match(FULL_DATE);
  if (full) {
    const iso = persianToISO(Number(full[1]), Number(full[2]), Number(full[3]));
    if (iso) return at(iso);
  }
  const short = text.match(SHORT_DATE);
  if (short) {
    const month = Number(short[1]); const day = Number(short[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const now = todayPersian(received);
      // پیامکِ اسفند که در فروردین رسیده، مال سال قبل است.
      const year = month > now.month + 1 ? now.year - 1 : now.year;
      const iso = persianToISO(year, month, day);
      if (iso) return at(iso);
    }
  }
  return received.toISOString();
}

/**
 * پیامک → واقعیت‌های بانکی.
 *
 * `kind`: «transaction» | «otp» (کد و رمز) | «unknown» (پیامک بانکِ بی‌مبلغ یا تبلیغ)
 * | «not-bank». فقط «transaction» ردیف می‌سازد.
 */
export function parseBankSms(input, { sender = '', receivedAt = null } = {}) {
  const raw = String(input || '');
  const text = normalizePersian(raw).replace(/‌/g, ' ');
  const bankId = bankOfSms(text, sender);
  if (OTP.test(text)) return { kind: 'otp', bankId };
  if (!bankId) return { kind: 'not-bank' };
  // مانده از متن کنار می‌رود تا عددش مبلغ خوانده نشود.
  const balanceMatch = text.match(BALANCE);
  const withoutBalance = balanceMatch ? text.replace(balanceMatch[0], ' ') : text;
  const withoutDates = withoutBalance.replace(FULL_DATE, ' ').replace(/\d{1,2}:\d{2}/g, ' ');
  const amountMatch = withoutDates.match(AMOUNT_AFTER);
  const signed = withoutDates.match(SIGNED);
  const amountRial = amountMatch ? digits(amountMatch[2]) : signed ? digits(signed[3]) : 0;
  if (!amountRial) return { kind: 'unknown', bankId };
  // جهت: علامتِ صریح مقدم است، بعد واژه.
  const sign = amountMatch?.[1] || signed?.[2] || '';
  const keywordOut = OUT.test(withoutDates); const keywordIn = IN.test(withoutDates);
  const direction = sign === '-' ? 'expense' : sign === '+' ? 'income'
    : keywordOut && !keywordIn ? 'expense' : keywordIn && !keywordOut ? 'income' : null;
  if (!direction) return { kind: 'unknown', bankId, amountRial, reason: 'جهت پیامک (برداشت یا واریز) روشن نیست.' };
  const account = withoutDates.match(ACCOUNT);
  // آخرین گروهِ رقمیِ دست‌کم چهاررقمی: «210.8100.12345678.1» → 5678، «6037-****-****-1234» → 1234.
  const accountDigits = account ? (account[1].split(/\D+/).filter((group) => group.length >= 4).at(-1) || '') : '';
  const reference = text.match(REFERENCE)?.[1] || null;
  const balanceRial = balanceMatch ? digits(balanceMatch[2]) * (balanceMatch[1] === '-' ? -1 : 1) : null;
  return {
    kind: 'transaction', bankId, bankName: BANKS.find((bank) => bank.id === bankId)?.name || bankId,
    direction, amountRial, balanceRial,
    accountHint: accountDigits.length >= 4 ? accountDigits.slice(-4) : null,
    reference, occurredAt: occurredAtOf(text, receivedAt),
  };
}

/** اثر انگشتِ یک پیامک برای جلوگیری از ثبت دوباره (همان پیامک که دو بار رسید). */
export function smsFingerprint(parsed) {
  return [parsed.bankId, parsed.direction, parsed.amountRial, parsed.balanceRial ?? '', parsed.accountHint || '', parsed.reference || '', String(parsed.occurredAt || '').slice(0, 16)].join('|');
}
