import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

/**
 * پولی که جابه‌جا نشده، ماندهٔ صندوق و بانک را تکان نمی‌دهد (قاعدهٔ ۴؛ صف حسابدار، ۲۹ مهر ۱۴۰۵).
 *
 * دیده‌شده در Chrome: تأییدِ T18 (قبضِ پرداخت‌نشده) برگهٔ «موجودی منفی می‌شود: صندوق ۰ ← −۴٬۰۰۰٬۰۰۰»
 * را باز کرد، در حالی که سندش هزینه در برابر بدهی بود. ریشه: ردیفِ `unpaidSignal` با حساب صندوق
 * ذخیره می‌شد و ماندهٔ صندوق از جمعِ ردیف‌ها حساب می‌شود. خانواده: قبض با موعد، پرداختِ آینده،
 * خرید نسیه با «هنوز ندادیم»، کارِ تحویل‌شده که مشتری هنوز نداده (طلب)، و ردیف‌های قدیمیِ ذخیره‌شده.
 * منفی: پرداختِ انجام‌شده همان ردیف نقدی است.
 */

process.env.DATABASE_PATH = tempDatabase('unpaid-no-cash-row');
process.env.ADMIN_USERNAME = 'unpaid-owner';
process.env.ADMIN_PASSWORD = 'Quarry-Lantern-Harbor-5512';
const database = await import('../server/db.js');
const { parseFinancialText } = await import('../shared/parser.js');
const { detachUnpaidCashRows } = await import('../server/financialEventStore.js');
database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);

let books = 0;
const inBook = (callback) => {
  const workspace = database.createWorkspace(owner.id, { name: `دفتر بی‌ردیف نقدی ${++books}`, profileType: 'business' });
  return database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, () => {
    database.installChartTemplate();
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true });
    database.saveAccount({ id: 'cash', name: 'صندوق نقدی', kind: 'cash', openingBalance: 100_000_000 });
    return callback();
  });
};
const cashBalance = () => database.listAccounts().find((account) => account.id === 'cash').balance;
const capture = (text) => database.insertTransactions({ transcript: text, transactions: parseFinancialText(text).transactions.map((item, index) => ({ ...item, clientId: `${text.length}-${index}-${Math.random()}` })) });
const cashRows = () => database.activeWorkspaceDatabase().prepare("SELECT amount FROM transactions WHERE account_id IS NOT NULL AND status!='deleted'").all();

test('پولِ پرداخت‌نشده ردیف نقدی نمی‌سازد و ماندهٔ صندوق را تکان نمی‌دهد — حتی پس از تأیید', () => {
  for (const text of [
    'قبض برق مهر مغازه ۴ میلیون تومان اومده ولی قراره تا آبان پرداختش کنیم.',
    'قبض برق و گاز کارگاه اومده نه میلیون، موعد پرداختش هفته بعده',
    'فاکتور خرید از شرکت پخش گلستان زدیم ۴۰ میلیون تومان به‌علاوهٔ ۱۰ درصد ارزش افزوده، پولش هنوز ندادیم.',
    'پروژه رو تحویل دادیم ولی کارفرما هنوز ۲۰ میلیون رو نداده',
  ]) {
    inBook(() => {
      const result = capture(text);
      assert.deepEqual(cashRows(), [], `ردیف نقدی: ${text}`);
      assert.equal(cashBalance(), 100_000_000, `ماندهٔ صندوق پیش از تأیید: ${text}`);
      for (const pending of database.reviewQueue({ limit: 20 }).items.filter((item) => item.approvalNextStep === 'approve')) {
        database.approveEvent(pending.id);
      }
      assert.equal(cashBalance(), 100_000_000, `ماندهٔ صندوق پس از تأیید: ${text}`);
      assert.ok(result.nonCash?.length || result.queuedForAccountant, `تعهد یا صف: ${text}`);
    });
  }
});

test('پرداختِ انجام‌شده همان ردیف نقدی است', () => {
  inBook(() => {
    capture('قبض برق ۴ میلیون پرداخت کردیم');
    assert.deepEqual(cashRows().map((row) => row.amount), [4_000_000]);
    for (const pending of database.reviewQueue({ limit: 20 }).items.filter((item) => item.approvalNextStep === 'approve')) database.approveEvent(pending.id);
    assert.equal(cashBalance(), 96_000_000);
  });
});

test('ردیفِ قدیمیِ «بدهی باز» که با حساب صندوق ذخیره شده بود، از صندوق جدا می‌شود؛ سند دست نمی‌خورد', () => {
  inBook(() => {
    capture('قبض برق ۴ میلیون پرداخت کردیم');
    const db = database.activeWorkspaceDatabase();
    // همان شکلی که پیش از اصلاح ذخیره می‌شد: رویدادِ بدهی باز روی ردیفِ صندوق.
    const event = db.prepare("SELECT id,source_event_id FROM financial_events WHERE source_event_id LIKE 'transaction:%'").get();
    db.prepare("UPDATE financial_events SET kind='payable-opened' WHERE id=?").run(event.id);
    const before = db.prepare('SELECT COUNT(*) AS count FROM journal_lines').get().count;
    detachUnpaidCashRows(db);
    detachUnpaidCashRows(db);
    assert.deepEqual(cashRows(), []);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM journal_lines').get().count, before);
  });
});
