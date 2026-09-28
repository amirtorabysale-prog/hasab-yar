import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFinancialText, hasCompositeAmounts } from '../shared/parser.js';
import { detectVoiceIntent } from '../shared/voiceIntent.js';

test('typed colloquial amount requires scale confirmation just like voice', () => {
  for (const source of ['text', 'voice']) {
    const result = parseFinancialText('یه سی تومن ریختم واسه چاپخونه', { source });
    assert.equal(result.transactions.length, 1);
    assert.equal(result.transactions[0].amountScaleAmbiguous, true);
    assert.equal(result.transactions[0].needsReview, true);
  }
});
test('discount verb does not reverse customer cheque direction', () => {
  const intent = detectVoiceIntent('فروش داشتیم به فروشگاه رضوی، جمع فاکتور هشتاد میلیون شد، پنج میلیون تخفیف تجاری دادیم، مانده رو چک ۴۵ روزه دادن.');
  assert.equal(intent.intent, 'cheque');
  assert.equal(intent.direction, 'receivable');
});
test('capital old/new balances and conditional forgiveness stay one review case', () => {
  for (const text of [
    'سرمایه نقدی شرکت از پانصد میلیون به یک میلیارد تومن با واریز نقدی سهامداران افزایش یافت.',
    'به تامین کننده هشتاد میلیون بدهکار بودیم، پنجاه میلیون دادیم، گفت ده تومن دیگه بدی بقیه شو می بخشم',
  ]) {
    assert.equal(hasCompositeAmounts(text), true);
    assert.equal(parseFinancialText(text).transactions.length, 0);
  }
  assert.equal(hasCompositeAmounts('دو میلیون اجاره دادم و سه میلیون فروش داشتم'), false);
});
