import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

const databasePath = tempDatabase('shadow');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'shadow-owner';
process.env.ADMIN_PASSWORD = `shadow-${crypto.randomUUID()}`;

const database = await import(`../server/db.js?shadow=${process.pid}`);
const accounting = await import(`../server/accounting.js?shadow=${process.pid}`);
const store = await import(`../server/financialEventStore.js?shadow=${process.pid}`);
const { DIFFERENCE_SEVERITY, compareProposalWithActual, summarizeDisagreements } = await import('../shared/shadowReport.js');
const { normalizeFinancialEvent } = await import('../shared/financialEvent.js');
const { routeEvent } = await import('../shared/confidenceEngine.js');
const { transactionEventDecision } = await import(`../server/transactionEvent.js?shadow=${process.pid}`);

database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
// رویدادهای ساختگی بی‌موجودیِ پیشین سند می‌خورند؛ نگهبان صندوق با تأیید صریح آزمون، نه خاموش.
const inPrimary = (callback) => database.runInWorkspace('primary', { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const OCCURRED = '2026-09-24T09:00:00.000Z';

/**
 * شادو مود — موتور نظر می‌دهد، دفتر دست نمی‌خورد.
 *
 * این تنها راهی است که می‌شود موتور را روی دفتر واقعی روشن کرد بدون هیچ
 * ریسکی. بدون آن، اولین دادهٔ واقعیِ اختلاف وقتی می‌رسد که همهٔ فازها ساخته
 * شده‌اند و هزینهٔ اصلاح برابر بازسازی است.
 *
 * شرط پذیرشش یک جمله است: **اجرای یک دستهٔ کامل، دفتر را بیت‌به‌بیت دست‌نخورده
 * می‌گذارد.**
 */

const transaction = (extra = {}) => ({
  type: 'expense', amount: 12_000_000, occurredAt: OCCURRED, accountId: 'bank-mellat',
  category: 'بیمه', source: 'voice', rawText: 'حق بیمه یک‌ساله دادم', ...extra,
});

const ledgerSnapshot = () => JSON.stringify(accounting.listJournal(db(), { limit: 500 }).items);

// ---------------------------------------------------------------------------
// مقایسه — تابع خالص
// ---------------------------------------------------------------------------

const plan = (roles, amount = 12_000_000) => ({
  lines: roles.map((role, index) => ({ role, debit: index === 0 ? amount : 0, credit: index === 0 ? 0 : amount })),
});

test('نقشهٔ یکسان، اختلافی ندارد', () => {
  const differences = compareProposalWithActual(
    { plan: plan(['prepaid-asset', 'cash']), amount: 12_000_000 },
    { plan: plan(['prepaid-asset', 'cash']), amount: 12_000_000 },
  );
  assert.deepEqual(differences, []);
});

test('هزینه در برابر دارایی، اختلاف بحرانی است', () => {
  // این همان خطایی است که کل پروژه برایش نوشته شده: یکی سود دوره را تکان
  // می‌دهد و دیگری نه.
  const differences = compareProposalWithActual(
    { plan: plan(['prepaid-asset', 'cash']), amount: 12_000_000 },
    { plan: plan(['expense-category', 'cash']), amount: 12_000_000 },
  );
  assert.ok(differences.some((item) => item.severity === DIFFERENCE_SEVERITY.CRITICAL));
});

test('مبلغ متفاوت همیشه بحرانی است', () => {
  const differences = compareProposalWithActual(
    { plan: plan(['expense-category', 'cash'], 12_000_000), amount: 12_000_000 },
    { plan: plan(['expense-category', 'cash'], 11_000_000), amount: 11_000_000 },
  );
  assert.equal(differences[0].severity, DIFFERENCE_SEVERITY.CRITICAL);
});

test('اختلاف حسابِ بدون اثر سود و زیانی، مهم است نه بحرانی', () => {
  const differences = compareProposalWithActual(
    { plan: plan(['receivable', 'cash']), amount: 12_000_000 },
    { plan: plan(['cheque-receivable', 'cash']), amount: 12_000_000 },
  );
  assert.equal(differences[0].severity, DIFFERENCE_SEVERITY.MATERIAL);
});

test('خلاصه، اختلاف‌ها را خانواده‌به‌خانواده می‌شمارد', () => {
  const summary = summarizeDisagreements([
    { family: 'asset-creation', differences: [{ severity: DIFFERENCE_SEVERITY.CRITICAL, field: 'accounts' }] },
    { family: 'asset-creation', differences: [] },
    { family: 'internal-transfer', differences: [{ severity: DIFFERENCE_SEVERITY.MATERIAL, field: 'accounts' }] },
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.agreed, 1);
  assert.equal(summary.byFamily['asset-creation'].critical, 1);
  assert.equal(summary.byFamily['internal-transfer'].material, 1);
});

// ---------------------------------------------------------------------------
// شرط پذیرش: دفتر دست نمی‌خورد
// ---------------------------------------------------------------------------

test('آماده‌سازی: یک ثبت عادی تا دفتر خالی نماند', () => {
  inPrimary(() => {
    store.recordFinancialEvent(db(), normalizeFinancialEvent({
      kind: 'cash-expense', amount: 1_000_000, occurredAt: OCCURRED, category: 'اجاره', accountId: 'cash',
    }), {
      sourceEventId: 'seed:1',
      decision: routeEvent({ kind: 'cash-expense' }, { components: { amountCertainty: 0.99, moneyDirectionCertainty: 0.99, completeness: 0.98 } }),
      actor: owner.id,
    });
    assert.ok(accounting.listJournal(db(), { limit: 500 }).items.length > 0);
  });
});

test('یک دستهٔ کامل شادو، دفتر را بیت‌به‌بیت دست‌نخورده می‌گذارد', () => {
  inPrimary(() => {
    const before = ledgerSnapshot();
    for (let index = 0; index < 5; index += 1) {
      const draft = transactionEventDecision(transaction({ amount: 12_000_000 + index }), { policy: { engineV2: true, shadowMode: true } });
      store.recordShadowRun(db(), {
        event: draft.event, decision: draft.accountingDecision, confidence: draft.decision,
        sourceEventId: `shadow:${index}`,
      });
    }
    assert.equal(ledgerSnapshot(), before, 'دفتر نباید یک بیت هم عوض شود');
    assert.equal(store.shadowRuns(db()).length, 5, 'ولی هر پنج تصمیم باید ثبت شده باشند');
  });
});

test('ردیف شادو همه‌چیزِ لازم برای گزارش اختلاف را دارد', () => {
  inPrimary(() => {
    const [run] = store.shadowRuns(db());
    assert.ok(run.family, 'خانواده');
    assert.ok(run.decisionStatus, 'وضعیت تصمیم');
    assert.ok(Array.isArray(run.guards), 'نتیجهٔ نگهبان‌ها');
    assert.ok(run.proposedPlan, 'سند پیشنهادی');
    assert.ok(run.question || run.decisionStatus !== 'needs-user-input', 'سؤالی که پرسیده می‌شد');
  });
});

test('اجرای دوبارهٔ همان دسته، ردیف دوم نمی‌سازد', () => {
  inPrimary(() => {
    const before = store.shadowRuns(db()).length;
    const draft = transactionEventDecision(transaction(), { policy: { engineV2: true, shadowMode: true } });
    store.recordShadowRun(db(), {
      event: draft.event, decision: draft.accountingDecision, confidence: draft.decision, sourceEventId: 'shadow:0',
    });
    assert.equal(store.shadowRuns(db()).length, before, 'همان شناسهٔ منبع، همان ردیف');
  });
});

test('ثبت واقعیِ حسابدار روی همان ردیف می‌نشیند', () => {
  inPrimary(() => {
    const [run] = store.shadowRuns(db());
    store.attachActualToShadowRun(db(), run.sourceEventId, {
      lines: [{ role: 'expense-category', debit: 12_000_000, credit: 0 }, { role: 'cash', debit: 0, credit: 12_000_000 }],
      amount: 12_000_000,
    });
    const updated = store.shadowRuns(db()).find((item) => item.sourceEventId === run.sourceEventId);
    assert.ok(updated.actualPlan, 'ثبت واقعی باید ذخیره شود');
    assert.ok(updated.differences.length > 0, 'و اختلافش محاسبه شود');
  });
});

test('در شادو مود، موتور روی ثبت اثر نمی‌گذارد', () => {
  // این همان وعده‌ای است که روی دکمه نوشته شده: «دفتر دست نمی‌خورد».
  // تصمیم ضبط می‌شود ولی به لایهٔ ثبت پاس داده نمی‌شود، وگرنه نگهبان‌ها و
  // نقشهٔ موتور سند را عوض می‌کنند و شادو مود فقط یک لایهٔ ضبط روی موتورِ
  // فعال می‌شد — چیزی که هیچ‌کس نمی‌تواند بی‌ریسک روشنش کند.
  const { automationPolicy, saveAutomationPolicy, insertTransactions, listTransactions } = database;
  inPrimary(() => {
    saveAutomationPolicy({ ...automationPolicy(), engineV2: true, shadowMode: true });

    const before = ledgerSnapshot();
    insertTransactions({
      transcript: 'حق بیمه یک‌ساله دوازده میلیون از بانک ملت دادم',
      transactions: [{
        amount: 12_000_000, type: 'expense', category: 'بیمه', source: 'voice',
        occurredAt: OCCURRED, rawText: 'حق بیمه یک‌ساله دوازده میلیون از بانک ملت دادم',
      }],
    });

    // ثبت کاربر باید انجام شده باشد — شادو مود ثبت را متوقف نمی‌کند.
    assert.ok(listTransactions({ limit: 50 }).items.some((item) => item.amount === 12_000_000), 'تراکنش باید ثبت شود');
    // تصمیم باید ضبط شده باشد — شادو مود کارش همین است.
    assert.ok(store.shadowRuns(db()).some((run) => run.amount === 12_000_000), 'تصمیم باید ضبط شود');

    // ولی سند نباید شکل موتور را گرفته باشد: پیش از این تغییر، همین ثبت به
    // حساب پیش‌پرداخت می‌رفت. اینکه سند همین حالا خورده یا منتظر تأیید مانده،
    // به آستانهٔ اطمینان بستگی دارد و ربطی به شادو مود ندارد.
    const entries = accounting.listJournal(db(), { limit: 50 }).items;
    const names = entries.flatMap((entry) => entry.lines.map((line) => line.accountName || ''));
    assert.equal(names.some((name) => String(name).includes('پیش‌پرداخت')), false, 'نقشهٔ موتور نباید اجرا شده باشد');

    saveAutomationPolicy({ ...automationPolicy(), engineV2: false, shadowMode: false });
  });
});
