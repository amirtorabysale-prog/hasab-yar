// نقش یک طرف حساب از کدینگ: پرسنل، شریک، یا هیچ‌کدام.
//
// سمت دریافتنی/پرداختنی به‌تنهایی نوع شخص را نمی‌گوید: تفصیلیِ زیر «حقوق پرداختنی»
// پرداختنی است، ولی تأمین‌کننده نیست، کارمند است. پارسیان این را در نام معین (و
// گاهی در خود نام تفصیلی، «… پرسنل») گفته است؛ همین‌جا خوانده می‌شود.
//
// مرزها:
//  - معین بیمه یا مالیاتِ حقوق (سازمان تأمین اجتماعی، اداره دارایی) پرسنل نیست.
//  - «حقوق صاحبان سهام» حقوق کارکنان نیست؛ سرمایه است و نشانهٔ شریک.
//  - شخصی که هم نشانهٔ پرسنل دارد هم شریک، نقشی نمی‌گیرد (شخص)؛ حدس زده نمی‌شود.

import { normalizePersian } from './normalize.js';

export const PARTY_ROLES = Object.freeze({ employee: 'پرسنل', partner: 'شریک' });

const NOT_A_PERSON = /ب[یي]مه|مال[یي]ات|تام[یي]ن\s*اجتماع[یي]|دارا[یي][یي]|صندوق\s*بازنشستگ[یي]/;
const PAYROLL_ACCOUNT = /حقوق\s*(?:و\s*)?(?:دستمزد|پرداخت(?:ن[یي])?|کارکنان|پرسنل|کارمندان)|دستمزد|پرسنل(?![آ-ی])|کارکنان|کارمندان|کارگران|مساعده|ع[یي]د[یي]|پاداش|سنوات/;
const PARTNER_ACCOUNT = /شرکا|شر[یي]ک|سهامدار|صاحبان\s*سهام|جار[یي]\s*(?:مد[یي]ر|اعضا)|مد[یي]رعامل|ه[یي]ئت\s*مد[یي]ره|ه[یي]ات\s*مد[یي]ره/;
const EMPLOYEE_NAME = /(?:^|\s)(?:پرسنل|کارمند|کارگر)(?![آ-ی])/;
const PARTNER_NAME = /(?:^|\s)(?:شر[یي]ک|سهامدار|مد[یي]رعامل)(?![آ-ی])/;

/** نقش یک حساب (کل یا معین) از نامش. */
export function accountPartyRole(name) {
  const text = normalizePersian(String(name || ''));
  if (!text || NOT_A_PERSON.test(text)) return '';
  if (PARTNER_ACCOUNT.test(text)) return 'partner';
  if (PAYROLL_ACCOUNT.test(text)) return 'employee';
  return '';
}

/**
 * نقش یک شخص از همهٔ تفصیلی‌هایش.
 * `charts`: [{ chartName, kolName }] — معین و کل هر گردش؛ `names`: نام‌های تفصیلی.
 */
export function partyRoleOf({ names = [], charts = [] } = {}) {
  const roles = new Set();
  for (const chart of charts) {
    // نام معین مقدم است؛ کل فقط وقتی خود معین چیزی نمی‌گوید («بستانکاران پرسنل» > «بدهی‌های جاری»).
    const role = accountPartyRole(chart.chartName) || (NOT_A_PERSON.test(normalizePersian(chart.chartName || '')) ? '' : accountPartyRole(chart.kolName));
    if (role) roles.add(role);
  }
  for (const name of names) {
    const text = normalizePersian(String(name || ''));
    if (EMPLOYEE_NAME.test(text)) roles.add('employee');
    if (PARTNER_NAME.test(text)) roles.add('partner');
  }
  return roles.size === 1 ? [...roles][0] : '';
}
