// دفتر چک — از ثبت تا وصول یا برگشت.
//
// چک در ایران ابزار اصلی پرداخت است و از مطالبات عادی جداست: سررسید دارد،
// ممکن است برگشت بخورد، و تا وصول نشود پول نیست. تا امروز حساب‌یار چک را ثبت
// می‌کرد ولی هیچ راهی برای بستنش نداشت — «اسناد دریافتنی» تا ابد بدهکار
// می‌ماند و مانده‌اش با واقعیت هیچ نسبتی نداشت.
//
// و یک اشتباه بدتر: چکی که بابت طلب قبلی گرفته می‌شد، دوباره درآمد شناسایی
// می‌کرد. همان فروش دو بار در سود دوره می‌آمد و مالیاتش هم دو بار.

import { randomUUID } from 'node:crypto';
import { analyticForContact, counterpartyAnalyticForKey } from '../chartOfAccounts.js';
import { chequeLedgerAccounts, postChequeJournal, reverseJournalEntry } from '../accounting.js';
import { activeWorkspaceDatabase, audit, cleanAmount, currentTimeZone, currentWorkspace, db, invalidInput } from './core.js';
import { contactIdForName } from './contacts.js';
import { resolveAccountId } from './accounts.js';
import { findEventBySource, recordFinancialEvent, rejectFinancialEvent, reverseFinancialEvent } from '../financialEventStore.js';
import { EVENT_KINDS, normalizeFinancialEvent } from '../../shared/financialEvent.js';
import { purchasePurposeFromSpeech } from '../../shared/purchasePurpose.js';
import { DECISION_STATUS } from '../../shared/accountingDecision.js';
import { ROUTES } from '../../shared/confidenceEngine.js';
import { ENGINE_POSTED_TREATMENTS, documentRouting, documentServiceDecision, readDocumentService } from '../../shared/documentService.js';

export const CHEQUE_STATUSES = Object.freeze({
  open: 'در جریان', cleared: 'وصول‌شده', bounced: 'برگشتی', cancelled: 'ابطال‌شده',
});

export function ensureChequeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cheques (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL CHECK(direction IN ('receivable','payable')),
      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      counterparty_name TEXT NOT NULL DEFAULT '',
      amount INTEGER NOT NULL CHECK(amount > 0),
      due_at TEXT,
      occurred_at TEXT NOT NULL,
      serial TEXT NOT NULL DEFAULT '',
      bank_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','cleared','bounced','cancelled')),
      against TEXT NOT NULL DEFAULT 'income' CHECK(against IN ('income','receivable')),
      obligation_id TEXT,
      analytic_id TEXT,
      note TEXT NOT NULL DEFAULT '',
      journal_entry_id TEXT,
      settled_entry_id TEXT,
      settled_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cheques_status ON cheques(status,due_at);
  `);
  return database;
}

const database = () => ensureChequeSchema(activeWorkspaceDatabase());

const COLUMNS = `id,direction,contact_id AS contactId,counterparty_name AS counterpartyName,amount,
  due_at AS dueAt,occurred_at AS occurredAt,serial,bank_name AS bankName,status,against,
  obligation_id AS obligationId,analytic_id AS analyticId,note,journal_entry_id AS journalEntryId,
  settled_entry_id AS settledEntryId,settled_at AS settledAt,created_at AS createdAt`;

const hydrate = (row) => (row ? { ...row, statusLabel: CHEQUE_STATUSES[row.status] || row.status } : null);

export function listCheques({ status = 'open', direction = '' } = {}) {
  const db_ = database();
  const where = [];
  const args = [];
  if (Object.hasOwn(CHEQUE_STATUSES, status)) { where.push('status=?'); args.push(status); }
  if (['receivable', 'payable'].includes(direction)) { where.push('direction=?'); args.push(direction); }
  return db_.prepare(`SELECT ${COLUMNS} FROM cheques ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at,created_at DESC`).all(...args).map(hydrate);
}

/**
 * ثبت یک چک.
 *
 * `against` تعیین می‌کند طرف دیگرِ سند چیست و مهم‌ترین انتخاب همین‌جاست:
 *
 * - `income` یعنی چک بابت یک فروش تازه است که هنوز جایی ثبت نشده — پس درآمد
 *   همین حالا شناسایی می‌شود.
 * - `receivable` یعنی چک بابت طلبی است که از قبل در دفتر هست. آن فروش قبلاً
 *   درآمد شده؛ شناسایی دوباره‌اش یعنی همان مبلغ دو بار در سود دوره و دو بار
 *   در مالیات. اینجا فقط شکل طلب عوض می‌شود: از حساب دریافتنی به اسناد
 *   دریافتنی.
 */
export function recordCheque(values = {}) {
  const db_ = database();
  const direction = ['receivable', 'payable'].includes(values.direction) ? values.direction : null;
  if (!direction) throw invalidInput('نوع چک (دریافتی یا پرداختی) مشخص نیست.');
  const amount = cleanAmount(values.amount);
  if (amount <= 0) throw invalidInput('مبلغ چک باید بیشتر از صفر باشد.');
  const evidence=String(values.note || '').trim();
  if(direction==='payable' && values.against==='income'
    && /خرید|خریدم|خریدیم/.test(evidence) && /انبار|برای\s*فروش|موجودی\s*کالا/.test(evidence)) {
    const reason='خرید کالای انباری با چک نیازمند ثبت موجودی و ورود انبار است؛ هزینه ساخته نشد و به صف حسابدار رفت.';
    const item=recordFinancialEvent(db_,normalizeFinancialEvent({kind:'cash-expense',amount,
      occurredAt:values.occurredAt || new Date().toISOString(),dueAt:values.dueAt,
      evidence,utterance:evidence,counterparty:values.counterpartyName,counterpartyId:values.contactId,
      category:values.category || 'مواد و کالا',source:'text'}),{
      sourceEventId:`inventory-cheque:${randomUUID()}`,decision:{route:'accountant-review',guardBlocked:true,reasons:[reason]},
      actor:currentWorkspace()?.userId || null,transcript:evidence,rawInput:evidence,timeZone:currentTimeZone(),
    });
    return {...item,queuedForAccountant:true,queuedReason:reason};
  }
  // چک بابت خرید یا فروش تازه که ارزش افزوده دارد: کل مبلغ چک بهای کالا یا
  // درآمد نیست. «۵۰ میلیون به‌علاوه ۱۰ درصد… چک ۵۵ میلیونی دادیم» کل ۵۵ را
  // «مواد و کالا» می‌کرد و اعتبار مالیاتی خرید گم می‌شد.
  if (values.against === 'income' && /ارزش\s*افزوده|مالیات\s*بر\s*ارزش/.test(evidence)) {
    const reason = direction === 'payable'
      ? 'خرید با ارزش افزوده و چک: بهای کالا و اعتبار مالیات خرید باید جدا ثبت شوند؛ سند ساخته نشد و به صف حسابدار رفت.'
      : 'فروش با ارزش افزوده و چک: درآمد و مالیات فروش باید جدا ثبت شوند؛ سند ساخته نشد و به صف حسابدار رفت.';
    const item = recordFinancialEvent(db_, normalizeFinancialEvent({ kind: direction === 'payable' ? 'cash-expense' : 'cash-income', amount,
      occurredAt: values.occurredAt || new Date().toISOString(), dueAt: values.dueAt,
      evidence, utterance: evidence, counterparty: values.counterpartyName, counterpartyId: values.contactId,
      category: values.category || (direction === 'payable' ? 'مواد و کالا' : 'فروش'), source: 'text' }), {
      sourceEventId: `vat-cheque:${randomUUID()}`, decision: { route: 'accountant-review', guardBlocked: true, reasons: [reason] },
      actor: currentWorkspace()?.userId || null, transcript: evidence, rawInput: evidence, timeZone: currentTimeZone(),
    });
    return { ...item, queuedForAccountant: true, queuedReason: reason };
  }
  const contactId = values.contactId || (values.counterpartyName ? contactIdForName(values.counterpartyName, values.counterpartyResolution) : null);
  const counterpartyName = String(values.counterpartyName || '').trim().slice(0, 120)
    || (contactId ? db_.prepare('SELECT name FROM contacts WHERE id=?').get(contactId)?.name || '' : '');
  if (!counterpartyName) throw invalidInput('نام صاحب چک یا گیرندهٔ آن لازم است.');
  // «بابت چه؟» پیش‌فرض ندارد. پیش‌فرض «معاملهٔ تازه» یعنی چکی که بابت طلب
  // قبلی آمده، همان فروش را دو بار در درآمد می‌آورد — بی‌آنکه کسی پرسیده باشد.
  if (!['income', 'receivable'].includes(values.against)) {
    throw invalidInput('مشخص کن این چک بابت معاملهٔ تازه است یا حساب قبلی.');
  }
  const against = values.against;
  const occurredAt = values.occurredAt || new Date().toISOString();
  const party = { values, direction, amount, occurredAt, evidence, contactId, counterpartyName, against };
  // «۱۲ تا چک ۱۰ میلیونی»: یک سری، نه یک چک. هر برگ سررسید خودش را دارد و
  // جمله آن‌ها را نگفته؛ ثبت تک‌چکی یا ساختن سررسیدِ حدسی هر دو غلط است. کل سری
  // با جمع کاملش به حسابدار می‌رود.
  const chequeCount = Math.round(Number(values.chequeCount) || 1);
  if (chequeCount > 1) {
    const each = Number(values.perChequeAmount) > 0 ? ` (هر برگ ${Number(values.perChequeAmount).toLocaleString('fa-IR')} تومان)` : '';
    return queueChequeForAccountant(db_, party, {
      prefix: 'cheque-series', category: values.category || null,
      reason: `سری ${chequeCount.toLocaleString('fa-IR')} چک${each} به جمع ${amount.toLocaleString('fa-IR')} تومان؛ سررسید هر برگ گفته نشده و یک چک تک ثبت نشد. برگ‌ها با سررسیدشان در صف حسابدار ثبت می‌شوند.`,
    });
  }
  // «چک دادیم برای خرید مواد اولیه» موجودی می‌خرد، نه هزینهٔ این ماه. همان
  // خواندن هدف خرید که خرید نقدی دارد؛ بی‌نشانه، رفتار قبلی می‌ماند.
  const intendedUse = values.intendedUse || (direction === 'payable' && against === 'income' ? purchasePurposeFromSpeech(values.note) : null);
  const inventory = direction === 'payable' && against === 'income' && ['resale', 'production'].includes(intendedUse);
  let category = String(values.category || '').trim().slice(0, 80);
  if (against === 'income' && !inventory) {
    // «بابت چه؟» از خودِ سند خوانده می‌شود، با همان خواننده‌ای که پرداخت نقدی
    // دارد — دسته، دورهٔ پوشش و استرداد. چک اجارهٔ یک‌ساله پیش‌پرداخت است، چک
    // اجارهٔ شش ماه آیندهٔ مستاجر پیش‌دریافت، و ودیعه هیچ‌وقت هزینه یا درآمد نیست.
    const service = readDocumentService(evidence, {
      direction, occurredAt, category: values.category,
      servicePeriodStart: values.servicePeriodStart, servicePeriodEnd: values.servicePeriodEnd, refundable: values.refundable,
    });
    const event = chequeEvent(party, service);
    const decision = documentServiceDecision(event);
    if (decision) {
      const routing = documentRouting(decision);
      if (routing.route === ROUTES.ACCOUNTANT_REVIEW) {
        return queueChequeForAccountant(db_, party, { prefix: 'service-cheque', category: service.category, reason: routing.reasons[0], event, accountingDecision: decision });
      }
      if (decision.decisionStatus !== DECISION_STATUS.DECIDED || ENGINE_POSTED_TREATMENTS.includes(decision.treatment)) {
        return recordEngineCheque(db_, party, { event, decision, routing });
      }
    }
    // پیش‌فرض «مواد و کالا» یا «فروش» حدسی بود: چک اجاره یک‌جا «مواد و کالا» و
    // چک ودیعهٔ مستاجر «فروش» می‌شد. وقتی نه دسته‌ای آمده و نه از یادداشت
    // درمی‌آید، هزینه یا درآمدی ساخته نمی‌شود.
    if (!service.category) {
      return queueChequeForAccountant(db_, party, {
        prefix: 'uncategorised-cheque', category: null,
        reason: direction === 'payable'
          ? 'معلوم نیست این چک بابت چه خرید یا هزینه‌ای است؛ دسته یا شرح لازم است. هزینهٔ حدسی ساخته نشد و به صف حسابدار رفت.'
          : 'معلوم نیست این چک بابت چه فروش یا درآمدی است؛ دسته یا شرح لازم است. درآمد حدسی ساخته نشد و به صف حسابدار رفت.',
      });
    }
    category = service.category;
  }
  const id = randomUUID();

  db_.exec('BEGIN IMMEDIATE');
  try {
    const analyticId = chequeAnalytic(db_, contactId, counterpartyName);
    const posted = postChequeJournal(db_, {
      chequeId: id, direction, against, amount, occurredAt, category, inventory,
      counterparty: { contactId, name: counterpartyName, analyticId },
      memo: `چک ${direction === 'receivable' ? 'دریافتی از' : 'پرداختی به'} ${counterpartyName}`,
    }, { createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone() });
    insertChequeRow(db_, id, party, analyticId, posted.id);
    db_.exec('COMMIT');
  } catch (error) { db_.exec('ROLLBACK'); throw error; }

  audit('create', 'cheque', id, { direction, amount, against, counterpartyName });
  return hydrate(db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(id));
}

const chequeAnalytic = (db_, contactId, name) => (contactId
  ? analyticForContact(db_, contactId, name)?.id || null
  : counterpartyAnalyticForKey(db_, name));

function insertChequeRow(db_, id, { values, direction, amount, occurredAt, contactId, counterpartyName, against }, analyticId, journalEntryId) {
  db_.prepare(`INSERT INTO cheques (id,direction,contact_id,counterparty_name,amount,due_at,occurred_at,serial,
    bank_name,against,obligation_id,analytic_id,note,journal_entry_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, direction, contactId, counterpartyName, amount, values.dueAt || null, occurredAt,
      String(values.serial || '').trim().slice(0, 40), String(values.bankName || '').trim().slice(0, 60),
      against, values.obligationId || null, analyticId, String(values.note || '').slice(0, 300), journalEntryId);
}

/** رویداد مالیِ خودِ چک، با واقعیت‌هایی که از یادداشتش خوانده شد. */
function chequeEvent({ values, direction, amount, occurredAt, evidence, contactId, counterpartyName, against }, service = {}) {
  return normalizeFinancialEvent({
    kind: direction === 'payable' ? EVENT_KINDS.CHEQUE_ISSUED : EVENT_KINDS.CHEQUE_RECEIVED,
    amount, occurredAt, dueAt: values.dueAt || null,
    counterparty: counterpartyName || values.counterpartyName || null, counterpartyId: contactId || values.contactId || null,
    category: service.category || null, description: service.category || null,
    servicePeriodStart: service.servicePeriodStart || null, servicePeriodEnd: service.servicePeriodEnd || null,
    refundable: typeof service.refundable === 'boolean' ? service.refundable : null,
    chequeAgainst: against || null,
    source: values.source === 'voice' ? 'voice' : 'text',
    evidence: evidence || null, utterance: evidence || null,
  });
}

/**
 * چک به صف حسابدار — بی‌آنکه سندی یا ردیف دفتر چکی ساخته شود.
 *
 * رویداد، خودِ چک است (چک دریافتی یا پرداختی) با جمع کامل، نه «هزینهٔ نقدی»:
 * حسابدار باید ببیند پولی جابه‌جا نشده و جهت چک چیست. وقتی سند را ثبت کند،
 * دفتر چک به همان سند وصل می‌شود.
 */
function queueChequeForAccountant(db_, party, { prefix, category, reason, event = null, accountingDecision = null }) {
  const queued = event || chequeEvent(party, { category });
  const item = recordFinancialEvent(db_, queued, {
    sourceEventId: `${prefix}:${randomUUID()}`,
    decision: { route: ROUTES.ACCOUNTANT_REVIEW, guardBlocked: true, reasons: [reason] },
    accountingDecision,
    actor: currentWorkspace()?.userId || null, transcript: party.evidence, rawInput: party.evidence, timeZone: currentTimeZone(),
  });
  return { ...item, queuedForAccountant: true, queuedReason: reason };
}

/**
 * چکِ خدمت دوره‌دار: سند را نقشهٔ موتور می‌زند — پیش‌پرداخت در برابر اسناد
 * پرداختنی، اسناد دریافتنی در برابر درآمد انتقالی، ودیعه — و برنامهٔ شناسایی
 * ماهانه همان‌جا ذخیره می‌شود. لنگر سند، خودِ چک است تا وصول و برگشت همان
 * حساب اسناد را ببندند.
 *
 * واقعیتِ کم (دورهٔ پوشش، استرداد) سؤال است: چک در دفتر چک‌ها ثبت می‌شود ولی
 * سندش تا جواب منتظر می‌ماند و وصول یا برگشتش هم.
 */
function recordEngineCheque(db_, party, { event, decision, routing }) {
  const { direction, amount, contactId, counterpartyName, against } = party;
  const id = randomUUID();
  let result;
  db_.exec('BEGIN IMMEDIATE');
  try {
    const analyticId = chequeAnalytic(db_, contactId, counterpartyName);
    // حساب اسناد با همان نام و کلیدی ساخته می‌شود که وصول و برگشت می‌خوانند.
    chequeLedgerAccounts(db_, { contactId, name: counterpartyName });
    insertChequeRow(db_, id, party, analyticId, null);
    result = recordFinancialEvent(db_, event, {
      sourceEventId: `cheque:${id}`, decision: routing, accountingDecision: decision,
      actor: currentWorkspace()?.userId || null, transcript: party.evidence, rawInput: party.evidence,
      timeZone: currentTimeZone(), withinTransaction: true,
      journalSource: { type: 'cheque_record', id },
    });
    // نگهبانی که سند را نگه داشت، کار را به حسابدار داده؛ ردیف دفتر چک را
    // ثبتِ حسابدار می‌سازد، نه این‌جا — وگرنه یک چک دو ردیف می‌گرفت.
    if (result.route === ROUTES.ACCOUNTANT_REVIEW && result.status !== 'posted') {
      db_.prepare('DELETE FROM cheques WHERE id=?').run(id);
      db_.prepare('UPDATE financial_events SET journal_source=NULL WHERE id=?').run(result.id);
      db_.exec('COMMIT');
      const reason = result.guards?.find?.((check) => check.verdict === 'block')?.reason || routing.reasons[0] || 'این چک قضاوت حسابدار لازم دارد.';
      return { ...result, queuedForAccountant: true, queuedReason: reason };
    }
    if (result.journalEntryId) db_.prepare('UPDATE cheques SET journal_entry_id=? WHERE id=?').run(result.journalEntryId, id);
    db_.exec('COMMIT');
  } catch (error) { db_.exec('ROLLBACK'); throw error; }
  audit('create', 'cheque', id, { direction, amount, against, counterpartyName, eventId: result.id, treatment: decision.treatment });
  const row = hydrate(db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(id));
  return {
    ...row, eventId: result.id, treatment: decision.treatment,
    ...(result.status === 'posted' ? {} : { pendingQuestion: decision.question?.text || routing.reasons[0] || null }),
  };
}

function openCheque(db_, id) {
  const row = db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(String(id || ''));
  if (!row) throw invalidInput('چک پیدا نشد.');
  if (row.status !== 'open') throw Object.assign(new Error(`این چک از قبل «${CHEQUE_STATUSES[row.status]}» است.`), { code: 'CHEQUE_NOT_OPEN', status: 409 });
  const recorded = findEventBySource(db_, `cheque:${row.id}`);
  // سند ثبتِ چک برگشته یا رد شده: اسناد پرداختنی/دریافتنی‌ای نمانده که وصول یا
  // برگشت ببندد. چک ابطال می‌شود، نه وصول (که بانک را بی‌پشتوانه کم می‌کرد).
  if (['reversed', 'rejected'].includes(recorded?.status)) {
    db_.prepare("UPDATE cheques SET status='cancelled' WHERE id=? AND status='open'").run(row.id);
    throw Object.assign(new Error('سند ثبت این چک برگشته یا رد شده؛ چک ابطال شد و وصول یا برگشت ندارد.'), { code: 'CHEQUE_CANCELLED', status: 409 });
  }
  // چکی که سند ثبتش منتظر جواب است (دورهٔ پوشش، استرداد) هنوز اسناد
  // پرداختنی یا دریافتنی نساخته؛ وصول یا برگشتش حسابی را می‌بست که باز نشده.
  if (!row.journalEntryId) {
    if (recorded?.status === 'posted' && recorded.journalEntryId) {
      db_.prepare('UPDATE cheques SET journal_entry_id=? WHERE id=?').run(recorded.journalEntryId, row.id);
      return { ...row, journalEntryId: recorded.journalEntryId };
    }
    if (recorded) {
      throw Object.assign(new Error('سند ثبت این چک هنوز منتظر جواب سؤالش (یا بررسی حسابدار) است؛ اول آن را کامل کن.'), { code: 'CHEQUE_RECORD_PENDING', status: 409 });
    }
  }
  return row;
}

/**
 * وصول چک — همان لحظه‌ای که چک تبدیل به پول می‌شود.
 *
 * تا اینجا هیچ پولی جابه‌جا نشده بود؛ فقط یک حق دریافت با سررسید وجود داشت.
 * وصول، آن حق را به موجودی بانک تبدیل می‌کند و نه درآمدی می‌سازد و نه
 * هزینه‌ای — درآمدش موقع ثبت چک شناسایی شده بود.
 */
export function clearCheque(id, { accountId, account = 'cash', occurredAt = '' } = {}) {
  const db_ = database();
  const cheque = openCheque(db_, id);
  const settledAt = occurredAt || new Date().toISOString();
  db_.exec('BEGIN IMMEDIATE');
  try {
    const posted = postChequeJournal(db_, {
      chequeId: cheque.id, stage: 'clear', direction: cheque.direction, amount: cheque.amount,
      occurredAt: settledAt, cashAccountId: resolveAccountId({ account, accountId }),
      counterparty: { contactId: cheque.contactId, name: cheque.counterpartyName, analyticId: cheque.analyticId },
      memo: `وصول چک ${cheque.counterpartyName}`,
    }, { createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone() });
    db_.prepare("UPDATE cheques SET status='cleared',settled_entry_id=?,settled_at=? WHERE id=? AND status='open'")
      .run(posted.id, settledAt, cheque.id);
    db_.exec('COMMIT');
  } catch (error) { db_.exec('ROLLBACK'); throw error; }
  audit('clear', 'cheque', cheque.id, { amount: cheque.amount });
  return hydrate(db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(cheque.id));
}

/**
 * برگشت چک.
 *
 * چک برگشتی یعنی طلب از بین نرفته، فقط ابزارش باطل شده. پس مبلغ از اسناد
 * دریافتنی به حساب دریافتنیِ همان شخص برمی‌گردد و او دوباره بدهکار می‌شود.
 * پاک‌کردن چک به‌جای این کار، طلب را از دفتر حذف می‌کرد.
 */
export function bounceCheque(id, { occurredAt = '' } = {}) {
  const db_ = database();
  const cheque = openCheque(db_, id);
  const bouncedAt = occurredAt || new Date().toISOString();
  db_.exec('BEGIN IMMEDIATE');
  try {
    const posted = postChequeJournal(db_, {
      chequeId: cheque.id, stage: 'bounce', direction: cheque.direction, amount: cheque.amount,
      occurredAt: bouncedAt,
      counterparty: { contactId: cheque.contactId, name: cheque.counterpartyName, analyticId: cheque.analyticId },
      memo: `برگشت چک ${cheque.counterpartyName}`,
    }, { createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone() });
    db_.prepare("UPDATE cheques SET status='bounced',settled_entry_id=?,settled_at=? WHERE id=? AND status='open'")
      .run(posted.id, bouncedAt, cheque.id);
    db_.exec('COMMIT');
  } catch (error) { db_.exec('ROLLBACK'); throw error; }
  audit('bounce', 'cheque', cheque.id, { amount: cheque.amount });
  return hydrate(db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(cheque.id));
}

/**
 * ابطال چکِ باز: سند ثبتش برمی‌گردد (یا رویدادِ منتظرش رد می‌شود) و چک
 * «ابطال‌شده» می‌شود. چکی که اشتباه ثبت شده یا هنوز سؤالش بی‌جواب است، راهی جز
 * وصول و برگشت داشت — هر دو دفتر را غلط می‌کردند.
 */
export function cancelCheque(id, { reason = '' } = {}) {
  const db_ = database();
  const row = db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(String(id || ''));
  if (!row) throw invalidInput('چک پیدا نشد.');
  if (row.status !== 'open') throw Object.assign(new Error(`این چک از قبل «${CHEQUE_STATUSES[row.status]}» است.`), { code: 'CHEQUE_NOT_OPEN', status: 409 });
  if (String(row.id).startsWith('review:')) {
    throw Object.assign(new Error('این چک را حسابدار از صف بررسی ثبت کرده؛ همان ثبت را از صف بررسی برگردان تا چک هم ابطال شود.'), { code: 'CHEQUE_FROM_REVIEW', status: 409 });
  }
  const actor = currentWorkspace()?.userId || null;
  const memo = reason ? `ابطال چک: ${String(reason).slice(0, 150)}` : `ابطال چک ${row.counterpartyName}`;
  db_.exec('BEGIN IMMEDIATE');
  try {
    const recorded = findEventBySource(db_, `cheque:${row.id}`);
    if (recorded?.status === 'posted') {
      reverseFinancialEvent(db_, recorded.id, { actor, reason: memo, timeZone: currentTimeZone(), withinTransaction: true });
    } else if (recorded?.status === 'pending') {
      rejectFinancialEvent(db_, recorded.id, { actor, reason: memo });
    } else if (!recorded) {
      reverseJournalEntry(db_, { sourceType: 'cheque_record', sourceId: row.id, memo, createdBy: actor, timeZone: currentTimeZone() });
    }
    db_.prepare("UPDATE cheques SET status='cancelled' WHERE id=? AND status='open'").run(row.id);
    db_.exec('COMMIT');
  } catch (error) { db_.exec('ROLLBACK'); throw error; }
  audit('cancel', 'cheque', row.id, { amount: row.amount, reason: String(reason).slice(0, 200) });
  return hydrate(db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(row.id));
}

export function chequeSummary() {
  const db_ = database();
  const rows = db_.prepare(`SELECT direction,status,COUNT(*) AS count,COALESCE(SUM(amount),0) AS total
    FROM cheques GROUP BY direction,status`).all();
  const pick = (direction, status) => rows.find((row) => row.direction === direction && row.status === status) || { count: 0, total: 0 };
  return {
    openReceivable: pick('receivable', 'open'),
    openPayable: pick('payable', 'open'),
    bounced: rows.filter((row) => row.status === 'bounced').reduce((sum, row) => sum + row.total, 0),
  };
}

void db;

/** سندِ بررسی‌شده از قبل ثبت شده؛ فقط دفتر چک به همان سند متصل می‌شود. */
export function attachReviewedCheque({ eventId, event, line, journalEntryId, against = 'income' }) {
  const database = ensureChequeSchema(activeWorkspaceDatabase());
  const direction = line.role === 'cheque-payable' ? 'payable' : 'receivable';
  // چکی که پیش‌تر در دفتر چک ثبت شده و سندش منتظر مانده بود، ردیف دوم نمی‌گیرد.
  const source = database.prepare('SELECT journal_source FROM financial_events WHERE id=?').get(eventId)?.journal_source;
  const anchored = source ? JSON.parse(source) : null;
  if (anchored?.type === 'cheque_record' && database.prepare('SELECT 1 FROM cheques WHERE id=?').get(anchored.id)) {
    database.prepare('UPDATE cheques SET journal_entry_id=? WHERE id=?').run(journalEntryId, anchored.id);
    return anchored.id;
  }
  const id = `review:${eventId}`;
  database.prepare(`INSERT INTO cheques(id,direction,contact_id,counterparty_name,amount,due_at,occurred_at,against,analytic_id,note,journal_entry_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,direction,event.counterpartyId,event.counterparty,line.debit || line.credit,event.dueAt,event.occurredAt,against,line.analyticId,`بررسی حسابدار: ${eventId}`,journalEntryId);
  return id;
}
