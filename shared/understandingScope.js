/**
 * کدام گفته به «فهم رویداد با AI» می‌رود؟
 *
 * محدودهٔ پیش‌فرض «مرکب» است: فقط گفته‌هایی که مسیر قطعی امروز یا نمی‌فهمد یا
 * کل گفته را به حسابدار می‌دهد. گفتهٔ سادهٔ تک‌مبلغی — «اجاره رو ده میلیون
 * دادیم» — همان مسیر رایگان و میلی‌ثانیه‌ای می‌ماند؛ فرستادنش به مدل نه دقت را
 * بالا می‌برد نه صف را کم می‌کند، فقط هزینه و تأخیر اضافه می‌کند.
 *
 * دلیل هر انتخاب برگردانده می‌شود تا گزارش مقایسه بگوید چرا یک گفته به مدل رفت.
 */
import { extractAmounts, hasCompositeAmounts } from './parser.js';
import { normalizePersian } from './normalize.js';
import { needsUnquantifiedReview } from './reviewIntake.js';
import { readEventNature, readExplicitNonCash, readMixedSettlement } from './eventNature.js';
import { priorSettlementDirection } from './priorSettlement.js';
import { conditionalWaiver } from './reviewSettlement.js';
import { judgmentReason } from './moneyPurpose.js';
import { mentionsPersonalMoney } from './partnerPaidSpeech.js';

const NEGATION = /(?:هنوز\s*(?:\S+\s*){0,3}(?:ن[آ-ی]+(?:یم|م|ه|ند|ن))|(?:نکردیم|ندادیم|نگرفتیم|نشده|نیومده|نرسیده)(?![آ-ی])|برای\s*فروش\s*نیست)/;
const CONDITION = /(?:^|\s)(?:اگر|اگه|در\s*صورت|به\s*شرط|مشروط)(?:\s|$)/;
const SELF_CORRECTION = /(?:نه\s*(?:ببخشید|ببخشین)|اشتباه\s*گفتم|منظورم|یعنی\s*(?:نه|در\s*اصل))/;

export function understandingReasons(input) {
  const text = normalizePersian(input);
  if (!text) return [];
  const reasons = [];
  const amounts = extractAmounts(text).spans.filter((span) => !span.bareScale);
  if (hasCompositeAmounts(text)) reasons.push('composite');
  else if (amounts.length > 1) reasons.push('multiple-amounts');
  if (needsUnquantifiedReview(text)) reasons.push('unquantified');
  if (NEGATION.test(text)) reasons.push('negation');
  if (CONDITION.test(text) || conditionalWaiver(text)) reasons.push('condition');
  if (SELF_CORRECTION.test(text)) reasons.push('self-correction');
  const nature = readEventNature(text);
  if (nature && nature !== 'new') reasons.push(`nature:${nature}`);
  if (readMixedSettlement(text)) reasons.push('mixed-settlement');
  if (readExplicitNonCash(text)) reasons.push('non-cash');
  if (priorSettlementDirection(text)) reasons.push('prior-settlement');
  if (judgmentReason(text)) reasons.push('judgment-signal');
  // پولِ شخصیِ شریک یا مدیرعامل: پارسر هر جمله را پولِ صندوق شرکت می‌خواند.
  if (mentionsPersonalMoney(text)) reasons.push('personal-money');
  return reasons;
}

export function inUnderstandingScope(input, scope = 'composite') {
  if (!normalizePersian(input)) return false;
  return scope === 'all' || understandingReasons(input).length > 0;
}
