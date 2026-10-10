import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { decide, DECISION_STATUS } from '../shared/accountingDecision.js';
import { purchasePurposeFromSpeech } from '../shared/purchasePurpose.js';
import { FIXTURE_OVERDRAFT } from './helpers/fixtureOverdraft.js';

/**
 * هدف خرید: هزینه، موجودی یا دارایی ثابت.
 *
 * با موتور روشن، «قبض برق دو میلیون» و «لپ‌تاپ ۴۵ میلیون» هر دو «ماهیت
 * نامعلوم» بودند و به صف حسابدار می‌رفتند. اولی هیچ سؤالی لازم ندارد؛ دومی یک
 * سؤال: «این خرید برای چیست؟».
 */
const databasePath = tempDatabase('purchase-purpose');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'purpose-owner';
process.env.ADMIN_PASSWORD = 'purpose-strong-password-4471';

const database = await import('../server/db.js');
const store = await import('../server/financialEventStore.js');
const { parseFinancialText } = await import('../shared/parser.js');
database.ensureAdmin();
const owner = database.authenticateUser('purpose-owner', 'purpose-strong-password-4471');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر هدف خرید', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { overdraftApproval: FIXTURE_OVERDRAFT, role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

const facts = (values) => ({ moneyDirection: 'out', occurredAt: '2026-10-07T08:00:00.000Z', cashAccountId: 'cash', ...values });

function record(sentence, extra = {}) {
  const [item] = parseFinancialText(sentence).transactions;
  const [id] = database.insertTransactions({ transcript: sentence, transactions: [{ ...item, source: 'text', accountId: 'cash', occurredAt: new Date().toISOString(), ...extra }] });
  return { id, event: store.findEventBySource(db(), `transaction:${id}`) };
}
const lines = (transactionId) => db().prepare(`SELECT a.name, l.debit, l.credit FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
  JOIN ledger_accounts a ON a.id=l.account_id WHERE e.source_type='transaction' AND e.source_id=? ORDER BY l.debit DESC`).all(transactionId);

test('هزینهٔ جاری بی‌سؤال تصمیم می‌گیرد؛ خرید کالا هدفش را می‌پرسد', () => {
  for (const category of ['قبوض', 'خوراک', 'کارمزد بانکی', 'سوخت و ایاب‌وذهاب']) {
    const decision = decide(facts({ amount: 2_000_000, category, evidence: 'دو میلیون' }));
    assert.equal(decision.decisionStatus, DECISION_STATUS.DECIDED, category);
    assert.equal(decision.family, 'asset-consumption');
    assert.equal(decision.treatment, 'period-expense');
  }
  const laptop = decide(facts({ amount: 45_000_000, category: 'سایر هزینه‌ها', evidence: 'لپ تاپ ۴۵ میلیون خریدم' }));
  assert.equal(laptop.decisionStatus, DECISION_STATUS.NEEDS_USER_INPUT);
  assert.equal(laptop.question.fact, 'intendedUse');
  assert.deepEqual(laptop.question.options.map((option) => option.value), ['resale', 'production', 'long-term-use', 'current-consumption']);
  // بدون فعل خرید معلوم نیست اصلاً خرید بوده؛ پرسیدن هدف خرید سؤال غلط است.
  // سؤال درست «این پرداخت بابت چه بود؟» است، از خودِ ثبت‌کننده.
  const vague = decide(facts({ amount: 10_000_000, category: 'سایر هزینه‌ها', evidence: 'ده میلیون دادم' }));
  assert.equal(vague.decisionStatus, DECISION_STATUS.NEEDS_USER_INPUT);
  assert.equal(vague.question.fact, 'paymentPurpose');
  // نشانهٔ قضاوت، هر دسته‌ای که باشد، به حسابدار می‌برد: کرایهٔ محمولهٔ
  // وارداتی جزو بهای کالاست، خرید شخصی شریک برداشت است، پول به شخص نام‌برده
  // شاید تسویه باشد.
  const judged = [
    { amount: 18_000_000, category: 'حمل‌ونقل', evidence: 'کرایه حمل محموله وارداتی از گمرک تا انبار' },
    { amount: 70_000_000, category: 'سایر هزینه‌ها', evidence: 'شریک بابت خرید وسایل ویلای شخصیش برداشت کرد' },
    { amount: 100_000_000, category: 'سایر هزینه‌ها', evidence: 'یه دستگاه خریدیم، فاکتور غیررسمی، چطور ثبت کنیم؟' },
    { amount: 30_000_000, category: 'مواد و کالا', evidence: 'آهن آلات خریدیم', counterparty: 'آقای کاظمی' },
  ];
  for (const values of judged) assert.equal(decide(facts(values)).decisionStatus, DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW, values.evidence);
  // دوره‌دار سیاست خودش را دارد و سؤال هدف خرید نمی‌گیرد.
  assert.equal(decide(facts({ amount: 20_000_000, category: 'اجاره', evidence: 'اجاره دادم' })).question?.fact, 'servicePeriodStart');
});

test('جواب هدف خرید و حد سرمایه‌ای شدن دفتر برخورد را تعیین می‌کنند', () => {
  const laptop = (intendedUse, amount, capitalizationThreshold = null) => decide(
    facts({ amount, category: 'سایر هزینه‌ها', evidence: 'لپ تاپ خریدم', intendedUse }), { capitalizationThreshold },
  );
  const consumed = laptop('current-consumption', 45_000_000);
  assert.equal(consumed.decisionStatus, DECISION_STATUS.DECIDED);
  assert.equal(consumed.treatment, 'period-expense');

  const small = laptop('long-term-use', 8_000_000, 20_000_000);
  assert.equal(small.decisionStatus, DECISION_STATUS.DECIDED);
  assert.equal(small.treatment, 'period-expense');
  assert.match(small.assumptions[0], /حد سرمایه‌ای شدن/);

  const asset = laptop('long-term-use', 45_000_000, 20_000_000);
  assert.equal(asset.treatment, 'fixed-asset');
  assert.equal(asset.decisionStatus, DECISION_STATUS.UNSUPPORTED);
  assert.match(asset.explanation, /عمر مفید/);
  // بدون حد، هیچ مبلغی خودکار هزینه نمی‌شود.
  assert.equal(laptop('long-term-use', 8_000_000).treatment, 'fixed-asset');

  // موجودی با ارزش درست همین حالا می‌نشیند؛ تفکیک اقلام بعداً در کارت کالا.
  for (const purpose of ['resale', 'production']) {
    const goods = laptop(purpose, 45_000_000, 20_000_000);
    assert.equal(goods.treatment, 'inventory-purchase');
    assert.equal(goods.decisionStatus, DECISION_STATUS.DECIDED);
    assert.match(goods.assumptions[0], /تفکیک/);
  }
  // ملزومات زیر حد، بی‌سؤال هزینه‌اند؛ بالای حد یا بی‌حد، پرسیده می‌شوند.
  const supplies = (amount, threshold) => decide(facts({ amount, category: 'ملزومات اداری', evidence: 'خریدم' }), { capitalizationThreshold: threshold });
  assert.equal(supplies(500_000, 20_000_000).treatment, 'period-expense');
  assert.equal(supplies(25_000_000, 20_000_000).question?.fact, 'intendedUse');
  assert.equal(supplies(500_000, null).question?.fact, 'intendedUse');
});

test('هدفی که در جمله گفته شده دوباره پرسیده نمی‌شود', () => {
  assert.equal(purchasePurposeFromSpeech('ده میلیون جنس خریدم برای فروش'), 'resale');
  assert.equal(purchasePurposeFromSpeech('مواد اولیه خریدیم'), 'production');
  assert.equal(purchasePurposeFromSpeech('لپ تاپ برای دفتر خریدم'), null);
});

test('با موتور روشن: قبض مستقیم ثبت می‌شود و لپ‌تاپ پس از جواب، هزینه یا صف حسابدار', () => inWorkspace(() => {
  database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, capitalizationThreshold: 20_000_000 });

  const bill = record('قبض برق دو میلیون پرداخت کردم', { userConfirmed: true });
  assert.equal(store.findEventBySource(db(), `transaction:${bill.id}`).status, 'posted');
  assert.deepEqual(lines(bill.id).map((line) => line.name), ['قبوض', 'صندوق نقدی']);

  const consumed = record('لپ تاپ ۴۵ میلیون خریدم');
  assert.equal(consumed.event.status, 'pending');
  assert.equal(consumed.event.route, 'confirm', 'یک سؤال، نه صف حسابدار');
  database.answerEvent(consumed.event.id, { fact: 'intendedUse', value: 'current-consumption' });
  database.approveEvent(consumed.event.id);
  assert.equal(lines(consumed.id)[0].debit, 45_000_000);
  assert.equal(lines(consumed.id)[1].name, 'صندوق نقدی');

  const asset = record('لپ تاپ ۴۵ میلیون خریدم');
  const answered = database.answerEvent(asset.event.id, { fact: 'intendedUse', value: 'long-term-use' });
  assert.equal(answered.decision.treatment, 'fixed-asset');
  assert.equal(store.findEventBySource(db(), `transaction:${asset.id}`).route, 'accountant-review', 'دارایی ثابت در تأیید کاربر گیر نمی‌کند');
  assert.throws(() => database.approveEvent(asset.event.id), { code: 'EVENT_PLAN_REVISION_REQUIRED' });
  assert.equal(lines(asset.id).length, 0, 'هیچ هزینه‌ای برای دارایی ثابت ثبت نشد');

  const printer = record('پرینتر ۸ میلیون خریدم');
  const cheap = database.answerEvent(printer.event.id, { fact: 'intendedUse', value: 'long-term-use' });
  assert.equal(cheap.decision.treatment, 'period-expense', 'زیر حد سرمایه‌ای شدن، هزینه');
  database.approveEvent(printer.event.id);
  assert.equal(lines(printer.id)[0].debit, 8_000_000);
}));

test('تأیید فوری پیش‌پرداخت قطعی، نقشهٔ پیش‌پرداخت را می‌زند نه هزینهٔ دسته را', () => inWorkspace(() => {
  database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true });
  const { id } = record('بیمه آتش‌سوزی دفتر دوازده میلیون پرداخت کردم', {
    category: 'بیمه', needsReview: false, reviewReasons: [], userConfirmed: true,
    servicePeriodStart: '2026-09-23T00:00:00.000Z', servicePeriodEnd: '2027-09-22T00:00:00.000Z',
  });
  const event = store.findEventBySource(db(), `transaction:${id}`);
  assert.equal(store.decisionForEvent(db(), event.id).treatment, 'prepaid-expense');
  if (event.status !== 'posted') database.approveEvent(event.id);
  const posted = lines(id);
  assert.equal(posted.length, 2);
  assert.doesNotMatch(posted[0].name, /^بیمه$/, 'هزینهٔ بیمه نشد');
  assert.match(posted[0].name, /پیش/);
}));

test.after(() => removeTempDatabase(databasePath));
