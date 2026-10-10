import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase } from './helpers/tempPath.js';

/**
 * هر ردیف کارت حساب به سند حسابداری خودش ارجاع می‌دهد.
 *
 * کارت اشخاص و کارت بانک و صندوق هر دو. شناسهٔ سند باید سندی باشد که واقعاً همان
 * ردیف را دارد، و برای ردیفی که ویرایش شد، سند جاری — نه نسخهٔ معکوس‌شده.
 */
process.env.DATABASE_PATH = tempDatabase('card-entry');
process.env.ADMIN_USERNAME = 'card-entry-owner';
process.env.ADMIN_PASSWORD = 'card-entry-strong-password-4471';
const database = await import('../server/db.js');
const accounting = await import('../server/accounting.js');
database.ensureAdmin();
const owner = database.authenticateUser('card-entry-owner', 'card-entry-strong-password-4471');
const workspace = database.createWorkspace(owner.id, { name: 'دفتر ارجاع سند', profileType: 'business' });
const inWorkspace = (callback) => database.runInWorkspace(workspace.id, { role: 'owner', userId: owner.id }, callback);
const entry = (id) => accounting.listJournal(database.activeWorkspaceDatabase(), { entryId: id }).items[0];

test('کارت اشخاص: ردیف دفتر کل و ردیف جاری شریک هر کدام سند خودشان را دارند', () => inWorkspace(() => {
  database.installChartTemplate();
  const aria = database.saveContact({ name: 'شرکت آریا' });
  const debt = database.saveObligation({ title: 'خرید مواد', amount: 280_000_000, direction: 'payable', contactId: aria.id });
  const settled = database.settleObligation(debt.id, { paidBy: { name: 'آقای سهرابی' } });
  for (const line of database.counterpartyCard(aria.id).lines) {
    assert.ok(line.entryId, line.title);
    const document = entry(line.entryId);
    assert.ok(document.lines.some((row) => row.debit === line.debit && row.credit === line.credit), 'سند همان ردیف را دارد');
  }
  const partner = database.counterpartyCard(settled.paidBy.contactId);
  assert.equal(partner.lines.length, 1);
  const document = entry(partner.lines[0].entryId);
  assert.deepEqual(document.lines.map((row) => [row.debit > 0, /جاری شریک/.test(row.name)]).sort(), [[false, true], [true, false]]);
}));

test('کارت اشخاص: ثبت مستقیم تراکنش هم سندش را دارد، و پس از ویرایش سند جاری را', () => inWorkspace(() => {
  const vendor = database.saveContact({ name: 'آقای نادری' });
  const [id] = database.insertTransactions({ transcript: 'دو میلیون به آقای نادری برای تعمیر دادیم', transactions: [{ clientId: 'direct-1', amount: 2_000_000, type: 'expense', category: 'تعمیر و نگهداری', contactId: vendor.id, settlement: 'none', source: 'text' }] });
  const before = database.counterpartyCard(vendor.id).lines.find((line) => line.sourceId === id);
  assert.ok(before.entryId, 'ردیف مستقیم سند دارد');
  database.updateTransaction(id, { amount: 2_500_000, type: 'expense', category: 'تعمیر و نگهداری', contactId: vendor.id, settlement: 'none' });
  const after = database.counterpartyCard(vendor.id).lines.find((line) => line.sourceId === id);
  assert.ok(after.entryId);
  assert.notEqual(after.entryId, before.entryId, 'سند جاری، نه سند معکوس‌شده');
  assert.equal(entry(after.entryId).lines.reduce((sum, row) => sum + row.debit, 0), 2_500_000);
}));

test('کارت بانک و صندوق: هر ردیف سند خودش را دارد', () => inWorkspace(() => {
  const card = database.moneyAccountCard('cash');
  assert.ok(card.lines.length > 0);
  for (const line of card.lines) {
    assert.ok(line.entryId, line.title);
    assert.ok(entry(line.entryId).lines.some((row) => row.debit === line.debit && row.credit === line.credit));
  }
}));
