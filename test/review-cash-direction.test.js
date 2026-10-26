import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';
import { normalizeFinancialEvent } from '../shared/financialEvent.js';

/**
 * آزمون زندهٔ ۴ آبان ۱۴۰۵ روی سایت، دفتر آزمایشی، «همه با AI»:
 *
 * - «۵ میلیون تومان از پول اجناسی که … پس داده شد و رفت تو صندوق.» فهم رویداد جهت را
 *   درست «دریافت» خواند و به صف داد؛ پیشنهاد AI صف «بستانکار صندوق / بدهکار سایر هزینه‌ها»
 *   بود — پرداختِ جعلی — و قابل ثبت. پرونده جهت پول را نگه نمی‌داشت که کنترل صف بسنجد.
 * - «قبض برق مهر که اومده بود رو امروز از ملت پرداخت کردیم، ۴ میلیون.» پیشنهاد صف «بدهکار
 *   قبوض / بستانکار ملت» بود؛ هزینه دو بار ثبت می‌شد (R035).
 *
 * خانواده: جهت ورود و خروج، برگشت خرید و برگشت پیش‌پرداخت، و پرداخت یا وصولِ سندِ قبلی؛
 * منفی: پیشنهادی که جهت درست دارد، و پرونده‌ای که جهتش معلوم نیست.
 */

const databasePath = tempDatabase('review-cash-direction');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'direction-owner';
process.env.ADMIN_PASSWORD = 'direction-strong-password-8813';
const previousKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'test-key';
const database = await import('../server/db.js');
const store = await import('../server/financialEventStore.js');
const assistant = await import('../server/reviewAssistant.js');
const ai = await import('../server/accountingReviewAi.js');
const { placeholderFacts } = await import('../server/db/understanding.js');
database.ensureAdmin();
const owner = database.authenticateUser('direction-owner', 'direction-strong-password-8813');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر جهت پول', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();
test.after(() => {
  if (previousKey == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
  removeTempDatabase(databasePath);
});

const fake = (proposal) => async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] }) });
/** پرونده‌ای که فهم رویداد به صف داد؛ همان شکل `sendUnderstandingToAccountant`. */
const queued = (text, amount, cashDirection) => store.recordFinancialEvent(db(), normalizeFinancialEvent({
  kind: 'review-placeholder', amount, amountReferenceOnly: true, occurredAt: '2026-10-26T08:00:00.000Z', source: 'text',
  evidence: text, utterance: text, ...(cashDirection ? { cashDirection } : {}),
}), { sourceEventId: crypto.randomUUID(), decision: { route: 'accountant-review', guardBlocked: true, reasons: ['با حسابدار'] }, transcript: text, rawInput: text });
const prepare = async (event, lines) => {
  const proposal = await ai.proposeReview(db(), event.id, { facts: { accountId: 'cash' }, fetcher: fake({ summary: 'پیشنهاد', explanation: 'آزمون', missingFacts: [], questions: [], lines }) });
  return assistant.prepareReviewProposal(db(), db().prepare('SELECT * FROM financial_events WHERE id=?').get(event.id), proposal);
};
const directionBlocked = (result) => result.postingBlockers.some((text) => text.includes('جهت را اصلاح کن'));

const RETURN_TEXT = '۵ میلیون تومان از پول اجناسی که هفتهٔ پیش نقد از بازار خریده بودیم پس داده شد و رفت تو صندوق.';

test('فهم رویداد جهت پول را با پرونده به صف می‌فرستد؛ جهتِ دوگانه یا نامعلوم نگه داشته نمی‌شود', () => {
  const now = '2026-10-26T08:00:00.000Z';
  assert.equal(placeholderFacts({ movements: [{ direction: 'in' }] }, RETURN_TEXT, now).cashDirection, 'in');
  assert.equal(placeholderFacts({ movements: [{ direction: 'out' }] }, 'قبض برق که اومده بود رو پرداخت کردیم', now).cashDirection, 'out');
  assert.equal(placeholderFacts({ movements: [{ direction: 'in' }, { direction: 'out' }] }, 'انتقال', now).cashDirection, undefined);
  assert.equal(placeholderFacts({ movements: [{ direction: 'none' }] }, 'بدهی', now).cashDirection, undefined);
  assert.equal(normalizeFinancialEvent({ kind: 'review-placeholder', amount: 1, occurredAt: now, cashDirection: 'sideways' }).cashDirection, null);
});

test('برگشت خرید با پول به صندوق: پیشنهادِ «بستانکار صندوق» رد می‌شود؛ «بدهکار صندوق» جلویش گرفته نمی‌شود', async () => {
  await inWorkspace(async () => {
    const event = queued(RETURN_TEXT, 5_000_000, 'in');
    // همان پیشنهاد غلطِ سایت.
    const wrong = await prepare(event, [{ role: 'expense-category', key: 'سایر هزینه‌ها', debit: 5_000_000, credit: 0 }, { role: 'cash', debit: 0, credit: 5_000_000 }]);
    assert.equal(wrong.canPost, false);
    assert.ok(directionBlocked(wrong));
    const right = await prepare(queued(RETURN_TEXT, 5_000_000, 'in'), [{ role: 'cash', debit: 5_000_000, credit: 0 }, { role: 'expense-category', key: 'مواد و کالا', debit: 0, credit: 5_000_000 }]);
    assert.equal(directionBlocked(right), false);
  });
});

test('پرداختِ قبضی که پیش‌تر آمده: ورودِ نقد رد، هزینهٔ تازه هم رد؛ جهتِ نامعلوم کنترل جهت ندارد', async () => {
  await inWorkspace(async () => {
    const text = 'قبض برق مهر که اومده بود رو امروز از ملت پرداخت کردیم، ۴ میلیون.';
    const reversed = await prepare(queued(text, 4_000_000, 'out'), [{ role: 'cash', debit: 4_000_000, credit: 0 }, { role: 'income-category', key: 'سایر درآمدها', debit: 0, credit: 4_000_000 }]);
    assert.ok(directionBlocked(reversed));
    // همان پیشنهاد سایت: هزینهٔ دوباره، با کنترل ماهیت «تسویهٔ سند قبلی».
    const doubled = await prepare(queued(text, 4_000_000, 'out'), [{ role: 'expense-category', key: 'قبوض', debit: 4_000_000, credit: 0 }, { role: 'cash', debit: 0, credit: 4_000_000 }]);
    assert.equal(doubled.canPost, false);
    assert.equal(directionBlocked(doubled), false);
    assert.ok(doubled.postingBlockers.some((blocker) => blocker.includes('تسویه طلب یا بدهی قبلی')));
    // پروندهٔ قدیمی بی‌جهت: این کنترل ساکت است و بقیهٔ کنترل‌ها کارشان را می‌کنند.
    const unknown = await prepare(queued('ده میلیون جابه‌جا شد', 10_000_000, null), [{ role: 'cash', debit: 10_000_000, credit: 0 }, { role: 'income-category', key: 'فروش', debit: 0, credit: 10_000_000 }]);
    assert.equal(directionBlocked(unknown), false);
  });
});

const vatBlocked = (result) => result.postingBlockers.some((text) => text.includes('طبق جمله، خالص') || text.includes('سطر ارزش افزوده باید'));

test('«۴۰ میلیون به‌علاوهٔ ۱۰ درصد ارزش افزوده»: جمع سند ۴۴ است؛ مالیاتِ دوباره (۴۸) یا جاافتاده رد می‌شود', async () => {
  await inWorkspace(async () => {
    const buy = 'فاکتور خرید از شرکت پخش گلستان زدیم ۴۰ میلیون تومان به‌علاوهٔ ۱۰ درصد ارزش افزوده، پولش هنوز ندادیم.';
    // همان پیشنهاد سایت.
    const doubled = await prepare(queued(buy, 40_000_000, null), [
      { role: 'inventory-unsplit', key: 'موجودی کالا', debit: 44_000_000, credit: 0 }, { role: 'vat-input', debit: 4_000_000, credit: 0 },
      { role: 'payable', debit: 0, credit: 48_000_000 }]);
    assert.ok(vatBlocked(doubled));
    const dropped = await prepare(queued(buy, 40_000_000, null), [{ role: 'inventory-unsplit', key: 'موجودی کالا', debit: 40_000_000, credit: 0 }, { role: 'payable', debit: 0, credit: 40_000_000 }]);
    assert.ok(vatBlocked(dropped));
    const right = await prepare(queued(buy, 40_000_000, null), [
      { role: 'inventory-unsplit', key: 'موجودی کالا', debit: 40_000_000, credit: 0 }, { role: 'vat-input', debit: 4_000_000, credit: 0 },
      { role: 'payable', debit: 0, credit: 44_000_000 }]);
    assert.equal(vatBlocked(right), false);
    // آینهٔ فروش.
    const sell = 'به شرکت آلفا ۳۰ میلیون به علاوه ۱۰ درصد ارزش افزوده نسیه فروختیم';
    const sale = await prepare(queued(sell, 30_000_000, null), [
      { role: 'receivable', debit: 33_000_000, credit: 0 }, { role: 'income-category', key: 'فروش', debit: 0, credit: 30_000_000 }, { role: 'vat-output', debit: 0, credit: 3_000_000 }]);
    assert.equal(vatBlocked(sale), false);
    const insideSplit = await prepare(queued(sell, 30_000_000, null), [
      { role: 'receivable', debit: 30_000_000, credit: 0 }, { role: 'income-category', key: 'فروش', debit: 0, credit: 27_272_727 }, { role: 'vat-output', debit: 0, credit: 2_727_273 }]);
    assert.ok(vatBlocked(insideSplit));
  });
});

test('منفی: «با احتساب ارزش افزوده» و جملهٔ بی‌درصد این کنترل را روشن نمی‌کنند', async () => {
  await inWorkspace(async () => {
    const inclusive = await prepare(queued('لپ‌تاپ خریدیم ۵۵ میلیون با احتساب ارزش افزوده', 55_000_000, null), [
      { role: 'fixed-asset', key: 'لپ‌تاپ', debit: 50_000_000, credit: 0 }, { role: 'vat-input', debit: 5_000_000, credit: 0 }, { role: 'cash', debit: 0, credit: 55_000_000 }]);
    assert.equal(vatBlocked(inclusive), false);
    const bare = await prepare(queued('فاکتور خرید ۴۰ میلیونی از پخش گلستان زدیم', 40_000_000, null), [
      { role: 'inventory-unsplit', key: 'موجودی کالا', debit: 40_000_000, credit: 0 }, { role: 'payable', debit: 0, credit: 40_000_000 }]);
    assert.equal(vatBlocked(bare), false);
  });
});

test('برداشت شخصیِ کسی که دفتر حساب جاری شریکش را دارد: پیشنهاد «جاری شریک» بسته نمی‌ماند', async () => {
  const { resolveEventRole } = await import('../server/roleResolver.js');
  await inWorkspace(async () => {
    const contact = database.saveContact({ name: 'آقای سعیدی' });
    // صبح همان روز: پول شریک که «پسش می‌دیم».
    resolveEventRole(db(), 'partner-payable', 'آقای سعیدی', { counterparty: 'آقای سعیدی', counterpartyId: contact.id });
    const text = 'آقای سعیدی ۸ میلیون از حساب تجارت برای خرج شخصی خودش برداشت.';
    const event = store.recordFinancialEvent(db(), normalizeFinancialEvent({ kind: 'review-placeholder', amount: 8_000_000, amountReferenceOnly: true,
      occurredAt: '2026-10-26T08:00:00.000Z', source: 'text', evidence: text, utterance: text, counterparty: 'آقای سعیدی', counterpartyId: contact.id, cashDirection: 'out' }),
    { sourceEventId: crypto.randomUUID(), decision: { route: 'accountant-review', guardBlocked: true, reasons: ['مالک یا شریک؟'] }, transcript: text, rawInput: text });
    const result = await prepare(event, [{ role: 'partner-receivable', key: 'آقای سعیدی', debit: 8_000_000, credit: 0 }, { role: 'cash', debit: 0, credit: 8_000_000 }]);
    assert.ok(!result.postingBlockers.some((text) => text.includes('رابطه شریک در متن')), result.postingBlockers.join(' | '));
  });
});

test('برگهٔ فهم: دسته فقط کنار سندی که درآمد یا هزینه دارد؛ آورده و پیش‌دریافت «سایر درآمدها» نمی‌گیرند', async () => {
  const { componentCategoryLabel } = await import('../src/lib/understandingPreview.js');
  const capital = { category: 'سایر درآمدها', preview: { lines: [{ role: 'cash', debit: 1 }, { role: 'owner-capital', credit: 1 }] } };
  const advance = { category: 'سایر درآمدها', preview: { lines: [{ role: 'cash', debit: 1 }, { role: 'customer-advance', credit: 1 }] } };
  const repair = { category: 'تعمیر و نگهداری', preview: { lines: [{ role: 'expense-category', debit: 1 }, { role: 'cash', credit: 1 }] } };
  assert.equal(componentCategoryLabel(capital), '');
  assert.equal(componentCategoryLabel(advance), '');
  assert.equal(componentCategoryLabel(repair), 'تعمیر و نگهداری');
  assert.equal(componentCategoryLabel({ category: 'فروش' }), 'فروش', 'بی‌پیش‌نمایش: همان قبلی');
});
