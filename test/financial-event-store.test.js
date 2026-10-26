import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

const databasePath = tempDatabase('event-store');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'event-owner';
process.env.ADMIN_PASSWORD = `event-${crypto.randomUUID()}`;

const database = await import(`../server/db.js?events=${process.pid}`);
const accounting = await import(`../server/accounting.js?events=${process.pid}`);
const store = await import(`../server/financialEventStore.js?events=${process.pid}`);
const { EVENT_KINDS, normalizeFinancialEvent } = await import('../shared/financialEvent.js');
const { ROUTES, routeEvent } = await import('../shared/confidenceEngine.js');

database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
// رویدادهای ساختگی بی‌موجودیِ پیشین سند می‌خورند؛ نگهبان صندوق با تأیید صریح آزمون، نه خاموش.
const inPrimary = (callback) => database.runInWorkspace('primary', { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const event = (extra) => normalizeFinancialEvent({
  amount: 5_000_000, occurredAt: new Date().toISOString(), source: 'voice', ...extra,
});
const confident = (kind) => routeEvent({ kind }, {
  components: { amountCertainty: 0.99, moneyDirectionCertainty: 0.99, dateCertainty: 0.99, completeness: 0.98 },
});

test('رویداد با اطمینان بالا خودکار سند می‌خورد و دفتر متوازن می‌ماند', () => {
  inPrimary(() => {
    const result = store.recordFinancialEvent(db(), event({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره' }), {
      sourceEventId: 'voice:auto-1', decision: confident(EVENT_KINDS.CASH_EXPENSE), actor: owner.id, transcript: 'پنج میلیون اجاره دادم',
    });
    assert.equal(result.route, ROUTES.AUTO);
    assert.equal(result.status, 'posted');
    assert.ok(result.journalEntryId);
    const trial = accounting.trialBalance(db());
    assert.equal(trial.totals.debit, trial.totals.credit);
  });
});

// کاربر دکمه را دوبار می‌زند، شبکه قطع می‌شود، صف آفلاین دوباره می‌فرستد —
// همه‌شان واقعی‌اند و هیچ‌کدام نباید سند دوم بسازند.
test('ثبت تکراری یک sourceEvent ممنوع است', () => {
  inPrimary(() => {
    const before = accounting.listJournal(db(), { limit: 200 }).items.length;
    const again = store.recordFinancialEvent(db(), event({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره' }), {
      sourceEventId: 'voice:auto-1', decision: confident(EVENT_KINDS.CASH_EXPENSE), actor: owner.id,
    });
    assert.equal(again.duplicate, true);
    assert.equal(accounting.listJournal(db(), { limit: 200 }).items.length, before, 'سند دوم نباید ساخته شود');
  });
});

test('شناسهٔ منبع اجباری است', () => {
  inPrimary(() => {
    assert.throws(
      () => store.recordFinancialEvent(db(), event({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره' }), { decision: confident(EVENT_KINDS.CASH_EXPENSE) }),
      (error) => error.code === 'EVENT_SOURCE_MISSING',
    );
  });
});

test('هر سندِ ساخته‌شده از رویداد متوازن است', () => {
  inPrimary(() => {
    const samples = [
      [EVENT_KINDS.CASH_INCOME, { category: 'فروش' }],
      [EVENT_KINDS.RECEIVABLE_OPENED, { counterparty: 'حسن', category: 'فروش' }],
      [EVENT_KINDS.PAYABLE_OPENED, { counterparty: 'پارس', category: 'مواد و کالا' }],
      [EVENT_KINDS.CHEQUE_RECEIVED, { counterparty: 'حسن' }],
      [EVENT_KINDS.CHEQUE_ISSUED, { counterparty: 'پارس' }],
    ];
    for (const [kind, extra] of samples) {
      store.recordFinancialEvent(db(), event({ kind, ...extra }), {
        sourceEventId: `voice:balanced-${kind}`, decision: confident(kind), actor: owner.id,
      });
    }
    const trial = accounting.trialBalance(db());
    assert.equal(trial.totals.debit, trial.totals.credit);
  });
});

test('رویداد کم‌اطمینان به صف بررسی می‌رود و سند نمی‌خورد', () => {
  inPrimary(() => {
    const decision = routeEvent({ kind: EVENT_KINDS.CASH_EXPENSE }, {
      components: { amountCertainty: 0.4, moneyDirectionCertainty: 0.5, dateCertainty: 0.6 },
    });
    assert.equal(decision.route, ROUTES.ACCOUNTANT_REVIEW);
    const result = store.recordFinancialEvent(db(), event({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'سایر هزینه‌ها' }), {
      sourceEventId: 'voice:low-1', decision, actor: owner.id,
    });
    assert.equal(result.status, 'pending');
    assert.equal(result.journalEntryId, null);
    assert.ok(store.listReviewQueue(db()).some((item) => item.sourceEventId === 'voice:low-1'));
  });
});

test('تأیید حسابدار رویداد منتظر را به سند تبدیل می‌کند', () => {
  inPrimary(() => {
    const pending = store.listReviewQueue(db()).find((item) => item.sourceEventId === 'voice:low-1');
    const approved = store.approveFinancialEvent(db(), pending.id, { actor: owner.id });
    assert.equal(approved.status, 'posted');
    assert.ok(approved.journalEntryId);
    const trial = accounting.trialBalance(db());
    assert.equal(trial.totals.debit, trial.totals.credit);
  });
});

// حذف، زنجیرهٔ حسابرسی را پاک می‌کند و هیچ راهی برای بازسازی‌اش نمی‌ماند.
test('برگشت، تاریخچه را پاک نمی‌کند', () => {
  inPrimary(() => {
    const posted = store.recordFinancialEvent(db(), event({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'قبوض' }), {
      sourceEventId: 'voice:reverse-1', decision: confident(EVENT_KINDS.CASH_EXPENSE), actor: owner.id,
    });
    const reversed = store.reverseFinancialEvent(db(), posted.id, { actor: owner.id, reason: 'اشتباه ثبت شد' });
    assert.equal(reversed.status, 'reversed');

    // سند اصلی باید هنوز در دفتر باشد، کنار سند معکوسش.
    const entries = accounting.listJournal(db(), { limit: 200 }).items.filter((item) => item.sourceId === posted.id);
    assert.ok(entries.length >= 2, 'سند اصلی و معکوس هر دو باید بمانند');
    assert.ok(entries.some((item) => item.entryKind === 'reversal'));

    const trail = store.financialEventAudit(db(), posted.id);
    assert.deepEqual(trail.map((item) => item.stage), ['captured', 'posted', 'reversed']);
    assert.equal(trail.at(-1).detail.reason, 'اشتباه ثبت شد');

    const trial = accounting.trialBalance(db());
    assert.equal(trial.totals.debit, trial.totals.credit, 'پس از برگشت هم دفتر متوازن می‌ماند');
  });
});

test('تاریخچه همهٔ اجزای تصمیم را نگه می‌دارد', () => {
  inPrimary(() => {
    const result = store.recordFinancialEvent(db(), event({ kind: EVENT_KINDS.CASH_INCOME, category: 'فروش' }), {
      sourceEventId: 'voice:trail-1', decision: confident(EVENT_KINDS.CASH_INCOME), actor: owner.id,
      transcript: 'پنج میلیون فروختم', rawInput: 'پنج میلیون فروختم',
    });
    const [captured] = store.financialEventAudit(db(), result.id);
    assert.equal(captured.stage, 'captured');
    assert.equal(captured.transcript ?? captured.detail.transcript, 'پنج میلیون فروختم');
    assert.ok(captured.detail.event, 'خود رویداد باید ذخیره شود');
    assert.ok(captured.detail.confidence.components, 'اجزای اطمینان باید ذخیره شوند');
    assert.ok(captured.detail.rule, 'قاعدهٔ استفاده‌شده باید ذخیره شود');
    assert.ok(captured.detail.journalPlan.lines.length === 2, 'نقشهٔ سند باید ذخیره شود');
    assert.equal(captured.actor, owner.id, 'تأییدکننده باید ثبت شود');
    assert.ok(captured.createdAt, 'زمان ثبت باید بماند');
  });
});

// یک میانگین بالا نباید روی «جهت پول مبهم است» سرپوش بگذارد.
test('مانع ساختاری از عدد اطمینان مهم‌تر است', () => {
  const decision = routeEvent({ kind: EVENT_KINDS.RECEIVABLE_OPENED, amount: 1 }, {
    components: { amountCertainty: 1, moneyDirectionCertainty: 1, dateCertainty: 1, completeness: 1 },
    blockers: ['جهت پول از جمله روشن نشد.'],
  });
  assert.notEqual(decision.route, ROUTES.AUTO);
  assert.ok(decision.percent >= 95, 'عدد بالا بوده ولی مسیر خودکار نشده');
});

// مدل زبانی فقط واقعیت معنایی استخراج می‌کند؛ مرجع تصمیم نیست.
test('برداشت تنهای مدل زبانی اجازهٔ ثبت خودکار ندارد', () => {
  const components = { amountCertainty: 1, moneyDirectionCertainty: 1, dateCertainty: 1, completeness: 1, aiExtractionConfidence: 1 };
  const aiOnly = routeEvent({ kind: EVENT_KINDS.CASH_EXPENSE, amount: 1 }, { components, aiOnly: true });
  assert.equal(aiOnly.route, ROUTES.CONFIRM);
  assert.ok(aiOnly.reasons.some((reason) => reason.includes('مدل زبانی')));

  // و با سیاست صریحِ دفتر، قابل بازکردن است — چون سیاست است، نه قفل کد.
  const permitted = routeEvent({ kind: EVENT_KINDS.CASH_EXPENSE, amount: 1 }, {
    components, aiOnly: true, policy: { allowAiOnlyAutoPost: true },
  });
  assert.equal(permitted.route, ROUTES.AUTO);
});

test('سیاست خودکارسازی قابل تنظیم است و مقدار خراب دروازه را باز نمی‌کند', () => {
  const components = { amountCertainty: 0.9, moneyDirectionCertainty: 0.9, dateCertainty: 0.9, completeness: 0.9 };
  const strict = routeEvent({ kind: EVENT_KINDS.CASH_EXPENSE, amount: 1 }, { components, policy: { autoThreshold: 0.85 } });
  assert.equal(strict.route, ROUTES.AUTO, 'آستانهٔ پایین‌تر باید اثر کند');

  const broken = routeEvent({ kind: EVENT_KINDS.CASH_EXPENSE, amount: 1 }, { components, policy: { autoThreshold: 'خراب' } });
  assert.equal(broken.route, ROUTES.CONFIRM, 'سیاست خراب باید به پیش‌فرض امن برگردد');
});

// DNA فقط زمینه و احتمال می‌دهد؛ اگر بتواند قاعده را عوض کند، منطق حسابداری
// به یک الگوی آماری سپرده می‌شود.
test('سیگنال DNA قاعدهٔ قطعی را عوض نمی‌کند', async () => {
  const { planJournal, ROLES } = await import('../shared/accountingRules.js');
  const asset = event({ kind: EVENT_KINDS.FIXED_ASSET_PURCHASE, description: 'دستگاه چاپ' });
  const withDna = { ...asset, historicalMatchScore: 0.99, counterpartyLikelyRole: 'vendor', likelyExpensePurpose: 'مواد و کالا' };
  const plan = planJournal(withDna);
  assert.ok(plan.lines.some((line) => line.role === ROLES.FIXED_ASSET), 'دارایی ثابت باید دارایی بماند');
  assert.ok(!plan.lines.some((line) => line.role === ROLES.EXPENSE_CATEGORY), 'سیگنال DNA نباید آن را هزینه کند');
});

test.after(() => {
  database.closeAllDatabases?.();
  removeTempDatabase(databasePath);
});
