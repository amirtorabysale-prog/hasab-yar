import { randomUUID } from 'node:crypto';
import { activeWorkspaceDatabase, audit, cleanAmount, db, invalidInput } from './core.js';
import { insertTransactionRows } from './transactions.js';
import { ensureFinancialEventSchema } from '../financialEventStore.js';
import { persianMonthRange, todayPersian } from '../../shared/persianDate.js';
import { bookedServiceFacts, isTimeBoundCategory } from '../../shared/documentReading.js';
import { TREATMENTS } from '../../shared/factRequirements.js';
import { unitLabel } from '../../shared/amountUnit.js';

/**
 * قاعدهٔ تکرار و خدمت دوره‌دار.
 *
 * اجارهٔ ماهانه‌ای که قاعده می‌سازد مال همان ماه است؛ تا امروز ردیفش بی‌دوره
 * ساخته می‌شد و موتور هر ماه دو سؤال «دورهٔ پوشش از کی؟ تا کی؟» می‌پرسید. حالا
 * ماه شمسیِ سررسید، دورهٔ پوشش همان ردیف است و هزینهٔ همان ماه بی‌سؤال ثبت
 * می‌شود.
 *
 * و اگر برای همان ماه پیش‌پرداختی (یا پیش‌دریافتی) با برنامهٔ شناسایی در دفتر
 * باشد، ردیف نقدی ساخته نمی‌شود: «اجارهٔ شش ماه جلوتر دادیم» به‌علاوهٔ قاعدهٔ
 * اجارهٔ ماهانه، هر ماه دو بار هزینه و یک خروج نقدیِ خیالی می‌ساخت. چون قاعده
 * طرف حساب ندارد و هم‌دسته بودن ثابت نمی‌کند همان قرارداد است، بی‌صدا هم رد
 * نمی‌شود: سررسید سر جایش می‌ماند و از صاحب کسب‌وکار پرسیده می‌شود.
 */
const holdColumnChecked = new WeakSet();
function ensureHoldColumn() {
  const database = activeWorkspaceDatabase();
  if (holdColumnChecked.has(database)) return;
  const columns = database.prepare('PRAGMA table_info(recurring_rules)').all().map((column) => column.name);
  if (!columns.includes('hold')) database.exec('ALTER TABLE recurring_rules ADD COLUMN hold TEXT');
  // بانک یا صندوقی که قاعده از آن می‌پردازد؛ خالی یعنی صندوق پیش‌فرض، مثل قبل.
  // اجاره‌ای که سال‌ها از بانک ملت رفته، نباید ماه بعد از صندوق برود.
  if (!columns.includes('account_id')) database.exec('ALTER TABLE recurring_rules ADD COLUMN account_id TEXT');
  holdColumnChecked.add(database);
}

const parseHold = (value) => { try { return value ? JSON.parse(value) : null; } catch { return null; } };

export function listRecurringRules() {
  ensureHoldColumn();
  return db.prepare(`SELECT id,title,amount,type,category,day_of_month AS dayOfMonth,next_due_at AS nextDueAt,
    active,created_at AS createdAt,hold,account_id AS accountId FROM recurring_rules ORDER BY active DESC,next_due_at`).all()
    .map(({ hold, ...rule }) => {
      const parsed = parseHold(hold);
      return { ...rule, hold: parsed?.reason ? parsed : null };
    });
}

/** ماه شمسیِ یک سررسید — دورهٔ پوشش ردیف همان ماه. */
function dueMonth(iso) {
  const day = todayPersian(new Date(iso));
  return persianMonthRange(day.year, day.month);
}

// اجارهٔ پرداختی در برابر پیش‌پرداخت اجاره؛ اجارهٔ دریافتی در برابر درآمد
// انتقالیِ اجاره — هر دو نام دستهٔ درآمد اجاره پذیرفته‌اند.
function coverageMatch(rule) {
  if (rule.type === 'income') {
    return ['اجاره', 'درآمد اجاره'].includes(rule.category)
      ? { categories: ['اجاره', 'درآمد اجاره'], treatment: TREATMENTS.DEFERRED_REVENUE } : null;
  }
  return isTimeBoundCategory(rule.category) ? { categories: [rule.category], treatment: TREATMENTS.PREPAID_EXPENSE } : null;
}

/** پیش‌پرداخت یا پیش‌دریافتِ ثبت‌شده‌ای که همین ماه را پوشش می‌دهد. */
function coveringSchedule(rule, periodKey, month = null) {
  const match = coverageMatch(rule);
  if (!match) return null;
  ensureFinancialEventSchema(activeWorkspaceDatabase());
  return db.prepare(`SELECT rsi.event_id AS eventId,rsi.period_key AS periodKey,rsi.amount
    FROM recognition_schedule_items rsi JOIN financial_events fe ON fe.id=rsi.event_id
    WHERE fe.status='posted' AND rsi.period_key=? AND rsi.status IN ('planned','posted')
      AND json_extract(fe.payload,'$.category') IN (${match.categories.map(() => '?').join(',')})
      AND (SELECT d.treatment FROM accounting_decisions d WHERE d.event_id=fe.id ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1)=?
    ORDER BY fe.occurred_at DESC LIMIT 1`).get(periodKey, ...match.categories, match.treatment)
    || (month ? coveringTransaction(rule, match, month) : null);
}

/**
 * ردیف ثبت‌شده‌ای که دورهٔ گفته‌شده‌اش همین ماه را می‌گیرد — بی‌برنامهٔ شناسایی.
 *
 * با موتور خاموش (پیش‌فرض) «اجاره ۶ ماه دفتر رو جلوتر دادیم ۳۰ میلیون» یک ردیف
 * هزینهٔ اجاره است و برنامه‌ای نمی‌سازد؛ قاعدهٔ اجارهٔ ماهانه کنارش هر ماه یک
 * خروج نقدی دیگر می‌ساخت. دوره از متن خودِ ردیف (نسبت به تاریخش) خوانده می‌شود،
 * همان خواننده‌ای که صورت‌حساب و رسید دارند.
 */
function coveringTransaction(rule, match, month) {
  const categories = match.categories;
  const from = new Date(new Date(month.from).getTime() - 3 * 366 * 86_400_000).toISOString();
  const rows = db.prepare(`SELECT id,amount,type,category,raw_text AS rawText,occurred_at AS occurredAt FROM transactions
    WHERE status!='deleted' AND type=? AND category IN (${categories.map(() => '?').join(',')})
      AND (client_id IS NULL OR client_id NOT LIKE 'recurring:%') AND occurred_at<=? AND occurred_at>=?
    ORDER BY occurred_at DESC LIMIT 60`).all(rule.type, ...categories, month.to, from);
  const start = new Date(month.from).getTime();
  const end = new Date(month.to).getTime();
  for (const row of rows) {
    const facts = bookedServiceFacts(row.rawText, { type: row.type, category: row.category, occurredAt: row.occurredAt });
    if (!facts.servicePeriodStart || !facts.servicePeriodEnd) continue;
    // همپوشانیِ واقعی با ماه سررسید، نه فقط یک روزِ مرزی.
    const overlap = Math.min(end, new Date(facts.servicePeriodEnd).getTime()) - Math.max(start, new Date(facts.servicePeriodStart).getTime());
    if (overlap >= 7 * 86_400_000 || overlap >= (end - start) / 2) {
      return { transactionId: row.id, periodKey: month.month, amount: row.amount, fromTransaction: true };
    }
  }
  return null;
}

function coveredQuestion(rule, periodKey, covering) {
  const side = rule.type === 'income' ? 'پیش‌دریافتِ' : 'پیش‌پرداختِ';
  if (covering.fromTransaction) {
    return `ماه ${periodKey} را ${side} ثبت‌شده‌ای (ردیف ${Number(covering.amount).toLocaleString('fa-IR')} ${unitLabel()}ی که دوره‌اش این ماه را می‌گیرد) پوشش می‌دهد؛ `
      + `ثبت دوره‌ای «${rule.title}» برای این ماه وارد نشد. اگر همان قرارداد است این ماه را رد کن یا قاعده را متوقف کن؛ اگر جداست، ثبتش کن.`;
  }
  return `ماه ${periodKey} را ${side} ثبت‌شده‌ای (${Number(covering.amount).toLocaleString('fa-IR')} ${unitLabel()} در همین ماه) پوشش می‌دهد؛ `
    + `ثبت دوره‌ای «${rule.title}» برای این ماه وارد نشد. اگر همان قرارداد است این ماه را رد کن یا قاعده را متوقف کن؛ اگر جداست، ثبتش کن.`;
}

// کوتاه‌ترین فاصلهٔ دو سررسید ماهانه ۲۸ روز است؛ هر نامزد نزدیک‌تر از این، همان سررسید است.
const MIN_MONTHLY_GAP_MS = 20 * 86_400_000;

/**
 * سررسید ماهانهٔ بعدی. با `afterOccurrence`، `from` خودش یک سررسید است و بعدی دست‌کم یک ماه
 * بعد است: سررسیدی که در ساعت‌های اول بامداد تهران است در UTC روز قبل می‌افتد و «همان روزِ
 * همین ماه» دوباره نامزد می‌شد؛ قسط دو بار ثبت می‌شد.
 */
export function nextMonthlyDate(day, from = new Date(), { afterOccurrence = false } = {}) {
  const next = new Date(from);
  next.setUTCHours(9, 0, 0, 0);
  next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()));
  if (next <= from || (afterOccurrence && next - from < MIN_MONTHLY_GAP_MS)) {
    next.setUTCMonth(next.getUTCMonth() + 1, 1);
    next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()));
  }
  return next.toISOString();
}

export function saveRecurringRule(values = {}) {
  // جواب سؤال «این ماه را پیش‌پرداخت پوشش می‌دهد» از همان مسیر ذخیره می‌آید و
  // بقیهٔ قاعده را دست نمی‌زند.
  if (values.id && values.coveredMonth) return resolveRecurringHold(values.id, values.coveredMonth);
  const id = values.id || randomUUID();
  const amount = cleanAmount(values.amount);
  const type = ['income', 'expense'].includes(values.type) ? values.type : 'expense';
  const day = Math.min(31, Math.max(1, Number(values.dayOfMonth) || new Date().getDate()));
  const title = String(values.title || '').trim().slice(0, 120);
  ensureHoldColumn();
  const accountId = values.accountId ? String(values.accountId) : null;
  if (accountId && !db.prepare('SELECT 1 FROM accounts WHERE id=? AND active=1').get(accountId)) throw invalidInput('بانک یا صندوق این ثبت تکرارشونده پیدا نشد.');
  if (!title) throw invalidInput('عنوان ثبت تکرارشونده را وارد کن.');
  db.prepare(`INSERT INTO recurring_rules (id,title,amount,type,category,day_of_month,next_due_at,active,account_id) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,amount=excluded.amount,type=excluded.type,category=excluded.category,
      day_of_month=excluded.day_of_month,next_due_at=excluded.next_due_at,active=excluded.active,account_id=COALESCE(excluded.account_id,recurring_rules.account_id),updated_at=CURRENT_TIMESTAMP`)
    .run(id, title, amount, type, String(values.category || (type === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها')).slice(0, 80), day, values.nextDueAt || nextMonthlyDate(day), values.active === false ? 0 : 1, accountId);
  audit(values.id ? 'update' : 'create', 'recurring', id, { title, amount });
  return listRecurringRules().find((item) => item.id === id);
}

export function materializeRecurringRules(now = new Date()) {
  ensureHoldColumn();
  const due = db.prepare('SELECT * FROM recurring_rules WHERE active=1 AND next_due_at<=?').all(now.toISOString());
  let created = 0;
  const held = [];
  for (const item of due) {
    let nextDue = item.next_due_at;
    const hold = parseHold(item.hold);
    let heldNow = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      while (nextDue <= now.toISOString()) {
        const clientId = `recurring:${item.id}:${nextDue.slice(0, 10)}`;
        const existed = db.prepare('SELECT id FROM transactions WHERE client_id=?').get(clientId);
        const month = dueMonth(nextDue);
        const covering = !existed && month && hold?.allowPeriodKey !== month.month ? coveringSchedule(item, month.month, month) : null;
        if (covering) {
          const question = coveredQuestion(item, month.month, covering);
          const source = covering.transactionId ? { transactionId: covering.transactionId } : { eventId: covering.eventId };
          heldNow = { reason: 'covered-by-prepaid', periodKey: month.month, dueAt: nextDue, ...source, question };
          held.push({ ruleId: item.id, title: item.title, amount: item.amount, reason: 'covered-by-prepaid', ...source, periodKey: month.month, question });
          break;
        }
        // اجاره، بیمه یا اشتراکِ ماهانهٔ قاعده مال همان ماه سررسید است.
        const ownMonth = item.type === 'expense' && isTimeBoundCategory(item.category) && month
          ? { servicePeriodStart: month.from, servicePeriodEnd: month.to } : {};
        insertTransactionRows({ transcript: item.title, transactions: [{
          clientId, amount: item.amount, type: item.type, category: item.category,
          rawText: item.title, note: 'ثبت خودکار دوره‌ای', source: 'text', occurredAt: nextDue, ...ownMonth,
          ...(item.account_id ? { accountId: item.account_id } : {}),
        }] });
        if (!existed) created += 1;
        nextDue = nextMonthlyDate(item.day_of_month, new Date(nextDue), { afterOccurrence: true });
      }
      // سؤال تازه می‌ماند؛ اجازهٔ «ثبتش کن» با ثبت همان ماه مصرف شده است.
      db.prepare('UPDATE recurring_rules SET next_due_at=?,hold=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(nextDue, heldNow ? JSON.stringify(heldNow) : null, item.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      // ثبت دوره‌ای که صندوق یا بانک را منفی می‌کند، خودکار نمی‌خورد و سررسیدش
      // سر جایش می‌ماند تا وقتی موجودی برسد یا حسابدار آن را دستی تأیید کند. باز
      // شدن برنامه و بقیهٔ قاعده‌ها نباید پشت آن بمانند.
      if (error.code === 'NEGATIVE_BALANCE') { held.push({ ruleId: item.id, title: item.title, amount: item.amount }); continue; }
      throw error;
    }
  }
  materializeRecurringRules.lastHeld = held;
  return created;
}

/**
 * جواب صاحب کسب‌وکار به ماهی که پیش‌پرداخت پوشش می‌دهد.
 *
 * `skip`: همان قرارداد است؛ این ماه بی‌ردیف نقدی رد می‌شود و سررسید به ماه بعد
 * می‌رود. `post`: قرارداد جداست؛ همین ماه ثبت می‌شود. `pause`: قاعده تا پایان
 * پیش‌پرداخت متوقف می‌شود. هر کدام در ردپا می‌ماند.
 */
export function resolveRecurringHold(id, action) {
  ensureHoldColumn();
  const rule = db.prepare('SELECT * FROM recurring_rules WHERE id=?').get(String(id || ''));
  if (!rule) throw Object.assign(invalidInput('ثبت تکرارشونده پیدا نشد.'), { status: 404, code: 'RECURRING_MISSING' });
  const hold = parseHold(rule.hold);
  if (!hold?.reason) throw Object.assign(invalidInput('این ثبت تکرارشونده منتظر جوابی نیست.'), { status: 409, code: 'RECURRING_NOT_HELD' });
  if (action === 'skip') {
    db.prepare('UPDATE recurring_rules SET next_due_at=?,hold=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(nextMonthlyDate(rule.day_of_month, new Date(hold.dueAt || rule.next_due_at), { afterOccurrence: true }), rule.id);
  } else if (action === 'post') {
    db.prepare('UPDATE recurring_rules SET hold=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({ allowPeriodKey: hold.periodKey }), rule.id);
  } else if (action === 'pause') {
    db.prepare('UPDATE recurring_rules SET active=0,hold=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(rule.id);
  } else {
    throw invalidInput('جواب باید «رد این ماه»، «ثبت» یا «توقف قاعده» باشد.');
  }
  audit('resolve-covered-month', 'recurring', rule.id, { action, periodKey: hold.periodKey, eventId: hold.eventId });
  // سررسیدِ نگه‌داشته همیشه گذشته است؛ همان ماه همین حالا ثبت می‌شود.
  if (action === 'post') materializeRecurringRules(new Date(Math.max(Date.now(), new Date(hold.dueAt || 0).getTime())));
  return listRecurringRules().find((item) => item.id === rule.id);
}

export function deleteRecurringRule(id) {
  const result = db.prepare('DELETE FROM recurring_rules WHERE id=?').run(id);
  if (result.changes) audit('delete', 'recurring', id);
  return result.changes > 0;
}
