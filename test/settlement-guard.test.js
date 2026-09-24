import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';

const databasePath = tempDatabase('settlement-guard');
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'guard-owner';
process.env.ADMIN_PASSWORD = `settle-${crypto.randomUUID()}`;

const database = await import(`../server/db.js?settle=${process.pid}`);
const { openDocumentsFor } = await import(`../server/db/counterpartyCard.js?settle=${process.pid}`);
const { SETTLEMENT_MATCH, matchOpenDocument } = await import('../shared/settlementMatch.js');
const { GUARD_VERDICTS, runGuards } = await import('../shared/guards.js');
const { normalizeFinancialEvent } = await import('../shared/financialEvent.js');
const { factsFromEvent } = await import('../shared/eventFacts.js');

database.ensureAdmin();
const owner = database.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
const inPrimary = (callback) => database.runInWorkspace('primary', { role: 'owner', userId: owner.id }, callback);

const OCCURRED = '2026-09-23T00:00:00.000Z';

/**
 * نگهبان «اول تسویه».
 *
 * «۹۳ میلیون به شرکت آراد پرداخت کردم» تا امروز یک هزینهٔ تازه می‌ساخت. ولی
 * وقتی به آن شرکت بدهکاریم، این پرداخت هزینه نمی‌سازد — بدهی موجود را می‌بندد.
 * ثبتش به‌عنوان هزینه دو خطا با هم دارد: سود دوره بی‌دلیل کم می‌شود، و بدهی آن
 * شرکت در دفتر باز می‌ماند انگار پولی نداده‌ایم.
 *
 * تست‌های منفی اول نوشته شده‌اند: معیار این نگهبان «چه چیزی می‌سازد» نیست،
 * «چه چیزی هرگز نمی‌سازد» است.
 */

let vendor;
test('آماده‌سازی: یک تأمین‌کننده با بدهی باز', () => {
  inPrimary(() => {
    vendor = database.saveContact({ name: 'شرکت آراد گستر آسیا', kind: 'vendor' });
    database.saveObligation({
      contactId: vendor.id, title: 'فاکتور ۱۲۳', amount: 93_000_000,
      direction: 'payable', occurredAt: OCCURRED,
    });
    assert.ok(vendor.id);
  });
});

test('اسناد باز یک طرف حساب، ردیف‌به‌ردیف برمی‌گردند', () => {
  inPrimary(() => {
    const documents = openDocumentsFor(vendor.id);
    assert.equal(documents.length, 1, 'یک سند باز');
    const [document] = documents;
    assert.equal(document.kind, 'obligation');
    assert.equal(document.direction, 'payable');
    assert.equal(document.remaining, 93_000_000);
    assert.ok(document.reference?.trim(), 'سند باید مرجع خوانا داشته باشد');
  });
});

test('طرف حسابِ بدون سند باز، فهرست خالی می‌دهد', () => {
  inPrimary(() => {
    const stranger = database.saveContact({ name: 'آقای رضایی', kind: 'vendor' });
    assert.deepEqual(openDocumentsFor(stranger.id), []);
  });
});

// ---------------------------------------------------------------------------
// تطبیق — تابع خالص، جدا از دیتابیس
// ---------------------------------------------------------------------------

const openDoc = (extra = {}) => ({ kind: 'obligation', id: 'o1', direction: 'payable', remaining: 93_000_000, reference: 'فاکتور ۱۲۳', occurredAt: OCCURRED, ...extra });

test('مبلغ دقیقاً برابر، تسویهٔ کامل است', () => {
  const match = matchOpenDocument({ amount: 93_000_000, moneyDirection: 'out' }, [openDoc()]);
  assert.equal(match.kind, SETTLEMENT_MATCH.EXACT);
  assert.equal(match.document.id, 'o1');
});

test('مبلغ کمتر، تسویهٔ جزئی است', () => {
  const match = matchOpenDocument({ amount: 40_000_000, moneyDirection: 'out' }, [openDoc()]);
  assert.equal(match.kind, SETTLEMENT_MATCH.PARTIAL);
});

test('مبلغ بیشتر از ماندهٔ سند، تسویه نیست', () => {
  // پرداخت بیشتر از بدهی یعنی چیزی غیر از تسویه هم در کار است؛ حدس زدنش
  // بدتر از نگفتن است.
  const match = matchOpenDocument({ amount: 200_000_000, moneyDirection: 'out' }, [openDoc()]);
  assert.equal(match.kind, SETTLEMENT_MATCH.NONE);
});

test('جهت پول که نخواند، تسویه نیست', () => {
  // پول وارد شد ولی سند باز یک بدهیِ ماست: این وصول طلب نیست.
  const match = matchOpenDocument({ amount: 93_000_000, moneyDirection: 'in' }, [openDoc()]);
  assert.equal(match.kind, SETTLEMENT_MATCH.NONE);
});

test('دو سند با مبلغ یکسان، ابهام است نه انتخاب', () => {
  // انتخاب یکی از دو سندِ هم‌مبلغ یعنی حدس. سند اشتباه بسته می‌شود و هیچ
  // نشانه‌ای هم ندارد.
  const match = matchOpenDocument({ amount: 93_000_000, moneyDirection: 'out' },
    [openDoc(), openDoc({ id: 'o2', reference: 'فاکتور ۱۲۴' })]);
  assert.equal(match.kind, SETTLEMENT_MATCH.AMBIGUOUS);
});

// ---------------------------------------------------------------------------
// تست‌های منفی نگهبان
// ---------------------------------------------------------------------------

const payment = (extra = {}) => normalizeFinancialEvent({
  kind: 'cash-expense', amount: 93_000_000, occurredAt: OCCURRED,
  category: 'سایر هزینه‌ها', accountId: 'bank-mellat', counterparty: 'شرکت آراد گستر آسیا', ...extra,
});

test('پرداختِ برابر با بدهی باز، هزینهٔ تازه نمی‌سازد', () => {
  const event = payment();
  const result = runGuards(event, factsFromEvent(event), { openDocuments: [openDoc()] });
  assert.equal(result.verdict, GUARD_VERDICTS.REWRITE, 'باید تصحیح شود، نه رد');
  assert.ok(result.reason.includes('فاکتور ۱۲۳'), 'دلیل باید سند را نام ببرد');
  const roles = result.plan.lines.map((line) => line.role);
  assert.equal(roles.includes('expense-category'), false, 'هیچ سطری نباید هزینه باشد');
  assert.ok(roles.includes('payable'), 'باید بدهی را ببندد');
});

test('تسویه هیچ اثری روی سود و زیان ندارد', () => {
  const event = payment();
  const result = runGuards(event, factsFromEvent(event), { openDocuments: [openDoc()] });
  const roles = result.plan.lines.map((line) => line.role);
  for (const role of ['expense-category', 'income-category', 'depreciation-expense']) {
    assert.equal(roles.includes(role), false, `نقش «${role}» نباید در سند تسویه باشد`);
  }
});

test('پرداخت بدون سند مرتبط، عبور می‌کند ولی بررسی ثبت می‌شود', () => {
  // «بررسی انجام نشد» و «چیزی برای تسویه نبود» باید از هم جدا بمانند.
  const event = payment();
  const result = runGuards(event, factsFromEvent(event), { openDocuments: [] });
  const check = result.checks.find((entry) => entry.name === 'settlement-first');
  assert.equal(check.verdict, GUARD_VERDICTS.PASS);
  assert.equal(check.checked, true);
  assert.equal(check.openDocumentCount, 0, 'تعداد اسناد بررسی‌شده باید ثبت شود');
});

test('ابهام میان دو سند، به حسابدار می‌رود — نه حدس', () => {
  const event = payment();
  const result = runGuards(event, factsFromEvent(event), {
    openDocuments: [openDoc(), openDoc({ id: 'o2', reference: 'فاکتور ۱۲۴' })],
  });
  assert.equal(result.verdict, GUARD_VERDICTS.BLOCK);
  assert.ok(result.reason?.trim());
});

test('وقتی طرف حساب شناسایی نشده، نگهبان سکوت نمی‌کند', () => {
  // امروز این حالت بی‌صدا هزینه می‌شد. حالا باید صریح بگوید که نتوانست بررسی کند.
  const event = payment({ counterparty: '' });
  const result = runGuards(event, factsFromEvent(event), { openDocuments: null });
  const check = result.checks.find((entry) => entry.name === 'settlement-first');
  assert.equal(check.checked, true);
  assert.ok(check.reason.includes('بررسی'), 'باید بگوید چرا نتوانست بررسی کند');
});
