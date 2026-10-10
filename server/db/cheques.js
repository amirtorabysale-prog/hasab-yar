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
import { chequeLedgerAccounts, postChequeJournal } from '../accounting.js';
import { activeWorkspaceDatabase, audit, cleanAmount, currentTimeZone, currentWorkspace, db, invalidInput } from './core.js';
import { contactIdForName } from './contacts.js';
import { resolveAccountId } from './accounts.js';
import { recordFinancialEvent } from '../financialEventStore.js';
import { normalizeFinancialEvent } from '../../shared/financialEvent.js';
import { purchasePurposeFromSpeech } from '../../shared/purchasePurpose.js';

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
  const category = String(values.category || (direction === 'receivable' ? 'فروش' : 'مواد و کالا')).trim().slice(0, 80);
  // «چک دادیم برای خرید مواد اولیه» موجودی می‌خرد، نه هزینهٔ این ماه. همان
  // خواندن هدف خرید که خرید نقدی دارد؛ بی‌نشانه، رفتار قبلی می‌ماند.
  const intendedUse = values.intendedUse || (direction === 'payable' && against === 'income' ? purchasePurposeFromSpeech(values.note) : null);
  const inventory = direction === 'payable' && against === 'income' && ['resale', 'production'].includes(intendedUse);
  const occurredAt = values.occurredAt || new Date().toISOString();
  const id = randomUUID();

  db_.exec('BEGIN IMMEDIATE');
  try {
    const analyticId = contactId
      ? analyticForContact(db_, contactId, counterpartyName)?.id || null
      : counterpartyAnalyticForKey(db_, counterpartyName);
    const posted = postChequeJournal(db_, {
      chequeId: id, direction, against, amount, occurredAt, category, inventory,
      counterparty: { contactId, name: counterpartyName, analyticId },
      memo: `چک ${direction === 'receivable' ? 'دریافتی از' : 'پرداختی به'} ${counterpartyName}`,
    }, { createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone() });

    db_.prepare(`INSERT INTO cheques (id,direction,contact_id,counterparty_name,amount,due_at,occurred_at,serial,
      bank_name,against,obligation_id,analytic_id,note,journal_entry_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, direction, contactId, counterpartyName, amount, values.dueAt || null, occurredAt,
        String(values.serial || '').trim().slice(0, 40), String(values.bankName || '').trim().slice(0, 60),
        against, values.obligationId || null, analyticId, String(values.note || '').slice(0, 300), posted.id);
    db_.exec('COMMIT');
  } catch (error) { db_.exec('ROLLBACK'); throw error; }

  audit('create', 'cheque', id, { direction, amount, against, counterpartyName });
  return hydrate(db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(id));
}

function openCheque(db_, id) {
  const row = db_.prepare(`SELECT ${COLUMNS} FROM cheques WHERE id=?`).get(String(id || ''));
  if (!row) throw invalidInput('چک پیدا نشد.');
  if (row.status !== 'open') throw Object.assign(new Error(`این چک از قبل «${CHEQUE_STATUSES[row.status]}» است.`), { code: 'CHEQUE_NOT_OPEN', status: 409 });
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
  const id = `review:${eventId}`;
  database.prepare(`INSERT INTO cheques(id,direction,contact_id,counterparty_name,amount,due_at,occurred_at,against,analytic_id,note,journal_entry_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,direction,event.counterpartyId,event.counterparty,line.debit || line.credit,event.dueAt,event.occurredAt,against,line.analyticId,`بررسی حسابدار: ${eventId}`,journalEntryId);
  return id;
}
