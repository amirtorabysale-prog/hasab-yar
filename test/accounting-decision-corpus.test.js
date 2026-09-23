import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseFinancialText } from '../shared/parser.js';
import { normalizeFinancialEvent } from '../shared/financialEvent.js';
import { factsFromEvent } from '../shared/eventFacts.js';
import { DECISION_STATUS, decide, decisionAuthorizesPosting } from '../shared/accountingDecision.js';
import { FAMILY_UNKNOWN } from '../shared/economicFamily.js';

/**
 * پیکرهٔ طلایی — از متن فارسی تا تصمیم، از همان مسیری که در برنامه اجرا می‌شود.
 *
 * چرا از متن و نه از واقعیت‌های دستی: تا امروز دموها با واقعیت‌هایی کار می‌کردند
 * که خودم می‌ساختم، و همین پنهان کرده بود که پارسر اصلاً دستهٔ «بیمه» را تولید
 * نمی‌کند. پیکره‌ای که از متن شروع نکند، همین اشتباه را دوباره پنهان می‌کند.
 *
 * دو معیار، و تفاوتشان مهم است:
 *
 * ۱. **هیچ‌وقت اشتباه نگوید.** اگر موتور خانواده‌ای بدهد، باید همان خانوادهٔ
 *    درست باشد. این معیار سخت است و آستانه‌اش صفر است.
 *
 * ۲. **حق دارد نداند.** «نمی‌دانم» یک جواب درست است، نه یک شکست. سناریویی که
 *    `mayAbstain` دارد می‌تواند `unknown` بگیرد بدون اینکه تست بشکند.
 *
 * معیار اول از دومی مهم‌تر است: سیستمی که سی درصد موارد را به حسابدار ارجاع
 * می‌دهد ولی هیچ‌وقت بی‌صدا اشتباه نمی‌زند قابل فروش است. عکسش نیست.
 */

const corpus = JSON.parse(readFileSync(new URL('./fixtures/accounting-decision-golden-v2.json', import.meta.url), 'utf8'));
const TODAY = '2026-09-23T00:00:00.000Z';

/** همان زنجیره‌ای که در برنامه اجرا می‌شود: متن → تراکنش → رویداد → واقعیت → تصمیم. */
function runCase(input) {
  const [item] = parseFinancialText(input).transactions || [];
  if (!item) return { parsed: false, decision: null };
  const event = normalizeFinancialEvent({
    kind: item.type === 'income' ? 'cash-income' : 'cash-expense',
    amount: item.amount,
    occurredAt: item.occurredAt || TODAY,
    category: item.category,
    counterparty: item.contactName || '',
    accountId: item.accountId || 'cash',
    evidence: input,
  });
  return { parsed: true, item, event, decision: decide(factsFromEvent(event), { today: TODAY }) };
}

test('پیکرهٔ طلایی ساختار سالمی دارد', () => {
  assert.equal(corpus.cases.length, 30, 'سی سناریو');
  assert.equal(new Set(corpus.cases.map((item) => item.id)).size, 30, 'شناسه‌ها یکتا');
  for (const group of ['clear', 'ambiguous', 'incomplete']) {
    assert.equal(corpus.cases.filter((item) => item.group === group).length, 10, `${group}: باید ده سناریو باشد`);
  }
  for (const item of corpus.cases) {
    assert.ok(item.input?.trim(), `${item.id}: متن ورودی ندارد`);
    assert.ok(item.why?.trim(), `${item.id}: دلیل انتظار نوشته نشده`);
  }
});

test('موتور هیچ‌وقت خانوادهٔ اشتباه نمی‌دهد', () => {
  // آستانه صفر است. «نمی‌دانم» مجاز است؛ «اشتباه با اطمینان» نه.
  const wrong = [];
  for (const item of corpus.cases) {
    const { parsed, decision } = runCase(item.input);
    if (!parsed || !decision) continue;
    if (decision.family === FAMILY_UNKNOWN) continue;
    if (decision.family !== item.expectedFamily) {
      wrong.push(`${item.id}: «${item.input}» → ${decision.family}، انتظار ${item.expectedFamily}`);
    }
  }
  assert.deepEqual(wrong, [], `خانوادهٔ اشتباه:\n${wrong.join('\n')}`);
});

test('هیچ سناریویی که نباید ثبت شود، اجازهٔ ثبت نمی‌گیرد', () => {
  const posted = [];
  for (const item of corpus.cases.filter((entry) => entry.expectNotPosted)) {
    const { decision } = runCase(item.input);
    if (decision && decisionAuthorizesPosting(decision)) posted.push(`${item.id}: «${item.input}»`);
  }
  assert.deepEqual(posted, [], `ثبت خودکارِ ناروا:\n${posted.join('\n')}`);
});

test('سناریوهای روشنِ غیرقابل‌امتناع، ماهیتشان تشخیص داده می‌شود', () => {
  const missed = [];
  for (const item of corpus.cases.filter((entry) => entry.mayAbstain === false)) {
    const { decision } = runCase(item.input);
    if (!decision || decision.family !== item.expectedFamily) {
      missed.push(`${item.id}: «${item.input}» → ${decision?.family || 'بدون تصمیم'}`);
    }
  }
  assert.deepEqual(missed, [], `ماهیت تشخیص داده نشد:\n${missed.join('\n')}`);
});

test('سؤالِ درست پرسیده می‌شود، نه هر سؤالی', () => {
  // پرسیدن «دورهٔ پوشش» از یک ودیعه، سؤال غلط از رویداد درست است.
  const wrong = [];
  for (const item of corpus.cases.filter((entry) => entry.expectAsks)) {
    const { decision } = runCase(item.input);
    if (decision?.question?.fact !== item.expectAsks) {
      wrong.push(`${item.id}: «${item.input}» → ${decision?.question?.fact || 'بدون سؤال'}، انتظار ${item.expectAsks}`);
    }
  }
  assert.deepEqual(wrong, [], `سؤال اشتباه:\n${wrong.join('\n')}`);
});

test('اجرای دوباره، همان نتیجه را می‌دهد', () => {
  // تابع خالص بودن تصمیم، شرط replay است. بدون این، گزارش اختلاف فاز بعد
  // نمی‌تواند بگوید تفاوت از تغییر قاعده بود یا از تصادف.
  for (const item of corpus.cases) {
    assert.deepEqual(runCase(item.input).decision, runCase(item.input).decision, `${item.id}: نتیجه پایدار نیست`);
  }
});

test('گزارش پوشش — چند تا تشخیص، چند تا امتناع', () => {
  // این تست هیچ‌وقت نمی‌شکند؛ کارش گزارش است. عددِ امتناع باید فاز‌به‌فاز پایین
  // بیاید و اگر یک روز بالا رفت، یعنی چیزی در خط تولید شکسته.
  const summary = { decided: 0, asked: 0, accountant: 0, unsupported: 0, abstained: 0, unparsed: 0 };
  for (const item of corpus.cases) {
    const { parsed, decision } = runCase(item.input);
    if (!parsed) { summary.unparsed += 1; continue; }
    if (decision.family === FAMILY_UNKNOWN) summary.abstained += 1;
    if (decision.decisionStatus === DECISION_STATUS.DECIDED) summary.decided += 1;
    else if (decision.decisionStatus === DECISION_STATUS.NEEDS_USER_INPUT) summary.asked += 1;
    else if (decision.decisionStatus === DECISION_STATUS.UNSUPPORTED) summary.unsupported += 1;
    else summary.accountant += 1;
  }
  console.log('   پوشش پیکره:', JSON.stringify(summary));
  assert.equal(summary.decided + summary.asked + summary.accountant + summary.unsupported + summary.unparsed, 30);
});
