// دوره و دستهٔ پیش‌پرداخت و درآمد انتقالی وقتی حسابدار سند را از صف ثبت می‌کند.
//
// از server/financialEventStore.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از
// پوشهٔ financialEvents همه از همان financialEventStore.js می‌خوانند.

import { readCoverageAnswers } from '../../shared/recognitionSchedule.js';
import { readServicePeriod } from '../../shared/periodSpeech.js';
import { normalizePersian } from '../../shared/normalize.js';
import { categoryByName, scoreCategories } from '../../shared/categoryRules.js';
import { DECISION_STATUS } from '../../shared/accountingDecision.js';
import { storeError, writeAudit } from './base.js';
import { storeDecision, storeSchedule, decisionForEvent, ALLOCATION_PLANS } from './schedule.js';

// ---------------------------------------------------------------------------
// ثبت حسابدار و برنامهٔ شناسایی
// ---------------------------------------------------------------------------

/** «پیش‌پرداخت خرید — …»: پیش‌پرداخت کالا به تأمین‌کننده، نه خدمت دوره‌دار. */
const SUPPLIER_ADVANCE_NAME = /^پیش[\s\u200c]*پرداخت[\s\u200c]+خرید/;

/**
 * حساب دوره‌دارِ یک سطر: پیش‌پرداخت خدمت (`prepaid`)، درآمد انتقالی
 * (`deferred`) یا هیچ‌کدام.
 *
 * از خودِ حساب دفتر کل خوانده می‌شود — منشأ یا نقش معین کدینگ — نه از نقشی که
 * پیشنهاد گفته بود: حسابدار می‌تواند هر حسابی را انتخاب کند و همان در دفتر
 * می‌نشیند. پیش‌پرداخت خرید کالا هم در همان معین پیش‌پرداخت‌هاست ولی دورهٔ
 * پوشش ندارد؛ با رسیدن کالا بسته می‌شود، نه با گذشت ماه.
 */
export function timingAccountKind(database, accountId, event = {}) {
  const account = database.prepare(`SELECT a.name,a.source_kind AS sourceKind,c.role AS chartRole FROM ledger_accounts a
    LEFT JOIN chart_accounts c ON c.id=a.chart_account_id WHERE a.id=?`).get(String(accountId || ''));
  if (!account) return null;
  if (account.sourceKind === 'deferred-revenue' || account.chartRole === 'deferred-revenue') return 'deferred';
  if (account.sourceKind === 'prepaid-asset' || account.chartRole === 'prepaid-asset') {
    if (event.reviewSupplierAdvance || SUPPLIER_ADVANCE_NAME.test(account.name || '')) return null;
    return 'prepaid';
  }
  return null;
}

/**
 * جواب‌های حسابدار دربارهٔ دورهٔ پوشش، از گفت‌وگوی بررسی.
 *
 * دستیار بررسی شروع و پایان پوشش را با شناسهٔ `coverage.start`/`coverage.end`
 * می‌پرسد (هرگز روی تاریخ پرداخت). شناسه یا متن سؤال گاهی فرق می‌کند؛ هر سؤالی
 * که دربارهٔ پوشش یا دورهٔ خدمت است خوانده می‌شود و سؤال تاریخ پرداخت نه.
 */
/** جواب‌های متنی حسابدار به سؤال‌های همین پرونده: `[id, value, question]`. */
export function reviewTextAnswers(database, eventId, event = {}) {
  let answers = event.questionAnswers || null;
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='accounting_review_context'").get()) {
    const row = database.prepare('SELECT facts FROM accounting_review_context WHERE event_id=?').get(eventId);
    if (row) answers = JSON.parse(row.facts || '{}').questionAnswers || answers;
  }
  return Object.entries(answers || {})
    .filter(([, answer]) => answer && typeof answer.value === 'string' && !answer.field)
    .map(([id, answer]) => [id, answer.value, normalizePersian(answer.question || '')]);
}

function reviewCoverageAnswers(database, eventId, event = {}) {
  const result = [];
  for (const [id, value, question] of reviewTextAnswers(database, eventId, event)) {
    const coverage = /coverage|service[_.-]?(?:start|end|period)|period[_.-]?(?:start|end)/i.test(id)
      || /پوشش|دوره(?:\s*ی)?\s*(?:خدمت|اجاره|قرارداد|بیمه|اشتراک)|(?:شروع|پایان)\s*(?:خدمت|قرارداد|اجاره|بیمه|اشتراک)|مدت\s*(?:قرارداد|اجاره|بیمه|اشتراک|پوشش)/.test(question);
    if (!coverage) continue;
    const side = /end|پایان|اتمام|انتها/i.test(`${id} ${question}`) ? 'end' : /start|شروع|ابتدا/i.test(`${id} ${question}`) ? 'start' : 'any';
    result.push({ text: value, side });
  }
  return result;
}

/**
 * دورهٔ پوشش برای سندی که حسابدار ثبت می‌کند.
 *
 * سه منبع، به ترتیب: جواب صریح حسابدار، دورهٔ ذخیره‌شده روی رویداد (از متن یا
 * از جواب کارت سؤال)، و دورهٔ گفته‌شده در خودِ متن اصلی با همان قاعدهٔ مسیر
 * قطعی. هیچ‌کدام نبود، دوره ناقص برمی‌گردد — حدسی در کار نیست.
 */
export function reviewTimingCoverage(database, eventId, event = {}) {
  const occurredAt = event.occurredAt || null;
  const text = event.utterance || event.evidence || '';
  const spoken = occurredAt ? readServicePeriod(text, { occurredAt }) : null;
  const start = event.servicePeriodStart || spoken?.start || null;
  const end = event.servicePeriodStart ? (event.servicePeriodEnd || null) : (spoken?.end || null);
  const months = !event.servicePeriodStart && spoken ? spoken.months : null;
  return readCoverageAnswers(reviewCoverageAnswers(database, eventId, event), { occurredAt, start, end, months });

}

export function coverageQuestion(kind) {
  return kind === 'deferred'
    ? 'دورهٔ خدمتی که پولش پیشاپیش گرفته شد از کی تا کی است؟ مثلاً «از اول مهر ۱۴۰۵ به مدت ۶ ماه»؛ بدون آن، درآمد انتقالی هیچ‌وقت درآمد نمی‌شود.'
    : 'دورهٔ پوشش این پیش‌پرداخت از کی تا کی است؟ مثلاً «از اول مهر ۱۴۰۵ به مدت ۱۲ ماه»؛ بدون آن، پیش‌پرداخت هیچ‌وقت هزینه نمی‌شود.';
}

/**
 * دسته‌هایی که هزینه یا درآمد ماهانهٔ یک خدمت دوره‌دار نیستند: کالا و بهای
 * تمام‌شده (پیش‌پرداخت کالا مسیر تأمین‌کننده است) و دستهٔ «سایر» که خودش یعنی
 * دسته معلوم نشد.
 */
const NON_SERVICE_CATEGORIES = new Set(['مواد و کالا', 'بهای تمام‌شدهٔ فروش', 'کسری و ضایعات موجودی', 'سایر هزینه‌ها', 'سایر درآمدها']);

/** نام دستهٔ معتبر از یک متن کوتاه (نام دسته، کلید سطر یا جواب): فقط وقتی یک دستهٔ خدمت بی‌رقیب جلوست. */
function serviceCategoryFrom(text, type) {
  const exact = categoryByName(text);
  if (exact) return exact.type === type && !NON_SERVICE_CATEGORIES.has(exact.name) ? exact.name : null;
  const [first, second] = scoreCategories(text, type);
  if (!first || (second && second.score >= first.score)) return null;
  return NON_SERVICE_CATEGORIES.has(first.definition.name) ? null : first.definition.name;
}

export function timingCategoryQuestion(kind) {
  return kind === 'deferred'
    ? 'درآمد ماهانهٔ این پیش‌دریافت کدام دسته است؟ (مثلاً درآمد اجاره یا خدمات)'
    : 'هزینهٔ ماهانهٔ این پیش‌پرداخت کدام دسته است؟ (مثلاً بیمه، اجاره، نرم‌افزار و اشتراک)؛ حساب «پیش‌پرداخت‌ها» دسته را نمی‌گوید.';
}

/**
 * دستهٔ هزینه (یا درآمد) ماهانهٔ قراردادی که حسابدار ثبت می‌کند — از انتخاب
 * خودِ حسابدار، نه از حدس لحظهٔ ضبط.
 *
 * به ترتیب:
 * 1. حسابِ دوره‌داری که سند حسابدار بدهکار یا بستانکار کرد، اگر به دسته وصل است
 *    («پیش‌پرداخت — بیمه» → بیمه). همان حسابی است که شناسایی از آن کم می‌کند.
 * 2. جواب صریح حسابدار به «کدام دسته؟».
 * 3. کلید سطر پیشنهاد حسابدار («بیمه انبار» → بیمه) — برای حساب کلی
 *    «پیش‌پرداخت‌ها» که دسته ندارد.
 * 4. دستهٔ لحظهٔ ضبط، فقط اگر دستهٔ یک خدمت است. «مواد و کالا» یا «سایر» برای
 *    پیش‌پرداخت خدمت حدس است: پرسیده می‌شود (`timing.category`).
 *
 * درآمد انتقالی حساب هر طرف است، نه هر دسته؛ دسته از جواب یا کلید سطر می‌آید و
 * نبودشان، دستهٔ لحظهٔ ضبط می‌ماند (حساب، چیزی خلافش نگفته).
 */
export function reviewedTimingCategory(database, eventId, event, timing, lines = []) {
  const type = timing.kind === 'deferred' ? 'income' : 'expense';
  const account = database.prepare('SELECT source_kind AS sourceKind, source_key AS sourceKey FROM ledger_accounts WHERE id=?').get(String(timing.accountId || ''));
  const linkedKind = timing.kind === 'deferred' ? 'deferred-revenue' : 'prepaid-asset';
  const linked = account?.sourceKind === linkedKind && account.sourceKey && account.sourceKey !== 'عمومی' ? account.sourceKey : null;
  const known = linked ? categoryByName(linked) : null;
  // پیش‌پرداخت به نام دسته باز می‌شود (دستهٔ دست‌ساز کاربر هم)؛ درآمد انتقالی به
  // نام طرف — مگر نامش خودش یک دستهٔ درآمد باشد.
  if (linked && (known ? known.type === type : timing.kind === 'prepaid')) return { category: linked, basis: 'account' };
  for (const [id, value, question] of reviewTextAnswers(database, eventId, event)) {
    if (!/category|دسته/i.test(id) && !/کدام\s*دسته|دسته\s*(?:ی|ٔ)?\s*(?:هزینه|درآمد)/.test(question)) continue;
    const answered = serviceCategoryFrom(value, type);
    if (answered) return { category: answered, basis: 'answer' };
  }
  for (const line of lines || []) {
    if (String(line.accountId || '') !== String(timing.accountId || '') || !line.key) continue;
    const keyed = serviceCategoryFrom(String(line.key), type);
    if (keyed) return { category: keyed, basis: 'line-key' };
  }
  const captured = event.category || '';
  if (timing.kind === 'deferred') return { category: captured, basis: 'capture' };
  if (captured && serviceCategoryFrom(captured, type) === captured) return { category: captured, basis: 'capture' };
  return { category: null, question: { id: 'timing.category', text: timingCategoryQuestion(timing.kind) } };
}

/**
 * سطر دوره‌دارِ سندِ حسابدار و دورهٔ پوششش — پیش از ثبت، تا ناقص بودن آن سند
 * نسازد.
 *
 * سطری که پیش‌پرداخت خدمت را بدهکار یا درآمد انتقالی را بستانکار می‌کند،
 * دارایی یا بدهی دوره‌دار می‌سازد و بدون برنامه تا ابد در ترازنامه می‌ماند.
 * پس دورهٔ پوشش شرط ثبت است؛ اگر معلوم نیست پرسیده می‌شود (کد
 * `REVIEW_DETAILS_REQUIRED` با همان سؤال)، نه اینکه از تاریخ پرداخت ساخته شود.
 *
 * بیش از یک حساب دوره‌دار در یک سند یعنی دو قرارداد با دو دوره؛ برنامهٔ یک
 * رویداد یک دوره دارد، پس جدا ثبت شوند.
 */
export function reviewedTimingPlan(database, eventId, event, lines) {
  const totals = new Map();
  for (const line of lines || []) {
    const kind = timingAccountKind(database, line.accountId, event);
    if (!kind) continue;
    const entry = totals.get(line.accountId) || { accountId: line.accountId, kind, amount: 0 };
    entry.amount += kind === 'prepaid' ? (line.debit || 0) - (line.credit || 0) : (line.credit || 0) - (line.debit || 0);
    totals.set(line.accountId, entry);
  }
  // جهت کاهنده (استرداد، فسخ) دارایی یا بدهی تازه نمی‌سازد.
  const creating = [...totals.values()].filter((entry) => entry.amount > 0);
  if (!creating.length) return null;
  if (creating.length > 1) {
    throw storeError('این سند بیش از یک حساب پیش‌پرداخت یا درآمد انتقالی دارد؛ هر قرارداد دوره‌دار را جداگانه ثبت کن تا برنامهٔ تخصیص هرکدام با دورهٔ خودش ساخته شود.', 'REVIEW_DETAILS_REQUIRED', 409);
  }
  const [timing] = creating;
  const coverage = reviewTimingCoverage(database, eventId, event);
  if (!coverage.start || !coverage.end) {
    const text = coverageQuestion(timing.kind);
    throw Object.assign(storeError(text, 'REVIEW_DETAILS_REQUIRED', 409), { question: { id: coverage.start ? 'coverage.end' : 'coverage.start', text } });
  }
  return { ...timing, start: coverage.start, end: coverage.end };
}

/**
 * سند حسابدار جای برنامهٔ لحظهٔ ضبط را می‌گیرد.
 *
 * برنامه‌ای که هنگام ضبط ساخته شد بر تصمیم آن لحظه تکیه داشت؛ وقتی حسابدار
 * سطرهای خودش را ثبت می‌کند، همان سطرها حقیقت دفترند:
 *
 * - سطر دوره‌دار هست: برنامه از **همان سطر** دوباره ساخته می‌شود — مبلغِ همان
 *   سطر (خالص، بی ارزش افزوده)، حسابِ همان سطر و دورهٔ پوشش. تخصیص بعدی از
 *   همان حسابی کم می‌کند که پرداخت بدهکار کرد و ماندهٔ آن در پایان دوره صفر
 *   است. پوششِ گذشته در اجرای بعدی جبران می‌شود.
 * - نیست (حسابدار همه را هزینه یا چیز دیگر ثبت کرد): اقلام برنامه باطل
 *   می‌شوند و تصمیم تازه‌ای جای تصمیم کهنه می‌نشیند، تا شناسایی ماهانه روی
 *   هزینه‌ای که یک بار ثبت شده دوباره هزینه نسازد.
 */
export function reconcileReviewedRecognition(database, row, event, timing, { actor, timeZone, journalEntryId }) {
  const previous = decisionForEvent(database, row.id);
  if (!timing) {
    const superseded = database.prepare(`UPDATE recognition_schedule_items SET status='superseded'
      WHERE event_id=? AND status IN ('planned','blocked-closed-period')`).run(row.id).changes;
    let decisionId = null;
    if (previous && (previous.recognitionMethod || ALLOCATION_PLANS[previous.treatment])) {
      decisionId = storeDecision(database, row.id, {
        family: previous.family, treatment: 'accountant-reviewed', policyKey: previous.policyKey, policyVersion: previous.policyVersion,
        recognitionMethod: null, riskLevel: previous.riskLevel, decisionStatus: DECISION_STATUS.DECIDED,
        explanation: 'سند را حسابدار بی‌حساب پیش‌پرداخت یا درآمد انتقالی ثبت کرد؛ تصمیم لحظهٔ ضبط دیگر برنامهٔ شناسایی ندارد.',
        sourceReferences: [{ type: 'journal-entry', id: journalEntryId }],
      }, previous.id);
      database.prepare('UPDATE financial_events SET decision_id=? WHERE id=?').run(decisionId, row.id);
    }
    if (superseded || decisionId) writeAudit(database, row.id, 'schedule-reconciled', { supersededItems: superseded, timing: null, decisionId }, actor);
    return null;
  }
  const deferred = timing.kind === 'deferred';
  const decision = {
    family: deferred ? 'advance-received' : 'asset-creation',
    treatment: deferred ? 'deferred-revenue' : 'prepaid-expense',
    policyKey: previous?.policyKey || null, policyVersion: previous?.policyVersion || null,
    recognitionDate: timing.start, recognitionMethod: 'monthly-straight-line',
    riskLevel: previous?.riskLevel || 'yellow', decisionStatus: DECISION_STATUS.DECIDED,
    explanation: `حسابدار ${deferred ? 'درآمد انتقالی' : 'پیش‌پرداخت'} ثبت کرد؛ برنامهٔ تخصیص از همان سطر و همان حساب ساخته شد.`,
    sourceReferences: [{ type: 'journal-entry', id: journalEntryId }, { type: 'ledger-account', id: timing.accountId },
      ...(timing.category ? [{ type: 'category', id: timing.category, basis: timing.categoryBasis || null }] : [])],
    assumptions: timing.category && timing.categoryBasis !== 'capture' && event.category && event.category !== timing.category
      ? [`دستهٔ لحظهٔ ضبط «${event.category}» با انتخاب حسابدار «${timing.category}» جایگزین شد.`] : [],
  };
  const decisionId = storeDecision(database, row.id, decision, previous?.id || null);
  database.prepare('UPDATE financial_events SET decision_id=? WHERE id=?').run(decisionId, row.id);
  // هزینه یا درآمد ماهانه به دسته‌ای می‌رود که حسابدار انتخاب کرد («پیش‌پرداخت —
  // بیمه» → هزینهٔ بیمه)، نه حدس لحظهٔ ضبط («مواد و کالا»).
  const scheduled = { ...event, servicePeriodStart: timing.start, servicePeriodEnd: timing.end, category: timing.category ?? event.category };
  database.prepare('UPDATE financial_events SET payload=? WHERE id=?').run(JSON.stringify(scheduled), row.id);
  const stored = storeSchedule(database, row.id, decision, scheduled, { amount: timing.amount, accountId: timing.accountId, timeZone });
  writeAudit(database, row.id, 'schedule-reconciled', {
    timing: { kind: timing.kind, accountId: timing.accountId, amount: timing.amount, start: timing.start, end: timing.end },
    decisionId, written: stored?.written || 0, blocked: stored?.blocked?.length || 0,
  }, actor);
  return scheduled;
}
