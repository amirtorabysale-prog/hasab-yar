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
import { chequeLedgerAccounts, counterpartyLedgerAccount, postChequeJournal, reverseJournalEntry } from '../accounting.js';
import { activeWorkspaceDatabase, audit, cleanAmount, currentTimeZone, currentWorkspace, db, invalidInput } from './core.js';
import { contactIdForName } from './contacts.js';
import { resolveAccountId } from './accounts.js';
import { findEventBySource, recordFinancialEvent, rejectFinancialEvent, reverseFinancialEvent } from '../financialEventStore.js';
import { EVENT_KINDS, normalizeFinancialEvent } from '../../shared/financialEvent.js';
import { purchasePurposeFromSpeech } from '../../shared/purchasePurpose.js';
import { DECISION_STATUS } from '../../shared/accountingDecision.js';
import { ROUTES } from '../../shared/confidenceEngine.js';
import { ADVANCE_TREATMENTS, ENGINE_POSTED_TREATMENTS, documentAdvanceDecision, documentRouting, documentServiceDecision, readDocumentService } from '../../shared/documentService.js';
import { readPrepaymentMention } from '../../shared/prepaymentSpeech.js';
import { unitLabel } from '../../shared/amountUnit.js';

export const CHEQUE_STATUSES = Object.freeze({
  open: 'در جریان', cleared: 'وصول‌شده', bounced: 'برگشتی', cancelled: 'ابطال‌شده',
  // چک دریافتی که به تأمین‌کننده داده شد (پشت‌نویسی)؛ و چک واردشده‌ای که وضعیتش معلوم نیست.
  transferred: 'واگذارشده', review: 'نیازمند بررسی',
  // چک دریافتی که برای وصول به بانک سپرده شد: هنوز پول نیست و سندی هم نمی‌خورد؛ فقط
  // جای چک عوض شده و وصولش به همان بانک می‌نشیند.
  deposited: 'نزد بانک',
});

/** وضعیت‌هایی که چک هنوز باز است: سررسید دارد و وصول یا برگشتش در پیش است. */
const LIVE_STATUSES = Object.freeze(['open', 'deposited']);

const STATUS_CHECK = `CHECK(status IN (${Object.keys(CHEQUE_STATUSES).map((status) => `'${status}'`).join(',')}))`;

// ستون‌های بعدی. منبع («parsian») و کلیدش ورود را تکرارناپذیر می‌کنند؛ حساب اسناد و
// معین صاحب چک برای چکِ واردشده‌ای است که حساب‌های خودِ پارسیان رویشان نشسته.
const LATER_COLUMNS = [
  ['source', "TEXT NOT NULL DEFAULT ''"], ['source_key', "TEXT NOT NULL DEFAULT ''"], ['sayad', "TEXT NOT NULL DEFAULT ''"],
  ['note_account_id', 'TEXT'], ['party_chart_id', 'TEXT'], ['transferred_to', "TEXT NOT NULL DEFAULT ''"], ['review_reason', "TEXT NOT NULL DEFAULT ''"],
  // بانکِ چک: حساب پولی که چک دریافتی به آن سپرده شد، یا معین و تفصیلی بانکی که چک
  // پرداختیِ پارسیان از آن کشیده شده (حساب پولی‌اش را فاز ب بعداً می‌سازد).
  ['bank_account_id', 'TEXT'], ['bank_chart_id', 'TEXT'], ['bank_analytic_id', 'TEXT'],
];

/**
 * جدول قدیمی وضعیت «واگذارشده» و «نیازمند بررسی» را در CHECK ندارد و SQLite آن را عوض
 * نمی‌کند؛ جدول با همان ردیف‌ها بازسازی می‌شود.
 */
function widenChequeStatuses(database) {
  const sql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cheques'").get()?.sql || '';
  if (!sql || sql.includes("'deposited'")) return;
  const columns = database.prepare('PRAGMA table_info(cheques)').all().map((column) => column.name).join(',');
  // SAVEPOINT، نه BEGIN: این تابع گاهی درون تراکنش فراخواننده صدا زده می‌شود.
  database.exec('SAVEPOINT widen_cheque_statuses');
  try {
    database.exec(`ALTER TABLE cheques RENAME TO cheques_before_statuses;
      ${sql.replace(/CREATE TABLE\s+"?cheques"?/i, 'CREATE TABLE cheques').replace(/CHECK\s*\(\s*status IN \([^)]*\)\s*\)/i, STATUS_CHECK)};
      INSERT INTO cheques (${columns}) SELECT ${columns} FROM cheques_before_statuses;
      DROP TABLE cheques_before_statuses;
      CREATE INDEX IF NOT EXISTS idx_cheques_status ON cheques(status,due_at);`);
    database.exec('RELEASE widen_cheque_statuses');
  } catch (error) {
    database.exec('ROLLBACK TO widen_cheque_statuses');
    database.exec('RELEASE widen_cheque_statuses');
    throw error;
  }
}

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
      status TEXT NOT NULL DEFAULT 'open' ${STATUS_CHECK},
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
  const present = new Set(database.prepare('PRAGMA table_info(cheques)').all().map((column) => column.name));
  for (const [name, type] of LATER_COLUMNS) if (!present.has(name)) database.exec(`ALTER TABLE cheques ADD COLUMN ${name} ${type}`);
  widenChequeStatuses(database);
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_cheques_source ON cheques(source,source_key) WHERE source<>''");
  // تاریخچهٔ هر چک: هر تغییر وضعیت یک ردیف، با سندش اگر سندی خورده.
  database.exec(`CREATE TABLE IF NOT EXISTS cheque_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cheque_id TEXT NOT NULL,
      at TEXT NOT NULL,
      status TEXT NOT NULL,
      entry_id TEXT,
      note TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cheque_events_cheque ON cheque_events(cheque_id,at,id);`);
  return database;
}

export function logChequeEvent(database, chequeId, { at, status, entryId = null, note = '', source = '' }) {
  database.prepare('INSERT INTO cheque_events (cheque_id,at,status,entry_id,note,source) VALUES (?,?,?,?,?,?)')
    .run(chequeId, at || new Date().toISOString(), status, entryId || null, String(note || '').slice(0, 300), source);
}

const database = () => ensureChequeSchema(activeWorkspaceDatabase());

const COLUMNS = `id,direction,contact_id AS contactId,counterparty_name AS counterpartyName,amount,
  due_at AS dueAt,occurred_at AS occurredAt,serial,bank_name AS bankName,status,against,
  obligation_id AS obligationId,analytic_id AS analyticId,note,journal_entry_id AS journalEntryId,
  settled_entry_id AS settledEntryId,settled_at AS settledAt,created_at AS createdAt,
  source,sayad,note_account_id AS noteAccountId,party_chart_id AS partyChartId,transferred_to AS transferredTo,review_reason AS reviewReason,
  bank_account_id AS bankAccountId,bank_chart_id AS bankChartId,bank_analytic_id AS bankAnalyticId`;

const hydrate = (row) => (row ? { ...row, statusLabel: CHEQUE_STATUSES[row.status] || row.status } : null);

export function listCheques({ status = 'open', direction = '' } = {}) {
  const db_ = database();
  const where = [];
  const args = [];
  if (Object.hasOwn(CHEQUE_STATUSES, status)) { where.push('status=?'); args.push(status); }
  if (['receivable', 'payable'].includes(direction)) { where.push('direction=?'); args.push(direction); }
  return db_.prepare(`SELECT ${COLUMNS} FROM cheques ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at,created_at DESC`).all(...args).map(hydrate)
    // بانکی که وصول یا پاس بی‌انتخاب به آن می‌نشیند؛ فرم وصول همان را پیش‌فرض می‌گیرد.
    .map((row) => (LIVE_STATUSES.includes(row.status) ? { ...row, defaultAccountId: chequeBankAccount(db_, row) } : row));
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
    const each = Number(values.perChequeAmount) > 0 ? ` (هر برگ ${Number(values.perChequeAmount).toLocaleString('fa-IR')} ${unitLabel()})` : '';
    return queueChequeForAccountant(db_, party, {
      prefix: 'cheque-series', category: values.category || null,
      reason: `سری ${chequeCount.toLocaleString('fa-IR')} چک${each} به جمع ${amount.toLocaleString('fa-IR')} ${unitLabel()}؛ سررسید هر برگ گفته نشده و یک چک تک ثبت نشد. برگ‌ها با سررسیدشان در صف حسابدار ثبت می‌شوند.`,
    });
  }
  // «چک دادیم برای خرید مواد اولیه» موجودی می‌خرد، نه هزینهٔ این ماه. همان
  // خواندن هدف خرید که خرید نقدی دارد؛ بی‌نشانه، رفتار قبلی می‌ماند.
  const intendedUse = values.intendedUse || (direction === 'payable' && against === 'income' ? purchasePurposeFromSpeech(values.note) : null);
  // «پیش پرداخت خرید مواد اولیه با چک»: کالا هنوز نرسیده؛ پیش‌پرداخت است، نه موجودی.
  const inventory = direction === 'payable' && against === 'income' && ['resale', 'production'].includes(intendedUse) && !readPrepaymentMention(evidence);
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
    // پیش‌پرداخت خرید یا بیعانه با چک: پیش‌پرداخت به تأمین‌کننده یا پیش‌دریافت،
    // نه هزینه یا فروشِ امروز — همان که مسیر نقدی می‌سازد.
    const decision = documentServiceDecision(event) || documentAdvanceDecision(event);
    if (decision) {
      const routing = documentRouting(decision);
      if (routing.route === ROUTES.ACCOUNTANT_REVIEW) {
        return queueChequeForAccountant(db_, party, { prefix: 'service-cheque', category: service.category, reason: routing.reasons[0], event, accountingDecision: decision });
      }
      if (decision.decisionStatus !== DECISION_STATUS.DECIDED || ENGINE_POSTED_TREATMENTS.includes(decision.treatment) || ADVANCE_TREATMENTS.includes(decision.treatment)) {
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
  logChequeEvent(db_, id, { at: occurredAt, status: 'open', entryId: journalEntryId, note: direction === 'receivable' ? 'دریافت چک' : 'صدور چک' });
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
    // «پیش پرداخت»، «بیعانه»، «علی‌الحساب» در شرح چک: ماهیت پیش‌پرداخت است.
    ...(against === 'income' && readPrepaymentMention(evidence) ? { prepaymentSignal: true } : {}),
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
      db_.prepare('DELETE FROM cheque_events WHERE cheque_id=?').run(id);
      db_.prepare('UPDATE financial_events SET journal_source=NULL WHERE id=?').run(result.id);
      db_.exec('COMMIT');
      const reason = result.guards?.find?.((check) => check.verdict === 'block')?.reason || routing.reasons[0] || 'این چک قضاوت حسابدار لازم دارد.';
      return { ...result, queuedForAccountant: true, queuedReason: reason };
    }
    if (result.journalEntryId) {
      db_.prepare('UPDATE cheques SET journal_entry_id=? WHERE id=?').run(result.journalEntryId, id);
      db_.prepare('UPDATE cheque_events SET entry_id=? WHERE cheque_id=? AND entry_id IS NULL').run(result.journalEntryId, id);
    }
    db_.exec('COMMIT');
  } catch (error) { db_.exec('ROLLBACK'); throw error; }
  audit('create', 'cheque', id, { direction, amount, against, counterpartyName, eventId: result.id, treatment: decision.treatment });
  const row = hydrate(db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(id));
  return {
    ...row, eventId: result.id, treatment: decision.treatment,
    ...(result.status === 'posted' ? {} : { pendingQuestion: decision.question?.text || routing.reasons[0] || null }),
  };
}

/**
 * حساب‌های پارسیانی که چک واردشده رویشان نشسته: حساب اسناد (ثبت در ورود) و حساب صاحب چک
 * روی معین خودش — حساب اختصاصی شخص اگر فاز ب ساخته، وگرنه حساب همان معین. چک خودِ
 * حساب‌یار چیزی برنمی‌گرداند و همان قاعدهٔ قبلی را می‌رود.
 */
function importedChequeAccounts(db_, cheque) {
  if (cheque.source !== 'parsian') return {};
  const party = cheque.partyChartId ? (db_.prepare(`SELECT journal_lines.account_id AS id FROM journal_lines
      JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE ledger_accounts.chart_account_id=? AND journal_lines.analytic_id IS ? LIMIT 1`).get(cheque.partyChartId, cheque.analyticId || null)
    || db_.prepare(`SELECT id FROM ledger_accounts WHERE chart_account_id=?
      ORDER BY CASE WHEN source_kind='chart-account' THEN 0 ELSE 1 END,rowid LIMIT 1`).get(cheque.partyChartId))?.id : null;
  return { noteAccountId: cheque.noteAccountId || undefined, partyAccountId: party || undefined };
}

function openCheque(db_, id, allowed = LIVE_STATUSES) {
  const row = db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(String(id || ''));
  if (!row) throw invalidInput('چک پیدا نشد.');
  if (!allowed.includes(row.status)) throw Object.assign(new Error(`این چک از قبل «${CHEQUE_STATUSES[row.status]}» است.`), { code: 'CHEQUE_NOT_OPEN', status: 409 });
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
export function clearCheque(id, { accountId, account = '', occurredAt = '' } = {}) {
  const db_ = database();
  const cheque = openCheque(db_, id);
  const settledAt = occurredAt || new Date().toISOString();
  // بی‌انتخاب صریح، وصول به بانکِ خود چک می‌نشیند (بانکی که چک به آن سپرده شد یا چک
  // پرداختی از آن کشیده شده)، نه صندوق پیش‌فرض.
  const cashAccountId = accountId || account ? resolveAccountId({ account, accountId }) : chequeBankAccount(db_, cheque) || resolveAccountId({});
  db_.exec('BEGIN IMMEDIATE');
  try {
    const posted = postChequeJournal(db_, {
      chequeId: cheque.id, stage: 'clear', direction: cheque.direction, amount: cheque.amount,
      occurredAt: settledAt, cashAccountId,
      counterparty: { contactId: cheque.contactId, name: cheque.counterpartyName, analyticId: cheque.analyticId },
      ...importedChequeAccounts(db_, cheque),
      memo: `${cheque.direction === 'payable' ? 'پاس' : 'وصول'} چک ${cheque.counterpartyName}`,
    }, { createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone() });
    db_.prepare("UPDATE cheques SET status='cleared',settled_entry_id=?,settled_at=?,bank_account_id=? WHERE id=? AND status IN ('open','deposited')")
      .run(posted.id, settledAt, cashAccountId, cheque.id);
    logChequeEvent(db_, cheque.id, { at: settledAt, status: 'cleared', entryId: posted.id, note: `${cheque.direction === 'payable' ? 'پاس' : 'وصول'} به ${accountName(db_, cashAccountId)}` });
    db_.exec('COMMIT');
  } catch (error) { db_.exec('ROLLBACK'); throw error; }
  audit('clear', 'cheque', cheque.id, { amount: cheque.amount, accountId: cashAccountId });
  return hydrate(db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(cheque.id));
}

function assertReceivable(db_, id, message) {
  const direction = db_.prepare('SELECT direction FROM cheques WHERE id=?').get(String(id || ''))?.direction;
  if (direction && direction !== 'receivable') throw invalidInput(message);
}

const accountName = (db_, accountId) => db_.prepare('SELECT name FROM accounts WHERE id=?').get(accountId)?.name || accountId;

/**
 * حساب پولیِ بانکِ خود چک: بانکی که چک به آن سپرده شد، وگرنه حساب پولیِ معین و تفصیلی
 * بانکی که چک پرداختی پارسیان از آن کشیده شده (فاز ب برای هر تفصیلی بانک یک حساب
 * ساخته). نبودنش null است، نه حدس.
 */
export function chequeBankAccount(db_, cheque) {
  const live = (accountId) => (accountId && db_.prepare('SELECT id FROM accounts WHERE id=? AND active=1').get(accountId)?.id) || null;
  if (live(cheque.bankAccountId)) return cheque.bankAccountId;
  if (!cheque.bankChartId) return null;
  const hasUnits = db_.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='parsian_money_units'").get();
  if (!hasUnits) return null;
  const unit = db_.prepare('SELECT account_id AS accountId FROM parsian_money_units WHERE chart_account_id=? AND analytic_id IS ?')
    .get(cheque.bankChartId, cheque.bankAnalyticId || null)
    || db_.prepare('SELECT account_id AS accountId FROM parsian_money_units WHERE chart_account_id=? AND analytic_id=?')
      .get(cheque.bankChartId, cheque.bankAnalyticId || '');
  return live(unit?.accountId);
}

/**
 * سپردن چک دریافتی به بانک برای وصول. پولی هنوز نیامده و چک همچنان «اسناد دریافتنی»
 * است؛ پس سندی نمی‌خورد. فقط بانک به یاد می‌ماند تا وصول بعدی همان‌جا بنشیند.
 */
export function depositCheque(id, { accountId, account = '', occurredAt = '' } = {}) {
  const db_ = database();
  assertReceivable(db_, id, 'فقط چک دریافتی به بانک سپرده می‌شود.');
  const cheque = openCheque(db_, id, ['open']);
  if (!accountId && !account) throw invalidInput('بانکی که چک به آن سپرده شد را انتخاب کن.');
  const bankAccountId = resolveAccountId({ account, accountId });
  const at = occurredAt || new Date().toISOString();
  db_.exec('BEGIN IMMEDIATE');
  try {
    db_.prepare("UPDATE cheques SET status='deposited',bank_account_id=? WHERE id=? AND status='open'").run(bankAccountId, cheque.id);
    logChequeEvent(db_, cheque.id, { at, status: 'deposited', note: `سپرده به ${accountName(db_, bankAccountId)} برای وصول` });
    db_.exec('COMMIT');
  } catch (error) { db_.exec('ROLLBACK'); throw error; }
  audit('deposit', 'cheque', cheque.id, { accountId: bankAccountId });
  return hydrate(db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(cheque.id));
}

/** چک سپرده‌شده از بانک پس گرفته شد (بی‌وصول، بی‌برگشت): دوباره در جریان. */
export function withdrawChequeDeposit(id, { occurredAt = '' } = {}) {
  const db_ = database();
  const cheque = openCheque(db_, id, ['deposited']);
  db_.exec('BEGIN IMMEDIATE');
  try {
    db_.prepare("UPDATE cheques SET status='open',bank_account_id=NULL WHERE id=? AND status='deposited'").run(cheque.id);
    logChequeEvent(db_, cheque.id, { at: occurredAt || new Date().toISOString(), status: 'open', note: 'پس‌گرفتن از بانک' });
    db_.exec('COMMIT');
  } catch (error) { db_.exec('ROLLBACK'); throw error; }
  audit('withdraw-deposit', 'cheque', cheque.id, {});
  return hydrate(db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(cheque.id));
}

/**
 * حساب پرداختنیِ گیرندهٔ چک واگذارشده: حسابی که بدهی به همین شخص (همان تفصیلی) در دفتر
 * رویش نشسته — حساب پرداختنی حساب‌یار یا حساب تأمین‌کنندهٔ پارسیان. شخصی که هیچ
 * بدهی‌ای در دفتر ندارد حساب پرداختنی تازهٔ خودش را می‌گیرد.
 */
function endorseeAccount(db_, contactId, name) {
  const analyticId = chequeAnalytic(db_, contactId, name);
  const used = analyticId ? db_.prepare(`SELECT journal_lines.account_id AS id FROM journal_lines
      JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
      WHERE journal_lines.analytic_id=? AND ledger_accounts.type='liability'
        AND ledger_accounts.source_kind NOT IN ('cheque-payable')
      GROUP BY journal_lines.account_id ORDER BY SUM(journal_lines.credit) DESC LIMIT 1`).get(analyticId)?.id : null;
  return { accountId: used || counterpartyLedgerAccount(db_, contactId, name, 'purchase'), analyticId };
}

/**
 * واگذاری چک دریافتی به تأمین‌کننده (پشت‌نویسی). پولی از حساب شرکت بیرون نمی‌رود؛
 * بدهی ما به گیرنده به اندازهٔ چک کم می‌شود و اسناد دریافتنی بسته می‌شود.
 */
export function transferCheque(id, { contactId = '', counterpartyName = '', occurredAt = '' } = {}) {
  const db_ = database();
  assertReceivable(db_, id, 'فقط چک دریافتی به دیگری واگذار می‌شود؛ چک پرداختی را خودمان کشیده‌ایم.');
  const cheque = openCheque(db_, id, ['open']);
  const name = String(counterpartyName || (contactId ? db_.prepare('SELECT name FROM contacts WHERE id=?').get(contactId)?.name : '') || '').trim().slice(0, 120);
  if (!name) throw invalidInput('چک به چه کسی واگذار شد؟ گیرنده را انتخاب کن.');
  const resolvedContact = contactId || contactIdForName(name);
  const at = occurredAt || new Date().toISOString();
  db_.exec('BEGIN IMMEDIATE');
  try {
    const endorsee = endorseeAccount(db_, resolvedContact, name);
    const posted = postChequeJournal(db_, {
      chequeId: cheque.id, stage: 'transfer', direction: 'receivable', amount: cheque.amount, occurredAt: at,
      counterparty: { contactId: cheque.contactId, name: cheque.counterpartyName, analyticId: cheque.analyticId },
      ...importedChequeAccounts(db_, cheque), endorsee,
      memo: `واگذاری چک ${cheque.counterpartyName} به ${name}`,
    }, { createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone() });
    db_.prepare("UPDATE cheques SET status='transferred',transferred_to=?,settled_entry_id=?,settled_at=? WHERE id=? AND status='open'")
      .run(name, posted.id, at, cheque.id);
    logChequeEvent(db_, cheque.id, { at, status: 'transferred', entryId: posted.id, note: `واگذار به ${name}` });
    db_.exec('COMMIT');
  } catch (error) { db_.exec('ROLLBACK'); throw error; }
  audit('transfer', 'cheque', cheque.id, { amount: cheque.amount, to: name });
  return hydrate(db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(cheque.id));
}

const RESOLVABLE = ['open', 'cleared', 'bounced', 'transferred', 'cancelled'];

/**
 * تعیین تکلیف چک «نیازمند بررسی» (کد ناشناختهٔ پارسیان). حدسی در کار نیست:
 * - «در جریان است» چک را باز می‌کند تا وصول یا برگشتش از همین‌جا سند بخورد؛
 * - هر وضعیت بسته (وصول، برگشت، واگذاری، ابطال) فقط با سندی پذیرفته می‌شود که همان
 *   رویداد را در دفتر دارد؛ سند تازه‌ای ساخته نمی‌شود، چون پارسیان آن را زده است.
 */
export function resolveReviewCheque(id, { status = '', entryId = '', documentNumber = '', fiscalYear = '', transferredTo = '', note = '', occurredAt = '' } = {}) {
  const db_ = database();
  const cheque = openCheque(db_, id, ['review']);
  if (!RESOLVABLE.includes(status)) throw invalidInput('وضعیت تازهٔ چک را انتخاب کن.');
  let entry = null;
  if (status !== 'open') {
    entry = entryId
      ? db_.prepare('SELECT id,occurred_at AS occurredAt FROM journal_entries WHERE id=?').get(String(entryId))
      : documentNumber ? db_.prepare(`SELECT id,occurred_at AS occurredAt FROM journal_entries WHERE document_number=?
          ${fiscalYear ? 'AND fiscal_year=?' : ''} ORDER BY fiscal_year DESC LIMIT 2`).all(...[Number(documentNumber), ...(fiscalYear ? [Number(fiscalYear)] : [])]) : null;
    if (Array.isArray(entry)) {
      if (entry.length > 1) throw invalidInput(`سند ${documentNumber} در چند سال هست؛ سال مالی را هم بگو.`);
      [entry] = entry;
    }
    if (!entry) throw invalidInput(`برای «${CHEQUE_STATUSES[status]}» سندی که این رویداد را در دفتر دارد لازم است؛ شمارهٔ سند را بده. سند تازه‌ای ساخته نمی‌شود.`);
  }
  if (status === 'transferred' && !String(transferredTo).trim()) throw invalidInput('چک به چه کسی واگذار شده؟');
  const at = occurredAt || entry?.occurredAt || new Date().toISOString();
  db_.exec('BEGIN IMMEDIATE');
  try {
    db_.prepare(`UPDATE cheques SET status=?,settled_entry_id=?,settled_at=?,transferred_to=?,review_reason='' WHERE id=? AND status='review'`)
      .run(status, entry?.id || null, status === 'open' ? null : at, status === 'transferred' ? String(transferredTo).trim().slice(0, 120) : cheque.transferredTo, cheque.id);
    logChequeEvent(db_, cheque.id, { at, status, entryId: entry?.id || null, note: `تعیین تکلیف حسابدار${note ? `: ${note}` : ''} (پیش‌تر: ${cheque.reviewReason})` });
    db_.exec('COMMIT');
  } catch (error) { db_.exec('ROLLBACK'); throw error; }
  audit('resolve', 'cheque', cheque.id, { status, entryId: entry?.id || null });
  return hydrate(db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(cheque.id));
}

export function chequeHistory(id) {
  const db_ = database();
  if (!db_.prepare('SELECT 1 FROM cheques WHERE id=?').get(String(id || ''))) throw invalidInput('چک پیدا نشد.');
  return db_.prepare(`SELECT cheque_events.at,cheque_events.status,cheque_events.note,cheque_events.source,cheque_events.entry_id AS entryId,
      journal_entries.document_number AS documentNumber,journal_entries.fiscal_year AS fiscalYear
    FROM cheque_events LEFT JOIN journal_entries ON journal_entries.id=cheque_events.entry_id
    WHERE cheque_id=? ORDER BY cheque_events.at,cheque_events.id`).all(String(id))
    .map((row) => ({ ...row, statusLabel: CHEQUE_STATUSES[row.status] || row.status }));
}

/**
 * تقویم سررسید: چک‌های باز (در جریان و نزد بانک) به تفکیک روز سررسید، از امروز تا
 * `days` روز بعد، به‌اضافهٔ سررسیدگذشته‌ها جدا. خالص هر روز = دریافتنی − پرداختنی.
 */
export function chequeCalendar({ days = 60, now = new Date() } = {}) {
  const db_ = database();
  const today = new Date(now);
  const startKey = dayKey(today);
  const end = new Date(today.getTime() + Math.max(1, Math.min(Number(days) || 60, 400)) * 86_400_000);
  const rows = db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE status IN ('open','deposited') AND due_at IS NOT NULL ORDER BY due_at`).all().map(hydrate);
  const overdue = [];
  const byDay = new Map();
  for (const row of rows) {
    const key = dayKey(new Date(row.dueAt));
    if (key < startKey) { overdue.push(row); continue; }
    if (new Date(row.dueAt) > end) continue;
    if (!byDay.has(key)) byDay.set(key, { day: key, dueAt: row.dueAt, receivable: 0, payable: 0, items: [] });
    const day = byDay.get(key);
    day[row.direction] += row.amount;
    day.items.push(row);
  }
  const sum = (items, direction) => items.filter((item) => item.direction === direction).reduce((total, item) => total + item.amount, 0);
  const undated = db_.prepare("SELECT COUNT(*) AS n FROM cheques WHERE status IN ('open','deposited') AND due_at IS NULL").get().n;
  return {
    overdue: { receivable: sum(overdue, 'receivable'), payable: sum(overdue, 'payable'), items: overdue },
    days: [...byDay.values()].map((day) => ({ ...day, net: day.receivable - day.payable })),
    undated,
  };
}

function dayKey(date) {
  // روز تهران؛ سررسید پارسیان نیمه‌شب تهران است.
  return new Intl.DateTimeFormat('en-CA', { timeZone: currentTimeZone() || 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
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
      ...importedChequeAccounts(db_, cheque),
      memo: `برگشت چک ${cheque.counterpartyName}`,
    }, { createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone() });
    db_.prepare("UPDATE cheques SET status='bounced',settled_entry_id=?,settled_at=? WHERE id=? AND status IN ('open','deposited')")
      .run(posted.id, bouncedAt, cheque.id);
    logChequeEvent(db_, cheque.id, { at: bouncedAt, status: 'bounced', entryId: posted.id, note: 'برگشت چک' });
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
  // سند ثبت چکِ پارسیان در خودِ بکاپ است؛ ابطالِ این‌جا آن سند را برنمی‌گرداند و چک از
  // دفتر چک می‌رفت در حالی که اسناد دریافتنی/پرداختنی همچنان بازش نگه می‌داشت.
  if (row.source === 'parsian') {
    throw Object.assign(new Error('این چک از بکاپ پارسیان آمده و سند ثبتش هم همان‌جاست؛ اگر اشتباه است، با سند اصلاحی درستش کن.'), { code: 'CHEQUE_FROM_PARSIAN', status: 409 });
  }
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
    logChequeEvent(db_, row.id, { at: new Date().toISOString(), status: 'cancelled', note: memo });
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
    // چک نزد بانک هنوز وصول نشده و جزو چک‌های دریافتی در جریان است.
    openReceivable: ['open', 'deposited'].map((status) => pick('receivable', status))
      .reduce((sum, row) => ({ count: sum.count + row.count, total: sum.total + row.total }), { count: 0, total: 0 }),
    deposited: pick('receivable', 'deposited'),
    openPayable: pick('payable', 'open'),
    bounced: rows.filter((row) => row.status === 'bounced').reduce((sum, row) => sum + row.total, 0),
    review: rows.filter((row) => row.status === 'review').reduce((sum, row) => ({ count: sum.count + row.count, total: sum.total + row.total }), { count: 0, total: 0 }),
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
  logChequeEvent(database, id, { at: event.occurredAt, status: 'open', entryId: journalEntryId, note: 'ثبت حسابدار از صف بررسی' });
  return id;
}
