import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { backfillLevelCodes } from '../server/chartOfAccounts.js';

// ستون level_code با پیش‌فرض خالی اضافه شد، پس هر کدینگی که پیش از آن نصب بود
// کد سطح نداشت. تا وقتی خروجی کد کامل می‌داد بی‌ضرر بود؛ از وقتی فایل انتقال
// پارسیان کد کل و معین را جدا می‌خواهد، خالی‌بودنش خروجی را متوقف می‌کند.

function chartDatabase(rows) {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE chart_accounts (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, parent_id TEXT, level_code TEXT NOT NULL DEFAULT ''
  );`);
  const insert = database.prepare('INSERT INTO chart_accounts (id,code,parent_id,level_code) VALUES (?,?,?,?)');
  for (const row of rows) insert.run(row.id, row.code, row.parentId ?? null, row.levelCode ?? '');
  return database;
}

const levelCodes = (database) => Object.fromEntries(
  database.prepare('SELECT code,level_code AS levelCode FROM chart_accounts ORDER BY code').all()
    .map((row) => [row.code, row.levelCode]),
);

test('a prefix chart installed before the column gets its level codes back', () => {
  const database = chartDatabase([
    { id: 'g', code: '1' },
    { id: 'k', code: '11', parentId: 'g' },
    { id: 'm', code: '1101', parentId: 'k' },
  ]);
  assert.equal(backfillLevelCodes(database), 3);
  assert.deepEqual(levelCodes(database), { 1: '1', 11: '1', 1101: '01' });
});

test('a root account keeps its own code as the level code', () => {
  const database = chartDatabase([{ id: 'r', code: '66' }]);
  backfillLevelCodes(database);
  assert.equal(levelCodes(database)['66'], '66');
});

test('a level code that is already set is never overwritten', () => {
  // کدینگ segmented پارسیان کد سطح مستقل دارد؛ backfill نباید خرابش کند.
  const database = chartDatabase([
    { id: 'g', code: '11', levelCode: '11' },
    { id: 'k', code: '1110', parentId: 'g', levelCode: '10' },
  ]);
  assert.equal(backfillLevelCodes(database), 0);
  assert.deepEqual(levelCodes(database), { 11: '11', 1110: '10' });
});

test('a child whose code does not start with the parent code falls back to its own code', () => {
  // کدینگ واقعی پارسیان این‌طور است: کل ۱۰ زیر گروه ۱۱ می‌نشیند.
  const database = chartDatabase([
    { id: 'g', code: '11' },
    { id: 'k', code: '10', parentId: 'g' },
  ]);
  backfillLevelCodes(database);
  assert.equal(levelCodes(database)['10'], '10');
});

test('running the backfill twice changes nothing the second time', () => {
  const database = chartDatabase([
    { id: 'g', code: '1' },
    { id: 'm', code: '1101', parentId: 'g' },
  ]);
  assert.equal(backfillLevelCodes(database), 2);
  assert.equal(backfillLevelCodes(database), 0);
});

test('every backfilled level code is numeric, which is what the Parsian file needs', () => {
  const database = chartDatabase([
    { id: 'g', code: '5000' },
    { id: 'k', code: '5100', parentId: 'g' },
    { id: 'm', code: '5101', parentId: 'k' },
  ]);
  backfillLevelCodes(database);
  for (const value of Object.values(levelCodes(database))) assert.match(value, /^\d+$/);
});
