import { reviewNature, reviewNatureViolations } from '../shared/reviewNature.js';
import { matchingUnidentifiedHolding } from './unidentifiedReceipts.js';
import { randomUUID } from 'node:crypto';
import { planJournal, treatmentHasPlan } from '../shared/accountingRules.js';
import { ROUTES } from '../shared/confidenceEngine.js';
import { EVENT_KINDS, normalizeFinancialEvent } from '../shared/financialEvent.js';
import { DECISION_STATUS, decide } from '../shared/accountingDecision.js';
import { factsFromEvent } from '../shared/eventFacts.js';
import { applyAnswer } from '../shared/questionAnswer.js';
import { GUARD_VERDICTS, guardedPlan, isGuardPlan, runGuards } from '../shared/guards.js';
import { eventFingerprint } from '../shared/eventFingerprint.js';
import { postJournalEntry, reverseJournalEntry } from './accounting.js';
import { resolveEventAnalytic, resolveEventRole } from './roleResolver.js';
import { storeError, ensureFinancialEventSchema, retireRecognitionSchedule, writeAudit } from './financialEvents/base.js';
import { storeDecision, storeSchedule, blockedRecognitionReason, lockedScheduleItems, decisionForEvent } from './financialEvents/schedule.js';
import { reviewedTimingCategory, reviewedTimingPlan, reconcileReviewedRecognition } from './financialEvents/reviewTiming.js';
import { reviewedContractReductions, reduceContractSchedule, linkedRefunds, refundLabel, restoreContractSchedule } from './financialEvents/contracts.js';

/**
 * دفتر رویدادهای مالی — یکتایی، ردیابی و صف بررسی.
 *
 * سه مسئولیت دارد و هیچ‌کدام تصمیم حسابداری نیست:
 *
 * ۱. **یکتایی.** یک ضبط صدا یا یک تراکنش نباید دو بار ثبت شود. کاربر دکمه را
 *    دوبار می‌زند، شبکه قطع می‌شود و درخواست تکرار می‌شود، صف آفلاین دوباره
 *    می‌فرستد — همه‌شان واقعی‌اند.
 *
 * ۲. **ردیابی.** برای هر تصمیم مالی باید بشود گفت از کدام گفته آمد، با چه
 *    اطمینانی، با کدام قاعده، چه سندی ساخت، چه کسی تأییدش کرد و بعداً چه بر
 *    سرش آمد. بدون این زنجیره، حسابرسی ممکن نیست.
 *
 * ۳. **صف بررسی.** رویدادی که اطمینانش کافی نیست یا مانع ساختاری دارد، به‌جای
 *    ثبت یا دورریختن، منتظر حسابدار می‌ماند.
 */

// بخش‌های دیگرِ دفتر رویدادها در server/financialEvents/؛ نامِ همهٔ export‌ها همان است که بود.
export { ensureFinancialEventSchema, detachUnpaidCashRows, retireRecognitionSchedule, repairCancelledSchedules } from './financialEvents/base.js';
export { scheduleForEvent, decisionForEvent } from './financialEvents/schedule.js';
export { timingAccountKind, reviewTimingCoverage, coverageQuestion, timingCategoryQuestion, reviewedTimingCategory, reviewedTimingPlan } from './financialEvents/reviewTiming.js';
export { reviewedContractReductions, reduceContractSchedule } from './financialEvents/contracts.js';
export { recordShadowRun, attachActualToShadowRun, shadowRuns, shadowDisagreementReport } from './financialEvents/shadow.js';
export { postDueRecognitionItems, releaseHeldRecognition, listRecognitionNotices, markRecognitionNoticeSeen, listTimingContracts, listHeldRecognition, listBlockedRecognition, postBlockedRecognitionCatchUp } from './financialEvents/recognition.js';
export { unscheduledTimingBalances, scheduleTimingBalance } from './financialEvents/timingBalances.js';

/**
 * رویداد را ثبت می‌کند و بر اساس مسیرش تصمیم می‌گیرد سند بخورد یا منتظر بماند.
 *
 * `sourceEventId` اجباری است. بدون آن هیچ تضمینی برای یکتایی نمی‌ماند و همان
 * گفته با هر بار ارسال دوباره ثبت می‌شود.
 */
export function recordFinancialEvent(database, event, {
  sourceEventId,
  decision,
  actor = null,
  transcript = '',
  rawInput = '',
  timeZone = 'Asia/Tehran',
  // فراخوانی که خودش تراکنش باز کرده، نباید تراکنش تودرتو بسازد؛ SQLite آن را
  // نمی‌پذیرد و کل عملیات شکست می‌خورد.
  withinTransaction = false,
  // لنگر سند در دفتر.
  //
  // پیش‌فرض، خودِ رویداد است. ولی وقتی رویداد روی یک تراکنش موجود می‌نشیند، سند
  // باید به همان تراکنش لنگر بخورد: `migrateAccountingLedger` هر تراکنشِ بی‌سند
  // را خودش سند می‌زند و سندی که با منبع دیگری ثبت شده را نمی‌بیند. نتیجه‌اش سند
  // دوم و شناسایی دوبارهٔ درآمد است — دقیقاً همان چیزی که این معماری قرار بود
  // جلویش را بگیرد.
  journalSource = null,
  // چه کسی سند را می‌زند.
  //
  // پیش‌فرض، نقشهٔ نقش‌محورِ `shared/accountingRules.js` است. ولی رویدادی که
  // روی یک تراکنش نشسته، سندش شکل جاافتاده و آزموده‌شدهٔ خودش را دارد؛ عوض کردن
  // آن شکل کار این تغییر نیست. تصمیمِ «ثبت بشود یا نه» اینجا گرفته می‌شود،
  // «چطور ثبت بشود» همان‌جایی می‌ماند که بود.
  postJournal = null,
  // تصمیم موتور نسخهٔ دو، اگر روشن باشد.
  //
  // اختیاری است و نبودنش یعنی همان مسیر قبلی. وقتی هست، ذخیره می‌شود حتی اگر
  // اجازهٔ ثبت ندهد — چون همان دادهٔ خامی است که گزارش اختلاف فاز بعد لازم
  // دارد: موتور چه گفت و حسابدار چه کرد.
  accountingDecision = null,
  // اسناد باز طرف حساب، برای نگهبان تسویه.
  //
  // `undefined` یعنی بررسی ممکن نبود و `[]` یعنی بررسی شد و چیزی نبود. این دو
  // عمداً یکی نشده‌اند: امروز در transactionEvent هر دو بی‌صدا به هزینه می‌رسند
  // و بعداً نمی‌شود گفت نگهبان اصلاً اجرا شده یا نه.
  openDocuments = undefined,
  // نرخ‌های مشمول و ماندهٔ ارزش افزودهٔ دفتر، برای نگهبان ارزش افزوده.
  // نبودش یعنی بررسی ممکن نبود؛ نگهبان خودش می‌داند با آن چه کند.
  vat = undefined,
} = {}) {
  ensureFinancialEventSchema(database);
  const source = String(sourceEventId || '').trim();
  if (!source) throw storeError('شناسهٔ منبع رویداد لازم است.', 'EVENT_SOURCE_MISSING');
  if (!event || !event.kind) throw storeError('رویداد مالی معتبر نیست.');
  if (!decision || !decision.route) throw storeError('تصمیم موتور اطمینان لازم است.', 'EVENT_DECISION_MISSING');

  const fingerprint = eventFingerprint(event);

  const existing = database.prepare('SELECT * FROM financial_events WHERE source_event_id=?').get(source)
    // همان رویداد از کانال دیگر: شناسهٔ منبع فرق دارد ولی محتوا یکی است.
    //
    // رویداد ردشده یا معکوس‌شده از این کنترل بیرون است: کاربر آن ثبت را پس
    // گرفته و دوباره درستش را گفته؛ مسدود کردنش یعنی ثبت درست هیچ‌وقت وارد
    // نمی‌شود.
    // همان رویداد از کانال **دیگر**: شناسهٔ منبع فرق دارد ولی محتوا یکی است.
    //
    // شرط «کانال متفاوت» حیاتی است. دو پرداخت واقعاً یکسان در یک روز — دو بار
    // بنزین پانصد هزاری — محتوای یکسان دارند و هر دو درست‌اند؛ یکی‌کردنشان
    // ثبت درست کاربر را می‌خورد و او هیچ‌وقت نمی‌فهمد. آنچه واقعاً مشکوک است
    // همان فاکتوری است که یک بار گفته شده و یک بار عکسش فرستاده شده.
    //
    // رویداد ردشده یا معکوس‌شده هم از این کنترل بیرون است: کاربر آن ثبت را پس
    // گرفته و دوباره درستش را گفته.
    || (fingerprint && database.prepare(`SELECT * FROM financial_events
      WHERE fingerprint=? AND status IN ('pending','posted')
        AND COALESCE(json_extract(payload,'$.source'),'') <> ?`).get(fingerprint, event.source || ''));
  // تکرار خطا نیست؛ همان نتیجهٔ قبلی برگردانده می‌شود تا فراخوان لازم نباشد
  // بین «شکست» و «قبلاً انجام شده» فرق بگذارد.
  if (existing) return { ...describeStored(database, existing), duplicate: true };

  // نقشهٔ سند همین‌جا ساخته و ذخیره می‌شود، حتی وقتی قرار نیست همین حالا ثبت
  // شود: حسابرسی باید بداند در لحظهٔ تصمیم، قاعده چه گفته بود.
  // نگهبان‌ها پس از تصمیم و پیش از قاعده. بدون تصمیم — یعنی موتور نسخهٔ دو
  // خاموش — اجرا نمی‌شوند و مسیر دقیقاً همان قبلی است.
  const guards = accountingDecision
    ? runGuards(event, factsFromEvent(event), { decision: accountingDecision, openDocuments, vat })
    : null;
  // مانعِ نگهبان به صف حسابدار می‌رود، با دلیلش — نه خطا.
  //
  // تا اینجا مانع یک خطای ۴۰۹ بود، و مسیر تراکنش هر خطای این لایه را «لایهٔ
  // رویداد نتوانست» می‌خواند و سند را از مسیر قدیمی می‌زد. یعنی درست همان
  // موردی که نگهبان گفته بود نباید ثبت شود، بی‌صدا ثبت می‌شد.
  const plan = guards ? guardedPlan(event, accountingDecision, guards) : planJournal(event, accountingDecision);
  const natureIssues=reviewNatureViolations(event.utterance || event.evidence || '',plan.lines,event);
  // همان پولی که پیش‌تر «ناشناس» نگه داشته شده، دریافت تازه نیست.
  const held = !reviewNature(event.utterance || event.evidence || '').unknownReceipt ? matchingUnidentifiedHolding(database, event) : null;
  const heldReason = held ? `این واریز با وجه ناشناس ${held.reference} (${Number(held.remaining).toLocaleString('fa-IR')} تومان، همین حساب) می‌خواند. اگر همان پول است، آن وجه را از صف «وجوه ناشناس» تعیین تکلیف کن و این مورد را رد کن.` : '';
  const blocked = natureIssues.length>0 || Boolean(held) || guards?.verdict === GUARD_VERDICTS.BLOCK || event.kind === EVENT_KINDS.REVIEW_PLACEHOLDER;
  const routed = blocked
    ? { ...decision, route: ROUTES.ACCOUNTANT_REVIEW, guardBlocked: true, reasons: [...new Set([...(decision.reasons || []), ...natureIssues.map(q=>q.text), ...(heldReason ? [heldReason] : []), guards?.reason || (heldReason ? '' : 'این گفته هنوز نقشهٔ سند قطعی ندارد.')].filter(Boolean))] }
    : decision;
  // قلمی از برنامه که در دورهٔ بسته می‌افتد، مورد را به صف حسابدار می‌برد (تصمیم
  // ۳ فاز صفر)؛ نه خودکار ثبت می‌شود و نه بی‌صدا در دورهٔ بعد می‌نشیند.
  const id = randomUUID();
  const lockedItems = lockedScheduleItems(database, id, accountingDecision, event, plan, timeZone);
  const routing = lockedItems.length
    ? { ...routed, route: ROUTES.ACCOUNTANT_REVIEW, reasons: [...new Set([...(routed.reasons || []), blockedRecognitionReason(lockedItems, timeZone)])] }
    : routed;
  // The proposed plan is retained for audit even when semantic validation holds it.

  if (!withinTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT INTO financial_events
      (id,source_event_id,kind,amount,occurred_at,due_at,payload,confidence,route,status,created_by,journal_source,posting_plan,fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, source, event.kind, event.amount, event.occurredAt, event.dueAt || null,
        JSON.stringify(event), JSON.stringify(routing), routing.route, 'pending', actor,
        journalSource ? JSON.stringify(journalSource) : null,
        // نقشه همین‌جا قفل می‌شود.
        //
        // تا امروز نقشه در تأیید دوباره با کدِ آن روز ساخته می‌شد. رویدادی که
        // دو هفته در صف مانده و در این فاصله قاعده‌ای عوض شده، سندی می‌خورد که
        // با آنچه به حسابدار نشان داده شده بود فرق دارد — و هیچ هشداری هم
        // نمی‌دهد. حالا آنچه در لحظهٔ تصمیم ساخته شد، همان ثبت می‌شود.
        JSON.stringify(plan), fingerprint);

    const decisionId = storeDecision(database, id, accountingDecision);
    if (decisionId) database.prepare('UPDATE financial_events SET decision_id=? WHERE id=?').run(decisionId, id);
    storeSchedule(database, id, accountingDecision, event, { plan, timeZone });

    writeAudit(database, id, 'captured', {
      rawInput: String(rawInput || '').slice(0, 10000),
      transcript: String(transcript || event.utterance || event.evidence || '').slice(0, 10000),
      event,
      confidence: routing,
      rule: plan.kind,
      journalPlan: plan,
      decision: accountingDecision || null,
      guards: guards?.checks || null,
      // آنچه نگهبان‌ها دیدند، نه فقط حکمشان: گزارش اختلاف باید بتواند بگوید
      // تفکیک با کدام نرخ و کدام مانده انجام شد.
      guardContext: guards ? { vat: vat ?? null, openDocumentCount: Array.isArray(openDocuments) ? openDocuments.length : null } : null,
    }, actor);

    let journalEntryId = null;
    if (routing.route === ROUTES.AUTO) {
      const posted = postPlanned(database, { id, event, plan, actor, timeZone, journalSource, postJournal, treatment: accountingDecision?.treatment });
      journalEntryId = posted?.id || null;
    }
    if (!withinTransaction) database.exec('COMMIT');
    return { id, sourceEventId: source, route: routing.route, status: journalEntryId ? 'posted' : 'pending', journalEntryId, decisionId, plan, guards: guards?.checks || null, duplicate: false };
  } catch (error) { if (!withinTransaction) database.exec('ROLLBACK'); throw error; }
}

/**
 * سند یک رویداد — با ثبت‌کنندهٔ تزریقی یا با نقشهٔ نقش‌محور.
 *
 * نقشه‌ای که نگهبان بازنویسی کرده هرگز به ثبت‌کنندهٔ تزریقی نمی‌رود. آن
 * ثبت‌کننده سند جاافتادهٔ تراکنش را می‌زند که فقط هزینه و درآمد می‌شناسد و
 * نقشه را اصلاً نمی‌خواند: فروش با ارزش افزوده دوباره کل مبلغ را درآمد می‌کرد،
 * درحالی‌که ردپا می‌گفت تفکیک شده. لنگر همان تراکنش می‌ماند تا ویرایش و
 * برگشت، سند را پیدا کنند.
 */
function postPlanned(database, { id, event, plan, actor, timeZone, journalSource, postJournal, treatment = null }) {
  const natureIssues=reviewNatureViolations(event.utterance || event.evidence || '',plan.lines,event);
  if(natureIssues.length) throw storeError(natureIssues.map(q=>q.text).join(' '),'REVIEW_NATURE_REQUIRED',409);
  // ثبت‌کنندهٔ تزریقیِ تراکنش فقط هزینه و درآمد می‌شناسد. برخوردی که نقشهٔ
  // خودش را دارد — پیش‌پرداخت، پیش‌دریافت — نباید در تأیید فوری یا ثبت خودکار
  // بی‌صدا هزینهٔ همان ماه شود؛ تأیید از صف این را از قبل رعایت می‌کرد.
  if (postJournal && !isGuardPlan(plan) && !treatmentHasPlan(treatment)) {
    const posted = postJournal(database, { event, plan, eventId: id, actor, timeZone });
    // مسیر تزریقی وضعیت و ردپا را خودش نمی‌نویسد؛ ردپا نباید به انتخاب
    // ثبت‌کننده وابسته باشد.
    if (posted?.id) markEventPosted(database, id, posted, plan.lines, actor);
    return posted;
  }
  return postEventJournal(database, id, event, plan, { actor, timeZone, journalSource });
}

/** نقشه را به سند تبدیل می‌کند؛ نقش‌ها اینجا به حساب واقعی نگاشت می‌شوند. */
function postEventJournal(database, eventId, event, plan, { actor = null, timeZone = 'Asia/Tehran', journalSource = null } = {}) {
  const lines = plan.lines.map((line) => ({
    accountId: resolveEventRole(database, line.role, line.key, event),
    // تفصیلی همان‌جا به سطر می‌چسبد، چون فقط اینجا می‌دانیم این سطر مال کدام
    // نقش است. بدون آن، طرف حساب در فایل انتقال گم می‌شود.
    analyticId: resolveEventAnalytic(database, line.role, event, line.key),
    debit: line.debit,
    credit: line.credit,
    description: plan.memoHint || null,
  }));
  const posted = postJournalEntry(database, {
    sourceType: journalSource?.type || 'financial-event',
    sourceId: journalSource?.id || eventId,
    occurredAt: event.occurredAt,
    memo: plan.memoHint || event.kind,
    lines,
  }, { createdBy: actor, timeZone });

  markEventPosted(database, eventId, posted, lines, actor);
  markTransactionAccountingRole(database, journalSource, plan.lines);
  return posted;
}

/**
 * ردیف نقدیِ پشت یک سند تخصصی، در جمع درآمد و هزینه نمی‌آید.
 *
 * وام، ودیعه، پیش‌پرداخت، پیش‌دریافت و آورده پول جابه‌جا می‌کنند ولی سود و
 * زیان نیستند. مسیر بررسی حسابدار همین علامت را می‌زند؛ موتور هم باید بزند،
 * وگرنه دویست میلیون وام در داشبورد «درآمد این ماه» دیده می‌شد.
 */
//
// فقط تأمین مالی: وام، واریز ناشناس و برداشت مالک (آورده با `capital_flow`).
// پیش‌پرداخت، ودیعه و خرید کالا پرداخت نقدی‌اند و در کارت «پرداخت امروز»
// می‌مانند؛ دفتر کل جداگانه نشان می‌دهد که هزینه نیستند.
const SPECIAL_COUNTERPART_ROLES = new Set(['loan-payable', 'unidentified-receipt', 'owner-drawing']);

function markTransactionAccountingRole(database, journalSource, planLines = []) {
  if (journalSource?.type !== 'transaction' || planLines.length !== 2) return;
  const counterpart = planLines.find((line) => line.role !== 'cash');
  if (!counterpart || !planLines.some((line) => line.role === 'cash')) return;
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transactions'").get()) return;
  if (counterpart.role === 'owner-capital') {
    database.prepare("UPDATE transactions SET capital_flow='capital-in' WHERE id=?").run(journalSource.id);
  } else if (SPECIAL_COUNTERPART_ROLES.has(counterpart.role)) {
    database.prepare('UPDATE transactions SET accounting_role=? WHERE id=?').run(counterpart.role, journalSource.id);
  }
}

/** وضعیت «ثبت شد» و ردپایش — مستقل از اینکه کدام لایه سند را زده است. */
function markEventPosted(database, eventId, posted, lines, actor) {
  database.prepare("UPDATE financial_events SET status='posted',journal_entry_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(posted.id, eventId);
  writeAudit(database, eventId, 'posted', { journalEntryId: posted.id, documentNumber: posted.documentNumber, lines }, actor);
}

/**
 * جواب کاربر به سؤال یک رویداد منتظر.
 *
 * چهار کار پشت سر هم، همه در یک تراکنش:
 *
 * ۱. جواب به واقعیت تبدیل و روی رویداد نشانده می‌شود؛
 * ۲. تصمیم دوباره گرفته می‌شود — تصمیم قبلی ویرایش نمی‌شود، تصمیم تازه با
 *    ارجاع به آن ساخته می‌شود تا تاریخچه دروغ نگوید؛
 * ۳. نقشهٔ سند با تصمیم تازه دوباره قفل می‌شود، چون ماهیت عوض شده؛
 * ۴. اگر تصمیم تازه برنامهٔ شناسایی بخواهد، ساخته می‌شود.
 *
 * سند اینجا ثبت **نمی‌شود**. جواب دادن یعنی ابهام برطرف شد، نه اینکه کاربر
 * تأیید کرد. ثبت همچنان کار `approveFinancialEvent` است.
 */
export function answerEventQuestion(database, eventId, { fact, value, freeText = '', actor = null, today = null, guardContext = {}, capitalizationThreshold = null } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status !== 'pending') throw storeError('این رویداد دیگر در انتظار نیست.', 'EVENT_NOT_PENDING', 409);

  const previous = decisionForEvent(database, row.id);
  const stored = JSON.parse(row.payload);
  const reference = today || stored.occurredAt;
  const patch = applyAnswer(stored, { fact, value, freeText }, { today: reference });
  const event = normalizeFinancialEvent({ ...stored, ...patch });
  const decision = decide(factsFromEvent(event), { today: reference, capitalizationThreshold });
  // نگهبان‌ها دوباره، چون ماهیت عوض شده. بدون این، جواب دادن به سؤال دورهٔ
  // پوشش نقشهٔ تفکیک ارزش افزوده را با نقشهٔ سادهٔ قاعده عوض می‌کرد و کل مبلغ
  // دوباره به سود و زیان می‌رفت — بی‌آنکه نگهبانی دوباره نگاه کند.
  const guards = runGuards(event, factsFromEvent(event), { ...guardContext, decision });
  const plan = guardedPlan(event, decision, guards);
  const blocked = guards.verdict === GUARD_VERDICTS.BLOCK;
  // جوابی که ماهیت را روشن کرد ولی ثبتش قضاوت می‌خواهد — دارایی ثابت، موجودی —
  // جایش صف حسابدار است. بدون این، رویداد در «تأیید کاربر» می‌ماند و تأییدش
  // هم رد می‌شد: کاربر گیر می‌کرد بی‌آنکه بداند منتظر چه کسی است.
  const forAccountant = ![DECISION_STATUS.DECIDED, DECISION_STATUS.NEEDS_USER_INPUT].includes(decision.decisionStatus);

  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('UPDATE financial_events SET payload=?,posting_plan=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(JSON.stringify(event), JSON.stringify(plan), row.id);
    if (blocked) {
      const confidence = JSON.parse(row.confidence);
      const routing = { ...confidence, route: ROUTES.ACCOUNTANT_REVIEW, guardBlocked: true, reasons: [...new Set([...(confidence.reasons || []), guards.reason])] };
      database.prepare('UPDATE financial_events SET route=?,confidence=? WHERE id=?').run(routing.route, JSON.stringify(routing), row.id);
    } else if (forAccountant) {
      const confidence = JSON.parse(row.confidence);
      const routing = { ...confidence, route: ROUTES.ACCOUNTANT_REVIEW, reasons: [...new Set([...(confidence.reasons || []), decision.explanation].filter(Boolean))] };
      database.prepare('UPDATE financial_events SET route=?,confidence=? WHERE id=?').run(routing.route, JSON.stringify(routing), row.id);
    }
    const decisionId = storeDecision(database, row.id, decision, previous?.id || null);
    database.prepare('UPDATE financial_events SET decision_id=? WHERE id=?').run(decisionId, row.id);
    const stored = storeSchedule(database, row.id, decision, event, { plan });
    if (stored?.blocked?.length) {
      const current = JSON.parse(database.prepare('SELECT confidence FROM financial_events WHERE id=?').get(row.id).confidence);
      const routing = { ...current, route: ROUTES.ACCOUNTANT_REVIEW, reasons: [...new Set([...(current.reasons || []), blockedRecognitionReason(stored.blocked)])] };
      database.prepare('UPDATE financial_events SET route=?,confidence=? WHERE id=?').run(routing.route, JSON.stringify(routing), row.id);
    }
    writeAudit(database, row.id, 'answered', { fact, value, freeText, patch, decision, guards: guards.checks }, actor);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }

  return { ...describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id)), decision };
}

/** تأیید کاربر یا حسابدار روی رویدادی که منتظر مانده بود. */
export function approveFinancialEvent(database, eventId, { actor = null, timeZone = 'Asia/Tehran', postJournal = null, overrideReason = '', withinTransaction = false } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status === 'posted') return describeStored(database, row);
  if (row.status !== 'pending') throw storeError('این رویداد دیگر در انتظار تأیید نیست.', 'EVENT_NOT_PENDING', 409);

  // نوشتن دلیل جایگزین اصلاح سند نیست. در مورد مبهم یا مسدود، نقشهٔ قفل‌شده
  // همچنان می‌تواند سند قدیمیِ درآمد/هزینه باشد؛ حتی حسابدار نباید آن را با
  // یک توضیح متنی بدون تعیین دوبارهٔ حساب‌ها تأیید کند.
  const decision = decisionForEvent(database, row.id);
  const undecided = decision && decision.decisionStatus !== DECISION_STATUS.DECIDED;
  const lockedPlan = row.posting_plan ? JSON.parse(row.posting_plan) : null;
  // صف حسابدارِ مسیر قدیمی — اطمینان پایین، بدون موتور تصمیم — همان رفتار
  // همیشگی را دارد؛ فقط مانعِ نگهبان override حساب می‌شود.
  const heldForAccountant = row.route === ROUTES.ACCOUNTANT_REVIEW && JSON.parse(row.confidence || '{}').guardBlocked === true;
  const reason = String(overrideReason || '').trim();
  // نگهبانی که واقعاً سند را بازنویسی کرده، نقشهٔ مشخص و متوازن دارد؛ حسابدار
  // می‌تواند همان نقشه را با دلیل تأیید کند. نقشهٔ عمومیِ حدسی چنین مجوزی ندارد.
  const reviewedGuardPlan = undecided && !heldForAccountant && isGuardPlan(lockedPlan);
  if (reviewedGuardPlan && reason.length < 5) {
    throw storeError('برای ثبت نقشهٔ اصلاح‌شدهٔ نگهبان، دلیل بررسی حسابدار لازم است.', 'EVENT_OVERRIDE_REASON_REQUIRED', 409);
  }
  if ((undecided && !reviewedGuardPlan) || heldForAccountant) {
    throw storeError(decision?.decisionStatus === DECISION_STATUS.NEEDS_USER_INPUT
      ? 'پیش از ثبت، به سؤال این مورد پاسخ بده تا تصمیم و نقشهٔ سند دوباره ساخته شوند.'
      : 'نقشهٔ سند این مورد قطعی نیست؛ آن را بررسی و در مسیر ثبت دستیِ حسابدار اصلاح کن.', 'EVENT_PLAN_REVISION_REQUIRED', 409);
  }

  const event = JSON.parse(row.payload);
  // نقشهٔ قفل‌شدهٔ لحظهٔ تصمیم، نه نقشه‌ای که کدِ امروز می‌سازد.
  //
  // رویدادهایی که پیش از این تغییر ثبت شده‌اند نقشهٔ ذخیره‌شده ندارند؛ برای
  // آن‌ها مثل قبل محاسبه می‌شود و همین در ردپا نوشته می‌شود، تا حسابرسی بتواند
  // این دو دسته را از هم تشخیص بدهد.
  const plan = lockedPlan || planJournal(event);
  // همان لنگری که در لحظهٔ ثبت تصمیم گرفته شد، نه لنگر تازه.
  const journalSource = row.journal_source ? JSON.parse(row.journal_source) : null;
  if (!withinTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    // سندِ رویدادی که روی تراکنش نشسته باید همان شکلی را داشته باشد که اگر
    // خودکار ثبت می‌شد داشت. تأیید حسابدار زمانِ ثبت را عوض می‌کند، نه سند را.
    postPlanned(database, { id: row.id, event, plan, actor, timeZone, journalSource, postJournal, treatment: decision?.treatment });
    writeAudit(database, row.id, 'approved', {
      by: actor, planSource: lockedPlan ? 'locked-at-capture' : 'recomputed-legacy',
      ...(reviewedGuardPlan ? { override: true, reason: reason.slice(0, 500), guard: lockedPlan.guard } : {}),
    }, actor);
    if (!withinTransaction) database.exec('COMMIT');
  } catch (error) { if (!withinTransaction) database.exec('ROLLBACK'); throw error; }
  return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
}

/** ثبتِ بررسی‌شدهٔ گفتهٔ چندمبلغی؛ حسابدار حساب‌ها و همهٔ مبالغ را صریح انتخاب می‌کند. */
export function postReviewedComposite(database, eventId, { lines, reason, actor = null, timeZone = 'Asia/Tehran', accountantProposal = false, eventOverride = null, contractEventId = null, contractEnded = null, contractEndedAt = null } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row || row.status !== 'pending' || row.route !== ROUTES.ACCOUNTANT_REVIEW || (!accountantProposal && (row.kind !== EVENT_KINDS.REVIEW_PLACEHOLDER || row.journal_source))) {
    throw storeError('فقط گفتهٔ چندمبلغیِ در انتظار را می‌توان از این مسیر ثبت کرد.', 'EVENT_NOT_REVIEWABLE', 409);
  }
  const explanation = String(reason || '').trim().slice(0, 500);
  if (explanation.length < 8) throw storeError('مبنای ثبت حسابدار را با حداقل هشت نویسه بنویس.', 'REVIEW_REASON_REQUIRED', 400);
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > 12) throw storeError('سند بررسی‌شده باید بین ۲ تا ۱۲ سطر داشته باشد.', 'REVIEW_LINES_INVALID', 400);
  if (lines.some((line) => !Number.isSafeInteger(line?.debit) || !Number.isSafeInteger(line?.credit) || line.debit < 0 || line.credit < 0)) {
    throw storeError('مبلغ هر سطر باید عدد صحیح نامنفی به تومان باشد.', 'REVIEW_LINES_INVALID', 400);
  }
  const counterpartyAccounts = new Set(['customer-receivable', 'vendor-payable', 'cheque-receivable', 'cheque-payable']);
  for (const line of lines) {
    const account = database.prepare('SELECT source_kind AS sourceKind FROM ledger_accounts WHERE id=?').get(String(line.accountId || ''));
    if (counterpartyAccounts.has(account?.sourceKind) && !line.analyticId) {
      throw storeError('برای سطر طرف حساب، تفصیلی همان طرف را تعیین کن.', 'REVIEW_ANALYTIC_REQUIRED', 400);
    }
  }
  // مبلغ مرجع در این خانواده مبلغ سند نیست. تراز و اعتبار حساب‌ها در
  // postJournalEntry بررسی می‌شود، نه با حدس از بزرگ‌ترین عدد گفتار.
  const safeLines = lines.map((line) => ({
    accountId: String(line.accountId || '').trim(),
    debit: line.debit, credit: line.credit,
    description: String(line.description || '').slice(0, 300),
    analyticId: line.analyticId || null, costCenterId: line.costCenterId || null,
  }));
  const event = eventOverride || JSON.parse(row.payload);
  // دورهٔ پوشش پیش از سند: سطر دوره‌دارِ بی‌دوره ثبت نمی‌شود.
  const timing = reviewedTimingPlan(database, row.id, event, safeLines);
  if (timing) {
    // دستهٔ هزینه یا درآمد ماهانه پیش از سند: نامعلومش پرسیده می‌شود.
    const chosen = reviewedTimingCategory(database, row.id, event, timing, lines);
    if (!chosen.category && chosen.question) throw Object.assign(storeError(chosen.question.text, 'REVIEW_DETAILS_REQUIRED', 409), { question: chosen.question });
    Object.assign(timing, { category: chosen.category, categoryBasis: chosen.basis });
  }
  // استرداد پیش از سند: قرارداد و سرنوشتش باید معلوم باشد.
  const reductions = reviewedContractReductions(database, row.id, event, safeLines, { contractEventId, contractEnded, contractEndedAt, reason: explanation });
  const source = row.journal_source ? JSON.parse(row.journal_source) : null;
  const posted = postJournalEntry(database, {
    sourceType: source?.type || 'financial-event', sourceId: source?.id || row.id, occurredAt: event.occurredAt,
    memo: `ثبت بررسی‌شده: ${explanation}`.slice(0, 500), lines: safeLines,
  }, { createdBy: actor, timeZone });
  database.prepare('UPDATE financial_events SET posting_plan=? WHERE id=?').run(JSON.stringify({
    kind: 'accountant-reviewed', lines: safeLines, memoHint: explanation,
  }), row.id);
  if (eventOverride) database.prepare('UPDATE financial_events SET payload=?,occurred_at=?,due_at=? WHERE id=?').run(JSON.stringify(event),event.occurredAt,event.dueAt || null,row.id);
  const reconciled = reconcileReviewedRecognition(database, row, event, timing, { actor, timeZone, journalEntryId: posted.id });
  for (const reduction of reductions) {
    const detail = reduceContractSchedule(database, reduction.contractEventId, {
      refund: reduction.amount, at: event.occurredAt, ended: reduction.ended, refundEventId: row.id, accountId: reduction.accountId, cutoff: reduction.cutoff, actor, timeZone,
    });
    writeAudit(database, row.id, 'contract-linked', { contractEventId: reduction.contractEventId, accountId: reduction.accountId, ...detail }, actor);
  }
  if (reductions.length) {
    const current = JSON.parse(database.prepare('SELECT payload FROM financial_events WHERE id=?').get(row.id).payload);
    database.prepare('UPDATE financial_events SET payload=? WHERE id=?')
      .run(JSON.stringify({ ...(reconciled || current), contractEventId: reductions[0].contractEventId }), row.id);
  }
  markEventPosted(database, row.id, posted, safeLines, actor);
  writeAudit(database, row.id, 'accountant-reviewed', { reason: explanation, journalEntryId: posted.id }, actor);
  return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
}

/**
 * برگشت یک رویداد ثبت‌شده.
 *
 * سند حذف نمی‌شود؛ سند معکوس می‌خورد و هر دو در تاریخچه می‌مانند. حذف، زنجیرهٔ
 * حسابرسی را پاک می‌کند و هیچ راهی برای بازسازی‌اش نمی‌ماند.
 */
export function reverseFinancialEvent(database, eventId, { actor = null, reason = '', timeZone = 'Asia/Tehran', withinTransaction = false } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status !== 'posted') throw storeError('فقط رویداد ثبت‌شده معکوس می‌شود.', 'EVENT_NOT_POSTED', 409);

  // قراردادی که استرداد ثبت‌شده‌ای برنامه‌اش را کم کرده، تا آن استرداد سر جایش
  // است برنمی‌گردد — همان قاعدهٔ اثر وابستهٔ موجودی و چک. برگشت قرارداد همهٔ
  // پرداخت را برمی‌گرداند؛ استردادِ ماندهٔ بخشی از همان پول، پیش‌پرداخت را
  // بستانکار (و درآمد انتقالی را بدهکار، «مستأجر به ما بدهکار است») می‌کرد.
  const dependents = linkedRefunds(database, row.id).filter((link) => link.eventId !== row.id);
  if (dependents.length) {
    throw storeError(`این قرارداد استرداد ثبت‌شده دارد (${refundLabel(dependents)})؛ اول آن استرداد را برگردان، بعد خود قرارداد را.`, 'EVENT_HAS_LINKED_REFUND', 409);
  }
  // استردادی که به قرارداد وصل است: برنامهٔ قرارداد هم با آن برمی‌گردد. استرداد
  // دیگری که بعد از آن همان قرارداد را کم کرده، اول باید برگردد؛ وگرنه
  // بازگرداندن وضعیت پیشین اثر استرداد بعدی را پاک می‌کرد.
  const ownLinks = database.prepare("SELECT rowid AS auditRow,event_id AS eventId,detail FROM financial_event_audit WHERE event_id=? AND stage='contract-linked' ORDER BY rowid DESC")
    .all(row.id).map((link) => ({ ...link, detail: JSON.parse(link.detail || '{}') }));
  for (const link of ownLinks) {
    const later = linkedRefunds(database, link.detail.contractEventId).filter((other) => other.eventId !== row.id && other.auditRow > link.auditRow);
    if (later.length) {
      throw storeError(`پس از این استرداد، استرداد دیگری همان قرارداد را کم کرده (${refundLabel(later)})؛ اول آن را برگردان.`, 'EVENT_HAS_LINKED_REFUND', 409);
    }
  }
  const restoreLinks = () => {
    const memo = reason ? `برگشت استرداد: ${reason}`.slice(0, 200) : 'برگشت استرداد';
    return ownLinks.map((link) => restoreContractSchedule(database, link, { actor, timeZone, memo }));
  };

  // سند این رویداد ممکن است به تراکنش لنگر خورده باشد، نه به خودِ رویداد.
  // جست‌وجوی لنگر اشتباه چیزی پیدا نمی‌کند و `reverseJournalEntry` بی‌صدا
  // `null` برمی‌گرداند — رویداد «معکوس‌شده» علامت می‌خورد ولی سندش سر جایش
  // می‌ماند. بدترین نوع خطا: دفتر غلط است و هیچ نشانه‌ای ندارد.
  const anchor = row.journal_source ? JSON.parse(row.journal_source) : null;
  // برنامهٔ ماندهٔ بی‌سند سند خودش را ندارد؛ برگشتش فقط برنامه را برمی‌گرداند و
  // سند مبنا (افتتاحیه، سند دستی) هرگز از این مسیر معکوس نمی‌شود.
  if (row.kind === 'balance-recognition') {
    if (!withinTransaction) database.exec('BEGIN IMMEDIATE');
    try {
      retireRecognitionSchedule(database, row.id, { actor, timeZone, memo: reason ? `برگشت شناسایی: ${reason}`.slice(0, 200) : undefined });
      database.prepare("UPDATE financial_events SET status='reversed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
      writeAudit(database, row.id, 'reversed', { reason: String(reason || '').slice(0, 300), scheduleOnly: true }, actor);
      if (!withinTransaction) database.exec('COMMIT');
    } catch (error) { if (!withinTransaction) database.exec('ROLLBACK'); throw error; }
    return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
  }
  if (!withinTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    const reversal = reverseJournalEntry(database, {
      sourceType: anchor?.type || 'financial-event', sourceId: anchor?.id || row.id,
      memo: reason ? `برگشت: ${reason}`.slice(0, 200) : 'برگشت رویداد مالی',
      createdBy: actor, timeZone,
    });
    // رویدادی که «ثبت‌شده» است حتماً سندی دارد. اگر پیدا نشد، یعنی لنگر غلط
    // است؛ علامت‌زدن «معکوس شد» در این حالت فقط ردپا را دروغ می‌کند.
    if (!reversal) throw storeError('سند این رویداد پیدا نشد؛ برگشت انجام نشد.', 'EVENT_JOURNAL_MISSING', 409);
    // برنامهٔ شناسایی دنبالهٔ همین سند است و با آن برمی‌گردد — پیش‌پرداخت و
    // درآمد انتقالی هر دو. بدون این، هزینهٔ ماه‌های گذشته برای پولی که برگشته
    // در دفتر می‌ماند و اجرای بعدی ماه‌های آینده را هم می‌ساخت.
    retireRecognitionSchedule(database, row.id, { actor, timeZone, memo: reason ? `برگشت شناسایی: ${reason}`.slice(0, 200) : undefined });
    const restoredContracts = restoreLinks();
    database.prepare("UPDATE financial_events SET status='reversed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
    writeAudit(database, row.id, 'reversed', {
      reason: String(reason || '').slice(0, 300), reversalEntryId: reversal.id,
      ...(restoredContracts.length ? { restoredContracts: ownLinks.map((link) => link.detail.contractEventId) } : {}),
    }, actor);
    if (!withinTransaction) database.exec('COMMIT');
  } catch (error) { if (!withinTransaction) database.exec('ROLLBACK'); throw error; }
  return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
}

/** رد رویداد در صف بررسی، بدون ساختن سند. */
export function rejectFinancialEvent(database, eventId, { actor = null, reason = '' } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status !== 'pending') throw storeError('فقط رویداد در انتظار قابل رد است.', 'EVENT_NOT_PENDING', 409);
  database.prepare("UPDATE financial_events SET status='rejected',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
  // برنامه‌ای که در لحظهٔ ضبط ساخته شد، با رد بی‌موضوع است؛ زنده ماندنش پنجرهٔ
  // اجرای ماهانه را برای رویدادهای واقعی پر می‌کرد.
  retireRecognitionSchedule(database, row.id, { actor });
  writeAudit(database, row.id, 'rejected', { reason: String(reason || '').slice(0, 300) }, actor);
  return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
}

/** سطرهای سندِ برنامه‌ریزی‌شده با نام‌هایی که کاربر می‌شناسد: حسابِ بانک، دسته، طرف حساب. */
function planPreview(database, row) {
  let plan = null;
  try { plan = row.posting_plan ? JSON.parse(row.posting_plan) : null; } catch { plan = null; }
  const lines = Array.isArray(plan?.lines) ? plan.lines : [];
  if (!lines.length) return null;
  const accountName = (id) => {
    try { return database.prepare('SELECT name FROM accounts WHERE id=?').get(String(id || ''))?.name || null; } catch { return null; }
  };
  return {
    lines: lines.map((line) => ({
      role: line.role, debit: Number(line.debit) || 0, credit: Number(line.credit) || 0,
      label: line.role === 'cash' ? accountName(line.key) || (line.key === 'cash' ? 'صندوق' : null) : (line.key || null),
    })),
  };
}

function describeStored(database, row) {
  const decision = decisionForEvent(database, row.id);
  const held = row.route === ROUTES.ACCOUNTANT_REVIEW && JSON.parse(row.confidence || '{}').guardBlocked === true;
  const undecided = decision && decision.decisionStatus !== DECISION_STATUS.DECIDED;
  const guardPlan = !held && isGuardPlan(row.posting_plan ? JSON.parse(row.posting_plan) : null);
  const approvalBlocked = Boolean(held || (undecided && !guardPlan));

  return {
    id: row.id,
    sourceEventId: row.source_event_id,
    kind: row.kind,
    amount: row.amount,
    occurredAt: row.occurred_at,
    dueAt: row.due_at,
    route: row.route,
    status: row.status,
    journalEntryId: row.journal_entry_id,
    approvalBlocked,
    approvalNextStep: approvalBlocked ? (decision?.decisionStatus === DECISION_STATUS.NEEDS_USER_INPUT ? 'answer-question' : 'manual-review') : 'approve',
    // سندی که با «تأیید» زده می‌شود، فقط وقتی تأیید باز است: سطرِ موردِ گیرافتاده حدسِ
    // پارسر است و نشان‌دادنش به‌عنوان «سند نهایی» گمراه می‌کرد (صف حسابدار، ۲۹ مهر ۱۴۰۵).
    plan: approvalBlocked ? null : planPreview(database, row),
    decisionId: row.decision_id || null,
    event: JSON.parse(row.payload),
    confidence: JSON.parse(row.confidence),
    createdAt: row.created_at,
  };
}

/**
 * صف بررسی: هرچه ثبت نشده و رد هم نشده.
 *
 * `route` صف را تنگ می‌کند. حسابدار همه را می‌بیند، ولی صاحب کسب‌وکار فقط
 * مسیر `confirm` را — یعنی چیزهایی که خودش می‌تواند جواب بدهد. موردی که به
 * دانش حسابداری نیاز دارد اصلاً به او نشان داده نمی‌شود.
 */
export function listReviewQueue(database, { limit = 50, route = '' } = {}) {
  ensureFinancialEventSchema(database);
  const filter = ROUTE_VALUES.includes(route) ? ' AND route=?' : '';
  const params = filter ? [route] : [];
  const rows = database.prepare(`SELECT * FROM financial_events
    WHERE status='pending'${filter} ORDER BY
      CASE route WHEN 'accountant-review' THEN 0 ELSE 1 END, created_at DESC
    LIMIT ?`).all(...params, Math.max(1, Math.min(200, Number(limit) || 50)));
  return rows.map((row) => describeStored(database, row));
}

const ROUTE_VALUES = Object.freeze(Object.values(ROUTES));

/**
 * سپردن یک مورد به حسابدار.
 *
 * وقتی صاحب کسب‌وکار می‌گوید «نمی‌دانم»، جواب درست پاک کردن نیست. مورد همان‌جا
 * می‌ماند و فقط مسیرش عوض می‌شود تا در صف کسی بنشیند که می‌تواند جوابش را بدهد.
 */
export function handOverToAccountant(database, eventId, { actor = null, reason = '' } = {}) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE id=?').get(String(eventId || ''));
  if (!row) throw storeError('رویداد پیدا نشد.', 'EVENT_MISSING', 404);
  if (row.status !== 'pending') throw storeError('این مورد دیگر در انتظار نیست.', 'EVENT_NOT_PENDING', 409);
  database.prepare("UPDATE financial_events SET route='accountant-review',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
  writeAudit(database, row.id, 'handed-over', { reason: String(reason || '').slice(0, 300) }, actor);
  return describeStored(database, database.prepare('SELECT * FROM financial_events WHERE id=?').get(row.id));
}

/** تاریخچهٔ کامل یک رویداد، از گفته تا برگشت. */
export function financialEventAudit(database, eventId) {
  ensureFinancialEventSchema(database);
  return database.prepare('SELECT stage,actor,detail,created_at AS createdAt FROM financial_event_audit WHERE event_id=? ORDER BY created_at,rowid')
    .all(String(eventId || ''))
    .map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
}

/**
 * رویداد ثبت‌شده برای یک منبع، اگر وجود داشته باشد.
 *
 * مهاجرت تدریجی به این لازم دارد: تعهدی که پیش از این تغییر ساخته شده هیچ
 * سندی در دفتر ندارد، پس تسویه‌اش نباید از حساب دریافتنی کم کند — آن حساب
 * اصلاً موجودی ندارد و منفی می‌شود. مسیر تازه فقط برای تعهدهایی است که
 * خودشان از این مسیر آمده‌اند.
 */
export function findEventBySource(database, sourceEventId) {
  ensureFinancialEventSchema(database);
  const row = database.prepare('SELECT * FROM financial_events WHERE source_event_id=?').get(String(sourceEventId || ''));
  return row ? describeStored(database, row) : null;
}
