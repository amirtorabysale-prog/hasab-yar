import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_STATES, approvalStateLabel, assertApprovalTransition, normalizeApprovalState,
  normalizeTemplateLines, worklistSummary,
} from '../server/journalWorkflow.js';
import { minimumRoleForRequest } from '../server/access.js';

test('an unknown state falls back to approved so existing books are not frozen', () => {
  assert.equal(normalizeApprovalState('nonsense'), 'approved');
  assert.equal(normalizeApprovalState(undefined), 'approved');
  assert.equal(approvalStateLabel('submitted'), 'در انتظار کنترل');
});

test('the maker-checker path runs draft to submitted to approved', () => {
  assert.deepEqual(assertApprovalTransition('draft', 'submitted'), { from: 'draft', to: 'submitted' });
  assert.deepEqual(assertApprovalTransition('submitted', 'approved'), { from: 'submitted', to: 'approved' });
});

test('a returned document goes back to the maker and can be resubmitted', () => {
  assert.deepEqual(
    assertApprovalTransition('submitted', 'returned', { reason: 'کد حساب هزینه اشتباه است' }),
    { from: 'submitted', to: 'returned' },
  );
  assert.deepEqual(assertApprovalTransition('returned', 'submitted'), { from: 'returned', to: 'submitted' });
});

test('returning a document without a real reason is refused', () => {
  assert.throws(() => assertApprovalTransition('submitted', 'returned', { reason: 'غلط' }), (error) => error.code === 'JOURNAL_RETURN_REASON_REQUIRED');
  assert.throws(() => assertApprovalTransition('submitted', 'returned'), (error) => error.code === 'JOURNAL_RETURN_REASON_REQUIRED');
});

test('an approved document never walks backwards', () => {
  for (const target of ['draft', 'submitted', 'returned']) {
    assert.throws(() => assertApprovalTransition('approved', target), (error) => {
      assert.equal(error.code, 'JOURNAL_STATE_FORBIDDEN');
      assert.match(error.message, /سند معکوس/);
      return true;
    });
  }
});

test('skipping the control step is refused', () => {
  assert.throws(() => assertApprovalTransition('draft', 'approved'), (error) => error.code === 'JOURNAL_STATE_FORBIDDEN');
  assert.throws(() => assertApprovalTransition('returned', 'approved'), (error) => error.code === 'JOURNAL_STATE_FORBIDDEN');
});

test('a no-op transition and an unknown target are both named clearly', () => {
  assert.throws(() => assertApprovalTransition('draft', 'draft'), (error) => error.code === 'JOURNAL_STATE_UNCHANGED');
  assert.throws(() => assertApprovalTransition('draft', 'archived'), (error) => error.code === 'JOURNAL_STATE_UNKNOWN');
});

test('self approval is forbidden by default and only an explicit trusted override can allow it', () => {
  assert.throws(
    () => assertApprovalTransition('submitted', 'approved', { sameUser: true }),
    (error) => error.code === 'JOURNAL_SELF_APPROVAL',
  );
  assert.doesNotThrow(() => assertApprovalTransition('submitted', 'approved', { sameUser: true, allowSelfApproval: true }));
});

test('only approved documents are allowed to leave in an export', () => {
  assert.equal(APPROVAL_STATES.approved.blocksExport, false);
  for (const state of ['draft', 'submitted', 'returned']) assert.equal(APPROVAL_STATES[state].blocksExport, true);
});

test('the worklist counts states and what is waiting for this user', () => {
  const summary = worklistSummary([
    { approvalState: 'draft', createdBy: 'u1' },
    { approvalState: 'draft', createdBy: 'u2' },
    { approvalState: 'submitted', createdBy: 'u1' },
    { approvalState: 'returned', createdBy: 'u1' },
    { approvalState: 'approved', createdBy: 'u1' },
  ], { userId: 'u1' });
  assert.equal(summary.draft, 2);
  assert.equal(summary.submitted, 1);
  assert.equal(summary.returned, 1);
  assert.equal(summary.approved, 1);
  assert.equal(summary.pending, 4);
  // پیش‌نویس و برگشتی خودِ کاربر، به‌علاوهٔ سند منتظر کنترل.
  assert.equal(summary.waitingForMe, 3);
  assert.equal(summary.clear, false);
});

test('a book with nothing in flight is reported clear, not "probably fine"', () => {
  const summary = worklistSummary([{ approvalState: 'approved', createdBy: 'u1' }], { userId: 'u1' });
  assert.equal(summary.pending, 0);
  assert.equal(summary.clear, true);
});

test('a template keeps its layout and rejects a line with both sides', () => {
  const lines = normalizeTemplateLines([
    { accountId: 'a', debit: 1000, description: 'اجاره' },
    { accountId: 'b', credit: 1000 },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].description, 'اجاره');
  assert.equal(lines[1].credit, 1000);
  assert.throws(() => normalizeTemplateLines([{ accountId: 'a', debit: 1, credit: 1 }, { accountId: 'b', credit: 1 }]), /هم بدهکار دارد/);
  assert.throws(() => normalizeTemplateLines([{ accountId: 'a', debit: 1 }]), /بین ۲ تا ۱۰۰/);
  assert.throws(() => normalizeTemplateLines([{ debit: 1 }, { accountId: 'b', credit: 1 }]), /حساب ندارد/);
});

test('a template may carry accounts without amounts', () => {
  const lines = normalizeTemplateLines([{ accountId: 'a' }, { accountId: 'b' }]);
  assert.equal(lines[0].debit, 0);
  assert.equal(lines[0].credit, 0);
});

test('approving is a manager job, bulk entry is not', () => {
  assert.equal(minimumRoleForRequest('POST', '/accounting/journal/abc/approval'), 'manager');
  assert.equal(minimumRoleForRequest('POST', '/accounting/templates'), 'manager');
  assert.equal(minimumRoleForRequest('POST', '/accounting/journal/batch'), 'accountant');
  assert.equal(minimumRoleForRequest('GET', '/accounting/journal/worklist'), 'viewer');
});
