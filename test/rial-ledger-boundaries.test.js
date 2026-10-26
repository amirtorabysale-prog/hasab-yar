import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { parseFinancialText } from '../shared/parser.js';
import { detectVoiceIntent } from '../shared/voiceIntent.js';
import { detectSettleIntent } from '../shared/settleSpeech.js';
import { detectPartnerPaidDebt } from '../shared/partnerPaidSpeech.js';
import { detectBankMovementIntent, detectCaptureTransfer, detectPettyCashFunding } from '../shared/bankSpeech.js';
import { averagesInToman, draftInLedgerUnit, parseResultInLedgerUnit } from '../shared/amountUnit.js';
import { previewCorrection } from '../shared/correction.js';
import { extractReceiptData } from '../server/receiptOcr.js';
import { prepareOpeningBalanceRows } from '../server/ledgerImport.js';

/**
 * خانوادهٔ «مبلغ گفته‌شده در دفتر ریالی».
 *
 * مردم به تومان می‌گویند و پارسر و AI هم به تومان می‌خوانند؛ دفتر ریالی همان را ده
 * برابر و در یک‌جا (مرز ورود) می‌گیرد. هر مسیر ورود یک عضو این خانواده است: متن و
 * صدا، کارت‌های نیت (طلب و بدهی، چک، فاکتور، آورده، انتقال، تنخواه، ساخت حساب،
 * تسویه، پرداخت شریک)، اصلاح گفتاری، رسید، فایل افتتاحیه و صف حسابدار. نمونهٔ منفی
 * هر کدام دفتر تومانی است که باید عیناً همان رفتار قبلی را داشته باشد.
 */

const now = new Date('2026-10-20T08:00:00.000Z');
const rial = (value) => draftInLedgerUnit(value, 'rial');
const toman = (value) => draftInLedgerUnit(value, 'toman');
const parsed = (text) => parseFinancialText(text, { source: 'text', now });

test('متن و صدا: تومانِ گفته‌شده ده برابر، ریالِ گفته‌شده همان عدد دقیق', () => {
  assert.deepEqual(parseResultInLedgerUnit(parsed('دو میلیون تومن بنزین زدم'), 'rial').transactions.map((item) => item.amount), [20_000_000]);
  assert.deepEqual(parseResultInLedgerUnit(parsed('۸۵۰ هزار تومان از آقای رضایی گرفتیم'), 'rial').transactions.map((item) => item.amount), [8_500_000]);
  // ریالی که بر ۱۰ بخش نمی‌شود در دفتر تومانی گرد می‌شد؛ دفتر ریالی رقم آخر را نگه می‌دارد.
  assert.deepEqual(parseResultInLedgerUnit(parsed('۱۲۰۵ ریال کارمزد بانک'), 'rial').transactions.map((item) => item.amount), [1_205]);
  assert.deepEqual(parseResultInLedgerUnit(parsed('کارمزد بانک 7200 ریال'), 'rial').transactions.map((item) => item.amount), [7_200]);
  assert.deepEqual(parseResultInLedgerUnit(parsed('۱۵۰۰ ریال کارمزد بانک کم شد'), 'rial').transactions.map((item) => item.amount), [1_500]);
});

test('متن در دفتر تومانی: همان خروجی قبلی، بی‌هیچ تبدیل', () => {
  const result = parsed('دو میلیون تومن بنزین زدم');
  assert.equal(parseResultInLedgerUnit(result, 'toman'), result);
  assert.deepEqual(parseResultInLedgerUnit(parsed('۱۵۰۰ ریال کارمزد بانک کم شد'), 'toman').transactions.map((item) => item.amount), [150]);
});

test('میانگین‌های دفتر ریالی پیش از قاعدهٔ «مبلغ غیرعادی» به تومان برمی‌گردند', () => {
  assert.deepEqual(averagesInToman({ 'سوخت': 20_000_000 }, 'rial'), { 'سوخت': 2_000_000 });
  const averages = { 'سوخت': 2_000_000 };
  assert.equal(averagesInToman(averages, 'toman'), averages);
});

test('کارت‌های نیت: طلب، بدهی، چک تکی و سری، فاکتور با قیمت واحد، آورده', () => {
  assert.equal(rial(detectVoiceIntent('پنج میلیون از آقای رضایی طلب داریم', { now })).amount, 50_000_000);
  assert.equal(rial(detectVoiceIntent('به شرکت پارس ۱۲ میلیون بدهکاریم', { now })).amount, 120_000_000);
  const series = rial(detectVoiceIntent('۱۲ تا چک ۱۰ میلیونی به آقای کریمی دادیم', { now }));
  assert.equal(series.amount, 1_200_000_000);
  assert.equal(series.perChequeAmount, 100_000_000);
  assert.equal(series.chequeCount, 12);
  const invoice = rial(detectVoiceIntent('فاکتور فروش ۵ عدد صندلی هر عدد ۲ میلیون برای شرکت آلفا', { now }));
  assert.deepEqual(invoice.lines.map((line) => [line.quantity, line.unitPrice]), [[5, 20_000_000]]);
  assert.equal(rial(detectVoiceIntent('پنجاه میلیون سرمایه گذاشتم', { now })).amount, 500_000_000);
  // دفتر تومانی: همان کارت، همان شیء.
  const obligation = detectVoiceIntent('پنج میلیون از آقای رضایی طلب داریم', { now });
  assert.equal(toman(obligation), obligation);
});

const accounts = [
  { id: 'cash', name: 'صندوق', kind: 'cash', active: 1 },
  { id: 'mellat', name: 'بانک ملت', kind: 'bank', bankId: 'mellat', active: 1 },
  { id: 'tejarat', name: 'بانک تجارت', kind: 'bank', bankId: 'tejarat', active: 1 },
  // تنخواهِ باز با سقف و مانده به واحد دفتر (ریال).
  { id: 'petty', name: 'تنخواه رضایی', kind: 'petty', holderName: 'رضایی', pettyCeiling: 50_000_000, balance: 12_000_000, active: 1 },
];

test('انتقال با کارمزد و ساخت حساب بانکی با موجودی اولیه', () => {
  const transfer = rial(detectCaptureTransfer('۴۰ میلیون از ملت به تجارت پایا زدیم و ۲۵ هزار تومان کارمزدش هم از ملت کم شد.', { accounts }));
  assert.equal(transfer.amount, 400_000_000);
  assert.equal(transfer.fee, 250_000);
  const created = rial(detectBankMovementIntent('حساب بانک ملت را بساز و ده میلیون موجودی اولیه‌اش کن', { accounts: [], now }));
  assert.equal(created.intent, 'create-account');
  assert.equal(created.openingBalance, 100_000_000);
});

test('تنخواه: مبلغ گفته‌شده ده برابر؛ کسری سقف که از خود دفتر آمده دست نمی‌خورد', () => {
  assert.equal(rial(detectPettyCashFunding('پنج میلیون تنخواه به رضایی دادیم', { accounts, now })).amount, 50_000_000);
  const recharge = detectPettyCashFunding('تنخواه رضایی رو از ملت شارژ کردیم', { accounts, now });
  assert.equal(recharge.amountInLedgerUnit, true);
  // ۵۰ میلیون سقف منهای ۱۲ میلیون مانده، هر دو ریال؛ ۳۸۰ میلیون ریال اشتباه بود.
  assert.equal(rial(recharge).amount, 38_000_000);
});

test('تسویه و پرداخت شریک: مبلغ کارت با ماندهٔ سندها در یک واحد سنجیده می‌شود', () => {
  assert.equal(rial(detectSettleIntent('طلب آقای رضایی ۵ میلیون وصول شد', { now })).amount, 50_000_000);
  assert.equal(rial(detectPartnerPaidDebt('بدهی شرکت پارس رو آقای محمدی شریکمون از جیب خودش ۸ میلیون داد', { now })).amount, 80_000_000);
});

const databasePath = tempDatabase('rial-ledger-boundaries');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'rial-owner';
process.env.ADMIN_PASSWORD = randomBytes(24).toString('base64url');
const database = await import(`../server/db.js?rial-ledger-boundaries=${process.pid}`);
database.ensureAdmin();
const owner = database.authenticateUser('rial-owner', process.env.ADMIN_PASSWORD);
const ledger = (name, unit) => {
  const workspace = database.createWorkspace(owner.id, { name, profileType: 'business' });
  database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, () => { if (unit === 'rial') database.setLedgerAmountUnit('rial'); });
  return (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
};
const rialLedger = ledger('ریالی', 'rial');
const tomanLedger = ledger('تومانی', 'toman');
test.after(() => removeTempDatabase(databasePath));

test('اصلاح گفتاری: «مبلغ درست ۳ میلیون بود» در دفتر ریالی ۳۰ میلیون ریال است، نه ۳ میلیون ریال', () => {
  const current = { id: 'row-1', amount: 20_000_000, type: 'expense', category: 'سوخت' };
  rialLedger(() => {
    assert.equal(previewCorrection('نه مبلغ درست ۳ میلیون بود', current).changes.amount, 30_000_000);
    // همان مبلغ به ریال: تغییری نیست.
    assert.equal(previewCorrection('نه مبلغ درست ۲ میلیون بود', current).canApply, false);
  });
  tomanLedger(() => assert.equal(previewCorrection('نه مبلغ درست ۳ میلیون بود', { ...current, amount: 2_000_000 }).changes.amount, 3_000_000));
});

test('رسید: دفتر ریالی عدد چاپ‌شدهٔ ریالی را دقیق می‌گیرد، رسید تومانی ده برابر؛ دفتر تومانی مثل قبل', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  let reply;
  globalThis.fetch = async () => new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(reply) }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const receipt = (fields) => ({
    occurredAt: '2026-10-19T12:30:00Z', merchant: 'فروشگاه نمونه', type: 'expense', paymentMethod: 'کارت', reference: '', category: 'مواد و کالا', confidence: 0.92,
    fieldConfidence: { amount: 0.97, occurredAt: 0.8, merchant: 0.9, type: 0.95, paymentMethod: 0.75 }, rawText: '', ...fields,
  });
  const read = () => extractReceiptData({ buffer: Buffer.from('image'), mimeType: 'image/jpeg', categories: [{ name: 'مواد و کالا' }] });
  try {
    reply = receipt({ amount: 850_001, sourceAmount: 8_500_005, currencySource: 'rial' });
    assert.equal((await rialLedger(read)).amount, 8_500_005);
    assert.equal((await tomanLedger(read)).amount, 850_001);
    reply = receipt({ amount: 850_000, sourceAmount: 850_000, currencySource: 'toman' });
    assert.equal((await rialLedger(read)).amount, 8_500_000);
    assert.equal((await tomanLedger(read)).amount, 850_000);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});

test('فایل افتتاحیه: فایل ریالی در دفتر ریالی بی‌تبدیل، فایل تومانی ده برابر؛ ریالِ ناصحیح در دفتر تومانی رد', () => {
  const rowsFor = () => {
    const chart = database.activeWorkspaceDatabase();
    const [cash] = chart.prepare("SELECT code FROM chart_accounts WHERE level='subsidiary' AND type='asset' AND active=1 ORDER BY code").all();
    const [capital] = chart.prepare("SELECT code FROM chart_accounts WHERE level='subsidiary' AND type='equity' AND active=1 ORDER BY code").all();
    return (amount) => [{ rowNumber: 2, code: cash.code, debit: amount, credit: 0 }, { rowNumber: 3, code: capital.code, debit: 0, credit: amount }];
  };
  rialLedger(() => {
    database.installChartTemplate();
    const rows = rowsFor();
    const exact = prepareOpeningBalanceRows(database.activeWorkspaceDatabase(), rows(567_905_027), { amountUnit: 'rial' });
    assert.equal(exact.debitTotal, 567_905_027);
    assert.equal(exact.ledgerUnit, 'rial');
    assert.equal(prepareOpeningBalanceRows(database.activeWorkspaceDatabase(), rows(56_790_502), { amountUnit: 'toman' }).debitTotal, 567_905_020);
  });
  tomanLedger(() => {
    database.installChartTemplate();
    const rows = rowsFor();
    assert.equal(prepareOpeningBalanceRows(database.activeWorkspaceDatabase(), rows(567_905_020), { amountUnit: 'rial' }).debitTotal, 56_790_502);
    assert.throws(() => prepareOpeningBalanceRows(database.activeWorkspaceDatabase(), rows(567_905_027), { amountUnit: 'rial' }),
      (error) => error.code === 'IMPORT_ROWS_INVALID' && /دفتر تومانی به عدد صحیح درنمی‌آید/.test(error.details.errors[0].message));
  });
});

test('صف حسابدار: مبلغ مرجع گفتهٔ چندمبلغی و تسویهٔ بی‌سند به واحد دفتر', () => {
  const sentence = 'کل خرید ۱۲ میلیون بود که ۸ میلیونش نقد و ۴ میلیونش چک دادیم';
  rialLedger(() => {
    const event = database.queueCompositeUtterance(sentence, { clientId: 'rial-composite' });
    assert.equal(event.amount ?? database.activeWorkspaceDatabase().prepare('SELECT amount FROM financial_events WHERE id=?').get(event.id).amount, 120_000_000);
  });
  tomanLedger(() => {
    const event = database.queueCompositeUtterance(sentence, { clientId: 'toman-composite' });
    assert.equal(event.amount ?? database.activeWorkspaceDatabase().prepare('SELECT amount FROM financial_events WHERE id=?').get(event.id).amount, 12_000_000);
  });
});
