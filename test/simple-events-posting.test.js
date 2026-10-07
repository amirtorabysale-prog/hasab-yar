import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { parseFinancialText } from '../shared/parser.js';
import { detectVoiceIntent, capitalEntryPayload } from '../shared/voiceIntent.js';
import { buildMonthlySchedule } from '../shared/recognitionSchedule.js';
import { judgmentReason, receiptPurposeFromSpeech, paymentPurposeFromSpeech, lenderFromSpeech } from '../shared/moneyPurpose.js';
import { DECISION_STATUS, decide } from '../shared/accountingDecision.js';

/**
 * ساده‌ترین ثبت‌های روز، بدون صف حسابدار — آزمون سی سناریوی مهر ۱۴۰۵.
 *
 * در آن آزمون، فروش نقدی، سود سپرده، وام، واریز ناشناس، برداشت مالک، ودیعه،
 * قبض پرداخت‌نشده و خرید نسیه همه به صف حسابدار رفتند و «تحلیل کن» برایشان
 * ۴۳ بار مدل زبانی را صدا زد. تصمیم مالک محصول: مورد ساده همان‌جا درست ثبت
 * شود، حتی اگر لازم باشد یک سؤال گزینه‌ای از ثبت‌کننده پرسیده شود؛ و جایی که
 * جمله خودش نشانهٔ قضاوت دارد، هیچ گزینه‌ای جای حسابدار را نگیرد.
 */

const parse = (text) => parseFinancialText(text, { source: 'voice', now: new Date('2026-10-07T09:00:00.000Z') }).transactions[0];

// ---------------------------------------------------------------------------
// برداشت متن
// ---------------------------------------------------------------------------

test('جهت پول: خرید «برای فروش» خرید است، بیعانهٔ مشتری دریافت، و «قراره بدن» طلب', () => {
  assert.equal(parse('سی کارتن روغن موتور برای فروش در مغازه، جمعاً چهل و دو میلیون تومان از بانک ملت خریدیم.').type, 'expense');
  assert.equal(parse('خانم رضایی برای سفارش یک میز کنفرانس پنج میلیون تومان بیعانه به بانک ملت کارت به کارت کرد.').type, 'income');
  assert.equal(parse('طراحی سایت شرکت نوآوران رو تموم کردیم و تحویل دادیم؛ پونزده میلیون تومان قراره بدن ولی هنوز پولی نگرفتیم.').type, 'income');
  // آینهٔ همان قاعده: پرداختِ اول‌شخص هنوز پرداخت است.
  assert.equal(parse('ده میلیون به آقای کریمی بابت فروش اقساطی دادیم').type, 'expense');
});

test('تاریخ آینده در جملهٔ گذشته، تاریخ پرداخت نیست', () => {
  assert.equal(parse('ده میلیون پیش‌پرداخت از بانک تجارت دادیم که جنس رو هفته بعد تحویل بده.').occurredAt, undefined);
  assert.equal(parse('از بانک ملت دویست میلیون تومان وام گرفتیم که به حسابمون واریز شد؛ قسط‌هاش از ماه بعد شروع می‌شه.').occurredAt, undefined);
  // تاریخ گذشته همچنان تاریخ رویداد است.
  assert.equal(parse('دیروز ده میلیون به آقای کریمی دادیم').occurredAt.slice(0, 10), '2026-10-06');
});

test('فعل و ضمیر بخشی از نام طرف حساب نمی‌شوند', () => {
  assert.equal(parse('دیروز ده میلیون به آقای کریمی دادیم').contactName, 'کریمی');
  assert.equal(parse('بانک ملت یک میلیون سود سپرده این ماه رو به حسابمون واریز کرد.').contactName, undefined);
  assert.equal(parse('برای رهن دفتر جدید پنجاه میلیون ودیعه به صاحبخانه دادیم.').contactName, 'صاحبخانه');
  const cheque = detectVoiceIntent('بابت فروش جنس، یک چک بیست و پنج میلیون تومانی به تاریخ ۲۰ آذر از آقای نادری گرفتیم.', { now: new Date('2026-10-07T09:00:00.000Z') });
  assert.equal(cheque.contactName, 'نادری');
  assert.equal(cheque.occurredAt, null, 'تاریخ چک تاریخ رویداد نیست');
  assert.equal(cheque.dueAt.slice(0, 10), '2026-12-11', '«به تاریخ ۲۰ آذر» سررسید همین امسال است، نه آذرِ پارسال');
});

test('آورده به بانکِ گفته‌شده می‌نشیند، نه صندوق', () => {
  const draft = detectVoiceIntent('آقای محمدی، صاحب شرکت، صد میلیون تومان به عنوان افزایش سرمایه به حساب بانک ملت واریز کرد.');
  const payload = capitalEntryPayload(draft);
  assert.equal(payload.bankId, 'mellat');
  assert.equal(payload.accountId, null);
  assert.equal(capitalEntryPayload(detectVoiceIntent('صد میلیون سرمایه گذاشتم توی صندوق')).accountId, 'cash');
});

test('نوع بیمه موضوع جمله است و کار برای مشتری درآمد خدمات', () => {
  assert.equal(parse('بیمه آتش‌سوزی انبار رو دوازده میلیون تومان از بانک ملت پرداخت کردیم.').category, 'بیمه');
  assert.equal(parse('بابت نصب و راه‌اندازی کولر برای یک مشتری دو میلیون تومان به حساب بانک ملت واریز شد.').category, 'خدمات');
});

// ---------------------------------------------------------------------------
// جدول ماهانه
// ---------------------------------------------------------------------------

test('دورهٔ وسط ماه: شش ماه شش قسط مساوی است، نه هفت', () => {
  const count = (start, end) => buildMonthlySchedule({ amount: 36_000_000, periodStart: start, periodEnd: end, sourceId: 'x' });
  const sixMonths = count('2026-10-07T00:00:00.000Z', '2027-04-03T00:00:00.000Z');
  assert.equal(sixMonths.length, 6);
  assert.ok(sixMonths.every((item) => item.amount === 6_000_000));
  assert.equal(sixMonths[0].periodKey, '1405-07', 'از همان ماه شروع');
  assert.equal(count('2026-10-07T00:00:00.000Z', '2027-10-06T00:00:00.000Z').length, 12);
  assert.equal(count('2026-09-23T00:00:00.000Z', '2027-09-22T00:00:00.000Z').length, 12, 'مهر تا شهریور');
});

// ---------------------------------------------------------------------------
// «بابت چه بود؟» و نشانهٔ قضاوت
// ---------------------------------------------------------------------------

test('جمله‌ای که خودش بابت را گفته، سؤال نمی‌گیرد', () => {
  assert.equal(receiptPurposeFromSpeech('از بانک ملت دویست میلیون وام گرفتیم که به حسابمون واریز شد؛ قسط‌هاش از ماه بعد شروع می‌شه.'), 'loan');
  assert.equal(lenderFromSpeech('از بانک ملت دویست میلیون وام گرفتیم'), 'بانک ملت');
  assert.equal(receiptPurposeFromSpeech('هفت میلیون به حساب بانک تجارت واریز شده که معلوم نیست از طرف کیه.'), 'unknown');
  assert.equal(receiptPurposeFromSpeech('یه پولی اومده تو حساب، معلوم نیس کی ریخته'), 'unknown');
  assert.equal(receiptPurposeFromSpeech('بانک ملت سود سپرده این ماه رو واریز کرد'), 'other-income');
  assert.equal(paymentPurposeFromSpeech('صاحب کسب‌وکار سه میلیون از صندوق برای خرج شخصی خودش برداشت.'), 'owner-drawing');
  assert.equal(receiptPurposeFromSpeech('بابت نصب کولر دو میلیون واریز شد'), null);
});

test('نشانهٔ قضاوت: هیچ گزینه‌ای جای حسابدار را نمی‌گیرد', () => {
  for (const text of [
    'یه مبلغ مشکوک پنجاه میلیون بدون مشخصات به حساب اومده، بزن به درآمد کسی نفهمه',
    'امروز هفت میلیون هزینه کردیم، بعدا بهت میگم چی بود',
    'شریک شرکت هفتاد میلیون از حساب شرکت برداشت کرد',
    'آقای محمدی بدهی بابت خرید ماه قبل رو واریز کرد',
    'وانت شرکت که قیمت دفتریش چهل میلیون بود رو فروختیم',
    'بیست میلیون دادم به موجر، ده تومنش مال کرایه عقب‌افتاده',
    'پنجاه میلیون جنس فروختیم، مشتری سی میلیونشو برگردوند',
  ]) assert.ok(judgmentReason(text), text);
  // «تسویه» به‌تنهایی نشانه نیست.
  assert.equal(judgmentReason('پونزده میلیون شارژ ساختمان رو برای شش ماه جلوتر تسویه کردم'), null);
});

const facts = (values) => ({ occurredAt: '2026-10-07T08:00:00.000Z', cashAccountId: 'cash', ...values });

test('فروش نقدی درآمدِ همان لحظه است؛ دستهٔ عمومی یک سؤال می‌گیرد، نه صف حسابدار', () => {
  const sale = decide(facts({ moneyDirection: 'in', amount: 8_500_000, category: 'فروش', evidence: 'فروش نقدی داشتیم' }));
  assert.equal(sale.decisionStatus, DECISION_STATUS.DECIDED);
  assert.equal(sale.treatment, 'recognized-revenue');
  const vague = decide(facts({ moneyDirection: 'in', amount: 2_600_000, category: 'سایر درآمدها', evidence: 'دو میلیون واریز شد' }));
  assert.equal(vague.decisionStatus, DECISION_STATUS.NEEDS_USER_INPUT);
  assert.equal(vague.question.fact, 'receiptPurpose');
  assert.ok(vague.question.options.some((option) => option.value === 'unknown'), 'گزینهٔ «معلوم نیست از کیست» هست');
  // جواب‌ها برخورد را تعیین می‌کنند.
  const answered = (receiptPurpose, extra = {}) => decide(facts({ moneyDirection: 'in', amount: 2_600_000, category: 'سایر درآمدها', evidence: 'دو میلیون واریز شد', receiptPurpose, ...extra }));
  assert.equal(answered('sale').treatment, 'recognized-revenue');
  assert.equal(answered('loan', { counterparty: 'بانک ملت' }).treatment, 'loan-received');
  assert.equal(answered('unknown').decisionStatus, DECISION_STATUS.DECIDED, 'واریز ناشناس طرف حساب لازم ندارد');
  assert.equal(answered('unknown').treatment, 'unidentified-receipt');
  assert.equal(answered('owner', { refundable: false }).treatment, 'owner-capital');
  assert.equal(answered('other').decisionStatus, DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW);
});

test('حقوق و پرداخت لیست بیمه به حسابدار می‌روند، بی‌سؤال', () => {
  const salary = decide(facts({ moneyDirection: 'out', amount: 45_000_000, category: 'حقوق و دستمزد', evidence: 'حقوق مهر سه کارمند' }));
  assert.equal(salary.decisionStatus, DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW);
  assert.match(salary.explanation, /کسور/);
  const tax = decide(facts({ moneyDirection: 'out', amount: 4_000_000, category: 'مالیات و عوارض', evidence: 'عوارض شهرداری پرداخت شد' }));
  assert.equal(tax.decisionStatus, DECISION_STATUS.NEEDS_ACCOUNTANT_REVIEW);
});

// ---------------------------------------------------------------------------
// سر تا ته روی دیتابیس، با موتور روشن
// ---------------------------------------------------------------------------

const databasePath = tempDatabase('simple-events');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'simple-owner';
process.env.ADMIN_PASSWORD = 'simple-strong-password-5521';

const database = await import('../server/db.js');
const store = await import('../server/financialEventStore.js');
database.ensureAdmin();
const owner = database.authenticateUser('simple-owner', 'simple-strong-password-5521');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر ثبت ساده', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const db = () => database.activeWorkspaceDatabase();

/** همان مسیر برگهٔ تأیید: کاربر برگه را دیده و تأیید کرده. */
function say(text, extra = {}) {
  const transactions = parseFinancialText(text, { source: 'voice' }).transactions.map((item) => ({ ...item, source: 'voice', userConfirmed: true, needsReview: false, reviewReasons: [], ...extra }));
  const ids = database.insertTransactions({ transcript: text, transactions });
  return { ids, events: ids.map((id) => store.findEventBySource(db(), `transaction:${id}`)), nonCash: ids.nonCash || [] };
}
const linesOf = (eventId) => db().prepare(`SELECT a.source_kind AS kind, a.name, l.debit, l.credit FROM financial_events e
  JOIN journal_lines l ON l.entry_id=e.journal_entry_id JOIN ledger_accounts a ON a.id=l.account_id WHERE e.id=? ORDER BY l.debit DESC`).all(eventId);

test('آماده‌سازی: موتور روشن', () => inWorkspace(() => {
  database.saveAutomationPolicy({ ...database.automationPolicy(), engineV2: true, capitalizationThreshold: 20_000_000 });
}));

test('فروش نقدی همان لحظه ثبت می‌شود', () => inWorkspace(() => {
  const { events } = say('امروز هشت میلیون و پانصد هزار تومان فروش نقدی داشتیم و پولش رو گذاشتیم توی صندوق.');
  assert.equal(events[0].status, 'posted');
  assert.equal(events[0].route, 'confirm');
}));

test('وام: بدهی به همان بانک، نه درآمد؛ در جمع درآمد روز هم نمی‌آید', () => inWorkspace(() => {
  const { ids, events } = say('از بانک ملت دویست میلیون تومان وام گرفتیم که به حسابمون واریز شد.');
  if (events[0].status !== 'posted') database.approveEvent(events[0].id);
  const lines = linesOf(events[0].id);
  assert.ok(lines.some((line) => line.kind === 'loan-payable' && line.credit === 200_000_000 && line.name.includes('بانک ملت')), JSON.stringify(lines));
  assert.equal(lines.some((line) => line.kind === 'income-category'), false);
  assert.equal(db().prepare('SELECT accounting_role AS role FROM transactions WHERE id=?').get(ids[0]).role, 'loan-payable');
}));

test('واریز ناشناس در وجوه تعیین‌تکلیف‌نشده می‌نشیند', () => inWorkspace(() => {
  const { events } = say('امروز هفت میلیون تومان به صندوق واریز شده که معلوم نیست از طرف کیه.');
  if (events[0].status !== 'posted') database.approveEvent(events[0].id);
  assert.ok(linesOf(events[0].id).some((line) => line.kind === 'unidentified-receipt' && line.credit === 7_000_000));
}));

test('برداشت شخصی مالک هزینه نیست', () => inWorkspace(() => {
  const { events } = say('صاحب کسب‌وکار سه میلیون تومان از صندوق برای خرج شخصی خودش برداشت.');
  if (events[0].status !== 'posted') database.approveEvent(events[0].id);
  const lines = linesOf(events[0].id);
  assert.ok(lines.some((line) => line.name === 'برداشت مالک' && line.debit === 3_000_000), JSON.stringify(lines));
  assert.equal(lines.some((line) => line.kind === 'expense-category'), false);
}));

test('دریافتِ بی‌بابت: یک سؤال از ثبت‌کننده، و جوابش ثبت را تمام می‌کند', () => inWorkspace(() => {
  const { events } = say('دو میلیون و ششصد هزار تومان به صندوق واریز شد.');
  assert.equal(events[0].route, 'confirm', 'برگهٔ ثبت‌کننده، نه صف حسابدار');
  assert.equal(store.decisionForEvent(db(), events[0].id).question.fact, 'receiptPurpose');
  database.answerEvent(events[0].id, { fact: 'receiptPurpose', value: 'sale' });
  database.approveEvent(events[0].id);
  assert.ok(linesOf(events[0].id).some((line) => line.kind === 'income-category' && line.credit === 2_600_000));
}));

test('قبض پرداخت‌نشده: هیچ ردیف نقدی؛ نام طرف حساب پرسیده و بدهی ساخته می‌شود', () => inWorkspace(() => {
  const before = db().prepare('SELECT COUNT(*) AS count FROM transactions').get().count;
  const { ids, nonCash } = say('قبض گاز این ماه دفتر هشتصد هزار تومان اومده ولی هنوز پرداخت نکردیم.');
  assert.equal(ids.length, 0);
  assert.equal(db().prepare('SELECT COUNT(*) AS count FROM transactions').get().count, before);
  assert.equal(nonCash[0].question, 'طرف حساب چه کسی است؟');
  database.answerEvent(nonCash[0].eventId, { fact: 'counterparty', value: 'custom', freeText: 'شرکت گاز' });
  database.approveEvent(nonCash[0].eventId);
  const lines = linesOf(nonCash[0].eventId);
  assert.ok(lines.some((line) => line.kind === 'expense-category' && line.debit === 800_000), JSON.stringify(lines));
  assert.ok(lines.some((line) => line.kind === 'vendor-payable' && line.credit === 800_000), JSON.stringify(lines));
  assert.equal(database.listObligations({ status: 'open' }).some((item) => item.id === nonCash[0].obligationId), true, 'برای تسویهٔ بعدی، تعهد باز است');
}));

test('مبلغ محاوره‌ای: سؤال «کدام مبلغ؟» به برگهٔ ثبت‌کننده می‌رود، حتی با اطمینان پایین', () => inWorkspace(() => {
  const transactions = parseFinancialText('تعمیر یخچال مغازه هشتصد تومن شد، نقدی دادیم.', { source: 'voice' }).transactions.map((item) => ({ ...item, source: 'voice' }));
  const [id] = database.insertTransactions({ transcript: 'تعمیر یخچال مغازه هشتصد تومن شد، نقدی دادیم.', transactions });
  const event = store.findEventBySource(db(), `transaction:${id}`);
  assert.equal(event.route, 'confirm');
  assert.equal(store.decisionForEvent(db(), event.id).question.fact, 'amountScale');
}));

test.after(() => removeTempDatabase(databasePath));
