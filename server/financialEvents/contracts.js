// استرداد قرارداد دوره‌دار: کدام قرارداد، تمام شد یا ادامه دارد، و برنامهٔ ماهانهٔ پس از آن.
//
// از server/financialEventStore.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از
// پوشهٔ financialEvents همه از همان financialEventStore.js می‌خوانند.

import { SCHEDULE_ITEM_STATUS, coverageMonths, readCoverageLength } from '../../shared/recognitionSchedule.js';
import { extractAmounts } from '../../shared/parser.js';
import { tomanToLedger, unitLabel } from '../../shared/amountUnit.js';
import { normalizePersian } from '../../shared/normalize.js';
import { persianToISO, readJalaliExpression, readTypedDate, todayPersian } from '../../shared/persianDate.js';
import { periodForDate, reverseJournalEntry } from '../accounting.js';
import { storeError, writeAudit, ledgerBalance } from './base.js';
import { lockedPeriodSet, persianDay, blockedDetail, notBeforeDate } from './schedule.js';
import { timingAccountKind, reviewTextAnswers } from './reviewTiming.js';

/**
 * قراردادهای زنده‌ای که تخصیصشان از این حساب کم می‌کند.
 *
 * رویداد ثبت‌شده با قلم برنامه‌ریزی‌شده یا منتظر؛ حسابش یا روی خودِ قلم ذخیره
 * شده (سند حسابدار، ماندهٔ بی‌سند) یا همان حسابی است که سند پرداخت/دریافتش
 * بدهکار/بستانکار کرد.
 */
function liveContractsOn(database, accountId, excludeEventId = '', { cutoff = null } = {}) {
  return database.prepare(`SELECT DISTINCT e.id,e.payload,e.journal_entry_id AS journalEntryId FROM financial_events e
    JOIN recognition_schedule_items i ON i.event_id=e.id
    WHERE e.status='posted' AND e.id<>? AND i.status IN ('planned','blocked-closed-period','posted')
      AND (i.account_id=? OR (i.account_id IS NULL AND EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id=e.journal_entry_id AND l.account_id=?)))
    ORDER BY e.occurred_at,e.rowid`).all(String(excludeEventId || ''), accountId, accountId)
    .map((row) => {
      const event = JSON.parse(row.payload);
      const position = contractPosition(database, row.id, cutoff);
      const entry = row.journalEntryId ? database.prepare('SELECT document_number AS documentNumber FROM journal_entries WHERE id=?').get(row.journalEntryId) : null;
      return {
        eventId: row.id, remaining: position.remaining, recognisedAfterEnd: position.postedAfterTotal,
        documentNumber: entry?.documentNumber ?? null, occurredAt: event.occurredAt, amount: event.amount,
        servicePeriodStart: event.servicePeriodStart || null, servicePeriodEnd: event.servicePeriodEnd || null,
        category: event.category || '', counterparty: event.counterparty || '', evidence: String(event.utterance || event.evidence || '').slice(0, 200),
      };
    })
    .filter((item) => item.remaining > 0 || item.recognisedAfterEnd > 0);
}

/** ابتدای ماه شمسیِ یک قلم، از کلید دوره‌اش («۱۴۰۵-۱۰» → اول دی ۱۴۰۵). */
function periodStartOf(periodKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(periodKey || ''));
  return match ? persianToISO(Number(match[1]), Number(match[2]), 1) : null;
}

/**
 * جای قرارداد در لحظهٔ استرداد: بخش شناسایی‌نشده، و ماه‌هایی که پس از پایان
 * قرارداد (`cutoff`) شروع شده‌اند ولی پیش‌تر سند خورده‌اند.
 *
 * شناسایی هر دقیقه اجرا می‌شود؛ پولِ استرداد معمولاً روزها پس از فسخ می‌رسد و
 * تا آن روز ماه‌های بعد از فسخ هزینه (یا درآمد) شده‌اند. پوششی که پس از پایان
 * قرارداد نبوده، هزینه یا درآمد هم نیست؛ این ماه‌ها جزو بخشی‌اند که استرداد
 * می‌تواند برگرداند. قلم پایانی و جبرانیِ استرداد قبلی جزو ماه‌های پوشش نیستند.
 */
function contractPosition(database, contractEventId, cutoff = null) {
  const rows = database.prepare(`SELECT key,period_key AS periodKey,amount,status FROM recognition_schedule_items
    WHERE event_id=? AND status IN ('planned','blocked-closed-period','posted') ORDER BY period_key,key`).all(contractEventId);
  const remaining = rows.filter((item) => item.status !== SCHEDULE_ITEM_STATUS.POSTED).reduce((sum, item) => sum + item.amount, 0);
  const floor = cutoff ? Date.parse(cutoff) : NaN;
  const postedAfter = Number.isNaN(floor) ? [] : rows.filter((item) => item.status === SCHEDULE_ITEM_STATUS.POSTED
    && !/:(?:close|restore):/.test(item.key) && Date.parse(periodStartOf(item.periodKey)) >= floor);
  const postedAfterTotal = postedAfter.reduce((sum, item) => sum + item.amount, 0);
  return { remaining, postedAfter, postedAfterTotal, available: remaining + postedAfterTotal };
}

/**
 * پایان خودِ قرارداد — نه هر «قطع شد»ی.
 *
 * «فسخ» و «تخلیه» فقط دربارهٔ قرارداد گفته می‌شوند. «کنسل»، «لغو»، «ابطال»،
 * «قطع» و «تمام» فقط وقتی پایان‌اند که فاعل یا مفعولشان خود قرارداد باشد («بیمه
 * رو کنسل کردیم»، «اشتراک قطع شد»، «قرارداد تمام شد»)؛ «آب انبار قطع شد» یا «برق
 * دو هفته قطع شد» قرارداد را تمام نمی‌کند. «تمدید نکرد» یعنی در سررسید ادامه
 * ندارد، نه امروز. فعل منفی («تخلیه نکرده»، «فسخ نشد») پایان نیست.
 */
const CONTRACT_NOUN = '(?:قرارداد|بیمه(?:\\s*نامه)?|اشتراک|اجاره(?:\\s*نامه)?|لایسنس|عضویت|اکانت|پشتیبانی|سرویس\\s*(?:پشتیبانی|نرم\\s*افزار|ابری|هاستینگ|میزبانی))';

const END_SOLE_VERB = /(?:فسخ|تخلیه)(?!\s*ن(?:کرد|کردیم|کرده|کردند|شد|شده|می|میکن|میشه))/;

const END_CONTRACT_VERB = new RegExp(`${CONTRACT_NOUN}[^،,.؛!؟?]{0,60}?(?:کنسل|لغو|ابطال|باطل|خاتمه|قطع|تمام)(?:\\s*(?:کردیم|کردند|کرد|کرده|شده|شد|گردید|دادیم|داد))(?![آ-ی])`);

const CONTRACT_ENDED = new RegExp(`${END_SOLE_VERB.source}|${END_CONTRACT_VERB.source}|پایان\\s*(?:قرارداد|همکاری)|خاتمه\\s*(?:قرارداد|همکاری)`);

const CONTRACT_CONTINUES = /ادامه\s*(?:دارد|داره|می\s*دهیم|میدیم|می\s*دهد|میده|پیدا)|تخفیف|کاهش\s*(?:پوشش|مبلغ|نرخ|اجاره|حق)|ارزان\s*تر|کمتر\s*شد/;

/** از متن: `true` پایان، `false` ادامه، `null` نامعلوم یا متناقض. */
function contractEndedFrom(text) {
  const normalized = normalizePersian(text);
  const ended = CONTRACT_ENDED.test(normalized);
  const continues = CONTRACT_CONTINUES.test(normalized);
  return ended === continues ? null : ended;
}

/**
 * جواب کوتاه به سؤال «تمام شد یا ادامه دارد؟» — «تمام شد»، «فسخ شد»، «نه، ادامه
 * دارد». جواب، سؤالِ خودش را دارد؛ فعل بی‌نام قرارداد اینجا کافی است.
 */
function contractEndedFromAnswer(text) {
  const fromText = contractEndedFrom(text);
  if (fromText !== null) return fromText;
  const normalized = normalizePersian(text);
  const negated = /(?:^|\s)(?:نه|خیر)(?=$|\s|[،,.])|(?:^|\s)ن(?:شد|شده|کرد|کرده|کردیم|کردند|میشه|می\s*شود)(?=$|\s|[،,.])/.test(normalized);
  const endWord = /(?:^|\s)(?:تمام|خاتمه|پایان|کنسل|لغو|باطل|فسخ|تخلیه)/.test(normalized);
  // «ادامه نداره»، «برقرار نیست» پایان‌اند؛ «فسخ نشده»، «هنوز تخلیه نکرده» ادامه.
  const stops = /ادامه\s*ن(?:دار|داد|می)|برقرار\s*نیست/.test(normalized);
  const goesOn = /ادامه(?!\s*ن(?:دار|داد|می))|هنوز|برقرار(?!\s*نیست)/.test(normalized);
  const ended = (endWord && !negated) || stops;
  const continues = goesOn || (endWord && negated);
  return ended === continues ? null : ended;
}

const MONTH_NAMES = 'فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند';

const END_VERB = '(?:فسخ|تخلیه|کنسل|لغو|ابطال|خاتمه)';

const END_DATE = `((?:(?:\\d{1,2}|اول|آخر|اخر|[آ-ی]+م)\\s+)?(?:${MONTH_NAMES})(?:\\s+ماه)?(?:\\s+(?:سال\\s+)?\\d{4})?)`;

/** «از اول دی فسخ کردیم»، «۱۵ آذر تخلیه کرد»، «از ۶ دی به بعد کنسل شد». */
const END_DATE_BEFORE = new RegExp(`(?:^|\\s)(?:از\\s+)?${END_DATE}\\s+(?:به\\s+بعد\\s+)?(?:(?:رو|را)\\s+)?${END_VERB}`);

/** «فسخ کردیم از اول دی»، «تخلیه کرد در ۱۵ آذر». */
const END_DATE_AFTER = new RegExp(`${END_VERB}\\S*\\s+(?:(?:کردیم|کرد|کردن|کردند|شد|شده|کرده)\\s+)?(?:از|در|به\\s+تاریخ|تاریخ)\\s+${END_DATE}`);

/**
 * یک تاریخ شمسی به لحظهٔ ISO؛ سالِ نگفته نزدیک‌ترین سال به تاریخ استرداد است
 * («اول دی» برای استرداد ۶ دی همین دی است، برای استرداد فروردین دیِ پارسال).
 */
function nearestJalali(text, reference) {
  const named = readJalaliExpression(text);
  if (!named) return readTypedDate(text, { now: new Date(reference) });
  const base = todayPersian(new Date(reference)).year + (named.yearOffset || 0);
  const years = named.year ? [named.year] : [base - 1, base, base + 1];
  const target = Date.parse(reference);
  let best = null;
  for (const year of years) {
    let iso = null;
    if (named.end) {
      const next = named.month === 12 ? persianToISO(year + 1, 1, 1) : persianToISO(year, named.month + 1, 1);
      iso = next ? new Date(Date.parse(next) - 86_400_000).toISOString() : null;
    } else iso = persianToISO(year, named.month, named.day || 1);
    if (iso && (!best || Math.abs(Date.parse(iso) - target) < Math.abs(Date.parse(best) - target))) best = iso;
  }
  return best;
}

/**
 * تاریخ پایان قرارداد، فقط وقتی کنار فعل پایان آمده باشد. تاریخی که جای دیگری از
 * جمله است (شروع پوشش، تاریخ خرید) تاریخ فسخ خوانده نمی‌شود.
 */
function contractEndDateFrom(text, reference) {
  const normalized = normalizePersian(text);
  const match = END_DATE_BEFORE.exec(normalized) || END_DATE_AFTER.exec(normalized);
  return match ? nearestJalali(match[1], reference) : null;
}

/**
 * جواب‌های حسابدار دربارهٔ قرارداد: کدام قرارداد و تمام شد یا ادامه دارد.
 *
 * سؤال «کدام قرارداد؟» با شمارهٔ سند یا نام طرف یا دستهٔ همان قرارداد جواب
 * داده می‌شود؛ جوابی که دقیقاً به یک نامزد نخورد، دوباره پرسیده می‌شود.
 */
function reviewContractAnswers(database, eventId, event = {}) {
  const result = { reference: [], ended: [], endedAt: [] };
  for (const [id, value, question] of reviewTextAnswers(database, eventId, event)) {
    if (/contract[_.-]?(?:ended[_.-]?at|end[_.-]?date|cancel(?:led)?[_.-]?(?:at|date)|termination)/i.test(id)
      || /(?:از\s*چه\s*تاریخی|چه\s*تاریخی|از\s*کی|چه\s*روزی|تاریخ).{0,30}(?:فسخ|تخلیه|پایان|تمام|کنسل|لغو)/.test(question)) result.endedAt.push(value);
    else if (/contract[_.-]?(?:ended|end|status|continue)/i.test(id) || /تمام\s*شد|ادامه\s*دارد/.test(question)) result.ended.push(value);
    else if (/contract|refund[_.-]?(?:source|reference)/i.test(id) || /کدام\s*قرارداد|قرارداد\s*اصلی/.test(question)) result.reference.push(value);
  }
  return result;
}

/** «سند ۱۸»، «سند شمارهٔ ۱۸»، «شماره ۱۸»، «#۱۸» — شمارهٔ سندی که صریحاً نام برده شد. */
const DOCUMENT_REFERENCE = /(?:سند|شماره|#)(?:[\s\u200cٔ]*(?:ی|سند|شماره|ه))*[\s\u200cٔ]*[#:]?\s*(\d+)(?![\d])/g;

/** واژه‌ای که پس از عدد آمد، آن را تاریخ، مبلغ یا مدت می‌کند، نه شمارهٔ سند. */
const NOT_DOCUMENT_AFTER = new RegExp(`^\\s*(?:${MONTH_NAMES}|هزار|میلیون|میلیارد|تومن|تومان|ریال|ماهه|ماه|ساله|سال|روز|درصد|تا)(?![آ-ی])`);

/** شماره‌های سندی که جواب صریحاً گفت؛ جوابِ فقط-عدد هم به سؤال «شمارهٔ سند؟» شماره است. */
function documentNumbersIn(normalized) {
  const bare = /^\s*#?\s*(\d+)\s*[.؟?!]?\s*$/.exec(normalized);
  if (bare) return [Number(bare[1])];
  const numbers = [];
  for (const match of normalized.matchAll(DOCUMENT_REFERENCE)) {
    if (!NOT_DOCUMENT_AFTER.test(normalized.slice(match.index + match[0].length))) numbers.push(Number(match[1]));
  }
  return numbers;
}

/** تاریخ یک نامزد با «۱۸ مهر»ِ جواب می‌خواند — روز ضبط یا شروع پوشش. */
function contractOnDate(candidate, named) {
  return [candidate.occurredAt, candidate.servicePeriodStart].filter(Boolean).some((iso) => {
    const parts = todayPersian(new Date(iso));
    return parts.month === named.month && (!named.day || parts.day === named.day) && (!named.year || parts.year === named.year);
  });
}

/**
 * کدام قرارداد؟ — از جواب حسابدار.
 *
 * هر نشانه‌ای که جواب گفت، نامزدها را جدا می‌کند و قرارداد باید با همهٔ آن‌ها
 * بخواند: شمارهٔ سندِ صریح («سند ۱۸»)، تاریخ («که ۱۸ مهر گرفتیم»)، مبلغ («همون
 * ۶۰ میلیونی»)، مدت («سه ماهه») و نام طرف یا دسته. عددی که کنار نام ماه،
 * «میلیون» یا «ماهه» آمده شمارهٔ سند نیست. نشانه‌ای که به هیچ نامزدی نخورد،
 * یا نشانه‌هایی که به دو قرارداد مختلف اشاره کنند، یعنی دوباره بپرس — حدس نه.
 */
function pickContract(candidates, references) {
  for (const text of references) {
    const normalized = normalizePersian(text);
    const signals = [];
    const numbers = documentNumbersIn(normalized);
    if (numbers.length) signals.push(candidates.filter((item) => item.documentNumber != null && numbers.includes(Number(item.documentNumber))));
    const named = readJalaliExpression(normalized);
    if (named) signals.push(candidates.filter((item) => contractOnDate(item, named)));
    // مبلغ گفته‌شده به تومان است و مبلغ قرارداد به واحد دفتر.
    const amounts = extractAmounts(normalized).spans.map((span) => span.amount).filter((value) => value >= 1000).map((value) => tomanToLedger(value));
    if (amounts.length) signals.push(candidates.filter((item) => amounts.includes(Number(item.amount))));
    const length = readCoverageLength(normalized);
    if (length) signals.push(candidates.filter((item) => coverageMonths(item.servicePeriodStart, item.servicePeriodEnd) === length.months));
    const byName = candidates.filter((item) => [item.counterparty, item.category].some((name) => name && normalized.includes(normalizePersian(name))));
    if (byName.length) signals.push(byName);
    if (!signals.length || signals.some((matched) => !matched.length)) continue;
    const chosen = candidates.filter((item) => signals.every((matched) => matched.includes(item)));
    if (chosen.length === 1) return chosen[0];
  }
  return null;
}

function contractQuestionError(text, id, extra = {}) {
  return Object.assign(storeError(text, 'REVIEW_DETAILS_REQUIRED', 409), { question: { id, text }, ...extra });
}

/**
 * سطرهای سند حسابدار که ماندهٔ یک قرارداد دوره‌دار را کم می‌کنند — پیش از ثبت.
 *
 * بستانکارِ پیش‌پرداخت خدمت (بیمه‌گر حق بیمه را برگرداند، اشتراک کنسل شد) یا
 * بدهکارِ درآمد انتقالی (به مستأجری که زودتر تخلیه کرد پس دادیم). برای هرکدام:
 *
 * - قرارداد زنده‌ای روی آن حساب نیست: فقط وقتی ثبت می‌شود که ماندهٔ واقعی حساب
 *   برای استرداد کافی باشد؛ برنامه‌ای نیست که کم شود.
 * - یکی هست: همان قرارداد.
 * - چندتا هست: کدام؟ پرسیده می‌شود (`contract.reference`)، با فهرست نامزدها —
 *   حدس نمی‌زنیم کدام بیمه یا کدام اجاره.
 * - استرداد از بخش شناسایی‌نشدهٔ قرارداد بیشتر است: ثبت نمی‌شود.
 * - کمتر است و از متن یا جواب معلوم نیست قرارداد تمام شد یا ادامه دارد:
 *   پرسیده می‌شود (`contract.ended`)؛ نتیجهٔ این دو در دفتر فرق دارد.
 */
export function reviewedContractReductions(database, eventId, event, lines, { contractEventId = null, contractEnded = null, contractEndedAt = null, reason = '' } = {}) {
  const totals = new Map();
  for (const line of lines || []) {
    const kind = timingAccountKind(database, line.accountId, event);
    if (!kind) continue;
    const entry = totals.get(line.accountId) || { accountId: line.accountId, kind, amount: 0 };
    entry.amount += kind === 'prepaid' ? (line.credit || 0) - (line.debit || 0) : (line.debit || 0) - (line.credit || 0);
    totals.set(line.accountId, entry);
  }
  const reductions = [];
  const at = event.occurredAt || new Date().toISOString();
  const text = `${event.utterance || event.evidence || ''} ${reason}`;
  for (const reduction of [...totals.values()].filter((entry) => entry.amount > 0)) {
    const answers = reviewContractAnswers(database, eventId, event);
    const said = typeof contractEnded === 'boolean' ? contractEnded
      : [...answers.ended.map(contractEndedFromAnswer), contractEndedFrom(text)].find((value) => value !== null) ?? null;
    // تاریخ پایان: انتخاب صریح، جواب سؤال، یا کنار فعل پایان در متن. نگفته، روز
    // استرداد است — کمترین برگشتی که لازم است.
    const explicitEnd = contractEndedAt && !Number.isNaN(Date.parse(contractEndedAt)) ? new Date(contractEndedAt).toISOString() : null;
    const statedEnd = said === false ? null
      : explicitEnd || answers.endedAt.map((value) => nearestJalali(value, at)).find(Boolean) || contractEndDateFrom(text, at);
    const cutoff = statedEnd || at;
    const candidates = liveContractsOn(database, reduction.accountId, eventId, { cutoff: said === false ? null : cutoff });
    const label = reduction.kind === 'deferred' ? 'درآمد انتقالی' : 'پیش‌پرداخت';
    if (!candidates.length) {
      const available = reduction.kind === 'prepaid' ? ledgerBalance(database, reduction.accountId) : -ledgerBalance(database, reduction.accountId);
      if (available < reduction.amount) {
        throw storeError(`ماندهٔ ${label} این حساب (${available.toLocaleString('fa-IR')} ${unitLabel()}) برای این استرداد کافی نیست و قرارداد زنده‌ای هم رویش نیست؛ سند مبنای قرارداد یا مانده را بررسی کن.`, 'REVIEW_DETAILS_REQUIRED', 409);
      }
      continue;
    }
    const chosen = contractEventId ? candidates.find((item) => item.eventId === contractEventId) || null
      : candidates.length === 1 ? candidates[0] : pickContract(candidates, answers.reference);
    if (contractEventId && !chosen) throw storeError('قرارداد انتخاب‌شده روی این حساب برنامهٔ زنده‌ای ندارد.', 'REVIEW_DETAILS_REQUIRED', 409);
    if (!chosen) {
      throw contractQuestionError(`این استرداد کدام قرارداد را کم می‌کند؟ چند قرارداد زنده روی همین حساب ${label} هست؛ «سند شمارهٔ …»، تاریخ، مبلغ یا مدت همان قرارداد را بگو.`, 'contract.reference', { candidates });
    }
    const amount = (value) => value.toLocaleString('fa-IR');
    if (said === false && reduction.amount > chosen.remaining) {
      throw storeError(`استرداد (${amount(reduction.amount)} ${unitLabel()}) از بخش شناسایی‌نشدهٔ قرارداد (${amount(chosen.remaining)} ${unitLabel()}) بیشتر است؛ قراردادی که ادامه دارد بیش از این برنمی‌گرداند. مبلغ یا قرارداد را بررسی کن.`, 'REVIEW_DETAILS_REQUIRED', 409);
    }
    const available = chosen.remaining + chosen.recognisedAfterEnd;
    if (reduction.amount > available) {
      // ماه‌هایی که پیش از روز استرداد شناسایی شده‌اند فقط وقتی برمی‌گردند که
      // قرارداد پیش از آن‌ها تمام شده باشد؛ آن تاریخ را حدس نمی‌زنیم.
      if (!statedEnd) {
        throw contractQuestionError(`استرداد (${amount(reduction.amount)} ${unitLabel()}) از بخش شناسایی‌نشدهٔ قرارداد (${amount(chosen.remaining)} ${unitLabel()}) بیشتر است؛ اگر قرارداد پیش‌تر تمام شده و ماه‌های بعد از آن شناسایی شده‌اند، قرارداد از چه تاریخی تمام شد (فسخ یا تخلیه)؟`, 'contract.end-date', { candidates: [chosen] });
      }
      throw storeError(`استرداد (${amount(reduction.amount)} ${unitLabel()}) از بخش پوشش‌نیافتهٔ قرارداد از ${persianDay(statedEnd)} به بعد (${amount(available)} ${unitLabel()}) بیشتر است؛ مبلغ یا تاریخ پایان را بررسی کن.`, 'REVIEW_DETAILS_REQUIRED', 409);
    }
    if (said === null && reduction.amount < chosen.remaining) {
      throw contractQuestionError('قرارداد با این استرداد تمام شد (فسخ، تخلیه) یا با مبلغ کمتر ادامه دارد؟', 'contract.ended', { candidates: [chosen] });
    }
    reductions.push({ ...reduction, contractEventId: chosen.eventId, ended: said !== false, remaining: chosen.remaining, cutoff: said === false ? null : cutoff, endedAt: statedEnd });
  }
  return reductions;
}

/** کلید ماه شمسیِ یک تاریخ، مثل «۱۴۰۵-۱۰». */
function persianPeriodKey(iso, timeZone = 'Asia/Tehran') {
  const parts = todayPersian(new Date(iso), timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}`;
}

/**
 * برنامهٔ یک قرارداد پس از استرداد — در همان تراکنش سند استرداد.
 *
 * - **پایان قرارداد** (فسخ، تخلیه): همهٔ اقلام زنده باطل می‌شوند و یک قلم
 *   پایانی به تاریخ استرداد، به اندازهٔ «ماندهٔ شناسایی‌نشده منهای استرداد»،
 *   ساخته می‌شود — بخشی که برنگشت و در لحظهٔ فسخ هزینه (یا درآمد) است. پایان
 *   کار: حساب پیش‌پرداخت یا درآمد انتقالی دقیقاً صفر.
 * - **ادامه با مبلغ کمتر**: اقلام آینده بازقیمت‌گذاری می‌شوند تا جمعشان همان
 *   مانده منهای استرداد شود، با همان گرد کردن برنامهٔ ماهانه (ته‌مانده روی قلم
 *   آخر).
 */
export function reduceContractSchedule(database, contractEventId, { refund, at, ended, refundEventId, accountId = null, cutoff = null, actor = null, timeZone = 'Asia/Tehran' } = {}) {
  const live = database.prepare(`SELECT key,period_key AS periodKey,recognition_date AS recognitionDate,amount,status FROM recognition_schedule_items
    WHERE event_id=? AND status IN ('planned','blocked-closed-period') ORDER BY period_key,key`).all(contractEventId);
  const remaining = live.reduce((sum, item) => sum + item.amount, 0);
  // ماه‌هایی که پس از پایان قرارداد شروع شده ولی پیش‌تر سند خورده‌اند — فقط
  // برای قراردادی که تمام شد.
  const position = ended ? contractPosition(database, contractEventId, cutoff || at) : { postedAfter: [], postedAfterTotal: 0 };
  if (!(refund > 0) || refund > remaining + position.postedAfterTotal) throw storeError('استرداد از بخش شناسایی‌نشدهٔ قرارداد بیشتر است.', 'REVIEW_DETAILS_REQUIRED', 409);
  const supersede = database.prepare("UPDATE recognition_schedule_items SET status='superseded' WHERE key=?");
  // وضعیت پیشینِ هر قلمی که این استرداد عوض می‌کند: برگشت استرداد همین را باز
  // می‌گرداند، نه برنامه‌ای حدسی.
  const touched = [];
  const reversedPosted = [];
  let closing = null;
  if (ended) {
    for (const item of live) { touched.push({ key: item.key, amount: item.amount, status: item.status }); supersede.run(item.key); }
    // پوششی که پس از پایان نبوده، هزینه یا درآمد هم نیست: سندش به تاریخ همین
    // استرداد معکوس می‌شود — دورهٔ گذشته (شاید بسته) بازنویسی نمی‌شود.
    for (const item of position.postedAfter) {
      const reversal = reverseJournalEntry(database, {
        sourceType: 'recognition-schedule', sourceId: item.key, occurredAt: at, createdBy: actor, timeZone,
        memo: `برگشت شناسایی ${item.periodKey} پس از پایان قرارداد`,
      });
      supersede.run(item.key);
      reversedPosted.push({ key: item.key, periodKey: item.periodKey, amount: item.amount, reversalEntryId: reversal?.id || null });
    }
    const left = remaining + position.postedAfterTotal - refund;
    if (left > 0) {
      const periodKey = persianPeriodKey(at, timeZone);
      const locked = lockedPeriodSet(database).has(periodForDate(at, timeZone));
      closing = { key: `${contractEventId}:${periodKey}:close:${refundEventId}`, periodKey, recognitionDate: at, amount: left };
      database.prepare(`INSERT INTO recognition_schedule_items (key,event_id,period_key,recognition_date,amount,status,account_id) VALUES (?,?,?,?,?,?,?)`)
        .run(closing.key, contractEventId, periodKey, at, left, locked ? SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD : SCHEDULE_ITEM_STATUS.PLANNED, accountId);
      if (locked) writeAudit(database, contractEventId, 'recognition-blocked', blockedDetail(closing, timeZone), actor);
    }
  } else {
    // ماه‌های آینده بار کاهش را می‌برند؛ اگر کافی نیستند، همهٔ اقلام زنده.
    const future = live.filter((item) => item.recognitionDate > at);
    const pool = future.reduce((sum, item) => sum + item.amount, 0) >= refund ? future : live;
    const target = pool.reduce((sum, item) => sum + item.amount, 0) - refund;
    const share = Math.floor(target / pool.length);
    const reprice = database.prepare('UPDATE recognition_schedule_items SET amount=? WHERE key=?');
    pool.forEach((item, index) => {
      const amount = index === pool.length - 1 ? target - (share * (pool.length - 1)) : share;
      touched.push({ key: item.key, amount: item.amount, status: item.status });
      if (amount > 0) reprice.run(amount, item.key); else supersede.run(item.key);
    });
  }
  const detail = {
    refundEventId, refund, at, cutoff: ended ? (cutoff || at) : null, remainingBefore: remaining,
    remainingAfter: Math.max(0, remaining + position.postedAfterTotal - refund), ended: Boolean(ended), closingItem: closing, touched, reversedPosted,
  };
  writeAudit(database, contractEventId, 'contract-reduced', detail, actor);
  return detail;
}

/**
 * استردادهای ثبت‌شده‌ای که برنامهٔ یک قرارداد را کم کرده‌اند — به ترتیب ثبت.
 *
 * پیوند در ردپای `contract-linked` خودِ استرداد است؛ استردادِ برگشت‌خورده دیگر
 * پیوند زنده نیست.
 */
export function linkedRefunds(database, contractEventId) {
  return database.prepare(`SELECT a.rowid AS auditRow,a.event_id AS eventId,a.detail,j.document_number AS documentNumber
    FROM financial_event_audit a JOIN financial_events e ON e.id=a.event_id LEFT JOIN journal_entries j ON j.id=e.journal_entry_id
    WHERE a.stage='contract-linked' AND json_extract(a.detail,'$.contractEventId')=? AND e.status='posted'
    ORDER BY a.rowid`).all(String(contractEventId || ''))
    .map((row) => ({ ...row, detail: JSON.parse(row.detail || '{}') }));
}

export function refundLabel(refunds) {
  return refunds.map((item) => (item.documentNumber != null ? `سند ${Number(item.documentNumber).toLocaleString('fa-IR', { useGrouping: false })}` : item.eventId)).join('، ');
}

/**
 * برگشت استرداد، برنامهٔ قرارداد را به پیش از آن برمی‌گرداند — در همان تراکنش.
 *
 * استرداد سه اثر روی برنامه داشت و هر سه برمی‌گردند:
 *
 * - **قلم پایانی** (بخشی که برنگشت و در لحظهٔ فسخ هزینه یا درآمد شد): اگر سند
 *   خورده، سندش معکوس می‌شود؛ وگرنه باطل.
 * - **اقلام باطل‌شده یا بازقیمت‌گذاری‌شده**: با مبلغ و وضعیت پیشین برمی‌گردند
 *   (قلمی که حالا در دورهٔ بسته می‌افتد، منتظر دورهٔ بسته).
 * - **آنچه از آن پس با مبلغ کمتر سند خورده یا معکوس شده** قابل بازگرداندن روی
 *   همان قلم نیست؛ تفاوتش یک قلم جبرانی به تاریخ خودِ استرداد می‌شود.
 *
 * پایان کار: جمع اقلام شناسایی‌نشدهٔ قرارداد دوباره برابر ماندهٔ حساب دوره‌دار
 * است — پیش‌پرداخت سرگردان یا درآمد انتقالیِ ابدی نمی‌ماند.
 */
export function restoreContractSchedule(database, link, { actor = null, timeZone = 'Asia/Tehran', memo = 'برگشت استرداد' } = {}) {
  const detail = link.detail || {};
  const contractEventId = detail.contractEventId;
  if (!contractEventId) return null;
  if (!Array.isArray(detail.touched)) {
    throw storeError('ردپای این استرداد برای بازگرداندن برنامهٔ قرارداد کافی نیست؛ برنامهٔ قرارداد را حسابدار بررسی کند.', 'REFUND_LINK_UNRESTORABLE', 409);
  }
  const contract = database.prepare('SELECT payload FROM financial_events WHERE id=?').get(contractEventId);
  const contractEvent = contract ? JSON.parse(contract.payload) : {};
  const lockedPeriods = lockedPeriodSet(database);
  const statusFor = (date) => (lockedPeriods.has(periodForDate(notBeforeDate(date, contractEvent.occurredAt), timeZone))
    ? SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD : SCHEDULE_ITEM_STATUS.PLANNED);
  const itemRow = database.prepare(`SELECT key,status,amount,recognition_date AS recognitionDate,period_key AS periodKey,account_id AS accountId
    FROM recognition_schedule_items WHERE key=?`);
  const supersede = database.prepare("UPDATE recognition_schedule_items SET status='superseded' WHERE key=?");
  const reversalEntryIds = [];
  let shortfall = 0;
  if (detail.closingItem?.key) {
    const closing = itemRow.get(detail.closingItem.key);
    if (closing?.status === SCHEDULE_ITEM_STATUS.POSTED) {
      const reversal = reverseJournalEntry(database, { sourceType: 'recognition-schedule', sourceId: closing.key, memo, createdBy: actor, timeZone });
      if (reversal) reversalEntryIds.push(reversal.id);
    }
    if (closing) supersede.run(closing.key);
  }
  const restored = [];
  const restore = database.prepare('UPDATE recognition_schedule_items SET amount=?,status=? WHERE key=?');
  for (const before of detail.touched) {
    const current = itemRow.get(before.key);
    if (!current) continue;
    // از آن پس با مبلغ بازقیمت‌گذاری‌شده سند خورده: تفاوت جبران می‌شود.
    if (current.status === SCHEDULE_ITEM_STATUS.POSTED) { shortfall += before.amount - current.amount; continue; }
    const status = statusFor(current.recognitionDate);
    restore.run(before.amount, status, before.key);
    restored.push({ key: before.key, amount: before.amount, status });
  }
  // ماه‌هایی که پس از تاریخ پایان سند خورده بودند و استرداد معکوسشان کرد.
  for (const reversed of detail.reversedPosted || []) shortfall += Number(reversed.amount) || 0;
  let compensation = null;
  if (shortfall > 0) {
    const at = detail.at || contractEvent.occurredAt;
    const periodKey = persianPeriodKey(at, timeZone);
    compensation = { key: `${contractEventId}:${periodKey}:restore:${detail.refundEventId || link.eventId}`, periodKey, recognitionDate: at, amount: shortfall };
    const status = statusFor(at);
    database.prepare(`INSERT INTO recognition_schedule_items (key,event_id,period_key,recognition_date,amount,status,account_id) VALUES (?,?,?,?,?,?,?)`)
      .run(compensation.key, contractEventId, periodKey, at, shortfall, status, detail.accountId ?? null);
    if (status === SCHEDULE_ITEM_STATUS.BLOCKED_CLOSED_PERIOD) writeAudit(database, contractEventId, 'recognition-blocked', blockedDetail(compensation, timeZone), actor);
  }
  const result = { refundEventId: detail.refundEventId || link.eventId, restored, closingReversed: reversalEntryIds, compensation };
  writeAudit(database, contractEventId, 'contract-restored', result, actor);
  return result;
}
