import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';

/**
 * کارت‌های امروز دریافت و پرداخت‌اند؛ دفتر کل درآمد و هزینه. هر دو دیده می‌شوند.
 *
 * فروش ۱۱۰ با ارزش افزوده ۱۱۰ دریافت است ولی ۱۰۰ درآمد؛ پیش‌پرداخت پرداخت
 * است ولی هزینه نیست. بدون جمع دفتر کل، این اختلاف از صاحب کسب‌وکار پنهان بود.
 */
const databasePath = tempDatabase('today-ledger');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'today-owner';
process.env.ADMIN_PASSWORD = 'today-strong-password-2291';

const database = await import('../server/db.js');
const store = await import('../server/financialEventStore.js');
const { parseFinancialText } = await import('../shared/parser.js');
database.ensureAdmin();
const owner = database.authenticateUser('today-owner', 'today-strong-password-2291');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر امروز', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

const record = (sentence) => {
  const [item] = parseFinancialText(sentence).transactions;
  const [id] = database.insertTransactions({ transcript: sentence, transactions: [{ ...item, source: 'text', accountId: 'cash', occurredAt: new Date().toISOString() }] });
  const event = store.findEventBySource(database.activeWorkspaceDatabase(), `transaction:${id}`);
  if (event?.status === 'pending') database.approveEvent(event.id, { reason: 'حسابدار: ماهیت بررسی و تأیید شد.' });
};

test('فروش با ارزش افزوده و پیش‌پرداخت: دریافت و پرداخت در کارت، درآمد و هزینه از دفتر کل', () => inWorkspace(() => {
  database.saveTaxRate({ name: 'ارزش افزوده ۱۰٪', rate: 10, treatment: 'taxable', isDefault: true });
  database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true });
  record('۱۱۰ میلیون فروختم با ارزش افزوده');
  record('پونزده میلیون شارژ ساختمان اداری رو برای شش ماه جلوتر نقدی پرداخت کردم');
  const { summary } = database.getToday();
  assert.equal(summary.income, 110_000_000, 'کارت: کل دریافت');
  assert.equal(summary.expense, 15_000_000, 'کارت: کل پرداخت');
  assert.deepEqual(summary.ledger, { income: 100_000_000, expense: 0, profit: 100_000_000 }, 'دفتر کل: ارزش افزوده درآمد نیست و پیش‌پرداخت هزینه نیست');
}));

test('کارت امروز اختلاف دفتر کل را نشان می‌دهد و وقتی یکی است ساکت می‌ماند', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { SummaryCard } = await vite.ssrLoadModule('/src/features/today/TodayPage.jsx');
    const differs = renderToStaticMarkup(React.createElement(SummaryCard, { summary: { income: 110_000_000, expense: 15_000_000, netCashFlow: 95_000_000, comparison: null, ledger: { income: 100_000_000, expense: 0, profit: 100_000_000 } } }));
    assert.match(differs, /طبق دفتر کل امروز/);
    const same = renderToStaticMarkup(React.createElement(SummaryCard, { summary: { income: 5, expense: 2, netCashFlow: 3, comparison: null, ledger: { income: 5, expense: 2, profit: 3 } } }));
    assert.doesNotMatch(same, /طبق دفتر کل امروز/);
  } finally { await vite.close(); }
});

test.after(() => removeTempDatabase(databasePath));
