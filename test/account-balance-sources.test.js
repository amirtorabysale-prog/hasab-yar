// ماندهٔ صندوق و بانک در فهرست حساب‌ها = کارت همان حساب در دفتر کل، از هر راهی که پول جابه‌جا شده.
//
// روی سایت (دفتر آزمایشی، ۴ آبان ۱۴۰۵) فهرست حساب‌ها صندوق را منفی ۳۹٫۲ میلیون نشان
// می‌داد و کارت همان صندوق منفی ۶٫۶۵ میلیون. اختلاف دقیقاً دو سندِ «financial-event» بود:
// موردهای صف که حسابدار سندشان را دستی زد (کلید برق ۴۵۰ هزار، فروش ۳۳ میلیون). این
// سندها ردیف تراکنش ندارند — اگر داشتند منبعشان «transaction» بود — پس ماندهٔ فهرست و
// نگهبان موجودی آن‌ها را نمی‌دیدند: صندوق کمتر از واقع نشان داده می‌شد و پرداختِ بیش از
// موجودی از مسیر صف بی‌پرسش رد می‌شد.
//
// اعضای خانواده: ثبت گفتاری (ردیف تراکنش؛ یک بار، نه دو بار)، سند دستی، سند حسابدار از
// صف، برگشت همان سند، و نگهبان موجودی برای سند حسابدار.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { normalizeFinancialEvent } from '../shared/financialEvent.js';

const databasePath = tempDatabase('account-balance-sources');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'balance-owner';
process.env.ADMIN_PASSWORD = randomBytes(24).toString('base64url');
const database = await import(`../server/db.js?account-balance-sources=${process.pid}`);
const store = await import('../server/financialEventStore.js');
const { resolveEventRole } = await import('../server/roleResolver.js');
database.ensureAdmin();
const owner = database.authenticateUser('balance-owner', process.env.ADMIN_PASSWORD);
const ledger = (name) => {
  const workspace = database.createWorkspace(owner.id, { name, profileType: 'business' });
  return (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
};
const sql = () => database.activeWorkspaceDatabase();
const cashBalance = () => database.listAccounts().find((account) => account.id === 'cash').balance;
const cardBalance = () => database.moneyAccountCard('cash').totals.balance;
test.after(() => removeTempDatabase(databasePath));

/** گفته‌ای که به صف حسابدار رفته؛ سندش را حسابدار دستی می‌زند. */
function queued(text, amount, key) {
  return store.recordFinancialEvent(sql(), normalizeFinancialEvent({ kind: 'review-placeholder', amount, amountReferenceOnly: true,
    occurredAt: '2026-10-21T08:00:00.000Z', source: 'text', evidence: text, utterance: text }),
  { sourceEventId: key, decision: { route: 'accountant-review', guardBlocked: true, reasons: ['سند این گفته با حسابدار است'] }, transcript: text, rawInput: text });
}

test('سند حسابدار از صف که از صندوق پرداخت کرد: فهرست حساب‌ها همان کارت صندوق را می‌گوید', () => {
  const run = ledger('صف و صندوق');
  run(() => {
    database.insertTransactions({ transcript: 'دو میلیون فروش نقد', transactions: [
      { amount: 2_000_000, type: 'income', category: 'فروش', rawText: 'دو میلیون فروش نقد', occurredAt: '2026-10-20T08:00:00.000Z' },
    ] });
    // ثبت گفتاری یک بار شمرده می‌شود.
    assert.equal(cashBalance(), 2_000_000);
    assert.equal(cardBalance(), 2_000_000);
    const event = queued('یه کلید برق ۴۵۰ هزار تومانی خریدیم که کلید سوخته رو عوض کردیم؛ نقد از صندوق', 450_000, 'switch');
    const cash = resolveEventRole(sql(), 'cash', 'cash', { accountId: 'cash' });
    const repair = resolveEventRole(sql(), 'expense-category', 'تعمیر و نگهداری', {});
    const posted = database.recordReviewedComposite(event.id, { reason: 'کلید سوخته تعویض شد؛ تعمیر', lines: [
      { accountId: repair, debit: 450_000, credit: 0 }, { accountId: cash, debit: 0, credit: 450_000 },
    ] });
    assert.equal(cashBalance(), 1_550_000);
    assert.equal(cardBalance(), 1_550_000);
    // برگشت همان سند، ماندهٔ فهرست را هم برمی‌گرداند.
    database.reverseEvent(event.id, 'آزمون برگشت');
    assert.equal(cashBalance(), 2_000_000);
    assert.equal(cardBalance(), 2_000_000);
    assert.ok(posted);
  });
});

test('نگهبان موجودی سند حسابدار از صف را هم می‌سنجد: پرداختِ بیش از صندوق بی‌تأیید رد می‌شود', () => {
  const run = ledger('صف و نگهبان');
  run(() => {
    database.insertTransactions({ transcript: 'یک میلیون فروش نقد', transactions: [
      { amount: 1_000_000, type: 'income', category: 'فروش', rawText: 'یک میلیون فروش نقد', occurredAt: '2026-10-20T08:00:00.000Z' },
    ] });
    const event = queued('سه میلیون تعمیر از صندوق دادیم', 3_000_000, 'overdraw');
    const cash = resolveEventRole(sql(), 'cash', 'cash', { accountId: 'cash' });
    const repair = resolveEventRole(sql(), 'expense-category', 'تعمیر و نگهداری', {});
    assert.throws(() => database.recordReviewedComposite(event.id, { reason: 'تعمیر بیش از موجودی صندوق', lines: [
      { accountId: repair, debit: 3_000_000, credit: 0 }, { accountId: cash, debit: 0, credit: 3_000_000 },
    ] }), (error) => error.code === 'NEGATIVE_BALANCE');
    assert.equal(cashBalance(), 1_000_000);
  });
});
