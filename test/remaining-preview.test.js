import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFinancialText } from '../shared/parser.js';
import { transactionEventDecision as sharedDecision } from '../shared/transactionEvent.js';
import { transactionEventDecision as serverDecision } from '../server/transactionEvent.js';

test('unpaid bill due date is not its occurrence date', () => {
  const [row] = parseFinancialText('قبض برق و گاز کارگاه اومده روی هم نه میلیون تومن، موعد پرداختش هفته بعده ولی الان فاکتورش اومده', { now: new Date('2026-09-29T12:00:00Z') }).transactions;
  assert.equal(row.amount, 9000000);
  assert.equal(row.unpaidSignal, true);
  assert.equal(row.occurredAt, undefined);
});
test('browser and server use the identical decision implementation', () => {
  assert.equal(sharedDecision, serverDecision);
  const [row] = parseFinancialText('قبض برق نه میلیون تومن اومده هنوز پرداخت نکردیم').transactions;
  const result = sharedDecision({ ...row, occurredAt: '2026-09-29T12:00:00Z' }, { policy: { engineV2: true } });
  assert.notEqual(result.accountingDecision.decisionStatus, 'decided');
});

 test('correction with old and correct amounts is one review item', () => {
  const result = parseFinancialText('فاکتور خرید دوازده میلیون تومانی دیروز اشتباهاً بیست و یک میلیون ثبت شده بود، اصلاحش کن لطفا.');
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].amount, 12000000);
  assert.equal(result.transactions[0].needsReview, true);
  assert.match(result.transactions[0].rawText, /بیست و یک/);
 });
