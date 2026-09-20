import test from 'node:test';
import assert from 'node:assert/strict';
import { removeTempDatabase, tempDatabase } from './helpers/tempPath.js';

/**
 * کارت حساب طرف حساب باید با دفتر کل بخواند، نه با جمعِ جدول‌ها.
 *
 * همان رویداد در چند جدول رد دارد: فاکتور فروش، تسویه‌اش و چکی که بابتش
 * گرفته شده، سه ردیف در سه جدول‌اند ولی یک گردش حساب. کارتی که جدول‌ها را
 * جمع بزند، همان مبلغ را دو بار نشان می‌دهد — و کاربری که به کارت حساب نگاه
 * می‌کند دقیقاً دنبال عددی است که بتواند به آن اتکا کند.
 */

const databasePath = tempDatabase('counterparty-card');
process.env.DATABASE_PATH = databasePath;

const db = await import(`../server/db.js?counterparty-card=${process.pid}`);
const { counterpartyCard, createInvoice, issueInvoice, recordInvoicePayment, saveContact, saveObligation } = db;

test.after(() => removeTempDatabase(databasePath));

test('کارت، فاکتور را بدهکار و تسویه‌اش را بستانکار نشان می‌دهد', () => {
  const contact = saveContact({ name: 'شرکت آراد گستره', kind: 'customer' });
  const invoice = createInvoice({
    contactId: contact.id, customerName: contact.name, documentType: 'sales',
    items: [{ title: 'خدمات مشاوره', quantity: 1, unitPrice: 5_000_000 }],
  });
  issueInvoice(invoice.id, { issuedAt: '2026-03-01T09:00:00.000Z' });
  recordInvoicePayment(invoice.id, { amount: 2_000_000, occurredAt: '2026-03-10T09:00:00.000Z' });

  const card = counterpartyCard(contact.id);

  assert.equal(card.contact.name, 'شرکت آراد گستره');
  assert.ok(card.lines.length >= 2, 'هم صدور و هم تسویه باید در کارت باشند');
  // فاکتور فروش، طرف حساب را بدهکار می‌کند؛ تسویه‌اش بستانکار.
  assert.equal(card.totals.debit, 5_000_000);
  assert.equal(card.totals.credit, 2_000_000);
  // ماندهٔ پایانی همان چیزی است که هنوز از او طلب داریم.
  assert.equal(card.totals.balance, 3_000_000);
});

test('مانده تجمعی است، نه مبلغ تک‌تک ردیف‌ها', () => {
  // اگر مانده ردیف‌به‌ردیف حساب نشود، کارت فقط یک فهرست است؛ چیزی که کاربر
  // از کارت حساب می‌خواهد همین ستون آخر است.
  const contact = saveContact({ name: 'فروشگاه پارس‌نگار', kind: 'customer' });
  for (const [amount, day] of [[1_000_000, '05'], [2_000_000, '10'], [3_000_000, '15']]) {
    const invoice = createInvoice({
      contactId: contact.id, customerName: contact.name, documentType: 'sales',
      items: [{ title: 'فروش', quantity: 1, unitPrice: amount }],
    });
    issueInvoice(invoice.id, { issuedAt: `2026-04-${day}T09:00:00.000Z` });
  }

  const card = counterpartyCard(contact.id);
  const balances = card.lines.map((line) => line.balance);

  assert.deepEqual(balances, [1_000_000, 3_000_000, 6_000_000]);
  assert.equal(card.totals.balance, 6_000_000);
});

test('بازه، مانده پیش از خودش را افتتاحیه می‌گیرد', () => {
  // بدون افتتاحیه، کارتِ یک ماه مانده را از صفر شروع می‌کند و عدد پایانی‌اش
  // با دفتر نمی‌خواند — همان جایی که کاربر اعتمادش را از دست می‌دهد.
  const contact = saveContact({ name: 'بازرگانی کاوه', kind: 'customer' });
  for (const [amount, month] of [[4_000_000, '05'], [1_000_000, '06']]) {
    const invoice = createInvoice({
      contactId: contact.id, customerName: contact.name, documentType: 'sales',
      items: [{ title: 'فروش', quantity: 1, unitPrice: amount }],
    });
    issueInvoice(invoice.id, { issuedAt: `2026-${month}-10T09:00:00.000Z` });
  }

  const card = counterpartyCard(contact.id, { from: '2026-06-01' });

  assert.equal(card.opening, 4_000_000, 'گردش ماه قبل باید افتتاحیه شود');
  assert.equal(card.lines.length, 1, 'فقط ردیف داخل بازه');
  assert.equal(card.totals.balance, 5_000_000, 'مانده از افتتاحیه ادامه پیدا می‌کند');
});

test('طرف حسابِ بدون گردش، کارت خالی می‌گیرد نه خطا', () => {
  const contact = saveContact({ name: 'مشتری تازه', kind: 'customer' });
  const card = counterpartyCard(contact.id);
  assert.deepEqual(card.lines, []);
  assert.equal(card.totals.balance, 0);
  assert.equal(card.contact.name, 'مشتری تازه');
});

test('شناسهٔ ناشناخته خطای روشن می‌دهد', () => {
  assert.throws(() => counterpartyCard('این-شناسه-وجود-ندارد'), /پیدا نشد/);
});

test('کارت هرگز بی‌صدا «تسویه» نمی‌گوید وقتی سند باز هست', () => {
  // باگی که کاربر پیدا کرد: فهرست طرف حساب‌ها ۲۵٬۶۸۰٬۰۰۰ بستانکار نشان
  // می‌داد و کارت همان شخص «تسویه». دو عدد متناقض یعنی کاربر به هیچ‌کدام
  // اعتماد نمی‌کند — و عددِ غلطِ مطمئن از عددِ نبودن هم بدتر است.
  //
  // علتش این است که فهرست از جدول تعهد و فاکتور می‌خواند و کارت از دفتر کل.
  // سندی که طرف حسابش موقع ثبت وصل نبوده، در دفتر کل حسابی به نام خودش
  // می‌سازد که به این شخص نمی‌چسبد.
  const contact = saveContact({ name: 'محسن اعتصامی', kind: 'person' });
  saveObligation({
    contactId: contact.id, title: 'بدهی', amount: 25_680_000,
    direction: 'payable', occurredAt: '2026-05-01T09:00:00.000Z',
  });
  // همان چیزی که در دادهٔ واقعی افتاده: حساب دفتر کل به این شخص نمی‌چسبد.
  db.db.prepare("UPDATE ledger_accounts SET source_key='کلید جامانده' WHERE source_kind='vendor-payable'").run();

  const card = counterpartyCard(contact.id);

  assert.equal(card.lines.length, 0, 'دفتر کل چیزی برای این شخص ندارد');
  assert.equal(card.reconciliation.documents, -25_680_000, 'ولی سند باز هست');
  assert.equal(card.reconciliation.unexplained, -25_680_000, 'و کارت باید اختلاف را بداند');
  assert.equal(card.reconciliation.openCount, 1);
});

test('کارتِ کامل اختلافی گزارش نمی‌کند', () => {
  // مرز مقابل: اگر هر سندی اختلاف نشان بدهد، هشدار بی‌معنا می‌شود و کاربر
  // یاد می‌گیرد نادیده‌اش بگیرد.
  const contact = saveContact({ name: 'طرف حساب سالم', kind: 'customer' });
  saveObligation({
    contactId: contact.id, title: 'طلب', amount: 4_000_000,
    direction: 'receivable', occurredAt: '2026-05-01T09:00:00.000Z',
  });

  const card = counterpartyCard(contact.id);

  assert.ok(card.lines.length > 0);
  assert.equal(card.reconciliation.unexplained, 0, 'وقتی همه‌چیز سر جایش است، اختلافی نیست');
});

test('طرف حسابی که در جمله گفته شده، به ثبت وصل می‌شود', () => {
  // «۹۳ میلیون تومان به شرکت آراد گستر آسیا پرداخت شد» یک هزینهٔ ساده ثبت
  // می‌شد و هیچ‌وقت به کارت آن شرکت نمی‌رسید — با اینکه نامش صریح در جمله
  // بود. کاربر باید دستی وصلش می‌کرد، یا اصلاً نمی‌فهمید که نشده.
  const before = db.listContacts().length;
  db.insertTransactions({
    transcript: 'پرداخت',
    transactions: [{ amount: 93_000_000, type: 'expense', category: 'سایر هزینه‌ها',
      rawText: '۹۳ میلیون تومان به شرکت آراد گستر آسیا پرداخت شد' }],
  });
  const created = db.listContacts().find((item) => item.name === 'شرکت آراد گستر آسیا');
  assert.ok(created, 'نام باید کامل و بدون فعل جمله باشد');

  const card = counterpartyCard(created.id);
  assert.equal(card.lines.length, 1, 'پرداخت باید در کارتش دیده شود');
  assert.equal(card.totals.balance, 93_000_000);
  assert.equal(db.listContacts().length, before + 1);
});

test('جمله‌ای بدون عنوان صریح، طرف حساب نمی‌سازد', () => {
  // مرز مقابل و مهم‌تر: اگر هر اسمی طرف حساب شود، فهرست از نام‌های بی‌ربط پر
  // می‌شود و خودِ قابلیت بی‌ارزش می‌شود.
  const before = db.listContacts().length;
  db.insertTransactions({
    transcript: 'پیک',
    transactions: [{ amount: 500_000, type: 'expense', category: 'حمل‌ونقل', rawText: 'پانصد هزار تومان به پیک دادم' }],
  });
  assert.equal(db.listContacts().length, before, 'هیچ طرف حسابی نباید ساخته شود');
});

test('پرداخت نقدی هم در کارت می‌آید، با اینکه حساب طرف را لمس نمی‌کند', () => {
  // در حسابداری دوطرفه پرداخت نقدی «بدهکار هزینه، بستانکار صندوق» است و به
  // حساب خودِ طرف نمی‌خورد. کارتی که فقط دفتر کل را بخواند این را نشان
  // نمی‌دهد — ولی چیزی که از کارت حساب انتظار می‌رود همهٔ داد و ستد با آن
  // شخص است، نه فقط گردش حسابداری‌اش.
  const contact = saveContact({ name: 'شرکت پخش نمونه', kind: 'vendor' });
  db.insertTransactions({
    transcript: 'x',
    transactions: [{ amount: 4_000_000, type: 'expense', category: 'مواد و کالا', contactId: contact.id, rawText: 'خرید مواد' }],
  });
  const card = counterpartyCard(contact.id);
  assert.equal(card.lines.length, 1);
  assert.equal(card.totals.debit, 4_000_000, 'پولی که به او دادیم بدهکارش می‌کند');
});
