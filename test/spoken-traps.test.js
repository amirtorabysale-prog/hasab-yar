import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { applySpokenCorrection, describesUnperformedCondition, hasCompositeAmounts, parseFinancialText } from '../shared/parser.js';
import { detectVoiceIntent } from '../shared/voiceIntent.js';
import { judgmentReason } from '../shared/moneyPurpose.js';
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

test.after(() => removeTempDatabase(databasePath));
