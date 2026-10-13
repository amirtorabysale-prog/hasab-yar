import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFinancialText } from '../shared/parser.js';
import { runVoice } from './helpers/voicePipeline.js';
import { ROLES } from '../shared/accountingRules.js';

/**
 * موتور ۵ پس از ادغام: خوانندهٔ مبلغ و خوانندهٔ دوره با هم.
 *
 * سالی که خوانندهٔ دوره سال می‌خواند («مهر ۰۵ ۳۰ میلیون»، «سال ۱۴۰۶ ۱۲ میلیون»)
 * پیش از خواندن مبلغ ماسک می‌شود؛ پس هم مبلغ درست است و هم دوره خوانده می‌شود.
 * سالِ حروفی پیش از مبلغِ رقمی هم سال است، نه بخشی از مبلغ و نه ردیف دوم.
 * و بیمه‌ای که بارِ حمل‌شده را بیمه می‌کند، بیمه است نه حمل‌ونقل.
 */
const NOW = '2026-10-10T00:00:00.000Z';
const rows = (text) => parseFinancialText(text, { now: new Date(NOW) }).transactions;
const amounts = (text) => rows(text).map((row) => row.amount);
const lines = (item) => (item.plan?.lines || []).map((line) => [line.role, line.debit || line.credit]);

test('سالِ دورقمی و چهاررقمی کنار مبلغ: مبلغ درست و دوره خوانده‌شده', () => {
  for (const [text, amount, months] of [
    ['اجاره مهر ۰۵ ۳۰ میلیون دادیم', 30_000_000, 1],
    ['بیمه از مهر 05 تا شهریور 06 12 میلیون دادیم', 12_000_000, 12],
    ['اجاره سال ۰۶ ۱۲۰ میلیون دادیم', 120_000_000, 12],
    ['بیمه سال ۱۴۰۶ ۱۲ میلیون دادیم', 12_000_000, 12],
    ['بیمه از اول آبان ۱۴۰۵ تا پایان مهر ۱۴۰۶ ۲۴ میلیون دادیم', 24_000_000, 12],
  ]) {
    const [row, ...rest] = rows(text);
    assert.equal(rest.length, 0, text);
    assert.equal(row.amount, amount, text);
    assert.ok(row.servicePeriodStart && row.servicePeriodEnd, `${text} — دوره خوانده شد`);
    const span = (new Date(row.servicePeriodEnd) - new Date(row.servicePeriodStart)) / (30.4 * 86_400_000);
    assert.equal(Math.round(span), months, text);
  }
  // سالِ کنار مبلغ وقتی دوره‌ای از آن خوانده نمی‌شود هم در مبلغ جمع نمی‌شود.
  assert.deepEqual(amounts('لایسنس تا اسفند ۰۵ ۶۰ میلیون دادیم'), [60_000_000]);
});

test('سالِ حروفی پیش از مبلغ رقمی، سال است', () => {
  for (const [text, expected] of [
    ['بیمه هزار و چهارصد و شش ۱۲ میلیون دادیم', [12_000_000]],
    ['اجاره هزار و چهارصد و پنج ۳۰ میلیون دادیم', [30_000_000]],
    ['هزار و چهارصد و پنج تا آخر شهریور ۳۰ میلیون دادیم', [30_000_000]],
  ]) assert.deepEqual(amounts(text), expected, text);
  // دو عددِ پشت‌سرهم که سال نیستند، یک مبلغِ ۵۰۳ میلیونی نمی‌سازند.
  assert.deepEqual(amounts('دو هزار و پونصد ۳ میلیون دادیم'), [2_500, 3_000_000]);
});

test('منفی: مبلغ‌های واقعیِ چندبخشی دست‌نخورده‌اند', () => {
  for (const [text, expected] of [
    ['یک میلیون ۲۰۰ هزار دادیم', [1_200_000]],
    ['دو میلیون و پونصد دادیم', [2_500_000]],
    ['پنج میلیون و ۲۰۰ هزار دادیم', [5_200_000]],
    ['اجاره ۱۴۰۰ میلیون دادیم', [1_400_000_000]],
    ['هزار و چهارصد تومن دادیم', [1_400]],
    ['۱۵ مهر ۳۰ میلیون اجاره دادیم', [30_000_000]],
  ]) assert.deepEqual(amounts(text), expected, text);
});

test('بیمهٔ بار و حمل‌ونقل، بیمه است؛ کرایهٔ حمل، حمل‌ونقل', () => {
  for (const [text, amount] of [
    ['بیمه حمل و نقل یکساله ۱۲ میلیون دادیم', 12_000_000],
    ['بیمه حمل سه ماه آینده ۹ میلیون دادیم', 9_000_000],
    ['بیمه یکساله باربری ۶ میلیون دادیم', 6_000_000],
  ]) {
    const [item] = runVoice(text, { today: NOW }).items;
    assert.equal(item.category, 'بیمه', text);
    assert.equal(item.outcome, 'post', text);
    assert.deepEqual(lines(item), [[ROLES.PREPAID_ASSET, amount], [ROLES.CASH, amount]], text);
  }
  for (const text of ['کرایه حمل بار ۲ میلیون دادیم', 'باربری ۵ میلیون دادیم']) {
    assert.equal(rows(text)[0].category, 'حمل‌ونقل', text);
  }
});
