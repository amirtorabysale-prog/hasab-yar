import { createHash, randomUUID } from 'node:crypto';
import { audit, currentTimeZone, currentWorkspace, db, invalidInput } from './core.js';
import { automationPolicy } from './settings.js';
import { insertTransactionRows, previewTransactions, recordUnderstoodObligation } from './transactions.js';
import { queueUnderstoodIntake } from './reviewIntakes.js';
import { openDocumentsFor } from './counterpartyCard.js';
import { settleObligation } from './obligations.js';
import { recordInvoicePayment } from './invoices.js';
import { postAccountTransferJournal } from '../accounting.js';
import { recordFinancialEvent } from '../financialEventStore.js';
import { understandText, understandingProvider } from '../eventUnderstandingAi.js';
import { resolveUnderstanding } from '../understandingResolve.js';
import { buildUnderstandingPlan } from '../../shared/understandingPlan.js';
import { inUnderstandingScope, understandingReasons } from '../../shared/understandingScope.js';
import { applyAnswer } from '../../shared/questionAnswer.js';
import { FACT_QUESTIONS } from '../../shared/factRequirements.js';
import { EVENT_KINDS, normalizeFinancialEvent } from '../../shared/financialEvent.js';
import { ROUTES } from '../../shared/confidenceEngine.js';

/**
 * پروندهٔ «فهم رویداد» — هر گفته یک پرونده، هر استخراج یا پاسخ یک نسخه.
 *
 * پرونده متن اصلی کاربر را همیشه نگه می‌دارد و هیچ‌وقت آن را جایگزین برداشت
 * مدل نمی‌کند. پاسخ‌های ثبت‌کننده جدا ذخیره می‌شوند و هر بار نقشه از نو و با
 * همان پاسخ‌ها ساخته می‌شود؛ پس استخراج تازهٔ مدل نمی‌تواند پاسخی را که کاربر
 * داده بازنویسی کند.
 *
 * ثبت فقط از مسیر همیشگی است (`insertTransactionRows` و موتور قاعده)، در یک
 * تراکنش SQLite، با `client_id` ثابت برای هر جزء: دو بار کلیک یا تکرار درخواست
 * سند دوم نمی‌سازد.
 */

const STATUSES = ['extracting', 'needs-answers', 'ready', 'needs-accountant', 'sent-to-accountant', 'no-entry', 'failed', 'posted', 'dismissed'];
const fail = (message, code, status = 409, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });

export function ensureUnderstandingSchema(database = db) {
  database.exec(`CREATE TABLE IF NOT EXISTS understanding_cases (
      id TEXT PRIMARY KEY,
      client_id TEXT UNIQUE,
      mode TEXT NOT NULL CHECK(mode IN ('active','shadow')),
      source TEXT NOT NULL DEFAULT 'text',
      transcript TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (${STATUSES.map((item) => `'${item}'`).join(',')})),
      version INTEGER NOT NULL DEFAULT 0,
      answers TEXT NOT NULL DEFAULT '{}',
      reasons TEXT NOT NULL DEFAULT '[]',
      error_code TEXT,
      error_message TEXT,
      legacy TEXT,
      comparison TEXT,
      result TEXT,
      review_ref TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_understanding_cases_mode ON understanding_cases(mode,created_at);
    CREATE TABLE IF NOT EXISTS understanding_versions (
      case_id TEXT NOT NULL REFERENCES understanding_cases(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      understanding TEXT NOT NULL,
      violations TEXT NOT NULL DEFAULT '[]',
      plan TEXT,
      model TEXT,
      cache_hit INTEGER NOT NULL DEFAULT 0,
      usage TEXT NOT NULL DEFAULT '{}',
      latency_ms INTEGER,
      trigger TEXT NOT NULL DEFAULT 'extraction',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (case_id, version)
    );`);
  return database;
}

const json = (value, fallback) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const caseRow = (id) => db.prepare('SELECT * FROM understanding_cases WHERE id=?').get(String(id || ''));
const latestVersion = (caseId) => db.prepare('SELECT * FROM understanding_versions WHERE case_id=? ORDER BY version DESC LIMIT 1').get(caseId);
const touch = (id, fields) => {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE understanding_cases SET ${keys.map((key) => `${key}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(...keys.map((key) => fields[key]), id);
};

// ---------------------------------------------------------------------------
// نقشه: فهم + پاسخ‌ها + تطبیق با دفتر + پیش‌نمایش موتور
// ---------------------------------------------------------------------------

/** پاسخ سؤال موتور («بابت چه بود؟»، «مقیاس مبلغ؟») روی ردیف همان جزء. */
function applyEngineAnswers(component, answers, today) {
  let item = { ...component.item };
  const prefix = `engine.${component.id}.`;
  for (const [key, answer] of Object.entries(answers)) {
    if (!key.startsWith(prefix)) continue;
    const fact = key.slice(prefix.length);
    const patch = applyAnswer({ ...item, occurredAt: item.occurredAt || today }, { fact, value: answer.value, freeText: answer.freeText || '' }, { today });
    for (const [field, value] of Object.entries(patch)) {
      if (field === 'cashAccountId') item.accountId = value;
      else if (field === 'counterparty') item = { ...item, contactName: value, linkContact: true, contactNameConfident: true };
      else item[field] = value;
    }
  }
  return item;
}

const ENGINE_PICKER = { 'free-input': 'text', options: 'options' };

/**
 * نقشهٔ کامل پرونده، همیشه از نو.
 *
 * تطبیق با دفتر (ماندهٔ طرف حساب، حساب‌های فعال) هر بار تازه خوانده می‌شود: اگر
 * بین پیش‌نمایش و ثبت سند دیگری بدهیِ همان شخص را تسویه کرده باشد، نقشه همان
 * لحظه عوض می‌شود.
 */
function planCase(understanding, answers, row, now = new Date()) {
  const resolution = resolveUnderstanding(understanding);
  // سندهای بازِ هر طرف حسابی که در نقشه ممکن است لازم شود: هم‌نامِ قطعی، و
  // شخصی که ثبت‌کننده انتخاب کرده.
  const contactIds = new Set([
    ...Object.values(resolution.counterparties).map((item) => item.contactId).filter(Boolean),
    ...Object.entries(answers).filter(([key, answer]) => key.startsWith('counterparties.') && answer.valueId && answer.valueId !== 'new').map(([, answer]) => answer.valueId),
  ]);
  resolution.documents = Object.fromEntries([...contactIds].map((contactId) => [contactId, openDocumentsFor(contactId)]));
  const plan = buildUnderstandingPlan(understanding, { resolution, answers, transcript: row.transcript, source: row.source, now });
  const today = now.toISOString();
  for (const component of plan.components) {
    // تسویه سند خودش را از مسیر کارت «تسویه» می‌زند: نقد در برابر همان طلب یا بدهی.
    if (component.kind === 'settlement') {
      const side = component.direction === 'payable' ? 'payable' : 'receivable';
      component.preview = { route: ROUTES.CONFIRM, eventKind: 'obligation-settled', decisionStatus: 'decided', treatment: 'settlement',
        lines: side === 'payable'
          ? [{ role: 'payable', debit: component.amount, credit: 0 }, { role: 'cash', debit: 0, credit: component.amount }]
          : [{ role: 'cash', debit: component.amount, credit: 0 }, { role: 'receivable', debit: 0, credit: component.amount }] };
      continue;
    }
    // انتقال بین حساب‌های خودِ شرکت: نه درآمد، نه هزینه؛ سندش همان سند کارت انتقال است.
    if (component.kind === 'transfer') {
      component.preview = { route: ROUTES.CONFIRM, eventKind: 'transfer', decisionStatus: 'decided', treatment: 'account-transfer',
        lines: [{ role: 'cash', debit: component.amount, credit: 0 }, { role: 'cash', debit: 0, credit: component.amount }] };
      continue;
    }
    if (!component.item) continue;
    component.item = applyEngineAnswers(component, answers, today);
    if (component.kind === 'transfer') continue;
    let preview;
    try { [preview] = previewTransactions({ transcript: row.transcript, transactions: [component.item] }); }
    catch (error) { preview = { route: ROUTES.ACCOUNTANT_REVIEW, reasons: [error.message] }; }
    component.preview = { route: preview.route, lines: preview.lines || [], treatment: preview.treatment || null, eventKind: preview.eventKind || null, decisionStatus: preview.decisionStatus || null };
    if (preview.question && !answers[`engine.${component.id}.${preview.question.fact}`]) {
      const definition = FACT_QUESTIONS[preview.question.fact];
      plan.questions.push({
        id: `engine.${component.id}.${preview.question.fact}`, kind: 'information', text: preview.question.text,
        picker: ENGINE_PICKER[definition?.kind] || 'options',
        options: (preview.question.options || []).map((option) => ({ value: option.value, label: option.label, freeInput: Boolean(option.freeInput) })),
      });
    } else if (preview.route === ROUTES.ACCOUNTANT_REVIEW) {
      plan.reasons.push(...(preview.reasons?.length ? preview.reasons : ['موتور قاعده این جزء را به حسابدار می‌فرستد.']));
      plan.route = 'accountant';
    }
  }
  if (plan.route !== 'accountant') {
    plan.route = plan.questions.length ? 'needs-answers' : plan.components.length ? 'ready' : 'no-entry';
  }
  return { ...plan, accounts: resolution.accounts, counterparties: resolution.counterparties };
}

const STATUS_BY_ROUTE = { ready: 'ready', 'needs-answers': 'needs-answers', accountant: 'needs-accountant', 'no-entry': 'no-entry' };

function replan(id, { now } = {}) {
  const row = caseRow(id);
  const version = latestVersion(id);
  if (!row || !version) return null;
  const plan = planCase(json(version.understanding, null), json(row.answers, {}), row, now);
  db.prepare('UPDATE understanding_versions SET plan=? WHERE case_id=? AND version=?').run(JSON.stringify(plan), id, version.version);
  if (row.mode === 'active' && !['posted', 'sent-to-accountant', 'dismissed'].includes(row.status)) touch(id, { status: STATUS_BY_ROUTE[plan.route] || 'needs-accountant' });
  return plan;
}

function saveVersion(id, { understanding, violations = [], model = null, cacheHit = false, usage = {}, latencyMs = null }, trigger) {
  const next = (db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM understanding_versions WHERE case_id=?').get(id).version || 0) + 1;
  db.prepare(`INSERT INTO understanding_versions (case_id,version,understanding,violations,model,cache_hit,usage,latency_ms,trigger)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, next, JSON.stringify(understanding), JSON.stringify(violations), model, cacheHit ? 1 : 0, JSON.stringify(usage), latencyMs, trigger);
  touch(id, { version: next, error_code: null, error_message: null });
  return next;
}

/** پاسخ‌های آزادی که مدل باید با آن‌ها گفته را دوباره بخواند — فقط متن سؤال و جواب. */
function rereadAnswers(row, plan) {
  const answers = json(row.answers, {});
  return Object.entries(answers)
    .filter(([, answer]) => answer.reread)
    .map(([, answer]) => ({ question: answer.question || '', answer: String(answer.value ?? '') }));
}

async function extract(id, options = {}) {
  const row = caseRow(id);
  try {
    const result = await understandText(db, {
      text: row.transcript, rereadAnswers: rereadAnswers(row), now: options.now || new Date(), timeZone: currentTimeZone(),
    }, { fetcher: options.fetcher, env: options.env, timeoutMs: options.timeoutMs });
    saveVersion(id, result, options.trigger || 'extraction');
    return replan(id, options);
  } catch (error) {
    touch(id, { status: row.mode === 'shadow' ? 'failed' : 'failed', error_code: String(error.code || 'UNDERSTANDING_FAILED').slice(0, 60), error_message: String(error.message || '').slice(0, 300) });
    if (error.violations) db.prepare("INSERT INTO understanding_versions (case_id,version,understanding,violations,trigger) VALUES (?,?,?,?,'rejected')")
      .run(id, (db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM understanding_versions WHERE case_id=?').get(id).version || 0) + 1, 'null', JSON.stringify(error.violations));
    return null;
  }
}

// ---------------------------------------------------------------------------
// نمای پرونده
// ---------------------------------------------------------------------------

/**
 * آن‌چه رابط می‌بیند. ردیف داخلی هر جزء (با پرچم‌های موتور) بیرون نمی‌رود؛
 * فقط برچسب، مبلغ، پیش‌نمایش سند و حساب و شخصِ انتخاب‌شده.
 */
export function getUnderstandingCase(id) {
  ensureUnderstandingSchema();
  const row = caseRow(id);
  if (!row) throw fail('پرونده پیدا نشد.', 'UNDERSTANDING_CASE_MISSING', 404);
  const version = latestVersion(id);
  const understanding = version ? json(version.understanding, null) : null;
  const plan = version ? json(version.plan, null) : null;
  return {
    id: row.id, mode: row.mode, source: row.source, transcript: row.transcript, status: row.status, version: row.version,
    reasons: json(row.reasons, []), answers: json(row.answers, {}),
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    understanding: understanding ? {
      event: understanding.event, amounts: understanding.amounts, dates: understanding.dates.map(({ jalali: _j, ...date }) => date),
      counterparties: understanding.counterparties, movements: understanding.movements, subject: understanding.subject,
      conditions: understanding.conditions, nonAmountNumbers: understanding.nonAmountNumbers,
    } : null,
    violations: version ? json(version.violations, []) : [],
    plan: plan ? {
      route: plan.route, notes: plan.notes, reasons: plan.reasons, questions: plan.questions,
      components: plan.components.map((component) => ({
        id: component.id, kind: component.kind, amount: component.amount, label: component.label,
        // جهت پول یا تعهد، یک‌دست برای همهٔ انواع جزء.
        flow: component.kind === 'transfer' ? 'transfer' : component.kind === 'settlement' ? component.direction
          : component.kind === 'obligation' ? (component.item?.type === 'income' ? 'receivable' : 'payable')
            : component.item?.type === 'income' ? 'in' : 'out',
        accountId: component.item?.accountId || component.accountId || component.fromAccountId || null, toAccountId: component.toAccountId || null,
        contactId: component.item?.contactId || component.contactId || null, category: component.item?.category || null, target: component.target || null,
        occurredAt: component.item?.occurredAt || component.occurredAt || null, preview: component.preview || null,
      })),
      accounts: plan.accounts,
      counterparties: plan.counterparties,
    } : null,
    ai: version ? { model: version.model, cacheHit: Boolean(version.cache_hit), usage: json(version.usage, {}), latencyMs: version.latency_ms, trigger: version.trigger } : null,
    legacy: json(row.legacy, null), comparison: json(row.comparison, null), result: json(row.result, null),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function listUnderstandingCases({ mode = '', status = '', limit = 50 } = {}) {
  ensureUnderstandingSchema();
  const clauses = [];
  const values = [];
  if (['active', 'shadow'].includes(mode)) { clauses.push('mode=?'); values.push(mode); }
  if (STATUSES.includes(status)) { clauses.push('status=?'); values.push(status); }
  return db.prepare(`SELECT id FROM understanding_cases ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...values, Math.max(1, Math.min(200, Number(limit) || 50))).map(({ id }) => getUnderstandingCase(id));
}

// ---------------------------------------------------------------------------
// عملیات
// ---------------------------------------------------------------------------

/**
 * پروندهٔ تازه از یک گفته.
 *
 * `clientId` تکرار را بی‌اثر می‌کند: همان گفته دو بار فرستاده شود، همان پرونده
 * برمی‌گردد و درخواست دوم به مدل نمی‌رود.
 */
export async function createUnderstandingCase({ text, source = 'text', clientId = '' } = {}, options = {}) {
  ensureUnderstandingSchema();
  const transcript = String(text || '').trim().slice(0, 1500);
  if (!transcript) throw invalidInput('متن گفته خالی است.');
  const policy = automationPolicy();
  if (policy.understandingMode !== 'active') throw fail('فهم رویداد با AI در این دفتر فعال نیست.', 'UNDERSTANDING_INACTIVE');
  // بدون موتور قاعده، اجزای فهمیده‌شده ماهیت و نقشهٔ سند نمی‌گیرند و فقط به
  // نقشهٔ قدیمی «نوع تراکنش» می‌رسند؛ همان چیزی که این لایه برای حذفش آمده.
  if (!policy.engineV2) throw fail('برای فهم رویداد، موتور تصمیم (نسخهٔ ۲) باید روشن باشد.', 'UNDERSTANDING_ENGINE_OFF');
  if (!understandingProvider(options.env)) throw fail('کلید سرویس AI روی سرور تنظیم نشده است.', 'UNDERSTANDING_NOT_CONFIGURED', 503);
  const key = String(clientId || '').slice(0, 100) || null;
  const existing = key ? db.prepare('SELECT id FROM understanding_cases WHERE client_id=?').get(key) : null;
  if (existing) return getUnderstandingCase(existing.id);
  const id = `uc-${randomUUID()}`;
  db.prepare(`INSERT INTO understanding_cases (id,client_id,mode,source,transcript,status,reasons,created_by) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, key, 'active', source === 'voice' ? 'voice' : 'text', transcript, 'extracting',
      JSON.stringify(understandingReasons(transcript)), currentWorkspace()?.userId || null);
  audit('create', 'understanding-case', id, { source, reasons: understandingReasons(transcript) });
  await extract(id, options);
  return getUnderstandingCase(id);
}

export async function retryUnderstandingCase(id, options = {}) {
  ensureUnderstandingSchema();
  const row = caseRow(id);
  if (!row) throw fail('پرونده پیدا نشد.', 'UNDERSTANDING_CASE_MISSING', 404);
  if (row.status !== 'failed') throw fail('فقط پروندهٔ ناموفق دوباره خوانده می‌شود.', 'UNDERSTANDING_NOT_FAILED');
  touch(id, { status: 'extracting' });
  await extract(id, { ...options, trigger: 'retry' });
  return getUnderstandingCase(id);
}

/**
 * پاسخ ثبت‌کننده.
 *
 * هر پاسخ همان فیلد را تکمیل می‌کند و نسخهٔ تازه می‌سازد. انتخاب حساب و شخص با
 * شناسهٔ واقعی ذخیره و همین‌جا اعتبارسنجی می‌شود: حسابِ دفتر دیگر یا شخصی که
 * وجود ندارد پذیرفته نمی‌شود. فقط پاسخِ آزاد به سؤالی که نقشه نمی‌تواند خودش
 * اعمالش کند، یک خواندن دوبارهٔ گفته را با مدل لازم دارد.
 */
export async function answerUnderstandingCase(id, incoming = {}, options = {}) {
  ensureUnderstandingSchema();
  const row = caseRow(id);
  if (!row) throw fail('پرونده پیدا نشد.', 'UNDERSTANDING_CASE_MISSING', 404);
  if (row.mode !== 'active' || !['needs-answers', 'ready', 'needs-accountant', 'no-entry'].includes(row.status)) {
    throw fail('این پرونده دیگر پاسخ نمی‌گیرد.', 'UNDERSTANDING_CLOSED');
  }
  const plan = json(latestVersion(id)?.plan, null);
  const answers = json(row.answers, {});
  const open = new Map((plan?.questions || []).map((question) => [question.id, question]));
  let needsReread = false;
  for (const [field, answer] of Object.entries(incoming || {})) {
    const question = open.get(field) || (answers[field] ? { id: field, picker: answers[field].picker, text: answers[field].question } : null);
    if (!question) throw invalidInput(`سؤال «${field}» در این پرونده باز نیست.`);
    const value = answer?.value ?? null;
    const valueId = answer?.valueId ? String(answer.valueId).slice(0, 80) : null;
    if (question.picker === 'account') {
      if (!valueId || !db.prepare('SELECT 1 FROM accounts WHERE id=? AND active=1').get(valueId)) throw invalidInput('حساب انتخاب‌شده در این دفتر فعال نیست.');
    }
    if (question.picker === 'contact' && valueId !== 'new') {
      if (!valueId || !db.prepare('SELECT 1 FROM contacts WHERE id=?').get(valueId)) throw invalidInput('طرف حساب انتخاب‌شده در این دفتر نیست.');
    }
    if (question.picker === 'amount' && !(Number.isSafeInteger(Number(value)) && Number(value) > 0)) throw invalidInput('مبلغ معتبر نیست.');
    if (question.picker === 'date' && Number.isNaN(Date.parse(value))) throw invalidInput('تاریخ معتبر نیست.');
    if (question.picker === 'options' && question.options?.length && !question.options.some((option) => option.value === value)) throw invalidInput('این گزینه برای این سؤال معتبر نیست.');
    const reread = Boolean(question.needsReread);
    needsReread ||= reread && answers[field]?.value !== value;
    answers[field] = {
      value: question.picker === 'amount' ? Number(value) : value, valueId, freeText: answer?.freeText ? String(answer.freeText).slice(0, 200) : undefined,
      question: question.text, picker: question.picker, reread, answeredAt: new Date().toISOString(), by: currentWorkspace()?.userId || null,
    };
  }
  touch(id, { answers: JSON.stringify(answers) });
  audit('answer', 'understanding-case', id, { fields: Object.keys(incoming || {}) });
  if (needsReread) {
    touch(id, { status: 'extracting' });
    await extract(id, { ...options, trigger: 'answer-reread' });
  } else {
    const version = latestVersion(id);
    saveVersion(id, { understanding: json(version.understanding, null), violations: json(version.violations, []), model: version.model, cacheHit: true, usage: {}, latencyMs: 0 }, 'answer');
    replan(id, options);
  }
  return getUnderstandingCase(id);
}

/**
 * ثبت پرونده — همه یا هیچ.
 *
 * نقشه همین‌جا از نو ساخته می‌شود و فقط اگر «آماده» باشد ثبت می‌شود. هر جزء
 * از همان مسیر ثبت روزانه می‌رود؛ `client_id` و `source_event_id` ثابتِ هر جزء
 * جلوی سند دوم را می‌گیرند و وضعیتِ «ثبت‌شده» درخواست تکراری را همان نتیجهٔ قبلی
 * برمی‌گرداند.
 */
export function commitUnderstandingCase(id, { now } = {}) {
  ensureUnderstandingSchema();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = caseRow(id);
    if (!row) throw fail('پرونده پیدا نشد.', 'UNDERSTANDING_CASE_MISSING', 404);
    if (row.status === 'posted') { db.exec('COMMIT'); return getUnderstandingCase(id); }
    if (row.mode !== 'active') throw fail('پروندهٔ مقایسه‌ای (شادو) هرگز سند نمی‌سازد.', 'UNDERSTANDING_SHADOW');
    if (!['ready', 'needs-answers', 'needs-accountant', 'no-entry'].includes(row.status)) throw fail('این پرونده قابل ثبت نیست.', 'UNDERSTANDING_CLOSED');
    const version = latestVersion(id);
    const answers = json(row.answers, {});
    const plan = planCase(json(version.understanding, null), answers, row, now);
    db.prepare('UPDATE understanding_versions SET plan=? WHERE case_id=? AND version=?').run(JSON.stringify(plan), id, version.version);
    if (plan.route !== 'ready') {
      touch(id, { status: STATUS_BY_ROUTE[plan.route] || 'needs-accountant' });
      db.exec('COMMIT');
      throw fail('پرونده هنوز آمادهٔ ثبت نیست.', 'UNDERSTANDING_NOT_READY', 409, { questions: plan.questions, reasons: plan.reasons });
    }
    const results = [];
    for (const component of plan.components) {
      const clientId = `understanding:${id}:${component.id}`;
      if (component.kind === 'transfer') {
        const transfer = postAccountTransferJournal(db, {
          transferId: `${id}-${component.id}`, fromAccountId: component.fromAccountId, toAccountId: component.toAccountId,
          amount: component.amount, occurredAt: component.occurredAt || new Date().toISOString(), memo: row.transcript.slice(0, 200),
        }, { createdBy: currentWorkspace()?.userId || null, timeZone: currentTimeZone() });
        results.push({ component: component.id, kind: 'transfer', journalEntryId: transfer?.id || null });
        continue;
      }
      if (component.kind === 'settlement') {
        const settleOptions = { amount: component.amount, accountId: component.accountId, occurredAt: component.occurredAt || undefined, withinTransaction: true };
        const settled = component.target.kind === 'invoice'
          ? recordInvoicePayment(component.target.id, settleOptions)
          : settleObligation(component.target.id, settleOptions);
        if (!settled) throw fail('سند مبنای تسویه دیگر باز نیست؛ هیچ سندی ثبت نشد.', 'UNDERSTANDING_TARGET_CLOSED');
        results.push({ component: component.id, kind: 'settlement', target: component.target, transactionId: settled.transaction?.id || null, status: 'posted' });
        continue;
      }
      const item = { ...component.item, clientId };
      if (component.kind === 'obligation') {
        const opened = recordUnderstoodObligation(item, row.transcript);
        if (!opened) throw fail('ثبت تعهد بدون موتور تصمیم ممکن نیست.', 'UNDERSTANDING_ENGINE_OFF');
        results.push({ component: component.id, kind: 'obligation', obligationId: opened.obligationId, eventId: opened.id, status: opened.status, route: opened.route });
        continue;
      }
      const contactAnswer = Object.entries(answers).find(([key, answer]) => key.startsWith('counterparties.') && answer.valueId === 'new');
      const ids = insertTransactionRows({
        transcript: row.transcript, transactions: [item], fromUtterance: false,
        counterpartyResolution: contactAnswer ? 'separate' : '',
      });
      const transactionId = ids[0] || null;
      const event = transactionId ? db.prepare('SELECT id,status,route FROM financial_events WHERE source_event_id=?').get(`transaction:${transactionId}`) : null;
      results.push({ component: component.id, kind: component.kind, transactionId, eventId: event?.id || null, status: event?.status || null, route: event?.route || null });
    }
    touch(id, { status: 'posted', result: JSON.stringify({ postedAt: new Date().toISOString(), components: results }) });
    audit('commit', 'understanding-case', id, { components: results.map((item) => ({ kind: item.kind, status: item.status })) });
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* COMMIT بالا انجام شده است. */ }
    throw error;
  }
  return getUnderstandingCase(id);
}

/**
 * ارسال به صف حسابدار، با متن کامل و بدون هیچ سند یا ردیف نقدی.
 *
 * مبلغ مرجع بزرگ‌ترین مبلغِ سنجیده‌شده است و فقط برای نمایش؛ اگر هیچ مبلغی
 * سنجیده نشده بود، پرونده در صف درخواست‌های بی‌مبلغ می‌نشیند — مبلغی ساخته نمی‌شود.
 */
export function sendUnderstandingToAccountant(id) {
  ensureUnderstandingSchema();
  const row = caseRow(id);
  if (!row) throw fail('پرونده پیدا نشد.', 'UNDERSTANDING_CASE_MISSING', 404);
  if (row.status === 'sent-to-accountant') return getUnderstandingCase(id);
  if (row.mode !== 'active' || ['posted', 'dismissed'].includes(row.status)) throw fail('این پرونده قابل ارسال نیست.', 'UNDERSTANDING_CLOSED');
  const version = latestVersion(id);
  const understanding = json(version?.understanding, null);
  const plan = json(version?.plan, null);
  const amounts = (understanding?.amounts || []).filter((amount) => amount.accepted && Number.isSafeInteger(amount.value) && amount.value > 0).map((amount) => amount.value);
  const summary = [...(plan?.reasons || []), ...(plan?.notes || []).map((note) => note.text)].join(' ').slice(0, 300) || 'پروندهٔ فهم رویداد برای قضاوت حسابدار';
  let ref;
  if (amounts.length) {
    const event = normalizeFinancialEvent({
      kind: EVENT_KINDS.REVIEW_PLACEHOLDER, amount: Math.max(...amounts), amountReferenceOnly: true, occurredAt: new Date().toISOString(),
      source: row.source === 'voice' ? 'voice' : 'text', evidence: row.transcript, utterance: row.transcript, description: summary,
    });
    const recorded = recordFinancialEvent(db, event, {
      sourceEventId: `understanding:${id}`,
      decision: { route: ROUTES.ACCOUNTANT_REVIEW, guardBlocked: true, reasons: plan?.reasons?.length ? plan.reasons : [summary], summary },
      actor: currentWorkspace()?.userId || null, transcript: row.transcript, rawInput: row.transcript, timeZone: currentTimeZone(),
    });
    ref = `event:${recorded.id}`;
  } else {
    ref = `intake:${queueUnderstoodIntake(row.transcript, { clientId: `understanding:${id}`, source: row.source }).id}`;
  }
  touch(id, { status: 'sent-to-accountant', review_ref: ref });
  audit('send', 'understanding-case', id, { ref });
  return getUnderstandingCase(id);
}

export function dismissUnderstandingCase(id) {
  ensureUnderstandingSchema();
  const row = caseRow(id);
  if (!row) throw fail('پرونده پیدا نشد.', 'UNDERSTANDING_CASE_MISSING', 404);
  if (['posted', 'sent-to-accountant'].includes(row.status)) throw fail('پروندهٔ ثبت‌شده یا ارسال‌شده کنار گذاشته نمی‌شود.', 'UNDERSTANDING_CLOSED');
  touch(id, { status: 'dismissed' });
  audit('dismiss', 'understanding-case', id, {});
  return getUnderstandingCase(id);
}

// ---------------------------------------------------------------------------
// حالت مقایسه‌ای (شادو)
// ---------------------------------------------------------------------------

/**
 * آن‌چه مسیر قدیمی با همین گفته کرد، در قالبی قابل مقایسه.
 *
 * `kind`: `transactions` (ردیف ساخته شد)، `composite-review` یا
 * `unquantified-review` (به حسابدار رفت).
 */
export function legacySnapshot(kind, { ids = [], queued = 0 } = {}) {
  const rows = ids.map((transactionId) => {
    const row = db.prepare('SELECT amount,type,category,account_id AS accountId FROM transactions WHERE id=?').get(transactionId);
    const event = db.prepare('SELECT status,route FROM financial_events WHERE source_event_id=?').get(`transaction:${transactionId}`);
    return row ? { transactionId, ...row, status: event?.status || null, route: event?.route || null } : null;
  }).filter(Boolean);
  return { kind, rows, queued };
}

/** مقایسهٔ آن‌چه مسیر قدیمی کرد با آن‌چه نقشهٔ تازه می‌کرد. */
export function compareWithLegacy(legacy, plan) {
  const legacyAmounts = (legacy?.rows || []).map((row) => row.amount).sort((a, b) => a - b);
  const newAmounts = (plan?.components || []).map((component) => component.amount).sort((a, b) => a - b);
  const legacyToAccountant = ['composite-review', 'unquantified-review'].includes(legacy?.kind)
    || (legacy?.rows || []).some((row) => row.route === ROUTES.ACCOUNTANT_REVIEW) || Number(legacy?.queued || 0) > 0;
  const flags = [];
  if (JSON.stringify(legacyAmounts) !== JSON.stringify(newAmounts)) flags.push('amounts-differ');
  if (legacyAmounts.length > newAmounts.length) flags.push('legacy-more-rows');
  if (legacyAmounts.length < newAmounts.length) flags.push('new-more-rows');
  const legacyTypes = (legacy?.rows || []).map((row) => row.type).sort().join(',');
  const newTypes = (plan?.components || []).map((component) => component.preview?.eventKind || component.kind).sort().join(',');
  if (legacyToAccountant && plan?.route !== 'accountant') flags.push('new-avoids-accountant');
  if (!legacyToAccountant && plan?.route === 'accountant') flags.push('new-sends-to-accountant');
  if (plan?.route === 'needs-answers') flags.push('new-asks');
  return {
    agree: !flags.some((flag) => ['amounts-differ', 'new-sends-to-accountant', 'new-avoids-accountant'].includes(flag)),
    flags, legacyAmounts, newAmounts, legacyTypes, newTypes, newRoute: plan?.route || null, legacyToAccountant,
  };
}

/**
 * پروندهٔ شادو برای گفته‌ای که مسیر قدیمی همین حالا ثبت کرد.
 *
 * پاسخ کاربر منتظرِ این نمی‌ماند: استخراج در پس‌زمینه اجرا می‌شود و شکستش فقط
 * در خود پرونده ثبت می‌شود. هیچ سندی، ردیفی یا صفی از این مسیر ساخته نمی‌شود.
 */
export function scheduleShadowUnderstanding({ text, source = 'text', legacy = null, clientId = '' } = {}, options = {}) {
  ensureUnderstandingSchema();
  const policy = automationPolicy();
  const transcript = String(text || '').trim().slice(0, 1500);
  if (policy.understandingMode !== 'shadow' || !transcript || !inUnderstandingScope(transcript, policy.understandingScope)) return null;
  if (!understandingProvider(options.env)) return null;
  const key = `shadow:${clientId || createHash('sha256').update(transcript + Date.now()).digest('hex').slice(0, 24)}`.slice(0, 100);
  if (db.prepare('SELECT 1 FROM understanding_cases WHERE client_id=?').get(key)) return null;
  const id = `uc-${randomUUID()}`;
  db.prepare(`INSERT INTO understanding_cases (id,client_id,mode,source,transcript,status,reasons,legacy,created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, key, 'shadow', source === 'voice' ? 'voice' : 'text', transcript, 'extracting', JSON.stringify(understandingReasons(transcript)), JSON.stringify(legacy), currentWorkspace()?.userId || null);
  const done = (async () => {
    const plan = await extract(id, { ...options, trigger: 'shadow' });
    // وضعیتِ شادو همان مسیرِ پیشنهادی است، ولی هیچ عملیاتی پشتش نیست.
    if (plan) touch(id, { status: STATUS_BY_ROUTE[plan.route] || 'needs-accountant', comparison: JSON.stringify(compareWithLegacy(legacy, plan)) });
    return id;
  })().catch(() => id);
  return { id, done };
}

/** جمع‌بندی حالت مقایسه‌ای برای تصمیم فعال‌سازی. */
export function understandingReport() {
  ensureUnderstandingSchema();
  const rows = db.prepare("SELECT * FROM understanding_cases WHERE mode='shadow' ORDER BY created_at DESC LIMIT 1000").all();
  const versions = db.prepare(`SELECT v.* FROM understanding_versions v JOIN understanding_cases c ON c.id=v.case_id WHERE c.mode='shadow'`).all();
  const count = (predicate) => rows.filter(predicate).length;
  const comparisons = rows.map((row) => json(row.comparison, null)).filter(Boolean);
  const flagCounts = {};
  for (const comparison of comparisons) for (const flag of comparison.flags) flagCounts[flag] = (flagCounts[flag] || 0) + 1;
  const calls = versions.filter((version) => !version.cache_hit && version.model);
  const latencies = calls.map((version) => Number(version.latency_ms)).filter(Number.isFinite).sort((a, b) => a - b);
  const usage = calls.map((version) => json(version.usage, {}));
  return {
    total: rows.length,
    failed: count((row) => row.status === 'failed'),
    compared: comparisons.length,
    agree: comparisons.filter((item) => item.agree).length,
    flags: flagCounts,
    routes: Object.fromEntries(['ready', 'needs-answers', 'needs-accountant', 'no-entry', 'failed'].map((status) => [status, count((row) => row.status === status)])),
    legacyToAccountant: comparisons.filter((item) => item.legacyToAccountant).length,
    wouldAvoidAccountant: comparisons.filter((item) => item.legacyToAccountant && ['ready', 'needs-answers'].includes(item.newRoute)).length,
    aiCalls: calls.length,
    cacheHits: versions.filter((version) => version.cache_hit).length,
    latencyMs: latencies.length ? { median: latencies[Math.floor(latencies.length / 2)], max: latencies.at(-1) } : null,
    tokens: { input: usage.reduce((sum, item) => sum + (Number(item.inputTokens) || 0), 0), output: usage.reduce((sum, item) => sum + (Number(item.outputTokens) || 0), 0) },
  };
}
