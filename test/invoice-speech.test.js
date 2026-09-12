import assert from 'node:assert/strict';
import test from 'node:test';
import { detectTaxMention, parseInvoiceLines, wantsImmediateIssue } from '../shared/invoiceSpeech.js';
import { detectVoiceIntent, invoiceDraftPayload, invoiceLinesTotal } from '../shared/voiceIntent.js';

test('یک ردیف با تعداد و نرخ واحد', () => {
  const lines = parseInvoiceLines('فاکتور فروش برای آقای احمدی ده عدد چای هرکدام پنجاه هزار تومان');
  assert.deepEqual(lines, [{ title: 'چای', quantity: 10, unitPrice: 50_000, fromUnitPrice: true }]);
});

test('چند ردیف در یک جمله از هم جدا می‌شوند', () => {
  const lines = parseInvoiceLines('فاکتور فروش دو عدد میز هرکدام یک میلیون و سه عدد صندلی هرکدام پانصد هزار تومان');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { title: 'میز', quantity: 2, unitPrice: 1_000_000, fromUnitPrice: true });
  assert.deepEqual(lines[1], { title: 'صندلی', quantity: 3, unitPrice: 500_000, fromUnitPrice: true });
});

test('شکل‌های گفتاری نشانهٔ نرخ واحد', () => {
  const forms = [
    'سه تا لپ تاپ دونه ای دوازده میلیون',
    'سه تا لپ تاپ دانه ای دوازده میلیون',
    'سه تا لپ تاپ هر عدد دوازده میلیون',
  ];
  for (const sentence of forms) {
    const [line] = parseInvoiceLines(sentence);
    assert.equal(line.quantity, 3, sentence);
    assert.equal(line.unitPrice, 12_000_000, sentence);
    assert.equal(line.title, 'لپ تاپ', sentence);
  }
});

test('عدد با رقم و واژهٔ شمارشی هم کار می‌کند', () => {
  const [line] = parseInvoiceLines('فاکتور خرید ۱۲ کیلو برنج هرکدام ۹۰ هزار تومان');
  assert.equal(line.quantity, 12);
  assert.equal(line.unitPrice, 90_000);
  assert.equal(line.title, 'برنج');
});

// ریال باید مثل بقیهٔ مسیر مبلغ به تومان تبدیل شود، وگرنه ردیف ده برابر می‌شود.
test('نرخ به ریال به تومان تبدیل می‌شود', () => {
  const [line] = parseInvoiceLines('دو عدد کارتن هرکدام پانصد هزار ریال');
  assert.equal(line.unitPrice, 50_000);
});

// بدون نشانهٔ صریح، تقسیم مبلغ بر تعداد عددی می‌سازد که کاربر نگفته است.
test('بدون نشانهٔ نرخ واحد، هیچ ردیفی حدس زده نمی‌شود', () => {
  assert.deepEqual(parseInvoiceLines('فاکتور فروش برای آقای احمدی سه میلیون'), []);
  assert.deepEqual(parseInvoiceLines('فاکتور فروش ده عدد چای پنجاه هزار تومان'), []);
  assert.deepEqual(parseInvoiceLines(''), []);
});

test('نام کالا از عنوان و واژه‌های دستوری پاک می‌شود', () => {
  const [line] = parseInvoiceLines('فاکتور فروش برای شرکت پارس پنج عدد مانیتور ال جی هرکدام دو میلیون تومان');
  assert.equal(line.title, 'مانیتور ال جی');
  assert.equal(line.quantity, 5);
});

test('ردیف بدون نام یا بدون نرخ ساخته نمی‌شود', () => {
  assert.deepEqual(parseInvoiceLines('ده عدد هرکدام پنجاه هزار تومان'), []);
  assert.deepEqual(parseInvoiceLines('ده عدد چای هرکدام'), []);
});

test('نرخ مالیات گفته‌شده تشخیص داده می‌شود', () => {
  assert.deepEqual(detectTaxMention('با ۹ درصد ارزش افزوده'), { wanted: true, ratePercent: 9, explicit: true });
  assert.deepEqual(detectTaxMention('با ارزش افزوده'), { wanted: true, ratePercent: null, explicit: true });
  assert.deepEqual(detectTaxMention('بدون مالیات'), { wanted: false, ratePercent: null, explicit: true });
  assert.deepEqual(detectTaxMention('فاکتور فروش سه میلیون'), { wanted: false, ratePercent: null, explicit: false });
});

test('درخواست صدور از پیش‌نویس‌ماندن جدا می‌شود', () => {
  assert.equal(wantsImmediateIssue('فاکتور فروش سه میلیون صادرش کن'), true);
  assert.equal(wantsImmediateIssue('فاکتور رسمی برای آقای احمدی'), true);
  assert.equal(wantsImmediateIssue('فاکتور فروش سه میلیون'), false);
});

// payload از نیت تا سند: این همان چیزی است که واقعاً به سرور می‌رود.
test('ردیف‌های گفته‌شده به payload فاکتور می‌رسند', () => {
  const intent = detectVoiceIntent('فاکتور فروش برای آقای احمدی ده عدد چای هرکدام پنجاه هزار تومان');
  assert.equal(intent.intent, 'invoice');
  assert.equal(intent.documentType, 'sales');
  const payload = invoiceDraftPayload(intent);
  assert.equal(payload.items.length, 1);
  assert.deepEqual(payload.items[0], { title: 'چای', quantity: 10, unitPrice: 50_000 });
  assert.equal(payload.issueNow, false);
  assert.equal(invoiceLinesTotal(intent), 500_000);
});

test('بدون نرخ واحد، همان ردیف تک‌خطی به کل مبلغ ساخته می‌شود', () => {
  const intent = detectVoiceIntent('فاکتور فروش برای آقای احمدی سه میلیون');
  const payload = invoiceDraftPayload(intent);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].quantity, 1);
  assert.equal(payload.items[0].unitPrice, 3_000_000);
  assert.equal(invoiceLinesTotal(intent), 3_000_000);
});

test('نرخ مالیات انتخاب‌شده روی همهٔ ردیف‌ها می‌نشیند', () => {
  const intent = detectVoiceIntent('فاکتور فروش دو عدد میز هرکدام یک میلیون و سه عدد صندلی هرکدام پانصد هزار با ۱۰ درصد ارزش افزوده');
  const payload = invoiceDraftPayload(intent, { taxRateId: 'vat-10' });
  assert.equal(payload.items.length, 2);
  assert.ok(payload.items.every((item) => item.taxRateId === 'vat-10'));
  assert.equal(intent.tax.ratePercent, 10);
});

// صدور باید آگاهانه باشد؛ سند صادرشده در دفتر کل می‌نشیند و برگشتش سند می‌خواهد.
test('صدور فقط با درخواست صریح انجام می‌شود', () => {
  const asked = detectVoiceIntent('فاکتور فروش برای آقای احمدی سه میلیون صادرش کن');
  assert.equal(asked.issueNow, true);
  assert.equal(invoiceDraftPayload(asked).issueNow, true);

  const quiet = detectVoiceIntent('فاکتور فروش برای آقای احمدی سه میلیون');
  assert.equal(quiet.issueNow, false);
  assert.equal(invoiceDraftPayload(quiet).issueNow, false);
});

test('تاریخ گفته‌شده فقط روی سند صادرشده می‌نشیند', () => {
  const issued = detectVoiceIntent('فاکتور فروش دیروز سه میلیون صادرش کن');
  const payload = invoiceDraftPayload(issued);
  assert.ok(payload.issuedAt, 'سند صادرشده باید تاریخ بگیرد');

  // پیش‌نویس تاریخ نمی‌گیرد؛ تاریخ فاکتور هنگام صدور تعیین می‌شود.
  const draft = detectVoiceIntent('فاکتور فروش دیروز سه میلیون');
  assert.equal(invoiceDraftPayload(draft).issuedAt, undefined);
});

test('ردیف بی‌مبلغ یا بی‌نام وارد payload نمی‌شود', () => {
  const payload = invoiceDraftPayload({ documentType: 'sales', amount: 1_000, lines: [{ title: '', unitPrice: 500 }, { title: 'چای', unitPrice: 0 }] });
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].unitPrice, 1_000, 'وقتی هیچ ردیف معتبری نماند، مبلغ کل ردیف می‌شود');
});
