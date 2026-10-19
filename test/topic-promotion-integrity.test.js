import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';

/**
 * ارتقای برچسب موضوعی نباید دفتر کل را کج کند (بررسی تغییرات z.ai، ۲۸ مهر ۱۴۰۵):
 *
 * ۱. سه «کلید برق» ثبت شد و یکی حذف شد؛ پیشنهاد «۳ بار» گفت و با تأیید، «تعمیرات»
 *    منفی یک میلیون و دستهٔ تازه سه میلیون شد — سند اصلیِ حذف‌شده جابه‌جا شد ولی
 *    سند معکوسش جا ماند.
 * ۲. در ماهِ قفل‌شده سه سطر سند جابه‌جا شد، بی هیچ خطایی.
 * ۳. معینِ تازه بی حساب کل ساخته شد و فایل انتقال پارسیان کد کلش را نداشت.
 * ۴. کد معین «۸۱۵۵» با ارقام فارسی در کدینگ نشست.
 *
 * خانواده: حذف و ویرایش پیش از گشت و میان گشت و تصمیم؛ دورهٔ بسته پیش و پس از
 * گشت؛ برچسب‌زدن دستی روی سند ثبت‌شده؛ هزینه و درآمد؛ کدینگ قالب، کدینگ واردشده
 * با ساختار دیگر، و کدینگِ نصب‌نشده؛ ارقام فارسی و عربی و جداکننده؛ و معین‌های
 * کجی که ارتقاهای پیشین ساخته‌اند.
 */

process.env.DATABASE_PATH = tempDatabase('topic-promotion-integrity');
process.env.ADMIN_USERNAME = 'topic-integrity-owner';
process.env.ADMIN_PASSWORD = 'Quarry-Lantern-Mosaic-8841';
const database = await import('../server/db.js');
const topics = await import('../server/topicPromotion.js');
const { lockAccountingPeriod, periodForDate } = await import('../server/accounting.js');
const { saveChartAccount, topicAnalytic } = await import('../server/chartOfAccounts.js');
database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);

const MILLION = 1_000_000;
let books = 0;
/** هر خانواده دفتر خودش را دارد. `chart: false` یعنی کدینگ نصب نشده. */
function freshBook({ chart = true } = {}) {
  const workspace = database.createWorkspace(owner.id, { name: `دفتر ارتقای برچسب ${++books}`, profileType: 'business' });
  const inBook = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
  let cash = null;
  inBook(() => {
    if (chart) { database.installChartTemplate(); database.applyChartSuggestions(); }
    cash = database.saveAccount({ name: 'صندوق دفتر', kind: 'cash', openingBalance: 500 * MILLION });
  });
  return { inBook, cash };
}
const sql = () => database.activeWorkspaceDatabase();
const balance = (name) => sql().prepare(`SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS b FROM journal_lines jl
  JOIN ledger_accounts la ON la.id=jl.account_id WHERE la.name=?`).get(name).b;
const totals = () => sql().prepare('SELECT SUM(debit) AS debit, SUM(credit) AS credit FROM journal_lines').get();
function post(cash, label, { amount = MILLION, type = 'expense', category = 'تعمیرات' } = {}) {
  const [id] = database.insertTransactions({ transcript: `${label} ${amount}`, transactions: [{
    amount, type, category, rawText: `${label} ${amount}`, accountId: cash.id, occurredAt: new Date().toISOString(),
    userConfirmed: true, clientId: `topic-${Math.random()}`, topicLabel: label,
  }] });
  return id;
}
const sweepOne = () => {
  const ids = topics.topicPromotionSweep(database.db);
  assert.equal(ids.length, 1, 'یک پیشنهاد ارتقا');
  return topics.getTopicPromotion(sql(), ids[0]);
};
const approve = (promotion, extra = {}) => topics.decideTopicPromotion(database.db, promotion.id, { decision: 'approve', reason: 'هر ماه تکرار می‌شود', ...extra });
const lockThisMonth = () => lockAccountingPeriod(sql(), periodForDate(new Date().toISOString(), 'Asia/Tehran'), owner.id);
const chartOf = (name) => sql().prepare(`SELECT c.code, c.level_code AS levelCode, parent.code AS parentCode, parent.level_code AS kolCode
  FROM chart_accounts c LEFT JOIN chart_accounts parent ON parent.id=c.parent_id WHERE c.name=?`).get(name);

// --- ۱. فقط سند زنده ---------------------------------------------------------

test('بازبینی: «کلید برق» حذف‌شده نه به آستانه می‌رسد، نه با ارتقا جابه‌جا می‌شود', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    const ids = [post(cash, 'کلید برق'), post(cash, 'کلید برق'), post(cash, 'کلید برق')];
    database.deleteTransaction(ids[0]);
    // منفی: دو ثبتِ زنده زیر آستانهٔ سه است.
    assert.deepEqual(topics.topicPromotionSweep(database.db), []);
    assert.equal(topics.topicLabelStats(database.db).labels.find((label) => label.name === 'کلید برق').current, 2);
    post(cash, 'کلید برق');
    const promotion = sweepOne();
    assert.equal(promotion.occurrences, 3);
    assert.equal(promotion.migrationCount, 3);
    const before = totals();
    const decided = approve(promotion);
    assert.equal(decided.migratedLines, 3);
    assert.equal(balance('تعمیرات'), 0, 'دستهٔ قدیمی منفی نمی‌شود');
    assert.equal(balance('کلید برق'), 3 * MILLION, 'دستهٔ تازه فقط ثبت‌های زنده را دارد');
    assert.deepEqual(totals(), before);
  });
});

test('ثبتی که میان گشت و تصمیم حذف شده، جابه‌جا نمی‌شود', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    const ids = [post(cash, 'سیم برق'), post(cash, 'سیم برق'), post(cash, 'سیم برق')];
    const promotion = sweepOne();
    database.deleteTransaction(ids[1]);
    assert.equal(approve(promotion).migratedLines, 2);
    assert.equal(balance('تعمیرات'), 0);
    assert.equal(balance('سیم برق'), 2 * MILLION);
  });
});

test('ثبت ویرایش‌شده: هیچ دسته‌ای منفی نمی‌شود و جمع دو دسته همان ثبت‌های زنده است', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    const ids = [post(cash, 'فیوز'), post(cash, 'فیوز'), post(cash, 'فیوز'), post(cash, 'فیوز')];
    database.updateTransaction(ids[0], { amount: 1_200_000 });
    // سطرهای برچسب‌دارِ سندهای زنده؛ نسخهٔ پیش از ویرایش با معکوسش خنثی شده است.
    const liveLabeled = sql().prepare(`SELECT COALESCE(SUM(jl.debit),0) AS total FROM journal_lines jl
      JOIN journal_entries je ON je.id=jl.entry_id JOIN analytic_accounts aa ON aa.id=jl.analytic_id
      WHERE aa.name='فیوز' AND je.entry_kind='normal'
        AND NOT EXISTS (SELECT 1 FROM journal_entries rev WHERE rev.reverses_entry_id=je.id)`).get().total;
    approve(sweepOne());
    assert.equal(balance('فیوز'), liveLabeled, 'نسخهٔ ویرایش‌شده دوبار به دستهٔ تازه نمی‌رود');
    assert.ok(balance('تعمیرات') >= 0, `تعمیرات منفی شد: ${balance('تعمیرات')}`);
    assert.equal(balance('تعمیرات') + balance('فیوز'), 1_200_000 + 3 * MILLION);
  });
});

// --- ۲. دورهٔ بسته -----------------------------------------------------------

test('بازبینی: دوره‌ای که پس از گشت بسته شده دست نمی‌خورد، ولی دسته و معین ساخته می‌شوند', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    post(cash, 'لامپ'); post(cash, 'لامپ'); post(cash, 'لامپ');
    const promotion = sweepOne();
    lockThisMonth();
    const decided = approve(promotion);
    assert.equal(decided.migratedLines, 0);
    assert.equal(decided.keptLockedLines, 3);
    assert.equal(balance('تعمیرات'), 3 * MILLION, 'سندهای دورهٔ بسته سر جایشان ماندند');
    assert.equal(decided.status, 'approved');
    assert.ok(sql().prepare("SELECT 1 FROM categories WHERE name='لامپ'").get(), 'دستهٔ تازه برای ثبت‌های بعدی ساخته شد');
    assert.equal(chartOf('لامپ')?.parentCode, '81');
  });
});

test('دورهٔ بسته پیش از گشت: پیشنهاد می‌آید ولی می‌گوید چیزی جابه‌جا نمی‌شود', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    post(cash, 'پریز'); post(cash, 'پریز'); post(cash, 'پریز');
    lockThisMonth();
    const promotion = sweepOne();
    assert.equal(promotion.migrationCount, 0);
    assert.equal(promotion.lockedLineCount, 3);
  });
});

test('برچسب دستی روی سندِ دورهٔ بسته رد می‌شود و هیچ چیز عوض نمی‌شود', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    const id = post(cash, 'کابل');
    lockThisMonth();
    assert.throws(() => topics.setTransactionTopicLabel(id, 'کابل شبکه'), (error) => error.code === 'ACCOUNTING_PERIOD_LOCKED');
    assert.equal(sql().prepare('SELECT topic_label AS label FROM transactions WHERE id=?').get(id).label, 'کابل');
    const analytic = sql().prepare(`SELECT aa.name FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
      JOIN analytic_accounts aa ON aa.id=jl.analytic_id WHERE je.source_id=?`).get(id);
    assert.equal(analytic?.name, 'کابل');
  });
});

test('برچسب دستی روی ثبتِ حذف‌شده فقط ستون را عوض می‌کند، نه سندِ معکوس‌شده را', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    const id = post(cash, 'چراغ');
    database.deleteTransaction(id);
    const result = topics.setTransactionTopicLabel(id, 'چراغ سقفی');
    assert.equal(result.attachedToPostedLines, 0);
    assert.equal(balance('تعمیرات'), 0);
  });
});

// --- ۳. معین زیر حساب کل ----------------------------------------------------

test('بازبینی: معینِ تازه زیر حساب کلِ همان دسته است و کد کل برای پارسیان دارد', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    post(cash, 'کلید برق'); post(cash, 'کلید برق'); post(cash, 'کلید برق');
    const promotion = sweepOne();
    assert.equal(promotion.suggestedCode, '8121');
    assert.equal(approve(promotion, { categoryName: 'تجهیزات برقی' }).chartCode, '8121');
    // کد کلِ فایل انتقال همان کد کلِ معین‌های خواهر است («تعمیر و نگهداری»).
    const sibling = chartOf('تعمیر و نگهداری');
    assert.match(sibling.kolCode, /^\d+$/);
    assert.deepEqual({ ...chartOf('تجهیزات برقی') }, { code: '8121', levelCode: '21', parentCode: '81', kolCode: sibling.kolCode });
  });
});

test('جهت وارونه: ارتقای برچسب درآمد زیر کلِ درآمد می‌نشیند', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    for (let index = 0; index < 3; index += 1) post(cash, 'اجاره پارکینگ', { type: 'income', category: 'سایر درآمدها' });
    const decided = approve(sweepOne());
    assert.equal(decided.chartCode, '6204');
    assert.equal(chartOf('اجاره پارکینگ')?.parentCode, '62');
    assert.equal(balance('سایر درآمدها'), 0);
    assert.equal(balance('اجاره پارکینگ'), -3 * MILLION);
  });
});

test('کدینگ واردشده با ساختار دیگر: معین بعدیِ همان کل، هم‌طول خواهرانش', () => {
  const { inBook, cash } = freshBook({ chart: false });
  inBook(() => {
    const raw = sql();
    saveChartAccount(raw, { code: '8', name: 'هزینه‌ها', level: 'group', type: 'expense' });
    saveChartAccount(raw, { code: '801', name: 'هزینه‌های اداری', level: 'general', type: 'expense', parentCode: '8' });
    const repairs = saveChartAccount(raw, { code: '80101', name: 'تعمیرات', level: 'subsidiary', type: 'expense', parentCode: '801' });
    post(cash, 'باتری'); post(cash, 'باتری'); post(cash, 'باتری');
    const ledger = raw.prepare("SELECT id FROM ledger_accounts WHERE source_kind='expense-category' AND name='تعمیرات'").get();
    database.mapLedgerAccount(ledger.id, repairs.id);
    const promotion = sweepOne();
    assert.equal(promotion.suggestedCode, '80102');
    approve(promotion);
    assert.deepEqual({ ...chartOf('باتری') }, { code: '80102', levelCode: '02', parentCode: '801', kolCode: '01' });
  });
});

test('کدینگِ نصب‌نشده: دسته و انتقال انجام می‌شود ولی معینِ یتیم ساخته نمی‌شود', () => {
  const { inBook, cash } = freshBook({ chart: false });
  inBook(() => {
    post(cash, 'روغن'); post(cash, 'روغن'); post(cash, 'روغن');
    const decided = approve(sweepOne());
    assert.equal(decided.chartCode, null);
    assert.equal(sql().prepare('SELECT COUNT(*) AS n FROM chart_accounts').get().n, 0);
    assert.equal(balance('روغن'), 3 * MILLION);
  });
});

// --- ۴. کد معین -------------------------------------------------------------

test('بازبینی: کد معین با ارقام فارسی، عربی و جداکننده همان کد لاتین است', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    for (const label of ['قفل', 'لولا', 'دستگیره']) { post(cash, label); post(cash, label); post(cash, label); }
    const promotions = topics.topicPromotionSweep(database.db).map((id) => topics.getTopicPromotion(sql(), id));
    const byLabel = Object.fromEntries(promotions.map((item) => [item.label, item]));
    approve(byLabel['قفل'], { chartCode: '۸۱۵۵' });
    approve(byLabel['لولا'], { chartCode: '٨١٥٦' });
    approve(byLabel['دستگیره'], { chartCode: '81-57' });
    assert.deepEqual([chartOf('قفل').code, chartOf('لولا').code, chartOf('دستگیره').code], ['8155', '8156', '8157']);
    assert.equal(chartOf('قفل').parentCode, '81');
    assert.equal(chartOf('قفل').levelCode, '55');
  });
});

test('کد نامعتبر یا خارج از کلِ هم‌نوع رد می‌شود و هیچ چیز ساخته نمی‌شود', () => {
  const { inBook, cash } = freshBook();
  inBook(() => {
    post(cash, 'رنگ'); post(cash, 'رنگ'); post(cash, 'رنگ');
    const promotion = sweepOne();
    assert.throws(() => approve(promotion, { chartCode: 'ab12' }), (error) => error.code === 'INVALID_INPUT');
    assert.throws(() => approve(promotion, { chartCode: '6299' }));
    assert.equal(sql().prepare("SELECT COUNT(*) AS n FROM categories WHERE name='رنگ'").get().n, 0);
    assert.equal(topics.getTopicPromotion(sql(), promotion.id).status, 'pending');
    assert.equal(balance('تعمیرات'), 3 * MILLION);
  });
});

// --- معین‌های کجِ ارتقاهای پیشین ---------------------------------------------

test('معینِ بی‌کل و رقم فارسیِ ارتقاهای پیشین یک بار سر جایش می‌نشیند؛ کدینگ دستی دست نمی‌خورد', () => {
  const { inBook } = freshBook();
  inBook(() => {
    const raw = sql();
    topics.ensureTopicPromotionSchema(raw);
    const insertChart = raw.prepare(`INSERT INTO chart_accounts (id,code,name,level,type,normal_side,role,level_code,active,source)
      VALUES (?,?,?,'subsidiary','expense','debit','',?,1,'manual')`);
    insertChart.run('old-promotion-chart', '۸۱۹۰', 'ابزار برقی', '۸۱۹۰');
    insertChart.run('hand-made-orphan', '8195', 'حساب دستی', '8195');
    const analytic = topicAnalytic(raw, 'ابزار برقی');
    raw.prepare(`INSERT INTO topic_promotions (id,analytic_id,label,period,occurrences,threshold,status,chart_code,category_name)
      VALUES ('old-promotion',?,'ابزار برقی','1405-07',3,3,'approved','۸۱۹۰','ابزار برقی')`).run(analytic.id);
    topics.listTopicPromotions(database.db);
    assert.deepEqual({ ...chartOf('ابزار برقی') }, { code: '8190', levelCode: '90', parentCode: '81', kolCode: chartOf('تعمیر و نگهداری').kolCode });
    assert.equal(topics.getTopicPromotion(raw, 'old-promotion').chartCode, '8190');
    assert.equal(chartOf('حساب دستی').parentCode, null, 'معینی که ارتقا نساخته، دست نمی‌خورد');
    assert.equal(topics.repairPromotionChartAccounts(raw), 0, 'اجرای دوباره کاری نمی‌کند');
  });
});
