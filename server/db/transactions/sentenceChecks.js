// پیش از ساختن ردیف نقدی: طرف حسابِ جمله، اصلاحِ ثبت قبلی، چک و سفته و تعهدِ وصول‌نشده، و صف حسابدار برای گفتهٔ مرکب و تسویهٔ بی‌سند.
//
// از server/db/transactions.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// transactions همه از همان server/db/transactions.js می‌خوانند.

import { detectSettleIntent } from '../../../shared/settleSpeech.js';
import { detectPartnerPaidDebt } from '../../../shared/partnerPaidSpeech.js';
import { randomUUID } from 'node:crypto';
import { resolveAccountId } from '../accounts.js';
import { audit, currentTimeZone, currentWorkspace, db, invalidInput } from '../core.js';
import { assertAccountingPeriodOpen, periodForDate } from '../../accounting.js';
import { automationPolicy } from '../settings.js';
import { extractContactName } from '../../../shared/voiceIntent.js';
import { COMPOSITE_AMOUNT_MESSAGE, extractAmounts, hasCompositeAmounts } from '../../../shared/parser.js';
import { saveContact } from '../contacts.js';
import { matchCounterparty } from '../../counterparties.js';
import { approveFinancialEvent, recordFinancialEvent } from '../../financialEventStore.js';
import { transactionEventDecision } from '../../transactionEvent.js';
import { vatGuardContext } from '../../tax.js';
import { NATURE_EXPLANATIONS, natureNeedsAccountant, readEventNature, readNonCashInstrument, MIXED_SETTLEMENT_REASON } from '../../../shared/eventNature.js';
import { EVENT_KINDS, normalizeFinancialEvent } from '../../../shared/financialEvent.js';
import { decide } from '../../../shared/accountingDecision.js';
import { factsFromEvent } from '../../../shared/eventFacts.js';
import { ROUTES } from '../../../shared/confidenceEngine.js';

/**
 * طرف حسابی که در خود جمله گفته شده، به ثبت وصل می‌شود.
 *
 * «۹۳ میلیون تومان به شرکت آراد گستر آسیا پرداخت شد» یک هزینهٔ ساده ثبت
 * می‌شد و هیچ‌وقت به کارت آن شرکت نمی‌رسید — با اینکه نامش صریح در جمله بود.
 * و چون سند به حساب طرف حساب نمی‌خورد، فهرست طرف حساب‌ها یک عدد نشان می‌داد
 * و کارتش عدد دیگری.
 *
 * `extractContactName` فقط با عنوان صریح کار می‌کند — «شرکت»، «آقای»،
 * «خانم» و مانندشان — پس «به پیک پول دادم» طرف حساب نمی‌سازد و فهرست از
 * نام‌های بی‌ربط پر نمی‌شود.
 *
 * `saveContact` خودش هر سه حالت را می‌داند: تطابق دقیق وصل می‌شود، نام مشابه
 * پرسیده می‌شود (`COUNTERPARTY_SIMILAR` که رابط به برگهٔ تأیید تبدیلش
 * می‌کند) و نام تازه ساخته می‌شود. هیچ‌کدام اینجا دوباره پیاده نشده.
 */
export function counterpartyFromSentence(item, transcript, counterpartyResolution) {
  // نامی که پارسر از **کل جمله** برداشته، بر متن ردیف مقدم است.
  //
  // `rawText` فقط تکهٔ کنار مبلغ است: در «از شرکت پخش البرز پانزده میلیون
  // تومان دریافت شد» به «تومان دریافت شد» کوتاه می‌شود و نام شرکت — که در
  // نیمهٔ اول جمله بود — کاملاً گم می‌شد.
  const name = String(item.contactName || '').trim()
    || extractContactName(String(item.rawText || transcript || ''));
  if (!name) return null;
  // نامِ حدسی (بدون عنوان) فقط وقتی وصل می‌شود که با طرف حسابی که از قبل در
  // دفتر هست بخواند. «به پیک پول دادم» نباید کارت حساب «پیک پول» بسازد —
  // ساختنش تصمیم کاربر است و برگهٔ تأیید آن را می‌پرسد.
  if (item.contactNameConfident === false && item.linkContact !== true) {
    return matchCounterparty(db, name).exact?.id || null;
  }
  return saveContact({ name, counterpartyResolution }).id;
}

/**
 * جمله‌ای که اصلاح یک ثبت قبلی است، تراکنش تازه نیست.
 *
 * «فاکتور خرید دیروز اشتباهاً بیست و یک میلیون ثبت شده بود، اصلاحش کن» روی
 * برگهٔ تأیید دو ردیف نقدی تازه می‌ساخت — دوازده و بیست و یک میلیون — و ماندهٔ
 * صندوق سی و سه میلیون کم می‌شد، درحالی‌که هیچ پولی جابه‌جا نشده بود. اصلاح،
 * سند اصلاحی با ارجاع به سند اول می‌خواهد و آن کار حسابدار است.
 *
 * فقط برای گفتهٔ کاربر (صدا یا متن). مسیرهای داخلی — تسویه، رسید، تکرار —
 * متن خودشان را می‌سازند و این واژه‌ها در آن‌ها معنای دیگری ندارند.
 */
export function correctionNature(item, transcript) {
  if (item.journalManaged || item.restoredFrom || !['voice', 'text', undefined].includes(item.source)) return null;
  const nature = item.eventNature || readEventNature(String(item.rawText || '')) || null;
  const fromSentence = readEventNature(String(transcript || ''));
  const chosen = natureNeedsAccountant(nature) ? nature : fromSentence;
  return natureNeedsAccountant(chosen) ? chosen : null;
}

export const NON_CASH_REASON = 'این جمله از چک یا سفته‌ای می‌گوید که هنوز وصول نشده؛ چک تا وصول نشود پول نیست و ردیف نقدی ساخته نشد.';

/** چکی که پول نیست — همان مسیر اصلاح: بدون ردیف نقدی، مستقیم به حسابدار. */
export function nonCashInstrument(item, transcript) {
  if (item.journalManaged || item.restoredFrom || !['voice', 'text', undefined].includes(item.source)) return false;
  return readNonCashInstrument(transcript || item.rawText || '');
}

export function queueCorrectionForAccountant(item, transcript, nature) {
  const amount = Math.round(Number(item.amount));
  const event = normalizeFinancialEvent({
    kind: item.type === 'income' ? EVENT_KINDS.CASH_INCOME : EVENT_KINDS.CASH_EXPENSE,
    amount, occurredAt: item.occurredAt || new Date().toISOString(),
    category: item.category, description: item.category, accountId: resolveAccountId(item),
    source: item.source === 'voice' ? 'voice' : 'text', eventNature: ['non-cash-instrument', 'explicit-non-cash', 'mixed-settlement'].includes(nature) ? 'new' : nature,
    evidence: String(transcript || item.rawText || '').slice(0, 1000),
  });
  const accountingDecision = decide(factsFromEvent(event), { today: event.occurredAt });
  const reason = nature === 'mixed-settlement' ? MIXED_SETTLEMENT_REASON : nature === 'explicit-non-cash' ? 'طبق گفتهٔ کاربر هنوز وجهی جابه‌جا نشده است؛ ثبت نقدی ساخته نشد و ماهیت تعهد یا موجودی باید بررسی شود.'
    : nature === 'non-cash-instrument' ? NON_CASH_REASON
    : NATURE_EXPLANATIONS[nature] || 'این جمله اصلاح یک ثبت قبلی است، نه تراکنش تازه.';
  return recordFinancialEvent(db, event, {
    sourceEventId: `correction:${item.clientId || randomUUID()}`,
    // این رویداد صرفاً حامل شاهد در صف است؛ نقشهٔ نقدیِ ناشی از نوعِ موقت
    // هرگز با دکمهٔ تأیید نباید ثبت شود. حسابدار باید سند درست را تعیین کند.
    decision: { route: ROUTES.ACCOUNTANT_REVIEW, guardBlocked: true, reasons: [reason], summary: reason },
    actor: currentWorkspace()?.userId || null, transcript, rawInput: transcript,
    timeZone: currentTimeZone(), withinTransaction: true, accountingDecision,
  });
}

/**
 * «نسیه فروختیم»، «قبض اومده ولی هنوز پرداخت نکردیم»، «تحویل دادیم ولی پولی
 * نگرفتیم» — پولی جابه‌جا نشده، ولی طلب یا بدهی همین حالا ساخته شده.
 *
 * تا امروز این‌ها یک پروندهٔ مسدود در صف حسابدار می‌ساختند، حتی ساده‌ترین‌شان.
 * با موتور روشن، همان طلب یا بدهی با دستهٔ واقعی جمله ساخته می‌شود و از
 * موتور تصمیم می‌گذرد: قطعی باشد همان‌جا ثبت می‌شود، یک واقعیت کم داشته باشد
 * از ثبت‌کننده پرسیده می‌شود، و فقط قضاوت واقعی به حسابدار می‌رسد.
 *
 * ردیف نقدی ساخته نمی‌شود — هیچ پولی جابه‌جا نشده. به‌جایش یک تعهد باز ساخته
 * می‌شود تا وصول یا پرداخت بعدی از همان مسیر همیشگیِ تسویه برود.
 */
const DELIVERED = /تحویل\s*(?:دادیم|دادم|شد)|انجام\s*(?:دادیم|دادم|شد)|(?:تموم|تمام)\s*(?:کردیم|کردم|شد)|فروختیم|فروختم/;

export function openNonCashStatement(item, transcript, sentence) {
  const amount = Math.round(Number(item.amount));
  const direction = item.type === 'income' ? 'receivable' : 'payable';
  const occurredAt = item.occurredAt || new Date().toISOString();
  assertAccountingPeriodOpen(db, periodForDate(occurredAt, currentTimeZone()));
  const said = String(sentence || item.rawText || transcript || '');
  const contactId = item.linkContact === false ? null : item.contactId || counterpartyFromSentence(item, transcript, '');
  const contactName = contactId ? db.prepare('SELECT name FROM contacts WHERE id=?').get(contactId)?.name || item.contactName || '' : item.contactName || '';
  const draft = transactionEventDecision({
    ...item, amount, occurredAt, accountId: null, contactId, contactName, unpaidSignal: true,
    deliveryDate: direction === 'receivable' && (DELIVERED.test(said) || ['فروش', 'خدمات'].includes(String(item.category || '').trim())) ? occurredAt : null,
  }, { transcript, sentence, policy: automationPolicy() });
  if (!draft?.accountingDecision) return null;
  const id = randomUUID();
  const title = String(contactName || item.category || (direction === 'receivable' ? 'طلب' : 'بدهی')).slice(0, 120);
  db.prepare(`INSERT INTO obligations (id,contact_id,title,amount,direction,due_at,occurred_at,status,note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, contactId || null, title, amount, direction, item.dueAt || null, occurredAt, 'open', said.slice(0, 500));
  audit('create', 'obligation', id, { amount, direction, title, fromStatement: true });
  let result = recordFinancialEvent(db, draft.event, {
    sourceEventId: `obligation:${id}`, decision: draft.decision,
    actor: currentWorkspace()?.userId || null, transcript, rawInput: said,
    timeZone: currentTimeZone(), withinTransaction: true,
    accountingDecision: draft.accountingDecision, vat: vatGuardContext(db),
  });
  // برگهٔ تأیید را ثبت‌کننده دیده و تأیید کرده؛ تصمیم قطعی همان‌جا ثبت می‌شود.
  if (item.userConfirmed === true && result.status === 'pending' && result.route === ROUTES.CONFIRM
    && draft.accountingDecision.decisionStatus === 'decided' && !draft.decision.reasons.length) {
    result = approveFinancialEvent(db, result.id, { actor: currentWorkspace()?.userId || null, timeZone: currentTimeZone(), withinTransaction: true });
  }
  return { obligationId: id, ...result, question: draft.accountingDecision.question || null };
}

/** یک گفتهٔ «جمع و اجزا» یک پروندهٔ بررسی است، حتی اگر سه عدد گفته شده باشد. */
export function queueCompositeUtterance(transcript, { clientId = '', source = 'text' } = {}) {
  const text = String(transcript || '').trim().slice(0, 1000);
  if (!hasCompositeAmounts(text)) throw invalidInput('این گفته چند مبلغ وابسته ندارد.');
  const amounts = extractAmounts(text).spans.map((span) => span.amount).filter((amount) => Number.isSafeInteger(amount) && amount > 0);
  const referenceAmount = Math.max(...amounts);
  if (!Number.isSafeInteger(referenceAmount) || referenceAmount > 999_999_999_999) throw invalidInput('مبالغ گفته معتبر نیستند.');
  const event = normalizeFinancialEvent({
    kind: EVENT_KINDS.REVIEW_PLACEHOLDER, amount: referenceAmount,
    amountReferenceOnly: true, occurredAt: new Date().toISOString(),
    source: source === 'voice' ? 'voice' : 'text', evidence: text, utterance: text,
    description: 'چند مبلغ وابسته در یک رویداد؛ مبلغ و سطرهای سند قطعی نیست.',
  });
  return recordFinancialEvent(db, event, {
    sourceEventId: `composite:${String(clientId || randomUUID()).slice(0, 100)}`,
    decision: { route: ROUTES.ACCOUNTANT_REVIEW, guardBlocked: true,
      reasons: [COMPOSITE_AMOUNT_MESSAGE], summary: 'یک گفته با جمع و اجزای وابسته؛ تعیین سند با حسابدار' },
    actor: currentWorkspace()?.userId || null, transcript: text, rawInput: text,
    timeZone: currentTimeZone(),
  });
}

/** A failed match is an auditable case, never a guessed settlement. */
export function queueUnmatchedSettlement(transcript, { clientId = '', source = 'text' } = {}) {
  const text=String(transcript || '').trim().slice(0,1000),draft=detectSettleIntent(text) || detectPartnerPaidDebt(text);
  if(!draft) throw invalidInput('گفته باید درخواست تسویه با مبلغ مشخص باشد.');
  const amounts=extractAmounts(text).spans.map(s=>s.amount).filter(n=>Number.isSafeInteger(n) && n>0);
  const amount=Math.max(...amounts);
  if(!Number.isSafeInteger(amount) || amount>999_999_999_999) throw invalidInput('مبلغ مرجع معتبر لازم است.');
  // چک برگشتی هم تسویه نیست و هم نباید گم شود: چک از اسناد دریافتنی (یا
  // پرداختنی) برمی‌گردد و طلب یا بدهی دوباره باز می‌شود؛ کدام چک، با حسابدار.
  const payer=draft.paidBy ? (draft.paidBy.name || draft.paidBy.role || 'شریک') : '';
  const reason=draft.paidBy
    ? `بدهی شرکت${draft.contactName ? ` به ${draft.contactName}` : ''} از پول شخصی ${payer} پرداخت شده و بدهی ثبت‌شدهٔ بازی برایش پیدا نشد. از صندوق و بانک شرکت وجهی نرفته و فروش داراییِ شخصیِ او درآمد شرکت نیست. سند پیشنهادی: بدهکار حساب پرداختنی طلبکار، بستانکار جاری ${payer}. هیچ سندی ثبت نشده است.`
    : draft.bounced
    ? 'چک برگشت خورده؛ چک از اسناد دریافتنی یا پرداختنی برمی‌گردد و طلب یا بدهی دوباره باز می‌شود. حسابدار چک مربوط را پیدا و ثبت می‌کند. هیچ سندی ثبت نشده است.'
    : 'سند مبنای تسویه انتخاب نشده؛ حسابدار باید مانده و مرجع واقعی را بررسی کند. هیچ وجه یا سندی ثبت نشده است.';
  const event=normalizeFinancialEvent({kind:EVENT_KINDS.REVIEW_PLACEHOLDER,amount,amountReferenceOnly:true,
    occurredAt:draft.occurredAt || new Date().toISOString(),source:source==='voice'?'voice':'text',evidence:text,utterance:text,description:reason});
  return recordFinancialEvent(db,event,{sourceEventId:`unmatched-settlement:${String(clientId || randomUUID()).slice(0,100)}`,
    decision:{route:ROUTES.ACCOUNTANT_REVIEW,guardBlocked:true,reasons:[reason],summary:reason},
    actor:currentWorkspace()?.userId || null,transcript:text,rawInput:text,timeZone:currentTimeZone()});
}
