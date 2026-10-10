import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';
import { runVoice } from './helpers/voicePipeline.js';
import { detectPartnerPaidDebt, mentionsPersonalMoney } from '../shared/partnerPaidSpeech.js';
import { matchSettleTargets } from '../shared/settleSpeech.js';
import { EVENT_KINDS, eventMovesCash, normalizeFinancialEvent } from '../shared/financialEvent.js';
import { ROLES, affectsProfit, planJournal } from '../shared/accountingRules.js';
import { understandingReasons } from '../shared/understandingScope.js';
import { validateUnderstanding } from '../shared/eventUnderstanding.js';
import { parseFinancialText } from '../shared/parser.js';

/**
 * بدهی شرکت که مدیرعامل یا شریک از پول شخصی‌اش داد.
 *
 * «آقای سهرابی مدیرعامل ماشین شخصی خودش رو فروخت و ۲۸۰ میلیون بدهی شرکت آریا رو
 * پرداخت کرد.» پیش از این، پارسر جمله را «دریافت — سایر درآمدها» یا «پرداخت —
 * سایر هزینه‌ها» می‌خواند و در هر دو حالت ماندهٔ صندوق ۲۸۰ میلیون جابه‌جا می‌شد،
 * درحالی‌که از حساب شرکت ریالی نرفته است. سند درست: بدهکار پرداختنیِ آریا،
 * بستانکار جاری شریکِ سهرابی؛ فروش ماشینِ شخصی هیچ‌جای دفتر نیست.
 */

const NOW = new Date('2026-10-10T09:00:00.000Z');

const SAID = {
  sold: 'آقای سهرابی مدیرعامل ماشین شخصی خودش رو فروخت و ۲۸۰ میلیون بدهی شرکت آریا رو پرداخت کرد',
  personal: 'بدهی ۲۸۰ میلیونی شرکت آریا رو آقای سهرابی از پول شخصی خودش پرداخت کرد',
  pocket: 'مدیرعامل از جیب خودش ۲۸۰ میلیون بدهی آریا رو صاف کرد',
  suffix: 'آقای سهرابی ماشینشو فروخت و ۲۸۰ میلیون بدهی آریا رو داد',
  house: 'مدیرعامل آقای سهرابی خونه‌اش رو فروخت و بدهی شرکت به آریا رو تسویه کرد',
  firstPerson: 'از جیب خودم ۵۰ میلیون بدهی شرکت نوین رو دادم',
  // عین گفتهٔ ثبت‌شده در برنامه (۱۸ مهر ۱۴۰۵): فعل «داشتیم» به نام طلبکار چسبیده بود.
  spoken: 'بدهی 280 میلیونی به شرکت آریا داشتیم مدیر عامل اقای سهرابی ماشین شخصی خودشون رو فروختن و بدهی رو پرداخت کردند',
};

test('هر شکل گفتن به کارت تسویه از پول شریک می‌رسد، با طلبکار و پرداخت‌کننده', () => {
  const read = (text) => {
    const found = detectPartnerPaidDebt(text, { now: NOW });
    return found && { creditor: found.contactName, amount: found.amount, payer: found.paidBy.name, role: found.paidBy.role, direction: found.direction };
  };
  assert.deepEqual(read(SAID.sold), { creditor: 'شرکت آریا', amount: 280_000_000, payer: 'آقای سهرابی', role: 'مدیرعامل', direction: 'payable' });
  assert.deepEqual(read(SAID.personal), { creditor: 'شرکت آریا', amount: 280_000_000, payer: 'آقای سهرابی', role: '', direction: 'payable' });
  assert.deepEqual(read(SAID.pocket), { creditor: 'آریا', amount: 280_000_000, payer: '', role: 'مدیرعامل', direction: 'payable' });
  assert.deepEqual(read(SAID.suffix), { creditor: 'آریا', amount: 280_000_000, payer: 'آقای سهرابی', role: '', direction: 'payable' });
  // مبلغ گفته نشده: کارت از ماندهٔ بدهیِ باز می‌گیرد.
  assert.deepEqual(read(SAID.house), { creditor: 'آریا', amount: 0, payer: 'آقای سهرابی', role: 'مدیرعامل', direction: 'payable' });
  assert.deepEqual(read(SAID.spoken), { creditor: 'شرکت آریا', amount: 280_000_000, payer: 'آقای سهرابی', role: 'مدیرعامل', direction: 'payable' });
  const self = detectPartnerPaidDebt(SAID.firstPerson, { now: NOW });
  assert.equal(self.contactName, 'شرکت نوین');
  assert.equal(self.paidBy.firstPerson, true);
});

test('بدون پولِ شخصی یا با جهتِ وارونه، این مسیر نیست', () => {
  for (const text of [
    '۲۸۰ میلیون به شرکت آریا پرداخت شد',
    'آقای سهرابی ۲۸۰ میلیون به آریا داد',
    'آقای سهرابی ۵۰ میلیون از حساب شرکت برداشت شخصی کرد',
    'مدیرعامل ۲۰ میلیون از حساب شرکت به حساب شخصی خودش ریخت',
    'آقای سهرابی ۵۰ میلیون به شرکت قرض داد',
    'آقای سهرابی ماشین شخصیش رو فروخت',
    'ماشین شرکت رو فروختیم ۴۰۰ میلیون',
    'مدیرعامل ۱۰۰ میلیون از پول شخصی خودش به حساب شرکت واریز کرد',
  ]) assert.equal(detectPartnerPaidDebt(text, { now: NOW }), null, text);
});

test('مسیر گفته: هیچ ردیف نقدی، هیچ درآمد یا هزینه', () => {
  for (const text of [SAID.sold, SAID.personal, SAID.pocket, SAID.suffix, SAID.spoken]) {
    const result = runVoice(text, { today: NOW.toISOString() });
    assert.equal(result.path, 'partner-settle', text);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].noCashRow, true);
    assert.equal(result.items[0].outcome, 'ask');
    assert.equal(result.items[0].amount, 280_000_000);
  }
});

test('کارت تسویه فقط بدهیِ بازِ همان طلبکار را نشان می‌دهد', () => {
  const intent = detectPartnerPaidDebt(SAID.sold, { now: NOW });
  const obligations = [
    { id: 'o1', title: 'خرید مواد', contactName: 'شرکت آریا', remaining: 280_000_000, direction: 'payable', status: 'open', journalStatus: 'posted' },
    { id: 'o2', title: 'فروش', contactName: 'شرکت آریا', remaining: 300_000_000, direction: 'receivable', status: 'open', journalStatus: 'posted' },
    { id: 'o3', title: 'اجاره', contactName: 'آقای کریمی', remaining: 400_000_000, direction: 'payable', status: 'open', journalStatus: 'posted' },
  ];
  assert.deepEqual(matchSettleTargets(intent, { obligations }).map((item) => [item.id, item.paymentAmount]), [['o1', 280_000_000]]);
});

test('قاعدهٔ سند: پرداختنیِ طلبکار در برابر جاری شریک؛ نقد و سود دست نمی‌خورند', () => {
  const event = normalizeFinancialEvent({
    kind: EVENT_KINDS.OBLIGATION_SETTLED_BY_PARTNER, amount: 280_000_000, occurredAt: NOW.toISOString(),
    counterparty: 'شرکت آریا', reference: 'خرید مواد', settlementDirection: 'payable', payerName: 'آقای سهرابی',
  });
  assert.equal(event.accountId, null, 'حساب نقدی ندارد');
  assert.equal(eventMovesCash(event.kind), false);
  assert.deepEqual(planJournal(event).lines.map((line) => [line.role, line.key, line.debit, line.credit]), [
    [ROLES.PAYABLE, 'شرکت آریا', 280_000_000, 0],
    [ROLES.PARTNER_PAYABLE, 'آقای سهرابی', 0, 280_000_000],
  ]);
  assert.equal(affectsProfit(EVENT_KINDS.OBLIGATION_SETTLED_BY_PARTNER), false);
  // وارونه: مشتری طلب ما را به شریک داد؛ شریک به شرکت بدهکار می‌شود.
  const received = normalizeFinancialEvent({ ...event, settlementDirection: 'receivable' });
  assert.deepEqual(planJournal(received).lines.map((line) => [line.role, line.debit > 0]), [[ROLES.PARTNER_RECEIVABLE, true], [ROLES.RECEIVABLE, false]]);
});

test('فهم با AI: جملهٔ پول شخصی در محدودهٔ مرکب است', () => {
  for (const text of Object.values(SAID)) {
    assert.equal(mentionsPersonalMoney(text), true, text);
    assert.ok(understandingReasons(text).includes('personal-money'), text);
  }
  assert.equal(understandingReasons('۲۸۰ میلیون به شرکت آریا پرداخت شد').includes('personal-money'), false);
});

// ---------------------------------------------------------------------------
// روی دفتر
// ---------------------------------------------------------------------------

process.env.DATABASE_PATH = tempDatabase('partner-paid');
process.env.ADMIN_USERNAME = 'partner-paid-owner';
process.env.ADMIN_PASSWORD = 'partner-paid-strong-password-5521';
const database = await import('../server/db.js');
const accounting = await import('../server/accounting.js');
database.ensureAdmin();
const owner = database.authenticateUser('partner-paid-owner', 'partner-paid-strong-password-5521');
const workspace = database.createWorkspace(owner.id, { name: 'شرکت سهرابی', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();
const balances = () => Object.fromEntries(db().prepare(`SELECT a.name,SUM(l.debit)-SUM(l.credit) AS balance FROM journal_lines l
  JOIN ledger_accounts a ON a.id=l.account_id GROUP BY a.id`).all().map((row) => [row.name, row.balance]));
const cashBalance = () => database.listAccounts().reduce((sum, account) => sum + Number(account.balance || 0), 0);
const transactionCount = () => db().prepare('SELECT COUNT(*) AS n FROM transactions').get().n;

let aria;
test('آماده‌سازی دفتر', () => inWorkspace(() => {
  database.installChartTemplate();
  database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, understandingMode: 'active' });
  aria = database.saveContact({ name: 'شرکت آریا' });
}));

test('تسویه از پول شخصی: بدهی آریا بسته، جاری سهرابی بستانکار، صندوق دست‌نخورده', () => inWorkspace(() => {
  const debt = database.saveObligation({ title: 'خرید مواد اولیه', amount: 280_000_000, direction: 'payable', contactId: aria.id });
  const cash = cashBalance();
  const rows = transactionCount();
  const result = database.settleObligation(debt.id, { paidBy: { name: 'آقای سهرابی' }, occurredAt: NOW.toISOString() });
  assert.equal(result.item.status, 'paid');
  assert.equal(result.item.remaining, 0);
  assert.equal(result.transaction, null);
  assert.equal(result.event.status, 'posted');
  assert.equal(transactionCount(), rows, 'هیچ ردیف نقدی ساخته نشد');
  assert.equal(cashBalance(), cash, 'ماندهٔ صندوق و بانک عوض نشد');
  const after = balances();
  assert.equal(after['حساب پرداختنی — شرکت آریا'], 0, 'بدهی به آریا صفر شد');
  assert.equal(after['جاری شریک — بدهی شرکت — آقای سهرابی'], -280_000_000, 'شرکت به سهرابی بدهکار شد');
  assert.equal(accounting.trialBalance(db()).balanced, true);
  // سهرابی کارت شخص دارد تا ماندهٔ جاری‌اش قابل پیگیری باشد.
  assert.ok(database.listContacts().some((contact) => contact.name === 'آقای سهرابی'));
}));

test('تسویهٔ جزئی از پول شریک، و دو شریک دو جاری جدا دارند', () => inWorkspace(() => {
  const debt = database.saveObligation({ title: 'خرید قالب', amount: 100_000_000, direction: 'payable', contactId: aria.id });
  database.settleObligation(debt.id, { amount: 40_000_000, paidBy: { name: 'آقای سهرابی' } });
  const partial = database.listObligations({ status: 'all' }).find((item) => item.id === debt.id);
  assert.equal(partial.status, 'open');
  assert.equal(partial.remaining, 60_000_000);
  database.settleObligation(debt.id, { amount: 60_000_000, paidBy: { name: 'خانم رحیمی' } });
  const after = balances();
  assert.equal(after['جاری شریک — بدهی شرکت — آقای سهرابی'], -320_000_000);
  assert.equal(after['جاری شریک — بدهی شرکت — خانم رحیمی'], -60_000_000);
  assert.equal(after['حساب پرداختنی — شرکت آریا'], 0);
}));

test('پرداخت‌کننده نمی‌تواند خودِ طلبکار باشد و بی‌نام ثبت نمی‌شود', () => inWorkspace(() => {
  const debt = database.saveObligation({ title: 'خرید ابزار', amount: 5_000_000, direction: 'payable', contactId: aria.id });
  assert.throws(() => database.settleObligation(debt.id, { paidBy: { name: 'شرکت آریا', contactId: aria.id } }), /همان طرف حساب/);
  assert.throws(() => database.settleObligation(debt.id, { paidBy: { name: '  ' } }), /نام شریک/);
  assert.equal(database.listObligations({ status: 'all' }).find((item) => item.id === debt.id).remaining, 5_000_000, 'چیزی تغییر نکرد');
}));

test('اگر گفته از کارت رد نشود، سرور ردیف نقدی نمی‌سازد و به صف حسابدار می‌فرستد', () => inWorkspace(() => {
  const rows = transactionCount();
  const cash = cashBalance();
  const ids = database.insertTransactionRows({
    transcript: SAID.sold, fromUtterance: true,
    transactions: [{ clientId: 'legacy-row', amount: 280_000_000, type: 'income', category: 'سایر درآمدها', rawText: SAID.sold, source: 'voice' }],
  });
  assert.deepEqual([...ids], []);
  assert.equal(ids.queuedForAccountant, 1);
  assert.equal(transactionCount(), rows);
  assert.equal(cashBalance(), cash);
  const queued = db().prepare("SELECT payload,route FROM financial_events WHERE source_event_id='unmatched-settlement:legacy-row'").get();
  assert.equal(queued.route, 'accountant-review');
  assert.match(JSON.parse(queued.payload).description, /پول شخصی آقای سهرابی/);
}));

// ---------------------------------------------------------------------------
// فهم با AI (مدل شبیه‌سازی‌شده)
// ---------------------------------------------------------------------------

const none = { op: null, of: [] };
const understood = ({ kind = 'paid-by-partner', movementFrom = { kind: 'counterparty', name: 'آقای سهرابی' } } = {}) => ({
  event: { kind, description: 'بدهی شرکت از پول شخصی مدیرعامل پرداخت شد', status: 'done' },
  amounts: [{ id: 'a1', value: 280_000_000, currency: null, role: 'paid-now', status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence: '۲۸۰ میلیون' }],
  nonAmountNumbers: [], dates: [],
  counterparties: [
    { id: 'c1', name: 'آقای سهرابی', role: 'owner', evidence: 'آقای سهرابی مدیرعامل' },
    { id: 'c2', name: 'شرکت آریا', role: 'supplier', evidence: 'بدهی شرکت آریا' },
  ],
  movements: [{ id: 'm1', amountRef: 'a1', direction: 'none', from: movementFrom, to: { kind: 'counterparty', name: 'شرکت آریا' }, evidence: 'پرداخت کرد' }],
  subject: { what: null, kind: null, use: 'unknown', delivered: 'unknown', usefulLifeMonths: null, evidence: null }, conditions: [], ambiguities: [],
});
const outputs = new Map();
const fetcher = async (_url, init) => {
  const said = JSON.parse(JSON.parse(init.body).input[1].content[0].text)['گفتهٔ کاربر'];
  return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(outputs.get(said)) }] }], usage: { input_tokens: 1, output_tokens: 1 } }) };
};
const options = { fetcher, env: { OPENAI_API_KEY: 'test-key-not-real', OPENAI_UNDERSTANDING_MODEL: 'test-model' }, now: NOW };

test('قرارداد AI: «پرداخت از پول شریک» بی‌نشانهٔ پول شخصی پذیرفته نمی‌شود', () => {
  const plain = '۲۸۰ میلیون بدهی شرکت آریا رو آقای سهرابی پرداخت کرد';
  const { understanding, violations } = validateUnderstanding(understood(), { text: plain, now: NOW });
  assert.notEqual(understanding.event.kind, 'paid-by-partner');
  assert.ok(violations.includes('event:paid-by-partner-without-cue'));
  assert.equal(validateUnderstanding(understood(), { text: SAID.sold, now: NOW }).understanding.event.kind, 'paid-by-partner');
});

test('فهم با AI روی دفتر: پرونده آماده، پیش‌نمایش بی‌سطر نقدی، ثبت درست', async () => {
  await inWorkspace(async () => {
    const debt = database.saveObligation({ title: 'خرید ورق', amount: 280_000_000, direction: 'payable', contactId: aria.id });
    // بدهی‌های قبلیِ آریا بسته‌اند؛ فقط همین یکی باز است، پس سؤالی نمی‌ماند.
    for (const item of database.listObligations().filter((row) => row.contactId === aria.id && row.id !== debt.id)) {
      database.settleObligation(item.id, { paidBy: { name: 'آقای سهرابی' } });
    }
    outputs.set(SAID.sold, understood());
    const rows = transactionCount();
    const cash = cashBalance();
    const before = balances()['جاری شریک — بدهی شرکت — آقای سهرابی'] || 0;
    const item = await database.createUnderstandingCase({ text: SAID.sold, clientId: 'ai-partner' }, options);
    assert.equal(item.status, 'ready', JSON.stringify(item.plan));
    assert.deepEqual(item.plan.components.map((component) => [component.kind, component.amount, component.target.id, component.paidBy.name]),
      [['partner-settlement', 280_000_000, debt.id, 'آقای سهرابی']]);
    assert.deepEqual(item.plan.components[0].preview.lines.map((line) => line.role), ['payable', 'partner-payable']);
    const posted = database.commitUnderstandingCase(item.id, { now: NOW });
    assert.equal(posted.status, 'posted');
    assert.equal(transactionCount(), rows);
    assert.equal(cashBalance(), cash);
    assert.equal(database.listObligations({ status: 'all' }).find((row) => row.id === debt.id).status, 'paid');
    assert.equal(balances()['جاری شریک — بدهی شرکت — آقای سهرابی'], before - 280_000_000);
    assert.equal(accounting.trialBalance(db()).balanced, true);
  });
});

test('فهم با AI: اگر مدل پول را از حساب شرکت بداند، به حسابدار می‌رود', async () => {
  await inWorkspace(async () => {
    const text = 'آقای سهرابی از جیب خودش ۲۸۰ میلیون بدهی شرکت آریا رو داد';
    const output = understood({ movementFrom: { kind: 'bank', name: 'بانک ملت' } });
    output.movements[0].direction = 'out';
    outputs.set(text, output);
    const item = await database.createUnderstandingCase({ text, clientId: 'ai-partner-bank' }, options);
    assert.equal(item.status, 'needs-accountant', JSON.stringify(item.plan));
  });
});

// ---------------------------------------------------------------------------
// بدهیِ دفتر کل بی‌سند — همان وضعیت دفتر واقعی (۱۸ مهر ۱۴۰۵): خرید ۳۰۰ میلیونی
// از آریا که حسابدار از صف تأیید کرد و مستقیم در دفتر کل نشست. کارت حساب
// ۲۸۰ میلیون بستانکار نشان می‌داد ولی کارت تسویه «بدهی باز پیدا نشد» می‌گفت.
// ---------------------------------------------------------------------------

const { recordFinancialEvent } = await import('../server/financialEventStore.js');
const { ledgerBalanceTargets } = await import('../shared/settleSpeech.js');
const { routeEvent } = await import('../shared/confidenceEngine.js');

let pars;
const reviewedPurchase = (contact, amount, key) => {
  const event = normalizeFinancialEvent({ kind: EVENT_KINDS.PAYABLE_OPENED, amount, occurredAt: NOW.toISOString(),
    counterparty: contact.name, counterpartyId: contact.id, category: 'خرید کالا', source: 'text' });
  const decision = routeEvent(event, { components: { amountCertainty: 1, moneyDirectionCertainty: 1, dateCertainty: 1, completeness: 1, counterpartyCertainty: 1 } });
  return recordFinancialEvent(db(), event, { sourceEventId: `review-approved:${key}`, decision });
};
const payableOf = (name) => -(balances()[`حساب پرداختنی — ${name}`] || 0);

test('کارت تسویه ماندهٔ بی‌سندِ کارت حساب را هدف می‌کند — هر دو جهت، نقدی یا از پول شریک', () => {
  const contacts = [
    { id: 'k1', name: 'شرکت آریا', uncoveredPayable: 280_000_000, uncoveredReceivable: 0 },
    { id: 'k2', name: 'شرکت نوین', uncoveredPayable: 0, uncoveredReceivable: 70_000_000 },
    { id: 'k3', name: 'آریا تجارت', uncoveredPayable: 0, uncoveredReceivable: 0 },
  ];
  const pick = (intent) => ledgerBalanceTargets(intent, { contacts }).map((item) => [item.contactId, item.direction, item.paymentAmount]);
  assert.deepEqual(pick(detectPartnerPaidDebt(SAID.spoken, { now: NOW })), [['k1', 'payable', 280_000_000]]);
  // تسویهٔ نقدی هم همان مانده را می‌بیند.
  assert.deepEqual(pick({ intent: 'settle', kind: 'any', direction: 'payable', contactName: 'شرکت آریا', amount: 50_000_000 }), [['k1', 'payable', 50_000_000]]);
  assert.deepEqual(pick({ intent: 'settle', kind: 'any', direction: 'receivable', contactName: 'شرکت نوین', amount: 20_000_000 }), [['k2', 'receivable', 20_000_000]]);
  // مبلغ بیش از مانده، یا شخصِ دیگر، هدف نیست.
  assert.deepEqual(pick({ intent: 'settle', kind: 'any', direction: 'payable', contactName: 'شرکت آریا', amount: 300_000_000 }), []);
  // فاکتور یا چک خواسته شده: ماندهٔ دفتر کل جای آن نیست.
  assert.deepEqual(pick({ intent: 'settle', kind: 'invoice', direction: 'payable', contactName: 'شرکت آریا' }), []);
});

test('روی دفتر: بدهیِ دفتر کل بی‌سند از پول شریک بسته می‌شود', () => inWorkspace(() => {
  pars = database.saveContact({ name: 'شرکت پارس' });
  assert.equal(reviewedPurchase(pars, 300_000_000, 'pars-1').status, 'posted');
  assert.equal(database.listObligations({ status: 'all' }).filter((item) => item.contactId === pars.id).length, 0, 'هیچ سند طلب و بدهی ندارد');
  assert.equal(database.payableLedgerBalance(pars.id), 300_000_000);
  const rows = transactionCount();
  const cash = cashBalance();
  const result = database.settlePayableBalanceByPartner(pars.id, { amount: 280_000_000, paidBy: { name: 'آقای سهرابی' }, clientId: 'card-1' });
  assert.equal(result.event.status, 'posted');
  assert.equal(result.remaining, 20_000_000);
  assert.equal(payableOf('شرکت پارس'), 20_000_000);
  assert.equal(transactionCount(), rows);
  assert.equal(cashBalance(), cash);
  assert.equal(accounting.trialBalance(db()).balanced, true);
  // همان کلیک دوباره سند دوم نمی‌سازد.
  database.settlePayableBalanceByPartner(pars.id, { amount: 280_000_000, paidBy: { name: 'آقای سهرابی' }, clientId: 'card-1' });
  assert.equal(payableOf('شرکت پارس'), 20_000_000);
  assert.throws(() => database.settlePayableBalanceByPartner(pars.id, { amount: 30_000_000, paidBy: { name: 'آقای سهرابی' } }), /بیشتر است/);
}));

test('فهم با AI: بدهیِ دفتر کل بی‌سند هدف تسویه است', async () => {
  await inWorkspace(async () => {
    const kian = database.saveContact({ name: 'شرکت کیان' });
    reviewedPurchase(kian, 300_000_000, 'kian-1');
    const text = 'بدهی 280 میلیونی به شرکت کیان داشتیم مدیر عامل اقای سهرابی ماشین شخصی خودشون رو فروختن و بدهی رو پرداخت کردند';
    const output = understood();
    output.counterparties[1] = { id: 'c2', name: 'شرکت کیان', role: 'supplier', evidence: 'به شرکت کیان' };
    output.movements[0].to = { kind: 'counterparty', name: 'شرکت کیان' };
    outputs.set(text, output);
    const item = await database.createUnderstandingCase({ text, clientId: 'ai-ledger-balance' }, options);
    assert.equal(item.status, 'ready', JSON.stringify(item.plan));
    assert.deepEqual(item.plan.components.map((component) => [component.kind, component.target.kind, component.amount]), [['partner-settlement', 'ledger-balance', 280_000_000]]);
    const posted = database.commitUnderstandingCase(item.id, { now: NOW });
    assert.equal(posted.status, 'posted');
    assert.equal(payableOf('شرکت کیان'), 20_000_000);
  });
});

// ---------------------------------------------------------------------------
// کل خانواده: پولی که از حساب شخصیِ کسی جز شرکت گذشت، و تسویهٔ ماندهٔ بی‌سند.
// ---------------------------------------------------------------------------

const FAMILY = {
  partnerExpense: 'مدیرعامل هزینه تعمیر کولر دفتر رو ۸ میلیون از جیب خودش داد',
  partnerGoods: 'آقای سهرابی با پول شخصی خودش ۱۰۰ میلیون مواد اولیه برای شرکت خرید',
  employeeExpense: 'آقای رضایی کارمندمون ۲ میلیون بنزین ماشین شرکت رو از جیب خودش داد',
  customerToPartner: 'شرکت نوین ۵۰ میلیون از بدهیش رو به حساب شخصی مدیرعامل ریخت',
  partnerCollected: 'آقای سهرابی ۳۰ میلیون طلب ما از شرکت نوین رو خودش نقد گرفت',
  theirDebtPaid: 'شرکت نوین ۲۰ میلیون از بدهیش رو واریز کرد',
};

test('خانواده در مسیر گفته: هیچ ردیف نقدی برای پولی که از حساب شرکت نگذشت', () => {
  const run = (text) => runVoice(text, { today: NOW.toISOString() });
  const goods = run(FAMILY.partnerGoods).items[0];
  assert.equal(goods.fundedBy, 'partner');
  assert.deepEqual(goods.plan.lines.map((line) => [line.role, line.debit > 0]), [[ROLES.INVENTORY_UNSPLIT, true], [ROLES.PARTNER_PAYABLE, false]]);
  const employee = run(FAMILY.employeeExpense).items[0];
  assert.equal(employee.outcome, 'post', 'جهت پرداخت از جیب کارمند قطعی است');
  assert.deepEqual(employee.plan.lines.map((line) => [line.role, line.key]), [[ROLES.EXPENSE_CATEGORY, employee.category], [ROLES.PAYABLE, 'آقای رضایی']]);
  const expense = run(FAMILY.partnerExpense).items[0];
  assert.equal(expense.fundedBy, 'partner');
  assert.ok(!(expense.plan?.lines || []).some((line) => line.role === ROLES.CASH), 'سطر صندوق ندارد');
  for (const key of ['customerToPartner', 'partnerCollected']) {
    const result = run(FAMILY[key]);
    assert.equal(result.path, 'partner-settle', key);
    assert.equal(detectPartnerPaidDebt(FAMILY[key], { now: NOW }).direction, 'receivable', key);
    assert.equal(detectPartnerPaidDebt(FAMILY[key], { now: NOW }).contactName, 'شرکت نوین', key);
  }
  assert.equal(run(FAMILY.theirDebtPaid).path, 'settle');
});

test('روی دفتر: هزینه و خرید از پول شریک یا کارمند، بی‌ردیف نقدی', () => inWorkspace(() => {
  const rows = transactionCount();
  const cash = cashBalance();
  const before = balances()['جاری شریک — بدهی شرکت — آقای سهرابی'] || 0;
  // همان ردیفی که پارسر برنامه می‌سازد و کارت تأیید می‌فرستد.
  const parsed = (text, clientId) => parseFinancialText(text, { source: 'voice' }).transactions.map((item) => ({ ...item, clientId, userConfirmed: true }));
  const goods = database.insertTransactions({ transcript: FAMILY.partnerGoods, transactions: parsed(FAMILY.partnerGoods, 'fam-goods') });
  assert.deepEqual([...goods], []);
  assert.equal(goods.nonCash[0].fundedBy, 'partner');
  const employee = database.insertTransactions({ transcript: FAMILY.employeeExpense, transactions: parsed(FAMILY.employeeExpense, 'fam-fuel') });
  assert.equal(employee.nonCash[0].fundedBy, 'employee');
  assert.equal(transactionCount(), rows, 'هیچ ردیف نقدی');
  assert.equal(cashBalance(), cash, 'صندوق و بانک دست‌نخورده');
  const after = balances();
  assert.equal(goods.nonCash[0].status, 'posted', JSON.stringify(db().prepare('SELECT route,confidence FROM financial_events WHERE id=?').get(goods.nonCash[0].eventId)));
  assert.equal(employee.nonCash[0].status, 'posted', JSON.stringify(employee.nonCash));
  assert.equal(after['جاری شریک — بدهی شرکت — آقای سهرابی'], before - 100_000_000);
  assert.equal(after['حساب پرداختنی — آقای رضایی'], -2_000_000);
  assert.equal(accounting.trialBalance(db()).balanced, true);
}));

test('روی دفتر: طلب ما به حساب شخصی شریک وصول شد — سند و دفتر کل', () => inWorkspace(() => {
  const novin = database.saveContact({ name: 'شرکت نوین' });
  const sale = database.saveObligation({ title: 'فروش قالب', amount: 50_000_000, direction: 'receivable', contactId: novin.id });
  const cash = cashBalance();
  database.settleObligation(sale.id, { paidBy: { name: 'آقای سهرابی' } });
  assert.equal(database.listObligations({ status: 'all' }).find((item) => item.id === sale.id).status, 'paid');
  assert.equal(balances()['جاری شریک — طلب شرکت — آقای سهرابی'], 50_000_000, 'شریک به شرکت بدهکار شد');
  assert.equal(cashBalance(), cash);
  // طلبِ دفتر کل بی‌سند (فروش تأییدشده از صف حسابدار).
  const event = normalizeFinancialEvent({ kind: EVENT_KINDS.RECEIVABLE_OPENED, amount: 70_000_000, occurredAt: NOW.toISOString(),
    counterparty: novin.name, counterpartyId: novin.id, category: 'فروش', source: 'text' });
  recordFinancialEvent(db(), event, { sourceEventId: 'review-approved:novin-sale', decision: routeEvent(event, { components: { amountCertainty: 1, moneyDirectionCertainty: 1, dateCertainty: 1, completeness: 1, counterpartyCertainty: 1 } }) });
  assert.equal(database.ledgerSideBalances(novin.id).uncoveredReceivable, 70_000_000);
  database.settleLedgerBalance(novin.id, { direction: 'receivable', amount: 30_000_000, paidBy: { name: 'آقای سهرابی' }, clientId: 'fam-recv' });
  assert.equal(balances()['جاری شریک — طلب شرکت — آقای سهرابی'], 80_000_000);
  assert.equal(database.ledgerSideBalances(novin.id).uncoveredReceivable, 40_000_000);
  assert.equal(cashBalance(), cash);
}));

test('روی دفتر: تسویهٔ نقدیِ ماندهٔ بی‌سند — ردیف نقدی و سند نقد در برابر طرف حساب', () => inWorkspace(() => {
  const sepehr = database.saveContact({ name: 'شرکت سپهر' });
  reviewedPurchase(sepehr, 90_000_000, 'sepehr-1');
  const rows = transactionCount();
  const cash = cashBalance();
  const paid = database.settleLedgerBalance(sepehr.id, { direction: 'payable', amount: 40_000_000, clientId: 'fam-cash' });
  assert.ok(paid.transactionId, 'پول واقعاً از صندوق رفت، پس ردیف نقدی دارد');
  assert.equal(transactionCount(), rows + 1);
  assert.equal(cashBalance(), cash - 40_000_000);
  assert.equal(payableOf('شرکت سپهر'), 50_000_000);
  // سند باز همان شخص از مسیر خودش بسته می‌شود؛ ماندهٔ بی‌سند آن را دوباره پیشنهاد نمی‌کند.
  database.saveObligation({ title: 'خرید ورق', amount: 30_000_000, direction: 'payable', contactId: sepehr.id });
  assert.equal(database.ledgerSideBalances(sepehr.id).uncoveredPayable, 50_000_000);
  assert.throws(() => database.settleLedgerBalance(sepehr.id, { direction: 'payable', amount: 60_000_000 }), /بیشتر است/);
  assert.equal(accounting.trialBalance(db()).balanced, true);
}));

test('فهم با AI: پول مشتری به حساب شخصی شریک — طلب بسته، جاری شریک بدهکار', async () => {
  await inWorkspace(async () => {
    const tara = database.saveContact({ name: 'شرکت تارا' });
    const sale = database.saveObligation({ title: 'فروش لوله', amount: 60_000_000, direction: 'receivable', contactId: tara.id });
    const text = 'شرکت تارا ۶۰ میلیون از بدهیش رو به حساب شخصی آقای سهرابی ریخت';
    outputs.set(text, {
      ...understood(),
      event: { kind: 'paid-by-partner', description: 'وصول طلب به حساب شخصی شریک', status: 'done' },
      amounts: [{ id: 'a1', value: 60_000_000, currency: null, role: 'received-now', status: 'done', partOf: null, basis: 'explicit', computedFrom: none, evidence: '۶۰ میلیون' }],
      counterparties: [
        { id: 'c1', name: 'آقای سهرابی', role: 'owner', evidence: 'حساب شخصی آقای سهرابی' },
        { id: 'c2', name: 'شرکت تارا', role: 'customer', evidence: 'شرکت تارا' },
      ],
      movements: [{ id: 'm1', amountRef: 'a1', direction: 'none', from: { kind: 'counterparty', name: 'شرکت تارا' }, to: { kind: 'counterparty', name: 'آقای سهرابی' }, evidence: 'ریخت' }],
    });
    const cash = cashBalance();
    const item = await database.createUnderstandingCase({ text, clientId: 'ai-recv-partner' }, options);
    assert.equal(item.status, 'ready', JSON.stringify(item.plan));
    assert.deepEqual(item.plan.components[0].preview.lines.map((line) => line.role), ['partner-receivable', 'receivable']);
    database.commitUnderstandingCase(item.id, { now: NOW });
    assert.equal(database.listObligations({ status: 'all' }).find((row) => row.id === sale.id).status, 'paid');
    assert.equal(cashBalance(), cash);
  });
});
