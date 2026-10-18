import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { normalizeFinancialEvent } from '../shared/financialEvent.js';
import { ROLES } from '../shared/accountingRules.js';
import { resolveEventAnalytic } from '../server/roleResolver.js';
import {
  TOPIC_SOURCE_KIND, topicAnalytic, normalizeTopicLabel, listAnalyticAccounts,
} from '../server/chartOfAccounts.js';
import {
  topicLabelStats, topicPromotionSweep, listTopicPromotions, decideTopicPromotion,
  setTransactionTopicLabel, topicPromotionThreshold, saveTopicPromotionThreshold,
} from '../server/topicPromotion.js';
import { insertTransactionRows } from '../server/db/transactions.js';
import { db } from '../server/db/core.js';

const databasePath = tempDatabase('topic-promotion');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'topic-owner';
process.env.ADMIN_PASSWORD = 'Topic-Promotion-Long-Pass-7719';

const database = await import(`../server/db.js?topic=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('topic-owner', 'Topic-Promotion-Long-Pass-7719');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر برچسب', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

/** ثبت مستقیم یک ردیف هزینهٔ برچسب‌دار — از همان مسیری که موتور واقعی می‌رود. */
function postLabeledExpense({ label, category = 'سایر هزینه‌ها', amount = 120_000 }) {
  return insertTransactionRows({
    transcript: label,
    transactions: [{ amount, type: 'expense', category, rawText: label, topicLabel: label }],
  });
}

const linesOf = (labelName) => db.prepare(`SELECT jl.id AS lineId, jl.entry_id AS entryId, jl.account_id AS accountId,
    la.source_kind AS sourceKind, aa.name AS analyticName
  FROM journal_lines jl
  JOIN analytic_accounts aa ON aa.id=jl.analytic_id
  JOIN ledger_accounts la ON la.id=jl.account_id
  WHERE aa.name=?`).all(labelName);

test('برچسب موضوعی یک تفصیلیِ تکرارپذیر است، نه دسته', () => {
  inWorkspace(() => {
    const first = topicAnalytic(db, 'کلید برق');
    const again = topicAnalytic(db, 'کلید   برق');
    assert.equal(first.id, again.id, 'نرمال‌سازی فاصله باید همان برچسب را برگرداند');
    assert.equal(first.source_kind, TOPIC_SOURCE_KIND);
    assert.equal(normalizeTopicLabel('  کلید\u200cبرق  '), 'کلید برق');
  });
});

test('رویداد برچسب را حمل می‌کند و فقط سطر دسته تفصیلی موضوعی می‌گیرد', () => {
  inWorkspace(() => {
    const event = normalizeFinancialEvent({
      kind: 'cash-expense', amount: 10_000, occurredAt: new Date().toISOString(),
      category: 'سایر هزینه‌ها', topicLabel: 'کلید برق',
    });
    assert.equal(event.topicLabel, 'کلید برق');
    const analyticId = resolveEventAnalytic(db, ROLES.EXPENSE_CATEGORY, event);
    assert.ok(analyticId, 'سطر دسته باید برچسب بگیرد');
    assert.equal(resolveEventAnalytic(db, ROLES.CASH, event), null, 'سطر نقد برچسب نمی‌گیرد');
    assert.equal(resolveEventAnalytic(db, ROLES.PAYABLE, event), null, 'نقشِ طرف حساب برچسب نمی‌گیرد');
  });
});

test('سه ثبتِ هم‌برچسب در ماه، یک پیشنهاد ارتقا می‌سازد — و اجرای دوباره تکراری نمی‌سازد', () => {
  inWorkspace(() => {
    database.installChartTemplate();
    database.applyChartSuggestions();
    for (let index = 0; index < 3; index += 1) postLabeledExpense({ label: 'کلید برق', amount: 150_000 + index });

    // برچسب روی سطرِ دسته نشسته باشد.
    const lines = linesOf('کلید برق');
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.equal(line.analyticName, 'کلید برق');
      assert.equal(line.sourceKind, 'expense-category', 'برچسب روی سطر دسته است، نه سطر نقد');
    }

    const stats = topicLabelStats(db);
    const label = stats.labels.find((item) => item.name === 'کلید برق');
    assert.equal(label.current, 3);
    assert.equal(label.crossedThreshold, true);
    assert.equal(topicPromotionThreshold(db), 3, 'پیش‌فرض آستانه ۳ است');

    const [firstId] = topicPromotionSweep(db);
    assert.ok(firstId, 'پیشنهاد ارتقا باید ساخته شود');
    assert.equal(topicPromotionSweep(db).length, 0, 'اجرای دوباره پیشنهاد تازه نمی‌سازد');

    const [promotion] = listTopicPromotions(db);
    assert.equal(promotion.status, 'pending');
    assert.equal(promotion.label, 'کلید برق');
    assert.equal(promotion.occurrences, 3);
    assert.equal(promotion.migrationCount, 3, 'سه سطرِ دسته برای انتقال پیشنهاد شده');
    assert.equal(promotion.suggestedCode, '8121', 'کد پیشنهادی ادامهٔ سقف قالب استاندارد است، نه برخوردی با آن');
  });
});

test('زیر آستانه، پیشنهادی ساخته نمی‌شود', () => {
  inWorkspace(() => {
    for (let index = 0; index < 2; index += 1) postLabeledExpense({ label: 'کابل شارژ', amount: 80_000 });
    assert.equal(topicPromotionSweep(db).length, 0);
    const stats = topicLabelStats(db);
    const label = stats.labels.find((item) => item.name === 'کابل شارژ');
    assert.equal(label.current, 2);
    assert.equal(label.crossedThreshold, undefined);
  });
});

test('تأیید ارتقا: دسته + معین کدینگ + انتقال ثبت‌های قبلی + یادگیری — همه یک‌جا', () => {
  inWorkspace(() => {
    const [promotion] = listTopicPromotions(db).filter((item) => item.status === 'pending');
    assert.ok(promotion, 'پیشنهاد در انتظار باشد');
    const balancesBefore = db.prepare(`SELECT SUM(jl.debit) AS debit, SUM(jl.credit) AS credit FROM journal_lines jl`).get();

    const decided = decideTopicPromotion(db, promotion.id, {
      decision: 'approve', reason: 'هر ماه چند بار خرج برق‌آلات داریم', categoryName: 'تجهیزات برقی',
    });

    // دستهٔ جدید
    const category = db.prepare(`SELECT id FROM categories WHERE name='تجهیزات برقی'`).get();
    assert.ok(category, 'دستهٔ جدید ساخته شد');

    // معین کدینگ و نگاشت
    assert.ok(decided.chartCode, 'کد معین ثبت شد');
    const chart = db.prepare('SELECT id,level,type FROM chart_accounts WHERE code=?').get(decided.chartCode);
    assert.ok(chart, 'حساب کدینگ ساخته شد');
    assert.equal(chart.level, 'subsidiary');
    assert.equal(chart.type, 'expense');

    // حساب دفتر کل دستهٔ جدید و انتقال سطرها
    const ledger = db.prepare(`SELECT id FROM ledger_accounts WHERE source_kind='expense-category' AND source_key='تجهیزات برقی'`).get();
    assert.ok(ledger, 'حساب دفتر کل دستهٔ جدید ساخته شد');
    const mapped = db.prepare('SELECT chart_account_id AS id FROM ledger_accounts WHERE id=?').get(ledger.id);
    assert.equal(mapped.id, chart.id, 'حساب جدید به معین تازه نگاشت شد — نگاشتِ خالی خروجی را قفل می‌کند');

    const migrated = linesOf('کلید برق');
    assert.equal(migrated.length, 3);
    for (const line of migrated) assert.equal(line.accountId, ledger.id, 'سطر قبلی به دستهٔ جدید منتقل شد');

    // دستهٔ خودِ تراکنش هم تازه شده باشد
    const transactionCategories = db.prepare(`SELECT DISTINCT category FROM transactions WHERE raw_text LIKE '%کلید برق%'`).all();
    assert.deepEqual(transactionCategories.map((row) => row.category), ['تجهیزات برقی']);

    // یادگیری واژه
    const learning = db.prepare(`SELECT category FROM learnings WHERE keyword='کلید برق'`).get();
    assert.equal(learning?.category, 'تجهیزات برقی', 'واژه یاد گرفته شد تا ثبت‌های بعدی خودشان بروند');

    // توازن دست نخورده باشد
    const balancesAfter = db.prepare(`SELECT SUM(jl.debit) AS debit, SUM(jl.credit) AS credit FROM journal_lines jl`).get();
    assert.equal(balancesAfter.debit, balancesBefore.debit);
    assert.equal(balancesAfter.credit, balancesBefore.credit);

    assert.equal(decided.status, 'approved');
    assert.equal(decided.migratedLines, 3);
  });
});

test('رد ارتقا: هیچ ساختاری ساخته نمی‌شود و دیگر پرسیده نمی‌شود', () => {
  inWorkspace(() => {
    for (let index = 0; index < 3; index += 1) postLabeledExpense({ label: 'فن صنعتی', amount: 300_000 });
    const [promotionId] = topicPromotionSweep(db);
    assert.ok(promotionId);
    const before = db.prepare(`SELECT id FROM categories WHERE name='فن صنعتی'`).get();
    assert.equal(before, undefined);

    const decided = decideTopicPromotion(db, promotionId, { decision: 'reject', reason: 'مصرف اتفاقی است، دسته لازم ندارد' });
    assert.equal(decided.status, 'rejected');
    assert.equal(db.prepare(`SELECT id FROM categories WHERE name='فن صنعتی'`).get(), undefined);
    assert.equal(topicPromotionSweep(db).length, 0, 'برچسبِ ردشده دوباره پیشنهاد نمی‌شود');
  });
});

test('برچسبِ دستی روی سندِ ثبت‌شده همان مسیر را باز می‌کند', () => {
  inWorkspace(() => {
    const [id] = postLabeledExpense({ label: '', category: 'سایر هزینه‌ها', amount: 55_000 });
    const entry = db.prepare(`SELECT id FROM journal_entries WHERE source_type='transaction' AND source_id=? AND entry_kind='normal'`).get(id);
    assert.ok(entry, 'سند تراکنش ثبت شده باشد');
    const before = db.prepare(`SELECT analytic_id FROM journal_lines jl
      JOIN ledger_accounts la ON la.id=jl.account_id
      WHERE jl.entry_id=? AND la.source_kind='expense-category'`).get(entry.id);
    assert.equal(before.analytic_id, null);

    const result = setTransactionTopicLabel(id, 'کابل شارژ');
    assert.equal(result.attachedToPostedLines, 1, 'برچسب به سندِ ثبت‌شده چسبید');
    const after = db.prepare(`SELECT analytic_id FROM journal_lines jl
      JOIN ledger_accounts la ON la.id=jl.account_id
      WHERE jl.entry_id=? AND la.source_kind='expense-category'`).get(entry.id);
    assert.ok(after.analytic_id);
    const label = listAnalyticAccounts(db).find((item) => item.id === after.analytic_id);
    assert.equal(label.name, 'کابل شارژ');

    // حذف برچسب، سند را پاک می‌کند.
    const cleared = setTransactionTopicLabel(id, '');
    assert.equal(cleared.topicLabel, '');
    const afterClear = db.prepare(`SELECT analytic_id FROM journal_lines jl
      JOIN ledger_accounts la ON la.id=jl.account_id
      WHERE jl.entry_id=? AND la.source_kind='expense-category'`).get(entry.id);
    assert.equal(afterClear.analytic_id, null);
  });
});

test('برچسب‌زدنِ ثبتِ قدیمیِ همان برچسب، پس از ارتقا به دستهٔ تازه منتقلش می‌کند', () => {
  inWorkspace(() => {
    // ثبتِ قدیمی بی‌برچسب، هم‌موضوع با برچسبِ ارتقایافته
    const [oldId] = postLabeledExpense({ label: '', category: 'سایر هزینه‌ها', amount: 44_000 });
    const result = setTransactionTopicLabel(oldId, 'کلید برق');
    assert.equal(result.migratedLines, 1, 'سطرِ قدیمی به دستهٔ ارتقایافته منتقل شد');
    const ledger = db.prepare(`SELECT id FROM ledger_accounts WHERE source_kind='expense-category' AND source_key='تجهیزات برقی'`).get();
    const entry = db.prepare(`SELECT id FROM journal_entries WHERE source_type='transaction' AND source_id=? AND entry_kind='normal'`).get(oldId);
    const line = db.prepare(`SELECT account_id FROM journal_lines jl JOIN ledger_accounts la ON la.id=jl.account_id
      WHERE jl.entry_id=? AND la.source_kind='expense-category'`).get(entry.id);
    assert.equal(line.account_id, ledger.id);
    assert.equal(db.prepare('SELECT category FROM transactions WHERE id=?').get(oldId).category, 'تجهیزات برقی');
  });
});

test('آستانهٔ ارتقا قابل تنظیم است و مرزشguard دارد', () => {
  inWorkspace(() => {
    assert.equal(saveTopicPromotionThreshold(5), 5);
    assert.equal(topicPromotionThreshold(db), 5);
    assert.throws(() => saveTopicPromotionThreshold(1), /۲ تا ۵۰/);
    saveTopicPromotionThreshold(3);
  });
});

test.after(() => removeTempDatabase(databasePath));
