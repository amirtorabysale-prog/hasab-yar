import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempDatabase, removeTempDatabase } from './helpers/tempPath.js';
import { readParsianDocuments } from '../server/parsianAccessFile.js';

const databasePath = tempDatabase('parsian-roundtrip');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'roundtrip-owner';
process.env.ADMIN_PASSWORD = 'Roundtrip-Long-Passphrase-8823';

const database = await import(`../server/db.js?roundtrip=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('roundtrip-owner', 'Roundtrip-Long-Passphrase-8823');
const workspace = database.createWorkspace(owner.id, { name: 'شرکت رفت‌وبرگشت', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

const TEMPLATE_PATH = 'parsian/parsian-document-export.mdb';
const hasTemplate = fs.existsSync(TEMPLATE_PATH);
const TARGET = 'parsian-review-csv';

/**
 * ثبت‌هایی که با هم همهٔ حالت‌های دردسرساز را می‌پوشانند: درآمد و هزینه،
 * مبلغ‌های نامساوی، و چند دسته که به معین‌های متفاوت می‌نشینند.
 */
// تاریخ عمداً «همین حالا» است: دورهٔ پیش‌فرض خروجی، ماه شمسی جاری است و
// تاریخ ثابت باعث می‌شد آزمون با گذشت زمان از آن دوره بیرون بیفتد.
const SOURCE = [
  { amount: 3_000_000, type: 'income', category: 'فروش', rawText: 'سه میلیون فروش نقدی' },
  { amount: 1_250_000, type: 'expense', category: 'اجاره', rawText: 'یک میلیون و دویست و پنجاه اجاره' },
  { amount: 415_000, type: 'expense', category: 'حمل و نقل', rawText: 'چهارصد و پانزده کرایه' },
];

let ready = false;

test('دفتر تا کامل نشدن نگاشت، فایل نمی‌سازد', () => {
  inWorkspace(() => {
    database.insertTransactions({ transcript: 'ثبت‌های دوره', transactions: SOURCE });
    database.installChartTemplate();
    database.applyChartSuggestions();
    assert.equal(database.accountingTransferOverview('', TARGET).readiness.ready, false,
      'بدون تأیید قالب و کد مقصد نباید آماده باشد');

    database.fillTransferMappingsFromChart(TARGET);
    // الگو باید همان فایلی باشد که دفتر از نصب خودش گرفته؛ فایل انتقال روی آن
    // نوشته می‌شود و ساختارش از همان می‌آید، نه از حدس ما.
    if (hasTemplate) {
      database.saveAccountingTransferTemplate(TARGET, fs.readFileSync(TEMPLATE_PATH), 'parsian-document-export.mdb');
    }
    database.saveAccountingTransferSettings({
      targetSystem: TARGET, templateName: 'قالب آزمایشی پارسیان', templateVerified: true,
    });
    const readiness = database.accountingTransferOverview('', TARGET).readiness;
    assert.equal(readiness.ready, true, JSON.stringify(readiness.checks.filter((item) => !item.passed)));
    ready = true;
  });
});

/**
 * قلب این فایل.
 *
 * فایل از همان مسیری ساخته می‌شود که خروجی واقعی از آن می‌آید، بعد از روی
 * بایت‌های خودِ فایل دوباره خوانده می‌شود — نه از روی دادهٔ حافظه. هر چیزی که
 * بین این دو گم شود، همان چیزی است که کاربر در پارسیان پیدا نمی‌کند.
 */
test('هر ردیف دفتر سالم در فایل می‌نشیند و سالم برمی‌گردد',
  { skip: hasTemplate ? false : 'الگوی واقعی پارسیان در دسترس نیست' }, () => {
    assert.ok(ready, 'آزمون قبلی باید دفتر را آماده کرده باشد');
    inWorkspace(() => {
      // مرجع مقایسه، خودِ سابقهٔ بسته است: همان عددی که مسیر تولید ثبت کرده و
      // حسابدار در رابط کاربری می‌بیند. اگر فایل با این نخواند، یعنی چیزی که
      // نشان داده‌ایم با چیزی که تحویل داده‌ایم یکی نیست.
      const batch = database.createAccountingTransferBatch({ targetSystem: TARGET, fileFormat: 'mdb' });
      assert.ok(batch.rowCount > 0);
      const buffer = database.accountingTransferBatchFile(batch.id).fileData;
      const back = readParsianDocuments(buffer);

      const unit = batch.amountUnit === 'rial' ? 10 : 1;
      const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);

      assert.equal(back.rows.length, batch.rowCount, 'تعداد ردیف باید دقیقاً برابر باشد');
      assert.equal(back.documents.length, batch.entryCount, 'تعداد سند باید دقیقاً برابر باشد');
      assert.equal(sum(back.rows, 'Bed'), batch.debitTotal * unit, 'جمع بدهکار نباید تغییر کند');
      assert.equal(sum(back.rows, 'Bes'), batch.creditTotal * unit, 'جمع بستانکار نباید تغییر کند');
      assert.equal(sum(back.rows, 'Bed'), sum(back.rows, 'Bes'), 'فایل باید متوازن باشد');

      // جمع کل می‌تواند دو خطای قرینه را پنهان کند؛ هر سند جداگانه هم کنترل می‌شود.
      for (const document of back.documents) {
        const debit = sum(document.lines, 'debit');
        const credit = sum(document.lines, 'credit');
        assert.equal(debit, credit, `سند ${document.number} متوازن نیست`);
      }

      // کد کل و معین باید عدد معتبر باشند، وگرنه ردیف در پارسیان جای اشتباه می‌نشیند.
      for (const row of back.rows) {
        assert.ok(Number.isInteger(row.KolCode) && row.KolCode > 0, 'کد کل باید عدد مثبت باشد');
        assert.ok(Number.isInteger(row.MoeenCode) && row.MoeenCode > 0, 'کد معین باید عدد مثبت باشد');
      }
    });
  });

// تاریخ شمسی در قالب پارسیان رشته است؛ یک تبدیل اشتباه، کل دوره را جابه‌جا
// می‌کند و سند بیرون از سال مالی مقصد می‌افتد.
test('تاریخ شمسی دست‌نخورده برمی‌گردد',
  { skip: hasTemplate ? false : 'الگوی واقعی پارسیان در دسترس نیست' }, () => {
    inWorkspace(() => {
      const batch = database.createAccountingTransferBatch({ targetSystem: TARGET, fileFormat: 'mdb' });
      const back = readParsianDocuments(database.accountingTransferBatchFile(batch.id).fileData);
      for (const document of back.documents) {
        assert.match(document.date, /^\d{4}\/\d{2}\/\d{2}$/, `تاریخ «${document.date}» قالب شمسی ندارد`);
        const [year] = document.date.split('/').map(Number);
        assert.ok(year >= 1400 && year <= 1500, `سال «${year}» شمسی نیست — احتمالاً میلادی مانده`);
      }
    });
  });

test.after(() => removeTempDatabase(databasePath));
