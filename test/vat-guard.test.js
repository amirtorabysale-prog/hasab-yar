import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('vat-guard');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'vat-owner';
process.env.ADMIN_PASSWORD = `vat-${crypto.randomUUID()}`;

const database = await import(`../server/db.js?vat=${process.pid}`);
const store = await import(`../server/financialEventStore.js?vat=${process.pid}`);
const { trialBalance, vatBalances } = await import(`../server/accounting.js?vat=${process.pid}`);
const { vatGuardContext } = await import(`../server/tax.js?vat=${process.pid}`);
const { VAT_FORMS, readVatMention, splitInclusive, withoutVatQualifiers } = await import('../shared/vatSpeech.js');
const { GUARD_VERDICTS, guardedPlan, isGuardPlan, runGuards } = await import('../shared/guards.js');
const { EVENT_KINDS, normalizeFinancialEvent } = await import('../shared/financialEvent.js');
const { factsFromEvent } = await import('../shared/eventFacts.js');
const { decide } = await import('../shared/accountingDecision.js');
const { ROLES } = await import('../shared/accountingRules.js');
const { parseFinancialText } = await import('../shared/parser.js');

database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const inPrimary = (callback) => database.runInWorkspace('primary', { role: 'owner', userId: owner.id }, callback);

/**
 * نگهبان تفکیک ارزش افزوده.
 *
 * ارزش افزوده پول سازمان است: در فروش جمع می‌شود و در خرید جلو داده می‌شود.
 * هیچ‌کدام درآمد یا هزینه نیست. «۱۱۰ میلیون فروختم با ارزش افزوده» تا امروز
 * کل ۱۱۰ میلیون را درآمد می‌کرد — سود دوره ده میلیون باد می‌کرد و بدهی به
 * سازمان در دفتر اصلاً ساخته نمی‌شد.
 *
 * مثل دو نگهبان قبلی، معیار «چه چیزی هرگز نمی‌سازد» است: هیچ سطر سود و زیانی
 * به اندازهٔ مالیات، و هیچ ثبت بی‌صدایی وقتی نسبت مبلغ و مالیات روشن نیست.
 */

const OCCURRED = '2026-09-23T00:00:00.000Z';
const REGISTERED = Object.freeze({ ratesBps: [1000], rateBps: 1000, outputTax: 0 });
const PROFIT_ROLES = [ROLES.INCOME_CATEGORY, ROLES.EXPENSE_CATEGORY, ROLES.DEPRECIATION_EXPENSE];

const cashEvent = (kind, extra = {}) => normalizeFinancialEvent({
  kind, amount: 110_000_000, occurredAt: OCCURRED, accountId: 'cash', category: 'فروش', ...extra,
});
const sale = (evidence, extra = {}) => cashEvent(EVENT_KINDS.CASH_INCOME, { evidence, ...extra });
const purchase = (evidence, extra = {}) => cashEvent(EVENT_KINDS.CASH_EXPENSE, { category: 'ملزومات اداری', evidence, ...extra });

const guard = (event, context = {}) => {
  const facts = factsFromEvent(event);
  const result = runGuards(event, facts, { decision: decide(facts, { today: OCCURRED }), ...context });
  return { result, vat: result.checks.find((entry) => entry.name === 'vat-split') };
};
const sumOf = (lines, role, side) => lines.filter((line) => line.role === role).reduce((sum, line) => sum + line[side], 0);

// ---------------------------------------------------------------------------
// خواندن جمله
// ---------------------------------------------------------------------------

test('سه نسبت مبلغ با ارزش افزوده از هم جدا خوانده می‌شوند', () => {
  assert.equal(readVatMention('۱۱۰ میلیون فروختم با ارزش افزوده').form, VAT_FORMS.INCLUSIVE);
  assert.equal(readVatMention('لپ‌تاپ خریدم ۵۵ میلیون با احتساب ارزش افزوده').form, VAT_FORMS.INCLUSIVE);
  assert.equal(readVatMention('فروش ۱۰۰ میلیون به علاوه ارزش افزوده').form, VAT_FORMS.EXCLUSIVE);
  assert.equal(readVatMention('فروش ۱۰۰ میلیون، ارزش افزوده‌اش جدا').form, VAT_FORMS.EXCLUSIVE);
  assert.equal(readVatMention('ارزش افزودهٔ فصل بهار رو ۲۰ میلیون پرداخت کردم').form, VAT_FORMS.BARE);
});

test('«بدون احتساب» معافیت نیست؛ یعنی مالیات بیرون مبلغ است', () => {
  // هر دو با «بدون» شروع می‌شوند و معنایشان برعکس است.
  assert.equal(readVatMention('فروش ۱۰۰ میلیون بدون احتساب مالیات').form, VAT_FORMS.EXCLUSIVE);
  assert.equal(readVatMention('فروختم ۵ میلیون بدون ارزش افزوده').form, VAT_FORMS.EXEMPT);
});

test('«مالیات» تنها، ارزش افزوده نیست', () => {
  // مالیات عملکرد و مالیات حقوق هزینه یا بدهی دیگری‌اند و نباید به حساب
  // ارزش افزوده بخورند.
  assert.equal(readVatMention('مالیات عملکرد ۴۰ میلیون دادم').form, VAT_FORMS.NONE);
  assert.equal(readVatMention('بابت مالیات حقوق ۵ میلیون دادم').form, VAT_FORMS.NONE);
  assert.equal(readVatMention('قبض برق رو سه میلیون پرداخت کردم').form, VAT_FORMS.NONE);
});

test('نرخ گفته‌شده، با عدد یا با حرف', () => {
  assert.equal(readVatMention('خرید کاغذ ۲۲ میلیون شامل ۱۰ درصد مالیات').ratePercent, 10);
  assert.equal(readVatMention('خرید کاغذ ۲۲ میلیون با ده درصد ارزش افزوده').ratePercent, 10);
  assert.equal(readVatMention('۱۱۰ میلیون فروختم با ارزش افزوده').ratePercent, null, 'نرخ نگفته حدس زده نمی‌شود');
});

test('تفکیک، جمع دو سطر را دقیقاً برابر پول جابه‌جاشده نگه می‌دارد', () => {
  assert.deepEqual(splitInclusive(110_000_000, 1000), { net: 100_000_000, tax: 10_000_000 });
  // نرخی که تقسیمش گرد نمی‌شود: مالیات از تفاضل می‌آید، پس ریالی گم نمی‌شود.
  for (const [gross, bps] of [[55_000_000, 950], [1_234_567, 900], [999_999, 1000]]) {
    const { net, tax } = splitInclusive(gross, bps);
    assert.equal(net + tax, gross, `${gross} با نرخ ${bps}`);
  }
  assert.equal(splitInclusive(1, 1000), null, 'مبلغی که مالیاتش صفر می‌شود تفکیک‌پذیر نیست');
  assert.equal(splitInclusive(110_000_000, 0), null);
});

// ---------------------------------------------------------------------------
// پارسر: نشانهٔ قیمت، موضوع خرج نیست
// ---------------------------------------------------------------------------

test('نشانهٔ ارزش افزوده دیگر دستهٔ خرید را نمی‌دزدد', () => {
  const [item] = parseFinancialText('خرید کاغذ ۲۲ میلیون شامل ۱۰ درصد مالیات').transactions;
  assert.notEqual(item.category, 'مالیات و عوارض', 'موضوع خرج کاغذ است، نه مالیات');
  assert.ok(item.rawText.includes('مالیات'), 'متن خام باید اشاره به مالیات را برای نگهبان نگه دارد');
});

test('فروش به علاوهٔ ارزش افزوده، درآمد است نه هزینه', () => {
  const [item] = parseFinancialText('فروش ۱۰۰ میلیون به علاوه ارزش افزوده').transactions;
  assert.equal(item.type, 'income');
  assert.equal(item.category, 'فروش');
});

test('پرداخت خودِ ارزش افزوده، دسته‌اش را نگه می‌دارد', () => {
  // اینجا ارزش افزوده موضوع جمله است، نه نشانهٔ قیمت؛ نباید پاک شود.
  const [item] = parseFinancialText('۲۰ میلیون بابت مالیات بر ارزش افزوده به دارایی دادم').transactions;
  assert.equal(item.category, 'مالیات و عوارض');
  assert.equal(withoutVatQualifiers('ارزش افزوده رو دادم'), 'ارزش افزوده رو دادم');
});

// ---------------------------------------------------------------------------
// نگهبان — آنچه هرگز نمی‌سازد
// ---------------------------------------------------------------------------

test('فروش با ارزش افزوده، مالیات را درآمد نمی‌کند', () => {
  const { result, vat } = guard(sale('۱۱۰ میلیون فروختم با ارزش افزوده'), { vat: REGISTERED });
  assert.equal(vat.verdict, GUARD_VERDICTS.REWRITE);
  const { lines } = result.plan;
  assert.equal(sumOf(lines, ROLES.INCOME_CATEGORY, 'credit'), 100_000_000, 'درآمد فقط خالص فروش است');
  assert.equal(sumOf(lines, ROLES.VAT_OUTPUT, 'credit'), 10_000_000, 'مالیات بدهی به سازمان است');
  assert.equal(sumOf(lines, ROLES.CASH, 'debit'), 110_000_000, 'پولی که آمد، کامل');
});

test('خرید با ارزش افزوده، مالیات را هزینه نمی‌کند', () => {
  const { result } = guard(purchase('کاغذ خریدم ۱۱۰ میلیون با ارزش افزوده'), { vat: REGISTERED });
  const { lines } = result.plan;
  assert.equal(sumOf(lines, ROLES.EXPENSE_CATEGORY, 'debit'), 100_000_000);
  assert.equal(sumOf(lines, ROLES.VAT_INPUT, 'debit'), 10_000_000, 'مالیات خرید اعتبار است');
  assert.equal(sumOf(lines, ROLES.CASH, 'credit'), 110_000_000);
});

test('نقشهٔ تفکیک متوازن است و نام نگهبان را با خود دارد', () => {
  const event = sale('۱۱۰ میلیون فروختم با ارزش افزوده');
  const facts = factsFromEvent(event);
  const decision = decide(facts, { today: OCCURRED });
  const plan = guardedPlan(event, decision, runGuards(event, facts, { decision, vat: REGISTERED }));
  assert.equal(plan.guard, 'vat-split');
  assert.ok(isGuardPlan(plan));
  const debit = plan.lines.reduce((sum, line) => sum + line.debit, 0);
  const credit = plan.lines.reduce((sum, line) => sum + line.credit, 0);
  assert.equal(debit, credit);
});

test('دفتر غیرمشمول، مالیات خرید را جزو بهای خرید نگه می‌دارد', () => {
  // اعتبار خرید فقط مال مشمولان است؛ جدا کردنش دارایی‌ای می‌ساخت که هیچ‌وقت
  // قابل استفاده نیست.
  const { result, vat } = guard(purchase('کاغذ خریدم ۱۱۰ میلیون با ارزش افزوده'), { vat: { ratesBps: [], rateBps: null, outputTax: 0 } });
  assert.equal(vat.verdict, GUARD_VERDICTS.PASS);
  assert.ok(vat.reason.includes('بهای خرید'));
  assert.equal(result.plan, null);
});

test('دفتر غیرمشمول نمی‌تواند با ارزش افزوده بفروشد — حسابدار می‌بیند', () => {
  const { result } = guard(sale('۱۱۰ میلیون فروختم با ارزش افزوده'), { vat: { ratesBps: [], rateBps: null, outputTax: 0 } });
  assert.equal(result.verdict, GUARD_VERDICTS.BLOCK);
});

test('نرخی که در دفتر تعریف نشده، سند نمی‌سازد', () => {
  const { result } = guard(sale('۱۰۹ میلیون فروختم با ۹ درصد ارزش افزوده'), { vat: REGISTERED });
  assert.equal(result.verdict, GUARD_VERDICTS.BLOCK);
  assert.ok(result.reason.includes('۹ درصد'), result.reason);
});

test('چند نرخ مشمول بی‌پیش‌فرض، حدس زده نمی‌شود', () => {
  const { result } = guard(sale('۱۱۰ میلیون فروختم با ارزش افزوده'), { vat: { ratesBps: [900, 1000], rateBps: null, outputTax: 0 } });
  assert.equal(result.verdict, GUARD_VERDICTS.BLOCK);
});

test('مالیات بیرون مبلغ، به حسابدار می‌رود نه به سود و زیان', () => {
  // «۱۰۰ به علاوه ارزش افزوده»: پولی که واقعاً آمد ۱۱۰ بود یا ۱۰۰؟ سند
  // هیچ‌کدام از دو حدس را نمی‌زند.
  const { result } = guard(sale('فروش ۱۰۰ میلیون به علاوه ارزش افزوده', { amount: 100_000_000 }), { vat: REGISTERED });
  assert.equal(result.verdict, GUARD_VERDICTS.BLOCK);
  assert.ok(result.reason.trim());
});

test('ارزش افزودهٔ بی‌نسبت در فروش، مبهم است', () => {
  const { result } = guard(sale('فروش ۱۱۰ میلیون، ارزش افزوده ده درصد'), { vat: REGISTERED });
  assert.equal(result.verdict, GUARD_VERDICTS.BLOCK);
});

test('بدون دادهٔ دفتر، ارزش افزوده بی‌صدا به سود و زیان نمی‌رود', () => {
  // برخلاف نگهبان تسویه، اینجا «نتوانستم بررسی کنم» مانع است: پیش‌فرض ناامن
  // «کل مبلغ درآمد» است، و کاربر خودش گفته ارزش افزوده در کار است.
  const { result, vat } = guard(sale('۱۱۰ میلیون فروختم با ارزش افزوده'));
  assert.equal(result.verdict, GUARD_VERDICTS.BLOCK);
  assert.equal(vat.checked, true);
});

test('جملهٔ بی‌ارزش‌افزوده دست نمی‌خورد ولی بررسی ثبت می‌شود', () => {
  const { result, vat } = guard(purchase('قبض برق رو سه میلیون پرداخت کردم', { amount: 3_000_000 }), { vat: REGISTERED });
  assert.equal(result.verdict, GUARD_VERDICTS.PASS);
  assert.equal(vat.checked, true);
  assert.equal(vat.vatForm, VAT_FORMS.NONE);
});

test('معافیت صریح، تفکیک نمی‌شود', () => {
  const { result } = guard(sale('فروختم ۵ میلیون بدون ارزش افزوده', { amount: 5_000_000 }), { vat: REGISTERED });
  assert.equal(result.verdict, GUARD_VERDICTS.PASS);
});

test('ارزش افزودهٔ یک پیش‌پرداخت، خالصش را پیش‌پرداخت نگه می‌دارد', () => {
  // تفکیک روی نقشهٔ تصمیم سوار می‌شود نه روی «هزینه»: بیمهٔ یک‌ساله با
  // ارزش افزوده، خالصش دارایی است.
  const event = purchase('حق بیمه یک‌ساله ۱۱۰ میلیون با ارزش افزوده', {
    category: 'بیمه', servicePeriodStart: OCCURRED, servicePeriodEnd: '2027-09-22T00:00:00.000Z',
  });
  const { result } = guard(event, { vat: REGISTERED });
  assert.equal(result.verdict, GUARD_VERDICTS.REWRITE);
  assert.equal(sumOf(result.plan.lines, ROLES.PREPAID_ASSET, 'debit'), 100_000_000);
  assert.equal(sumOf(result.plan.lines, ROLES.EXPENSE_CATEGORY, 'debit'), 0, 'هیچ سطر هزینه‌ای');
  assert.equal(sumOf(result.plan.lines, ROLES.VAT_INPUT, 'debit'), 10_000_000);
});

test('تسویهٔ فاکتور با ارزش افزوده، مالیات را دوباره نمی‌سازد', () => {
  // مالیات فاکتور روز ثبت فاکتور شناسایی شده. تفکیک دوباره‌اش در پرداخت،
  // همان مالیات را دو بار در دفتر می‌نشاند.
  const event = purchase('۱۱۰ میلیون به شرکت آراد دادم بابت فاکتور با ارزش افزوده', { counterparty: 'شرکت آراد' });
  const openDocuments = [{ kind: 'obligation', id: 'o1', direction: 'payable', remaining: 110_000_000, reference: 'فاکتور ۷', occurredAt: OCCURRED }];
  const { result, vat } = guard(event, { vat: REGISTERED, openDocuments });
  assert.equal(result.rewrittenBy, 'settlement-first');
  assert.equal(vat.verdict, GUARD_VERDICTS.PASS);
  assert.equal(result.plan.lines.some((line) => [ROLES.VAT_INPUT, ROLES.VAT_OUTPUT].includes(line.role)), false);
});

test('پرداخت ارزش افزوده به سازمان، هزینه نیست', () => {
  const event = purchase('ارزش افزودهٔ فصل بهار رو ۲۰ میلیون پرداخت کردم', { amount: 20_000_000, category: 'مالیات و عوارض' });
  const { result } = guard(event, { vat: { ...REGISTERED, outputTax: 35_000_000 } });
  assert.equal(result.verdict, GUARD_VERDICTS.REWRITE);
  assert.equal(result.plan.lines.some((line) => PROFIT_ROLES.includes(line.role)), false, 'هیچ سطر سود و زیانی');
  assert.equal(sumOf(result.plan.lines, ROLES.VAT_OUTPUT, 'debit'), 20_000_000, 'بدهی به سازمان بسته می‌شود');
});

test('پرداختی بیش از ماندهٔ دفتر، به حسابدار می‌رود', () => {
  // شاید دوره‌های قبل اصلاً در دفتر نیامده‌اند؛ بستن بدهی‌ای که نیست، ماندهٔ
  // بدهکار روی حساب بدهی می‌ساخت.
  const event = purchase('ارزش افزودهٔ فصل بهار رو ۲۰ میلیون پرداخت کردم', { amount: 20_000_000 });
  const { result, vat } = guard(event, { vat: { ...REGISTERED, outputTax: 5_000_000 } });
  assert.equal(result.verdict, GUARD_VERDICTS.BLOCK);
  assert.equal(vat.outputTax, 5_000_000, 'مانده‌ای که دیده شد ثبت می‌شود');
});

test('جریمهٔ ارزش افزوده همچنان هزینه است', () => {
  const event = purchase('جریمه دیرکرد ارزش افزوده ۳ میلیون دادم', { amount: 3_000_000 });
  const { result } = guard(event, { vat: { ...REGISTERED, outputTax: 50_000_000 } });
  assert.equal(result.verdict, GUARD_VERDICTS.PASS);
});

test('استرداد ارزش افزوده درآمد نیست', () => {
  const event = sale('استرداد ارزش افزوده ۸ میلیون گرفتم', { amount: 8_000_000 });
  const { result } = guard(event, { vat: REGISTERED });
  assert.equal(result.verdict, GUARD_VERDICTS.BLOCK);
});

// ---------------------------------------------------------------------------
// سر تا ته: از جمله تا دفتر، با فلگ روشن
// ---------------------------------------------------------------------------

function journalFor(transactionId) {
  const db = database.activeWorkspaceDatabase();
  return db.prepare(`SELECT ledger_accounts.source_kind AS sourceKind,ledger_accounts.source_key AS sourceKey,
      journal_lines.debit,journal_lines.credit
    FROM journal_entries JOIN journal_lines ON journal_lines.entry_id=journal_entries.id
    JOIN ledger_accounts ON ledger_accounts.id=journal_lines.account_id
    WHERE journal_entries.source_type='transaction' AND journal_entries.source_id=? AND journal_entries.entry_kind='normal'`).all(transactionId);
}

function record(sentence) {
  const [item] = parseFinancialText(sentence).transactions;
  const [id] = database.insertTransactions({ transcript: sentence, transactions: [{ ...item, source: 'text', accountId: 'cash' }] });
  const event = store.findEventBySource(database.activeWorkspaceDatabase(), `transaction:${id}`);
  return { id, event };
}

// موتور برای «فروختم» ساده هنوز خانواده‌ای نمی‌شناسد، پس مورد به صف حسابدار
// می‌رود و فقط با دلیل ثبت می‌شود — همان کاری که حسابدار واقعی می‌کند.
const settle = (event) => {
  if (event.status !== 'pending') return event;
  // فروش از مهر ۱۴۰۵ تصمیم قطعی دارد (درآمد همان لحظه) و تفکیک نگهبان روی تصمیم
  // قطعی دلیل جدا نمی‌خواهد. نقشهٔ بازنویسی‌شده روی تصمیم ناقص هنوز می‌خواهد.
  const decided = store.decisionForEvent(database.activeWorkspaceDatabase(), event.id)?.decisionStatus === 'decided';
  if (decided) return database.approveEvent(event.id);
  assert.throws(() => database.approveEvent(event.id), { code: 'EVENT_OVERRIDE_REASON_REQUIRED' }, 'تأیید بی‌دلیل نباید ممکن باشد');
  return database.approveEvent(event.id, { reason: 'حسابدار: ماهیت بررسی و تأیید شد.' });
};

test('آماده‌سازی: دفتر مشمول با نرخ ده درصد و موتور روشن', () => {
  inPrimary(() => {
    database.saveTaxRate({ name: 'ارزش افزوده ۱۰٪', rate: 10, treatment: 'taxable', isDefault: true });
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true });
    const context = vatGuardContext(database.activeWorkspaceDatabase());
    assert.deepEqual(context.ratesBps, [1000]);
    assert.equal(context.rateBps, 1000);
  });
});

test('سر تا ته: فروش با ارزش افزوده، بدهی به سازمان می‌سازد', () => {
  inPrimary(() => {
    const { id, event } = record('۱۱۰ میلیون فروختم با ارزش افزوده');
    assert.ok(event, 'رویداد باید ساخته شود');
    settle(event);
    const lines = journalFor(id);
    const income = lines.filter((line) => line.sourceKind === 'income-category').reduce((sum, line) => sum + line.credit, 0);
    const tax = lines.filter((line) => line.sourceKey === 'output-tax').reduce((sum, line) => sum + line.credit, 0);
    assert.equal(income, 100_000_000, `درآمد باید خالص باشد: ${JSON.stringify(lines)}`);
    assert.equal(tax, 10_000_000);
    assert.equal(vatBalances(database.activeWorkspaceDatabase()).outputTax, 10_000_000, 'تسویهٔ دوره حالا چیزی برای بستن دارد');
  });
});

test('سر تا ته: پرداخت ارزش افزوده همان بدهی را می‌بندد', () => {
  inPrimary(() => {
    const { id, event } = record('ارزش افزوده فصل بهار رو ۱۰ میلیون پرداخت کردم');
    settle(event);
    const lines = journalFor(id);
    assert.equal(lines.some((line) => line.sourceKind === 'expense-category'), false, `هیچ سطر هزینه‌ای: ${JSON.stringify(lines)}`);
    assert.equal(vatBalances(database.activeWorkspaceDatabase()).outputTax, 0);
  });
});

test('سر تا ته: مانع نگهبان واقعاً ثبت را نگه می‌دارد', () => {
  // تا امروز مانع یک خطا بود و مسیر تراکنش هر خطا را «لایهٔ رویداد نتوانست»
  // می‌خواند و سند را از مسیر قدیمی می‌زد — یعنی درست همان چیزی که نگهبان
  // گفته بود نباید ثبت شود.
  inPrimary(() => {
    const { id, event } = record('فروش ۱۰۰ میلیون به علاوه ارزش افزوده');
    assert.equal(event.status, 'pending');
    assert.equal(event.route, 'accountant-review');
    assert.ok(event.confidence.reasons.some((reason) => reason.includes('ارزش افزوده')), 'دلیل نگهبان باید در صف دیده شود');
    assert.deepEqual(journalFor(id), [], 'هیچ سندی نباید زده شود');
    trialBalance(database.activeWorkspaceDatabase());
    assert.deepEqual(journalFor(id), [], 'مهاجرت دفتر هم نباید برایش سند بسازد');
  });
});

test('سر تا ته: جواب سؤال، تفکیک را از دست نمی‌دهد', () => {
  inPrimary(() => {
    const db = database.activeWorkspaceDatabase();
    const { event } = record('حق بیمه یک‌ساله ۱۱۰ میلیون با ارزش افزوده پرداخت کردم');
    assert.equal(event.status, 'pending', 'بیمهٔ یک‌ساله دورهٔ پوشش می‌خواهد');
    database.answerEvent(event.id, { fact: 'servicePeriodStart', value: 'this-month' });
    database.answerEvent(event.id, { fact: 'servicePeriodEnd', value: 'one-year' });
    const plan = JSON.parse(db.prepare('SELECT posting_plan FROM financial_events WHERE id=?').get(event.id).posting_plan);
    assert.equal(plan.guard, 'vat-split', `نقشه باید هنوز تفکیک‌شده باشد: ${JSON.stringify(plan)}`);
    assert.equal(sumOf(plan.lines, ROLES.PREPAID_ASSET, 'debit'), 100_000_000);
    assert.equal(sumOf(plan.lines, ROLES.VAT_INPUT, 'debit'), 10_000_000);
  });
});

/**
 * «مالیات» تنها، بدون نشانهٔ داد و ستد، ارزش افزوده نیست.
 *
 * این نقص در بازبینی پیدا شد: الگوی «با ... مالیات» روی جملهٔ حقوق می‌گرفت و
 * نگهبان ده درصد از حقوق را اعتبار مالیاتی می‌کرد — اعتباری جعلی که هیچ‌وقت
 * قابل استفاده نیست و در تسویهٔ دوره با سازمان نمی‌خواند. بدتر اینکه حکمش
 * `rewrite` بود، یعنی بی‌صدا اتفاق می‌افتاد.
 */
test('مالیات حقوق، ارزش افزوده خوانده نمی‌شود', () => {
  assert.equal(readVatMention('حقوق پرسنل رو با مالیات 100 میلیون دادم').form, VAT_FORMS.NONE);
  assert.equal(readVatMention('مالیات عملکرد رو 50 میلیون دادم').form, VAT_FORMS.NONE);
  assert.equal(readVatMention('بیمه رو با مالیات حساب کردن').form, VAT_FORMS.NONE);
});

test('«مالیات» تنها با نشانهٔ داد و ستد، ارزش افزوده است', () => {
  // «فروختم» و «خریدم» همان نشانه‌ای‌اند که مالیات جمله را به ارزش افزوده
  // وصل می‌کنند؛ بدون آن‌ها هر مالیاتی می‌توانست باشد.
  assert.equal(readVatMention('فروش 100 میلیون به علاوه مالیات').form, VAT_FORMS.EXCLUSIVE);
  assert.equal(readVatMention('110 میلیون فروختم با مالیات').form, VAT_FORMS.INCLUSIVE);
});
