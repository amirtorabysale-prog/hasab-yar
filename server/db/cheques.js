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

export const CHEQUE_STATUSES = Object.freeze({
  open: 'در جریان', cleared: 'وصول‌شده', bounced: 'برگشتی', cancelled: 'ابطال‌شده',
});

function ensureChequeSchema(database) {
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
  const contactId = values.contactId || (values.counterpartyName ? contactIdForName(values.counterpartyName, values.counterpartyResolution) : null);
  const counterpartyName = String(values.counterpartyName || '').trim().slice(0, 120)
    || (contactId ? db_.prepare('SELECT name FROM contacts WHERE id=?').get(contactId)?.name || '' : '');
  if (!counterpartyName) throw invalidInput('نام صاحب چک یا گیرندهٔ آن لازم است.');
  const against = values.against === 'receivable' ? 'receivable' : 'income';
  const category = String(values.category || (direction === 'receivable' ? 'فروش' : 'مواد و کالا')).trim().slice(0, 80);
  const occurredAt = values.occurredAt || new Date().toISOString();
  const id = randomUUID();

  db_.exec('BEGIN IMMEDIATE');
  try {
    const analyticId = contactId
      ? analyticForContact(db_, contactId, counterpartyName)?.id || null
      : counterpartyAnalyticForKey(db_, counterpartyName);
    const posted = postChequeJournal(db_, {
      chequeId: id, direction, against, amount, occurredAt, category,
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
