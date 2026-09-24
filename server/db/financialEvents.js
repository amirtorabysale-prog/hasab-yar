import { activeWorkspaceDatabase, audit, currentTimeZone, currentWorkspace, db } from './core.js';
import { answerEventQuestion, approveFinancialEvent, decisionForEvent, financialEventAudit, handOverToAccountant, listReviewQueue, recordFinancialEvent, rejectFinancialEvent, reverseFinancialEvent, scheduleForEvent, postDueRecognitionItems } from '../financialEventStore.js';
import { treatmentHasPlan } from '../../shared/accountingRules.js';
import { contactIdForName } from './contacts.js';
import { describeEvent, normalizeFinancialEvent } from '../../shared/financialEvent.js';
import { settlementFor, transactionJournalPoster } from './transactions.js';
import { openDocumentsFor } from './counterpartyCard.js';
import { vatGuardContext } from '../tax.js';

// ---------------------------------------------------------------------------
// رویدادهای مالی و صف بررسی
// ---------------------------------------------------------------------------

/**
 * ثبت یک رویداد مالی.
 *
 * تصمیمِ «سند چه باشد» اینجا گرفته نمی‌شود؛ `shared/accountingRules.js` آن را
 * می‌گیرد و لایهٔ ثبت فقط اجرا می‌کند. این تابع فقط دروازهٔ ورود است.
 */
export function submitFinancialEvent(event, options = {}) {
  const normalized = normalizeFinancialEvent(event);
  let resolvedEvent = normalized;
  if (normalized.counterparty && !normalized.counterpartyId) {
    const counterpartyId = contactIdForName(normalized.counterparty, options.counterpartyResolution);
    const contact = counterpartyId ? db.prepare('SELECT id,name FROM contacts WHERE id=?').get(counterpartyId) : null;
    resolvedEvent = { ...normalized, counterpartyId, counterparty: contact?.name || normalized.counterparty };
  }
  const result = recordFinancialEvent(activeWorkspaceDatabase(), resolvedEvent, {
    ...options,
    actor: options.actor || currentWorkspace()?.userId || null,
    timeZone: currentTimeZone(),
  });
  if (!result.duplicate) audit('create', 'financial-event', result.id, { kind: resolvedEvent.kind, amount: resolvedEvent.amount, route: result.route });
  return result;
}

export function reviewQueue(options = {}) {
  return { items: listReviewQueue(activeWorkspaceDatabase(), options) };
}

/**
 * پرسش‌های بازِ صاحب کسب‌وکار.
 *
 * فقط مسیر `confirm` — یعنی مواردی که خودِ کاربر می‌تواند جوابشان را بدهد.
 * چیزی که به دانش حسابداری نیاز دارد به او نشان داده نمی‌شود؛ آن در صف
 * حسابدار می‌ماند.
 *
 * خروجی عمداً تنگ است: نه نمرهٔ اطمینان، نه نام مسیر، نه مؤلفه‌ها، نه نقشهٔ
 * سند. کاربری که دانش حسابداری ندارد با دیدن این‌ها تصمیم بهتری نمی‌گیرد،
 * فقط اعتمادش را از دست می‌دهد.
 */
export function pendingConfirmations(limit = 5) {
  const items = listReviewQueue(activeWorkspaceDatabase(), { limit, route: 'confirm' });
  return {
    items: items.map((item) => ({
      id: item.id,
      question: item.confidence?.summary || describeEvent(item.event),
      // یک دلیل، به زبان ساده. فهرست دلایل، پرسش را به بازجویی تبدیل می‌کند.
      hint: item.confidence?.reasons?.[0] || '',
      amount: item.amount,
      occurredAt: item.occurredAt,
      evidence: String(item.event?.evidence || '').slice(0, 300),
    })),
  };
}

/** «بله، درست است» — همان تأیید، با همان مسیر سند. */
export function confirmPending(eventId) {
  return approveEvent(eventId);
}

/**
 * ردیف تراکنشی که رویدادش رد یا معکوس شده.
 *
 * چرا لازم است: ماندهٔ حساب و گزارش‌های کاربر از جدول `transactions` ساخته
 * می‌شوند، نه از دفتر کل. اگر فقط رویداد رد شود، ردیف تراکنش سر جایش می‌ماند و
 * تا ابد در ماندهٔ صندوق و گزارش ماه دیده می‌شود — درحالی‌که هیچ سندی ندارد و
 * هیچ‌وقت هم نخواهد داشت. دفتر و برنامه دائم اختلاف نشان می‌دهند و هیچ‌کس
 * نمی‌فهمد چرا.
 *
 * حذف فیزیکی نمی‌شود: همان `status='deleted'` که مسیر حذف عادی استفاده می‌کند.
 */
function retireTransactionBehind(eventId, action) {
  const database = activeWorkspaceDatabase();
  const row = database.prepare('SELECT journal_source AS journalSource FROM financial_events WHERE id=?').get(String(eventId || ''));
  const source = row?.journalSource ? JSON.parse(row.journalSource) : null;
  if (source?.type !== 'transaction') return;
  const changed = database.prepare("UPDATE transactions SET status='deleted',journal_deferred=0,updated_at=? WHERE id=? AND status!='deleted'")
    .run(new Date().toISOString(), source.id).changes;
  if (changed) audit(action, 'transaction', source.id, { because: 'financial-event', eventId });
}

/** «نمی‌دانم» — مورد به حسابدار سپرده می‌شود، نه پاک. */
export function handOverPending(eventId) {
  const item = handOverToAccountant(activeWorkspaceDatabase(), eventId, {
    actor: currentWorkspace()?.userId || null, reason: 'کاربر گفت مطمئن نیست.',
  });
  audit('handover', 'financial-event', eventId, { route: item.route });
  return item;
}

export function approveEvent(eventId) {
  const database = activeWorkspaceDatabase();
  // رویدادی که روی یک تراکنش نشسته، سندش را از همان مسیر تراکنش می‌گیرد. اگر
  // اینجا نقشهٔ نقش‌محور اجرا شود، دو تراکنش هم‌شکل بسته به اینکه خودکار ثبت
  // شده‌اند یا با تأیید، دو سند متفاوت می‌گیرند.
  const row = database.prepare('SELECT journal_source AS journalSource FROM financial_events WHERE id=?').get(String(eventId || ''));
  const source = row?.journalSource ? JSON.parse(row.journalSource) : null;
  let postJournal = null;
  // ولی وقتی تصمیم برخوردی را انتخاب کرده که نقشهٔ خودش را دارد — مثل
  // پیش‌پرداخت — مسیر تراکنش نباید برنده شود. آن مسیر فقط هزینه و درآمد
  // می‌شناسد و سکوت‌کنان تصمیم را دور می‌زند.
  const decision = decisionForEvent(database, eventId);
  const decisionDrivesPlan = treatmentHasPlan(decision?.treatment);
  if (source?.type === 'transaction' && !decisionDrivesPlan) {
    // شناسهٔ طرف حساب هم خوانده می‌شود: بدون آن، سندی که با تأیید ثبت
    // می‌شود روی دستهٔ هزینه می‌نشیند درحالی‌که همان ثبت اگر خودکار رفته بود
    // بدهی همان شخص را می‌بست. دو سند متفاوت برای یک ثبت، بسته به اینکه
    // حسابدار تأییدش کرده یا نه.
    const transaction = database.prepare(`SELECT id,amount,type,category,raw_text AS rawText,
      account_id AS accountId,occurred_at AS occurredAt,contact_id AS contactId,
      settlement_choice AS settlement FROM transactions WHERE id=?`).get(source.id);
    if (transaction) postJournal = transactionJournalPoster(transaction, settlementFor(transaction));
  }
  const item = approveFinancialEvent(database, eventId, {
    actor: currentWorkspace()?.userId || null, timeZone: currentTimeZone(), postJournal,
  });
  if (source?.type === 'transaction') database.prepare('UPDATE transactions SET journal_deferred=0 WHERE id=?').run(source.id);
  audit('approve', 'financial-event', eventId, { status: item.status });
  return item;
}

export function reverseEvent(eventId, reason = '') {
  const item = reverseFinancialEvent(activeWorkspaceDatabase(), eventId, {
    actor: currentWorkspace()?.userId || null, reason, timeZone: currentTimeZone(),
  });
  retireTransactionBehind(eventId, 'reverse');
  audit('reverse', 'financial-event', eventId, { reason: String(reason || '').slice(0, 200) });
  return item;
}

export function rejectEvent(eventId, reason = '') {
  const item = rejectFinancialEvent(activeWorkspaceDatabase(), eventId, {
    actor: currentWorkspace()?.userId || null, reason,
  });
  retireTransactionBehind(eventId, 'reject');
  audit('reject', 'financial-event', eventId, { reason: String(reason || '').slice(0, 200) });
  return item;
}

export function eventAudit(eventId) {
  return { items: financialEventAudit(activeWorkspaceDatabase(), eventId) };
}

/**
 * جواب کاربر به سؤال یک رویداد.
 *
 * جواب دادن ثبت نیست: ابهام برطرف می‌شود و تصمیم تازه ساخته می‌شود، ولی سند
 * همچنان با تأیید زده می‌شود. اگر جواب دادن خودش سند می‌زد، کاربر با یک کلیک
 * روی «از همین ماه» ناخواسته دفتر را تکان می‌داد.
 */
export function answerEvent(eventId, { fact, value, freeText = '' } = {}) {
  const database = activeWorkspaceDatabase();
  // نگهبان‌ها پس از جواب دوباره اجرا می‌شوند و همان چیزی را لازم دارند که در
  // لحظهٔ ثبت داشتند — با وضعیت امروزِ دفتر، نه وضعیت آن روز.
  const stored = database.prepare('SELECT payload FROM financial_events WHERE id=?').get(String(eventId || ''));
  const contactId = stored ? JSON.parse(stored.payload).counterpartyId : null;
  const item = answerEventQuestion(database, eventId, {
    fact, value, freeText, actor: currentWorkspace()?.userId || null,
    guardContext: { vat: vatGuardContext(database), openDocuments: contactId ? openDocumentsFor(contactId) : undefined },
  });
  audit('answer', 'financial-event', eventId, { fact, value, status: item.decision?.decisionStatus });
  return item;
}

/** تصمیم و برنامهٔ شناسایی یک رویداد — برای صف بررسی. */
/**
 * اجرای اقلام شناسایی سررسیدرسیده.
 *
 * دستی صدا زده می‌شود، نه خودکار: تا وقتی کسی ندیده موتور چه می‌سازد، اجرای
 * خودکارش روی دفتر واقعی همان حدسی است که کل طرح برای حذفش نوشته شده.
 */
export function runRecognition() {
  const result = postDueRecognitionItems(activeWorkspaceDatabase(), {
    actor: currentWorkspace()?.userId || null, timeZone: currentTimeZone(),
  });
  if (result.posted) audit('recognize', 'recognition-schedule', 'due', result);
  return result;
}

export function eventDecision(eventId) {
  const database = activeWorkspaceDatabase();
  return { decision: decisionForEvent(database, eventId), schedule: scheduleForEvent(database, eventId) };
}
