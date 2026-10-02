import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractContactName } from '../shared/counterpartySpeech.js';
import { parseFinancialText } from '../shared/parser.js';
import { todayKey, persianDate } from '../src/lib/format.js';
const cases = new Map(JSON.parse(fs.readFileSync(new URL('./fixtures/stress-scenarios-v1.json', import.meta.url))).map(item => [item.id, item.text]));
test('names stop at verbs and fiscal phrases are not counterparties', () => {
  assert.equal(extractContactName('به آقای کاظمی زدیم ولی نمیدونم'), 'کاظمی');
  for (const phrase of ['به مبلغ ده میلیون', 'به عنوان تخفیفات', 'به شرکت عودت داد', 'به مالیات ارزش افزوده', 'از موقع اظهارنامه']) assert.equal(extractContactName(phrase, { allowBare: true }), '');
  for (const id of ['T071', 'T073', 'T076', 'T090', 'T102', 'T108']) assert.ok(!parseFinancialText(cases.get(id)).transactions[0].contactName, id);
  assert.equal(extractContactName('به شرکت آراد گستر آسیا پرداخت شد'), 'شرکت آراد گستر آسیا');
});
test('service dates without payment date remain explicit missing facts', () => {
  const item = parseFinancialText(cases.get('T002'), { now: new Date('2026-09-30T08:30:00Z') }).transactions[0];
  assert.ok(!item.occurredAt);
  assert.ok(item.reviewReasons.some(reason => reason.startsWith('تاریخ پرداخت مشخص نیست')));
});
test('today and displayed date agree across Tehran midnight', () => {
  const instant = new Date('2026-09-30T21:00:00Z');
  assert.equal(todayKey(instant), '2026-10-01');
  assert.equal(persianDate(instant), persianDate(new Date('2026-10-01T08:00:00Z')));
});

test('journal search, numbering, paging and seeded expense reuse', async () => {
  const { tempDatabase } = await import('./helpers/tempPath.js');
  process.env.DATABASE_PATH = tempDatabase('pr75-documents');
  process.env.ADMIN_USERNAME = 'document-owner';
  process.env.ADMIN_PASSWORD = 'document-test-password-123';
  const db = await import('../server/db.js');
  const { listJournal } = await import('../server/accounting.js');
  db.ensureAdmin();
  const owner = db.authenticateUser(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
  db.runInWorkspace('primary', { role: 'owner', userId: owner.id }, () => {
    db.installChartTemplate();
    const sql = db.activeWorkspaceDatabase();
    const rentBefore = sql.prepare("SELECT l.id FROM ledger_accounts l JOIN chart_accounts c ON c.id=l.chart_account_id WHERE c.code='8102' AND l.active=1").all();
    assert.equal(rentBefore.length, 1);
    const ids = db.insertTransactions({ transcript: 'اجاره', transactions: [{ amount: 12000000, type: 'expense', category: 'اجاره', rawText: 'اجاره', accountId: 'cash' }] });
    const entry = listJournal(sql, { search: ids[0] }).items[0];
    assert.ok(entry);
    assert.equal(entry.lines.find(line => line.debit).accountId, rentBefore[0].id);
    assert.ok(entry.documentNumber);
    assert.ok(listJournal(sql, { search: String(entry.documentNumber) }).items.some(item => item.id === entry.id));
    assert.equal(listJournal(sql, { search: "' OR 1=1 --" }).total, 0);
    assert.equal(listJournal(sql, { approvalState: 'returned' }).items.length, 0);
    assert.equal(listJournal(sql, { limit: 1 }).items.length, 1);
    assert.equal(entry.lines.reduce((sum, line) => sum + line.debit - line.credit, 0), 0);
  });
});
