import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { applySpokenCorrection, describesUnperformedCondition, hasCompositeAmounts, parseFinancialText } from '../shared/parser.js';
import { detectVoiceIntent } from '../shared/voiceIntent.js';
import { judgmentReason, paymentPurposeFromSpeech } from '../shared/moneyPurpose.js';
import { detectCaptureTransfer } from '../shared/bankSpeech.js';
import { transactionEventDecision } from '../shared/transactionEvent.js';
import { planJournal } from '../shared/accountingRules.js';
import { understandingReasons } from '../shared/understandingScope.js';
import { applyAnswer } from '../shared/questionAnswer.js';
import { normalizeFinancialEvent } from '../shared/financialEvent.js';
import { decide, DECISION_STATUS } from '../shared/accountingDecision.js';

/**
 * دام‌های گفتار که ثبت غلط با اطمینان می‌ساختند (آزمون ۱۵ چالشی، مسیر بدون AI).
 *
 * «۳۰ میلیونش … بقیه‌اش»: عدد دوم جزئی از اولی است، نه رویداد تازه.
 *
 * بدون این تشخیص، «۸۰ میلیون فروختیم؛ ۳۰ میلیونش رو واریز کرد و بقیه‌اش رو
 * آخر ماه می‌ده» دو فروش ۸۰ و ۳۰ به بانک ثبت می‌کرد — ۱۱۰ میلیون فروش، و ۵۰
 * میلیونِ نسیه هم نقد. ثبت غلط با اطمینان، بی هیچ هشداری.
 */
const databasePath = tempDatabase('part-of-total');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'part-owner';
process.env.ADMIN_PASSWORD = 'part-of-total-strong-password-5520';

const SALE = 'امروز به شرکت آریا ۸۰ میلیون تومان جنس فروختیم؛ ۳۰ میلیونش رو کارت به کارت به ملت زد و بقیه‌اش رو قرار شد آخر ماه بده.';

test('جزء یک کل به زبان گفتار، گفتهٔ مرکب است', () => {
  for (const sentence of [
    SALE,
    '۱۰۰ میلیون فروختیم، ۴۰ تاش نقد بقیه چک',
    'آقای رضوی ۱۰۰ میلیون به حساب ملت ریخت؛ ۷۰ میلیونش آورده است و ۳۰ میلیونش قرض',
    '۵۰ میلیون از مشتری گرفتیم، ۲۰ میلیون باقیمانده رو هفته بعد میده',
    'سی میلیون دادیم و مابقی ده میلیون رو ماه بعد می‌دیم',
  ]) {
    assert.equal(hasCompositeAmounts(sentence), true, sentence);
    assert.ok(understandingReasons(sentence).includes('composite'), 'با فهم AI روشن، همین گفته به مدل می‌رود');
  }
});

test('دو رویداد مستقل در یک جمله همچنان دو ردیف‌اند', () => {
  for (const sentence of ['۵ میلیون قبض برق و ۲ میلیون بنزین دادم', '۱۸ میلیون فروش نقدی و ۳ میلیون هزینه پیک']) {
    assert.equal(hasCompositeAmounts(sentence), false, sentence);
    assert.equal(parseFinancialText(sentence).transactions.length, 2, sentence);
  }
  // پسوند روی تک‌مبلغ («پنجاه میلیونیش») جزء کل نیست.
  assert.equal(hasCompositeAmounts('بدهی پنجاه میلیونیش رو دادیم'), false);
});

test('سرور هم ثبت مستقیم چنین گفته‌ای را نمی‌پذیرد', async () => {
  const database = await import('../server/db.js');
  database.ensureAdmin();
  const owner = database.authenticateUser('part-owner', 'part-of-total-strong-password-5520');
  const workspace = database.createWorkspace(owner.id, { name: 'دفتر جزء و کل', profileType: 'business' });
  await database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, () => {
    const transactions = parseFinancialText(SALE).transactions.map((item) => ({ ...item, source: 'text', accountId: 'cash' }));
    assert.throws(() => database.insertTransactions({ transcript: SALE, transactions }));
    assert.equal(database.activeWorkspaceDatabase().prepare('SELECT count(*) n FROM transactions').get().n, 0, 'هیچ ردیف نقدی ساخته نشد');
  });
});

test('عددی که گوینده اصلاح کرد، ثبت نمی‌شود', () => {
  const amounts = (sentence) => parseFinancialText(sentence).transactions.map((item) => item.amount);
  assert.deepEqual(amounts('۱۲ میلیون، نه ببخشید ۱۸ میلیون بابت تعمیر یخچال مغازه نقدی دادیم.'), [18_000_000]);
  // «نه»ی اصلاح عددِ نه نیست: این جمله ۳۹ میلیون خوانده می‌شد.
  assert.deepEqual(amounts('دوازده میلیون نه هجده میلیون دادیم'), [18_000_000]);
  assert.deepEqual(amounts('پنج میلیون اشتباه گفتم شش میلیون خرج پیک شد'), [6_000_000]);
  // «ده میلیون نه هزار» اصلاح نیست؛ ده میلیون و نه هزار است.
  assert.deepEqual(amounts('ده میلیون نه هزار تومان دادیم'), [10_009_000]);
  assert.equal(applySpokenCorrection('نه میلیون دادیم'), 'نه میلیون دادیم');
});

test('کار شرطیِ آینده رویداد مالی نیست و ردیف نقدی نمی‌سازد', () => {
  for (const sentence of ['اگر شرکت نوین سفارش رو تأیید کنه، هفتهٔ بعد ۲۰ میلیون پیش‌پرداخت براشون می‌ریزیم.', 'در صورت تأیید، فردا ۱۵ میلیون بیعانه می‌دهیم']) {
    assert.equal(describesUnperformedCondition(sentence), true, sentence);
    const parsed = parseFinancialText(sentence);
    assert.equal(parsed.transactions.length, 0);
    assert.match(parsed.clarification, /شرطی/);
  }
  // «اگه» در جملهٔ انجام‌شده، شرط نیست.
  assert.equal(parseFinancialText('اگه اشتباه نکنم دیروز ۵ میلیون به پیک دادیم').transactions.length, 1);
  assert.equal(parseFinancialText('۲۰ میلیون پیش‌پرداخت دادیم که اگر تأیید کنن جنس بفرستن').transactions.length, 1);
});

test('واریزی که منشأش حدس است، نه فاکتور می‌سازد نه فروش', () => {
  const sentence = 'امروز ۱۷ مهر ۱۴۰۵ مبلغ ۹ میلیون و ۷۵۰ هزار تومان به حساب تجارت واریز شده؛ احتمالاً مال خانم توکلیه بابت فاکتور فروش، ولی مطمئن نیستیم.';
  assert.equal(detectVoiceIntent(sentence), null, 'برگهٔ صدور فاکتور باز نمی‌شود');
  assert.ok(judgmentReason(sentence), 'تردیدِ خودِ گوینده به حسابدار می‌رود');
  assert.deepEqual(parseFinancialText(sentence).transactions.map((item) => item.amount), [9_750_000], 'تاریخ مبلغ نیست');
  // پولِ آمده بابت فاکتور، وصول است نه صدور فاکتور تازه.
  assert.equal(detectVoiceIntent('۵ میلیون بابت فاکتور فروش شرکت آریا به حساب ملت واریز شد'), null);
});

test('پایا با کارمزد: یک انتقال و یک هزینهٔ کارمزد، فقط بین حساب‌های خودِ شرکت', () => {
  const accounts = [{ id: 'cash', name: 'صندوق', kind: 'cash' }, { id: 'b1', name: 'بانک ملت', kind: 'bank', bankId: 'mellat' }, { id: 'b2', name: 'بانک تجارت', kind: 'bank', bankId: 'tejarat' }];
  const draft = detectCaptureTransfer('۴۰ میلیون از ملت به تجارت پایا زدیم و ۲۵ هزار تومان کارمزدش هم از ملت کم شد.', { accounts });
  assert.deepEqual({ amount: draft.amount, fee: draft.fee, from: draft.fromAccountId, to: draft.toAccountId }, { amount: 40_000_000, fee: 25_000, from: 'b1', to: 'b2' });
  assert.equal(detectCaptureTransfer('۱۰ میلیون از ملت به تجارت ساتنا کردیم', { accounts }).amount, 10_000_000);
  // پایا به حساب شخص دیگر، پرداخت است نه انتقال داخلی.
  assert.equal(detectCaptureTransfer('به آقای رضایی ۱۰ میلیون از ملت به حساب تجارتش پایا زدیم', { accounts }), null);
});

test('مساعده طلب از کارمند است، نه هزینهٔ حقوق', () => {
  const sentence = '۵ میلیون تومان از صندوق به آقای کاظمی، کارمندمون، مساعده دادیم که از حقوق آبانش کم کنیم.';
  assert.equal(paymentPurposeFromSpeech(sentence), 'employee-advance');
  const [item] = parseFinancialText(sentence).transactions;
  const { event, accountingDecision } = transactionEventDecision({ ...item, accountId: 'cash', occurredAt: '2026-10-07T08:00:00.000Z' }, { transcript: sentence, policy: { engineV2: true } });
  assert.equal(accountingDecision.treatment, 'employee-advance');
  assert.equal(accountingDecision.decisionStatus, 'decided');
  assert.deepEqual(planJournal(event, accountingDecision).lines.map((line) => line.role), ['employee-advance', 'cash']);
  // بی‌نام، نام کارمند پرسیده می‌شود؛ حقوق همچنان به حسابدار می‌رود.
  const [bare] = parseFinancialText('۳ میلیون مساعده دادیم').transactions;
  assert.equal(transactionEventDecision({ ...bare, accountId: 'cash', occurredAt: '2026-10-07T08:00:00.000Z' }, { transcript: '۳ میلیون مساعده دادیم', policy: { engineV2: true } }).accountingDecision.question?.fact, 'counterparty');
  const [salary] = parseFinancialText('حقوق مهر رو ۶۰ میلیون دادیم').transactions;
  assert.equal(transactionEventDecision({ ...salary, accountId: 'cash', occurredAt: '2026-10-07T08:00:00.000Z' }, { transcript: 'حقوق مهر رو ۶۰ میلیون دادیم', policy: { engineV2: true } }).decision.route, 'accountant-review');
});

test('کارت چک مبلغ و جهت را از جملهٔ خودِ چک می‌خواند', () => {
  const intent = detectVoiceIntent('از شرکت پخش البرز ۵۰ میلیون کالا به‌علاوه ۱۰ درصد ارزش افزوده خریدیم و تحویل گرفتیم؛ یه چک ۵۵ میلیونی به تاریخ ۳۰ آبان بهشون دادیم.');
  assert.deepEqual({ d: intent.direction, a: intent.amount, need: intent.needsAmount, vat: intent.vatMentioned, c: intent.contactName },
    { d: 'payable', a: 55_000_000, need: false, vat: true, c: 'شرکت پخش البرز' });
  // چکی که مبلغ خودش را نگفته، همچنان مبلغ پرسیده می‌شود.
  assert.equal(detectVoiceIntent('جمع فاکتور هشتاد میلیون شد، پنج میلیون تخفیف دادیم، مانده رو چک دادن').needsAmount, true);
});

test('سرور: کارمزد با انتقال یک‌جا ثبت می‌شود و چکِ معاملهٔ دارای ارزش افزوده به حسابدار می‌رود', async () => {
  const database = await import('../server/db.js');
  const owner = database.authenticateUser('part-owner', 'part-of-total-strong-password-5520');
  const workspace = database.createWorkspace(owner.id, { name: 'دفتر کارمزد و چک', profileType: 'business' });
  await database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, () => {
    const mellat = database.saveAccount({ name: 'بانک ملت', kind: 'bank', openingBalance: 100_000_000 });
    const tejarat = database.saveAccount({ name: 'بانک تجارت', kind: 'bank', openingBalance: 0 });
    const balance = (id) => database.listAccounts().find((item) => item.id === id).balance;
    assert.throws(() => database.transferWithFee({ fromAccountId: mellat.id, toAccountId: tejarat.id, amount: 1_000, fee: 5_000 }));
    assert.equal(balance(mellat.id), 100_000_000, 'کارمزد نامعتبر: هیچ‌چیز ثبت نشد');
    const result = database.transferWithFee({ fromAccountId: mellat.id, toAccountId: tejarat.id, amount: 40_000_000, fee: 25_000 });
    assert.ok(result.feeTransactionId);
    assert.equal(balance(mellat.id), 100_000_000 - 40_000_000 - 25_000);
    assert.equal(balance(tejarat.id), 40_000_000);
    // برگهٔ انتقال برای انتقال بی‌کارمزد `fee: 0` می‌فرستد؛ این نباید رد شود.
    for (const fee of [0, '0', '', null]) database.transferWithFee({ fromAccountId: mellat.id, toAccountId: tejarat.id, amount: 1_000_000, fee });
    assert.equal(balance(tejarat.id), 44_000_000);

    const cheque = database.recordCheque({ direction: 'payable', counterpartyName: 'شرکت پخش البرز', amount: 55_000_000, against: 'income',
      dueAt: '2026-11-21T08:30:00.000Z', note: 'از شرکت پخش البرز ۵۰ میلیون کالا به‌علاوه ۱۰ درصد ارزش افزوده خریدیم؛ یه چک ۵۵ میلیونی دادیم' });
    assert.equal(cheque.queuedForAccountant, true);
    assert.match(cheque.queuedReason, /ارزش افزوده/);
  });
});

test('تاریخ شمسیِ تایپ‌شده شمسی خوانده می‌شود، نه سال ۱۴۰۵ میلادی', () => {
  const event = { occurredAt: '2026-10-10T08:00:00.000Z' };
  for (const typed of ['1405/07/30', '۱۴۰۵/۰۷/۳۰', '۳۰ مهر ۱۴۰۵']) {
    const patch = applyAnswer(event, { fact: 'servicePeriodStart', value: 'custom', freeText: typed });
    assert.equal(patch.servicePeriodStart.slice(0, 10), '2026-10-22', typed);
  }
  assert.equal(applyAnswer(event, { fact: 'servicePeriodStart', value: 'custom', freeText: '2026-10-21' }).servicePeriodStart.slice(0, 10), '2026-10-21');
  assert.throws(() => applyAnswer(event, { fact: 'servicePeriodStart', value: 'custom', freeText: 'یه وقتی' }), { code: 'ANSWER_DATE_INVALID' });
  // تاریخی که جای دیگری بی‌تبدیل به ISO رفته هم در لایهٔ رویداد شمسی خوانده می‌شود.
  for (const raw of ['1405/07/30', '1405-07-30T00:00:00.000Z']) {
    assert.equal(normalizeFinancialEvent({ kind: 'cash-expense', amount: 1000, occurredAt: raw }).occurredAt.slice(0, 10), '2026-10-22', raw);
  }
});

test('اجارهٔ ماه نام‌برده دوره دارد: همین ماه یا گذشته هزینه، ماه آینده پیش‌پرداخت', () => {
  const now = new Date('2026-10-10T08:00:00.000Z');
  const decideFor = (sentence) => {
    const [item] = parseFinancialText(sentence, { now }).transactions;
    return decide({ moneyDirection: 'out', amount: item.amount, category: item.category, evidence: sentence, occurredAt: now.toISOString(),
      cashAccountId: 'cash', servicePeriodStart: item.servicePeriodStart, servicePeriodEnd: item.servicePeriodEnd }, { today: now.toISOString() });
  };
  for (const sentence of ['اجاره مهر بیست میلیون دادم', 'اجارهٔ مهر ماه رو ۲۰ میلیون پرداخت کردم', 'اجاره‌ی ماه شهریور ۲۰ میلیون دادم']) {
    const decision = decideFor(sentence);
    assert.equal(decision.decisionStatus, DECISION_STATUS.DECIDED, sentence);
    assert.equal(decision.treatment, 'period-expense', sentence);
  }
  assert.equal(decideFor('اجاره آبان ۲۰ میلیون دادم').treatment, 'prepaid-expense');
  // بی‌ماه، دوره همچنان پرسیده می‌شود؛ «مهر» بیرون از نام خدمت ماه نیست.
  assert.equal(decideFor('اجاره دادم ۲۰ میلیون').question?.fact, 'servicePeriodStart');
  assert.equal(parseFinancialText('مهر شرکت خریدم ۵۰۰ هزار', { now }).transactions[0].servicePeriodStart, undefined);
});

test('«فاکتور زدیم، پولش نیومده» صدور فاکتور است، نه پرداخت', () => {
  const issued = detectVoiceIntent('فاکتور فروش ۵۰ میلیون برای شرکت آلفا زدیم ولی پولش هنوز نیومده');
  assert.equal(issued?.intent, 'invoice');
  assert.equal(issued.documentType, 'sales');
  assert.equal(issued.amount, 50_000_000);
  assert.equal(issued.contactName, 'شرکت آلفا');
  assert.equal(detectVoiceIntent('برای آقای رضایی فاکتور ۳۰ میلیون زدیم، هنوز پول نداده')?.intent, 'invoice');
  assert.equal(detectVoiceIntent('فاکتور فروش ۵۰ میلیون برای شرکت آلفا صادر کردم').contactName, 'شرکت آلفا');
  // پولی که آمده یا رفته، کارت فاکتور نمی‌گیرد.
  assert.equal(detectVoiceIntent('فاکتور ۲۰ میلیون زدیم و پولشو کارت به کارت کرد'), null);
  assert.equal(detectVoiceIntent('سی میلیون به حساب کاظمی زدیم ولی نمیدونم فاکتور خریدش قبلاً ثبت شده'), null);
  // «ندادیم» پرداخت نیست.
  assert.equal(detectVoiceIntent('فاکتور خرید ۱۰ میلیون از تامین گستر، هنوز پولشو ندادیم')?.documentType, 'purchase');
});

test('دور سوم: تخفیف، فروش وسیلهٔ کارکرده، انتقال کارت به کارت و چک برگشتی', async () => {
  assert.equal(hasCompositeAmounts('به شرکت نوین ۱۵ میلیون جنس فروختیم، ۱ میلیون تخفیف دادیم و ۱۴ میلیون رو کارت به کارت به ملت زد.'), true);
  assert.equal(hasCompositeAmounts('۲۰ میلیون با تخفیف فروختیم'), false, 'یک مبلغ، کل و جزء نیست');

  assert.match(judgmentReason('پرینتر قدیمی دفتر رو ۳ میلیون نقد فروختیم.'), /دارایی/);
  assert.match(judgmentReason('لپ تاپ دست دوم خودمون رو ۲۰ میلیون فروختم'), /دارایی/);
  assert.equal(judgmentReason('سه تا پرینتر به مشتری ۴۵ میلیون فروختیم'), null, 'کالای فروش، فروش است');

  const transfer = detectCaptureTransfer('۵۰ میلیون از ملت به تجارت کارت به کارت کردیم.');
  assert.equal(transfer?.intent, 'transfer');
  assert.equal(transfer.amount, 50_000_000);
  assert.equal(detectCaptureTransfer('۵۰ میلیون از حساب ملت به حساب تجارت زدیم')?.intent, 'transfer');
  assert.equal(detectCaptureTransfer('۵۰ میلیون از ملت به آقای رضایی کارت به کارت کردیم'), null, 'به شخص، پرداخت است');
  assert.equal(detectCaptureTransfer('قبض برق ۲ میلیون از ملت زدیم'), null);

  const database = await import('../server/db.js');
  const owner = database.authenticateUser('part-owner', 'part-of-total-strong-password-5520');
  const workspace = database.createWorkspace(owner.id, { name: 'دفتر چک برگشتی', profileType: 'business' });
  await database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, () => {
    const queued = database.queueUnmatchedSettlement('چک ۳۰ میلیونی که از آقای نادری گرفته بودیم برگشت خورد.');
    assert.equal(queued.status, 'pending');
    assert.equal(queued.route, 'accountant-review');
    assert.match(JSON.stringify(database.reviewQueue()), /چک برگشت خورده/);
  });
});

test('پولی که طرف مقابل آورد یا پس داد ورود است؛ جنس آورده یا برگشتی نه', () => {
  const typeOf = (sentence) => parseFinancialText(sentence).transactions[0]?.type;
  assert.equal(typeOf('خانم توکلی ۹ میلیون از بدهی قبلیش رو نقد آورد.'), 'income');
  const deposit = parseFinancialText('صاحبخونه قبلی ۶۰ میلیون ودیعه‌مون رو به تجارت برگردوند.').transactions[0];
  assert.equal(deposit.type, 'income');
  assert.doesNotMatch(String(deposit.counterparty || ''), /برگردوند/);
  assert.equal(typeOf('آقای صالحی ۴ میلیون از جنسی که هفته پیش نسیه برده بود رو پس آورد.'), 'expense', 'برگشت کالا، پول نیاورده');
  assert.equal(typeOf('فروشنده ۱۰ میلیون جنس آورد'), 'expense');
  assert.equal(typeOf('۵ میلیون ودیعه رو به صاحبخونه برگردوندیم'), 'expense');
});

test.after(() => removeTempDatabase(databasePath));
