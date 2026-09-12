import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENT_KINDS, describeEvent, eventHasDueDate, eventMovesCash, normalizeFinancialEvent } from '../shared/financialEvent.js';
import { ROLES, affectsProfit, planJournal } from '../shared/accountingRules.js';
import { CONFIDENCE_THRESHOLDS, ROUTES, humanSummary, routeEvent, scoreConfidence } from '../shared/confidenceEngine.js';

const base = { amount: 1_000_000, occurredAt: '2026-09-12T08:30:00.000Z', source: 'voice' };
const build = (extra) => normalizeFinancialEvent({ ...base, ...extra });

// ---------------------------------------------------------------- رویداد

test('رویداد بدون نوع شناخته‌شده ساخته نمی‌شود', () => {
  assert.throws(() => build({ kind: 'چیز عجیب' }), (error) => error.code === 'EVENT_KIND_UNKNOWN');
  assert.throws(() => build({}), (error) => error.code === 'EVENT_KIND_UNKNOWN');
});

// رویداد نیمه‌ساخته که از اینجا رد شود، در موتور حسابداری به سند نیمه‌ساخته
// تبدیل می‌شود و آنجا تشخیصش خیلی سخت‌تر است.
test('مبلغ و تاریخ نامعتبر همین‌جا رد می‌شوند', () => {
  assert.throws(() => build({ kind: EVENT_KINDS.CASH_EXPENSE, amount: 0 }), (error) => error.code === 'EVENT_AMOUNT_INVALID');
  assert.throws(() => build({ kind: EVENT_KINDS.CASH_EXPENSE, amount: -5 }), (error) => error.code === 'EVENT_AMOUNT_INVALID');
  assert.throws(() => build({ kind: EVENT_KINDS.CASH_EXPENSE, occurredAt: 'دیروز' }), (error) => error.code === 'EVENT_DATE_MISSING');
});

test('سررسید فقط روی رویدادهای تعهدآور می‌نشیند', () => {
  const cheque = build({ kind: EVENT_KINDS.CHEQUE_ISSUED, dueAt: '2026-10-01T08:30:00.000Z', counterparty: 'شرکت پارس' });
  assert.ok(cheque.dueAt, 'چک باید سررسید نگه دارد');

  // سررسید روی یک هزینهٔ نقدی داده‌ای است که هیچ‌کس بعداً نمی‌داند یعنی چه.
  const expense = build({ kind: EVENT_KINDS.CASH_EXPENSE, dueAt: '2026-10-01T08:30:00.000Z', category: 'اجاره' });
  assert.equal(expense.dueAt, null);
  assert.equal(eventHasDueDate(EVENT_KINDS.CASH_EXPENSE), false);
  assert.equal(eventHasDueDate(EVENT_KINDS.CHEQUE_ISSUED), true);
});

test('حساب نقدی فقط روی رویدادهای پول‌جابه‌جاکن است', () => {
  assert.equal(build({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره' }).accountId, 'cash');
  assert.equal(build({ kind: EVENT_KINDS.RECEIVABLE_OPENED, counterparty: 'حسن' }).accountId, null);
  assert.equal(eventMovesCash(EVENT_KINDS.OBLIGATION_SETTLED), true);
  assert.equal(eventMovesCash(EVENT_KINDS.CHEQUE_RECEIVED), false);
});

test('رویداد پس از ساخت تغییرناپذیر است', () => {
  const event = build({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره' });
  assert.throws(() => { event.amount = 999; }, TypeError);
});

// ---------------------------------------------------------- قواعد حسابداری

const planFor = (kind, extra = {}) => planJournal(build({ kind, ...extra }));

test('هر نقشهٔ سند متوازن است', () => {
  const samples = [
    [EVENT_KINDS.CASH_EXPENSE, { category: 'اجاره' }],
    [EVENT_KINDS.CASH_INCOME, { category: 'فروش' }],
    [EVENT_KINDS.RECEIVABLE_OPENED, { counterparty: 'حسن', category: 'فروش' }],
    [EVENT_KINDS.PAYABLE_OPENED, { counterparty: 'پارس', category: 'مواد و کالا' }],
    [EVENT_KINDS.CHEQUE_RECEIVED, { counterparty: 'حسن' }],
    [EVENT_KINDS.CHEQUE_ISSUED, { counterparty: 'پارس' }],
    [EVENT_KINDS.CAPITAL_CONTRIBUTION, {}],
    [EVENT_KINDS.FIXED_ASSET_PURCHASE, { description: 'دستگاه چاپ' }],
    [EVENT_KINDS.DEPRECIATION, { description: 'دستگاه چاپ' }],
    [EVENT_KINDS.SALES_INVOICE, { counterparty: 'حسن', category: 'فروش' }],
    [EVENT_KINDS.PURCHASE_INVOICE, { counterparty: 'پارس', category: 'مواد و کالا' }],
  ];
  for (const [kind, extra] of samples) {
    const { lines } = planFor(kind, extra);
    const debit = lines.reduce((sum, line) => sum + line.debit, 0);
    const credit = lines.reduce((sum, line) => sum + line.credit, 0);
    assert.equal(debit, credit, kind);
    assert.equal(debit, 1_000_000, kind);
  }
});

// این ادعاها تا امروز فقط قرارداد شفاهی بودند؛ حالا اثبات‌پذیرند.
test('آوردهٔ مالک هرگز درآمد دوره نمی‌شود', () => {
  const { lines } = planFor(EVENT_KINDS.CAPITAL_CONTRIBUTION);
  assert.ok(lines.some((line) => line.role === ROLES.OWNER_CAPITAL && line.credit > 0));
  assert.ok(!lines.some((line) => line.role === ROLES.INCOME_CATEGORY));
  assert.equal(affectsProfit(EVENT_KINDS.CAPITAL_CONTRIBUTION), false);
});

test('خرید دارایی ثابت هرگز هزینهٔ دوره نمی‌شود', () => {
  const { lines } = planFor(EVENT_KINDS.FIXED_ASSET_PURCHASE, { description: 'دستگاه چاپ' });
  assert.ok(lines.some((line) => line.role === ROLES.FIXED_ASSET && line.debit > 0));
  assert.ok(!lines.some((line) => line.role === ROLES.EXPENSE_CATEGORY));
  assert.equal(affectsProfit(EVENT_KINDS.FIXED_ASSET_PURCHASE), false);
});

// اگر تسویه دوباره به دستهٔ درآمد/هزینه بخورد، همان مبلغ دو بار در سود دوره
// می‌آید: یک‌بار موقع ساخت طلب و یک‌بار موقع وصولش.
test('تسویه سود دوره را دوباره تکان نمی‌دهد', () => {
  for (const direction of ['receivable', 'payable']) {
    const { lines } = planJournal(build({ kind: EVENT_KINDS.OBLIGATION_SETTLED, counterparty: 'حسن', settlementDirection: direction }));
    assert.ok(!lines.some((line) => [ROLES.INCOME_CATEGORY, ROLES.EXPENSE_CATEGORY].includes(line.role)), direction);
    assert.ok(lines.some((line) => line.role === ROLES.CASH), direction);
  }
  assert.equal(affectsProfit(EVENT_KINDS.OBLIGATION_SETTLED), false);
});

test('استهلاک بهای دارایی را دست نمی‌زند', () => {
  const { lines } = planFor(EVENT_KINDS.DEPRECIATION, { description: 'دستگاه چاپ' });
  assert.ok(lines.some((line) => line.role === ROLES.DEPRECIATION_EXPENSE && line.debit > 0));
  assert.ok(lines.some((line) => line.role === ROLES.ACCUMULATED_DEPRECIATION && line.credit > 0));
  assert.ok(!lines.some((line) => line.role === ROLES.FIXED_ASSET));
});

// چک باید در تراز از مطالبات عادی قابل تفکیک باشد.
test('چک روی حساب جدا می‌نشیند، نه روی طلب و بدهی عادی', () => {
  assert.ok(planFor(EVENT_KINDS.CHEQUE_RECEIVED, { counterparty: 'حسن' }).lines.some((line) => line.role === ROLES.CHEQUE_RECEIVABLE));
  assert.ok(planFor(EVENT_KINDS.CHEQUE_ISSUED, { counterparty: 'پارس' }).lines.some((line) => line.role === ROLES.CHEQUE_PAYABLE));
});

test('جهت طلب و بدهی در سند وارونه نمی‌شود', () => {
  const receivable = planFor(EVENT_KINDS.RECEIVABLE_OPENED, { counterparty: 'حسن', category: 'فروش' });
  assert.ok(receivable.lines.find((line) => line.role === ROLES.RECEIVABLE).debit > 0, 'طلب ما باید بدهکار شود');

  const payable = planFor(EVENT_KINDS.PAYABLE_OPENED, { counterparty: 'پارس', category: 'مواد و کالا' });
  assert.ok(payable.lines.find((line) => line.role === ROLES.PAYABLE).credit > 0, 'بدهی ما باید بستانکار شود');
});

test('رویداد بدون قاعده صریح شکست می‌خورد', () => {
  assert.throws(() => planJournal({ kind: 'ناشناخته', amount: 1 }), (error) => error.code === 'RULE_UNSUPPORTED');
  assert.throws(() => planJournal(null), (error) => error.code === 'RULE_UNSUPPORTED');
});

// ------------------------------------------------------------ موتور اطمینان

test('آستانه‌ها همان سیاست محصول‌اند', () => {
  assert.equal(CONFIDENCE_THRESHOLDS.auto, 0.95);
  assert.equal(CONFIDENCE_THRESHOLDS.confirm, 0.80);
});

test('اطمینان بالا، ثبت خودکار', () => {
  const event = build({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره' });
  const decision = routeEvent(event, { components: { amountCertainty: 0.99, moneyDirectionCertainty: 0.98, dateCertainty: 0.97, completeness: 0.96 } });
  assert.equal(decision.route, ROUTES.AUTO);
  assert.ok(decision.percent >= 95);
});

test('اطمینان متوسط، تأیید کاربر', () => {
  const event = build({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره' });
  const decision = routeEvent(event, { components: { amountCertainty: 0.9, moneyDirectionCertainty: 0.85, dateCertainty: 0.8, completeness: 0.7 } });
  assert.equal(decision.route, ROUTES.CONFIRM);
});

test('اطمینان پایین، صف بررسی حسابدار', () => {
  const event = build({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره' });
  const decision = routeEvent(event, { components: { amountCertainty: 0.6, moneyDirectionCertainty: 0.5, dateCertainty: 0.9, completeness: 0.4 } });
  assert.equal(decision.route, ROUTES.ACCOUNTANT_REVIEW);
});

// یک عدد بالا نباید روی ایراد ساختاری سرپوش بگذارد.
test('ایراد ساختاری، ثبت خودکار را قطع می‌کند', () => {
  const event = build({ kind: EVENT_KINDS.RECEIVABLE_OPENED, counterparty: 'حسن' });
  const decision = routeEvent(event, {
    components: { amountCertainty: 0.99, moneyDirectionCertainty: 0.99, dateCertainty: 0.99, counterpartyCertainty: 0.99 },
    blockers: ['جهت پول از جمله روشن نشد.'],
  });
  assert.notEqual(decision.route, ROUTES.AUTO);
  assert.deepEqual(decision.reasons, ['جهت پول از جمله روشن نشد.']);
});

// فاکتور صادرشده سند برگشتی می‌خواهد و آورده ساختار سرمایه را عوض می‌کند؛
// اینها با یک «باشه» از کاربر عادی رد نمی‌شوند.
test('سندهای سخت‌برگشت هرگز خودکار ثبت نمی‌شوند', () => {
  const full = { amount: 1, moneyDirectionCertainty: 1, dateCertainty: 1, counterparty: 1, completeness: 1 };
  for (const kind of [EVENT_KINDS.SALES_INVOICE, EVENT_KINDS.PURCHASE_INVOICE, EVENT_KINDS.CAPITAL_CONTRIBUTION, EVENT_KINDS.FIXED_ASSET_PURCHASE, EVENT_KINDS.DEPRECIATION]) {
    const event = build({ kind, counterparty: 'حسن', category: 'فروش', description: 'دستگاه' });
    const decision = routeEvent(event, { components: full });
    assert.equal(decision.route, ROUTES.CONFIRM, kind);
    assert.ok(decision.reasons.length, `${kind} باید دلیلش را بگوید`);
  }
});

// جملهٔ کوتاه و کاملاً روشن نباید به‌خاطر میدان‌های گفته‌نشده تنبیه شود.
test('میدان گفته‌نشده وزنش از محاسبه بیرون می‌رود، نه اینکه صفر بگیرد', () => {
  const withCounterparty = scoreConfidence({ amount: 1, moneyDirectionCertainty: 1, dateCertainty: 1, counterpartyCertainty: 0 });
  const without = scoreConfidence({ amount: 1, moneyDirectionCertainty: 1, dateCertainty: 1 });
  assert.equal(without.score, 1);
  assert.ok(withCounterparty.score < 1);
});

test('خلاصهٔ تأیید هیچ اصطلاح دفترداری ندارد', () => {
  const samples = [
    build({ kind: EVENT_KINDS.CASH_EXPENSE, category: 'اجاره' }),
    build({ kind: EVENT_KINDS.RECEIVABLE_OPENED, counterparty: 'حسن' }),
    build({ kind: EVENT_KINDS.CHEQUE_ISSUED, counterparty: 'پارس' }),
    build({ kind: EVENT_KINDS.CAPITAL_CONTRIBUTION }),
  ];
  for (const event of samples) {
    const summary = humanSummary(event);
    assert.ok(summary.length > 0, event.kind);
    for (const jargon of ['بدهکار', 'بستانکار', 'دفتر کل', 'آرتیکل', 'سند حسابداری']) {
      assert.ok(!summary.includes(jargon), `«${jargon}» نباید در خلاصهٔ کاربر عادی باشد: ${summary}`);
    }
  }
});

test('توضیح رویداد برای هر نوع ساخته می‌شود', () => {
  for (const kind of Object.values(EVENT_KINDS)) {
    const event = build({ kind, counterparty: 'حسن', category: 'فروش', description: 'دستگاه', reference: 'FR-1' });
    assert.ok(describeEvent(event).trim().length > 0, kind);
  }
});

// ------------------------------------------- از گفتار واقعی تا نقشهٔ سند

const { detectVoiceIntent, intentConfidenceFields, intentToFinancialEvent } = await import('../shared/voiceIntent.js');
const { persianToISO } = await import('../shared/persianDate.js');
const NOW = new Date(persianToISO(1405, 6, 21, 'Asia/Tehran'));
const eventFrom = (text) => intentToFinancialEvent(detectVoiceIntent(text, { now: NOW, context: 'obligation' }), { now: NOW });

test('گفتار واقعی به رویداد درست می‌رسد', () => {
  const receivable = eventFrom('مبلغ 23 میلیون تومان در تاریخ 15/3/1405 از شرکت آراد گستر آسیا طلبکار شدیم');
  assert.equal(receivable.kind, EVENT_KINDS.RECEIVABLE_OPENED);
  assert.equal(receivable.amount, 23_000_000);
  assert.equal(receivable.counterparty, 'شرکت آراد گستر آسیا');

  const cheque = eventFrom('چک پنج میلیون دادم سررسید دهم مهر');
  assert.equal(cheque.kind, EVENT_KINDS.CHEQUE_ISSUED);
  assert.ok(cheque.dueAt, 'چک باید سررسید داشته باشد');
});

test('کل زنجیره: گفتار تا نقشهٔ متوازن سند', () => {
  const event = eventFrom('آقای احمدی سه میلیون بدهکار شد');
  const { lines } = planJournal(event);
  assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), 3_000_000);
  assert.equal(lines.reduce((sum, line) => sum + line.credit, 0), 3_000_000);
  assert.ok(lines.find((line) => line.role === ROLES.RECEIVABLE).debit > 0);
});

// نیتِ ناقص نباید بی‌صدا به رویداد تبدیل شود؛ تصمیم دربارهٔ آن کار رابط است.
test('نیت ناقص رویداد نمی‌سازد', () => {
  assert.equal(intentToFinancialEvent(null), null);
  assert.equal(intentToFinancialEvent({ intent: 'obligation', amount: 0 }), null);
  // جهت مبهم یعنی جهت پول معلوم نیست؛ ساختن رویداد از آن یعنی حدس‌زدن.
  assert.equal(intentToFinancialEvent({ intent: 'obligation', amount: 1_000, direction: null }), null);
  assert.equal(intentToFinancialEvent({ intent: 'fixed-asset', amount: 1_000, title: '' }), null);
});

test('نیت مبهم به صف بررسی می‌رود، نه ثبت خودکار', () => {
  const intent = detectVoiceIntent('آقای رضایی بدهکاره ولی من هم بهش بدهکارم پنج میلیون', { now: NOW, context: 'obligation' });
  const { fields, blockers } = intentConfidenceFields(intent);
  assert.ok(blockers.length, 'جهت مبهم باید مانع ساختاری بسازد');
  const decision = routeEvent({ kind: EVENT_KINDS.RECEIVABLE_OPENED, amount: intent.amount }, { components: fields, blockers });
  assert.notEqual(decision.route, ROUTES.AUTO);
});
