import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSheet, openSheetCount, sheetRefCallback } from '../src/components/sheetA11y.js';

/**
 * رفتار قلاب برگه‌ها، نه متنش (بررسی تغییرات z.ai، ۲۸ مهر ۱۴۰۵):
 * - برگهٔ تأیید منفی‌شدن روی برگهٔ «فهم گفته»: Tab روی دکمهٔ اول گیر می‌کرد، چون
 *   برگهٔ زیرین فوکوس را پس می‌گرفت، و Escape هر دو برگه را می‌بست.
 * - برگهٔ ویرایش و پرداخت دفتر مالی و برگهٔ تنخواه اصلاً وصل نمی‌شدند، چون قلاب
 *   در صفحهٔ همیشه‌سوار با useEffect([]) اجرا می‌شد و برگه آن لحظه نبود.
 *
 * window و document ساختگی‌اند؛ مثل مرورگر، همهٔ شنونده‌های window یک رویداد را
 * می‌گیرند و stopPropagation جلوی شنوندهٔ دیگرِ همان window را نمی‌گیرد.
 */

class FakeElement {
  constructor(name, doc) { this.name = name; this.doc = doc; this.offsetParent = {}; }
  focus() { this.doc.activeElement = this; }
}

function fakeWindow() {
  const doc = { activeElement: null };
  const listeners = [];
  const win = {
    HTMLElement: FakeElement,
    addEventListener: (_type, listener) => listeners.push(listener),
    removeEventListener: (_type, listener) => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); },
  };
  const press = (key, { shiftKey = false } = {}) => {
    const event = { key, shiftKey, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    for (const listener of [...listeners]) listener(event);
    return event;
  };
  return { env: { doc, win }, doc, press, listeners };
}

function fakeSheet(doc, names) {
  const items = names.map((name) => new FakeElement(name, doc));
  const node = new FakeElement('sheet', doc);
  node.querySelectorAll = () => items;
  node.contains = (element) => element === node || items.includes(element);
  return { node, items };
}

test('برگهٔ رویی کلید را می‌گیرد: Tab در خودش می‌چرخد و Escape فقط خودش را می‌بندد', () => {
  const { env, doc, press } = fakeWindow();
  const trigger = new FakeElement('دکمهٔ ثبت', doc);
  trigger.focus();
  const closed = [];
  const understanding = fakeSheet(doc, ['پاسخ', 'ثبت پرونده']);
  const detachUnderstanding = attachSheet(understanding.node, () => () => closed.push('فهم گفته'), env);
  understanding.items[1].focus();
  const overdraft = fakeSheet(doc, ['تأیید منفی‌شدن', 'لغو']);
  const detachOverdraft = attachSheet(overdraft.node, () => () => closed.push('منفی‌شدن'), env);
  assert.equal(doc.activeElement, overdraft.items[0], 'برگهٔ تازه فوکوس را می‌گیرد');

  const tab = press('Tab');
  assert.equal(doc.activeElement, overdraft.items[0], 'برگهٔ زیرین فوکوس را نمی‌دزدد');
  assert.equal(tab.prevented, false, 'مرورگر خودش به دکمهٔ بعد می‌رود');
  overdraft.items[1].focus();
  assert.equal(press('Tab').prevented, true);
  assert.equal(doc.activeElement, overdraft.items[0], 'از آخرین دکمه به اولی برمی‌گردد');

  press('Escape');
  assert.deepEqual(closed, ['منفی‌شدن'], 'Escape فقط برگهٔ رویی را می‌بندد');
  detachOverdraft();
  assert.equal(doc.activeElement, understanding.items[1], 'فوکوس به همان دکمهٔ برگهٔ زیرین برمی‌گردد');
  press('Escape');
  assert.deepEqual(closed, ['منفی‌شدن', 'فهم گفته'], 'حالا برگهٔ زیرین بالاترین است');
  detachUnderstanding();
  assert.equal(doc.activeElement, trigger);
  assert.equal(openSheetCount(), 0);
});

test('برگه‌ای که بعد از سوار شدن صفحه باز می‌شود هم وصل می‌شود و با بسته‌شدن جدا', () => {
  const { env, doc, press, listeners } = fakeWindow();
  const editButton = new FakeElement('ویرایش ردیف', doc);
  editButton.focus();
  let closes = 0;
  // صفحهٔ دفتر مالی سوار است و برگهٔ ویرایش هنوز رندر نشده.
  const ref = sheetRefCallback(() => () => { closes += 1; }, env);
  assert.equal(listeners.length, 0);
  const edit = fakeSheet(doc, ['مبلغ', 'ذخیره', 'لغو']);
  ref(edit.node);
  assert.equal(listeners.length, 1, 'برگه وصل شد');
  assert.equal(doc.activeElement, edit.items[0], 'فوکوس به اولین کنترل رفت');
  press('Escape');
  assert.equal(closes, 1);
  ref(null);
  assert.equal(listeners.length, 0, 'با رفتن برگه شنونده جدا شد');
  assert.equal(doc.activeElement, editButton, 'فوکوس به دکمهٔ بازکننده برگشت');
  assert.equal(openSheetCount(), 0);
});

test('برگهٔ اجباری بی دکمهٔ بستن: Escape کاری نمی‌کند ولی تلهٔ فوکوس هست', () => {
  const { env, doc, press } = fakeWindow();
  const onboarding = fakeSheet(doc, ['نوع پرونده', 'شروع']);
  const detach = attachSheet(onboarding.node, () => null, env);
  assert.doesNotThrow(() => press('Escape'));
  onboarding.items[1].focus();
  assert.equal(press('Tab').prevented, true);
  assert.equal(doc.activeElement, onboarding.items[0]);
  detach();
});

test('برگهٔ زیرینی که زودتر بسته شود، فوکوس را از برگهٔ رویی نمی‌دزدد', () => {
  const { env, doc, press } = fakeWindow();
  new FakeElement('دکمهٔ ثبت', doc).focus();
  const closed = [];
  const understanding = fakeSheet(doc, ['پاسخ']);
  const detachUnderstanding = attachSheet(understanding.node, () => () => closed.push('فهم گفته'), env);
  const overdraft = fakeSheet(doc, ['تأیید منفی‌شدن', 'لغو']);
  const detachOverdraft = attachSheet(overdraft.node, () => () => closed.push('منفی‌شدن'), env);
  overdraft.items[1].focus();
  detachUnderstanding();
  assert.equal(doc.activeElement, overdraft.items[1], 'فوکوس در برگهٔ رویی می‌ماند');
  press('Escape');
  assert.deepEqual(closed, ['منفی‌شدن']);
  detachOverdraft();
  assert.equal(openSheetCount(), 0);
});
