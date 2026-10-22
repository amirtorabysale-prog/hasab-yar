// ویرایش، اصلاح آخرین ثبت، حذف با سند معکوس، و برگرداندن حذف.
//
// از server/db/transactions.js جدا شد؛ بدنهٔ اعلان‌ها دست نخورده است. بیرون از پوشهٔ
// transactions همه از همان server/db/transactions.js می‌خوانند.

import { resolveAccountId } from '../accounts.js';
import { audit, cleanAmount, currentTimeZone, currentWorkspace, db, parseStoredJson } from '../core.js';
import { assertAccountingPeriodOpen, periodForDate, postCapitalJournal, reverseTransactionJournal, syncTransactionJournal, transactionJournalIsPlain } from '../../accounting.js';
import { reverseFinancialEvent } from '../../financialEventStore.js';
import { capitalEntryTitle, normalizeReviewState, jsonText, transactionRow, transactionAnyRow, latestTransaction } from './rows.js';
import { insertTransactionRows } from './recording.js';

export function updateTransaction(id, values = {}) {
  const current = transactionRow(id);
  if (!current) return null;
  if (current.accountingRole) throw Object.assign(new Error('این ثبت تخصصی را از سند و پرونده بررسی حسابدار اصلاح یا برگشت کن.'), {code:'REVIEWED_TRANSACTION_LOCKED',status:409});
  if (current.journalDeferred) throw Object.assign(new Error('این ثبت هنوز در صف بررسی است؛ ابتدا آن را از همان صف تعیین‌تکلیف کن.'), { code: 'PENDING_TRANSACTION_LOCKED', status: 409 });
  if (current.status === 'allocated') throw Object.assign(new Error('این جابه‌جایی پول از تسویهٔ یک سند ساخته شده و فقط از داخل همان سند قابل اصلاح است.'), { code: 'ALLOCATED_TRANSACTION_LOCKED', status: 409 });
  const type = ['income', 'expense'].includes(values.type) ? values.type : current.type;
  const amount = values.amount == null ? current.amount : cleanAmount(values.amount);
  const occurredAt = values.occurredAt || current.occurredAt;
  const accountId = values.accountId == null && values.account == null ? current.accountId : resolveAccountId(values);
  assertAccountingPeriodOpen(db, periodForDate(current.occurredAt, currentTimeZone()));
  assertAccountingPeriodOpen(db, periodForDate(occurredAt, currentTimeZone()));
  const category = String(values.category || current.category).slice(0, 80);
  const rawText = String(values.rawText ?? current.rawText).slice(0, 1000);
  // ثبت سرمایه‌ای نوعش را از جریانش می‌گیرد، نه از فرم: «آورده» همیشه
  // بستانکار سرمایه است و «دارایی ثابت» همیشه بدهکار دارایی.
  if (current.capitalFlow && values.type && values.type !== current.type) {
    throw Object.assign(new Error('نوع ثبت آورده یا دارایی ثابت عوض نمی‌شود؛ اگر اشتباه ثبت شده، حذفش کن و درست ثبت کن.'), { code: 'CAPITAL_TYPE_LOCKED', status: 409 });
  }
  const changedByUser = ['amount', 'type', 'category', 'accountId', 'account'].some((field) => values[field] !== undefined);
  const needsReview = values.needsReview === undefined ? (changedByUser ? false : current.needsReview) : Boolean(values.needsReview);
  const confidence = Number(values.confidence ?? current.confidence ?? 1);
  const confidenceDetails = values.confidenceDetails ?? current.confidenceDetails ?? {};
  const reviewReasons = values.reviewReasons ?? current.reviewReasons ?? [];
  const reviewState = normalizeReviewState(values.reviewState, changedByUser ? 'reviewed' : current.reviewState);
  // یادداشت، متن و وضعیت بازبینی در سند نیستند؛ عوض کردنشان سند را دست نمی‌زند.
  const journalChanged = amount !== current.amount || type !== current.type || category !== current.category
    || accountId !== current.accountId || occurredAt !== current.occurredAt;
  if (journalChanged && !current.capitalFlow && !transactionJournalIsPlain(db, id)) {
    throw Object.assign(new Error('سند این ثبت تخصصی است (تفکیک ارزش افزوده، پیش‌پرداخت یا تسویهٔ طرف حساب) و با ویرایش ساده بازسازی نمی‌شود؛ برای تغییر مبلغ، نوع، دسته، حساب یا تاریخ، حذفش کن و دوباره ثبت کن.'), { code: 'SPECIALIZED_TRANSACTION_LOCKED', status: 409 });
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (journalChanged) reverseTransactionJournal(db, id, current.occurredAt, { createdBy: currentWorkspace()?.userId });
    db.prepare(`UPDATE transactions SET amount=?,type=?,category=?,raw_text=?,note=?,account=?,account_id=?,contact_id=?,occurred_at=?,due_at=?,
      confidence=?,needs_review=?,confidence_details=?,review_reasons=?,review_state=?,updated_at=? WHERE id=?`)
      .run(amount, type, category, rawText, String(values.note ?? current.note ?? '').slice(0, 500), accountId, accountId,
        values.contactId === undefined ? current.contactId : (values.contactId || null), occurredAt,
        values.dueAt === undefined ? current.dueAt : (values.dueAt || null), confidence, needsReview ? 1 : 0,
        jsonText(confidenceDetails, {}), jsonText(reviewReasons, []), reviewState, new Date().toISOString(), id);
    // سند این ثبت از کدام مسیر آمده بود؟ آورده و دارایی ثابت از
    // `postCapitalJournal` می‌آیند و اگر ویرایش، سند تازه را از مسیر دستهٔ
    // درآمد/هزینه بسازد، آورده تبدیل به درآمد می‌شود و دارایی ثابت به هزینه —
    // دقیقاً همان چیزی که کل طراحی «جریان سرمایه» برای جلوگیری از آن ساخته
    // شده بود. جمع سند هم درست می‌ماند، پس هیچ کنترلی نمی‌گیردش.
    if (!journalChanged) {
      // سند فعلی سر جایش می‌ماند.
    } else if (current.capitalFlow) {
      postCapitalJournal(db, {
        transactionId: id, kind: current.capitalFlow, amount, accountId, occurredAt,
        title: capitalEntryTitle({ ...current, category }),
      }, { createdBy: currentWorkspace()?.userId });
    } else {
      // برچسب موضوعی با ویرایش نمی‌افتد: نسخهٔ تازهٔ سند همان تفصیلیِ موضوع را می‌گیرد.
      syncTransactionJournal(db, { id, amount, type, category, rawText, accountId, occurredAt, topicLabel: current.topicLabel }, { createdBy: currentWorkspace()?.userId });
    }
    audit('update', 'transaction', id, { before: current, after: values });
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return transactionRow(id);
}

export function correctLatestTransaction(targetId, command, changes = {}) {
  const latest = latestTransaction();
  if (!latest) throw Object.assign(new Error('هنوز ثبتی برای اصلاح وجود ندارد.'), { code: 'LATEST_TRANSACTION_MISSING', status: 404 });
  if (!targetId || latest.id !== targetId) throw Object.assign(new Error('در این فاصله ثبت تازه‌ای اضافه شده؛ اصلاح را دوباره بررسی کن.'), { code: 'LATEST_TRANSACTION_CHANGED', status: 409 });
  const allowed = Object.fromEntries(Object.entries(changes).filter(([key]) => ['amount', 'type', 'category', 'accountId'].includes(key)));
  if (!Object.keys(allowed).length) throw Object.assign(new Error('تغییر قابل‌اعمالی در فرمان پیدا نشد.'), { code: 'CORRECTION_EMPTY', status: 400 });
  const item = updateTransaction(targetId, {
    ...allowed,
    rawText: `${latest.rawText}\nاصلاح گفتاری: ${String(command || '').trim()}`,
    needsReview: false,
    reviewState: 'reviewed',
    reviewReasons: [...(latest.reviewReasons || []), `اصلاح با فرمان کاربر: ${String(command || '').trim()}`],
  });
  audit('conversation_correction', 'transaction', targetId, { command: String(command || '').slice(0, 500), changes: allowed });
  return item;
}

export function deleteTransaction(id) {
  const current = transactionRow(id);
  if (!current) return false;
  if (current.accountingRole) throw Object.assign(new Error('این ثبت تخصصی را از سند و پرونده بررسی حسابدار اصلاح یا برگشت کن.'), {code:'REVIEWED_TRANSACTION_LOCKED',status:409});
  if (current.journalDeferred) throw Object.assign(new Error('برای حذف ثبت معلق، آن را در صف بررسی رد کن تا رویداد و تراکنش با هم بسته شوند.'), { code: 'PENDING_TRANSACTION_LOCKED', status: 409 });
  if (current.status === 'allocated') throw Object.assign(new Error('تراکنش تخصیص‌یافته به سند را نمی‌توان جداگانه حذف کرد.'), { code: 'ALLOCATED_TRANSACTION_LOCKED', status: 409 });
  assertAccountingPeriodOpen(db, periodForDate(current.occurredAt, currentTimeZone()));
  // رویدادی که سندش روی همین تراکنش نشسته، با آن بسته می‌شود.
  //
  // حذف تراکنش تا امروز فقط سند تراکنش را معکوس می‌کرد و رویداد «ثبت‌شده»
  // می‌ماند؛ برنامهٔ شناسایی پیش‌پرداخت یا درآمد انتقالی‌اش هر ماه برای پولی
  // که دیگر وجود نداشت هزینه یا درآمد می‌ساخت، و ثبت دوبارهٔ درستِ کاربر — همان
  // کاری که پیام قفل ویرایش از او می‌خواهد — دو برابر شناسایی می‌شد. همین مسیر
  // «برگرداندن آخرین ثبت» و حذف ثبتِ تأییدشده از فهم AI را هم می‌پوشاند.
  const event = postedEventOnTransaction(id);
  // ثبتی که حسابدار از پرونده زده، اثرهای وابسته‌اش (موجودی، چک، تخصیص) را
  // فقط برگشت همان پرونده می‌شناسد؛ حذف از دفتر روزانه آن‌ها را جا می‌گذاشت.
  if (event?.reviewed) throw Object.assign(new Error('این ثبت تخصصی را از سند و پرونده بررسی حسابدار اصلاح یا برگشت کن.'), {code:'REVIEWED_TRANSACTION_LOCKED',status:409});
  db.exec('BEGIN IMMEDIATE');
  try {
    if (event) {
      reverseFinancialEvent(db, event.id, {
        actor: currentWorkspace()?.userId || null, reason: 'حذف تراکنش', timeZone: currentTimeZone(), withinTransaction: true,
      });
    } else {
      reverseTransactionJournal(db, id, current.occurredAt, { createdBy: currentWorkspace()?.userId, memo: 'سند معکوس حذف تراکنش' });
    }
    db.prepare("UPDATE transactions SET status='deleted',updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    audit('delete', 'transaction', id, current);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return true;
}

/**
 * رویداد ثبت‌شده‌ای که سندش به این تراکنش لنگر خورده، اگر باشد.
 *
 * `reviewed` یعنی سند را حسابدار از پرونده زده، نه موتور از گفته.
 */
const hasEventTable = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='financial_events'").get());

function postedEventOnTransaction(id) {
  if (!hasEventTable()) return null;
  const row = db.prepare(`SELECT id,posting_plan AS postingPlan FROM financial_events WHERE status='posted'
    AND json_extract(journal_source,'$.type')='transaction' AND json_extract(journal_source,'$.id')=?
    ORDER BY created_at DESC LIMIT 1`).get(String(id));
  if (!row) return null;
  const plan = parseStoredJson(row.postingPlan, null);
  return { id: row.id, reviewed: plan?.kind === 'accountant-reviewed' };
}

export function redoTransaction(id) {
  const current = transactionAnyRow(id);
  if (!current || current.status !== 'deleted') throw Object.assign(new Error('ثبت حذف‌شده برای بازیابی پیدا نشد.'), { code: 'REDO_SOURCE_MISSING', status: 404 });
  const alreadyRestored = db.prepare("SELECT id FROM transactions WHERE restored_from=? AND status!='deleted' ORDER BY created_at DESC LIMIT 1").get(id);
  if (alreadyRestored) throw Object.assign(new Error('این ثبت قبلاً بازیابی شده است.'), { code: 'TRANSACTION_ALREADY_RESTORED', status: 409, details: { id: alreadyRestored.id } });
  // دورهٔ پوششی که کاربر پیش‌تر گفته بود با ثبت برمی‌گردد. ردیف تراکنش دوره را
  // نگه نمی‌دارد و بدون این، پیش‌پرداختِ بازگردانده دوباره همان سؤال را می‌پرسید
  // — جوابی که کاربر یک بار داده و چیزی در آن عوض نشده.
  const previous = hasEventTable()
    ? parseStoredJson(db.prepare('SELECT payload FROM financial_events WHERE source_event_id=?').get(`transaction:${id}`)?.payload, {}) : {};
  const period = previous.servicePeriodStart && previous.servicePeriodEnd
    ? { servicePeriodStart: previous.servicePeriodStart, servicePeriodEnd: previous.servicePeriodEnd } : {};
  db.exec('BEGIN IMMEDIATE');
  try {
    const [restoredId] = insertTransactionRows({ transcript: current.rawText, transactions: [{
      ...period,
      amount: current.amount, type: current.type, category: current.category, rawText: current.rawText,
      source: current.source, confidence: current.confidence, confidenceDetails: current.confidenceDetails,
      reviewReasons: [...(current.reviewReasons || []), 'ثبت حذف‌شده با درخواست کاربر دوباره ایجاد شد.'],
      reviewState: 'reviewed', needsReview: false, accountId: current.accountId, contactId: current.contactId,
      note: current.note, dueAt: current.dueAt, occurredAt: current.occurredAt, restoredFrom: id, topicLabel: current.topicLabel,
    }] });
    audit('redo', 'transaction', restoredId, { restoredFrom: id });
    db.exec('COMMIT');
    return transactionRow(restoredId);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
