import test from 'node:test';
import assert from 'node:assert/strict';
import { MONEY_POLICY, PRODUCT_POSITIONING, profileDefinition } from '../shared/product.js';

test('positions the current product as a cash-basis voice assistant', () => {
  assert.equal(PRODUCT_POSITIONING.accountingScope, 'cash-basis-assistant');
  assert.match(PRODUCT_POSITIONING.accountingDisclaimer, /جایگزین صورت‌های مالی/);
});

test('keeps business-only tools out of the personal profile', () => {
  const personal = profileDefinition('personal');
  assert.equal(personal.ledgerTabs.includes('invoices'), false);
  assert.equal(personal.ledgerTabs.includes('inventory'), false);
  assert.equal(personal.ledgerTabs.includes('transactions'), true);
});

test('documents the safe money migration instead of silently multiplying existing data', () => {
  assert.equal(MONEY_POLICY.currentStorageUnit, 'IRT');
  assert.equal(MONEY_POLICY.canonicalTargetUnit, 'IRR');
  assert.equal(MONEY_POLICY.rialPerToman, 10);
  assert.equal(MONEY_POLICY.migrationRequired, true);
});
