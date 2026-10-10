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

    const cheque = database.recordCheque({ direction: 'payable', counterpartyName: 'شرکت پخش البرز', amount: 55_000_000, against: 'income',
      dueAt: '2026-11-21T08:30:00.000Z', note: 'از شرکت پخش البرز ۵۰ میلیون کالا به‌علاوه ۱۰ درصد ارزش افزوده خریدیم؛ یه چک ۵۵ میلیونی دادیم' });
    assert.equal(cheque.queuedForAccountant, true);
    assert.match(cheque.queuedReason, /ارزش افزوده/);
  });
});

test.after(() => removeTempDatabase(databasePath));
