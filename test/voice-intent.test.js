import assert from 'node:assert/strict';
import test from 'node:test';
import { capitalEntryPayload, detectVoiceIntent, extractContactName, invoiceDraftPayload } from '../shared/voiceIntent.js';
import { persianToISO } from '../shared/persianDate.js';

const TZ = 'Asia/Tehran';
const NOW = new Date(persianToISO(1405, 6, 6, TZ));
const persianDay = (iso) => {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}/${part('month')}/${part('day')}`;
};
const detect = (text) => detectVoiceIntent(text, { now: NOW });

test('طلب و بدهی جهت مخالف می‌گیرند', () => {
  const owed = detect('آقای احمدی سه میلیون بدهکاره');
  assert.equal(owed.intent, 'obligation');
  assert.equal(owed.direction, 'receivable');
  assert.equal(owed.amount, 3_000_000);
  assert.equal(owed.contactName, 'احمدی');

  const owing = detect('به شرکت پارس دو میلیون بدهکارم');
  assert.equal(owing.direction, 'payable');
  assert.equal(owing.amount, 2_000_000);
});

// جمله‌ای که هر دو نشانه دارد اجرا نمی‌شود؛ ثبت جهت غلط بدتر از نپرسیدن است.
test('جملهٔ مبهم جهت نمی‌گیرد و پرچم می‌خورد', () => {
  const found = detect('آقای رضایی بدهکاره ولی من هم بهش بدهکارم پنج میلیون');
  assert.equal(found.ambiguous, true);
  assert.equal(found.direction, null);
});

test('چک با سررسید آینده ثبت می‌شود، نه سال گذشته', () => {
  const cheque = detect('چک پنج میلیون دادم سررسید دهم مهر');
  assert.equal(cheque.intent, 'cheque');
  assert.equal(cheque.direction, 'payable');
  assert.equal(cheque.amount, 5_000_000);
  assert.equal(persianDay(cheque.dueAt), '1405/07/10');
});

test('چک دریافتی طلب است، نه بدهی', () => {
  const cheque = detect('چک ده میلیون از آقای احمدی گرفتم');
  assert.equal(cheque.direction, 'receivable');
  assert.equal(cheque.amount, 10_000_000);
});

test('فاکتور فروش و خرید از هم جدا می‌شوند', () => {
  const sales = detect('فاکتور فروش برای آقای احمدی سه میلیون');
  assert.equal(sales.intent, 'invoice');
  assert.equal(sales.documentType, 'sales');
  assert.equal(sales.amount, 3_000_000);
  assert.equal(sales.contactName, 'احمدی');

  const purchase = detect('فاکتور خرید از شرکت پارس دوازده میلیون');
  assert.equal(purchase.documentType, 'purchase');
  assert.equal(purchase.amount, 12_000_000);
});

// ثبت عادی نباید به نیت دیگری ربوده شود.
test('ثبت معمولی هیچ نیت خاصی نمی‌سازد', () => {
  assert.equal(detect('دو میلیون بابت تبلیغات دادم'), null);
  assert.equal(detect('دیروز ده میلیون فروختم'), null);
  assert.equal(detect(''), null);
});

test('بدون مبلغ، نیتی اجرا نمی‌شود', () => {
  assert.equal(detect('آقای احمدی بدهکاره'), null);
  assert.equal(detect('فاکتور فروش برای آقای احمدی'), null);
});

test('نام طرف حساب از عنوان بیرون کشیده می‌شود', () => {
  assert.equal(extractContactName('آقای احمدی سه میلیون بدهکاره'), 'احمدی');
  assert.equal(extractContactName('خانم موسوی نژاد دو میلیون'), 'موسوی نژاد');
  assert.equal(extractContactName('شرکت پارس خودرو ده میلیون'), 'شرکت پارس خودرو');
  // بدون عنوان، حدس‌زدن نام خطای بیشتری می‌سازد تا فایده.
  assert.equal(extractContactName('دو میلیون بدهکاره'), '');
});

test('پیش‌نویس فاکتور یک ردیف به کل مبلغ می‌سازد و صادر نمی‌شود', () => {
  const payload = invoiceDraftPayload(detect('فاکتور فروش برای آقای احمدی سه میلیون'));
  assert.equal(payload.documentType, 'sales');
  assert.equal(payload.customerName, 'احمدی');
  assert.equal(payload.issueNow, false);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].quantity, 1);
  assert.equal(payload.items[0].unitPrice, 3_000_000);
  // نرخ مالیات از گفتار درنمی‌آید و ساختگی هم نمی‌شود؛ خالی می‌ماند تا در فرم انتخاب شود.
  assert.equal(payload.items[0].taxRateId, undefined);

  const purchase = invoiceDraftPayload(detect('فاکتور خرید از شرکت پارس دوازده میلیون'));
  assert.equal(purchase.documentType, 'purchase');
  assert.equal(purchase.items[0].unitPrice, 12_000_000);
});

test('بدون مبلغ پیش‌نویس فاکتور ساخته نمی‌شود', () => {
  assert.equal(invoiceDraftPayload({ documentType: 'sales', amount: 0 }), null);
  assert.equal(invoiceDraftPayload({}), null);
});

test('آورده و افزایش سرمایه از ثبت عادی جدا می‌شود', () => {
  const capital = detect('پنجاه میلیون سرمایه گذاشتم');
  assert.equal(capital.intent, 'capital');
  assert.equal(capital.amount, 50_000_000);
  assert.equal(detect('افزایش سرمایه صد میلیون').intent, 'capital');
});

test('دارایی ثابت فقط با نشانهٔ صریح تشخیص داده می‌شود', () => {
  const asset = detect('لپ‌تاپ به عنوان دارایی ثابت سی میلیون خریدم');
  assert.equal(asset.intent, 'fixed-asset');
  assert.equal(asset.amount, 30_000_000);
  assert.equal(asset.title, 'لپ تاپ');
  assert.equal(detect('دارایی ثابت کولر گازی بیست میلیون').title, 'کولر گازی');
  // بدون نشانهٔ صریح حدس زده نمی‌شود؛ همان لپ‌تاپ می‌تواند کالای فروش باشد.
  assert.equal(detect('لپ‌تاپ سی میلیون خریدم'), null);
});

// واژهٔ شمارش برای پارسر هم یک عدد است؛ اولین عدد، مبلغ را ۱ می‌کرد.
test('عدد شمارش با مبلغ اشتباه گرفته نمی‌شود', () => {
  const asset = detect('یک دستگاه پراید به عنوان دارایی ثابت چهارصد میلیون خریدم');
  assert.equal(asset.amount, 400_000_000);
  assert.equal(asset.title, 'دستگاه پراید');
});

test('ورودی ثبت سرمایه بدون عنوان ساخته نمی‌شود', () => {
  const asset = detect('دارایی ثابت هشتاد میلیون خریدم');
  assert.equal(asset.title, '');
  assert.equal(capitalEntryPayload(asset), null);
  assert.equal(capitalEntryPayload({ ...asset, title: 'میز اداری' }).kind, 'fixed-asset');
  assert.equal(capitalEntryPayload(detect('پنجاه میلیون سرمایه گذاشتم')).kind, 'capital-in');
});

// روی صفحهٔ طلب و بدهی، موضوع از قبل روشن است: نام بدون عنوان پذیرفته می‌شود و
// جملهٔ بدون مبلغ رد نمی‌شود.
const inObligations = (text) => detectVoiceIntent(text, { now: NOW, context: 'obligation' });

test('روی صفحهٔ طلب و بدهی، نام بدون عنوان هم فهمیده می‌شود', () => {
  const owed = inObligations('حسن سه میلیون بدهکار شد');
  assert.equal(owed.direction, 'receivable');
  assert.equal(owed.amount, 3_000_000);
  assert.equal(owed.contactName, 'حسن');

  assert.equal(inObligations('از رضا دو میلیون طلب دارم').contactName, 'رضا');
  assert.equal(inObligations('بدهکار شد حسن').contactName, 'حسن');
  assert.equal(inObligations('به شرکت پارس بدهکارم').contactName, 'شرکت پارس');
  // مسیر عمومی همچنان محافظه‌کار است؛ آنجا حدس نام خطای بیشتری می‌سازد تا فایده.
  assert.equal(detect('حسن سه میلیون بدهکار شد').contactName, '');
});

// «بدهکار شد» و «بدهکار شدم» جهت مخالف دارند؛ اشتباه‌گرفتنشان طلب را بدهی ثبت می‌کند.
test('صیغهٔ فعل، جهت را عوض می‌کند', () => {
  assert.equal(inObligations('حسن بدهکار شد دو میلیون').direction, 'receivable');
  assert.equal(inObligations('بدهکار شدم دو میلیون').direction, 'payable');
  assert.equal(inObligations('به حسن یک میلیون قرض دادم').direction, 'receivable');
  assert.equal(inObligations('از مغازه یک میلیون قرض گرفتم').direction, 'payable');
  // فعل اول‌شخص نباید نام شمرده شود.
  assert.equal(inObligations('بدهکار شدم دو میلیون').contactName, '');
});

test('جملهٔ بدون مبلغ روی این صفحه رد نمی‌شود، ناقص علامت می‌خورد', () => {
  const partial = inObligations('حسن بدهکار شد');
  assert.equal(partial.intent, 'obligation');
  assert.equal(partial.direction, 'receivable');
  assert.equal(partial.contactName, 'حسن');
  assert.equal(partial.amount, 0);
  assert.equal(partial.needsAmount, true);
  // همان جمله در مسیر عمومی هیچ نیتی نمی‌سازد.
  assert.equal(detect('حسن بدهکار شد'), null);
});

test('جملهٔ بی‌ربط روی صفحهٔ طلب و بدهی هم نیت نمی‌سازد', () => {
  assert.equal(inObligations('قبض برق دادم'), null);
  assert.equal(inObligations('دیروز ده میلیون فروختم'), null);
});

// سررسید در گفتار طلب و بدهی تقریباً همیشه نسبی و رو به آینده است.
test('سررسید نسبی روی صفحهٔ طلب و بدهی فهمیده می‌شود', () => {
  const persianDay = (iso) => {
    const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part('year')}/${part('month')}/${part('day')}`;
  };
  // NOW برابر ۶ شهریور ۱۴۰۵ است.
  assert.equal(persianDay(inObligations('حسن سه میلیون بدهکار شد سه روز دیگه').dueAt), '1405/06/09');
  assert.equal(persianDay(inObligations('رضا دو میلیون بدهکار شد هفته بعد').dueAt), '1405/06/13');
  assert.equal(persianDay(inObligations('حسن یک میلیون بدهکار شد آخر ماه').dueAt), '1405/06/31');
  assert.equal(persianDay(inObligations('حسن دو میلیون بدهکار شد سررسید بیستم مهر').dueAt), '1405/07/20');

  // سررسید آینده نباید به سال گذشته پرت شود.
  assert.equal(persianDay(inObligations('حسن سه میلیون بدهکار شد سررسید دهم مهر').dueAt), '1405/07/10');
});

// جملهٔ واقعی کاربر در production. سه ایراد هم‌زمان داشت و بدترینش مبلغ بود:
// «۱۵ ۵ ۱۴۰۵ ۱۳» همه در یک عدد جمع می‌شدند و سند با ۱٬۴۳۸٬۰۰۰٬۰۰۰ ثبت می‌شد،
// یعنی صد برابر، بی‌صدا.
test('رقم‌های تاریخ وارد مبلغ نمی‌شوند', () => {
  const found = detect('در تاریخ 15 5 1405 13 میلیون تومان به شرکت آزاد بدهکار شدیم');
  assert.equal(found.amount, 13_000_000);
  assert.equal(found.direction, 'payable');
  assert.equal(found.contactName, 'شرکت آزاد', 'واژهٔ جهت نباید بخشی از نام شود');
  // «در تاریخ» تاریخ رویداد را معرفی می‌کند، نه سررسید.
  assert.equal(persianDay(found.occurredAt), '1405/05/15');
  assert.equal(found.dueAt, null);
});

test('تاریخ عددی با فاصله هم فهمیده می‌شود', () => {
  const spaced = detect('۱۵ ۵ ۱۴۰۵ ده میلیون به آقای احمدی بدهکارم');
  assert.equal(spaced.amount, 10_000_000);
  // تاریخ گذشته، تاریخ رویداد است نه سررسید.
  assert.equal(persianDay(spaced.occurredAt), '1405/05/15');

  const slashed = detect('1405/07/10 ده میلیون به آقای احمدی بدهکارم');
  assert.equal(slashed.amount, 10_000_000);
  // ۱۰ مهر از ۶ شهریور جلوتر است، پس سررسید.
  assert.equal(persianDay(slashed.dueAt), '1405/07/10');
});

test('عدد سه‌تایی بدون بخش چهاررقمی تاریخ شمرده نمی‌شود', () => {
  // «۱۲ ۵ ۳» می‌تواند هر چیزی باشد؛ تاریخ‌خواندنش یعنی مبلغ از بین می‌رود.
  const found = detect('دوازده میلیون به آقای احمدی بدهکارم');
  assert.equal(found.amount, 12_000_000);
  assert.equal(found.dueAt, null);
});

// «در تاریخ X بدهکار شدیم» تاریخِ رویداد است، نه سررسید. یکی‌کردنشان یعنی
// سندی که همین امروز بدهکار شده، سررسیدش در گذشته دیده می‌شود و در فهرست
// عقب‌افتاده‌ها می‌نشیند — گزارشی که کاملاً غلط است.
test('تاریخ بدهکارشدن با سررسید یکی نمی‌شود', () => {
  const found = detect('در تاریخ 15 5 1405 15 میلیون تومان به شرکت آراد گستره آسیا بدهکار شدیم');
  assert.equal(found.amount, 15_000_000);
  assert.equal(persianDay(found.occurredAt), '1405/05/15');
  assert.equal(found.dueAt, null, 'بدون واژهٔ سررسید، تاریخ رویداد است نه سررسید');
  assert.equal(found.contactName, 'شرکت آراد گستره آسیا', 'نام شرکت نباید نصفه شود');
});

test('هر دو تاریخ در یک جمله از هم جدا می‌شوند', () => {
  const found = detect('در تاریخ 15 5 1405 به شرکت آراد بدهکار شدیم 10 میلیون سررسید دهم مهر');
  assert.equal(persianDay(found.occurredAt), '1405/05/15');
  assert.equal(persianDay(found.dueAt), '1405/07/10');
});

// چک اصلاً دربارهٔ سررسید است، پس تاریخِ تنها در جملهٔ چک سررسید است.
test('در جملهٔ چک، تاریخ تنها سررسید است', () => {
  const cheque = detect('چک پنج میلیون دادم دهم مهر');
  assert.equal(persianDay(cheque.dueAt), '1405/07/10');
  assert.equal(cheque.occurredAt, null);
});

test('در طلب و بدهی عادی، تاریخ تنها رویداد است نه سررسید', () => {
  const found = detect('آقای احمدی سه میلیون بدهکار شد دوم شهریور');
  assert.equal(persianDay(found.occurredAt), '1405/06/02');
  assert.equal(found.dueAt, null);
});

test('نام شرکت چندبخشی کامل برداشته می‌شود', () => {
  assert.equal(extractContactName('به شرکت آراد گستره آسیا بدهکار شدیم'), 'شرکت آراد گستره آسیا');
  assert.equal(extractContactName('آقای محمد رضا موسوی نژاد بدهکار شد'), 'محمد رضا موسوی نژاد');
});
