import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = new EventTarget();
const { COUNTERPARTY_PROMPT_EVENT, withCounterpartyConfirmation } = await import('../src/lib/counterpartyPrompt.js');

const similar = () => Object.assign(new Error('مشابه'), {
  code: 'COUNTERPARTY_SIMILAR', details: { input: 'آرمان', existing: { id: 'c1', name: 'شرکت آرمان' } },
});

/** کاربرِ ساختگی که به پرسش جواب می‌دهد. */
function answerWith(resolution) {
  const seen = [];
  const listener = (event) => { seen.push(event.detail.details); event.detail.resolve(resolution); };
  window.addEventListener(COUNTERPARTY_PROMPT_EVENT, listener, { once: true });
  return seen;
}

test('ثبت بدون شباهت یک بار و بدون پرسش انجام می‌شود', async () => {
  const calls = [];
  const result = await withCounterpartyConfirmation(async (resolution) => { calls.push(resolution); return 'ok'; });
  assert.equal(result, 'ok');
  assert.deepEqual(calls, ['']);
});

test('نام مشابه پرسیده می‌شود و همان درخواست با جواب کاربر دوباره می‌رود', async () => {
  const seen = answerWith('merge');
  const calls = [];
  const result = await withCounterpartyConfirmation(async (resolution) => {
    calls.push(resolution);
    if (!resolution) throw similar();
    return `saved:${resolution}`;
  });
  assert.equal(result, 'saved:merge');
  assert.deepEqual(calls, ['', 'merge']);
  assert.equal(seen[0].existing.name, 'شرکت آرمان', 'برگه باید طرف حساب موجود را نشان دهد');
});

// بستن برگه نباید بی‌صدا یکی از دو گزینه را انتخاب کند.
test('بستن برگه ثبت را لغو می‌کند و چیزی ذخیره نمی‌شود', async () => {
  answerWith(null);
  let secondCall = false;
  await assert.rejects(
    withCounterpartyConfirmation(async (resolution) => { if (resolution) secondCall = true; throw similar(); }),
    (error) => error.code === 'COUNTERPARTY_CANCELLED',
  );
  assert.equal(secondCall, false);
});

test('خطای دیگر بدون پرسش به فراخوان برمی‌گردد', async () => {
  await assert.rejects(
    withCounterpartyConfirmation(async () => { throw Object.assign(new Error('مبلغ معتبر نیست'), { code: 'INVALID_INPUT' }); }),
    /مبلغ معتبر نیست/,
  );
});
