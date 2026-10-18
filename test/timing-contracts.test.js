import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

/**
 * بخش «پیش‌پرداخت و پیش‌دریافت» (مالک محصول، ۲۳ مهر ۱۴۰۵).
 *
 * «این موارد پیش‌دریافت و پیش‌پرداخت باید یک بخش مشخص داشته باشند که معلوم باشد و
 * هرکدام سر تایم خودش برود توی هزینه یا درآمدی که باید، البته با اعلام به حسابدار»
 * — و «خبر بده کافیه». پس: فهرست همهٔ قراردادهای دوره‌دار با مانده و قسط بعدی، ثبت
 * خودکار سر موعد (همان کار دقیقه‌ای) و خبرِ ماهانه برای حسابدار، بی‌تأییدِ تک‌تکِ اقلام.
 */
process.env.DATABASE_PATH = tempDatabase('timing-contracts');
process.env.ADMIN_USERNAME = 'timing-owner';
process.env.ADMIN_PASSWORD = 'timing-strong-password-5521';
const database = await import('../server/db.js');
const store = await import('../server/financialEventStore.js');
database.ensureAdmin();
const owner = database.authenticateUser('timing-owner', 'timing-strong-password-5521');
const ISSUED = '2026-10-10T08:00:00.000Z';

let count = 0;
function inWorkspace(callback) {
  const workspace = database.createWorkspace(owner.id, { name: `دفتر دوره‌دار ${++count}`, profileType: 'business' });
  return database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, () => {
    database.installChartTemplate();
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true });
    return callback();
  });
}
const contracts = () => database.timingContracts();

function twoContracts() {
  const insurance = database.createInvoice({ documentType: 'purchase', category: 'بیمه', customerName: 'بیمه ایران',
    items: [{ title: 'حق بیمه آتش سوزی یکساله انبار', unitPrice: 12_000_000 }], issueNow: true, issuedAt: ISSUED });
  const support = database.createInvoice({ documentType: 'sales', category: 'خدمات', customerName: 'شرکت آلفا',
    items: [{ title: 'اشتراک دوازده ماهه نرم افزار (مهر ۱۴۰۵ تا شهریور ۱۴۰۶)', unitPrice: 36_000_000 }], issueNow: true, issuedAt: ISSUED });
  return { insurance, support };
}

test('فهرست: هر پیش‌پرداخت و پیش‌دریافت با مبلغ کل، مانده، قسط بعدی و حسابش', () => inWorkspace(() => {
  twoContracts();
  const { items, summary } = contracts();
  const prepaid = items.find((item) => item.kind === 'prepaid');
  const deferred = items.find((item) => item.kind === 'deferred');
  assert.deepEqual([prepaid.total, prepaid.recognized, prepaid.remaining, prepaid.instalments, prepaid.state], [12_000_000, 0, 12_000_000, 12, 'active']);
  assert.match(prepaid.title, /بیمه/);
  assert.match(prepaid.account, /پیش‌پرداخت/);
  assert.equal(prepaid.next.amount, 1_000_000);
  assert.equal(prepaid.periodFrom, '1405-07');
  assert.deepEqual([deferred.total, deferred.instalments, deferred.next.amount, deferred.counterparty], [36_000_000, 12, 3_000_000, 'شرکت آلفا']);
  assert.match(deferred.account, /درآمد انتقالی/);
  assert.deepEqual(summary, { prepaidRemaining: 12_000_000, deferredRemaining: 36_000_000, prepaidActive: 1, deferredActive: 1 });
}));

test('ثبت سر موعد: هر قلمِ ثبت‌شده به خبرِ ماهِ خودش می‌رود و در صف حسابدار دیده می‌شود؛ «دیدم» آن را از صف برمی‌دارد', () => inWorkspace(() => {
  twoContracts();
  assert.deepEqual(database.reviewQueue().recognitionNotices, [], 'پیش از هر ثبت، خبری نیست');
  const run = store.postDueRecognitionItems(database.activeWorkspaceDatabase(), { today: '2026-12-15T00:00:00.000Z' });
  assert.equal(run.posted, 6, 'مهر، آبان و آذرِ هر دو قرارداد');
  const notices = database.reviewQueue().recognitionNotices;
  assert.deepEqual(notices.map((notice) => notice.periodKey), ['1405-09', '1405-08', '1405-07']);
  for (const notice of notices) {
    assert.deepEqual([notice.postedItems, notice.expenseAmount, notice.incomeAmount, notice.seenAt], [2, 1_000_000, 3_000_000, null]);
    assert.equal(notice.contracts.length, 2);
  }
  // دوباره اجرا: سند و خبرِ تکراری نمی‌سازد.
  store.postDueRecognitionItems(database.activeWorkspaceDatabase(), { today: '2026-12-15T00:00:00.000Z' });
  assert.equal(database.reviewQueue().recognitionNotices.find((notice) => notice.periodKey === '1405-07').postedItems, 2);

  const prepaid = contracts().items.find((item) => item.kind === 'prepaid');
  assert.deepEqual([prepaid.recognized, prepaid.remaining, prepaid.postedInstalments, prepaid.next.periodKey], [3_000_000, 9_000_000, 3, '1405-10']);

  const seen = database.seeRecognitionNotice('1405-07').item;
  assert.ok(seen.seenAt);
  assert.deepEqual(database.reviewQueue().recognitionNotices.map((notice) => notice.periodKey), ['1405-09', '1405-08']);
  assert.equal(contracts().notices.length, 3, 'بخش دوره‌دار تاریخچهٔ خبرها را نگه می‌دارد');
  assert.throws(() => database.seeRecognitionNotice('1399-01'), { code: 'RECOGNITION_NOTICE_MISSING' });
}));

test('قلم تازه در ماهی که خبرش دیده شده، خبر را دوباره «دیده‌نشده» می‌کند', () => inWorkspace(() => {
  twoContracts();
  store.postDueRecognitionItems(database.activeWorkspaceDatabase(), { today: '2026-10-20T00:00:00.000Z' });
  database.seeRecognitionNotice('1405-07');
  database.createInvoice({ documentType: 'purchase', category: 'نرم‌افزار و اشتراک', customerName: 'شرکت نرم افزاری',
    items: [{ title: 'لایسنس یک ساله نرم افزار (مهر ۱۴۰۵ تا شهریور ۱۴۰۶)', unitPrice: 24_000_000 }], issueNow: true, issuedAt: ISSUED });
  store.postDueRecognitionItems(database.activeWorkspaceDatabase(), { today: '2026-10-20T00:00:00.000Z' });
  const [notice] = database.reviewQueue().recognitionNotices;
  assert.deepEqual([notice.periodKey, notice.postedItems, notice.expenseAmount, notice.seenAt], ['1405-07', 3, 3_000_000, null]);
}));

test('قرارداد لغوشده در فهرست می‌ماند ولی در جمع مانده‌ها نمی‌آید', () => inWorkspace(() => {
  const { insurance } = twoContracts();
  database.deleteInvoice(insurance.id);
  const prepaid = contracts().items.find((item) => item.kind === 'prepaid');
  assert.equal(prepaid.state, 'cancelled');
  assert.equal(contracts().summary.prepaidRemaining, 0);
  assert.equal(contracts().summary.deferredRemaining, 36_000_000);
}));

test('دسترسی: دیدن بخش در محیط ساده هم هست؛ «دیدم» کار حسابدار است', async () => {
  const { minimumRoleForRequest } = await import('../server/access.js');
  const { pathNeedsProfessional } = await import('../shared/experience.js');
  assert.equal(minimumRoleForRequest('GET', '/timing-contracts'), 'viewer');
  assert.equal(minimumRoleForRequest('POST', '/timing-contracts/notices/1405-07/seen'), 'accountant');
  assert.equal(pathNeedsProfessional('/timing-contracts'), false);
});

test('رابط: بخش با دادهٔ واقعیِ سرور، مانده‌ها، قسط بعدی، خبرِ دیده‌نشده و «نیاز به اقدام» را نشان می‌دهد', async () => {
  const data = inWorkspace(() => {
    twoContracts();
    store.postDueRecognitionItems(database.activeWorkspaceDatabase(), { today: '2026-10-20T00:00:00.000Z' });
    return contracts();
  });
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { TimingContractsView } = await vite.ssrLoadModule('/src/features/ledger/TimingContractsPanel.jsx');
    // خواستهٔ مالک (۲۶ مهر ۱۴۰۵): دو زبانهٔ جدای پیش‌پرداخت/پیش‌دریافت در بالای صفحه.
    const html = renderToStaticMarkup(React.createElement(TimingContractsView, { data }));
    for (const text of ['پیش‌پرداخت‌ها', 'پیش‌دریافت‌ها', 'ماندهٔ پیش‌پرداخت‌ها', 'قسط بعدی: آبان ۱۴۰۵', 'مهر ۱۴۰۵: ۲ قسط خودکار ثبت شد', 'دیدم']) {
      assert.ok(html.includes(text), text);
    }
    // زبانهٔ پیش‌فرض پیش‌پرداخت است؛ فهرست پیش‌دریافت (راهنمای زبانهٔ دیگر) نباید بیرون بیاید.
    assert.ok(!html.includes('برای خدمت آینده گرفته‌ایم'), 'زبانهٔ پیش‌فرض فقط پیش‌پرداخت‌ها را نشان می‌دهد');
    const deferredTab = renderToStaticMarkup(React.createElement(TimingContractsView, { data, initialKind: 'deferred' }));
    for (const text of ['ماندهٔ پیش‌دریافت‌ها', 'شرکت آلفا']) assert.ok(deferredTab.includes(text), text);
    assert.ok(!deferredTab.includes('برای پوشش آینده داده‌ایم'), 'زبانهٔ پیش‌دریافت فقط پیش‌دریافت‌ها را نشان می‌دهد');
    assert.doesNotMatch(html, /نیاز به اقدام حسابدار/, 'موردی برای اقدام نیست');
    const withAttention = renderToStaticMarkup(React.createElement(TimingContractsView, { data: { ...data, attention: { blocked: [], held: [], unscheduled: [{ accountId: 'a1', accountName: 'پیش‌پرداخت‌ها', residual: 5_000_000 }] } } }));
    assert.match(withAttention, /نیاز به اقدام حسابدار/);
    assert.match(withAttention, /برنامهٔ ماهانه ندارد/);
  } finally { await vite.close(); }
});

test('اقلامی که پیش از این بخش ثبت شده بودند به خبرها منتقل می‌شوند؛ فقط آخرین ماه دیده‌نشده می‌ماند', () => inWorkspace(() => {
  twoContracts();
  const db = database.activeWorkspaceDatabase();
  store.postDueRecognitionItems(db, { today: '2026-12-15T00:00:00.000Z' });
  // دفتری که پیش از این بخش ثبت کرده بود: جدول خبر هنوز نیست.
  db.exec('DROP TABLE recognition_notices');
  const notices = contracts().notices;
  assert.deepEqual(notices.map((notice) => [notice.periodKey, notice.postedItems, notice.seenAt === null]), [['1405-09', 2, true], ['1405-08', 2, false], ['1405-07', 2, false]]);
  assert.deepEqual(database.reviewQueue().recognitionNotices.map((notice) => notice.periodKey), ['1405-09']);
  // اجرای بعدی خبر را دوباره نمی‌سازد.
  store.postDueRecognitionItems(db, { today: '2026-12-15T00:00:00.000Z' });
  assert.equal(contracts().notices.find((notice) => notice.periodKey === '1405-09').postedItems, 2);
}));
