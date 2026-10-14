import { reviewNature } from '../shared/reviewNature.js';
import { normalizePersian } from '../shared/normalize.js';
import { payrollLedgerAccounts } from './accounting.js';

/**
 * پرداخت لیست بیمه از صف حسابدار — تسویهٔ بدهی لیست حقوق، نه هزینهٔ تازه.
 *
 * لیست حقوق هنگام ثبت، بیمهٔ سهم کارمند و کارفرما را بدهی کرده و سهم کارفرما
 * را همان‌جا هزینه کرده است. پرداختی که از راه صدا یا متن می‌رسد (T062) اگر
 * هزینه شود، سهم کارفرما دو بار هزینه می‌شود و بدهی بیمه هیچ‌وقت بسته نمی‌شود.
 * پس پرداخت فقط به یک لیست واقعیِ پرداخت‌نشده وصل می‌شود، به مبلغ دقیق همان
 * لیست، و لیست «پرداخت‌شده» علامت می‌خورد تا دکمهٔ پرداخت صفحهٔ حقوق دوباره
 * همان را نپردازد.
 */
export const INSURANCE_ROLE = 'payroll-insurance-payable';
const QUESTION_ID = 'nature.insurance-settlement';

export function ensureInsuranceSettlementSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS accounting_review_insurance (
    event_id TEXT PRIMARY KEY REFERENCES financial_events(id) ON DELETE RESTRICT,
    run_id TEXT NOT NULL,
    journal_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
    amount INTEGER NOT NULL CHECK(amount>0));`);
}
const question = text => ({ id: QUESTION_ID, text });
const reference = value => normalizePersian(String(value || '')).replace(/\s+/g, '').trim();
const fa = value => Number(value || 0).toLocaleString('fa-IR');

function openRuns(database, occurredAt) {
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payroll_runs'").get();
  if (!table) return [];
  return database.prepare(`SELECT id,period,occurred_at AS occurredAt,insurance_employee+insurance_employer AS total
    FROM payroll_runs WHERE insurance_paid_at IS NULL AND insurance_employee+insurance_employer>0 ORDER BY occurred_at,period`).all()
    .filter((run) => !occurredAt || String(run.occurredAt).slice(0, 10) <= String(occurredAt).slice(0, 10));
}

/**
 * رویدادهایی که پول آورده‌اند. پرداخت لیست بیمه همیشه خروج وجه است؛
 * «تأمین اجتماعی ۱۵ میلیون به حساب شرکت واریز کرد» یا «… بهمون پس داد» هر
 * فعلی هم داشته باشد، تسویهٔ بدهی لیست نیست و لیست را «پرداخت‌شده» نمی‌کند.
 */
const MONEY_IN_KINDS = new Set(['cash-income', 'cheque-received', 'receivable-opened', 'capital-contribution', 'sales-invoice']);

export function insuranceSettlementContext(database, text, amount, event = {}) {
  if (!reviewNature(text).insuranceSettlement || MONEY_IN_KINDS.has(event?.kind)) return null;
  const runs = openRuns(database, event.occurredAt);
  const answer = reference(event.questionAnswers?.[QUESTION_ID]?.value);
  const byAmount = runs.filter((run) => run.total === amount);
  // یک لیست باز با مبلغ دیگر: همان را نام می‌بریم تا اختلاف مبلغ دیده شود.
  const matched = answer ? runs.filter((run) => [run.period, run.id].some((value) => reference(value) === answer))
    : byAmount.length ? byAmount : runs.length === 1 ? runs : [];
  if (matched.length !== 1) {
    const list = runs.slice(0, 12).map((run) => `${run.period}: ${fa(run.total)}`).join('، ');
    return { run: null, candidates: runs.slice(0, 12), question: question(runs.length
      ? `پرداخت بیمه مربوط به لیست حقوق کدام دوره است؟ دوره را وارد کن (بیمهٔ پرداخت‌نشده: ${list}).`
      : 'لیست حقوقی با بیمهٔ پرداخت‌نشده پیدا نشد. اول لیست حقوق همان دوره را در صفحهٔ «حقوق» وارد کن؛ پرداخت بیمه بدون بدهی ثبت‌شده، هزینهٔ سهم کارفرما را دو بار می‌شمارد.') };
  }
  const run = matched[0];
  if (amount !== run.total) {
    return { run: null, candidates: [run], question: question(`مبلغ پرداخت (${fa(amount)}) با بیمهٔ لیست ${run.period} (${fa(run.total)}) برابر نیست. جریمه یا پرداخت جزئی باید جدا بررسی شود.`) };
  }
  return { run, accountId: payrollLedgerAccounts(database).insurancePayable, question: null };
}

export function insuranceSettlementProposal(database, text, amount, event) {
  const context = insuranceSettlementContext(database, text, amount, event);
  if (!context) return null;
  if (!context.run) {
    return { summary: 'تطبیق پرداخت بیمه با لیست حقوق', explanation: 'پرداخت لیست بیمه تسویهٔ بدهی لیست حقوق است، نه هزینهٔ تازه.', missingFacts: [], questions: [context.question], lines: [] };
  }
  const { run } = context;
  return {
    summary: 'پرداخت بیمهٔ لیست حقوق',
    explanation: `تسویهٔ بیمهٔ پرداختنی لیست ${run.period} (سهم کارمند و کارفرما) به مبلغ ${fa(run.total)} تومان. هزینهٔ سهم کارفرما هنگام ثبت لیست شناسایی شده و دوباره هزینه نمی‌شود.`,
    missingFacts: [], questions: [],
    lines: [
      { role: INSURANCE_ROLE, accountId: context.accountId, key: 'بیمهٔ پرداختنی (تأمین اجتماعی)', debit: amount, credit: 0 },
      { role: 'cash', debit: 0, credit: amount },
    ],
  };
}

export function insuranceSettlementValidation(database, text, amount, event, lines) {
  const used = lines.some((line) => line.role === INSURANCE_ROLE);
  const context = insuranceSettlementContext(database, text, amount, event);
  if (!context) return { run: null, issues: used ? [question('نقش بیمهٔ پرداختنی فقط برای پرداخت لیست بیمهٔ حقوق قابل استفاده است.')] : [] };
  if (!used) return { run: null, issues: [] };
  if (!context.run) return { run: null, candidates: context.candidates || [], issues: [context.question] };
  const payable = lines.filter((line) => line.role === INSURANCE_ROLE);
  const cash = lines.filter((line) => line.role === 'cash');
  const exact = lines.length === 2 && payable.length === 1 && cash.length === 1
    && payable[0].accountId === context.accountId && payable[0].debit === amount && cash[0].credit === amount;
  return { run: context.run, issues: exact ? [] : [question('سند پرداخت بیمه باید فقط بیمهٔ پرداختنی همان لیست را به مبلغ کامل بدهکار و بانک را بستانکار کند.')] };
}

/** داخل تراکنش تأیید: لیست «پرداخت‌شده» می‌شود؛ پرداخت هم‌زمان از صفحهٔ حقوق شکست می‌خورد. */
export function allocateInsuranceSettlement(database, eventId, journalId, run, amount, occurredAt) {
  if (!run) return;
  ensureInsuranceSettlementSchema(database);
  const changed = database.prepare('UPDATE payroll_runs SET insurance_paid_at=? WHERE id=? AND insurance_paid_at IS NULL').run(occurredAt, run.id).changes;
  if (!changed) throw Object.assign(new Error('بیمهٔ این لیست هم‌زمان پرداخت شده است؛ پرونده را دوباره بررسی کن.'), { code: 'PAYROLL_ALREADY_PAID', status: 409 });
  database.prepare('INSERT INTO accounting_review_insurance(event_id,run_id,journal_id,amount) VALUES(?,?,?,?)').run(eventId, run.id, journalId, amount);
}

/** برگشت همان رویداد، لیست را دوباره «پرداخت‌نشده» می‌کند. */
export function releaseInsuranceSettlement(database, eventId) {
  ensureInsuranceSettlementSchema(database);
  const allocation = database.prepare('SELECT run_id AS runId FROM accounting_review_insurance WHERE event_id=?').get(eventId);
  if (!allocation) return;
  database.prepare('UPDATE payroll_runs SET insurance_paid_at=NULL WHERE id=?').run(allocation.runId);
  database.prepare('DELETE FROM accounting_review_insurance WHERE event_id=?').run(eventId);
}
