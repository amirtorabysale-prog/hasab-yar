import { randomUUID } from 'node:crypto';
import { activeWorkspaceDatabase, audit, cleanAmount, db, invalidInput } from './core.js';
import { insertTransactionRows } from './transactions.js';
import { ensureFinancialEventSchema } from '../financialEventStore.js';
import { persianMonthRange, todayPersian } from '../../shared/persianDate.js';
import { isTimeBoundCategory } from '../../shared/documentReading.js';
import { TREATMENTS } from '../../shared/factRequirements.js';

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
  if (!database.prepare('PRAGMA table_info(recurring_rules)').all().some((column) => column.name === 'hold')) {
    database.exec('ALTER TABLE recurring_rules ADD COLUMN hold TEXT');
  }
  holdColumnChecked.add(database);
}

const parseHold = (value) => { try { return value ? JSON.parse(value) : null; } catch { return null; } };

export function listRecurringRules() {
  ensureHoldColumn();
  return db.prepare(`SELECT id,title,amount,type,category,day_of_month AS dayOfMonth,next_due_at AS nextDueAt,
    active,created_at AS createdAt,hold FROM recurring_rules ORDER BY active DESC,next_due_at`).all()
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
function coveringSchedule(rule, periodKey) {
  const match = coverageMatch(rule);
  if (!match) return null;
  ensureFinancialEventSchema(activeWorkspaceDatabase());
  return db.prepare(`SELECT rsi.event_id AS eventId,rsi.period_key AS periodKey,rsi.amount
    FROM recognition_schedule_items rsi JOIN financial_events fe ON fe.id=rsi.event_id
    WHERE fe.status='posted' AND rsi.period_key=? AND rsi.status IN ('planned','posted')
      AND json_extract(fe.payload,'$.category') IN (${match.categories.map(() => '?').join(',')})
      AND (SELECT d.treatment FROM accounting_decisions d WHERE d.event_id=fe.id ORDER BY d.created_at DESC,d.rowid DESC LIMIT 1)=?
    ORDER BY fe.occurred_at DESC LIMIT 1`).get(periodKey, ...match.categories, match.treatment) || null;
}

function coveredQuestion(rule, periodKey, covering) {
  const side = rule.type === 'income' ? 'پیش‌دریافتِ' : 'پیش‌پرداختِ';
  return `ماه ${periodKey} را ${side} ثبت‌شده‌ای (${Number(covering.amount).toLocaleString('fa-IR')} تومان در همین ماه) پوشش می‌دهد؛ `
    + `ثبت دوره‌ای «${rule.title}» برای این ماه وارد نشد. اگر همان قرارداد است این ماه را رد کن یا قاعده را متوقف کن؛ اگر جداست، ثبتش کن.`;
}

function nextMonthlyDate(day, from = new Date()) {
  const next = new Date(from);
  next.setUTCHours(9, 0, 0, 0);
  next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()));
  if (next <= from) {
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
  if (!title) throw invalidInput('عنوان ثبت تکرارشونده را وارد کن.');
  db.prepare(`INSERT INTO recurring_rules (id,title,amount,type,category,day_of_month,next_due_at,active) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title,amount=excluded.amount,type=excluded.type,category=excluded.category,
      day_of_month=excluded.day_of_month,next_due_at=excluded.next_due_at,active=excluded.active,updated_at=CURRENT_TIMESTAMP`)
    .run(id, title, amount, type, String(values.category || (type === 'income' ? 'سایر درآمدها' : 'سایر هزینه‌ها')).slice(0, 80), day, values.nextDueAt || nextMonthlyDate(day), values.active === false ? 0 : 1);
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
        const covering = !existed && month && hold?.allowPeriodKey !== month.month ? coveringSchedule(item, month.month) : null;
        if (covering) {
          const question = coveredQuestion(item, month.month, covering);
          heldNow = { reason: 'covered-by-prepaid', periodKey: month.month, dueAt: nextDue, eventId: covering.eventId, question };
          held.push({ ruleId: item.id, title: item.title, amount: item.amount, reason: 'covered-by-prepaid', eventId: covering.eventId, periodKey: month.month, question });
          break;
        }
        // اجاره، بیمه یا اشتراکِ ماهانهٔ قاعده مال همان ماه سررسید است.
        const ownMonth = item.type === 'expense' && isTimeBoundCategory(item.category) && month
          ? { servicePeriodStart: month.from, servicePeriodEnd: month.to } : {};
        insertTransactionRows({ transcript: item.title, transactions: [{
          clientId, amount: item.amount, type: item.type, category: item.category,
          rawText: item.title, note: 'ثبت خودکار دوره‌ای', source: 'text', occurredAt: nextDue, ...ownMonth,
        }] });
        if (!existed) created += 1;
        nextDue = nextMonthlyDate(item.day_of_month, new Date(nextDue));
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
      .run(nextMonthlyDate(rule.day_of_month, new Date(hold.dueAt || rule.next_due_at)), rule.id);
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
