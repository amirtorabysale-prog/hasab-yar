import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const databasePath = `/tmp/hesab-yar-validation-${process.pid}.sqlite`;
process.env.DATABASE_PATH = databasePath;
process.env.ADMIN_USERNAME = 'validation-owner';
process.env.ADMIN_PASSWORD = 'validation-safe-password-6620';

const database = await import(`../server/db.js?validation=${process.pid}`);
database.ensureAdmin();

const owner = database.authenticateUser('validation-owner', 'validation-safe-password-6620');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر اعتبارسنجی', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);

// error handler فقط وقتی پیام واقعی را به کاربر می‌دهد که خطا status داشته
// باشد. بدون آن، کاربر «خطای داخلی سرور؛ دوباره تلاش کن» می‌بیند و تا ابد
// دوباره تلاش می‌کند، چون ایراد از ورودی خودش بوده و پیامش را هرگز ندیده.
function assertUserFacing(fn, expectedFragment) {
  try {
    fn();
    assert.fail('انتظار خطا می‌رفت');
  } catch (error) {
    assert.equal(error.status, 400, `خطای «${error.message}» بدون status است و به کاربر ۵۰۰ نشان داده می‌شود`);
    assert.ok(error.message.includes(expectedFragment), `پیام «${error.message}» شامل «${expectedFragment}» نیست`);
    return error;
  }
}

test('مبلغ خارج از بازه، خطای ورودی است نه خرابی سرور', () => {
  inWorkspace(() => {
    assertUserFacing(() => database.insertTransactions({
      transcript: 'آزمون',
      transactions: [{ amount: Number.MAX_SAFE_INTEGER, type: 'income', category: 'فروش', rawText: 'x', accountId: 'cash' }],
    }), 'مبلغ');
  });
});

test('نوع تراکنش نامعتبر، خطای ورودی است', () => {
  inWorkspace(() => {
    assertUserFacing(() => database.insertTransactions({
      transcript: 'آزمون',
      transactions: [{ amount: 100_000, type: 'نامعتبر', category: 'فروش', rawText: 'x', accountId: 'cash' }],
    }), 'نوع تراکنش');
  });
});

test('حساب ناموجود، خطای ورودی است', () => {
  inWorkspace(() => {
    assertUserFacing(() => database.insertTransactions({
      transcript: 'آزمون',
      transactions: [{ amount: 100_000, type: 'income', category: 'فروش', rawText: 'x', accountId: 'حساب-ناموجود' }],
    }), 'حساب مالی');
  });
});

test('نام دفتر کوتاه، خطای ورودی است', () => {
  assertUserFacing(() => database.createWorkspace(owner.id, { name: 'ی', profileType: 'business' }), 'نام دفتر');
});

test('نقش نامعتبر عضو، خطای ورودی است', () => {
  assertUserFacing(() => database.addWorkspaceMember(workspace.id, { username: 'someone', role: 'رئیس' }), 'نقش');
});

test('کد خطا برای کلاینت قابل تشخیص است', () => {
  const error = assertUserFacing(() => database.createWorkspace(owner.id, { name: '', profileType: 'business' }), 'نام دفتر');
  assert.equal(error.code, 'INVALID_INPUT');
});

// نگهبان: اگر کسی دوباره `throw new Error` خام اضافه کند، پیامش بی‌صدا پشت
// «خطای داخلی سرور» پنهان می‌شود. این آزمون همان عقب‌گرد را می‌گیرد.
test('هیچ اعتبارسنجی تازه‌ای بدون status اضافه نشده است', () => {
  const source = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  const bare = source.match(/throw new Error\(/g) || [];
  assert.equal(bare.length, 0, `${bare.length} مورد throw بدون status در db.js هست؛ به‌جایش invalidInput استفاده کن`);
});
