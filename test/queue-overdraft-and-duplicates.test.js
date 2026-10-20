import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

/**
 * گزارش مالک محصول (۲۳ مهر ۱۴۰۵) — دو اجارهٔ ۱۵ میلیونی از جاری سامان:
 * - «اجاره دفتر مهر 15 میلیون از حساب سامان» از مسیر بی‌AI به صف حسابدار رفت و با
 *   پاسخ به سؤال کارت ثبت شد؛ سامان بی هیچ تأییدی به منفی ۱۵ میلیون رسید. مسیرهای صف
 *   با اتصال خامِ دیتابیس کار می‌کردند و ردیفِ صف پس از COMMIT زنده می‌شد، بیرون از
 *   نگهبان مانده.
 * - دو دقیقه بعد «اجاره مهر دفتر 15 میلیون از سامان» از مسیر AI ثبت شد، بی هشدار
 *   «شاید تکراری». کنترل تکرار فقط در ثبت روزانه بود و فقط برای پنج دقیقهٔ اخیر.
 *
 * خانواده: نگهبان مانده روی هر مسیرِ صف؛ هشدار تکرار در ثبت روزانه، کارت AI و
 * تأیید صف. نمونه‌های منفی: حسابی که پول دارد، اجارهٔ ماه دیگر، دستهٔ دیگر، طرف
 * حساب دیگر، و قلمِ غیرماهانه در روزی دیگر.
 */

const NOW = '2026-10-15T08:00:00.000Z'; // ۲۳ مهر ۱۴۰۵
const MEHR_1 = '2026-09-23T08:00:00.000Z'; // ۱ مهر ۱۴۰۵
const ABAN_2 = '2026-10-24T08:00:00.000Z'; // ۲ آبان ۱۴۰۵
const none = { op: null, of: [] };

process.env.DATABASE_PATH = tempDatabase('queue-overdraft-duplicates');
process.env.ADMIN_USERNAME = 'queue-guard-owner';
process.env.ADMIN_PASSWORD = 'queue-guard-strong-password-4471';
const database = await import('../server/db.js');
const { parseFinancialText } = await import('../shared/parser.js');
database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);

let counter = 0;
/** هر خانواده دفتر خودش را دارد؛ `member` تأیید منفی‌شدن یا اجازهٔ تکرار را می‌دهد یا نمی‌دهد. */
async function freshBook(samanOpening) {
  const workspace = database.createWorkspace(owner.id, { name: `دفتر نگهبان صف ${++counter}`, profileType: 'business' });
  const inBook = (callback, member = {}) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id, ...member }, callback);
  let saman = null;
  await inBook(() => {
    database.installChartTemplate();
    database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active', understandingScope: 'all' });
    saman = database.saveAccount({ name: 'جاری سامان', kind: 'bank', bankId: 'saman', openingBalance: samanOpening });
  });
  return { inBook, saman };
}
const sql = () => database.activeWorkspaceDatabase();
const balanceOf = (name) => database.listAccounts().find((account) => account.name === name).balance;
const eventOf = (transactionId) => sql().prepare('SELECT * FROM financial_events WHERE source_event_id=?').get(`transaction:${transactionId}`);
const rentRows = () => sql().prepare("SELECT id FROM transactions WHERE status!='deleted' AND category='اجاره'").all().length;

/** همان راهِ بی‌AI: پارسر، ردیف تراکنش؛ `queued` یعنی کارت هنوز تأیید نشده و در صف است. */
function capture(text, { occurredAt = NOW, queued = false, contactId = null } = {}) {
  const rows = parseFinancialText(text, { source: 'text', now: new Date(occurredAt) }).transactions;
  assert.ok(rows.length >= 1, `پارسر چیزی از «${text}» نخواند`);
  const [transactionId] = database.insertTransactions({ transcript: text, transactions: rows.map((row) => ({
    ...row, occurredAt, userConfirmed: !queued, clientId: `c-${Math.random()}`, ...(contactId ? { contactId } : {}),
  })) });
  return transactionId;
}
/** جواب همهٔ سؤال‌های کارت صف، همان کاری که حسابدار در صف می‌کند. */
function answerQueue(eventId) {
  for (let round = 0; round < 6; round += 1) {
    const question = database.eventDecision(eventId)?.decision?.question;
    if (!question) return;
    database.answerEvent(eventId, { fact: question.fact, value: question.fact === 'servicePeriodStart' ? 'already-passed' : question.options?.[0]?.value });
  }
}

const amt = (id, value, role, evidence) => ({ id, value, currency: 'toman', role, status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence });
const fetcherFor = (said) => async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(said) }] }], usage: { input_tokens: 1, output_tokens: 1 } }) });
/** خروجیِ مدل برای جملهٔ دومِ گزارش، و پروندهٔ فهمی که از آن ساخته می‌شود. */
async function understoodRent(text = 'اجاره مهر دفتر 15 میلیون از  سامان') {
  const said = {
    event: { kind: 'expense', description: 'اجاره دفتر', status: 'done' },
    amounts: [amt('a1', 15_000_000, 'paid-now', '15 میلیون')], nonAmountNumbers: [], dates: [], counterparties: [],
    movements: [{ id: 'm1', amountRef: 'a1', direction: 'out', from: { kind: 'bank', name: 'سامان' }, to: { kind: 'counterparty', name: null }, evidence: 'از سامان' }],
    subject: { what: 'اجاره دفتر', kind: 'service', use: 'internal', category: 'اجاره', delivered: 'unknown', usefulLifeMonths: null, evidence: 'اجاره مهر دفتر' },
    conditions: [], ambiguities: [],
  };
  const options = { fetcher: fetcherFor(said), env: { OPENAI_API_KEY: 'test-key-not-real', OPENAI_UNDERSTANDING_MODEL: 'test-model' }, now: new Date(NOW) };
  const item = await database.createUnderstandingCase({ text, clientId: `rent-${Math.random()}` }, options);
  assert.equal(item.status, 'ready', JSON.stringify(item.plan?.questions || item.plan?.reasons));
  return item;
}

test('گزارش مالک محصول: مورد صف که با پاسخ ثبت می‌شود، حساب را بی‌تأیید منفی نمی‌کند', async () => {
  const { inBook } = await freshBook(0);
  let eventId = null;
  let transactionId = null;
  await inBook(() => {
    transactionId = capture('اجاره دفتر مهر 15 میلیون از حساب سامان', { queued: true });
    eventId = eventOf(transactionId).id;
    answerQueue(eventId);
    assert.equal(balanceOf('جاری سامان'), 0);
    assert.throws(() => database.approveEvent(eventId), (error) => error.code === 'NEGATIVE_BALANCE');
    // هیچ چیزی عوض نشد: ردیف هنوز در صف است و مانده همان صفر.
    assert.equal(balanceOf('جاری سامان'), 0);
    assert.equal(eventOf(transactionId).status, 'pending');
    assert.equal(sql().prepare('SELECT journal_deferred AS deferred FROM transactions WHERE id=?').get(transactionId).deferred, 1);
  });
  // با تأیید حسابدار و دلیلش ثبت می‌شود و تأیید کنار سند می‌ماند.
  await inBook(() => {
    database.approveEvent(eventId);
    assert.equal(balanceOf('جاری سامان'), -15_000_000);
    assert.equal(sql().prepare("SELECT COUNT(*) AS n FROM overdraft_approvals WHERE account_name='جاری سامان'").get().n, 1);
  }, { overdraftApproval: FIXTURE_OVERDRAFT });
});

test('نمونهٔ منفی: مورد صف روی حسابی که پول دارد بی‌تأیید ثبت می‌شود', async () => {
  const { inBook } = await freshBook(50_000_000);
  await inBook(() => {
    const transactionId = capture('اجاره دفتر مهر 15 میلیون از حساب سامان', { queued: true });
    const eventId = eventOf(transactionId).id;
    answerQueue(eventId);
    database.approveEvent(eventId);
    assert.equal(balanceOf('جاری سامان'), 35_000_000);
  });
});

test('گزارش مالک محصول: کارت AI همان اجارهٔ ثبت‌شدهٔ همین ماه را «شاید تکراری» می‌گوید', async () => {
  const { inBook } = await freshBook(100_000_000);
  let caseId = null;
  await inBook(async () => {
    capture('اجاره دفتر مهر 15 میلیون از حساب سامان');
    assert.equal(rentRows(), 1);
    const before = balanceOf('جاری سامان');
    caseId = (await understoodRent()).id;
    assert.throws(() => database.commitUnderstandingCase(caseId, { now: new Date(NOW) }), (error) => error.code === 'POSSIBLE_DUPLICATE'
      && error.details.duplicates[0].reason === 'same-month' && error.details.duplicates[0].amount === 15_000_000);
    // هیچ سندی ساخته نشد.
    assert.equal(rentRows(), 1);
    assert.equal(balanceOf('جاری سامان'), before);
  });
  // کاربر هشدار را دید و گفت «تکراری نیست».
  await inBook(() => {
    database.commitUnderstandingCase(caseId, { now: new Date(NOW) });
    assert.equal(rentRows(), 2);
  }, { allowDuplicate: true });
});

test('تأیید صف هم همان هشدار تکرار را می‌دهد، و با «تکراری نیست» ثبت می‌شود', async () => {
  const { inBook } = await freshBook(100_000_000);
  let eventId = null;
  await inBook(async () => {
    database.commitUnderstandingCase((await understoodRent()).id, { now: new Date(NOW) });
    const transactionId = capture('اجاره دفتر مهر 15 میلیون از حساب سامان', { queued: true });
    eventId = eventOf(transactionId).id;
    answerQueue(eventId);
    assert.throws(() => database.approveEvent(eventId), (error) => error.code === 'POSSIBLE_DUPLICATE');
    assert.equal(eventOf(transactionId).status, 'pending');
  });
  await inBook(() => {
    database.approveEvent(eventId);
    assert.equal(balanceOf('جاری سامان'), 70_000_000);
  }, { allowDuplicate: true });
});

test('ثبت روزانه: اجارهٔ همین ماه که روزها قبل ثبت شده، فقط پنج دقیقهٔ اخیر نیست', async () => {
  const { inBook, saman } = await freshBook(100_000_000);
  await inBook(() => {
    capture('اجاره دفتر مهر 15 میلیون از حساب سامان', { occurredAt: MEHR_1 });
    // کارتِ ثبت روزانه حسابِ بانکِ گفته‌شده را خودش می‌گذارد (`pickBankAccount`).
    const incoming = { ...parseFinancialText('اجاره مهر دفتر 15 میلیون از سامان', { source: 'text', now: new Date(NOW) }).transactions[0], accountId: saman.id };
    const [duplicate] = database.findPotentialDuplicates([{ ...incoming, occurredAt: NOW }]);
    assert.equal(duplicate?.reason, 'same-month');
    // منفی: اجارهٔ آبان تکرارِ اجارهٔ مهر نیست.
    assert.deepEqual(database.findPotentialDuplicates([{ ...incoming, occurredAt: ABAN_2 }]), []);
  });
});

test('نمونه‌های منفی: دستهٔ دیگر، طرف حساب دیگر، و قلم غیرماهانه در روز دیگر تکرار نیستند', async () => {
  const { inBook, saman } = await freshBook(100_000_000);
  await inBook(() => {
    const parse = (text) => ({ ...parseFinancialText(text, { source: 'text', now: new Date(NOW) }).transactions[0], accountId: saman.id });
    // دستهٔ دیگر با همان مبلغ و همان حساب.
    capture('بیمه دفتر 15 میلیون از حساب سامان', { occurredAt: MEHR_1 });
    assert.deepEqual(database.findPotentialDuplicates([{ ...parse('اجاره دفتر مهر 15 میلیون از حساب سامان'), occurredAt: NOW }]), []);
    // طرف حساب دیگر: دو خرید هم‌مبلغ از دو تأمین‌کننده.
    const alpha = database.saveContact({ name: 'شرکت آلفا' });
    const beta = database.saveContact({ name: 'شرکت بتا' });
    capture('ناهار پرسنل 3 میلیون از حساب سامان', { occurredAt: NOW, contactId: alpha.id });
    const lunch = parse('ناهار پرسنل 3 میلیون از حساب سامان');
    assert.deepEqual(database.findPotentialDuplicates([{ ...lunch, occurredAt: '2026-10-15T12:00:00.000Z', contactId: beta.id }]), []);
    // قلم غیرماهانه: همان روز نامزد است، روز بعد نه.
    assert.equal(database.findPotentialDuplicates([{ ...lunch, occurredAt: '2026-10-15T12:00:00.000Z', contactId: alpha.id }])[0]?.reason, 'same-day');
    assert.deepEqual(database.findPotentialDuplicates([{ ...lunch, occurredAt: '2026-10-16T12:00:00.000Z', contactId: alpha.id }]), []);
  });
});

test('نمونهٔ منفی: تأیید دوبارهٔ رویدادی که قبلاً ثبت شده هشدار تکرار نمی‌گیرد و چیزی دوبار نمی‌شود', async () => {
  const { inBook } = await freshBook(100_000_000);
  let eventId = null;
  await inBook(async () => {
    database.commitUnderstandingCase((await understoodRent()).id, { now: new Date(NOW) });
    eventId = eventOf(capture('اجاره دفتر مهر 15 میلیون از حساب سامان', { queued: true })).id;
    answerQueue(eventId);
  });
  await inBook(() => database.approveEvent(eventId), { allowDuplicate: true });
  await inBook(() => {
    // همان دکمه دوباره زده شد، این بار بی «تکراری نیست».
    assert.doesNotThrow(() => database.approveEvent(eventId));
    assert.equal(balanceOf('جاری سامان'), 70_000_000);
    assert.equal(rentRows(), 2);
  });
});

test('جهت وارونه: درآمد اجارهٔ همین ماه هم «شاید تکراری» است، ولی هزینهٔ هم‌مبلغ نه', async () => {
  const { inBook, saman } = await freshBook(0);
  await inBook(() => {
    const parse = (text) => ({ ...parseFinancialText(text, { source: 'text', now: new Date(NOW) }).transactions[0], accountId: saman.id });
    capture('اجاره مغازه مهر 20 میلیون از مستاجر گرفتیم به حساب سامان', { occurredAt: MEHR_1 });
    // همان درآمد با ارقام فارسی و جملهٔ دیگر.
    const [duplicate] = database.findPotentialDuplicates([{ ...parse('درآمد اجاره مهر ۲۰ میلیون به حساب سامان واریز شد'), occurredAt: NOW }]);
    assert.equal(duplicate?.reason, 'same-month');
    assert.equal(duplicate?.type, 'income');
    // منفی: اجاره‌ای که شرکت می‌دهد، با همان مبلغ و همان حساب، تکرار درآمد اجاره نیست.
    assert.deepEqual(database.findPotentialDuplicates([{ ...parse('اجاره دفتر مهر 20 میلیون از حساب سامان'), occurredAt: NOW }]), []);
  });
});
