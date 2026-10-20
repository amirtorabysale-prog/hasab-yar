import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tempDatabase } from './helpers/tempPath.js';

/**
 * صف حسابدار هم به یادگیری می‌رود (خواستهٔ مالک محصول، ۲۹ مهر ۱۴۰۵): «مواردی که حسابدار تأیید
 * می‌کند باید توی یادگیری برود و سیستم خودش را با آن به‌روز کند.»
 *
 * خانواده: سه راهِ تأیید در صف (پیشنهادِ AI، نقشهٔ قطعی، سطرهای دستی) → همان مقایسه با پارسر.
 * تأییدِ حسابدار قطعی است و منتظرِ آستانه نمی‌ماند؛ ولی همان مرزها: فقط دسته، هرگز جهت؛ یادگیریِ
 * خودِ کاربر بازنویسی نمی‌شود؛ بی‌موضوع یاد گرفته نمی‌شود؛ اختلاف ساختاری فقط برای بازبینی.
 */

process.env.DATABASE_PATH = tempDatabase('accountant-lessons');
process.env.ADMIN_USERNAME = 'accountant-lessons-owner';
process.env.ADMIN_PASSWORD = 'Harbor-Quarry-Lantern-8843';
const database = await import('../server/db.js');
const { parseFinancialText } = await import('../shared/parser.js');
database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);

const REPAIR = 'تعمیر و نگهداری';
const SWITCH = 'یه کلید برق ۴۵۰ هزار تومانی برای تابلوی برق دفتر خریدیم؛ نقد از صندوق.';
let books = 0;
const inBook = (callback) => {
  const workspace = database.createWorkspace(owner.id, { name: `دفتر یادگیری حسابدار ${++books}`, profileType: 'business' });
  return database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, () => { database.installChartTemplate(); return callback(); });
};
const repairLines = (amount = 450_000) => [{ role: 'expense-category', key: REPAIR, debit: amount, credit: 0 }, { role: 'cash', key: 'cash', debit: 0, credit: amount }];
const lessons = (kind) => database.listAiLessons().lessons.filter((lesson) => !kind || lesson.kind === kind);

test('سندِ قطعیِ حسابدار به شکلِ جزءِ قابل‌مقایسه: نقد، تعهد، پولِ شریک؛ بی‌دسته کنار می‌ماند', () => {
  inBook(() => {
    assert.deepEqual(database.componentFromLines(repairLines(), { topicLabel: 'کلید برق' }), { id: 'accountant', kind: 'cash', amount: 450_000, item: { amount: 450_000, type: 'expense', category: REPAIR, topicLabel: 'کلید برق' } });
    assert.equal(database.componentFromLines([{ role: 'expense-category', key: 'قبوض', debit: 4_000_000 }, { role: 'payable', key: 'اداره برق', credit: 4_000_000 }]).kind, 'obligation');
    const partner = database.componentFromLines([{ role: 'expense-category', key: 'خوراک', debit: 2_000_000 }, { role: 'partner-payable', key: 'سعیدی', credit: 2_000_000 }]);
    assert.deepEqual([partner.kind, partner.item.fundedBy], ['cash', { kind: 'partner' }]);
    assert.equal(database.componentFromLines([{ role: 'income-category', key: 'فروش', credit: 5_000_000 }, { role: 'cash', debit: 5_000_000 }]).item.type, 'income');
    assert.equal(database.componentFromLines([{ role: 'prepaid-asset', debit: 36_000_000 }, { role: 'cash', credit: 36_000_000 }]), null);
  });
});

test('تأییدِ حسابدار همان لحظه یاد گرفته می‌شود و پارسر جملهٔ بعدی را درست می‌گیرد', () => {
  inBook(() => {
    assert.equal(parseFinancialText(SWITCH).transactions[0].category, 'سایر هزینه‌ها');
    database.recordAccountantLesson({ eventId: 'e1', transcript: SWITCH, lines: repairLines(), topicLabel: 'کلید برق' });
    const [lesson] = lessons('category');
    assert.equal(lesson.status, 'learned');
    assert.equal(lesson.confirmations, 1);
    assert.equal(lesson.final.confirmedBy, 'accountant');
    assert.deepEqual(database.getLearnings().map((item) => [item.keyword, item.category, item.source]), [['کلید برق', REPAIR, 'accountant']]);
    const next = parseFinancialText('یه کلید برق دیگه ۲۰۰ هزار تومن خریدیم', { learnings: database.getLearnings() }).transactions[0];
    assert.equal(next.category, REPAIR);
    assert.match(next.confidenceDetails.category.reason, /حسابدار/);
  });
});

test('همان مرزها: جهت پول عوض نمی‌شود، یادگیریِ کاربر بازنویسی نمی‌شود، بی‌موضوع یاد گرفته نمی‌شود', () => {
  const said = 'بابت کلید برق ۲۰۰ هزار تومن دریافت کردیم';
  assert.equal(parseFinancialText(said, { learnings: [{ keyword: 'کلید برق', category: REPAIR, source: 'accountant' }] }).transactions[0].type, 'income');
  inBook(() => {
    database.saveLearning({ keyword: 'کلید برق', category: 'ملزومات اداری' });
    database.recordAccountantLesson({ eventId: 'e1', transcript: 'یه کلید برق ۲۰۰ هزار تومن خریدیم', lines: repairLines(200_000), topicLabel: 'کلید برق' });
    assert.equal(lessons('category')[0].status, 'conflict');
    assert.deepEqual(database.getLearnings().map((item) => [item.category, item.source]), [['ملزومات اداری', 'manual']]);
  });
  inBook(() => {
    database.recordAccountantLesson({ eventId: 'e1', transcript: SWITCH, lines: repairLines(), topicLabel: null });
    assert.deepEqual(lessons().map((lesson) => lesson.flags.map((flag) => flag.id)), [['category-unlearnable']]);
    assert.deepEqual(database.getLearnings(), []);
  });
});

test('اختلاف ساختاری از تأییدِ حسابدار: ثبتِ تعهد جایی که پارسر نقد می‌ساخت', () => {
  inBook(() => {
    database.recordAccountantLesson({ eventId: 'e1', transcript: 'قبض برق ۴ میلیون اومده', lines: [{ role: 'expense-category', key: 'قبوض', debit: 4_000_000 }, { role: 'payable', key: 'اداره برق', credit: 4_000_000 }], topicLabel: 'قبض برق' });
    const [lesson] = lessons('structural');
    assert.deepEqual(lesson.flags.map((flag) => flag.id), ['cash-for-unpaid']);
    assert.equal(lesson.final.confirmedBy, 'accountant');
    assert.deepEqual(database.getLearnings(), []);
  });
});

test('هر سه راهِ تأیید در صف، پس از COMMIT، به یادگیری می‌روند', () => {
  const source = readFileSync(new URL('../server/db/financialEvents.js', import.meta.url), 'utf8');
  assert.match(source, /addReviewMessage\(database,eventId,'accepted',`تأیید سند \$\{item\.journalEntryId\}`,actor\);\s*database\.exec\('COMMIT'\);\s*learnFromAccountant\(database, fresh,/, 'نقشهٔ قطعی');
  assert.match(source, /audit\('accept-ai-proposal'[^\n]*\n\s*learnFromAccountant\(database, fresh, final\.lines\);/, 'پیشنهادِ AI');
  assert.match(source, /audit\('reviewed-composite'[^\n]*\n\s*learnFromAccountant\(database, row, lines\);/, 'سطرهای دستی');
  assert.match(source, /function learnFromAccountant\(database, row, lines\) \{\s*try \{[\s\S]*?\} catch \(error\) \{ console\.warn\('\[ai-lessons\]'/, 'شکستِ یادگیری سند را برنمی‌گرداند');
});
