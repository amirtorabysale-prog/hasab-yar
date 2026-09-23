import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('decision-wiring');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'decision-owner';
process.env.ADMIN_PASSWORD = `decision-${crypto.randomUUID()}`;

const database = await import(`../server/db.js?decision=${process.pid}`);
const accounting = await import(`../server/accounting.js?decision=${process.pid}`);
const store = await import(`../server/financialEventStore.js?decision=${process.pid}`);
const { EVENT_KINDS, normalizeFinancialEvent } = await import('../shared/financialEvent.js');
const { ROUTES, routeEvent } = await import('../shared/confidenceEngine.js');
const { transactionEventDecision } = await import(`../server/transactionEvent.js?decision=${process.pid}`);
const { DECISION_STATUS, decide } = await import('../shared/accountingDecision.js');
const { ECONOMIC_FAMILIES } = await import('../shared/economicFamily.js');
const { factsFromEvent } = await import('../shared/eventFacts.js');

database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const inPrimary = (callback) => database.runInWorkspace('primary', { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const OCCURRED = '2026-09-23T00:00:00.000Z';
const event = (extra) => normalizeFinancialEvent({ amount: 5_000_000, occurredAt: OCCURRED, source: 'voice', ...extra });
const confident = (kind) => routeEvent({ kind }, {
  components: { amountCertainty: 0.99, moneyDirectionCertainty: 0.99, dateCertainty: 0.99, completeness: 0.98 },
});

const transaction = (extra = {}) => ({
  type: 'expense', amount: 120_000_000, occurredAt: OCCURRED, accountId: 'bank-mellat',
  category: 'بیمه', source: 'voice', rawText: 'حق بیمه یک‌ساله را از بانک ملت پرداخت کردم', ...extra,
});

// ---------------------------------------------------------------------------
// فلگ خاموش — هیچ چیز عوض نمی‌شود
// ---------------------------------------------------------------------------

test('با فلگ خاموش، هیچ تصمیمی ساخته نمی‌شود', () => {
  const draft = transactionEventDecision(transaction(), { policy: {} });
  assert.equal(draft.accountingDecision, null, 'موتور خاموش نباید تصمیم بسازد');
  assert.equal(draft.decision.route, ROUTES.AUTO, 'مسیر باید همان قبلی بماند');
});

test('با فلگ خاموش، رویداد بدون ردیف تصمیم ثبت می‌شود', () => {
  inPrimary(() => {
    const result = store.recordFinancialEvent(db(), event({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره' }), {
      sourceEventId: 'off:1', decision: confident(EVENT_KINDS.CASH_EXPENSE), actor: owner.id,
    });
    assert.equal(result.status, 'posted');
    assert.equal(store.decisionForEvent(db(), result.id), null, 'ردیف تصمیم نباید ساخته شود');
  });
});

// ---------------------------------------------------------------------------
// فلگ روشن — ماهیت سنجیده می‌شود
// ---------------------------------------------------------------------------

test('با فلگ روشن، پیش‌پرداخت بدون دورهٔ پوشش خودکار ثبت نمی‌شود', () => {
  // همان ایرادی که مدیر دفتر گرفت: مبلغ و تاریخ و بانک قطعی‌اند، ولی این پول
  // روی چند ماه پخش می‌شود و هیچ‌کس نمی‌داند چند ماه.
  const draft = transactionEventDecision(transaction(), { policy: { engineV2: true } });

  assert.equal(draft.accountingDecision.family, ECONOMIC_FAMILIES.ASSET_CREATION);
  assert.equal(draft.accountingDecision.decisionStatus, DECISION_STATUS.NEEDS_USER_INPUT);
  assert.notEqual(draft.decision.route, ROUTES.AUTO, 'ثبت بی‌پرسش نباید اجازه داشته باشد');
  assert.ok(draft.decision.reasons.some((reason) => reason.includes('دورهٔ پوشش')), 'دلیل باید همان سؤال باشد');
});

test('اطمینان کامل، جای واقعیت مفقود را نمی‌گیرد', () => {
  const draft = transactionEventDecision(transaction({
    confidenceDetails: { amount: { score: 1, reason: '' }, type: { score: 1, reason: '' }, category: { score: 1, reason: '' }, account: { score: 1, reason: '' } },
  }), { policy: { engineV2: true } });
  assert.notEqual(draft.decision.route, ROUTES.AUTO);
});

test('با فلگ روشن، تصمیم کنار رویداد ذخیره می‌شود', () => {
  inPrimary(() => {
    const draft = transactionEventDecision(transaction(), { policy: { engineV2: true } });
    const result = store.recordFinancialEvent(db(), draft.event, {
      sourceEventId: 'on:1', decision: draft.decision, actor: owner.id, accountingDecision: draft.accountingDecision,
    });
    const stored = store.decisionForEvent(db(), result.id);
    assert.ok(stored, 'تصمیم باید ذخیره شود');
    assert.equal(stored.family, ECONOMIC_FAMILIES.ASSET_CREATION);
    assert.equal(stored.decisionStatus, DECISION_STATUS.NEEDS_USER_INPUT);
    assert.ok(stored.missingFacts.includes('servicePeriodStart'));
    assert.ok(stored.question?.options?.length, 'سؤال گزینه‌دار باید ذخیره شود');
    assert.equal(result.decisionId, stored.id);
  });
});

test('تصمیمی که اجازهٔ ثبت نمی‌دهد هم ذخیره می‌شود', () => {
  // این عمدی است: گزارش اختلاف فاز بعد باید بداند موتور چه گفت، حتی وقتی
  // موتور اجازهٔ عمل نداشت.
  inPrimary(() => {
    const draft = transactionEventDecision(transaction({ category: 'پذیرایی', amount: 2_000_000 }), { policy: { engineV2: true } });
    const result = store.recordFinancialEvent(db(), draft.event, {
      sourceEventId: 'on:2', decision: draft.decision, actor: owner.id, accountingDecision: draft.accountingDecision,
    });
    const stored = store.decisionForEvent(db(), result.id);
    assert.ok(stored, 'تصمیم باید ذخیره شود حتی وقتی سند نمی‌سازد');
    assert.equal(stored.decisionStatus, DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW);
  });
});

test('رویدادی که خودش دورهٔ پوشش دارد، ماهیتش قطعی می‌شود', () => {
  // مسیر تراکنش هنوز راهی برای حمل دورهٔ پوشش ندارد — آن کارِ روز بعد است،
  // وقتی جواب سؤال روی رویداد می‌نشیند. ولی خودِ رویداد از امروز جا برایش
  // دارد، و این تست همان را اثبات می‌کند.
  const withPeriod = normalizeFinancialEvent({
    kind: EVENT_KINDS.CASH_EXPENSE, amount: 120_000_000, occurredAt: OCCURRED,
    category: 'بیمه', accountId: 'bank-mellat',
    servicePeriodStart: OCCURRED, servicePeriodEnd: '2027-09-22T00:00:00.000Z',
  });
  assert.equal(withPeriod.servicePeriodStart, OCCURRED, 'رویداد باید دوره را نگه دارد');

  const decision = decide(factsFromEvent(withPeriod), { today: OCCURRED });
  assert.equal(decision.decisionStatus, DECISION_STATUS.DECIDED);
  assert.equal(decision.treatment, 'prepaid-expense');
  assert.ok(decision.policyVersion, 'تصمیم بدون نسخهٔ قاعده ساخته نمی‌شود');
});

test('واقعیت‌های تازهٔ رویداد، رویداد قدیمی را نامعتبر نمی‌کنند', () => {
  // مهاجرت افزایشی: رویدادی که هیچ‌کدام از فیلدهای تازه را ندارد باید همچنان
  // معتبر بماند و `null` بگیرد، نه اینکه نرمال‌سازی بشکند.
  const plain = normalizeFinancialEvent({ kind: EVENT_KINDS.CASH_EXPENSE, amount: 1_000_000, occurredAt: OCCURRED, category: 'اجاره' });
  assert.equal(plain.servicePeriodStart, null);
  assert.equal(plain.refundable, null, 'پرسیده‌نشده با «نه» یکی نیست');
  assert.equal(plain.intendedUse, null);
});

// ---------------------------------------------------------------------------
// قفل شدن نقشهٔ سند
// ---------------------------------------------------------------------------

test('نقشهٔ سند در لحظهٔ ثبت قفل می‌شود', () => {
  inPrimary(() => {
    const result = store.recordFinancialEvent(db(), event({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره' }), {
      sourceEventId: 'lock:1', decision: routeEvent({ kind: EVENT_KINDS.CASH_EXPENSE }, { blockers: ['تأیید لازم است'] }), actor: owner.id,
    });
    assert.equal(result.status, 'pending');
    const row = db().prepare('SELECT posting_plan FROM financial_events WHERE id=?').get(result.id);
    assert.ok(row.posting_plan, 'نقشه باید در لحظهٔ ثبت ذخیره شود');
    assert.equal(JSON.parse(row.posting_plan).lines.length, 2);
  });
});

test('تأیید از نقشهٔ قفل‌شده استفاده می‌کند، نه از کدِ امروز', () => {
  // شبیه‌سازی تغییر قاعده: نقشهٔ ذخیره‌شده دستی عوض می‌شود. اگر تأیید دوباره
  // محاسبه کند، مبلغ عوض‌شده نادیده گرفته می‌شود و این تست می‌شکند.
  inPrimary(() => {
    const result = store.recordFinancialEvent(db(), event({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره', amount: 4_000_000 }), {
      sourceEventId: 'lock:2', decision: routeEvent({ kind: EVENT_KINDS.CASH_EXPENSE }, { blockers: ['تأیید لازم است'] }), actor: owner.id,
    });
    const plan = JSON.parse(db().prepare('SELECT posting_plan FROM financial_events WHERE id=?').get(result.id).posting_plan);
    plan.lines = plan.lines.map((line) => ({ ...line, debit: line.debit ? 1_234_000 : 0, credit: line.credit ? 1_234_000 : 0 }));
    db().prepare('UPDATE financial_events SET posting_plan=? WHERE id=?').run(JSON.stringify(plan), result.id);

    const approved = store.approveFinancialEvent(db(), result.id, { actor: owner.id });
    assert.equal(approved.status, 'posted');
    const entry = accounting.listJournal(db(), { limit: 200 }).items.find((item) => item.id === approved.journalEntryId);
    assert.ok(entry, 'سند باید ساخته شده باشد');
    assert.equal(entry.lines.reduce((sum, line) => sum + line.debit, 0), 1_234_000, 'نقشهٔ قفل‌شده باید ثبت شود');
  });
});

test('ردپا می‌گوید نقشه قفل‌شده بود یا دوباره محاسبه شد', () => {
  inPrimary(() => {
    const result = store.recordFinancialEvent(db(), event({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره' }), {
      sourceEventId: 'lock:3', decision: routeEvent({ kind: EVENT_KINDS.CASH_EXPENSE }, { blockers: ['تأیید لازم است'] }), actor: owner.id,
    });
    store.approveFinancialEvent(db(), result.id, { actor: owner.id });
    const approved = store.financialEventAudit(db(), result.id).find((row) => row.stage === 'approved');
    assert.equal(approved.detail.planSource, 'locked-at-capture');
  });
});

test('رویداد قدیمیِ بدون نقشهٔ ذخیره‌شده همچنان تأیید می‌شود', () => {
  // مهاجرت باید برگشت‌پذیر باشد: ردیفی که پیش از این تغییر ثبت شده نقشه ندارد
  // و نباید هنگام تأیید بشکند.
  inPrimary(() => {
    const result = store.recordFinancialEvent(db(), event({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره' }), {
      sourceEventId: 'lock:4', decision: routeEvent({ kind: EVENT_KINDS.CASH_EXPENSE }, { blockers: ['تأیید لازم است'] }), actor: owner.id,
    });
    db().prepare('UPDATE financial_events SET posting_plan=NULL WHERE id=?').run(result.id);
    const approved = store.approveFinancialEvent(db(), result.id, { actor: owner.id });
    assert.equal(approved.status, 'posted');
    const audit = store.financialEventAudit(db(), result.id).find((row) => row.stage === 'approved');
    assert.equal(audit.detail.planSource, 'recomputed-legacy', 'ردپا باید این دو دسته را از هم جدا کند');
  });
});
